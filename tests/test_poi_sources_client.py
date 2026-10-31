# -*- coding: utf-8 -*-
"""POI 公开资料候选客户端离线测试：全部用 httpx.MockTransport，不访问真实网络。

运行方式（在仓库根目录）：

    python -m pytest tests/test_poi_sources_client.py

夹具直接放在本文件内，不依赖外部 fixture 文件。覆盖：

1. QL 构造纯函数：固定端点、nwr 三标签 union、around、out meta center 上限
2. 规范 node/way/relation 解析、union 去重、距离排序、8 候选上限
3. 缺/错字段、布尔 id、NaN 坐标、超长标签 unknown、来源 URL/时间真实口径
4. 无身份升级：identity_status 恒 unconfirmed、uid/user 不进输出
5. 空 elements → no_candidates；remark 部分错误/缺 elements → failed
6. 429/5xx/坏 JSON/超 1MiB body/总 deadline/重定向
7. 缓存 TTL/容量/副本隔离/只缓存成功与 no_candidates
8. CancelledError 原样上抛
"""

from __future__ import annotations

import asyncio
import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from poi_sources_client import (  # noqa: E402
    PROVIDER_ENDPOINT,
    PoiSourcesClient,
    PoiTagField as PoiTagFieldModel,
    build_overpass_query,
    haversine_m,
    parse_nearby_payload,
)

LAT, LON = 31.2304, 121.4737

FIXED_NOW = datetime(2026, 10, 30, 4, 5, 0, tzinfo=timezone.utc)
FIXED_NOW_ISO = FIXED_NOW.isoformat()


def fixed_now() -> datetime:
    return FIXED_NOW


def run(coro):
    return asyncio.run(coro)


def element(
    *,
    etype: str = "node",
    eid: int = 1,
    lat: float | None = LAT,
    lon: float | None = LON,
    name: str | None = "示例站点",
    opening_hours: str | None = "Mo-Su 08:00-18:00",
    fee: str | None = None,
    charge: str | None = None,
    timestamp: str | None = "2025-06-01T08:00:00Z",
    tags: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """构造一份 Overpass JSON 元素。way/relation 用 center，node 用 lat/lon。"""

    el: dict[str, Any] = {"type": etype, "id": eid, "timestamp": timestamp}
    if etype == "node":
        if lat is not None:
            el["lat"] = lat
        if lon is not None:
            el["lon"] = lon
    else:
        if lat is not None or lon is not None:
            el["center"] = {"lat": lat if lat is not None else LAT,
                            "lon": lon if lon is not None else LON}
    el_tags: dict[str, Any] = dict(tags) if tags is not None else {}
    if tags is None:
        if name is not None:
            el_tags["name"] = name
        if opening_hours is not None:
            el_tags["opening_hours"] = opening_hours
        if fee is not None:
            el_tags["fee"] = fee
        if charge is not None:
            el_tags["charge"] = charge
    el["tags"] = el_tags
    return el


def ok_payload(elements: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "version": 0.6,
        "generator": "Overpass API",
        "osm3s": {"timestamp_osm_base": "2026-10-29T20:00:02Z"},
        "elements": elements,
    }


def handler_ok(payload: dict[str, Any], *, status: int = 200) -> Callable[
    [httpx.Request], httpx.Response
]:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return handler


def make_client(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    total_deadline_seconds: float = 8.0,
    cache_ttl_seconds: float = 0.0,
    cache_max_keys: int = 128,
    clock: Callable[[], float] | None = None,
    now_utc: Callable[[], datetime] | None = fixed_now,
) -> tuple[PoiSourcesClient, httpx.AsyncClient]:
    """构造注入 MockTransport 的客户端；HTTP client 由测试侧关闭。"""

    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport)
    kwargs: dict[str, Any] = {"client": http_client}
    if total_deadline_seconds != 8.0:
        kwargs["total_deadline_seconds"] = total_deadline_seconds
    kwargs["cache_ttl_seconds"] = cache_ttl_seconds
    kwargs["cache_max_keys"] = cache_max_keys
    if clock is not None:
        kwargs["clock"] = clock
    if now_utc is not None:
        kwargs["now_utc"] = now_utc
    return PoiSourcesClient(**kwargs), http_client


async def close_pair(client: PoiSourcesClient, http_client: httpx.AsyncClient) -> None:
    await client.aclose()
    await http_client.aclose()


def fetch(
    handler: Callable[[httpx.Request], httpx.Response], **kwargs: Any
):
    client, http_client = make_client(handler, **kwargs)

    async def action():
        try:
            return await client.fetch_nearby(LAT, LON)
        finally:
            await close_pair(client, http_client)

    return run(action())


# ==================== 1. QL 构造 ====================


def test_build_query_is_fixed_numeric() -> None:
    query = build_overpass_query(31.2304, 121.4737)
    assert "[out:json][timeout:" in query
    assert 'nwr["opening_hours"](around:100.0,31.2304,121.4737);' in query
    assert 'nwr["fee"](around:100.0,31.2304,121.4737);' in query
    assert 'nwr["charge"](around:100.0,31.2304,121.4737);' in query
    assert query.count("nwr[") == 3
    assert query.startswith("(") or "(" in query
    assert "out meta center 30;" in query
    # 不收用户 QL/URL：无任何引号包裹的自由片段。
    assert "data=" not in query
    assert "user" not in query.lower().replace("union", "")


def test_haversine_known_distance() -> None:
    # 赤道上 1 经度 ≈ 111.19 km。
    d = haversine_m(0.0, 0.0, 0.0, 1.0)
    assert 111000 < d < 111400
    assert haversine_m(31.0, 121.0, 31.0, 121.0) == 0.0


# ==================== 2. 解析：规范三类型与去重排序 ====================


def test_parse_node_way_relation_with_distance_sort() -> None:
    payload = ok_payload([
        element(etype="way", eid=200, name=".way 候选"),
        element(eid=100, name=".近 node"),
        element(etype="relation", eid=300, name=".远 relation",
                lat=LAT + 0.0003, lon=LON),
        # 同一 node/way/relation 由不同标签分支命中两次：union 语义去重。
        element(eid=100, name=".近 node", fee="yes"),
    ])
    parsed = parse_nearby_payload(
        payload, center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO
    )
    assert parsed.source_elements_seen == 4
    types = [(c.element_type, c.element_id) for c in parsed.candidates]
    assert types == [("node", 100), ("way", 200), ("relation", 300)]
    distances = [c.distance_m for c in parsed.candidates]
    assert distances == sorted(distances)
    assert all(c.identity_status == "unconfirmed" for c in parsed.candidates)
    # 去重有记录。
    assert any("重复" in n for n in parsed.notes)


def test_candidates_capped_at_eight_and_elements_at_thirty() -> None:
    elements = [
        element(eid=i, name=f".站点{i}", lat=LAT + i * 0.0001, lon=LON)
        for i in range(1, 13)
    ]
    parsed = parse_nearby_payload(
        ok_payload(elements), center_lat=LAT, center_lon=LON,
        retrieved_at=FIXED_NOW_ISO,
    )
    assert parsed.source_elements_seen == 12
    assert len(parsed.candidates) == 8
    assert parsed.candidates[0].element_id == 1
    assert parsed.candidates[-1].element_id == 8
    # 9..12 因超 8 上限被截；此处断言截断行为本身，note 文案不锁死。
    assert all(c.element_id <= 8 for c in parsed.candidates)

    # 源元素超过 30：只处理前 30。
    many = [element(eid=i) for i in range(1, 41)]
    parsed_many = parse_nearby_payload(
        ok_payload(many), center_lat=LAT, center_lon=LON,
        retrieved_at=FIXED_NOW_ISO,
    )
    assert parsed_many.source_elements_seen == 40
    assert len(parsed_many.candidates) == 8


# ==================== 3. 字段口径 ====================


def test_field_truth_and_unknown_states() -> None:
    payload = ok_payload([
        # fee 有值、charge 缺失、opening_hours 为空白字符串。
        element(eid=10, fee="yes", opening_hours="   "),
    ])
    parsed = parse_nearby_payload(
        payload, center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO
    )
    c = parsed.candidates[0]
    assert c.opening_hours.state == "unknown"
    assert c.opening_hours.value is None
    assert c.fee == PoiTagFieldModel(state="source_only", value="yes")
    assert c.charge.state == "unknown"


def test_overlong_tag_is_unknown_not_truncated() -> None:
    long_value = "x" * 301
    payload = ok_payload([element(eid=11, opening_hours=long_value)])
    parsed = parse_nearby_payload(
        payload, center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO
    )
    c = parsed.candidates[0]
    assert c.opening_hours.state == "unknown"
    assert c.opening_hours.value is None
    # 原文没有进入任何输出。
    assert long_value not in json.dumps(parsed.candidates[0].model_dump())


def test_source_url_only_from_validated_type_id() -> None:
    payload = ok_payload([element(etype="way", eid=4242)])
    parsed = parse_nearby_payload(
        payload, center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO
    )
    c = parsed.candidates[0]
    assert c.source_url == "https://www.openstreetmap.org/way/4242"


def test_timestamps_real_semantics() -> None:
    payload = ok_payload([
        element(eid=20, timestamp="2025-06-01T08:00:00Z"),
        element(eid=21, timestamp=None),
        element(eid=22, timestamp="not-a-time"),
        element(eid=23, timestamp="2025-13-40T99:00:00Z"),
    ])
    parsed = parse_nearby_payload(
        payload, center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO
    )
    by_id = {c.element_id: c for c in parsed.candidates}
    assert by_id[20].source_updated_at == "2025-06-01T08:00:00Z"
    # 缺失/非法：null，绝不用当前时间填充。
    assert by_id[21].source_updated_at is None
    assert by_id[22].source_updated_at is None
    assert by_id[23].source_updated_at is None
    assert by_id[20].retrieved_at == FIXED_NOW_ISO


def test_name_and_metadata_hygiene() -> None:
    payload = ok_payload([
        {
            "type": "node", "id": 30, "lat": LAT, "lon": LON,
            "timestamp": "2025-06-01T08:00:00Z",
            "uid": 999, "user": "some-editor",
            "changeset": 12345, "version": 7,
            "tags": {"name": "  ", "opening_hours": "24/7"},
        },
    ])
    parsed = parse_nearby_payload(
        payload, center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO
    )
    dump = json.dumps(parsed.candidates[0].model_dump())
    assert "some-editor" not in dump
    assert "999" not in dump
    assert "12345" not in dump
    # 空白名字不当成有名字。
    c = parsed.candidates[0]
    assert c.name is None


def test_invalid_elements_skipped_never_fabricated() -> None:
    payload = ok_payload([
        {"type": "way", "id": 1},               # 无 center
        {"type": "node", "id": 2, "lat": LAT, "lon": LON},  # 无 tags
        {"type": "node", "id": True, "lat": LAT, "lon": LON},  # 布尔 id
        {"type": "node", "id": -5, "lat": LAT, "lon": LON},  # 负 id
        {"type": "node", "id": 0, "lat": LAT, "lon": LON},  # 0 id
        {"type": "area", "id": 8, "lat": LAT, "lon": LON},  # 不支持的类型
        {"type": "node", "id": 9, "lat": 95.0, "lon": LON},  # 越界坐标
        {"type": "node", "id": 10, "lat": float("nan"), "lon": LON},
        element(eid=11, lat=LAT + 0.01, lon=LON),  # 中心超 100m 半径
        # 合法且有标签的对照样本。
        element(eid=12, opening_hours="24/7"),
    ])
    parsed = parse_nearby_payload(
        payload, center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO
    )
    # 只有 id=12 成为候选；其余全部排除且有记录。
    assert [c.element_id for c in parsed.candidates] == [12]
    notes = "\n".join(parsed.notes)
    assert "缺少合法 WGS84" in notes
    assert "超出 100.0m 半径" in notes


def test_center_out_of_radius_note_documents_limitation() -> None:
    payload = ok_payload([
        element(etype="way", eid=50, lat=LAT + 0.002, lon=LON),  # ≈222m
    ])
    parsed = parse_nearby_payload(
        payload, center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO
    )
    assert parsed.candidates == []
    assert any("超出" in n and "保守排除" in n for n in parsed.notes)


# ==================== 4. 结构性损坏 → OverpassResponseError ====================


def test_parse_rejects_bad_structures() -> None:
    from poi_sources_client import OverpassResponseError

    with pytest.raises(OverpassResponseError):
        parse_nearby_payload(
            "not a dict", center_lat=LAT, center_lon=LON,
            retrieved_at=FIXED_NOW_ISO,
        )
    with pytest.raises(OverpassResponseError):
        parse_nearby_payload(
            {"elements": None}, center_lat=LAT, center_lon=LON,
            retrieved_at=FIXED_NOW_ISO,
        )
    # 无 elements 键。
    with pytest.raises(OverpassResponseError):
        parse_nearby_payload(
            {"version": 0.6}, center_lat=LAT, center_lon=LON,
            retrieved_at=FIXED_NOW_ISO,
        )
    # remark 顶层与 osm3s 内层都算部分失败。
    with pytest.raises(OverpassResponseError):
        parse_nearby_payload(
            {"elements": [], "remark": "runtime error: query timed out."},
            center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO,
        )
    with pytest.raises(OverpassResponseError):
        parse_nearby_payload(
            {"elements": [],
             "osm3s": {"remark": "partial data: some regions skipped"}},
            center_lat=LAT, center_lon=LON, retrieved_at=FIXED_NOW_ISO,
        )


def test_empty_elements_is_no_candidates_not_failed() -> None:
    report = fetch(handler_ok(ok_payload([])))
    assert report.status == "no_candidates"
    assert report.candidates == []
    assert report.fetched_at is not None
    assert report.reason is None


# ==================== 5. 网络与 HTTP 层 ====================


def test_provider_request_is_fixed() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = request.url
        return httpx.Response(200, json=ok_payload([]))

    fetch(handler)
    url = seen["url"]
    assert url.host == "overpass-api.de"
    assert url.path == "/api/interpreter"
    assert "data=" in str(url)
    query = build_overpass_query(round(LAT, 6), round(LON, 6))
    assert query in httpx.QueryParams({"data": query})["data"]


def test_429_is_rate_limited_200_envelope() -> None:
    report = fetch(lambda request: httpx.Response(429, text="slow down"))
    assert report.status == "rate_limited"
    assert report.provider_http_status == 429
    assert report.fetched_at is None
    assert "slow down" not in report.reason


@pytest.mark.parametrize("status_code", [500, 502, 503])
def test_5xx_is_unavailable_200_envelope(status_code: int) -> None:
    report = fetch(
        lambda request: httpx.Response(status_code, text="upstream boom")
    )
    assert report.status == "unavailable"
    assert report.provider_http_status == status_code
    assert "upstream boom" not in report.reason


def test_4xx_is_failed() -> None:
    report = fetch(lambda request: httpx.Response(400, text="bad request"))
    assert report.status == "failed"
    assert report.provider_http_status == 400


@pytest.mark.parametrize("status_code", [200, 201, 202])
def test_success_2xx_carries_its_own_status(status_code: int) -> None:
    """有效 2xx + 合法 payload：信封带本次真实的 provider_http_status，不硬写 200。"""

    report = fetch(handler_ok(ok_payload([element(eid=1)]), status=status_code))
    assert report.status == "available"
    assert report.provider_http_status == status_code
    assert report.fetched_at == FIXED_NOW_ISO


@pytest.mark.parametrize("status_code", [204, 301, 302, 404])
def test_non_2xx_contrast_is_failed(status_code: int) -> None:
    """非 2xx 对照：都不进成功 body 处理路径。

    204 是 2xx 但没有 body，JSON 解析失败折算 failed 且状态如实保留；
    301/302 重定向、404 走 typed 失败，状态同样真实携带。
    """

    if status_code in (301, 302):
        report = fetch(
            lambda request: httpx.Response(
                status_code, headers={"location": "https://example.com/x"}
            )
        )
    else:
        report = fetch(lambda request: httpx.Response(status_code))
    assert report.status == "failed"
    assert report.provider_http_status == status_code
    assert report.candidates == []


def test_connect_error_is_unavailable() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure", request=request)

    report = fetch(refuse)
    assert report.status == "unavailable"
    assert "dns" not in report.reason


def test_bad_json_is_failed_with_real_fetched_at() -> None:
    report = fetch(lambda request: httpx.Response(200, content=b"<html>error</html>"))
    assert report.status == "failed"
    # body 已真实收到：fetched_at 是真实时间，不伪造也不隐藏。
    assert report.fetched_at == FIXED_NOW_ISO
    assert "<html>" not in report.reason


def test_missing_elements_is_failed() -> None:
    report = fetch(handler_ok({"version": 0.6}))
    assert report.status == "failed"


def test_remark_partial_error_is_failed_not_success() -> None:
    payload = ok_payload([element(eid=1)])
    payload["remark"] = "runtime error: query timed out."
    report = fetch(handler_ok(payload))
    assert report.status == "failed"
    # 部分错误不当完整成功：即便有元素也不返回候选。
    assert report.candidates == []


def test_body_over_1mib_is_failed() -> None:
    payload = ok_payload([element(eid=1)])
    payload["elements"][0]["tags"]["name"] = "y" * 1_100_000

    report = fetch(handler_ok(payload))
    assert report.status == "failed"


def test_gzip_body_within_limit_ok() -> None:
    raw = json.dumps(ok_payload([element(eid=1)])).encode("utf-8")
    compressed = gzip.compress(raw)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=compressed,
            headers={"content-type": "application/json",
                     "content-encoding": "gzip"},
        )

    report = fetch(handler)
    assert report.status == "available"


def test_slow_stream_hits_total_deadline() -> None:
    # body 要足够大，保证慢 clock 能在读完前超过 deadline。
    payload = ok_payload([element(eid=1)])
    payload["elements"][0]["tags"]["name"] = "z" * 40_000
    body = json.dumps(payload).encode("utf-8")
    chunk_size = 64

    def handler(request: httpx.Request) -> httpx.Response:
        async def stream():
            for i in range(0, len(body), chunk_size):
                yield body[i:i + chunk_size]

        return httpx.Response(200, content=stream())

    fake_time = {"t": 0.0}

    def clock() -> float:
        fake_time["t"] += 0.05
        return fake_time["t"]

    report = fetch(
        handler, total_deadline_seconds=0.3, clock=clock, now_utc=fixed_now
    )
    assert report.status == "timeout"
    assert report.fetched_at is None


def test_redirect_is_failed_not_followed() -> None:
    report = fetch(
        lambda request: httpx.Response(
            302, headers={"location": "https://evil.example.com/api"}
        )
    )
    assert report.status == "failed"
    assert "evil" not in report.reason


# ==================== 6. 输入校验（0 provider 请求） ====================


def test_invalid_inputs_no_provider_call() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=ok_payload([]))

    invalid_lats = [True, False, "NaN", "abc", None, 90.1, -90.1, float("inf")]
    invalid_lons = [True, "NaN", None, 180.1, -180.1, float("-inf")]

    client, http_client = make_client(handler)
    try:
        for bad in invalid_lats:
            report = run(client.fetch_nearby(bad, LON))
            assert report.status == "invalid_request", bad
            assert report.reason
            assert report.candidates == []
        for bad in invalid_lons:
            report = run(client.fetch_nearby(LAT, bad))
            assert report.status == "invalid_request", bad
    finally:
        await_close = close_pair(client, http_client)
        run(await_close)
    assert calls["n"] == 0


# ==================== 7. 缓存 ====================


def test_cache_hit_second_call_no_provider() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=ok_payload([element(eid=1)]))

    client, http_client = make_client(
        handler, cache_ttl_seconds=300.0, clock=lambda: 1000.0
    )
    try:
        first = run(client.fetch_nearby(LAT, LON))
        second = run(client.fetch_nearby(LAT, LON))
    finally:
        run(close_pair(client, http_client))
    assert calls["n"] == 1
    assert first.cached is False
    assert second.cached is True
    # 命中保留原 retrieved_at，不造新鲜度。
    assert second.fetched_at == first.fetched_at == FIXED_NOW_ISO
    assert second.checked_at == first.checked_at
    assert [c.model_dump() for c in second.candidates] == [
        c.model_dump() for c in first.candidates
    ]


def test_cache_expiry_by_ttl() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=ok_payload([]))

    fake_time = {"t": 1000.0}

    client, http_client = make_client(
        handler, cache_ttl_seconds=10.0, clock=lambda: fake_time["t"]
    )
    try:
        run(client.fetch_nearby(LAT, LON))
        fake_time["t"] = 1005.0
        hit = run(client.fetch_nearby(LAT, LON))
        assert hit.cached is True
        fake_time["t"] = 1011.0
        expired = run(client.fetch_nearby(LAT, LON))
        assert expired.cached is False
    finally:
        run(close_pair(client, http_client))
    assert calls["n"] == 2


def test_cache_capacity_eviction() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=ok_payload([]))

    client, http_client = make_client(
        handler, cache_ttl_seconds=300.0, cache_max_keys=2,
        clock=lambda: 1000.0,
    )
    try:
        run(client.fetch_nearby(10.0, 10.0))
        run(client.fetch_nearby(20.0, 20.0))
        run(client.fetch_nearby(30.0, 30.0))
        assert len(client._cache) == 2
        # 最旧的 (10,10) 被逐出。
        assert run(client.fetch_nearby(10.0, 10.0)).cached is False
        assert run(client.fetch_nearby(30.0, 30.0)).cached is True
    finally:
        run(close_pair(client, http_client))


def test_cache_failure_not_cached() -> None:
    mode = {"fail": True}
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if mode["fail"]:
            return httpx.Response(503, text="down")
        return httpx.Response(200, json=ok_payload([]))

    client, http_client = make_client(
        handler, cache_ttl_seconds=300.0, clock=lambda: 1000.0
    )
    try:
        failed = run(client.fetch_nearby(LAT, LON))
        assert failed.status == "unavailable"
        mode["fail"] = False
        ok = run(client.fetch_nearby(LAT, LON))
        assert ok.status == "no_candidates"
        again = run(client.fetch_nearby(LAT, LON))
        assert again.cached is True
    finally:
        run(close_pair(client, http_client))
    assert calls["n"] == 2


def test_cache_copy_isolation() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=ok_payload([element(eid=1)]))

    client, http_client = make_client(
        handler, cache_ttl_seconds=300.0, clock=lambda: 1000.0
    )
    try:
        first = run(client.fetch_nearby(LAT, LON))
        first.candidates[0].name = "被我改掉了"
        first.notes.append("污染尝试")
        second = run(client.fetch_nearby(LAT, LON))
    finally:
        run(close_pair(client, http_client))
    assert second.candidates[0].name == "示例站点"
    assert second.notes == []
    assert second.cached is True


def test_disabled_cache_always_hits_provider() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=ok_payload([]))

    client, http_client = make_client(handler, cache_ttl_seconds=0.0)
    try:
        run(client.fetch_nearby(LAT, LON))
        run(client.fetch_nearby(LAT, LON))
    finally:
        run(close_pair(client, http_client))
    assert calls["n"] == 2


# ==================== 8. 取消与关闭 ====================


def test_cancellation_propagates() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        async def stream():
            while True:
                yield b"x" * 1024
                await asyncio.sleep(0.01)

        return httpx.Response(200, content=stream())

    async def action():
        client, http_client = make_client(handler, now_utc=fixed_now)
        try:
            task = asyncio.ensure_future(client.fetch_nearby(LAT, LON))
            await asyncio.sleep(0.05)
            assert not task.done()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            await close_pair(client, http_client)

    run(action())


def test_fetch_after_close_raises_runtime_error() -> None:
    client, http_client = make_client(handler_ok(ok_payload([])))
    run(close_pair(client, http_client))
    with pytest.raises(RuntimeError):
        run(client.fetch_nearby(LAT, LON))


def test_module_import_has_no_network_or_env() -> None:
    # import 时不在缓存里塞东西、不发请求：直接检查模块级常量即可。
    import poi_sources_client as m

    assert m.PROVIDER_ENDPOINT == "https://overpass-api.de/api/interpreter"
    assert m.PROVIDER_ATTRIBUTION_URL == "https://www.openstreetmap.org/copyright"
    assert m.PROVIDER_LICENSE == "ODbL 1.0"


# ==================== 9. 验收回归（并发状态串值 / 安全整数 / 构造合同） ====================


def test_concurrent_requests_report_own_provider_status() -> None:
    """并发正反路径：每个请求的信封只带本次请求自己的 provider 状态。

    A：200 且 body 分两段，第二段等 B 完成后才到达并超过 1 MiB；
    B：立即 429。B 完整返回后 A 才在读 body 时失败——若状态存在共享
    实例字段，A 的失败信封会串到 B 的 429。
    """

    b_finished = asyncio.Event()

    def handler_a(request: httpx.Request) -> httpx.Response:
        async def stream():
            yield b"x" * 700_000
            await b_finished.wait()
            yield b"y" * 700_000  # 累计超 1 MiB，触发 _BodyTooLarge

        return httpx.Response(200, content=stream())

    def handler_b(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="slow down")

    async def action():
        client_a, http_a = make_client(handler_a, now_utc=fixed_now)
        client_b, http_b = make_client(handler_b, now_utc=fixed_now)

        async def fetch_b():
            report = await client_b.fetch_nearby(LAT, LON)
            b_finished.set()
            return report

        try:
            return await asyncio.gather(
                client_a.fetch_nearby(LAT, LON), fetch_b()
            )
        finally:
            await close_pair(client_a, http_a)
            await close_pair(client_b, http_b)

    rep_a, rep_b = run(action())
    assert rep_b.status == "rate_limited"
    assert rep_b.provider_http_status == 429
    assert rep_a.status == "failed"
    # A 的失败信封必须带 A 自己的 200，而不是 B 的 429。
    assert rep_a.provider_http_status == 200


def test_no_shared_provider_status_instance_field() -> None:
    client, http_client = make_client(handler_ok(ok_payload([])))
    try:
        assert not hasattr(client, "_last_provider_status")
    finally:
        run(close_pair(client, http_client))


def test_element_id_above_js_safe_integer_is_rejected() -> None:
    ok_id = 2**53 - 1
    parsed = parse_nearby_payload(
        ok_payload([element(eid=ok_id)]), center_lat=LAT, center_lon=LON,
        retrieved_at=FIXED_NOW_ISO,
    )
    assert [c.element_id for c in parsed.candidates] == [ok_id]
    assert parsed.candidates[0].source_url.endswith(f"/node/{ok_id}")

    for bad_id in (2**53, 2**53 + 1, 10**30):
        parsed = parse_nearby_payload(
            ok_payload([element(eid=bad_id)]), center_lat=LAT,
            center_lon=LON, retrieved_at=FIXED_NOW_ISO,
        )
        assert parsed.candidates == [], bad_id
        assert any("ID" in n for n in parsed.notes), bad_id


def test_huge_integer_coordinates_are_conservatively_excluded() -> None:
    # 极大 int 坐标转 float 会 OverflowError：必须保守排除而不是泄异常。
    el = {
        "type": "node", "id": 1, "timestamp": None,
        "lat": 10**400, "lon": LON,
        "tags": {"opening_hours": "24/7"},
    }
    parsed = parse_nearby_payload(
        ok_payload([el]), center_lat=LAT, center_lon=LON,
        retrieved_at=FIXED_NOW_ISO,
    )
    assert parsed.candidates == []
    assert any("坐标" in n for n in parsed.notes)
    # 合法对照样本不受影响。
    parsed_ok = parse_nearby_payload(
        ok_payload([el, element(eid=2)]), center_lat=LAT, center_lon=LON,
        retrieved_at=FIXED_NOW_ISO,
    )
    assert [c.element_id for c in parsed_ok.candidates] == [2]


def test_constructor_validates_config_before_resources() -> None:
    bad_configs: list[tuple[dict[str, Any], type[Exception]]] = [
        ({"total_deadline_seconds": 0}, ValueError),
        ({"total_deadline_seconds": -1.0}, ValueError),
        ({"total_deadline_seconds": float("nan")}, ValueError),
        ({"total_deadline_seconds": float("inf")}, ValueError),
        ({"total_deadline_seconds": "8"}, TypeError),
        ({"total_deadline_seconds": True}, TypeError),
        ({"cache_ttl_seconds": -0.5}, ValueError),
        ({"cache_ttl_seconds": float("nan")}, ValueError),
        ({"cache_ttl_seconds": float("inf")}, ValueError),
        ({"cache_ttl_seconds": "300"}, TypeError),
        ({"cache_max_keys": -1}, ValueError),
        ({"cache_max_keys": 1.5}, TypeError),
        ({"cache_max_keys": True}, TypeError),
        ({"cache_max_keys": "128"}, TypeError),
    ]
    for kwargs, exc in bad_configs:
        with pytest.raises(exc):
            PoiSourcesClient(**kwargs)


def test_invalid_config_never_allocates_owned_client(monkeypatch) -> None:
    created: list[httpx.AsyncClient] = []
    real_init = httpx.AsyncClient.__init__

    def spy_init(self: httpx.AsyncClient, *a: Any, **kw: Any) -> None:
        created.append(self)
        real_init(self, *a, **kw)

    with monkeypatch.context() as patch:
        patch.setattr(httpx.AsyncClient, "__init__", spy_init)
        with pytest.raises((TypeError, ValueError)):
            PoiSourcesClient(total_deadline_seconds="bad")
    # 校验发生在分配任何 HTTP 资源之前：连 AsyncClient 都没构造过。
    assert created == []


def test_cache_max_keys_zero_is_valid_and_disables_cache() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=ok_payload([]))

    client, http_client = make_client(
        handler, cache_ttl_seconds=300.0, cache_max_keys=0,
        clock=lambda: 1000.0,
    )
    try:
        run(client.fetch_nearby(LAT, LON))
        run(client.fetch_nearby(LAT, LON))
        assert len(client._cache) == 0
    finally:
        run(close_pair(client, http_client))
    assert calls["n"] == 2


def test_deep_nested_bad_json_is_failed_not_crash() -> None:
    # 极深嵌套的坏 JSON 可能抛 RecursionError 而不是 ValueError：
    # 必须折算 typed failed，不让异常泄成 500。
    bad = ("[" * 60000) + ("]" * 60000)
    report = fetch(lambda r: httpx.Response(200, content=bad.encode()))
    assert report.status == "failed"
    # body 确实收到过：fetched_at 如实保留。
    assert report.fetched_at == FIXED_NOW_ISO
    assert report.provider_http_status == 200

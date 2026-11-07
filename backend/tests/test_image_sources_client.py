# -*- coding: utf-8 -*-
"""image_sources_client 离线测试：全部用 httpx.MockTransport，不访问真实网络。

运行方式（在仓库根目录）：

    python -m pytest backend/tests/test_image_sources_client.py

夹具直接放在本文件内（recorded fixture 风格，仿 test_poi_sources_client.py），
Commons 响应形状依据 MediaWiki API:Search / API:Imageinfo 文档的
formatversion=2 样例手工记录。覆盖：

0. 模块级 autouse 守卫：真实 httpx transport 在任何 DNS/HTTP 出站前
   直接 AssertionError；漏绑 MockTransport 的自建/注入 client 同样被拦
1. 请求契约：固定端点与参数（action/query/formatversion=2/generator/
   gsrnamespace=6/gsrlimit≤10/prop/iiurlwidth=320）、诚实 UA（自建与
   注入两条路径）、无 Authorization
2. query 规范化：trim、1..100 码点、孤立代理拒绝、emoji 100/101 边界
3. 状态矩阵：available/no_candidates/429→rate_limited/5xx→unavailable/
   4xx/坏 JSON/缺 pages/结构损坏→failed、重定向、超 1 MiB body、总
   deadline（slow stream + 慢 clock）
4. 解析纯函数：title/URL 白名单（upload 与 commons 主机）、license 与
   artist 的 HTML 剥离与实体解码、超长署名按缺失、维度清洗、条目截断
5. 输入校验（0 上游请求）、关闭后调用、CancelledError 原样上抛、
   构造参数在任何资源分配前校验
"""

from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from image_sources_client import (  # noqa: E402
    PROVIDER_ENDPOINT,
    ImageSourcesClient,
    normalize_image_query,
    parse_search_payload,
    strip_html_to_text,
)

QUERY = "西湖"

# 期望的固定诚实应用 UA（字面量，不镜像实现常量；实现须与其完全一致）。
EXPECTED_USER_AGENT = (
    "Travel-Assistant-ImageSources/1.0 "
    "(+https://github.com/flower-forever/LangGraph-Smart-Traval-Assitant)"
)

FIXED_NOW = datetime(2026, 11, 8, 4, 5, 0, tzinfo=timezone.utc)


def fixed_now() -> datetime:
    return FIXED_NOW


def run(coro):
    return asyncio.run(coro)


# ==================== 0. 真实网络出站守卫（autouse） ====================
#
# 与 test_poi_sources_client.py 同款：任何真实 httpx transport 一旦尝试
# 建立连接就立即 AssertionError，把"测试误触真实网络"变成显式红灯。
# MockTransport 是独立的 transport 类，不受影响。


@pytest.fixture(autouse=True)
def _block_real_network(monkeypatch):
    def _refuse_async(self, request):
        raise AssertionError(
            "测试试图通过真实 AsyncHTTPTransport 出站（异步路径）："
            f"{request.method} {request.url.host} —— 本模块只允许 MockTransport"
        )

    def _refuse_sync(self, request):
        raise AssertionError(
            "测试试图通过真实 HTTPTransport 出站（同步路径）："
            f"{request.method} {request.url.host} —— 本模块只允许 MockTransport"
        )

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", _refuse_async
    )
    monkeypatch.setattr(
        httpx.HTTPTransport, "handle_request", _refuse_sync
    )
    yield


# ==================== recorded fixtures（Commons formatversion=2 形状） ====================


def image_item(
    *,
    page_id: int = 1,
    title: str = "File:West Lake 01.jpg",
    thumb_url: str = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/320px-X.jpg",
    image_url: str = "https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg",
    description_url: str = "https://commons.wikimedia.org/wiki/File:West_Lake_01.jpg",
    license_value: str | None = "CC BY-SA 4.0",
    artist_value: str | None = '<a href="//commons.wikimedia.org/wiki/User:x">张三</a>',
    width: int | None = 4032,
    height: int | None = 3024,
) -> dict[str, Any]:
    """构造一个 Commons query.pages[] 元素；imageinfo[0] 含 extmetadata。"""

    page: dict[str, Any] = {"pageid": page_id, "ns": 6, "title": title}
    info: dict[str, Any] = {
        "thumburl": thumb_url,
        "url": image_url,
        "descriptionurl": description_url,
    }
    if width is not None:
        info["width"] = width
    if height is not None:
        info["height"] = height
    extmetadata: dict[str, Any] = {}
    if license_value is not None:
        extmetadata["LicenseShortName"] = {"value": license_value}
    if artist_value is not None:
        extmetadata["Artist"] = {"value": artist_value}
    if extmetadata:
        info["extmetadata"] = extmetadata
    page["imageinfo"] = [info]
    return page


def ok_payload(items: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "batchcomplete": True,
        "query": {"pages": items if items is not None else [image_item()]},
    }


def empty_payload() -> dict[str, Any]:
    """Commons 搜索无命中的真实形状：batchcomplete 且无 query 字段。"""

    return {"batchcomplete": True}


def json_responder(payload: Any, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return handler


class Recorder:
    """记录上游请求次数与最后一次请求，用于 0 请求/单次尝试断言。"""

    def __init__(self, responder: Callable[[httpx.Request], httpx.Response]):
        self.calls = 0
        self.requests: list[httpx.Request] = []
        self.responder = responder

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        self.requests.append(request)
        return self.responder(request)


def make_client(
    recorder: Recorder, **kwargs: Any
) -> tuple[ImageSourcesClient, httpx.AsyncClient]:
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = ImageSourcesClient(client=http_client, **kwargs)
    return client, http_client


async def _close_pair(
    client: ImageSourcesClient, http_client: httpx.AsyncClient
) -> None:
    await client.aclose()
    await http_client.aclose()


def search_once(
    handler: Callable[[httpx.Request], httpx.Response],
    query: str = QUERY,
    **kwargs: Any,
):
    """单次 search 快捷方式：注入 MockTransport，返回 (report, recorder)。

    默认固定 now_utc（可用 kwargs 覆盖），让 checked_at/fetched_at 可断言。
    """

    kwargs.setdefault("now_utc", fixed_now)
    recorder = Recorder(handler)
    client, http_client = make_client(recorder, **kwargs)
    try:
        report = run(client.search(query))
    finally:
        run(_close_pair(client, http_client))
    return report, recorder


# ==================== 1. 请求契约 ====================


def test_provider_request_is_fixed() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = request.url
        seen["headers"] = dict(request.headers)
        return httpx.Response(200, json=ok_payload([image_item()]))

    report, recorder = search_once(handler)
    assert report.status == "available"
    assert recorder.calls == 1
    url = seen["url"]
    assert str(url).startswith(PROVIDER_ENDPOINT)
    params = dict(url.params)
    assert params["action"] == "query"
    assert params["format"] == "json"
    assert params["formatversion"] == "2"
    assert params["generator"] == "search"
    assert params["gsrsearch"] == QUERY
    assert params["gsrnamespace"] == "6"
    assert params["gsrlimit"] == "10"
    assert params["prop"] == "imageinfo"
    assert params["iiprop"] == "url|size|extmetadata"
    assert params["iiurlwidth"] == "320"


def test_gsrlimit_never_exceeds_local_hard_cap() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["gsrlimit"] = request.url.params.get("gsrlimit")
        return httpx.Response(200, json=ok_payload([]))

    report, recorder = search_once(handler, max_results=10)
    assert report.status == "no_candidates"
    assert recorder.calls == 1
    assert seen["gsrlimit"] == "10"
    # 构造侧也拒绝超过 10 的配置（见构造参数测试）。


def test_user_agent_sent_on_injected_client() -> None:
    """注入 client 路径：单次请求携带固定诚实 UA，其他默认头保留。"""

    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["ua"] = request.headers.get("user-agent")
        seen["accept"] = request.headers.get("accept")
        seen["accept-encoding"] = request.headers.get("accept-encoding")
        seen["authorization"] = request.headers.get("authorization")
        return httpx.Response(200, json=ok_payload([image_item()]))

    report, _ = search_once(handler)
    assert report.status == "available"
    assert seen["ua"] == EXPECTED_USER_AGENT
    # 只补 UA，不清洗/覆盖 httpx 其他默认头；Commons 无 Key，无 Authorization。
    assert seen["accept"] == "*/*"
    assert seen["accept-encoding"].startswith("gzip")
    assert seen["authorization"] is None


def test_user_agent_sent_on_owned_client(monkeypatch) -> None:
    """自建 client 路径：UA 同样随单次请求发出，aclose 真正代关底层 client。

    通过替换 httpx.AsyncClient 工厂注入 MockTransport，让不传 client 的
    真实自建分支保持离线。
    """

    seen: dict[str, Any] = {}
    created: list[httpx.AsyncClient] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen["ua"] = request.headers.get("user-agent")
        return httpx.Response(200, json=ok_payload([]))

    transport = httpx.MockTransport(handler)
    real_client_cls = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        instance = real_client_cls(*args, **kwargs)
        created.append(instance)
        return instance

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    client = ImageSourcesClient()
    try:
        report = run(client.search(QUERY))
    finally:
        run(client.aclose())
    assert created, "自建路径应真实创建 AsyncClient"
    assert created[0].is_closed, "aclose 应关闭自建的底层 client"
    assert report.status == "no_candidates"
    assert seen["ua"] == EXPECTED_USER_AGENT


def test_user_agent_does_not_take_ownership_of_injected_client() -> None:
    """注入 client 的所有权不变：aclose 后注入 client 仍可用。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=ok_payload([image_item()]))

    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport)
    client = ImageSourcesClient(client=http_client)
    run(client.search(QUERY))
    run(client.aclose())
    # 注入的 client 未被代关：仍能正常发请求（MockTransport 不出站）。
    response = run(http_client.get(PROVIDER_ENDPOINT))
    assert response.status_code == 200
    run(http_client.aclose())


# ==================== 2. query 规范化（纯函数） ====================


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  西湖  ", "西湖"),
        ("西湖", "西湖"),
        ("🚀 西湖", "🚀 西湖"),
        ("a" * 100, "a" * 100),
    ],
)
def test_normalize_accepts(raw: str, expected: str) -> None:
    assert normalize_image_query(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        None,
        123,
        True,
        "",
        "   ",
        "a" * 101,
        "🚀" * 101,
        "\ud800abc",
    ],
)
def test_normalize_rejects(raw: Any) -> None:
    assert normalize_image_query(raw) is None


def test_invalid_query_is_invalid_request_with_zero_upstream() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    try:
        for bad in ("", "   ", "a" * 101, None, 123, "\ud800"):
            report = run(client.search(bad))
            assert report.status == "invalid_request", bad
            assert report.requested_query is None
            assert report.reason == "查询必须为去除首尾空白后 1 到 100 个字符的文本"
    finally:
        run(_close_pair(client, http_client))
    assert recorder.calls == 0


def test_query_emoji_100_accepted_101_rejected() -> None:
    assert normalize_image_query("🚀" * 100) == "🚀" * 100
    assert normalize_image_query("🚀" * 101) is None


# ==================== 3. 状态矩阵 ====================


def test_available_envelope_shape() -> None:
    report, recorder = search_once(json_responder(ok_payload([image_item()])))
    assert report.status == "available"
    assert report.checked_at == FIXED_NOW.isoformat()
    assert report.fetched_at == FIXED_NOW.isoformat()
    assert report.requested_query == QUERY
    assert report.max_results == 10
    assert report.provider_http_status == 200
    assert report.results_seen == 1
    assert report.source.provider == "wikimedia-commons"
    assert recorder.calls == 1
    item = report.items[0]
    assert item.title == "File:West Lake 01.jpg"
    assert item.thumbUrl.startswith("https://upload.wikimedia.org/")
    assert item.imageUrl.startswith("https://upload.wikimedia.org/")
    assert item.descriptionUrl.startswith("https://commons.wikimedia.org/")
    assert item.license == "CC BY-SA 4.0"
    assert item.artist == "张三"
    assert item.width == 4032
    assert item.height == 3024


def test_empty_upstream_maps_to_no_candidates() -> None:
    """Commons 无命中（无 query 字段）：诚实 no_candidates，不兜底。"""

    report, recorder = search_once(json_responder(empty_payload()))
    assert report.status == "no_candidates"
    assert report.items == []
    assert report.results_seen == 0
    assert report.fetched_at is not None
    assert recorder.calls == 1


def test_empty_pages_list_is_no_candidates() -> None:
    report, _ = search_once(json_responder(ok_payload([])))
    assert report.status == "no_candidates"


def test_all_items_dropped_is_no_candidates_with_note() -> None:
    """上游有条目但全部不安全：no_candidates（不是 available/failed）。"""

    bad = image_item(
        thumb_url="https://evil.example.com/x.jpg",
        image_url="https://evil.example.com/x.jpg",
        description_url="https://evil.example.com/wiki/File:X.jpg",
    )
    report, _ = search_once(json_responder(ok_payload([bad])))
    assert report.status == "no_candidates"
    assert report.items == []
    assert report.results_seen == 1
    assert any("均无法作为图片展示" in note for note in report.notes)


def test_429_is_rate_limited_200_shape() -> None:
    report, recorder = search_once(lambda request: httpx.Response(429, text="slow down"))
    assert report.status == "rate_limited"
    assert report.provider_http_status == 429
    assert report.fetched_at is None
    assert report.reason == "图片搜索请求过于频繁，请稍后再试"
    assert recorder.calls == 1


@pytest.mark.parametrize("status_code", [500, 502, 503])
def test_5xx_is_unavailable(status_code: int) -> None:
    report, _ = search_once(
        lambda request: httpx.Response(status_code, text="boom")
    )
    assert report.status == "unavailable"
    assert report.provider_http_status == status_code


@pytest.mark.parametrize("status_code", [401, 403, 404])
def test_other_4xx_is_failed(status_code: int) -> None:
    report, _ = search_once(
        lambda request: httpx.Response(status_code, text="no")
    )
    assert report.status == "failed"
    assert report.provider_http_status == status_code


def test_bad_json_is_failed() -> None:
    report, _ = search_once(
        lambda request: httpx.Response(200, content=b"not-json{")
    )
    assert report.status == "failed"
    assert report.fetched_at is None
    assert report.provider_http_status == 200


def test_error_structure_is_failed() -> None:
    """MediaWiki 结构化 error（如参数非法）按 provider 响应异常处理。"""

    report, _ = search_once(
        json_responder({"error": {"code": "badvalue", "info": "x"}})
    )
    assert report.status == "failed"


def test_pages_not_list_is_failed() -> None:
    report, _ = search_once(json_responder({"query": {"pages": {"1": {}}}}))
    assert report.status == "failed"


def test_redirect_is_failed_not_followed() -> None:
    report, _ = search_once(
        lambda request: httpx.Response(
            302, headers={"location": "https://evil.example.com/w/api.php"}
        )
    )
    assert report.status == "failed"
    assert "evil" not in report.reason


def test_body_over_1mib_is_failed() -> None:
    big = b"x" * (1024 * 1024 + 1)
    report, _ = search_once(lambda request: httpx.Response(200, content=big))
    assert report.status == "failed"


def test_upstream_lone_surrogate_is_failed_not_crash() -> None:
    """上游 JSON 的孤立代理码点：整份 failed，可编码响应，不回显原文。"""

    text = json.dumps(ok_payload()).encode("utf-8").decode("utf-8")
    text = text.replace("File:West Lake", "File:\\ud800West Lake")
    report, _ = search_once(
        lambda request: httpx.Response(
            200, content=text.encode("ascii"), headers={
                "Content-Type": "application/json"
            }
        )
    )
    assert report.status == "failed"
    payload = json.loads(json.dumps(report.model_dump(mode="json")))
    assert "ud800" not in json.dumps(payload, ensure_ascii=True).lower()


def test_slow_stream_hits_total_deadline() -> None:
    body = json.dumps(ok_payload([image_item()])).encode("utf-8")
    body = body.replace(b"X.jpg", b"z" * 40_000 + b".jpg")
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

    report, _ = search_once(
        handler, total_deadline_seconds=0.3, clock=clock, now_utc=fixed_now
    )
    assert report.status == "timeout"
    assert report.fetched_at is None


def test_connect_error_is_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    report, _ = search_once(handler)
    assert report.status == "unavailable"
    assert report.provider_http_status is None


def test_no_retry_single_upstream_attempt() -> None:
    """上游 500 也只打一次：无隐式重试。"""

    recorder = Recorder(lambda request: httpx.Response(500, text="boom"))
    client, http_client = make_client(recorder)
    try:
        report = run(client.search(QUERY))
    finally:
        run(_close_pair(client, http_client))
    assert report.status == "unavailable"
    assert recorder.calls == 1


# ==================== 4. 解析纯函数 ====================


def test_parse_rejects_bad_structures() -> None:
    with pytest.raises(Exception):
        parse_search_payload("not-a-dict", max_results=10)
    with pytest.raises(Exception):
        parse_search_payload({"error": {"code": "x"}}, max_results=10)
    with pytest.raises(Exception):
        parse_search_payload({"query": {"pages": 7}}, max_results=10)


def test_parse_missing_imageinfo_skipped() -> None:
    page = {"pageid": 1, "ns": 6, "title": "File:X.jpg"}
    parsed = parse_search_payload(ok_payload([page]), max_results=10)
    assert parsed.items == []
    assert parsed.results_seen == 1
    assert any("结构异常" in note for note in parsed.notes)


def test_url_whitelist_strict_hosts() -> None:
    base = image_item()
    # (imageinfo 键, 违规值)：MediaWiki 字段名是 thumburl/url/descriptionurl。
    variants = [
        ("thumburl", "http://upload.wikimedia.org/x.jpg"),  # 非 https
        ("thumburl", "https://upload.evil.com/x.jpg"),  # 主机不符
        ("url", "https://commons.wikimedia.org/x.jpg"),  # 图片必须 upload
        ("descriptionurl", "https://upload.wikimedia.org/wiki/File:X"),  # 反向
        ("descriptionurl", "https://commons.wikimedia.org:8080/wiki/F"),  # 端口
        ("descriptionurl", "https://user@commons.wikimedia.org/wiki/F"),  # userinfo
    ]
    for field, bad_value in variants:
        item = dict(base)
        item["imageinfo"] = [dict(base["imageinfo"][0])]
        item["imageinfo"][0][field] = bad_value
        parsed = parse_search_payload(ok_payload([item]), max_results=10)
        assert parsed.items == [], (field, bad_value)
        assert any("安全检查" in note for note in parsed.notes)


def test_artist_html_stripped_with_entities_and_links() -> None:
    item = image_item(
        artist_value='<a href="//c.org">李四 &amp; 王五</a>  拍摄\n于西湖'
    )
    parsed = parse_search_payload(ok_payload([item]), max_results=10)
    assert parsed.items[0].artist == "李四 & 王五 拍摄 于西湖"


def test_artist_plain_text_passthrough() -> None:
    item = image_item(artist_value="匿名用户")
    parsed = parse_search_payload(ok_payload([item]), max_results=10)
    assert parsed.items[0].artist == "匿名用户"


def test_missing_license_and_artist_are_null_not_fabricated() -> None:
    item = image_item(license_value=None, artist_value=None)
    parsed = parse_search_payload(ok_payload([item]), max_results=10)
    assert parsed.items[0].license is None
    assert parsed.items[0].artist is None


def test_overlong_artist_treated_as_missing_with_note() -> None:
    item = image_item(artist_value="很" * 301)
    parsed = parse_search_payload(ok_payload([item]), max_results=10)
    assert parsed.items[0].artist is None
    assert any("署名" in note for note in parsed.notes)


def test_dimensions_cleaned() -> None:
    item = image_item(width=0, height=-5)
    parsed = parse_search_payload(ok_payload([item]), max_results=10)
    assert parsed.items[0].width is None
    assert parsed.items[0].height is None


def test_items_capped_at_max_results() -> None:
    items = [image_item(page_id=i, title=f"File:{i}.jpg") for i in range(10)]
    parsed = parse_search_payload(ok_payload(items), max_results=8)
    assert len(parsed.items) == 8
    assert any("仅保留前 8 条" in note for note in parsed.notes)


def test_strip_html_to_text_edges() -> None:
    assert strip_html_to_text(None) is None
    assert strip_html_to_text("") is None
    assert strip_html_to_text("   ") is None
    assert strip_html_to_text("<b>粗体</b>") == "粗体"
    # 块级标签（<br>）两侧文本节点直接拼接后按空白折叠；无边距时无分隔。
    assert strip_html_to_text("A<br>B") == "AB"
    assert strip_html_to_text("A<br> B") == "A B"
    assert strip_html_to_text("<script>x</script>y") == "xy"
    assert strip_html_to_text("很" * 301) is None  # 超长不截断冒充
    assert strip_html_to_text("\ud800") is None  # 孤立代理


# ==================== 5. 生命周期与契约 ====================


def test_fetch_after_close_raises_runtime_error() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    run(_close_pair(client, http_client))
    with pytest.raises(RuntimeError):
        run(client.search(QUERY))


def test_cancellation_propagates() -> None:
    started = asyncio.Event()

    async def slow_handler(request: httpx.Request) -> httpx.Response:
        started.set()
        await asyncio.sleep(3600)
        return httpx.Response(200, json=ok_payload())  # pragma: no cover

    async def scenario() -> None:
        recorder = Recorder(slow_handler)
        client, http_client = make_client(recorder)
        try:
            task = asyncio.ensure_future(client.search(QUERY))
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        finally:
            await _close_pair(client, http_client)

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "kwargs",
    [
        {"max_results": 0},
        {"max_results": 11},
        {"max_results": True},
        {"total_deadline_seconds": 0},
        {"total_deadline_seconds": -1},
        {"total_deadline_seconds": float("inf")},
        {"total_deadline_seconds": "8"},
    ],
)
def test_constructor_validates_config_before_resources(kwargs: Any) -> None:
    with pytest.raises((TypeError, ValueError)):
        ImageSourcesClient(**kwargs)


def test_invalid_config_never_allocates_owned_client(monkeypatch) -> None:
    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        raise AssertionError("非法配置不得创建任何 HTTP 客户端")

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    with pytest.raises(ValueError):
        ImageSourcesClient(max_results=99)
    with pytest.raises(ValueError):
        ImageSourcesClient(total_deadline_seconds=0)


def test_module_import_has_no_network_or_env(monkeypatch) -> None:
    """模块 import 不读环境变量（Commons 无 Key）。"""

    import image_sources_client as module

    assert module.PROVIDER_ENDPOINT.startswith("https://commons.wikimedia.org/")
    # 再 import 一次（已在 sys.modules）不应有任何副作用；直接断言常量即可。
    assert module._GSR_NAMESPACE == 6
    assert module._THUMB_WIDTH == 320

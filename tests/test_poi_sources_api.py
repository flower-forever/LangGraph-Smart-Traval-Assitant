# -*- coding: utf-8 -*-
"""poi_sources_api 离线测试：FastAPI TestClient + 真实 PoiSourcesClient(MockTransport)。

全部离线，不发真实网络请求；生产 app 的 POI 请求通过把
``api_server.app.state.poi_sources_client`` 换成 MockTransport 客户端完成，
不 import 启动真实服务、不连接 MCP / DashScope / Overpass。覆盖：

1. available 字段、requested/source/固定 provider query
2. no_candidates / timeout / rate_limited / unavailable / failed → 200 信封
3. 非法 lat/lon/缺参/布尔/NaN → 422 且 0 provider 请求
4. 默认 client 与注入 client 的关闭所有权、多 app 状态隔离
5. 初始化失败不拖死 app、失败后可恢复；app lifespan 与 router lifespan 同时执行
6. CancelledError 原样上抛
7. 生产 api_server 已注册该 GET、无模型 Key 下 POI 路由可用且既有端点语义不变
"""

from __future__ import annotations

import os
import sys
import unittest.mock

# 必须在 import api_server 之前：模块导入时会执行 load_dotenv()。
# 双重保险：
# 1) PYTHON_DOTENV_DISABLED=1（与其他测试文件的约定一致，导入期短路）；
# 2) 不依赖 dotenv 版本行为：只在受控导入 api_server 期间把 dotenv.load_dotenv
#    临时替换为 no-op——api_server 的 ``from dotenv import load_dotenv`` 在其
#    导入时刻绑定的就是这个 no-op，无论安装哪个版本的 python-dotenv 都绝不
#    读取真实 .env；导入完成后立即还原原函数，不污染同进程的其他测试模块。
if not os.environ.get("PYTHON_DOTENV_DISABLED"):
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"

import dotenv  # noqa: E402

_original_load_dotenv = dotenv.load_dotenv


def _dotenv_noop(*args: object, **kwargs: object) -> bool:
    return False


# 若 api_server 已被同进程的其他测试模块先导入，本模块不再重复导入，
# 绑定断言只在本模块亲手完成受控导入时才有意义。
_api_server_fresh_imported = "api_server" not in sys.modules
with unittest.mock.patch.object(dotenv, "load_dotenv", _dotenv_noop):
    import api_server  # noqa: E402

import asyncio  # noqa: E402
import threading  # noqa: E402
from contextlib import asynccontextmanager, contextmanager  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from typing import Any, Iterator  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import api_server  # noqa: E402
import poi_sources_api  # noqa: E402
from poi_sources_api import poi_sources_router_factory  # noqa: E402
from poi_sources_client import PoiSourcesClient  # noqa: E402

LAT, LON = 31.2304, 121.4737

FIXED_NOW = datetime(2026, 10, 30, 4, 5, 0, tzinfo=timezone.utc)


def fixed_now() -> datetime:
    return FIXED_NOW


def element(eid: int = 1, **kwargs: Any) -> dict[str, Any]:
    el: dict[str, Any] = {
        "type": kwargs.get("etype", "node"),
        "id": eid,
        "timestamp": "2025-06-01T08:00:00Z",
        "tags": {"name": f"站点{eid}", "opening_hours": "Mo-Su 08:00-18:00"},
    }
    if el["type"] == "node":
        el["lat"] = LAT
        el["lon"] = LON
    else:
        el["center"] = {"lat": LAT, "lon": LON}
    return el


def ok_payload() -> dict[str, Any]:
    return {"version": 0.6, "osm3s": {}, "elements": [element(1)]}


def ok_responder(payload: dict[str, Any]):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    return handler


class Recorder:
    """记录 provider 请求次数与最后一次请求，用于 0 请求/不重试断言。"""

    def __init__(self, responder: Any) -> None:
        self.calls = 0
        self.last_request: httpx.Request | None = None
        self._lock = threading.Lock()
        self.responder = responder

    def __call__(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            self.calls += 1
            self.last_request = request
        return self.responder(request)


def make_client(
    recorder: Recorder, *, cache_ttl_seconds: float = 0.0
) -> tuple[PoiSourcesClient, httpx.AsyncClient]:
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    return (
        PoiSourcesClient(
            client=http_client, cache_ttl_seconds=cache_ttl_seconds
        ),
        http_client,
    )


async def _close_pair(
    poi_client: PoiSourcesClient, http_client: httpx.AsyncClient
) -> None:
    await poi_client.aclose()
    await http_client.aclose()


@contextmanager
def poi_app(recorder: Recorder) -> Iterator[tuple[TestClient, PoiSourcesClient]]:
    """带 /health 的最小 app；退出时关闭注入的 client。"""

    app = FastAPI()
    poi_client, http_client = make_client(recorder)
    app.include_router(poi_sources_router_factory(client=poi_client))

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "healthy"}

    try:
        with TestClient(app) as test_client:
            yield test_client, poi_client
    finally:
        asyncio.run(_close_pair(poi_client, http_client))


@pytest.fixture()
def ok_app() -> Iterator[tuple[TestClient, Recorder]]:
    recorder = Recorder(ok_responder(ok_payload()))
    with poi_app(recorder) as (test_client, _poi_client):
        yield test_client, recorder


# ==================== 1. available ====================


def test_available_full_envelope(ok_app) -> None:
    test_client, recorder = ok_app
    response = test_client.get(
        "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
    )

    assert response.status_code == 200
    assert response.headers["x-poi-sources-status"] == "available"
    body = response.json()
    assert body["status"] == "available"
    assert body["provider_http_status"] == 200
    assert body["checked_at"]
    assert body["fetched_at"] is not None
    assert body["requested"] == {"lat": LAT, "lon": LON}
    assert body["radius_m"] == 100.0
    assert body["cached"] is False
    assert body["source"]["provider"] == "overpass-api.de"
    assert body["source"]["endpoint"] == "https://overpass-api.de/api/interpreter"
    assert body["source"]["attribution_url"] == "https://www.openstreetmap.org/copyright"
    assert body["source"]["license"] == "ODbL 1.0"
    assert body["source"]["data_source"] == "OpenStreetMap"
    assert body["source_elements_seen"] == 1
    candidate = body["candidates"][0]
    assert candidate["element_type"] == "node"
    assert candidate["element_id"] == 1
    assert candidate["name"] == "站点1"
    assert candidate["location"] == {"lat": LAT, "lon": LON}
    assert candidate["distance_m"] == 0.0
    assert candidate["source_url"] == "https://www.openstreetmap.org/node/1"
    assert candidate["retrieved_at"] == body["fetched_at"]
    assert candidate["source_updated_at"] == "2025-06-01T08:00:00Z"
    assert candidate["identity_status"] == "unconfirmed"
    assert candidate["opening_hours"] == {
        "state": "source_only", "value": "Mo-Su 08:00-18:00",
    }
    assert candidate["fee"] == {"state": "unknown", "value": None}
    assert candidate["charge"] == {"state": "unknown", "value": None}
    assert recorder.calls == 1


def test_provider_request_is_fixed_and_has_no_user_url(ok_app) -> None:
    test_client, recorder = ok_app
    test_client.get(
        "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
    )

    request = recorder.last_request
    assert request is not None
    assert request.url.host == "overpass-api.de"
    assert request.url.path == "/api/interpreter"
    data = request.url.params["data"]
    assert "nwr[\"opening_hours\"]" in data
    assert "nwr[\"fee\"]" in data
    assert "nwr[\"charge\"]" in data
    assert "(around:100.0,31.2304,121.4737)" in data
    assert "out meta center 30;" in data
    # 只有一个 data 参数：没有用户可控 URL/QL 通道。
    assert set(request.url.params.keys()) == {"data"}


def test_cache_hit_on_second_request() -> None:
    recorder = Recorder(ok_responder(ok_payload()))
    app = FastAPI()
    poi_client, http_client = make_client(recorder, cache_ttl_seconds=300.0)
    app.include_router(poi_sources_router_factory(client=poi_client))
    try:
        with TestClient(app) as test_client:
            first = test_client.get(
                "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
            )
            second = test_client.get(
                "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
            )
            assert first.json()["cached"] is False
            assert second.json()["cached"] is True
            assert second.json()["fetched_at"] == first.json()["fetched_at"]
    finally:
        asyncio.run(_close_pair(poi_client, http_client))
    assert recorder.calls == 1


# ==================== 2. no_candidates / 上游失败 → 200 信封 ====================


def test_no_candidates_is_200_envelope() -> None:
    recorder = Recorder(ok_responder({"version": 0.6, "osm3s": {}, "elements": []}))
    with poi_app(recorder) as (test_client, _poi_client):
        response = test_client.get(
            "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
        )

    assert response.status_code == 200
    assert response.headers["x-poi-sources-status"] == "no_candidates"
    body = response.json()
    assert body["status"] == "no_candidates"
    assert body["candidates"] == []
    assert body["fetched_at"] is not None
    assert recorder.calls == 1


def test_timeout_is_200_and_not_retried() -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("read timeout", request=request)

    recorder = Recorder(timeout)
    with poi_app(recorder) as (test_client, _poi_client):
        response = test_client.get(
            "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "timeout"
    assert body["fetched_at"] is None
    assert recorder.calls == 1


def test_rate_limited_is_200_envelope() -> None:
    recorder = Recorder(lambda request: httpx.Response(429, text="slow down"))
    with poi_app(recorder) as (test_client, _poi_client):
        response = test_client.get(
            "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "rate_limited"
    assert body["provider_http_status"] == 429
    assert "slow down" not in response.text
    assert recorder.calls == 1


@pytest.mark.parametrize("status_code", [500, 502, 503])
def test_5xx_is_200_unavailable(status_code: int) -> None:
    recorder = Recorder(
        lambda request: httpx.Response(status_code, text="secret upstream body")
    )
    with poi_app(recorder) as (test_client, _poi_client):
        response = test_client.get(
            "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "unavailable"
    assert body["provider_http_status"] == status_code
    assert "secret upstream body" not in response.text
    assert recorder.calls == 1


def test_bad_json_is_200_failed() -> None:
    recorder = Recorder(lambda request: httpx.Response(200, content=b"<html>err</html>"))
    with poi_app(recorder) as (test_client, _poi_client):
        response = test_client.get(
            "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    assert "<html>" not in response.text


def test_remark_partial_error_is_200_failed() -> None:
    payload = ok_payload()
    payload["remark"] = "runtime error: query timed out."
    recorder = Recorder(ok_responder(payload))
    with poi_app(recorder) as (test_client, _poi_client):
        response = test_client.get(
            "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    # 部分错误不当完整成功：即便有元素也不返回候选。
    assert body["candidates"] == []


# ==================== 3. 非法输入 422 + 0 provider 请求 ====================


def test_invalid_inputs_422_and_zero_provider_calls() -> None:
    recorder = Recorder(ok_responder(ok_payload()))
    local_invalid = [
        {"lat": 90.1, "lon": 0.0},
        {"lat": -90.1, "lon": 0.0},
        {"lat": 0.0, "lon": 180.1},
        {"lat": 0.0, "lon": -180.1},
        {"lat": "NaN", "lon": 0.0},
        {"lat": "Infinity", "lon": 0.0},
        {"lat": "1e309", "lon": 0.0},
        {"lat": "abc", "lon": 0.0},
        {"lat": True, "lon": 0.0},
        {"lat": 0.0, "lon": True},
    ]

    with poi_app(recorder) as (test_client, _poi_client):
        for params in local_invalid:
            response = test_client.get("/api/poi-sources/nearby", params=params)
            assert response.status_code == 422, params
            assert "detail" in response.json(), params
            assert recorder.calls == 0, params

        # 布尔类型：FastAPI 层拒绝（bool 不是 float 合法入参）。
        assert recorder.calls == 0


def test_missing_params_422_without_provider_call() -> None:
    recorder = Recorder(ok_responder(ok_payload()))
    with poi_app(recorder) as (test_client, _poi_client):
        assert test_client.get("/api/poi-sources/nearby").status_code == 422
        assert (
            test_client.get(
                "/api/poi-sources/nearby", params={"lat": 1.0}
            ).status_code
            == 422
        )

    assert recorder.calls == 0


# ==================== 4. 生命周期与所有权 ====================


def test_client_unavailable_before_lifespan_returns_503() -> None:
    recorder = Recorder(ok_responder(ok_payload()))
    poi_client, http_client = make_client(recorder)
    app = FastAPI()
    app.include_router(poi_sources_router_factory(client=poi_client))

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "healthy"}

    test_client = TestClient(app)
    try:
        response = test_client.get(
            "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
        )
        assert response.status_code == 503
        assert response.json()["detail"] == "兴趣点公开资料服务未初始化，请稍后再试。"
        assert "overpass" not in response.text
        assert "PoiSourcesClient" not in response.text
        assert test_client.get("/health").json() == {"status": "healthy"}
        assert recorder.calls == 0
    finally:
        test_client.close()
        asyncio.run(_close_pair(poi_client, http_client))


def test_multiple_apps_get_isolated_default_clients() -> None:
    app_a = FastAPI()
    app_b = FastAPI()
    app_a.include_router(poi_sources_router_factory())
    app_b.include_router(poi_sources_router_factory())

    with TestClient(app_a) as _ta, TestClient(app_b) as _tb:
        client_a = app_a.state.poi_sources_client
        client_b = app_b.state.poi_sources_client
        assert isinstance(client_a, PoiSourcesClient)
        assert isinstance(client_b, PoiSourcesClient)
        assert client_a is not client_b

    assert client_a._closed is True
    assert client_a._client is None
    assert client_b._closed is True
    assert client_b._client is None
    assert app_a.state.poi_sources_client is None
    assert app_b.state.poi_sources_client is None


def test_same_router_included_in_two_apps_stays_isolated() -> None:
    shared_router = poi_sources_router_factory()
    app_a = FastAPI()
    app_b = FastAPI()
    app_a.include_router(shared_router)
    app_b.include_router(shared_router)

    with TestClient(app_a) as _ta, TestClient(app_b) as _tb:
        client_a = app_a.state.poi_sources_client
        client_b = app_b.state.poi_sources_client
        assert client_a is not None and client_b is not None
        assert client_a is not client_b

    assert client_a._closed is True
    assert client_b._closed is True


def test_app_lifespan_and_router_lifespan_both_run() -> None:
    events: list[tuple[str, Any]] = []

    @asynccontextmanager
    async def app_lifespan(app: FastAPI):
        events.append(("app-start", getattr(app.state, "poi_sources_client", "missing")))
        yield
        events.append(("app-stop", getattr(app.state, "poi_sources_client", "missing")))

    app = FastAPI(lifespan=app_lifespan)
    app.include_router(poi_sources_router_factory())

    with TestClient(app) as _test_client:
        poi_client = app.state.poi_sources_client
        assert isinstance(poi_client, PoiSourcesClient)
        events.append(("running", poi_client))

    assert [name for name, _value in events] == ["app-start", "running", "app-stop"]
    assert events[0][1] == "missing"
    assert events[2][1] is None
    assert poi_client._closed is True


def test_injected_client_is_not_closed_by_router_lifespan() -> None:
    recorder = Recorder(ok_responder(ok_payload()))
    poi_client, http_client = make_client(recorder)
    app = FastAPI()
    app.include_router(poi_sources_router_factory(client=poi_client))

    try:
        with TestClient(app) as test_client:
            assert app.state.poi_sources_client is poi_client
            assert (
                test_client.get(
                    "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
                ).status_code
                == 200
            )

        assert poi_client._closed is False
        assert http_client.is_closed is False
        assert app.state.poi_sources_client is poi_client
        report = asyncio.run(poi_client.fetch_nearby(LAT, LON))
        assert report.status == "available"
    finally:
        asyncio.run(_close_pair(poi_client, http_client))


def test_closed_injected_client_returns_503() -> None:
    recorder = Recorder(ok_responder(ok_payload()))
    poi_client, http_client = make_client(recorder)
    app = FastAPI()
    app.include_router(poi_sources_router_factory(client=poi_client))

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "healthy"}

    try:
        with TestClient(app) as test_client:
            asyncio.run(poi_client.aclose())
            response = test_client.get(
                "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
            )
            assert response.status_code == 503
            assert response.json()["detail"] == "兴趣点公开资料服务未初始化，请稍后再试。"
            assert test_client.get("/health").status_code == 200
    finally:
        asyncio.run(_close_pair(poi_client, http_client))


def test_router_startup_makes_no_provider_request() -> None:
    recorder = Recorder(ok_responder(ok_payload()))
    with poi_app(recorder) as (_test_client, _poi_client):
        pass
    assert recorder.calls == 0


class _ExplodingClient:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        raise RuntimeError(
            "secret-token https://overpass-api.de/api/interpreter boom"
        )


def test_init_failure_does_not_kill_health_and_recovers(monkeypatch) -> None:
    recorder = Recorder(ok_responder(ok_payload()))
    app = FastAPI()
    app.include_router(poi_sources_router_factory())

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "healthy"}

    with monkeypatch.context() as patch:
        patch.setattr(poi_sources_api, "PoiSourcesClient", _ExplodingClient)
        with TestClient(app) as test_client:
            assert app.state.poi_sources_client is None
            assert test_client.get("/health").json() == {"status": "healthy"}
            response = test_client.get(
                "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
            )
            assert response.status_code == 503
            assert response.json()["detail"] == "兴趣点公开资料服务未初始化，请稍后再试。"
            assert "secret-token" not in response.text
            assert "overpass" not in response.text
            assert "boom" not in response.text

    # 故障解除后，同一个 app 重新启动 lifespan 能重建可用 client。
    poi_client, http_client = make_client(recorder)
    try:
        with TestClient(app) as test_client:
            recovered = app.state.poi_sources_client
            assert isinstance(recovered, PoiSourcesClient)
            app.state.poi_sources_client = poi_client
            response = test_client.get(
                "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
            )
            assert response.status_code == 200
            assert response.json()["status"] == "available"
    finally:
        asyncio.run(_close_pair(poi_client, http_client))


# ==================== 5. 取消 ====================


class _CancelledClient(PoiSourcesClient):
    async def fetch_nearby(self, lat: Any, lon: Any):  # type: ignore[override]
        raise asyncio.CancelledError


def test_cancelled_error_propagates_from_route() -> None:
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={}))
    )
    poi_client = _CancelledClient(client=http_client)
    app = FastAPI()
    app.include_router(poi_sources_router_factory(client=poi_client))

    async def scenario() -> None:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                with pytest.raises(asyncio.CancelledError):
                    await client.get(
                        "/api/poi-sources/nearby",
                        params={"lat": LAT, "lon": LON},
                    )
        await poi_client.aclose()
        await http_client.aclose()

    asyncio.run(scenario())


# ==================== 6. 生产 api_server 接线 ====================


def _prepare_no_model_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("DASHSCOPE_API_KEY", "AMAP_API_KEY", "API_HOST"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])


@pytest.fixture()
def production_client(monkeypatch: pytest.MonkeyPatch):
    _prepare_no_model_keys(monkeypatch)
    with TestClient(api_server.app) as test_client:
        yield test_client


def test_production_openapi_registers_poi_sources_get() -> None:
    # dotenv 局部 guard 核验：只在受控导入期间 no-op 生效，之后原函数身份
    # 已还原（dotenv.load_dotenv 回到 _original_load_dotenv）；这里只断言
    # 函数身份，绝不调用 load_dotenv，不读真实 .env。
    import dotenv as _dotenv

    assert _dotenv.load_dotenv is _original_load_dotenv
    if _api_server_fresh_imported:
        # 本模块亲手受控导入 api_server 时，导入期间绑定的是 no-op。
        assert api_server.load_dotenv is _dotenv_noop

    schema = api_server.app.openapi()
    assert "/api/poi-sources/nearby" in schema["paths"]
    operation = schema["paths"]["/api/poi-sources/nearby"]
    assert "get" in operation
    parameters = {item["name"]: item for item in operation["get"]["parameters"]}
    assert set(parameters) == {"lat", "lon"}
    assert all(parameters[name]["required"] is True for name in parameters)
    ok_schema = operation["get"]["responses"]["200"]["content"]["application/json"][
        "schema"
    ]
    assert ok_schema.get("$ref", "").endswith("/PoiSourceReport")
    # 既有业务路径没有因为接入 POI 路由而消失。
    assert "/api/trips/plan" in schema["paths"]
    assert "/api/weather/day" in schema["paths"]


def test_production_poi_sources_works_without_model_key(
    production_client: TestClient,
) -> None:
    recorder = Recorder(ok_responder(ok_payload()))
    poi_client, http_client = make_client(recorder)
    api_server.app.state.poi_sources_client = poi_client
    try:
        response = production_client.get(
            "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
        )
        assert response.status_code == 200
        assert response.json()["status"] == "available"
        assert recorder.calls == 1

        health = production_client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "healthy"
    finally:
        asyncio.run(_close_pair(poi_client, http_client))


def test_production_existing_endpoints_keep_their_semantics(
    production_client: TestClient,
) -> None:
    health = production_client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["agent_ready"] is False

    example = production_client.get("/api/trips/example")
    assert example.status_code == 200
    assert example.json()["source"] == "example"

    plan = production_client.post(
        "/api/trips/plan",
        json={"destination": "杭州", "days": 2, "travel_mode": "walking"},
    )
    assert plan.status_code == 503
    assert "DASHSCOPE_API_KEY" in plan.json()["detail"]


def test_production_poi_sources_init_failure_does_not_kill_health(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _prepare_no_model_keys(monkeypatch)
    with monkeypatch.context() as patch:
        patch.setattr(poi_sources_api, "PoiSourcesClient", _ExplodingClient)
        with TestClient(api_server.app) as test_client:
            health = test_client.get("/health")
            assert health.status_code == 200
            assert health.json()["status"] == "healthy"

            example = test_client.get("/api/trips/example")
            assert example.status_code == 200

            response = test_client.get(
                "/api/poi-sources/nearby", params={"lat": LAT, "lon": LON}
            )
            assert response.status_code == 503
            assert response.json()["detail"] == "兴趣点公开资料服务未初始化，请稍后再试。"
            for leaked in ("secret-token", "overpass", "boom", "Traceback"):
                assert leaked not in response.text

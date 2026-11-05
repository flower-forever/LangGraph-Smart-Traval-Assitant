# -*- coding: utf-8 -*-
"""固定端点衔接路线 HTTP 接口（POST /api/trips/days/leg-refresh）离线回归。

全部使用假高德客户端或真实 ``AMapClient`` + ``httpx.MockTransport``，不读 .env、
不访问真实高德 / 模型 / 天气 / Tavily，也不创建任何模型调用。覆盖：

- ready 精确回显 parent / day / date / mode / 两端 id 与 WGS84 数值；
- 0 距离、null 耗时、0 / 负坐标不被当成缺失；
- no_key 零客户端零 route、timeout / unavailable / failed typed 失败；
- owned client 每次请求创建并关闭，外层取消继续传播；
- 客户端创建/进入失败返回固定 failed，不回显异常 / Key / URL；
- CORS 白名单与 BrowserOriginGuard 复用，非法 Origin 在路由前被拒；
- 422 固定安全形状，不回显 input / 字段名 / 原始 body；
- 真实 AMapClient + MockTransport 只命中固定 v5 direction 端点，
  不做 geocode / POI / LLM / 重试。
"""

import os

# 测试进程绝不读取仓库里可能存在的真实 .env（必须在 import api_server 之前）。
os.environ["PYTHON_DOTENV_DISABLED"] = "1"

import asyncio
import time
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

import api_server
from leg_refresh import LegRefreshRequest
from travel_itinerary import (
    AMapClient,
    AMapError,
    Coordinate,
    RouteResult,
    gcj02_to_wgs84,
    wgs84_to_gcj02,
)

URL = "/api/trips/days/leg-refresh"
FAKE_KEY = "FAKE-LEG-REFRESH-HTTP-KEY-0001"
ENDPOINTS = {
    "walking": "/v5/direction/walking",
    "driving": "/v5/direction/driving",
}
REASONS = {
    "no_key": "服务端未配置高德地图 Key，本次未执行任何路线查询。",
    "timeout": "衔接路线查询超时，本次未返回路线。",
    "unavailable": "高德地图路线服务暂时不可用，本次未返回路线。",
    "failed": "衔接路线数据不可用，本次未返回路线。",
}
EXPECTED_KEYS = {
    "parent",
    "day",
    "date",
    "travel_mode",
    "from_stop",
    "to_stop",
    "map_status",
    "leg",
    "reason",
    "source",
    "checked_at",
}
SENTINEL = "SENTINEL-LEG-REFRESH-MUST-NOT-ECHO"


# ==================== autouse：真实出站守卫 ====================


@pytest.fixture(autouse=True)
def forbid_real_async_send(monkeypatch):
    """任何非 MockTransport 的 httpx.AsyncClient 出站立即失败。

    只拦截 ``send``，不影响 weather / POI / Tavily 的 lifespan 在启动时
    创建（但不发送）自有客户端；任何真实业务网络请求都不会发生。
    """

    original_send = httpx.AsyncClient.send

    async def guarded_send(self, request, **kwargs):
        transport = getattr(self, "_transport", None)
        if not isinstance(transport, httpx.MockTransport):
            raise AssertionError("测试禁止真实 HTTP 出站；必须显式注入 MockTransport")
        return await original_send(self, request, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "send", guarded_send)


# ==================== 构造工具 ====================


def request_body(**overrides):
    body = {
        "parent": {"trip_id": "opaque-current-id", "revision": 1},
        "day": 1,
        "date": None,
        "travel_mode": "walking",
        "from_stop": {"id": "anchor-id", "location": {"lng": 120.1, "lat": 30.2}},
        "to_stop": {"id": "tail-first-id", "location": {"lng": 120.2, "lat": 30.3}},
    }
    body.update(overrides)
    return body


def invalid_bodies():
    """422 反例；SENTINEL 放在 input 会被默认 FastAPI 422 回显的位置。"""

    cases = []

    body = request_body()
    body["extra"] = SENTINEL
    cases.append(body)

    body = request_body()
    body["from_stop"]["extra"] = SENTINEL
    cases.append(body)

    body = request_body()
    body["from_stop"]["location"]["extra"] = SENTINEL
    cases.append(body)

    body = request_body()
    del body["from_stop"]["location"]
    cases.append(body)

    body = request_body()
    body["to_stop"]["id"] = body["from_stop"]["id"]
    cases.append(body)

    for day in (0, 8, True):
        body = request_body()
        body["day"] = day
        cases.append(body)

    body = request_body()
    body["parent"]["revision"] = True
    cases.append(body)

    body = request_body()
    body["parent"]["revision"] = -1
    cases.append(body)

    body = request_body()
    body["parent"]["revision"] = 1.5
    cases.append(body)

    body = request_body()
    body["parent"]["trip_id"] = ""
    cases.append(body)

    body = request_body()
    body["parent"]["trip_id"] = "a\x01b"
    cases.append(body)

    for date in ("2026-02-30", "2026-11-02T00:00:00", "20261102", ""):
        body = request_body()
        body["date"] = date
        cases.append(body)

    body = request_body()
    body["travel_mode"] = "transit"
    cases.append(body)

    for value in ("120.1", True, None, 181):
        body = request_body()
        body["from_stop"]["location"]["lng"] = value
        cases.append(body)

    body = request_body()
    body["from_stop"]["location"]["lat"] = -91
    cases.append(body)

    body = request_body()
    body["from_stop"]["id"] = ""
    cases.append(body)

    body = request_body()
    body["from_stop"]["id"] = "x" * 101
    cases.append(body)

    body = request_body()
    del body["to_stop"]["id"]
    cases.append(body)

    cases.append([])
    cases.append({})
    return cases


# ==================== 假高德客户端 ====================


class FakeLegAMap:
    """注入用假客户端：记录 route 单次调用，几何按真实转换回 WGS84。"""

    configured = True
    instances = []
    distance_m = 1234
    duration_minutes = 5.0

    def __init__(self, api_key, *, timeout=6.0):
        self.api_key = api_key
        self.timeout = timeout
        self.closed = False
        self.route_calls = []
        self.geocode_calls = []
        self.poi_calls = []
        FakeLegAMap.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.closed = True

    async def route(self, origin, destination, mode):
        self.route_calls.append((origin, destination, mode))
        wgs_origin = gcj02_to_wgs84(origin.lng, origin.lat)
        wgs_destination = gcj02_to_wgs84(destination.lng, destination.lat)
        return RouteResult(
            geometry=[
                Coordinate(lng=wgs_origin[0], lat=wgs_origin[1]),
                Coordinate(lng=wgs_destination[0], lat=wgs_destination[1]),
            ],
            distance_m=self.distance_m,
            duration_minutes=self.duration_minutes,
        )

    async def geocode(self, address, *, city=None):
        self.geocode_calls.append((address, city))
        raise AssertionError("leg-refresh 不得调用 geocode")

    async def search_poi(self, keywords, *, city=None):
        self.poi_calls.append((keywords, city))
        raise AssertionError("leg-refresh 不得调用 POI")


class ZeroDistanceAMap(FakeLegAMap):
    distance_m = 0
    duration_minutes = None


class SlowAMap(FakeLegAMap):
    async def route(self, origin, destination, mode):
        self.route_calls.append((origin, destination, mode))
        await asyncio.Event().wait()


class UnavailableAMap(FakeLegAMap):
    SECRET = "amap-secret-token-unavailable"

    async def route(self, origin, destination, mode):
        self.route_calls.append((origin, destination, mode))
        raise AMapError(
            "invalid key: https://restapi.amap.com/v5/direction/walking?key="
            + self.SECRET,
            code="http_500",
        )


class BadRouteAMap(FakeLegAMap):
    SECRET = "amap-secret-token-bad-route"

    async def route(self, origin, destination, mode):
        self.route_calls.append((origin, destination, mode))
        raise AMapError("bad route: " + self.SECRET, code="implausible_polyline")


class ExplodingInitAMap(FakeLegAMap):
    SECRET = "amap-secret-token-init"

    def __init__(self, api_key, *, timeout=6.0):
        raise RuntimeError("upstream exploded " + self.SECRET)


class ExplodingEnterAMap(FakeLegAMap):
    SECRET = "amap-secret-token-enter"

    async def __aenter__(self):
        raise RuntimeError("upstream exploded " + self.SECRET)


class ExplodingAgent:
    def __init__(self):
        self.calls = []

    async def ainvoke(self, payload, config=None):  # pragma: no cover - 只计数
        self.calls.append((payload, config))
        raise AssertionError("leg-refresh 不得调用大模型")


class MockTransportAMap(AMapClient):
    """真实 AMapClient + MockTransport：走完整 URL/参数/JSON/几何转换链路。"""

    requests = []

    def __init__(self, api_key, *, timeout=6.0):
        def handler(request: httpx.Request) -> httpx.Response:
            MockTransportAMap.requests.append(request)
            params = request.url.params
            origin = params["origin"]
            destination = params["destination"]
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "route": {
                        "paths": [
                            {
                                "distance": "1234",
                                "cost": {"duration": "300"},
                                "steps": [{"polyline": f"{origin};{destination}"}],
                            }
                        ]
                    },
                },
            )

        inner = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        super().__init__(api_key, timeout=timeout, client=inner)
        # 让 __aexit__ 真正关闭本测试注入的 client，验证 owned 生命周期。
        self._owns_client = True


# ==================== fixture ====================


@pytest.fixture
def client(monkeypatch):
    for name in (
        "DASHSCOPE_API_KEY",
        "AMAP_API_KEY",
        "MAP_REFRESH_TIMEOUT",
        "MAP_ENRICH_TIMEOUT",
        "AMAP_TIMEOUT",
        "CORS_ORIGINS",
        "TAVILY_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_timeout", 6.0)
    monkeypatch.setattr(
        api_server.cfg, "map_refresh_timeout", api_server.DEFAULT_MAP_REFRESH_TIMEOUT
    )
    monkeypatch.setattr(
        api_server.cfg, "cors_origins", list(api_server.DEFAULT_CORS_ORIGINS)
    )
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])
    FakeLegAMap.instances = []
    MockTransportAMap.requests = []

    with TestClient(api_server.app) as test_client:
        yield test_client


def post_leg(client, body=None, headers=None):
    return client.post(URL, json=body if body is not None else request_body(), headers=headers)


def enable_fake_amap(monkeypatch, cls=FakeLegAMap, *, key="test-map-key"):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", key)
    monkeypatch.setattr(api_server, "AMapClient", cls)
    FakeLegAMap.instances = []


# ==================== 1. ready / 契约 ====================


def test_ready_echoes_request_exactly_and_closes_owned_client(client, monkeypatch):
    enable_fake_amap(monkeypatch)
    body = request_body()

    response = post_leg(client, body)

    assert response.status_code == 200
    payload = response.json()
    assert set(payload) == EXPECTED_KEYS
    assert payload["parent"] == body["parent"]
    assert payload["day"] == 1
    assert payload["date"] is None
    assert payload["travel_mode"] == "walking"
    assert payload["from_stop"] == body["from_stop"]
    assert payload["to_stop"] == body["to_stop"]
    assert payload["map_status"] == "ready"
    assert payload["reason"] is None
    assert payload["source"] == {
        "provider": "amap",
        "coordinate_system": "WGS84",
        "endpoint": ENDPOINTS["walking"],
    }

    leg = payload["leg"]
    assert leg["route_type"] == "navigation"
    assert leg["from_stop_id"] == "anchor-id"
    assert leg["to_stop_id"] == "tail-first-id"
    assert leg["mode"] == "walking"
    assert leg["distance_m"] == 1234
    assert leg["duration_minutes"] == 5.0
    assert len(leg["geometry"]) >= 2
    assert leg["description"]

    checked_at = datetime.fromisoformat(payload["checked_at"])
    assert checked_at.tzinfo is not None
    assert checked_at.utcoffset() == timezone.utc.utcoffset(None)

    assert len(FakeLegAMap.instances) == 1
    fake = FakeLegAMap.instances[0]
    assert fake.closed is True
    assert len(fake.route_calls) == 1
    assert fake.geocode_calls == []
    assert fake.poi_calls == []

    origin, destination, mode = fake.route_calls[0]
    expected_origin = wgs84_to_gcj02(120.1, 30.2)
    expected_destination = wgs84_to_gcj02(120.2, 30.3)
    assert origin == Coordinate(lng=expected_origin[0], lat=expected_origin[1])
    assert destination == Coordinate(
        lng=expected_destination[0], lat=expected_destination[1]
    )
    assert mode == "walking"


def test_driving_mode_binds_driving_endpoint(client, monkeypatch):
    enable_fake_amap(monkeypatch)

    response = post_leg(client, request_body(travel_mode="driving"))

    assert response.status_code == 200
    payload = response.json()
    assert payload["travel_mode"] == "driving"
    assert payload["source"]["endpoint"] == ENDPOINTS["driving"]
    assert payload["leg"]["mode"] == "driving"
    assert FakeLegAMap.instances[0].route_calls[0][2] == "driving"


def test_zero_distance_and_null_duration_are_kept(client, monkeypatch):
    enable_fake_amap(monkeypatch, ZeroDistanceAMap)

    response = post_leg(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["map_status"] == "ready"
    assert payload["leg"]["distance_m"] == 0
    assert payload["leg"]["duration_minutes"] is None


def test_zero_and_negative_coordinates_are_not_treated_as_missing(client, monkeypatch):
    enable_fake_amap(monkeypatch)
    body = request_body()
    body["from_stop"] = {"id": "zero", "location": {"lng": 0, "lat": 0}}
    body["to_stop"] = {
        "id": "west",
        "location": {"lng": -0.1278, "lat": 51.5074},
    }

    response = post_leg(client, body)

    assert response.status_code == 200
    payload = response.json()
    assert payload["map_status"] == "ready"
    assert payload["from_stop"] == {
        "id": "zero",
        "location": {"lng": 0.0, "lat": 0.0},
    }
    assert payload["to_stop"] == body["to_stop"]
    assert payload["to_stop"]["location"]["lng"] < 0


def test_each_request_gets_its_own_client_and_closes_it(client, monkeypatch):
    enable_fake_amap(monkeypatch)

    first = post_leg(client)
    second = post_leg(client)

    assert first.status_code == 200 and second.status_code == 200
    assert len(FakeLegAMap.instances) == 2
    assert [fake.closed for fake in FakeLegAMap.instances] == [True, True]
    assert [len(fake.route_calls) for fake in FakeLegAMap.instances] == [1, 1]


# ==================== 2. no_key / 失败 / 生命周期 ====================


def test_no_key_returns_no_key_with_zero_client_creation(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "AMapClient", FakeLegAMap)
    FakeLegAMap.instances = []

    response = post_leg(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["map_status"] == "no_key"
    assert payload["leg"] is None
    assert payload["reason"] == REASONS["no_key"]
    assert payload["source"]["endpoint"] == ENDPOINTS["walking"]
    assert FakeLegAMap.instances == [], "无 Key 时不应创建高德客户端"


def test_timeout_returns_typed_timeout_and_closes_client(client, monkeypatch):
    enable_fake_amap(monkeypatch, SlowAMap)
    monkeypatch.setattr(api_server.cfg, "map_refresh_timeout", 0.05)

    started = time.monotonic()
    response = post_leg(client)
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed < 2.0, f"超时后仍等待了 {elapsed:.2f}s"
    payload = response.json()
    assert payload["map_status"] == "timeout"
    assert payload["leg"] is None
    assert payload["reason"] == REASONS["timeout"]
    assert FakeLegAMap.instances and FakeLegAMap.instances[0].closed is True


def test_upstream_unavailable_is_safe_and_does_not_leak(client, monkeypatch):
    enable_fake_amap(monkeypatch, UnavailableAMap)

    response = post_leg(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["map_status"] == "unavailable"
    assert payload["leg"] is None
    assert payload["reason"] == REASONS["unavailable"]
    assert UnavailableAMap.SECRET not in response.text
    assert "restapi.amap.com" not in response.text
    assert "invalid key" not in response.text


def test_bad_route_data_maps_to_failed_without_leak(client, monkeypatch):
    enable_fake_amap(monkeypatch, BadRouteAMap)

    response = post_leg(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["map_status"] == "failed"
    assert payload["leg"] is None
    assert payload["reason"] == REASONS["failed"]
    assert BadRouteAMap.SECRET not in response.text


@pytest.mark.parametrize("cls", [ExplodingInitAMap, ExplodingEnterAMap])
def test_client_construction_failure_returns_safe_failed(client, monkeypatch, cls):
    enable_fake_amap(monkeypatch, cls)

    response = post_leg(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["map_status"] == "failed"
    assert payload["leg"] is None
    assert payload["reason"] == REASONS["failed"]
    assert cls.SECRET not in response.text
    assert "upstream exploded" not in response.text


def test_outer_cancellation_propagates_and_closes_client(monkeypatch):
    async def scenario():
        monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
        monkeypatch.setattr(api_server.cfg, "map_refresh_timeout", 30.0)
        monkeypatch.setattr(api_server, "AMapClient", SlowAMap)
        FakeLegAMap.instances = []

        request = LegRefreshRequest.model_validate(request_body())
        task = asyncio.create_task(api_server.run_leg_refresh(request))
        await asyncio.sleep(0.02)
        assert not task.done()

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert FakeLegAMap.instances, "应已创建本次请求的客户端"
        assert FakeLegAMap.instances[0].closed is True

    asyncio.run(scenario())


# ==================== 3. CORS / 来源守卫 ====================


def test_trusted_origin_is_allowed_and_routes_once(client, monkeypatch):
    enable_fake_amap(monkeypatch)

    response = post_leg(
        client, headers={"Origin": "http://127.0.0.1:5173"}
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
    assert response.headers["access-control-allow-origin"] != "*"
    assert len(FakeLegAMap.instances) == 1
    assert len(FakeLegAMap.instances[0].route_calls) == 1


def test_malicious_origin_is_rejected_before_route_or_validation(client, monkeypatch):
    enable_fake_amap(monkeypatch)
    body = request_body()
    body["extra"] = SENTINEL

    response = post_leg(client, body, headers={"Origin": "https://evil.example"})

    assert response.status_code == 403
    assert "evil.example" not in response.text
    assert SENTINEL not in response.text
    assert FakeLegAMap.instances == []


def test_cli_request_without_origin_keeps_working(client, monkeypatch):
    enable_fake_amap(monkeypatch)

    response = client.post(URL, json=request_body())

    assert response.status_code == 200
    assert response.json()["map_status"] == "ready"


# ==================== 4. 422 固定安全形状 ====================


@pytest.mark.parametrize("body", invalid_bodies())
def test_invalid_body_is_safe_422_without_input_echo(client, monkeypatch, body):
    enable_fake_amap(monkeypatch)

    response = post_leg(client, body)

    assert response.status_code == 422
    payload = response.json()
    assert set(payload) == {"detail"}
    assert isinstance(payload["detail"], str) and payload["detail"]
    assert "input" not in response.text
    assert SENTINEL not in response.text
    assert FakeLegAMap.instances == []


@pytest.mark.parametrize(
    "raw_body",
    [
        b'{"day":',
        b'{"extra": "\\ud800"}',
        b'{"from_stop": {"id": "\\ud800"}}',
        b'{"day": "\xff"}',
    ],
)
def test_malformed_or_non_utf8_body_is_safe_422(client, monkeypatch, raw_body):
    enable_fake_amap(monkeypatch)

    response = client.post(
        URL, content=raw_body, headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 422
    assert set(response.json()) == {"detail"}
    assert "input" not in response.text
    assert "ud800" not in response.text.lower()
    assert FakeLegAMap.instances == []


# ==================== 5. 不碰模型 / geocode / POI ====================


def test_route_never_calls_model_geocode_or_poi(client, monkeypatch):
    enable_fake_amap(monkeypatch)
    agent = ExplodingAgent()
    monkeypatch.setattr(api_server, "agent", agent)
    monkeypatch.setattr(api_server, "planner_agent", agent)

    response = post_leg(client)

    assert response.status_code == 200
    assert response.json()["map_status"] == "ready"
    assert agent.calls == []
    fake = FakeLegAMap.instances[0]
    assert fake.geocode_calls == []
    assert fake.poi_calls == []


# ==================== 6. 真实客户端 + MockTransport ====================


def test_real_amap_client_with_mock_transport_hits_fixed_v5_endpoint(
    client, monkeypatch
):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", FAKE_KEY)
    monkeypatch.setattr(api_server, "AMapClient", MockTransportAMap)
    MockTransportAMap.requests = []

    response = post_leg(client)

    assert response.status_code == 200
    payload = response.json()
    assert payload["map_status"] == "ready"
    assert payload["leg"]["route_type"] == "navigation"
    assert payload["leg"]["distance_m"] == 1234
    assert payload["leg"]["duration_minutes"] == 5.0
    assert len(payload["leg"]["geometry"]) == 2

    assert len(MockTransportAMap.requests) == 1
    request = MockTransportAMap.requests[0]
    assert request.url.path == ENDPOINTS["walking"]
    params = request.url.params
    assert params["key"] == FAKE_KEY
    expected_origin = wgs84_to_gcj02(120.1, 30.2)
    expected_destination = wgs84_to_gcj02(120.2, 30.3)
    assert params["origin"] == f"{expected_origin[0]:.6f},{expected_origin[1]:.6f}"
    assert (
        params["destination"]
        == f"{expected_destination[0]:.6f},{expected_destination[1]:.6f}"
    )

    # 响应 geometry 是 WGS84，但回显端点仍是请求原值，不被吸附点改写。
    assert payload["from_stop"]["location"] == {"lng": 120.1, "lat": 30.2}
    assert payload["to_stop"]["location"] == {"lng": 120.2, "lat": 30.3}
    first = payload["leg"]["geometry"][0]
    assert abs(first["lng"] - 120.1) < 0.01
    assert abs(first["lat"] - 30.2) < 0.01

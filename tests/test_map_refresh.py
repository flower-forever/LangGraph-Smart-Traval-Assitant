# -*- coding: utf-8 -*-
"""单日地图刷新接口（POST /api/trips/days/map-refresh）离线回归。

全部使用假高德客户端或挂起的 fake，不读取 .env、不访问真实高德 / DashScope，
也不创建任何模型调用。覆盖：

- 响应契约：只回地图补丁，不含 Trip / source，parent 原值回显；
- ready / partial / unavailable / no_key / timeout / failed 六态与内容自洽；
- 超过 8 站 422 不截断、重复 id、坐标/instruction 注入一律拒绝；
- 无地图 Key 零客户端创建、无模型 Key 仍可刷新、模型 ainvoke 为零；
- 总预算超时与取消传播、错误与密钥/URL 不回显；
- 0 与负 WGS 坐标不被当成“缺失”。
"""

import asyncio
import math
import time

import pytest
from fastapi.testclient import TestClient

import api_server
from travel_itinerary import AMapError, Coordinate, GeoResult, RouteResult


# ==================== 公共数据 ====================


def stop(stop_id: str, name: str, address: str = "") -> dict:
    return {"id": stop_id, "name": name, "address": address}


def request_body(**overrides) -> dict:
    data = {
        "destination": "杭州",
        "day": 2,
        "date": "2026-11-02",
        "travel_mode": "walking",
        "parent": {"trip_id": "trip-local-α/01 ", "revision": 12},
        "stops": [
            stop("s1", "断桥残雪", "杭州市西湖区"),
            stop("s2", "平湖秋月", "杭州市西湖区"),
        ],
    }
    data.update(overrides)
    return data


def poi(name: str, lng: float, lat: float, *, formatted: str | None = None) -> GeoResult:
    return GeoResult(
        location=Coordinate(lng=lng, lat=lat),
        formatted_address=(
            f"杭州市西湖区{name}" if formatted is None else formatted
        ),
        name=name,
    )


class FakeAgent:
    def __init__(self) -> None:
        self.calls = []

    async def ainvoke(self, payload, config=None):  # pragma: no cover - 只用来计数
        self.calls.append((payload, config))
        raise AssertionError("地图刷新不允许调用大模型")


# ==================== 假高德客户端 ====================


class ReadyAMap:
    """所有 POI / 地理编码 / 路线都成功。"""

    configured = True
    instances: list["ReadyAMap"] = []

    def __init__(self, api_key, *, timeout=6.0):
        self.api_key = api_key
        self.timeout = timeout
        self.closed = False
        self.calls = []
        ReadyAMap.instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.closed = True

    async def search_poi(self, keywords, *, city=None):
        self.calls.append(("poi", keywords))
        index = 1 if "平湖" in keywords else 0
        return poi(keywords, 120.15 + index * 0.001, 30.25 + index * 0.001)

    async def geocode(self, address, *, city=None):
        self.calls.append(("geocode", address))
        return poi(address, 120.15, 30.25, formatted=f"杭州市西湖区{address}")

    async def route(self, origin, destination, mode):
        self.calls.append(("route", mode))
        return RouteResult(
            geometry=[
                Coordinate(lng=120.1501, lat=30.2501),
                Coordinate(lng=120.1502, lat=30.2502),
            ],
            distance_m=800,
            duration_minutes=10.0,
        )


class OneUnresolvedAMap(ReadyAMap):
    """第二个站点 POI 与地理编码都失败。"""

    async def search_poi(self, keywords, *, city=None):
        if "博物馆" in keywords:
            raise AMapError("没有搜到匹配地点", code="poi_not_found")
        return await super().search_poi(keywords, city=city)

    async def geocode(self, address, *, city=None):
        if "博物馆" in address or "孤山路" in address:
            raise AMapError("未找到地址", code="geocode_not_found")
        return await super().geocode(address, city=city)


class RouteFailAMap(ReadyAMap):
    """坐标都能拿到，但路线接口失败。"""

    async def route(self, origin, destination, mode):
        self.calls.append(("route", mode))
        raise AMapError("路线规划失败", code="route_failed")


class AuthFailAMap(ReadyAMap):
    """鉴权失败：错误文本里带密钥和 URL，响应不能回显。"""

    SECRET = "amap-secret-token-should-never-appear"

    async def search_poi(self, keywords, *, city=None):
        raise AMapError(
            "invalid key: https://restapi.amap.com/v3/place/text?key=" + self.SECRET,
            code="10001",
        )

    async def geocode(self, address, *, city=None):
        raise AMapError(
            "invalid key: https://restapi.amap.com/v3/geocode/geo?key=" + self.SECRET,
            code="10001",
        )

    async def route(self, origin, destination, mode):  # pragma: no cover
        raise AssertionError("鉴权失败后不应继续请求路线")


class ExplodingAMap(ReadyAMap):
    async def __aenter__(self):
        raise RuntimeError("upstream exploded amap-secret-token-should-never-appear")


class SlowAMap(ReadyAMap):
    async def search_poi(self, keywords, *, city=None):
        await asyncio.Event().wait()


class ZeroAndNegativeAMap(ReadyAMap):
    async def search_poi(self, keywords, *, city=None):
        if "零点" in keywords:
            return poi(keywords, 0.0, 0.0)
        return poi(keywords, -0.1278, 51.5074, formatted="")


class EmptyFormattedAddressAMap(ReadyAMap):
    async def search_poi(self, keywords, *, city=None):
        return poi(keywords, 120.15, 30.25, formatted="")


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
    ):
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_timeout", 6.0)
    monkeypatch.setattr(
        api_server.cfg, "map_refresh_timeout", api_server.DEFAULT_MAP_REFRESH_TIMEOUT
    )
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])
    ReadyAMap.instances = []

    with TestClient(api_server.app) as test_client:
        yield test_client


def post_refresh(client, body=None):
    return client.post("/api/trips/days/map-refresh", json=body or request_body())


# ==================== 1. ready / 契约 ====================


def test_all_resolved_returns_ready_patch_echoing_parent(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", ReadyAMap)

    response = post_refresh(client)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "day",
        "date",
        "parent",
        "map_status",
        "stops",
        "unresolved",
        "legs",
        "warnings",
    }
    assert "source" not in body and "trip" not in body
    assert body["day"] == 2
    assert body["date"] == "2026-11-02"
    assert body["parent"] == {"trip_id": "trip-local-α/01 ", "revision": 12}
    assert body["map_status"] == "ready"
    assert [item["id"] for item in body["stops"]] == ["s1", "s2"]
    assert all(item["location"] is not None for item in body["stops"])
    assert body["stops"][0]["resolved_address"] == "杭州市西湖区断桥残雪"
    assert body["unresolved"] == []
    assert len(body["legs"]) == 1
    assert body["legs"][0]["route_type"] == "navigation"
    assert body["legs"][0]["from_stop_id"] == "s1"
    assert body["legs"][0]["to_stop_id"] == "s2"
    assert len(body["legs"][0]["geometry"]) >= 2
    assert 0 < len(body["warnings"]) <= 40
    assert ReadyAMap.instances and ReadyAMap.instances[0].closed


def test_single_stop_without_legs_is_ready(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", ReadyAMap)

    response = post_refresh(
        client, request_body(stops=[stop("only", "断桥残雪", "杭州市西湖区")])
    )

    assert response.status_code == 200
    body = response.json()
    assert body["map_status"] == "ready"
    assert len(body["stops"]) == 1
    assert body["legs"] == []


def test_eight_stops_are_accepted(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", ReadyAMap)
    stops = [stop(f"s{i}", f"景点{i}") for i in range(1, 9)]

    response = post_refresh(client, request_body(stops=stops))

    assert response.status_code == 200
    body = response.json()
    assert body["map_status"] == "ready"
    assert len(body["stops"]) == 8
    assert len(body["legs"]) == 7
    assert body["unresolved"] == []


def test_zero_and_negative_wgs84_coordinates_are_not_treated_as_missing(
    client, monkeypatch
):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", ZeroAndNegativeAMap)

    response = post_refresh(
        client,
        request_body(stops=[stop("zero", "零点"), stop("west", "格林尼治")]),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["map_status"] == "ready"
    locations = {item["id"]: item["location"] for item in body["stops"]}
    assert set(locations) == {"zero", "west"}
    assert locations["zero"] == {"lng": 0.0, "lat": 0.0}
    assert locations["west"]["lng"] is not None
    assert locations["west"]["lng"] < 0
    assert all(
        math.isfinite(value)
        for location in locations.values()
        for value in location.values()
    )


def test_resolved_address_is_null_when_provider_returns_none_and_never_echoes_user_text(
    client, monkeypatch
):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", EmptyFormattedAddressAMap)

    response = post_refresh(
        client,
        request_body(stops=[stop("s1", "断桥残雪", "用户自己写的地址")]),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["map_status"] == "ready"
    assert body["stops"][0]["location"] is not None
    assert body["stops"][0]["resolved_address"] is None
    assert "用户自己写的地址" not in response.text


# ==================== 2. partial ====================


def test_unresolved_stop_returns_partial_and_keeps_union_of_ids(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", OneUnresolvedAMap)

    response = post_refresh(
        client,
        request_body(
            stops=[
                stop("s1", "断桥残雪", "杭州市西湖区"),
                stop("s2", "浙江省博物馆", "杭州市西湖区孤山路"),
            ]
        ),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["map_status"] == "partial"
    assert [item["id"] for item in body["stops"]] == ["s1"]
    assert all(item["location"] is not None for item in body["stops"])
    assert [item["id"] for item in body["unresolved"]] == ["s2"]
    unresolved = body["unresolved"][0]
    assert unresolved["reason_code"]
    assert unresolved["reason"]
    assert {item["id"] for item in body["stops"]} | {
        item["id"] for item in body["unresolved"]
    } == {"s1", "s2"}
    assert len(body["legs"]) == 1
    assert body["legs"][0]["route_type"] == "unavailable"
    assert body["legs"][0]["geometry"] == []
    assert all(item["location"] is not None for item in body["stops"])


def test_route_failure_returns_straight_line_partial_instead_of_dropping_points(
    client, monkeypatch
):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", RouteFailAMap)

    response = post_refresh(client)

    assert response.status_code == 200
    body = response.json()
    assert body["map_status"] == "partial"
    assert len(body["stops"]) == 2
    assert len(body["legs"]) == 1
    leg = body["legs"][0]
    assert leg["route_type"] == "straight_line"
    assert leg["distance_m"] is None
    assert leg["duration_minutes"] is None
    assert len(leg["geometry"]) == 2
    assert any("路线降级" in warning for warning in body["warnings"])


# ==================== 3. no_key / failed / timeout ====================


def test_no_key_returns_no_key_and_creates_zero_clients(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "AMapClient", ReadyAMap)
    ReadyAMap.instances.clear()

    response = post_refresh(client)

    assert response.status_code == 200
    body = response.json()
    assert body["map_status"] == "no_key"
    assert body["stops"] == [] and body["legs"] == []
    assert [item["id"] for item in body["unresolved"]] == ["s1", "s2"]
    assert all(item["reason_code"] == "no_key" for item in body["unresolved"])
    assert ReadyAMap.instances == [], "无地图 Key 时不应创建高德客户端"


def test_auth_failure_returns_failed_empty_patch_without_leaking_secret(
    client, monkeypatch
):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", AuthFailAMap.SECRET)
    monkeypatch.setattr(api_server, "AMapClient", AuthFailAMap)

    response = post_refresh(client)

    assert response.status_code == 200
    body = response.json()
    assert body["map_status"] == "failed"
    assert body["stops"] == [] and body["legs"] == []
    assert [item["id"] for item in body["unresolved"]] == ["s1", "s2"]
    assert any("10001" in warning for warning in body["warnings"])
    assert AuthFailAMap.SECRET not in response.text
    assert "restapi.amap.com" not in response.text
    assert "invalid key" not in response.text


def test_client_construction_failure_returns_failed_without_leaking_secret(
    client, monkeypatch
):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "amap-secret-token-should-never-appear")
    monkeypatch.setattr(api_server, "AMapClient", ExplodingAMap)

    response = post_refresh(client)

    assert response.status_code == 200
    body = response.json()
    assert body["map_status"] == "failed"
    assert body["stops"] == [] and body["legs"] == []
    assert "amap-secret-token-should-never-appear" not in response.text
    assert "upstream exploded" not in response.text


def test_total_budget_timeout_returns_timeout_empty_patch(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server.cfg, "map_refresh_timeout", 0.05)
    monkeypatch.setattr(api_server, "AMapClient", SlowAMap)

    started = time.monotonic()
    response = post_refresh(client)
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed < 2.0, f"超时后仍等待了 {elapsed:.2f}s"
    body = response.json()
    assert body["map_status"] == "timeout"
    assert body["stops"] == [] and body["legs"] == []
    assert all(item["reason_code"] == "timeout" for item in body["unresolved"])
    assert any("超时" in warning for warning in body["warnings"])
    assert SlowAMap.instances and SlowAMap.instances[0].closed


def test_outer_cancellation_propagates_and_closes_client(monkeypatch):
    async def scenario():
        monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
        monkeypatch.setattr(api_server.cfg, "map_refresh_timeout", 30.0)
        monkeypatch.setattr(api_server, "AMapClient", SlowAMap)
        SlowAMap.instances.clear()

        from travel_itinerary import MapRefreshRequest

        task = asyncio.create_task(
            api_server.run_map_refresh(MapRefreshRequest(**request_body()))
        )
        await asyncio.sleep(0.02)
        assert not task.done()

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert SlowAMap.instances and SlowAMap.instances[0].closed

    asyncio.run(scenario())


# ==================== 4. 不依赖模型 ====================


def test_no_model_key_still_refreshes_and_never_calls_model(client, monkeypatch):
    fake_agent = FakeAgent()
    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "planner_agent", fake_agent)
    monkeypatch.setattr(api_server, "agent", fake_agent)
    monkeypatch.setattr(api_server, "AMapClient", ReadyAMap)

    response = post_refresh(client)

    assert response.status_code == 200
    assert response.json()["map_status"] == "ready"
    assert fake_agent.calls == []


# ==================== 5. 请求校验 ====================


def test_nine_stops_are_rejected_without_truncation(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", ReadyAMap)
    stops = [stop(f"s{i}", f"景点{i}") for i in range(1, 10)]

    response = post_refresh(client, request_body(stops=stops))

    assert response.status_code == 422
    assert "too_many_stops" in response.text
    assert "stops" not in response.json()
    assert ReadyAMap.instances == []


@pytest.mark.parametrize(
    "mutate",
    [
        lambda body: body["stops"][0].update({"location": {"lng": 120.15, "lat": 30.25}}),
        lambda body: body["stops"][0].update({"geometry": [{"lng": 120.15, "lat": 30.25}]}),
        lambda body: body["stops"][0].update({"lng": 120.15, "lat": 30.25}),
        lambda body: body.update({"instruction": "把第二天改成室内"}),
        lambda body: body["parent"].update({"location": {"lng": 120.15, "lat": 30.25}}),
    ],
)
def test_coordinate_or_instruction_injection_is_rejected(client, mutate, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", ReadyAMap)
    body = request_body()
    mutate(body)

    response = post_refresh(client, body)

    assert response.status_code == 422
    assert ReadyAMap.instances == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"stops": []},
        {"stops": [stop("dup", "断桥残雪"), stop("dup", "平湖秋月")]},
        {"day": 0},
        {"day": 8},
        {"day": True},
        {"destination": ""},
        {"destination": "杭" * 81},
        {"travel_mode": "transit"},
        {"parent": {"trip_id": "", "revision": 1}},
        {"parent": {"trip_id": "x" * 101, "revision": 1}},
        {"parent": {"trip_id": "a", "revision": -1}},
        {"parent": {"trip_id": "a", "revision": True}},
        {"date": "2026-11-02T00:00:00"},
        {"date": "20261102"},
        {"date": "2026-W45-3"},
        {"date": ""},
        {"date": "2026-02-30"},
    ],
)
def test_invalid_requests_are_rejected(client, overrides, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", ReadyAMap)

    response = post_refresh(client, request_body(**overrides))

    assert response.status_code == 422
    assert ReadyAMap.instances == []


def test_null_date_and_optional_address_are_accepted(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server, "AMapClient", ReadyAMap)

    response = post_refresh(
        client,
        request_body(date=None, stops=[stop("s1", "断桥残雪")]),
    )

    assert response.status_code == 200
    assert response.json()["date"] is None
    assert response.json()["map_status"] == "ready"


# ==================== 6. 配置 ====================


@pytest.mark.parametrize(
    "raw",
    [None, "", "   ", "abc", "0", "-3", "-0.1", "nan", "NaN", "inf", "-inf", "1e309"],
)
def test_map_refresh_timeout_falls_back_to_default(monkeypatch, raw):
    if raw is None:
        monkeypatch.delenv("MAP_REFRESH_TIMEOUT", raising=False)
    else:
        monkeypatch.setenv("MAP_REFRESH_TIMEOUT", raw)

    value = api_server.Configuration().map_refresh_timeout

    assert value == api_server.DEFAULT_MAP_REFRESH_TIMEOUT
    assert math.isfinite(value)
    assert value > 0


def test_map_refresh_timeout_default_is_twenty_seconds():
    assert api_server.DEFAULT_MAP_REFRESH_TIMEOUT == 20.0


def test_map_refresh_timeout_honors_valid_override(monkeypatch):
    monkeypatch.setenv("MAP_REFRESH_TIMEOUT", " 12.5 ")

    assert api_server.Configuration().map_refresh_timeout == 12.5

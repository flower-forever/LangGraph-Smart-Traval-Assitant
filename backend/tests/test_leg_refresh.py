# -*- coding: utf-8 -*-
"""固定 WGS84 端点衔接路线（第一批后端）离线契约 / service 测试。

只测仓库根 ``leg_refresh.py`` 与 ``tests/test_amap_client.py`` 的邻接。
禁止真实 HTTP transport（只准 httpx.MockTransport）、不读 .env / dotenv、
不接触真实模型或高德服务、不 import api_server、不注册 HTTP 路由。
"""

import asyncio
import inspect
import json
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError

import leg_refresh
from leg_refresh import (
    LegRefreshCoordinate,
    LegRefreshRequest,
    LegRefreshResponse,
    LegRefreshSource,
    LegRefreshStop,
    refresh_leg_route,
)
from travel_itinerary import (
    AMapClient,
    AMapError,
    Coordinate,
    Leg,
    MapRefreshParent,
    RouteResult,
    gcj02_to_wgs84,
    wgs84_to_gcj02,
)

os.environ.setdefault("PYTHON_DOTENV_DISABLED", "1")

FAKE_KEY = "FAKE-LEG-REFRESH-KEY-0001"
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


# ==================== autouse：真实 HTTP transport 守卫 ====================


@pytest.fixture(autouse=True)
def forbid_real_http(monkeypatch):
    """任何未显式注入 MockTransport 的 httpx.AsyncClient 立即失败。

    假 service 直接返回结果不能绕过此守卫：只要有人构造真实 transport，
    测试就红，且不会发出任何外部请求。
    """

    original_init = httpx.AsyncClient.__init__

    def guarded_init(self, *args, **kwargs):
        transport = kwargs.get("transport")
        if not isinstance(transport, httpx.MockTransport):
            raise AssertionError("测试禁止真实 HTTP transport；必须显式注入 MockTransport")
        return original_init(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", guarded_init)


# ==================== 构造工具 ====================


def raw_request():
    return {
        "parent": {"trip_id": "opaque-current-id", "revision": 1},
        "day": 1,
        "date": None,
        "travel_mode": "walking",
        "from_stop": {"id": "anchor-id", "location": {"lng": 120.1, "lat": 30.2}},
        "to_stop": {"id": "tail-first-id", "location": {"lng": 120.2, "lat": 30.3}},
    }


def make_request(mutator=None):
    payload = raw_request()
    if mutator is not None:
        mutator(payload)
    return LegRefreshRequest.model_validate(payload)


def run(coro):
    return asyncio.run(coro)


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat()


def sample_geometry(n=2, *, start=(120.1, 30.2), end=(120.2, 30.3)):
    if n < 2:
        return [Coordinate(lng=start[0], lat=start[1])]
    return [
        Coordinate(
            lng=round(start[0] + (end[0] - start[0]) * i / (n - 1), 6),
            lat=round(start[1] + (end[1] - start[1]) * i / (n - 1), 6),
        )
        for i in range(n)
    ]


def sample_leg(request, **overrides):
    data = {
        "from_stop_id": request.from_stop.id,
        "to_stop_id": request.to_stop.id,
        "mode": request.travel_mode,
        "route_type": "navigation",
        "distance_m": 1234,
        "duration_minutes": 5.0,
        "geometry": sample_geometry(),
        "description": "按两端记录坐标取得的衔接路段。",
    }
    data.update(overrides)
    return Leg(**data)


def bad_leg(**overrides):
    """绕过 Leg 字段校验，专门检验 response 模型自身的互斥 / 内容校验。"""

    data = {
        "from_stop_id": "anchor-id",
        "to_stop_id": "tail-first-id",
        "mode": "walking",
        "route_type": "navigation",
        "distance_m": 1234,
        "duration_minutes": 5.0,
        "geometry": sample_geometry(),
        "description": "x",
    }
    data.update(overrides)
    return Leg.model_construct(**data)


def make_response(request, **overrides):
    data = {
        "parent": request.parent,
        "day": request.day,
        "date": request.date,
        "travel_mode": request.travel_mode,
        "from_stop": request.from_stop,
        "to_stop": request.to_stop,
        "map_status": "ready",
        "leg": sample_leg(request),
        "reason": None,
        "source": LegRefreshSource(endpoint=ENDPOINTS[request.travel_mode]),
        "checked_at": utc_now_iso(),
    }
    data.update(overrides)
    return LegRefreshResponse.model_validate(data)


def sample_route_result(**overrides):
    data = {
        "geometry": sample_geometry(),
        "distance_m": 1234,
        "duration_minutes": 5.0,
    }
    data.update(overrides)
    return RouteResult(**data)


_NOT_GIVEN = object()


class FakeAMap:
    """注入用假客户端：计数单次 route，可挂起 / 抛错 / 返回任意结果。"""

    def __init__(self, *, result=_NOT_GIVEN, configured=True, error=None, hang=False):
        self.result = sample_route_result() if result is _NOT_GIVEN else result
        self.configured = configured
        self.error = error
        self.hang = hang
        self.calls = 0
        self.args = []
        self.started = asyncio.Event()

    async def route(self, origin, destination, mode):
        self.calls += 1
        self.args.append((origin, destination, mode))
        self.started.set()
        if self.hang:
            await asyncio.Event().wait()
        if self.error is not None:
            raise self.error
        return self.result


def gcj_points(request):
    origin = wgs84_to_gcj02(
        request.from_stop.location.lng, request.from_stop.location.lat
    )
    destination = wgs84_to_gcj02(
        request.to_stop.location.lng, request.to_stop.location.lat
    )
    return origin, destination


def route_json(origin, destination, *, distance="1234", duration="300", polyline=None, omit_polyline=False):
    first = f"{origin[0]:.6f},{origin[1]:.6f}"
    last = f"{destination[0]:.6f},{destination[1]:.6f}"
    line = polyline if polyline is not None else f"{first};{last}"
    path = {"distance": distance}
    if duration is not None:
        path["cost"] = {"duration": duration}
    if not omit_polyline:
        path["steps"] = [{"polyline": line}]
    return {"status": "1", "info": "OK", "route": {"paths": [path]}}


async def call_real_client(request, handler, *, timeout_seconds=20.0):
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        amap = AMapClient(FAKE_KEY, client=http_client)
        return await refresh_leg_route(request, amap, timeout_seconds=timeout_seconds)


def assert_failure_shape(response, request, status):
    assert response.map_status == status
    assert response.leg is None, "失败必须 leg=null，不能夹带部分成功"
    assert response.reason == REASONS[status]
    assert response.source.provider == "amap"
    assert response.source.coordinate_system == "WGS84"
    assert response.source.endpoint == ENDPOINTS[request.travel_mode]
    assert response.parent == request.parent
    assert response.day == request.day
    assert response.date == request.date
    assert response.travel_mode == request.travel_mode
    assert response.from_stop == request.from_stop
    assert response.to_stop == request.to_stop
    parsed = datetime.fromisoformat(response.checked_at)
    assert parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0)


# ==================== 1. request 严格契约 ====================


def test_request_legal_shape_and_opaque_echo():
    payload = raw_request()
    payload["parent"]["trip_id"] = "  Trïp/東京 🗺  "
    payload["from_stop"]["id"] = "  anchor  "
    payload["to_stop"]["id"] = "tail-Δ"
    payload["date"] = "2026-11-04"
    payload["day"] = 7
    payload["parent"]["revision"] = 0
    request = LegRefreshRequest.model_validate(payload)

    assert request.parent.trip_id == "  Trïp/東京 🗺  "
    assert request.parent.revision == 0
    assert request.from_stop.id == "  anchor  "
    assert request.to_stop.id == "tail-Δ"
    assert request.day == 7
    assert request.date == "2026-11-04"
    assert request.travel_mode == "walking"
    assert isinstance(request.from_stop, LegRefreshStop)
    assert isinstance(request.from_stop.location, LegRefreshCoordinate)
    assert request.from_stop.location.lng == 120.1
    assert request.to_stop.location.lat == 30.3
    assert "dotenv" not in sys.modules or os.environ.get("PYTHON_DOTENV_DISABLED") == "1"


@pytest.mark.parametrize(
    "path",
    [
        ("extra",),
        ("parent", "extra"),
        ("from_stop", "extra"),
        ("to_stop", "extra"),
        ("from_stop", "location", "extra"),
        ("to_stop", "location", "extra"),
    ],
)
def test_request_nested_extra_forbid(path):
    def mutator(payload):
        node = payload
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = "injected"

    with pytest.raises(ValidationError):
        make_request(mutator)


@pytest.mark.parametrize(
    "field,value",
    [
        ("lng", True),
        ("lng", False),
        ("lng", "120.1"),
        ("lng", None),
        ("lng", float("nan")),
        ("lng", float("inf")),
        ("lng", -float("inf")),
        ("lng", 181.0),
        ("lng", -181.0),
        ("lng", 1e300),
        ("lat", True),
        ("lat", "30.2"),
        ("lat", None),
        ("lat", float("nan")),
        ("lat", float("inf")),
        ("lat", 91.0),
        ("lat", -91.0),
    ],
)
def test_request_rejects_bad_coordinate_numbers(field, value):
    def mutator(payload):
        payload["from_stop"]["location"][field] = value

    with pytest.raises(ValidationError):
        make_request(mutator)


def test_request_accepts_zero_and_negative_coordinates():
    def mutator(payload):
        payload["from_stop"]["location"] = {"lng": 0, "lat": 0}
        payload["to_stop"]["location"] = {"lng": -120.5, "lat": -30.5}

    request = make_request(mutator)
    assert request.from_stop.location.lng == 0.0
    assert request.from_stop.location.lat == 0.0
    assert request.to_stop.location.lng == -120.5
    assert request.to_stop.location.lat == -30.5


def test_request_null_is_not_zero():
    def mutator(payload):
        payload["from_stop"]["location"] = {"lng": None, "lat": 0}

    with pytest.raises(ValidationError):
        make_request(mutator)


def test_request_echo_int_coordinate_keeps_numeric_semantics():
    def mutator(payload):
        payload["from_stop"]["location"] = {"lng": 120, "lat": 30}

    request = make_request(mutator)
    assert request.from_stop.location.lng == 120
    assert request.from_stop.location.lat == 30
    assert isinstance(request.from_stop.location.lng, float)


@pytest.mark.parametrize("bad", [0, 8, True, False, "1", 1.0, 1.5, None, 2**60])
def test_request_rejects_bad_day(bad):
    with pytest.raises(ValidationError):
        make_request(lambda p: p.__setitem__("day", bad))


@pytest.mark.parametrize("bad", [-1, True, False, "1", 1.0, 1.5, None, 2**53])
def test_request_rejects_bad_revision(bad):
    with pytest.raises(ValidationError):
        make_request(lambda p: p["parent"].__setitem__("revision", bad))


def test_request_accepts_max_safe_revision():
    request = make_request(lambda p: p["parent"].__setitem__("revision", 2**53 - 1))
    assert request.parent.revision == 2**53 - 1


@pytest.mark.parametrize("bad", ["cycling", "bus", "WALKING", "", True, 1, None])
def test_request_rejects_bad_travel_mode(bad):
    with pytest.raises(ValidationError):
        make_request(lambda p: p.__setitem__("travel_mode", bad))


def test_request_requires_travel_mode():
    payload = raw_request()
    del payload["travel_mode"]
    with pytest.raises(ValidationError):
        LegRefreshRequest.model_validate(payload)


@pytest.mark.parametrize(
    "bad",
    [
        "2026-02-30",
        "2026-1-1",
        "20261104",
        "",
        " 2026-11-04",
        "2026-11-04 ",
        "2026-11-04T00:00:00",
        "2026-13-01",
        "2025-02-29",
        20261104,
        True,
        "not-a-date",
    ],
)
def test_request_rejects_bad_date(bad):
    with pytest.raises(ValidationError):
        make_request(lambda p: p.__setitem__("date", bad))


@pytest.mark.parametrize("good", ["2026-11-04", "2024-02-29", None])
def test_request_accepts_real_calendar_date(good):
    request = make_request(lambda p: p.__setitem__("date", good))
    assert request.date == good


def test_request_rejects_same_stop_ids():
    def mutator(payload):
        payload["to_stop"]["id"] = payload["from_stop"]["id"]

    with pytest.raises(ValidationError):
        make_request(mutator)


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "   ",
        "a\x00b",
        "x" * 101,
        123,
        None,
        pytest.param("bad\ud800", id="lone-surrogate"),
    ],
)
def test_request_rejects_bad_stop_id(bad):
    with pytest.raises(ValidationError):
        make_request(lambda p: p["from_stop"].__setitem__("id", bad))


def test_request_rejects_lone_surrogate_in_trip_id():
    with pytest.raises(ValidationError):
        make_request(lambda p: p["parent"].__setitem__("trip_id", "trip\ud800"))


def test_request_same_coordinates_different_ids_are_legal():
    def mutator(payload):
        payload["to_stop"]["location"] = {"lng": 120.1, "lat": 30.2}

    request = make_request(mutator)
    assert request.from_stop.id != request.to_stop.id
    assert request.from_stop.location == request.to_stop.location


# ==================== 2. response 严格互斥 / source / 预算 ====================


def test_response_ready_echo_and_fixed_fields():
    request = make_request()
    response = make_response(request)
    assert response.map_status == "ready"
    assert response.leg is not None
    assert response.reason is None
    assert response.source.provider == "amap"
    assert response.source.coordinate_system == "WGS84"
    assert response.source.endpoint == "/v5/direction/walking"
    assert response.parent == request.parent
    assert response.day == request.day
    assert response.date == request.date
    assert response.travel_mode == request.travel_mode
    assert response.from_stop == request.from_stop
    assert response.to_stop == request.to_stop
    assert response.from_stop.location.lng == 120.1
    assert response.to_stop.location.lat == 30.3
    parsed = datetime.fromisoformat(response.checked_at)
    assert parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0)


@pytest.mark.parametrize("status", ["no_key", "timeout", "unavailable", "failed"])
def test_failure_response_shape(status):
    request = make_request()
    response = make_response(
        request, map_status=status, leg=None, reason=REASONS[status]
    )
    assert_failure_shape(response, request, status)
    assert "warnings" not in response.model_dump()


@pytest.mark.parametrize(
    "overrides",
    [
        {"map_status": "ready", "leg": None, "reason": None},
        {"map_status": "ready", "reason": "some reason"},
        {"map_status": "failed", "leg": "auto", "reason": REASONS["failed"]},
        {"map_status": "timeout", "leg": "auto", "reason": REASONS["timeout"]},
        {"map_status": "failed", "leg": None, "reason": None},
        {"map_status": "failed", "leg": None, "reason": ""},
        {"map_status": "no_key", "leg": None, "reason": "leaked key=SECRET"},
    ],
)
def test_response_status_and_content_are_mutually_exclusive(overrides):
    request = make_request()
    overrides = dict(overrides)
    if overrides.get("leg") == "auto":
        overrides["leg"] = sample_leg(request)
    with pytest.raises(ValidationError):
        make_response(request, **overrides)


@pytest.mark.parametrize(
    "leg",
    [
        bad_leg(route_type="straight_line"),
        bad_leg(route_type="unavailable"),
        bad_leg(from_stop_id="wrong-id"),
        bad_leg(to_stop_id="wrong-id"),
        bad_leg(mode="driving"),
        bad_leg(distance_m=None),
        bad_leg(distance_m=-1),
        bad_leg(distance_m=True),
        bad_leg(distance_m=1.5),
        bad_leg(distance_m=2**60),
        bad_leg(distance_m=float("nan")),
        bad_leg(duration_minutes=True),
        bad_leg(duration_minutes=-1.0),
        bad_leg(duration_minutes=float("inf")),
        bad_leg(duration_minutes="5"),
        bad_leg(geometry=[]),
        bad_leg(geometry=[Coordinate(lng=120.1, lat=30.2)]),
        bad_leg(geometry=sample_geometry(5001)),
        bad_leg(geometry=[Coordinate(lng=120.1, lat=30.2)] * 2),
        bad_leg(geometry=["not-a-coordinate", "not-a-coordinate"]),
        bad_leg(
            geometry=[
                Coordinate.model_construct(lng=float("nan"), lat=30.2),
                Coordinate(lng=120.2, lat=30.3),
            ]
        ),
        bad_leg(
            geometry=[
                Coordinate.model_construct(lng=True, lat=30.2),
                Coordinate(lng=120.2, lat=30.3),
            ]
        ),
        bad_leg(
            geometry=[
                Coordinate.model_construct(lng=200.0, lat=30.2),
                Coordinate(lng=120.2, lat=30.3),
            ]
        ),
    ],
)
def test_response_rejects_bad_ready_leg(leg):
    request = make_request()
    with pytest.raises(ValidationError):
        make_response(request, leg=leg)


def test_response_accepts_geometry_budget_and_safe_distance_extremes():
    request = make_request()
    response = make_response(
        request,
        leg=sample_leg(
            request, distance_m=0, duration_minutes=None, geometry=sample_geometry(5000)
        ),
    )
    assert response.leg.distance_m == 0
    assert response.leg.duration_minutes is None
    assert len(response.leg.geometry) == 5000


@pytest.mark.parametrize(
    "source",
    [
        {"provider": "baidu", "coordinate_system": "WGS84", "endpoint": "/v5/direction/walking"},
        {"provider": "amap", "coordinate_system": "GCJ02", "endpoint": "/v5/direction/walking"},
        {"provider": "amap", "coordinate_system": "WGS84", "endpoint": "/v3/geocode/geo"},
        {"provider": "amap", "coordinate_system": "WGS84", "endpoint": "/v3/place/text"},
        {"provider": "amap", "coordinate_system": "WGS84", "endpoint": "/v5/direction/walking", "extra": 1},
    ],
)
def test_response_source_rejects_unknown_endpoint_or_extra(source):
    with pytest.raises(ValidationError):
        LegRefreshSource.model_validate(source)


def test_response_source_endpoint_must_match_mode():
    request = make_request(lambda p: p.__setitem__("travel_mode", "driving"))
    with pytest.raises(ValidationError):
        make_response(request, source=LegRefreshSource(endpoint="/v5/direction/walking"))


@pytest.mark.parametrize(
    "bad",
    [
        "not-a-time",
        "2026-11-04T00:00:00",
        "2026-11-04T00:00:00+08:00",
        "2026-11-04",
        "",
        None,
    ],
)
def test_response_checked_at_must_be_utc_iso(bad):
    request = make_request()
    with pytest.raises(ValidationError):
        make_response(request, checked_at=bad)


def test_response_extra_forbid_including_warnings():
    request = make_request()
    with pytest.raises(ValidationError):
        make_response(request, warnings=["不应新增的字段"])


def test_response_day_date_and_mode_are_strict_echo():
    request = make_request()
    for bad in [0, 8, True, "1", 1.0]:
        with pytest.raises(ValidationError):
            make_response(request, day=bad)
    with pytest.raises(ValidationError):
        make_response(request, date="2026-02-30")
    with pytest.raises(ValidationError):
        make_response(request, travel_mode="cycling")


# ==================== 2b. 原始 wire（raw dict / model_validate_json）严格数值 ====================


WIRE_ENTRIES = ["dict", "json"]


def raw_ready_response(mutator=None):
    """完整可 JSON 序列化的 ready 响应；leg / parent / source 全是原始 dict。"""

    payload = {
        "parent": {"trip_id": "opaque-current-id", "revision": 1},
        "day": 1,
        "date": None,
        "travel_mode": "walking",
        "from_stop": {"id": "anchor-id", "location": {"lng": 120.1, "lat": 30.2}},
        "to_stop": {"id": "tail-first-id", "location": {"lng": 120.2, "lat": 30.3}},
        "map_status": "ready",
        "leg": {
            "from_stop_id": "anchor-id",
            "to_stop_id": "tail-first-id",
            "mode": "walking",
            "route_type": "navigation",
            "distance_m": 1234,
            "duration_minutes": 5.0,
            "geometry": [
                {"lng": 120.1, "lat": 30.2},
                {"lng": 120.2, "lat": 30.3},
            ],
            "description": "按两端记录坐标取得的衔接路段。",
        },
        "reason": None,
        "source": {
            "provider": "amap",
            "coordinate_system": "WGS84",
            "endpoint": "/v5/direction/walking",
        },
        "checked_at": utc_now_iso(),
    }
    if mutator is not None:
        mutator(payload)
    return payload


def validate_wire(payload, entry):
    """两个真实入口：raw dict 与 json.dumps 后的 model_validate_json。"""

    if entry == "dict":
        return LegRefreshResponse.model_validate(payload)
    return LegRefreshResponse.model_validate_json(json.dumps(payload))


@pytest.mark.parametrize("entry", WIRE_ENTRIES)
@pytest.mark.parametrize(
    "field,value",
    [
        ("distance_m", True),
        ("distance_m", False),
        ("distance_m", "123"),
        ("distance_m", "0"),
        ("duration_minutes", True),
        ("duration_minutes", False),
        ("duration_minutes", "5"),
        ("duration_minutes", "0"),
    ],
)
def test_wire_rejects_bool_string_leg_numbers_before_coercion(entry, field, value):
    def mutator(p):
        p["leg"][field] = value

    with pytest.raises(ValidationError):
        validate_wire(raw_ready_response(mutator), entry)


@pytest.mark.parametrize("entry", WIRE_ENTRIES)
@pytest.mark.parametrize(
    "field,value",
    [
        ("lng", True),
        ("lng", False),
        ("lng", "120.1"),
        ("lng", None),
        ("lat", True),
        ("lat", "30.2"),
    ],
)
def test_wire_rejects_bool_string_geometry_coordinates(entry, field, value):
    def mutator(p):
        p["leg"]["geometry"][0][field] = value

    with pytest.raises(ValidationError):
        validate_wire(raw_ready_response(mutator), entry)


@pytest.mark.parametrize("entry", WIRE_ENTRIES)
@pytest.mark.parametrize("bad", ["1", "1.0", 1.0, 0.0])
def test_wire_rejects_lax_coerced_revision(entry, bad):
    def mutator(p):
        p["parent"]["revision"] = bad

    with pytest.raises(ValidationError):
        validate_wire(raw_ready_response(mutator), entry)


@pytest.mark.parametrize("entry", WIRE_ENTRIES)
def test_wire_accepts_legal_integer_float_geometry_and_null_duration(entry):
    def mutator(p):
        p["leg"]["distance_m"] = 0
        p["leg"]["duration_minutes"] = None
        p["leg"]["geometry"] = [
            {"lng": 120, "lat": 30},
            {"lng": 120.2, "lat": 30.3},
        ]

    response = validate_wire(raw_ready_response(mutator), entry)
    assert response.map_status == "ready"
    assert response.leg.distance_m == 0
    assert response.leg.duration_minutes is None
    assert response.leg.geometry[0].lng == 120.0
    assert response.leg.geometry[0].lat == 30.0
    assert response.leg.geometry[1].lng == 120.2
    assert response.parent.revision == 1
    assert response.source.endpoint == "/v5/direction/walking"
    parsed = datetime.fromisoformat(response.checked_at)
    assert parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0)


@pytest.mark.parametrize("entry", WIRE_ENTRIES)
def test_wire_rejects_lone_surrogate_trip_id(entry):
    def mutator(p):
        p["parent"]["trip_id"] = "trip\ud800"

    with pytest.raises(ValidationError):
        validate_wire(raw_ready_response(mutator), entry)


def test_model_instance_path_keeps_service_leg_and_bad_injection_contract():
    request = make_request()
    # service 构造的 Leg 实例（模型实例入口）仍合法。
    response = make_response(
        request, leg=sample_leg(request, distance_m=0, duration_minutes=None)
    )
    assert response.map_status == "ready"
    assert response.leg.distance_m == 0
    assert response.leg.duration_minutes is None
    # 既有 model_construct 坏注入仍被 response 的 after validator 拒绝。
    with pytest.raises(ValidationError):
        make_response(request, leg=bad_leg(distance_m=True))
    with pytest.raises(ValidationError):
        make_response(request, leg=bad_leg(duration_minutes="5"))


# ==================== 3. service 离线闭环 ====================


def test_module_does_not_create_client_or_read_env():
    source = inspect.getsource(leg_refresh)
    assert "os.environ" not in source
    assert "dotenv" not in source
    assert "api_server" not in source
    assert "AMapClient(" not in source
    assert "AsyncClient(" not in source
    assert "load_dotenv" not in source


def test_none_client_returns_no_key_with_zero_route():
    request = make_request()
    response = run(refresh_leg_route(request, None))
    assert_failure_shape(response, request, "no_key")
    assert isinstance(request.parent, MapRefreshParent)


def test_unconfigured_fake_returns_no_key_with_zero_route():
    request = make_request()
    fake = FakeAMap(configured=False)
    response = run(refresh_leg_route(request, fake))
    assert_failure_shape(response, request, "no_key")
    assert fake.calls == 0


def test_checked_at_is_captured_at_call_start(monkeypatch):
    request = make_request()
    events = []
    fixed = "2026-11-04T00:00:00+00:00"

    def fake_clock():
        events.append("clock")
        return fixed

    monkeypatch.setattr(leg_refresh, "_utc_now", fake_clock)

    class RecordingAMap(FakeAMap):
        async def route(self, origin, destination, mode):
            events.append("route")
            return await super().route(origin, destination, mode)

    fake = RecordingAMap()
    response = run(refresh_leg_route(request, fake))
    assert events == ["clock", "route"]
    assert response.checked_at == fixed
    assert response.map_status == "ready"
    assert fake.calls == 1


def test_mocktransport_walking_single_v5_get_gcj_request_wgs_geometry():
    request = make_request()
    origin, destination = gcj_points(request)
    records = {"paths": [], "params": []}

    def handler(req):
        records["paths"].append(req.url.path)
        records["params"].append(dict(req.url.params))
        return httpx.Response(200, json=route_json(origin, destination))

    response = run(call_real_client(request, handler))

    # 恰一次 v5 GET，且没有任何 geocode / POI / 模型请求。
    assert records["paths"] == ["/v5/direction/walking"]
    params = records["params"][0]
    assert params["origin"] == f"{origin[0]:.6f},{origin[1]:.6f}"
    assert params["destination"] == f"{destination[0]:.6f},{destination[1]:.6f}"
    assert params["key"] == FAKE_KEY
    assert "polyline" in params["show_fields"]

    assert response.map_status == "ready"
    assert response.reason is None
    assert response.leg is not None
    assert response.leg.route_type == "navigation"
    assert response.leg.from_stop_id == request.from_stop.id
    assert response.leg.to_stop_id == request.to_stop.id
    assert response.leg.mode == request.travel_mode
    assert response.leg.distance_m == 1234
    assert response.leg.duration_minutes == 5.0
    assert response.source.endpoint == "/v5/direction/walking"

    expected_first = gcj02_to_wgs84(origin[0], origin[1])
    expected_last = gcj02_to_wgs84(destination[0], destination[1])
    assert response.leg.geometry[0].lng == pytest.approx(round(expected_first[0], 6), abs=1e-6)
    assert response.leg.geometry[0].lat == pytest.approx(round(expected_first[1], 6), abs=1e-6)
    assert response.leg.geometry[-1].lng == pytest.approx(round(expected_last[0], 6), abs=1e-6)
    assert response.leg.geometry[-1].lat == pytest.approx(round(expected_last[1], 6), abs=1e-6)

    # echo 端点保持请求原值，不回填、不二次转换。
    assert response.from_stop.location.lng == 120.1
    assert response.from_stop.location.lat == 30.2
    assert response.to_stop.location.lng == 120.2
    assert response.to_stop.location.lat == 30.3
    assert FAKE_KEY not in response.model_dump_json()


def test_mocktransport_driving_uses_driving_endpoint_and_source():
    request = make_request(lambda p: p.__setitem__("travel_mode", "driving"))
    origin, destination = gcj_points(request)
    records = {"paths": []}

    def handler(req):
        records["paths"].append(req.url.path)
        return httpx.Response(200, json=route_json(origin, destination, distance="5000"))

    response = run(call_real_client(request, handler))
    assert records["paths"] == ["/v5/direction/driving"]
    assert response.map_status == "ready"
    assert response.leg.distance_m == 5000
    assert response.source.endpoint == "/v5/direction/driving"
    assert response.travel_mode == "driving"


def test_ready_distance_zero_duration_null_from_upstream():
    request = make_request()
    origin, destination = gcj_points(request)

    def handler(req):
        return httpx.Response(
            200, json=route_json(origin, destination, distance="0", duration=None)
        )

    response = run(call_real_client(request, handler))
    assert response.map_status == "ready"
    assert response.leg.distance_m == 0
    assert response.leg.duration_minutes is None
    assert len(response.leg.geometry) == 2


def test_snapped_geometry_does_not_rewrite_echo_endpoints():
    request = make_request()
    origin, destination = gcj_points(request)
    snapped = (
        f"{origin[0] + 0.001:.6f},{origin[1] + 0.001:.6f};"
        f"{destination[0] - 0.001:.6f},{destination[1] - 0.001:.6f}"
    )

    def handler(req):
        return httpx.Response(200, json=route_json(origin, destination, polyline=snapped))

    response = run(call_real_client(request, handler))
    assert response.map_status == "ready"
    assert response.from_stop.location.lng == 120.1
    assert response.from_stop.location.lat == 30.2
    assert response.to_stop.location.lng == 120.2
    assert response.to_stop.location.lat == 30.3
    assert response.leg.geometry[0].lng != response.from_stop.location.lng
    assert response.leg.geometry[-1].lng != response.to_stop.location.lng


def test_bad_polyline_is_typed_failure():
    request = make_request()
    origin, destination = gcj_points(request)
    records = {"count": 0}

    def handler(req):
        records["count"] += 1
        return httpx.Response(
            200, json=route_json(origin, destination, omit_polyline=True)
        )

    response = run(call_real_client(request, handler))
    assert_failure_shape(response, request, "failed")
    assert records["count"] == 1


def test_http_error_is_unavailable():
    request = make_request()

    def handler(req):
        return httpx.Response(503, json={"status": "0", "info": "SERVICE_BUSY"})

    response = run(call_real_client(request, handler))
    assert_failure_shape(response, request, "unavailable")


def test_quota_error_is_unavailable_without_upstream_leak():
    request = make_request()

    def handler(req):
        return httpx.Response(
            200,
            json={"status": "0", "info": "DAILY_QUERY_OVER_LIMIT", "infocode": "10003"},
        )

    response = run(call_real_client(request, handler))
    assert_failure_shape(response, request, "unavailable")
    for forbidden in ["10003", "DAILY_QUERY_OVER_LIMIT", FAKE_KEY]:
        assert forbidden not in response.reason
        assert forbidden not in response.model_dump_json()


def test_timeout_is_bounded_and_routes_once():
    request = make_request()
    fake = FakeAMap(hang=True)
    started = time.monotonic()
    response = run(refresh_leg_route(request, fake, timeout_seconds=0.02))
    elapsed = time.monotonic() - started
    assert_failure_shape(response, request, "timeout")
    assert fake.calls == 1
    assert elapsed < 2.0


def test_cancellation_propagates_and_does_not_retry():
    request = make_request()
    fake = FakeAMap(hang=True)

    async def scenario():
        task = asyncio.create_task(
            refresh_leg_route(request, fake, timeout_seconds=30.0)
        )
        await asyncio.wait_for(fake.started.wait(), timeout=1.0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert fake.calls == 1
        assert task.cancelled() or task.done()

    run(scenario())


@pytest.mark.parametrize("bad", [0, -1, -0.0001, None, True, False, "abc", float("nan"), float("inf"), -float("inf")])
def test_bad_timeout_budget_never_waits_forever(bad):
    request = make_request()
    fake = FakeAMap()
    started = time.monotonic()
    response = run(refresh_leg_route(request, fake, timeout_seconds=bad))
    elapsed = time.monotonic() - started
    assert response.map_status == "ready"
    assert fake.calls == 1
    assert elapsed < 2.0


@pytest.mark.parametrize(
    "bad",
    [None, True, False, "x", 0, -1, float("nan"), float("inf"), -float("inf"), 1e300, 1e9],
)
def test_resolve_timeout_budget_is_finite_and_bounded(bad):
    value = leg_refresh._resolve_timeout_budget(bad)
    assert math.isfinite(value)
    assert 0.0 < value <= 60.0


def test_positive_budget_is_preserved():
    assert leg_refresh._resolve_timeout_budget(0.02) == 0.02
    assert leg_refresh._resolve_timeout_budget(20.0) == 20.0


@pytest.mark.parametrize(
    "result",
    [
        sample_route_result(distance_m=True),
        sample_route_result(distance_m=-1),
        sample_route_result(distance_m=float("nan")),
        sample_route_result(distance_m=float("inf")),
        sample_route_result(distance_m="1234"),
        sample_route_result(distance_m=1.5),
        sample_route_result(distance_m=2**60),
        sample_route_result(duration_minutes=True),
        sample_route_result(duration_minutes=-1.0),
        sample_route_result(duration_minutes=float("nan")),
        sample_route_result(duration_minutes=float("inf")),
        sample_route_result(duration_minutes="5"),
        sample_route_result(geometry=None),
        sample_route_result(geometry=[]),
        sample_route_result(geometry=[Coordinate(lng=120.1, lat=30.2)]),
        sample_route_result(geometry=sample_geometry(5001)),
        sample_route_result(geometry=[Coordinate(lng=120.1, lat=30.2)] * 2),
        sample_route_result(geometry=["x", "y"]),
        sample_route_result(
            geometry=[
                Coordinate.model_construct(lng=float("nan"), lat=30.2),
                Coordinate(lng=120.2, lat=30.3),
            ]
        ),
        sample_route_result(
            geometry=[
                Coordinate.model_construct(lng=True, lat=30.2),
                Coordinate(lng=120.2, lat=30.3),
            ]
        ),
        sample_route_result(
            geometry=[
                Coordinate.model_construct(lng=200.0, lat=30.2),
                Coordinate(lng=120.2, lat=30.3),
            ]
        ),
        sample_route_result(
            geometry=[Coordinate(lng=10.0, lat=10.0), Coordinate(lng=11.0, lat=11.0)]
        ),
        {"geometry": sample_geometry(), "distance_m": 1234, "duration_minutes": 5.0},
        SimpleNamespace(geometry=sample_geometry(), distance_m=1234, duration_minutes=5.0),
        None,
    ],
)
def test_injected_bad_route_shape_is_failed(result):
    request = make_request()
    fake = FakeAMap(result=result)
    response = run(refresh_leg_route(request, fake))
    assert_failure_shape(response, request, "failed")
    assert fake.calls == 1


@pytest.mark.parametrize(
    "result",
    [
        sample_route_result(distance_m=0, duration_minutes=None),
        sample_route_result(geometry=sample_geometry(5000)),
    ],
)
def test_injected_valid_route_shape_is_ready(result):
    request = make_request()
    fake = FakeAMap(result=result)
    response = run(refresh_leg_route(request, fake))
    assert response.map_status == "ready"
    assert response.leg is not None
    assert response.reason is None
    assert response.leg.route_type == "navigation"
    assert fake.calls == 1


def test_injected_route_is_called_once_with_gcj_points_and_mode():
    request = make_request()
    fake = FakeAMap()
    response = run(refresh_leg_route(request, fake))
    assert response.map_status == "ready"
    assert fake.calls == 1
    origin, destination, mode = fake.args[0]
    expected_origin = wgs84_to_gcj02(120.1, 30.2)
    expected_destination = wgs84_to_gcj02(120.2, 30.3)
    assert origin.lng == pytest.approx(expected_origin[0])
    assert origin.lat == pytest.approx(expected_origin[1])
    assert destination.lng == pytest.approx(expected_destination[0])
    assert destination.lat == pytest.approx(expected_destination[1])
    assert mode == "walking"


def test_failure_reason_never_leaks_upstream_exception_or_key():
    request = make_request()
    exc = AMapError(
        f"key={FAKE_KEY} path=/v5/direction/walking body=SECRET_RAW",
        code="http_error",
    )
    fake = FakeAMap(error=exc)
    response = run(refresh_leg_route(request, fake))
    assert_failure_shape(response, request, "unavailable")
    for forbidden in [FAKE_KEY, "SECRET_RAW", "Traceback", "AMapError", "body=", "/v5/direction"]:
        assert forbidden not in response.reason
    for forbidden in [FAKE_KEY, "SECRET_RAW", "Traceback", "AMapError"]:
        assert forbidden not in response.model_dump_json()


def test_unknown_exception_is_failed_with_fixed_reason():
    request = make_request()
    fake = FakeAMap(error=RuntimeError("SECRET /root/private/path raw_body"))
    response = run(refresh_leg_route(request, fake))
    assert_failure_shape(response, request, "failed")
    for forbidden in ["SECRET", "/root/private/path", "raw_body", "RuntimeError"]:
        assert forbidden not in response.reason
        assert forbidden not in response.model_dump_json()


def test_amap_error_timeout_code_maps_to_timeout():
    request = make_request()
    fake = FakeAMap(error=AMapError("上游超时", code="timeout"))
    response = run(refresh_leg_route(request, fake))
    assert_failure_shape(response, request, "timeout")


def test_amap_error_missing_key_code_maps_to_no_key():
    request = make_request()
    fake = FakeAMap(error=AMapError("未配置", code="missing_key"))
    response = run(refresh_leg_route(request, fake))
    assert_failure_shape(response, request, "no_key")

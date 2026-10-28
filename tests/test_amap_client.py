# -*- coding: utf-8 -*-
"""高德客户端离线测试：用 httpx.MockTransport，不访问真实网络。"""

import asyncio

import httpx
import pytest

from travel_itinerary import AMapClient, AMapError, Coordinate, gcj02_to_wgs84


def run(coro):
    return asyncio.run(coro)


async def _call_with_transport(handler, action):
    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        amap = AMapClient("test-key", client=http_client)
        return await action(amap)


def test_geocode_parses_gcj_location_and_keeps_lng_lat_order():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={
                "status": "1",
                "info": "OK",
                "geocodes": [
                    {
                        "formatted_address": "北京市东城区景山前街4号",
                        "location": "116.397,39.916",
                    }
                ],
            },
        )

    result = run(
        _call_with_transport(
            handler,
            lambda amap: amap.geocode("故宫", city="北京"),
        )
    )

    assert seen["path"] == "/v3/geocode/geo"
    assert seen["params"]["address"] == "故宫"
    assert seen["params"]["city"] == "北京"
    assert seen["params"]["key"] == "test-key"
    # 地理编码结果仍为 GCJ-02，保持经度在前。
    assert result.location.lng == pytest.approx(116.397)
    assert result.location.lat == pytest.approx(39.916)
    assert result.formatted_address == "北京市东城区景山前街4号"


def test_geocode_api_error_raises_amap_error_with_code():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"status": "0", "info": "INVALID_USER_KEY", "infocode": "10001"},
        )

    with pytest.raises(AMapError) as exc_info:
        run(
            _call_with_transport(
                handler,
                lambda amap: amap.geocode("故宫"),
            )
        )
    assert exc_info.value.code == "10001"
    assert "INVALID_USER_KEY" in str(exc_info.value)


def test_missing_key_is_never_sent_to_network():
    called = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        called["count"] += 1
        return httpx.Response(200, json={"status": "1"})

    async def action():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient("", client=http_client)
            assert amap.configured is False
            with pytest.raises(AMapError) as exc_info:
                await amap.geocode("故宫")
            assert exc_info.value.code == "missing_key"

    run(action())
    assert called["count"] == 0


def test_walking_route_requests_v5_and_converts_polyline_to_wgs84():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={
                "status": "1",
                "route": {
                    "paths": [
                        {
                            "distance": "1234",
                            "cost": {"duration": "300"},
                            "steps": [
                                {"polyline": "116.397,39.908;116.398,39.909"},
                                {"polyline": "116.398,39.909;116.400,39.910"},
                            ],
                        }
                    ]
                },
            },
        )

    result = run(
        _call_with_transport(
            handler,
            lambda amap: amap.route(
                Coordinate(lng=116.397, lat=39.908),
                Coordinate(lng=116.400, lat=39.910),
                "walking",
            ),
        )
    )

    assert seen["path"] == "/v5/direction/walking"
    assert seen["params"]["origin"] == "116.397000,39.908000"
    assert seen["params"]["destination"] == "116.400000,39.910000"
    assert "polyline" in seen["params"]["show_fields"]
    assert result.distance_m == 1234
    assert result.duration_minutes == 5.0

    expected_first = gcj02_to_wgs84(116.397, 39.908)
    assert result.geometry[0].lng == pytest.approx(expected_first[0], abs=1e-6)
    assert result.geometry[0].lat == pytest.approx(expected_first[1], abs=1e-6)
    # 相邻步骤的重复端点被去掉，不是把每一步都原样拼接。
    assert len(result.geometry) == 3


def test_driving_route_uses_driving_endpoint_and_v3_duration_fallback():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        return httpx.Response(
            200,
            json={
                "status": "1",
                "route": {
                    "paths": [
                        {
                            "distance": 5000,
                            "duration": "900",
                            "steps": [{"polyline": "116.397,39.908;116.470,39.950"}],
                        }
                    ]
                },
            },
        )

    result = run(
        _call_with_transport(
            handler,
            lambda amap: amap.route(
                Coordinate(lng=116.397, lat=39.908),
                Coordinate(lng=116.470, lat=39.950),
                "driving",
            ),
        )
    )

    assert seen["path"] == "/v5/direction/driving"
    assert result.distance_m == 5000
    assert result.duration_minutes == 15.0
    assert len(result.geometry) == 2


def test_route_without_polyline_raises_instead_of_faking_geometry():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "1",
                "route": {"paths": [{"distance": "100", "cost": {"duration": "60"}}]},
            },
        )

    with pytest.raises(AMapError) as exc_info:
        run(
            _call_with_transport(
                handler,
                lambda amap: amap.route(
                    Coordinate(lng=116.397, lat=39.908),
                    Coordinate(lng=116.400, lat=39.910),
                    "walking",
                ),
            )
        )
    assert exc_info.value.code == "missing_polyline"


def test_route_reads_distance_from_cost_container_when_path_field_missing():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "1",
                "route": {
                    "paths": [
                        {
                            "cost": {"duration": "120", "distance": "777"},
                            "steps": [{"polyline": "116.397,39.908;116.398,39.909"}],
                        }
                    ]
                },
            },
        )

    result = run(
        _call_with_transport(
            handler,
            lambda amap: amap.route(
                Coordinate(lng=116.397, lat=39.908),
                Coordinate(lng=116.398, lat=39.909),
                "walking",
            ),
        )
    )
    assert result.distance_m == 777
    assert result.duration_minutes == 2.0


def test_route_quota_error_is_reported_readably():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"status": "0", "info": "DAILY_QUERY_OVER_LIMIT", "infocode": "10003"},
        )

    with pytest.raises(AMapError) as exc_info:
        run(
            _call_with_transport(
                handler,
                lambda amap: amap.route(
                    Coordinate(lng=116.397, lat=39.908),
                    Coordinate(lng=116.400, lat=39.910),
                    "walking",
                ),
            )
        )
    assert exc_info.value.code == "10003"
    assert "DAILY_QUERY_OVER_LIMIT" in str(exc_info.value)

# -*- coding: utf-8 -*-
"""地图数据可信度与降级回归测试。

全部使用 httpx.MockTransport 或假客户端，不需要真实 AMAP_API_KEY，也不访问外网。
覆盖：
- 区县级宽泛地理编码不能冒充景点坐标，可识别名称优先走 POI；
- 高德返回 inf / 非有限数值时只降级相关路段；
- 单个站点或路段异常不拖垮整趟行程；
- 鉴权/配额错误码进入 warnings，且不泄露 key、URL 或原始异常。
"""

import asyncio
import json

import httpx
import pytest

from travel_itinerary import (
    AMapClient,
    AMapError,
    Coordinate,
    GeoResult,
    RouteResult,
    TripPlanRequest,
    build_agent_trip,
    gcj02_to_wgs84,
)
from travel_itinerary import _extract_duration_minutes, _to_int

SECRET = "sk-map-secret-should-never-appear"
POISON_TEXT = "https://restapi.amap.com/v3/place/text?key=sk-map-secret-should-never-appear"


def run(coro):
    return asyncio.run(coro)


def make_request(**overrides):
    data = {
        "destination": "杭州",
        "days": 1,
        "travelers": 1,
        "preferences": "",
        "travel_mode": "walking",
    }
    data.update(overrides)
    return TripPlanRequest(**data)


def make_payload(stops):
    return {
        "title": "杭州一日",
        "summary": "测试用行程。",
        "days": [
            {
                "day": 1,
                "title": "第1天",
                "summary": "当天概述",
                "stops": stops,
            }
        ],
    }


def stop(name, address="", time="09:00"):
    return {"name": name, "time": time, "address": address, "duration_minutes": 60}


def poi(name, lng, lat, *, city="杭州市", address=None):
    return GeoResult(
        location=Coordinate(lng=lng, lat=lat),
        formatted_address=address or f"{city}西湖区{name}",
        name=name,
        city=city,
        district="西湖区",
    )


def route_result(origin, destination, *, distance=300, duration=5.0):
    return RouteResult(
        geometry=[origin, destination],
        distance_m=distance,
        duration_minutes=duration,
    )


class PoiFirstAMap:
    configured = True

    def __init__(self):
        self.geocode_calls = 0
        self.route_calls = 0

    async def search_poi(self, keywords, *, city=None):
        locations = {
            "断桥残雪": (120.1500, 30.2600),
            "平湖秋月": (120.1400, 30.2500),
        }
        lng, lat = locations[keywords]
        return poi(keywords, lng, lat, address=f"杭州市西湖区{keywords}")

    async def geocode(self, address, *, city=None):
        self.geocode_calls += 1
        raise AssertionError("POI 已经命中，不应再拿模型写宽的地址做地理编码")

    async def route(self, origin, destination, mode):
        self.route_calls += 1
        return route_result(origin, destination)


def test_verified_poi_wins_over_district_level_geocode_and_uses_real_address():
    fake = PoiFirstAMap()
    trip = run(
        build_agent_trip(
            make_payload(
                [
                    stop("断桥残雪", "杭州市西湖区"),
                    stop("平湖秋月", "杭州市西湖区", time="10:30"),
                ]
            ),
            make_request(),
            fake,
        )
    )

    first = trip.days[0].stops[0]
    expected = gcj02_to_wgs84(120.15, 30.26)
    assert first.location is not None
    assert first.location.lng == pytest.approx(expected[0], abs=1e-6)
    assert first.location.lat == pytest.approx(expected[1], abs=1e-6)
    # 真实 POI 地址覆盖模型瞎写的宽泛地址。
    assert "断桥残雪" in first.address
    assert fake.geocode_calls == 0
    assert [leg.route_type for leg in trip.days[0].legs] == ["navigation"]


class DistrictOnlyAMap:
    configured = True

    def __init__(self):
        self.geocode_calls = []
        self.route_calls = 0

    async def search_poi(self, keywords, *, city=None):
        raise AMapError("没有匹配的 POI", code="poi_mismatch")

    async def geocode(self, address, *, city=None):
        self.geocode_calls.append(address)
        return GeoResult(
            location=Coordinate(lng=120.1300, lat=30.2700),
            formatted_address="杭州市西湖区",
            level="区县",
            city="杭州市",
        )

    async def route(self, origin, destination, mode):  # pragma: no cover
        self.route_calls += 1
        raise AssertionError("没有可信坐标时不应尝试路线规划")


def test_district_level_geocode_leaves_null_instead_of_faking_attraction():
    fake = DistrictOnlyAMap()
    trip = run(
        build_agent_trip(
            make_payload(
                [
                    stop("断桥残雪", "杭州市西湖区"),
                    stop("平湖秋月", "杭州市西湖区", time="10:30"),
                ]
            ),
            make_request(),
            fake,
        )
    )

    assert all(stop.location is None for stop in trip.days[0].stops)
    assert all(leg.route_type == "unavailable" for leg in trip.days[0].legs)
    assert all(leg.geometry == [] for leg in trip.days[0].legs)
    assert fake.route_calls == 0
    joined = " ".join(trip.warnings)
    assert "区县" in joined
    assert "无法通过高德获取可信坐标" in joined


def test_broad_admin_query_is_rejected_even_with_non_admin_level():
    class RoadLevelAMap:
        configured = True

        async def search_poi(self, keywords, *, city=None):
            raise AMapError("没有匹配的 POI", code="poi_mismatch")

        async def geocode(self, address, *, city=None):
            return GeoResult(
                location=Coordinate(lng=120.1300, lat=30.2700),
                formatted_address="杭州市西湖区",
                level="道路",
                city="杭州市",
            )

        async def route(self, origin, destination, mode):  # pragma: no cover
            raise AssertionError("没有可信坐标时不应请求路线")

    trip = run(
        build_agent_trip(
            make_payload([stop("断桥残雪", "杭州市西湖区")]),
            make_request(),
            RoadLevelAMap(),
        )
    )

    assert trip.days[0].stops[0].location is None
    assert "查询地址只到行政区级" in " ".join(trip.warnings)


class MismatchedPoiThenPreciseGeocode:
    configured = True

    async def search_poi(self, keywords, *, city=None):
        return poi("西湖音乐喷泉", 120.1600, 30.2500)

    async def geocode(self, address, *, city=None):
        return GeoResult(
            location=Coordinate(lng=120.1450, lat=30.2550),
            formatted_address="杭州市西湖区北山街1号",
            level="门牌号",
            city="杭州市",
        )

    async def route(self, origin, destination, mode):
        return route_result(origin, destination)


def test_precise_street_geocode_is_accepted_when_poi_name_does_not_match():
    trip = run(
        build_agent_trip(
            make_payload([stop("断桥残雪", "杭州市西湖区北山街1号")]),
            make_request(),
            MismatchedPoiThenPreciseGeocode(),
        )
    )

    resolved = trip.days[0].stops[0]
    assert resolved.location is not None
    assert resolved.address == "杭州市西湖区北山街1号"


@pytest.mark.parametrize("level", ["门牌号", "兴趣点", "道路", "公交地铁站点"])
def test_reasonable_precise_geocode_levels_are_not_rejected(level):
    class PreciseAMap:
        configured = True

        async def search_poi(self, keywords, *, city=None):
            raise AMapError("没有匹配的 POI", code="poi_mismatch")

        async def geocode(self, address, *, city=None):
            return GeoResult(
                location=Coordinate(lng=120.1450, lat=30.2550),
                formatted_address="杭州市西湖区北山街1号",
                level=level,
                city="杭州市",
            )

        async def route(self, origin, destination, mode):  # pragma: no cover
            return route_result(origin, destination)

    trip = run(
        build_agent_trip(
            make_payload([stop("断桥残雪", "杭州市西湖区北山街1号")]),
            make_request(),
            PreciseAMap(),
        )
    )
    assert trip.days[0].stops[0].location is not None


MISSING = object()


@pytest.mark.parametrize(
    "level_marker",
    [MISSING, None, [], ["未知"]],
    ids=[
        "level-missing",
        "level-null",
        "level-empty-array",
        "level-unknown-array",
    ],
)
def test_amap_client_missing_or_array_level_is_not_trusted(level_marker):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v3/place/text":
            return httpx.Response(200, json={"status": "1", "pois": []})
        if request.url.path == "/v3/geocode/geo":
            item = {
                "formatted_address": "杭州市西湖区",
                "location": "120.1300,30.2700",
                "city": "杭州市",
            }
            if level_marker is not MISSING:
                item["level"] = level_marker
            return httpx.Response(200, json={"status": "1", "geocodes": [item]})
        raise AssertionError(f"没有可信坐标时不应请求 {request.url.path}")

    async def action():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient("test-key", client=http_client)
            return await build_agent_trip(
                make_payload([stop("断桥残雪", "杭州市西湖区")]),
                make_request(),
                amap,
            )

    trip = run(action())
    assert trip.days[0].stops[0].location is None
    assert all(leg.route_type == "unavailable" for leg in trip.days[0].legs)
    joined = " ".join(trip.warnings)
    assert "无法通过高德获取可信坐标" in joined
    assert "未返回地理编码匹配级别" in joined or "未知级行政" in joined


def test_poi_search_skips_mismatched_first_result():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v3/place/text"
        return httpx.Response(
            200,
            json={
                "status": "1",
                "pois": [
                    {
                        "name": "西湖音乐喷泉",
                        "location": "120.1600,30.2500",
                        "cityname": "杭州市",
                        "adname": "西湖区",
                        "address": "湖滨路",
                    },
                    {
                        "name": "断桥残雪",
                        "location": "120.1500,30.2600",
                        "cityname": "杭州市",
                        "adname": "西湖区",
                        "address": "北山街",
                    },
                ],
            },
        )

    async def action():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient("test-key", client=http_client)
            return await amap.search_poi("断桥残雪", city="杭州")

    result = run(action())
    assert result.name == "断桥残雪"
    assert result.formatted_address == "杭州市西湖区北山街"


def test_malformed_infinite_distance_degrades_only_that_leg():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        params = dict(request.url.params)
        if path == "/v3/place/text":
            name = params["keywords"]
            index = {"断桥残雪": 1, "平湖秋月": 2, "苏堤春晓": 3}[name]
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "pois": [
                        {
                            "name": name,
                            "location": f"120.1{index}0,30.2{index}0",
                            "cityname": "杭州市",
                            "adname": "西湖区",
                            "address": f"西湖景区{name}",
                        }
                    ],
                },
            )
        if path == "/v5/direction/walking":
            if params["origin"].startswith("120.110"):
                return httpx.Response(
                    200,
                    json={
                        "status": "1",
                        "route": {
                            "paths": [
                                {
                                    "distance": "inf",
                                    "cost": {"duration": "60"},
                                    "steps": [
                                        {"polyline": "120.110,30.210;120.120,30.220"}
                                    ],
                                }
                            ]
                        },
                    },
                )
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "route": {
                        "paths": [
                            {
                                "distance": "500",
                                "cost": {"duration": "inf"},
                                "steps": [{"polyline": "120.120,30.220;120.130,30.230"}],
                            }
                        ]
                    },
                },
            )
        raise AssertionError(f"unexpected path {path}")

    async def action():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient("test-key", client=http_client)
            return await build_agent_trip(
                make_payload(
                    [
                        stop("断桥残雪", "杭州市西湖区", time="09:00"),
                        stop("平湖秋月", "杭州市西湖区", time="10:00"),
                        stop("苏堤春晓", "杭州市西湖区", time="11:00"),
                    ]
                ),
                make_request(),
                amap,
            )

    trip = run(action())
    assert all(stop.location is not None for stop in trip.days[0].stops)
    first_leg, second_leg = trip.days[0].legs
    assert first_leg.route_type == "straight_line"
    assert first_leg.distance_m is None
    assert second_leg.route_type == "navigation"
    assert second_leg.distance_m == 500
    assert second_leg.duration_minutes is None
    assert "耗时未知" in second_leg.description
    assert _to_int("inf") is None
    assert _extract_duration_minutes({"duration": "inf"}) is None


def test_absurd_polyline_is_rejected_and_leg_degrades():
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v3/place/text":
            name = dict(request.url.params)["keywords"]
            lng, lat = (116.397, 39.908) if name == "天安门广场" else (116.411, 39.909)
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "pois": [
                        {
                            "name": name,
                            "location": f"{lng},{lat}",
                            "cityname": "北京市",
                            "adname": "东城区",
                            "address": "测试路",
                        }
                    ],
                },
            )
        if path == "/v5/direction/walking":
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "route": {
                        "paths": [
                            {
                                "distance": "1500",
                                "cost": {"duration": "600"},
                                "steps": [
                                    {
                                        "polyline": (
                                            "116.397000,39.908000;"
                                            "121.473700,31.230400;"
                                            "116.411000,39.909000"
                                        )
                                    }
                                ],
                            }
                        ]
                    },
                },
            )
        raise AssertionError(path)

    async def action():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient("test-key", client=http_client)
            return await build_agent_trip(
                make_payload(
                    [
                        stop("天安门广场", "北京市东城区东长安街", time="09:00"),
                        stop("王府井", "北京市东城区王府井大街", time="10:30"),
                    ]
                ),
                make_request(destination="北京"),
                amap,
            )

    trip = run(action())
    assert all(stop.location is not None for stop in trip.days[0].stops)
    leg = trip.days[0].legs[0]
    assert leg.route_type == "straight_line"
    assert "路线获取失败" in " ".join(trip.warnings)


class ScheduleAMap:
    configured = True

    def __init__(self):
        self.route_calls = 0

    async def search_poi(self, keywords, *, city=None):
        index = {"甲": 1, "乙": 2}[keywords]
        return poi(keywords, 120.10 + index / 100.0, 30.20 + index / 100.0)

    async def geocode(self, address, *, city=None):  # pragma: no cover
        raise AssertionError("POI 已命中")

    async def route(self, origin, destination, mode):
        self.route_calls += 1
        return route_result(origin, destination, distance=1000, duration=30.0)


def test_route_duration_conflict_warns_without_mutating_schedule():
    trip = run(
        build_agent_trip(
            make_payload(
                [
                    {
                        "name": "甲",
                        "time": "09:00",
                        "duration_minutes": 10,
                        "address": "杭州市甲路",
                    },
                    {
                        "name": "乙",
                        "time": "09:10",
                        "duration_minutes": 30,
                        "address": "杭州市乙路",
                    },
                ]
            ),
            make_request(),
            ScheduleAMap(),
        )
    )

    assert [stop.time for stop in trip.days[0].stops] == ["09:00", "09:10"]
    assert trip.days[0].stops[0].duration_minutes == 10
    assert trip.days[0].legs[0].duration_minutes == pytest.approx(30.0)
    joined = " ".join(trip.warnings)
    assert "时间冲突" in joined
    assert "甲" in joined and "乙" in joined


class ExplodingStopAMap:
    configured = True

    def __init__(self):
        self.route_calls = 0

    async def search_poi(self, keywords, *, city=None):
        if keywords == "爆炸景点":
            raise RuntimeError(f"boom {POISON_TEXT}")
        return poi(keywords, 120.1500, 30.2600)

    async def geocode(self, address, *, city=None):
        if "爆炸" in address:
            raise RuntimeError(f"boom {POISON_TEXT}")
        return GeoResult(
            location=Coordinate(lng=120.1500, lat=30.2600),
            formatted_address="杭州市西湖区正常路1号",
            level="门牌号",
            city="杭州市",
        )

    async def route(self, origin, destination, mode):  # pragma: no cover
        self.route_calls += 1
        raise AssertionError("缺少坐标的路段不应请求路线")


def test_unexpected_stop_error_keeps_other_stops_and_does_not_leak_details():
    fake = ExplodingStopAMap()
    trip = run(
        build_agent_trip(
            make_payload(
                [
                    stop("爆炸景点", "杭州市爆炸路1号"),
                    stop("正常景点", "杭州市正常路1号", time="10:00"),
                ]
            ),
            make_request(),
            fake,
        )
    )

    first, second = trip.days[0].stops
    assert first.location is None
    assert second.location is not None
    assert trip.days[0].legs[0].route_type == "unavailable"
    assert fake.route_calls == 0
    joined = " ".join(trip.warnings)
    assert "内部异常" in joined
    serialized = json.dumps(trip.model_dump(mode="json"), ensure_ascii=False)
    assert SECRET not in serialized
    assert "restapi.amap.com" not in serialized
    assert "boom" not in serialized


class ExplodingRouteAMap:
    configured = True

    def __init__(self):
        self.calls = 0

    async def search_poi(self, keywords, *, city=None):
        index = {"甲": 1, "乙": 2, "丙": 3}[keywords]
        return poi(keywords, 120.1 + index / 100.0, 30.2 + index / 100.0)

    async def geocode(self, address, *, city=None):  # pragma: no cover
        raise AssertionError("POI 已命中，不应调用地理编码")

    async def route(self, origin, destination, mode):
        self.calls += 1
        if origin.lat < 30.215:
            raise RuntimeError(f"boom {POISON_TEXT}")
        return route_result(origin, destination, distance=200, duration=3.0)


def test_unexpected_route_error_degrades_only_that_leg():
    fake = ExplodingRouteAMap()
    trip = run(
        build_agent_trip(
            make_payload(
                [
                    stop("甲", "杭州市甲路", time="09:00"),
                    stop("乙", "杭州市乙路", time="10:00"),
                    stop("丙", "杭州市丙路", time="11:00"),
                ]
            ),
            make_request(),
            fake,
        )
    )

    assert all(stop.location is not None for stop in trip.days[0].stops)
    first_leg, second_leg = trip.days[0].legs
    assert first_leg.route_type == "straight_line"
    assert second_leg.route_type == "navigation"
    assert second_leg.distance_m == 200
    joined = " ".join(trip.warnings)
    assert "路线解析异常" in joined
    serialized = json.dumps(trip.model_dump(mode="json"), ensure_ascii=False)
    assert SECRET not in serialized
    assert "boom" not in serialized


@pytest.mark.parametrize(
    ("code", "fragment"),
    [
        ("10001", "API Key 无效"),
        ("10009", "Web 服务接口不匹配"),
        ("10044", "配额受限"),
    ],
)
def test_fatal_amap_codes_are_aggregated_and_stop_extra_calls(code, fragment):
    class BrokenKeyAMap:
        configured = True

        def __init__(self):
            self.calls = 0
            self.route_calls = 0

        async def search_poi(self, keywords, *, city=None):
            self.calls += 1
            raise AMapError(POISON_TEXT, code=code)

        async def geocode(self, address, *, city=None):
            self.calls += 1
            raise AMapError(POISON_TEXT, code=code)

        async def route(self, origin, destination, mode):
            self.route_calls += 1
            raise AMapError(POISON_TEXT, code=code)

    fake = BrokenKeyAMap()
    stops = [
        stop(f"景点{index}", "杭州市西湖区", time=f"{9 + index:02d}:00")
        for index in range(8)
    ]
    trip = run(build_agent_trip(make_payload(stops), make_request(), fake))

    assert all(stop.location is None for stop in trip.days[0].stops)
    assert all(leg.route_type == "unavailable" for leg in trip.days[0].legs)
    assert fake.route_calls == 0
    # 8 个站点最多 24 次调用；熔断后只允许信号量内已经开始的少量请求。
    assert 1 <= fake.calls <= 4
    joined = " ".join(trip.warnings)
    assert code in joined
    assert fragment in joined
    serialized = json.dumps(trip.model_dump(mode="json"), ensure_ascii=False)
    assert SECRET not in serialized
    assert "restapi.amap.com" not in serialized
    assert POISON_TEXT not in serialized


def test_cancelled_error_is_not_swallowed_as_a_degraded_stop():
    class CancelledAMap:
        configured = True

        async def search_poi(self, keywords, *, city=None):
            raise asyncio.CancelledError()

        async def geocode(self, address, *, city=None):  # pragma: no cover
            return GeoResult(
                location=Coordinate(lng=120.15, lat=30.26),
                formatted_address="杭州市西湖区",
                level="门牌号",
            )

        async def route(self, origin, destination, mode):  # pragma: no cover
            return route_result(origin, destination)

    with pytest.raises(asyncio.CancelledError):
        run(build_agent_trip(make_payload([stop("断桥残雪")]), make_request(), CancelledAMap()))


# ==================== POI 错店：不覆盖用户地址、不输出虚假精确定位 ====================


class WrongBranchPoiAMap:
    """POI 只会搜到另一家同品牌门店；用户自己写的门牌地址是准确的。"""

    configured = True

    def __init__(self):
        self.geocode_calls = []
        self.route_calls = 0

    async def search_poi(self, keywords, *, city=None):
        return GeoResult(
            location=Coordinate(lng=120.1630, lat=30.2760),
            formatted_address="杭州市下城区武林广场1号如家酒店（武林广场店）",
            name="如家酒店（武林广场店）",
            city="杭州市",
            district="下城区",
        )

    async def geocode(self, address, *, city=None):
        self.geocode_calls.append(address)
        return GeoResult(
            location=Coordinate(lng=120.1300, lat=30.2740),
            formatted_address="杭州市西湖区文三路100号",
            level="门牌号",
            city="杭州市",
        )

    async def route(self, origin, destination, mode):
        self.route_calls += 1
        return route_result(origin, destination)


def test_wrong_branch_poi_does_not_override_user_address():
    fake = WrongBranchPoiAMap()
    trip = run(
        build_agent_trip(
            make_payload(
                [
                    stop("如家酒店（西湖店）", "杭州市西湖区文三路100号"),
                    stop("西湖断桥", "杭州市西湖区北山街", time="10:30"),
                ]
            ),
            make_request(),
            fake,
        )
    )

    first = trip.days[0].stops[0]
    # 用户地址里的门牌号仍然生效，没有被另一家门店的地址覆盖。
    assert first.address == "杭州市西湖区文三路100号"
    assert "武林" not in first.address
    # 坐标来自用户地址的地理编码，不是武林广场店。
    expected = gcj02_to_wgs84(120.13, 30.274)
    assert first.location is not None
    assert first.location.lng == pytest.approx(expected[0], abs=1e-6)
    assert first.location.lat == pytest.approx(expected[1], abs=1e-6)
    assert fake.geocode_calls and fake.geocode_calls[0] == "杭州市西湖区文三路100号"


class WrongBranchEverywhereAMap(WrongBranchPoiAMap):
    """连名称地理编码都只会返回错误门店，用来验证不会硬凑坐标。"""

    async def search_poi(self, keywords, *, city=None):
        if "如家" not in keywords:
            return GeoResult(
                location=Coordinate(lng=120.1450, lat=30.2570),
                formatted_address="杭州市西湖区北山街",
                name=keywords,
                city="杭州市",
                district="西湖区",
            )
        return await super().search_poi(keywords, city=city)

    async def geocode(self, address, *, city=None):
        self.geocode_calls.append(address)
        if "如家" not in address:
            return GeoResult(
                location=Coordinate(lng=120.1450, lat=30.2570),
                formatted_address="杭州市西湖区北山街",
                level="兴趣点",
                city="杭州市",
            )
        return GeoResult(
            location=Coordinate(lng=120.1630, lat=30.2760),
            formatted_address="杭州市下城区武林广场1号如家酒店（武林广场店）",
            level="兴趣点",
            city="杭州市",
        )

    async def route(self, origin, destination, mode):  # pragma: no cover
        self.route_calls += 1
        raise AssertionError("没有可信坐标时不应请求路线")


def test_unconfirmed_branch_keeps_null_location_and_warns():
    fake = WrongBranchEverywhereAMap()
    trip = run(
        build_agent_trip(
            make_payload(
                [
                    stop("如家酒店（西湖店）"),
                    stop("西湖断桥", "杭州市西湖区北山街", time="10:30"),
                ]
            ),
            make_request(),
            fake,
        )
    )

    first = trip.days[0].stops[0]
    assert first.location is None, "不同门店的坐标不能被当成用户指定的门店"
    assert first.address == "", "没有可信结果时不应写入别家门店的地址"
    assert fake.route_calls == 0

    joined = " ".join(trip.warnings)
    assert "无法通过高德获取可信坐标" in joined
    assert "门店/分店标识不一致" in joined
    # 站点数据里不能出现别家门店的地址或坐标（warnings 里解释原因时可以提到店名）。
    wrong = gcj02_to_wgs84(120.163, 30.276)
    for stop_data in trip.model_dump(mode="json")["days"][0]["stops"]:
        assert "武林广场" not in stop_data["address"]
        if stop_data["location"] is not None:
            assert stop_data["location"]["lng"] != pytest.approx(wrong[0], abs=1e-6)
    assert all(
        stop.location is None
        for stop in trip.days[0].stops
        if stop.name.startswith("如家")
    )


def test_directionally_different_station_is_not_used():
    """杭州东站不能拿到杭州西站的坐标，哪怕高德首条就是西站。"""

    class WrongStationAMap:
        configured = True

        def __init__(self):
            self.route_calls = 0

        async def search_poi(self, keywords, *, city=None):
            return GeoResult(
                location=Coordinate(lng=120.0300, lat=30.2900),
                formatted_address="杭州市余杭区杭州西站",
                name="杭州西站",
                city="杭州市",
            )

        async def geocode(self, address, *, city=None):
            raise AMapError("没有匹配的地点", code="geocode_not_found")

        async def route(self, origin, destination, mode):  # pragma: no cover
            self.route_calls += 1
            raise AssertionError("没有可信坐标时不应请求路线")

    fake = WrongStationAMap()
    trip = run(
        build_agent_trip(
            make_payload([stop("杭州东站", "杭州东站")]),
            make_request(),
            fake,
        )
    )

    assert trip.days[0].stops[0].location is None
    assert fake.route_calls == 0
    assert "方位标识不一致" in " ".join(trip.warnings)


# ==================== POI 边界：门店后缀、入口、括号限定词 ====================


class FixedPoiAMap:
    """POI 搜索固定返回一条结果；退回地理编码即报错，用来确认坐标来源。"""

    configured = True

    def __init__(self, name, address):
        self.name = name
        self.address = address
        self.route_calls = 0

    async def search_poi(self, keywords, *, city=None):
        return poi(self.name, 120.1600, 30.2700, address=self.address)

    async def geocode(self, address, *, city=None):  # pragma: no cover
        raise AssertionError(f"不该退回地理编码：{address}")

    async def route(self, origin, destination, mode):
        self.route_calls += 1
        return route_result(origin, destination)


def test_store_branch_suffix_variants_are_accepted():
    """全聚德（东直门店）能拿到高德返回的全聚德(东直门分店) 坐标。"""

    fake = FixedPoiAMap("全聚德(东直门分店)", "杭州市上城区东直门")
    trip = run(
        build_agent_trip(
            make_payload([stop("全聚德（东直门店）")]),
            make_request(),
            fake,
        )
    )

    first = trip.days[0].stops[0]
    assert first.location is not None, trip.warnings
    assert first.address == "杭州市上城区东直门"
    assert "无法通过高德获取可信坐标" not in " ".join(trip.warnings)


def test_same_attraction_entrance_is_accepted():
    """搜索“雷峰塔”时拿到“雷峰塔东门”的坐标，不应被当成另一个错点。"""

    fake = FixedPoiAMap("雷峰塔东门", "杭州市西湖区南山路")
    trip = run(
        build_agent_trip(make_payload([stop("雷峰塔")]), make_request(), fake)
    )

    first = trip.days[0].stops[0]
    assert first.location is not None, trip.warnings
    assert first.address == "杭州市西湖区南山路"


def test_unspecified_branch_is_not_invented():
    """用户只说“全聚德”，高德返回某一家分店时不能直接当成确定位置。"""

    fake = FixedPoiAMap("全聚德（西湖店）", "杭州市西湖区文三路1号")
    trip = run(
        build_agent_trip(make_payload([stop("全聚德")]), make_request(), fake)
    )

    first = trip.days[0].stops[0]
    assert first.location is None, "未指定分店却用了某一家分店的坐标"
    assert first.address == "", "未指定分店却写入了某一家分店的地址"
    joined = " ".join(trip.warnings)
    assert "无法通过高德获取可信坐标" in joined
    assert "没有标出" in joined


def test_unspecified_branch_does_not_fall_back_to_name_geocode():
    """真实客户端在 POI 只匹配到某一家分店时，不能再用名称地理编码锁定它。"""

    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        calls.append(path)
        if path == "/v3/place/text":
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "pois": [
                        {
                            "name": "全聚德（王府井店）",
                            "location": "120.160000,30.270000",
                            "cityname": "杭州市",
                            "adname": "上城区",
                            "address": "王府井大街1号",
                        }
                    ],
                },
            )
        if path == "/v3/geocode/geo":
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "geocodes": [
                        {
                            "formatted_address": "杭州市上城区王府井大街1号全聚德（王府井店）",
                            "location": "120.160000,30.270000",
                            "level": "兴趣点",
                            "city": "杭州市",
                        }
                    ],
                },
            )
        raise AssertionError(f"unexpected path {path}")

    async def enrich():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = AMapClient("fixture-key", client=http_client)
            return await build_agent_trip(
                make_payload([stop("全聚德")]), make_request(), amap
            )

    trip = run(enrich())

    assert trip.days[0].stops[0].location is None
    assert "/v3/geocode/geo" not in calls, "未指定分店时不应退回名称地理编码"
    joined = " ".join(trip.warnings)
    assert "无法确认是同一处" in joined

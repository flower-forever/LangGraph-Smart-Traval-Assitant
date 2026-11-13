# -*- coding: utf-8 -*-
"""七期 S1 · 多城生成流（normalize / enrich / resolver / day_replan）测试。

全部离线：FakeAMap 只回放固定坐标，不读密钥、不联网。
"""

import asyncio

import pytest

import day_replan
from day_replan import DayReplanRequest
from travel_itinerary import (
    AMapError,
    Coordinate,
    DayPlan,
    GeoResult,
    RouteResult,
    Stop,
    TripPlanRequest,
    enrich_trip_with_map,
    normalize_agent_payload,
)


CITY_COORDS = {
    "杭州": Coordinate(lng=120.1551, lat=30.2741),
    "苏州": Coordinate(lng=120.5853, lat=31.2989),
}


# ==================== helpers ====================


def _request(
    *,
    cities: list[tuple[str, int]] | None = None,
    days: int = 5,
    travel_mode: str = "walking",
) -> TripPlanRequest:
    data = {
        "destination": cities[0][0] if cities else "杭州",
        "days": days,
        "departure_date": "2026-05-01",
        "travelers": 2,
        "preferences": "",
        "travel_mode": travel_mode,
    }
    if cities:
        data["cities"] = [
            {"name": name, "days": city_days} for name, city_days in cities
        ]
    return TripPlanRequest(**data)


def _payload(
    day_count: int = 5,
    *,
    cities_by_day: list[str] | None = None,
    stops_per_day: int = 2,
    model_city: str | None = None,
) -> dict:
    days = []
    for index in range(day_count):
        city = cities_by_day[index] if cities_by_day else "杭州"
        stops = []
        for stop_index in range(stops_per_day):
            stops.append(
                {
                    "name": f"{city}景点{index + 1}-{stop_index + 1}",
                    "time": f"{9 + stop_index * 2}:00",
                    "duration_minutes": 60,
                    "description": "",
                    "address": f"{city}示例路{index + 1}{stop_index + 1}号",
                }
            )
        day = {
            "day": index + 1,
            "title": f"第{index + 1}天",
            "summary": "",
            "stops": stops,
        }
        if model_city is not None:
            day["city"] = model_city
        days.append(day)
    return {"title": "", "summary": "", "days": days}


class RecordingAMap:
    """按请求 city 返回该城固定坐标，并记录每次调用的 city 参数。"""

    configured = True

    def __init__(self, *, failing_cities: set[str] | None = None) -> None:
        self.calls: list[tuple[str, str, str | None]] = []
        self.failing_cities = set(failing_cities or ())

    async def search_poi(self, keywords, *, city=None):
        self.calls.append(("search_poi", keywords, city))
        if city in self.failing_cities:
            raise AMapError("没有搜到匹配地点", code="mock_not_found")
        return GeoResult(
            location=CITY_COORDS[city],
            formatted_address=f"{city}示例地址",
            name=keywords,
        )

    async def geocode(self, address, *, city=None):
        self.calls.append(("geocode", address, city))
        if city in self.failing_cities:
            raise AMapError("未找到地址", code="mock_not_found")
        return GeoResult(
            location=CITY_COORDS[city],
            formatted_address=f"{city}示例地址",
        )

    async def route(self, origin, destination, mode):
        self.calls.append(("route", mode, None))
        return RouteResult(
            geometry=[origin, destination],
            distance_m=900,
            duration_minutes=12.0,
        )


def _multicity_trip() -> tuple[TripPlanRequest, object]:
    request = _request(cities=[("杭州", 3), ("苏州", 2)])
    trip, _ = normalize_agent_payload(
        _payload(5, cities_by_day=["杭州", "杭州", "杭州", "苏州", "苏州"]),
        request,
    )
    return request, trip


def _run_enrich(trip, request, amap):
    return asyncio.run(enrich_trip_with_map(trip, request, amap))


# ==================== 6. normalize 多城分城 ====================


def test_normalize_assigns_city_by_request_day_counts():
    request, trip = _multicity_trip()

    assert [day.city for day in trip.days] == [
        "杭州",
        "杭州",
        "杭州",
        "苏州",
        "苏州",
    ]
    assert trip.destination == "杭州"
    assert trip.cityProfile is None
    assert trip.cityProfiles is None
    assert trip.title == "杭州·苏州5日行程"
    assert "杭州·苏州" in trip.summary


def test_normalize_three_cities_smoke():
    request = _request(cities=[("杭州", 2), ("苏州", 2), ("南京", 1)])
    trip, _ = normalize_agent_payload(
        _payload(5, cities_by_day=["杭州", "杭州", "苏州", "苏州", "南京"]),
        request,
    )
    assert [day.city for day in trip.days] == ["杭州", "杭州", "苏州", "苏州", "南京"]


def test_normalize_single_city_keeps_city_none():
    request = _request()
    trip, _ = normalize_agent_payload(_payload(5), request)
    assert all(day.city is None for day in trip.days)
    assert trip.cityProfiles is None


def test_normalize_ignores_model_written_day_city():
    request = _request(cities=[("杭州", 3), ("苏州", 2)])
    trip, _ = normalize_agent_payload(
        _payload(
            5,
            cities_by_day=["杭州", "杭州", "杭州", "苏州", "苏州"],
            model_city="北京",
        ),
        request,
    )
    assert [day.city for day in trip.days] == [
        "杭州",
        "杭州",
        "杭州",
        "苏州",
        "苏州",
    ]


# ==================== 7. enrich 城际段与 resolver 城市参数 ====================


def test_enrich_builds_intercity_leg_with_estimate():
    request, trip = _multicity_trip()
    amap = RecordingAMap()
    enriched = _run_enrich(trip, request, amap)

    day3 = enriched.days[2]
    intercity = day3.legs[-1]
    assert intercity.transferKind == "intercity"
    assert intercity.mode == "driving"
    assert intercity.route_type == "straight_line"
    assert intercity.from_stop_id == day3.stops[-1].id
    assert intercity.to_stop_id == enriched.days[3].stops[0].id
    assert intercity.distance_m is not None
    assert abs(intercity.distance_m - 121_000) < 3_000
    assert intercity.duration_minutes is not None
    assert abs(intercity.duration_minutes - 131) <= 2
    assert len(intercity.geometry) == 2
    assert intercity.geometry[0] == day3.stops[-1].location
    assert intercity.geometry[1] == enriched.days[3].stops[0].location

    description = intercity.description
    assert "城际转移：杭州 → 苏州" in description
    assert "直线约 121.1 公里" in description
    assert "按 80 公里/小时估算并预留 40 分钟" in description
    assert "建议预留约 2 小时 11 分钟" in description
    assert "具体班次与时刻未提供，请自行查询" in description
    assert len(description) <= 500

    # 同日 leg 数不变：每天 2 站 → 1 条；城际段不调用高德 route。
    assert len([leg for leg in day3.legs if leg.transferKind is None]) == 1
    route_calls = [call for call in amap.calls if call[0] == "route"]
    assert len(route_calls) == 5
    assert sum(
        1
        for day in enriched.days
        for leg in day.legs
        if leg.transferKind == "intercity"
    ) == 1
    assert enriched.days[-1].legs[-1].transferKind is None


def test_enrich_uses_each_days_city_for_place_resolution():
    request, trip = _multicity_trip()
    amap = RecordingAMap()
    _run_enrich(trip, request, amap)

    poi_calls = [call for call in amap.calls if call[0] == "search_poi"]
    assert poi_calls
    assert {call[2] for call in poi_calls} == {"杭州", "苏州"}
    for _, keywords, city in poi_calls:
        expected = "苏州" if keywords.startswith("苏州") else "杭州"
        assert city == expected


def test_enrich_missing_coordinate_degrades_intercity_leg():
    request, trip = _multicity_trip()
    amap = RecordingAMap(failing_cities={"苏州"})
    enriched = _run_enrich(trip, request, amap)

    intercity = enriched.days[2].legs[-1]
    assert intercity.transferKind == "intercity"
    assert intercity.route_type == "unavailable"
    assert intercity.distance_m is None
    assert intercity.duration_minutes is None
    assert intercity.geometry == []
    assert "缺少可信坐标，距离与耗时未知" in intercity.description
    assert "具体班次与时刻未提供，请自行查询" in intercity.description


def test_enrich_without_amap_still_adds_unavailable_intercity_leg():
    request, trip = _multicity_trip()
    enriched = _run_enrich(trip, request, None)

    day3 = enriched.days[2]
    intercity = day3.legs[-1]
    assert intercity.transferKind == "intercity"
    assert intercity.route_type == "unavailable"
    assert intercity.distance_m is None
    assert intercity.geometry == []
    assert "缺少可信坐标，距离与耗时未知" in intercity.description


def test_enrich_is_idempotent_for_intercity_legs():
    request, trip = _multicity_trip()
    amap = RecordingAMap()
    once = _run_enrich(trip, request, amap)
    twice = _run_enrich(once, request, amap)

    def counts(enriched):
        return [
            sum(1 for leg in day.legs if leg.transferKind == "intercity")
            for day in enriched.days
        ]

    assert counts(once) == [0, 0, 1, 0, 0]
    assert counts(twice) == [0, 0, 1, 0, 0]
    assert len(once.days[2].legs) == len(twice.days[2].legs)

    no_map_once = _run_enrich(trip, request, None)
    no_map_twice = _run_enrich(no_map_once, request, None)
    assert counts(no_map_twice) == [0, 0, 1, 0, 0]


# ==================== 8. day_replan 保留 city ====================


def test_build_target_day_keeps_city():
    base_day = DayPlan(
        day=1,
        date=None,
        title="第1天",
        summary="苏州第1天的行程安排。",
        city="苏州",
        stops=[
            Stop(id="stop-d01-01", name="甲", time="09:00"),
            Stop(id="stop-d01-02", name="乙", time="11:00"),
        ],
    )
    request = DayReplanRequest.model_validate(
        {
            "destination": "苏州",
            "day": 2,
            "date": "2026-11-02",
            "travel_mode": "walking",
            "instruction": "改成室内。",
            "stops": [],
            "parent": {"trip_id": "trip-agent-abc123", "revision": 1},
        }
    )

    day, _ = day_replan._build_target_day(base_day, request, {})

    assert day.city == "苏州"
    assert day.day == 2

# -*- coding: utf-8 -*-
"""时刻表安全检查回归测试（不依赖地图数据）。

背景：地图密钥缺失、地图客户端失败、或地图增强总超时时，api_server 返回的是
归一化后的行程，原来完全没有时刻表冲突提醒——三个 09:00 开始、各停留 2 小时
的站点看起来完全正常。预期：只要相邻站点的停留时间和下一站起始时间重叠，
就必须在 warnings 里提醒（说明第几天、点名站点），且不改站点时间/停留时长。

另覆盖：
- 跨午夜按“次日”表述，不把 23:00 -> 00:30 比较成负数；不同天不混算；
- 每对相邻站点最多一条提醒，重复调用不叠加；
- warnings 达到 40 条上限时显式汇总剩余条数与涉及天数，关键地图降级与
  模型提示不被挤掉。

全部离线：假 Agent + fake 地图客户端 + httpx.MockTransport，不访问真实高德 /
DashScope，也不读 .env 或真实密钥。
"""

import asyncio
import copy
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

import api_server
import travel_itinerary
from travel_itinerary import (
    GENERATED_CONTENT_WARNING,
    MAX_TRIP_WARNINGS,
    PLACEHOLDER_TIME_CAVEAT,
    SCHEDULE_CONFLICT_PREFIX,
    SCHEDULE_ORDER_PREFIX,
    UNKNOWN_TIME_SOURCE_CAVEAT,
    WARNING_SUMMARY_PREFIX,
    AMapError,
    TripPlanRequest,
    build_agent_trip,
    dedupe_warnings,
    normalize_agent_payload,
    _schedule_time_label,
)


def run(coro):
    return asyncio.run(coro)


_CONFLICT_KEYWORDS = ("时间冲突", "重叠", "赶不上", "早于上一站")


def _conflict_warnings(warnings):
    return [
        warning
        for warning in warnings
        if not warning.startswith(WARNING_SUMMARY_PREFIX)
        and any(keyword in warning for keyword in _CONFLICT_KEYWORDS)
    ]


def _request(days=1):
    return TripPlanRequest(destination="杭州", days=days, travel_mode="walking")


def _payload(*, days=1, stops=None, time="09:00", duration=120):
    """按 days 生成行程，默认每天 3 个同一时间开始、各停留 2 小时的站点。"""

    if stops is None:
        stops = [
            {
                "name": f"景点{index + 1}",
                "time": time,
                "duration_minutes": duration,
                "description": "测试站点。",
            }
            for index in range(3)
        ]
    return {
        "title": "杭州行程",
        "summary": "时刻表冲突回归用行程。",
        "days": [
            {
                "day": day_number,
                "title": f"第{day_number}天",
                "summary": "当天概述",
                "stops": [
                    {
                        **stop,
                        "name": f"{stop['name']}-D{day_number}"
                        if stop.get("name")
                        else f"景点-D{day_number}",
                    }
                    for stop in stops
                ],
            }
            for day_number in range(1, days + 1)
        ],
    }


class FailingAMap:
    """所有调用都失败，且不是致命错误码：模拟地图服务整体不可用。"""

    configured = True

    def __init__(self):
        self.calls = 0

    async def search_poi(self, keywords, *, city=None):
        self.calls += 1
        raise AMapError("地图服务不可用", code="mock_unavailable")

    async def geocode(self, address, *, city=None):
        self.calls += 1
        raise AMapError("地图服务不可用", code="mock_unavailable")

    async def route(self, origin, destination, mode):
        self.calls += 1
        raise AMapError("地图服务不可用", code="mock_unavailable")


class FatalKeyAMap(FailingAMap):
    """鉴权失败：触发熔断，用来验证关键地图降级不会被上限挤掉。"""

    async def search_poi(self, keywords, *, city=None):
        self.calls += 1
        raise AMapError("INVALID_USER_KEY", code="10001")

    async def geocode(self, address, *, city=None):
        self.calls += 1
        raise AMapError("INVALID_USER_KEY", code="10001")

    async def route(self, origin, destination, mode):  # pragma: no cover
        self.calls += 1
        raise AMapError("INVALID_USER_KEY", code="10001")


# ==================== 1. 三个重叠站点：三种降级路径都要提醒 ====================


def test_no_map_key_still_warns_about_three_overlapping_stops():
    trip = run(build_agent_trip(_payload(), _request(), None))

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 2, f"三站两段应各提醒一次：{trip.warnings!r}"
    joined = " ".join(conflicts)
    assert "第1天" in joined
    assert "景点1" in joined and "景点2" in joined and "景点3" in joined
    # 没有任何地图耗时时不许编造交通时间。
    assert all("约需" not in conflict for conflict in conflicts)

    # 只提醒，不改数据。
    assert [stop.time for stop in trip.days[0].stops] == ["09:00", "09:00", "09:00"]
    assert [stop.duration_minutes for stop in trip.days[0].stops] == [120, 120, 120]
    assert all(leg.route_type == "unavailable" for leg in trip.days[0].legs)


def test_failing_map_client_still_warns_about_three_overlapping_stops():
    fake = FailingAMap()
    trip = run(build_agent_trip(_payload(), _request(), fake))

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 2, f"地图失败时也要提醒：{trip.warnings!r}"
    assert all("第1天" in conflict for conflict in conflicts)
    # 地图失败时没有真实耗时，不允许出现编造的“约需 N 分钟”。
    assert all("约需" not in conflict for conflict in conflicts)
    assert all(stop.location is None for stop in trip.days[0].stops)


# ==================== 2. API 地图总超时路径仍保留提醒 ====================


class FakeAgent:
    def __init__(self, content):
        self.content = content
        self.calls = []

    async def ainvoke(self, payload, config=None):
        self.calls.append((payload, config))
        return {"messages": [SimpleNamespace(content=self.content)]}


class _LifecycleOnlyAMap:
    instances: list["_LifecycleOnlyAMap"] = []

    def __init__(self, api_key, *, timeout=6.0):
        self.api_key = api_key
        self.timeout = timeout
        self.entered = False
        self.closed = False
        _LifecycleOnlyAMap.instances.append(self)

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.closed = True


@pytest.fixture
def client(monkeypatch):
    for name in (
        "DASHSCOPE_API_KEY",
        "AMAP_API_KEY",
        "TRIP_PLAN_TIMEOUT",
        "MAP_ENRICH_TIMEOUT",
    ):
        monkeypatch.delenv(name, raising=False)

    with TestClient(api_server.app) as test_client:
        monkeypatch.setattr(api_server.cfg, "api_key", None)
        monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
        monkeypatch.setattr(api_server.cfg, "plan_timeout", 30.0)
        monkeypatch.setattr(api_server.cfg, "amap_timeout", 6.0)
        monkeypatch.setattr(
            api_server.cfg,
            "map_enrich_timeout",
            api_server.DEFAULT_MAP_ENRICH_TIMEOUT,
        )
        monkeypatch.setattr(api_server, "agent", None)
        monkeypatch.setattr(api_server, "planner_agent", None)
        monkeypatch.setattr(api_server, "mcp_client", None)
        monkeypatch.setattr(api_server, "available_tools", [])
        yield test_client


def test_api_map_timeout_response_keeps_schedule_conflicts(client, monkeypatch):
    api_server.planner_agent = FakeAgent(json.dumps(_payload(), ensure_ascii=False))
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server.cfg, "map_enrich_timeout", 0.05)
    _LifecycleOnlyAMap.instances.clear()
    monkeypatch.setattr(api_server, "AMapClient", _LifecycleOnlyAMap)

    async def never_finishes(trip, request, amap):
        await asyncio.Event().wait()

    monkeypatch.setattr(api_server, "enrich_trip_with_map", never_finishes)

    response = client.post(
        "/api/trips/plan",
        json={
            "destination": "杭州",
            "days": 1,
            "departure_date": None,
            "travelers": 1,
            "preferences": "",
            "travel_mode": "walking",
        },
    )

    assert response.status_code == 200
    trip = travel_itinerary.TripPlan.model_validate(response.json())

    # 地图超时提示仍然在。
    assert any("地图数据超时" in warning for warning in trip.warnings)
    # 模型提示不被挤掉。
    assert GENERATED_CONTENT_WARNING in trip.warnings
    # 归一化阶段的时刻表提醒必须保留到响应里。
    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 2, f"地图超时后丢了时刻表提醒：{trip.warnings!r}"
    assert all("第1天" in conflict for conflict in conflicts)
    # 超时路径不伪造坐标与路线。
    assert all(stop.location is None for stop in trip.days[0].stops)
    assert all(leg.route_type == "unavailable" for leg in trip.days[0].legs)


# ==================== 3. 只在时间可信时提醒 ====================


def test_missing_duration_does_not_invent_conflict():
    stops = [
        {"name": f"景点{i + 1}", "time": "09:00"} for i in range(3)
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), None))

    assert all(stop.duration_minutes is None for stop in trip.days[0].stops)
    assert _conflict_warnings(trip.warnings) == [], (
        f"停留时长未知时不应推算冲突：{trip.warnings!r}"
    )


def test_feasible_sequential_schedule_has_no_conflict():
    stops = [
        {"name": "景点1", "time": "09:00", "duration_minutes": 90},
        {"name": "景点2", "time": "11:00", "duration_minutes": 60},
        {"name": "景点3", "time": "13:00", "duration_minutes": 60},
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), None))

    assert _conflict_warnings(trip.warnings) == [], trip.warnings


def test_each_overlapping_pair_is_reported_exactly_once():
    trip = run(build_agent_trip(_payload(), _request(), None))

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 2
    assert len(set(conflicts)) == len(conflicts), "同一对站点被重复提醒"

    # 再跑一次（模拟客户端重试 / 幂等调用）不叠加重复提醒。
    again = run(build_agent_trip(_payload(), _request(), None))
    assert again.warnings == trip.warnings


# ==================== 4. 跨午夜与跨天 ====================


def test_cross_midnight_is_reported_as_next_day_and_days_do_not_mix():
    payload = {
        "title": "跨午夜行程",
        "summary": "第一天跨午夜，第二天正常。",
        "days": [
            {
                "day": 1,
                "stops": [
                    {"name": "夜游A", "time": "23:00", "duration_minutes": 120},
                    {"name": "夜宵B", "time": "00:30", "duration_minutes": 30},
                ],
            },
            {
                "day": 2,
                "stops": [
                    {"name": "早茶C", "time": "09:00", "duration_minutes": 120},
                    {"name": "早茶D", "time": "09:00", "duration_minutes": 120},
                ],
            },
        ],
    }
    trip = run(build_agent_trip(payload, _request(days=2), None))

    day1 = [w for w in _conflict_warnings(trip.warnings) if "第1天" in w]
    day2 = [w for w in _conflict_warnings(trip.warnings) if "第2天" in w]
    assert len(day1) == 1 and len(day2) == 1, trip.warnings

    # 23:00 起停留 120 分钟 => 次日 01:00 才结束，比 00:30 晚。
    assert "次日 01:00" in day1[0]
    assert "次日 00:30" in day1[0]
    # 第 2 天的提醒里不能出现第 1 天的站点，反过来说，跨天没有混算。
    assert "夜游A" in day1[0] and "早茶C" not in day1[0]
    assert "早茶C" in day2[0] and "夜游A" not in day2[0]


def test_same_day_backwards_time_is_flagged_without_negative_math():
    payload = {
        "title": "顺序倒置行程",
        "summary": "下午排在上午之前。",
        "days": [
            {
                "day": 1,
                "stops": [
                    {"name": "下午站", "time": "15:00", "duration_minutes": 30},
                    {"name": "上午站", "time": "10:00", "duration_minutes": 30},
                ],
            }
        ],
    }
    trip = run(build_agent_trip(payload, _request(), None))

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 1, trip.warnings
    assert "下午站" in conflicts[0] and "上午站" in conflicts[0]
    assert "早于上一站" in conflicts[0]
    # 不能把倒置算成“提前 300 分钟到达”这类负数结论。
    assert "提前" not in conflicts[0]


# ==================== 5. 40 条上限：显式汇总，不挤掉关键提醒 ====================


def _crowded_payload():
    return {
        "title": "拥挤行程",
        "summary": "每天都排满重叠站点。",
        "days": [
            {
                "day": day_number,
                "stops": [
                    {
                        "name": f"站点{day_number}-{index}",
                        "time": "09:00",
                        "duration_minutes": 120,
                    }
                    for index in range(8)
                ],
            }
            for day_number in range(1, 8)
        ],
    }


def test_warning_cap_summarizes_remaining_conflicts_instead_of_silent_truncation():
    trip, warnings = normalize_agent_payload(_crowded_payload(), _request(days=7))

    assert len(trip.warnings) == MAX_TRIP_WARNINGS
    assert warnings == trip.warnings

    summaries = [
        warning
        for warning in trip.warnings
        if warning.startswith(WARNING_SUMMARY_PREFIX)
    ]
    assert len(summaries) == 1, f"超上限时应有且只有一条汇总提醒：{trip.warnings!r}"
    summary = summaries[0]
    # 49 段冲突只能展示一部分，汇总行要说清剩余条数与涉及天数。
    assert "未展开" in summary
    assert "时间冲突 11 条" in summary
    assert "第7天" in summary

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) < 49, "不能声称所有冲突都展开了"
    # 40 条里：1 条模型提示 + 1 条汇总行 + 剩下的是冲突提醒。
    assert len(conflicts) + 2 == MAX_TRIP_WARNINGS


def test_cap_keeps_model_notice_and_fatal_map_degradation():
    trip = run(
        build_agent_trip(_crowded_payload(), _request(days=7), FatalKeyAMap())
    )

    assert len(trip.warnings) == MAX_TRIP_WARNINGS
    assert GENERATED_CONTENT_WARNING in trip.warnings, "模型提示被挤掉了"
    assert any(
        "10001" in warning and "高德地图" in warning for warning in trip.warnings
    ), f"关键地图降级被挤掉了：{trip.warnings!r}"
    assert any(
        warning.startswith(WARNING_SUMMARY_PREFIX) for warning in trip.warnings
    ), "超上限没有汇总行"


def test_dedupe_keeps_traffic_conflict_over_plain_overlap_conflicts():
    traffic = (
        "时间冲突：第1天 甲 09:00 起停留 10 分钟，步行到 乙 约需 30 分钟，"
        "预计 09:40 才能抵达，但计划安排在 09:10，按当前时刻表赶不上。"
    )
    plains = [
        f"时间冲突：第{day}天 站点{index} 09:00 起停留 120 分钟，"
        "到 11:00 才结束，晚于下一站的时间；两站时间重叠。"
        for day in range(2, 8)
        for index in range(8)
    ]
    map_warning = (
        "高德地图 API Key 无效或已过期（错误码 10001），已停止继续请求；"
        "请检查服务端 AMAP_API_KEY 配置。"
    )

    warnings = dedupe_warnings(
        [GENERATED_CONTENT_WARNING, map_warning, traffic, *plains]
    )

    assert len(warnings) == MAX_TRIP_WARNINGS
    assert GENERATED_CONTENT_WARNING in warnings
    assert map_warning in warnings
    assert traffic in warnings, "真实交通冲突被普通重叠提醒挤掉了"
    assert any(warning.startswith(WARNING_SUMMARY_PREFIX) for warning in warnings)


def test_map_timeout_plus_crowded_conflicts_still_keeps_timeout_warning():
    """带 40 条提醒的行程再追加超时提示时，超时提示不能被静默丢掉。"""

    trip, _ = normalize_agent_payload(_crowded_payload(), _request(days=7))
    timeout_warning = "地图数据超时（>35 秒）：已保留已生成的文字行程。"

    merged = dedupe_warnings(list(trip.warnings) + [timeout_warning])

    assert len(merged) == MAX_TRIP_WARNINGS
    assert timeout_warning in merged, "超时提示被上限截断丢掉了"
    assert GENERATED_CONTENT_WARNING in merged
    assert any(warning.startswith(WARNING_SUMMARY_PREFIX) for warning in merged)


# ==================== 6. 与真实地图耗时并存时不重复提醒 ====================


class RouteDurationAMap:
    """POI 命中、路线耗时 30 分钟，用来验证有地图时只保留一条提醒。"""

    configured = True

    async def search_poi(self, keywords, *, city=None):
        return travel_itinerary.GeoResult(
            location=travel_itinerary.Coordinate(lng=120.15, lat=30.26),
            formatted_address=f"杭州市西湖区{keywords}",
            name=keywords,
            city="杭州市",
        )

    async def geocode(self, address, *, city=None):  # pragma: no cover
        raise AssertionError("POI 已命中")

    async def route(self, origin, destination, mode):
        return travel_itinerary.RouteResult(
            geometry=[origin, destination],
            distance_m=1000,
            duration_minutes=30.0,
        )


def test_map_duration_conflict_replaces_overlap_warning_without_duplicating():
    stops = [
        {"name": "甲", "time": "09:00", "duration_minutes": 10, "address": "杭州市甲路"},
        {"name": "乙", "time": "09:10", "duration_minutes": 30, "address": "杭州市乙路"},
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), RouteDurationAMap()))

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 1, f"同一对站点被提醒两次：{trip.warnings!r}"
    assert "约需 30 分钟" in conflicts[0] and "第1天" in conflicts[0]
    assert trip.days[0].stops[0].duration_minutes == 10
    assert trip.days[0].legs[0].duration_minutes == pytest.approx(30.0)


def test_second_enrich_pass_is_idempotent_with_map_data(monkeypatch):
    """重复调用 enrich 不叠加提醒，也不改变已算出的冲突文案。"""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v3/place/text":
            name = dict(request.url.params)["keywords"]
            lng = 120.15 if name == "甲" else 120.16
            return httpx.Response(
                200,
                json={
                    "status": "1",
                    "pois": [
                        {
                            "name": name,
                            "location": f"{lng},30.26",
                            "cityname": "杭州市",
                            "adname": "西湖区",
                            "address": "北山街",
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
                                "distance": "900",
                                "cost": {"duration": "1800"},
                                "steps": [{"polyline": "120.150,30.260;120.160,30.260"}],
                            }
                        ]
                    },
                },
            )
        raise AssertionError(f"unexpected path {path}")

    stops = [
        {"name": "甲", "time": "09:00", "duration_minutes": 10},
        {"name": "乙", "time": "09:10", "duration_minutes": 30},
    ]
    request = _request()
    trip = run(build_agent_trip(_payload(stops=stops), request, None))

    async def enrich(trip_in):
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as http_client:
            amap = travel_itinerary.AMapClient("fixture-key", client=http_client)
            return await travel_itinerary.enrich_trip_with_map(
                trip_in, request, amap
            )

    once = run(enrich(trip))
    twice = run(enrich(once))

    assert once.warnings == twice.warnings
    conflicts = _conflict_warnings(once.warnings)
    assert len(conflicts) == 1, f"重复增强叠加了提醒：{once.warnings!r}"


# ==================== 7. 倒序时间：不静默、不硬判，也不依赖停留时长 ====================


def _order_or_conflict_warnings(warnings):
    return [
        warning
        for warning in warnings
        if warning.startswith((SCHEDULE_ORDER_PREFIX, SCHEDULE_CONFLICT_PREFIX))
    ]


def test_backwards_time_without_durations_is_not_silent():
    """11:00 -> 10:00 且两站都没写停留时长：仍要出现“时间顺序/跨日待确认”。"""

    stops = [
        {"name": "上午站", "time": "11:00"},
        {"name": "下一站", "time": "10:00"},
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), None))

    notices = [
        warning
        for warning in trip.warnings
        if warning.startswith(SCHEDULE_ORDER_PREFIX)
    ]
    assert len(notices) == 1, trip.warnings
    notice = notices[0]
    assert "第1天" in notice
    assert "上午站" in notice and "下一站" in notice
    assert "早于上一站" in notice
    assert "时间顺序或跨日待确认" in notice
    assert "未改动站点时间" in notice
    # 只提示，不改源数据。
    assert [stop.time for stop in trip.days[0].stops] == ["11:00", "10:00"]
    assert all(stop.duration_minutes is None for stop in trip.days[0].stops)


@pytest.mark.parametrize("duration", [None, 30, 600])
def test_2200_to_0900_is_not_asserted_as_same_day_error(duration):
    """22:00 -> 09:00 不再被断言“同一天无法执行”，换停留时长也不会静默。"""

    stops = [
        {"name": "夜游站", "time": "22:00", "duration_minutes": duration},
        {"name": "早间站", "time": "09:00", "duration_minutes": 30},
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), None))

    warnings = _order_or_conflict_warnings(trip.warnings)
    assert len(warnings) == 1, trip.warnings
    text = warnings[0]
    assert "第1天" in text
    assert "夜游站" in text and "早间站" in text
    assert "早于上一站" in text
    assert "时间顺序或跨日待确认" in text
    # 不再把“倒序”直接定死成同日错误。
    assert "同一天内按这个顺序无法执行" not in text
    if duration is None:
        assert text.startswith(SCHEDULE_ORDER_PREFIX)
        assert "缺少停留时长" in text
    else:
        assert "按次日" in text
    assert [stop.duration_minutes for stop in trip.days[0].stops] == [
        duration,
        30,
    ]


def test_late_night_next_day_candidate_is_explained_as_assumption():
    """23:50 停留 20 分钟、下一站 00:20：按次日理解可衔接，但必须写明是假设。"""

    stops = [
        {"name": "夜游站", "time": "23:50", "duration_minutes": 20},
        {"name": "夜宵站", "time": "00:20", "duration_minutes": 30},
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), None))

    warnings = [
        warning
        for warning in trip.warnings
        if warning.startswith(SCHEDULE_ORDER_PREFIX)
    ]
    assert len(warnings) == 1, trip.warnings
    text = warnings[0]
    assert "时间顺序或跨日待确认" in text
    assert "按次日假设" in text
    assert "次日 00:10" in text and "次日 00:20" in text
    assert "可以衔接" in text
    assert "不能确认日期" in text
    # 只有“待确认”，没有把假设写成确定的时间冲突。
    assert [
        warning
        for warning in trip.warnings
        if warning.startswith(SCHEDULE_CONFLICT_PREFIX)
    ] == []


def test_schedule_labels_distinguish_second_and_third_day():
    """超过 24 小时要写“次日/第三天”，不能按 24 小时取模假装还是当天。"""

    assert _schedule_time_label(23 * 60 + 50) == "23:50"
    assert _schedule_time_label(24 * 60) == "次日 00:00"
    assert _schedule_time_label(48 * 60) == "第三天 00:00"
    assert _schedule_time_label(48 * 60 + 29) == "第三天 00:29"


def test_warning_after_24_hours_uses_third_day_label():
    """23:50 停留 1440 分钟再步行 30 分钟，抵达已经是第三天 00:20。"""

    stops = [
        {"name": "甲", "time": "23:50", "duration_minutes": 1440},
        {"name": "乙", "time": "01:00", "duration_minutes": 30},
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), RouteDurationAMap()))

    warnings = _order_or_conflict_warnings(trip.warnings)
    assert len(warnings) == 1, trip.warnings
    assert "第三天 00:20" in warnings[0], warnings[0]
    assert [stop.time for stop in trip.days[0].stops] == ["23:50", "01:00"]
    assert trip.days[0].stops[0].duration_minutes == 1440


# ==================== 8. 40 条上限：旧汇总要累计，不能当成普通“其他” ====================


def _capped_trip():
    trip, _ = normalize_agent_payload(_crowded_payload(), _request(days=7))
    assert len(trip.warnings) == MAX_TRIP_WARNINGS
    return trip


def _summary_of(warnings):
    summaries = [
        warning for warning in warnings if warning.startswith(WARNING_SUMMARY_PREFIX)
    ]
    assert len(summaries) == 1, warnings
    return summaries[0]


def test_map_warning_after_cap_accumulates_previous_hidden_conflicts():
    """49 条冲突封顶后再加地图超时：旧汇总里的 11 条要继续累计，不能只剩 2 条。"""

    trip = _capped_trip()
    timeout_warning = "地图数据超时（>35 秒）：已保留已生成的文字行程。"

    merged = api_server._with_map_warning(trip, timeout_warning)

    assert len(merged.warnings) == MAX_TRIP_WARNINGS
    summary = _summary_of(merged.warnings)
    assert "另有 12 条提醒" in summary, summary
    assert "时间冲突 12 条" in summary, summary
    assert "第7天" in summary
    assert timeout_warning in merged.warnings
    assert GENERATED_CONTENT_WARNING in merged.warnings


def test_repeated_map_warning_keeps_accumulating_summary():
    """多轮追加地图告警时，累计条数要继续增长，而不是回到 1~2 条。"""

    trip = _capped_trip()
    once = api_server._with_map_warning(
        trip, "地图数据超时（>35 秒）：已保留已生成的文字行程。"
    )
    twice = api_server._with_map_warning(
        once, "地图数据增强失败，已返回不含实时地图数据的行程：模拟错误"
    )

    summary = _summary_of(twice.warnings)
    assert "另有 13 条提醒" in summary, summary
    assert "时间冲突 13 条" in summary, summary
    assert "地图数据超时" in " ".join(twice.warnings)
    assert "地图数据增强失败" in " ".join(twice.warnings)


def test_dedupe_with_existing_summary_is_idempotent():
    trip = _capped_trip()
    assert dedupe_warnings(list(trip.warnings)) == trip.warnings

    merged = api_server._with_map_warning(
        trip, "地图数据超时（>35 秒）：已保留已生成的文字行程。"
    )
    assert dedupe_warnings(list(merged.warnings)) == merged.warnings


def test_corrupted_summary_text_does_not_change_counts():
    """以汇总前缀开头的伪造/损坏文本不能被当成“已省略 N 条”的账本。"""

    trip = _capped_trip()
    forged = (
        WARNING_SUMMARY_PREFIX
        + " 999 条提醒（时间冲突 999 条）未展开；伪造的汇总不能改计数"
    )

    merged = dedupe_warnings(list(trip.warnings) + [forged])

    summary = _summary_of(merged)
    assert "另有 11 条提醒" in summary, summary
    assert "时间冲突 11 条" in summary, summary
    assert "999" not in summary
    assert forged not in merged


def test_no_map_enrich_is_idempotent_after_cap():
    """重复 enrich（无地图密钥）不叠加提醒，仍保留一条汇总。"""

    request = _request(days=7)
    trip = _capped_trip()

    once = run(travel_itinerary.enrich_trip_with_map(trip, request, None))
    twice = run(travel_itinerary.enrich_trip_with_map(once, request, None))

    assert once.warnings == twice.warnings
    assert len(once.warnings) == MAX_TRIP_WARNINGS
    _summary_of(once.warnings)


def test_default_time_disclaimer_names_stops_and_survives_cap():
    """被默认时间填充的站点要指名道姓，并优先保留到 40 条上限里。"""

    payload = _crowded_payload()
    payload["days"][0]["stops"][0]["name"] = "默认时间站"
    payload["days"][0]["stops"][0]["time"] = "早上"

    trip, _ = normalize_agent_payload(payload, _request(days=7))

    disclaimers = [
        warning for warning in trip.warnings if warning.startswith("部分站点 time")
    ]
    assert len(disclaimers) == 1, trip.warnings
    text = disclaimers[0]
    assert "默认时间站" in text
    assert "→09:00" in text
    assert "占位时间" in text
    assert len(trip.warnings) == MAX_TRIP_WARNINGS


def test_field_disclaimer_survives_many_stop_level_map_warnings():
    """几十条站点级地图降级提示不能把“哪些时间是默认值”的说明挤掉。"""

    disclaimer = (
        "部分站点 time 缺失或格式不是 HH:MM，已使用默认时间："
        "第1天 默认时间站→09:00。这些是占位时间，不是模型给出的真实时刻，请确认后调整。"
    )
    map_stops = [
        f"{index} 个站点无法通过高德获取可信坐标，location 保持 null："
        f"景点{index}（未找到可信坐标）。相关路段标记为 unavailable。"
        for index in range(50)
    ]

    warnings = dedupe_warnings([GENERATED_CONTENT_WARNING, disclaimer, *map_stops])

    assert disclaimer in warnings
    assert GENERATED_CONTENT_WARNING in warnings
    summary = _summary_of(warnings)
    assert "地图降级 13 条" in summary, summary


def test_strip_keeps_non_time_summary_counts_before_enrich_recompute():
    """重算时间冲突时，旧汇总里的“其他/地图”隐藏条数不能被一起丢掉。"""

    map_warning = (
        "高德地图 API Key 无效或已过期（错误码 10001），已停止继续请求；"
        "请检查服务端 AMAP_API_KEY 配置。"
    )
    others = [f"普通提醒 {index}" for index in range(39)]
    conflicts = [
        f"{SCHEDULE_CONFLICT_PREFIX}第{day}天 站点{day} 09:00 起停留 120 分钟，"
        "到 11:00 才结束，晚于下一站的时间；两站时间重叠。"
        for day in range(1, 6)
    ]
    capped = dedupe_warnings([GENERATED_CONTENT_WARNING, map_warning, *others, *conflicts])
    assert len(capped) == MAX_TRIP_WARNINGS

    stripped = travel_itinerary._strip_generated_warnings(capped)
    assert not any(
        warning.startswith(SCHEDULE_CONFLICT_PREFIX) for warning in stripped
    ), "重算前应摘掉旧时间冲突"
    assert map_warning in stripped
    assert GENERATED_CONTENT_WARNING in stripped

    recapped = dedupe_warnings(stripped)
    summary = _summary_of(recapped)
    assert "其他 7 条" in summary, summary
    assert map_warning in recapped
    assert dedupe_warnings(recapped) == recapped


# ==================== 9. 占位时间：冲突提醒不得把未知说成事实 ====================


def _placeholder_overlap_stops():
    """第一站 time 不可解析（归一化为 09:00 占位），且停留时长足够造成重叠。"""

    return [
        {"name": "占位起点", "time": "早上", "duration_minutes": 180},
        {"name": "真实下一站", "time": "11:30", "duration_minutes": 60},
    ]


def test_placeholder_time_conflict_does_not_assert_missed_connection():
    trip = run(build_agent_trip(_payload(stops=_placeholder_overlap_stops()), _request(), None))

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 1, trip.warnings
    text = conflicts[0]

    # 占位时间必须显式说明，且不能把“可能重叠”说成确定事实。
    assert PLACEHOLDER_TIME_CAVEAT in text
    assert "按当前时刻表赶不上" not in text
    assert "两站时间重叠" not in text
    assert "未改动站点时间" in text
    assert "第1天" in text and "占位起点-D1" in text and "真实下一站-D1" in text

    # 只提醒，不改源数据。
    assert [stop.time for stop in trip.days[0].stops] == ["09:00", "11:30"]
    assert [stop.duration_minutes for stop in trip.days[0].stops] == [180, 60]


def test_placeholder_pair_and_real_pair_get_different_wording():
    stops = [
        {"name": "占位站", "time": "早上", "duration_minutes": 180},
        {"name": "真实站", "time": "11:30", "duration_minutes": 60},
        {"name": "真实站二", "time": "12:00", "duration_minutes": 60},
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), None))

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 2, trip.warnings

    placeholder_conflicts = [text for text in conflicts if "占位站" in text]
    real_conflicts = [text for text in conflicts if "占位站" not in text]
    assert len(placeholder_conflicts) == 1 and len(real_conflicts) == 1

    assert PLACEHOLDER_TIME_CAVEAT in placeholder_conflicts[0]
    assert "两站时间重叠" not in placeholder_conflicts[0]

    # 两个真实时间的一对保持原有确定性语义。
    assert "两站时间重叠" in real_conflicts[0]
    assert PLACEHOLDER_TIME_CAVEAT not in real_conflicts[0]


def test_two_real_0900_stops_keep_definite_overlap_wording():
    """模型确实给出了 09:00 时不能被一律当占位，否则真实冲突会被降级成猜测。"""

    stops = [
        {"name": "甲", "time": "09:00", "duration_minutes": 120},
        {"name": "乙", "time": "09:00", "duration_minutes": 120},
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), None))

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 1, trip.warnings
    text = conflicts[0]
    assert "两站时间重叠" in text
    assert PLACEHOLDER_TIME_CAVEAT not in text
    assert "未记录时间来源" not in text


def test_placeholder_with_navigation_duration_keeps_caveat():
    """经地图 enrich 成功拿到真实耗时后，占位来源不能被重算弄丢。"""

    stops = [
        {
            "name": "甲",
            "time": "早上",
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
    trip = run(build_agent_trip(_payload(stops=stops), _request(), RouteDurationAMap()))

    assert trip.days[0].legs[0].route_type == "navigation"
    assert trip.days[0].legs[0].duration_minutes == pytest.approx(30.0)

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 1, trip.warnings
    text = conflicts[0]
    assert PLACEHOLDER_TIME_CAVEAT in text
    # 真实导航耗时仍要写出来，但不做“赶不上”的定论。
    assert "约需 30 分钟" in text
    assert "才能抵达" not in text
    assert "按当前时刻表赶不上" not in text


def test_placeholder_conflict_is_idempotent_across_enrich_and_deepcopy():
    request = _request()
    trip = run(build_agent_trip(_payload(stops=_placeholder_overlap_stops()), request, None))

    once = run(travel_itinerary.enrich_trip_with_map(trip, request, None))
    twice = run(travel_itinerary.enrich_trip_with_map(once, request, None))
    assert once.warnings == twice.warnings, "重复 enrich 改变了占位时间的冲突文案"

    cloned = copy.deepcopy(once)
    cloned_enriched = run(travel_itinerary.enrich_trip_with_map(cloned, request, None))
    assert cloned_enriched.warnings == once.warnings, "深拷贝后时间来源丢失"

    copied = once.model_copy()
    copied_enriched = run(travel_itinerary.enrich_trip_with_map(copied, request, None))
    assert copied_enriched.warnings == once.warnings, "model_copy 后时间来源丢失"

    conflicts = _conflict_warnings(once.warnings)
    assert len(conflicts) == 1 and PLACEHOLDER_TIME_CAVEAT in conflicts[0]


def test_pydantic_rebuild_of_placeholder_trip_stays_conservative():
    """经 JSON 往返（TripPlan.model_validate）后私有来源丢失，措辞要保守。"""

    request = _request()
    trip = run(build_agent_trip(_payload(stops=_placeholder_overlap_stops()), request, None))
    rebuilt = travel_itinerary.TripPlan.model_validate(json.loads(trip.model_dump_json()))
    assert rebuilt._time_origins == {}

    enriched = run(travel_itinerary.enrich_trip_with_map(rebuilt, request, None))
    conflicts = _conflict_warnings(enriched.warnings)
    assert len(conflicts) == 1, enriched.warnings
    text = conflicts[0]
    assert PLACEHOLDER_TIME_CAVEAT in text
    assert "具体是哪些站点已无法对应" in text
    assert "按当前时刻表赶不上" not in text
    assert "两站时间重叠" not in text
    # 站点时间仍不被改写。
    assert [stop.time for stop in enriched.days[0].stops] == ["09:00", "11:30"]


def test_time_source_record_is_not_serialized_in_contract():
    """来源记录只能内部使用，不得出现在 schema、model_dump 或响应字段里。"""

    trip = run(build_agent_trip(_payload(stops=_placeholder_overlap_stops()), _request(), None))

    schema_text = json.dumps(travel_itinerary.TripPlan.model_json_schema())
    assert "_time_origins" not in schema_text
    assert "placeholder" not in schema_text

    dump = trip.model_dump()
    assert "_time_origins" not in dump
    assert "_time_origins" not in trip.model_dump_json()
    assert set(dump["days"][0]["stops"][0]) == {
        "id",
        "name",
        "time",
        "duration_minutes",
        "description",
        "address",
        "location",
    }


def test_model_text_cannot_forge_or_hide_placeholder_time():
    """来源只看结构，不看模型写的“占位/真实”字样。"""

    # 真实 09:00，描述里自称占位：不能被降级。
    real_stops = [
        {
            "name": "甲",
            "time": "09:00",
            "duration_minutes": 120,
            "description": f"这些是{PLACEHOLDER_TIME_CAVEAT}（模型写的假标记）",
        },
        {"name": "乙", "time": "09:00", "duration_minutes": 120},
    ]
    real_trip = run(build_agent_trip(_payload(stops=real_stops), _request(), None))
    real_conflicts = _conflict_warnings(real_trip.warnings)
    assert len(real_conflicts) == 1, real_trip.warnings
    assert "两站时间重叠" in real_conflicts[0]
    assert PLACEHOLDER_TIME_CAVEAT not in real_conflicts[0]

    # 占位时间，描述里自称真实：仍然必须是占位措辞。
    placeholder_stops = [
        {
            "name": "占位站",
            "time": "上午",
            "duration_minutes": 180,
            "description": "时间是真实的 09:00，不是占位时间。",
        },
        {"name": "下一站", "time": "11:30", "duration_minutes": 30},
    ]
    placeholder_trip = run(
        build_agent_trip(_payload(stops=placeholder_stops), _request(), None)
    )
    placeholder_conflicts = _conflict_warnings(placeholder_trip.warnings)
    assert len(placeholder_conflicts) == 1, placeholder_trip.warnings
    assert PLACEHOLDER_TIME_CAVEAT in placeholder_conflicts[0]
    assert "两站时间重叠" not in placeholder_conflicts[0]


def _placeholder_crowded_payload():
    return {
        "title": "占位时间拥挤行程",
        "summary": "每天都排满占位时间与重叠站点。",
        "days": [
            {
                "day": day_number,
                "stops": [
                    {
                        "name": f"站点{day_number}-{index}",
                        "time": "早上",
                        "duration_minutes": 120,
                    }
                    for index in range(8)
                ],
            }
            for day_number in range(1, 8)
        ],
    }


def test_placeholder_conflicts_survive_warning_cap_with_summary():
    trip, warnings = normalize_agent_payload(_placeholder_crowded_payload(), _request(days=7))

    assert len(trip.warnings) == MAX_TRIP_WARNINGS
    assert warnings == trip.warnings

    summary = _summary_of(trip.warnings)
    # 多了一条“部分站点 time 已使用默认时间”的字段说明，冲突展示名额相应少一条。
    assert "未展开" in summary and "时间冲突" in summary, summary
    assert "第7天" in summary, summary

    conflicts = _conflict_warnings(trip.warnings)
    assert conflicts
    assert len(conflicts) + 3 == MAX_TRIP_WARNINGS, (
        "40 条里应有 1 条模型提示 + 1 条字段说明 + 1 条汇总行："
        f"{trip.warnings!r}"
    )
    # 展示出来的占位时间冲突全部带说明，且不把重叠说成事实。
    assert all(PLACEHOLDER_TIME_CAVEAT in text for text in conflicts), conflicts
    assert all("两站时间重叠" not in text for text in conflicts), conflicts


def test_api_map_timeout_keeps_placeholder_caveat(client, monkeypatch):
    api_server.planner_agent = FakeAgent(
        json.dumps(_payload(stops=_placeholder_overlap_stops()), ensure_ascii=False)
    )
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server.cfg, "map_enrich_timeout", 0.05)
    _LifecycleOnlyAMap.instances.clear()
    monkeypatch.setattr(api_server, "AMapClient", _LifecycleOnlyAMap)

    async def never_finishes(trip, request, amap):
        await asyncio.Event().wait()

    monkeypatch.setattr(api_server, "enrich_trip_with_map", never_finishes)

    response = client.post(
        "/api/trips/plan",
        json={
            "destination": "杭州",
            "days": 1,
            "departure_date": None,
            "travelers": 1,
            "preferences": "",
            "travel_mode": "walking",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert "_time_origins" not in json.dumps(body)
    assert set(body["days"][0]["stops"][0]) == {
        "id",
        "name",
        "time",
        "duration_minutes",
        "description",
        "address",
        "location",
    }

    trip = travel_itinerary.TripPlan.model_validate(body)
    assert any("地图数据超时" in warning for warning in trip.warnings)
    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 1, trip.warnings
    assert PLACEHOLDER_TIME_CAVEAT in conflicts[0]
    assert "按当前时刻表赶不上" not in conflicts[0]
    assert "两站时间重叠" not in conflicts[0]


# ==================== 10. 来源缺失/旧数据：不得把占位时间说成事实 ====================


def _rebuild_without_private_origins(trip):
    """模拟行程经 JSON 往返重建：公开字段还在，私有来源记录丢失。"""

    rebuilt = travel_itinerary.TripPlan.model_validate(
        json.loads(trip.model_dump_json())
    )
    assert rebuilt._time_origins == {}, "JSON 往返后私有来源记录不应保留"
    return rebuilt


def _without_default_time_disclaimer(trip):
    """模拟旧数据或被上限截断的提醒：连“已使用默认时间”的公开说明也看不到。"""

    return trip.model_copy(
        update={
            "warnings": [
                warning
                for warning in trip.warnings
                if not warning.startswith(
                    travel_itinerary._DEFAULT_TIME_DISCLAIMER_PREFIX
                )
            ]
        }
    )


def test_legacy_trip_without_origins_or_disclaimer_never_asserts_overlap():
    """私有来源和公开默认时间说明都缺失时，不能把 09:00 占位说成已确认时刻。"""

    request = _request()
    trip = run(
        build_agent_trip(_payload(stops=_placeholder_overlap_stops()), request, None)
    )
    legacy = _without_default_time_disclaimer(
        _rebuild_without_private_origins(trip)
    )
    assert not any(
        warning.startswith(travel_itinerary._DEFAULT_TIME_DISCLAIMER_PREFIX)
        for warning in legacy.warnings
    )
    # 模型文本自称“时间是真实的”不能把来源未知洗白成确定事实。
    day = legacy.days[0]
    legacy = legacy.model_copy(
        update={
            "days": [
                day.model_copy(
                    update={
                        "stops": [
                            day.stops[0].model_copy(
                                update={
                                    "description": "这里的 09:00 是真实时间，不是占位时间。"
                                }
                            ),
                            *day.stops[1:],
                        ]
                    }
                )
            ]
        }
    )

    enriched = run(travel_itinerary.enrich_trip_with_map(legacy, request, None))
    conflicts = _conflict_warnings(enriched.warnings)
    assert len(conflicts) == 1, enriched.warnings
    text = conflicts[0]

    # 必须说明来源不可考，并明确这是旧数据无法逐站还原的局限。
    assert UNKNOWN_TIME_SOURCE_CAVEAT in text
    assert "旧数据" in text or "JSON" in text
    assert "两站时间重叠" not in text
    assert "按当前时刻表赶不上" not in text
    assert "按记录时刻" in text and "未改动站点时间" in text

    # 重复增强同样保守，不叠加提醒。
    again = run(travel_itinerary.enrich_trip_with_map(enriched, request, None))
    assert again.warnings == enriched.warnings

    # 只提醒，不改业务数据；私有来源也不得随 dump 泄漏。
    assert [stop.time for stop in enriched.days[0].stops] == ["09:00", "11:30"]
    assert [stop.duration_minutes for stop in enriched.days[0].stops] == [180, 60]
    assert "_time_origins" not in enriched.model_dump()
    assert "_time_origins" not in enriched.model_dump_json()


def test_legacy_trip_without_origins_keeps_next_day_reasoning_with_caveat():
    """来源未知时仍保留“按次日假设”的核对，但先说明时间来源不可考。"""

    stops = [
        {"name": "夜游站", "time": "23:00", "duration_minutes": 30},
        {"name": "早间站", "time": "00:30", "duration_minutes": 30},
    ]
    request = _request()
    trip = run(build_agent_trip(_payload(stops=stops), request, None))
    legacy = _without_default_time_disclaimer(
        _rebuild_without_private_origins(trip)
    )

    enriched = run(travel_itinerary.enrich_trip_with_map(legacy, request, None))
    notices = [
        warning
        for warning in enriched.warnings
        if warning.startswith(SCHEDULE_ORDER_PREFIX)
    ]
    assert len(notices) == 1, enriched.warnings
    text = notices[0]
    assert UNKNOWN_TIME_SOURCE_CAVEAT in text
    assert "按次日假设" in text and "可以衔接" in text
    assert "次日 00:30" in text
    assert "未改动" in text


def test_same_model_ids_across_days_do_not_share_placeholder_state():
    """模型在两天里写同一组 id：归一化重新生成按天唯一的 id，占位归属不串天。"""

    payload = {
        "title": "重复标识行程",
        "summary": "两天都用了同一组模型 id。",
        "days": [
            {
                "day": 1,
                "stops": [
                    {
                        "id": "shared-1",
                        "name": "第一天占位",
                        "time": "早上",
                        "duration_minutes": 180,
                    },
                    {
                        "id": "shared-2",
                        "name": "第一天下一站",
                        "time": "11:30",
                        "duration_minutes": 30,
                    },
                ],
            },
            {
                "day": 2,
                "stops": [
                    {
                        "id": "shared-1",
                        "name": "第二天真实甲",
                        "time": "09:00",
                        "duration_minutes": 120,
                    },
                    {
                        "id": "shared-2",
                        "name": "第二天真实乙",
                        "time": "09:00",
                        "duration_minutes": 120,
                    },
                ],
            },
        ],
    }
    trip, _ = normalize_agent_payload(payload, _request(days=2))

    assert [stop.id for day in trip.days for stop in day.stops] == [
        "stop-d01-01",
        "stop-d01-02",
        "stop-d02-01",
        "stop-d02-02",
    ]
    assert "shared-1" not in trip._time_origins
    assert "shared-2" not in trip._time_origins
    assert trip._time_origins["stop-d01-01"] == "placeholder"
    assert trip._time_origins["stop-d02-01"] == "model"

    day_one = [
        warning
        for warning in trip.warnings
        if warning.startswith(SCHEDULE_CONFLICT_PREFIX) and "第1天" in warning
    ]
    day_two = [
        warning
        for warning in trip.warnings
        if warning.startswith(SCHEDULE_CONFLICT_PREFIX) and "第2天" in warning
    ]
    assert len(day_one) == 1 and len(day_two) == 1, trip.warnings
    assert PLACEHOLDER_TIME_CAVEAT in day_one[0]
    assert "两站时间重叠" not in day_one[0]
    # 第二天的合法 09:00 不能被第一天的占位标记污染成猜测。
    assert "两站时间重叠" in day_two[0]
    assert PLACEHOLDER_TIME_CAVEAT not in day_two[0]
    assert "未记录时间来源" not in day_two[0]


def test_missing_stop_ids_are_generated_per_day_and_never_collide():
    payload = {
        "title": "缺 id 行程",
        "summary": "模型没有给任何站点 id。",
        "days": [
            {
                "day": 1,
                "stops": [
                    {"name": "第一天占位", "time": "早上", "duration_minutes": 180},
                    {"name": "第一天下一站", "time": "11:30", "duration_minutes": 30},
                ],
            },
            {
                "day": 2,
                "stops": [
                    {"name": "第二天甲", "time": "09:00", "duration_minutes": 120},
                    {"name": "第二天乙", "time": "09:00", "duration_minutes": 120},
                ],
            },
        ],
    }
    trip, _ = normalize_agent_payload(payload, _request(days=2))

    stop_ids = [stop.id for day in trip.days for stop in day.stops]
    assert stop_ids == [
        "stop-d01-01",
        "stop-d01-02",
        "stop-d02-01",
        "stop-d02-02",
    ]
    assert len(set(stop_ids)) == len(stop_ids)
    assert set(trip._time_origins) == set(stop_ids)
    assert trip._time_origins["stop-d01-01"] == "placeholder"
    assert trip._time_origins["stop-d02-01"] == "model"


def test_rebuilt_trip_with_default_time_note_cannot_pinpoint_stops():
    """公开说明只列了前几处占位时，不得把未列出的站点当作“确定真实时间”。"""

    payload = {
        "title": "跨天占位行程",
        "summary": "第一天有占位时间，第二天是合法 09:00。",
        "days": [
            {
                "day": 1,
                "stops": [
                    {"name": "占位站", "time": "早上", "duration_minutes": 180},
                    {"name": "占位下一站", "time": "11:30", "duration_minutes": 30},
                ],
            },
            {
                "day": 2,
                "stops": [
                    {"name": "真实甲", "time": "09:00", "duration_minutes": 120},
                    {"name": "真实乙", "time": "09:00", "duration_minutes": 120},
                ],
            },
        ],
    }
    request = _request(days=2)
    trip, _ = normalize_agent_payload(payload, request)
    # 私有来源还在时可以精确定位：第二天保持确定性措辞。
    day_two_before = [
        warning
        for warning in trip.warnings
        if warning.startswith(SCHEDULE_CONFLICT_PREFIX) and "第2天" in warning
    ]
    assert len(day_two_before) == 1
    assert "两站时间重叠" in day_two_before[0]

    rebuilt = _rebuild_without_private_origins(trip)
    enriched = run(travel_itinerary.enrich_trip_with_map(rebuilt, request, None))
    conflicts = _conflict_warnings(enriched.warnings)
    assert len(conflicts) == 2, enriched.warnings
    # 说明只列了部分站点，重建后已无法逐站对应；两天的提醒都改用保守措辞。
    assert all("具体是哪些站点已无法对应" in text for text in conflicts)
    assert all("两站时间重叠" not in text for text in conflicts)


def test_private_origin_survives_public_warning_replacement():
    """model_copy 只替换 warnings 时，私有来源仍在，占位措辞仍能精确到站。"""

    request = _request()
    trip = run(
        build_agent_trip(_payload(stops=_placeholder_overlap_stops()), request, None)
    )
    stripped = trip.model_copy(update={"warnings": []})
    assert stripped._time_origins == trip._time_origins
    assert stripped.model_copy(deep=True)._time_origins == trip._time_origins

    enriched = run(travel_itinerary.enrich_trip_with_map(stripped, request, None))
    conflicts = _conflict_warnings(enriched.warnings)
    assert len(conflicts) == 1, enriched.warnings
    text = conflicts[0]
    assert "占位起点-D1 的 09:00 是占位时间，实际时间待确认" in text
    assert "具体是哪些站点已无法对应" not in text
    assert "两站时间重叠" not in text


def test_failing_map_client_keeps_placeholder_caveat_and_stop_data():
    """假地图客户端整体失败时，重算冲突不能丢掉占位来源，也不能改站点数据。"""

    stops = [
        {
            "name": "占位起点",
            "time": "早上",
            "duration_minutes": 180,
            "address": "杭州市甲路",
        },
        {
            "name": "真实下一站",
            "time": "11:30",
            "duration_minutes": 60,
            "address": "杭州市乙路",
        },
    ]
    trip = run(build_agent_trip(_payload(stops=stops), _request(), FailingAMap()))

    conflicts = _conflict_warnings(trip.warnings)
    assert len(conflicts) == 1, trip.warnings
    text = conflicts[0]
    assert PLACEHOLDER_TIME_CAVEAT in text
    assert "两站时间重叠" not in text
    assert "按当前时刻表赶不上" not in text
    assert [stop.time for stop in trip.days[0].stops] == ["09:00", "11:30"]
    assert [stop.duration_minutes for stop in trip.days[0].stops] == [180, 60]
    assert all(stop.location is None for stop in trip.days[0].stops)


def test_openapi_does_not_expose_private_time_origin(client):
    """OpenAPI 与公开模型字段都不能出现私有来源记录。"""

    response = client.get("/openapi.json")
    assert response.status_code == 200
    text = response.text
    assert "_time_origins" not in text
    assert "placeholder_unknown" not in text

    components = response.json()["components"]["schemas"]
    stop_schemas = [
        schema for name, schema in components.items() if name.startswith("Stop")
    ]
    assert stop_schemas, components.keys()
    for schema in stop_schemas:
        assert set(schema["properties"]) == {
            "id",
            "name",
            "time",
            "duration_minutes",
            "description",
            "address",
            "location",
        }

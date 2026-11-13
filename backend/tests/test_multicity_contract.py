# -*- coding: utf-8 -*-
"""七期 S1 · 多城契约与请求/prompt 窄口径测试。

覆盖：
1. DayPlan.city / Leg.transferKind / TripPlan.cityProfiles 可选往返与 extra=forbid。
2. TripPlan 校验器：跨天 intercity leg 的窄口径豁免与全部拒绝分支。
3. TripPlanRequest.cities：两城/三城合法、重复/天数和/首城/长度非法。
4. stable_trip_id：单城旧钉子不变，多城随城市序列变化。
5. build_agent_prompt：单城逐字节旧形态，多城城市序列 + 禁令 + 第 17 条。
"""

import json

import pytest
from pydantic import ValidationError

from travel_itinerary import (
    CityProfile,
    DayPlan,
    Leg,
    Stop,
    TripPlan,
    TripPlanRequest,
    build_agent_prompt,
    stable_trip_id,
)


# ==================== helpers ====================


def _stop(stop_id: str, name: str | None = None) -> Stop:
    return Stop(id=stop_id, name=name or stop_id, time="09:00")


def _same_day_leg(from_id: str, to_id: str) -> Leg:
    return Leg(
        from_stop_id=from_id,
        to_stop_id=to_id,
        mode="walking",
        route_type="unavailable",
    )


def _intercity_leg(from_id: str, to_id: str, **overrides) -> Leg:
    return Leg(
        from_stop_id=from_id,
        to_stop_id=to_id,
        mode="driving",
        route_type="unavailable",
        transferKind="intercity",
        **overrides,
    )


def _two_city_trip(city_a: str = "杭州", city_b: str = "苏州") -> TripPlan:
    return TripPlan(
        id="trip-multi",
        source="agent",
        destination=city_a,
        days=[
            DayPlan(
                day=1,
                city=city_a,
                stops=[_stop("a"), _stop("b")],
                legs=[_intercity_leg("b", "c")],
            ),
            DayPlan(day=2, city=city_b, stops=[_stop("c")]),
        ],
    )


def _base_request(**overrides) -> dict:
    data = {
        "destination": "杭州",
        "days": 5,
        "departure_date": "2026-05-01",
        "travelers": 2,
        "preferences": "",
        "travel_mode": "walking",
    }
    data.update(overrides)
    return data


# ==================== 1. 可选字段往返 ====================


def test_new_optional_fields_roundtrip():
    trip = _two_city_trip()
    assert trip.days[0].city == "杭州"
    assert trip.days[0].legs[0].transferKind == "intercity"
    assert trip.cityProfiles is None

    payload = trip.model_dump(mode="json")
    rebuilt = TripPlan.model_validate(payload)
    assert rebuilt.days[0].city == "杭州"
    assert rebuilt.days[0].legs[0].transferKind == "intercity"

    with_profile = trip.model_copy(
        update={
            "cityProfiles": {
                "杭州": CityProfile(),
                "苏州": CityProfile(),
            }
        }
    )
    dumped = with_profile.model_dump(mode="json")
    assert set(dumped["cityProfiles"]) == {"杭州", "苏州"}
    assert TripPlan.model_validate(dumped).cityProfiles is not None


def test_legacy_json_without_new_fields_parses():
    legacy = {
        "id": "trip-legacy",
        "source": "agent",
        "destination": "杭州",
        "title": "",
        "summary": "",
        "warnings": [],
        "days": [
            {
                "day": 1,
                "title": "",
                "summary": "",
                "stops": [
                    {"id": "a", "name": "甲", "time": "09:00"},
                    {"id": "b", "name": "乙", "time": "11:00"},
                ],
                "legs": [
                    {
                        "from_stop_id": "a",
                        "to_stop_id": "b",
                        "mode": "walking",
                        "route_type": "unavailable",
                        "description": "",
                    }
                ],
            }
        ],
    }
    trip = TripPlan.model_validate(legacy)
    assert trip.days[0].city is None
    assert trip.days[0].legs[0].transferKind is None
    assert trip.cityProfiles is None


def test_extra_forbid_still_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        DayPlan(day=1, unknown=1)
    with pytest.raises(ValidationError):
        Leg(
            from_stop_id="a",
            to_stop_id="b",
            mode="walking",
            route_type="unavailable",
            unknown=1,
        )
    with pytest.raises(ValidationError):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[DayPlan(day=1, stops=[_stop("a")])],
            unknown=1,
        )
    with pytest.raises(ValidationError):
        DayPlan(day=1, city="")
    with pytest.raises(ValidationError):
        Leg(
            from_stop_id="a",
            to_stop_id="b",
            mode="walking",
            route_type="unavailable",
            transferKind="flight",
        )


def test_city_profiles_capped_at_seven():
    profiles = {f"城市{i}": {} for i in range(8)}
    with pytest.raises(ValidationError):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[DayPlan(day=1, stops=[_stop("a")])],
            cityProfiles=profiles,
        )


# ==================== 2. 跨天 intercity 窄口径 ====================


def test_valid_cross_day_intercity_leg_passes():
    trip = _two_city_trip()
    assert trip.days[0].legs[-1].to_stop_id == "c"


def test_intercity_must_be_last_leg_of_day():
    with pytest.raises(ValidationError):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[
                DayPlan(
                    day=1,
                    city="杭州",
                    stops=[_stop("a"), _stop("b")],
                    legs=[_intercity_leg("b", "c"), _same_day_leg("a", "b")],
                ),
                DayPlan(day=2, city="苏州", stops=[_stop("c")]),
            ],
        )


def test_intercity_must_start_from_last_stop():
    with pytest.raises(ValidationError):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[
                DayPlan(
                    day=1,
                    city="杭州",
                    stops=[_stop("a"), _stop("b")],
                    legs=[_intercity_leg("a", "c")],
                ),
                DayPlan(day=2, city="苏州", stops=[_stop("c")]),
            ],
        )


def test_intercity_must_arrive_at_first_stop_of_next_day():
    with pytest.raises(ValidationError):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[
                DayPlan(
                    day=1,
                    city="杭州",
                    stops=[_stop("a"), _stop("b")],
                    legs=[_intercity_leg("b", "d")],
                ),
                DayPlan(
                    day=2,
                    city="苏州",
                    stops=[_stop("c"), _stop("d")],
                ),
            ],
        )


def test_intercity_forbidden_on_last_day():
    with pytest.raises(ValidationError):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[
                DayPlan(
                    day=1,
                    city="杭州",
                    stops=[_stop("a"), _stop("b")],
                    legs=[_intercity_leg("a", "b")],
                )
            ],
        )


def test_intercity_requires_different_day_cities():
    with pytest.raises(ValidationError):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[
                DayPlan(
                    day=1,
                    city="杭州",
                    stops=[_stop("a"), _stop("b")],
                    legs=[_intercity_leg("b", "c")],
                ),
                DayPlan(day=2, city="杭州", stops=[_stop("c")]),
            ],
        )


def test_intercity_requires_stops_on_both_days():
    with pytest.raises(ValidationError):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[
                DayPlan(
                    day=1,
                    city="杭州",
                    stops=[_stop("a"), _stop("b")],
                    legs=[_intercity_leg("b", "c")],
                ),
                DayPlan(day=2, city="苏州", stops=[]),
            ],
        )


def test_plain_leg_still_cannot_cross_days():
    with pytest.raises(ValidationError, match="leg 引用了当天不存在的站点 id"):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[
                DayPlan(
                    day=1,
                    city="杭州",
                    stops=[_stop("a"), _stop("b")],
                    legs=[_same_day_leg("b", "c")],
                ),
                DayPlan(day=2, city="苏州", stops=[_stop("c")]),
            ],
        )


def test_geometry_rules_also_apply_to_intercity():
    with pytest.raises(ValidationError, match="unavailable 类型不应包含几何点"):
        TripPlan(
            id="t",
            source="agent",
            destination="杭州",
            days=[
                DayPlan(
                    day=1,
                    city="杭州",
                    stops=[_stop("a"), _stop("b")],
                    legs=[
                        _intercity_leg(
                            "b",
                            "c",
                            geometry=[{"lng": 120.0, "lat": 30.0}],
                        )
                    ],
                ),
                DayPlan(day=2, city="苏州", stops=[_stop("c")]),
            ],
        )


# ==================== 3. 请求 cities ====================


def test_cities_accepts_two_and_three_cities():
    two = TripPlanRequest(
        **_base_request(
            cities=[
                {"name": "杭州", "days": 3},
                {"name": "苏州", "days": 2},
            ]
        )
    )
    assert [city.name for city in two.cities] == ["杭州", "苏州"]

    three = TripPlanRequest(
        **_base_request(
            days=5,
            cities=[
                {"name": "杭州", "days": 2},
                {"name": "苏州", "days": 2},
                {"name": "南京", "days": 1},
            ],
        )
    )
    assert sum(city.days for city in three.cities) == 5


def test_city_names_are_stripped():
    request = TripPlanRequest(
        **_base_request(
            cities=[
                {"name": " 杭州 ", "days": 3},
                {"name": " 苏州 ", "days": 2},
            ]
        )
    )
    assert [city.name for city in request.cities] == ["杭州", "苏州"]


@pytest.mark.parametrize(
    "cities",
    [
        [{"name": "杭州", "days": 3}, {"name": "杭州", "days": 2}],
        [{"name": "杭州", "days": 2}, {"name": "苏州", "days": 2}],
        [{"name": "苏州", "days": 3}, {"name": "杭州", "days": 2}],
        [{"name": "杭州", "days": 5}],
        [{"name": "杭州", "days": 3}, {"name": " ", "days": 2}],
    ],
)
def test_invalid_cities_are_rejected(cities):
    with pytest.raises(ValidationError):
        TripPlanRequest(**_base_request(cities=cities))


def test_too_many_cities_rejected():
    cities = [{"name": "杭州", "days": 1}]
    cities.extend({"name": f"城市{i}", "days": 1} for i in range(7))
    with pytest.raises(ValidationError):
        TripPlanRequest(**_base_request(days=7, cities=cities))


def test_default_request_shape_is_unchanged():
    request = TripPlanRequest(**_base_request(days=2, destination="Hangzhou"))
    dumped = json.dumps(request.model_dump(), ensure_ascii=True, sort_keys=True)

    assert dumped == (
        '{"constraints": null, "days": 2, "departure_date": "2026-05-01", '
        '"destination": "Hangzhou", "interests": [], "pace": "balanced", '
        '"preferences": "", "travel_mode": "walking", "travelers": 2}'
    )
    assert "cities" not in dumped


def test_multicity_request_dump_keeps_cities():
    request = TripPlanRequest(
        **_base_request(
            cities=[
                {"name": "杭州", "days": 3},
                {"name": "苏州", "days": 2},
            ]
        )
    )
    assert request.model_dump()["cities"] == [
        {"name": "杭州", "days": 3},
        {"name": "苏州", "days": 2},
    ]


# ==================== 4. stable_trip_id ====================


def test_single_city_trip_id_matches_head_pin():
    request = TripPlanRequest(
        destination="Hangzhou",
        days=2,
        departure_date="2026-05-01",
        travelers=2,
        preferences="quiet lake",
        travel_mode="walking",
    )
    assert stable_trip_id(request) == "trip-agent-f21d434412f1"


def test_multicity_trip_id_differs_from_single_and_by_city_order():
    single = TripPlanRequest(**_base_request())
    two = TripPlanRequest(
        **_base_request(
            cities=[
                {"name": "杭州", "days": 3},
                {"name": "苏州", "days": 2},
            ]
        )
    )
    reordered_days = TripPlanRequest(
        **_base_request(
            cities=[
                {"name": "杭州", "days": 2},
                {"name": "苏州", "days": 3},
            ]
        )
    )
    other_city = TripPlanRequest(
        **_base_request(
            cities=[
                {"name": "杭州", "days": 3},
                {"name": "南京", "days": 2},
            ]
        )
    )

    assert stable_trip_id(two) != stable_trip_id(single)
    assert stable_trip_id(two) != stable_trip_id(reordered_days)
    assert stable_trip_id(two) != stable_trip_id(other_city)
    assert stable_trip_id(two) == stable_trip_id(
        TripPlanRequest(
            **_base_request(
                cities=[
                    {"name": "杭州", "days": 3},
                    {"name": "苏州", "days": 2},
                ]
            )
        )
    )


# ==================== 5. prompt ====================


def test_single_city_prompt_has_no_multicity_content():
    prompt = build_agent_prompt(TripPlanRequest(**_base_request()))
    assert '"cities"' not in prompt
    assert "城际" not in prompt
    assert "联程" not in prompt
    assert "17." not in prompt
    assert "16. 同一天相邻站点尽量就近安排，避免长距离折返；" in prompt
    assert (
        "确实需要跨城区或跨景区转移时，在 description 里简要说明理由。"
        in prompt
    )


def test_single_city_driving_prompt_keeps_old_mode_hint():
    prompt = build_agent_prompt(
        TripPlanRequest(**_base_request(travel_mode="driving"))
    )
    assert "不要安排跨城赶路" in prompt


def test_multicity_prompt_contains_city_sequence_and_bans():
    request = TripPlanRequest(
        **_base_request(
            cities=[
                {"name": "杭州", "days": 3},
                {"name": "苏州", "days": 2},
            ]
        )
    )
    prompt = build_agent_prompt(request)

    assert '"cities": [' in prompt
    assert '"name": "杭州"' in prompt
    assert '"name": "苏州"' in prompt
    assert "本次是 2 城联程：" in prompt
    assert "第1-3天在杭州" in prompt
    assert "第4-5天在苏州" in prompt
    assert "同一城市的日期必须连续，不得把两座城市交错安排" in prompt
    assert "每天只安排一座城市内的站点" in prompt
    assert "不要输出具体车次、班次、时刻表或车站数据" in prompt

    assert "17. 禁止输出具体车次、班次、时刻表、车站数据；" in prompt
    assert "城际转移段只由服务端给距离与建议预留时长（估算），不要自行编造。" in prompt
    assert "城际转移只发生在天与天之间、由服务端生成" in prompt
    assert "城际转移由服务端在天与天之间生成，无需自行安排" in prompt
    assert "不要安排跨城赶路" not in prompt


def test_multicity_prompt_has_no_single_city_cross_district_rule():
    prompt = build_agent_prompt(
        TripPlanRequest(
            **_base_request(
                cities=[
                    {"name": "杭州", "days": 3},
                    {"name": "苏州", "days": 2},
                ]
            )
        )
    )
    assert "确实需要跨城区或跨景区转移时" not in prompt

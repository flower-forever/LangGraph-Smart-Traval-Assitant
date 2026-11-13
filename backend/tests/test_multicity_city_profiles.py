# -*- coding: utf-8 -*-
"""七期 S6 · 多城 cityProfiles 的生成、解析与降级测试。

覆盖：
1. 两城 map 逐城解析 + 主城回退。
2. 三城冒烟。
3. 缺一城 → 只有一份、主城仅按请求首城回退（不补造）。
4. 多余 key 丢弃。
5. 任一份易变事实被裁剪，warning 只追加一条。
6. 单城走旧路径：忽略 cityProfiles、键集合不新增。
7. 多城 prompt 要求每城一份 cityProfiles；单城 prompt 逐字节旧形态。
"""

import os

# 测试进程绝不读取仓库里可能存在的真实 .env。
os.environ["PYTHON_DOTENV_DISABLED"] = "1"

from travel_itinerary import TripPlanRequest, build_agent_prompt, normalize_agent_payload


def make_request(cities=None, days=5, **overrides):
    data = {
        "destination": "杭州",
        "days": days,
        "departure_date": "2026-05-01",
        "travelers": 2,
        "preferences": "quiet lake",
        "travel_mode": "walking",
    }
    if cities is not None:
        data["cities"] = cities
    data.update(overrides)
    return TripPlanRequest(**data)


def make_days(days):
    return [
        {
            "day": day_number,
            "title": f"Day {day_number}",
            "summary": "A day in the city.",
            "stops": [
                {
                    "name": f"Stop {day_number}-1",
                    "time": "09:00",
                    "duration_minutes": 90,
                    "description": "Walk around.",
                    "address": "Somewhere",
                },
                {
                    "name": f"Stop {day_number}-2",
                    "time": "11:00",
                    "duration_minutes": 60,
                    "description": "Tea break.",
                    "address": "Somewhere",
                },
            ],
        }
        for day_number in range(1, days + 1)
    ]


def make_payload(days=5, city_profiles=None, **overrides):
    payload = {
        "title": "Multi-city trip",
        "summary": "A trip across cities.",
        "days": make_days(days),
    }
    if city_profiles is not None:
        payload["cityProfiles"] = city_profiles
    payload.update(overrides)
    return payload


def profile_payload(impression, season_tips=None, classics=None):
    profile = {"oneLineImpression": {"text": impression, "source": "model_generated"}}
    if season_tips is not None:
        profile["seasonTips"] = {"text": season_tips, "source": "model_generated"}
    if classics is not None:
        profile["classicList"] = [
            {"name": name, "reason": f"{name} reason", "source": "model_generated"}
            for name in classics
        ]
    return profile


TWO_CITIES = [{"name": "杭州", "days": 3}, {"name": "苏州", "days": 2}]
THREE_CITIES = [
    {"name": "杭州", "days": 2},
    {"name": "苏州", "days": 2},
    {"name": "南京", "days": 1},
]


# ==================== 解析 ====================


def test_two_city_map_is_parsed_per_city_and_main_falls_back_to_first_city():
    request = make_request(cities=TWO_CITIES, days=5)
    payload = make_payload(
        days=5,
        city_profiles={
            "杭州": profile_payload("湖山相映", classics=["断桥", "灵隐寺"]),
            "苏州": profile_payload("园林与水巷", classics=["拙政园", "虎丘"]),
        },
    )

    trip, _ = normalize_agent_payload(payload, request)

    assert trip.cityProfiles is not None
    assert list(trip.cityProfiles) == ["杭州", "苏州"]
    assert trip.cityProfiles["杭州"].oneLineImpression.text == "湖山相映"
    assert trip.cityProfiles["苏州"].oneLineImpression.text == "园林与水巷"
    assert [item.name for item in trip.cityProfiles["苏州"].classicList] == ["拙政园", "虎丘"]

    # 没有顶层 cityProfile 时，主城画像回退 map 首城。
    assert trip.cityProfile is not None
    assert trip.cityProfile.oneLineImpression.text == "湖山相映"
    # day.city 由请求城市序列确定性分配。
    assert [day.city for day in trip.days] == ["杭州", "杭州", "杭州", "苏州", "苏州"]


def test_three_city_map_smoke():
    request = make_request(cities=THREE_CITIES, days=5)
    payload = make_payload(
        days=5,
        city_profiles={
            "杭州": profile_payload("杭州印象"),
            "苏州": profile_payload("苏州印象"),
            "南京": profile_payload("南京印象"),
        },
    )

    trip, _ = normalize_agent_payload(payload, request)

    assert trip.cityProfiles is not None
    assert list(trip.cityProfiles) == ["杭州", "苏州", "南京"]
    assert trip.cityProfile is not None
    assert trip.cityProfile.oneLineImpression.text == "杭州印象"


def test_missing_city_is_not_fabricated_and_main_only_uses_first_city():
    request = make_request(cities=TWO_CITIES, days=5)

    # 缺苏州：只有杭州一份，主城回退杭州。
    partial, _ = normalize_agent_payload(
        make_payload(days=5, city_profiles={"杭州": profile_payload("杭州印象")}),
        request,
    )
    assert partial.cityProfiles is not None
    assert list(partial.cityProfiles) == ["杭州"]
    assert partial.cityProfile is not None
    assert partial.cityProfile.oneLineImpression.text == "杭州印象"

    # 缺首城：苏州一份保留，但主城不拿苏州顶替。
    missing_main, _ = normalize_agent_payload(
        make_payload(days=5, city_profiles={"苏州": profile_payload("苏州印象")}),
        request,
    )
    assert missing_main.cityProfiles is not None
    assert list(missing_main.cityProfiles) == ["苏州"]
    assert missing_main.cityProfile is None


def test_extra_city_keys_are_dropped():
    request = make_request(cities=TWO_CITIES, days=5)
    payload = make_payload(
        days=5,
        city_profiles={
            "杭州": profile_payload("杭州印象"),
            "苏州": profile_payload("苏州印象"),
            "南京": profile_payload("不应出现"),
            "上海": profile_payload("也不应出现"),
        },
    )

    trip, _ = normalize_agent_payload(payload, request)

    assert trip.cityProfiles is not None
    assert list(trip.cityProfiles) == ["杭州", "苏州"]
    assert "南京" not in trip.cityProfiles
    assert "上海" not in trip.cityProfiles


def test_city_profiles_outside_trip_wrapper_are_tolerated():
    request = make_request(cities=TWO_CITIES, days=5)
    payload = {
        "trip": make_payload(days=5),
        "cityProfiles": {
            "杭州": profile_payload("杭州印象"),
            "苏州": profile_payload("苏州印象"),
        },
    }

    trip, _ = normalize_agent_payload(payload, request)

    assert trip.cityProfiles is not None
    assert list(trip.cityProfiles) == ["杭州", "苏州"]


def test_volatile_text_in_any_profile_is_trimmed_and_warns_once():
    request = make_request(cities=TWO_CITIES, days=5)
    payload = make_payload(
        days=5,
        city_profiles={
            "杭州": profile_payload("杭州印象", season_tips="门票 60 元"),
            "苏州": profile_payload("苏州印象", season_tips="需预约"),
        },
    )

    trip, _ = normalize_agent_payload(payload, request)

    assert trip.cityProfiles is not None
    assert trip.cityProfiles["杭州"].seasonTips is None
    assert trip.cityProfiles["苏州"].seasonTips is None
    assert trip.cityProfiles["杭州"].oneLineImpression.text == "杭州印象"
    assert trip.cityProfiles["苏州"].oneLineImpression.text == "苏州印象"
    city_warnings = [
        warning for warning in trip.warnings if "城市导览中有内容涉及" in warning
    ]
    assert len(city_warnings) == 1


def test_single_city_ignores_city_profiles_and_keeps_old_key_set():
    request = make_request(days=2)
    payload = make_payload(
        days=2,
        city_profiles={"杭州": profile_payload("不应使用")},
    )
    payload["cityProfile"] = {"oneLineImpression": {"text": "单城印象"}}

    trip, _ = normalize_agent_payload(payload, request)

    assert trip.cityProfiles is None
    assert trip.cityProfile is not None
    assert trip.cityProfile.oneLineImpression.text == "单城印象"
    assert set(trip.model_dump()) == {
        "id",
        "source",
        "destination",
        "title",
        "summary",
        "map_coordinate_system",
        "warnings",
        "days",
        "cityProfile",
        "cityProfiles",
    }


# ==================== prompt ====================


def test_multicity_prompt_requires_one_profile_per_requested_city():
    prompt = build_agent_prompt(make_request(cities=TWO_CITIES, days=5))

    assert '  "cityProfiles": {' in prompt
    assert '"<城市名>"' in prompt
    assert "杭州、苏州 每城各写一份" in prompt
    assert "key 必须是请求城市名" in prompt
    assert "cityProfiles 的每一份都禁止输出营业时间、票价、预约政策" in prompt
    assert "cityProfiles 字数软约束对每城每份同样生效" in prompt
    assert '  "cityProfile": {' not in prompt


def test_single_city_prompt_keeps_old_city_profile_rules():
    prompt = build_agent_prompt(make_request(days=2))

    assert '  "cityProfile": {' in prompt
    assert '"cityProfiles"' not in prompt
    assert "10. cityProfile 是城市稳定知识概览" in prompt
    assert "11. cityProfile 中禁止输出营业时间、票价、预约政策" in prompt
    assert "12. cityProfile 字数软约束" in prompt

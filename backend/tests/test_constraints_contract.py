# -*- coding: utf-8 -*-
"""F2 后端 constraints 契约测试（真实 HTTP + fake planner，零真实外网）。

覆盖 docs/WORKSPACE_SIDECAR.md §11.9：省略兼容、初始/整日/后段 scope、
严格字段/上限、map/leg 拒绝、H 级 502 与 U 级 warnings。
"""

import os

os.environ["PYTHON_DOTENV_DISABLED"] = "1"
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import api_server
from day_replan import DayReplanRequest, build_day_replan_prompt
from travel_itinerary import TripPlanRequest, build_agent_prompt


BASE_PLAN = {
    "destination": "杭州",
    "days": 2,
    "departure_date": "2026-11-02",
    "travelers": 2,
    "preferences": "喜欢湖景",
    "travel_mode": "walking",
}

BASE_REPLAN = {
    "destination": "杭州",
    "day": 2,
    "date": "2026-11-02",
    "travel_mode": "walking",
    "instruction": "保留西湖，下午换成室内。",
    "stops": [
        {
            "id": "base-d2-s1",
            "name": "西湖",
            "time": "09:00",
            "duration_minutes": 90,
        },
        {
            "id": "base-d2-s2",
            "name": "浙江省博物馆",
            "time": "13:00",
            "duration_minutes": 120,
        },
    ],
    "parent": {"trip_id": "trip-agent-abc123", "revision": 7},
}


def constraint_item(**overrides):
    item = {
        "id": "constraint-1",
        "kind": "must_visit",
        "day": 1,
        "stop_id": None,
        "title": "博物馆",
        "start_date": None,
        "end_date": None,
        "start_time": None,
        "end_time": None,
        "duration_minutes": None,
        "priority": 1,
    }
    item.update(overrides)
    return item


def constraints(**overrides):
    data = {
        "version": 1,
        "scope": "trip_plan",
        "day": None,
        "anchor_stop_id": None,
        "fingerprint": "a1b2c3d4",
        "items": [constraint_item()],
    }
    data.update(overrides)
    return data


def plan_payload(*, names=("西湖景点1-1", "西湖景点1-2")):
    return {
        "title": "杭州两日",
        "summary": "测试行程。",
        "days": [
            {
                "day": 1,
                "title": "第一天",
                "summary": "当天概述",
                "stops": [
                    {
                        "name": name,
                        "time": "09:00",
                        "duration_minutes": 60,
                        "description": "",
                        "address": "杭州市西湖区",
                    }
                    for name in names
                ],
            },
            {
                "day": 2,
                "title": "第二天",
                "summary": "当天概述",
                "stops": [
                    {
                        "name": "西湖景点2-1",
                        "time": "09:00",
                        "duration_minutes": 60,
                        "description": "",
                        "address": "杭州市西湖区",
                    }
                ],
            },
        ],
    }


def replan_payload(*, names=("西湖", "浙江省博物馆")):
    return {
        "title": "单日",
        "summary": "单日概述",
        "days": [
            {
                "day": 1,
                "title": "当天",
                "summary": "当天概述",
                "stops": [
                    {
                        "name": name,
                        "time": "09:00",
                        "duration_minutes": 60,
                        "description": "",
                        "address": "杭州市西湖区",
                    }
                    for name in names
                ],
            }
        ],
    }


class FakePlanner:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    async def ainvoke(self, payload, config=None):
        self.calls.append((payload, config))
        return {
            "messages": [
                SimpleNamespace(content=json.dumps(self.payload, ensure_ascii=False))
            ]
        }


@pytest.fixture
def client(monkeypatch):
    for name in (
        "DASHSCOPE_API_KEY",
        "AMAP_API_KEY",
        "CORS_ORIGINS",
        "TRIP_REPLAN_TIMEOUT",
        "MAP_ENRICH_TIMEOUT",
        "AMAP_TIMEOUT",
        "CHAT_TIMEOUT",
    ):
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])

    with TestClient(api_server.app) as test_client:
        yield test_client


def post_plan(client, body):
    return client.post("/api/trips/plan", json=body)


def post_replan(client, body):
    return client.post("/api/trips/days/replan", json=body)


# ==================== 初始规划 ====================


def test_plan_omitted_constraints_keeps_old_prompt(client):
    planner = FakePlanner(plan_payload())
    api_server.planner_agent = planner

    response = post_plan(client, BASE_PLAN)

    assert response.status_code == 200, response.text
    prompt = planner.calls[0][0]["messages"][0].content
    assert prompt == build_agent_prompt(TripPlanRequest(**BASE_PLAN))
    assert "<constraints>" not in prompt
    assert not any("约束未核实" in warning for warning in response.json()["warnings"])


def test_plan_constraints_use_structured_prompt_and_keep_user_text(client):
    planner = FakePlanner(plan_payload(names=("博物馆 <script>",)))
    api_server.planner_agent = planner
    body = {
        **BASE_PLAN,
        "preferences": "喜欢湖景 <script>",
        "constraints": constraints(
            items=[constraint_item(kind="reminder", title="提醒 <script>")]
        ),
    }

    response = post_plan(client, body)

    assert response.status_code == 200, response.text
    prompt = planner.calls[0][0]["messages"][0].content
    assert "<constraints>" in prompt
    assert '"scope": "trip_plan"' in prompt
    assert '"title": "提醒 \\u003cscript\\u003e"' in prompt
    assert "喜欢湖景 \\u003cscript\\u003e" in prompt
    assert "8. <constraints>" in prompt
    assert "约束未核实" not in response.text


def test_plan_unknown_top_level_field_is_still_ignored(client):
    planner = FakePlanner(plan_payload())
    api_server.planner_agent = planner

    response = post_plan(client, {**BASE_PLAN, "unknown_top": "ignored"})

    assert response.status_code == 200, response.text
    assert len(planner.calls) == 1


@pytest.mark.parametrize(
    "override",
    [
        {"items": [{**constraint_item(), "notes": "不该接收"}]},
        {"items": [{**constraint_item(), "day": True}]},
        {"items": [{**constraint_item(), "priority": 4}]},
        {"items": [{**constraint_item(), "start_date": "2026-02-30"}]},
    ],
)
def test_plan_constraints_reject_invalid_inner_fields(client, override):
    planner = FakePlanner(plan_payload())
    api_server.planner_agent = planner

    response = post_plan(client, {**BASE_PLAN, "constraints": {**constraints(), **override}})

    assert response.status_code == 422, response.text
    assert planner.calls == []


def test_plan_trip_plan_allows_null_must_visit_stop_but_rejects_non_null(client):
    planner = FakePlanner(plan_payload(names=("博物馆",)))
    api_server.planner_agent = planner

    valid = {
        **BASE_PLAN,
        "constraints": constraints(
            items=[constraint_item(kind="must_visit", day=1, stop_id=None)]
        ),
    }
    response = post_plan(client, valid)
    assert response.status_code == 200, response.text

    invalid = {
        **BASE_PLAN,
        "constraints": constraints(
            items=[constraint_item(kind="must_visit", day=1, stop_id="s1")]
        ),
    }
    response = post_plan(client, invalid)
    assert response.status_code == 422
    assert len(planner.calls) == 1


def test_plan_rejects_wrong_scope_and_tail_anchor(client):
    planner = FakePlanner(plan_payload())
    api_server.planner_agent = planner

    for bad in (
        constraints(scope="day", day=1),
        constraints(scope="day_tail", day=1, anchor_stop_id="s1"),
    ):
        response = post_plan(client, {**BASE_PLAN, "constraints": bad})
        assert response.status_code == 422, response.text
    assert planner.calls == []


def test_plan_rejects_25_items_and_over_16_kib(client):
    planner = FakePlanner(plan_payload())
    api_server.planner_agent = planner

    twenty_five = constraints(items=[constraint_item(id=f"c-{i}") for i in range(25)])
    response = post_plan(client, {**BASE_PLAN, "constraints": twenty_five})
    assert response.status_code == 422

    big_items = [
        constraint_item(id="约" * 200, title="约" * 120, day=1)
        for _ in range(24)
    ]
    response = post_plan(
        client,
        {**BASE_PLAN, "constraints": constraints(items=big_items)},
    )
    assert response.status_code == 422
    assert planner.calls == []


def test_plan_missing_must_visit_is_safe_502(client):
    planner = FakePlanner(plan_payload(names=("西湖景点1-1",)))
    api_server.planner_agent = planner

    response = post_plan(
        client,
        {
            **BASE_PLAN,
            "constraints": constraints(items=[constraint_item(title="不存在的博物馆")]),
        },
    )

    assert response.status_code == 502, response.text
    detail = response.json()["detail"]
    assert "候选未满足硬约束：" in detail
    assert "constraint-1" in detail
    assert "不存在的博物馆" in detail
    assert len(planner.calls) == 1


def test_plan_ambiguous_must_visit_is_u_warning(client):
    planner = FakePlanner(plan_payload(names=("博物馆", "博物馆")))
    api_server.planner_agent = planner

    response = post_plan(
        client,
        {**BASE_PLAN, "constraints": constraints(items=[constraint_item(title="博物馆")])},
    )

    assert response.status_code == 200, response.text
    warnings = response.json()["warnings"]
    assert any(warning.startswith("约束未核实：") for warning in warnings)
    assert all("已满足" not in warning for warning in warnings)


def test_plan_placeholder_time_is_u_not_h(client):
    payload = plan_payload(names=("博物馆",))
    del payload["days"][0]["stops"][0]["time"]
    planner = FakePlanner(payload)
    api_server.planner_agent = planner

    fixed = constraint_item(
        kind="fixed_window",
        day=1,
        title="博物馆",
        start_date="2026-11-02",
        end_date="2026-11-02",
        start_time="14:00",
        end_time="16:00",
        duration_minutes=60,
    )
    response = post_plan(
        client,
        {**BASE_PLAN, "constraints": constraints(items=[fixed])},
    )

    assert response.status_code == 200, response.text
    warnings = response.json()["warnings"]
    assert any("约束未核实：" in warning and "占位" in warning for warning in warnings)
    assert all("已满足" not in warning for warning in warnings)


def test_plan_fixed_window_start_violation_is_safe_502(client):
    payload = plan_payload(names=("博物馆",))
    payload["days"][0]["stops"][0]["time"] = "15:00"
    planner = FakePlanner(payload)
    api_server.planner_agent = planner

    fixed = constraint_item(
        kind="fixed_window",
        day=1,
        title="博物馆",
        start_date="2026-11-02",
        end_date="2026-11-02",
        start_time="14:00",
        end_time="16:00",
        duration_minutes=30,
    )
    response = post_plan(
        client,
        {**BASE_PLAN, "constraints": constraints(items=[fixed])},
    )

    assert response.status_code == 502, response.text
    detail = response.json()["detail"]
    assert "候选未满足硬约束：" in detail
    assert "fixed_window_start_violation" not in detail
    assert "constraint-1" in detail


def test_plan_null_duration_is_u_not_zero(client):
    planner = FakePlanner(plan_payload(names=("博物馆",)))
    api_server.planner_agent = planner

    fixed = constraint_item(
        kind="fixed_window",
        day=1,
        title="博物馆",
        start_date="2026-11-02",
        end_date="2026-11-02",
        start_time="14:00",
        end_time="16:00",
        duration_minutes=None,
    )
    response = post_plan(
        client,
        {**BASE_PLAN, "constraints": constraints(items=[fixed])},
    )

    assert response.status_code == 200, response.text
    warnings = response.json()["warnings"]
    assert any("停留时长为 null" in warning for warning in warnings)


# ==================== 整日 / 后段 replan ====================


def test_replan_omitted_constraints_keeps_old_prompt(client):
    planner = FakePlanner(replan_payload())
    api_server.planner_agent = planner

    response = post_replan(client, BASE_REPLAN)

    assert response.status_code == 200, response.text
    prompt = planner.calls[0][0]["messages"][0].content
    assert prompt == build_day_replan_prompt(DayReplanRequest(**BASE_REPLAN))
    assert "<constraints>" not in prompt
    assert not any("约束未核实" in warning for warning in response.json()["warnings"])


def test_replan_unknown_top_level_field_is_422(client):
    planner = FakePlanner(replan_payload())
    api_server.planner_agent = planner

    response = post_replan(client, {**BASE_REPLAN, "unknown_top": "x"})

    assert response.status_code == 422
    assert planner.calls == []


def test_replan_constraints_inner_unknown_is_422(client):
    planner = FakePlanner(replan_payload())
    api_server.planner_agent = planner

    body = {
        **BASE_REPLAN,
        "constraints": {
            **constraints(scope="day", day=2),
            "items": [{**constraint_item(day=2), "notes": "x"}],
        },
    }
    response = post_replan(client, body)
    assert response.status_code == 422
    assert planner.calls == []


def test_replan_scope_day_and_tail_rules(client):
    planner = FakePlanner(replan_payload(names=("新景点",)))
    api_server.planner_agent = planner

    cases = [
        constraints(scope="trip_plan"),
        constraints(scope="day", day=3),
        constraints(scope="day_tail", day=2, anchor_stop_id=None),
        constraints(scope="day_tail", day=2, anchor_stop_id="missing"),
        constraints(scope="day", day=2, anchor_stop_id="base-d2-s1"),
        {
            **constraints(scope="day", day=2),
            "items": [
                constraint_item(kind="must_visit", day=2, stop_id="missing-stop")
            ],
        },
        {
            **constraints(scope="day", day=2),
            "items": [constraint_item(kind="must_visit", day=None)],
        },
    ]
    for bad in cases:
        response = post_replan(client, {**BASE_REPLAN, "constraints": bad})
        assert response.status_code == 422, (bad, response.text)
    assert planner.calls == []


def test_replan_day_tail_scope_is_explicit_and_anchor_valid(client):
    planner = FakePlanner(replan_payload(names=("新景点",)))
    api_server.planner_agent = planner

    body = {
        **BASE_REPLAN,
        "constraints": {
            **constraints(scope="day_tail", day=2, anchor_stop_id="base-d2-s1"),
            "items": [
                constraint_item(kind="must_visit", day=2, stop_id=None, title="新景点")
            ],
        },
    }
    response = post_replan(client, body)

    assert response.status_code == 200, response.text
    prompt = planner.calls[0][0]["messages"][0].content
    assert '"scope": "day_tail"' in prompt
    assert '"anchor_stop_id": "base-d2-s1"' in prompt
    assert "<constraints>" in prompt
    assert BASE_REPLAN["instruction"] in prompt
    assert "【后段重规划】" not in prompt


def test_replan_missing_must_visit_is_safe_502(client):
    planner = FakePlanner(replan_payload(names=("浙江省博物馆",)))
    api_server.planner_agent = planner

    body = {
        **BASE_REPLAN,
        "constraints": {
            **constraints(scope="day", day=2),
            "items": [
                constraint_item(
                    kind="must_visit", day=2, stop_id="base-d2-s1", title="西湖"
                )
            ],
        },
    }
    response = post_replan(client, body)

    assert response.status_code == 502, response.text
    detail = response.json()["detail"]
    assert "候选未满足硬约束：" in detail
    assert "constraint-1" in detail


def test_replan_day_tail_frozen_target_is_u(client):
    planner = FakePlanner(replan_payload(names=("新景点",)))
    api_server.planner_agent = planner

    body = {
        **BASE_REPLAN,
        "constraints": {
            **constraints(scope="day_tail", day=2, anchor_stop_id="base-d2-s1"),
            "items": [
                constraint_item(
                    kind="must_visit", day=2, stop_id="base-d2-s1", title="西湖"
                )
            ],
        },
    }
    response = post_replan(client, body)

    assert response.status_code == 200, response.text
    warnings = response.json()["warnings"]
    assert any("冻结范围" in warning for warning in warnings)
    assert all("已满足" not in warning for warning in warnings)


# ==================== map / leg 不接受 constraints ====================


def test_map_refresh_rejects_constraints_field(client):
    planner = FakePlanner(plan_payload())
    api_server.planner_agent = planner
    body = {
        "destination": "杭州",
        "day": 2,
        "date": "2026-11-02",
        "travel_mode": "walking",
        "parent": {"trip_id": "trip-local", "revision": 1},
        "stops": [{"id": "s1", "name": "断桥残雪"}],
        "constraints": constraints(),
    }

    response = client.post("/api/trips/days/map-refresh", json=body)

    assert response.status_code == 422
    assert planner.calls == []


def test_leg_refresh_rejects_constraints_field(client):
    planner = FakePlanner(plan_payload())
    api_server.planner_agent = planner
    body = {
        "parent": {"trip_id": "trip-local", "revision": 1},
        "day": 1,
        "date": None,
        "travel_mode": "walking",
        "from_stop": {"id": "a", "location": {"lng": 120.1, "lat": 30.2}},
        "to_stop": {"id": "b", "location": {"lng": 120.2, "lat": 30.3}},
        "constraints": constraints(),
    }

    response = client.post("/api/trips/days/leg-refresh", json=body)

    assert response.status_code == 422
    assert planner.calls == []

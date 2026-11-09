# -*- coding: utf-8 -*-
"""五期 S3 · 规划节奏（pace）定向测试。

覆盖：
1. TripPlanRequest.pace 缺省 = balanced（旧请求不传照常可用，向后兼容）。
2. pace 合法值通过；非法值 422。
3. build_agent_prompt 按节奏给出对应站数/跨度/缓冲/结束时间约束。
4. stable_trip_id 随 pace 变化（不同节奏 = 不同行程），同请求稳定。
5. api_server /api/trips/plan 端到端：不传 pace 走旧行为 prompt；传 pace 生效。
"""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import api_server  # noqa: E402
from travel_itinerary import TripPlanRequest, build_agent_prompt, stable_trip_id  # noqa: E402


def make_request(**overrides):
    data = {
        "destination": "杭州",
        "days": 2,
        "departure_date": "2026-05-01",
        "travelers": 2,
        "preferences": "",
        "travel_mode": "walking",
    }
    data.update(overrides)
    return TripPlanRequest(**data)


# ==================== 1. 向后兼容 ====================

def test_pace_defaults_to_balanced_for_legacy_request():
    request = make_request()
    assert request.pace == "balanced"


def test_pace_accepts_all_three_levels():
    assert make_request(pace="relaxed").pace == "relaxed"
    assert make_request(pace="balanced").pace == "balanced"
    assert make_request(pace="packed").pace == "packed"


def test_pace_rejects_unknown_values():
    for bad in ("fast", "slow", "", "RELAXED", None, True):
        with pytest.raises(ValidationError):
            make_request(pace=bad)


# ==================== 2. prompt 节奏段 ====================

def test_prompt_contains_pace_field_in_user_input():
    prompt = build_agent_prompt(make_request(pace="relaxed"))
    assert '"pace": "relaxed"' in prompt


@pytest.mark.parametrize(
    ("pace", "max_stops", "span", "buffer", "cutoff"),
    [
        ("relaxed", "4 个站点", "不超过 8 小时", "至少留 20 分钟缓冲", "20:00"),
        ("balanced", "6 个站点", "不超过 10 小时", "至少留 15 分钟缓冲", "21:00"),
        ("packed", "8 个站点", "不超过 12 小时", "至少留 10 分钟缓冲", "22:00"),
    ],
)
def test_prompt_pace_hints_differ_by_level(pace, max_stops, span, buffer, cutoff):
    prompt = build_agent_prompt(make_request(pace=pace))
    assert max_stops in prompt
    assert span in prompt
    assert buffer in prompt
    assert cutoff in prompt
    assert "分钟级爆满" in prompt


def test_prompt_meal_windows_and_honesty_rule_present():
    prompt = build_agent_prompt(make_request())
    assert "11:30-13:30" in prompt
    assert "17:30-19:30" in prompt
    assert "45 分钟" in prompt
    assert "不确认沿途是否有餐馆时不要编造用餐地点" in prompt


def test_prompt_otherwise_same_shape_as_before():
    """非 pace 文案不受影响：模式提示、JSON 结构要求仍在。"""
    prompt = build_agent_prompt(make_request())
    assert "步行优先" in prompt
    assert "只输出一个 JSON 对象" in prompt
    assert "只输出 JSON" in prompt


# ==================== 3. stable_trip_id ====================

def test_trip_id_stable_within_same_pace_and_differs_across_pace():
    balanced = stable_trip_id(make_request())
    again = stable_trip_id(make_request())
    relaxed = stable_trip_id(make_request(pace="relaxed"))
    packed = stable_trip_id(make_request(pace="packed"))
    assert balanced == again
    assert balanced != relaxed
    assert balanced != packed
    assert relaxed != packed


# ==================== 4. 端到端：/api/trips/plan ====================

class FakePlanner:
    def __init__(self, content):
        self.content = content
        self.calls = []

    async def ainvoke(self, payload, config=None):
        self.calls.append((payload, config))
        return {"messages": [SimpleNamespace(content=self.content)]}


def plan_payload():
    return {
        "title": "杭州两日",
        "summary": "概述。",
        "days": [
            {
                "day": 1,
                "title": "第一天",
                "summary": "概述",
                "stops": [
                    {
                        "name": "断桥残雪",
                        "time": "09:00",
                        "duration_minutes": 60,
                        "description": "湖景。",
                        "address": "杭州市西湖区白堤",
                    }
                ],
            },
            {
                "day": 2,
                "title": "第二天",
                "summary": "概述",
                "stops": [
                    {
                        "name": "雷峰塔",
                        "time": "10:00",
                        "duration_minutes": 60,
                        "description": "古塔。",
                        "address": "杭州市西湖区南山路",
                    }
                ],
            },
        ],
    }


@pytest.fixture
def client(monkeypatch):
    for name in ("DASHSCOPE_API_KEY", "AMAP_API_KEY", "CORS_ORIGINS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    api_server.cfg = api_server.Configuration()
    api_server.cfg.api_key = None
    api_server.cfg.amap_api_key = None
    api_server.agent = None
    api_server.planner_agent = None
    test_client = TestClient(api_server.app)
    with test_client:
        yield test_client


def test_plan_without_pace_keeps_legacy_prompt(client):
    planner = FakePlanner(json.dumps(plan_payload(), ensure_ascii=False))
    api_server.planner_agent = planner

    body = {
        "destination": "杭州",
        "days": 2,
        "departure_date": None,
        "travelers": 2,
        "preferences": "",
        "travel_mode": "walking",
    }
    response = client.post("/api/trips/plan", json=body)

    assert response.status_code == 200, response.text
    prompt = planner.calls[0][0]["messages"][0].content
    # 旧请求（无 pace）：prompt 按 balanced 生成（等价旧行为），不是报错
    assert '"pace": "balanced"' in prompt
    assert "6 个站点" in prompt


def test_plan_with_pace_uses_requested_level(client):
    planner = FakePlanner(json.dumps(plan_payload(), ensure_ascii=False))
    api_server.planner_agent = planner

    response = client.post(
        "/api/trips/plan",
        json={
            "destination": "杭州",
            "days": 2,
            "departure_date": None,
            "travelers": 2,
            "preferences": "",
            "travel_mode": "walking",
            "pace": "packed",
        },
    )

    assert response.status_code == 200, response.text
    prompt = planner.calls[0][0]["messages"][0].content
    assert '"pace": "packed"' in prompt
    assert "8 个站点" in prompt
    assert "22:00" in prompt


def test_plan_rejects_invalid_pace_with_422(client):
    response = client.post(
        "/api/trips/plan",
        json={
            "destination": "杭州",
            "days": 2,
            "departure_date": None,
            "travelers": 2,
            "preferences": "",
            "travel_mode": "walking",
            "pace": "express",
        },
    )
    assert response.status_code == 422

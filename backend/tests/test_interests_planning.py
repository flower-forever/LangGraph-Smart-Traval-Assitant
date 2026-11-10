# -*- coding: utf-8 -*-
"""五期 S6 · 个性化兴趣（interests）定向测试。

覆盖：
1. TripPlanRequest.interests 缺省 = []（旧请求不传照常可用，向后兼容）。
2. 合法值通过；非法值 422 / ValidationError。
3. build_agent_prompt 把兴趣写进 user_input，并给出「偏好而非硬约束」的说明。
4. 旧请求的提示词与加 interests 之前逐字节一致（user_input 里没有 interests 键）。
5. stable_trip_id 随兴趣变化；旧请求（不传 interests）的 id 与旧算法一致。
6. api_server /api/trips/plan 端到端：不传 interests 走旧行为；传 interests 生效。
"""

import hashlib
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
from travel_itinerary import (  # noqa: E402
    MAX_INTERESTS,
    MAX_INTEREST_LENGTH,
    TripPlanRequest,
    build_agent_prompt,
    stable_trip_id,
)


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


def legacy_trip_id(request: TripPlanRequest) -> str:
    """加 interests 之前的指纹算法：旧请求的 id 必须保持不变。"""

    fingerprint = json.dumps(
        {
            "destination": request.destination,
            "days": request.days,
            "departure_date": request.departure_date,
            "travelers": request.travelers,
            "preferences": request.preferences,
            "travel_mode": request.travel_mode,
            "pace": request.pace,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:12]
    return f"trip-agent-{digest}"


# ==================== 1. 向后兼容 ====================

def test_interests_default_to_empty_list_for_legacy_request():
    request = make_request()
    assert request.interests == []


def test_interests_accept_known_values():
    assert make_request(interests=["history", "food"]).interests == ["history", "food"]


def test_interests_dedupe_preserving_first_occurrence():
    assert make_request(interests=["food", "history", "food"]).interests == ["food", "history"]


def test_interests_reject_invalid_values():
    for bad in (
        "history",          # 不是数组
        ["history", 42],    # 元素不是字符串
        [True],             # 布尔值不是字符串
        [""],               # 空字符串
        ["   "],            # 只有空白
        ["x" * (MAX_INTEREST_LENGTH + 1)],
        ["x"] * (MAX_INTERESTS + 1),
    ):
        with pytest.raises(ValidationError):
            make_request(interests=bad)


def test_interests_none_becomes_empty_list():
    assert make_request(interests=None).interests == []


# ==================== 2. prompt 兴趣段 ====================

def test_prompt_contains_interests_in_user_input():
    prompt = build_agent_prompt(make_request(interests=["history", "food"]))
    assert '"interests"' in prompt
    assert '"history"' in prompt
    assert '"food"' in prompt


def test_prompt_states_interests_are_preference_not_constraint():
    prompt = build_agent_prompt(make_request(interests=["history"]))
    assert "只是偏好" in prompt
    assert "不是硬约束" in prompt
    assert "不要硬塞" in prompt


def test_prompt_for_legacy_request_has_no_interests_key():
    """旧请求（不传 interests）的提示词与加这个字段之前逐字节一致。"""

    prompt = build_agent_prompt(make_request())
    assert '"interests"' not in prompt
    assert "用户勾选的兴趣偏好" not in prompt


def test_prompt_otherwise_keeps_existing_shape():
    prompt = build_agent_prompt(make_request(interests=["nature"]))
    assert "只输出一个 JSON 对象" in prompt
    assert "11:30-13:30" in prompt
    assert '"pace": "balanced"' in prompt


# ==================== 3. stable_trip_id ====================

def test_trip_id_stable_within_same_interests_and_differs_across_interests():
    first = stable_trip_id(make_request(interests=["history"]))
    again = stable_trip_id(make_request(interests=["history"]))
    other = stable_trip_id(make_request(interests=["food"]))
    assert first == again
    assert first != other


def test_legacy_trip_id_unchanged_for_requests_without_interests():
    assert stable_trip_id(make_request()) == legacy_trip_id(make_request())


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


def test_plan_without_interests_keeps_legacy_prompt(client):
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
    assert '"interests"' not in prompt


def test_plan_with_interests_passes_them_to_prompt(client):
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
            "interests": ["history", "food"],
        },
    )

    assert response.status_code == 200, response.text
    prompt = planner.calls[0][0]["messages"][0].content
    assert '"interests"' in prompt
    assert "history" in prompt
    assert "food" in prompt


def test_plan_rejects_invalid_interests_with_422(client):
    response = client.post(
        "/api/trips/plan",
        json={
            "destination": "杭州",
            "days": 2,
            "departure_date": None,
            "travelers": 2,
            "preferences": "",
            "travel_mode": "walking",
            "interests": [42],
        },
    )
    assert response.status_code == 422

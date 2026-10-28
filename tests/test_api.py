# -*- coding: utf-8 -*-
"""FastAPI 接口测试：无密钥启动、示例契约、Agent 注入、错误降级。"""

import asyncio
import json
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import api_server
from travel_itinerary import Coordinate, GeoResult, RouteResult, TripPlan


VALID_REQUEST = {
    "destination": "杭州",
    "days": 2,
    "departure_date": None,
    "travelers": 2,
    "preferences": "喜欢湖景",
    "travel_mode": "walking",
}


def agent_payload(days=2):
    return {
        "title": "杭州两日慢行",
        "summary": "围绕西湖安排的两天行程。",
        "days": [
            {
                "day": day_number,
                "title": f"第{day_number}天",
                "summary": "当天概述",
                "stops": [
                    {
                        "name": f"西湖景点{day_number}-1",
                        "time": "09:00",
                        "duration_minutes": 90,
                        "description": "沿湖散步。",
                        "address": "杭州市西湖区",
                    },
                    {
                        "name": f"西湖景点{day_number}-2",
                        "time": "11:00",
                        "duration_minutes": 60,
                        "description": "看看风景。",
                        "address": "杭州市西湖区",
                    },
                ],
            }
            for day_number in range(1, days + 1)
        ],
    }


class FakeAgent:
    def __init__(self, content=None, error=None):
        self.content = content
        self.error = error
        self.calls = []

    async def ainvoke(self, payload, config=None):
        self.calls.append((payload, config))
        if self.error is not None:
            raise self.error
        return {"messages": [SimpleNamespace(content=self.content)]}


class FakeAMapContext:
    configured = True

    def __init__(self, api_key, *, timeout=6.0):
        self.api_key = api_key
        self.timeout = timeout
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.closed = True

    async def geocode(self, address, *, city=None):
        return GeoResult(
            location=Coordinate(lng=116.397, lat=39.908),
            formatted_address="杭州市示例地址",
        )

    async def search_poi(self, keywords, *, city=None):
        return GeoResult(
            location=Coordinate(lng=116.397, lat=39.908),
            formatted_address="杭州市示例地址",
            name=keywords,
        )

    async def route(self, origin, destination, mode):
        return RouteResult(
            geometry=[
                Coordinate(lng=116.3913, lat=39.9075),
                Coordinate(lng=116.3920, lat=39.9080),
            ],
            distance_m=900,
            duration_minutes=12.0,
        )


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    monkeypatch.delenv("AMAP_API_KEY", raising=False)
    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])

    with TestClient(api_server.app) as test_client:
        yield test_client


def test_example_endpoint_works_without_any_api_key(client):
    response = client.get("/api/trips/example")

    assert response.status_code == 200
    payload = response.json()
    trip = TripPlan.model_validate(payload)
    assert trip.source == "example"
    assert trip.map_coordinate_system == "WGS84"
    assert trip.warnings
    assert len(trip.days) == 3
    assert all(stop.location is not None for day in trip.days for stop in day.stops)


def test_health_reports_degraded_mode_without_keys(client):
    response = client.get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["agent_ready"] is False
    assert payload["planner_ready"] is False
    assert payload["mcp_ready"] is False
    assert payload["amap_configured"] is False
    assert payload["warnings"]


def test_tools_endpoint_is_503_without_mcp(client):
    response = client.get("/tools")
    assert response.status_code == 503
    assert "MCP" in response.json()["detail"]


def test_chat_is_503_without_agent(client):
    response = client.post("/chat", json={"message": "你好", "thread_id": "t1"})
    assert response.status_code == 503
    assert "示例行程" in response.json()["detail"]


def test_chat_still_works_with_injected_agent(client):
    api_server.agent = FakeAgent("你好，我是小途。")
    response = client.post("/chat", json={"message": "你好", "thread_id": "t2"})

    assert response.status_code == 200
    assert response.json()["content"] == "你好，我是小途。"
    assert response.json()["thread_id"] == "t2"


def test_plan_is_503_without_planner_and_never_falls_back_to_chat_agent(client):
    api_server.agent = FakeAgent(json.dumps(agent_payload()))
    response = client.post("/api/trips/plan", json=VALID_REQUEST)

    assert response.status_code == 503
    assert "DASHSCOPE_API_KEY" in response.json()["detail"]


def test_plan_rejects_invalid_contract(client):
    api_server.planner_agent = FakeAgent(json.dumps(agent_payload()))
    response = client.post(
        "/api/trips/plan",
        json={**VALID_REQUEST, "days": 8, "travel_mode": "taxi"},
    )
    assert response.status_code == 422


def test_plan_success_without_amap_returns_honest_degradation(client):
    fake = FakeAgent(json.dumps(agent_payload(), ensure_ascii=False))
    api_server.planner_agent = fake
    api_server.cfg.amap_api_key = None

    response = client.post("/api/trips/plan", json=VALID_REQUEST)

    assert response.status_code == 200
    payload = response.json()
    trip = TripPlan.model_validate(payload)
    assert trip.source == "agent"
    assert len(trip.days) == 2
    assert trip.days[0].stops[0].location is None
    assert trip.days[0].legs[0].route_type == "unavailable"
    assert any("AMAP_API_KEY" in warning for warning in trip.warnings)

    # prompt 里包含目的地，且要求只输出 JSON；用户输入被包裹为数据。
    prompt = fake.calls[0][0]["messages"][0].content
    assert "杭州" in prompt
    assert "<user_input>" in prompt
    assert "只输出一个 JSON 对象" in prompt
    assert fake.calls[0][1]["configurable"]["thread_id"].startswith("trip-")


def test_plan_with_fake_amap_enriches_locations_and_routes(client, monkeypatch):
    fake = FakeAgent(json.dumps(agent_payload(), ensure_ascii=False))
    api_server.planner_agent = fake
    api_server.cfg.amap_api_key = "test-key"
    monkeypatch.setattr(api_server, "AMapClient", FakeAMapContext)

    response = client.post("/api/trips/plan", json=VALID_REQUEST)

    assert response.status_code == 200
    trip = TripPlan.model_validate(response.json())
    assert all(stop.location is not None for day in trip.days for stop in day.stops)
    legs = [leg for day in trip.days for leg in day.legs]
    assert legs
    assert all(leg.route_type == "navigation" for leg in legs)
    assert all(leg.distance_m == 900 for leg in legs)
    assert all(leg.duration_minutes == 12.0 for leg in legs)


def test_plan_502_when_agent_returns_non_json(client):
    api_server.planner_agent = FakeAgent("抱歉，这次没有生成行程。")
    response = client.post("/api/trips/plan", json=VALID_REQUEST)

    assert response.status_code == 502
    assert "结构化行程" in response.json()["detail"]


def test_plan_502_when_agent_raises_and_redacts_secret(client):
    api_server.planner_agent = FakeAgent(error=RuntimeError("upstream failed sk-test-secret"))
    api_server.cfg.api_key = "sk-test-secret"

    response = client.post("/api/trips/plan", json=VALID_REQUEST)

    assert response.status_code == 502
    detail = response.json()["detail"]
    assert "sk-test-secret" not in detail
    assert "***" in detail


def test_plan_504_when_agent_times_out(client):
    class SlowAgent:
        async def ainvoke(self, payload, config=None):
            await asyncio.sleep(0.05)
            return {"messages": [SimpleNamespace(content=json.dumps(agent_payload()))]}

    api_server.planner_agent = SlowAgent()
    api_server.cfg.plan_timeout = 0.001

    response = client.post("/api/trips/plan", json=VALID_REQUEST)
    assert response.status_code == 504
    assert "超时" in response.json()["detail"]


def test_resolve_server_config_falls_back_from_missing_venv_python():
    raw = {
        "weather": {
            "command": ".\\venv\\Scripts\\python.exe",
            "args": ["weather_server.py"],
            "transport": "stdio",
        }
    }
    resolved = api_server._resolve_server_config(raw)

    assert resolved["weather"]["command"] == sys.executable
    assert resolved["weather"]["args"][0].endswith("weather_server.py")
    assert "\\venv\\" not in resolved["weather"]["args"][0]
    # 不修改调用方传入的配置，避免影响其它初始化路径。
    assert raw["weather"]["command"] == ".\\venv\\Scripts\\python.exe"

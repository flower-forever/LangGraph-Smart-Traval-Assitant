# -*- coding: utf-8 -*-
"""地图增强独立超时测试：限时、降级、客户端关闭与配置回退。

全部离线运行：fake Agent 只返回固定 JSON，地图侧使用 fake 客户端或
httpx.MockTransport，不访问真实高德 / DashScope，也不依赖真实 .env。
"""

import asyncio
import json
import math
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

import api_server
import travel_itinerary
from travel_itinerary import TripPlan, TripPlanRequest, build_example_trip


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
    def __init__(self, content):
        self.content = content
        self.calls = []

    async def ainvoke(self, payload, config=None):
        self.calls.append((payload, config))
        return {"messages": [SimpleNamespace(content=self.content)]}


class FakeAMapClient:
    """只记录生命周期，不发起任何网络请求。"""

    instances: list["FakeAMapClient"] = []

    def __init__(self, api_key, *, timeout=6.0):
        self.api_key = api_key
        self.timeout = timeout
        self.entered = False
        self.closed = False
        FakeAMapClient.instances.append(self)

    async def __aenter__(self):
        self.entered = True
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.closed = True


@pytest.fixture
def client(monkeypatch):
    """无密钥启动的测试客户端；进入 lifespan 后再固定易被其它测试污染的配置。"""

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


# ==================== 1. 地图增强超时只降级 ====================


def test_map_enrichment_timeout_keeps_text_plan_and_warns(client, monkeypatch):
    api_server.planner_agent = FakeAgent(
        json.dumps(agent_payload(), ensure_ascii=False)
    )
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server.cfg, "map_enrich_timeout", 0.05)

    FakeAMapClient.instances.clear()
    monkeypatch.setattr(api_server, "AMapClient", FakeAMapClient)

    async def never_finishes(trip, request, amap):
        await asyncio.Event().wait()

    monkeypatch.setattr(api_server, "enrich_trip_with_map", never_finishes)

    started = time.monotonic()
    response = client.post("/api/trips/plan", json=VALID_REQUEST)
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed < 2.0, f"地图超时后仍等待了 {elapsed:.2f}s"

    trip = TripPlan.model_validate(response.json())
    assert trip.source == "agent"
    assert trip.title == "杭州两日慢行"
    assert trip.summary == "围绕西湖安排的两天行程。"
    assert len(trip.days) == 2

    # 模型生成的文字内容原样保留。
    assert [stop.name for day in trip.days for stop in day.stops] == [
        "西湖景点1-1",
        "西湖景点1-2",
        "西湖景点2-1",
        "西湖景点2-2",
    ]
    assert all(
        stop.description == "沿湖散步。" or stop.description == "看看风景。"
        for day in trip.days
        for stop in day.stops
    )

    # 地图没返回就不伪造坐标和路线。
    assert all(stop.location is None for day in trip.days for stop in day.stops)
    legs = [leg for day in trip.days for leg in day.legs]
    assert legs
    assert all(leg.route_type == "unavailable" for leg in legs)
    assert all(leg.geometry == [] for leg in legs)

    # warnings 明确说明地图数据超时，且不谎称拿到了地图数据。
    assert any("地图数据超时" in warning for warning in trip.warnings), trip.warnings
    assert any("已保留" in warning for warning in trip.warnings), trip.warnings

    # 超时取消内部任务时，地图客户端的上下文正常退出。
    assert FakeAMapClient.instances, "地图客户端没有被创建"
    assert all(instance.entered for instance in FakeAMapClient.instances)
    assert all(instance.closed for instance in FakeAMapClient.instances)

    # 模型调用仍然只发生一次，且没有走 504 分支。
    assert len(api_server.planner_agent.calls) == 1


def test_timeout_closes_real_httpx_client(client, monkeypatch):
    """用真实 AMapClient + 挂起的 MockTransport 验证 httpx 客户端被关闭。"""

    created = []
    real_async_client = httpx.AsyncClient

    async def hanging_handler(request):
        await asyncio.Event().wait()

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(hanging_handler)
        http_client = real_async_client(*args, **kwargs)
        created.append(http_client)
        return http_client

    monkeypatch.setattr(travel_itinerary.httpx, "AsyncClient", factory)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
    monkeypatch.setattr(api_server.cfg, "amap_timeout", 30.0)
    monkeypatch.setattr(api_server.cfg, "map_enrich_timeout", 0.05)
    api_server.planner_agent = FakeAgent(
        json.dumps(agent_payload(), ensure_ascii=False)
    )

    started = time.monotonic()
    response = client.post("/api/trips/plan", json=VALID_REQUEST)
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed < 2.0
    assert created, "没有创建 httpx.AsyncClient"
    assert created[0].is_closed is True

    trip = TripPlan.model_validate(response.json())
    assert trip.source == "agent"
    assert all(stop.location is None for day in trip.days for stop in day.stops)
    assert any("地图数据超时" in warning for warning in trip.warnings)


# ==================== 2. 无 key 模式不等待 ====================


def test_no_key_mode_does_not_wrap_enrichment_in_timeout(client, monkeypatch):
    api_server.planner_agent = FakeAgent(
        json.dumps(agent_payload(), ensure_ascii=False)
    )
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    # 故意把地图超时设得比下面的增强还短：如果无 key 分支也套 wait_for，就会误判超时。
    monkeypatch.setattr(api_server.cfg, "map_enrich_timeout", 0.01)

    FakeAMapClient.instances.clear()
    monkeypatch.setattr(api_server, "AMapClient", FakeAMapClient)
    seen = {}

    async def direct_enrich(trip, request, amap):
        seen["amap"] = amap
        await asyncio.sleep(0.05)
        return trip.model_copy(
            update={"warnings": list(trip.warnings) + ["NO_KEY_DIRECT_CALL"]}
        )

    monkeypatch.setattr(api_server, "enrich_trip_with_map", direct_enrich)

    started = time.monotonic()
    response = client.post("/api/trips/plan", json=VALID_REQUEST)
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed < 1.0
    assert seen["amap"] is None
    assert FakeAMapClient.instances == []

    trip = TripPlan.model_validate(response.json())
    assert "NO_KEY_DIRECT_CALL" in trip.warnings
    assert not any("地图数据超时" in warning for warning in trip.warnings)


# ==================== 3. 外层取消不被吞掉 ====================


def test_outer_cancellation_is_not_swallowed(monkeypatch):
    async def scenario():
        monkeypatch.setattr(api_server.cfg, "amap_api_key", "test-map-key")
        monkeypatch.setattr(api_server.cfg, "map_enrich_timeout", 30.0)
        monkeypatch.setattr(api_server, "AMapClient", FakeAMapClient)
        FakeAMapClient.instances.clear()

        async def never_finishes(trip, request, amap):
            await asyncio.Event().wait()

        monkeypatch.setattr(api_server, "enrich_trip_with_map", never_finishes)

        request = TripPlanRequest(destination="北京", days=1)
        task = asyncio.create_task(
            api_server._apply_map_enrichment(build_example_trip(), request)
        )
        await asyncio.sleep(0.02)
        assert not task.done()

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert FakeAMapClient.instances
        assert FakeAMapClient.instances[0].closed

    asyncio.run(scenario())


# ==================== 4. 非超时的地图失败：可读且不泄露密钥 ====================


def test_map_failure_keeps_text_plan_and_redacts_secret(client, monkeypatch):
    api_server.planner_agent = FakeAgent(
        json.dumps(agent_payload(), ensure_ascii=False)
    )
    monkeypatch.setattr(api_server.cfg, "api_key", "sk-test-secret")
    monkeypatch.setattr(api_server.cfg, "amap_api_key", "amap-secret-key")
    monkeypatch.setattr(api_server.cfg, "map_enrich_timeout", 5.0)

    class ExplodingAMap(FakeAMapClient):
        async def __aenter__(self):
            raise RuntimeError("upstream failed with amap-secret-key")

    monkeypatch.setattr(api_server, "AMapClient", ExplodingAMap)

    response = client.post("/api/trips/plan", json=VALID_REQUEST)

    assert response.status_code == 200
    trip = TripPlan.model_validate(response.json())
    assert trip.source == "agent"
    assert len(trip.days) == 2
    assert all(stop.location is None for day in trip.days for stop in day.stops)

    warning = next(
        warn for warn in trip.warnings if "地图数据增强失败" in warn
    )
    assert "amap-secret-key" not in warning
    assert "sk-test-secret" not in warning
    assert "***" in warning


# ==================== 5. 配置回退 ====================


@pytest.mark.parametrize(
    "raw",
    [None, "", "   ", "abc", "0", "-3", "-0.1", "nan", "NaN", "inf", "-inf", "1e309"],
)
def test_map_enrich_timeout_falls_back_to_default(monkeypatch, raw):
    if raw is None:
        monkeypatch.delenv("MAP_ENRICH_TIMEOUT", raising=False)
    else:
        monkeypatch.setenv("MAP_ENRICH_TIMEOUT", raw)

    value = api_server.Configuration().map_enrich_timeout

    assert value == api_server.DEFAULT_MAP_ENRICH_TIMEOUT
    assert math.isfinite(value)
    assert value > 0


def test_map_enrich_timeout_default_is_reasonable():
    assert 30.0 <= api_server.DEFAULT_MAP_ENRICH_TIMEOUT <= 45.0
    assert math.isfinite(api_server.DEFAULT_MAP_ENRICH_TIMEOUT)


def test_map_enrich_timeout_honors_valid_override(monkeypatch):
    monkeypatch.setenv("MAP_ENRICH_TIMEOUT", " 37.5 ")

    assert api_server.Configuration().map_enrich_timeout == 37.5

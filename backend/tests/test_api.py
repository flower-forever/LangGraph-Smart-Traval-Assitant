# -*- coding: utf-8 -*-
"""FastAPI 接口测试：无密钥启动、示例契约、Agent 注入、错误降级、CORS 与超时。"""

import os

# 测试进程绝不读取仓库里可能存在的真实 .env（python-dotenv 认这个开关）。
# 必须在 import api_server 之前设置：模块导入时就会执行 load_dotenv()。
os.environ["PYTHON_DOTENV_DISABLED"] = "1"

import asyncio
import json
import sys
from contextlib import contextmanager
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
    for name in (
        "DASHSCOPE_API_KEY",
        "AMAP_API_KEY",
        "CORS_ORIGINS",
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


@contextmanager
def fresh_client(
    monkeypatch,
    *,
    base_url: str = "http://testserver",
    cors_origins=None,
    chat_timeout=None,
):
    """用指定环境变量启动一个独立 lifespan 的客户端。

    ``cors_origins=None`` 表示删除该变量（走默认来源）；其它值按原样写入，
    用于验证合法/非法配置。客户端进入时 lifespan 会重新读取配置。
    """
    for name in (
        "DASHSCOPE_API_KEY",
        "AMAP_API_KEY",
        "CORS_ORIGINS",
        "CHAT_TIMEOUT",
    ):
        monkeypatch.delenv(name, raising=False)
    if cors_origins is not None:
        monkeypatch.setenv("CORS_ORIGINS", cors_origins)
    if chat_timeout is not None:
        monkeypatch.setenv("CHAT_TIMEOUT", str(chat_timeout))

    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])

    with TestClient(api_server.app, base_url=base_url) as test_client:
        yield test_client


class RecordingAsyncSaver:
    """记录删除调用的假 checkpointer。"""

    def __init__(self):
        self.calls: list[str] = []

    async def adelete_thread(self, thread_id: str) -> None:
        self.calls.append(thread_id)


class SlowChatAgent:
    """慢速聊天 Agent；记录自身是否因 wait_for 超时被取消。"""

    def __init__(self, delay: float = 0.05):
        self.delay = delay
        self.calls = []
        self.cancelled = False

    async def ainvoke(self, payload, config=None):
        self.calls.append((payload, config))
        try:
            await asyncio.sleep(self.delay)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return {"messages": [SimpleNamespace(content="迟到的回复")]}


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


# ==================== 4. 浏览器来源保护：配置解析 ====================


def test_default_cors_origins_cover_dev_and_preview_ports(monkeypatch):
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    config = api_server.Configuration()

    assert config.cors_config_state == api_server.CORS_CONFIG_DEFAULT
    assert config.cors_origins == list(api_server.DEFAULT_CORS_ORIGINS)
    assert config.cors_warnings == []
    assert "*" not in config.cors_origins
    for port in (5173, 5181, 5182):
        assert f"http://127.0.0.1:{port}" in config.cors_origins
        assert f"http://localhost:{port}" in config.cors_origins


def test_cors_origins_env_normalizes_and_dedupes(monkeypatch):
    monkeypatch.setenv(
        "CORS_ORIGINS",
        " HTTPS://Travel.Example.com/ , http://127.0.0.1:4321 , "
        "https://travel.example.com:443 ",
    )
    config = api_server.Configuration()

    assert config.cors_config_state == api_server.CORS_CONFIG_CUSTOM
    assert config.cors_origins == [
        "https://travel.example.com",
        "http://127.0.0.1:4321",
    ]


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        ",",
        "*",
        "https://*.example.com",
        "https://user:pass@example.com",
        "https://example.com/path",
        "https://example.com?x=1",
        "https://example.com#frag",
        "ftp://example.com",
        "example.com:5173",
        "http://",
        "https://example.com:0",
        "https://example.com:99999",
        "http://999.999.999.999:5173",
        "http://exa mple.com",
        "http://[::1",
    ],
)
def test_invalid_cors_config_fails_closed(monkeypatch, raw):
    monkeypatch.setenv("CORS_ORIGINS", raw)
    config = api_server.Configuration()

    assert config.cors_origins == []
    assert config.cors_config_state == api_server.CORS_CONFIG_FAIL_CLOSED
    assert config.cors_warnings
    assert any("fail-closed" in warning for warning in config.cors_warnings)


def test_one_invalid_cors_entry_rejects_entire_config(monkeypatch):
    monkeypatch.setenv(
        "CORS_ORIGINS", "http://127.0.0.1:5173,https://example.com/app"
    )
    config = api_server.Configuration()

    assert config.cors_origins == []
    assert config.cors_config_state == api_server.CORS_CONFIG_FAIL_CLOSED


def test_cors_warning_does_not_echo_raw_config(monkeypatch):
    secret = "super-secret-token"
    monkeypatch.setenv(
        "CORS_ORIGINS", f"https://user:{secret}@evil.example/callback"
    )
    config = api_server.Configuration()

    text = " ".join(config.cors_warnings)
    assert secret not in text
    assert "evil.example" not in text


# ==================== 5. 浏览器来源保护：预检与写请求 ====================


def test_malicious_origin_preflight_is_rejected(client):
    fake = FakeAgent("不会被调用")
    api_server.agent = fake

    response = client.options(
        "/chat",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 400
    assert response.headers.get("access-control-allow-origin") is None
    assert fake.calls == []


def test_trusted_origin_preflight_returns_explicit_origin(client):
    origin = "http://127.0.0.1:5173"

    response = client.options(
        "/chat",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-origin"] != "*"
    assert response.headers["access-control-allow-credentials"] == "true"
    allow_methods = response.headers["access-control-allow-methods"]
    assert "POST" in allow_methods
    assert "DELETE" in allow_methods


@pytest.mark.parametrize(
    "origin",
    [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5181",
        "http://localhost:5181",
        "http://127.0.0.1:5182",
        "http://localhost:5182",
    ],
)
def test_default_local_origin_can_use_chat(client, origin):
    fake = FakeAgent("你好，我是小途。")
    api_server.agent = fake

    response = client.post(
        "/chat",
        json={"message": "你好", "thread_id": "cors-ok"},
        headers={"Origin": origin},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-origin"] != "*"
    assert len(fake.calls) == 1


def test_malicious_origin_cannot_trigger_chat(client):
    fake = FakeAgent("不会被调用")
    api_server.agent = fake

    response = client.post(
        "/chat",
        json={"message": "你好"},
        headers={"Origin": "https://evil.example"},
    )

    assert response.status_code == 403
    assert fake.calls == []
    assert "evil.example" not in response.text


def test_malicious_origin_cannot_trigger_plan(client):
    planner = FakeAgent(json.dumps(agent_payload(), ensure_ascii=False))
    api_server.planner_agent = planner

    response = client.post(
        "/api/trips/plan",
        json=VALID_REQUEST,
        headers={"Origin": "http://127.0.0.1:9999"},
    )

    assert response.status_code == 403
    assert planner.calls == []


def test_trusted_origin_can_use_plan(client):
    planner = FakeAgent(json.dumps(agent_payload(), ensure_ascii=False))
    api_server.planner_agent = planner

    response = client.post(
        "/api/trips/plan",
        json=VALID_REQUEST,
        headers={"Origin": "http://localhost:5182"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5182"
    assert len(planner.calls) == 1
    assert TripPlan.model_validate(response.json()).source == "agent"


def test_malicious_origin_cannot_delete_history(client):
    saver = RecordingAsyncSaver()
    api_server.agent = SimpleNamespace(checkpointer=saver)

    response = client.delete(
        "/chat/thread-evil", headers={"Origin": "https://evil.example"}
    )

    assert response.status_code == 403
    assert saver.calls == []
    assert "evil.example" not in response.text


def test_trusted_origin_can_delete_history(client):
    saver = RecordingAsyncSaver()
    api_server.agent = SimpleNamespace(checkpointer=saver)

    response = client.delete(
        "/chat/thread-trusted",
        headers={"Origin": "http://127.0.0.1:5181"},
    )

    assert response.status_code == 200
    assert response.json()["deleted"] is True
    assert saver.calls == ["thread-trusted"]


def test_cli_requests_without_origin_keep_working(client):
    chat_agent = FakeAgent("无 Origin 正常")
    api_server.agent = chat_agent
    assert client.post("/chat", json={"message": "你好"}).status_code == 200

    planner = FakeAgent(json.dumps(agent_payload(), ensure_ascii=False))
    api_server.planner_agent = planner
    assert client.post("/api/trips/plan", json=VALID_REQUEST).status_code == 200

    saver = RecordingAsyncSaver()
    api_server.agent = SimpleNamespace(checkpointer=saver)
    assert client.delete("/chat/thread-cli").status_code == 200
    assert saver.calls == ["thread-cli"]


def test_custom_cors_origin_from_env_is_trusted(monkeypatch):
    with fresh_client(
        monkeypatch,
        cors_origins=" https://travel.example.com , http://127.0.0.1:4321/ ",
    ) as test_client:
        assert api_server.cfg.cors_origins == [
            "https://travel.example.com",
            "http://127.0.0.1:4321",
        ]
        fake = FakeAgent("自定义来源")
        api_server.agent = fake

        allowed = test_client.post(
            "/chat",
            json={"message": "你好"},
            headers={"Origin": "https://travel.example.com"},
        )
        assert allowed.status_code == 200
        assert (
            allowed.headers["access-control-allow-origin"]
            == "https://travel.example.com"
        )

        # 显式覆盖后，默认来源不再自动信任。
        blocked = test_client.post(
            "/chat",
            json={"message": "你好"},
            headers={"Origin": "http://127.0.0.1:5173"},
        )
        assert blocked.status_code == 403
        assert len(fake.calls) == 1


def test_invalid_cors_config_fails_closed_for_browser_but_not_cli(monkeypatch):
    with fresh_client(
        monkeypatch,
        cors_origins="https://user:super-secret@evil.example/callback",
    ) as test_client:
        fake = FakeAgent("不会被调用")
        api_server.agent = fake

        blocked = test_client.post(
            "/chat",
            json={"message": "你好"},
            headers={"Origin": "http://127.0.0.1:5173"},
        )
        assert blocked.status_code == 403
        assert blocked.headers.get("access-control-allow-origin") is None
        assert fake.calls == []
        assert "super-secret" not in blocked.text

        # 无 Origin 的 CLI 调用不受浏览器来源配置影响。
        cli = test_client.post("/chat", json={"message": "你好"})
        assert cli.status_code == 200

        health = test_client.get("/health").json()
        warnings_text = " ".join(health["warnings"])
        assert "CORS_ORIGINS" in warnings_text
        assert "fail-closed" in warnings_text
        assert "super-secret" not in warnings_text
        assert "https://user:" not in warnings_text


def test_blank_cors_origins_env_fails_closed(monkeypatch):
    with fresh_client(monkeypatch, cors_origins="   ") as test_client:
        assert api_server.cfg.cors_origins == []
        fake = FakeAgent("不会被调用")
        api_server.agent = fake

        blocked = test_client.post(
            "/chat",
            json={"message": "你好"},
            headers={"Origin": "http://127.0.0.1:5173"},
        )
        assert blocked.status_code == 403
        assert fake.calls == []

        cli = test_client.post("/chat", json={"message": "你好"})
        assert cli.status_code == 200


@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:8000"])
def test_loopback_same_origin_docs_can_call_chat(monkeypatch, host):
    """同源 Swagger UI（127.0.0.1/localhost 监听端口）发起的写请求应能通过。"""

    with fresh_client(monkeypatch, base_url=f"http://{host}") as test_client:
        fake = FakeAgent("同源调用")
        api_server.agent = fake

        response = test_client.post(
            "/chat",
            json={"message": "你好"},
            headers={"Origin": f"http://{host}"},
        )

        assert response.status_code == 200, response.text
        assert len(fake.calls) == 1


def test_loopback_origin_with_other_port_is_not_same_origin(monkeypatch):
    with fresh_client(monkeypatch, base_url="http://127.0.0.1:8000") as test_client:
        fake = FakeAgent("不会被调用")
        api_server.agent = fake

        response = test_client.post(
            "/chat",
            json={"message": "你好"},
            headers={"Origin": "http://127.0.0.1:8001"},
        )

        assert response.status_code == 403
        assert fake.calls == []


def test_options_without_origin_is_not_a_preflight(client):
    fake = FakeAgent("不会被调用")
    api_server.agent = fake

    response = client.options("/chat")

    assert response.status_code == 405
    assert fake.calls == []


# ==================== 6. /chat 输入限制与超时 ====================


def test_chat_timeout_default_is_120_seconds(monkeypatch):
    monkeypatch.delenv("CHAT_TIMEOUT", raising=False)

    assert api_server.DEFAULT_CHAT_TIMEOUT == 120.0
    assert api_server.Configuration().chat_timeout == 120.0


def test_chat_timeout_honors_positive_override(monkeypatch):
    monkeypatch.setenv("CHAT_TIMEOUT", " 90.5 ")

    assert api_server.Configuration().chat_timeout == 90.5


@pytest.mark.parametrize(
    "raw",
    ["", "   ", "abc", "0", "-1", "-0.001", "nan", "NaN", "inf", "-inf", "1e309"],
)
def test_chat_timeout_invalid_falls_back_to_default(monkeypatch, raw):
    monkeypatch.setenv("CHAT_TIMEOUT", raw)

    assert (
        api_server.Configuration().chat_timeout
        == api_server.DEFAULT_CHAT_TIMEOUT
    )


def test_chat_rejects_empty_and_overlong_message_without_calling_agent(client):
    fake = FakeAgent("不会被调用")
    api_server.agent = fake

    assert client.post("/chat", json={"message": ""}).status_code == 422
    assert client.post("/chat", json={"message": "x" * 4001}).status_code == 422
    assert client.post("/chat", json={}).status_code == 422
    assert fake.calls == []


def test_chat_accepts_message_at_limit_and_keeps_thread_id_compat(client):
    fake = FakeAgent("边界值")
    api_server.agent = fake

    response = client.post(
        "/chat", json={"message": "x" * 4000, "thread_id": "t-limit"}
    )
    assert response.status_code == 200
    assert response.json()["thread_id"] == "t-limit"
    assert len(fake.calls) == 1
    assert len(fake.calls[0][0]["messages"][0].content) == 4000

    default_thread = client.post("/chat", json={"message": "你好"})
    assert default_thread.status_code == 200
    assert default_thread.json()["thread_id"] == "default"
    assert fake.calls[1][1]["configurable"]["thread_id"] == "default"


def test_chat_504_when_agent_times_out(client, monkeypatch):
    slow = SlowChatAgent(delay=0.05)
    api_server.agent = slow
    monkeypatch.setattr(api_server.cfg, "chat_timeout", 0.001)

    response = client.post("/chat", json={"message": "你好"})

    assert response.status_code == 504
    assert "超时" in response.json()["detail"]
    assert slow.cancelled is True


def test_chat_outer_cancellation_is_not_swallowed(monkeypatch):
    async def scenario():
        class WaitingAgent:
            def __init__(self):
                self.cancelled = False

            async def ainvoke(self, payload, config=None):
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.cancelled = True
                    raise

        waiter = WaitingAgent()
        monkeypatch.setattr(api_server, "agent", waiter)
        monkeypatch.setattr(api_server.cfg, "chat_timeout", 30.0)

        task = asyncio.create_task(
            api_server.chat_endpoint(api_server.ChatRequest(message="你好"))
        )
        await asyncio.sleep(0.02)
        assert not task.done()

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert waiter.cancelled is True

    asyncio.run(scenario())


def test_chat_500_redacts_configured_secret(client, monkeypatch):
    monkeypatch.setattr(api_server.cfg, "api_key", "sk-chat-secret")
    api_server.agent = FakeAgent(
        error=RuntimeError("upstream failed sk-chat-secret")
    )

    response = client.post("/chat", json={"message": "你好"})

    assert response.status_code == 500
    assert "sk-chat-secret" not in response.text
    assert "***" in response.json()["detail"]


# ==================== 7. 错误信息脱敏：引号 / JSON / URL ====================


def assert_secret_fully_masked(text: str, secret: str) -> None:
    """不只检查完整密钥：逐段确认没有留下可拼出密钥的片段。"""

    assert secret not in text, text
    midpoint = len(secret) // 2
    for fragment in (secret[:midpoint], secret[midpoint:]):
        assert fragment not in text, f"密钥片段泄露：{fragment!r} / {text!r}"


@pytest.mark.parametrize(
    ("template", "secret", "kept"),
    [
        (
            'upstream rejected body {"apiKey":"{secret}","model":"qwen-plus"}',
            "sk-syn-json-Zq7Lm2Xk9P",
            ('"apiKey"', "qwen-plus"),
        ),
        (
            "config {'api_key': '{secret}'} is invalid",
            "sk-syn-single-4Lp8RtVb2N",
            ("api_key", "invalid"),
        ),
        (
            "auth failed: api_key={secret}",
            "sk-syn-eq-8Wm3Hs6T",
            ("auth failed",),
        ),
        (
            "GET https://api.example.com/v1?api_key={secret}&model=qwen-plus failed",
            "sk-syn-url-3Yk9Jd5F",
            ("api.example.com", "model=qwen-plus"),
        ),
        (
            "upstream ?key={secret}&city=hz",
            "syn-bare-key-7Ty3Nm5R",
            ("city=hz",),
        ),
        (
            'callback ?key="{secret}"&city=hz',
            "syn-quoted-bare-key-2Pw8Kd4S",
            ("city=hz",),
        ),
        (
            '{"API_KEY":"{secret}"}',
            "sk-syn-case-2Rf6Bg9M",
            ("API_KEY",),
        ),
        (
            'callback {"token": "{secret}", "page": 2}',
            "sk-syn-token-5Nx7Kp4D",
            ('"token"', '"page": 2'),
        ),
    ],
)
def test_safe_error_masks_common_secret_fields(template, secret, kept):
    text = api_server._safe_error(RuntimeError(template.replace("{secret}", secret)))

    assert_secret_fully_masked(text, secret)
    assert "***" in text
    for piece in kept:
        assert piece in text, f"可读信息被误删：{piece!r} / {text!r}"


@pytest.mark.parametrize(
    "secret",
    ["alpha beta gamma delta", "pass word with spaces"],
)
def test_safe_error_masks_quoted_values_containing_spaces(secret):
    text = api_server._safe_error(
        RuntimeError(f'config {{"password": "{secret}", "mode": "strict"}}')
    )

    assert_secret_fully_masked(text, secret)
    assert text == 'config {"password": "***", "mode": "strict"}'


def test_safe_error_masks_truncated_quoted_value():
    """错误文本被截断、引号没闭合时也不能漏出剩余片段。"""

    text = api_server._safe_error(RuntimeError('body {"apiKey":"truncated-secret-9wK2'))

    assert_secret_fully_masked(text, "truncated-secret-9wK2")
    assert text == 'body {"apiKey":"***'


def test_safe_error_masks_configured_keys(monkeypatch):
    chat_secret = "sk-cfg-chat-7Hq2Wn"
    map_secret = "amap-cfg-4Lp8Rt"
    monkeypatch.setattr(api_server.cfg, "api_key", chat_secret)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", map_secret)

    text = api_server._safe_error(
        RuntimeError(f"chat key {chat_secret}; map key {map_secret}")
    )

    assert_secret_fully_masked(text, chat_secret)
    assert_secret_fully_masked(text, map_secret)
    assert text.count("***") == 2


def test_safe_error_keeps_non_sensitive_diagnostics_readable():
    message = "upstream 502 after 3 retries; request id=abc-123; model qwen-plus"
    assert api_server._safe_error(RuntimeError(message)) == message

    # 单词内部的 key= 不算凭据字段，避免把普通文本一并抹掉。
    assert (
        api_server._safe_error(RuntimeError("monkey=banana; tokens=42"))
        == "monkey=banana; tokens=42"
    )


def test_safe_error_falls_back_to_exception_type_when_message_empty():
    assert api_server._safe_error(RuntimeError("")) == "RuntimeError"


# ==================== 8. 错误信息脱敏：appid / appkey / 独立 key / Authorization ====================


@pytest.mark.parametrize(
    ("template", "secret", "kept"),
    [
        (
            "amap rejected: appid={secret}",
            "syn-app-id-9vM4Pq7L",
            ("appid",),
        ),
        (
            '{"APP_ID": "{secret}"}',
            "syn-app-id-2Rf6Xk3D",
            ("APP_ID",),
        ),
        (
            "app-id={secret}; retry 2",
            "syn-app-id-8Wn3Ts5E",
            ("app-id", "retry 2"),
        ),
        (
            "upstream appid:{secret}",
            "syn-app-id-7Qk2Jm4N",
            ("appid",),
        ),
        (
            "aliyun app_key={secret} invalid",
            "syn-app-key-5Nx7Lp2V",
            ("app_key",),
        ),
        (
            '{"APPKEY": "{secret}"}',
            "syn-app-key-3Yb4Cd8M",
            ("APPKEY",),
        ),
        (
            "GET https://gw.example.com/rest?appkey={secret}&sign=abc&city=hz",
            "syn-app-key-6Pq9Rt4Z",
            ("sign=abc", "city=hz"),
        ),
        (
            "?APP-KEY={secret}&city=hz",
            "syn-app-key-2Jd3Fh7B",
            ("APP-KEY", "city=hz"),
        ),
    ],
)
def test_safe_error_masks_app_key_and_id_variants(template, secret, kept):
    text = api_server._safe_error(RuntimeError(template.replace("{secret}", secret)))

    assert_secret_fully_masked(text, secret)
    assert "***" in text
    for piece in kept:
        assert piece in text, f"可读信息被误删：{piece!r} / {text!r}"


@pytest.mark.parametrize(
    "secret",
    ["syn bare KqX2 mZ7L!", "pass; word=x(y)"],
)
def test_safe_error_masks_quoted_app_id_value_with_punctuation(secret):
    text = api_server._safe_error(
        RuntimeError('config {"appid": "' + secret + '", "mode": "strict"}')
    )

    assert_secret_fully_masked(text, secret)
    assert text == 'config {"appid": "***", "mode": "strict"}'


def test_safe_error_masks_bare_key_json_and_param_forms():
    """独立 key：JSON/单引号/URL 参数三种形态都遮蔽，字段名保留。"""

    secret = "syn-bare-KqX2mZ7L"
    cases = {
        '{"key": "syn-bare-KqX2mZ7L"}': '{"key": "***"}',
        "{'key': 'syn-bare-KqX2mZ7L'}": "{'key': '***'}",
        "?key=syn-bare-KqX2mZ7L&city=hz": "?key=***&city=hz",
        '?key="syn-bare-KqX2mZ7L"&page=2': '?key="***"&page=2',
        "silent key: syn-bare-KqX2mZ7L": "silent key: ***",
    }
    for template, expected in cases.items():
        text = api_server._safe_error(RuntimeError(template))

        assert_secret_fully_masked(text, secret)
        assert text == expected, template


def test_safe_error_masks_truncated_bare_key_value():
    """错误文本中途截断、引号没闭合时，独立 key 的值也不能漏片段。"""

    text = api_server._safe_error(RuntimeError('body {"key":"syn-bare-KqX2mZ7L'))

    assert_secret_fully_masked(text, "syn-bare-KqX2mZ7L")
    assert text == 'body {"key":"***'


def test_safe_error_keeps_non_cred_words_near_key():
    """monkey / mykey / keys / passkey 不是凭据字段，普通文本不能被抹。"""

    samples = (
        "monkey=banana; tokens=42",
        "mykey=x",
        '{"keys": "a"}',
        "passkey=111",
        "no key hint here",
    )
    for sample in samples:
        text = api_server._safe_error(RuntimeError(sample))

        assert text == sample, sample


def test_safe_error_masks_authorization_basic_and_any_scheme():
    """Authorization 无论 Basic 还是自定义方案，scheme 和凭据都整体遮掉。"""

    cases = {
        "Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=": "Authorization: ***",
        "authorization = q42": "authorization = ***",
        "AUTHORIZATION HMAC r9k": "AUTHORIZATION ***",
        "Authorization Basic dXNlcjpwYXNzd29yZDEyMzQ=; retries=3":
            "Authorization ***; retries=3",
    }
    for template, expected in cases.items():
        text = api_server._safe_error(RuntimeError(template))

        assert "***" in text
        assert text == expected, template


def test_safe_error_masks_authorization_quoted_values_with_spaces():
    secret = "Bearer syn-Pq9sTm4K with spaces / ok!"
    text = api_server._safe_error(
        RuntimeError("headers={'Authorization': '" + secret + "'}")
    )

    assert_secret_fully_masked(text, secret)
    assert text == "headers={'Authorization': '***'}"

    json_secret = "syn-auth-jYk7Dw2R; note=(a,b)"
    text = api_server._safe_error(
        RuntimeError('{"Authorization": "' + json_secret + '"}')
    )

    assert_secret_fully_masked(text, json_secret)
    assert text == '{"Authorization": "***"}'


def test_safe_error_masks_authorization_in_url_query_and_keeps_the_rest():
    text = api_server._safe_error(
        RuntimeError("GET https://api.example.com/v1?Authorization=Bearer 123ab&city=hz")
    )

    assert_secret_fully_masked(text, "123ab")
    assert text == "GET https://api.example.com/v1?Authorization=***&city=hz"


def test_safe_error_keeps_non_value_authorization_mentions():
    """KeyError 风格：后面没有分隔符接值，就不动原文。"""

    text = api_server._safe_error(RuntimeError("KeyError: 'Authorization'"))

    assert text == "KeyError: 'Authorization'"


def test_safe_error_masks_short_and_quoted_bearer_values():
    """短 Bearer 与带引号/冒号写法之前完全漏出，这里是补上的重点。"""

    cases = {
        "Bearer a1": "Bearer ***",
        "bearer: 7x": "bearer: ***",
        "Bearer 'ok jwt'": "Bearer '***'",
        'Bearer "z9"': 'Bearer "***"',
        "Bearer syn-brt-K3mR8vQ2": "Bearer ***",
    }
    for template, expected in cases.items():
        text = api_server._safe_error(RuntimeError(template))

        assert text == expected, template


def test_safe_error_keeps_nonbearer_words_not_masked():
    text = api_server._safe_error(RuntimeError("nonbearer abc; retry once"))

    assert text == "nonbearer abc; retry once"


def test_safe_error_masks_mixed_credential_shapes_in_one_message():
    app_secret = "syn-appid-mm4Kq7Px"
    json_secret = "sk-mix-json-8Pz3Rk6N"
    key_secret = "syn-bare-K2mZ7LqX"
    bearer_secret = "syn-brt-Qk8Wz3Pm"
    message = (
        f"amap ok appid={app_secret};"
        f' body {{"apiKey":"{json_secret}"}};'
        f" GET ?key={key_secret}&city=hz;"
        f" headers Bearer {bearer_secret}"
    )
    text = api_server._safe_error(RuntimeError(message))

    for secret in (app_secret, json_secret, key_secret, bearer_secret):
        assert_secret_fully_masked(text, secret)
    assert "appid" in text and "apiKey" in text and "key=" in text
    assert "city=hz" in text


def test_chat_500_redacts_json_body_secret(client):
    secret = "sk-syn-json-Zq7Lm2Xk9P"
    api_server.agent = FakeAgent(
        error=RuntimeError(
            'upstream rejected {"apiKey":"' + secret + '","model":"qwen-plus"}'
        )
    )

    response = client.post("/chat", json={"message": "你好"})

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert_secret_fully_masked(detail, secret)
    assert_secret_fully_masked(response.text, secret)
    assert "***" in detail
    assert '"apiKey"' in detail
    assert "qwen-plus" in detail

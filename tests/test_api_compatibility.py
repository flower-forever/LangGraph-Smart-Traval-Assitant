# -*- coding: utf-8 -*-
"""API 兼容层收尾测试：/api/health 别名、DELETE 真删除、默认仅监听本机。

全部离线运行：不读写 .env 中的密钥，不连接 DashScope / 高德 / MCP 上游。
"""

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import api_server


HEALTH_FIELDS = {
    "status",
    "tools_count",
    "model",
    "agent_ready",
    "planner_ready",
    "mcp_ready",
    "amap_configured",
    "warnings",
}


@pytest.fixture
def client(monkeypatch):
    """无密钥的测试客户端；额外清掉 API_HOST，让监听地址断言不受本机环境影响。"""
    for name in ("DASHSCOPE_API_KEY", "AMAP_API_KEY", "API_HOST"):
        monkeypatch.delenv(name, raising=False)

    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])

    with TestClient(api_server.app) as test_client:
        yield test_client


# ==================== 1. /api/health 别名 ====================


def test_api_health_alias_returns_same_payload_as_health(client):
    legacy = client.get("/health")
    alias = client.get("/api/health")

    assert legacy.status_code == 200
    assert alias.status_code == 200
    assert alias.json() == legacy.json()


def test_api_health_alias_is_usable_without_any_api_key(client):
    payload = client.get("/api/health").json()

    assert payload["status"] == "healthy"
    assert payload["agent_ready"] is False
    assert payload["planner_ready"] is False
    assert payload["mcp_ready"] is False
    assert payload["amap_configured"] is False
    assert set(payload) == HEALTH_FIELDS


def test_openapi_documents_both_health_paths(client):
    paths = client.get("/openapi.json").json()["paths"]

    assert "/health" in paths
    assert "/api/health" in paths


# ==================== 2. DELETE /chat/{thread_id} 真删除 ====================


class AsyncSaver:
    """只实现异步删除接口的假 checkpointer。"""

    def __init__(self):
        self.calls: list[str] = []

    async def adelete_thread(self, thread_id: str) -> None:
        self.calls.append(thread_id)


class SyncOnlySaver:
    """只有同步 delete_thread 的假 checkpointer。"""

    def __init__(self):
        self.calls: list[str] = []

    def delete_thread(self, thread_id: str) -> None:
        self.calls.append(thread_id)


class NotImplementedAsyncSaver:
    """异步接口未实现、同步接口可用的假 checkpointer。"""

    def __init__(self):
        self.adelete_calls: list[str] = []
        self.delete_calls: list[str] = []

    async def adelete_thread(self, thread_id: str) -> None:
        self.adelete_calls.append(thread_id)
        raise NotImplementedError("async delete not supported")

    def delete_thread(self, thread_id: str) -> None:
        self.delete_calls.append(thread_id)


class UnsupportedSaver:
    """两个删除接口都没有的假 checkpointer。"""


class ExplodingSaver:
    """删除时抛错的假 checkpointer。"""

    async def adelete_thread(self, thread_id: str) -> None:
        raise RuntimeError("checkpointer 存储层不可用")


def test_delete_calls_async_adelete_thread(client):
    saver = AsyncSaver()
    api_server.agent = SimpleNamespace(checkpointer=saver)

    response = client.delete("/chat/thread-async")

    assert response.status_code == 200
    assert response.json()["deleted"] is True
    assert response.json()["thread_id"] == "thread-async"
    assert saver.calls == ["thread-async"]


def test_delete_falls_back_to_sync_delete_thread(client):
    saver = SyncOnlySaver()
    api_server.agent = SimpleNamespace(checkpointer=saver)

    response = client.delete("/chat/thread-sync")

    assert response.status_code == 200
    assert response.json()["deleted"] is True
    assert saver.calls == ["thread-sync"]


def test_delete_falls_back_when_async_delete_is_not_implemented(client):
    saver = NotImplementedAsyncSaver()
    api_server.agent = SimpleNamespace(checkpointer=saver)

    response = client.delete("/chat/thread-fallback")

    assert response.status_code == 200
    assert saver.adelete_calls == ["thread-fallback"]
    assert saver.delete_calls == ["thread-fallback"]


def test_delete_501_when_checkpointer_cannot_delete(client):
    api_server.agent = SimpleNamespace(checkpointer=UnsupportedSaver())

    response = client.delete("/chat/thread-unsupported")

    assert response.status_code == 501
    detail = response.json()["detail"]
    assert "不支持" in detail
    assert "未删除任何会话历史" in detail
    assert "已删除" not in detail


def test_delete_500_when_saver_raises_and_never_claims_success(client):
    api_server.agent = SimpleNamespace(checkpointer=ExplodingSaver())

    response = client.delete("/chat/thread-boom")

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "失败" in detail
    assert "存储层不可用" in detail
    assert "已删除" not in detail
    assert "已清除" not in detail


def test_delete_503_without_agent(client):
    response = client.delete("/chat/thread-none")

    assert response.status_code == 503
    assert "Agent" in response.json()["detail"]
    assert "未修改任何数据" in response.json()["detail"]


def test_delete_503_when_agent_has_no_checkpointer(client):
    api_server.agent = SimpleNamespace(checkpointer=None)

    response = client.delete("/chat/thread-none")

    assert response.status_code == 503
    assert "checkpointer" in response.json()["detail"]


def test_delete_rejects_blank_thread_id(client):
    api_server.agent = SimpleNamespace(checkpointer=AsyncSaver())

    response = client.delete("/chat/%20")

    assert response.status_code == 400


def test_delete_really_clears_memorysaver_thread_and_keeps_others(client):
    """用真实 MemorySaver 证明删除生效：目标 thread 清空，另一个 thread 原样保留。"""
    pytest.importorskip("langgraph.graph")
    from typing import TypedDict

    from langgraph.checkpoint.memory import MemorySaver
    from langgraph.graph import START, StateGraph

    class State(TypedDict, total=False):
        value: int

    def bump(state):
        return {"value": state.get("value", 0) + 1}

    builder = StateGraph(State)
    builder.add_node("bump", bump)
    builder.add_edge(START, "bump")
    saver = MemorySaver()
    graph = builder.compile(checkpointer=saver)

    keep_config = {"configurable": {"thread_id": "keep-thread"}}
    remove_config = {"configurable": {"thread_id": "remove-thread"}}
    graph.invoke({"value": 0}, keep_config)
    graph.invoke({"value": 10}, remove_config)
    assert saver.get_tuple(remove_config) is not None

    api_server.agent = graph
    response = client.delete("/chat/remove-thread")

    assert response.status_code == 200
    assert response.json()["deleted"] is True

    # 目标 thread 的检查点与待写入数据都清空了。
    assert saver.get_tuple(remove_config) is None
    assert [key for key in saver.writes if key[0] == "remove-thread"] == []
    assert [key for key in saver.blobs if key[0] == "remove-thread"] == []

    # 另一个 thread 完全不受影响。
    kept = saver.get_tuple(keep_config)
    assert kept is not None
    assert kept.checkpoint["channel_values"]["value"] == 1

    # 再跑同一 thread 会从新输入开始，而不是接续删除前的状态。
    resumed = graph.invoke({"value": 100}, remove_config)
    assert resumed["value"] == 101


def test_delete_twice_is_idempotent(client):
    saver = AsyncSaver()
    api_server.agent = SimpleNamespace(checkpointer=saver)

    assert client.delete("/chat/thread-repeat").status_code == 200
    assert client.delete("/chat/thread-repeat").status_code == 200
    assert saver.calls == ["thread-repeat", "thread-repeat"]


# ==================== 3. 默认只监听 127.0.0.1 ====================


def test_configuration_defaults_to_loopback(monkeypatch):
    monkeypatch.delenv("API_HOST", raising=False)

    assert api_server.Configuration().host == "127.0.0.1"


def test_configuration_honors_api_host_override(monkeypatch):
    monkeypatch.setenv("API_HOST", "0.0.0.0")

    assert api_server.Configuration().host == "0.0.0.0"


def test_configuration_ignores_blank_api_host(monkeypatch):
    monkeypatch.setenv("API_HOST", "   ")

    assert api_server.Configuration().host == "127.0.0.1"


def test_lifespan_binds_loopback_by_default(client):
    assert api_server.cfg.host == "127.0.0.1"


def test_non_loopback_override_is_reported_in_health_warnings(monkeypatch):
    monkeypatch.setenv("API_HOST", "0.0.0.0")
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    monkeypatch.delenv("AMAP_API_KEY", raising=False)
    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)

    with TestClient(api_server.app) as test_client:
        payload = test_client.get("/api/health").json()

    assert api_server.cfg.host == "0.0.0.0"
    assert any(
        "0.0.0.0" in warning and "认证" in warning for warning in payload["warnings"]
    ), payload["warnings"]

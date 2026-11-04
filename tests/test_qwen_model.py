"""Qwen3.8-Flash 接口与工具消息回归；所有 SDK 调用均替换为离线实现。"""

import os

os.environ["PYTHON_DOTENV_DISABLED"] = "1"

import asyncio
import importlib

import dashscope
import pytest
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool


def sdk_response(content, *, tool_calls=None):
    message = {"role": "assistant", "content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    return {
        "status_code": 200,
        "request_id": "offline-request",
        "output": {"choices": [{"message": message, "finish_reason": "stop"}]},
        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
    }


@pytest.fixture(autouse=True)
def block_real_model_calls(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("测试禁止真实模型调用或错误的 SDK 接口")

    monkeypatch.setattr(dashscope.Generation, "call", blocked)
    monkeypatch.setattr(dashscope.MultiModalConversation, "call", blocked)


@pytest.mark.parametrize("entrypoint", ["api_server", "client", "client_simple"])
def test_flash_uses_multimodal_endpoint_and_returns_plain_text(monkeypatch, entrypoint):
    calls = []

    def fake_call(**kwargs):
        calls.append(kwargs)
        return sdk_response([{"text": '{"title":"杭州"}'}, {"text": "\n"}])

    monkeypatch.setattr(dashscope.MultiModalConversation, "call", fake_call)
    module = importlib.import_module(entrypoint)
    model = module.ChatTongyi(
        model="qwen3.8-flash", dashscope_api_key="offline-model-key", streaming=False
    )
    messages = [SystemMessage(content="只返回 JSON"), HumanMessage(content="杭州三日")]

    result = model.invoke(messages)

    assert result.content == '{"title":"杭州"}\n'
    assert calls[0]["model"] == "qwen3.8-flash"
    assert calls[0]["enable_thinking"] is False
    assert "result_format" not in calls[0]
    assert calls[0]["messages"] == [
        {"role": "system", "content": [{"text": "只返回 JSON"}]},
        {"role": "user", "content": [{"text": "杭州三日"}]},
    ]
    assert messages[0].content == "只返回 JSON"
    assert messages[1].content == "杭州三日"


def test_flash_async_tool_call_and_tool_result_keep_the_same_identity(monkeypatch):
    calls = []

    def fake_call(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return sdk_response(
                None,
                tool_calls=[
                    {
                        "id": "offline-tool-1",
                        "type": "function",
                        "function": {
                            "name": "example_weather",
                            "arguments": '{"city":"杭州"}',
                        },
                    }
                ],
            )
        return sdk_response([{"text": "已读取示例天气"}])

    @tool
    def example_weather(city: str) -> str:
        """返回离线天气示例。"""
        return f"{city}：仅供测试"

    monkeypatch.setattr(dashscope.MultiModalConversation, "call", fake_call)
    model_class = importlib.import_module("api_server").ChatTongyi
    model = model_class(model="qwen3.8-flash", dashscope_api_key="offline-model-key")
    bound = model.bind_tools([example_weather])

    async def run():
        question = HumanMessage(content="查看杭州天气")
        answer = await bound.ainvoke([question])
        assert answer.content == ""
        assert answer.tool_calls[0]["id"] == "offline-tool-1"
        assert answer.tool_calls[0]["args"] == {"city": "杭州"}
        tool_result = ToolMessage(
            content=example_weather.invoke(answer.tool_calls[0]["args"]),
            tool_call_id=answer.tool_calls[0]["id"],
            name="example_weather",
        )
        return await bound.ainvoke([question, answer, tool_result])

    assert asyncio.run(run()).content == "已读取示例天气"
    assert calls[0]["tools"][0]["function"]["name"] == "example_weather"
    assert calls[1]["messages"][1]["tool_calls"][0]["id"] == "offline-tool-1"
    assert calls[1]["messages"][2]["tool_call_id"] == "offline-tool-1"
    assert calls[1]["messages"][2]["content"] == [{"text": "杭州：仅供测试"}]


def test_flash_streaming_converts_text_blocks_to_text_chunks(monkeypatch):
    def fake_call(**kwargs):
        assert kwargs["stream"] is True
        return iter([sdk_response([{"text": "杭州"}]), sdk_response([{"text": "三日"}])])

    monkeypatch.setattr(dashscope.MultiModalConversation, "call", fake_call)
    model_class = importlib.import_module("api_server").ChatTongyi
    model = model_class(
        model="qwen3.8-flash", dashscope_api_key="offline-model-key", streaming=True
    )

    assert "".join(chunk.content for chunk in model.stream("示例行程")) == "杭州三日"


def test_flash_streaming_with_tools_is_rejected_before_any_sdk_call(monkeypatch):
    calls = []

    def fake_call(**kwargs):
        calls.append(kwargs)
        tool_call = {
            "id": "offline-tool-1",
            "type": "function",
            "function": {"name": "example_weather", "arguments": '{"city":"杭州"}'},
        }
        return iter(
            [sdk_response(None, tool_calls=[tool_call])] * 2
        )

    monkeypatch.setattr(dashscope.MultiModalConversation, "call", fake_call)
    model_class = importlib.import_module("api_server").ChatTongyi
    model = model_class(
        model="qwen3.8-flash", dashscope_api_key="offline-model-key", streaming=True
    )

    @tool
    def example_weather(city: str) -> str:
        """返回离线天气示例。"""
        return f"{city}：仅供测试"

    with pytest.raises(ValueError, match="非流式"):
        list(model.bind_tools([example_weather]).stream("查看杭州天气"))

    assert calls == []


def test_flash_async_streaming_with_tools_is_rejected_before_any_sdk_call(monkeypatch):
    calls = []

    def fake_call(**kwargs):
        calls.append(kwargs)
        tool_call = {
            "id": "offline-tool-1",
            "type": "function",
            "function": {"name": "example_weather", "arguments": '{"city":"杭州"}'},
        }
        return iter(
            [sdk_response(None, tool_calls=[tool_call])] * 2
        )

    monkeypatch.setattr(dashscope.MultiModalConversation, "call", fake_call)
    model_class = importlib.import_module("api_server").ChatTongyi
    model = model_class(
        model="qwen3.8-flash", dashscope_api_key="offline-model-key", streaming=True
    )

    @tool
    def example_weather(city: str) -> str:
        """返回离线天气示例。"""
        return f"{city}：仅供测试"

    async def run():
        chunks = []
        with pytest.raises(ValueError, match="非流式"):
            async for chunk in model.bind_tools([example_weather]).astream(
                "查看杭州天气"
            ):
                chunks.append(chunk)
        return chunks

    assert asyncio.run(run()) == []
    assert calls == []


def test_legacy_model_streaming_with_tools_keeps_upstream_behavior(monkeypatch):
    calls = []

    def fake_call(**kwargs):
        calls.append(kwargs)
        return iter([sdk_response("杭州"), sdk_response("三日")])

    monkeypatch.setattr(dashscope.Generation, "call", fake_call)
    model_class = importlib.import_module("api_server").ChatTongyi
    model = model_class(
        model="qwen-plus", dashscope_api_key="offline-model-key", streaming=True
    )

    @tool
    def example_weather(city: str) -> str:
        """返回离线天气示例。"""
        return f"{city}：仅供测试"

    chunks = list(model.bind_tools([example_weather]).stream("示例"))

    assert "".join(chunk.content for chunk in chunks) == "杭州三日"
    assert len(calls) == 1


def test_explicit_legacy_model_keeps_its_original_text_endpoint(monkeypatch):
    calls = []

    def fake_call(**kwargs):
        calls.append(kwargs)
        return sdk_response("旧模型示例")

    monkeypatch.setattr(dashscope.Generation, "call", fake_call)
    model_class = importlib.import_module("api_server").ChatTongyi
    model = model_class(model="qwen-plus", dashscope_api_key="offline-model-key")

    assert model.invoke("示例").content == "旧模型示例"
    assert calls[0]["messages"] == [{"role": "user", "content": "示例"}]
    assert calls[0]["result_format"] == "message"
    assert "enable_thinking" not in calls[0]


@pytest.mark.parametrize("content", [[{"image": "not-text"}], [{"text": None}], [7]])
def test_flash_rejects_unexpected_output_blocks_instead_of_inventing_text(monkeypatch, content):
    monkeypatch.setattr(
        dashscope.MultiModalConversation, "call", lambda **kwargs: sdk_response(content)
    )
    model_class = importlib.import_module("api_server").ChatTongyi
    model = model_class(model="qwen3.8-flash", dashscope_api_key="offline-model-key")

    with pytest.raises(ValueError, match="非文本"):
        model.invoke("示例")

"""补齐 Qwen3.8-Flash 的 DashScope 多模态接口；项目目前仍只处理文本。"""

from typing import Any

from langchain_community.chat_models import ChatTongyi as _ChatTongyi
from pydantic import model_validator


class ChatTongyi(_ChatTongyi):
    """沿用 LangChain 工具调用，仅适配当前默认 Flash 模型的接口和文本格式。"""

    @model_validator(mode="after")
    def _configure_flash_endpoint(self) -> "ChatTongyi":
        if self.model_name == "qwen3.8-flash":
            from dashscope import MultiModalConversation

            # 上游 ChatTongyi 仅按旧 VL 名称分流，会把 qwen3.8-flash 误发到
            # Generation。该模型即使只有文字输入也要求 MultiModalConversation。
            self.client = MultiModalConversation
            # 保持原应用直接回复、非流式等待的使用方式，避免默认开启额外推理。
            self.model_kwargs = {"enable_thinking": False, **self.model_kwargs}
        return self

    def _invocation_params(self, messages: list, stop: Any, **kwargs: Any) -> dict:
        params = super()._invocation_params(messages, stop, **kwargs)
        if self.model_name == "qwen3.8-flash":
            # 上游对流式且带 tools 的请求不设 incremental_output，改由本地做块间
            # 差减；差减对 content=None（工具调用块）调 .replace 会直接崩溃。
            # 该组合当前项目不支持，生产三个入口都是非流式，请求发出前显式拒绝。
            if params.get("stream") and params.get("tools"):
                raise ValueError(
                    "qwen3.8-flash 当前仅支持非流式工具调用：请用 streaming=False"
                    "并 bind_tools 后 invoke/ainvoke；流式仅限纯文本。"
                )
            # 仅转换本次请求副本，不改 LangGraph 的消息或工具调用标识。
            params["messages"] = [
                {
                    **message,
                    "content": [{"text": message["content"]}]
                    if isinstance(message["content"], str)
                    else message["content"],
                }
                for message in params["messages"]
            ]
            # 纯文本 Generation 的参数不传给多模态接口。
            params.pop("result_format", None)
        return params

    def _chat_generation_from_qwen_resp(
        self, resp: Any, is_chunk: bool = False, is_last_chunk: bool = True
    ) -> dict:
        if self.model_name == "qwen3.8-flash":
            choices = resp["output"]["choices"]
            message = choices[0]["message"]
            content = message["content"]
            if isinstance(content, list):
                if any(
                    not isinstance(part, dict) or not isinstance(part.get("text"), str)
                    for part in content
                ):
                    raise ValueError("模型返回了非文本内容，无法作为旅行助手回复。")
                content = "".join(part["text"] for part in content)
            elif content is None and message.get("tool_calls"):
                content = ""
            elif not isinstance(content, str):
                raise ValueError("模型返回了非文本内容，无法作为旅行助手回复。")
            resp = {
                **resp,
                "output": {
                    **resp["output"],
                    "choices": [
                        {**choices[0], "message": {**message, "content": content}},
                        *choices[1:],
                    ],
                },
            }
        return super()._chat_generation_from_qwen_resp(resp, is_chunk, is_last_chunk)

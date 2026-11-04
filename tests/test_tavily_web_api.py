# -*- coding: utf-8 -*-
"""tavily_web_api 离线测试：FastAPI TestClient + TavilyWebClient(MockTransport)。

全部离线，不发真实网络请求（业务外网预算 0）；生产 app 的搜索请求通过把
``api_server.app.state.tavily_web_client`` 换成 MockTransport 客户端完成，
不 import 启动真实服务、不读真实 .env、不连接 Tavily。覆盖：

1. POST /api/web-sources/search 契约：仅 {query}、available 信封透传 200
2. typed provider 状态 → 200 + x-web-sources-status；invalid_request → 422
3. 本地非法 body（缺 query/非字符串/空/301 码点/孤立代理码点）→ 422 且
   0 provider 请求；合法 emoji 300 码点通过
4. client 未初始化/初始化失败 → 固定 503，健康检查不受影响
5. lifespan 读 TAVILY_API_KEY：无 Key 仍启动，请求返回 no_key 信封（200）
6. app 级来源守卫自动覆盖新 POST：恶意 Origin POST → 403 且 0 provider 请求；
   恶意 Origin OPTIONS 预检 → 400 且无 allow-origin 头；白名单 Origin 通过；
   相邻旧接口（/api/health、/api/trips/example）不回退
7. 既有端点语义不变、openapi 注册与新路由共存
"""

from __future__ import annotations

import os
import sys
import unittest.mock

# 必须在 import api_server 之前：模块导入时会执行 load_dotenv()。
# 与 test_poi_sources_api.py 同款双重保险，绝不读真实 .env。
if not os.environ.get("PYTHON_DOTENV_DISABLED"):
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"

import dotenv  # noqa: E402

_original_load_dotenv = dotenv.load_dotenv


def _dotenv_noop(*args: object, **kwargs: object) -> bool:
    return False


_api_server_fresh_imported = "api_server" not in sys.modules
with unittest.mock.patch.object(dotenv, "load_dotenv", _dotenv_noop):
    import api_server  # noqa: E402

import asyncio  # noqa: E402
import json  # noqa: E402
import threading  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from typing import Any, Callable  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import api_server  # noqa: E402
import tavily_web_api  # noqa: E402
from tavily_web_api import tavily_web_router_factory  # noqa: E402
from tavily_web_client import TavilyWebClient  # noqa: E402

FAKE_KEY = "tvly-fake-key-for-tests"

FIXED_NOW = datetime(2026, 11, 3, 8, 0, 0, tzinfo=timezone.utc)


def fixed_now() -> datetime:
    return FIXED_NOW


# ==================== 0. 真实网络出站守卫（autouse） ====================


@pytest.fixture(autouse=True)
def _block_real_network(monkeypatch):
    def _refuse_async(self, request):
        raise AssertionError(
            "测试试图通过真实 AsyncHTTPTransport 出站（异步路径）："
            f"{request.method} {request.url.host} —— 本模块只允许 MockTransport"
        )

    def _refuse_sync(self, request):
        raise AssertionError(
            "测试试图通过真实 HTTPTransport 出站（同步路径）："
            f"{request.method} {request.url.host} —— 本模块只允许 MockTransport"
        )

    monkeypatch.setattr(
        httpx.AsyncHTTPTransport, "handle_async_request", _refuse_async
    )
    monkeypatch.setattr(
        httpx.HTTPTransport, "handle_request", _refuse_sync
    )
    yield


# ==================== 夹具 ====================


class Recorder:
    """记录 provider 请求次数与最后一次请求，用于 0 请求/单次尝试断言。"""

    def __init__(self, responder: Callable[[httpx.Request], httpx.Response]):
        self.calls = 0
        self.requests: list[httpx.Request] = []
        self._lock = threading.Lock()
        self.responder = responder

    def __call__(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            self.calls += 1
            self.requests.append(request)
        return self.responder(request)


def ok_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "query": "西湖 旅游",
        "results": [
            {
                "title": "杭州西湖旅游攻略",
                "url": "https://www.example-travel.com/xihu-guide",
                "content": "西湖位于杭州市西湖区。",
                "published_date": "2025-06-01",
            }
        ],
        "response_time": 1.0,
    }
    payload.update(overrides)
    return payload


def json_responder(payload: Any, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return handler


def make_client(
    recorder: Recorder, *, api_key: str | None = FAKE_KEY, **kwargs: Any
) -> tuple[TavilyWebClient, httpx.AsyncClient]:
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = TavilyWebClient(api_key=api_key, client=http_client, **kwargs)
    return client, http_client


async def _close_pair(
    client: TavilyWebClient, http_client: httpx.AsyncClient
) -> None:
    await client.aclose()
    await http_client.aclose()


def status_responder(status: int):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"detail": {"error": "x"}})

    return handler


# ==================== 1-2. 契约与状态映射（独立 router app） ====================


def build_router_app(client: Any) -> FastAPI:
    app = FastAPI()
    app.include_router(tavily_web_router_factory(client=client))
    return app


@pytest.mark.parametrize(
    ("upstream_status", "envelope_status"),
    [
        (200, "available"),
        (429, "rate_limited"),
        (432, "rate_limited"),
        (401, "unauthorized"),
        (403, "unauthorized"),
        (500, "unavailable"),
    ],
)
def test_typed_provider_status_returns_200_with_header(
    upstream_status: int, envelope_status: str
) -> None:
    payload: Any = ok_payload() if upstream_status == 200 else {"detail": {"e": "x"}}
    recorder = Recorder(json_responder(payload, upstream_status))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search", json={"query": "西湖 旅游"}
            )
            assert response.status_code == 200
            assert response.headers["x-web-sources-status"] == envelope_status
            assert response.json()["status"] == envelope_status
            assert recorder.calls == 1
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_upstream_empty_results_maps_to_no_results_envelope() -> None:
    recorder = Recorder(json_responder(ok_payload(results=[])))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search", json={"query": "冷门查询"}
            )
            assert response.status_code == 200
            assert response.headers["x-web-sources-status"] == "no_results"
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_no_key_maps_to_200_no_key_envelope() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder, api_key=None)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search", json={"query": "西湖"}
            )
            assert response.status_code == 200
            assert response.headers["x-web-sources-status"] == "no_key"
            assert response.json()["status"] == "no_key"
            assert recorder.calls == 0
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_client_invalid_request_maps_to_422_with_report() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            # 301 码点会先被 router 本地校验 422；这里用直接调用 client 的
            # invalid_request 路径（绕过本地校验等价：空 query 到不了 client）。
            # 本地校验对超长也拦截，因此 422 分支已由 test_local_invalid_body
            # 覆盖；此用例验证 router 对 client 返回 invalid_request 的转换。
            response = test_client.post(
                "/api/web-sources/search", json={"query": "西" * 301}
            )
            assert response.status_code == 422
            assert response.headers["x-web-sources-status"] == "invalid_request"
            assert recorder.calls == 0
    finally:
        asyncio.run(_close_pair(client, http_client))


# ==================== 3. 本地非法 body（422 且 0 请求） ====================


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"query": 123},
        {"query": None},
        {"query": ""},
        {"query": "   "},
        {"query": "西" * 301},
        {"query": "西湖", "extra": "多余字段"},
        [1, 2, 3],
        "not-an-object",
    ],
)
def test_local_invalid_body_is_422_without_provider_request(body: Any) -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search", json=body
            )
            assert response.status_code == 422
            assert recorder.calls == 0
            # 本端点所有 422 都是同一固定安全形状，不出现 input/字段原文。
            assert response.headers["x-web-sources-status"] == "invalid_request"
            text = response.content.decode("utf-8")
            assert json.loads(text) == {
                "detail": "query 必须为去除首尾空白后 1 到 300 个字符的文本",
                "report": None,
            }
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_missing_body_is_422() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search",
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 422
            assert recorder.calls == 0
            assert response.headers["x-web-sources-status"] == "invalid_request"
            text = response.content.decode("utf-8")
            assert json.loads(text) == {
                "detail": "query 必须为去除首尾空白后 1 到 300 个字符的文本",
                "report": None,
            }
    finally:
        asyncio.run(_close_pair(client, http_client))


@pytest.mark.parametrize(
    "raw_body",
    [
        b'{"query":"ok","extra":"\\ud800"}',
        b'{"query":{"x":"\\ud800"}}',
        b'{"query":"ok","\\ud800":1}',
        b'["\\ud800"]',
    ],
)
def test_fastapi_schema_errors_with_lone_surrogate_are_safe_422(
    raw_body: bytes,
) -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            # 真实 ASCII JSON 字节：Pydantic/FastAPI 在进入 _validate_body 前
            # 就会拿到这些 input，默认 422 会回显并在 UTF-8 编码时崩成 500。
            response = test_client.post(
                "/api/web-sources/search",
                content=raw_body,
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 422
            assert response.headers["x-web-sources-status"] == "invalid_request"
            assert recorder.calls == 0
            text = response.content.decode("utf-8")
            assert json.loads(text) == {
                "detail": "query 必须为去除首尾空白后 1 到 300 个字符的文本",
                "report": None,
            }
            assert "ud800" not in text.lower()
            assert "extra" not in text
            assert '"x"' not in text
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_other_routes_keep_fastapi_default_422_shape() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = FastAPI()
    app.include_router(tavily_web_router_factory(client=client))

    @app.post("/other-validation")
    def other_validation(body: dict[str, int]) -> dict[str, int]:
        return body

    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/other-validation", json={"x": "not-an-int"}
            )
            assert response.status_code == 422
            # 未被本 router 的固定信封篡改：仍是 FastAPI 默认 detail 列表。
            detail = response.json()["detail"]
            assert isinstance(detail, list)
            assert detail and detail[0]["input"] == "not-an-int"
            assert "x-web-sources-status" not in response.headers
            assert recorder.calls == 0
    finally:
        asyncio.run(_close_pair(client, http_client))


@pytest.mark.parametrize(
    "raw_body",
    [
        b'{"query":"ok\\ud800"',  # 截断 JSON
        b'{"query":"\xff"}',  # 无法按 UTF-8 解码的 body
    ],
)
def test_malformed_json_body_is_safe_422_without_echo(
    raw_body: bytes,
) -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search",
                content=raw_body,
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 422
            assert response.headers["x-web-sources-status"] == "invalid_request"
            assert recorder.calls == 0
            text = response.content.decode("utf-8")
            assert json.loads(text) == {
                "detail": "query 必须为去除首尾空白后 1 到 300 个字符的文本",
                "report": None,
            }
            assert "ud800" not in text.lower()
            assert '"query"' not in text
    finally:
        asyncio.run(_close_pair(client, http_client))


@pytest.mark.parametrize("raw_query", ["\\ud800abc", "abc\\udfff"])
def test_ascii_json_lone_surrogate_query_is_422_without_transport(
    raw_query: str,
) -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            # 直接发 ASCII 字节，复现 {"query":"\ud800abc"} 的真实 HTTP 入口。
            raw_body = ('{"query":"%s"}' % raw_query).encode("ascii")
            response = test_client.post(
                "/api/web-sources/search",
                content=raw_body,
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 422
            assert response.headers["x-web-sources-status"] == "invalid_request"
            assert recorder.calls == 0
            # 响应必须是可解码 UTF-8，且不回显无效 query 原文/代理转义。
            text = response.content.decode("utf-8")
            payload = json.loads(text)
            assert payload["report"] is None
            assert "query 必须" in payload["detail"]
            assert "ud800" not in text.lower()
            assert "udfff" not in text.lower()
            assert "abc" not in text
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_ascii_json_valid_surrogate_pair_decodes_to_emoji_and_is_accepted() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            # 真实合法 JSON 代理对：\uD83D\uDE80 解码为单个 emoji，必须接受。
            raw_body = b'{"query":"\\ud83d\\ude80 \\u897f\\u6e56"}'
            response = test_client.post(
                "/api/web-sources/search",
                content=raw_body,
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 200
            assert response.headers["x-web-sources-status"] == "available"
            assert response.json()["requested_query"] == "🚀 西湖"
            assert recorder.calls == 1
            sent = json.loads(recorder.requests[0].content)
            assert sent["query"] == "🚀 西湖"
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_query_emoji_300_accepted_301_rejected_at_http_boundary() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            query_300 = "🚀" * 300
            response = test_client.post(
                "/api/web-sources/search", json={"query": query_300}
            )
            assert response.status_code == 200
            assert response.headers["x-web-sources-status"] == "available"
            assert response.json()["requested_query"] == query_300
            assert recorder.calls == 1
            sent = json.loads(recorder.requests[0].content)
            assert sent["query"] == query_300

            response_301 = test_client.post(
                "/api/web-sources/search", json={"query": "🚀" * 301}
            )
            assert response_301.status_code == 422
            assert (
                response_301.headers["x-web-sources-status"]
                == "invalid_request"
            )
            assert recorder.calls == 1
            response_301.content.decode("utf-8")
    finally:
        asyncio.run(_close_pair(client, http_client))


def _raw_upstream_payload_with_bad_field(field: str) -> bytes:
    entry: dict[str, str] = {
        "title": "正常标题",
        "url": "https://www.example-travel.com/bad",
        "content": "正常摘要",
        "published_date": "2025-01-01",
    }
    entry[field] = "__UPSTREAM_SECRET__"
    text = json.dumps({"results": [entry]}, ensure_ascii=True)
    text = text.replace("__UPSTREAM_SECRET__", "\\ud800UPSTREAM_SECRET")
    return text.encode("ascii")


@pytest.mark.parametrize("field", ["title", "content", "published_date"])
def test_upstream_lone_surrogate_returns_encodable_failed_envelope(
    field: str,
) -> None:
    raw = _raw_upstream_payload_with_bad_field(field)
    recorder = Recorder(
        lambda request: httpx.Response(
            200, content=raw, headers={"Content-Type": "application/json"}
        )
    )
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search", json={"query": "西湖"}
            )
            assert response.status_code == 200
            assert response.headers["x-web-sources-status"] == "failed"
            text = response.content.decode("utf-8")
            payload = json.loads(text)
            assert payload["status"] == "failed"
            assert payload["fetched_at"] is None
            assert payload["provider_http_status"] == 200
            assert payload["results"] == []
            assert "UPSTREAM_SECRET" not in text
            assert recorder.calls == 1
    finally:
        asyncio.run(_close_pair(client, http_client))


# ==================== 4. client 不可用 → 503 ====================


def test_router_before_lifespan_returns_fixed_503() -> None:
    app = FastAPI()
    app.include_router(tavily_web_router_factory())
    # 不进入 TestClient 上下文：真实模拟 lifespan 从未运行、state 无 client。
    test_client = TestClient(app)
    try:
        response = test_client.post(
            "/api/web-sources/search", json={"query": "西湖"}
        )
        assert response.status_code == 503
        assert response.json()["detail"] == "网页资料搜索服务未初始化，请稍后再试。"
    finally:
        test_client.close()


class _ExplodingClient:
    def __init__(self, **kwargs: Any) -> None:
        raise RuntimeError("boom")


def test_init_failure_returns_fixed_503_and_keeps_health(monkeypatch) -> None:
    app = FastAPI()
    with monkeypatch.context() as patch:
        patch.setattr(tavily_web_api, "TavilyWebClient", _ExplodingClient)
        app.include_router(tavily_web_router_factory(api_key="k"))
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search", json={"query": "西湖"}
            )
            assert response.status_code == 503
            assert response.json()["detail"] == "网页资料搜索服务未初始化，请稍后再试。"


# ==================== 5. lifespan 读环境 Key ====================


def test_lifespan_reads_env_key_and_owned_client_is_closed() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    captured: dict[str, Any] = {}

    real_client_type = TavilyWebClient

    def _spy_factory(**kwargs: Any) -> Any:
        captured.update(kwargs)
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
        return real_client_type(client=http_client, **kwargs)

    env = {
        k: v for k, v in os.environ.items() if k != "TAVILY_API_KEY"
    }
    env["TAVILY_API_KEY"] = FAKE_KEY
    with unittest.mock.patch.dict(os.environ, env, clear=True):
        with unittest.mock.patch.object(
            tavily_web_api, "TavilyWebClient", _spy_factory
        ):
            app = FastAPI()
            app.include_router(tavily_web_router_factory())
            with TestClient(app) as test_client:
                response = test_client.post(
                    "/api/web-sources/search", json={"query": "西湖 旅游"}
                )
                assert response.status_code == 200
                assert captured.get("api_key") == FAKE_KEY
                assert recorder.calls == 1
            # shutdown 后 owned http client 已关（_spy_factory 自建并交出）。
            assert app.state.tavily_web_client is None


def test_lifespan_without_env_key_still_serves_no_key() -> None:
    app = FastAPI()
    env = {k: v for k, v in os.environ.items() if k != "TAVILY_API_KEY"}
    with unittest.mock.patch.dict(os.environ, env, clear=True):
        app.include_router(tavily_web_router_factory())
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search", json={"query": "西湖"}
            )
            assert response.status_code == 200
            assert response.json()["status"] == "no_key"
            assert test_client.get("/openapi.json").status_code == 200


# ==================== 6. app 级来源守卫覆盖新 POST ====================


def _guard_app_with_client(monkeypatch) -> tuple[FastAPI, Recorder]:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = FastAPI()
    app.include_router(tavily_web_router_factory(client=client))
    # 记录到闭包外以便关闭
    app.state._test_http_client = http_client
    return app, recorder


def test_malicious_origin_post_is_403_with_zero_provider_calls() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = FastAPI()
    # 生产 api_server 的 app 级来源守卫按方法拦截 POST；独立 app 显式装同款
    # 中间件（BrowserOriginGuardMiddleware + 默认 CORS 白名单）等价复现。
    app.add_middleware(api_server.BrowserOriginGuardMiddleware)
    app.include_router(tavily_web_router_factory(client=client))
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search",
                json={"query": "西湖"},
                headers={"Origin": "https://evil.example"},
            )
            assert response.status_code == 403
            assert recorder.calls == 0
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_malicious_origin_with_lone_surrogate_body_stays_403() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = FastAPI()
    app.add_middleware(api_server.BrowserOriginGuardMiddleware)
    app.include_router(tavily_web_router_factory(client=client))
    try:
        with TestClient(app) as test_client:
            # Origin 守卫必须先于 body 校验生效，且响应不得回显坏 input。
            response = test_client.post(
                "/api/web-sources/search",
                content=b'{"query":"ok","extra":"\\ud800"}',
                headers={
                    "Content-Type": "application/json",
                    "Origin": "https://evil.example",
                },
            )
            assert response.status_code == 403
            assert recorder.calls == 0
            text = response.content.decode("utf-8")
            assert "ud800" not in text.lower()
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_malicious_origin_preflight_is_400_without_allow_origin() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = FastAPI()
    app.add_middleware(
        api_server.DynamicCORSMiddleware,
        allow_origins=list(api_server.DEFAULT_CORS_ORIGINS),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(tavily_web_router_factory(client=client))
    try:
        with TestClient(app) as test_client:
            response = test_client.options(
                "/api/web-sources/search",
                headers={
                    "Origin": "https://evil.example",
                    "Access-Control-Request-Method": "POST",
                },
            )
            assert response.status_code == 400
            assert response.headers.get("access-control-allow-origin") is None
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_allowed_origin_post_passes_guard() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = FastAPI()
    app.add_middleware(
        api_server.DynamicCORSMiddleware,
        allow_origins=list(api_server.DEFAULT_CORS_ORIGINS),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(tavily_web_router_factory(client=client))
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/web-sources/search",
                json={"query": "西湖 旅游"},
                headers={"Origin": "http://127.0.0.1:5173"},
            )
            assert response.status_code == 200
            assert response.json()["status"] == "available"
            assert recorder.calls == 1
    finally:
        asyncio.run(_close_pair(client, http_client))


# ==================== 7. 生产 api_server 接线 ====================


def _prepare_no_model_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "DASHSCOPE_API_KEY",
        "AMAP_API_KEY",
        "API_HOST",
        "TAVILY_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(api_server.cfg, "api_key", None)
    monkeypatch.setattr(api_server.cfg, "amap_api_key", None)
    monkeypatch.setattr(api_server, "agent", None)
    monkeypatch.setattr(api_server, "planner_agent", None)
    monkeypatch.setattr(api_server, "mcp_client", None)
    monkeypatch.setattr(api_server, "available_tools", [])


@pytest.fixture()
def production_client(monkeypatch: pytest.MonkeyPatch):
    _prepare_no_model_keys(monkeypatch)
    with TestClient(api_server.app) as test_client:
        yield test_client


def test_production_openapi_registers_web_sources_post() -> None:
    schema = api_server.app.openapi()
    assert "/api/web-sources/search" in schema["paths"]
    operation = schema["paths"]["/api/web-sources/search"]
    assert "post" in operation
    # 既有业务路径没有因为接入新路由而消失。
    assert "/api/trips/plan" in schema["paths"]
    assert "/api/weather/day" in schema["paths"]
    assert "/api/poi-sources/nearby" in schema["paths"]


def test_production_web_sources_no_key_envelope_without_real_network(
    production_client: TestClient,
) -> None:
    # 生产 app lifespan：无 TAVILY_API_KEY 时自建 no-key client；
    # 请求返回 no_key 信封（200），全程 0 真实网络。
    response = production_client.post(
        "/api/web-sources/search", json={"query": "西湖"}
    )
    assert response.status_code == 200
    assert response.headers["x-web-sources-status"] == "no_key"
    assert response.json()["status"] == "no_key"

    health = production_client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "healthy"


def test_production_web_sources_with_injected_mock_client(
    production_client: TestClient,
) -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    api_server.app.state.tavily_web_client = client
    try:
        response = production_client.post(
            "/api/web-sources/search", json={"query": "西湖 旅游"}
        )
        assert response.status_code == 200
        assert response.json()["status"] == "available"
        assert recorder.calls == 1
        body = json.loads(recorder.requests[0].content)
        assert body["query"] == "西湖 旅游"

        # 相邻旧接口不回退。
        example = production_client.get("/api/trips/example")
        assert example.status_code == 200
        health = production_client.get("/api/health")
        assert health.status_code == 200
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_production_post_guard_blocks_malicious_origin(
    production_client: TestClient,
) -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    api_server.app.state.tavily_web_client = client
    try:
        response = production_client.post(
            "/api/web-sources/search",
            json={"query": "西湖"},
            headers={"Origin": "https://evil.example"},
        )
        assert response.status_code == 403
        assert recorder.calls == 0

        # 既有 GET 不受影响。
        example = production_client.get("/api/trips/example")
        assert example.status_code == 200
    finally:
        asyncio.run(_close_pair(client, http_client))

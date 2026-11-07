# -*- coding: utf-8 -*-
"""image_sources_api 离线测试：FastAPI TestClient + ImageSourcesClient(MockTransport)。

全部离线，不发真实网络请求（业务外网预算 0）；生产 app 的搜索请求通过把
``api_server.app.state.image_sources_client`` 换成 MockTransport 客户端完成，
不 import 启动真实服务、不读真实 .env、不连接 Wikimedia Commons。覆盖：

1. POST /api/image-sources/search 契约：仅 {query}、available 信封透传 200
2. typed provider 状态 → 200 + x-image-sources-status；invalid_request → 422
3. 本地非法 body（缺 query/非字符串/空/101 码点/孤立代理码点）→ 422 且
   0 provider 请求；合法 emoji 100 码点通过；其他路由保持 FastAPI 默认 422
4. client 未初始化/初始化失败 → 固定 503，健康检查不受影响
5. app 级来源守卫自动覆盖新 POST：恶意 Origin POST → 403 且 0 provider 请求
6. 既有端点语义不变、openapi 注册与新路由共存
"""

from __future__ import annotations

import os
import sys
import unittest.mock

# 必须在 import api_server 之前：模块导入时会执行 load_dotenv()。
# 与 test_poi_sources_api.py / test_tavily_web_api.py 同款双重保险，
# 绝不读真实 .env。
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
import image_sources_api  # noqa: E402
from image_sources_api import image_sources_router_factory  # noqa: E402
from image_sources_client import ImageSourcesClient  # noqa: E402

FIXED_NOW = datetime(2026, 11, 8, 8, 0, 0, tzinfo=timezone.utc)


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
    page: dict[str, Any] = {
        "pageid": 1,
        "ns": 6,
        "title": "File:West Lake 01.jpg",
        "imageinfo": [
            {
                "thumburl": (
                    "https://upload.wikimedia.org/wikipedia/commons/"
                    "thumb/a/ab/X.jpg/320px-X.jpg"
                ),
                "url": "https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg",
                "descriptionurl": (
                    "https://commons.wikimedia.org/wiki/File:West_Lake_01.jpg"
                ),
                "width": 4032,
                "height": 3024,
                "extmetadata": {
                    "LicenseShortName": {"value": "CC BY-SA 4.0"},
                    "Artist": {
                        "value": '<a href="//commons.wikimedia.org/wiki/User:x">张三</a>'
                    },
                },
            }
        ],
    }
    return {"batchcomplete": True, "query": {"pages": [page]}}


def json_responder(payload: Any, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return handler


def make_client(
    recorder: Recorder, **kwargs: Any
) -> tuple[ImageSourcesClient, httpx.AsyncClient]:
    kwargs.setdefault("now_utc", fixed_now)
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(recorder))
    client = ImageSourcesClient(client=http_client, **kwargs)
    return client, http_client


async def _close_pair(
    client: ImageSourcesClient, http_client: httpx.AsyncClient
) -> None:
    await client.aclose()
    await http_client.aclose()


def build_router_app(client: Any) -> FastAPI:
    app = FastAPI()
    app.include_router(image_sources_router_factory(client=client))
    return app


# ==================== 1-2. 契约与状态映射（独立 router app） ====================


@pytest.mark.parametrize(
    ("upstream_status", "envelope_status"),
    [
        (200, "available"),
        (429, "rate_limited"),
        (500, "unavailable"),
        (503, "unavailable"),
    ],
)
def test_typed_provider_status_returns_200_with_header(
    upstream_status: int, envelope_status: str
) -> None:
    payload: Any = ok_payload() if upstream_status == 200 else {"error": {"code": "x"}}
    recorder = Recorder(json_responder(payload, upstream_status))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/image-sources/search", json={"query": "西湖"}
            )
            assert response.status_code == 200
            assert response.headers["x-image-sources-status"] == envelope_status
            assert response.json()["status"] == envelope_status
            assert recorder.calls == 1
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_available_envelope_transparent_to_http() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/image-sources/search", json={"query": "西湖"}
            )
            assert response.status_code == 200
            body = response.json()
            assert body["status"] == "available"
            assert body["checked_at"] == FIXED_NOW.isoformat()
            assert body["fetched_at"] == FIXED_NOW.isoformat()
            assert body["requested_query"] == "西湖"
            assert body["source"]["provider"] == "wikimedia-commons"
            item = body["items"][0]
            assert item["title"] == "File:West Lake 01.jpg"
            assert item["thumbUrl"].startswith("https://upload.wikimedia.org/")
            assert item["imageUrl"].startswith("https://upload.wikimedia.org/")
            assert item["descriptionUrl"].startswith(
                "https://commons.wikimedia.org/"
            )
            assert item["license"] == "CC BY-SA 4.0"
            assert item["artist"] == "张三"  # HTML 已剥离
            assert item["width"] == 4032
            assert item["height"] == 3024
            # 上游请求只带 query，不带任何多余字段。
            assert "gsrsearch" in recorder.requests[0].url.params
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_upstream_empty_maps_to_no_candidates_envelope() -> None:
    recorder = Recorder(
        json_responder({"batchcomplete": True})
    )
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/image-sources/search", json={"query": "冷门查询"}
            )
            assert response.status_code == 200
            assert response.headers["x-image-sources-status"] == "no_candidates"
            body = response.json()
            assert body["status"] == "no_candidates"
            assert body["items"] == []
            assert recorder.calls == 1
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_timeout_maps_to_200_timeout_envelope() -> None:
    def slow_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow")

    recorder = Recorder(slow_handler)
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/image-sources/search", json={"query": "西湖"}
            )
            assert response.status_code == 200
            assert response.headers["x-image-sources-status"] == "timeout"
            assert recorder.calls == 1
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
        {"query": "西" * 101},
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
                "/api/image-sources/search", json=body
            )
            assert response.status_code == 422
            assert recorder.calls == 0
            # 本端点所有 422 都是同一固定安全形状，不出现 input/字段原文。
            assert response.headers["x-image-sources-status"] == "invalid_request"
            text = response.content.decode("utf-8")
            assert json.loads(text) == {
                "detail": "query 必须为去除首尾空白后 1 到 100 个字符的文本",
                "report": None,
            }
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_query_emoji_100_accepted_101_rejected_at_http_boundary() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            query_100 = "🚀" * 100
            response = test_client.post(
                "/api/image-sources/search", json={"query": query_100}
            )
            assert response.status_code == 200
            assert response.headers["x-image-sources-status"] == "available"
            assert response.json()["requested_query"] == query_100
            assert recorder.calls == 1
            sent = recorder.requests[0].url.params["gsrsearch"]
            assert sent == query_100

            response_101 = test_client.post(
                "/api/image-sources/search", json={"query": "🚀" * 101}
            )
            assert response_101.status_code == 422
            assert (
                response_101.headers["x-image-sources-status"]
                == "invalid_request"
            )
            assert recorder.calls == 1
            response_101.content.decode("utf-8")
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_missing_body_is_422() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/image-sources/search",
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 422
            assert recorder.calls == 0
            assert response.headers["x-image-sources-status"] == "invalid_request"
            text = response.content.decode("utf-8")
            assert json.loads(text) == {
                "detail": "query 必须为去除首尾空白后 1 到 100 个字符的文本",
                "report": None,
            }
    finally:
        asyncio.run(_close_pair(client, http_client))


@pytest.mark.parametrize(
    "raw_body",
    [
        b'{"query":"ok","extra":"\\ud800"}',
        b'{"query":{"x":"\\ud800"}}',
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
            response = test_client.post(
                "/api/image-sources/search",
                content=raw_body,
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 422
            assert response.headers["x-image-sources-status"] == "invalid_request"
            assert recorder.calls == 0
            text = response.content.decode("utf-8")
            json.loads(text)
            assert "ud800" not in text.lower()
            assert "extra" not in text
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
                "/api/image-sources/search",
                content=raw_body,
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 422
            assert response.headers["x-image-sources-status"] == "invalid_request"
            assert recorder.calls == 0
            text = response.content.decode("utf-8")
            json.loads(text)
            assert "ud800" not in text.lower()
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_ascii_json_lone_surrogate_query_is_422_without_transport() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            raw_body = b'{"query":"\\ud800abc"}'
            response = test_client.post(
                "/api/image-sources/search",
                content=raw_body,
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 422
            assert response.headers["x-image-sources-status"] == "invalid_request"
            assert recorder.calls == 0
            text = response.content.decode("utf-8")
            payload = json.loads(text)
            assert payload["report"] is None
            assert "ud800" not in text.lower()
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_ascii_json_valid_surrogate_pair_decodes_to_emoji_and_is_accepted() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = build_router_app(client)
    try:
        with TestClient(app) as test_client:
            raw_body = b'{"query":"\\ud83d\\ude80 \\u897f\\u6e56"}'
            response = test_client.post(
                "/api/image-sources/search",
                content=raw_body,
                headers={"Content-Type": "application/json"},
            )
            assert response.status_code == 200
            assert response.headers["x-image-sources-status"] == "available"
            assert response.json()["requested_query"] == "🚀 西湖"
            assert recorder.calls == 1
            sent = recorder.requests[0].url.params["gsrsearch"]
            assert sent == "🚀 西湖"
    finally:
        asyncio.run(_close_pair(client, http_client))


def test_other_routes_keep_fastapi_default_422_shape() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = FastAPI()
    app.include_router(image_sources_router_factory(client=client))

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
            assert "x-image-sources-status" not in response.headers
            assert recorder.calls == 0
    finally:
        asyncio.run(_close_pair(client, http_client))


# ==================== 4. client 不可用 → 503 ====================


def test_router_before_lifespan_returns_fixed_503() -> None:
    app = FastAPI()
    app.include_router(image_sources_router_factory())
    # 不进入 TestClient 上下文：真实模拟 lifespan 从未运行、state 无 client。
    test_client = TestClient(app)
    try:
        response = test_client.post(
            "/api/image-sources/search", json={"query": "西湖"}
        )
        assert response.status_code == 503
        assert response.json()["detail"] == "图片搜索服务未初始化，请稍后再试。"
    finally:
        test_client.close()


class _ExplodingClient:
    def __init__(self, **kwargs: Any) -> None:
        raise RuntimeError("boom")


def test_init_failure_returns_fixed_503(monkeypatch) -> None:
    app = FastAPI()
    with monkeypatch.context() as patch:
        patch.setattr(image_sources_api, "ImageSourcesClient", _ExplodingClient)
        app.include_router(image_sources_router_factory())
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/image-sources/search", json={"query": "西湖"}
            )
            assert response.status_code == 503
            assert response.json()["detail"] == "图片搜索服务未初始化，请稍后再试。"


def test_owned_client_closed_after_shutdown() -> None:
    """默认 lifespan 自建 client，shutdown 后关闭并清空 state。"""

    app = FastAPI()
    app.include_router(image_sources_router_factory())
    with TestClient(app):
        # lifespan 真实创建 owned client（不发请求、零出站）。
        assert app.state.image_sources_client is not None
    assert app.state.image_sources_client is None


# ==================== 5. app 级来源守卫覆盖新 POST ====================


def test_malicious_origin_post_is_403_with_zero_provider_calls() -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    app = FastAPI()
    # 生产 api_server 的 app 级来源守卫按方法拦截 POST；独立 app 显式装同款
    # 中间件（BrowserOriginGuardMiddleware + 默认 CORS 白名单）等价复现。
    app.add_middleware(api_server.BrowserOriginGuardMiddleware)
    app.include_router(image_sources_router_factory(client=client))
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/image-sources/search",
                json={"query": "西湖"},
                headers={"Origin": "https://evil.example"},
            )
            assert response.status_code == 403
            assert recorder.calls == 0
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
    app.include_router(image_sources_router_factory(client=client))
    try:
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/image-sources/search",
                json={"query": "西湖"},
                headers={"Origin": "http://127.0.0.1:5173"},
            )
            assert response.status_code == 200
            assert response.json()["status"] == "available"
            assert recorder.calls == 1
    finally:
        asyncio.run(_close_pair(client, http_client))


# ==================== 6. 生产 api_server 接线 ====================


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


def test_production_openapi_registers_image_sources_post() -> None:
    schema = api_server.app.openapi()
    assert "/api/image-sources/search" in schema["paths"]
    operation = schema["paths"]["/api/image-sources/search"]
    assert "post" in operation
    # 既有业务路径没有因为接入新路由而消失。
    assert "/api/trips/plan" in schema["paths"]
    assert "/api/weather/day" in schema["paths"]
    assert "/api/poi-sources/nearby" in schema["paths"]
    assert "/api/web-sources/search" in schema["paths"]


def test_production_image_sources_with_injected_mock_client(
    production_client: TestClient,
) -> None:
    recorder = Recorder(json_responder(ok_payload()))
    client, http_client = make_client(recorder)
    api_server.app.state.image_sources_client = client
    try:
        response = production_client.post(
            "/api/image-sources/search", json={"query": "西湖"}
        )
        assert response.status_code == 200
        assert response.json()["status"] == "available"
        assert recorder.calls == 1
        sent = recorder.requests[0].url.params["gsrsearch"]
        assert sent == "西湖"

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
    api_server.app.state.image_sources_client = client
    try:
        response = production_client.post(
            "/api/image-sources/search",
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

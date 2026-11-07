# -*- coding: utf-8 -*-
"""Wikimedia Commons 图片搜索 HTTP 路由（独立模块，不 import api_server）。

契约（docs/IMAGE_SOURCES.md）：

- ``POST /api/image-sources/search``，JSON body 仅 ``{"query": <str>}``。
- 本地校验失败（缺 query/非字符串/trim 后空/超 100 码点/孤立代理码点/
  多余字段/非对象/坏 JSON）HTTP 422 且 0 次 provider 请求。本 router 的
  ``RequestValidationError`` 由自定义 APIRoute 折成固定安全 422：不读取
  errors 的 input/字段名、不回显原始 body；只影响本路由，不改全 app 默认
  422 形状，也不吞其他异常。
- provider 结果统一 HTTP 200 返回 typed 独立信封（ImageSearchReport 原样），
  no_candidates/timeout/rate_limited/unavailable/failed 不改状态码、
  不重试、不阻塞业务；invalid_request → HTTP 422（body 内保留完整信封，
  结构不变）。
- client 不可用（lifespan 未运行或初始化失败）时路由返回固定 503，不回显
  异常文本/URL；健康检查与其它路由不受影响。
- ``asyncio.CancelledError`` 原样上抛，不折算成任何响应。

生命周期（与 weather_api.py / poi_sources_api.py / tavily_web_api.py 相同的
已确证机制）：``APIRouter`` 支持 ``lifespan=`` 参数，
``FastAPI.include_router`` 合并执行 router lifespan。api_server 只需要：

    from image_sources_api import image_sources_router_factory

    app.include_router(image_sources_router_factory())

client 归属：每个 app/worker 一个独立 ImageSourcesClient，由本 router 的
lifespan 创建并存入 ``app.state.image_sources_client``，shutdown 时 close。
显式传入 ``client=`` 时由调用方管理生命周期，lifespan 不覆盖也不关闭。

无 Key：Commons API 不需要认证，本模块不读任何环境变量；模块 import 不发
任何网络请求。

写请求防护：POST 由 app 级 ``BrowserOriginGuardMiddleware`` / CORS 按方法
统一拦截（无路径枚举），本模块不复制、不绕过该守卫。
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator, Callable

import httpx  # noqa: F401 — 与 image_sources_client 同版本约束，显式声明依赖面
from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response

from image_sources_client import ImageSourcesClient, ImageSearchReport, normalize_image_query

# ==================== 常量 ====================

# 固定短句，不回显异常/URL/合成 token。
_IMAGE_SOURCES_UNAVAILABLE_DETAIL = "图片搜索服务未初始化，请稍后再试。"
_INVALID_QUERY_DETAIL = "query 必须为去除首尾空白后 1 到 100 个字符的文本"

# 运行时 client 类型判定基准：在模块导入时刻绑定真实类。测试可能替换模块
# 属性 ImageSourcesClient（spy 构造函数）后再调工厂，handler 内的类型检查
# 仍按导入时的真实契约判定，不被 patch 拖垮。
_CLIENT_TYPE = ImageSourcesClient


# ==================== 请求体模型（本地校验，422 且 0 provider 请求） ====================


class ImageSearchRequestBody(BaseModel):
    """仅接受 ``{"query": str}``；多余字段一律拒绝（fail-closed）。"""

    model_config = ConfigDict(extra="forbid")

    query: Annotated[str, Field()]


def _invalid_body_response() -> JSONResponse:
    """本端点唯一的 422 形状：固定 detail + report=None，绝不回显 input。"""

    return JSONResponse(
        status_code=422,
        content={"detail": _INVALID_QUERY_DETAIL, "report": None},
        headers={"x-image-sources-status": "invalid_request"},
    )


class _SafeValidationRoute(APIRoute):
    """仅本 router 使用：请求解析错误 → 固定安全 422。

    FastAPI 默认 422 会把 Pydantic errors 的 input 原样放进 JSONResponse；
    含孤立代理码点的 input 会在 UTF-8 编码时抛 UnicodeEncodeError → 500。
    这里不读取 errors()/input/字段名，也不透传原始 body；只返回本端点既有
    的固定 422 信封。另仅把 FastAPI 对非 UTF-8 body 的解析 400（cause 为
    UnicodeDecodeError）折成同一 422；其他异常（真实程序 bug）原样上抛。
    """

    def get_route_handler(self) -> Callable[[Request], Any]:
        original_route_handler = super().get_route_handler()

        async def safe_route_handler(request: Request) -> Response:
            try:
                return await original_route_handler(request)
            except RequestValidationError:
                return _invalid_body_response()
            except StarletteHTTPException as exc:
                # FastAPI 对无法按 UTF-8 解码的 body 抛 400（cause 是
                # UnicodeDecodeError）；本端点按既有 422 合同固定处理。
                # 仅匹配该解析场景，其他 HTTPException/程序 bug 原样上抛。
                if exc.status_code == 400 and isinstance(
                    exc.__cause__, UnicodeDecodeError
                ):
                    return _invalid_body_response()
                raise

        return safe_route_handler


def _validate_body(
    body: ImageSearchRequestBody,
) -> tuple[str | None, JSONResponse | None]:
    """本地快速校验；返回 (规范化 query, 错误响应)。

    校验失败一律发生在发请求之前：返回 422 JSONResponse（带
    x-image-sources-status 头），规范化 query 为 None。成功时错误响应为 None。
    不抛 HTTPException：FastAPI 对 HTTPException 的默认 422 响应不带自定义头。
    """

    normalized = normalize_image_query(body.query)
    if normalized is None:
        return None, _invalid_body_response()
    return normalized, None


# ==================== 信封 → HTTP 响应 ====================


def _to_response(report: ImageSearchReport) -> JSONResponse:
    """typed 信封原样返回。

    available/no_candidates/timeout/rate_limited/unavailable/failed →
    HTTP 200；invalid_request → HTTP 422（body 内保留完整信封，结构不变）。
    """

    payload = report.model_dump(mode="json")
    if report.status == "invalid_request":
        return JSONResponse(
            status_code=422,
            content={"detail": payload["reason"], "report": payload},
            headers={"x-image-sources-status": "invalid_request"},
        )
    return JSONResponse(
        status_code=200,
        content=payload,
        headers={"x-image-sources-status": report.status},
    )


# ==================== Router 工厂 ====================


def image_sources_router_factory(
    *,
    client: ImageSourcesClient | None = None,
    total_deadline_seconds: float = 8.0,
    max_results: int = 10,
) -> APIRouter:
    """构造 Commons 图片搜索路由（集成者唯一入口）。

    - ``client=None``（默认）：lifespan 启动时为当前 app 自建一个独立
      ImageSourcesClient 存入 ``app.state.image_sources_client``，shutdown
      时 close。多个 app 各 include 一份工厂产出的 router，client 互相隔离。
    - ``client=<实例>``：由调用方管理生命周期，lifespan 不覆盖不关闭。
    - 其余参数透传给 ImageSourcesClient（总截止秒数与结果上限）。

    模块 import 不发请求；请求只在 handler 内经 client 发出。
    """

    if client is not None and not isinstance(client, ImageSourcesClient):
        raise TypeError("client 必须为 ImageSourcesClient 实例或 None")

    @asynccontextmanager
    async def image_sources_lifespan(app: Any) -> AsyncIterator[None]:
        if client is not None:
            # 外部注入：所有权在调用方，本 lifespan 不 close。
            app.state.image_sources_client = client
            yield
            return
        try:
            owned = ImageSourcesClient(
                total_deadline_seconds=total_deadline_seconds,
                max_results=max_results,
            )
        except Exception:
            # 初始化失败不拖死 app：只标记不可用，路由侧固定 503。
            app.state.image_sources_client = None
            yield
            return
        app.state.image_sources_client = owned
        try:
            yield
        finally:
            await owned.aclose()
            app.state.image_sources_client = None

    router = APIRouter(
        prefix="/api/image-sources",
        tags=["image-sources"],
        lifespan=image_sources_lifespan,
        route_class=_SafeValidationRoute,
    )

    @router.post(
        "/search",
        summary="按用户显式查询搜索 Wikimedia Commons 图片（含署名与许可）",
        response_model=ImageSearchReport,
        response_description="typed ImageSearchReport 信封（原样透传）",
        responses={
            422: {"description": "本地参数校验失败或 client 判定 invalid_request（0 provider 请求）"},
            503: {"description": "图片搜索 client 不可用（不回显原因）"},
        },
    )
    async def search_image_sources(
        request: Request,
        body: ImageSearchRequestBody,
    ) -> JSONResponse:
        # 本地校验先于任何 provider 请求；非法输入 422 且 0 请求。
        normalized_query, local_error = _validate_body(body)
        if local_error is not None:
            return local_error
        assert normalized_query is not None  # 无错误响应时必已规范化

        image_client: Any = getattr(request.app.state, "image_sources_client", None)
        if not isinstance(image_client, _CLIENT_TYPE):
            # lifespan 未运行、或初始化失败、或已关闭：固定 503，不回显原因。
            raise HTTPException(
                status_code=503, detail=_IMAGE_SOURCES_UNAVAILABLE_DETAIL
            )

        try:
            # 只发送本地已规范化的值，避免无效原文进入信封/上游。
            report = await image_client.search(normalized_query)
        except asyncio.CancelledError:
            raise
        except Exception:
            # client 契约是不抛业务异常；这里只兜意外实现 bug，同样不回显。
            raise HTTPException(
                status_code=503, detail=_IMAGE_SOURCES_UNAVAILABLE_DETAIL
            )

        return _to_response(report)

    return router

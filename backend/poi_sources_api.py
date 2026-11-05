# -*- coding: utf-8 -*-
"""POI 公开资料候选 HTTP 路由（独立模块，不 import api_server）。

契约（poi-sources-brief.md）：

- ``GET /api/poi-sources/nearby?lat=<WGS84>&lon=<WGS84>``
- 两个参数必填；坏输入（缺失/布尔/非有限/越界）HTTP 422 且 0 次 provider
  请求（422 由本地校验产生，或由 client 的 invalid_request 转换）。
- provider 结果统一 HTTP 200 返回 typed 独立信封（PoiSourceReport 原样），
  no_candidates/timeout/rate_limited/unavailable/failed 不改状态码、
  不重试、不阻塞业务。
- client 不可用（lifespan 未运行或初始化失败）时路由返回固定 503，不回显
  异常文本/URL/任何合成 token；健康检查与其它路由不受影响。
- ``asyncio.CancelledError`` 原样上抛，不折算成任何响应。

生命周期（与 weather_api.py 相同的已确证机制）：``APIRouter`` 支持
``lifespan=`` 参数，``FastAPI.include_router`` 合并执行 router lifespan。
api_server 只需要：

    from poi_sources_api import poi_sources_router_factory

    app.include_router(poi_sources_router_factory())

client 归属：每个 app/worker 一个独立 PoiSourcesClient，由本 router 的
lifespan 创建并存入 ``app.state.poi_sources_client``，shutdown 时 close。
显式传入 ``client=`` 时由调用方管理生命周期，lifespan 不覆盖也不关闭。

模块 import 不发任何网络请求、不读取 .env。
"""

from __future__ import annotations

import asyncio
import math
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator

import httpx  # noqa: F401 — 与 poi_sources_client 同版本约束，显式声明依赖面
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from poi_sources_client import PoiSourceReport, PoiSourcesClient

# ==================== 常量 ====================

_LAT_MIN, _LAT_MAX = -90.0, 90.0
_LON_MIN, _LON_MAX = -180.0, 180.0

# 固定短句，不回显异常/URL/合成 token。
_POI_UNAVAILABLE_DETAIL = "兴趣点公开资料服务未初始化，请稍后再试。"


# ==================== 本地校验（422 且 0 provider 请求） ====================


def _is_finite(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def _validate_query(lat: float, lon: float) -> tuple[float, float]:
    """本地快速校验；任何失败都发生在发请求之前。"""

    if not _is_finite(lat) or not (_LAT_MIN <= float(lat) <= _LAT_MAX):
        raise HTTPException(status_code=422, detail="lat 必须为 -90 到 90 之间的有限数值")
    if not _is_finite(lon) or not (_LON_MIN <= float(lon) <= _LON_MAX):
        raise HTTPException(status_code=422, detail="lon 必须为 -180 到 180 之间的有限数值")
    return float(lat), float(lon)


# ==================== 信封 → HTTP 响应 ====================


def _to_response(report: PoiSourceReport) -> JSONResponse:
    """typed 信封原样返回。

    available/no_candidates/timeout/rate_limited/unavailable/failed → HTTP 200；
    invalid_request → HTTP 422（body 内保留完整信封，结构不变）。
    """

    payload = report.model_dump(mode="json")
    if report.status == "invalid_request":
        return JSONResponse(
            status_code=422,
            content={"detail": payload["reason"], "report": payload},
            headers={"x-poi-sources-status": "invalid_request"},
        )
    return JSONResponse(
        status_code=200,
        content=payload,
        headers={"x-poi-sources-status": report.status},
    )


# ==================== Router 工厂 ====================


def poi_sources_router_factory(
    *,
    client: PoiSourcesClient | None = None,
    total_deadline_seconds: float = 8.0,
    cache_ttl_seconds: float = 300.0,
    cache_max_keys: int = 128,
) -> APIRouter:
    """构造 POI 公开资料候选路由（集成者唯一入口）。

    - ``client=None``（默认）：lifespan 启动时为当前 app 自建一个独立
      PoiSourcesClient 存入 ``app.state.poi_sources_client``，shutdown 时
      close。多个 app 各 include 一份工厂产出的 router，client 互相隔离。
    - ``client=<实例>``：由调用方管理生命周期，lifespan 不覆盖不关闭。
    - 其余参数透传给 PoiSourcesClient（总截止秒数与缓存配置）。

    模块 import 不发请求；请求只在 handler 内经 client 发出。
    """

    if client is not None and not isinstance(client, PoiSourcesClient):
        raise TypeError("client 必须为 PoiSourcesClient 实例或 None")

    @asynccontextmanager
    async def poi_sources_lifespan(app: Any) -> AsyncIterator[None]:
        if client is not None:
            # 外部注入：所有权在调用方，本 lifespan 不 close。
            app.state.poi_sources_client = client
            yield
            return
        try:
            owned = PoiSourcesClient(
                total_deadline_seconds=total_deadline_seconds,
                cache_ttl_seconds=cache_ttl_seconds,
                cache_max_keys=cache_max_keys,
            )
        except Exception:
            # 初始化失败不拖死 app：只标记不可用，路由侧固定 503。
            app.state.poi_sources_client = None
            yield
            return
        app.state.poi_sources_client = owned
        try:
            yield
        finally:
            await owned.aclose()
            app.state.poi_sources_client = None

    router = APIRouter(
        prefix="/api/poi-sources", tags=["poi-sources"], lifespan=poi_sources_lifespan
    )

    @router.get(
        "/nearby",
        summary="查询某坐标附近的 OSM 公开资料候选（100m，未确认身份）",
        response_model=PoiSourceReport,
        response_description="typed PoiSourceReport 信封（原样透传）",
        responses={
            422: {"description": "本地参数校验失败或 client 判定 invalid_request（0 provider 请求）"},
            503: {"description": "POI 公开资料 client 不可用（不回显原因）"},
        },
    )
    async def get_poi_sources_nearby(
        request: Request,
        lat: Annotated[float, Query(description="WGS84 纬度，范围 -90..90")],
        lon: Annotated[float, Query(description="WGS84 经度，范围 -180..180")],
    ) -> JSONResponse:
        # 缺参/布尔/非有限由 FastAPI 422 或此处拦截，全部在发请求前。
        vlat, vlon = _validate_query(lat, lon)

        poi_client: Any = getattr(request.app.state, "poi_sources_client", None)
        if not isinstance(poi_client, PoiSourcesClient):
            # lifespan 未运行、或初始化失败、或已关闭：固定 503，不回显原因。
            raise HTTPException(status_code=503, detail=_POI_UNAVAILABLE_DETAIL)

        try:
            report = await poi_client.fetch_nearby(vlat, vlon)
        except asyncio.CancelledError:
            raise
        except Exception:
            # client 契约是不抛业务异常；这里只兜意外实现 bug，同样不回显。
            raise HTTPException(status_code=503, detail=_POI_UNAVAILABLE_DETAIL)

        return _to_response(report)

    return router

# -*- coding: utf-8 -*-
"""天气日预报 HTTP 路由（阶段 2，独立模块，不 import api_server）。

契约（weather-brief.md）：

- ``GET /api/weather/day?lat=<WGS84>&lon=<WGS84>&date=YYYY-MM-DD``
- 三个参数必填；坏输入（缺失/非有限/越界/非法日期）HTTP 422 且 0 次
  provider 请求（422 由本地校验产生，或由 client 的 invalid_request 转换）。
- provider 结果统一 HTTP 200 返回 typed 独立信封（WeatherDayReport 原样），
  timeout/unavailable/failed/out_of_range 不改状态码、不重试、不阻塞业务。
- client 不可用（lifespan 未运行或初始化失败）时路由返回固定 503，不回显
  异常文本/URL/任何合成 token；健康检查与其它路由不受影响。
- ``asyncio.CancelledError`` 原样上抛，不折算成任何响应。

生命周期（本机 fastapi 0.162.0 + repo 最低 fastapi>=0.115.0 均已确证）：

``APIRouter`` 支持 ``lifespan=`` 参数（自 fastapi 0.93.0 起，PR #2944），
``FastAPI.include_router`` 通过 ``_merge_lifespan_context`` 把 router 的
lifespan 与 app 的 lifespan 合并执行（先 app 后 router，先关 router 后关 app）。
因此 api_server 只需要：

    from weather_api import weather_router_factory

    app.include_router(weather_router_factory())

一行 include_router，无需改动现有 ``lifespan`` 函数。

client 归属：每个 app/worker 一个独立 WeatherClient，由本 router 的 lifespan
创建并存入 ``app.state.weather_client``，shutdown 时 ``aclose``。显式传入
``client=`` 时由调用方管理生命周期，lifespan 不覆盖也不关闭它。

模块 import 不发任何网络请求。
"""

from __future__ import annotations

import asyncio
import math
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator

import httpx  # noqa: F401 — 与 weather_client 同版本约束，显式声明依赖面
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from weather_client import WeatherClient, WeatherDayReport

# ==================== 常量 ====================

_LAT_MIN, _LAT_MAX = -90.0, 90.0
_LON_MIN, _LON_MAX = -180.0, 180.0

# 固定短句，不回显异常/URL/合成 token。
_WEATHER_UNAVAILABLE_DETAIL = "天气服务未初始化，请稍后再试。"


# ==================== 本地校验（422 且 0 provider 请求） ====================


def _is_finite(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def _validate_query(lat: float, lon: float, date: str) -> tuple[float, float, str]:
    """本地快速校验；任何失败都发生在发请求之前。

    只做有限性/范围/格式校验；"2026-02-30" 这类格式正确但不是真实日历日的
    输入交由 client 的 invalid_request 判定（同样 0 provider 请求，422）。
    """

    if not _is_finite(lat) or not (_LAT_MIN <= float(lat) <= _LAT_MAX):
        raise HTTPException(status_code=422, detail="lat 必须为 -90 到 90 之间的有限数值")
    if not _is_finite(lon) or not (_LON_MIN <= float(lon) <= _LON_MAX):
        raise HTTPException(status_code=422, detail="lon 必须为 -180 到 180 之间的有限数值")
    if not isinstance(date, str) or len(date) != 10 or date[4] != "-" or date[7] != "-":
        raise HTTPException(status_code=422, detail="date 必须为格式 YYYY-MM-DD 的真实日历日")
    return float(lat), float(lon), date


# ==================== 信封 → HTTP 响应 ====================


def _to_response(report: WeatherDayReport) -> JSONResponse:
    """typed 信封原样返回。

    available/out_of_range/timeout/unavailable/failed → HTTP 200；
    invalid_request → HTTP 422（body 内保留完整信封，结构不变）。
    """

    payload = report.model_dump(mode="json")
    if report.status == "invalid_request":
        return JSONResponse(
            status_code=422,
            content={"detail": payload["reason"], "report": payload},
            headers={"x-weather-status": "invalid_request"},
        )
    return JSONResponse(
        status_code=200,
        content=payload,
        headers={"x-weather-status": report.status},
    )


# ==================== Router 工厂 ====================


def weather_router_factory(
    *,
    client: WeatherClient | None = None,
    total_deadline_seconds: float = 8.0,
) -> APIRouter:
    """构造天气路由（集成者唯一入口）。

    - ``client=None``（默认）：lifespan 启动时为当前 app 自建一个独立
      WeatherClient 存入 ``app.state.weather_client``，shutdown 时 close。
      多个 app 各 include 一份工厂产出的 router，client 互相隔离。
    - ``client=<实例>``：由调用方管理生命周期，lifespan 不覆盖不关闭。
    - ``total_deadline_seconds``：透传给 WeatherClient 的总截止秒数。

    模块 import 不发请求；请求只在 handler 内经 client 发出。
    """

    if client is not None and not isinstance(client, WeatherClient):
        raise TypeError("client 必须为 WeatherClient 实例或 None")

    @asynccontextmanager
    async def weather_lifespan(app: Any) -> AsyncIterator[None]:
        if client is not None:
            # 外部注入：所有权在调用方，本 lifespan 不 close。
            app.state.weather_client = client
            yield
            # 不清空引用：app 关闭后 state 随之消亡，保留便于调试。
            return
        try:
            owned = WeatherClient(total_deadline_seconds=total_deadline_seconds)
        except Exception:
            # 初始化失败不拖死 app：只标记不可用，路由侧固定 503。
            app.state.weather_client = None
            yield
            return
        app.state.weather_client = owned
        try:
            yield
        finally:
            await owned.aclose()
            app.state.weather_client = None

    router = APIRouter(prefix="/api/weather", tags=["weather"], lifespan=weather_lifespan)

    @router.get(
        "/day",
        summary="查询某坐标某日的 Open-Meteo 日预报",
        response_model=WeatherDayReport,
        response_description="typed WeatherDayReport 信封（原样透传）",
        responses={
            422: {"description": "本地参数校验失败或 client 判定 invalid_request（0 provider 请求）"},
            503: {"description": "天气 client 不可用（不回显原因）"},
        },
    )
    async def get_weather_day(
        request: Request,
        lat: Annotated[float, Query(description="WGS84 纬度，范围 -90..90")],
        lon: Annotated[float, Query(description="WGS84 经度，范围 -180..180")],
        date: Annotated[str, Query(description="目标日期，格式 YYYY-MM-DD 的真实日历日")],
    ) -> JSONResponse:
        # 缺参由 FastAPI 422；此处再拦有限性/范围/格式，全部在发请求前。
        vlat, vlon, vdate = _validate_query(lat, lon, date)

        weather_client: Any = getattr(request.app.state, "weather_client", None)
        if not isinstance(weather_client, WeatherClient):
            # lifespan 未运行、或初始化失败、或已关闭：固定 503，不回显原因。
            raise HTTPException(status_code=503, detail=_WEATHER_UNAVAILABLE_DETAIL)

        try:
            report = await weather_client.fetch_day(vlat, vlon, vdate)
        except asyncio.CancelledError:
            raise
        except Exception:
            # client 契约是不抛业务异常；这里只兜意外实现 bug，同样不回显。
            raise HTTPException(status_code=503, detail=_WEATHER_UNAVAILABLE_DETAIL)

        return _to_response(report)

    return router

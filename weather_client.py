# -*- coding: utf-8 -*-
"""Open-Meteo 每日预报客户端（独立信封，不进 Trip v1）。

数据源：https://api.open-meteo.com/v1/forecast，免费 API 仅限非商业用途；
数据许可为 CC BY 4.0，对外展示时须附 "Weather data by Open-Meteo.com" 署名链接。
本模块只提供结构化的"单日预报查询"，不做 geocode、不迁移旧 MCP、不缓存。

设计要点（与 weather-brief.md 一致）：

- 请求参数固定，只做 GET 本域名，不收调用方 URL，不跟随重定向，无重试。
- 总 deadline（默认 8 秒）从请求发起计时，真实 asyncio 超时覆盖等待
  headers、每个 chunk 之间的全部空等；仅 per-read 超时挡不住慢流。
- 流式读取解压后 body 上限 128 KiB；``daily.time`` 至多 16 行。
- 所有错误折算为结果信封的状态字段，不向调用方抛 HTTP 异常；
  取消（``asyncio.CancelledError``）原样上抛。
- ``provider_http_status`` 走请求局部传递（成功返回值或失败异常属性），
  不存实例共享字段：并发请求各自的状态互不串值；无 HTTP 响应的失败
  （连接错误、超时等）为 None，不沿用上一次或另一个请求的状态。
  成功信封携带本请求真实 2xx 状态（201/202 原样保留），非 2xx 一律
  不按成功处理。
- ``checked_at`` 为本次调用开始处理的 UTC 时间（可注入 clock 便于测试）；
  ``fetched_at`` 只在成功收到并解析 provider 2xx 响应体后设置，失败不伪造。
- ``requested_date`` 为调用方请求的原始日期（已规范化）；非法日期输入为 None。
  六个变量都有已知官方单位且数值通过范围校验时才给出数值，否则该字段
  value 置 null 并进 missing_fields；0 与负温是真值不是缺值。
- 请求坐标与 provider 返回的网格中心坐标分开存放，verified 固定 False：
  网格中心可能偏离请求点，不代表站点精确坐标。
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
from datetime import date as _date
from datetime import datetime as _datetime
from datetime import timezone as _timezone
from typing import Any, Callable, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

# ==================== 固定契约 ====================

PROVIDER_ENDPOINT = "https://api.open-meteo.com/v1/forecast"
PROVIDER_DOCS_URL = "https://open-meteo.com/en/docs"
PROVIDER_ATTRIBUTION_URL = "https://open-meteo.com/"
PROVIDER_LICENSE = "CC BY 4.0"
PROVIDER_NAME = "open-meteo"

_DAILY_VARIABLES = (
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
    "precipitation_probability_max",
    "wind_speed_10m_max",
    "weather_code",
)

_MAX_FORECAST_DAYS = 16
_MAX_BODY_BYTES = 128 * 1024
_MAX_DAILY_ROWS = 16

# 六变量请求时固定单位；provider daily_units 与之不符时该字段 value 置 null。
_EXPECTED_UNITS: dict[str, set[str]] = {
    "temperature_2m_max": {"°C", "°c"},
    "temperature_2m_min": {"°C", "°c"},
    "precipitation_sum": {"mm"},
    "precipitation_probability_max": {"%"},
    "wind_speed_10m_max": {"km/h", "kmh"},
    "weather_code": {"wmo code", "wmo"},
}
# 概率合法区间与“必须非负”的变量；温度只要求 finite。
_PROB_RANGE = (0.0, 100.0)
_NON_NEGATIVE = ("precipitation_sum", "wind_speed_10m_max")
# utc_offset_seconds 的保守合法区间（现实世界 ±14h，留余量）。
_UTC_OFFSET_LIMIT = 60 * 60 * 16

_TIMEOUTS = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=2.0)
_DEFAULT_TOTAL_DEADLINE_SECONDS = 8.0
_LIMITS = httpx.Limits(max_connections=4, max_keepalive_connections=2)

_LAT_MIN, _LAT_MAX = -90.0, 90.0
_LON_MIN, _LON_MAX = -180.0, 180.0

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

WeatherStatus = Literal[
    "available",
    "out_of_range",
    "invalid_request",
    "timeout",
    "unavailable",
    "failed",
]

# 固定短句，不回显 provider 原文（原文可能含 URL、密钥或任意内容）。
_REASONS: dict[str, str] = {
    "invalid_lat": "纬度必须为 -90 到 90 之间的有限数值",
    "invalid_lon": "经度必须为 -180 到 180 之间的有限数值",
    "invalid_date": "日期必须为格式 YYYY-MM-DD 的真实日历日",
    "timeout": "天气服务请求超时",
    "unavailable": "天气服务暂时不可用",
    "failed": "天气服务响应格式异常",
    "out_of_range": "目标日期超出预报覆盖范围",
}

# ==================== WMO 天气代码（官方表内确定性映射） ====================

# 来源：官方文档 "WMO Weather interpretation codes (WW)" 表。
# 表外代码不做语义猜测，weather_desc 返回 None，UI 显示"未知"。
_WMO_DESCRIPTIONS_ZH: dict[int, str] = {
    0: "晴",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "大毛毛雨",
    56: "冻毛毛雨（轻）",
    57: "冻毛毛雨（浓）",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨（轻）",
    67: "冻雨（浓）",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "小阵雨",
    81: "阵雨",
    82: "强阵雨",
    85: "小阵雪",
    86: "大阵雪",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹",
}


def describe_weather_code(code: Any) -> str | None:
    """官方 WMO 表内返回中文描述；表外/非整数返回 None，不猜。"""
    if isinstance(code, bool) or not isinstance(code, int):
        return None
    return _WMO_DESCRIPTIONS_ZH.get(code)


# ==================== 输入校验 ====================


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def _parse_iso_date(value: Any) -> _date | None:
    """严格 YYYY-MM-DD 且为真实日历日；bool/其他类型一律拒绝。"""
    if not isinstance(value, str) or not _DATE_RE.match(value):
        return None
    try:
        return _date.fromisoformat(value)
    except ValueError:
        return None


# ==================== 响应信封（独立于 Trip v1） ====================


class WeatherCoordinate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: float
    lon: float


class WeatherCoordinateInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    system: Literal["WGS84"] = "WGS84"
    verified: bool = False
    requested: WeatherCoordinate
    grid: WeatherCoordinate | None = None
    grid_elevation_m: float | None = None


class WeatherSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = PROVIDER_NAME
    endpoint: str = PROVIDER_ENDPOINT
    docs_url: str = PROVIDER_DOCS_URL
    attribution_url: str = PROVIDER_ATTRIBUTION_URL
    license: str = PROVIDER_LICENSE


class WeatherCoverage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    first_date: str | None = None
    last_date: str | None = None
    count: int = 0


class WeatherDayForecast(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: str
    values: dict[str, float | int | None] = Field(default_factory=dict)
    units: dict[str, str | None] = Field(default_factory=dict)
    missing_fields: list[str] = Field(default_factory=list)


class WeatherDayReport(BaseModel):
    """fetch_day 的返回信封。所有失败路径都不抛异常，只设置 status/reason。"""

    model_config = ConfigDict(extra="forbid")

    status: WeatherStatus
    reason: str | None = None
    provider_http_status: int | None = None
    requested_date: str | None = None
    checked_at: str
    fetched_at: str | None = None
    provider_timezone: str | None = None
    provider_utc_offset_seconds: int | None = None
    coordinate: WeatherCoordinateInfo
    source: WeatherSource = Field(default_factory=WeatherSource)
    coverage: WeatherCoverage = Field(default_factory=WeatherCoverage)
    forecast: WeatherDayForecast | None = None


# ==================== 内部信号异常 ====================


class _BodyTooLarge(Exception):
    """携带本次请求 provider 状态的内部信号（供失败信封读取）。"""

    def __init__(
        self, message: str = "body too large",
        provider_http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.provider_http_status = provider_http_status


class _BadResponse(Exception):
    """携带本次请求 provider 状态的内部信号（供失败信封读取）。"""

    def __init__(
        self, message: str = "bad response",
        provider_http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.provider_http_status = provider_http_status


class _UpstreamHTTPError(httpx.HTTPError):
    """429/5xx 等上游不可用：作为 httpx.HTTPError 传播，同时携带本次状态。"""

    def __init__(
        self, message: str, provider_http_status: int | None = None
    ) -> None:
        super().__init__(message)
        self.provider_http_status = provider_http_status


# ==================== 客户端 ====================


class WeatherClient:
    """Open-Meteo 每日预报异步客户端。

    client 所有权：外部传入 ``httpx.AsyncClient`` 时由调用方负责关闭；
    不传时本类自建（带固定超时与连接上限）并在 :meth:`aclose` /
    ``__aexit__`` 中关闭。关闭幂等，重复调用无副作用。
    """

    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        total_deadline_seconds: float = _DEFAULT_TOTAL_DEADLINE_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        now_utc: Callable[[], _datetime] = lambda: _datetime.now(_timezone.utc),
    ) -> None:
        self._client = client
        self._owns_client = client is None
        if self._client is None:
            # 自建 client：固定超时与连接上限，不跟随重定向；由 aclose 关闭。
            self._client = httpx.AsyncClient(
                timeout=_TIMEOUTS, limits=_LIMITS, follow_redirects=False
            )
        self._total_deadline_seconds = float(total_deadline_seconds)
        self._clock = clock
        self._now_utc = now_utc
        self._closed = False

    async def __aenter__(self) -> "WeatherClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
        self._client = None
        self._closed = True

    # ---------- 公开接口 ----------

    async def fetch_day(self, lat: float, lon: float, date: str) -> WeatherDayReport:
        """查询单日预报。非法输入不发请求，直接返回 invalid_request。"""
        checked_at = self._now_utc().isoformat()
        # 非法坐标输入时 float() 可能 OverflowError（如超大 int），一并折算 invalid_request。
        try:
            coord = WeatherCoordinateInfo(
                requested=WeatherCoordinate(lat=float(lat), lon=float(lon))
            )
        except (OverflowError, ValueError, TypeError):
            coord = WeatherCoordinateInfo(
                requested=WeatherCoordinate(lat=0.0, lon=0.0)
            )

        target = _parse_iso_date(date)
        # requested_date：合法输入填规范化原 date；非法日期为 None。
        requested_date = target.isoformat() if target is not None else None

        lat_ok = False
        lon_ok = False
        try:
            lat_ok = _is_finite_number(lat) and _LAT_MIN <= float(lat) <= _LAT_MAX
            lon_ok = _is_finite_number(lon) and _LON_MIN <= float(lon) <= _LON_MAX
        except (OverflowError, ValueError, TypeError):
            pass
        if not lat_ok:
            return WeatherDayReport(
                status="invalid_request", reason=_REASONS["invalid_lat"],
                requested_date=requested_date,
                checked_at=checked_at, coordinate=coord,
            )
        if not lon_ok:
            return WeatherDayReport(
                status="invalid_request", reason=_REASONS["invalid_lon"],
                requested_date=requested_date,
                checked_at=checked_at, coordinate=coord,
            )
        if target is None:
            return WeatherDayReport(
                status="invalid_request", reason=_REASONS["invalid_date"],
                requested_date=requested_date,
                checked_at=checked_at, coordinate=coord,
            )

        request_lat = round(float(lat), 6)
        request_lon = round(float(lon), 6)
        try:
            payload, http_status, fetched_at = await self._fetch_payload(
                request_lat, request_lon
            )
        except asyncio.CancelledError:
            raise
        except httpx.TimeoutException:
            return WeatherDayReport(
                status="timeout", reason=_REASONS["timeout"],
                requested_date=requested_date,
                checked_at=checked_at, coordinate=coord,
            )
        except (httpx.HTTPError, OSError) as exc:
            # 状态只从本请求自己的异常读：OSError 等无 HTTP 响应的失败
            # 不带状态属性，保持 None，不沿用别的请求写入的值。
            return WeatherDayReport(
                status="unavailable", reason=_REASONS["unavailable"],
                requested_date=requested_date,
                checked_at=checked_at, coordinate=coord,
                provider_http_status=getattr(
                    exc, "provider_http_status", None
                ),
            )
        except (_BodyTooLarge, _BadResponse) as exc:
            return WeatherDayReport(
                status="failed", reason=_REASONS["failed"],
                requested_date=requested_date,
                checked_at=checked_at, coordinate=coord,
                provider_http_status=exc.provider_http_status,
            )

        coord = self._merge_grid(coord, payload)
        timezone_name, utc_offset = self._extract_timezone(payload)
        coverage = self._extract_coverage(payload)

        if coverage.count == 0:
            # daily.time 缺失/为空/乱序/重复：无法确认任何日期覆盖，保守 failed。
            return WeatherDayReport(
                status="failed", reason=_REASONS["failed"],
                requested_date=requested_date,
                provider_http_status=http_status, checked_at=checked_at,
                coordinate=coord,
                provider_timezone=timezone_name,
                provider_utc_offset_seconds=utc_offset,
            )

        if not (
            coverage.first_date
            and coverage.last_date
            and coverage.first_date <= target.isoformat() <= coverage.last_date
        ):
            return WeatherDayReport(
                status="out_of_range", reason=_REASONS["out_of_range"],
                requested_date=requested_date,
                provider_http_status=http_status, checked_at=checked_at,
                fetched_at=fetched_at, coordinate=coord,
                provider_timezone=timezone_name,
                provider_utc_offset_seconds=utc_offset, coverage=coverage,
            )

        daily_units = payload.get("daily_units")
        daily_units = daily_units if isinstance(daily_units, dict) else {}
        forecast = self._build_forecast(
            target.isoformat(), payload.get("daily"), daily_units
        )
        if forecast is None:
            return WeatherDayReport(
                status="failed", reason=_REASONS["failed"],
                requested_date=requested_date,
                provider_http_status=http_status, checked_at=checked_at,
                coordinate=coord,
                provider_timezone=timezone_name,
                provider_utc_offset_seconds=utc_offset, coverage=coverage,
            )

        return WeatherDayReport(
            status="available", provider_http_status=http_status,
            requested_date=requested_date,
            checked_at=checked_at, fetched_at=fetched_at, coordinate=coord,
            provider_timezone=timezone_name,
            provider_utc_offset_seconds=utc_offset, coverage=coverage,
            forecast=forecast,
        )

    # ---------- 内部实现 ----------

    def _build_query(self, lat: float, lon: float) -> dict[str, str]:
        # 参数与官方 OpenAPI 核对（weather-brief.md，2026-10-30），不编造。
        return {
            "latitude": f"{lat}",
            "longitude": f"{lon}",
            "daily": ",".join(_DAILY_VARIABLES),
            "timezone": "auto",
            "forecast_days": "16",
            "temperature_unit": "celsius",
            "wind_speed_unit": "kmh",
            "precipitation_unit": "mm",
            "cell_selection": "nearest",
        }

    async def _fetch_payload(
        self, lat: float, lon: float
    ) -> tuple[dict[str, Any], int, str]:
        """发请求、读 body、解析 JSON。

        返回 (payload, provider_http_status, fetched_at)。
        失败抛内部信号异常（异常属性携带本次请求自己的 provider 状态），
        由上层折算成信封状态；成功时返回本请求真实 2xx 状态，不硬写 200。
        状态一律走请求局部传递，不存实例共享字段，并发请求互不串值。

        总截止用 ``asyncio.wait_for`` 真实取消：覆盖等 headers、等 chunk
        之间的全部等待；到期时流上下文自动关闭，折算为 httpx 超时。
        """
        if self._closed or self._client is None:
            raise RuntimeError("WeatherClient 已关闭或未初始化 HTTP 客户端")

        deadline = self._clock() + self._total_deadline_seconds

        async def _do_request() -> tuple[bytes, int]:
            # follow_redirects 显式 False：外部注入的 client 可能开了 True。
            async with self._client.stream(
                "GET", PROVIDER_ENDPOINT, params=self._build_query(lat, lon),
                follow_redirects=False,
            ) as response:
                status = response.status_code
                if response.is_redirect:
                    raise _BadResponse(
                        "unexpected redirect", provider_http_status=status
                    )
                if status == 429 or status >= 500:
                    # 错误正文不需要解析：完全不消费并关闭，防无限错误流。
                    raise _UpstreamHTTPError(
                        f"provider unavailable: {status}",
                        provider_http_status=status,
                    )
                if not (200 <= status < 300):
                    raise _BadResponse(
                        "provider client error", provider_http_status=status
                    )
                try:
                    body = await self._bounded_read(response, deadline)
                except _BodyTooLarge as exc:
                    exc.provider_http_status = status
                    raise
                except httpx.TimeoutException:
                    raise
                except TimeoutError:
                    # _bounded_read 的假时钟/总 deadline 超时：内置 TimeoutError
                    # 是 OSError 子类，必须先放行给外层 timeout 分支。
                    raise
                except (httpx.HTTPError, OSError) as exc:
                    # headers 已收到、body 读到一半断开（ReadError 等）：
                    # 本次状态已知，用请求局部异常包装携带，不丢也不串；
                    # 只带异常类名，不回显原文/URL。TimeoutException 在上面
                    # 原样放行给外层 timeout 分支（超时口径维持 status None）。
                    raise _UpstreamHTTPError(
                        f"body read failed: {type(exc).__name__}",
                        provider_http_status=status,
                    ) from exc
                return body, status

        try:
            body, status = await asyncio.wait_for(
                _do_request(), timeout=self._total_deadline_seconds
            )
        except TimeoutError as exc:
            # 总 deadline 到期折算成 httpx 超时，调用方看到 timeout 而非 unavailable。
            raise httpx.TimeoutException("total deadline exceeded") from exc
        # fetched_at 在成功读完并确认 2xx body 之后取，不在网络开始前。
        fetched_at = self._now_utc().isoformat()

        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise _BadResponse(
                "not json", provider_http_status=status
            ) from None
        if not isinstance(payload, dict):
            raise _BadResponse(
                "root not object", provider_http_status=status
            )
        return payload, status, fetched_at

    async def _bounded_read(
        self, response: httpx.Response, deadline: float
    ) -> bytes:
        """流式读取解压后的 body，带 128 KiB 上限和总 deadline。"""
        chunks: list[bytes] = []
        received = 0
        async for chunk in response.aiter_bytes():
            received += len(chunk)
            if received > _MAX_BODY_BYTES:
                raise _BodyTooLarge()
            if self._clock() > deadline:
                raise TimeoutError("total deadline exceeded")
            chunks.append(chunk)
        return b"".join(chunks)

    # ---------- provider 数据抽取 ----------

    def _merge_grid(
        self, coord: WeatherCoordinateInfo, payload: dict[str, Any]
    ) -> WeatherCoordinateInfo:
        grid_lat = payload.get("latitude")
        grid_lon = payload.get("longitude")
        # 保守核验 WGS84 范围：越界的网格坐标不采信，保持 None。
        if (
            _is_finite_number(grid_lat)
            and _is_finite_number(grid_lon)
            and _LAT_MIN <= float(grid_lat) <= _LAT_MAX
            and _LON_MIN <= float(grid_lon) <= _LON_MAX
        ):
            coord = coord.model_copy(
                update={
                    "grid": WeatherCoordinate(lat=float(grid_lat), lon=float(grid_lon))
                }
            )
            elevation = payload.get("elevation")
            if _is_finite_number(elevation) and abs(float(elevation)) <= 10000.0:
                coord = coord.model_copy(
                    update={"grid_elevation_m": float(elevation)}
                )
        return coord

    def _extract_timezone(
        self, payload: dict[str, Any]
    ) -> tuple[str | None, int | None]:
        tz = payload.get("timezone")
        tz = tz if isinstance(tz, str) and tz else None
        offset = payload.get("utc_offset_seconds")
        if not _is_finite_number(offset):
            return tz, None
        # int(float) 会悄悄截小数：非整数或超出保守区间一律未知，不改值。
        f = float(offset)
        if not f.is_integer() or abs(f) > _UTC_OFFSET_LIMIT:
            return tz, None
        return tz, int(f)

    def _extract_coverage(self, payload: dict[str, Any]) -> "WeatherCoverage":
        daily = payload.get("daily")
        time_list = daily.get("time") if isinstance(daily, dict) else None
        if not isinstance(time_list, list) or not time_list:
            return WeatherCoverage()
        if len(time_list) > _MAX_DAILY_ROWS:
            # 行数超限：拒绝整仄覆盖，调用方按 failed 处理（count==0 分支）。
            return WeatherCoverage()
        dates: list[str] = []
        for item in time_list:
            d = _parse_iso_date(item)
            if d is None or d.isoformat() in dates:
                # 格式不合法或重复日期：结构不符，保守 failed。
                return WeatherCoverage()
            dates.append(d.isoformat())
        if not dates:
            return WeatherCoverage()
        # 覆盖必须真实严格递增，否则结构不符，保守 failed。
        if dates != sorted(dates):
            return WeatherCoverage()
        return WeatherCoverage(
            first_date=dates[0], last_date=dates[-1], count=len(dates)
        )

    def _build_forecast(
        self,
        target_iso: str,
        daily: Any,
        daily_units: dict[str, Any],
    ) -> WeatherDayForecast | None:
        if not isinstance(daily, dict):
            return None
        time_list = daily.get("time")
        if not isinstance(time_list, list) or target_iso not in time_list:
            return None
        idx = time_list.index(target_iso)

        values: dict[str, float | int | None] = {}
        units: dict[str, str | None] = {}
        missing: list[str] = []
        for name in _DAILY_VARIABLES:
            # 单位先行：缺失或与请求固定单位不符时该字段 value 置 null，
            # 不给裸数字；单位本身仍透传展示。
            unit = daily_units.get(name)
            unit = unit if isinstance(unit, str) and unit else None
            units[name] = unit
            expected = _EXPECTED_UNITS.get(name)
            unit_ok = unit is not None and (
                expected is None or unit.lower() in expected
            )

            arr = daily.get(name)
            value: float | int | None = None
            if isinstance(arr, list) and idx < len(arr):
                raw = arr[idx]
                # 0 是真 0，不是缺值；None/非数值才算缺失。int 保留 int
                # （weather_code、概率是整数语义），float 保留 float。
                if isinstance(raw, bool):
                    value = None
                elif isinstance(raw, int) and (
                    name != "weather_code" or -(2**31) <= raw <= 2**31 - 1
                ):
                    value = raw
                elif isinstance(raw, float) and math.isfinite(raw):
                    # weather_code 是整数语义：非整数浮点不可采信。
                    if name == "weather_code":
                        value = raw if raw.is_integer() else None
                    else:
                        value = raw
            # 数值约束：概率限 0..100，降水/风速必须非负；温度只要求 finite。
            # 越界视为 provider 数据不可信，value 置 null 而非静默透传。
            if value is not None:
                f = float(value)
                if name == "precipitation_probability_max" and not (
                    _PROB_RANGE[0] <= f <= _PROB_RANGE[1]
                ):
                    value = None
                elif name in _NON_NEGATIVE and f < 0.0:
                    value = None
            if value is None or not unit_ok:
                missing.append(name)
                value = None
            values[name] = value
        return WeatherDayForecast(
            date=target_iso, values=values, units=units, missing_fields=missing
        )

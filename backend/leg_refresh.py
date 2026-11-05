# -*- coding: utf-8 -*-
"""固定 WGS84 端点的单段衔接路线契约与离线 service（第一批）。

只提供纯模型与单次路线 service；HTTP 路由注册、运行时客户端创建与关闭、
前端组合契约都由后续批次负责，本模块不声称接口已上线。

service 不读取环境变量或 .env 文件、不接触密钥、不创建地图客户端或 HTTP
客户端；调用者注入已配置的 AMapClient（或 None）。高德 Web 服务的密钥按
接口约定走 query 参数，不是仅 header（仅 header 是 Tavily 之类服务的做法）；
本模块自身不接触密钥。

请求端点只按形状校验并原值回显：WGS84 -> GCJ-02 只用于传给既有 route，
route 返回的 geometry 已是 WGS84，不再二次转换；路网吸附只影响几何首末点，
不改写回显端点，也不把 geometry 首末点回填为站点坐标。
"""

from __future__ import annotations

import asyncio
import math
from datetime import date as _date
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from travel_itinerary import (
    MAX_DAYS,
    MAX_SAFE_JSON_INTEGER,
    AMapClient,
    AMapError,
    Coordinate,
    Leg,
    MapRefreshParent,
    RouteResult,
    _CONTROL_CHARS,
    _DATE_SHAPE_RE,
    _MAX_ROUTE_GEOMETRY_POINTS,
    _polyline_is_plausible,
    wgs84_to_gcj02,
)

__all__ = [
    "LegRefreshCoordinate",
    "LegRefreshStop",
    "LegRefreshRequest",
    "LegRefreshResponse",
    "LegRefreshSource",
    "refresh_leg_route",
]

LegRefreshStatus = Literal["ready", "no_key", "timeout", "unavailable", "failed"]

_ENDPOINTS: dict[str, str] = {
    "walking": "/v5/direction/walking",
    "driving": "/v5/direction/driving",
}

# 失败 reason 一律使用固定安全文案：不回显异常、Key、上游正文或路径。
_REASONS: dict[str, str] = {
    "no_key": "服务端未配置高德地图 Key，本次未执行任何路线查询。",
    "timeout": "衔接路线查询超时，本次未返回路线。",
    "unavailable": "高德地图路线服务暂时不可用，本次未返回路线。",
    "failed": "衔接路线数据不可用，本次未返回路线。",
}

_LEG_DESCRIPTIONS: dict[str, str] = {
    "walking": (
        "按两端记录的 WGS84 坐标向高德地图查询步行衔接段；未重新核对地址或"
        "地点身份，几何为路网吸附结果，端点坐标未改写。"
    ),
    "driving": (
        "按两端记录的 WGS84 坐标向高德地图查询驾车衔接段；未重新核对地址或"
        "地点身份，几何为路网吸附结果，端点坐标未改写。"
    ),
}

_BAD_DATA_CODES = {
    "bad_route",
    "bad_path",
    "bad_location",
    "missing_distance",
    "missing_polyline",
    "degenerate_polyline",
    "implausible_polyline",
    "bad_mode",
}
_NETWORK_CODES = {"http_error", "bad_json", "bad_response", "client_not_ready"}

_DEFAULT_TIMEOUT_SECONDS = 20.0
_MAX_TIMEOUT_SECONDS = 60.0


# ==================== 小工具 ====================


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _endpoint_for_mode(mode: str) -> str:
    return _ENDPOINTS[mode]


def _require_utf8_id(value: Any, label: str) -> str:
    """opaque id 原值校验：非空、无控制字符、UTF-8 可编码（挡下孤立代理）。"""

    if not isinstance(value, str):
        raise ValueError(f"{label} 必须是字符串")
    if not value.strip():
        raise ValueError(f"{label} 不能为空或全空白")
    if _CONTROL_CHARS.search(value) is not None:
        raise ValueError(f"{label} 不能包含控制字符")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{label} 必须是可编码的 UTF-8 文本") from exc
    return value


def _check_date_type(value: Any) -> Any:
    if value is not None and not isinstance(value, str):
        raise ValueError("date 必须是 YYYY-MM-DD 或 null")
    return value


def _validate_calendar_date(value: str | None) -> str | None:
    if value is None:
        return None
    if _DATE_SHAPE_RE.fullmatch(value) is None:
        raise ValueError("date 必须是 YYYY-MM-DD 或 null")
    try:
        parsed = _date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("date 必须是真实日历日期") from exc
    return parsed.isoformat()


def _validate_checked_at(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("checked_at 必须是 UTC ISO 时间") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ValueError("checked_at 必须是 UTC 时间")
    return value


def _finite_coordinate(point: Any) -> Coordinate | None:
    """只接受真实 Coordinate 且 lng/lat 是有限、有界的 WGS84 数值。"""

    if not isinstance(point, Coordinate):
        return None
    lng, lat = point.lng, point.lat
    if isinstance(lng, bool) or isinstance(lat, bool):
        return None
    if not isinstance(lng, (int, float)) or not isinstance(lat, (int, float)):
        return None
    try:
        lng_f, lat_f = float(lng), float(lat)
    except (OverflowError, ValueError, TypeError):
        return None
    if not (math.isfinite(lng_f) and math.isfinite(lat_f)):
        return None
    if not (-180.0 <= lng_f <= 180.0 and -90.0 <= lat_f <= 90.0):
        return None
    return Coordinate(lng=lng_f, lat=lat_f)


def _check_raw_number(value: Any, label: str, *, bound: float) -> None:
    """在 Pydantic  lax coerce 之前拒绝 bool / 字符串 / null / 非有限 / 越界数值。"""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} 必须是有限 JSON 数值")
    try:
        number = float(value)
    except (OverflowError, ValueError, TypeError) as exc:
        raise ValueError(f"{label} 必须是有限 JSON 数值") from exc
    if not math.isfinite(number):
        raise ValueError(f"{label} 必须是有限 JSON 数值")
    if not (-bound <= number <= bound):
        raise ValueError(f"{label} 超出合法范围")


def _check_raw_coordinate_point(point: Any) -> None:
    """原始 geometry 点：只接受数值型 lng/lat，不做任何转换。"""

    if isinstance(point, Coordinate):
        lng, lat = point.lng, point.lat
    elif isinstance(point, dict):
        lng, lat = point.get("lng"), point.get("lat")
    else:
        raise ValueError("leg.geometry 点必须是坐标对象")
    _check_raw_number(lng, "leg.geometry.lng", bound=180.0)
    _check_raw_number(lat, "leg.geometry.lat", bound=90.0)


def _check_raw_leg(value: Any) -> Any:
    """响应 leg 原始输入预校：bool / 字符串数值在 coerce 之前就失败。

    dict 是 raw JSON wire / raw dict 入口；Leg 实例是 service 返回值与既有
    model_construct 坏注入，保持原路线交给 after validator 在实例上校验。
    只检查并拒绝，不把非法值悄悄转成合法数字。
    """

    if value is None or isinstance(value, Leg):
        return value
    if not isinstance(value, dict):
        raise ValueError("leg 必须是对象或 null")

    distance = value.get("distance_m")
    if distance is not None:
        if isinstance(distance, bool) or not isinstance(distance, int):
            raise ValueError("leg.distance_m 必须是安全非负整数")
        if distance < 0 or distance > MAX_SAFE_JSON_INTEGER:
            raise ValueError("leg.distance_m 必须是安全非负整数")

    duration = value.get("duration_minutes")
    if duration is not None:
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            raise ValueError("leg.duration_minutes 必须是有限非负数或 null")
        try:
            number = float(duration)
        except (OverflowError, ValueError, TypeError) as exc:
            raise ValueError("leg.duration_minutes 必须是有限非负数或 null") from exc
        if not math.isfinite(number) or number < 0:
            raise ValueError("leg.duration_minutes 必须是有限非负数或 null")

    geometry = value.get("geometry")
    if geometry is not None:
        if not isinstance(geometry, list) or not (
            2 <= len(geometry) <= _MAX_ROUTE_GEOMETRY_POINTS
        ):
            raise ValueError("leg.geometry 必须含 2..5000 个合法 WGS84 点")
        for point in geometry:
            _check_raw_coordinate_point(point)
    return value


def _check_parent_raw(value: Any) -> Any:
    """parent 原始输入预校：revision 必须是非 bool 整数，trip_id 为 opaque UTF-8。"""

    if isinstance(value, MapRefreshParent):
        _require_utf8_id(value.trip_id, "parent.trip_id")
        return value
    if isinstance(value, dict):
        if "revision" in value:
            revision = value["revision"]
            if isinstance(revision, bool) or not isinstance(revision, int):
                raise ValueError("parent.revision 必须是 JSON 安全整数")
        if "trip_id" in value:
            _require_utf8_id(value["trip_id"], "parent.trip_id")
        return value
    return value


def _resolve_timeout_budget(value: Any) -> float:
    """坏预算（非数值 / bool / 非有限 / 非正）退到安全默认值并封顶。"""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return _DEFAULT_TIMEOUT_SECONDS
    try:
        number = float(value)
    except (OverflowError, ValueError, TypeError):
        return _DEFAULT_TIMEOUT_SECONDS
    if not math.isfinite(number) or number <= 0.0:
        return _DEFAULT_TIMEOUT_SECONDS
    return min(number, _MAX_TIMEOUT_SECONDS)


def _status_from_amap_error(exc: AMapError) -> LegRefreshStatus:
    code = getattr(exc, "code", None)
    if code == "timeout":
        return "timeout"
    if code == "missing_key":
        return "no_key"
    if isinstance(code, str):
        if code in _BAD_DATA_CODES:
            return "failed"
        if code in _NETWORK_CODES or code.startswith("http_") or code.isdigit():
            return "unavailable"
    return "unavailable"


def _gcj_from(location: LegRefreshCoordinate) -> Coordinate:
    lng, lat = wgs84_to_gcj02(float(location.lng), float(location.lat))
    return Coordinate(lng=lng, lat=lat)


def _build_navigation_leg(
    request: LegRefreshRequest, result: Any
) -> Leg | None:
    """不盲信注入客户端的 RouteResult：先校形状与几何，再构造 navigation leg。"""

    if not isinstance(result, RouteResult):
        return None
    distance_m = result.distance_m
    if isinstance(distance_m, bool) or not isinstance(distance_m, int):
        return None
    if distance_m < 0 or distance_m > MAX_SAFE_JSON_INTEGER:
        return None

    duration: float | None = None
    if result.duration_minutes is not None:
        value = result.duration_minutes
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        try:
            duration = float(value)
        except (OverflowError, ValueError, TypeError):
            return None
        if not math.isfinite(duration) or duration < 0:
            return None

    raw_geometry = result.geometry
    if not isinstance(raw_geometry, list):
        return None
    if not (2 <= len(raw_geometry) <= _MAX_ROUTE_GEOMETRY_POINTS):
        return None
    geometry: list[Coordinate] = []
    for point in raw_geometry:
        coordinate = _finite_coordinate(point)
        if coordinate is None:
            return None
        geometry.append(coordinate)
    if all(point == geometry[0] for point in geometry):
        return None

    # 既有合理性函数在同坐标系比较：请求端点本来就是 WGS84，geometry 已是
    # WGS84，不做第二次坐标转换，也不新增容差。
    wgs_origin = Coordinate(
        lng=request.from_stop.location.lng, lat=request.from_stop.location.lat
    )
    wgs_destination = Coordinate(
        lng=request.to_stop.location.lng, lat=request.to_stop.location.lat
    )
    if not _polyline_is_plausible(
        geometry, wgs_origin, wgs_destination, request.travel_mode
    ):
        return None

    return Leg(
        from_stop_id=request.from_stop.id,
        to_stop_id=request.to_stop.id,
        mode=request.travel_mode,
        route_type="navigation",
        distance_m=distance_m,
        duration_minutes=duration,
        geometry=geometry,
        description=_LEG_DESCRIPTIONS[request.travel_mode],
    )


# ==================== 严格契约模型 ====================


class LegRefreshCoordinate(BaseModel):
    """请求两端的 WGS84 坐标；0 与负值合法，null 不是 0。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    lng: float = Field(strict=True, ge=-180, le=180)
    lat: float = Field(strict=True, ge=-90, le=90)


class LegRefreshStop(BaseModel):
    """固定端点：opaque id 原文 + WGS84 坐标，不接名称 / 地址 / 几何。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    id: str = Field(min_length=1, max_length=100)
    location: LegRefreshCoordinate

    @field_validator("id", mode="before")
    @classmethod
    def _check_id(cls, value: Any) -> str:
        return _require_utf8_id(value, "站点 id")


class LegRefreshSource(BaseModel):
    """来源固定为 amap / WGS84 / 依 mode 固定的官方 v5 direction 端点。"""

    model_config = ConfigDict(extra="forbid")

    provider: Literal["amap"] = "amap"
    coordinate_system: Literal["WGS84"] = "WGS84"
    endpoint: Literal["/v5/direction/walking", "/v5/direction/driving"]


class LegRefreshRequest(BaseModel):
    """固定端点衔接路线请求；未知字段与非法数值一律拒绝。"""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    parent: MapRefreshParent
    day: int = Field(strict=True, ge=1, le=MAX_DAYS)
    date: str | None = None
    travel_mode: Literal["walking", "driving"]
    from_stop: LegRefreshStop
    to_stop: LegRefreshStop

    @field_validator("parent", mode="before")
    @classmethod
    def _reject_non_integer_revision(cls, value: Any) -> Any:
        return _check_parent_raw(value)

    @field_validator("date", mode="before")
    @classmethod
    def _date_type(cls, value: Any) -> Any:
        return _check_date_type(value)

    @field_validator("date")
    @classmethod
    def _date_calendar(cls, value: str | None) -> str | None:
        return _validate_calendar_date(value)

    @model_validator(mode="after")
    def _validate_stops(self) -> "LegRefreshRequest":
        if self.from_stop.id == self.to_stop.id:
            raise ValueError("起终点 id 必须不同")
        _require_utf8_id(self.parent.trip_id, "parent.trip_id")
        return self


class LegRefreshResponse(BaseModel):
    """回显请求字段 + 状态 / leg / reason / source / checked_at。

    ready 与失败状态内容互斥：ready 必须带一个 navigation leg 且 reason=null；
    失败必须 leg=null 且只返回固定安全 reason。不新增 warnings 之类的字段。
    """

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    parent: MapRefreshParent
    day: int = Field(strict=True, ge=1, le=MAX_DAYS)
    date: str | None = None
    travel_mode: Literal["walking", "driving"]
    from_stop: LegRefreshStop
    to_stop: LegRefreshStop
    map_status: LegRefreshStatus
    leg: Leg | None = None
    reason: str | None = None
    source: LegRefreshSource
    checked_at: str

    @field_validator("parent", mode="before")
    @classmethod
    def _parent_raw(cls, value: Any) -> Any:
        return _check_parent_raw(value)

    @field_validator("leg", mode="before")
    @classmethod
    def _leg_raw(cls, value: Any) -> Any:
        return _check_raw_leg(value)

    @field_validator("date", mode="before")
    @classmethod
    def _date_type(cls, value: Any) -> Any:
        return _check_date_type(value)

    @field_validator("date")
    @classmethod
    def _date_calendar(cls, value: str | None) -> str | None:
        return _validate_calendar_date(value)

    @field_validator("checked_at")
    @classmethod
    def _checked_at(cls, value: str) -> str:
        return _validate_checked_at(value)

    @model_validator(mode="after")
    def _validate_contract(self) -> "LegRefreshResponse":
        for label, value in (
            ("parent.trip_id", self.parent.trip_id),
            ("from_stop.id", self.from_stop.id),
            ("to_stop.id", self.to_stop.id),
        ):
            _require_utf8_id(value, label)
        if self.from_stop.id == self.to_stop.id:
            raise ValueError("起终点 id 必须不同")
        if self.source.endpoint != _endpoint_for_mode(self.travel_mode):
            raise ValueError("source.endpoint 必须与 travel_mode 一致")

        if self.map_status == "ready":
            if self.reason is not None:
                raise ValueError("ready 不得返回 reason")
            leg = self.leg
            if leg is None:
                raise ValueError("ready 必须返回 navigation leg")
            if leg.route_type != "navigation":
                raise ValueError("ready 只接受 navigation leg")
            if (
                leg.from_stop_id != self.from_stop.id
                or leg.to_stop_id != self.to_stop.id
                or leg.mode != self.travel_mode
            ):
                raise ValueError("leg 的 id / mode 必须与回显请求一致")
            distance = leg.distance_m
            if (
                isinstance(distance, bool)
                or not isinstance(distance, int)
                or distance < 0
                or distance > MAX_SAFE_JSON_INTEGER
            ):
                raise ValueError("leg.distance_m 必须是安全非负整数")
            duration = leg.duration_minutes
            if duration is not None:
                if isinstance(duration, bool) or not isinstance(duration, (int, float)):
                    raise ValueError("leg.duration_minutes 必须是有限非负数或 null")
                try:
                    duration_f = float(duration)
                except (OverflowError, ValueError, TypeError) as exc:
                    raise ValueError("leg.duration_minutes 必须是有限非负数或 null") from exc
                if not math.isfinite(duration_f) or duration_f < 0:
                    raise ValueError("leg.duration_minutes 必须是有限非负数或 null")
            geometry = leg.geometry
            if not isinstance(geometry, list) or not (
                2 <= len(geometry) <= _MAX_ROUTE_GEOMETRY_POINTS
            ):
                raise ValueError("leg.geometry 必须含 2..5000 个合法 WGS84 点")
            for point in geometry:
                if _finite_coordinate(point) is None:
                    raise ValueError("leg.geometry 含非法点")
            if all(point == geometry[0] for point in geometry):
                raise ValueError("leg.geometry 不是有效折线")
        else:
            if self.leg is not None:
                raise ValueError("失败状态必须 leg=null")
            if self.reason != _REASONS[self.map_status]:
                raise ValueError("失败状态必须返回固定安全 reason")
        return self


# ==================== service ====================


async def refresh_leg_route(
    request: LegRefreshRequest,
    amap: AMapClient | None,
    *,
    timeout_seconds: float = 20.0,
) -> LegRefreshResponse:
    """单次固定端点路线查询：无 Key 零调用，失败只返回固定安全 reason。

    不读取环境 / 密钥、不创建客户端；运行层负责注入并关闭 owned client。
    WGS84 端点只在此处转一次 GCJ-02 交给既有 route，route 的 geometry 已是
    WGS84，不二次转换、不回填回显端点、不生成直线降级 leg。
    """

    checked_at = _utc_now()  # 本次调用开始，不是资料更新时间
    source = LegRefreshSource(endpoint=_endpoint_for_mode(request.travel_mode))

    def build_response(
        status: LegRefreshStatus, *, leg: Leg | None = None
    ) -> LegRefreshResponse:
        return LegRefreshResponse(
            parent=request.parent,
            day=request.day,
            date=request.date,
            travel_mode=request.travel_mode,
            from_stop=request.from_stop,
            to_stop=request.to_stop,
            map_status=status,
            leg=leg,
            reason=_REASONS.get(status),
            source=source,
            checked_at=checked_at,
        )

    if amap is None or not getattr(amap, "configured", False):
        return build_response("no_key")

    budget = _resolve_timeout_budget(timeout_seconds)
    origin = _gcj_from(request.from_stop.location)
    destination = _gcj_from(request.to_stop.location)

    try:
        # 只 route 一次；无 geocode / POI / LLM / 重试 / 跟随重定向。
        result = await asyncio.wait_for(
            amap.route(origin, destination, request.travel_mode),
            timeout=budget,
        )
        # 不盲信注入客户端：先校 RouteResult 与 geometry 形状，再决定 ready。
        leg = _build_navigation_leg(request, result)
    except asyncio.CancelledError:
        raise  # 调用者取消继续传播，不转成 typed 失败
    except asyncio.TimeoutError:
        return build_response("timeout")
    except AMapError as exc:
        return build_response(_status_from_amap_error(exc))
    except Exception:
        return build_response("failed")

    if leg is None:
        return build_response("failed")
    return build_response("ready", leg=leg)

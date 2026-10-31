# -*- coding: utf-8 -*-
"""POI 公开资料候选客户端（OSM/Overpass，独立信封，不进 Trip v1）。

数据源固定为 https://overpass-api.de/api/interpreter（OpenStreetMap 协作地图
公开资料，OSM 许可为 ODbL 1.0，对外展示须附 openstreetmap.org/copyright 署名）。
本模块只提供结构化的"附近 POI 公开资料候选查询"：固定 100m 半径、
opening_hours/fee/charge 三标签 union、最多处理 30 个源元素、最多 8 个候选。
不做地理编码、不收任意用户 URL/QL、不自动大范围检索。

设计要点（与 poi-sources-brief.md 一致）：

- 结果是"公开资料候选"，``identity_status`` 永远 ``unconfirmed``：距离近、
  名称相似都不是身份确认；不修改 Trip/草稿/模型文案。
- opening_hours/fee/charge 只透传来源标签原文（state=source_only）；缺失、
  非法或超长为 unknown/null，不推断实时营业状态、免费与否或票价币种。
- 每条候选有真实 OSM type/id、按已校验 type/id 规范构造的 source_url、
  本次实际获取时间 retrieved_at、来源对象编辑时间 source_updated_at
  （缺失或非法为 null，绝不用当前时间填充）。
- way/relation 只用 center 坐标；中心超出 100m 半径的元素保守排除并记录
  在 notes 中（大 way/relation 的 bbox 可能触及半径而中心在外），不补坐标。
- typed 报告区分 available/no_candidates/invalid_request/timeout/
  rate_limited/unavailable/failed；available 必须至少有 1 个真实候选；
  no_candidates 表示本期未找到可用候选，不表示地点不存在。
- 上游 429 → rate_limited、5xx/网络错误 → unavailable、4xx/坏 JSON/缺
  elements/remark 错误/超 body → failed；失败返回空候选与固定短原因，
  不回显异常文本/URL/响应 HTML。``asyncio.CancelledError`` 原样上抛。
- 请求固定 GET data=<QL>，不跟随重定向、无重试；总 deadline 默认 8 秒
  覆盖等待 headers 与全部 body 读取；流式读取解压后上限 1 MiB。
- provider_http_status 走请求局部传递（返回值或异常属性），不存实例共享
  字段：并发请求各自的状态互不串值。
- 构造参数在任何 HTTP 资源分配之前校验：total_deadline_seconds 为大于 0
  的有限数值；cache_ttl_seconds 为大于等于 0 的有限数值（0 关闭缓存）；
  cache_max_keys 为大于等于 0 的整数（0 表示缓存永不保留任何键，等价于
  每次都打 provider）。非法配置直接抛 TypeError/ValueError，不留半初始化
  对象，也不遗留 owned client。
- element_id 上限为 JS 安全整数 2**53-1：超过的 id 无法被后续 JS 前端
  安全表达，按非法 id 排除；来源 URL 只由已校验的 type/id 构造。
- uid/user/changeset 等无关元数据一律忽略，不进入任何输出。
- 可选内存缓存（默认 5 分钟 TTL / 最多 128 键）：只缓存 available 与
  no_candidates，命中返回深拷贝并显式 cached=True，保留原 retrieved_at；
  不持久化。cache_ttl_seconds=0 或 cache_max_keys=0 均可关闭。
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
from collections import OrderedDict
from datetime import datetime as _datetime
from datetime import timezone as _timezone
from typing import Any, Callable, Literal, NamedTuple

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

# ==================== 固定契约 ====================

PROVIDER_ENDPOINT = "https://overpass-api.de/api/interpreter"
PROVIDER_DOCS_URL = "https://wiki.openstreetmap.org/wiki/Overpass_API"
PROVIDER_ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright"
PROVIDER_LICENSE = "ODbL 1.0"
PROVIDER_NAME = "overpass-api.de"

_OSM_BASE_URL = "https://www.openstreetmap.org"

_RADIUS_M = 100.0
_MAX_SOURCE_ELEMENTS = 30
_MAX_CANDIDATES = 8
_MAX_BODY_BYTES = 1024 * 1024
# 标签原文长度上限：超过按 unknown 处理，绝不截断后冒充原文。
_MAX_TAG_VALUE_CHARS = 300

# JS 安全整数上限：id 超过后前端 JSON.parse 无法安全表达，视为非法。
_MAX_SAFE_INTEGER = 2**53 - 1

# 服务端 QL timeout 小于客户端总 deadline，先到先断。
_QUERY_TIMEOUT_SECONDS = 6

_TIMEOUTS = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=2.0)
_DEFAULT_TOTAL_DEADLINE_SECONDS = 8.0
_LIMITS = httpx.Limits(max_connections=4, max_keepalive_connections=2)

_LAT_MIN, _LAT_MAX = -90.0, 90.0
_LON_MIN, _LON_MAX = -180.0, 180.0

_DEFAULT_CACHE_TTL_SECONDS = 300.0
_DEFAULT_CACHE_MAX_KEYS = 128

# OSM 对象编辑时间是 UTC 秒级 ISO 形如 2025-06-01T08:00:00Z；其余格式不采信。
_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

_ELEMENT_TYPES = ("node", "way", "relation")

PoiSourceStatus = Literal[
    "available",
    "no_candidates",
    "invalid_request",
    "timeout",
    "rate_limited",
    "unavailable",
    "failed",
]

# 固定短句，不回显 provider 原文（原文可能含 URL 或任意响应内容）。
_REASONS: dict[str, str] = {
    "invalid_lat": "纬度必须为 -90 到 90 之间的有限数值",
    "invalid_lon": "经度必须为 -180 到 180 之间的有限数值",
    "timeout": "兴趣点公开资料服务请求超时",
    "rate_limited": "兴趣点公开资料服务请求过于频繁，请稍后再试",
    "unavailable": "兴趣点公开资料服务暂时不可用",
    "failed": "兴趣点公开资料服务响应异常",
}


# ==================== QL 构造（纯函数，可独立测） ====================


def build_overpass_query(lat: float, lon: float) -> str:
    """固定数值化查询；lat/lon 已由调用方校验并四舍五入到 6 位小数。

    语法依据 Overpass QL 官方文档（wiki.openstreetmap.org/wiki/Overpass_API/
    Overpass_QL，2026-10-31 核对）：nwr 为 node/way/relation 联合类型说明符；
    括号 union 合并子语句结果；(around:radius,lat,lon) 为坐标圆域过滤；
    out 语句参数任意顺序，meta 含对象编辑时间戳，center 为 way/relation
    补充中心点，末尾非负整数限制输出元素数。
    """

    return (
        f"[out:json][timeout:{_QUERY_TIMEOUT_SECONDS}];"
        "("
        f'nwr["opening_hours"](around:{_RADIUS_M},{lat},{lon});'
        f'nwr["fee"](around:{_RADIUS_M},{lat},{lon});'
        f'nwr["charge"](around:{_RADIUS_M},{lat},{lon});'
        ");"
        f"out meta center {_MAX_SOURCE_ELEMENTS};"
    )


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """两点球面距离（米，WGS84 近似球体半径 6371000 m）。"""

    r = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


# ==================== 输入校验工具 ====================


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        # 极大 int（如 provider 返回畸形坐标 10**400）转 float 会 OverflowError，
        # 视为非法数值而不是让异常上抛。
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _in_wgs84(lat: Any, lon: Any) -> bool:
    return (
        _is_finite_number(lat)
        and _is_finite_number(lon)
        and _LAT_MIN <= float(lat) <= _LAT_MAX
        and _LON_MIN <= float(lon) <= _LON_MAX
    )


class _UpstreamStatusError(Exception):
    """携带本次请求 provider 状态的内部信号基类（供失败信封读取）。"""

    def __init__(
        self, message: str, provider_http_status: int | None = None
    ) -> None:
        super().__init__(message)
        self.provider_http_status = provider_http_status


class _UpstreamHTTPError(httpx.HTTPError):
    """5xx 等网络层失败：作为 httpx.HTTPError 传播，同时携带本次状态。"""

    def __init__(
        self, message: str, provider_http_status: int | None = None
    ) -> None:
        super().__init__(message)
        self.provider_http_status = provider_http_status


class _RateLimited(_UpstreamStatusError):
    """上游 429（复用 _UpstreamStatusError 携带本次请求的状态）。"""


class _BodyTooLarge(_UpstreamStatusError):
    pass


# ==================== 响应信封（独立于 Trip v1） ====================


class PoiCoordinate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: float
    lon: float


class PoiTagField(BaseModel):
    """单个来源标签：source_only=标签原文，unknown=缺失/非法/超长（不截断）。"""

    model_config = ConfigDict(extra="forbid")

    state: Literal["source_only", "unknown"]
    value: str | None = None


class PoiSourceMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = PROVIDER_NAME
    endpoint: str = PROVIDER_ENDPOINT
    docs_url: str = PROVIDER_DOCS_URL
    attribution_url: str = PROVIDER_ATTRIBUTION_URL
    license: str = PROVIDER_LICENSE
    data_source: str = "OpenStreetMap"


class PoiSourceCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    element_type: Literal["node", "way", "relation"]
    element_id: int = Field(gt=0)
    name: str | None
    location: PoiCoordinate
    distance_m: float = Field(ge=0)
    source_url: str
    retrieved_at: str
    source_updated_at: str | None
    identity_status: Literal["unconfirmed"] = "unconfirmed"
    opening_hours: PoiTagField
    fee: PoiTagField
    charge: PoiTagField


class PoiSourceReport(BaseModel):
    """fetch_nearby 的返回信封。失败路径不抛业务异常，只设置 status/reason。"""

    model_config = ConfigDict(extra="forbid")

    status: PoiSourceStatus
    reason: str | None = None
    provider_http_status: int | None = None
    checked_at: str
    fetched_at: str | None = None
    requested: PoiCoordinate | None = None
    radius_m: float = _RADIUS_M
    cached: bool = False
    source: PoiSourceMeta = Field(default_factory=PoiSourceMeta)
    source_elements_seen: int = 0
    candidates: list[PoiSourceCandidate] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


# ==================== 内部信号异常 ====================


class OverpassResponseError(_UpstreamStatusError):
    """provider 响应结构性损坏：root 非对象、缺 elements、remark 错误等。

    可携带本次请求的 provider_http_status（非 2xx 的 body 结构损坏等），
    供调用方写入信封而不依赖任何共享实例字段。
    """


# ==================== 响应解析（纯函数，可独立测） ====================


class ParsedNearby(NamedTuple):
    candidates: list[PoiSourceCandidate]
    notes: list[str]
    source_elements_seen: int


def _tag_field(tags: dict[str, Any], key: str) -> PoiTagField:
    raw = tags.get(key)
    if (
        isinstance(raw, str)
        and raw
        and len(raw) <= _MAX_TAG_VALUE_CHARS
        and raw.strip()
    ):
        return PoiTagField(state="source_only", value=raw)
    return PoiTagField(state="unknown")


def _clean_text(value: Any) -> str | None:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > _MAX_TAG_VALUE_CHARS
        or not value.strip()
    ):
        return None
    return value


def _parse_osm_timestamp(value: Any) -> str | None:
    """OSM 对象编辑时间；缺失/格式不符/非真实日历时间为 None，不用当前时间填充。"""

    if not isinstance(value, str) or not _TIMESTAMP_RE.match(value):
        return None
    try:
        _datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None
    return value


def parse_nearby_payload(
    payload: Any,
    *,
    center_lat: float,
    center_lon: float,
    retrieved_at: str,
) -> ParsedNearby:
    """把 Overpass JSON 响应解析为候选列表。

    结构性损坏抛 :class:`OverpassResponseError`（调用方折算为 failed）。
    单个元素字段非法只跳过并计数，不伪造候选。
    """

    if not isinstance(payload, dict):
        raise OverpassResponseError("root not object")
    remark = payload.get("remark")
    if isinstance(remark, str) and remark:
        raise OverpassResponseError("remark error")
    osm3s = payload.get("osm3s")
    if isinstance(osm3s, dict):
        inner = osm3s.get("remark")
        if isinstance(inner, str) and inner:
            raise OverpassResponseError("remark error")
    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise OverpassResponseError("missing elements")

    notes: list[str] = []
    seen = len(elements)
    if seen > _MAX_SOURCE_ELEMENTS:
        notes.append(
            f"源元素数超过上限，仅处理前 {_MAX_SOURCE_ELEMENTS} 个"
        )

    candidates: list[PoiSourceCandidate] = []
    seen_keys: set[tuple[str, int]] = set()
    skipped_invalid = 0
    skipped_no_location = 0
    skipped_out_radius = 0
    skipped_no_tags = 0
    skipped_duplicate = 0

    for element in elements[:_MAX_SOURCE_ELEMENTS]:
        if not isinstance(element, dict):
            skipped_invalid += 1
            continue
        etype = element.get("type")
        if etype not in _ELEMENT_TYPES:
            skipped_invalid += 1
            continue
        eid = element.get("id")
        if (
            isinstance(eid, bool)
            or not isinstance(eid, int)
            or eid <= 0
            or eid > _MAX_SAFE_INTEGER
        ):
            # 超过 JS 安全整数的 id 前端无法安全表达，按非法排除；
            # source_url 只由这里校验过的 type/id 构造。
            skipped_invalid += 1
            continue
        if (etype, eid) in seen_keys:
            skipped_duplicate += 1
            continue

        if etype == "node":
            elat, elon = element.get("lat"), element.get("lon")
        else:
            center = element.get("center")
            elat = center.get("lat") if isinstance(center, dict) else None
            elon = center.get("lon") if isinstance(center, dict) else None
        if not _in_wgs84(elat, elon):
            skipped_no_location += 1
            continue

        distance = haversine_m(center_lat, center_lon, float(elat), float(elon))
        if distance > _RADIUS_M:
            # 大 way/relation 的 bbox 可触及圆域而 center 在外：保守排除，
            # 不拿中心点冒充半径内的位置。
            skipped_out_radius += 1
            continue

        tags = element.get("tags") if isinstance(element.get("tags"), dict) else {}
        opening = _tag_field(tags, "opening_hours")
        fee = _tag_field(tags, "fee")
        charge = _tag_field(tags, "charge")
        if not any(key in tags for key in ("opening_hours", "fee", "charge")):
            # 防御性排除：本次 union 查询本不该返回三项标签全缺的元素；
            # 万一出现，不伪造候选。注意标签键存在但值非法/超长的元素
            # 仍保留（字段记 unknown），不因值不可用丢掉整个候选。
            skipped_no_tags += 1
            continue

        try:
            candidate = PoiSourceCandidate(
                element_type=etype,
                element_id=eid,
                name=_clean_text(tags.get("name")),
                location=PoiCoordinate(lat=float(elat), lon=float(elon)),
                distance_m=round(distance, 1),
                source_url=f"{_OSM_BASE_URL}/{etype}/{eid}",
                retrieved_at=retrieved_at,
                source_updated_at=_parse_osm_timestamp(element.get("timestamp")),
                opening_hours=opening,
                fee=fee,
                charge=charge,
            )
        except ValidationError:
            skipped_invalid += 1
            continue

        seen_keys.add((etype, eid))
        candidates.append(candidate)

    if skipped_invalid:
        notes.append(f"{skipped_invalid} 个源元素因类型/ID 校验未通过被排除")
    if skipped_no_location:
        notes.append(
            f"{skipped_no_location} 个源元素缺少合法 WGS84 坐标"
            "（node 缺 lat/lon 或 way/relation 缺 center），不补坐标、未作为候选"
        )
    if skipped_out_radius:
        notes.append(
            f"{skipped_out_radius} 个 way/relation 元素中心超出 "
            f"{_RADIUS_M}m 半径，已保守排除"
        )
    if skipped_no_tags:
        notes.append(
            f"{skipped_no_tags} 个源元素三项标签均不可用，未作为候选"
        )
    if skipped_duplicate:
        notes.append(f"{skipped_duplicate} 个重复元素已去重")

    candidates.sort(key=lambda c: (c.distance_m, c.element_type, c.element_id))
    if len(candidates) > _MAX_CANDIDATES:
        notes.append(
            f"候选按距离排序后仅保留最近 {_MAX_CANDIDATES} 个，"
            "结果不声称完整或全局最近"
        )
        candidates = candidates[:_MAX_CANDIDATES]

    return ParsedNearby(
        candidates=candidates, notes=notes, source_elements_seen=seen
    )


# ==================== 客户端 ====================


class PoiSourcesClient:
    """Overpass 附近 POI 公开资料候选异步客户端。

    client 所有权：外部传入 ``httpx.AsyncClient`` 时由调用方负责关闭；
    不传时本类自建（固定超时与连接上限）并在 :meth:`aclose` / ``__aexit__``
    中关闭。关闭幂等。
    """

    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        total_deadline_seconds: float = _DEFAULT_TOTAL_DEADLINE_SECONDS,
        cache_ttl_seconds: float = _DEFAULT_CACHE_TTL_SECONDS,
        cache_max_keys: int = _DEFAULT_CACHE_MAX_KEYS,
        clock: Callable[[], float] = time.monotonic,
        now_utc: Callable[[], _datetime] = lambda: _datetime.now(_timezone.utc),
    ) -> None:
        # 本地配置合同：在任何 HTTP 资源分配之前校验，非法配置不留半初始化
        # 对象、不遗留 owned client。TTL=0 与容量=0 都等于关闭缓存。
        if isinstance(total_deadline_seconds, bool) or not isinstance(
            total_deadline_seconds, (int, float)
        ):
            raise TypeError("total_deadline_seconds 必须为数值")
        try:
            deadline = float(total_deadline_seconds)
        except (OverflowError, ValueError) as exc:
            raise ValueError("total_deadline_seconds 必须为有限数值") from exc
        if not math.isfinite(deadline) or deadline <= 0:
            raise ValueError("total_deadline_seconds 必须为大于 0 的有限数值")

        if isinstance(cache_ttl_seconds, bool) or not isinstance(
            cache_ttl_seconds, (int, float)
        ):
            raise TypeError("cache_ttl_seconds 必须为数值")
        try:
            ttl = float(cache_ttl_seconds)
        except (OverflowError, ValueError) as exc:
            raise ValueError("cache_ttl_seconds 必须为有限数值") from exc
        if not math.isfinite(ttl) or ttl < 0:
            raise ValueError("cache_ttl_seconds 必须为大于等于 0 的有限数值（0 关闭缓存）")

        if isinstance(cache_max_keys, bool) or not isinstance(cache_max_keys, int):
            raise TypeError("cache_max_keys 必须为整数")
        if cache_max_keys < 0:
            raise ValueError("cache_max_keys 必须为大于等于 0 的整数（0 等于关闭缓存）")

        if not callable(clock):
            raise TypeError("clock 必须为可调用对象")
        if not callable(now_utc):
            raise TypeError("now_utc 必须为可调用对象")

        self._client = client
        self._owns_client = client is None
        if self._client is None:
            # 自建 client：固定超时与连接上限，不跟随重定向；由 aclose 关闭。
            self._client = httpx.AsyncClient(
                timeout=_TIMEOUTS, limits=_LIMITS, follow_redirects=False
            )
        self._total_deadline_seconds = deadline
        self._cache_ttl_seconds = ttl
        self._cache_max_keys = cache_max_keys
        self._cache: "OrderedDict[tuple[float, float], tuple[float, PoiSourceReport]]" = (
            OrderedDict()
        )
        self._clock = clock
        self._now_utc = now_utc
        self._closed = False

    async def __aenter__(self) -> "PoiSourcesClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
        self._client = None
        self._cache.clear()
        self._closed = True

    # ---------- 公开接口 ----------

    async def fetch_nearby(self, lat: Any, lon: Any) -> PoiSourceReport:
        """查询附近公开资料候选。非法输入不发请求，直接返回 invalid_request。"""

        checked_at = self._now_utc().isoformat()

        lat_ok = False
        lon_ok = False
        try:
            lat_ok = _is_finite_number(lat) and _LAT_MIN <= float(lat) <= _LAT_MAX
            lon_ok = _is_finite_number(lon) and _LON_MIN <= float(lon) <= _LON_MAX
        except (OverflowError, ValueError, TypeError):
            pass
        if not lat_ok:
            return self._status_report(
                "invalid_request", _REASONS["invalid_lat"], checked_at=checked_at
            )
        if not lon_ok:
            return self._status_report(
                "invalid_request", _REASONS["invalid_lon"], checked_at=checked_at
            )

        request_lat = round(float(lat), 6)
        request_lon = round(float(lon), 6)
        requested = PoiCoordinate(lat=request_lat, lon=request_lon)

        cached = self._cache_get(request_lat, request_lon)
        if cached is not None:
            return cached

        try:
            body, http_status = await self._fetch_payload(
                request_lat, request_lon
            )
        except asyncio.CancelledError:
            raise
        except httpx.TimeoutException:
            return self._status_report(
                "timeout", _REASONS["timeout"],
                checked_at=checked_at, requested=requested,
            )
        except _RateLimited as exc:
            return self._status_report(
                "rate_limited", _REASONS["rate_limited"],
                checked_at=checked_at, requested=requested,
                provider_http_status=exc.provider_http_status,
            )
        except (httpx.HTTPError, OSError) as exc:
            return self._status_report(
                "unavailable", _REASONS["unavailable"],
                checked_at=checked_at, requested=requested,
                provider_http_status=getattr(
                    exc, "provider_http_status", None
                ),
            )
        except _UpstreamStatusError as exc:
            return self._status_report(
                "failed", _REASONS["failed"],
                checked_at=checked_at, requested=requested,
                provider_http_status=exc.provider_http_status,
            )

        # fetched_at 在成功读完 2xx body 之后取，不在网络开始前；
        # 后续解析失败也如实保留该时间（body 确实收到过）。
        fetched_at = self._now_utc().isoformat()
        try:
            payload = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError, RecursionError):
            # 极深嵌套的坏 JSON 可能抛 RecursionError 而不是 ValueError，
            # 同样按 provider 结构损坏折算 failed，不让异常泄成 500。
            return self._status_report(
                "failed", _REASONS["failed"],
                checked_at=checked_at, requested=requested,
                fetched_at=fetched_at, provider_http_status=http_status,
            )

        try:
            parsed = parse_nearby_payload(
                payload,
                center_lat=request_lat,
                center_lon=request_lon,
                retrieved_at=fetched_at,
            )
        except OverpassResponseError:
            # body 已真实收到但结构损坏：fetched_at 是真实获取时间，如实保留。
            return self._status_report(
                "failed", _REASONS["failed"],
                checked_at=checked_at, requested=requested,
                fetched_at=fetched_at, provider_http_status=http_status,
            )

        status: PoiSourceStatus = (
            "available" if parsed.candidates else "no_candidates"
        )
        report = PoiSourceReport(
            status=status,
            checked_at=checked_at,
            fetched_at=fetched_at,
            requested=requested,
            provider_http_status=http_status,
            source_elements_seen=parsed.source_elements_seen,
            candidates=parsed.candidates,
            notes=parsed.notes,
        )
        self._cache_put(request_lat, request_lon, report)
        return report

    # ---------- 内部实现 ----------

    @staticmethod
    def _status_report(
        status: PoiSourceStatus,
        reason: str,
        *,
        checked_at: str,
        requested: PoiCoordinate | None = None,
        fetched_at: str | None = None,
        provider_http_status: int | None = None,
    ) -> PoiSourceReport:
        return PoiSourceReport(
            status=status,
            reason=reason,
            checked_at=checked_at,
            requested=requested,
            fetched_at=fetched_at,
            provider_http_status=provider_http_status,
        )

    async def _fetch_payload(
        self, lat: float, lon: float
    ) -> tuple[bytes, int]:
        """发请求并读取 body，返回 (body, provider_http_status)。

        失败抛内部信号异常（_UpstreamStatusError 携带本次请求自己的
        provider 状态），由上层折算成信封状态。成功时 _do_request 直接
        返回 (body, 本次 2xx 状态)，不伪造 200；严格只有 2xx 进入成功
        body 处理，其他状态沿 typed 失败口径。状态一律走请求局部传递，
        不存实例共享字段，并发请求互不串值。JSON 解析在调用方完成，以便
        解析失败时仍能记录真实 fetched_at。

        总截止用 ``asyncio.wait_for`` 真实取消：覆盖等 headers 与全部 chunk
        之间的等待；到期时流上下文自动关闭。
        """

        if self._closed or self._client is None:
            raise RuntimeError("PoiSourcesClient 已关闭或未初始化 HTTP 客户端")

        deadline = self._clock() + self._total_deadline_seconds
        query = build_overpass_query(lat, lon)

        async def _do_request() -> tuple[bytes, int]:
            # follow_redirects 显式 False：外部注入的 client 可能开了 True。
            async with self._client.stream(
                "GET", PROVIDER_ENDPOINT, params={"data": query},
                follow_redirects=False,
            ) as response:
                status = response.status_code
                if response.is_redirect:
                    raise OverpassResponseError(
                        "unexpected redirect", provider_http_status=status
                    )
                if status == 429:
                    raise _RateLimited(
                        "rate limited", provider_http_status=status
                    )
                if status >= 500:
                    # 错误正文不解析、不消费，防无限错误流。
                    raise _UpstreamHTTPError(
                        f"provider unavailable: {status}",
                        provider_http_status=status,
                    )
                if not (200 <= status < 300):
                    raise OverpassResponseError(
                        "provider client error", provider_http_status=status
                    )
                try:
                    return await self._bounded_read(response, deadline), status
                except _BodyTooLarge as exc:
                    exc.provider_http_status = status
                    raise

        try:
            return await asyncio.wait_for(
                _do_request(), timeout=self._total_deadline_seconds
            )
        except TimeoutError as exc:
            # 总 deadline 到期折算成 httpx 超时，调用方看到 timeout。
            raise httpx.TimeoutException("total deadline exceeded") from exc

    async def _bounded_read(
        self, response: httpx.Response, deadline: float
    ) -> bytes:
        """流式读取解压后的 body，带 1 MiB 硬上限和总 deadline。"""

        chunks: list[bytes] = []
        received = 0
        async for chunk in response.aiter_bytes():
            received += len(chunk)
            if received > _MAX_BODY_BYTES:
                raise _BodyTooLarge("body too large")
            if self._clock() > deadline:
                raise TimeoutError("total deadline exceeded")
            chunks.append(chunk)
        return b"".join(chunks)

    # ---------- 内存缓存 ----------

    def _cache_get(self, lat: float, lon: float) -> PoiSourceReport | None:
        if self._cache_ttl_seconds <= 0 or self._cache_max_keys <= 0:
            return None
        key = (lat, lon)
        entry = self._cache.get(key)
        if entry is None:
            return None
        stored_at, report = entry
        if self._clock() - stored_at > self._cache_ttl_seconds:
            del self._cache[key]
            return None
        self._cache.move_to_end(key)
        # 深拷贝隔离：调用方修改返回值不污染缓存；显式 cached，保留原时间戳。
        return report.model_copy(update={"cached": True}, deep=True)

    def _cache_put(
        self, lat: float, lon: float, report: PoiSourceReport
    ) -> None:
        if self._cache_ttl_seconds <= 0 or self._cache_max_keys <= 0:
            return
        # 只缓存成功与 no_candidates；失败响应不缓存。
        if report.status not in ("available", "no_candidates"):
            return
        self._cache[(lat, lon)] = (
            self._clock(), report.model_copy(deep=True),
        )
        self._cache.move_to_end((lat, lon))
        while len(self._cache) > self._cache_max_keys:
            self._cache.popitem(last=False)

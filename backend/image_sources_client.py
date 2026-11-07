# -*- coding: utf-8 -*-
"""Wikimedia Commons 图片搜索客户端（独立信封，不进 Trip v1）。

数据源固定为 Wikimedia Commons API（``https://commons.wikimedia.org/w/api.php``，
``action=query&generator=search&gsrnamespace=6``，仅搜 File 命名空间）。
接口参数依据 MediaWiki API 文档（mediawiki.org/wiki/API:Search 与
API:Imageinfo，2026-11-08 核对）：GET、无 Key、``prop=imageinfo`` 取
``url|size|extmetadata``、``iiurlwidth=320`` 请求 320px 缩略图、
``gsrlimit`` 本地硬上限 10。

定位（与 tavily_web_client / poi_sources_client 一致的边界）：

- 结果是"Commons 返回的可展示图片条目"：缩略图/原图/描述页 URL、逐文件
  license 与作者署名（artist 由后端剥离 HTML 为纯文本）。许可与署名按上游
  原样透传，缺失即为 null，绝不编造；是否可收进由前端按署名存在与否决定。
- 查询必须来自用户显式点击；本模块不做自动搜索、无重试（一次 search 最多
  1 次 upstream 尝试）、不跟随重定向。
- typed 报告区分 available/no_candidates/invalid_request/timeout/
  rate_limited/unavailable/failed。available 必须至少有 1 个可展示条目；
  no_candidates 表示本期未找到可用候选（含"上游有条目但全部不可展示"），
  不表示地点不存在，notes 记录取舍原因。
- 条目 URL 走保守主机白名单：``thumb_url``/``image_url`` 仅允许 https 的
  ``upload.wikimedia.org``，``description_url`` 仅允许 https 的
  ``commons.wikimedia.org``；无 userinfo/端口/控制字符/空白，总长 ≤2048。
  不安全条目丢弃并计数进 notes，绝不改写上游 URL。
- 上游文本（title/artist/license/URL）含孤立代理码点时整份按 failed 返回
  固定可编码信封（与 tavily_web_client 同口径）：不替换字符伪造内容，
  也不让响应编码崩溃。
- 上游 429 → rate_limited；5xx/网络错误 → unavailable；重定向/其他 4xx/
  坏 JSON/超 body/``error`` 结构 → failed。失败信封 ``reason`` 全部固定
  短句，不回显上游原文/URL/异常文本；``provider_http_status`` 走请求局部
  传递（返回值或异常属性），不存实例共享字段，并发请求互不串值。
- 总 deadline（默认 8 秒）用 ``asyncio.wait_for`` 真实取消；流式读取解压后
  body 上限 1 MiB；``asyncio.CancelledError`` 原样上抛。
- 构造参数在任何 HTTP 资源分配之前校验：total_deadline_seconds 为大于 0 的
  有限数值；max_results 为 1..10 整数（本地硬上限 10，gsrlimit 不超过它）。
  非法配置直接抛 TypeError/ValueError，不留半初始化对象，也不遗留 owned
  client。
- 无缓存：每次 search 都是一次显式上游查询（与 Tavily 同口径；POI 的缓存
  是坐标查询特有优化，这里不复制）。
- client 所有权：外部传入 ``httpx.AsyncClient`` 时由调用方负责关闭（测试可
  注入 MockTransport）；不传时本类自建（固定超时与连接上限、不跟随重定向）
  并在 :meth:`aclose` / ``__aexit__`` 中关闭。关闭幂等。

诚实 UA（Wikimedia UA 政策要求可联系的标识）：固定常量
``Travel-Assistant-ImageSources/1.0 (+仓库 URL)``，随单次请求发送，不含
Key/环境值，不伪装浏览器。模块 import 不发任何网络请求、不读取 .env。
"""

from __future__ import annotations

import asyncio
import json
import math
import time
from datetime import datetime as _datetime
from datetime import timezone as _timezone
from html.parser import HTMLParser
from typing import Any, Callable, Literal, NamedTuple
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field

# ==================== 固定契约 ====================

PROVIDER_ENDPOINT = "https://commons.wikimedia.org/w/api.php"
PROVIDER_DOCS_URL = "https://www.mediawiki.org/wiki/API:Search"
PROVIDER_ATTRIBUTION_URL = (
    "https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia"
)
PROVIDER_NAME = "wikimedia-commons"
DATA_SOURCE_NAME = "Wikimedia Commons"

# 缩略图/原图与描述页的主机白名单：仅接受 https + 精确主机名。
_IMAGE_HOST = "upload.wikimedia.org"
_DESCRIPTION_HOST = "commons.wikimedia.org"

_GSR_NAMESPACE = 6
_THUMB_WIDTH = 320
_MIN_MAX_RESULTS = 1
# 本地硬上限：Commons API 的 gsrlimit 允许更高，本项目收紧到 10。
_MAX_MAX_RESULTS = 10
_DEFAULT_MAX_RESULTS = 10

_MAX_QUERY_CODEPOINTS = 100
_MAX_BODY_BYTES = 1024 * 1024
# 防御性投影上限：gsrlimit ≤ 10 时上游本不该返回更多页；万一异常返回，
# 只处理前 25 个源条目并在 notes 说明。
_MAX_PROJECTION_ENTRIES = 25
_MAX_TITLE_CHARS = 300
_MAX_META_TEXT_CHARS = 300
_MAX_URL_LENGTH = 2048

_TIMEOUTS = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=2.0)
_DEFAULT_TOTAL_DEADLINE_SECONDS = 8.0
_LIMITS = httpx.Limits(max_connections=4, max_keepalive_connections=2)

# 固定、诚实的应用请求标识：不含 Key/环境值，也不伪装浏览器。
_USER_AGENT = (
    "Travel-Assistant-ImageSources/1.0 "
    "(+https://github.com/flower-forever/LangGraph-Smart-Traval-Assitant)"
)

ImageSourceStatus = Literal[
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
    "invalid_query": "查询必须为去除首尾空白后 1 到 100 个字符的文本",
    "timeout": "图片搜索请求超时",
    "rate_limited": "图片搜索请求过于频繁，请稍后再试",
    "unavailable": "图片搜索服务暂时不可用",
    "failed": "图片搜索响应异常",
}


# ==================== 查询规范化（纯函数，可独立测） ====================


def _is_utf8_encodable(value: str) -> bool:
    """str 能否无替换地编码为 UTF-8（拒绝孤立代理码点）。"""

    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def normalize_image_query(value: Any) -> str | None:
    """trim 后按 Python Unicode 码点计 1..100；不合法返回 None。

    本地 100 码点是本项目上限（Commons 搜索本身没有这么紧的限制）；
    str 只按码点计数（``len(str)``），astral 字符（如 emoji）算 1 个。
    合法 JSON 代理对解码后的 astral 字符可正常通过；孤立代理码点无法
    编码为 UTF-8，一律视为非法，避免后续 JSON 响应编码崩溃。
    """

    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if len(trimmed) > _MAX_QUERY_CODEPOINTS:
        return None
    if not _is_utf8_encodable(trimmed):
        return None
    return trimmed


# ==================== URL 安全策略（纯函数，可独立测） ====================


def _is_safe_commons_url(value: Any, host: str) -> bool:
    """上游图片/描述页 URL 的保守白名单（纯语法检查，不解析 DNS）。

    仅绝对 https、精确主机名匹配（``upload.wikimedia.org`` /
    ``commons.wikimedia.org``）、无 userinfo、无控制字符/空白、总长
    ≤2048、端口仅允许省略或 443。不满足即拒绝，绝不改写上游 URL。
    """

    if not isinstance(value, str) or not value or len(value) > _MAX_URL_LENGTH:
        return False
    if not _is_utf8_encodable(value):
        return False
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
        return False
    if any(ch.isspace() for ch in value):
        return False
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    if parts.scheme != "https":
        return False
    if parts.username is not None or parts.password is not None:
        return False
    hostname = parts.hostname
    if not isinstance(hostname, str) or hostname.lower() != host:
        return False
    try:
        port = parts.port
    except ValueError:
        return False
    if port is not None and port != 443:
        return False
    return True


# ==================== artist HTML 剥离（纯函数，可独立测） ====================


class _HTMLTextExtractor(HTMLParser):
    """只收集文本节点；convert_charrefs=True 时实体引用一并解码。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        if data:
            self._parts.append(data)

    def text(self) -> str:
        return "".join(self._parts)


def strip_html_to_text(value: Any) -> str | None:
    """上游 extmetadata 富文本（artist/license 等）→ 单行纯文本。

    标签剥掉、实体解码、空白折叠为单空格；结果为空或超过
    _MAX_META_TEXT_CHARS 码点时返回 None：宁可缺失也不截断后冒充原文
    （署名被截断会破坏 CC 署名义务，与 POI 标签"不截断"同口径）。
    不可编码为 UTF-8 的原文同样返回 None（孤立代理不进响应）。
    """

    if not isinstance(value, str) or not value.strip():
        return None
    if not _is_utf8_encodable(value):
        return None
    extractor = _HTMLTextExtractor()
    try:
        extractor.feed(value)
        extractor.close()
    except Exception:  # noqa: BLE001 — 解析器对畸形输入极宽容；兜底按缺失处理
        return None
    text = " ".join(extractor.text().split())
    if not text or len(text) > _MAX_META_TEXT_CHARS:
        return None
    return text


# ==================== 响应信封（独立于 Trip v1） ====================


class ImageSourceMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = PROVIDER_NAME
    endpoint: str = PROVIDER_ENDPOINT
    docs_url: str = PROVIDER_DOCS_URL
    attribution_url: str = PROVIDER_ATTRIBUTION_URL
    data_source: str = DATA_SOURCE_NAME


class ImageSearchItem(BaseModel):
    """单张可展示图片条目；license/artist 按上游原样，缺失为 null。

    字段名按 wire 契约（docs/IMAGE_SOURCES.md / 计划 §3.1）使用 camelCase，
    与前端消费侧保持一致。
    """

    model_config = ConfigDict(extra="forbid")

    title: str | None
    thumbUrl: str
    imageUrl: str
    descriptionUrl: str
    license: str | None
    artist: str | None
    width: int | None
    height: int | None


class ImageSearchReport(BaseModel):
    """search 的返回信封。失败路径不抛业务异常，只设置 status/reason。"""

    model_config = ConfigDict(extra="forbid")

    status: ImageSourceStatus
    reason: str | None = None
    provider_http_status: int | None = None
    checked_at: str
    fetched_at: str | None = None
    requested_query: str | None = None
    max_results: int
    results_seen: int = 0
    items: list[ImageSearchItem] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    source: ImageSourceMeta = Field(default_factory=ImageSourceMeta)


# ==================== 内部信号异常 ====================


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
    """上游 429。"""


class _BodyTooLarge(_UpstreamStatusError):
    pass


class CommonsResponseError(_UpstreamStatusError):
    """provider 响应结构性损坏：root 非对象、pages 非列表、error 结构等。

    可携带本次请求的 provider_http_status（非 2xx 的 body 结构损坏等），
    供调用方写入信封而不依赖任何共享实例字段。
    """


# ==================== 响应解析（纯函数，可独立测） ====================


class ParsedItems(NamedTuple):
    items: list[ImageSearchItem]
    notes: list[str]
    results_seen: int


def _extmetadata_text(extmetadata: Any, key: str) -> str | None:
    """extmetadata[key].value 的原始字符串；结构不符返回 None。"""

    if not isinstance(extmetadata, dict):
        return None
    entry = extmetadata.get(key)
    if not isinstance(entry, dict):
        return None
    value = entry.get("value")
    if not isinstance(value, str):
        return None
    return value


def _clean_dimension(value: Any) -> int | None:
    """原始宽高：仅接受 ≥1 的真实整数；缺失/布尔/非法为 None。"""

    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 1 else None


def _require_encodable(value: Any) -> None:
    """上游 JSON 不可信：孤立代理码点会让响应编码崩溃，整份按 failed。"""

    if isinstance(value, str) and not _is_utf8_encodable(value):
        raise CommonsResponseError("non-utf8 item text")


def parse_search_payload(
    payload: Any,
    *,
    max_results: int,
) -> ParsedItems:
    """把 Commons JSON 响应投影为可展示条目列表。

    结构性损坏抛 :class:`CommonsResponseError`（调用方折算为 failed）；
    ``{"batchcomplete": true}``（搜索无命中）与空 pages → 0 条。单条
    字段非法/URL 不安全/缺缩略图只跳过并计数，不伪造候选、不改写 URL。
    """

    if not isinstance(payload, dict):
        raise CommonsResponseError("root not object")
    if "error" in payload:
        # MediaWiki 的结构化错误（如参数非法）：按 provider 响应异常处理。
        raise CommonsResponseError("api error")
    query = payload.get("query")
    if query is None:
        # Commons 搜索无命中时的正常形态，不是结构损坏。
        return ParsedItems(items=[], notes=[], results_seen=0)
    if not isinstance(query, dict):
        raise CommonsResponseError("query not object")
    pages = query.get("pages")
    if pages is None or (isinstance(pages, list) and not pages):
        return ParsedItems(items=[], notes=[], results_seen=0)
    if not isinstance(pages, list):
        raise CommonsResponseError("pages not list")

    notes: list[str] = []
    seen = len(pages)
    process_limit = min(seen, _MAX_PROJECTION_ENTRIES)
    if seen > _MAX_PROJECTION_ENTRIES:
        notes.append(f"上游返回 {seen} 条，仅处理前 {_MAX_PROJECTION_ENTRIES} 条")

    items: list[ImageSearchItem] = []
    dropped_malformed = 0
    dropped_unsafe_url = 0
    dropped_no_thumb = 0
    dropped_overlong_artist = 0

    for page in pages[:process_limit]:
        if not isinstance(page, dict):
            dropped_malformed += 1
            continue
        imageinfo = page.get("imageinfo")
        if not isinstance(imageinfo, list) or not imageinfo:
            dropped_malformed += 1
            continue
        info = imageinfo[0]
        if not isinstance(info, dict):
            dropped_malformed += 1
            continue

        raw_title = page.get("title")
        raw_thumb = info.get("thumburl")
        raw_image = info.get("url")
        raw_description = info.get("descriptionurl")
        raw_license = _extmetadata_text(info.get("extmetadata"), "LicenseShortName")
        raw_artist = _extmetadata_text(info.get("extmetadata"), "Artist")
        for raw in (raw_title, raw_thumb, raw_image, raw_description, raw_license, raw_artist):
            _require_encodable(raw)

        if not _is_safe_commons_url(raw_thumb, _IMAGE_HOST) or not _is_safe_commons_url(
            raw_image, _IMAGE_HOST
        ):
            dropped_unsafe_url += 1
            continue
        if not _is_safe_commons_url(raw_description, _DESCRIPTION_HOST):
            dropped_unsafe_url += 1
            continue
        if not isinstance(raw_thumb, str) or not raw_thumb:
            # URL 安全检查已覆盖非字符串；此处防御性再挡一次缺缩略图。
            dropped_no_thumb += 1
            continue

        title: str | None = None
        if isinstance(raw_title, str) and raw_title.strip() and len(raw_title) <= _MAX_TITLE_CHARS:
            title = raw_title

        license_text = strip_html_to_text(raw_license)
        artist_text = strip_html_to_text(raw_artist)
        if raw_artist is not None and artist_text is None:
            # 有署名原文但剥离后为空/超长/不可编码：按缺失处理并计数，
            # 不截断冒充完整署名。
            dropped_overlong_artist += 1

        try:
            items.append(
                ImageSearchItem(
                    title=title,
                    thumbUrl=raw_thumb,
                    imageUrl=raw_image,
                    descriptionUrl=raw_description,
                    license=license_text,
                    artist=artist_text,
                    width=_clean_dimension(info.get("width")),
                    height=_clean_dimension(info.get("height")),
                )
            )
        except Exception:  # noqa: BLE001 — pydantic 校验失败按坏条目跳过
            dropped_malformed += 1
            continue

    if dropped_malformed:
        notes.append(f"{dropped_malformed} 条上游条目结构异常，未展示")
    if dropped_unsafe_url:
        notes.append(f"{dropped_unsafe_url} 条条目链接未通过安全检查，未展示")
    if dropped_no_thumb:
        notes.append(f"{dropped_no_thumb} 条条目缺少可用缩略图，未展示")
    if dropped_overlong_artist:
        notes.append(f"{dropped_overlong_artist} 条署名文本超长，按缺失处理")

    if len(items) > max_results:
        notes.append(f"结果按来源顺序仅保留前 {max_results} 条，未声称完整")
        items = items[:max_results]

    return ParsedItems(items=items, notes=notes, results_seen=seen)


# ==================== 客户端 ====================


class ImageSourcesClient:
    """Wikimedia Commons 图片搜索异步客户端（单查询、单次 upstream 尝试）。

    client 所有权：外部传入 ``httpx.AsyncClient`` 时由调用方负责关闭；
    不传时本类自建（固定超时与连接上限、不跟随重定向）并在 :meth:`aclose` /
    ``__aexit__`` 中关闭。关闭幂等。
    """

    def __init__(
        self,
        *,
        max_results: int = _DEFAULT_MAX_RESULTS,
        total_deadline_seconds: float = _DEFAULT_TOTAL_DEADLINE_SECONDS,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.monotonic,
        now_utc: Callable[[], _datetime] = lambda: _datetime.now(_timezone.utc),
    ) -> None:
        # 本地配置合同：在任何 HTTP 资源分配之前校验，非法配置不留半初始化
        # 对象、不遗留 owned client（与 PoiSourcesClient / TavilyWebClient 同口径）。
        if isinstance(max_results, bool) or not isinstance(max_results, int):
            raise TypeError("max_results 必须为整数")
        if not (_MIN_MAX_RESULTS <= max_results <= _MAX_MAX_RESULTS):
            raise ValueError(
                f"max_results 必须在 {_MIN_MAX_RESULTS}..{_MAX_MAX_RESULTS} 之间"
            )

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
        if not callable(clock):
            raise TypeError("clock 必须为可调用对象")
        if not callable(now_utc):
            raise TypeError("now_utc 必须为可调用对象")

        self._client = client
        self._owns_client = client is None
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=_TIMEOUTS, limits=_LIMITS, follow_redirects=False
            )
        self._max_results = max_results
        self._total_deadline_seconds = deadline
        self._clock = clock
        self._now_utc = now_utc
        self._closed = False

    async def __aenter__(self) -> "ImageSourcesClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
        self._client = None
        self._closed = True

    # ---------- 公开接口 ----------

    async def search(self, query: Any) -> ImageSearchReport:
        """按用户查询搜索 Commons 图片。非法输入不发请求，直接返回。"""

        checked_at = self._now_utc().isoformat()
        normalized = normalize_image_query(query)
        if normalized is None:
            return ImageSearchReport(
                status="invalid_request",
                reason=_REASONS["invalid_query"],
                checked_at=checked_at,
                max_results=self._max_results,
            )

        try:
            body_bytes, http_status = await self._fetch_payload(normalized)
        except asyncio.CancelledError:
            raise
        except httpx.TimeoutException:
            return ImageSearchReport(
                status="timeout",
                reason=_REASONS["timeout"],
                checked_at=checked_at,
                requested_query=normalized,
                max_results=self._max_results,
            )
        except _RateLimited as exc:
            return ImageSearchReport(
                status="rate_limited",
                reason=_REASONS["rate_limited"],
                checked_at=checked_at,
                requested_query=normalized,
                max_results=self._max_results,
                provider_http_status=exc.provider_http_status,
            )
        except (httpx.HTTPError, OSError) as exc:
            return ImageSearchReport(
                status="unavailable",
                reason=_REASONS["unavailable"],
                checked_at=checked_at,
                requested_query=normalized,
                max_results=self._max_results,
                provider_http_status=getattr(
                    exc, "provider_http_status", None
                ),
            )
        except _UpstreamStatusError as exc:
            return ImageSearchReport(
                status="failed",
                reason=_REASONS["failed"],
                checked_at=checked_at,
                requested_query=normalized,
                max_results=self._max_results,
                provider_http_status=exc.provider_http_status,
            )

        try:
            payload = json.loads(body_bytes.decode("utf-8"))
        except (ValueError, UnicodeDecodeError, RecursionError):
            # 极深嵌套的坏 JSON 可能抛 RecursionError 而不是 ValueError，
            # 同样按 provider 结构损坏折算 failed，不让异常泄成 500。
            return self._failed_report(
                checked_at=checked_at,
                requested_query=normalized,
                provider_http_status=http_status,
            )

        try:
            parsed = parse_search_payload(payload, max_results=self._max_results)
        except CommonsResponseError:
            return self._failed_report(
                checked_at=checked_at,
                requested_query=normalized,
                provider_http_status=http_status,
            )

        notes = list(parsed.notes)
        if parsed.items:
            status: ImageSourceStatus = "available"
        else:
            status = "no_candidates"
            if parsed.results_seen > 0:
                notes.append(
                    f"取得 {parsed.results_seen} 条结果，但均无法作为图片展示"
                )
        # fetched_at 在 body 成功读取且结构解析可信之后才设置；坏 JSON /
        # 坏结构走 _failed_report（fetched_at=None），不用半途时间冒充。
        fetched_at = self._now_utc().isoformat()
        return ImageSearchReport(
            status=status,
            checked_at=checked_at,
            fetched_at=fetched_at,
            requested_query=normalized,
            max_results=self._max_results,
            provider_http_status=http_status,
            results_seen=parsed.results_seen,
            items=parsed.items,
            notes=notes,
        )

    # ---------- 内部实现 ----------

    def _failed_report(
        self,
        *,
        checked_at: str,
        requested_query: str,
        provider_http_status: int | None,
    ) -> ImageSearchReport:
        return ImageSearchReport(
            status="failed",
            reason=_REASONS["failed"],
            checked_at=checked_at,
            fetched_at=None,
            requested_query=requested_query,
            max_results=self._max_results,
            provider_http_status=provider_http_status,
        )

    async def _fetch_payload(self, query: str) -> tuple[bytes, int]:
        """单次 GET 官方 endpoint，返回 (body, provider_http_status)。

        无重试、不跟随重定向、无 Key；UA 在单次请求级设置：无论
        self._client 是自建还是外部注入（可能带自定义默认头），这条请求
        都带固定诚实标识。总截止用 ``asyncio.wait_for`` 真实取消：覆盖
        等 headers 与全部 chunk 之间的等待；到期时流上下文自动关闭。
        """

        if self._closed or self._client is None:
            raise RuntimeError("ImageSourcesClient 已关闭或未初始化 HTTP 客户端")

        deadline = self._clock() + self._total_deadline_seconds
        params = {
            "action": "query",
            "format": "json",
            "formatversion": "2",
            "generator": "search",
            "gsrsearch": query,
            "gsrnamespace": _GSR_NAMESPACE,
            "gsrlimit": self._max_results,
            "prop": "imageinfo",
            "iiprop": "url|size|extmetadata",
            "iiurlwidth": _THUMB_WIDTH,
        }

        async def _do_request() -> tuple[bytes, int]:
            # follow_redirects 显式 False：外部注入的 client 可能开了 True。
            async with self._client.stream(
                "GET",
                PROVIDER_ENDPOINT,
                params=params,
                headers={"User-Agent": _USER_AGENT},
                follow_redirects=False,
            ) as response:
                status = response.status_code
                if response.is_redirect:
                    raise CommonsResponseError(
                        "unexpected redirect", provider_http_status=status
                    )
                if status == 429:
                    raise _RateLimited(
                        "rate limited", provider_http_status=status
                    )
                if status >= 500:
                    # 错误正文不解析、不消费，防无限错误流。
                    raise _UpstreamHTTPError(
                        "provider unavailable", provider_http_status=status
                    )
                if not (200 <= status < 300):
                    # 其他 4xx（含 401/403/404）：Commons 无 Key 体系，
                    # 一律按 provider client error 折算 failed。
                    raise CommonsResponseError(
                        "provider client error", provider_http_status=status
                    )
                try:
                    return (
                        await self._bounded_read(response, deadline),
                        status,
                    )
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
        """流式读取解压后的 body，带 1 MiB 上限和总 deadline。"""

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

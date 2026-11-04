# -*- coding: utf-8 -*-
"""Tavily 网页资料搜索客户端（独立信封，不进 Trip v1）。

数据源固定为 https://api.tavily.com/search（Tavily Search API）。
接口依据官方文档 docs.tavily.com「POST /search」（Context7 拉取的当前
api-reference，2026-11-03 核对）：POST JSON body，API Key 走
``Authorization: Bearer`` 请求头（不进 URL、不进日志、不进任何输出）；
本模块固定 ``search_depth="basic"``、``max_results`` 默认 3 且硬上限 5、
``include_answer=false``、``include_raw_content=false``、
``include_published_date=true``。

定位（与 weather_client / poi_sources_client 一致的边界）：

- 结果是"搜索引擎返回的网页资料条目"，``content_status`` 恒为
  ``unverified``：title/snippet 只是检索摘要，不是官方数据、不是实时核验，
  不修改 Trip/费用/规划，不据此抓取任何结果链接。
- 查询必须来自用户显式点击；本模块不做自动搜索、无重试（一次 search 最多
  1 次 upstream 尝试）、不跟随重定向。
- typed 报告区分 available/no_results/no_usable_results/invalid_request/
  no_key/timeout/rate_limited/unauthorized/unavailable/failed。
  available 必须至少有 1 个可展示结果；no_results 仅指上游确实返回空数组；
  上游有条目但全部因 URL 安全策略不可展示时为 no_usable_results，绝不冒充
  "上游没有结果"。
- 结果 URL 走保守白名单策略（:func:`is_shareable_https_url`）：仅绝对 https、
  ASCII 域名（标准 punycode 可，原始 Unicode host 首批拒绝）、所有
  ``xn--`` A-label 必须可被 stdlib IDNA 解码（无效 punycode 如 ``xn--a``
  拒绝；已知保守差异：IDNA2003 比 UTS46 更严，个别 UTS46 可解码 label
  被多滤，不宣称 WHATWG 等价）、无 userinfo、
  无控制/空白字符、总长 ≤2048、端口仅允许空或 443、拒绝一切 IP 字面量与
  localhost/.local/.internal 等本地形式。只做语法检查，不为校验解析 DNS、
  不 fetch 结果页面。
- publication_date 只来自 provider 真实字段归一化（ISO 日期或 RFC1123），
  缺失/非法为 None，绝不用当前时间或抓取时间代填；title 超长置 None 但保留
  条目链接；snippet 截到 500 码点并显式 ``snippet_truncated=True``。
- 请求与失败信封不回显上游响应原文/异常文本/Key；``reason`` 全部固定短句。
- ``provider_http_status`` 走请求局部传递（成功返回值或失败异常属性），
  不存实例共享字段，并发请求互不串值。
- 总 deadline（默认 10 秒）用 ``asyncio.wait_for`` 真实取消；流式读取解压后
  body 上限 256 KiB；``asyncio.CancelledError`` 原样上抛。
- client 所有权：外部传入 ``httpx.AsyncClient`` 时由调用方负责关闭（测试可
  注入 MockTransport）；不传时本类自建（固定超时与连接上限、不跟随重定向）
  并在 :meth:`aclose` / ``__aexit__`` 中关闭。关闭幂等。
- Key 为空/空白时服务仍可用：search 返回 no_key 状态（0 请求），不抛异常。
"""

from __future__ import annotations

import asyncio
import encodings.idna as _stdlib_idna
import json
import math
import time
from datetime import date as _date
from datetime import datetime as _datetime
from datetime import timezone as _timezone
from email.utils import parsedate_to_datetime as _parsedate_to_datetime
from typing import Any, Callable, Literal, NamedTuple
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field

# ==================== 固定契约 ====================

PROVIDER_ENDPOINT = "https://api.tavily.com/search"
PROVIDER_DOCS_URL = "https://docs.tavily.com/api-reference/endpoint/search"
PROVIDER_NAME = "tavily"

_SEARCH_DEPTH = "basic"
_DEFAULT_MAX_RESULTS = 3
# 本地硬上限（官方 max_results 允许 0..20，这里保守收紧到 1..5）。
_MIN_MAX_RESULTS = 1
_MAX_MAX_RESULTS = 5

_MAX_QUERY_CODEPOINTS = 300
_MAX_BODY_BYTES = 256 * 1024
_MAX_PROJECTION_ENTRIES = 25
_MAX_TITLE_CHARS = 300
_MAX_SNIPPET_CHARS = 500
_MAX_URL_LENGTH = 2048

_TIMEOUTS = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=2.0)
_DEFAULT_TOTAL_DEADLINE_SECONDS = 10.0
_LIMITS = httpx.Limits(max_connections=4, max_keepalive_connections=2)

# 固定、诚实的应用请求标识：不含 Key/环境值，也不伪装浏览器。
_USER_AGENT = (
    "Travel-Assistant-TavilyWeb/1.0 "
    "(+https://github.com/flower-forever/LangGraph-Smart-Traval-Assitant)"
)

TavilyStatus = Literal[
    "available",
    "no_results",
    "no_usable_results",
    "invalid_request",
    "no_key",
    "timeout",
    "rate_limited",
    "unauthorized",
    "unavailable",
    "failed",
]

# 固定短句，不回显 provider 原文（原文可能含 Key、URL 或任意内容）。
_REASONS: dict[str, str] = {
    "invalid_query": "查询必须为去除首尾空白后 1 到 300 个字符的文本",
    "no_key": "未配置搜索服务 Key，网页资料搜索不可用",
    "timeout": "网页资料搜索请求超时",
    "rate_limited": "网页资料搜索请求过于频繁或配额已用尽，请稍后再试",
    "unauthorized": "搜索服务 Key 未被接受，请检查配置",
    "unavailable": "网页资料搜索服务暂时不可用",
    "failed": "网页资料搜索响应格式异常",
}


# ==================== 查询规范化（纯函数，可独立测） ====================


def _is_utf8_encodable(value: str) -> bool:
    """str 能否无替换地编码为 UTF-8（拒绝孤立代理码点）。"""

    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def normalize_search_query(value: Any) -> str | None:
    """trim 后按 Python Unicode 码点计 1..300；不合法返回 None。

    本地 300 码点是本项目上限，不是官方 API 限制；str 只按码点计数
    （``len(str)``），astral 字符（如 emoji）算 1 个。合法 JSON 代理对
    解码后的 astral 字符可正常通过；孤立代理码点无法编码为 UTF-8，
    一律视为非法，避免后续 JSON 响应编码崩溃。
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

# ASCII 字母/数字/连字符的 DNS label（不含下划线：下划线在主机名里非法）。
_ASCII_LABEL_RE = None  # 在下方用 str.isascii/isalnum 组合实现，避免 re 依赖差异


def _is_dns_label(label: str) -> bool:
    if not label or len(label) > 63:
        return False
    if not label.isascii():
        return False
    if not all(ch.isalnum() or ch == "-" for ch in label):
        return False
    # 不得以连字符开头或结尾（RFC 1123）。
    return label[0] != "-" and label[-1] != "-"


def _is_valid_punycode_label(label: str) -> bool:
    """``xn--`` 开头的 A-label 必须可被 stdlib IDNA 解码。

    只查 ASCII 形状会把 ``example.xn--a`` 这类无效 punycode 放行，而浏览器
    WHATWG URL 解析拒绝，导致前端整包折算 bad_payload、同批合法结果一并
    丢失。这里用 stdlib :func:`encodings.idna.ToUnicode`（零新依赖）真实
    解码验证。已知保守差异：IDNA2003 比 UTS46 nontransitional 更严，个别
    UTS46 可解码 label（如 ``xn--zca``/ß）会被多滤——按保守拒绝处理，
    见 docs/TAVILY_WEB_SOURCES.md，不宣称 WHATWG 等价。
    """

    try:
        # ToASCII 不做解码校验（任意垃圾都接受），必须用 ToUnicode；
        # stdlib 只认小写 ``xn--`` 前缀，大写会原样返回不验证，先 lower。
        _stdlib_idna.ToUnicode(label.lower().encode("ascii"))
    except (UnicodeError, ValueError):
        return False
    return True


def _last_label_has_alpha_tld(label: str) -> bool:
    """末 label 为有效 TLD：≥2 个纯 ASCII 字母，或可解码 punycode ``xn--``。

    punycode TLD（如 xn--p1ai）是 IDN 顶极域的标准 ASCII 形式，放行；
    混数字（com1）、单字母（c）、纯数字仍拒绝；无效 A-label（如 xn--a）
    拒绝。
    """

    if len(label) >= 2 and label.isalpha() and label.isascii():
        return True
    # 标准 punycode：xn-- 后至少 2 个 ASCII 字母数字（RFC 3490 形式）。
    if label.lower().startswith("xn--") and len(label) > 4:
        rest = label[4:]
        if not (
            rest.isascii()
            and all(ch.isalnum() or ch == "-" for ch in rest)
            and rest[0] != "-"
            and rest[-1] != "-"
        ):
            return False
        return _is_valid_punycode_label(label)
    return False


def _reject_local_or_ip_host(host: str) -> bool:
    """命中本地/伪 IP 形态返回 True（应拒绝）。host 已为小写 ASCII。"""

    if host == "localhost" or host.endswith(".localhost"):
        return True
    if host.endswith(".local") or host.endswith(".internal"):
        return True
    labels = host.split(".")
    if len(labels) < 2:
        return True
    last = labels[-1]
    # 纯数字末 label（如 example.127 / 2130706433 这类单 label 已在上面挡），
    # 或十六进制样式（0x…）：都不是可展示的公共域名。
    if last.isdigit():
        return True
    if last.startswith("0x") or last.startswith("0X"):
        return True
    # 八进制风格全数字段（0177 等）已由 isdigit 分支覆盖；再挡全 label 均
    # 为 0-9 组成、但末 label 带前导 0 的 IP 变体（如 010.1.1.1）。
    if all(label.isdigit() for label in labels):
        return True
    return False


def is_shareable_https_url(value: Any) -> bool:
    """结果链接的保守白名单：仅"适合展示给用户的公共 https 网页"。

    只做语法级检查（不解析 DNS、不访问网络）。首批策略：

    - scheme 必须严格 https；无 userinfo；无控制字符/空白；
    - host 为 ASCII（标准 punycode 形式可，原始 Unicode host 拒绝）；
    - 端口仅允许省略或 443；
    - 拒绝 IP 字面量（v4/v6）、localhost/.local/.internal、单 label、
      整数/十六进制/八进制别名、纯数字末 label；
    - 总长 ≤2048。
    """

    if not isinstance(value, str):
        return False
    if not value or len(value) > _MAX_URL_LENGTH:
        return False
    # 孤立代理码点无法编码进 UTF-8 响应：按不安全链接拒绝。
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
    if not isinstance(hostname, str) or not hostname:
        return False
    host = hostname.lower()
    if not host.isascii():
        return False
    if _reject_local_or_ip_host(host):
        return False
    # v6 字面量：urlsplit 的 hostname 不含方括号；形如 ":" 的都已在
    # label 检查挡掉，这里再显式拒绝冒号形态（v6 一定带冒号）。
    if ":" in host:
        return False
    labels = host.split(".")
    if not all(_is_dns_label(label) for label in labels):
        return False
    if not _last_label_has_alpha_tld(labels[-1]):
        return False
    # 所有 xn-- label（含 TLD 以外的中间 label）同样必须可解码：WHATWG
    # URL 解析会对每个 A-label 做 IDNA 解码，任一无效即整 URL 拒绝。
    for label in labels:
        if label.lower().startswith("xn--") and not _is_valid_punycode_label(label):
            return False
    # 端口：urlsplit.port 解析失败（非法端口）或非 443 一律拒绝。
    try:
        port = parts.port
    except ValueError:
        return False
    if port is not None and port != 443:
        return False
    return True


# ==================== publication_date 归一化（纯函数） ====================


def normalize_publication_date(value: Any) -> str | None:
    """provider 真实字段 → YYYY-MM-DD；缺失/非法为 None，绝不用当前时间。"""

    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    # ISO 日期（YYYY-MM-DD）：严格校验为真实日历日。
    if len(text) == 10:
        try:
            parsed = _date.fromisoformat(text)
        except ValueError:
            return None
        return parsed.isoformat()
    # RFC1123（HTTP 日期，官方示例 "Tue, 11 Mar 2025 17:00:00 GMT"）。
    try:
        parsed_dt = _parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return None
    if parsed_dt is None:
        return None
    if parsed_dt.tzinfo is None:
        return None
    return parsed_dt.astimezone(_timezone.utc).date().isoformat()


# ==================== 响应信封（独立于 Trip v1） ====================


class WebSourceMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = PROVIDER_NAME
    endpoint: str = PROVIDER_ENDPOINT
    docs_url: str = PROVIDER_DOCS_URL


class WebSearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None
    url: str
    snippet: str | None
    snippet_truncated: bool
    publication_date: str | None


class WebSearchReport(BaseModel):
    """search 的返回信封。失败路径不抛业务异常，只设置 status/reason。"""

    model_config = ConfigDict(extra="forbid")

    status: TavilyStatus
    reason: str | None = None
    provider_http_status: int | None = None
    checked_at: str
    fetched_at: str | None = None
    requested_query: str | None = None
    max_results: int
    results_seen: int = 0
    results: list[WebSearchResult] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    source: WebSourceMeta = Field(default_factory=WebSourceMeta)
    content_status: Literal["unverified"] = "unverified"


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


class _BodyTooLarge(_UpstreamStatusError):
    pass


class TavilyResponseError(_UpstreamStatusError):
    """provider 响应结构性损坏：root 非对象、results 非数组等。"""


# ==================== 响应解析（纯函数，可独立测） ====================


class ParsedResults(NamedTuple):
    candidates: list[WebSearchResult]
    notes: list[str]
    results_seen: int
    results_all_count: int


def parse_search_payload(
    payload: Any,
    *,
    max_results: int,
) -> ParsedResults:
    """把 Tavily JSON 响应投影为可展示结果列表。

    结构性损坏抛 :class:`TavilyResponseError`（调用方折算为 failed）。
    单条字段非法只跳过并计数；URL 不安全的条目丢弃并计数。
    """

    if not isinstance(payload, dict):
        raise TavilyResponseError("root not object")
    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        raise TavilyResponseError("missing results")

    notes: list[str] = []
    seen = len(raw_results)
    if seen > _MAX_PROJECTION_ENTRIES:
        notes.append(f"上游返回 {seen} 条，仅处理前 {_MAX_PROJECTION_ENTRIES} 条")

    candidates: list[WebSearchResult] = []
    dropped_unsafe_url = 0
    dropped_malformed = 0
    dropped_long_title = 0

    for entry in raw_results[:_MAX_PROJECTION_ENTRIES]:
        if not isinstance(entry, dict):
            dropped_malformed += 1
            continue

        # 上游 JSON 不可信：合法 JSON 允许 \uD800 这类孤立代理转义，Python
        # 解码后得到无法编码为 UTF-8 的 str。不能替换字符伪造摘要，也不能
        # 让它进入响应导致 UnicodeEncodeError；最小策略是整份 typed failed。
        if any(
            isinstance(entry.get(key), str)
            and not _is_utf8_encodable(entry[key])
            for key in ("title", "content", "published_date")
        ):
            raise TavilyResponseError("non-utf8 result text")

        raw_url = entry.get("url")
        if not is_shareable_https_url(raw_url):
            dropped_unsafe_url += 1
            continue
        url = raw_url

        raw_title = entry.get("title")
        title: str | None = None
        if isinstance(raw_title, str) and raw_title.strip():
            if len(raw_title) <= _MAX_TITLE_CHARS:
                title = raw_title
            else:
                dropped_long_title += 1

        raw_content = entry.get("content")
        snippet: str | None = None
        snippet_truncated = False
        if isinstance(raw_content, str) and raw_content.strip():
            snippet = raw_content
            if len(snippet) > _MAX_SNIPPET_CHARS:
                snippet = snippet[:_MAX_SNIPPET_CHARS]
                snippet_truncated = True

        try:
            candidates.append(
                WebSearchResult(
                    title=title,
                    url=url,
                    snippet=snippet,
                    snippet_truncated=snippet_truncated,
                    publication_date=normalize_publication_date(
                        entry.get("published_date")
                    ),
                )
            )
        except Exception:  # noqa: BLE001 — pydantic 校验失败按坏条目跳过
            dropped_malformed += 1
            continue

    if dropped_unsafe_url:
        notes.append(f"{dropped_unsafe_url} 条结果链接未通过安全检查，未展示")
    if dropped_malformed:
        notes.append(f"{dropped_malformed} 条结果结构异常，未展示")
    if dropped_long_title:
        notes.append(f"{dropped_long_title} 条标题过长，仅显示为未提供标题")

    if len(candidates) > max_results:
        notes.append(f"结果按来源顺序仅保留前 {max_results} 条，未声称完整")
        candidates = candidates[:max_results]

    return ParsedResults(
        candidates=candidates,
        notes=notes,
        results_seen=seen,
        results_all_count=seen,
    )


# ==================== 客户端 ====================


class TavilyWebClient:
    """Tavily 网页资料搜索异步客户端（单查询、单次 upstream 尝试）。

    client 所有权：外部传入 ``httpx.AsyncClient`` 时由调用方负责关闭；
    不传时本类自建（固定超时与连接上限、不跟随重定向）并在 :meth:`aclose` /
    ``__aexit__`` 中关闭。关闭幂等。
    """

    def __init__(
        self,
        *,
        api_key: str | None,
        max_results: int = _DEFAULT_MAX_RESULTS,
        total_deadline_seconds: float = _DEFAULT_TOTAL_DEADLINE_SECONDS,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.monotonic,
        now_utc: Callable[[], _datetime] = lambda: _datetime.now(_timezone.utc),
    ) -> None:
        # 本地配置合同：在任何 HTTP 资源分配之前校验，非法配置不留半初始化
        # 对象、不遗留 owned client（与 PoiSourcesClient 同口径）。
        if api_key is not None and not isinstance(api_key, str):
            raise TypeError("api_key 必须为字符串或 None")
        self._api_key = api_key.strip() if isinstance(api_key, str) else None

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

    async def __aenter__(self) -> "TavilyWebClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
        self._client = None
        self._closed = True

    # ---------- 公开接口 ----------

    async def search(self, query: Any) -> WebSearchReport:
        """按用户查询搜索网页资料。非法输入/无 Key 不发请求，直接返回。"""

        checked_at = self._now_utc().isoformat()
        normalized = normalize_search_query(query)
        if normalized is None:
            return WebSearchReport(
                status="invalid_request",
                reason=_REASONS["invalid_query"],
                checked_at=checked_at,
                max_results=self._max_results,
            )

        api_key = self._api_key
        if not api_key:
            return WebSearchReport(
                status="no_key",
                reason=_REASONS["no_key"],
                checked_at=checked_at,
                requested_query=normalized,
                max_results=self._max_results,
            )

        try:
            body_bytes, http_status = await self._fetch_payload(normalized)
        except asyncio.CancelledError:
            raise
        except httpx.TimeoutException:
            return WebSearchReport(
                status="timeout",
                reason=_REASONS["timeout"],
                checked_at=checked_at,
                requested_query=normalized,
                max_results=self._max_results,
            )
        except _RateLimited as exc:
            return WebSearchReport(
                status="rate_limited",
                reason=_REASONS["rate_limited"],
                checked_at=checked_at,
                requested_query=normalized,
                max_results=self._max_results,
                provider_http_status=exc.provider_http_status,
            )
        except _Unauthorized as exc:
            return WebSearchReport(
                status="unauthorized",
                reason=_REASONS["unauthorized"],
                checked_at=checked_at,
                requested_query=normalized,
                max_results=self._max_results,
                provider_http_status=exc.provider_http_status,
            )
        except (httpx.HTTPError, OSError) as exc:
            return WebSearchReport(
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
            return WebSearchReport(
                status="failed",
                reason=_REASONS["failed"],
                checked_at=checked_at,
                requested_query=normalized,
                max_results=self._max_results,
                provider_http_status=exc.provider_http_status,
            )

        # fetched_at 只在成功读取 2xx body 且 JSON/结构解析可信之后设置；
        # 坏 JSON / 坏结构走 _failed_report（fetched_at=None），不冒充可信。
        try:
            payload = json.loads(body_bytes.decode("utf-8"))
        except (ValueError, UnicodeDecodeError, RecursionError):
            return self._failed_report(
                checked_at=checked_at,
                requested_query=normalized,
                provider_http_status=http_status,
            )

        try:
            parsed = parse_search_payload(payload, max_results=self._max_results)
        except TavilyResponseError:
            return self._failed_report(
                checked_at=checked_at,
                requested_query=normalized,
                provider_http_status=http_status,
            )

        if parsed.candidates:
            status: TavilyStatus = "available"
        elif parsed.results_seen == 0:
            status = "no_results"
        else:
            status = "no_usable_results"
            notes = list(parsed.notes)
            if not any("无法安全展示" in note for note in notes):
                notes.append(
                    f"取得 {parsed.results_seen} 条结果，但均无法安全展示"
                )
        if status != "no_usable_results":
            notes = list(parsed.notes)
        # fetched_at 在 body 成功读取且结构解析可信之后才设置；坏 JSON /
        # 坏结构走 _failed_report（fetched_at=None），不用半途时间冒充。
        fetched_at = self._now_utc().isoformat()
        return WebSearchReport(
            status=status,
            checked_at=checked_at,
            fetched_at=fetched_at,
            requested_query=normalized,
            max_results=self._max_results,
            provider_http_status=http_status,
            results_seen=parsed.results_seen,
            results=parsed.candidates,
            notes=notes,
        )

    # ---------- 内部实现 ----------

    def _failed_report(
        self,
        *,
        checked_at: str,
        requested_query: str,
        provider_http_status: int | None,
    ) -> WebSearchReport:
        return WebSearchReport(
            status="failed",
            reason=_REASONS["failed"],
            checked_at=checked_at,
            fetched_at=None,
            requested_query=requested_query,
            max_results=self._max_results,
            provider_http_status=provider_http_status,
        )

    async def _fetch_payload(self, query: str) -> tuple[bytes, int]:
        """单次 POST 官方 endpoint，返回 (body, provider_http_status)。

        无重试、不跟随重定向；Key 只在 Authorization header。
        """

        if self._closed or self._client is None:
            raise RuntimeError("TavilyWebClient 已关闭或未初始化 HTTP 客户端")

        deadline = self._clock() + self._total_deadline_seconds
        request_body = {
            "query": query,
            "search_depth": _SEARCH_DEPTH,
            "max_results": self._max_results,
            "include_answer": False,
            "include_raw_content": False,
            "include_published_date": True,
        }

        async def _do_request() -> tuple[bytes, int]:
            # follow_redirects 显式 False：外部注入的 client 可能开了 True。
            async with self._client.stream(
                "POST",
                PROVIDER_ENDPOINT,
                json=request_body,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "User-Agent": _USER_AGENT,
                },
                follow_redirects=False,
            ) as response:
                status = response.status_code
                if response.is_redirect:
                    raise TavilyResponseError(
                        "unexpected redirect", provider_http_status=status
                    )
                if status == 429 or status == 432:
                    raise _RateLimited(
                        "rate limited", provider_http_status=status
                    )
                if status in (401, 403):
                    raise _Unauthorized(
                        "unauthorized", provider_http_status=status
                    )
                if status >= 500:
                    # 错误正文不解析、不消费，防无限错误流。
                    raise _UpstreamHTTPError(
                        "provider unavailable", provider_http_status=status
                    )
                if not (200 <= status < 300):
                    raise TavilyResponseError(
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
        """流式读取解压后的 body，带 256 KiB 上限和总 deadline。"""

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


# ==================== 内部信号异常（命名在信封之后便于阅读） ====================


class _RateLimited(_UpstreamStatusError):
    """上游 429/432（配额或频率）。"""


class _Unauthorized(_UpstreamStatusError):
    """上游 401/403（Key 未被接受）。"""

"""
智能出行助手 - FastAPI 服务器
提供 HTTP API 接口供前端或其他服务调用

启动策略：
- 未配置 DASHSCOPE_API_KEY 时服务仍然启动，GET /api/trips/example 可正常浏览；
  /chat 与 /api/trips/plan 返回明确的 503，而不是伪造结果。
- MCP 初始化、模型初始化都做渐进降级：依赖缺失、venv 路径失效、上游超时都不会
  阻止 FastAPI 启动。
- 新增的结构化行程逻辑在 travel_itinerary.py，保持 /chat、/tools 等旧接口兼容。
- 地图增强有独立的 MAP_ENRICH_TIMEOUT（默认 40 秒）；超时只降级为纯文字行程，
  不影响已经完成的模型调用。
- 默认只监听 127.0.0.1（本机预览且没有认证）；显式设置 API_HOST（例如 0.0.0.0）
  才会对外监听，启动日志与 /health 的 warnings 会提示该风险。
- CORS 只信任显式来源（默认本机前端 5173/5181/5182），不使用 "*" + credentials。
  带 Origin 的写请求（POST/PUT/PATCH/DELETE）在进入路由前还会经过来源守卫，
  避免“CORS 只阻止浏览器读取响应，副作用却已经发生”。可用 CORS_ORIGINS
  （逗号分隔的绝对 http(s) origin）覆盖；配置为空或非法时 fail-closed。
- /chat 的模型调用使用 CHAT_TIMEOUT（默认 120 秒）单独限时，消息长度限制为
  1..4000 字符；超时返回 504，不吞掉外层取消。
"""
import asyncio
import inspect
import ipaddress
import json
import math
import os
import re
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

from day_replan import DayReplanRequest, DayReplanResponse, run_day_replan
from travel_itinerary import (
    AMapClient,
    ItineraryParseError,
    TripPlan,
    TripPlanRequest,
    build_agent_prompt,
    build_example_trip,
    dedupe_warnings,
    enrich_trip_with_map,
    extract_agent_text,
    extract_json_object,
    is_planner_safe_tool,
    normalize_agent_payload,
)

BASE_DIR = Path(__file__).resolve().parent

# 加载环境变量：优先当前工作目录，其次项目目录，兼容从任意目录启动
load_dotenv()
load_dotenv(BASE_DIR / ".env")

# ==================== 可选的重依赖 ====================
# FastAPI 示例接口不依赖这些库。缺失时只禁用对应的动态能力，不阻止导入与启动。

create_react_agent = None
MemorySaver = None
ChatTongyi = None
HumanMessage = None
MultiServerMCPClient = None

_LANGGRAPH_IMPORT_ERROR: Optional[str] = None
_MODEL_IMPORT_ERROR: Optional[str] = None
_MCP_IMPORT_ERROR: Optional[str] = None

try:
    from langgraph.prebuilt import create_react_agent  # type: ignore[no-redef]
    from langgraph.checkpoint.memory import MemorySaver  # type: ignore[no-redef]
except Exception as exc:  # pragma: no cover - 仅依赖缺失时命中
    _LANGGRAPH_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

try:
    from langchain_community.chat_models import ChatTongyi  # type: ignore[no-redef]
    from langchain_core.messages import HumanMessage  # type: ignore[no-redef]
except Exception as exc:  # pragma: no cover
    _MODEL_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"

try:
    from langchain_mcp_adapters.client import MultiServerMCPClient  # type: ignore[no-redef]
except Exception as exc:  # pragma: no cover - 本机常见缺少该可选依赖
    _MCP_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"


# ==================== 配置类 ====================

# 地图增强（地址解析 + 路线）单独限时，避免网络抖动把请求拖到模型超时之外。
# 默认值留出足够余量覆盖多站点并发请求，同时远小于 TRIP_PLAN_TIMEOUT。
DEFAULT_MAP_ENRICH_TIMEOUT = 40.0

# /chat 的模型调用单独限时，避免请求无限挂起。
DEFAULT_CHAT_TIMEOUT = 120.0

# 单日 AI 重规划只调用一次 planner graph，使用独立于整趟规划的 90 秒上限；
# 底层模型仍可能发生多次内部调用，这里限制的是一次 graph 调用。
DEFAULT_TRIP_REPLAN_TIMEOUT = 90.0

# CORS：只使用显式 origin，绝不再用 "*" + credentials。
# 默认覆盖本机前端开发端口 5173，以及当前/后续预览使用的 5181、5182；
# 127.0.0.1 与 localhost 视为等价来源分别列出。其它端口用 CORS_ORIGINS 覆盖。
DEFAULT_CORS_ORIGINS: tuple[str, ...] = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:5181",
    "http://localhost:5181",
    "http://127.0.0.1:5182",
    "http://localhost:5182",
)
CORS_ORIGINS_ENV = "CORS_ORIGINS"
CORS_CONFIG_DEFAULT = "default"
CORS_CONFIG_CUSTOM = "custom"
CORS_CONFIG_FAIL_CLOSED = "fail_closed"

LOOPBACK_HOSTNAMES = frozenset({"127.0.0.1", "localhost", "::1"})
MUTATING_HTTP_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# 常规主机名（RD 里常见下划线，一并允许）；IPv6 走 ipaddress 校验。
_ORIGIN_HOST_RE = re.compile(
    r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$"
)


def _positive_finite_timeout(name: str, default: float) -> float:
    """读取正数超时配置；缺失、非法、非有限或非正数时回退默认值。"""

    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value) or value <= 0:
        return default
    return value


def _normalize_origin(raw: Any) -> Optional[str]:
    """把 origin 规范化为 ``scheme://host[:port]``，不合法时返回 None。

    只接受绝对 http(s) origin：拒绝通配符、用户信息、路径、查询、片段、
    非法端口和非常规主机名。返回值是重新拼装的，不直接回显输入。
    """

    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text or len(text) > 2048:
        return None
    if any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text):
        return None
    if "*" in text:
        return None

    try:
        parts = urlsplit(text)
    except ValueError:
        return None

    scheme = (parts.scheme or "").lower()
    if scheme not in {"http", "https"}:
        return None
    if not parts.netloc or "@" in parts.netloc:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    if parts.path not in {"", "/"} or parts.query or parts.fragment:
        return None

    try:
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if not hostname:
        return None
    if port is not None and not 1 <= port <= 65535:
        return None
    if "%" in hostname:
        return None

    if ":" in hostname:
        try:
            ipaddress.IPv6Address(hostname)
        except ValueError:
            return None
        host_for_url = f"[{hostname}]"
    else:
        if not _ORIGIN_HOST_RE.fullmatch(hostname):
            return None
        if "." in hostname and re.fullmatch(r"[0-9.]+", hostname):
            try:
                ipaddress.IPv4Address(hostname)
            except ValueError:
                return None
        host_for_url = hostname

    default_port = 443 if scheme == "https" else 80
    if port == default_port:
        port = None
    netloc = host_for_url if port is None else f"{host_for_url}:{port}"
    return f"{scheme}://{netloc}"


def _origin_rejection_reason(raw: str) -> str:
    """给出固定的拒绝原因，便于排障且不回显原始配置值。"""

    text = raw.strip()
    if not text:
        return "为空"
    if "*" in text:
        return "不允许通配符"
    if any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in text):
        return "包含空白或控制字符"
    try:
        parts = urlsplit(text)
    except ValueError:
        return "URL 无法解析"
    scheme = (parts.scheme or "").lower()
    if scheme not in {"http", "https"}:
        return "不是 http(s) 绝对地址"
    if not parts.netloc:
        return "缺少主机名"
    if (
        "@" in parts.netloc
        or parts.username is not None
        or parts.password is not None
    ):
        return "不允许用户信息"
    if parts.path not in {"", "/"}:
        return "不允许路径"
    if parts.query or parts.fragment:
        return "不允许查询或片段"
    try:
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        return "主机或端口无效"
    if not hostname:
        return "缺少主机名"
    if port is not None and not 1 <= port <= 65535:
        return "端口无效"
    if "%" in hostname:
        return "主机名无效"
    if ":" in hostname:
        try:
            ipaddress.IPv6Address(hostname)
        except ValueError:
            return "IPv6 主机无效"
    elif not _ORIGIN_HOST_RE.fullmatch(hostname):
        return "主机名无效"
    elif "." in hostname and re.fullmatch(r"[0-9.]+", hostname):
        try:
            ipaddress.IPv4Address(hostname)
        except ValueError:
            return "IPv4 主机无效"
    return "格式无效"


def _resolve_cors_origins(raw: Optional[str]) -> tuple[list[str], str, list[str]]:
    """解析 CORS_ORIGINS，返回 ``(origins, state, warnings)``。

    - 未设置（None）：使用本机前端默认来源。
    - 显式设置：逗号分隔的绝对 http(s) origin。任意一项为空或非法时
      整份配置 fail-closed（不信任任何跨域浏览器来源），避免“部分生效”
      让运维误判实际放行的范围；修正后重启生效。
    - 空值：同样 fail-closed。
    警告里只有序号和固定原因，不回显原始配置值。
    """

    if raw is None:
        return list(DEFAULT_CORS_ORIGINS), CORS_CONFIG_DEFAULT, []

    if not raw.strip():
        warning = (
            f"{CORS_ORIGINS_ENV} 为空，已按 fail-closed 处理：不信任任何跨域"
            " 浏览器来源（127.0.0.1/localhost 同源请求不受影响）；"
            "修正后重启服务生效。"
        )
        return [], CORS_CONFIG_FAIL_CLOSED, [warning]

    origins: list[str] = []
    problems: list[str] = []
    for index, entry in enumerate(raw.split(","), start=1):
        text = entry.strip()
        if not text:
            problems.append(f"第 {index} 项为空")
            continue
        origin = _normalize_origin(text)
        if origin is None:
            problems.append(f"第 {index} 项{_origin_rejection_reason(text)}")
            continue
        if origin not in origins:
            origins.append(origin)

    if problems:
        reason_text = "；".join(problems[:3])
        if len(problems) > 3:
            reason_text += f"；另有 {len(problems) - 3} 项问题"
        warning = (
            f"{CORS_ORIGINS_ENV} 配置不合法（{reason_text}），已按 fail-closed "
            "处理：整份配置不生效，不信任任何跨域浏览器来源"
            "（127.0.0.1/localhost 同源请求不受影响）；"
            "修正后重启服务生效，未回显原始配置值。"
        )
        return [], CORS_CONFIG_FAIL_CLOSED, [warning]

    if not origins:  # 双重保险：正常不会走到这里。
        warning = (
            f"{CORS_ORIGINS_ENV} 没有可用的 origin，已按 fail-closed 处理："
            "不信任任何跨域浏览器来源。"
        )
        return [], CORS_CONFIG_FAIL_CLOSED, [warning]

    return origins, CORS_CONFIG_CUSTOM, []


class Configuration:
    """应用配置。每次 lifespan 启动时刷新，便于测试与热启动。"""

    def __init__(self) -> None:
        self.refresh()

    def refresh(self) -> None:
        self.model = os.getenv("MODEL_NAME", "qwen-plus")
        self.api_key = (os.getenv("DASHSCOPE_API_KEY") or "").strip() or None
        self.amap_api_key = (os.getenv("AMAP_API_KEY") or "").strip() or None
        # 默认只监听回环地址：本地预览没有认证，不该默认暴露到局域网。
        # 需要对外监听时显式设置 API_HOST（如 0.0.0.0）。
        self.host = (os.getenv("API_HOST") or "").strip() or "127.0.0.1"
        try:
            self.port = int(os.getenv("API_PORT", "8000"))
        except ValueError:
            self.port = 8000
        try:
            self.mcp_init_timeout = float(os.getenv("MCP_INIT_TIMEOUT", "20"))
        except ValueError:
            self.mcp_init_timeout = 20.0
        try:
            self.plan_timeout = float(os.getenv("TRIP_PLAN_TIMEOUT", "180"))
        except ValueError:
            self.plan_timeout = 180.0
        try:
            self.amap_timeout = float(os.getenv("AMAP_TIMEOUT", "6"))
        except ValueError:
            self.amap_timeout = 6.0
        self.map_enrich_timeout = _positive_finite_timeout(
            "MAP_ENRICH_TIMEOUT", DEFAULT_MAP_ENRICH_TIMEOUT
        )
        self.chat_timeout = _positive_finite_timeout(
            "CHAT_TIMEOUT", DEFAULT_CHAT_TIMEOUT
        )
        self.replan_timeout = _positive_finite_timeout(
            "TRIP_REPLAN_TIMEOUT", DEFAULT_TRIP_REPLAN_TIMEOUT
        )
        (
            self.cors_origins,
            self.cors_config_state,
            self.cors_warnings,
        ) = _resolve_cors_origins(os.getenv(CORS_ORIGINS_ENV))

    def allows_origin(self, origin: Any) -> bool:
        """判断浏览器 Origin 是否在显式白名单内（不做通配符或前缀匹配）。"""

        normalized = _normalize_origin(origin)
        return normalized is not None and normalized in self.cors_origins

    @staticmethod
    def load_servers() -> dict:
        """加载 MCP 服务器配置（相对项目目录，避免受启动 cwd 影响）。"""
        config_path = BASE_DIR / "servers_config.json"
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        servers = config.get("mcpServers", {})
        return servers if isinstance(servers, dict) else {}

    @staticmethod
    def load_prompt() -> str:
        """加载系统提示词（相对项目目录）。"""
        prompt_path = BASE_DIR / "agent_prompts.txt"
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()


FALLBACK_PROMPT = (
    "你是专业的智能出行助手，名叫“小途”。你可以查询天气、地图、路线和费用，"
    "回答时使用清晰、友好的中文。不要编造实时数据。"
)

# 结构化规划模式：即使 Agent 仍带着通用系统提示词，也强制它只返回 JSON。
PLANNER_MODE_APPENDIX = """

## 结构化行程规划模式

当用户消息要求输出 JSON 行程时：
- 只输出一个 JSON 对象，不要输出解释、Markdown 代码块或额外文字。
- 不要调用文件读写、保存、删除类工具。
- 不要编造实时价格、营业状态、门票余量或预订信息。
"""


# ==================== 请求/响应模型 ====================


class ChatRequest(BaseModel):
    """聊天请求

    - message 限制 1..4000 字符，避免空消息和超长输入拖垮模型调用。
    - thread_id 保持原有默认值 "default"，不新增约束，兼容旧调用方。
    """

    message: str = Field(..., min_length=1, max_length=4000)
    thread_id: str = "default"


class ChatResponse(BaseModel):
    """聊天响应"""
    content: str
    thread_id: str


class HealthResponse(BaseModel):
    """健康检查响应（在旧字段基础上追加降级状态）"""
    status: str
    tools_count: int
    model: str
    agent_ready: bool = False
    planner_ready: bool = False
    mcp_ready: bool = False
    amap_configured: bool = False
    warnings: list[str] = Field(default_factory=list)


# ==================== 全局变量 ====================

cfg = Configuration()
mcp_client: Optional[Any] = None
agent: Optional[Any] = None
planner_agent: Optional[Any] = None
available_tools: list[Any] = []
startup_warnings: list[str] = []
planner_unavailable_reason: str = (
    "结构化行程规划 Agent 尚未初始化：请配置 DASHSCOPE_API_KEY 并检查启动日志；"
    "示例行程仍可通过 GET /api/trips/example 浏览。"
)


def _print_safe(message: str) -> None:
    """Windows GBK 控制台下 emoji 可能触发 UnicodeEncodeError，降级为可打印文本。"""
    try:
        print(message)
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, "encoding", None) or "ascii"
        try:
            print(message.encode(encoding, "replace").decode(encoding, "replace"))
        except Exception:
            print(message.encode("ascii", "replace").decode("ascii"))


def _warn(message: str) -> None:
    """记录并打印启动降级信息，不抛异常。"""
    text = re.sub(r"\s+", " ", str(message)).strip()
    if not text:
        return
    if text not in startup_warnings:
        startup_warnings.append(text)
    _print_safe(f"⚠️  {text}")


# 常见保密字段名（大小写不敏感）；长名在前，避免 access_token 只匹配到 token。
# appid / appkey 是高德等上游的常用风控字段，与 api_key 放在一起，先于更短的名字。
_SECRET_FIELD_NAMES = (
    r"api[_-]?key",
    r"app[_-]?key",
    r"app[_-]?id",
    r"access[_-]?token",
    r"auth[_-]?token",
    r"refresh[_-]?token",
    r"client[_-]?secret",
    r"secret[_-]?key",
    r"password",
    r"passwd",
    r"secret",
    r"token",
)

# 键值对形态的脱敏规则，同时覆盖：
# - JSON / dict：{"apiKey": "..."}、{'api_key': '...'}（键和值带引号，值可含空格）；
# - 表单 / 日志：password=...、token: ...；
# - URL 查询串：?api_key=...&model=qwen（到 & 或空白为止）；
# - appid / appkey 系列字段（含 app_id、app_key、app-id、APP-KEY 等写法与大小写）。
_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)"
    r"(?P<key_open>[\"']?)"
    rf"(?P<key>{'|'.join(_SECRET_FIELD_NAMES)})"
    r"(?P<key_close>[\"']?)"
    r"(?P<sep>\s*[=:]\s*)"
    r"(?P<value>"
    r"\"(?:[^\"\\]|\\.)*\""
    r"|'(?:[^'\\]|\\.)*'"
    r"|[\"'][^\s&,;]*"
    r"|[^\s\"'&,;<>(){}\[\]]+"
    r")"
)

# 独立的 key 字段：URL / JSON / 单引号参数直接用 key=<值>、"key":"<值>"。
# key 的左侧用词边界，避免把 monkey=banana 这类单词内部命中一并抹掉。
_GENERIC_KEY_RE = re.compile(
    r"(?i)"
    r"(?P<key_open>[\"']?)"
    r"(?<![A-Za-z0-9_-])"
    r"(?P<key>key)"
    r"(?P<key_close>[\"']?)"
    r"(?P<sep>\s*[:=]\s*)"
    r"(?P<value>"
    r"\"(?:[^\"\\]|\\.)*\""
    r"|'(?:[^'\\]|\\.)*'"
    r"|[\"'][^\s&,;]*"
    r"|[^\"'&,;<>(){}\[\]]+"
    r")"
)

# Authorization 头：Basic 及任意自定义方案都完整遮蔽（scheme 与凭据一起抹掉），
# 值可以是带空格/标点的引号串，也可以是裸的 scheme+credential 形式；字段名保留。
# 分隔符可以是 [=:] 也可以只是空格（Authorization Basic dXNlcj... 这类日志也覆盖），
# 但至少要有一个分隔字符，KeyError: 'Authorization' 这类普通文本不受影响。
_AUTHORIZATION_RE = re.compile(
    r"(?i)"
    r"(?P<key_open>[\"']?)"
    r"(?P<key>authorization)"
    r"(?P<key_close>[\"']?)"
    r"(?P<sep>\s*[:=]\s*|\s+)"
    r"(?P<value>"
    r"\"(?:[^\"\\]|\\.)*\""
    r"|'(?:[^'\\]|\\.)*'"
    r"|[A-Za-z][\w\-.]*\s+[^&\s,;<>(){}\[\]\"']+"
    r"|[^&\s\"'&,;]+"
    r")"
)

# 裸 Bearer 兜底：不依赖 Authorization 前缀；token 不再要求至少 8 字符，
# 带引号、冒号写法也一并遮蔽。词边界防止 nonbearer 这类单词内部命中。
_BEARER_RE = re.compile(
    r"(?i)"
    r"(?P<pre>(?<![A-Za-z0-9_])bearer\s*[:=]?\s*)"
    r"(?P<value>"
    r"\"(?:[^\"\\]|\\.)*\""
    r"|'(?:[^'\\]|\\.)*'"
    r"|[A-Za-z0-9._~/=-]+"
    r")"
)


def _mask_secret_assignment(match: re.Match) -> str:
    """保留字段名和引号形态，只替换值，让错误信息仍能定位到字段。"""

    value = match.group("value")
    quote = value[:1] if value[:1] in {'"', "'"} else ""
    if quote and len(value) >= 2 and value.endswith(quote):
        masked = f"{quote}***{quote}"
    elif quote:
        masked = f"{quote}***"
    else:
        masked = "***"
    return (
        f"{match.group('key_open')}{match.group('key')}"
        f"{match.group('key_close')}{match.group('sep')}{masked}"
    )


def _mask_bearer_token(match: re.Match) -> str:
    """遮蔽裸 Bearer token，保留 ``Bearer`` 字样和引号形态。"""

    value = match.group("value")
    quote = value[:1] if value[:1] in {'"', "'"} else ""
    if quote and len(value) >= 2 and value.endswith(quote):
        masked = f"{quote}***{quote}"
    elif quote:
        masked = f"{quote}***"
    else:
        masked = "***"
    return f"{match.group('pre')}{masked}"


def _safe_error(exc: BaseException) -> str:
    """把异常变成可读文本，并抹掉可能带出的密钥。

    除了已知的配置密钥，这里也会遮蔽常见的 ``token=`` / ``Bearer`` 形式，
    以及 JSON/dict 里 ``"apiKey": "..."`` 这类带引号的键值对；字段名和其它
    诊断信息保持原样，避免把上游错误的原文直接回显给调用方。

    追加覆盖：appid / appkey 系列字段、独立的 ``key`` 字段（词边界限定）、
    Authorization 值（Basic 与任意方案都整体遮蔽）以及短于 8 字符的 Bearer
    token；带空格/标点的引号值同样不掉片段。
    """

    text = str(exc) or type(exc).__name__
    for secret in (cfg.api_key, cfg.amap_api_key):
        if secret:
            text = text.replace(secret, "***")
    text = _AUTHORIZATION_RE.sub(_mask_secret_assignment, text)
    text = _BEARER_RE.sub(_mask_bearer_token, text)
    text = _SECRET_ASSIGNMENT_RE.sub(_mask_secret_assignment, text)
    text = _GENERIC_KEY_RE.sub(_mask_secret_assignment, text)
    text = re.sub(r"\s+", " ", text).strip()
    return (text or type(exc).__name__)[:300]


def _with_map_warning(trip: TripPlan, warning: str) -> TripPlan:
    """保留已生成的行程内容，只追加一条地图增强降级提示。"""

    return trip.model_copy(
        update={"warnings": dedupe_warnings(list(trip.warnings) + [warning])}
    )


async def _enrich_with_amap(trip: TripPlan, request: TripPlanRequest) -> TripPlan:
    """创建并关闭本次请求专用的高德客户端，完成地图增强。"""

    async with AMapClient(cfg.amap_api_key, timeout=cfg.amap_timeout) as amap:
        return await enrich_trip_with_map(trip, request, amap)


async def _apply_map_enrichment(trip: TripPlan, request: TripPlanRequest) -> TripPlan:
    """给已生成的文字行程补地图数据，只对这段增强单独限时。

    - 未配置高德密钥时直接返回，不做无意义的网络等待。
    - 超时只放弃地图数据，保留已生成的文字行程，不编造坐标或路线。
    - 内部任务被取消时 ``async with`` 会关闭 httpx 客户端；外层取消
      （``CancelledError``）不在这里捕获，继续向上传播。
    """

    if not cfg.amap_api_key:
        return await enrich_trip_with_map(trip, request, None)

    try:
        return await asyncio.wait_for(
            _enrich_with_amap(trip, request),
            timeout=cfg.map_enrich_timeout,
        )
    except asyncio.TimeoutError:
        return _with_map_warning(
            trip,
            f"地图数据超时（>{cfg.map_enrich_timeout:g} 秒）："
            "已保留已生成的文字行程，坐标与路线未获取，未使用推测数据。",
        )
    except Exception as exc:
        return _with_map_warning(
            trip,
            "地图数据增强失败，已返回不含实时地图数据的行程：" + _safe_error(exc),
        )


def _resolve_server_config(raw_servers: dict) -> dict:
    """为写死的 Windows venv 路径做渐进降级。

    - servers_config.json 里的 ``.\\venv\\Scripts\\python.exe`` 不存在时，改用当前解释器。
    - 相对路径的 *server.py 参数改成项目目录下的绝对路径，避免启动 cwd 不同导致失败。
    不修改磁盘上的配置文件。
    """

    resolved: dict[str, Any] = {}
    if not isinstance(raw_servers, dict):
        return resolved

    for name, entry in raw_servers.items():
        if not isinstance(entry, dict):
            continue
        item = dict(entry)

        command = item.get("command")
        if isinstance(command, str) and command.strip():
            candidate = Path(command)
            if not candidate.is_absolute():
                candidate = BASE_DIR / command
            command_name = Path(command.replace("\\", "/")).name.lower()
            looks_like_python = "python" in command_name
            if looks_like_python and not candidate.is_file():
                item["command"] = sys.executable
            elif candidate.is_file():
                item["command"] = str(candidate)

        args = item.get("args")
        if isinstance(args, list):
            resolved_args: list[Any] = []
            for arg in args:
                if isinstance(arg, str) and arg.endswith(".py"):
                    candidate = Path(arg)
                    if not candidate.is_absolute():
                        candidate = BASE_DIR / candidate
                    if candidate.is_file():
                        resolved_args.append(str(candidate))
                        continue
                resolved_args.append(arg)
            item["args"] = resolved_args

        resolved[name] = item

    return resolved


async def _initialize_mcp() -> tuple[Any, list[Any]]:
    """初始化 MCP 工具，超时或失败由调用方降级处理。"""

    if MultiServerMCPClient is None:
        raise RuntimeError(
            f"langchain-mcp-adapters 未安装（{_MCP_IMPORT_ERROR or 'import failed'}）"
        )
    servers_cfg = cfg.load_servers()
    if not servers_cfg:
        return None, []
    client = MultiServerMCPClient(_resolve_server_config(servers_cfg))
    tools = await asyncio.wait_for(client.get_tools(), timeout=cfg.mcp_init_timeout)
    return client, list(tools)


# ==================== 生命周期管理 ====================


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI 生命周期管理：任何初始化失败都只降级，不阻止示例接口。"""

    global mcp_client, agent, planner_agent, available_tools
    global startup_warnings, planner_unavailable_reason, prompt

    cfg.refresh()
    startup_warnings = []
    mcp_client = None
    agent = None
    planner_agent = None
    available_tools = []

    # CORS 配置有问题时只降级为 fail-closed，并在 /health 里给出可读原因，
    # 不阻止服务启动，也不回显原始配置值。
    for cors_warning in cfg.cors_warnings:
        _warn(cors_warning)

    planner_unavailable_reason = (
        "结构化行程规划 Agent 尚未初始化：请配置 DASHSCOPE_API_KEY 并检查启动日志；"
        "示例行程仍可通过 GET /api/trips/example 浏览。"
    )
    prompt = FALLBACK_PROMPT

    _print_safe("🚀 正在启动智能出行助手...")

    cors_state_label = {
        CORS_CONFIG_DEFAULT: "默认本机前端",
        CORS_CONFIG_CUSTOM: "CORS_ORIGINS 自定义",
        CORS_CONFIG_FAIL_CLOSED: "fail-closed，仅同源回环请求",
    }.get(cfg.cors_config_state, cfg.cors_config_state)
    _print_safe(f"🌐 CORS 允许来源 {len(cfg.cors_origins)} 个（{cors_state_label}）")
    if cfg.cors_origins:
        _print_safe("   " + ", ".join(cfg.cors_origins))

    if cfg.host not in {"127.0.0.1", "localhost", "::1"}:
        _warn(
            f"API_HOST={cfg.host}：服务监听非回环地址且没有认证，"
            "仅建议在本机预览时使用。"
        )

    try:
        prompt = Configuration.load_prompt()
        _print_safe("✅ 提示词加载完成")
    except Exception as exc:
        _warn(f"读取提示词失败，使用内置提示词：{_safe_error(exc)}")

    model = None
    if not cfg.api_key:
        _warn(
            "未配置 DASHSCOPE_API_KEY：/chat 与 /api/trips/plan 不可用；"
            "GET /api/trips/example 仍可正常浏览。"
        )
        planner_unavailable_reason = (
            "未配置 DASHSCOPE_API_KEY：结构化行程规划需要可用的 LangGraph 模型；"
            "示例行程仍可通过 GET /api/trips/example 浏览。"
        )
    elif ChatTongyi is None or HumanMessage is None:
        _warn(f"LangChain 模型依赖不可用：{_MODEL_IMPORT_ERROR or 'import failed'}")
        planner_unavailable_reason = "LangChain 模型依赖不可用，结构化行程规划暂不可用。"
    elif create_react_agent is None:
        _warn(f"LangGraph 依赖不可用：{_LANGGRAPH_IMPORT_ERROR or 'import failed'}")
        planner_unavailable_reason = "LangGraph 依赖不可用，结构化行程规划暂不可用。"
    else:
        try:
            model = ChatTongyi(
                model=cfg.model,
                dashscope_api_key=cfg.api_key,
                streaming=False,
            )
            _print_safe(f"🤖 模型初始化完成: {cfg.model}")
        except Exception as exc:
            _warn(f"模型初始化失败：{_safe_error(exc)}")
            planner_unavailable_reason = "模型初始化失败，结构化行程规划暂不可用。"

    if model is not None and create_react_agent is not None:
        tools: list[Any] = []
        if MultiServerMCPClient is None:
            _warn("langchain-mcp-adapters 未安装，Agent 将以无 MCP 工具模式运行。")
        else:
            try:
                mcp_client, tools = await _initialize_mcp()
                available_tools = tools
                _print_safe(f"🔧 已加载 {len(tools)} 个 MCP 工具")
            except asyncio.TimeoutError:
                _warn(
                    f"MCP 初始化超时（>{cfg.mcp_init_timeout:g}s），"
                    "Agent 将以无 MCP 工具模式运行。"
                )
            except Exception as exc:
                _warn(f"MCP 初始化失败，Agent 将以无工具模式运行：{_safe_error(exc)}")

        try:
            checkpointer = MemorySaver() if MemorySaver is not None else None
            agent = create_react_agent(
                model=model,
                tools=tools,
                prompt=prompt,
                checkpointer=checkpointer,
            )
            _print_safe("✅ 聊天 Agent 创建完成")
        except Exception as exc:
            _warn(f"聊天 Agent 初始化失败：{_safe_error(exc)}")
            agent = None

        # 规划 Agent 单独初始化：即使它失败，已创建的聊天 Agent 仍可用。
        try:
            planner_tools = [tool for tool in tools if is_planner_safe_tool(tool)]
            planner_agent = create_react_agent(
                model=model,
                tools=planner_tools,
                prompt=prompt + PLANNER_MODE_APPENDIX,
            )
            planner_unavailable_reason = ""
            _print_safe("✅ 结构化规划 Agent 创建完成")
        except Exception as exc:
            _warn(f"结构化规划 Agent 初始化失败：{_safe_error(exc)}")
            planner_agent = None
            planner_unavailable_reason = "结构化规划 Agent 初始化失败，暂无法动态生成行程。"

    if planner_agent is None and not planner_unavailable_reason:
        planner_unavailable_reason = (
            "结构化行程规划 Agent 尚未初始化：请配置 DASHSCOPE_API_KEY 并检查启动日志。"
        )

    _print_safe("=" * 50)
    _print_safe("🎉 智能出行助手启动成功!")
    _print_safe(f"📍 默认配置地址: http://{cfg.host}:{cfg.port}（以实际启动参数为准）")
    _print_safe("🧭 示例行程: GET /api/trips/example")
    if startup_warnings:
        _print_safe(f"⚠️  启动降级提示 {len(startup_warnings)} 条（详见 /health）")
    _print_safe("=" * 50)

    yield  # 应用运行中

    _print_safe("\n🔄 正在关闭服务...")
    _print_safe("👋 服务已关闭")


# ==================== 浏览器来源保护 ====================


class DynamicCORSMiddleware(CORSMiddleware):
    """在运行时读取 Configuration 的 CORS 白名单。

    Starlette 的 CORSMiddleware 在构造时固化 allow_origins；这里改成每次请求
    都查当前配置，让 lifespan 刷新和测试覆盖共用同一份来源列表。
    """

    def is_allowed_origin(self, origin: str) -> bool:
        return cfg.allows_origin(origin)


def _is_loopback_same_origin(scope: Any, headers: Headers, origin: str) -> bool:
    """判断是否为回环地址上的同源请求（用于 /docs 这类同源调用）。

    只认 127.0.0.1、localhost、::1，并且要求 Origin 与请求的 Host 完全一致。
    不把任意 Host 当同源，避免把 DNS rebinding 请求一并放行。
    """

    normalized = _normalize_origin(origin)
    if normalized is None:
        return False
    if urlsplit(normalized).hostname not in LOOPBACK_HOSTNAMES:
        return False

    scheme = str(scope.get("scheme") or "http").lower()
    if scheme not in {"http", "https"}:
        return False
    host_header = headers.get("host") or ""
    candidate = _normalize_origin(f"{scheme}://{host_header}")
    return candidate is not None and candidate == normalized


class BrowserOriginGuardMiddleware:
    """在路由执行前拒绝不允许的浏览器来源写请求。

    CORS 规范只限制浏览器读取响应：一个跨域 POST/DELETE 即使响应不可读，
    路由仍可能已经执行（消耗模型额度、删除会话）。这里对携带 Origin 的
    POST/PUT/PATCH/DELETE 做前置检查；无 Origin 的 CLI/服务端调用保持兼容。

    这里只处理跨域来源，不解决“服务没有认证”“本机其它进程直接调用”
    “DNS rebinding 变体”等更底层的问题。
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        method = str(scope.get("method", "")).upper()
        if method not in MUTATING_HTTP_METHODS:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        origins = headers.getlist("origin")
        if not origins:
            # 非浏览器客户端（curl/httpx/现有测试）通常不带 Origin。
            await self.app(scope, receive, send)
            return

        origin = origins[0]
        if len(origins) == 1 and (
            cfg.allows_origin(origin)
            or _is_loopback_same_origin(scope, headers, origin)
        ):
            await self.app(scope, receive, send)
            return

        # 响应里不回显 Origin，也不设置 CORS 头；请求在进入路由前结束。
        response = JSONResponse(
            {"detail": "该浏览器来源不被允许，请求未执行。"},
            status_code=403,
            headers={"Vary": "Origin", "Cache-Control": "no-store"},
        )
        await response(scope, receive, send)


# ==================== FastAPI 应用 ====================

app = FastAPI(
    title="智能出行助手 API",
    description="基于 LangGraph + MCP 的智能出行助手服务，并提供结构化旅行规划接口",
    version="1.1.0",
    lifespan=lifespan,
)

# 只信任显式 origin；allow_credentials=True 时绝不能再配 allow_origins=["*"]。
app.add_middleware(
    DynamicCORSMiddleware,
    allow_origins=list(DEFAULT_CORS_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# 后添加的中间件位于外层：写请求先经过来源守卫，再进入 CORS/路由。
app.add_middleware(BrowserOriginGuardMiddleware)


# ==================== API 路由 ====================


@app.get("/", response_model=dict)
async def root():
    """根路径"""
    return {
        "name": "智能出行助手 API",
        "version": "1.1.0",
        "status": "running",
    }


def _health_payload() -> HealthResponse:
    """构造健康检查响应；不主动连接 MCP，避免健康探针被上游拖住。"""
    return HealthResponse(
        status="healthy",
        tools_count=len(available_tools),
        model=cfg.model,
        agent_ready=agent is not None,
        planner_ready=planner_agent is not None,
        mcp_ready=mcp_client is not None,
        amap_configured=bool(cfg.amap_api_key),
        warnings=list(startup_warnings),
    )


@app.get("/health", response_model=HealthResponse, summary="健康检查")
async def health_check():
    """健康检查（历史路径）。"""
    return _health_payload()


# Vite 开发服务器只代理 /api，前端探测自己的业务代理时走这个别名。
# 与 /health 共用 _health_payload，保证字段与取值始终一致。
@app.get(
    "/api/health",
    response_model=HealthResponse,
    summary="健康检查（/api 代理别名）",
)
async def api_health_check():
    """与 /health 完全一致的别名；无密钥时同样可用。"""
    return _health_payload()


@app.post(
    "/chat",
    response_model=ChatResponse,
    responses={
        422: {"description": "消息为空或超过 4000 字符"},
        503: {"description": "Agent 或消息依赖未初始化"},
        504: {"description": "聊天响应超时"},
    },
)
async def chat_endpoint(request: ChatRequest):
    """
    聊天接口

    - **message**: 用户消息
    - **thread_id**: 对话线程ID（用于保持上下文）
    """
    if not agent:
        raise HTTPException(
            status_code=503,
            detail=(
                "Agent 尚未初始化：请配置 DASHSCOPE_API_KEY 并检查启动日志；"
                "示例行程仍可通过 GET /api/trips/example 浏览。"
            ),
        )
    if HumanMessage is None:
        raise HTTPException(status_code=503, detail="消息依赖不可用，无法处理聊天请求。")

    try:
        result = await asyncio.wait_for(
            agent.ainvoke(
                {"messages": [HumanMessage(content=request.message)]},
                {"configurable": {"thread_id": request.thread_id}},
            ),
            timeout=cfg.chat_timeout,
        )

        ai_message = result["messages"][-1]
        content = extract_agent_text(ai_message) or str(ai_message)

        return ChatResponse(content=content, thread_id=request.thread_id)

    except asyncio.TimeoutError as exc:
        # wait_for 会取消内部任务；外层取消（CancelledError）不在 Exception
        # 分支里，继续向上传播，不会被误报成 504。
        raise HTTPException(
            status_code=504,
            detail=f"聊天响应超时（>{cfg.chat_timeout:g} 秒），请稍后重试。",
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"处理请求时出错: {_safe_error(exc)}",
        ) from exc


@app.get("/tools")
async def list_tools():
    """列出所有可用工具"""
    if not available_tools:
        raise HTTPException(
            status_code=503,
            detail=(
                "MCP 工具尚未加载：需要可用的模型密钥、langchain-mcp-adapters，"
                "以及能够启动的 MCP 服务器。"
            ),
        )

    return {
        "count": len(available_tools),
        "tools": [
            {
                "name": getattr(tool, "name", ""),
                "description": getattr(tool, "description", ""),
            }
            for tool in available_tools
        ],
    }


@app.get(
    "/api/trips/example",
    response_model=TripPlan,
    summary="获取内置示例行程",
)
async def get_example_trip():
    """返回固定示例行程，source 恒为 example，不需要任何 API Key。"""
    return build_example_trip()


@app.post(
    "/api/trips/plan",
    response_model=TripPlan,
    summary="生成结构化分日行程",
    responses={
        502: {"description": "模型或上游服务失败，返回可读错误"},
        503: {"description": "模型/Agent 未配置，无法动态生成"},
        504: {"description": "行程生成超时"},
    },
)
async def plan_trip(request: TripPlanRequest):
    """通过已初始化的 LangGraph Agent 生成结构化行程，再补地图坐标与路线。

    - 未配置高德密钥时仍返回行程，但坐标为空、路线为 unavailable，并给出 warnings。
    - 地图增强使用独立的 MAP_ENRICH_TIMEOUT；超时只返回文字行程并写入 warnings。
    - 不会把示例数据冒充为动态生成结果。
    """
    if planner_agent is None:
        raise HTTPException(
            status_code=503,
            detail=planner_unavailable_reason
            or "结构化行程规划 Agent 尚未初始化：请配置 DASHSCOPE_API_KEY 并检查启动日志。",
        )
    if HumanMessage is None:
        raise HTTPException(status_code=503, detail="消息依赖不可用，无法生成行程。")

    plan_prompt = build_agent_prompt(request)
    thread_id = f"trip-{uuid.uuid4().hex}"

    try:
        result = await asyncio.wait_for(
            planner_agent.ainvoke(
                {"messages": [HumanMessage(content=plan_prompt)]},
                {"configurable": {"thread_id": thread_id}},
            ),
            timeout=cfg.plan_timeout,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail=f"行程生成超时（>{cfg.plan_timeout:g} 秒），请稍后重试。",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"行程生成失败：{_safe_error(exc)}",
        ) from exc

    try:
        payload = extract_json_object(extract_agent_text(result))
        trip, _ = normalize_agent_payload(payload, request)
    except ItineraryParseError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"模型未返回可用的结构化行程：{_safe_error(exc)}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"行程结构校验失败：{_safe_error(exc)}",
        ) from exc

    # 地图增强是可选能力：独立限时，超时/失败只降级，不丢掉已生成的文字行程。
    trip = await _apply_map_enrichment(trip, request)

    return trip


@app.post(
    "/api/trips/days/replan",
    response_model=DayReplanResponse,
    summary="只重新生成指定一天的行程",
    responses={
        502: {"description": "模型上游失败或模型输出结构非法"},
        503: {"description": "模型/Agent 未配置，无法动态生成"},
        504: {"description": "单日重规划超时"},
    },
)
async def replan_trip_day(request: DayReplanRequest):
    """只重写请求指定的那一天，返回独立信封而不是新 Trip v1。

    - 一次 planner graph 调用（底层模型仍可能多次内部调用），不隐藏重试；
      超时用独立的 TRIP_REPLAN_TIMEOUT（默认 90 秒）。
    - 模型必须恰好返回 1 天；返回 0 天或多天按 502 处理，不补齐、不截断。
    - 站点 id 重新生成，legs 与时间来源记录同步；模型坐标被忽略。
    - 地图增强复用 _enrich_with_amap 并单独限时；无 Key/超时/异常保留文字日程，
      并给出结构化 map_status，不依赖解析中文 warnings。
    - parent 只作为版本令牌原样回显，不持久化。
    """
    if planner_agent is None:
        raise HTTPException(
            status_code=503,
            detail=planner_unavailable_reason
            or "结构化行程规划 Agent 尚未初始化：请配置 DASHSCOPE_API_KEY 并检查启动日志。",
        )
    if HumanMessage is None:
        raise HTTPException(status_code=503, detail="消息依赖不可用，无法生成行程。")

    return await run_day_replan(
        request,
        planner_agent=planner_agent,
        human_message_cls=HumanMessage,
        amap_configured=bool(cfg.amap_api_key),
        replan_timeout=cfg.replan_timeout,
        map_enrich_timeout=cfg.map_enrich_timeout,
        enrich_with_amap=_enrich_with_amap,
        append_map_warning=_with_map_warning,
        safe_error=_safe_error,
    )


def _agent_checkpointer() -> Optional[Any]:
    """取聊天 Agent 实际持有的 checkpointer；没有 Agent 时返回 None。"""
    if agent is None:
        return None
    return getattr(agent, "checkpointer", None)


async def _delete_checkpoint_thread(checkpointer: Any, thread_id: str) -> None:
    """调用 checkpointer 的删除接口，真正清掉该 thread 的检查点与写入。

    优先用异步 ``adelete_thread``（LangGraph 1.x 的 BaseCheckpointSaver 已提供）；
    异步接口未实现或不存在时退回同步 ``delete_thread``。两者都没有时抛
    NotImplementedError，由调用方转成 501，绝不假装成功。
    """
    adelete = getattr(checkpointer, "adelete_thread", None)
    if callable(adelete):
        try:
            pending = adelete(thread_id)
            if inspect.isawaitable(pending):
                await pending
            return
        except NotImplementedError:
            pass

    delete = getattr(checkpointer, "delete_thread", None)
    if callable(delete):
        await asyncio.to_thread(delete, thread_id)
        return

    raise NotImplementedError(
        f"{type(checkpointer).__name__} 未提供 adelete_thread/delete_thread"
    )


@app.delete(
    "/chat/{thread_id}",
    summary="删除指定对话线程的历史记录",
    responses={
        400: {"description": "thread_id 为空"},
        500: {"description": "删除过程中 checkpointer 报错，未修改其它 thread"},
        501: {"description": "当前 checkpointer 不支持删除 thread"},
        503: {"description": "聊天 Agent 或 checkpointer 未初始化，无法删除"},
    },
)
async def clear_chat_history(thread_id: str):
    """真正删除指定 thread 的会话历史，不影响其它 thread。

    只有 checkpointer 的删除调用成功返回后才回 ``deleted: true``；
    没有 Agent/checkpointer 时回 503，checkpointer 不支持删除时回 501，
    删除抛错时回 500，这几种情况都不会声称历史已清除。
    """
    clean_thread_id = (thread_id or "").strip()
    if not clean_thread_id:
        raise HTTPException(status_code=400, detail="thread_id 不能为空。")

    if agent is None:
        raise HTTPException(
            status_code=503,
            detail="聊天 Agent 尚未初始化，无法删除会话历史；未修改任何数据。",
        )

    checkpointer = _agent_checkpointer()
    if checkpointer is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "聊天 Agent 未配置 checkpointer，没有可删除的持久化会话历史。"
            ),
        )

    try:
        await _delete_checkpoint_thread(checkpointer, clean_thread_id)
    except NotImplementedError as exc:
        raise HTTPException(
            status_code=501,
            detail=(
                f"当前 checkpointer（{type(checkpointer).__name__}）不支持删除 thread，"
                "未删除任何会话历史。"
            ),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                f"删除 thread {clean_thread_id} 的会话历史失败：{_safe_error(exc)}"
            ),
        ) from exc

    return {
        "message": f"对话 {clean_thread_id} 的历史记录已删除",
        "thread_id": clean_thread_id,
        "deleted": True,
    }


# ==================== 主入口 ====================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "api_server:app",
        host=cfg.host,
        port=cfg.port,
        reload=True,
    )

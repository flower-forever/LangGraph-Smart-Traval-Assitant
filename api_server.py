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
"""
import asyncio
import inspect
import json
import math
import os
import re
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

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
    """聊天请求"""
    message: str
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


def _safe_error(exc: BaseException) -> str:
    """把异常变成可读文本，并抹掉可能带出的密钥。"""
    text = str(exc) or type(exc).__name__
    for secret in (cfg.api_key, cfg.amap_api_key):
        if secret:
            text = text.replace(secret, "***")
    text = re.sub(r"(?i)(key=)[^&\s]+", r"\1***", text)
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
    planner_unavailable_reason = (
        "结构化行程规划 Agent 尚未初始化：请配置 DASHSCOPE_API_KEY 并检查启动日志；"
        "示例行程仍可通过 GET /api/trips/example 浏览。"
    )
    prompt = FALLBACK_PROMPT

    _print_safe("🚀 正在启动智能出行助手...")

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


# ==================== FastAPI 应用 ====================

app = FastAPI(
    title="智能出行助手 API",
    description="基于 LangGraph + MCP 的智能出行助手服务，并提供结构化旅行规划接口",
    version="1.1.0",
    lifespan=lifespan,
)

# 添加 CORS 中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.post("/chat", response_model=ChatResponse)
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
        result = await agent.ainvoke(
            {"messages": [HumanMessage(content=request.message)]},
            {"configurable": {"thread_id": request.thread_id}},
        )

        ai_message = result["messages"][-1]
        content = extract_agent_text(ai_message) or str(ai_message)

        return ChatResponse(content=content, thread_id=request.thread_id)

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

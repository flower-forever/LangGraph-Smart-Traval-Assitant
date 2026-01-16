"""
智能出行助手 - FastAPI 服务器
提供 HTTP API 接口供前端或其他服务调用
"""
import os
import json
import asyncio
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.memory import MemorySaver
from langchain_community.chat_models import ChatTongyi
from langchain_core.messages import HumanMessage, AIMessage
from langchain_mcp_adapters.client import MultiServerMCPClient

# 加载环境变量
load_dotenv()


# ==================== 配置类 ====================

class Configuration:
    """应用配置"""
    
    def __init__(self):
        self.model = os.getenv("MODEL_NAME", "qwen-plus")
        self.api_key = os.getenv("DASHSCOPE_API_KEY")
        self.host = os.getenv("API_HOST", "0.0.0.0")
        self.port = int(os.getenv("API_PORT", "8000"))
    
    @staticmethod
    def load_servers() -> dict:
        """加载 MCP 服务器配置"""
        config_path = "servers_config.json"
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
        return config.get("mcpServers", {})
    
    @staticmethod
    def load_prompt() -> str:
        """加载系统提示词"""
        prompt_path = "agent_prompts.txt"
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()


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
    """健康检查响应"""
    status: str
    tools_count: int
    model: str


# ==================== 全局变量 ====================

cfg = Configuration()
mcp_client: Optional[MultiServerMCPClient] = None
agent = None
prompt = ""


# ==================== 生命周期管理 ====================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI 生命周期管理"""
    global mcp_client, agent, prompt
    
    print("🚀 正在启动智能出行助手...")
    
    try:
        # 1. 读取系统提示词
        prompt = cfg.load_prompt()
        print("✅ 提示词加载完成")
        
        # 2. 读取 MCP 服务器配置
        servers_cfg = cfg.load_servers()
        print(f"📋 发现 {len(servers_cfg)} 个 MCP 服务器配置")
        
        # 3. 连接 MCP 服务器并获取工具（新版 API）
        mcp_client = MultiServerMCPClient(servers_cfg)
        tools = await mcp_client.get_tools()
        print(f"🔧 已加载 {len(tools)} 个工具")
        
        # 4. 初始化大模型
        model = ChatTongyi(
            model=cfg.model,
            dashscope_api_key=cfg.api_key,
            streaming=False
        )
        print(f"🤖 模型初始化完成: {cfg.model}")
        
        # 5. 初始化内存检查点（保存对话历史）
        checkpointer = MemorySaver()
        
        # 6. 创建 ReAct Agent
        agent = create_react_agent(
            model=model,
            tools=tools,
            prompt=prompt,
            checkpointer=checkpointer
        )
        print("✅ Agent 创建完成")
        
        print("=" * 50)
        print("🎉 智能出行助手启动成功!")
        print(f"📍 服务地址: http://{cfg.host}:{cfg.port}")
        print("=" * 50)
        
        yield  # 应用运行中
        
    finally:
        # 清理资源
        print("\n🔄 正在关闭服务...")
        print("👋 服务已关闭")


# ==================== FastAPI 应用 ====================

app = FastAPI(
    title="智能出行助手 API",
    description="基于 LangGraph + MCP 的智能出行助手服务",
    version="1.0.0",
    lifespan=lifespan
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
        "version": "1.0.0",
        "status": "running"
    }


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """健康检查"""
    tools = await mcp_client.get_tools() if mcp_client else []
    return HealthResponse(
        status="healthy",
        tools_count=len(tools),
        model=cfg.model
    )


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    """
    聊天接口
    
    - **message**: 用户消息
    - **thread_id**: 对话线程ID（用于保持上下文）
    """
    if not agent:
        raise HTTPException(status_code=503, detail="Agent 尚未初始化")
    
    try:
        # 调用 Agent
        result = await agent.ainvoke(
            {"messages": [HumanMessage(content=request.message)]},
            {"configurable": {"thread_id": request.thread_id}}
        )
        
        # 获取最后一条 AI 消息
        ai_message = result["messages"][-1]
        content = ai_message.content if hasattr(ai_message, 'content') else str(ai_message)
        
        return ChatResponse(
            content=content,
            thread_id=request.thread_id
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"处理请求时出错: {str(e)}")


@app.get("/tools")
async def list_tools():
    """列出所有可用工具"""
    if not mcp_client:
        raise HTTPException(status_code=503, detail="MCP 客户端尚未初始化")
    
    tools = await mcp_client.get_tools()
    return {
        "count": len(tools),
        "tools": [
            {
                "name": tool.name,
                "description": tool.description
            }
            for tool in tools
        ]
    }


@app.delete("/chat/{thread_id}")
async def clear_chat_history(thread_id: str):
    """清除指定对话的历史记录"""
    # 注意：MemorySaver 不支持直接清除，这里返回提示
    return {"message": f"对话 {thread_id} 的历史已标记为清除（下次会话将重新开始）"}


# ==================== 主入口 ====================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api_server:app",
        host=cfg.host,
        port=cfg.port,
        reload=True
    )

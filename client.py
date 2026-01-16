"""
智能出行助手 - CLI 交互式客户端
提供命令行界面与 Agent 进行多轮对话
"""
import asyncio
import json
import os
import sys
import warnings
from typing import Optional
from datetime import datetime

# 过滤弃用警告
warnings.filterwarnings("ignore", category=DeprecationWarning)

from dotenv import load_dotenv

from langgraph.prebuilt import create_react_agent
from langgraph.checkpoint.memory import MemorySaver
from langchain_community.chat_models import ChatTongyi
from langchain_mcp_adapters.client import MultiServerMCPClient

# 加载环境变量
load_dotenv()

# 尝试导入 rich 库（用于美化输出）
try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.markdown import Markdown
    console = Console()
    USE_RICH = True
except ImportError:
    USE_RICH = False


class Configuration:
    """应用配置"""
    
    def __init__(self, config_file: str = None):
        self.model = os.getenv("MODEL_NAME", "qwen-plus")
        self.api_key = os.getenv("DASHSCOPE_API_KEY")
        # 支持通过命令行参数指定配置文件
        self.config_file = config_file or os.getenv("MCP_CONFIG", "servers_config.json")
    
    def load_servers(self) -> dict:
        """加载 MCP 服务器配置"""
        with open(self.config_file, "r", encoding="utf-8") as f:
            config = json.load(f)
        return config.get("mcpServers", {})
    
    @staticmethod
    def load_prompt() -> str:
        """加载系统提示词"""
        prompt_path = "agent_prompts.txt"
        with open(prompt_path, "r", encoding="utf-8") as f:
            return f.read()


def print_banner():
    """打印启动横幅"""
    banner = """
╔══════════════════════════════════════════════════════════════╗
║                  🚗 智能出行助手 v1.0                        ║
║                                                              ║
║  功能: 天气查询 | 路线规划 | 行程保存 | 费用计算             ║
║  命令: quit (退出) | clear (清屏) | help (帮助)              ║
╚══════════════════════════════════════════════════════════════╝
"""
    if USE_RICH:
        console.print(Panel(banner.strip(), style="cyan"))
    else:
        print(banner)


def print_help():
    """打印帮助信息"""
    help_text = """
📚 使用帮助:

🔹 基本对话
   直接输入问题即可与助手对话

🔹 天气查询
   "北京今天天气怎么样？"
   "上海明天会下雨吗？"

🔹 路线规划
   "从北京到上海怎么走最快？"
   "帮我规划一个三天的杭州旅行"

🔹 保存行程
   "把刚才的旅行计划保存下来"

🔹 费用计算
   "100公里需要多少油费？油耗8L/100km，油价7.5元"

🔹 命令
   quit  - 退出程序
   clear - 清屏
   help  - 显示帮助
"""
    if USE_RICH:
        console.print(Markdown(help_text))
    else:
        print(help_text)


def print_message(role: str, content: str):
    """打印消息"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    
    if USE_RICH:
        if role == "user":
            console.print(f"\n[bold green]👤 你 [{timestamp}][/bold green]")
            console.print(content)
        else:
            console.print(f"\n[bold blue]🤖 助手 [{timestamp}][/bold blue]")
            console.print(Markdown(content))
    else:
        if role == "user":
            print(f"\n👤 你 [{timestamp}]: {content}")
        else:
            print(f"\n🤖 助手 [{timestamp}]:\n{content}")


async def run_chat_loop() -> None:
    """启动 MCP-Agent 聊天循环"""
    
    cfg = Configuration()
    
    # 检查 API Key
    if not cfg.api_key:
        print("❌ 错误: 未设置 DASHSCOPE_API_KEY 环境变量")
        print("   请在 .env 文件中配置或设置环境变量")
        return
    
    print("🔄 正在初始化...")
    
    # 1. 加载配置
    servers_cfg = cfg.load_servers()
    prompt = cfg.load_prompt()
    
    print(f"📋 发现 {len(servers_cfg)} 个 MCP 服务器")
    
    # 2. 连接多台 MCP 服务器（新版 API 不使用 async with）
    mcp_client = MultiServerMCPClient(servers_cfg)
    
    try:
        tools = await mcp_client.get_tools()
        print(f"🔧 已加载 {len(tools)} 个工具:")
        
        # 按类别分组显示工具（紧凑格式）
        tool_names = [t.name for t in tools]
        # 简单分行显示，每行4个工具
        for i in range(0, len(tool_names), 4):
            row = tool_names[i:i+4]
            print(f"   {' | '.join(row)}")
        
        # 3. 初始化大模型
        model = ChatTongyi(
            model=cfg.model,
            dashscope_api_key=cfg.api_key
        )
        print(f"🤖 模型: {cfg.model}")
        
        # 4. 构造 Agent（带记忆）
        checkpointer = MemorySaver()
        agent = create_react_agent(
            model=model,
            tools=tools,
            prompt=prompt,
            checkpointer=checkpointer
        )
        
        print_banner()
        
        # 5. CLI 聊天循环
        thread_id = f"chat_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        
        while True:
            try:
                # 获取用户输入
                if USE_RICH:
                    user_input = console.input("\n[bold yellow]>>> [/bold yellow]").strip()
                else:
                    user_input = input("\n>>> ").strip()
                
                # 处理空输入
                if not user_input:
                    continue
                
                # 处理命令
                if user_input.lower() == "quit":
                    print("\n👋 再见！祝您旅途愉快！")
                    break
                elif user_input.lower() == "clear":
                    os.system('cls' if os.name == 'nt' else 'clear')
                    print_banner()
                    continue
                elif user_input.lower() == "help":
                    print_help()
                    continue
                
                # 显示用户消息
                print_message("user", user_input)
                
                # 显示思考中
                print("\n⏳ 思考中...", end="", flush=True)
                
                # 调用 Agent
                result = await agent.ainvoke(
                    {"messages": [{"role": "user", "content": user_input}]},
                    config={"configurable": {"thread_id": thread_id}}
                )
                
                # 清除"思考中"
                print("\r" + " " * 20 + "\r", end="")
                
                # 显示回复
                ai_response = result['messages'][-1].content
                print_message("assistant", ai_response)
                
            except KeyboardInterrupt:
                print("\n\n👋 已中断，再见！")
                break
            except Exception as e:
                print(f"\n❌ 错误: {e}")
                continue
    finally:
        # 清理 MCP 客户端资源
        pass


def main():
    """主入口"""
    try:
        asyncio.run(run_chat_loop())
    except KeyboardInterrupt:
        print("\n👋 再见！")


if __name__ == "__main__":
    main()
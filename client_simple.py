"""
单次调用示例
演示如何简单地与智能出行助手进行单次交互
"""
import asyncio
import os
from dotenv import load_dotenv

from langgraph.prebuilt import create_react_agent
from langchain_community.chat_models import ChatTongyi
from langchain_mcp_adapters.client import MultiServerMCPClient

import mcp_runtime

# 加载环境变量：先看当前工作目录，再补项目目录，从任意目录启动都能读到 .env
load_dotenv()
load_dotenv(mcp_runtime.PROJECT_DIR / ".env")


def require_api_key() -> str:
    """没有有效 DASHSCOPE_API_KEY 时直接报错，不假装可聊天。"""
    key = (os.getenv("DASHSCOPE_API_KEY") or "").strip()
    if not key:
        raise RuntimeError(
            "未检测到有效的 DASHSCOPE_API_KEY 环境变量。"
            "请在项目目录的 .env 文件中配置 DASHSCOPE_API_KEY，"
            f"或在启动前设置该环境变量（项目目录: {mcp_runtime.PROJECT_DIR}）。"
            "未连接模型，本次查询取消。"
        )
    return key


async def single_query(question: str) -> str:
    """
    执行单次查询
    :param question: 用户问题
    :return: AI 回复
    """
    # 0. 前置校验：没有有效 key 时明确报错，而不是让模型调用在深处失败
    require_api_key()

    # 1. 加载配置（路径与启动目录无关，MCP_CONFIG 可覆盖）
    servers_cfg = mcp_runtime.load_server_config()
    
    # 2. 连接 MCP 服务器（新版 API）
    mcp_client = MultiServerMCPClient(servers_cfg)
    tools = await mcp_client.get_tools()
    
    # 3. 初始化模型
    model = ChatTongyi(
        model=os.getenv("MODEL_NAME", "qwen-plus"),
        dashscope_api_key=os.getenv("DASHSCOPE_API_KEY")
    )
    
    # 4. 加载提示词（锚定项目目录）
    system_prompt = mcp_runtime.load_prompt()
    
    # 5. 创建 Agent
    agent = create_react_agent(
        model=model,
        tools=tools,
        prompt=system_prompt
    )
    
    # 6. 执行查询
    result = await agent.ainvoke({
        "messages": [{"role": "user", "content": question}]
    })
    
    return result["messages"][-1].content


async def main():
    """主函数"""
    mcp_runtime.safe_print("=" * 50)
    mcp_runtime.safe_print("🚗 智能出行助手 - 单次查询示例")
    mcp_runtime.safe_print("=" * 50)
    
    # 示例查询
    examples = [
        "北京今天天气怎么样？",
        "帮我规划一个从北京到上海的旅行路线",
        "计算一下 100 公里的油费，假设油耗 8L/100km，油价 7.5 元/L"
    ]
    
    mcp_runtime.safe_print("\n📝 可用的示例查询:")
    for i, q in enumerate(examples, 1):
        mcp_runtime.safe_print(f"  {i}. {q}")
    
    # 获取用户输入
    user_input = input("\n请输入您的问题 (或输入数字选择示例): ").strip()
    
    # 处理输入
    if user_input.isdigit() and 1 <= int(user_input) <= len(examples):
        question = examples[int(user_input) - 1]
    else:
        question = user_input
    
    mcp_runtime.safe_print(f"\n🔍 查询: {question}")
    mcp_runtime.safe_print("-" * 50)
    
    # 执行查询
    try:
        answer = await single_query(question)
        print(f"\n🤖 回复:\n{answer}")
    except RuntimeError as e:
        # 配置类错误（如缺少 API Key）：直接给出明确提示
        mcp_runtime.safe_print(f"\n❌ {e}")
    except Exception as e:
        mcp_runtime.safe_print(f"\n❌ 错误: {e}")


if __name__ == "__main__":
    asyncio.run(main())

"""
单次调用示例
演示如何简单地与智能出行助手进行单次交互
"""
import asyncio
import json
import os
from dotenv import load_dotenv

from langgraph.prebuilt import create_react_agent
from langchain_community.chat_models import ChatTongyi
from langchain_mcp_adapters.client import MultiServerMCPClient

# 加载环境变量
load_dotenv()


async def single_query(question: str) -> str:
    """
    执行单次查询
    :param question: 用户问题
    :return: AI 回复
    """
    # 1. 加载配置
    with open("servers_config.json", "r", encoding="utf-8") as f:
        config = json.load(f)
    
    servers_cfg = config.get("mcpServers", {})
    
    # 2. 连接 MCP 服务器（新版 API）
    mcp_client = MultiServerMCPClient(servers_cfg)
    tools = await mcp_client.get_tools()
    
    # 3. 初始化模型
    model = ChatTongyi(
        model=os.getenv("MODEL_NAME", "qwen-plus"),
        dashscope_api_key=os.getenv("DASHSCOPE_API_KEY")
    )
    
    # 4. 加载提示词
    with open("agent_prompts.txt", "r", encoding="utf-8") as f:
        system_prompt = f.read()
    
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
    print("=" * 50)
    print("🚗 智能出行助手 - 单次查询示例")
    print("=" * 50)
    
    # 示例查询
    examples = [
        "北京今天天气怎么样？",
        "帮我规划一个从北京到上海的旅行路线",
        "计算一下 100 公里的油费，假设油耗 8L/100km，油价 7.5 元/L"
    ]
    
    print("\n📝 可用的示例查询:")
    for i, q in enumerate(examples, 1):
        print(f"  {i}. {q}")
    
    # 获取用户输入
    user_input = input("\n请输入您的问题 (或输入数字选择示例): ").strip()
    
    # 处理输入
    if user_input.isdigit() and 1 <= int(user_input) <= len(examples):
        question = examples[int(user_input) - 1]
    else:
        question = user_input
    
    print(f"\n🔍 查询: {question}")
    print("-" * 50)
    
    # 执行查询
    try:
        answer = await single_query(question)
        print(f"\n🤖 回复:\n{answer}")
    except Exception as e:
        print(f"\n❌ 错误: {e}")


if __name__ == "__main__":
    asyncio.run(main())

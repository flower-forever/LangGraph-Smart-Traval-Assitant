"""
文件写入 MCP 服务器
提供文件读写功能，用于保存旅行计划、行程记录等
"""
from mcp.server.fastmcp import FastMCP
import os
from datetime import datetime

# 初始化 MCP 服务器
mcp = FastMCP("WriteServer")

# 默认输出目录
OUTPUT_DIR = "./outputs"


@mcp.tool()
async def write_file(filename: str, content: str) -> str:
    """
    将内容写入文件。
    :param filename: 文件名（会自动添加到 outputs 目录）
    :param content: 要写入的内容
    :return: 写入结果
    """
    try:
        # 确保输出目录存在
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        
        # 构建完整路径
        filepath = os.path.join(OUTPUT_DIR, filename)
        
        # 写入文件
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        
        return f"✅ 文件已成功保存到: {filepath}"
    except Exception as e:
        return f"❌ 写入失败: {e}"


@mcp.tool()
async def read_file(filename: str) -> str:
    """
    读取文件内容。
    :param filename: 文件名（从 outputs 目录读取）
    :return: 文件内容
    """
    try:
        filepath = os.path.join(OUTPUT_DIR, filename)
        
        if not os.path.exists(filepath):
            return f"❌ 文件不存在: {filepath}"
        
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        
        return content
    except Exception as e:
        return f"❌ 读取失败: {e}"


@mcp.tool()
async def list_files() -> str:
    """
    列出 outputs 目录下的所有文件。
    :return: 文件列表
    """
    try:
        if not os.path.exists(OUTPUT_DIR):
            return "📁 输出目录为空"
        
        files = os.listdir(OUTPUT_DIR)
        if not files:
            return "📁 输出目录为空"
        
        file_list = "\n".join([f"  📄 {f}" for f in files])
        return f"📁 已保存的文件:\n{file_list}"
    except Exception as e:
        return f"❌ 列出文件失败: {e}"


@mcp.tool()
async def save_travel_plan(destination: str, plan: str) -> str:
    """
    保存旅行计划到文件。
    :param destination: 目的地名称
    :param plan: 旅行计划内容
    :return: 保存结果
    """
    try:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        
        # 生成文件名（包含时间戳）
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"travel_plan_{destination}_{timestamp}.md"
        filepath = os.path.join(OUTPUT_DIR, filename)
        
        # 格式化内容
        formatted_content = f"""# 🗺️ {destination} 旅行计划

📅 创建时间: {datetime.now().strftime("%Y年%m月%d日 %H:%M")}

---

{plan}

---
*由智能出行助手自动生成*
"""
        
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(formatted_content)
        
        return f"✅ 旅行计划已保存到: {filepath}"
    except Exception as e:
        return f"❌ 保存失败: {e}"


if __name__ == "__main__":
    mcp.run(transport='stdio')

# 🚗 智能出行助手

基于 **LangGraph + MCP** 架构的智能出行助手，集成天气查询、高德地图导航、费用计算等 **20 个工具**。

## ✨ 功能特性

| 功能 | 描述 | MCP 服务器 | 工具数 |
|------|------|-----------|--------|
| 🌤️ 天气查询 | 实时天气、天气预报、穿衣建议、出行贴士 | weather_server | 4 |
| 🗺️ 高德地图 | POI搜索、路线规划、地理编码、周边搜索 | amap_server | 7 |
| 🧮 费用计算 | 油费估算、预算规划、货币换算、数学计算 | calculator_server | 5 |
| 📝 文件管理 | 保存/读取旅行计划、文件操作 | write_server | 4 |

## 📁 项目结构

```
project/
├── client.py                  # CLI 交互式客户端
├── client_simple.py           # 单次调用示例
├── api_server.py              # FastAPI HTTP 服务器
├── weather_server.py          # 天气查询 MCP 服务器 (STDIO)
├── amap_server.py             # 高德地图 MCP 服务器 (STDIO)
├── calculator_server.py       # 计算器 MCP 服务器 (STDIO)
├── write_server.py            # 文件写入 MCP 服务器 (STDIO)
├── servers_config.json        # MCP 服务器配置
├── agent_prompts.txt          # Agent 系统提示词
├── requirements.txt           # Python 依赖
├── .env                       # 环境变量配置
├── 测试示例.md                 # 工具测试示例
└── README.md                  # 项目说明
```

## 🚀 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置环境变量

```bash
# 复制示例配置
cp .env.example .env

# 编辑 .env 文件，填入你的 API Key
```

**必需的 API Key:**
- `DASHSCOPE_API_KEY` - 通义千问 API Key ([获取地址](https://dashscope.console.aliyun.com/))
- `OPENWEATHER_API_KEY` - OpenWeather API Key ([获取地址](https://openweathermap.org/api))
- `AMAP_API_KEY` - 高德地图 API Key ([获取地址](https://console.amap.com/dev/key/app))

### 3. 运行方式

#### 方式一：CLI 交互模式（推荐）

```bash
# 激活虚拟环境
.\venv\Scripts\Activate.ps1  # Windows
source venv/bin/activate       # Linux/Mac

# 启动客户端
python client.py
```

#### 方式二：HTTP API 服务

```bash
# 启动服务
python api_server.py

# 或使用 uvicorn
uvicorn api_server:app --reload --host 0.0.0.0 --port 8000
```

API 文档: http://localhost:8000/docs

#### 方式三：单次查询示例

```bash
python client_simple.py
```

## 🔧 API 接口

### POST /chat
聊天接口

```json
{
  "message": "北京今天天气怎么样？",
  "thread_id": "user_123"
}
```

### GET /tools
获取所有可用工具

### GET /health
健康检查

## 💬 使用示例

```
>>> 北京今天天气怎么样？
🤖 北京当前天气晴朗，温度 15°C，建议穿薄外套...

>>> 帮我规划从北京到上海的自驾路线
🤖 为您规划路线：
   - 全程约 1200 公里
   - 预计耗时 12 小时
   - 油费约 ¥720...

>>> 把这个计划保存下来
🤖 旅行计划已保存到: outputs/travel_plan_上海_20260115.md
```

## 🏗️ 架构说明

```
┌─────────────┐     ┌─────────────────────────────────────┐
│   Client    │────▶│          LangGraph Agent           │
│ (CLI/HTTP)  │     │  ┌─────────────────────────────┐   │
└─────────────┘     │  │      ReAct Controller       │   │
                    │  │  (思考 → 行动 → 观察循环)   │   │
                    │  └──────────────┬──────────────┘   │
                    │                 │                   │
                    │  ┌──────────────▼──────────────┐   │
                    │  │     MCP Client Adapter      │   │
                    │  │  (langchain-mcp-adapters)   │   │
                    │  └──────────────┬──────────────┘   │
                    └─────────────────┼─────────────────┘
                                      │ STDIO
      ┌───────────────┬───────────────┼───────────────┬───────────────┐
      │               │               │               │               │
      ▼               ▼               ▼               ▼               ▼
┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐
│  Weather  │   │   Amap    │   │Calculator │   │   Write   │   │    ...    │
│  Server   │   │  Server   │   │  Server   │   │  Server   │   │  (扩展)   │
└─────┬─────┘   └─────┬─────┘   └─────┬─────┘   └─────┬─────┘   └───────────┘
      │               │               │               │
      ▼               ▼               ▼               ▼
 OpenWeather      高德地图 API     Math Functions   Local Files
    API
```

## 📝 MCP 服务器配置

`servers_config.json`:

```json
{
  "mcpServers": {
    "weather": {
      "command": ".\\venv\\Scripts\\python.exe",
      "args": ["weather_server.py"],
      "transport": "stdio"
    },
    "amap": {
      "command": ".\\venv\\Scripts\\python.exe",
      "args": ["amap_server.py"],
      "transport": "stdio"
    },
    "calculator": {
      "command": ".\\venv\\Scripts\\python.exe",
      "args": ["calculator_server.py"],
      "transport": "stdio"
    },
    "write": {
      "command": ".\\venv\\Scripts\\python.exe",
      "args": ["write_server.py"],
      "transport": "stdio"
    }
  }
}
```

## 🔑 环境变量

| 变量名 | 必需 | 说明 |
|--------|------|------|
| DASHSCOPE_API_KEY | ✅ | 通义千问 API Key |
| OPENWEATHER_API_KEY | ✅ | OpenWeather API Key |
| AMAP_API_KEY | ✅ | 高德地图 Web服务 API Key |
| MODEL_NAME | ❌ | 模型名称，默认 qwen-plus |

## 🛠️ 开发指南

### 添加新的 MCP 服务器

1. 创建服务器文件 `xxx_server.py`
2. 使用 `@mcp.tool()` 装饰器注册工具
3. 在 `servers_config.json` 中添加配置
4. 更新 `agent_prompts.txt` 中的工具说明

### MCP 工具模板

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("MyServer")

@mcp.tool()
async def my_tool(param: str) -> str:
    """工具描述"""
    return f"结果: {param}"

if __name__ == "__main__":
    mcp.run(transport='stdio')
```

## 📜 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

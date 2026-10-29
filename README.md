# 🚗 智能出行助手

基于 **LangGraph + MCP** 架构的智能出行助手，集成天气查询、高德地图导航、费用计算、文件管理共 **20 个 MCP 工具**，提供结构化分日行程规划接口（`travel_itinerary.py` + `/api/trips/plan`）和网页前端（React + Vite + Leaflet 地图）。

## ✨ 功能特性

| 功能 | 描述 | 代码位置 | 工具数 |
|------|------|----------|--------|
| 🌤️ 天气查询 | 实时天气、天气预报、穿衣建议、出行贴士 | weather_server.py | 4 |
| 🗺️ 高德地图 | POI 搜索、路线规划、地理编码、周边搜索 | amap_server.py | 7 |
| 🧮 费用计算 | 油费估算、预算规划、货币换算、数学计算 | calculator_server.py | 5 |
| 📝 文件管理 | 保存/读取旅行计划、文件操作；写入固定落在项目根 `outputs/` 目录（与启动目录无关） | write_server.py | 4 |
| 🗓️ 分日行程规划 | 模型生成行程 JSON，服务端校验归一化，按需补高德坐标与路线 | travel_itinerary.py + /api/trips/plan | — |
| 🖥️ 网页界面 | 示例行程与 AI 规划表单、逐日地图、站点弹窗与逐点讲解、本地保存与 .ics 导出 | frontend/ | — |

界面上的本地保存、日历导出和「停止等待」都只在浏览器这一侧工作，边界如下：

- 🗂️ **本地保存**：点「保存当前行程」才写入当前浏览器、当前网址的 localStorage，不上传、不跨设备同步；换浏览器、换网址或清除站点数据后就看不到了。最多 20 份，达到上限要先删一份，不会自动顶掉旧记录。
- 💾 **备份与导入（.json）**：点「下载行程备份」才生成明文 JSON；导入只先预览，点「保存到本地」才写入。导入与本地保存共用同一套结构约束（重复 day / 站点 ID、字段长度、每段 5000 点、全行程 40 000 点等）和同一个 640 KB 单份容量口径（算的是本地记录 `id + savedAt + trip`，不只是 trip）。导入预览校验的是这套结构与单份 640 KB 上限；真正保存还受 20 份总数、全部记录合计约 1.5 MiB 以及浏览器可用配额等限制，所以预览通过不代表当下一定有空间，保存结果以点击保存后的反馈为准。同 ID 覆盖要页面内二次确认，确认时比对保存时间与完整内容快照，期间变过就拒绝；localStorage 没有跨标签页的原子比较交换，只能缩小覆盖窗口、不保证绝对原子。文件里可能含你自己填写的描述，工具不做脱敏。
- 📅 **日历导出**：点「下载 .ics 文件」才生成并下载到你自己的电脑，导入 iOS 日历 / Google Calendar / Outlook 需要手动操作。示例行程的事件标题带【示例】前缀；时刻不带时区，按导入设备的本地时区解释；整份行程都缺日期时要先选首日才临时推算，只有部分天缺日期时这些天的站点会被跳过；缺停留时长的站点只写开始时间，没有补结束时间。
- ⏹️ **停止等待**：只让本页不再等这次规划，迟到的响应会被忽略，可以马上改参数重新提交。后端和上游模型可能已经在跑、甚至跑完，所以不保证服务端停止处理，也不保证停止计费。

## 📦 环境要求

- **Python 3.10+**：行程模块使用 PEP 604 类型语法和 pydantic v2 校验器，3.10 以下无法运行。下文命令按 3.12 给出。
- **Node.js 20.19+ 或 22.12+**：前端用 Vite 7，这是 Vite 7 的最低要求（实测版本 Node 22.21）。
- **pnpm**：前端使用 pnpm-lock.yaml 锁定依赖，推荐 `npm i -g pnpm` 安装。
- **uv**（Windows 本机装环境用，见快速开始）：按 [官方文档](https://docs.astral.sh/uv/getting-started/installation/) 安装即可。
- **可访问外网**：DashScope（模型）、高德 Web 服务（地理编码/路线）、OpenWeather（天气）、OpenStreetMap 瓦片（前端底图）都是外部服务，断网或上游配额不足时对应功能会降级或报错。

## 🚀 快速开始

### 1. 安装后端依赖

在项目根目录（本 README 所在目录）执行。

Windows 推荐用 uv 建环境。本机验证时 `python -m venv` 和 `pip install` 有复现故障，下面的 uv 流程已完整实测（建环境 → 装依赖 → 跑全量测试 → 启动服务）：

```powershell
uv venv .venv --python 3.12
uv pip install --python .venv/Scripts/python.exe -r requirements-dev.txt
```

之后所有后端命令都使用 `.venv\Scripts\python.exe`，或者先激活虚拟环境再直接用 `python`。

macOS / Linux 对应写法（解释器路径为 `.venv/bin/python`）：

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r requirements-dev.txt
```

其他环境用标准 pip 安装也可以（PowerShell 与 bash 命令二选一）：

```text
python -m venv .venv
.venv\Scripts\Activate.ps1      # Windows PowerShell 激活
source .venv/bin/activate       # macOS / Linux 激活
pip install -r requirements-dev.txt
```

`requirements-dev.txt` = 运行时依赖（`-r requirements.txt`）+ pytest，装这一个文件就够跑服务和测试；只需要运行时的话装 `requirements.txt`。

### 2. 配置环境变量

```bash
# Windows
copy .env.example .env
# macOS / Linux
cp .env.example .env
```

模板里的三个 API Key 默认全部留空。**留空可以直接启动并浏览示例行程，不要以为复制了模板就等于配好了 Key**——动态生成行程才需要模型 Key，真实坐标与导航路线才需要高德 Key。需要时在 `.env` 里填入自己的 Key（不要把真实密钥提交进仓库）：

| 变量名 | 何时需要 | 说明 |
|--------|----------|------|
| `DASHSCOPE_API_KEY` | 想真实生成行程、使用 /chat 和 CLI | 通义千问 API Key，[获取地址](https://dashscope.console.aliyun.com/)。**未配置时后端仍能启动**，示例接口照常可用，只是动态生成不可用 |
| `AMAP_API_KEY` | 想要真实坐标与导航路线 | 高德 **Web 服务** 类型 Key，[获取地址](https://lbs.amap.com/)。用于两处：行程规划接口的坐标/路线增强（travel_itinerary.py），以及 amap_server.py 的 7 个地图工具 |
| `OPENWEATHER_API_KEY` | 使用天气类 MCP 工具 | OpenWeather API Key，[获取地址](https://openweathermap.org/api)。该 Key 只供 weather_server.py 的天气 MCP 工具读取；规划与聊天 Agent 是否调用天气工具由模型和工具可用性决定，不保证每次都有实时天气 |
| `MODEL_NAME` | 可选 | 模型名，默认 `qwen-plus` |
| `API_HOST` / `API_PORT` | 可选 | FastAPI 监听地址/端口，默认 `127.0.0.1:8000`（与模板一致）。服务无认证，默认只监听本机回环；需要局域网访问再改，改成非回环地址时启动日志会给出警告 |
| `MCP_INIT_TIMEOUT` / `TRIP_PLAN_TIMEOUT` / `AMAP_TIMEOUT` | 可选 | 超时秒数，默认 20 / 180 / 6 |
| `MAP_ENRICH_TIMEOUT` | 可选 | 地图增强（坐标/路线补全）单独限时，默认 40 秒；配置缺失、非正数或非法时回退默认值。超时只放弃地图数据，保留已生成的文字行程，并在 `warnings` 里说明坐标与路线未获取（限时与回退行为有离线单测覆盖，未实测真实高德链路） |
| `CHAT_TIMEOUT` | 可选 | `/chat` 的模型调用单独限时，默认 120 秒；必须是正的有限数，缺失、非法（0、负数、限不住的 inf/nan）都回退默认值。超过时限返回 504 |
| `CORS_ORIGINS` | 可选 | 允许的浏览器来源白名单。未设置时默认 6 个本机 origin（127.0.0.1 与 localhost 的 5173、5181、5182）；设置后为逗号分隔的整体覆盖而不是追加；设成空值或任一项非法都触发 fail-closed。改完需重启后端，细节见下文「浏览器来源防护（CORS 与写请求 403）」 |

两个容易混淆的"地图 key"：

- `AMAP_API_KEY` 是**后端服务端 key**，调用高德 restapi.amap.com 做地理编码、POI 和步行/驾车路线。
- 前端地图底图是 **Leaflet + OpenStreetMap 瓦片**（`tile.openstreetmap.org`），浏览器直连，**不需要任何 key**，也不使用高德 JS API。

注意：Vite 的 `/api` 代理目标写死为 `http://127.0.0.1:8000`。如果改了 `API_PORT`，前端要用 `VITE_API_BASE` 指向新端口（见第 4 节）。

### 3. 启动后端（FastAPI）

从项目根目录运行：

```powershell
# Windows
.venv\Scripts\python.exe api_server.py
```

```bash
# macOS / Linux
.venv/bin/python api_server.py
```

等价于（host/port 来自 `API_HOST`/`API_PORT`）：

```bash
uvicorn api_server:app --reload --host 127.0.0.1 --port 8000
```

启动成功的标志：控制台打印服务地址，且健康检查有返回：

```bash
curl http://127.0.0.1:8000/health
```

`/health` 返回 `status`、`tools_count`、`model`、`agent_ready`、`planner_ready`、`mcp_ready`、`amap_configured` 和 `warnings`，据此可以判断当前是完整模式还是降级模式。

**没有配置任何 Key 时后端也能启动，且这是设计好的降级模式（已实测）**：`GET /api/trips/example` 正常返回；`/chat` 和 `/api/trips/plan` 返回明确的 503 提示，不会伪造结果；此时 MCP 工具与模型都不加载（`tools_count` 为 0）。MCP 初始化超时/失败、模型初始化失败也只降级，不会阻止 FastAPI 起来。

### 4. 启动前端（Vite）

```bash
cd frontend
pnpm install
pnpm dev
```

开发服务器默认端口 5173（被占用时会顺延，以终端打印的地址为准），并把 `/api` 请求代理到 `http://127.0.0.1:8000`，与后端默认 `API_HOST` 一致，所以先启动后端再开前端。前端请求默认走同源 `/api`；需要指向别的后端时设置 `VITE_API_BASE` 环境变量。注意 `VITE_API_BASE` 是 Vite 构建/启动时读取的环境变量：开发在 `pnpm dev` 前设置，生产在 `pnpm build` 前设置；运行构建产物后再改系统环境变量，不会重写已生成的 bundle。

**后端没起，只想调前端**：可以用契约桩代替后端。`pnpm stub` 启动 `node dev-stub/server.mjs`（监听 `127.0.0.1:8001`，可用 `STUB_PORT` 覆盖）。桩只提供探活与固定示例，不提供规划：`/health` 与 `/api/health` 返回探活 JSON；`GET /api/trips/example` 返回写死的杭州三日示例，标题、摘要、warnings 都标「固定示例」；`POST /api/trips/plan` 直接返回 503，不生成模拟 Agent 行程。示例路段只有「示意直线」和「路线不可用」两类，距离与耗时一律为 null：

```powershell
$env:VITE_API_BASE = "http://127.0.0.1:8001"; pnpm dev   # PowerShell
```

```bash
VITE_API_BASE=http://127.0.0.1:8001 pnpm dev             # bash
```

桩示例里的连线不是任何导航结果，也没有导航距离。更多前端细节见 `frontend/README.md`。

### 5. 浏览器入口

- **网页界面**：http://localhost:5173/
- **后端 API 文档（Swagger）**：http://localhost:8000/docs

首次体验（未配任何 Key）：打开 http://localhost:5173/ 即可浏览内置的**北京中轴线三日示例行程**。数据来自 `GET /api/trips/example`，`source` 恒为 `example`，界面按此显示「示例行程」标识，返回数据的 `warnings` 明确写着这是示例、连线是直线示意，不是为用户实时生成的行程。前端进入页面时会先请求 `/api/health` 探活。注意区分两种画法：内置示例自带坐标，站点间画虚线示意；动态生成且未配 `AMAP_API_KEY` 的行程站点坐标为 null、路段标记为 `unavailable`，地图不画任何连线（包括直线），显示空态提示。想真实生成时再按第 2 节配置 `DASHSCOPE_API_KEY`（必需）和 `AMAP_API_KEY`（可选，决定有没有真实坐标和导航路线）。

## 🧭 行程内容的边界（请务必了解）

- **行程文字由大模型生成**：开放时间、门票、交通情况请以官方信息为准。本接口不提供实时价格、营业状态或预订信息。
- **导航路线来自高德**：`route_type=navigation` 的路段是高德 Web 服务返回的步行/驾车路线，带距离和预计耗时。
- **直线只是示意**：`route_type=straight_line` 是两个站点间的直连虚线，不是真实道路，没有距离和耗时数据；只在路线请求失败、几何不足等上游降级且两端坐标可信时才这样画。前端对 `unavailable` 路段不画线，只保留文字说明。
- **无数据时诚实降级**：没有配置 `AMAP_API_KEY` 时所有站点坐标为 null、路段标记为 `unavailable`，前端不画线也不画直线，地图区显示空态提示，不编造路线；个别站点地理编码失败时该站保持 null，相关路段同样标记为不可用。
- **坐标统一 WGS84**：高德返回 GCJ-02，服务端输出前已转换为 WGS84（`map_coordinate_system="WGS84"`），Leaflet/OpenStreetMap 可直接使用。
- **外部依赖**：行程生成依赖 DashScope 网络，坐标/路线依赖高德服务，底图依赖 OpenStreetMap 瓦片。任一上游不可用都会在行程的 `warnings` 或界面提示中说明，不影响文字行程本身。

## 🔌 API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 服务名称、版本与运行状态 |
| `/health` | GET | 健康检查，附降级状态与启动警告 |
| `/api/health` | GET | 与 `/health` 完全一致的别名（Vite 只代理 `/api`，前端探测用它） |
| `/tools` | GET | 已加载的 MCP 工具列表；未加载时返回 503 |
| `/chat` | POST | 通用聊天（**兼容旧入口**），请求体 `{"message": "...", "thread_id": "user_123"}`；message 限制 1–4000 字符（不合法 422），模型调用超过 `CHAT_TIMEOUT`（默认 120 秒）返回 504 |
| `/chat/{thread_id}` | DELETE | 标记清除会话，返回 `{"thread_id": "...", "deleted": true}`；内存历史在进程重启后清空 |
| `/api/trips/example` | GET | 内置示例行程，不需要任何 API Key |
| `/api/trips/plan` | POST | 生成结构化分日行程 |

`POST /api/trips/plan` 请求体：

```json
{
  "destination": "杭州",
  "days": 2,
  "departure_date": null,
  "travelers": 2,
  "preferences": "喜欢湖景",
  "travel_mode": "walking"
}
```

字段约束：`destination` 1–80 字；`days` 1–7；`travelers` 1–20；`travel_mode` 只能是 `walking` 或 `driving`；`departure_date` 为 `YYYY-MM-DD` 或 null。

错误码语义：422 参数不合法；502 模型返回无法解析或上游失败（错误信息已抹去密钥）；503 未配置 `DASHSCOPE_API_KEY` 或 Agent 未就绪；504 行程生成超时（默认 180 秒）。`/chat/{thread_id}` 的 DELETE 在 `thread_id` 为空时返回 400。

curl 示例（macOS/Linux）：

```bash
curl http://127.0.0.1:8000/api/trips/example
curl -X POST http://127.0.0.1:8000/api/trips/plan \
  -H "Content-Type: application/json" \
  -d '{"destination":"杭州","days":2,"travel_mode":"walking"}'
```

### 浏览器来源防护（CORS 与写请求 403）

后端对来自浏览器的调用有两层限制：

- **CORS 白名单**：只对显式列出的 origin 返回可跨域的响应头，不用 `*`，也不做通配符或前缀匹配。
- **写请求前置守卫**：浏览器跨域发出的 POST/PUT/PATCH/DELETE 通常带 Origin 头，守卫只检查这类带 Origin 的写请求，Origin 不在白名单内就在进路由前拒绝，返回 403（`{"detail": "该浏览器来源不被允许，请求未执行。"}`），避免出现响应读不到、副作用却已发生的情况。GET 不拦。不带 Origin 的请求（`curl`、`client.py` 这类 CLI/服务端调用）为保持兼容直接放行，守卫管不到刻意不带 Origin 的客户端；本机回环同源（Origin 是 127.0.0.1、localhost 或 ::1 且与服务访问地址完全一致，例如直接在 `/docs` 页面里调用）也照常可用。

`CORS_ORIGINS` 的语义：

- 未设置时，默认白名单为 http://127.0.0.1:5173、http://localhost:5173、http://127.0.0.1:5181、http://localhost:5181、http://127.0.0.1:5182、http://localhost:5182 共 6 个。
- 设置后是整体覆盖而不是追加：逗号分隔的绝对 http(s) origin，接受 `scheme://host[:port]` 形式，端口可省略，末尾多写的一个 `/` 会归一成无 `/` 的写法，默认端口（http 的 80、https 的 443）同样归一成无端口；不允许通配符、真实路径、查询、片段或账号信息，重复项自动去重。已列出的 5173/5181/5182 也要写进新列表，否则会随覆盖一起失效。
- **Vite 端口顺延后要补配置**：5173 被占用时 Vite 会顺延到 5174 这类未配置的新端口，新端口不在默认白名单里，从它发出的写请求可能被 403 拒掉。把实际要用的所有前端 origin 一并写进 `CORS_ORIGINS`，例如 `CORS_ORIGINS=http://localhost:5174,http://127.0.0.1:5174`。
- **空值或任一项非法都 fail-closed**：设成空值，或列表里出现空项和非法项（缺协议、带路径、含通配符等），整份配置一个浏览器 origin 都不放行，只保留回环同源与无 Origin 调用，避免部分生效让人误判实际放行范围。原因会写进启动日志和 `/health` 的 `warnings`（只有序号和原因，不回显原始配置值），修正后重启后端生效。
- 修改后要重启后端：`--reload` 只监听 `.py` 文件，改 `.env` 不会触发重载。

边界：这套防护降低的是恶意网页从别的域调用接口、消耗模型额度的风险。无 Origin 的请求为兼容 CLI 直接放行，刻意不带 Origin 的客户端不在防线上，所以只能当作降险手段，不能当成完全防护。它也不是身份认证，不覆盖本机其它进程直接调用和 DNS rebinding 变体。默认 `API_HOST` 只监听 `127.0.0.1`，需要部署到非回环地址时，认证、TLS 和其余防护另行配置（见「注意事项」）。

## 🧪 运行测试

后端测试全部离线：高德客户端用 httpx.MockTransport，FastAPI 用 TestClient 加假 Agent/假高德，MCP 运行时测试用本地 stdio 子进程做真实握手——都不发真实网络请求，也不需要任何 API Key：

```powershell
# Windows
.venv\Scripts\python.exe -m pytest tests/ -q
```

```bash
# macOS / Linux
.venv/bin/python -m pytest tests/ -q
```

测试文件（按模块划分，新增测试随代码补进清单即可）：`test_coordinates.py`（坐标转换）、`test_amap_client.py`（高德客户端）、`test_itinerary.py`（行程归一化/降级/提示词）、`test_map_resilience.py`（地图数据可信度与降级回归）、`test_map_timeout.py`（地图增强独立超时、客户端关闭与配置回退）、`test_route_quality.py`（异常几何不得以 navigation 输出、时间冲突告警）、`test_schedule_safety.py`（无地图/超时下的时刻表冲突、占位时间与来源丢失后的措辞、提醒上限与防伪）、`test_api.py`（FastAPI 接口与降级行为）、`test_api_compatibility.py`（兼容旧字段）、`test_mcp_runtime.py`（MCP 配置解析、跨目录启动、真实 stdio 握手）、`test_calculator_security.py` 与 `test_write_security.py`（计算器沙箱与文件写入安全）。

前端测试（vitest，测试文件在 `frontend/src/__tests__/`，覆盖 App、ItineraryList、TripMap 集成与 api、format、mapData、tileStatus 单测）：

```bash
cd frontend
pnpm test          # vitest run
pnpm test:watch    # watch 模式
pnpm build         # tsc -b && vite build
pnpm preview       # 本地预览 dist 产物
```

## 🤖 CI（GitHub Actions）

`.github/workflows/ci.yml` 定义了两个并行 job，`push` 到 `feat/interactive-travel-planner` / `main` 或任意 Pull Request 都会触发；同一分支有新推送时自动取消还在跑的旧任务。所有外部 action 只授予 `contents: read` 权限，不注入任何密钥。

- **后端**：Windows runner + Python 3.12，装 `requirements-dev.txt` 后跑 `pytest tests -q`。设置了 `PYTHON_DOTENV_DISABLED=1` 和 `PYTHONDONTWRITEBYTECODE=1`，与本地离线测试的约定一致：测试全部走 MockTransport / 假 Agent，不读取实际 `.env`，也不需要任何 API Key。
- **前端**：Node 22 + pnpm（lockfile 是 `lockfileVersion: '9.0'`，pnpm 9+ 可读，CI 固定 pnpm 11，与本机开发环境一致），`pnpm install --frozen-lockfile` 后跑完整 `pnpm test` 和 `pnpm build`（含 `tsc -b` 类型检查）。

本地运行同样两条命令即可复现 CI 的核心检查（仓库根目录装好依赖后）：

```bash
# 后端（需先按「快速开始」装好 .venv）
PYTHON_DOTENV_DISABLED=1 PYTHONDONTWRITEBYTECODE=1 .venv/Scripts/python.exe -m pytest tests -q -p no:cacheprovider

# 前端
cd frontend && pnpm install --frozen-lockfile && pnpm test && pnpm build
```

CI 的验证边界：这条工作流定义时经过 YAML 结构核对和命令与现有 README/lockfile 的核对，但还没有真正推送到 GitHub 上跑过，不能当作「CI 已绿」。全量回归测试请在自己的环境或 CI 实际运行后以真实结果为准。

## 💬 CLI 入口

```powershell
# Windows
.venv\Scripts\python.exe client.py          # 多轮交互客户端
.venv\Scripts\python.exe client_simple.py   # 单次问答示例
```

```bash
# macOS / Linux
.venv/bin/python client.py
.venv/bin/python client_simple.py
```

- `client.py` 是多轮对话（命令：`quit` 退出、`clear` 清屏、`help` 帮助），`client_simple.py` 是单次问答示例，两者都需要 `DASHSCOPE_API_KEY`：检测不到 Key 会直接退出并给出配置提示，不进入对话。
- 可以问的问题：

```
>>> 北京今天天气怎么样？
>>> 帮我规划从北京到上海的自驾路线
>>> 100 公里需要多少油费？油耗 8L/100km，油价 7.5 元
>>> 把这个计划保存下来
```

实际回答取决于工具调用与上游服务返回，不是固定话术。
- MCP 配置与系统提示词锚定在项目根目录，从任何工作目录启动都能找到。`servers_config.json` 磁盘内容里写的 `.\\venv\\Scripts\\python.exe` 如果不存在，运行时自动回退到当前 Python 解释器，`*.py` 脚本参数也会解析成绝对路径（只改内存配置，不动磁盘文件）。想用自定义配置文件时，设置 `MCP_CONFIG` 环境变量指向它（CLI 专属；api_server.py 固定读取项目根的 servers_config.json）。

## 🏗️ 架构说明

```
┌─────────────┐  /api（Vite 代理→:8000） ┌────────────────────────────────────┐
│  Web 前端   │─────────────────────────▶│       FastAPI (api_server.py)      │
│ React+Vite  │                          │ /chat /tools /health /api/trips/*  │
│  + Leaflet  │                          └───────────────┬────────────────────┘
└──────┬──────┘                                          │
       │ 浏览器直连 OpenStreetMap 瓦片（底图，无需 key）  │ 两条链路
       ▼                                                 │
┌──────────────────────┐            ┌──────────────────────▼──────────────────────┐
│ tile.openstreetmap.org│           │              LangGraph Agent                │
│  (Leaflet 底图瓦片)   │           │  /chat: ReAct 全工具 Agent                   │
└──────────────────────┘            │  /api/trips/plan: 只输出 JSON 的规划 Agent   │
                                    └──────────────┬──────────────────────────────┘
                                                   │ langchain-mcp-adapters (STDIO)
                  ┌────────────────┬───────────────┼────────────────┐
                  ▼                ▼               ▼                ▼
            ┌───────────┐  ┌───────────┐  ┌────────────┐  ┌───────────┐
            │  Weather  │  │   Amap    │  │ Calculator │  │   Write   │
            │  Server   │  │  Server   │  │  Server    │  │  Server   │
            └─────┬─────┘  └─────┬─────┘  └────────────┘  └───────────┘
                  ▼              ▼
            OpenWeather     高德 Web 服务        另一条链路（不经过 MCP）：
              API           geocode/POI/路线     FastAPI → travel_itinerary.py
                                                 （JSON 校验归一化、GCJ-02→WGS84、
                                                   AMapClient 增强、失败时诚实降级）
```

要点：

- 行程规划接口由 `travel_itinerary.py` 负责领域逻辑：模型 JSON → `TripPlan` 契约校验 → 高德地理编码/POI/路线增强 → 输出统一 WGS84。任何上游失败都降级并在 `warnings` 里说明，不伪造数据。
- 归一化阶段无法解析的 `time` 会被换成 09:00 起的占位时间，并在 `warnings` 里说明。时间来源随 `TripPlan` 以私有属性在内部传递（不进 JSON schema、`model_dump` 或响应），地图增强重算冲突时据此判断：涉及占位时间的提醒写明「占位时间，实际时间待确认」，只做假设性推算，不下「赶不上」「两站时间重叠」的结论；模型真实给出的时间（包括合法的 09:00）仍按原来的确定性/跨日语义提醒。模型自带的站点 id 不参与归属，归一化按天重新生成 `stop-dNN-MM`，所以两天写同一个 id 也不会把占位状态串到另一天。行程经 JSON 往返重建后私有来源会丢失：公开提醒里还有默认时间说明时，整趟按「含占位但无法对应到具体站点」保守措辞；连说明也没有（旧数据或被提醒上限截断）时按「来源未知」处理，提醒里直接写明无法逐站识别、若含占位值则实际时间待确认，并保留按次日假设的核对。站点时间、停留时长与公开字段不变，API 契约不受影响。
- 规划 Agent 被限制为只输出 JSON，且过滤掉了文件读写类工具（`is_planner_safe_tool`），天气等其余 MCP 工具仍在它的工具列表里，是否调用由模型决定；用户输入作为数据包裹在提示词里，只能降低提示注入风险，不是绝对防护。
- 未配置 `DASHSCOPE_API_KEY` 时服务仍启动；`servers_config.json` 里写死的 venv Python 路径不存在时，api_server 会自动回退到当前解释器（CLI 侧由 mcp_runtime.py 做同样的解析，见「CLI 入口」）。

## 📁 项目结构

```
LangGraph-Smart-Traval-Assitant/
├── client.py                  # CLI 多轮交互客户端
├── client_simple.py           # 单次问答示例
├── mcp_runtime.py             # CLI 共用 MCP 运行时：配置/提示词定位、解释器回退、路径解析
├── api_server.py              # FastAPI HTTP 服务器
├── travel_itinerary.py        # 结构化行程领域逻辑（契约/解析/高德客户端/坐标转换/降级）
├── weather_server.py          # 天气 MCP 服务器 (STDIO)
├── amap_server.py             # 高德地图 MCP 服务器 (STDIO)
├── calculator_server.py       # 计算器 MCP 服务器 (STDIO)
├── write_server.py            # 文件写入 MCP 服务器 (STDIO)
├── servers_config.json        # MCP 服务器配置
├── agent_prompts.txt          # Agent 系统提示词
├── requirements.txt           # 运行时依赖
├── requirements-dev.txt       # 开发/测试依赖（runtime + pytest）
├── .env.example               # 环境变量模板（复制为 .env）
├── tests/                     # pytest：坐标 / 高德客户端 / 行程 / 地图降级与超时 / API / MCP 运行时 / 安全
├── frontend/                  # React + Vite 前端（pnpm 管理），详见 frontend/README.md
│   ├── dev-stub/server.mjs    # 契约桩：固定示例 + 探活，不提供规划
│   ├── src/components/        # PlanForm（规划表单）/ ItineraryList（逐日清单）/ TripMap（Leaflet 地图）
│   ├── src/lib/               # api（后端客户端）/ format / mapData
│   └── vite.config.ts         # 开发代理：/api → 127.0.0.1:8000
├── 测试示例.md                 # 20 个 MCP 工具的测试提问示例
└── README.md
```

## 📝 MCP 服务器配置

`servers_config.json`：

```json
{
  "mcpServers": {
    "weather":  { "command": ".\\venv\\Scripts\\python.exe", "args": ["weather_server.py"],  "transport": "stdio" },
    "amap":     { "command": ".\\venv\\Scripts\\python.exe", "args": ["amap_server.py"],     "transport": "stdio" },
    "calculator": { "command": ".\\venv\\Scripts\\python.exe", "args": ["calculator_server.py"], "transport": "stdio" },
    "write":    { "command": ".\\venv\\Scripts\\python.exe", "args": ["write_server.py"],    "transport": "stdio" }
  }
}
```

磁盘上这份 JSON 保留 `.\\venv\\Scripts\\python.exe` 的写法，两条链路都会在启动时解析它：CLI 走 `mcp_runtime.py`，api_server 走自己的 `_resolve_server_config`。规则一致——解释器路径存在就使用它（尊重用户自己的 venv）；不存在则回退到当前 Python 解释器，`*.py` 参数解析为项目根下的绝对路径。只改内存配置，不动磁盘文件；非 Python 程序（npx/node/uvx）不会被改写。

### 添加新的 MCP 服务器

1. 创建服务器文件 `xxx_server.py`，用 `@mcp.tool()` 注册工具
2. 在 `servers_config.json` 中添加配置
3. 更新 `agent_prompts.txt` 中的工具说明

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

## ⚠️ 注意事项

- 服务默认只监听 `127.0.0.1` 且接口无认证，仅适合本机预览；要对外监听需要自行加防护，`API_HOST` 改成非回环地址时启动日志会提醒。
- 会话历史保存在进程内存（LangGraph MemorySaver），进程重启即清空。
- `mcp` 与 `langgraph` 依赖都钉了 `<2` 上限：`mcp` 2.x 移除了 `mcp.server.fastmcp`，四个自带 server 会在 import 阶段失败；`langgraph` 2.x 移除了 `create_react_agent`，这是兼容护栏，后续需要迁移到 `langchain.agents.create_agent`。requirements.txt 已钉版本，按 requirements 安装即可。
- 本项目不提供实时预订、票价查询，也不承诺任何上游服务无条件成功；所有动态结果都受网络与上游凭证额度影响。

## 📜 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

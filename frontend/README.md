# frontend · 路书（智能出行助手前端）

React 19 + Vite 7 + TypeScript 前端，配 LangGraph 后端（`../api_server.py`）。交互地图用 Leaflet + OpenStreetMap 底图。

## 开发

```bash
cd frontend
pnpm install        # 或 npm install
pnpm dev            # http://localhost:5173，/api 代理到 http://127.0.0.1:8000
```

后端（仓库根目录）：

```bash
python api_server.py    # 需要先配置 .env（DASHSCOPE_API_KEY 等）
```

后端未就绪时可先用开发桩看界面。注意：**桩只提供固定示例和探活，不提供规划**。

```bash
# 终端 A（frontend/ 下）
pnpm stub              # 开发桩，监听 127.0.0.1:8001：GET /api/health、GET /api/trips/example
# 终端 B（frontend/ 下，Windows PowerShell）
$env:VITE_API_BASE="http://127.0.0.1:8001"; pnpm dev
# 或 bash: VITE_API_BASE=http://127.0.0.1:8001 pnpm dev
```

桩返回的是写死的杭州示例，标题、摘要和 warnings 都标了「固定示例」：所有路段只有「示意直线」或「路线不可用」，`distance_m` / `duration_minutes` 一律为 `null`，没有真实导航数据。`POST /api/trips/plan` 直接返回 503，`detail` 说明请启动配置密钥的后端，不会伪造 `source: "agent"` 的结果。需要真实规划时启动 `python api_server.py`。

## 构建与测试

```bash
pnpm build           # tsc -b + vite build
pnpm test            # vitest 单测（含 App 集成测试）
pnpm preview         # 预览 dist 产物
```

`pnpm test` 也会跑 `dev-stub/server.test.mjs`：只起本机 http 服务核对桩的标识与 503 行为，不连外网、不依赖高德或模型。

接口地址：默认走同源 `/api`（dev 由 Vite 代理，生产需反代同源 `/api`），也可用 `VITE_API_BASE` 覆盖（如 `VITE_API_BASE=http://127.0.0.1:8001`）。注意 `VITE_API_BASE` 是构建/启动时读取的环境变量，不是运行时变量：开发在 `pnpm dev` 前设置，生产在 `pnpm build` 前设置；bundle 生成后再改系统环境变量不会重写已构建的产物。

## 目录

```
frontend/
├── dev-stub/server.mjs        # 开发桩：固定示例 + 探活，不提供规划
├── public/favicon.svg
├── src/
│   ├── main.tsx               # 入口
│   ├── App.tsx                # 页面编排：示例加载、规划、日切换、站点联动
│   ├── app.css                # 样式（引用 ../tokens.css 设计令牌）
│   ├── tokens.css             # 设计令牌（OKLCH 颜色 + 字体 + 4pt 间距）
│   ├── components/
│   │   ├── PlanForm.tsx       # 规划表单（真实验证、loading、错误处理）
│   │   ├── ItineraryList.tsx  # 逐日行程清单（逐点讲解、复制为文本）
│   │   └── TripMap.tsx        # Leaflet 地图（站点、路线、图例、空态）
│   └── lib/
│       ├── api.ts             # 后端客户端（/api/trips/example、/api/trips/plan）
│       ├── format.ts          # 展示格式化与 OSM 链接
│       └── mapData.ts         # 日行程 → 地图数据（坐标清洗、路线分类）
└── src/__tests__/             # vitest 单测与集成测试
```

## 契约要点（与后端约定）

- `GET /api/trips/example`、`POST /api/trips/plan` 返回同一 `Trip` 结构；`source: 'example'|'agent'` 决定「示例行程 / AI 规划」标识。开发桩只返回 `source: 'example'`，路段只含 `straight_line` / `unavailable`。
- 坐标一律 WGS84 `lng/lat`；前端转成 Leaflet 的 `lat,lng`。
- `route_type`：`navigation` 画地图服务路线、`straight_line` 画虚线并在图例标注「示意直线（非导航）」、`unavailable` 不画线只给文字。
- 模型文案只按纯文本渲染，不做 HTML 注入。
- 后端不可达时：示例区给出明确错误与重试；规划区给出可操作的提示；地图缺瓦片/缺坐标各有空态。

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
python api_server.py    # 未配置密钥也能启动；真实规划需要 DASHSCOPE_API_KEY
```

不配任何 Key 时后端是可用的降级模式：`GET /api/health` 探活和 `GET /api/trips/example` 内置示例正常返回；`POST /api/trips/plan`、`/chat` 返回明确的 503，不会伪造结果。真实生成行程需要 `DASHSCOPE_API_KEY`；真实坐标和导航路线另需 `AMAP_API_KEY`，不配时站点坐标为 `null`、路段为 `unavailable`，前端不画线。Key 的配置方式见根 README 的 `.env` 说明。

后端未就绪时可先用开发桩看界面。注意：**桩只提供固定示例和探活，不提供规划**。

```bash
# 终端 A（frontend/ 下）
pnpm stub              # 开发桩，监听 127.0.0.1:8001：GET /api/health、GET /api/trips/example
# 终端 B（frontend/ 下，Windows PowerShell）
$env:VITE_API_BASE="http://127.0.0.1:8001"; pnpm dev
# 或 bash: VITE_API_BASE=http://127.0.0.1:8001 pnpm dev
```

桩返回的是写死的杭州示例，标题、摘要和 warnings 都标了「固定示例」：所有路段只有「示意直线」或「路线不可用」，`distance_m` / `duration_minutes` 一律为 `null`，没有真实导航数据。`POST /api/trips/plan` 直接返回 503，`detail` 说明请启动配置密钥的后端，不会伪造 `source: "agent"` 的结果。需要真实规划时启动 `python api_server.py`。

## 本地保存

- 只有点「保存当前行程」才写入，页面加载、恢复、导出都不会顺手保存。
- 数据写入当前浏览器、当前网址（同源）的 localStorage（键 `travel-assistant:saved-trips:v1`），不上传、不跨设备同步。最多 20 份，单份约 640 KB，总计约 1.5 MiB（1 536 KB）；同一 `trip.id` 再次保存只更新原记录。
- 结构校验对齐后端契约（`travel_itinerary.py` 的 `_MAX_ROUTE_GEOMETRY_POINTS`）：单段路线最多 5 000 个几何点，全行程 40 000 个点。7 天 × 8 站、每段 150 点这类长路线是正常数据，不会被当成损坏；校验只读不写，不抽稀几何、不改站点和路线。
- 达到份数或体积上限时明确失败，不会自动淘汰旧记录，需要先删一份。单份超限只能重新规划更短的行程，删其他记录也放不下；当前行程仍可查看和导出 `.ics`。
- 恢复只读取本地副本，后端不可用时也能查看；恢复后回到第一天并清空选中站点。删除后有页面内「撤销删除」，撤销条保留到撤销、手动关闭或下一次删除。
- 每次读取都会重新校验。数据损坏、版本不符或体积异常时整份读取停止；存储里有无法识别的记录时只展示能确认的部分。这两种情况下保存、删除、撤销都会暂停，避免覆盖原始数据；确认不再需要后可在面板里二次确认清除，清除不可撤销。
- 清除浏览器站点数据会一并删除这些记录；无痕模式或禁用站点数据时保存不可用。

## 行程备份与导入（.json）

- 只有点「下载行程备份 (.json)」才生成文件并交给浏览器下载；渲染页面、预览文件、打开行程都不会触发下载，也不写 localStorage。文件是明文 JSON，可能包含你自己写的行程摘要、站点描述和地址，工具不做脱敏，分享前自行检查。
- 选文件后先解析并预览，只有点「保存到本地」才写入当前浏览器。导入与本地保存共用同一套结构校验（`savedTrips.checkTripShape`）：天数 1–31、每天站点 / 路段各不超过 100、全行程站点 / 路段各不超过 5 000、重复 `day` 与同一天里重复的站点 ID 直接拒绝、字段长度有上限、单段路线最多 5 000 个几何点、全行程最多 40 000 点。这些约束在预览前就生效，所以预览能打开的行程一定存得下，不会先让用户看见再说存不了。
- 单份 640 KB 的容量口径是真正写下的记录 `{ id, savedAt, trip }`（`savedTrips.savedTripRecordBytes`），包含 id 与保存时间的元数据，不只是 trip 本身；导出、导入、本地保存三处用同一个口径，卡在 640 KB 的边界文件不会出现「预览通过、保存必然失败」。超限一律 fail-closed：不生成文件、不写存储。
- 同 ID 覆盖必须在页面内二次确认，不弹 `confirm` / `alert`。确认时会重读存储，并同时比对 `savedAt` 和本地副本的完整内容快照，任一变化都拒绝写入并刷新快照让用户重新确认。localStorage 没有跨标签页的原子 compare-and-swap，「读 → 比对 → 写」之间其他标签页仍可能写入，这里只能缩小覆盖窗口，不保证绝对原子。
- 预览里的「行程来源」和「导出时间」都是文件自述：`source` 只代表文件自己标了示例 / 生成，证明不了行程的真实来源；`exportedAt` 不参与任何校验，展示时只接受规范 ISO 8601（统一换算成 UTC），其他内容一律显示「格式无法识别」，不把文件里的长文本原样渲染出来。
- 取消替换、确认失败、读取或写入异常时，本地已保存内容逐字节不变；数据损坏或含无法识别记录时按现有策略整体暂停写入，不静默丢弃或覆盖。
- 读取失败、写入失败、下载失败都只显示固定文案，不回显浏览器原始异常（可能带本机路径）。`File.size` 是 NaN / 负数 / Infinity 之类不可信值时保守拒绝，不读取文件内容。
- 内联确认的说明文字放在 `role="alert"` 里朗读，按钮放在紧邻的 `group` 中（不把交互控件塞进 alert）；确认框关闭后焦点回到「保存到本地」，放弃预览时回到文件选择框。

## 日历导出（.ics）

- 点「下载 .ics 文件」才生成文件并用浏览器下载到本机，需要你手动导入 iOS 日历 / Google Calendar / Outlook。不会上传，也不会修改或保存行程。
- 每个事件必须有合法日期和开始时刻。只有整份行程所有天的 `date` 都为空、且至少一天有站点时，面板才要求你先选「行程首日」；输入框默认空，必须由你主动选择。导出按天序号在真实日历上推算日期（跨月、跨年、闰年按实际日期算），仅用于本次导出，不写回原行程。存在任何真实日期时不会出现首日设置，缺日期的天只跳过。
- 时间是不带时区的 floating local time，导入端按导入设备的本地时区解释。换设备或跨时区时，事件对应的绝对时间会变（钟面时间不变），导入后请抽查第一场事件。
- 停留时长缺失、为 0、负数、非整数或超过 1440 分钟时，只写开始时间，不写结束时间，也不用默认时长补算。日历应用可能按自身默认时长显示一个结束时间，那不是行程数据的一部分。
- 坐标不写入 `.ics`，`LOCATION` 使用站点地址；地址或讲解为空就省略对应字段。
- 示例行程的事件标题带【示例】前缀，描述注明「示例行程数据，仅用于演示，未包含任何真实预约」。导出不写 STATUS、ORGANIZER、URL，不代表真实预订或已确认。
- 缺日期、日期非法、时刻非法或站点无名称的站点会被跳过并列出原因；没有有效事件时不会下载空文件。重复导出同一事件的 UID 保持不变。

## 停止等待

规划请求进行中可以点「停止等待」。本页会立即中止等待并忽略迟到的响应，可以马上改参数重新提交。这个动作只影响本页，不保证后端或上游模型停止处理，也不能保证停止计费。

## 构建与测试

```bash
pnpm build           # tsc -b + vite build
pnpm test            # vitest 单测（含 App 集成测试）
pnpm preview         # 预览 dist 产物
```

`pnpm test` 也会跑 `dev-stub/server.test.mjs`：只起本机 http 服务核对桩的标识与 503 行为，不连外网、不依赖高德或模型。前端单测覆盖接口客户端、地图数据、瓦片状态、保存读写（`savedTrips.test.ts`）、日历生成（`calendar.test.ts`）与下载（`icsFile.test.ts`），以及保存、导出相关的组件测试。

接口地址：默认走同源 `/api`（dev 由 Vite 代理，生产需反代同源 `/api`），也可用 `VITE_API_BASE` 覆盖（如 `VITE_API_BASE=http://127.0.0.1:8001`）。注意 `VITE_API_BASE` 是构建/启动时读取的环境变量，不是运行时变量：开发在 `pnpm dev` 前设置，生产在 `pnpm build` 前设置；bundle 生成后再改系统环境变量不会重写已构建的产物。

## 目录

```
frontend/
├── dev-stub/server.mjs        # 开发桩：固定示例 + 探活，不提供规划
├── public/favicon.svg
├── src/
│   ├── main.tsx               # 入口
│   ├── App.tsx                # 页面编排：示例加载、规划/停止等待、日切换、恢复保存、站点联动
│   ├── app.css                # 样式（引用 ../tokens.css 设计令牌）
│   ├── tokens.css             # 设计令牌（OKLCH 颜色 + 字体 + 4pt 间距）
│   ├── components/
│   │   ├── PlanForm.tsx       # 规划表单（校验、loading、停止等待）
│   │   ├── ItineraryList.tsx  # 逐日行程清单（逐点讲解、复制为文本）
│   │   ├── TripMap.tsx        # Leaflet 地图（站点、路线、图例、空态）
│   │   ├── SavedTripsPanel.tsx # 本地保存 / 恢复 / 删除 / 撤销 / 清除
│   │   ├── TripTransferPanel.tsx # 行程备份导出、文件导入预览、同 ID 覆盖确认
│   │   ├── tripTransfer.css   # 备份面板样式（引用 tokens.css，不写死色值）
│   │   └── IcsExportPanel.tsx # 日历导出（首日选择、跳过与导入提示）
│   └── lib/
│       ├── api.ts             # 后端客户端（/api/trips/example、/api/trips/plan）
│       ├── format.ts          # 展示格式化与 OSM 链接
│       ├── mapData.ts         # 日行程 → 地图数据（坐标清洗、路线分类）
│       ├── tileStatus.ts      # 瓦片加载状态结算
│       ├── savedTrips.ts      # localStorage 读写、共享结构校验与单份容量口径
│       ├── tripTransfer.ts    # 备份信封、严格投影、导入 / 导出共用的结构与容量校验
│       ├── tripFile.ts        # 备份文件名、Blob 下载、读文件前的体积门禁
│       ├── calendar.ts        # Trip → .ics 纯函数（转义、折行、UID、日期推算）
│       └── icsFile.ts         # 文件名清洗与 Blob 下载
└── src/__tests__/             # vitest 单测与集成测试（含保存、备份、导出、日历、ICS 文件）
```

## 契约要点（与后端约定）

- `GET /api/trips/example`、`POST /api/trips/plan` 返回同一 `Trip` 结构；`source: 'example'|'agent'` 决定「示例行程 / AI 规划」标识。开发桩只返回 `source: 'example'`，路段只含 `straight_line` / `unavailable`。
- 坐标一律 WGS84 `lng/lat`；前端转成 Leaflet 的 `lat,lng`。
- `route_type`：`navigation` 画地图服务路线、`straight_line` 画虚线并在图例标注「示意直线（非导航）」、`unavailable` 不画线只给文字。
- 模型文案只按纯文本渲染，不做 HTML 注入。
- 后端不可达时：示例区给出明确错误与重试；规划区给出可操作的提示；地图缺瓦片/缺坐标各有空态。

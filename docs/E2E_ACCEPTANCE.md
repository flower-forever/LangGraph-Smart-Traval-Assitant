# E2E 离线契约浏览器验收

## 这是什么

`pnpm verify:e2e`（frontend 目录内）一条命令跑完「生成 → 查看 → 本地编辑/重排 → 显式应用 → AI 单日调整 → 仅刷新地图 → 天气/POI → 手工费用 → 保存 → 四类文件下载 → 恢复」全链路，外加失败保旧与迟到响应两个边界场景，桌面 1440 与窄屏 390 两个视口；再加五个**恢复启用（opt-in 会话留存）**场景：跨标签停写、reload→pending→显式恢复（含 App 写回→reload→恢复闭环）、坏数据保旧、可控注入故障、文件来源 true 全链路。

**2026-11-04 新增（网页资料场景 10–12）：已在真实浏览器实跑通过**（2026-11-04 报告：12 场景 95 步全过、实际出站 0、console 预期 1/未预期 0）；下表 10–12 为实际步骤与断言。原 9 场景（含恢复 true/unknown/false 三态）保持不变。

**模式边界（重要）**：这是**离线 HTTP 契约浏览器验收**。

- 所有 `/api` 请求命中本进程内的契约桩（`dev-stub/contract-server.mjs`），返回当前契约信封的固定测试数据；
- 浏览器所有非本机请求被 Playwright 路由拦截：OSM 瓦片 fulfill 为本地 1×1 测试图块，其余 abort 并使验收失败；
- 因此它验证的是 **UI 行为与前后端契约**，**不是真实模型输出，也不是真实地图/天气/POI 数据质量**。截图与 JSON 报告（`e2e/artifacts/report.json`）均标注 `offline-contract-browser-acceptance`。

真实服务验收（配置 Key 的 `api_server.py` + 真实模型/地图）是另一批独立工作，不在本脚本范围内；不要把本脚本输出当作真实模型验收证据。

## 运行与产物

```bash
cd frontend
pnpm verify:e2e
```

**需要本机 Chrome/Edge 的只有 `pnpm verify:e2e` 与 `pnpm verify:e2e:malicious-base` 两条显式命令**；普通 `pnpm test` 只跑 jsdom/Node 单元（fixtures/diagnose 等纯单元都在默认集合，不需要浏览器，fresh clone/CI 可直接跑）。

- 产物全部落在 `frontend/e2e/artifacts/`（已在 `.gitignore`）：场景截图（01–28，覆盖桌面与窄屏关键状态；28-narrow-web-open 为场景 12 窄屏 available 结果展开态的补充视觉证据——滚动至结果卡可见后拍摄，未核实声明/安全链接/出处日期在画面内，页首表单允许出屏；28-narrow-web 为收起后状态；`file-source/` 子目录为场景 9 的真实下载备份）与 `report.json`。
- 报告包含：外部 HTTP 尝试计数（应全部为瓦片 fulfill）、被拦截计数（应为 0）、契约请求全量记录（路径+请求体）、场景失败列表、恢复场景注入声明（`resume_injection_note`）与覆盖限制（`resume_coverage_limits`）。
- 退出码非 0 即存在失败；失败明细打印在 stderr。

## 结构

| 文件 | 作用 |
| --- | --- |
| `e2e/runner.mjs` | 单 Node 进程：创建契约桩 `http.Server` 与 Vite dev server（Node API，`configFile:false` / `envDir:false` + `define` 钉死 `VITE_API_BASE`，proxy `/api` → 本次桩口，仅本次 owned origin），全程 top-level try/finally；本机 Chrome/Edge fresh 临时 profile 跑场景 |
| `e2e/sessionResumeScenarios.mjs` | 恢复启用场景（场景 5–9）：从 runner 编排调用，驱动真实 UI 与真实 localStorage；自带断言 helper 与合法 v1 信封种子构造器（供场景 6/7 种子化，属被测输入「上次会话留下的副本」，页面运行时业务状态一律不注入） |
| `e2e/webSourcesScenarios.mjs` | 网页资料场景（场景 10–12）：入口零请求、显式恰好一次 POST（body 仅规范化 query，FEFF 原样保留）、available 安全展示、业务失败四态明示、迟到 gate 停止等待/收起不复活、390 窄屏；驱动真实 UI，模式与 gate 走 runner 持有的内存 control，无 HTTP 控制端点 |
| `e2e/routePolicy.mjs` | 离线路由决策纯函数（runner 与测试同源） |
| `e2e/diagnose.mjs` | 门禁纯 helper：console/pageerror 分类、route 处置汇总 |
| `e2e/diagnose.test.mjs` | 门禁逻辑的故障注入测试（含启动失败清理复现） |
| `e2e/malicious-base.mjs` | 恶意 `VITE_API_BASE` 继承探针（显式命令 `pnpm verify:e2e:malicious-base`，动态隔离哨兵端口，需本机浏览器） |
| `dev-stub/contract-server.mjs` | 仅 runner 创建的契约桩：plan/example/replan/map-refresh/weather/poi-sources 响应构造器全部导出（与防漂移测试同源）；请求带 `settled` 生命周期 Promise；场景由 runner 持有的内存 control 控制，**无 HTTP 控制端点**。默认 `dev-stub/server.mjs`（example+503）不受影响 |
| `dev-stub/contractFixtures.json` | 契约测试数据 |
| `dev-stub/contractFixtures.test.mjs` | Vitest：runner 运行时用的同一批构造器 + 前端真实 validators 闭环 |

契约防漂移测试随 `pnpm test` 一起跑；桩数据或前端契约任一侧变化而另一侧没跟上时先在单测红。

## 场景清单（与 report.json 的 scenarios/实际步骤一致）

| # | 场景 | 视口 | 覆盖 | 关键断言 |
| --- | --- | --- | --- | --- |
| 1 | happy 正常全链路 | desktop-1440 | 示例首屏→瓦片（本地图块）→生成→本地编辑重排（UI 顺序真实变化）→应用→AI 候选+应用（主视图站点变化）→地图补算（预览不改行程；应用后 marker 重渲染）→天气/POI available→费用 0+25.5=25.50→保存→四文件下载逐项核对（JSON 与基准 days/id 全等；ICS 事件数/首站 SUMMARY/DTSTART/LOCATION；MD 全站名+停留+直线/导航标签；费用绑定 trip id+0/25.5/空预算）→改站名不保存→恢复（存储 localStorage 逐字节不动+UI 导出与基准全等） | 18 步 |
| 2 | planFailure 规划失败保旧 | desktop-1440 | 503 后旧行程标题不变、错误横幅+归属说明（含目的地）、恢复后可重新生成 | 3 步 |
| 3 | lateReplan 迟到不复活 | desktop-1440 | gate 挂起（pendingCount≥1 显式证据）→停止等待（桩侧显式观察到连接 abort，非固定 sleep）→候选不复活、行程不变 | 5 步 |
| 4 | narrow 窄屏冒烟 | mobile-390 | 生成→编辑重排→应用→AI（显式选步行）→保存→首尾横向无溢出 | 7 步 |
| 5 | resumeCrossTab 恢复跨标签 | desktop-1440 | off 默认形态（启用与显式检查入口，无 pending/恢复/关闭/删除）→显式开启（flag='1' + 首份自动留存落盘、信封 format/version/savedAt 核对）→帮助文案不保留范围→费用原字符串 0/空/abc 计算合计 25.50 + 无效项列表保留原文→草稿改第 1 站名保存到草稿（不应用）→自动留存快照含草稿块+4 行费用原字符串+**openedFromFile===false 显式断言**（全程真实 UI，无文件打开）→dirty 输入期间停写（有界窗口）取消输入后恢复→同 context 第二真实页面共享存储→第二页写数据键→第一页收到真实 StorageEvent 冲突停写（提示文案+外部副本逐字节原样+停写后编辑不再落盘） | 11 步 |
| 6 | resumeRestore reload→pending→显式恢复（来源 null 全程） | desktop-1440 | off 零键（含规划/停止等待也不写）→种子化 flag=1 + 合法 v1 信封（**来源未知 openedFromFile:null**，草稿+费用 0/空/abc）→reload pending 概况（标题/天数/草稿/费用条数/来源未知自述；示例不覆盖 raw）→pending 期间规划 gate 挂起→停止等待→迟到响应放行后页面/副本均不被覆盖→显式恢复进编辑态（草稿预览站可见、应用草稿入口在、无「已保存」时间戳）→放弃草稿后恢复通告（来源未知自述+不是保存的行程）→费用面板 3 行原字符串原样、current 重绑可编辑可计算→正式保存键全程未出现、再次留存来源保持 null→关闭保副本（flag 置 0、数据键原样、删除入口在）→重新开启回到 pending（不自动恢复）→**闭环恢复：App 自己写回的 record → 关闭/重开 → reload 后 pending 仍在 → 显式恢复再次成功（未知来源通告、无草稿、无已保存时间戳）→费用原字符串（含编辑过的 30）经 App 写回→reload→恢复保持，正式保存键仍未出现** | 14 步 |
| 7 | resumeCorrupt 坏数据原子保旧 | desktop-1440 | 坏 JSON→问题态（「不是合法 JSON」+原样保留声明、无恢复入口、删除入口在、raw 逐字节保留、示例加载不受影响）→异版本 version:99→问题态+raw 保留→关闭→off 门禁不读不写→off 下 reload 不自动读取或展示待恢复内容（保留显式检查入口），副本仍原样 | 4 步 |
| 8 | resumeInjection 可控注入故障 | desktop-1440 | 显式开启+首份自动留存→注入 `window.localStorage` getter SecurityError（addInitScript，页面脚本前）→问题横幅「存储不可用…留存未启用」+启用入口保留+还原后副本逐字节原样→还原后注入 `setItem` QuotaExceededError→切日签触发真实自动写→「存储已满…副本保持原样」提示+副本原样+还原后停写持久（再次操作仍不落盘）→步骤内记录注入边界声明（非自然故障） | 4 步 |
| 9 | resumeFileSource 文件来源 true 全链路 | desktop-1440 | fresh context→真实规划（契约桩 AI 行程，与示例区分）→展开「行程备份与导入」→**显式点「下载行程备份 (.json)」真实 download**（信封 format/version/exportedAt/trip 核对）→**标准 file input `setInputFiles` 选择刚下载的文件**→页面预览（标题=AI 契约桩）→**显式点「打开这份行程」**（「来自备份文件+未向服务器核对+不自动保存」说明可见）→显式启用留存（首份快照 **openedFromFile===true**）→UI 产生辨识费用 77.25 + 草稿改名「文件来源站（未应用）」→再次留存保持 true、费用原字符串 77.25→reload→pending 概况（**文件自述来源**+1 条费用+raw 保旧；示例不覆盖）→显式恢复进编辑态（草稿站可见、应用草稿入口在）→放弃草稿后恢复通告=「来自备份文件+仍未向服务器核对+不是保存的行程」、文件来源说明保持、无已保存时间戳→费用 77.25 原字符串原样且可编辑→再次留存 true 保持、draft=null 合法空值、正式保存键未出现→关闭保副本 | 11 步 |
| 10 | webMain 网页资料主链路 | desktop-1440 | fresh context 示例行程、存储零键→入口默认收起、打开面板零请求→预填费用 77.25 计算后收起（可核对基准）→FEFF 包裹中文 query 显式搜索**恰好一次 POST、body 仅 `{query}` 且 FEFF 原样保留**→available 结果安全展示（data-status/已返回标签/未核实声明/2 条目/https 链接只查 href+target=_blank+rel/纯文本无 script·iframe·img/出处 2025-06-01 与「未知（来源未提供）」/查询发起与获取时间/实发 FEFF 原文/契约桩测试数据免责声明）→Trip 标题不变、localStorage 全程零键、重开费用 77.25 原字符串仍在并重算一致→收起重开全新实例（空输入/无旧结果/不重发） | 7 步 |
| 11 | webFailure 业务失败四态保旧 | desktop-1440 | 同 context：预填费用 77.25 基准+面板零请求→`no_results`（明示「没有搜索结果」+「不代表该地点不存在」，恰 1 请求）→`no_usable_results`（明示取得 3 条全部未过安全检查、不代表无结果，恰 1 新请求）→`no_key`（明示「服务端没有配置搜索 Key」，不回显上游 reason 原文，恰 1 请求）→`unavailable`（明示「搜索服务暂时不可用」，恰 1 请求）→恢复默认 mode 收起；每态清当前结果、Trip 标题/费用 77.25/存储零键保旧，一次点击一请求无隐式重试，HTTP 200 业务失败不产生 console 错误 | 5 步 |
| 12 | webLate 迟到不复活+390 窄屏 | desktop-1440→mobile-390 | gate 挂起（pendingCount≥1 显式证据、aria-busy）→停止等待：桩侧 settled==='aborted' 显式观察到连接断开→release 放行迟到响应（responses 含该 seq）后无结果复活、固定「已停止等待」文案、无隐式重试→再次挂起用「收起」结束等待：同样 abort 证据+release 不复活→重开全新实例（空输入/无旧结果/不重发）恢复默认后显式搜索 available→390 窄屏打开查询渲染无横向溢出、收起/控件可操作、结果链接只查 href、存储零键 | 6 步 |

**恢复场景注入边界（report.json 的 `resume_injection_note`，必须随报告保留）**：场景 8 的 SecurityError / QuotaExceededError 由测试脚本经 Playwright `addInitScript` / `page.evaluate` 可控注入（覆盖 `window.localStorage` 属性 getter 与 `Storage.prototype.setItem`），**不是平台自然触发的 quota/权限事件**；自然 quota 在 fresh 临时 profile 里不可复现，如实声明。注入只模拟存储访问故障，不伪造任何业务数据。

**恢复场景来源三态覆盖**：`false`（场景 5，真实 UI 启用后的快照显式断言）；`null`（场景 6，旧记录缺字段跨种子/恢复/再次留存/reload 保持未知）；`true`（场景 9，真实导出→setInputFiles→显式打开→启用留存→恢复的完整 UI 链路，文件自述与「未向服务器核对」全程保持）。三态均为浏览器实测。

**恢复场景覆盖限制（report.json 的 `resume_coverage_limits`，不假称全覆盖）**：

- 费用 binding=stale（只读沿用/新建交互）由 jsdom 集成测试覆盖，浏览器场景不造 stale 夹具。
- 自然平台 quota、`localStorage.clear()` 的 key=null 事件、too_large 体积门禁不在本批（场景 8 的 quota/SecurityError 是可控注入，非自然事件）。

**明确未覆盖**：AI 后段（tail/锚点）路径；窄屏下天气/POI/费用/导出面板（仅桌面核；网页资料面板的窄屏已由场景 12 覆盖）；真实瓦片渲染质量与弱网；真实模型/地图/天气/POI 服务；真实 Tavily 上游（网页资料场景全部打本进程契约桩，结果/摘录/日期都是固定测试值）。失败路径时 exit 非 0 且 report.failures 列出全部失败步骤。（备份文件导入分支已在场景 9 以真实 download + setInputFiles + 显式打开覆盖核心链路；「保存到本地」替换确认等分支仍未在浏览器场景覆盖。）

## 门禁与负向证据

- **console/pageerror**：任何 console.error/pageerror 都判未预期并使门禁红；唯一例外是 fail 场景里带场景证据（该场景记录过一次 `/api/trips/plan` 503 响应）的单次资源错误。分类逻辑在 `e2e/diagnose.test.mjs` 有故障注入测试（未预期噪声红、第二条 503 红、happy 场景 503 红、404/500 红、对真实 report 回放）。恢复场景的注入故障走页面内可控脚本，**不产生任何 console.error / pageerror**（App 全部 try/catch 收敛为 UI 提示），所以门禁对恢复场景同样零豁免。
- **离线拦截**：route 决策表 `e2e/routePolicy.mjs`（runner 与测试同源）——本次 owned origin 放行；`https://tile.openstreetmap.org/{z}/{x}/{y}.png` fulfill 本地图块；其余（公网、其它 loopback 含真实 8000）一律 abort。`actualOutbound`（放行出站）>0 或 `handlerErrors`>0 即红；`route_summary` 全部从实际 route 处置结果导出，无硬编码。
- **API base 钉死**：runner 用 Vite `define` 把 `import.meta.env.VITE_API_BASE` 编译为空串——`envDir:false` 只挡 .env 文件，挡不住 `process.env` 继承，`define` 两者都挡。显式命令 `pnpm verify:e2e:malicious-base`（需本机浏览器）以「probe 自己拥有的动态隔离回环端口」作为恶意 foreign origin 跑完整验收：哨兵收到的连接数为 0（零触达），route 层把该 origin 的任何请求截获为 `abort_loopback_foreign`。不 bind 固定 8000，不碰用户可能开着的真实服务；routePolicy 单测仍以 8000 为例明确拒绝。
- **迟到响应定序**：桩为每个请求暴露 `settled` Promise（'responded' | 'aborted'）；停止等待后 runner 显式等待该请求的 settled==='aborted'，不依赖固定 sleep。浏览器 abort 切断响应的真实行为由此证明；「忽略 AbortSignal 的适配器」边界由既有 jsdom 单测覆盖，本脚本不冒充。恢复场景（场景 6）的迟到规划用 `planDelay` gate 挂起→停止等待→显式 release 放行，副本与页面均不被迟到响应覆盖。网页资料（场景 12）同一模式：`webSourcesDelay` gate 挂起有 `pendingCount` 显式证据，停止等待/收起两条停止路径都以桩侧 `settled==='aborted'` 证明真实网络 abort，release 放行迟到响应（`responses` 含该 seq）后 UI 不复活结果；不据此外推「忽略 AbortSignal 的适配器」在浏览器中的行为（该边界仍由 jsdom 单测覆盖）。
- **网页资料模式与防污染**：`control.webSourcesMode`（null=默认 available / no_results / no_usable_results / no_key / unavailable）与 `control.webSourcesDelay` 由 runner 内存控制，无 HTTP 控制端点；三个网页场景的包装层在 `finally` 里把两者复位为默认，模式/门失败不会污染后续场景的分类。请求计数断言一律用场景开始基线的相对增量（`control.requests` 全程累计、跨场景共享同一桩进程）。业务失败信封走 HTTP 200（`x-web-sources-status` 头），不产生任何 console 资源错误，门禁对网页场景零豁免——503 预期豁免仍只属于 fail 场景的单次 `/api/trips/plan` 证据。结果链接只核对 href/target/rel，不实际点击、不抓取任何网页；notes 明示契约桩固定测试数据。`expectedPaths` 含 `/api/web-sources/search`；报告计数（`webMain` 7 步 / `webFailure` 5 步 / `webLate` 6 步）为 2026-11-04 实跑实际值。
- **启动失败清理**：runner 从 stub listen 起全程包在 top-level try/finally，Vite/Chrome 任一失败都走 finally 关闭全部已启动资源且 exit 非 0；`diagnose.test.mjs` 用端口占用注入与编排复现证明已监听端口被释放（可复绑）。

## 真实服务验收（另批，未实现）

本脚本**没有** `--real` 分支。真实服务验收需要：授权预算、启动配置了 Key 的后端、对真实模型/地图/天气/POI 各跑有限次数（建议各 1 次），归档截图并明确标注「真实服务验收」。届时可基于本 runner 的选择器另写小脚本或手工执行，模式声明必须与离线验收严格区分。

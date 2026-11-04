# Tavily 网页资料搜索

状态：**后端与前端均已接入，功能独立可用**。后端（client + router + 测试）
已注册进 `api_server.py`；前端 `WebSourcesPanel` 已在 `App.tsx` 接线并通过
离线测试与浏览器验收（契约桩）。本文档描述当前契约与安全边界；
"未核实""不自动"的边界同样是契约的一部分。

## 用户入口（前端）

- 行程区内点「查网页资料」展开面板；**打开面板、切天、选站、改输入都不发请求**，
  只有点「搜索网页资料」才显式向后端发一次请求，无隐式重试；每次后端请求
  最多尝试一次上游查询，缺 Key 或输入非法时不请求上游。
- 查询输入与后端共享同一套规范化口径（Python `str.strip()` 同码点判定）：
  规范化后为空、超过 300 码点或含孤立代理码点的输入按钮禁用或拒绝，0 请求。
- 面板归属（owner）：对当前天、行程快照（含 revision 与完整内容快照）与
  选中站点做序列化快照，并叠加单调 epoch 与渲染期守卫；切天、换行程
  （规划成功/导入/恢复）、关闭面板、进入本地编辑或 AI/地图面板都会使
  旧结果立即失效隐藏；「停止等待」或收起面板会真实 abort 在途请求，
  忽略 AbortSignal 的适配器产生的迟到响应也不落地、不复活旧结果。
- 结果只存面板内存：**不写 Trip / 费用 / localStorage / 恢复副本**，
  不自动应用或保存；失败信封逐状态明示（业务失败走 HTTP 200 + status），
  搜索失败时行程、费用与本地保存一律保持原样。

## 定位与边界

- 数据源固定为 Tavily Search API（`POST https://api.tavily.com/search`）。
  接口字段依据官方文档 `docs.tavily.com/api-reference/endpoint/search`
  （2026-11-03 核对）：Bearer header 认证、`search_depth: "basic"`、
  `max_results`（本地硬上限 1..5，默认 3；官方允许 0..20，本项目收紧）、
  `include_answer/include_raw_content` 固定 false、
  `include_published_date` 固定 true。
- 界面查询只能由用户显式点击「搜索网页资料」触发（每次后端请求最多一次上游
  尝试，无隐式重试；缺 Key 或输入非法时为零次）；后端不做自动搜索、不抓取任何结果链接、不把搜索摘要冒充
  官方或实时核验数据。
- 结果**不写** Trip / localStorage / 规划与费用；`content_status` 恒为
  `unverified`——title/snippet 只是搜索引擎返回的摘要文本。
- 与既有 OSM/Overpass「POI 公开资料候选」（`/api/poi-sources/nearby`）是
  两个独立 provider/endpoint/UI 标签，互不替代、互不兜底：Tavily 失败时
  返回 typed 失败信封，绝不拿 OSM 候选或模型生成文本冒充搜索成功。

## 接口

`POST /api/web-sources/search`

- 请求体仅接受 `{"query": string}`：trim 后按 Unicode 码点计 1..300
  （本地上限，非官方限制）。查询还必须是可编码为 UTF-8 的合法文本：
  孤立代理码点（如 ASCII JSON 里的 `\uD800`）无法编码进响应，按非法
  query 拒绝；合法 JSON 代理对（如 `\uD83D\uDE80`）解码后的 emoji 以及
  300 个 astral 码点正常接受，301 个拒绝。多余字段/非对象/非法 query →
  HTTP 422，0 次上游请求，422 信封不回显无效原文。缺 body、坏 JSON 及
  FastAPI/Pydantic schema 校验失败也折成同一固定 422：不读取/回显
  errors 里的 `input`、字段名或原始 body；该安全处理仅作用于本路由，
  其他路由保持 FastAPI 默认 422 形状。
- 上游 JSON 同样不可信：`title`/`snippet`/`published_date` 若含孤立代理
  码点，按 `failed` 返回固定可编码信封（`fetched_at=null`，不使用替换
  字符伪造摘要、不回显上游原文）；结果 URL 含同类码点时按不安全链接丢弃。
- 上游已请求过的结果一律 HTTP 200 返回 typed 信封 `WebSearchReport`，
  并带 `x-web-sources-status` 响应头（invalid_request → 422，同样带头）。
- client 未初始化/初始化失败 → 固定 503，不回显原因。

### 信封字段

```
status: available | no_results | no_usable_results | invalid_request
      | no_key | timeout | rate_limited | unauthorized
      | unavailable | failed
reason: 固定短句（绝不回显上游原文/异常文本/Key）
provider_http_status: 上游真实状态码；无 HTTP 响应的失败为 null
checked_at: 本次调用开始处理的 UTC 时间（不代表数据更新时间）
fetched_at: 仅在成功读取上游 2xx body 且 JSON/结构解析可信后设置
requested_query: 规范化后实际发送的查询（invalid_request 为 null）
max_results: 本次请求的上限（回显）
results_seen: 上游返回的原始条目数（可能 > 展示条数）
results[]: { title|null, url, snippet|null, snippet_truncated,
             publication_date|null }
notes[]: 固定中文说明（截断/过滤/坏条目计数）
source: { provider: "tavily", endpoint, docs_url }
content_status: 恒为 "unverified"
```

### 状态语义（互斥、无矛盾）

| status | 触发条件 | 结果列表 |
| --- | --- | --- |
| `available` | ≥1 个通过安全检查的可展示条目 | 非空 |
| `no_results` | 上游成功返回且 `results` 为空数组 | 空 |
| `no_usable_results` | 上游有条目但全部未通过 URL 安全检查/结构损坏 | 空 + notes 说明"取得 N 条但均无法安全展示" |
| `invalid_request` | query 非法（422） | 空 |
| `no_key` | 服务端未配置 `TAVILY_API_KEY`（0 请求） | 空 |
| `timeout` | 总 deadline（默认 10s）到期 | 空 |
| `rate_limited` | 上游 429/432 | 空 |
| `unauthorized` | 上游 401/403（Key 未被接受） | 空 |
| `unavailable` | 上游 5xx 或网络错误 | 空 |
| `failed` | 坏 JSON/超 256KiB/重定向/缺 results 等结构损坏、上游 4xx | 空 |

`fetched_at` 与 `checked_at` 分开：`checked_at` 只是查询发起时间，永远不
冒充资料更新时间。`publication_date` 只来自上游真实字段归一化
（ISO `YYYY-MM-DD` 或 RFC1123，统一转 UTC 日期）；缺失/非法为 null，
绝不用当前时间或抓取时间代填，不宣称结果"新鲜"。

## URL 安全策略（首批保守版）

结果条目的 `url` 逐条过 `is_shareable_https_url`（`tavily_web_client.py`，
纯语法检查，不做 DNS 解析、不 fetch 结果页面）：

- 仅绝对 `https`；无 userinfo；无控制字符/空白；总长 ≤2048；
- host 仅 ASCII（可解码的标准 punycode 如 `xn--p1ai` 可；原始 Unicode host 首批
  拒绝并在 notes 说明）；
- 所有 `xn--` A-label（TLD 位与中间 label 一致）必须可被 stdlib
  `encodings.idna.ToUnicode` 真实解码（零新依赖）；无效 punycode
  （`example.xn--a`、`xn--p1ai.xn--a.example.com` 等）一律拒绝——浏览器
  WHATWG URL 解析同样拒绝这类 URL，放行会让前端整包校验折算
  bad_payload、同批合法结果一并丢失（2026-11-04 修复）；
- 端口仅允许省略或 443；
- 拒绝一切 IP 字面量（v4/v6、整数/十六进制/八进制别名）、
  `localhost`/`.localhost`/`.local`/`.internal`、单 label、纯数字或
  `com1` 式伪 TLD；
- 域名至少 2 个合法 DNS label，末 label 为 ≥2 纯字母或可解码 punycode。

被拒条目不展示并计数进 notes；全部被拒时状态为 `no_usable_results`，
不会写"上游没有结果"。前端（`lib/webSources.ts`）会独立复验信封与链接并纯文本渲染；
两端域名处理的已知差异见下文。

**已知保守差异（不宣称 WHATWG 等价）**：后端用 stdlib IDNA2003 校验，
与浏览器 UTS46 nontransitional 存在差异。部分前端接受的 A-label 被
后端多滤（实测样本：`xn--zca`/ß、`xn--strae-oqa`/Straße、`xn---9a`/£）；
被多滤条目计入 notes。作者约 450 组和独立审查 104 条离线差分中，均未发现
后端放行而前端拒绝的反例；这是有限样本结果，不保证未测试域名同样一致。

## Key 与传输安全

- Key 只从 `TAVILY_API_KEY` 环境变量读取（lifespan 启动时，import 不读
  env）；缺失/空白时服务照常启动，请求返回 `no_key` 信封。
- Key 只存在于 Authorization header；绝不进 URL、日志、信封或异常文案。
- 上游 endpoint 固定为官方常量；`follow_redirects=False`、无重试；
  错误正文不消费、不解析、不透出（只保留 `provider_http_status` 数字）。
- 写请求防护：POST 由 `api_server` 现有 app 级来源守卫
  （BrowserOriginGuardMiddleware + 显式 CORS 白名单）按方法统一拦截，
  本路由未复制或绕过该守卫。

## 测试

当前批实测计数（离线，不发真实网络请求；与其他文档的历史数字不是同一口径）：

- `tests/test_tavily_web_client.py`（114 项 PASS）：请求契约/Key 卫生、状态矩阵、
  publication_date 归一化、URL 拒绝/接受矩阵、条目上限、并发隔离、取消、
  所有权；查询与上游字段的孤立代理码点回归（合法 emoji 300 / 301 边界）；
  模块级 autouse 守卫把任何真实 httpx transport 出站变成红灯
  （MockTransport 不受影响）。
- `tests/test_tavily_web_api.py`（45 项 PASS）：路由契约/状态头、422 与 0 请求
  （含 ASCII JSON 孤立代理、合法代理对 emoji、FastAPI schema 错误、坏
  JSON 与非 UTF-8 body 的 HTTP 字节回归）、503、lifespan 环境变量 Key
  （无 Key 仍启动）、来源守卫 403/预检 400/白名单通过、生产 api_server
  注册与相邻旧接口不回退；同样默认断网。
- 后端整库回归：1150 passed / 3 skipped。
- 前端 vitest 目标：webSources.ts lib 117、webSourcesApi.ts 18、owner 8、
  Panel 50、App×WebSources 集成 15；恢复结构隔离与写前校验补充后的前端整库为
  69 文件 / 1517 项通过（2026-11-04 07:52 实跑）。
  类型检查覆盖 118 个源文件，生产 build 通过（91 modules）。
- 浏览器验收（`docs/E2E_ACCEPTANCE.md` 场景 10–12，真实 UI + 本进程契约桩，
  非真实上游）：新网页场景 webMain 7 / webFailure 5 / webLate 6 步 PASS，
  outbound 0 / handler 0，console 预期 1 / 未预期 0；结果链接只核对
  href/target/rel，不实际点击、不抓取任何网页。

## 本批次未覆盖

- 未做任何真实 Tavily 联调（业务外网预算为 0）；上游错误体真实形态、
  429 Retry-After 行为、published_date 真实变体仅依据官方文档样例，
  不能据此标注"真实源验证成功"。

## 前端接线（已实现）

`frontend/src/lib/webSources.ts` 按本文当前后端合同提供纯 TS 类型、
query 与后端 `str.strip()` 同口径的 1..300 码点与孤立代理校验、URL 安全策略、
日期与整份信封校验；`webSourcesApi.ts` 复用现有 `postJson`（12s 超时、
signal 透传、无重试），422/503 使用固定安全文案且不回显 detail。
`webSourcesOwner.ts` 提供天 + 行程快照（revision + 内容快照）+ activeStopId
的序列化归属快照；`components/WebSourcesPanel.tsx` 在 App 接入（入口
「查网页资料」/ 显式按钮「搜索网页资料」），render guard 保证只有
当前 epoch 且快照 key 完全一致的结果才显示，关闭/编辑/迟到一律失效。
整库前端测试、类型检查、生产 build 与浏览器验收均已通过（计数见「测试」）。
本批仍未做真实 Tavily 联调。

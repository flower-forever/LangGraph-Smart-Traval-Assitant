# Wikimedia Commons 图片搜索（Image Sources）

状态：**后端端点已接入（三期 S4）＋ 前端已接线（三期 S5）**。client + router +
契约测试已注册进 `api_server.py`；前端「资料卡编辑器内搜索图片」已由 S5 切片
落地（`frontend/src/lib/imageSources.ts` + `imageSourcesApi.ts` +
`PoiCardPanel.tsx` 内嵌搜索子区）。本文档描述当前后端契约、前端接线与安全
边界；"未核实""不自动"的边界同样是契约的一部分。

## 定位与边界

- 数据源固定为 Wikimedia Commons API：
  `https://commons.wikimedia.org/w/api.php`（`action=query` +
  `generator=search` + `gsrnamespace=6`，仅搜 File 命名空间）。接口参数依据
  MediaWiki API 文档（mediawiki.org/wiki/API:Search、API:Imageinfo，
  2026-11-08 核对）。**无 Key**：Commons API 不需要认证，后端不读任何
  环境变量。
- 固定上游参数：`format=json&formatversion=2`、`prop=imageinfo`、
  `iiprop=url|size|extmetadata`、`iiurlwidth=320`（请求 320px 缩略图）、
  `gsrlimit` 本地硬上限 10（官方允许更高，本项目收紧）。
- 界面查询只能由用户显式点击触发（S5 前端约束）；后端不做自动搜索、
  无重试——每次后端请求最多 1 次上游尝试，不跟随重定向。
- 结果是"Commons 返回的可展示图片条目"：缩略图/原图/描述页 URL、逐文件
  license 与作者署名。**署名与许可按上游原样透传，缺失即为 null，绝不编造**；
  Commons 内容遵守其许可体系（常见 CC 协议要求保留署名），是否可收进
  由前端按署名存在与否决定（S5：缺署名的结果不提供收进）。
- 中文景点名可查但覆盖不定：上游结果为空 → 诚实 `no_candidates`，
  **不兜底、不编造、不换关键词重查**。
- 图片仅存 URL（S5 资料卡侧），渲染由前端处理；后端不下载图片、不缓存
  上游响应、不写任何本地存储。
- 与 Tavily 网页搜索（`/api/web-sources/search`）、OSM 公开资料
  （`/api/poi-sources/nearby`）是三个独立 provider/endpoint，互不替代、
  互不兜底。

## 接口

`POST /api/image-sources/search`

- 请求体仅接受 `{"query": string}`：trim 后按 Unicode 码点计 1..100
  （本地上限）。孤立代理码点（如 ASCII JSON 里的 `\uD800`）无法编码进
  响应，按非法 query 拒绝；合法 JSON 代理对（如 `\uD83D\uDE80`）解码后的
  emoji 以及 100 个 astral 码点正常接受，101 个拒绝。多余字段/非对象/
  非法 query → HTTP 422，**0 次上游请求**，422 信封不回显无效原文。
  缺 body、坏 JSON 及 FastAPI/Pydantic schema 校验失败也折成同一固定 422：
  不读取/回显 errors 里的 `input`、字段名或原始 body；该安全处理仅作用于
  本路由，其他路由保持 FastAPI 默认 422 形状。
- 上游已请求过的结果一律 HTTP 200 返回 typed 信封 `ImageSearchReport`，
  并带 `x-image-sources-status` 响应头（invalid_request → 422，同样带头）。
- client 未初始化/初始化失败 → 固定 503，不回显原因。

### 信封字段

```
status: available | no_candidates | invalid_request
      | timeout | rate_limited | unavailable | failed
reason: 固定短句（绝不回显上游原文/异常文本/URL）
provider_http_status: 上游真实状态码；无 HTTP 响应的失败为 null
checked_at: 本次调用开始处理的 UTC 时间（不代表数据更新时间）
fetched_at: 仅在成功读取上游 2xx body 且 JSON/结构解析可信后设置
requested_query: 规范化后实际发送的查询（invalid_request 为 null）
max_results: 本次请求的条目上限（回显，≤10）
results_seen: 上游返回的原始条目数（可能 > 展示条数）
items[]: { title|null, thumbUrl, imageUrl, descriptionUrl,
          license|null, artist|null, width|null, height|null }
notes[]: 固定中文说明（截断/过滤/坏条目计数）
source: { provider: "wikimedia-commons", endpoint, docs_url,
         attribution_url, data_source: "Wikimedia Commons" }
```

items 字段语义：

- `thumbUrl` / `imageUrl`：仅接受 https 且主机恰为 `upload.wikimedia.org`
  的上游 URL；`descriptionUrl` 仅接受 `commons.wikimedia.org`。不安全的
  条目整条丢弃并计数进 notes，**绝不改写上游 URL**。
- `license`：来自 `extmetadata.LicenseShortName.value`，HTML 已剥离为
  纯文本；缺失/为空/超 300 码点为 null。
- `artist`：来自 `extmetadata.Artist.value`（上游常为 HTML，如作者页
  链接），后端剥标签、解码实体（`&amp;` 等）、折叠空白为单空格纯文本；
  缺失/剥离后为空/超 300 码点为 null（**不截断冒充完整署名**）。
- `width` / `height`：仅接受上游真实 ≥1 的整数，缺失/非法为 null。
- `title`：File 命名空间原始标题，超 300 码点置 null。

### 状态语义（互斥、无矛盾）

| status | 触发条件 | items |
| --- | --- | --- |
| `available` | ≥1 个通过安全检查的可展示条目 | 非空 |
| `no_candidates` | 上游成功返回但无命中（无 query 字段/空 pages），或有条目但全部未通过安全检查（notes 说明"取得 N 条但均无法作为图片展示"） | 空 |
| `invalid_request` | query 非法（422） | 空 |
| `timeout` | 总 deadline（默认 8s）到期 | 空 |
| `rate_limited` | 上游 429 | 空 |
| `unavailable` | 上游 5xx 或网络错误 | 空 |
| `failed` | 坏 JSON/超 1 MiB/重定向/`error` 结构/缺 pages 结构损坏/上游其他 4xx/上游文本含孤立代理码点 | 空 |

`fetched_at` 与 `checked_at` 分开：`checked_at` 只是查询发起时间，永远不
冒充资料更新时间。`license`/`artist` 是检索时刻上游展示的署名信息，
不宣称图片权利状态已核验。

## 诚实 UA 与传输安全

- 固定、诚实的应用请求标识（Wikimedia UA 政策要求可联系的标识）：
  `Travel-Assistant-ImageSources/1.0 (+https://github.com/flower-forever/`
  `LangGraph-Smart-Traval-Assitant)`，随单次请求发送；不含 Key/环境值，
  不伪装浏览器。自建与外部注入 client 两条路径一致（单次请求级覆盖）。
- 无 Authorization 头（Commons 不需要 Key）。
- `follow_redirects=False`、无重试；错误正文不消费、不解析、不透出
  （只保留 `provider_http_status` 数字）；`reason` 全部固定短句。
- 上游文本（title/URL/license/artist）含孤立代理码点 → 整份 `failed`
  返回固定可编码信封：不替换字符伪造内容，也不让响应编码崩溃。
- 流式读取解压后 body 上限 1 MiB；总 deadline 默认 8 秒，用
  `asyncio.wait_for` 真实取消（覆盖等 headers 与全部 chunk 之间的等待）。
- `provider_http_status` 走请求局部传递（返回值或异常属性），不存实例
  共享字段，并发请求互不串值。
- 写请求防护：POST 由 `api_server` 现有 app 级来源守卫
  （BrowserOriginGuardMiddleware + 显式 CORS 白名单）按方法统一拦截，
  本路由未复制或绕过该守卫。

## 超时与重试政策

- 总 deadline：8 秒（`total_deadline_seconds` 可配，须为 >0 有限数值），
  覆盖连接、等待 headers 与全部 body 读取；到期折算 `timeout` 信封。
- 单次上游尝试：任何失败（429/5xx/坏 JSON/超时）都直接折算对应失败信封，
  **无隐式重试、无 fallback 上游、无关键词改写**。
- 无缓存：每次 search 都是一次显式上游查询（与 Tavily 同口径）。

## 测试策略

全部离线（业务外网预算 0），真实 Commons 适配器保持薄层；测试用
httpx.MockTransport + recorded fixture（Commons formatversion=2 响应形状
依据官方文档样例手工记录），**绝不向 Commons 发真实请求**，本机不起服
对真实上游联调。模块级 autouse 守卫把任何真实 httpx transport 出站变成
显式红灯（MockTransport 不受影响）。

- `backend/tests/test_image_sources_client.py`（60 项 PASS）：请求契约
  （固定端点与参数、gsrlimit 上限、诚实 UA 两条路径、无 Authorization）、
  query 规范化（1..100 码点、孤立代理、emoji 边界）、状态矩阵
  （available/no_candidates/429/5xx/4xx/坏 JSON/error 结构/重定向/超
  1 MiB/总 deadline/单次尝试）、URL 白名单、HTML 剥离与署名边界、
  生命周期与构造参数校验。
- `backend/tests/test_image_sources_api.py`（34 项 PASS）：路由契约与
  状态头、422 与 0 请求（含 ASCII JSON 孤立代理、合法代理对 emoji、坏
  JSON 与非 UTF-8 body）、503、来源守卫 403/白名单通过、生产 api_server
  注册与相邻旧接口不回退。
- 前端（S5）：`frontend/src/__tests__/imageSources.test.ts`（query 规范化
  与后端同口径、7 态矩阵、URL 白名单、adapter 单请求无重试）+
  `PoiCardImageSearch.test.tsx`（显式触发零请求 / 逐张署名与许可 / 缺署名
  不收进 / 收进内存态→显式保存才落盘 / 失败逐状态文案 / 失败保旧）+
  `imageScenarios.test.ts`（dev-stub fixture 形状钉住）。实数见 S5 交付回报。
- 回归：既有 `test_poi_sources_*`、`test_tavily_web_*`、`test_api*` 全绿
  （实数见 S4 交付回报）；全量后端测试见收尾审计。

## 前端接线（三期 S5 已落地）

前端消费侧三件套，全部离线测试、业务外网 0：

| 文件 | 职责 |
|---|---|
| `frontend/src/lib/imageSources.ts` | 纯契约：类型、`normalizeImageQuery`（与后端 `normalize_image_query` 同口径：Python strip + 1..100 码点 + 拒孤立代理）、`validateImageSearchReport`（7 态矩阵 + requested_query 归属核对 + 条目 URL 白名单复核，任一条目不安全整份作废）。无网络、无 UI、零存储。 |
| `frontend/src/lib/imageSourcesApi.ts` | 请求 adapter：复用 `api.ts` 的 `postJson`（取消 / 超时时钟 / 错误分类），每次调用只发一次 POST（`timeoutMs=12000`，后端总 deadline 8s 前端留余量）；不重试、不自动查询；结构不符抛 `ApiError('bad_payload')`；HTTP 422/503 折成固定安全文案（不透传 detail）。 |
| `frontend/src/components/PoiCardPanel.tsx`（内嵌 `WikimediaImageSearch` 子区） | 编辑器内「搜索图片」：显式触发、结果网格、逐张收进（详见下）。 |

### 界面行为与红线（S5）

- **入口**：资料卡编辑表单内的「搜索 Wikimedia 图片」子区；查询输入带卡名
  预填（可改）。**只有点「搜索图片」才发一次请求**：挂载、改输入、改名、
  收进、换卡都不发；每次点击最多一次上游请求，**失败不自动重发**（错误文案
  提示用户可再点一次）。
- **结果网格**：逐张展示缩略图（`thumbUrl`，懒加载，失败占位「缩略图加载
  失败」不阻断）+ `license`（缺失显示「未知」）+ 作者署名 `artist`（缺失显示
  「未知」）。结果默认「未核实」标注：署名与许可是检索时刻的上游展示，不
  宣称图片权利状态已核验。
- **缺署名不收进**：`artist` 为 null 的条目**不提供收进按钮**，固定文案
  「缺作者署名，不提供收进（CC 协议要求保留署名）」——CC 协议要求保留署名，
  前端按署名存在与否决定是否可收进，绝不替用户编造署名。
- **收进（确认流内的一步）**：点某张的「收进」→ 图片加入**编辑内存态**
  `form.images`（`source='wikimedia'`，`attribution=artist`，`license` 原样
  保留，`caption=null`）。收进去重（同 `thumbUrl` 已在表单 → 显示「已收进
  表单」徽标）、张数上限沿用 S3（满 8 张显示「图片已满，先移除后才能收进」）。
  **收进本身不写任何键**：仍走本面板已有的「保存资料卡」显式保存才落盘
  （`handleSavePoiCards`，expectedRaw 冻结比对）；不保存直接取消 / 关闭，
  收进内容随内存态丢弃，零写入。
- **失败信封逐状态明示**：7 态各配固定中文文案（诚实展示、无兜底编造、
  reason 原文一律不回显）；传输层失败（超时 / 网络 / 422 / 503 / 坏结构）
  也各配固定安全文案。**失败保旧**：搜索失败只影响本次结果展示，已编辑
  内存态（含已收进图片）与存储字节完全不变。
- **图片仅存 URL**：收进只存 `thumbUrl` 引用（≤1000 字符，超限拒绝）；
  不下载、不转存、不内嵌图片数据。
- 文案红线沿用：无「已预订/已确认/已出票」；未知显示「未知」；不自动收图、
  不自动写任何键。

### dev-stub fixture（S5）

`frontend/dev-stub/server.mjs` 扩展 `POST /api/image-sources/search` 分支 +
`frontend/dev-stub/imageScenarios.mjs` 固定场景表：

- 请求体仅 `{"query"}`；**`场景:xxx` 前缀选择场景**，普通 query 返回
  `available_many`（3 张，含 1 张无署名条目，用于验证「缺署名不提供收进」）。
- 场景齐备：`available_many` / `available_single` / `no_candidates` /
  `invalid_request` / `timeout` / `rate_limited`（429） / `unavailable`（503）
  / `failed`（404）。所有 URL 使用白名单主机（upload.wikimedia.org /
  commons.wikimedia.org），形状经 `imageScenarios.test.ts` 钉住。
- 空 query / 坏 JSON / 超 100 码点 → HTTP 422 + `report` 信封（与后端
  同一 422 语义，0 场景请求）。

## 本批次未覆盖

- 未做任何真实 Commons 联调（业务外网预算为 0）；上游错误体真实形态、
  429 行为、extmetadata 真实变体仅依据官方文档样例，不能据此标注
  "真实源验证成功"。
- `artist` 的 HTML 剥离用 stdlib `html.parser`（零新依赖），覆盖常见
  标签与实体；真实 Commons 富文本若含脚本化内容，按文本节点收集处理，
  不会执行任何脚本。

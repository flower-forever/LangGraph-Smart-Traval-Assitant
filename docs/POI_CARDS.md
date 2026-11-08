# P · 景点资料卡（本地、独立库）v1

日期：2026-11-08。三期 S2 切片。基线 `feat/interactive-travel-planner` @ `3fb3df0`。
计划来源：`C:\Users\86133\.opencode\plan\p3-poi-ui.md` §2；设计基线 `docs/UI_DESIGN.md`。

## 这是什么

用户手动整理的「景点资料卡」：介绍 / 开放时间 / 门票 / 图片（URL 引用）。
一张卡对应一个地点（名称+地址归一化后唯一），内容全部默认**未核实**，
展示时带来源与时间。资料卡是**独立逻辑库**，与工作区 / 候选库 / 版本库并列，
**永不自动写** Trip / 费用 / 候选库 / 任何工作区键。

明确不做：真实地图 / geocode、图片本地存储（只存 URL）、账号同步、
内置离线景点介绍库（防 AI 编造；内容真实性由来源标注兜底）。

## 数据契约（唯一权威：`frontend/src/lib/poiCards.ts`）

### 存储键

| 项 | 值 |
|---|---|
| 键 | `poiCards:v1`（常量 `POI_CARDS_STORAGE_KEY = 'travel-assistant:poi-cards:v1'`） |
| format | `travel-assistant.poi-cards` |
| version | `1` |
| 条数上限 | `MAX_POI_CARDS_COUNT = 200` |
| 整库字节上限 | `MAX_POI_CARDS_BYTES = 512 KiB`（紧凑 JSON 真实 UTF-8 字节） |
| intro 上限 | `MAX_POI_CARD_INTRO_LENGTH = 2000` 字 |
| 单卡图片上限 | `MAX_POI_CARD_IMAGES = 8`（仅 URL 引用） |

### PoiCardV1

```
{
  id: string                    // 随机逻辑 ID，非指纹
  identityKey: string           // 复用候选池 dedupeKey：normalize(name)+'|'+normalize(address)
  name: string                  // 1..120 字（沿用 MAX_CANDIDATE_NAME_LENGTH）
  intro: string                 // ≤2000 字；'' = 未填写
  openingHours: string          // ≤300 字；'' = 未填写（展示「未知」）
  ticket: string                // ≤300 字；'' = 未填写（展示「未知」）
  images: CardImageV1[]         // ≤8 张，URL 去重
  provenance: {                 // 逐字段来源；null = 无来源
    intro?, openingHours?, ticket?: { source, detail|null, recordedAt } | null
  }
  createdAt, updatedAt: number  // epoch ms；updatedAt ≥ createdAt
}
```

### CardImageV1

```
{
  url: string                   // http(s) 或本站相对路径；只存引用，绝不内嵌图片数据
  caption: string | null
  source: 'manual' | 'tavily' | 'osm' | 'wikimedia'
  attribution: string | null    // 作者署名（wikimedia 收进时保留）
  license: string | null        // 许可证（wikimedia 收进时保留）
  addedAt: number
}
```

### identityKey 规则

- 口径与候选池 `candidateDedupeKey` 完全一致：`normalizeCandidateText(name) + '|' +
  normalizeCandidateText(address)`（NFKC → trim → 空白折叠 → 小写）。
- **卡片本体不存地址**（契约字段清单没有 address）：地址只在创建 / 更新时经入参
  参与 identityKey 计算，之后随 key 固化；更新只改名称时，key 的地址段沿用旧值。
- 同一 identityKey 的重复卡拒绝（`duplicate_identity`）；重名不同址是两张。
- 存储校验钉住「key 名称段 == norm(当前 name)」：名称改了 key 必须跟着改，
  防止存储内容与归一化键脱钩。

## 语义红线（全部有测试钉住）

1. **显式保存才落盘**：编辑只在 `PoiCardPanel` 内存 state；点「保存资料卡」才经
   `onSave` → `savePoiCardsRecord` 写入。取消 / 关闭零写入。
2. **未保存编辑 reload 不复活**：没有任何自动写盘路径；reload 后内存态消失，
   存储里只有上次显式保存过的内容。
3. **永不自动写其它键**：数据层只碰 `poiCards:v1` 一个键（`grep` 可自查）；
   Trip / 候选库 / 版本库 / 工作区键零接触（测试断言 raw 前后一致）。
4. **内容默认「未核实」**：展示位一律带「未核实」badge + 来源（`SOURCE_LABEL`）+
   录入时间；未知显示「未知」，不补 0、不编造。
5. **文案红线**：无「已预订 / 已确认 / 已出票」；未知显示「未知」。
6. **图片仅存 URL**；渲染 `loading="lazy"` 懒加载；加载失败 → 占位 +
   「图片加载失败」，不阻断其余内容、不编造。
7. **无坐标字段**：PoiCardV1 没有任何坐标字段（无坐标可编造），也不出现 (0,0)。
8. **数据层零网络调用**：`poiCards.ts` 不 import `api.ts`、无 fetch/XHR；
   图片加载是渲染期浏览器行为，测试一律 mock（同 OSM 瓦片处理）。
9. **失败保旧**：校验失败 / 超限 / Quota / 冲突时旧记录与旧字节保持不变，
   不驱逐、不截断、不清洗覆盖。
10. **保存冲突检测**：`savePoiCardsRecord` 以 `expectedRaw`（冻结 raw）比对当前
    存储字节，不一致 → `conflict` 拒绝写（不覆盖其它入口的更新）。

## 存储行为（`loadPoiCardsRecord` / `savePoiCardsRecord`）

- 读取状态：`ok / empty / unavailable / corrupt / unknown_version`；
  `corrupt / unknown_version` 时拒绝普通写入，原字节不动，不自动迁移。
- 体积防护：raw 超过 `MAX_POI_CARDS_RAW_READ_BYTES`（上限 + 64 KiB）不再 JSON.parse。
- 写入：校验 → 序列化（计真实字节）→ 冻结 raw 比对 → 一次 `setItem`；
  成功才返回 `ok`。Quota / SecurityError 分别映射 typed failure。

## 纯 CRUD API（`frontend/src/lib/poiCards.ts`）

| 函数 | 说明 |
|---|---|
| `createEmptyPoiCardsRecord(now)` | 空记录 |
| `createPoiCard(input, now)` | 新建卡（不落盘） |
| `updatePoiCard(record, id, patch, now)` | 逐字段覆盖；identityKey 随 name/address 重算；撞车拒绝 |
| `removePoiCard(record, id, now)` | 删除 |
| `addPoiCard(record, card, now)` | 追加已构造的卡（S3 收进管道复用） |
| `addImageToPoiCard(record, id, image, now)` | 追加图片引用；URL 去重 + 张数上限 |
| `findPoiCardByName(record, name)` | 按名称归一化查找；0 / 多命中返回 null（不猜） |
| `validatePoiCardsRecord(value)` | 整条记录严格校验（未知字段拒绝） |
| `loadPoiCardsRecord(storage?)` / `savePoiCardsRecord(record, opts)` | 存储读写（仅这两处碰 localStorage） |

## 展示位（三处，均只读）

| 位置 | 组件 | 行为 |
|---|---|---|
| 行程停点展开 | `ItineraryList`（`.stop-poi-card`） | 停点展开时按名称归一化匹配；命中显示介绍/开放时间/门票 + 「未核实」+ 「按名称匹配，请自行核对」。0 / 多命中不显示。 |
| 候选池条目 | `CandidatePoolPanel`（`有资料卡` 徽标按钮） | 按名称归一化命中显示可点徽标；点击回调 `onOpenPoiCard(name)`，父级打开资料卡面板（无卡则新建态）。 |
| 助手提案卡 | `AssistantDialogPanel`（`有资料卡` 只读徽标） | 提案目标名命中时显示「有资料卡」徽标 + 说明文案；**不自动读取内容进提案**、不写任何键。 |

匹配提示固定文案：**「按名称匹配，请自行核对」**（名称归一化匹配不构成身份确认）。

## 面板（`frontend/src/components/PoiCardPanel.tsx`）

- shadcn 组件构建（`@/components/ui/*`：Card / Button / Input / Textarea / Badge /
  Field）；迁移期遵守 UI_DESIGN §2.4：不用 `bg-accent` / `bg-muted`（tokens.css
  同名冲突），用 `bg-muted-surface` 等别名类。
- 查看（已保存内容 + 来源 + 图片）与编辑（名称/介绍/开放时间/门票）同一面板；
  「保存资料卡」显式提交；「取消」/ 关闭零写入。
- 面板不读 localStorage；记录由父级（`App.tsx`）读取后经 props 传入。
- 图片编辑入口：S3「图片 URL 手动添加」+ S5「Wikimedia 搜索图片」子区均已
  落地；搜索只在显式点击时发一次请求，收进只进编辑内存态，显式保存才落盘。

## App 接线（最小侵入）

- 首次进入只读加载一次（`ensurePoiCardsLoaded`）；`poiCardsRecord` 作为 props
  分发到三个展示位。
- `poiCardOpenId: string | null | undefined`：undefined = 关闭，null = 新建，
  字符串 = 查看对应卡；关闭面板零写入。
- `handleSavePoiCards`：面板显式保存的唯一落盘通道（expectedRaw 冻结比对）。

## 测试

| 文件 | 覆盖 |
|---|---|
| `__tests__/poiCards.test.ts` | CRUD / 键独立性 / identityKey 归一化 / intro 限长 / provenance / 存储读写与冲突 / 零网络调用 |
| `__tests__/PoiCardPanel.test.tsx` | 显式保存才落盘 / 取消零写入 / 未保存不复活 / 文案红线 / 图片懒加载与失败占位 / 其它键 raw 不变 |
| `__tests__/ItineraryList.test.tsx`（追加） | 停点展开资料卡展示位 |
| `__tests__/CandidatePoolPanel.test.tsx`（追加） | 候选条目资料卡入口 |
| `__tests__/AssistantDialogPanel.test.tsx`（追加） | 提案卡「有资料卡」只读徽标 |

## S3 / S5 预留

- S5 Wikimedia：编辑器内「搜索图片」（显式触发）→ 逐张「收进」确认流
  （source=wikimedia，保留 attribution/license）。**已由三期 S5 落地**，
  契约与红线详见 `docs/IMAGE_SOURCES.md`「前端接线（三期 S5）」一节；
  测试见 `__tests__/PoiCardImageSearch.test.tsx`（显式触发 / 署名许可展示 /
  缺署名不收进 / 收进内存态→显式保存才落盘 / 失败逐状态文案 / 失败保旧）。

## 收进管道（三期 S3 已落地）

收进 = 来源面板点「收进资料卡」→ 打开**预填表单**（用户可改）→ 确认保存才落盘；
**不采纳（取消 / 关闭）零写入**；**不自动收进任何内容**：不点按钮不构造载荷、
不弹表单、不落任何数据。

### 两路来源

| 路 | 入口 | 预填 | provenance | 文案 |
|---|---|---|---|---|
| tavily | `WebSourcesPanel` 每条搜索摘要的「收进资料卡」 | intro = 标题+摘录（`collectPrefillFromWebResult`）；名称留空（来源无名称字段，用户必填）；开放时间/门票留空 | intro 标 `tavily` + detail=页面 URL；其余字段留空不标 | 「预填自 Tavily 网页搜索摘要，未核实；…不采纳则零写入」 |
| osm | `DayPoiSourcesPanel` 每条候选的「收进资料卡」 | opening_hours / fee / charge 标签原文 → 开放时间/门票（`collectPrefillFromPoiCandidate`；charge 优先于 fee；unknown 不预填）；名称用候选名 | openingHours/ticket 标 `osm` + detail=OSM 对象链接 | 「预填自 OpenStreetMap 公开标签，来自协作地图，未核实；…不采纳则零写入」 |

- 预填载荷契约：`frontend/src/lib/poiCardPrefill.ts`（`PoiCardPrefill`，纯类型零写路径）。
- 按名称归一化定位已有卡（App 层，`findPoiCardByName`）：唯一命中 → 打开该卡编辑态
  （已有字段不覆盖，用户自行核对合并）；0 / 多命中 → 新建预填态（**不猜**）。
- 预填表单复用 `PoiCardPanel` 编辑通道（`prefill` prop，仅新建态生效）：全部字段可改；
  用户补填的空字段保存时标 `manual`（「手工粘贴」）；用户改动过的预填字段保存时
  仍标原收进来源（tavily / osm）——收进语义不冒充官方核实。
- 取消按钮在收进态显示「不采纳，关闭」；两种关闭（取消 / 关闭 X）都丢弃预填零写入。

### 图片 URL 收进（manual / tavily）

- S2 图片区只读展示；S3 在编辑表单加「图片 URL」输入 + 「添加图片 URL」入口：
  仅存 URL 引用，不抓取、不转存；URL 去重、张数上限 8、非法格式拒绝。
- 收进态贴图来源按 `prefill.imageSourceHint` 标注：tavily 收进 → `source='tavily'` +
  attribution 标页面来源（标题或 URL）；手动新建 / 编辑 → `source='manual'`。
- Tavily 摘要信封没有图片字段（`WebSearchResult` 只有页面 URL，页面 URL 不是图片，
  不冒充图片预填）；OSM 公开资料同样无图片。Wikimedia 图片收进属 S5。
- 编辑已有卡补图走同一入口；`updatePoiCard` 不触碰逐字段 provenance（不编造来源）。

### 红线语义（收进管道专属补充，基线红线全部继续有效）

- 收进预填只是**内存表单初始化**：不写 `poiCards:v1`，更不写 Trip / 费用 / 候选库 /
  工作区键（测试断言 raw 逐字节不变）。
- 一切收进内容默认「未核实」+ 来源标注；OSM 路径显示「来自协作地图，未核实」；
  来源面板结果本身未变的文案（身份未确认 / 未核实）不受收进影响。
- 保存走 S2 同一通道（`handleSavePoiCards`，expectedRaw 冻结比对）；收进保存与
  手动保存无任何特权差异；冲突拒绝失败保旧。

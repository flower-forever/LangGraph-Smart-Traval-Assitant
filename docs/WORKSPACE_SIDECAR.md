# 工作区 sidecar 与三个逻辑库契约 v1

> 状态：**S1 公共契约阶段 + R1/C1 最小修订 + F5 constraintId 兼容（2026-11-06 01:10）**。
> 本文是唯一权威；代码中的 `frontend/src/lib/workspaceTypes.ts` / `workspace.ts` /
> `workspaceFingerprint.ts` 与本文同步。**`workspaceStorage.ts`、恢复模块、后端 F2
> 实现不在本阶段交付**；本文只定契约与可测纯函数，不声称这些能力已经落地。
>
> 适用基线：`F:/MunderDifflin/Travel-Assistant/LangGraph-Smart-Traval-Assitant`。
> 契约起草时 HEAD 为 `2cc9d60b7972793975523b4d3778ef6e877109b3`；S1 公共契约已
> 提交到 `2341be4adecd7b8e1b4a3ae38c35edb2198af3d8`（feature/main CI 绿）。本批只
> 增加 checklist 兼容字段，不改 Trip v1、旧备份格式、旧会话恢复 v1 读取语义或任何
> 既有 UI。

---

## 0. 权威、边界与非目标

- 公共契约只有一个 owner；六个 feature **不得各自发明 schema**。新增字段先改本文与
  `workspaceTypes.ts`，再由各 feature 消费。
- 单个权威工作区记录 = **Trip v1 + sidecar + 手工预算快照 + owner/revision/meta**。
  不存在「只存 sidecar、不存 Trip」的工作区记录。
- 三个**独立逻辑库**：工作区、候选库、版本库。各自显式备份 / 导入；**不做跨库事务**，
  **不声称跨库原子恢复**。
- 候选库与版本库的增删改**不触碰工作区记录**；工作区记录的保存**不触碰**候选库 / 版本库。
- 本契约不引入数据库、登录、云同步、实时服务；不把数据塞进 `warnings` / `summary`
  等 Trip 既有字符串字段。
- Trip v1 的字段集合保持不变；`checkTripShape`（`savedTrips.ts`）仍是 Trip 载荷
  唯一门禁。sidecar 数据不进入 Trip。
- **未知字段**：新结构（workspace / sidecar / anchors / constraints / checklist /
  applies / candidates / versions / backups）一律拒绝；**builder 白名单投影**与
  **validator 拒未知**是两套分开的机制，不做「丢掉字段来消除差异」。
- **数组语义顺序**：`applies`、约束、清单、版本等数组保持调用方给出的顺序；
  canonical JSON 只排序对象键，**不排序数组**，不为指纹改变 anchor / visit 顺序。
- **null 不是 0**：时间、停留、坐标、预算缺失都用 `null` 表达；`0` 只在真实为零时使用。
- **不做浏览器指纹**：`ownerId` / `workspaceId` 是随机逻辑 ID；短 hash 只作索引 / 显示。
- 本阶段**不写** `workspaceStorage.ts`、恢复实现、`api.ts` / Trip 类型、共享 App、
  `backend/**` 实现；这些由后续存储 owner / F2 后端唯一 writer 按本文实现。

---

## 1. 已核对的真实事实（不是推测）

| 事实 | 位置 / 值 |
|---|---|
| 仓库 HEAD（契约起草） | `2cc9d60b7972793975523b4d3778ef6e877109b3` |
| 当前工区 HEAD | `426fb4b221a1aa33bdc8eec37b68bf9634f67454`（仅旧 UI / E2E 7 文件；未触及本契约事实） |
| 旧 Trip 结构 | `frontend/src/lib/api.ts` 的 `Trip / TripDay / TripStop / TripLeg`；无 sidecar 字段 |
| Trip 结构门禁 | `savedTrips.checkTripShape`；单份 640 KiB（`MAX_SAVED_TRIP_BYTES`） |
| 旧保存列表 | `travel-assistant:saved-trips:v1`，保留不动 |
| 会话恢复 v1 | `travel-assistant:session-resume:data:v1`；envelope `{format, version:1, savedAt, session:{trip,draft,budget,ui}}`；顶层与 session 内未知键都 `invalid`；flag 关闭不读内容键 |
| 预算行 | `tripBudget.ts`：最多 32 行；金额是用户原字符串；`0.10 + 0.20 = 0.30` |
| 草稿 | `tripDraft.ts`：不生成 id，fork / stop id 由调用方提供；单日最多 100 站（前端结构上限） |
| 旧 Trip JSON | `tripTransfer.ts` / `tripFile.ts` 保留；**当前不会自动挂接 sidecar** |
| 后端初始规划模型 | `backend/travel_itinerary.py` 的 `TripPlanRequest`：`extra="ignore"`，destination ≤80，days 1..7，travelers 1..50，preferences ≤500 |
| 后端单日 replan 模型 | `backend/day_replan.py` 的 `DayReplanRequest`：`extra="forbid"`，instruction ≤500，stops ≤8，day 1..7，parent `{trip_id, revision}` |
| 后端 replan 响应 | `DayReplanResponse`：`{day,warnings,map_status,parent,source}`；`parent` 只回显；`extra="forbid"` |
| 后段 replan | 复用 `POST /api/trips/days/replan`（`dayReplanTail.ts` 用组合 instruction 构造同一请求），**没有**独立端点 |
| map-refresh / leg-refresh | 各自 request 模型 `extra="forbid"`；本契约**不给它们加** constraints 字段 |

> 注意：计划原文假设初始规划 request 也 `extra="forbid"`；实际是
> `extra="ignore"`。这是真实差异，本契约按实际行为定案（见 §11.4），
> 不把「未知字段 422」错误地套到初始规划上。

---

## 2. 常量（唯一实现：`workspaceTypes.ts`）

### 2.1 键

| 常量 | 值 | 含义 |
|---|---|---|
| `WORKSPACE_STORAGE_KEY` | `travel-assistant:workspace:v1` | 单个权威工作区记录 |
| `CANDIDATES_STORAGE_KEY` | `travel-assistant:workspace:candidates:v1` | 候选库 |
| `VERSIONS_STORAGE_KEY` | `travel-assistant:workspace:versions:v1` | 版本库 |
| 旧 `KEY_SESSION_FLAG` | `travel-assistant:session-resume:enabled:v1` | 旧会话恢复开关，语义不变 |
| 旧 `KEY_SESSION_DATA` | `travel-assistant:session-resume:data:v1` | 旧会话恢复内容键，语义不变 |
| 旧 `KEY_SAVED_TRIPS` | `travel-assistant:saved-trips:v1` | 旧保存列表，保留不动 |

> **命名对照（重要，避免六线猜名）**：计划中的 `KEY_WORKSPACE` / `KEY_CANDIDATES` /
> `KEY_VERSIONS` 是**逻辑名**；代码实际导出为 `WORKSPACE_STORAGE_KEY` /
> `CANDIDATES_STORAGE_KEY` / `VERSIONS_STORAGE_KEY`。同理旧会话键导出为
> `SESSION_RESUME_FLAG_KEY` / `SESSION_RESUME_DATA_KEY`。feature 代码按**实际导出名**
> import，不要自行定义同值字符串。

### 2.2 容量

| 常量 | 值 | 作用 |
|---|---|---|
| `MAX_WORKSPACE_RECORD_BYTES` | `2 097 152`（2 MiB） | 整条工作区记录 |
| `MAX_WORKSPACE_SIDECAR_BYTES` | `524 288`（512 KiB） | 记录内 sidecar 段 |
| `MAX_CANDIDATES_BYTES` | `262 144`（256 KiB） | 候选库整库 |
| `MAX_CANDIDATES_COUNT` | `200` | 候选条数 |
| `MAX_VERSIONS_COUNT` | `10` | 版本个数 |
| `MAX_VERSIONS_TOTAL_BYTES` | `4 194 304`（4 MiB） | 版本库整体 |
| `MAX_VERSION_SNAPSHOT_BYTES` | `2 097 152`（2 MiB） | 单个版本快照 |
| `MAX_WORKSPACE_BACKUP_FILE_BYTES` | `2 097 152`（2 MiB） | 工作区备份文件 |
| `MAX_CANDIDATES_BACKUP_FILE_BYTES` | `524 288`（512 KiB） | 候选库备份文件 |
| `MAX_VERSIONS_BACKUP_FILE_BYTES` | `8 388 608`（8 MiB） | 版本库备份文件 |
| 既有 `MAX_SAVED_TRIP_BYTES` | `655 360`（640 KiB） | 单份 savedTrip 记录；工作区 / 版本快照仍按 `savedTripRecordBytes` 口径遵守 |
| 既有 `MAX_SAVED_STORAGE_BYTES` | `1 572 864` | 旧保存列表，不变 |
| 既有 `MAX_SESSION_RESUME_BYTES` | `1 572 864`（+64 KiB raw 读上限） | 会话恢复，不变 |

**字节口径**：容量按**实际要写入的紧凑 JSON 字符串**的 UTF-8 字节计算
（`utf8ByteLength(JSON.stringify(value))`），不是 UTF-16 字符数；中文、emoji 按真实
UTF-8 字节计。`workspace.ts` 的 `measure*` / `check*Limits` 使用同一口径。
`checkWorkspaceRecordLimits` / `checkVersionSnapshotLimits` 里的 Trip 容量用既有
`savedTripRecordBytes(trip)`，即 `{id,savedAt,trip}` 的紧凑 JSON 字节，不是只算
`trip` 字段；这与旧保存列表的门禁一致。
**容量是最大允许，不是浏览器 quota 保证**；超限 / QuotaExceeded → 失败并保留旧字节，
**绝不自动驱逐旧数据**。

### 2.3 新结构字段上限

| 常量 | 值 | 说明 |
|---|---|---|
| `MAX_WORKSPACE_ID_LENGTH` | 200 | 逻辑 ID / 引用 ID |
| `MAX_WORKSPACE_LABEL_LENGTH` | 200 | 工作区标签 |
| `MAX_ANCHOR_NAME_LENGTH` | 120 | 每日锚点名称 |
| `MAX_ACCOMMODATION_NAME_LENGTH` | 300 | 住宿名称 |
| `MAX_TRANSPORT_NAME_LENGTH` | 300 | 抵离名称 |
| `MAX_ANCHOR_ADDRESS_LENGTH` | 300 | 锚点地址 |
| `MAX_ANCHOR_DAY` | 366 | sidecar 天序号上限；Trip 自身 `checkTripShape` 最多 31 个 day，day 编号 1..366 |
| `MAX_CONSTRAINT_ITEMS` | 24 | 工作区约束条数 |
| `MAX_CONSTRAINTS_BYTES` | 16384（16 KiB） | F2 发送后端的 constraints 紧凑 UTF-8 上限；不是整条 sidecar 上限 |
| `MAX_CONSTRAINT_TITLE_LENGTH` | 120 | 约束标题 |
| `MAX_CONSTRAINT_NOTES_LENGTH` | 500 | 约束备注（只存本地 / 不进后端 prompt） |
| `MAX_CONSTRAINT_PRIORITY` | 3 | 0..3 |
| `MAX_BUDGET_RAW_LENGTH` | 1000 | 手工预算总额原文 |
| `MAX_BUDGET_ROW_NAME_LENGTH` | 200 | 预算行名称 |
| `MAX_BUDGET_AMOUNT_RAW_LENGTH` | 1000 | 预算行金额原文 |
| `MAX_CHECKLIST_ITEMS` | 300 | 清单项数 |
| `MAX_CHECKLIST_TITLE_LENGTH` | 200 | 清单标题 |
| `MAX_CHECKLIST_NOTES_LENGTH` | 1000 | 清单备注 |
| `MAX_APPLIED_TEMPLATES` | 50 | 已采纳模板 id 数 |
| `MAX_TEMPLATE_ID_LENGTH` | 100 | 模板 id |
| `MAX_APPLY_LINKS` | 1000 | 候选使用关系数 |
| `MAX_CANDIDATE_NAME_LENGTH` | 120 | 候选名称 |
| `MAX_CANDIDATE_ADDRESS_LENGTH` | 300 | 候选地址 |
| `MAX_CANDIDATE_NOTES_LENGTH` | 500 | 候选备注 |
| `MAX_CANDIDATE_TAGS` | 20 | 候选标签数 |
| `MAX_CANDIDATE_TAG_LENGTH` | 50 | 单个标签长度 |
| `MAX_CANDIDATE_PRIORITY` | 3 | 0..3 |
| `MAX_VERSION_NAME_LENGTH` | 200 | 版本名 |
| `MAX_SAFE_WORKSPACE_REVISION` | `2^53-1` | revision / epoch 上限 |

> `MAX_ANCHOR_DAY=366` 是 sidecar 数据结构上限，**不是** Trip 天数上限：Trip
> `checkTripShape` 最多 31 个 day，day 编号 1..366。**后端规划**又只有 7 天
> （`MAX_DAYS=7`）。F2 的 backend 请求只覆盖 1..7 天；超过 7 天的行程不能走初始 /
> replan 后端通道，见 §11。

---

## 3. 数据模型（`workspaceTypes.ts` 为代码权威）

### 3.1 完整工作区记录

```ts
interface WorkspaceRecordV1 {
  format: 'travel-assistant.workspace'
  version: 1
  workspaceId: string            // 随机逻辑 ID，不是浏览器指纹
  ownerId: string                // 随机逻辑 ID，不是浏览器指纹
  tripId: string                 // 必须 === trip.id
  trip: Trip                     // Trip v1 原样；不扩字段
  sidecar: WorkspaceSidecarV1
  budget: BudgetSnapshotV1 | null // null = 明确没有预算数据，不补 0
  workspaceRevision: number      // 单调，安全整数；绝不回放旧值
  updatedAt: number              // epoch ms
  meta: WorkspaceMetaV1
}

interface WorkspaceMetaV1 {
  createdAt: number              // 创建后不变
  label: string | null
}
```

- 工作区只绑定**一个** Trip；`tripId !== trip.id` 直接拒绝。
- `format` / `version` 必须精确匹配；未知版本 → `unknown_version`（保留原字节）。
- `updatedAt` / `meta.createdAt` 是正整数安全整数；模块不读时钟，时间由调用方传入。
- Trip 使用 `checkTripShape`；Trip 的宽字段兼容由既有门禁决定（本契约不往里加字段，
  也不另造一套 Trip 校验）。

### 3.2 sidecar

```ts
interface WorkspaceSidecarV1 {
  anchors: AnchorsV1
  constraints: ConstraintsV1
  checklist: ChecklistV1
  applies: ApplyLinkV1[]
}
```

sidecar 段 UTF-8 ≤ 512 KiB；整条记录 ≤ 2 MiB。数组顺序是语义顺序，不排序。

#### F1：住宿与抵离锚点

```ts
interface AnchorsV1 {
  accommodation: AccommodationAnchorV1 | null
  daily: Record<string, { start: DayAnchorV1 | null; end: DayAnchorV1 | null }>
  arrival: TransportAnchorV1 | null
  departure: TransportAnchorV1 | null
}

interface AccommodationAnchorV1 {
  hotelId: string | null
  name: string | null
  address: string | null
  location: { lng: number; lat: number } | null // null = 未知；绝不写 (0,0) 冒充
  locationSource: 'user_provided' | null
  checkInDate: string | null  // YYYY-MM-DD
  checkOutDate: string | null
}

interface DayAnchorV1 {
  anchorId: string
  kind: 'stop' | 'manual'
  stopId: string | null   // kind='stop' 必填；kind='manual' 必须为 null
  hotelId: string | null  // 地点实体 identity，可与 stopId 不同
  name: string
  address: string | null
  location: { lng: number; lat: number } | null
  time: string | null     // HH:MM
  date: string | null     // YYYY-MM-DD
}

interface TransportAnchorV1 {
  kind: 'airport' | 'station' | 'other'
  name: string
  date: string | null
  time: string | null
  location: { lng: number; lat: number } | null
}
```

规则：

- `daily` 的 key 是 Trip 的**规范十进制天序号**（`'1'`..`'366'`，不接受 `'01'`）；
  没有锚点的天**省略 key**；`{start:null,end:null}` 是无意义条目，拒绝。1..366 是
  结构上限，**是否对应当前 Trip 的某一天由 F1 apply 门检查**（结构 validator 不读
  Trip days）。
- `kind='stop'`：只 link 已有 stop，`stopId` 必填；不复制、不改 stop id。
- `kind='manual'`：`stopId` 必须为 null；手工锚点不冒充已有 stop。
- `hotelId` 是**实体** identity，可跨多个 visit 共享；`stopId` 是**一次停靠 occurrence**。
  同一酒店做首站和末站 → 两个独立 `DayAnchorV1` / 两个独立 stop occurrence id；
  次日再次入住 → 新的 occurrence id。**已有 stop 只 link，不 duplicate、不改冻结 id。**
- 坐标：`null` = 未知；只有用户自己填写真实坐标才是 `locationSource:'user_provided'`；
  有坐标无 source、或有 source 无坐标都拒绝。校验不把 `(0,0)` 当作未知哨兵——
  是否真实坐标由用户输入决定；**builder / UI 不允许用 `(0,0)` 表示未知**。
- 日期 / 时间：严格 `YYYY-MM-DD`（真实日历日）与 `HH:MM`（24 小时制）；未知用 null。
  `checkInDate > checkOutDate` 是 F1 的业务 typed 拒绝（结构 validator 只检查日期真实）。
- 锚点**不自动进入 Trip、不自动重排站点、不自动生成 stop**。occurrence 的生成属于
  F1 的草稿 / 预览 / 显式 apply 流程；必须过 `checkTripShape` 与 id 冲突门。
- `arrival` / `departure` 只是首 / 末日参考；缺时间 / 缺坐标是「缺信息」，不阻断。
- 文案只能说「你填写的住宿信息」，**不得说「已预订 / 已确认」**。

#### F2：必去点与预约时间约束

```ts
type ConstraintKindV1 = 'must_visit' | 'fixed_window' | 'reminder'

interface ConstraintItemV1 {
  id: string
  kind: ConstraintKindV1
  title: string
  day: number | null          // 1..366；must_visit 必填
  stopId: string | null       // null = 尚未落 Trip 的目标实体；非 null 由 scope 层核目标日
  startDate: string | null    // YYYY-MM-DD
  endDate: string | null
  startTime: string | null    // HH:MM，行程当地时刻
  endTime: string | null
  durationMinutes: number | null // null = 未知；0 = 已知零
  notes: string | null
  priority: number            // 0..3
  updatedAt: number
}

interface ConstraintsV1 { items: ConstraintItemV1[] }
```

规则：

- `must_visit`：`day` + `title` 必填；`stopId` 可为 null，表示**尚未落 Trip 的初始目标
  实体**，用规范化 title + day 表达，不能伪造 stop id。`stopId` 非 null 时由
  `validateConstraintsForScope` 在 scope 层要求它存在于指定日；适合 day/day_tail 的
  既有 stop。`trip_plan` 没有 request.stops，所有约束的 `stopId` 必须为 null。
- `fixed_window`：完整起止 = `startDate + endDate + startTime + endTime` 全部已知且日期
  真实；只有完整时才可声称**硬验证通过**。任一必要端为 null → **U 级**，不得声称满足。
- `reminder`：只提醒，不阻断。
- **H 级（直接禁 apply，用户不可 override 硬冲突）**：`must_visit` 已知目标缺失 / 目标
  stop 不在指定日 / 已被删；`fixed_window` 绑定的 stop 被删；已知结束下界明确晚于后续
  `fixed_window` 开始。H 级只能改行程或改约束，不能靠确认绕过。零命中已知目标 = H；
  同名多站 / 多义 / 坐标相悖 = U，不得 silent 选第一个。
- **U 级（任一必要端未知）**：不得声称「已满足」；apply 前必须有独立确认
  （§5.3），确认绑定 owner / revision / 完整 constraints / scope / epoch。目标匹配、
  H/U 判定属于 F2 适配层（§11.7），不是结构 validator。`09:00` 占位时间 /
  `_time_origins.placeholder` / `durationMinutes=null` 都不是已知证据，不能报 H。
- `endDate` 存在时 `startDate` 必须存在；`endTime` 存在时 `startTime` 必须存在；
  **不把缺失开始日期猜成当天、不把缺失开始时刻猜成 0 点**。
- 跨日窗口用显式 `startDate` / `endDate` + 日内时间按日历区间判断；**不把酒店连住
  误当跨日景点预约**。无时区信息时只用行程记录的当地日期 / 时刻，**不用浏览器时区
  隐式转换**，不扩跨时区机票服务。
- 结构 validator **不**检查 stop 是否仍存在；scope/binding 层的
  `validateConstraintsForScope` 对非 null `stopId` 检查目标日存在性。结构上允许
  dangling `stopId` 以便读出旧数据，但 `trip_plan` 一律要求 null，day/day_tail 绑定
  时不存在即 `invalid_field`；apply 仍要报 H / stale。
- 删除 / 修改约束只改 `sidecar.constraints`，**不级联删除清单**；F5 通过清单项的
  `constraintId` 发现 needsRelink，不能按同名 / 相同日期自动重绑；只有用户显式解除
  关联才清空。清单的 stop/day/date 关联与预约关联相互独立。
- 约束条数 ≤ 24；F2 发后端前另有 16 KiB payload 上限（见 §11）。
- `durationMinutes: null` 与 `0` 语义不同；任何 null 都不补 0。
- `09:00` 可能是后端 `_time_origins=placeholder` 的占位值；本契约只保存原值，不能
  据此声称时间已知。H 只接受真实已知证据，U 不得补 0。

#### F5：出行准备清单

```ts
type ChecklistCategoryV1 = 'ticket' | 'appointment' | 'document' | 'luggage' | 'todo'

interface ChecklistItemV1 {
  id: string
  category: ChecklistCategoryV1
  title: string
  done: boolean
  date: string | null
  day: number | null
  stopId: string | null
  originalStopId: string | null // stop 被删 / 解绑后保留最后一次已知 id
  constraintId?: string | null // 缺省 = 旧 v1 未记录；null = 明确未关联
  notes: string | null
  updatedAt: number
}

interface ChecklistV1 {
  items: ChecklistItemV1[]
  appliedTemplates: string[] // 已逐条采纳的模板 id，去重
}
```

规则：

- `done:true` 只表示「已准备 / 已核对」，**不等于已预订、已出票或已确认**；文案固定
  用「已准备 / 未准备」。
- 删除被引用的 stop：条目**不删除**；`stopId=null`，`originalStopId` 保留原 id，
  `notes` 追加「需重新关联」提示（由 F5 写）；结构 validator 允许 dangling 引用。
- `constraintId` 是**可选已知字段**：旧 v1 缺省合法，读取 / 重写不得自动补 `null`，
  旧 raw / canonical 不变；显式 `null` = 明确未关联。非 null 时复用
  `ConstraintItemV1.id` 的规则（1..200 字符、非空白），不得另造格式。
- 关联存在性不在结构 validator：删除 / 修改约束后条目**不删除、不整条损坏**；保留
  可能 dangling 的 `constraintId`，由 F5 audit 结合当前 constraints 显示 needsRelink。
  **不得**按同名 / 相同 date/day 自动重绑；只有用户显式 unlink 才写 `null` 或移除。
  stop/day/date 关联与预约关联独立，拷贝日期或站点不等于建立关联。
- `constraintId` 必须经 `createWorkspaceRecord` / `validateWorkspaceRecord` / 版本 /
  workspace 与 versions 备份路径原样保留（含显式 `null`）。旧 reader 不支持该新字段时
  按既有严格策略 fail closed、保留原 bytes；**不声称旧程序能读新字段**。
- F6 导出按当前有效清单状态显示；`constraintId` dangling / 未关联时只能显示
  「需重新关联」，不得写成「预约已确认」。
- 模板只产生**未勾选**建议；不自动写入，需逐条采纳；`appliedTemplates` 只记录已采纳。
- 清单最多 300 项；`done` / 清单状态不进 Trip。
- 清单段损坏不得牵连 Trip；工作区导入 / 备份覆盖清单（见 §6 / §7）。

#### F3：候选使用关系

```ts
interface ApplyLinkV1 {
  candidateId: string
  tripId: string
  day: number
  stopId: string
}
```

`applies` 存在工作区 sidecar，**不放进候选库**。删除候选只删候选；Trip 点与 `applies`
保留，UI 对指向已删候选的 link 标「候选已删除」。同一 `(candidateId,tripId,day,stopId)`
重复 → `duplicate_id`。最多 1000 条。

#### 手工预算快照

```ts
interface BudgetSnapshotV1 {
  budgetRaw: string          // 用户原字符串，空 / 非法也保留
  rows: BudgetRowInput[]     // tripBudget.ts 的 id/category/name/amountRaw
}
```

- `budget:null` = 明确没有预算数据；`emptyBudgetSnapshot()` = 明确空预算（`budgetRaw:''`,
  `rows:[]`）。两者不同，不互相替代。
- 只保存输入，不保存派生合计；金额精度仍由 `tripBudget.ts` 处理。
- 行数 ≤ 32（既有 `MAX_BUDGET_ITEMS`）；不解析 / 不补 0 / 不改写原字符串。

### 3.3 候选库

```ts
interface CandidateItemV1 {
  id: string
  name: string
  address: string | null
  notes: string | null
  tags: string[]             // 区域标签，去重
  priority: number           // 0..3
  location: { lng: number; lat: number } | null // null = 未知；不得用 (0,0) 冒充
  source: 'manual' | 'copied'
  copiedFromStopId: string | null // copied 必填；manual 必须 null
  createdAt: number
  updatedAt: number          // >= createdAt
}

interface CandidatesRecordV1 {
  format: 'travel-assistant.workspace.candidates'
  version: 1
  items: CandidateItemV1[]
  updatedAt: number
}
```

- `source` 只允许 `manual` / `copied`；UI 必须标「未核实」，不是 verified。
- 从既有 stop 复制：名称 / 地址 / 坐标带过来；原 stop 坐标为 null → 候选仍 null；
  不 geocode、不补 (0,0)。
- 去重提示（F3 业务）`dedupeKey = normalize(name) + '|' + normalize(address)`；命中只
  提示两条，不自动合并 / 覆盖。
- 候选库独立键；写入不触碰 `KEY_WORKSPACE`；删除候选不删 Trip 点。
- 容量：200 条 / 256 KiB；超限明确失败，不驱逐；独立备份 / 导入见 §7。

### 3.4 版本库

```ts
interface VersionSnapshotV1 {
  id: string
  name: string
  createdAt: number
  workspaceRevision: number   // 只记录快照当时值；绝不用于恢复
  trip: Trip                  // 完整 Trip v1
  sidecar: WorkspaceSidecarV1
  budget: BudgetSnapshotV1 | null // null = 明确无预算；不套用当前预算
}

interface VersionsRecordV1 {
  format: 'travel-assistant.workspace.versions'
  version: 1
  items: VersionSnapshotV1[]
  updatedAt: number
}
```

- 版本一经保存即不可变；读取只解析，不改旧快照。
- 采用版本 = 用 `commitWorkspaceTransition` 一次换 Trip + sidecar + budget；
  `workspaceRevision = 当前值 + 1`，**绝不恢复快照里的旧 revision**；撤销也 +1。
- 快照的 `trip.id` 必须与当前工作区 `tripId` 相同才能采用；否则是另一个行程，
  明确拒绝，不静默换工作区。
- 快照里的额外 / 当前工作区有但快照没有的约束等条目，由 F4 列入「需重新确认」，
  不静默套用、不静默丢弃。
- 快照 sidecar 原样保留 checklist 的可选 `constraintId`（含显式 `null`）；旧快照缺省
  不补 `null`，旧 reader 不支持该新字段时 fail closed、保留原 bytes。
- 版本数 10 / 总量 4 MiB / 单快照 2 MiB；超限明确失败，不驱逐旧版本。
- 版本库独立键；写入不触碰工作区 / 候选库。

---

## 4. 校验、canonical 与 ID

### 4.1 校验分层

- `validateWorkspaceRecord`：严格对象键、Trip 通过 `checkTripShape`、`tripId===trip.id`、
  sidecar / budget / meta 校验、Trip ≤640 KiB、sidecar ≤512 KiB、整条 ≤2 MiB。
- `validateWorkspaceSidecar`：严格 sidecar 结构 + sidecar 字节上限。
- `validateAnchors` / `validateConstraints` / `validateChecklist` / `validateApplyLinks`：
  子结构校验；`constraints` / checklist 的条数上限在此执行。
- `validateCandidatesRecord` / `validateCandidateItem`：候选结构 + 200 条 / 256 KiB。
- `validateVersionSnapshot` / `validateVersionsRecord`：快照 / 版本库结构 + 2 MiB /
  10 个 / 4 MiB。
- `validateWorkspaceBackup` / `validateCandidatesBackup` / `validateVersionsBackup`：
  独立 envelope + 内部库校验 + 文件字节上限；导入层还可传 `rawBytes`（实际文件字节）。
- 所有失败返回 `WorkspaceValidationFailure`：`{ok:false, reason, path, message}`；
  `reason` 包括 `not_object / missing_field / unknown_field / invalid_field /
  invalid_trip / duplicate_id / limit_exceeded / unserializable`。
- **未知字段在每个声明的对象层拒绝**（record、meta、sidecar、anchors、accommodation、
  daily entry、day anchor、transport、constraints、constraint item、checklist、
  checklist item、apply link、budget、budget row、candidate、candidate record、
  version snapshot、versions record、三个 backup envelope、owner/binding/ack）。
- 旧 v1 兼容例外：`ChecklistItemV1.constraintId` 是可选的**已知**字段，缺省合法；这
  不是放宽 unknown field，其它未声明字段仍拒绝。validator 不得把缺省自动补 `null`。
- `Trip` 例外说明：Trip 是既有 v1 数据模型，唯一门禁是 `checkTripShape`；本契约不
  另造 Trip 的严格投影，也不因为 Trip 既有宽字段而拒绝整个工作区。**新结构**仍然
  拒未知字段。

### 4.2 canonical JSON

`workspaceFingerprint.canonicalJson(value)`：

- 普通对象键按 UTF-16 code unit 升序；**数组顺序保持**。
- 只接受 JSON 值：null / boolean / string / 有限 number / array / plain object。
- `undefined`、函数、Symbol、BigInt、NaN、Infinity、循环引用、Date / Map / class 实例
  一律失败；不调用 `toJSON`，不静默丢掉 undefined。
- `-0` 输出 `0`；字符串由 `JSON.stringify` 转义。
- 失败返回 `{ok:false, reason, path, message}`；owner / hash 比较必须 fail closed。

### 4.3 短指纹

- `shortFingerprint(text)` = FNV-1a 32-bit over UTF-8 bytes，8 位小写十六进制。
- **只作索引 / 显示 / 快速排除**；碰撞客观存在；**不承诺「任一字段变化必变」**。
- `fingerprintsMatch(a,b)` 只有完整 `canonical` 文本相等才为 true；short 只用于快速
  排除。owner 判定永远看完整 canonical + identity + revision + epoch。

### 4.4 ID

- `ownerId` / `workspaceId` / `hotelId` / `anchorId` / candidate id / version id 都是
  调用方提供的随机逻辑 ID；`createLogicalId()` 与 App 既有 `newUuid()` 语义一致
  （优先 `crypto.randomUUID`，否则随机串），**不采集浏览器 / 设备信息**。
- 纯 feature 模块优先接受调用方传入的 id（方便测试与统一撤销）。
- 引用既有 stop 的 id 可能是旧数据（最多 200 字符）；F1 生成酒店 occurrence 时必须
  遵守既有 id 唯一规则，**不改已有 stop 的冻结 id**。
- 清单 `constraintId` 复用 `ConstraintItemV1.id` 的 1..200 / 非空白规则；它是弱引用，
  允许指向已删除约束（dangling），由 F5 audit 提示 needsRelink，不自动重绑。

---

## 5. owner / revision / epoch

### 5.1 权威判定四件套

1. **完整 canonical JSON 快照**（内容全文，不是 hash）；
2. **对象 identity**：`ownerId + workspaceId + tripId`（candidate / version 还带自己的 id）；
3. **revision**：`workspaceRevision`，单调，当前值 +1，绝不回放；
4. **单调 epoch**：组件级，换 owner / 换 base / 换候选即推进。

`WorkspaceOwnerV1` 是完整 owner token：

```ts
interface WorkspaceOwnerV1 {
  ownerId: string
  workspaceId: string
  tripId: string
  workspaceRevision: number
  epoch: number
  snapshot: { canonical: string; short: string } // 整条记录的 canonical
}
```

`createWorkspaceOwner(record, epoch)` / `workspaceOwnerMatches(owner, record, epoch)`。
short 不参与匹配。

#### 5.1.1 运行期引用门（C1，强制义务）

上面的公共 helper 只比较 **canonical 内容 + 逻辑 ID（ownerId/workspaceId/tripId）+
revision + epoch**；它们**不持有 actual object refs**。因此：

- 同一内容换一个 JS 对象引用仍可能匹配（P1）；
- 在未推进 epoch 的情况下原地 A-B-A 回原内容也可能匹配（P2）。

**纯内容 helper 不能单独被宣称为完整 owner 授权，也不能用“内容相同”豁免旧候选 /
旧请求不复活。** 运行期必须额外做：

1. **capture**：发起 AI / apply / adopt / undo / import 预览时，保存实际
   `record` / `trip` / `sidecar` / `budget` 以及适用的 `candidate` / `version` / `input`
   对象引用（`captureWorkspaceRuntime`）。
2. **confirm 双门**：先用 `workspaceRuntimeRefsMatch` 检查
   `captured.record === currentRecord`、其 trip / sidecar / budget / 适用对象引用相等，
   且 **safe epoch 相等**；**之后**才用 `workspaceOwnerMatches` /
   `constraintsBindingMatches` 等做内容 / identity / revision 匹配。
3. **epoch 推进**：每次用户编辑、切换工作区 / 候选 / 版本、采用、撤销、导入、外部
   storage 变化，都必须推进对应 epoch；**即使内容 A-B-A 恢复相同，也不能复用旧
   pending**。old request 的 `finally` 在清理 pending 前必须核对当前 epoch，不能把
   新 pending 清掉。
4. **不序列化引用**：actual refs 只存在运行时内存；持久 identity 的逻辑 ID **不等于**
   JS 对象引用，不能写进 storage / backup / session payload。
5. **不可原地突变**：未观察到的原地字段变更，公共 helper 无法神奇发现；禁止外部原地
   修改，`commitWorkspaceTransition` 必须返回新对象，组件必须发事件通知。
6. `captureWorkspaceRuntime` / `workspaceRuntimeRefsMatch` 只是引用门工具，**不会自动
   推进 epoch**；推进 epoch 仍是调用方（F2 / F4 / 集成 owner）的强制职责。

### 5.2 F2 候选绑定

```ts
type PlanScopeV1 =
  | { scope: 'trip_plan'; day: null; anchorStopId: null }
  | { scope: 'day'; day: number; anchorStopId: null }
  | { scope: 'day_tail'; day: number; anchorStopId: string }

interface ConstraintsBindingV1 {
  owner: WorkspaceIdentityV1       // ownerId/workspaceId/tripId/revision
  constraints: { canonical: string; short: string } // 完整约束 canonical
  planScope: PlanScopeV1
  epoch: number
}
```

- 候选产生时记录；`constraintsBindingMatches(binding, record, currentConstraints, epoch)`
  要求 identity / revision / 完整 constraints canonical / planScope / epoch 全部一致。
- **binding 内容匹配不是 apply 的全部授权**：必须先过 §5.1.1 的运行期引用门 + epoch
  门，再用 binding 内容匹配；任何采用 / 撤销 / 导入 / 外部变化都推进 epoch，旧候选
  即使内容相同也不得复活。
- 任何 Trip / sidecar / budget 的成功 transition 都使 `workspaceRevision+1`，因此旧
  候选失效；不需要也不允许用短 hash 单独证明。
- `day_tail` 的 `anchorStopId` 必须是目标日已有 stop；scope 与当前 Trip 不符即失效。
- **不使用 response 里的自报字段当权威**（见 §11.6）。

### 5.3 U 级确认

```ts
interface UnverifiedConstraintsAckV1 {
  ownerId: string
  workspaceId: string
  tripId: string
  workspaceRevision: number
  constraints: { canonical: string; short: string }
  planScope: PlanScopeV1
  epoch: number
  acknowledgedAt: number
}
```

`createUnverifiedConstraintsAck` / `unverifiedConstraintsAckMatches`。U 级（含未核实
时间）方案 apply 前必须出现独立确认；确认绑定当前 owner / revision / 完整约束 /
scope / epoch。任何一项变化 → 确认失效；**不能把 null 补 0 后声称已核实**。

### 5.4 revision transition

`commitWorkspaceTransition(current, patch, now)`：

- 在内存中整体替换 Trip + sidecar + budget（patch 省略某段 = 保持原段；`budget:null`
  明确清空）；**采用版本 / 撤销都只产生这一层 transition，一次 undo 整体回退，
  不存在 Trip 回退而 sidecar / budget 不回退的中间态**；
- 撤销同样是一次新 transition：恢复旧内容，但 `workspaceRevision = 当前值 + 1`，
  **不回放旧 revision**；保留 `workspaceId/ownerId/meta.createdAt`；
- 不允许换 `trip.id`（换行程 = 新工作区）；
- 结果重新走完整 validator + 容量检查；失败返回 failure，**原记录对象与存储字节都不变**；
- 不读写 storage；持久保存必须由用户显式操作、单键 `setItem` 成功后更新持久状态。

`nextWorkspaceRevision` 对负数 / 非安全整数 / 达到 2^53-1 明确失败，不回绕。

---

## 6. 保存 / 切换 / 失败语义（storage 实现契约，本阶段未写）

### 6.1 单键保存

- 三个库各自**一条记录、一个键、一次 `setItem`**。
- 工作区记录必须是完整快照（Trip + sidecar + budget + meta）；禁止先写 Trip 再补
  sidecar，禁止顺序写三键后再 rollback（rollback 自身可能 quota 失败，保不住旧值）。
- 候选 / 版本库同样一次 `setItem` 一条记录。
- **持久保存 = 用户显式操作**；导入 / 应用 / 采用先在内存中完成单一 transition，
  预览 / 确认后才允许 `setItem`；`setItem` 成功后才更新持久状态 / 标志。
- 失败（超限 / QuotaExceeded / SecurityError / 校验失败）→ 旧内存对象与旧存储字节
  **都不改变**；不驱逐旧数据、不写半截记录。

### 6.2 读取状态

| 状态 | 条件 | 行为 |
|---|---|---|
| `ok` | 结构合法 | 返回记录；不修改原始字节 |
| `empty` | 键不存在 / 空串 | 没有数据，不是损坏 |
| `unavailable` | 无 localStorage / SecurityError | 明确提示「当前浏览器无法访问本地存储」；不崩、不假装已保存 |
| `corrupt` | 非 JSON、顶层形状坏、版本/格式不识别 | **保留原字节**，只读不写；UI 明确提示，不假装没有数据 |
| `anomaly` | raw 可解析且能认出外层，但内部有无效条目 / 重复 / 超限；严格 validator 会整条拒绝 | **普通写入拒绝**，避免用清洗后的数据覆盖原始；保留原字节；仅按 §6.6 做只读展示 |
| `unknown_version` | `version` 不是 1 | 原样保留，不覆盖 |

- `corrupt` / `anomaly` / `unknown_version` 不得自动清除；只有用户明确确认的修复 / 删除
  流程才能删键。
- 候选 / 在途异步结果**无 storage 副作用**：候选写入不触碰工作区键；在途候选不落盘。

### 6.3 跨 tab

- 同页**串行**（页面内单写者）。
- prepare / confirm 冻结 **raw + revision**；提交前重读，与冻结值不一致 → **拒绝并保留
  旧数据**，提示「另一处已更新」。
- **不声称 localStorage 自带 CAS**；本阶段**不实现跨 tab 事务**，也不引入 Web Locks /
  journaling / 多键事务。未实现互斥时，跨 tab 只允许「重读比对 + 拒绝」，不承诺事务。
- 任何需要多键 rollback 的方案都不属于本契约。

### 6.4 quota 识别

沿用 `savedTrips.ts` 的 `isQuotaError` 口径：`QuotaExceededError` /
`NS_ERROR_DOM_QUOTA_REACHED` / `code 22` / `code 1014`；识别后失败并保旧。容量是
最大允许，不是配额保证。

### 6.5 缺陷 / anomaly 的边界

- **写入 / 导入 / 备份路径**：只用严格 `validateWorkspaceRecord`。清单段或约束段任一字段
  非法 → **整条记录拒绝**，不静默只丢清单 / 只丢约束，也不写回清洗后的数据。
- **读取路径**：默认仍整条只读；唯一例外是 §6.6 的清单段只读 salvage。其它段损坏
  （Trip / anchors / constraints / applies / budget / meta）→ 整个记录 `corrupt`，不
  拆段展示。
- 版本库 / 候选库某条坏 → 整个库进入 `anomaly`，普通写拒绝；不「清洗后覆盖」。

### 6.6 清单段损坏的只读 salvage（与严格写入分开）

这是**读取层的窄例外**，不是 validator 放宽：

- 仅当 raw 可解析、外层与 `trip` 可读、且**只有 `sidecar.checklist`** 不合法时，storage
  可返回 `anomaly` 并附带可展示的 Trip；内存中的清单视为 **invalid / 空**，UI 明示
  「清单数据损坏，未加载」。
- 其它任何段损坏都不得 salvage；尤其 anchors / constraints / applies 不合法时整条
  `corrupt`，不能展示半条 sidecar。
- salvage 结果**只读**：普通保存、清单编辑、版本采用、备份导出都拒绝，直到用户显式
  选择「保留原字节并放弃清单」或「删除原记录」。**绝不自动写回**，原字节始终保留。
- 这条规则只服务于「清单坏了，Trip 还能看」；导入 / 备份预览必须显式报告分段错误，
  不能把 salvage 结果当成合法记录再导出。

---

## 7. 三个独立备份文件

三个 envelope，格式与旧 Trip / 预算 / ICS / Markdown 文件互不相认：

```json
{
  "format": "travel-assistant.workspace.backup",
  "version": 1,
  "exportedAt": 1760000000000,
  "workspace": { "...": "WorkspaceRecordV1" }
}
```

```json
{
  "format": "travel-assistant.workspace.candidates.backup",
  "version": 1,
  "exportedAt": 1760000000000,
  "candidates": { "...": "CandidatesRecordV1" }
}
```

```json
{
  "format": "travel-assistant.workspace.versions.backup",
  "version": 1,
  "exportedAt": 1760000000000,
  "versions": { "...": "VersionsRecordV1" }
}
```

- **工作区备份默认不含候选库 / 版本库**；候选与版本各有独立备份 / 导入。
- 文件字节上限见 §2.2；导入前按 `File.size` / 实际 raw UTF-8 字节门禁，解析后再按
  内部结构与容量复核。预览 / 下载必须使用**同一份字节**（预览后下载，不重新生成）。
- 每个操作：明确范围 → 预览 → 确认 → 写入 → **一次 undo**；每个库独立。
- 导入遵守 §6.1：validate → 冻结旧 raw → 内存单一 transition → 用户显式持久保存；
  损坏 / 超限 / 失败 → 原库字节不变。
- **不声称**跨三库原子恢复 / 一键全套恢复；不把三个 envelope 合并成一个。
- 旧 Trip JSON / ICS / Markdown 文件行为不变；新增 sidecar 字段的保存 / 备份 / 恢复
  必须有端到端读回测试（不是只测内存对象）。
- workspace / versions 备份与导入必须原样保留 `ChecklistItemV1.constraintId`（含显式
  `null`）；旧记录缺省不补 `null`。旧程序不支持新字段时按严格策略 fail closed、保留原
  文件，不静默剥离或改写。

---

## 8. 会话恢复迁移（旧 v1 → 新 v2）

### 8.1 旧 v1（只读兼容）

现有 envelope：

```json
{
  "format": "travel-assistant.session-resume",
  "version": 1,
  "savedAt": 1760000000000,
  "session": {
    "trip": { "...": "Trip v1" },
    "draft": null,
    "budget": null,
    "ui": { "activeDay": 1, "draftMode": "walking", "openedFromFile": null }
  }
}
```

旧读取器对顶层与 `session` 内的未知键都按 `invalid` 原子拒绝；flag 关闭时**不读内容键**。
这些语义保持不变。

### 8.2 新 v2（契约决定）

新 payload 使用**外层 version 2**（不是 v1 可选扩展），因为旧 v1 validator 会拒绝未知
`session` 键，可选扩展同样无法被旧代码读取；v2 更诚实。

```json
{
  "format": "travel-assistant.session-resume",
  "version": 2,
  "savedAt": 1760000000000,
  "session": {
    "trip": { "...": "Trip v1" },
    "draft": null,
    "budget": null,
    "ui": { "activeDay": 1, "draftMode": "walking", "openedFromFile": null },
    "workspace": {
      "workspaceId": "…",
      "ownerId": "…",
      "workspaceRevision": 3,
      "updatedAt": 1760000000000,
      "sidecar": { "...": "WorkspaceSidecarV1" },
      "meta": { "createdAt": 1760000000000, "label": null }
    }
  }
}
```

- `workspace` 为 `null` 或对象；v2 中该键必须存在。只保存 sidecar / owner / revision /
  meta，**不重复 Trip / budget**（Trip 已在 `session.trip`，预算已在 `session.budget`）。
- **写策略**：有 workspace 块 → 写 v2；没有 workspace 块 → 仍写 v1，保持对旧读取器
  最大兼容。读取器同时支持 v1 / v2；**v2 也必须能读旧 v1 outer format**。
- **单次完整写**：v2 的 `trip + draft + budget + ui + workspace` 必须在一次 `setItem`
  中整体写入，不允许先写 Trip 再补 workspace，也不允许把 workspace 拆到另一个键。
  失败 / 超限 → 旧 payload 原字节不变。flag 关闭不读、无 payload、corrupt /
  unknown_version 的既有三态语义不变。
- **rehydrate 规则**（新读取器）：
  - `tripId = session.trip.id`；`trip = session.trip`；`sidecar = workspace.sidecar`；
  - `budget`：仅当 `session.budget.binding.kind === 'current'` 且
    `binding.tripId === session.trip.id` 时，映射 `{budgetRaw, rows}`；否则 `null`
    （stale / unbound 预算不属于当前行程，不冒充）；
  - 用重建对象跑 `validateWorkspaceRecord` + 容量检查；失败 → 整份 payload `invalid`，
    原字节保留，不部分恢复；
  - 任一块无法自证 → 失败，不静默丢块。
- **容量**：会话总包仍 ≤ 1.5 MiB；Trip ≤ 640 KiB；sidecar ≤512 KiB；若 workspace 块
  导致超限 → `too_large`，旧 payload 保留，**不静默丢弃 workspace 字段**。手动
  `KEY_WORKSPACE` 保存仍可单独完成。
- **v1 → v2**：读取 v1 的 workspace = `null`（未关联）；不自动生成 workspaceId /
  ownerId，不自动挂 sidecar。只有用户显式保存工作区或下次带 workspace 的 v2 写入
  才迁移。
- **两条恢复路径**：
  1. 手动工作区保存 / 导入：完整 `WorkspaceRecordV1`；
  2. 启用会话恢复：v2 `workspace` 块重建记录。
  两条都必须能恢复 sidecar（F1/F5 验收要覆盖），不能只做内存 UI。

### 8.3 default-off 按 key 语义

- flag 键 `KEY_SESSION_FLAG` 非 `'1'`：启动 / 普通编辑**不读** `KEY_SESSION_DATA`；
- 既有「显式恢复管理 / 检查」是唯一例外（用户主动打开恢复面板 / 执行管理动作）；
- 候选库 / 版本库 / 已存工作区**只在用户打开对应面板或执行对应读取动作时**读自己的键；
  这不等于启用会话恢复；任何用户动作都**不得借机读取恢复 raw**；
- 测试按内容键分别 spy（如「`KEY_SESSION_DATA` 读次数 0」），**不写全局 `getItem=0`**
  （会误伤正常 savedTrip / workspace 读取）。

---

## 9. 旧 Trip 导入

- `tripTransfer.ts` / `tripFile.ts` 的旧 Trip JSON 流程 / 接口保留，语义不变。
- 导入后**默认不自动挂接任何 sidecar**；即使内容 / ID 相同，也必须用户**显式选择**
  已保存工作区才能关联；**不得仅凭短 hash 自动挂接**。
- `createWorkspaceRecord` 只用于用户显式「保存为工作区」；旧 Trip 导入不得调用它自动
  造 sidecar。
- 导入保留候选库 / 版本库数据，但当前上下文清晰解绑（UI 明示「本行程未关联工作区
  数据」）；不删除其它库。

---

## 10. F1–F6 消费矩阵（作者可直接照此开工）

| Feature | 消费的契约类型 / helper | 自己拥有 | 写入边界 |
|---|---|---|---|
| **F1** 住宿与抵离 | `AnchorsV1`、`AccommodationAnchorV1`、`DayAnchorV1`、`TransportAnchorV1`、`validateAnchors`、`emptyAnchors`、`commitWorkspaceTransition` | `anchors.ts`、`StayAnchorsPanel.*`、`docs/ANCHORS.md`；酒店 occurrence 生成 / 冲突报告 | 只改 `sidecar.anchors`；不直接写 Trip；显式 apply 才 transition +1 |
| **F2** 必去与预约 | `ConstraintsV1`、`ConstraintItemV1`、`validateConstraints`、`validateConstraintsForScope`、`PlanScopeV1`、`createConstraintsBinding`、`constraintsBindingMatches`、`createUnverifiedConstraintsAck`、`unverifiedConstraintsAckMatches`、`validatePlanScope` | `constraints.ts`、`ConstraintsPanel.*`、`docs/CONSTRAINTS.md`；H/U 判定与目标匹配；backend contract tests | 只改 `sidecar.constraints`；候选 apply 前必须重验；`trip_plan` 不伪造 stopId；backend 约束字段按 §11 |
| **F3** 候选池 | `CandidateItemV1`、`CandidatesRecordV1`、`validateCandidateItem`、`validateCandidatesRecord`、`createCandidatesRecord`、`createApplyLink`、`MAX_CANDIDATES_*` | `candidatePool.ts`、面板、去重提示、独立备份 / 导入 | 只写 `KEY_CANDIDATES`；加入草稿走 `tripDraft`；不写工作区键 |
| **F4** 版本 | `VersionSnapshotV1`、`VersionsRecordV1`、`validateVersionSnapshot`、`validateVersionsRecord`、`createVersionsRecord`、`commitWorkspaceTransition`、`nextWorkspaceRevision` | `versionSnapshots.ts`、面板、diff、采用 / undo 计划 | 只写 `KEY_VERSIONS`；采用 / 撤销整体 Trip+sidecar+budget，revision 当前 +1 |
| **F5** 清单 | `ChecklistV1`、`ChecklistItemV1`（含可选 `constraintId`）、`validateChecklist`、`emptyChecklist` | `checklist.ts`、面板、模板建议、`constraintId` 审计 / needsRelink 规则 | 只改 `sidecar.checklist`；done 不进 Trip；删除约束不自动重绑 |
| **F6** 离线页 | `WorkspaceRecordV1` 的只读快照、`validateWorkspaceRecord`、`canonicalJson` / `fingerprintOf`（如需导出绑定） | `offlineTripHtml.ts`、`offlineTripHtmlFile.ts`、面板、`docs/OFFLINE_TRIP_HTML.md` | **只读**当前选定有效快照；不写 storage；不含候选 / 其他版本 / 会话 raw / key；不依赖外链；清单 dangling / 未关联只提示，不宣称预约已确认 |

共同约束：

- 纯 feature 模块不直接读 localStorage；存储由后续 `workspaceStorage.ts` 统一提供。
- 不修改 `workspace.ts` / `workspaceTypes.ts` / `workspaceFingerprint.ts`（契约 owner 独占；
  变更走契约评审）。
- 不修改 `App.tsx` / `e2e/runner.mjs`（各自 owner 串行接入）。
- 不把 sidecar 字段塞进 Trip；不改 Trip v1 类型。
- 不用短 hash 自动挂接 / 自动合并 / 自动恢复。
- **运行期先过引用门**：apply / 采用 / 撤销 / 导入确认必须先
  `captureWorkspaceRuntime` + `workspaceRuntimeRefsMatch`（actual refs + safe epoch），
  再做公共内容 / binding 匹配；内容相同不等于同一对象（§5.1.1）。
- 所有 apply / 采用 / 导入都走“完整 validate → 预览 → 显式确认 → 单一 transition →
  显式持久保存”；失败保旧。

### 10.1 稳定 import 面（六线按实际导出名使用）

| 模块 | 稳定导出（本阶段已实现） |
|---|---|
| `workspaceTypes.ts` | 三个 `*_STORAGE_KEY`、`*_FORMAT` / `*_VERSION` / `BACKUP_VERSION`、全部 `MAX_*` 常量、`WorkspaceRecordV1` / `WorkspaceSidecarV1` / `AnchorsV1` / `ConstraintsV1` / `ChecklistV1` / `ChecklistItemV1`（含可选 `constraintId`）/ `ApplyLinkV1` / `CandidateItemV1` / `CandidatesRecordV1` / `VersionSnapshotV1` / `VersionsRecordV1` / 三个 backup、`WorkspaceFingerprintV1` / `WorkspaceIdentityV1` / `WorkspaceOwnerV1` / `PlanScopeV1` / `ConstraintsBindingV1` / `UnverifiedConstraintsAckV1`、`WorkspaceStoreStatus` |
| `workspace.ts`（并 re-export `workspaceTypes`） | `validateAnchors` / `emptyAnchors`、`validateConstraints` / `validateConstraintsForScope` / `emptyConstraints`、`validateChecklist` / `emptyChecklist`、`validateApplyLink(s)` / `createApplyLink`、`validateBudgetSnapshot` / `emptyBudgetSnapshot`、`validateWorkspaceSidecar` / `emptySidecar`、`validateWorkspaceRecord` / `createWorkspaceRecord`、`commitWorkspaceTransition` / `nextWorkspaceRevision`、`validateCandidateItem` / `validateCandidatesRecord` / `createCandidatesRecord`、`validateVersionSnapshot` / `validateVersionsRecord` / `createVersionsRecord`、三个 `validate*Backup`、`validateWorkspaceIdentity` / `workspaceIdentityOf` / `workspaceIdentityMatches`、`captureWorkspaceRuntime` / `workspaceRuntimeRefsMatch` / `WorkspaceRuntimeCaptureV1` / `WorkspaceRuntimeExtrasV1`、`validatePlanScope` / `planScopeMatchesRecord`、`validateWorkspaceOwner` / `createWorkspaceOwner` / `workspaceOwnerMatches`、`validateConstraintsBinding` / `createConstraintsBinding` / `constraintsBindingMatches`、`validateUnverifiedConstraintsAck` / `createUnverifiedConstraintsAck` / `unverifiedConstraintsAckMatches`、`check*Limits` / `measure*`、`createLogicalId` |
| `workspaceFingerprint.ts` | `canonicalJson`、`fingerprintOf`、`fingerprintsMatch`、`canonicalValuesEqual`、`shortFingerprint`、`isShortFingerprint`、`SHORT_FINGERPRINT_ALGORITHM` |

不在这里的 helper（如 storage 读写、salvage、会话 v2 迁移、H/U 业务判定）由后续
owner 新增；六线不要自行复制 schema 或常量。

---

## 11. F2 后端契约（唯一 writer 按此实现；本阶段未改 backend）

### 11.1 端点覆盖

| 端点 | 现有 request | 规划 scope | 是否加 constraints |
|---|---|---|---|
| `POST /api/trips/plan` | `TripPlanRequest` | `trip_plan`（day=null, anchor=null） | **是，可选** |
| `POST /api/trips/days/replan` | `DayReplanRequest` | `day` 或 `day_tail` | **是，可选** |
| 后段 replan（同一 replan 端点） | `DayReplanRequest` | `day_tail`（day + anchor_stop_id） | **是，可选** |
| `POST /api/trips/days/map-refresh` | `MapRefreshRequest` | — | **否** |
| `POST /api/trips/days/leg-refresh` | `LegRefreshRequest` | — | **否** |

- 不新增独立端点；不把 constraints 塞进 `instruction`；不截断原 instruction。
- 后段 replan 沿用现有 replan 端点；`day_tail` 是 scope，不是新 endpoint。
- map-refresh / leg-refresh 的 request 模型继续 `extra="forbid"`；客户端不得发送
  constraints。它们的**结果合入 / apply 仍必须核当前硬约束**。

### 11.2 请求 JSON 形状（backend snake_case）

```json
{
  "constraints": {
    "version": 1,
    "scope": "trip_plan",
    "day": null,
    "anchor_stop_id": null,
    "fingerprint": "a1b2c3d4",
    "items": [
      {
        "id": "constraint-1",
        "kind": "must_visit",
        "day": 2,
        "stop_id": null,
        "title": "博物馆",
        "start_date": null,
        "end_date": null,
        "start_time": null,
        "end_time": null,
        "duration_minutes": null,
        "priority": 2
      }
    ]
  }
}
```

- 字段映射：前端 `stopId → stop_id`、`startDate → start_date`、`endDate → end_date`、
  `startTime → start_time`、`endTime → end_time`、`durationMinutes → duration_minutes`、
  `anchorStopId → anchor_stop_id`。
- **不发送** `notes` / `updatedAt`（本地字段，避免 prompt 膨胀与隐私外泄）。
- `fingerprint` 是客户端**完整本地 constraints**（含 `notes` / `updatedAt`）canonical 的
  8 位短索引；wire 又省略了这两个字段，所以后端**不能**用它重算 wire 内容哈希。它
  只是不透明索引 / 日志关联，**不是信任证明**，不能替代客户端 apply 硬门。
- `version` 只认 `1`（数字）；`kind` 只认 `must_visit` / `fixed_window` / `reminder`。
- **可空字段必须显式发 `null`，不得省略**：`day`、`stop_id`、`start_date`、`end_date`、
  `start_time`、`end_time`、`duration_minutes`。后端接收后保持 null，**不补 0、不猜当天 /
  0 点**；U 级约束允许缺必要端，是否可 apply 由前端 H/U 门判定。
- `must_visit` 的 `day` + `title` 必填；`stop_id` **可为 null**，表示尚未落 Trip 的
  初始目标实体，用规范化 title + day 表达。`trip_plan` 没有 request.stops，所有约束的
  `stop_id` 都必须为 null；day / day_tail 绑定既有 stop 时才给非 null `stop_id`，且该
  stop 必须存在于 scope 指定日。`fixed_window` / `reminder` 可以只有部分时间字段（U 级）；
  `fixed_window` 的完整起止是「可声称硬验证」的条件，不是 backend 的接收条件。
- `id` 是约束逻辑 id，≤200 字符；`stop_id` 非 null 时引用 request.stops 中已有 stop，
  现有 `DayReplanStop.id` 上限 100，超过 100 的本地 stop id 不能走 backend 规划通道
  （前端 typed 失败，不截断 id）。`stop_id=null` 的目标由 §11.7 的 title/day 语义匹配，
  不能声称已做 stop id 验证。
- `duration_minutes` 与本地一致：`null` 未知，整数 0..100000；`0` 只表示已知零。`title`
  ≤120；`priority` 0..3。

### 11.3 上限与失败

| 项 | 值 | 行为 |
|---|---|---|
| `items` 条数 | ≤ 24（`MAX_CONSTRAINT_ITEMS`） | 超限 422 / 前端 typed 失败；不截断 |
| constraints 紧凑 UTF-8 | ≤ 16 KiB（`MAX_CONSTRAINTS_BYTES`，按实际 wire JSON） | 超限 422 / 前端不发送；不丢部分约束 |
| `title` | ≤120 | 422 |
| `notes` | 不进后端 | — |
| `day` | `must_visit` 必填 1..7；其他 kind 可 null；day/day_tail 的 `items[].day` 必须为 null 或 scope.day | 超出 422；工作区可存 >7 天，但不能走该 backend 流程 |
| `id` | ≤200（约束逻辑 id） | 422 |
| `stop_id` | `trip_plan` 必须 null；day/day_tail 非 null 时必须引用 request.stops 且属于 request.day；null = 未绑定目标 | 伪造 / 跨天 / 不存在 → 422；`DayReplanStop.id` >100 前端 typed 失败，不截断 |
| `duration_minutes` | null 或 0..100000 整数 | 422 |
| `priority` | 0..3 | 422 |
| dates / times | null 或严格 `YYYY-MM-DD` / `HH:MM` | 422；null 不补 0 / 当天 |

- 超容量 = **明确失败**（backend 422 / 前端不发起请求），不是静默截断或丢条目。
- `constraints` 省略 = 旧行为，prompt 不出现约束段；旧客户端语义保持。
- `constraints` 存在但 `items: []` 合法（等价无约束），仍要求 scope 与端点匹配。
- **可空字段必须显式发 null**；backend 不得把 null 归一成 0、当天或「无约束」而悄悄
  放行。U 级是否 apply 由前端 H/U 门与独立确认决定。

### 11.4 实际 `extra` 行为（重要差异）

| 模型 | 实际 | 本契约决定 |
|---|---|---|
| `TripPlanRequest`（初始规划） | `extra="ignore"` | **保持 ignore**；只新增已声明的可选 `constraints`；不改成 forbid（避免对旧客户端的行为突变）。`constraints` 内部对象严格 `extra="forbid"`。 |
| `DayReplanRequest`（整日 / 后段） | `extra="forbid"` | **保持 forbid**；只新增已声明的可选 `constraints`；其它未知字段继续 422。 |
| `MapRefreshRequest` / `LegRefreshRequest` | `extra="forbid"` | 不加字段；constraints 若被发送会 422。 |

> 因此「初始规划未知顶层字段也 422」**不是**当前事实。F2 contract tests 必须按实际
> 断言：初始规划未知顶层字段仍被忽略；`constraints` 内部未知字段 422；day replan
> 未知顶层字段 422。若未来要把初始规划收紧为 forbid，这是单独的行为变更，需要新证据
> 与迁移，不在本契约内偷偷做。

### 11.5 scope 与端点一致性

- `trip_plan`：只能用于 `/api/trips/plan`；`day=null`、`anchor_stop_id=null`；请求
  **没有 request.stops**，所以所有 `items[].stop_id` 必须为 null。`must_visit` 只用
  `title + day` 表达初始目标，不能伪造 stop id。
- `day`：只能用于 `/api/trips/days/replan`；`day` 必须等于 request.day；
  `anchor_stop_id=null`。`items[].day` 必须为 null 或 request.day；非 null `stop_id`
  必须存在于 request.stops 且属于 request.day；null 表示未绑定目标，后续按 title/day
  匹配。
- `day_tail`：只能用于 `/api/trips/days/replan`；`day` 必须等于 request.day；
  `anchor_stop_id` 必须存在于 request.stops 中，且是该日的后段锚点。约束规则同 day；
  **不要通过解析 instruction 前缀识别 scope**，scope 只能在 `constraints.scope` 显式给。
- 不匹配 → 422；前端不发起请求。

### 11.6 响应 / 回显 / ownership

- **不新增响应字段**；`DayReplanResponse` 保持 `{day,warnings,map_status,parent,source}`，
  不为 constraints 扩 envelope。
- 回显策略（唯一允许的 ownership 线索）：
  | 字段 | 是否回显 | 客户端用途 |
  |---|---|---|
  | `parent {trip_id, revision}` | replan 原样回显 | 只作陈旧性 / 身份核对，不作内容权威 |
  | `constraints` / `scope` / `fingerprint` | **不回显** | 客户端用本地 binding + 当前 canonical 重算 |
  | `source` | 固定 `agent` | 仅标识来源 |
  | 初始规划 `parent` / `revision` | **没有** | 响应只是候选 Trip，保存后才形成工作区 |
- 现有 replan `parent {trip_id, revision}` 必须原样回显；客户端 apply 前校验
  `parent.trip_id === 当前 tripId` 且 `parent.revision === 当前 workspaceRevision`。
  这两项不匹配 → 明确失败，不静默套用。
- 初始规划**没有** parent / revision 回显；其响应只是候选 Trip，只有用户显式保存 /
  采用后才形成工作区，不能拿响应自报当成 owner。
- `constraints.fingerprint` 是客户端发出的不透明索引，**不要求后端回显**；即使未来
  回显，也只作关联 / 日志，**不作为权威**。权威判定在客户端：完整 constraints
  canonical + identity + revision + epoch + scope（§5.2）。
- 客户端候选记录在发起请求时绑定 `ConstraintsBindingV1`；响应回来 / apply 时先过
  §5.1.1 的运行期引用门 + epoch，再计算当前约束与 revision，失配 → 「约束已变化，请
  重新生成」，不静默重算、不套用。

### 11.7 目标匹配 / H-U 证据（F2 适配层）

目标匹配是**解析线索**，不是强身份自证；名称相同不等于同一实体。

- **禁止只靠输出 stop id**：day replan 会把输出 stop id 重写为 `replan-*`，和请求
  stop id 不是同一命名空间。请求里有 `stop_id` 时，先映射到 request stops 的
  name / date / duration / 位置（DayReplanStop 没有 location 时不要声称坐标匹配），
  再到候选 Trip 中按语义匹配。
- **初始 trip_plan**：没有 request.stops；`must_visit.stop_id` 必须 null，按规范化
  `title`（NFKC、trim、折叠空白、大小写归一） + `day` 匹配。规范化后唯一命中才可
  声称满足；零命中 = 已知必去缺失，走 H（现有 502 安全 detail）；同名多站 / 多义 /
  坐标相悖 = U，**不能 silent 挑第一个，不能声称满足**。结构里没有坐标可匹配时，
  不得声称已做坐标验证。
- **day / day_tail**：非 null `stop_id` 先从 request.stops 取得目标信息再匹配；null
  `stop_id` 作为未绑定目标，按规范化 title + scope.day 匹配。零命中 H、多义 U。
- `fixed_window`：完整起止 + 真实日期 + 唯一目标才可声称硬验证；绑定 stop 被删 /
  目标缺失 = H；时间或目标无法唯一确认 = U。`_time_origins.placeholder`（例如
  09:00 占位）、`duration_minutes=null`（durationNone）、缺失时间都**不是已知证据**，
  一律 U，不补 0。
- **day_tail 冻结段**：服务端只看到后段，看不到冻结前缀；指向冻结段 / 服务端不可见
  的约束不得声称 H，标 U，由客户端在最终合并后的完整 Trip 上硬验。**不要解析
  instruction 前缀来识别 scope**；scope 只能来自 `constraints.scope`。
- 适配层必须用 `checkTripShape` / `validateWorkspaceRecord` 核对完整 Trip 候选，再把
  目标匹配结果变成 typed H/U issue；不能用输出自报字段或短 hash 替代。
- **输出通道**：H 沿用既有安全 502（固定 detail 前缀，不泄露完整约束 / instruction）；
  U 沿用既有 `warnings` 固定前缀，不新增 endpoint / response 字段。前端 apply 硬门
  仍然保留，不能只靠 backend warning。

### 11.8 prompt / 输出

- prompt 接收**独立的结构化 constraints JSON 段**；`instruction` 原文完整保留，不塞入、
  不截断。
- 模型输出仍按现有 Trip v1 / 单日 DayPlan 结构校验；前端纯 apply 硬门**不省**。
- map-refresh / leg-refresh 结果合入时仍核当前约束；它们不接收 constraints 字段。

### 11.9 F2 contract tests（实现时必跑）

1. constraints 省略 → 请求与旧行为等价（初始 / replan）。
2. constraints 存在 → 透传到 planner prompt，instruction 原文不变。
3. 初始规划未知顶层字段仍被忽略（实际 `extra="ignore"`）。
4. day replan 未知顶层字段仍 422（`extra="forbid"`）。
5. constraints 内部未知字段 422。
6. scope / day / anchor 与端点不匹配 → 422。
7. 25 条 / >16 KiB → 明确失败（不截断）。
8. map-refresh / leg-refresh 发送 constraints → 422；不改变其正常请求。
9. 后段 replan 走同一端点，scope=`day_tail` + anchor。
10. `trip_plan` + `must_visit {day, title, stop_id:null}` 合法；非 null `stop_id` 422。
11. `day` / `day_tail` 非 null `stop_id` 不在目标日 / 跨天 → 422；null 目标合法但不
    自动算满足；`must_visit.day` 缺失 422。
12. 目标匹配：零命中已知必去 → H（502 安全 detail）；同名多站 / 多义 / 坐标相悖 →
    U；占位 09:00 / `duration_minutes=null` → U，不补 0；不按输出 stop id 匹配。
13. `day_tail` 冻结段约束服务端不可见 → U；客户端最终合并后的完整 Trip 必须硬验。

---

## 12. 本阶段代码与验证

新增文件：

| 文件 | 内容 |
|---|---|
| `frontend/src/lib/workspaceTypes.ts` | 常量 + 全部 v1 类型（唯一 schema 定义） |
| `frontend/src/lib/workspaceFingerprint.ts` | canonical JSON + FNV-1a 短指纹 + 全文比较 |
| `frontend/src/lib/workspace.ts` | 严格 validator / 白名单 builder / 容量测量 / revision transition / owner / binding / ack / plan scope / scope-aware constraints / runtime ref capture / checklist 可选 constraintId |
| `frontend/src/__tests__/workspaceFingerprint.test.ts` | canonical / hash / 比较测试 |
| `frontend/src/__tests__/workspace.test.ts` | 记录 / sidecar / F1-F5 结构 / 容量 / owner / runtime refs / transition / backup / checklist constraintId 兼容测试 |
| `docs/WORKSPACE_SIDECAR.md` | 本文（唯一权威） |

本阶段实测（仅这两个测试文件 + 目标 TypeScript noEmit）：

- `vitest run src/__tests__/workspace.test.ts src/__tests__/workspaceFingerprint.test.ts --no-cache`：
  `workspaceFingerprint.test.ts` 9 tests、`workspace.test.ts` 46 tests，合计 **55 passed**
  （原 51 项全部保留 + checklist constraintId 兼容 4 项）；
- `tsc`（scoped 仅本文 5 个前端文件，`--composite false --noEmit`）：通过；当前 moving
  tree 中其它 owner 的 WIP 类型错误不在本批类型门内。
- **未跑**：full 前端 suite、build、E2E、backend pytest；**未实现** storage / 恢复 /
  backend；这些不属于本阶段完成态。

F1–F6 作者可以直接 import 本文 §10 的 helper 开始纯模块；storage / 后端接线按后续
owner 排期。若本契约需要变更，先改本文 + `workspaceTypes.ts`，再改 validator / tests，
最后通知六线；不要让 feature 各自造字段。

---

## 13. 后续实现依赖 / 明确未做

- `workspaceStorage.ts`：单键原子写、容量、损坏保旧、quota、跨 tab raw 比对、
  三个独立备份 / 导入（本阶段只定义契约）。
- 会话恢复 v2 写入 / 读取迁移：需在 `sessionRestore.ts` 现有 v1 读取路径上增量实现；
  **本阶段未改**该文件。
- `api.ts` / `tripDraft.ts` / `tripTransfer.ts` / `tripFile.ts`：本阶段未改；F2 的
  wire payload 映射放在自己的模块，但必须复用 `ConstraintsV1`，避免改 Trip v1 /
  旧导入语义。
- 后端 F2：`backend/travel_itinerary.py`（`TripPlanRequest`）、
  `backend/day_replan.py`（`DayReplanRequest`）加可选严格 `constraints`；F2 唯一 writer
  按 §11 实现；本阶段未改 backend。
- F1 occurrence 生成、F2 H/U、F3 去重、F4 diff、F5 模板、F6 HTML 都属于 feature 业务
  模块；本契约只提供类型 / 校验 / owner / transition / 容量基础，不替它们做业务判断。
- 运行期引用门（§5.1.1）不能由 storage 持久化替代：App / 各 feature 在 apply、adopt、
  undo、import confirm 时必须 capture actual refs、先比 refs + safe epoch，再做内容 /
  binding 匹配；每次编辑 / 切换 / 采用 / 撤销 / 导入 / 外部 storage 变化都要推进 epoch。
- 不做跨三库事务、不做跨 tab 事务、不做 Web Locks、不做数据库 / 登录 / 云同步 /
  Service Worker 全应用离线；不自动驱逐旧数据；不声称浏览器 quota 保证。

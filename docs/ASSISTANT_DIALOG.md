# A · 对话式行程编辑（前端纯模块 / 契约）

> 状态：**契约文档 + 纯前端模块 + 单测**。
> 本文件是这条能力的**唯一权威契约**；实现见
> `frontend/src/lib/assistantDialog.ts`，测试见
> `frontend/src/__tests__/assistantDialog.test.ts`。
> 本文件**不声称** App 已接线、面板已实现、后端已改造或端到端已验收。
>
> 适用基线：`F:/MunderDifflin/Travel-Assistant/LangGraph-Smart-Traval-Assitant`，
> 分支 `feat/interactive-travel-planner`。

---

## 1. 交付边界

本批只新增三个文件：

| 文件 | 作用 |
|---|---|
| `docs/ASSISTANT_DIALOG.md` | 本文件：契约唯一权威 |
| `frontend/src/lib/assistantDialog.ts` | 指令解析 → 结构化意图 → 提案卡计算（纯函数，无 UI） |
| `frontend/src/__tests__/assistantDialog.test.ts` | 纯模块单测（全部离线） |

**明确不做**：

- 不改 `App.tsx`、不改任何 Panel、不新增后端端点、不改 `Trip v1`、不改工作区 schema。
- 不读写 `localStorage`、不 `fetch`、不 import React、不读时钟、不调用 `crypto`。
- 不实现对话面板、不做语音输入、不接会话历史。
- 不跑浏览器验收、不跑 E2E、不做 Git 操作。

---

## 2. 能力边界（一句话）

把一句中文自然语言指令，**在本地确定性地**解析成结构化意图，算出一张**带快照**的提案卡
（改什么 / 冲突是什么 / 为什么），由用户在面板上确认或丢弃；确认后走**一次内存工作区
transition**（revision + 1），可撤销一层。

六类解析结果：

| 意图 | 说明 | 产物 |
|---|---|---|
| `move_stop` | 挪动站点到另一天 / 另一个时段 | 候选行程 + 站点级改动 |
| `add_from_pool` | 从收藏池（候选库）加入站点 | 候选行程 + 站点级改动 |
| `remove_stop` | 删除站点 | 候选行程 + 站点级改动 |
| `time_preference` | 时间偏好（停留更久 / 晚点开始 / 早点开始） | **重排请求描述** |
| `pace_adjust` | 节奏调整（松一点 / 紧凑一点） | **重排请求描述** |
| `unsupported` | 超出以上五类 | 礼貌拒绝，不可应用 |

`unsupported` **不猜、不硬套**：既不把「订机票」硬套成 `add_from_pool`，也不把
「把博物馆」硬套成 `move_stop`。

---

## 3. 五类指令 schema

### 3.1 解析产物

```ts
interface AssistantParsedIntent {
  kind: 'move_stop' | 'add_from_pool' | 'remove_stop'
      | 'time_preference' | 'pace_adjust' | 'unsupported'
  /** 目标站点 / 候选名原文；没识别到为 null。 */
  targetName: string | null
  /** 目标天序号（1..366）；没识别到、或指令里的天序号越界，为 null。 */
  day: number | null
  /** 目标时段；没识别到为 null。 */
  slot: 'morning' | 'afternoon' | 'evening' | null
  /** 显式时刻 HH:MM；没识别到、或指令里的时刻非法，为 null（非法时刻不回退成别的时刻）。 */
  time: string | null
  /** time_preference 的偏好方向；其它意图为 null。 */
  timePreference: 'stay_longer' | 'start_later' | 'start_earlier' | null
  /** pace_adjust 的偏好方向；其它意图为 null。 */
  pacePreference: 'looser' | 'tighter' | null
  /** 解析说明：命中了什么、缺了什么。 */
  notes: string[]
}
```

**每一项「没识别到」都是 `null`。** 解析器不填默认天、不填默认时段、不填默认时刻。

### 3.2 词表与判定顺序

判定顺序是**固定**的，先命中先赢：

1. 收藏池标记 + 加入动词 → `add_from_pool`
2. 删除动词 → `remove_stop`
3. 挪动动词 → `move_stop`
4. 时间偏好短语 → `time_preference`
5. 节奏偏好短语 → `pace_adjust`
6. 都不命中 → `unsupported`

| 类别 | 词表（节选，完整表见 `assistantDialog.ts`） |
|---|---|
| 收藏池标记 | `收藏池` `候选池` `候选库` `收藏夹` |
| 加入动词 | `加到` `加进` `加在` `加入` `放进` `安排到` |
| 删除动词 | `不要去` `别去` `去掉` `删掉` `删除` `移除` `取消` |
| 挪动动词 | `挪到` `移到` `换到` `调到` `改到` `放到` `排到` `安排到` |
| 时间偏好 | `停留久一点` `多待一会儿` `待久一点` `停留更久` `久一点` / `晚点开始` `晚点出发` `推迟开始` `晚点` / `早一点开始` `早点开始` `提早开始` `早一点` |
| 节奏偏好 | `松一点` `松一些` `宽松` `轻松一点` `别那么赶` `慢一点` / `紧凑` `紧凑一点` `赶一点` `多排几个` `密一点` `充实一点` |
| 时段 | `早上` `上午` `清晨` `一早` → morning；`中午` `下午` `午后` → afternoon；`晚上` `傍晚` `夜里` `夜间` `晚间` → evening |
| 天 | `第 N 天`（`N` 为 1..366 的整数；越界按未知处理，见 §3.4） |

解析前先做 NFKC 归一 + 合并空白 + 去首尾空白，所以全角数字、多个空格都不影响判定。

### 3.3 各指令的语义

**`move_stop`（挪动站点）**

- 目标名：挪动动词**之前**的文本，去掉「把 / 将 / 请 / 帮我 / 我想…」等前缀。
  找不到目标名 → `unsupported`（不猜是哪一个站）。
- 目标站点按 §3.5 的三层口径定位（原文 → 归一化 → 简称）。
- 目标天：指令里的 `第 N 天`；没有就用面板当前正在看的那天（`currentDay`）。
  两者都没有 → 提案卡 `needsDay: true`，**不可应用**，让用户补。
- 目标时段**只决定插入位置**，不改写站点时刻。位置规则（只用当天已有的计划时刻分桶，
  读不出的时刻不参与分桶）：`morning` → 插到最前；`afternoon` → 插到最后一个上午站点
  之后；`evening` → 插到最后一个上午 / 下午站点之后；没有时段 → 插到当天末尾。
- 站点 id 保持不变（同一个地点换天），因此约束里的 `stopId` 绑定不会因为挪动而失联，
  但**必须去点换天**会被硬门判成 H 级。

**`add_from_pool`（从收藏池加入）**

- 目标名：收藏池标记与加入动词之间的文本（去掉「里的 / 中的 / 内的 / 把 / 将」）。
  也支持「把西湖从收藏池加到第 3 天」这种语序。
- 收藏池里有多个同名候选 → 列为**未知改动**，不替用户挑第一个。
- 新站点的字段来自候选：**名称、地址、备注**；**坐标不进入行程**（坐标留在候选库），
  **停留时长未知 = `null`**（不补 0）。
- 新站点 id 由调用方提供（`ids.newStopId`），本模块不生成随机 id。

**`remove_stop`（删除站点）**

- 目标名：删除动词之后的文本，可带 `第 N 天的` / `下午的` 前缀，前缀里的天会被取走。
- 指定了天就只在那一天找；没指定就在整条行程里找。
- 站点按 §3.5 定位：同名多个 → 未知改动；简称多命中 → 未知改动并列出候选；找不到 → 未知改动。

**`time_preference` / `pace_adjust`（时间偏好 / 节奏调整）**

- 这两类**不直接改行程**，只产出「重排请求描述」：
  `day`（目标天）+ `preference`（偏好参数）+ `instruction`（交给重排通道的指令原文）。
- 指令原文只描述偏好，不夹带坐标、费用、时间表，也不做任何「已经落实」的断言。
- 面板层把它喂给**既有的** day replan 通道（`buildDayReplanRequest` → `replanDay`），
  **不新增任何后端端点**。

### 3.4 数字边界：非法时刻与越界天序号

指令里的数字**整 token 校验**，不合法就按未知处理，**绝不回退匹配成另一个值**
（把编造的 `05:00` 当成「用户写的时刻」正是红线）。

| 引用 | 合法口径 | 非法时的行为 |
|---|---|---|
| 时刻 | `HH:MM`：小时 0–23、分钟 0–59，分钟必须写两位（`9:30` 归一成 `09:30`，`9:5` 不算时刻）。`24:00` **非法**（与 `constraints.ts` / `tripDraft.ts` 的 `STOP_TIME_PATTERN` 同一口径） | `parsed.time = null`；不写成别的时刻，也不回落到沿用 / 占位时刻；`move_stop` / `add_from_pool` 走 `needs_input` 并在 `reason` 里指出非法原文 |
| 天序号 | `第 N 天`，`N` 为 1–366 的整数 | `parsed.day = null`；**不回落到 `currentDay` 或别的天**；所有用到天的意图（挪动 / 加入 / 删除 / 重排两类）都走 `needs_input`（`needsDay: true`）并指出非法原文 |

- 「25:00」这种越界时刻**不会**被拆成「5:00」再当成 `05:00`；整 token 不合法即非法。
- 越界但合法的天序号（如「第 99 天」，行程只有 3 天）走既有路径：
  `needs_input` + 「当前行程里没有第 99 天」，同样不改动行程。
- 「第 0 天」在删除指令里同样被拒：**不会**退化成「不限定天」再去整条行程里找同名站点。

### 3.5 站点定位口径：原文 → 归一化 → 简称（三期 S7b）

删除 / 挪动的目标站点名按**三层口径**依次定位，**前一层有命中就不再往下找**：

| 层 | 口径 | 命中多个时 |
|---|---|---|
| 1 | 站点名与指令里的名字**原文完全相同** | 未知改动：「同名站点…不替你挑第一个」 |
| 2 | NFKC + 合并空白 + 去首尾空白 + 小写后相同 | 同上 |
| 3 | **简称**：站点名的归一化文本**包含**目标名，且恰好命中 1 个站点 | `needs_input`：逐个列出候选（`第 N 天「全名」`）请用户澄清，**绝不猜** |

- 简称匹配只在第 1、2 层都落空时启用，因此**不改变任何既有命中结果**：同名精确命中永远优先，
  不会因为另一个站点名更长而变成「多命中」。
- **天的作用范围按指令类型区分**：删除指令里写的天（如「去掉第 1 天的博物馆」）是**查找范围**，
  只在那一天里找、不跨天兜底；挪动指令里写的天（如「把博物馆挪到第 2 天」）是**目标天**，
  源站点始终在整条行程里找（`locateStop(trip, name, null)`），所以简称可能命中别的天，
  提案卡会写明它原本在第几天。
- 0 命中仍是「当前行程里没有找到」的诚实失败，不编造站点。
- 绑定后提案卡展示**匹配到的全名**：`changes.known[].name`、理由与改动清单都是站点全名；
  面板另用 `assistantStopMatchNotes(proposal)` 显示「按『简称』匹配到第 N 天的『全名』」一行供核对。
- 归一化口径直接复用 `constraints.ts` 的 `normalizeConstraintTitle`，不另造一套。
- 面板 `AssistantDialogPanel.tsx` 只多渲染一行「按『简称』匹配到第 N 天的『全名』」核对文案，
  提案计算 / 应用 / 撤销 / 失效逻辑一律不动。
- 例：行程里有「上海博物馆」，指令写「把博物馆挪到第 2 天下午」→ 唯一子串命中，自动绑定并显示全名；
  行程里同时有「上海博物馆」「上海自然博物馆」→ 转澄清，列出两个候选，不替用户挑。

---

## 4. 提案卡结构

```ts
interface AssistantProposalCard {
  /** 提案 id：调用方提供。 */
  proposalId: string
  kind: 'trip_change' | 'replan_request' | 'unsupported' | 'needs_input'
  intent: AssistantIntentKind
  instruction: string
  parsed: AssistantParsedIntent
  /** 站点级改动：已知与未知分列。 */
  changes: { known: AssistantProposalChange[]; unknown: AssistantProposalChange[] }
  /** H / U 级冲突：直接来自 constraints.ts，不自造判定。 */
  conflicts: ConstraintIssue[]
  /** 一句话理由。 */
  reason: string
  /** 生成时的快照：工作区 revision。 */
  baseRevision: number
  /** 生成时的快照：整条工作区记录的完整 canonical 指纹。 */
  baseFingerprint: WorkspaceFingerprintV1
  status: 'pending' | 'applied' | 'discarded' | 'invalid'
  /** 应用用的候选行程；replan / unsupported / needs_input 时为 null。 */
  candidateTrip: Trip | null
  /** 重排请求描述。 */
  replanRequest: AssistantReplanRequest | null
  /** 既有单日重排通道的请求体。 */
  replanApiRequest: DayReplanRequest | null
  requiresAck: boolean
  ack: AssistantUnverifiedAck | null
  needsDay: boolean
  notices: string[]
  invalidReason: string | null
  evaluationError: string | null
}

interface AssistantProposalChange {
  type: 'add' | 'remove' | 'move' | 'time_change'
  stopId: string | null
  name: string
  fromDay: number | null
  toDay: number | null
  /** 变更前时刻；未知为 null（不补 0）。 */
  fromTime: string | null
  /** 变更后时刻；未知为 null（不补 0）。 */
  toTime: string | null
  timeSource: 'explicit' | 'inherited' | 'slot_default' | 'unknown'
  slot: AssistantSlot | null
  detail: string
}
```

### 4.1 已知与未知分列

- `changes.known`：站点唯一确定、目标天确定、时刻确定的改动。
- 简称匹配命中时，`known[].name` / `detail` / `reason` 一律用**站点全名**（用户写的简称只出现在
  `parsed.targetName` 与面板的核对文案里），见 §3.5。
- `changes.unknown`：任一项没确定（站点没定位到 / 同名多个 / 天没定 / 时刻未知）的改动。
  这些改动里 `stopId` / `fromTime` / `toTime` 一律 `null`，由界面显示「未知」。
- **未知项永远显示「未知」，绝不填 `0`、绝不填 `00:00`、绝不编造费用或坐标。**
  `0` 分钟停留、`0` 分钟交通是合法的**已知值**，与 `null`（未知）严格区分。

### 4.2 时刻来源

| `timeSource` | 含义 | 是否已核实 |
|---|---|---|
| `explicit` | 指令里写了 `HH:MM` | 否（仍需面板确认） |
| `inherited` | 沿用站点原有的计划时刻 | 否（沿用既有 AI 占位约定） |
| `slot_default` | 按时段取的占位时刻（上午 `09:00` / 下午 `14:00` / 晚上 `19:00`） | 否，界面会标注「按时段取的占位时刻，未核实」 |
| `unknown` | 没定 | 显示「未知」 |

`explicit` 只在指令里的时刻**合法**时才有；非法时刻（`25:00` / `24:30` / `24:00`）
一律按未知处理（见 §3.4）：既不写成别的时刻，也不回落到 `inherited` / `slot_default`，
而是提案卡 `needs_input`，让用户给一个合法时刻。

时段占位时刻沿用既有 AI 候选的占位约定：`Trip.time` 非空**不构成**已知证据，
硬门仍按未核实处理（见 §6.2）。

---

## 5. 确认 / 撤销 / 失效语义

### 5.1 应用 = 一次内存 transition

```
applyAssistantProposal({ proposal, record, now })
```

顺序：

1. `status !== 'pending'` → 拒绝（`not_pending`）。
2. `kind === 'unsupported'` → 拒绝（`not_supported`），走礼貌拒绝文案。
3. `kind === 'needs_input'` 或 `needsDay` → 拒绝（`not_ready`）。
4. **快照核对**：`record.workspaceRevision !== proposal.baseRevision` → **失效**
   （`stale_revision`，卡片转 `invalid`）。
5. **指纹核对**：`fingerprintOf(record)` 与 `proposal.baseFingerprint` 不一致 → **失效**
   （`stale_fingerprint`，卡片转 `invalid`）。短 hash 只作索引，比较用完整 canonical。
6. `kind === 'replan_request'` → 返回 `replan_requested`，把 `replanApiRequest` 交给
   既有 day replan 通道；**本模块不改行程、不写存储**。
7. 硬门（§6）：H 级 → 拒绝（`hard_blocked`）；U 级 → 需要独立确认（`ack_required`），
   确认过期 → 失效（`ack_stale`）。
8. 通过后：`commitWorkspaceTransition(record, { trip: candidateTrip }, now)`，
   **一次 transition**，`workspaceRevision` 严格 +1，返回新记录 + 一层撤销句柄。

**失效绝不静默套用**：快照对不上时卡片直接转 `invalid` 并带上 `invalidReason`，
提示重新生成。

### 5.2 撤销

- 撤销句柄只保留**应用后一层**，**不与行程草稿的 undo 栈串联**。
- 撤销同样是一次 transition：`revision` 继续 **+1**，**绝不恢复旧 revision**。
- 当前 revision 不是应用后的那个值 → 拒绝（`stale_revision`），不覆盖后来的改动。

### 5.3 不采纳

`discardAssistantProposal(proposal)` 只把卡片状态改成 `discarded`：
**零写入、零存储副作用、行程不动**。

### 5.4 U 级独立确认

```ts
confirmAssistantUnverified(proposal, acknowledgedAt)
```

- 确认**绑定生成时的完整快照**（`baseRevision` + `baseFingerprint`）。
- `isAssistantAckFresh(proposal, record)` 同时核对：确认里的 revision == 提案的
  `baseRevision`、确认里的指纹 == 提案的 `baseFingerprint`、当前记录 revision 与指纹
  仍与快照一致。
- **任何变化即失效**：改了行程、改了约束、revision 前进、换了工作区，确认立刻过期，
  必须重新确认。

---

## 6. 硬门

### 6.1 判定来源

硬门**只用** `constraints.ts` 的 `evaluateConstraintsAgainstTrip`，在**候选行程**上跑：

```ts
evaluateConstraintsAgainstTrip({
  constraints: record.sidecar.constraints,
  trip: candidateTrip,
  sourceTrip: record.trip,
  timeOrigins,   // 缺省 = 全部未知
})
```

- 不传 `planScope` / `record`：这是**整条行程**的判定，不按单日作用域裁剪，
  避免跨天约束被误判。
- **不自造放宽版判定**：H / U 的分级、消息、issue code 全部沿用既有实现。

### 6.2 H 级（禁 apply，不可 override）

| 场景 | issue code |
|---|---|
| 必去目标从目标天消失 | `must_visit_missing` / `target_deleted` |
| 预约窗口结束早于开始、两个完整窗口重叠 | `window_invalid` / `window_overlap` |
| 目标站按已知时刻早于 / 晚于预约窗口 | `stop_before_window` / `stop_after_window` |
| 停留已知超出窗口 / 按前一站推算到达晚于窗口结束 | `stop_duration_exceeds` / `arrival_after_window` |
| 冻结段站点被删 / 被改 | `frozen_stop_missing` / `frozen_stop_changed` |

**H 级直接禁 apply，没有任何确认绕过入口**——即使提案已经带了 U 级确认，
`applyAssistantProposal` 仍然返回 `hard_blocked`。

### 6.3 U 级（需独立确认）

`window_incomplete`、`day_date_unknown`、`stop_time_unknown`、`stop_duration_unknown`、
`transit_unknown`、`predecessor_unknown`、`target_ambiguous`、`coordinate_conflict`、
`identity_unverified` 等。

- U 级**不得声称已满足**；必须由用户独立确认「仍采用含未核实时间的方案」。
- 确认绑定当前快照（§5.4）。

### 6.4 时间来源默认未知

`timeOrigins` 缺省 / 未列出 / `placeholder` / `unknown` 一律按**未知**处理；
只有显式 `'known'` 才按真实时刻参与 H 级硬核。
**非空 `Trip.time`、时段占位时刻、冻结段存在本身都不构成已知证据。**

---

## 7. 文案边界

- AI 生成的建议一律标注**未核实**：所有提案都带
  `ASSISTANT_UNVERIFIED_NOTICE`。
- **禁止出现「已预订」「已确认」「已出票」**，也不要用同义说法暗示已经落实。
- 未知的时间 / 费用显示「未知」（`ASSISTANT_UNKNOWN_TEXT`），**不显示 0、不显示估计值**。
- 时段占位时刻必须标注来源：`ASSISTANT_SLOT_TIME_NOTICE`。
- 内存改动必须声明不落盘：`ASSISTANT_NO_SAVE_NOTICE`。
- 候选坐标留在候选库：`ASSISTANT_POOL_LOCATION_NOTICE`。
- 超出五类：`ASSISTANT_UNSUPPORTED_REASON`（礼貌拒绝，并指出可以在面板里完成）。
- 简称匹配命中时，提案卡必须写出**实际绑定到的全名**（「按『简称』匹配到第 N 天的『全名』」），
  不能让用户以为命中的是别处同名站点（§3.5）。

固定文案常量都从 `assistantDialog.ts` 导出，测试会扫一遍禁用词。

---

## 8. 零存储副作用

- `assistantDialog.ts` 在 **import 期与调用期都不访问 `localStorage`**：不 `setItem` /
  `removeItem` / `getItem`，不注册 `storage` 事件，不读时钟。它只 import 纯函数模块
  （`constraints` / `candidatePool` / `tripDraft` / `dayReplan` / `workspace` /
  `workspaceFingerprint`），其中 `tripDraft` 间接依赖的 `savedTrips` 在本模块的调用
  路径上只用到 `checkTripShape` / `savedTripRecordBytes` 两个纯函数。
- **在途提案零落盘**：生成提案、查看 diff、丢弃提案都不写任何 storage key。
- **应用只是内存 transition**：写不写盘由调用方决定，且必须由用户显式保存触发
  （沿用 `workspaceStorage.ts` 的 `saveWorkspaceRecord` 流程）。
- 本模块**不新增任何后端端点**：重排类提案复用既有的 `POST /api/trips/days/replan`。

---

## 9. 与既有模块的复用关系

| 既有模块 | 本模块复用了什么 |
|---|---|
| `constraints.ts` | `evaluateConstraintsAgainstTrip`（H/U 判定）、`ConstraintIssue`、`ConstraintTimeOrigin`、`normalizeConstraintTitle`（站点名匹配口径） |
| `candidatePool.ts` | `normalizeCandidateText`（候选名匹配口径）；候选坐标仍留在候选库 |
| `tripDraft.ts` | `createTripDraft` / `removeDraftStop` / `addDraftStop` / `applyDraft`：天级 copy-on-write、相邻路段重建、本地编辑摘要与提醒 |
| `dayReplan.ts` | `buildDayReplanRequest`：既有单日重排请求构造（端点不变） |
| `workspace.ts` | `commitWorkspaceTransition`（revision + 1 的原子切换）、`createWorkspaceRecord`（测试夹具） |
| `workspaceFingerprint.ts` | `fingerprintOf` / `fingerprintsMatch`（canonical 全量比较） |
| `workspaceTypes.ts` | `WorkspaceRecordV1`、`WorkspaceFingerprintV1`、`CandidateItemV1` |

**没有复用的地方（有意为之）**：

- 不复用 `tripDraft` 的 **fork id** 与 **undo 栈**：工作区只绑定一个行程，
  候选行程保留原 `trip.id`；撤销是工作区一层，不是草稿栈的一层。
- 不复用 `tripDraft` 的新增站点路径来**搬动**站点：跨天挪动会丢掉坐标，
  因此挪动后会把原站点对象放回去（含坐标），只让新相邻关系走 `unavailable` 路段。
- 不新建 `planScope`：对话编辑是整条行程范围的判定，不按单日作用域裁剪约束。

---

## 10. 公共 API

```ts
// 解析
parseAssistantIntent(text: string): AssistantParsedIntent

// 提案计算（纯函数；不改入参、不写存储）
buildAssistantProposal(input: AssistantProposalInput): AssistantProposalResult

// 应用 / 撤销 / 丢弃 / 确认
applyAssistantProposal(input: AssistantApplyInput): AssistantApplyResult
undoAssistantProposal(handle: AssistantUndoHandle, current: WorkspaceRecordV1, now: number): AssistantUndoResult
discardAssistantProposal(proposal: AssistantProposalCard): AssistantProposalCard
confirmAssistantUnverified(proposal: AssistantProposalCard, acknowledgedAt: number): AssistantProposalCard
isAssistantAckFresh(proposal: AssistantProposalCard, record: WorkspaceRecordV1): boolean

// 展示
describeAssistantChange(change: AssistantProposalChange): string
/** 简称匹配说明：按简称匹配到全名时给出一行核对文案（精确命中返回空数组）。 */
assistantStopMatchNotes(proposal: AssistantProposalCard): AssistantStopMatchNote[]
```

`AssistantProposalInput` 必填项（缺一个都不能生成提案）：

```ts
{
  proposalId: string
  instruction: string
  record: WorkspaceRecordV1
  candidates: readonly CandidateItemV1[]
  currentDay: number | null
  travelMode: TravelMode
  ids: { draftForkId: string; newStopId: string | null }
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
}
```

`travelMode`、`ids.draftForkId`、`ids.newStopId` 都**必须由调用方显式给出**，
本模块不猜出行方式、不生成随机 id（`createLogicalId()` 由调用方使用）。

---

## 11. 测试与验证

本批实跑（2026-11-07，Windows / pnpm / vitest 3.2.7）：

- `frontend/src/__tests__/assistantDialog.test.ts`：**25 passed**
- 全仓 `pnpm typecheck`（`tsc -b --force`）：**exit 0 / 无输出**

命令：

```powershell
cd frontend
pnpm --config.verify-deps-before-run=false vitest run src/__tests__/assistantDialog.test.ts
pnpm --config.verify-deps-before-run=false typecheck
```

覆盖重点：

- 五类指令各至少 1 个「解析 + 提案计算」用例；
- `unsupported` 解析为礼貌拒绝且不可应用；
- H 级禁 apply，且带 U 级确认也绕不过；
- U 级需独立确认，确认绑定快照，快照一变即失效；
- ABA：revision 变化 → `invalid`；revision 未变但内容变化 → `invalid`；
- 未知不补 0：时刻读不出就是 `null`，新增站点坐标 / 停留都是 `null`；
- 不采纳零写入：丢弃提案不碰行程、不碰存储（`Storage.prototype.setItem` 零调用）；
- 同名站点不唯一 → 列为未知改动，不替用户挑第一个；
- 简称匹配：唯一子串命中自动绑定并显示全名；多命中列候选转澄清；0 命中失败语义不变；
  大小写 / 空白归一化与 `normalizeConstraintTitle` 同口径；精确同名优先于简称；
- 撤销是一次 transition，revision 继续 +1，不恢复旧 revision；
- 文案不出现「已预订 / 已确认 / 已出票」。

**未跑**：full 前端 suite、build、E2E、backend pytest、浏览器验收。

### 11.1 关于全仓 typecheck

最终实跑全仓 `pnpm typecheck` 为 **exit 0 / 无输出**。

交付过程中曾短暂不是全绿：同一工作树里另一个并发任务正在改
`frontend/src/components/CandidatePoolPanel.tsx` 与
`frontend/src/components/ChecklistPanel.tsx`（同期新增
`frontend/src/lib/candidateSuggestions.ts`、`frontend/src/lib/checklistSuggestions.ts`），
其 `TS6133 / TS6192` 未使用导入错误一度使全仓 typecheck 失败。本批两个文件不 import
任何 components，与该并发任务无耦合；并发任务收敛后全仓 typecheck 回到 exit 0。

本批两个文件另有一轮**独立作用域类型检查**（exit 0 / 无输出），用于在并发改动期间
自证本批无新错：

```powershell
cd frontend
npx tsc --noEmit --pretty false --strict --noUnusedLocals --noUnusedParameters `
  --noFallthroughCasesInSwitch --target ES2022 --module ESNext `
  --moduleResolution bundler --jsx react-jsx --skipLibCheck `
  --verbatimModuleSyntax --lib ES2022,DOM,DOM.Iterable --types vite/client `
  src/lib/assistantDialog.ts src/__tests__/assistantDialog.test.ts
```

### 11.2 三期 S7b：站点简称匹配（2026-11-08，Temp 副本实跑）

- 定向：`assistantDialog.test.ts` + `AssistantDialogPanel.test.tsx` → **71 passed（2 files）**
- 全量（排除禁触的 `_indep-probe-0400.test.js`）→ **106 files / 2292 tests passed**
- `tsc -b --force` → **exit 0 / 无输出**；`vite build` → **exit 0**（唯一的 1.27 MB chunk
  体积告警与本期无关，是既有告警）
- 命令（junction `node_modules` 直跑同一套二进制，绕过 pnpm 11.25 的 deps 校验）：

```powershell
cd frontend
node node_modules/vitest/vitest.mjs run src/__tests__/assistantDialog.test.ts src/__tests__/AssistantDialogPanel.test.tsx
node node_modules/vitest/vitest.mjs run --exclude "**/_indep-probe-0400.test.js"
node node_modules/typescript/bin/tsc -b --force
node node_modules/vite/bin/vite.js build
```

---

## 12. 集成依赖 / 明确未做

面板层（后续 owner）需要：

1. 提供 `travelMode`、`ids.draftForkId`、`ids.newStopId`（可用 `createLogicalId()`）。
2. 生成提案后展示 diff：**已知改动 / 未知改动分两栏**，未知项显示「未知」。
3. H 级时**禁用**应用按钮，且不提供任何绕过入口。
4. U 级时要求用户单独勾选确认，确认调用 `confirmAssistantUnverified`。
5. 应用调用 `applyAssistantProposal`，成功后用返回的记录走工作区 transition；
   **持久化仍由用户显式保存触发**。
6. 重排类提案把 `replanApiRequest` 交给既有 `replanDay`（并按既有做法附带
   `planningConstraints`），端点不变。
7. 撤销用 `undoAssistantProposal`，只保留一层，不与行程草稿 undo 栈串联。
8. 在途提案期间的工作区变化（revision / 指纹）必须让面板把提案标记为失效，
   提示重新生成。

**未做**：App 接线、对话面板 UI、语音输入、E2E、后端改动、浏览器验收。

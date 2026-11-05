# 会话恢复 v2 × 工作区适配（W-R）

> 状态：**本批 writer 交付**。范围仅 `frontend/src/lib/sessionRestore.ts`、
> `frontend/src/lib/workspaceSessionRestore.ts`、
> `frontend/src/components/SessionResumePanel.tsx` 与对应测试 / 本文档。
> **未改** `App.tsx`、F1–F6 面板、`workspace*` 公共契约 / storage / transfer、
> api / runner / backend / 全局样式；App 接线由 W8 完成，浏览器真实 reload 由
> W8 / E2E 验证。契约权威仍是 `docs/WORKSPACE_SIDECAR.md`，存储实现见
> `docs/WORKSPACE_STORAGE.md`。
>
> 2026-11-06 R1/R2 文档修订：`currentWorkspace` 只取内存 authority；确认前
> fresh-read 恢复会话 raw；组合预览的 proposal 与 confirm 需要的 prepared 区分。
> 本次只改文档，源码 / 测试 hash 不变。

适用基线：`F:/MunderDifflin/Travel-Assistant/LangGraph-Smart-Traval-Assitant`。
本批开工时工作区 HEAD 为 `fbc19d2ed696787ae72403f7f044009f9364ed75`
（S1 契约与其他 feature 已在其上推进）。

---

## 1. 交付边界

- **v1 原字节 / 原行为不变**：没有 workspace 的 payload 仍写 outer version 1，
  `session` 只有 `trip / draft / budget / ui` 四键；旧读取器可继续读。
- **有 workspace 才写 v2**：outer version 2，`session.workspace` 只含
  `workspaceId / ownerId / workspaceRevision / updatedAt / sidecar / meta` 六键；
  Trip 仍在 `session.trip`，手工预算仍在 `session.budget`，**不重复**。
- **读取同时支持 v1 / v2**：v1 的 workspace 明确为 `null`；v2 的 workspace 必须是
  `null` 或通过公共 `rehydrateWorkspaceFromSession` 重建的完整记录。
- **不自动挂接**：v1 不按 `tripId` / 短 hash 读 `KEY_WORKSPACE`，也不把工作区库里的
  其它 sidecar 挂到恢复出的 Trip；没有 workspace 时父层按旧兼容逻辑处理为新空
  sidecar，**不能携带前一个 Trip 的 anchors / constraints / checklist / applies**。
- **只恢复当前有效已应用工作区**：候选库、版本库、在途 AI / 草稿候选、版本快照
  都不进入会话 payload；本文不声称“全库恢复”。
- **default-off 不变**：flag 不是 `'1'` 时只读 flag 键，不读内容键；既有显式
  “检查本机恢复副本”仍是唯一管理例外。任何候选库 / 版本库面板动作都不得借机
  读取恢复 raw。
- **不写第四工作区库**：本模块不建 localStorage 键、不自动开启恢复、不改 flag。

---

## 2. v1 / v2 格式

### 2.1 无 workspace（v1，原样）

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

- `session` 只认四键；出现 `workspace` 仍按旧严格协议 `invalid`。
- `Trip` 不扩字段；费用 / 草稿 / ui 的既有严格校验不变。

### 2.2 有 workspace（v2）

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

- `workspace` 键**必须存在**；`null` = v2 但未关联工作区，合法读取。
- 块内字段集合严格为六键；`trip` / `budget` / 其它未知字段一律 `invalid`。
  这避免“块内 Trip/预算与外层重复且冲突”时静默选一份。
- 重建时 `tripId = session.trip.id`，`trip = session.trip`，`sidecar` 原样，
  `budget` 按 §3 映射；整条记录再走 `validateWorkspaceRecord`（Trip 640 KiB、
  sidecar 512 KiB、整条 record 2 MiB）。
- **不做 checklist salvage**：`sidecar.checklist` 损坏时整份 payload `invalid`，
  原 raw 保留，提示到已保存工作区人工修复；不自动写空清单，也不展示“恢复成功”。
- 其它 sidecar 段（anchors / constraints / applies / budget / meta）任一损坏同样
  整份 `invalid`，不部分恢复。

---

## 3. 预算映射（唯一口径）

`sessionRestore.sessionBudgetSnapshot(block, tripId)`：

| session.budget | 映射到 workspace.budget |
|---|---|
| `null` | `null` |
| `binding.kind === 'current'` 且 `binding.tripId === tripId` | `{ budgetRaw, rows }`（用户原字符串原样） |
| `binding.kind === 'stale'` | `null` |
| `binding.kind === 'unbound'` | `null` |
| `current` 但 tripId 不同 | 读取端已 `invalid`；纯函数安全返回 `null` |

- `null` 是明确无预算，不是 0；空快照与 null 不互相替代。
- 不解析金额、不补 0、不改写原字符串。
- v2 写入要求 `workspace.budget` 与上述映射**完全一致**；不一致 →
  `workspace_conflict`，不写 v1 降级、不静默选一份。
- 既有 UI 的 `previewSessionResume` 仍会为 stale 预算构造只读展示 session；
  但工作区记录里的预算保持 `null`。父层不要把 stale / unbound 行写进当前
  Trip 的 workspace 记录。

---

## 4. sessionRestore.ts 实际导出（本批新增 / 变更）

```ts
// 常量
SESSION_RESUME_VERSION = 1
SESSION_RESUME_VERSION_V2 = 2
MAX_SESSION_RESUME_BYTES = 1_572_864             // v1 写入上限，旧行为
MAX_SESSION_RESUME_RAW_BYTES = 1_572_864 + 64 KiB
MAX_SESSION_RESUME_V2_BYTES = 3_145_728           // v2 外层独立上限
MAX_SESSION_RESUME_V2_RAW_BYTES = 3_145_728 + 64 KiB
MAX_SESSION_TRIP_BYTES = 655_360                  // 既有单 Trip 口径

// 类型（增量）
interface SessionResumePayload {
  trip; draft; budget; ui
  workspace?: WorkspaceRecordV1 | null   // null / 省略 = 写 v1
}
interface SessionResumeRecord {
  savedAt; session: { trip; draft; budget; ui; workspace?: WorkspaceRecordV1 | null }
}
type SessionResumeLoad =
  | { status: 'pending'; version?: 1 | 2; record; raw }
  | ...

// 函数
sessionBudgetSnapshot(block, tripId): BudgetSnapshotV1 | null
buildPayloadFromSession(input): SessionResumePayload | null   // input 新增可选 workspace
writeSessionResume(input, storage): SessionWriteResult
// input.allowWorkspaceDrop?: boolean —— 仅用户明确删除 / 放弃工作区数据时设 true；
// 否则当前 v2 被无 workspace 的 write 覆盖时 workspace_conflict 保旧，防静默降级。
loadSessionResumeRecord(storage): SessionResumeLoad
// 既有 previewSessionResume / rebuildDraftFromTrip / rebuildBudgetSession / 删除 / flag 不变
```

### 4.1 写入门禁顺序

1. workspace 若存在：`validateWorkspaceRecord` + `workspaceMatchesSessionPayload`
   （Trip 内容 + 预算映射），失败 `workspace_invalid` / `workspace_conflict`；
2. 整包可序列化，失败 `snapshot_failed`；
3. v1 ≤ 1.5 MiB / v2 ≤ 3 MiB，失败 `too_large`；
4. Trip 单记录 ≤ 640 KiB，失败 `too_large`；
5. 写出的 Trip 过 `checkTripShape`；v2 还按**实际写出的字节**重新解析
   `session.workspace` 并用 `rehydrateWorkspaceFromSession` 完整重建，失败
   `workspace_invalid`；
6. 写前重读与 `expectedRaw` 逐字节相等，否则 `conflict`；
7. 单次 `setItem`；quota / SecurityError → typed 失败。

任一步失败旧 raw 不变；**不自动删除旧副本、不驱逐、不写半截**。

### 4.2 读取状态

| 状态 | 条件 |
|---|---|
| `disabled` | flag ≠ `'1'`；不读内容键 |
| `empty` | 键不存在 / 空串 / 全空白 |
| `corrupt` | 非 JSON、顶层非对象、raw 超安全读上限 |
| `unknown_version` | format 不符或 version ∉ `{1, 2}` |
| `invalid` | 顶层 / session 未知键、缺 trip、draft / budget / ui / workspace 任一非法、v2 缺 workspace、sidecar 损坏（含 checklist） |
| `unavailable` | 无 storage / getter 抛 SecurityError 等 |
| `pending` | 全部严格通过；附 `version`、`raw`、完整 `record.session.workspace` |

读取永不写存储；`invalid` / `corrupt` / `unknown_version` 原字节保留。

---

## 5. workspaceSessionRestore.ts（新增纯适配）

```ts
prepareSessionWorkspaceRestore(input): PreparedSessionWorkspaceRestore
previewSessionResumeWithWorkspace(input): PreviewSessionResumeWithWorkspaceResult
confirmSessionWorkspaceRestore(
  prepared,
  currentWorkspace,
  epoch,
  options?: { currentRaw?: string | null },
): SessionWorkspaceConfirmResult
```

`options.currentRaw` 是 App 在确认前**重新读取**恢复会话内容键得到的 fresh raw，
不是 preview 时的 `load.raw`；传入时必须与 prepare 冻结的 `frozen.raw` 逐字节相等，
否则 `input_changed`。`confirmSessionWorkspaceRestore` 是纯函数，**不自行读 storage**；
省略 `currentRaw` 表示调用方已在外部完成并验证了同一 raw 的 CAS，本 helper 不再检查。
正式 App 路径必须传 fresh raw；省略只保留给已验收的旧 / 兼容调用方。本批不新增严格
wrapper（没有真实调用证据）；若后续确需，先报告再定。把 prepare 的 `load.raw` 原样
传回只能证明它与自身相等，不能证明未被外部更新；fresh raw 与 prepare 冻结值不同
（例如 B vs A）→ `input_changed`，旧状态不动。

输入：

```ts
interface PrepareSessionWorkspaceRestoreInput {
  session: SessionResumeRecord['session']   // load 产出的完整 session
  savedAt: number | null
  raw: string | null                        // 本次 load 实际读到的 raw（冻结）
  currentWorkspace: WorkspaceRecordV1 | null // 当前内存已应用记录；不是持久库记录
  epoch: number                             // 与 currentWorkspace 同一内存 authority
  now: number
}
```

`currentWorkspace` 永远是 controller 当前**内存**已应用记录（`workspaceRef.current` /
`workspaceController.workspace`）；没有就是 `null`。不要把 `loadWorkspaceRecord()`
读到的持久记录直接当成内存 authority：持久 revision 只属于独立存储的 CAS / 冲突
背景，不是 restore transition 的 revision 基准。只有用户显式“加载工作区”并已应用到
内存后，该记录才成为 `currentWorkspace`。

结果：

- `{ ok:true, status:'no_workspace', frozen, message }`：v1 或 v2 `workspace:null`。
  父层沿用旧 `previewSessionResume` 流程；不读 `KEY_WORKSPACE`、不按 tripId/hash
  挂 sidecar。
- `{ ok:true, status:'ready', proposal }`：完整整体提案。
- `{ ok:false, reason, message }`：`workspace_invalid / trip_mismatch /
  budget_mismatch / revision_limit / epoch_limit / unserializable`；无副作用。

`proposal` 关键字段：

```ts
{
  transition: 'commit_same_trip' | 'new_workspace' | 'replace_trip'
  record: WorkspaceRecordV1        // 唯一目标状态（Trip + sidecar + budget + meta）
  identity / owner / snapshot
  frozen: { raw, savedAt, workspace: fingerprint }   // 完整 canonical，不是短 hash
  current: { record, capture, owner }               // 引用门 + owner 内容快照
  previousWorkspaceRevision
  nextWorkspaceRevision
  apply: {
    trip; sidecar; budget; workspaceId; ownerId; tripId;
    workspaceRevision; meta;
    atomic: true;
    requiresEpochAdvance: true;
    epochBefore; suggestedEpochAfter;
  }
}
```

规则：

- **revision = 当前内存工作区 revision + 1**（无当前内存工作区时从 1 开始）；绝不采用
  `session.workspace.workspaceRevision` 里的旧值，也不采用持久库记录的 revision。
  持久 revision 只在后续显式保存时用于 storage 的 CAS / 冲突判断。达到安全整数上限
  typed 失败。
- 当前工作区与恢复行程**同一 trip**：调用公共 `commitWorkspaceTransition`，一次换
  Trip + sidecar + budget，保留当前 `workspaceId / ownerId / meta.createdAt`。
- 当前工作区是**另一个 trip**：生成 `replace_trip` 新记录（identity / meta 来自会话
  快照），但仍用当前 revision + 1；父层必须把它当成显式换行程再确认。
- 当前**内存**无工作区：`new_workspace`，revision 从 1 开始；这不代表 storage
  没有旧记录，后续保存仍需显式处理冲突。
- `confirm` 先 `workspaceRuntimeRefsMatch`（实际 record/trip/sidecar/budget 引用 +
  epoch + 冻结 raw），再 `workspaceOwnerMatches`（完整 canonical）；同内容新对象、
  A-B-A（epoch 已推进）、外部更新均拒绝，旧确认失效。
- prepare 后 current 从 `null → record` 或 `record → null`、同内容新引用、epoch 变化
  → `current_changed` / `epoch_changed`；旧 proposal 不得复活。
- `confirm` 成功返回 `record`（同一对象）、`owner`（新 epoch）、`runtime`（新 epoch）
  与 `nextEpoch`；App 必须用它自己的 ref 实际推进 epoch，并作废全部旧 pending。
- `previewSessionResumeWithWorkspace` 先跑既有 `previewSessionResume`，再跑
  prepare；任一失败整份失败，**不返回半份恢复方案**。返回的 `base` 是既有草稿 /
  预算 / UI 预览；`workspace` 是整体记录提案。
- **API 形状注意**：`previewSessionResumeWithWorkspace().workspace` 是
  `SessionWorkspaceRestoreProposal`，不是 `confirmSessionWorkspaceRestore` 需要的
  `PreparedSessionWorkspaceRestore` ready 对象。确认路径必须使用
  `prepareSessionWorkspaceRestore` 的返回值（见 §5.1）；组合预览只适合只读展示。

### 5.0 当前工作区 authority（R1）

- `currentWorkspace` 永远是 controller 当前**内存**已应用记录；没有就传 `null`。
- 恢复预览**不读** `KEY_WORKSPACE`，也不调用 `loadWorkspaceRecord()` 决定 revision。
- 持久库记录只有在用户显式“加载工作区”并已应用到内存后，才成为内存 current。
- 持久记录的 `workspaceRevision` 是独立存储的 CAS / 冲突背景，不是 restore
  transition 的基准；restore 的 revision 只取内存 current 的 revision + 1（无内存
  current 从 1 起）。
- 内存 current 与持久库分叉（内存 rev3、库 rev1）时，以内存 rev3 为基准得到 rev4；
  不得回退到库 rev1 得到 rev2。
- 内存无记录但库有旧记录：恢复按 `new_workspace` 处理；恢复本身只改内存，后续保存
  必须由用户显式处理 storage 冲突（加载/应用旧记录或解除/新建），不得静默覆盖。

### 5.1 父层 / W8 必须步骤

1. 保持现有 default-off 启动逻辑：flag 关闭只读 flag 键，不读内容键。
2. 组装 `currentWorkspace`：只取 controller 的**当前内存已应用记录**
   （`workspaceRef.current` / `workspaceController.workspace`），没有就是 `null`。
   **不要**为了恢复预览调用 `loadWorkspaceRecord(storage)` 或把持久记录当成内存
   authority；持久 revision 不是 restore 的基准。只有用户显式“加载工作区”并已应用
   到内存后，该记录才进入 `currentWorkspace`。若内存无记录但库里有旧工作区，
   prepare 会按 `new_workspace`（revision 1）处理；后续保存必须由用户显式解决
   存储冲突，不能静默覆盖。
3. 调 `prepareSessionWorkspaceRestore({ session, savedAt, raw, currentWorkspace, epoch, now })`
   拿到**可确认的** `prepared`；若还需要旧草稿 / 预算 / UI 预览，另用
   `previewSessionResume(load.record, tripRevision + 1, { allowWorkspace: true })` 拿
   `base`。这里显式 `allowWorkspace` 只用于拿 base，工作区仍由 `prepared` 整体确认，
   不是单独 `setTrip`。`previewSessionResumeWithWorkspace()` 的 `workspace` 字段只是
   `SessionWorkspaceRestoreProposal`，**不是** confirm 需要的
   `PreparedSessionWorkspaceRestore` ready 对象；它适合只读展示，不能直接传给
   confirm。确认路径必须保留这次 `prepared`，不要重新 prepare 后再 confirm（会丢掉
   prepare → confirm 的时间门）。
4. `prepared.status === 'no_workspace'`：用 `base` 沿用旧 Trip/草稿/预算/UI 恢复；
   sidecar 视为空，**不读取工作区库**、不按 tripId/hash 挂接。
5. `prepared.status === 'ready'`：把 `prepared.proposal.apply` 的 Trip + sidecar + budget
   作为唯一目标状态；**确认成功前不要安装**。禁止先 `setTrip(record.trip)` 再单独写
   sidecar 或 budget。`base.budget` 是既有 UI 费用 session（stale 可能只读展示）；
   `prepared.proposal.record.budget` 才是工作区持久快照（仅 current 映射）。
6. 用户确认后，在**同一个同步事件处理器**里重新读取恢复会话键（按现有 flag / 显式
   管理权限），把 fresh raw 传给 confirm；**不要**复用 prepare 时的 `load.raw` 充当
   fresh：

   ```ts
   const fresh = loadSessionResumeRecord(storage)
   if (fresh.status !== 'pending') {
     // disabled / empty / corrupt / unknown_version / invalid / unavailable
     // 一律保旧：不改内存、不写 storage、不作废旧状态
     return
   }
   const confirmed = confirmSessionWorkspaceRestore(
     prepared,                       // 不是 preview.workspace（后者只是 proposal）
     workspaceController.workspace,  // 与 prepare 同一个内存 record 引用
     workspaceEpochRef.current,      // 与 prepare 同一个 epoch
     { currentRaw: fresh.raw },      // 必须 fresh
   )
   if (!confirmed.ok) return          // input_changed / current_changed / epoch_changed ...
   ```

   fresh read → confirm → 整体内存 apply 之间**不得插入 await**；若业务上必须 await，
   必须在 await 后重新 fresh read 并重新 confirm。外部 flag 关闭、corrupt、unknown、
   invalid、unavailable 都保持旧状态，不“尽量恢复一半”。confirm 失败 → 不改 App
   状态、不写 storage。
7. confirm 成功：用 controller 的 **in-memory 记录装载缝**（等价于现有
   `applyRecord(record, 'in_memory', nextEpoch)`）安装 `confirmed.record`；**不要**再调
   `applyTripChange` / `commitWorkspaceTransition`，因为
   `confirmed.record.workspaceRevision` 已经是「当前 +1」，再 transition 会变成 +2。
   装载时保留 controller 的
   `workspaceRawRef` / `workspaceCanonicalRef`（它们代表 storage 基线，恢复本身不
   写 storage），只更新内存 `workspaceRef` / state / epoch；然后作废 AI / 地图 /
   路线 / 预算 / 备份全部旧 pending。
8. `transition === 'replace_trip'`（当前**内存**工作区属于另一行程）：这是显式换
   行程的内存恢复；storage 里的旧工作区记录仍在。父层必须先让用户明确选择“解除旧
   工作区 / 新建工作区”再做持久保存；**不要**把它当同工作区直接
   `saveWorkspaceRecord`（identity 不同会被 storage `owner_conflict` 拒绝）。
   `new_workspace` 同理，第一次保存是新建写入，不是覆盖。
9. 持久保存仍是用户显式“保存工作区”动作：单次
   `saveWorkspaceRecord(record, { storage, locks, expectedRaw, expectedBaseCanonical })`；
   成功后才更新持久标志。恢复动作本身不写 `KEY_WORKSPACE`。
10. 自动留存 / 放弃恢复并开始留存也必须把当前已应用工作区传给
    `buildPayloadFromSession({ ..., workspace: workspaceController.workspace })`；
    否则会写回 v1。只有用户明确“放弃旧副本 / 删除工作区数据”时才可传
    `allowWorkspaceDrop: true`。
11. 侧边栏只展示 `record.sidecar`；不得把候选库 / 版本库 / 其它 pending 混入
    “已恢复”文案。

---

## 6. 容量

| 口径 | 值 | 说明 |
|---|---:|---|
| `MAX_SESSION_RESUME_BYTES` | 1 572 864（1.5 MiB） | **v1 写入上限，不变** |
| `MAX_SESSION_RESUME_RAW_BYTES` | 1.5 MiB + 64 KiB | v1 读取安全上限，不变 |
| `MAX_SESSION_RESUME_V2_BYTES` | 3 145 728（3 MiB） | v2 外层独立上限 |
| `MAX_SESSION_RESUME_V2_RAW_BYTES` | 3 MiB + 64 KiB | v2 超长 raw 先挡解析 |
| `MAX_SESSION_TRIP_BYTES` | 655 360（640 KiB） | 单 Trip，v1/v2 同尺 |
| `MAX_WORKSPACE_RECORD_BYTES` | 2 097 152（2 MiB） | 公共记录上限，v2 重建仍执行 |
| `MAX_WORKSPACE_SIDECAR_BYTES` | 524 288（512 KiB） | 公共 sidecar 上限 |

**为什么 v2 是 3 MiB 而不是沿用 1.5 MiB**：

- 合法工作区记录本身允许 2 MiB（Trip 640 KiB + sidecar 512 KiB + budget/meta 余量）；
- v2 外层还要携带未应用草稿（最多约 640 KiB）与 ui/envelope 开销；
- 3 MiB = 2 MiB 记录 + 640 KiB 草稿 + 64 KiB 余量。它不会把合法
  `640 KiB Trip + 512 KiB sidecar` 截掉，也不是无限大；超过仍 `too_large` 保旧。
- 记录本身仍单独跑 `validateWorkspaceRecord`，所以“外层 3 MiB”不等于放宽
  sidecar / record 公共上限。

---

## 7. 失败与安全语义

- **未知版本**（v3+）→ `unknown_version`，原字节保留，不自动迁移。
- **v1 未知键 / v2 块内未知字段** → `invalid`，不丢字段“清洗”。
- **checklist 段损坏** → `invalid`，不 salvage；提示人工修复已保存工作区；
  不自动写空清单。
- **同内容新引用 / A-B-A** → confirm 的 ref + epoch 门拒绝。
- **外部 tab 更新** → prepare 冻结 raw；确认前 fresh 重读恢复会话键并与冻结值比对
  （`input_changed`）；本模块不监听 storage 事件，也不把 prepare 时的 `load.raw`
  当作新鲜读取。
- **quota / getter 抛错 / 容量超限** → typed 失败，旧 raw 不变，不自动驱逐。
- **不声称 localStorage CAS**；跨 tab 仍靠“冻结 raw + 重读比对 + 拒绝”。

---

## 8. 测试与独立验收

目标测试：

```powershell
cd frontend
npx vitest run src/__tests__/sessionRestore.test.ts src/__tests__/sessionRestoreWorkspace.test.ts src/__tests__/SessionResumePanel.test.tsx src/__tests__/SessionResumeWorkspacePanel.test.tsx --no-cache
```

覆盖：

- v1 原四键 / 原 raw 行为；v1 `workspace` 键仍 invalid；
- v2 六键块、无 Trip/预算重复、完整往返、constraintId 保留；
- budget current / stale / unbound / null 映射与冲突 fail closed；
- 缺 workspace、块内未知字段、缺字段、checklist 损坏；
- v2 > 1.5 MiB 合法读写；> 3 MiB `too_large` 保旧；
- 未知版本 / 坏 JSON / getter 抛错保旧；
- default-off 只读 flag；v1 读取不碰 `WORKSPACE_STORAGE_KEY`；
- prepare / confirm 同 trip revision+1、无工作区 revision=1、换 trip replace、
  同内容新引用 / epoch 变化拒绝；v1 no_workspace 不自动挂接。

源码批次 writer 自测：目标 4 个测试文件 **71 passed**；另跑既有
`AppSessionRestoreIntegration.test.tsx` **37 passed**，合计 108 passed。
类型检查：项目 `tsc -p tsconfig.app.json --noEmit` 仍被其它 owner 的 WIP
（`WorkspaceController.test.ts`）挡住；用批准的 Temp scoped tsconfig 只编译本批
文件 + 测试 setup 时 **0 error**。当前工作区其它 owner 的 WIP 不在本批范围。

独立非作者验收（2026-11-06 04:18 / 04:21）已实跑同一 5 文件 **108 passed**，并完成
5 个探针：revision 基准（内存 rev3 / 库 rev1 时以内存 rev3+1，不回退到 rev2）、
`currentRaw` 省略语义、`new_workspace` epoch 门、current 出现/消失、v1 读字节边界。
本次 R1/R2 修复只改文档，不改源码 / 测试；六文件源码 hash 保持不变。App 集成测试
仍需按 §5.0 / §5.1 覆盖“内存 rev3 vs 持久 rev1 不回退”“fresh raw B vs prepare A 拒绝”
“current 出现/消失 / 引用+epoch 变化拒绝”“v1 off 零内容键读取”。

**未跑**：全量前端 suite / build / E2E / backend / 浏览器真实 reload。App 接线与
浏览器恢复门由 W8 / E2E 完成；本批不声称六个 feature 已整体交付。

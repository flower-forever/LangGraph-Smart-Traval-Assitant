# 工作区三库存储与导入 adapter（S1 存储切片）

> 状态：**存储 / 备份 / 导入 adapter 与本批目标测试已完成**；**不是**完整 feature 上线。
> 本文只描述 `frontend/src/lib/workspaceStorage.ts` / `workspaceTransfer.ts` 的已实现能力、
> 失败语义与集成依赖。App 接线、`sessionRestore.ts` 新 payload 接线、F1–F6 面板与 E2E
> 仍由各自 owner 完成。契约权威仍是 `docs/WORKSPACE_SIDECAR.md`。

适用基线：`F:/MunderDifflin/Travel-Assistant/LangGraph-Smart-Traval-Assitant`，
本批修复时 HEAD `57249fb692cff633181dc28531eacd5352d07815`。

---

## 1. 边界

- **三个键、三条记录、各自一次 `setItem`**：工作区、候选库、版本库互不打包。
  不存在跨三键事务、顺序写三键后补偿 rollback、或一键全套恢复。
- **模块 import 不读 localStorage**。只有显式调用 `load*` / `save*` / `prepare*` /
  `confirm*` / `undo*` 才访问存储；没有 `storage` 事件监听、没有自动恢复、没有自动保存。
- **工作区记录 = Trip v1 + sidecar + budget + owner/revision/meta**；不提供直接
  `setTrip` 的入口。Trip 类型与 `checkTripShape` 仍是既有 v1 门禁。
- **不自动驱逐旧数据**。容量 / quota / 损坏 / 未知版本失败时，原始字节保持不变。
- **短 hash 不参与权威判定**。本 adapter 的导入冻结使用完整 raw 与完整 canonical JSON，
  不使用短 hash 自动挂接 / 自动恢复。
- **`null` 不是 `0`**：预算 `null` 与空预算、约束 `durationMinutes:null` 与 `0`
  在读写中保持区别。
- 旧 Trip JSON / ICS / Markdown / savedTrips 接口不改；旧 Trip 导入**不会**自动挂 sidecar。

---

## 2. 键与容量

实际导出名以 `workspaceTypes.ts` 为准：

| 库 | 键 | 写入对象 | 上限 |
|---|---|---|---|
| 工作区 | `WORKSPACE_STORAGE_KEY` = `travel-assistant:workspace:v1` | 一条 `WorkspaceRecordV1` | 2 MiB |
| 候选库 | `CANDIDATES_STORAGE_KEY` = `travel-assistant:workspace:candidates:v1` | 一条 `CandidatesRecordV1` | 256 KiB / 200 条 |
| 版本库 | `VERSIONS_STORAGE_KEY` = `travel-assistant:workspace:versions:v1` | 一条 `VersionsRecordV1` | 4 MiB / 10 个 / 单快照 2 MiB |

备份文件上限（含 envelope wrapper，按实际 UTF-8 字节）：

| 备份 | 常量 | 上限 |
|---|---|---|
| 工作区 | `MAX_WORKSPACE_BACKUP_FILE_BYTES` | 2 MiB |
| 候选库 | `MAX_CANDIDATES_BACKUP_FILE_BYTES` | 512 KiB |
| 版本库 | `MAX_VERSIONS_BACKUP_FILE_BYTES` | 8 MiB |

读取 raw 的额外安全上限（只影响超长坏数据的解析）：

- `MAX_WORKSPACE_RAW_READ_BYTES` = 工作区记录上限 + 64 KiB；
- `MAX_CANDIDATES_RAW_READ_BYTES` = 候选库上限 + 64 KiB；
- `MAX_VERSIONS_RAW_READ_BYTES` = 版本库上限 + 64 KiB。

容量一律按**真实要写入的紧凑 JSON 字符串**的 UTF-8 字节计算；中文、emoji 按真实
UTF-8 计。容量是最大允许，不是浏览器 quota 保证。

---

## 3. 读取状态 union

`workspaceStorage.ts` 导出：

```ts
type WorkspaceReadStatus =
  | 'ok' | 'empty' | 'unavailable' | 'corrupt' | 'anomaly' | 'unknown_version'
```

- `loadWorkspaceRecord(storage?) : WorkspaceRecordRead`
- `loadCandidatesRecord(storage?) : StoreRead<CandidatesRecordV1>`
- `loadVersionsRecord(storage?) : StoreRead<VersionsRecordV1>`

| status | 条件 | 行为 |
|---|---|---|
| `ok` | 严格 validator 通过 | 返回记录、原始 `raw`、UTF-8 `bytes` |
| `empty` | 键不存在 / 空串 / 全空白 | 不伪造空记录 |
| `unavailable` | 无 localStorage / getter 抛 SecurityError 等 | 不崩、不假装已保存 |
| `corrupt` | 非 JSON、外层不是对象、format 不对、version 缺失、raw 超安全读上限 | 保留原字节，只读不写 |
| `anomaly` | 外层可识别，但内部条目 / 重复 / 超限 / 未知字段不合法 | 保留原字节，普通写入与导入拒绝 |
| `unknown_version` | format 正确但 `version` 不是 1 | 保留原字节，不自动迁移 / 覆盖 |

**清单段唯一的 salvage**：工作区 raw 可解析、Trip 与其它段合法、只有
`sidecar.checklist` 不合法时，`status:'anomaly'` 会附带
`salvage: { record, checklistDamaged: true }`。该记录里的清单被替换为空清单，
**只用于只读展示**；`raw` 仍是原始字节。普通保存、导入、版本采用都会拒绝，
不会把空清单写回。其它任何段损坏都不 salvage。

---

## 4. 显式保存

### 4.1 工作区

```ts
await saveWorkspaceRecord(record, {
  storage,                     // 省略时用 window.localStorage；null = 明确不可用
  locks,                       // Web Locks；省略时尝试 navigator.locks；null = 拒写
  expectedRaw,                 // 调用方读到的当前 raw；未写过的键用 null
  expectedBaseCanonical,       // 可选：当前完整工作区 canonical
})
```

- **一次 `setItem`**；`setItem` 成功返回后才报告 `{ ok:true, status:'saved' }`。
- `current` 为 `ok` 时，必须：
  - `workspaceId / ownerId / tripId` 与当前一致；
  - 提交字节与持久 raw **完全一致** → 幂等 `saved`：不重写、不推进 generation；
  - 否则 `workspaceRevision` 必须是合法安全整数，且**严格大于**持久值。允许
    `persist rev 0 → memory rev 3 → 一次显式保存`（多次未保存 transition 不强制逐次落盘）；
  - 同 revision 但字节不同、revision 倒退或非安全整数 → `revision_conflict`。
- `current` 为 `empty` 时允许首次写入合法记录。
- `expectedRaw` 与提交时 fresh read 不完全一致 → `conflict`。
- `expectedBaseCanonical` 不一致 → `conflict`。
- `current` 为 `corrupt / anomaly / unknown_version` → 同名 typed 拒绝，原字节不动。
- 所有失败（quota / blocked / unavailable / lock / 校验 / 超限）都不写半截、不驱逐旧数据，
  也不推进 generation。
- 幂等判断只认**完整持久字节相等**；不因为 revision 相同就假定内容相同。

### 4.2 候选库 / 版本库

```ts
await saveCandidatesRecord(record, { storage, locks, expectedRaw, expectedBaseCanonical? })
await saveVersionsRecord(record, { storage, locks, expectedRaw, expectedBaseCanonical? })
```

各自只读自己的键、只写自己的键；不触碰工作区或另一个库。失败语义同工作区
（除 revision / owner 规则不适用）。

---

## 5. 三个独立备份文件

`workspaceTransfer.ts` 的纯函数（**不读 localStorage**）：

```ts
createWorkspaceBackupFile(record, now)
parseWorkspaceBackupText(text, { maxBytes? })
createCandidatesBackupFile(record, now)
parseCandidatesBackupText(text, { maxBytes? })
createVersionsBackupFile(record, now)
parseVersionsBackupText(text, { maxBytes? })
```

- envelope 分别使用 `travel-assistant.workspace.backup` /
  `.candidates.backup` / `.versions.backup`，`version: 1`。
- 文件上限按**实际文本 UTF-8 字节**；`parse` 在 JSON.parse 之前先量体积，并把实际
  `bytes` 传给 `validate*Backup`，所以 wrapper 开销被明确计入。
- `create*` 校验内部记录 + 完整 envelope 后才返回 `{ text, bytes }`；预览与下载应使用
  同一份 `text`，不重新生成。
- 旧 Trip JSON / savedTrips 列表 / 其它库 envelope 都会 `format_mismatch`，不会被误认。
- 工作区备份默认只含 workspace；候选 / 版本各自独立，不合并。

---

## 6. 导入：prepare → confirm → 一次 undo

### 6.1 prepare（预览，不写）

```ts
const preview = prepareWorkspaceImport(text, { storage, locks })
const previewC = prepareCandidatesImport(text, { storage, locks })
const previewV = prepareVersionsImport(text, { storage, locks })
```

prepare 会：

1. 解析并严格校验备份；
2. 显式读取当前库，冻结 `previousRaw`；
3. 工作区额外冻结 `workspaceId / ownerId / tripId / workspaceRevision` 与
   `nextRevision`（当前 +1；空库从 1 开始）；
4. 冻结导入记录的完整 canonical JSON（不是短 hash）；
5. 返回 `writeReady`（当前是否有可用锁管理器）。

prepare **不写任何键**。当前库为 `corrupt / anomaly / unknown_version` 时返回
`source_store_blocked`，不用导入数据覆盖原始字节。

### 6.2 confirm（显式写入）

```ts
const confirmed = await confirmWorkspaceImport(preview, {
  storage, locks, now: Date.now(), undoTtlMs?, // 1..60 分钟
})
```

confirm 在同一把锁内：

- 先核对 prepare 时冻结的**同页写代际（generation）**；期间本页有成功
  write / confirm / undo 或显式失效 → `import_superseded`，不写；
- fresh read 当前 raw，必须与 `previousRaw` **逐字节相同**；
- 工作区再核对 `workspaceRevision / ownerId / workspaceId / tripId`；
- 再核对导入记录的完整 canonical 未变化（预览对象被改 → `input_changed`）；
- 重新校验容量，构建新记录：Trip + sidecar + budget 原样，`updatedAt = now`，
  `workspaceRevision = 当前值 + 1`（导入仍按 current + 1，不回放备份旧 revision；
  普通 `saveWorkspaceRecord` 才允许严格单调跳号）；
- **一次 `setItem`**；成功后推进该库 generation，并返回写入记录 + 一次性 undo 句柄。

候选 / 版本 confirm 同样核对 generation + raw + 完整 canonical，只是没有 revision / owner 重写。
confirm 需要锁；无锁 → `lock_unavailable`，原数据不变。重复 confirm →
`import_already_confirmed`（终态句柄保留到下一次 prepare 前统一清理，不退化成
`import_expired`）。

### 6.3 取消、显式失效与 undo

```ts
cancelPreparedImport(preview)        // 之后 confirm → import_cancelled
invalidatePreparedImport(preview)    // 之后 confirm → import_superseded
await undoImport(confirmed.undo, { storage, locks, now: Date.now() })
// undoImport 是 undoStorageCommit 的语义别名
```

- 一次 undo 只恢复这次 import **之前**的 raw；恢复前先在锁内核对写代际：
  import 之后本页若有其它成功写入 / 显式失效 → `import_superseded`，即使 raw
  已被完整恢复成旧值也不复活（防同页 ABA）。
- 代际通过后 fresh read，当前 raw 仍须等于 import 写入的 raw；其它 tab 已更新 →
  `conflict`，不覆盖 B。
- 已撤销过 → `undo_used`；超过 `undoTtlMs` → `undo_expired`。
- 原状态为空时恢复为 `removeItem`（有 try/catch）；失败可重试，成功后句柄才标记已用。
  成功 undo 会推进该库 generation，并释放句柄里的大块 raw（保留轻量 used 标记，
  下一次 issueUndo / prune 时清理）。
- **不做**跨三库 undo，也不把 undo 当成版本回退。
- 终态 pending import（confirmed / canceled / superseded）不在发生时立即删除，
  而是在下一次 prepare 前统一 prune：这样重复 confirm / cancel 能返回准确 reason，
  内存也不会随预览次数无界增长。

---

## 7. 跨 tab 锁语义（重要）

```ts
interface WorkspaceLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T> | T,
  ): Promise<T>
}
```

- **同页串行**：`workspaceStorage` 内部按 lock 名维护页面内 Promise 队列。
- **跨 tab**：必须使用 Web Locks（`navigator.locks`）或等价的可验证互斥实现。
  adapter 通过 `locks.request(name, { mode:'exclusive' }, ...)` 持有锁。
- **稳定 lock 名**：
  - `WORKSPACE_STORAGE_LOCK_NAME` = `travel-assistant:workspace:v1:lock`
  - `CANDIDATES_STORAGE_LOCK_NAME` = `travel-assistant:workspace:candidates:v1:lock`
  - `VERSIONS_STORAGE_LOCK_NAME` = `travel-assistant:workspace:versions:v1:lock`
- **没有锁管理器时**：读取仍可用；所有写 / confirm / undo 返回
  `lock_unavailable`（typed 只读 / 拒写）。不会退化成“直接写 localStorage 并声称安全”。
- **不宣称 localStorage CAS**。localStorage 的同步 `setItem` 不是跨 tab 事务；
  本 adapter 的保证来自「Web Locks + fresh raw 比对」，不是 `setItem` 本身。
- 不使用 `storage` 事件做恢复、不 spin、不 sleep、不引入 journaling / 多键事务。

`save*` / `confirm*` / `undo*` 都是 **async**；调用方必须 `await`。同步读取 API
（`load*` / `prepare*` / `parse*` / `create*`）不持有 Web Lock。

### 7.1 同页写代际、显式失效与 App 义务

每个库（workspace / candidates / versions）各有一条内存 generation，互不共享。
每次**成功的** write / confirm / undo 只推进自己库的 generation；失败写入不推进。

公开的失效 / 观察接口：

```ts
getLibraryGeneration(key): { key: string; generation: number }
invalidateLibraryGenerations(key): { key: string; generation: number }
preparedImportIsLive(handle: { importId: string }): boolean
currentStorageGeneration(key): number          // 协作读取，App 一般用上面三个
invalidatePreparedImport(handle): ImportCancelResult  // workspaceTransfer.ts
```

- `prepare*` 冻结创建时 generation；`confirm*` / `undoStorageCommit` 在锁内、
  真正写前比对。旧句柄返回 `import_superseded`，原数据不动。
- `invalidatePreparedImport(handle)` 只失效单个 prepared 句柄，不推进库 generation。
- `invalidateLibraryGenerations(key)` 推进整库 generation，使该库所有旧 prepared /
  undo 句柄失效；用于 App 确认“本页外部发生了写入”之后的显式屏障。
- `preparedImportIsLive` 只回答“这个 prepared 句柄现在是否仍可 confirm”，不读存储。

**App 必须承担的义务**（本 adapter 不注册 storage 事件）：

1. 监听三个存储键的 `storage` 事件；**每次事件都推进 App 自己的 epoch**，并对
   对应 key 调用 `invalidateLibraryGenerations(key)`，同时取消 / 失效该库所有
   在途 prepared handle 与旧 UI 预览。即使 `newValue === oldValue` 或两者都为
   `null` 也要处理（写入后撤销可能恢复同一 raw）。
2. 每次 apply / transition 不自动保存；只有用户显式保存或 confirm 时才调用
   async 写 API，并 `await` 到 `ok` 后才更新“已保存”标志。
3. 不把 storage 返回对象直接当成当前 UI 状态；对象引用 / epoch / 在途 AI 与预算
   pending 的失效仍由 App guard 负责。

**能力边界（不得夸大）**：

- 同页 generation 能检测本页观察到的 write → undo → 旧 raw 的 ABA；
- 跨 tab 的写入由 Web Locks + fresh raw 比对兜底；
- 但 raw 比较**不能**检测所有未观察的跨 tab ABA：如果另一个 tab 写入后又撤销、
  且本页没有收到 / 没有处理 storage 事件，旧 prepared 句柄看到相同 raw 时无法
  仅凭字节区分。App 的 storage-event epoch + `invalidateLibraryGenerations` 是
  关闭这个窗口的必要条件，不是可选项。
- 没有新增多 key 事务、tombstone、database、journal，也不把 localStorage 当 CAS。

---

## 8. 会话恢复 v2 的 workspace 块 adapter

`sessionRestore.ts` 的接线由后续独占 owner 完成；本模块只提供纯函数：

```ts
createSessionWorkspaceBlock(record): WorkspaceValidationResult<SessionWorkspaceBlockV1>
rehydrateWorkspaceFromSession({ trip, budget, workspace }): WorkspaceValidationResult<WorkspaceRecordV1 | null>
```

- 块只含 `workspaceId / ownerId / workspaceRevision / updatedAt / sidecar / meta`；
  Trip 仍在 `session.trip`，预算仍在 `session.budget`，不重复。
- `workspace: null` → `null`（旧 v1 未关联；不自动生成 id / sidecar）。
- 块未知字段拒绝；重建后整条记录再走 `validateWorkspaceRecord`。
- `budget` 参数由 `sessionRestore` owner 按 binding 规则映射；**adapter 不重新解释
  binding**，也不读 / 写 localStorage、不注册事件、不自动恢复。
- 写入会话时，`createSessionWorkspaceBlock` 只产出块；真正的 v2 payload 单次
  `setItem` 仍由 `sessionRestore` owner 实现。

---

## 9. 调用示例

```ts
import { commitWorkspaceTransition } from './workspace'
import { fingerprintOf } from './workspaceFingerprint'
import {
  getWorkspaceLockManager,
  loadWorkspaceRecord,
  saveWorkspaceRecord,
} from './workspaceStorage'
import {
  confirmWorkspaceImport,
  prepareWorkspaceImport,
} from './workspaceTransfer'

const storage = window.localStorage
const locks = getWorkspaceLockManager() // null → 只读

const loaded = loadWorkspaceRecord(storage)
if (loaded.status === 'ok') {
  const canonical = fingerprintOf(loaded.record)
  const next = commitWorkspaceTransition(loaded.record, { sidecar: loaded.record.sidecar }, Date.now())
  if (next.ok && canonical.ok) {
    const saved = await saveWorkspaceRecord(next.value, {
      storage,
      locks,
      expectedRaw: loaded.raw,
      expectedBaseCanonical: canonical.fingerprint.canonical,
    })
    // saved.ok 为 true 才更新持久状态 / 标志
  }
}

const preview = prepareWorkspaceImport(fileText, { storage, locks })
if (preview.ok) {
  const confirmed = await confirmWorkspaceImport(preview, {
    storage,
    locks,
    now: Date.now(),
  })
  if (confirmed.ok) {
    // 用户点击「撤销这次导入」时：
    // await undoImport(confirmed.undo, { storage, locks, now: Date.now() })
  }
}
```

**App guard 仍负责**：对象引用 identity、组件 epoch、在途 AI / 预算 / 备份 pending
失效、是否允许把 storage 返回对象赋值给当前 UI。storage 只负责 raw / canonical /
revision / owner 的持久化比较，不替 App 做状态机。

---

## 10. 测试与验证

本批目标测试：

- `frontend/src/__tests__/workspaceStorage.test.ts`（23）
- `frontend/src/__tests__/workspaceTransfer.test.ts`（23）

本次实跑：**46 passed / 2 files**。

覆盖（在原有 41 项之上新增）：

- 同 owner + expectedRaw 匹配时，两次未保存内存 transition 后一次显式保存（P1）；
- 同完整字节幂等 `saved`，且不产生第二次 `setItem`、不推进 generation（P2）；
- 同 revision 不同字节 / revision 倒退仍拒绝；
- 写 → undo 恢复旧 raw 后，旧 prepared import 必须 `import_superseded`，不复活（P3）；
- 迟到的 undo 不得覆盖后一次本地 import（B）；
- `invalidatePreparedImport` 显式失效后 confirm 拒绝且零写入；
- quota 失败不推进 generation、不毒化写入队列，清除错误后同一记录可重试成功；
- 并发 confirm 只有一个成功，另一个为 `import_superseded`；
- 原有：读取状态、坏包 / 未知版本保原、容量、三库独立、锁串行、外部 raw 冲突、
  undo 过期 / 已用 / 失败重试、backup 字节与格式、v2 workspace 块。

命令（本次）：

```powershell
cd frontend
npx vitest run --config <temp>/vitest.ts-first.config.mjs `
  src/__tests__/workspaceStorage.test.ts src/__tests__/workspaceTransfer.test.ts
npx tsc -p <temp>/tsconfig.wst-scoped.json --noEmit --pretty false
```

**测试解析注意事项（当前工作树）**：`frontend/src/**` 里存在历史遗留的
`*.js` 产物（不是本批生成，未删除、未 stage）。Vite 默认扩展名顺序会先解析
`.js`，直接 `npx vitest run ...` 会测到旧 JS 而不是本次修改的 `.ts`。本次使用
仓库外的临时 ts-first config（`resolve.extensions` 把 `.ts` 放在 `.js` 前，
保留原 `jsdom` / `setupFiles` / `globals:false` / `css:false`，用
`esbuild.jsx:'automatic'` 替代共享 vite config 的 react plugin，不改共享配置）实跑
46 项；`DEBUG=vite:resolve` 已确认 `workspaceStorage` / `workspaceTransfer` 及
workspace / workspaceTypes / workspaceFingerprint / savedTrips / api /
sessionRestore / fixtures 全部解析到 `.ts`。独立复验必须确认解析到 `.ts`
（或由 tree owner 统一清理 / 忽略这些 `*.js` 产物），否则测试绿灯不代表本文件
描述的源码。

`tsc` 结果：本批 4 个 TS 文件的 scoped `--noEmit` 为 **exit 0 / 无输出**
（依赖闭包 hash 见修复证据 `dependencies.sha256`）。full app
`tsc -p tsconfig.app.json --noEmit` 当前会因 `src/App.tsx` 的未使用 import 报错；
那是 App owner 正在改的文件，不在本批白名单，本文件不声称 full app 绿。
没有运行 full build / E2E / backend。

---

## 11. 集成依赖 / 明确未做

后续 owner 需要：

1. **App guard**：把 `expectedRaw`、`expectedBaseCanonical`、对象引用 / epoch 与在途
   pending 状态接上；storage 返回对象不会自动成为当前 Trip。必须监听三个键的
   `storage` 事件，每次推进 epoch 并调用 `invalidateLibraryGenerations(key)`，
   取消旧 prepared 预览；不能只靠 raw 比较声称检测了所有跨 tab ABA。
2. **sessionRestore owner**：把 v2 `workspace` 块接入 payload 读写；budget binding 映射
   在 `sessionRestore.ts` 内完成，再调用 `rehydrateWorkspaceFromSession`。
3. **F1/F2/F3/F4/F5/F6 writer**：只调用本 adapter 的独立读写 / backup API，不复制 schema；
   F4 采用版本先用 `commitWorkspaceTransition`（revision 当前 +1）再
   `saveWorkspaceRecord`，版本 undo 是新的 transition，不是 raw rollback。
4. **UI integrator**：一次接一个 feature；不把 `prepare*` 的预览结果直接当已保存状态。
5. **独立验收**：本文件与测试只是存储切片证据，不等于 F1–F6 任一 feature 上线。

### 11.1 F4 `VersionsStorageAdapterV1` 的真实签名差异

F4 模块定义了同步注入接缝：

```ts
interface VersionsStorageAdapterV1 {
  storageKey: typeof VERSIONS_STORAGE_KEY
  readRaw(): string | null
  writeRaw(text: string): void
}
```

统一 storage **不能**用同步 `writeRaw` 冒充真实持久化成功：本 adapter 的所有写 /
confirm / undo 都是 async，且需要 Web Locks。集成 owner 的最小映射：

| F4 接缝 | 统一 storage 用法 |
|---|---|
| `readRaw()` | `loadVersionsRecord(storage)`，按 `status` 处理 `anomaly/corrupt/unavailable`，不要只取 raw |
| `writeRaw(text)` | 不要实现同步假接口；用 `saveVersionsRecord(record, { expectedRaw, locks, ... })` 或 `confirmVersionsImport(...)`，`await` 返回 `ok` 后才能报告保存成功 |
| import preview / confirm | `prepareVersionsImport` / `confirmVersionsImport`；取消 `cancelPreparedImport`；撤销 `undoImport` |
| backup | `createVersionsBackupFile` / `parseVersionsBackupText`（预览与下载同一份 text） |

本批**未修改** F4 的 `versionSnapshots.ts` / `VersionsPanel.tsx`；差异交由统一集成
owner 在 App 层桥接，F4 不直接读 / 写 localStorage。

明确未做：

- 不做跨三库事务 / 一键恢复；不做 localStorage CAS；不做 storage 事件自动恢复。
- 不做多 key 事务、tombstone、database / journal；不把 generation 持久化，也不跨 tab
  共享 generation。
- 不做自动驱逐、自动修复、自动迁移未知版本、自动按 hash 挂 sidecar。
- 不接线 `App.tsx` / `SessionResumePanel` / `sessionRestore.ts` / `runner` / API / backend /
  共享 CSS；不声称整个工作区 feature 已交付。

# 行程版本与方案对比（F4）

> 状态：**纯模块 + 受控面板，未接入 App，未实现存储写入。** 本文描述
> `frontend/src/lib/versionSnapshots.ts` 与 `frontend/src/components/VersionsPanel.tsx`
> 的已实现边界；不声称版本库已完成端到端落盘。
>
> 公共 schema / 容量 / revision 常量来自 `docs/WORKSPACE_SIDECAR.md` 与
> `workspaceTypes.ts` / `workspace.ts`；本模块不另造版本 schema，不扩展 Trip v1。

---

## 0. 范围与非目标

**做：**

- 用户显式命名保存不可变版本：完整 Trip v1 + sidecar + 手工预算快照 + 元数据。
- 两个版本对比：站点新增 / 删除 / 跨日移动 / 同日变化、预约变化、时间 / 距离 /
  费用的已知与未知分列。
- 采用版本：先预览，再显式确认；一次 transition 切换 Trip + sidecar + budget；
  revision 从当前值 +1。
- 采用后一次整体撤销：恢复采用前的 Trip + sidecar + budget，revision / epoch
  仍继续 +1。
- 版本库独立备份 / 导入预览；通过公共 validator 校验，不跨库原子恢复。
- 给统一存储 owner 的 adapter 接口与单键写入计划（只定义，不实现 localStorage）。

**不做：**

- 不每按键自动分叉版本；不用既有单步 undo 冒充多版本。
- 不读写 localStorage、不读时钟、不发网络请求。
- 不修改 App / runner / `workspace*.ts` / `api.ts` / backend / 全局样式。
- 不把未知费用 / 时间 / 距离补成 0；不伪造总价；不自动驱逐旧版本。
- 不恢复快照里的旧 revision；不套用当前预算到无预算旧版本。
- 不声称跨三库原子恢复、跨 tab 事务或浏览器 quota 保证。

---

## 1. 快照

```ts
interface VersionSnapshotV1 {
  id: string
  name: string
  createdAt: number
  workspaceRevision: number   // 仅记录；绝不用于恢复
  trip: Trip                  // Trip v1 完整快照
  sidecar: WorkspaceSidecarV1
  budget: BudgetSnapshotV1 | null
}
```

- 版本保存后不可变：`createVersionSnapshot` 先做 canonical JSON 纯度检查，再深拷贝
  并递归冻结；后续编辑原 Trip / sidecar / budget 不会串改旧快照。
- 循环引用、`undefined`、函数、BigInt、非有限数、非普通对象 → `unserializable`，
  不静默丢字段。
- `budget: null` = 该版本明确没有预算数据；采用时**不会**套用当前工作区的预算。
- 同名版本允许存在，id 独立；`addVersionSnapshot` 不按名字覆盖。

### 稳定导出

| 导出 | 作用 |
|---|---|
| `createVersionSnapshot(input)` | 深拷贝 + 校验 + 冻结快照 |
| `addVersionSnapshot(record, snapshot, updatedAt)` | 追加版本；返回新版本库记录 |
| `validateVersionSnapshot` / `validateVersionsRecord` | 公共严格 validator（re-export） |
| `measureVersionSnapshotBytes` / `measureVersionsRecordBytes` | UTF-8 JSON 字节（re-export） |
| `MAX_VERSIONS_COUNT` / `MAX_VERSIONS_TOTAL_BYTES` / `MAX_VERSION_SNAPSHOT_BYTES` | 统一容量常量（re-export） |
| `VERSION_LIMITS` | 上述常量的只读聚合 |

容量：**10 个 / 4 MiB / 单快照 2 MiB**。超限明确失败，**不自动驱逐旧版本**。
字节口径是实际要写入的紧凑 JSON 的 UTF-8 字节，不是 UTF-16 字符数。

---

## 2. 对比

`diffVersions(a, b)` 返回 typed 结构；输入不会被修改，结果中的条目是独立副本。

### 2.1 站点

按 stop **id** 识别：

- `added` / `removed`：只在一侧存在。
- `moved`：同一 id 在两个版本中处于不同天（跨日移动）。
- `changed`：同一 id、同一天，但 stop 内容（名称 / 时间 / 停留 / 地址等）变化。
- `unchangedCount`：同 id 同日且内容完全相同。

同一 id 在一侧跨多天重复出现时，按各自出现顺序配对；这不会把重复 occurrence
折叠成一个站点。

### 2.2 预约

按 `constraint.id` 对比 `sidecar.constraints.items`：`added` / `removed` /
`changed` / `unchangedCount`。直接使用公共 `ConstraintsV1`，不另造字段。

### 2.3 时间 / 距离

- 时间统计 Trip 内 stop `duration_minutes` 与 leg `duration_minutes`。
- 距离统计 leg `distance_m`。
- 每个指标分别给出 `knownTotal` / `knownCount` / `unknownCount` / `complete` /
  `total`。
- `null` = 未知，**不补 0**；`0` = 已知零，进入已知合计。
- 只有全部项已知时才给 `total`；否则只给「已知合计 + 另有 N 项未知」。
- 没有任何已知项时 `knownTotal = null`，不是 0。

### 2.4 费用

- 金额使用 `tripBudget.ts` 的十进制字符串精确算法：`0.10 + 0.20 = 0.30`，不经过浮点。
- `budget: null` → `state: 'missing'`，没有总价。
- 有预算但存在未填 / 非法金额 → `complete: false`，`totalCents` / `totalText` 为
  `null`，只显示已知合计与未知项数。
- 明确填写的 `0` 是合法已知金额，显示 `0.00`。
- 总价变化只有在两边都完整且有总价时才计算；否则 `totalDeltaText: null`。

---

## 3. 采用与撤销

### 3.1 采用提案

`planVersionAdopt(current, version, { epoch })` 只生成 proposal，不改当前记录、
不写存储。proposal 携带：

- `base.identity`：`ownerId + workspaceId + tripId + workspaceRevision`；
- `base.epoch` 与 `base.snapshot`：提案创建时整条工作区记录的**完整 canonical JSON**；
- `target.content`：目标 Trip + sidecar + budget（完整快照）；
- `target.snapshot`：目标内容的完整 canonical JSON；
- `versionId` / `versionName` / `versionRevision`（旧 revision 只显示）；
- `nextWorkspaceRevision = 当前 revision + 1`；
- `nextEpoch = 当前 epoch + 1`；
- `needsReconfirmation`：当前工作区有、但目标版本没有的条目（约束 / 清单 / 候选
  引用 / 锚点）。采用前明确列出，不静默套用。

如果版本属于另一个 `trip.id`，直接 `owner_mismatch` 拒绝，不静默换工作区。

### 3.2 应用采用

`applyVersionAdoptProposal(current, proposal, { epoch }, now)`：

1. 校验当前记录；
2. 全文核对 base 身份、revision、epoch、canonical；
3. 核对 `nextWorkspaceRevision` 必须等于**当前 revision + 1**；
4. 核对目标内容 canonical 未被改写；
5. 用 `commitWorkspaceTransition` 在内存中**一次整体切换** Trip + sidecar + budget；
6. 返回新记录、一次整体 undo proposal 与 `invalidation`。

- 不恢复快照里的旧 revision。
- 失败（过期 / 损坏 / 超限 / revision 不符）时当前记录与存储字节都不变。
- 不写 storage；持久化由父级显式调用统一存储 owner。
- 返回的 `invalidation = { workspaceRevision, epoch, reason }` 供集成使在途 AI /
  路线 / 预算 / 备份 pending 全部失效；pending 必须同时守卫 identity、revision、
  epoch 与完整快照，不能只看短 hash。

### 3.3 撤销

- `applyVersionAdoptProposal` 返回的 `undo` 携带采用前的完整 Trip + sidecar + budget、
  采用后的 base canonical / revision / epoch，以及下一 revision / epoch。
- `applyVersionUndoProposal(current, undo, { epoch }, now)` 恢复内容、**仍然当前 +1**；
  不重放采用前或快照里的旧 revision。
- undo 只允许一次；重复使用、内容变化、epoch 变化、ABA（A→B→A）都会因 base canonical
  / revision / epoch 不匹配而拒绝。

### 3.4 过期 / ABA 判定

提案不是凭短 hash 生效，而是同时核对：

- 完整 `base.snapshot.canonical` 与当前记录 canonical 全文；
- `ownerId` / `workspaceId` / `tripId` / `workspaceRevision`；
- `epoch`；
- `nextWorkspaceRevision` 与当前值 +1 一致；
- 目标内容 canonical 与 proposal 中的记录一致。

任一不一致 → 明确失败并保留当前数据，不静默重算、不重放旧状态。

---

## 4. 版本库独立备份 / 导入

- envelope 使用公共 `VersionsBackupV1`：
  `format: travel-assistant.workspace.versions.backup`、`version: 1`、`exportedAt`、
  `versions`。
- `buildVersionsBackupPreview(record, exportedAt)`：只包含版本库自身；返回
  `{ scope: 'versions-only', record, backup, text, bytes }`。预览与下载必须使用
  同一份 `text`。
- `previewVersionsImport(rawText, rawBytes?)`：只解析 / 校验 / 展示，不写任何库。
  文件上限 8 MiB；损坏、未知字段、非版本库 envelope、条数 / 总量超限都拒绝，
  原版本库字节不变。
- `prepareVersionsLibraryWrite(record)`：给统一存储 owner 的**单键写入计划**
  `{ storageKey, text, bytes, record }`；不写 storage，不驱逐旧版本。
- `VersionsStorageAdapterV1` 只是注入接缝：
  `readRaw()` / `writeRaw(text)` / `storageKey`。**本阶段没有实现**
  `workspaceStorage.ts`，没有 localStorage / quota / 跨 tab 逻辑。
- 不做跨工作区 / 候选库原子恢复；三个库各自预览、确认、写入、一次 undo。

---

## 5. 面板

`VersionsPanel` 是受控组件，**不直接读 / 写 storage**：

```ts
interface VersionsPanelProps {
  current: WorkspaceRecordV1 | null
  versions: VersionsRecordV1 | null
  epoch: number
  libraryStatus?: VersionsLibraryStatusV1
  undoProposal?: VersionUndoProposalV1 | null
  busy?: boolean
  onSaveVersion: (request: VersionSaveRequestV1) => void
  onAdoptVersion: (proposal: VersionAdoptProposalV1) => void
  onUndoAdopt: (proposal: VersionUndoProposalV1) => void
  onImportVersions?: (preview: VersionsImportPreviewV1) => void
  onDownloadBackup?: (preview: VersionsBackupPreviewV1) => void
  onClose?: () => void
  now?: () => number
}
```

- 保存：输入名字 → 点「保存为版本」→ 只调用 `onSaveVersion({ name })`；父级负责
  id / 时间 / 写入。
- 采用：点「预览采用」只生成 proposal；**必须再点「确认采用此版本」**才调用
  `onAdoptVersion(proposal)`。面板不调用 `applyVersionAdoptProposal`，也不写存储。
- 撤销：父级传 `undoProposal` 后显示「撤销本次采用」，点击才调用 `onUndoAdopt`。
- 对比：默认选最近两个版本；显示站点 / 预约差异、已知与未知时间距离、已知费用
  与是否显示总价、0.30 这类精确已知合计。
- 空预算显示「该版本没有预算数据；采用后预算明确缺失，不会套用当前预算」。
- 当前额外条目在采用预览中逐条列出，并明确「采用后不会恢复」。
- 备份 / 导入只预览版本库范围；导入文件确认后才调用 `onImportVersions`；
  下载由父级 `onDownloadBackup` 接入。
- 损坏 / anomaly / unknown_version / unavailable 状态显示提示并禁用普通写入。

---

## 6. 集成缺口（诚实清单）

本阶段**已实现**：纯快照 / 对比 / 采用 / 撤销 proposal / 备份导入预览 / 受控面板 /
目标测试与 noEmit。

**未实现，不属于本 writer 文件范围：**

- `workspaceStorage.ts`：单键原子写、容量 / quota 失败保旧、corrupt / anomaly 读取
  状态、跨 tab 重读比对；以及把 `VersionsStorageAdapterV1` 接到真实 localStorage。
- App / UI integrator：把 `VersionsPanel` 接入 `App.tsx`，持有版本库状态、生成保存
  的 id / `createdAt`，调用 `applyVersionAdoptProposal` / `applyVersionUndoProposal`
  后再显式保存；把 `onDownloadBackup` 接到真实文件下载。
- 会话恢复 v2 / 工作区备份：版本库不参与跨库恢复。
- E2E / 全量前端 / backend / build：本阶段未跑，不声称通过。

如果统一存储 owner 提供的 adapter 与本模块的 `VersionsStorageAdapterV1` 形状不一致，
应报告 PM 对齐，**不要在本模块或组件里直接读写 localStorage**。

---

## 7. 本次测试

目标测试文件：

- `frontend/src/__tests__/versionSnapshots.test.ts`
- `frontend/src/__tests__/VersionsPanel.test.tsx`

覆盖：快照深不可变、预算归属与缺失、合法 0、重复名字独立 id、同 id 跨日移动、
预约差异、未知费用不伪总价、精确十进制、revision 不回退、整体 undo、ABA / 过期 /
重复提案拒绝、容量与不驱逐、UTF-8 字节、备份 / 导入预览、面板未确认不 apply。

命令见报告 `night-20261105/f4/REPORT-F4-VERSIONS.md`；不把作者自测当独立验收。

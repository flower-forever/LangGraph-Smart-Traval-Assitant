# F3 · 候选地点池（本地、独立库）v1

> 状态：**纯模块 + 受控面板 + 聚焦单测**。本切片**没有**接 `App.tsx` / `e2e/runner.mjs`，
> **没有**写 / 接入 `workspaceStorage.ts`，也不自行做任何真实 localStorage 读写，
> **不宣称纵向交付完成**。候选库的读取 / 保存 / 备份 / 导入由公共契约的**存储 owner**
> 实现；本文写清它需要提供的 adapter 契约。类型 / 容量 / key 的唯一权威仍是
> `docs/WORKSPACE_SIDECAR.md` 与 `frontend/src/lib/workspaceTypes.ts`。

---

## 1. 范围与不变量

用户场景：攒一批想去的地方（名称、地址、备注、区域标签、优先级、可选坐标），
规划某天时从池里挑一个加入**当天草稿**，再由既有草稿流程显式应用。池子里的东西
**不自动进行程**；没有真实搜索、地理编码、账户同步或跨设备同步。

硬不变量：

- 候选库与工作区 / 版本库是**三个独立逻辑库**；候选增删改**不触碰** `KEY_WORKSPACE`，
  不写 Trip、不改 `sidecar.applies`、不删已加入行程的站点。
- 候选记录只有一条：`CandidatesRecordV1`；存储键使用公共常量
  `CANDIDATES_STORAGE_KEY`（`travel-assistant:workspace:candidates:v1`）。
  **本模块不另建 key，也不复制一份 schema。**
- 容量使用公共常量：`MAX_CANDIDATES_COUNT = 200`、
  `MAX_CANDIDATES_BYTES = 262144`（256 KiB）、
  `MAX_CANDIDATES_BACKUP_FILE_BYTES = 524288`（512 KiB）。
  字节一律是**紧凑 JSON 的真实 UTF-8 字节**（`utf8ByteLength(JSON.stringify(value))`），
  不是 UTF-16 字符数；中文与 emoji 按真实字节计。
- 超限 / Quota / 校验失败：**明确失败，保留旧记录与旧字节**，不驱逐、不截断、不清洗覆盖。
- 未知字段：公共 validator **拒绝**；builder 只做白名单投影。两者是分开的机制。
- `location: null` = 坐标未知；`0` 是合法真实坐标。**绝不把未知补成 `(0,0)`**，
  也不 geocode。
- `source` 只允许 `manual` / `copied`；UI 固定标「未核实」，不是 verified。
- 候选 `id` 是随机逻辑 ID，不是浏览器指纹；从 stop 复制时 `copiedFromStopId`
  只记录来源，不把候选变成原 stop 的别名。
- 去重只做提示：`dedupeKey = normalize(name) + '|' + normalize(address)`；
  命中后返回两条供用户判断，**不自动合并、不自动覆盖、不按短 hash 自动挂接**。

---

## 2. 新增文件

| 文件 | 内容 |
|---|---|
| `frontend/src/lib/candidatePool.ts` | 纯函数：构造 / 复制 / 增删改 / 筛选 / 去重提示 / 容量 / 备份预览 / 草稿加入 proposal |
| `frontend/src/components/CandidatePoolPanel.tsx` | 受控面板：手工新增、从 stop 复制、编辑、筛选、删除、单步撤销、加入草稿预览、显式保存 / 导入 / 导出回调 |
| `frontend/src/components/candidatePoolPanel.css` | 面板独立样式（`.cpl-` 前缀，取 `tokens.css` 变量；不改全局 CSS） |
| `frontend/src/__tests__/candidatePool.test.ts` | 纯模块 20 项测试 |
| `frontend/src/__tests__/CandidatePoolPanel.test.tsx` | 面板 15 项测试 |
| `docs/CANDIDATE_POOL.md` | 本文 |

**未改**：`App.tsx`、`e2e/runner.mjs`、`workspaceTypes.ts`、`workspace.ts`、
`workspaceFingerprint.ts`、`api.ts`、`tripDraft.ts`、`savedTrips.ts`、任何
`workspaceStorage.ts`、任何 backend、任何全局 CSS、任何 `KEY_*` 常量。

---

## 3. 数据模型（引用公共契约，不重复定义）

`frontend/src/lib/workspaceTypes.ts` 已定义，F3 直接使用：

```ts
type CandidateSourceV1 = 'manual' | 'copied'

interface CandidateItemV1 {
  id: string
  name: string                 // 1..120
  address: string | null       // ≤300
  notes: string | null         // ≤500
  tags: string[]               // ≤20 个，每个 ≤50；去重
  priority: number             // 0..3
  location: { lng: number; lat: number } | null
  source: CandidateSourceV1
  copiedFromStopId: string | null // copied 必填；manual 必须 null
  createdAt: number
  updatedAt: number            // >= createdAt
}

interface CandidatesRecordV1 {
  format: 'travel-assistant.workspace.candidates'
  version: 1
  items: CandidateItemV1[]
  updatedAt: number
}
```

使用关系 `ApplyLinkV1` 仍在工作区 `sidecar.applies`，**不在候选里**。因此删除候选
天然只删候选；UI 对指向已删候选的 link 只标「候选已删除」，不改 Trip。

---

## 4. 纯模块 API（`candidatePool.ts`）

所有函数**不读时钟、不读 storage、不发网络**；时间与 ID 由调用方传入。
失败统一返回 `{ ok:false, reason, message }`，不会返回半条新记录。

### 4.1 构造与复制

```ts
createManualCandidate(input, now) -> CandidatePoolResult<CandidateItemV1>
copyCandidateFromStop({ id, stop, notes?, tags?, priority? }, now)
  -> CandidatePoolResult<CandidateItemV1>
```

- `manual`：`source='manual'`、`copiedFromStopId=null`。
- `copied`：名称 / 地址 / 坐标从 `CandidateStopSource` 深拷贝；原 stop 坐标为 null
  时仍为 null；候选与原 stop 完全隔离。
- 名称 / 地址 / 备注会 trim；空地址 / 空备注落 `null`；标签 trim、按首次出现去重。
- 坐标解析：`parseCandidateCoordinates(lngText, latText)`：两边都空 = `null`；
  只填一边 / 非有限数 / 超范围 = typed failure；`'0','0'` = `{lng:0,lat:0}`。

### 4.2 不可变增删改

```ts
createEmptyCandidateRecord(now)
addCandidateToRecord(record, candidate, now)
updateCandidateInRecord(record, candidateId, patch, now)
removeCandidateFromRecord(record, candidateId, now)
```

返回 `{ record, changed, duplicates }`：

- `changed=false`：编辑没有实际变化，返回原记录，`updatedAt` 不变。
- 编辑保留 `source` / `copiedFromStopId` / `createdAt`；`updatedAt` 用本次 `now`，
  且 `now` 不得早于 `createdAt`。
- 新增 / 编辑先走公共 `validateCandidateItem` / `validateCandidatesRecord`；
  未知字段、重复 id、跨条目重复标签等直接拒绝。
- 容量先查 200 条，再按真实 UTF-8 字节查 256 KiB；失败保留旧记录。
- `duplicates` 只是与本次同 `dedupeKey` 的其它条目，**不自动合并**。

### 4.3 筛选与去重

```ts
normalizeCandidateText(text)       // NFKC + trim + 折叠空白 + 小写
candidateDedupeKey(candidate)
findDuplicateCandidates(items, candidate, { excludeId? })
listCandidateTags(items)           // 首次出现顺序
filterCandidates(items, { text?, tag?, untaggedOnly? })
```

筛选只影响显示：返回条目仍是原引用，数组顺序不变；不改 `currentTrip`，不触发 storage。

### 4.4 备份 / 导入（纯校验与预览）

```ts
createCandidatesBackup(record, exportedAt)
  -> { backup, json, bytes, itemCount }

previewCandidatesBackup(value, rawBytes?)
  -> { backup, record, itemCount, exportedAt, bytes }

parseCandidatesBackupJson(text)
```

- envelope 使用公共 `CANDIDATES_BACKUP_FORMAT` / `BACKUP_VERSION`；
  内部记录与文件字节都走公共 `validateCandidatesBackup`。
- `json` 与 `bytes` 是**同一份**紧凑 JSON；预览 / 下载应使用同一份字节。
- 未知字段、格式 / 版本不符、文件超 512 KiB、内部记录超限都明确失败。
- **不写 storage、不自动恢复**；调用方拿到 preview 后仍需显式确认与持久保存。

---

## 5. 加入草稿 / 预览 proposal

```ts
buildCandidateDraftProposal({
  draft, candidate, day, time, durationMinutes?, visitStopId,
}) -> CandidatePoolResult<CandidateDraftProposal>
```

流程：

1. 校验候选（未知字段拒绝）与目标 `day` 是否存在。
2. 检查当天已有站数 < `MAX_DRAFT_STOPS_PER_DAY`（既有 `tripDraft` 的 100 站结构上限）。
3. 校验 `time` 为严格 `HH:MM`；`durationMinutes` 为 `null` 或 0..1440 整数。
4. 校验 `visitStopId`：非空、≤100 字符、**不等于候选 id**、不与草稿内任何 stop id 冲突。
5. 只调用既有 `tripDraft.addDraftStop`（名称 / 地址 / 备注 / 时间 / 停留；坐标固定
   `null`），再调用 `applyDraft` 生成**预览 Trip**。
6. 预览 Trip 再显式跑 `checkTripShape` 与既有保存字节门禁；失败则不返回 proposal。
7. 原 `draft` 与 `draft.base` **都不被修改**；返回 `proposal.draft` 是新草稿。

`CandidateDraftProposal` 的关键字段：

```ts
{
  previewOnly: true
  candidateId, candidateUpdatedAt, candidateName, candidateLocation
  day, time, visitStopId
  draft                 // 新草稿，只含这次加入
  previewTrip           // applyDraft 生成的预览 Trip，不是当前 Trip
  previewTripBytes
  stop                  // 新加入的站点（属于 draft）
  changedDays, localChecks, notices, caveats
  shapeChecked: true
  baseTripId, forkTripId, draftRevision
}
```

**明确限制（诚实）**：现有 `tripDraft` 的新增站点接口只接受文字与 `location: null`；
候选坐标保留在候选库，**不会**写进草稿 stop，也不会 geocode。proposal 的 `caveats`
固定写明这一点，并固定写明「预览未写入任何行程或本地存储」「确认加入只改父级草稿，
真正应用到行程仍需既有草稿应用流程」。

---

## 6. 面板回调与 adapter 契约

`CandidatePoolPanel` 是**受控组件**：不读 localStorage、不写 Trip、不自己生成备份文件。
父级必须提供以下显式回调 / 状态。

| Prop | 作用 | 边界 |
|---|---|---|
| `record: CandidatesRecordV1 \| null` | 父级已加载并通过公共 validator 的候选库；`null` = 未加载 / 损坏 / 不可用 | 面板不会在 `null` 时凭空新建记录；损坏 / anomaly / unknown_version 时只读 |
| `draft: TripDraft \| null` | 父级当前草稿 | 面板只读；proposal 返回新草稿，父级决定是否替换 |
| `copySources` | 父级从当前 Trip / 草稿整理出的可复制站点 | 面板不直接读 Trip；没有来源时不按名称搜索 / geocode |
| `storageStatus` / `storageMessage` | 父级报告 `ok / empty / loading / unavailable / corrupt / anomaly / unknown_version / error`（可直接映射 `loadCandidatesRecord()` 的 `status` / `message`） | 非 `ok / empty` 时禁用新增 / 编辑 / 删除 / 保存 / 导出；导入请求仍可交给父级做显式修复预览 |
| `storageRevision` | 父级存储 owner 的不透明 raw / revision token | 变化时旧预览立即失效；面板不解析、不读 key |
| `saveStatus` / `saveMessage` | 父级保存结果 | 面板只在父级报告 `saved` 时显示「已保存」；本页有未保存变更时优先显示未保存提示 |
| `onRecordChange(next)` | 内存记录变化 | **只**更新父级内存；不代表已持久化 |
| `onSave(record)` | 显式保存请求 | 父级 adapter 使用 `CANDIDATES_STORAGE_KEY` 单键 `setItem`；成功后才更新持久状态 |
| `onExport(record)` | 显式备份导出请求 | 父级生成 envelope / 文件与同一份字节；面板不写文件 |
| `onImportRequest()` | 显式导入请求 | 父级读文件、用 `previewCandidatesBackup` 纯校验 / 预览、再显式确认写入；不自动恢复 |
| `onPreview(proposal)` | 预览生成后的观察回调 | 只表示「生成了预览」，**不得**当作已应用 / 已持久化 |
| `onAddToDraft(proposal)` | 把预览草稿交给父级 | **只**更新父级草稿；面板不写 Trip；真正 apply 仍由既有草稿流程完成 |
| `createCandidateId` / `createVisitStopId` | ID 工厂 | 默认 `createLogicalId`；测试可注入；visit id 不得复用候选 id |
| `now` | 显式时钟 | 默认 `Date.now`，纯模块不读时钟 |

### 6.1 存储 owner 必须补齐的能力

> 公共存储 owner 需要提供下列 API（当前工作区已有 `frontend/src/lib/workspaceStorage.ts`，
> 具体导出以该模块为准）；本切片**不修改**它，只约定面板如何消费。

1. **读**：只在用户打开候选面板 / 执行显式动作时调用 `loadCandidatesRecord()`；
   它返回 `StoreRead<CandidatesRecordV1>`（`status / raw / bytes / record / message`）。
   面板 `record` 取 `read.record`，`storageStatus` 取 `read.status`，
   `storageMessage` 取 `read.message`；损坏 / anomaly **保留原始字节、只读不写**。
2. **写**：用户显式保存时调用 `saveCandidatesRecord(record, { expectedRaw,
   expectedBaseCanonical? })`；它使用 `CANDIDATES_STORAGE_KEY` 一次写入完整记录，
   并在提交前重读 raw / canonical 比对。`conflict` / quota / `unavailable` 等失败时
   面板显示父级 message，旧字节保持不变。不声称 localStorage 有 CAS。
3. **quota / 超限**：owner 识别 QuotaExceeded，失败保留旧字节，不驱逐；容量是最大允许，
   不是浏览器 quota 保证。
4. **备份**：候选库独立 envelope；范围仅候选库，不含工作区 / 版本；
   预览与下载使用同一份字节；文件上限 512 KiB。
5. **导入**：父级先 `previewCandidatesBackup` / `parseCandidatesBackupJson` 纯校验
   preview → 用户显式确认 → `commitCandidatesImport(record, { expectedRaw,
   expectedRecordCanonical }, options)` → 可选一次 undo；损坏 / 超限失败时原库字节不变；
   **不默认自动恢复**。
6. **owner / revision**：把当前 raw（或等价 revision token）作为 `storageRevision`
   传入；变化时面板自动作废旧预览。`workspaceRevision` 不参与候选库写入；
   本模块不伪造 workspace 绑定。
7. **App 集成**：`onRecordChange` 更新父级内存；`onAddToDraft` 把 proposal.draft 交给
   现有草稿状态；是否替换草稿、何时 apply 到 Trip 由 UI integrator 串行接入。
   **本次没有接 App，不能宣称端到端可用。**

---

## 7. 验收覆盖（本次实跑）

纯模块测试覆盖：

- 同名同址（空白 / 大小写 / 全角归一）只提示重复，两条保留；不自动合并。
- 手工 `manual` / 复制 `copied` 来源诚实；`copiedFromStopId` 正确；名称 / 地址 /
  坐标 / 标签深隔离，改动任一侧不污染另一侧。
- 坐标 `0` 合法、null = 未知、只填一半 / 越界 typed failure；复制 null 坐标仍是 null。
- 新增 / 编辑 / 删除不可变；冻结旧记录与旧标签 / 坐标仍可操作；编辑无变化不 bump；
  `now < createdAt` 拒绝并保旧。
- 200 条上限、第 201 条失败；中文备注按 UTF-8 字节，超 256 KiB 失败且旧库不变；
  实际字节与 `utf8ByteLength(JSON.stringify(record))` 一致。
- 区域标签 / 无标签 / 文本筛选只读；标签顺序稳定。
- 加入草稿 proposal：不存在 day / 满 100 站 / 非法时间 / visit id 复用候选 id /
  已有 stop id 都失败保旧；成功时新 visit id 独立、坐标不进行程、
  `checkTripShape` 通过、原 Trip / 草稿未变。
- 删除候选后预览 Trip / 当前 Trip / 草稿 / `applies` 均保持。
- 备份 envelope、同一份 JSON 字节、preview 读回；未知字段 / 损坏 / 超 512 KiB 失败；
  `parseCandidatesBackupJson` 非法 JSON 失败；preview 不写 localStorage。
- 候选 / 候选库层未知字段严格拒绝。

面板测试覆盖：

- 挂载不调用保存 / 导出 / 导入 / 加入草稿 / 记录变更回调；不读 localStorage。
- 手工新增坐标 0、标签去重、来源 manual；只回传内存记录。
- 第二次同名同址显示重复提示，两条都在。
- 从 stop 复制 source / copiedFromStopId / 坐标正确，来源对象不变。
- 编辑只改内存记录，清空坐标显示「坐标未知」；筛选 / 打开编辑表单都不触发回调。
- 删除只回传候选库新记录，草稿与来源不变。
- 加入草稿先预览、`onPreview` 收到 proposal、新 visit id 不复用候选 id、
  确认后才调用 `onAddToDraft`；原草稿不变；localCheck 报「缺少坐标」。
- 草稿 revision / 父级 `storageRevision` 变化后预览与确认按钮立即消失。
- 满 100 站 / 复用候选 id / 非法时间都在面板层明确失败，不产生 `onPreview`。
- 保存 / 导出 / 导入只在显式点击时调用父级回调；父级 `saved` 后继续编辑会显示
  「本页有尚未保存的变更」，不把新变更说成已保存。
- 损坏 / 不可写状态禁用变更与保存，明确保留原始字节；200 条时新增失败、旧库不变。

本次命令与结果：

```text
cd frontend
npx vitest run src/__tests__/candidatePool.test.ts src/__tests__/CandidatePoolPanel.test.tsx --no-cache
# 2 files, 35 tests passed

npx tsc -p <Temp>/night-20261105/f3/tsconfig.f3.json --pretty false
# 通过（只包含 F3 源文件 / 测试 / 必要的既有依赖）

npx tsc -p tsconfig.app.json --composite false --noEmit --pretty false
# 通过（exit 0，无输出；最终检查时全仓 noEmit 干净）
```

**未跑**：full 前端 suite、`pnpm build`、E2E、backend pytest。F3 只按任务要求跑
目标测试 + noEmit；不把未跑的 full suite / build / E2E 写成通过。

---

## 8. 明确未做 / 已知限制

- 未接 `App.tsx`、未接 `e2e/runner.mjs`、未写 / 未接入 `workspaceStorage.ts`；
  当前只是可独立验收的纯模块 + 受控面板，**不是完整纵向交付**。
- 面板没有直接读文件：导入的文件选择、读取、预览与确认由存储 owner / UI integrator
  接入；本模块只提供纯 envelope / preview 函数。
- 只有组件内存的一步撤销（`撤销上一步`），不是持久多版本历史。
- 候选坐标不写进草稿站点：这是现有 `tripDraft` 新增站点接口的边界；不通过修改
  `tripDraft.ts` 绕过，也不假装坐标已进入行程。
- 没有真实地点搜索、geocode、账户、云同步、爬取；没有自动合并重复候选。
- 不提供跨三库事务、跨 tab 事务、自动恢复；这些仍按 `docs/WORKSPACE_SIDECAR.md`
  的存储契约由 owner 实现。

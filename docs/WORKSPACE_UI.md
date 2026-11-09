# 工作区 UI 集成（W8 App / controller / Hub 切片）

状态：**阶段 2 App/UI 接线已完成，等待非作者整合门与真实浏览器 E2E。**
本文只描述已接线的真实入口与仍然存在的缺口，不把 mock 子面板测试当成整 App 已验收。

仓库：`F:/MunderDifflin/Travel-Assistant/LangGraph-Smart-Traval-Assitant`
契约权威：`docs/WORKSPACE_SIDECAR.md`、`docs/WORKSPACE_STORAGE.md`、`docs/WORKSPACE_RESTORE.md`、`docs/CONSTRAINTS.md`

---

## 1. 文件与职责

| 文件 | 职责 |
|---|---|
| `frontend/src/lib/useWorkspaceController.ts` | 唯一内存工作区 controller（React hook）。持有 `WorkspaceRecordV1`（Trip + sidecar + 手工预算快照 + owner/revision/meta），维护单调 epoch；所有显式读 / 存 / 采用走 async storage + Web Locks。新增 `getRuntime()`、`adoptRecord(next, capture, options)`、`applyPatch(patch, capture, {notify})`、`applyTripFork(trip, budget, capture)`，并把工作区 / 版本库 / 候选库三个键的 storage 事件统一为「推进 epoch + 失效对应库 generation + 通知 App」，不自动读取。mounted 守卫在 effect setup 里恢复，兼容 React StrictMode dev 的额外 setup+cleanup 周期。 |
| `frontend/src/components/WorkspaceHub.tsx` + `.css` | 工作区 / 版本库入口。新增 `children` 工具槽，由 App 挂载锚点 / 约束 / 清单 / 候选池 / 离线导出；Hub 自身不读 localStorage。 |
| `frontend/src/App.tsx` | 唯一接线父级：`applyWorkspaceRecord` 统一投影 Trip + 预算，`commitTripChange` 处理显式换行程，`commitInternalTripFork` 处理同工作区内的 Trip 副本（草稿 / AI / 地图 / 撤销），并承载六个 feature 入口和恢复 v2。 |
| `frontend/src/components/DayReplanPanel.tsx` | 新增可选 `planningContext`：父级在面板渲染时捕获 record / constraints / epoch，请求前按真实 scope 生成 binding；`PlanningConstraintsError` 与 `ApiError` 分别安全显示，不丢约束静默重试。另提供可选 `liveInputRef`（每次渲染写入 `{trip, revision, dayNumber, contentEpoch, inputEpoch}` 实时代际快照）与可选 `onPlanningInputChanged`（输入 / 上下文代际变化通知）；未提供时旧行为不变。 |
| `frontend/src/__tests__/WorkspaceController.test.ts` | controller 单测（15）。 |
| `frontend/src/__tests__/AppWorkspaceIntegration.test.tsx` | 工作区 / 版本库 / 恢复 v2 / StrictMode 双挂载集成（9）。 |
| `frontend/src/__tests__/AppWorkspacePlanningIntegration.test.tsx` | F1/F2/F3/F5/F6 真实入口 + 候选导入导出 + F5 同 ID 预约修改审计（9）。 |
| `frontend/src/__tests__/DayReplanConstraintsIntegration.test.tsx` | AI day × F2 request body / H / U / 输入代际失效（4）。 |

未改动各 feature 的 lib / panel、API/backend、shared workspace/schema、`workspaceStorage.ts`、`workspaceTransfer.ts`、`sessionRestore.ts`、`SessionResumePanel.tsx`、`workspaceSessionRestore.ts`、公共 types、vite 共享配置。

## 2. 单一内存 authority 与 transition

- 已关联工作区时，所有同 `trip.id` 的改动都走**一次整体 transition**：Trip + sidecar + 手工预算快照同时安装，`workspaceRevision = 当前 + 1`，epoch 推进。覆盖：本地草稿应用、AI 整日 / 后段、地图刷新、取消应用、预算编辑、清单、约束、锚点、版本采用 / 撤销、恢复 v2。
- linked 情况下内部 fork 由 `commitInternalTripFork` 统一调用 `applyTripFork`；`applyWorkspaceRecord` 只投影一次 Trip + budget，避免 revision 双增。
- 只有显式新 owner 才解绑：新规划、旧 Trip JSON 导入、切换到其它 Trip。旧的 `applyTripChange` 仍保留「换 trip.id → 解绑」语义，但内部 fork 不再走它。
- 每次 transition 只改内存；**正式保存是另一次显式动作**，任何 apply / restore / import 都不会自动写工作区键。保存失败保留旧 raw 和已应用的内存 dirty，不声称成功。
- 失败路径：实际引用 / epoch / owner / revision 不匹配时 typed 拒绝，当前 Trip、sidecar、预算和存储都不变，错误进全局横幅。

## 3. 六个 feature 的真实入口

- **F1 锚点与酒店**：Hub 工具槽「住宿与抵离锚点」→ `AnchorsPanel`。App 在打开时捕获 `runtime.capture`；应用时 `applyAnchorsProposal` 后 `adoptRecord(notify:false)`，Trip 内容变化才同步投影并推进页面 revision。
- **F2 必去点与预约**：Hub「必去点与预约时间约束」→ `ConstraintsPanel`。ticket 预检核对 ticket.runtime 的实际 record / trip / sidecar / budget / candidate 引用，再跑 `checkConstraintsApply`；H 级硬冲突不可应用、无确认入口；U 级必须面板内独立勾选确认。
- **F2 × AI day / day_tail**：`DayReplanPanel` 收到 `planningContext` 后，请求体带 `constraints: { version, scope, day, anchor_stop_id, fingerprint, items }`，`parent.revision` 使用统一 workspace revision；只发送全局 + 目标日且 stopId 在当前日的约束，sidecar 仍保留全量。服务端 U 级警告不转成 known；App 对最终候选再跑一次本地 H/U 门，U 级用面板下方独立按钮确认，H 级直接拒绝。U 确认挂起时，App 快照面板实时输入代际（`liveInputRef`）；确认提交做同步 final guard——指令 / 方式 / 人数 / 范围 / 锚点 / 行程内容 / day 任一变化（含 A→B→A）都推进单调 contentEpoch，旧确认（连同旧点击闭包）被拒并提示重新生成；输入变化同时通过 `onPlanningInputChanged` 收起旧确认入口。未改输入的显式确认仍成功，H 不可 override。
- **F3 候选池**：Hub「候选地点池」→ `CandidatePoolPanel`。候选库是独立键：打开 / 保存 / 导出 / 导入都是显式动作，不挂到工作区记录；保存用 `saveCandidatesRecord` + `expectedRaw`，失败保旧；导入先纯校验预览，再 `confirmCandidatesImport`，成功后显示一次撤销；`candidateLocation` 保留在候选库，加入草稿时 TripDraft 不携 coords，不静默补 `(0,0)`；`candidateLocation` 的 caveat 在面板与加入草稿提示中保留。
- **F4 版本库**：Hub 内 `VersionsPanel`。保存 / 采用 / 撤销都由 controller 显式执行；采用与撤销是整体 transition，当前 revision +1，不恢复旧 revision；版本库与工作区分别保存，不声称跨库原子写入，也不使用 F4 sync adapter 的 `writeRaw`。
- **F5 出行清单**：Hub「准备清单」→ `ChecklistPanel`。受控 `onChange` 先生成整体 workspace transition，失败原记录不变；清单 `constraintId` 三态保真（undefined / null / string），删除预约不级联清单、不按同名或日期自动重绑，dangling 保留并提示需重新关联。`previousConstraints` 由 App 维护为「同 ID 约束最近一次修改之前的真实快照」，**只用于检测变化**；提示的解除是逐条的：用户对条目点「按当前预约重新核对」（`action:'reconfirm-constraint'`，`checklist.ts` 的 `reconfirmChecklistItemWithConstraint`）把当前约束声明的锚点写回该条目后，audit 按该条目锚点解除它的提示；「标记需重新关联」（`action:'relink'`）只追加生成标记，不解除任何提示，也没有全局 baseline ack。普通勾 done / 无关编辑不清提示；初始 / reload 为 null 不制造误报。
- **F6 离线页**：Hub 工具槽内 `<OfflineTripPanel record={currentWorkspaceRecord} epoch={workspaceEpoch} />`，使用当前 controller 的单调 safe epoch，而不是默认 0；renderer 只基于当前已应用 workspace + 已通过的 F5 exact `constraintId` audit，不传在途候选 / 其它版本 / 恢复 raw。显式「预览离线行程页」后才出现「下载离线页 (.html)」；生成与下载都不读写存储、不联网。

## 4. 存储 / 候选库 / 版本库事件

- controller 观察 `WORKSPACE_STORAGE_KEY`、`VERSIONS_STORAGE_KEY`、`CANDIDATES_STORAGE_KEY` 的 storage 事件：任一事件（包括 `newValue === oldValue` 或两者都为 null）都推进 App epoch、`invalidateLibraryGenerations(key)`，key 为 null 时失效三个库，并取消旧 prepared / 预览。
- 事件只负责失效和提示「另一处已更新」，**不自动读取**、不覆盖当前内存。App 对候选库事件额外取消导入预览与撤销窗口，并把库代际写进面板状态。
- 同页成功 save / import / undo 后由库自己推进本地 generation；App 更新 raw 基线、dirty 和自身序号，避免旧 confirmation 复活。失败 / quota 不报告保存成功。
- 留存自动写 effect 的依赖包含 `workspaceController.epoch`：sidecar-only transition（清单 / 约束 / 锚点 applyPatch，notify:false）不改 Trip / budget 引用，但每次 transition 都推进 epoch；否则 v2 payload 会停在旧 revision 的 sidecar 上，reload 丢编辑。`persistSessionResume` 不改 epoch，不会自触发循环；flag off / 暂停 / dirty 时仍零读写，写失败保旧 raw。

## 5. 会话恢复 v2

`handleResumeRestore` 的实际顺序：

1. 校验当前 data raw 与 pending 冻结 raw 逐字节一致；不一致停写，双方数据都保留。
2. 父级在预览前捕获 `workspaceController.getRuntime()` 的真实 record / epoch；没有工作区则传 `null`。
3. `prepareSessionWorkspaceRestore({ session, savedAt, raw, currentWorkspace, epoch, now })` 得到 prepared；
   `previewSessionResume(record, nextRevision, { allowWorkspace: true })` 只用于草稿 / 预算 / UI。
4. `prepared.status === 'ready'` 时重新 fresh `loadSessionResumeRecord`，把 fresh raw 传给
   `confirmSessionWorkspaceRestore(prepared, currentWorkspace, epoch, { currentRaw: fresh.raw })`；
   fresh read → confirm → `adoptRecord` 之间没有 await。confirm 结果已是当前 +1，整条记录只安装一次，不再 transition。
5. 安装成功后不自动 `writeWorkspace`；只更新内存、页面投影和提示。v1 / `workspace:null` 走 `no_workspace`：若当前有关联工作区先 `detach`，只恢复 Trip，sidecar 视为空，不按同 `tripId` 读取或挂接工作区库。
6. 自动留存开启时，下一次有界自动写会把恢复后的 workspace（revision 已 +1）投影进 v2 payload；`buildPayloadFromSession` 在自动留存与放弃恢复路径都接收 `workspace: workspaceRecordRef.current`，投影失败则 fail closed 停写。

## 6. 测试与模块解析证据

当前工作树仍可能有同目录 `.js` 产物；所有目标测试使用仓库外 Temp 配置：

- config：`C:/Users/86133/AppData/Local/Temp/opencode/night-20261105/storage-fix/vitest.ts-first.config.mjs`
- root：`F:/MunderDifflin/Travel-Assistant/LangGraph-Smart-Traval-Assitant/frontend`
- `resolve.extensions`：`.ts`, `.tsx`, `.mts`, `.mjs`, `.js`, `.jsx`, `.json`（`.ts/.tsx` 优先）
- 继承 jsdom + `./src/test/setup.ts` + esbuild automatic JSX；仓库 `vite.config` 未被修改。

命令与结果（TS-first 配置）：

```
npx vitest run --config <temp>/vitest.ts-first.config.mjs \
  src/__tests__/WorkspaceController.test.ts \
  src/__tests__/AppWorkspaceIntegration.test.tsx \
  src/__tests__/AppWorkspacePlanningIntegration.test.tsx \
  src/__tests__/DayReplanConstraintsIntegration.test.tsx --no-cache
  → 4 files, 36 passed

npx vitest run --config <temp>/vitest.ts-first.config.mjs \
  src/__tests__/App.test.tsx src/__tests__/AppDraftIntegration.test.tsx \
  src/__tests__/AppDraftWalkingDistanceIntegration.test.tsx \
  src/__tests__/AppMapRefreshIntegration.test.tsx \
  src/__tests__/AppDayReplanIntegration.test.tsx \
  src/__tests__/AppDayReplanTailIntegration.test.tsx \
  src/__tests__/AppBudgetIntegration.test.tsx \
  src/__tests__/AppBudgetTransferIntegration.test.tsx \
  src/__tests__/AppSessionRestoreIntegration.test.tsx \
  src/__tests__/DayReplanPanel.test.tsx --no-cache
  → 10 files, 147 passed

npx tsc -p tsconfig.app.json --noEmit
  → 0 errors
```

说明：以上是当前 TS 源结果，不是同目录旧 `.js` 的结果；报告与 phase2 证据另附 hash。未运行未知 `_indep-probe-0400.test.js`、全量 suite、build、backend pytest 或真实浏览器 E2E。

## 7. 已知缺口 / 待独立门

1. **whole-App 六流程 / 保存重读 / 恢复 reload / 窄屏 E2E 尚无 owner**：本切片完成接线和必要邻接测试，但没有真实浏览器全流程验收；需主 PM 另派非作者整合门 + 浏览器验证，不能由作者自审替代。
2. **F4 内部 fork 后的旧版本**：本地草稿 / AI / 地图会把当前 Trip 换成新 `trip.id` 的副本；此前保存的版本快照属于旧 Trip 身份，采用时会被判为另一行程而不是同行程历史。当前不静默迁移，UI 按旧版本处理。
3. **F5 重新核对的粒度**：逐条「按当前预约重新核对」把当前约束**声明了的**锚点写回该条目；
   同 constraintId 的其它任务各有自己的旧锚与提示，互不影响。`previousConstraints` 快照
   （运行期）只用于检测变化；被标记（notes）的条目在 reload 后仍显示「需重新关联」标签，
   但「已变更」审计行依赖运行期快照，reload 后不可重建（契约锚点 = day/startDate/stopId，
   不含时刻端）。
4. **候选库与工作区不是跨库原子写**：候选库独立保存 / 导入 / 撤销；工作区保存失败只保工作区旧 raw，不会回滚已成功写入的候选库。
5. **恢复 v2 的 confirm 后自动留存**：恢复成功且留存开启时，下一次有界自动写会用恢复后的 revision 更新 data raw（guarded，旧 raw 作 expectedRaw）；这是协议规定的「恢复不是删除」，不是恢复动作本身写库。

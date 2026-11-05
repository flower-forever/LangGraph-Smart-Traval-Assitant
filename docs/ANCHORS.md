# F1 · 住宿与抵离锚点

> 状态：**纯模块 + 受控面板已实现，尚未接入 `App.tsx`，也未接 storage。** 本文件描述
> F1 的消费方式、proposal/apply 边界与 F2 集成接口；不声称功能已经上线。
>
> 公共契约唯一权威：`docs/WORKSPACE_SIDECAR.md`。F1 只消费
> `frontend/src/lib/workspaceTypes.ts` / `workspace.ts` 的公开导出，不复制 schema，
> 不修改公共契约文件。

## 1. 文件与边界

| 文件 | 内容 |
|---|---|
| `frontend/src/lib/anchors.ts` | 表单 ↔ `AnchorsV1`、proposal 构建、冻结校验、显式 apply、F2 硬门报告 |
| `frontend/src/components/AnchorsPanel.tsx` | 受控面板：手工住宿 / 每日起终 / 抵离；预览后显式回调 |
| `frontend/src/components/AnchorsPanel.css` | 面板自有样式，只作用于 `.anchors-*` |
| `frontend/src/__tests__/anchors.test.ts` | 纯模块 / proposal / apply / F2 报告测试 |
| `frontend/src/__tests__/AnchorsPanel.test.tsx` | 面板用户路径测试（离线 DOM） |

不做：geocode、网络请求、自动重排、自动把锚点写进 Trip、自动补坐标、写
`localStorage`、修改 `App.tsx` / `Trip` v1 / 公共 workspace 校验、承诺酒店已保留房间。

## 2. 数据语义

`AnchorsV1` 完全按 `workspaceTypes.ts`：

- `accommodation`：`hotelId` 是**酒店实体** identity，可跨多个 visit 共享；`name` /
  `address` / 日期都允许 `null`。`location` 为真实 WGS84 或 `null`；
  `locationSource` 只在用户填写坐标时是 `'user_provided'`。
- `daily`：key 是规范天序号 `'1'..'366'`，只放有锚点的天。每天 `start` / `end`
  是独立 `DayAnchorV1`。
- `DayAnchorV1.kind='stop'`：只 link 当前天已有 stop，`stopId` 必填；不复制、不改
  stop 的冻结 id。
- `DayAnchorV1.kind='manual'`：`stopId` 必须为 `null`；手工锚点不冒充已有 stop。
- `arrival` / `departure`：机场 / 车站 / 其他，日期与时间可未知。
- **null 不是 0**：坐标、时间、停留、日期未知都用 `null`；0 是合法坐标 / 时刻值。
  模块不会把 `(0,0)` 当未知哨兵，也不会把未知坐标补成 0。
- 日期是行程当地 `YYYY-MM-DD`，时间是 `HH:MM`；不做浏览器时区转换。
- 文案只说「你填写的住宿信息」，不承诺房间保留、预订或确认。

## 3. 纯模块 API

### 3.1 表单 ↔ 契约

```ts
import {
  anchorsToForm,
  buildAnchorsFromForm,
  emptyAccommodationForm,
  emptyAnchorsForm,
  emptyDayAnchorForm,
  emptyTransportAnchorForm,
} from './lib/anchors'

const form = anchorsToForm(record.sidecar.anchors)
const built = buildAnchorsFromForm(form, (kind) => createLogicalId())
// built.ok ? built.value : built.reason / built.message
```

`buildAnchorsFromForm` 只做字段形状 / 真实日历日 / `HH:MM` / 坐标范围解析，并生成
缺失的 `hotelId` / `anchorId`。与当前 Trip 的匹配不在这一步。

### 3.2 proposal

```ts
import { createAnchorsProposal } from './lib/anchors'

const result = createAnchorsProposal({
  record,                 // 完整 WorkspaceRecordV1
  epoch,                  // 组件级单调 epoch
  anchors,                // AnchorsV1
  newLegMode: 'walking',  // 新增 occurrence 的 leg 显式模式，不猜
  createStopId,           // 可选注入；缺省 createLogicalId()
})
```

成功返回 `AnchorsProposal`：

- `owner`：完整 `WorkspaceOwnerV1`（canonical 快照 + identity + revision + epoch）；
- `baseRevision` / `baseTripId`：输入工作区版本与行程；
- `nextAnchors`：应用后写入 `sidecar.anchors` 的值；手工酒店锚点会变成
  `kind:'stop'`，指向本次生成的独立 occurrence；
- `nextSidecar`：只替换 `anchors`，`constraints` / `checklist` / `applies` 原样保留；
- `trip`：应用后的 Trip 草稿；只新增 occurrence，既有 stop / leg 内容与 id 不变；
- `occurrences`：本次新增的独立酒店 stop；同一天起点 / 终点、跨天都不会复用 id；
- `placements`：每个锚点的明确状态
  - `linked_existing`：链接已有 stop，不复制；
  - `new_occurrence`：将新增独立酒店停靠（预览阶段未写入）；
  - `reference_only`：仅参考，不写入 Trip；
- `hardGate` / `conflicts`：时间 / 引用 / 未知项的冲突报告；
- `notices`：日期、未知坐标、抵离时间等固定提示；
- `newLegMode`：冻结校验使用的模式。

失败返回 `{ok:false, reason, message, path?}`。失败时不会修改输入记录、Trip、
anchors；不会返回半截 proposal。

### 3.3 显式 apply

```ts
import { applyAnchorsProposal, anchorsProposalMatches } from './lib/anchors'

if (!anchorsProposalMatches(proposal, record)) {
  // owner / revision 已变，重新预览
}
const applied = applyAnchorsProposal(record, proposal, now)
// applied.ok ? applied.value : 旧记录与旧字节不变
```

`applyAnchorsProposal`：

1. 重新校验完整记录；
2. 核对 proposal 的 owner / revision / tripId；
3. 核对冻结前缀：proposal 的 Trip 只能等于「原站点顺序 + 本次 occurrence」，
   原 stop / leg 内容与 id 不变，标题 / 摘要 / 警告 / 天数不变；
4. 核对 `nextSidecar` 只改 `anchors`；
5. 调用 `commitWorkspaceTransition(record, { trip, sidecar }, now)` —— 内存单一
   transition，`workspaceRevision = 当前值 + 1`。

它**不写 storage**。持久保存必须由父级 storage owner 在显式用户操作后单键
`setItem`，成功后才更新持久状态。

## 4. 面板集成

```tsx
import AnchorsPanel, { type AnchorsPanelApplyResult } from './components/AnchorsPanel'

<AnchorsPanel
  record={record}
  epoch={epoch}
  newLegMode={newLegMode}
  createId={(kind) => createLogicalId()}
  onApply={(proposal): AnchorsPanelApplyResult | void => {
    const applied = applyAnchorsProposal(record, proposal, Date.now())
    if (!applied.ok) return { ok: false, message: applied.message }
    // 父级唯一的 storage owner 在此显式保存；保存成功后再 setRecord(applied.value)
    return { ok: true }
  }}
  onClose={closePanel}
/>
```

- 面板从 `record.sidecar.anchors` 初始化；只在本地表单工作。
- 点「预览提案」生成 proposal；点「应用提案」才调用 `onApply`。
- 改动输入会作废旧预览；「取消预览」保留表单并说明原工作区未变。
- `onApply` 返回 `{ok:false,message}` 时，面板显示错误并保留预览与表单；
  `record` 不变。
- 面板不写 storage、不发请求、不自动 apply；`onClose` 只收起。

**尚未接入**：`App.tsx` 入口、工作区 storage owner、全局样式、e2e 由后续集成
owner 串行接入。当前面板上没有「已在行程」状态；`placements` 明确区分三种关系。

## 5. F2 最终硬门接口

```ts
import { evaluateAnchorsHardGate } from './lib/anchors'

const report = evaluateAnchorsHardGate(currentTrip, currentAnchors)
// report.blockers   -> 明确冲突，F2/H 级应禁 apply
// report.unverified -> 时间 / 停留 / 路段未知，F2 U 级，必须独立确认
// report.anchorsAreTripStops === false
```

规则：

- 起点有 `time` 且当天首站有可解析开始时间：首站 **不得早于** 起点；否则
  `start_after_first_stop` blocker。
- 终点有 `time` 且末站有可解析开始时间：
  - 末站 `duration_minutes === null` → `end_stop_duration_unknown` unverified；
  - 已知停留 → 末站结束下界晚于终点 → `end_after_anchor` blocker。
- 相邻 leg `duration_minutes === null` → `leg_duration_unknown` unverified；不补 0、
  不假设可达。
- 引用 stop 已删除 / 不在当天 → `stop_missing` blocker。
- 锚点日期与当天日期不一致、酒店锚点超出入住 / 退房范围、退房早于入住 →
  blocker。
- `anchorsAreTripStops: false` 是固定语义：侧栏锚点不是 Trip 停靠；F2 不得把
  anchor 当作已经落在行程中的站点。酒店 occurrence 只有用户显式 apply 后才进入
  Trip。

F2 在候选 apply 前应把 `blockers` 当作 H 级硬门，把 `unverified` 当作 U 级，
并按 `docs/WORKSPACE_SIDECAR.md` 的 owner / revision / 确认绑定规则处理。

## 6. 测试

本次实跑（仅目标文件，离线 DOM，无网络 / 无 storage 写入）：

```powershell
cd frontend
pnpm exec vitest run src/__tests__/anchors.test.ts src/__tests__/AnchorsPanel.test.tsx
npx tsc --noEmit ... src/lib/anchors.ts src/components/AnchorsPanel.tsx \
  src/__tests__/anchors.test.ts src/__tests__/AnchorsPanel.test.tsx src/test/setup.ts
```

覆盖：酒店同日首末 / 跨日独立 id、hotelId 共享、link 已有 stop 不复制、坐标
null 与 0、坏日期 / 不存在 day / stop、单日 100 站限站、冻结前缀、用户编辑不改
已应用 Trip、预览取消失败保旧、面板显式回调、apply 失败保旧、重复应用不生成重复
occurrence、F2 blocker / unverified 报告。

未跑：全前端 test / build / e2e、后端、依赖安装。当前工作区其它并行 feature 的
文件可能尚未通过全量 `tsc`，F1 目标文件已单独 noEmit 通过。

## 7. 已知限制 / 后续集成

- 面板 `onApply` 是同步回调；父级若需要异步保存，应在父级内部处理，不要让它
  修改 proposal 或 record。
- 撤销栈不在面板内；父级可用 `commitWorkspaceTransition` 做一次整体 undo（恢复
  Trip + sidecar，revision 仍 +1），不要把 F1 锚点撤销与行程草稿 undo 混在一起。
- 同一份 proposal 第二次 apply 会因 revision 变化明确失败；重新预览后，已链接的
  酒店锚点不会再次生成 occurrence。
- `hotelId` / `anchorId` 是调用方提供的逻辑 id；集成 owner 应统一使用
  `createLogicalId()` 或自己的随机 id 工厂，不采集浏览器指纹。
- 旧 Trip 导入默认不挂接 anchors；必须由用户显式选择工作区后才有 sidecar。

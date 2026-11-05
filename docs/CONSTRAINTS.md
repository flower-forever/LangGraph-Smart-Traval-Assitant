# F2 · 必去点与预约时间约束（前端本地模块 / Panel）

> 状态：**前端纯模块 + 受控 Panel + 单测 + 本地文档**。  
> 本文件不声称 App 已接线、后端已实现或完整纵向 feature 已交付。  
> 公共 schema 以 `docs/WORKSPACE_SIDECAR.md` 为唯一权威；本模块只消费
> `workspaceTypes.ts` / `workspace.ts` / `workspaceFingerprint.ts` 的既有导出，
> 不复制 schema、不新造请求字段、不改 Trip v1。

适用基线：`F:/MunderDifflin/Travel-Assistant/LangGraph-Smart-Traval-Assitant`。  
契约修订对齐：S1 R1 + C1 独立 PASS 后的 `R1-CONTRACT-REPORT.md` / `R1-SHA256.txt`
（`night-20261105/`）。

---

## 1. 交付边界

本批只新增：

| 文件 | 作用 |
|---|---|
| `frontend/src/lib/constraints.ts` | 约束编辑、目标解析、H/U 本地硬门、apply ticket / ack / 引用门 |
| `frontend/src/components/ConstraintsPanel.tsx` | 受控约束编辑与本地硬门预览 Panel |
| `frontend/src/components/constraintsPanel.css` | Panel 私有样式（`.cfp-` 前缀） |
| `frontend/src/__tests__/constraints.test.ts` | 纯模块测试 |
| `frontend/src/__tests__/ConstraintsPanel.test.tsx` | Panel 用户路径测试 |
| `docs/CONSTRAINTS.md` | 本文件 |

**未做 / 不在本批**：

- 不改 `App.tsx`、`DayReplanPanel.tsx`、`e2e/runner.mjs`、`api.ts`、`workspace*.ts`、
  `backend/**`、共享 CSS、其它 feature 的 storage。
- 不实现 `/api/trips/plan` / `/api/trips/days/replan` 的 wire 请求字段。后端
  `constraints` 的唯一权威是 `docs/WORKSPACE_SIDECAR.md` §11 / §11.7；本模块不另造
  `constraints` 请求 shape，也不把 constraints 塞进 `instruction`。
- 不声称 `App` 集成、持久化、E2E 或后端 contract 已完成；这些由对应唯一 owner
  后续接入。
- 不读 `.env` / `_repro_surrogate.py`，不写 Git，不安装依赖，不发起业务外网请求。

---

## 2. 公共接口（稳定导出）

### 2.1 编辑 / 容量

```ts
parseConstraintClock(value): number | null
parseConstraintDate(value): ConstraintCivilDate | null
constraintLocalMinute(date, time): number | null
normalizeConstraintTitle(title): string

constraintsByteLength(constraints): number
checkConstraintsCapacity(constraints): ConstraintsCapacityResult
constraintsFingerprint(constraints): WorkspaceFingerprintV1 | null
constraintsContentEqual(left, right): boolean
cloneConstraints(constraints): ConstraintsV1

makeConstraintItem(input, now): WorkspaceValidationResult<ConstraintItemV1>
addConstraintItem(constraints, item): WorkspaceValidationResult<ConstraintsV1>
replaceConstraintItem(constraints, item): WorkspaceValidationResult<ConstraintsV1>
removeConstraintItem(constraints, id): WorkspaceValidationResult<ConstraintsV1>
advanceConstraintsEpoch(current): WorkspaceValidationResult<number>
```

- 条数上限 `24`、紧凑 JSON UTF-8 上限 `16 KiB`；超限明确失败，不截断、不丢条目。
- 所有编辑函数返回新对象；**不修改 Trip、不修改传入 constraints**。
- `0` 分钟停留 / `0` 分钟交通是合法已知值；`null` 才是未知，绝不补 0。

### 2.2 本地 H/U 硬门

```ts
evaluateConstraintsAgainstTrip(input): ConstraintsEvaluationResult
```

`input`：

```ts
{
  constraints: ConstraintsV1
  /** 最终要应用的完整 Trip（day_tail 必须传合并后的整条 Trip） */
  trip: Trip
  /** 生成候选前的基准 Trip；AI 重写 stop id 时用于唯一名称 / 坐标映射 */
  sourceTrip?: Trip | null
  /** 提供 record + planScope 时复用公共 scope 校验 */
  record?: WorkspaceRecordV1 | null
  planScope?: PlanScopeV1 | null
  /** stopId → 时间来源；缺省 / 未列出 / placeholder / unknown 一律按未知，只有显式 known 才核 H */
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
  /** 冻结段快照；day_tail 由客户端完整检查；冻结本身不证明时间已核实 */
  frozenStops?: readonly TripStop[] | null
  frozenStopIds?: readonly string[] | null
}
```

返回：

```ts
{
  ok: true,
  verdict: 'pass' | 'needs_ack' | 'blocked',
  hardIssues: ConstraintIssue[],     // H
  unknownIssues: ConstraintIssue[],  // U
  issues: ConstraintIssue[],
  safeToApply: boolean,              // 只有 pass 为 true
  requiresAck: boolean,              // 只有 needs_ack 为 true
  resolutions: ConstraintTargetResolution[],
  mappedConstraints: ConstraintsV1,  // 仅供评估；null 目标不伪造 stop id
  constraintsBytes: number,
  notices: string[]
}
```

`ok:false` 只用于结构 / 容量 / scope 不合法，不是 H/U 结论。

### 2.3 apply ticket / U 确认 / 引用门

```ts
createConstraintsApplyTicket(input): { ok: true; value } | ConstraintsApplyFailure
checkConstraintsApply(input): ConstraintsApplyDecision
```

`createConstraintsApplyTicket` 绑定：

1. **owner**：整条工作区记录的 canonical + identity + revision + epoch
   （`createWorkspaceOwner`）。
2. **binding**：完整约束 canonical + identity + revision + `planScope` + epoch
   （`createConstraintsBinding`）。
3. **U ack**：仅 `needs_ack` 需要，`createUnverifiedConstraintsAck`；
   `blocked` 拒绝生成，`pass` 的 `ack` 为 `null`。
4. **candidate**：候选 Trip 完整 canonical + `tripId`。
5. **runtime**：`captureWorkspaceRuntime(record, epoch, { input: candidateTrip })`
   的实际对象引用捕获；**不序列化、不入 storage**。
6. **evaluationContext**：`timeOrigins` + 冻结段输入的 canonical 指纹；这些输入
   变化会改变 H/U，旧 ticket 与 U ack 不能再复用。旧 ticket 缺该字段时，仅当前
   上下文也为空才兼容。旧 ticket 缺该字段时，仅当前
   上下文也为空才兼容；当前上下文非空一律拒绝。

`checkConstraintsApply` 顺序：

1. 在最终合并 Trip 上重跑 H/U；
2. `evaluationContext` 指纹严格相等（timeOrigins / frozen 输入未变化）；
3. `workspaceRuntimeRefsMatch(...)` 严格 `===` + epoch；
4. `workspaceOwnerMatches(...)`；
5. `constraintsBindingMatches(...)`；
6. scope 相等、候选 canonical / tripId 相等；
7. U 级 `unverifiedConstraintsAckMatches(...)`。

任一项变化都拒绝。**运行时 helper 只比较实际引用 + epoch，不会自动推进 epoch，
也不会做内容匹配**；必须与 owner / binding 的 canonical + revision 组合使用。

**epoch 规则**：Panel 每次编辑 / 切换查看 / 取消 / 采纳 / 撤销 / 还原都推进
`advanceConstraintsEpoch` 并丢弃旧 ticket。即使内容 A→B→A 回到旧值，revision /
epoch 已前进，旧 U 确认也不会复活。`timeOrigins` / 冻结段输入变化同样推进 Panel
内部 epoch、清空旧 ticket 与 ack；ticket 另绑定评估输入指纹，guard 会拒绝换上下文
复用。

---

## 3. H 级 / U 级语义

| 结论 | 条件 | apply |
|---|---|---|
| **H** | 已知必去目标缺失；目标 stop 不在指定日 / 已删；已知到达晚于窗口；目标站开始晚于窗口或早于窗口；停留已知超出窗口；两个完整 `fixed_window` 重叠；冻结段站点被删 / 被改 | **直接禁 apply，用户不可 override** |
| **U** | `fixed_window` 任一必要端未知；目标开始时刻未显式提供 `known` 来源 / `placeholder` / `unknown`；停留未知；交通耗时未知；前站时间或停留未知；目标日无真实日期；同名多站；坐标矛盾；身份无法确证 | **不得声称已满足**；apply 前必须独立确认「仍采用含未核实时间方案」 |
| **pass** | 无 H、无 U | 可进入工作区 transition（仍需完整 ticket / 引用门） |

补充：

- `must_visit` 的 `stopId` 可为 `null`：用 **规范化 title + day** 表达初始目标实体；
  候选 Trip 必须有唯一匹配站点。零命中 = H；同名多站 = U；**不 silent 挑第一个**。
- `trip_plan` scope：所有 `stopId` 必须为 `null`。`day` / `day_tail` scope 的
  day / stop 关联直接复用公共 `validatePlanScope` + `validateConstraintsForScope`，
  本模块不重造 scope 规则。
- `fixed_window` 完整起止 = `startDate + endDate + startTime + endTime` 全部已知且
  日期真实，才可硬验证。任一端 `null` → U。
- 固定开始时刻可硬核「到达不晚于计划开始」；已知到达晚于窗口结束 = H。
- **跨日窗口**只按显式 `startDate` / `endDate` + 日内时刻计算。同日期
  `22:00 → 02:00` 是非法；跨午夜必须写次日 `endDate`。酒店连住不是景点预约。
- 日期 / 时刻只用行程记录的当地日期与 `HH:MM` 做整数运算，不用浏览器隐式时区转换。
- 站点开始时刻默认 `unknown`：只有调用方显式提供 `timeOrigins[stopId] === 'known'`
  才按真实时刻核 H / 通过。缺 map、缺 entry、`placeholder`、`unknown` 全部按未知，
  **不因 `Trip.time` 是非空字符串就推断 known**。
- 后端 `_time_origins` 不随当前 wire 保留时，新 AI 站即使写着 `09:00` 也必须由集成层
  按 unknown 传入；本地 gate 不会把归一化占位值当成已知端。
- 服务端 `warnings` 中的占位 / 未核实信息也必须在本地 gate 传入，不能靠“无警告”
  或响应自报字段绕过。
- `must_visit` / `fixed_window` 的 `reminder` 只提醒，不阻断。
- 目标解析：
  - 候选保留原 stop id → exact；
  - id 被重写 → 只在目标日按规范化名称唯一匹配；同名多站 = U；
  - 双方坐标已知且不同 = U 坐标矛盾；
  - 至少一方坐标未知 = U 身份未核实；
  - 无法唯一解析时绝不说 H 已满足。

---

## 4. day_tail 冻结段

服务端看不到客户端冻结前缀，因此：

- `evaluateConstraintsAgainstTrip` 的 `trip` 必须是**最终合并 Trip**，不是仅后段。
- 传入 `frozenStops` / `frozenStopIds` 时，客户端在最终 Trip 上检查：
  - 冻结 stop 被删 → H `frozen_stop_missing`；
  - id / name / time / duration / address / description / location 任一变化 →
    H `frozen_stop_changed`。
- **冻结只证明该段不得变更，不证明时间已核实**：仅传 `frozenStopIds` / `frozenStops`
  不会把旧 `09:00` 占位标成 known；要 known 必须另有显式可信 `timeOrigins`（或同
  id / time 上下文一致的已验证 base 来源映射），否则按 U。不得按“已冻结”批量推 known。
- `map-refresh` / `leg-refresh` 不接收 constraints 字段；其结果合入 / apply 时仍要
  在最终 Trip 上跑本硬门。

---

## 5. Panel props

```ts
interface ConstraintsPanelProps {
  constraints: ConstraintsV1
  trip: Trip
  workspaceRevision: number
  epoch: number
  candidateTrip?: Trip | null
  record?: WorkspaceRecordV1 | null
  runtimeCapture?: WorkspaceRuntimeCaptureV1 | null
  planScope?: PlanScopeV1 | null
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
  frozenStops?: readonly TripStop[] | null
  frozenStopIds?: readonly string[] | null
  onApply?: (request: ConstraintsPanelApplyRequest) => ConstraintsPanelApplyResult | void
  onClose?: () => void
  now?: () => number
}
```

`ConstraintsPanelApplyRequest`：

```ts
{
  constraints: ConstraintsV1
  candidateTrip: Trip
  planScope: PlanScopeV1
  epoch: number
  ticket: ConstraintsApplyTicketV1
  evaluation: ConstraintsEvaluation
}
```

行为：

- 所有编辑先落组件内存草稿；点「应用约束改动」才通过 `onApply` 交给父级。
- Panel 不写 localStorage、不改 Trip、不改共享状态。
- H 级：应用按钮禁用，没有确认绕过入口。
- U 级：必须勾选「仍采用含未核实时间方案」才能应用；勾选只对当前 ticket 有效。
- 每次编辑 / 切换 / 取消 / 采纳 / 撤销 / 还原推进内部 epoch 并清空旧 ticket / ack。
- `record` 缺失时只能本地预览，不能声称已应用。
- `runtimeCapture` 是调用方在**当前 `props.epoch`** 下的实际引用捕获；若其 epoch
  已落后于 Panel 内部编辑后的 epoch，Panel 会在 apply 时用当前 `record` / 候选
  重新 capture（不从旧 capture 反填 current），并在 ticket 中绑定新引用 + 新 epoch。
- `timeOrigins` / `frozenStops` 必须由集成 owner 从 server 响应 / 当前基准 Trip
  映射；**缺省按 unknown**，Panel 不猜占位时间。不能因为 `Trip.time` 非空或站点被
  冻结就批量标 known；只有明确可信来源才显式传 `known`，缺数据就让用户走 U 确认。
- `timeOrigins` / `frozenStops` / `frozenStopIds` 变化时，Panel 会推进内部 epoch、
  清空旧 ticket 与 ack；这些输入影响 H/U，不能沿用旧确认。

集成 owner 仍需负责：

1. 把 `onApply` 的约束与 ticket 送入工作区唯一 transition（`commitWorkspaceTransition`），
   并持久化；
2. AI 候选 apply 前调用 `checkConstraintsApply`，不要只信 response 自报；
3. initial `/plan` 的 constraints wire 按 `docs/WORKSPACE_SIDECAR.md` §11 由后端 owner
   实现，本模块不定义请求字段；
4. App 面板挂载 / 收起 / 回焦沿用现有受控面板范式。

---

## 6. 测试与验证

本批实跑（2026-11-06 01:54 北京，Temp 配置）：

- `frontend/src/__tests__/constraints.test.ts`：**42 passed**
- `frontend/src/__tests__/ConstraintsPanel.test.tsx`：**16 passed**
- 合计 **58 passed**，2 files。
- 目标 TypeScript `tsc --noEmit`（Temp tsconfig + Temp tsbuildinfo）：**exit 0**。

覆盖重点：

- H 不可 override；`must_visit` 缺失 / 同名多站 U；固定窗口重叠。
- `null` vs `0`；停留 0 / 交通 0 / distance 0 合法。
- 固定开始 / 完整窗口 / 跨午夜显式 `startDate` / `endDate` / 00:00 边界。
- 已知不可能 vs 未知；默认无 origin / 缺 entry / `placeholder` 09:00 → U；显式 `known`
  才按真实时刻 H / pass。
- 部分 origin map、未标 origin 的冻结站点、`frozenStopIds` 单独存在均不自动 known；
  显式 known 冻结站点保留真实 H。
- ticket 的 `timeOrigins` / 冻结段评估输入变化（含反向）后旧 ticket / U ack 失效。
- 重复名称 / 重复 ID / 坐标矛盾 / 唯一 ID 重写映射。
- 冻结段被删 / 被改 → H。
- 超过 24 条 / 16 KiB 明确失败。
- 编组编辑不改 Trip；纯 evaluate 不污染 current record。
- ticket / ack / scope / 换引用同内容 / 原地突变 + 事件 ABA / 旧确认不复活。
- Panel：H 禁用、U 确认、epoch 递增、编辑后旧 ack 清空、受控编辑不写 storage。

**未跑**：full 前端 suite、build、E2E、backend pytest；本批只在 Temp 跑自身
module / Panel 测试与目标 noEmit。缓存 / tsbuildinfo / 日志均在
`C:/Users/86133/AppData/Local/Temp/opencode/night-20261105/f2-timeorigin-fix/`。

---

## 7. 与 W1 R1 / C1 的对齐点

- 唯一 schema 来自 `workspaceTypes.ts`；本模块不新增字段、不改 Trip v1。
- `trip_plan` 的 `must_visit` 允许 `{ day, title, stopId: null }`；非 null `stopId`
  由公共 `validateConstraintsForScope` 拒绝。
- `day` / `day_tail` 的 day / stop / anchor 关联直接调用公共 scope helper。
- `captureWorkspaceRuntime` / `workspaceRuntimeRefsMatch` 只做实际引用 + epoch；
  本模块在 ticket 中组合 `workspaceOwnerMatches` / `constraintsBindingMatches` /
  `unverifiedConstraintsAckMatches`，不把逻辑 ID 或 short hash 当自证。
- 时间来源默认 unknown；只有显式可信 `timeOrigins` 的 `known` 才按真实时刻核 H。
  非空 `Stop.time`、AI 归一化 `09:00`、冻结段存在本身都不证明 known；当前 wire 不保留
  `_time_origins` 时新 AI 站保持 unknown，缺数据走 U 独立确认。
- ticket 绑定 `timeOrigins` + 冻结段评估输入指纹；这些输入变化会拒绝旧 ticket / U ack。
- 服务端占位时间 / warnings 仍必须映射到 `timeOrigins`；本地 gate 不绕。
- backend `constraints` wire 等后端 owner 按 `docs/WORKSPACE_SIDECAR.md` §11 /
  §11.7 实现；本模块不 chunk instruction、不加 endpoint、不截断原指令。

---

## 8. 未完成 / 后续

- App 面板挂载、工作区 transition / 持久化接线：UI integrator / storage owner。
- `/plan`、`/days/replan`、`day_tail` 的 constraints 请求链：F2 后端 owner；本模块只
  提供本地 hard gate / binding / ticket，不定义 wire。
- 初始规划 target editor 的 App 入口：等 UI integrator 接入；本模块已支持
  `stopId: null` + title/day 本地目标表达与候选唯一匹配。
- E2E 场景：由 W-E2E owner 接入 runner 并真实跑 browser。
- full suite / build / backend 回归：整合期统一执行；本文件不冒称已跑。

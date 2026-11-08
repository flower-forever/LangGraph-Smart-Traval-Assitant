# F5 · 出行准备清单（checklist）

> 状态：**纯模块 + 受控面板切片（2026-11-06 凌晨，F5 constraintId 定向修复）**。
> 本文件只描述 F5 自身；数据形状、容量、sidecar 归属以
> `docs/WORKSPACE_SIDECAR.md` 为唯一权威。可选 `ChecklistItemV1.constraintId`
> 由公共契约 W1 释放，F5 只消费、不改 schema。面板尚未接入 `App.tsx`（热文件由
> UI integrator 串行接线），存储写入与运行期引用门由统一工作区 adapter / 父级负责；
> 这些不属于本切片。

---

## 1. 范围与边界

**做**：票务 / 预约 / 证件 / 行李 / 待确认事项的手工增、改、删、勾选；关联日期、
天序号、行程 stop；记录 F2 约束的真实 `constraintId` 并带入其日期 / 天 / 地点；
模板建议；stop / 约束失效后的「需重新关联」提示；供 F6 读取的只读有效清单。

**不做**：

- 不读写 `localStorage`、不新建存储键、不写 Trip；清单只属于
  `WorkspaceSidecarV1.checklist`。
- 不查询票务 / 库存 / 出票 / 预约状态；不发送邮件、推送或短信。
- 不自动勾选、不自动把模板写进清单、不自动删除被 stop / 约束引用的任务。
- 不扩展 schema：可选 `ChecklistItemV1.constraintId` 由公共契约 owner（W1）释放，
  F5 只消费；不改 `workspaceTypes.ts` / `workspace.ts` / 公共 validator。

**文案红线**：勾选状态固定为「已准备 / 未准备」；标题、备注、按钮与提示中不得出现
「已预订 / 已出票 / 已确认库存」等承诺。打勾只表示用户自己完成核对。

---

## 2. 数据归属与持久化

```ts
// docs/WORKSPACE_SIDECAR.md 已定义；F5 不复制也不修改
interface ChecklistV1 {
  items: ChecklistItemV1[]
  appliedTemplates: string[]
}
```

`ChecklistItemV1.constraintId?: string | null` 的三态（由公共契约 W1 释放，F5 只消费）：

| 值 | 含义 | 读 / 保存 / 勾选 / 模板 |
|---|---|---|
| 属性缺省（或 `undefined`） | 旧 v1 记录未携带预约关联 | **不补 `null`**，不参与启发式关联；只提示「未记录预约关联 / 可手动关联」 |
| 显式 `null` | 用户明确解除预约关联 | 原样保留；不报「约束已删除」，不重写 |
| 非空 string | 弱引用 `ConstraintItemV1.id` | 精确按 ID 匹配；约束删除后允许 dangling，任务与 ID 都保留 |

日期 / 天 / stop 是展示与旧数据兼容锚点，**不能替代** `constraintId`；同名或相同
date / day / stop 的另一个约束不会被自动绑定。

- 清单是**工作区记录** `sidecar.checklist` 的一段；整个工作区仍按契约「Trip v1 +
  sidecar + budget + meta，一次单键 `setItem`」保存。
- `done` 不进入 Trip；F5 的所有 reducer 都不接收 Trip，只接受 checklist。
- 记录损坏 / 超限 / QuotaExceeded 的「失败保旧」由工作区 adapter 执行；F5 reducer
  只在内存里构造下一版并复检，失败返回 failure，入参对象不变。
- **清单段损坏（salvage）**：storage 返回只读 + 可展示 Trip 时，面板以
  `status="salvage"` 只读展示提示；**不把空清单写回**，原字节保留。
  只有用户显式删除 / 重建记录（工作区 adapter 的修复流程）后才能重新编辑。
- 本切片**不提供**工作区备份 / 导入 UI；由 `workspaceStorage.ts` 的备份中心统一
  覆盖清单（`docs/WORKSPACE_SIDECAR.md` §7）。F5 的单元测试只验证清单段本身。

---

## 3. 纯函数 API（`frontend/src/lib/checklist.ts`）

### 3.1 结果与上限

```ts
type ChecklistMutationResult =
  | { ok: true; value: ChecklistV1 }
  | { ok: false; reason: ChecklistFailureReason; message: string; path?: string }
```

所有 reducer 的统一门禁：

1. 构造下一版（只投影已声明字段）；
2. 调公共 `validateChecklist`（`workspace.ts`）复检字段、枚举、日期 / 时间、条数、
   重复 id 与未知字段；
3. 按实际紧凑 JSON 的 **UTF-8 字节**做 sidecar 字节预检（≤ 512 KiB）；失败即
   `limit_exceeded`，旧值不变，不截断。

字段上限沿用 `workspaceTypes.ts`：标题 200、备注 1000、清单 300 项、已采纳模板 50、
模板 id 100、天序号 1–366、`constraintId` 200（与 `ConstraintItemV1.id` 同规则）。
面板输入框的 `maxLength` 与上限常量同源。

### 3.2 增 / 改 / 勾选 / 删

| 导出 | 语义 |
|---|---|
| `createChecklistItem(input, { id, now })` | 纯构造；`done:false`，空字符串归一为 `null` |
| `addChecklistItem(checklist, input, { id, now })` | 新条目一律未准备；重复 id / 超限失败 |
| `updateChecklistItem(checklist, id, patch, now)` | 只改分类 / 标题 / 日期 / 天 / 备注；不动 id、done、stop 关联 |
| `setChecklistItemDone` / `toggleChecklistItem` | 只改 `done` 与 `updatedAt` |
| `deleteChecklistItem(checklist, id)` | 只删清单项；不碰 Trip / 约束 |

`date: ''`、`notes: ''`、`stopId: ''` 归一为 `null`；**`day: 0` 不是 null，会被
validator 拒绝**；未知时间 / 天数不补 0。`ChecklistItemInput.constraintId` 只在
显式关联预约时传入；普通新增 / 模板不传，保持旧 v1 的属性缺省。

### 3.3 模板

```ts
CHECKLIST_TEMPLATES                  // 机票 / 火车 / 住宿 / 证件 / 充电 / 常用药 / 雨具 / 预约
listChecklistTemplateSuggestions(id, checklist)
applyChecklistTemplate(checklist, templateId, {
  selectedSuggestionIds, now, idFactory,
})
```

- `list…` 只返回建议，**不改 checklist**；`appliedTemplates` 只用于提示「已采纳过」。
- `apply…` 必须收到**显式选中**的建议 id；未选 → `no_selection`；未知建议 / 模板 →
  失败；新增项全部 `done:false`，`date/day/stopId` 为 `null`。
- `appliedTemplates` 每个模板只记一次；再次采纳允许，用于补加缺少的条目。

### 3.4 关联与失效

| 场景 | 行为 |
|---|---|
| 关联 stop | `linkChecklistItemToStop`：写 `stopId`、可选 `day`，清空 `originalStopId` |
| 解除 stop | `unlinkChecklistItem`：任务保留；`stopId=null`，旧 id 进 `originalStopId`，备注追加「需重新关联」 |
| 关联约束 | `linkChecklistItemToConstraint`：写入真实 `constraintId = constraint.id`，同时带入 `day` / `startDate` / `stopId` 锚点；不改约束、不改 Trip |
| 解除约束 | `unlinkChecklistItemFromConstraint`：只把 `constraintId` 写为 `null`；日期 / 天 / stop / notes / done 全部保留，与「解除地点关联」严格区分 |
| stop 被删 | `auditChecklistLinks` 报 `stop_deleted`；用户点「标记需重新关联」后调 `markChecklistItemNeedsRelink`，保留任务与 done |
| 约束被删 | 当前 constraints 存在且条目的非空 `constraintId` 找不到对应 ID → `constraint_deleted`；`markChecklistItemNeedsRelink(..., 'constraint_deleted')` 只追加复核备注，**保留 dangling ID、日期 / 天 / stop、任务与 done** |
| 约束变更 | 传入 `previousConstraints` 且同 ID 的 `day` / `startDate` / `stopId` 变化 → `constraint_changed`；同样保留任务与 ID，只追加复核备注 |
| 逐条重新核对 | `reconfirmChecklistItemWithConstraint(checklist, id, constraint, now)`：**仅当**条目 `constraintId === constraint.id`；把当前约束**声明了的** `day` / `startDate` / `stopId` 写回条目（未声明字段保留原值；约束声明 stop 时清 `originalStopId`），并移除生成标记 `constraint_changed`；done / 标题 / 用户备注与其它生成标记原样保留。ID 不同 → `invalid_input` typed 失败，本函数不是改绑 |

**精确外键语义（Important-1 修复）**：

- `constraintMatchesChecklistItem(item, constraint)` 与
  `planConstraintRemovalImpact(checklist, constraint)` **只**比较
  `item.constraintId === constraint.id`；同名或相同 date / day / stop 的另一个约束
  不会被自动绑定，也不会被误报为受影响。
- `checklistItemConstraintState(item)` 返回 `unrecorded / unlinked / linked`，
  区分旧属性缺省、显式 `null`、真实 ID；普通读 / 保存 / 勾选 / 模板**不**自动补
  `null`，只有显式 link / unlink 才写字段。对旧缺省 `undefined` 调用 unlink 保持
  缺省（不把未知历史改写成「明确未关联」）；对已记录的非空 ID 才写显式 `null`。
- 删除或变更约束不级联删除任务、不清空 `constraintId`、不改用户手工 date / notes；
  审计结果只提案，不自动写清单或 Trip。
- `previousConstraints` 只用于①同 ID 的删除标题提示②同 ID 的字段变更检测；
  **不**用旧约束 / 锚点去匹配没有 `constraintId` 的旧数据，也不制造关联事实。
- `auditChecklistLinks` 额外返回 `unrecordedConstraintItems`：旧记录仅提示
  「未记录预约关联 / 可手动关联」，绝不标成某个已删除预约的任务。
- dangling 提示只描述「需重新确认关联」，不写「预约已确认 / 已预订」。

`checklistItemNeedsRelink(item)` 用于列表标记：`stopId=null && originalStopId!=null`
或备注内已含固定提示文案（含 `constraint_deleted` / `constraint_changed`）。

**标记 ≠ 确认（per-item 语义，2026-11-06 修订）**：

- `markChecklistItemNeedsRelink` 只追加生成标记，**不承担确认**：不改日期 / 天 / stop /
  done / constraintId，也不会让任何提示消失。
- `checklistItemAnchorsMatchConstraint(item, constraint)`：条目自身锚点是否与当前约束
  **声明了的**锚点逐项一致（约束未声明的 null 字段不参与核对）。这是「该条目已按当前
  预约重新核对」的持久表达，随条目落盘，reload 后仍由 audit 依据同样数据判定。
- `auditChecklistLinks` 的 `constraint_changed` 按条目逐条判定：`previous !== current`
  且条目锚点与当前约束不一致才提示。逐条重新核对只解除该条目；同 constraintId 的
  其它条目保留自己的旧锚与提示；普通勾 done / 无关编辑 / 仅再次选择同 ID 都不解除；
  约束再次变化时，已核对到旧值的条目重新进入提示。
- 没有全局 baseline ack：`previousConstraints` 快照只用于检测变化本身，任何 UI 动作
  都不得整体推进它来消除提示。

### 3.5 F6 有效清单接口

```ts
buildEffectiveChecklist(value: unknown): EffectiveChecklistResult
```

- 只接受**当前** `ChecklistV1`；先走 `validateChecklist`，非法整份拒绝，不投影半份。
- 输出只含白名单字段：`id / category / title / done / preparedLabel / date / day /
  stopId / originalStopId / constraintId? / notes / updatedAt`，加 `appliedTemplates`
  与 `summary { total, prepared, pending }`。
- `constraintId` **条件投影**：旧记录缺省保持缺省（不新增属性），显式 `null` 输出
  `null`，非空 string 原样输出；F6 可凭 ID 解析当前 constraints，dangling 只提示
  需重新关联，不宣称预约已确认。
- `preparedLabel` 固定「已准备 / 未准备」；返回值与数组、条目均 `Object.freeze`。
- 不读 storage、不包含其它版本 / 候选 / 会话恢复 raw / 存储键；F6 只应把当前
  有效记录的 `sidecar.checklist` 传进来。

---

## 4. 受控面板（`frontend/src/components/ChecklistPanel.tsx`）

```ts
interface ChecklistPanelProps {
  checklist: ChecklistV1
  trip?: Trip | null
  constraints?: ConstraintsV1 | null
  previousConstraints?: ConstraintsV1 | null
  status?: 'ready' | 'readonly' | 'unavailable' | 'salvage' | 'corrupt'
  now?: number
  onChange: (next: ChecklistV1, context: ChecklistChangeContext) =>
    ChecklistApplyResult | Promise<ChecklistApplyResult>
  onClose?: () => void
  onRebuildRequest?: () => void // 仅 salvage 显示；由父级显式确认，面板不写空清单
}
```

- **完全受控**：面板不持有清单副本，不写 storage；`onChange` 是唯一出口。
- `onChange` 的 `context.action` 为 `add / update / toggle / delete / template /
  relink / unlink / unlink-constraint / undo`，便于父级审计与决定 revision；
  `unlink` 只解除地点关联，`unlink-constraint` 只把预约外键写 `null`，两者不混用。
- 预约下拉框显示并保存真实 `constraintId`；编辑已有条目时，只有用户**改变**预约
  选择才重新 link / unlink。未改变选择时保存不会重抄约束锚点，也不会覆盖用户手工
  修改的日期或备注。已删除约束的 dangling ID 会显示「原预约已不在当前约束中」并
  保留下拉选项，用户可显式改选或解除。
- 父级 adapter 持久化成功返回 `{ok:true}`；失败返回 `{ok:false,message}`，面板显示
  错误并保持旧清单。面板不假定回调一定成功。
- 编辑表单是本地草稿：未点「保存」不调用 `onChange`；取消即丢弃。
- 撤销是 **proposal**：上一步成功后记录 `before` 与结果 canonical；只有当前清单仍
  等于该结果时按钮才可用。父级在别处改了清单 → 提示失效且禁用，点击不写入。
- 模板必须先勾选建议，再点「添加所选（n）」；打开面板 / 切换模板 / 勾选过程都不写。
- 失效提示：stop 被删或约束消失时列出任务与「标记需重新关联」；任务、备注、done
  与 dangling ID 保留。`stop_unlinked` 已标记的条目只显示标签，不重复写入。
- 旧记录没有 `constraintId` 时，只在当前已有约束且条目未记录关联时提示
  「未记录预约关联；可在编辑中手动关联」；不把日期 / 地点相同当作已关联，也不
  把它标成某个已删除预约的任务。
- `status != 'ready'` 时全部编辑禁用；`salvage` 明确提示「清单数据损坏，未加载；
  原始数据保留，未写入」，不把空清单当作新值。父级可传 `onRebuildRequest` 显示
  「重建清单（需确认）」；面板只调用回调，不自造空清单、不直接写 storage。
- 文本全部由 React 文本节点渲染，**没有** `dangerouslySetInnerHTML`；XSS 输入按普通
  文本显示。

### 4.1 接入点（父级 / UI integrator）

面板可单独嵌入任意行程区域（例如「出行准备」折叠区）。父级需要：

1. 从统一工作区 adapter 读取当前有效 `WorkspaceRecordV1`，只把
   `record.sidecar.checklist` 传给面板；**不要**传其它版本 / 恢复 raw / 候选库。
2. `onChange` 内用 `commitWorkspaceTransition` 生成下一版记录（只改
   `sidecar.checklist`，`workspaceRevision = 当前 + 1`），走工作区 adapter 的显式
   保存；失败返回 `{ok:false}`，旧记录与旧字节不变。
3. 传入当前 `trip` 与 `constraints`；若 F2 刚删除 / 变更约束，传入操作前的
   `previousConstraints`，或在删除处理器里调用 `planConstraintRemovalImpact` 做
   精确影响面提示。`previousConstraints` 只服务已知 ID，不用于旧数据绑定。
4. `status` 按 adapter 的读取状态映射：`unavailable / corrupt / anomaly(salvage) /
   unknown_version`；本切片没有 App wiring，**不能算完整交付**。
5. **运行期引用门（强制，见 `docs/WORKSPACE_SIDECAR.md` §5.1.1）**：`onChange`
   的异步保存属于 apply 类操作，父级必须先 `captureWorkspaceRuntime` 保存实际
   `record / trip / sidecar / budget` 对象引用，写入前用
   `workspaceRuntimeRefsMatch` + safe epoch 双门确认，再叠加内容 / identity /
   revision 匹配；每次用户编辑、切换工作区 / 版本、外部 storage 变化都要推进
   epoch。内容相同（A-B-A）也不能复用旧 pending。`constraintId` 是逻辑外键，不是
   JS 对象引用，不能序列化实际 refs 或写进 storage / backup / session。
   失败 / 旧 epoch 的 apply 不得覆盖新清单；面板仍显示当前已提交值，不回显未
   apply 的草稿。

---

## 5. 验收与本次实跑

本切片实跑（不跑 full suite / build / E2E / backend）：

```bash
cd frontend
npx vitest run src/__tests__/checklist.test.ts src/__tests__/ChecklistPanel.test.tsx --no-cache
```

结果：**2 个测试文件、51 项通过**（checklist 31 + panel 20）。类型检查使用
scoped `tsconfig`（本 feature 四个源 / 测试文件 + `src/test/setup.ts`）实跑 **exit 0**；
项目级 `tsc -p tsconfig.app.json` 仍受其它并行 owner WIP 影响，本切片不据此扩大门禁。

覆盖：

- 增 / 改 / 勾选 / 删除的不可变性与空 / null / 0 语义；
- 模板只建议、显式选择、全部未准备、appliedTemplates 去重与 50 上限；
- stop 解绑 / stop 删除保留任务与 done、追加「需重新关联」，不误删 task；
- 300 项 / 512 KiB 字节上限、无效输入失败保旧；
- **同一 stop 双约束 A（无 date）/ B（有 date）**：删除 A 不误报关联 B 的任务；
- **同名但不同 ID** 的约束不会被自动绑定；`planConstraintRemovalImpact` 只按真实 ID；
- 约束删除后任务、done、dangling `constraintId` 与日期 / 天 / stop 保留，标记只追加
  「需重新确认关联」，不删 task、不按锚点重绑；
- 显式 `null`（已解除）与旧记录缺省 `undefined`（未记录）三态保真；普通编辑 / 勾选 /
  模板 / 有效清单都不自动补 `null`，也不丢已知字段；
- 手工修改日期 / 备注后，未变更预约选择时不会重抄约束锚点或覆盖手工值；
- 关联 / 解除预约与解除地点严格区分，解除地点生成的备注不会被随后保存覆盖；
- 表单中预约在保存前消失时拒绝静默新增，保留原清单；constraints 未加载不误报失效；
- XSS 标题与备注按文本显示；面板文案不含「已预订 / 已出票 / 已确认 / 确认库存」；
- 草稿不写、adapter 失败保旧、只读 / salvage 状态禁用；
- 撤销 proposal 在外部清单变化后失效且不写入；
- F6 有效清单只输出白名单字段、条件投影 `constraintId`、preparedLabel 与 summary，
  并冻结。

---

## 6. 已知限制 / 后续动作

1. **没有 App wiring**：面板只在测试中渲染；需要 UI integrator 串行接入
   `App.tsx`（本切片不碰热文件）。
2. **约束外键的运行时前提**：`constraintId` 已由 W1 释放并由 F5 精确消费；删除
   约束的 dangling 提示需要父级传当前 `constraints`，同 ID 变更检测还需要操作前
   的 `previousConstraints`。不传时不会猜测关联，也不会把旧数据标成已关联。
3. **备份 / 导入 / 会话恢复覆盖清单**：由 `workspaceStorage.ts` 与恢复模块统一实现；
   F5 只保证清单段可被这些流程整体替换，不另造 key / 备份格式。
4. **salvage 重建**：面板只读；重建 / 删除原记录必须走工作区 adapter 的显式修复
   流程，避免把空清单覆盖原字节。
5. 模板不包含用户自定义模板；新增模板只需追加 `CHECKLIST_TEMPLATES` 的纯数据项。

---

## 7. 智能建议（二期 C-1，纯本地规则）

> 入口：清单工具栏「建议携带物」；模块
> `frontend/src/lib/checklistSuggestions.ts`。

- **输入**：当前行程目的地、天数、出发月份（优先取行程第一天日期；没有日期时
  回退到面板的显式 `now` / 本地时间）、现有清单标题（只读，仅用于重复提示）。
- **规则顺序**：通用必备（证件复印件 / 充电 / 常用药 / 住宿信息）→ 目的地关键词
  （海滨 / 山地 / 冰雪 / 温泉 / 乐园 / 展馆 / 古城）→ 雨季 / 水边雨具 → 季节
  （春 / 夏 / 秋 / 冬）→ 天数（≥4 天换洗、≥6 天洗衣）。总共最多 10 条；**通用
  必备固定排在最前并优先保留名额**，场景项再多也不会把它们挤出截断。同输入恒同
  输出；零网络、零存储。
- **每条建议**包含标题、分类、一句话理由；理由只作参考，不查询票务 / 库存 / 预约状态。
- **采纳**：显式点击「采纳」才调用 `addChecklistItem` 新增条目，`done:false`，
  **绝不自动勾选**；备注写入「建议理由：…」。丢弃只隐藏建议，零写入。
- **重复提示**：与现有清单标题相同（NFKC + 空白折叠 + 小写）时标记「清单里已有」，
  采纳按钮禁用；不自动合并、不自动跳过。
- 文案继续沿用「已准备 / 未准备」；打勾仍只代表用户自己核对过。
- 测试：`frontend/src/__tests__/checklistSuggestions.test.ts`。

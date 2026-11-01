# AI 后段重规划（「某站之后」）：前端首批实现说明

基线 ebb58838d5edecf5a739f9b136e215c53aa21bf3。本批在现有「AI 调整这一天」面板上增加显式的应用范围选择：默认「整天」（行为与之前完全一致），或「某站之后」——保留锚点站及之前的全部站点与站间路线，把 AI 返回的整个 Day 候选当作新的后段拼回去。**后端零改动**：请求仍是现有 `POST /api/trips/days/replan` 协议，服务端不知道「后段范围」，冻结与拼接全部在客户端完成。

## 文件

- 新 `frontend/src/lib/dayReplanTail.ts`：后段纯函数（请求构造 / scope / 预览组合 / 应用）。
- 新 `frontend/src/__tests__/dayReplanTail.test.ts`（30 项）、`DayReplanTailPanel.test.tsx`（14 项）、`AppDayReplanTailIntegration.test.tsx`（6 项）。
- 改 `frontend/src/components/DayReplanPanel.tsx`、`dayReplanPanel.css`、`frontend/src/App.tsx`（仅 onApply 第三参与提示文案分支）。
- 不改：后端全部、`dayReplan.ts`、`dayReplanApi.ts`、`api.ts`、旧测试、fixtures、Trip/PlanRequest 协议、依赖与 lock。

## 请求与指令

- 用户指令原文**不截断**；固定范围说明与用户原文合并成一条现有 `instruction` 字段，合计超 500 字时构造明确失败并显示固定占用与可用长度，不静默截字。固定说明包含：锚点站名、冻结站数、最多新站数（8 − 冻结数），已知时间下界时附「新后段开始时刻不应早于 HH:MM」。
- 请求本身仍由旧 `buildDayReplanRequest` 构造：只投影目标日站点文字字段，不带坐标 / 几何 / scope 快照 / 任何新字段。

## Scope（只在前端会话）

`DayReplanTailScope` 记录 trip id、revision、**完整内容快照**（`JSON.stringify`）、day/date、锚点 id 与序号、保留站数、请求及其快照、用户原文指令、交通方式与人数。无法序列化时 fail closed。`verifyTailScope` 在预览与应用前核对：结构非法（`invalid_scope`）、revision / trip id / 内容快照（**同对象变更也逃不掉**）/ 请求指纹（含 `request.parent.trip_id` 与记录的 trip id 一致）/ 目标日 / 锚点位置任一不符（`stale_scope` 或 `invalid_scope`），一律整体拒绝，绝不落回整天替换。A→B→A 不复活：面板用单调 `inputEpoch` 序号比较（生成时捕获，任何输入变化 +1），不做内容等值判断；迟到结果（成功或失败）除 seq/abort 外还要与渲染时同步更新的最新上下文快照（trip 对象 / revision / day / 输入序号）逐一比对，即使变化尚未触发 effect 也不落进新上下文。

## 候选校验与组合

模型返回的整个 Day 候选就是「新后段」：不按锚点索引盲切模型数组、不信模型自己保留前段、不按名字/坐标去重。校验链：旧 `validateDayReplanResponse`（信封 / 相邻链 / 坐标 / route_type 一致性）→ 至少 1 个新站 → 组合 ≤ 8 站（超限拒绝，不丢站凑数）→ id 不与冻结段 / 其它天冲突 → 保守时间核对 → **冻结前缀旧链核对**：前 keptCount−1 段路段必须存在且端点与保留站点顺序逐段一致，缺失或错链按 `invalid_base_day` 明确拒绝，不把坏链持久化，也不去修 / 重排旧链；route_type / geometry 形态（如 straight_line + 空几何）属保存格式允许范围，不在链校验之内。

- **冻结前缀**：站点与内部 legs 直接取原日的原对象引用；其它天原引用。旧跨边界 leg（锚点→原后段）**永不复用**。
- **唯一新建衔接 leg**：anchor → 新后段第一站，mode 为本次所选方式，`route_type='unavailable'`、distance/duration `null`、geometry `[]`、固定说明「衔接路线未重算，需另行核对」。不造直线、不按未知补 0。
- **时间下界**：只用合法 HH:MM + 已知合法整数停留（0–1440）推算冻结段可知结束下界；未知保持未知并在预览明示「无法推算衔接时刻下界」。新后段时刻明确早于下界 → 拒绝（不改时刻）；下界 ≥ 1440（跨日）→ 本批不能同日接续，拒绝。
- **组合 map_status**：对组合日重新 `classifyDayMapStatus`，不拿旧前段地图冒充本次获取；组合日全部站点无坐标时仍是 `unavailable`，不冒 `partial`。预览同时独立展示原始后段地图状态（AI 返回时的 no_key/timeout/failed 等原因）与原始候选 warnings，不只显示组合后的 notices。

## 预览与应用

- 只有显式点「生成」才发一次 adapter 调用（无自动请求 / 重试）；生成只进预览，不改行程。后段预览用 `TailPreview` 区分「冻结保留（前 N 站，原记录）」与「组合方案（冻结段 + AI 新后段）」，展示衔接未知与时间下界说明；组合日与最终应用走同一套 `composeTailPreviewDay` / `applyDayReplanTail` 检查与拼装。预览用**界面当前 revision**（而非 scope 自带 revision）核对范围仍有效，作废后旧预览整个不渲染（不只禁用按钮）。
- 显式「应用后段候选」才改当前副本。`DayReplanPanel.onApply` 追加可选第三参：整天调用不传（`undefined`），后段调用传生成时的 scope。`App.handleAiApply` 仅按第三参**严格 `=== undefined`** 选择旧 `applyDayReplan` 或新 `applyDayReplanTail`；任何有参（含非法 falsy 值）都走后段校验路径并类型化失败，**绝不降级成整天替换**；应用通告分支用同一判定。应用时把面板透传的生成时 `request` 一并交给 `applyDayReplanTail` 与 scope 记录核对指纹，不一致按 `request_mismatch` 拒绝。
- 应用实现：复用旧 `applyDayReplan` 做信封复验、跨天 id 冲突与 40 条提醒组合（旧的整体头 /「调整前提醒」头 / 省略行按完整模板摘除；本模块写的旧后段头在二次应用前按完整模板摘掉，用户提醒即使以相同字眼开头也原文保留），再把冻结前缀原引用恢复进组合日，改写本次生成的分段头（「【AI后段调整】第 N 天前 M 站原样保留，之后已按 AI 候选替换…」）与 Trip/Day 摘要（准确说明前 N 站原样、仅之后替换、其它天保留、衔接未重算、未自动保存未核实），后验 `checkTripShape` 与 640 KB 容量；失败保旧、不裁几何。
- App 侧仍用 `latestTripRef` / `tripRevisionRef` / `newUuid` 与原成功采纳路径；共用一层「撤销应用」，revision 单调递增，`interactionPaused` 语义不变，不自动写 Storage、不下载、不触发地图重算或新的模型调用。

## 离线验证（作者自测 + 独立验收复跑）

- 新增 3 文件 50 项：`dayReplanTail.test.ts` 30、`DayReplanTailPanel.test.tsx` 14、`AppDayReplanTailIntegration.test.tsx` 6，全部通过（vitest，jsdom + fetch/adapter mock，无真实网络 / Storage 写 / 模型调用）。
- 完整前端套件 `pnpm test`：54 文件 1131 项全部通过（逐文件计数以验收复跑输出为准）。
- `pnpm typecheck`（source-path guard + `tsc -b --force`）与 `pnpm build`（vite 生产构建）均 exit 0。
- 真实模型 / 高德 / 浏览器联调未做；后端未改动，服务端行为与此前基线一致。

## 边界重申

- 不声称服务端新增任何范围锁定；范围只由客户端校验。
- 不做真实出行可行性、预约或营业状态验证；时间核对只按已填写值的保守下界。
- 后段候选的 AI 摘要只在预览展示，持久化的 Day/Trip 摘要被准确的范围摘要取代，不把后段摘要当成整天推荐。

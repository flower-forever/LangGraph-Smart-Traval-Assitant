# 草稿步行距离检查（每天步行距离上限）

日期：2026-11-01。对应分支 `feat/interactive-travel-planner`，前置基线 `418f0c6`。

## 这是什么

本地编辑器的第三个偏好检查（前两个是「每天最多站点数」「每天最晚结束时间」）：用户设置一个每天步行距离上限（整数米），检查按天汇总行程里已记录的导航步行距离，并与上限做保守比较。它只是编辑会话内的 UI 提示状态。

## 诚实边界（先读这个）

- **只统计已记录的导航估算**：纳入合计的只有 `mode=walking` 且 `route_type=navigation`、`distance_m` 为有限非负数的路段。walking 的直线示意 / 待重取、导航距离缺失（null）、负数、NaN / Infinity 都归为「未知或示意」，不进合计，也不按 0 补齐。driving 不算步行，也不从驾车里程里猜末端步行；未知 mode 与 leg 结构不完整的段单独计为「无法识别」，不猜 walking、不冒充步行未知数，但会让当天保持覆盖不足（不出现「全已知未超」结论）。
- **不代表实际全天步行量**：景点内、站内、路线未记录的步行都不在统计里；数据是此前记录的估算，本批未重新核实任何路线。全驾车的一天不等于实际步行 0 米。
- **0 合法、空不是 0、小数合法**：距离记录显式 0 有效（有 0 距离合法记录时可显示已记录 0）；上限输入留空明示「留空不等于 0」，负数 / 小数 / 非数 / 超 100000 都是 typed 失败，不静默裁值；非字符串的运行时输入（数字、布尔、null 等）也按 typed 失败处理，不抛未捕获异常。路线记录里的小数距离是合法数据，按原 finite 值求和，不在数据层取整——「必须整数」的限制只约束上限本身，不套到距离上。上限本身运行时非法（负数 / NaN）时单天汇总同样 typed 拒绝，不产生任何比较结论。
- **求和不能安全表示时 fail closed**：单段距离是有限数但相加超出 `Number.MAX_SAFE_INTEGER` 时，返回结构化 `unsafe_sum`（合计 null、不给出比较结论），绝不返回 0、不裁值、不冒「未超限」。
- **比较结论是保守的**：已知部分超过上限时说「已记录导航步行距离超过所设上限」并提醒未知段可能更多；未超过时只说「已记录部分未超」，有未知段必须说明不能确认全量。不出现「全天未超限」「可以轻松走完」这类肯定结论，不谈体力适合或健康建议。
- **显示约数不参与比较**：小数或大数合计的展示用「约 N 米」标注估算；超过 / 未超的比较始终基于原始合计，不依赖显示舍入。
- **只有点「检查」才产生结果**：修改开启状态、上限输入或范围都会立即清除旧结果与旧报错，必须重新点「检查」；禁用状态不冒充已检查结论。
- **只在本编辑器会话**：设置与结果不写入 Trip、不进 `Trip.warnings`、不存 localStorage、不发给后端、不触发任何路线重算或网络请求。换草稿后整体回默认（默认关闭、输入 3000、范围 all_days），A-B-A 切换不复活旧 run；owner 每轮渲染基于 `forkTripId + base 完整内容快照`（`JSON.stringify(base)`，不按引用 memo）并结合 base 引用身份推进单调 epoch——同浅元数据但站点 / 路线内容不同的新 base、内容相同的新克隆 base、同引用 base 被原地改任何内容（含 geometry），都会进入新会话并重置偏好；序列化失败 fail closed（结果不渲染、检查不可用）；切换后旧 run / 旧结论在重置生效前也不会闪现。
- **不阻断原编辑**：仅此检查的输入非法不影响单站编辑、应用、撤销、放弃等原有路径；`applyDraft` 一层 undo 与原 Trip 行为不变。

## 每日输出

每天给：已记录导航步行合计（无可纳入段时为 null +「暂无可统计导航步行距离」）、纳入段数、未知 / 示意步行段数、驾车段数，以及对所设上限的保守比较。`changed_days` 范围复用 `draftChangedDays` 口径，没有已改天时明确说「没有已改动过的天可检查」，不冒「未超限」。

## 同草稿实时重算

冻结设置对应的结果每次渲染都基于当前 draft 的 legs 重新汇总，不按对象引用做 useMemo 缓存：同草稿切天、编辑、撤销会重读，同一个 draft 对象被原地改 `legs` 的 `distance_m` / `route_type` 后，重渲染也会读出新值。改名称 / 地址使相关路段失效（`route_type` 回 `unavailable`、距离 `null`）后，合计立即变为「暂无可统计」——绝不拿旧距离继续合计。

注意（2026-11-03 归属修复后）：创建草稿（`createTripDraft`）起 `draft.days` 与 `base.days` 就是值相等、对象独立的可编辑结构副本（geometry 数组与坐标点仍按只读叶节点合同共享）。「同 draft 对象原地改 legs」改的是草稿自己的工作结构，设置保留、按新值重算；「同引用 base 原地改内容」改的是 base，owner 完整内容快照立刻变化，旧 run 渲染期即失效、偏好回默认。两者不再被别名混成同一件事。直接改 geometry 是不受支持的只读叶节点写操作，但 base geometry 变化同样会被完整快照发现并触发会话重置。

## 实现与文件

纯函数模块 `draftWalkingDistance.ts` 不改 `tripDraft.ts` 的 `DraftLocalCheck` / warnings 协议，独立区块渲染；`TripDraftEditor.tsx` 只加一组与 endtime 同模式的偏好状态（enabled / text / scope / frozen run / error），另加步行检查自己的 owner 绑定（forkTripId + base 完整内容快照 + 单调 epoch，含 base 引用身份）：run 与产生它的 owner 时代绑定，owner 变化后旧 run 一律过期。样式沿用既有 `.tde-` tokens，只新增 `.tde-walking-detail` 一个明细行类。

2026-11-03 归属修复：`createTripDraft` 创建时克隆可编辑 day / stops / legs / location（值相等、对象独立；geometry 按只读叶节点合同共享），`draft.base` 仍是原 Trip、discard 与无变化 apply 仍返回原对象；编辑器 owner 改为每轮渲染对 base 完整内容快照（不再按引用 useMemo），epoch 由 forkTripId + base 引用身份共同推进，重置 effect 依赖同样含 base 引用。回归见 `frontend/src/__tests__/tripDraftOwnerIsolationRegression.test.tsx`。

| 文件 | 内容 |
| --- | --- |
| `frontend/src/lib/draftWalkingDistance.ts` | 纯函数：上限解析、米数展示、单天汇总、逐日检查、固定口径文案 |
| `frontend/src/components/TripDraftEditor.tsx` | 偏好区新增「每天步行距离上限（偏好检查）」区块 |
| `frontend/src/components/tripDraftEditor.css` | 新增 `.tde-walking-detail` |
| `frontend/src/__tests__/draftWalkingDistance.test.ts` | 纯逻辑 24 项 |
| `frontend/src/__tests__/TripDraftWalkingDistanceEditor.test.tsx` | Editor 路径 14 项 |
| `frontend/src/__tests__/AppDraftWalkingDistanceIntegration.test.tsx` | App 接线 4 项 |

不改：`App.tsx`、`tripDraft.ts`、`draftEndTime.ts`、`api.ts`、旧测试与 fixtures、后端、依赖锁、Trip / PlanRequest 协议、类型门禁。

## 离线验证（验收后实数）

- 新增 3 文件 42 项全部通过（纯逻辑 24、Editor 14、App 4；jsdom + fetch mock，无真实网络 / Storage 写 / 定位 / 浏览器）。其中含独立验收补的复现回归：同 draft 对象原地改 legs 后重渲染读新值、同 forkTripId 换 base 草稿重置且 A-B-A 不复活、未知 mode 段不冒充分数据、上限 / 输入运行时非法 typed 拒绝。
- 完整前端套件 `pnpm vitest run`：57 文件 1180 项全部通过（逐文件实数）。
- `pnpm typecheck`（source-path guard 扫 102 个 .ts/.tsx 无 casefold 冲突 + `tsc -b --force`）与 `pnpm build`（vite 生产构建）均 exit 0。
- 真实浏览器验收未做；CI 结果以推送后的实际运行为准。

## 未做与局限

- 不从坐标算距离、不取真实路线、不调用任何地图或模型服务；路段失效后不自动补距离。
- 不推年龄体力、不核营业与预约；不做持久化，刷新丢失是设计行为。
- 检查结果与上限不进 Trip、不进保存 / 导出（ICS / Markdown / 备份）内容。

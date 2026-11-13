# P7-S8 报告（E2E 补测 + S6-30 + S8-36）

日期：2026-11-13
工作目录：`F:\MunderDifflin\Travel-Assistant\LangGraph-Smart-Traval-Assitant`
基线：`HEAD 9898b3f`（feat(p7): 多城契约与请求入口 + workspace 面板懒加载 (S1/S2)）
交付方式：不 commit / 不 push，由 PM 统一集成。

## 一、改动文件（仅本任务允许范围）

| 文件 | 类型 | 说明 |
|---|---|---|
| `frontend/e2e/p7Scenarios.mjs` | 新建 | 3 个离线 E2E 场景实现 |
| `frontend/e2e/runner.mjs` | 修改 | 只追加 import、3 个 wrapper、`setP7AppOrigin` 与 3 次执行/`report.scenarios` 写入；既有 32 个场景与断言未动 |
| `frontend/src/lib/cityProfile.ts` | 修改 | `classicsOf` 改为「全量遍历 → 过滤空名 → 按 name 去重 → 截断 15」 |
| `frontend/src/__tests__/cityProfile.test.ts` | 新建 | S6-30 回归单测 |
| `P7-S8-REPORT.md` | 新建 | 本报告 |

未改 `App.tsx`、组件、后端、契约与任何既有断言。

> 说明：主仓工作区同时存在另一并行切片的在途改动（`App.tsx`、`TodayPanel.tsx`、`CitySegments.tsx`、`cityScope.ts` 等，非本任务文件）。本报告只对本表 5 个文件负责。

## 二、任务 1：3 个离线 E2E 场景

场景函数全部在 `frontend/e2e/p7Scenarios.mjs`，由 runner 按既有模式注册为 `report.scenarios.p7Stamp / p7SwapFlyTo / p7Cinema`。全部走真实 UI，未注入页面业务状态；`/api` 由契约桩承接，瓦片由 route 门禁 fulfill。

### A. 落印（p7Stamp）

选择器与断言：
- 规划成功：`button:has-text("生成行程")` → `[data-testid="stamp-seal"]` 出现且 `isVisible()`。
- 普通模式：`data-reduced="false"`，`getComputedStyle(...).animationName` 含 `oc-stamp-jolt`（盖章微震真实存在）。
- 自动退场：`waitForSelector(stamp, { state: 'detached' })` 6s 内卸载；随后真实点击「编辑这趟行程」进入草稿，证明印章 `pointer-events:none` 且退场后页面可交互。
- reduced-motion：`page.emulateMedia({ reducedMotion: 'reduce' })` + reload 后重新规划；`data-reduced="true"`，`animationName` 不含 `oc-stamp-jolt`，`animationDuration="1e-05s"`，仍在 6s 内自动卸载。
- 截图：`frontend/e2e/artifacts/70-p7-stamp-seal.png`。

实测证据：普通模式动画名 `oc-stamp-in, oc-stamp-jolt, oc-stamp-out`；reduced 模式 `oc-stamp-in, oc-stamp-out`。

### B. 换一换 + 地图 fly-to（p7SwapFlyTo）

流程与选择器：
1. `button:has-text("候选地点池")` → `[data-testid="candidate-pool-panel"]`；在 `form[aria-label="手工新增候选表单"]` 真实填写「E2E 换一候选地点」+ 经纬度，点「添加到候选库」。
2. 收起候选池 → `button:has-text("编辑这趟行程")` → `[data-testid^="stop-swap-open-"]` 打开 `[data-testid="stop-swap-panel"]`。
3. 第一个 `[data-testid="stop-swap-candidate"]` → 「预览替换」→ `[data-testid="stop-swap-preview"]` → 「确认替换」。
4. 目标行 `li:has([data-testid="stop-swap-open-s-e2e-1"])`：`data-swap-anim="forward"` 出现，随后被摘除（轮询 DOM 属性，不睡眠猜时长）。
5. 「撤销这次更换」：同一行 `data-swap-anim="backward"` 出现并摘除。
6. reduced-motion 再替换：`page.emulateMedia({ reducedMotion: 'reduce' })`；`data-swap-anim` 仍会短暂挂上，但 `getComputedStyle(...).animationDuration` 实测 `1e-05s`（≤1ms），随后摘除。
7. `Escape` 关闭 `[data-testid="stop-swap-panel"]`。
8. 地图侧：按 marker 到地图中心的距离选最远的一个未替换站点，点击草稿行内 `button[aria-label^="在地图中查看"]`；断言：
   - `[aria-label="交互式地图"] .leaflet-popup` 打开；
   - `.leaflet-marker-icon[aria-pressed="true"]` 恰好 1 个且是点击的站点；
   - marker 与瓦片的 `style.transform` 在点击前后真实变化（实测 marker `translate3d(623px,-8px,0px)` → `translate3d(720px,0px,0px)`，瓦片 y 从 `-212px` → `-39px`）。
- 截图：`frontend/e2e/artifacts/71-p7-swap-map-flyto.png`。

地图可观测性说明：
- Leaflet `flyTo` 在「缩放级别不变」时不会改 `.leaflet-map-pane` 的 transform，而是重排 marker / 瓦片；因此没有把 pane transform 当作唯一证据，改用 marker + 瓦片位置变化 + popup + 选中态。未读取 React/Leaflet 内部状态，未硬造。
- 精确的 flyTo 调用参数（`MAP_FLY_DURATION_S` / `setView` reduced 分支）仍由既有 vitest `SwapFlipAndFlyTo.test.tsx` 覆盖，本 E2E 只补浏览器端真实视图变化。

Reduced-motion nuance（如实报告）：
- `data-swap-anim` 是组件层的纯装饰标注，当前实现不按 reducedMotion 条件挂载，因此 reduced 下系统仍会短暂挂上该属性；CSS 降级分支把动画时长压到 `1e-05s`，随后组件计时器摘除。E2E 断言的是「动画瞬时 + 标注摘除」，不是「属性完全不出现」。未改组件（任务禁止），未放宽既有断言。

### C. 电影模式 + 台词彩蛋（p7Cinema）

选择器与断言：
- `[data-testid="route-replay-entry"]` 打开 `[data-testid="route-replay-panel"]`。
- `[data-testid="replay-cinema-toggle"]` 进入电影模式：`data-cinema="true"`、`data-cinema-phase="title"`、`[data-testid="cinema-title-card"]` 可见；片头文本含目的地「杭州」（实测 `杭州（契约桩）2026-11-07 ～ 2026-11-09…`）。
- 点击片头跳过 → `data-cinema-phase="playing"`；在末站前用 `replay-next` 走到最后一站（末站按钮 disabled），再用 `replay-speed-2` + `replay-play-toggle` 让最后一站自然停留走完 → `data-phase="finished"`。
- `[data-testid="cinema-credits"]` 出现：`textContent` 长度 97，含既有免责口径「路线与时间仅为参考」；`.oc-cinema-credits-quote` 非空（实测「走得慢一点，让风景追上你。」）；`data-settled` 在 8s 内变 `true`（定格尾帧）。
- `Escape` 退出电影模式（`data-cinema="false"`、credits detached），再 `Escape` 关闭回放面板。
- 截图：`frontend/e2e/artifacts/72-p7-cinema-credits.png`。

### E2E 总数字

主仓实际执行 `pnpm verify:e2e`（2026-11-13 15:01）：

```
scenarios = 35
failures = 0
route: fulfill瓦片=330 截获公网=0 截获其它loopback=0 本机放行=6109
       handler异常=0 实际出站(actualOutbound)=0
console: 预期=1 未预期=0
```

`frontend/e2e/artifacts/report.json` 复核：`Object.keys(report.scenarios).length = 35`，`failures.length = 0`，`route_summary.actualOutbound = 0`，三个 P7 场景 `ok=true`。

隔离验证：由于首次主仓运行时另一并行切片正在写 `App.tsx`（Vite HMR 在既有 `resumeFileSource` 中途触发，导致该既有场景失败、编排中止），另用 `git archive HEAD` 建了一个只叠加本任务 4 个代码文件的临时快照（`Temp\opencode\p7-s8-e2e`，node_modules junction），同一套 35 场景也得到 **35 / 0 failure / actualOutbound=0**。主仓在并发改动稳定后复跑同样全绿。

## 三、任务 2：S6-30（classicsOf 截断顺序）

改动前：
```ts
for (const entry of value.slice(0, MAX_CLASSICS)) { ...过滤空名/去重... }
```
前 15 条里的空名 / 重复会占用配额，过滤后结果可能少于 15 条。

改动后：
```ts
for (const entry of value) { ...过滤空名/去重... }
return classics.slice(0, MAX_CLASSICS)
```
先遍历全部候选 → 过滤空名 → 按 `name` 去重 → 再截断 15；输出顺序仍是输入顺序，最多 15 条。`projectCityProfile` 其它字段行为未变。

新增单测 `frontend/src/__tests__/cityProfile.test.ts`：
- 构造 20 条有效候选，前部插入 3 条空名（`'   '`、`''`、`' \t '`）与 2 条重复（`经典景点00` / `经典景点01` 再出现一次）。
- 断言输出 15 条、全部非空、无重复、名称序列等于输入顺序的前 15 个有效名、首条 reason 保留。

实际执行：

```
pnpm vitest run src/__tests__/cityProfile.test.ts
Test Files  1 passed (1)
Tests       1 passed (1)
```

## 四、任务 3：S8-36（只调查）

全仓检索 `preferredWindow`、`preferred_window`、`轻窗口`、`时间窗`：
- `preferredWindow` / `preferred_window` / `轻窗口`：0 命中。
- `时间窗`：仅出现在约束 / 分享卡 / 今日卡的既有文案与测试里（如预约时间窗、分享卡「带时间窗」），不是 M2 轻窗口固定字段，也没有可透传的契约字段。

结论：**S8-36 不适用：当前代码无 preferredWindow 字段，未改动。**

## 五、验证记录汇总

| 命令 | 结果 |
|---|---|
| `pnpm typecheck`（frontend） | 通过；`check-source-paths` 扫描 333 个 `.ts/.tsx` 无大小写折叠冲突，`tsc -b --force` 无错误 |
| `pnpm vitest run src/__tests__/cityProfile.test.ts` | 1 文件 / 1 用例通过 |
| `pnpm verify:e2e`（主仓） | 35 场景 / 0 failure / 0 实际出站 |
| 同一套 E2E（HEAD 隔离快照 + 本任务 4 文件） | 35 场景 / 0 failure / 0 实际出站 |

## 六、未稳定覆盖 / 注意事项

1. **地图精确 flyTo 参数**：E2E 只断言 DOM 可观察的 marker/瓦片重排 + popup + 选中态；`flyTo` 调用、`duration=0.75s`、reduced 下 `setView` 直跳仍由既有 `SwapFlipAndFlyTo.test.tsx` 覆盖。
2. **reduced-motion 下 `data-swap-anim` 属性仍短暂存在**：CSS 动画时长已降为 `1e-05s`，但组件标注不是条件挂载；E2E 按实际行为断言「瞬时 + 随后摘除」。若后续要「属性完全不出现」，需要改 `TripDraftEditor`，不在本任务允许范围。
3. **主仓并发切片**：本报告的主仓 E2E 数字包含另一并行切片的稳定改动；隔离快照证明本任务 4 个代码文件在 HEAD 上同样 35/0/0。两次数值均为 `actualOutbound=0`。
4. 未 commit / 未 push；未执行 force / reset / stash / clean / worktree。

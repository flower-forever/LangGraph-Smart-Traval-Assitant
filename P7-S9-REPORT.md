# P7-S9 收官报告（真实多城 E2E + DoD 复核）

日期：2026-11-14
项目目录：`F:\MunderDifflin\Travel-Assistant\LangGraph-Smart-Traval-Assitant`
基线：`fb813c7`（波 2：S3-S7/S7b）
本次改动：`frontend/e2e/p7MulticityScenarios.mjs`（新建）、`frontend/e2e/runner.mjs`（注册 2 个场景、补 Tailwind 插件）

## 一、S9 新增内容

### 1. 两城全链路 E2E（p7MulticityTwoCity）

走真实 App 表单与 `POST /api/trips/plan` 请求，页面级 route 用契约 fixture 返回杭州 2 天 + 苏州 1 天：

- 提交体 `cities = [{name:'杭州',days:2},{name:'苏州',days:1}]`，标题为「杭州 · 苏州 行程」。
- 城市分段 2 个按钮，初始杭州激活；今日徽标为杭州；城市导览为杭州；分城覆盖「杭州 · 已覆盖 2/2」「苏州 · 已覆盖 1/2」。
- 地图默认投影杭州两天的 4 个站点；切到苏州后只投影苏州当天 2 个站点。
- 分享卡 SVG 含城市序列「行旅 · 杭州 · 苏州」；离线路书 iframe 的 `srcdoc` 含杭州、苏州。
- 浅色与深色主题各截图一张；另有城际卡与苏州切换截图。
- 第 2 天城际卡为 `estimated`：标题「城际转移 · 杭州 → 苏州」，含「直线约 130.0 公里」「建议预留约 1 小时 12 分钟」，固定提示「具体班次与时刻未提供，请自行查询。」；卡片文本不含车次/时刻表。
- 切苏州后城际卡消失，证明归属与渲染都按当前城际段。

截图：`frontend/e2e/artifacts/90-p7-multicity-two-city-light.png`、`91-...-dark.png`、`92-...-intercity.png`、`93-...-suzhou.png`。

### 2. 三城冒烟 E2E（p7MulticityThreeCity）

杭州 2 天 + 苏州 1 天 + 南京 1 天，提交体与实际 `cities[]` 一致；逐城点击苏州、南京，核对 `aria-pressed`、今日徽标、城市导览、地图站点，无崩溃。

- 苏州→南京城际卡为 `unknown`：显示「距离与耗时未知」，无估算行，固定提示仍在；与两城的 `estimated`、末日的「无卡」共同覆盖城际三态。
- 三城城市导览均显示 `AI 生成·供参考` 徽标，fixture 画像 `source='model_generated'`。

截图：`94-p7-multicity-three-city-hangzhou.png`、`95-...-suzhou.png`、`96-...-nanjing.png`。

### 3. E2E 基础设施修正

`runner.mjs` 的内联 Vite 配置原先只挂 `react()`，没有 `tailwindcss()`，导致既有 E2E 截图实际是无样式页面（DOM 断言仍有效）。本次补上 `@tailwindcss/vite` 插件，截图才反映真实样式。该修正只影响 E2E 宿主，不改生产构建配置。

## 二、DoD 复核

> 2026-11-14 P7 收官更新：本表为 S9 当日（11-13）基线数字；S8-36 与 S2 lazy 修复已在收官补做，
> 见下文「S8-36 与 S2 lazy 修复」一节与更新后的验证数字。

| # | 要求 | 结果 |
|---|---|---|
| 1 | fullsuite 全绿 | vitest 186 文件 / 3089 例（11-14 复跑）；pytest 2100 passed / 3 skipped（11-14 复跑）；E2E 41 场景 / 0 failure（37 + 新增 4 个 lazy 场景） |
| 2 | 两城端到端真实演示 + 地图取证 + 三城冒烟 | 两城与三城均走真实 App；地图站点点数、城市切换、城际卡均有断言；7 张截图 |
| 3 | 既有回归 | 41 个 E2E 场景全量执行（既有 37 个断言未动）；既有 fixture 未改；typecheck 0 error |
| 4 | 主包 ≤1450 kB | 1337.29 kB（11-14 复测；S2 lazy 修复后 Constraints/Checklist/CandidatePool 拆为独立 chunk，主包几乎不变） |
| 5 | 城际三态 + model_generated 取证 | estimated / unknown / 无卡三态齐备；导览徽标与 fixture source 取证 |
| 6 | S8-36 / S6-30 / S8-39 / 3 个 E2E | ~~S8-36 全仓无 preferredWindow，确认不适用~~（**11-14 更正：已实现**，见下节）；S6-30 已有单测；S8-39 为用户授权的识别扩展；P7 E2E 3 个均在 |
| 7 | 未完项归档 + 双 CI 一致 | 未完项已归档至 `P7-P8-ARCHIVE.md`（六部分：已消解项 / P6 剩余 27 条 / P6.5 留观 8 条+X2-M1 触发条件 / 八期四缺口 / 新增观察项 / 永不修 7 条）；feat 与 main 推送后同一提交、全量 CI |

## 三、验证命令与结果

在仓库根目录执行（2026-11-14 收官复跑）：

```text
pnpm --dir frontend typecheck        # 345 个 .ts/.tsx，0 error
pnpm --dir frontend test             # 186 files / 3089 tests passed（137.28s）
.venv\Scripts\python.exe -m pytest -q  # 2100 passed / 3 skipped
pnpm --dir frontend build            # 主包 1337.29 kB（门禁 1450）
pnpm --dir frontend run verify:e2e   # 41 scenarios / 0 failures（37 + 4 lazy）
```

E2E 路由取证：`fulfilledTiles=865`、`abortedExternal=0`、`continuedLocal=6972`、`handlerErrors=0`、`actualOutbound=0`；console 未预期 0。报告文件 `frontend/e2e/artifacts/report.json`，`scenarios.p7MulticityTwoCity.ok=true`、`scenarios.p7MulticityThreeCity.ok=true`、4 个 lazy 场景 `ok=true`。

## 三A、S8-36 与 S2 lazy 修复（2026-11-14 收官补做）

**S8-36 补餐优先体检提示窗口**：`itineraryHealth.checkMealGaps` 现在为出问题的补餐缺口记录 `preferredWindow`（午餐优先），`MealSuggestPanel` 接收该 prop；`findMealInsertion(day, preferredWindow?)` 优先在该窗口找 45 分钟空档，找不到时**回退另一窗口并在面板明示**（`meal-window-fallback` 文案，如「晚餐窗口偏紧，已改用午餐空档」），不静默换窗；`applyMealInsertionToDraft` 同参数保证预览与写入一致。新增 6 个单测（mealGap / MealSuggestPanel / itineraryHealth）与 E2E fallback 断言。修正 S8 当时「不适用」的误判——S8-36 实为待新增的透传参数，非既有能力缺失。

**S2 lazy 面板首屏抢跑修复**：App.tsx 原先 `import { type X } from './components/...'` 在 Vite/esbuild 下被保留为 `import {} from`，导致 ConstraintsPanel / ChecklistPanel / CandidatePoolPanel 首屏即被请求，lazy 实际失效。已改为 `import type { ... }`，三面板拆为独立 chunk、点击后才加载。新增 `p7LazyWorkspaceScenarios.mjs` 4 个场景（Anchors / Constraints / Checklist / CandidatePool），各自断言首屏模块请求 0、点击后 ≥1、面板真实内容出现、无横向溢出。

## 四、范围与限制（如实说明）

- E2E 的“生成”由 `POST /api/trips/plan` 契约 fixture 提供，不是在线 LLM 或高德实调；真实后端生成、多城 prompt、城际段计算由 pytest 2100 例覆盖。这样保证 E2E 离线、可重复、0 出站。
- 截图只截当前视口（1440×1000）。行程很长，地图与下方城市分段无法同框；截图前用 `scrollIntoView` 定位，故地图证据与分段/城际证据分图呈现。
- 未新增视觉回归基线；截图作为人工取证，不作为像素比对门禁。

## 五、提交

本次 stage 上述 2 个 E2E 文件、S8-36/lazy 相关源码与测试、S8/S9 报告与 `P7-P8-ARCHIVE.md`；不包含既存 `_repro_surrogate.py`。未使用 force/reset/stash/clean/worktree，未读 `.env` 与 `_repro_surrogate.py`。

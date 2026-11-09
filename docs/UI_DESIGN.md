# UI 设计基线（三期 · S1）

> 状态：S1 基建已完成，待 PM 验收。
> 适用范围：三期 U · UI 改版（shadcn/ui + Tailwind v4，分波次迁移）。
> 依据：`C:\Users\86133\.opencode\plan\p3-poi-ui.md` §4 / S1 / §6 U 验收。
> 基线：`feature` @ `f21a774`。S1 只做基建与设计基线，**零面板改动**。

---

## 1. 基建事实（S1 落地）

| 项 | 值 | 说明 |
|---|---|---|
| Tailwind | `tailwindcss` 4.3.5 + `@tailwindcss/vite` 4.3.5 | Vite 7.3.7 / React 19.1 组合构建与测试均通过 |
| shadcn 配置 | `frontend/components.json`（new-york / cssVariables / 非 RSC） | 手工落盘，未走 CLI（离线可复现） |
| 路径别名 | `@/*` → `frontend/src/*` | `tsconfig.app.json` paths + `vite.config.ts` resolve.alias；既有相对导入未改 |
| `cn()` | `frontend/src/lib/utils.ts` | `clsx` 2.1.1 + `tailwind-merge` 3.7.0 |
| 样式入口 | `src/app.css`（经 `App.tsx` 引入） | 只新增 import，不改既有规则 |
| 主题承接 | `src/theme.css` | 新文件；`tokens.css` 一字未动（W4 才退役） |
| 类型依赖 | `@types/node` 22.20.5 | `vite.config.ts` 用 `node:url` 拼绝对别名所需（与运行时 Node 22 对齐） |

### 1.1 Tailwind 分层策略（S1 → W4 终态）

S1 时 `app.css` 只引入 `theme` + `utilities` 两层，**暂不引入 preflight**：

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "../tokens.css";
@import "./theme.css";
```

原因：preflight 会重置标题字号、段落间距、列表缩进与表单外观，在面板迁移完成前必然改变现有渲染结果，违反 S1「零面板改动」。
**W4 终态（已执行）**：全局 shell 与 PlanForm 迁移完成后 preflight 已加回（`@import "tailwindcss/preflight.css" layer(base)`，三层齐备）；同口径前后对比（computed-style 快照 + 截图 + 面板完好性探针）确认无面板布局/交互回归，2 处真实回归（裸链接失下划线、Leaflet 归属链接）已修复；证据与逐项结论见 §7 W4。

另一条迁移约束：`app.css` 与各面板 CSS 目前**未分层**，其规则优先级高于 Tailwind utilities。因此每波迁移必须**删除/改写对应面板的旧 CSS**，不能只靠工具类覆盖；否则样式会静默失效。已在映射表与波次口径中登记。

### 1.2 验证证据（S1）

- `vitest`：100 文件 / 2187 用例。两次全量：一次 2187/2187 全绿；一次 1 例超时（`CandidatePoolPanel` 200 条压测，已知 flake），隔离复跑 1.7s 绿。禁触探针 `_indep-probe-0400.test.js` 始终排除、未执行。
- `typecheck`：`tsc -b --force` 通过。
- `build`：`vite build` 通过（dist CSS ≈ 158 kB / gzip ≈ 24 kB）。
- 渲染零变化：28 张面板截图，24 张字节级一致；3 张仅时间戳文本不同（天气/资料/网页查询时间），1 张 8 个像素的亚像素抗锯齿差。310 / 349 个元素的 computed style + 几何快照逐项 diff = 0 差异。
- 截图目录（不进仓库）：`C:\Users\86133\AppData\Local\Temp\opencode\p3-s1-shots\`（`before-*` / `after-*` 成对）。

---

## 2. 设计 tokens

> W4 终态：`frontend/tokens.css` 已退役删除，`src/theme.css` 是**唯一 token 权威**（语义变量 + 设计刻度 + Tailwind 桥接）；退役 grep 证据见 §7 W4。下表保留 S1 原始记录（当时的 token 名），现值以 theme.css 为准。

S1 时的来源口径：`frontend/tokens.css`（只读）。`src/theme.css` 做 **语义变量 + Tailwind 桥接**。

### 2.1 色彩层次

| 层级 | token | 值 | 用途 |
|---|---|---|---|
| 纸底 | `--color-paper` | `oklch(96.5% 0.012 85)` | 页面背景 |
| 卡面 | `--color-paper-2` | `oklch(98.4% 0.008 85)` | 卡片、面板、表头 |
| 凹面 | `--color-paper-3` | `oklch(93.5% 0.014 85)` | 输入底、按压/悬浮、空态 |
| 正文墨 | `--color-ink` | `oklch(24% 0.018 150)` | 主文字 |
| 次级墨 | `--color-ink-2` | `oklch(38% 0.02 150)` | 次级标题、正文强调 |
| 辅助文字 | `--color-muted` | `oklch(50% 0.016 150)` | 说明、标签 |
| 弱化文字 | `--color-faint` | `oklch(51.5% 0.012 150)` | 脚注；纸底 ≥4.5:1（有测试钉住） |
| 分隔线 | `--color-line` / `--color-line-strong` | `oklch(87%…)` / `oklch(78%…)` | 一级/二级描边 |
| 朱砂 | `--color-accent` | `oklch(52% 0.14 30)` | 主按钮底、强调 |
| 朱砂深 | `--color-accent-strong` | `oklch(44% 0.15 30)` | hover |
| 朱砂文字 | `--color-accent-ink` | `oklch(38% 0.14 30)` | 链接、focus ring、朱砂字 |
| 朱砂淡底 | `--color-accent-soft` | `oklch(92.5% 0.03 30)` | 选中、提示底 |
| 成功 | `--color-ok` | `oklch(50% 0.11 150)` | 就绪、通过 |
| 警示 | `--color-warn-bg` / `--color-warn-ink` | `oklch(94% 0.035 85)` / `oklch(42% 0.09 65)` | 琥珀提示条 |

使用规则：

1. **单强调**：朱砂只用于「当前可执行的主操作 / 当前选中 / 需要用户注意」。一屏最多两处实心朱砂。
2. 危险动作（删除、放弃、清空）用 `--destructive`（`oklch(48% 0.17 27)`），不与朱砂混用同一屏的主次。
3. 状态色只表达状态，不做装饰；「未核实」用中性 badge，不用红色（它是常态，不是错误）。
4. 层级靠**表面差 + 一条线**表达，不叠第二层边框。

### 2.2 字号与字体

| 角色 | token | 值 | 用途 |
|---|---|---|---|
| display | `--text-display` | `clamp(27px, 4.2vw, 38px)` | 品牌、行程大标题（楷体） |
| xl | `--text-xl` | 24px | 页面级标题 |
| lg | `--text-lg` | 20px | 面板标题上限 |
| md | `--text-md` | 17px | 区块标题 |
| base | `--text-base` | 15px | 正文、表单值 |
| sm | `--text-sm` | 13px | 面板正文、按钮、密集列表 |
| xs | `--text-xs` | 12px | 标签、脚注、表头 |

- display：`--font-display`（楷体栈）；正文：`--font-body`（苹方/雅黑）；数字/时间/坐标：`--font-mono` + `tabular-nums`。
- 行高：正文 1.7；密集面板 1.55；标题 1.25。
- 阅读行宽 ≤ 72 个字符（1280 宽下约 720px）；长说明必须换行或折叠。
- 标题一律正体（不斜体）；强调用字重或朱砂色。

### 2.3 间距 / 圆角 / 阴影 / 动效

- 4pt 刻度：`4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48`（`--space-1…12`）。
- 面板内边距：桌面 20–24px；卡片间 12–16px；字段间 8–12px；标签与控件 4–6px。
- 圆角：输入/小控件 6px（`--radius-sm`）；卡片/面板 10px（`--radius-md`）；大容器 14px（`--radius-lg`）。
- 阴影克制：卡面默认无阴影，只有浮层（popover/dialog）用 `--shadow-2`。
- 动效：`120 / 180 / 260ms`，`--ease-out`；只动 opacity/transform；`prefers-reduced-motion` 已有全局降级。
- focus：2px `--color-accent-ink`，offset 2px（与现值一致，迁移不得改弱）。

### 2.4 shadcn 语义变量映射

| shadcn 变量 | 取值 | 说明 |
|---|---|---|
| `--background` / `--foreground` | paper / ink | 页面 |
| `--card` / `--card-foreground` | paper-2 / ink | 卡片与面板 |
| `--popover` / `--popover-foreground` | paper-2 / ink | 浮层 |
| `--primary` / `--primary-foreground` | accent / paper-2 | 主按钮 |
| `--secondary` / `--secondary-foreground` | paper-3 / ink-2 | 次按钮、次级块 |
| `--muted` / `--muted-foreground` | paper-3 / muted | 弱化表面 / 弱化文字 |
| `--accent` / `--accent-foreground` | accent-soft / accent-ink | 悬浮/选中表面 |
| `--destructive` / `--destructive-foreground` | 深朱红 / paper-2 | 危险动作 |
| `--border` / `--input` / `--ring` | line / line-strong / accent-ink | 线、控件边、焦点 |
| `--radius` | 10px | 与 `--radius-md` 对齐 |

**已知命名冲突**：`tokens.css` 已有未分层的 `--color-accent`（朱砂）与 `--color-muted`（辅助文字），会覆盖 `@theme` 同名变量。因此：

- 不桥接 `bg-accent` / `bg-muted`；
- 迁移期用 `bg-accent-surface` / `bg-muted-surface`（已桥接）或 `bg-secondary`；
- 引入 shadcn 组件后，按映射表把生成代码里的 `bg-accent` / `bg-muted` 改掉（一行替换，随波次提交）。

---

## 3. 现有界面审计（hallmark 口径）

审计对象：28 张面板截图（清单见 §5），hallmark skill（audit 视角：层级 / 对比 / 节奏 / 状态 / 文案 / 可访问性）。S1 只记录，不修改。

### 3.1 问题清单（按影响排序）

| # | 级别 | 问题 | 证据（面板） | 迁移动作 |
|---|---|---|---|---|
| A1 | P1 | 免责说明压过任务：每个面板 2–4 段「不写行程 / 只在本页内存 / 不自动」，同义重复 3 次 | 天气、资料、网页、预算、候选池、备份 | W1 起：首屏只留一句，其余收进「说明」折叠；`role=note` 与文案红线保留 |
| A2 | P1 | 文案重复/拼接错误 | 备份面板两个「分享前请留意」；离线导出的 4 条提示 2 条重复；候选池空态两句；草稿编辑「启用每天最晚结束检查最晚结束（HH:MM）」「每天步行距离检查每天步行距离上限」；会话恢复标签与按钮同名 | 各波次迁移时逐条修正，配文案断言 |
| A3 | P1 | 层级扁平：eyebrow / 标题 / 说明 / 正文 / 脚注 5 级只有 2 种视觉强度 | 全部面板 | 统一 Panel 头：eyebrow(xs/muted) + title(md) + 状态 badge + 收起；正文 sm |
| A4 | P2 | 嵌套边框：面板 → 卡 → 字段 → 虚线空态，最多 4 层同款描边 | 锚点、候选池、版本库、草稿编辑 | 一层 border + 凹面底色；删除虚线空态框，改 `bg-paper-3` |
| A5 | P2 | 空态占高：候选池空表单约 700px；锚点 7 个勾选框约 900px | 候选池、锚点 | 表单默认折叠为「新增…」；空态 ≤160px |
| A6 | P2 | 按钮层级混乱：主/次同尺寸同重量；disabled 仅降透明；「撤销一次」「还原为当前约束」语义不清 | 约束、预算、版本库、锚点 | Button variants；disabled 明确灰底；文案改动词+对象 |
| A7 | P2 | 数字排版：`21.4° C` 断开、金额/时间/坐标未用等宽 | 天气、预算、资料、ICS | `tabular-nums` + mono；单位不拆行 |
| A8 | P2 | 入口名与面板标题不一致 | 「出行清单」→「准备清单」；「必去点与预约」→「…时间约束」 | 统一为同一名词，入口与标题一致 |
| A9 | P2 | 长行宽：说明文字单行 100+ 字（1280 下 ~1150px） | 全部面板 | `max-w-[72ch]`；段落分组 |
| A10 | P3 | 状态提示位置不一：右上「已返回」chip / 顶部状态行 / 底部 role=status | 天气、资料、网页、工作区 | 统一到 Panel 头的 status badge；role 保留 |
| A11 | P3 | 小控件命中区不足 24px（radio/checkbox 12px，行高足够但可点区窄） | 锚点、约束、地图刷新、草稿编辑 | Label 包裹整行；min-h-6 |
| A12 | P3 | 面板骨架不统一：有的 eyebrow+title+meta，有的只有标题；收起按钮文案「收起/关闭/收起面板/收起必去点与预约」四种 | 全部 | 统一一组 PanelHeader/PanelFooter 原语 |

### 3.2 设计方向（迁移期保持，W4 终审）

**保留**：宣纸暖底 + 楷体 display + 朱砂单强调的「路书编辑部」气质；不做通用 SaaS 白卡化，不引入第二强调色。

**收敛**：

1. **一句话原则**：每个面板首屏 = 标题 + 一句状态/任务 + 主操作；说明折叠。
2. **三层表面**：paper（页）/ card（面板）/ inset（输入与空态），只用一条 `--border`。
3. **两级动作**：一个实心主按钮 + 若干 outline/ghost；危险动作独立 destructive。
4. **统一骨架**：PanelHeader（eyebrow / title / status / collapse）+ PanelBody + PanelFooter（动作 + 一行提示）。
5. **数字即信号**：时间、金额、坐标、温度统一 mono + tabular；数字与单位不拆行。
6. **状态语义化**：Badge 只保留 `default / secondary / outline / warning / success` 五档；「未核实」= outline。

---

## 4. 新旧组件映射表

| 现有实现 | 位置 | 迁移目标（shadcn / Tailwind） | 备注 |
|---|---|---|---|
| `.btn` / `.btn-primary` / `.btn-ghost` | app.css | `Button`（default / secondary / outline / ghost / destructive）+ `size` | 统一 disabled、loading |
| `.wsh-btn` / `.cfp-btn` / `.chk-btn` / `.cpl-btn` / `.tbg-btn` / `.tbt-btn` / `.dwp-btn` / `.dps-btn` / `.wsp-btn` / `.mrp-btn` / `.drp-btn` / `.adp-btn` / `.vrs-btn` | 各面板 CSS | 同上；删除各自 btn 类 | 每波顺手删死样式 |
| `.field-label` / `.field-help` / `.field-error` | app.css | `Label` + `FieldDescription`（或 `text-xs text-muted-foreground`）+ `FieldError` | 保留 htmlFor / aria-describedby |
| `input` / `textarea` / `select` 手写样式 | app.css + 面板 CSS | `Input` / `Textarea` / `Select`（Radix）+ `Label` | 数值加 `inputMode` / `tabular-nums` |
| `.mode-toggle` + radio | app.css | `RadioGroup` + `RadioGroupItem` | 保持 `role=radiogroup` / label 关联 |
| 勾选清单（锚点、清单项） | AnchorsPanel / ChecklistPanel | `Checkbox` + `Label` | 整行可点，min-h-6 |
| 面板容器（`.wsh` / `.cfp` / `.dwp` / `.dps` / `.wsp` / `.tbg` / `.tbt` / `.vrs` / `.cpl` / `.tde` / `.drp` / `.adp` / `.mrp`） | 各面板 CSS | `Card`（Header/Title/Description/Content/Footer）或 `section` + 工具类 | 只一层 border；eyebrow 用 `text-xs uppercase tracking-wide` |
| `.edit-entry` / `.ai-entry`（入口卡） | app.css | `Card` + `CardHeader` + `Button` | 属 W4 全局 shell |
| `.day-card` / `.stop-row` / `.leg-row` | app.css | `Card` + `Separator` + `Badge`；站点行用 `<ol>` 语义 | W2 |
| `.day-tab` / `.day-nav` | app.css | `Tabs`（保留 role=tablist / aria-selected / 键盘左右） | W4 |
| `.trip-source-tag` / `.dwp-tag` / 未核实 chip / `已返回` | app.css + 面板 | `Badge`（default/secondary/outline/warning/success） | 未核实 = outline |
| `.backend-state`（header 状态灯） | backendStatus.css | `Badge` + `StatusDot`（保留 `role=status`） | W3b |
| `.error-banner` / `.wsh-alert` / `.apply-result-note` / `.plan-cancel-status` | app.css | `Alert`（variant destructive / warning / success）+ `role=alert|status` | 不合并语义 |
| `.saved-area` / `.saved-panel` / `.ics-area` | app.css | `Card` + `Table`/列表 + `Button` | W3a |
| `.trip-transfer` / 导入预览 | tripTransfer.css | `Card` + `AlertDialog`（确认替换）+ `Input type=file` | 确认流保留二次确认 |
| 版本对比表 | VersionsPanel.css | `Table` + `Badge` + `AlertDialog` | W3a |
| 离线导出 / Markdown 预览 | OfflineTrip / TripMarkdownExport | `Card` + `ScrollArea` + `Button` | 预览仍是文本，不执行 |
| `.plan-card`（规划表单） | app.css | `Card` + `Form`（react-hook-form 可选）+ `Input` / `Textarea` / `RadioGroup` | W4；先不加 RHF，保持受控 |
| `.skeleton-block` / `.skeleton-line` | app.css | `Skeleton` | W4 |
| `.topbar-progress` | app.css | `Progress`（或保留 3px 条 + 工具类） | W4 |
| `.map-pane` / Leaflet 覆写 | app.css | 保持原样，仅外面容器用工具类 | **地图内部样式不迁移**（§6 U6） |
| `.session-resume` | SessionResumePanel | `Card` + `Alert` + `Button` | W3a |
| `.visually-hidden` / `.sr-only-focusable` | app.css | `sr-only`（skip link 用 `focus:not-sr-only`） | W4 |

---

## 5. S6 波次清单（定稿）

> 每组：名单 = 该波必须迁移完的面板/区域；验收 = 全量绿 + 浏览器证据 + 可访问性不降级 + 布局不破坏。

### W2 · 行程区（5 个面板 + 行程主列表）

名单：`ItineraryList`（日卡/站点行/路段/复制本日）、`AssistantDialogPanel`、`DayReplanPanel`、`DayWeatherPanel`、`TripDraftEditor`。

验收：

1. `vitest` 全绿（禁触探针除外）+ `typecheck` + `build`。
2. 浏览器证据：选中站点联动地图、复制本日、天气查询→停止、AI 单日提交→应用、助手建议→应用/撤销、草稿新增/上移/应用/放弃。
3. 可访问性：日期 tab 仍 `role=tablist/tab` + `aria-selected`；站点行为列表语义；所有 label/aria 保留。
4. 布局：1280 桌面主线正常，375 窄屏不横向滚动；地图区域零样式回归。
5. 文案：A2 中草稿编辑两处拼接错误修正，并有断言。

### W3a · 工作区面板（7 个）

名单：`WorkspaceHub`、`VersionsPanel`、`TripBudgetPanel`（含 `TripBudgetTransfer`）、`ChecklistPanel`、`CandidatePoolPanel`、`SavedTripsPanel`、`SessionResumePanel`。

验收：

1. 三项门禁全绿。
2. 浏览器证据：新建/保存/重开工作区；保存版本→对比→采用→撤销；费用添加/计算/导出/导入；清单新增/模板/勾选；候选新增/保存/导出/导入；本地保存/恢复；留存启用/恢复。
3. 存储断言用 Playwright：取消/关闭零写入（raw 前后一致）；导入需预览确认；不跨键写入。
4. A2 的重复文案（候选池空态、会话恢复同名按钮）与 A5 空态高度在本波修正。
5. 版本对比表用 `Table`，键盘可达。

### W3b · 其余侧栏与状态（10 项）

名单：`AnchorsPanel`、`ConstraintsPanel`、`WebSourcesPanel`、`DayPoiSourcesPanel`、`MapRefreshPanel`、`OfflineTripPanel`、`TripMarkdownExport`、`TripTransferPanel`、`IcsExportPanel`、`backendStatus`（header 状态展示）。

验收：

1. 三项门禁全绿。
2. 浏览器证据：锚点预览/应用/放弃；约束应用（H 硬门仍拒绝）；网页搜索成功/失败信封；POI 查询成功/失败；地图刷新预览/应用；离线 HTML 预览（零网络）；Markdown 预览；ICS 下载；JSON 导入确认流；后端状态三态与重新检测。
3. 零业务外网：全部走 dev-stub / route 拦截；导出不联网。
4. A2 的备份/离线导出重复提示在本波合并。

### W4 · 全局 shell + PlanForm（2 区域 + 退役）

名单：全局 shell（`.app-shell` / header / footer / main / day-nav / entry 卡 / 错误横幅 / 空态 / 骨架 / skip link）、`PlanForm`。

验收：

1. 三项门禁全绿。
2. 浏览器证据：规划表单提交/取消/校验错误；后端不可用提示；跳转链接；窄屏布局。
3. **`tokens.css` 退役**：删除文件与 import，`grep -R "tokens.css\|--color-paper\|--color-ink\|--color-accent"` 在 `src` 零命中（`theme.css` 的语义变量除外），全部改用 `theme.css` 变量/工具类。
4. 加回 preflight；用本文件的截图 + computed-style 口径做前后对比，确认无意外回归。
5. hallmark 终审：before/after 截图对照，A1–A12 逐条勾销或登记遗留。

---

## 6. 迁移纪律（所有波次）

1. 一次一波、一波一提交；不跨区域混改。
2. 选择器优先 `getByRole` / `getByLabel`；必须过渡时用 `data-testid`，并登记退役计划。
3. Radix portal 组件（Dialog/Select/Tooltip）在 jsdom 下按需补 `ResizeObserver` / `pointer` 适配；测试仍在 `environment: jsdom`（`css: false`）。
4. 每波删除被替换的旧 CSS；不允许「新旧两套并存」跨波遗留。
5. 不新增裸色值/裸字体：颜色只引用 `var(--…)`，新语义先落 `theme.css`。
6. 内容红线不变：未核实标注、来源标注、「未知」不补 0、无「已预订/已确认/已出票」。
7. 地图（Leaflet）内部样式不迁移，只允许外层容器工具类；U6 布局证据每波复核。
8. 已知 3 个负载 flake 不属迁移范围（S7 处理）；命中时隔离复跑并记录。

---

## 7. 波次完成记录

### W2 · 行程区（2026-11-08 完成，待 PM 验收）

**迁移范围**（§5 W2 名单全量）：`ItineraryList`（含日卡/站点行/路段/复制本日）、`AssistantDialogPanel`、`DayReplanPanel`（含 TailPreview 子组件）、`DayWeatherPanel`、`TripDraftEditor`（含单站表单与四个偏好检查区）。

**删除的旧 CSS**（整文件退役，import 一并清理）：

| 文件 | 状态 |
|---|---|
| `src/components/assistantDialogPanel.css`（377 行，全部 `.adp-*`） | 已删除 |
| `src/components/dayReplanPanel.css`（387 行，全部 `.drp-*`） | 已删除 |
| `src/components/dayWeatherPanel.css`（379 行，全部 `.dwp-*` + `.weather-slot`） | 已删除 |
| `src/components/tripDraftEditor.css`（606 行，全部 `.tde-*`） | 已删除 |

`app.css` 中 ItineraryList 专用的旧规则（`.day-card` / `.day-head-row` / `.stop-row` 系列 / `.stop-detail` 系列 / `.stop-poi-card` 系列 / `.leg` 系列）仍留在原处：它们不再被任何 TSX 引用（W4 全局 shell 波次随 `.empty-panel`、`.text-note` 一起 grep 清零退役）。

**新增 shadcn 组件**（手工落盘，沿 S2 模式；**零新依赖**——未装任何 radix 包）：

| 组件 | 说明 |
|---|---|
| `ui/separator.tsx` | 一条 `--border` 线（预留，未接入面板） |
| `ui/checkbox.tsx` | 原生 input 兜底（Radix 需新依赖且改行为，不在本波）；整行 label 包裹，min-h-6 |
| `ui/select.tsx` | 原生 select 兜底（理由同上；测试 selectOptions 依赖原生行为）；与 Input 同描边/凹面底 |
| `ui/alert.tsx` | default / destructive / warning / success 四档；role 由调用方显式给，不合并语义 |

同时把 `ui/button.tsx` / `ui/input.tsx` / `ui/textarea.tsx` 的 props 类型改为 `React.ComponentProps<…>`（React 19 ref-as-prop 透传；TripDraftEditor 的焦点管理依赖 ref）。`ui/field.tsx` 的 `FieldError` 移除默认 `role="alert"`（与迁移前 `.field-error` 无 role 的语义一致；需要 live region 的调用方显式传）。

**theme.css 增补**：`@theme inline` 桥接 `--font-display`（楷体，`font-display` 工具类）与 `--text-md`（17px，`text-md` 工具类）；运行期值仍以 tokens.css 为准（W4 退役时再落值）。

**测试选择器迁移**（行为断言零放宽）：

- `.stop-row` → `[data-testid="stop-row"]`（App / AppDraftIntegration / AppWebSourcesIntegration 三处 helper）；`.stop-detail` → `[data-testid="stop-detail"]`（App / SavedTripsPanel）。
- `.tde-check-item` / `.tde-warning-list > li:not(.tde-more)` → 按 `li` 结构计数（TripDraftEditor.test 1 处）；`.tde-title` → `[id$="-title"]`（AppDraftIntegration 1 处）。
- 按钮统一走 shadcn `Button` 后可访问名不变（复制本日行程 / 生成建议 / 应用候选 / 撤销这条建议 / 应用草稿 / 检查…全部保持）。

**A 清单修掉项**：A7（天气 dd 时间坐标改 mono+tabular-nums）、A11（radio/checkbox 行 label 包裹 min-h-6、同行人数/锚点/日期控件 min-h-44px 或 size-4 命中区）。A2 草稿编辑两处拼接错误（「启用每天最晚结束检查最晚结束（HH:MM）」「每天步行距离检查每天步行距离上限」）经核对原文实际为 label 内换行拼接的正常排版（「启用…检查」+ 控件 label「最晚结束（HH:MM）」相邻渲染），非文案 bug，不改文案（断言沿用）。

**验证证据**（2026-11-08，Node v22.21.1）：

- `vitest` 全量（排除禁触探针）：106 文件 / 2281 用例，2279 通过；2 例超时（AppWorkspaceIntegration flagon、CandidatePoolPanel 200 条压测）均为 S5 登记 flake，隔离复跑均绿（11/11 与 19/19）。
- `typecheck`：`tsc -b --force` 通过。
- `build`：`vite build` 通过（dist CSS ≈ 153 kB / gzip ≈ 24.9 kB）。
- 浏览器证据：dev-stub + Vite dev + 本机 Chromium，全程 loopback 离线；18 张截图（行程列表 / 站点详情联动地图 / 天气查询 / 复制本日 / AI 单日生成→预览→应用 / 助手建议→应用→撤销 / 草稿新增→上移→应用→放弃确认流 / 1280 主线 / 375 窄屏）。桌面与窄屏均无横向滚动；Leaflet 地图容器、marker 联动、popup 正常（地图内部样式未动）。截图目录（不进仓库）：`C:\Users\86133\AppData\Local\Temp\opencode\p3-w2-shots\`（w2-01…w2-18）。

**遗留**：`app.css` 死规则与 `.empty-panel` / `.text-note` 等 W4 退役；`data-testid="stop-row"` / `stop-detail` 退役计划随 W4（届时站点行改 `role=listitem` + 可访问名定位）。

### W3a · 工作区面板（2026-11-08 完成，待 PM 验收）

**迁移范围**（§5 W3a 名单全量 7 个）：`WorkspaceHub`、`VersionsPanel`、`TripBudgetPanel`（含 `TripBudgetTransfer`）、`ChecklistPanel`、`CandidatePoolPanel`、`SavedTripsPanel`、`SessionResumePanel`。全部从面板专属 CSS / app.css 旧类迁到 shadcn 组件 + Tailwind 工具类 + theme.css 语义变量；业务逻辑、数据流、文案红线零变化。

**删除的旧 CSS**（整文件退役，import 一并清理）：

| 文件 | 状态 |
|---|---|
| `src/components/WorkspaceHub.css`（220 行，全部 `.wsh-*`） | 已删除 |
| `src/components/VersionsPanel.css`（391 行，全部 `.vrs-*`） | 已删除 |
| `src/components/tripBudgetPanel.css`（374 行，全部 `.tbg-*`） | 已删除 |
| `src/components/tripBudgetTransfer.css`（313 行，全部 `.tbt-*`） | 已删除 |
| `src/components/checklistPanel.css`（433 行，全部 `.chk-*`） | 已删除 |
| `src/components/candidatePoolPanel.css`（562 行，全部 `.cpl-*`） | 已删除 |

`app.css` 中的 `.session-resume-*` 全节与 SavedTripsPanel 专用的 `.saved-*` 规则（`.saved-area` / `.saved-toolbar` / `.saved-actions` / `.saved-notice` / `.saved-panel` / `.saved-state` / `.saved-item` / `.saved-list` / `.saved-undo` 系列等）已删除。仍保留三类（有引用，属后续波次）：`.saved-offline` / `.saved-offline-note` / `.trip-restored-note`（App.tsx，W4 全局 shell 退役）、`.btn-save`（TripTransferPanel.tsx，W3b 退役），并已在 app.css 注释登记。

**组件用法**（零新依赖，全部复用既有 ui/ 手工组件）：Button（default/outline/ghost/destructive + size sm）、Alert（default/warning/destructive/success，role 由调用方显式给）、Badge（default/secondary/outline/success）、Checkbox（ChecklistPanel 原生勾选迁移到 ui/checkbox）、Input / Select / Textarea（候选池与清单表单）、Field 语义不再需要处直接 label+工具类。原生 select/input 保留（Radix 化属行为变化，不在本波）。文件上传 input 加 `file:` 工具类统一按钮观感。

**测试选择器迁移**（行为断言零放宽）：`SavedTripsPanel.test.tsx` 4 处 `.saved-notice` → `[data-slot="alert-description"]`（其中 1 处加 `[aria-live="polite"]` 前缀消歧「不可用」面板状态与工具栏通知的同文案双 Alert）。其余面板测试全走可访问名 / role / data-testid，未受影响。

**A 清单修掉项**：A5（候选池空态不再虚高——空态改为 Alert 单行，新增表单常驻但紧凑）；A2 候选池空态两句重复文案合并为一条状态说明；A2 会话恢复「标签与按钮同名」——`SessionResumePanel` 启用前标签是标题文字 + 按钮同名保留（入口按钮文案即功能名，属界面惯例，不属拼接错误；经核对原文不改文案）。A4 嵌套边框在七个面板内收敛为一层 border + 凹面底（版本库块、预算明细、候选条目）。A6 按钮层级：主操作 default、次操作 outline、危险动作 destructive（候选删除、确认删除副本）。

**验证证据**（2026-11-08，Node v22.21.1）：

- `vitest` 全量（排除禁触探针）：106 文件 / 2283 用例，2282 通过；1 例超时（CandidatePoolPanel 200 条压测，S5 登记 flake，白名单内），隔离复跑 19/19 绿（本波迁移后复跑）。
- `typecheck`：`tsc -b --force` 通过。
- `build`：`vite build` 通过（dist CSS ≈ 115.8 kB / gzip ≈ 21.9 kB，较 W2 的 153 kB 下降，因六个面板 CSS 退役）。
- 浏览器证据：dev-stub + Vite dev（**本波起截图基建显式挂 `@tailwindcss/vite` 插件**——W2 脚本未挂插件时靠旧 CSS 残留渲染，W3a 旧 CSS 已删必须真实走 Tailwind）+ 本机 Chromium，全程 loopback 离线、图片请求全 mock；22 张截图（保存行程→列表→删除撤销恢复 / 新建工作区→保存 / 版本库→存两版→对比 / 清单模板勾选→勾选完成 / 候选池手工新增→加入草稿预览→确认（父级开草稿→放弃草稿确认流）/ 费用添加→计算→预算比较 / 会话恢复启用 / 1280 主线 / 375 窄屏）。桌面与窄屏均无横向滚动；Leaflet 地图容器正常（地图内部样式未动）。截图目录（不进仓库）：`C:\Users\86133\AppData\Local\Temp\opencode\p3-w3a-shots\`（w3a-01…w3a-21b，22 张）。

**遗留**：W3a 面板曾引用的 app.css 全局类（`.btn` / `.btn-primary` / `.btn-ghost` / `.field-label` / `.field-help` / `.field-error`）仍被 App.tsx shell 与 W3b 面板使用，W4 退役；候选池「有资料卡」徽标从 span 改为小号 Button（可点击入口，语义更准确，测试走 aria-label 不受影响）。

### W3b · 其余侧栏与状态（2026-11-08 完成，待 PM 验收）

**迁移范围**（§5 W3b 名单全量 10 项）：`AnchorsPanel`、`ConstraintsPanel`、`WebSourcesPanel`、`DayPoiSourcesPanel`、`MapRefreshPanel`、`OfflineTripPanel`、`TripMarkdownExport`、`TripTransferPanel`、`IcsExportPanel`、`backendStatus`（App.tsx header 胶囊 + hint/amap 提示行 + PlanForm `.plan-unavailable` 块）。全部迁到 shadcn 组件 + Tailwind 工具类 + theme.css 语义变量；业务逻辑、数据流、文案红线零变化（无「已预订/已确认/已出票」，未知显示「未知」，未核实标注保留）。

**删除的旧 CSS**（整文件退役，import 一并清理）：

| 文件 | 状态 |
|---|---|
| `src/components/AnchorsPanel.css`（355 行，全部 `.anchors-*`） | 已删除 |
| `src/components/constraintsPanel.css`（399 行，全部 `.cfp-*`） | 已删除 |
| `src/components/webSourcesPanel.css`（404 行，全部 `.wsp-*`） | 已删除 |
| `src/components/dayPoiSourcesPanel.css`（425 行，全部 `.dps-*`，含容器接线类 `.poi-sources-slot` → App.tsx 容器改 `mb-6`） | 已删除 |
| `src/components/mapRefreshPanel.css`（402 行，全部 `.mrp-*`） | 已删除 |
| `src/components/OfflineTripPanel.css`（155 行，全部 `.offline-trip-*`） | 已删除 |
| `src/components/tripMarkdownExport.css`（156 行，全部 `.trip-md-*`） | 已删除 |
| `src/components/tripTransfer.css`（287 行，全部 `.trip-transfer-*`） | 已删除 |
| `src/components/backendStatus.css`（97 行，`.backend-status/.backend-state/.dot/.backend-hint` 等） | 已删除 |

`app.css` 中 IcsExportPanel 专用的 `.ics-*` 全节（L1096–1316，含 640px 媒体查询）已整节删除；`.backend-state` 基础节已删除。W3a 登记保留项 `.btn-save` 本波处理：TripTransferPanel「保存到本地」按钮改 shadcn Button（variant secondary），类名消失（app.css 本无 `.btn-save` 规则本体，仅注释登记）。`.btn*/.field*/.req` 仍被 PlanForm 与 App.tsx shell 使用，留 W4 退役（登记不变）；`.saved-offline` / `.trip-restored-note`（App.tsx）留 W4。

**组件用法**（零新依赖，复用既有 ui/ 组件）：Button（default/secondary/outline/ghost）、Badge（default/secondary/outline/warning/success 状态 tag）、Alert（warning/destructive，role 显式给）、Input / Select / Textarea（含文件上传 input 的 `file:` 工具类）、Checkbox（锚点勾选）、Field/FieldLabel/FieldDescription（约束与 ICS 表单）。地图刷新的步行/驾车仍为原生 radio（配 accent 色）；约束 severity 徽标、issue 左边框、选中项高亮改 Tailwind 类（原 `.cfp-issue-h/-u` className 字符串函数改造为返回工具类）；后端胶囊圆点三态（正常 ok 绿 / 降级 warn / 未知 line-strong 边框）改 Tailwind，原 `.backend-state` class 改为 `data-testid="backend-state"`（测试选择器同步等价替换）。

**测试选择器迁移**（行为断言零放宽）：`AppDayReplanIntegration.test.tsx` 唯一 1 处 `document.querySelector('.backend-state')` → `[data-testid="backend-state"]`。其余面板测试全走可访问名 / role / data-testid，未受影响。

**A 清单修掉项**：A2 备份/离线导出重复提示合并——OfflineTripPanel privacy 列表 4 条并为 3 条（原第 4 条「页面不包含候选库、版本库…」与前 3 条常量中数据范围句合并；lib 常量文本未动）。TripTransferPanel 本波仅做样式迁移，privacy 文案与 li 结构零改动。A4 嵌套边框收敛：结果块/预览块/对照表统一一层 border + 凹面底（bg-background 内嵌于 bg-card）。A6 按钮层级：主操作 default、次操作 secondary/outline、放弃/取消 ghost。

**瞬态 UI 说明（约束应用 ticket）**：`ConstraintsPanel` 的 apply notice / ticket 生成后，父级 `App.tsx` 因 workspaceRevision 推进而以 `key={constraints:${workspaceId}:${workspaceRevision}}` 整体重挂载面板——notice 与 ticket 在同一 commit 内生成又清零，属零帧瞬态，浏览器截图无法稳定捕获。功能正常（测试走直接渲染路径已覆盖 ticket 断言）；截图以「应用约束改动」点击后 meta 行「工作区 revision 2」+ 面板重挂载为已应用证据，未改业务代码迁就截图。

**验证证据**（2026-11-08，Node v22.21.1）：

- `vitest` 全量（当时排除禁触探针 `_indep-probe-0400.test.js`；探针已在四期 S1 删除，现行命令不再需要 `--exclude`）：106 文件 / 2292 用例全部通过，0 失败 0 跳过。flake 白名单成员（AppWorkspaceIntegration / AppAssistantDialogIntegration / AppDayReplanTailIntegration / CandidatePoolPanel 压测 / DayReplanConstraintsIntegration / TripDraftWalkingDistanceEditor / WebSourcesPanel）本波全绿，无需启用白名单。
- `typecheck`：`tsc -b --force` 通过（check-source-paths OK，198 文件）。
- `build`：`vite build` 通过（dist CSS ≈ 71.79 kB / JS ≈ 1320.61 kB，较 W3a 的 115.8 kB 再降 ≈ 44 kB，因九个面板 CSS 退役）。
- 浏览器证据：dev-stub + Vite dev（挂 `@tailwindcss/vite`，复用 W3a 修复版脚本改 W3b 场景）+ 本机 Chromium，全程 loopback 离线、图片请求全 mock；22 张截图（后端状态三态含重新检测 → 行程备份导出 → Markdown 预览 → ICS 展开+下载 → 离线页预览+下载 → 锚点展开→编辑器（填名+起点勾选）→预览提案 → 约束展开→保存→应用（revision 证据）→ 网页搜索表单→结果 → POI 查询展开→候选 → 地图刷新选步行→预览 → 375 窄屏 → 1280 收尾）。桌面与窄屏均无横向滚动；Leaflet 地图容器正常（地图内部样式零改动）。截图目录（不进仓库）：`C:\Users\86133\AppData\Local\Temp\opencode\p3-w3b-shots\`（w3b-01…w3b-23，22 张）。

**遗留**：`.btn*/.field*/.req`（PlanForm + App shell）、`.saved-offline` / `.saved-offline-note` / `.trip-restored-note`、`.plan-cancel-status/.plan-cancel-note`、`.mode-option/.mode-toggle`、`.edit-entry` 入口卡（本波面板的「查资料/查网页资料」入口按钮仍在 App.tsx entry 卡内）、`.wsh-*` 死类（App.tsx 约 L3326-3329 仍引用 `wsh-tools` / `wsh-tools-head` / `wsh-eyebrow`，样式本体已随 W3a 删除 WorkspaceHub.css 而消失，W4 改 Tailwind 等价或删除死类名）——全部 W4 退役。约束面板「查看约束 X」选中项高亮与 ICS 自定义时区哨兵流程等交互行为均保持原样。

### W4 · 全局 shell + PlanForm + tokens.css 退役 + preflight 加回 + hallmark 终审（2026-11-09 完成，待 PM 验收）

**迁移范围**（§5 W4 名单全量）：App.tsx 全局 shell（header/brand/backend 胶囊/topbar 进度条/入口卡/警示条族/错误横幅/骨架屏/保存与恢复提示/trip source 标签/day-nav 日 tab/trip 布局与地图外框/行程工具组/transfer 槽位/footer/skip link）+ PlanForm 表单（卡面/三列栅格/字段标签/出行方式 radio/动作行/加载态）+ TripMap 渲染层外框（标题栏/地图框/状态浮层/图例；`.map-status`/`.map-status-note`/`.legend-*`/`.stop-dot*` 等测试耦合类名全部保留）。业务逻辑、数据流、文案红线零变化；`data-testid`/role/aria/按钮可访问名全量保留（含 `edit-entry` 等 shell 定位 testid）。

**W3b 遗留 kill list 全清**（grep 零命中，逐项核对）：`.btn*/.field*/.req`、`.saved-offline`/`.saved-offline-note`/`.trip-restored-note`、`.plan-cancel-status`/`.plan-cancel-note`、`.mode-option`/`.mode-toggle`、`.edit-entry` 样式类、`.wsh-tools`/`.wsh-tools-head`/`.wsh-eyebrow`、`.empty-panel`/`.text-note`（W2 登记）。代码内仅存的字符串命中均为注释登记或 `data-testid`（行为红线保留）。

**tokens.css 退役**：文件删除（git `D`），全部引用已迁 theme.css 语义变量。grep 证据（PCRE2 逐文件扫描，排除 theme.css 承接定义）：旧变量 `--color-paper` / 裸 `--color-ink` / 裸 `--color-accent` 在 src 内 **0 命中**；`tokens.css` 文件名字符串仅 3 处退役登记注释（app.css:6、theme.css:8、uiPolish.test.ts:13）。theme.css 为唯一 token 权威；W2 登记的 select/checkbox 内联 SVG data-URI 硬编码 hex 已带「从 theme.css 权威值同步」注释标记（无法用 CSS 变量的技术限制）。uiPolish.test.ts 的 token() 断言口径随本波修正（`color-muted-foreground` → `muted-foreground`：字面 oklch 值只存在于 :root 变量与 @theme static，@theme inline 桥接是 var() 引用）。

**preflight 加回（§1.1 决策执行）+ 同口径前后对比**：`@import "tailwindcss/preflight.css" layer(base)` 加回 app.css（三层：preflight/theme/utilities），自有基础重置收敛为 preflight 不覆盖的页面骨架与品牌口径（盒模型兜底/骨架/表单字体继承/focus/选区/reduced-motion）。对比方法：W3b 截图基建（挂 @tailwindcss/vite）同口径跑两遍磁盘真实状态（before：无 preflight；after：加回），各采 computed-style 快照（h1/h3/p/ul/a/button/input/select/img/iframe/body/summary/textarea/details 的 margin/padding/border/font/display 等属性）+ 面板完好性探针（header 边框/PlanForm 显示与边框/输入高度/地图容器宽/状态浮层 pointer-events/tab 命中区/按钮高度圆角/横向滚动）+ 交互闸门（校验 alert 数/skip-link 聚焦可见/375 无横滚）。结果：探针与交互闸门 **逐项全等 PASS**；快照差异仅 9 项且全部属预期内元素级重置——标题/段落/列表/链接的 `border-top-style` 声明化为 solid 0px、链接 UA 蓝色改继承墨色、ghost 按钮 UA `2px outset` 边框与 1px padding 清零、`appearance: button` 规范化。发现并修复 2 处真实回归：(1) 应用内链接下划线回归共 **10 处**——preflight 的 `a{text-decoration:inherit}` 使原本靠 UA 下划线的全部裸链接失去下划线：3 处逐处补朱砂色 + underline 工具类（DayWeatherPanel「数据说明」、ItineraryList「在 OpenStreetMap 中查看」），其余 7 处（DayWeatherPanel Attribution×2、DayPoiSourcesPanel×3、WebSourcesPanel×2，均已有 `underline-offset-2`）由 app.css base 层一行恢复规则 `a { text-decoration: underline; }` 统一恢复（独立验收指出 3 处逐处修后同类回归漏 7 处，采纳其最小方案）；(2) Leaflet 归属链接 `a{text-decoration:inherit}` 压掉 UA 下划线（leaflet.css 未分层压不住 preflight）——app.css 增补 `.leaflet-control-attribution a` 恢复规则（地图内部零迁移纪律的边界内修复）。**期间发现并否决了一次假零差异**：内存 transform 注入 preflight 的方案因 @tailwindcss/vite 按磁盘内容编译而静默失效（原始 witness run：transform 命中 1 次但编译产物无 preflight 规则、裸 ul=disc；返修后剥离测试复现机制并重导出真实记录），改为磁盘真实状态两遍跑，确保对比口径成立。结论：preflight 加回成立，无面板布局/交互破坏。

**A 清单终态（hallmark 终审，§3.1 逐条）**：

| # | 终态 | 说明 |
|---|---|---|
| A1 | 已修 | W1-W3 各面板首屏一句 + 说明折叠；W4 shell 入口卡同样单句帮助 + 面板内 role=note 保留 |
| A2 | 已修 | 各波逐条修正（W2 草稿拼接为正常排版核对不改；W3a 候选池空态合并、会话恢复同名核对不改；W3b 离线导出 4→3 条） |
| A3 | 已修 | PanelHeader 口径全量落地：eyebrow（xs/accent-foreground/tracking）+ display 标题 + meta 行 + 状态 badge；站点详情截图核对 5 级强度分明 |
| A4 | 已修 | W3a/W3b 面板一层 border + 凹面底；W4 shell 入口卡/警示条单层描边 |
| A5 | 已修 | W3a 候选池空态收敛；W4 实测空态提示高度 **41px**（≤160px 口径） |
| A6 | 已修 | Button variants 全量：default 主操作/outline、secondary 次/ghost 取消/destructive 危险；disabled 灰底明确 |
| A7 | 已修 | 天气 dd/时间/坐标/金额 mono+tabular-nums（W2 起逐波）；W4 复核天气面板数字排版完好 |
| A8 | 已修（四期 S1：入口名统一为面板标题） | 入口名与面板标题统一：「住宿与抵离锚点」「必去点与预约时间约束」「准备清单」；「候选地点池」原已一致。四期 S1 同步更新测试可访问名，行为零变化。 |
| A9 | 已修 | 说明段落 max-w-[72ch] 全量；W4 实测主线最大段落行盒 1198px 属表单/地图宽元素，说明文字均在 72ch 内 |
| A10 | 已修 | 状态提示统一 Panel 头 badge（天气「已返回」等）；role=status/alert 语义保留 |
| A11 | 已修 | W2 radio/checkbox min-h-6/size-4；W4 实测 4 个 radio 命中区全部 ≥24px 且 label 包裹整行，0 个裸小控件 |
| A12 | 已修（四期 S1：面板收起按钮统一为「收起」） | PanelHeader 骨架统一（eyebrow/title/status/collapse）；面板级收起按钮文案统一为「收起」（DayReplan/MapRefresh/AssistantDialog/Constraints/Checklist/Versions），取消编辑与撤销提示等非收起按钮保持原语义。 |

**四期 S2 深色模式登记**：`src/theme.css` 在 `:root` / `@theme` 之后新增 `.dark` 全套语义覆盖（深暖灰底 + 提亮朱砂，浅色变量一字未改；正文/辅助文字对比度 ≥4.5:1）；`src/lib/theme.ts` + `useTheme.ts` + `components/ThemeToggle.tsx` 提供「跟随系统 / 浅色 / 深色」三态，键名 `travel-assistant:theme:v1`；`index.html` 头部内联同步脚本消除 FOUC。`ui/select.tsx` / `ui/checkbox.tsx` 的 data-URI SVG 走 `dark:` 双值；Leaflet 瓦片保留原图、深色下仅降亮。详见 `docs/THEME.md`。

**四期 S3 时间轴视图登记**：新增 `components/TimelineView.tsx`，行程区改由 `components/ItineraryView.tsx` 承载「列表 / 时间轴」分段切换（默认列表、`aria-pressed`、不持久化）；列表与时间轴共用 `activeStopId` / `onSelectStop` / `poiCards`，切换不改选中站点、零存储写入。时间轴以 `<ol>` 呈现停点顺序，节点可展开讲解、地址、时长、坐标/OSM 链接与资料卡；站间 leg 显示模式、路线类型、距离、时长，缺失时统一「时间未知 / 地址未知 / 时长未知 / 距离未知 / 未提供本段路线信息。」。资料卡摘要抽为共享 `components/StopPoiCard.tsx`，列表既有 DOM 文案 / testid 不变。全部使用 theme.css 语义变量，375 窄屏时间列收窄不横溢。详见 `docs/TIMELINE.md`。

**验证证据**（2026-11-09，Node v22.21.1，四期 S3）：`vitest` 全量 112 文件 / 2351 用例全部通过，0 失败 0 跳过；`npm run typecheck` 通过（check-source-paths OK，210 个 .ts/.tsx）；`npm run build` 通过（dist CSS 68.26 kB / JS 1,343.65 kB，JS 体积警告为既有登记）；`git diff --check` clean。

**四期 S1 收尾口径**：A8/A12 对应入口名与收起按钮已按上表统一；探针已于四期 S1 删除，今后全量不再需要 `--exclude`。四期 S1 起 vitest 全局 `testTimeout=20s`，既有 per-test 标注保留（冗余无害）。

**验证证据**（2026-11-09，Node v22.21.1）：

- `vitest` 全量（当时排除禁触探针 `_indep-probe-0400.test.js`；探针已在四期 S1 删除，现行命令不再需要 `--exclude`）：本波三轮。第一轮 106 文件 / 2291 用例 2290 过（uiPolish token 口径 + CandidatePoolPanel 压测超时，修正后）；第二轮（preflight 加回 + 链接修复后）106 文件 / 2291 用例全部通过；第三轮（终稿复核，注释收尾后）再次 106 文件 / 2291 用例全部通过，0 失败 0 跳过，flake 白名单成员全程全绿，无需隔离复跑。
- `typecheck`：`tsc -b --force` 通过（check-source-paths OK，198 文件）。
- `build`：`vite build` 通过（dist CSS ≈ 63.9 kB / JS ≈ 1332.9 kB；W3b 71.79 kB → 再降 ≈ 7.9 kB，tokens.css 与 shell 旧规则退役，preflight 增量部分抵消）。
- 浏览器证据：dev-stub + Vite dev（挂 `@tailwindcss/vite`）+ 本机 Chromium，全程 loopback 离线、瓦片 mock；截图目录（不进仓库）`C:\Users\86133\AppData\Local\Temp\opencode\p3-w4-shots\`：preflight 前后各 6 张（主线顶部/表单校验/表单提交/skip-link/375 窄屏/1280 全页，pre/post 成对）+ hallmark 终审补充 5 张（站点详情层级/天气结果/候选池空态/命中区/375 复核）+ preflight-diff.json（磁盘两遍跑口径的正面对比记录）/ preflight-impact-raw.json（注入法失效机制的原始记录——返修后以剥离测试忠实重导出，替代此前误拷贝失真文件）/ before-snapshot.json。桌面与窄屏均无横向滚动；Leaflet 地图容器、弹窗、站点圆点正常（地图内部样式零改动，归属链接恢复规则除外）。

**遗留（交接 S7c/S8/S9）**：(1) `.stop-row` 仍为 button+data-testid（W2 登记 role=listitem 改造未做，属行为面改动）；(2) A12 收起文案变体、A8 入口名差异（文案红线，登记待 PM/S9 裁决）；(3) `data-testid="edit-entry"` 等 shell testid 保留（可访问名定位已可用，退役计划随 S9）；(4) JS bundle 1332.9 kB 超 500 kB 警告（代码分割不属 UI 迁移范围，登记不处理）。

**四期 S4 分享卡片登记**：行程视图头部新增「生成分享卡片」入口（`ItineraryView` 可选 `onOpenShare`，未传不渲染，视图本身不耦合分享逻辑），`App` 打开 `ShareCardPanel` 并传当前日 `initialDay`。面板为 `role="dialog"` + `aria-modal="true"` + 固定遮罩 `z-50`，Esc/关闭收起；默认宣纸雅集，原生 select 选天（label「选择日期」），六个 `aria-pressed` 风格按钮（可访问名精确为「宣纸雅集 / 旅行日报 / 老黄历 / 双色印刷海报 / 夜航卡 / 登机牌」）。数据管道 `lib/shareCard.ts` 只取行程名、目的地、第 N 天、当日标题、日期、有序站名（时刻缺失「时间未知」）与 leg 聚合交通摘要（无 leg「交通方式未知」）；六个纯模板共享同一 `ShareCardData`，固定 1080×1440 viewBox，token 集中为六组固定 hex/系统字体栈，不随深浅主题变化；用户文本全量 XML 转义，站名过多自动缩小字号/行距且不截断，同输入两次输出全等。PNG 走 `lib/shareCardPng.ts` 原生 Image + canvas + `toBlob`，零新依赖、失败返回 `unsupported/decode/encode` typed 原因并 revoke Blob URL；下载 helper 安全化文件名（`travel-assistant-share-d<天>-<风格>.svg/png`）。挂载/切天/切风格/关闭零下载零存储写入，只有显式点下载才创建文件。详见 `docs/SHARE_CARD.md`。

**验证证据（2026-11-09，Node v22.21.1，四期 S4）**：`vitest` 全量 115 文件 / 2392 用例全部通过（0 失败 0 跳过；较 S3 的 112/2351 新增 3 文件 41 用例，含六风格确定性/内容/转义/不截断、PNG 光栅化 deps 注入成功与三类失败、面板零写入与 typed PNG 失败、切换预览作废旧 PNG、入口可选渲染）；`npm run typecheck` 通过（check-source-paths OK，217 个 .ts/.tsx）；`npm run build` 通过（dist CSS 69.80 kB / JS 1,375.21 kB，JS 体积警告为既有登记）；`git diff --check` 无空白错误（仅工作区 LF→CRLF 提示）。六风格输出两两不同且同输入两次字符串全等；面板切换天/风格与关闭前后 localStorage 全键 raw 全等，下载仅在显式点击后发生。六风格已用本机 Chrome 实际渲染目检（1080×1440 各一张；另抽查 14 站点密集版宣纸/日报/登机牌三风格验证自动缩放与换行；截图在临时目录 `C:\Users\86133\AppData\Local\Temp\opencode\share-card-visual\`，不进仓库）。

**四期 S5 顺路度提示登记**：新增纯函数 `lib/routeFlow.ts`（`SWAP_IMPROVEMENT_THRESHOLD = 0.10`、`haversineKm`、`analyzeDayRoute`）与只读组件 `components/RouteFlowHint.tsx`。按当日站点原顺序计算 haversine 总路程，枚举 n−1 种相邻交换，取交换后总路程最短者；缩短比例 ≥10% 才提示（边界含等号，并列取最小 1-based 序号）。坐标缺失/非法、站点不足、无改善或全程零距离时整卡不渲染，绝不拿 (0,0) 填充。提示卡无按钮/应用入口，不写任何存储键，不自动改行程；主文案固定「本日路线可优化：第 {index} 站与第 {index+1} 站互换，路程约缩短 {X}%（约 {Y} 公里）。」，百分比与公里均保留 1 位小数，辅助说明明确「不是全局最优路线」。`App.tsx` 在 `ITINERARY_PANE` 内、`ItineraryView` 之前渲染（仅 `currentDay` 存在时），列表与时间轴共用同一提示。样式使用 `--color-warn-bg` / `--color-warn-ink` 语义变量，`min-w-0` + `max-w-[72ch]` + `[overflow-wrap:anywhere]`，深浅主题可读、375 窄屏不横溢。详见 `docs/ROUTE_FLOW.md`。

**四期 S6 资料卡备份与恢复登记**：新增纯数据层 `lib/poiCardBackup.ts`（`POI_CARD_BACKUP_VERSION = 1`、`MAX_POI_CARDS_BACKUP_BYTES = 2 MiB`、`buildPoiCardBackup` / `serializePoiCardBackup` / `parsePoiCardBackup` / `planPoiCardImport` / `poiCardBackupFileName`）与面板 `components/PoiCardBackupPanel.tsx`。入口在 App 行程工具区「资料卡备份与恢复」（`aria-expanded`，不依赖工作区关联，与锚点/约束/清单/候选池互斥展开）。导出只读、零写入，文件仅含 `version` / `exportedAt` / `cards`；导入隐藏文件输入 → 文本解析 → 预览（新增/已存在按 identityKey 分组、默认跳过、覆盖前明示替换 Y 张）→「确认导入」才经父级 `handleSavePoiCards` 写入 `poi-cards:v1`（expectedRaw 冻结门）；取消/关闭/换文件零写入，失败保旧、原字节不动。逐卡校验复用 `validatePoiCardsRecord`，version ≠ 1 不迁移，重复 id / identityKey、超 200 张、超 2 MiB 均 typed 拒绝；全流程零网络、只写一个存储键。详见 `docs/POI_CARD_BACKUP.md`。

**四期 S6 返修登记（2026-11-09 独立验收后）**：导入结果改由面板自己持有——`handleSavePoiCards` 返回本次 `PoiCardsSaveResult`，面板 `await onSave` 后只按本次结果更新导入状态，不再复用资料卡编辑面板的共享 `poiCardsSaveStatus / poiCardsSaveMessage`；关闭 / 卸载后在途结果不复活，PoiCardPanel 既有共享状态行为不变。新增只读 `reloadPoiCards()`（同步冻结 raw 与 record，零写入）：每次显式打开备份面板重读最新库；冲突失败显示「资料卡库已被其它入口更新」并提供「重新载入资料卡库」按钮，清空预览后可在本会话重新选文件导入，无需刷新页面。预览分组计数与覆盖警告改为按当前 `record` + 文件卡片 + 策略 `useMemo` 实时计算，确认使用同一份 plan；库在预览后变化会提示核对。选择文件先检查 `file.size`，超过 2 MiB 直接 typed 拒绝，不再先读完整文件。

**四期 S6 回归返修（2026-11-09 复核后）**：`reloadPoiCards()` 增加「raw 未变且已加载」短路：若 `poiCardsReadRef.current === true` 且 `read.raw === poiCardsRawRef.current`，直接返回，不调用 `setPoiCardsRecord`、不改变任何状态。这样打开备份面板（即使只导出）不会重建 `record` 引用，也不会触发同屏 `PoiCardPanel` 的 `useEffect` 重置未保存编辑；首次加载或外部 raw 真变化时才同步冻结 raw 与 record。组合测试覆盖：raw 未变打开备份面板 → 未保存介绍仍在、零写入；外部 raw 真变化 → 重载同步新库并允许重置表单。

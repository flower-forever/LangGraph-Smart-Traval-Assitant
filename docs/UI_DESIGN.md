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

### 1.1 Tailwind 分层策略（重要）

`app.css` 当前只引入 `theme` + `utilities` 两层，**暂不引入 preflight**：

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
@import "../tokens.css";
@import "./theme.css";
```

原因：preflight 会重置标题字号、段落间距、列表缩进与表单外观，在面板迁移完成前必然改变现有渲染结果，违反 S1「零面板改动」。
**W4 动作**：全局 shell 迁移完成后加回 preflight，并用同口径截图 + computed-style 快照复核。

另一条迁移约束：`app.css` 与各面板 CSS 目前**未分层**，其规则优先级高于 Tailwind utilities。因此每波迁移必须**删除/改写对应面板的旧 CSS**，不能只靠工具类覆盖；否则样式会静默失效。已在映射表与波次口径中登记。

### 1.2 验证证据（S1）

- `vitest`：100 文件 / 2187 用例。两次全量：一次 2187/2187 全绿；一次 1 例超时（`CandidatePoolPanel` 200 条压测，已知 flake），隔离复跑 1.7s 绿。禁触探针 `_indep-probe-0400.test.js` 始终排除、未执行。
- `typecheck`：`tsc -b --force` 通过。
- `build`：`vite build` 通过（dist CSS ≈ 158 kB / gzip ≈ 24 kB）。
- 渲染零变化：28 张面板截图，24 张字节级一致；3 张仅时间戳文本不同（天气/资料/网页查询时间），1 张 8 个像素的亚像素抗锯齿差。310 / 349 个元素的 computed style + 几何快照逐项 diff = 0 差异。
- 截图目录（不进仓库）：`C:\Users\86133\AppData\Local\Temp\opencode\p3-s1-shots\`（`before-*` / `after-*` 成对）。

---

## 2. 设计 tokens

唯一来源仍是 `frontend/tokens.css`（W4 前只读）。`src/theme.css` 只做 **语义变量 + Tailwind 桥接**，不复制类名。

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

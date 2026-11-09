# 主题与深色模式（四期 S2）

> 状态：已实现，待 PM 验收。
> 权威边界：浅色变量以 `frontend/src/theme.css` 的 `:root` / `@theme` 为准（四期 S2 一字未改）；深色只新增 `.dark` 覆盖。
> 代码：`frontend/src/lib/theme.ts`（纯函数 + 存储）、`frontend/src/lib/useTheme.ts`（订阅与落 DOM）、`frontend/src/components/ThemeToggle.tsx`（三态控件）。

## 1. 存储键与取值

- 键名：`travel-assistant:theme:v1`
- 取值：`'system'` | `'light'` | `'dark'`
- 缺失、非法值、读取异常 → `'system'`（不抛错）。
- 只有用户显式点选三态按钮才写入；mount / render / 系统主题变化都不写存储。

## 2. 三态语义

| 偏好 | 含义 | 系统切换时是否跟随 |
|---|---|---|
| `system` | 跟随操作系统 `prefers-color-scheme` | 是 |
| `light` | 强制浅色（宣纸 / 朱砂） | 否 |
| `dark` | 强制深色（深暖灰 / 暗调朱砂） | 否 |

`useTheme()` 返回 `{ preference, resolvedTheme, setPreference }`。`resolvedTheme` 是最终落地的 `'light' | 'dark'`；`setPreference` 是唯一写存储入口。

## 3. FOUC 防闪脚本

`frontend/index.html` 的 `<head>` 内、任何样式/模块脚本之前有一段同步内联脚本：

1. 读 `travel-assistant:theme:v1`；
2. 显式 `dark` → 立即给 `<html>` 加 `dark` 并设 `colorScheme='dark'`；
3. 非 `light` 且 `matchMedia('(prefers-color-scheme: dark)')` 命中 → 同上；
4. `try/catch` 静默，不引模块、不发网络请求。localStorage 读取与 matchMedia 判断各自独立 try/catch：存储被禁（读取抛错）时按 `null` 继续判断系统主题，系统深色仍能在首帧上 `dark`。

`<meta name="theme-color">` 初始值保持浅色 `#f5f2ea`；React 挂载后由 `applyThemeToDocument` 按实际主题更新为 `#1c1a17` / `#f5f2ea`。

## 4. 深色色板与对比度口径

色板与浅色同源：暖灰纸底（hue 85）+ 朱砂（hue 30）。深色下：

| 角色 | `.dark` 值 |
|---|---|
| background | `oklch(21% 0.012 85)` |
| foreground | `oklch(91% 0.012 85)` |
| card / popover | `oklch(24.5% 0.012 85)` |
| secondary / muted | `oklch(27.5% 0.014 85)` |
| primary（提亮） | `oklch(65% 0.15 30)` |
| primary-foreground（深墨） | `oklch(19% 0.01 85)` |
| accent（暗朱砂底） | `oklch(31% 0.05 30)` |
| accent-foreground（朱砂文字 / focus） | `oklch(74% 0.12 30)` |
| destructive（提亮） | `oklch(69% 0.19 27)` |
| faint | `oklch(68% 0.012 85)` |
| shadow-1 / shadow-2 | 黑色 55% / 60% 不透明度（深底加深） |

对比度用 WCAG 相对亮度实算（sRGB / gamma 编码后），关键组合：

| 前景 / 底色 | 对比度 |
|---|---|
| foreground / background | 13.6:1 |
| foreground / card | 12.4:1 |
| muted-foreground / background | 7.4:1 |
| muted-foreground / card / secondary / accent / warn-bg | 6.8 / 6.2 / 5.6 / 5.7:1 |
| faint / background / card / secondary / warn-bg | 6.2 / 5.6 / 5.2 / 4.7:1 |
| accent-foreground / background / card / accent | 7.3 / 6.7 / 5.6:1 |
| destructive / card / background | 5.4 / 5.9:1 |
| destructive 文字 / destructive-10% 叠加卡面 | 4.7:1 |
| color-ok 文字 / color-ok-10% 叠加卡面 | 5.4:1 |
| primary-foreground / primary | 5.3:1 |
| destructive-foreground / destructive | 6.5:1 |

正文与辅助文字（含 faint）在所有实际底色上均 ≥4.5:1。浅色对比度契约仍由 `src/__tests__/uiPolish.test.ts` 盯住（token 解析取第一条浅色值，不受 `.dark` 影响）。

## 5. select / checkbox 的双 SVG 处理

`ui/select.tsx` 与 `ui/checkbox.tsx` 的箭头/勾选是背景 data-URI，`stroke` 无法引用 CSS 变量。四期 S2 保留浅色 SVG 原样，新增深色 SVG，用 `dark:` 变体切换：

| 组件 | 浅色 stroke | 深色 stroke | 深色近似依据 |
|---|---|---|---|
| Select 箭头 | `#405640` | `#c8c4ba` | `.dark --secondary-foreground` |
| Checkbox 勾 | `#faf6ea` | `#16140f` | `.dark --primary-foreground` |

深色未选中态用 `dark:bg-none` 隐藏勾图（避免深墨勾叠在深 card 上约 1.13:1 的极淡噪点），仅 `dark:checked` 显示深色勾；浅色 class 原样保留。`AlertDescription` 浅色保持 `text-current/85`，深色改为 `dark:text-current`（不透明），避免 destructive / success 描述被 85% 透明度压到 3.0 / 4.3:1。

为让 `dark:` 跟随类而非仅系统偏好，`src/app.css` 顶部声明了 Tailwind v4 自定义变体：

```css
@custom-variant dark (&:where(.dark, .dark *));
```

构建产物已核对：`.dark` 块存在，`dark:bg-[url(...)]` 编译为 `...:where(.dark,.dark *)`，且在源顺序上位于浅色规则之后。

范围边界：`src/lib/offlineTripHtml.ts` 里的十六进制色是「离线行程 HTML 导出」这一自包含浅色文档的内联样式（脱离 App 主题体系单独打开），不属于面板内联硬编码，四期 S2 未改。

## 6. Leaflet 地图

决定：**保留原图，深色下降亮**。`.dark .leaflet-tile-pane { filter: brightness(.82) contrast(1.02) saturate(.9); }` 只作用于瓦片图片层，不动 marker / 弹窗 / 交互层；浅色不加任何 filter。地图归属链接深色下提亮为 `#8ec9ea`（浅色保持 `#0078a8`）。

## 7. 跨平台字体差异

字体栈未改：display 楷体（Kaiti SC / STKaiti / KaiTi / Noto Serif SC / Songti SC / SimSun），正文苹方 / 微软雅黑 / 冬青黑 / Noto Sans SC。Windows 上楷体与雅黑的实际字形、行高和 macOS 不同，深色只改颜色变量，不引入字体或字号变化，因此跨平台差异与浅色一致。

## 8. 验证

- `node node_modules/vitest/vitest.mjs run`：110 文件 / 2333 用例全绿（含新增 `theme.test.ts` 17、`ThemeToggle.test.tsx` 7、`AppThemeIntegration.test.tsx` 4、`themeContrast.test.ts` 14）。
- `npm run typecheck`、`npm run build` 通过；dist CSS 中 `.dark` 与 `dark:` 变体均已生成。
- 新测试全程 mock `matchMedia`、无网络；`localStorage` 除主题键外零写入断言覆盖组件级与 App 级。

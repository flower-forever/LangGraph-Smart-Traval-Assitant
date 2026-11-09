# 行程分享卡片（四期 S4）

## 入口与结构

行程视图头部右侧新增「生成分享卡片」按钮（`ItineraryView` 的可选 `onOpenShare`，由 `App` 传入打开回调）。点击后挂载 `ShareCardPanel`：

- 弹层为 `role="dialog"`、`aria-modal="true"`、`aria-labelledby` 指向标题「生成分享卡片」；固定遮罩 `z-50`，Esc 或「关闭」收起。
- 默认天 = 打开时的当前日（`initialDay`），默认风格 = 宣纸雅集。
- 天选择用原生 `select`（label「选择日期」，选项 `D1 · 标题`）；风格选择为六个 `aria-pressed` 按钮，可访问名精确等于风格名。
- 预览内联渲染 `renderShareCard` 生成的 SVG，容器 `data-testid="share-card-preview"`，内层 `data-style` 标记当前风格；按 1080×1440 比例缩放。
- 操作只有「下载 SVG」「下载 PNG」「关闭」。切换天/风格只更新预览，不产生下载或写入。

## 六风格

| id | 名称 | 方向 |
|---|---|---|
| `xuanzhi` | 宣纸雅集（默认） | 米白宣纸底、朱砂双线框与闲章、楷体标题、竖排感留白 |
| `daily` | 旅行日报 | 报纸刊头、宋体大标题、细线分栏、右上日期刊号、站点如今日要闻 |
| `almanac` | 老黄历 | 日期大字居中、朱红双框、「宜：出行 / 忌：犹豫」趣味位、站点清单 |
| `riso` | 双色印刷海报 | 墨绿/橘红撞色、粗黑站名与编号、固定点阵噪点、底部交通色带 |
| `midnight` | 夜航卡 | 深墨底、暖金细线与航线节点、米白文字、固定星点 |
| `boarding` | 登机牌 | 等宽数字、打孔缺口、虚线撕裂线、右侧票根、条形码与「出发 → 抵达」印章位 |

六风格共享同一份 `ShareCardData`，各自是 `shareCard.ts` 内的纯模板函数；配色与字体栈集中在该文件的 `STYLE_TOKENS` 常量，**不随 App 深浅主题变化**。六套构图、底色、字体与装饰均不同，字符串输出两两不等。

## 数据管道与确定性

`buildShareCardData(trip, day)` 只取以下字段：

- `tripTitle` ← `trip.title`；`destination` ← `trip.destination`。
- `dayNumber` / `dayTitle` / `date` ← `day`。
- `stops` ← `day.stops` 原顺序；`time` 经 `displayTime` 折叠秒，空/缺失显示「时间未知」。
- `transportSummary` ← `day.legs` 按 mode 计数，固定顺序「步行 N 段 · 驾车 M 段」；无 leg 显示「交通方式未知」。只统计实际存在的 leg，不按站点数推算。

`renderShareCard(style, data)` 返回完整 SVG 字符串（`<svg xmlns=... viewBox="0 0 1080 1440">`）。确定性约束：

- 不使用 `Date.now` / `Math.random` / `Intl`；噪点、星点、条形码均由固定公式或固定种子生成。
- 日期只做字符串展示，不做时区换算；缺失显示「日期未知」。
- 同输入两次渲染字符串全等（测试逐风格断言）。
- 站名过长自动换行；站点过多时逐级缩小字号与行距（`layoutStops`），不截断站名文字。
- 所有用户文本经 XML 转义（`& < > " '`）并移除 XML 非法控制字符；站名含特殊字符也不会破坏 SVG。

## 内容红线

卡片只含：行程名、目的地、第 N 天、当日标题、日期、有序站名（带时间窗）、交通方式摘要、底部「由 旅行助手 生成」。刻意不含：

- 坐标（经纬度）、地图/路线几何；
- 门票价格、费用数字；
- 网页来源原文、资料卡内容、未核实链接；
- 任何 localStorage / sessionStorage 键名或键值；
- 「已预订」「已确认」「已出票」等状态词；未知一律显示「未知」或「交通方式未知 / 时间未知 / 日期未知」。

## SVG / PNG 管线与零依赖

- SVG：`lib/shareCard.ts` 纯字符串生成。下载时 `lib/shareCardFile.ts` 自动补 XML 声明，Blob 类型 `image/svg+xml;charset=utf-8`。
- PNG：`lib/shareCardPng.ts` 用原生 `Image` + `<canvas>` 光栅化：SVG → Blob URL → `Image.onload` → 1080×1440 canvas → `drawImage` → `toBlob('image/png')`。未引入 html2canvas 或任何新依赖。
- `rasterizeShareCardPng` 返回 `{ ok: true, blob }` 或 `{ ok: false, reason: 'unsupported' | 'decode' | 'encode' }`；特性检测失败返回 `unsupported`，不抛异常；无论成功失败都 `revokeObjectURL`。
- 面板对失败显示固定 typed 文案（当前浏览器不支持 / 解码失败 / 编码失败），按钮不崩溃，建议改下载 SVG。
- 测试可注入 `createImage` / `createCanvas` 与 `rasterize`，不依赖 jsdom 的 canvas 实现。

## 字体栈与跨平台差异

所有文本使用系统字体栈：

- 楷体：`KaiTi / STKaiti / Kaiti SC / Noto Serif SC`；
- 宋体/衬线：`Songti SC / SimSun / Noto Serif SC / Source Han Serif SC`；
- 黑体：`Microsoft YaHei / PingFang SC / Noto Sans SC`；
- 粗黑展示：`Arial Black / Microsoft YaHei / PingFang SC`；
- 等宽：`Cascadia Mono / Consolas / SFMono-Regular / Menlo`。

不同操作系统缺少某款字体时由下一档回退；字形宽度与换行位置可能略有差异，属于预期。内容、字号层级与确定性不受影响。

## PNG 环境限制

- 需要浏览器支持 `canvas.toBlob`、`URL.createObjectURL` 与 SVG 图像解码；任一缺失时只提供 SVG 下载。
- 预览使用内联 SVG，不依赖 canvas；即使 PNG 不可用，六风格预览仍正常。
- 光栅化在本地完成，不上传、不触网；图片中的字体按当前系统渲染后再栅格化。

## 零写入与显式点击

- 挂载、切换天、切换风格、预览、按 Esc、点「关闭」都不创建 Blob、不触发下载、不写任何存储。
- 只有点「下载 SVG」或「下载 PNG」才创建文件；PNG 生成中按钮 `disabled` + `aria-busy`。
- 关闭会作废尚未完成的 PNG 生成（序号守卫），关闭后不会再触发下载；切换天/风格同样作废旧图，预览变化不会下载上一张卡。
- 面板不修改 `Trip`，不自动保存，不影响地图、日签、天气、预算等其它功能（只读预览）。

## 文件名规则

`shareCardFileName(dayNumber, style, format)` 固定格式：

```text
travel-assistant-share-d<天>-<风格 id>.svg
travel-assistant-share-d<天>-<风格 id>.png
```

`safeShareCardFileName` 会移除路径分隔符、控制字符与 Windows 非法字符（`\ / : * ? " < > |`），压缩空白与连续连字符，限制长度并保留扩展名。下载后移除 `<a>`，Blob URL 延迟 1 秒回收（Firefox 同步回收会取消下载）。

## 测试

- `frontend/src/__tests__/shareCard.test.ts`：数据管道（时刻缺失、交通聚合、固定顺序）、六风格确定性与内容、日期未知、特殊字符转义 + `DOMParser` 可解析、六风格两两不同、大量站名不截断、坐标/门票/存储键零出现。
- `frontend/src/__tests__/ShareCardPanel.test.tsx`：默认宣纸雅集 + `initialDay`、六风格按钮可访问名与 `aria-pressed`、切天/切风格零下载零写入、localStorage 全键 raw 全等、下载 SVG 一次、关闭/Esc 零下载、PNG `unsupported/decode/encode` typed 文案、生成中 `aria-busy`、切换预览作废旧 PNG、PNG 成功路径。
- `frontend/src/__tests__/shareCardPng.test.ts`：通过 deps 注入假 Image / canvas，覆盖 `unsupported`（缺 URL API）、`decode`、`encode`、成功 Blob 与 Blob URL 回收；文件名固定格式与路径/控制/Windows 非法字符清理。
- `frontend/src/__tests__/ItineraryView.test.tsx`：入口按 `onOpenShare` 可选渲染，点击只回调分享入口，不影响选中站点。

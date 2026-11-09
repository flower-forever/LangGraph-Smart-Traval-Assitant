# 资料卡备份与恢复（本地 JSON）v1

日期：2026-11-09。四期 S6 切片。基线 `feat/interactive-travel-planner`。设计基线
`docs/UI_DESIGN.md`；资料卡数据契约见 `docs/POI_CARDS.md`。

## 这是什么

把 `poiCards:v1` 资料卡库导出为一份本地 JSON 文件，或从这类文件恢复。
**导出只读、导入先预览、确认才写入**；写入仍走 `savePoiCardsRecord` 的
`expectedRaw` 冻结门。备份文件只含卡片数据，不含工作区 / 候选库 / 版本库 /
行程 / 费用内容。

明确不做：云同步、自动备份、自动导入、跨版本自动迁移、图片内嵌（图片仍只有 URL）。

## 文件格式（`frontend/src/lib/poiCardBackup.ts`）

```json
{
  "version": 1,
  "exportedAt": "2026-11-09T08:53:20.000Z",
  "cards": [ /* PoiCardV1[]，字段与 docs/POI_CARDS.md 完全一致 */ ]
}
```

| 项 | 值 |
|---|---|
| 结构版本 | `POI_CARD_BACKUP_VERSION = 1`（只认数字 1；字符串 `"1"` 也不接受） |
| 导出时刻 | ISO 8601 UTC；只代表文件自述的时间。读取时缺失 / 非字符串按未知（空串）处理，不影响卡片导入 |
| 卡片上限 | `MAX_POI_CARDS_COUNT = 200` |
| 原始文本上限 | `MAX_POI_CARDS_BACKUP_BYTES = 2 MiB`（UTF-8 字节；超过不解析） |
| 文件名 | `travel-assistant-poi-cards-YYYY-MM-DD.json`（日期取 UTC，与 exportedAt 日期一致） |
| 卡片顺序 | 与资料卡库一致（导出不排序） |

`buildPoiCardBackup(record, now)` 深拷贝卡片，不修改入参；`serializePoiCardBackup`
使用 `JSON.stringify`，同一输入得到同一字符串。

## 解析与校验（`parsePoiCardBackup`）

顺序固定，任一步失败都**不返回部分卡片**：

1. 原始文本 UTF-8 字节 > 2 MiB → `too_large`（不 JSON.parse）。
2. JSON 解析失败 / 顶层不是对象 → `invalid_json`。
3. `version !== 1` → `unknown_version`：明确提示不兼容，**不自动迁移**。
4. `cards` 不是数组或超过 200 张 → `invalid_cards`。
5. 逐卡复用 `validatePoiCardsRecord`（单卡记录包装）——字段、长度、图片、
   provenance、identityKey 与存储校验**同一口径**，不放宽。失败消息指出
   「第 N 张」与字段路径，不回显卡片名称等原文。
6. 文件内部重复：同 `id` 或同 `identityKey` → `duplicate`，消息指出第几张，
   不回显原始 id。

失败时资料卡库与原存储字节都不动（面板不写、父级不保存）。

## 合并计划（`planPoiCardImport`）

按 `identityKey`（名称+地址归一化，与卡片库唯一性口径一致）把文件卡片分成：

- **新增**：`identityKey` 不在现有库；
- **已存在**：`identityKey` 已在现有库。

两种策略：

| 策略 | 现有卡 | 已存在的文件卡 | 新增卡 |
|---|---|---|---|
| `skip`（默认） | 全部保留 | **跳过**（保留本地版本） | 追加 |
| `overwrite` | 除同键外保留 | **替换**（用文件版本） | 追加 |

结果必须通过 `validatePoiCardsRecord` 且不超过整库 `MAX_POI_CARDS_BYTES`；
`updatedAt` 取调用方传入的 `now`。失败类型：

- `id_conflict`：文件卡与现有**其它**卡同 id 但地点不同、文件内部 id 重复，
  或合并后会产生重复 id；
- `invalid`：卡片字段不合法、文件内部 identityKey 重复、超过张数 / 体积上限等。

失败不返回半成品记录，存储保持原样。

## 面板（`frontend/src/components/PoiCardBackupPanel.tsx`）

- 入口：App 行程工具区「资料卡备份与恢复」按钮（`aria-expanded`），不依赖工作区关联；
  打开时收起锚点 / 约束 / 清单 / 候选池面板，反之亦然。**每次显式打开都会调用
  只读的 `reloadPoiCards()`**，同步最新 `record` 与冻结 raw，不要求刷新页面。
  raw 未变且已加载时直接返回，不重建 `record` 引用——同屏 `PoiCardPanel` 的
  未保存表单编辑不会被重置；只有首次加载或 raw 真变化才同步。
- 头部：「资料卡备份与恢复」+「收起」+ 说明「导出为本地 JSON；导入先预览，
  确认后才写入资料卡库。」
- 导出区：显示当前卡数；「导出资料卡备份」→ `build` + `serialize` + Blob 下载。
  库为 `null`（不可用 / 未读取）时禁用并说明。导出零写入。
- 导入区：隐藏的 `<input type="file" accept="application/json,.json">` +
  「选择备份文件」按钮。选择文件后**先检查 `file.size`**：超过 2 MiB 直接 typed
  拒绝，不调用 `file.text()` / `FileReader` 读取。未超限才读取文本 → 解析；
  失败显示 typed 错误并保持旧库；成功显示预览：
  - 「文件《name》：共 N 张；新增 X 张 / 已存在 Y 张」；
  - 「新增」「已存在」两组名称清单（按 identityKey 判定）；
  - 策略单选，默认「跳过已存在（保留本地版本）」；
  - 选「覆盖已存在（用文件版本替换本地）」时明示
    「覆盖将替换已存在的 Y 张卡；其它卡保持不变。确认前不会写入。」
  - 「确认导入」/「取消导入」；确认才调用 `onSave(plan.record)`。
  - 分组计数与覆盖警告由 `useMemo` 按**当前 `record` + 文件卡片 + 策略**实时
    计算；确认时使用同一份 plan。预览之后库发生变化会显示「资料卡库已更新，
    请核对…」，计数与覆盖数量同步刷新。
- **导入结果归面板自己**：面板 `await onSave(record)`，只按本次返回的
  `PoiCardsSaveResult` 更新 `saving / saved / error`，不读取父级资料卡编辑面板
  共享的 `poiCardsSaveStatus / poiCardsSaveMessage`。别处保存成功 / 失败不会
  清空导入预览，也不会被误报成导入成功 / 失败。
- 取消 / 关闭 / 换文件清空预览，零写入。保存中禁用「选择备份文件」「确认导入」
  「取消导入」；保存失败保留预览并显示本次失败原因（原字节未动）；保存成功后
  清空预览并提示「已导入 N 张卡（新增 X / 覆盖 Y / 跳过 Z）」。关闭 / 卸载后
  在途保存结果不会在重新打开时复活。
- 样式使用 theme.css 语义变量（`bg-card` / `bg-background` / `--color-warn-*` /
  `--color-faint`），深浅主题可读；375 宽度下两组清单改为纵向，不横溢。

## 存储与冲突（App 接线）

- 面板自身**不读不写** localStorage，也不发网络请求；唯一写入路径是
  `onSave` → `App.handleSavePoiCards` → `savePoiCardsRecord`。
- `handleSavePoiCards` 用 `poiCardsRawRef` 冻结 raw 做 `expectedRaw` 比对，并
  返回本次 `PoiCardsSaveResult`。预览之后另一处更新了 `poi-cards:v1`，确认导入
  会返回 `conflict`，**不写入**，原字节保持外部更新后的内容。
- 冲突后面板显示「资料卡库已被其它入口更新」并提供**「重新载入资料卡库」**
  按钮：调用只读的 `reloadPoiCards()`（重新 `loadPoiCardsRecord`，同步
  `poiCardsRawRef` 与 `poiCardsRecord`，不写任何键）并清空旧预览；用户重新
  选择文件即可用新的冻结 raw 再次预览、确认。整个过程无需刷新页面。
- `reloadPoiCards()` 的读取口径：空存储 → 合法空记录；corrupt /
  unknown_version / unavailable → `record = null`；空白串按 empty 口径把冻结
  raw 归一到 `null`，与 `savePoiCardsRecord` 的比对口径一致。**raw 未变且已加载
  时短路返回，不调用 `setPoiCardsRecord`、不改变任何状态**；只有首次加载或 raw
  真变化才同步 `poiCardsRawRef` 与 `poiCardsRecord`。`unavailable` 的 raw 同为
  `null`，不视为「已加载的空库」；存储恢复后再次打开面板会重新读取并显示空库。
  本函数零写入。
- 成功才更新 `poiCardsRecord` 与冻结 raw；只写 `travel-assistant:poi-cards:v1`
  一个键，工作区 / 候选库 / 版本库 / 主题等其它键逐字节不变（测试断言）。

## 文案红线

不出现「已预订 / 已确认 / 已出票」；未知 / 未读取显示「未知」或明确的不可用
说明，不假装空库；覆盖后果在确认前明示。

## 测试

| 文件 | 覆盖 |
|---|---|
| `__tests__/poiCardBackup.test.ts` | build 只读与深拷贝 / exportedAt / serialize-parse 往返 / 版本 / 坏 JSON / 字段 / 重复 id 与 identityKey / 体积上限 / skip-overwrite / id_conflict / 结果校验 |
| `__tests__/PoiCardBackupPanel.test.tsx` | 导出一次下载且零写入 / 预览计数与名称 / 策略文案 / 取消零写入 / 三分支确认导入 / 导入失败展示 / 坏文件与版本不兼容 / 超大 `file.size` 读取前拒绝 / 冲突后重新载入并再次导入 / 预览后外部保存成功与失败不串状态 / 库变化后计数与覆盖警告实时更新且确认用最新 plan / 关闭重开与在途保存结果不复活 / 其它键 raw 不变 |
| `__tests__/AppPoiCardBackupIntegration.test.tsx` | 入口 aria-expanded / 真实写入 `poi-cards:v1` / 打开面板重读最新库（空存储 → 空记录、corrupt → null，均零写入）/ 其它键 raw 不变 / 外部改动后 expectedRaw 冲突拒绝且原字节不动 / 冲突后重新载入并重新导入成功 / raw 未变时打开备份面板保留同屏资料卡未保存编辑且零写入 / 外部 raw 真变化后重载同步新库并允许重置表单 / 存储不可用恢复后重新读取空库 |

验证口径：`cd frontend; node node_modules/vitest/vitest.mjs run` 全量全绿；
`npm run typecheck`、`npm run build`、`git diff --check` 通过。

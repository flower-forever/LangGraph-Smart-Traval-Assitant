# 费用草稿文件备份与导入

日期：2026-11-01。对应分支 `feat/interactive-travel-planner`，前置基线 `8c63714a`（CI 41244304202 success）。

## 这是什么

费用估算面板内新增「费用文件备份与导入」子区域（默认收起）：把当前费用草稿下载成一份独立的 `.budget.json` 备份文件；之后选择这份文件、预览、确认替换，恢复费用草稿。它与行程 JSON 备份（`travel-assistant.trip`）是两个独立文件，互不通用。

费用草稿只在本页内存里，刷新会丢失——本功能提供的是「显式备份 / 显式恢复」，不是自动保存。

## 文件协议

新独立 JSON envelope，与行程备份格式互不相认：

```json
{
  "format": "travel-assistant.budget",
  "version": 1,
  "currency": "CNY",
  "trip": { "id": "…", "title": "…" },
  "draft": {
    "budgetRaw": "5000",
    "rows": [{ "id": "r1", "category": "transport", "name": "高铁票", "amountRaw": "128.50" }]
  }
}
```

- `trip` 只记录导出时的自述（id 与 title），为 `null` 表示草稿还没有绑定行程版本。**它不是身份或来源证明**：即使 id 与标题和当前行程相同，也不能证明这份文件真的来自当前行程；界面明确写「只是文件里的记录，不能证明它真的来自这份行程」。
- `draft` 是原字符串草稿：金额是用户输入或此前确认导入的记录，空、`0`、未完 / 非法金额（如 `abc`、`12.345`、`-5`）都原样保留，不补 0、不丢数据、不因金额非法拒绝备份。数字计算仍走 `tripBudget.ts` 的既有规则（未填不当 0、无效单独列出）。
- 字段只投影已知项：`trip` 只有 id/title，行只有 id/category/name/amountRaw。session 内部的 `owner.tripSnapshot` / `revision` / `undo` / `result` 与任何未知 extra 都不进文件。
- 同一草稿确定性输出：不写导出时间、不读时钟，两次生成逐字节相同。

## 校验与上限

- 文件 / 文本 UTF-8 总上限固定 **256 KiB**：生成后按编码字节门禁；读文件前按 `File.size` 门禁（size 缺失 / 异常一律保守拒绝，不发起无界读取）；字节路径读后按实字节复核（BOM 也算进去）。读取的 `maxBytes` 配置只能收紧（有限正整数 ≤ 256 KiB），非法配置是独立的固定错误，不伪装成用户文件过大，也不能绕过固定 cap。
- 行数沿用预算的 32 项上限；33 行拒绝。
- 解析顺序固定：体积 → JSON 语法（容忍一个前导 UTF-8 BOM）→ format → version（只认数字 1，字符串 `'1'` 不匹配）→ currency（只认 CNY）→ 结构（trip 自述、draft、行 id 非空白唯一、字段类型严格）。
- 解码合同：读文件优先字节路径（`File.arrayBuffer` / `FileReader.readAsArrayBuffer`）+ `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`：坏编码固定错误、不静默替换；BOM 不在解码层吞掉，原样交给解析层「最多剥一个」——单 BOM 允许、双 BOM 拒绝。**字节接口存在但读取失败时固定 `read_error`，不降级到文本路径**——一次失败的严格字节读取不会被悄悄换成宿主解码的文本（BOM 被吞 / 坏编码被静默替换）；仅当字节接口本来不可用才允许 `File.text` / `readAsText` 兼容路径，该路径的解码合同由宿主决定，未在真实浏览器实测。
- 全部失败给固定文案，不回显文件内容、不露原始异常。
- 可计算性与备份合法性解耦：算不出合计的草稿照样能备份 / 导入；预览摘要用既有 `computeBudgetSummary` 只做只读提醒。

## 导出

- 展开 / 挂载 / 行程变化都不生成文件或 Blob URL；点「预览费用备份」才纯函数生成 JSON，显示只读纯文本与条数 / 已知合计 / 无效与未填提醒。
- 点「下载费用备份 (.budget.json)」把**同一份**已预览 JSON 交给浏览器，不在下载时重新生成。文件名固定 `.budget.json` 后缀，形如 `budget-标题-id.budget.json`，净化路径分隔符、Windows 非法字符与保留名前缀；**预览标题展示的文件名与实际下载同名**（同一个安全净化函数，来自导出自述 owner）。
- 导出预览绑定生成时实际费用 owner 全指纹（id / revision / 内容快照 / 标题）与费用输入快照：任何费用、owner 或归属变化，旧导出预览立即作废且不复活（渲染期守卫 + effect 永久清理，A→B→A 也不复活）；计算本身未改输入时预览保持。
- 允许备份旧 owner 草稿救回输入：备份自述写原行程标题，不冒充当前行程。
- 下载 adapter 沿已修 Markdown 模式：Blob 构造 / anchor 属性 / appendChild / click / 调度全部受控，失败固定文案并清理 URL 与 DOM；点击成功后延迟 1000ms 幂等回收，调度失败用默认 setTimeout 兜底；成功只说「已发起浏览器下载」，不保证落盘；失败保留合法预览可重试。

## 导入与确认

- 文件输入只接受 json；读前 size 门禁，取内容顺序字节路径 →（仅字节接口本来不可用时）File.text → FileReader。**选择 / 解析只产生本地预览**：不改费用 session、不写 Storage、不下载、不发请求。
- 文件读取用「序号 + 选择时 ctx 指纹 + 卸载」三重守卫：ctx 指纹与渲染期同步更新的 ref 比较（不等 effect），读取晚回时目标变了就不落地；Trip / revision / 内容 / 可验证性切换（含不可验证→可验证）也让在途读取与导入候选全部作废，不出提示、不动当前费用；选新文件先清旧候选与 pending；收起 / 放弃使在途读取与候选全部作废；失败保原费用。
- 预览显示文件自述的行程、当前应用目标、费用条目与原字符串、合法合计、未填与无效项提醒；全部 React 文本节点，无 HTML / Markdown 渲染。
- 空草稿（无条目且预算未填）是合法文件：预览明确「确认替换会把当前费用清空」。
- 应用走**内联两步确认**（无 alert / confirm 弹窗）：点「替换当前费用草稿」先显示替换前后条数 / 预算与当前目标，再点「确认替换费用」才生效。
- 确认绑定当前 Trip id + revision + 内容快照、候选内容指纹、当前费用 owner 全指纹与费用输入快照：确认期间任何一项变化（含沿用 / 换文件）立即作废 pending（渲染期同步守卫 + effect 永久清理），A→B→A 不复活旧确认。行程目标变化的旧导入预览同样渲染期隐藏 + effect 永久清理，不自动留成新目标的预览，A→B→A 不复活。无法验证当前 Trip 内容快照时只能查看，应用按钮禁用。
- 行程目标变化的旧导入预览只能失效 / 重新预览（目标变化后已永久清理），不自动套到新 Trip；文件自述 metadata 不能直接当 owner。
- 应用只改费用 session：用既有 `createBudgetForTrip` 建立当前 owner，再替换已验证的 rows / budgetRaw，result 清空；undo 保存应用前的当前 session（一层 owner / rows / budgetRaw，不递归）。`tripBudget.ts` 本身未改。撤销可恢复替换前费用；若恢复的是旧 owner，继续走既有只读守卫。

## 边界

- 取消 / 收起 / 放弃预览只丢面板内存里的预览，App 里的费用草稿不丢。
- 无自动文件读取 / 下载 / 存储：不新增 localStorage、不发网络、不接后端、不动 Trip v1 与原 JSON/MD/ICS 导出。
- 宿主原「都是你自己填的」口径已改为「你输入或此前确认导入的记录，不是任何服务提供者的报价；实际花费没有经过核实」——文件里的记录同样没有核实过来源。

## 文件

| 文件 | 内容 |
| --- | --- |
| `frontend/src/lib/tripBudgetTransfer.ts` | 纯函数：envelope 投影 / 生成 / 解析 / 摘要 / 应用 / 文件名 |
| `frontend/src/lib/tripBudgetFile.ts` | 浏览器侧：下载 adapter（同已修 Markdown 模式）与文件读取 |
| `frontend/src/components/TripBudgetTransfer.tsx` | 子面板：预览 / 下载 / 导入确认与并发守卫 |
| `frontend/src/components/tripBudgetTransfer.css` | `.tbt-` 局部样式（宣纸 / 朱砂 tokens） |
| `frontend/src/components/TripBudgetPanel.tsx` | 仅挂载子区域、透传 props、来源与备份说明 |
| `frontend/src/__tests__/tripBudgetTransfer.test.ts` | 纯函数测试（34 项） |
| `frontend/src/__tests__/tripBudgetFile.test.ts` | adapter 测试（24 项） |
| `frontend/src/__tests__/TripBudgetTransferPanel.test.tsx` | 面板 DOM 测试（36 项；原 `TripBudgetTransfer.test.tsx`，为消除与纯函数测试的大小写折叠冲突更名为此，见 `docs/FRONTEND_TYPECHECK.md`） |
| `frontend/src/__tests__/AppBudgetTransferIntegration.test.tsx` | App 接线集成测试（7 项） |

文档同步：本文件、`docs/TRIP_BUDGET.md`（来源口径与内存说明）、`docs/ROADMAP.md`（阶段 E 小批）、`README.md`（功能表与边界段）。App.tsx、tripBudget.ts、旧 helpers / 夹具 / 后端 / API / schema / 依赖均未改动。

## 未做与局限

- 未做真实浏览器验收；完整前端 suite 与 CI 结果以推送后的实际运行为准。
- 不做持久化：备份文件由用户自己保存与携带，本工具不读目录、不自动恢复。
- 不校验备份文件的真实来源：metadata 只是自述，应用与否由用户审阅后决定。

# 离线随身行程页（单文件 HTML）v1

> 状态：**F6 renderer 已实现并通过目标单测；尚未接入 `App.tsx`，因此不称为已发布。**
> 2026-11-06 修复轮已补 `constraintId` 精确关联提示与运行期引用 / epoch 门；
> 仍待非作者定向复验，未提交、未接入 App，也不宣称整门 PASS。
> 本文描述当前仓库里的实际文件与边界，不把计划里的拟新增文件当成已存在。
>
> 适用基线：`F:/MunderDifflin/Travel-Assistant/LangGraph-Smart-Traval-Assitant`，
> 契约见 `docs/WORKSPACE_SIDECAR.md`；运行期引用门见其 §5.1.1。

---

## 1. 交付文件

| 文件 | 作用 |
|---|---|
| `frontend/src/lib/offlineTripHtml.ts` | 纯函数：校验 `WorkspaceRecordV1`、投影内容、转义、生成单文件 HTML、UTF-8 上限门禁 |
| `frontend/src/components/OfflineTripPanel.tsx` | 受控面板：显式预览（sandbox iframe / srcdoc）、显式下载（Blob + 延迟 revoke）、变化作废 |
| `frontend/src/components/OfflineTripPanel.css` | 面板样式（取 `tokens.css`，不新增全局样式） |
| `frontend/src/__tests__/offlineTripHtml.test.ts` | 生成器 / 转义 / 离线安全 / fail-closed 测试 |
| `frontend/src/__tests__/OfflineTripPanel.test.tsx` | 预览 / 下载 / 作废 / revoke / 失败路径测试 |
| `docs/OFFLINE_TRIP.md` | 本文 |

> 与计划 §7 的命名差异：本批任务的白名单使用 `OfflineTripPanel.*` 与
> `docs/OFFLINE_TRIP.md`；计划里的 `OfflineTripExportPanel.*` /
> `offlineTripHtmlFile.ts` / `docs/OFFLINE_TRIP_HTML.md` 没有创建。
> 浏览器下载封装放在 `OfflineTripPanel.tsx` 内（`downloadOfflineTripHtml`），
> 生成器仍然保持纯函数。

**未修改**：`App.tsx`、`e2e/runner.mjs`、`workspace*.ts`、storage、API、全局样式、
`backend/**`。没有派子 agent，没有 Git 写操作。

---

## 2. 输入契约

组件接收 `record`，并可选接收父级运行期 `epoch`：

```tsx
<OfflineTripPanel record={currentWorkspaceRecord} epoch={workspaceEpoch} />
```

- `record` 类型是 `WorkspaceRecordV1`（当前完整、已应用方案）。
- `epoch` 类型是可选的非负安全整数，表示父级运行期版本。缺省 `0` 只用于兼容尚未接入
  的旧调用方；App 集成后必须传入并在用户编辑、采用、撤销、导入、切换工作区 / 候选 /
  版本、外部 storage 变化时推进。**组件不会自动推进 epoch**。
- 预览会捕获实际 `record` / `trip` / `sidecar` / `budget` 对象引用、safe epoch、内容快照
  和运行期版本号；任一项变化都会作废旧预览，详见 §5 与
  `docs/WORKSPACE_SIDECAR.md` §5.1.1。
- 组件**不读** `localStorage`、不读会话恢复 raw、不读候选库 / 版本库，也不写任何存储。
- `App` integrator 只需传入当前有效记录与 epoch；接入由 UI integrator 串行完成，本批
  不碰 `App.tsx`。
- 生成器内部仍会重新执行 `validateWorkspaceRecord`，即使调用方传入 `as WorkspaceRecordV1`
  也不会绕过校验。
- 显式传入非法 epoch（负数、小数、NaN、超出安全整数）时，预览按 fail-closed 拒绝，
  不生成 HTML、不建 Blob URL。

---

## 3. 页面内容

生成物是一份可双击打开、可打印的静态 HTML：

1. **头部**：行程标题、目的地、天数、导出页生成时间、固定诚实提示。
2. **数据来源与导出范围**：工作区 ID、行程 ID、label、revision、记录更新时间、
   行程 `source` 自述、明确「不含候选库 / 版本库 / 会话恢复 / 存储原文 / 密钥」。
3. **住宿与抵离锚点**：住宿名称 / 地址 / 入住退房日期 / 坐标与坐标来源；
   到达、离开的机场 / 车站信息；明确「按记录展示，未核实」。
4. **每日行程**：按 `trip.days` 与 `trip.stops` 的**记录顺序**展示：
   - 当天起点 / 终点锚点（引用 stop 或手工锚点、时间、地址、坐标、酒店实体 ID）；
   - 站点序号、名称、记录时间、停留时长、地址、坐标、描述；
   - 当天绑定的 `must_visit` / `fixed_window` / `reminder`；
   - 当天路段交通摘要：方式、路线类型、记录距离、记录耗时、说明。
5. **未绑定到具体天数的约束**：`day=null` 或目标天不在当前行程中的约束。
6. **出行准备清单**：`已准备 / 未准备`、分类、日期 / 天 / 关联站点、备注；
   明确「已准备只表示勾选过，不代表下单成功、出票或商家受理」。
   - `constraintId` 与当前 `sidecar.constraints.items` 的 `id` **精确匹配**时，显示
     「关联预约：<标题>（ID：…）」；只按 ID 对应，不做同名 / 同日期 / 同站点认领。
   - `constraintId` 指向的预约已不在当前行程时，保留任务与 `done` 状态，显示
     「需重新关联：关联预约已不在当前行程（原关联 ID：…）」，不自动改绑其他预约。
   - 旧 v1 缺少 `constraintId` 属性、或用户显式设为 `null` 的条目，都按普通清单项
     展示；不补关联、不提示为损坏，也不会被同日期 / 同站点的预约自动认领。
7. **已知费用**：手工预算原文、逐项金额与状态、已知合计、分类小计、预算比较；
   未填写 / 无法解析的项目不按 0 元计。
8. **记录内 warnings**。
9. **页脚**：数据来源、导出页生成时间、分享提醒。

页面**不**包含：候选库条目、版本库快照、在途候选、`KEY_SESSION_DATA` 原文、
任何 API key / token、本地存储键或 raw 字节。

---

## 4. unknown 与 0

| 字段 | 输出 |
|---|---|
| `duration_minutes: null` | 「未知（不是 0 分钟）」 |
| `duration_minutes: 0` | 「0 分钟」 |
| `distance_m: null` | 「未知（不是 0 米）」 |
| `distance_m: 0` | 「0 米」 |
| `location: null` | 「坐标未知（记录没有填写；不补 0）」 |
| 真实坐标 `lng: 0` / `lat: 0` | 按 0 显示（0 是合法坐标，不是未知哨兵） |
| `budget: null` | 「明确没有预算数据（不等于 0 元）」 |
| 预算项 `amountRaw: ''` | 「未填写（未知，不按 0 元计）」 |
| 预算项 `amountRaw: '0'` | 已知 0，计入合计并显示 `0.00` |
| 预算项无法解析 | 「无法解析（未知，不按 0 元计）」 |
| `checkInDate` / `time` 等为 null | 「日期未知 / 时间未知 / 未填写」 |

金额计算复用 `tripBudget.computeBudgetSummary` 的十进制字符串精确算法；
未知项不进入合计，也不补 0。

---

## 5. 预览与下载生命周期

1. **挂载不生成**：不生成 HTML、不建 Blob URL、不点击下载、不联网、不写存储。
2. **显式预览**：用户点「预览离线行程页」后：
   - 组件取一次 `Date.now()` 作为 `exportedAt`；
   - 调 `tripToOfflineHtml(record, { exportedAt })`；
   - 成功后在 `sandbox=""` 的 iframe `srcdoc` 中展示；
   - 失败显示固定错误，不产生 iframe / 下载按钮。
3. **显式下载**：预览后才出现「下载离线页 (.html)」：
   - 只把预览保存的同一份 `html` 交给 `downloadOfflineTripHtml`；
   - 下载时不重新生成，`exportedAt` 不改写；
   - 创建一次 Blob URL、点击一次 anchor，约 1 秒后延迟 `revokeObjectURL`；
   - 失败保留预览，可重试。
4. **运行期引用 / epoch 门（C1）**：
   - 预览时用 `captureWorkspaceRuntime(record, epoch)` 捕获实际 `record` / `trip` /
     `sidecar` / `budget` 引用与 safe epoch；同时保存 `canonicalJson` 内容快照和组件内
     运行期版本号。
   - 渲染期同时检查：`workspaceRuntimeRefsMatch`（引用 + epoch）、内容快照、运行期版本号。
     任一不符 → 旧预览立即不展示；effect 清除旧预览状态，`A→B→A` 不会复活。
   - **同内容换新引用**（例如父级返回新对象但字段相同）也会作废；不能以内容相等豁免
     引用门。
   - epoch `A→B→A` 即使回到同一个数值，只要中间观察过变化，旧预览也不复活。
   - 下载前再次核对同一组引用 / epoch / 快照 / 版本号；失配则拒绝下载并显示
     「请重新预览后再下载」的可见提示，同时保持 0 Blob URL、0 下载点击。
   - 失效提示会保留到用户重新预览 / 放弃预览或下一次上下文变化；不会被同一提交里的
     清理 effect 立即抹掉。
   - 父级必须在用户编辑、采用、撤销、导入、切换工作区 / 候选 / 版本、外部 storage
     变化时推进 epoch；helper 不会自动推进。契约见
     `docs/WORKSPACE_SIDECAR.md` §5.1.1。
5. **下载时间语义**：页面内 `exportedAt` 是**预览生成时刻**；下载复用同一份字节，
   不会在下载时改时间。页面文案明确写出这一点。

---

## 6. 安全模型

### 6.1 转义

- 所有用户文本（标题、名称、地址、备注、描述、约束、清单、warnings、ID、来源）
  统一经过 `escapeHtml`：`& < > " '` 全部转成实体；控制字符转成可见 `U+XXXX`。
- 页面**不嵌入 JSON**、不输出 `<script>`，因此没有 `</script>` / JSON-script
  逃逸面；不依赖「替换少量字符」的假安全。
- 不把用户文本放进属性；没有动态 `href` / `src` / `style`。用户文本里的网址只作为
  纯文本显示，不生成可点击链接，也不产生 `javascript:` / `data:` 危险 href。

### 6.2 离线

- 生成物没有任何远程脚本、字体、图片、地图瓦片、`@import`、`url()` 或 `http(s)://`
  资源引用。
- 生成物带 `Content-Security-Policy` meta：
  `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`。
- 页面无 JS、无 Service Worker 注册、无自动网络请求。
- 预览 iframe 使用 `sandbox=""` + `referrerPolicy="no-referrer"`，不执行脚本、
  不加载外部资源。

### 6.3 fail closed

- 完整 `WorkspaceRecordV1` 先走严格 validator（未知字段 / 重复 ID / NaN /
  超限 / Trip 结构）。
- validator 可能因循环引用或异常 getter 抛错时，生成器 try/catch 后按
  `invalid_record` 拒绝。
- 输出超过默认 4 MiB（或调用方收紧的上限）→ `too_large`，不返回半截 HTML。
- 失败不写存储、不改输入、不产生 Blob URL；组件保留当前工作区并显示固定文案。
- Trip 上夹带的额外字段（例如秘密字符串、候选数组）不会被投影进页面。

---

## 7. 上限

| 项 | 值 |
|---|---|
| 默认 HTML 输出上限 | `MAX_OFFLINE_TRIP_HTML_BYTES` = 4 MiB（UTF-8 实际字节） |
| 自定义上限 | 只允许正数且不超过 4 MiB；非法配置 `bad_limit` |
| 工作区记录 | 由 `validateWorkspaceRecord` 遵守 2 MiB / sidecar 512 KiB / Trip 640 KiB |
| 导出时间 | 必须是有效、可显示的正安全整数 epoch ms；否则 `bad_exported_at` |

容量是最大允许，不是浏览器配额保证。

---

## 8. 测试与验证

本批实跑（2026-11-06 修复轮）：

```text
pnpm exec vitest run \
  --config <Temp>/vitest-ts-first.config.mjs \
  src/__tests__/offlineTripHtml.test.ts src/__tests__/OfflineTripPanel.test.tsx --no-cache
→ 2 files / 36 tests passed（15 + 21；旧 28 项保留）
```

当前工作树验证注意：仓库里存在未跟踪的 `frontend/src/**/*.js` 文件（不是本批写权文件，
本批未修改 / 删除 / 暂存它们；来源未由本批确认）。Vite 默认解析顺序是 `.js` 先于 `.ts`，
所以默认 `vitest` 命令可能命中这些编译产物，而不是本批修改的 `.ts/.tsx`。本次定向测试
使用仅位于 Temp 的配置，把 `resolve.extensions` 调整为 `.ts/.tsx` 优先，确保测试实际
覆盖本批 TypeScript 源；该配置不写入仓库。若这些 `.js` 被移除或仓库后续调整了解析顺序，
普通 `vitest run` 才会直接命中 `.ts`。本次使用的配置等价于：

```js
export default {
  root: '<repo>/frontend',
  resolve: { extensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.json'] },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: './src/test/setup.ts',
    css: false,
  },
}
```

```text
pnpm check:source-paths
→ OK（扫描数量以当次命令输出为准；本文不硬编码浮动总数）
```

目标 TypeScript noEmit（显式文件，含测试与 setup；可复现范围）：

```text
pnpm exec tsc --noEmit --strict --jsx react-jsx --module esnext --moduleResolution bundler \
  --target es2022 --lib "es2022,dom,dom.iterable" --skipLibCheck --types vite/client \
  --allowImportingTsExtensions --verbatimModuleSyntax --noUnusedLocals --noUnusedParameters \
  --noFallthroughCasesInSwitch --pretty false \
  src/test/setup.ts src/lib/offlineTripHtml.ts src/components/OfflineTripPanel.tsx \
  src/__tests__/offlineTripHtml.test.ts src/__tests__/OfflineTripPanel.test.tsx
→ 通过（无输出）
```

这个命令只编译 F6 的 2 个源文件 + 2 个测试 + setup 及其**实际被 import 的传递依赖**；
它不跑 `tsc -b`、不写 `tsbuildinfo`、不生成 JS。它不是整 App 类型检查：其它 owner 的
在途文件（当前工作树中的 `workspaceTransfer.ts` / `workspaceStorage.ts` 等）不在这个
范围内。如果这些传递依赖被改动后出现新错误，应按依赖 WIP 处理，不能据此宣称 F6 或
整 App 已绿。

**未跑**：完整前端 suite、`pnpm build`、E2E、真实 browser `file://` 验收、backend pytest。
这些由整合 owner / 浏览器 owner 在后续统一场景跑；本批不冒充已跑。

测试覆盖的真实攻击面：

- 名称 / 地址 / 备注 / 来源 / 清单中的 `< > & " '`、`</script><img onerror>`、
  `javascript:`、`data:text/html`、嵌套未知字段；
- 循环引用、NaN、重复 stop id、顶层 / sidecar 污染；
- 离线文档 DOM 无 script / img / svg / iframe / object / embed / link / base / form，
  无 `src` / `href` / `on*` 属性，无 `@import` / `url()` / `http(s)://`；
- 合法 0 与未知在预算、交通、坐标、时间上的区分；
- 清单 `constraintId`：有效 ID 精确关联、dangling 保留任务 / `done` 并提示需重新关联、
  旧版缺省与显式 `null` 不被同名 / 同日期 / 同站点预约认领；
- 预览 / 下载同一份字节、显式点击、延迟 revoke、变化作废、失败保留预览；
- 同内容换 `record` 引用、单层 `trip` / `sidecar` / `budget` 引用变化、epoch
  `A→B→A` 都作废旧预览；失效下载拒绝时提示可见且仍为 0 Blob / 0 click；
- 不读写 storage、不发请求、不读时钟。

---

## 9. 所需 App 集成

由 UI integrator 串行完成，本批不碰 `App.tsx`：

```tsx
import OfflineTripPanel from './components/OfflineTripPanel'

// record 必须是当前完整、有效的 WorkspaceRecordV1
// epoch 必须是父级单调、非负安全整数；不要用内容 hash 或 Date.now() 冒充
<OfflineTripPanel record={currentWorkspaceRecord} epoch={workspaceEpoch} />
```

集成注意：

1. **epoch 归属父级**：`workspaceEpoch` 由 App / workspace controller 持有并单调推进；
   组件不会自动推进。至少在这些事件后推进并传入新值：
   - 用户编辑任何工作区字段；
   - 采用 / 应用候选、撤销、导入 / 恢复；
   - 切换工作区、候选或版本；
   - 外部 storage 变化（例如 `storage` 事件或恢复流程）；
   - 任何产生新 `record` / `trip` / `sidecar` / `budget` 引用的 transition。
   即使内容 A→B→A 恢复相同，也要推进；旧预览 / 旧 pending 不得复用。
2. 不要把 `localStorage.getItem` 或 raw JSON 直接传给组件；先走 workspace 读取 /
   validator，得到 `WorkspaceRecordV1`。
3. 组件不会写回工作区；它只是只读导出入口。
4. 若当前没有有效工作区记录，不要渲染组件或由 integrator 给明确空态；不要传半条
   sidecar、候选库、版本库或会话恢复 payload。
5. 运行期引用门的契约见 `docs/WORKSPACE_SIDECAR.md` §5.1.1；`captureWorkspaceRuntime` /
   `workspaceRuntimeRefsMatch` 只做引用 + safe epoch 检查，不会自动推进 epoch。
6. e2e 场景接入由 W-E2E owner 负责；本批没有改 `runner.mjs`。

---

## 10. 明确未做 / 限制

- 未接入 `App.tsx`，所以用户还不能在应用里点到这个面板；不称已发布。
- 未跑真实 browser `file://` / E2E；只做了 jsdom 目标测试。
- 不做 PDF / 复杂分页，只提供最小 `@media print` / `@page` 样式。
- 不自动把纯文本网址变成链接；如需可点击外链，必须由后续显式设计并保证离线加载。
- `WorkspaceRecordV1` 不携带 POI 来源 URL / 抓取时间；页面只能展示记录自述的
  `trip.source`、住宿 `locationSource` 与坐标/地址记录值，不能补造外部来源。
- 不导出候选库 / 版本库 / 会话恢复数据 / 密钥 / 存储 raw。
- 不做 Service Worker，也不把整个应用做成离线应用。
- F5 清单模块现在是本页的**实际模块依赖**：`offlineTripHtml.ts` 从
  `frontend/src/lib/checklist.ts` 引入已独立验收的公开入口
  `checklistItemConstraintState` 与 `auditChecklistLinks`，用于区分
  `unrecorded / unlinked / linked` 并识别 dangling `constraintId`。本页仍然只读
  `sidecar.checklist`，不写回、不改 F5；如果冻结树没有这批 F5 公开入口，本模块无法
  编译，不能把它说成无依赖。
- 清单里没有条目时仍显示空态；旧 v1 缺省 `constraintId` 与显式 `null` 不补关联。

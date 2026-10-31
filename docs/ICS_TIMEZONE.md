# ICS 导出的显式目的地时区

日期：2026-10-31。对应分支 `feat/interactive-travel-planner`，前置基线 `b017a62`。

## 这是什么

日历导出（`.ics`）原有两种时间语义之外新增第三种可选模式：用户显式选择一个目的地
IANA 时区后，行程中的当地日期/时刻被唯一解析为 UTC，以带 `Z` 后缀的
`DTSTART`/`DTEND`（RFC 5545 §3.3.5 UTC 格式）写入事件文件。

三种模式：

| 模式 | 触发条件 | 输出 | 导入端行为 |
| --- | --- | --- | --- |
| floating（默认） | 不选时区 | `DTSTART:20260403T090000`（无 Z、无 TZID） | 按导入设备的本地时区解释这个裸钟面，不同设备时区会解释成不同瞬间 |
| 目的地时区 | 选择有效 IANA 时区 | `DTSTART:20260403T010000Z`（UTC 固定瞬间） | 任意设备显示为该设备本地时间，同一瞬间不漂移 |
| 拒绝导出 | 无效/不支持的时区 | 无文件 | UI 显示明确错误，不静默回退；「拒绝」是选项错误的处理方式，不是第三种导出结果 |

不写 `TZID` 参数，也不生成 `VTIMEZONE` 组件：这两者需要完整的时区规则数据，
不完整引用在真实日历客户端上是比 floating 更差的失败模式。UTC 时刻是
RFC 5545 定义完备、客户端无需时区库即可正确解释的形式。

## 用户可见行为

- 导出面板新增「目的地时区（可选）」：少量常用 IANA 预设 + 自定义输入框（有独立
  可访问 label）。默认值为空 = floating 模式，旧行为完全不变；帮助文案实时显示
  当前生效的时区，清空自定义输入即回到默认模式。
- 设置仅本次导出会话有效：不写入 Trip、不写 localStorage/Storage、不发请求；
  换行程时组件随 `key={ics:${trip.id}}` 重新挂载，设置自动重置，不泄漏到另一行程。
- 无效时区（不是当前运行环境 ICU/tzdata 支持的 IANA 名称）是明确的选项错误：
  预览给出错误文案、下载按钮消失、`downloadIcs` 返回 `invalid_timezone`，
  不创建 Blob URL，绝不静默回退 floating。该判定由导出结果里的独立元数据
  `configurationError: { code: 'invalid_timezone', message }` 承载，与行程内容解耦：
  空行程、全缺日期、零站点同样报 `invalid_timezone`，不会误报成 `no_events`；
  该错误不进入 `skipped`/站点计数，不构造 day=0/空 stopId 的占位跳过记录，
  所以空行程时 `skippedCount` 为 0，有真实站点时跳过数不超过真实站点数。
- DST 边界：当地时刻在所选时区中「不存在」（春季拨快跳过）或「出现两次」（秋季
  回拨重复）时，站点按 `time_not_representable` 结构化跳过，跳过清单给出可见原因
  （重复时刻会列出全部候选 UTC），不会自动选第一个/第二个解，也不会挪动时间。
  `time_not_representable` 同时涵盖 UTC 年份超范围（该类站点的 UTC 瞬间是唯一的），
  面板总提示只按结构化 reason 给中性说明（不解析站点文案做分类），
  具体原因（夏令时切换 vs 超出 4 位年份）完整保留在跳过清单与 notices 里逐站可见；
  零事件时的总提示也区分「站点被时区语义拒绝」与「站点缺少合法日期或开始时刻」。
- 年份边界按 UTC 判定：当地分量合法但换算出的 UTC 落在 1000..9999 之外
  （如 9999-12-31 纽约晚间的 UTC 已是 10000 年、1000-01-01 上海 00:00 的 UTC
  在 999 年）时按 `time_not_representable` 拒绝，不写出 5 位年份的非法 ICS；
  有无停留时长不影响该判定。注意 999 年在这里是因为本工具的导出按 4 位年份
  （1000..9999）输出，999 超出该支持范围；这不是 RFC 5545 本身禁止三位数年份
  （RFC 要求 4 位以上年份格式，10000 年及以上的五位年份才是格式错误）。
- 有效停留时长（1..1440 整数分钟）表示实际经过时间，直接从已解析的 UTC 开始
  时刻加，得到带 Z 的 DTEND；未知/非法停留仍只写 DTSTART，与旧模式一致。

## 面向用户的解释口径

- UTC 表示的是「固定瞬间」：文件里的 `01:00Z` 在上海显示为 09:00、在纽约显示为
  前一晚 20:00（冬令时），是同一瞬间。相比之下 floating 模式写的是裸钟面
  （无时区标注），导入端按各自设备时区解释，同一个文件在两地显示的是不同瞬间。
- 日历客户端按设备自己的时区显示这一固定瞬间，所以同一文件在不同设备上显示的
  钟面数字不同，这是符合预期的（变化的是显示，不是瞬间本身）。
- 该实现经过完整的往返一致性测试与多种 DST 样例验证，但未在真实日历客户端
  （iOS/Google/Outlook）上逐个验收；导入后请抽查第一场事件的时间。

## 实现要点

### frontend/src/lib/icsTimezone.ts（新增，纯转换模块）

- 唯一的时间来源是 `Intl.DateTimeFormat` 的显式 `timeZone` 参数；locale 固定
  `en-US`，`calendar: 'gregory'`、`numberingSystem: 'latn'`、`hourCycle: 'h23'`
  显式指定，保证 `formatToParts` 字段跨环境稳定。全程不经过机器本地时区的
  Date 解析路径。
- `resolveZonedLocalToUtc` 的算法：对目标当地时刻取 ±1 天的实测偏移确定候选
  范围，再对窗口内所有不同偏移段（二分枚举，防御上限 8 段）逐一生成候选 UTC，
  每个候选都做「UTC 反查当地墙上时间 === 输入」的严格往返校验：
  - 恰好 1 个候选通过 → `unique`；
  - 多个候选通过 → `ambiguous`（DST 重复，列出全部候选）；
  - 0 个候选通过 → `nonexistent`（DST 空档或日历上不存在的日期）。
  该枚举保证覆盖「±1 天窗口内所有实际出现的偏移段」：二分找切换边界假设相邻
  切换间隔远大于 1ms（tzdb 偏移为整秒、真实时区 48 小时窗口内至多两三次切换），
  该假设被上述真实样例与多进程测试验证；极端构造数据落到保守的 `nonexistent`
  拒绝而不是错误输出。
- 不假设 DST 切换恰好一小时：偏移按秒对齐（`Intl` 粒度），Lord Howe 的半小时
  切换、查塔姆标准偏移本身带 45 分钟（+12:45，非 DST 幅度）、Apia 2011 年跨日跳变
  都靠同一机制处理。
- `isSupportedIanaTimeZone` 是时区有效性的唯一权威判断（构造
  `Intl.DateTimeFormat` 试构造），UI 层不做任何猜测或别名推断。
- 不依赖 calendar.ts，也不被 calendar.ts 之外的模块依赖，无运行时循环导入。

### frontend/src/lib/calendar.ts（修改）

- `IcsExportOptions.timeZone?: string`；空白/缺省 = floating，行为逐字节兼容。
- `IcsExportResult.exportTimeZone: string | null` 与 `configurationError?:
  { code: 'invalid_timezone', message: string }` 向后兼容扩展；`IcsSkipReason`
  新增 `timezone_invalid`、`time_not_representable`。无效时区时导出级错误只写在
  `configurationError` 元数据里；有可遍历站点时仍逐站点记录 `timezone_invalid`
  跳过（真实计数），空行程/零站点不补占位跳过记录，事件数为 0，notices 给出
  时区名与修正建议。
- UID 输入保持 (tripId, 当地日期, 当地开始时刻, stopId, 重复序号)，与导出模式
  无关：同一事件在 floating 与时区模式下 UID 相同。
- 无效时区时全部可遍历站点跳过（`timezone_invalid`），事件数为 0，notices 给出
  时区名与修正建议；导出级错误同时以 `configurationError` 元数据给出。
- 零事件时的总提示区分原因：站点被 DST/年份范围拒绝时说明「无法按当前时区
  设置表示」，不误报为缺少日期或时刻。

### frontend/src/lib/icsFile.ts（修改）

- `downloadIcs` 现在把 `timeZone` 显式转发给 `tripToIcs`（此前只转发
  `now`/`firstDate`），保证预览与下载文件逐字节一致。
- `downloadIcs` 优先按 `configurationError.code === 'invalid_timezone'` 判定
  （与有无站点/日期无关），返回 `{ ok: false, reason: 'invalid_timezone' }`
  而非难懂的 `no_events`，不创建 Blob URL。
- 有站点时的 `timezone_invalid` 逐站记录与缺日期等真实 skip 各自保留，
  `skipped` 只包含真实站点（day/stopId 都是真实值）。
- `createIcsArtifact` 本就透传完整 options，时区选项自动生效。

### frontend/src/components/IcsExportPanel.tsx（修改）

- 时区选择 UI 复用既有 `ics-date-field`/`field-label`/`field-input`/`field-help`/
  `field-error` 样式类，未新增 CSS。
- 无效时区时下载按钮隐藏（`canDownload` 同时检查 `eventCount > 0` 与无
  `configurationError`），错误文案经 `role="alert"` 可见。
- `time_not_representable` 的总提示是中性口径：只按结构化 reason
  （`entry.reason === 'time_not_representable'`）计数，不解析站点 message 文案；
  DST（重复/不存在时刻）与 UTC 年份超范围的具体原因在跳过清单与 notices 里逐站可见。

## 测试覆盖

`icsTimezone.test.ts`（26）、`calendar.test.ts` 新增 17 个时区用例（总 55）、
`icsFile.test.ts` 新增 4 个（总 13）、`IcsExport.test.tsx` 新增 8 个面板用例
（总 13）。关键样例：

- 上海 2026-11-01 09:00 → `01:00Z`（任务基准样例）；
- 纽约夏 -4 / 冬 -5 同一当地时刻不同 UTC；
- 加德满都 +5:45、查塔姆 +12:45 非整小时偏移；
- 纽约 2026-03-08 02:30 不存在、2026-11-01 01:30 重复（两个候选 UTC 均列出）；
- Lord Howe 半小时 DST 空档（2026-10-04 02:15）与夏令时常规时刻（+11）；
- Apia 2011-12-30 跨日跳变（整日不存在）与跳变前时刻（当时 -10）；
- UTC 跨午夜/跨年、无效时区拒绝（含空行程 skippedCount=0 不虚构占位站点、
  真站点与 configurationError 并存回归）、年份边界
  （9999 年末 UTC 10000 年、1000 年初 UTC 999 年，两分支拒绝；999 年是超出
  本工具 1000..9999 输出范围，不是 RFC 禁止三位数年份）、默认兼容、
  UID 跨模式稳定、输入不可变、无 fetch/Storage 副作用、预览与下载转发同一时区；
- 面板层：自定义输入 label 可达、「自定义…」哨兵项不改变状态、预设↔自定义真实
  切换与清空修正、无效时区不出现下载按钮、DST 与年份越界两类
  `time_not_representable` 都验证中性总提示 + 跳过清单里的具体逐站原因；
- 超出 Date TimeClip 范围（±8.64e15 ms）的 epoch 返回 null 而非抛 RangeError。
- 纯模块与 calendar 层测试在 `TZ=UTC`、`TZ=America/Los_Angeles`、
  `TZ=Pacific/Kiritimati`（UTC+14）三种进程时区下结果一致（显式 timeZone 不受
  设备时区影响）。

## 已知限制

- 时区名经过 trim 后使用；名称匹配与 ICU 一致（IANA 名称大小写不敏感，`asia/shanghai`
  与 `Asia/Shanghai` 等价，测试已锁定）。
- 预设列表是写死的少量常用值；自定义输入是权威入口，不做城市名/中文时区名
  猜测。
- 未做真实日历客户端验收（本阶段范围外）；RFC 5545 §3.3.5/§3.6.5 合规性基于
  既有实现审计与新增测试，非客户端实测。

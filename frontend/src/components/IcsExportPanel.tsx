import { useId, useMemo, useRef, useState } from 'react'
import type { Trip } from '../lib/api'
import { parseIcsDate, tripDateCoverage, tripToIcs } from '../lib/calendar'
import { downloadIcs, safeIcsFilename } from '../lib/icsFile'
import { isSupportedIanaTimeZone } from '../lib/icsTimezone'

export interface IcsExportPanelProps {
  trip: Trip
}

type NoticeTone = 'ok' | 'warn' | 'error'

interface Notice {
  tone: NoticeTone
  text: string
}

/**
 * 少量清楚标注的常用时区选项（括号内 UTC 偏移是标准时基线，仅供参考，不做换算依据）。
 * 换算一律由用户显式选择的 IANA 名称 + Intl 运行时完成，不根据城市/浏览器/模型猜。
 */
const TIMEZONE_PRESETS: Array<{ value: string; label: string }> = [
  { value: '', label: '默认（不指定时区，floating 本地时间）' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai（中国标准时间 UTC+8）' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo（日本标准时间 UTC+9）' },
  { value: 'Europe/London', label: 'Europe/London（英国 UTC+0/+1）' },
  { value: 'Europe/Paris', label: 'Europe/Paris（中欧 UTC+1/+2）' },
  { value: 'America/New_York', label: 'America/New_York（美东 UTC-5/-4）' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles（美西 UTC-8/-7）' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney（澳东 UTC+10/+11）' },
]

const isPresetZone = (value: string): boolean =>
  TIMEZONE_PRESETS.some((preset) => preset.value === value)

/**
 * 显式日历导出入口。
 *
 * - 只有点「下载 .ics 文件」才生成并下载文件；页面加载、恢复、保存都不会自动导出；
 * - 没有任何有效事件时不创建 Blob URL、不触发下载；
 * - 整份行程都缺日期时，必须由用户明确选首日才按天序号临时推算；默认值为空，
 *   不修改 trip、不自动保存，选择的日期也不会被写回原行程；
 * - 部分日期缺失时只跳过并说明，不按编号补日期，也不覆盖已有真实日期；
 * - 目的地时区仅本次导出会话有效：不预填、不存储，换行程时组件随 trip.id 重新挂载而重置。
 */
export default function IcsExportPanel({ trip }: IcsExportPanelProps) {
  const [open, setOpen] = useState(false)
  /** 绝不预填：只有用户自己选了首日才会推算临时日期 */
  const [firstDate, setFirstDate] = useState('')
  /** 用户显式选择的目的地 IANA 时区；空串 = 不指定时区（floating） */
  const [timeZone, setTimeZone] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  /** 哨兵值：select 用它表示「当前是非预设的自定义值」，真实状态始终在 timeZone 里 */
  const CUSTOM_SENTINEL = '__custom__'

  const panelId = useId()
  const headingId = useId()
  const dateId = useId()
  const dateHelpId = useId()
  const scopeId = useId()
  const zoneSelectId = useId()
  const zoneCustomId = useId()
  const zoneCustomLabelId = useId()
  const zoneHelpId = useId()
  const customInputRef = useRef<HTMLInputElement>(null)

  const coverage = useMemo(() => tripDateCoverage(trip), [trip])
  const parsedFirstDate = firstDate ? parseIcsDate(firstDate) : null
  const needsFirstDate = coverage.needsFirstDate
  const effectiveFirstDate = needsFirstDate && parsedFirstDate ? firstDate : undefined
  const trimmedZone = timeZone.trim()
  const zoneSupported = trimmedZone === '' || isSupportedIanaTimeZone(trimmedZone)
  // 只有非空白且运行时支持的时区才传入导出；空白即 floating。无效时区传原始输入，
  // 让 calendar 层产生 timezone_invalid 跳过与可见错误，而不是在 UI 层静默忽略。
  const effectiveTimeZone = trimmedZone === '' ? undefined : trimmedZone
  const preview = useMemo(
    () => tripToIcs(trip, { firstDate: effectiveFirstDate, timeZone: effectiveTimeZone }),
    [trip, effectiveFirstDate, effectiveTimeZone],
  )
  const filename = useMemo(() => safeIcsFilename(trip), [trip])
  const dateInvalid = firstDate !== '' && parsedFirstDate === null
  const zoneInvalid = !zoneSupported
  // 导出级配置错误（无效时区）直接由 calendar 层元数据给出，与站点计数无关；
  // time_not_representable 只按结构化 reason 给中性总提示，
  // 具体原因（DST 重复/不存在时刻、UTC 年份超范围）完整保留在跳过清单与 notices
  const configurationInvalid = preview.configurationError?.code === 'invalid_timezone'
  const notRepresentableCount = preview.skipped.filter(
    (entry) => entry.reason === 'time_not_representable',
  ).length
  const canDownload = preview.eventCount > 0 && !configurationInvalid
  const isExample = trip.source === 'example'

  const handleToggle = () => {
    setOpen((prev) => !prev)
    setNotice(null)
  }

  const handleDownload = () => {
    const outcome = downloadIcs(trip, { firstDate: effectiveFirstDate, timeZone: effectiveTimeZone })
    if (outcome.ok) {
      setNotice({
        tone: 'ok',
        text:
          `已开始下载 ${outcome.filename}（${outcome.result.eventCount} 个事件）。` +
          '文件只保存在本机，不会上传，也不会修改或自动保存这份行程。' +
          (isExample ? ' 事件标题带【示例】前缀。' : ''),
      })
      return
    }
    if (outcome.reason === 'no_events') {
      setNotice({
        tone: 'warn',
        text: needsFirstDate
          ? '还没有可导出的事件：请先选择行程首日，再按天序号临时推算日期。'
          : '这次没有可导出的有效事件，因此没有下载任何文件。',
      })
      return
    }
    if (configurationInvalid) {
      setNotice({
        tone: 'error',
        text:
          preview.configurationError?.message ??
          '导出时区无效或当前环境不支持，未创建任何日历事件，也没有下载文件。请修正时区或改回默认模式。',
      })
      return
    }
    if (outcome.reason === 'unsupported' || outcome.reason === 'error') {
      setNotice({ tone: 'error', text: outcome.message })
    }
  }

  return (
    <div className="ics-area" role="region" aria-label="导出日历">
      <div className="ics-toolbar">
        <button
          type="button"
          className="btn ics-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          aria-describedby={scopeId}
          onClick={handleToggle}
        >
          导出日历 (.ics)
        </button>
        <span className="ics-scope-note" id={scopeId}>
          显式下载到你自己的电脑，不上传、不同步
        </span>
      </div>

      {open && (
        <section className="ics-panel" id={panelId} aria-labelledby={headingId}>
          <div className="ics-panel-head">
            <h3 className="ics-panel-title" id={headingId}>导出到日历</h3>
            <p className="ics-panel-note">
              生成一个标准的 .ics 文件，由本机浏览器下载后手动导入日历。
              不会上传、不会修改或自动保存这份行程。
            </p>
          </div>

          {isExample && (
            <p className="ics-example-note">
              示例行程：导出的事件标题会带【示例】前缀，描述里注明未含真实预约。
            </p>
          )}

          <p className="ics-summary" role="status">
            {preview.eventCount > 0
              ? `可导出 ${preview.eventCount} 个日历事件${preview.skippedCount > 0 ? `，跳过 ${preview.skippedCount} 个站点` : ''}。`
              : needsFirstDate && parsedFirstDate === null
                ? '还没有选择首日，暂时不会生成任何日历事件。'
                : '没有可导出的有效事件，因此不会生成下载文件。'}
          </p>

          <div className="ics-date-field">
            <label className="field-label" htmlFor={zoneSelectId}>
              目的地时区（可选）
            </label>
            <select
              id={zoneSelectId}
              className="field-input"
              value={isPresetZone(trimmedZone) || trimmedZone === '' ? timeZone : CUSTOM_SENTINEL}
              onChange={(event) => {
                const next = event.target.value
                if (next !== CUSTOM_SENTINEL) {
                  setTimeZone(next)
                } else {
                  // 「自定义…」哨兵项本身不携带值：选中后聚焦输入框，
                  // 当前实际生效的设置仍显示在动态 option 与输入框里，不冒充已选定
                  customInputRef.current?.focus()
                }
                setNotice(null)
              }}
              aria-describedby={zoneHelpId}
            >
              {TIMEZONE_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            {trimmedZone !== '' && !isPresetZone(trimmedZone) && (
              <option value={trimmedZone}>{trimmedZone}（自定义）</option>
            )}
            <option value={CUSTOM_SENTINEL}>自定义…（在下方输入 IANA 名称）</option>
          </select>
          <label className="field-label" htmlFor={zoneCustomId} id={zoneCustomLabelId}>
            自定义时区（IANA 名称）
          </label>
          <input
            id={zoneCustomId}
            className="field-input"
            type="text"
            value={timeZone}
            placeholder="自定义 IANA 时区，如 Asia/Kathmandu"
            ref={customInputRef}
            onChange={(event) => {
              setTimeZone(event.target.value)
              setNotice(null)
            }}
            aria-invalid={zoneInvalid || undefined}
            aria-describedby={zoneInvalid ? `${zoneCustomId}-err ${zoneHelpId}` : zoneHelpId}
          />
            <p className="field-help" id={zoneHelpId}>
              {zoneInvalid
                ? '该时区不是当前运行环境支持的 IANA 名称，导出会被拒绝且不会下载文件；请修正或改回默认模式。'
                : trimmedZone === ''
                  ? '选择后，行程中的当地日期/时刻会换算成该时区唯一确定的 UTC 固定时刻（带 Z）写入日历；' +
                    '日历应用会按设备自己的时区显示同一时刻。留空则保持默认的 floating 本地时间导出。' +
                    '此设置只对本次导出有效，不保存、不写回行程。'
                  : `当前生效的目的地时区：${trimmedZone}。当地日期/时刻会换算成该时区唯一确定的 ` +
                    'UTC 固定时刻（带 Z）写入日历；日历应用会按设备自己的时区显示同一时刻。' +
                    '此设置只对本次导出有效，不保存、不写回行程；清空输入框即回到默认 floating 模式。'}
            </p>
            {configurationInvalid && (
              <p className="field-error" id={`${zoneCustomId}-err`} role="alert">
                {preview.configurationError?.message ?? '导出时区无效：请输入运行环境支持的 IANA 时区名称（如 Asia/Shanghai），或改回默认模式。'}
              </p>
            )}
            {trimmedZone !== '' && !zoneInvalid && notRepresentableCount > 0 && (
              <p className="field-error" role="alert">
                {`有 ${notRepresentableCount} 个站点无法按当前导出设置生成日历事件，具体原因见下方跳过清单。`}
              </p>
            )}
          </div>

          {needsFirstDate && (
            <div className="ics-date-field">
              <label className="field-label" htmlFor={dateId}>
                行程首日<span className="req" aria-hidden="true">*</span>
              </label>
              <input
                id={dateId}
                className="field-input"
                type="date"
                value={firstDate}
                onChange={(event) => {
                  setFirstDate(event.target.value)
                  setNotice(null)
                }}
                aria-required="true"
                aria-invalid={dateInvalid || undefined}
                aria-describedby={dateInvalid ? `${dateHelpId} ${dateId}-err` : dateHelpId}
              />
              <p className="field-help" id={dateHelpId}>
                这份行程的所有天都没有日期。选一个首日后，导出会按「第几天」在真实日历上临时推算，
                跨月、跨年和闰年都按实际日期计算；推算结果只用于这次导出，不会写回行程。
              </p>
              {dateInvalid && (
                <p className="field-error" id={`${dateId}-err`} role="alert">
                  首日必须是合法的 YYYY-MM-DD 日期。
                </p>
              )}
            </div>
          )}

          {preview.provisionalDates.length > 0 && (
            <div className="ics-provisional" aria-live="polite">
              <p className="ics-provisional-title">本次导出使用的临时日期（按你选的首日推算）</p>
              <ul className="ics-provisional-list">
                {preview.provisionalDates.map((item) => (
                  <li key={item.day}>第 {item.day} 天 · {item.date}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.notices.length > 0 && (
            <div className="ics-notices">
              <h4 className="ics-subheading">导入前请留意</h4>
              <ul>
                {preview.notices.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </div>
          )}

          {preview.skipped.length > 0 && (
            <details className="ics-skips">
              <summary>查看被跳过的 {preview.skipped.length} 个站点</summary>
              <ul>
                {preview.skipped.map((skip, index) => (
                  <li key={`${skip.day}:${skip.stopId}:${skip.reason}:${index}`}>{skip.message}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="ics-download">
            <p className="ics-filename">
              文件名：<code>{filename}</code>
            </p>
            {canDownload ? (
              <button type="button" className="btn btn-primary" onClick={handleDownload}>
                下载 .ics 文件
              </button>
            ) : (
              <p className="ics-empty" role="note">
                没有有效事件时不会创建或下载文件。
              </p>
            )}
          </div>

          <div className="ics-notice-live" aria-live="polite" aria-atomic="true">
            {notice && (
              <p className="ics-notice" data-tone={notice.tone}>
                {notice.text}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

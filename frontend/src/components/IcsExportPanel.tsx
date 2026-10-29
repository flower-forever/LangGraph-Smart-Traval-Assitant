import { useId, useMemo, useState } from 'react'
import type { Trip } from '../lib/api'
import { parseIcsDate, tripDateCoverage, tripToIcs } from '../lib/calendar'
import { downloadIcs, safeIcsFilename } from '../lib/icsFile'

export interface IcsExportPanelProps {
  trip: Trip
}

type NoticeTone = 'ok' | 'warn' | 'error'

interface Notice {
  tone: NoticeTone
  text: string
}

/**
 * 显式日历导出入口。
 *
 * - 只有点「下载 .ics 文件」才生成并下载文件；页面加载、恢复、保存都不会自动导出；
 * - 没有任何有效事件时不创建 Blob URL、不触发下载；
 * - 整份行程都缺日期时，必须由用户明确选首日才按天序号临时推算；默认值为空，
 *   不修改 trip、不自动保存，选择的日期也不会被写回原行程；
 * - 部分日期缺失时只跳过并说明，不按编号补日期，也不覆盖已有真实日期。
 */
export default function IcsExportPanel({ trip }: IcsExportPanelProps) {
  const [open, setOpen] = useState(false)
  /** 绝不预填：只有用户自己选了首日才会推算临时日期 */
  const [firstDate, setFirstDate] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)

  const panelId = useId()
  const headingId = useId()
  const dateId = useId()
  const dateHelpId = useId()
  const scopeId = useId()

  const coverage = useMemo(() => tripDateCoverage(trip), [trip])
  const parsedFirstDate = firstDate ? parseIcsDate(firstDate) : null
  const needsFirstDate = coverage.needsFirstDate
  const effectiveFirstDate = needsFirstDate && parsedFirstDate ? firstDate : undefined
  const preview = useMemo(
    () => tripToIcs(trip, { firstDate: effectiveFirstDate }),
    [trip, effectiveFirstDate],
  )
  const filename = useMemo(() => safeIcsFilename(trip), [trip])
  const dateInvalid = firstDate !== '' && parsedFirstDate === null
  const canDownload = preview.eventCount > 0
  const isExample = trip.source === 'example'

  const handleToggle = () => {
    setOpen((prev) => !prev)
    setNotice(null)
  }

  const handleDownload = () => {
    const outcome = downloadIcs(trip, { firstDate: effectiveFirstDate })
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
    setNotice({ tone: 'error', text: outcome.message })
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

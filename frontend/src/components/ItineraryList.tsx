import { useEffect, useRef, useState } from 'react'
import type { TripDay } from '../lib/api'
import { displayTime, formatDate, formatDistance, formatDuration, MODE_LABELS, osmSearchUrl, ROUTE_LABELS } from '../lib/format'

interface ItineraryListProps {
  day: TripDay
  activeStopId: string | null
  onSelectStop: (stopId: string) => void
}

/** 组装某一天的纯文本行程，供「复制」使用 */
export function dayToText(day: TripDay): string {
  const lines: string[] = []
  lines.push(`第 ${day.day} 天 · ${day.title}`)
  if (day.date) lines.push(`日期：${formatDate(day.date)}`)
  if (day.summary) lines.push(day.summary)
  lines.push('')
  for (const stop of day.stops) {
    lines.push(`${displayTime(stop.time)} ${stop.name}`)
    if (stop.duration_minutes != null) lines.push(`  建议停留：${formatDuration(stop.duration_minutes)}`)
    if (stop.address) lines.push(`  地址：${stop.address}`)
    if (stop.description) lines.push(`  讲解：${stop.description}`)
    if (!stop.location) lines.push('  （该站点缺少坐标，未在地图上标注）')
    lines.push('')
    const leg = day.legs.find((l) => l.from_stop_id === stop.id)
    const next = day.stops.find((s) => s.id === leg?.to_stop_id)
    if (leg && next) {
      const parts = [`→ ${next.name} · ${MODE_LABELS[leg.mode]} · ${ROUTE_LABELS[leg.route_type]}`]
      if (leg.distance_m != null) parts.push(formatDistance(leg.distance_m))
      if (leg.duration_minutes != null) parts.push(formatDuration(leg.duration_minutes))
      lines.push(parts.join('，'))
      if (leg.description) lines.push(`  ${leg.description}`)
      lines.push('')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * 复制文本：优先 Clipboard API，失败再退回 execCommand 兜底。
 * 兜底的临时 textarea 无论成功、失败还是抛异常都必须在 finally 里移除，
 * 否则会残留一个悬浮在视口外的节点，键盘/滚动行为都会被它影响。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 无权限 / 非安全上下文 / 被拒绝：继续走兜底 */
  }

  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    return typeof document.execCommand === 'function' && document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
  }
}

export default function ItineraryList({ day, activeStopId, onSelectStop }: ItineraryListProps) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'fail'>('idle')
  const timerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
  }, [])

  const handleCopy = async () => {
    const ok = await copyText(dayToText(day))
    setCopied(ok ? 'done' : 'fail')
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setCopied('idle'), 2200)
  }

  if (day.stops.length === 0) {
    return (
      <div className="day-card">
        <h3 className="day-heading">第 {day.day} 天 · {day.title}</h3>
        {day.date && <p className="day-meta">{formatDate(day.date)}</p>}
        <div className="empty-panel" role="status">
          <p className="empty-title">这一天暂无具体安排</p>
          <p className="empty-desc">
            {day.summary || '后端没有为本日生成站点。可以换个天数重新规划，或调整偏好后重试。'}
          </p>
        </div>
      </div>
    )
  }

  const hasLegs = day.legs.length > 0

  return (
    <div className="day-card">
      <div className="day-head-row">
        <div>
          <h3 className="day-heading">第 {day.day} 天 · {day.title}</h3>
          <p className="day-meta">
            {day.date && <span>{formatDate(day.date)}</span>}
            <span>{day.stops.length} 个站点</span>
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleCopy}
          aria-live="polite"
        >
          {copied === 'done' ? '已复制' : copied === 'fail' ? '复制失败，请手动选择' : '复制本日行程'}
        </button>
      </div>

      {day.summary && <p className="day-summary">{day.summary}</p>}

      <div className="stop-list">
        {day.stops.map((stop, i) => {
          const leg = day.legs.find((l) => l.from_stop_id === stop.id)
          const nextStop = leg ? day.stops.find((s) => s.id === leg.to_stop_id) : undefined
          const isActive = stop.id === activeStopId
          const legHasNoGeometry = Boolean(leg) && leg!.geometry.length < 2
          return (
            <div key={stop.id}>
              <button
                type="button"
                className="stop-row"
                aria-current={isActive || undefined}
                aria-expanded={isActive}
                onClick={() => onSelectStop(isActive ? '' : stop.id)}
              >
                <span className="stop-time">{displayTime(stop.time)}</span>
                <span className="stop-main">
                  <span className="stop-name">{stop.name}</span>
                  {stop.description && <span className="stop-desc">{stop.description}</span>}
                </span>
                <span className="stop-side">
                  {!stop.location && <span className="stop-nocoord-tag">无坐标</span>}
                  <span className="stop-index">{i + 1}</span>
                </span>
              </button>

              {isActive && (
                <div className="stop-detail">
                  <h4>{stop.name}</h4>
                  {stop.description
                    ? <p>{stop.description}</p>
                    : <p className="text-note">后端暂未提供这一站点的讲解。</p>}
                  <p className="stop-addr">
                    {stop.address || '地址未知'}
                    {' · '}
                    {stop.duration_minutes != null ? formatDuration(stop.duration_minutes) : '时长未知'}
                  </p>
                  {stop.location && (
                    <p className="text-note">
                      坐标 WGS84 {stop.location.lat.toFixed(4)}, {stop.location.lng.toFixed(4)}
                      {' · '}
                      <a href={osmSearchUrl(stop)} target="_blank" rel="noopener noreferrer">在 OpenStreetMap 中查看</a>
                    </p>
                  )}
                </div>
              )}

              {leg && nextStop && (
                <div className={`leg${leg.route_type === 'unavailable' || legHasNoGeometry ? ' leg-no-geometry' : ''}`}>
                  <div className="leg-inner">
                    <span className="leg-mode-line">
                      <span>{MODE_LABELS[leg.mode]}</span>
                      <span className={`leg-tag`} data-route={leg.route_type}>{ROUTE_LABELS[leg.route_type]}</span>
                      {leg.distance_m != null && <span>{formatDistance(leg.distance_m)}</span>}
                      {leg.duration_minutes != null && <span>{formatDuration(leg.duration_minutes)}</span>}
                    </span>
                    {leg.description && <p className="leg-desc">{leg.description}</p>}
                    {leg.route_type === 'navigation' && legHasNoGeometry && (
                      <p className="leg-desc">地图服务未返回折线，地图上只画两端示意，不算真实导航。</p>
                    )}
                  </div>
                </div>
              )}
              {!leg && nextStop == null && i < day.stops.length - 1 && (
                <div className="leg"><div className="leg-inner leg-no-geometry"><p className="leg-desc">未提供本段路线信息。</p></div></div>
              )}
            </div>
          )
        })}
      </div>

      {hasLegs && (
        <p className="text-note" style={{ marginTop: 'var(--space-3)' }}>
          「示意直线」为两点直连，仅供方位参考，不是真实导航路径；「地图路线」来自地图服务。
        </p>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { TripDay } from '../lib/api'
import { displayTime, formatDate, formatDistance, formatDuration, MODE_LABELS, osmSearchUrl, ROUTE_LABELS } from '../lib/format'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import { Button } from '@/components/ui/button'
import StopPoiCard from './StopPoiCard'
interface ItineraryListProps {
  day: TripDay
  activeStopId: string | null
  onSelectStop: (stopId: string) => void
  /**
   * 资料卡库记录（父级读好传入；null = 未加载）。停点展开时按名称归一化
   * 匹配资料卡并展示；匹配提示「按名称匹配，请自行核对」。只读展示，
   * 本组件不写任何键。
   */
  poiCards?: PoiCardsRecordV1 | null
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

/** 路段类型 → leg-tag 徽标色（宣纸体系：导航=成功绿、直线=琥珀、缺失=弱化）。 */
const LEG_TAG_CLASS: Record<TripDay['legs'][number]['route_type'], string> = {
  navigation: 'border-[color:var(--color-ok)] text-[color:var(--color-ok)]',
  straight_line: 'border-[color:var(--color-warn-ink)] text-[color:var(--color-warn-ink)]',
  unavailable: 'border-border text-[color:var(--color-faint)]',
}

export default function ItineraryList({ day, activeStopId, onSelectStop, poiCards = null }: ItineraryListProps) {
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
      <div className="rounded-[14px] border border-border bg-card p-5 mb-5">
        <h3 className="m-0 mb-1 font-display text-lg font-bold tracking-[0.03em]">第 {day.day} 天 · {day.title}</h3>
        {day.date && <p className="m-0 mb-3 flex flex-wrap gap-3 font-mono text-xs text-muted-foreground">{formatDate(day.date)}</p>}
        <div className="rounded-[10px] border border-border bg-secondary px-6 py-10 text-center" role="status">
          <p className="m-0 mb-2 font-display text-lg">这一天暂无具体安排</p>
          <p className="mx-auto m-0 max-w-[46ch] text-sm text-muted-foreground">
            {day.summary || '后端没有为本日生成站点。可以换个天数重新规划，或调整偏好后重试。'}
          </p>
        </div>
      </div>
    )
  }

  const hasLegs = day.legs.length > 0

  return (
    <div className="rounded-[14px] border border-border bg-card p-5 mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="m-0 mb-1 font-display text-lg font-bold tracking-[0.03em]">第 {day.day} 天 · {day.title}</h3>
          <p className="m-0 mb-3 flex flex-wrap gap-3 font-mono text-xs text-muted-foreground">
            {day.date && <span>{formatDate(day.date)}</span>}
            <span>{day.stops.length} 个站点</span>
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={handleCopy}
          aria-live="polite"
        >
          {copied === 'done' ? '已复制' : copied === 'fail' ? '复制失败，请手动选择' : '复制本日行程'}
        </Button>
      </div>

      {day.summary && <p className="m-0 mb-4 text-sm text-[color:var(--color-secondary-foreground)]">{day.summary}</p>}

      <div>
        {day.stops.map((stop, i) => {
          const leg = day.legs.find((l) => l.from_stop_id === stop.id)
          const nextStop = leg ? day.stops.find((s) => s.id === leg.to_stop_id) : undefined
          const isActive = stop.id === activeStopId
          const legHasNoGeometry = Boolean(leg) && leg!.geometry.length < 2
          return (
            <div key={stop.id}>
              <button
                type="button"
                className="grid w-full cursor-pointer grid-cols-[74px minmax(0,1fr) auto] gap-3 border-0 border-t border-t-border bg-none py-3 text-left font-[inherit] text-[inherit] hover:bg-secondary focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent-foreground)] focus-visible:-outline-offset-2 max-md:grid-cols-[58px_minmax(0,1fr)] aria-[current=true]:bg-accent-surface aria-[current=true]:shadow-[inset_3px_0_0_var(--color-primary)]"
                data-testid="stop-row"
                aria-current={isActive || undefined}
                aria-expanded={isActive}
                onClick={() => onSelectStop(isActive ? '' : stop.id)}
              >
                <span className="pt-0.5 font-mono text-sm tabular-nums text-[color:var(--color-secondary-foreground)]">{displayTime(stop.time)}</span>
                <span className="min-w-0">
                  <span className="block text-base font-semibold [overflow-wrap:anywhere]">{stop.name}</span>
                  {stop.description && (
                    <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">{stop.description}</span>
                  )}
                </span>
                <span className="flex items-center gap-2 text-xs text-[color:var(--color-faint)]">
                  {!stop.location && (
                    <span className="rounded-[4px] border border-border px-[5px] py-px text-[10px]">无坐标</span>
                  )}
                  <span className="font-mono text-muted-foreground">{i + 1}</span>
                </span>
              </button>

              {isActive && (
                <div className="mt-3 rounded-[10px] border border-border bg-secondary p-4" data-testid="stop-detail">
                  <h4 className="m-0 mb-2 font-display text-md">{stop.name}</h4>
                  {stop.description
                    ? <p className="m-0 mb-2 whitespace-pre-line text-sm text-[color:var(--color-secondary-foreground)]">{stop.description}</p>
                    : <p className="m-0 mb-2 text-xs text-[color:var(--color-faint)]">后端暂未提供这一站点的讲解。</p>}
                  <p className="m-0 flex flex-wrap items-start gap-2 text-sm text-muted-foreground">
                    {stop.address || '地址未知'}
                    {' · '}
                    {stop.duration_minutes != null ? formatDuration(stop.duration_minutes) : '时长未知'}
                  </p>
                  {stop.location && (
                    <p className="m-0 mt-2 text-xs text-[color:var(--color-faint)]">
                      坐标 WGS84 {stop.location.lat.toFixed(4)}, {stop.location.lng.toFixed(4)}
                      {' · '}
                      <a
                        href={osmSearchUrl(stop)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[color:var(--color-accent-foreground)] underline underline-offset-2 [text-decoration-thickness:1px]"
                      >
                        在 OpenStreetMap 中查看
                      </a>
                    </p>
                  )}
                  <StopPoiCard stop={stop} poiCards={poiCards} />
                </div>
              )}

              {leg && nextStop && (
                <div className={`relative -mt-2 grid grid-cols-[74px_minmax(0,1fr)] gap-3 pb-3 pt-2 max-md:grid-cols-[58px_minmax(0,1fr)] ${leg.route_type === 'unavailable' || legHasNoGeometry ? '' : ''}`}>
                  <div className={`col-start-2 border-l-2 border-l-[color:var(--color-line-strong)] px-3 py-1 text-xs text-muted-foreground ${leg.route_type === 'unavailable' || legHasNoGeometry ? 'border-l-dashed' : ''}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{MODE_LABELS[leg.mode]}</span>
                      <span className={`rounded-[4px] border px-1.5 py-px text-[10px] tracking-[0.08em] ${LEG_TAG_CLASS[leg.route_type]}`} data-route={leg.route_type}>{ROUTE_LABELS[leg.route_type]}</span>
                      {leg.distance_m != null && <span>{formatDistance(leg.distance_m)}</span>}
                      {leg.duration_minutes != null && <span>{formatDuration(leg.duration_minutes)}</span>}
                    </div>
                    {leg.description && <p className="m-0 mt-1">{leg.description}</p>}
                    {leg.route_type === 'navigation' && legHasNoGeometry && (
                      <p className="m-0 mt-1">地图服务未返回折线，地图上只画两端示意，不算真实导航。</p>
                    )}
                  </div>
                </div>
              )}
              {!leg && nextStop == null && i < day.stops.length - 1 && (
                <div className="relative -mt-2 grid grid-cols-[74px_minmax(0,1fr)] gap-3 pb-3 pt-2 max-md:grid-cols-[58px_minmax(0,1fr)]">
                  <div className="col-start-2 border-l-2 border-l-dashed border-l-[color:var(--color-line-strong)] px-3 py-1 text-xs text-muted-foreground">
                    <p className="m-0">未提供本段路线信息。</p>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {hasLegs && (
        <p className="m-0 mt-3 text-xs text-[color:var(--color-faint)]">
          「示意直线」为两点直连，仅供方位参考，不是真实导航路径；「地图路线」来自地图服务。
        </p>
      )}
    </div>
  )
}

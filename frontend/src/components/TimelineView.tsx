import type { TripDay } from '../lib/api'
import { displayTime, formatDate, formatDistance, formatDuration, MODE_LABELS, osmSearchUrl, ROUTE_LABELS } from '../lib/format'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import { cn } from '@/lib/utils'
import StopPoiCard from './StopPoiCard'

interface TimelineViewProps {
  day: TripDay
  activeStopId: string | null
  onSelectStop: (stopId: string) => void
  /**
   * 资料卡库（父级读好传入；null = 未加载）。停点展开时按名称归一化
   * 匹配资料卡并展示；匹配提示「按名称匹配，请自行核对」。只读展示，
   * 本组件不写任何键。
   */
  poiCards?: PoiCardsRecordV1 | null
}

/** 路段类型 → leg-tag 徽标色，与列表视图同一口径。 */
const LEG_TAG_CLASS: Record<TripDay['legs'][number]['route_type'], string> = {
  navigation: 'border-[color:var(--color-ok)] text-[color:var(--color-ok)]',
  straight_line: 'border-[color:var(--color-warn-ink)] text-[color:var(--color-warn-ink)]',
  unavailable: 'border-border text-[color:var(--color-faint)]',
}

/** 时刻缺失时统一显示「时间未知」，不猜测、不补默认值。 */
function stopTimeLabel(time: string): string {
  return time.trim() ? displayTime(time) : '时间未知'
}

/**
 * 时间轴视图（四期 S3）：与列表视图共用同一份 TripDay / activeStopId /
 * onSelectStop / poiCards。纯只读展示：不调用 localStorage / sessionStorage，
 * 不修改 Trip 数据，展开/收起状态完全由父级 activeStopId 驱动。
 */
export default function TimelineView({ day, activeStopId, onSelectStop, poiCards = null }: TimelineViewProps) {
  if (day.stops.length === 0) {
    return (
      <div className="rounded-[14px] border border-border bg-card p-5 mb-5" data-testid="timeline-view">
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
    <div className="rounded-[14px] border border-border bg-card p-5 mb-5" data-testid="timeline-view">
      <div className="min-w-0">
        <h3 className="m-0 mb-1 font-display text-lg font-bold tracking-[0.03em]">第 {day.day} 天 · {day.title}</h3>
        <p className="m-0 mb-3 flex flex-wrap gap-3 font-mono text-xs text-muted-foreground">
          {day.date && <span>{formatDate(day.date)}</span>}
          <span>{day.stops.length} 个站点</span>
        </p>
      </div>

      {day.summary && <p className="m-0 mb-4 text-sm text-[color:var(--color-secondary-foreground)]">{day.summary}</p>}

      <ol className="m-0 list-none p-0" data-testid="timeline-list">
        {day.stops.map((stop, i) => {
          const leg = day.legs.find((l) => l.from_stop_id === stop.id)
          const nextStop = leg ? day.stops.find((s) => s.id === leg.to_stop_id) : undefined
          const isActive = stop.id === activeStopId
          const isLast = i === day.stops.length - 1
          const legHasNoGeometry = Boolean(leg) && leg!.geometry.length < 2
          const showLeg = !isLast

          return (
            <li key={stop.id} className="relative">
              <div className="grid grid-cols-[64px_18px_minmax(0,1fr)] gap-x-2 max-sm:grid-cols-[46px_14px_minmax(0,1fr)]">
                <div className="col-start-1 row-start-1 pt-3 text-right font-mono text-xs tabular-nums text-[color:var(--color-secondary-foreground)]">
                  {stopTimeLabel(stop.time)}
                </div>

                <div className="relative col-start-2 row-span-2 row-start-1 flex justify-center" aria-hidden="true">
                  {!isLast && <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />}
                  <span
                    className={cn(
                      'relative z-10 mt-3 size-3 shrink-0 rounded-full border-2',
                      isActive ? 'border-primary bg-primary' : 'border-[color:var(--color-line-strong)] bg-card',
                    )}
                  />
                </div>

                <div className="col-start-3 row-start-1 min-w-0 pb-2">
                  <button
                    type="button"
                    className="w-full cursor-pointer rounded-[8px] border-0 bg-transparent px-2 py-2 text-left font-[inherit] text-[inherit] hover:bg-secondary focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent-foreground)] focus-visible:-outline-offset-2 aria-[current=true]:bg-accent-surface aria-[current=true]:shadow-[inset_3px_0_0_var(--color-primary)]"
                    data-testid="timeline-stop"
                    aria-current={isActive || undefined}
                    aria-expanded={isActive}
                    onClick={() => onSelectStop(isActive ? '' : stop.id)}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                      <span className="text-base font-semibold [overflow-wrap:anywhere]">{stop.name}</span>
                      {!stop.location && (
                        <span className="rounded-[4px] border border-border px-[5px] py-px text-[10px] text-[color:var(--color-faint)]">无坐标</span>
                      )}
                    </span>
                    {stop.description && (
                      <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{stop.description}</span>
                    )}
                  </button>

                  {isActive && (
                    <div className="mt-2 rounded-[10px] border border-border bg-secondary p-4" data-testid="timeline-stop-detail">
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
                </div>

                {showLeg && (
                  <div className="col-start-3 row-start-2 min-w-0 pb-4 text-xs text-muted-foreground">
                    {leg && nextStop ? (
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          <span>{MODE_LABELS[leg.mode]}</span>
                          <span
                            className={`rounded-[4px] border px-1.5 py-px text-[10px] tracking-[0.08em] ${LEG_TAG_CLASS[leg.route_type]}`}
                            data-route={leg.route_type}
                          >
                            {ROUTE_LABELS[leg.route_type]}
                          </span>
                          <span>{formatDistance(leg.distance_m)}</span>
                          <span>{formatDuration(leg.duration_minutes)}</span>
                        </div>
                        {leg.description && <p className="m-0 mt-1">{leg.description}</p>}
                        {leg.route_type === 'navigation' && legHasNoGeometry && (
                          <p className="m-0 mt-1">地图服务未返回折线，地图上只画两端示意，不算真实导航。</p>
                        )}
                      </>
                    ) : (
                      <p className="m-0">未提供本段路线信息。</p>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {hasLegs && (
        <p className="m-0 mt-3 text-xs text-[color:var(--color-faint)]">
          「示意直线」为两点直连，仅供方位参考，不是真实导航路径；「地图路线」来自地图服务。
        </p>
      )}
    </div>
  )
}

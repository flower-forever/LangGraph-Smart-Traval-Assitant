import type { Trip, TripDay, TripLeg } from '../lib/api'
import { dayCity, findIntercityLeg } from '../lib/cityScope'
import { formatDistance, formatDuration } from '../lib/format'

/**
 * 七期 S3 城际转移卡。
 *
 * - 只有当天带 `transferKind === 'intercity'` 的 leg 才渲染；单城零 DOM。
 * - 三态口径（与五期一致）：直线估算态显示距离 / 建议预留并标「估算」；
 *   不可用或距离 / 耗时缺失显示「距离与耗时未知」。
 * - **任何状态**都给出固定行「具体班次与时刻未提供，请自行查询。」，
 *   绝不渲染具体车次、班次或时刻，也不补造任何数字。
 */

export interface IntercityTransferCardProps {
  trip: Trip
  day: TripDay
  nextDay?: TripDay | null
}

const CARD =
  'mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-4 py-3 text-sm leading-relaxed'
const BADGE =
  'inline-flex items-center rounded-[4px] border border-[color:var(--color-warn-ink)] px-1.5 py-px text-[10px] text-[color:var(--color-warn-ink)]'

/** 下一天城市名；缺下一天时从 S1 的 `城际转移：A → B，…` 描述里取目标城。 */
function resolveNextCity(trip: Trip, leg: TripLeg, nextDay: TripDay | null | undefined): string {
  if (nextDay !== null && nextDay !== undefined) {
    const city = dayCity(nextDay, trip)
    if (city !== '') return city
  }
  const match = /→\s*([^，,；;。\n]+)/.exec(leg.description)
  const parsed = match?.[1]?.trim()
  if (parsed) return parsed
  const raw = leg.description.trim()
  return raw === '' ? '下一城' : raw
}

export default function IntercityTransferCard({ trip, day, nextDay = null }: IntercityTransferCardProps) {
  const leg = findIntercityLeg(day)
  if (leg === null) return null

  const hasEstimate =
    leg.route_type === 'straight_line' &&
    typeof leg.distance_m === 'number' &&
    Number.isFinite(leg.distance_m) &&
    typeof leg.duration_minutes === 'number' &&
    Number.isFinite(leg.duration_minutes)
  const state = hasEstimate ? 'estimated' : 'unknown'
  const fromCity = dayCity(day, trip)
  const toCity = resolveNextCity(trip, leg, nextDay)

  return (
    <section
      aria-label="城际转移"
      data-testid="intercity-transfer-card"
      data-transfer-kind="intercity"
      data-state={state}
      className={CARD}
    >
      <p className="m-0 font-semibold" data-testid="intercity-transfer-title">
        城际转移 · {fromCity} → {toCity}
      </p>
      {hasEstimate ? (
        <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="intercity-transfer-estimate">
          <span>直线约 {formatDistance(leg.distance_m)}</span>
          <span>建议预留{formatDuration(leg.duration_minutes)}</span>
          <span className={BADGE} data-testid="intercity-transfer-approx">估算</span>
        </p>
      ) : (
        <p className="m-0 mt-1" data-testid="intercity-transfer-unknown">
          距离与耗时未知
        </p>
      )}
      <p
        className="m-0 mt-1 text-xs text-[color:var(--color-faint)]"
        data-testid="intercity-transfer-notice"
      >
        具体班次与时刻未提供，请自行查询。
      </p>
    </section>
  )
}

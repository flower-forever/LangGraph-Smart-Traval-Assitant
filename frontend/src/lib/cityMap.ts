import type { Trip, TripDay, TripLeg } from './api'
import { dayCity, tripCityGroups } from './cityScope'

/**
 * 七期 S4 · 地图跨日视野投影。
 *
 * 口径：
 * - 城市段直接复用 `tripCityGroups`（`day.city ?? trip.destination`，连续同城合并）；
 * - `days` 按 `day` 升序，单城只保留当天（等价旧单日地图，不放大视野）；
 * - `intercityLegs` 只收 `transferKind === 'intercity'` 且任一端落在本段站点集合里的段，
 *   因此中间城市段会同时拿到「进入段」（上一天末站 → 本段首站）与「离开段」
 *   （本段末站 → 下天首站），最多 2 条；不补造班次或额外几何；
 * - `dayByStopId` 只为段内站点建映射；重复 id 保留首次出现的天（行程契约本身
 *   不允许跨天重复 id，这里只是不猜）；
 * - 纯函数：不修改输入、不读写存储、不发请求。
 */

export interface CityMapSegment {
  city: string
  days: TripDay[]
  /** 与该城市段首尾相连的城际段（进入本段/离开本段），最多 2 条。 */
  intercityLegs: TripLeg[]
  /** stopId → day.day，用于点击跨日站点时切天。 */
  dayByStopId: Record<string, number>
}

function buildDayByStopId(days: readonly TripDay[]): Record<string, number> {
  const dayByStopId: Record<string, number> = {}
  for (const day of days) {
    for (const stop of day.stops) {
      if (!Object.prototype.hasOwnProperty.call(dayByStopId, stop.id)) {
        dayByStopId[stop.id] = day.day
      }
    }
  }
  return dayByStopId
}

/**
 * 找 activeDay 所属城市段并投影成地图可消费的数据。
 * activeDay 不在 trip.days 里（按 day.day 匹配）时返回 null。
 */
export function buildCityMapSegment(trip: Trip, activeDay: TripDay): CityMapSegment | null {
  const groups = tripCityGroups(trip)
  const group = groups.find((candidate) => candidate.days.some((day) => day.day === activeDay.day))
  if (!group) return null

  // 单城：只投影当天，行为等价旧单日地图；不把同城多天并成跨日视野。
  if (groups.length <= 1) {
    return {
      city: dayCity(activeDay, trip),
      days: [activeDay],
      intercityLegs: [],
      dayByStopId: buildDayByStopId([activeDay]),
    }
  }

  const days = [...group.days].sort((left, right) => left.day - right.day)
  const stopIds = new Set<string>()
  for (const day of days) {
    for (const stop of day.stops) stopIds.add(stop.id)
  }

  const intercityLegs: TripLeg[] = []
  for (const day of trip.days) {
    for (const leg of day.legs) {
      if (leg.transferKind !== 'intercity') continue
      if (!stopIds.has(leg.from_stop_id) && !stopIds.has(leg.to_stop_id)) continue
      if (!intercityLegs.includes(leg)) intercityLegs.push(leg)
    }
  }

  return {
    city: group.city,
    days,
    intercityLegs,
    dayByStopId: buildDayByStopId(days),
  }
}

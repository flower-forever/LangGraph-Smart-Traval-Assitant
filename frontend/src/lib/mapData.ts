import type { TripDay, TripStop } from '../lib/api'
import { validCoord } from '../lib/format'

export interface StopRef {
  stop: TripStop
  index: number
}

export interface LegRef {
  from: TripStop
  to: TripStop
  routeType: 'navigation' | 'straight_line' | 'unavailable'
  geometry: Array<{ lng: number; lat: number }>
}

export interface DayMapData {
  stops: StopRef[]
  legs: LegRef[]
  /** 是否至少有一个可用坐标 */
  hasCoords: boolean
  /** 这一日的站点总数（含缺坐标的），与 stops.length（可画的）分开 */
  totalStopCount: number
  /** 其中缺少可用坐标的站点数；0 表示本日站点坐标齐全 */
  missingCoordCount: number
}

/**
 * 把一日的 stops/legs 整理成地图可消费的数据。
 * - 坐标必须 WGS84 lng/lat 且数值合法，非法一律丢弃（宁缺毋滥，不画假点）
 * - navigation 用完整 geometry；有效点少于 2 个时降级为 straight_line，
 *   这样图例、虚线样式和 tooltip 都会按「示意直线」呈现，不会冒充真实导航
 * - straight_line 只取两端点连线；unavailable 不画
 */
export function buildDayMapData(day: TripDay): DayMapData {
  const stops: StopRef[] = []
  day.stops.forEach((stop, index) => {
    const loc = validCoord(stop.location)
    if (loc) {
      stops.push({ stop: { ...stop, location: loc }, index })
    }
  })

  const byId = new Map(day.stops.map((s) => [s.id, s]))
  const legs: LegRef[] = []
  for (const leg of day.legs) {
    const from = byId.get(leg.from_stop_id)
    const to = byId.get(leg.to_stop_id)
    if (!from || !to) continue
    if (leg.route_type === 'unavailable') continue

    const fLoc = validCoord(from.location)
    const tLoc = validCoord(to.location)
    if (!fLoc || !tLoc) continue

    if (leg.route_type === 'navigation') {
      const geom = (leg.geometry ?? [])
        .map((p) => validCoord(p))
        .filter((p): p is { lng: number; lat: number } => p !== null)
      if (geom.length >= 2) {
        legs.push({ from, to, routeType: 'navigation', geometry: geom })
      } else {
        // 后端标了 navigation 却没给出可用折线：降级成两点示意，绝不标成真实导航
        legs.push({ from, to, routeType: 'straight_line', geometry: [fLoc, tLoc] })
      }
    } else {
      // straight_line：明确是示意直线，只连两端
      legs.push({ from, to, routeType: 'straight_line', geometry: [fLoc, tLoc] })
    }
  }

  return { stops, legs, hasCoords: stops.length > 0, totalStopCount: day.stops.length, missingCoordCount: day.stops.length - stops.length }
}

/**
 * 把可画的站点按完全相同的坐标分组，解决同点 marker 相互遮挡：
 * - 只有 lng/lat 字面相等才归为一组，不做任何「近似」合并——近似会吞掉真实的相邻站点；
 * - 原始坐标、全天序号、名称、时间一律原值透传，分组只影响 marker 的堆叠呈现，
 *   不改写任何 location / route geometry。
 */
export function groupStopsByLocation(stops: StopRef[]): StopRef[][] {
  const groups = new Map<string, StopRef[]>()
  for (const ref of stops) {
    const key = `${ref.stop.location!.lng},${ref.stop.location!.lat}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(ref)
    else groups.set(key, [ref])
  }
  return [...groups.values()]
}

/** 展开整条行程的所有站点（跨日用于空态文案等） */
export function countStops(trip: { days: TripDay[] }): number {
  return trip.days.reduce((acc, d) => acc + d.stops.length, 0)
}

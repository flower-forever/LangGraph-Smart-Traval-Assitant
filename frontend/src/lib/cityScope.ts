import type { CityProfile, Trip, TripDay, TripLeg } from './api'

/**
 * 七期 S3 多城渲染基础：城市归属与城市分段投影。
 *
 * 口径：
 * - 城市归属一律 `day.city ?? trip.destination`，旧行程（无 `day.city`）整体归属目的地。
 * - 城市名先 trim；空串 / 纯空白按缺省处理（回退目的地）。
 * - 全部纯函数：不修改输入对象、不读写存储、不发请求。
 * - 与后端契约一致：`cityProfiles` 只做最浅守卫，坏值安全回退到 `cityProfile`。
 */

export interface CityGroup {
  city: string
  days: TripDay[]
  fromDay: number
  toDay: number
}

function cityName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 单天城市：`day.city` 优先，空 / 缺省回退 `trip.destination`（同样 trim）。 */
export function dayCity(day: TripDay, trip: Trip): string {
  return cityName(day.city) ?? cityName(trip.destination) ?? ''
}

/** 把连续同城的天合并成城市段；旧行程全部同城时只返回 1 组。 */
export function tripCityGroups(trip: Trip): CityGroup[] {
  const groups: CityGroup[] = []
  for (const day of trip.days) {
    const city = dayCity(day, trip)
    const last = groups[groups.length - 1]
    if (last !== undefined && last.city === city) {
      last.days.push(day)
      last.toDay = day.day
      continue
    }
    groups.push({ city, days: [day], fromDay: day.day, toDay: day.day })
  }
  return groups
}

/** 行程是否真的出现 ≥2 个城市（单城旧行程必须为 false）。 */
export function isMultiCityTrip(trip: Trip): boolean {
  return tripCityGroups(trip).length > 1
}

/** 当前天城市；没有当前天时回退目的地（与 `dayCity` 同一口径）。 */
export function currentCity(trip: Trip, day: TripDay | null | undefined): string {
  if (day !== null && day !== undefined) return dayCity(day, trip)
  return cityName(trip.destination) ?? ''
}

/**
 * 城市画像：`cityProfiles[city]` 优先，其次主城 `cityProfile`，最后 null。
 * `cityProfiles` 不是普通对象、或命中值不是对象（坏数据）时安全回退。
 */
export function getCityProfile(trip: Trip, city: string): CityProfile | null {
  const key = city.trim()
  const profiles = trip.cityProfiles
  if (key !== '' && isRecord(profiles)) {
    const hit = profiles[key]
    if (isRecord(hit)) return hit as CityProfile
  }
  return isRecord(trip.cityProfile) ? trip.cityProfile : null
}

/** 当天最后一条城际转移段；没有则 null（单城零渲染）。 */
export function findIntercityLeg(day: TripDay): TripLeg | null {
  for (let index = day.legs.length - 1; index >= 0; index -= 1) {
    const leg = day.legs[index]
    if (leg.transferKind === 'intercity') return leg
  }
  return null
}

/**
 * 城市序列标签：多城按出现顺序去重后用 " · " 连接（同城连续段只出现一次）；
 * 单城 / 空行程返回 `trip.destination` 原文——单城导出据此保持逐字节不变。
 */
export function tripCityLabel(trip: Trip): string {
  const groups = tripCityGroups(trip)
  if (groups.length <= 1) return trip.destination
  const cities: string[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    if (group.city === '' || seen.has(group.city)) continue
    seen.add(group.city)
    cities.push(group.city)
  }
  return cities.length <= 1 ? trip.destination : cities.join(' · ')
}

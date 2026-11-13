/**
 * 七期 S4 · 地图跨日视野投影测试。
 *
 * 覆盖：中间城市段的进入/离开城际段、单城只投影当天、找不到 activeDay、
 * 重复站点 id 只认首次出现、旧行程（无 day.city）回退目的地、纯函数不修改输入。
 */
import { describe, expect, it } from 'vitest'

import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import { buildCityMapSegment } from '../lib/cityMap'

function stop(id: string, name: string, lng: number, lat: number): TripStop {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: 60,
    description: '',
    address: '',
    location: { lng, lat },
  }
}

function leg(from: string, to: string, patch: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'straight_line',
    distance_m: 1000,
    duration_minutes: 20,
    geometry: [],
    description: '',
    ...patch,
  }
}

function intercity(from: string, to: string, description: string): TripLeg {
  return leg(from, to, {
    mode: 'driving',
    distance_m: 170000,
    duration_minutes: 150,
    transferKind: 'intercity',
    description,
  })
}

function day(dayNumber: number, city: string, stops: TripStop[], legs: TripLeg[] = []): TripDay {
  return { day: dayNumber, date: null, title: `第 ${dayNumber} 天`, summary: '', stops, legs, city }
}

/** 三城：A(1) → B(2-3) → C(4)，中间段同时有进入段与离开段。 */
function makeThreeCityTrip(): Trip {
  const a1 = stop('a1', 'A 城一站', 116.4, 39.9)
  const a2 = stop('a2', 'A 城二站', 116.41, 39.91)
  const b1 = stop('b1', 'B 城一站', 121.47, 31.23)
  const b2 = stop('b2', 'B 城二站', 121.48, 31.24)
  const b3 = stop('b3', 'B 城三站', 121.49, 31.25)
  const c1 = stop('c1', 'C 城一站', 113.26, 23.13)
  return {
    id: 'trip-three-city',
    source: 'agent',
    destination: 'A 城',
    title: '三城联程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [
      day(1, 'A 城', [a1, a2], [leg('a1', 'a2'), intercity('a2', 'b1', '城际 A→B')]),
      day(2, 'B 城', [b1, b2]),
      day(3, 'B 城', [b3], [intercity('b3', 'c1', '城际 B→C')]),
      day(4, 'C 城', [c1]),
    ],
  }
}

describe('buildCityMapSegment · 城市段与城际段', () => {
  it('中间城市段：days 按天升序，首尾两条城际段都收进来', () => {
    const trip = makeThreeCityTrip()
    const segment = buildCityMapSegment(trip, trip.days[1])
    expect(segment).not.toBeNull()
    expect(segment!.city).toBe('B 城')
    expect(segment!.days.map((item) => item.day)).toEqual([2, 3])
    expect(segment!.intercityLegs.map((item) => item.description)).toEqual([
      '城际 A→B',
      '城际 B→C',
    ])
    expect(segment!.dayByStopId).toEqual({ b1: 2, b2: 2, b3: 3 })
  })

  it('首城段只收离开段，末城段只收进入段', () => {
    const trip = makeThreeCityTrip()
    const first = buildCityMapSegment(trip, trip.days[0])!
    expect(first.days.map((item) => item.day)).toEqual([1])
    expect(first.intercityLegs.map((item) => item.description)).toEqual(['城际 A→B'])

    const last = buildCityMapSegment(trip, trip.days[3])!
    expect(last.days.map((item) => item.day)).toEqual([4])
    expect(last.intercityLegs.map((item) => item.description)).toEqual(['城际 B→C'])
  })

  it('只认 transferKind=intercity：同城普通 leg 不进城际段', () => {
    const trip = makeThreeCityTrip()
    const segment = buildCityMapSegment(trip, trip.days[0])!
    expect(segment.intercityLegs).toHaveLength(1)
    expect(segment.intercityLegs[0].transferKind).toBe('intercity')
    expect(segment.intercityLegs.some((item) => item.description === '')).toBe(false)
  })

  it('activeDay 不在行程里时返回 null', () => {
    const trip = makeThreeCityTrip()
    const alien: TripDay = day(99, 'B 城', [stop('x', '异界站', 120, 30)])
    expect(buildCityMapSegment(trip, alien)).toBeNull()
  })

  it('重复站点 id 只认首次出现的天，不猜后者', () => {
    const trip: Trip = {
      ...makeThreeCityTrip(),
      days: [
        day(1, 'A 城', [stop('a1', 'A 城一站', 116.4, 39.9)]),
        day(2, 'B 城', [stop('dup', '重复站', 121.47, 31.23)]),
        day(3, 'B 城', [stop('dup', '重复站', 121.49, 31.25), stop('b3', 'B 城三站', 121.5, 31.26)]),
      ],
    }
    const segment = buildCityMapSegment(trip, trip.days[1])!
    expect(segment.dayByStopId.dup).toBe(2)
  })

  it('纯函数：不修改输入', () => {
    const trip = makeThreeCityTrip()
    const before = JSON.stringify(trip)
    buildCityMapSegment(trip, trip.days[1])
    expect(JSON.stringify(trip)).toBe(before)
  })
})

describe('buildCityMapSegment · 单城与旧行程', () => {
  it('单城只投影当天（不把同城多天并成跨日视野）', () => {
    const trip: Trip = {
      ...makeThreeCityTrip(),
      destination: '杭州',
      days: [
        day(1, '杭州', [stop('h1', '断桥', 120.15, 30.27)]),
        day(2, '杭州', [stop('h2', '灵隐', 120.1, 30.24)]),
        day(3, '杭州', [stop('h3', '龙井', 120.11, 30.22)]),
      ],
    }
    const segment = buildCityMapSegment(trip, trip.days[1])!
    expect(segment.city).toBe('杭州')
    expect(segment.days.map((item) => item.day)).toEqual([2])
    expect(segment.intercityLegs).toEqual([])
    expect(segment.dayByStopId).toEqual({ h2: 2 })
  })

  it('旧行程没有 day.city 时回退 trip.destination，整段按单城处理', () => {
    const trip: Trip = {
      ...makeThreeCityTrip(),
      destination: '杭州',
      days: [
        { ...day(1, '', [stop('o1', '旧站一', 120.15, 30.27)]), city: undefined },
        { ...day(2, '', [stop('o2', '旧站二', 120.1, 30.24)]), city: undefined },
      ],
    }
    const segment = buildCityMapSegment(trip, trip.days[0])!
    expect(segment.city).toBe('杭州')
    expect(segment.days.map((item) => item.day)).toEqual([1])
    expect(segment.intercityLegs).toEqual([])
  })
})

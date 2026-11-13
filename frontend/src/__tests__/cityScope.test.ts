import { describe, expect, it } from 'vitest'

import type { CityProfile, Trip, TripDay, TripLeg } from '../lib/api'
import {
  currentCity,
  dayCity,
  findIntercityLeg,
  getCityProfile,
  isMultiCityTrip,
  tripCityGroups,
} from '../lib/cityScope'

function makeDay(dayNumber: number, city?: string | null): TripDay {
  const base: TripDay = {
    day: dayNumber,
    date: null,
    title: `第 ${dayNumber} 天`,
    summary: '',
    stops: [],
    legs: [],
  }
  return city === undefined ? base : { ...base, city }
}

function makeTrip(days: TripDay[], patch: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-city-scope',
    source: 'example',
    destination: '杭州',
    title: '城市归属测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days,
    ...patch,
  }
}

function makeLeg(patch: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: 'a',
    to_stop_id: 'b',
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 800,
    duration_minutes: 12,
    geometry: [],
    description: '市内步行',
    ...patch,
  }
}

const PROFILE_A: CityProfile = { source: 'model_generated' }
const PROFILE_B: CityProfile = {
  source: 'model_generated',
  oneLineImpression: { text: '园林与水巷', source: 'model_generated' },
}

describe('dayCity / tripCityGroups', () => {
  it('旧行程无 city：1 组、归属 destination、isMultiCity=false', () => {
    const days = [makeDay(1), makeDay(2), makeDay(3)]
    const trip = makeTrip(days)

    expect(dayCity(days[0], trip)).toBe('杭州')
    expect(currentCity(trip, days[1])).toBe('杭州')
    expect(currentCity(trip, null)).toBe('杭州')

    const groups = tripCityGroups(trip)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ city: '杭州', fromDay: 1, toDay: 3 })
    expect(groups[0].days).toHaveLength(3)
    expect(isMultiCityTrip(trip)).toBe(false)

    // 纯函数：不写输入、不复制天对象。
    expect(Object.hasOwn(days[0], 'city')).toBe(false)
    expect(groups[0].days[0]).toBe(days[0])
  })

  it('3+2 两天城：2 组、from/to 正确，连续同城（含空白差异）不拆组', () => {
    const days = [
      makeDay(1, '杭州'),
      makeDay(2, ' 杭州 '),
      makeDay(3, '杭州'),
      makeDay(4, '苏州'),
      makeDay(5, '苏州'),
    ]
    const trip = makeTrip(days)

    const groups = tripCityGroups(trip)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ city: '杭州', fromDay: 1, toDay: 3 })
    expect(groups[0].days.map((day) => day.day)).toEqual([1, 2, 3])
    expect(groups[1]).toMatchObject({ city: '苏州', fromDay: 4, toDay: 5 })
    expect(groups[1].days.map((day) => day.day)).toEqual([4, 5])
    expect(isMultiCityTrip(trip)).toBe(true)
    expect(currentCity(trip, days[4])).toBe('苏州')
  })

  it('空串 / 纯空白 city 回退 destination；正常城市名 trim', () => {
    const trip = makeTrip([makeDay(1, ''), makeDay(2, '   '), makeDay(3, ' 苏州 ')])
    expect(dayCity(trip.days[0], trip)).toBe('杭州')
    expect(dayCity(trip.days[1], trip)).toBe('杭州')
    expect(dayCity(trip.days[2], trip)).toBe('苏州')
    expect(tripCityGroups(trip).map((group) => group.city)).toEqual(['杭州', '苏州'])
  })
})

describe('getCityProfile', () => {
  it('cityProfiles 优先，其次 cityProfile，最后 null', () => {
    const trip = makeTrip([makeDay(1, '杭州'), makeDay(2, '苏州')], {
      cityProfile: PROFILE_A,
      cityProfiles: { 杭州: PROFILE_A, 苏州: PROFILE_B },
    })
    expect(getCityProfile(trip, '苏州')).toBe(PROFILE_B)
    expect(getCityProfile(trip, ' 苏州 ')).toBe(PROFILE_B)
    expect(getCityProfile(trip, '南京')).toBe(PROFILE_A)

    const onlyMain = makeTrip([makeDay(1)], { cityProfile: PROFILE_A })
    expect(getCityProfile(onlyMain, '杭州')).toBe(PROFILE_A)

    const empty = makeTrip([makeDay(1)], { cityProfile: null })
    expect(getCityProfile(empty, '杭州')).toBeNull()
  })

  it('坏 map（数组 / 非对象值）安全回退，不抛错', () => {
    const main = makeTrip([makeDay(1)], { cityProfile: PROFILE_A })
    const badValue: Trip = {
      ...main,
      cityProfiles: { 杭州: 42 } as unknown as Record<string, CityProfile>,
    }
    const badMap: Trip = {
      ...main,
      cityProfiles: [] as unknown as Record<string, CityProfile>,
    }
    const nullValue: Trip = {
      ...main,
      cityProfiles: { 杭州: null } as unknown as Record<string, CityProfile>,
    }

    expect(getCityProfile(badValue, '杭州')).toBe(PROFILE_A)
    expect(getCityProfile(badMap, '杭州')).toBe(PROFILE_A)
    expect(getCityProfile(nullValue, '杭州')).toBe(PROFILE_A)
  })
})

describe('findIntercityLeg', () => {
  it('只认最后一条 transferKind=intercity 的 leg；没有则 null', () => {
    const day = makeDay(1, '杭州')
    day.legs = [
      makeLeg({ description: '市内步行' }),
      makeLeg({ transferKind: 'intercity', description: '城际段甲' }),
      makeLeg({ transferKind: null, description: '显式同城' }),
      makeLeg({ transferKind: 'intercity', description: '城际段乙' }),
    ]
    expect(findIntercityLeg(day)).toBe(day.legs[3])

    const single = makeDay(2, '杭州')
    single.legs = [makeLeg(), makeLeg({ transferKind: null })]
    expect(findIntercityLeg(single)).toBeNull()
  })
})

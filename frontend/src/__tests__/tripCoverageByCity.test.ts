/**
 * 七期 S6 · 按城市分桶的选择充分度投影测试（lib/tripCoverage.ts）。
 * 全离线纯函数：不读写存储、不发请求。
 * 覆盖：两城 3+2 分桶 / 跨城经典不互相顶替 / 缺画像 → view=null /
 * 单城桶与旧 projectTripCoverage deep-equal / 空输入与坏输入防御。
 */
import { describe, expect, it } from 'vitest'

import type { CityProfile, Trip, TripDay } from '../lib/api'
import { projectTripCoverage, projectTripCoverageByCity } from '../lib/tripCoverage'

function profileWithClassics(names: string[]): CityProfile {
  return {
    source: 'model_generated',
    classicList: names.map((name) => ({
      name,
      reason: `${name}的理由`,
      source: 'model_generated' as const,
    })),
  }
}

function dayWithStops(dayNumber: number, city: string, stopNames: string[]): TripDay {
  return {
    day: dayNumber,
    date: null,
    title: `第 ${dayNumber} 天`,
    summary: '',
    city,
    stops: stopNames.map((name, index) => ({
      id: `stop-${dayNumber}-${index}`,
      name,
      time: '09:00',
      duration_minutes: null,
      description: '',
      address: '',
      location: null,
    })),
    legs: [],
  }
}

function makeTrip(days: TripDay[], patch: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-coverage-by-city',
    source: 'example',
    destination: '杭州',
    title: '分城覆盖测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days,
    ...patch,
  }
}

describe('projectTripCoverageByCity · 分桶', () => {
  it('两城 3+2 天：2 桶、天号连续段正确，各城只统计自己的站点', () => {
    const trip = makeTrip(
      [
        dayWithStops(1, '杭州', ['断桥', '苏堤春晓']),
        dayWithStops(2, '杭州', ['九溪烟树']),
        dayWithStops(3, '杭州', []),
        dayWithStops(4, '苏州', ['拙政园']),
        dayWithStops(5, '苏州', ['平江路']),
      ],
      {
        cityProfile: profileWithClassics(['断桥', '灵隐寺']),
        cityProfiles: {
          杭州: profileWithClassics(['断桥', '灵隐寺']),
          苏州: profileWithClassics(['拙政园', '虎丘']),
        },
      },
    )

    const buckets = projectTripCoverageByCity(trip)
    expect(buckets).toHaveLength(2)
    expect(buckets[0]).toMatchObject({ city: '杭州', days: [1, 2, 3] })
    expect(buckets[1]).toMatchObject({ city: '苏州', days: [4, 5] })

    expect(buckets[0]!.view).not.toBeNull()
    expect(buckets[0]!.view!.total).toBe(2)
    expect(buckets[0]!.view!.covered.map((item) => item.name)).toEqual(['断桥'])
    expect(buckets[0]!.view!.uncovered.map((item) => item.name)).toEqual(['灵隐寺'])
    expect(buckets[0]!.view!.unrecognizedStops).toEqual(['苏堤春晓', '九溪烟树'])

    expect(buckets[1]!.view).not.toBeNull()
    expect(buckets[1]!.view!.total).toBe(2)
    expect(buckets[1]!.view!.covered.map((item) => item.name)).toEqual(['拙政园'])
    expect(buckets[1]!.view!.uncovered.map((item) => item.name)).toEqual(['虎丘'])
    expect(buckets[1]!.view!.unrecognizedStops).toEqual(['平江路'])
  })

  it('杭州站不覆盖苏州经典：同名经典只在本城桶里命中', () => {
    const trip = makeTrip(
      [dayWithStops(1, '杭州', ['拙政园']), dayWithStops(2, '苏州', ['平江路'])],
      {
        cityProfile: profileWithClassics(['断桥']),
        cityProfiles: {
          杭州: profileWithClassics(['断桥']),
          苏州: profileWithClassics(['拙政园']),
        },
      },
    )

    const buckets = projectTripCoverageByCity(trip)
    const hangzhou = buckets.find((bucket) => bucket.city === '杭州')!
    const suzhou = buckets.find((bucket) => bucket.city === '苏州')!

    // 杭州的「拙政园」站点对杭州经典清单是未识别，不能算作苏州已覆盖。
    expect(hangzhou.view!.covered).toHaveLength(0)
    expect(hangzhou.view!.unrecognizedStops).toEqual(['拙政园'])
    expect(suzhou.view!.covered).toHaveLength(0)
    expect(suzhou.view!.uncovered.map((item) => item.name)).toEqual(['拙政园'])
    expect(suzhou.view!.unrecognizedStops).toEqual(['平江路'])
  })

  it('某城缺画像：该桶 view=null，其它城不受影响（不补造）', () => {
    const trip = makeTrip(
      [dayWithStops(1, '杭州', ['断桥']), dayWithStops(2, '苏州', ['拙政园'])],
      { cityProfile: profileWithClassics(['断桥']) },
    )

    const buckets = projectTripCoverageByCity(trip)
    expect(buckets[0]!.view!.total).toBe(1)
    expect(buckets[1]).toEqual({ city: '苏州', days: [2], view: null })
  })

  it('画像取值：cityProfiles[城] 优先，主城回退 cityProfile', () => {
    const trip = makeTrip(
      [dayWithStops(1, '杭州', []), dayWithStops(2, '苏州', [])],
      {
        cityProfile: profileWithClassics(['断桥', '灵隐寺', '苏堤春晓']),
        cityProfiles: { 苏州: profileWithClassics(['拙政园']) },
      },
    )

    const buckets = projectTripCoverageByCity(trip)
    expect(buckets[0]!.view!.total).toBe(3)
    expect(buckets[1]!.view!.total).toBe(1)
  })
})

describe('projectTripCoverageByCity · 单城与降级', () => {
  it('单城（旧行程无 day.city）：1 桶，view 与 projectTripCoverage deep-equal', () => {
    const trip = makeTrip(
      [
        { ...dayWithStops(1, '杭州', ['断桥', '九溪烟树']), city: undefined },
        { ...dayWithStops(2, '杭州', []), city: undefined },
      ],
      { cityProfile: profileWithClassics(['断桥', '灵隐寺']) },
    )

    const buckets = projectTripCoverageByCity(trip)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({ city: '杭州', days: [1, 2] })
    expect(buckets[0]!.view).toEqual(
      projectTripCoverage(trip.days, trip.cityProfile),
    )
  })

  it('空行程 / 无天 / 无城市：返回 []', () => {
    expect(projectTripCoverageByCity(null)).toEqual([])
    expect(projectTripCoverageByCity(undefined)).toEqual([])
    expect(projectTripCoverageByCity(makeTrip([]))).toEqual([])

    const noCity = makeTrip(
      [{ ...dayWithStops(1, '杭州', ['断桥']), city: undefined }],
      { destination: '' },
    )
    expect(projectTripCoverageByCity(noCity)).toEqual([])
  })
})

/**
 * 六期 S7 · 绕行拦截投影测试（lib/detourIntercept.ts）。
 * 全离线纯函数：不读写存储、不发请求、不改行程。
 * 覆盖：97.2km 型命中 / 3 倍但 <30km 不命中 / 山形合理绕行不命中 / 跨城直达不命中 /
 * location 缺失跳过 / 空 days / leg 缺失或距离非法跳过 / 30km 地板边界 /
 * 坐标相同（直线 0）如实标记 / 多条按输入顺序输出。
 */
import { describe, expect, it } from 'vitest'

import type { TripDay, TripLeg, TripLocation, TripStop } from '../lib/api'
import {
  DETOUR_INTERCEPT_MIN_KM,
  DETOUR_INTERCEPT_RATIO,
  formatDetourEvidence,
  formatDetourRatio,
  projectDetourIntercept,
} from '../lib/detourIntercept'

function stop(id: string, name: string, location: TripLocation | null): TripStop {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: 60,
    description: '',
    address: '',
    location,
  }
}

function leg(fromId: string, toId: string, distance_m: number | null): TripLeg {
  return {
    from_stop_id: fromId,
    to_stop_id: toId,
    mode: 'driving',
    route_type: 'navigation',
    distance_m,
    duration_minutes: null,
    geometry: [],
    description: '',
  }
}

function day(dayNumber: number, stops: TripStop[], legs: TripLeg[]): TripDay {
  return { day: dayNumber, date: null, title: `第 ${dayNumber} 天`, summary: '', stops, legs }
}

/** 张家界 97.2km 型：两站直线约 26.26km，规划 97.2km（约 3.70 倍）。 */
const WULINGYUAN: TripLocation = { lng: 110.5465, lat: 29.3455 }
const TIANMENSHAN: TripLocation = { lng: 110.478, lat: 29.117 }

function zhangjiajieDay(actualMeters = 97_200): TripDay {
  return day(
    1,
    [
      stop('s-1', '武陵源标志门', WULINGYUAN),
      stop('s-2', '天门山索道', TIANMENSHAN),
    ],
    [leg('s-1', 's-2', actualMeters)],
  )
}

/** 同经度、给定纬度差的两站（用于可控直线距离）。 */
function northSouthDay(latDelta: number, actualMeters: number): TripDay {
  return day(
    1,
    [
      stop('s-1', '起点', { lng: 110.5, lat: 29.3 }),
      stop('s-2', '终点', { lng: 110.5, lat: 29.3 + latDelta }),
    ],
    [leg('s-1', 's-2', actualMeters)],
  )
}

describe('projectDetourIntercept · 命中与阈值', () => {
  it('97.2km 型：实际 ≥30km 且 ≥ 直线 3 倍 → 命中并给出证据与倍数', () => {
    const hits = projectDetourIntercept([zhangjiajieDay()])

    expect(hits).toHaveLength(1)
    const hit = hits[0]
    expect(hit.day).toBe(1)
    expect(hit.stopIndex).toBe(1)
    expect(hit.fromName).toBe('武陵源标志门')
    expect(hit.toName).toBe('天门山索道')
    expect(hit.straightKm).toBeCloseTo(26.263, 2)
    expect(hit.actualKm).toBeCloseTo(97.2, 6)
    expect(hit.ratio).toBeCloseTo(3.701, 2)
    expect(formatDetourEvidence(hit)).toBe('直线 26.3 km，规划 97.2 km')
    expect(formatDetourRatio(hit)).toBe('约 3.7 倍')
  })

  it('比例 5 倍但实际 <30km → 不命中（30km 地板优先）', () => {
    // 直线约 5.0km，实际 25km：比例约 5 倍，仍低于 30km 地板。
    const hits = projectDetourIntercept([northSouthDay(0.045, 25_000)])
    expect(hits).toEqual([])
  })

  it('山形合理绕行：实际 40km / 直线约 20km（2 倍）→ 不命中', () => {
    const hits = projectDetourIntercept([northSouthDay(0.18, 40_000)])
    expect(hits).toEqual([])
  })

  it('跨城直达：实际 330km / 直线约 300km（1.1 倍）→ 不命中', () => {
    const hits = projectDetourIntercept([northSouthDay(2.7, 330_000)])
    expect(hits).toEqual([])
  })

  it('30km 地板边界：30000m 命中，29999m 不命中', () => {
    // 直线约 9.0km，3 倍为 27.0km，所以两个值都已过比例门槛。
    expect(projectDetourIntercept([northSouthDay(0.081, 30_000)])).toHaveLength(1)
    expect(projectDetourIntercept([northSouthDay(0.081, 29_999)])).toEqual([])
  })

  it('阈值常量是具名导出的 30km / 3 倍', () => {
    expect(DETOUR_INTERCEPT_MIN_KM).toBe(30)
    expect(DETOUR_INTERCEPT_RATIO).toBe(3)
  })
})

describe('projectDetourIntercept · 数据缺失与降级', () => {
  it('任一站 location 缺失 → 跳过该站对，不猜坐标', () => {
    const missingTo = zhangjiajieDay()
    missingTo.stops[1] = stop('s-2', '天门山索道', null)
    expect(projectDetourIntercept([missingTo])).toEqual([])

    const missingFrom = zhangjiajieDay()
    missingFrom.stops[0] = stop('s-1', '武陵源标志门', null)
    expect(projectDetourIntercept([missingFrom])).toEqual([])
  })

  it('坐标非法 → 跳过（haversine 返回 NaN，不按 0 补）', () => {
    const invalid = zhangjiajieDay()
    invalid.stops[1] = { ...invalid.stops[1], location: { lng: 110.478, lat: 999 } }
    expect(projectDetourIntercept([invalid])).toEqual([])
  })

  it('leg 缺失 / distance_m 为 null / 负数 → 跳过', () => {
    const noLeg = zhangjiajieDay()
    noLeg.legs = []
    expect(projectDetourIntercept([noLeg])).toEqual([])

    expect(projectDetourIntercept([zhangjiajieDay()].map((d) => ({ ...d, legs: [leg('s-1', 's-2', null)] })))).toEqual([])
    expect(projectDetourIntercept([zhangjiajieDay()].map((d) => ({ ...d, legs: [leg('s-1', 's-2', -1)] })))).toEqual([])
  })

  it('空 days / null / undefined → 空结果', () => {
    expect(projectDetourIntercept([])).toEqual([])
    expect(projectDetourIntercept(null)).toEqual([])
    expect(projectDetourIntercept(undefined)).toEqual([])
  })

  it('坐标相同（直线 0）：仍按 30km 地板拦截，倍数如实写「无法计算」', () => {
    const same = day(
      1,
      [
        stop('s-1', '同名地点 A', { lng: 110.5, lat: 29.3 }),
        stop('s-2', '同名地点 B', { lng: 110.5, lat: 29.3 }),
      ],
      [leg('s-1', 's-2', 97_200)],
    )
    const hits = projectDetourIntercept([same])
    expect(hits).toHaveLength(1)
    expect(hits[0].ratio).toBe(Number.POSITIVE_INFINITY)
    expect(formatDetourEvidence(hits[0])).toBe('直线 0.0 km（两站坐标相同），规划 97.2 km')
    expect(formatDetourRatio(hits[0])).toBe('倍数无法计算')
  })
})

describe('projectDetourIntercept · 多段与顺序', () => {
  it('全部命中路段按输入顺序输出（天号 / 站序）', () => {
    const day1 = zhangjiajieDay()
    const day2 = day(
      2,
      [
        stop('a', '甲', { lng: 110.5, lat: 29.3 }),
        stop('b', '乙', { lng: 110.5, lat: 29.48 }),
        stop('c', '丙', { lng: 110.5, lat: 29.66 }),
      ],
      [leg('a', 'b', 70_000), leg('b', 'c', 65_000)],
    )

    const hits = projectDetourIntercept([day1, day2])
    expect(hits.map((hit) => [hit.day, hit.stopIndex, hit.fromName, hit.toName])).toEqual([
      [1, 1, '武陵源标志门', '天门山索道'],
      [2, 1, '甲', '乙'],
      [2, 2, '乙', '丙'],
    ])
  })

  it('legs 顺序与站点不一致时按 from/to id 找回正确路段', () => {
    const shuffled = zhangjiajieDay()
    shuffled.legs = [
      leg('x', 'y', 5_000),
      leg('s-1', 's-2', 97_200),
    ]
    const hits = projectDetourIntercept([shuffled])
    expect(hits).toHaveLength(1)
    expect(hits[0].actualKm).toBeCloseTo(97.2, 6)
  })
})

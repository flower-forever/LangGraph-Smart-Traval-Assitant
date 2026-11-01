/**
 * draftWalkingDistance 的离线回归：纯函数只读、口径边界、结构化失败与不可变。
 *
 * 不 mock tripDraft：改动天口径由真实 draftChangedDays 决定，输入直接构造在
 * 夹具上，检查函数不修改任何原对象（deepFreeze 证明）。
 */
import { describe, expect, it } from 'vitest'

import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import { createTripDraft, updateDraftStop, type TripDraft } from '../lib/tripDraft'
import {
  MAX_DAILY_WALKING_DISTANCE_METERS,
  WALKING_DISTANCE_DISCLAIMER,
  dailyWalkingDistanceResult,
  formatWalkingMeters,
  parseDailyWalkingDistanceLimit,
  summarizeDayWalkingDistance,
} from '../lib/draftWalkingDistance'
import { MOCK_TRIP } from './fixtures/trip'

function cloneTrip(trip: Trip = MOCK_TRIP): Trip {
  return JSON.parse(JSON.stringify(trip)) as Trip
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item)
    }
    Object.freeze(value)
  }
  return value
}

function makeDraft(base: Trip, forkTripId = 'trip-fork-walking'): TripDraft {
  const created = createTripDraft(base, { forkTripId, newLegMode: 'walking' })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

function stop(id: string, name: string, time: string): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes: null,
    description: '',
    address: '',
    location: null,
  }
}

function leg(partial: Partial<TripLeg> & { from_stop_id: string; to_stop_id: string }): TripLeg {
  return {
    mode: 'walking',
    route_type: 'navigation',
    distance_m: null,
    duration_minutes: null,
    geometry: [],
    description: '',
    ...partial,
  }
}

function oneDayTrip(legs: TripLeg[]): Trip {
  const day: TripDay = {
    day: 1,
    date: null,
    title: '测试日',
    summary: '',
    stops: [stop('a', '甲站', '09:00'), stop('b', '乙站', '10:00')],
    legs,
  }
  return { ...cloneTrip(), id: 'trip-walking', days: [day] }
}

describe('parseDailyWalkingDistanceLimit', () => {
  it('0 合法，空不是 0（not_entered），负数/小数/非数/超限都是 typed 失败', () => {
    expect(parseDailyWalkingDistanceLimit('0')).toEqual({ ok: true, meters: 0 })
    expect(parseDailyWalkingDistanceLimit('3000')).toEqual({ ok: true, meters: 3000 })
    expect(parseDailyWalkingDistanceLimit(' 500 ')).toEqual({ ok: true, meters: 500 })
    expect(parseDailyWalkingDistanceLimit('100000')).toEqual({
      ok: true,
      meters: MAX_DAILY_WALKING_DISTANCE_METERS,
    })

    const empty = parseDailyWalkingDistanceLimit('')
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.kind).toBe('not_entered')
      expect(empty.message).toContain('留空不等于 0')
    }
    expect(parseDailyWalkingDistanceLimit('   ').ok).toBe(false)

    for (const bad of ['-1', '3.5', 'abc', '3e3', '1,000', '１００', '100001', '999999999999']) {
      const parsed = parseDailyWalkingDistanceLimit(bad)
      expect(parsed.ok, bad).toBe(false)
      if (!parsed.ok) expect(parsed.kind).toBe('invalid')
    }
    const over = parseDailyWalkingDistanceLimit('100001')
    if (!over.ok) expect(over.message).toContain('0–100000')
  })

  it('非字符串 runtime 输入是 typed 失败，不抛未捕获异常；false / null 不当 0', () => {
    for (const bad of [false, null, undefined, 3000, NaN]) {
      const parsed = parseDailyWalkingDistanceLimit(bad as unknown as string)
      expect(parsed.ok, String(bad)).toBe(false)
      if (!parsed.ok) expect(parsed.kind).toBe('invalid')
    }
    expect(parseDailyWalkingDistanceLimit('0').ok).toBe(true)
  })
})

describe('formatWalkingMeters', () => {
  it('整数原样显示；小数与超安全整数用「约」标注估算', () => {
    expect(formatWalkingMeters(0)).toBe('0 米')
    expect(formatWalkingMeters(1250)).toBe('1250 米')
    expect(formatWalkingMeters(1100.5)).toMatch(/^约 1101 米$/)
    const huge = Number.MAX_SAFE_INTEGER + 1.5
    expect(formatWalkingMeters(huge)).toContain('约')
  })
})

describe('summarizeDayWalkingDistance 纳入口径', () => {
  it('只统计 walking+navigation+有效非负 finite 距离；driving、示意、待重取不混入', () => {
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', mode: 'walking', route_type: 'navigation', distance_m: 1100 }),
      leg({ from_stop_id: 'b', to_stop_id: 'a', mode: 'driving', route_type: 'navigation', distance_m: 5000 }),
      // 同一对站点再来一条 walking straight_line：示意距离不进合计
      leg({ from_stop_id: 'a', to_stop_id: 'b', mode: 'walking', route_type: 'straight_line', distance_m: 700 }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.includedLegCount).toBe(1)
    expect(result.includedTotalMeters).toBe(1100)
    expect(result.unknownWalkingLegCount).toBe(1)
    expect(result.drivingLegCount).toBe(1)
    expect(result.status).toBe('under_limit_known_partial')
    expect(result.summary).toContain('未超过')
    expect(result.summary).toContain('不能确认全天步行量')
  })

  it('显式 0 距离是合法记录：合计 0 且不为 null；未知段仍独立可见', () => {
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 0 }),
      leg({ from_stop_id: 'b', to_stop_id: 'a', route_type: 'unavailable', distance_m: null }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.status).toBe('under_limit_known_partial')
    expect(result.includedTotalMeters).toBe(0)
    expect(result.includedLegCount).toBe(1)
    expect(result.unknownWalkingLegCount).toBe(1)
    expect(result.summary).toContain('0 米')
    expect(result.summary).toContain('未知')
  })

  it('小数距离是合法记录：按原值求和，不在数据层取整', () => {
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 1100.5 }),
      leg({ from_stop_id: 'b', to_stop_id: 'a', distance_m: 200.25 }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.includedTotalMeters).toBe(1300.75)
    expect(result.summary).toContain('约 1301 米')
  })

  it('负数、NaN、Infinity 的导航距离都归未知，不进合计也不抛错', () => {
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: -5 }),
      leg({
        from_stop_id: 'b',
        to_stop_id: 'a',
        distance_m: Number.NaN as unknown as number,
      }),
      leg({
        from_stop_id: 'a',
        to_stop_id: 'b',
        distance_m: Number.POSITIVE_INFINITY as unknown as number,
      }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.status).toBe('no_data')
    expect(result.includedTotalMeters).toBeNull()
    expect(result.unknownWalkingLegCount).toBe(3)
    expect(result.summary).toContain('不能当作全天步行 0 米')
  })

  it('未知 mode 不猜 walking，按无充分数据处理不抛错', () => {
    const trip = oneDayTrip([
      leg({
        from_stop_id: 'a',
        to_stop_id: 'b',
        mode: ' teleport ' as unknown as TripLeg['mode'],
        route_type: 'navigation',
        distance_m: 999,
      }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.status).toBe('no_data')
    expect(result.includedLegCount).toBe(0)
    expect(result.unclassifiedLegCount).toBe(1)
    expect(result.summary).toContain('暂无可统计的导航步行距离')
    expect(result.summary).toContain('无法识别')
  })

  it('同日已知导航步行 + 未知 mode：保持覆盖不足，不标 under_limit_full_known', () => {
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 800 }),
      leg({
        from_stop_id: 'b',
        to_stop_id: 'a',
        mode: ' teleport ' as unknown as TripLeg['mode'],
        route_type: 'navigation',
        distance_m: 999,
      }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.status).toBe('under_limit_known_partial')
    expect(result.includedTotalMeters).toBe(800)
    expect(result.includedLegCount).toBe(1)
    expect(result.unclassifiedLegCount).toBe(1)
    expect(result.summary).toContain('未超过')
    expect(result.summary).toContain('无法识别')
    expect(result.summary).toContain('不能确认全天步行量')
  })

  it('全驾车一天不推步行：不冒「步行 0 米」，也不冒合格', () => {
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', mode: 'driving', route_type: 'navigation', distance_m: 12000 }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.status).toBe('no_data')
    expect(result.drivingLegCount).toBe(1)
    expect(result.summary).toContain('驾车路线不计入步行')
    expect(result.summary).toContain('不能当作全天步行 0 米')
    // 合计字段保持 null 而不是 0
    expect(result.includedTotalMeters).toBeNull()
  })

  it('无任何可纳入段：合计 null + 暂无可统计文案，绝不假 0', () => {
    const result = summarizeDayWalkingDistance(deepFreeze(oneDayTrip([]).days[0]), 3000)
    expect(result.status).toBe('no_data')
    expect(result.includedTotalMeters).toBeNull()
    expect(result.summary).toContain('暂无可统计的导航步行距离')
  })
})

describe('summarizeDayWalkingDistance 比较与 unsafe', () => {
  it('已知部分合计超上限：明确提醒已记录超限，未知段提示可能更多', () => {
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 2000 }),
      leg({ from_stop_id: 'b', to_stop_id: 'a', route_type: 'straight_line', distance_m: 100 }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 1500)
    expect(result.status).toBe('over_limit')
    expect(result.includedTotalMeters).toBe(2000)
    expect(result.summary).toContain('超过你设置的每天 1500 米上限')
    expect(result.summary).toContain('可能更多')
  })

  it('全已知未超限：只说记录未超，不说全天合格', () => {
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 1200 }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 1500)
    expect(result.status).toBe('under_limit_full_known')
    expect(result.summary).toContain('未超过')
    expect(result.summary).toContain('不代表实际全天步行量')
  })

  it('上限 0：有已记录距离就超限；合计 0 时恰好等于上限不算超', () => {
    const above = summarizeDayWalkingDistance(
      deepFreeze(oneDayTrip([leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 1 })]).days[0]),
      0,
    )
    expect(above.status).toBe('over_limit')

    const zero = summarizeDayWalkingDistance(
      deepFreeze(oneDayTrip([leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 0 })]).days[0]),
      0,
    )
    expect(zero.status).toBe('under_limit_full_known')
  })

  it('上限本身非法（负数 / 小数 / NaN）时 typed 拒绝，不产生比较结论', () => {
    for (const bad of [-1, 3.5, Number.NaN]) {
      const result = summarizeDayWalkingDistance(
        deepFreeze(oneDayTrip([leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 100 })]).days[0]),
        bad,
      )
      expect(result.status, String(bad)).toBe('invalid_limit')
      expect(result.includedTotalMeters).toBeNull()
      expect(result.summary).toContain('未执行')
    }
  })

  it('合计不能安全表示（超安全整数）：unsafe_sum，不返回 0 或假合格', () => {
    const big = Number.MAX_SAFE_INTEGER
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: big }),
      leg({ from_stop_id: 'b', to_stop_id: 'a', distance_m: 1000 }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.status).toBe('unsafe_sum')
    expect(result.includedTotalMeters).toBeNull()
    expect(result.includedLegCount).toBe(2)
    expect(result.summary).toContain('无法安全表示')
    expect(result.summary).toContain('未裁剪')
  })

  it('单段距离本身就非有限的情况不会走到求和；Infinity 大数相加也触发 unsafe', () => {
    // 距离是有限大数但两段相加溢出安全整数：unsafe，而不是裁值或 0。
    const near = Number.MAX_SAFE_INTEGER - 10
    const trip = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: near }),
      leg({ from_stop_id: 'b', to_stop_id: 'a', distance_m: near }),
    ])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.status).toBe('unsafe_sum')
  })
})

describe('dailyWalkingDistanceResult 范围与结构', () => {
  it('all_days 检查所有天，changed_days 只查真正改过的天', () => {
    const base = cloneTrip()
    // 第 3 天本身没有 legs；先看 all_days 覆盖 1..3
    let draft = makeDraft(deepFreeze(base))
    const all = dailyWalkingDistanceResult(draft, 3000, 'all_days')
    if (!all.ok) throw new Error(all.message)
    expect(all.days.map((item) => item.day)).toEqual([1, 2, 3])

    const before = dailyWalkingDistanceResult(draft, 3000, 'changed_days')
    if (!before.ok) throw new Error(before.message)
    expect(before.days).toEqual([])

    // 改第 1 天一处描述：changed_days 只返回第 1 天
    const edited = updateDraftStop(draft, 1, 's1', { description: '触发改动' })
    if (!edited.ok) throw new Error(edited.message)
    draft = edited.draft
    const after = dailyWalkingDistanceResult(draft, 3000, 'changed_days')
    if (!after.ok) throw new Error(after.message)
    expect(after.days.map((item) => item.day)).toEqual([1])
  })

  it('changed_days 且没有改动天时给出「没有已改天可检查」语义（空列表，不冒未超限）', () => {
    const draft = makeDraft(cloneTrip())
    const result = dailyWalkingDistanceResult(draft, 3000, 'changed_days')
    if (!result.ok) throw new Error(result.message)
    expect(result.days).toEqual([])
    // 界面据此显示「没有已改天可检查」，这里验证纯函数层面不产出任何天结论。
  })

  it('上限非法：结构化错误而不是抛错；0 与 100000 是合法边界', () => {
    const draft = makeDraft(cloneTrip())
    for (const bad of [-1, 100001, 3.5, NaN, null]) {
      const result = dailyWalkingDistanceResult(
        draft,
        bad as unknown as number,
        'all_days',
      )
      expect(result.ok, String(bad)).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('invalid_limit')
        expect(result.message).toContain('未执行')
      }
    }
    expect(dailyWalkingDistanceResult(draft, 0, 'all_days').ok).toBe(true)
    expect(
      dailyWalkingDistanceResult(draft, MAX_DAILY_WALKING_DISTANCE_METERS, 'all_days').ok,
    ).toBe(true)
    const badScope = dailyWalkingDistanceResult(
      draft,
      3000,
      'per_week' as unknown as 'all_days',
    )
    expect(badScope.ok).toBe(false)
  })
})

describe('不可变与文案边界', () => {
  it('检查前后草稿保持同一引用且未被修改（deepFreeze + JSON 比对）', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)
    const before = JSON.stringify(draft)
    const result = dailyWalkingDistanceResult(draft, 3000, 'all_days')
    if (!result.ok) throw new Error(result.message)
    expect(JSON.stringify(draft)).toBe(before)
    expect(draft.days).toBe(base.days)
  })

  it('固定口径文案存在且不出现「全天未超限/轻松走完」类肯定结论', () => {
    expect(WALKING_DISTANCE_DISCLAIMER).toContain('导航步行')
    expect(WALKING_DISTANCE_DISCLAIMER).toContain('不代表实际全天步行量')
    expect(WALKING_DISTANCE_DISCLAIMER).toContain('未重新核实')

    const trip = oneDayTrip([leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 10 })])
    const result = summarizeDayWalkingDistance(deepFreeze(trip.days[0]), 3000)
    expect(result.summary).not.toContain('全天未超')
    expect(result.summary).not.toContain('轻松走完')
    expect(result.summary).not.toContain('可以走完')
  })

  it('大站数旧数据不被卡住：100 段混合路线照常汇总不抛错', () => {
    const legs: TripLeg[] = Array.from({ length: 100 }, (_, index) =>
      leg({
        from_stop_id: `a${index}`,
        to_stop_id: `b${index}`,
        route_type: index % 2 === 0 ? 'navigation' : 'unavailable',
        distance_m: index % 2 === 0 ? index * 3 : null,
      }),
    )
    const result = summarizeDayWalkingDistance(deepFreeze(oneDayTrip(legs).days[0]), 3000)
    expect(result.includedLegCount).toBe(50)
    expect(result.unknownWalkingLegCount).toBe(50)
    expect(result.includedTotalMeters).toBe(
      Array.from({ length: 50 }, (_, i) => i * 6).reduce((a, b) => a + b, 0),
    )
  })

  it('leg 结构非法（null / 缺 mode）按无充分数据处理，不抛错也不猜 walking', () => {
    const day = oneDayTrip([
      leg({ from_stop_id: 'a', to_stop_id: 'b', distance_m: 500 }),
    ]).days[0]
    const broken = [
      null,
      { route_type: 'navigation', distance_m: 300 },
    ] as unknown as TripDay['legs']
    const result = summarizeDayWalkingDistance(
      deepFreeze({ ...day, legs: [...day.legs, ...broken] } as TripDay),
      3000,
    )
    expect(result.status).toBe('under_limit_known_partial')
    expect(result.includedLegCount).toBe(1)
    expect(result.unclassifiedLegCount).toBe(2)
    expect(result.summary).toContain('无法识别')
    expect(result.summary).toContain('不能确认全天步行量')
  })
})

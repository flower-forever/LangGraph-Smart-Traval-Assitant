/**
 * 七期 S5 · 体检分城：城际转移豁免 / 城际合理性规则 / backtrack 防御性豁免。
 *
 * 离线、确定性：全部走构造的 TripDay + 下一日，不碰存储、不发请求。
 * 口径：
 * - 城际段由 `leg.transferKind === 'intercity'` 识别，归属出发日尾部（连接当日末站与次日首站）。
 * - 同日 detour 不看城际段；城际绕行交给 `intercity_transfer`（1.6 倍直线）。
 * - backtrack 只吃 stops，追加城际 leg 前后结果必须完全一致（PM 裁决的防御性口径）。
 */
import { describe, expect, it } from 'vitest'
import type { TripDay, TripLeg, TripStop } from '../lib/api'
import { inspectDayHealth, type HealthItem } from '../lib/itineraryHealth'
import type { StopFacts } from '../lib/stopFacts'

/* ───────── 构造器 ───────── */

let seq = 0
function makeStop(overrides: Partial<TripStop> = {}): TripStop {
  seq += 1
  return {
    id: `s${seq}`,
    name: `站点${seq}`,
    time: '09:00',
    duration_minutes: 60,
    description: '',
    address: '',
    location: null,
    ...overrides,
  }
}

function makeLeg(from: TripStop, to: TripStop, overrides: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: from.id,
    to_stop_id: to.id,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 500,
    duration_minutes: 10,
    geometry: [],
    description: '',
    ...overrides,
  }
}

function makeDay(
  stops: TripStop[],
  options: { date?: string | null; legs?: TripLeg[]; legOverrides?: Partial<TripLeg> } = {},
): TripDay {
  const legs =
    options.legs ??
    stops.slice(0, -1).map((stop, i) => makeLeg(stop, stops[i + 1], options.legOverrides))
  return {
    day: 1,
    date: options.date === undefined ? '2026-05-04' : options.date,
    title: '第一天',
    summary: '',
    stops,
    legs,
  }
}

function noFacts(stops: readonly TripStop[]): Array<StopFacts | null> {
  return stops.map(() => null)
}

function itemOf(report: { items: HealthItem[] }, code: HealthItem['code']): HealthItem | undefined {
  return report.items.find((item) => item.code === code)
}

/** 杭州 → 苏州直线约 121 公里：S1 城际 straight_line 距离的典型尺度。 */
const HANGZHOU = { lng: 120.1551, lat: 30.2741 }
const SUZHOU = { lng: 120.5853, lat: 31.2989 }

/** 一天只有末站，城际 leg 挂在日尾，指向次日首站（S1 契约）。 */
function intercityScenario(options: {
  legOverrides?: Partial<TripLeg>
  nextFirstTime?: string
  lastOverrides?: Partial<TripStop>
} = {}): { day: TripDay; nextDay: TripDay } {
  const last = makeStop({
    name: '杭州末站',
    time: '18:00',
    duration_minutes: 60,
    location: HANGZHOU,
    ...options.lastOverrides,
  })
  const first = makeStop({
    name: '苏州首站',
    time: options.nextFirstTime ?? '21:30',
    duration_minutes: 60,
    location: SUZHOU,
  })
  const day = makeDay([last], {
    legs: [
      makeLeg(last, first, {
        transferKind: 'intercity',
        distance_m: 121_000,
        duration_minutes: 131,
        ...options.legOverrides,
      }),
    ],
  })
  return { day, nextDay: { ...makeDay([first]), day: 2 } }
}

/* ───────── 1. detour 豁免 ───────── */

describe('S5 · 城际段与 detour', () => {
  it('1. 城际 121km 段不触发 detour；同日普通 35km 段仍触发', () => {
    // 防御性用例：把城际段放在同日相邻站对上（契约外，但「漏跳过」变异必须被抓住）。
    const last = makeStop({ name: '杭州末站', time: '18:00', location: HANGZHOU })
    const first = makeStop({ name: '苏州首站', time: '09:00', location: SUZHOU })
    const day = makeDay([last, first], {
      legs: [
        makeLeg(last, first, {
          transferKind: 'intercity',
          distance_m: 121_000,
          duration_minutes: 131,
        }),
      ],
    })
    const nextDay = makeDay([
      makeStop({ name: '苏州次日首站', time: '21:30', location: SUZHOU }),
    ])
    const intercityReport = inspectDayHealth(day, 'balanced', noFacts(day.stops), nextDay)
    expect(itemOf(intercityReport, 'detour')).toBeUndefined()

    const a = makeStop({ location: { lng: 120.0, lat: 30.0 } })
    const b = makeStop({ location: { lng: 120.3, lat: 30.0 } })
    const ordinary = makeDay([a, b], { legOverrides: { distance_m: 35_000 } })
    expect(itemOf(inspectDayHealth(ordinary, 'balanced', noFacts(ordinary.stops)), 'detour')?.level).toBe(
      'notice',
    )
  })
})

/* ───────── 2. intercity_transfer ───────── */

describe('S5 · 城际合理性（intercity_transfer）', () => {
  it('2. 城际 leg 缺坐标 / unavailable → unknown，不崩', () => {
    const { day, nextDay } = intercityScenario({
      legOverrides: { route_type: 'unavailable', distance_m: null, duration_minutes: null, geometry: [] },
      lastOverrides: { location: null },
    })
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops), nextDay)
    const item = itemOf(report, 'intercity_transfer')
    expect(item?.level).toBe('unknown')
    expect(item?.message).toContain('无法完整核对城际转移')
    expect(item?.suggestion).toBeNull()
  })

  it('3. 时间窗不足：末站 18:00+60 停留 + 131 分钟，次日 20:30 到达 → notice；22:00 → 无 notice', () => {
    const tight = intercityScenario({ nextFirstTime: '20:30' })
    const tightItem = itemOf(
      inspectDayHealth(tight.day, 'balanced', noFacts(tight.day.stops), tight.nextDay),
      'intercity_transfer',
    )
    expect(tightItem?.level).toBe('notice')
    expect(tightItem?.message).toContain('城际转移时间不足')

    const relaxed = intercityScenario({ nextFirstTime: '22:00' })
    const relaxedItem = itemOf(
      inspectDayHealth(relaxed.day, 'balanced', noFacts(relaxed.day.stops), relaxed.nextDay),
      'intercity_transfer',
    )
    expect(relaxedItem).toBeUndefined()
  })

  it('4. 绕行异常：distance_m=300km 但两端直线 121km（>1.6×）→ notice', () => {
    const { day, nextDay } = intercityScenario({
      legOverrides: { distance_m: 300_000 },
      nextFirstTime: '23:00',
      lastOverrides: { time: '08:00' },
    })
    const item = itemOf(
      inspectDayHealth(day, 'balanced', noFacts(day.stops), nextDay),
      'intercity_transfer',
    )
    expect(item?.level).toBe('notice')
    expect(item?.message).toContain('城际转移绕行异常')
  })

  it('5. 单城 / 无城际 leg → 新规则不出现，原有规则顺序与文案不变', () => {
    const a = makeStop({ name: 'A', time: '09:00', duration_minutes: 60, location: { lng: 0, lat: 0 } })
    const b = makeStop({ name: 'B', time: '11:00', duration_minutes: 180, location: { lng: 3, lat: 0 } })
    const c = makeStop({ name: 'C', time: '15:00', duration_minutes: 60, location: { lng: 0, lat: 0.001 } })
    const day = makeDay([a, b, c], {
      date: null,
      legs: [makeLeg(a, b, { distance_m: 333_000 }), makeLeg(b, c)],
    })
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))

    expect(report.items.map((item) => item.code)).toEqual([
      'opening_conflict',
      'closed_day',
      'meal_gap',
      'backtrack',
      'detour',
    ])
    expect(itemOf(report, 'intercity_transfer')).toBeUndefined()
    expect(itemOf(report, 'opening_conflict')?.message).toBe(
      '无法核对 3 个站点的营业时间是否冲突。',
    )
    expect(itemOf(report, 'closed_day')?.message).toBe(
      '无法核对闭馆日：这一天没有可解析的日期。',
    )
    expect(itemOf(report, 'meal_gap')?.message).toContain('正餐窗口偏紧')
    expect(itemOf(report, 'detour')?.message).toBe(
      '第 1→2 站路段约 333.0 公里，明显超出城市游览的常见尺度，可能存在绕行。',
    )
  })

  it('6. backtrack：同一天追加 intercity leg 前后结果 deep-equal', () => {
    const a = makeStop({ location: { lng: 0, lat: 0 } })
    const b = makeStop({ location: { lng: 3, lat: 0 } })
    const c = makeStop({ location: { lng: 0, lat: 0.001 } })
    const day = makeDay([a, b, c])
    const nextStop = makeStop({ name: '次日首站', time: '09:00', location: { lng: 3, lat: 0 } })

    const before = itemOf(inspectDayHealth(day, 'balanced', noFacts(day.stops)), 'backtrack')
    expect(before?.level).toBe('notice')

    const augmented: TripDay = {
      ...day,
      legs: [
        ...day.legs,
        makeLeg(c, nextStop, {
          transferKind: 'intercity',
          distance_m: 333_000,
          duration_minutes: 131,
        }),
      ],
    }
    const augmentedReport = inspectDayHealth(augmented, 'balanced', noFacts(day.stops))
    // 固定顺序：intercity_transfer 在 pace 之后、backtrack 之前。
    expect(augmentedReport.items.map((item) => item.code)).toEqual([
      'opening_conflict',
      'closed_day',
      'pace',
      'intercity_transfer',
      'backtrack',
    ])
    expect(itemOf(augmentedReport, 'backtrack')).toEqual(before)
  })
})

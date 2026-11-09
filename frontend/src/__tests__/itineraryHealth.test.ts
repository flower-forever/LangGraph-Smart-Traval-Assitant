/**
 * S3 · 行程体检纯函数测试（itineraryHealth.ts）。
 * 离线、确定性：不碰存储、不发请求；全部走构造的 TripDay。
 *
 * 覆盖规格 A 六类规则 + 可选 detour + 三档节奏阈值可区分 + 未知数据 → 无法核对。
 */
import { describe, expect, it } from 'vitest'
import type { TripDay, TripLeg, TripStop } from '../lib/api'
import {
  DETOUR_KM_LIMIT,
  inspectDayHealth,
  paceLabelOf,
  PACE_LIMITS,
  type HealthItem,
} from '../lib/itineraryHealth'
import type { StopFacts } from '../lib/stopFacts'
import { projectStopFacts } from '../lib/stopFacts'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import { createEmptyPoiCardsRecord, createPoiCard } from '../lib/poiCards'

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

/** 构造一天：stops + 顺序衔接的 legs（默认 navigation 10 分钟每段）。 */
function makeDay(
  stops: TripStop[],
  options: { date?: string | null; legOverrides?: Partial<TripLeg> } = {},
): TripDay {
  const legs = stops.slice(0, -1).map((stop, i) => makeLeg(stop, stops[i + 1], options.legOverrides))
  return {
    day: 1,
    date: options.date === undefined ? '2026-05-04' : options.date, // 2026-05-04 是周一
    title: '第一天',
    summary: '',
    stops,
    legs,
  }
}

/** 事实查询：全部「无卡」（openingHours unknown）；用 inline facts 覆盖。 */
function noFacts(stops: TripStop[]): Array<StopFacts | null> {
  return stops.map(() => null)
}

/** 用资料卡投影出 openingHours=sourced 的 facts（复用 S2 投影，口径一致）。 */
function makeRecord(cards: Array<{ name: string; openingHours: string }>): PoiCardsRecordV1 | null {
  const empty = createEmptyPoiCardsRecord(1000)
  if (!empty.ok) throw new Error(empty.message)
  const NOW = 1_800_000_000_000
  const built = cards.map((card, i) => {
    const created = createPoiCard(
      {
        id: `card-${i}`,
        name: card.name,
        intro: '',
        openingHours: card.openingHours,
        ticket: '',
        provenance: {
          intro: null,
          openingHours: { source: 'manual', detail: '手工粘贴', recordedAt: NOW },
          ticket: null,
        },
      },
      1000,
    )
    if (!created.ok) throw new Error(created.message)
    return created.value
  })
  return { ...empty.value, cards: built }
}

/** 通过 S2 投影把资料卡映射到各站（找不到卡的站 → matched=false 全 unknown）。 */
function factsFromRecord(
  stops: TripStop[],
  record: PoiCardsRecordV1 | null,
): Array<StopFacts | null> {
  const NOW = 1_800_000_000_000
  return stops.map((stop) => projectStopFacts(stop, record, NOW))
}

/* ───────── 断言小工具 ───────── */

function itemOf(report: { items: HealthItem[] }, code: HealthItem['code']): HealthItem | undefined {
  return report.items.find((item) => item.code === code)
}

/** 断言全程没有「已确认可行」这类过度承诺。 */
function expectNoFalseCertainty(items: readonly HealthItem[]): void {
  for (const item of items) {
    expect(item.message).not.toContain('已确认可行')
    expect(item.evidence).not.toContain('已确认可行')
    expect(item.message).not.toContain('已核实')
    expect(item.evidence).not.toContain('已核实')
  }
}

/* ───────── 1. 十类问题行程 ───────── */

describe('inspectDayHealth · 十类问题行程', () => {
  it('1. 闭馆日：周一到达「周一闭馆」站点 → warning，evidence 引用文本与星期', () => {
    const stops = [makeStop({ name: '市博物馆', time: '09:00' })]
    const day = makeDay(stops, { date: '2026-05-04' }) // 周一
    const record = makeRecord([{ name: '市博物馆', openingHours: '周一闭馆' }])
    const report = inspectDayHealth(day, 'balanced', factsFromRecord(stops, record))

    const item = itemOf(report, 'closed_day')
    expect(item?.level).toBe('warning')
    expect(item?.message).toContain('闭馆日')
    expect(item?.evidence).toContain('周一闭馆')
    expect(item?.evidence).toContain('周一')
    expectNoFalseCertainty(report.items)
  })

  it('2. 到得太早：营业「09:00-17:00」、到达 08:00 → opening_conflict warning + evidence', () => {
    const stops = [makeStop({ name: '美术馆', time: '08:00' })]
    const day = makeDay(stops)
    const record = makeRecord([{ name: '美术馆', openingHours: '09:00-17:00' }])
    const report = inspectDayHealth(day, 'balanced', factsFromRecord(stops, record))

    const item = itemOf(report, 'opening_conflict')
    expect(item?.level).toBe('warning')
    expect(item?.message).toContain('营业时间之外')
    expect(item?.evidence).toContain('09:00-17:00')
    expect(item?.evidence).toContain('08:00')
    expectNoFalseCertainty(report.items)
  })

  it('3. 到得太晚：营业「09:00-17:00」、到达 17:30 → opening_conflict warning + evidence', () => {
    const stops = [makeStop({ name: '美术馆', time: '17:30' })]
    const day = makeDay(stops)
    const record = makeRecord([{ name: '美术馆', openingHours: '09:00-17:00' }])
    const report = inspectDayHealth(day, 'balanced', factsFromRecord(stops, record))

    const item = itemOf(report, 'opening_conflict')
    expect(item?.level).toBe('warning')
    expect(item?.evidence).toContain('17:30')
    expectNoFalseCertainty(report.items)
  })

  it('4. 午餐缺失：站点占满午餐窗口 → meal_gap notice，不认定沿途有餐馆', () => {
    // 11:00 到达 + 180 分钟停留 → 占满 11:30-13:30 整个午餐窗口
    const stops = [makeStop({ time: '11:00', duration_minutes: 180 })]
    const day = makeDay(stops)
    const report = inspectDayHealth(day, 'balanced', noFacts(stops))

    const item = itemOf(report, 'meal_gap')
    expect(item?.level).toBe('notice')
    expect(item?.message).toContain('午餐')
    expect(item?.evidence).toContain('不确认沿途是否有餐馆')
    expectNoFalseCertainty(report.items)
  })

  it('5. 晚餐缺失：站点占满晚餐窗口 → meal_gap notice', () => {
    // 17:00 到达 + 180 分钟停留 → 占满 17:30-19:30 晚餐窗口
    const stops = [makeStop({ time: '17:00', duration_minutes: 180 })]
    const day = makeDay(stops)
    const report = inspectDayHealth(day, 'balanced', noFacts(stops))

    const item = itemOf(report, 'meal_gap')
    expect(item?.level).toBe('notice')
    expect(item?.message).toContain('晚餐')
    expectNoFalseCertainty(report.items)
  })

  it('6. 日跨度过长：balanced 上限 10h，行程 11h → pace notice + evidence', () => {
    // 08:00 到达 + 600 分钟末站停留 → 跨度 600 分钟 = 10h，需要再超一点
    const stops = [makeStop({ time: '08:00', duration_minutes: 60 })]
    const end = makeStop({ time: '19:30', duration_minutes: 120 }) // 离开 21:30，跨度 13.5h
    const day = makeDay([stops[0], end])
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))

    const item = itemOf(report, 'pace')
    expect(item?.level).toBe('notice')
    expect(item?.evidence).toContain('日跨度')
    expect(item?.evidence).toContain('上限')
    expectNoFalseCertainty(report.items)
  })

  it('7. 站太多：balanced 上限 6 站，7 站 → pace notice', () => {
    const stops = Array.from({ length: 7 }, (_, i) => makeStop({ time: `${9 + i}:00` }))
    const day = makeDay(stops)
    const report = inspectDayHealth(day, 'balanced', noFacts(stops))

    const item = itemOf(report, 'pace')
    expect(item?.level).toBe('notice')
    expect(item?.evidence).toContain('超过')
    expect(item?.evidence).toContain('上限 6 个')
  })

  it('8. 缓冲不足：到达+停留+路段 ≥ 下一站到达 → pace notice + evidence', () => {
    // 09:00 到 + 60 停 + 30 路 = 10:30，下一站 10:20 到达 → 缓冲 -10 分钟
    const a = makeStop({ time: '09:00', duration_minutes: 60 })
    const b = makeStop({ time: '10:20', duration_minutes: 60 })
    const day = makeDay([a, b], { legOverrides: { duration_minutes: 30 } })
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))

    const item = itemOf(report, 'pace')
    expect(item?.level).toBe('notice')
    expect(item?.evidence).toContain('缓冲')
    expect(item?.evidence).toContain('低于')
    expectNoFalseCertainty(report.items)
  })

  it('9. 折返：相邻交换缩短 ≥10% → backtrack notice，evidence 说明口径', () => {
    // A(0,0) → B(3,0) → C(0,0.001)：交换 A/B 缩短明显
    const a = makeStop({ location: { lng: 0.0, lat: 0.0 } })
    const b = makeStop({ location: { lng: 3.0, lat: 0.0 } })
    const c = makeStop({ location: { lng: 0.0, lat: 0.001 } })
    const day = makeDay([a, b, c])
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))

    const item = itemOf(report, 'backtrack')
    expect(item?.level).toBe('notice')
    expect(item?.message).toContain('顺序可优化')
    expect(item?.evidence).toContain('不是全局最优')
    expect(item?.suggestion).toContain('不会自动修改')
    expectNoFalseCertainty(report.items)
  })

  it('10. 时间未知：缺到达时间+缺停留+路段待重取 → unknown_time + meal/pace 无法核对', () => {
    const a = makeStop({ time: '', duration_minutes: null })
    const b = makeStop({ time: '', duration_minutes: null })
    const day = makeDay([a, b], { legOverrides: { route_type: 'unavailable', duration_minutes: null } })
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))

    const item = itemOf(report, 'unknown_time')
    expect(item?.level).toBe('unknown')
    expect(item?.message).toContain('人工确认')
    expect(item?.evidence).toContain('不按 0 补齐')

    // 用餐与节奏都因缺时间 → unknown，绝不按 0 补出「没问题」
    expect(itemOf(report, 'meal_gap')?.level).toBe('unknown')
    const pace = itemOf(report, 'pace')
    expect(pace?.level).toBe('unknown')
    expectNoFalseCertainty(report.items)
  })
})

/* ───────── 2. 保守判定：解析不了 → 无法核对 ───────── */

describe('inspectDayHealth · 保守判定与无法核对', () => {
  it('营业时间「全天」等多段/含糊文本 → opening_conflict unknown（不猜）', () => {
    const stops = [makeStop({ name: '老街', time: '08:00' })]
    const day = makeDay(stops)
    const record = makeRecord([{ name: '老街', openingHours: '全天开放' }])
    const report = inspectDayHealth(day, 'balanced', factsFromRecord(stops, record))

    const item = itemOf(report, 'opening_conflict')
    expect(item?.level).toBe('unknown')
    expect(item?.message).toContain('无法核对')
    expect(item?.evidence).toContain('不猜不判')
  })

  it('无卡站点 → opening_conflict unknown；不冒充「无冲突」', () => {
    const stops = [makeStop({ time: '08:00' })]
    const day = makeDay(stops)
    const report = inspectDayHealth(day, 'balanced', noFacts(stops))

    const item = itemOf(report, 'opening_conflict')
    expect(item?.level).toBe('unknown')
    expect(item?.message).toContain('无法核对')
  })

  it('日期缺失 → closed_day unknown（不因没日期就说没问题）', () => {
    const stops = [makeStop({ name: '市博物馆' })]
    const day = makeDay(stops, { date: null })
    const record = makeRecord([{ name: '市博物馆', openingHours: '周一闭馆' }])
    const report = inspectDayHealth(day, 'balanced', factsFromRecord(stops, record))

    const item = itemOf(report, 'closed_day')
    expect(item?.level).toBe('unknown')
    expect(item?.message).toContain('无法核对')
  })

  it('闭馆文本含糊（区间写法）→ closed_day unknown', () => {
    const stops = [makeStop({ name: '市博物馆' })]
    const day = makeDay(stops, { date: '2026-05-04' }) // 周一
    const record = makeRecord([{ name: '市博物馆', openingHours: '闭馆日另行通知' }])
    const report = inspectDayHealth(day, 'balanced', factsFromRecord(stops, record))

    const item = itemOf(report, 'closed_day')
    expect(item?.level).toBe('unknown')
  })

  it('日期与文本都明确但不是闭馆日 → 不报 closed_day（正常日不误报）', () => {
    const stops = [makeStop({ name: '市博物馆', time: '10:00' })]
    const day = makeDay(stops, { date: '2026-05-05' }) // 周二，闭馆日是周一
    const record = makeRecord([{ name: '市博物馆', openingHours: '周一闭馆' }])
    const report = inspectDayHealth(day, 'balanced', factsFromRecord(stops, record))

    expect(itemOf(report, 'closed_day')).toBeUndefined()
  })

  it('空行程（无站点）→ 无 pace/meal/closed 项，不产出噪音', () => {
    const day = makeDay([])
    const report = inspectDayHealth(day, 'balanced', [])
    expect(report.items).toHaveLength(0)
    expect(report.counts).toEqual({ warning: 0, notice: 0, unknown: 0 })
  })

  it('正常行程（时间齐全、缓冲充足、午餐窗口留空）→ 零问题，绝无「已确认可行」字样', () => {
    // 09:00 到 + 90 停 = 10:30；路 10 分钟；下一站 11:30 到（缓冲 50 分钟），
    // 11:30 + 60 = 12:30，午餐窗口 11:30-13:30 内有 11:30-13:30 空档？→ 占用 11:30-12:30，剩 60 分钟 ≥45 ✓
    const a = makeStop({ time: '09:00', duration_minutes: 90 })
    const b = makeStop({ time: '11:30', duration_minutes: 60 })
    const day = makeDay([a, b], { legOverrides: { duration_minutes: 10 } })
    const record = makeRecord([
      { name: a.name, openingHours: '08:00-18:00' },
      { name: b.name, openingHours: '11:00-20:00' },
    ])
    const report = inspectDayHealth(day, 'balanced', factsFromRecord(day.stops, record))

    expect(report.items).toHaveLength(0)
    expect(report.counts).toEqual({ warning: 0, notice: 0, unknown: 0 })
    expectNoFalseCertainty(report.items)
  })

  it('detour：单段 distance_m ≥ 30km → detour notice；低于阈值不报', () => {
    const a = makeStop({ location: { lng: 120.0, lat: 30.0 } })
    const b = makeStop({ location: { lng: 120.0, lat: 30.0 } })
    const day = makeDay([a, b], { legOverrides: { distance_m: DETOUR_KM_LIMIT * 1000 + 5_000_000 } })
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))
    expect(itemOf(report, 'detour')?.level).toBe('notice')

    const small = makeDay([a, b], { legOverrides: { distance_m: 5_000 } })
    expect(itemOf(inspectDayHealth(small, 'balanced', noFacts(day.stops)), 'detour')).toBeUndefined()
  })

  it('detour：距离缺失时沉默（unknown_time 已覆盖，不重复报）', () => {
    const a = makeStop({ location: { lng: 120.0, lat: 30.0 } })
    const b = makeStop({ location: { lng: 121.0, lat: 30.0 } })
    const day = makeDay([a, b], { legOverrides: { distance_m: null } })
    expect(itemOf(inspectDayHealth(day, 'balanced', noFacts(day.stops)), 'detour')).toBeUndefined()
  })
})

/* ───────── 3. 三档节奏阈值可区分 ───────── */

describe('inspectDayHealth · 三档节奏阈值', () => {
  const buildDayWithStops = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeStop({ time: `${String(9 + i).padStart(2, '0')}:00`, duration_minutes: 30 }),
    )

  it('5 站：relaxed 报超站、balanced/packed 不报 → 阈值可区分', () => {
    const stops = buildDayWithStops(5)
    const day = makeDay(stops)
    const relaxed = itemOf(inspectDayHealth(day, 'relaxed', noFacts(stops)), 'pace')
    const balanced = itemOf(inspectDayHealth(day, 'balanced', noFacts(stops)), 'pace')
    const packed = itemOf(inspectDayHealth(day, 'packed', noFacts(stops)), 'pace')

    expect(relaxed?.evidence).toContain('超过')
    expect(relaxed?.evidence).toContain('上限 4 个')
    expect(balanced).toBeUndefined()
    expect(packed).toBeUndefined()
  })

  it('7 站：balanced 报超站、packed 不报', () => {
    const stops = buildDayWithStops(7)
    const day = makeDay(stops)
    expect(itemOf(inspectDayHealth(day, 'balanced', noFacts(stops)), 'pace')?.evidence).toContain('超过')
    expect(itemOf(inspectDayHealth(day, 'packed', noFacts(stops)), 'pace')).toBeUndefined()
  })

  it('日跨度 9h：relaxed（≤8h）报、balanced（≤10h）不报', () => {
    // 08:00 到 → 17:00 离开 = 9h
    const a = makeStop({ time: '08:00', duration_minutes: 60 })
    const b = makeStop({ time: '15:00', duration_minutes: 120 }) // 离开 17:00
    const day = makeDay([a, b], { legOverrides: { duration_minutes: 20 } }) // 缓冲 08:00+60+20=09:40 → 15:00 大缓冲 ✓
    const relaxed = itemOf(inspectDayHealth(day, 'relaxed', noFacts(day.stops)), 'pace')
    const balanced = itemOf(inspectDayHealth(day, 'balanced', noFacts(day.stops)), 'pace')

    expect(relaxed?.evidence).toContain('日跨度')
    expect(balanced).toBeUndefined()
  })

  it('缓冲 12 分钟：packed（≥10）不报、balanced（≥15）报', () => {
    // 09:00 到 + 60 停 + 6 路 = 10:06，下一站 10:18 到 → 缓冲 12 分钟
    const a = makeStop({ time: '09:00', duration_minutes: 60 })
    const b = makeStop({ time: '10:18', duration_minutes: 60 })
    const day = makeDay([a, b], { legOverrides: { duration_minutes: 6 } })
    const balanced = itemOf(inspectDayHealth(day, 'balanced', noFacts(day.stops)), 'pace')
    const packed = itemOf(inspectDayHealth(day, 'packed', noFacts(day.stops)), 'pace')

    expect(balanced?.evidence).toContain('缓冲')
    expect(packed).toBeUndefined()
  })

  it('PACE_LIMITS 表钉住：三档阈值与规格一致', () => {
    expect(PACE_LIMITS.relaxed).toEqual({ maxStops: 4, maxDaySpanMinutes: 480, minBufferMinutes: 20 })
    expect(PACE_LIMITS.balanced).toEqual({ maxStops: 6, maxDaySpanMinutes: 600, minBufferMinutes: 15 })
    expect(PACE_LIMITS.packed).toEqual({ maxStops: 8, maxDaySpanMinutes: 720, minBufferMinutes: 10 })
    expect(paceLabelOf('relaxed')).toBe('松弛')
    expect(paceLabelOf('balanced')).toBe('均衡')
    expect(paceLabelOf('packed')).toBe('紧凑')
  })

  it('节奏部分缺数据：span 未知且缓冲未知 → pace unknown（不按 0 补）', () => {
    // 末站缺 duration → span 未知；站数 2 ≤ 上限；路段待重取 → 缓冲未知
    const a = makeStop({ time: '09:00', duration_minutes: 60 })
    const b = makeStop({ time: '10:00', duration_minutes: null })
    const day = makeDay([a, b], { legOverrides: { route_type: 'unavailable', duration_minutes: null } })
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))

    const pace = itemOf(report, 'pace')
    expect(pace?.level).toBe('unknown')
    expect(pace?.evidence).toContain('不按 0 补')
    expect(pace?.evidence).toContain('路段')
  })

  it('缓冲部分缺数据：路段待重取 → pace unknown（不按 0 补）', () => {
    const a = makeStop({ time: '09:00', duration_minutes: 60 })
    const b = makeStop({ time: '10:00', duration_minutes: 60 })
    const day = makeDay([a, b], { legOverrides: { route_type: 'unavailable', duration_minutes: null } })
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))

    const pace = itemOf(report, 'pace')
    expect(pace?.level).toBe('unknown')
    expect(pace?.evidence).toContain('路段')
  })
})

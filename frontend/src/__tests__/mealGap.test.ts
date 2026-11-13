/**
 * S8 · 用餐空档 / 补餐候选纯函数测试。
 *
 * 覆盖：时窗与体检口径对齐、空档扫描、无可用空档、餐饮关键词（名称 / 标签 / 资料卡）、
 * 双库皆空沉默、最多 3 候选、插入位置与 leg 作废（换一纪律）、撤销恢复、预览后变化拒绝写入。
 */
import { describe, expect, it } from 'vitest'

import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import { createEmptyPoiCardsRecord, createPoiCard, type PoiCardsRecordV1 } from '../lib/poiCards'
import { createTripDraft, undoDraft, updateDraftStop } from '../lib/tripDraft'
import type { CandidateItemV1 } from '../lib/workspace'
import {
  MEAL_CANDIDATE_LIMIT,
  applyMealInsertionToDraft,
  buildMealCandidates,
  findMealInsertion,
  scanMealGaps,
  topMealCandidates,
} from '../lib/mealGap'

const NOW = 1_800_000_000_000
let seq = 0

function makeStop(time: string, duration: number | null, overrides: Partial<TripStop> = {}): TripStop {
  seq += 1
  return {
    id: `m${seq}`,
    name: `站点${seq}`,
    time,
    duration_minutes: duration,
    description: '',
    address: '',
    location: null,
    ...overrides,
  }
}

function makeLeg(from: TripStop, to: TripStop): TripLeg {
  return {
    from_stop_id: from.id,
    to_stop_id: to.id,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 500,
    duration_minutes: 10,
    geometry: [{ lng: 120.1, lat: 30.2 }],
    description: '原路线',
  }
}

function makeDay(stops: TripStop[]): TripDay {
  return {
    day: 1,
    date: '2026-04-03',
    title: '第一天',
    summary: '',
    stops,
    legs: stops.slice(0, -1).map((stop, index) => makeLeg(stop, stops[index + 1])),
  }
}

function makeTrip(day: TripDay): Trip {
  return {
    id: 'trip-meal-base',
    source: 'example',
    destination: '杭州',
    title: '补餐测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [day],
  }
}

function candidate(
  id: string,
  name: string,
  overrides: Partial<CandidateItemV1> = {},
): CandidateItemV1 {
  return {
    id,
    name,
    address: overrides.address ?? null,
    notes: overrides.notes ?? null,
    tags: overrides.tags ?? [],
    priority: 1,
    location: overrides.location ?? null,
    source: 'manual',
    copiedFromStopId: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function poiRecord(cards: Array<{ id: string; name: string; intro?: string }>): PoiCardsRecordV1 {
  const empty = createEmptyPoiCardsRecord(NOW)
  if (!empty.ok) throw new Error(empty.message)
  const built = cards.map((card) => {
    const created = createPoiCard(
      {
        id: card.id,
        name: card.name,
        intro: card.intro ?? '',
        provenance: { intro: null, openingHours: null, ticket: null },
      },
      NOW,
    )
    if (!created.ok) throw new Error(created.message)
    return created.value
  })
  return { ...empty.value, cards: built }
}

/** 午餐有 60 分钟空档、晚餐被完全占满的一天。 */
function mealDay(): TripDay {
  return makeDay([
    makeStop('09:00', 90),
    makeStop('11:00', 60),
    makeStop('13:00', 60),
    makeStop('17:00', 120),
  ])
}

describe('scanMealGaps', () => {
  it('按体检同口径识别午餐 / 晚餐窗口空档', () => {
    const scan = scanMealGaps(mealDay())
    expect(scan.ok).toBe(true)
    if (!scan.ok) return
    expect(scan.gaps).toEqual([
      { window: 'lunch', label: '午餐', start: '12:00', end: '13:00', minutes: 60 },
      { window: 'dinner', label: '晚餐', start: '19:00', end: '19:30', minutes: 30 },
    ])
  })

  it('站点时间或停留不可解析 → 无法核对，不按 0 补', () => {
    const day = makeDay([makeStop('09:00', null)])
    const scan = scanMealGaps(day)
    expect(scan.ok).toBe(false)
    if (scan.ok) return
    expect(scan.reason).toBe('unreadable_time')
    expect(scan.message).toContain('不按 0 补')

    const badTime = makeDay([makeStop('九点', 30, { name: '坏时间站' })])
    const scan2 = scanMealGaps(badTime)
    expect(scan2.ok).toBe(false)
    if (scan2.ok) return
    expect(scan2.message).toContain('坏时间站')
  })

  it('空日 → empty_day', () => {
    const scan = scanMealGaps(makeDay([]))
    expect(scan.ok).toBe(false)
    if (scan.ok) return
    expect(scan.reason).toBe('empty_day')
  })
})

describe('findMealInsertion', () => {
  it('取最早一个 ≥45 分钟的空档，并给出插入索引与前后站', () => {
    const day = mealDay()
    const result = findMealInsertion(day)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slot.window).toBe('lunch')
    expect(result.slot.startTime).toBe('12:00')
    expect(result.slot.endTime).toBe('12:45')
    expect(result.slot.minutes).toBe(45)
    expect(result.slot.gapMinutes).toBe(60)
    expect(result.slot.index).toBe(2)
    expect(result.slot.afterStopName).toBe(day.stops[1].name)
    expect(result.slot.beforeStopName).toBe(day.stops[2].name)
  })

  it('两个窗口都没有 45 分钟空档 → no_slot，不提供会重叠的方案', () => {
    const day = makeDay([makeStop('11:30', 120), makeStop('17:30', 120)])
    const result = findMealInsertion(day)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no_slot')
    expect(result.message).toContain('不提供会重叠的方案')
    expect(result.gaps).toHaveLength(0)
  })

  it('S8-36 优先体检提示窗口：两窗都可用时，晚餐偏好选晚餐而非默认午餐', () => {
    const day = makeDay([
      makeStop('09:00', 60),
      makeStop('11:00', 60),
      makeStop('13:00', 60),
      makeStop('17:00', 90),
    ])
    const lunch = findMealInsertion(day, 'lunch')
    const dinner = findMealInsertion(day, 'dinner')
    expect(lunch.ok).toBe(true)
    expect(dinner.ok).toBe(true)
    if (!lunch.ok || !dinner.ok) return
    expect(lunch.slot.window).toBe('lunch')
    expect(lunch.slot.startTime).toBe('12:00')
    expect(dinner.slot.window).toBe('dinner')
    expect(dinner.slot.startTime).toBe('18:30')
  })

  it('S8-36 提示窗口无 45 分钟空档 → 回退另一窗口（由面板显式说明）', () => {
    const day = mealDay()
    const result = findMealInsertion(day, 'dinner')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slot.window).toBe('lunch')
    expect(result.slot.startTime).toBe('12:00')
  })
})

describe('buildMealCandidates', () => {
  it('名称 / 标签命中餐饮关键词；非餐饮与已有站名排除', () => {
    const day = mealDay()
    const candidates = buildMealCandidates({
      candidates: [
        candidate('c1', '老字号面馆'),
        candidate('c2', '楼外楼', { tags: ['餐厅', '杭帮菜'] }),
        candidate('c3', '断桥残雪'),
        candidate('c4', day.stops[0].name, { tags: ['餐厅'] }),
      ],
      poiCards: poiRecord([
        { id: 'card1', name: '星巴克咖啡' },
        { id: 'card2', name: '浙江省博物馆' },
      ]),
      anchorStop: day.stops[1],
      existingStopNames: day.stops.map((stop) => stop.name),
      now: NOW,
    })
    const names = candidates.map((item) => item.name)
    expect(names).toContain('老字号面馆')
    expect(names).toContain('楼外楼')
    expect(names).toContain('星巴克咖啡')
    expect(names).not.toContain('断桥残雪')
    expect(names).not.toContain(day.stops[0].name)
    expect(names).not.toContain('浙江省博物馆')

    const noodle = candidates.find((item) => item.name === '老字号面馆')
    expect(noodle?.matchedInName).toBe(true)
    expect(noodle?.reason).toContain('名称含餐饮关键词')
    const tower = candidates.find((item) => item.name === '楼外楼')
    expect(tower?.matchedInName).toBe(false)
    expect(tower?.reason).toContain('标签含餐饮关键词')
    const coffee = candidates.find((item) => item.name === '星巴克咖啡')
    expect(coffee?.source).toBe('poi_card')
    expect(coffee?.straightDistanceMeters).toBeNull()
  })

  it('最多 3 个候选（沿换一上限）', () => {
    const day = mealDay()
    const list = topMealCandidates(
      buildMealCandidates({
        candidates: [
          candidate('c1', '一号餐厅'),
          candidate('c2', '二号餐馆'),
          candidate('c3', '三号饭馆'),
          candidate('c4', '四号咖啡馆'),
        ],
        anchorStop: day.stops[0],
        now: NOW,
      }),
      MEAL_CANDIDATE_LIMIT,
    )
    expect(list).toHaveLength(3)
  })

  it('双库皆空 → 空数组（沉默，不编造）', () => {
    const result = buildMealCandidates({
      candidates: [],
      poiCards: null,
      anchorStop: null,
      now: NOW,
    })
    expect(result).toEqual([])
  })

  it('有坐标锚点时给出直线距离；无坐标一律未知', () => {
    const anchor = makeStop('11:00', 60, { location: { lng: 120.15, lat: 30.28 } })
    const near = candidate('c1', '近处餐厅', { location: { lng: 120.16, lat: 30.28 } })
    const far = candidate('c2', '远处餐馆', { location: { lng: 120.3, lat: 30.28 } })
    const unknown = candidate('c3', '无坐标咖啡馆')
    const list = buildMealCandidates({
      candidates: [far, unknown, near],
      anchorStop: anchor,
      now: NOW,
    })
    expect(list[0].name).toBe('近处餐厅')
    expect(list[1].name).toBe('远处餐馆')
    expect(list[0].straightDistanceMeters).not.toBeNull()
    expect(list[1].straightDistanceMeters).not.toBeNull()
    expect(list[2].straightDistanceMeters).toBeNull()
  })
})

describe('applyMealInsertionToDraft', () => {
  it('插入到空档位置：名称 / 时间 / 45 分钟 / 无坐标；相邻 leg 作废，撤销一次恢复', () => {
    const day = mealDay()
    const draftCreated = createTripDraft(makeTrip(day), {
      forkTripId: 'trip-meal-fork',
      newLegMode: 'walking',
    })
    if (!draftCreated.ok) throw new Error(draftCreated.message)
    const [candidateItem] = buildMealCandidates({
      candidates: [candidate('c1', '老字号面馆')],
      anchorStop: day.stops[1],
      now: NOW,
    })
    const insertedSlot = findMealInsertion(day)
    if (!insertedSlot.ok) throw new Error(insertedSlot.message)

    const written = applyMealInsertionToDraft(
      draftCreated.draft,
      1,
      insertedSlot.slot,
      candidateItem,
      'meal-stop-1',
    )
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.changed).toBe(true)
    const nextDay = written.draft.days[0]
    expect(nextDay.stops).toHaveLength(5)
    const meal = nextDay.stops[2]
    expect(meal.id).toBe('meal-stop-1')
    expect(meal.name).toBe('老字号面馆')
    expect(meal.time).toBe('12:00')
    expect(meal.duration_minutes).toBe(45)
    expect(meal.location).toBeNull()

    const unavailable = nextDay.legs.filter((leg) => leg.route_type === 'unavailable')
    expect(unavailable).toHaveLength(2)
    for (const leg of unavailable) {
      expect(leg.geometry).toEqual([])
      expect(leg.distance_m).toBeNull()
      expect(leg.duration_minutes).toBeNull()
      expect(leg.description).toContain('待重新获取路线')
    }
    // 不相关路段原样保留
    expect(nextDay.legs[0]).toEqual(day.legs[0])
    expect(nextDay.legs[3]).toEqual(day.legs[2])
    expect(written.draft.history).toHaveLength(1)

    const undone = undoDraft(written.draft)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.draft.days[0].stops).toHaveLength(4)
    expect(undone.draft.days[0].stops.map((stop) => stop.time)).toEqual([
      '09:00',
      '11:00',
      '13:00',
      '17:00',
    ])
    expect(undone.draft.days[0].legs).toEqual(day.legs)
  })

  it('S8-36 传入提示窗口时，预览与写入使用同一窗口（晚餐 18:30）', () => {
    const day = makeDay([
      makeStop('09:00', 60),
      makeStop('11:00', 60),
      makeStop('13:00', 60),
      makeStop('17:00', 90),
    ])
    const draftCreated = createTripDraft(makeTrip(day), {
      forkTripId: 'trip-meal-fork-3',
      newLegMode: 'walking',
    })
    if (!draftCreated.ok) throw new Error(draftCreated.message)
    const [candidateItem] = buildMealCandidates({
      candidates: [candidate('c1', '老字号面馆')],
      anchorStop: day.stops[3],
      now: NOW,
    })
    const slotResult = findMealInsertion(day, 'dinner')
    if (!slotResult.ok) throw new Error(slotResult.message)
    expect(slotResult.slot.window).toBe('dinner')
    expect(slotResult.slot.startTime).toBe('18:30')

    const written = applyMealInsertionToDraft(
      draftCreated.draft,
      1,
      slotResult.slot,
      candidateItem,
      'meal-stop-3',
      'dinner',
    )
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.draft.days[0].stops[4].time).toBe('18:30')
    expect(written.draft.days[0].stops[4].name).toBe('老字号面馆')
  })

  it('预览后空档变化 → 拒绝写入，草稿保持原样', () => {
    const day = mealDay()
    const draftCreated = createTripDraft(makeTrip(day), {
      forkTripId: 'trip-meal-fork-2',
      newLegMode: 'walking',
    })
    if (!draftCreated.ok) throw new Error(draftCreated.message)
    const [candidateItem] = buildMealCandidates({
      candidates: [candidate('c1', '老字号面馆')],
      anchorStop: day.stops[1],
      now: NOW,
    })
    const slotResult = findMealInsertion(day)
    if (!slotResult.ok) throw new Error(slotResult.message)

    // 把第 2 站延长到 12:40，午餐空档只剩 20 分钟 → 原预览失效。
    const edited = updateDraftStop(draftCreated.draft, 1, day.stops[1].id, {
      duration_minutes: 100,
    })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return

    const written = applyMealInsertionToDraft(
      edited.draft,
      1,
      slotResult.slot,
      candidateItem,
      'meal-stop-2',
    )
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.reason).toBe('postcondition_failed')
    expect(edited.draft.days[0].stops).toHaveLength(4)
    expect(edited.draft.days[0].stops[1].duration_minutes).toBe(100)
  })
})

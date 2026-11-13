/**
 * 七期 S8-39 · 体检识别餐饮站 + 补餐输出不回归。
 *
 * 口径：
 * - `isMealStopLike` 只看站名 / 描述是否命中现有餐饮关键词（大小写不敏感，中文包含）；
 *   不看时长、不推断沿途餐馆。
 * - 体检的用餐窗口内若已有餐饮站到达，视为「已安排正餐」，不再因空档 <45 分钟报 notice；
 *   窗口内没有餐饮站时判定保持五期原样。
 * - `scanMealGaps` / `buildMealCandidates` 输出必须与本片之前逐字一致（快照式断言）。
 */
import { describe, expect, it } from 'vitest'

import type { TripDay, TripStop } from '../lib/api'
import { inspectDayHealth, type HealthItem } from '../lib/itineraryHealth'
import {
  buildMealCandidates,
  isMealStopLike,
  scanMealGaps,
} from '../lib/mealGap'
import type { StopFacts } from '../lib/stopFacts'
import type { CandidateItemV1 } from '../lib/workspace'

const NOW = 1_800_000_000_000
let seq = 0

function makeStop(overrides: Partial<TripStop> = {}): TripStop {
  seq += 1
  return {
    id: `m${seq}`,
    name: `站点${seq}`,
    time: '09:00',
    duration_minutes: 60,
    description: '',
    address: '',
    location: null,
    ...overrides,
  }
}

function makeDay(stops: TripStop[]): TripDay {
  return {
    day: 1,
    date: '2026-04-03',
    title: '第一天',
    summary: '',
    stops,
    legs: [],
  }
}

function noFacts(stops: readonly TripStop[]): Array<StopFacts | null> {
  return stops.map(() => null)
}

function itemOf(report: { items: HealthItem[] }, code: HealthItem['code']): HealthItem | undefined {
  return report.items.find((item) => item.code === code)
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

/** 午餐窗口总空档仅 15 分钟、晚餐窗口留足的一天。 */
function tightLunchDay(middayName: string): TripDay {
  return makeDay([
    makeStop({ name: '早市', time: '09:00', duration_minutes: 90 }),
    makeStop({ name: '街角', time: '11:30', duration_minutes: 30 }),
    makeStop({ name: middayName, time: '12:00', duration_minutes: 45 }),
    makeStop({ name: '博物馆', time: '13:00', duration_minutes: 60 }),
    makeStop({ name: '河坊街', time: '17:30', duration_minutes: 45 }),
  ])
}

describe('S8-39 · 体检识别餐饮站', () => {
  it('7. 午餐窗口内「面馆 · 午餐」45 分钟 → 不再报正餐窗口偏紧', () => {
    const day = tightLunchDay('面馆 · 午餐')
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))
    expect(itemOf(report, 'meal_gap')).toBeUndefined()
  })

  it('8. 同一时间「西湖观景」45 分钟 → 仍报午餐窗口偏紧（负向）', () => {
    const day = tightLunchDay('西湖观景')
    const report = inspectDayHealth(day, 'balanced', noFacts(day.stops))
    const item = itemOf(report, 'meal_gap')
    expect(item?.level).toBe('notice')
    expect(item?.message).toContain('午餐')
  })

  it('9. 站名 / 描述关键词识别：餐厅、咖啡馆、restaurant 大小写；空描述不影响', () => {
    expect(isMealStopLike(makeStop({ name: '老字号面馆' }))).toBe(true)
    expect(isMealStopLike(makeStop({ name: '街角', description: '楼下有咖啡馆' }))).toBe(true)
    expect(isMealStopLike(makeStop({ name: 'Sunset RESTAURANT' }))).toBe(true)
    expect(isMealStopLike(makeStop({ name: '观景台', description: '' }))).toBe(false)
    expect(isMealStopLike(makeStop({ name: '西湖', description: '风景很好' }))).toBe(false)
    // 空描述不影响站名命中
    expect(isMealStopLike(makeStop({ name: '茶餐厅', description: '' }))).toBe(true)
  })

  it('10. scanMealGaps / buildMealCandidates 输出与 HEAD 一致（快照式）', () => {
    const day = makeDay([
      makeStop({ name: '甲', time: '09:00', duration_minutes: 90 }),
      makeStop({ name: '乙', time: '11:00', duration_minutes: 60 }),
      makeStop({ name: '丙', time: '13:00', duration_minutes: 60 }),
      makeStop({ name: '丁', time: '17:00', duration_minutes: 120 }),
    ])

    expect(scanMealGaps(day)).toEqual({
      ok: true,
      gaps: [
        { window: 'lunch', label: '午餐', start: '12:00', end: '13:00', minutes: 60 },
        { window: 'dinner', label: '晚餐', start: '19:00', end: '19:30', minutes: 30 },
      ],
    })

    const candidates = buildMealCandidates({
      candidates: [
        candidate('c1', '老字号面馆'),
        candidate('c2', '楼外楼', { tags: ['餐厅', '杭帮菜'] }),
        candidate('c3', '断桥残雪'),
      ],
      poiCards: null,
      anchorStop: day.stops[1],
      existingStopNames: day.stops.map((stop) => stop.name),
      now: NOW,
    })
    const snapshot = candidates.map((item) => ({
      id: item.id,
      name: item.name,
      source: item.source,
      matchedKeywords: item.matchedKeywords,
      matchedInName: item.matchedInName,
      straightDistanceMeters: item.straightDistanceMeters,
      trust: item.trust,
    }))
    expect(snapshot).toEqual([
      {
        id: 'candidate:c1',
        name: '老字号面馆',
        source: 'candidate_pool',
        matchedKeywords: ['面馆'],
        matchedInName: true,
        straightDistanceMeters: null,
        trust: 'unknown',
      },
      {
        id: 'candidate:c2',
        name: '楼外楼',
        source: 'candidate_pool',
        matchedKeywords: ['餐厅'],
        matchedInName: false,
        straightDistanceMeters: null,
        trust: 'unknown',
      },
    ])
  })
})

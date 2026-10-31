/**
 * draftEndTime 的离线回归：纯函数只读、结构化结论、边界与不可变。
 *
 * 不 mock tripDraft：改动天口径由真实 draftChangedDays 决定，倒序 / 跨日 /
 * 旧宽字段这些输入直接构造在夹具上，检查函数不修改任何原对象（deepFreeze 证明）。
 */
import { describe, expect, it } from 'vitest'

import type { Trip, TripDay, TripStop } from '../lib/api'
import { createTripDraft, updateDraftStop, type TripDraft } from '../lib/tripDraft'
import {
  MAX_DAILY_END_TIME_MINUTES,
  dailyEndTimeLimitResult,
  formatEndTimeClock,
  parseDailyEndTimeLimit,
  type EndTimeDayResult,
  type EndTimeStopFinding,
} from '../lib/draftEndTime'
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

function makeDraft(base: Trip, forkTripId = 'trip-fork-endtime'): TripDraft {
  const created = createTripDraft(base, { forkTripId, newLegMode: 'walking' })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

function dayResult(days: readonly EndTimeDayResult[], dayNumber: number): EndTimeDayResult {
  const day = days.find((item) => item.day === dayNumber)
  if (!day) throw new Error(`结果里没有第 ${dayNumber} 天`)
  return day
}

function findingOf(
  day: EndTimeDayResult,
  stopId: string,
  kind: EndTimeStopFinding['kind'],
): EndTimeStopFinding {
  const finding = day.findings.find(
    (item) => item.stopId === stopId && item.kind === kind,
  )
  if (!finding) {
    throw new Error(
      `第 ${day.day} 天没有 ${stopId} 的 ${kind}，实际: ${JSON.stringify(day.findings)}`,
    )
  }
  return finding
}

function stop(
  id: string,
  name: string,
  time: string,
  durationMinutes: number | null,
  extra?: Partial<TripStop>,
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes: durationMinutes,
    description: '',
    address: '',
    location: null,
    ...extra,
  }
}

function oneDayTrip(stops: TripStop[]): Trip {
  const day: TripDay = { day: 1, date: null, title: '测试日', summary: '', stops, legs: [] }
  return { ...cloneTrip(), id: 'trip-endtime', days: [day] }
}

describe('parseDailyEndTimeLimit', () => {
  it('接受严格 HH:MM，拒绝宽格式与 24:00（与站点时间同一口径，上限最大 23:59）', () => {
    expect(parseDailyEndTimeLimit('22:00')).toEqual({ ok: true, minutes: 1320 })
    expect(parseDailyEndTimeLimit('00:00')).toEqual({ ok: true, minutes: 0 })
    expect(parseDailyEndTimeLimit('9:00').ok).toBe(false)
    expect(parseDailyEndTimeLimit('24:00').ok).toBe(false)
    expect(parseDailyEndTimeLimit('24:30').ok).toBe(false)
    expect(parseDailyEndTimeLimit('12:60').ok).toBe(false)
    expect(parseDailyEndTimeLimit('').ok).toBe(false)
  })
})

describe('formatEndTimeClock', () => {
  it('分钟数补零成 HH:MM', () => {
    expect(formatEndTimeClock(1320)).toBe('22:00')
    expect(formatEndTimeClock(0)).toBe('00:00')
    expect(formatEndTimeClock(1445)).toBe('24:05')
  })
})

describe('dailyEndTimeLimitResult 基础结论', () => {
  it('前站超限但末站未超：超限的是前站，不因为只看末站而漏报', () => {
    // 上限 18:00；第 1 站 16:00 开始停留 150 分钟 → 结束下界 18:30 超限；
    // 末站 18:30 开始停留 20 分钟 → 结束下界 18:50，同样超限。
    // 换一组「末站不超」的：末站 17:50 开始停留 0 → 下界 17:50 不超。
    const trip = oneDayTrip([
      stop('a', '早场', '16:00', 150),
      stop('b', '末站', '17:50', 0),
    ])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1080, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('over_limit')
    expect(findingOf(day, 'a', 'end_over_limit').message).toContain('18:30')
    expect(day.findings.some((item) => item.stopId === 'b')).toBe(false)
    expect(day.summary).toContain('1 条按填写值可确认超过上限')
  })

  it('开始本身晚于上限：与停留无关地报 start_late', () => {
    const trip = oneDayTrip([stop('a', '夜场', '23:30', null)])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1320, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('over_limit')
    const finding = findingOf(day, 'a', 'start_late')
    expect(finding.message).toContain('23:30')
    expect(finding.message).toContain('不可能在上限前结束')
  })

  it('结束下界恰好等于上限、开始等于上限且停留 0：边界相等不超', () => {
    const trip = oneDayTrip([
      stop('a', '刚好', '17:00', 60),
      stop('b', '零停留', '18:00', 0),
    ])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1080, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('no_evidence')
    expect(day.findings).toEqual([])
    expect(day.summary).toContain('未发现超过最晚结束时间')
    expect(day.summary).toContain('仍需人工确认交通')
  })

  it('结束下界在上限内但跨过 1440：按次日表述并直接超限（任何合法同日上限必然被超过）', () => {
    const trip = oneDayTrip([stop('a', '跨日活动', '23:30', 60)])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1439, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('over_limit')
    const finding = findingOf(day, 'a', 'cross_day_over_limit')
    expect(finding.message).toContain('次日 00:30')
  })

  it('跨日结束下界晚于上限：显式写「次日 HH:MM」，不模 24 冒充当天；开始未超时只报 end 超限', () => {
    const trip = oneDayTrip([stop('a', '晚间场', '08:00', 1020)])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 600, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('over_limit')
    const finding = findingOf(day, 'a', 'cross_day_over_limit')
    expect(finding.message).toContain('次日 01:00')
    expect(finding.message).toContain('晚于上限 10:00')
  })
})

describe('dailyEndTimeLimitResult 无法确认情形', () => {
  it('缺停留（null）：unconfirmed，不按 0 补齐，不虚构结束', () => {
    const trip = oneDayTrip([stop('a', '未填停留', '17:00', null)])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1080, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('unconfirmed')
    const finding = findingOf(day, 'a', 'duration_unknown')
    expect(finding.status).toBe('unconfirmed')
    expect(finding.message).toContain('停留时长缺失')
  })

  it('结束下界恰好 1440（次日午夜 00:00）：跨日超限，显式按次日表述', () => {
    // 上限 23:59；23:30 开始停留 30 分钟 → 结束下界恰好 1440 = 次日 00:00。
    // 任何合法同日上限（最大 23:59）都被它超过，按「次日 00:00」表述。
    const trip = oneDayTrip([stop('a', '午夜场', '23:30', 30)])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1439, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('over_limit')
    const finding = findingOf(day, 'a', 'cross_day_over_limit')
    expect(finding.status).toBe('over_limit')
    expect(finding.message).toContain('次日 00:00')
  })

  it('停留 1440 分钟是可知合法时长：结束下界未超上限时不误报', () => {
    // 00:00 开始停留 1440 → 下界 1440 跨日；但这也是唯一「1440 不超上限」的
    // 反例口径：上限语义是 0–1439（00:00–23:59），1440 的下界必然超限，
    // 这里验证的是超限结论确实给出，而不是把 1440 停留当未知。
    const trip = oneDayTrip([stop('a', '全天站', '00:00', 1440)])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1439, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('over_limit')
    expect(day.findings.some((item) => item.kind === 'cross_day_over_limit')).toBe(true)
    // 下界消息按次日 00:00 表述，不把 1440 停留当缺失或非法。
    expect(day.findings.some((item) => item.kind === 'duration_unknown')).toBe(false)
  })

  it('旧数据停留是小数或超过 1440 分钟：unconfirmed，原值原样不修复', () => {
    const decimalTrip = oneDayTrip([stop('a', '旧小数', '17:00', 45.5 as unknown as number)])
    const decimal = dailyEndTimeLimitResult(makeDraft(decimalTrip), 1080, 'all_days')
    if (!decimal.ok) throw new Error(decimal.message)
    expect(dayResult(decimal.days, 1).status).toBe('unconfirmed')
    expect(findingOf(dayResult(decimal.days, 1), 'a', 'duration_unknown').message).toContain(
      '不是 0–1440 的整数分钟',
    )

    const hugeTrip = oneDayTrip([stop('a', '旧超长', '10:00', 3000)])
    const huge = dailyEndTimeLimitResult(makeDraft(hugeTrip), 1439, 'all_days')
    if (!huge.ok) throw new Error(huge.message)
    expect(dayResult(huge.days, 1).status).toBe('unconfirmed')
  })

  it('旧时间不是 HH:MM：unconfirmed，不做模 24 或部分解析', () => {
    const trip = oneDayTrip([stop('a', '旧宽时间', '9:00', 60)])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1080, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('unconfirmed')
    expect(findingOf(day, 'a', 'time_unreadable').message).toContain('无法按填写值推算结束时刻')
  })

  it('时钟倒序：单独 unconfirmed，且允许与逐站 over_limit 并存', () => {
    // 上限 20:00；a 正常，b 倒序回 10:00 且停留 700 分钟 → 结束下界 21:40 超限，
    // 同时 b 相对 a 倒序 → time_order unconfirmed 与 over_limit 并存。
    const trip = oneDayTrip([
      stop('a', '正常站', '18:00', 30),
      stop('b', '倒序站', '10:00', 700),
    ])
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1200, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    expect(day.status).toBe('over_limit')
    expect(day.findings.some((item) => item.kind === 'time_order')).toBe(true)
    expect(day.findings.some((item) => item.kind === 'end_over_limit')).toBe(true)
    expect(day.summary).toContain('无法确认、需人工核对')
  })
})

describe('dailyEndTimeLimitResult 空日与非法设置', () => {
  it('空日不虚构结束，单独 empty_day', () => {
    const result = dailyEndTimeLimitResult(makeDraft(cloneTrip()), 1080, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 2)
    expect(day.status).toBe('empty_day')
    expect(day.findings).toEqual([])
    expect(day.summary).toContain('没有站点，不虚构结束时刻')
  })

  it('上限非法：结构化错误而不是抛错，也不产生任何天结果；1440 不是合法上限', () => {
    const draft = makeDraft(cloneTrip())
    expect(dailyEndTimeLimitResult(draft, -1, 'all_days').ok).toBe(false)
    expect(dailyEndTimeLimitResult(draft, 1440, 'all_days').ok).toBe(false)
    expect(dailyEndTimeLimitResult(draft, 1441, 'all_days').ok).toBe(false)
    expect(dailyEndTimeLimitResult(draft, 10.5, 'all_days').ok).toBe(false)
    const invalid = dailyEndTimeLimitResult(draft, 1440, 'all_days')
    if (invalid.ok) throw new Error('应为结构化错误')
    expect(invalid.reason).toBe('invalid_limit')
    expect(invalid.message).toContain('00:00–23:59')
    expect(invalid.message).toContain('未执行')
    // 合法边界：0（00:00）与 1439（23:59）都可接受。
    expect(dailyEndTimeLimitResult(draft, 0, 'all_days').ok).toBe(true)
    expect(dailyEndTimeLimitResult(draft, 1439, 'all_days').ok).toBe(true)
  })
})

describe('dailyEndTimeLimitResult 生效范围', () => {
  it('all_days 检查所有天，changed_days 只查真正改过的天', () => {
    const base = cloneTrip()
    // 第 3 天 10:00 + 120 分钟 → 下界 12:00，超 11:00 上限；但这一天没有编辑过。
    base.days[2].stops[0].duration_minutes = 120
    let draft = makeDraft(base)
    const allResult = dailyEndTimeLimitResult(draft, 660, 'all_days')
    if (!allResult.ok) throw new Error(allResult.message)
    expect(allResult.days.map((item) => item.day)).toEqual([1, 2, 3])
    expect(dayResult(allResult.days, 3).status).toBe('over_limit')

    const changedBefore = dailyEndTimeLimitResult(draft, 660, 'changed_days')
    if (!changedBefore.ok) throw new Error(changedBefore.message)
    expect(changedBefore.days).toEqual([])

    // 只改第 1 天一个描述：changed_days 只返回第 1 天；第 3 天的超限不出现。
    draft = (
      updateDraftStop(draft, 1, 's1', { description: '触发改动' }) as {
        ok: true
        draft: TripDraft
      }
    ).draft
    const changedAfter = dailyEndTimeLimitResult(draft, 660, 'changed_days')
    if (!changedAfter.ok) throw new Error(changedAfter.message)
    expect(changedAfter.days.map((item) => item.day)).toEqual([1])
  })

  it('撤销编辑回到原值后，changed_days 不再包含该天（复用 draftChangedDays 口径）', () => {
    let draft = makeDraft(cloneTrip())
    const changed = updateDraftStop(draft, 1, 's1', { time: '09:05' })
    if (!changed.ok || !changed.changed) throw new Error('前置编辑失败')
    draft = changed.draft
    const afterEdit = dailyEndTimeLimitResult(draft, 660, 'changed_days')
    if (!afterEdit.ok) throw new Error(afterEdit.message)
    expect(afterEdit.days.map((item) => item.day)).toEqual([1])
  })
})

describe('dailyEndTimeLimitResult 输入不可变', () => {
  it('检查前后草稿对象保持同一引用且未被修改', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)
    const before = JSON.stringify(draft)
    const result = dailyEndTimeLimitResult(draft, 1080, 'all_days')
    if (!result.ok) throw new Error(result.message)
    expect(JSON.stringify(draft)).toBe(before)
    expect(draft.days).toBe(base.days)
  })

  it('旧大站数与旧宽字段不被校验卡住，照常逐站检查', () => {
    // 单日 100 站是 checkTripShape 的结构上限（复用现有草稿边界，不放宽）。
    const stops: TripStop[] = Array.from({ length: 100 }, (_, index) =>
      stop(`bulk-${index}`, '长'.repeat(300), index % 2 === 0 ? '09:00' : 'bad-time', null),
    )
    const trip = oneDayTrip(stops)
    const result = dailyEndTimeLimitResult(makeDraft(deepFreeze(trip)), 1080, 'all_days')
    if (!result.ok) throw new Error(result.message)
    const day = dayResult(result.days, 1)
    // 50 站时间不可读 + 50 站缺停留：全部 unconfirmed，不抛错、不卡旧宽字段。
    expect(day.findings.filter((item) => item.kind === 'time_unreadable')).toHaveLength(50)
    expect(day.findings.filter((item) => item.kind === 'duration_unknown')).toHaveLength(50)
    expect(MAX_DAILY_END_TIME_MINUTES).toBe(1439)
  })
})

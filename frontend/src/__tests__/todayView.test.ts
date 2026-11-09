/**
 * todayView 纯投影模块测试：时钟注入（固定 nowMs），三时刻场景 + 四缺失场景 +
 * 预约收集，不碰 React、不碰存储。
 */
import { describe, expect, it } from 'vitest'

import type { TripDay, TripLeg, TripStop } from '../lib/api'
import type { ChecklistItemV1, ConstraintItemV1 } from '../lib/workspaceTypes'
import {
  DEPARTURE_BUFFER_MINUTES,
  collectTodayReminders,
  departureFor,
  localDateKey,
  minutesOfDay,
  minutesToHhMm,
  parseStopTimeMinutes,
  pickNextStop,
  pickTodayDay,
} from '../lib/todayView'

/* 固定时钟：2026-04-03 本地，首站前 08:30 / 两站间 09:30 / 末站后 18:00。 */
const MORNING = new Date(2026, 3, 3, 8, 30, 0).getTime()
const MIDDAY = new Date(2026, 3, 3, 9, 30, 0).getTime()
const EVENING = new Date(2026, 3, 3, 18, 0, 0).getTime()

function stop(id: string, time: string, patch: Partial<TripStop> = {}): TripStop {
  return {
    id,
    name: `站点${id}`,
    time,
    duration_minutes: 60,
    description: '',
    address: '',
    location: null,
    ...patch,
  }
}

function leg(from: string, to: string, patch: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking' as const,
    route_type: 'navigation' as const,
    distance_m: null,
    duration_minutes: 16,
    geometry: [],
    description: '',
    ...patch,
  }
}

function day(stops: TripStop[], legs: TripLeg[] = [], date: string | null = '2026-04-03'): TripDay {
  return { day: 1, date, title: '测试日', summary: '', stops, legs }
}

describe('时钟与解析', () => {
  it('localDateKey 用本地时区拆字段，minutesOfDay 用本地时分', () => {
    expect(localDateKey(MORNING)).toBe('2026-04-03')
    expect(minutesOfDay(MORNING)).toBe(8 * 60 + 30)
  })

  it('parseStopTimeMinutes 只认 HH:MM / HH:MM:SS 白名单，非法一律 null', () => {
    expect(parseStopTimeMinutes('09:00')).toBe(540)
    expect(parseStopTimeMinutes('09:00:30')).toBe(540)
    expect(parseStopTimeMinutes(' 9:05 ')).toBe(545)
    expect(parseStopTimeMinutes('24:00')).toBeNull()
    expect(parseStopTimeMinutes('09:60')).toBeNull()
    expect(parseStopTimeMinutes('上午九点')).toBeNull()
    expect(parseStopTimeMinutes('')).toBeNull()
    expect(parseStopTimeMinutes('9')).toBeNull()
  })

  it('minutesToHhMm 越界（跨零点）返回空串', () => {
    expect(minutesToHhMm(540)).toBe('09:00')
    expect(minutesToHhMm(-5)).toBe('')
    expect(minutesToHhMm(1440)).toBe('')
  })
})

describe('当前天判定', () => {
  const d1: TripDay = { day: 1, date: '2026-04-03', title: 'a', summary: '', stops: [], legs: [] }
  const d2: TripDay = { day: 2, date: '2026-04-04', title: 'b', summary: '', stops: [], legs: [] }

  it('日期匹配 → matched', () => {
    expect(pickTodayDay([d1, d2], MORNING)).toEqual({ day: d1, kind: 'matched' })
  })

  it('有日期但都不匹配 → 兜底第 1 天，kind=unmatched_first', () => {
    expect(pickTodayDay([d1, d2], new Date(2026, 5, 1).getTime())).toEqual({
      day: d1,
      kind: 'unmatched_first',
    })
  })

  it('整份行程无日期 → 默认第 1 天，kind=no_dates', () => {
    const undated: TripDay = { day: 1, date: null, title: 'x', summary: '', stops: [], legs: [] }
    expect(pickTodayDay([undated], MORNING)).toEqual({ day: undated, kind: 'no_dates' })
  })

  it('空行程 → day=null', () => {
    expect(pickTodayDay([], MORNING).day).toBeNull()
  })
})

describe('下一站三时刻', () => {
  const d = day([
    stop('s1', '09:00'),
    stop('s2', '10:00'),
    stop('s3', '11:30'),
  ])

  it('首站前（08:30）→ 第一站 upcoming before_first', () => {
    const pick = pickNextStop(d, MORNING)
    expect(pick.kind).toBe('upcoming')
    expect(pick.stop?.id).toBe('s1')
    expect(pick.position).toBe('before_first')
    expect(pick.timeKnown).toBe(true)
  })

  it('两站之间（09:30）→ 第二站 upcoming between', () => s2Between())

  function s2Between() {
    const pick = pickNextStop(d, MIDDAY)
    expect(pick.kind).toBe('upcoming')
    expect(pick.stop?.id).toBe('s2')
    expect(pick.position).toBe('between')
  }

  it('末站后（18:00）→ finished', () => {
    const pick = pickNextStop(d, EVENING)
    expect(pick.kind).toBe('finished')
    expect(pick.stop).toBeNull()
    expect(pick.position).toBe('after_last')
  })

  it('恰好等于站时刻算未过去', () => {
    const atNine = new Date(2026, 3, 3, 9, 0, 0).getTime()
    expect(pickNextStop(d, atNine).stop?.id).toBe('s1')
  })
})

describe('四种缺失', () => {
  it('缺站时间：第一站缺时刻 → 取第一站并标时间未知（即使后面有带时刻的站）', () => {
    const d = day([stop('s1', ''), stop('s2', '10:00')])
    const pick = pickNextStop(d, MORNING)
    expect(pick.stop?.id).toBe('s1')
    expect(pick.timeKnown).toBe(false)
    expect(pick.position).toBe('before_first')
  })

  it('带时刻的站都过去、后面还有缺时刻的站 → 取第一个缺时刻的站，不断言已结束', () => {
    const d = day([stop('s1', '09:00'), stop('s2', '')])
    const pick = pickNextStop(d, EVENING)
    expect(pick.stop?.id).toBe('s2')
    expect(pick.timeKnown).toBe(false)
    expect(pick.kind).toBe('upcoming')
  })

  it('全部带时刻且都过去 → finished', () => {
    const d = day([stop('s1', '09:00'), stop('s2', '10:00')])
    expect(pickNextStop(d, EVENING).kind).toBe('finished')
  })

  it('无站点 → no_stops', () => {
    expect(pickNextStop(day([]), MORNING).kind).toBe('no_stops')
  })
})

describe('出发时间建议', () => {
  it('有 leg 耗时 → 站时间 − 耗时 − 缓冲；断言缓冲常量参与计算', () => {
    const d = day([stop('s1', '09:00'), stop('s2', '10:00')], [leg('s1', 's2')])
    const next = pickNextStop(d, MIDDAY)
    const dep = departureFor(d, next)
    expect(dep.kind).toBe('suggested')
    expect(dep.timeText).toBe(minutesToHhMm(600 - 16 - DEPARTURE_BUFFER_MINUTES))
    expect(dep.approximate).toBe(false)
    expect(dep.legText).toContain('步行')
  })

  it('straight_line 路段 → approximate=true（UI 标「示意」）', () => {
    const d = day(
      [stop('s1', '09:00'), stop('s2', '10:00')],
      [leg('s1', 's2', { route_type: 'straight_line' })],
    )
    const dep = departureFor(d, pickNextStop(d, MIDDAY))
    expect(dep.kind).toBe('suggested')
    expect(dep.approximate).toBe(true)
  })

  it('缺 leg → no_leg；缺 leg 耗时 → no_duration（都无建议时刻）', () => {
    const noLeg = day([stop('s1', '09:00'), stop('s2', '10:00')], [])
    expect(departureFor(noLeg, pickNextStop(noLeg, MIDDAY)).kind).toBe('no_leg')

    const noDur = day([stop('s1', '09:00'), stop('s2', '10:00')], [
      leg('s1', 's2', { duration_minutes: null }),
    ])
    expect(departureFor(noDur, pickNextStop(noDur, MIDDAY)).kind).toBe('no_duration')
  })

  it('第一站无上一站路程 → no_prev', () => {
    const d = day([stop('s1', '09:00'), stop('s2', '10:00')], [leg('s1', 's2')])
    expect(departureFor(d, pickNextStop(d, MORNING)).kind).toBe('no_prev')
  })

  it('下一站缺时刻 → unknown_time；推算越过零点 → out_of_range', () => {
    const noTime = day([stop('s1', ''), stop('s2', '10:00')])
    expect(departureFor(noTime, pickNextStop(noTime, MORNING)).kind).toBe('unknown_time')

    // s1 00:05 已过、s2 00:20 未到 → s2 是下一站；出发 = 00:20 − 120 − 10 < 0 → 越过零点
    const atMidnight = new Date(2026, 3, 3, 0, 10, 0).getTime()
    const late = day(
      [stop('s1', '00:05'), stop('s2', '00:20')],
      [leg('s1', 's2', { duration_minutes: 120 })],
    )
    const lateNext = pickNextStop(late, atMidnight)
    expect(lateNext.stop?.id).toBe('s2')
    expect(departureFor(late, lateNext).kind).toBe('out_of_range')
  })

  it('finished / no_stops → invalid（无建议）', () => {
    const d = day([stop('s1', '09:00')])
    expect(departureFor(d, pickNextStop(d, EVENING)).kind).toBe('invalid')
  })
})

describe('预约提醒收集', () => {
  const d = day([], [], '2026-04-03')

  function item(patch: Partial<ChecklistItemV1>): ChecklistItemV1 {
    return {
      id: 'c1',
      category: 'appointment',
      title: '预约事项',
      done: false,
      date: null,
      day: 1,
      stopId: null,
      originalStopId: null,
      constraintId: null,
      notes: null,
      updatedAt: 0,
      ...patch,
    }
  }

  function constraint(patch: Partial<ConstraintItemV1>): ConstraintItemV1 {
    return {
      id: 'k1',
      kind: 'fixed_window',
      day: 1,
      stopId: null,
      title: '约束事项',
      startDate: null,
      endDate: null,
      startTime: null,
      endTime: null,
      durationMinutes: null,
      notes: null,
      priority: 0,
      updatedAt: 0,
      ...patch,
    }
  }

  it('appointment 清单项按天序号匹配；fixed_window 约束按天序号匹配', () => {
    const out = collectTodayReminders(d, [item({ title: '博物馆预约' })], [
      constraint({ title: '入园时间窗' }),
    ])
    expect(out).toEqual([
      { title: '博物馆预约', from: 'checklist' },
      { title: '入园时间窗', from: 'constraint' },
    ])
  })

  it('day=null 时按日期匹配（checklist 用 date，constraint 用 startDate）', () => {
    const out = collectTodayReminders(
      d,
      [item({ day: null, date: '2026-04-03' })],
      [constraint({ day: null, startDate: '2026-04-03' })],
    )
    expect(out).toHaveLength(2)
  })

  it('别的天的 / 类别不符的 / 日期不符的不收录；同名去重', () => {
    const out = collectTodayReminders(
      d,
      [
        item({ title: '明天的事', day: 2 }),
        item({ title: '非预约', category: 'todo' }),
        item({ title: '日期不符', day: null, date: '2026-05-01' }),
        item({ title: '预约事项' }),
      ],
      [constraint({ title: '预约事项' })],
    )
    expect(out).toEqual([{ title: '预约事项', from: 'checklist' }])
  })

  it('空清单空约束 → 空数组（UI 显示「未记录」）', () => {
    expect(collectTodayReminders(d, [], [])).toEqual([])
  })
})

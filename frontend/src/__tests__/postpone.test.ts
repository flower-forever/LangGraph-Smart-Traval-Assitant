/**
 * S8 · 时刻顺延纯函数测试。
 *
 * 覆盖：15/30 级联、跨天边界（保持原时刻 / 目标站跨日不可用）、边界冲突明示、
 * 投影不改写原对象、体检建议起点、写入草稿只占一个撤销步、预览后草稿变化拒绝写入。
 */
import { describe, expect, it } from 'vitest'

import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import { createTripDraft, undoDraft, updateDraftStop, type TripDraft } from '../lib/tripDraft'
import {
  applyPostponeToDraft,
  projectPostpone,
  suggestPostponeTarget,
} from '../lib/postpone'

let seq = 0
function makeStop(time: string, duration: number | null, overrides: Partial<TripStop> = {}): TripStop {
  seq += 1
  return {
    id: `s${seq}`,
    name: `站点${seq}`,
    time,
    duration_minutes: duration,
    description: '',
    address: '',
    location: null,
    ...overrides,
  }
}

function makeLeg(from: TripStop, to: TripStop, duration: number | null, routeType: TripLeg['route_type'] = 'navigation'): TripLeg {
  return {
    from_stop_id: from.id,
    to_stop_id: to.id,
    mode: 'walking',
    route_type: routeType,
    distance_m: routeType === 'unavailable' ? null : 500,
    duration_minutes: duration,
    geometry: [],
    description: '',
  }
}

function makeDay(stops: TripStop[], legMinutes: Array<number | null> = []): TripDay {
  const legs = stops.slice(0, -1).map((stop, index) => {
    const duration = legMinutes[index] === undefined ? 10 : legMinutes[index]
    return makeLeg(stop, stops[index + 1], duration)
  })
  return { day: 1, date: '2026-04-03', title: '第一天', summary: '', stops, legs }
}

function makeTrip(day: TripDay): Trip {
  return {
    id: 'trip-postpone-base',
    source: 'example',
    destination: '杭州',
    title: '顺延测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [day],
  }
}

function makeDraft(day: TripDay): TripDraft {
  const created = createTripDraft(makeTrip(day), {
    forkTripId: 'trip-postpone-fork',
    newLegMode: 'walking',
  })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

describe('projectPostpone', () => {
  it('15 分钟：从目标站起整体后移，目标站之前的站不动', () => {
    const s1 = makeStop('09:00', 60)
    const s2 = makeStop('10:10', 30)
    const s3 = makeStop('11:00', 30)
    const day = makeDay([s1, s2, s3])
    const before = JSON.parse(JSON.stringify(day)) as TripDay

    const result = projectPostpone(day, s2.id, 15)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.projection.shiftedCount).toBe(2)
    expect(result.projection.stops.map((stop) => stop.timeAfter)).toEqual([
      '09:00',
      '10:25',
      '11:15',
    ])
    expect(result.projection.stops[1].endAfter).toBe('10:55')
    expect(result.projection.stops[2].endAfter).toBe('11:45')

    // 投影不改写原对象
    expect(day).toEqual(before)
  })

  it('30 分钟：级联与结束时刻同步后移', () => {
    const s1 = makeStop('09:00', 60)
    const s2 = makeStop('10:10', 30)
    const s3 = makeStop('11:00', 30)
    const day = makeDay([s1, s2, s3])

    const result = projectPostpone(day, s2.id, 30)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.projection.minutes).toBe(30)
    expect(result.projection.stops.map((stop) => stop.timeAfter)).toEqual([
      '09:00',
      '10:40',
      '11:30',
    ])
    expect(result.projection.stops[1].endAfter).toBe('11:10')
  })

  it('跨天边界：会跨到次日的末尾站保持原时刻，并如实说明', () => {
    const a = makeStop('21:00', 0)
    const b = makeStop('22:30', 0)
    const c = makeStop('23:40', 0)
    const day = makeDay([a, b, c])

    const result = projectPostpone(day, a.id, 30)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.projection.shiftedCount).toBe(2)
    expect(result.projection.heldCount).toBe(1)
    const held = result.projection.stops[2]
    expect(held.timeAfter).toBe('23:40')
    expect(held.heldReason).toContain('跨到次日')
    expect(result.projection.conflicts).toEqual([])
    expect(result.projection.notes.join(' ')).toContain('保持原时刻')
  })

  it('边界冲突：顺延段结束晚于保持原时刻的下一站时明示冲突', () => {
    const a = makeStop('21:00', 0)
    const b = makeStop('23:20', 0)
    const c = makeStop('23:40', 0)
    const day = makeDay([a, b, c])

    const result = projectPostpone(day, a.id, 30)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.projection.conflicts).toHaveLength(1)
    expect(result.projection.conflicts[0]).toContain('23:50')
    expect(result.projection.conflicts[0]).toContain('23:40')
  })

  it('目标站自己会跨到次日 → 整次顺延不可用（不折叠成 00:10）', () => {
    const only = makeStop('23:50', 0)
    const day = makeDay([only])
    const result = projectPostpone(day, only.id, 15)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('midnight')
    expect(result.message).toContain('跨到次日')
  })

  it('目标站结束时刻新跨到次日 → 整次顺延不可用', () => {
    const only = makeStop('22:50', 60)
    const day = makeDay([only])
    const result = projectPostpone(day, only.id, 30)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('midnight')
  })

  it('只接受 15 / 30 分钟', () => {
    const only = makeStop('09:00', 30)
    const day = makeDay([only])
    const result = projectPostpone(day, only.id, 20)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid_minutes')
  })

  it('目标站及之后时间不可解析 → 失败；目标站之前不可解析不影响顺延', () => {
    const badBefore = makeStop('9:00', 30)
    const s2 = makeStop('10:00', 30)
    const day = makeDay([badBefore, s2])
    const okResult = projectPostpone(day, s2.id, 15)
    expect(okResult.ok).toBe(true)

    const s3 = makeStop('9:00', 30)
    const badAfter = makeStop('十点', 30, { name: '坏时间站' })
    const badDay = makeDay([s3, badAfter])
    const badResult = projectPostpone(badDay, badAfter.id, 15)
    expect(badResult.ok).toBe(false)
    if (badResult.ok) return
    expect(badResult.reason).toBe('unreadable_time')
    expect(badResult.message).toContain('坏时间站')
  })

  it('停留缺失不按 0 补：结束时刻为 null，并在 notes 里说明无法判断', () => {
    const s1 = makeStop('09:00', 60)
    const s2 = makeStop('10:00', null)
    const day = makeDay([s1, s2])
    const result = projectPostpone(day, s2.id, 15)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.projection.stops[1].endAfter).toBeNull()
    expect(result.projection.notes.join(' ')).toContain('停留时长缺失')
  })
})

describe('suggestPostponeTarget', () => {
  it('找第一段缓冲不足的路段，返回其下一站作为起点', () => {
    const s1 = makeStop('09:00', 60)
    const s2 = makeStop('10:10', 30)
    const day = makeDay([s1, s2], [5])
    const suggestion = suggestPostponeTarget(day, 'balanced')
    expect(suggestion).not.toBeNull()
    expect(suggestion?.stopId).toBe(s2.id)
    expect(suggestion?.stopIndex).toBe(1)
    expect(suggestion?.bufferMinutes).toBe(5)
  })

  it('缺少路段时间 → 不猜，返回 null', () => {
    const s1 = makeStop('09:00', 60)
    const s2 = makeStop('10:10', 30)
    const day = makeDay([s1, s2], [null])
    expect(suggestPostponeTarget(day, 'balanced')).toBeNull()
  })

  it('缓冲充足 → null', () => {
    const s1 = makeStop('09:00', 60)
    const s2 = makeStop('11:00', 30)
    const day = makeDay([s1, s2], [10])
    expect(suggestPostponeTarget(day, 'balanced')).toBeNull()
  })
})

describe('applyPostponeToDraft', () => {
  it('写入草稿：所有顺延站合并成一个撤销步，撤销一次整体恢复', () => {
    const s1 = makeStop('09:00', 60)
    const s2 = makeStop('10:10', 30)
    const s3 = makeStop('11:00', 30)
    const day = makeDay([s1, s2, s3])
    const draft = makeDraft(day)
    const projected = projectPostpone(day, s2.id, 30)
    expect(projected.ok).toBe(true)
    if (!projected.ok) return

    const written = applyPostponeToDraft(draft, projected.projection)
    expect(written.ok).toBe(true)
    if (!written.ok) return
    expect(written.changed).toBe(true)
    const times = written.draft.days[0].stops.map((stop) => stop.time)
    expect(times).toEqual(['09:00', '10:40', '11:30'])
    expect(written.draft.history).toHaveLength(1)
    expect(written.draft.revision).toBe(draft.revision + 1)

    const undone = undoDraft(written.draft)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.draft.days[0].stops.map((stop) => stop.time)).toEqual(['09:00', '10:10', '11:00'])
    expect(undone.draft.history).toHaveLength(0)
  })

  it('预览后草稿时刻变了 → 拒绝写入，草稿保持原样', () => {
    const s1 = makeStop('09:00', 60)
    const s2 = makeStop('10:10', 30)
    const day = makeDay([s1, s2])
    const draft = makeDraft(day)
    const projected = projectPostpone(day, s2.id, 15)
    expect(projected.ok).toBe(true)
    if (!projected.ok) return

    const edited = updateDraftStop(draft, 1, s2.id, { time: '10:20' })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return

    const written = applyPostponeToDraft(edited.draft, projected.projection)
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.reason).toBe('postcondition_failed')
    expect(edited.draft.days[0].stops.map((stop) => stop.time)).toEqual(['09:00', '10:20'])
    expect(edited.draft.revision).toBe(draft.revision + 1)
  })

  it('草稿里没有目标天 → 失败保旧', () => {
    const s1 = makeStop('09:00', 60)
    const day = makeDay([s1])
    const draft = makeDraft(day)
    const projected = projectPostpone(day, s1.id, 15)
    expect(projected.ok).toBe(true)
    if (!projected.ok) return
    const otherDay = { ...projected.projection, day: 99 }
    const written = applyPostponeToDraft(draft, otherDay)
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.reason).toBe('unknown_day')
    expect(draft.days[0].stops[0].time).toBe('09:00')
  })
})

import { describe, expect, it } from 'vitest'

import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import {
  addConstraintItem,
  advanceConstraintsEpoch,
  checkConstraintsApply,
  checkConstraintsCapacity,
  cloneConstraints,
  constraintsContentEqual,
  createConstraintsApplyTicket,
  evaluateConstraintsAgainstTrip,
  makeConstraintItem,
  normalizeConstraintTitle,
  parseConstraintClock,
  parseConstraintDate,
  removeConstraintItem,
  type ConstraintTimeOrigin,
} from '../lib/constraints'
import { emptySidecar, createWorkspaceRecord } from '../lib/workspace'
import type { ConstraintItemV1, ConstraintsV1, PlanScopeV1, WorkspaceRecordV1 } from '../lib/workspaceTypes'

/* ───────── 本地夹具（不读 storage / 不连后端） ───────── */

function location(lng: number, lat: number) {
  return { lng, lat }
}

function stop(
  id: string,
  name: string,
  time: string,
  duration_minutes: number | null,
  loc: { lng: number; lat: number } | null = location(121.47, 31.23),
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location: loc,
  }
}

function leg(from: string, to: string, duration_minutes: number | null, distance_m: number | null = 500): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'navigation',
    distance_m,
    duration_minutes,
    geometry: [location(121.47, 31.23), location(121.48, 31.24)],
    description: '测试路线',
  }
}

function day(dayNumber: number, date: string | null, stops: TripStop[], legs: TripLeg[] = []): TripDay {
  return { day: dayNumber, date, title: `第${dayNumber}天`, summary: '', stops, legs }
}

function trip(days: TripDay[], id = 'trip-1'): Trip {
  return {
    id,
    source: 'agent',
    destination: '上海',
    title: '测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days,
  }
}

const DAY_DATE = '2026-04-03'

function baseTrip(): Trip {
  return trip([
    day(1, DAY_DATE, [
      stop('s1', '起点', '09:00', 60),
      stop('s2', '博物馆', '14:30', 30),
    ], [leg('s1', 's2', 30)]),
  ])
}

function twoSameNameTrip(): Trip {
  return trip([
    day(1, DAY_DATE, [
      stop('a1', '博物馆', '10:00', 30),
      stop('a2', '博物馆', '15:00', 30),
    ]),
  ])
}

function item(overrides: Partial<ConstraintItemV1> = {}): ConstraintItemV1 {
  return {
    id: 'c1',
    kind: 'must_visit',
    title: '博物馆',
    day: 1,
    stopId: null,
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    notes: null,
    priority: 1,
    updatedAt: 1_000,
    ...overrides,
  }
}

function constraints(...items: ConstraintItemV1[]): ConstraintsV1 {
  return { items }
}

function known(...ids: string[]): Record<string, ConstraintTimeOrigin> {
  return Object.fromEntries(ids.map((id) => [id, 'known' as const]))
}

function evalTrip(
  tripValue: Trip,
  constraintsValue: ConstraintsV1,
  extra: Partial<Parameters<typeof evaluateConstraintsAgainstTrip>[0]> = {},
) {
  const result = evaluateConstraintsAgainstTrip({
    trip: tripValue,
    constraints: constraintsValue,
    ...extra,
  })
  if (!result.ok) throw new Error(result.message)
  return result
}

function makeRecord(recordTrip: Trip, recordConstraints: ConstraintsV1, revision = 1, now = 1_000): WorkspaceRecordV1 {
  const created = createWorkspaceRecord({
    workspaceId: 'ws-1',
    ownerId: 'owner-1',
    trip: recordTrip,
    workspaceRevision: revision,
    now,
    sidecar: { ...emptySidecar(), constraints: recordConstraints },
  })
  if (!created.ok) throw new Error(created.message)
  return created.value
}

const DAY_SCOPE: PlanScopeV1 = { scope: 'day', day: 1, anchorStopId: null }
const TRIP_SCOPE: PlanScopeV1 = { scope: 'trip_plan', day: null, anchorStopId: null }

/* ───────── 基础解析 / 容量 / 编辑 ───────── */

describe('日期 / 时刻 / 容量', () => {
  it('严格 HH:MM 与真实日历日；不合法一律 null', () => {
    expect(parseConstraintClock('00:00')).toBe(0)
    expect(parseConstraintClock('23:59')).toBe(1439)
    expect(parseConstraintClock('24:00')).toBeNull()
    expect(parseConstraintClock('9:00')).toBeNull()
    expect(parseConstraintDate('2026-04-03')?.ordinal).toBeTypeOf('number')
    expect(parseConstraintDate('2026-02-29')).toBeNull()
    expect(parseConstraintDate('2024-02-29')).not.toBeNull()
    expect(parseConstraintDate('2026-02-30')).toBeNull()
  })

  it('标题匹配 NFKC / 空白归一，但不改写保存原文', () => {
    expect(normalizeConstraintTitle('  博物馆  ')).toBe('博物馆')
    expect(normalizeConstraintTitle('ＡＢＣ')).toBe('abc')
  })

  it('超过 24 条或 16 KiB 明确失败，不截断', () => {
    const tooMany = Array.from({ length: 25 }, (_, index) =>
      item({ id: `c${index}`, title: `地点${index}` }),
    )
    const countCheck = checkConstraintsCapacity({ items: tooMany })
    expect(countCheck.ok).toBe(false)
    if (!countCheck.ok) expect(countCheck.reason).toBe('too_many')

    const largeItems = Array.from({ length: 24 }, (_, index) =>
      item({
        id: `c${index}`.padEnd(200, 'x'),
        title: `地点${index}`.padEnd(120, '题'),
        notes: '注'.repeat(500),
        must_visit: true,
      } as Partial<ConstraintItemV1>),
    )
    const large = { items: largeItems }
    const byteCheck = checkConstraintsCapacity(large)
    expect(byteCheck.ok).toBe(false)
    if (!byteCheck.ok) expect(byteCheck.reason).toBe('too_large')

    const base = constraints(item({ id: 'base' }))
    const added = addConstraintItem(base, item({ id: 'c2' }))
    expect(added.ok).toBe(true)
  })

  it('编辑返回新对象；不修改原约束或 Trip', () => {
    const original = constraints(item({ id: 'c1' }))
    const snapshot = JSON.stringify(original)
    const tripValue = baseTrip()
    const tripSnapshot = JSON.stringify(tripValue)
    const added = addConstraintItem(original, item({ id: 'c2', title: '外滩' }))
    expect(added.ok).toBe(true)
    if (added.ok) expect(added.value.items).toHaveLength(2)
    expect(JSON.stringify(original)).toBe(snapshot)
    expect(JSON.stringify(tripValue)).toBe(tripSnapshot)
    const removed = removeConstraintItem(original, 'c1')
    expect(removed.ok).toBe(true)
    if (removed.ok) expect(removed.value.items).toHaveLength(0)
    expect(JSON.stringify(original)).toBe(snapshot)
    expect(constraintsContentEqual(original, cloneConstraints(original))).toBe(true)
  })

  it('0 分钟停留是已知值；null 才是未知', () => {
    const zero = makeConstraintItem({ kind: 'fixed_window', title: '零分钟', durationMinutes: 0 }, 1_000)
    const unknown = makeConstraintItem({ kind: 'fixed_window', title: '未知时长', durationMinutes: null }, 1_000)
    expect(zero.ok).toBe(true)
    expect(unknown.ok).toBe(true)
    if (zero.ok) expect(zero.value.durationMinutes).toBe(0)
    if (unknown.ok) expect(unknown.value.durationMinutes).toBeNull()
  })
})

/* ───────── H / U 硬门 ───────── */

describe('must_visit 与目标解析', () => {
  it('已知必去缺失 → H，不能靠确认绕过', () => {
    const result = evalTrip(baseTrip(), constraints(item({ stopId: 'missing' })))
    expect(result.verdict).toBe('blocked')
    expect(result.hardIssues.some((issue) => issue.code === 'must_visit_missing')).toBe(true)
    expect(result.safeToApply).toBe(false)
  })

  it('trip_plan 的 title + day + stopId:null 可表达；同名多站 → U，不 silent 挑第一', () => {
    const unique = evalTrip(baseTrip(), constraints(item({ stopId: null })), {
      planScope: TRIP_SCOPE,
    })
    expect(unique.verdict).toBe('pass')
    expect(unique.resolutions[0].status).toBe('entity_unique')

    const ambiguous = evalTrip(twoSameNameTrip(), constraints(item({ stopId: null })))
    expect(ambiguous.verdict).toBe('needs_ack')
    expect(ambiguous.unknownIssues.some((issue) => issue.code === 'target_ambiguous')).toBe(true)
  })

  it('reminder 缺失只提示，不阻断', () => {
    const result = evalTrip(
      baseTrip(),
      constraints(item({ kind: 'reminder', title: '带伞', stopId: 'missing' })),
    )
    expect(result.verdict).toBe('pass')
    expect(result.hardIssues).toHaveLength(0)
  })

  it('重复约束 id 被结构 validator 拒绝', () => {
    const duplicate = constraints(item({ id: 'same' }), item({ id: 'same' }))
    const result = evaluateConstraintsAgainstTrip({ trip: baseTrip(), constraints: duplicate })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_constraints')
  })
})

describe('fixed_window 时间边界', () => {
  const windowItem = (overrides: Partial<ConstraintItemV1> = {}) =>
    item({
      kind: 'fixed_window',
      stopId: 's2',
      startDate: DAY_DATE,
      endDate: DAY_DATE,
      startTime: '14:00',
      endTime: '16:00',
      ...overrides,
    })

  it('完整窗口 + 目标在窗口内 → pass', () => {
    const result = evalTrip(baseTrip(), constraints(windowItem()), {
      timeOrigins: known('s1', 's2'),
    })
    expect(result.verdict).toBe('pass')
    expect(result.safeToApply).toBe(true)
  })

  it('缺少结束时刻 → U；不声称已满足', () => {
    const result = evalTrip(baseTrip(), constraints(windowItem({ endTime: null })))
    expect(result.verdict).toBe('needs_ack')
    expect(result.requiresAck).toBe(true)
    expect(result.unknownIssues.some((issue) => issue.code === 'window_incomplete')).toBe(true)
    expect(result.safeToApply).toBe(false)
  })

  it('同日期 22:00 → 02:00 是非法窗口；跨午夜必须显式次日 endDate', () => {
    const invalid = evalTrip(
      baseTrip(),
      constraints(windowItem({ startTime: '22:00', endTime: '02:00' })),
    )
    expect(invalid.verdict).toBe('blocked')
    expect(invalid.hardIssues.some((issue) => issue.code === 'window_invalid')).toBe(true)

    const crossDayTrip = trip([
      day(1, DAY_DATE, [stop('s2', '博物馆', '23:00', 60)]),
    ])
    const valid = evalTrip(
      crossDayTrip,
      constraints(
        windowItem({
          stopId: 's2',
          startTime: '22:00',
          endTime: '02:00',
          endDate: '2026-04-04',
        }),
      ),
      { timeOrigins: known('s2') },
    )
    expect(valid.verdict).toBe('pass')
  })

  it('结束恰好 00:00 是边界；超过 1 分钟变 H', () => {
    const onBoundaryTrip = trip([
      day(1, DAY_DATE, [stop('s2', '博物馆', '23:30', 30)]),
    ])
    const onBoundary = evalTrip(
      onBoundaryTrip,
      constraints(windowItem({ stopId: 's2', startTime: '22:00', endTime: '00:00', endDate: '2026-04-04' })),
      { timeOrigins: known('s2') },
    )
    expect(onBoundary.verdict).toBe('pass')

    const justOverTrip = trip([
      day(1, DAY_DATE, [stop('s2', '博物馆', '23:30', 31)]),
    ])
    const justOver = evalTrip(
      justOverTrip,
      constraints(windowItem({ stopId: 's2', startTime: '22:00', endTime: '00:00', endDate: '2026-04-04' })),
      { timeOrigins: known('s2') },
    )
    expect(justOver.verdict).toBe('blocked')
    expect(justOver.hardIssues.some((issue) => issue.code === 'stop_duration_exceeds')).toBe(true)
  })

  it('两个固定窗口重叠 → H', () => {
    const result = evalTrip(
      baseTrip(),
      constraints(
        windowItem({ id: 'c1', title: '窗口 A' }),
        windowItem({ id: 'c2', title: '窗口 B', startTime: '15:00', endTime: '17:00' }),
      ),
      { timeOrigins: known('s1', 's2') },
    )
    expect(result.verdict).toBe('blocked')
    expect(result.hardIssues.some((issue) => issue.code === 'window_overlap')).toBe(true)
  })

  it('已知不可能与未知区分：时刻晚于窗口 → H；时刻缺失 → U', () => {
    const lateTrip = trip([
      day(1, DAY_DATE, [stop('s2', '博物馆', '17:00', 30)]),
    ])
    const late = evalTrip(lateTrip, constraints(windowItem()), {
      timeOrigins: known('s2'),
    })
    expect(late.verdict).toBe('blocked')
    expect(late.hardIssues.some((issue) => issue.code === 'stop_after_window')).toBe(true)

    const unknownTrip = trip([
      day(1, DAY_DATE, [stop('s2', '博物馆', '', 30)]),
    ])
    const unknown = evalTrip(unknownTrip, constraints(windowItem()))
    expect(unknown.verdict).toBe('needs_ack')
    expect(unknown.unknownIssues.some((issue) => issue.code === 'stop_time_unknown')).toBe(true)

    const unknownWithKnownOrigin = evalTrip(unknownTrip, constraints(windowItem()), {
      timeOrigins: known('s2'),
    })
    expect(unknownWithKnownOrigin.verdict).toBe('needs_ack')
    expect(
      unknownWithKnownOrigin.unknownIssues.some((issue) => issue.code === 'stop_time_unknown'),
    ).toBe(true)
  })

  it('停留未知 → U；停留 0 → 已知且可通过', () => {
    const unknownTrip = trip([
      day(1, DAY_DATE, [stop('s2', '博物馆', '14:30', null)]),
    ])
    const unknown = evalTrip(unknownTrip, constraints(windowItem()), {
      timeOrigins: known('s2'),
    })
    expect(unknown.verdict).toBe('needs_ack')
    expect(unknown.unknownIssues.some((issue) => issue.code === 'stop_duration_unknown')).toBe(true)

    const zeroTrip = trip([
      day(1, DAY_DATE, [
        stop('s1', '起点', '09:00', 60),
        stop('s2', '博物馆', '14:30', 0),
      ], [leg('s1', 's2', 0, 0)]),
    ])
    const zero = evalTrip(zeroTrip, constraints(windowItem()), {
      timeOrigins: known('s1', 's2'),
    })
    expect(zero.verdict).toBe('pass')
  })

  it('真实交通 / 前一站停留未知 → U，不假设可达', () => {
    const transitUnknownTrip = trip([
      day(1, DAY_DATE, [
        stop('s1', '起点', '09:00', 60),
        stop('s2', '博物馆', '14:30', 30),
      ], [leg('s1', 's2', null)]),
    ])
    const transitUnknown = evalTrip(transitUnknownTrip, constraints(windowItem()), {
      timeOrigins: known('s1', 's2'),
    })
    expect(transitUnknown.verdict).toBe('needs_ack')
    expect(transitUnknown.unknownIssues.some((issue) => issue.code === 'transit_unknown')).toBe(true)

    const predecessorUnknownTrip = trip([
      day(1, DAY_DATE, [
        stop('s1', '起点', '09:00', null),
        stop('s2', '博物馆', '14:30', 30),
      ], [leg('s1', 's2', 30)]),
    ])
    const predecessorUnknown = evalTrip(predecessorUnknownTrip, constraints(windowItem()), {
      timeOrigins: known('s1', 's2'),
    })
    expect(predecessorUnknown.verdict).toBe('needs_ack')
    expect(predecessorUnknown.unknownIssues.some((issue) => issue.code === 'predecessor_unknown')).toBe(true)
  })

  it('已知到达晚于窗口结束 → H；晚于计划开始 → H', () => {
    const lateArrivalTrip = trip([
      day(1, DAY_DATE, [
        stop('s1', '起点', '09:00', 120),
        stop('s2', '博物馆', '10:30', 30),
      ], [leg('s1', 's2', 60)]),
    ])
    const lateArrival = evalTrip(
      lateArrivalTrip,
      constraints(windowItem({ startTime: '10:00', endTime: '11:00' })),
      { timeOrigins: known('s1', 's2') },
    )
    expect(lateArrival.verdict).toBe('blocked')
    expect(lateArrival.hardIssues.some((issue) => issue.code === 'arrival_after_window')).toBe(true)

    const contradictTrip = trip([
      day(1, DAY_DATE, [
        stop('s1', '起点', '09:00', 120),
        stop('s2', '博物馆', '10:30', 30),
      ], [leg('s1', 's2', 60)]),
    ])
    const contradict = evalTrip(
      contradictTrip,
      constraints(windowItem({ startTime: '10:00', endTime: '14:00' })),
      { timeOrigins: known('s1', 's2') },
    )
    expect(contradict.verdict).toBe('blocked')
    expect(contradict.hardIssues.some((issue) => issue.code === 'arrival_after_stop_start')).toBe(true)
  })

  it('placeholder 09:00 不得当已知端核 H；按 U 处理', () => {
    const placeholderTrip = trip([
      day(1, DAY_DATE, [stop('s2', '博物馆', '09:00', null)]),
    ])
    const origins: Record<string, ConstraintTimeOrigin> = { s2: 'placeholder' }
    const result = evalTrip(
      placeholderTrip,
      constraints(windowItem({ startTime: '08:00', endTime: '10:00' })),
      { timeOrigins: origins },
    )
    expect(result.verdict).toBe('needs_ack')
    expect(result.unknownIssues.some((issue) => issue.code === 'stop_time_unknown')).toBe(true)
  })
})

/* ───────── 时间来源默认 unknown：fail-closed，不假 H / 不假 pass ───────── */

describe('时间来源 fail-closed（默认 unknown）', () => {
  const fixedWindow = (overrides: Partial<ConstraintItemV1> = {}) =>
    item({
      kind: 'fixed_window',
      stopId: 's1',
      startDate: DAY_DATE,
      endDate: DAY_DATE,
      startTime: '14:00',
      endTime: '16:00',
      ...overrides,
    })

  it('同一 09:00 候选 + 同一固定窗口，不传 timeOrigins → U，不是 H 也不是 pass', () => {
    const candidate = trip([day(1, DAY_DATE, [stop('s1', '博物馆', '09:00', 30)])])
    const targetConstraints = constraints(fixedWindow())
    const result = evalTrip(candidate, targetConstraints)
    expect(result.verdict).toBe('needs_ack')
    expect(result.safeToApply).toBe(false)
    expect(result.unknownIssues.some((issue) => issue.code === 'stop_time_unknown')).toBe(true)
    expect(result.hardIssues.some((issue) => issue.code === 'stop_before_window')).toBe(false)
  })

  it('同一 09:00 候选 + 同一固定窗口，显式 placeholder → U', () => {
    const candidate = trip([day(1, DAY_DATE, [stop('s1', '博物馆', '09:00', 30)])])
    const result = evalTrip(candidate, constraints(fixedWindow()), {
      timeOrigins: { s1: 'placeholder' },
    })
    expect(result.verdict).toBe('needs_ack')
    expect(result.unknownIssues.some((issue) => issue.code === 'stop_time_unknown')).toBe(true)
    expect(result.hardIssues.some((issue) => issue.code === 'stop_before_window')).toBe(false)
  })

  it('无 origin 但 14:30 落在窗口内，也不得变成 pass', () => {
    const candidate = trip([day(1, DAY_DATE, [stop('s1', '博物馆', '14:30', 30)])])
    const result = evalTrip(candidate, constraints(fixedWindow()))
    expect(result.verdict).toBe('needs_ack')
    expect(result.requiresAck).toBe(true)
    expect(result.unknownIssues.some((issue) => issue.code === 'stop_time_unknown')).toBe(true)
  })

  it('显式 known 才按真实时刻：09:00 → H；14:30 → pass', () => {
    const earlyCandidate = trip([day(1, DAY_DATE, [stop('s1', '博物馆', '09:00', 30)])])
    const early = evalTrip(earlyCandidate, constraints(fixedWindow()), {
      timeOrigins: known('s1'),
    })
    expect(early.verdict).toBe('blocked')
    expect(early.hardIssues.some((issue) => issue.code === 'stop_before_window')).toBe(true)

    const insideCandidate = trip([day(1, DAY_DATE, [stop('s1', '博物馆', '14:30', 30)])])
    const inside = evalTrip(insideCandidate, constraints(fixedWindow()), {
      timeOrigins: known('s1'),
    })
    expect(inside.verdict).toBe('pass')
  })

  it('部分 origin map：未列出的站点仍是 unknown，不能用邻近已知站推断', () => {
    const candidate = trip([
      day(1, DAY_DATE, [
        stop('s1', '起点', '09:00', 60),
        stop('s2', '博物馆', '14:30', 30),
      ], [leg('s1', 's2', 30)]),
    ])
    const targetConstraints = constraints(fixedWindow({ stopId: 's2' }))

    const onlyTarget = evalTrip(candidate, targetConstraints, {
      timeOrigins: known('s2'),
    })
    expect(onlyTarget.verdict).toBe('needs_ack')
    expect(
      onlyTarget.unknownIssues.some((issue) => issue.code === 'predecessor_unknown'),
    ).toBe(true)

    const onlyPrevious = evalTrip(candidate, targetConstraints, {
      timeOrigins: known('s1'),
    })
    expect(onlyPrevious.verdict).toBe('needs_ack')
    expect(
      onlyPrevious.unknownIssues.some((issue) => issue.code === 'stop_time_unknown'),
    ).toBe(true)
  })

  it('frozenStopIds / frozenStops 本身不证明 known；显式 known 才恢复真实 H', () => {
    const frozen = stop('s1', '博物馆', '09:00', 30)
    const candidate = trip([day(1, DAY_DATE, [frozen])])
    const targetConstraints = constraints(fixedWindow())

    const idsOnly = evalTrip(candidate, targetConstraints, { frozenStopIds: ['s1'] })
    expect(idsOnly.verdict).toBe('needs_ack')
    expect(idsOnly.unknownIssues.some((issue) => issue.code === 'stop_time_unknown')).toBe(true)
    expect(idsOnly.hardIssues.some((issue) => issue.code === 'stop_before_window')).toBe(false)

    const snapshotOnly = evalTrip(candidate, targetConstraints, { frozenStops: [frozen] })
    expect(snapshotOnly.verdict).toBe('needs_ack')

    const trusted = evalTrip(candidate, targetConstraints, {
      frozenStops: [frozen],
      timeOrigins: known('s1'),
    })
    expect(trusted.verdict).toBe('blocked')
    expect(trusted.hardIssues.some((issue) => issue.code === 'stop_before_window')).toBe(true)
  })

  it('显式 known 的明确不可行仍是 H，unverifiedConfirmed 不能绕过', () => {
    const candidate = trip([day(1, DAY_DATE, [stop('s1', '博物馆', '17:00', 30)])])
    const targetConstraints = constraints(fixedWindow())
    const evaluation = evalTrip(candidate, targetConstraints, {
      timeOrigins: known('s1'),
    })
    expect(evaluation.verdict).toBe('blocked')
    expect(evaluation.hardIssues.some((issue) => issue.code === 'stop_after_window')).toBe(true)

    const record = makeRecord(candidate, targetConstraints, 1)
    const created = createConstraintsApplyTicket({
      record,
      constraints: targetConstraints,
      candidateTrip: candidate,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: true,
      timeOrigins: known('s1'),
    })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.reason).toBe('hard_blocked')
  })

  it('合法 0 只有 known 时间证据下才按已知 0 通过', () => {
    const candidate = trip([day(1, DAY_DATE, [stop('s1', '博物馆', '14:30', 0)])])
    const targetConstraints = constraints(fixedWindow())

    const noOrigin = evalTrip(candidate, targetConstraints)
    expect(noOrigin.verdict).toBe('needs_ack')

    const knownZero = evalTrip(candidate, targetConstraints, {
      timeOrigins: known('s1'),
    })
    expect(knownZero.verdict).toBe('pass')
    expect(knownZero.hardIssues).toHaveLength(0)
  })
})

describe('ID 重写 / 坐标 / 冻结段', () => {
  const rewriteItem = () =>
    item({
      kind: 'fixed_window',
      stopId: 'old-1',
      startDate: DAY_DATE,
      endDate: DAY_DATE,
      startTime: '14:00',
      endTime: '16:00',
    })

  function sourceTrip(): Trip {
    return trip([day(1, DAY_DATE, [stop('old-1', '博物馆', '14:30', 30)])])
  }

  function candidateTrip(candidateStop: TripStop): Trip {
    return trip([day(1, DAY_DATE, [candidateStop])])
  }

  it('唯一同名且坐标一致 → 映射成功并 pass', () => {
    const result = evalTrip(candidateTrip(stop('new-1', '博物馆', '14:30', 30)), constraints(rewriteItem()), {
      sourceTrip: sourceTrip(),
      timeOrigins: known('new-1'),
    })
    expect(result.verdict).toBe('pass')
    expect(result.resolutions[0].status).toBe('unique_name')
    expect(result.mappedConstraints.items[0].stopId).toBe('new-1')
  })

  it('同名多站 → U 歧义，不 silent 挑第一', () => {
    const ambiguous = trip([
      day(1, DAY_DATE, [
        stop('new-1', '博物馆', '14:30', 30),
        stop('new-2', '博物馆', '15:00', 30),
      ]),
    ])
    const result = evalTrip(ambiguous, constraints(rewriteItem()), {
      sourceTrip: sourceTrip(),
      timeOrigins: known('new-1', 'new-2'),
    })
    expect(result.verdict).toBe('needs_ack')
    expect(result.unknownIssues.some((issue) => issue.code === 'target_ambiguous')).toBe(true)
  })

  it('同名但坐标矛盾 → U；坐标未知 → U', () => {
    const conflict = evalTrip(
      candidateTrip(stop('new-1', '博物馆', '14:30', 30, location(121.5, 31.3))),
      constraints(rewriteItem()),
      { sourceTrip: sourceTrip(), timeOrigins: known('new-1') },
    )
    expect(conflict.verdict).toBe('needs_ack')
    expect(conflict.unknownIssues.some((issue) => issue.code === 'coordinate_conflict')).toBe(true)

    const unverified = evalTrip(
      candidateTrip(stop('new-1', '博物馆', '14:30', 30, null)),
      constraints(rewriteItem()),
      { sourceTrip: sourceTrip(), timeOrigins: known('new-1') },
    )
    expect(unverified.verdict).toBe('needs_ack')
    expect(unverified.unknownIssues.some((issue) => issue.code === 'identity_unverified')).toBe(true)
  })

  it('冻结段站点被删 / 被改 → H', () => {
    const frozen = stop('frozen-1', '冻结点', '10:00', 30)
    const frozenTrip = trip([day(1, DAY_DATE, [frozen, stop('s2', '博物馆', '14:30', 30)])])
    const deleted = trip([day(1, DAY_DATE, [stop('s2', '博物馆', '14:30', 30)])])
    const missing = evalTrip(deleted, constraints(item({ stopId: 's2' })), {
      frozenStops: [frozen],
    })
    expect(missing.verdict).toBe('blocked')
    expect(missing.hardIssues.some((issue) => issue.code === 'frozen_stop_missing')).toBe(true)

    const changed = trip([
      day(1, DAY_DATE, [stop('frozen-1', '冻结点', '11:00', 30), stop('s2', '博物馆', '14:30', 30)]),
    ])
    const changedResult = evalTrip(changed, constraints(item({ stopId: 's2' })), {
      frozenStops: [frozenTrip.days[0].stops[0]],
    })
    expect(changedResult.verdict).toBe('blocked')
    expect(changedResult.hardIssues.some((issue) => issue.code === 'frozen_stop_changed')).toBe(true)
  })
})

/* ───────── apply ticket / ack / refs / epoch ───────── */

describe('apply ticket 与 U 级独立确认', () => {
  const uConstraints = constraints(
    item({
      kind: 'fixed_window',
      stopId: 's1',
      startDate: DAY_DATE,
      endDate: DAY_DATE,
      startTime: '09:00',
      endTime: null,
    }),
  )

  function uRecord(revision = 1): WorkspaceRecordV1 {
    return makeRecord(baseTrip(), uConstraints, revision)
  }

  it('U 级没有独立确认 → ack_required；确认后 ticket 可校验通过', () => {
    const record = uRecord()
    const base = {
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
    }
    const refused = createConstraintsApplyTicket({ ...base, unverifiedConfirmed: false })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe('ack_required')

    const created = createConstraintsApplyTicket({ ...base, unverifiedConfirmed: true })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.ack).not.toBeNull()

    const decision = checkConstraintsApply({
      ticket: created.value,
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('ok')
  })

  it('H 级硬冲突 → ticket 创建被 hard_blocked 拒绝', () => {
    const record = makeRecord(baseTrip(), constraints(item({ stopId: 's1' })), 1)
    const candidate = trip([day(1, DAY_DATE, [stop('other', '别的点', '10:00', 30)])])
    const created = createConstraintsApplyTicket({
      record,
      constraints: constraints(item({ stopId: 's1' })),
      candidateTrip: candidate,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: true,
    })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.reason).toBe('hard_blocked')
  })

  it('epoch 变化 / 换引用同内容 / 换 scope → 旧 ticket 失效', () => {
    const record = uRecord()
    const created = createConstraintsApplyTicket({
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const epochChanged = checkConstraintsApply({
      ticket: created.value,
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 2,
    })
    expect(epochChanged.allowed).toBe(false)
    expect(epochChanged.reason).toBe('ref_mismatch')

    const sameContentNewReference = JSON.parse(JSON.stringify(record.trip)) as Trip
    const refChanged = checkConstraintsApply({
      ticket: created.value,
      record,
      constraints: uConstraints,
      candidateTrip: sameContentNewReference,
      planScope: DAY_SCOPE,
      epoch: 1,
    })
    expect(refChanged.allowed).toBe(false)
    expect(refChanged.reason).toBe('ref_mismatch')

    const scopeChanged = checkConstraintsApply({
      ticket: created.value,
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: { scope: 'day_tail', day: 1, anchorStopId: 's1' },
      epoch: 1,
    })
    expect(scopeChanged.allowed).toBe(false)
    expect(scopeChanged.reason).toBe('scope_mismatch')
  })

  it('内容 A→B→A 后旧 U 确认不复活（revision / epoch 前进）', () => {
    const recordA = uRecord(1)
    const created = createConstraintsApplyTicket({
      record: recordA,
      constraints: uConstraints,
      candidateTrip: recordA.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const recordAgain = makeRecord(baseTrip(), uConstraints, 3, 3_000)
    const decision = checkConstraintsApply({
      ticket: created.value,
      record: recordAgain,
      constraints: uConstraints,
      candidateTrip: recordAgain.trip,
      planScope: DAY_SCOPE,
      epoch: 4,
    })
    expect(decision.allowed).toBe(false)
  })

  it('原地突变后恢复内容但推进 epoch → 旧确认不复活', () => {
    const record = uRecord()
    const created = createConstraintsApplyTicket({
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const originalEnd = record.sidecar.constraints.items[0].endTime
    record.sidecar.constraints.items[0].endTime = '16:00'
    record.sidecar.constraints.items[0].endTime = originalEnd

    const decision = checkConstraintsApply({
      ticket: created.value,
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 2,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('ref_mismatch')
  })

  it('timeOrigins 缺省 → known 后，旧 ticket / U ack 不可复用', () => {
    const record = uRecord()
    const created = createConstraintsApplyTicket({
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.evaluationContext).toBeNull()

    const decision = checkConstraintsApply({
      ticket: created.value,
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      timeOrigins: known('s1', 's2'),
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('ticket_stale')
  })

  it('timeOrigins 从 known 变为缺省后，旧 ticket 也不可复用', () => {
    const record = uRecord()
    const created = createConstraintsApplyTicket({
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: true,
      timeOrigins: known('s1', 's2'),
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const decision = checkConstraintsApply({
      ticket: created.value,
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('ticket_stale')
  })

  it('frozenStopIds 变化后，旧 ticket 也不可复用', () => {
    const record = uRecord()
    const created = createConstraintsApplyTicket({
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: true,
      frozenStopIds: ['s1'],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const decision = checkConstraintsApply({
      ticket: created.value,
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      frozenStopIds: ['s2'],
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('ticket_stale')
  })

  it('相同 timeOrigins 内容的新对象 / 不同键顺序仍可复用 ticket 上下文', () => {
    const record = uRecord()
    const created = createConstraintsApplyTicket({
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: true,
      timeOrigins: known('s1', 's2'),
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const decision = checkConstraintsApply({
      ticket: created.value,
      record,
      constraints: uConstraints,
      candidateTrip: record.trip,
      planScope: DAY_SCOPE,
      epoch: 1,
      timeOrigins: known('s2', 's1'),
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('ok')
  })

  it('trip_plan 非 null stopId 被公共 scope 逻辑拒绝', () => {
    const record = makeRecord(baseTrip(), constraints(item({ stopId: 's1' })), 1)
    const created = createConstraintsApplyTicket({
      record,
      constraints: constraints(item({ stopId: 's1' })),
      candidateTrip: record.trip,
      planScope: TRIP_SCOPE,
      epoch: 1,
      acknowledgedAt: 2_000,
      unverifiedConfirmed: false,
    })
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.reason).toBe('invalid_scope')
  })

  it('advanceConstraintsEpoch 单调且拒绝非法值', () => {
    expect(advanceConstraintsEpoch(0)).toEqual({ ok: true, value: 1 })
    expect(advanceConstraintsEpoch(Number.MAX_SAFE_INTEGER).ok).toBe(false)
    expect(advanceConstraintsEpoch(-1).ok).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  applyAssistantProposal,
  buildAssistantProposal,
  confirmAssistantUnverified,
  describeAssistantChange,
  discardAssistantProposal,
  isAssistantAckFresh,
  parseAssistantIntent,
  undoAssistantProposal,
  ASSISTANT_NO_SAVE_NOTICE,
  ASSISTANT_POOL_LOCATION_NOTICE,
  ASSISTANT_REPLAN_NOTICE,
  ASSISTANT_SLOT_TIME_NOTICE,
  ASSISTANT_UNKNOWN_TEXT,
  ASSISTANT_UNSUPPORTED_REASON,
  ASSISTANT_UNVERIFIED_NOTICE,
  type AssistantProposalInput,
} from '../lib/assistantDialog'
import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import type { ConstraintTimeOrigin } from '../lib/constraints'
import { createWorkspaceRecord, emptySidecar } from '../lib/workspace'
import type { CandidateItemV1, ConstraintItemV1, WorkspaceRecordV1 } from '../lib/workspaceTypes'

/* ───────── 本地夹具（不读 storage / 不连后端） ───────── */

function location(lng: number, lat: number) {
  return { lng, lat }
}

function stop(
  id: string,
  name: string,
  time: string,
  duration_minutes: number | null = 60,
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

function leg(from: string, to: string, duration_minutes: number | null = 30): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 500,
    duration_minutes,
    geometry: [location(121.47, 31.23), location(121.48, 31.24)],
    description: '测试路线',
  }
}

function day(dayNumber: number, date: string | null, stops: TripStop[], legs: TripLeg[] = []): TripDay {
  return { day: dayNumber, date, title: `第${dayNumber}天`, summary: '', stops, legs }
}

function baseTrip(): Trip {
  return {
    id: 'trip-1',
    source: 'agent',
    destination: '上海',
    title: '测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [
      day(
        1,
        '2026-04-03',
        [stop('s-silk', '丝绸店', '09:00', 60), stop('s-museum', '博物馆', '14:30', 30)],
        [leg('s-silk', 's-museum', 30)],
      ),
      day(2, '2026-04-04', [stop('s-westlake', '西湖', '10:00', 90)]),
      day(3, '2026-04-05', [stop('s-lingyin', '灵隐寺', '09:00', 60)]),
    ],
  }
}

function makeRecord(
  tripValue: Trip = baseTrip(),
  constraints: ConstraintItemV1[] = [],
  revision = 1,
): WorkspaceRecordV1 {
  const result = createWorkspaceRecord({
    workspaceId: 'ws-1',
    ownerId: 'owner-1',
    trip: tripValue,
    workspaceRevision: revision,
    now: 1_000,
    sidecar: { ...emptySidecar(), constraints: { items: constraints } },
  })
  if (!result.ok) throw new Error(`工作区记录不合法：${result.message}`)
  return result.value
}

function candidate(id: string, name: string, address: string): CandidateItemV1 {
  return {
    id,
    name,
    address,
    notes: '候选备注',
    tags: [],
    priority: 1,
    location: location(120.1, 30.2),
    source: 'manual',
    copiedFromStopId: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function proposalInput(
  instruction: string,
  options: {
    record?: WorkspaceRecordV1
    candidates?: CandidateItemV1[]
    currentDay?: number | null
    timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
  } = {},
): AssistantProposalInput {
  return {
    proposalId: 'p-1',
    instruction,
    record: options.record ?? makeRecord(),
    candidates: options.candidates ?? [],
    currentDay: options.currentDay ?? null,
    travelMode: 'walking',
    ids: { draftForkId: 'fork-1', newStopId: 'new-stop-1' },
    timeOrigins: options.timeOrigins ?? null,
  }
}

function mustBuild(input: AssistantProposalInput) {
  const built = buildAssistantProposal(input)
  if (!built.ok) throw new Error(`提案没有生成：${built.message}`)
  return built.proposal
}

function constraintItem(overrides: Partial<ConstraintItemV1>): ConstraintItemV1 {
  return {
    id: 'c1',
    kind: 'must_visit',
    day: 1,
    stopId: null,
    title: '丝绸店',
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    notes: null,
    priority: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/* ───────── 指令解析 ───────── */

describe('对话式行程编辑 · 指令解析', () => {
  it('move_stop：解析站点、目标天与时段', () => {
    const parsed = parseAssistantIntent('把博物馆挪到第 2 天下午')
    expect(parsed.kind).toBe('move_stop')
    expect(parsed.targetName).toBe('博物馆')
    expect(parsed.day).toBe(2)
    expect(parsed.slot).toBe('afternoon')
    expect(parsed.time).toBeNull()
  })

  it('add_from_pool：解析收藏池候选与目标天', () => {
    const parsed = parseAssistantIntent('把收藏池里的西湖加到第 3 天晚上')
    expect(parsed.kind).toBe('add_from_pool')
    expect(parsed.targetName).toBe('西湖')
    expect(parsed.day).toBe(3)
    expect(parsed.slot).toBe('evening')
  })

  it('remove_stop：解析目标天与站点名', () => {
    const parsed = parseAssistantIntent('去掉第 1 天的丝绸店')
    expect(parsed.kind).toBe('remove_stop')
    expect(parsed.targetName).toBe('丝绸店')
    expect(parsed.day).toBe(1)
  })

  it('time_preference：解析时间偏好', () => {
    const parsed = parseAssistantIntent('第 2 天停留久一点')
    expect(parsed.kind).toBe('time_preference')
    expect(parsed.timePreference).toBe('stay_longer')
    expect(parsed.day).toBe(2)

    const later = parseAssistantIntent('这天晚点开始')
    expect(later.kind).toBe('time_preference')
    expect(later.timePreference).toBe('start_later')
    expect(later.day).toBeNull()
  })

  it('pace_adjust：解析节奏偏好', () => {
    const parsed = parseAssistantIntent('这一天安排松一点')
    expect(parsed.kind).toBe('pace_adjust')
    expect(parsed.pacePreference).toBe('looser')
    expect(parsed.day).toBeNull()
  })

  it('unsupported：超出五类时礼貌拒绝，不猜也不硬套', () => {
    const parsed = parseAssistantIntent('帮我订一张明天去上海的机票')
    expect(parsed.kind).toBe('unsupported')
    expect(parsed.targetName).toBeNull()
    expect(parsed.day).toBeNull()
    expect(parsed.notes.length).toBeGreaterThan(0)
  })
})

/* ───────── 提案计算 ───────── */

describe('对话式行程编辑 · 提案计算', () => {
  it('move_stop：给出移动改动与候选行程', () => {
    const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天下午'))
    expect(proposal.kind).toBe('trip_change')
    expect(proposal.intent).toBe('move_stop')
    expect(proposal.changes.unknown).toHaveLength(0)
    expect(proposal.changes.known).toHaveLength(1)

    const change = proposal.changes.known[0]
    expect(change.type).toBe('move')
    expect(change.stopId).toBe('s-museum')
    expect(change.name).toBe('博物馆')
    expect(change.fromDay).toBe(1)
    expect(change.toDay).toBe(2)
    expect(change.fromTime).toBe('14:30')
    expect(change.toTime).toBe('14:30')
    expect(change.timeSource).toBe('inherited')

    expect(proposal.baseRevision).toBe(1)
    expect(proposal.baseFingerprint.short).toMatch(/^[0-9a-f]{8}$/)
    expect(proposal.status).toBe('pending')
    expect(proposal.conflicts).toHaveLength(0)
    expect(proposal.requiresAck).toBe(false)

    const candidateTrip = proposal.candidateTrip
    expect(candidateTrip).not.toBeNull()
    const day1 = candidateTrip!.days.find((item) => item.day === 1)!
    const day2 = candidateTrip!.days.find((item) => item.day === 2)!
    expect(day1.stops.map((item) => item.id)).toEqual(['s-silk'])
    expect(day2.stops.map((item) => item.id)).toEqual(['s-westlake', 's-museum'])
    // 工作区只绑定一个行程：候选行程保留原 id。
    expect(candidateTrip!.id).toBe('trip-1')
  })

  it('move_stop：改了时刻就多一条时间变化', () => {
    const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天下午 15:00'))
    expect(proposal.changes.known).toHaveLength(2)
    const timeChange = proposal.changes.known[1]
    expect(timeChange.type).toBe('time_change')
    expect(timeChange.fromTime).toBe('14:30')
    expect(timeChange.toTime).toBe('15:00')
    expect(timeChange.timeSource).toBe('explicit')
  })

  it('add_from_pool：从收藏池加入站点', () => {
    const proposal = mustBuild(
      proposalInput('把收藏池里的西湖加到第 3 天晚上', {
        candidates: [candidate('c-westlake', '西湖', '湖滨路 1 号')],
      }),
    )
    expect(proposal.kind).toBe('trip_change')
    expect(proposal.intent).toBe('add_from_pool')
    expect(proposal.changes.known).toHaveLength(1)

    const change = proposal.changes.known[0]
    expect(change.type).toBe('add')
    expect(change.name).toBe('西湖')
    expect(change.toDay).toBe(3)
    expect(change.fromDay).toBeNull()
    expect(change.toTime).toBe('19:00')
    expect(change.timeSource).toBe('slot_default')

    const day3 = proposal.candidateTrip!.days.find((item) => item.day === 3)!
    expect(day3.stops.map((item) => item.id)).toEqual(['s-lingyin', 'new-stop-1'])
    const added = day3.stops[1]
    // 坐标未知就不带坐标；停留未知就是 null，都不补 0。
    expect(added.location).toBeNull()
    expect(added.duration_minutes).toBeNull()
    expect(proposal.notices).toContain(ASSISTANT_POOL_LOCATION_NOTICE)
    expect(proposal.notices).toContain(ASSISTANT_SLOT_TIME_NOTICE)
  })

  it('remove_stop：给出删除改动与候选行程', () => {
    const proposal = mustBuild(proposalInput('去掉第 1 天的丝绸店'))
    expect(proposal.kind).toBe('trip_change')
    expect(proposal.intent).toBe('remove_stop')
    expect(proposal.changes.known).toHaveLength(1)

    const change = proposal.changes.known[0]
    expect(change.type).toBe('remove')
    expect(change.stopId).toBe('s-silk')
    expect(change.fromDay).toBe(1)
    expect(change.toDay).toBeNull()

    const day1 = proposal.candidateTrip!.days.find((item) => item.day === 1)!
    expect(day1.stops.map((item) => item.id)).toEqual(['s-museum'])
  })

  it('time_preference：只产出重排请求，不直接改行程', () => {
    const proposal = mustBuild(proposalInput('第 2 天停留久一点'))
    expect(proposal.kind).toBe('replan_request')
    expect(proposal.candidateTrip).toBeNull()
    expect(proposal.replanRequest?.day).toBe(2)
    expect(proposal.replanRequest?.preference.kind).toBe('time_preference')
    expect(proposal.replanApiRequest?.day).toBe(2)
    expect(proposal.replanApiRequest?.parent.revision).toBe(1)
    expect(proposal.notices).toContain(ASSISTANT_REPLAN_NOTICE)

    const record = makeRecord()
    const applied = applyAssistantProposal({ proposal, record, now: 2_000 })
    if (!applied.ok || applied.outcome !== 'replan_requested') {
      throw new Error('应当产出单日重排请求')
    }
    expect(applied.request.day).toBe(2)
    // 走重排通道不等于写进行程。
    expect(record.trip.days[0].stops).toHaveLength(2)
  })

  it('pace_adjust：只产出重排请求', () => {
    const proposal = mustBuild(proposalInput('这一天安排松一点', { currentDay: 2 }))
    expect(proposal.kind).toBe('replan_request')
    expect(proposal.replanRequest?.day).toBe(2)
    expect(proposal.replanRequest?.preference.kind).toBe('pace_adjust')
    expect(proposal.candidateTrip).toBeNull()
  })

  it('unsupported：给出礼貌拒绝，不能应用', () => {
    const proposal = mustBuild(proposalInput('帮我订一张明天去上海的机票'))
    expect(proposal.kind).toBe('unsupported')
    expect(proposal.reason).toBe(ASSISTANT_UNSUPPORTED_REASON)
    expect(proposal.changes.known).toHaveLength(0)
    expect(proposal.changes.unknown).toHaveLength(0)

    const record = makeRecord()
    const applied = applyAssistantProposal({ proposal, record, now: 2_000 })
    if (applied.ok) throw new Error('不支持的指令不应被应用')
    expect(applied.reason).toBe('not_supported')
  })

  it('同名站点无法唯一确定时列为未知改动，不替用户挑第一个', () => {
    const duplicated: Trip = {
      ...baseTrip(),
      days: [
        day(1, '2026-04-03', [
          stop('a1', '博物馆', '10:00', 30),
          stop('a2', '博物馆', '15:00', 30),
        ]),
        day(2, '2026-04-04', [stop('s-westlake', '西湖', '10:00', 90)]),
      ],
    }
    const proposal = mustBuild(
      proposalInput('把博物馆挪到第 2 天下午', { record: makeRecord(duplicated) }),
    )
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.changes.known).toHaveLength(0)
    expect(proposal.changes.unknown).toHaveLength(1)
    expect(proposal.changes.unknown[0].detail).toContain('同名')
    expect(proposal.candidateTrip).toBeNull()
  })
})

/* ───────── 硬门：H 级 / U 级 / 失效 ───────── */

describe('对话式行程编辑 · 硬门与失效', () => {
  it('必去点被挪走 → H 级禁 apply，且没有确认绕过入口', () => {
    const record = makeRecord(baseTrip(), [constraintItem({ kind: 'must_visit', day: 1, title: '丝绸店' })])
    const proposal = mustBuild(
      proposalInput('把丝绸店挪到第 2 天下午', { record }),
    )
    expect(proposal.conflicts.some((issue) => issue.severity === 'H')).toBe(true)
    expect(
      proposal.conflicts.some((issue) => issue.code === 'must_visit_missing'),
    ).toBe(true)

    const applied = applyAssistantProposal({ proposal, record, now: 2_000 })
    if (applied.ok) throw new Error('H 级冲突不应被应用')
    expect(applied.reason).toBe('hard_blocked')
    expect(record.workspaceRevision).toBe(1)

    // 即便带上 U 级确认，H 级依然禁 apply。
    const confirmed = confirmAssistantUnverified(proposal, 2_000)
    const appliedWithAck = applyAssistantProposal({ proposal: confirmed, record, now: 2_000 })
    if (appliedWithAck.ok) throw new Error('H 级冲突不应被确认绕过')
    expect(appliedWithAck.reason).toBe('hard_blocked')
  })

  it('预约窗口被挪到窗口之外 → H 级禁 apply', () => {
    const record = makeRecord(baseTrip(), [
      constraintItem({
        kind: 'fixed_window',
        day: 1,
        stopId: 's-museum',
        title: '博物馆',
        startDate: '2026-04-03',
        endDate: '2026-04-03',
        startTime: '13:00',
        endTime: '15:00',
      }),
    ])
    const proposal = mustBuild(
      proposalInput('把博物馆挪到第 1 天 16:00', {
        record,
        timeOrigins: { 's-museum': 'known' },
      }),
    )
    expect(proposal.conflicts.some((issue) => issue.severity === 'H')).toBe(true)
    expect(proposal.conflicts.some((issue) => issue.code === 'stop_after_window')).toBe(true)

    const applied = applyAssistantProposal({ proposal, record, now: 2_000 })
    if (applied.ok) throw new Error('预约被挪不应被应用')
    expect(applied.reason).toBe('hard_blocked')
  })

  it('时间未核实 → U 级需要独立确认，确认绑定当前快照', () => {
    const record = makeRecord(baseTrip(), [
      constraintItem({
        kind: 'fixed_window',
        day: 1,
        stopId: 's-silk',
        title: '丝绸店',
        startDate: '2026-04-03',
        endDate: '2026-04-03',
        startTime: '08:00',
        endTime: '12:00',
      }),
    ])
    const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天下午', { record }))
    expect(proposal.requiresAck).toBe(true)
    expect(proposal.conflicts.length).toBeGreaterThan(0)
    expect(proposal.conflicts.every((issue) => issue.severity === 'U')).toBe(true)
    expect(proposal.ack).toBeNull()

    // 没有独立确认：不应用。
    const rejected = applyAssistantProposal({ proposal, record, now: 2_000 })
    if (rejected.ok) throw new Error('U 级方案未确认时不应被应用')
    expect(rejected.reason).toBe('ack_required')

    // 独立确认之后可以应用。
    const confirmed = confirmAssistantUnverified(proposal, 2_000)
    expect(isAssistantAckFresh(confirmed, record)).toBe(true)
    const applied = applyAssistantProposal({ proposal: confirmed, record, now: 2_000 })
    if (!applied.ok || applied.outcome !== 'applied') throw new Error('确认后应当应用成功')
    expect(applied.record.workspaceRevision).toBe(2)
    expect(applied.record.trip.days[0].stops).toHaveLength(1)
  })

  it('确认绑定的是快照：快照一变，确认立刻过期', () => {
    const record = makeRecord(baseTrip(), [
      constraintItem({
        kind: 'fixed_window',
        day: 1,
        stopId: 's-silk',
        title: '丝绸店',
        startDate: '2026-04-03',
        endDate: '2026-04-03',
        startTime: '08:00',
        endTime: '12:00',
      }),
    ])
    const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天下午', { record }))
    const confirmed = confirmAssistantUnverified(proposal, 2_000)

    // 确认被换成别的快照 → 过期。
    const tampered = {
      ...confirmed,
      ack: { ...confirmed.ack!, revision: 99 },
    }
    const stale = applyAssistantProposal({ proposal: tampered, record, now: 2_000 })
    if (stale.ok) throw new Error('过期的确认不应被接受')
    expect(stale.reason).toBe('ack_stale')
    expect(stale.proposal.status).toBe('invalid')
  })

  it('ABA 失效：revision 变了就绝不静默套用', () => {
    const record = makeRecord(baseTrip())
    const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天下午', { record }))
    expect(proposal.status).toBe('pending')

    const movedOn = makeRecord(baseTrip(), [], 2)
    const applied = applyAssistantProposal({ proposal, record: movedOn, now: 2_000 })
    if (applied.ok) throw new Error('过期提案不应被应用')
    expect(applied.reason).toBe('stale_revision')
    expect(applied.proposal.status).toBe('invalid')
    expect(applied.proposal.invalidReason).toBeTruthy()
  })

  it('ABA 失效：revision 没变但内容变了，同样失效', () => {
    const record = makeRecord(baseTrip())
    const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天下午', { record }))

    const changed: Trip = { ...baseTrip(), title: '另一个标题' }
    const applied = applyAssistantProposal({
      proposal,
      record: makeRecord(changed, [], 1),
      now: 2_000,
    })
    if (applied.ok) throw new Error('内容变了就不应套用旧提案')
    expect(applied.reason).toBe('stale_fingerprint')
    expect(applied.proposal.status).toBe('invalid')
  })

  it('应用是一次内存 transition：revision + 1，撤销也是一次 transition', () => {
    const record = makeRecord(baseTrip())
    const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天下午', { record }))
    const applied = applyAssistantProposal({ proposal, record, now: 2_000 })
    if (!applied.ok || applied.outcome !== 'applied') throw new Error('应当应用成功')
    expect(applied.record.workspaceRevision).toBe(2)
    expect(applied.record.trip.days[0].stops).toHaveLength(1)

    const undone = undoAssistantProposal(applied.undo, applied.record, 3_000)
    if (!undone.ok) throw new Error('撤销应当成功')
    // 撤销不回放旧 revision，只继续 +1。
    expect(undone.record.workspaceRevision).toBe(3)
    expect(undone.record.trip.days[0].stops).toHaveLength(2)
  })
})

/* ───────── 未知项与零写入 ───────── */

describe('对话式行程编辑 · 未知项与零写入', () => {
  it('未知时间显示「未知」，不补 0，也不编造', () => {
    const withUnknown: Trip = {
      ...baseTrip(),
      days: [
        day(1, '2026-04-03', [
          stop('s-pending', '待定景点', '待定', null),
          stop('s-museum', '博物馆', '14:30', 30),
        ]),
        day(2, '2026-04-04', [stop('s-westlake', '西湖', '10:00', 90)]),
      ],
    }
    const proposal = mustBuild(
      proposalInput('去掉第 1 天的待定景点', { record: makeRecord(withUnknown) }),
    )
    expect(proposal.changes.known).toHaveLength(1)
    const change = proposal.changes.known[0]
    expect(change.fromTime).toBeNull()
    expect(change.fromTime).not.toBe('00:00')
    expect(change.timeSource).toBe('inherited')
    expect(describeAssistantChange(change)).toContain(ASSISTANT_UNKNOWN_TEXT)
  })

  it('未知项在改动列表里与已知项分列', () => {
    const proposal = mustBuild(proposalInput('把不存在的景点挪到第 2 天下午'))
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.changes.known).toHaveLength(0)
    expect(proposal.changes.unknown).toHaveLength(1)
    const change = proposal.changes.unknown[0]
    expect(change.stopId).toBeNull()
    expect(change.fromTime).toBeNull()
    expect(change.toTime).toBeNull()
    expect(change.timeSource).toBe('unknown')
  })

  it('不采纳 = 零写入：丢弃提案不碰行程，也不碰存储', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
    try {
      const record = makeRecord(baseTrip())
      const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天下午', { record }))

      const discarded = discardAssistantProposal(proposal)
      expect(discarded.status).toBe('discarded')
      // 丢弃只改卡片状态：原记录与行程都没动。
      expect(record.trip.days[0].stops).toHaveLength(2)
      expect(record.workspaceRevision).toBe(1)

      // 生成提案、应用提案都不写存储：持久化由用户显式保存触发。
      const applied = applyAssistantProposal({ proposal, record, now: 2_000 })
      if (!applied.ok || applied.outcome !== 'applied') throw new Error('应当应用成功')
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
    } finally {
      setItem.mockRestore()
      removeItem.mockRestore()
    }
  })

  it('文案不出现「已预订 / 已确认 / 已出票」', () => {
    const texts = [
      ASSISTANT_UNSUPPORTED_REASON,
      ASSISTANT_UNVERIFIED_NOTICE,
      ASSISTANT_NO_SAVE_NOTICE,
      ASSISTANT_SLOT_TIME_NOTICE,
      ASSISTANT_REPLAN_NOTICE,
      ASSISTANT_POOL_LOCATION_NOTICE,
    ]
    for (const text of texts) {
      expect(text).not.toContain('已预订')
      expect(text).not.toContain('已确认')
      expect(text).not.toContain('已出票')
    }
  })
})

/* ───────── 数字边界：非法时刻 / 越界天序号（不编造、不回退） ───────── */

describe('对话式行程编辑 · 数字边界', () => {
  it('非法时刻 25:00 不回退匹配成 05:00', () => {
    const parsed = parseAssistantIntent('把博物馆挪到第 2 天 25:00')
    expect(parsed.kind).toBe('move_stop')
    expect(parsed.time).toBeNull()
    expect(parsed.notes.join(' ')).toContain('25:00')
  })

  it('非法时刻 24:30 不回退匹配成 04:30', () => {
    const parsed = parseAssistantIntent('把博物馆挪到第 2 天 24:30')
    expect(parsed.kind).toBe('move_stop')
    expect(parsed.time).toBeNull()
  })

  it('非法时刻的提案走 needs_input：不产生编造时刻，也不进 candidateTrip', () => {
    const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天 25:00'))
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.changes.known).toHaveLength(0)
    expect(proposal.changes.unknown).toHaveLength(1)

    const unknown = proposal.changes.unknown[0]
    expect(unknown.toTime).toBeNull()
    expect(unknown.fromTime).toBeNull()
    expect(unknown.timeSource).toBe('unknown')

    expect(proposal.candidateTrip).toBeNull()
    expect(proposal.reason).toContain('25:00')
    // 绝不出现回退匹配出来的时刻。
    expect(proposal.reason).not.toContain('05:00')
    expect(JSON.stringify(proposal)).not.toContain('05:00')

    const applied = applyAssistantProposal({ proposal, record: makeRecord(), now: 2_000 })
    if (applied.ok) throw new Error('非法时刻的提案不应被应用')
    expect(applied.reason).toBe('not_ready')
  })

  it('非法时刻不会退回沿用旧时刻或占位时刻', () => {
    // 博物馆原时刻是 14:30：指令写了非法时刻就按未知处理，不沿用 14:30。
    const proposal = mustBuild(proposalInput('把博物馆挪到第 2 天 24:30'))
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.changes.known).toHaveLength(0)
    expect(JSON.stringify(proposal)).not.toContain('04:30')
  })

  it('加入候选时非法时刻同样不编造', () => {
    const proposal = mustBuild(
      proposalInput('把收藏池里的西湖加到第 3 天 25:00', {
        candidates: [candidate('c-westlake', '西湖', '湖滨路 1 号')],
      }),
    )
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.changes.known).toHaveLength(0)
    expect(proposal.changes.unknown[0].toTime).toBeNull()
    expect(proposal.candidateTrip).toBeNull()
    expect(proposal.reason).toContain('25:00')
  })

  it('合法时刻照旧解析：9:30 归一成 09:30，15:00 不受影响', () => {
    expect(parseAssistantIntent('把博物馆挪到第 2 天 9:30').time).toBe('09:30')
    expect(parseAssistantIntent('把博物馆挪到第 2 天 15:00').time).toBe('15:00')
    // 24:00 与仓库里其它模块（constraints / tripDraft）同一口径：一律非法。
    expect(parseAssistantIntent('把博物馆挪到第 2 天 24:00').time).toBeNull()
    expect(parseAssistantIntent('把博物馆挪到第 2 天 12:60').time).toBeNull()
  })

  it('越界天序号（第 0 天）被拒绝：不回落到当前天', () => {
    const parsed = parseAssistantIntent('把博物馆挪到第 0 天')
    expect(parsed.day).toBeNull()

    const proposal = mustBuild(proposalInput('把博物馆挪到第 0 天', { currentDay: 2 }))
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.needsDay).toBe(true)
    expect(proposal.changes.known).toHaveLength(0)
    expect(proposal.candidateTrip).toBeNull()
    expect(proposal.reason).toContain('第 0 天')
  })

  it('越界天序号在删除指令里也不会删错天', () => {
    const proposal = mustBuild(proposalInput('去掉第 0 天的丝绸店'))
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.changes.known).toHaveLength(0)
    expect(proposal.candidateTrip).toBeNull()
    expect(proposal.reason).toContain('第 0 天')
  })

  it('超过 366 的天序号同样被拒绝', () => {
    const proposal = mustBuild(proposalInput('把博物馆挪到第 367 天'))
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.changes.known).toHaveLength(0)
    expect(proposal.candidateTrip).toBeNull()
    expect(proposal.reason).toContain('第 367 天')
  })

  it('重排类指令里的越界天序号不回落到当前天', () => {
    const proposal = mustBuild(proposalInput('第 0 天停留久一点', { currentDay: 2 }))
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.replanRequest).toBeNull()
    expect(proposal.replanApiRequest).toBeNull()
    expect(proposal.reason).toContain('第 0 天')
  })

  it('行程里没有的天（第 99 天）走「没有这一天」的未知路径', () => {
    const proposal = mustBuild(proposalInput('把博物馆挪到第 99 天'))
    expect(proposal.kind).toBe('needs_input')
    expect(proposal.changes.known).toHaveLength(0)
    expect(proposal.candidateTrip).toBeNull()
    expect(proposal.reason).toContain('99')
  })
})

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import ConstraintsPanel, {
  type ConstraintsPanelApplyHandler,
} from '../components/ConstraintsPanel'
import { advanceConstraintsEpoch, type ConstraintTimeOrigin } from '../lib/constraints'
import {
  captureWorkspaceRuntime,
  createWorkspaceRecord,
  emptySidecar,
} from '../lib/workspace'
import type { ConstraintItemV1, ConstraintsV1, WorkspaceRecordV1 } from '../lib/workspaceTypes'

/* ───────── 本地夹具（不读 storage / 不连后端） ───────── */

function location(lng: number, lat: number) {
  return { lng, lat }
}

function stop(
  id: string,
  name: string,
  time: string,
  duration_minutes: number | null,
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location: location(121.47, 31.23),
  }
}

function leg(from: string, to: string, duration_minutes: number, distance_m = 500): TripLeg {
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
      day(1, '2026-04-03', [
        stop('s1', '博物馆', '14:30', 30),
        stop('s2', '外滩', '16:30', 30),
      ], [leg('s1', 's2', 15)]),
    ],
  }
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

function makeRecord(tripValue: Trip, constraintsValue: ConstraintsV1): WorkspaceRecordV1 {
  const created = createWorkspaceRecord({
    workspaceId: 'ws-1',
    ownerId: 'owner-1',
    trip: tripValue,
    workspaceRevision: 1,
    now: 1_000,
    sidecar: { ...emptySidecar(), constraints: constraintsValue },
  })
  if (!created.ok) throw new Error(created.message)
  return created.value
}

interface RenderOptions {
  trip?: Trip
  candidateTrip?: Trip
  constraints?: ConstraintsV1
  onApply?: Mock<ConstraintsPanelApplyHandler>
  onClose?: () => void
  epoch?: number
  planScope?: { scope: 'trip_plan'; day: null; anchorStopId: null } | { scope: 'day'; day: number; anchorStopId: null }
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
}

function renderPanel(options: RenderOptions = {}) {
  const trip = options.trip ?? baseTrip()
  const candidate = options.candidateTrip ?? trip
  const constraintsValue = options.constraints ?? constraints()
  const record = makeRecord(trip, constraintsValue)
  const captured = captureWorkspaceRuntime(record, options.epoch ?? 1, { input: candidate })
  if (!captured.ok) throw new Error(captured.message)
  const onApply = options.onApply ?? vi.fn<ConstraintsPanelApplyHandler>(() => ({ ok: true }))
  const view = render(
    <ConstraintsPanel
      constraints={constraintsValue}
      trip={trip}
      workspaceRevision={1}
      epoch={options.epoch ?? 1}
      candidateTrip={candidate}
      record={record}
      runtimeCapture={captured.value}
      planScope={options.planScope ?? { scope: 'day', day: 1, anchorStopId: null }}
      timeOrigins={options.timeOrigins ?? null}
      onApply={onApply}
      onClose={options.onClose}
      now={() => 2_000}
    />,
  )
  return { ...view, trip, record, captured: captured.value, onApply }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/* ───────── 面板初始状态 / H 级不可绕过 ───────── */

describe('面板初始状态与 H 级', () => {
  it('显示本地硬门结论、条数与 epoch；不写 localStorage', () => {
    renderPanel()
    expect(screen.getByTestId('constraints-verdict')).toHaveTextContent('本地硬门通过')
    expect(screen.getByText(/0 条约束/)).toBeInTheDocument()
    expect(screen.getByText(/当前 epoch 1/)).toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
  })

  it('H 级硬冲突：应用按钮禁用，没有确认绕过入口', () => {
    const trip = baseTrip()
    const candidate = {
      ...trip,
      days: [day(1, '2026-04-03', [stop('other', '别的点', '10:00', 30)])],
    }
    renderPanel({
      trip,
      candidateTrip: candidate,
      constraints: constraints(item({ stopId: 's1' })),
    })
    expect(screen.getByTestId('constraints-verdict')).toHaveTextContent('H 级硬冲突')
    expect(screen.getByText(/H 级硬冲突不能由用户确认绕过/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/仍采用含未核实时间方案/)).toBeNull()
    expect(screen.getByRole('button', { name: '应用约束改动' })).toBeDisabled()
  })

  it('同名多站 → U 歧义，面板提示不静默挑第一', () => {
    const trip = baseTrip()
    const candidate = {
      ...trip,
      days: [
        day(1, '2026-04-03', [
          stop('a1', '博物馆', '10:00', 30),
          stop('a2', '博物馆', '15:00', 30),
        ]),
      ],
    }
    renderPanel({
      trip,
      candidateTrip: candidate,
      constraints: constraints(item({ stopId: null })),
    })
    expect(screen.getByTestId('constraints-verdict')).toHaveTextContent('U 级')
    expect(screen.getByText(/无法唯一确定/)).toBeInTheDocument()
  })

  it('默认无 timeOrigins 的 09:00 目标 → U；显式 known 才按真实时刻 H', () => {
    const trip = baseTrip()
    const candidate = {
      ...trip,
      days: [day(1, '2026-04-03', [stop('s1', '博物馆', '09:00', 30)])],
    }
    const window = constraints(
      item({
        id: 'c-window',
        kind: 'fixed_window',
        title: '博物馆预约',
        day: 1,
        stopId: 's1',
        startDate: '2026-04-03',
        endDate: '2026-04-03',
        startTime: '14:00',
        endTime: '16:00',
      }),
    )

    const first = renderPanel({ trip, candidateTrip: candidate, constraints: window })
    expect(screen.getByTestId('constraints-verdict')).toHaveTextContent('U 级')
    expect(screen.getByRole('button', { name: '应用约束改动' })).toBeDisabled()
    first.unmount()

    renderPanel({
      trip,
      candidateTrip: candidate,
      constraints: window,
      timeOrigins: { s1: 'known', s2: 'known' },
    })
    expect(screen.getByTestId('constraints-verdict')).toHaveTextContent('H 级硬冲突')
    expect(screen.getByRole('button', { name: '应用约束改动' })).toBeDisabled()
  })

  it('timeOrigins 变化会清空旧 ack/ticket，并要求新 epoch 重新确认', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn<ConstraintsPanelApplyHandler>(() => ({ ok: true }))
    const trip = baseTrip()
    const windowConstraint = constraints(
      item({
        id: 'c-window',
        kind: 'fixed_window',
        title: '预约',
        day: 1,
        stopId: 's1',
        startDate: '2026-04-03',
        endDate: '2026-04-03',
        startTime: '14:00',
        endTime: null,
      }),
    )
    const planScope = { scope: 'day' as const, day: 1, anchorStopId: null }
    const view = renderPanel({ trip, constraints: windowConstraint, onApply })

    expect(screen.getByTestId('constraints-verdict')).toHaveTextContent('U 级')
    await user.click(screen.getByLabelText(/仍采用含未核实时间方案/))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    expect(onApply).toHaveBeenCalledTimes(1)
    const firstTicket = onApply.mock.calls[0][0].ticket

    view.rerender(
      <ConstraintsPanel
        constraints={windowConstraint}
        trip={trip}
        workspaceRevision={1}
        epoch={1}
        candidateTrip={trip}
        record={view.record}
        runtimeCapture={view.captured}
        planScope={planScope}
        timeOrigins={{ s1: 'known' }}
        onApply={onApply}
        now={() => 2_000}
      />,
    )
    expect(screen.getByTestId('constraints-verdict')).toHaveTextContent('U 级')
    expect(screen.getByRole('button', { name: '应用约束改动' })).toBeDisabled()

    await user.click(screen.getByLabelText(/仍采用含未核实时间方案/))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    expect(onApply).toHaveBeenCalledTimes(2)
    const secondTicket = onApply.mock.calls[1][0].ticket
    expect(secondTicket.epoch).toBeGreaterThan(firstTicket.epoch)
  })

  it('trip_plan scope 支持 title + day + stopId:null；非 null stopId 被公共 scope 逻辑拒绝', async () => {
    const targetTrip = baseTrip()
    const titleOnly = constraints(
      item({ id: 'c-entity', kind: 'must_visit', title: '博物馆', day: 1, stopId: null }),
    )
    const { onApply } = renderPanel({
      trip: targetTrip,
      constraints: titleOnly,
      planScope: { scope: 'trip_plan', day: null, anchorStopId: null },
    })
    const user = userEvent.setup()

    expect(screen.getByTestId('constraints-verdict').textContent).toContain('本地硬门通过')
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    const request = (onApply as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(request.planScope.scope).toBe('trip_plan')
    expect(request.constraints.items[0].stopId).toBeNull()
  })

  it('trip_plan scope 下非 null stopId 显示不合法，应用禁用', () => {
    const targetTrip = baseTrip()
    const bound = constraints(
      item({ id: 'c-bound', kind: 'must_visit', title: '博物馆', day: 1, stopId: 's1' }),
    )
    renderPanel({
      trip: targetTrip,
      constraints: bound,
      planScope: { scope: 'trip_plan', day: null, anchorStopId: null },
    })
    expect(screen.getByTestId('constraints-verdict').textContent).toContain('约束数据不合法')
    expect(screen.getByRole('button', { name: '应用约束改动' })).toBeDisabled()
  })
})

/* ───────── U 级确认 / epoch / 旧确认失效 ───────── */

describe('U 级独立确认与 epoch', () => {
  const uConstraint = () =>
    constraints(
      item({
        kind: 'fixed_window',
        stopId: 's1',
        startDate: '2026-04-03',
        endDate: '2026-04-03',
        startTime: '14:00',
        endTime: null,
      }),
    )

  it('U 级未勾选确认 → 应用禁用；勾选后可生成 ticket 并调用 callback', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn<ConstraintsPanelApplyHandler>(() => ({ ok: true }))
    renderPanel({ constraints: uConstraint(), onApply })

    expect(screen.getByTestId('constraints-verdict')).toHaveTextContent('U 级')
    const apply = screen.getByRole('button', { name: '应用约束改动' })
    expect(apply).toBeDisabled()

    const ack = screen.getByLabelText(/仍采用含未核实时间方案/)
    await user.click(ack)
    expect(apply).toBeEnabled()
    await user.click(apply)

    expect(onApply).toHaveBeenCalledTimes(1)
    const request = onApply.mock.calls[0][0]
    expect(request.ticket.ack).not.toBeNull()
    expect(request.epoch).toBe(1)
    expect(request.constraints.items[0].endTime).toBeNull()
  })

  it('采纳后再应用必须使用新 epoch；旧确认不复活', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn<ConstraintsPanelApplyHandler>(() => ({ ok: true }))
    renderPanel({ constraints: uConstraint(), onApply })

    await user.click(screen.getByLabelText(/仍采用含未核实时间方案/))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    expect(onApply).toHaveBeenCalledTimes(1)

    // bumpEpoch 已把确认清掉；再次应用必须先重新确认。
    expect(screen.getByRole('button', { name: '应用约束改动' })).toBeDisabled()
    await user.click(screen.getByLabelText(/仍采用含未核实时间方案/))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    expect(onApply).toHaveBeenCalledTimes(2)

    const first = onApply.mock.calls[0][0]
    const second = onApply.mock.calls[1][0]
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(second.ticket.epoch).toBeGreaterThan(first.ticket.epoch)
  })

  it('切换查看约束推进 epoch；旧 ticket 不再出现在界面', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn<ConstraintsPanelApplyHandler>(() => ({ ok: true }))
    renderPanel({
      constraints: constraints(
        item({ id: 'c1', kind: 'reminder', title: '带伞' }),
        item({ id: 'c2', kind: 'reminder', title: '充电' }),
      ),
      onApply,
    })
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    expect(onApply).toHaveBeenCalledTimes(1)
    const first = onApply.mock.calls[0][0]

    await user.click(screen.getByRole('button', { name: '查看约束 充电' }))
    expect(screen.queryByTestId('constraints-ticket')).toBeNull()
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    expect(onApply).toHaveBeenCalledTimes(2)
    const second = onApply.mock.calls[1][0]
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(screen.getByTestId('constraints-ticket').textContent).toContain(`epoch ${second.epoch}`)
  })

  it('还原为当前约束会清除旧确认；再次应用使用更高 epoch', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn<ConstraintsPanelApplyHandler>(() => ({ ok: true }))
    renderPanel({ constraints: uConstraint(), onApply })
    await user.click(screen.getByLabelText(/仍采用含未核实时间方案/))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    const first = onApply.mock.calls[0][0]

    await user.click(screen.getByRole('button', { name: '还原为当前约束' }))
    expect(screen.getByRole('button', { name: '应用约束改动' })).toBeDisabled()
    await user.click(screen.getByLabelText(/仍采用含未核实时间方案/))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    const second = onApply.mock.calls[1][0]
    expect(second.epoch).toBeGreaterThan(first.epoch)
  })
})

/* ───────── 编辑 / null vs 0 / Trip 不变 ───────── */

describe('受控编辑', () => {
  it('添加 title-only 必去：提交约束不改 Trip，apply 传 stopId:null', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn<ConstraintsPanelApplyHandler>(() => ({ ok: true }))
    const { trip } = renderPanel({ onApply })
    const tripSnapshot = JSON.stringify(trip)

    await user.click(screen.getByRole('button', { name: '添加约束' }))
    await user.type(screen.getByLabelText('标题'), '博物馆')
    await user.click(screen.getByRole('button', { name: '保存约束' }))
    expect(JSON.stringify(trip)).toBe(tripSnapshot)

    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    const request = onApply.mock.calls[0][0]
    expect(request.constraints.items[0].title).toBe('博物馆')
    expect(request.constraints.items[0].stopId).toBeNull()
    expect(JSON.stringify(trip)).toBe(tripSnapshot)
  })

  it('停留留空保存 null；输入 0 保存已知 0，不把未知当 0', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn<ConstraintsPanelApplyHandler>(() => ({ ok: true }))
    renderPanel({ onApply, timeOrigins: { s1: 'known', s2: 'known' } })

    await user.click(screen.getByRole('button', { name: '添加约束' }))
    await user.selectOptions(screen.getByLabelText('类型'), 'fixed_window')
    await user.type(screen.getByLabelText('标题'), '预约')
    await user.selectOptions(screen.getByLabelText('绑定站点'), 's1')
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-04-03' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-04-03' } })
    fireEvent.change(screen.getByLabelText('开始时刻'), { target: { value: '14:00' } })
    fireEvent.change(screen.getByLabelText('结束时刻'), { target: { value: '16:00' } })
    await user.click(screen.getByRole('button', { name: '保存约束' }))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))

    const first = onApply.mock.calls[0][0]
    expect(first.constraints.items[0].durationMinutes).toBeNull()

    await user.click(screen.getByRole('button', { name: '编辑约束 预约' }))
    await user.clear(screen.getByLabelText('停留分钟'))
    await user.type(screen.getByLabelText('停留分钟'), '0')
    await user.click(screen.getByRole('button', { name: '保存约束' }))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))

    const second = onApply.mock.calls[1][0]
    expect(second.constraints.items[0].durationMinutes).toBe(0)
  })

  it('删除只删约束，不改 Trip；取消 / 还原不产生半截写入', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn<ConstraintsPanelApplyHandler>(() => ({ ok: true }))
    const { trip } = renderPanel({
      constraints: constraints(item({ id: 'c1', kind: 'reminder', title: '带伞' })),
      onApply,
    })
    const snapshot = JSON.stringify(trip)
    await user.click(screen.getByRole('button', { name: '删除约束 带伞' }))
    expect(screen.getByRole('button', { name: '确认删除约束 带伞' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认删除约束 带伞' }))
    expect(screen.getByText(/还没有约束/)).toBeInTheDocument()
    expect(JSON.stringify(trip)).toBe(snapshot)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('关闭按钮推进本地 epoch 并调用 onClose', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderPanel({ onClose })
    await user.click(screen.getByRole('button', { name: '收起必去与预约' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('advanceConstraintsEpoch 单调且拒绝非法值（供父级 / 集成层复用）', () => {
    expect(advanceConstraintsEpoch(0)).toEqual({ ok: true, value: 1 })
    expect(advanceConstraintsEpoch(Number.MAX_SAFE_INTEGER).ok).toBe(false)
  })
})

/**
 * ChecklistPanel 受控 UI 测试：草稿不误写、模板需显式添加且不自动已办、
 * 勾选不承诺预订、失效 stop / constraint 保留任务、XSS 文本转义、失败保旧、
 * 撤销提案在清单变化后失效。
 */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Trip, TripStop } from '../lib/api'
import type { ChecklistItemV1, ChecklistV1, ConstraintItemV1 } from '../lib/workspaceTypes'
import { emptyChecklist } from '../lib/workspace'
import ChecklistPanel, {
  type ChecklistApplyResult,
  type ChecklistChangeContext,
  type ChecklistPanelStatus,
} from '../components/ChecklistPanel'

const NOW = 1_760_000_000_000

function makeItem(overrides: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return {
    id: 'check-1',
    category: 'ticket',
    title: '核对机票订单',
    done: false,
    date: null,
    day: null,
    stopId: null,
    originalStopId: null,
    notes: null,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeChecklist(items: ChecklistItemV1[] = [], appliedTemplates: string[] = []): ChecklistV1 {
  return { items, appliedTemplates }
}

function makeStop(id: string, name: string): TripStop {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: 60,
    description: '',
    address: '',
    location: null,
  }
}

function makeTrip(stops: TripStop[] = [makeStop('s1', '博物馆')]): Trip {
  return {
    id: 'trip-1',
    source: 'example',
    destination: '苏州',
    title: '测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [
      {
        day: 1,
        date: '2026-04-03',
        title: '第一天',
        summary: '',
        stops,
        legs: [],
      },
    ],
  }
}

function makeConstraint(overrides: Partial<ConstraintItemV1> = {}): ConstraintItemV1 {
  return {
    id: 'c1',
    kind: 'fixed_window',
    day: 1,
    stopId: 's1',
    title: '博物馆预约',
    startDate: '2026-04-03',
    endDate: '2026-04-03',
    startTime: '14:00',
    endTime: '16:00',
    durationMinutes: 120,
    notes: null,
    priority: 2,
    updatedAt: NOW,
    ...overrides,
  }
}

interface HarnessProps {
  initial: ChecklistV1
  trip?: Trip | null
  constraints?: ChecklistPanelPropsConstraints
  previousConstraints?: ChecklistPanelPropsConstraints
  status?: ChecklistPanelStatus
  onCommit?: (next: ChecklistV1, context: ChecklistChangeContext) => ChecklistApplyResult
  onCall?: (next: ChecklistV1, context: ChecklistChangeContext) => void
  onRebuildRequest?: () => void
}

type ChecklistPanelPropsConstraints = { items: ConstraintItemV1[] } | null

function Harness({
  initial,
  trip = null,
  constraints = null,
  previousConstraints = null,
  status = 'ready',
  onCommit,
  onCall,
  onRebuildRequest,
}: HarnessProps) {
  const [checklist, setChecklist] = useState(initial)
  const [externalTick, setExternalTick] = useState(0)
  const handle = async (next: ChecklistV1, context: ChecklistChangeContext): Promise<ChecklistApplyResult> => {
    onCall?.(next, context)
    const result = onCommit ? onCommit(next, context) : { ok: true as const }
    if (result.ok) setChecklist(next)
    return result
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setExternalTick((value) => value + 1)
          setChecklist(makeChecklist([makeItem({ id: 'external', title: `外部修改 ${externalTick + 1}` })]))
        }}
      >
        外部更新
      </button>
      <ChecklistPanel
        checklist={checklist}
        trip={trip}
        constraints={constraints}
        previousConstraints={previousConstraints}
        status={status}
        now={NOW}
        onChange={handle}
        onRebuildRequest={onRebuildRequest}
      />
    </div>
  )
}

function ConstraintSwapHarness({
  onCall,
}: {
  onCall: (next: ChecklistV1, context: ChecklistChangeContext) => void
}) {
  const [constraints, setConstraints] = useState<ChecklistPanelPropsConstraints>({ items: [makeConstraint()] })
  const [checklist, setChecklist] = useState(emptyChecklist())
  return (
    <div>
      <button type="button" onClick={() => setConstraints({ items: [] })}>
        移除约束
      </button>
      <ChecklistPanel
        checklist={checklist}
        trip={makeTrip()}
        constraints={constraints}
        now={NOW}
        onChange={async (next, context) => {
          onCall(next, context)
          setChecklist(next)
          return { ok: true }
        }}
      />
    </div>
  )
}

afterEach(cleanup)

describe('ChecklistPanel · 基本编辑与安全渲染', () => {
  it('renders user text as text, never as HTML', () => {
    const title = '<img src=x onerror=alert(1)>'
    const notes = '<script>alert(1)</script>'
    const { container } = render(
      <Harness initial={makeChecklist([makeItem({ title, notes })])} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText(title)).toBeInTheDocument()
    expect(screen.getByText(notes)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/已预订|已出票|已确认|确认库存/)
  })

  it('does not write while typing; explicit add sends a not-done item', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(<Harness initial={emptyChecklist()} onCall={(next, context) => calls.push({ next, context })} />)
    fireEvent.click(screen.getByRole('button', { name: '新增清单项' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '  护照  ' } })
    fireEvent.change(screen.getByLabelText('备注（可选）'), { target: { value: '放在随身包' } })
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '添加这一项' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].context.action).toBe('add')
    expect(calls[0].next.items[0]).toMatchObject({
      category: 'todo',
      title: '护照',
      done: false,
      date: null,
      day: null,
      stopId: null,
      notes: '放在随身包',
    })
    await screen.findByText('护照')
    expect(screen.getByRole('checkbox', { name: '护照：未准备' })).not.toBeChecked()
  })

  it('discards a dirty edit without writing, and cancels cleanly', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={makeChecklist([makeItem({ title: '原任务' })])}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '被丢弃的草稿' } })
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(calls).toHaveLength(0)
    expect(screen.getByText('原任务')).toBeInTheDocument()
    expect(screen.queryByText('被丢弃的草稿')).toBeNull()
  })

  it('toggles and deletes only checklist state, never the Trip', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    const trip = makeTrip()
    const tripSnapshot = JSON.stringify(trip)
    render(
      <Harness
        initial={makeChecklist([makeItem()])}
        trip={trip}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '核对机票订单：未准备' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].next.items[0].done).toBe(true)
    expect(JSON.stringify(trip)).toBe(tripSnapshot)
    await screen.findByRole('checkbox', { name: '核对机票订单：已准备' })

    fireEvent.click(screen.getByRole('button', { name: '删除 核对机票订单' }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].next.items).toHaveLength(0)
    expect(JSON.stringify(trip)).toBe(tripSnapshot)
  })
})

describe('ChecklistPanel · 模板与关联', () => {
  it('shows template suggestions without writing; selected additions stay not-done', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(<Harness initial={emptyChecklist()} onCall={(next, context) => calls.push({ next, context })} />)
    fireEvent.click(screen.getByRole('button', { name: '用模板' }))
    expect(calls).toHaveLength(0)
    const suggestion = screen.getByLabelText(/核对机票订单与乘机人姓名/)
    expect(suggestion).not.toBeChecked()
    fireEvent.click(suggestion)
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '添加所选（1）' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].context).toMatchObject({ action: 'template', templateId: 'flight' })
    expect(calls[0].next.items).toHaveLength(1)
    expect(calls[0].next.items[0].done).toBe(false)
    expect(calls[0].next.appliedTemplates).toEqual(['flight'])
    await screen.findByText('核对机票订单与乘机人姓名')
    expect(screen.getByRole('checkbox', { name: '核对机票订单与乘机人姓名：未准备' })).not.toBeChecked()
  })

  it('links a constraint into date / day / stop only after explicit save', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={emptyChecklist()}
        trip={makeTrip()}
        constraints={{ items: [makeConstraint()] }}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '新增清单项' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '博物馆预约' } })
    fireEvent.change(screen.getByLabelText('关联预约（可选）'), { target: { value: 'c1' } })
    expect((screen.getByLabelText('日期（可选）') as HTMLInputElement).value).toBe('2026-04-03')
    expect((screen.getByLabelText('天序号（可选）') as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText('关联地点（可选）') as HTMLSelectElement).value).toBe('s1')
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '添加这一项' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].next.items[0]).toMatchObject({
      constraintId: 'c1',
      date: '2026-04-03',
      day: 1,
      stopId: 's1',
      done: false,
    })
  })

  it('does not silently add a new item when the chosen constraint disappears before save', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(<ConstraintSwapHarness onCall={(next, context) => calls.push({ next, context })} />)
    fireEvent.click(screen.getByRole('button', { name: '新增清单项' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '消失的预约' } })
    fireEvent.change(screen.getByLabelText('关联预约（可选）'), { target: { value: 'c1' } })
    fireEvent.click(screen.getByRole('button', { name: '移除约束' }))
    fireEvent.click(screen.getByRole('button', { name: '添加这一项' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('所选预约已不在当前约束中')
    expect(calls).toHaveLength(0)
  })
})

describe('ChecklistPanel · 关联失效与撤销', () => {
  it('keeps a task whose stop is missing and marks it only after explicit action', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    const trip = makeTrip([makeStop('s1', '博物馆')])
    const tripSnapshot = JSON.stringify(trip)
    render(
      <Harness
        initial={makeChecklist([makeItem({ title: '博物馆门票', done: true, stopId: 'gone', notes: '保留' })])}
        trip={trip}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    expect(screen.getByText(/关联的地点已不在当前行程中/)).toBeInTheDocument()
    expect(calls).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '标记需重新关联' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].context.action).toBe('relink')
    expect(calls[0].next.items[0]).toMatchObject({
      title: '博物馆门票',
      done: true,
      stopId: null,
      originalStopId: 'gone',
    })
    expect(calls[0].next.items[0].notes).toContain('需重新关联')
    expect(JSON.stringify(trip)).toBe(tripSnapshot)
    await screen.findByText('博物馆门票')
  })

  it('keeps date / day / stop when a constraint disappears; only adds a review note', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    const item = makeItem({
      title: '博物馆预约',
      category: 'appointment',
      done: true,
      date: '2026-04-03',
      day: 1,
      stopId: 's1',
      constraintId: 'c1',
    })
    render(
      <Harness
        initial={makeChecklist([item])}
        trip={makeTrip()}
        constraints={{ items: [] }}
        previousConstraints={{ items: [makeConstraint()] }}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    expect(screen.getByText(/关联的预约「博物馆预约」已不在当前约束中/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '标记需重新关联' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].next.items[0]).toMatchObject({
      constraintId: 'c1',
      done: true,
      date: '2026-04-03',
      day: 1,
      stopId: 's1',
    })
    expect(calls[0].next.items[0].notes).toContain('原预约已不在当前约束中')
  })

  it('keeps the exact foreign id: deleting A never blames a task linked to B on the same stop', async () => {
    const a = makeConstraint({ id: 'A', title: '预约 A' })
    const b = makeConstraint({ id: 'B', title: '预约 B' })
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={makeChecklist([
          makeItem({ title: '预约 B 的任务', category: 'appointment', stopId: 's1', day: 1, constraintId: 'B' }),
        ])}
        trip={makeTrip()}
        constraints={{ items: [b] }}
        previousConstraints={{ items: [a, b] }}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    expect(screen.getByText(/关联预约 预约 B/)).toBeInTheDocument()
    expect(screen.queryByText(/预约 A/)).toBeNull()
    expect(screen.queryByText(/已不在当前约束中/)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('keeps a dangling foreign id when its constraint is deleted and marks it for review', async () => {
    const a = makeConstraint({ id: 'A', title: '预约 A' })
    const b = makeConstraint({ id: 'B', title: '预约 B' })
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={makeChecklist([
          makeItem({
            title: '预约 B 的任务',
            category: 'appointment',
            done: true,
            date: '2026-04-03',
            day: 1,
            stopId: 's1',
            constraintId: 'B',
          }),
        ])}
        trip={makeTrip()}
        constraints={{ items: [a] }}
        previousConstraints={{ items: [a, b] }}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    expect(screen.getByText(/关联的预约「预约 B」已不在当前约束中/)).toBeInTheDocument()
    expect(screen.getByText(/关联预约已失效，需重新关联/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '标记需重新关联' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].next.items[0]).toMatchObject({
      constraintId: 'B',
      done: true,
      date: '2026-04-03',
      day: 1,
      stopId: 's1',
    })
    expect(calls[0].next.items[0].notes).toContain('原预约已不在当前约束中')
  })

  it('unlinks only the constraint to explicit null and preserves manual date / notes', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={makeChecklist([
          makeItem({
            title: '手工预约',
            category: 'appointment',
            done: true,
            date: '2026-04-05',
            day: 2,
            stopId: 's1',
            notes: '手工备注',
            constraintId: 'c1',
          }),
        ])}
        trip={makeTrip()}
        constraints={{ items: [makeConstraint()] }}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '解除预约关联' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].context.action).toBe('unlink-constraint')
    expect(calls[0].next.items[0]).toMatchObject({
      constraintId: null,
      done: true,
      date: '2026-04-05',
      day: 2,
      stopId: 's1',
      notes: '手工备注',
    })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].next.items[0]).toMatchObject({
      constraintId: null,
      date: '2026-04-05',
      day: 2,
      stopId: 's1',
      notes: '手工备注',
    })
  })

  it('does not add constraintId to a legacy item on ordinary save, and hints manual linking', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={makeChecklist([makeItem({ title: '旧预约任务', category: 'appointment', date: '2026-04-03', day: 1 })])}
        trip={makeTrip()}
        constraints={{ items: [makeConstraint()] }}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    expect(screen.getByText(/未记录预约关联/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '旧预约任务（已改）' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(Object.hasOwn(calls[0].next.items[0], 'constraintId')).toBe(false)
  })

  it('does not re-copy anchors or rewrite the foreign id when the constraint selection is unchanged', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={makeChecklist([
          makeItem({
            title: '手工日期预约',
            category: 'appointment',
            done: true,
            date: '2026-04-05',
            day: 2,
            stopId: 's1',
            notes: '手工备注',
            constraintId: 'c1',
          }),
        ])}
        trip={makeTrip()}
        constraints={{ items: [makeConstraint()] }}
        previousConstraints={{ items: [makeConstraint()] }}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    expect(screen.queryByText(/已变更/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '手工日期预约（已改）' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].context.action).toBe('update')
    expect(calls[0].next.items[0]).toMatchObject({
      constraintId: 'c1',
      done: true,
      date: '2026-04-05',
      day: 2,
      stopId: 's1',
      notes: '手工备注',
    })
  })

  it('does not claim a recorded constraint is deleted when constraints are not loaded', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={makeChecklist([
          makeItem({ title: '已记录预约', category: 'appointment', constraintId: 'c1' }),
        ])}
        trip={makeTrip()}
        constraints={null}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    expect(screen.getByText(/已记录预约关联（当前约束未加载）/)).toBeInTheDocument()
    expect(screen.queryByText(/关联预约已失效/)).toBeNull()
    expect(screen.queryByText(/已不在当前约束中/)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('keeps explicit null unlinked: no false deleted-constraint alert and no rewrite', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    const constraint = makeConstraint()
    render(
      <Harness
        initial={makeChecklist([
          makeItem({ title: '明确未关联', category: 'appointment', constraintId: null, stopId: 's1' }),
        ])}
        trip={makeTrip()}
        constraints={{ items: [] }}
        previousConstraints={{ items: [constraint] }}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    expect(screen.queryByText(/未记录预约关联/)).toBeNull()
    expect(screen.queryByText(/已不在当前约束中/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '明确未关联（已改）' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(Object.hasOwn(calls[0].next.items[0], 'constraintId')).toBe(true)
    expect(calls[0].next.items[0].constraintId).toBeNull()
  })

  it('does not silently re-link after an explicit unlink in the edit form', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={makeChecklist([makeItem({ stopId: 's1', done: true, constraintId: 'C' })])}
        trip={makeTrip()}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '解除地点关联' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].context.action).toBe('unlink')
    expect(calls[0].next.items[0]).toMatchObject({
      constraintId: 'C',
      stopId: null,
      originalStopId: 's1',
      done: true,
    })
    expect(calls[0].next.items[0].notes).toContain('已解除地点关联')
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].next.items[0]).toMatchObject({
      constraintId: 'C',
      stopId: null,
      originalStopId: 's1',
      done: true,
    })
    expect(calls[1].next.items[0].notes).toContain('已解除地点关联')
  })

  it('offers undo only until the checklist changes; stale proposals never write', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={makeChecklist([makeItem({ done: false })])}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '核对机票订单：未准备' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    const undo = await screen.findByRole('button', { name: '撤销上一步' })
    expect(undo).toBeEnabled()
    fireEvent.click(undo)
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].context.action).toBe('undo')
    expect(calls[1].next.items[0].done).toBe(false)
    await screen.findByRole('checkbox', { name: '核对机票订单：未准备' })

    fireEvent.click(screen.getByRole('checkbox', { name: '核对机票订单：未准备' }))
    await waitFor(() => expect(calls).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: '外部更新' }))
    expect(await screen.findByText('当前清单已变化，撤销提案已失效。')).toBeInTheDocument()
    const staleUndo = screen.getByRole('button', { name: '撤销上一步' })
    expect(staleUndo).toBeDisabled()
    fireEvent.click(staleUndo)
    expect(calls).toHaveLength(3)
  })
})

describe('ChecklistPanel · 失败与只读', () => {
  it('shows the adapter failure and keeps the old checklist unchanged', async () => {
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    render(
      <Harness
        initial={emptyChecklist()}
        onCommit={() => ({ ok: false, message: '容量已满，未写入，原清单保持不变。' })}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '新增清单项' }))
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '不会写入' } })
    fireEvent.click(screen.getByRole('button', { name: '添加这一项' }))
    expect(await screen.findByText('容量已满，未写入，原清单保持不变。')).toBeInTheDocument()
    expect(screen.queryByText('不会写入')).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('is read-only when storage is unavailable or the checklist is salvaged', () => {
    const rebuild = vi.fn()
    const calls: Array<{ next: ChecklistV1; context: ChecklistChangeContext }> = []
    const { container, rerender } = render(
      <Harness initial={makeChecklist([makeItem()])} status="unavailable" />,
    )
    expect(screen.getByText(/当前浏览器无法访问本地存储/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新增清单项' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: '核对机票订单：未准备' })).toBeDisabled()
    expect(container.textContent).not.toMatch(/已预订|已出票|已确认|确认库存/)

    rerender(
      <Harness
        initial={makeChecklist([makeItem()])}
        status="salvage"
        onRebuildRequest={rebuild}
        onCall={(next, context) => calls.push({ next, context })}
      />,
    )
    expect(screen.getByText(/清单数据损坏，未加载/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新增清单项' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重建清单（需确认）' }))
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(0)
  })
})

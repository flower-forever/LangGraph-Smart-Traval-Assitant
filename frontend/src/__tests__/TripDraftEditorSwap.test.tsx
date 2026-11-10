/**
 * S6 · 换一个：在站点编辑区（TripDraftEditor）里的入口与写入路径。
 *
 * 覆盖：每站有「换一个」入口；点开后展开替换面板；确认后草稿里的站点与
 * 相邻路段真的被改（并保留其它天的内容）。
 */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Trip } from '../lib/api'
import { createTripDraft, updateDraftStop, type TripDraft } from '../lib/tripDraft'
import TripDraftEditor from '../components/TripDraftEditor'
import type { CandidateItemV1 } from '../lib/workspace'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_700_000_000_000

function cloneTrip(): Trip {
  return JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
}

function candidate(overrides: Partial<CandidateItemV1> & { id: string; name: string }): CandidateItemV1 {
  return {
    id: overrides.id,
    name: overrides.name,
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

function Harness({ latestRef }: { latestRef?: { current: TripDraft | null } }) {
  const [draft, setDraft] = useState<TripDraft>(() => {
    const created = createTripDraft(cloneTrip(), {
      forkTripId: 'trip-fork-editor-swap',
      newLegMode: 'walking',
    })
    if (!created.ok) throw new Error(created.message)
    return created.draft
  })
  if (latestRef) latestRef.current = draft
  return (
    <TripDraftEditor
      draft={draft}
      dayNumber={1}
      onDraftChange={setDraft}
      onApply={() => {}}
      onDiscard={() => {}}
      createStopId={() => 'new-stop-1'}
      candidates={[candidate({ id: 'c1', name: '浙江省博物馆' })]}
    />
  )
}

/**
 * 切天场景：模拟 App.tsx 的日签切换（编辑器拿到的 dayNumber 变了，组件不重新挂载）。
 * 先改一个站名，让草稿处于「有改动」状态——这样「应用草稿」按钮的可用性只由锁决定。
 */
function DaySwitchHarness() {
  const [draft, setDraft] = useState<TripDraft>(() => {
    const created = createTripDraft(cloneTrip(), {
      forkTripId: 'trip-fork-editor-swap-day',
      newLegMode: 'walking',
    })
    if (!created.ok) throw new Error(created.message)
    const edited = updateDraftStop(created.draft, 1, 's2', { name: '平湖秋月（改过）' })
    if (!edited.ok) throw new Error(edited.message)
    return edited.draft
  })
  const [dayNumber, setDayNumber] = useState(1)
  return (
    <>
      <button type="button" data-testid="switch-to-day-2" onClick={() => setDayNumber(2)}>
        切到第 2 天
      </button>
      <button type="button" data-testid="switch-to-day-1" onClick={() => setDayNumber(1)}>
        切回第 1 天
      </button>
      <TripDraftEditor
        draft={draft}
        dayNumber={dayNumber}
        onDraftChange={setDraft}
        onApply={() => {}}
        onDiscard={() => {}}
        createStopId={() => 'new-stop-1'}
        candidates={[candidate({ id: 'c1', name: '浙江省博物馆' })]}
      />
    </>
  )
}

describe('TripDraftEditor · 换一个入口', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('每个站点都有「换一个」入口，点开后展开替换面板', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const button = screen.getByTestId('stop-swap-open-s1')
    expect(button).toBeInTheDocument()
    expect(screen.queryByTestId('stop-swap-panel')).toBeNull()

    await user.click(button)
    const panel = screen.getByTestId('stop-swap-panel')
    expect(panel).toBeInTheDocument()
    expect(within(panel).getByText('浙江省博物馆')).toBeInTheDocument()
  })

  it('确认替换后草稿里的站点与相邻路段都被改，其它天不动', async () => {
    const user = userEvent.setup()
    const latestRef: { current: TripDraft | null } = { current: null }
    render(<Harness latestRef={latestRef} />)

    await user.click(screen.getByTestId('stop-swap-open-s1'))
    await user.click(screen.getByRole('button', { name: '预览替换' }))
    await user.click(screen.getByRole('button', { name: '确认替换' }))

    const draft = latestRef.current
    expect(draft).not.toBeNull()
    const day1 = draft?.days.find((day) => day.day === 1)
    expect(day1?.stops[0].name).toBe('浙江省博物馆')
    expect(day1?.stops[0].location).toBeNull()
    expect(day1?.legs[0].route_type).toBe('unavailable')
    expect(day1?.legs[0].distance_m).toBeNull()
    // 其它天原样保留。
    const day3 = draft?.days.find((day) => day.day === 3)
    expect(day3?.stops[0].name).toBe('龙井村')
  })

  it('Esc 关闭后焦点回到「换一个」入口按钮', () => {
    render(<Harness />)
    const entry = screen.getByTestId('stop-swap-open-s1')
    // 模拟 Chrome：入口被 disabled 后焦点已落到 body；fireEvent.click 不预先聚焦入口。
    entry.focus()
    entry.blur()
    fireEvent.click(entry)
    expect(screen.getByTestId('stop-swap-panel')).toBeInTheDocument()
    expect(entry).toBeDisabled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('stop-swap-panel')).toBeNull()
    expect(entry).toBeEnabled()
    expect(document.activeElement).toBe(entry)
  })

  it('面板开着切天：面板自动关闭，编辑器恢复可用（不再锁死）', async () => {
    const user = userEvent.setup()
    render(<DaySwitchHarness />)

    await user.click(screen.getByTestId('stop-swap-open-s1'))
    expect(screen.getByTestId('stop-swap-panel')).toBeInTheDocument()
    // 面板打开时，结构动作被暂停。
    expect(screen.getByRole('button', { name: '新增站点' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '应用草稿' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '放弃草稿' })).toBeDisabled()
    expect(screen.getByText(/「换一个」面板打开中/)).toBeInTheDocument()

    // 切到第 2 天（模拟 App.tsx 的日签切换）。
    await user.click(screen.getByTestId('switch-to-day-2'))

    // 面板自动关闭，锁全部解除：不会留下「面板不见了但按钮还锁着」的死角。
    expect(screen.queryByTestId('stop-swap-panel')).toBeNull()
    expect(screen.queryByText(/「换一个」面板打开中/)).toBeNull()
    expect(screen.getByRole('button', { name: '新增站点' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '应用草稿' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '放弃草稿' })).toBeEnabled()

    // 切回原来那天，面板也不会自己冒出来（是「关闭」，不是「藏起来」）。
    await user.click(screen.getByTestId('switch-to-day-1'))
    expect(screen.queryByTestId('stop-swap-panel')).toBeNull()
    expect(screen.getByRole('button', { name: '新增站点' })).toBeEnabled()
  })
})

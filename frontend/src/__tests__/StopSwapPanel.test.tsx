/**
 * S6 · 换一个：面板交互的定向测试。
 *
 * 覆盖：候选展示（名称 / 直线距离 / 可信状态 / 理由）、暂无候选、
 * 预览 → 确认才写入草稿、取消预览不改动草稿、撤销一次、
 * 以及「零自动保存」（不写 localStorage、不发网络请求）。
 */
import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Trip, TripStop } from '../lib/api'
import { createTripDraft, type TripDraft } from '../lib/tripDraft'
import StopSwapPanel from '../components/StopSwapPanel'
import type { CandidateItemV1 } from '../lib/workspace'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_700_000_000_000

function cloneTrip(): Trip {
  return JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
}

function makeDraft(base: Trip = cloneTrip()): TripDraft {
  const created = createTripDraft(base, { forkTripId: 'trip-fork-panel', newLegMode: 'walking' })
  if (!created.ok) throw new Error(created.message)
  return created.draft
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

/** 被替换的站点：当天第一站，后面有相邻路段。 */
const TARGET: TripStop = {
  id: 's1',
  name: '断桥残雪',
  time: '09:00',
  duration_minutes: 40,
  description: '白堤东端。',
  address: '杭州市西湖区白堤东端',
  location: { lng: 120.1576, lat: 30.2726 },
}

function Harness({
  initialDraft = makeDraft(),
  stop = TARGET,
  candidates = [] as readonly CandidateItemV1[],
  onChangeSpy,
}: {
  initialDraft?: TripDraft
  stop?: TripStop
  candidates?: readonly CandidateItemV1[]
  onChangeSpy?: (next: TripDraft) => void
}) {
  const [draft, setDraft] = useState(initialDraft)
  return (
    <StopSwapPanel
      draft={draft}
      dayNumber={1}
      stop={stop}
      onDraftChange={(next) => {
        setDraft(next)
        onChangeSpy?.(next)
      }}
      candidates={candidates}
      poiCards={null}
      onClose={() => {}}
    />
  )
}

describe('StopSwapPanel', () => {
  beforeEach(() => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('展示候选：名称、直线距离、可信状态与一句话理由', () => {
    render(
      <Harness
        candidates={[
          candidate({
            id: 'c1',
            name: '浙江省博物馆',
            notes: '省博物馆',
            location: { lng: 120.15, lat: 30.28 },
          }),
        ]}
      />,
    )
    const item = screen.getByTestId('stop-swap-candidate')
    expect(within(item).getByText('浙江省博物馆')).toBeInTheDocument()
    expect(item.textContent).toContain('直线距离')
    expect(item.textContent).toContain('可信状态：未知')
    expect(item.textContent).toContain('候选池')
  })

  it('没有候选时明确写「暂无候选」，不编造候选', () => {
    render(<Harness />)
    expect(screen.getByTestId('stop-swap-empty')).toHaveTextContent('暂无候选')
    expect(screen.queryByTestId('stop-swap-candidate')).toBeNull()
  })

  it('先预览再确认：预览显示替换后顺序与受影响路段，确认后才写入草稿', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(
      <Harness
        candidates={[candidate({ id: 'c1', name: '浙江省博物馆' })]}
        onChangeSpy={onChangeSpy}
      />,
    )

    // 点「预览替换」之前没有预览，也不写草稿。
    expect(screen.queryByTestId('stop-swap-preview')).toBeNull()
    expect(onChangeSpy).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '预览替换' }))
    const preview = screen.getByTestId('stop-swap-preview')
    expect(preview.textContent).toContain('浙江省博物馆')
    expect(preview.textContent).toContain('替换后')
    expect(preview.textContent).toContain('路线待重取')
    // 预览阶段还没写草稿。
    expect(onChangeSpy).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '确认替换' }))
    expect(onChangeSpy).toHaveBeenCalledTimes(1)
    const next = onChangeSpy.mock.calls[0][0] as TripDraft
    const stop = next.days[0].stops.find((item) => item.id === 's1')
    expect(stop?.name).toBe('浙江省博物馆')
    expect(stop?.location).toBeNull()
    expect(next.days[0].legs[0].route_type).toBe('unavailable')
    expect(next.days[0].legs[0].geometry).toEqual([])
    expect(next.days[0].legs[0].distance_m).toBeNull()
    expect(next.days[0].legs[0].duration_minutes).toBeNull()
  })

  it('取消预览不改动草稿', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(
      <Harness
        candidates={[candidate({ id: 'c1', name: '浙江省博物馆' })]}
        onChangeSpy={onChangeSpy}
      />,
    )
    await user.click(screen.getByRole('button', { name: '预览替换' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByTestId('stop-swap-preview')).toBeNull()
    expect(onChangeSpy).not.toHaveBeenCalled()
  })

  it('可以撤销一次：撤销后回到替换前的站点', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(
      <Harness
        candidates={[candidate({ id: 'c1', name: '浙江省博物馆' })]}
        onChangeSpy={onChangeSpy}
      />,
    )
    await user.click(screen.getByRole('button', { name: '预览替换' }))
    await user.click(screen.getByRole('button', { name: '确认替换' }))
    expect(onChangeSpy).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '撤销这次更换' }))
    expect(onChangeSpy).toHaveBeenCalledTimes(2)
    const restored = onChangeSpy.mock.calls[1][0] as TripDraft
    const stop = restored.days[0].stops.find((item) => item.id === 's1')
    expect(stop?.name).toBe('断桥残雪')
    expect(restored.days[0].legs[0].route_type).toBe('navigation')
  })

  it('零自动保存：不写 localStorage、不发网络请求', async () => {
    const user = userEvent.setup()
    render(<Harness candidates={[candidate({ id: 'c1', name: '浙江省博物馆' })]} />)
    await user.click(screen.getByRole('button', { name: '预览替换' }))
    await user.click(screen.getByRole('button', { name: '确认替换' }))
    expect(Storage.prototype.setItem).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

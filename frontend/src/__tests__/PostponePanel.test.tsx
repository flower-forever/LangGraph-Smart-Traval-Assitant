/**
 * S8 · 建议顺延面板交互测试。
 *
 * 覆盖：体检建议起点、15/30 预览前后对照、预览不写草稿、确认才写入、
 * 无草稿明示 fork 并创建、创建失败保旧、应用后体检重跑回调、撤销一次恢复、
 * 草稿被外部改动后拒绝写入、零自动保存。
 */
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import { createTripDraft, updateDraftStop, type TripDraft } from '../lib/tripDraft'
import PostponePanel from '../components/PostponePanel'

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

function makeLeg(from: TripStop, to: TripStop, duration: number): TripLeg {
  return {
    from_stop_id: from.id,
    to_stop_id: to.id,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 500,
    duration_minutes: duration,
    geometry: [],
    description: '',
  }
}

const S1 = makeStop('09:00', 60, { id: 'p-s1', name: '断桥残雪' })
const S2 = makeStop('10:10', 30, { id: 'p-s2', name: '平湖秋月' })
const S3 = makeStop('11:00', 30, { id: 'p-s3', name: '湖滨晴雨' })
const DAY: TripDay = {
  day: 1,
  date: '2026-04-03',
  title: '第一天',
  summary: '',
  stops: [S1, S2, S3],
  legs: [makeLeg(S1, S2, 5), makeLeg(S2, S3, 5)],
}
const TRIP: Trip = {
  id: 'trip-panel-base',
  source: 'example',
  destination: '杭州',
  title: '顺延面板测试',
  summary: '',
  map_coordinate_system: 'WGS84',
  warnings: [],
  days: [DAY],
}

function createdDraft(): TripDraft {
  const created = createTripDraft(TRIP, { forkTripId: 'trip-panel-fork', newLegMode: 'walking' })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

function timesText(draft: TripDraft | null): string {
  if (draft === null) return 'no-draft'
  return draft.days[0].stops.map((stop) => stop.time).join(',')
}

function Harness({
  initialDraft = null,
  onCreateDraft = () => createTripDraft(TRIP, { forkTripId: 'trip-panel-fork', newLegMode: 'walking' }),
  onChangeSpy,
  onRecheckSpy,
}: {
  initialDraft?: TripDraft | null
  onCreateDraft?: () => ReturnType<typeof createTripDraft>
  onChangeSpy?: (next: TripDraft) => void
  onRecheckSpy?: (day: number) => void
}) {
  const [draft, setDraft] = useState<TripDraft | null>(initialDraft)
  return (
    <>
      <PostponePanel
        baseDay={DAY}
        pace="balanced"
        draft={draft}
        onCreateDraft={onCreateDraft}
        onDraftChange={(next) => {
          setDraft(next)
          onChangeSpy?.(next)
        }}
        onClose={() => {}}
        onHealthRecheck={onRecheckSpy}
      />
      <p data-testid="harness-times">{timesText(draft)}</p>
      <p data-testid="harness-revision">{draft?.revision ?? 'none'}</p>
      <button
        type="button"
        data-testid="harness-external-edit"
        onClick={() => {
          if (draft === null) return
          const edited = updateDraftStop(draft, 1, S2.id, { time: '10:20' })
          if (edited.ok) setDraft(edited.draft)
        }}
      >
        模拟外部编辑
      </button>
    </>
  )
}

describe('PostponePanel', () => {
  beforeEach(() => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('默认选中体检建议起点；30 分钟预览显示级联前后对照，预览不写草稿', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(<Harness onChangeSpy={onChangeSpy} />)

    expect(screen.getByTestId('postpone-suggestion').textContent).toContain('建议从第 2 站')
    expect((screen.getByTestId('postpone-target') as HTMLSelectElement).value).toBe(S2.id)
    expect(screen.getByTestId('postpone-fork-note').textContent).toContain('基于当前行程创建')

    await user.click(screen.getByTestId('postpone-minutes-30'))
    await user.click(screen.getByTestId('postpone-preview-action'))

    const preview = screen.getByTestId('postpone-preview')
    expect(preview.textContent).toContain('10:10 → 10:40')
    expect(preview.textContent).toContain('11:00 → 11:30')
    expect(preview.textContent).toContain('09:00 → 不变')
    expect(screen.getByTestId('harness-times').textContent).toBe('no-draft')
    expect(onChangeSpy).not.toHaveBeenCalled()
  })

  it('确认才创建草稿并写入；应用后体检重跑；撤销一次整体恢复', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    const onRecheckSpy = vi.fn()
    const onCreateDraft = vi.fn(() =>
      createTripDraft(TRIP, { forkTripId: 'trip-panel-fork', newLegMode: 'walking' }),
    )
    render(
      <Harness
        onCreateDraft={onCreateDraft}
        onChangeSpy={onChangeSpy}
        onRecheckSpy={onRecheckSpy}
      />,
    )

    await user.click(screen.getByTestId('postpone-preview-action'))
    expect(onCreateDraft).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('postpone-confirm'))
    expect(onCreateDraft).toHaveBeenCalledTimes(1)
    expect(onChangeSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('harness-times').textContent).toBe('09:00,10:25,11:15')
    expect(onRecheckSpy).toHaveBeenCalledWith(1)

    const undo = screen.getByTestId('postpone-undo')
    expect(undo).toBeEnabled()
    await user.click(undo)
    expect(screen.getByTestId('harness-times').textContent).toBe('09:00,10:10,11:00')
    expect(onRecheckSpy).toHaveBeenCalledTimes(2)
  })

  it('创建草稿失败 → 明示错误且不写任何草稿', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(
      <Harness
        onChangeSpy={onChangeSpy}
        onCreateDraft={() => ({
          ok: false,
          reason: 'invalid_fork_id',
          message: 'fork 失败',
        })}
      />,
    )

    await user.click(screen.getByTestId('postpone-preview-action'))
    await user.click(screen.getByTestId('postpone-confirm'))

    expect(screen.getByRole('alert').textContent).toContain('没能创建草稿：fork 失败')
    expect(onChangeSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('harness-times').textContent).toBe('no-draft')
  })

  it('预览后草稿被改动 → 拒绝写入并保持草稿原样', async () => {
    const user = userEvent.setup()
    const onCreateDraft = vi.fn(() => createTripDraft(TRIP, { forkTripId: 'trip-panel-fork', newLegMode: 'walking' }))
    render(<Harness initialDraft={createdDraft()} onCreateDraft={onCreateDraft} />)

    await user.click(screen.getByTestId('postpone-preview-action'))
    await user.click(screen.getByTestId('harness-external-edit'))
    await user.click(screen.getByTestId('postpone-confirm'))

    expect(screen.getByRole('alert').textContent).toContain('预览后又有改动')
    expect(screen.getByTestId('harness-times').textContent).toBe('09:00,10:20,11:00')
    expect(onCreateDraft).not.toHaveBeenCalled()
  })

  it('零自动保存：不写 localStorage、不发网络请求', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByTestId('postpone-preview-action'))
    await user.click(screen.getByTestId('postpone-confirm'))
    expect(Storage.prototype.setItem).not.toHaveBeenCalled()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})

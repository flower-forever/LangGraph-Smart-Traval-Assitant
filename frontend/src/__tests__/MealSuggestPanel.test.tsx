/**
 * S8 · 补一餐面板交互测试。
 *
 * 覆盖：空档位置展示、3 个餐饮候选、预览时间与位置 + leg 作废提示、
 * 确认才写入（无草稿时走 fork）、创建失败保旧、撤销一次恢复、
 * 双库皆空沉默、无 45 分钟空档明示、零自动保存。
 */
import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import { createTripDraft, type TripDraft } from '../lib/tripDraft'
import type { CandidateItemV1 } from '../lib/workspace'
import MealSuggestPanel from '../components/MealSuggestPanel'

const NOW = 1_800_000_000_000
let seq = 0

function makeStop(time: string, duration: number | null, overrides: Partial<TripStop> = {}): TripStop {
  seq += 1
  return {
    id: `ms${seq}`,
    name: `站点${seq}`,
    time,
    duration_minutes: duration,
    description: '',
    address: '',
    location: null,
    ...overrides,
  }
}

function makeLeg(from: TripStop, to: TripStop): TripLeg {
  return {
    from_stop_id: from.id,
    to_stop_id: to.id,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 500,
    duration_minutes: 10,
    geometry: [],
    description: '',
  }
}

function makeDay(stops: TripStop[]): TripDay {
  return {
    day: 1,
    date: '2026-04-03',
    title: '第一天',
    summary: '',
    stops,
    legs: stops.slice(0, -1).map((stop, index) => makeLeg(stop, stops[index + 1])),
  }
}

const S1 = makeStop('09:00', 90, { id: 'ms-s1', name: '灵隐寺' })
const S2 = makeStop('11:00', 60, {
  id: 'ms-s2',
  name: '龙井村',
  location: { lng: 120.15, lat: 30.28 },
})
const S3 = makeStop('13:00', 60, { id: 'ms-s3', name: '西湖' })
const S4 = makeStop('17:00', 120, { id: 'ms-s4', name: '河坊街' })
const DAY = makeDay([S1, S2, S3, S4])
const TRIP: Trip = {
  id: 'trip-meal-panel-base',
  source: 'example',
  destination: '杭州',
  title: '补餐面板测试',
  summary: '',
  map_coordinate_system: 'WGS84',
  warnings: [],
  days: [DAY],
}

function candidate(id: string, name: string, overrides: Partial<CandidateItemV1> = {}): CandidateItemV1 {
  return {
    id,
    name,
    address: overrides.address ?? null,
    notes: null,
    tags: overrides.tags ?? [],
    priority: 1,
    location: overrides.location ?? null,
    source: 'manual',
    copiedFromStopId: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

const CANDIDATES: readonly CandidateItemV1[] = [
  candidate('c1', '近处餐厅', { location: { lng: 120.1501, lat: 30.2801 } }),
  candidate('c2', '远处餐馆', { location: { lng: 120.5, lat: 30.5 } }),
  candidate('c3', '楼外楼', { tags: ['餐厅', '杭帮菜'] }),
  candidate('c4', '断桥残雪'),
]

function createdDraft(): TripDraft {
  const created = createTripDraft(TRIP, { forkTripId: 'trip-meal-panel-fork', newLegMode: 'walking' })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

function draftSummary(draft: TripDraft | null): string {
  if (draft === null) return 'no-draft'
  const day = draft.days[0]
  return `${day.stops.length}|${day.stops.map((stop) => stop.time).join(',')}`
}

function Harness({
  initialDraft = null,
  day = DAY,
  candidates = CANDIDATES,
  onCreateDraft = () => createTripDraft(TRIP, { forkTripId: 'trip-meal-panel-fork', newLegMode: 'walking' }),
  createStopId = () => 'meal-stop-panel',
  onChangeSpy,
  onRecheckSpy,
}: {
  initialDraft?: TripDraft | null
  day?: TripDay
  candidates?: readonly CandidateItemV1[]
  onCreateDraft?: () => ReturnType<typeof createTripDraft>
  createStopId?: () => string
  onChangeSpy?: (next: TripDraft) => void
  onRecheckSpy?: (day: number) => void
}) {
  const [draft, setDraft] = useState<TripDraft | null>(initialDraft)
  return (
    <>
      <MealSuggestPanel
        baseDay={day}
        draft={draft}
        onCreateDraft={onCreateDraft}
        onDraftChange={(next) => {
          setDraft(next)
          onChangeSpy?.(next)
        }}
        candidates={candidates}
        poiCards={null}
        createStopId={createStopId}
        now={NOW}
        onClose={() => {}}
        onHealthRecheck={onRecheckSpy}
      />
      <p data-testid="harness-meal-summary">{draftSummary(draft)}</p>
      <button
        type="button"
        data-testid="harness-meal-external-edit"
        onClick={() => {
          if (draft === null) return
          const next = {
            ...draft,
            revision: draft.revision + 1,
          }
          setDraft(next)
        }}
      >
        模拟外部改动
      </button>
    </>
  )
}

describe('MealSuggestPanel', () => {
  beforeEach(() => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('展示最近空档与 3 个餐饮候选；预览显示时间、位置与 leg 作废说明', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(<Harness onChangeSpy={onChangeSpy} />)

    const slot = screen.getByTestId('meal-slot')
    expect(slot.textContent).toContain('午餐 12:00–12:45')
    expect(slot.textContent).toContain('第 2 站「龙井村」之后')
    expect(slot.textContent).toContain('第 3 站「西湖」之前')
    expect(screen.getByTestId('meal-fork-note').textContent).toContain('基于当前行程创建')

    const cards = screen.getAllByTestId('meal-candidate')
    expect(cards).toHaveLength(3)
    const names = cards.map((card) => card.textContent ?? '')
    expect(names[0]).toContain('近处餐厅')
    expect(names.some((text) => text.includes('断桥残雪'))).toBe(false)

    await user.click(within(cards[0]).getByText('预览插入'))
    const preview = screen.getByTestId('meal-preview')
    expect(preview.textContent).toContain('12:00–12:45')
    expect(preview.textContent).toContain('第 2 站「龙井村」之后')
    expect(preview.textContent).toContain('2 段相邻路线')
    expect(preview.textContent).toContain('路线待重取')
    expect(screen.getByTestId('harness-meal-summary').textContent).toBe('no-draft')
    expect(onChangeSpy).not.toHaveBeenCalled()
  })

  it('确认才创建草稿并插入；撤销一次恢复原站点与时刻', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    const onRecheckSpy = vi.fn()
    const onCreateDraft = vi.fn(() =>
      createTripDraft(TRIP, { forkTripId: 'trip-meal-panel-fork', newLegMode: 'walking' }),
    )
    render(
      <Harness
        onCreateDraft={onCreateDraft}
        onChangeSpy={onChangeSpy}
        onRecheckSpy={onRecheckSpy}
      />,
    )

    const card = screen.getAllByTestId('meal-candidate')[0]
    await user.click(within(card).getByText('预览插入'))
    expect(onCreateDraft).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('meal-confirm'))
    expect(onCreateDraft).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('harness-meal-summary').textContent).toBe(
      '5|09:00,11:00,12:00,13:00,17:00',
    )
    expect(onRecheckSpy).toHaveBeenCalledWith(1)

    const draft = onChangeSpy.mock.calls[0][0] as TripDraft
    expect(draft.days[0].stops[2].name).toBe('近处餐厅')
    expect(draft.days[0].stops[2].duration_minutes).toBe(45)
    expect(draft.days[0].legs.filter((leg) => leg.route_type === 'unavailable')).toHaveLength(2)

    const undo = screen.getByTestId('meal-undo')
    expect(undo).toBeEnabled()
    await user.click(undo)
    expect(screen.getByTestId('harness-meal-summary').textContent).toBe(
      '4|09:00,11:00,13:00,17:00',
    )
    expect(onRecheckSpy).toHaveBeenCalledTimes(2)
  })

  it('双库都没有餐饮候选 → 沉默显示「暂无餐饮候选」，不提供插入', async () => {
    render(<Harness candidates={[]} />)
    expect(screen.getByTestId('meal-empty').textContent).toContain('暂无餐饮候选')
    expect(screen.queryAllByTestId('meal-candidate')).toHaveLength(0)
    expect(screen.queryByTestId('meal-confirm')).toBeNull()
  })

  it('没有 45 分钟连续空档 → 明示不提供会重叠的方案', () => {
    const denseDay = makeDay([
      makeStop('11:30', 120, { id: 'dense-s1', name: '午餐占用' }),
      makeStop('17:30', 120, { id: 'dense-s2', name: '晚餐占用' }),
    ])
    render(<Harness day={denseDay} />)
    const missing = screen.getByTestId('meal-slot-missing')
    expect(missing.textContent).toContain('不提供会重叠的方案')
    expect(screen.queryAllByTestId('meal-candidate')).toHaveLength(0)
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

    const card = screen.getAllByTestId('meal-candidate')[0]
    await user.click(within(card).getByText('预览插入'))
    await user.click(screen.getByTestId('meal-confirm'))

    expect(screen.getByRole('alert').textContent).toContain('没能创建草稿：fork 失败')
    expect(onChangeSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('harness-meal-summary').textContent).toBe('no-draft')
  })

  it('草稿在预览后变化 → 撤销不再可用（避免误回退别的编辑）', async () => {
    const user = userEvent.setup()
    render(<Harness initialDraft={createdDraft()} />)

    const card = screen.getAllByTestId('meal-candidate')[0]
    await user.click(within(card).getByText('预览插入'))
    await user.click(screen.getByTestId('meal-confirm'))
    expect(screen.getByTestId('meal-undo')).toBeEnabled()

    await user.click(screen.getByTestId('harness-meal-external-edit'))
    expect(screen.getByTestId('meal-undo')).toBeDisabled()
  })

  it('零自动保存：不写 localStorage、不发网络请求', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const card = screen.getAllByTestId('meal-candidate')[0]
    await user.click(within(card).getByText('预览插入'))
    await user.click(screen.getByTestId('meal-confirm'))
    expect(Storage.prototype.setItem).not.toHaveBeenCalled()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})

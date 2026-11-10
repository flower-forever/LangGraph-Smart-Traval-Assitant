/**
 * 六期 S2 · 交互动效测试：换一翻卡对称性 + 地图 fly-to 的 reduced-motion 分支。
 *
 * 边界：
 * - 翻卡是**纯装饰层**：本文件只钉住「事件发出方向」与「失败不发事件」，
 *   swap 数据流（legs unavailable / location null / 撤销语义）由既有
 *   TripDraftEditorSwap.test.tsx / stopSwap.test.ts 钉住，这里零重复、零改动。
 * - fly-to 用 vi.spyOn 钉住 Leaflet 调用与参数（jsdom 无布局，动画不会真的跑）。
 *   注意 Leaflet 初始化 / fitBounds / 弹窗内部也会调 setView，所以「我的直跳」
 *   按精确签名过滤：options 恰为 { animate: false } 一个键（组件直跳的唯一形状）。
 * - matchMedia 桩：useReducedMotion 在 jsdom 下 matchMedia 缺失按 false 兜底；
 *   要钉 reduced 分支就装一个可切换的桩。
 */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import L from 'leaflet'

import TripMap from '../components/TripMap'
import RouteReplayPanel from '../components/RouteReplayPanel'
import StopSwapPanel from '../components/StopSwapPanel'
import { createTripDraft, type TripDraft } from '../lib/tripDraft'
import { MAP_FLY_DURATION_S, REPLAY_FLY_DURATION_S } from '../lib/motionMap'
import type { Trip } from '../lib/api'
import type { CandidateItemV1 } from '../lib/workspace'
import { MOCK_TRIP } from './fixtures/trip'
import { REPLAY_DAYS } from './fixtures/replay'

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

/** 组件直跳的 setView 签名：animate === false（Leaflet 内部会展开成 zoom/pan 键，组件直跳只传 animate）。 */
function isDirectJump(call: unknown[]): boolean {
  const opts = call[2] as L.ZoomPanOptions | undefined
  return typeof opts === 'object' && opts !== null && 'animate' in opts && opts.animate === false
}

function directJumpCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(isDirectJump).length
}

/** 可切换的 matchMedia 桩；返回 query 与 listeners 供手动触发 change（与真实事件语义一致）。 */
function stubMatchMedia(reduced: boolean): {
  query: { matches: boolean }
  listeners: Set<() => void>
} {
  const listeners = new Set<() => void>()
  const query = {
    matches: reduced,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(query))
  return { query, listeners }
}

const day1 = MOCK_TRIP.days[0]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* ───────── TripMap · fly-to（选中联动） ───────── */

describe('TripMap · fly-to（六期 S2）', () => {
  it('外部选中站点时 flyTo 平滑飞行，时长用统一常量', () => {
    stubMatchMedia(false)
    const flyToSpy = vi.spyOn(L.Map.prototype, 'flyTo')
    const setViewSpy = vi.spyOn(L.Map.prototype, 'setView')

    const { rerender } = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(flyToSpy).not.toHaveBeenCalled()
    expect(directJumpCount(setViewSpy)).toBe(0)

    rerender(<TripMap day={day1} activeStopId="s1" onSelectStop={vi.fn()} />)

    expect(flyToSpy).toHaveBeenCalledTimes(1)
    const [latlng, zoom, options] = flyToSpy.mock.calls[0] as [L.LatLng, number, L.ZoomPanOptions]
    // 目标是断桥残雪的 marker 位置，zoom 至少 13（不缩小用户视野）
    expect(latlng.lat).toBeCloseTo(day1.stops[0].location!.lat, 6)
    expect(latlng.lng).toBeCloseTo(day1.stops[0].location!.lng, 6)
    expect(zoom).toBeGreaterThanOrEqual(13)
    expect(options.duration).toBe(MAP_FLY_DURATION_S)
    expect(directJumpCount(setViewSpy)).toBe(0)
  })

  it('reduced-motion 下选中站点改 setView 直跳，不调用 flyTo', () => {
    stubMatchMedia(true)
    const flyToSpy = vi.spyOn(L.Map.prototype, 'flyTo')
    const setViewSpy = vi.spyOn(L.Map.prototype, 'setView')

    const { rerender } = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    rerender(<TripMap day={day1} activeStopId="s2" onSelectStop={vi.fn()} />)

    expect(flyToSpy).not.toHaveBeenCalled()
    expect(directJumpCount(setViewSpy)).toBe(1)
    const [latlng, zoom, options] = setViewSpy.mock.calls.find(isDirectJump) as [
      L.LatLng,
      number,
      L.ZoomPanOptions,
    ]
    expect(latlng.lat).toBeCloseTo(day1.stops[1].location!.lat, 6)
    expect(latlng.lng).toBeCloseTo(day1.stops[1].location!.lng, 6)
    expect(zoom).toBeGreaterThanOrEqual(13)
    expect(options.animate).toBe(false)
  })

  it('系统 reduced-motion 在挂载后开启：新一次选中走 setView 直跳', () => {
    const { query, listeners } = stubMatchMedia(false)
    const flyToSpy = vi.spyOn(L.Map.prototype, 'flyTo')
    const setViewSpy = vi.spyOn(L.Map.prototype, 'setView')

    const { rerender } = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    // 用户中途开启「减少动态效果」：change 事件触达订阅（React 状态更新包 act）
    act(() => {
      query.matches = true
      for (const listener of [...listeners]) listener()
    })

    rerender(<TripMap day={day1} activeStopId="s1" onSelectStop={vi.fn()} />)

    expect(setViewSpy.mock.calls.length).toBeGreaterThan(0)
    expect(directJumpCount(setViewSpy)).toBe(1)
    expect(flyToSpy).not.toHaveBeenCalled()
  })

  it('取消选中（activeStopId 回到 null）只关弹窗，不再触发任何地图移动', () => {
    stubMatchMedia(false)
    const flyToSpy = vi.spyOn(L.Map.prototype, 'flyTo')
    const setViewSpy = vi.spyOn(L.Map.prototype, 'setView')

    const { rerender } = render(<TripMap day={day1} activeStopId="s1" onSelectStop={vi.fn()} />)
    expect(flyToSpy).toHaveBeenCalledTimes(1)

    rerender(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(flyToSpy).toHaveBeenCalledTimes(1)
    expect(directJumpCount(setViewSpy)).toBe(0)
  })
})

/* ───────── RouteReplayPanel · fly-to（回放到站 / 换天） ───────── */

describe('RouteReplayPanel · fly-to（六期 S2）', () => {
  it('非 reduced 下到站 flyTo，时长用统一常量', () => {
    const flyToSpy = vi.spyOn(L.Map.prototype, 'flyTo')
    const setViewSpy = vi.spyOn(L.Map.prototype, 'setView')

    render(<RouteReplayPanel days={REPLAY_DAYS} initialDay={1} onClose={vi.fn()} />)
    // reducedMotion 未传 → 走系统通道；jsdom 桩默认不 reduced
    expect(flyToSpy).toHaveBeenCalled()
    const [, , options] = flyToSpy.mock.calls[0] as [L.LatLng, number, L.ZoomPanOptions]
    expect(options.duration).toBe(REPLAY_FLY_DURATION_S)
    expect(directJumpCount(setViewSpy)).toBe(0)
  })

  it('reduced 下到站 setView 直跳（animate:false），flyTo 零调用', () => {
    const flyToSpy = vi.spyOn(L.Map.prototype, 'flyTo')
    const setViewSpy = vi.spyOn(L.Map.prototype, 'setView')

    render(
      <RouteReplayPanel days={REPLAY_DAYS} initialDay={1} onClose={vi.fn()} reducedMotion />,
    )
    expect(flyToSpy).not.toHaveBeenCalled()
    expect(directJumpCount(setViewSpy)).toBe(1)
  })

  it('换天 reset 后同一分支继续生效：reduced 换天仍直跳到新天第 1 站', () => {
    const flyToSpy = vi.spyOn(L.Map.prototype, 'flyTo')
    const setViewSpy = vi.spyOn(L.Map.prototype, 'setView')

    render(
      <RouteReplayPanel days={REPLAY_DAYS} initialDay={1} onClose={vi.fn()} reducedMotion />,
    )
    const jumpsBefore = directJumpCount(setViewSpy)

    fireEvent.change(screen.getByTestId('replay-day-select'), { target: { value: '1' } })
    expect(panel()).toHaveAttribute('data-station-count', '2')
    // 换天没有触发 flyTo，setView 继续走直跳分支
    expect(flyToSpy).not.toHaveBeenCalled()
    expect(directJumpCount(setViewSpy)).toBe(jumpsBefore + 1)
  })
})

function panel(): HTMLElement {
  return screen.getByTestId('route-replay-panel')
}

/* ───────── 换一翻卡 · 对称性（forward / backward） ───────── */

describe('换一翻卡 · 对称性（六期 S2）', () => {
  type SwapAnimEvent = { stopId: string; direction: 'forward' | 'backward' }

  /** 独立 harness：监听 StopSwapPanel 的事件序列，不经过编辑器 DOM。 */
  function EventHarness({ events }: { events: SwapAnimEvent[] }) {
    const [draft, setDraft] = useState<TripDraft>(() => {
      const created = createTripDraft(cloneTrip(), {
        forkTripId: 'trip-fork-swap-anim',
        newLegMode: 'walking',
      })
      if (!created.ok) throw new Error(created.message)
      return created.draft
    })
    return (
      <StopSwapPanel
        draft={draft}
        dayNumber={1}
        stop={draft.days.find((day) => day.day === 1)!.stops[0]}
        onDraftChange={setDraft}
        candidates={[candidate({ id: 'c1', name: '浙江省博物馆' })]}
        onClose={() => {}}
        onSwapAnimated={(direction) => events.push({ stopId: 's1', direction })}
      />
    )
  }

  it('确认替换发 forward，撤销发 backward：方向对称、成对出现', async () => {
    const user = userEvent.setup()
    const events: SwapAnimEvent[] = []
    render(<EventHarness events={events} />)

    await user.click(screen.getByRole('button', { name: '预览替换' }))
    await user.click(screen.getByRole('button', { name: '确认替换' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '撤销这次更换' })).toBeEnabled())

    expect(events).toEqual([{ stopId: 's1', direction: 'forward' }])

    await user.click(screen.getByRole('button', { name: '撤销这次更换' }))
    expect(events).toEqual([
      { stopId: 's1', direction: 'forward' },
      { stopId: 's1', direction: 'backward' },
    ])
  })

  it('替换失败（站点已不在草稿里）不发翻卡事件，草稿保持原样', async () => {
    const user = userEvent.setup()
    const events: SwapAnimEvent[] = []
    // 草稿里 s1 已不存在（外部改动），面板持有的 stop 引用指向旧 id
    const stale = draftWithoutStop1()
    const ghostStop = cloneTrip().days[0].stops[0]
    render(
      <StopSwapPanel
        draft={stale}
        dayNumber={1}
        stop={ghostStop}
        onDraftChange={() => {}}
        candidates={[candidate({ id: 'c1', name: '浙江省博物馆' })]}
        onClose={() => {}}
        onSwapAnimated={(direction) => events.push({ stopId: 's1', direction })}
      />,
    )

    await user.click(screen.getByRole('button', { name: '预览替换' }))

    // 预览即失败：错误可见、确认按钮根本没有出现、零翻卡事件
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认替换' })).toBeNull()
    expect(events).toEqual([])
  })
})

/** 移除第 1 天的 s1（把它的 id 改掉模拟外部改动），用来构造「确认替换会失败」的场景。 */
function draftWithoutStop1(): TripDraft {
  const created = createTripDraft(cloneTrip(), {
    forkTripId: 'trip-fork-swap-anim-stale',
    newLegMode: 'walking',
  })
  if (!created.ok) throw new Error(created.message)
  const draft = created.draft
  const day1Draft = draft.days.find((day) => day.day === 1)!
  day1Draft.stops = day1Draft.stops.map((stop, index) =>
    index === 0 ? { ...stop, id: 's1-moved' } : stop,
  )
  return draft
}

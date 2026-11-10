/**
 * S7 · 路线回放纯逻辑测试（计划 §8.2）。
 *
 * 覆盖：计划构建（四种路线 / 缺坐标 / 无 leg / leg 顺序不匹配）、几何简化与截断、
 * 五站状态机（播放 / 暂停 / 继续 / 上一站 / 下一站 / 拖动 / 倍速 / 换天 / 结束）、
 * prefers-reduced-motion 逐站翻页。全部纯函数，零 DOM、零存储、零网络。
 */
import { describe, expect, it } from 'vitest'

import type { TripDay } from '../lib/api'
import {
  INITIAL_REPLAY_STATE,
  MAX_REPLAY_GEOMETRY_POINTS,
  REPLAY_DWELL_MS,
  REPLAY_LEG_MS,
  REPLAY_STRAIGHT_MS,
  buildReplayDay,
  normalizeReplaySpeed,
  reduceReplay,
  replayRouteLabel,
  replayStayLabel,
  replayTimeLabel,
  simplifyGeometry,
  sliceGeometry,
  type ReplayContext,
  type ReplayState,
} from '../lib/routeReplay'
import { REPLAY_DAY, REPLAY_DAY_EMPTY, REPLAY_DAY_NO_COORD } from './fixtures/replay'

const CONTEXT: ReplayContext = {
  stationCount: REPLAY_DAY.stops.length,
  legKinds: ['unavailable', 'navigation', 'straight_line', 'unavailable', 'straight_line'],
  reducedMotion: false,
}

const REDUCED_CONTEXT: ReplayContext = { ...CONTEXT, reducedMotion: true }

function play(state: ReplayState, context: ReplayContext = CONTEXT): ReplayState {
  return reduceReplay(state, { type: 'play' }, context)
}

function tick(state: ReplayState, deltaMs: number, context: ReplayContext = CONTEXT): ReplayState {
  return reduceReplay(state, { type: 'tick', deltaMs }, context)
}

describe('buildReplayDay · 四种路段与缺失降级', () => {
  const plan = buildReplayDay(REPLAY_DAY)

  it('五站全部保留，首站无入站段', () => {
    expect(plan.stations).toHaveLength(5)
    expect(plan.drawableStopCount).toBe(5)
    expect(plan.missingCoordCount).toBe(0)
    expect(plan.stations[0].inbound).toBeNull()
    expect(plan.stations.map((station) => station.stop.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
  })

  it('navigation 用完整折线', () => {
    const inbound = plan.stations[1].inbound!
    expect(inbound.kind).toBe('navigation')
    expect(inbound.note).toBe('navigation')
    expect(inbound.geometry).toHaveLength(3)
    expect(replayRouteLabel(inbound)).toBe('地图服务路线')
  })

  it('straight_line 只连两端并画虚线语义', () => {
    const inbound = plan.stations[2].inbound!
    expect(inbound.kind).toBe('straight_line')
    expect(inbound.note).toBe('straight_line')
    expect(inbound.geometry).toEqual([
      { lng: 120.1522, lat: 30.2631 },
      { lng: 120.1651, lat: 30.2567 },
    ])
    expect(replayRouteLabel(inbound)).toBe('示意直线（非导航）')
  })

  it('unavailable 不画线', () => {
    const inbound = plan.stations[3].inbound!
    expect(inbound.kind).toBe('unavailable')
    expect(inbound.note).toBe('route_unavailable')
    expect(inbound.geometry).toEqual([])
    expect(replayRouteLabel(inbound)).toBe('路线未知')
  })

  it('navigation 无 geometry 降级成两点示意，不冒充导航', () => {
    const inbound = plan.stations[4].inbound!
    expect(inbound.kind).toBe('straight_line')
    expect(inbound.note).toBe('navigation_without_geometry')
    expect(inbound.geometry).toHaveLength(2)
    expect(replayRouteLabel(inbound)).toContain('按示意直线显示')
  })

  it('缺坐标：不画点、不画线，卡片口径为位置未知', () => {
    const missing = buildReplayDay(REPLAY_DAY_NO_COORD)
    expect(missing.stations[1].location).toBeNull()
    expect(missing.missingCoordCount).toBe(1)
    expect(missing.drawableStopCount).toBe(1)
    const inbound = missing.stations[1].inbound!
    expect(inbound.kind).toBe('unavailable')
    expect(inbound.note).toBe('missing_coordinate')
    expect(inbound.geometry).toEqual([])
    expect(replayRouteLabel(inbound)).toBe('位置未知，无法绘制路线')
  })

  it('没有 leg / leg 顺序不匹配：标未提供，不硬套路线', () => {
    const noLeg: TripDay = {
      day: 9,
      date: null,
      title: '',
      summary: '',
      stops: REPLAY_DAY.stops.slice(0, 2),
      legs: [],
    }
    expect(buildReplayDay(noLeg).stations[1].inbound!.note).toBe('no_leg')

    const wrongOrder: TripDay = {
      ...noLeg,
      legs: [{ ...REPLAY_DAY.legs[0], from_stop_id: 'r5', to_stop_id: 'r2' }],
    }
    expect(buildReplayDay(wrongOrder).stations[1].inbound!.note).toBe('no_leg')
  })

  it('空日返回空计划', () => {
    const plan = buildReplayDay(REPLAY_DAY_EMPTY)
    expect(plan.stations).toEqual([])
    expect(plan.drawableStopCount).toBe(0)
  })
})

describe('几何简化与截断', () => {
  it('超过上限时等距抽样，首尾保留', () => {
    const points = Array.from({ length: 500 }, (_, index) => ({ lng: 120 + index * 0.0001, lat: 30 }))
    const simplified = simplifyGeometry(points, MAX_REPLAY_GEOMETRY_POINTS)
    expect(simplified).toHaveLength(MAX_REPLAY_GEOMETRY_POINTS)
    expect(simplified[0]).toEqual(points[0])
    expect(simplified[simplified.length - 1]).toEqual(points[points.length - 1])
    expect(simplified[1].lng).toBeGreaterThan(simplified[0].lng)
  })

  it('未超过上限时逐点复制，不改坐标', () => {
    const points = [{ lng: 1, lat: 2 }, { lng: 3, lat: 4 }]
    const copy = simplifyGeometry(points, 10)
    expect(copy).toEqual(points)
    expect(copy).not.toBe(points)
  })

  it('sliceGeometry：0 只留起点，1 返回完整，0.5 落在中间', () => {
    const points = [
      { lng: 120, lat: 30 },
      { lng: 120.01, lat: 30 },
      { lng: 120.02, lat: 30 },
    ]
    expect(sliceGeometry(points, 0)).toEqual([points[0]])
    expect(sliceGeometry(points, 1)).toEqual(points)
    const half = sliceGeometry(points, 0.5)
    expect(half.length).toBeGreaterThanOrEqual(2)
    expect(half[0]).toEqual(points[0])
    expect(half[half.length - 1].lng).toBeCloseTo(120.01, 6)
  })

  it('同点折线不会除零', () => {
    const points = [
      { lng: 120, lat: 30 },
      { lng: 120, lat: 30 },
    ]
    expect(sliceGeometry(points, 0.3)).toEqual([points[0]])
    expect(sliceGeometry(points, 1)).toEqual(points)
  })
})

describe('五站状态机', () => {
  it('初始暂停在第一站', () => {
    expect(INITIAL_REPLAY_STATE.stationIndex).toBe(0)
    expect(INITIAL_REPLAY_STATE.playing).toBe(false)
    expect(INITIAL_REPLAY_STATE.phase).toBe('station')
  })

  it('播放 → 停留 → 画线 → 到下一站，按顺序推进', () => {
    let state = play(INITIAL_REPLAY_STATE)
    expect(state.playing).toBe(true)

    state = tick(state, REPLAY_DWELL_MS - 100)
    expect(state.stationIndex).toBe(0)
    expect(state.phase).toBe('station')
    expect(state.progress).toBeGreaterThan(0)

    state = tick(state, 101)
    expect(state.phase).toBe('leg')
    expect(state.stationIndex).toBe(0)

    state = tick(state, REPLAY_LEG_MS / 2)
    expect(state.phase).toBe('leg')
    expect(state.progress).toBeCloseTo(0.5, 1)

    state = tick(state, REPLAY_LEG_MS / 2)
    expect(state.stationIndex).toBe(1)
    expect(state.phase).toBe('station')
    expect(state.progress).toBe(0)
  })

  it('暂停后 tick 不推进；继续后从原进度接着走', () => {
    let state = play(INITIAL_REPLAY_STATE)
    state = tick(state, REPLAY_DWELL_MS)
    expect(state.phase).toBe('leg')
    const paused = reduceReplay(state, { type: 'pause' }, CONTEXT)
    expect(paused.playing).toBe(false)
    const afterPauseTick = tick(paused, 5000)
    expect(afterPauseTick).toEqual(paused)

    state = play(afterPauseTick)
    expect(state.playing).toBe(true)
    expect(state.progress).toBe(paused.progress)
  })

  it('上一站 / 下一站 / 拖动都重置到站点阶段', () => {
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'next' }, CONTEXT)
    expect(state.stationIndex).toBe(1)
    state = reduceReplay(state, { type: 'next' }, CONTEXT)
    expect(state.stationIndex).toBe(2)
    state = reduceReplay(state, { type: 'prev' }, CONTEXT)
    expect(state.stationIndex).toBe(1)
    state = reduceReplay(state, { type: 'seek', index: 4 }, CONTEXT)
    expect(state.stationIndex).toBe(4)
    expect(state.phase).toBe('station')
    // 越界拖动夹到 0..4
    expect(reduceReplay(state, { type: 'seek', index: 99 }, CONTEXT).stationIndex).toBe(4)
    expect(reduceReplay(state, { type: 'seek', index: -5 }, CONTEXT).stationIndex).toBe(0)
  })

  it('最后一站下一站 → 回放结束；再播放从头开始', () => {
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 4 }, CONTEXT)
    state = reduceReplay(state, { type: 'next' }, CONTEXT)
    expect(state.phase).toBe('finished')
    expect(state.playing).toBe(false)

    state = play(state)
    expect(state.stationIndex).toBe(0)
    expect(state.phase).toBe('station')
    expect(state.playing).toBe(true)
  })

  it('最后一站停留结束自动进入 finished', () => {
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 4 }, CONTEXT)
    state = play(state)
    state = tick(state, REPLAY_DWELL_MS)
    expect(state.phase).toBe('finished')
    expect(state.playing).toBe(false)
  })

  it('倍速 2x 把停留与画线时长减半', () => {
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'setSpeed', speed: 2 }, CONTEXT)
    state = play(state)
    state = tick(state, REPLAY_DWELL_MS / 2)
    expect(state.phase).toBe('leg')
    state = tick(state, REPLAY_LEG_MS / 2)
    expect(state.stationIndex).toBe(1)

    // 1x 下同样的时间不足以走完 leg
    let slow = play(INITIAL_REPLAY_STATE)
    slow = tick(slow, REPLAY_DWELL_MS)
    slow = tick(slow, REPLAY_LEG_MS / 2)
    expect(slow.phase).toBe('leg')
    expect(slow.stationIndex).toBe(0)
  })

  it('straight_line 的 leg 阶段比 navigation 短', () => {
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 1 }, CONTEXT)
    state = play(state)
    state = tick(state, REPLAY_DWELL_MS)
    expect(state.phase).toBe('leg')
    // 第 3 站入站段是 straight_line，用 REPLAY_STRAIGHT_MS
    state = tick(state, REPLAY_STRAIGHT_MS)
    expect(state.stationIndex).toBe(2)
  })

  it('换天 reset 回到第一站并保留倍速', () => {
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 3 }, CONTEXT)
    state = reduceReplay(state, { type: 'setSpeed', speed: 1.5 }, CONTEXT)
    state = reduceReplay(state, { type: 'reset' }, CONTEXT)
    expect(state.stationIndex).toBe(0)
    expect(state.phase).toBe('station')
    expect(state.playing).toBe(false)
    expect(state.speed).toBe(1.5)
  })

  it('空日直接 finished', () => {
    const state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'play' }, { ...CONTEXT, stationCount: 0 })
    expect(state.phase).toBe('finished')
    expect(state.playing).toBe(false)
  })

  it('从空日 reset 回有站点的日子：回到第一站，不留在 finished', () => {
    const emptyFinished = reduceReplay(INITIAL_REPLAY_STATE, { type: 'play' }, {
      ...CONTEXT,
      stationCount: 0,
    })
    expect(emptyFinished.phase).toBe('finished')
    const state = reduceReplay(emptyFinished, { type: 'reset' }, CONTEXT)
    expect(state.stationIndex).toBe(0)
    expect(state.phase).toBe('station')
    expect(state.playing).toBe(false)
  })

  it('normalizeReplaySpeed 只接受 1 / 1.5 / 2', () => {
    expect(normalizeReplaySpeed(1.2)).toBe(1)
    expect(normalizeReplaySpeed(1.5)).toBe(1.5)
    expect(normalizeReplaySpeed(1.9)).toBe(1.5)
    expect(normalizeReplaySpeed(9)).toBe(2)
    expect(normalizeReplaySpeed(Number.NaN)).toBe(1)
  })
})

describe('prefers-reduced-motion · 逐站翻页', () => {
  it('停留结束直接到下一站，不进入 leg 阶段', () => {
    let state = play(INITIAL_REPLAY_STATE, REDUCED_CONTEXT)
    state = tick(state, REPLAY_DWELL_MS, REDUCED_CONTEXT)
    expect(state.stationIndex).toBe(1)
    expect(state.phase).toBe('station')
    expect(state.progress).toBe(0)

    state = tick(state, REPLAY_DWELL_MS, REDUCED_CONTEXT)
    expect(state.stationIndex).toBe(2)
    expect(state.phase).toBe('station')
  })

  it('最后一站停留结束进入 finished', () => {
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 4 }, REDUCED_CONTEXT)
    state = play(state, REDUCED_CONTEXT)
    state = tick(state, REPLAY_DWELL_MS, REDUCED_CONTEXT)
    expect(state.phase).toBe('finished')
  })
})

describe('展示口径', () => {
  it('无时间 / 无停留显示未知，不补默认值', () => {
    const stop = REPLAY_DAY.stops[2]
    expect(replayTimeLabel(stop)).toBe('11:30')
    expect(replayStayLabel(stop)).toBe('停留未知')
    expect(replayTimeLabel({ ...stop, time: '' })).toBe('时间未知')
    expect(replayStayLabel({ ...stop, duration_minutes: 30 })).toBe('停留 约 30 分钟')
  })
})

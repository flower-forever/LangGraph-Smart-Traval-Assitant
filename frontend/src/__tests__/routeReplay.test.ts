/**
 * S7 · 路线回放纯逻辑测试（计划 §8.2）。
 *
 * 覆盖：计划构建（四种路线 / 缺坐标 / 无 leg / leg 顺序不匹配）、几何简化与截断、
 * 五站状态机（播放 / 暂停 / 继续 / 上一站 / 下一站 / 拖动 / 倍速 / 换天 / 结束）、
 * prefers-reduced-motion 逐站翻页。全部纯函数，零 DOM、零存储、零网络。
 */
import { describe, expect, it } from 'vitest'

import type { TripDay, TripLeg } from '../lib/api'
import {
  INITIAL_REPLAY_STATE,
  MAX_REPLAY_GEOMETRY_POINTS,
  REPLAY_DWELL_MAX_MS,
  REPLAY_DWELL_MIN_MS,
  REPLAY_DWELL_MS,
  REPLAY_INTERCITY_MAX_MS,
  REPLAY_INTERCITY_MIN_MS,
  REPLAY_INTERCITY_MS,
  REPLAY_LEG_MAX_MS,
  REPLAY_LEG_MIN_MS,
  REPLAY_LEG_MS,
  REPLAY_STRAIGHT_MS,
  buildReplayDay,
  normalizeReplaySpeed,
  reduceReplay,
  replayDwellMs,
  replayIntercityMs,
  replayLegMs,
  replayNoteText,
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

describe('六期 S9 · 按时长比例分配回放节奏', () => {
  it('停留按 duration_minutes 换算并夹在上下限；缺失回退现状默认', () => {
    expect(replayDwellMs(40)).toBe(3200)
    expect(replayDwellMs(1)).toBe(REPLAY_DWELL_MIN_MS)
    expect(replayDwellMs(90)).toBe(REPLAY_DWELL_MAX_MS)
    expect(replayDwellMs(null)).toBe(REPLAY_DWELL_MS)
    expect(replayDwellMs(undefined)).toBe(REPLAY_DWELL_MS)
    expect(replayDwellMs(Number.NaN)).toBe(REPLAY_DWELL_MS)
  })

  it('路段按 duration_minutes 换算；缺失按路线类型回退旧默认', () => {
    expect(replayLegMs(15, 'navigation')).toBe(1200)
    expect(replayLegMs(12, 'straight_line')).toBe(REPLAY_LEG_MIN_MS)
    expect(replayLegMs(1, 'navigation')).toBe(REPLAY_LEG_MIN_MS)
    expect(replayLegMs(90, 'navigation')).toBe(REPLAY_LEG_MAX_MS)
    expect(replayLegMs(null, 'navigation')).toBe(REPLAY_LEG_MS)
    expect(replayLegMs(null, 'straight_line')).toBe(REPLAY_STRAIGHT_MS)
    expect(replayLegMs(undefined, 'unavailable')).toBe(1200)
  })

  it('状态机使用 context 的每站/每段时长，不再走固定 2500/2600', () => {
    const context: ReplayContext = {
      ...CONTEXT,
      dwellMs: [1000, 2000, 3000, 4000, 5000],
      legMs: [0, 800, 1600, 2400, 3200],
    }
    let state = play(INITIAL_REPLAY_STATE, context)
    state = tick(state, 999, context)
    expect(state.phase).toBe('station')
    state = tick(state, 1, context)
    expect(state.phase).toBe('leg')
    state = tick(state, 799, context)
    expect(state.stationIndex).toBe(0)
    state = tick(state, 1, context)
    expect(state.stationIndex).toBe(1)
    expect(state.phase).toBe('station')

    // 第 2 站停留 2000ms；leg 1600ms 与第 1 站不同，证明确实按站取值
    state = tick(state, 2000, context)
    expect(state.phase).toBe('leg')
    state = tick(state, 1599, context)
    expect(state.stationIndex).toBe(1)
    state = tick(state, 1, context)
    expect(state.stationIndex).toBe(2)
  })

  it('reduced-motion 仍按站翻页，只受停留时长影响、不进入 leg', () => {
    const context: ReplayContext = {
      ...CONTEXT,
      dwellMs: [1000, 1000, 1000, 1000, 1000],
      legMs: [0, 9000, 9000, 9000, 9000],
      reducedMotion: true,
    }
    let state = play(INITIAL_REPLAY_STATE, context)
    state = tick(state, 1000, context)
    expect(state.stationIndex).toBe(1)
    expect(state.phase).toBe('station')
    state = tick(state, 1000, context)
    expect(state.stationIndex).toBe(2)
    expect(state.phase).toBe('station')
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

/* ───────────────────── 七期 S4 · 回放城际段 ───────────────────── */

const INTERCITY_LEG: TripLeg = {
  from_stop_id: 'r5',
  to_stop_id: 'x1',
  mode: 'driving',
  route_type: 'straight_line',
  distance_m: 170000,
  duration_minutes: 133,
  geometry: [
    { lng: 120.1131, lat: 30.2226 },
    { lng: 121.49, lat: 31.24 },
  ],
  description: '城际转移：杭州 → 上海，直线约 170.0 公里；估算并预留约 2 小时 13 分钟。具体班次与时刻未提供，请自行查询。',
  transferKind: 'intercity',
}

const MULTICITY_DAY: TripDay = {
  ...REPLAY_DAY,
  legs: [...REPLAY_DAY.legs, INTERCITY_LEG],
}

describe('七期 S4 · 跨城日回放计划', () => {
  it('最后一条城际段进入 intercity，距离 / 时长与 leg 一致', () => {
    const plan = buildReplayDay(MULTICITY_DAY)
    expect(plan.intercity).not.toBeNull()
    expect(plan.intercity!.note).toBe('intercity')
    expect(plan.intercity!.kind).toBe('straight_line')
    expect(plan.intercity!.distanceMeters).toBe(170000)
    expect(plan.intercity!.durationMinutes).toBe(133)
    expect(plan.intercity!.description).toBe(INTERCITY_LEG.description)
    expect(plan.intercity!.geometry).toEqual(INTERCITY_LEG.geometry)
    // 站点计划本身不受影响
    expect(plan.stations).toHaveLength(5)
  })

  it('单城日 intercity 为 null，旧计划字段不变', () => {
    expect(buildReplayDay(REPLAY_DAY).intercity).toBeNull()
    expect(buildReplayDay(REPLAY_DAY_EMPTY).intercity).toBeNull()
  })

  it('城际段几何不足时用当天末站坐标兜底；unavailable 不画线', () => {
    const onePoint: TripDay = {
      ...MULTICITY_DAY,
      legs: [...REPLAY_DAY.legs, { ...INTERCITY_LEG, geometry: [{ lng: 121.49, lat: 31.24 }] }],
    }
    const fallback = buildReplayDay(onePoint).intercity!
    expect(fallback.kind).toBe('straight_line')
    // 起点取当天末站，终点取 leg 几何末点；不跨天补站点、不补车次
    expect(fallback.geometry).toEqual([
      { lng: REPLAY_DAY.stops[4].location!.lng, lat: REPLAY_DAY.stops[4].location!.lat },
      { lng: 121.49, lat: 31.24 },
    ])
    expect(fallback.distanceMeters).toBe(170000)

    const unavailable: TripDay = {
      ...MULTICITY_DAY,
      legs: [...REPLAY_DAY.legs, { ...INTERCITY_LEG, route_type: 'unavailable', geometry: [], distance_m: null, duration_minutes: null }],
    }
    const plan = buildReplayDay(unavailable).intercity!
    expect(plan.kind).toBe('unavailable')
    expect(plan.distanceMeters).toBeNull()
    expect(plan.durationMinutes).toBeNull()
  })

  it('replayRouteLabel / replayNoteText 同一口径', () => {
    const plan = buildReplayDay(MULTICITY_DAY)
    expect(replayRouteLabel(plan.intercity)).toBe('城际转移（估算）')
    expect(replayNoteText('intercity')).toBe('城际转移（估算）')
    // 旧 note 文案不因重构改变
    expect(replayNoteText('navigation')).toBe('地图服务路线')
    expect(replayNoteText('no_leg')).toBe('未提供本段路线信息')
    expect(replayRouteLabel(null)).toBe('起点站，无上一段路线')
  })
})

describe('七期 S4 · 城际状态机', () => {
  const plan = buildReplayDay(MULTICITY_DAY)
  const intercityContext: ReplayContext = {
    ...CONTEXT,
    intercity: plan.intercity,
    intercityMs: 2000,
  }

  it('最后一站停留结束后进入 intercity，progress 0→1 后才 finished', () => {
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 4 }, intercityContext)
    state = play(state, intercityContext)
    state = tick(state, REPLAY_DWELL_MS, intercityContext)
    expect(state.phase).toBe('intercity')
    expect(state.stationIndex).toBe(4)
    expect(state.progress).toBe(0)

    state = tick(state, 1000, intercityContext)
    expect(state.phase).toBe('intercity')
    expect(state.progress).toBeCloseTo(0.5, 5)

    state = tick(state, 999, intercityContext)
    expect(state.phase).toBe('intercity')

    state = tick(state, 1, intercityContext)
    expect(state.phase).toBe('finished')
    expect(state.playing).toBe(false)
    expect(state.progress).toBe(0)
  })

  it('总时长包含城际段：同一时刻无城际段已 finished，有城际段仍在播', () => {
    const without = (() => {
      let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 4 }, CONTEXT)
      state = play(state)
      return tick(state, REPLAY_DWELL_MS)
    })()
    expect(without.phase).toBe('finished')

    let withIntercity = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 4 }, intercityContext)
    withIntercity = play(withIntercity, intercityContext)
    withIntercity = tick(withIntercity, REPLAY_DWELL_MS, intercityContext)
    expect(withIntercity.phase).toBe('intercity')
  })

  it('倍速作用到城际段：2x 下 1000ms 播完', () => {
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 4 }, intercityContext)
    state = reduceReplay(state, { type: 'setSpeed', speed: 2 }, intercityContext)
    state = play(state, intercityContext)
    state = tick(state, REPLAY_DWELL_MS / 2, intercityContext)
    expect(state.phase).toBe('intercity')
    state = tick(state, 1000, intercityContext)
    expect(state.phase).toBe('finished')
  })

  it('reduced-motion 跳过城际动画，最后一站停留完直接 finished', () => {
    const reduced: ReplayContext = { ...intercityContext, reducedMotion: true }
    let state = reduceReplay(INITIAL_REPLAY_STATE, { type: 'seek', index: 4 }, reduced)
    state = play(state, reduced)
    state = tick(state, REPLAY_DWELL_MS, reduced)
    expect(state.phase).toBe('finished')
  })

  it('replayIntercityMs：缺失固定 3 秒，有值按比例并夹在上下限', () => {
    expect(replayIntercityMs(null)).toBe(REPLAY_INTERCITY_MS)
    expect(replayIntercityMs(undefined)).toBe(REPLAY_INTERCITY_MS)
    expect(replayIntercityMs(Number.NaN)).toBe(REPLAY_INTERCITY_MS)
    expect(replayIntercityMs(133)).toBe(REPLAY_INTERCITY_MAX_MS)
    expect(replayIntercityMs(10)).toBe(REPLAY_INTERCITY_MIN_MS)
    expect(replayIntercityMs(50)).toBe(4000)
  })
})

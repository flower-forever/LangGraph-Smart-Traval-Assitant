/**
 * S7 · 路线回放纯逻辑（计划 §8.2）。
 *
 * 这一层只做三件事，全部可单测、零副作用：
 * 1. 把一天的 stops / legs 整理成「按站点顺序」的回放计划，明确每一段的路线类型
 *    与不可绘制原因（无坐标 / 无 leg / 后端标 unavailable / navigation 无折线）；
 * 2. 几何简化与按进度截断（限制点数，供 requestAnimationFrame 逐帧画线）；
 * 3. 回放状态机（播放 / 暂停 / 上一站 / 下一站 / 拖动 / 倍速 / 换天 / 结束），
 *    以及 prefers-reduced-motion 下的「逐站翻页」分支。
 *
 * 不做的事：不写存储、不发请求、不改行程；缺数据时宁可不画，也不补假点。
 */
import type { TravelMode, TripDay, TripLeg, TripLocation, TripStop } from './api'
import { displayTime, formatDuration, validCoord } from './format'

/** 单段折线最多保留的点数；超出按等距抽样，首尾必留。 */
export const MAX_REPLAY_GEOMETRY_POINTS = 96

export type ReplayRouteKind = 'navigation' | 'straight_line' | 'unavailable'

export type ReplayRouteNote =
  | 'navigation'
  | 'straight_line'
  | 'navigation_without_geometry'
  | 'route_unavailable'
  | 'missing_coordinate'
  | 'no_leg'
  /** 七期 S4：跨城日的收尾城际转移段（估算，班次未提供）。 */
  | 'intercity'

export interface ReplayLeg {
  kind: ReplayRouteKind
  note: ReplayRouteNote
  mode: TravelMode | null
  /** 已清洗、已简化的坐标；unavailable 时为空数组 */
  geometry: TripLocation[]
  distanceMeters: number | null
  durationMinutes: number | null
  description: string
}

export interface ReplayStation {
  index: number
  stop: TripStop
  /** 清洗后的坐标；null = 无坐标（地图不画、不移动） */
  location: TripLocation | null
  /** 进入本站的那一段；首站为 null */
  inbound: ReplayLeg | null
}

export interface ReplayDayPlan {
  day: TripDay | null
  stations: ReplayStation[]
  /** 可画的站点数 */
  drawableStopCount: number
  /** 缺坐标的站点数 */
  missingCoordCount: number
  /** 七期 S4：当天最后一条城际段；单城 / 无城际段为 null（旧时间轴）。 */
  intercity: ReplayLeg | null
}

export const EMPTY_REPLAY_PLAN: ReplayDayPlan = {
  day: null,
  stations: [],
  drawableStopCount: 0,
  missingCoordCount: 0,
  intercity: null,
}

/**
 * 等距抽样简化：点数超过上限时保留首尾，中间按固定步长取点。
 * 不改变端点，不做平滑或插值（平滑会伪造不存在的路线形状）。
 */
export function simplifyGeometry(
  points: readonly TripLocation[],
  maxPoints: number = MAX_REPLAY_GEOMETRY_POINTS,
): TripLocation[] {
  if (maxPoints < 2) return points.length > 0 ? [{ ...points[0] }] : []
  if (points.length <= maxPoints) return points.map((point) => ({ lng: point.lng, lat: point.lat }))
  const last = points.length - 1
  const stride = last / (maxPoints - 1)
  const out: TripLocation[] = []
  for (let i = 0; i < maxPoints; i += 1) {
    const point = points[Math.min(last, Math.round(i * stride))]
    out.push({ lng: point.lng, lat: point.lat })
  }
  out[0] = { ...points[0] }
  out[out.length - 1] = { ...points[last] }
  return out
}

function validGeometry(raw: readonly TripLocation[] | undefined): TripLocation[] {
  const out: TripLocation[] = []
  for (const point of raw ?? []) {
    const valid = validCoord(point)
    if (valid) out.push(valid)
  }
  return out
}

function unavailableLeg(
  note: ReplayRouteNote,
  mode: TravelMode | null,
  leg: TripLeg | null,
): ReplayLeg {
  return {
    kind: 'unavailable',
    note,
    mode,
    geometry: [],
    distanceMeters: leg?.distance_m ?? null,
    durationMinutes: leg?.duration_minutes ?? null,
    description: leg?.description ?? '',
  }
}

function resolveLeg(leg: TripLeg, from: TripLocation | null, to: TripLocation | null): ReplayLeg {
  const base = {
    mode: leg.mode,
    distanceMeters: leg.distance_m,
    durationMinutes: leg.duration_minutes,
    description: leg.description,
  }

  if (!from || !to) return unavailableLeg('missing_coordinate', leg.mode, leg)
  if (leg.route_type === 'unavailable') return unavailableLeg('route_unavailable', leg.mode, leg)

  if (leg.route_type === 'navigation') {
    const geometry = simplifyGeometry(validGeometry(leg.geometry))
    if (geometry.length >= 2) {
      return { ...base, kind: 'navigation', note: 'navigation', geometry }
    }
    // 后端标了 navigation 却没给出可用折线：按两点示意直线画，明确标注不是导航
    return {
      ...base,
      kind: 'straight_line',
      note: 'navigation_without_geometry',
      geometry: [{ ...from }, { ...to }],
    }
  }

  // straight_line：只连两端，不伪造中间形状
  return {
    ...base,
    kind: 'straight_line',
    note: 'straight_line',
    geometry: [{ ...from }, { ...to }],
  }
}

/**
 * 七期 S4：把当天最后一条城际段解析成回放段。
 * - 优先用 leg.geometry（S1 的城际段是两点直线；导航几何若存在也保留）；
 * - 几何不足 2 点时退到「当天末站坐标 → leg 几何末点」，不跨天补点；
 * - 仍无法得到两端坐标时明确 unavailable，不伪造站点或车次。
 */
function resolveIntercityLeg(leg: TripLeg, day: TripDay): ReplayLeg {
  const base = {
    mode: leg.mode,
    distanceMeters: leg.distance_m,
    durationMinutes: leg.duration_minutes,
    description: leg.description,
  }
  const geometry = simplifyGeometry(validGeometry(leg.geometry))
  if (leg.route_type !== 'unavailable' && geometry.length >= 2) {
    return {
      ...base,
      kind: leg.route_type === 'navigation' ? 'navigation' : 'straight_line',
      note: 'intercity',
      geometry,
    }
  }

  const lastStop = day.stops.length > 0 ? day.stops[day.stops.length - 1] : null
  const from = lastStop ? validCoord(lastStop.location) : null
  const lastPoint = validGeometry(leg.geometry).at(-1) ?? null
  if (
    leg.route_type !== 'unavailable' &&
    from &&
    lastPoint &&
    (from.lng !== lastPoint.lng || from.lat !== lastPoint.lat)
  ) {
    return {
      ...base,
      kind: 'straight_line',
      note: 'intercity',
      geometry: [{ ...from }, { ...lastPoint }],
    }
  }

  return { ...base, kind: 'unavailable', note: 'intercity', geometry: [] }
}

/**
 * 生成一天的回放计划。leg 必须同时匹配「上一站 → 本站」，避免把顺序错乱的
 * leg 硬套到站点上；没有匹配 leg 的站（首站除外）明确标 no_leg，不画线。
 *
 * 七期 S4：`intercity` 取当天最后一条 transferKind='intercity' 的段，单城为 null。
 */
export function buildReplayDay(day: TripDay): ReplayDayPlan {
  const stations: ReplayStation[] = []
  let drawableStopCount = 0
  let missingCoordCount = 0

  day.stops.forEach((stop, index) => {
    const location = validCoord(stop.location)
    if (location) drawableStopCount += 1
    else missingCoordCount += 1

    let inbound: ReplayLeg | null = null
    if (index > 0) {
      const previous = day.stops[index - 1]
      const leg =
        day.legs.find((item) => item.from_stop_id === previous.id && item.to_stop_id === stop.id) ?? null
      const previousLocation = validCoord(previous.location)
      inbound = leg
        ? resolveLeg(leg, previousLocation, location)
        : unavailableLeg('no_leg', null, null)
    }

    stations.push({ index, stop, location, inbound })
  })

  let intercity: ReplayLeg | null = null
  for (let index = day.legs.length - 1; index >= 0; index -= 1) {
    const leg = day.legs[index]
    if (leg.transferKind !== 'intercity') continue
    intercity = resolveIntercityLeg(leg, day)
    break
  }

  return { day, stations, drawableStopCount, missingCoordCount, intercity }
}

/* ───────────────────────── 几何截断（逐帧画线） ───────────────────────── */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 按行程长度比例截断折线：progress 0 → 只留起点；1 → 完整折线。
 * 用等距投影（经度乘 cos(纬度)）计算段长，避免高纬度横向段被严重低估。
 * 点数已由 simplifyGeometry 限制，逐帧调用是 O(96)。
 */
export function sliceGeometry(
  geometry: readonly TripLocation[],
  progress: number,
): TripLocation[] {
  if (geometry.length === 0) return []
  if (geometry.length === 1) return [{ ...geometry[0] }]
  const t = clamp01(progress)
  if (t <= 0) return [{ ...geometry[0] }]
  if (t >= 1) return geometry.map((point) => ({ ...point }))

  const refLat = (geometry[0].lat * Math.PI) / 180
  const scale = Math.cos(refLat)
  const lengths: number[] = []
  let total = 0
  for (let i = 1; i < geometry.length; i += 1) {
    const dx = (geometry[i].lng - geometry[i - 1].lng) * scale
    const dy = geometry[i].lat - geometry[i - 1].lat
    const length = Math.hypot(dx, dy)
    lengths.push(length)
    total += length
  }
  if (total <= 0) return t >= 1 ? geometry.map((point) => ({ ...point })) : [{ ...geometry[0] }]

  const target = total * t
  const out: TripLocation[] = [{ ...geometry[0] }]
  let travelled = 0
  for (let i = 0; i < lengths.length; i += 1) {
    const length = lengths[i]
    if (travelled + length <= target) {
      out.push({ ...geometry[i + 1] })
      travelled += length
      continue
    }
    const ratio = length === 0 ? 0 : (target - travelled) / length
    out.push({
      lng: geometry[i].lng + (geometry[i + 1].lng - geometry[i].lng) * ratio,
      lat: geometry[i].lat + (geometry[i + 1].lat - geometry[i].lat) * ratio,
    })
    break
  }
  return out
}

/* ───────────────────────── 状态机 ───────────────────────── */

export type ReplayPhase = 'station' | 'leg' | 'intercity' | 'finished'
export type ReplaySpeed = 1 | 1.5 | 2

export interface ReplayState {
  stationIndex: number
  phase: ReplayPhase
  playing: boolean
  speed: ReplaySpeed
  /** 当前阶段内部进度 0–1（站点停留倒计时 / 路段绘制进度） */
  progress: number
}

export const REPLAY_DWELL_MS = 2500
export const REPLAY_LEG_MS = 2600
export const REPLAY_STRAIGHT_MS = 1800
export const REPLAY_UNAVAILABLE_MS = 1200

/** 六期 S9：1 分钟行程时长 → 80ms 回放时长（固定演示节奏 → 按时长比例）。 */
export const REPLAY_MS_PER_MINUTE = 80
export const REPLAY_DWELL_MIN_MS = 1200
export const REPLAY_DWELL_MAX_MS = 4000
export const REPLAY_LEG_MIN_MS = 1000
export const REPLAY_LEG_MAX_MS = 4000
/** 七期 S4：城际段固定演示时长（leg 没有 duration_minutes 时使用）。 */
export const REPLAY_INTERCITY_MS = 3000
export const REPLAY_INTERCITY_MIN_MS = 1000
export const REPLAY_INTERCITY_MAX_MS = 6000

export interface ReplayContext {
  stationCount: number
  /** 每个站点的入站路段类型；index 0 不使用 */
  legKinds: readonly ReplayRouteKind[]
  reducedMotion: boolean
  /** 每站停留时长（ms，已按 duration_minutes 换算）；缺省 / 缺项回退 REPLAY_DWELL_MS。 */
  dwellMs?: readonly number[]
  /** 每个入站路段时长（ms）；缺省 / 缺项回退按路线类型的现状默认。 */
  legMs?: readonly number[]
  /** 七期 S4：当天城际段；缺省 / null = 旧单城时间轴，终点站停留完直接 finished。 */
  intercity?: ReplayLeg | null
  /** 城际段播放时长（ms）；缺省按 duration_minutes 换算，再缺省 REPLAY_INTERCITY_MS。 */
  intercityMs?: number
}

function clampMs(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 站点停留：有 duration_minutes 按比例换算并夹在 [1200, 4000]；缺失用现状默认。 */
export function replayDwellMs(minutes: number | null | undefined): number {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return REPLAY_DWELL_MS
  }
  return clampMs(minutes * REPLAY_MS_PER_MINUTE, REPLAY_DWELL_MIN_MS, REPLAY_DWELL_MAX_MS)
}

/** 路段时长：有 duration_minutes 按比例换算并夹在 [1000, 4000]；缺失按路线类型默认。 */
export function replayLegMs(
  minutes: number | null | undefined,
  kind: ReplayRouteKind | undefined,
): number {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return legDurationMs(kind)
  }
  return clampMs(minutes * REPLAY_MS_PER_MINUTE, REPLAY_LEG_MIN_MS, REPLAY_LEG_MAX_MS)
}

/** 城际段时长：有 duration_minutes 按比例换算并夹在 [1000, 6000]；缺失固定 3 秒。 */
export function replayIntercityMs(minutes: number | null | undefined): number {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return REPLAY_INTERCITY_MS
  }
  return clampMs(minutes * REPLAY_MS_PER_MINUTE, REPLAY_INTERCITY_MIN_MS, REPLAY_INTERCITY_MAX_MS)
}

export type ReplayAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'seek'; index: number }
  | { type: 'setSpeed'; speed: number }
  | { type: 'tick'; deltaMs: number }
  | { type: 'reset' }

export const INITIAL_REPLAY_STATE: ReplayState = {
  stationIndex: 0,
  phase: 'station',
  playing: false,
  speed: 1,
  progress: 0,
}

export function normalizeReplaySpeed(value: number): ReplaySpeed {
  if (!Number.isFinite(value)) return 1
  if (value >= 2) return 2
  if (value >= 1.5) return 1.5
  return 1
}

function legDurationMs(kind: ReplayRouteKind | undefined): number {
  if (kind === 'navigation') return REPLAY_LEG_MS
  if (kind === 'straight_line') return REPLAY_STRAIGHT_MS
  return REPLAY_UNAVAILABLE_MS
}

/**
 * 回放状态机（纯函数）。
 *
 * 时间轴：第 i 站停留（按 duration_minutes 换算，缺省 REPLAY_DWELL_MS）→
 * （非 reduced-motion）进入 leg 阶段，用该段时长（按 duration_minutes 换算，
 * 缺省按路线类型取固定值）把第 i+1 站入站路段画完 → 到第 i+1 站停留。最后一站
 * 停留结束后进入 finished。reduced-motion 时跳过 leg 阶段，停留结束直接翻到下一站。
 *
 * 七期 S4：若 context.intercity 存在且非 reduced-motion，最后一站停留结束后先播放
 * 城际转移 phase（进度 0→1，虚线由面板绘制），播完再 finished。没有城际段时状态
 * 序列与 HEAD 完全一致；reduced-motion 继续跳过所有路线动画（含城际段）。
 */
export function reduceReplay(
  state: ReplayState,
  action: ReplayAction,
  context: ReplayContext,
): ReplayState {
  const count = Math.max(0, context.stationCount)
  // reset 不依赖旧计划：从空日切回有站点的日子时必须回到第一站，而不是停在 finished
  if (action.type === 'reset') {
    return { ...INITIAL_REPLAY_STATE, speed: state.speed }
  }
  if (count === 0) {
    return { ...state, stationIndex: 0, phase: 'finished', playing: false, progress: 0 }
  }
  const lastIndex = count - 1

  switch (action.type) {
    case 'play': {
      if (state.phase === 'finished') {
        return { ...INITIAL_REPLAY_STATE, speed: state.speed, playing: true }
      }
      return { ...state, playing: true }
    }
    case 'pause':
      return state.playing ? { ...state, playing: false } : state
    case 'toggle':
      return reduceReplay(state, { type: state.playing ? 'pause' : 'play' }, context)
    case 'next': {
      if (state.stationIndex >= lastIndex) {
        return { ...state, phase: 'finished', playing: false, progress: 0 }
      }
      return { ...state, stationIndex: state.stationIndex + 1, phase: 'station', progress: 0 }
    }
    case 'prev': {
      if (state.stationIndex <= 0) {
        return { ...state, phase: 'station', progress: 0 }
      }
      return { ...state, stationIndex: state.stationIndex - 1, phase: 'station', progress: 0 }
    }
    case 'seek': {
      const index = Math.min(lastIndex, Math.max(0, Math.round(action.index)))
      return { ...state, stationIndex: index, phase: 'station', progress: 0 }
    }
    case 'setSpeed':
      return { ...state, speed: normalizeReplaySpeed(action.speed) }
    case 'tick': {
      if (!state.playing || state.phase === 'finished') return state
      const delta = Math.max(0, action.deltaMs)
      if (delta === 0) return state
      const speed = state.speed

      if (state.phase === 'station') {
        // 六期 S9：停留时长按本站 duration_minutes 比例分配；缺省回退旧固定值。
        // reduced-motion 仍只影响「是否进入 leg 阶段」，不改变计时口径。
        const dwell = (context.dwellMs?.[state.stationIndex] ?? REPLAY_DWELL_MS) / speed
        const progress = state.progress + delta / dwell
        if (progress < 1) return { ...state, progress }
        if (state.stationIndex >= lastIndex) {
          if (!context.reducedMotion && context.intercity) {
            return { ...state, phase: 'intercity', progress: 0 }
          }
          return { ...state, phase: 'finished', playing: false, progress: 0 }
        }
        if (context.reducedMotion) {
          return { ...state, stationIndex: state.stationIndex + 1, phase: 'station', progress: 0 }
        }
        return { ...state, phase: 'leg', progress: 0 }
      }

      // 七期 S4 · phase === 'intercity'：最后一站之后把城际段画完（虚线由面板决定）
      if (state.phase === 'intercity') {
        const duration =
          (context.intercityMs ?? replayIntercityMs(context.intercity?.durationMinutes)) / speed
        const progress = state.progress + delta / duration
        if (progress < 1) return { ...state, progress }
        return { ...state, phase: 'finished', playing: false, progress: 0 }
      }

      // phase === 'leg'：正在画进入 stationIndex + 1 的那一段
      const targetIndex = Math.min(lastIndex, state.stationIndex + 1)
      const duration =
        (context.legMs?.[targetIndex] ??
          legDurationMs(context.legKinds[targetIndex])) / speed
      const progress = state.progress + delta / duration
      if (progress < 1) return { ...state, progress }
      return { ...state, stationIndex: targetIndex, phase: 'station', progress: 0 }
    }
    default:
      return state
  }
}

/* ───────────────────────── 展示口径 ───────────────────────── */

/** 路段 note 的展示文案；routeReplay 与面板共用同一口径。 */
export function replayNoteText(note: ReplayRouteNote): string {
  switch (note) {
    case 'navigation':
      return '地图服务路线'
    case 'straight_line':
      return '示意直线（非导航）'
    case 'navigation_without_geometry':
      return '地图服务未返回折线，本段按示意直线显示'
    case 'route_unavailable':
      return '路线未知'
    case 'missing_coordinate':
      return '位置未知，无法绘制路线'
    case 'no_leg':
      return '未提供本段路线信息'
    case 'intercity':
      return '城际转移（估算）'
    default:
      return '路线未知'
  }
}

export function replayRouteLabel(leg: ReplayLeg | null): string {
  if (!leg) return '起点站，无上一段路线'
  return replayNoteText(leg.note)
}

export function replayTimeLabel(stop: TripStop): string {
  const time = stop.time.trim()
  return time ? displayTime(time) : '时间未知'
}

export function replayStayLabel(stop: TripStop): string {
  if (stop.duration_minutes == null || Number.isNaN(stop.duration_minutes)) return '停留未知'
  return `停留 ${formatDuration(stop.duration_minutes)}`
}

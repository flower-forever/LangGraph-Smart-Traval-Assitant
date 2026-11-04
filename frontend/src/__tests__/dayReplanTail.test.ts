/**
 * dayReplanTail 纯函数测试：请求投影 / 500 边界、冻结引用、边界 leg、mixed mode、
 * id 冲突、时间下界与未知、revision/同对象内容变化、scope 篡改、容量、deepFreeze。
 * 全部离线：不发请求、不读 Storage、不碰时间。
 */
import { describe, expect, it } from 'vitest'

import type { Trip, TripLeg, TripStop } from '../lib/api'
import {
  MAX_SAVED_TRIP_BYTES,
  checkTripShape,
} from '../lib/savedTrips'
import {
  applyDayReplan,
  validateDayReplanResponse,
  type DayReplanRequest,
  type DayReplanResponse,
  type MapStatus,
} from '../lib/dayReplan'
import {
  TAIL_AI_REPLAN_WARNING_PREFIX,
  TAIL_APPLY_NOTICE,
  TAIL_BOUNDARY_APPLIED_NOTICE,
  TAIL_BOUNDARY_LEG_DESCRIPTION,
  applyDayReplanTail,
  bindTailBoundaryResponse,
  buildDayReplanTailRequest,
  buildTailBoundaryRequest,
  composeTailPreviewDay,
  knownTailLowerBound,
  verifyTailScope,
  type DayReplanTailScope,
  type TailBoundaryCurrent,
  type TailBoundarySelection,
} from '../lib/dayReplanTail'
import {
  MAX_LEG_REFRESH_STOP_ID_LENGTH,
  type LegRefreshRequest,
  type LegRefreshResponse,
} from '../lib/legRefresh'

// ==================== 夹具 ====================

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item)
    }
    Object.freeze(value)
  }
  return value
}

function locatedStop(
  id: string,
  name: string,
  time: string,
  lng: number,
  lat: number,
  extra: Partial<TripStop> = {},
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes: 60,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location: { lng, lat },
    ...extra,
  }
}

function navLeg(from: string, to: string, a: { lng: number; lat: number }, b: { lng: number; lat: number }, mode: 'walking' | 'driving' = 'walking'): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode,
    route_type: 'navigation',
    distance_m: 900,
    duration_minutes: 12,
    geometry: [{ ...a }, { ...b }],
    description: '导航路线。',
  }
}

const REVISION = 7
const BASE_ID = 'trip-tail-1'

/** 三站日：s1(09:00+60) → s2(11:00+60) → s3(14:00+60)；legs 全 navigation。 */
function makeBase(): Trip {
  const a = locatedStop('s1', '虎丘', '09:00', 120.57, 31.33)
  const b = locatedStop('s2', '寒山寺', '11:00', 120.56, 31.31)
  const c = locatedStop('s3', '留园', '14:00', 120.59, 31.32)
  const day1 = locatedStop('d1', '拙政园', '09:00', 120.62, 31.32)
  return {
    id: BASE_ID,
    source: 'example',
    destination: '苏州',
    title: '苏州两日测试行程',
    summary: '原始摘要。',
    map_coordinate_system: 'WGS84',
    warnings: ['调整前提醒 A', '调整前提醒 B'],
    days: [
      { day: 1, date: '2026-05-01', title: '第一天', summary: '第一天摘要。', stops: [day1], legs: [] },
      {
        day: 2,
        date: '2026-05-02',
        title: '第二天',
        summary: '第二天摘要。',
        stops: [a, b, c],
        legs: [
          navLeg('s1', 's2', { lng: 120.57, lat: 31.33 }, { lng: 120.56, lat: 31.31 }),
          navLeg('s2', 's3', { lng: 120.56, lat: 31.31 }, { lng: 120.59, lat: 31.32 }, 'driving'),
        ],
      },
    ],
  }
}

function buildTail(
  base: Trip,
  instruction = '换成安静的安排。',
  anchorIndex = 1,
  day = 2,
  options: Partial<{ travel_mode: 'walking' | 'driving'; parentRevision: number }> = {},
) {
  const result = buildDayReplanTailRequest(base, day, instruction, anchorIndex, {
    travel_mode: options.travel_mode ?? 'walking',
    parentRevision: options.parentRevision ?? REVISION,
  })
  if (!result.ok) throw new Error(result.message)
  return result
}

/** 构造通过旧校验的后段候选响应（默认一个新站，ready）。 */
function tailCandidate(
  request: DayReplanRequest,
  stopId = 'new-t1',
  time = '13:00',
  status: MapStatus = 'ready',
  warnings: string[] = ['本次返回提醒：13:00 是计划时刻。'],
): DayReplanResponse {
  const coord = { lng: 120.58, lat: 31.3 }
  return {
    day: {
      day: request.day,
      date: request.date,
      title: 'AI 后段候选',
      summary: 'AI 候选摘要。',
      stops: [locatedStop(stopId, '新后段站', time, coord.lng, coord.lat)],
      legs: [],
    },
    warnings,
    map_status: status,
    parent: { trip_id: request.parent.trip_id, revision: request.parent.revision },
    source: 'agent',
  }
}

// ==================== 请求构造 ====================

describe('buildDayReplanTailRequest', () => {
  it('合并固定范围说明与用户原文；请求仍走旧投影，不带坐标/几何/scope', () => {
    const base = deepFreeze(deepClone(makeBase()))
    const snapshot = JSON.stringify(base)
    const built = buildTail(base, '换成安静的安排。', 1)
    expect(JSON.stringify(base)).toBe(snapshot)

    const { request, scope, combinedInstruction } = built
    expect(combinedInstruction).toContain('前2站已冻结')
    expect(combinedInstruction).toContain('寒山寺')
    expect(combinedInstruction.endsWith('换成安静的安排。')).toBe(true)
    expect(request.instruction).toBe(combinedInstruction)
    // 白名单投影：stops 只有文字字段
    for (const stop of request.stops) {
      expect(Object.keys(stop).sort()).toEqual(
        ['address', 'description', 'duration_minutes', 'id', 'name', 'time'].sort(),
      )
    }
    // scope 不进请求
    expect(JSON.stringify(request)).not.toContain('tripSnapshot')
    expect(scope.keptCount).toBe(2)
    expect(scope.anchorStopId).toBe('s2')
    expect(scope.anchorIndex).toBe(1)
  })

  it('合并指令超过 500 字明确失败，不截断；给出可用长度', () => {
    const base = makeBase()
    const long = '长'.repeat(470)
    const result = buildDayReplanTailRequest(base, 2, long, 1, {
      travel_mode: 'walking',
      parentRevision: REVISION,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('instruction_overflow')
      expect(result.message).toContain('没有截断')
      expect(result.message).toMatch(/只有 \d+ 字/)
    }
  })

  it('末站作锚点、单站日、锚点越界都明确失败', () => {
    const base = makeBase()
    const last = buildDayReplanTailRequest(base, 2, 'x', 2, { travel_mode: 'walking', parentRevision: REVISION })
    expect(last.ok).toBe(false)
    if (!last.ok) expect(last.reason).toBe('anchor_is_last')

    const oneStop = deepClone(base)
    oneStop.days[1] = { ...oneStop.days[1], stops: [oneStop.days[1].stops[0]], legs: [] }
    const few = buildDayReplanTailRequest(oneStop, 2, 'x', 0, { travel_mode: 'walking', parentRevision: REVISION })
    expect(few.ok).toBe(false)
    if (!few.ok) expect(few.reason).toBe('too_few_stops')

    const out = buildDayReplanTailRequest(base, 2, 'x', 99, { travel_mode: 'walking', parentRevision: REVISION })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('invalid_anchor')
  })

  it('冻结段时间下界已知时写入固定说明；未知保持 unknown 不虚构', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    // 前两站 09:00+60min、11:00+60min → 已知下界 12:00
    expect(built.lowerBound).toEqual({ known: true, minutes: 720 })
    expect(built.combinedInstruction).toContain('12:00')

    const unknown = deepClone(base)
    unknown.days[1].stops[0] = { ...unknown.days[1].stops[0], time: null as unknown as string, duration_minutes: null }
    unknown.days[1].stops[1] = { ...unknown.days[1].stops[1], duration_minutes: null }
    const builtUnknown = buildTail(unknown, 'x', 1)
    expect(builtUnknown.lowerBound).toEqual({ known: false, minutes: null })
    expect(builtUnknown.combinedInstruction).not.toContain('不应早于')
  })

  it('已知下界跨日（>=1440）明确拒绝', () => {
    const base = makeBase()
    base.days[1].stops[0] = { ...base.days[1].stops[0], time: '23:30', duration_minutes: 1440 }
    base.days[1].stops[1] = { ...base.days[1].stops[1], time: null as unknown as string, duration_minutes: null }
    const result = buildDayReplanTailRequest(base, 2, 'x', 0, { travel_mode: 'walking', parentRevision: REVISION })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('time_cross_day')
  })

  it('knownTailLowerBound：非法时间/未知停留不参与；整数停留才算', () => {
    const stops = [
      locatedStop('a', '甲', '09:00', 0, 0, { duration_minutes: 30 }),
      locatedStop('b', '乙', 'bad', 0, 0, { duration_minutes: 30 }),
      locatedStop('c', '丙', '10:00', 0, 0, { duration_minutes: null }),
      locatedStop('d', '丁', '11:00', 0, 0, { duration_minutes: 60 }),
    ]
    expect(knownTailLowerBound(stops, 4)).toEqual({ known: true, minutes: 720 })
    expect(knownTailLowerBound(stops, 1)).toEqual({ known: true, minutes: 570 })
    expect(knownTailLowerBound(stops, 3)).toEqual({ known: true, minutes: 570 })
    expect(knownTailLowerBound([], 2)).toEqual({ known: false, minutes: null })
    const noDuration = [locatedStop('a', '甲', '09:00', 0, 0, { duration_minutes: null })]
    expect(knownTailLowerBound(noDuration, 1)).toEqual({ known: false, minutes: null })
  })
})

// ==================== Scope 核对 ====================

describe('verifyTailScope', () => {
  it('同对象变更（不换引用改内容）被快照抓住', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const mutated = deepClone(base)
    mutated.days[1].stops[2].name = '原地改名'
    const check = verifyTailScope(built.scope, mutated, REVISION)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toBe('stale_scope')
  })

  it('revision 变化、trip id 变化、锚点移位都失效', () => {
    const baseA = makeBase()
    const built = buildTail(baseA, 'x', 1)

    const checkRev = verifyTailScope(built.scope, baseA, REVISION + 1)
    expect(checkRev.ok).toBe(false)

    const baseB = deepClone(baseA)
    baseB.id = 'trip-tail-other'
    const checkId = verifyTailScope(built.scope, baseB, REVISION)
    expect(checkId.ok).toBe(false)

    const moved = deepClone(baseA)
    const stops = moved.days[1].stops
    const tmp = stops[1]
    stops[1] = stops[2]
    stops[2] = tmp
    const checkAnchor = verifyTailScope(built.scope, moved, REVISION)
    expect(checkAnchor.ok).toBe(false)
  })

  it('篡改 scope 字段（结构非法）按 invalid_scope 拒绝', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const forged = { ...built.scope, keptCount: 3 } as DayReplanTailScope
    const check = verifyTailScope(forged, base, REVISION)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toBe('invalid_scope')

    const notTail = { ...built.scope, kind: 'whole' } as unknown
    const checkKind = verifyTailScope(notTail, base, REVISION)
    expect(checkKind.ok).toBe(false)
    if (!checkKind.ok) expect(checkKind.reason).toBe('invalid_scope')
  })
})

// ==================== 预览组合 ====================

describe('composeTailPreviewDay', () => {
  it('组合日：冻结前缀原引用；边界 leg 全未知不复用旧路线；组合 map_status 重新分类', () => {
    const base = makeBase()
    const built = buildTail(base, '换成安静的安排。', 1)
    const response = tailCandidate(built.request)
    const preview = composeTailPreviewDay(base, built.scope, response, REVISION)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    const day = preview.day
    // 冻结站与原对象同引用
    expect(day.stops[0]).toBe(base.days[1].stops[0])
    expect(day.stops[1]).toBe(base.days[1].stops[1])
    // 内部 leg 原引用
    expect(day.legs[0]).toBe(base.days[1].legs[0])
    // 旧跨边界 leg（s2→s3）被丢弃，不被复用
    expect(day.legs.some((leg) => leg.from_stop_id === 's2' && leg.to_stop_id === 's3')).toBe(false)
    // 边界 leg：unavailable、全未知、固定说明、mode 为新选方式
    const boundary = day.legs[1]
    expect(boundary.from_stop_id).toBe('s2')
    expect(boundary.to_stop_id).toBe('new-t1')
    expect(boundary.mode).toBe('walking')
    expect(boundary.route_type).toBe('unavailable')
    expect(boundary.distance_m).toBeNull()
    expect(boundary.duration_minutes).toBeNull()
    expect(boundary.geometry).toEqual([])
    expect(boundary.description).toBe(TAIL_BOUNDARY_LEG_DESCRIPTION)
    // 后段候选内部数据保留
    expect(day.stops[2].id).toBe('new-t1')
    expect(day.legs).toHaveLength(2)
    expect(day.stops).toHaveLength(3)
    // 组合 map_status：boundary unavailable → partial（不拿旧前段地图冒充）
    expect(preview.mapStatus).toBe('partial')
    // 预览说明覆盖衔接未知与时间下界
    expect(preview.notices.join('\n')).toContain('未重算')
    expect(preview.notices.join('\n')).toContain('12:00')
  })

  it('mixed mode 合法：冻结段 driving leg 原样保留，不被改写', () => {
    const base = deepClone(makeBase())
    // 四站日：s1→s2 driving、s2→s3 walking；锚点 index 1（保留 2 站），冻结段含 driving leg
    base.days[1].stops = [
      ...base.days[1].stops,
      locatedStop('s4', '网师园', '16:00', 120.6, 31.33),
    ]
    base.days[1].legs = [
      navLeg('s1', 's2', { lng: 120.57, lat: 31.33 }, { lng: 120.56, lat: 31.31 }, 'driving'),
      navLeg('s2', 's3', { lng: 120.56, lat: 31.31 }, { lng: 120.59, lat: 31.32 }, 'walking'),
      navLeg('s3', 's4', { lng: 120.59, lat: 31.32 }, { lng: 120.6, lat: 31.33 }),
    ]
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-mix')
    const preview = composeTailPreviewDay(base, built.scope, response, REVISION)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    // 冻结段 driving leg 原引用保留
    expect(preview.day.legs[0]).toBe(base.days[1].legs[0])
    expect(preview.day.legs[0].mode).toBe('driving')
    expect(preview.day.legs[1].route_type).toBe('unavailable')
    // 旧 s2→s3 walking leg 不复用
    expect(preview.day.legs.some((leg) => leg.from_stop_id === 's2' && leg.to_stop_id === 's3')).toBe(false)
  })

  it('候选 id 与冻结段冲突 / 与其它天冲突 / 空后段 / 组合超 8 站都拒绝且不改原对象', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const snapshot = JSON.stringify(base)

    const conflictFrozen = composeTailPreviewDay(base, built.scope, tailCandidate(built.request, 's1'), REVISION)
    expect(conflictFrozen.ok).toBe(false)
    if (!conflictFrozen.ok) expect(conflictFrozen.reason).toBe('tail_id_conflict')

    const conflictOther = composeTailPreviewDay(base, built.scope, tailCandidate(built.request, 'd1'), REVISION)
    expect(conflictOther.ok).toBe(false)
    if (!conflictOther.ok) expect(conflictOther.reason).toBe('cross_day_id_conflict')

    const empty = tailCandidate(built.request, 'new-empty', '13:00', 'unavailable')
    empty.day.stops[0] = { ...empty.day.stops[0], location: null }
    empty.day.stops = []
    empty.day.legs = []
    const emptyResult = composeTailPreviewDay(base, built.scope, empty, REVISION)
    expect(emptyResult.ok).toBe(false)
    if (!emptyResult.ok) expect(emptyResult.reason).toBe('empty_tail')

    // 组合超 8 站：冻结 2 站 + 候选 7 站 = 9。
    // 候选日先过旧校验：7 站全无坐标 + unavailable 相邻链 + map_status=unavailable。
    const many = tailCandidate(built.request, 'new-many', '13:00', 'unavailable')
    const tailStops = [locatedStop('new-many', '新后段站', '13:00', 0, 0)]
    tailStops[0] = { ...tailStops[0], location: null }
    for (let i = 0; i < 6; i += 1) {
      tailStops.push({ ...locatedStop(`extra-${i}`, `第${i}站`, '15:00', 0, 0), location: null })
    }
    many.day.stops = tailStops
    many.day.legs = tailStops.slice(0, -1).map((stop, i) => ({
      from_stop_id: stop.id,
      to_stop_id: tailStops[i + 1].id,
      mode: 'walking' as const,
      route_type: 'unavailable' as const,
      distance_m: null,
      duration_minutes: null,
      geometry: [],
      description: '未获取。',
    }))
    const manyResult = composeTailPreviewDay(base, built.scope, many, REVISION)
    expect(manyResult.ok).toBe(false)
    if (!manyResult.ok) {
      expect(manyResult.reason).toBe('too_many_combined_stops')
      expect(manyResult.message).toContain('不会丢弃站点')
    }
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it('坏信封（无坐标但 map_status=ready）被旧校验拒绝', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const bad = tailCandidate(built.request)
    bad.day.stops[0] = { ...bad.day.stops[0], location: null }
    const result = composeTailPreviewDay(base, built.scope, bad, REVISION)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_response')
  })

  it('新后段时刻明确早于可知下界拒绝；恰好等于下界不拒绝；未知下界不拒绝', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const early = tailCandidate(built.request, 'new-e1', '11:59')
    const earlyResult = composeTailPreviewDay(base, built.scope, early, REVISION)
    expect(earlyResult.ok).toBe(false)
    if (!earlyResult.ok) {
      expect(earlyResult.reason).toBe('time_conflict')
      expect(earlyResult.message).toContain('11:59')
    }
    // 恰好等于下界不拒绝
    const equal = tailCandidate(built.request, 'new-e2', '12:00')
    const equalResult = composeTailPreviewDay(base, built.scope, equal, REVISION)
    expect(equalResult.ok).toBe(true)

    const unknownBase = deepClone(base)
    unknownBase.days[1].stops[0] = { ...unknownBase.days[1].stops[0], time: null as unknown as string, duration_minutes: null }
    unknownBase.days[1].stops[1] = { ...unknownBase.days[1].stops[1], duration_minutes: null }
    const builtUnknown = buildTail(unknownBase, 'x', 1)
    const anytime = tailCandidate(builtUnknown.request, 'new-a1', '00:01')
    const anytimeResult = composeTailPreviewDay(unknownBase, builtUnknown.scope, anytime, REVISION)
    expect(anytimeResult.ok).toBe(true)
    if (anytimeResult.ok) {
      expect(anytimeResult.notices.join('\n')).toContain('无法推算衔接时刻下界')
    }
  })
})

// ==================== 应用 ====================

describe('applyDayReplanTail', () => {
  function applyTail(
    base: Trip,
    built: ReturnType<typeof buildTail>,
    response: DayReplanResponse,
    currentRevision = REVISION,
    forkTripId = 'trip-tail-fork-1',
  ) {
    return applyDayReplanTail({
      baseTrip: base,
      scope: built.scope,
      response,
      currentRevision,
      forkTripId,
    })
  }

  it('成功：其它日原引用不变、冻结段原引用恢复、摘要/生成头准确', () => {
    const base = makeBase()
    const built = buildTail(base, '换成安静的安排。', 1)
    const response = tailCandidate(built.request, 'new-apply1', '13:00', 'ready', [
      '本次返回提醒一：占位时间。',
      '本次返回提醒二：地图降级。',
    ])
    const snapshot = JSON.stringify(base)
    const result = applyTail(base, built, response)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(base)).toBe(snapshot)
    if (!result.ok) return

    const trip = result.trip
    expect(trip.id).toBe('trip-tail-fork-1')
    expect(trip.source).toBe('example')
    // 其它日原引用
    expect(trip.days[0]).toBe(base.days[0])
    // 组合日：冻结段原引用 + 边界 + 候选
    const day = trip.days[1]
    expect(day.stops[0]).toBe(base.days[1].stops[0])
    expect(day.stops[1]).toBe(base.days[1].stops[1])
    expect(day.legs[0]).toBe(base.days[1].legs[0])
    expect(day.legs[1].route_type).toBe('unavailable')
    expect(day.stops[2].id).toBe('new-apply1')
    // 摘要准确
    expect(trip.summary).toContain('前 2 站原样保留')
    expect(trip.summary).toContain('仅之后按 AI 候选替换')
    expect(trip.summary).toContain('衔接路线未重算')
    expect(trip.summary).toContain('不会自动保存')
    expect(day.title).toContain('前2站原样')
    expect(day.summary).toContain('仅之后按 AI 候选替换')
    // 生成头：后段头，说明保留前2站；调整前提醒段仍准确
    expect(trip.warnings[0]).toContain(TAIL_AI_REPLAN_WARNING_PREFIX)
    expect(trip.warnings[0]).toContain('前 2 站原样保留')
    expect(trip.warnings[0]).toContain('其余天沿用原安排')
    expect(trip.warnings).toContain(
      '【调整前提醒】以下 2 条是本次 AI 调整前已有的提醒，原文保留、尚未重新核对；它们既不能当成仍然成立，也不能当成已经排除。',
    )
    expect(trip.warnings).toContain('调整前提醒 A')
    expect(trip.warnings).toContain('调整前提醒 B')
    expect(result.changedDays).toEqual([2])
    expect(result.tail.keptCount).toBe(2)
    expect(result.tail.combinedMapStatus).toBe('partial')
    // R2 回归：旧 unknown 路径 notice 必须逐字 = 旧 TAIL_APPLY_NOTICE 原文
    // （含「衔接路线未重算」字样），不得被 navigation 文案替换或改写。
    expect(result.notices[0]).toBe(TAIL_APPLY_NOTICE)
    expect(result.notices[0]).toBe(
      'AI 后段候选只应用到当前副本：前段站点与路线原样保留，衔接路线未重算；不会自动保存，也不代表已核实预约、营业状态或实时交通。',
    )
    expect(result.notices).not.toContain(TAIL_BOUNDARY_APPLIED_NOTICE)
  })

  it('oldResponse warnings 超上限时省略计数准确（旧提醒整段省略是既有行为）', () => {
    const base = makeBase()
    base.warnings = Array.from({ length: 40 }, (_, i) => `调整前提醒 第${i + 1}条`)
    const built = buildTail(base, 'x', 1)
    // 响应 warnings 上限 40：39 条新提醒 + 2 个头 + 省略行 > 40
    const response = tailCandidate(built.request, 'new-w1', '13:00', 'ready', [
      ...Array.from({ length: 39 }, (_, i) => `本次返回提醒 ${i + 1}`),
    ])
    const result = applyTail(base, built, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip.warnings.length).toBeLessThanOrEqual(40)
    // 39 新 + 40 旧放不下：新提醒保留 38 条、旧提醒整段省略，计数必须准确
    expect(result.keptNewWarnings).toBe(38)
    expect(result.omittedNewWarnings).toBe(1)
    expect(result.keptOldWarnings).toBe(0)
    expect(result.omittedOldWarnings).toBe(40)
    const omission = result.trip.warnings.find((w) => w.startsWith('【提醒省略】'))
    expect(omission).toContain('省略1条本次返回提醒/40条调整前提醒')
    expect(result.omittedWarnings).toBe(41)
  })

  it('以模板字眼开头的用户提醒不被误删（放得下时原文保留）', () => {
    const base = makeBase()
    base.warnings = [
      '【AI后段调整】用户自己写的提醒，不是模板，必须保留。',
      '【提醒省略】用户模仿的省略行，也不是模板。',
      '调整前提醒 A',
    ]
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-u1', '13:00', 'ready', ['本次返回提醒一。'])
    const result = applyTail(base, built, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip.warnings).toContain('【AI后段调整】用户自己写的提醒，不是模板，必须保留。')
    expect(result.trip.warnings).toContain('【提醒省略】用户模仿的省略行，也不是模板。')
    expect(result.trip.warnings).toContain('调整前提醒 A')
  })

  it('二次应用：旧后段头按完整模板摘掉，用户提醒保留', () => {
    const base = makeBase()
    const built1 = buildTail(base, '第一次。', 1)
    const response1 = tailCandidate(built1.request, 'new-r1', '13:00')
    const first = applyTail(base, built1, response1)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const afterFirst = first.trip

    const built2 = buildTail(afterFirst, '第二次。', 1)
    const response2 = tailCandidate(built2.request, 'new-r2', '13:30')
    const second = applyTail(afterFirst, built2, response2, REVISION, 'trip-tail-fork-2')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const headers = second.trip.warnings.filter((w) => w.startsWith(TAIL_AI_REPLAN_WARNING_PREFIX))
    // 只剩一条后段头
    expect(headers).toHaveLength(1)
    expect(second.trip.warnings).toContain('调整前提醒 A')
  })

  it('stale revision / 同对象变更 / 篡改 scope：拒绝且绝不落回整天替换', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-s1')

    const stale = applyTail(base, built, response, REVISION + 1)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toBe('stale_scope')

    const mutated = deepClone(base)
    mutated.summary = '原地改了摘要'
    const staleContent = applyDayReplanTail({
      baseTrip: mutated,
      scope: built.scope,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-tail-fork-2',
    })
    expect(staleContent.ok).toBe(false)
    if (!staleContent.ok) expect(staleContent.reason).toBe('stale_scope')

    const forged = { ...built.scope, keptCount: 3 } as DayReplanTailScope
    const invalid = applyDayReplanTail({
      baseTrip: base,
      scope: forged,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-tail-fork-3',
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.reason).toBe('invalid_scope')
  })

  it('容量：组合后超 640KiB 拒绝且不裁 geometry', () => {
    // 其它 6 天各带约 2800 点几何（base 约 580KB < 640KB），候选 4000 点推过上限
    const bigPoint = { lng: 120.123456, lat: 31.123456 }
    const bigTrip: Trip = {
      ...deepClone(makeBase()),
      days: [
        deepClone(makeBase().days[0]),
        deepClone(makeBase().days[1]),
        ...Array.from({ length: 6 }, (_, d) => ({
          day: d + 3,
          date: null,
          title: `第${d + 3}天`,
          summary: '',
          stops: [
            locatedStop(`a${d}`, '甲', '09:00', 120.5, 31.3),
            locatedStop(`b${d}`, '乙', '10:00', 120.5, 31.3),
          ],
          legs: [
            {
              from_stop_id: `a${d}`,
              to_stop_id: `b${d}`,
              mode: 'walking' as const,
              route_type: 'navigation' as const,
              distance_m: 900,
              duration_minutes: 12,
              geometry: Array.from({ length: 2800 }, () => ({ ...bigPoint })),
              description: '长路线。',
            },
          ],
        })),
      ],
    }
    const shape = checkTripShape(bigTrip)
    expect(shape.ok).toBe(true)
    const baseBytes = JSON.stringify(bigTrip).length
    expect(baseBytes).toBeLessThan(MAX_SAVED_TRIP_BYTES)

    const built = buildTail(bigTrip, 'x', 1, 2)
    const response = tailCandidate(built.request, 'new-big', '13:00')
    response.day.stops = [
      response.day.stops[0],
      locatedStop('new-big-2', '乙二', '14:00', 120.5, 31.3),
    ]
    response.day.legs = [
      {
        from_stop_id: 'new-big',
        to_stop_id: 'new-big-2',
        mode: 'walking',
        route_type: 'navigation',
        distance_m: 900,
        duration_minutes: 12,
        geometry: Array.from({ length: 4000 }, () => ({ ...bigPoint })),
        description: '大。',
      },
    ]
    const result = applyDayReplanTail({
      baseTrip: bigTrip,
      scope: built.scope,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-big-fork',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('capacity_exceeded')
      expect(result.message).toContain('没有被改动或截断')
    }
    // 原 Trip 不动
    expect(JSON.stringify(bigTrip).length).toBe(baseBytes)
  })

  it('deepFreeze 输入全程纯：预览与应用都不修改冻结对象', () => {
    const base = deepFreeze(deepClone(makeBase()))
    const built = buildTail(base, '冻结输入。', 1)
    const response = tailCandidate(built.request, 'new-f1', '13:00')
    const preview = composeTailPreviewDay(base, built.scope, response, REVISION)
    expect(preview.ok).toBe(true)
    const result = applyTail(base, built, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip.days[1].stops[0].name).toBe('虎丘')
    expect(result.trip.days[0]).toBe(base.days[0])
  })

  it('fork id 非法拒绝', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-k1')
    const same = applyTail(base, built, response, REVISION, base.id)
    expect(same.ok).toBe(false)
    if (!same.ok) expect(same.reason).toBe('invalid_fork_id')
  })

  it('与旧整天 apply 互不混淆：tail scope 不会被旧 apply 消费成整天', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-m1', '13:00')
    // 旧 apply 用同样的 request/response 会整日替换（候选日只有 1 站），
    // 新 apply 必须保留冻结段——两者结果不同，证明没有混用路径。
    const oldResult = applyDayReplan({
      baseTrip: base,
      request: built.request,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-old-fork',
    })
    expect(oldResult.ok).toBe(true)
    if (!oldResult.ok) return
    expect(oldResult.trip.days[1].stops).toHaveLength(1)

    const tailResult = applyTail(base, built, response)
    expect(tailResult.ok).toBe(true)
    if (!tailResult.ok) return
    expect(tailResult.trip.days[1].stops).toHaveLength(3)
    expect(tailResult.trip.days[1].stops[0].name).toBe('虎丘')
  })

  it('冻结段旧链缺失/端点错位：明确拒绝且不持久化坏链', () => {
    const base = deepClone(makeBase())
    // 缺失冻结段内部 leg（前 2 站需要 1 段）：组合会拼出坏链，必须拒
    const missingLeg = deepClone(base)
    missingLeg.days[1].legs = [missingLeg.days[1].legs[1]]
    const builtMissing = buildTail(missingLeg, 'x', 1)
    const respMissing = tailCandidate(builtMissing.request, 'new-bad1')
    const previewMissing = composeTailPreviewDay(missingLeg, builtMissing.scope, respMissing, REVISION)
    expect(previewMissing.ok).toBe(false)
    if (!previewMissing.ok) expect(previewMissing.reason).toBe('invalid_base_day')

    // 端点错位（leg from/to 不对应站点顺序）
    const crossed = deepClone(base)
    const originalSnapshot = JSON.stringify(base)
    crossed.days[1].legs = [
      { ...crossed.days[1].legs[0], from_stop_id: 's3' },
      crossed.days[1].legs[1],
    ]
    const builtCrossedBaseSnapshot = JSON.stringify(crossed)
    const builtCrossed = buildTail(crossed, 'x', 1)
    const respCrossed = tailCandidate(builtCrossed.request, 'new-bad2')
    const applyCrossed = applyDayReplanTail({
      baseTrip: crossed,
      scope: builtCrossed.scope,
      response: respCrossed,
      currentRevision: REVISION,
      forkTripId: 'trip-bad-chain',
    })
    expect(applyCrossed.ok).toBe(false)
    if (!applyCrossed.ok) expect(applyCrossed.reason).toBe('invalid_base_day')
    // 拒绝后 crossed 自身没有被重排或修复；原始 base 也未被触碰
    expect(JSON.stringify(crossed)).toBe(builtCrossedBaseSnapshot)
    expect(JSON.stringify(base)).toBe(originalSnapshot)
  })

  it('旧链 leg 数多于前缀：只取前 keptCount-1 段并校验端点，不报错也不重排', () => {
    const base = deepClone(makeBase())
    // 保持原有 2 段 legs 不动，这是既有合法宽形态：链校验只看前缀端点
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-wide', '13:00')
    const preview = composeTailPreviewDay(base, built.scope, response, REVISION)
    expect(preview.ok).toBe(true)
  })

  it('组合日全无坐标时 map_status 仍是 unavailable，不冒 partial', () => {
    const base = deepClone(makeBase())
    // 前缀两站全部无坐标
    base.days[1].stops[0] = { ...base.days[1].stops[0], location: null }
    base.days[1].stops[1] = { ...base.days[1].stops[1], location: null }
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-nocoord', '13:00', 'unavailable')
    response.day.stops[0] = { ...response.day.stops[0], location: null }
    response.day.legs = []
    const preview = composeTailPreviewDay(base, built.scope, response, REVISION)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.mapStatus).toBe('unavailable')
  })

  it('scope 请求指纹被篡改或请求 parent 与 tripId 不一致：invalid_scope 拒绝', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const forgedRequest = { ...built.scope.request, instruction: '被换过的指令' }
    const forgedScope = { ...built.scope, request: forgedRequest } as DayReplanTailScope
    const check = verifyTailScope(forgedScope, base, REVISION)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toBe('invalid_scope')

    // request.parent.trip_id 与 tripId 不一致
    const badParent = {
      ...built.scope,
      request: { ...built.scope.request, parent: { trip_id: 'other-trip', revision: REVISION } },
    } as DayReplanTailScope
    const checkParent = verifyTailScope(badParent, base, REVISION)
    expect(checkParent.ok).toBe(false)
    if (!checkParent.ok) expect(checkParent.reason).toBe('invalid_scope')
  })

  it('apply 传入 request 与 scope 记录不一致时 request_mismatch 拒绝；一致时成功', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-rm1', '13:00')
    const mismatched = { ...built.request, instruction: '另一份请求' }
    const bad = applyDayReplanTail({
      baseTrip: base,
      scope: built.scope,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-rm-bad',
      request: mismatched,
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('request_mismatch')

    const good = applyDayReplanTail({
      baseTrip: base,
      scope: built.scope,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-rm-good',
      request: built.request,
    })
    expect(good.ok).toBe(true)
  })

  it('preview 用当前 revision 核对：revision 变了预览也作废（不再自比自）', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-rev', '13:00')
    // 内容相同、只递增 revision：预览必须失败（此前用 scope.revision 自比自会通过）
    const stale = composeTailPreviewDay(base, built.scope, response, REVISION + 1)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toBe('stale_scope')
    // 当前 revision 相等时通过
    const fresh = composeTailPreviewDay(base, built.scope, response, REVISION)
    expect(fresh.ok).toBe(true)
  })

  it('currentRevision 必填：缺失/NaN/Infinity/负数/非整数/非数值都 invalid_revision，不回退 scope.revision', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-crm', '13:00')
    const invalidRevisions: unknown[] = [
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
      '7',
      true,
    ]
    for (const invalid of invalidRevisions) {
      const result = composeTailPreviewDay(
        base,
        built.scope,
        response,
        invalid as number,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('invalid_revision')
    }
    // 即使 scope.revision 与内容都匹配，也不能拿 scope.revision 兜底
    expect(built.scope.revision).toBe(REVISION)
  })

  it('仅 revision 变、内容相同的候选不能通过 apply 落回（invalid_revision 口径与预览一致）', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-arv', '13:00')
    for (const invalid of [undefined, Number.NaN, -3, 2.5] as unknown[]) {
      const result = applyDayReplanTail({
        baseTrip: base,
        scope: built.scope,
        response,
        currentRevision: invalid as number,
        forkTripId: 'trip-invalid-rev',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('invalid_revision')
    }
    expect(JSON.stringify(base)).toBe(JSON.stringify(makeBase()))
  })

  it('响应 parent 与请求 revision 不匹配被旧校验拒绝', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-p1')
    response.parent = { trip_id: built.request.parent.trip_id, revision: REVISION + 5 }
    const result = applyTail(base, built, response)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_response')
  })
})

// 静态检查：确保 validateDayReplanResponse 被显式引用（后段路径依赖它）
expect(typeof validateDayReplanResponse).toBe('function')

// ==================== 边界衔接路线（Wave 2：owner + 纯组合） ====================

const BOUNDARY_EPOCHS = { contentEpoch: 1, inputEpoch: 2, boundaryEpoch: 3 }

/** 与生成时 state 一致的 current（独立于 owner，模拟 Panel/App 实时读值）。 */
function boundaryCurrent(
  base: Trip,
  built: ReturnType<typeof buildTail>,
  response: DayReplanResponse,
  overrides: Partial<TailBoundaryCurrent> = {},
): TailBoundaryCurrent {
  return {
    trip: base,
    candidate: response,
    scope: built.scope,
    revision: REVISION,
    contentEpoch: BOUNDARY_EPOCHS.contentEpoch,
    inputEpoch: BOUNDARY_EPOCHS.inputEpoch,
    boundaryEpoch: BOUNDARY_EPOCHS.boundaryEpoch,
    ...overrides,
  }
}

/** 构造一个有效的边界请求 owner（请求时刻基准）。 */
function buildBoundary(
  base: Trip,
  built: ReturnType<typeof buildTail>,
  response: DayReplanResponse,
  currentOverrides: Partial<TailBoundaryCurrent> = {},
) {
  const result = buildTailBoundaryRequest(
    base,
    built.scope,
    response,
    REVISION,
    boundaryCurrent(base, built, response, currentOverrides),
  )
  if (!result.ok) throw new Error(`buildTailBoundaryRequest 应成功：${result.message}`)
  return result
}

/** 构造与请求精确 echo 的 ready LegRefreshResponse（形状由 F validator 保证）。 */
function legReadyResponse(
  request: LegRefreshRequest,
  overrides: {
    distance?: number
    duration?: number | null
    geometry?: Array<{ lng: number; lat: number }>
    description?: string
  } = {},
): LegRefreshResponse {
  const geometry = overrides.geometry ?? [
    { lng: request.from_stop.location.lng, lat: request.from_stop.location.lat },
    { lng: request.to_stop.location.lng, lat: request.to_stop.location.lat },
  ]
  return {
    parent: { ...request.parent },
    day: request.day,
    date: request.date,
    travel_mode: request.travel_mode,
    from_stop: { id: request.from_stop.id, location: { ...request.from_stop.location } },
    to_stop: { id: request.to_stop.id, location: { ...request.to_stop.location } },
    map_status: 'ready',
    leg: {
      from_stop_id: request.from_stop.id,
      to_stop_id: request.to_stop.id,
      mode: request.travel_mode,
      route_type: 'navigation',
      distance_m: overrides.distance ?? 900,
      duration_minutes: overrides.duration !== undefined ? overrides.duration : 12,
      geometry,
      description:
        overrides.description ??
        '按两端记录的 WGS84 坐标向高德地图查询步行衔接段；未重新核对地址或地点身份，几何为路网吸附结果，端点坐标未改写。',
    },
    reason: null,
    source: { provider: 'amap', coordinate_system: 'WGS84', endpoint: '/v5/direction/walking' },
    checked_at: '2026-11-04T15:00:00+00:00',
  }
}

/** 绑定一个有效 selection（请求 + ready 响应）。 */
function bindBoundary(
  base: Trip,
  built: ReturnType<typeof buildTail>,
  response: DayReplanResponse,
  legOverrides?: Parameters<typeof legReadyResponse>[1],
): TailBoundarySelection {
  const { owner, request } = buildBoundary(base, built, response)
  const bound = bindTailBoundaryResponse(
    owner,
    request,
    legReadyResponse(request, legOverrides),
    boundaryCurrent(base, built, response),
  )
  if (!bound.ok) throw new Error(`bindTailBoundaryResponse 应成功：${bound.message}`)
  return bound.selection
}

describe('buildTailBoundaryRequest', () => {
  it('构造六字段白名单请求：parent=scope、day/date/mode=scope、两端 id 与 WGS84 原值；owner 捕获快照与引用', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-bd1', '13:00')
    const snapshot = JSON.stringify(base)
    const result = buildBoundary(base, built, response)

    const request = result.request
    expect(Object.keys(request).sort()).toEqual(
      ['date', 'day', 'from_stop', 'parent', 'to_stop', 'travel_mode'].sort(),
    )
    expect(request.parent).toEqual({ trip_id: built.scope.tripId, revision: built.scope.revision })
    expect(request.day).toBe(built.scope.day)
    expect(request.date).toBe(built.scope.date)
    expect(request.travel_mode).toBe(built.scope.travelMode)
    // 锚点 = 冻结段最后一站实际 id/坐标；首站 = 候选首站实际 id/坐标（恒等映射，不改名）
    expect(request.from_stop.id).toBe('s2')
    expect(request.from_stop.location).toEqual(base.days[1].stops[1].location)
    expect(request.to_stop.id).toBe('new-bd1')
    expect(request.to_stop.location).toEqual(response.day.stops[0].location)
    // owner 捕获当前引用与完整快照（trip / 候选 / scope 三份）
    expect(result.owner.trip).toBe(base)
    expect(result.owner.candidate).toBe(response)
    expect(result.owner.scope).toBe(built.scope)
    expect(result.owner.anchorStop).toBe(base.days[1].stops[1])
    expect(result.owner.tailFirstStop).toBe(response.day.stops[0])
    expect(result.owner.tripSnapshot).toBe(snapshot)
    expect(result.owner.candidateSnapshot).toBe(JSON.stringify(response))
    expect(result.owner.scopeSnapshot).toBe(JSON.stringify(built.scope))
    expect(result.owner.request).toBe(request)
    expect(result.owner.captured).toEqual(BOUNDARY_EPOCHS)
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it('current 形状非法/负数/NaN/非安全整数 epoch 拒绝（fail closed，不跳过）', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-bd2')
    const badEpochs: Array<Partial<TailBoundaryCurrent>> = [
      { contentEpoch: -1 },
      { inputEpoch: Number.NaN },
      { boundaryEpoch: 1.5 },
      { contentEpoch: Number.POSITIVE_INFINITY },
      { revision: -2 },
      { revision: Number.NaN },
    ]
    for (const overrides of badEpochs) {
      const result = buildTailBoundaryRequest(
        base,
        built.scope,
        response,
        REVISION,
        boundaryCurrent(base, built, response, overrides),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('invalid_boundary_input')
    }
    // 缺失 current / current 断裂（与实参不是同一对象）都拒绝
    for (const brokenCurrent of [
      undefined,
      null,
      {},
      boundaryCurrent(deepClone(base), built, response),
      boundaryCurrent(base, built, deepClone(response)),
    ] as unknown[]) {
      const result = buildTailBoundaryRequest(
        base,
        built.scope,
        response,
        REVISION,
        brokenCurrent as TailBoundaryCurrent,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('invalid_boundary_input')
    }
  })

  it('缺坐标不能查询（null 不是 0）：锚点/首站任一缺都明确失败；合法 0 可用', () => {
    // 锚点缺坐标：候选响应需与缺坐标组合日自洽（candidate map_status=unavailable 且坐标 null）
    const noAnchor = deepClone(makeBase())
    noAnchor.days[1].stops[1] = { ...noAnchor.days[1].stops[1], location: null }
    const builtNoAnchor = buildTail(noAnchor, 'x', 1)
    const respNoAnchor = tailCandidate(builtNoAnchor.request, 'new-bd3', '13:00', 'unavailable')
    respNoAnchor.day.stops[0] = { ...respNoAnchor.day.stops[0], location: null }
    respNoAnchor.day.legs = []
    const r1 = buildTailBoundaryRequest(
      noAnchor, builtNoAnchor.scope, respNoAnchor, REVISION,
      boundaryCurrent(noAnchor, builtNoAnchor, respNoAnchor),
    )
    expect(r1.ok).toBe(false)
    if (!r1.ok) {
      expect(r1.reason).toBe('missing_boundary_location')
      expect(r1.message).toContain('寒山寺')
    }

    // 首站缺坐标：组合仍合法（unavailable 链），只是查询被禁
    const noTail = deepClone(makeBase())
    const builtNoTail = buildTail(noTail, 'x', 1)
    const respNoTail = tailCandidate(builtNoTail.request, 'new-bd3', '13:00', 'unavailable')
    respNoTail.day.stops[0] = { ...respNoTail.day.stops[0], location: null }
    respNoTail.day.legs = []
    const r2 = buildTailBoundaryRequest(
      noTail, builtNoTail.scope, respNoTail, REVISION,
      boundaryCurrent(noTail, builtNoTail, respNoTail),
    )
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toBe('missing_boundary_location')

    // 合法 0 坐标可用
    const zero = deepClone(makeBase())
    const builtZero = buildTail(zero, 'x', 1)
    const respZero = tailCandidate(builtZero.request, 'new-bd3')
    respZero.day.stops[0] = { ...respZero.day.stops[0], location: { lng: 0, lat: 0 } }
    const r3 = buildTailBoundaryRequest(
      zero, builtZero.scope, respZero, REVISION,
      boundaryCurrent(zero, builtZero, respZero),
    )
    expect(r3.ok).toBe(true)
    if (r3.ok) expect(r3.request.to_stop.location).toEqual({ lng: 0, lat: 0 })
  })

  it('锚点 id 超过 replan 投影 100 字上限时候选生成已拒绝；101-200 字 id 属导入路径，构造阶段同样拒绝', () => {
    // 后段请求投影本身限 100 字：超长锚点 id 在 buildDayReplanTailRequest 就失败，不会产生 scope。
    const base100 = deepClone(makeBase())
    base100.days[1].stops[1] = { ...base100.days[1].stops[1], id: 'L'.repeat(101) }
    const overProjection = buildDayReplanTailRequest(base100, 2, 'x', 1, {
      travel_mode: 'walking',
      parentRevision: REVISION,
    })
    expect(overProjection.ok).toBe(false)
    if (!overProjection.ok) expect(overProjection.reason).toBe('invalid_stop')

    // 衔接接口口径与 replan 一致（都 100）：构造期防御性拒绝，不改名/截断，可仅应用后段。
    const built = buildTail(makeBase(), 'x', 1)
    const response = tailCandidate(built.request, 'new-bd4')
    const forgedAnchor = {
      ...built.scope,
      anchorStopId: 'L'.repeat(MAX_LEG_REFRESH_STOP_ID_LENGTH + 1),
    } as DayReplanTailScope
    // scope 对象被伪造后与 verifyTailScope 既有字段仍自洽（锚点校验按 anchorIndex 站点 id），
    // 真正拦住的是 buildLegRefreshRequest 对 id 的白名单校验。
    const result = buildTailBoundaryRequest(
      makeBase(), forgedAnchor, response, REVISION,
      { ...boundaryCurrent(makeBase(), built, response), scope: forgedAnchor },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(['invalid_boundary_input', 'invalid_scope', 'invalid_boundary_stop_id', 'stale_scope']).toContain(result.reason)
    }
  })

  it('scope 是唯一模式来源：篡改 scope.request.travel_mode 或 scope.travelMode 都拒绝', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-bd5')
    // requestSnapshot 已不再匹配（含 travel_mode），verifyTailScope 先拒绝
    const forgedRequest = {
      ...built.scope,
      request: { ...built.scope.request, travel_mode: 'driving' },
    } as DayReplanTailScope
    const r1 = buildTailBoundaryRequest(
      base, forgedRequest, response, REVISION,
      { ...boundaryCurrent(base, built, response), scope: forgedRequest },
    )
    expect(r1.ok).toBe(false)
    // 直接伪造 scope.travelMode 与 request.travel_mode 不一致
    const forgedMode = { ...built.scope, travelMode: 'driving' } as DayReplanTailScope
    const r2 = buildTailBoundaryRequest(
      base, forgedMode, response, REVISION,
      { ...boundaryCurrent(base, built, response), scope: forgedMode },
    )
    expect(r2.ok).toBe(false)
  })
})

describe('bindTailBoundaryResponse', () => {
  it('ready 精确 echo 绑定成功；typed 失败（no_key 等）不产生 selection', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-bn1')
    const { owner, request } = buildBoundary(base, built, response)

    const ok = bindTailBoundaryResponse(
      owner, request, legReadyResponse(request),
      boundaryCurrent(base, built, response),
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.selection.owner).toBe(owner)
      expect(ok.selection.request).toBe(request)
      expect(ok.selection.response.map_status).toBe('ready')
      expect(ok.selection.response.leg?.route_type).toBe('navigation')
    }

    const readyShape = legReadyResponse(request)
    const failed: LegRefreshResponse = {
      ...readyShape,
      map_status: 'no_key',
      leg: null,
      reason: '服务端未配置高德地图 Key，本次未执行任何路线查询。',
    }
    const rejected = bindTailBoundaryResponse(owner, request, failed, boundaryCurrent(base, built, response))
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe('boundary_not_ready')
  })

  it('请求期间上下文变化拒绝：epoch 推进/引用换新/revision 变/原地改', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-bn2')
    const { owner, request } = buildBoundary(base, built, response)
    const ready = legReadyResponse(request)

    // epoch 推进后（含 A→B→A 回不到旧值）不等于 captured
    const advanced = bindTailBoundaryResponse(
      owner, request, ready,
      boundaryCurrent(base, built, response, { boundaryEpoch: BOUNDARY_EPOCHS.boundaryEpoch + 1 }),
    )
    expect(advanced.ok).toBe(false)
    if (!advanced.ok) expect(advanced.reason).toBe('invalid_boundary')

    // 同内容换 trip 引用
    const clonedTrip = bindTailBoundaryResponse(
      owner, request, ready,
      boundaryCurrent(base, built, response, { trip: deepClone(base) }),
    )
    expect(clonedTrip.ok).toBe(false)

    // 同内容换候选引用
    const clonedResp = bindTailBoundaryResponse(
      owner, request, ready,
      boundaryCurrent(base, built, response, { candidate: deepClone(response) }),
    )
    expect(clonedResp.ok).toBe(false)

    // revision 推进
    const stale = bindTailBoundaryResponse(
      owner, request, ready,
      boundaryCurrent(base, built, response, { revision: REVISION + 1 }),
    )
    expect(stale.ok).toBe(false)

    // trip 原地改（引用同、内容变）：快照核对拒绝；改完还原不影响判定
    const before = JSON.stringify(base)
    base.summary = '原地改'
    const mutatedResult = bindTailBoundaryResponse(owner, request, ready, boundaryCurrent(base, built, response))
    base.summary = '原始摘要。'
    expect(JSON.stringify(base)).toBe(before)
    expect(mutatedResult.ok).toBe(false)
  })

  it('响应 echo 漂移拒绝：端点坐标/id/day/date/mode 任意一处与请求不一致都不绑定', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-bn3')
    const { owner, request } = buildBoundary(base, built, response)
    const current = boundaryCurrent(base, built, response)

    const drifted = legReadyResponse(request)
    drifted.from_stop = {
      id: request.from_stop.id,
      location: { lng: request.from_stop.location.lng + 0.0000001, lat: request.from_stop.location.lat },
    }
    expect(bindTailBoundaryResponse(owner, request, drifted, current).ok).toBe(false)

    const badId = legReadyResponse(request)
    badId.to_stop = { ...badId.to_stop, id: 'other-id' }
    expect(bindTailBoundaryResponse(owner, request, badId, current).ok).toBe(false)

    const badDay = legReadyResponse(request)
    badDay.day = request.day + 1
    expect(bindTailBoundaryResponse(owner, request, badDay, current).ok).toBe(false)

    const badDate = legReadyResponse(request)
    badDate.date = request.date === null ? '2026-05-02' : null
    expect(bindTailBoundaryResponse(owner, request, badDate, current).ok).toBe(false)

    const badMode = legReadyResponse(request)
    badMode.travel_mode = 'driving'
    expect(bindTailBoundaryResponse(owner, request, badMode, current).ok).toBe(false)
  })

  it('ready 但 leg 形状非法（非 navigation/geometry<2/负距离/leg 端点漂移）拒绝', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-bn4')
    const { owner, request } = buildBoundary(base, built, response)
    const current = boundaryCurrent(base, built, response)

    const straight = legReadyResponse(request)
    ;(straight.leg as { route_type: string }).route_type = 'straight_line'
    expect(bindTailBoundaryResponse(owner, request, straight, current).ok).toBe(false)

    const shortGeometry = legReadyResponse(request, { geometry: [{ lng: 120, lat: 30 }] })
    expect(bindTailBoundaryResponse(owner, request, shortGeometry, current).ok).toBe(false)

    const negative = legReadyResponse(request, { distance: -1 })
    expect(bindTailBoundaryResponse(owner, request, negative, current).ok).toBe(false)

    const legDrift = legReadyResponse(request)
    ;(legDrift.leg as { from_stop_id: string }).from_stop_id = 'other'
    expect(bindTailBoundaryResponse(owner, request, legDrift, current).ok).toBe(false)
  })
})

describe('composeTailPreviewDay / applyDayReplanTail（boundary）', () => {
  it('预览：边界 leg 变 navigation，其余原引用；notices 明确来源；合法 0 距离与未知耗时不混淆', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-pv1', '13:00', 'ready', [
      '本次返回提醒：地图降级说明保留。',
    ])
    const selection = bindBoundary(base, built, response, { distance: 0, duration: null })
    const snapshot = JSON.stringify(base)
    const preview = composeTailPreviewDay(
      base, built.scope, response, REVISION, selection,
      boundaryCurrent(base, built, response),
    )
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    const day = preview.day
    expect(day.stops[0]).toBe(base.days[1].stops[0])
    expect(day.stops[1]).toBe(base.days[1].stops[1])
    expect(day.legs[0]).toBe(base.days[1].legs[0])
    const boundary = day.legs[1]
    expect(boundary.route_type).toBe('navigation')
    expect(boundary.from_stop_id).toBe('s2')
    expect(boundary.to_stop_id).toBe('new-pv1')
    expect(boundary.mode).toBe(built.scope.travelMode)
    expect(boundary.distance_m).toBe(0)
    expect(boundary.duration_minutes).toBeNull()
    expect(boundary.geometry).toEqual(selection.response.leg?.geometry)
    expect(boundary.description).toBe(selection.response.leg?.description)
    expect(day.legs).toHaveLength(2)
    // 组合 map_status：前缀与候选 ready + 边界 navigation → ready（不再 partial）
    expect(preview.mapStatus).toBe('ready')
    // notices：不再说“未重算”，说明按记录坐标取得、未核对地点身份
    const notices = preview.notices.join('\n')
    expect(notices).not.toContain('未重算')
    expect(notices).toContain('按两端记录坐标')
    expect(notices).toContain('未核对地点身份')
    // R2 回归：navigation 预览不得携带旧 unknown 的 TAIL_APPLY_NOTICE 原文
    expect(preview.notices).not.toContain(TAIL_APPLY_NOTICE)
    expect(preview.notices[0]).toContain(TAIL_BOUNDARY_APPLIED_NOTICE.slice(0, 30))
    // 用户自由文本中“未重算”不被误删的护栏：这里断言的是本模块自动文案，不前缀扫描用户提醒
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it('预览传 boundary 不传 current：invalid_boundary_input；失效 selection 绝不当 unknown', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-pv2')
    const selection = bindBoundary(base, built, response)

    const noCurrent = composeTailPreviewDay(base, built.scope, response, REVISION, selection)
    expect(noCurrent.ok).toBe(false)
    if (!noCurrent.ok) expect(noCurrent.reason).toBe('invalid_boundary_input')

    // current epoch 推进后传同一 selection：拒绝（不静默降级 unknown）
    const advanced = composeTailPreviewDay(
      base, built.scope, response, REVISION, selection,
      boundaryCurrent(base, built, response, { boundaryEpoch: BOUNDARY_EPOCHS.boundaryEpoch + 7 }),
    )
    expect(advanced.ok).toBe(false)
    if (!advanced.ok) expect(advanced.reason).toBe('invalid_boundary')

    // current 与实参错配（换 trip 引用）拒绝
    const mismatch = composeTailPreviewDay(
      base, built.scope, response, REVISION, selection,
      boundaryCurrent(base, built, response, { trip: deepClone(base) }),
    )
    expect(mismatch.ok).toBe(false)
  })

  it('应用：只换跨界 leg；摘要不再说未重算；boundaryKind=navigation；前缀/候选内部/其他天保真', () => {
    const base = makeBase()
    const built = buildTail(base, '换成安静的安排。', 1)
    const response = tailCandidate(built.request, 'new-ap1', '13:00', 'ready', [
      '本次返回提醒一：占位时间。',
    ])
    const selection = bindBoundary(base, built, response, { distance: 1234, duration: 18 })
    const snapshot = JSON.stringify(base)
    const result = applyDayReplanTail({
      baseTrip: base,
      scope: built.scope,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-boundary-fork-1',
      boundary: selection,
      current: boundaryCurrent(base, built, response),
    })
    expect(result.ok).toBe(true)
    expect(JSON.stringify(base)).toBe(snapshot)
    if (!result.ok) return

    const trip = result.trip
    const day = trip.days[1]
    expect(trip.days[0]).toBe(base.days[0])
    expect(day.stops[0]).toBe(base.days[1].stops[0])
    expect(day.stops[1]).toBe(base.days[1].stops[1])
    expect(day.legs[0]).toBe(base.days[1].legs[0])
    const boundary = day.legs[1]
    expect(boundary.route_type).toBe('navigation')
    expect(boundary.distance_m).toBe(1234)
    expect(boundary.duration_minutes).toBe(18)
    // 导航 leg 是复制，不把外部对象塞进 Trip
    expect(boundary).not.toBe(selection.response.leg)
    expect(boundary.geometry).not.toBe(selection.response.leg?.geometry)
    expect(day.legs).toHaveLength(2)
    // 摘要/notice：采用路径不再说“未重算”
    expect(trip.summary).not.toContain('未重算')
    expect(trip.summary).toContain('按两端记录坐标')
    expect(result.notices.join('\n')).not.toContain('未重算')
    expect(result.notices.join('\n')).toContain('按两端记录坐标')
    // R2 回归：navigation 应用不携带旧 unknown 的 TAIL_APPLY_NOTICE 原文
    expect(result.notices).toContain(TAIL_BOUNDARY_APPLIED_NOTICE)
    expect(result.notices).not.toContain(TAIL_APPLY_NOTICE)
    expect(result.tail.boundaryKind).toBe('navigation')
    // 头模板：仍是既有后段头（不新增 warnings 模板）
    expect(trip.warnings[0]).toContain(TAIL_AI_REPLAN_WARNING_PREFIX)
    expect(result.changedDays).toEqual([2])
  })

  it('失效 selection 应用整次失败保旧：epoch 推进/换引用/缺 current 都不落回 unknown', () => {
    const base = makeBase()
    const built = buildTail(base, 'x', 1)
    const response = tailCandidate(built.request, 'new-ap2')
    const selection = bindBoundary(base, built, response)
    const snapshot = JSON.stringify(base)
    const input = {
      baseTrip: base,
      scope: built.scope,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-boundary-fork-2',
      boundary: selection,
    }
    const staleEpoch = applyDayReplanTail({
      ...input,
      current: boundaryCurrent(base, built, response, { contentEpoch: BOUNDARY_EPOCHS.contentEpoch + 1 }),
    })
    expect(staleEpoch.ok).toBe(false)
    if (!staleEpoch.ok) expect(staleEpoch.reason).toBe('invalid_boundary')

    const swapped = applyDayReplanTail({
      ...input,
      current: boundaryCurrent(base, built, response, { candidate: deepClone(response) }),
    })
    expect(swapped.ok).toBe(false)

    const noCurrent = applyDayReplanTail(input)
    expect(noCurrent.ok).toBe(false)
    if (!noCurrent.ok) expect(noCurrent.reason).toBe('invalid_boundary_input')
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it('交替重复：unknown→navigation→unknown→navigation，头不嵌套、用户自写同前缀提醒保留', () => {
    let tripState = deepClone(makeBase())
    tripState.warnings = [
      '【AI后段调整】用户自己写的提醒，不是模板，必须保留。',
      '调整前提醒 A',
    ]

    // 第 1 次：unknown
    let built = buildTail(tripState, '第一次。', 1)
    let response = tailCandidate(built.request, 'alt-1', '13:00')
    let applied = applyDayReplanTail({
      baseTrip: tripState, scope: built.scope, response,
      currentRevision: REVISION, forkTripId: 'alt-fork-1',
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    tripState = applied.trip
    expect(applied.tail.boundaryKind).toBe('unavailable')
    expect(tripState.summary).toContain('衔接路线未重算')
    // R2 回归：旧 unknown 应用的 notice 逐字 = 旧 TAIL_APPLY_NOTICE 原文（含“衔接路线未重算”）
    expect(applied.notices[0]).toBe(TAIL_APPLY_NOTICE)
    expect(applied.notices[0]).toContain('衔接路线未重算')
    expect(applied.notices[0]).not.toBe(TAIL_BOUNDARY_APPLIED_NOTICE)

    // 第 2 次：navigation（基于新行程重新生成）
    const stateAfterUnknown = tripState
    built = buildTail(stateAfterUnknown, '第二次。', 1)
    response = tailCandidate(built.request, 'alt-2', '13:30')
    const selection = bindBoundary(stateAfterUnknown, built, response)
    applied = applyDayReplanTail({
      baseTrip: stateAfterUnknown, scope: built.scope, response,
      currentRevision: REVISION, forkTripId: 'alt-fork-2',
      boundary: selection,
      current: boundaryCurrent(stateAfterUnknown, built, response),
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    tripState = applied.trip
    expect(applied.tail.boundaryKind).toBe('navigation')
    expect(tripState.summary).not.toContain('未重算')
    // R2 回归：navigation 应用的 notice 是独立新 notice，不携带旧“未重算”常量
    expect(applied.notices).toContain(TAIL_BOUNDARY_APPLIED_NOTICE)
    expect(applied.notices).not.toContain(TAIL_APPLY_NOTICE)
    for (const notice of applied.notices) {
      expect(notice).not.toContain('衔接路线未重算')
    }
    // 模板头恰好 1 条；用户自写同前缀提醒不算模板头（probe 证据：共 2 条同前缀）
    expect(tripState.warnings.filter((w) => /^【AI后段调整】第\d+天前 \d+ 站原样保留/.test(w))).toHaveLength(1)

    // 第 3 次：unknown
    const stateAfterNav = tripState
    built = buildTail(stateAfterNav, '第三次。', 1)
    response = tailCandidate(built.request, 'alt-3', '14:00')
    applied = applyDayReplanTail({
      baseTrip: stateAfterNav, scope: built.scope, response,
      currentRevision: REVISION, forkTripId: 'alt-fork-3',
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    tripState = applied.trip
    expect(tripState.summary).toContain('未重算')

    // 第 4 次：navigation
    const stateAfterUnknown2 = tripState
    built = buildTail(stateAfterUnknown2, '第四次。', 1)
    response = tailCandidate(built.request, 'alt-4', '14:30')
    const selection4 = bindBoundary(stateAfterUnknown2, built, response)
    applied = applyDayReplanTail({
      baseTrip: stateAfterUnknown2, scope: built.scope, response,
      currentRevision: REVISION, forkTripId: 'alt-fork-4',
      boundary: selection4,
      current: boundaryCurrent(stateAfterUnknown2, built, response),
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    tripState = applied.trip

    // 头不嵌套：整个流程只有 1 条【AI后段调整】模板头；用户自写同前缀提醒不算模板头、仍保留
    const templateHeaders = tripState.warnings.filter((w) =>
      /^【AI后段调整】第\d+天前 \d+ 站原样保留，之后已按 AI 候选替换/.test(w),
    )
    expect(templateHeaders).toHaveLength(1)
    expect(templateHeaders[0]).toContain('前 2 站原样保留')
    const tailPrefix = tripState.warnings.filter((w) => w.startsWith('【AI后段调整】'))
    expect(tailPrefix).toHaveLength(2) // 模板头 + 用户自写一条
    expect(tripState.warnings).toContain('【AI后段调整】用户自己写的提醒，不是模板，必须保留。')
    expect(tripState.warnings).toContain('调整前提醒 A')
  })

  it('容量：navigation 边界推过全行程几何预算 → capacity_exceeded 且说明几何超预算、保旧', () => {
    // 基础行程体积小（短文本），6 天 × 4999 点（单段 5000 上限内）+ day2 的 4 点 = 29998；
    // 加候选内部 1 段 4999 点 + 边界 leg 4999 点 = 39996；候选再加 1 段 5 点 → 40001 > 40000。
    // 序列化体积仍 < 640 KiB，确保失败原因是几何预算而不是体积。
    const bigGeometry = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        lng: Number((120.56 + ((120.58 - 120.56) * i) / (count - 1)).toFixed(6)),
        lat: Number((31.31 + ((31.3 - 31.31) * i) / (count - 1)).toFixed(6)),
      }))
    // 体积最小坐标（{lng:1,lat:1} ≈ 15B/点）：只喂 checkTripShape 的点数与字节数，
    // 不参与衔接路线（plausible 检查只针对 boundary leg，filler/候选 leg 无此约束）。
    const tinyGeometry = (count: number) =>
      Array.from({ length: count }, () => ({ lng: 1, lat: 1 }))
    const bigTrip: Trip = {
      ...deepClone(makeBase()),
      summary: '',
      title: 't',
      days: [
        // 额外一天（两站一小段 3 点）：用于把总点数顶过 40000，同时让 checkTripShape 基础态合法
        {
          day: 10,
          date: null,
          title: 'd10',
          summary: '',
          stops: [locatedStop('p1', '甲', '09:00', 120.5, 31.3), locatedStop('p2', '乙', '10:00', 120.5, 31.3)],
          legs: [
            {
              from_stop_id: 'p1',
              to_stop_id: 'p2',
              mode: 'walking' as const,
              route_type: 'navigation' as const,
              distance_m: 100,
              duration_minutes: 2,
              geometry: tinyGeometry(6),
              description: '',
            },
          ],
        },
        { ...deepClone(makeBase().days[0]), summary: '', title: 'd0', stops: deepClone(makeBase().days[0].stops).map((s) => ({ ...s, description: '', address: '' })) },
        {
          ...deepClone(makeBase().days[1]),
          summary: '',
          title: 'd2',
          stops: deepClone(makeBase().days[1].stops).map((s) => ({ ...s, description: '', address: '' })),
        },
        ...Array.from({ length: 6 }, (_, d) => ({
          day: d + 4,
          date: null,
          title: `d${d + 4}`,
          summary: '',
          stops: [
            locatedStop(`a${d}`, '甲', '09:00', 120.5, 31.3),
            locatedStop(`b${d}`, '乙', '10:00', 120.5, 31.3),
          ],
          legs: [
            {
              from_stop_id: `a${d}`,
              to_stop_id: `b${d}`,
              mode: 'walking' as const,
              route_type: 'navigation' as const,
              distance_m: 900,
              duration_minutes: 12,
              geometry: tinyGeometry(4_999),
              description: '',
            },
          ],
        })),
      ],
    }
    bigTrip.warnings = []
    bigTrip.days.forEach((day) => {
      day.stops.forEach((stop) => {
        stop.description = ''
        stop.address = ''
        stop.name = stop.id
      })
    })
    expect(checkTripShape(bigTrip)).toEqual({ ok: true })
    const built = buildTail(bigTrip, 'x', 1, 2)
    const response = tailCandidate(built.request, 'new-big2', '13:00')
    response.day.stops = [
      { ...response.day.stops[0] },
      locatedStop('new-big2b', '乙二', '14:00', 120.59, 31.31),
    ]
    response.day.legs = [
      {
        from_stop_id: 'new-big2',
        to_stop_id: 'new-big2b',
        mode: 'walking',
        route_type: 'navigation',
        distance_m: 900,
        duration_minutes: 12,
        geometry: [...tinyGeometry(4_993), { lng: 120.6, lat: 31.32 }, { lng: 120.61, lat: 31.33 }, { lng: 120.62, lat: 31.34 }, { lng: 120.63, lat: 31.35 }, { lng: 120.64, lat: 31.36 }, { lng: 120.65, lat: 31.37 }],
        description: '大。',
      },
    ]
    const selection = bindBoundary(bigTrip, built, response, {
      geometry: bigGeometry(5_000),
    })
    const baseSnapshot = JSON.stringify(bigTrip)
    const result = applyDayReplanTail({
      baseTrip: bigTrip,
      scope: built.scope,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-big-fork-2',
      boundary: selection,
      current: boundaryCurrent(bigTrip, built, response),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('capacity_exceeded')
      expect(result.message).toContain('几何点')
      expect(result.message).toContain('没有被改动或截断')
    }
    expect(JSON.stringify(bigTrip)).toBe(baseSnapshot)
  })
})


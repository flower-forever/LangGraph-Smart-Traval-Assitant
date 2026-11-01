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
  TAIL_BOUNDARY_LEG_DESCRIPTION,
  applyDayReplanTail,
  buildDayReplanTailRequest,
  composeTailPreviewDay,
  knownTailLowerBound,
  verifyTailScope,
  type DayReplanTailScope,
} from '../lib/dayReplanTail'

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

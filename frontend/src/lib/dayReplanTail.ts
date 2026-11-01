/**
 * AI 后段重规划（「某站之后」）的前端纯函数契约。
 *
 * 边界：
 * - 独立于 dayReplan.ts 的应用逻辑：请求仍由旧 buildDayReplanRequest 构造（白名单文字
 *   投影，不带坐标 / 几何 / scope 快照），不新增任何后端字段或 DTO；服务端并不知道
 *   「后段范围」，它照常生成整个目标日候选，冻结前段与拼接完全由本模块在客户端完成。
 * - Scope 只存在于前端会话：记录 trip id / revision / 完整内容快照 / day / date /
 *   锚点 id 与序号 / 请求与输入指纹。无法序列化时 fail closed；trip 内容（含同对象
 *   变更）、revision、锚点、输入任何变化都使请求与预览失效，A→B→A 不复活。
 * - 模型返回的整个 Day 候选就是「新后段」：不按锚点索引盲切模型数组、不信模型自己
 *   保留前段、不按名字或坐标去重。候选先过旧 validateDayReplanResponse，再做后段
 *   特有检查（至少 1 个新站、组合 ≤ 8 站、id 不与冻结段 / 其它天冲突、保守时间下界）。
 * - 冻结前段的站点与内部路段尽量保留原对象引用；旧跨边界 leg 永不复用，唯一新建的
 *   衔接 leg 是 unavailable 且距离 / 耗时 / 几何全未知，不造直线、不按未知补 0。
 * - 时间只按用户已填的合法 HH:MM 与合法整数停留做保守下界：未知保持未知并明示；
 *   新后段时刻明确早于可知下界、或下界已跨日时明确拒绝，不改任何时刻。
 * - 应用前再次核对 scope / 信封 / 组合结构，后验 checkTripShape 与 640 KB 容量；
 *   任何失败原 Trip 与所有输入保持不变。提醒沿用旧 apply 的 40 条组合与准确省略
 *   计数，只改写本次生成的分段头，不前缀扫描用户文案（旧的后段头按完整模板摘除）。
 * - 所有操作纯：不读 Storage、不发请求、不碰 crypto / 时间；deepFreeze 的输入不会被
 *   修改。是否应用、何时生成由调用方显式触发。
 */

import type { TravelMode, Trip, TripDay, TripLeg, TripStop } from './api'
import {
  AI_REPLAN_WARNING_PREFIX,
  DAY_REPLAN_WARNINGS_NOTICE,
  MAX_REPLAN_INSTRUCTION_LENGTH,
  MAX_REPLAN_STOPS_PER_DAY,
  applyDayReplan,
  buildDayReplanRequest,
  classifyDayMapStatus,
  validateDayReplanResponse,
  type BuildDayReplanOptions,
  type DayReplanApplyFailureReason,
  type DayReplanBuildFailureReason,
  type DayReplanRequest,
  type DayReplanResponse,
  type MapStatus,
} from './dayReplan'
import { MAX_SAVED_TRIP_BYTES, checkTripShape, savedTripRecordBytes } from './savedTrips'

// ==================== 常量 ====================

/** 可见分段标记：只由本模块按完整模板生成；摘除旧头时用完整正则，不做前缀匹配。 */
export const TAIL_AI_REPLAN_WARNING_PREFIX = '【AI后段调整】'
/** 唯一新建的跨锚点衔接 leg 的固定说明。 */
export const TAIL_BOUNDARY_LEG_DESCRIPTION = '衔接路线未重算，需另行核对。'
export const TAIL_APPLY_NOTICE =
  'AI 后段候选只应用到当前副本：前段站点与路线原样保留，衔接路线未重算；不会自动保存，也不代表已核实预约、营业状态或实时交通。'

/** 与 dayReplan.ts 同一口径的合法站点时间。 */
const TAIL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 只认本模块写出的完整后段头模板：重新应用时先按完整模板摘掉旧的一组，
 * 用户自己写的任何提醒（即使以相同字眼开头）都不是模板，不会被删除。
 */
const TAIL_AI_HEADER_PATTERN =
  /^【AI后段调整】第\d+天前 \d+ 站原样保留，之后已按 AI 候选替换(?:，其余天沿用原安排)?。(?:从下一条起是本次候选返回的提醒（含占位时间与地图降级说明）(?:；再后面的「调整前提醒」是调整前已有的内容，尚未重新核对)?。|本次候选没有返回额外提醒；后面的「调整前提醒」是调整前已有的内容，尚未重新核对。|本次候选没有返回额外提醒。)本次应用不会自动保存，也不代表已核实预约、营业状态或实时交通。$/

// ==================== Scope ====================

/** 后段范围令牌：只在客户端会话中存在，不进请求额外字段、不进 Trip、不进 Storage。 */
export interface DayReplanTailScope {
  kind: 'tail'
  tripId: string
  /** 构造请求时的父行程版本；应用时还必须与界面当前 revision 相等。 */
  revision: number
  /** 完整内容快照：同对象变更也会被它抓住。 */
  tripSnapshot: string
  day: number
  date: string | null
  anchorStopId: string
  anchorIndex: number
  /** 冻结保留的站数 = anchorIndex + 1。 */
  keptCount: number
  request: DayReplanRequest
  requestSnapshot: string
  /** 用户原始指令（不拼固定说明），用于输入指纹比对。 */
  userInstruction: string
  travelMode: TravelMode
  travelers: number | null
}

// ==================== 请求构造 ====================

export type DayReplanTailBuildFailureReason =
  | DayReplanBuildFailureReason
  | 'too_few_stops'
  | 'invalid_anchor'
  | 'anchor_is_last'
  | 'instruction_overflow'
  | 'time_cross_day'
  | 'scope_not_serializable'

export interface DayReplanTailBuildFailure {
  ok: false
  reason: DayReplanTailBuildFailureReason
  message: string
}

export interface DayReplanTailBuildSuccess {
  ok: true
  request: DayReplanRequest
  scope: DayReplanTailScope
  /** 实际发出去的合并指令（固定范围说明 + 用户原文）。 */
  combinedInstruction: string
  /** 冻结段可知结束下界；未知时 known=false。 */
  lowerBound: TailLowerBound
}

export type DayReplanTailBuildResult = DayReplanTailBuildSuccess | DayReplanTailBuildFailure

export interface TailLowerBound {
  known: boolean
  /** 已知时为当日分钟数（0..1439，≥1440 已被跨日检查拒绝）。 */
  minutes: number | null
}

function tailBuildFailure(
  reason: DayReplanTailBuildFailureReason,
  message: string,
): DayReplanTailBuildFailure {
  return { ok: false, reason, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** 预览/应用必需的当前 revision：缺失、NaN/Infinity、负数、非整数、非数值都无效。 */
function isValidCurrentRevision(value: unknown): value is number {
  return isInteger(value) && value >= 0
}

function isValidClock(value: unknown): value is string {
  return typeof value === 'string' && TAIL_TIME_PATTERN.test(value)
}

function isKnownDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1440
}

function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * 冻结段（前 keptCount 站）的可知结束下界：只有合法 HH:MM 且已知合法整数停留
 * 才算可知；未知时间 / 停留不参与，也不按 0 补齐。
 */
export function knownTailLowerBound(stops: readonly TripStop[], keptCount: number): TailLowerBound {
  let maxEnd: number | null = null
  for (let index = 0; index < keptCount && index < stops.length; index += 1) {
    const stop = stops[index]
    if (!isRecord(stop)) continue
    if (!isValidClock(stop.time)) continue
    if (!isKnownDuration(stop.duration_minutes)) continue
    const [h, m] = stop.time.split(':')
    const end = Number(h) * 60 + Number(m) + stop.duration_minutes
    if (maxEnd === null || end > maxEnd) maxEnd = end
  }
  return { known: maxEnd !== null, minutes: maxEnd }
}

/** 找目标日；缺失或重复返回 null（重复日在旧 build 里也会失败，这里先兜住）。 */
function findTargetDay(trip: Trip, day: number): TripDay | null {
  if (!isRecord(trip) || !Array.isArray(trip.days)) return null
  const matches = trip.days.filter((item) => isRecord(item) && item.day === day)
  return matches.length === 1 ? (matches[0] as TripDay) : null
}

/**
 * 构造后段模式请求：固定范围说明 + 用户原文合并成一条现有 instruction（合计 ≤ 500，
 * 溢出明确失败并给出可用长度，不截字）；请求本身仍由旧 buildDayReplanRequest 投影
 * 完整目标日文字上下文。同时生成可核对的 scope。
 */
export function buildDayReplanTailRequest(
  baseTrip: Trip,
  day: number,
  userInstruction: string,
  anchorIndex: number,
  options: BuildDayReplanOptions,
): DayReplanTailBuildResult {
  const baseDay = findTargetDay(baseTrip, day)
  if (!baseDay || !Array.isArray(baseDay.stops)) {
    return tailBuildFailure('unknown_day', `当前行程里没有第 ${day} 天，未发起 AI 调整。`)
  }
  if (baseDay.stops.length < 2) {
    return tailBuildFailure(
      'too_few_stops',
      `第 ${day} 天只有 ${baseDay.stops.length} 个站点，没有可替换的后段；后段模式至少需要 2 个站点。未发起 AI 调整。`,
    )
  }
  if (!isInteger(anchorIndex) || anchorIndex < 0 || anchorIndex >= baseDay.stops.length) {
    return tailBuildFailure('invalid_anchor', '锚点站序号无效，未发起 AI 调整。')
  }
  if (anchorIndex === baseDay.stops.length - 1) {
    return tailBuildFailure(
      'anchor_is_last',
      '锚点不能是最后一个站点：末站之后没有可替换的内容。请选择更早的站点，未发起 AI 调整。',
    )
  }
  const anchor = baseDay.stops[anchorIndex]
  if (!isRecord(anchor) || typeof anchor.id !== 'string' || typeof anchor.name !== 'string') {
    return tailBuildFailure('invalid_anchor', '锚点站数据不完整，未发起 AI 调整。')
  }
  if (typeof userInstruction !== 'string' || userInstruction.trim().length === 0) {
    return tailBuildFailure('invalid_instruction', '请先填写想怎么调整这一天的后段，未发起 AI 调整。')
  }

  const keptCount = anchorIndex + 1
  const lowerBound = knownTailLowerBound(baseDay.stops, keptCount)
  if (lowerBound.known && (lowerBound.minutes as number) >= 1440) {
    return tailBuildFailure(
      'time_cross_day',
      `冻结前段按已填时间与停留推算，已知结束下界已跨入次日（${minutesToClock((lowerBound.minutes as number) - 1440)} 之后）；后段无法在同一日内接续。未发起 AI 调整，也没有改动任何时刻。`,
    )
  }

  const maxNewStops = MAX_REPLAN_STOPS_PER_DAY - keptCount
  const fixedParts = [
    `【后段重规划】只生成锚点「${anchor.name}」之后的新站点：前${keptCount}站已冻结、由客户端原样保留，不要输出冻结段；最多${maxNewStops}个新站点。`,
  ]
  if (lowerBound.known) {
    fixedParts.push(
      `新后段开始时刻不应早于 ${minutesToClock(lowerBound.minutes as number)}（按已填时间与停留推算，未计入衔接交通）。`,
    )
  }
  const fixedInstruction = `${fixedParts.join('')}用户调整要求：`
  const combinedInstruction = `${fixedInstruction}${userInstruction}`
  if (combinedInstruction.length > MAX_REPLAN_INSTRUCTION_LENGTH) {
    return tailBuildFailure(
      'instruction_overflow',
      `后段范围说明固定占用 ${fixedInstruction.length} 字，留给你的指令只有 ${MAX_REPLAN_INSTRUCTION_LENGTH - fixedInstruction.length} 字，当前写了 ${userInstruction.length} 字；这次没有截断，未发起 AI 调整。`,
    )
  }

  const built = buildDayReplanRequest(baseTrip, day, combinedInstruction, options)
  if (!built.ok) return built

  let tripSnapshot: string
  let requestSnapshot: string
  try {
    tripSnapshot = JSON.stringify(baseTrip)
    requestSnapshot = JSON.stringify(built.request)
  } catch {
    return tailBuildFailure(
      'scope_not_serializable',
      '当前行程无法序列化成快照，无法安全记录后段范围；未发起 AI 调整。',
    )
  }

  const scope: DayReplanTailScope = {
    kind: 'tail',
    tripId: baseTrip.id,
    revision: options.parentRevision,
    tripSnapshot,
    day,
    date: baseDay.date,
    anchorStopId: anchor.id,
    anchorIndex,
    keptCount,
    request: built.request,
    requestSnapshot,
    userInstruction,
    travelMode: options.travel_mode,
    travelers: options.travelers ?? null,
  }
  return { ok: true, request: built.request, scope, combinedInstruction, lowerBound }
}

// ==================== Scope 核对 ====================

export interface TailScopeInputs {
  userInstruction: string
  travelMode: TravelMode
  travelers: number | null
}

export type TailScopeCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid_scope' | 'stale_scope'; message: string }

function scopeProblem(
  reason: 'invalid_scope' | 'stale_scope',
  message: string,
): TailScopeCheck {
  return { ok: false, reason, message }
}

/** 面板侧输入指纹：指令 / 方式 / 人数任一变化即失效。 */
export function tailScopeInputsMatch(scope: DayReplanTailScope, inputs: TailScopeInputs): boolean {
  return (
    scope.userInstruction === inputs.userInstruction &&
    scope.travelMode === inputs.travelMode &&
    scope.travelers === inputs.travelers
  )
}

/**
 * 核对 scope 与当前行程 / 版本仍一致：结构非法返回 invalid_scope；trip id、revision、
 * 完整内容快照（同对象变更也逃不掉）、请求指纹、目标日 / 日期、锚点仍在原序号上任一
 * 不符返回 stale_scope。序列化失败一律按失效处理，不猜。
 */
export function verifyTailScope(scope: unknown, trip: Trip, revision: number): TailScopeCheck {
  if (!isRecord(scope) || scope.kind !== 'tail') {
    return scopeProblem('invalid_scope', '后段范围记录不完整或不是后段范围，无法应用。')
  }
  if (
    typeof scope.tripId !== 'string' ||
    !isInteger(scope.revision) ||
    typeof scope.tripSnapshot !== 'string' ||
    !isInteger(scope.day) ||
    (scope.date !== null && typeof scope.date !== 'string') ||
    typeof scope.anchorStopId !== 'string' ||
    !isInteger(scope.anchorIndex) ||
    !isInteger(scope.keptCount) ||
    !isRecord(scope.request) ||
    typeof scope.requestSnapshot !== 'string' ||
    typeof scope.userInstruction !== 'string' ||
    (scope.travelMode !== 'walking' && scope.travelMode !== 'driving') ||
    (scope.travelers !== null && !isInteger(scope.travelers))
  ) {
    return scopeProblem('invalid_scope', '后段范围记录字段缺失或类型不对，无法应用。')
  }
  const tailScope = scope as unknown as DayReplanTailScope
  if (tailScope.revision !== revision) {
    return scopeProblem(
      'stale_scope',
      '行程版本已经变化，这份后段候选基于旧版本，不能覆盖当前内容；请重新生成。',
    )
  }
  if (tailScope.tripId !== trip.id) {
    return scopeProblem('stale_scope', '当前行程已经不是发起后段调整时的那份行程，候选失效。')
  }
  let snapshotNow: string
  try {
    snapshotNow = JSON.stringify(trip)
  } catch {
    return scopeProblem('stale_scope', '当前行程无法序列化核对，后段候选失效。')
  }
  if (snapshotNow !== tailScope.tripSnapshot) {
    return scopeProblem(
      'stale_scope',
      '行程内容已经变化（包括原地修改），这份后段候选基于旧内容，不能应用。',
    )
  }
  let requestNow: string
  try {
    requestNow = JSON.stringify(tailScope.request)
  } catch {
    return scopeProblem('invalid_scope', '后段范围里的请求无法序列化核对，候选失效。')
  }
  if (requestNow !== tailScope.requestSnapshot) {
    return scopeProblem('invalid_scope', '后段范围里的请求与记录不一致，候选失效。')
  }
  if (tailScope.request.day !== tailScope.day || tailScope.request.date !== tailScope.date) {
    return scopeProblem('invalid_scope', '后段范围里的目标日与请求不一致，候选失效。')
  }
  const requestParent = (tailScope.request as { parent?: unknown }).parent
  if (!isRecord(requestParent) || requestParent.trip_id !== tailScope.tripId) {
    return scopeProblem('invalid_scope', '后段范围里的请求父行程与记录不一致，候选失效。')
  }
  const baseDay = findTargetDay(trip, tailScope.day)
  if (!baseDay || !Array.isArray(baseDay.stops)) {
    return scopeProblem('stale_scope', '目标日在当前行程里已不存在，候选失效。')
  }
  const anchor = baseDay.stops[tailScope.anchorIndex]
  if (!isRecord(anchor) || anchor.id !== tailScope.anchorStopId) {
    return scopeProblem('stale_scope', '锚点站已不在原来的位置，这份后段候选失效；请重新生成。')
  }
  if (tailScope.keptCount !== tailScope.anchorIndex + 1) {
    return scopeProblem('invalid_scope', '后段范围的保留站数与锚点不一致，候选失效。')
  }
  return { ok: true }
}

// ==================== 后段候选检查与组合 ====================

export type DayReplanTailFailureReason =
  | DayReplanApplyFailureReason
  | 'invalid_scope'
  | 'stale_scope'
  | 'invalid_revision'
  | 'invalid_anchor'
  | 'invalid_base_day'
  | 'empty_tail'
  | 'too_many_combined_stops'
  | 'tail_id_conflict'
  | 'time_conflict'
  | 'time_cross_day'

export interface DayReplanTailFailure {
  ok: false
  reason: DayReplanTailFailureReason
  message: string
}

interface TailContext {
  baseDay: TripDay
  frozenStops: TripStop[]
  frozenLegs: TripLeg[]
  candidateDay: TripDay
  keptCount: number
  lowerBound: TailLowerBound
}

type TailContextResult = { ok: true; ctx: TailContext } | DayReplanTailFailure

function tailFailure(reason: DayReplanTailFailureReason, message: string): DayReplanTailFailure {
  return { ok: false, reason, message }
}

function firstTailTimeConflict(
  lowerMinutes: number,
  stops: readonly TripStop[],
): { index: number; time: string } | null {
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index]
    if (!isRecord(stop) || !isValidClock(stop.time)) continue
    const [h, m] = (stop.time as string).split(':')
    const minutes = Number(h) * 60 + Number(m)
    if (minutes < lowerMinutes) return { index, time: stop.time as string }
  }
  return null
}

/**
 * 冻结前缀的内部路段：逐段核对端点与保留站点顺序后取原引用。
 * 只要求前缀路段存在且端点相邻一致；route_type / geometry 形态（如 straight_line +
 * 空几何）属保存格式允许范围，不在链校验之内。缺失或错链返回 null，由调用方明确失败，
 * 绝不把坏链持久化，也不去修 / 重排旧链。
 */
function frozenPrefixLegs(baseDay: TripDay, keptCount: number): TripLeg[] | null {
  if (keptCount <= 1) return []
  const legs = baseDay.legs
  if (!Array.isArray(legs) || legs.length < keptCount - 1) return null
  const frozen: TripLeg[] = []
  for (let index = 0; index < keptCount - 1; index += 1) {
    const leg = legs[index]
    const from = baseDay.stops[index]
    const to = baseDay.stops[index + 1]
    if (!isRecord(leg) || !isRecord(from) || !isRecord(to)) return null
    if (leg.from_stop_id !== from.id || leg.to_stop_id !== to.id) return null
    frozen.push(leg as TripLeg)
  }
  return frozen
}

/**
 * 后段上下文核对与组合素材：scope / 信封 / 锚点 / 数量 / id / 时间全部通过才返回。
 * 冻结站点与内部路段直接取自原日的原对象引用；候选日来自通过旧校验的响应。
 * revisionForScopeCheck 必须是调用方的真实当前 revision；预览路径不得拿 scope 自带
 * revision 自比自。
 */
function resolveTailContext(
  baseTrip: Trip,
  scope: unknown,
  response: unknown,
  revisionForScopeCheck: number,
): TailContextResult {
  const scopeCheck = verifyTailScope(scope, baseTrip, revisionForScopeCheck)
  if (!scopeCheck.ok) {
    return tailFailure(scopeCheck.reason, scopeCheck.message)
  }
  const tailScope = scope as DayReplanTailScope

  const baseDay = findTargetDay(baseTrip, tailScope.day)
  if (!baseDay) {
    return tailFailure('unknown_day', `当前行程里没有第 ${tailScope.day} 天，后段候选未应用。`)
  }
  const keptCount = tailScope.keptCount
  if (
    !isInteger(keptCount) ||
    keptCount < 1 ||
    keptCount !== tailScope.anchorIndex + 1 ||
    keptCount > baseDay.stops.length - 1
  ) {
    return tailFailure('invalid_anchor', '锚点与保留站数和当前日程不一致，后段候选未应用。')
  }

  const validated = validateDayReplanResponse(response, tailScope.request)
  if (!validated.ok) {
    return tailFailure('invalid_response', `AI 候选没有通过结构校验：${validated.message}`)
  }
  const candidateDay = validated.response.day
  if (candidateDay.stops.length < 1) {
    return tailFailure('empty_tail', 'AI 候选没有返回任何新站点，无法构成后段；候选未应用。')
  }
  const combined = keptCount + candidateDay.stops.length
  if (combined > MAX_REPLAN_STOPS_PER_DAY) {
    return tailFailure(
      'too_many_combined_stops',
      `组合后本日将有 ${combined} 个站点，超过单日上限 ${MAX_REPLAN_STOPS_PER_DAY} 个；不会丢弃站点来凑上限，候选未应用。`,
    )
  }

  const frozenStops = baseDay.stops.slice(0, keptCount)
  const frozenIds = new Set(frozenStops.map((stop) => stop.id))
  for (const stop of candidateDay.stops) {
    if (frozenIds.has(stop.id)) {
      return tailFailure(
        'tail_id_conflict',
        `AI 候选站点 id「${stop.id}」与冻结保留段冲突；不会自动去重或改名，候选未应用。`,
      )
    }
  }
  const otherDayStopIds = new Set<string>()
  for (const day of baseTrip.days) {
    if (day.day === tailScope.day) continue
    for (const stop of day.stops) otherDayStopIds.add(stop.id)
  }
  for (const stop of candidateDay.stops) {
    if (otherDayStopIds.has(stop.id)) {
      return tailFailure(
        'cross_day_id_conflict',
        `候选站点 id「${stop.id}」与其它天已有站点冲突，候选未应用；不会改动其它日期或站点 id。`,
      )
    }
  }

  const lowerBound = knownTailLowerBound(baseDay.stops, keptCount)
  if (lowerBound.known && (lowerBound.minutes as number) >= 1440) {
    return tailFailure(
      'time_cross_day',
      '冻结前段按已填时间推算的结束下界已跨入次日，本批无法在同一日内接续后段；候选未应用，也没有改动任何时刻。',
    )
  }
  if (lowerBound.known) {
    const conflict = firstTailTimeConflict(lowerBound.minutes as number, candidateDay.stops)
    if (conflict) {
      return tailFailure(
        'time_conflict',
        `AI 候选第 ${conflict.index + 1} 个新站时刻 ${conflict.time} 早于冻结段可知结束下界 ${minutesToClock(lowerBound.minutes as number)}；不会替它改写时刻，候选未应用。`,
      )
    }
  }

  const frozenLegs = frozenPrefixLegs(baseDay, keptCount)
  if (!frozenLegs) {
    return tailFailure(
      'invalid_base_day',
      `这一天的既有路段与站点顺序对不上（前 ${keptCount} 站的站间路段缺失或端点错位），无法安全冻结前段；后段候选未应用，也没有改动任何旧数据。`,
    )
  }

  return {
    ok: true,
    ctx: {
      baseDay,
      frozenStops,
      frozenLegs,
      candidateDay,
      keptCount,
      lowerBound,
    },
  }
}

/** 唯一新建的跨锚点衔接 leg：全未知，不造直线、不按未知补 0。 */
function boundaryLeg(fromStopId: string, toStopId: string, mode: TravelMode): TripLeg {
  return {
    from_stop_id: fromStopId,
    to_stop_id: toStopId,
    mode,
    route_type: 'unavailable',
    distance_m: null,
    duration_minutes: null,
    geometry: [],
    description: TAIL_BOUNDARY_LEG_DESCRIPTION,
  }
}

/** 组合完整目标日：冻结前缀原引用 + 新衔接 leg + 经校验的候选后段。 */
function assembleTailDay(ctx: TailContext, travelMode: TravelMode): TripDay {
  const firstTailStop = ctx.candidateDay.stops[0]
  return {
    day: ctx.baseDay.day,
    date: ctx.baseDay.date,
    title: `第${ctx.baseDay.day}天（前${ctx.keptCount}站原样，之后按 AI 候选调整）`,
    summary: buildTailDaySummary(ctx.keptCount, ctx.baseDay.stops[ctx.keptCount - 1]?.name ?? ''),
    stops: [...ctx.frozenStops, ...ctx.candidateDay.stops],
    legs: [
      ...ctx.frozenLegs,
      boundaryLeg(ctx.baseDay.stops[ctx.keptCount - 1].id, firstTailStop.id, travelMode),
      ...ctx.candidateDay.legs,
    ],
  }
}

function buildTailDaySummary(keptCount: number, anchorName: string): string {
  return (
    `AI 后段调整：本日前 ${keptCount} 站（至「${anchorName}」）原样保留，仅之后按 AI 候选替换；` +
    '锚点衔接路线未重算，需另行核对。前段时刻、停留与路线未改动，后段为候选数据，' +
    '未核实预约、营业状态或实时交通。'
  )
}

function buildTailTripSummary(days: readonly TripDay[], dayNumber: number, keptCount: number): string {
  const totalStops = days.reduce((total, day) => total + day.stops.length, 0)
  const rest =
    days.length > 1 ? `其余 ${days.length - 1} 天沿用原安排` : '这是行程里唯一的一天'
  return (
    `AI 后段调整副本（未重新规划其它天）：第${dayNumber}天前 ${keptCount} 站原样保留、仅之后按 AI 候选替换，${rest}；` +
    `共 ${days.length} 天、${totalStops} 个站点。锚点衔接路线未重算，需另行核对；` +
    '本次没有重新核实预约、营业状态或实时交通，占位时间与地图降级说明见行程提醒，原推荐摘要不再代表当前方案。' +
    '本次应用不会自动保存。'
  )
}

function buildTailAiHeader(
  dayNumber: number,
  totalDays: number,
  keptCount: number,
  hasNew: boolean,
  hasOld: boolean,
): string {
  const scope =
    totalDays > 1
      ? `第${dayNumber}天前 ${keptCount} 站原样保留，之后已按 AI 候选替换，其余天沿用原安排。`
      : `第${dayNumber}天前 ${keptCount} 站原样保留，之后已按 AI 候选替换。`
  const segments = hasNew
    ? `从下一条起是本次候选返回的提醒（含占位时间与地图降级说明）${hasOld ? '；再后面的「调整前提醒」是调整前已有的内容，尚未重新核对' : ''}。`
    : hasOld
      ? '本次候选没有返回额外提醒；后面的「调整前提醒」是调整前已有的内容，尚未重新核对。'
      : '本次候选没有返回额外提醒。'
  return (
    `${TAIL_AI_REPLAN_WARNING_PREFIX}${scope}${segments}` +
    '本次应用不会自动保存，也不代表已核实预约、营业状态或实时交通。'
  )
}

// ==================== 预览 ====================

export interface DayReplanTailPreview {
  ok: true
  /** 组合后的完整目标日（冻结前缀 + 衔接 + 后段），仅供预览，不代表已应用。 */
  day: TripDay
  mapStatus: MapStatus
  keptCount: number
  tailStopCount: number
  lowerBound: TailLowerBound
  /** 固定说明：衔接未知、时间下界状态等。 */
  notices: string[]
}

export type DayReplanTailPreviewResult = DayReplanTailPreview | DayReplanTailFailure

/**
 * 组合可预览的完整目标日。纯函数：不改任何输入，也不代表已应用。
 * 预览与应用走同一套检查与拼装，不会出现「预览一套、应用一套」。
 * currentRevision 必填：必须传界面当前的真实 revision；缺失或无效（NaN / Infinity /
 * 负数 / 非整数 / 非数值）按 invalid_revision 类型化失败，不回退 scope 自带 revision
 * 自比自——revision 变而内容相同的窄场景下预览也必须作废。
 */
export function composeTailPreviewDay(
  baseTrip: Trip,
  scope: unknown,
  response: unknown,
  currentRevision: number,
): DayReplanTailPreviewResult {
  if (!isValidCurrentRevision(currentRevision)) {
    return tailFailure(
      'invalid_revision',
      '调用方未提供有效的当前行程版本，无法安全核对后段范围；未组合预览。',
    )
  }
  const ctxResult = resolveTailContext(baseTrip, scope, response, currentRevision)
  if (!ctxResult.ok) return ctxResult
  const ctx = ctxResult.ctx
  const tailScope = scope as DayReplanTailScope
  const day = assembleTailDay(ctx, tailScope.travelMode)
  const notices = [
    `衔接路线（${ctx.baseDay.stops[ctx.keptCount - 1].name} → ${ctx.candidateDay.stops[0].name}）未重算：距离、耗时与几何未知，需另行核对。`,
    ctx.lowerBound.known
      ? `按已填时间推算，冻结段已知结束不早于 ${minutesToClock(ctx.lowerBound.minutes as number)}；新后段不应早于该时刻开始（未计入衔接交通）。`
      : '冻结段存在未填时间或未填停留，无法推算衔接时刻下界；无法确认时间衔接，需人工核对。',
  ]
  return {
    ok: true,
    day,
    mapStatus: classifyDayMapStatus(day),
    keptCount: ctx.keptCount,
    tailStopCount: ctx.candidateDay.stops.length,
    lowerBound: ctx.lowerBound,
    notices,
  }
}

// ==================== 应用 ====================

export interface ApplyDayReplanTailInput {
  /** 当前显示的行程；不会被修改。 */
  baseTrip: Trip
  /** 生成候选时记录的后段范围；非法或过期整体拒绝，绝不落回整天替换。 */
  scope: DayReplanTailScope
  /** 原始候选响应（会重新过一遍完整校验）。 */
  response: DayReplanResponse
  /** 界面当前的 revision；与 scope.revision 不一致视为过期。 */
  currentRevision: number
  /** 由调用方生成的新副本 id：1-100 字且不等于 baseTrip.id。 */
  forkTripId: string
  /**
   * 面板透传的生成时请求；提供时必须与 scope.request 指纹一致，否则拒绝，
   * 保证预览组合与应用用的请求是同一份，不被篡改或错配。
   */
  request?: DayReplanRequest
}

/** 应用输入的当前 revision 核对：与预览同一口径，无效即类型化失败。 */
function checkCurrentRevision(value: unknown): DayReplanTailFailure | null {
  if (!isValidCurrentRevision(value)) {
    return tailFailure(
      'invalid_revision',
      '调用方未提供有效的当前行程版本，无法安全核对后段范围；后段候选未应用。',
    )
  }
  return null
}

export interface DayReplanTailApplySuccess {
  ok: true
  trip: Trip
  changedDays: number[]
  newWarningCount: number
  keptNewWarnings: number
  omittedNewWarnings: number
  keptOldWarnings: number
  omittedOldWarnings: number
  omittedWarnings: number
  notices: string[]
  tail: {
    day: number
    keptCount: number
    anchorIndex: number
    anchorStopId: string
    tailStopCount: number
    boundaryMode: TravelMode
    lowerBound: TailLowerBound
    combinedMapStatus: MapStatus
  }
}

export type DayReplanTailApplyResult = DayReplanTailApplySuccess | DayReplanTailFailure

/**
 * 显式应用后段候选：冻结前缀原引用恢复进组合日，只改本次生成的分段头与摘要，
 * 其它天原样；复用旧 applyDayReplan 做信封复验、跨天 id 冲突与 40 条提醒组合
 * （旧的整体头按完整模板先摘掉，用户提醒不动），再后验结构与 640 KB 容量。
 * scope 非法 / 过期返回失败，绝不落回整天替换；所有输入保持不变。
 */
export function applyDayReplanTail(input: ApplyDayReplanTailInput): DayReplanTailApplyResult {
  const { baseTrip, scope, response, currentRevision, forkTripId, request } = input
  const revisionProblem = checkCurrentRevision(currentRevision)
  if (revisionProblem) return revisionProblem
  const scopeCheck = verifyTailScope(scope, baseTrip, currentRevision)
  if (!scopeCheck.ok) {
    return tailFailure(scopeCheck.reason, scopeCheck.message)
  }
  if (request !== undefined) {
    let requestNow: string
    try {
      requestNow = JSON.stringify(request)
    } catch {
      return tailFailure('request_mismatch', '传入的候选请求无法序列化核对，后段候选未应用。')
    }
    if (requestNow !== scope.requestSnapshot) {
      return tailFailure(
        'request_mismatch',
        '传入的候选请求与后段范围记录不一致，后段候选未应用；请用生成时的候选重新应用。',
      )
    }
  }

  const ctxResult = resolveTailContext(baseTrip, scope, response, currentRevision)
  if (!ctxResult.ok) return ctxResult
  const ctx = ctxResult.ctx

  // 旧 apply 的 composeWarnings 按完整模板摘掉旧的整体替换头 /「调整前提醒」头 /
  // 省略行，但本模块写的旧后段头它不认识；先按完整模板摘掉旧后段头，避免二次
  // 应用越套越深。只删完整模板匹配项，用户提醒（含以相同字眼开头的）不动。
  const inheritedWarnings = baseTrip.warnings.filter(
    (warning) => !TAIL_AI_HEADER_PATTERN.test(warning),
  )
  const oldResult = applyDayReplan({
    baseTrip:
      inheritedWarnings.length === baseTrip.warnings.length
        ? baseTrip
        : { ...baseTrip, warnings: inheritedWarnings },
    request: scope.request,
    response,
    currentRevision,
    forkTripId,
  })
  if (!oldResult.ok) return oldResult

  const assembledDay = assembleTailDay(ctx, scope.travelMode)
  const warnings = [...oldResult.trip.warnings]
  // 旧 apply 的组合头固定在首位；不是它说明组合结果不符合预期，整体放弃。
  if (!warnings[0]?.startsWith(AI_REPLAN_WARNING_PREFIX)) {
    return tailFailure(
      'postcondition_failed',
      '提醒组合结果与预期不一致，这次应用已放弃，原始行程保持不变。',
    )
  }
  warnings[0] = buildTailAiHeader(
    scope.day,
    oldResult.trip.days.length,
    ctx.keptCount,
    oldResult.keptNewWarnings > 0,
    oldResult.keptOldWarnings > 0,
  )

  const trip: Trip = {
    ...oldResult.trip,
    summary: buildTailTripSummary(oldResult.trip.days, scope.day, ctx.keptCount),
    warnings,
    days: oldResult.trip.days.map((day) => (day.day === scope.day ? assembledDay : day)),
  }

  const postShape = checkTripShape(trip)
  if (!postShape.ok) {
    return tailFailure(
      'postcondition_failed',
      '应用后的行程没有通过本地结构校验，这次应用已放弃，原始行程保持不变。',
    )
  }
  let recordBytes: number
  try {
    recordBytes = savedTripRecordBytes(trip)
  } catch {
    return tailFailure(
      'postcondition_failed',
      '应用后的行程无法序列化，这次应用已放弃，原始行程保持不变。',
    )
  }
  if (recordBytes > MAX_SAVED_TRIP_BYTES) {
    return tailFailure(
      'capacity_exceeded',
      `应用后的行程约 ${Math.ceil(recordBytes / 1024)} KB，会超过单份 ${Math.round(MAX_SAVED_TRIP_BYTES / 1024)} KB 的保存与备份上限，` +
        '这次应用已放弃，原始行程与候选几何都没有被改动或截断。',
    )
  }

  return {
    ok: true,
    trip,
    changedDays: [scope.day],
    newWarningCount: oldResult.newWarningCount,
    keptNewWarnings: oldResult.keptNewWarnings,
    omittedNewWarnings: oldResult.omittedNewWarnings,
    keptOldWarnings: oldResult.keptOldWarnings,
    omittedOldWarnings: oldResult.omittedOldWarnings,
    omittedWarnings: oldResult.omittedWarnings,
    notices: [TAIL_APPLY_NOTICE, DAY_REPLAN_WARNINGS_NOTICE],
    tail: {
      day: scope.day,
      keptCount: ctx.keptCount,
      anchorIndex: scope.anchorIndex,
      anchorStopId: scope.anchorStopId,
      tailStopCount: ctx.candidateDay.stops.length,
      boundaryMode: scope.travelMode,
      lowerBound: ctx.lowerBound,
      combinedMapStatus: classifyDayMapStatus(assembledDay),
    },
  }
}

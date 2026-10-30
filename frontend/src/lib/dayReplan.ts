/**
 * 单日 AI 候选（POST /api/trips/days/replan）的前端纯函数契约。
 *
 * 边界：
 * - 纯函数：不读 localStorage，不调用 crypto / 网络 / 地图 / 时间，不自动保存；
 *   fork 行程 id、父 revision、出行方式全部由调用方显式提供。
 * - 请求只投影目标日的站点文字字段，绝不把带 location / geometry 的 Stop 整个展开。
 *   新接口的上限（目的地 80、1..7 天、单日 8 站、站点 id 100 / 名称 120 / 地址 300 /
 *   描述 1000 / HH:MM / 停留 0..1440 / 指令 500 / revision 安全整数）逐项校验；
 *   任何超出范围的输入都明确拒绝，不截字、不截站、不顺手修复旧导入数据，原 Trip 不动。
 * - 响应按 unknown 做运行时校验：source=agent、六种 map_status、parent 与请求完全一致、
 *   目标 day/date 一致、站点 / 路段形状、ID 唯一、WGS84 坐标范围、legs 相邻链、
 *   route_type 与 geometry 一致；在 checkTripShape 之上补足它不校验的这些业务约束。
 *   map_status 还必须与坐标 / 路线实际完整度相符，无效响应直接失败，不自动补成导航。
 * - 应用是显式操作：父 id / revision 必须与当前行程一致，fork id 合法且不等于 base.id，
 *   候选站点 id 不得与其它天冲突。只替换目标日，其它天对象与 geometry 逐点保持原引用，
 *   深冻结的输入也不会被修改；返回新 Trip 给界面主动采用，不自动保存、不写 parent 令牌。
 * - 新候选的 warnings（含占位时间、地图降级、服务端末尾汇总）必须随 Trip v1 持久化。
 *   这里只把本模块写出的完整分段模板认成生成段，不做前缀匹配：用户自己写的
 *   「【调整前提醒】博物馆周一闭馆，需核实」仍是实质提醒，必须原文保留。
 *   总量压到 40 条；空间不足时写准确的省略条数（按返回条目计，不冒充实际冲突总数），
 *   并优先保留新提醒的首项与末项。更早一次应用省略过条目时，会保留一条明确的
 *   「历史提醒不完整」说明，避免再次应用后看起来完整。
 */

import type { TravelMode, Trip, TripDay } from './api'
import {
  MAX_GEOMETRY_POINTS_PER_LEG,
  MAX_SAVED_TRIP_BYTES,
  MAX_TOTAL_GEOMETRY_POINTS,
  checkTripShape,
  savedTripRecordBytes,
} from './savedTrips'

// ==================== 后端契约上限 ====================

/** 与 day_replan.py 的 DayReplanRequest / DayReplanStop 字段上限一致。 */
export const MAX_REPLAN_DESTINATION_LENGTH = 80
export const MAX_REPLAN_DAYS = 7
export const MAX_REPLAN_STOPS_PER_DAY = 8
export const MAX_REPLAN_TRIP_ID_LENGTH = 100
export const MAX_REPLAN_STOP_ID_LENGTH = 100
export const MAX_REPLAN_STOP_NAME_LENGTH = 120
export const MAX_REPLAN_STOP_ADDRESS_LENGTH = 300
export const MAX_REPLAN_STOP_DESCRIPTION_LENGTH = 1000
export const MAX_REPLAN_STOP_DURATION_MINUTES = 1440
export const MAX_REPLAN_INSTRUCTION_LENGTH = 500
export const MAX_REPLAN_TRAVELERS = 50
export const MAX_REPLAN_DAY_TITLE_LENGTH = 120
export const MAX_REPLAN_DAY_SUMMARY_LENGTH = 800
export const MAX_REPLAN_LEG_DESCRIPTION_LENGTH = 500
/** TripPlan.warnings 的后端上限。 */
export const MAX_REPLAN_WARNINGS = 40
/** checkTripShape 对单条 warning 的上限，生成的说明与原文都必须落在其内。 */
export const MAX_REPLAN_WARNING_LENGTH = 2000
/** parent.revision 只接受 JSON 安全整数。 */
export const MAX_REPLAN_REVISION = Number.MAX_SAFE_INTEGER

/** 合法站点时间：严格 HH:MM，24 小时制。 */
export const REPLAN_STOP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** 可见分段标记：它们只由本模块生成，重新应用时会先摘掉旧的一组，避免越套越深。 */
export const AI_REPLAN_WARNING_PREFIX = '【AI单日调整】'
export const PRE_ADJUSTMENT_WARNING_PREFIX = '【调整前提醒】'
export const WARNING_OMISSION_PREFIX = '【提醒省略】'

/**
 * 只认本模块写出的完整模板，绝不用 startsWith：用户自定义提醒即使以相同字眼开头，
 * 也是实质内容，不能被静默删除。
 */
const AI_REPLAN_HEADER_PATTERN =
  /^【AI单日调整】第\d+天已按 AI 候选替换(?:，其余天沿用原安排)?。(?:从下一条起是本次候选返回的提醒（含占位时间与地图降级说明）(?:；再后面的「调整前提醒」是调整前已有的内容，尚未重新核对)?。|本次候选没有返回额外提醒；后面的「调整前提醒」是调整前已有的内容，尚未重新核对。|本次候选没有返回额外提醒。)本次应用不会自动保存，也不代表已核实预约、营业状态或实时交通。$/

const PRE_ADJUSTMENT_HEADER_PATTERN =
  /^【调整前提醒】以下 \d+ 条是本次 AI 调整前已有的提醒，原文保留、尚未重新核对；它们既不能当成仍然成立，也不能当成已经排除。$/

const WARNING_OMISSION_PATTERN =
  /^【提醒省略】为不超过 \d+ 条提醒上限，省略\d+条本次返回提醒\/\d+条调整前提醒；这里统计的是被省略的返回条目数，不代表实际冲突总数。$/

/** 更早一次应用省过条目时的保守记录；再次应用会按完整模板识别并重写，不会累积。 */
const HISTORY_INCOMPLETE_NOTE =
  `【历史提醒不完整】更早一次 AI 调整曾因 ${MAX_REPLAN_WARNINGS} 条提醒上限省略过条目；` +
  '这次继承的「调整前提醒」不是调整前的全部内容，不能据此判断没有其它冲突。'

export type MapStatus = 'ready' | 'partial' | 'unavailable' | 'no_key' | 'timeout' | 'failed'

const MAP_STATUSES: ReadonlySet<string> = new Set<MapStatus>([
  'ready',
  'partial',
  'unavailable',
  'no_key',
  'timeout',
  'failed',
])

/** 父行程版本令牌：与后端一样只回显、不落库。 */
export interface DayReplanParent {
  trip_id: string
  revision: number
}

/** 请求里的站点只有文字字段；坐标永远由服务端地图环节决定。 */
export interface DayReplanStopProjection {
  id: string
  name: string
  description: string
  address: string
  time: string | null
  duration_minutes: number | null
}

/** POST /api/trips/days/replan 的请求体（字段名与后端严格一致）。 */
export interface DayReplanRequest {
  destination: string
  day: number
  date: string | null
  travel_mode: TravelMode
  instruction: string
  stops: DayReplanStopProjection[]
  parent: DayReplanParent
  travelers?: number
}

/** 响应信封：Trip v1 字段不扩展，day 仍是普通 TripDay。 */
export interface DayReplanResponse {
  day: TripDay
  warnings: string[]
  map_status: MapStatus
  parent: DayReplanParent
  source: 'agent'
}

// ==================== 请求构造 ====================

export interface BuildDayReplanOptions {
  /** 由调用方显式给出，不从旧行程里猜。 */
  travel_mode: TravelMode
  /** 构造请求时的父行程版本；应用时还必须与界面当前 revision 相等。 */
  parentRevision: number
  /** 1..50；缺省或 null 时不写进请求，避免把默认人数当成用户已知信息。 */
  travelers?: number | null
}

export type DayReplanBuildFailureReason =
  | 'invalid_trip'
  | 'invalid_parent_trip_id'
  | 'invalid_destination'
  | 'invalid_day'
  | 'unknown_day'
  | 'duplicate_day'
  | 'invalid_date'
  | 'invalid_options'
  | 'invalid_mode'
  | 'invalid_parent_revision'
  | 'invalid_travelers'
  | 'invalid_instruction'
  | 'too_many_stops'
  | 'invalid_stop'
  | 'duplicate_stop_id'

export interface DayReplanBuildFailure {
  ok: false
  reason: DayReplanBuildFailureReason
  message: string
}

export type DayReplanBuildResult =
  | { ok: true; request: DayReplanRequest }
  | DayReplanBuildFailure

function buildFailure(
  reason: DayReplanBuildFailureReason,
  message: string,
): DayReplanBuildFailure {
  return { ok: false, reason, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function isBoundedText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= max &&
    value.trim().length > 0
  )
}

function isBoundedOptionalText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** 严格 YYYY-MM-DD 且是真实日历日；不用 Date，避免时区与 1900 偏移。 */
function isStrictDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  return day <= daysInMonth(year, month)
}

function isValidClock(value: unknown): value is string {
  return typeof value === 'string' && REPLAN_STOP_TIME_PATTERN.test(value)
}

/**
 * 把一天的站点投影成请求里的最小文字上下文。
 * 只读已知字段并显式构造对象，不 spread，location / geometry 不会进入请求。
 */
function projectStop(
  value: unknown,
  index: number,
): { ok: true; stop: DayReplanStopProjection } | { ok: false; message: string } {
  const label = `目标日第 ${index + 1} 个站点`
  if (!isRecord(value)) {
    return { ok: false, message: `${label}不是对象，未发起 AI 调整，也没有改动当前行程。` }
  }
  if (!isBoundedText(value.id, MAX_REPLAN_STOP_ID_LENGTH)) {
    return {
      ok: false,
      message: `${label}的 id 必须是 1-${MAX_REPLAN_STOP_ID_LENGTH} 字非空字符串，未发起 AI 调整。`,
    }
  }
  if (!isBoundedText(value.name, MAX_REPLAN_STOP_NAME_LENGTH)) {
    return {
      ok: false,
      message: `${label}的名称必须是 1-${MAX_REPLAN_STOP_NAME_LENGTH} 字非空字符串；这次没有截断，未发起 AI 调整。`,
    }
  }
  if (!isBoundedOptionalText(value.description, MAX_REPLAN_STOP_DESCRIPTION_LENGTH)) {
    return {
      ok: false,
      message: `${label}的描述超过 ${MAX_REPLAN_STOP_DESCRIPTION_LENGTH} 字或不是字符串；这次没有截断，未发起 AI 调整。`,
    }
  }
  if (!isBoundedOptionalText(value.address, MAX_REPLAN_STOP_ADDRESS_LENGTH)) {
    return {
      ok: false,
      message: `${label}的地址超过 ${MAX_REPLAN_STOP_ADDRESS_LENGTH} 字或不是字符串；这次没有截断，未发起 AI 调整。`,
    }
  }
  if (value.time !== null && !isValidClock(value.time)) {
    return {
      ok: false,
      message: `${label}的时间不是严格 HH:MM（24 小时制）或 null；不会替它改写成占位时间，未发起 AI 调整。`,
    }
  }
  const duration = value.duration_minutes
  if (
    duration !== null &&
    !(typeof duration === 'number' && Number.isInteger(duration) && duration >= 0 && duration <= MAX_REPLAN_STOP_DURATION_MINUTES)
  ) {
    return {
      ok: false,
      message: `${label}的停留时间必须是 null 或 0-${MAX_REPLAN_STOP_DURATION_MINUTES} 的整数，未发起 AI 调整。`,
    }
  }
  return {
    ok: true,
    stop: {
      id: value.id,
      name: value.name,
      description: value.description,
      address: value.address,
      time: value.time,
      duration_minutes: duration,
    },
  }
}

/**
 * 从当前 Trip、目标 day、用户指令与显式选项构造单日重规划请求。
 * 目标日缺失 / 重复、字段超限、日期非严格 YYYY-MM-DD 都返回明确失败；原 Trip 不被修改。
 */
export function buildDayReplanRequest(
  baseTrip: Trip,
  day: number,
  instruction: string,
  options: BuildDayReplanOptions,
): DayReplanBuildResult {
  if (!isRecord(baseTrip)) {
    return buildFailure('invalid_trip', '当前行程不是对象，未发起 AI 调整。')
  }
  if (!isBoundedText(baseTrip.id, MAX_REPLAN_TRIP_ID_LENGTH)) {
    return buildFailure(
      'invalid_parent_trip_id',
      `当前行程 id 必须是 1-${MAX_REPLAN_TRIP_ID_LENGTH} 字非空字符串，才能作为父行程令牌；未发起 AI 调整。`,
    )
  }
  if (!isBoundedText(baseTrip.destination, MAX_REPLAN_DESTINATION_LENGTH)) {
    return buildFailure(
      'invalid_destination',
      `目的地必须是 1-${MAX_REPLAN_DESTINATION_LENGTH} 字非空字符串；这次没有截断，未发起 AI 调整。`,
    )
  }
  if (!isIntegerInRange(day, 1, MAX_REPLAN_DAYS)) {
    return buildFailure(
      'invalid_day',
      `目标日必须是 1-${MAX_REPLAN_DAYS} 的整数，未发起 AI 调整。`,
    )
  }
  if (!isRecord(options)) {
    return buildFailure('invalid_options', '缺少出行方式与父 revision，未发起 AI 调整。')
  }
  if (options.travel_mode !== 'walking' && options.travel_mode !== 'driving') {
    return buildFailure('invalid_mode', '出行方式只能是 walking 或 driving，未发起 AI 调整。')
  }
  if (!isSafeRevision(options.parentRevision)) {
    return buildFailure(
      'invalid_parent_revision',
      '父 revision 必须是 0 到 2^53-1 的安全整数，未发起 AI 调整。',
    )
  }
  const travelers = options.travelers
  if (
    travelers !== undefined &&
    travelers !== null &&
    !isIntegerInRange(travelers, 1, MAX_REPLAN_TRAVELERS)
  ) {
    return buildFailure(
      'invalid_travelers',
      `同行人数必须是 1-${MAX_REPLAN_TRAVELERS} 的整数或省略，未发起 AI 调整。`,
    )
  }
  if (typeof instruction !== 'string' || instruction.trim().length === 0) {
    return buildFailure('invalid_instruction', '请先填写想怎么调整这一天，未发起 AI 调整。')
  }
  if (instruction.length > MAX_REPLAN_INSTRUCTION_LENGTH) {
    return buildFailure(
      'invalid_instruction',
      `调整指令最多 ${MAX_REPLAN_INSTRUCTION_LENGTH} 字，当前 ${instruction.length} 字；这次没有截断，未发起 AI 调整。`,
    )
  }

  if (!Array.isArray(baseTrip.days)) {
    return buildFailure('invalid_trip', '当前行程缺少天数组，未发起 AI 调整。')
  }
  const matches: unknown[] = []
  for (const item of baseTrip.days) {
    if (isRecord(item) && item.day === day) matches.push(item)
  }
  if (matches.length === 0) {
    return buildFailure('unknown_day', `当前行程里没有第 ${day} 天，未发起 AI 调整。`)
  }
  if (matches.length > 1) {
    return buildFailure(
      'duplicate_day',
      `当前行程里第 ${day} 天出现了 ${matches.length} 次，无法确定要调整哪一天；未发起 AI 调整。`,
    )
  }

  const sourceDay = matches[0]
  if (!isRecord(sourceDay) || !Array.isArray(sourceDay.stops)) {
    return buildFailure('invalid_trip', `第 ${day} 天的站点数据结构不完整，未发起 AI 调整。`)
  }
  const date = sourceDay.date
  if (date !== null && !isStrictDate(date)) {
    return buildFailure(
      'invalid_date',
      `第 ${day} 天的日期不是严格 YYYY-MM-DD 或 null；不会静默改成 null，未发起 AI 调整。`,
    )
  }
  if (sourceDay.stops.length > MAX_REPLAN_STOPS_PER_DAY) {
    return buildFailure(
      'too_many_stops',
      `第 ${day} 天有 ${sourceDay.stops.length} 个站点，超过单日 AI 调整上限 ${MAX_REPLAN_STOPS_PER_DAY} 个；这次没有截断，未发起 AI 调整。请先在本地编辑里精简站点。`,
    )
  }

  const stops: DayReplanStopProjection[] = []
  const seenIds = new Set<string>()
  for (let index = 0; index < sourceDay.stops.length; index += 1) {
    const projected = projectStop(sourceDay.stops[index], index)
    if (!projected.ok) {
      return buildFailure('invalid_stop', projected.message)
    }
    if (seenIds.has(projected.stop.id)) {
      return buildFailure(
        'duplicate_stop_id',
        `第 ${day} 天存在重复的站点 id「${projected.stop.id}」；未发起 AI 调整。`,
      )
    }
    seenIds.add(projected.stop.id)
    stops.push(projected.stop)
  }

  const request: DayReplanRequest = {
    destination: baseTrip.destination,
    day,
    date,
    travel_mode: options.travel_mode,
    instruction,
    stops,
    parent: { trip_id: baseTrip.id, revision: options.parentRevision },
  }
  if (travelers !== undefined && travelers !== null) {
    request.travelers = travelers
  }
  return { ok: true, request }
}

// ==================== 响应校验 ====================

export type DayReplanValidation =
  | { ok: true; response: DayReplanResponse }
  | { ok: false; message: string }

function validationFailure(message: string): { ok: false; message: string } {
  return { ok: false, message }
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'day',
  'warnings',
  'map_status',
  'parent',
  'source',
])
const DAY_KEYS: ReadonlySet<string> = new Set([
  'day',
  'date',
  'title',
  'summary',
  'stops',
  'legs',
])
const STOP_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'time',
  'duration_minutes',
  'description',
  'address',
  'location',
])
const LEG_KEYS: ReadonlySet<string> = new Set([
  'from_stop_id',
  'to_stop_id',
  'mode',
  'route_type',
  'distance_m',
  'duration_minutes',
  'geometry',
  'description',
])
const LOCATION_KEYS: ReadonlySet<string> = new Set(['lng', 'lat'])
const PARENT_KEYS: ReadonlySet<string> = new Set(['trip_id', 'revision'])

function findUnknownKey(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key
  }
  return null
}

function checkCoordinate(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} 不是坐标对象`
  const extra = findUnknownKey(value, LOCATION_KEYS)
  if (extra) return `${path} 包含未知字段 ${extra}`
  if (!isFiniteNumber(value.lng) || value.lng < -180 || value.lng > 180) {
    return `${path}.lng 必须是 -180 到 180 的有限数字`
  }
  if (!isFiniteNumber(value.lat) || value.lat < -90 || value.lat > 90) {
    return `${path}.lat 必须是 -90 到 90 的有限数字`
  }
  return null
}

function checkStop(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} 不是对象`
  const extra = findUnknownKey(value, STOP_KEYS)
  if (extra) return `${path} 包含未知字段 ${extra}`
  if (!isBoundedText(value.id, MAX_REPLAN_STOP_ID_LENGTH)) {
    return `${path}.id 必须是 1-${MAX_REPLAN_STOP_ID_LENGTH} 字非空字符串`
  }
  if (!isBoundedText(value.name, MAX_REPLAN_STOP_NAME_LENGTH)) {
    return `${path}.name 必须是 1-${MAX_REPLAN_STOP_NAME_LENGTH} 字非空字符串`
  }
  if (!isValidClock(value.time)) {
    return `${path}.time 必须是严格 HH:MM`
  }
  if (
    value.duration_minutes !== null &&
    !(
      typeof value.duration_minutes === 'number' &&
      Number.isInteger(value.duration_minutes) &&
      value.duration_minutes >= 0 &&
      value.duration_minutes <= MAX_REPLAN_STOP_DURATION_MINUTES
    )
  ) {
    return `${path}.duration_minutes 必须是 null 或 0-${MAX_REPLAN_STOP_DURATION_MINUTES} 的整数`
  }
  if (!isBoundedOptionalText(value.description, MAX_REPLAN_STOP_DESCRIPTION_LENGTH)) {
    return `${path}.description 必须是 0-${MAX_REPLAN_STOP_DESCRIPTION_LENGTH} 字的字符串`
  }
  if (!isBoundedOptionalText(value.address, MAX_REPLAN_STOP_ADDRESS_LENGTH)) {
    return `${path}.address 必须是 0-${MAX_REPLAN_STOP_ADDRESS_LENGTH} 字的字符串`
  }
  if (value.location !== null) {
    const locationError = checkCoordinate(value.location, `${path}.location`)
    if (locationError) return locationError
  }
  return null
}

function checkLeg(value: unknown, path: string, budget: { points: number }): string | null {
  if (!isRecord(value)) return `${path} 不是对象`
  const extra = findUnknownKey(value, LEG_KEYS)
  if (extra) return `${path} 包含未知字段 ${extra}`
  if (!isBoundedText(value.from_stop_id, MAX_REPLAN_STOP_ID_LENGTH)) {
    return `${path}.from_stop_id 必须是 1-${MAX_REPLAN_STOP_ID_LENGTH} 字非空字符串`
  }
  if (!isBoundedText(value.to_stop_id, MAX_REPLAN_STOP_ID_LENGTH)) {
    return `${path}.to_stop_id 必须是 1-${MAX_REPLAN_STOP_ID_LENGTH} 字非空字符串`
  }
  if (value.mode !== 'walking' && value.mode !== 'driving') {
    return `${path}.mode 只能是 walking 或 driving`
  }
  if (
    value.route_type !== 'navigation' &&
    value.route_type !== 'straight_line' &&
    value.route_type !== 'unavailable'
  ) {
    return `${path}.route_type 不是受支持的类型`
  }
  if (
    value.distance_m !== null &&
    !(typeof value.distance_m === 'number' && Number.isInteger(value.distance_m) && value.distance_m >= 0)
  ) {
    return `${path}.distance_m 必须是 null 或非负整数`
  }
  if (
    value.duration_minutes !== null &&
    !(isFiniteNumber(value.duration_minutes) && value.duration_minutes >= 0)
  ) {
    return `${path}.duration_minutes 必须是 null 或非负有限数字`
  }
  if (!isBoundedOptionalText(value.description, MAX_REPLAN_LEG_DESCRIPTION_LENGTH)) {
    return `${path}.description 必须是 0-${MAX_REPLAN_LEG_DESCRIPTION_LENGTH} 字的字符串`
  }
  if (!Array.isArray(value.geometry)) return `${path}.geometry 不是数组`
  if (value.geometry.length > MAX_GEOMETRY_POINTS_PER_LEG) {
    return `${path}.geometry 超过单段 ${MAX_GEOMETRY_POINTS_PER_LEG} 点`
  }
  budget.points += value.geometry.length
  if (budget.points > MAX_TOTAL_GEOMETRY_POINTS) {
    return `响应里的路线几何点超过全行程 ${MAX_TOTAL_GEOMETRY_POINTS} 点预算`
  }
  for (let index = 0; index < value.geometry.length; index += 1) {
    const pointError = checkCoordinate(value.geometry[index], `${path}.geometry[${index}]`)
    if (pointError) return pointError
  }
  if (value.route_type === 'unavailable') {
    if (value.geometry.length > 0) {
      return `${path} 是 unavailable 却带着旧路线几何，不能当成已更新`
    }
    if (value.distance_m !== null || value.duration_minutes !== null) {
      return `${path} 是 unavailable 却带着距离或耗时，不能当成可信路线`
    }
  } else if (value.geometry.length < 2) {
    return `${path} 的 ${value.route_type} 至少需要 2 个几何点`
  }
  return null
}

/** 与后端 classify_map_status 同一套判定，供预览展示与响应一致性校验共用。 */
export function classifyDayMapStatus(day: Pick<TripDay, 'stops' | 'legs'>): MapStatus {
  if (day.stops.length === 0) return 'unavailable'
  const located = day.stops.filter((stop) => stop.location !== null).length
  if (located === 0) return 'unavailable'
  if (located < day.stops.length) return 'partial'
  const expectedLegs = Math.max(day.stops.length - 1, 0)
  if (day.legs.length !== expectedLegs) return 'partial'
  return day.legs.every((leg) => leg.route_type === 'navigation') ? 'ready' : 'partial'
}

function checkDay(
  value: unknown,
  request: DayReplanRequest,
  mapStatus: MapStatus,
): { day: TripDay | null; error: string | null } {
  if (!isRecord(value)) return { day: null, error: '响应.day 不是对象' }
  const extra = findUnknownKey(value, DAY_KEYS)
  if (extra) return { day: null, error: `响应.day 包含未知字段 ${extra}` }
  if (!isIntegerInRange(value.day, 1, MAX_REPLAN_DAYS) || value.day !== request.day) {
    return { day: null, error: `响应.day.day 必须等于请求的第 ${request.day} 天` }
  }
  if (value.date !== request.date) {
    return { day: null, error: '响应.day.date 与请求日期不一致' }
  }
  if (!isBoundedOptionalText(value.title, MAX_REPLAN_DAY_TITLE_LENGTH)) {
    return { day: null, error: `响应.day.title 必须是 0-${MAX_REPLAN_DAY_TITLE_LENGTH} 字的字符串` }
  }
  if (!isBoundedOptionalText(value.summary, MAX_REPLAN_DAY_SUMMARY_LENGTH)) {
    return { day: null, error: `响应.day.summary 必须是 0-${MAX_REPLAN_DAY_SUMMARY_LENGTH} 字的字符串` }
  }
  if (!Array.isArray(value.stops) || value.stops.length > MAX_REPLAN_STOPS_PER_DAY) {
    return { day: null, error: `响应.day.stops 必须是不超过 ${MAX_REPLAN_STOPS_PER_DAY} 项的数组` }
  }
  const stopIds = new Set<string>()
  for (let index = 0; index < value.stops.length; index += 1) {
    const error = checkStop(value.stops[index], `响应.day.stops[${index}]`)
    if (error) return { day: null, error }
    const stop = value.stops[index] as Record<string, unknown>
    const id = stop.id as string
    if (stopIds.has(id)) return { day: null, error: `响应.day.stops 存在重复的站点 id「${id}」` }
    stopIds.add(id)
  }
  if (!Array.isArray(value.legs)) return { day: null, error: '响应.day.legs 不是数组' }
  const expectedLegs = Math.max(value.stops.length - 1, 0)
  if (value.legs.length !== expectedLegs) {
    return {
      day: null,
      error: `响应.day.legs 必须恰好覆盖相邻站点链（期望 ${expectedLegs} 段，实际 ${value.legs.length} 段）`,
    }
  }
  const budget = { points: 0 }
  for (let index = 0; index < value.legs.length; index += 1) {
    const error = checkLeg(value.legs[index], `响应.day.legs[${index}]`, budget)
    if (error) return { day: null, error }
    const leg = value.legs[index] as Record<string, unknown>
    const from = value.stops[index] as Record<string, unknown>
    const to = value.stops[index + 1] as Record<string, unknown>
    if (leg.from_stop_id !== from.id || leg.to_stop_id !== to.id) {
      return {
        day: null,
        error: `响应.day.legs[${index}] 必须连接第 ${index + 1} 与第 ${index + 2} 个站点，顺序不能错位`,
      }
    }
  }
  const day = value as unknown as TripDay
  const computed = classifyDayMapStatus(day)
  switch (mapStatus) {
    case 'ready':
      if (computed !== 'ready') {
        return { day: null, error: 'map_status=ready 但坐标或相邻导航并不完整' }
      }
      break
    case 'partial':
      if (computed !== 'partial') {
        return { day: null, error: 'map_status=partial 与坐标 / 路线完整度不一致' }
      }
      break
    case 'unavailable':
      if (computed !== 'unavailable' || day.legs.some((leg) => leg.route_type !== 'unavailable')) {
        return { day: null, error: 'map_status=unavailable 但仍有坐标或可用路线' }
      }
      break
    case 'no_key':
    case 'timeout':
    case 'failed':
      if (
        day.stops.some((stop) => stop.location !== null) ||
        day.legs.some((leg) => leg.route_type !== 'unavailable')
      ) {
        return {
          day: null,
          error: `map_status=${mapStatus} 时所有站点坐标必须为 null、所有路段必须为 unavailable`,
        }
      }
      break
  }
  return { day, error: null }
}

function validatedMapStatus(value: Record<string, unknown>): MapStatus | null {
  const status = value.map_status
  return typeof status === 'string' && MAP_STATUSES.has(status) ? (status as MapStatus) : null
}

function checkParent(
  value: unknown,
  expected: DayReplanParent,
  path: string,
): string | null {
  if (!isRecord(value)) return `${path} 不是对象`
  const extra = findUnknownKey(value, PARENT_KEYS)
  if (extra) return `${path} 包含未知字段 ${extra}`
  if (value.trip_id !== expected.trip_id) return `${path}.trip_id 与请求不一致`
  if (value.revision !== expected.revision) return `${path}.revision 与请求不一致`
  return null
}

/**
 * 对 unknown 响应做运行时校验。失败即拒绝，绝不补坐标、补 leg 或改成导航。
 * 只使用传入的 request 做父令牌 / 目标日比对，不读取任何隐式当前行程状态。
 */
export function validateDayReplanResponse(
  value: unknown,
  request: DayReplanRequest,
): DayReplanValidation {
  if (!isRecord(value)) return validationFailure('响应不是 JSON 对象')
  const extra = findUnknownKey(value, ENVELOPE_KEYS)
  if (extra) return validationFailure(`响应包含未知字段 ${extra}`)
  if (value.source !== 'agent') return validationFailure('响应.source 必须是 agent')
  const mapStatus = validatedMapStatus(value)
  if (mapStatus === null) {
    return validationFailure('响应.map_status 不是受支持的状态')
  }
  const expectedParent = request?.parent
  if (!isRecord(expectedParent)) {
    return validationFailure('请求上下文缺少 parent，无法校验响应')
  }
  const parentError = checkParent(value.parent, expectedParent, '响应.parent')
  if (parentError) return validationFailure(parentError)
  if (!Array.isArray(value.warnings)) return validationFailure('响应.warnings 不是数组')
  if (value.warnings.length > MAX_REPLAN_WARNINGS) {
    return validationFailure(`响应.warnings 超过 ${MAX_REPLAN_WARNINGS} 条上限`)
  }
  for (let index = 0; index < value.warnings.length; index += 1) {
    const warning = value.warnings[index]
    if (typeof warning !== 'string' || warning.length > MAX_REPLAN_WARNING_LENGTH) {
      return validationFailure(
        `响应.warnings[${index}] 必须是 0-${MAX_REPLAN_WARNING_LENGTH} 字的字符串`,
      )
    }
  }
  const dayCheck = checkDay(value.day, request, mapStatus)
  if (dayCheck.error) return validationFailure(dayCheck.error)
  return { ok: true, response: value as unknown as DayReplanResponse }
}

// ==================== 应用 ====================

export interface ApplyDayReplanInput {
  /** 当前显示 / 已保存的行程；不会被修改。 */
  baseTrip: Trip
  /** 构造候选时发出去的请求，用于版本与目标日核对。 */
  request: DayReplanRequest
  /** 已通过（或再次通过）validateDayReplanResponse 的候选。 */
  response: DayReplanResponse
  /** 界面当前的 revision；与 request.parent.revision 不一致视为过期。 */
  currentRevision: number
  /** 由调用方生成的新副本 id：1-100 字且不等于 baseTrip.id。 */
  forkTripId: string
}

export type DayReplanApplyFailureReason =
  | 'invalid_base'
  | 'base_too_large'
  | 'invalid_revision'
  | 'invalid_fork_id'
  | 'parent_mismatch'
  | 'stale_request'
  | 'request_mismatch'
  | 'unknown_day'
  | 'invalid_response'
  | 'cross_day_id_conflict'
  | 'postcondition_failed'
  | 'capacity_exceeded'

export interface DayReplanApplyFailure {
  ok: false
  reason: DayReplanApplyFailureReason
  message: string
}

export interface DayReplanApplySuccess {
  ok: true
  trip: Trip
  changedDays: number[]
  /** 响应里本次返回的提醒总数。 */
  newWarningCount: number
  keptNewWarnings: number
  omittedNewWarnings: number
  keptOldWarnings: number
  omittedOldWarnings: number
  /** omittedNewWarnings + omittedOldWarnings。 */
  omittedWarnings: number
  /** 固定提示，不写进行程。 */
  notices: string[]
}

export type DayReplanApplyResult = DayReplanApplySuccess | DayReplanApplyFailure

export const DAY_REPLAN_APPLY_NOTICE =
  'AI 单日候选只应用到当前副本，不会自动保存；保存、导出和备份仍由你显式操作。'
export const DAY_REPLAN_WARNINGS_NOTICE =
  '行程提醒分为「本次返回」与「调整前提醒」两段：前者来自这次 AI 候选，后者是调整前已有的内容，尚未重新核对。'

function applyFailure(
  reason: DayReplanApplyFailureReason,
  message: string,
): DayReplanApplyFailure {
  return { ok: false, reason, message }
}

interface ComposedWarnings {
  warnings: string[]
  keptNew: number
  omittedNew: number
  keptOld: number
  omittedOld: number
}

function isGeneratedSegment(warning: string): boolean {
  return (
    warning === HISTORY_INCOMPLETE_NOTE ||
    AI_REPLAN_HEADER_PATTERN.test(warning) ||
    PRE_ADJUSTMENT_HEADER_PATTERN.test(warning) ||
    WARNING_OMISSION_PATTERN.test(warning)
  )
}

/** 保留首项与末项，中间按原顺序尽量保留；服务端末尾的省略汇总不会先被丢掉。 */
function selectNewWarnings(warnings: readonly string[], count: number): string[] {
  if (count >= warnings.length) return [...warnings]
  if (count <= 0) return []
  if (count === 1) return [warnings[0]]
  return [...warnings.slice(0, count - 1), warnings[warnings.length - 1]]
}

function buildAiHeader(dayNumber: number, totalDays: number, hasNew: boolean, hasOld: boolean): string {
  const scope =
    totalDays > 1
      ? `第${dayNumber}天已按 AI 候选替换，其余天沿用原安排。`
      : `第${dayNumber}天已按 AI 候选替换。`
  const segments = hasNew
    ? `从下一条起是本次候选返回的提醒（含占位时间与地图降级说明）${hasOld ? '；再后面的「调整前提醒」是调整前已有的内容，尚未重新核对' : ''}。`
    : hasOld
      ? '本次候选没有返回额外提醒；后面的「调整前提醒」是调整前已有的内容，尚未重新核对。'
      : '本次候选没有返回额外提醒。'
  return (
    `${AI_REPLAN_WARNING_PREFIX}${scope}${segments}` +
    '本次应用不会自动保存，也不代表已核实预约、营业状态或实时交通。'
  )
}

function buildOldHeader(keptOld: number): string {
  return (
    `${PRE_ADJUSTMENT_WARNING_PREFIX}以下 ${keptOld} 条是本次 AI 调整前已有的提醒，` +
    '原文保留、尚未重新核对；它们既不能当成仍然成立，也不能当成已经排除。'
  )
}

function buildOmissionLine(omittedNew: number, omittedOld: number): string {
  return (
    `${WARNING_OMISSION_PREFIX}为不超过 ${MAX_REPLAN_WARNINGS} 条提醒上限，` +
    `省略${omittedNew}条本次返回提醒/${omittedOld}条调整前提醒；` +
    '这里统计的是被省略的返回条目数，不代表实际冲突总数。'
  )
}

/**
 * 组合本次候选与调整前提醒。新提醒优先；放不下时保留新提醒首末项，
 * 旧提醒只保留能放下的前缀，并写准确的省略条数。旧的分段模板会被摘掉，避免二次应用越套越深；
 * 摘掉旧省略行时改写成一条「历史提醒不完整」说明，避免再应用后误以为旧提醒仍完整。
 */
function composeWarnings(
  dayNumber: number,
  totalDays: number,
  responseWarnings: readonly string[],
  baseWarnings: readonly string[],
): ComposedWarnings {
  const historyIncomplete = baseWarnings.some(
    (warning) => warning === HISTORY_INCOMPLETE_NOTE || WARNING_OMISSION_PATTERN.test(warning),
  )
  const inherited = baseWarnings.filter((warning) => !isGeneratedSegment(warning))
  const newWarnings = [...responseWarnings]
  const historyNotes = historyIncomplete ? [HISTORY_INCOMPLETE_NOTE] : []
  /**
   * 分段说明必须描述实际保留下来的段：旧提醒全被省略时，不能再声称后面还有
   * 「调整前提醒」。计数仍以 keptNew / keptOld 为准，不改变省略条数。
   */
  const headerFor = (keptNewCount: number, keptOldCount: number) =>
    buildAiHeader(dayNumber, totalDays, keptNewCount > 0, keptOldCount > 0)
  const fitsWithoutOmission =
    1 +
      newWarnings.length +
      historyNotes.length +
      (inherited.length > 0 ? 1 + inherited.length : 0) <=
    MAX_REPLAN_WARNINGS
  if (fitsWithoutOmission) {
    return {
      warnings: [
        headerFor(newWarnings.length, inherited.length),
        ...newWarnings,
        ...historyNotes,
        ...(inherited.length > 0 ? [buildOldHeader(inherited.length)] : []),
        ...inherited,
      ],
      keptNew: newWarnings.length,
      omittedNew: 0,
      keptOld: inherited.length,
      omittedOld: 0,
    }
  }

  // 留出首部说明、历史不完整说明与末尾省略行，其余名额先给新提醒，
  // 再给旧提醒（旧段需要独立分段头 + 至少 1 条）。
  const contentSlots = MAX_REPLAN_WARNINGS - 2 - historyNotes.length
  const keptNew = Math.min(newWarnings.length, contentSlots)
  const remaining = contentSlots - keptNew
  const keptOld = inherited.length > 0 && remaining >= 2 ? Math.min(inherited.length, remaining - 1) : 0
  const keptNewWarnings = selectNewWarnings(newWarnings, keptNew)
  const keptOldWarnings = inherited.slice(0, keptOld)
  const omittedNew = newWarnings.length - keptNew
  const omittedOld = inherited.length - keptOld

  const warnings = [headerFor(keptNew, keptOld), ...keptNewWarnings, ...historyNotes]
  if (keptOld > 0) warnings.push(buildOldHeader(keptOld))
  warnings.push(...keptOldWarnings)
  warnings.push(buildOmissionLine(omittedNew, omittedOld))
  return { warnings, keptNew, omittedNew, keptOld, omittedOld }
}

function buildTripSummary(days: readonly TripDay[], dayNumber: number): string {
  const totalStops = days.reduce((total, day) => total + day.stops.length, 0)
  const rest =
    days.length > 1
      ? `其余 ${days.length - 1} 天沿用调整前安排`
      : '这是行程里唯一的一天'
  return (
    `AI 单日调整副本（未重新规划其它天）：第${dayNumber}天已按 AI 候选替换，${rest}；` +
    `共 ${days.length} 天、${totalStops} 个站点。本次没有重新核实预约、营业状态或实时交通，` +
    '占位时间与地图降级说明见行程提醒，原推荐摘要不再代表当前方案。'
  )
}

/**
 * 显式应用候选：只替换目标日，返回新 fork Trip。
 * 父 id / revision 不匹配、候选站点与其它天撞 id、结构或 640 KB 容量不过关都整体拒绝，
 * 原行程与所有输入保持不变；不自动保存，parent 令牌不写进 Trip v1。
 */
export function applyDayReplan(input: ApplyDayReplanInput): DayReplanApplyResult {
  const { baseTrip, request, response, currentRevision, forkTripId } = input
  const baseShape = checkTripShape(baseTrip)
  if (!baseShape.ok) {
    return applyFailure(
      baseShape.reason === 'too_large' ? 'base_too_large' : 'invalid_base',
      '当前行程没有通过本地结构校验，AI 候选无法安全应用；原始行程保持不变。',
    )
  }
  if (!isSafeRevision(currentRevision)) {
    return applyFailure('invalid_revision', '当前 revision 必须是安全非负整数，AI 候选未应用。')
  }
  if (
    !isBoundedText(forkTripId, MAX_REPLAN_TRIP_ID_LENGTH) ||
    forkTripId === baseTrip.id
  ) {
    return applyFailure(
      'invalid_fork_id',
      `新副本 id 必须是 1-${MAX_REPLAN_TRIP_ID_LENGTH} 字非空字符串且不等于当前行程 id；AI 候选未应用。`,
    )
  }
  if (!isRecord(request) || !isRecord(request.parent)) {
    return applyFailure('request_mismatch', '请求上下文不完整，AI 候选未应用。')
  }
  if (request.parent.trip_id !== baseTrip.id) {
    return applyFailure('parent_mismatch', '候选请求的父行程与当前行程不一致，AI 候选未应用。')
  }
  if (request.parent.revision !== currentRevision) {
    return applyFailure(
      'stale_request',
      '这份 AI 候选基于旧版本的行程（父 revision 已变化），不能覆盖当前内容；请重新发起调整。',
    )
  }
  if (
    !isIntegerInRange(request.day, 1, MAX_REPLAN_DAYS) ||
    (request.date !== null && !isStrictDate(request.date)) ||
    request.destination !== baseTrip.destination
  ) {
    return applyFailure('request_mismatch', '候选请求与当前行程的目标日或目的地不一致，AI 候选未应用。')
  }
  const baseDay = baseTrip.days.find((day) => day.day === request.day)
  if (!baseDay) {
    return applyFailure('unknown_day', `当前行程里没有第 ${request.day} 天，AI 候选未应用。`)
  }
  if (baseDay.date !== request.date) {
    return applyFailure(
      'stale_request',
      '目标日的日期已经变化，这份候选基于旧内容，AI 候选未应用。',
    )
  }

  const validated = validateDayReplanResponse(response, request)
  if (!validated.ok) {
    return applyFailure('invalid_response', `AI 候选没有通过结构校验：${validated.message}`)
  }

  const candidateDay = validated.response.day
  const otherDayStopIds = new Set<string>()
  for (const day of baseTrip.days) {
    if (day.day === request.day) continue
    for (const stop of day.stops) otherDayStopIds.add(stop.id)
  }
  for (const stop of candidateDay.stops) {
    if (otherDayStopIds.has(stop.id)) {
      return applyFailure(
        'cross_day_id_conflict',
        `候选站点 id「${stop.id}」与其它天已有站点冲突，AI 候选未应用；不会改动其它日期或站点 id。`,
      )
    }
  }

  const days = baseTrip.days.map((day) => (day.day === request.day ? candidateDay : day))
  const composed = composeWarnings(
    request.day,
    days.length,
    validated.response.warnings,
    baseTrip.warnings,
  )
  const trip: Trip = {
    id: forkTripId,
    source: baseTrip.source,
    destination: baseTrip.destination,
    title: baseTrip.title,
    summary: buildTripSummary(days, request.day),
    map_coordinate_system: baseTrip.map_coordinate_system,
    warnings: composed.warnings,
    days,
  }

  const postShape = checkTripShape(trip)
  if (!postShape.ok) {
    return applyFailure(
      'postcondition_failed',
      '应用后的行程没有通过本地结构校验，这次应用已放弃，原始行程保持不变。',
    )
  }
  let recordBytes: number
  try {
    recordBytes = savedTripRecordBytes(trip)
  } catch {
    return applyFailure(
      'postcondition_failed',
      '应用后的行程无法序列化，这次应用已放弃，原始行程保持不变。',
    )
  }
  if (recordBytes > MAX_SAVED_TRIP_BYTES) {
    return applyFailure(
      'capacity_exceeded',
      `应用后的行程约 ${Math.ceil(recordBytes / 1024)} KB，会超过单份 ${Math.round(MAX_SAVED_TRIP_BYTES / 1024)} KB 的保存与备份上限，` +
        '这次应用已放弃，原始行程与候选几何都没有被改动或截断。',
    )
  }

  return {
    ok: true,
    trip,
    changedDays: [request.day],
    newWarningCount: validated.response.warnings.length,
    keptNewWarnings: composed.keptNew,
    omittedNewWarnings: composed.omittedNew,
    keptOldWarnings: composed.keptOld,
    omittedOldWarnings: composed.omittedOld,
    omittedWarnings: composed.omittedNew + composed.omittedOld,
    notices: [DAY_REPLAN_APPLY_NOTICE, DAY_REPLAN_WARNINGS_NOTICE],
  }
}

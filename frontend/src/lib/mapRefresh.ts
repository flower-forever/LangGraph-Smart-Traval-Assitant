/**
 * 单日地图刷新（POST /api/trips/days/map-refresh）的前端纯函数契约。
 *
 * 边界：
 * - 纯函数：不读时间 / 本地存储 / 网络，不生成 id、不递增 revision、不自动保存。
 *   新副本 id 与父 revision 全部由调用方显式给出。
 * - 请求只投影目标日的站点文字字段（id / name / address），坐标、几何、路线说明都不进请求；
 *   站点 id 按原值透传，不按 `|` 拆段，也不从 `id` 里推断任何索引。
 * - 响应按 unknown 做严格运行时校验：parent / day / date 必须与请求一致，成功站点与
 *   unresolved 的 id 必须互斥且并集等于请求 id，且各自保持请求顺序；legs 覆盖全部相邻对、
 *   mode 等于请求 mode、几何为 WGS84 且满足单段 / 全量点数预算；map_status 与内容自洽。
 *   任何一处不合法都整包拒绝，不做局部采纳、不补点、不补 leg。
 * - 应用：base 不可变，只改目标天的 stops[].location、legs 和全局 warnings；其它天对象
 *   与几何保持原引用。resolved_address 仅供预览展示，绝不写进用户的 stop.address。
 * - 没有地图字段的实质变化（坐标与 leg 数值都相同）时返回 base 本身，不 fork、不改提醒；
 *   no_key / timeout / failed / unavailable 等空补丁同样 no-op。
 * - 旧 warnings 不按前缀或完整模板推断“这是自己写的”后删除；旧文本原文保留到容量上限，
 *   超出时写准确省略条数，并保留“历史提醒不完整”的永久信号。
 */

import type { TravelMode, Trip, TripDay, TripLeg, TripLocation, TripStop } from './api'
import type { MapStatus } from './dayReplan'
import {
  MAX_GEOMETRY_POINTS_PER_LEG,
  MAX_SAVED_TRIP_BYTES,
  MAX_TOTAL_GEOMETRY_POINTS,
  checkTripShape,
  savedTripRecordBytes,
} from './savedTrips'

export type { MapStatus }

// ==================== 后端契约上限 ====================

export const MAX_MAP_REFRESH_DESTINATION_LENGTH = 80
export const MAX_MAP_REFRESH_DAYS = 7
export const MAX_MAP_REFRESH_STOPS = 8
export const MAX_MAP_REFRESH_TRIP_ID_LENGTH = 100
export const MAX_MAP_REFRESH_STOP_ID_LENGTH = 100
export const MAX_MAP_REFRESH_STOP_NAME_LENGTH = 120
export const MAX_MAP_REFRESH_STOP_ADDRESS_LENGTH = 300
export const MAX_MAP_REFRESH_REVISION = Number.MAX_SAFE_INTEGER
export const MAX_MAP_REFRESH_WARNINGS = 40
export const MAX_MAP_REFRESH_WARNING_LENGTH = 2_000
export const MAX_MAP_REFRESH_LEG_DESCRIPTION_LENGTH = 500
export const MAX_MAP_REFRESH_RESOLVED_ADDRESS_LENGTH = 1_000
export const MAX_MAP_REFRESH_REASON_LENGTH = 1_000
export const MAX_MAP_REFRESH_REASON_CODE_LENGTH = 100

/** 刷新后仍无可用路线时的诚实说明；不假装旧几何还能用。 */
export const MAP_REFRESH_UNAVAILABLE_LEG_DESCRIPTION = '地图刷新后待重新获取路线'
export const MAP_REFRESH_WARNING_PREFIX = '【地图刷新】'
export const PRE_MAP_REFRESH_WARNING_PREFIX = '【刷新前提醒】'
export const MAP_REFRESH_OMISSION_PREFIX = '【提醒省略】'
export const MAP_REFRESH_HISTORY_INCOMPLETE_NOTE =
  `【历史提醒不完整】地图刷新曾因 ${MAX_MAP_REFRESH_WARNINGS} 条提醒上限省略过提醒；` +
  '这次继承的刷新前提醒不是全部内容，不能据此判断没有其它提醒。'

export const MAP_REFRESH_APPLY_NOTICE =
  '本次只更新目标天的地图坐标与路线，不会自动保存；保存、导出和备份仍由你显式操作。'
export const MAP_REFRESH_WARNINGS_NOTICE =
  '地图刷新不会重新核对预约、营业状态或实时交通；刷新前的提醒原文保留，需要自行判断是否仍然成立。'

const MAP_STATUSES: ReadonlySet<string> = new Set<MapStatus>([
  'ready',
  'partial',
  'unavailable',
  'no_key',
  'timeout',
  'failed',
])
const HARD_MAP_STATUSES: ReadonlySet<MapStatus> = new Set<MapStatus>([
  'unavailable',
  'no_key',
  'timeout',
  'failed',
])

// ==================== 请求 ====================

/** 请求里的站点只有文字字段；坐标永远由服务端地图环节决定。 */
export interface MapRefreshStopProjection {
  id: string
  name: string
  address: string
}

/** 父行程版本令牌：与后端一样只回显、不落库。 */
export interface MapRefreshParent {
  trip_id: string
  revision: number
}

/** POST /api/trips/days/map-refresh 的请求体（字段名与后端严格一致）。 */
export interface MapRefreshRequest {
  destination: string
  day: number
  date: string | null
  travel_mode: TravelMode
  parent: MapRefreshParent
  stops: MapRefreshStopProjection[]
}

export interface BuildMapRefreshOptions {
  /** 由调用方显式给出，不从旧 leg 里猜。 */
  travel_mode: TravelMode
  /** 构造请求时的父 revision；应用时还必须与界面当前 revision 相等。 */
  parentRevision: number
}

export type MapRefreshBuildFailureReason =
  | 'invalid_trip'
  | 'invalid_parent_trip_id'
  | 'invalid_destination'
  | 'invalid_day'
  | 'unknown_day'
  | 'duplicate_day'
  | 'invalid_options'
  | 'invalid_mode'
  | 'invalid_parent_revision'
  | 'invalid_date'
  | 'too_many_stops'
  | 'no_stops'
  | 'invalid_stop'
  | 'duplicate_stop_id'

export interface MapRefreshBuildFailure {
  ok: false
  reason: MapRefreshBuildFailureReason
  message: string
}

export type MapRefreshBuildResult =
  | { ok: true; request: MapRefreshRequest }
  | MapRefreshBuildFailure

// ==================== 响应 ====================

export interface MapRefreshResolvedStop {
  id: string
  /** 非 null；WGS84 的 { lng, lat } 原结构。 */
  location: TripLocation
  /** 解析时返回 / 使用的地址记录，仅供查看，不写回用户 address。 */
  resolved_address: string | null
}

export interface MapRefreshUnresolvedStop {
  id: string
  reason_code: string
  reason: string
}

/** 后端返回的地图补丁；不含 Trip，也不含 source。 */
export interface MapRefreshResponse {
  day: number
  date: string | null
  parent: MapRefreshParent
  map_status: MapStatus
  stops: MapRefreshResolvedStop[]
  unresolved: MapRefreshUnresolvedStop[]
  legs: TripLeg[]
  warnings: string[]
}

export type MapRefreshValidation =
  | { ok: true; response: MapRefreshResponse }
  | { ok: false; message: string }

// ==================== 预览 / 应用 ====================

export interface MapRefreshPointStats {
  /** 本次采用且与 base 不同的坐标数（含 null -> 有值）。 */
  refreshed: number
  /** 本次返回但坐标数值与 base 完全相同。 */
  unchanged: number
  /** 本次未返回，保留 base 原值（含原 null）。 */
  notReturned: number
  /** null -> 有值。 */
  added: number
  /** 有值 -> 另一个值。 */
  updated: number
}

export interface MapRefreshLegStats {
  /** 采用本次可用新路线（navigation / straight_line）的段数。 */
  refreshed: number
  /** 新路线不可用，但端点、相邻关系与 mode 都没变，沿用旧 leg 原对象的段数。 */
  retained: number
  /** 因端点 / 相邻关系 / mode 变化且无可用新路线，旧几何与距离、耗时被作废的段数。 */
  invalidated: number
}

export interface MapRefreshWarningStats {
  /** 响应里本次返回的提醒总数。 */
  newWarningCount: number
  keptNewWarnings: number
  omittedNewWarnings: number
  keptOldWarnings: number
  omittedOldWarnings: number
  /** omittedNewWarnings + omittedOldWarnings。 */
  omittedWarnings: number
  /** 旧提醒是否已不完整（本次截断，或继承的旧数据里已有省略信号）。 */
  historyIncomplete: boolean
}

export interface PreviewMapRefreshInput {
  /** 当前显示 / 已保存的行程；不会被修改。 */
  baseTrip: Trip
  /** 构造补丁时发出去的请求，用于核对父版本、目标日与当前投影。 */
  request: MapRefreshRequest
  /** 服务端返回的 unknown 补丁；内部会再做一次严格校验。 */
  response: unknown
  /** 界面当前的 revision；与 request.parent.revision 不一致视为过期。 */
  currentRevision: number
}

export type MapRefreshFailureReason =
  | 'invalid_base'
  | 'base_too_large'
  | 'invalid_revision'
  | 'invalid_fork_id'
  | 'invalid_request'
  | 'parent_mismatch'
  | 'stale_request'
  | 'request_mismatch'
  | 'unknown_day'
  | 'invalid_response'
  | 'postcondition_failed'
  | 'capacity_exceeded'

export interface MapRefreshFailure {
  ok: false
  reason: MapRefreshFailureReason
  message: string
}

export interface MapRefreshPreviewSuccess {
  ok: true
  changed: boolean
  changedDays: number[]
  day: TripDay
  /** 若应用将得到的提醒；未变化时就是 base 的原数组。 */
  warnings: string[]
  points: MapRefreshPointStats
  legs: MapRefreshLegStats
  warningStats: MapRefreshWarningStats
  omittedWarnings: number
  notices: string[]
}

export type MapRefreshPreviewResult = MapRefreshPreviewSuccess | MapRefreshFailure

export interface ApplyMapRefreshInput extends PreviewMapRefreshInput {
  /** 由调用方生成的新副本 id：1-100 字且不等于 baseTrip.id。 */
  forkTripId: string
}

export interface MapRefreshApplySuccess {
  ok: true
  changed: boolean
  trip: Trip
  changedDays: number[]
  points: MapRefreshPointStats
  legs: MapRefreshLegStats
  warningStats: MapRefreshWarningStats
  omittedWarnings: number
  notices: string[]
}

export type MapRefreshApplyResult = MapRefreshApplySuccess | MapRefreshFailure

// ==================== 通用校验 ====================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
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

const LOCATION_KEYS: ReadonlySet<string> = new Set(['lng', 'lat'])
const REQUEST_KEYS: ReadonlySet<string> = new Set([
  'destination',
  'day',
  'date',
  'travel_mode',
  'parent',
  'stops',
])
const REQUEST_STOP_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'address'])
const PARENT_KEYS: ReadonlySet<string> = new Set(['trip_id', 'revision'])
const RESPONSE_KEYS: ReadonlySet<string> = new Set([
  'day',
  'date',
  'parent',
  'map_status',
  'stops',
  'unresolved',
  'legs',
  'warnings',
])
const RESPONSE_STOP_KEYS: ReadonlySet<string> = new Set([
  'id',
  'location',
  'resolved_address',
])
const UNRESOLVED_KEYS: ReadonlySet<string> = new Set(['id', 'reason_code', 'reason'])
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

// ==================== 请求构造 ====================

function buildFailure(
  reason: MapRefreshBuildFailureReason,
  message: string,
): MapRefreshBuildFailure {
  return { ok: false, reason, message }
}

/**
 * 从当前 Trip、目标 day 与显式选项构造地图刷新请求。
 * 目标日缺失 / 重复、字段超限、日期不是严格 YYYY-MM-DD、站点超过 8 个都明确拒绝；
 * 不截字、不截站、不静默把日期改成 null，原 Trip 不被修改。
 */
export function buildMapRefreshRequest(
  baseTrip: Trip,
  day: number,
  options: BuildMapRefreshOptions,
): MapRefreshBuildResult {
  if (!isRecord(baseTrip)) {
    return buildFailure('invalid_trip', '当前行程不是对象，未发起地图刷新。')
  }
  if (!isBoundedText(baseTrip.id, MAX_MAP_REFRESH_TRIP_ID_LENGTH)) {
    return buildFailure(
      'invalid_parent_trip_id',
      `当前行程 id 必须是 1-${MAX_MAP_REFRESH_TRIP_ID_LENGTH} 字非空字符串，才能作为父行程令牌；未发起地图刷新。`,
    )
  }
  if (!isBoundedText(baseTrip.destination, MAX_MAP_REFRESH_DESTINATION_LENGTH)) {
    return buildFailure(
      'invalid_destination',
      `目的地必须是 1-${MAX_MAP_REFRESH_DESTINATION_LENGTH} 字非空字符串；这次没有截断，未发起地图刷新。`,
    )
  }
  if (!isIntegerInRange(day, 1, MAX_MAP_REFRESH_DAYS)) {
    return buildFailure(
      'invalid_day',
      `目标日必须是 1-${MAX_MAP_REFRESH_DAYS} 的整数，未发起地图刷新。`,
    )
  }
  if (!isRecord(options)) {
    return buildFailure('invalid_options', '缺少出行方式与父 revision，未发起地图刷新。')
  }
  if (options.travel_mode !== 'walking' && options.travel_mode !== 'driving') {
    return buildFailure('invalid_mode', '出行方式只能是 walking 或 driving，未发起地图刷新。')
  }
  if (!isSafeRevision(options.parentRevision)) {
    return buildFailure(
      'invalid_parent_revision',
      '父 revision 必须是 0 到 2^53-1 的安全整数，未发起地图刷新。',
    )
  }
  if (!Array.isArray(baseTrip.days)) {
    return buildFailure('invalid_trip', '当前行程缺少天数组，未发起地图刷新。')
  }
  const matches: unknown[] = []
  for (const item of baseTrip.days) {
    if (isRecord(item) && item.day === day) matches.push(item)
  }
  if (matches.length === 0) {
    return buildFailure('unknown_day', `当前行程里没有第 ${day} 天，未发起地图刷新。`)
  }
  if (matches.length > 1) {
    return buildFailure(
      'duplicate_day',
      `当前行程里第 ${day} 天出现了 ${matches.length} 次，无法确定要刷新哪一天；未发起地图刷新。`,
    )
  }
  const sourceDay = matches[0]
  if (!isRecord(sourceDay) || !Array.isArray(sourceDay.stops)) {
    return buildFailure('invalid_trip', `第 ${day} 天的站点数据结构不完整，未发起地图刷新。`)
  }
  const date = sourceDay.date
  if (date !== null && !isStrictDate(date)) {
    return buildFailure(
      'invalid_date',
      `第 ${day} 天的日期不是严格 YYYY-MM-DD 或 null；不会静默改成 null，未发起地图刷新。`,
    )
  }
  if (sourceDay.stops.length === 0) {
    return buildFailure('no_stops', `第 ${day} 天没有站点，未发起地图刷新。`)
  }
  if (sourceDay.stops.length > MAX_MAP_REFRESH_STOPS) {
    return buildFailure(
      'too_many_stops',
      `第 ${day} 天有 ${sourceDay.stops.length} 个站点，超过单日地图刷新上限 ${MAX_MAP_REFRESH_STOPS} 个；这次没有截断，未发起地图刷新。请先在本地编辑里精简站点。`,
    )
  }

  const stops: MapRefreshStopProjection[] = []
  const seenIds = new Set<string>()
  for (let index = 0; index < sourceDay.stops.length; index += 1) {
    const value: unknown = sourceDay.stops[index]
    const label = `目标日第 ${index + 1} 个站点`
    if (!isRecord(value)) {
      return buildFailure('invalid_stop', `${label}不是对象，未发起地图刷新。`)
    }
    if (!isBoundedText(value.id, MAX_MAP_REFRESH_STOP_ID_LENGTH)) {
      return buildFailure(
        'invalid_stop',
        `${label}的 id 必须是 1-${MAX_MAP_REFRESH_STOP_ID_LENGTH} 字非空字符串，未发起地图刷新。`,
      )
    }
    if (!isBoundedText(value.name, MAX_MAP_REFRESH_STOP_NAME_LENGTH)) {
      return buildFailure(
        'invalid_stop',
        `${label}的名称必须是 1-${MAX_MAP_REFRESH_STOP_NAME_LENGTH} 字非空字符串；这次没有截断，未发起地图刷新。`,
      )
    }
    if (!isBoundedOptionalText(value.address, MAX_MAP_REFRESH_STOP_ADDRESS_LENGTH)) {
      return buildFailure(
        'invalid_stop',
        `${label}的地址超过 ${MAX_MAP_REFRESH_STOP_ADDRESS_LENGTH} 字或不是字符串；这次没有截断，未发起地图刷新。`,
      )
    }
    if (seenIds.has(value.id)) {
      return buildFailure(
        'duplicate_stop_id',
        `第 ${day} 天存在重复的站点 id「${value.id}」；未发起地图刷新。`,
      )
    }
    seenIds.add(value.id)
    stops.push({ id: value.id, name: value.name, address: value.address })
  }

  return {
    ok: true,
    request: {
      destination: baseTrip.destination,
      day,
      date: date as string | null,
      travel_mode: options.travel_mode,
      parent: { trip_id: baseTrip.id, revision: options.parentRevision },
      stops,
    },
  }
}

// ==================== 请求校验 ====================

function checkParent(
  value: unknown,
  expected: MapRefreshParent,
  path: string,
): string | null {
  if (!isRecord(value)) return `${path} 不是对象`
  const extra = findUnknownKey(value, PARENT_KEYS)
  if (extra) return `${path} 包含未知字段 ${extra}`
  if (value.trip_id !== expected.trip_id) return `${path}.trip_id 与请求不一致`
  if (value.revision !== expected.revision) return `${path}.revision 与请求不一致`
  return null
}

/** 只校验请求本身的形状，不接触当前 Trip；失败返回可直接展示的中文说明。 */
function checkRequestShape(request: unknown): string | null {
  if (!isRecord(request)) return '请求不是对象'
  const extra = findUnknownKey(request, REQUEST_KEYS)
  if (extra) return `请求包含未知字段 ${extra}`
  if (!isBoundedText(request.destination, MAX_MAP_REFRESH_DESTINATION_LENGTH)) {
    return `请求.destination 必须是 1-${MAX_MAP_REFRESH_DESTINATION_LENGTH} 字非空字符串`
  }
  if (!isIntegerInRange(request.day, 1, MAX_MAP_REFRESH_DAYS)) {
    return `请求.day 必须是 1-${MAX_MAP_REFRESH_DAYS} 的整数`
  }
  if (request.date !== null && !isStrictDate(request.date)) {
    return '请求.date 必须是严格 YYYY-MM-DD 或 null'
  }
  if (request.travel_mode !== 'walking' && request.travel_mode !== 'driving') {
    return '请求.travel_mode 只能是 walking 或 driving'
  }
  if (!isRecord(request.parent)) return '请求.parent 不是对象'
  const parentExtra = findUnknownKey(request.parent, PARENT_KEYS)
  if (parentExtra) return `请求.parent 包含未知字段 ${parentExtra}`
  if (!isBoundedText(request.parent.trip_id, MAX_MAP_REFRESH_TRIP_ID_LENGTH)) {
    return `请求.parent.trip_id 必须是 1-${MAX_MAP_REFRESH_TRIP_ID_LENGTH} 字非空字符串`
  }
  if (!isSafeRevision(request.parent.revision)) {
    return '请求.parent.revision 必须是安全非负整数'
  }
  if (!Array.isArray(request.stops)) return '请求.stops 不是数组'
  if (request.stops.length === 0) return '请求.stops 不能为空'
  if (request.stops.length > MAX_MAP_REFRESH_STOPS) {
    return `请求.stops 不能超过 ${MAX_MAP_REFRESH_STOPS} 个`
  }
  const seen = new Set<string>()
  for (let index = 0; index < request.stops.length; index += 1) {
    const value: unknown = request.stops[index]
    const path = `请求.stops[${index}]`
    if (!isRecord(value)) return `${path} 不是对象`
    const stopExtra = findUnknownKey(value, REQUEST_STOP_KEYS)
    if (stopExtra) return `${path} 包含未知字段 ${stopExtra}`
    if (!isBoundedText(value.id, MAX_MAP_REFRESH_STOP_ID_LENGTH)) {
      return `${path}.id 必须是 1-${MAX_MAP_REFRESH_STOP_ID_LENGTH} 字非空字符串`
    }
    if (!isBoundedText(value.name, MAX_MAP_REFRESH_STOP_NAME_LENGTH)) {
      return `${path}.name 必须是 1-${MAX_MAP_REFRESH_STOP_NAME_LENGTH} 字非空字符串`
    }
    if (!isBoundedOptionalText(value.address, MAX_MAP_REFRESH_STOP_ADDRESS_LENGTH)) {
      return `${path}.address 必须是 0-${MAX_MAP_REFRESH_STOP_ADDRESS_LENGTH} 字的字符串`
    }
    if (seen.has(value.id)) return `${path}.id「${value.id}」与前面的站点重复`
    seen.add(value.id)
  }
  return null
}

// ==================== 响应校验 ====================

function checkResponseStop(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} 不是对象`
  const extra = findUnknownKey(value, RESPONSE_STOP_KEYS)
  if (extra) return `${path} 包含未知字段 ${extra}`
  if (!isBoundedText(value.id, MAX_MAP_REFRESH_STOP_ID_LENGTH)) {
    return `${path}.id 必须是 1-${MAX_MAP_REFRESH_STOP_ID_LENGTH} 字非空字符串`
  }
  const locationError = checkCoordinate(value.location, `${path}.location`)
  if (locationError) return `${path}.location 不能为 null，且必须是 WGS84 坐标`
  if (
    value.resolved_address !== null &&
    !isBoundedOptionalText(value.resolved_address, MAX_MAP_REFRESH_RESOLVED_ADDRESS_LENGTH)
  ) {
    return `${path}.resolved_address 必须是 null 或 0-${MAX_MAP_REFRESH_RESOLVED_ADDRESS_LENGTH} 字的字符串`
  }
  return null
}

function checkUnresolved(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} 不是对象`
  const extra = findUnknownKey(value, UNRESOLVED_KEYS)
  if (extra) return `${path} 包含未知字段 ${extra}`
  if (!isBoundedText(value.id, MAX_MAP_REFRESH_STOP_ID_LENGTH)) {
    return `${path}.id 必须是 1-${MAX_MAP_REFRESH_STOP_ID_LENGTH} 字非空字符串`
  }
  if (!isBoundedText(value.reason_code, MAX_MAP_REFRESH_REASON_CODE_LENGTH)) {
    return `${path}.reason_code 必须是 1-${MAX_MAP_REFRESH_REASON_CODE_LENGTH} 字非空字符串`
  }
  if (!isBoundedOptionalText(value.reason, MAX_MAP_REFRESH_REASON_LENGTH)) {
    return `${path}.reason 必须是 0-${MAX_MAP_REFRESH_REASON_LENGTH} 字的字符串`
  }
  return null
}

function checkLeg(value: unknown, path: string, budget: { points: number }): string | null {
  if (!isRecord(value)) return `${path} 不是对象`
  const extra = findUnknownKey(value, LEG_KEYS)
  if (extra) return `${path} 包含未知字段 ${extra}`
  if (!isBoundedText(value.from_stop_id, MAX_MAP_REFRESH_STOP_ID_LENGTH)) {
    return `${path}.from_stop_id 必须是 1-${MAX_MAP_REFRESH_STOP_ID_LENGTH} 字非空字符串`
  }
  if (!isBoundedText(value.to_stop_id, MAX_MAP_REFRESH_STOP_ID_LENGTH)) {
    return `${path}.to_stop_id 必须是 1-${MAX_MAP_REFRESH_STOP_ID_LENGTH} 字非空字符串`
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
  if (!isBoundedOptionalText(value.description, MAX_MAP_REFRESH_LEG_DESCRIPTION_LENGTH)) {
    return `${path}.description 必须是 0-${MAX_MAP_REFRESH_LEG_DESCRIPTION_LENGTH} 字的字符串`
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

function validatedMapStatus(value: Record<string, unknown>): MapStatus | null {
  const status = value.map_status
  return typeof status === 'string' && MAP_STATUSES.has(status) ? (status as MapStatus) : null
}

function checkIdOrder(
  ids: readonly string[],
  order: ReadonlyMap<string, number>,
  path: string,
): string | null {
  let last = -1
  for (const id of ids) {
    const index = order.get(id)
    if (index === undefined) return `${path} 出现请求里没有的站点 id「${id}」`
    if (index <= last) return `${path} 的站点 id 没有保持请求里的原顺序`
    last = index
  }
  return null
}

/**
 * 对 unknown 响应做运行时校验。失败即整包拒绝，绝不补坐标、补 leg 或改状态。
 * 只使用传入的 request 做父令牌 / 目标日 / id 投影比对，不读取任何隐式当前行程状态。
 */
export function validateMapRefreshResponse(
  value: unknown,
  request: MapRefreshRequest,
): MapRefreshValidation {
  const requestError = checkRequestShape(request)
  if (requestError) return { ok: false, message: `请求上下文不完整：${requestError}` }
  if (!isRecord(value)) return { ok: false, message: '响应不是 JSON 对象' }
  const extra = findUnknownKey(value, RESPONSE_KEYS)
  if (extra) return { ok: false, message: `响应包含未知字段 ${extra}` }

  const mapStatus = validatedMapStatus(value)
  if (mapStatus === null) {
    return { ok: false, message: '响应.map_status 不是受支持的状态' }
  }
  if (value.day !== request.day) {
    return { ok: false, message: `响应.day 必须等于请求的第 ${request.day} 天` }
  }
  if (value.date !== request.date) {
    return { ok: false, message: '响应.date 与请求日期不一致' }
  }
  const parentError = checkParent(value.parent, request.parent, '响应.parent')
  if (parentError) return { ok: false, message: parentError }

  if (!Array.isArray(value.warnings)) return { ok: false, message: '响应.warnings 不是数组' }
  if (value.warnings.length > MAX_MAP_REFRESH_WARNINGS) {
    return { ok: false, message: `响应.warnings 超过 ${MAX_MAP_REFRESH_WARNINGS} 条上限` }
  }
  for (let index = 0; index < value.warnings.length; index += 1) {
    const warning: unknown = value.warnings[index]
    if (!isBoundedOptionalText(warning, MAX_MAP_REFRESH_WARNING_LENGTH)) {
      return {
        ok: false,
        message: `响应.warnings[${index}] 必须是 0-${MAX_MAP_REFRESH_WARNING_LENGTH} 字的字符串`,
      }
    }
  }

  if (!Array.isArray(value.stops)) return { ok: false, message: '响应.stops 不是数组' }
  if (!Array.isArray(value.unresolved)) {
    return { ok: false, message: '响应.unresolved 不是数组' }
  }
  if (!Array.isArray(value.legs)) return { ok: false, message: '响应.legs 不是数组' }

  const order = new Map<string, number>()
  request.stops.forEach((stop, index) => order.set(stop.id, index))
  const stopIds: string[] = []
  for (let index = 0; index < value.stops.length; index += 1) {
    const error = checkResponseStop(value.stops[index], `响应.stops[${index}]`)
    if (error) return { ok: false, message: error }
    const stop = value.stops[index] as Record<string, unknown>
    stopIds.push(stop.id as string)
  }
  const unresolvedIds: string[] = []
  for (let index = 0; index < value.unresolved.length; index += 1) {
    const error = checkUnresolved(value.unresolved[index], `响应.unresolved[${index}]`)
    if (error) return { ok: false, message: error }
    const item = value.unresolved[index] as Record<string, unknown>
    unresolvedIds.push(item.id as string)
  }
  if (new Set(stopIds).size !== stopIds.length) {
    return { ok: false, message: '响应.stops 存在重复的站点 id' }
  }
  if (new Set(unresolvedIds).size !== unresolvedIds.length) {
    return { ok: false, message: '响应.unresolved 存在重复的站点 id' }
  }
  const resolvedSet = new Set(stopIds)
  for (const id of unresolvedIds) {
    if (resolvedSet.has(id)) {
      return { ok: false, message: `站点 id「${id}」同时出现在 stops 与 unresolved，不能重复` }
    }
  }
  const orderError =
    checkIdOrder(stopIds, order, '响应.stops') ?? checkIdOrder(unresolvedIds, order, '响应.unresolved')
  if (orderError) return { ok: false, message: orderError }
  if (new Set([...stopIds, ...unresolvedIds]).size !== request.stops.length) {
    return { ok: false, message: '响应.stops 与 unresolved 的并集必须覆盖请求里的全部站点 id' }
  }

  const expectedLegs = Math.max(request.stops.length - 1, 0)
  if (HARD_MAP_STATUSES.has(mapStatus)) {
    if (stopIds.length > 0 || value.legs.length > 0) {
      return { ok: false, message: `map_status=${mapStatus} 时 stops 与 legs 必须为空` }
    }
    if (unresolvedIds.length !== request.stops.length) {
      return {
        ok: false,
        message: `map_status=${mapStatus} 时 unresolved 必须覆盖请求里的全部站点 id`,
      }
    }
  } else {
    if (value.legs.length !== expectedLegs) {
      return {
        ok: false,
        message: `响应.legs 必须恰好覆盖相邻站点链（期望 ${expectedLegs} 段，实际 ${value.legs.length} 段）`,
      }
    }
    const budget = { points: 0 }
    for (let index = 0; index < value.legs.length; index += 1) {
      const error = checkLeg(value.legs[index], `响应.legs[${index}]`, budget)
      if (error) return { ok: false, message: error }
      const leg = value.legs[index] as Record<string, unknown>
      const from = request.stops[index]
      const to = request.stops[index + 1]
      if (leg.from_stop_id !== from.id || leg.to_stop_id !== to.id) {
        return {
          ok: false,
          message: `响应.legs[${index}] 必须连接第 ${index + 1} 与第 ${index + 2} 个站点，顺序不能错位`,
        }
      }
      if (leg.mode !== request.travel_mode) {
        return { ok: false, message: `响应.legs[${index}].mode 必须等于请求的出行方式` }
      }
    }
  }

  if (mapStatus === 'ready') {
    if (stopIds.length !== request.stops.length || unresolvedIds.length > 0) {
      return { ok: false, message: 'map_status=ready 但并非全部站点都解析成功' }
    }
    const allNavigation = (value.legs as unknown[]).every((leg) => {
      return isRecord(leg) && leg.route_type === 'navigation'
    })
    if (!allNavigation) {
      return { ok: false, message: 'map_status=ready 但存在非 navigation 的相邻路线' }
    }
  } else if (mapStatus === 'partial') {
    if (stopIds.length === 0) {
      return { ok: false, message: 'map_status=partial 但没有任何解析成功的站点' }
    }
    const allStops = stopIds.length === request.stops.length
    const allNavigation = (value.legs as unknown[]).every((leg) => {
      return isRecord(leg) && leg.route_type === 'navigation'
    })
    if (allStops && allNavigation) {
      return { ok: false, message: 'map_status=partial 与完整的坐标 / 导航路线不一致，应为 ready' }
    }
  }

  return { ok: true, response: value as unknown as MapRefreshResponse }
}

// ==================== 合并 ====================

interface MergeOutcome {
  day: TripDay
  warnings: string[]
  changed: boolean
  points: MapRefreshPointStats
  legs: MapRefreshLegStats
  warningStats: MapRefreshWarningStats
  omittedWarnings: number
  notices: string[]
}

function emptyWarningStats(): MapRefreshWarningStats {
  return {
    newWarningCount: 0,
    keptNewWarnings: 0,
    omittedNewWarnings: 0,
    keptOldWarnings: 0,
    omittedOldWarnings: 0,
    omittedWarnings: 0,
    historyIncomplete: false,
  }
}

function sameLocation(a: TripLocation | null, b: TripLocation | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.lng === b.lng && a.lat === b.lat
}

function sameLegMap(a: TripLeg, b: TripLeg): boolean {
  if (
    a.from_stop_id !== b.from_stop_id ||
    a.to_stop_id !== b.to_stop_id ||
    a.mode !== b.mode ||
    a.route_type !== b.route_type ||
    a.distance_m !== b.distance_m ||
    a.duration_minutes !== b.duration_minutes ||
    a.geometry.length !== b.geometry.length
  ) {
    return false
  }
  for (let index = 0; index < a.geometry.length; index += 1) {
    if (!sameLocation(a.geometry[index], b.geometry[index])) return false
  }
  return true
}

/** 地图字段的实质比对：坐标与 leg 数值；说明文字不同不算变化。 */
function sameDayMap(a: TripDay, b: TripDay): boolean {
  if (a.stops.length !== b.stops.length || a.legs.length !== b.legs.length) return false
  for (let index = 0; index < a.stops.length; index += 1) {
    const left = a.stops[index]
    const right = b.stops[index]
    if (left.id !== right.id || !sameLocation(left.location, right.location)) return false
  }
  for (let index = 0; index < a.legs.length; index += 1) {
    if (!sameLegMap(a.legs[index], b.legs[index])) return false
  }
  return true
}

function copyLeg(leg: TripLeg): TripLeg {
  return {
    from_stop_id: leg.from_stop_id,
    to_stop_id: leg.to_stop_id,
    mode: leg.mode,
    route_type: leg.route_type,
    distance_m: leg.distance_m,
    duration_minutes: leg.duration_minutes,
    geometry: leg.geometry.map((point) => ({ lng: point.lng, lat: point.lat })),
    description: leg.description,
  }
}

function unavailableLeg(fromId: string, toId: string, mode: TravelMode): TripLeg {
  return {
    from_stop_id: fromId,
    to_stop_id: toId,
    mode,
    route_type: 'unavailable',
    distance_m: null,
    duration_minutes: null,
    geometry: [],
    description: MAP_REFRESH_UNAVAILABLE_LEG_DESCRIPTION,
  }
}

function hasIncompleteHistory(warnings: readonly string[]): boolean {
  return warnings.some(
    (warning) =>
      warning === MAP_REFRESH_HISTORY_INCOMPLETE_NOTE ||
      warning.startsWith(MAP_REFRESH_OMISSION_PREFIX),
  )
}

function selectNewWarnings(warnings: readonly string[], count: number): string[] {
  if (count >= warnings.length) return [...warnings]
  if (count <= 0) return []
  if (count === 1) return [warnings[0]]
  return [...warnings.slice(0, count - 1), warnings[warnings.length - 1]]
}

function buildRefreshHeader(dayNumber: number, status: MapStatus): string {
  const partial =
    status === 'partial'
      ? '；只取得部分站点或路段的本次结果，未返回或无法安全沿用的部分按规则保留或失效'
      : ''
  return (
    `${MAP_REFRESH_WARNING_PREFIX}第${dayNumber}天的站点坐标与相邻路线已按本次地图结果更新${partial}。` +
    '本次没有重新规划行程，也没有重新核对预约、营业状态或实时交通；' +
    '刷新前的提醒原文保留，尚未重新核对。'
  )
}

function buildOldHeader(keptOld: number): string {
  return (
    `${PRE_MAP_REFRESH_WARNING_PREFIX}以下 ${keptOld} 条是本次地图刷新前已有的提醒，` +
    '原文保留、尚未重新核对；它们既不能当成仍然成立，也不能当成已经排除。'
  )
}

function buildOmissionLine(omittedNew: number, omittedOld: number): string {
  return (
    `${MAP_REFRESH_OMISSION_PREFIX}为不超过 ${MAX_MAP_REFRESH_WARNINGS} 条提醒上限，` +
    `省略${omittedNew}条本次返回提醒/${omittedOld}条刷新前提醒；` +
    '这里统计的是被省略的条目数，不代表实际冲突总数。'
  )
}

interface ComposedWarnings {
  warnings: string[]
  stats: MapRefreshWarningStats
}

/**
 * 组合本次返回的提醒与刷新前提醒。
 * - 旧提醒逐字保留到容量上限，不按前缀 / 完整模板推断来源后删除；导入文件里同样的文本也照旧保留。
 * - 新提醒放不下时保留首项与末项；旧提醒只保留能放下的前缀。
 * - 只要旧提醒被省略，就保留一条明确的「历史提醒不完整」说明；之后继续刷新不会丢这个信号。
 */
function composeWarnings(
  dayNumber: number,
  status: MapStatus,
  responseWarnings: readonly string[],
  baseWarnings: readonly string[],
  legMetricsChanged: boolean,
): ComposedWarnings {
  const header = buildRefreshHeader(dayNumber, status)
  const metricsLines = legMetricsChanged
    ? ['本次有路段的距离或耗时更新，此前与耗时相关的提醒没有重新计算。']
    : []
  const full = [
    header,
    ...metricsLines,
    ...responseWarnings,
    ...(baseWarnings.length > 0 ? [buildOldHeader(baseWarnings.length), ...baseWarnings] : []),
  ]
  const inheritedIncomplete = hasIncompleteHistory(baseWarnings)
  // 「历史提醒不完整」说明：自身历史没有这行原文，继承的信号才需要补一行。
  const addNoteToFull =
    inheritedIncomplete &&
    !responseWarnings.includes(MAP_REFRESH_HISTORY_INCOMPLETE_NOTE) &&
    !baseWarnings.includes(MAP_REFRESH_HISTORY_INCOMPLETE_NOTE)
  if (full.length + (addNoteToFull ? 1 : 0) <= MAX_MAP_REFRESH_WARNINGS) {
    const warnings = [...full]
    if (addNoteToFull) warnings.push(MAP_REFRESH_HISTORY_INCOMPLETE_NOTE)
    return {
      warnings,
      stats: {
        newWarningCount: responseWarnings.length,
        keptNewWarnings: responseWarnings.length,
        omittedNewWarnings: 0,
        keptOldWarnings: baseWarnings.length,
        omittedOldWarnings: 0,
        omittedWarnings: 0,
        historyIncomplete: inheritedIncomplete,
      },
    }
  }

  // 全量放不下：header、可选耗时说明与省略行固定占位；新提醒优先保留首尾，
  // 剩余格给旧提醒原文。旧提醒被省略，或者继承的不完整信号没保住原行时，
  // 再补一行「历史提醒不完整」。按实际行数逐轮核对总宽，
  // 保证整块不超过上限，且省略条数与实际被省略的条目一致。
  const budget = MAX_MAP_REFRESH_WARNINGS - 1 - metricsLines.length - 1
  let keptNew = Math.min(responseWarnings.length, budget)
  let keptOld = Math.min(baseWarnings.length, budget - keptNew)

  for (;;) {
    const keptNewWarnings = selectNewWarnings(responseWarnings, keptNew)
    const keptOldWarnings = baseWarnings.slice(0, keptOld)
    const omittedNew = responseWarnings.length - keptNew
    const omittedOld = baseWarnings.length - keptOld
    const oldHeaderUsed = keptOld > 0
    const noteNeeded =
      !keptNewWarnings.includes(MAP_REFRESH_HISTORY_INCOMPLETE_NOTE) &&
      !keptOldWarnings.includes(MAP_REFRESH_HISTORY_INCOMPLETE_NOTE) &&
      (omittedOld > 0 || addNoteToFull)
    const used =
      1 /* header */ +
      metricsLines.length +
      keptNewWarnings.length +
      (oldHeaderUsed ? 1 : 0) +
      keptOldWarnings.length +
      (noteNeeded ? 1 : 0) +
      1 /* omission line */
    if (used <= MAX_MAP_REFRESH_WARNINGS) {
      const warnings: string[] = [header, ...metricsLines, ...keptNewWarnings]
      if (noteNeeded) warnings.push(MAP_REFRESH_HISTORY_INCOMPLETE_NOTE)
      if (oldHeaderUsed) warnings.push(buildOldHeader(keptOld))
      warnings.push(...keptOldWarnings)
      warnings.push(buildOmissionLine(omittedNew, omittedOld))
      return {
        warnings,
        stats: {
          newWarningCount: responseWarnings.length,
          keptNewWarnings: keptNew,
          omittedNewWarnings: omittedNew,
          keptOldWarnings: keptOld,
          omittedOldWarnings: omittedOld,
          omittedWarnings: omittedNew + omittedOld,
          historyIncomplete: inheritedIncomplete || omittedOld > 0,
        },
      }
    }
    // 超宽：优先减旧提醒（降省略数变更最小），旧提醒已清零就减新提醒。
    const over = used - MAX_MAP_REFRESH_WARNINGS
    if (keptOld >= over) {
      keptOld -= over
    } else if (keptOld > 0) {
      keptOld = 0
    } else {
      keptNew = Math.max(0, keptNew - over)
    }
  }
}

interface MergeInput {
  baseDay: TripDay
  request: MapRefreshRequest
  response: MapRefreshResponse
  baseWarnings: readonly string[]
}

function mergeMapRefresh(input: MergeInput): MergeOutcome {
  const { baseDay, request, response, baseWarnings } = input
  const points: MapRefreshPointStats = {
    refreshed: 0,
    unchanged: 0,
    notReturned: 0,
    added: 0,
    updated: 0,
  }
  const legs: MapRefreshLegStats = { refreshed: 0, retained: 0, invalidated: 0 }

  if (HARD_MAP_STATUSES.has(response.map_status)) {
    const notice =
      `地图服务本次返回 ${response.map_status}，没有可应用的地图数据；旧坐标与旧路线原样保留。`
    return {
      day: baseDay,
      warnings: [...baseWarnings],
      changed: false,
      points: { ...points, notReturned: request.stops.length },
      legs: { ...legs, retained: baseDay.legs.length },
      warningStats: emptyWarningStats(),
      omittedWarnings: 0,
      notices: [notice],
    }
  }

  const successById = new Map<string, MapRefreshResolvedStop>()
  for (const stop of response.stops) successById.set(stop.id, stop)

  const effectiveLocation = new Map<string, TripLocation | null>()
  const stops: TripStop[] = baseDay.stops.map((stop) => {
    const resolved = successById.get(stop.id)
    if (!resolved) {
      points.notReturned += 1
      effectiveLocation.set(stop.id, stop.location)
      return stop
    }
    effectiveLocation.set(stop.id, resolved.location)
    if (sameLocation(stop.location, resolved.location)) {
      points.unchanged += 1
      return stop
    }
    points.refreshed += 1
    if (stop.location === null) points.added += 1
    else points.updated += 1
    return { ...stop, location: { lng: resolved.location.lng, lat: resolved.location.lat } }
  })

  let legMetricsChanged = false
  let keptNavigationOverStraightLine = 0
  const mergedLegs: TripLeg[] = []
  for (let index = 0; index < baseDay.stops.length - 1; index += 1) {
    const from = baseDay.stops[index]
    const to = baseDay.stops[index + 1]
    const newLeg = response.legs[index]
    const oldLeg = baseDay.legs.find(
      (leg) => leg.from_stop_id === from.id && leg.to_stop_id === to.id,
    )
    const bothResolved = successById.has(from.id) && successById.has(to.id)
    const endpointsChanged =
      !sameLocation(from.location, effectiveLocation.get(from.id) ?? null) ||
      !sameLocation(to.location, effectiveLocation.get(to.id) ?? null)

    // 本次只回退成 straight_line、而旧记录是可用 navigation，且端点与出行方式都没变：
    // 保旧导航原对象（本次未重新核验），不用退化直线覆盖。
    if (
      newLeg !== undefined &&
      newLeg.route_type === 'straight_line' &&
      bothResolved &&
      oldLeg !== undefined &&
      oldLeg.route_type === 'navigation' &&
      oldLeg.mode === request.travel_mode &&
      !endpointsChanged
    ) {
      legs.retained += 1
      keptNavigationOverStraightLine += 1
      mergedLegs.push(oldLeg)
      continue
    }

    if (
      newLeg !== undefined &&
      (newLeg.route_type === 'navigation' || newLeg.route_type === 'straight_line') &&
      bothResolved
    ) {
      legs.refreshed += 1
      mergedLegs.push(copyLeg(newLeg))
      if (
        !oldLeg ||
        oldLeg.route_type !== newLeg.route_type ||
        oldLeg.distance_m !== newLeg.distance_m ||
        oldLeg.duration_minutes !== newLeg.duration_minutes
      ) {
        legMetricsChanged = true
      }
      continue
    }

    if (oldLeg && oldLeg.mode === request.travel_mode && !endpointsChanged) {
      legs.retained += 1
      mergedLegs.push(oldLeg)
      continue
    }

    legs.invalidated += 1
    if (oldLeg && (oldLeg.route_type !== 'unavailable' || oldLeg.distance_m !== null || oldLeg.duration_minutes !== null)) {
      legMetricsChanged = true
    }
    mergedLegs.push(unavailableLeg(from.id, to.id, request.travel_mode))
  }

  const day: TripDay = { ...baseDay, stops, legs: mergedLegs }
  const changed = !sameDayMap(baseDay, day)
  const notices: string[] = []
  if (!changed) {
    if (keptNavigationOverStraightLine > 0) {
      notices.push(
        '本次未取得新的导航路线，已沿用旧导航记录（本次没有重新计算），没有可应用更改。',
      )
    } else {
      notices.push('本次地图结果与当前行程一致，没有生成新副本，也没有改动提醒。')
    }
    return {
      day,
      warnings: [...baseWarnings],
      changed: false,
      points,
      legs,
      warningStats: emptyWarningStats(),
      omittedWarnings: 0,
      notices,
    }
  }

  if (points.refreshed > 0 || legs.refreshed > 0) {
    notices.push(
      `按本次地图结果更新了 ${points.refreshed} 个站点坐标与 ${legs.refreshed} 段路线。`,
    )
  }
  if (response.map_status === 'partial') {
    notices.push(
      '本次只取得部分站点或路段的结果；界面需要区分“本次刷新”与“沿用旧数据”，不能把旧点说成本次已核验。',
    )
  }
  if (points.notReturned > 0 || legs.retained > 0) {
    notices.push(
      `有 ${points.notReturned} 个站点与 ${legs.retained} 段路线沿用旧数据，本次没有重新计算。`,
    )
  }
  if (legs.invalidated > 0) {
    notices.push(
      `有 ${legs.invalidated} 段路线因端点、相邻关系或出行方式变化且没有可用新路线，已标记为 unavailable 并清空旧几何与距离、耗时。`,
    )
  }

  const composed = composeWarnings(
    request.day,
    response.map_status,
    response.warnings,
    baseWarnings,
    legMetricsChanged,
  )
  return {
    day,
    warnings: composed.warnings,
    changed: true,
    points,
    legs,
    warningStats: composed.stats,
    omittedWarnings: composed.stats.omittedWarnings,
    notices,
  }
}

// ==================== 预览 / 应用公共前置 ====================

interface PreparedRefresh {
  ok: true
  baseDay: TripDay
  request: MapRefreshRequest
  merge: MergeOutcome
}

type PrepareResult = PreparedRefresh | MapRefreshFailure

function prepareRefresh(
  input: PreviewMapRefreshInput,
  forkTripId?: string,
): PrepareResult {
  const { baseTrip, request, response, currentRevision } = input
  const baseShape = checkTripShape(baseTrip)
  if (!baseShape.ok) {
    return {
      ok: false,
      reason: baseShape.reason === 'too_large' ? 'base_too_large' : 'invalid_base',
      message: '当前行程没有通过本地结构校验，地图刷新结果无法安全应用；原始行程保持不变。',
    }
  }
  if (!isSafeRevision(currentRevision)) {
    return {
      ok: false,
      reason: 'invalid_revision',
      message: '当前 revision 必须是安全非负整数，地图刷新结果未应用。',
    }
  }
  if (
    forkTripId !== undefined &&
    (!isBoundedText(forkTripId, MAX_MAP_REFRESH_TRIP_ID_LENGTH) || forkTripId === baseTrip.id)
  ) {
    return {
      ok: false,
      reason: 'invalid_fork_id',
      message: `新副本 id 必须是 1-${MAX_MAP_REFRESH_TRIP_ID_LENGTH} 字非空字符串且不等于当前行程 id；地图刷新结果未应用。`,
    }
  }

  const requestError = checkRequestShape(request)
  if (requestError) {
    return {
      ok: false,
      reason: 'invalid_request',
      message: `请求上下文不完整：${requestError}；地图刷新结果未应用。`,
    }
  }
  if (request.parent.trip_id !== baseTrip.id) {
    return {
      ok: false,
      reason: 'parent_mismatch',
      message: '候选请求的父行程与当前行程不一致，地图刷新结果未应用。',
    }
  }
  if (request.parent.revision !== currentRevision) {
    return {
      ok: false,
      reason: 'stale_request',
      message:
        '这份地图结果基于旧版本的行程（父 revision 已变化），不能覆盖当前内容；请重新发起地图刷新。',
    }
  }
  if (
    request.destination !== baseTrip.destination ||
    request.date !== null && !isStrictDate(request.date)
  ) {
    return {
      ok: false,
      reason: 'request_mismatch',
      message: '候选请求的目的地或日期与当前行程不一致，地图刷新结果未应用。',
    }
  }
  const baseDay = baseTrip.days.find((day) => day.day === request.day)
  if (!baseDay) {
    return {
      ok: false,
      reason: 'unknown_day',
      message: `当前行程里没有第 ${request.day} 天，地图刷新结果未应用。`,
    }
  }
  if (baseDay.date !== request.date) {
    return {
      ok: false,
      reason: 'stale_request',
      message: '目标日的日期已经变化，这份地图结果基于旧内容，未应用。',
    }
  }
  if (baseDay.stops.length !== request.stops.length) {
    return {
      ok: false,
      reason: 'stale_request',
      message: '目标日的站点数量已经变化，这份地图结果基于旧内容，未应用。',
    }
  }
  for (let index = 0; index < baseDay.stops.length; index += 1) {
    const current = baseDay.stops[index]
    const projected = request.stops[index]
    if (
      current.id !== projected.id ||
      current.name !== projected.name ||
      current.address !== projected.address
    ) {
      return {
        ok: false,
        reason: 'stale_request',
        message:
          '目标日的站点顺序、id、名称或地址已经变化，这份地图结果基于旧内容，未应用。',
      }
    }
  }

  const validated = validateMapRefreshResponse(response, request)
  if (!validated.ok) {
    return {
      ok: false,
      reason: 'invalid_response',
      message: `地图刷新结果没有通过结构校验：${validated.message}`,
    }
  }

  const merge = mergeMapRefresh({
    baseDay,
    request,
    response: validated.response,
    baseWarnings: baseTrip.warnings,
  })
  return { ok: true, baseDay, request, merge }
}

// ==================== 预览 ====================

export function previewMapRefresh(input: PreviewMapRefreshInput): MapRefreshPreviewResult {
  const prepared = prepareRefresh(input)
  if (!prepared.ok) return prepared
  const { merge } = prepared
  return {
    ok: true,
    changed: merge.changed,
    changedDays: merge.changed ? [prepared.request.day] : [],
    day: merge.day,
    warnings: merge.warnings,
    points: merge.points,
    legs: merge.legs,
    warningStats: merge.warningStats,
    omittedWarnings: merge.omittedWarnings,
    notices: merge.notices,
  }
}

// ==================== 应用 ====================

/**
 * 显式应用地图补丁：只替换目标日的 stops[].location、legs 与全局 warnings，返回新 fork Trip。
 * 父 id / revision、目标日投影、响应结构或 640 KB 容量不过关都整体拒绝，base 与所有输入保持不变。
 * 没有地图字段的实质变化时返回 base 本身，不新建 id、不追加提醒。
 */
export function applyMapRefresh(input: ApplyMapRefreshInput): MapRefreshApplyResult {
  const { baseTrip, request, forkTripId } = input
  const prepared = prepareRefresh(input, forkTripId)
  if (!prepared.ok) return prepared
  const { merge } = prepared

  if (!merge.changed) {
    return {
      ok: true,
      changed: false,
      trip: baseTrip,
      changedDays: [],
      points: merge.points,
      legs: merge.legs,
      warningStats: merge.warningStats,
      omittedWarnings: 0,
      notices: merge.notices,
    }
  }

  const days = baseTrip.days.map((day) =>
    day.day === request.day ? merge.day : day,
  )
  const trip: Trip = {
    id: forkTripId,
    source: baseTrip.source,
    destination: baseTrip.destination,
    title: baseTrip.title,
    summary: baseTrip.summary,
    map_coordinate_system: baseTrip.map_coordinate_system,
    warnings: merge.warnings,
    days,
  }

  const postShape = checkTripShape(trip)
  if (!postShape.ok) {
    return {
      ok: false,
      reason: 'postcondition_failed',
      message: '应用后的行程没有通过本地结构校验，这次应用已放弃，原始行程保持不变。',
    }
  }
  let recordBytes: number
  try {
    recordBytes = savedTripRecordBytes(trip)
  } catch {
    return {
      ok: false,
      reason: 'postcondition_failed',
      message: '应用后的行程无法序列化，这次应用已放弃，原始行程保持不变。',
    }
  }
  if (recordBytes > MAX_SAVED_TRIP_BYTES) {
    return {
      ok: false,
      reason: 'capacity_exceeded',
      message:
        `应用后的行程约 ${Math.ceil(recordBytes / 1024)} KB，会超过单份 ` +
        `${Math.round(MAX_SAVED_TRIP_BYTES / 1024)} KB 的保存与备份上限，` +
        '这次应用已放弃，原始行程与候选几何都没有被改动或截断。',
    }
  }

  return {
    ok: true,
    changed: true,
    trip,
    changedDays: [request.day],
    points: merge.points,
    legs: merge.legs,
    warningStats: merge.warningStats,
    omittedWarnings: merge.omittedWarnings,
    notices: [
      ...merge.notices,
      MAP_REFRESH_APPLY_NOTICE,
      MAP_REFRESH_WARNINGS_NOTICE,
    ],
  }
}

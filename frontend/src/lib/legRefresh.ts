/**
 * 固定端点衔接路线（POST /api/trips/days/leg-refresh）的前端纯契约。
 *
 * 边界：
 * - 纯函数：不读时间 / Storage / 环境变量，不发网络，不生成 id、revision、坐标或几何。
 * - 请求只投影 parent / day / date / travel_mode / 两个 stop id 与 WGS84 location；
 *   stop 的名称、地址、时刻、停留、说明等字段一律不进入请求。缺坐标明确失败，不补 0、
 *   不 geocode、不移动端点。合法 0 / 负坐标与未知 null 分开处理。
 * - 响应按 unknown 严格校验：parent / day / date / mode / 两个 id 与两端 lng/lat 必须与
 *   请求 JS `===` 精确相等；几何另做 2..5000 点、有限有界 WGS84、非退化和既有路网吸附
 *   合理性检查。几何不能自证端点归属，端点归属只由请求回显与上层 owner 绑定证明。
 * - map_status 是契约的一部分：HTTP 200 只说明拿到信封，不说明 ready。失败状态必须
 *   leg=null 且 reason 是后端固定安全文案；ready 必须恰好一个 navigation leg，距离可为
 *   合法 0、耗时可未知 null，不生成直线降级，不把 null 当 0。
 * - 本模块不持有 Trip、不做 owner / scope / epoch / ABA 判断，也不应用或保存任何结果。
 *   下一层必须用自己的完整 Trip/候选快照、scope.travelMode 与单调 epoch 绑定请求和响应；
 *   仅凭本模块的 parse 通过不能证明结果仍属于当前候选。
 */
import type { TravelMode, TripLeg } from './api'
import { MAX_GEOMETRY_POINTS_PER_LEG } from './savedTrips'

export const MAX_LEG_REFRESH_DAYS = 7
export const MAX_LEG_REFRESH_TRIP_ID_LENGTH = 100
export const MAX_LEG_REFRESH_STOP_ID_LENGTH = 100
export const MAX_LEG_REFRESH_REVISION = Number.MAX_SAFE_INTEGER
export const MAX_LEG_REFRESH_LEG_DESCRIPTION_LENGTH = 500
/**
 * 单段几何上限与既有 `MAX_GEOMETRY_POINTS_PER_LEG` 一致（5000）。
 * 本模块只校验单段；组合进 Trip 后仍必须由应用层复核全行程
 * `MAX_TOTAL_GEOMETRY_POINTS` 与 640 KiB 保存门禁。
 */
export const MAX_LEG_REFRESH_GEOMETRY_POINTS = MAX_GEOMETRY_POINTS_PER_LEG

export const LEG_REFRESH_ENDPOINTS = {
  walking: '/v5/direction/walking',
  driving: '/v5/direction/driving',
} as const

export type LegRefreshStatus = 'ready' | 'no_key' | 'timeout' | 'unavailable' | 'failed'
export type LegRefreshFailureStatus = Exclude<LegRefreshStatus, 'ready'>
export type LegRefreshEndpoint = (typeof LEG_REFRESH_ENDPOINTS)[TravelMode]

/** 与 leg_refresh.py 的固定安全文案一致；不回显异常、Key、上游正文或路径。 */
export const LEG_REFRESH_FAILURE_REASONS: Readonly<
  Record<LegRefreshFailureStatus, string>
> = {
  no_key: '服务端未配置高德地图 Key，本次未执行任何路线查询。',
  timeout: '衔接路线查询超时，本次未返回路线。',
  unavailable: '高德地图路线服务暂时不可用，本次未返回路线。',
  failed: '衔接路线数据不可用，本次未返回路线。',
}

export interface LegRefreshCoordinate {
  lng: number
  lat: number
}

export interface LegRefreshParent {
  trip_id: string
  revision: number
}

export interface LegRefreshStop {
  id: string
  location: LegRefreshCoordinate
}

/** POST /api/trips/days/leg-refresh 的请求体（字段名与后端严格一致）。 */
export interface LegRefreshRequest {
  parent: LegRefreshParent
  day: number
  date: string | null
  travel_mode: TravelMode
  from_stop: LegRefreshStop
  to_stop: LegRefreshStop
}

export interface LegRefreshSource {
  provider: 'amap'
  coordinate_system: 'WGS84'
  endpoint: LegRefreshEndpoint
}

export interface LegRefreshNavigationLeg extends TripLeg {
  route_type: 'navigation'
}

interface LegRefreshResponseBase {
  parent: LegRefreshParent
  day: number
  date: string | null
  travel_mode: TravelMode
  from_stop: LegRefreshStop
  to_stop: LegRefreshStop
  source: LegRefreshSource
  checked_at: string
}

export interface LegRefreshReadyResponse extends LegRefreshResponseBase {
  map_status: 'ready'
  leg: LegRefreshNavigationLeg
  reason: null
}

export interface LegRefreshFailedResponse extends LegRefreshResponseBase {
  map_status: LegRefreshFailureStatus
  leg: null
  reason: string
}

export type LegRefreshResponse = LegRefreshReadyResponse | LegRefreshFailedResponse

/**
 * 构造请求时的显式输入。字段按 unknown 接收，便于把仍有效的 scope 值、当前 Trip 的
 * 站点对象或导入数据直接交给本模块做运行时校验；多余字段会被投影掉。
 * 本模块不读取任何隐式当前表单值。
 */
export interface LegRefreshBuildInput {
  parent?: unknown
  day?: unknown
  date?: unknown
  travel_mode?: unknown
  from_stop?: unknown
  to_stop?: unknown
}

export type LegRefreshRequestFailureReason =
  | 'invalid_input'
  | 'invalid_parent'
  | 'invalid_day'
  | 'invalid_date'
  | 'invalid_mode'
  | 'invalid_stop'
  | 'missing_location'
  | 'invalid_location'
  | 'duplicate_stop_id'

export interface LegRefreshRequestFailure {
  ok: false
  reason: LegRefreshRequestFailureReason
  message: string
}

export interface LegRefreshRequestSuccess {
  ok: true
  request: LegRefreshRequest
}

export type LegRefreshRequestValidation =
  | LegRefreshRequestSuccess
  | LegRefreshRequestFailure

export type LegRefreshBuildResult = LegRefreshRequestValidation

export type LegRefreshResponseValidation =
  | { ok: true; response: LegRefreshResponse }
  | { ok: false; message: string }

// ==================== 通用校验 ====================

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/
const CHECKED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00|-00:00)$/

const REQUEST_KEYS: ReadonlySet<string> = new Set([
  'parent',
  'day',
  'date',
  'travel_mode',
  'from_stop',
  'to_stop',
])
const PARENT_KEYS: ReadonlySet<string> = new Set(['trip_id', 'revision'])
const STOP_KEYS: ReadonlySet<string> = new Set(['id', 'location'])
const LOCATION_KEYS: ReadonlySet<string> = new Set(['lng', 'lat'])
const RESPONSE_KEYS: ReadonlySet<string> = new Set([
  'parent',
  'day',
  'date',
  'travel_mode',
  'from_stop',
  'to_stop',
  'map_status',
  'leg',
  'reason',
  'source',
  'checked_at',
])
const SOURCE_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'coordinate_system',
  'endpoint',
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

function unicodeLength(value: string): number {
  return Array.from(value).length
}

function isBoundedOpaqueId(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    unicodeLength(value) >= 1 &&
    unicodeLength(value) <= max &&
    value.trim().length > 0 &&
    !CONTROL_CHARS.test(value)
  )
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** 严格 YYYY-MM-DD 且是真实日历日；不用 Date，避免时区与年份偏移。 */
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

function isCheckedAt(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = CHECKED_AT_PATTERN.exec(value)
  if (!match) return false
  if (!isStrictDate(`${match[1]}-${match[2]}-${match[3]}`)) return false
  return Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59
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

function requestFailure(
  reason: LegRefreshRequestFailureReason,
  message: string,
): LegRefreshRequestFailure {
  return { ok: false, reason, message }
}

type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; message: string }

function parseOk<T>(value: T): Parsed<T> {
  return { ok: true, value }
}

function parseError<T>(message: string): Parsed<T> {
  return { ok: false, message }
}

interface ReadStopFailure {
  ok: false
  kind: 'stop' | 'missing_location' | 'invalid_location'
  message: string
}

type ReadStopResult = { ok: true; value: LegRefreshStop } | ReadStopFailure

function readParent(value: unknown, path: string): Parsed<LegRefreshParent> {
  if (!isRecord(value)) return parseError(`${path} 不是对象`)
  if (findUnknownKey(value, PARENT_KEYS) !== null) {
    return parseError(`${path} 包含未知字段`)
  }
  if (!isBoundedOpaqueId(value.trip_id, MAX_LEG_REFRESH_TRIP_ID_LENGTH)) {
    return parseError(
      `${path}.trip_id 必须是 1-${MAX_LEG_REFRESH_TRIP_ID_LENGTH} 字非空字符串，且不能包含控制字符`,
    )
  }
  if (!isSafeRevision(value.revision)) {
    return parseError(`${path}.revision 必须是安全非负整数`)
  }
  return parseOk({ trip_id: value.trip_id, revision: value.revision })
}

function readLocation(value: unknown, path: string): Parsed<LegRefreshCoordinate> {
  if (!isRecord(value)) return parseError(`${path} 不是坐标对象`)
  if (findUnknownKey(value, LOCATION_KEYS) !== null) {
    return parseError(`${path} 包含未知字段`)
  }
  if (!isFiniteNumber(value.lng) || value.lng < -180 || value.lng > 180) {
    return parseError(`${path}.lng 必须是 -180 到 180 的有限数字`)
  }
  if (!isFiniteNumber(value.lat) || value.lat < -90 || value.lat > 90) {
    return parseError(`${path}.lat 必须是 -90 到 90 的有限数字`)
  }
  return parseOk({ lng: value.lng, lat: value.lat })
}

function readStop(value: unknown, path: string): ReadStopResult {
  if (!isRecord(value)) {
    return { ok: false, kind: 'stop', message: `${path} 不是对象` }
  }
  if (findUnknownKey(value, STOP_KEYS) !== null) {
    return { ok: false, kind: 'stop', message: `${path} 包含未知字段` }
  }
  if (!isBoundedOpaqueId(value.id, MAX_LEG_REFRESH_STOP_ID_LENGTH)) {
    return {
      ok: false,
      kind: 'stop',
      message: `${path}.id 必须是 1-${MAX_LEG_REFRESH_STOP_ID_LENGTH} 字非空字符串，且不能包含控制字符`,
    }
  }
  if (value.location === null || value.location === undefined) {
    return {
      ok: false,
      kind: 'missing_location',
      message: `${path} 缺少 WGS84 坐标；不会自动 geocode 或按 0 补齐`,
    }
  }
  const location = readLocation(value.location, `${path}.location`)
  if (!location.ok) {
    return { ok: false, kind: 'invalid_location', message: location.message }
  }
  return { ok: true, value: { id: value.id, location: location.value } }
}

function stopFailureReason(kind: ReadStopFailure['kind']): LegRefreshRequestFailureReason {
  if (kind === 'missing_location') return 'missing_location'
  if (kind === 'invalid_location') return 'invalid_location'
  return 'invalid_stop'
}

function projectLocation(value: unknown): unknown {
  return isRecord(value) ? { lng: value.lng, lat: value.lat } : value
}

// ==================== 请求 ====================

/** 从显式 scope 值 / 站点对象构造请求；只保留允许字段，不读取隐式当前状态。 */
export function buildLegRefreshRequest(
  input: LegRefreshBuildInput,
): LegRefreshBuildResult {
  if (!isRecord(input)) {
    return requestFailure('invalid_input', '衔接路线请求输入不是对象。')
  }
  const parent = isRecord(input.parent)
    ? { trip_id: input.parent.trip_id, revision: input.parent.revision }
    : input.parent
  const fromStop = isRecord(input.from_stop)
    ? { id: input.from_stop.id, location: projectLocation(input.from_stop.location) }
    : input.from_stop
  const toStop = isRecord(input.to_stop)
    ? { id: input.to_stop.id, location: projectLocation(input.to_stop.location) }
    : input.to_stop

  return validateLegRefreshRequest({
    parent,
    day: input.day,
    date: input.date,
    travel_mode: input.travel_mode,
    from_stop: fromStop,
    to_stop: toStop,
  })
}

/** 严格校验 wire 请求：未知字段、非法数值、相同 id 都整包拒绝。 */
export function validateLegRefreshRequest(value: unknown): LegRefreshRequestValidation {
  if (!isRecord(value)) {
    return requestFailure('invalid_input', '衔接路线请求不是对象。')
  }
  if (findUnknownKey(value, REQUEST_KEYS) !== null) {
    return requestFailure('invalid_input', `衔接路线请求包含未知字段。`)
  }

  const parent = readParent(value.parent, '请求.parent')
  if (!parent.ok) return requestFailure('invalid_parent', parent.message)

  if (!isIntegerInRange(value.day, 1, MAX_LEG_REFRESH_DAYS)) {
    return requestFailure(
      'invalid_day',
      `请求.day 必须是 1-${MAX_LEG_REFRESH_DAYS} 的整数。`,
    )
  }
  if (value.date !== null && !isStrictDate(value.date)) {
    return requestFailure('invalid_date', '请求.date 必须是严格 YYYY-MM-DD 或 null。')
  }
  if (value.travel_mode !== 'walking' && value.travel_mode !== 'driving') {
    return requestFailure('invalid_mode', '请求.travel_mode 只能是 walking 或 driving。')
  }

  const from = readStop(value.from_stop, '请求.from_stop')
  if (!from.ok) return requestFailure(stopFailureReason(from.kind), from.message)
  const to = readStop(value.to_stop, '请求.to_stop')
  if (!to.ok) return requestFailure(stopFailureReason(to.kind), to.message)
  if (from.value.id === to.value.id) {
    return requestFailure('duplicate_stop_id', '请求的起终点 id 必须不同。')
  }

  return {
    ok: true,
    request: {
      parent: parent.value,
      day: value.day,
      date: value.date as string | null,
      travel_mode: value.travel_mode,
      from_stop: from.value,
      to_stop: to.value,
    },
  }
}

// ==================== 响应 ====================

function readSource(
  value: unknown,
  mode: TravelMode,
): Parsed<LegRefreshSource> {
  if (!isRecord(value)) return parseError('响应.source 不是对象')
  if (findUnknownKey(value, SOURCE_KEYS) !== null) {
    return parseError(`响应.source 包含未知字段`)
  }
  if (value.provider !== 'amap') {
    return parseError('响应.source.provider 必须是 amap')
  }
  if (value.coordinate_system !== 'WGS84') {
    return parseError('响应.source.coordinate_system 必须是 WGS84')
  }
  const expectedEndpoint = LEG_REFRESH_ENDPOINTS[mode]
  if (value.endpoint !== expectedEndpoint) {
    return parseError(`响应.source.endpoint 必须与 travel_mode 对应的固定端点一致`)
  }
  return parseOk({
    provider: 'amap',
    coordinate_system: 'WGS84',
    endpoint: expectedEndpoint,
  })
}

function greatCircleDistanceM(
  lng1: number,
  lat1: number,
  lng2: number,
  lat2: number,
): number {
  const radius = 6_371_000
  const phi1 = (lat1 * Math.PI) / 180
  const phi2 = (lat2 * Math.PI) / 180
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180
  const deltaLambda = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * 与后端既有 `_polyline_is_plausible` 同口径的保守检查：先看经纬度包围盒，
 * 再看首末点是否落在既有路网吸附容差内。只用于几何合理性，不证明端点归属。
 */
function isPlausibleGeometry(
  geometry: readonly LegRefreshCoordinate[],
  from: LegRefreshCoordinate,
  to: LegRefreshCoordinate,
  mode: TravelMode,
): boolean {
  if (geometry.length < 2) return false
  const span = Math.max(Math.abs(to.lng - from.lng), Math.abs(to.lat - from.lat))
  const padding = Math.max(0.5, span * 0.75)
  const lngLo = Math.min(from.lng, to.lng) - padding
  const lngHi = Math.max(from.lng, to.lng) + padding
  const latLo = Math.min(from.lat, to.lat) - padding
  const latHi = Math.max(from.lat, to.lat) + padding
  for (const point of geometry) {
    if (
      point.lng < lngLo ||
      point.lng > lngHi ||
      point.lat < latLo ||
      point.lat > latHi
    ) {
      return false
    }
  }
  const tolerance = mode === 'walking' ? 2_000 : 5_000
  const first = geometry[0]
  const last = geometry[geometry.length - 1]
  return (
    greatCircleDistanceM(first.lng, first.lat, from.lng, from.lat) <= tolerance &&
    greatCircleDistanceM(last.lng, last.lat, to.lng, to.lat) <= tolerance
  )
}

function readReadyLeg(
  value: unknown,
  request: LegRefreshRequest,
): Parsed<LegRefreshNavigationLeg> {
  if (!isRecord(value)) return parseError('响应.leg 不是对象')
  if (findUnknownKey(value, LEG_KEYS) !== null) {
    return parseError(`响应.leg 包含未知字段`)
  }
  if (!isBoundedOpaqueId(value.from_stop_id, MAX_LEG_REFRESH_STOP_ID_LENGTH)) {
    return parseError('响应.leg.from_stop_id 必须是 1-100 字非空字符串')
  }
  if (!isBoundedOpaqueId(value.to_stop_id, MAX_LEG_REFRESH_STOP_ID_LENGTH)) {
    return parseError('响应.leg.to_stop_id 必须是 1-100 字非空字符串')
  }
  if (value.from_stop_id !== request.from_stop.id || value.to_stop_id !== request.to_stop.id) {
    return parseError('响应.leg 的 from/to id 与请求不一致')
  }
  if (value.mode !== 'walking' && value.mode !== 'driving') {
    return parseError('响应.leg.mode 不是受支持的出行方式')
  }
  if (value.mode !== request.travel_mode) {
    return parseError('响应.leg.mode 与请求不一致')
  }
  if (value.route_type !== 'navigation') {
    return parseError('响应.leg.route_type 必须是 navigation；不接受直线或降级结果')
  }
  if (
    !Number.isSafeInteger(value.distance_m) ||
    (value.distance_m as number) < 0
  ) {
    return parseError('响应.leg.distance_m 必须是安全非负整数')
  }
  if (
    value.duration_minutes !== null &&
    (!isFiniteNumber(value.duration_minutes) || value.duration_minutes < 0)
  ) {
    return parseError('响应.leg.duration_minutes 必须是有限非负数或 null')
  }
  if (
    typeof value.description !== 'string' ||
    unicodeLength(value.description) < 1 ||
    unicodeLength(value.description) > MAX_LEG_REFRESH_LEG_DESCRIPTION_LENGTH
  ) {
    return parseError(
      `响应.leg.description 必须是 1-${MAX_LEG_REFRESH_LEG_DESCRIPTION_LENGTH} 字非空字符串`,
    )
  }
  if (!Array.isArray(value.geometry)) {
    return parseError('响应.leg.geometry 必须是数组')
  }
  if (
    value.geometry.length < 2 ||
    value.geometry.length > MAX_LEG_REFRESH_GEOMETRY_POINTS
  ) {
    return parseError(
      `响应.leg.geometry 必须含 2..${MAX_LEG_REFRESH_GEOMETRY_POINTS} 个合法 WGS84 点`,
    )
  }
  const geometry: LegRefreshCoordinate[] = []
  for (let index = 0; index < value.geometry.length; index += 1) {
    const point = readLocation(value.geometry[index], `响应.leg.geometry[${index}]`)
    if (!point.ok) return parseError(point.message)
    geometry.push(point.value)
  }
  if (geometry.every((point) => point.lng === geometry[0].lng && point.lat === geometry[0].lat)) {
    return parseError('响应.leg.geometry 不是有效折线（所有点相同）')
  }
  if (
    !isPlausibleGeometry(
      geometry,
      request.from_stop.location,
      request.to_stop.location,
      request.travel_mode,
    )
  ) {
    return parseError('响应.leg.geometry 与请求端点明显不符，不能当作本次衔接路线')
  }

  return parseOk({
    from_stop_id: value.from_stop_id,
    to_stop_id: value.to_stop_id,
    mode: value.mode,
    route_type: 'navigation',
    distance_m: value.distance_m as number,
    duration_minutes: value.duration_minutes as number | null,
    geometry: geometry.map((point) => ({ lng: point.lng, lat: point.lat })),
    description: value.description,
  })
}

/**
 * 对 unknown 响应做完整契约校验。失败即整包拒绝，不局部采纳、不补 leg、不把 200 当成功。
 * 请求 echo 与几何检查分开：几何合理不代表结果属于当前 owner；那由下一层绑定。
 */
export function validateLegRefreshResponse(
  value: unknown,
  request: LegRefreshRequest,
): LegRefreshResponseValidation {
  const requestResult = validateLegRefreshRequest(request)
  if (!requestResult.ok) {
    return { ok: false, message: `请求上下文不完整：${requestResult.message}` }
  }
  const req = requestResult.request
  if (!isRecord(value)) {
    return { ok: false, message: '响应不是 JSON 对象' }
  }
  if (findUnknownKey(value, RESPONSE_KEYS) !== null) {
    return { ok: false, message: `响应包含未知字段` }
  }
  if (
    value.map_status !== 'ready' &&
    value.map_status !== 'no_key' &&
    value.map_status !== 'timeout' &&
    value.map_status !== 'unavailable' &&
    value.map_status !== 'failed'
  ) {
    return { ok: false, message: '响应.map_status 不是受支持的状态' }
  }
  const status = value.map_status

  const parent = readParent(value.parent, '响应.parent')
  if (!parent.ok) return { ok: false, message: parent.message }
  if (
    parent.value.trip_id !== req.parent.trip_id ||
    parent.value.revision !== req.parent.revision
  ) {
    return { ok: false, message: '响应.parent 与请求不一致' }
  }

  if (!isIntegerInRange(value.day, 1, MAX_LEG_REFRESH_DAYS)) {
    return { ok: false, message: `响应.day 必须是 1-${MAX_LEG_REFRESH_DAYS} 的整数` }
  }
  if (value.day !== req.day) {
    return { ok: false, message: '响应.day 与请求不一致' }
  }
  if (value.date !== null && !isStrictDate(value.date)) {
    return { ok: false, message: '响应.date 必须是严格 YYYY-MM-DD 或 null' }
  }
  if (value.date !== req.date) {
    return { ok: false, message: '响应.date 与请求不一致' }
  }
  if (value.travel_mode !== 'walking' && value.travel_mode !== 'driving') {
    return { ok: false, message: '响应.travel_mode 不是受支持的出行方式' }
  }
  if (value.travel_mode !== req.travel_mode) {
    return { ok: false, message: '响应.travel_mode 与请求不一致' }
  }

  const from = readStop(value.from_stop, '响应.from_stop')
  if (!from.ok) return { ok: false, message: from.message }
  if (
    from.value.id !== req.from_stop.id ||
    from.value.location.lng !== req.from_stop.location.lng ||
    from.value.location.lat !== req.from_stop.location.lat
  ) {
    return {
      ok: false,
      message: '响应.from_stop 与请求不一致（id 或 WGS84 坐标必须精确相等）',
    }
  }
  const to = readStop(value.to_stop, '响应.to_stop')
  if (!to.ok) return { ok: false, message: to.message }
  if (
    to.value.id !== req.to_stop.id ||
    to.value.location.lng !== req.to_stop.location.lng ||
    to.value.location.lat !== req.to_stop.location.lat
  ) {
    return {
      ok: false,
      message: '响应.to_stop 与请求不一致（id 或 WGS84 坐标必须精确相等）',
    }
  }

  const source = readSource(value.source, req.travel_mode)
  if (!source.ok) return { ok: false, message: source.message }
  if (!isCheckedAt(value.checked_at)) {
    return { ok: false, message: '响应.checked_at 必须是带 UTC 时区的 ISO 时间' }
  }

  const base = {
    parent: parent.value,
    day: value.day,
    date: value.date as string | null,
    travel_mode: req.travel_mode,
    from_stop: from.value,
    to_stop: to.value,
    source: source.value,
    checked_at: value.checked_at,
  }

  if (status === 'ready') {
    if (value.reason !== null) {
      return { ok: false, message: '响应.map_status=ready 时 reason 必须为 null' }
    }
    const leg = readReadyLeg(value.leg, req)
    if (!leg.ok) return { ok: false, message: leg.message }
    return {
      ok: true,
      response: { ...base, map_status: 'ready', leg: leg.value, reason: null },
    }
  }

  if (value.leg !== null) {
    return { ok: false, message: `响应.map_status=${status} 时 leg 必须为 null` }
  }
  const expectedReason = LEG_REFRESH_FAILURE_REASONS[status]
  if (value.reason !== expectedReason) {
    return { ok: false, message: `响应.map_status=${status} 时 reason 必须是固定安全文案` }
  }
  return {
    ok: true,
    response: { ...base, map_status: status, leg: null, reason: expectedReason },
  }
}

/** 只有 ready 才返回 leg；失败状态一律 null，调用方无需把 200 当成功。 */
export function legRefreshReadyLeg(
  response: LegRefreshResponse,
): LegRefreshNavigationLeg | null {
  return response.map_status === 'ready' ? response.leg : null
}

/**
 * POI 公开资料候选的前端契约与运行时验证（独立信封，不进 Trip v1）。
 *
 * 数据来源：GET /api/poi-sources/nearby?lat&lon，返回后端
 * poi_sources_client.PoiSourceReport 的 JSON（直接是信封，不套第二层）。
 *
 * 边界：
 * - 只做 DTO 校验与展示换算，不写 Trip、不写 localStorage、不猜坐标。
 * - 校验以「请求」为基准：requested 要与本次请求一致（后端把坐标四舍五入到
 *   6 位小数，所以用 1e-5 容差比较，不做浮点全等），否则整份响应作废。
 * - 0 与负坐标是合法 WGS84 值；距离 0 是合法值。
 * - 标签字段只认 state=source_only（原文）或 unknown；原文不解析、不推断
 *   实时营业、免费与否或币种，展示时原样透传。
 * - source_url 必须与校验过的 type/id 构造的规范 OSM 链接一致；不一致整份
 *   响应作废，防止把任意 URL 冒充 OSM 来源。
 */
import type { TripDay } from './api'

/** 与后端 api_server 注册路径一致，走 Vite /api 代理。 */
export const POI_SOURCES_NEARBY_PATH = '/api/poi-sources/nearby'

/** OSM 对象链接的规范构造：只认 node/way/relation + 正整数 id。 */
export const OSM_OBJECT_BASE_URL = 'https://www.openstreetmap.org'
/** ODM 署名与文档地址：只作为可见链接的兜底，不杜撰来源。 */
export const OSM_ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright'
export const OSM_DOCS_URL = 'https://wiki.openstreetmap.org/wiki/Overpass_API'

export type PoiSourceStatus =
  | 'available'
  | 'no_candidates'
  | 'invalid_request'
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'failed'

export type PoiElementType = 'node' | 'way' | 'relation'

export interface PoiCoordinate {
  lat: number
  lon: number
}

export interface PoiTagField {
  state: 'source_only' | 'unknown'
  value: string | null
}

export interface PoiSourceMeta {
  provider: string
  endpoint: string
  docs_url: string
  attribution_url: string
  license: string
  data_source: string
}

export interface PoiSourceCandidate {
  element_type: PoiElementType
  element_id: number
  name: string | null
  location: PoiCoordinate
  distance_m: number
  source_url: string
  /** 本次实际收到 provider 2xx 响应体的 UTC 时间 */
  retrieved_at: string
  /** OSM 对象编辑时间；缺失/非法为 null，不用当前时间填充 */
  source_updated_at: string | null
  identity_status: 'unconfirmed'
  opening_hours: PoiTagField
  fee: PoiTagField
  charge: PoiTagField
}

export interface PoiSourceReport {
  status: PoiSourceStatus
  reason: string | null
  provider_http_status: number | null
  checked_at: string
  fetched_at: string | null
  requested: PoiCoordinate | null
  radius_m: number
  cached: boolean
  source: PoiSourceMeta
  /** provider 返回的元素总数（可能大于 30：后端只处理前 30，但 seen 如实记录） */
  source_elements_seen: number
  candidates: PoiSourceCandidate[]
  notes: string[]
}

export interface PoiSourceQuery {
  /** WGS84 纬度，-90..90（0 与负值合法） */
  lat: number
  /** WGS84 经度，-180..180（0 与负值合法） */
  lon: number
}

export type PoiSourceValidationResult =
  | { ok: true; report: PoiSourceReport }
  | { ok: false; reason: string }

const POI_STATUSES: readonly PoiSourceStatus[] = [
  'available',
  'no_candidates',
  'invalid_request',
  'timeout',
  'rate_limited',
  'unavailable',
  'failed',
]

const ELEMENT_TYPES: readonly PoiElementType[] = ['node', 'way', 'relation']

/** element_id 上限：JS 安全整数 2^53-1（后端同样按此排除非法 id） */
const MAX_SAFE_INTEGER = 2 ** 53 - 1

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
/** OSM 对象编辑时间固定是秒级 Z 形式（后端 _TIMESTAMP_RE 同口径） */
const OSM_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
/**
 * 后端把坐标 round 到 6 位小数：|Δ| 最大可能舍入误差是 5e-7。
 * 用 1e-6 容差（略大于最大舍入误差、留浮点余量）——过宽容差会把
 * 附近另一个真实坐标也判成本次请求，掩盖 requested 被替换。
 */
const COORD_EPSILON = 1e-6
/** 后端固定查询半径（_RADIUS_M=100.0），不是可调参数 */
const FIXED_RADIUS_M = 100
const MAX_CANDIDATES = 8
/** 标签字段原文上限：后端 _MAX_TAG_VALUE_CHARS=300，超出记 unknown 不截断 */
const MAX_TAG_VALUE_CHARS = 300
/**
 * 后端 len() 按 Unicode 码点计数；一个 astral 码点占 2 个 UTF-16 code units，
 * 所以合法的 300 码点最多占 600 units，>600 必然 >300：先拒超长巨串
 * 避免为明显超限的值分配整大数组，≤600 的再精确数码点。 */
const MAX_TAG_VALUE_UTF16_UNITS = MAX_TAG_VALUE_CHARS * 2
/**
 * 与后端同口径的字符计数：按 Unicode 码点（Python len），不是 UTF-16 code
 * units。"\u{1F680}".length 是 2 但 Python len 是 1，只看 .length 会把合法
 * 原文错拒。组合音标与 ZWJ 序列不合并：Python len 对它们分别计数，这里一致。
 */

/**
 * 后端 PoiSourceMeta 是固定常量（PROVIDER_*），与 docs/POI_SOURCES.md 的
 * 合同示例逐字一致。署名/文档链接直接挂到「OpenStreetMap」名下，所以必须
 * 与受控常量相等——HTTPS_REGEX 本身不能证明一个任意站是可查证的 OSM 来源。
 */
const TRUSTED_META: Readonly<PoiSourceMeta> = {
  provider: 'overpass-api.de',
  endpoint: 'https://overpass-api.de/api/interpreter',
  docs_url: 'https://wiki.openstreetmap.org/wiki/Overpass_API',
  attribution_url: 'https://www.openstreetmap.org/copyright',
  license: 'ODbL 1.0',
  data_source: 'OpenStreetMap',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isLatitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -90 && value <= 90
}

function isLongitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -180 && value <= 180
}

/**
 * 真实日历/时钟范围校验：Date.parse 会把 2026-02-30 滚成 3 月 2 日，
 * 所以解析后把各字段重新序列化回去比对，不一致（滚动、越界）即拒绝。
 * 接受后端合法的微秒 ISO、+00:00 与 Z。
 */
function isRealUtcTimestamp(value: string): boolean {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return false
  const date = new Date(ms)
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)
  if (!m) return false
  const [, y, mo, d, h, mi, s] = m
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() + 1 === Number(mo) &&
    date.getUTCDate() === Number(d) &&
    date.getUTCHours() === Number(h) &&
    date.getUTCMinutes() === Number(mi) &&
    date.getUTCSeconds() === Number(s)
  )
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_RE.test(value) && isRealUtcTimestamp(value)
}

function isOsmTimestamp(value: unknown): value is string {
  return typeof value === 'string' && OSM_TIMESTAMP_RE.test(value) && isRealUtcTimestamp(value)
}

function isCoordinateLike(value: unknown, check: (v: unknown) => boolean): value is PoiCoordinate {
  return isRecord(value) && check(value.lat) && check(value.lon)
}

/** 标签原文：非空白、≤300 码点（后端 _tag_field 同口径）；允许首尾空格并原样保留 */
function isTagRawValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TAG_VALUE_UTF16_UNITS &&
    unicodeCodePointLength(value) <= MAX_TAG_VALUE_CHARS &&
    value.trim() !== ''
  )
}

/** 字符串的 Unicode 码点数（等价 Python len(str)），不用 Intl/通用 Unicode 库。 */
function unicodeCodePointLength(value: string): number {
  let count = 0
  for (const _char of value) count += 1
  return count
}

function matchesRequestedCoordinate(
  value: PoiCoordinate,
  query: PoiSourceQuery,
): boolean {
  return (
    Math.abs(value.lat - query.lat) <= COORD_EPSILON &&
    Math.abs(value.lon - query.lon) <= COORD_EPSILON
  )
}

/**
 * haversine 复核的数值误差余量（米）：与 distance_m 边界的 1e-6 同口径，
 * 只吸收浮点误差，不扩大接收半径——后端和前端同样基于已回传的 center
 * 坐标算球面距离，不存在需要多放 1m 的近似。
 */
const HAVERSINE_EPSILON_M = 1e-6
/**
 * haversine 距离的独立实现（校验层用，不 import 后端代码）：
 * 6371000 m 半径，与后端 haversine_m 同口径。用于核对候选坐标确实落在
 * 请求点的固定 100m 半径内，防止「距离声明 5m、实际 111m」的假候选。
 */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371000
  const phi1 = (lat1 * Math.PI) / 180
  const phi2 = (lat2 * Math.PI) / 180
  const dphi = ((lat2 - lat1) * Math.PI) / 180
  const dlam = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(Math.min(1, a)))
}

/**
 * 规范 OSM 对象链接：只由已校验的 type/id 构造。
 * 候选里的 source_url 必须与之逐字一致，不一致说明来源字段被污染。
 */
export function osmObjectUrl(type: PoiElementType, id: number): string {
  return `${OSM_OBJECT_BASE_URL}/${type}/${id}`
}

/** 三类标签字段的统一读取：原文透传，unknown 一律显示未知 */
export function readTagField(field: PoiTagField | null | undefined): {
  known: boolean
  value: string | null
} {
  if (!field) return { known: false, value: null }
  if (field.state === 'source_only' && typeof field.value === 'string' && field.value.length > 0) {
    return { known: true, value: field.value }
  }
  return { known: false, value: null }
}

/** 标签字段在候选上的数据状态：source_only=来源标签原文，unknown=来源未提供 */
export type TagFieldStatus = 'source_only' | 'unknown'

/** 标签字段的展示文本：unknown 固定「来源未提供」，原文原样返回（不解析） */
export function tagFieldText(field: PoiTagField): string {
  const reading = readTagField(field)
  return reading.known && reading.value !== null ? reading.value : '来源未提供'
}

/** 后端状态对应的固定短句；reason 不回显（后端 reason 也只是固定短句，但前端不依赖它） */
export function poiStatusText(status: PoiSourceStatus): string {
  switch (status) {
    case 'available':
      return '已返回'
    case 'no_candidates':
      return '本期没有候选'
    case 'invalid_request':
      return '参数未接受'
    case 'timeout':
      return '超时'
    case 'rate_limited':
      return '请求过于频繁'
    case 'unavailable':
      return '暂时不可用'
    case 'failed':
      return '本次失败'
  }
}

/** UTC ISO → `YYYY-MM-DD HH:mm:ss UTC`；解析不了就原样返回，不伪造时间 */
export function formatPoiTimestamp(value: string | null | undefined): string {
  if (!value) return '未知'
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return value
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

/**
 * 距离的展示文本：0 与负值中 0 是合法真值（后端 ge=0，负值会被拒）。
 * 保留一位小数；0 原样显示。
 */
export function formatPoiDistance(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? `${rounded} m` : `${rounded.toFixed(1)} m`
}

/** 坐标展示：保留 6 位小数以内（后端 requested 即 6 位舍入值） */
export function formatPoiCoordinate(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6
  return String(rounded)
}

/**
 * 从本日行程记录里取有合法 WGS84 坐标的站点（0 / 负坐标合法）。
 * 不查其它天、不用浏览器定位、不按城市猜；按 stop id 去重，保持记录顺序。
 * 与 weather.ts 的 collectWeatherStations 同口径，但独立实现，不互相依赖。
 */
export interface PoiStationOption {
  stopId: string
  name: string
  lat: number
  lon: number
}

export function collectPoiStations(
  day: Pick<TripDay, 'stops'> | null | undefined,
): PoiStationOption[] {
  if (!day || !Array.isArray(day.stops)) return []
  const seen = new Set<string>()
  const stations: PoiStationOption[] = []
  for (const stop of day.stops) {
    const location = stop?.location
    if (!location) continue
    if (!isLatitude(location.lat) || !isLongitude(location.lng)) continue
    if (typeof stop.id !== 'string' || stop.id === '' || seen.has(stop.id)) continue
    seen.add(stop.id)
    stations.push({
      stopId: stop.id,
      name: typeof stop.name === 'string' && stop.name.trim() !== '' ? stop.name : '未命名站点',
      lat: location.lat,
      lon: location.lng,
    })
  }
  return stations
}

function validateTagField(value: unknown): value is PoiTagField {
  if (!isRecord(value)) return false
  if (value.state === 'unknown') return value.value === null || value.value === undefined
  if (value.state === 'source_only') {
    return isTagRawValue(value.value)
  }
  return false
}

function validateMeta(value: unknown): value is PoiSourceMeta {
  if (!isRecord(value)) return false
  // 逐字段与后端固定常量相等：署名/文档链接挂在「OpenStreetMap」名下，
  // 任意 https 站点不能因为「是 https」就冒充可查证的 OSM 来源。
  return (
    value.provider === TRUSTED_META.provider &&
    value.endpoint === TRUSTED_META.endpoint &&
    value.docs_url === TRUSTED_META.docs_url &&
    value.attribution_url === TRUSTED_META.attribution_url &&
    value.license === TRUSTED_META.license &&
    value.data_source === TRUSTED_META.data_source
  )
}

function validateCandidate(value: unknown): value is PoiSourceCandidate {
  if (!isRecord(value)) return false
  if (
    typeof value.element_type !== 'string' ||
    !ELEMENT_TYPES.includes(value.element_type as PoiElementType)
  ) {
    return false
  }
  if (
    typeof value.element_id !== 'number' ||
    !Number.isInteger(value.element_id) ||
    value.element_id <= 0 ||
    value.element_id > MAX_SAFE_INTEGER
  ) {
    return false
  }
  if (value.name !== null && typeof value.name !== 'string') return false
  if (!isCoordinateLike(value.location, isFiniteNumber)) return false
  const location = value.location as PoiCoordinate
  if (!isLatitude(location.lat) || !isLongitude(location.lon)) return false
  if (!isFiniteNumber(value.distance_m) || value.distance_m < 0) return false
  // distance_m 只是排序参考，但候选声称出自固定 100m 半径查询——
  // 声明超过 100m 的候选不可能出自这个合同，不展示超范围候选。
  //（后端 haversine 圆整误差 < 1e-6 m，此处 1e-6 覆盖浮点边界。）
  if (value.distance_m > FIXED_RADIUS_M + 1e-6) return false
  // source_url 必须与校验过的 type/id 构造的规范链接逐字一致
  if (value.source_url !== osmObjectUrl(value.element_type as PoiElementType, value.element_id)) {
    return false
  }
  if (!isUtcTimestamp(value.retrieved_at)) return false
  if (value.source_updated_at !== null && !isOsmTimestamp(value.source_updated_at)) return false
  if (value.identity_status !== 'unconfirmed') return false
  return (
    validateTagField(value.opening_hours) &&
    validateTagField(value.fee) &&
    validateTagField(value.charge)
  )
}

/**
 * 完整校验一份 PoiSourceReport，并核对它确实属于这次请求。
 * 校验失败只返回原因，不抛错；调用方（poiSourcesApi）统一折算成 bad_payload。
 *
 * 注意 requested 的比较：后端会把坐标 round 到 6 位小数再回传，所以用容差，
 * 不做浮点全等（否则合法响应会被错拒）。
 */
export function validatePoiSourceReport(
  value: unknown,
  query: PoiSourceQuery,
): PoiSourceValidationResult {
  if (!isLatitude(query.lat) || !isLongitude(query.lon)) {
    return { ok: false, reason: '请求坐标超出 WGS84 范围' }
  }
  if (!isRecord(value)) return { ok: false, reason: '响应不是对象' }

  const status = value.status
  if (typeof status !== 'string' || !POI_STATUSES.includes(status as PoiSourceStatus)) {
    return { ok: false, reason: 'status 不在约定取值内' }
  }
  const typedStatus = status as PoiSourceStatus

  if (value.reason !== null && typeof value.reason !== 'string') {
    return { ok: false, reason: 'reason 不是字符串或 null' }
  }
  if (value.provider_http_status !== null) {
    // provider_http_status：失败信封携带上游真实状态（429/5xx/4xx 等可为 null）；
    // available 一定是本次真实 2xx（见下方 typedStatus 分支）。
    if (
      !Number.isInteger(value.provider_http_status) ||
      (value.provider_http_status as number) < 0
    ) {
      return { ok: false, reason: 'provider_http_status 不是合法状态码' }
    }
  }
  if (!isUtcTimestamp(value.checked_at)) {
    return { ok: false, reason: 'checked_at 不是带时区的 ISO 时间' }
  }
  if (value.fetched_at !== null && !isUtcTimestamp(value.fetched_at)) {
    return { ok: false, reason: 'fetched_at 不是带时区的 ISO 时间' }
  }

  if (value.requested === null || !isCoordinateLike(value.requested, isFiniteNumber)) {
    return { ok: false, reason: 'requested 不是坐标' }
  }
  // 1e-6 舍入匹配不等于放行越界值：requested 本身也要是合法 WGS84 坐标
  const requested = value.requested as PoiCoordinate
  if (!isLatitude(requested.lat) || !isLongitude(requested.lon)) {
    return { ok: false, reason: 'requested 超出 WGS84 范围' }
  }
  if (!matchesRequestedCoordinate(value.requested as PoiCoordinate, query)) {
    return { ok: false, reason: 'requested 与本次请求坐标不一致' }
  }

  if (!isFiniteNumber(value.radius_m) || value.radius_m !== FIXED_RADIUS_M) {
    return { ok: false, reason: 'radius_m 与固定查询半径不一致' }
  }
  if (typeof value.cached !== 'boolean') {
    return { ok: false, reason: 'cached 不是布尔值' }
  }
  if (!validateMeta(value.source)) return { ok: false, reason: 'source 不是可信的 OSM 来源' }

  if (
    typeof value.source_elements_seen !== 'number' ||
    !Number.isInteger(value.source_elements_seen) ||
    value.source_elements_seen > MAX_SAFE_INTEGER ||
    value.source_elements_seen < 0
  ) {
    return { ok: false, reason: 'source_elements_seen 不是非负整数' }
  }
  // source_elements_seen 可以大于 30（后端只处理前 30 但如实记录 seen），不错拒

  if (!Array.isArray(value.candidates)) {
    return { ok: false, reason: 'candidates 不是数组' }
  }
  if (value.candidates.length > MAX_CANDIDATES) {
    return { ok: false, reason: '候选数量超过上限 8' }
  }
  if (!value.candidates.every(validateCandidate)) {
    return { ok: false, reason: '候选结构或来源链接不符合契约' }
  }
  // 候选坐标必须真的落在请求点固定半径内：distance_m 声称 5m 而实际 111m
  // 的候选不允许展示（后端按 haversine 过滤，此处独立复核同口径）。复核
  // 基准用 requested（后端舍入后的中心），与后端用同一坐标算球面距离，
  // 容差只覆盖浮点数值误差，不扩大接收半径。
  const queryCoord = value.requested as PoiCoordinate
  for (const candidate of value.candidates as PoiSourceCandidate[]) {
    const realDistance = haversineM(queryCoord.lat, queryCoord.lon, candidate.location.lat, candidate.location.lon)
    if (realDistance > FIXED_RADIUS_M + HAVERSINE_EPSILON_M) {
      return { ok: false, reason: '候选坐标超出固定查询半径' }
    }
  }

  if (!Array.isArray(value.notes) || !value.notes.every((n) => typeof n === 'string')) {
    return { ok: false, reason: 'notes 不是字符串数组' }
  }

  if (typedStatus === 'available' && value.candidates.length === 0) {
    return { ok: false, reason: 'available 响应必须至少有 1 个候选' }
  }
  if (typedStatus !== 'available' && value.candidates.length > 0) {
    return { ok: false, reason: '非 available 响应不应携带候选' }
  }
  if (typedStatus === 'available') {
    // available 意味着真实抓到过 provider 2xx 响应体：必须有真实获取时间
    // 与 2xx 状态，不能用 checked_at 伪装 fetched_at。
    if (value.fetched_at === null) {
      return { ok: false, reason: 'available 响应必须有真实 fetched_at' }
    }
    const httpStatus = value.provider_http_status
    if (typeof httpStatus !== 'number' || httpStatus < 200 || httpStatus > 299) {
      return { ok: false, reason: 'available 响应的 provider_http_status 必须是 2xx' }
    }
  }

  return { ok: true, report: value as unknown as PoiSourceReport }
}

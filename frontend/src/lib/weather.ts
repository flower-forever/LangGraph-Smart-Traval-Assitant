/**
 * 单日天气查询的前端契约与展示工具（独立于 Trip v1）。
 *
 * 数据来源：GET /api/weather/day?lat&lon&date，返回后端
 * weather_client.WeatherDayReport 的 JSON（直接是信封，不套第二层）。
 *
 * 边界：
 * - 只做 DTO 校验与展示换算，不写 Trip、不写 localStorage、不猜坐标。
 * - 校验以「请求」为基准：requested_date、coordinate.requested 要与本次请求一致，
 *   否则整份响应作废（bad_payload），不拿别的站点的结果凑数。
 * - 0 与负坐标是合法值；0 与负温也是真值，只有 null / 单位不符才算未知。
 * - WMO 代码只按官方表做确定性映射，表外代码保留原代码并显示「未知」。
 */
import type { TripDay } from './api'

/** 与后端 api_server 注册路径一致，走 Vite /api 代理。 */
export const WEATHER_DAY_PATH = '/api/weather/day'

/** 官方署名与文档地址：只作为可见链接的兜底，不杜撰来源。 */
export const OPEN_METEO_ATTRIBUTION_URL = 'https://open-meteo.com/'
export const OPEN_METEO_DOCS_URL = 'https://open-meteo.com/en/docs'
export const OPEN_METEO_ATTRIBUTION_TEXT = 'Weather data by Open-Meteo.com'

export type WeatherStatus =
  | 'available'
  | 'out_of_range'
  | 'invalid_request'
  | 'timeout'
  | 'unavailable'
  | 'failed'

export interface WeatherCoordinate {
  lat: number
  lon: number
}

export interface WeatherCoordinateInfo {
  system: 'WGS84'
  /** 固定 false：请求点与 provider 网格中心都不是站点核验坐标 */
  verified: false
  requested: WeatherCoordinate
  grid: WeatherCoordinate | null
  grid_elevation_m: number | null
}

export interface WeatherSource {
  provider: string
  endpoint: string
  docs_url: string
  attribution_url: string
  license: string
}

export interface WeatherCoverage {
  first_date: string | null
  last_date: string | null
  count: number
}

/** 与 weather_client._DAILY_VARIABLES 一致，顺序也保持官方请求顺序 */
export const WEATHER_FIELDS = [
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'weather_code',
] as const

export type WeatherField = (typeof WEATHER_FIELDS)[number]

export interface WeatherDayForecast {
  date: string
  /** 六个变量齐全；null 表示缺值 / 单位不符，不是 0 */
  values: Record<WeatherField, number | null>
  units: Record<WeatherField, string | null>
  missing_fields: string[]
}

export interface WeatherDayReport {
  status: WeatherStatus
  reason: string | null
  provider_http_status: number | null
  requested_date: string | null
  /** 本次调用开始处理的时间（UTC ISO） */
  checked_at: string
  /** 成功读到 provider 2xx 响应体的时间（UTC ISO）；失败分支为 null */
  fetched_at: string | null
  provider_timezone: string | null
  provider_utc_offset_seconds: number | null
  coordinate: WeatherCoordinateInfo
  source: WeatherSource
  coverage: WeatherCoverage
  forecast: WeatherDayForecast | null
}

export interface WeatherDayQuery {
  /** WGS84 纬度，-90..90 */
  lat: number
  /** WGS84 经度，-180..180 */
  lon: number
  /** YYYY-MM-DD 的查询日期 */
  date: string
}

export type WeatherValidationResult =
  | { ok: true; report: WeatherDayReport }
  | { ok: false; reason: string }

const WEATHER_STATUSES: readonly WeatherStatus[] = [
  'available',
  'out_of_range',
  'invalid_request',
  'timeout',
  'unavailable',
  'failed',
]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** 带时区偏移的 ISO 时间；后端用 datetime.isoformat()，UTC 时为 +00:00 */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const HTTPS_URL_RE = /^https:\/\/[^\s]+$/i
const COORD_EPSILON = 1e-5

/** JSON YYYY-MM-DD 且是真实日历日（挡 2026-02-31 / 空串 / 非字符串） */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

/** trip day.date 合法时直接作为查询初值；否则返回空串，要求用户自己选日期 */
export function initialWeatherDate(date: string | null | undefined): string {
  return isCalendarDate(date) ? date : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value))
}

function isLatitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -90 && value <= 90
}

function isLongitude(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -180 && value <= 180
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && HTTPS_URL_RE.test(value) && value.length <= 2048
}

function isCoordinateLike(value: unknown, check: (v: unknown) => boolean): value is WeatherCoordinate {
  return isRecord(value) && check(value.lat) && check(value.lon)
}

function matchesRequestedCoordinate(value: WeatherCoordinate, query: WeatherDayQuery): boolean {
  return (
    Math.abs(value.lat - query.lat) <= COORD_EPSILON &&
    Math.abs(value.lon - query.lon) <= COORD_EPSILON
  )
}

function validateSource(value: unknown): value is WeatherSource {
  if (!isRecord(value)) return false
  return (
    typeof value.provider === 'string' &&
    value.provider.length > 0 &&
    value.provider.length <= 64 &&
    isHttpsUrl(value.endpoint) &&
    isHttpsUrl(value.docs_url) &&
    isHttpsUrl(value.attribution_url) &&
    typeof value.license === 'string' &&
    value.license.length > 0 &&
    value.license.length <= 128
  )
}

function validateCoverage(value: unknown): value is WeatherCoverage {
  if (!isRecord(value)) return false
  if (!Number.isInteger(value.count) || (value.count as number) < 0) return false
  const first = value.first_date
  const last = value.last_date
  if (first === null && last === null) return value.count === 0
  if (!isCalendarDate(first) || !isCalendarDate(last)) return false
  return first <= last
}

function validateForecast(value: unknown, date: string): value is WeatherDayForecast {
  if (!isRecord(value)) return false
  if (value.date !== date) return false
  if (!isRecord(value.values) || !isRecord(value.units)) return false
  if (!Array.isArray(value.missing_fields) || !value.missing_fields.every((f) => typeof f === 'string')) {
    return false
  }
  return WEATHER_FIELDS.every(
    (field) =>
      Object.prototype.hasOwnProperty.call(value.values, field) &&
      Object.prototype.hasOwnProperty.call(value.units, field) &&
      isNullableFiniteNumber((value.values as Record<string, unknown>)[field]) &&
      isNullableString((value.units as Record<string, unknown>)[field]),
  )
}

/**
 * 完整校验一份 WeatherDayReport，并核对它确实属于这次请求。
 * 校验失败只返回原因，不抛错；调用方（weatherApi）统一折算成 bad_payload。
 */
export function validateWeatherDayReport(
  value: unknown,
  query: WeatherDayQuery,
): WeatherValidationResult {
  if (!isCalendarDate(query.date)) return { ok: false, reason: '请求日期不是合法日历日' }
  if (!isLatitude(query.lat) || !isLongitude(query.lon)) {
    return { ok: false, reason: '请求坐标超出 WGS84 范围' }
  }
  if (!isRecord(value)) return { ok: false, reason: '响应不是对象' }

  const status = value.status
  if (typeof status !== 'string' || !WEATHER_STATUSES.includes(status as WeatherStatus)) {
    return { ok: false, reason: 'status 不在约定取值内' }
  }
  const typedStatus = status as WeatherStatus

  if (value.requested_date !== query.date) {
    return { ok: false, reason: 'requested_date 与本次请求不一致' }
  }
  if (!isUtcTimestamp(value.checked_at)) {
    return { ok: false, reason: 'checked_at 不是带时区的 ISO 时间' }
  }
  if (value.fetched_at !== null && !isUtcTimestamp(value.fetched_at)) {
    return { ok: false, reason: 'fetched_at 不是带时区的 ISO 时间' }
  }
  if (value.provider_http_status !== null && !Number.isInteger(value.provider_http_status)) {
    return { ok: false, reason: 'provider_http_status 不是整数' }
  }
  if (!isNullableString(value.provider_timezone)) {
    return { ok: false, reason: 'provider_timezone 不是字符串或 null' }
  }
  if (value.provider_utc_offset_seconds !== null) {
    const offset = value.provider_utc_offset_seconds
    if (!Number.isInteger(offset) || Math.abs(offset as number) > 16 * 3600) {
      return { ok: false, reason: 'provider_utc_offset_seconds 超出保守范围' }
    }
  }

  const coordinate = value.coordinate
  if (!isRecord(coordinate)) return { ok: false, reason: 'coordinate 不是对象' }
  if (coordinate.system !== 'WGS84') return { ok: false, reason: 'coordinate.system 不是 WGS84' }
  if (coordinate.verified !== false) return { ok: false, reason: 'coordinate.verified 不是 false' }
  if (!isCoordinateLike(coordinate.requested, isFiniteNumber)) {
    return { ok: false, reason: 'coordinate.requested 不是坐标' }
  }
  if (!matchesRequestedCoordinate(coordinate.requested as WeatherCoordinate, query)) {
    return { ok: false, reason: 'coordinate.requested 与本次请求坐标不一致' }
  }
  if (coordinate.grid !== null && !isCoordinateLike(coordinate.grid, isFiniteNumber)) {
    return { ok: false, reason: 'coordinate.grid 不是坐标或 null' }
  }
  if (coordinate.grid !== null) {
    const grid = coordinate.grid as WeatherCoordinate
    if (!isLatitude(grid.lat) || !isLongitude(grid.lon)) {
      return { ok: false, reason: 'coordinate.grid 超出 WGS84 范围' }
    }
  }
  if (!isNullableFiniteNumber(coordinate.grid_elevation_m)) {
    return { ok: false, reason: 'coordinate.grid_elevation_m 不是数值或 null' }
  }

  if (!validateSource(value.source)) return { ok: false, reason: 'source 不是可信的 https 来源' }
  if (!validateCoverage(value.coverage)) return { ok: false, reason: 'coverage 结构不符合契约' }
  const coverage = value.coverage as WeatherCoverage

  const forecast = value.forecast
  if (typedStatus === 'available') {
    if (!validateForecast(forecast, query.date)) {
      return { ok: false, reason: 'available 响应缺少对应的 forecast' }
    }
    if (
      coverage.count === 0 ||
      coverage.first_date === null ||
      coverage.last_date === null ||
      query.date < coverage.first_date ||
      query.date > coverage.last_date
    ) {
      return { ok: false, reason: 'available 日期不在 coverage 内' }
    }
  } else {
    if (forecast !== null) return { ok: false, reason: '非 available 响应不应带 forecast' }
    if (typedStatus === 'out_of_range') {
      if (coverage.count === 0 || coverage.first_date === null || coverage.last_date === null) {
        return { ok: false, reason: 'out_of_range 响应缺少实际覆盖范围' }
      }
      if (query.date >= coverage.first_date && query.date <= coverage.last_date) {
        return { ok: false, reason: 'out_of_range 日期实际在覆盖范围内' }
      }
    }
  }

  return { ok: true, report: value as unknown as WeatherDayReport }
}

/** 官方 WMO 表内的中文描述；表外/非整数返回 null，不猜天气 */
export const WMO_DESCRIPTIONS_ZH: Readonly<Record<number, string>> = {
  0: '晴',
  1: '大致晴朗',
  2: '局部多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨（轻）',
  57: '冻毛毛雨（浓）',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨（轻）',
  67: '冻雨（浓）',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
}

export function weatherCodeLabel(code: unknown): string | null {
  if (typeof code !== 'number' || !Number.isInteger(code)) return null
  return WMO_DESCRIPTIONS_ZH[code] ?? null
}

/** 官方表外代码保留代码本身并注明未知；null 只显示未知 */
export function weatherCodeText(code: unknown): string {
  if (code === null || code === undefined) return '未知'
  if (typeof code !== 'number' || !Number.isInteger(code)) return '未知'
  return weatherCodeLabel(code) ?? `未知（代码 ${code}）`
}

/** 六变量的固定单位集合；后端已按这套单位校验，前端展示前再核一次 */
export const WEATHER_FIELD_UNITS: Readonly<Record<WeatherField, readonly string[]>> = {
  temperature_2m_max: ['°c'],
  temperature_2m_min: ['°c'],
  precipitation_sum: ['mm'],
  precipitation_probability_max: ['%'],
  wind_speed_10m_max: ['km/h', 'kmh'],
  weather_code: ['wmo code', 'wmo'],
}

export interface WeatherFieldReading {
  /** null 表示未知（缺值或单位不符），不是 0 */
  value: number | null
  /** provider 透传的原始单位，可能为 null */
  unit: string | null
  /** 是否可以作为已知数值展示 */
  known: boolean
}

/** 读一个变量：单位不符、越界或 null 都按未知处理；0 / 负温保留 */
export function readWeatherField(
  forecast: WeatherDayForecast | null | undefined,
  field: WeatherField,
): WeatherFieldReading {
  if (!forecast) return { value: null, unit: null, known: false }
  const value = forecast.values[field] ?? null
  const unit = forecast.units[field] ?? null
  const expected = WEATHER_FIELD_UNITS[field]
  const unitOk = unit !== null && expected.includes(unit.toLowerCase())
  let known = value !== null && unitOk
  if (known && value !== null) {
    if (field === 'precipitation_probability_max' && (value < 0 || value > 100)) known = false
    if ((field === 'precipitation_sum' || field === 'wind_speed_10m_max') && value < 0) known = false
  }
  return { value, unit, known }
}

/** 最多保留一位小数，去掉多余的 .0；0 原样显示 */
export function formatWeatherNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** 数值 + 单位；单位未知或值未知时由调用方显示未知 */
export function formatWeatherMetric(reading: WeatherFieldReading): string {
  if (!reading.known || reading.value === null || reading.unit === null) return '未知'
  const unit = reading.unit.toLowerCase() === '°c' ? '°C' : reading.unit
  if (unit === '%') return `${formatWeatherNumber(reading.value)}%`
  return `${formatWeatherNumber(reading.value)} ${unit}`
}

/** UTC ISO → `YYYY-MM-DD HH:mm:ss UTC`；解析不了就原样返回，不伪造时间 */
export function formatWeatherTimestamp(value: string | null | undefined): string {
  if (!value) return '未知'
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return value
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

/** 秒级偏移 → `UTC+08:00`；null / 非整数 → 未知 */
export function formatUtcOffset(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isInteger(seconds)) return '未知'
  const sign = seconds < 0 ? '-' : '+'
  const abs = Math.abs(seconds)
  const hours = String(Math.floor(abs / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((abs % 3600) / 60)).padStart(2, '0')
  return `UTC${sign}${hours}:${minutes}`
}

export interface WeatherStationOption {
  stopId: string
  name: string
  lat: number
  lon: number
}

/**
 * 从本日行程记录里取有合法 WGS84 坐标的站点。
 * 不查其它天、不用浏览器定位、不按城市猜；0 / 负坐标是合法值。
 * 同一天同一站点只保留一条（按 stop id 去重），顺序保持记录顺序。
 */
export function collectWeatherStations(
  day: Pick<TripDay, 'stops'> | null | undefined,
): WeatherStationOption[] {
  if (!day || !Array.isArray(day.stops)) return []
  const seen = new Set<string>()
  const stations: WeatherStationOption[] = []
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

/** 覆盖范围的一句话；字段缺失时明确说未知 */
export function formatCoverage(coverage: WeatherCoverage | null | undefined): string {
  if (!coverage || coverage.count <= 0 || !coverage.first_date || !coverage.last_date) {
    return '未知'
  }
  return `${coverage.first_date} 至 ${coverage.last_date}（共 ${coverage.count} 天）`
}

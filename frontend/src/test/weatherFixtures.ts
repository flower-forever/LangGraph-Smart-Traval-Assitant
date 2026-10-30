/**
 * 天气测试夹具：构造 WeatherDayReport 与含/不含坐标的行程，不包含任何业务断言。
 * 只给离线测试用，不参与构建产物。
 */
import type { Trip, TripDay, TripStop } from '../lib/api'
import type {
  WeatherCoverage,
  WeatherCoordinateInfo,
  WeatherDayForecast,
  WeatherDayQuery,
  WeatherDayReport,
  WeatherField,
} from '../lib/weather'

export const CHECKED_AT = '2026-10-30T04:00:00+00:00'
export const FETCHED_AT = '2026-10-30T04:00:02+00:00'

export const DEFAULT_UNITS: Record<WeatherField, string> = {
  temperature_2m_max: '°C',
  temperature_2m_min: '°C',
  precipitation_sum: 'mm',
  precipitation_probability_max: '%',
  wind_speed_10m_max: 'km/h',
  weather_code: 'wmo code',
}

export function makeForecast(
  date: string,
  values: Partial<Record<WeatherField, number | null>> = {},
  units: Partial<Record<WeatherField, string | null>> = {},
  missingFields?: string[],
): WeatherDayForecast {
  const mergedValues = {
    temperature_2m_max: 21.4,
    temperature_2m_min: 9.2,
    precipitation_sum: 0,
    precipitation_probability_max: 12,
    wind_speed_10m_max: 18.5,
    weather_code: 3,
    ...values,
  } as Record<WeatherField, number | null>
  const mergedUnits = { ...DEFAULT_UNITS, ...units } as Record<WeatherField, string | null>
  const missing = missingFields ?? (Object.keys(mergedValues) as WeatherField[]).filter((f) => mergedValues[f] === null)
  return { date, values: mergedValues, units: mergedUnits, missing_fields: missing }
}

export function makeCoordinate(
  query: WeatherDayQuery,
  grid: { lat: number; lon: number } | null = { lat: query.lat + 0.05, lon: query.lon + 0.05 },
): WeatherCoordinateInfo {
  return {
    system: 'WGS84',
    verified: false,
    requested: { lat: query.lat, lon: query.lon },
    grid,
    grid_elevation_m: grid ? 7 : null,
  }
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

export function makeCoverage(first = '2026-10-30', last = '2026-11-14', count = 16): WeatherCoverage {
  return { first_date: first, last_date: last, count }
}

/**
 * 默认返回 available 的完整信封。要构造其它状态时传 patch：
 * 例如 makeWeatherReport(query, { status: 'out_of_range', forecast: null, coverage: ... })
 */
export function makeWeatherReport(
  query: WeatherDayQuery,
  patch: Partial<WeatherDayReport> = {},
): WeatherDayReport {
  const base: WeatherDayReport = {
    status: 'available',
    reason: null,
    provider_http_status: 200,
    requested_date: query.date,
    checked_at: CHECKED_AT,
    fetched_at: FETCHED_AT,
    provider_timezone: 'Asia/Shanghai',
    provider_utc_offset_seconds: 28800,
    coordinate: makeCoordinate(query),
    source: {
      provider: 'open-meteo',
      endpoint: 'https://api.open-meteo.com/v1/forecast',
      docs_url: 'https://open-meteo.com/en/docs',
      attribution_url: 'https://open-meteo.com/',
      license: 'CC BY 4.0',
    },
    coverage: makeCoverage(query.date, addDays(query.date, 15), 16),
    forecast: makeForecast(query.date),
  }
  return { ...base, ...patch }
}

export function makeStop(
  id: string,
  name: string,
  location: { lng: number; lat: number } | null,
  time = '09:00',
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes: 60,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location,
  }
}

export function makeDay(
  day: number,
  date: string | null,
  stops: TripStop[],
  title = `第 ${day} 天`,
): TripDay {
  return { day, date, title, summary: `${title}摘要。`, stops, legs: [] }
}

/**
 * 覆盖场景的行程：
 * - 第 1 天：合法日期 + 两个有坐标站点 + 一个无坐标站点（可验证站点切换）
 * - 第 2 天：无日期 + 坐标 (0,0)（0 不是缺值）
 * - 第 3 天：非法日期 + 负坐标（-33.86, 151.21）
 * - 第 4 天：合法日期 + 全部无坐标（禁用查询）
 */
export function makeWeatherTrip(patch: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-weather-1',
    source: 'example',
    destination: '苏州',
    title: '天气测试行程',
    summary: '用于离线天气面板测试的行程。',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [
      makeDay(1, '2026-05-01', [
        makeStop('w1', '虎丘', { lng: 120.57, lat: 31.33 }),
        makeStop('w1b', '寒山寺', { lng: 120.56, lat: 31.31 }),
        makeStop('w1c', '无坐标站点', null),
      ]),
      makeDay(2, null, [makeStop('w2', '赤道站点', { lng: 0, lat: 0 })]),
      makeDay(3, 'not-a-date', [makeStop('w3', '南半球站点', { lng: 151.21, lat: -33.86 })]),
      makeDay(4, '2026-05-04', [
        makeStop('w4', '只有文字 A', null),
        makeStop('w4b', '只有文字 B', null),
      ]),
    ],
    ...patch,
  }
}

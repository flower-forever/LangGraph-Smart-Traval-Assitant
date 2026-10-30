/**
 * 单日天气查询的网络客户端：GET /api/weather/day?lat&lon&date。
 *
 * 复用 api.ts 的 getJson（取消 / 超时时钟 / baseUrl / 错误分类），
 * 不另起一套 fetch。响应按 unknown 接回，再用 validateWeatherDayReport
 * 核对整份信封与本次请求是否一致；不过关统一抛 ApiError('bad_payload')。
 */
import { ApiError, getJson, type ApiOptions } from './api'
import {
  WEATHER_DAY_PATH,
  validateWeatherDayReport,
  type WeatherDayQuery,
  type WeatherDayReport,
} from './weather'

/**
 * 前端等待上限：后端内部总 deadline 是 8 秒，这里留出传输与排队的余量。
 * 超时只结束本页等待，不保证后端停止处理。
 */
export const WEATHER_TIMEOUT_MS = 15000

/** 请求 adapter 签名：面板默认用它，测试可注入 mock。 */
export type WeatherAdapter = (
  query: WeatherDayQuery,
  options?: { signal?: AbortSignal },
) => Promise<WeatherDayReport>

/** 组装路径与查询串；坐标/日期只按记录值透传，不做额外取整或换算 */
export function buildWeatherDayPath(query: WeatherDayQuery): string {
  const params = new URLSearchParams({
    lat: String(query.lat),
    lon: String(query.lon),
    date: query.date,
  })
  return `${WEATHER_DAY_PATH}?${params.toString()}`
}

/**
 * 查询单日天气。成功返回已校验的 DTO；网络失败、HTTP 错误、取消、超时
 * 沿用 getJson 的 ApiError 分类；结构或归属不符抛 ApiError('bad_payload')。
 * 每次调用只发一次请求，不自动重试。
 */
export async function fetchDayWeather(
  query: WeatherDayQuery,
  options?: ApiOptions,
): Promise<WeatherDayReport> {
  const data = await getJson<unknown>(buildWeatherDayPath(query), {
    timeoutMs: WEATHER_TIMEOUT_MS,
    ...options,
  })
  const validated = validateWeatherDayReport(data, query)
  if (!validated.ok) {
    throw new ApiError('bad_payload', '天气接口返回的结构与本次请求不一致')
  }
  return validated.report
}

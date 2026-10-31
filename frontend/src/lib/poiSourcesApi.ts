/**
 * POI 公开资料查询的网络客户端：GET /api/poi-sources/nearby?lat&lon。
 *
 * 复用 api.ts 的 getJson（取消 / 超时时钟 / baseUrl / 错误分类），
 * 不另起一套 fetch，也不改公共 api.ts。响应按 unknown 接回，再用
 * validatePoiSourceReport 核对整份信封与本次请求是否一致；不过关统一
 * 抛 ApiError('bad_payload')。
 *
 * invalid_request 是 HTTP 422 + 完整信封在 body.report 里，getJson 会把
 * 422 折成 ApiError('server')——面板层按状态映射固定文案，不回显 detail 原文。
 */
import { ApiError, getJson, type ApiOptions } from './api'
import {
  POI_SOURCES_NEARBY_PATH,
  validatePoiSourceReport,
  type PoiSourceQuery,
  type PoiSourceReport,
} from './poiSources'

/**
 * 前端等待上限：后端内部总 deadline 是 8 秒，这里留出传输与排队的余量。
 * 超时只结束本页等待，不保证后端停止处理。
 */
export const POI_SOURCES_TIMEOUT_MS = 12000

/** 请求 adapter 签名：面板默认用它，测试可注入 mock。 */
export type PoiSourcesAdapter = (
  query: PoiSourceQuery,
  options?: { signal?: AbortSignal },
) => Promise<PoiSourceReport>

/** 组装路径与查询串；坐标只按记录值透传，不做额外取整或换算 */
export function buildPoiSourcesNearbyPath(query: PoiSourceQuery): string {
  const params = new URLSearchParams({
    lat: String(query.lat),
    lon: String(query.lon),
  })
  return `${POI_SOURCES_NEARBY_PATH}?${params.toString()}`
}

/**
 * 查询附近公开资料候选。成功返回已校验的 DTO；网络失败、HTTP 错误、取消、
 * 超时沿用 getJson 的 ApiError 分类；结构或归属不符抛 ApiError('bad_payload')。
 * 每次调用只发一次请求，不自动重试。
 */
export async function fetchPoiSourcesNearby(
  query: PoiSourceQuery,
  options?: ApiOptions,
): Promise<PoiSourceReport> {
  const data = await getJson<unknown>(buildPoiSourcesNearbyPath(query), {
    timeoutMs: POI_SOURCES_TIMEOUT_MS,
    ...options,
  })
  const validated = validatePoiSourceReport(data, query)
  if (!validated.ok) {
    throw new ApiError('bad_payload', '公开资料接口返回的结构与本次请求不一致')
  }
  return validated.report
}

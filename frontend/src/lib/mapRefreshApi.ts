/**
 * 单日地图刷新的 HTTP 包装。
 * 只复用 api.ts 的 postJson / ApiOptions（取消、超时时钟、baseUrl、错误分类），
 * 不另建 fetch、时钟或重试；响应交 mapRefresh.validateMapRefreshResponse 做完整业务校验，
 * 结构不符统一抛 ApiError('bad_payload')，不把坏数据漏给界面。
 * 请求体由 buildMapRefreshRequest 构造后原样交给本层，本层不重新生成名字或坐标。
 */
import { ApiError, postJson, type ApiOptions } from './api'
import {
  validateMapRefreshResponse,
  type MapRefreshRequest,
  type MapRefreshResponse,
} from './mapRefresh'

export const MAP_REFRESH_PATH = '/api/trips/days/map-refresh'

/** 后端总预算 20s，留 5s 给传输与校验；调用方仍可覆盖。 */
export const MAP_REFRESH_DEFAULT_TIMEOUT_MS = 25_000

export type MapRefreshAdapter = (
  request: MapRefreshRequest,
  options?: ApiOptions,
) => Promise<MapRefreshResponse>

/**
 * POST /api/trips/days/map-refresh。
 * 网络失败、HTTP 错误、取消与超时沿用 postJson 的 ApiError 分类；
 * 响应结构或业务约束不过关时抛 ApiError('bad_payload')。
 */
export async function refreshDayMap(
  request: MapRefreshRequest,
  options?: ApiOptions,
): Promise<MapRefreshResponse> {
  const data = await postJson<unknown>(MAP_REFRESH_PATH, request, {
    ...options,
    timeoutMs: options?.timeoutMs ?? MAP_REFRESH_DEFAULT_TIMEOUT_MS,
  })
  const validated = validateMapRefreshResponse(data, request)
  if (!validated.ok) {
    throw new ApiError('bad_payload', '地图刷新返回结构不符合契约')
  }
  return validated.response
}

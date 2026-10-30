/**
 * 单日 AI 重规划的网络客户端：POST /api/trips/days/replan。
 *
 * 复用 api.ts 的 postJson / ApiOptions（取消、超时时钟、baseUrl、错误分类），
 * 不另起一套 fetch 与错误处理。响应先按 unknown 接回，再交给
 * validateDayReplanResponse 做完整业务校验；结构不符时统一抛
 * ApiError('bad_payload')，不把坏数据漏给界面。
 */
import { ApiError, postJson, type ApiOptions } from './api'
import { validateDayReplanResponse, type DayReplanRequest, type DayReplanResponse } from './dayReplan'

/** 与后端 api_server 中的注册路径一致，走 Vite /api 代理。 */
export const DAY_REPLAN_PATH = '/api/trips/days/replan'

/**
 * 发起单日 AI 重规划。成功返回已校验的 DTO；
 * 网络失败、HTTP 错误、取消与超时沿用 postJson 的 ApiError 分类；
 * 响应结构或业务约束不过关时抛 ApiError('bad_payload')。
 */
export async function replanDay(
  request: DayReplanRequest,
  options?: ApiOptions,
): Promise<DayReplanResponse> {
  const data = await postJson<unknown>(DAY_REPLAN_PATH, request, options)
  const validated = validateDayReplanResponse(data, request)
  if (!validated.ok) {
    throw new ApiError('bad_payload', 'AI 单日调整返回结构不符合契约')
  }
  return validated.response
}

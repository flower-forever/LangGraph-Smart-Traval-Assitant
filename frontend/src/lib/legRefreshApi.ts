/**
 * 固定端点衔接路线的 HTTP 包装（纯网络层，不接 App/UI）。
 *
 * 复用 api.ts 的 postJson / ApiOptions（取消、超时时钟、baseUrl、错误分类），
 * 不另建 fetch、时钟或重试；每次调用只对固定 path 发一次 POST，不自动查询。
 * 请求先经 legRefresh.validateLegRefreshRequest 校验并投影，非法时零 fetch；
 * 响应交 validateLegRefreshResponse 核对完整 echo、map_status 与 geometry，
 * 不过关统一抛 ApiError('bad_payload')，不把坏数据漏给界面。
 *
 * HTTP 422/5xx 等状态错误沿用 ApiError('server') 分类，但统一替换为固定安全文案：
 * 不透传后端 detail、原始 body、Key 或任意 URL。HTTP 200 的 typed 失败仍按
 * LegRefreshResponse 返回，调用方必须检查 map_status；本层不把 200 当 ready。
 */
import { ApiError, postJson, type ApiOptions } from './api'
import {
  validateLegRefreshRequest,
  validateLegRefreshResponse,
  type LegRefreshRequest,
  type LegRefreshResponse,
} from './legRefresh'

export const LEG_REFRESH_PATH = '/api/trips/days/leg-refresh'

/** 后端总预算 20s，留 5s 给传输与校验；调用方仍可覆盖。 */
export const LEG_REFRESH_DEFAULT_TIMEOUT_MS = 25_000

function safeServerError(error: ApiError): ApiError {
  if (error.kind !== 'server') return error
  let message = '衔接路线查询失败，请稍后再试'
  if (error.status === 422) message = '衔接路线请求未通过服务端校验，本次未执行查询'
  if (error.status === 503) message = '衔接路线服务暂不可用，请稍后再试'
  // 不保留 detail：后端 / 代理原文可能含 Key、任意输入或上游 body。
  return new ApiError('server', message, error.status, undefined, error.upstreamUnavailable)
}

/**
 * 按显式请求查询固定 WGS84 端点的单段衔接路线。
 * - 只在调用时发一次 POST；无自动重试、无自动保存/应用；
 * - 本地请求非法时抛固定 bad_payload，且 0 次 fetch；
 * - 网络 / HTTP / 取消 / 超时沿用 shared ApiError 分类；
 * - 结构或业务约束不符抛固定 bad_payload，不回显响应内容；
 * - 返回的 typed 信封可能 map_status 非 ready，调用方必须自行检查。
 */
export async function refreshLegRoute(
  request: LegRefreshRequest,
  options?: ApiOptions,
): Promise<LegRefreshResponse> {
  const local = validateLegRefreshRequest(request)
  if (!local.ok) {
    throw new ApiError('bad_payload', '衔接路线请求未通过本地校验')
  }

  let data: unknown
  try {
    data = await postJson<unknown>(LEG_REFRESH_PATH, local.request, {
      ...options,
      timeoutMs: options?.timeoutMs ?? LEG_REFRESH_DEFAULT_TIMEOUT_MS,
    })
  } catch (error) {
    if (error instanceof ApiError) throw safeServerError(error)
    throw error
  }

  const validated = validateLegRefreshResponse(data, local.request)
  if (!validated.ok) {
    throw new ApiError('bad_payload', '衔接路线返回结构不符合契约')
  }
  return validated.response
}

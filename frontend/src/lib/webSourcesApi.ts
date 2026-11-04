/**
 * Tavily 网页资料搜索的请求 adapter（纯网络层，不接 App/UI）。
 *
 * 复用 api.ts 的 postJson / ApiOptions（取消、超时时钟、baseUrl、错误分类），
 * 不另起 fetch、不改公共 api.ts。每次调用只发一次 POST，不重试、不自动查询；
 * body 只含规范化 query。响应按 unknown 接回，再用 validateWebSearchReport
 * 核对整份信封与本次实发 query；不过关统一抛 ApiError('bad_payload')。
 *
 * HTTP 422/503 等状态错误沿用 ApiError('server') 分类，但统一替换为固定
 * 安全文案：不透传后端 detail、原始 body 或 Key。
 */
import { ApiError, postJson, type ApiOptions } from './api'
import {
  WEB_SOURCES_SEARCH_PATH,
  buildWebSearchRequestBody,
  normalizeWebSearchQuery,
  validateWebSearchReport,
  type WebSearchReport,
} from './webSources'

/** 后端总 deadline 默认 10s；前端留出传输/排队余量。 */
export const WEB_SOURCES_TIMEOUT_MS = 12000

function safeServerError(error: ApiError): ApiError {
  if (error.kind !== 'server') return error
  let message = '网页资料搜索请求失败，请稍后再试'
  if (error.status === 422) message = '查询参数未通过校验，请修改后重试'
  if (error.status === 503) message = '网页资料搜索服务暂不可用，请稍后再试'
  // 不保留 detail：后端/代理的原文可能含 Key 或任意输入。
  return new ApiError('server', message, error.status, undefined, error.upstreamUnavailable)
}

/**
 * 按用户显式 query 搜索网页资料。成功返回已校验的 typed 信封；
 * 本地查询非法时 0 请求；网络/超时/取消沿用 postJson 的 ApiError 分类；
 * 结构不符抛 ApiError('bad_payload')。
 */
export async function searchWebSources(
  rawQuery: string,
  options?: ApiOptions,
): Promise<WebSearchReport> {
  const query = normalizeWebSearchQuery(rawQuery)
  if (query === null) {
    throw new ApiError('bad_payload', '查询参数未通过本地校验')
  }

  let data: unknown
  try {
    data = await postJson<unknown>(
      WEB_SOURCES_SEARCH_PATH,
      buildWebSearchRequestBody(query),
      { timeoutMs: WEB_SOURCES_TIMEOUT_MS, ...options },
    )
  } catch (error) {
    if (error instanceof ApiError) throw safeServerError(error)
    throw error
  }

  const validated = validateWebSearchReport(data, query)
  if (!validated.ok) {
    throw new ApiError('bad_payload', '网页资料搜索返回结构不符合契约')
  }
  return validated.report
}

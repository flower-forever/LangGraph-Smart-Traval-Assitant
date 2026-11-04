/**
 * 网页资料搜索（/api/web-sources/search）契约夹具构造器。
 * 与 contractFixtures.test.mjs / webSourcesFixtures.test.mjs / runner 同源：
 * 这里产出的信封就是浏览器验收会话里桩返回的原文，测试用前端真实
 * validateWebSearchReport 闭环——构造器或前端契约任一侧漂移先红。
 *
 * 数据（结果模板/固定 reason）在 contractFixtures.json 的 webSourcesTemplate；
 * 只服务浏览器验收，不是真实 Tavily：所有结果/摘录/日期都是固定测试值。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(resolve(here, 'contractFixtures.json'), 'utf-8'))

/** 桩实现的信封状态集合（业务失败首批仅 no_key / unavailable；其余沿后端真实合同） */
export const WEB_SOURCES_MODES = ['available', 'no_results', 'no_usable_results', 'no_key', 'unavailable']

/** 与后端 tavily_web_api.py 相同的固定 422 文案（绝不回显无效原文） */
const WEB_SOURCES_INVALID_DETAIL = 'query 必须为去除首尾空白后 1 到 300 个字符的文本'

function nowIso() {
  return new Date().toISOString().replace('Z', '+00:00')
}

/** 请求体只允许 {query}；多余字段/非对象/缺字段都算本地形状不符。返回 {query} 或 undefined。 */
export function parseWebSearchRequestBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const keys = Object.keys(body)
  if (keys.length !== 1 || !('query' in body)) return undefined
  if (typeof body.query !== 'string') return undefined
  return { query: body.query }
}

/** 后端 _invalid_body_response 的固定形状：固定 detail + report:null + 状态头 */
export function buildWebSearchInvalidResponse() {
  return {
    status: 422,
    headers: { 'x-web-sources-status': 'invalid_request' },
    body: { detail: WEB_SOURCES_INVALID_DETAIL, report: null },
  }
}

/**
 * 构造 WebSearchReport 信封（与 runner / contractFixtures.test 同源）：
 * - available/no_results/no_usable_results/no_key/unavailable 之外的 mode 直接 error；
 * - query 原样写入 requested_query（由调用方保证已规范化，FEFF 等原样保留）；
 * - checked_at 实例化为当前时刻，其余字段取固定 fixture，满足前端 validateWebSearchReport。
 */
export function buildWebSearchReport(mode, query) {
  if (!WEB_SOURCES_MODES.includes(mode)) {
    return { error: `契约桩未实现的网页资料模式：${mode}` }
  }
  const template = fixtures.webSourcesTemplate
  const checkedAt = nowIso()
  if (mode === 'available' || mode === 'no_results' || mode === 'no_usable_results') {
    const isAvailable = mode === 'available'
    return {
      report: {
        status: mode,
        reason: null,
        provider_http_status: 200,
        checked_at: checkedAt,
        fetched_at: nowIso(),
        requested_query: query,
        max_results: 3,
        results_seen: isAvailable ? 2 : mode === 'no_results' ? 0 : template.no_usable_results.results_seen,
        results: isAvailable ? template.available.results : [],
        notes: isAvailable
          ? [...template.available.notes]
          : mode === 'no_results'
            ? ['契约桩固定空结果：上游成功返回但没有条目（测试值，不是真实 Tavily 响应）。']
            : [...template.no_usable_results.notes],
        source: {
          provider: 'tavily',
          endpoint: 'https://api.tavily.com/search',
          docs_url: 'https://docs.tavily.com/api-reference/endpoint/search',
        },
        content_status: 'unverified',
      },
    }
  }
  // no_key / unavailable：0 次上游尝试的信封，fetched_at 与 provider_http_status 语义不同
  return {
    report: {
      status: mode,
      reason: template.reasons[mode],
      provider_http_status: mode === 'unavailable' ? 503 : null,
      checked_at: checkedAt,
      fetched_at: null,
      requested_query: query,
      max_results: 3,
      results_seen: 0,
      results: [],
      notes: ['契约桩固定失败信封：不是真实 Tavily 调用结果。'],
      source: {
        provider: 'tavily',
        endpoint: 'https://api.tavily.com/search',
        docs_url: 'https://docs.tavily.com/api-reference/endpoint/search',
      },
      content_status: 'unverified',
    },
  }
}

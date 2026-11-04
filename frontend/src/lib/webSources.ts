/**
 * Tavily 网页资料搜索的前端纯契约（无网络、无 UI）。
 *
 * 事实来源：后端 tavily_web_client.py / tavily_web_api.py（2026-11-03 当前版）。
 * 本文件只做类型、query 规范化、URL/日期/信封校验与安全文案，不写 Trip、
 * 不读 localStorage、不自动查询、不抓取任何结果链接。WebSourcesPanel 已在 App 接入。
 */

/** 与后端注册路径一致，走 Vite /api 代理。 */
export const WEB_SOURCES_SEARCH_PATH = '/api/web-sources/search'

/** 后端固定 source 常量（WebSourceMeta）。 */
export const WEB_SOURCES_PROVIDER = 'tavily'
export const WEB_SOURCES_ENDPOINT = 'https://api.tavily.com/search'
export const WEB_SOURCES_DOCS_URL = 'https://docs.tavily.com/api-reference/endpoint/search'

export const WEB_SOURCES_MAX_QUERY_CODEPOINTS = 300
export const WEB_SOURCES_MAX_TITLE_CODEPOINTS = 300
export const WEB_SOURCES_MAX_SNIPPET_CODEPOINTS = 500
export const WEB_SOURCES_MAX_URL_CODEPOINTS = 2048
export const WEB_SOURCES_MAX_RESULTS = 5
export const WEB_SOURCES_MAX_NOTES = 10
export const WEB_SOURCES_MAX_NOTE_CODEPOINTS = 300
export const WEB_SOURCES_MAX_NOTES_TOTAL_CODEPOINTS = 2000

export type WebSourceStatus =
  | 'available'
  | 'no_results'
  | 'no_usable_results'
  | 'invalid_request'
  | 'no_key'
  | 'timeout'
  | 'rate_limited'
  | 'unauthorized'
  | 'unavailable'
  | 'failed'

export interface WebSourceMeta {
  provider: typeof WEB_SOURCES_PROVIDER
  endpoint: typeof WEB_SOURCES_ENDPOINT
  docs_url: typeof WEB_SOURCES_DOCS_URL
}

export interface WebSearchResult {
  /** 后端超长 title 会置 null；不会截断伪造。 */
  title: string | null
  url: string
  /** 后端截到 500 码点；null 表示上游没提供。 */
  snippet: string | null
  snippet_truncated: boolean
  /** 只来自上游真实字段归一化；缺失/非法为 null。 */
  publication_date: string | null
}

export interface WebSearchReport {
  status: WebSourceStatus
  reason: string | null
  provider_http_status: number | null
  /** 查询发起时刻（UTC ISO），不是网页发布时间。 */
  checked_at: string
  /** 仅成功读取上游 2xx body 且解析可信后才有；失败为 null。 */
  fetched_at: string | null
  /** 实际发送的规范化 query；invalid_request 为 null。 */
  requested_query: string | null
  /** 后端构造参数 1..5。 */
  max_results: number
  /** 上游原始条目数；可能大于 25（后端只投影前 25）。 */
  results_seen: number
  results: WebSearchResult[]
  notes: string[]
  source: WebSourceMeta
  content_status: 'unverified'
}

export type WebSearchValidationResult =
  | { ok: true; report: WebSearchReport }
  | { ok: false; reason: string }

export interface WebSearchRequestBody {
  query: string
}

const STATUSES: readonly WebSourceStatus[] = [
  'available',
  'no_results',
  'no_usable_results',
  'invalid_request',
  'no_key',
  'timeout',
  'rate_limited',
  'unauthorized',
  'unavailable',
  'failed',
]

const SUCCESS_STATUSES: readonly WebSourceStatus[] = [
  'available',
  'no_results',
  'no_usable_results',
]

const REPORT_KEYS = [
  'status',
  'reason',
  'provider_http_status',
  'checked_at',
  'fetched_at',
  'requested_query',
  'max_results',
  'results_seen',
  'results',
  'notes',
  'source',
  'content_status',
] as const

const RESULT_KEYS = [
  'title',
  'url',
  'snippet',
  'snippet_truncated',
  'publication_date',
] as const

const SOURCE_KEYS = ['provider', 'endpoint', 'docs_url'] as const

/** Python str.isspace() 的空白集合（多 U+0085、少 U+FEFF），用于 strip 与 URL 对齐。 */
const PYTHON_WHITESPACE_RE =
  /[\t\n\v\f\r \u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u

/** 与 Python str.strip() 同口径：只剥首尾 Python 空白，不折叠/不改内部。 */
function stripPythonWhitespace(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && PYTHON_WHITESPACE_RE.test(value.charAt(start))) start += 1
  while (end > start && PYTHON_WHITESPACE_RE.test(value.charAt(end - 1))) end -= 1
  return value.slice(start, end)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

/** JS 字符串是否没有孤立代理码点（合法代理对算一个 astral 字符）。 */
export function isWellFormedUnicodeText(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) return false
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

/** 与后端 str.strip() 同口径的 strip + 1..300 Unicode 码点 + 拒绝孤立代理。 */
export function normalizeWebSearchQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = stripPythonWhitespace(value)
  if (!trimmed) return null
  if (!isWellFormedUnicodeText(trimmed)) return null
  if (trimmed.length > WEB_SOURCES_MAX_QUERY_CODEPOINTS * 2) return null
  if (codePointLength(trimmed) > WEB_SOURCES_MAX_QUERY_CODEPOINTS) return null
  return trimmed
}

/** 请求体只允许 query；不拼 Trip/坐标/Key。 */
export function buildWebSearchRequestBody(query: string): WebSearchRequestBody {
  return { query }
}

function isDnsLabel(label: string): boolean {
  if (!label || label.length > 63) return false
  if (!/^[a-z0-9-]+$/i.test(label)) return false
  return !label.startsWith('-') && !label.endsWith('-')
}

function isPunycodeTld(label: string): boolean {
  if (!label.toLowerCase().startsWith('xn--') || label.length <= 4) return false
  const rest = label.slice(4)
  return /^[a-z0-9-]+$/i.test(rest) && !rest.startsWith('-') && !rest.endsWith('-')
}

function lastLabelIsTld(label: string): boolean {
  if (label.length >= 2 && label.length <= 63 && /^[a-z]+$/i.test(label)) return true
  return isPunycodeTld(label)
}

function isLocalOrIpHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  const labels = host.split('.')
  if (labels.length < 2) return true
  const last = labels[labels.length - 1]
  if (/^\d+$/.test(last)) return true
  if (last.startsWith('0x')) return true
  if (labels.every((label) => /^\d+$/.test(label))) return true
  return false
}

/**
 * 结果链接的保守白名单，与后端 is_shareable_https_url 对齐。
 *
 * 先检查原始 authority（host:port）：拒绝反斜杠、userinfo `@`、`%` 编码
 * host、原始非 ASCII host。TS 的 `new URL` 会把 Unicode host 自动转 punycode、
 * 把反斜杠归一成 `/`，所以必须先用原始字符串挡住，不能让它偷偷放开 IDN
 * 或转义 host。Unicode path 合法；不解析 DNS、不 fetch 链接。
 */
export function isShareableWebSourceUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (!value || value.length > WEB_SOURCES_MAX_URL_CODEPOINTS * 2) return false
  if (codePointLength(value) > WEB_SOURCES_MAX_URL_CODEPOINTS) return false
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false
  if (PYTHON_WHITESPACE_RE.test(value)) return false
  if (!isWellFormedUnicodeText(value)) return false
  const scheme = /^https:\/\//i.exec(value)
  if (!scheme) return false

  const afterScheme = value.slice(scheme[0].length)
  const authorityEnd = afterScheme.search(/[/?#]/)
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd)
  if (!authority) return false
  // 原始 authority 里不允许反斜杠/@/%/非 ASCII：这些是 WHATWG 会自动
  // 归一化或解码、而后端会拒绝的形式。
  if (authority.includes('\\') || authority.includes('@') || authority.includes('%')) return false
  if (!/^[\x21-\x7e]+$/.test(authority)) return false

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  if (parsed.port !== '') return false

  const host = parsed.hostname.toLowerCase()
  if (!host || host.endsWith('.') || host.includes(':')) return false
  if (!/^[a-z0-9.-]+$/.test(host)) return false
  if (isLocalOrIpHost(host)) return false

  const labels = host.split('.')
  if (labels.length < 2) return false
  if (!labels.every(isDnsLabel)) return false
  return lastLabelIsTld(labels[labels.length - 1])
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** 只认真实日历日，避免 Date.parse 把 2025-02-30 滚到 3 月。 */
export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]
}

const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

/** 后端 checked_at/fetched_at 是带时区的真实 ISO 时间；拒绝滚动日期。 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = ISO_TIMESTAMP_RE.exec(value)
  if (!match) return false
  const [, year, month, day, hour, minute, second, zone] = match
  if (!isIsoCalendarDate(`${year}-${month}-${day}`)) return false
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3))
    const offsetMinute = Number(zone.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) return false
  }
  return true
}

function isBoundedText(value: unknown, maxCodepoints: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxCodepoints * 2 &&
    isWellFormedUnicodeText(value) &&
    codePointLength(value) <= maxCodepoints
  )
}

function isNullableBoundedText(value: unknown, maxCodepoints: number): value is string | null {
  if (value === null) return true
  return isBoundedText(value, maxCodepoints) && stripPythonWhitespace(value) !== ''
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isValidProviderStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 599
}

function validateSource(value: unknown): value is WebSourceMeta {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_KEYS)) return false
  return (
    value.provider === WEB_SOURCES_PROVIDER &&
    value.endpoint === WEB_SOURCES_ENDPOINT &&
    value.docs_url === WEB_SOURCES_DOCS_URL
  )
}

function validateResult(value: unknown): value is WebSearchResult {
  if (!isRecord(value) || !hasExactKeys(value, RESULT_KEYS)) return false
  if (!isNullableBoundedText(value.title, WEB_SOURCES_MAX_TITLE_CODEPOINTS)) return false
  if (!isShareableWebSourceUrl(value.url)) return false
  if (!isNullableBoundedText(value.snippet, WEB_SOURCES_MAX_SNIPPET_CODEPOINTS)) return false
  if (typeof value.snippet_truncated !== 'boolean') return false
  if (value.snippet === null) {
    if (value.snippet_truncated) return false
  } else if (value.snippet_truncated && codePointLength(value.snippet) !== WEB_SOURCES_MAX_SNIPPET_CODEPOINTS) {
    // 后端只在原文 >500 时截断，截断后必然正好 500 码点。
    return false
  }
  if (value.publication_date !== null && !isIsoCalendarDate(value.publication_date)) return false
  return true
}

function validateNotes(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > WEB_SOURCES_MAX_NOTES) return false
  let total = 0
  for (const note of value) {
    if (!isBoundedText(note, WEB_SOURCES_MAX_NOTE_CODEPOINTS)) return false
    total += codePointLength(note)
  }
  return total <= WEB_SOURCES_MAX_NOTES_TOTAL_CODEPOINTS
}

function isSuccessStatus(status: WebSourceStatus): boolean {
  return SUCCESS_STATUSES.includes(status)
}

function statusAllowsProviderStatus(status: WebSourceStatus, value: number | null): boolean {
  if (isSuccessStatus(status)) {
    return typeof value === 'number' && value >= 200 && value <= 299
  }
  switch (status) {
    case 'invalid_request':
    case 'no_key':
    case 'timeout':
      return value === null
    case 'rate_limited':
      return value === 429 || value === 432
    case 'unauthorized':
      return value === 401 || value === 403
    case 'unavailable':
      return value === null || (typeof value === 'number' && value >= 500 && value <= 599)
    case 'failed':
      if (typeof value !== 'number' || value < 200 || value > 499) return false
      return value !== 401 && value !== 403 && value !== 429 && value !== 432
    default:
      return false
  }
}

/**
 * 校验整份 WebSearchReport，并核对 requested_query 等于本次规范化实发 query。
 * 运行时绝不 throw；失败只返回原因，由 webSourcesApi 统一折成 bad_payload。
 *
 * invalid_request 按真实合同要求 requested_query=null、provider_http_status=null、
 * fetched_at=null、results 空；其他状态不接受 requested_query=null。
 */
export function validateWebSearchReport(
  value: unknown,
  sentQuery: string,
): WebSearchValidationResult {
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) {
    return { ok: false, reason: '响应不是完整的 WebSearchReport 对象' }
  }

  const status = value.status
  if (typeof status !== 'string' || !STATUSES.includes(status as WebSourceStatus)) {
    return { ok: false, reason: 'status 不在约定取值内' }
  }
  const typedStatus = status as WebSourceStatus

  if (typedStatus === 'invalid_request') {
    if (value.reason === null || !isBoundedText(value.reason, WEB_SOURCES_MAX_NOTE_CODEPOINTS)) {
      return { ok: false, reason: 'invalid_request 必须有固定 reason' }
    }
    if (value.requested_query !== null) {
      return { ok: false, reason: 'invalid_request 的 requested_query 必须为 null' }
    }
  } else {
    if (isSuccessStatus(typedStatus)) {
      if (value.reason !== null) {
        return { ok: false, reason: '成功状态不应带 reason' }
      }
    } else if (value.reason === null || !isBoundedText(value.reason, WEB_SOURCES_MAX_NOTE_CODEPOINTS)) {
      return { ok: false, reason: '失败状态必须有固定 reason' }
    }
    const normalized = normalizeWebSearchQuery(sentQuery)
    if (
      normalized === null ||
      typeof value.requested_query !== 'string' ||
      value.requested_query !== normalized
    ) {
      return { ok: false, reason: 'requested_query 必须等于本次规范化实发 query' }
    }
  }

  if (!isIsoTimestamp(value.checked_at)) {
    return { ok: false, reason: 'checked_at 不是真实带时区 ISO 时间' }
  }
  if (value.fetched_at !== null && !isIsoTimestamp(value.fetched_at)) {
    return { ok: false, reason: 'fetched_at 不是真实带时区 ISO 时间' }
  }
  if (!isValidProviderStatus(value.provider_http_status)) {
    if (!(value.provider_http_status === null && !isSuccessStatus(typedStatus))) {
      return { ok: false, reason: 'provider_http_status 不是合法状态码' }
    }
  }
  const providerStatus = value.provider_http_status as number | null
  if (!statusAllowsProviderStatus(typedStatus, providerStatus)) {
    return { ok: false, reason: 'provider_http_status 与 status 语义不一致' }
  }

  if (
    typeof value.max_results !== 'number' ||
    !Number.isInteger(value.max_results) ||
    value.max_results < 1 ||
    value.max_results > WEB_SOURCES_MAX_RESULTS
  ) {
    return { ok: false, reason: 'max_results 必须是 1..5 的整数' }
  }
  if (!isSafeNonNegativeInteger(value.results_seen)) {
    return { ok: false, reason: 'results_seen 必须是非负安全整数' }
  }
  if (!Array.isArray(value.results) || value.results.length > value.max_results) {
    return { ok: false, reason: 'results 数量超过 max_results' }
  }
  if (!value.results.every(validateResult)) {
    return { ok: false, reason: 'results 结构或 URL/日期不符合契约' }
  }
  if (value.results.length > value.results_seen) {
    return { ok: false, reason: 'results_seen 小于展示条数' }
  }
  if (!validateNotes(value.notes)) {
    return { ok: false, reason: 'notes 不是有界字符串数组' }
  }
  if (!validateSource(value.source)) {
    return { ok: false, reason: 'source 不是固定 Tavily 来源' }
  }
  if (value.content_status !== 'unverified') {
    return { ok: false, reason: 'content_status 必须恒为 unverified' }
  }

  if (typedStatus === 'available') {
    if (value.results.length < 1) return { ok: false, reason: 'available 必须至少 1 条结果' }
    if (value.fetched_at === null) return { ok: false, reason: 'available 必须有 fetched_at' }
  } else if (typedStatus === 'no_results') {
    if (value.results.length !== 0 || value.results_seen !== 0) {
      return { ok: false, reason: 'no_results 必须是真空结果' }
    }
    if (value.fetched_at === null) return { ok: false, reason: 'no_results 必须有 fetched_at' }
  } else if (typedStatus === 'no_usable_results') {
    if (value.results.length !== 0 || value.results_seen < 1) {
      return { ok: false, reason: 'no_usable_results 必须 seen>0 且 results 空' }
    }
    if (value.fetched_at === null) return { ok: false, reason: 'no_usable_results 必须有 fetched_at' }
  } else {
    if (value.results.length !== 0 || value.results_seen !== 0) {
      return { ok: false, reason: '错误状态不得携带结果' }
    }
    if (value.fetched_at !== null) return { ok: false, reason: '错误状态不得有 fetched_at' }
  }

  return { ok: true, report: value as unknown as WebSearchReport }
}

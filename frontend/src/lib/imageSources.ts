/**
 * Wikimedia Commons 图片搜索的前端纯契约（无网络、无 UI；三期 S5）。
 *
 * 事实来源：后端 image_sources_client.py / image_sources_api.py（2026-11-08
 * 当前版）与 docs/IMAGE_SOURCES.md。本文件只做类型、query 规范化、URL 白名单
 * 与信封校验，不写 Trip、不读 localStorage、不自动查询、不抓取任何结果链接。
 *
 * 与 webSources.ts 同口径但独立实现（不互相依赖）：Python str.strip() 的空白
 * 集合、Unicode 码点计数（同 Python len）、孤立代理码点拒绝、固定 1..100 查询
 * 上限。条目 URL 走保守主机白名单（thumbUrl/imageUrl 仅 https 的
 * upload.wikimedia.org；descriptionUrl 仅 https 的 commons.wikimedia.org），
 * 与后端 _IMAGE_HOST / _DESCRIPTION_HOST 一致；任一条目不安全则整份响应作废。
 */

/** 与后端注册路径一致，走 Vite /api 代理。 */
export const IMAGE_SOURCES_SEARCH_PATH = '/api/image-sources/search'

/** 后端固定 source 常量（ImageSourceMeta；与 docs/IMAGE_SOURCES.md 逐字一致）。 */
export const IMAGE_SOURCES_PROVIDER = 'wikimedia-commons'
export const IMAGE_SOURCES_ENDPOINT = 'https://commons.wikimedia.org/w/api.php'
export const IMAGE_SOURCES_DOCS_URL = 'https://www.mediawiki.org/wiki/API:Search'
export const IMAGE_SOURCES_ATTRIBUTION_URL =
  'https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia'
export const IMAGE_SOURCES_DATA_SOURCE = 'Wikimedia Commons'

export const IMAGE_SOURCES_MAX_QUERY_CODEPOINTS = 100
export const IMAGE_SOURCES_MAX_RESULTS = 10
export const IMAGE_SOURCES_MAX_TEXT_CODEPOINTS = 300
export const IMAGE_SOURCES_MAX_URL_CODEPOINTS = 2048
export const IMAGE_SOURCES_MAX_NOTES = 10
export const IMAGE_SOURCES_MAX_NOTE_CODEPOINTS = 300

/** 缩略图/原图与描述页主机白名单：仅接受 https + 精确主机名（与后端一致）。 */
export const IMAGE_SOURCES_THUMB_HOST = 'upload.wikimedia.org'
export const IMAGE_SOURCES_DESCRIPTION_HOST = 'commons.wikimedia.org'

export type ImageSourceStatus =
  | 'available'
  | 'no_candidates'
  | 'invalid_request'
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'failed'

export interface ImageSourceMeta {
  provider: typeof IMAGE_SOURCES_PROVIDER
  endpoint: typeof IMAGE_SOURCES_ENDPOINT
  docs_url: typeof IMAGE_SOURCES_DOCS_URL
  attribution_url: typeof IMAGE_SOURCES_ATTRIBUTION_URL
  data_source: typeof IMAGE_SOURCES_DATA_SOURCE
}

/** 单张可展示图片条目：署名与许可按上游原样透传，缺失为 null，绝不编造。 */
export interface ImageSearchItem {
  title: string | null
  thumbUrl: string
  imageUrl: string
  descriptionUrl: string
  license: string | null
  /** 作者署名（后端已剥离 HTML 为纯文本）；null = 上游未提供 → 前端不可收进。 */
  artist: string | null
  width: number | null
  height: number | null
}

export interface ImageSearchReport {
  status: ImageSourceStatus
  reason: string | null
  provider_http_status: number | null
  /** 查询发起时刻（UTC ISO），不代表图片资料更新时间。 */
  checked_at: string
  /** 仅成功读取上游 2xx body 且结构解析可信后才有；失败为 null。 */
  fetched_at: string | null
  /** 实际发送的规范化 query；invalid_request 为 null。 */
  requested_query: string | null
  max_results: number
  results_seen: number
  items: ImageSearchItem[]
  notes: string[]
  source: ImageSourceMeta
}

export type ImageSearchValidationResult =
  | { ok: true; report: ImageSearchReport }
  | { ok: false; reason: string }

export interface ImageSearchRequestBody {
  query: string
}

const STATUSES: readonly ImageSourceStatus[] = [
  'available',
  'no_candidates',
  'invalid_request',
  'timeout',
  'rate_limited',
  'unavailable',
  'failed',
]

/** 成功路径（HTTP 200 且读过可信 body）：available / no_candidates。 */
const SUCCESS_STATUSES: readonly ImageSourceStatus[] = ['available', 'no_candidates']

const REPORT_KEYS = [
  'status',
  'reason',
  'provider_http_status',
  'checked_at',
  'fetched_at',
  'requested_query',
  'max_results',
  'results_seen',
  'items',
  'notes',
  'source',
] as const

const ITEM_KEYS = [
  'title',
  'thumbUrl',
  'imageUrl',
  'descriptionUrl',
  'license',
  'artist',
  'width',
  'height',
] as const

const SOURCE_KEYS = ['provider', 'endpoint', 'docs_url', 'attribution_url', 'data_source'] as const

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

/** 字符串的 Unicode 码点数（等价 Python len(str)），不用 Intl/通用 Unicode 库。 */
function codePointLength(value: string): number {
  let count = 0
  for (const _char of value) count += 1
  return count
}

/** 与后端 normalize_image_query 同口径：Python strip + 1..100 码点 + 拒孤立代理。 */
export function normalizeImageQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = stripPythonWhitespace(value)
  if (!trimmed) return null
  if (!isWellFormedUnicodeText(trimmed)) return null
  if (codePointLength(trimmed) > IMAGE_SOURCES_MAX_QUERY_CODEPOINTS) return null
  return trimmed
}

/** 请求体只允许 query；不拼 Trip/坐标/Key。 */
export function buildImageSearchRequestBody(query: string): ImageSearchRequestBody {
  return { query }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
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

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isValidProviderStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 599
}

function isSuccessStatus(status: ImageSourceStatus): boolean {
  return SUCCESS_STATUSES.includes(status)
}

function statusAllowsProviderStatus(status: ImageSourceStatus, value: number | null): boolean {
  if (isSuccessStatus(status)) {
    return typeof value === 'number' && value >= 200 && value <= 299
  }
  switch (status) {
    case 'invalid_request':
    case 'timeout':
      return value === null
    case 'rate_limited':
      return value === 429
    case 'unavailable':
      return value === null || (typeof value === 'number' && value >= 500 && value <= 599)
    case 'failed':
      // 重定向 3xx / 其他 4xx / 坏 JSON（真实 2xx）等都会折成 failed。
      return value === null || (typeof value === 'number' && value >= 100 && value <= 599)
    default:
      return false
  }
}

/**
 * 条目 URL 白名单：仅 https + 精确主机名；拒绝 userinfo / 端口 / 控制字符 /
 * 空白 / 孤立代理 / 超 2048 码点。与后端 _check_image_url 同口径，不解析 DNS、
 * 不 fetch 链接。
 */
export function isWhitelistedImageUrl(value: unknown, host: string): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > IMAGE_SOURCES_MAX_URL_CODEPOINTS * 2) return false
  if (codePointLength(value) > IMAGE_SOURCES_MAX_URL_CODEPOINTS) return false
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false
  if (PYTHON_WHITESPACE_RE.test(value)) return false
  if (!isWellFormedUnicodeText(value)) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  if (parsed.port !== '') return false
  return parsed.hostname.toLowerCase() === host
}

function validateItem(value: unknown): value is ImageSearchItem {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) return false
  if (value.title !== null && !isBoundedText(value.title, IMAGE_SOURCES_MAX_TEXT_CODEPOINTS)) return false
  if (!isWhitelistedImageUrl(value.thumbUrl, IMAGE_SOURCES_THUMB_HOST)) return false
  if (!isWhitelistedImageUrl(value.imageUrl, IMAGE_SOURCES_THUMB_HOST)) return false
  if (!isWhitelistedImageUrl(value.descriptionUrl, IMAGE_SOURCES_DESCRIPTION_HOST)) return false
  if (value.license !== null && !isBoundedText(value.license, IMAGE_SOURCES_MAX_TEXT_CODEPOINTS)) return false
  if (value.artist !== null && !isBoundedText(value.artist, IMAGE_SOURCES_MAX_TEXT_CODEPOINTS)) return false
  if (value.width !== null && !isPositiveSafeInteger(value.width)) return false
  if (value.height !== null && !isPositiveSafeInteger(value.height)) return false
  return true
}

function validateNotes(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > IMAGE_SOURCES_MAX_NOTES) return false
  return value.every((note) => isBoundedText(note, IMAGE_SOURCES_MAX_NOTE_CODEPOINTS))
}

function validateSource(value: unknown): value is ImageSourceMeta {
  if (!isRecord(value) || !hasExactKeys(value, SOURCE_KEYS)) return false
  return (
    value.provider === IMAGE_SOURCES_PROVIDER &&
    value.endpoint === IMAGE_SOURCES_ENDPOINT &&
    value.docs_url === IMAGE_SOURCES_DOCS_URL &&
    value.attribution_url === IMAGE_SOURCES_ATTRIBUTION_URL &&
    value.data_source === IMAGE_SOURCES_DATA_SOURCE
  )
}

/**
 * 校验整份 ImageSearchReport，并核对 requested_query 等于本次规范化实发 query。
 * 运行时绝不 throw；失败只返回原因，由 imageSourcesApi 统一折成 bad_payload。
 *
 * invalid_request 按真实合同要求 requested_query=null、provider_http_status=null、
 * fetched_at=null、items 空；其余非成功状态不接受 requested_query=null。
 */
export function validateImageSearchReport(
  value: unknown,
  sentQuery: string,
): ImageSearchValidationResult {
  if (!isRecord(value) || !hasExactKeys(value, REPORT_KEYS)) {
    return { ok: false, reason: '响应不是完整的 ImageSearchReport 对象' }
  }

  const status = value.status
  if (typeof status !== 'string' || !STATUSES.includes(status as ImageSourceStatus)) {
    return { ok: false, reason: 'status 不在约定取值内' }
  }
  const typedStatus = status as ImageSourceStatus

  if (isSuccessStatus(typedStatus)) {
    if (value.reason !== null) {
      return { ok: false, reason: '成功状态不应带 reason' }
    }
  } else if (value.reason === null || !isBoundedText(value.reason, IMAGE_SOURCES_MAX_NOTE_CODEPOINTS)) {
    return { ok: false, reason: '失败状态必须有固定 reason' }
  }

  if (typedStatus === 'invalid_request') {
    if (value.requested_query !== null) {
      return { ok: false, reason: 'invalid_request 的 requested_query 必须为 null' }
    }
  } else {
    if (typeof value.requested_query !== 'string' || value.requested_query !== sentQuery) {
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
    if (value.provider_http_status !== null) {
      return { ok: false, reason: 'provider_http_status 不是合法状态码' }
    }
  }
  if (!statusAllowsProviderStatus(typedStatus, value.provider_http_status)) {
    return { ok: false, reason: 'provider_http_status 与 status 语义不一致' }
  }

  if (
    typeof value.max_results !== 'number' ||
    !Number.isInteger(value.max_results) ||
    value.max_results < 1 ||
    value.max_results > IMAGE_SOURCES_MAX_RESULTS
  ) {
    return { ok: false, reason: 'max_results 必须是 1..10 的整数' }
  }
  if (!isSafeNonNegativeInteger(value.results_seen)) {
    return { ok: false, reason: 'results_seen 必须是非负安全整数' }
  }
  if (!Array.isArray(value.items) || value.items.length > value.max_results) {
    return { ok: false, reason: 'items 数量超过 max_results' }
  }
  if (!value.items.every(validateItem)) {
    return { ok: false, reason: 'items 结构或 URL 不符合契约' }
  }
  if (!validateNotes(value.notes)) {
    return { ok: false, reason: 'notes 不是有界字符串数组' }
  }
  if (!validateSource(value.source)) {
    return { ok: false, reason: 'source 不是固定 Wikimedia Commons 来源' }
  }

  if (isSuccessStatus(typedStatus)) {
    if (value.fetched_at === null) {
      return { ok: false, reason: '成功状态必须有 fetched_at' }
    }
    if (typedStatus === 'available' && value.items.length < 1) {
      return { ok: false, reason: 'available 必须至少 1 条条目' }
    }
    if (value.items.length > value.results_seen) {
      return { ok: false, reason: 'results_seen 小于展示条数' }
    }
  } else {
    if (value.items.length !== 0 || value.results_seen !== 0) {
      return { ok: false, reason: '失败/空状态不得携带条目' }
    }
    if (value.fetched_at !== null) {
      return { ok: false, reason: '失败/空状态不得有 fetched_at' }
    }
  }

  return { ok: true, report: value as unknown as ImageSearchReport }
}

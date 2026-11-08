/**
 * Wikimedia 图片搜索的固定 fixture 场景（仅 dev-stub / 前端联调用）。
 * 形状以 backend/image_sources_client.py 的 ImageSearchReport 为准；
 * URL 一律白名单主机（upload.wikimedia.org / commons.wikimedia.org），
 * 与 lib/imageSources.ts 的前端校验一致。纯数据，不发请求。
 */

const COMMONS_THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb'
const COMMONS_IMAGE = 'https://upload.wikimedia.org/wikipedia/commons'
const COMMONS_PAGE = 'https://commons.wikimedia.org/wiki'

function item(
  file,
  hash,
  { license = 'CC BY-SA 4.0', artist = '示例摄影师', width = 4032, height = 3024 } = {},
) {
  const safe = file.replace(/ /g, '_')
  return {
    title: `File:${file}`,
    thumbUrl: `${COMMONS_THUMB}/${hash}/${safe}/320px-${safe}`,
    imageUrl: `${COMMONS_IMAGE}/${hash}/${safe}`,
    descriptionUrl: `${COMMONS_PAGE}/File:${safe}`,
    license,
    artist,
    width,
    height,
  }
}

const SOURCE = {
  provider: 'wikimedia-commons',
  endpoint: 'https://commons.wikimedia.org/w/api.php',
  docs_url: 'https://www.mediawiki.org/wiki/API:Search',
  attribution_url:
    'https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia',
  data_source: 'Wikimedia Commons',
}

/** 固定 checked_at：dev-stub 不假装是真实时间，测试断言也不依赖它变化。 */
const CHECKED_AT = '2026-11-08T08:00:00+00:00'
const FETCHED_AT = '2026-11-08T08:00:01+00:00'

/**
 * 场景表：query 以 `场景:` 前缀触发对应信封；无前缀的普通查询返回
 * available 多张（含一张无署名条目，用于验证「缺署名不提供收进」）。
 */
export const IMAGE_SEARCH_SCENARIOS = {
  available_many: {
    status: 'available',
    reason: null,
    provider_http_status: 200,
    checked_at: CHECKED_AT,
    fetched_at: FETCHED_AT,
    requested_query: null,
    max_results: 10,
    results_seen: 3,
    items: [
      item('West Lake Sunset.jpg', 'a/ab'),
      item('West Lake Boats.jpg', 'c/cd', { license: 'CC0', artist: '另一位作者', width: 2048, height: 1536 }),
      item('West Lake No Artist.jpg', 'e/ef', { license: 'CC0', artist: null, width: 1024, height: 768 }),
    ],
    notes: [],
    source: SOURCE,
  },
  available_single: {
    status: 'available',
    reason: null,
    provider_http_status: 200,
    checked_at: CHECKED_AT,
    fetched_at: FETCHED_AT,
    requested_query: null,
    max_results: 10,
    results_seen: 1,
    items: [item('Single Bridge Snow.jpg', 'b/bc', { license: 'CC BY 2.0', artist: '断桥作者' })],
    notes: [],
    source: SOURCE,
  },
  no_candidates: {
    status: 'no_candidates',
    reason: null,
    provider_http_status: 200,
    checked_at: CHECKED_AT,
    fetched_at: FETCHED_AT,
    requested_query: null,
    max_results: 10,
    results_seen: 0,
    items: [],
    notes: [],
    source: SOURCE,
  },
  invalid_request: {
    status: 'invalid_request',
    reason: '查询必须为去除首尾空白后 1 到 100 个字符的文本',
    provider_http_status: null,
    checked_at: CHECKED_AT,
    fetched_at: null,
    requested_query: null,
    max_results: 10,
    results_seen: 0,
    items: [],
    notes: [],
    source: SOURCE,
  },
  timeout: {
    status: 'timeout',
    reason: '图片搜索请求超时',
    provider_http_status: null,
    checked_at: CHECKED_AT,
    fetched_at: null,
    requested_query: null,
    max_results: 10,
    results_seen: 0,
    items: [],
    notes: [],
    source: SOURCE,
  },
  rate_limited: {
    status: 'rate_limited',
    reason: '图片搜索请求过于频繁，请稍后再试',
    provider_http_status: 429,
    checked_at: CHECKED_AT,
    fetched_at: null,
    requested_query: null,
    max_results: 10,
    results_seen: 0,
    items: [],
    notes: [],
    source: SOURCE,
  },
  unavailable: {
    status: 'unavailable',
    reason: '图片搜索服务暂时不可用',
    provider_http_status: 503,
    checked_at: CHECKED_AT,
    fetched_at: null,
    requested_query: null,
    max_results: 10,
    results_seen: 0,
    items: [],
    notes: [],
    source: SOURCE,
  },
  failed: {
    status: 'failed',
    reason: '图片搜索响应异常',
    provider_http_status: 404,
    checked_at: CHECKED_AT,
    fetched_at: null,
    requested_query: null,
    max_results: 10,
    results_seen: 0,
    items: [],
    notes: [],
    source: SOURCE,
  },
}

/**
 * 按 query 解析场景：`场景:available_many` 等；普通 query 回 available_many
 * （多张，含一张无署名条目）。requested_query 由调用方按实发查询回填。
 */
export function resolveImageSearchScenario(query) {
  const prefix = '场景:'
  const name = query.startsWith(prefix) ? query.slice(prefix.length) : 'available_many'
  const scenario = IMAGE_SEARCH_SCENARIOS[name]
  if (!scenario) {
    return {
      status: 'failed',
      reason: '图片搜索响应异常',
      provider_http_status: null,
      checked_at: CHECKED_AT,
      fetched_at: null,
      requested_query: query,
      max_results: 10,
      results_seen: 0,
      items: [],
      notes: [],
      source: SOURCE,
    }
  }
  return { ...scenario, requested_query: query }
}

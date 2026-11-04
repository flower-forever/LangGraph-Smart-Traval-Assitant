/**
 * Tavily 网页资料搜索前端纯契约测试（无网络）。
 * 形状以当前后端 tavily_web_client.py 的 WebSearchReport 为准。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  buildWebSearchRequestBody,
  isIsoCalendarDate,
  isShareableWebSourceUrl,
  normalizeWebSearchQuery,
  validateWebSearchReport,
  WEB_SOURCES_DOCS_URL,
  WEB_SOURCES_ENDPOINT,
} from '../lib/webSources'
import { makeWebSearchReport, makeWebSearchResult } from './fixtures/webSources'

const SENT = '西湖 旅游'

function validReport(value: unknown) {
  const result = validateWebSearchReport(value, SENT)
  if (!result.ok) throw new Error(result.reason)
  return result.report
}

function badReport(value: unknown, sent = SENT) {
  expect(validateWebSearchReport(value, sent).ok).toBe(false)
}

describe('normalizeWebSearchQuery', () => {
  it('trim 后按 Unicode 码点保留 1..300', () => {
    expect(normalizeWebSearchQuery('  西湖 \n')).toBe('西湖')
    expect(normalizeWebSearchQuery('西'.repeat(300))).toBe('西'.repeat(300))
    expect(normalizeWebSearchQuery('西'.repeat(301))).toBeNull()
    expect(normalizeWebSearchQuery('   ')).toBeNull()
    expect(normalizeWebSearchQuery('')).toBeNull()
    expect(normalizeWebSearchQuery(123)).toBeNull()
    expect(normalizeWebSearchQuery(null)).toBeNull()
  })

  it.each([
    ['\u001cabc', 'abc'],
    ['\u001dabc', 'abc'],
    ['\u001eabc', 'abc'],
    ['\u001fabc', 'abc'],
    ['\u0085abc', 'abc'],
    ['\ufeffabc', '\ufeffabc'],
    ['\ufeff', '\ufeff'],
  ])('按 Python strip 处理边缘空白：%j -> %j', (raw, expected) => {
    expect(normalizeWebSearchQuery(raw)).toBe(expected)
  })

  it('仅 Python 空白时 query 为空，合法 FEFF 单字不是空', () => {
    expect(normalizeWebSearchQuery('\u001c')).toBeNull()
    expect(normalizeWebSearchQuery('\u0085')).toBeNull()
    expect(normalizeWebSearchQuery('\u3000')).toBeNull()
    expect(normalizeWebSearchQuery('\ufeff')).toBe('\ufeff')
  })

  it('300 个 astral emoji 合法（JS length 是 600，码点才是 300）', () => {
    const query = '🚀'.repeat(300)
    expect(query.length).toBe(600)
    expect(normalizeWebSearchQuery(query)).toBe(query)
    expect(normalizeWebSearchQuery('🚀'.repeat(301))).toBeNull()
  })

  it('合法代理对可用，孤立代理拒绝', () => {
    expect(normalizeWebSearchQuery('\uD83D\uDE80')).toBe('🚀')
    expect(normalizeWebSearchQuery('\uD800abc')).toBeNull()
    expect(normalizeWebSearchQuery('abc\uDFFF')).toBeNull()
    expect(normalizeWebSearchQuery('\uD83D')).toBeNull()
  })

  it('请求体只构造 query 字段', () => {
    expect(buildWebSearchRequestBody('西湖')).toEqual({ query: '西湖' })
    expect(Object.keys(buildWebSearchRequestBody('西湖'))).toEqual(['query'])
  })
})

describe('isShareableWebSourceUrl', () => {
  it.each([
    'https://www.example-travel.com/xihu-guide',
    'https://example.com',
    'https://example.travel/path?q=1#frag',
    'https://EXAMPLE.COM/Path',
    'https://www.example.com:443/a',
    'https://xn--e1afmkfd.xn--p1ai/a',
    'https://www.example.com/杭州西湖',
    'https://sub.domain.example.co.uk/a/b/c',
    'https://example.com/%5c',
  ])('接受后端也接受的公共 https：%s', (url) => {
    expect(isShareableWebSourceUrl(url)).toBe(true)
  })

  it.each([
    'https://user@example.com/a',
    'https://user:pass@example.com/a',
    'https://127.0.0.1/a',
    'https://1.1.1.1/a',
    'https://192.168.1.1/a',
    'https://[::1]/a',
    'https://[2001:db8::1]/a',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://localhost/a',
    'https://api.localhost/a',
    'https://service.local/a',
    'https://service.internal/a',
    'https://example/',
    'https://example.c/',
    'https://example.com1/',
    'https://example.com./a',
    'https://example.com:8443/a',
    'https://example.com:0/a',
    'https://example.com:notaport/a',
    'http://www.example.com/a',
    'ftp://www.example.com/a',
    'javascript:alert(1)',
    'data:text/html,hello',
    'https://www.example.com/a b',
    ' https://www.example.com/a',
    'https://www.example.com/a\n',
    'https://www.example.com/a\u0085',
    'https://www.example.com/\uD800',
    'https://例え.jp/a',
    'https://www.西湖.com/a',
    'https://example.com\\@evil.com/a',
    'https://example.com\\evil.com/a',
    'https://%65xample.com/a',
    'https://example.com%2f.evil.com/a',
    'https://www.example.com/' + 'a'.repeat(2048),
  ])('拒绝不安全或后端拒绝的形式：%s', (url) => {
    expect(isShareableWebSourceUrl(url)).toBe(false)
  })

  it('校验 URL 不会发起任何 fetch', () => {
    const fetchMock = vi.fn(() => {
      throw new Error('URL 校验不应 fetch')
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect(isShareableWebSourceUrl('https://www.example.com/a')).toBe(true)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    'https://example.xn--a/a',
    'https://example.XN--a/a',
    'https://xn--a.example.org/x',
    'https://xn--p1ai.xn--a.example.com/x',
    'https://xn--a.xn--b.example.com/x',
    'https://xn--.example.com/a',
    'https://example.xn--abc-/a',
  ])('拒绝无效 punycode A-label（浏览器拒绝、后端已同步拒绝）：%s', (url) => {
    expect(isShareableWebSourceUrl(url)).toBe(false)
  })

  it.each([
    'https://example.xn--p1ai/a',
    'https://xn--80ak6aa92e.com/a',
    'https://www.example.xn--fiqs8s/a',
    'https://xn--e1afmkfd.xn--p1ai/a',
    'https://xn--bcher-kva.example.com/a',
  ])('可解码 punycode A-label 继续接受：%s', (url) => {
    expect(isShareableWebSourceUrl(url)).toBe(true)
  })
})

describe('与修复后后端的混合批次兼容', () => {
  // 修后后端逐条过滤：坏 A-label 条目被丢弃并计入 notes，只发合法 URL。
  // 前端整包校验必须接受这类报告，不把合法结果折成 bad_payload。
  it('混合过滤报告（2 合法 + 过滤 notes）整包可用', () => {
    const report = makeWebSearchReport({
      results: [
        makeWebSearchResult({ url: 'https://www.example.com/ok-1' }),
        makeWebSearchResult({ url: 'https://www.example.org/ok-2' }),
      ],
      results_seen: 3,
      notes: ['1 条结果链接未通过安全检查，未展示'],
    })
    const accepted = validReport(report)
    expect(accepted.results).toHaveLength(2)
    expect(accepted.notes).toEqual(['1 条结果链接未通过安全检查，未展示'])
  })

  it('punycode 合法域名的过滤报告同样整包可用', () => {
    const report = makeWebSearchReport({
      results: [makeWebSearchResult({ url: 'https://example.xn--p1ai/guide' })],
      results_seen: 2,
      notes: ['1 条结果链接未通过安全检查，未展示'],
    })
    expect(validReport(report).results[0].url).toBe('https://example.xn--p1ai/guide')
  })

  it('含坏 A-label 的结果仍被整包拒绝（前端保持严守）', () => {
    badReport(
      makeWebSearchReport({
        results: [
          makeWebSearchResult({ url: 'https://www.example.com/ok-1' }),
          makeWebSearchResult({ url: 'https://example.xn--a/bad' }),
        ],
        results_seen: 2,
      }),
    )
  })
})

describe('isIsoCalendarDate', () => {
  it.each([
    ['2025-06-01', true],
    ['2024-02-29', true],
    ['2025-02-28', true],
    ['2025-02-29', false],
    ['2025-02-30', false],
    ['2025-13-01', false],
    ['2025-00-10', false],
    ['2025-04-31', false],
    ['0000-01-01', false],
    ['2025-6-1', false],
    ['2025-06-01T00:00:00Z', false],
    [null, false],
    [20250601, false],
  ] as const)('日历日 %s -> %s', (value, expected) => {
    expect(isIsoCalendarDate(value)).toBe(expected)
  })
})

describe('validateWebSearchReport 合法状态', () => {
  it('available：至少 1 条可展示结果、2xx、有 fetched_at', () => {
    const report = validReport(makeWebSearchReport())
    expect(report.status).toBe('available')
    expect(report.results).toHaveLength(1)
    expect(report.content_status).toBe('unverified')
    expect(report.source.endpoint).toBe(WEB_SOURCES_ENDPOINT)
    expect(report.source.docs_url).toBe(WEB_SOURCES_DOCS_URL)
  })

  it.each([
    ['no_results', 200, null, 0],
    ['no_usable_results', 200, null, 3],
    ['invalid_request', null, null, 0],
    ['no_key', null, '未配置搜索服务 Key', 0],
    ['timeout', null, '超时', 0],
    ['rate_limited', 429, '频繁', 0],
    ['unauthorized', 403, '未授权', 0],
    ['unavailable', 503, '暂不可用', 0],
    ['failed', 200, '格式异常', 0],
  ] as const)('状态 %s 的必填字段与类型', (status, providerStatus, reason, seen) => {
    const error = status !== 'no_results' && status !== 'no_usable_results'
    const report = makeWebSearchReport({
      status,
      reason: error ? (reason ?? '固定失败') : null,
      provider_http_status: providerStatus,
      fetched_at: error ? null : '2026-11-03T08:00:01+00:00',
      requested_query: status === 'invalid_request' ? null : SENT,
      results: [],
      results_seen: seen,
      notes: [],
    })
    expect(validReport(report).status).toBe(status)
  })

  it('no_results 的 0 与 null 字段合法', () => {
    expect(
      validReport(
        makeWebSearchReport({
          status: 'no_results',
          reason: null,
          results: [],
          results_seen: 0,
          notes: [],
        }),
      ).results_seen,
    ).toBe(0)
  })

  it('title/snippet/publication_date 为 null 时合法', () => {
    const report = makeWebSearchReport({
      results: [makeWebSearchResult({ title: null, snippet: null, publication_date: null, snippet_truncated: false })],
    })
    expect(validReport(report).results[0].title).toBeNull()
  })
})

describe('validateWebSearchReport 矛盾与坏字段', () => {
  it.each([null, undefined, [], 'x', 42])('非对象：%s', (value) => {
    badReport(value)
  })

  it('unknown status / 缺字段 / 多余字段', () => {
    badReport(makeWebSearchReport({ status: 'official' as never }))
    const missing = makeWebSearchReport() as unknown as Record<string, unknown>
    delete missing.fetched_at
    badReport(missing)
    badReport({ ...makeWebSearchReport(), official: true })
  })

  it('query 回显必须等于规范化实发 query', () => {
    badReport(makeWebSearchReport({ requested_query: '另一个查询' }))
    badReport(makeWebSearchReport({ requested_query: null }))
    badReport(makeWebSearchReport({ status: 'invalid_request', requested_query: SENT, reason: 'x', provider_http_status: null, fetched_at: null, results: [], results_seen: 0 }))
    badReport(makeWebSearchReport({ status: 'invalid_request', requested_query: null, reason: 'x', provider_http_status: 200 }))
  })

  it('available 必须有结果、2xx、fetched_at', () => {
    badReport(makeWebSearchReport({ results: [], results_seen: 0 }))
    badReport(makeWebSearchReport({ fetched_at: null }))
    badReport(makeWebSearchReport({ provider_http_status: 500 }))
    badReport(makeWebSearchReport({ provider_http_status: null }))
  })

  it('no_results / no_usable_results / 错误的 results、seen、fetched_at', () => {
    badReport(makeWebSearchReport({ status: 'no_results', results: [makeWebSearchResult()] }))
    badReport(makeWebSearchReport({ status: 'no_results', results: [], results_seen: 1 }))
    badReport(makeWebSearchReport({ status: 'no_results', results: [], results_seen: 0, fetched_at: null }))
    badReport(makeWebSearchReport({ status: 'no_usable_results', results: [], results_seen: 0 }))
    badReport(makeWebSearchReport({ status: 'no_usable_results', results: [], results_seen: 2, fetched_at: null }))
    badReport(makeWebSearchReport({ status: 'timeout', results: [makeWebSearchResult()], fetched_at: null, reason: 'x' }))
    badReport(makeWebSearchReport({ status: 'failed', results: [makeWebSearchResult()], fetched_at: null, reason: 'x' }))
    badReport(makeWebSearchReport({ status: 'unavailable', fetched_at: '2026-11-03T08:00:01+00:00', reason: 'x' }))
    badReport(makeWebSearchReport({ status: 'failed', results_seen: 1, results: [], fetched_at: null, reason: 'x' }))
  })

  it('错误状态的 provider_http_status 与真实映射一致', () => {
    const base = { status: 'timeout' as const, reason: 'x', fetched_at: null, results: [], results_seen: 0, requested_query: SENT }
    badReport(makeWebSearchReport({ ...base, provider_http_status: 429 }))
    badReport(makeWebSearchReport({ status: 'rate_limited', reason: 'x', provider_http_status: 500, fetched_at: null, results: [], results_seen: 0 }))
    badReport(makeWebSearchReport({ status: 'unauthorized', reason: 'x', provider_http_status: 429, fetched_at: null, results: [], results_seen: 0 }))
    badReport(makeWebSearchReport({ status: 'unavailable', reason: 'x', provider_http_status: 404, fetched_at: null, results: [], results_seen: 0 }))
    badReport(makeWebSearchReport({ status: 'failed', reason: 'x', provider_http_status: 401, fetched_at: null, results: [], results_seen: 0 }))
    badReport(makeWebSearchReport({ status: 'failed', reason: 'x', provider_http_status: null, fetched_at: null, results: [], results_seen: 0 }))
  })

  it('max_results 1..5、结果数上限、seen 关系', () => {
    badReport(makeWebSearchReport({ max_results: 0 }))
    badReport(makeWebSearchReport({ max_results: 6 }))
    badReport(makeWebSearchReport({ max_results: 2.5 }))
    badReport(makeWebSearchReport({ max_results: 1, results: [makeWebSearchResult(), makeWebSearchResult()] }))
    badReport(makeWebSearchReport({ results_seen: 0 }))
    badReport(makeWebSearchReport({ results_seen: -1 }))
    badReport(makeWebSearchReport({ results_seen: 1.5 }))
    expect(validReport(makeWebSearchReport({ results_seen: 30, results: [makeWebSearchResult()] })).results_seen).toBe(30)
  })

  it('title / snippet 边界与截断一致性', () => {
    const longTitle = '字'.repeat(300)
    expect(validReport(makeWebSearchReport({ results: [makeWebSearchResult({ title: longTitle })] })).results[0].title).toBe(longTitle)
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ title: '字'.repeat(301) })] }))
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ title: '   ' })] }))
    const snippet500 = '字'.repeat(500)
    expect(validReport(makeWebSearchReport({ results: [makeWebSearchResult({ snippet: snippet500, snippet_truncated: true })] })).results[0].snippet).toBe(snippet500)
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ snippet: '字'.repeat(501) })] }))
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ snippet: null, snippet_truncated: true })] }))
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ snippet: '短', snippet_truncated: true })] }))
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ snippet: '短', snippet_truncated: 'yes' as never })] }))
  })

  it('title / snippet 的空白判空走 Python strip，FEFF 合法、U+0085 为空', () => {
    const feffReport = makeWebSearchReport({
      results: [makeWebSearchResult({ title: '\ufeff', snippet: '\ufeff', snippet_truncated: false })],
    })
    const accepted = validReport(feffReport)
    expect(accepted.results[0].title).toBe('\ufeff')
    expect(accepted.results[0].snippet).toBe('\ufeff')

    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ title: '\u0085' })] }))
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ snippet: '\u0085' })] }))
  })

  it('publication_date 只接受真实 ISO 日历日或 null', () => {
    expect(validReport(makeWebSearchReport()).results[0].publication_date).toBe('2025-06-01')
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ publication_date: '2025-02-30' })] }))
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ publication_date: '2025-6-1' })] }))
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ publication_date: 20250601 as never })] }))
  })

  it('source 固定、content_status 恒为 unverified、extra 字段拒绝', () => {
    badReport(makeWebSearchReport({ source: { ...makeWebSearchReport().source, provider: 'other' as never } }))
    badReport(makeWebSearchReport({ source: { ...makeWebSearchReport().source, endpoint: 'https://evil.example/search' as never } }))
    badReport(makeWebSearchReport({ source: { ...makeWebSearchReport().source, docs_url: 'https://evil.example/docs' as never } }))
    badReport(makeWebSearchReport({ source: { ...makeWebSearchReport().source, verified: true } as never }))
    badReport(makeWebSearchReport({ content_status: 'verified' as never }))
    badReport(makeWebSearchReport({ results: [{ ...makeWebSearchResult(), score: 0.9 } as never] }))
    badReport(makeWebSearchReport({ results: [makeWebSearchResult({ url: 'http://www.example.com/a' })] }))
  })

  it('notes 有界且只能是字符串', () => {
    expect(validReport(makeWebSearchReport({ notes: ['1 条结果链接未通过安全检查，未展示'] })).notes).toHaveLength(1)
    badReport(makeWebSearchReport({ notes: [1 as never] }))
    badReport(makeWebSearchReport({ notes: Array.from({ length: 11 }, () => 'x') }))
    badReport(makeWebSearchReport({ notes: ['字'.repeat(301)] }))
  })

  it('checked_at / fetched_at 必须是真实带时区时间', () => {
    badReport(makeWebSearchReport({ checked_at: '2026-02-30T08:00:00+00:00' }))
    badReport(makeWebSearchReport({ checked_at: '2026-11-03T25:00:00+00:00' }))
    badReport(makeWebSearchReport({ checked_at: '2026-11-03T08:00:00' }))
    badReport(makeWebSearchReport({ fetched_at: 'not a time' }))
  })

  it('校验器运行时永不 throw', () => {
    expect(() => validateWebSearchReport(null, SENT)).not.toThrow()
    expect(() => validateWebSearchReport({}, SENT)).not.toThrow()
    expect(() => validateWebSearchReport(makeWebSearchReport(), SENT)).not.toThrow()
  })
})

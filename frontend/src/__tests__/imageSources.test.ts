/**
 * imageSources 前端契约测试（离线、纯函数）：query 规范化（与后端
 * normalize_image_query 同口径）、信封校验 7 态矩阵、URL 白名单、
 * requested_query 归属核对、失败/空状态不得携带条目。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  IMAGE_SOURCES_SEARCH_PATH,
  IMAGE_SOURCES_MAX_QUERY_CODEPOINTS,
  buildImageSearchRequestBody,
  isWhitelistedImageUrl,
  normalizeImageQuery,
  validateImageSearchReport,
} from '../lib/imageSources'
import { IMAGE_SOURCES_TIMEOUT_MS, searchImageSources } from '../lib/imageSourcesApi'
import { makeImageSearchItem, makeImageSearchReport } from './fixtures/imageSources'

beforeEach(() => {
  fetchMock = vi.fn(() => {
    throw new Error('测试不得发起真实 fetch')
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

let fetchMock: ReturnType<typeof vi.fn>

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('normalizeImageQuery（与后端同口径）', () => {
  it('trim + 1..100 码点；emoji（astral）按 1 码点计', () => {
    expect(normalizeImageQuery('  西湖  ')).toBe('西湖')
    expect(normalizeImageQuery('')).toBeNull()
    expect(normalizeImageQuery('   ')).toBeNull()
    expect(normalizeImageQuery('🚀'.repeat(100))).toBe('🚀'.repeat(100))
    expect(normalizeImageQuery('🚀'.repeat(101))).toBeNull()
    expect(normalizeImageQuery('好'.repeat(IMAGE_SOURCES_MAX_QUERY_CODEPOINTS + 1))).toBeNull()
  })

  it('孤立代理码点拒绝；非字符串拒绝', () => {
    expect(normalizeImageQuery('a\uD800b')).toBeNull()
    expect(normalizeImageQuery('\uDC00')).toBeNull()
    expect(normalizeImageQuery(42)).toBeNull()
    expect(normalizeImageQuery(null)).toBeNull()
  })

  it('FEFF 非 Python 空白不剥离（与后端 str.strip 一致）', () => {
    expect(normalizeImageQuery('\uFEFF西湖')).toBe('\uFEFF西湖')
    // U+0085 属 Python 空白，剥离
    expect(normalizeImageQuery('\u0085西湖\u0085')).toBe('西湖')
  })

  it('请求体只含 query', () => {
    expect(buildImageSearchRequestBody('西湖')).toEqual({ query: '西湖' })
    expect(IMAGE_SOURCES_SEARCH_PATH).toBe('/api/image-sources/search')
    expect(IMAGE_SOURCES_TIMEOUT_MS).toBeGreaterThan(8000)
  })
})

describe('isWhitelistedImageUrl（主机白名单）', () => {
  it('只接受 https + 精确主机名；http / 其它主机 / userinfo / 端口拒绝', () => {
    const good = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/x.jpg'
    expect(isWhitelistedImageUrl(good, 'upload.wikimedia.org')).toBe(true)
    expect(isWhitelistedImageUrl('http://upload.wikimedia.org/a.jpg', 'upload.wikimedia.org')).toBe(false)
    expect(isWhitelistedImageUrl('https://evil.example.com/a.jpg', 'upload.wikimedia.org')).toBe(false)
    expect(
      isWhitelistedImageUrl('https://upload.wikimedia.org.evil.example.com/a.jpg', 'upload.wikimedia.org'),
    ).toBe(false)
    expect(
      isWhitelistedImageUrl('https://user:pass@upload.wikimedia.org/a.jpg', 'upload.wikimedia.org'),
    ).toBe(false)
    expect(isWhitelistedImageUrl('https://upload.wikimedia.org:8080/a.jpg', 'upload.wikimedia.org')).toBe(false)
    expect(isWhitelistedImageUrl('https://upload.wikimedia.org/a.jpg\n', 'upload.wikimedia.org')).toBe(false)
    expect(isWhitelistedImageUrl('not a url', 'upload.wikimedia.org')).toBe(false)
  })

  it('descriptionUrl 主机独立白名单（commons.wikimedia.org）', () => {
    expect(
      isWhitelistedImageUrl('https://commons.wikimedia.org/wiki/File:X.jpg', 'commons.wikimedia.org'),
    ).toBe(true)
    expect(
      isWhitelistedImageUrl('https://upload.wikimedia.org/wiki/File:X.jpg', 'commons.wikimedia.org'),
    ).toBe(false)
  })
})

describe('validateImageSearchReport · 状态矩阵', () => {
  it('available：合法信封通过；items 为空拒绝；reason 非 null 拒绝', () => {
    const ok = validateImageSearchReport(makeImageSearchReport(), '西湖')
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.report.items).toHaveLength(1)
      expect(ok.report.items[0].artist).toBe('示例摄影师')
    }
    expect(
      validateImageSearchReport(makeImageSearchReport({ items: [], results_seen: 0 }), '西湖').ok,
    ).toBe(false)
    expect(
      validateImageSearchReport(makeImageSearchReport({ reason: '多余' }), '西湖').ok,
    ).toBe(false)
  })

  it('requested_query 必须等于实发 query；不等于则整份作废', () => {
    expect(validateImageSearchReport(makeImageSearchReport({ requested_query: '别的' }), '西湖').ok).toBe(false)
    expect(validateImageSearchReport(makeImageSearchReport({ requested_query: null }), '西湖').ok).toBe(false)
  })

  it('invalid_request：requested_query/provider_http_status/fetched_at 必须 null，items 空', () => {
    const base = makeImageSearchReport({
      status: 'invalid_request',
      reason: '查询必须为去除首尾空白后 1 到 100 个字符的文本',
      requested_query: null,
      provider_http_status: null,
      fetched_at: null,
      items: [],
      results_seen: 0,
    })
    expect(validateImageSearchReport(base, '西湖').ok).toBe(true)
    expect(
      validateImageSearchReport({ ...base, requested_query: '西湖' }, '西湖').ok,
    ).toBe(false)
    expect(
      validateImageSearchReport({ ...base, provider_http_status: 200 }, '西湖').ok,
    ).toBe(false)
    expect(validateImageSearchReport({ ...base, fetched_at: base.checked_at }, '西湖').ok).toBe(false)
    expect(
      validateImageSearchReport({ ...base, items: [makeImageSearchItem()] }, '西湖').ok,
    ).toBe(false)
  })

  it('失败状态（timeout/rate_limited/unavailable/failed）：不携带条目与 fetched_at', () => {
    for (const [status, provider] of [
      ['timeout', null],
      ['rate_limited', 429],
      ['unavailable', 503],
      ['failed', 404],
    ] as const) {
      const report = makeImageSearchReport({
        status,
        reason: '固定短句',
        provider_http_status: provider,
        fetched_at: null,
        items: [],
        results_seen: 0,
      })
      expect(validateImageSearchReport(report, '西湖').ok).toBe(true)
      expect(
        validateImageSearchReport({ ...report, items: [makeImageSearchItem()] }, '西湖').ok,
      ).toBe(false)
      expect(
        validateImageSearchReport({ ...report, fetched_at: report.checked_at }, '西湖').ok,
      ).toBe(false)
    }
    // rate_limited 与 provider_http_status 语义绑定：429 之外拒绝
    expect(
      validateImageSearchReport(
        makeImageSearchReport({ status: 'rate_limited', reason: '固定短句', provider_http_status: 500, fetched_at: null, items: [], results_seen: 0 }),
        '西湖',
      ).ok,
    ).toBe(false)
  })

  it('no_candidates：items 空 + fetched_at 必须有（读到了可信 body）', () => {
    const base = makeImageSearchReport({
      status: 'no_candidates',
      items: [],
      results_seen: 0,
    })
    expect(validateImageSearchReport(base, '西湖').ok).toBe(true)
    expect(validateImageSearchReport({ ...base, fetched_at: null }, '西湖').ok).toBe(false)
  })

  it('条目 URL 越过白名单 → 整份作废；未知字段拒绝', () => {
    const bad = makeImageSearchReport({
      items: [makeImageSearchItem({ thumbUrl: 'https://evil.example.com/a.jpg' })],
    })
    expect(validateImageSearchReport(bad, '西湖').ok).toBe(false)
    const extra = makeImageSearchReport() as unknown as Record<string, unknown>
    extra.extra_field = 1
    expect(validateImageSearchReport(extra, '西湖').ok).toBe(false)
    expect(validateImageSearchReport('not an object', '西湖').ok).toBe(false)
    expect(validateImageSearchReport(null, '西湖').ok).toBe(false)
  })

  it('署名与许可缺失保留 null；非法宽度拒绝', () => {
    const ok = validateImageSearchReport(
      makeImageSearchReport({ items: [makeImageSearchItem({ artist: null, license: null })] }),
      '西湖',
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.report.items[0].artist).toBeNull()
      expect(ok.report.items[0].license).toBeNull()
    }
    expect(
      validateImageSearchReport(
        makeImageSearchReport({ items: [makeImageSearchItem({ width: 0 })] }),
        '西湖',
      ).ok,
    ).toBe(false)
    expect(
      validateImageSearchReport(
        makeImageSearchReport({ items: [makeImageSearchItem({ height: -3 })] }),
        '西湖',
      ).ok,
    ).toBe(false)
  })
})

describe('searchImageSources（网络 adapter，全部 mock）', () => {
  it('本地查询非法：0 次请求，直接 bad_payload', async () => {
    await expect(searchImageSources('   ')).rejects.toMatchObject({ kind: 'bad_payload' })
    await expect(searchImageSources('a\uD800b')).rejects.toMatchObject({ kind: 'bad_payload' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('恰好一次 POST 到固定路径；body 只含规范化 query', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeImageSearchReport({ requested_query: '西湖' })))
    const report = await searchImageSources('  西湖  ')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(IMAGE_SOURCES_SEARCH_PATH)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ query: '西湖' })
    expect(report.status).toBe('available')
  })

  it('结构不符 → bad_payload；不重试', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ hello: 1 }))
    await expect(searchImageSources('西湖')).rejects.toMatchObject({ kind: 'bad_payload' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 422/503 → server 分类 + 固定安全文案，不透传 detail', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: '内部敏感原文', report: null }, 422),
    )
    const err = await searchImageSources('西湖').catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'server', status: 422 })
    expect((err as Error).message).not.toContain('内部敏感原文')

    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'x' }, 503))
    const err2 = await searchImageSources('西湖').catch((e: unknown) => e)
    expect(err2).toMatchObject({ kind: 'server', status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('网络错误沿用 network 分类；每次调用只发一次请求', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('boom'))
    await expect(searchImageSources('西湖')).rejects.toMatchObject({ kind: 'network' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

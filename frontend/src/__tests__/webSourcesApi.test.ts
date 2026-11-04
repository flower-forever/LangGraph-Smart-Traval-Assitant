/**
 * webSourcesApi 网络适配器测试：默认 fetch 直接失败，只有显式 mock 的用例
 * 才能返回响应；不发起真实请求、不读 .env、不重试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../lib/api'
import { WEB_SOURCES_SEARCH_PATH } from '../lib/webSources'
import { searchWebSources, WEB_SOURCES_TIMEOUT_MS } from '../lib/webSourcesApi'
import { makeWebSearchReport } from './fixtures/webSources'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function hangingBodyResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => new Promise<never>(() => {}),
    text: () => new Promise<never>(() => {}),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(() => {
    throw new Error('测试不得发起真实 fetch')
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchWebSources', () => {
  it('默认等待上限是 12 秒', () => {
    expect(WEB_SOURCES_TIMEOUT_MS).toBe(12000)
  })

  it('一次调用只发一次 POST，body 只有规范化 query，无 Key/Trip/坐标', async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeWebSearchReport()))
    const report = await searchWebSources('  西湖 旅游 ')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(WEB_SOURCES_SEARCH_PATH)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    })
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toEqual({ query: '西湖 旅游' })
    expect(Object.keys(body)).toEqual(['query'])
    expect(String(init.body)).not.toMatch(/tvly|api[_-]?key|trip|lat|lon|coordinate/i)
    expect(report.requested_query).toBe('西湖 旅游')
  })

  it('300 个 emoji 合法，301 个本地拒绝且 0 请求', async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeWebSearchReport({ requested_query: '🚀'.repeat(300) })))
    await searchWebSources('🚀'.repeat(300))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).query).toBe('🚀'.repeat(300))

    fetchMock.mockClear()
    await expect(searchWebSources('🚀'.repeat(301))).rejects.toMatchObject({ name: 'ApiError', kind: 'bad_payload' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('孤立代理 query 本地拒绝且 0 请求', async () => {
    await expect(searchWebSources('\uD800abc')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['\u0085abc', 'abc'],
    ['\u001cabc', 'abc'],
    ['\ufeffabc', '\ufeffabc'],
    ['\ufeff', '\ufeff'],
  ])('按 Python strip 实发 query 并与后端回显一致：%j', async (raw, sent) => {
    fetchMock.mockResolvedValue(jsonResponse(makeWebSearchReport({ requested_query: sent })))
    const report = await searchWebSources(raw)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).toEqual({ query: sent })
    expect(report.requested_query).toBe(sent)
  })

  it('仅 Python 空白 query 本地拒绝且 0 额外请求', async () => {
    await expect(searchWebSources('\u0085')).rejects.toBeInstanceOf(ApiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HTTP 422 用固定安全文案，不回显 detail', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'SECRET <script>alert(1)</script>', report: null }, 422))
    const err = (await searchWebSources('西湖').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('server')
    expect(err.status).toBe(422)
    expect(err.message).not.toContain('SECRET')
    expect(err.message).not.toContain('<script>')
    expect(err.detail).toBeUndefined()
  })

  it('HTTP 503 用固定安全文案，不回显 detail/Key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'tvly-secret-key', report: null }, 503))
    const err = (await searchWebSources('西湖').catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe('server')
    expect(err.status).toBe(503)
    expect(err.message).not.toContain('tvly-secret-key')
    expect(err.detail).toBeUndefined()
  })

  it('HTTP 500 text/plain 仍归 server，保留 upstreamUnavailable 但文案固定', async () => {
    fetchMock.mockResolvedValue(
      new Response('proxy exploded tvly-secret-key', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      }),
    )
    const err = (await searchWebSources('西湖').catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe('server')
    expect(err.status).toBe(500)
    expect(err.upstreamUnavailable).toBe(true)
    expect(err.message).not.toContain('tvly-secret-key')
    expect(err.detail).toBeUndefined()
  })

  it('坏 JSON 归 bad_payload，不回显原文', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"secret": <broken', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const err = (await searchWebSources('西湖').catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe('bad_payload')
    expect(err.message).not.toContain('secret')
  })

  it('信封校验失败归 bad_payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'available', foo: 'bar' }))
    const err = (await searchWebSources('西湖').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('bad_payload')
  })

  it('200 typed 失败信封（no_key）原样返回，不折成 HTTP 错误', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        makeWebSearchReport({
          status: 'no_key',
          reason: '未配置搜索服务 Key，网页资料搜索不可用',
          provider_http_status: null,
          fetched_at: null,
          requested_query: '西湖',
          results: [],
          results_seen: 0,
        }),
      ),
    )
    const report = await searchWebSources('西湖')
    expect(report.status).toBe('no_key')
    expect(report.requested_query).toBe('西湖')
  })

  it('调用方取消归 abort', async () => {
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('请求已中止', 'AbortError'))
          })
        }),
    )
    const controller = new AbortController()
    const pending = searchWebSources('西湖', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'ApiError', kind: 'abort' })
  })

  it('响应头已到但 body 卡住时归 timeout', async () => {
    fetchMock.mockResolvedValue(hangingBodyResponse())
    const err = (await searchWebSources('西湖', { timeoutMs: 20 }).catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('timeout')
  })

  it('网络失败只尝试一次，不重试', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const err = (await searchWebSources('西湖').catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe('network')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

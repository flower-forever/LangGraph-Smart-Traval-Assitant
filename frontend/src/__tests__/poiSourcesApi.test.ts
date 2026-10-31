/**
 * poiSourcesApi 网络包装测试：mock fetch，验证路径参数、校验与错误分类。
 * 不发起真实请求、不读 .env。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../lib/api'
import { buildPoiSourcesNearbyPath, fetchPoiSourcesNearby, POI_SOURCES_TIMEOUT_MS } from '../lib/poiSourcesApi'
import { makePoiSourceReport } from './fixtures/poiSources'

const QUERY = { lat: 31.2304, lon: 121.4737 }
const QUERY_NEG = { lat: -33.865143, lon: -151.2099 }

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildPoiSourcesNearbyPath', () => {
  it('按后端契约拼 lat/lon，0 与负数原样保留', () => {
    expect(buildPoiSourcesNearbyPath(QUERY)).toBe('/api/poi-sources/nearby?lat=31.2304&lon=121.4737')
    expect(buildPoiSourcesNearbyPath(QUERY_NEG)).toBe(
      '/api/poi-sources/nearby?lat=-33.865143&lon=-151.2099',
    )
    expect(buildPoiSourcesNearbyPath({ lat: 0, lon: 0 })).toBe('/api/poi-sources/nearby?lat=0&lon=0')
  })
})

describe('fetchPoiSourcesNearby', () => {
  it('默认等待上限是 12 秒', () => {
    expect(POI_SOURCES_TIMEOUT_MS).toBe(12000)
  })

  it('成功时只发一次 GET，并把已校验的信封返回', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(makePoiSourceReport(QUERY))))
    vi.stubGlobal('fetch', fetchMock)

    const report = await fetchPoiSourcesNearby(QUERY)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/poi-sources/nearby?lat=31.2304&lon=121.4737')
    expect(init.method ?? 'GET').toBe('GET')
    expect(report.status).toBe('available')
    expect(report.candidates).toHaveLength(2)
  })

  it('requested 与本次请求坐标不一致时抛 bad_payload', async () => {
    const report = makePoiSourceReport(QUERY)
    report.requested = { lat: 30.0, lon: 120.0 }
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(report)))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchPoiSourcesNearby(QUERY)).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'bad_payload',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 422（invalid_request）归为 server 错误，不伪装成结构问题', async () => {
    const envelope = makePoiSourceReport(QUERY, { status: 'invalid_request', candidates: [] })
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ detail: 'lat 必须为 -90 到 90 之间的有限数值', report: envelope }, 422),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const err = await fetchPoiSourcesNearby(QUERY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).kind).toBe('server')
    expect((err as ApiError).status).toBe(422)
  })

  it('HTTP 502 归为 server 错误', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ detail: 'bad gateway' }, 502)),
    )
    vi.stubGlobal('fetch', fetchMock)

    const err = await fetchPoiSourcesNearby(QUERY).catch((e: unknown) => e)
    expect((err as ApiError).kind).toBe('server')
    expect((err as ApiError).status).toBe(502)
  })

  it('调用方取消时归为 abort', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('请求已中止', 'AbortError'))
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = fetchPoiSourcesNearby(QUERY, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ kind: 'abort' })
  })

  it('响应头已到但 body 卡住：超时覆盖 body 阶段，归为 timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('请求已中止', 'AbortError'))
            })
            // 永不 resolve body：模拟响应头已回、body 挂起
            void resolve
          }),
      ),
    )

    await expect(fetchPoiSourcesNearby(QUERY, { timeoutMs: 20 })).rejects.toMatchObject({
      kind: 'timeout',
    })
  })

  it('返回 HTML 的 200 归为 network（SPA fallback），不当结构错误', async () => {
    const fetchMock = vi.fn(
      () =>
        Promise.resolve(
          new Response('<!doctype html><html><body>fallback</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchPoiSourcesNearby(QUERY)).rejects.toMatchObject({ kind: 'network' })
  })

  it('非对象 JSON 归为 bad_payload', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse([1, 2, 3])))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchPoiSourcesNearby(QUERY)).rejects.toMatchObject({ kind: 'bad_payload' })
  })

  it('baseUrl 覆盖生效', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(makePoiSourceReport(QUERY))))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPoiSourcesNearby(QUERY, { baseUrl: 'https://example.test' })

    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://example.test/api/poi-sources/nearby?lat=31.2304&lon=121.4737')
  })
})

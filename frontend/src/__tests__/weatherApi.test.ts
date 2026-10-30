/**
 * weatherApi 网络包装测试：mock fetch，验证路径参数、校验与错误分类。
 * 不发起真实请求。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../lib/api'
import { buildWeatherDayPath, fetchDayWeather } from '../lib/weatherApi'
import type { WeatherDayQuery } from '../lib/weather'
import { makeWeatherReport } from '../test/weatherFixtures'

const QUERY: WeatherDayQuery = { lat: 31.33, lon: 120.57, date: '2026-05-01' }

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildWeatherDayPath', () => {
  it('按后端契约拼 lat/lon/date，0 与负数原样保留', () => {
    expect(buildWeatherDayPath(QUERY)).toBe('/api/weather/day?lat=31.33&lon=120.57&date=2026-05-01')
    expect(buildWeatherDayPath({ lat: 0, lon: -0.5, date: '2026-05-01' })).toBe(
      '/api/weather/day?lat=0&lon=-0.5&date=2026-05-01',
    )
  })
})

describe('fetchDayWeather', () => {
  it('成功时只发一次 GET，并把已校验的信封返回', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(makeWeatherReport(QUERY))))
    vi.stubGlobal('fetch', fetchMock)

    const report = await fetchDayWeather(QUERY)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/weather/day?lat=31.33&lon=120.57&date=2026-05-01')
    expect(init.method ?? 'GET').toBe('GET')
    expect(report.status).toBe('available')
    expect(report.forecast?.values.temperature_2m_max).toBe(21.4)
  })

  it('后端返回的 requested_date 不一致时抛 bad_payload', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(makeWeatherReport(QUERY, { requested_date: '2026-05-02' }))),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchDayWeather(QUERY)).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'bad_payload',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 502 归为 server 错误，不伪装成结构问题', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'bad gateway' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const err = await fetchDayWeather(QUERY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
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
    const pending = fetchDayWeather(QUERY, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ kind: 'abort' })
  })

  it('超时归为 timeout，不无限等待', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('请求已中止', 'AbortError'))
            })
          }),
      ),
    )

    await expect(fetchDayWeather(QUERY, { timeoutMs: 20 })).rejects.toMatchObject({
      kind: 'timeout',
    })
  })
})

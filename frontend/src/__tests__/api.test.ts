import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, isTripLike, planTrip, fetchExampleTrip, probeBackend } from '../lib/api'
import { MOCK_TRIP } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function htmlResponse(body = '<!doctype html><html><body><div id="root"></div></body></html>', status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } })
}

function proxyErrorResponse() {
  return new Response(
    'Error occurred while trying to proxy: 127.0.0.1:5173/api/trips/example',
    { status: 500, headers: { 'Content-Type': 'text/plain' } },
  )
}

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('isTripLike 拒绝缺失字段的数据', () => {
    expect(isTripLike(MOCK_TRIP)).toBe(true)
    expect(isTripLike({ ...MOCK_TRIP, map_coordinate_system: 'GCJ02' })).toBe(false)
    expect(isTripLike({ ...MOCK_TRIP, days: undefined })).toBe(false)
    expect(isTripLike(null)).toBe(false)
  })

  it('isTripLike 深入校验每个 day 与 stops/legs 结构', () => {
    const withDays = (days: unknown) => ({ ...MOCK_TRIP, days }) as unknown
    const [day1] = MOCK_TRIP.days
    const stop = day1.stops[0]
    const leg = day1.legs[0]

    // days: [null] 是最容易让页面崩掉的坏数据
    expect(isTripLike(withDays([null]))).toBe(false)
    expect(isTripLike(withDays([]))).toBe(false)
    expect(isTripLike(withDays([{ ...day1, stops: [null] }]))).toBe(false)
    expect(isTripLike(withDays([{ ...day1, stops: [{ ...stop, id: '' }] }]))).toBe(false)
    expect(isTripLike(withDays([{ ...day1, stops: [{ ...stop, location: { lng: '120', lat: 30 } }] }]))).toBe(false)
    expect(isTripLike(withDays([{ ...day1, legs: [{ ...leg, route_type: 'teleport' }] }]))).toBe(false)
    expect(isTripLike(withDays([{ ...day1, legs: [{ ...leg, geometry: [{ lng: 120 }] }] }]))).toBe(false)
    expect(isTripLike(withDays([{ ...day1, legs: 'nope' }]))).toBe(false)
    expect(isTripLike(withDays([{ ...day1, day: '1' }]))).toBe(false)
    expect(isTripLike({ ...MOCK_TRIP, warnings: [1] })).toBe(false)
  })

  it('fetchExampleTrip 请求 /api/trips/example 并返回契约数据', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MOCK_TRIP))
    vi.stubGlobal('fetch', fetchMock)
    const trip = await fetchExampleTrip()
    expect(fetchMock).toHaveBeenCalledWith('/api/trips/example', expect.objectContaining({ headers: expect.anything() }))
    expect(trip.title).toBe('杭州三日漫步路书')
  })

  it('planTrip POST JSON 载荷', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MOCK_TRIP))
    vi.stubGlobal('fetch', fetchMock)
    await planTrip({
      destination: '杭州', days: 3, departure_date: null, travelers: 2,
      preferences: '', travel_mode: 'walking',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/trips/plan')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({ destination: '杭州', days: 3 })
  })

  it('网络失败抛 ApiError(network)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const err = await fetchExampleTrip().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('network')
  })

  it('后端 500 带 detail 时透出 detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ detail: '模型调用失败' }, 500),
    ))
    const err = await fetchExampleTrip().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('server')
    expect(err.detail).toBe('模型调用失败')
    expect(err.upstreamUnavailable).toBe(false)
  })

  it('500 text/plain（代理断开）标记 upstreamUnavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proxyErrorResponse()))
    const err = await fetchExampleTrip().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('server')
    expect(err.detail).toBeUndefined()
    expect(err.upstreamUnavailable).toBe(true)
  })

  it('返回结构不符契约时抛 bad_payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ foo: 'bar' })))
    const err = await fetchExampleTrip().catch((e) => e)
    expect(err.kind).toBe('bad_payload')
  })

  it('合同字段对但 day 是 null 时抛 bad_payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...MOCK_TRIP, days: [null] })))
    const err = await fetchExampleTrip().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('bad_payload')
  })
})

describe('probeBackend', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('走 /api 代理请求 /api/health，接受 JSON healthy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'healthy', tools_count: 3 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(probeBackend()).resolves.toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/health')
  })

  it('SPA fallback 的 200 HTML 不算后端在线', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse()))
    await expect(probeBackend()).resolves.toBe(false)
  })

  it('200 但 status 不是 healthy 也不算在线', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'degraded' })))
    await expect(probeBackend()).resolves.toBe(false)
  })

  it('Vite 代理断开（500 text/plain）不算在线', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proxyErrorResponse()))
    await expect(probeBackend()).resolves.toBe(false)
  })

  it('网络错误不算在线', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(probeBackend()).resolves.toBe(false)
  })

  it('外部传入的 abort 会取消探活', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')))
    await expect(probeBackend({ signal: controller.signal })).resolves.toBe(false)
  })
})

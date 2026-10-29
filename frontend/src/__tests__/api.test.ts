import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, isTripLike, planTrip, fetchExampleTrip, probeBackend, probeBackendCapabilities } from '../lib/api'
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

/**
 * 只回了响应头、body 永远不结束的响应。abort 打不断这种假响应，
 * 用来验证「响应体阶段」的超时归类不依赖底层读取是否响应 abort。
 */
function hangingBodyResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => new Promise<never>(() => {}),
    text: () => new Promise<never>(() => {}),
  } as unknown as Response
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

  it('响应头之后 body 卡住：超时归类 timeout，不误报 bad_payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(hangingBodyResponse()))
    const err = await fetchExampleTrip({ timeoutMs: 5 }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('timeout')
  })

  it('body 阶段被调用方取消归类 abort，不误报超时', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(hangingBodyResponse()))
    const pending = fetchExampleTrip({ signal: controller.signal, timeoutMs: 5000 }).catch((e) => e)
    controller.abort()
    const err = await pending
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('abort')
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

  it('probeBackend 的布尔结果与 capabilities.reachable 一致', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'healthy', planner_ready: false })))
    // 规划不可用，但后端确实可达：老入口仍然只回答「可达」
    await expect(probeBackend()).resolves.toBe(true)
  })
})

describe('probeBackendCapabilities', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('planner_ready=false：可达，但规划明确不可用', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ status: 'healthy', tools_count: 3, planner_ready: false }),
    ))
    await expect(probeBackendCapabilities()).resolves.toEqual({
      reachable: true,
      planner: 'unavailable',
      failure: null,
      amap: 'unknown',
    })
  })

  it('planner_ready=true：可达且可规划', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ status: 'healthy', planner_ready: true }),
    ))
    await expect(probeBackendCapabilities()).resolves.toEqual({
      reachable: true,
      planner: 'ready',
      failure: null,
      amap: 'unknown',
    })
  })

  it('字段缺失或不是布尔值时是 unknown，绝不猜成 unavailable', async () => {
    const payloads: unknown[] = [
      { status: 'healthy' },
      { status: 'healthy', planner_ready: 'false' },
      { status: 'healthy', planner_ready: 0 },
      { status: 'healthy', planner_ready: null },
      { status: 'healthy', planner_ready: {} },
    ]
    for (const payload of payloads) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)))
      const caps = await probeBackendCapabilities()
      expect(caps).toEqual({ reachable: true, planner: 'unknown', failure: null, amap: 'unknown' })
    }
  })

  it('status 不是 healthy：不可达，且 planner 固定 unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ status: 'degraded', planner_ready: true }),
    ))
    await expect(probeBackendCapabilities()).resolves.toEqual({
      reachable: false,
      planner: 'unknown',
      failure: 'bad_payload',
      amap: 'unknown',
    })
  })

  it('200 HTML（SPA fallback）归为 bad_payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse()))
    await expect(probeBackendCapabilities()).resolves.toMatchObject({
      reachable: false,
      planner: 'unknown',
      failure: 'bad_payload',
    })
  })

  it('HTTP 错误归为 http 分级', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proxyErrorResponse()))
    await expect(probeBackendCapabilities()).resolves.toMatchObject({
      reachable: false,
      planner: 'unknown',
      failure: 'http',
    })
  })

  it('网络错误归为 network 分级', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(probeBackendCapabilities()).resolves.toMatchObject({
      reachable: false,
      planner: 'unknown',
      failure: 'network',
    })
  })

  it('超时归为 timeout 分级（不会卡住首屏）', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    await expect(probeBackendCapabilities({ timeoutMs: 5 })).resolves.toMatchObject({
      reachable: false,
      planner: 'unknown',
      failure: 'timeout',
    })
  })

  it('响应头到了、body 卡住：超时归为 timeout，不算 bad_payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(hangingBodyResponse()))
    await expect(probeBackendCapabilities({ timeoutMs: 5 })).resolves.toEqual({
      reachable: false,
      planner: 'unknown',
      failure: 'timeout',
      amap: 'unknown',
    })
  })

  /* ───────── amap_configured 解析 ───────── */

  it('amap_configured=true：可达且地图服务已配置', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ status: 'healthy', planner_ready: true, amap_configured: true }),
    ))
    await expect(probeBackendCapabilities()).resolves.toMatchObject({ amap: 'configured' })
  })

  it('amap_configured=false：可达但当前服务未配置地图 Key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ status: 'healthy', planner_ready: true, amap_configured: false }),
    ))
    await expect(probeBackendCapabilities()).resolves.toMatchObject({ amap: 'not_configured' })
  })

  it('amap_configured 缺失、非布尔：unknown，绝不猜', async () => {
    const payloads: unknown[] = [
      { status: 'healthy' },
      { status: 'healthy', amap_configured: 'true' },
      { status: 'healthy', amap_configured: 1 },
      { status: 'healthy', amap_configured: null },
    ]
    for (const payload of payloads) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)))
      const caps = await probeBackendCapabilities()
      expect(caps.amap).toBe('unknown')
    }
  })

  it('不可达时 amap 固定 unknown：没连上就无从判断当前服务', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(probeBackendCapabilities()).resolves.toMatchObject({
      reachable: false,
      amap: 'unknown',
    })
  })
})

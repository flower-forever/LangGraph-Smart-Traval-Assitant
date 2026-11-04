import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import {
  LEG_REFRESH_DEFAULT_TIMEOUT_MS,
  LEG_REFRESH_PATH,
  refreshLegRoute,
} from '../lib/legRefreshApi'
import {
  LEG_REFRESH_FAILURE_REASONS,
  legRefreshReadyLeg,
  type LegRefreshRequest,
} from '../lib/legRefresh'

const request: LegRefreshRequest = {
  parent: { trip_id: 'trip-1', revision: 7 },
  day: 2,
  date: '2026-05-02',
  travel_mode: 'walking',
  from_stop: { id: 'anchor', location: { lng: 120.1, lat: 30.2 } },
  to_stop: { id: 'tail-first', location: { lng: 120.2, lat: 30.3 } },
}

function readyPayload(): Record<string, unknown> {
  return {
    parent: { trip_id: 'trip-1', revision: 7 },
    day: 2,
    date: '2026-05-02',
    travel_mode: 'walking',
    from_stop: { id: 'anchor', location: { lng: 120.1, lat: 30.2 } },
    to_stop: { id: 'tail-first', location: { lng: 120.2, lat: 30.3 } },
    map_status: 'ready',
    leg: {
      from_stop_id: 'anchor',
      to_stop_id: 'tail-first',
      mode: 'walking',
      route_type: 'navigation',
      distance_m: 0,
      duration_minutes: null,
      geometry: [
        { lng: 120.1, lat: 30.2 },
        { lng: 120.15, lat: 30.25 },
        { lng: 120.2, lat: 30.3 },
      ],
      description: '按两端记录的 WGS84 坐标向高德地图查询步行衔接段。',
    },
    reason: null,
    source: {
      provider: 'amap',
      coordinate_system: 'WGS84',
      endpoint: '/v5/direction/walking',
    },
    checked_at: '2026-11-04T14:55:00+00:00',
  }
}

let fetchMock: ReturnType<typeof vi.fn>

function httpResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response
}

function pendingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const fail = () => {
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (init?.signal?.aborted) fail()
    else init?.signal?.addEventListener('abort', fail, { once: true })
  })
}

function postBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('refreshLegRoute', () => {
  it('向固定 path 显式发一次 POST，并原样发送规范请求', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(readyPayload()))

    await refreshLegRoute(request)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit | undefined]
    expect(String(input)).toContain(LEG_REFRESH_PATH)
    expect(init?.method).toBe('POST')
    expect(postBody()).toEqual(request)
    const serialized = JSON.stringify(postBody())
    expect(serialized).not.toContain('instruction')
    expect(serialized).not.toContain('api_key')
    expect(serialized).not.toContain('url')
  })

  it('接受 baseUrl 但只拼接固定 path，不接受任意 URL', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(readyPayload()))

    await refreshLegRoute(request, { baseUrl: 'https://example.test/base/' })

    const [input] = fetchMock.mock.calls[0] as [RequestInfo | URL]
    expect(String(input)).toBe(`https://example.test/base${LEG_REFRESH_PATH}`)
  })

  it('成功时返回 typed 信封，不额外包 Trip，也不自动应用', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(readyPayload()))

    const result = await refreshLegRoute(request)

    expect(result.map_status).toBe('ready')
    expect(result.parent).toEqual(request.parent)
    expect('days' in result).toBe(false)
    expect('id' in result).toBe(false)
    expect(legRefreshReadyLeg(result)?.route_type).toBe('navigation')
  })

  it('本地请求不合法时零 fetch，抛固定 bad_payload', async () => {
    const sentinel = 'SENTINEL-LOCAL-INPUT-MUST-NOT-ECHO'
    const invalid = { ...request, extra: sentinel } as unknown as LegRefreshRequest

    const promise = refreshLegRoute(invalid)

    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await expect(promise).rejects.toMatchObject({ kind: 'bad_payload' })
    await expect(promise).rejects.not.toMatchObject({ message: expect.stringContaining(sentinel) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('HTTP 200 的 typed 失败仍是失败状态，不返回 leg', async () => {
    const payload = {
      ...readyPayload(),
      map_status: 'no_key',
      leg: null,
      reason: LEG_REFRESH_FAILURE_REASONS.no_key,
    }
    fetchMock.mockResolvedValueOnce(httpResponse(payload))

    const result = await refreshLegRoute(request)

    expect(result.map_status).toBe('no_key')
    expect(result.leg).toBeNull()
    expect(legRefreshReadyLeg(result)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('响应回显漂移时抛 bad_payload，不把几何当成端点归属证明', async () => {
    const payload = readyPayload()
    ;((payload.from_stop as Record<string, unknown>).location as Record<string, unknown>).lng =
      120.1000000001
    ;(payload.leg as Record<string, unknown>).geometry = [
      { lng: 120.1000000001, lat: 30.2 },
      { lng: 120.15, lat: 30.25 },
      { lng: 120.2, lat: 30.3 },
    ]
    fetchMock.mockResolvedValueOnce(httpResponse(payload))

    const promise = refreshLegRoute(request)

    await expect(promise).rejects.toMatchObject({ kind: 'bad_payload' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('响应带未知字段 / 非法 geometry 时抛固定安全 bad_payload，不回显内容', async () => {
    const sentinel = 'SENTINEL-UPSTREAM-BODY'
    const payload = { ...readyPayload(), extra: sentinel }
    fetchMock.mockResolvedValueOnce(httpResponse(payload))

    const promise = refreshLegRoute(request)

    await expect(promise).rejects.toMatchObject({ kind: 'bad_payload' })
    await expect(promise).rejects.not.toMatchObject({
      message: expect.stringContaining(sentinel),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([422, 500, 503])('HTTP %i 使用固定安全文案，丢弃 detail，不重试', async (status) => {
    const sentinel = 'SENTINEL-SERVER-DETAIL-KEY-BODY'
    fetchMock.mockResolvedValueOnce(httpResponse({ detail: sentinel }, status))

    const promise = refreshLegRoute(request)

    await expect(promise).rejects.toMatchObject({
      kind: 'server',
      status,
    })
    await expect(promise).rejects.not.toMatchObject({
      message: expect.stringContaining(sentinel),
    })
    const error = (await promise.catch((value: unknown) => value)) as ApiError
    expect(error.detail).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('网络错误只返回固定说明，不回显底层错误', async () => {
    const sentinel = 'SENTINEL-NETWORK-URL'
    fetchMock.mockRejectedValueOnce(new Error(sentinel))

    const promise = refreshLegRoute(request)

    await expect(promise).rejects.toMatchObject({ kind: 'network' })
    await expect(promise).rejects.not.toMatchObject({
      message: expect.stringContaining(sentinel),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('调用方取消沿用 shared abort 行为，只发一次', async () => {
    fetchMock.mockImplementation(pendingFetch)
    const controller = new AbortController()

    const promise = refreshLegRoute(request, { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toMatchObject({ kind: 'abort' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('超时沿用 shared timeout 行为，只发一次', async () => {
    fetchMock.mockImplementation(pendingFetch)

    await expect(refreshLegRoute(request, { timeoutMs: 20 })).rejects.toMatchObject({
      kind: 'timeout',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('默认超时 25 秒，固定 path 与后端已注册路由一致', () => {
    expect(LEG_REFRESH_DEFAULT_TIMEOUT_MS).toBe(25_000)
    expect(LEG_REFRESH_PATH).toBe('/api/trips/days/leg-refresh')
  })
})

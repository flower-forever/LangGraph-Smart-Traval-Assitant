import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../lib/api'
import {
  MAP_REFRESH_DEFAULT_TIMEOUT_MS,
  MAP_REFRESH_PATH,
  refreshDayMap,
} from '../lib/mapRefreshApi'
import type { MapRefreshRequest, MapRefreshResponse } from '../lib/mapRefresh'

const request: MapRefreshRequest = {
  destination: '杭州',
  day: 2,
  date: '2026-05-02',
  travel_mode: 'walking',
  parent: { trip_id: 'trip-1', revision: 7 },
  stops: [
    { id: 's1', name: '西湖', address: '西湖区' },
    { id: 's2', name: '灵隐寺', address: '' },
  ],
}

const response: MapRefreshResponse = {
  day: 2,
  date: '2026-05-02',
  parent: { trip_id: 'trip-1', revision: 7 },
  map_status: 'ready',
  stops: [
    { id: 's1', location: { lng: 120.15, lat: 30.25 }, resolved_address: '西湖区' },
    { id: 's2', location: { lng: 120.1, lat: 30.24 }, resolved_address: null },
  ],
  unresolved: [],
  legs: [
    {
      from_stop_id: 's1',
      to_stop_id: 's2',
      mode: 'walking',
      route_type: 'navigation',
      distance_m: 1200,
      duration_minutes: 18,
      geometry: [
        { lng: 120.15, lat: 30.25 },
        { lng: 120.12, lat: 30.245 },
        { lng: 120.1, lat: 30.24 },
      ],
      description: '步行',
    },
  ],
  warnings: [],
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

describe('refreshDayMap', () => {
  it('向固定 path 发 POST，并原样发送 buildMapRefreshRequest 的投影', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(response))

    await refreshDayMap(request)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit | undefined]
    expect(String(input)).toContain(MAP_REFRESH_PATH)
    expect(init?.method).toBe('POST')

    const body = postBody()
    expect(body).toEqual(request)
    expect(body.parent).toEqual({ trip_id: 'trip-1', revision: 7 })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('coords')
    expect(serialized).not.toContain('instruction')
  })

  it('默认超时为 25 秒，调用方可以覆盖', () => {
    expect(MAP_REFRESH_DEFAULT_TIMEOUT_MS).toBe(25_000)
  })

  it('成功时返回裸地图补丁，不额外包 Trip', async () => {
    fetchMock.mockResolvedValueOnce(httpResponse(response))

    const result = await refreshDayMap(request)

    expect(result).toEqual(response)
    expect(result.parent).toEqual(request.parent)
    expect('id' in result).toBe(false)
    expect('source' in result).toBe(false)
    expect('days' in result).toBe(false)
  })

  it.each([
    ['parent', { ...response, parent: { trip_id: 'trip-1', revision: 8 } }],
    ['day', { ...response, day: 3 }],
    ['站点顺序', { ...response, stops: [response.stops[1], response.stops[0]] }],
    [
      '几何点',
      {
        ...response,
        legs: [{ ...response.legs[0], geometry: [response.legs[0].geometry[0]] }],
      },
    ],
  ])('响应 %s 不符时抛 bad_payload', async (_label, payload) => {
    fetchMock.mockResolvedValueOnce(httpResponse(payload))

    const promise = refreshDayMap(request)

    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await expect(promise).rejects.toMatchObject({ kind: 'bad_payload' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([503, 422])('HTTP %i 沿用 shared server 错误，不重试', async (status) => {
    fetchMock.mockResolvedValueOnce(httpResponse({ detail: '拒绝' }, status))

    await expect(refreshDayMap(request)).rejects.toMatchObject({
      kind: 'server',
      status,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('调用方取消沿用 shared abort 行为', async () => {
    fetchMock.mockImplementation(pendingFetch)
    const controller = new AbortController()

    const promise = refreshDayMap(request, { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toMatchObject({ kind: 'abort' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('超时沿用 shared timeout 行为', async () => {
    fetchMock.mockImplementation(pendingFetch)

    await expect(refreshDayMap(request, { timeoutMs: 20 })).rejects.toMatchObject({
      kind: 'timeout',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * dayReplanApi 网络包装的测试：mock fetch，验证 URL、请求体与错误分类。
 * 不做真实服务调用；契约校验函数用真实的 dayReplan 纯函数。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../lib/api'
import { replanDay } from '../lib/dayReplanApi'
import {
  applyDayReplan,
  buildDayReplanRequest,
  type DayReplanResponse,
} from '../lib/dayReplan'
import type { Trip } from '../lib/api'

function locatedStop(id: string, name: string, time: string, lng: number, lat: number) {
  return {
    id,
    name,
    time,
    duration_minutes: 60,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location: { lng, lat },
  }
}

function navLeg(from: string, to: string, a: { lng: number; lat: number }, b: { lng: number; lat: number }) {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking' as const,
    route_type: 'navigation' as const,
    distance_m: 900,
    duration_minutes: 12,
    geometry: [{ ...a }, { ...b }],
    description: '导航路线。',
  }
}

function makeBase(): Trip {
  const a = locatedStop('s1', '虎丘', '10:00', 120.57, 31.33)
  const b = locatedStop('s2', '寒山寺', '13:00', 120.56, 31.31)
  return {
    id: 'trip-client-1',
    source: 'example',
    destination: '苏州',
    title: '苏州两日测试行程',
    summary: '原始摘要。',
    map_coordinate_system: 'WGS84',
    warnings: ['调整前提醒 A'],
    days: [
      {
        day: 1,
        date: '2026-05-01',
        title: '第一天',
        summary: '第一天摘要。',
        stops: [a, b],
        legs: [navLeg('s1', 's2', { lng: 120.57, lat: 31.33 }, { lng: 120.56, lat: 31.31 })],
      },
    ],
  }
}

function makeCandidateResponse(base: Trip): DayReplanResponse {
  const a = locatedStop('r1', '山塘街', '09:30', 120.61, 31.32)
  const b = locatedStop('r2', '留园', '11:00', 120.59, 31.31)
  return {
    day: {
      day: 1,
      date: '2026-05-01',
      title: 'AI 调整后的第一天',
      summary: 'AI 候选摘要。',
      stops: [a, b],
      legs: [navLeg('r1', 'r2', { lng: 120.61, lat: 31.32 }, { lng: 120.59, lat: 31.31 })],
    },
    warnings: ['本次返回提醒：09:30 是占位时间，不是真实时刻。'],
    map_status: 'ready',
    parent: { trip_id: base.id, revision: 5 },
    source: 'agent',
  }
}

function buildRequest(base: Trip) {
  const result = buildDayReplanRequest(base, 1, '把第一天安排得轻松一点。', {
    travel_mode: 'walking',
    parentRevision: 5,
  })
  if (!result.ok) throw new Error(result.message)
  return result.request
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('dayReplanApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST 到 /api/trips/days/replan，请求体只含文字投影、不带坐标', async () => {
    const base = makeBase()
    const request = buildRequest(base)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeCandidateResponse(base)))
    vi.stubGlobal('fetch', fetchMock)
    await replanDay(request)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/trips/days/replan')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.parent).toEqual({ trip_id: 'trip-client-1', revision: 5 })
    expect(body.stops[0]).not.toHaveProperty('location')
    expect(JSON.stringify(body)).not.toContain('120.57')
  })

  it('合法响应通过 validateDayReplanResponse 后原样返回', async () => {
    const base = makeBase()
    const request = buildRequest(base)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(makeCandidateResponse(base))))
    const response = await replanDay(request)
    expect(response.map_status).toBe('ready')
    expect(response.day.stops.map((s) => s.name)).toEqual(['山塘街', '留园'])
  })

  it('结构不符契约时抛 ApiError(bad_payload)，且不带 detail 泄漏', async () => {
    const base = makeBase()
    const request = buildRequest(base)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ foo: 'bar' })))
    const err = await replanDay(request).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).kind).toBe('bad_payload')
  })

  it('坏数据带敏感假 token 也不回显到错误信息', async () => {
    const base = makeBase()
    const request = buildRequest(base)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({ detail: 'secret-token-abc123', source: 'agent' }, 500),
    ))
    const err = (await replanDay(request).catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe('server')
    expect(err.message).not.toContain('secret-token-abc123')
  })

  it('ApiOptions.signal 取消时抛 ApiError(abort)', async () => {
    const base = makeBase()
    const request = buildRequest(base)
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => {
          const err = new DOMException('请求已中止', 'AbortError')
          reject(err)
        }
        if (init.signal?.aborted) rejectAbort()
        else init.signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    }))
    const err = (await replanDay(request, { signal: controller.signal }).catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe('abort')
  })

  it('timeoutMs 生效：响应体悬挂时按 timeout 归类', async () => {
    const base = makeBase()
    const request = buildRequest(base)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () => new Promise<never>(() => {}),
      text: () => new Promise<never>(() => {}),
    } as unknown as Response))
    const err = (await replanDay(request, { timeoutMs: 30 }).catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe('timeout')
  })

  it('503 返回 server 错误，供面板显示「规划暂时不可用」', async () => {
    const base = makeBase()
    const request = buildRequest(base)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: 'planner unavailable' }, 503)))
    const err = (await replanDay(request).catch((e: unknown) => e)) as ApiError
    expect(err.kind).toBe('server')
    expect(err.status).toBe(503)
  })

  it('端到端：客户端返回的响应能被 applyDayReplan 接受（同契约）', async () => {
    const base = makeBase()
    const request = buildRequest(base)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(makeCandidateResponse(base))))
    const response = await replanDay(request)
    const result = applyDayReplan({
      baseTrip: base,
      request,
      response,
      currentRevision: 5,
      forkTripId: 'trip-client-1-fork',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.changedDays).toEqual([1])
      expect(result.trip.days[0].stops[0].name).toBe('山塘街')
      expect(result.trip.days[0].stops[0].id).toBe('r1')
      // 其它天逐点保持（本例只有一天，验证原 trip 未被改）
      expect(base.days[0].stops[0].name).toBe('虎丘')
    }
  })
})

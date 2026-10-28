/**
 * 开发桩的本地行为测试：只起本机 http 服务，不访问高德、模型或任何外网。
 * 重点守住「固定示例 / 不提供规划」的标识，防止桩数据再次冒充真实导航或智能体结果。
 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStubServer, STUB_PLAN_DETAIL } from './server.mjs'

let server
let port

function request(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: body ? { 'Content-Type': 'application/json' } : undefined },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body: raw }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

beforeAll(async () => {
  server = createStubServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('dev-stub', () => {
  it('探活：/health 与 /api/health 都返回 healthy', async () => {
    for (const path of ['/health', '/api/health']) {
      const res = await request(path)
      expect(res.status).toBe(200)
      expect(res.type).toContain('application/json')
      expect(JSON.parse(res.body)).toEqual({ status: 'healthy', stub: true })
    }
  })

  it('示例行程醒目标注固定示例，且不冒充智能体结果', async () => {
    const res = await request('/api/trips/example')
    expect(res.status).toBe(200)
    const trip = JSON.parse(res.body)
    expect(trip.source).toBe('example')
    expect(trip.title).toContain('固定示例')
    expect(trip.summary).toContain('示例')
    expect(trip.summary).toContain('不是真实规划')
    expect(trip.warnings.join(' ')).toContain('固定示例')
    expect(res.body).not.toContain('"source":"agent"')
    expect(res.body).not.toContain('高德')
    expect(res.body).not.toMatch(/navigation/i)
  })

  it('所有模拟路段只允许 straight_line / unavailable，距离与耗时为 null', async () => {
    const res = await request('/api/trips/example')
    const trip = JSON.parse(res.body)
    const legs = trip.days.flatMap((day) => day.legs)
    expect(legs.length).toBeGreaterThan(0)
    for (const leg of legs) {
      expect(['straight_line', 'unavailable']).toContain(leg.route_type)
      expect(leg.distance_m).toBeNull()
      expect(leg.duration_minutes).toBeNull()
      expect(leg.geometry).toEqual([])
    }
  })

  it('规划接口明确 503，不伪造 agent 结果，也不回显请求目的地', async () => {
    const payload = {
      destination: '上海',
      days: 5,
      departure_date: null,
      travelers: 2,
      preferences: '不要太赶',
      travel_mode: 'walking',
    }
    const res = await request('/api/trips/plan', { method: 'POST', body: JSON.stringify(payload) })
    expect(res.status).toBe(503)
    expect(res.type).toContain('application/json')
    expect(JSON.parse(res.body)).toEqual({ detail: STUB_PLAN_DETAIL, stub: true })
    expect(res.body).not.toContain('上海')
    expect(res.body).not.toContain('days')
    expect(res.body).not.toContain('agent')
  })

  it('未知路径返回 404，而不是编造数据', async () => {
    const res = await request('/api/nope')
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body).detail).toContain('未实现的路径')
  })
})

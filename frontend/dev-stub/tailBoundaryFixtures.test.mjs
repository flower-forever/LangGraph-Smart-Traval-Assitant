/**
 * 后段衔接路线契约桩防漂移测试：tailBoundaryFixtures 的构造器必须始终通过
 * 前端真实校验器（validateLegRefreshResponse / validateDayReplanResponse）。
 * 关键约束（与 runner 同源）：这里 import 的就是 contract-server 运行时调用的
 * parseLegRefreshRequestBody / buildLegRefreshResponse / buildTailReplanResponse，
 * 不保留平行构造副本；构造器或前端契约任一侧变化，这里先红。
 *
 * replan 后段候选的响应校验依赖请求（parent / day / date / travel_mode 投影），
 * 用前端真实 buildDayReplanTailRequest 构造请求，再喂给桩构造器生成响应，
 * 最后用真实 validators + composeTailPreviewDay 检验——与浏览器会话完整链路一致。
 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildDayReplanRequest, validateDayReplanResponse } from '../src/lib/dayReplan'
import {
  buildDayReplanTailRequest,
  composeTailPreviewDay,
} from '../src/lib/dayReplanTail'
import { validateLegRefreshRequest, validateLegRefreshResponse } from '../src/lib/legRefresh'
import { buildPlanTrip, buildReplanResponse } from './contract-server.mjs'
import {
  buildLegRefreshInvalidResponse,
  buildLegRefreshResponse,
  buildTailReplanResponse,
  parseLegRefreshRequestBody,
  TAIL_LEG_REFRESH_MODES,
  TAIL_REPLAN_INSTRUCTION_PREFIX,
} from './tailBoundaryFixtures.mjs'

const planTrip = buildPlanTrip('plan')

// ==================== 构造器 + 前端真实校验器（同源闭环） ====================

describe('衔接路线契约桩与前端真实校验器（同源构造器）', () => {
  it('模式集合固定，ready / 0 距离变体都产出过真实校验的信封', () => {
    expect(TAIL_LEG_REFRESH_MODES).toEqual([
      'ready',
      'ready_zero_distance',
      'no_key',
      'timeout',
      'unavailable',
      'failed',
    ])
  })

  it('walking ready：严格请求 → 桩构造器 → validateLegRefreshResponse 精确回显', () => {
    const request = {
      parent: { trip_id: 'trip-e2e-plan-1', revision: 3 },
      day: 1,
      date: '2026-11-07',
      travel_mode: 'walking',
      from_stop: { id: 's-e2e-2', location: { lng: 120.141, lat: 30.261 } },
      to_stop: { id: 'ai-tail-e2e-1', location: { lng: 120.1264, lat: 30.2412 } },
    }
    const localCheck = validateLegRefreshRequest(request)
    if (!localCheck.ok) throw new Error(`本地请求校验意外失败：${localCheck.message}`)
    const built = buildLegRefreshResponse('ready', request)
    if (built.error) throw new Error(`buildLegRefreshResponse 意外失败：${built.error}`)
    const result = validateLegRefreshResponse(built.report, request)
    if (!result.ok) throw new Error(`validateLegRefreshResponse 拒绝：${result.message}`)
    expect(result.ok).toBe(true)
    // 两端 WGS84 端点按请求精确 echo（JS === 数值相等）
    expect(built.report.from_stop).toEqual(request.from_stop)
    expect(built.report.to_stop).toEqual(request.to_stop)
    expect(built.report.parent).toEqual(request.parent)
    expect(built.report.leg.from_stop_id).toBe('s-e2e-2')
    expect(built.report.leg.to_stop_id).toBe('ai-tail-e2e-1')
    expect(built.report.leg.route_type).toBe('navigation')
    expect(built.report.source).toEqual({
      provider: 'amap',
      coordinate_system: 'WGS84',
      endpoint: '/v5/direction/walking',
    })
    expect(built.report.reason).toBeNull()
    expect(built.report.checked_at).toMatch(/\+00:00$/)
  })

  it('driving ready：endpoint 随 mode 切换，leg.mode 与请求一致', () => {
    const request = {
      parent: { trip_id: 'trip-e2e-plan-1', revision: 0 },
      day: 1,
      date: null,
      travel_mode: 'driving',
      from_stop: { id: 's-e2e-2', location: { lng: 120.141, lat: 30.261 } },
      to_stop: { id: 'ai-tail-e2e-1', location: { lng: 120.1264, lat: 30.2412 } },
    }
    const built = buildLegRefreshResponse('ready', request)
    if (built.error) throw new Error(`buildLegRefreshResponse 意外失败：${built.error}`)
    const result = validateLegRefreshResponse(built.report, request)
    if (!result.ok) throw new Error(`validateLegRefreshResponse 拒绝：${result.message}`)
    expect(built.report.source.endpoint).toBe('/v5/direction/driving')
    expect(built.report.leg.mode).toBe('driving')
  })

  it('ready 0 距离 / null 耗时：distance_m=0 合法、duration=null 不补 0', () => {
    const request = {
      parent: { trip_id: 'trip-e2e-plan-1', revision: 0 },
      day: 1,
      date: '2026-11-07',
      travel_mode: 'walking',
      from_stop: { id: 's-e2e-2', location: { lng: 120.141, lat: 30.261 } },
      to_stop: { id: 'ai-tail-e2e-1', location: { lng: 120.1409, lat: 30.2609 } },
    }
    const built = buildLegRefreshResponse('ready_zero_distance', request)
    if (built.error) throw new Error(`buildLegRefreshResponse 意外失败：${built.error}`)
    const result = validateLegRefreshResponse(built.report, request)
    if (!result.ok) throw new Error(`validateLegRefreshResponse 拒绝：${result.message}`)
    expect(built.report.leg.distance_m).toBe(0)
    expect(built.report.leg.duration_minutes).toBeNull()
    expect(built.report.leg.geometry.length).toBeGreaterThanOrEqual(2)
  })

  it('typed 失败：leg=null + 固定安全 reason（与后端逐字一致），且过真实校验器', () => {
    const request = {
      parent: { trip_id: 'trip-e2e-plan-1', revision: 0 },
      day: 1,
      date: '2026-11-07',
      travel_mode: 'walking',
      from_stop: { id: 's-e2e-2', location: { lng: 120.141, lat: 30.261 } },
      to_stop: { id: 'ai-tail-e2e-1', location: { lng: 120.1264, lat: 30.2412 } },
    }
    const expectedReasons = {
      no_key: '服务端未配置高德地图 Key，本次未执行任何路线查询。',
      timeout: '衔接路线查询超时，本次未返回路线。',
      unavailable: '高德地图路线服务暂时不可用，本次未返回路线。',
      failed: '衔接路线数据不可用，本次未返回路线。',
    }
    for (const mode of ['no_key', 'timeout', 'unavailable', 'failed']) {
      const built = buildLegRefreshResponse(mode, request)
      if (built.error) throw new Error(`buildLegRefreshResponse 意外失败：${built.error}`)
      expect(built.report.map_status).toBe(mode)
      expect(built.report.leg).toBeNull()
      expect(built.report.reason).toBe(expectedReasons[mode])
      expect(built.report.reason).not.toContain('http')
      const result = validateLegRefreshResponse(built.report, request)
      if (!result.ok) throw new Error(`validateLegRefreshResponse(${mode}) 拒绝：${result.message}`)
    }
  })

  it('未知模式返回 error（桩只实现约定模式）', () => {
    const request = {
      parent: { trip_id: 't', revision: 0 },
      day: 1,
      date: null,
      travel_mode: 'walking',
      from_stop: { id: 'a', location: { lng: 0, lat: 0 } },
      to_stop: { id: 'b', location: { lng: 0.001, lat: 0.001 } },
    }
    expect(buildLegRefreshResponse('rate_limited', request).error).toBeTruthy()
    expect(buildLegRefreshResponse('available', request).error).toBeTruthy()
  })
})

// ==================== 请求解析（固定 422，不回显 input） ====================

describe('衔接路线请求体（固定 422，不回显原文）', () => {
  const validBody = {
    parent: { trip_id: 'trip-e2e-plan-1', revision: 2 },
    day: 1,
    date: '2026-11-07',
    travel_mode: 'walking',
    from_stop: { id: 's-e2e-2', location: { lng: 120.141, lat: 30.261 } },
    to_stop: { id: 'ai-tail-e2e-1', location: { lng: 120.1264, lat: 30.2412 } },
  }

  it('合法体解析为白名单投影；0 坐标合法、null 不是 0', () => {
    const parsed = parseLegRefreshRequestBody(validBody)
    expect(parsed?.request).toEqual(validBody)
    const zeroCoordinates = parseLegRefreshRequestBody({
      ...validBody,
      from_stop: { id: 's-e2e-2', location: { lng: 0, lat: 0 } },
    })
    expect(zeroCoordinates?.request.from_stop.location).toEqual({ lng: 0, lat: 0 })
  })

  it('未知字段 / 缺字段 / bool 冒充数值 / 非整数 revision / 坏日期 / 相同 id 都形状不符', () => {
    expect(parseLegRefreshRequestBody({ ...validBody, extra: 1 })).toBeNull()
    const { to_stop: _dropped, ...missingToStop } = validBody
    expect(parseLegRefreshRequestBody(missingToStop)).toBeNull()
    expect(
      parseLegRefreshRequestBody({
        ...validBody,
        from_stop: { id: 's-e2e-2', location: { lng: true, lat: 30 } },
      }),
    ).toBeNull()
    expect(
      parseLegRefreshRequestBody({ ...validBody, parent: { trip_id: 't', revision: 1.5 } }),
    ).toBeNull()
    expect(parseLegRefreshRequestBody({ ...validBody, day: 8 })).toBeNull()
    expect(parseLegRefreshRequestBody({ ...validBody, date: '2026-02-30' })).toBeNull()
    expect(
      parseLegRefreshRequestBody({
        ...validBody,
        to_stop: { id: 's-e2e-2', location: { lng: 120.1264, lat: 30.2412 } },
      }),
    ).toBeNull()
    expect(parseLegRefreshRequestBody('衔接路线')).toBeNull()
    expect(parseLegRefreshRequestBody(null)).toBeNull()
    expect(parseLegRefreshRequestBody(undefined)).toBeNull()
  })

  it('422 形状固定：唯一 detail，无第二个字段，不携带任何输入回显', () => {
    const invalid = buildLegRefreshInvalidResponse()
    expect(invalid.status).toBe(422)
    expect(invalid.body).toEqual({
      detail: '请求体不符合固定端点衔接路线接口要求，本次未执行任何路线查询。',
    })
    expect(Object.keys(invalid.body)).toEqual(['detail'])
  })

  it('坏 JSON 与坏 payload 走同一固定 422（镜像后端 _SafeLegRefreshRoute）', async () => {
    const res = await request('/api/trips/days/leg-refresh', {
      method: 'POST',
      body: '{"parent":',
    })
    expect(res.status).toBe(422)
    expect(JSON.parse(res.body)).toEqual(buildLegRefreshInvalidResponse().body)
  })
})

// ==================== 后段候选 fixture（【后段重规划】专用） ====================

describe('后段候选 fixture 与既有组合链（同源构造器 + 真实校验器）', () => {
  it('识别前缀与整日指令区分：只有【后段重规划】前缀走专用候选', () => {
    expect(TAIL_REPLAN_INSTRUCTION_PREFIX).toBe('【后段重规划】')
    expect('【后段重规划】只生成锚点…'.startsWith(TAIL_REPLAN_INSTRUCTION_PREFIX)).toBe(true)
    expect('换成博物馆主题'.startsWith(TAIL_REPLAN_INSTRUCTION_PREFIX)).toBe(false)
  })

  it('后段候选通过 validateDayReplanResponse 且首站时刻晚于冻结下界', () => {
    const built = buildDayReplanTailRequest(planTrip, 1, '换个安静的地方走走', 1, {
      travel_mode: 'walking',
      parentRevision: 0,
    })
    if (!built.ok) throw new Error(`buildDayReplanTailRequest 意外失败：${built.message}`)
    const response = buildTailReplanResponse(built.request)
    const result = validateDayReplanResponse(response, built.request)
    if (!result.ok) {
      throw new Error(`validateDayReplanResponse 拒绝：${result.message ?? JSON.stringify(result)}`)
    }
    expect(result.ok).toBe(true)
    expect(response.parent).toEqual(built.request.parent)
    // buildDayReplanTailRequest 返回 {ok, request, scope, combinedInstruction, lowerBound}
    expect(built.lowerBound.known).toBe(true)
    // 首站 13:00 晚于锚点 s-e2e-2 的冻结下界 11:10（10:30 + 40min 停留）
    expect(built.lowerBound.minutes).toBe(11 * 60 + 10)
    expect(response.day.stops[0].time).toBe('13:00')
  })

  it('composeTailPreviewDay 接受后段候选：组合成功、id 不冲突、不触发 time_conflict', () => {
    const built = buildDayReplanTailRequest(planTrip, 1, '换个安静的地方走走', 1, {
      travel_mode: 'walking',
      parentRevision: 0,
    })
    if (!built.ok) throw new Error(`buildDayReplanTailRequest 意外失败：${built.message}`)
    const response = buildTailReplanResponse(built.request)
    const preview = composeTailPreviewDay(planTrip, built.scope, response, 0)
    if (!preview.ok) {
      throw new Error(`composeTailPreviewDay 拒绝：${preview.reason} ${preview.message}`)
    }
    expect(preview.ok).toBe(true)
    expect(preview.tailStopCount).toBe(2)
    const candidateIds = response.day.stops.map((stop) => stop.id)
    expect(candidateIds).toEqual(['ai-tail-e2e-1', 'ai-tail-e2e-2'])
    for (const day of planTrip.days) {
      for (const stop of day.stops) {
        expect(candidateIds).not.toContain(stop.id)
      }
    }
  })

  it('整日 fixture（非 tail 前缀）不受影响：buildReplanResponse 仍走原路径', () => {
    const built = buildDayReplanRequest(planTrip, 1, '换成博物馆主题', {
      travel_mode: 'walking',
      parentRevision: 0,
    })
    if (!built.ok) throw new Error(`buildDayReplanRequest 意外失败：${built.message}`)
    const response = buildReplanResponse(built.request)
    const result = validateDayReplanResponse(response, built.request)
    if (!result.ok) {
      throw new Error(`validateDayReplanResponse 拒绝：${result.message ?? JSON.stringify(result)}`)
    }
    expect(result.ok).toBe(true)
    // 仍是既有整日候选 ai-e2e-1/2，不是 tail 专用命名空间
    expect(response.day.stops.map((stop) => stop.id)).toEqual(['ai-e2e-1', 'ai-e2e-2'])
  })
})

// ==================== 本机 loopback server（无外网） ====================

let server
let port
let control

function request(path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

beforeAll(async () => {
  const contractServer = await import('./contract-server.mjs')
  control = contractServer.createContractState()
  server = contractServer.createContractServer(control)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  port = server.address().port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('契约桩 leg-refresh 路由（本机 loopback，无外网）', () => {
  const wireBody = {
    parent: { trip_id: 'trip-e2e-plan-1', revision: 0 },
    day: 1,
    date: '2026-11-07',
    travel_mode: 'walking',
    from_stop: { id: 's-e2e-2', location: { lng: 120.141, lat: 30.261 } },
    to_stop: { id: 'ai-tail-e2e-1', location: { lng: 120.1264, lat: 30.2412 } },
  }

  it('ready：HTTP 200 信封过真实校验器，一次请求恰好记录一次', async () => {
    const beforeCount = control.requests.filter(
      (entry) => entry.path === '/api/trips/days/leg-refresh',
    ).length
    const res = await request('/api/trips/days/leg-refresh', {
      method: 'POST',
      body: JSON.stringify(wireBody),
    })
    expect(res.status).toBe(200)
    const report = JSON.parse(res.body)
    const result = validateLegRefreshResponse(report, wireBody)
    if (!result.ok) throw new Error(`validateLegRefreshResponse 拒绝：${result.message}`)
    // 一次显式请求 → control 恰好新增一条记录（含请求体，供 runner 审计）
    const legRequests = control.requests.filter((entry) => entry.path === '/api/trips/days/leg-refresh')
    expect(legRequests.length).toBe(beforeCount + 1)
    expect(legRequests[legRequests.length - 1].method).toBe('POST')
    expect(legRequests[legRequests.length - 1].body).toEqual(wireBody)
  })

  it('坏 payload：固定 422 不回显 input', async () => {
    const res = await request('/api/trips/days/leg-refresh', {
      method: 'POST',
      body: JSON.stringify({ ...wireBody, weapon: 'x', from_stop: undefined }),
    })
    expect(res.status).toBe(422)
    expect(JSON.parse(res.body)).toEqual({
      detail: '请求体不符合固定端点衔接路线接口要求，本次未执行任何路线查询。',
    })
    expect(res.body).not.toContain('weapon')
  })

  it('no_key：typed 失败信封 HTTP 200，leg=null + 固定 reason', async () => {
    control.legRefreshMode = 'no_key'
    try {
      const res = await request('/api/trips/days/leg-refresh', {
        method: 'POST',
        body: JSON.stringify(wireBody),
      })
      expect(res.status).toBe(200)
      const report = JSON.parse(res.body)
      expect(report.map_status).toBe('no_key')
      expect(report.leg).toBeNull()
      const result = validateLegRefreshResponse(report, wireBody)
      if (!result.ok) throw new Error(`validateLegRefreshResponse 拒绝：${result.message}`)
    } finally {
      control.legRefreshMode = null
    }
  })

  it('replan：tail 前缀指令走专用候选，整日指令原样走既有 fixture', async () => {
    const baseRequest = buildDayReplanTailRequest(planTrip, 1, '换个安静的地方走走', 1, {
      travel_mode: 'walking',
      parentRevision: 0,
    })
    if (!baseRequest.ok) throw new Error(`buildDayReplanTailRequest 意外失败：${baseRequest.message}`)
    const tailRes = await request('/api/trips/days/replan', {
      method: 'POST',
      body: JSON.stringify(baseRequest.request),
    })
    expect(tailRes.status).toBe(200)
    const tailReport = JSON.parse(tailRes.body)
    expect(tailReport.day.stops.map((stop) => stop.id)).toEqual([
      'ai-tail-e2e-1',
      'ai-tail-e2e-2',
    ])
    const tailValidated = validateDayReplanResponse(tailReport, baseRequest.request)
    expect(tailValidated.ok).toBe(true)

    const wholeDayRequest = buildDayReplanRequest(planTrip, 1, '换成博物馆主题', {
      travel_mode: 'walking',
      parentRevision: 0,
    })
    if (!wholeDayRequest.ok) throw new Error(`buildDayReplanRequest 意外失败：${wholeDayRequest.message}`)
    const wholeRes = await request('/api/trips/days/replan', {
      method: 'POST',
      body: JSON.stringify(wholeDayRequest.request),
    })
    expect(wholeRes.status).toBe(200)
    const wholeReport = JSON.parse(wholeRes.body)
    // 整日 fixture 保持原样：仍是既有 ai-e2e-1/2，不是 tail 专用候选
    expect(wholeReport.day.stops.map((stop) => stop.id)).toEqual(['ai-e2e-1', 'ai-e2e-2'])
    const wholeValidated = validateDayReplanResponse(wholeReport, wholeDayRequest.request)
    expect(wholeValidated.ok).toBe(true)
  })

  it('未知路径仍 404；leg-refresh 计数与请求体可从 control 审计', async () => {
    const res = await request('/api/nope', { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    // 本文件累计：ready 1 + 坏 payload 1 + no_key 1 + 坏 JSON 1 = 4 次显式请求记录；
    // 坏 JSON 按设计只记 path/seq，不保存不可解析原文
    const legRequests = control.requests.filter(
      (entry) => entry.path === '/api/trips/days/leg-refresh',
    )
    expect(legRequests.length).toBe(4)
    const parsedOnes = legRequests.filter((entry) => entry.body !== undefined)
    expect(parsedOnes.length).toBe(3)
    for (const entry of parsedOnes) {
      expect(entry.method).toBe('POST')
      expect(entry.body).toBeTruthy()
    }
  })
})

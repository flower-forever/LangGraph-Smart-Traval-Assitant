import { describe, expect, it } from 'vitest'
import {
  LEG_REFRESH_ENDPOINTS,
  LEG_REFRESH_FAILURE_REASONS,
  MAX_LEG_REFRESH_GEOMETRY_POINTS,
  buildLegRefreshRequest,
  legRefreshReadyLeg,
  validateLegRefreshRequest,
  validateLegRefreshResponse,
  type LegRefreshBuildInput,
  type LegRefreshRequest,
  type LegRefreshResponse,
} from '../lib/legRefresh'

const request: LegRefreshRequest = {
  parent: { trip_id: 'trip-1', revision: 7 },
  day: 2,
  date: '2026-05-02',
  travel_mode: 'walking',
  from_stop: { id: 'anchor', location: { lng: 120.1, lat: 30.2 } },
  to_stop: { id: 'tail-first', location: { lng: 120.2, lat: 30.3 } },
}

function build(input: LegRefreshBuildInput) {
  const result = buildLegRefreshRequest(input)
  if (!result.ok) throw new Error(`unexpected build failure: ${result.message}`)
  return result.request
}

function requestFailure(input: LegRefreshBuildInput) {
  const result = buildLegRefreshRequest(input)
  if (result.ok) throw new Error('expected build failure')
  return result
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
      endpoint: LEG_REFRESH_ENDPOINTS.walking,
    },
    checked_at: '2026-11-04T14:55:00+00:00',
  }
}

function validated(payload: unknown): LegRefreshResponse {
  const result = validateLegRefreshResponse(payload, request)
  if (!result.ok) throw new Error(`unexpected response failure: ${result.message}`)
  return result.response
}

function responseFailure(payload: unknown): string {
  const result = validateLegRefreshResponse(payload, request)
  if (result.ok) throw new Error('expected response failure')
  return result.message
}

function mutate(payload: Record<string, unknown>, fn: (copy: Record<string, unknown>) => void) {
  const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  fn(copy)
  return copy
}

describe('buildLegRefreshRequest', () => {
  it('只投影 parent/day/date/mode 与两端 id+WGS84 坐标，忽略其它站点字段', () => {
    const result = build({
      parent: { trip_id: 'trip-1', revision: 7, extra: 'ignored' },
      day: 2,
      date: '2026-05-02',
      travel_mode: 'walking',
      from_stop: {
        id: 'anchor',
        name: '西湖',
        address: '西湖区',
        time: '09:00',
        duration_minutes: 30,
        description: '不应进入请求',
        location: { lng: 120.1, lat: 30.2, extra: 1 },
        extra: 'ignored',
      },
      to_stop: {
        id: 'tail-first',
        name: '灵隐寺',
        address: '',
        time: '10:00',
        duration_minutes: null,
        description: '',
        location: { lng: 120.2, lat: 30.3 },
      },
    })

    expect(result).toEqual(request)
    expect(JSON.stringify(result)).not.toContain('地址')
    expect(JSON.stringify(result)).not.toContain('09:00')
    expect(JSON.stringify(result)).not.toContain('instruction')
  })

  it('接受合法 0 / 负坐标与 null 日期，并保留 driving 端点', () => {
    const result = build({
      parent: { trip_id: 'trip-1', revision: 0 },
      day: 1,
      date: null,
      travel_mode: 'driving',
      from_stop: { id: 'a', location: { lng: 0, lat: 0 } },
      to_stop: { id: 'b', location: { lng: -179.5, lat: -89.5 } },
    })

    expect(result).toEqual({
      parent: { trip_id: 'trip-1', revision: 0 },
      day: 1,
      date: null,
      travel_mode: 'driving',
      from_stop: { id: 'a', location: { lng: 0, lat: 0 } },
      to_stop: { id: 'b', location: { lng: -179.5, lat: -89.5 } },
    })
  })

  it('缺少端点坐标时明确失败，不补 0、不发请求', () => {
    const missingLocation = requestFailure({
      parent: { trip_id: 'trip-1', revision: 1 },
      day: 1,
      date: null,
      travel_mode: 'walking',
      from_stop: { id: 'a' },
      to_stop: { id: 'b', location: { lng: 120, lat: 30 } },
    })
    expect(missingLocation.reason).toBe('missing_location')
    expect(missingLocation.message).toContain('坐标')

    const nullLocation = requestFailure({
      parent: { trip_id: 'trip-1', revision: 1 },
      day: 1,
      date: null,
      travel_mode: 'walking',
      from_stop: { id: 'a', location: null },
      to_stop: { id: 'b', location: { lng: 120, lat: 30 } },
    })
    expect(nullLocation.reason).toBe('missing_location')

    const nullStop = requestFailure({
      parent: { trip_id: 'trip-1', revision: 1 },
      day: 1,
      date: null,
      travel_mode: 'walking',
      from_stop: null,
      to_stop: { id: 'b', location: { lng: 120, lat: 30 } },
    })
    expect(nullStop.reason).toBe('invalid_stop')
  })

  it.each([
    ['字符串经度', { lng: '120.1', lat: 30.2 }],
    ['布尔维度', { lng: 120.1, lat: true }],
    ['null 经度', { lng: null, lat: 30.2 }],
    ['NaN', { lng: Number.NaN, lat: 30.2 }],
    ['Infinity', { lng: 120.1, lat: Number.POSITIVE_INFINITY }],
    ['经度越界', { lng: 180.0001, lat: 30.2 }],
    ['纬度越界', { lng: 120.1, lat: -90.0001 }],
  ])('拒绝%s而不是转成 0 或省略', (_label, location) => {
    const result = requestFailure({
      parent: { trip_id: 'trip-1', revision: 1 },
      day: 1,
      date: null,
      travel_mode: 'walking',
      from_stop: { id: 'a', location },
      to_stop: { id: 'b', location: { lng: 120, lat: 30 } },
    })
    expect(result.reason).toBe('invalid_location')
  })

  it('拒绝起终点相同 id，即使坐标不同', () => {
    const result = requestFailure({
      parent: { trip_id: 'trip-1', revision: 1 },
      day: 1,
      date: null,
      travel_mode: 'walking',
      from_stop: { id: 'same', location: { lng: 120.1, lat: 30.2 } },
      to_stop: { id: 'same', location: { lng: 120.2, lat: 30.3 } },
    })
    expect(result.reason).toBe('duplicate_stop_id')
  })

  it.each([
    ['空 trip_id', { trip_id: '', revision: 1 }, 'invalid_parent'],
    ['全空白 trip_id', { trip_id: '   ', revision: 1 }, 'invalid_parent'],
    ['超长 trip_id', { trip_id: 'x'.repeat(101), revision: 1 }, 'invalid_parent'],
    ['控制字符 trip_id', { trip_id: 'a\u0001b', revision: 1 }, 'invalid_parent'],
    ['负 revision', { trip_id: 'trip-1', revision: -1 }, 'invalid_parent'],
    ['小数 revision', { trip_id: 'trip-1', revision: 1.5 }, 'invalid_parent'],
    ['布尔 revision', { trip_id: 'trip-1', revision: true }, 'invalid_parent'],
    [
      '超出安全整数 revision',
      { trip_id: 'trip-1', revision: Number.MAX_SAFE_INTEGER + 1 },
      'invalid_parent',
    ],
    ['day 0', 0, 'invalid_day'],
    ['day 8', 8, 'invalid_day'],
    ['day 小数', 1.5, 'invalid_day'],
    ['day 布尔', true, 'invalid_day'],
    ['日期不是真实日历日', '2026-02-30', 'invalid_date'],
    ['日期带时间', '2026-05-02T00:00:00', 'invalid_date'],
    ['空日期', '', 'invalid_date'],
    ['undefined 日期', undefined, 'invalid_date'],
    ['未知出行方式', 'transit', 'invalid_mode'],
    ['大小写错误', 'Walking', 'invalid_mode'],
    ['undefined 出行方式', undefined, 'invalid_mode'],
  ])('拒绝%s', (_label, value, reason) => {
    const input: LegRefreshBuildInput = {
      parent: { trip_id: 'trip-1', revision: 1 },
      day: 1,
      date: null,
      travel_mode: 'walking',
      from_stop: { id: 'a', location: { lng: 120, lat: 30 } },
      to_stop: { id: 'b', location: { lng: 121, lat: 31 } },
    }
    if (typeof value === 'object' && value !== null && 'trip_id' in value) {
      input.parent = value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      input.day = value
    } else if (typeof value === 'string' || value === undefined) {
      if (_label.includes('日期')) input.date = value
      else input.travel_mode = value
    }
    const result = requestFailure(input)
    expect(result.reason).toBe(reason)
  })

  it('不修改冻结的输入对象', () => {
    const input = {
      parent: { trip_id: 'trip-1', revision: 7 },
      day: 2,
      date: '2026-05-02',
      travel_mode: 'walking',
      from_stop: { id: 'anchor', location: { lng: 120.1, lat: 30.2 } },
      to_stop: { id: 'tail-first', location: { lng: 120.2, lat: 30.3 } },
    }
    const frozen = JSON.parse(JSON.stringify(input)) as Record<string, unknown>
    const deepFreeze = (value: unknown) => {
      if (value && typeof value === 'object') {
        Object.freeze(value)
        for (const child of Object.values(value)) deepFreeze(child)
      }
      return value
    }
    deepFreeze(frozen)

    expect(build(frozen as unknown as LegRefreshBuildInput)).toEqual(request)
    expect(frozen).toEqual(input)
  })
})

describe('validateLegRefreshRequest', () => {
  it('接受规范请求并返回同样的投影', () => {
    const result = validateLegRefreshRequest(request)
    if (!result.ok) throw new Error(result.message)
    expect(result.request).toEqual(request)
  })

  it('拒绝顶层、parent、stop、location 的未知字段', () => {
    const top = { ...request, extra: true }
    expect(validateLegRefreshRequest(top).ok).toBe(false)

    const parent = { ...request, parent: { ...request.parent, extra: true } }
    expect(validateLegRefreshRequest(parent).ok).toBe(false)

    const stop = {
      ...request,
      from_stop: { ...request.from_stop, name: '西湖' },
    }
    expect(validateLegRefreshRequest(stop).ok).toBe(false)

    const location = {
      ...request,
      from_stop: {
        ...request.from_stop,
        location: { ...request.from_stop.location, extra: 1 },
      },
    }
    expect(validateLegRefreshRequest(location).ok).toBe(false)
  })
})

describe('validateLegRefreshResponse', () => {
  it('接受 ready：合法距离 0、未知耗时 null、精确 echo 与 navigation leg', () => {
    const response = validated(readyPayload())

    expect(response.map_status).toBe('ready')
    expect(response.leg?.distance_m).toBe(0)
    expect(response.leg?.duration_minutes).toBeNull()
    expect(response.leg?.route_type).toBe('navigation')
    expect(response.parent).toEqual(request.parent)
    expect(response.from_stop).toEqual(request.from_stop)
    expect(response.to_stop).toEqual(request.to_stop)
    expect(legRefreshReadyLeg(response)).toBe(response.leg)
  })

  it('接受 Z 结尾的 UTC checked_at', () => {
    const payload = mutate(readyPayload(), (copy) => {
      copy.checked_at = '2026-11-04T14:55:00.123456Z'
    })
    expect(validated(payload).checked_at).toBe('2026-11-04T14:55:00.123456Z')
  })

  it('driving 模式接受 null 日期、driving 端点与 driving leg', () => {
    const drivingRequest = {
      ...request,
      date: null,
      travel_mode: 'driving' as const,
    }
    const payload = mutate(readyPayload(), (copy) => {
      copy.date = null
      copy.travel_mode = 'driving'
      ;(copy.leg as Record<string, unknown>).mode = 'driving'
      ;(copy.source as Record<string, unknown>).endpoint = LEG_REFRESH_ENDPOINTS.driving
    })
    const result = validateLegRefreshResponse(payload, drivingRequest)
    if (!result.ok) throw new Error(result.message)
    expect(result.response.date).toBeNull()
    expect(result.response.source.endpoint).toBe(LEG_REFRESH_ENDPOINTS.driving)
    expect(result.response.leg?.mode).toBe('driving')
  })

  it.each([
    ['parent.trip_id', (copy: Record<string, unknown>) => {
      ;(copy.parent as Record<string, unknown>).trip_id = 'trip-2'
    }],
    ['parent.revision', (copy: Record<string, unknown>) => {
      ;(copy.parent as Record<string, unknown>).revision = 8
    }],
    ['day', (copy: Record<string, unknown>) => {
      copy.day = 3
    }],
    ['date', (copy: Record<string, unknown>) => {
      copy.date = null
    }],
    ['travel_mode', (copy: Record<string, unknown>) => {
      copy.travel_mode = 'driving'
    }],
    ['from_stop.id', (copy: Record<string, unknown>) => {
      ;(copy.from_stop as Record<string, unknown>).id = 'other'
    }],
    ['to_stop.id', (copy: Record<string, unknown>) => {
      ;(copy.to_stop as Record<string, unknown>).id = 'other'
    }],
    ['from_stop.lng 极小漂移', (copy: Record<string, unknown>) => {
      ;((copy.from_stop as Record<string, unknown>).location as Record<string, unknown>).lng =
        120.1000000001
    }],
    ['to_stop.lat 极小漂移', (copy: Record<string, unknown>) => {
      ;((copy.to_stop as Record<string, unknown>).location as Record<string, unknown>).lat =
        30.3000000001
    }],
  ])('拒绝 %s 与请求不一致', (_label, change) => {
    expect(responseFailure(mutate(readyPayload(), change))).toContain('不一致')
  })

  it('拒绝响应顶层、parent、stop、location、source、leg、geometry 点的未知字段', () => {
    expect(responseFailure(mutate(readyPayload(), (copy) => {
      copy.extra = true
    }))).toContain('未知字段')

    expect(responseFailure(mutate(readyPayload(), (copy) => {
      ;(copy.parent as Record<string, unknown>).extra = true
    }))).toContain('未知字段')

    expect(responseFailure(mutate(readyPayload(), (copy) => {
      ;(copy.from_stop as Record<string, unknown>).extra = true
    }))).toContain('未知字段')

    expect(responseFailure(mutate(readyPayload(), (copy) => {
      ;((copy.from_stop as Record<string, unknown>).location as Record<string, unknown>).extra = true
    }))).toContain('未知字段')

    expect(responseFailure(mutate(readyPayload(), (copy) => {
      ;(copy.source as Record<string, unknown>).extra = true
    }))).toContain('未知字段')

    expect(responseFailure(mutate(readyPayload(), (copy) => {
      ;(copy.leg as Record<string, unknown>).extra = true
    }))).toContain('未知字段')

    expect(responseFailure(mutate(readyPayload(), (copy) => {
      const geometry = (copy.leg as Record<string, unknown>).geometry as Array<Record<string, unknown>>
      geometry[0].extra = true
    }))).toContain('未知字段')
  })

  it('拒绝未知 map_status 与缺失状态', () => {
    expect(responseFailure(mutate(readyPayload(), (copy) => {
      copy.map_status = 'partial'
    }))).toContain('map_status')
    expect(responseFailure(mutate(readyPayload(), (copy) => {
      delete copy.map_status
    }))).toContain('map_status')
  })

  it('接受四种 typed 失败：HTTP 200 不等于成功，leg 必须为 null', () => {
    for (const status of ['no_key', 'timeout', 'unavailable', 'failed'] as const) {
      const payload = mutate(readyPayload(), (copy) => {
        copy.map_status = status
        copy.leg = null
        copy.reason = LEG_REFRESH_FAILURE_REASONS[status]
      })
      const response = validated(payload)
      expect(response.map_status).toBe(status)
      expect(response.leg).toBeNull()
      expect(response.reason).toBe(LEG_REFRESH_FAILURE_REASONS[status])
      expect(legRefreshReadyLeg(response)).toBeNull()
    }
  })

  it.each([
    ['失败却带 leg', (copy: Record<string, unknown>) => {
      copy.map_status = 'no_key'
      copy.reason = LEG_REFRESH_FAILURE_REASONS.no_key
    }],
    ['失败 reason 不是固定安全文案', (copy: Record<string, unknown>) => {
      copy.map_status = 'failed'
      copy.leg = null
      copy.reason = '上游返回：secret'
    }],
    ['失败缺少 reason', (copy: Record<string, unknown>) => {
      copy.map_status = 'timeout'
      copy.leg = null
      copy.reason = null
    }],
    ['ready 没有 leg', (copy: Record<string, unknown>) => {
      copy.leg = null
    }],
    ['ready 带 reason', (copy: Record<string, unknown>) => {
      copy.reason = 'ok'
    }],
    ['ready leg 不是 navigation', (copy: Record<string, unknown>) => {
      ;(copy.leg as Record<string, unknown>).route_type = 'straight_line'
    }],
    ['ready leg 是 unavailable', (copy: Record<string, unknown>) => {
      ;(copy.leg as Record<string, unknown>).route_type = 'unavailable'
    }],
    ['ready leg 的 from_stop_id 不符', (copy: Record<string, unknown>) => {
      ;(copy.leg as Record<string, unknown>).from_stop_id = 'other'
    }],
    ['ready leg 的 to_stop_id 不符', (copy: Record<string, unknown>) => {
      ;(copy.leg as Record<string, unknown>).to_stop_id = 'other'
    }],
    ['ready leg 的 mode 不符', (copy: Record<string, unknown>) => {
      ;(copy.leg as Record<string, unknown>).mode = 'driving'
    }],
  ])('拒绝%s', (_label, change) => {
    expect(responseFailure(mutate(readyPayload(), change)).length).toBeGreaterThan(0)
  })

  it('source 必须固定 amap / WGS84 / 与 mode 对应的官方端点', () => {
    for (const patch of [
      { provider: 'other' },
      { coordinate_system: 'GCJ02' },
      { endpoint: LEG_REFRESH_ENDPOINTS.driving },
    ]) {
      const payload = mutate(readyPayload(), (copy) => {
        Object.assign(copy.source as Record<string, unknown>, patch)
      })
      expect(responseFailure(payload)).toContain('source')
    }
  })

  it.each([
    ['缺少时区', '2026-11-04T14:55:00'],
    ['非 UTC 时区', '2026-11-04T22:55:00+08:00'],
    ['非法日历日', '2026-02-30T14:55:00Z'],
    ['非法小时', '2026-11-04T24:00:00Z'],
    ['非法分钟', '2026-11-04T14:60:00Z'],
    ['非字符串', 123],
  ])('拒绝 checked_at %s', (_label, value) => {
    const payload = mutate(readyPayload(), (copy) => {
      copy.checked_at = value
    })
    expect(responseFailure(payload)).toContain('checked_at')
  })

  it.each([
    ['负数距离', -1, null],
    ['小数距离', 1.5, null],
    ['非安全整数距离', Number.MAX_SAFE_INTEGER + 1, null],
    ['字符串距离', '0', null],
    ['布尔距离', true, null],
    ['负耗时', 0, -1],
    ['非有限耗时', 0, Number.POSITIVE_INFINITY],
    ['字符串耗时', 0, '5'],
    ['布尔耗时', 0, true],
  ])('拒绝%s', (_label, distance, duration) => {
    const payload = mutate(readyPayload(), (copy) => {
      const leg = copy.leg as Record<string, unknown>
      leg.distance_m = distance
      leg.duration_minutes = duration
    })
    expect(responseFailure(payload).length).toBeGreaterThan(0)
  })

  it('geometry 必须 2..5000 点，且点必须是有限有界 WGS84 坐标', () => {
    expect(MAX_LEG_REFRESH_GEOMETRY_POINTS).toBe(5000)

    const onePoint = mutate(readyPayload(), (copy) => {
      ;(copy.leg as Record<string, unknown>).geometry = [{ lng: 120.1, lat: 30.2 }]
    })
    expect(responseFailure(onePoint)).toContain('geometry')

    const tooMany = mutate(readyPayload(), (copy) => {
      const geometry = Array.from({ length: MAX_LEG_REFRESH_GEOMETRY_POINTS + 1 }, (_, index) => ({
        lng: 120.1 + (index / (MAX_LEG_REFRESH_GEOMETRY_POINTS + 1)) * 0.1,
        lat: 30.2 + (index / (MAX_LEG_REFRESH_GEOMETRY_POINTS + 1)) * 0.1,
      }))
      ;(copy.leg as Record<string, unknown>).geometry = geometry
    })
    expect(responseFailure(tooMany)).toContain('geometry')

    for (const point of [
      { lng: '120.1', lat: 30.2 },
      { lng: 120.1, lat: true },
      { lng: Number.NaN, lat: 30.2 },
      { lng: 181, lat: 30.2 },
      { lng: 120.1, lat: -91 },
    ]) {
      const payload = mutate(readyPayload(), (copy) => {
        const geometry = (copy.leg as Record<string, unknown>).geometry as Array<Record<string, unknown>>
        geometry[1] = point
      })
      expect(responseFailure(payload).length).toBeGreaterThan(0)
    }
  })

  it('拒绝全部点相同的伪折线', () => {
    const payload = mutate(readyPayload(), (copy) => {
      ;(copy.leg as Record<string, unknown>).geometry = [
        { lng: 120.1, lat: 30.2 },
        { lng: 120.1, lat: 30.2 },
      ]
    })
    expect(responseFailure(payload)).toContain('geometry')
  })

  it('拒绝明显不属于请求端点的几何，但允许正常路网吸附偏移', () => {
    const snapped = mutate(readyPayload(), (copy) => {
      ;(copy.leg as Record<string, unknown>).geometry = [
        { lng: 120.101, lat: 30.201 },
        { lng: 120.199, lat: 30.299 },
      ]
    })
    expect(validated(snapped).map_status).toBe('ready')

    const farAway = mutate(readyPayload(), (copy) => {
      ;(copy.leg as Record<string, unknown>).geometry = [
        { lng: 121.0, lat: 31.0 },
        { lng: 121.001, lat: 31.001 },
      ]
    })
    expect(responseFailure(farAway)).toContain('geometry')

    const endpointsTooFar = mutate(readyPayload(), (copy) => {
      ;(copy.leg as Record<string, unknown>).geometry = [
        { lng: 120.4, lat: 30.5 },
        { lng: 120.5, lat: 30.6 },
      ]
    })
    expect(responseFailure(endpointsTooFar)).toContain('geometry')
  })

  it('端点 echo 与 geometry 是两次检查：几何不能自证端点归属', () => {
    const payload = mutate(readyPayload(), (copy) => {
      ;((copy.from_stop as Record<string, unknown>).location as Record<string, unknown>).lng =
        120.1000000001
      ;(copy.leg as Record<string, unknown>).geometry = [
        { lng: 120.1000000001, lat: 30.2 },
        { lng: 120.15, lat: 30.25 },
        { lng: 120.2, lat: 30.3 },
      ]
    })
    expect(responseFailure(payload)).toContain('不一致')
  })

  it('失败响应也必须完整回显请求令牌与端点', () => {
    const payload = mutate(readyPayload(), (copy) => {
      copy.map_status = 'no_key'
      copy.leg = null
      copy.reason = LEG_REFRESH_FAILURE_REASONS.no_key
      ;(copy.to_stop as Record<string, unknown>).id = 'other'
    })
    expect(responseFailure(payload)).toContain('不一致')
  })

  it('在 export 与纯函数中不生成直线、距离 0 或默认 mode', () => {
    const response = validated(readyPayload())
    const leg = legRefreshReadyLeg(response)
    expect(leg).not.toBeNull()
    expect(leg?.geometry.length).toBeGreaterThanOrEqual(2)
    expect(leg?.route_type).toBe('navigation')

    const failed = validated(
      mutate(readyPayload(), (copy) => {
        copy.map_status = 'failed'
        copy.leg = null
        copy.reason = LEG_REFRESH_FAILURE_REASONS.failed
      }),
    )
    expect(legRefreshReadyLeg(failed)).toBeNull()
  })
})

describe('响应类型可判别', () => {
  it('map_status=ready 时 leg 非空，失败时 leg 固定 null', () => {
    const ready = validated(readyPayload())
    const failure = validated(
      mutate(readyPayload(), (copy) => {
        copy.map_status = 'timeout'
        copy.leg = null
        copy.reason = LEG_REFRESH_FAILURE_REASONS.timeout
      }),
    )

    const first: LegRefreshResponse = ready
    const second: LegRefreshResponse = failure
    if (first.map_status === 'ready') expect(first.leg.route_type).toBe('navigation')
    if (second.map_status !== 'ready') expect(second.leg).toBeNull()
  })
})

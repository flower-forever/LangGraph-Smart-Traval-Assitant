import { describe, expect, it } from 'vitest'

import type { TravelMode, Trip, TripDay, TripLeg, TripLocation, TripStop } from '../lib/api'
import { MAX_SAVED_TRIP_BYTES, savedTripRecordBytes } from '../lib/savedTrips'
import {
  MAP_REFRESH_HISTORY_INCOMPLETE_NOTE,
  MAX_MAP_REFRESH_STOPS,
  MAX_MAP_REFRESH_WARNINGS,
  applyMapRefresh,
  buildMapRefreshRequest,
  previewMapRefresh,
  validateMapRefreshResponse,
  type MapRefreshRequest,
  type MapRefreshResponse,
} from '../lib/mapRefresh'

// ==================== 夹具 ====================

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item)
    }
    Object.freeze(value)
  }
  return value
}

function point(lng: number, lat: number): TripLocation {
  return { lng, lat }
}

function stop(
  id: string,
  name: string,
  address: string,
  location: TripLocation | null,
): TripStop {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: 60,
    description: `${name}的描述`,
    address,
    location,
  }
}

function leg(
  from: string,
  to: string,
  mode: TravelMode = 'walking',
  geometry: TripLocation[] = [point(120.2, 30.2), point(120.21, 30.21)],
): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode,
    route_type: 'navigation',
    distance_m: 1_000,
    duration_minutes: 10,
    geometry,
    description: '导航路线',
  }
}

function sampleTrip(): Trip {
  const day1: TripDay = {
    day: 1,
    date: '2026-11-02',
    title: '第一天',
    summary: '第一天的原摘要',
    stops: [
      stop('s|1', '西湖', '杭州西湖景区', point(120.15, 30.25)),
      stop('s|2', '灵隐寺', '杭州灵隐寺', point(120.1, 30.24)),
      stop('s|3', '河坊街', '杭州河坊街', point(120.17, 30.23)),
    ],
    legs: [leg('s|1', 's|2'), leg('s|2', 's|3')],
  }
  const day2: TripDay = {
    day: 2,
    date: null,
    title: '第二天',
    summary: '第二天的原摘要',
    stops: [
      stop('t|1', '外滩', '上海外滩', point(121.49, 31.24)),
      stop('t|2', '豫园', '上海豫园', point(121.49, 31.23)),
    ],
    legs: [leg('t|1', 't|2', 'driving', [point(121.49, 31.24), point(121.49, 31.23)])],
  }
  return {
    id: 'trip-parent',
    source: 'example',
    destination: '杭州',
    title: '杭州两日',
    summary: '原行程摘要',
    map_coordinate_system: 'WGS84',
    warnings: ['旧提醒一', '旧提醒二'],
    days: [day1, day2],
  }
}

function buildRequest(
  trip: Trip,
  day = 1,
  mode: TravelMode = 'walking',
  revision = 7,
): MapRefreshRequest {
  const result = buildMapRefreshRequest(trip, day, {
    travel_mode: mode,
    parentRevision: revision,
  })
  if (!result.ok) throw new Error(result.message)
  return result.request
}

function responseFor(
  request: MapRefreshRequest,
  options: {
    locations?: Record<string, TripLocation>
    legs?: TripLeg[]
    warnings?: string[]
    unresolved?: string[]
  } = {},
): MapRefreshResponse {
  const unresolved = new Set(options.unresolved ?? [])
  const stops = request.stops
    .filter((item) => !unresolved.has(item.id))
    .map((item) => ({
      id: item.id,
      location:
        options.locations?.[item.id] ??
        point(120.3 + request.stops.indexOf(item) * 0.01, 30.3),
      resolved_address: null as string | null,
    }))
  const legs =
    options.legs ??
    request.stops.slice(0, -1).map((item, index) => {
      return leg(item.id, request.stops[index + 1].id, request.travel_mode)
    })
  return {
    day: request.day,
    date: request.date,
    parent: { ...request.parent },
    map_status: 'ready',
    stops,
    unresolved: request.stops
      .filter((item) => unresolved.has(item.id))
      .map((item) => ({ id: item.id, reason_code: 'not_found', reason: '未找到' })),
    legs,
    warnings: options.warnings ?? [],
  }
}

function unavailable(from: string, to: string, mode: TravelMode): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode,
    route_type: 'unavailable',
    distance_m: null,
    duration_minutes: null,
    geometry: [],
    description: '本次没有可用路线',
  }
}

function apply(
  trip: Trip,
  request: MapRefreshRequest,
  response: unknown,
  currentRevision = 7,
  forkTripId = 'fork-1',
) {
  return applyMapRefresh({
    baseTrip: trip,
    request,
    response,
    currentRevision,
    forkTripId,
  })
}

function twoStopTrip(): Trip {
  return {
    id: 'two-stop',
    source: 'example',
    destination: '杭州',
    title: '两点行程',
    summary: '原摘要',
    map_coordinate_system: 'WGS84',
    warnings: ['旧提醒'],
    days: [
      {
        day: 1,
        date: '2026-11-02',
        title: '第一天',
        summary: '第一天摘要',
        stops: [
          stop('a', '甲', '甲地址', point(120.1, 30.1)),
          stop('b', '乙', '乙地址', point(120.2, 30.2)),
        ],
        legs: [leg('a', 'b')],
      },
    ],
  }
}

function largeGeometry(count: number, seed: number): TripLocation[] {
  const points: TripLocation[] = []
  for (let index = 0; index < count; index += 1) {
    points.push({
      lng: 120 + ((index * 13 + seed) % 1_000) / 1_000_000,
      lat: 30 + ((index * 7 + seed) % 1_000) / 1_000_000,
    })
  }
  return points
}

// ==================== 请求构造 ====================

describe('buildMapRefreshRequest', () => {
  it('按原顺序投影文字字段，保留 opaque id，不把坐标带进请求', () => {
    const trip = deepClone(sampleTrip())
    trip.id = 'trip|甲'
    trip.days[0].stops[0].id = 's|[1]'
    deepFreeze(trip)
    const request = buildRequest(trip)

    expect(request.parent).toEqual({ trip_id: 'trip|甲', revision: 7 })
    expect(request.stops.map((item) => item.id)).toEqual(['s|[1]', 's|2', 's|3'])
    expect(request.stops[0]).toEqual({
      id: 's|[1]',
      name: '西湖',
      address: '杭州西湖景区',
    })
    expect(Object.keys(request.stops[0]).sort()).toEqual(['address', 'id', 'name'])
    expect(JSON.stringify(request)).not.toContain('120.15')
    expect(request.travel_mode).toBe('walking')
  })

  it('拒绝超过 8 个站点且不截断', () => {
    const trip = deepClone(sampleTrip())
    trip.days[0].stops = Array.from({ length: 9 }, (_, index) =>
      stop(`s${index}`, `站点${index}`, `地址${index}`, point(120 + index / 100, 30)),
    )
    const result = buildMapRefreshRequest(trip, 1, {
      travel_mode: 'walking',
      parentRevision: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('too_many_stops')
      expect(result.message).toContain('没有截断')
    }
  })

  it('拒绝非法日期、revision、目的地与空站点，不改原值', () => {
    const trip = deepClone(sampleTrip())
    trip.days[0].date = '2026-02-30'
    const badDate = buildMapRefreshRequest(trip, 1, {
      travel_mode: 'walking',
      parentRevision: 1,
    })
    expect(!badDate.ok && badDate.reason).toBe('invalid_date')

    const badRevision = buildMapRefreshRequest(sampleTrip(), 1, {
      travel_mode: 'walking',
      parentRevision: Number.MAX_SAFE_INTEGER + 1,
    })
    expect(!badRevision.ok && badRevision.reason).toBe('invalid_parent_revision')

    const longDestination = deepClone(sampleTrip())
    longDestination.destination = '目'.repeat(81)
    const badDestination = buildMapRefreshRequest(longDestination, 1, {
      travel_mode: 'walking',
      parentRevision: 1,
    })
    expect(!badDestination.ok && badDestination.reason).toBe('invalid_destination')

    const empty = deepClone(sampleTrip())
    empty.days[0].stops = []
    const badEmpty = buildMapRefreshRequest(empty, 1, {
      travel_mode: 'walking',
      parentRevision: 1,
    })
    expect(!badEmpty.ok && badEmpty.reason).toBe('no_stops')
  })

  it('拒绝重复 id、超长名称 / 地址', () => {
    const duplicated = deepClone(sampleTrip())
    duplicated.days[0].stops[1].id = duplicated.days[0].stops[0].id
    const duplicate = buildMapRefreshRequest(duplicated, 1, {
      travel_mode: 'walking',
      parentRevision: 1,
    })
    expect(!duplicate.ok && duplicate.reason).toBe('duplicate_stop_id')

    const longName = deepClone(sampleTrip())
    longName.days[0].stops[0].name = '名'.repeat(121)
    const badName = buildMapRefreshRequest(longName, 1, {
      travel_mode: 'walking',
      parentRevision: 1,
    })
    expect(!badName.ok && badName.reason).toBe('invalid_stop')

    const longAddress = deepClone(sampleTrip())
    longAddress.days[0].stops[0].address = '址'.repeat(301)
    const badAddress = buildMapRefreshRequest(longAddress, 1, {
      travel_mode: 'walking',
      parentRevision: 1,
    })
    expect(!badAddress.ok && badAddress.reason).toBe('invalid_stop')
  })

  it('接受边界值：80 字目的地、120 字名称、300 字地址、100 字 id、最大安全 revision', () => {
    const trip = deepClone(sampleTrip())
    trip.id = 't'.repeat(100)
    trip.destination = '目'.repeat(80)
    trip.days[0].date = '2026-12-31'
    trip.days[0].stops = [
      stop('s'.repeat(100), '名'.repeat(120), '址'.repeat(300), point(120, 30)),
    ]
    const result = buildMapRefreshRequest(trip, 1, {
      travel_mode: 'driving',
      parentRevision: Number.MAX_SAFE_INTEGER,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.stops).toHaveLength(1)
      expect(result.request.parent.revision).toBe(Number.MAX_SAFE_INTEGER)
    }
  })
})

// ==================== 响应校验 ====================

describe('validateMapRefreshResponse', () => {
  it('接受完整 ready 响应与单点 ready', () => {
    const request = buildRequest(sampleTrip())
    const ready = validateMapRefreshResponse(responseFor(request), request)
    expect(ready.ok).toBe(true)

    const singleTrip = twoStopTrip()
    singleTrip.days[0].stops = [singleTrip.days[0].stops[0]]
    singleTrip.days[0].legs = []
    const singleRequest = buildRequest(singleTrip)
    const single = validateMapRefreshResponse(
      {
        ...responseFor(singleRequest),
        legs: [],
      },
      singleRequest,
    )
    expect(single.ok).toBe(true)
  })

  it('拒绝 parent / date / day 不一致以及同一 trip 不同 revision', () => {
    const request = buildRequest(sampleTrip())
    const base = responseFor(request)

    expect(validateMapRefreshResponse({ ...base, day: 2 }, request).ok).toBe(false)
    expect(validateMapRefreshResponse({ ...base, date: '2026-11-03' }, request).ok).toBe(false)
    expect(
      validateMapRefreshResponse(
        { ...base, parent: { trip_id: request.parent.trip_id, revision: 8 } },
        request,
      ).ok,
    ).toBe(false)
    expect(
      validateMapRefreshResponse(
        { ...base, parent: { trip_id: 'other', revision: 7 } },
        request,
      ).ok,
    ).toBe(false)
  })

  it('拒绝未知 id、重复 id、stops / unresolved 重叠与缺失并集', () => {
    const request = buildRequest(sampleTrip())
    const base = responseFor(request)

    const unknown = deepClone(base)
    unknown.stops[0].id = 'ghost'
    expect(validateMapRefreshResponse(unknown, request).ok).toBe(false)

    const duplicate = deepClone(base)
    duplicate.stops[1].id = duplicate.stops[0].id
    expect(validateMapRefreshResponse(duplicate, request).ok).toBe(false)

    const overlap = deepClone(base)
    overlap.unresolved = [{ id: overlap.stops[0].id, reason_code: 'x', reason: 'x' }]
    expect(validateMapRefreshResponse(overlap, request).ok).toBe(false)

    const missing = deepClone(base)
    missing.stops.pop()
    expect(validateMapRefreshResponse(missing, request).ok).toBe(false)
  })

  it('ready 缺站、ready 含 straight_line、hard 状态带 stop 都拒绝', () => {
    const request = buildRequest(sampleTrip())
    const base = responseFor(request)

    const missing = deepClone(base)
    missing.stops.pop()
    missing.unresolved.push({ id: 's|3', reason_code: 'x', reason: 'x' })
    expect(validateMapRefreshResponse(missing, request).ok).toBe(false)

    const straight = deepClone(base)
    straight.legs[0].route_type = 'straight_line'
    expect(validateMapRefreshResponse(straight, request).ok).toBe(false)

    const hard = deepClone(base)
    hard.map_status = 'no_key'
    expect(validateMapRefreshResponse(hard, request).ok).toBe(false)
  })

  it('拒绝几何越界、错误 mode、错误 legs 数量与超长 warnings', () => {
    const request = buildRequest(sampleTrip())
    const base = responseFor(request)

    const badGeometry = deepClone(base)
    badGeometry.legs[0].geometry[0].lng = 181
    expect(validateMapRefreshResponse(badGeometry, request).ok).toBe(false)

    const badMode = deepClone(base)
    badMode.legs[0].mode = 'driving'
    expect(validateMapRefreshResponse(badMode, request).ok).toBe(false)

    const badCount = deepClone(base)
    badCount.legs.pop()
    expect(validateMapRefreshResponse(badCount, request).ok).toBe(false)

    const manyWarnings = deepClone(base)
    manyWarnings.warnings = Array.from(
      { length: MAX_MAP_REFRESH_WARNINGS + 1 },
      (_, index) => `提醒${index}`,
    )
    expect(validateMapRefreshResponse(manyWarnings, request).ok).toBe(false)

    const extraField = deepClone(base) as MapRefreshResponse & { extra?: string }
    extraField.extra = 'x'
    expect(validateMapRefreshResponse(extraField, request).ok).toBe(false)
  })

  it('接受合法 partial（部分站点 + unavailable 腿），拒绝零成功的 partial', () => {
    const request = buildRequest(sampleTrip())
    const partial: MapRefreshResponse = {
      day: request.day,
      date: request.date,
      parent: { ...request.parent },
      map_status: 'partial',
      stops: [
        { id: 's|1', location: point(120.3, 30.3), resolved_address: null },
        { id: 's|2', location: point(120.31, 30.31), resolved_address: null },
      ],
      unresolved: [{ id: 's|3', reason_code: 'not_found', reason: '未找到' }],
      legs: [leg('s|1', 's|2'), unavailable('s|2', 's|3', 'walking')],
      warnings: [],
    }
    expect(validateMapRefreshResponse(partial, request).ok).toBe(true)

    const none: MapRefreshResponse = {
      ...partial,
      stops: [],
      unresolved: request.stops.map((item) => ({
        id: item.id,
        reason_code: 'not_found',
        reason: '未找到',
      })),
    }
    expect(validateMapRefreshResponse(none, request).ok).toBe(false)
  })
})

// ==================== 应用 ====================

describe('applyMapRefresh', () => {
  it('只改目标天的坐标 / 路线 / 提醒，其它天与文字字段保持原引用', () => {
    const trip = deepFreeze(sampleTrip())
    const request = buildRequest(trip)
    const response = deepFreeze(
      responseFor(request, {
        locations: {
          's|1': point(120.4, 30.4),
          's|2': point(120.41, 30.41),
          's|3': point(120.42, 30.42),
        },
        warnings: ['本次服务提醒'],
      }),
    )
    const before = JSON.stringify(trip)
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.trip).not.toBe(trip)
    expect(result.trip.id).toBe('fork-1')
    expect(result.trip.source).toBe('example')
    expect(result.trip.summary).toBe(trip.summary)
    expect(result.trip.days[1]).toBe(trip.days[1])
    expect(result.trip.days[0]).not.toBe(trip.days[0])
    expect(result.trip.days[0].stops[0].name).toBe('西湖')
    expect(result.trip.days[0].stops[0].address).toBe('杭州西湖景区')
    expect(result.trip.days[0].stops[0].time).toBe('09:00')
    expect(result.trip.days[0].stops[0].location).toEqual(point(120.4, 30.4))
    expect(result.points.refreshed).toBe(3)
    expect(result.legs.refreshed).toBe(2)
    expect(result.trip.warnings.join('\n')).toContain('本次服务提醒')
    expect(JSON.stringify(result.trip)).not.toContain('resolved_address')
    expect(JSON.stringify(trip)).toBe(before)
  })

  it('未返回的点保留原值，原 null 仍是 null', () => {
    const trip = deepClone(twoStopTrip())
    trip.days[0].stops[1].location = null
    trip.days[0].stops.push(stop('c', '丙', '丙地址', point(120.3, 30.3)))
    trip.days[0].legs = [leg('a', 'b'), leg('b', 'c')]
    const request = buildRequest(trip)
    const response: MapRefreshResponse = {
      day: request.day,
      date: request.date,
      parent: { ...request.parent },
      map_status: 'partial',
      stops: [{ id: 'a', location: point(120.5, 30.5), resolved_address: '高德地址' }],
      unresolved: [
        { id: 'b', reason_code: 'not_found', reason: '未找到' },
        { id: 'c', reason_code: 'not_found', reason: '未找到' },
      ],
      legs: [unavailable('a', 'b', 'walking'), unavailable('b', 'c', 'walking')],
      warnings: [],
    }
    const oldB = trip.days[0].stops[1]
    const oldLegBC = trip.days[0].legs[1]
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip.days[0].stops[1].location).toBeNull()
    expect(result.trip.days[0].stops[2].location).toEqual(point(120.3, 30.3))
    expect(result.trip.days[0].stops[1]).toBe(oldB)
    // b、c 端点都没变，旧的 b-c 路线安全沿用；a 变化且无新路线，a-b 失效。
    expect(result.trip.days[0].legs[1]).toBe(oldLegBC)
    expect(result.trip.days[0].legs[0].route_type).toBe('unavailable')
    expect(result.trip.days[0].stops[0].address).toBe('甲地址')
    expect(JSON.stringify(result.trip)).not.toContain('高德地址')
  })

  it('两端本次都成功但新路线 unavailable、坐标没变时保留旧 leg 且 no-op', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip)
    const response = deepFreeze({
      day: request.day,
      date: request.date,
      parent: { ...request.parent },
      map_status: 'partial',
      stops: [
        { id: 'a', location: point(120.1, 30.1), resolved_address: null },
        { id: 'b', location: point(120.2, 30.2), resolved_address: null },
      ],
      unresolved: [],
      legs: [unavailable('a', 'b', 'walking')],
      warnings: ['服务提醒'],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
    expect(result.trip).toBe(trip)
    expect(result.legs.retained).toBe(1)
    expect(result.notices.length).toBeGreaterThan(0)
    expect(result.trip.warnings).toBe(trip.warnings)
    expect(result.warningStats.newWarningCount).toBe(0)
  })

  it('端点变化且没有可用新路线时清空旧几何、距离与耗时', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip)
    const response = deepFreeze({
      day: request.day,
      date: request.date,
      parent: { ...request.parent },
      map_status: 'partial',
      stops: [
        { id: 'a', location: point(120.11, 30.11), resolved_address: null },
        { id: 'b', location: point(120.21, 30.21), resolved_address: null },
      ],
      unresolved: [],
      legs: [unavailable('a', 'b', 'walking')],
      warnings: [],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.legs.invalidated).toBe(1)
    const merged = result.trip.days[0].legs[0]
    expect(merged.route_type).toBe('unavailable')
    expect(merged.geometry).toEqual([])
    expect(merged.distance_m).toBeNull()
    expect(merged.duration_minutes).toBeNull()
  })

  it('合法 straight_line 原样采用，不伪作 navigation', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip)
    const response = deepFreeze({
      ...responseFor(request, {
        locations: { a: point(120.3, 30.3), b: point(120.31, 30.31) },
      }),
      map_status: 'partial',
      legs: [
        {
          ...leg('a', 'b'),
          route_type: 'straight_line',
          geometry: [point(120.3, 30.3), point(120.31, 30.31)],
        },
      ],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip.days[0].legs[0].route_type).toBe('straight_line')
    expect(result.legs.refreshed).toBe(1)
  })

  it('同坐标本次只返回 straight_line 时保留旧 navigation，纯退化不 fork', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip)
    const oldLeg = trip.days[0].legs[0]
    const response = deepFreeze({
      ...responseFor(request, {
        locations: { a: point(120.1, 30.1), b: point(120.2, 30.2) },
      }),
      map_status: 'partial',
      legs: [
        {
          ...leg('a', 'b'),
          route_type: 'straight_line',
          distance_m: null,
          duration_minutes: null,
          geometry: [point(120.1, 30.1), point(120.2, 30.2)],
          description: '直线',
        },
      ],
    })
    const preview = previewMapRefresh({
      baseTrip: trip,
      request,
      response,
      currentRevision: 7,
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.changed).toBe(false)
    expect(preview.legs.retained).toBe(1)
    expect(preview.legs.refreshed).toBe(0)
    expect(preview.notices.join('\n')).toContain('本次未取得新的导航路线')
    expect(preview.notices.join('\n')).toContain('没有可应用更改')

    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
    expect(result.trip).toBe(trip)
    expect(result.trip.warnings).toBe(trip.warnings)
    expect(result.legs.retained).toBe(1)
    expect(result.legs.refreshed).toBe(0)
    expect(result.legs.invalidated).toBe(0)
    expect(result.trip.days[0].legs[0]).toBe(oldLeg)
    expect(result.notices.join('\n')).not.toContain('本次结果完全相同')
  })

  it('同坐标但本次拿到真实 navigation 时照常替换旧 leg', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip)
    const newGeometry = [point(120.1, 30.1), point(120.15, 30.15), point(120.2, 30.2)]
    const response = deepFreeze({
      ...responseFor(request, {
        locations: { a: point(120.1, 30.1), b: point(120.2, 30.2) },
      }),
      legs: [
        {
          ...leg('a', 'b'),
          distance_m: 800,
          duration_minutes: 10,
          geometry: newGeometry,
        },
      ],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.legs.refreshed).toBe(1)
    expect(result.legs.retained).toBe(0)
    expect(result.trip.days[0].legs[0].route_type).toBe('navigation')
    expect(result.trip.days[0].legs[0].distance_m).toBe(800)
    expect(result.trip.days[0].legs[0].geometry).toHaveLength(3)
  })

  it('坐标改变时本次 straight_line 应采纳，不保旧 navigation', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip)
    const response = deepFreeze({
      ...responseFor(request, {
        locations: { a: point(120.11, 30.11), b: point(120.21, 30.21) },
      }),
      map_status: 'partial',
      legs: [
        {
          ...leg('a', 'b'),
          route_type: 'straight_line',
          distance_m: null,
          duration_minutes: null,
          geometry: [point(120.11, 30.11), point(120.21, 30.21)],
        },
      ],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.legs.refreshed).toBe(1)
    expect(result.legs.retained).toBe(0)
    expect(result.trip.days[0].legs[0].route_type).toBe('straight_line')
  })

  it('mode 改变时本次 straight_line 应采纳，不保旧 navigation', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip, 1, 'driving')
    const response = deepFreeze({
      ...responseFor(request, {
        locations: { a: point(120.1, 30.1), b: point(120.2, 30.2) },
      }),
      map_status: 'partial',
      legs: [
        {
          ...leg('a', 'b', 'driving'),
          route_type: 'straight_line',
          distance_m: null,
          duration_minutes: null,
          geometry: [point(120.1, 30.1), point(120.2, 30.2)],
        },
      ],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.legs.refreshed).toBe(1)
    expect(result.legs.retained).toBe(0)
    expect(result.trip.days[0].legs[0].route_type).toBe('straight_line')
    expect(result.trip.days[0].legs[0].mode).toBe('driving')
  })

  it('目标 mode 变化且新路线不可用时显式失效', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip, 1, 'driving')
    const response = deepFreeze({
      day: request.day,
      date: request.date,
      parent: { ...request.parent },
      map_status: 'partial',
      stops: [
        { id: 'a', location: point(120.1, 30.1), resolved_address: null },
        { id: 'b', location: point(120.2, 30.2), resolved_address: null },
      ],
      unresolved: [],
      legs: [unavailable('a', 'b', 'driving')],
      warnings: [],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.legs.invalidated).toBe(1)
    expect(result.trip.days[0].legs[0]).toMatchObject({
      mode: 'driving',
      route_type: 'unavailable',
      geometry: [],
      distance_m: null,
      duration_minutes: null,
    })
  })

  it('单点 ready 可以补上缺坐标并生成新副本', () => {
    const trip = deepClone(twoStopTrip())
    trip.days[0].stops = [trip.days[0].stops[0]]
    trip.days[0].stops[0].location = null
    trip.days[0].legs = []
    const request = buildRequest(trip)
    const response = deepFreeze({
      ...responseFor(request, { locations: { a: point(120.5, 30.5) } }),
      legs: [],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(true)
    expect(result.points.added).toBe(1)
    expect(result.legs.refreshed).toBe(0)
    expect(result.trip.days[0].stops[0].location).toEqual(point(120.5, 30.5))
  })

  it('hard status 空补丁 no-op，不 fork、不改提醒', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip)
    const response = deepFreeze({
      day: request.day,
      date: request.date,
      parent: { ...request.parent },
      map_status: 'no_key',
      stops: [],
      unresolved: request.stops.map((item) => ({
        id: item.id,
        reason_code: 'no_key',
        reason: '未配置地图 key',
      })),
      legs: [],
      warnings: [],
    })
    const result = apply(trip, request, response, 7, 'new-fork')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
    expect(result.trip).toBe(trip)
    expect(result.trip.id).toBe('two-stop')
    expect(result.trip.warnings).toBe(trip.warnings)
  })

  it('相同坐标与相同 leg 数值时 no-op，没有新提醒也不 fork', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip)
    const response = deepFreeze({
      day: request.day,
      date: request.date,
      parent: { ...request.parent },
      map_status: 'ready',
      stops: [
        { id: 'a', location: point(120.1, 30.1), resolved_address: null },
        { id: 'b', location: point(120.2, 30.2), resolved_address: null },
      ],
      unresolved: [],
      legs: [leg('a', 'b')],
      warnings: ['不应写进提醒'],
    })
    const result = apply(trip, request, response, 7, 'new-fork')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
    expect(result.trip).toBe(trip)
    expect(result.trip.warnings).toBe(trip.warnings)
    expect(result.trip.warnings).not.toContain('不应写进提醒')
  })

  it('父 revision / 父 id / 站点投影过期时拒绝且不改 Trip', () => {
    const trip = deepFreeze(sampleTrip())
    const request = buildRequest(trip)
    const response = deepFreeze(responseFor(request))
    const before = JSON.stringify(trip)

    const stale = apply(trip, request, response, 8)
    expect(!stale.ok && stale.reason).toBe('stale_request')

    const otherParent = deepClone(request)
    otherParent.parent.trip_id = 'other'
    const parentMismatch = apply(trip, otherParent, response)
    expect(!parentMismatch.ok && parentMismatch.reason).toBe('parent_mismatch')

    const edited = deepClone(trip)
    edited.days[0].stops[0].name = '改名后的西湖'
    const projection = apply(edited, request, response)
    expect(!projection.ok && projection.reason).toBe('stale_request')

    const badResponse = apply(trip, request, {
      ...response,
      parent: { trip_id: request.parent.trip_id, revision: 8 },
    })
    expect(!badResponse.ok && badResponse.reason).toBe('invalid_response')

    expect(JSON.stringify(trip)).toBe(before)
  })

  it('opaque id 与边界值可应用，父令牌按原值保留', () => {
    const trip = deepClone(twoStopTrip())
    trip.id = 'trip|甲'
    trip.days[0].stops = [
      stop('s|[1]', '甲', '甲地址', point(120.1, 30.1)),
      stop('站|乙', '乙', '乙地址', point(120.2, 30.2)),
    ]
    trip.days[0].legs = [leg('s|[1]', '站|乙')]
    const request = buildRequest(trip)
    expect(request.parent.trip_id).toBe('trip|甲')
    expect(request.stops.map((item) => item.id)).toEqual(['s|[1]', '站|乙'])
    const response = deepFreeze(responseFor(request))
    const result = apply(trip, request, response, 7, 'fork|甲')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip.id).toBe('fork|甲')
    expect(result.trip.days[0].stops.map((item) => item.id)).toEqual(['s|[1]', '站|乙'])
  })
})

// ==================== 提醒 ====================

describe('地图刷新提醒', () => {
  it('旧提醒原文保留到容量上限，省略条数准确并永久标记历史不完整', () => {
    const trip = deepClone(twoStopTrip())
    const userWarning = '【地图刷新】用户自己写的提醒：博物馆周一闭馆，需核实'
    trip.warnings = [
      userWarning,
      ...Array.from({ length: 41 }, (_, index) => `旧提醒${index}`),
    ]
    const request = buildRequest(trip)
    const response = deepFreeze({
      ...responseFor(request, {
        locations: { a: point(120.3, 30.3), b: point(120.31, 30.31) },
        warnings: ['本次提醒一', '本次提醒二'],
      }),
      legs: [
        {
          ...leg('a', 'b'),
          geometry: [point(120.3, 30.3), point(120.31, 30.31)],
        },
      ],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.trip.warnings.length).toBeLessThanOrEqual(MAX_MAP_REFRESH_WARNINGS)
    expect(result.trip.warnings).toHaveLength(MAX_MAP_REFRESH_WARNINGS)
    expect(result.trip.warnings).toContain(userWarning)
    expect(result.warningStats.historyIncomplete).toBe(true)
    expect(result.trip.warnings).toContain(MAP_REFRESH_HISTORY_INCOMPLETE_NOTE)
    expect(result.warningStats.keptOldWarnings + result.warningStats.omittedOldWarnings).toBe(
      trip.warnings.length,
    )
    expect(
      result.warningStats.omittedNewWarnings + result.warningStats.omittedOldWarnings,
    ).toBe(result.omittedWarnings)
    expect(result.warningStats.omittedNewWarnings).toBe(0)
    expect(result.warningStats.omittedOldWarnings).toBeGreaterThan(0)
  })

  it('50 条旧提醒 + 40 条新提醒仍压到 40，并给出准确遗漏数', () => {
    const trip = deepClone(twoStopTrip())
    trip.warnings = Array.from({ length: 50 }, (_, index) => `旧提醒${index}`)
    const request = buildRequest(trip)
    const response = deepFreeze({
      ...responseFor(request, {
        locations: { a: point(120.3, 30.3), b: point(120.31, 30.31) },
        warnings: Array.from({ length: 40 }, (_, index) => `新提醒${index}`),
      }),
      legs: [
        {
          ...leg('a', 'b'),
          geometry: [point(120.3, 30.3), point(120.31, 30.31)],
        },
      ],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip.warnings).toHaveLength(MAX_MAP_REFRESH_WARNINGS)
    expect(result.warningStats.omittedNewWarnings).toBe(3)
    expect(result.warningStats.omittedOldWarnings).toBe(50)
    expect(result.warningStats.omittedWarnings).toBe(53)
    expect(result.warningStats.historyIncomplete).toBe(true)
    expect(result.trip.warnings).toContain(MAP_REFRESH_HISTORY_INCOMPLETE_NOTE)
  })

  it('用户自己写的同模板 / 同前缀提醒不会被当成生成段删除', () => {
    const trip = deepClone(twoStopTrip())
    const omissionLike = '【提醒省略】这是用户自己写的提醒，不能被当成生成段'
    const headerLike = '【地图刷新】用户自己写的另一条提醒'
    trip.warnings = [omissionLike, headerLike]
    const request = buildRequest(trip)
    const response = deepFreeze(responseFor(request, {
      locations: { a: point(120.3, 30.3), b: point(120.31, 30.31) },
    }))
    const result = apply(trip, request, response)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip.warnings).toContain(omissionLike)
    expect(result.trip.warnings).toContain(headerLike)
    expect(result.trip.warnings.length).toBeLessThanOrEqual(MAX_MAP_REFRESH_WARNINGS)
  })
})

// ==================== 容量与预览 ====================

describe('容量与预览', () => {
  it('应用后超过 640 KB 时整体拒绝，不截几何、不改原行程', () => {
    const trip: Trip = {
      id: 'large-trip',
      source: 'agent',
      destination: '杭州',
      title: '大行程',
      summary: '摘要',
      map_coordinate_system: 'WGS84',
      warnings: [],
      days: [
        {
          day: 1,
          date: '2026-11-02',
          title: '第一天',
          summary: '摘要',
          stops: [
            stop('a', '甲', '甲地址', point(120.1, 30.1)),
            stop('b', '乙', '乙地址', point(120.2, 30.2)),
            stop('c', '丙', '丙地址', point(120.3, 30.3)),
          ],
          legs: [
            { ...leg('a', 'b'), geometry: largeGeometry(1_000, 1) },
            { ...leg('b', 'c'), geometry: largeGeometry(1_000, 2) },
          ],
        },
        {
          day: 2,
          date: null,
          title: '第二天',
          summary: '摘要',
          stops: [
            stop('d', '丁', '丁地址', point(121.1, 31.1)),
            stop('e', '戊', '戊地址', point(121.2, 31.2)),
          ],
          legs: [{ ...leg('d', 'e', 'driving'), geometry: largeGeometry(5_000, 3) }],
        },
        {
          day: 3,
          date: null,
          title: '第三天',
          summary: '摘要',
          stops: [
            stop('f', '己', '己地址', point(122.1, 32.1)),
            stop('g', '庚', '庚地址', point(122.2, 32.2)),
          ],
          legs: [{ ...leg('f', 'g', 'driving'), geometry: largeGeometry(5_000, 4) }],
        },
      ],
    }
    expect(savedTripRecordBytes(trip)).toBeLessThanOrEqual(MAX_SAVED_TRIP_BYTES)
    deepFreeze(trip)
    const before = JSON.stringify(trip)
    const request = buildRequest(trip)
    const response = deepFreeze({
      ...responseFor(request, {
        locations: {
          a: point(120.4, 30.4),
          b: point(120.5, 30.5),
          c: point(120.6, 30.6),
        },
      }),
      legs: [
        { ...leg('a', 'b'), geometry: largeGeometry(5_000, 5) },
        { ...leg('b', 'c'), geometry: largeGeometry(5_000, 6) },
      ],
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('capacity_exceeded')
    expect(JSON.stringify(trip)).toBe(before)
  })

  it('预览返回计数与提醒，不修改冻结输入；过期 revision 直接拒绝', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = deepFreeze(buildRequest(trip))
    const response = deepFreeze(responseFor(request, {
      locations: { a: point(120.3, 30.3), b: point(120.31, 30.31) },
    }))
    const before = JSON.stringify({ trip, request, response })
    const preview = previewMapRefresh({
      baseTrip: trip,
      request,
      response,
      currentRevision: 7,
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.changed).toBe(true)
    expect(preview.points.updated).toBe(2)
    expect(preview.legs.refreshed).toBe(1)
    expect(preview.day.stops[0].location).toEqual(point(120.3, 30.3))
    expect(preview.notices.length).toBeGreaterThan(0)
    expect(JSON.stringify({ trip, request, response })).toBe(before)

    const stale = previewMapRefresh({
      baseTrip: trip,
      request,
      response,
      currentRevision: 6,
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toBe('stale_request')
  })

  it('invalid response 整体拒绝，Trip 不动；8 站上限常量与后端一致', () => {
    const trip = deepFreeze(twoStopTrip())
    const request = buildRequest(trip)
    const response = deepFreeze({
      ...responseFor(request),
      stops: [{ id: 'a', location: point(120.5, 30.5), resolved_address: null }],
      unresolved: [{ id: 'b', reason_code: 'x', reason: 'x' }],
      map_status: 'ready',
    })
    const result = apply(trip, request, response)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid_response')
    expect(MAX_MAP_REFRESH_STOPS).toBe(8)
  })
})

import { describe, expect, it } from 'vitest'
import type { CityProfile, Trip, TripDay, TripLeg, TripLocation, TripStop } from '../lib/api'
import { isTripLike } from '../lib/api'
import {
  applyDayReplan,
  buildDayReplanRequest,
  validateDayReplanResponse,
  type DayReplanRequest,
  type DayReplanResponse,
} from '../lib/dayReplan'
import {
  validateLegRefreshResponse,
  type LegRefreshRequest,
} from '../lib/legRefresh'
import {
  buildMapRefreshRequest,
  applyMapRefresh,
  validateMapRefreshResponse,
  type MapRefreshRequest,
} from '../lib/mapRefresh'
import { projectTrip, rebuildIntercityLegs } from '../lib/tripTransfer'
import { MOCK_TRIP } from './fixtures/trip'

function point(lng: number, lat: number): TripLocation {
  return { lng, lat }
}

function locatedStop(id: string, name: string, location: TripLocation): TripStop {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: 60,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location,
  }
}

function navLeg(from: string, to: string, extra: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 1_000,
    duration_minutes: 12,
    geometry: [point(120.1, 30.2), point(120.15, 30.25), point(120.2, 30.3)],
    description: '导航路线',
    ...extra,
  }
}

/** 杭州(D1) → 苏州(D2) 的两城行程，D1 尾部带一条旧的城际段（距离故意写成 1 便于断言更新）。 */
function crossCityTrip(): Trip {
  const a1 = locatedStop('a1', '杭州甲', point(120.1, 30.2))
  const a2 = locatedStop('a2', '杭州乙', point(120.2, 30.3))
  const b1 = locatedStop('b1', '苏州甲', point(120.6, 31.3))
  const b2 = locatedStop('b2', '苏州乙', point(120.65, 31.32))
  const oldIntercity: TripLeg = {
    from_stop_id: 'a2',
    to_stop_id: 'b1',
    mode: 'driving',
    route_type: 'straight_line',
    distance_m: 1,
    duration_minutes: 1,
    geometry: [point(120.2, 30.3), point(120.6, 31.3)],
    description: '旧城际段',
    transferKind: 'intercity',
  }
  return {
    id: 'trip-multicity-cross',
    source: 'example',
    destination: '杭州',
    title: '杭州苏州两城',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [
      {
        day: 1,
        date: '2026-05-01',
        title: '杭州',
        summary: '',
        city: '杭州',
        stops: [a1, a2],
        legs: [navLeg('a1', 'a2'), oldIntercity],
      },
      {
        day: 2,
        date: '2026-05-02',
        title: '苏州',
        summary: '',
        city: '苏州',
        stops: [b1, b2],
        legs: [navLeg('b1', 'b2')],
      },
    ],
  }
}

/** 带全部新字段的行程：day.city、leg.transferKind、trip.cityProfiles（含 null 值）。 */
function tripWithMulticityFields(): Trip {
  return {
    ...MOCK_TRIP,
    cityProfiles: {
      杭州: {
        source: 'model_generated',
        oneLineImpression: { text: '湖山与市井并存。', source: 'model_generated' },
      },
      苏州: null,
    },
    days: [
      {
        ...MOCK_TRIP.days[0],
        city: '杭州',
        legs: [navLeg('s1', 's2', { transferKind: 'intercity' })],
      },
      { ...MOCK_TRIP.days[1], city: '苏州' },
      { ...MOCK_TRIP.days[2], city: null },
    ],
  } as unknown as Trip
}

describe('七期 S1 契约：tripTransfer 往返', () => {
  it('projectTrip 保留 day.city / leg.transferKind / trip.cityProfiles（含 null 值）', () => {
    const projected = projectTrip(tripWithMulticityFields())
    expect(projected.ok).toBe(true)
    if (!projected.ok) return

    expect(projected.trip.days[0].city).toBe('杭州')
    expect(projected.trip.days[1].city).toBe('苏州')
    expect(projected.trip.days[2].city).toBeNull()
    expect(projected.trip.days[0].legs[0].transferKind).toBe('intercity')
    expect(projected.trip.cityProfiles).toEqual({
      杭州: {
        source: 'model_generated',
        oneLineImpression: { text: '湖山与市井并存。', source: 'model_generated' },
      },
      苏州: null,
    })

    // 导出 → 导入（JSON 序列化往返）不丢新字段，也不新增 undefined 键。
    const again = projectTrip(JSON.parse(JSON.stringify(projected.trip)))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.trip).toEqual(projected.trip)
  })

  it('旧 fixture 投影后键集合不增加：缺省不写 city / transferKind / cityProfiles', () => {
    const projected = projectTrip(MOCK_TRIP)
    expect(projected.ok).toBe(true)
    if (!projected.ok) return
    const trip = projected.trip

    expect(Object.hasOwn(trip, 'cityProfiles')).toBe(false)
    expect(Object.keys(trip).sort()).toEqual(
      [
        'id',
        'source',
        'destination',
        'title',
        'summary',
        'map_coordinate_system',
        'warnings',
        'days',
      ].sort(),
    )
    for (const day of trip.days) {
      expect(Object.hasOwn(day, 'city')).toBe(false)
      expect(Object.keys(day).sort()).toEqual(
        ['day', 'date', 'title', 'summary', 'stops', 'legs'].sort(),
      )
      for (const leg of day.legs) {
        expect(Object.hasOwn(leg, 'transferKind')).toBe(false)
        expect(Object.keys(leg).sort()).toEqual(
          [
            'from_stop_id',
            'to_stop_id',
            'mode',
            'route_type',
            'distance_m',
            'duration_minutes',
            'geometry',
            'description',
          ].sort(),
        )
      }
    }
  })

  it('非法 transferKind 整份拒绝（isLegLike 先行拦截）；day.city 非字符串整份拒绝', () => {
    const badTransferKind = projectTrip({
      ...MOCK_TRIP,
      days: [
        {
          ...MOCK_TRIP.days[0],
          legs: [navLeg('s1', 's2', { transferKind: 'train' as unknown as 'intercity' })],
        },
      ],
    })
    expect(badTransferKind.ok).toBe(false)

    const badCity = projectTrip({
      ...MOCK_TRIP,
      days: [{ ...MOCK_TRIP.days[0], city: 42 as unknown as string }],
    })
    expect(badCity.ok).toBe(false)
  })
})

describe('七期 S1 契约：isTripLike', () => {
  it('合法新字段通过：transferKind null、city null、cityProfiles null / 空对象', () => {
    expect(isTripLike(tripWithMulticityFields())).toBe(true)
    expect(
      isTripLike({
        ...MOCK_TRIP,
        cityProfiles: null,
        days: [{ ...MOCK_TRIP.days[0], city: null, legs: [navLeg('s1', 's2', { transferKind: null })] }],
      }),
    ).toBe(true)
    expect(isTripLike({ ...MOCK_TRIP, cityProfiles: {} })).toBe(true)
  })

  it('非法新字段拒绝：transferKind=train、cityProfiles 坏 value、cityProfiles 是数组', () => {
    expect(
      isTripLike({
        ...MOCK_TRIP,
        days: [
          {
            ...MOCK_TRIP.days[0],
            legs: [navLeg('s1', 's2', { transferKind: 'train' as unknown as 'intercity' })],
          },
        ],
      }),
    ).toBe(false)
    expect(isTripLike({ ...MOCK_TRIP, cityProfiles: { 杭州: 42 } })).toBe(false)
    expect(isTripLike({ ...MOCK_TRIP, cityProfiles: [] })).toBe(false)
    expect(
      isTripLike({
        ...MOCK_TRIP,
        days: [{ ...MOCK_TRIP.days[0], city: 42 as unknown as string }],
      }),
    ).toBe(false)
  })
})

describe('七期 S1 契约：三个响应校验器放行新字段、仍拒绝未知键', () => {
  it('dayReplan：day.city / leg.transferKind 通过，未知键仍拒绝', () => {
    const base = MOCK_TRIP
    const built = buildDayReplanRequest(base, 1, '第一天轻松一点', {
      travel_mode: 'walking',
      parentRevision: 3,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const request = built.request

    const day: TripDay = {
      day: 1,
      date: '2026-04-03',
      title: '调整后的第一天',
      summary: '',
      city: '杭州',
      stops: [
        locatedStop('c1', 'Candidate A', point(120.16, 30.27)),
        locatedStop('c2', 'Candidate B', point(120.15, 30.26)),
      ],
      legs: [navLeg('c1', 'c2', { transferKind: 'intercity' })],
    }
    const response: DayReplanResponse = {
      day,
      warnings: [],
      map_status: 'ready',
      parent: { trip_id: base.id, revision: 3 },
      source: 'agent',
    }
    expect(validateDayReplanResponse(response, request).ok).toBe(true)

    const unknownDay = { ...response, day: { ...day, unknownField: true } }
    expect(validateDayReplanResponse(unknownDay, request).ok).toBe(false)
    const unknownLeg = {
      ...response,
      day: { ...day, legs: [{ ...day.legs[0], unknownField: true }] },
    }
    expect(validateDayReplanResponse(unknownLeg, request).ok).toBe(false)
  })

  it('legRefresh：leg.transferKind 通过，未知键仍拒绝', () => {
    const request: LegRefreshRequest = {
      parent: { trip_id: 'trip-1', revision: 7 },
      day: 2,
      date: '2026-05-02',
      travel_mode: 'walking',
      from_stop: { id: 'anchor', location: point(120.1, 30.2) },
      to_stop: { id: 'tail-first', location: point(120.2, 30.3) },
    }
    const response = {
      parent: { trip_id: 'trip-1', revision: 7 },
      day: 2,
      date: '2026-05-02',
      travel_mode: 'walking',
      from_stop: { id: 'anchor', location: point(120.1, 30.2) },
      to_stop: { id: 'tail-first', location: point(120.2, 30.3) },
      map_status: 'ready',
      leg: navLeg('anchor', 'tail-first', {
        route_type: 'navigation',
        distance_m: 0,
        duration_minutes: null,
        transferKind: 'intercity',
      }),
      reason: null,
      source: {
        provider: 'amap',
        coordinate_system: 'WGS84',
        endpoint: '/v5/direction/walking',
      },
      checked_at: '2026-11-04T14:55:00+00:00',
    }
    expect(validateLegRefreshResponse(response, request).ok).toBe(true)

    const unknownLeg = {
      ...response,
      leg: { ...response.leg, unknownField: true },
    }
    expect(validateLegRefreshResponse(unknownLeg, request).ok).toBe(false)
  })

  it('mapRefresh：leg.transferKind 通过，未知键仍拒绝', () => {
    const trip: Trip = {
      id: 'trip-multi-map',
      source: 'example',
      destination: '杭州',
      title: '多城地图校验',
      summary: '',
      map_coordinate_system: 'WGS84',
      warnings: [],
      days: [
        {
          day: 1,
          date: '2026-05-01',
          title: '第一天',
          summary: '',
          city: '杭州',
          stops: [
            locatedStop('a', 'A', point(120.0, 30.0)),
            locatedStop('b', 'B', point(120.1, 30.1)),
          ],
          legs: [navLeg('a', 'b')],
        },
      ],
    }
    const built = buildMapRefreshRequest(trip, 1, {
      travel_mode: 'walking',
      parentRevision: 2,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const request: MapRefreshRequest = built.request

    const response = {
      day: 1,
      date: '2026-05-01',
      parent: { trip_id: trip.id, revision: 2 },
      map_status: 'ready',
      stops: [
        { id: 'a', location: point(120.0, 30.0), resolved_address: null },
        { id: 'b', location: point(120.1, 30.1), resolved_address: null },
      ],
      unresolved: [],
      legs: [navLeg('a', 'b', { transferKind: 'intercity' })],
      warnings: [],
    }
    expect(validateMapRefreshResponse(response, request).ok).toBe(true)

    const unknownLeg = {
      ...response,
      legs: [{ ...response.legs[0], unknownField: true }],
    }
    expect(validateMapRefreshResponse(unknownLeg, request).ok).toBe(false)
  })
})

describe('七期 S1 契约：applyDayReplan 不丢城市数据', () => {
  function applyWith(base: Trip) {
    const built = buildDayReplanRequest(base, 2, '第二天保持轻松', {
      travel_mode: 'walking',
      parentRevision: 5,
    })
    if (!built.ok) throw new Error(built.message)
    const request: DayReplanRequest = built.request
    const response: DayReplanResponse = {
      day: {
        day: 2,
        date: '2026-04-04',
        title: '调整后的第二天',
        summary: '',
        city: '杭州',
        stops: [locatedStop('n1', '新站点', point(120.14, 30.24))],
        legs: [],
      },
      warnings: [],
      map_status: 'ready',
      parent: { trip_id: base.id, revision: 5 },
      source: 'agent',
    }
    const validated = validateDayReplanResponse(response, request)
    if (!validated.ok) throw new Error(validated.message)
    const applied = applyDayReplan({
      baseTrip: base,
      request,
      response,
      currentRevision: 5,
      forkTripId: `${base.id}-fork`,
    })
    if (!applied.ok) throw new Error(applied.message)
    return applied.trip
  }

  it('有 cityProfile / cityProfiles 时原样保留（含 null）', () => {
    const base: Trip = {
      ...MOCK_TRIP,
      cityProfile: { source: 'model_generated' },
      cityProfiles: { 杭州: { source: 'model_generated' }, 苏州: null } as unknown as Record<
        string,
        CityProfile
      >,
    }
    const trip = applyWith(base)
    expect(trip.cityProfile).toEqual({ source: 'model_generated' })
    expect(trip.cityProfiles).toEqual({ 杭州: { source: 'model_generated' }, 苏州: null })
    // 候选日的 city 进入新行程
    expect(trip.days.find((day) => day.day === 2)?.city).toBe('杭州')
  })

  it('旧行程没有这些键时，不凭空增加键', () => {
    const trip = applyWith(MOCK_TRIP)
    expect(Object.hasOwn(trip, 'cityProfile')).toBe(false)
    expect(Object.hasOwn(trip, 'cityProfiles')).toBe(false)
  })
})

describe('七期 S1 多城：单日重规划与城际段重建', () => {
  it('苏州日请求 destination=苏州；应用后城际段端点与距离更新', () => {
    const base = crossCityTrip()
    const built = buildDayReplanRequest(base, 2, '第二天改成苏州园林', {
      travel_mode: 'walking',
      parentRevision: 2,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.request.destination).toBe('苏州')

    const c1 = locatedStop('c1', '拙政园', point(121.0, 31.0))
    const c2 = locatedStop('c2', '留园', point(121.05, 31.02))
    const response: DayReplanResponse = {
      day: {
        day: 2,
        date: '2026-05-02',
        title: '苏州园林',
        summary: '',
        city: '苏州',
        stops: [c1, c2],
        legs: [navLeg('c1', 'c2')],
      },
      warnings: [],
      map_status: 'ready',
      parent: { trip_id: base.id, revision: 2 },
      source: 'agent',
    }
    const applied = applyDayReplan({
      baseTrip: base,
      request: built.request,
      response,
      currentRevision: 2,
      forkTripId: 'trip-multicity-cross-fork',
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return

    const day1 = applied.trip.days[0]
    const transfer = day1.legs[day1.legs.length - 1]
    expect(transfer.transferKind).toBe('intercity')
    expect(transfer.from_stop_id).toBe('a2')
    expect(transfer.to_stop_id).toBe('c1')
    expect(transfer.geometry).toEqual([point(120.2, 30.3), point(121.0, 31.0)])
    expect(transfer.distance_m).not.toBe(1)
    expect(transfer.distance_m as number).toBeGreaterThan(80_000)
    expect(transfer.duration_minutes as number).toBeGreaterThan(60)
    // 旧城际段被替换，而不是与新段并存
    expect(day1.legs.filter((leg) => leg.transferKind === 'intercity')).toHaveLength(1)
  })

  it('同城相邻天不生成城际段；跨城缺坐标降级为 unavailable', () => {
    const sameCity: TripDay[] = [
      {
        day: 1,
        date: null,
        title: '',
        summary: '',
        city: '杭州',
        stops: [locatedStop('s1', 'A', point(120.0, 30.0))],
        legs: [],
      },
      {
        day: 2,
        date: null,
        title: '',
        summary: '',
        city: '杭州',
        stops: [locatedStop('s2', 'B', point(120.1, 30.1))],
        legs: [],
      },
    ]
    const rebuilt = rebuildIntercityLegs(sameCity, '杭州')
    expect(rebuilt.every((day) => !day.legs.some((leg) => leg.transferKind === 'intercity'))).toBe(
      true,
    )

    // 旧行程没有 day.city（缺省回退 destination）时同样不生成。
    const noCity: TripDay[] = sameCity.map((day) => ({
      day: day.day,
      date: day.date,
      title: day.title,
      summary: day.summary,
      stops: day.stops,
      legs: day.legs,
    }))
    const fallback = rebuildIntercityLegs(noCity, '杭州')
    expect(fallback.every((day) => !day.legs.some((leg) => leg.transferKind === 'intercity'))).toBe(
      true,
    )

    const missingCoord: TripDay[] = [
      {
        day: 1,
        date: null,
        title: '',
        summary: '',
        city: '杭州',
        stops: [{ ...locatedStop('m1', 'A', point(120.0, 30.0)), location: null }],
        legs: [],
      },
      {
        day: 2,
        date: null,
        title: '',
        summary: '',
        city: '苏州',
        stops: [locatedStop('m2', 'B', point(120.6, 31.3))],
        legs: [],
      },
    ]
    const degraded = rebuildIntercityLegs(missingCoord, '杭州')
    const intercity = degraded[0].legs[degraded[0].legs.length - 1]
    expect(intercity.transferKind).toBe('intercity')
    expect(intercity.route_type).toBe('unavailable')
    expect(intercity.distance_m).toBeNull()
    expect(intercity.duration_minutes).toBeNull()
    expect(intercity.geometry).toEqual([])
  })

  it('地图刷新后城际段仍存在，距离与几何随刷新坐标更新', () => {
    const base = crossCityTrip()
    const built = buildMapRefreshRequest(base, 1, {
      travel_mode: 'walking',
      parentRevision: 4,
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const response = {
      day: 1,
      date: '2026-05-01',
      parent: { trip_id: base.id, revision: 4 },
      map_status: 'ready',
      stops: [
        { id: 'a1', location: point(120.1, 30.2), resolved_address: null },
        { id: 'a2', location: point(121.0, 31.0), resolved_address: null },
      ],
      unresolved: [],
      legs: [
        navLeg('a1', 'a2', {
          geometry: [point(120.1, 30.2), point(121.0, 31.0)],
        }),
      ],
      warnings: [],
    }
    expect(validateMapRefreshResponse(response, built.request).ok).toBe(true)

    const applied = applyMapRefresh({
      baseTrip: base,
      request: built.request,
      response,
      currentRevision: 4,
      forkTripId: 'trip-multicity-cross-map-fork',
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return

    const day1 = applied.trip.days[0]
    const transfer = day1.legs[day1.legs.length - 1]
    expect(transfer.transferKind).toBe('intercity')
    expect(transfer.from_stop_id).toBe('a2')
    expect(transfer.to_stop_id).toBe('b1')
    expect(transfer.geometry[0]).toEqual(point(121.0, 31.0))
    expect(transfer.geometry[1]).toEqual(point(120.6, 31.3))
    expect(transfer.distance_m).not.toBe(1)
    expect(transfer.distance_m as number).toBeGreaterThan(40_000)
    expect(day1.legs.filter((leg) => leg.transferKind === 'intercity')).toHaveLength(1)
  })
})

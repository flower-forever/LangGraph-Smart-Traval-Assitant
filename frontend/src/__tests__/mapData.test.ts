import { describe, expect, it } from 'vitest'
import { buildDayMapData } from '../lib/mapData'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD } from './fixtures/trip'

describe('buildDayMapData', () => {
  it('丢弃无坐标站点，保留合法坐标站点并保持顺序', () => {
    const data = buildDayMapData(MOCK_TRIP.days[0])
    expect(data.hasCoords).toBe(true)
    expect(data.stops.map((s) => s.stop.id)).toEqual(['s1', 's2'])
  })

  it('navigation 路段使用完整 geometry', () => {
    const data = buildDayMapData(MOCK_TRIP.days[0])
    const nav = data.legs.find((l) => l.routeType === 'navigation')
    expect(nav).toBeTruthy()
    expect(nav!.geometry).toHaveLength(3)
  })

  it('straight_line 路段只取两端点，端点无坐标时整段丢弃', () => {
    const day = {
      ...MOCK_TRIP.days[0],
      stops: [
        MOCK_TRIP.days[0].stops[0],
        { ...MOCK_TRIP.days[0].stops[1], location: { lng: 120.1501, lat: 30.2611 } },
      ],
      legs: [
        {
          from_stop_id: 's1',
          to_stop_id: 's2',
          mode: 'walking' as const,
          route_type: 'straight_line' as const,
          distance_m: 900,
          duration_minutes: 13,
          geometry: [],
          description: '',
        },
      ],
    }
    const data = buildDayMapData(day)
    const straight = data.legs.find((l) => l.routeType === 'straight_line')
    expect(straight).toBeTruthy()
    expect(straight!.geometry).toHaveLength(2)

    // 任一端点缺坐标 → 该路段不可画
    const broken = {
      ...day,
      legs: [{ ...day.legs[0], to_stop_id: 's3' }],
    }
    expect(buildDayMapData(broken).legs).toHaveLength(0)
  })

  it('unavailable 路段不产生图形', () => {
    const day = {
      ...MOCK_TRIP.days[0],
      legs: [
        {
          from_stop_id: 's1',
          to_stop_id: 's2',
          mode: 'walking' as const,
          route_type: 'unavailable' as const,
          distance_m: null,
          duration_minutes: null,
          geometry: [],
          description: '',
        },
      ],
    }
    const data = buildDayMapData(day)
    expect(data.legs).toHaveLength(0)
  })

  it('全部站点无坐标时 hasCoords 为 false', () => {
    const data = buildDayMapData(MOCK_TRIP_NO_COORD.days[0])
    expect(data.hasCoords).toBe(false)
    expect(data.stops).toHaveLength(0)
  })

  it('非法坐标值被过滤（越界 / 非数值）', () => {
    const day = {
      ...MOCK_TRIP.days[0],
      stops: [
        { ...MOCK_TRIP.days[0].stops[0], location: { lng: 999, lat: 30 } },
        { ...MOCK_TRIP.days[0].stops[1], location: { lng: Number.NaN, lat: 30 } },
      ],
    }
    const data = buildDayMapData(day)
    expect(data.hasCoords).toBe(false)
  })

  it('navigation 有效几何点不足 2 个时降级为示意直线', () => {
    const nav = MOCK_TRIP.days[0].legs[0]
    const day = {
      ...MOCK_TRIP.days[0],
      legs: [{ ...nav, geometry: [nav.geometry[0]] }],
    }
    const data = buildDayMapData(day)
    expect(data.legs).toHaveLength(1)
    expect(data.legs[0].routeType).toBe('straight_line')
    expect(data.legs[0].geometry).toHaveLength(2)
    expect(data.legs[0].geometry[0]).toEqual({ lng: 120.1576, lat: 30.2726 })
    expect(data.legs[0].geometry[1]).toEqual({ lng: 120.1522, lat: 30.2631 })
  })

  it('navigation 几何点全是非法值时同样降级，不冒充导航', () => {
    const nav = MOCK_TRIP.days[0].legs[0]
    const day = {
      ...MOCK_TRIP.days[0],
      legs: [{ ...nav, geometry: [{ lng: 999, lat: 30 }, { lng: Number.NaN, lat: 30 }] }],
    }
    expect(buildDayMapData(day).legs[0].routeType).toBe('straight_line')
  })

  it('空日不产生站点与路线', () => {
    const data = buildDayMapData(MOCK_TRIP.days[1])
    expect(data.stops).toHaveLength(0)
    expect(data.legs).toHaveLength(0)
    expect(data.hasCoords).toBe(false)
  })
})

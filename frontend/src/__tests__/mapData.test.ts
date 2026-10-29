import { describe, expect, it } from 'vitest'
import { buildDayMapData, groupStopsByLocation } from '../lib/mapData'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD, MOCK_TRIP_SAME_COORD } from './fixtures/trip'

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

describe('groupStopsByLocation', () => {
  it('相同坐标的站点归为一组，保留原序号、名称与坐标原值', () => {
    const data = buildDayMapData(MOCK_TRIP_SAME_COORD.days[0])
    const groups = groupStopsByLocation(data.stops)
    expect(groups).toHaveLength(2)
    // 每组内部保持站点顺序：早课在前、晚课在后
    const twin = groups.find((g) => g.length === 2)!
    expect(twin).toBeTruthy()
    expect(twin.map((s) => s.stop.id)).toEqual(['d1', 'd2'])
    // 原序号（全天序号）和真实坐标原值不能被改动
    expect(twin[0].index).toBe(0)
    expect(twin[1].index).toBe(1)
    expect(twin[0].stop.location).toEqual({ lng: 120.0972, lat: 30.2408 })
    expect(twin[1].stop.location).toEqual({ lng: 120.0972, lat: 30.2408 })
    expect(groups.find((g) => g.length === 1)![0].stop.id).toBe('d3')
  })

  it('每组的时间/名称各不相同，marker 不能只显示第一站', () => {
    const data = buildDayMapData(MOCK_TRIP_SAME_COORD.days[0])
    const groups = groupStopsByLocation(data.stops)
    const twin = groups.find((g) => g.length === 2)!
    expect(twin[0].stop.time).toBe('09:00')
    expect(twin[1].stop.time).toBe('17:00')
    expect(twin[0].stop.name).not.toBe(twin[1].stop.name)
  })

  it('坐标不同（哪怕很近）不合并：分组是字面相等，不做近似猜测', () => {
    const data = buildDayMapData(MOCK_TRIP.days[0])
    const groups = groupStopsByLocation(data.stops)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.length === 1)).toBe(true)
  })

  it('全部无坐标时返回空分组列表', () => {
    const data = buildDayMapData(MOCK_TRIP_NO_COORD.days[0])
    expect(groupStopsByLocation(data.stops)).toHaveLength(0)
  })
})

describe('缺坐标计数（DayMapData 扩展）', () => {
  it('部分缺坐标时报告缺失数量，与地图可用站点分开', () => {
    const data = buildDayMapData(MOCK_TRIP.days[0])
    expect(data.stops).toHaveLength(2)
    expect(data.missingCoordCount).toBe(1)
    expect(data.totalStopCount).toBe(3)
    expect(data.hasCoords).toBe(true)
  })

  it('全缺坐标时缺失数等于站点总数', () => {
    const day = MOCK_TRIP_NO_COORD.days[0]
    const data = buildDayMapData(day)
    expect(data.missingCoordCount).toBe(day.stops.length)
    expect(data.totalStopCount).toBe(day.stops.length)
    expect(data.hasCoords).toBe(false)
  })

  it('空日：站点总数为 0，与「有站点但全缺坐标」可区分', () => {
    const data = buildDayMapData(MOCK_TRIP.days[1])
    expect(data.totalStopCount).toBe(0)
    expect(data.missingCoordCount).toBe(0)
  })
})

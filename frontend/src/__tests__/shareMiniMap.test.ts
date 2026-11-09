/**
 * 五期 S5 · 路线小地图（纯 SVG）：
 * 确定性、三种路段样式、缺坐标分组、XML 转义、分享卡尾部组合块。
 * 全部离线，不依赖时钟 / 随机数 / 地图瓦片。
 */
import { describe, expect, it } from 'vitest'
import type { TripDay } from '../lib/api'
import { buildShareCardData, renderShareCard } from '../lib/shareCard'
import {
  appendMiniMapToShareCard,
  buildShareMiniMap,
} from '../lib/shareMiniMap'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD, MOCK_TRIP_SAME_COORD } from './fixtures/trip'

function cloneDay(): TripDay {
  return JSON.parse(JSON.stringify(MOCK_TRIP.days[0])) as TripDay
}

/** 三个站点都有坐标；三种 route_type 各一段。 */
function locatedDay(): TripDay {
  const day = cloneDay()
  day.stops[2].location = { lng: 120.1601, lat: 30.2579 }
  day.legs = [
    { ...day.legs[0], route_type: 'navigation' },
    { ...day.legs[1], route_type: 'straight_line' },
    {
      ...day.legs[0],
      from_stop_id: 's3',
      to_stop_id: 's1',
      route_type: 'unavailable',
    },
  ]
  return day
}

describe('buildShareMiniMap · 确定性', () => {
  it('同一输入两次输出逐字节相同', () => {
    const day = locatedDay()
    const first = buildShareMiniMap(day)
    const second = buildShareMiniMap(day)
    expect(first.svg).toBe(second.svg)
    expect(first.unknownStops).toEqual(second.unknownStops)
    expect(first.routeTypes).toEqual(second.routeTypes)
  })
})

describe('buildShareMiniMap · 三种路段样式', () => {
  it('navigation 实线、straight_line 虚线 + 示意、unavailable 不画线 + 路线未知', () => {
    const result = buildShareMiniMap(locatedDay())
    expect(result.svg).not.toBeNull()
    const svg = result.svg as string

    expect(svg).toContain('data-route="navigation"')
    expect(svg).toContain('stroke-width="3"')
    expect(svg).toContain('data-route="straight_line"')
    expect(svg).toContain('stroke-dasharray="8 6"')
    expect(svg).toContain('示意')
    expect(svg).toContain('路线未知：1 段')
    // unavailable 不产生任何线形
    expect(svg).not.toContain('data-route="unavailable"')
    expect(result.routeTypes).toEqual(['navigation', 'straight_line', 'unavailable'])
  })

  it('navigation 的 geometry 不足 2 个合法点时降级为示意直线，不冒充导航', () => {
    const day = locatedDay()
    day.legs[0] = { ...day.legs[0], geometry: [] }
    const result = buildShareMiniMap(day)
    expect(result.svg).toContain('data-route="straight_line"')
    expect(result.svg).not.toContain('data-route="navigation"')
    expect(result.routeTypes).toContain('straight_line')
  })
})

describe('buildShareMiniMap · 缺坐标与同坐标', () => {
  it('缺坐标站点不画点，按原顺序列进 unknownStops，并在 aria 中写明数量', () => {
    const result = buildShareMiniMap(MOCK_TRIP.days[0])
    expect(result.unknownStops).toEqual(['湖滨晴雨'])
    const svg = result.svg as string
    expect(svg).toContain('data-stop-index="1"')
    expect(svg).toContain('data-stop-index="2"')
    expect(svg).not.toContain('data-stop-index="3"')
    expect(svg).toContain('1 个位置未知')
  })

  it('整日无坐标返回 svg=null，绝不补 (0,0)', () => {
    const result = buildShareMiniMap(MOCK_TRIP_NO_COORD.days[0])
    expect(result.svg).toBeNull()
    expect(result.unknownStops).toEqual(['某无名站点'])
    expect(result.routeTypes).toEqual([])
  })

  it('同坐标多站各自保留编号圆点（不做近似合并）', () => {
    const result = buildShareMiniMap(MOCK_TRIP_SAME_COORD.days[0])
    const svg = result.svg as string
    expect((svg.match(/<circle /g) ?? []).length).toBe(3)
    expect(svg).toContain('data-stop-index="1"')
    expect(svg).toContain('data-stop-index="2"')
    expect(svg).toContain('data-stop-index="3"')
    expect(result.unknownStops).toEqual([])
  })
})

describe('buildShareMiniMap · XML 转义', () => {
  it('站名里的标签与引号被转义，不能闭合属性或注入 <script>', () => {
    const day = locatedDay()
    day.stops[0].name = '"><script>alert(1)</script>'
    const svg = buildShareMiniMap(day).svg as string
    expect(svg).not.toContain('<script')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('&quot;&gt;&lt;script&gt;')
  })
})

describe('appendMiniMapToShareCard · 统一尾部块', () => {
  it('固定 1080×1440，保留卡片内容并附加小地图与位置未知提示', () => {
    const day = locatedDay()
    const card = renderShareCard('xuanzhi', buildShareCardData(MOCK_TRIP, day))
    const map = buildShareMiniMap(day)
    const composed = appendMiniMapToShareCard(card, map)

    expect(composed).toContain('viewBox="0 0 1080 1440"')
    expect(composed).toContain('data-share-minimap="true"')
    expect(composed).toContain('data-route="navigation"')
    expect(composed).toContain('路线小地图')
    expect(composed).toContain('断桥残雪')
  })

  it('小地图无坐标时原样返回卡片 SVG', () => {
    const day = locatedDay()
    const card = renderShareCard('xuanzhi', buildShareCardData(MOCK_TRIP, day))
    const empty = buildShareMiniMap(MOCK_TRIP_NO_COORD.days[0])
    expect(appendMiniMapToShareCard(card, empty)).toBe(card)
  })
})

/**
 * 七期 S4 · TripMap 跨日视野（真实 Leaflet + jsdom）。
 *
 * 覆盖：两城 3+2 天、当前段 5 站合并；跨日站点点击走 onSelectStopInDay；
 * 当天站点仍走 onSelectStop；无切天回调时只弹 popup；别的天的选中不高亮；
 * 城际段虚线存在且 fitBounds 覆盖城际几何；segment=null 时 DOM 与旧单日一致。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import L from 'leaflet'

import TripMap from '../components/TripMap'
import { buildCityMapSegment } from '../lib/cityMap'
import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import { MOCK_TRIP } from './fixtures/trip'

function stop(id: string, name: string, lng: number, lat: number): TripStop {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: 60,
    description: `${name}的说明`,
    address: `${name}地址`,
    location: { lng, lat },
  }
}

function leg(from: string, to: string, patch: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'straight_line',
    distance_m: 900,
    duration_minutes: 12,
    geometry: [],
    description: '',
    ...patch,
  }
}

function day(dayNumber: number, city: string, stops: TripStop[], legs: TripLeg[] = []): TripDay {
  return { day: dayNumber, date: null, title: `第 ${dayNumber} 天`, summary: '', stops, legs, city }
}

const HANGZHOU_STOPS = {
  m1: stop('m1', '断桥残雪', 120.1576, 30.2726),
  m2: stop('m2', '平湖秋月', 120.1522, 30.2631),
  m3: stop('m3', '河坊街', 120.169, 30.242),
  m4: stop('m4', '钱塘江', 120.21, 30.21),
  m5: stop('m5', '宋城', 120.1, 30.17),
}
const SHANGHAI_STOPS = {
  s1: stop('s1', '外滩', 121.49, 31.24),
  s2: stop('s2', '南京路', 121.47, 31.23),
  s3: stop('s3', '豫园', 121.49, 31.22),
}

const INTERCITY_DESCRIPTION =
  '城际转移：杭州 → 上海，直线约 170.0 公里；按 90 公里/小时估算并预留 20 分钟，建议预留约 2 小时 13 分钟。具体班次与时刻未提供，请自行查询。'

const TRIP: Trip = {
  id: 'trip-multicity-map',
  source: 'agent',
  destination: '杭州',
  title: '杭州上海五日',
  summary: '',
  map_coordinate_system: 'WGS84',
  warnings: [],
  days: [
    day(1, '杭州', [HANGZHOU_STOPS.m1, HANGZHOU_STOPS.m2], [leg('m1', 'm2')]),
    day(2, '杭州', [HANGZHOU_STOPS.m3]),
    day(
      3,
      '杭州',
      [HANGZHOU_STOPS.m4, HANGZHOU_STOPS.m5],
      [
        leg('m4', 'm5'),
        leg('m5', 's1', {
          mode: 'driving',
          route_type: 'straight_line',
          distance_m: 170000,
          duration_minutes: 133,
          geometry: [
            { lng: HANGZHOU_STOPS.m5.location!.lng, lat: HANGZHOU_STOPS.m5.location!.lat },
            { lng: SHANGHAI_STOPS.s1.location!.lng, lat: SHANGHAI_STOPS.s1.location!.lat },
          ],
          description: INTERCITY_DESCRIPTION,
          transferKind: 'intercity',
        }),
      ],
    ),
    day(4, '上海', [SHANGHAI_STOPS.s1, SHANGHAI_STOPS.s2], [leg('s1', 's2')]),
    day(5, '上海', [SHANGHAI_STOPS.s3]),
  ],
}

const ACTIVE_DAY = TRIP.days[1]
const SEGMENT = buildCityMapSegment(TRIP, ACTIVE_DAY)

function markerEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.stop-dot-wrapper'))
}

function markerByStopName(name: string): HTMLElement {
  const el = markerEls().find((node) => node.getAttribute('aria-label')?.includes(name))
  if (!el) throw new Error(`找不到站点 marker：${name}`)
  return el
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

function renderSegment(onSelectStop = vi.fn(), onSelectStopInDay?: (day: number, stopId: string) => void) {
  return render(
    <TripMap
      day={ACTIVE_DAY}
      activeStopId={null}
      onSelectStop={onSelectStop}
      segment={SEGMENT}
      onSelectStopInDay={onSelectStopInDay}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TripMap 多城段 · 合并与城际虚线', () => {
  it('两城 3+2 天：当前段合并出 5 个站点', () => {
    expect(SEGMENT).not.toBeNull()
    renderSegment()
    expect(markerEls()).toHaveLength(5)
    expect(markerByStopName('断桥残雪')).toBeInTheDocument()
    expect(markerByStopName('宋城')).toBeInTheDocument()
    // 下一城（上海）不在当前段，不画
    expect(document.querySelector('.stop-dot-wrapper[aria-label*="外滩"]')).toBeNull()
  })

  it('城际段画虚线，fitBounds 覆盖城际几何端点（上海）', () => {
    const fitBoundsSpy = vi.spyOn(L.Map.prototype, 'fitBounds')
    renderSegment()

    const intercityPaths = Array.from(
      document.querySelectorAll<SVGPathElement>('path.poly-intercity'),
    )
    expect(intercityPaths).toHaveLength(1)
    expect(intercityPaths[0].getAttribute('stroke-dasharray')).toBe('6 6')

    expect(fitBoundsSpy).toHaveBeenCalled()
    const bounds = fitBoundsSpy.mock.calls[0][0] as L.LatLngBounds
    // 当前段站点都在杭州；上海端点只能来自城际几何
    expect(bounds.contains([SHANGHAI_STOPS.s1.location!.lat, SHANGHAI_STOPS.s1.location!.lng])).toBe(true)
  })
})

describe('TripMap 多城段 · 点击与高亮按天分流', () => {
  it('本天站点点击走 onSelectStop，别的天站点走 onSelectStopInDay(day, stopId)', () => {
    const onSelect = vi.fn()
    const onSelectInDay = vi.fn()
    renderSegment(onSelect, onSelectInDay)

    click(markerByStopName('河坊街'))
    expect(onSelect).toHaveBeenCalledWith('m3')
    expect(onSelectInDay).not.toHaveBeenCalled()

    onSelect.mockClear()
    click(markerByStopName('宋城'))
    expect(onSelect).not.toHaveBeenCalled()
    expect(onSelectInDay).toHaveBeenCalledWith(3, 'm5')
  })

  it('没有切天回调时只弹 popup，不把别的天 stopId 塞给当天', () => {
    const onSelect = vi.fn()
    renderSegment(onSelect)

    click(markerByStopName('宋城'))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '查看逐点讲解' })).toBeInTheDocument()
  })

  it('activeStopId 只在本天 marker 上高亮：别的天选中不高亮也不弹窗', () => {
    const { rerender } = render(
      <TripMap day={ACTIVE_DAY} activeStopId="m5" onSelectStop={vi.fn()} segment={SEGMENT} />,
    )
    expect(document.querySelectorAll('.stop-dot[data-active="true"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '查看逐点讲解' })).toBeNull()

    rerender(
      <TripMap day={ACTIVE_DAY} activeStopId="m3" onSelectStop={vi.fn()} segment={SEGMENT} />,
    )
    expect(document.querySelectorAll('.stop-dot[data-active="true"]')).toHaveLength(1)
    expect(markerByStopName('河坊街').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('TripMap 单城 · segment=null 保持旧单日 DOM', () => {
  it('不传 segment 与显式传 null 的容器 DOM 完全一致', () => {
    const day1 = MOCK_TRIP.days[0]
    const first = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const withoutProp = document.querySelector('.map-container')!.innerHTML
    first.unmount()

    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} segment={null} />)
    const withNull = document.querySelector('.map-container')!.innerHTML
    expect(withNull).toBe(withoutProp)
  })
})

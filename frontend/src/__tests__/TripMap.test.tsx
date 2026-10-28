/**
 * 真实 Leaflet + jsdom 回归：不 mock 地图组件，marker/popup 都走真实 Leaflet 事件。
 * jsdom 没有布局引擎，瓦片不会真的去加载（也不会发网络请求），所以瓦片状态用
 * 一个真实 Leaflet 图层替身来触发事件，验证「最后一个瓦片结束时结算」。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import L from 'leaflet'
import TripMap from '../components/TripMap'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD } from './fixtures/trip'

const day1 = MOCK_TRIP.days[0]
const emptyDay = MOCK_TRIP.days[1]
const noCoordDay = MOCK_TRIP_NO_COORD.days[0]

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

/** 用真实 Leaflet 图层替身截获瓦片事件（不访问网络） */
function stubTileLayer(): { fire: (type: string) => void } {
  const fakeTiles = L.layerGroup()
  vi.spyOn(L, 'tileLayer').mockReturnValue(fakeTiles as unknown as L.TileLayer)
  return { fire: (type: string) => fakeTiles.fire(type) }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TripMap（真实 Leaflet）', () => {
  it('marker 点击与弹窗按钮都发出同一站点选择', () => {
    const onSelect = vi.fn()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={onSelect} />)

    const marker = markerByStopName('断桥残雪')
    expect(marker.getAttribute('role')).toBe('button')
    expect(marker.getAttribute('aria-label')).toContain('断桥残雪')

    click(marker)
    expect(onSelect).toHaveBeenCalledWith('s1')

    const detailBtn = screen.getByRole('button', { name: '查看逐点讲解' })
    onSelect.mockClear()
    click(detailBtn)
    expect(onSelect).toHaveBeenCalledWith('s1')
  })

  it('外部选中站点时高亮并打开对应弹窗（互不重建）', () => {
    const { rerender } = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(document.querySelectorAll('.stop-dot[data-active="true"]')).toHaveLength(0)

    rerender(<TripMap day={day1} activeStopId="s1" onSelectStop={vi.fn()} />)

    const active = document.querySelectorAll('.stop-dot[data-active="true"]')
    expect(active).toHaveLength(1)
    expect(markerByStopName('断桥残雪').getAttribute('aria-pressed')).toBe('true')
    expect(markerByStopName('平湖秋月').getAttribute('aria-pressed')).toBe('false')
    // 列表 / 外部状态 → 地图弹窗联动
    expect(screen.getByRole('button', { name: '查看逐点讲解' })).toBeInTheDocument()
  })

  it('切换选中不重建图层、不重新 fitBounds（用户缩放不被重置）', () => {
    const fitBoundsSpy = vi.spyOn(L.Map.prototype, 'fitBounds')
    const clearLayersSpy = vi.spyOn(L.LayerGroup.prototype, 'clearLayers')

    const { rerender } = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(fitBoundsSpy).toHaveBeenCalledTimes(1)
    const clearsAfterMount = clearLayersSpy.mock.calls.length

    const onSelect = vi.fn()
    rerender(<TripMap day={day1} activeStopId="s2" onSelectStop={onSelect} />)
    rerender(<TripMap day={day1} activeStopId="s1" onSelectStop={onSelect} />)
    rerender(<TripMap day={day1} activeStopId={null} onSelectStop={onSelect} />)

    expect(clearLayersSpy.mock.calls.length).toBe(clearsAfterMount)
    expect(fitBoundsSpy).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('.stop-dot[data-active="true"]')).toHaveLength(0)
  })

  it('没有站点的一天不显示「缺少坐标」提示', () => {
    render(<TripMap day={emptyDay} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(screen.queryByText(/缺少坐标/)).toBeNull()
    expect(screen.queryByText(/均无坐标/)).toBeNull()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
  })

  it('有站点但都没有坐标时才显示坐标提示', () => {
    render(<TripMap day={noCoordDay} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(screen.getByText('这一天的站点缺少坐标')).toBeInTheDocument()
  })

  it('最后一个瓦片成功时也要结算出「部分失败」', () => {
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    act(() => {
      tiles.fire('tileloadstart')
      tiles.fire('tileloadstart')
      tiles.fire('tileloadstart')
      tiles.fire('tileerror')
      tiles.fire('tileload')
      tiles.fire('tileload')
    })
    expect(screen.getByText(/部分地图瓦片加载失败/)).toBeInTheDocument()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
  })

  it('全部瓦片失败时显示兜底提示，并说明文字行程不受影响', () => {
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    act(() => {
      tiles.fire('tileloadstart')
      tiles.fire('tileerror')
    })
    expect(screen.getByText('地图瓦片加载失败')).toBeInTheDocument()
    expect(screen.getByText(/文字行程仍可完整使用/)).toBeInTheDocument()
  })
})

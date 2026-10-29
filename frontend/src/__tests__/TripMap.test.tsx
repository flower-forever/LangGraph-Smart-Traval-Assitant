/**
 * 真实 Leaflet + jsdom 回归：不 mock 地图组件，marker/popup 都走真实 Leaflet 事件。
 * jsdom 没有布局引擎，瓦片不会真的去加载（也不会发网络请求），所以瓦片状态用
 * 一个真实 Leaflet 图层替身来触发事件，验证「最后一个瓦片结束时结算」。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import L from 'leaflet'
import TripMap from '../components/TripMap'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD, MOCK_TRIP_SAME_COORD } from './fixtures/trip'

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

type StubTileType = 'tileloadstart' | 'tileload' | 'tileerror' | 'tileunload' | 'tileabort'

interface StubTile {
  tile: HTMLImageElement
  coords: L.Coords
}

/**
 * 用真实 Leaflet 图层替身截获瓦片事件（不访问网络）。
 *
 * 事件负载必须和 GridLayer 一致：tile 是 <img> 元素，coords 是带 z 的 Point
 * （_addTile / _tileReady / _removeTile 都是这么发的）。只 fire 一个类型名，
 * 等于假设 Leaflet 事件不带瓦片身份，会把「按瓦片记账」的问题藏起来。
 */
function stubTileLayer(): {
  newTile: () => StubTile
  start: (t: StubTile) => void
  load: (t: StubTile) => void
  error: (t: StubTile) => void
  unload: (t: StubTile) => void
  abort: (t: StubTile) => void
} {
  const fakeTiles = L.layerGroup()
  vi.spyOn(L, 'tileLayer').mockReturnValue(fakeTiles as unknown as L.TileLayer)

  let seq = 0
  const newTile = (): StubTile => {
    const tile = document.createElement('img')
    // 和 Leaflet 的 _keyToTileCoords 一样：在 Point 上挂一个 z
    const coords = Object.assign(L.point(seq, 0), { z: 12 })
    seq += 1
    return { tile, coords }
  }

  const fire = (type: StubTileType, t: StubTile): void => {
    fakeTiles.fire(type, type === 'tileerror' ? { ...t, error: new Error('tile failed') } : t)
  }

  return {
    newTile,
    start: (t) => fire('tileloadstart', t),
    load: (t) => fire('tileload', t),
    error: (t) => fire('tileerror', t),
    unload: (t) => fire('tileunload', t),
    abort: (t) => fire('tileabort', t),
  }
}

/** 底图路线是否还在 DOM 里（SVG 渲染器在 jsdom 下可用的路径） */
function polylineCount(): number {
  return document.querySelectorAll('.leaflet-overlay-pane path').length
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
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

  it('有站点但都没有坐标时不再承诺「重新规划能得到路线」', () => {
    render(<TripMap day={noCoordDay} activeStopId={null} onSelectStop={vi.fn()} />)
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('重新规划')
    expect(text).not.toContain('换一天')
    expect(text).toContain('服务状态')
  })

  it('部分站点缺坐标时给出缺失数量说明，与全缺、空日区分', () => {
    render(<TripMap day={MOCK_TRIP.days[0]} activeStopId={null} onSelectStop={vi.fn()} />)
    // 第 1 天 3 站里 s3（湖滨晴雨）无坐标
    const text = document.body.textContent ?? ''
    expect(text).toContain('1 个没有解析到经纬度')
    expect(text).toContain('本日共 3 个站点')
    // 不出现全缺口径的大标题
    expect(screen.queryByText('这一天的站点缺少坐标')).toBeNull()
  })

  /* ───────── 同坐标站点分组 ───────── */

  it('同坐标的两站合成一个 marker，marker 上标明此处有 2 站', () => {
    render(<TripMap day={MOCK_TRIP_SAME_COORD.days[0]} activeStopId={null} onSelectStop={vi.fn()} />)
    const dots = document.querySelectorAll('.stop-dot')
    // 3 站 2 个坐标 → 2 个 marker；「早晚两次去灵隐寺」只画一个点
    expect(dots).toHaveLength(2)
    const twin = Array.from(dots).find((d) => d.textContent?.includes('2'))
    expect(twin).toBeTruthy()
    // 可访问名说明此处有两站
    const wrapper = twin!.closest('.stop-dot-wrapper') as HTMLElement
    const label = wrapper.getAttribute('aria-label') ?? ''
    expect(label).toContain('2 站')
    expect(label).toContain('早课·灵隐寺')
    expect(label).toContain('晚课·灵隐寺')
  })

  it('分组 marker 打开弹窗后，两站都能单独选择（循环切换）', () => {
    const onSelect = vi.fn()
    render(<TripMap day={MOCK_TRIP_SAME_COORD.days[0]} activeStopId={null} onSelectStop={onSelect} />)
    const dots = document.querySelectorAll('.stop-dot-wrapper')
    const twinWrapper = Array.from(dots).find(
      (d) => d.getAttribute('aria-label')?.includes('早课·灵隐寺'),
    ) as HTMLElement

    click(twinWrapper)
    // 弹窗出现，提供两站的独立入口
    const pick1 = screen.getByRole('button', { name: /早课·灵隐寺.*查看逐点讲解/ })
    const pick2 = screen.getByRole('button', { name: /晚课·灵隐寺.*查看逐点讲解/ })
    onSelect.mockClear()
    click(pick1)
    expect(onSelect).toHaveBeenCalledWith('d1')
    click(pick2)
    expect(onSelect).toHaveBeenCalledWith('d2')
  })

  it('单站坐标的 marker 不受分组影响：可访问名仍是单站描述', () => {
    render(<TripMap day={MOCK_TRIP_SAME_COORD.days[0]} activeStopId={null} onSelectStop={vi.fn()} />)
    const solo = Array.from(document.querySelectorAll('.stop-dot-wrapper')).find(
      (d) => d.getAttribute('aria-label')?.includes('飞来峰'),
    )
    expect(solo).toBeTruthy()
    expect(solo!.getAttribute('aria-label') ?? '').not.toContain('此处')
  })

  it('分组 marker 的高亮跟随组内选中的站：选中晚课时分组高亮且弹窗停留在该站', () => {
    const { rerender } = render(
      <TripMap day={MOCK_TRIP_SAME_COORD.days[0]} activeStopId="d1" onSelectStop={vi.fn()} />,
    )
    rerender(<TripMap day={MOCK_TRIP_SAME_COORD.days[0]} activeStopId="d2" onSelectStop={vi.fn()} />)
    const active = document.querySelectorAll('.stop-dot[data-active="true"]')
    expect(active).toHaveLength(1)
  })

  it('同坐标分组不改变真实坐标：路线端点（如有的话）原样使用原值', () => {
    // MOCK_TRIP 第 1 天 legs 端点是真实坐标，分组逻辑不能碰 geometry
    render(<TripMap day={MOCK_TRIP.days[0]} activeStopId={null} onSelectStop={vi.fn()} />)
    const paths = document.querySelectorAll('.leaflet-overlay-pane path')
    expect(paths.length).toBeGreaterThan(0)
  })

  it('最后一个瓦片成功时也要结算出「部分失败」', () => {
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()
    const b = tiles.newTile()
    const c = tiles.newTile()
    act(() => {
      tiles.start(a)
      tiles.start(b)
      tiles.start(c)
      tiles.error(a)
      tiles.load(b)
      tiles.load(c)
    })
    expect(screen.getByText(/部分瓦片加载失败/)).toBeInTheDocument()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
  })

  it('全部瓦片失败时显示兜底提示，并说明文字行程不受影响', () => {
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()
    act(() => {
      tiles.start(a)
      tiles.error(a)
    })
    expect(screen.getByText('地图瓦片加载失败')).toBeInTheDocument()
    expect(screen.getByText(/文字行程仍可完整使用/)).toBeInTheDocument()
  })

  it('只有 tileloadstart 时，8 秒内不提示，9 秒后说明底图超时且站点路线仍可看', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const beforeStart = vi.getTimerCount()
    const a = tiles.newTile()

    act(() => {
      tiles.start(a)
    })
    expect(vi.getTimerCount()).toBe(beforeStart + 1)

    act(() => {
      vi.advanceTimersByTime(8000)
    })
    expect(screen.queryByText(/底图加载超时/)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()
    expect(screen.getByText(/站点、路线和文字行程仍可查看/)).toBeInTheDocument()
    // 不能把「没等到瓦片」说成网络已断，也不能声称数据准确
    expect(screen.queryByText(/网络已断|断网/)).toBeNull()
    expect(screen.queryByText(/数据准确/)).toBeNull()
    // 只是角落条，不做全屏遮罩，站点和路线还能点
    expect(document.querySelector('.map-status')).toBeNull()
    expect(document.querySelector('.map-status-note')).not.toBeNull()
  })

  it('超时之后迟到的 tileload 会撤掉提示并恢复为正常', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()

    act(() => {
      tiles.start(a)
      vi.advanceTimersByTime(9000)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()

    act(() => {
      tiles.load(a)
    })
    expect(screen.queryByText(/底图加载超时/)).toBeNull()
    expect(screen.queryByText(/部分瓦片加载失败/)).toBeNull()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
  })

  it('卸载时清掉超时定时器，之后不再提示', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const beforeMount = vi.getTimerCount()
    const tiles = stubTileLayer()
    const { unmount } = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()

    act(() => {
      tiles.start(a)
    })
    unmount()

    expect(vi.getTimerCount()).toBe(beforeMount)
    act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(document.querySelector('.map-status-note')?.textContent ?? '').not.toContain('底图')
  })

  it('换天时重新计时，上一屏的超时提示不会带到新一天', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    const { rerender } = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()

    act(() => {
      tiles.start(a)
      vi.advanceTimersByTime(6000)
    })

    rerender(<TripMap day={emptyDay} activeStopId={null} onSelectStop={vi.fn()} />)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByText(/底图加载超时/)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()
  })

  it('已成功的瓦片被卸载后，另一个挂起的瓦片仍在 9 秒后给出超时结论', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()
    const b = tiles.newTile()

    act(() => {
      tiles.start(a)
      tiles.start(b)
      tiles.load(a)
      // 缩放/平移时 Leaflet 卸载已成功的旧瓦片，B 仍在途，不能被这一下清掉 pending
      tiles.unload(a)
    })

    act(() => {
      vi.advanceTimersByTime(8000)
    })
    expect(screen.queryByText(/底图加载超时/)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()
    // A 被卸载不是失败：不能顺手报「部分失败」或「全部失败」
    expect(screen.queryByText(/部分瓦片加载失败/)).toBeNull()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
    // 站点和路线不受底图状态影响
    expect(markerEls()).toHaveLength(2)
  })

  it('迟到的 B 成功后撤掉超时提示，站点与路线原样保留', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()
    const b = tiles.newTile()

    act(() => {
      tiles.start(a)
      tiles.start(b)
      tiles.load(a)
      tiles.unload(a)
    })
    act(() => {
      vi.advanceTimersByTime(9000)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()

    const markersBefore = markerEls().length
    const polylinesBefore = polylineCount()
    expect(markersBefore).toBe(2)
    expect(polylinesBefore).toBeGreaterThan(0)

    act(() => {
      tiles.load(b)
    })

    expect(screen.queryByText(/底图加载超时/)).toBeNull()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
    expect(markerEls()).toHaveLength(markersBefore)
    expect(markerByStopName('断桥残雪')).toBeInTheDocument()
    expect(polylineCount()).toBe(polylinesBefore)

    // 恢复之后不能再冒出超时
    act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(document.querySelector('.map-status-note')?.textContent ?? '').not.toContain('底图')
  })

  it('在途瓦片被 tileabort（换 zoom）取消后不误报超时', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()
    const b = tiles.newTile()

    act(() => {
      tiles.start(a)
      // TileLayer._abortLoading：换 zoom 时放弃在途瓦片，只发 tileabort
      tiles.abort(a)
      tiles.start(b)
      tiles.load(b)
    })

    act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(document.querySelector('.map-status-note')?.textContent ?? '').not.toContain('底图')
  })

  it('换 zoom 放弃旧瓦片后按新一批重新计时，不拿旧截止时间误报', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const oldTile = tiles.newTile()
    const baseline = vi.getTimerCount()

    act(() => {
      tiles.start(oldTile)
      vi.advanceTimersByTime(6000)
      // 换 zoom：Leaflet 放弃在途旧瓦片，只发 tileabort（不发 tileunload）
      tiles.abort(oldTile)
    })
    expect(vi.getTimerCount()).toBe(baseline)

    const fresh = tiles.newTile()
    act(() => {
      tiles.start(fresh)
    })

    // 距旧瓦片 start 已经 9 秒，但旧瓦片早已被放弃，新一批才过了 3 秒
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(screen.queryByText(/底图加载超时/)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(5999)
    })
    expect(screen.queryByText(/底图加载超时/)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()
    // 被放弃的旧瓦片不是失败，也不是全部失败
    expect(screen.queryByText(/部分瓦片加载失败/)).toBeNull()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
  })

  it('tileabort 只取消它指名的瓦片：重复 abort 与迟到的 load 不动另一个在途瓦片', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()
    const b = tiles.newTile()

    act(() => {
      tiles.start(a)
      tiles.start(b)
      tiles.abort(a)
      tiles.abort(a)
      // abort 之后浏览器补发的 load 不能反过来把它算成成功
      tiles.load(a)
    })

    act(() => {
      vi.advanceTimersByTime(8000)
    })
    expect(screen.queryByText(/底图加载超时/)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()
    expect(screen.queryByText(/部分瓦片加载失败/)).toBeNull()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
    expect(markerEls()).toHaveLength(2)
  })

  it('已经提示超时时换天：旧提示撤掉，从换天那一刻重新计时', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    const { rerender } = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()
    const baseline = vi.getTimerCount()

    act(() => {
      tiles.start(a)
      vi.advanceTimersByTime(9000)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(baseline)

    rerender(<TripMap day={emptyDay} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(screen.queryByText(/底图加载超时/)).toBeNull()
    expect(vi.getTimerCount()).toBe(baseline + 1)

    act(() => {
      vi.advanceTimersByTime(8999)
    })
    expect(screen.queryByText(/底图加载超时/)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()
  })

  it('超时状态下卸载组件：定时器与提示都不再出现', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const beforeMount = vi.getTimerCount()
    const tiles = stubTileLayer()
    const { unmount } = render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()

    act(() => {
      tiles.start(a)
      vi.advanceTimersByTime(9000)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()

    unmount()
    expect(vi.getTimerCount()).toBe(beforeMount)
    expect(document.querySelector('.map-status-note')?.textContent ?? '').not.toContain('底图')

    act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(document.querySelector('.map-status-note')?.textContent ?? '').not.toContain('底图')
  })

  // 旧实现把 loaded/failed 当成图层生命周期累计，一次失败会粘在界面上。下面几条用真实
  // <img> 身份 + 真实 Leaflet 事件语义，锁定「只描述此刻还挂在图上的瓦片」。
  it('旧失败瓦片被卸载后，新视野全部成功就不再显示历史错误', () => {
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const old = tiles.newTile()
    const stale = tiles.newTile()

    act(() => {
      tiles.start(old)
      tiles.start(stale)
      tiles.load(old)
      tiles.error(stale)
    })
    expect(screen.getByText(/部分瓦片加载失败/)).toBeInTheDocument()

    // 平移：失败那块出视野被 _removeTile 卸载，新视野的瓦片全部成功
    const fresh = tiles.newTile()
    act(() => {
      tiles.unload(stale)
      tiles.unload(old)
      tiles.start(fresh)
      tiles.load(fresh)
    })

    expect(screen.queryByText(/部分瓦片加载失败/)).toBeNull()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
    expect(document.querySelector('.map-status-note')?.textContent ?? '').not.toContain('底图')
    // 站点和路线不受底图状态影响
    expect(markerEls()).toHaveLength(2)
    expect(polylineCount()).toBeGreaterThan(0)
  })

  it('仍看得见的成功瓦片 + 平移只新请求的一片失败，只报部分失败', () => {
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const kept = tiles.newTile()

    act(() => {
      tiles.start(kept)
      tiles.load(kept)
    })
    expect(document.querySelector('.map-status-note')?.textContent ?? '').not.toContain('底图')

    const edge = tiles.newTile()
    act(() => {
      tiles.start(edge)
      tiles.error(edge)
    })

    expect(screen.getByText(/部分瓦片加载失败/)).toBeInTheDocument()
    // 一片失败不能升级成「整张底图失败」的兜底提示
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
    expect(document.querySelector('.map-status')).toBeNull()
  })

  it('卸载在途瓦片后迟到的 error 不会把历史失败重新点亮', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()

    act(() => {
      tiles.start(a)
      tiles.unload(a)
      // 卸载之后补发的 error 属于迟到事件，不能记成失败
      tiles.error(a)
    })

    act(() => {
      vi.advanceTimersByTime(20000)
    })
    expect(screen.queryByText(/部分瓦片加载失败/)).toBeNull()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
    expect(document.querySelector('.map-status-note')?.textContent ?? '').not.toContain('底图')
  })

  it('平移卸载已成功的瓦片不会把挂起瓦片的超时推后', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const done = tiles.newTile()
    const hung = tiles.newTile()

    act(() => {
      tiles.start(done)
      tiles.load(done)
    })
    act(() => {
      tiles.start(hung)
      vi.advanceTimersByTime(8000)
    })
    // 平移把已成功的旧瓦片卸掉：pending 没变，不该重新给 9 秒
    act(() => {
      tiles.unload(done)
    })

    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(screen.queryByText(/底图加载超时/)).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText(/底图加载超时/)).toBeInTheDocument()
  })

  it('tileabort 取消的瓦片即使补发 error 也不算失败', () => {
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const aborted = tiles.newTile()
    const ok = tiles.newTile()

    act(() => {
      tiles.start(aborted)
      tiles.abort(aborted)
      // _abortLoading 清掉 src 后浏览器仍可能补发 error
      tiles.error(aborted)
      tiles.start(ok)
      tiles.load(ok)
    })

    expect(screen.queryByText(/部分瓦片加载失败/)).toBeNull()
    expect(screen.queryByText('地图瓦片加载失败')).toBeNull()
    expect(document.querySelector('.map-status-note')?.textContent ?? '').not.toContain('底图')
    expect(markerEls()).toHaveLength(2)
  })

  // 事件层能证明的只是「图层上的瓦片」：include keepBuffer 在视野外预加载的两圈，
  // 口径比像素视窗大。文案不能把它说成「你看到的底图有洞」，也不能承诺平移就会重试
  // ——仍挂在图层上的失败瓦片不会被重新请求。
  it('部分失败的提示如实说明范围含视野外瓦片，且不承诺平移就能重试', () => {
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const ok = tiles.newTile()
    const bad = tiles.newTile()

    act(() => {
      tiles.start(ok)
      tiles.load(ok)
      tiles.start(bad)
      tiles.error(bad)
    })

    const note = document.querySelector('.map-status-note')
    expect(note).not.toBeNull()
    const text = note!.textContent ?? ''
    // 说清范围：缓冲区里看不见的瓦片也算在内，视野可能根本看不出缺口
    expect(text).toContain('部分瓦片加载失败')
    expect(text).toContain('视野外')
    expect(text).toContain('看不见')
    // 旧文案的过度承诺不能回来
    expect(text).not.toContain('当前底图上有部分')
    expect(text).not.toContain('平移或缩放会再次尝试加载')
    // 给出真的能生效的重试方式
    expect(text).toContain('缩放地图')
    expect(text).toContain('移出视野再移回')
    expect(text).toContain('站点与路线不受影响')
    // 只是角落条，站点和路线仍可点
    expect(document.querySelector('.map-status')).toBeNull()
    expect(markerEls()).toHaveLength(2)
  })

  it('超时提示不把「没等到瓦片」说成断网，也不承诺平移会重试', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const tiles = stubTileLayer()
    render(<TripMap day={day1} activeStopId={null} onSelectStop={vi.fn()} />)
    const a = tiles.newTile()

    act(() => {
      tiles.start(a)
      vi.advanceTimersByTime(9000)
    })

    const note = document.querySelector('.map-status-note')
    expect(note).not.toBeNull()
    const text = note!.textContent ?? ''
    expect(text).toContain('底图加载超时')
    expect(text).toContain('不一定是网络问题')
    expect(text).toContain('缩放地图会重新请求瓦片')
    expect(text).not.toContain('平移或缩放')
    expect(text).toContain('站点、路线和文字行程仍可查看')
    expect(markerEls()).toHaveLength(2)
  })
})

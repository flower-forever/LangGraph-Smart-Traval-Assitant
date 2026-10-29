import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { TripDay, TripStop } from '../lib/api'
import { buildDayMapData, type DayMapData } from '../lib/mapData'
import { osmSearchUrl, displayTime } from '../lib/format'
import { createTileWatch, type TileState, type TileWatch } from '../lib/tileStatus'

interface TripMapProps {
  day: TripDay
  activeStopId: string | null
  onSelectStop: (stopId: string) => void
}

/** 用 divIcon 圆点替代默认 marker，避免默认图钉资源加载问题 */
function makeStopIcon(index: number, active: boolean, hasCoord: boolean): L.DivIcon {
  return L.divIcon({
    className: 'stop-dot-wrapper',
    html: `<span class="stop-dot" data-active="${active}" data-nocoord="${!hasCoord}">${index + 1}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -12],
  })
}

/** divIcon 没有原生 alt，只能手动补可访问名与选中状态；setIcon 会重建节点，所以每次都要重设 */
function decorateMarker(marker: L.Marker, index: number, stop: TripStop, active: boolean): void {
  const el = marker.getElement()
  if (!el) return
  el.setAttribute('role', 'button')
  el.setAttribute('aria-pressed', active ? 'true' : 'false')
  el.setAttribute('aria-label', `站点 ${index + 1}：${stop.name}${active ? '（当前选中）' : ''}，按回车查看讲解`)
}

function buildPopupEl(stop: TripStop, index: number, onSelectStop: (id: string) => void, onClose: () => void): HTMLElement {
  const wrap = document.createElement('div')
  const title = document.createElement('b')
  title.textContent = `${index + 1}. ${stop.name}`
  wrap.appendChild(title)

  const meta = document.createElement('div')
  meta.className = 'pop-meta'
  meta.textContent = [displayTime(stop.time), stop.address].filter(Boolean).join(' · ')
  if (meta.textContent) wrap.appendChild(meta)

  if (stop.description) {
    const desc = document.createElement('div')
    desc.className = 'pop-desc'
    desc.textContent = stop.description
    wrap.appendChild(desc)
  }

  const row = document.createElement('div')
  const more = document.createElement('a')
  more.className = 'pop-more'
  more.href = osmSearchUrl(stop)
  more.target = '_blank'
  more.rel = 'noopener noreferrer'
  more.textContent = '在 OpenStreetMap 中查看'
  row.appendChild(more)

  const detailBtn = document.createElement('button')
  detailBtn.type = 'button'
  detailBtn.className = 'pop-more'
  detailBtn.textContent = '查看逐点讲解'
  detailBtn.addEventListener('click', () => {
    onSelectStop(stop.id)
    onClose()
  })
  row.appendChild(detailBtn)
  wrap.appendChild(row)
  return wrap
}

export default function TripMap({ day, activeStopId, onSelectStop }: TripMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())
  const popupsRef = useRef<Map<string, L.Popup>>(new Map())
  const onSelectRef = useRef(onSelectStop)
  const tileWatchRef = useRef<TileWatch | null>(null)
  const [tileState, setTileState] = useState<TileState>('loading')

  const data: DayMapData = useMemo(() => buildDayMapData(day), [day])
  const activeIsOnMap = useMemo(
    () => data.stops.some((s) => s.stop.id === activeStopId),
    [data, activeStopId],
  )

  // 回调走 ref：父组件回调身份变化不该触发图层重建
  useEffect(() => {
    onSelectRef.current = onSelectStop
  }, [onSelectStop])

  // 初始化地图（一次）
  useEffect(() => {
    if (!containerRef.current) return
    const map = L.map(containerRef.current, {
      center: [35.0, 110.0],
      zoom: 5,
      scrollWheelZoom: true,
      zoomControl: true,
      attributionControl: true,
    })
    mapRef.current = map
    layerRef.current = L.layerGroup().addTo(map)

    setTileState('loading')
    // 瓦片状态由 watchdog 统一结算：只有 start、始终等不到 load/error 时也要给出结论
    const watch = createTileWatch(setTileState)
    tileWatchRef.current = watch

    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 贡献者',
    })
    // 每个事件都把瓦片身份（TileEvent.tile + coords）转给 watchdog：
    // 只有仍在途的那一个瓦片第一次给出结果才记账，重复或迟到的同瓦片事件不会
    // 把别的在途瓦片的 pending 扣掉。
    tiles.on('tileloadstart', (e) => watch.handleStart(e))
    tiles.on('tileload', (e) => watch.handleSettled('load', e))
    tiles.on('tileerror', (e) => watch.handleSettled('error', e))
    // 缩放/平移会卸载旧瓦片：已成功的那些只是常规清理，不能拿来扣在途计数
    tiles.on('tileunload', (e) => watch.handleUnload(e))
    // 换 zoom 时 Leaflet 会 abort 在途瓦片，只发 tileabort 不发 tileunload；
    // 不跟着取消，这些瓦片会一直挂着，等它们的 9 秒预算到了就误报超时
    tiles.on('tileabort', (e) => watch.handleAbort(e))
    // 底图层被移除后不再结算，避免卸载之后还回调
    tiles.on('remove', () => watch.dispose())
    tiles.addTo(map)

    return () => {
      watch.dispose()
      if (tileWatchRef.current === watch) tileWatchRef.current = null
      map.remove()
      mapRef.current = null
      layerRef.current = null
      markersRef.current.clear()
      popupsRef.current.clear()
    }
  }, [])

  // 数据变化：重建图层并适配视野（只有换日/换行程才走这里）
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return

    // 换天 / 重新适配视野：作废上一屏的超时计时；还有在途瓦片就从现在重新计时
    tileWatchRef.current?.resetForViewChange()

    layer.clearLayers()
    markersRef.current.clear()
    popupsRef.current.clear()

    // 路线：先画线再画点，点在上层
    for (const leg of data.legs) {
      const latlngs = leg.geometry.map((p) => [p.lat, p.lng] as [number, number])
      const isNav = leg.routeType === 'navigation'
      const line = L.polyline(latlngs, {
        className: isNav ? 'poly-nav' : 'poly-straight',
        weight: isNav ? 4 : 3,
        opacity: isNav ? 0.9 : 0.85,
        dashArray: isNav ? undefined : '8 8',
        lineCap: 'round',
      })
      line.bindTooltip(
        isNav ? '地图服务路线' : '示意直线（两点直连，非真实导航）',
        { sticky: true, direction: 'top', className: 'poly-tip' },
      )
      layer.addLayer(line)
    }

    for (const { stop, index } of data.stops) {
      const loc = stop.location!
      const marker = L.marker([loc.lat, loc.lng], {
        icon: makeStopIcon(index, false, true),
        title: stop.name,
        keyboard: true,
        alt: `站点 ${index + 1}：${stop.name}`,
      })
      const popup = L.popup({ maxWidth: 280, autoPan: true })
      popup.setContent(buildPopupEl(stop, index, (id) => onSelectRef.current(id), () => marker.closePopup()))
      marker.bindPopup(popup)
      // 地图点击只上报选中；选中状态由父组件幂等处理，重复触发不会被抵消
      marker.on('click', () => onSelectRef.current(stop.id))
      layer.addLayer(marker)
      markersRef.current.set(stop.id, marker)
      popupsRef.current.set(stop.id, popup)
      decorateMarker(marker, index, stop, false)
    }

    // 容器刚挂载时尺寸可能为 0，先同步一次尺寸再适配视野
    map.invalidateSize()
    if (data.stops.length > 0) {
      const bounds = L.latLngBounds(data.stops.map((s) => [s.stop.location!.lat, s.stop.location!.lng] as [number, number]))
      for (const leg of data.legs) {
        bounds.extend(L.latLngBounds(leg.geometry.map((p) => [p.lat, p.lng] as [number, number])))
      }
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 })
    }
    // 选中态只影响高亮，不参与建层；下面单独一个 effect 处理，避免选中就重置用户缩放
  }, [data])

  // 选中站点变化：只换单个 marker 的图标 + 平移，不清图层、不重算视野
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    for (const { stop, index } of data.stops) {
      const marker = markersRef.current.get(stop.id)
      if (!marker) continue
      const active = stop.id === activeStopId
      marker.setIcon(makeStopIcon(index, active, true))
      decorateMarker(marker, index, stop, active)
    }
    if (!activeStopId || !activeIsOnMap) {
      map.closePopup()
      return
    }
    const marker = markersRef.current.get(activeStopId)
    if (!marker) return
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 13), { duration: 0.6 })
    marker.openPopup()
  }, [activeStopId, activeIsOnMap, data])

  // 没有站点（空日）不能说「站点均无坐标」；有站点但一个坐标都没有才算缺坐标
  const hasStops = day.stops.length > 0
  const missingCoords = hasStops && data.stops.length === 0
  const status = missingCoords
    ? {
        big: '这一天的站点缺少坐标',
        desc: '后端未能解析出本日站点的经纬度，文字行程照常可用。换一天或重新规划可能得到带坐标的路线。',
      }
    : tileState === 'failed'
      ? {
          big: '地图瓦片加载失败',
          desc: '请检查网络连接。下方的文字行程仍可完整使用，站点坐标未受影响。',
        }
      : null

  return (
    <section className="map-card" aria-label={`${day.title} 地图`}>
      <div className="map-title-bar">
        <h3 className="map-title">当日路线地图</h3>
        <span className="text-note">WGS84 · 底图 © OpenStreetMap 贡献者</span>
      </div>
      <div className="map-frame">
        <div ref={containerRef} className="map-container" role="application" aria-label="交互式地图" />
        {status && (
          <div className="map-status" role="status">
            <span className="big">{status.big}</span>
            <span>{status.desc}</span>
          </div>
        )}
        {!status && tileState === 'partial' && (
          <p className="map-status-note" role="status">
            部分地图瓦片加载失败，底图可能不完整；站点与路线不受影响。
          </p>
        )}
        {!status && tileState === 'stalled' && (
          <p className="map-status-note" role="status">
            底图加载超时，底图可能暂时不可用；站点、路线和文字行程仍可查看。平移或缩放地图会再次尝试加载。
          </p>
        )}
      </div>
      <div className="map-legend" aria-label="地图图例">
        <span className="legend-item"><i className="legend-swatch" data-kind="nav" /> 地图服务路线</span>
        <span className="legend-item"><i className="legend-swatch" data-kind="straight" /> 示意直线（非导航）</span>
        <span className="legend-item"><i className="legend-swatch" data-kind="stop" /> 站点</span>
        <span className="legend-item"><i className="legend-swatch" data-kind="stop-active" /> 当前选中</span>
      </div>
    </section>
  )
}

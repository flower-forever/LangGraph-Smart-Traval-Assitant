import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { TripDay } from '../lib/api'
import { buildDayMapData, groupStopsByLocation, type DayMapData, type StopRef } from '../lib/mapData'
import { osmSearchUrl, displayTime } from '../lib/format'
import { createTileWatch, type TileState, type TileWatch } from '../lib/tileStatus'

interface TripMapProps {
  day: TripDay
  activeStopId: string | null
  onSelectStop: (stopId: string) => void
}

/** 用 divIcon 圆点替代默认 marker，避免默认图钉资源加载问题 */
function makeStopIcon(index: number, active: boolean, hasCoord: boolean, groupSize = 1): L.DivIcon {
  // 同坐标分组时圆点里放组内站数（2/3/…），单站仍显示全天序号
  const label = groupSize > 1 ? String(groupSize) : String(index + 1)
  return L.divIcon({
    className: 'stop-dot-wrapper',
    html: `<span class="stop-dot" data-active="${active}" data-nocoord="${!hasCoord}" data-group="${groupSize > 1}">${label}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -12],
  })
}

/** divIcon 没有原生 alt，只能手动补可访问名与选中状态；setIcon 会重建节点，所以每次都要重设 */
function markerAriaLabel(refs: StopRef[], active: boolean): string {
  const first = refs[0]
  if (refs.length === 1) {
    return `站点 ${first.index + 1}：${first.stop.name}${active ? '（当前选中）' : ''}，按回车查看讲解`
  }
  const names = refs.map((r) => `${r.index + 1}. ${r.stop.name}`).join('、')
  return `此处 ${refs.length} 站（坐标相同）：${names}${active ? '（当前选中）' : ''}，按回车查看各站讲解`
}

function decorateMarker(marker: L.Marker, refs: StopRef[], active: boolean): void {
  const el = marker.getElement()
  if (!el) return
  el.setAttribute('role', 'button')
  el.setAttribute('aria-pressed', active ? 'true' : 'false')
  el.setAttribute('aria-label', markerAriaLabel(refs, active))
}

function buildPopupEl(refs: StopRef[], onSelectStop: (id: string) => void, onClose: () => void): HTMLElement {
  const wrap = document.createElement('div')
  if (refs.length === 1) {
    // 单站：沿用原弹窗结构
    const stop = refs[0].stop
    const index = refs[0].index
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

  // 同坐标多站：标题说明此处有几站，下面逐站列出可访问入口
  const title = document.createElement('b')
  title.textContent = `此处 ${refs.length} 站（坐标相同）`
  wrap.appendChild(title)

  const meta = document.createElement('div')
  meta.className = 'pop-meta'
  meta.textContent = '这几个站点解析到同一个坐标，点击任意一站查看讲解；站点本身按行程顺序排列。'
  wrap.appendChild(meta)

  for (const ref of refs) {
    const row = document.createElement('div')
    row.className = 'pop-stop-row'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'pop-more pop-stop-btn'
    btn.textContent = `${ref.index + 1}. ${ref.stop.name}（${displayTime(ref.stop.time)}）查看逐点讲解`
    btn.addEventListener('click', () => {
      onSelectStop(ref.stop.id)
      onClose()
    })
    row.appendChild(btn)
    wrap.appendChild(row)
  }
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
  /** 同坐标分组：一组对应一个 marker；组内是可单独访问的各站 */
  const groups: StopRef[][] = useMemo(() => groupStopsByLocation(data.stops), [data])
  /** 组内任一站被选中，就视为这个 marker 选中 */
  const activeGroupId = useMemo(() => {
    if (!activeStopId) return null
    const idx = groups.findIndex((g) => g.some((s) => s.stop.id === activeStopId))
    return idx >= 0 ? idx : null
  }, [groups, activeStopId])
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
    // 每个事件都把瓦片身份（TileEvent.tile + coords）转给 watchdog：状态只算「此刻
    // 还挂在图层上的瓦片」。load/error 只结算那张仍在途的瓦片，重复或迟到的事件不会
    // 把别人的 pending 扣掉；unload/abort 让这张瓦片整条离场，历史失败不会粘在界面上。
    tiles.on('tileloadstart', (e) => watch.handleStart(e))
    tiles.on('tileload', (e) => watch.handleSettled('load', e))
    tiles.on('tileerror', (e) => watch.handleSettled('error', e))
    // 缩放/平移会卸载旧瓦片（_removeTile）：离场即撤账，已成功的不算失败也不扣别人的
    // pending；已失败的不再计入当前底图状态
    tiles.on('tileunload', (e) => watch.handleUnload(e))
    // 换 zoom 时 Leaflet 调 _abortLoading 放弃在途瓦片，只发 tileabort 不发 tileunload；
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

    for (const refs of groups) {
      const loc = refs[0].stop.location!
      const marker = L.marker([loc.lat, loc.lng], {
        icon: makeStopIcon(refs[0].index, false, true, refs.length),
        title: refs.length === 1 ? refs[0].stop.name : `此处 ${refs.length} 站：${refs.map((r) => r.stop.name).join('、')}`,
        keyboard: true,
        alt: markerAriaLabel(refs, false),
      })
      const popup = L.popup({ maxWidth: 280, autoPan: true })
      popup.setContent(buildPopupEl(refs, (id) => onSelectRef.current(id), () => marker.closePopup()))
      marker.bindPopup(popup)
      // 地图点击只上报选中；选中状态由父组件幂等处理，重复触发不会被抵消
      marker.on('click', () => onSelectRef.current(refs[0].stop.id))
      layer.addLayer(marker)
      markersRef.current.set(refs[0].stop.id, marker)
      popupsRef.current.set(refs[0].stop.id, popup)
      decorateMarker(marker, refs, false)
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
    for (const [groupIndex, refs] of groups.entries()) {
      const marker = markersRef.current.get(refs[0].stop.id)
      if (!marker) continue
      const active = groupIndex === activeGroupId
      marker.setIcon(makeStopIcon(refs[0].index, active, true, refs.length))
      decorateMarker(marker, refs, active)
    }
    if (!activeStopId || !activeIsOnMap) {
      map.closePopup()
      return
    }
    // 选中组内哪一站，弹窗就指向哪一站的说明（marker 只有一个，弹窗内容含全组入口）
    const owningGroup = groups.find((g) => g.some((s) => s.stop.id === activeStopId))
    const marker = owningGroup ? markersRef.current.get(owningGroup[0].stop.id) : undefined
    if (!marker) return
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 13), { duration: 0.6 })
    marker.openPopup()
  }, [activeStopId, activeGroupId, activeIsOnMap, groups])

  // 没有站点（空日）不能说「站点均无坐标」；有站点但一个坐标都没有才算缺坐标
  const hasStops = day.stops.length > 0
  const allMissing = hasStops && data.stops.length === 0
  const someMissing = hasStops && data.stops.length > 0 && data.missingCoordCount > 0
  /**
   * 空态文案分情形说，且都不承诺「重新规划就能拿到坐标」：
   * - 全部缺坐标：全幅说明，原因前端看不到，措辞保持中性——本地新增站点、导入文件
   *   都没有请求过定位，不能说成「后端解析失败」；
   * - 个别站点缺坐标：角落提示缺了几个，地图本身仍可用；
   * - 底图瓦片失败/超时：与站点坐标是两回事，分开表述。
   */
  const status = allMissing
    ? {
        big: '这一天的站点缺少坐标',
        desc: '当前数据里没有这一天的可绘制坐标：可能尚未定位，也可能定位没有成功，原因前端无法确认（本地编辑新增的站点、导入文件里的站点都不会自动请求定位；其他站点取决于当时服务的地图配置）。文字行程照常可用。',
      }
    : tileState === 'failed'
      ? {
          // 只在地图上每一张瓦片都失败时才走到这里：不能把「一片失败」说成整体断网
          big: '地图瓦片加载失败',
          // 事件层只能证明「没拿到瓦片」，证明不了原因，所以不能直接断定是网络断了
          desc: '此刻挂在底图上的瓦片没有一张加载成功，可能是网络、代理或图源暂时不可用；缩放地图会重新请求瓦片。下方的文字行程仍可完整使用，站点坐标未受影响。',
        }
      : null

  // 角落提示条（不拦交互）：站点坐标缺失与瓦片异常是两类问题，分开两条、各自成段。
  // 瓦片异常保留 role=status（状态会随缩放消失）；缺坐标是当日数据事实，不占 live region，
  // 避免常驻提示和头部状态播报撞车。
  const tileNote =
    tileState === 'partial'
      ? // 状态的口径是「挂在图层上的瓦片」，含 keepBuffer 在视野外预加载的那几圈，
        // 不是像素视窗，所以不能说成「你看到的底图有洞」；也不能承诺平移就会重试——
        // 仍挂在图层上的失败瓦片不会被重新请求，得先移出缓冲区或换 zoom 重建。
        '底图上有部分瓦片加载失败（含视野外预加载、当前看不见的瓦片），你看到的部分可能看不出缺口。缩放地图，或把该区域移出视野再移回，才会重新请求这些瓦片；站点与路线不受影响。'
      : tileState === 'stalled'
        ? '底图加载超时：有瓦片一直没返回结果，这不一定是网络问题，底图可能暂时不完整。缩放地图会重新请求瓦片；站点、路线和文字行程仍可查看。'
        : null
  const coordNote =
    someMissing
      ? `本日共 ${data.totalStopCount} 个站点，其中 ${data.missingCoordCount} 个没有解析到经纬度，未画在图上；缺少的站点在下方文字行程里仍可查看。`
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
        {!status && tileNote && (
          <p className="map-status-note" role="status">{tileNote}</p>
        )}
        {!status && coordNote && (
          <p className="map-status-note map-note-coord">{coordNote}</p>
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

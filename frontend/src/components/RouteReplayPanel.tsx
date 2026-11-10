/**
 * S7 · 路线回放面板（计划 §8.2）。
 *
 * 边界：
 * - **零写入**：不读/写 localStorage、不碰行程与草稿；回放只是视图状态。
 * - **不自动改行程**：所有控制只影响本面板的播放进度。
 * - **缺数据诚实降级**：无坐标站不画点、地图不移动，卡片写「位置未知」；
 *   straight_line 画虚线并标「示意直线」；unavailable / 无 leg 不画线并标
 *   「路线未知 / 未提供本段路线信息」；无时间、无停留写「未知」。
 * - **性能**：单段折线最多 96 点，rAF 逐帧只更新当前段 latlngs，不重建图层。
 * - **prefers-reduced-motion**：跳过路线动画，改为逐站翻页（仍可手动上一站/下一站）。
 * - **电影模式**：隐藏页头与侧栏，只留地图 + 当前站卡 + 控制条；Esc 退出电影模式，
 *   非电影模式下 Esc 关闭面板。
 *
 * 入口挂载在 App.tsx，由 PM 接线（见交付报告）。
 */
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import type { TripDay } from '../lib/api'
import { MODE_LABELS, formatDistance, formatDuration } from '../lib/format'
import {
  EMPTY_REPLAY_PLAN,
  INITIAL_REPLAY_STATE,
  buildReplayDay,
  reduceReplay,
  replayRouteLabel,
  replayStayLabel,
  replayTimeLabel,
  sliceGeometry,
  type ReplayAction,
  type ReplayDayPlan,
  type ReplayStation,
} from '../lib/routeReplay'
import { cn } from '../lib/utils'
import { useDialogFocus } from '../lib/useDialogFocus'
import { useReducedMotion } from '../lib/useReducedMotion'

export interface RouteReplayPanelProps {
  /** 行程的全部天；回放按天切换。 */
  days: readonly TripDay[]
  /** 打开时选中的天（按 day.day 匹配；匹配不到用第 1 天）。 */
  initialDay: number
  onClose: () => void
  /** 测试 / 预览覆盖；默认跟随系统 prefers-reduced-motion。 */
  reducedMotion?: boolean
}

const BTN =
  'min-h-11 cursor-pointer rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-3 text-sm hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50'
const SPEED_BTN =
  'min-h-9 cursor-pointer rounded-[6px] border border-border bg-background px-2.5 text-xs hover:bg-secondary aria-[pressed=true]:border-[color:var(--color-primary)] aria-[pressed=true]:bg-accent-surface aria-[pressed=true]:text-[color:var(--color-accent-foreground)]'
const MUTED = 'text-xs text-[color:var(--color-faint)]'

function replayIcon(index: number, active: boolean): L.DivIcon {
  return L.divIcon({
    className: 'stop-dot-wrapper',
    html: `<span class="stop-dot" data-active="${active}" data-nocoord="false" data-group="false">${index + 1}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })
}

function nextLegSummary(next: ReplayStation): string {
  if (!next.location) return '下一站位置未知，无法绘制路线'
  const leg = next.inbound
  if (!leg) return '未提供下一段路线信息'
  if (leg.kind === 'unavailable') return replayRouteLabel(leg)
  const mode = leg.mode ? MODE_LABELS[leg.mode] : '方式未知'
  const distance = leg.distanceMeters != null ? ` · ${formatDistance(leg.distanceMeters)}` : ''
  const duration = leg.durationMinutes != null ? ` · ${formatDuration(leg.durationMinutes)}` : ' · 时长未知'
  return `${mode} · ${replayRouteLabel(leg)}${distance}${duration}`
}

export default function RouteReplayPanel({
  days,
  initialDay,
  onClose,
  reducedMotion: reducedMotionOverride,
}: RouteReplayPanelProps) {
  const titleId = useId()
  const mapElRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const markerRefs = useRef<Map<number, L.Marker>>(new Map())
  const lineRefs = useRef<Array<L.Polyline | null>>([])

  const initialIndex = Math.max(
    0,
    days.findIndex((day) => day.day === initialDay),
  )
  const [dayIndex, setDayIndex] = useState(initialIndex)
  const safeDayIndex = Math.min(dayIndex, Math.max(0, days.length - 1))
  const day = days[safeDayIndex] ?? null
  const plan: ReplayDayPlan = useMemo(() => (day ? buildReplayDay(day) : EMPTY_REPLAY_PLAN), [day])

  const systemReducedMotion = useReducedMotion()
  const reducedMotion = reducedMotionOverride ?? systemReducedMotion

  const reducer = useCallback(
    (state: typeof INITIAL_REPLAY_STATE, action: ReplayAction) =>
      reduceReplay(state, action, {
        stationCount: plan.stations.length,
        legKinds: plan.stations.map((station) => station.inbound?.kind ?? 'unavailable'),
        reducedMotion,
      }),
    [plan, reducedMotion],
  )
  const [state, dispatch] = useReducer(reducer, INITIAL_REPLAY_STATE)

  const [cinema, setCinema] = useState(false)

  const dialogRef = useDialogFocus<HTMLDivElement>({
    onEscape: () => {
      if (cinema) setCinema(false)
      else onClose()
    },
  })

  /* ── 地图：只初始化一次；图层随 plan 重建 ── */
  useEffect(() => {
    const element = mapElRef.current
    if (!element) return
    const map = L.map(element, {
      center: [35, 110],
      zoom: 5,
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: true,
    })
    mapRef.current = map
    layerRef.current = L.layerGroup().addTo(map)
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 贡献者',
    })
    tiles.addTo(map)

    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
      markerRefs.current.clear()
      lineRefs.current = []
    }
  }, [])

  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.clearLayers()
    markerRefs.current.clear()

    for (const station of plan.stations) {
      if (!station.location) continue
      const marker = L.marker([station.location.lat, station.location.lng], {
        icon: replayIcon(station.index, false),
        keyboard: false,
        title: `${station.index + 1}. ${station.stop.name}`,
      })
      marker.addTo(layer)
      markerRefs.current.set(station.index, marker)
    }

    const lines: Array<L.Polyline | null> = []
    plan.stations.forEach((station, index) => {
      if (index === 0) {
        lines.push(null)
        return
      }
      const leg = station.inbound
      if (!leg || leg.geometry.length < 2) {
        lines.push(null)
        return
      }
      const polyline = L.polyline([], {
        className: `replay-leg replay-leg-${index}`,
        color: leg.kind === 'navigation' ? 'var(--color-ok)' : 'var(--color-warn-ink)',
        weight: leg.kind === 'navigation' ? 5 : 4,
        opacity: 0.95,
        dashArray: leg.kind === 'straight_line' ? '8 8' : undefined,
        lineCap: 'round',
        interactive: false,
      })
      polyline.addTo(layer)
      lines.push(polyline)
    })
    lineRefs.current = lines
  }, [plan])

  /* 当前站高亮：只换图标，不重建 marker */
  useEffect(() => {
    for (const [index, marker] of markerRefs.current) {
      marker.setIcon(replayIcon(index, index === state.stationIndex))
    }
  }, [plan, state.stationIndex])

  /* 路线可见性：已走过的段画满，当前段按 progress 截断，未来段不提前画 */
  useEffect(() => {
    const lines = lineRefs.current
    if (lines.length === 0) return
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      const leg = plan.stations[index]?.inbound
      if (!leg || leg.geometry.length < 2) {
        line.setLatLngs([])
        continue
      }
      const fullThrough = state.phase === 'finished' ? plan.stations.length - 1 : state.stationIndex
      let points = null as typeof leg.geometry | null
      if (index <= fullThrough) points = leg.geometry
      else if (state.phase === 'leg' && index === state.stationIndex + 1) {
        points = sliceGeometry(leg.geometry, state.progress)
      }
      if (points) {
        line.setLatLngs(points.map((point) => [point.lat, point.lng] as [number, number]))
      } else {
        line.setLatLngs([])
      }
      const element = line.getElement()
      if (element) element.setAttribute('data-drawn', points ? 'true' : 'false')
    }
  }, [plan, state.stationIndex, state.phase, state.progress])

  /* 地图移动：到站 pan/zoom；画线时把整段放进视野；无坐标站不移动 */
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.invalidateSize()
    const current = plan.stations[state.stationIndex]
    if (!current) {
      const points = plan.stations
        .filter((station) => station.location)
        .map((station) => [station.location!.lat, station.location!.lng] as [number, number])
      if (points.length > 0) {
        map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 13, animate: false })
      }
      return
    }
    if (state.phase === 'leg') {
      const target = plan.stations[state.stationIndex + 1]
      const leg = target?.inbound
      if (leg && leg.geometry.length >= 2) {
        map.fitBounds(
          L.latLngBounds(leg.geometry.map((point) => [point.lat, point.lng] as [number, number])),
          { padding: [48, 48], maxZoom: 14, animate: !reducedMotion },
        )
        return
      }
    }
    if (!current.location) return
    const latlng: [number, number] = [current.location.lat, current.location.lng]
    const zoom = Math.max(map.getZoom(), 13)
    if (reducedMotion) map.setView(latlng, zoom, { animate: false })
    else map.flyTo(latlng, zoom, { duration: 0.7 })
  }, [plan, state.stationIndex, state.phase, reducedMotion])

  /* 电影模式切换后容器尺寸变化，必须让 Leaflet 重新量一次 */
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const frame = requestAnimationFrame(() => map.invalidateSize())
    return () => cancelAnimationFrame(frame)
  }, [cinema])

  /* 播放时钟：rAF 累积到 ~40ms 才 dispatch 一次，避免 60fps 全量重渲染 */
  useEffect(() => {
    if (!state.playing) return
    let frame = 0
    let last = performance.now()
    let accumulated = 0
    const loop = (now: number) => {
      const delta = Math.min(250, Math.max(0, now - last))
      last = now
      accumulated += delta
      if (accumulated >= 40) {
        dispatch({ type: 'tick', deltaMs: accumulated })
        accumulated = 0
      }
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [state.playing])

  const stationCount = plan.stations.length
  const sliderMax = Math.max(0, stationCount - 1)
  const current = plan.stations[state.stationIndex] ?? null
  const next = plan.stations[state.stationIndex + 1] ?? null
  const canPrev = stationCount > 0 && state.stationIndex > 0
  const canNext = stationCount > 0 && state.stationIndex < stationCount - 1
  const finished = stationCount === 0 || state.phase === 'finished'
  const effectivePhase = stationCount === 0 ? 'finished' : state.phase
  const phaseLabel =
    stationCount === 0
      ? '没有可回放的站点'
      : finished
        ? '回放结束'
        : state.phase === 'leg'
          ? `前往第 ${state.stationIndex + 2} 站（路线绘制中）`
          : `第 ${state.stationIndex + 1} 站 / 共 ${stationCount} 站`
  const playLabel = stationCount === 0 ? '播放' : state.playing ? '暂停' : finished ? '重新播放' : '播放'

  const changeDay = (index: number) => {
    setDayIndex(index)
    dispatch({ type: 'reset' })
  }

  const stationCard = current ? (
    <section
      className="rounded-[10px] border border-border bg-card p-3 shadow-[var(--shadow-1)]"
      data-testid="replay-current-card"
      data-has-coord={current.location ? 'true' : 'false'}
      data-route-kind={current.inbound?.kind ?? 'none'}
      aria-label={`当前站：${current.stop.name}`}
    >
      <p className={`m-0 ${MUTED}`}>
        第 {current.index + 1} 站 / 共 {stationCount} 站
        {state.phase === 'leg' ? ' · 正在前往下一站' : finished ? ' · 回放结束' : ' · 当前站'}
      </p>
      <h3 className="m-0 mt-1 font-display text-lg font-bold [overflow-wrap:anywhere]" data-testid="replay-current-name">
        {current.stop.name}
      </h3>
      <p className="m-0 mt-1 text-sm" data-testid="replay-current-time">
        时间：{replayTimeLabel(current.stop)}
      </p>
      <p className="m-0 mt-0.5 text-sm" data-testid="replay-current-stay">
        {replayStayLabel(current.stop)}
      </p>
      <p
        className={cn('m-0 mt-1 text-sm', current.location ? 'text-muted-foreground' : 'font-medium text-[color:var(--color-warn-ink)]')}
        data-testid="replay-current-position"
      >
        {current.location ? '位置已定位（WGS84）' : '位置未知，地图上不显示这一站'}
      </p>
      <p className="m-0 mt-1 text-sm text-[color:var(--color-secondary-foreground)]" data-testid="replay-current-route">
        本段：{replayRouteLabel(current.inbound)}
      </p>
      {current.stop.description && (
        <p className="m-0 mt-2 whitespace-pre-line text-sm text-muted-foreground" data-testid="replay-current-desc">
          {current.stop.description}
        </p>
      )}
      <p className="m-0 mt-2 border-t border-border pt-2 text-xs text-muted-foreground" data-testid="replay-next-leg">
        下一段：{next ? nextLegSummary(next) : '本日路线结束'}
      </p>
      {reducedMotion && (
        <p className="m-0 mt-2 text-xs text-muted-foreground" data-testid="replay-reduced-note">
          已按系统「减少动态效果」设置关闭路线动画，按站翻页。
        </p>
      )}
    </section>
  ) : (
    <p className="m-0 rounded-[10px] border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="replay-empty">
      这一天没有可回放的站点。
    </p>
  )

  return (
    <div
      className={cn('oc-overlay-enter fixed inset-0 z-[1200] flex items-center justify-center bg-black/55', cinema ? 'p-0' : 'p-2 sm:p-4')}
      data-testid="route-replay-overlay"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'oc-panel-enter flex w-full flex-col overflow-hidden border border-border bg-background shadow-xl',
          cinema ? 'h-[100dvh] max-w-none rounded-none border-0' : 'h-[min(94vh,900px)] max-w-[1180px] rounded-[10px]',
        )}
        data-testid="route-replay-panel"
        data-phase={effectivePhase}
        data-station-index={state.stationIndex}
        data-station-count={stationCount}
        data-playing={state.playing ? 'true' : 'false'}
        data-speed={state.speed}
        data-cinema={cinema ? 'true' : 'false'}
        data-route-kind={current?.inbound?.kind ?? 'none'}
      >
        {cinema && <h2 id={titleId} className="sr-only">路线回放</h2>}
        {!cinema && (
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 id={titleId} className="m-0 font-display text-lg font-bold">
                路线回放{day ? ` · 第 ${day.day} 天${day.title ? ` · ${day.title}` : ''}` : ''}
              </h2>
              <p className="m-0 mt-1 text-xs text-muted-foreground">
                按站点顺序回放；地图只画已经走过的路段。回放不修改行程、不写任何数据。
              </p>
            </div>
            <button
              type="button"
              className={BTN}
              onClick={onClose}
              data-testid="replay-close"
              data-dialog-initial-focus
            >
              退出回放
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="relative min-h-[300px] flex-1 bg-[color:var(--color-map-water)]">
            <div
              ref={mapElRef}
              className="absolute inset-0 h-full w-full"
              role="application"
              aria-label={day ? `${day.title} 路线回放地图` : '路线回放地图'}
              data-testid="replay-map"
            />
            <div className="pointer-events-none absolute left-3 top-3 z-[400] rounded-[6px] border border-border bg-card/95 px-2 py-1 text-[11px] leading-[1.5] text-[color:var(--color-secondary-foreground)] shadow-[var(--shadow-1)]">
              实线：地图服务路线 · 虚线：示意直线 · 未来路段不提前绘制
            </div>
            {cinema && (
              <div className="absolute bottom-3 left-3 z-[1000] w-[min(420px,calc(100%-24px))]">{stationCard}</div>
            )}
          </div>
          {!cinema && (
            <aside className="min-h-0 overflow-y-auto border-t border-border bg-card p-3 lg:w-[340px] lg:border-l lg:border-t-0 lg:p-4">
              {stationCard}
            </aside>
          )}
        </div>

        <div className="border-t border-border bg-card px-3 py-2" data-testid="replay-controls">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN}
              onClick={() => dispatch({ type: 'toggle' })}
              disabled={stationCount === 0}
              aria-pressed={state.playing}
              data-testid="replay-play-toggle"
            >
              {playLabel}
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => dispatch({ type: 'prev' })}
              disabled={!canPrev}
              data-testid="replay-prev"
            >
              上一站
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => dispatch({ type: 'next' })}
              disabled={!canNext}
              data-testid="replay-next"
            >
              下一站
            </button>
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
              换天
              <select
                className="min-h-9 max-w-[220px] rounded-[6px] border border-border bg-background px-1.5 text-xs"
                value={String(safeDayIndex)}
                onChange={(event) => changeDay(Number(event.target.value))}
                data-testid="replay-day-select"
                disabled={days.length === 0}
              >
                {days.map((item, index) => (
                  <option key={`${item.day}:${index}`} value={index}>
                    第 {item.day} 天{item.title ? ` · ${item.title}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-[160px] flex-1 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
              进度
              <input
                type="range"
                min={0}
                max={sliderMax}
                step={1}
                value={Math.min(state.stationIndex, sliderMax)}
                onChange={(event) => dispatch({ type: 'seek', index: Number(event.target.value) })}
                disabled={stationCount === 0}
                aria-label="回放进度"
                aria-valuetext={
                  stationCount === 0
                    ? '没有可回放的站点'
                    : `第 ${Math.min(state.stationIndex, sliderMax) + 1} 站，共 ${stationCount} 站`
                }
                className="w-full accent-[color:var(--primary)]"
                data-testid="replay-progress"
              />
            </label>
            <span className="whitespace-nowrap font-mono text-xs text-muted-foreground" data-testid="replay-counter">
              第 {stationCount === 0 ? 0 : Math.min(state.stationIndex, sliderMax) + 1} / {stationCount} 站
            </span>
            <div role="group" aria-label="回放倍速" className="flex items-center gap-1">
              {[1, 1.5, 2].map((speed) => (
                <button
                  key={speed}
                  type="button"
                  className={SPEED_BTN}
                  aria-pressed={state.speed === speed}
                  onClick={() => dispatch({ type: 'setSpeed', speed })}
                  data-testid={`replay-speed-${speed}`}
                >
                  {speed}x
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground" data-testid="replay-phase-label">
              {phaseLabel}
            </span>
            <button
              type="button"
              className={BTN}
              onClick={() => setCinema((value) => !value)}
              data-testid="replay-cinema-toggle"
            >
              {cinema ? '退出电影模式' : '电影模式'}
            </button>
            <button type="button" className={BTN} onClick={onClose} data-testid="replay-exit">
              退出
            </button>
          </div>
          {state.phase === 'leg' && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded bg-secondary" role="presentation">
              <div
                className="h-full bg-[color:var(--color-primary)]"
                style={{ width: `${Math.round(state.progress * 100)}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import './app.css'
import PlanForm from './components/PlanForm'
import ItineraryList from './components/ItineraryList'
import TripMap from './components/TripMap'
import { ApiError, fetchExampleTrip, planTrip, probeBackend } from './lib/api'
import type { PlanRequest, Trip } from './lib/api'

type LoadPhase = 'initial' | 'loading' | 'ready' | 'failed'

interface BackendState {
  checked: boolean
  ok: boolean
}

function errorText(err: unknown): { title: string; detail: string } {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case 'network':
        return {
          title: '连不上后端服务',
          detail: '请确认后端已启动，并且 Vite 的 /api 代理（或 VITE_API_BASE 指向的地址）能访问到它。改好后刷新页面再试。',
        }
      case 'server':
        if (err.upstreamUnavailable) {
          // 后端没起 / 代理目标不可达时，开发服务器会回 500 text/plain，不是业务错误
          return {
            title: '连不上后端服务',
            detail: `开发服务器转发 /api 请求时没拿到后端响应（HTTP ${err.status ?? 500}）。请确认后端已启动、代理目标可达；若后端在别的地址，用 VITE_API_BASE 指定后重启 Vite。`,
          }
        }
        return {
          title: '后端处理失败',
          detail: err.detail ? `后端返回：${err.detail}` : `HTTP ${err.status ?? ''}，请稍后重试或查看后端日志。`,
        }
      case 'bad_payload':
        return {
          title: '数据格式不符合约定',
          detail: '后端返回的行程结构与前端契约不一致，请检查后端版本是否已更新（/api/trips）。',
        }
      case 'abort':
        return { title: '请求已取消', detail: '可以重新点击「生成行程」再试一次。' }
    }
  }
  return { title: '出错了', detail: err instanceof Error ? err.message : String(err) }
}

export default function App() {
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [trip, setTrip] = useState<Trip | null>(null)
  const [error, setError] = useState<{ title: string; detail: string } | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [backend, setBackend] = useState<BackendState>({ checked: false, ok: false })
  const [activeDay, setActiveDay] = useState(1)
  const [activeStopId, setActiveStopId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const itineraryTopRef = useRef<HTMLDivElement | null>(null)

  // 首次进入：拉示例行程 + 探活
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    probeBackend({ signal: controller.signal }).then((ok) => {
      if (cancelled) return
      // 业务请求如果已经成功，就保留在线结论（探活可能被代理或超时误判）
      setBackend((prev) => (prev.ok ? prev : { checked: true, ok }))
    })
    fetchExampleTrip({ signal: controller.signal })
      .then((t) => {
        if (cancelled) return
        setTrip(t)
        setPhase('ready')
        // 能拿到业务数据本身就说明后端在线
        setBackend({ checked: true, ok: true })
      })
      .catch((err) => {
        if (cancelled) return
        setPhase('failed')
        setError(errorText(err))
        if (err instanceof ApiError && err.kind === 'network') {
          setBackend({ checked: true, ok: false })
        }
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  // 地图 marker、弹窗与列表共用同一个入口：幂等设置选中站点，空串表示收起
  const handleSelectStop = useCallback((stopId: string) => {
    setActiveStopId(stopId === '' ? null : stopId)
  }, [])

  // 日切换时清除选中站点
  useEffect(() => {
    setActiveStopId(null)
  }, [activeDay])

  const currentDay = trip?.days.find((d) => d.day === activeDay) ?? trip?.days[0]

  const switchDay = useCallback(
    (dayNum: number) => {
      setActiveDay(dayNum)
    },
    [],
  )

  // tablist 方向键导航（WAI-APG）：左右键在日签间移动并激活
  const dayNavKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!trip || e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const days = trip.days
      const idx = days.findIndex((d) => d.day === activeDay)
      if (idx < 0) return
      const next = e.key === 'ArrowRight' ? (idx + 1) % days.length : (idx - 1 + days.length) % days.length
      const nextDay = days[next].day
      setActiveDay(nextDay)
      const el = document.getElementById(`day-tab-${nextDay}`)
      el?.focus()
    },
    [trip, activeDay],
  )

  const handlePlan = useCallback(async (payload: PlanRequest) => {
    // 取消上一次未完成的规划请求
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setPlanLoading(true)
    setError(null)
    try {
      const t = await planTrip(payload, { signal: controller.signal })
      setTrip(t)
      setActiveDay(t.days[0]?.day ?? 1)
      setBackend({ checked: true, ok: true })
      // 滚动到行程区（不用 scrollIntoView，避免嵌入环境的滚动干扰）
      requestAnimationFrame(() => {
        const el = itineraryTopRef.current
        if (el) {
          const top = el.getBoundingClientRect().top + window.scrollY
          window.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' })
        }
      })
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'abort') return
      if (err instanceof ApiError && err.kind === 'network') {
        setBackend({ checked: true, ok: false })
      }
      setError(errorText(err))
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setPlanLoading(false)
    }
  }, [])

  const dayTabs = trip?.days ?? []
  const tripIsExample = trip?.source === 'example'

  return (
    <div className="app-shell">
      <a className="visually-hidden sr-only-focusable" href="#trip-section">跳到行程内容</a>

      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">路书</span>
          <span className="brand-sub">智能出行助手 · 逐日路线与中文讲解</span>
        </div>
        <div className="header-spacer" />
        <div
          className="backend-state"
          data-state={backend.checked ? (backend.ok ? 'ok' : 'down') : 'unknown'}
          title={backend.checked && !backend.ok ? '请确认后端已启动，或检查 Vite 的 /api 代理设置' : undefined}
        >
          <span className="dot" aria-hidden="true" />
          <span role="status">
            {!backend.checked
              ? '正在检查后端…'
              : backend.ok
                ? '后端服务正常'
                : '后端未连接——规划暂不可用'}
          </span>
        </div>
      </header>

      <div className="topbar-progress" data-active={planLoading || phase === 'loading'} aria-hidden="true" />

      <main className="app-main">
        <PlanForm onSubmit={handlePlan} loading={planLoading} />

        {error && (
          <div className="error-banner" role="alert">
            <p>
              <span className="error-title">{error.title}。</span>
              {error.detail}
            </p>
            {phase === 'failed' && (
              <button className="btn" onClick={() => window.location.reload()}>重试</button>
            )}
          </div>
        )}

        {phase === 'loading' && (
          <div aria-busy="true" aria-label="正在加载示例行程">
            <div className="skeleton-block">
              <div className="skeleton-line w40" />
              <div className="skeleton-line w80" />
              <div className="skeleton-line w60" />
            </div>
          </div>
        )}

        <div ref={itineraryTopRef} id="trip-section" />
        {trip && (
          <section aria-label="行程安排">
            <header className="trip-header">
              <span className="trip-source-tag" data-source={trip.source}>
                {tripIsExample ? '示例行程' : 'AI 规划'}
              </span>
              <h2 className="trip-title">{trip.title}</h2>
              <p className="trip-summary">{trip.summary}</p>
              {trip.warnings.length > 0 && (
                <div className="trip-warnings">
                  <ul>
                    {trip.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </header>

            <div className="day-nav" role="tablist" aria-label="按日切换" onKeyDown={dayNavKeyDown}>
              {dayTabs.map((d) => {
                const selected = d.day === activeDay
                return (
                <button
                  key={d.day}
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  aria-controls="day-panel"
                  id={`day-tab-${d.day}`}
                  className="day-tab"
                  onClick={() => switchDay(d.day)}
                >
                  <span className="d-num">D{d.day}{d.date ? ` · ${d.date.slice(5)}` : ''}</span>
                  <span className="d-title">{d.title || `第 ${d.day} 天`}</span>
                </button>
                )
              })}
            </div>

            <div className="trip-layout">
              <div className="itinerary-pane" id="day-panel" role="tabpanel" aria-labelledby={`day-tab-${activeDay}`}>
                {currentDay && (
                  <ItineraryList
                    day={currentDay}
                    activeStopId={activeStopId}
                    onSelectStop={handleSelectStop}
                  />
                )}
              </div>
              <div className="map-pane">
                {currentDay && (
                  <TripMap
                    day={currentDay}
                    activeStopId={activeStopId}
                    onSelectStop={handleSelectStop}
                    key={currentDay.day}
                  />
                )}
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="app-footer">
        <span>底图 © OpenStreetMap 贡献者 · 地图坐标系统 WGS84（经度、纬度）</span>
        <span>路线「示意直线」仅为方位参考，不代表真实导航路径。</span>
        <span>示例行程为演示数据；AI 规划内容由模型生成，出行前请核实开放时间与交通信息。</span>
      </footer>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import './app.css'
import IcsExportPanel from './components/IcsExportPanel'
import PlanForm from './components/PlanForm'
import ItineraryList from './components/ItineraryList'
import SavedTripsPanel from './components/SavedTripsPanel'
import TripMap from './components/TripMap'
import { ApiError, fetchExampleTrip, planTrip, probeBackend } from './lib/api'
import { formatDateTime } from './lib/format'
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
  const [planCancelled, setPlanCancelled] = useState(false)
  const [backend, setBackend] = useState<BackendState>({ checked: false, ok: false })
  const [activeDay, setActiveDay] = useState(1)
  const [activeStopId, setActiveStopId] = useState<string | null>(null)
  const [restoredAt, setRestoredAt] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const exampleAbortRef = useRef<AbortController | null>(null)
  /** 行程归属序号：恢复 / 规划成功都会 +1，迟到的示例响应据此丢弃 */
  const loadSeqRef = useRef(0)
  const planSeqRef = useRef(0)
  const itineraryTopRef = useRef<HTMLDivElement | null>(null)
  const tripTitleRef = useRef<HTMLHeadingElement | null>(null)

  // 首次进入：拉示例行程 + 探活
  useEffect(() => {
    let cancelled = false
    const probeController = new AbortController()
    const exampleController = new AbortController()
    const sequence = loadSeqRef.current
    exampleAbortRef.current = exampleController
    probeBackend({ signal: probeController.signal }).then((ok) => {
      if (cancelled) return
      // 业务请求如果已经成功，就保留在线结论（探活可能被代理或超时误判）
      setBackend((prev) => (prev.ok ? prev : { checked: true, ok }))
    })
    fetchExampleTrip({ signal: exampleController.signal })
      .then((t) => {
        if (cancelled || sequence !== loadSeqRef.current) return
        setTrip(t)
        setPhase('ready')
        // 能拿到业务数据本身就说明后端在线
        setBackend({ checked: true, ok: true })
      })
      .catch((err) => {
        if (cancelled || sequence !== loadSeqRef.current) return
        // 用户已经在加载途中恢复本地副本：旧请求即使忽略 abort 也不能改页面
        if (err instanceof ApiError && err.kind === 'abort') return
        setPhase('failed')
        setError(errorText(err))
        if (err instanceof ApiError && err.kind === 'network') {
          setBackend({ checked: true, ok: false })
        }
      })
    return () => {
      cancelled = true
      probeController.abort()
      exampleController.abort()
      if (exampleAbortRef.current === exampleController) exampleAbortRef.current = null
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

  const scrollToItinerary = useCallback(() => {
    // 滚动到行程区（不用 scrollIntoView，避免嵌入环境的滚动干扰）；
    // 同时把焦点放到行程标题，键盘用户从「恢复」按钮切回来后不会掉到 body。
    requestAnimationFrame(() => {
      const el = itineraryTopRef.current
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY
        window.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' })
      }
      tripTitleRef.current?.focus({ preventScroll: true })
    })
  }, [])

  const handlePlan = useCallback(async (payload: PlanRequest) => {
    // 取消上一次未完成的规划请求，并用序号挡住已经 resolved、但回调还没执行的旧响应
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const sequence = planSeqRef.current + 1
    planSeqRef.current = sequence
    setPlanLoading(true)
    setPlanCancelled(false)
    setError(null)
    try {
      const t = await planTrip(payload, { signal: controller.signal })
      if (sequence !== planSeqRef.current) return
      setTrip(t)
      setPhase('ready')
      setRestoredAt(null)
      setActiveDay(t.days[0]?.day ?? 1)
      setActiveStopId(null)
      setBackend({ checked: true, ok: true })
      // 新规划已接管页面，加载中的示例请求（即使忽略 abort）不能再覆盖
      loadSeqRef.current += 1
      scrollToItinerary()
    } catch (err) {
      if (sequence !== planSeqRef.current) return
      if (err instanceof ApiError && err.kind === 'abort') return
      if (err instanceof ApiError && err.kind === 'network') {
        setBackend({ checked: true, ok: false })
      }
      setError(errorText(err))
    } finally {
      if (sequence === planSeqRef.current) {
        if (abortRef.current === controller) abortRef.current = null
        setPlanLoading(false)
      }
    }
  }, [scrollToItinerary])

  /**
   * 停止等待：只让本页不再等这次结果，立刻恢复可提交状态。
   * 不承诺后端 / 上游模型停止处理或停止计费——请求可能已经在服务端跑完。
   */
  const handleStopWaiting = useCallback(() => {
    if (!planLoading) return
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPlanLoading(false)
    setPlanCancelled(true)
    setError(null)
  }, [planLoading])

  /**
   * 从本浏览器保存的副本恢复：取消未完成的规划请求与示例请求（避免旧响应覆盖恢复结果），
   * 回到第一天，并清空选中站点和地图弹窗。
   */
  const handleRestoreSavedTrip = useCallback((restored: Trip, savedAt: number) => {
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    setPlanLoading(false)
    setPlanCancelled(false)
    setTrip(restored)
    setPhase('ready')
    setError(null)
    setRestoredAt(savedAt)
    setActiveStopId(null)
    setActiveDay(restored.days[0]?.day ?? 1)
    scrollToItinerary()
  }, [scrollToItinerary])

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
        <PlanForm onSubmit={handlePlan} loading={planLoading} onCancel={handleStopWaiting} />

        {planCancelled && !planLoading && (
          <p className="plan-cancel-status" role="status">
            已停止等待这次规划，可以立刻改参数重新提交；旧响应即使到达也会被忽略。
            这个动作只取消本页的等待，不能保证后端或上游模型立即停止处理，也不能保证不再计费。
          </p>
        )}

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

        {!trip && (phase === 'loading' || phase === 'failed') && (
          <div className="saved-offline">
            <p className="saved-offline-note">
              {phase === 'failed'
                ? '后端暂时不可用。这个浏览器里保存过的行程仍可离线恢复；恢复后可以继续查看，重新规划需要等后端恢复。'
                : '示例行程还在加载。这个浏览器里保存过的行程可以现在就恢复，不必等示例返回。'}
            </p>
            <SavedTripsPanel trip={null} onRestore={handleRestoreSavedTrip} />
          </div>
        )}

        <div ref={itineraryTopRef} id="trip-section" />
        {trip && (
          <section aria-label="行程安排">
            <header className="trip-header">
              <span className="trip-source-tag" data-source={trip.source}>
                {tripIsExample ? '示例行程' : 'AI 规划'}
              </span>
              <h2 className="trip-title" ref={tripTitleRef} tabIndex={-1}>{trip.title}</h2>
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
              {restoredAt != null && (
                <p className="trip-restored-note">
                  从本浏览器保存的副本恢复 · 保存于 {formatDateTime(restoredAt)}。这份副本不会同步到其他设备。
                </p>
              )}
            </header>

            <SavedTripsPanel trip={trip} onRestore={handleRestoreSavedTrip} />
            <IcsExportPanel trip={trip} key={`ics:${trip.id}`} />

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
                    key={`${trip.id}:${currentDay.day}`}
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

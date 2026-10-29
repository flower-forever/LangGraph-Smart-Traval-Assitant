import { useCallback, useEffect, useRef, useState } from 'react'
import './app.css'
import IcsExportPanel from './components/IcsExportPanel'
import PlanForm from './components/PlanForm'
import ItineraryList from './components/ItineraryList'
import SavedTripsPanel from './components/SavedTripsPanel'
import TripMap from './components/TripMap'
import './components/backendStatus.css'
import { ApiError, fetchExampleTrip, planTrip, probeBackendCapabilities } from './lib/api'
import { formatDateTime } from './lib/format'
import type { BackendCapabilities, PlanRequest, PlannerAvailability, ProbeFailure, Trip } from './lib/api'

type LoadPhase = 'initial' | 'loading' | 'ready' | 'failed'

/** 失败结论是谁给的。探活失败和业务请求失败必须分开说，不能互相冒充。 */
type FailureSource = 'probe' | 'request'

/** 后端探活结论。可达（reachable）与能规划（planner）分开记，不能互相替代。 */
interface BackendState {
  /** 完成过一次探活或拿到过业务结论 */
  checked: boolean
  /** 后端是可用的健康服务 */
  reachable: boolean
  /** 只有 health 明确表态才不是 unknown；unknown 不等于不可用 */
  planner: PlannerAvailability
  /** 失败分级；可达时为 null */
  failure: ProbeFailure | null
  /** 这条失败结论来自探活还是业务请求——决定文案怎么说，不能混 */
  failureSource: FailureSource | null
  /** 有探活在飞 */
  probing: boolean
}

const BACKEND_INITIAL: BackendState = {
  checked: false,
  reachable: false,
  planner: 'unknown',
  failure: null,
  failureSource: null,
  probing: true,
}

/** 探活失败时的固定提示：不复述后端 warnings，避免把绝对路径、密钥这类内容带进页面 */
const PROBE_FAILURE_HINT: Record<ProbeFailure, string> = {
  timeout: '健康检查超时没有回应。请确认后端已启动，或检查 Vite 的 /api 代理是否指向了正确的地址。',
  network: '健康检查请求没能送达后端。请确认后端已启动，或检查 Vite 的 /api 代理设置。',
  http: '健康检查返回了错误状态码。请确认 /api/health 确实被代理到后端，而不是静态服务器。',
  bad_payload: '健康检查没有返回约定的 JSON。/api 可能被 SPA fallback 或静态服务器接管了。',
}

/**
 * 业务请求失败时的固定提示：只承认「这一次调用没成」，
 * 不用健康检查的口径描述业务错误，也不复述后端返回的原文。
 */
const REQUEST_FAILURE_HINT =
  '这次失败来自业务请求，不是健康检查：它只说明这一次调用没拿到结果。点「重新检测」可以按健康检查重新确认后端状态。'

/** 头部失败原因提示的固定 id，供「重新检测」按钮 aria-describedby 引用 */
const BACKEND_HINT_ID = 'backend-hint'

/** 有业务请求成功就说明后端在线：health 只是辅助信号，不能推翻实际成功的数据请求 */
function markReachable(prev: BackendState): BackendState {
  return { ...prev, checked: true, reachable: true, failure: null, failureSource: null }
}

/**
 * 探活结论落到界面状态。业务请求在探活发出之后成功过（provenLater），
 * 就不接受这次「不可达」的迟到判定——常见于代理慢、探活超时这类误判。
 */
function mergeProbe(prev: BackendState, caps: BackendCapabilities, provenLater: boolean): BackendState {
  if (provenLater && !caps.reachable) return { ...markReachable(prev), probing: false }
  return {
    checked: true,
    reachable: caps.reachable,
    planner: caps.reachable ? caps.planner : 'unknown',
    failure: caps.failure,
    failureSource: caps.failure ? 'probe' : null,
    probing: false,
  }
}

/**
 * 业务请求失败只降级「可达」，不动已经落地的规划能力结论：
 * planner_ready=false 是健康检查给出的能力判定，不该被一次无关的业务失败抹掉。
 */
function mergeRequestFailure(prev: BackendState, failure: ProbeFailure): BackendState {
  return { ...prev, checked: true, reachable: false, failure, failureSource: 'request' }
}

/** 业务失败里能说明「后端连接有问题」的只有传输层两种；结构错误不该升级成后端不可达 */
function requestFailureOf(err: unknown): ProbeFailure | null {
  if (!(err instanceof ApiError)) return null
  if (err.kind === 'timeout') return 'timeout'
  if (err.kind === 'network') return 'network'
  return null
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
  const [backend, setBackend] = useState<BackendState>(BACKEND_INITIAL)
  const [activeDay, setActiveDay] = useState(1)
  const [activeStopId, setActiveStopId] = useState<string | null>(null)
  const [restoredAt, setRestoredAt] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const exampleAbortRef = useRef<AbortController | null>(null)
  /** 行程归属序号：恢复 / 规划成功都会 +1，迟到的示例响应据此丢弃 */
  const loadSeqRef = useRef(0)
  const planSeqRef = useRef(0)
  /** 探活归属序号：重新检测 / 规划成功都会 +1，迟到的探活结论据此丢弃 */
  const probeSeqRef = useRef(0)
  const probeControllerRef = useRef<AbortController | null>(null)
  /**
   * 后端结论版本号：探活得出一致结论、业务请求成功、业务失败被采纳，都会 +1。
   * 业务请求在发起时记下版本，失败回来时版本变了就说明其间已有更新的结论，这次失败不许覆盖它。
   */
  const backendConclusionSeqRef = useRef(0)
  /** 业务请求成功次数：探活发出后拿到过真实数据，就不再采信这次探活的失败结论 */
  const businessProofRef = useRef(0)
  const itineraryTopRef = useRef<HTMLDivElement | null>(null)
  const tripTitleRef = useRef<HTMLHeadingElement | null>(null)

  /** 探活，可重复触发；旧结论靠序号挡住，不会盖掉新结果 */
  const runProbe = useCallback(() => {
    probeControllerRef.current?.abort()
    const controller = new AbortController()
    probeControllerRef.current = controller
    const sequence = probeSeqRef.current + 1
    probeSeqRef.current = sequence
    const proofAtStart = businessProofRef.current
    setBackend((prev) => ({ ...prev, probing: true }))
    void probeBackendCapabilities({ signal: controller.signal }).then((caps) => {
      if (probeControllerRef.current === controller) probeControllerRef.current = null
      if (sequence !== probeSeqRef.current) return
      backendConclusionSeqRef.current += 1
      const provenLater = businessProofRef.current !== proofAtStart
      setBackend((prev) => mergeProbe(prev, caps, provenLater))
    })
  }, [])

  /**
   * 业务请求失败落库。两条硬规则：
   * 1. 只有这次请求发出之后没有更新的后端结论，才轮得到它说话——旧失败不能盖掉新探活；
   * 2. 只降级「可达」，不写 planner：规划能力是 health 的判断，业务失败无从得知。
   */
  const applyRequestFailure = useCallback((failure: ProbeFailure, conclusionAtStart: number) => {
    if (backendConclusionSeqRef.current !== conclusionAtStart) return
    backendConclusionSeqRef.current += 1
    setBackend((prev) => mergeRequestFailure(prev, failure))
  }, [])

  // 首次进入：拉示例行程 + 探活
  useEffect(() => {
    let cancelled = false
    const exampleController = new AbortController()
    const sequence = loadSeqRef.current
    /** 示例请求出发时的后端结论版本，用来挡住「旧失败盖新探活」 */
    const conclusionAtStart = backendConclusionSeqRef.current
    exampleAbortRef.current = exampleController
    runProbe()
    fetchExampleTrip({ signal: exampleController.signal })
      .then((t) => {
        if (cancelled || sequence !== loadSeqRef.current) return
        setTrip(t)
        setPhase('ready')
        // 能拿到业务数据本身就说明后端在线；它不证明规划可用，所以 planner 仍以 health 为准
        businessProofRef.current += 1
        backendConclusionSeqRef.current += 1
        setBackend(markReachable)
      })
      .catch((err) => {
        if (cancelled || sequence !== loadSeqRef.current) return
        // 用户已经在加载途中恢复本地副本：旧请求即使忽略 abort 也不能改页面
        if (err instanceof ApiError && err.kind === 'abort') return
        setPhase('failed')
        setError(errorText(err))
        // 只有传输层失败才改变后端结论；结构错误是数据问题，不该说成连不上
        const failure = requestFailureOf(err)
        if (failure) applyRequestFailure(failure, conclusionAtStart)
      })
    return () => {
      cancelled = true
      // 序号 +1 让在飞探活的迟到结论直接作废
      probeSeqRef.current += 1
      probeControllerRef.current?.abort()
      probeControllerRef.current = null
      exampleController.abort()
      if (exampleAbortRef.current === exampleController) exampleAbortRef.current = null
    }
  }, [runProbe, applyRequestFailure])

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
    /** 规划请求出发时的后端结论版本，用来挡住「旧失败盖新探活」 */
    const conclusionAtStart = backendConclusionSeqRef.current
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
      // 真正拿到规划结果，比 health 更有说服力：此时规划确定可用，迟到的探活不能推翻
      businessProofRef.current += 1
      backendConclusionSeqRef.current += 1
      probeSeqRef.current += 1
      probeControllerRef.current?.abort()
      probeControllerRef.current = null
      setBackend({ checked: true, reachable: true, planner: 'ready', failure: null, failureSource: null, probing: false })
      // 新规划已接管页面，加载中的示例请求（即使忽略 abort）不能再覆盖
      loadSeqRef.current += 1
      scrollToItinerary()
    } catch (err) {
      if (sequence !== planSeqRef.current) return
      if (err instanceof ApiError && err.kind === 'abort') return
      // 传输层失败才动后端结论；业务错误（500 / 结构不符）由错误横幅说明，不能冒充health
      const failure = requestFailureOf(err)
      if (failure) applyRequestFailure(failure, conclusionAtStart)
      setError(errorText(err))
    } finally {
      if (sequence === planSeqRef.current) {
        if (abortRef.current === controller) abortRef.current = null
        setPlanLoading(false)
      }
    }
  }, [scrollToItinerary, applyRequestFailure])

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

  // 只有后端明确返回 planner_ready=false 才锁提交；unknown 保持旧行为，照常允许
  const plannerUnavailable = backend.reachable && backend.planner === 'unavailable'
  const backendVisual = !backend.checked
    ? 'unknown'
    : !backend.reachable
      ? 'down'
      : plannerUnavailable
        ? 'degraded'
        : 'ok'
  /**
   * 失败原因一律用前端固定句，不回显后端 warnings（绝对路径、疑似密钥会被带进页面）。
   * 探活失败和业务失败各说各的：业务错误不借用健康检查的口径。
   */
  const backendHint = !backend.checked || backend.reachable
    ? null
    : backend.failureSource === 'request'
      ? REQUEST_FAILURE_HINT
      : backend.failure
        ? PROBE_FAILURE_HINT[backend.failure]
        : null
  // 状态胶囊里的一句话；结论不因重新检测而消失，进行中状态另加后缀（见 JSX）
  const backendStatusLabel = !backend.checked
    ? '正在检查后端…'
    : !backend.reachable
      ? backend.failureSource === 'request'
        ? '最近一次请求没成功——后端状态未确认'
        : '后端未连接——规划暂不可用'
      : plannerUnavailable
        ? '后端在线，规划暂不可用'
        : (
          <>
            <span>后端服务正常</span>
            <span className="backend-note">
              {' · '}
              {backend.planner === 'ready' ? '可以生成行程' : '规划能力未知'}
            </span>
          </>
        )

  return (
    <div className="app-shell">
      <a className="visually-hidden sr-only-focusable" href="#trip-section">跳到行程内容</a>

      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">路书</span>
          <span className="brand-sub">智能出行助手 · 逐日路线与中文讲解</span>
        </div>
        <div className="header-spacer" />
        <div className="backend-status">
          <div className="backend-state" data-state={backendVisual}>
            <span className="dot" aria-hidden="true" />
            {/* role=status 自带 polite 播报：重新检测的开始 / 结束都会念出来 */}
            <span role="status" aria-live="polite">
              {backendStatusLabel}
              {backend.probing && backend.checked && (
                <span className="backend-probing">{' · '}正在重新检测…</span>
              )}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-ghost backend-reprobe"
            onClick={runProbe}
            aria-busy={backend.probing || undefined}
            aria-describedby={backendHint ? BACKEND_HINT_ID : undefined}
            title="重新探测后端健康状态，不会刷新页面"
          >
            重新检测
          </button>
        </div>
      </header>

      {backendHint && (
        <p className="backend-hint" id={BACKEND_HINT_ID}>{backendHint}</p>
      )}

      <div className="topbar-progress" data-active={planLoading || phase === 'loading'} aria-hidden="true" />

      <main className="app-main">
        <PlanForm
          onSubmit={handlePlan}
          loading={planLoading}
          onCancel={handleStopWaiting}
          plannerUnavailable={plannerUnavailable}
        />

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

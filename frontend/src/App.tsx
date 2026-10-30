import { useCallback, useEffect, useId, useRef, useState } from 'react'
import './app.css'
import IcsExportPanel from './components/IcsExportPanel'
import PlanForm from './components/PlanForm'
import ItineraryList from './components/ItineraryList'
import SavedTripsPanel from './components/SavedTripsPanel'
import TripMap from './components/TripMap'
import TripTransferPanel from './components/TripTransferPanel'
import TripDraftEditor from './components/TripDraftEditor'
import DayReplanPanel, { type DayReplanAdapter } from './components/DayReplanPanel'
import './components/backendStatus.css'
import { ApiError, fetchExampleTrip, planTrip, probeBackendCapabilities } from './lib/api'
import { createTripDraft, type DraftApplySuccess, type TripDraft } from './lib/tripDraft'
import {
  MAX_REPLAN_WARNINGS,
  applyDayReplan,
  type DayReplanApplyResult,
  type DayReplanRequest,
  type DayReplanResponse,
} from './lib/dayReplan'
import { replanDay } from './lib/dayReplanApi'
import { formatDateTime } from './lib/format'
import type { AmapAvailability, BackendCapabilities, PlanRequest, PlannerAvailability, ProbeFailure, TravelMode, Trip } from './lib/api'

/** 站点 id / fork 行程 id 都由页面用 UUID 生成；无 crypto.randomUUID 的环境退回随机串 */
function newUuid(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

type LoadPhase = 'initial' | 'loading' | 'ready' | 'failed'

/**
 * 请求结果的归属说明：只描述「当前展示的行程对应哪次请求」，
 * 是当前视图的临时状态，不写进 Trip、不进本地保存/备份。
 */
type RequestOutcome =
  | { kind: 'none' }
  /** 有一次规划请求在飞：下方是上次结果，新行程正在生成 */
  | { kind: 'pending'; destination: string }
  /** 最近一次规划失败（含超时/网络/5xx）：本次没有生成新行程 */
  | { kind: 'failed'; destination: string }
  /** 用户停止等待：这次结果没有等到，下方仍是上次结果 */
  | { kind: 'stopped'; destination: string }

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
  /** 当前后端服务是否配置了地图 Key；只有 health 明确表态才不是 unknown */
  amap: AmapAvailability
}

const BACKEND_INITIAL: BackendState = {
  checked: false,
  reachable: false,
  planner: 'unknown',
  failure: null,
  failureSource: null,
  probing: true,
  amap: 'unknown',
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
    amap: caps.reachable ? caps.amap : 'unknown',
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
  /**
   * 当前行程相对最近一次规划请求的归属：pending/failed/stopped 都属于
   * 「这次请求」而不是 trip 本身，成功、恢复、导入时清空。
   */
  const [requestOutcome, setRequestOutcome] = useState<RequestOutcome>({ kind: 'none' })
  const [backend, setBackend] = useState<BackendState>(BACKEND_INITIAL)
  const [activeDay, setActiveDay] = useState(1)
  const [activeStopId, setActiveStopId] = useState<string | null>(null)
  const [restoredAt, setRestoredAt] = useState<number | null>(null)
  /**
   * 当前行程是不是从用户选择的备份文件打开进来的。
   * 只用来加一句来源说明：文件里的 source 字段不能证明真实来源，
   * 也不能拿它当「本地保存恢复」来展示时间戳。
   */
  const [openedFromFile, setOpenedFromFile] = useState(false)
  /** 备份 / 导入面板是否展开；默认收起，展开后才挂载面板 */
  const [transferOpen, setTransferOpen] = useState(false)
  const transferBodyId = useId()
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

  /* ───────── 本地编辑（内存草稿）状态 ───────── */

  /**
   * 正在编辑的本地草稿；null 表示当前没有打开编辑器。
   * 草稿只存在于内存：不写 localStorage、不发请求；「应用」后才成为当前行程。
   */
  const [draft, setDraft] = useState<TripDraft | null>(null)
  /** 新建相邻路段的出行方式，进入编辑前由用户显式选择，不猜、不混用 */
  const [draftMode, setDraftMode] = useState<TravelMode>('walking')
  /** 编辑草稿时出错的提示（创建草稿失败等），只在编辑区显示 */
  const [draftError, setDraftError] = useState<string | null>(null)
  /** 编辑器里打开了单站表单：父级据此暂停日切换等外部替换（回调同步，渲染值不直接参与布局） */
  const [, setEditorEditing] = useState(false)
  /** 单站表单里有未提交输入：日切换被明确挡住，避免输入被切换带走 */
  const [editorInputDirty, setEditorInputDirty] = useState(false)
  /** 应用草稿成功后的页面内提示；含撤销应用入口 */
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null)
  /** 应用前的行程快照，供「撤销应用」恢复一次；只保留最近一次 */
  const undoApplyRef = useRef<Trip | null>(null)
  /** 「撤销应用」是否可用（快照存在且当前行程仍是应用产物） */
  const [canUndoApply, setCanUndoApply] = useState(false)
  /**
   * 页面行程版本号：所有会替换当前行程的入口（示例、规划成功、恢复、导入、
   * 本地应用、AI 候选应用、撤销应用）都会 +1。ref 同步可读，供事件处理器在
   * 调用 applyDayReplan 时核对最新版本；state 同时传给 AI 面板，行程被外部
   * 替换后旧候选立即失效。
   */
  const tripRevisionRef = useRef(0)
  const [tripRevision, setTripRevision] = useState(0)
  const bumpTripRevision = useCallback(() => {
    tripRevisionRef.current += 1
    setTripRevision(tripRevisionRef.current)
  }, [])

  /** 最新行程的同步引用：AI 候选应用必须以当前页面为准，不能读闭包里的旧值 */
  const tripRef = useRef<Trip | null>(null)
  tripRef.current = trip
  /** AI 单日调整请求序号：关闭面板 / 重新生成 / 应用成功都 +1，迟到的适配器结果据此作废 */
  const aiRequestSeqRef = useRef(0)
  /** AI 单日调整面板是否打开；与本地草稿互斥 */
  const [aiOpen, setAiOpen] = useState(false)

  /** 当前是否处于本地编辑状态（草稿已打开） */
  const editingDraft = draft !== null
  /** 本地草稿或 AI 单日面板打开时，都暂停会替换行程 / 写存储的外部入口 */
  const interactionPaused = editingDraft || aiOpen
  /** 暂停期间的公共说明 */
  const editPauseNote = editingDraft
    ? '本地编辑进行中：新行程规划、保存、恢复、导出备份和导出日历已暂停。请先「应用草稿」或「放弃草稿」回到原视图，再使用这些功能。'
    : aiOpen
      ? 'AI 单日调整进行中：新行程规划、保存、恢复、导出备份和导出日历已暂停。请先关闭 AI 面板，再使用这些功能。'
      : null

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
        bumpTripRevision()
        setPhase('ready')
        setOpenedFromFile(false)
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

  /** 当前日：编辑时优先取草稿天数组，否则用当前行程；日签仍是唯一的导航事实 */
  const currentDay = (() => {
    if (draft) {
      const fromDraft = draft.days.find((d) => d.day === activeDay)
      if (fromDraft) return fromDraft
      const fromTrip = trip?.days.find((d) => d.day === activeDay)
      if (fromTrip) return fromTrip
    }
    return trip?.days.find((d) => d.day === activeDay) ?? trip?.days[0]
  })()

  const switchDay = useCallback(
    (dayNum: number) => {
      // AI 面板打开时目标日锁定：中途换天会让候选与当前目标日脱节。
      if (aiOpen) return
      // 有未提交的单站输入时明确挡住日切换：输入属于当前天，切换会把它晾在别的天。
      // 没有表单输入时允许跨日编辑同一份草稿（草稿由父级持有，切天不丢）。
      if (editingDraft && editorInputDirty) return
      setActiveDay(dayNum)
    },
    [aiOpen, editingDraft, editorInputDirty],
  )

  // tablist 方向键导航（WAI-APG）：左右键在日签间移动并激活
  const dayNavKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!trip || e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      // AI 面板打开时同样锁住目标日
      if (aiOpen) {
        e.preventDefault()
        return
      }
      // 键盘切天同样遵守「有未提交输入时暂停日切换」
      if (editingDraft && editorInputDirty) {
        e.preventDefault()
        return
      }
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
    [trip, activeDay, aiOpen, editingDraft, editorInputDirty],
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
    setRequestOutcome({ kind: 'pending', destination: payload.destination })
    try {
      const t = await planTrip(payload, { signal: controller.signal })
      if (sequence !== planSeqRef.current) return
      setTrip(t)
      bumpTripRevision()
      setPhase('ready')
      setRestoredAt(null)
      setOpenedFromFile(false)
      setActiveDay(t.days[0]?.day ?? 1)
      setActiveStopId(null)
      setRequestOutcome({ kind: 'none' })
      // 真正拿到规划结果，比 health 更有说服力：此时规划确定可用，迟到的探活不能推翻
      businessProofRef.current += 1
      backendConclusionSeqRef.current += 1
      probeSeqRef.current += 1
      probeControllerRef.current?.abort()
      probeControllerRef.current = null
      setBackend({ checked: true, reachable: true, planner: 'ready', failure: null, failureSource: null, probing: false, amap: 'unknown' })      // 新规划已接管页面，加载中的示例请求（即使忽略 abort）不能再覆盖
      loadSeqRef.current += 1
      scrollToItinerary()
    } catch (err) {
      if (sequence !== planSeqRef.current) return
      if (err instanceof ApiError && err.kind === 'abort') return
      // 传输层失败才动后端结论；业务错误（500 / 结构不符）由错误横幅说明，不能冒充health
      const failure = requestFailureOf(err)
      if (failure) applyRequestFailure(failure, conclusionAtStart)
      setError(errorText(err))
      setRequestOutcome({ kind: 'failed', destination: payload.destination })
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
    setRequestOutcome((prev) =>
      prev.kind === 'pending' ? { kind: 'stopped', destination: prev.destination } : { kind: 'stopped', destination: '' },
    )
  }, [planLoading])

  /**
   * 从本浏览器保存的副本恢复：取消未完成的规划请求与示例请求（避免旧响应覆盖恢复结果），
   * 回到第一天，并清空选中站点和地图弹窗。恢复也会替换当前行程：递增 revision。
   * 编辑草稿时该入口被禁用，正常不会走到这里；万一被调用（面板未禁用的路径），
   * 旧草稿立即作废而不是带着新 base 应用。
   */
  const handleRestoreSavedTrip = useCallback((restored: Trip, savedAt: number) => {
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    // 恢复同样替换当前行程：AI 面板若在开（正常已禁用）立刻作废在途候选
    aiRequestSeqRef.current += 1
    setAiOpen(false)
    setPlanLoading(false)
    setPlanCancelled(false)
    setDraft(null)
    setDraftError(null)
    setAppliedNotice(null)
    undoApplyRef.current = null
    setCanUndoApply(false)
    setEditorEditing(false)
    setEditorInputDirty(false)
    setTrip(restored)
    bumpTripRevision()
    setPhase('ready')
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setRestoredAt(savedAt)
    setOpenedFromFile(false)
    setActiveStopId(null)
    setActiveDay(restored.days[0]?.day ?? 1)
    scrollToItinerary()
  }, [scrollToItinerary])

  /**
   * 打开从备份文件导入的行程（TripTransferPanel 的「打开这份行程」）。
   *
   * - 只切换当前视图：不写 localStorage、不下载、不请求后端；需要保存走面板里显式的「保存到本地」；
   * - 作废在飞的示例 / 规划请求：序号 +1 再 abort，即使对方忽略 abort，迟到的响应也覆盖不了这份行程；
   * - 不设 restoredAt——那份时间戳只属于「本浏览器保存的副本」，不能拿来给文件里的行程用；
   * - 回到第一天并清空选中站点，避免停在上一个行程的某天 / 某个站点上。
   */
  const handleOpenImportedTrip = useCallback((imported: Trip) => {
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    // 打开文件同样替换当前行程：AI 面板若在开（正常已禁用）立刻作废在途候选
    aiRequestSeqRef.current += 1
    setAiOpen(false)
    // 等待中的规划被这次打开接管：恢复可提交状态，也不再显示「已停止等待」的旧说明
    setPlanLoading(false)
    setPlanCancelled(false)
    // 打开文件同样替换当前行程：旧草稿作废（编辑期间此入口已被禁用，这里是兜底）
    setDraft(null)
    setDraftError(null)
    setAppliedNotice(null)
    undoApplyRef.current = null
    setCanUndoApply(false)
    setEditorEditing(false)
    setEditorInputDirty(false)
    setTrip(imported)
    bumpTripRevision()
    setPhase('ready')
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setRestoredAt(null)
    setOpenedFromFile(true)
    setActiveStopId(null)
    setActiveDay(imported.days[0]?.day ?? 1)
    scrollToItinerary()
  }, [scrollToItinerary])

  const dayTabs = trip?.days ?? []
  const tripIsExample = trip?.source === 'example'

  /* ───────── 本地编辑：进入 / 应用 / 放弃 / 撤销应用 ───────── */

  /**
   * 进入本地编辑：先作废并中止当前规划与示例等待（迟到的结果不允许在编辑期间覆盖页面），
   * 再用 UUID 创建新 fork 草稿。原行程与已保存数据完全不动。
   * 停止等待只取消本页的等待，不保证后端停止处理。
   */
  const handleStartEditing = useCallback(() => {
    if (!trip || draft || aiOpen) return
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    setPlanLoading(false)
    setPlanCancelled(false)
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setDraftError(null)
    setAppliedNotice(null)
    setCanUndoApply(false)
    undoApplyRef.current = null
    const result = createTripDraft(trip, { forkTripId: newUuid(), newLegMode: draftMode })
    if (!result.ok) {
      setDraftError(`没能开始本地编辑：${result.message}`)
      return
    }
    setDraft(result.draft)
  }, [trip, draft, aiOpen, draftMode])

  /** 编辑期间用户换了出行方式：对未打开的草稿没有影响；草稿打开后选择被禁用 */
  const handleDraftModeChange = useCallback((mode: TravelMode) => {
    setDraftMode(mode)
  }, [])

  /**
   * 应用草稿成功：采纳新 fork Trip 为当前行程。旧错误与请求归属提示清空；
   * 保留仍然有效的日签；清掉已经不存在的选中站点；保留一次应用前快照供撤销应用。
   * 应用不会写 localStorage：用户之后仍需显式保存。
   */
  const handleDraftApply = useCallback((result: DraftApplySuccess) => {
    if (!result.changed) return
    undoApplyRef.current = trip
    setCanUndoApply(true)
    setDraft(null)
    setDraftError(null)
    setEditorEditing(false)
    setEditorInputDirty(false)
    setTrip(result.trip)
    bumpTripRevision()
    setPhase('ready')
    setError(null)
    setRequestOutcome({ kind: 'none' })
    // 新副本不是本浏览器保存的那份记录，不能继续显示「从已保存副本恢复」
    setRestoredAt(null)
    setAppliedNotice(
      '已把草稿应用成当前行程（新的行程副本）。这一步不会自动保存，需要保存请再点「保存当前行程」；' +
        '导出日历会生成新副本，不会更新之前导入的日历事件。',
    )
    const appliedDayValid = result.trip.days.some((d) => d.day === activeDay)
    if (!appliedDayValid) setActiveDay(result.trip.days[0]?.day ?? 1)
    setActiveStopId((current) =>
      current && result.trip.days.some((d) => d.stops.some((s) => s.id === current)) ? current : null,
    )
    scrollToItinerary()
  }, [trip, activeDay, bumpTripRevision, scrollToItinerary])

  /** 放弃草稿：回到原视图；原行程从未被改过，无需恢复 */
  const handleDraftDiscard = useCallback(() => {
    setDraft(null)
    setDraftError(null)
    setEditorEditing(false)
    setEditorInputDirty(false)
  }, [])

  /** 撤销应用：回到应用前的那个行程。只影响当前视图，不删除用户已显式保存的副本 */
  const handleUndoApply = useCallback(() => {
    const snapshot = undoApplyRef.current
    if (!snapshot || !canUndoApply) return
    undoApplyRef.current = null
    setCanUndoApply(false)
    setDraft(null)
    setDraftError(null)
    setEditorEditing(false)
    setEditorInputDirty(false)
    setTrip(snapshot)
    bumpTripRevision()
    setPhase('ready')
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setRestoredAt(null)
    setAppliedNotice('已撤销应用，回到应用前的行程。已显式保存过的记录不受影响。')
    const dayValid = snapshot.days.some((d) => d.day === activeDay)
    if (!dayValid) setActiveDay(snapshot.days[0]?.day ?? 1)
    setActiveStopId((current) =>
      current && snapshot.days.some((d) => d.stops.some((s) => s.id === current)) ? current : null,
    )
    scrollToItinerary()
  }, [canUndoApply, activeDay, bumpTripRevision, scrollToItinerary])

  /* ───────── AI 单日调整：打开 / 请求适配 / 应用 / 关闭 ───────── */

  /**
   * 打开 AI 单日调整面板。和进入本地编辑一样，先作废并中止在飞的规划 / 示例请求，
   * 清掉旧错误与请求归属，避免迟到的结果在面板打开期间覆盖页面。
   * 草稿与 AI 面板互斥：有草稿时入口按钮被禁用，草稿输入不会被清掉。
   */
  const handleOpenAiPanel = useCallback(() => {
    if (!trip || draft || aiOpen) return
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    aiRequestSeqRef.current += 1
    setPlanLoading(false)
    setPlanCancelled(false)
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setDraftError(null)
    setAiOpen(true)
  }, [trip, draft, aiOpen])

  /** 关闭面板：作废在途候选请求；当前行程不变，也不代表服务端停止处理。 */
  const handleCloseAiPanel = useCallback(() => {
    aiRequestSeqRef.current += 1
    setAiOpen(false)
  }, [])

  /**
   * 面板的请求适配器：复用既有 postJson / replanDay 客户端与取消、超时、错误分类。
   * 有效的成功响应说明模型服务确实可用，可以把 planner 记为 ready；
   * 但只有仍是当前请求序号时才允许改后端结论——关闭面板、重新生成、应用成功后，
   * 旧请求即使迟到也不能把更新的健康 / 失败结论翻回去。
   */
  const handleAiRequestDay = useCallback<DayReplanAdapter>(
    (request, options) => {
      const seq = aiRequestSeqRef.current + 1
      aiRequestSeqRef.current = seq
      const conclusionAtStart = backendConclusionSeqRef.current
      return replanDay(request, options).then(
        (response) => {
          if (aiRequestSeqRef.current === seq) {
            businessProofRef.current += 1
            backendConclusionSeqRef.current += 1
            probeSeqRef.current += 1
            probeControllerRef.current?.abort()
            probeControllerRef.current = null
            setBackend((prev) => ({ ...markReachable(prev), planner: 'ready', probing: false }))
          }
          return response
        },
        (err: unknown) => {
          if (aiRequestSeqRef.current === seq) {
            const failure = requestFailureOf(err)
            if (failure) applyRequestFailure(failure, conclusionAtStart)
          }
          throw err
        },
      )
    },
    [applyRequestFailure],
  )

  /**
   * 面板里点了「应用候选」：父级用最新行程引用与 revision 重新走 applyDayReplan，
   * 绝不直接 setTrip 旧响应。过期、容量、跨天 id 冲突等失败原样返回给面板显示，
   * 当前行程保持不变；成功才采纳新 fork、递增统一 revision 并关闭面板。
   * 应用快照与本地编辑共用一次「撤销应用」，但不写 localStorage。
   */
  const handleAiApply = useCallback(
    (request: DayReplanRequest, response: DayReplanResponse): DayReplanApplyResult => {
      const latestTrip = tripRef.current
      if (!latestTrip) {
        return { ok: false, reason: 'invalid_base', message: '当前没有可应用的行程，AI 候选未应用。' }
      }
      const applied = applyDayReplan({
        baseTrip: latestTrip,
        request,
        response,
        currentRevision: tripRevisionRef.current,
        forkTripId: newUuid(),
      })
      if (!applied.ok) return applied

      aiRequestSeqRef.current += 1
      undoApplyRef.current = latestTrip
      setCanUndoApply(true)
      setTrip(applied.trip)
      bumpTripRevision()
      setPhase('ready')
      setError(null)
      setRequestOutcome({ kind: 'none' })
      // 新副本不是本浏览器保存的那份记录，不能继续显示「从已保存副本恢复」
      setRestoredAt(null)
      setAiOpen(false)
      const dayValid = applied.trip.days.some((d) => d.day === activeDay)
      if (!dayValid) setActiveDay(applied.trip.days[0]?.day ?? 1)
      setActiveStopId((current) =>
        current && applied.trip.days.some((d) => d.stops.some((s) => s.id === current)) ? current : null,
      )
      setAppliedNotice(
        `已把第 ${request.day} 天的 AI 候选应用到当前行程（新的行程副本）；这次应用只替换这一天，其它天和已有保存记录都没有被它改动。` +
          '这次应用本身不会自动保存，保存仍由你显式操作；导出的日历是新副本，不会更新之前导入的事件。' +
          (applied.omittedWarnings > 0
            ? ` 有 ${applied.omittedWarnings} 条提醒因 ${MAX_REPLAN_WARNINGS} 条上限被省略，具体见行程提醒里的说明。`
            : '') +
          (openedFromFile
            ? ' 这份行程来自导入文件：本次只替换了这一天，其余内容仍未向服务器核对。'
            : '') +
          (applied.trip.source === 'example' ? ' 这次应用保留了原来的示例行程身份。' : ''),
      )
      scrollToItinerary()
      return applied
    },
    [activeDay, bumpTripRevision, openedFromFile, scrollToItinerary],
  )

  /**
   * 规划请求归属说明：有失败/停止/进行中，且页面有行程可看时，
   * 在行程标题旁注明「下方内容属于哪次结果」，避免旧行程被误读成新请求的答案。
   * pending 且 planLoading 时也显示——用户可能正在看行程区，需要知道下面是旧结果。
   */
  const outcomeNote = (() => {
    if (!trip) return null
    const dest =
      requestOutcome.kind !== 'none' && requestOutcome.destination ? `「${requestOutcome.destination}」` : ''
    switch (requestOutcome.kind) {
      case 'pending':
        return `正在生成${dest}的新行程；下方显示的仍是上一次的结果，生成完成后会自动替换。`
      case 'failed':
        return `刚才为${dest}生成行程的请求没有成功，本次没有生成新行程；下方显示的是上一次的结果，可以继续浏览。可修改参数后重新提交。`
      case 'stopped':
        return `已停止等待${dest || '这次'}的规划请求，本次没有拿到新行程；下方显示的是上一次的结果，可以继续浏览。`
      default:
        return null
    }
  })()

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
              {backend.amap === 'not_configured' && ' · 地图 Key 未配置'}
            </span>
          </>
        )

  /**
   * 地图 Key 的说明只描述「当前后端服务」：它解释不了某份行程里坐标为什么缺
   * ——导入/恢复的行程由当时的生成环境决定，这里不能替历史结果背书。
   */
  const amapNote = backend.checked && backend.reachable && backend.amap === 'not_configured'
    ? '当前后端服务没有配置地图 Key：新规划的行程不会有站点坐标和导航路线。已经生成的行程（包括导入或恢复的）不受此说明影响，它们的坐标取决于各自生成时的服务配置。'
    : null

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

      {amapNote && (
        <p className="backend-hint backend-hint-amap">{amapNote}</p>
      )}

      <div className="topbar-progress" data-active={planLoading || phase === 'loading'} aria-hidden="true" />

      <main className="app-main">
        {/*
          本地编辑期间把规划表单整体包进 disabled fieldset：控件禁用且读屏会念出
          「已暂停」的说明。不传 loading=true——那会假装 AI 正在生成。
        */}
        <fieldset className="edit-pause-fieldset" disabled={interactionPaused}>
          {editPauseNote && <legend className="edit-pause-legend">{editPauseNote}</legend>}
          <PlanForm
            onSubmit={handlePlan}
            loading={planLoading}
            onCancel={handleStopWaiting}
            plannerUnavailable={plannerUnavailable}
          />
        </fieldset>

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
          <section aria-label="行程安排" data-trip-revision={tripRevision}>
            <header className="trip-header">
              <div className="trip-head-row">
                <span className="trip-source-tag" data-source={trip.source}>
                  {tripIsExample ? '示例行程' : 'AI 规划'}
                </span>
                {outcomeNote && (
                  /*
                   * 归属说明是当前请求/视图的临时状态：不写进 trip，保存/备份不会带上它。
                   * 失败细节由 role=alert 的错误横幅播报，这里只做视觉归属标注，
                   * 不再挂 live region，避免同一事件被读屏播报两遍。
                   */
                  <p className="trip-outcome-note" data-testid="request-status-note">
                    {outcomeNote}
                  </p>
                )}
              </div>
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
              {restoredAt != null && !editingDraft && (
                <p className="trip-restored-note">
                  从本浏览器保存的副本恢复 · 保存于 {formatDateTime(restoredAt)}。这份副本不会同步到其他设备。
                </p>
              )}
              {openedFromFile && !editingDraft && (
                /*
                 * 来源说明：source 是文件里写的内容，标签本身证明不了真实来源。
                 * 样式沿用 .trip-restored-note。
                 */
                <p className="trip-restored-note trip-imported-note" data-note="imported-file">
                  这份行程来自你选择的备份文件：页面没有向服务器核对过内容。打开文件这个动作不会自动保存；
                  想把它留在这台电脑上，请在下面的「行程备份与导入」里点「保存到本地」。
                  上面的「示例行程 / AI 规划」标签取自文件里的 source 字段，只代表文件自己这么写，不能证明它的真实来源。
                </p>
              )}
            </header>

            {appliedNotice && !editingDraft && !aiOpen && (
              <div className="apply-result-note" data-testid="apply-notice">
                <p role="status">{appliedNotice}</p>
                {canUndoApply && (
                  <button type="button" className="btn btn-ghost" onClick={handleUndoApply}>
                    撤销应用
                  </button>
                )}
              </div>
            )}

            {!editingDraft && !aiOpen && (
              <>
                <SavedTripsPanel trip={trip} onRestore={handleRestoreSavedTrip} />
                <IcsExportPanel trip={trip} key={`ics:${trip.id}`} />
              </>
            )}

            {/* 本地编辑入口：行程下方、日签上方。编辑期间被现有草稿取代；AI 面板打开时收起 */}
            {!editingDraft && !aiOpen && (
              <div className="edit-entry" data-testid="edit-entry">
                <div className="field edit-entry-mode">
                  <span className="field-label" id="edit-mode-label">新增路段的出行方式</span>
                  <div className="mode-toggle" role="radiogroup" aria-labelledby="edit-mode-label">
                    <label className="mode-option">
                      <input
                        type="radio"
                        name="draft_leg_mode"
                        value="walking"
                        checked={draftMode === 'walking'}
                        onChange={() => handleDraftModeChange('walking')}
                      />
                      <span>步行</span>
                    </label>
                    <label className="mode-option">
                      <input
                        type="radio"
                        name="draft_leg_mode"
                        value="driving"
                        checked={draftMode === 'driving'}
                        onChange={() => handleDraftModeChange('driving')}
                      />
                      <span>驾车</span>
                    </label>
                  </div>
                  <p className="field-help">
                    本地编辑不会请求新路线：新增或重排站点后，涉及的新路段会标为「待重新获取」，
                    这里选定的方式只写进那条路段的标记，不会自动补距离或耗时。
                  </p>
                </div>
                <div className="edit-entry-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleStartEditing}
                  >
                    编辑这趟行程
                  </button>
                  <p className="field-help">
                    在内存草稿里改站点文字、顺序和时间，不会自动保存，也不请求后端；应用后才替换当前显示的行程。
                  </p>
                </div>
                {draftError && (
                  <p className="field-error" role="alert">{draftError}</p>
                )}
              </div>
            )}

            {/*
              AI 单日调整入口：目标固定为当前日。
              有本地草稿时按钮禁用——先应用或放弃草稿，避免把草稿输入晾在一边。
            */}
            {!aiOpen && (
              <div className="ai-entry" data-testid="ai-entry" data-day={activeDay}>
                <div className="ai-entry-copy">
                  <p className="field-label">
                    AI 调整单日（目标：第 {activeDay} 天
                    {currentDay?.date ? ` · ${currentDay.date}` : ''}）
                  </p>
                  <p className="field-help">
                    只让 AI 重排这一天。候选会先和当前安排对比，你点「应用候选」之前，页面上的行程、地图和保存记录都不会变。
                  </p>
                  {editingDraft ? (
                    <p className="field-help" role="note">
                      本地草稿正在编辑：先「应用草稿」或「放弃草稿」，再让 AI 调整这一天；草稿输入不会因此丢失。
                    </p>
                  ) : null}
                </div>
                <div className="ai-entry-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={handleOpenAiPanel}
                    disabled={editingDraft}
                  >
                    AI 调整这一天
                  </button>
                </div>
              </div>
            )}

            {aiOpen && (
              <div className="ai-panel-slot" data-testid="ai-panel-slot">
                <p className="ai-pause-note" role="note">
                  AI 调整面板打开着：日期切换、规划、恢复、保存、导出与备份已暂停，关闭面板后恢复。
                  面板里的「停止等待」只停止本页等待，不保证后端或上游模型停止处理，也不保证停止计费。
                </p>
                <DayReplanPanel
                  trip={trip}
                  dayNumber={activeDay}
                  revision={tripRevision}
                  plannerAvailability={backend.planner}
                  requestDay={handleAiRequestDay}
                  onApply={handleAiApply}
                  onClose={handleCloseAiPanel}
                />
              </div>
            )}

            {editingDraft && draft && (
              <TripDraftEditor
                draft={draft}
                dayNumber={currentDay?.day ?? draft.base.days[0]?.day ?? 1}
                onDraftChange={setDraft}
                onApply={handleDraftApply}
                onDiscard={handleDraftDiscard}
                createStopId={newUuid}
                onEditingChange={setEditorEditing}
                onInputDirtyChange={setEditorInputDirty}
                onSelectStop={handleSelectStop}
              />
            )}

            <div className="day-nav" role="tablist" aria-label="按日切换" onKeyDown={dayNavKeyDown}>
              {dayTabs.map((d) => {
                const selected = d.day === activeDay
                const blocked = aiOpen || (editingDraft && editorInputDirty)
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
                  aria-disabled={blocked || undefined}
                  title={
                    aiOpen
                      ? 'AI 调整面板打开着，目标日已锁定；关闭面板后可切换日期。'
                      : blocked
                        ? '有未保存的站点输入，先保存到草稿或取消输入，再切换日期。'
                        : undefined
                  }
                >
                  <span className="d-num">D{d.day}{d.date ? ` · ${d.date.slice(5)}` : ''}</span>
                  <span className="d-title">{d.title || `第 ${d.day} 天`}</span>
                </button>
                )
              })}
            </div>
            {editingDraft && editorInputDirty && (
              <p className="day-switch-note" role="status">
                单站输入尚未保存：日期切换已暂停。输入属于当前正在编辑的天，先「保存到草稿」或「取消输入」再切换。
              </p>
            )}
            {aiOpen && (
              <p className="day-switch-note" data-testid="ai-day-lock-note" role="status">
                AI 调整面板打开着：日期切换已暂停，目标固定为第 {activeDay} 天；关闭面板后恢复。
              </p>
            )}

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
            {editingDraft && (
              <p className="draft-preview-note" data-testid="draft-preview-note" role="note">
                上面的行程和地图显示的是内存草稿的预览，还没有应用，也没有保存；
                当前行程的原始数据没有被修改，已保存的记录保持原样。
              </p>
            )}
          </section>
        )}

        {/*
          备份 / 导入的入口：默认收起，点一次展开。没有行程时也能进来导入，
          导出区自己会说明当前没有可导出的行程。展开后才挂载面板——面板的导出区会
          把当前行程标题再显示一遍，收起时页面里只保留行程标题本身。
        */}
        <div className="trip-transfer-slot">
          {editingDraft ? (
            <p className="edit-pause-note" role="note">
              本地编辑进行中：行程备份与导入（含保存到本地、下载备份）已暂停。请先「应用草稿」或「放弃草稿」再使用。
            </p>
          ) : aiOpen ? (
            <p className="edit-pause-note" role="note">
              AI 单日调整进行中：行程备份与导入（含保存到本地、下载备份）已暂停。请先关闭 AI 面板再使用。
            </p>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-ghost trip-transfer-toggle"
                onClick={() => setTransferOpen((open) => !open)}
                aria-expanded={transferOpen}
                aria-controls={transferBodyId}
                title="导入或导出本机 JSON 备份；没有行程时也可以先导入"
              >
                {transferOpen ? '收进行程备份与导入' : '行程备份与导入'}
              </button>
              <div id={transferBodyId}>
                {transferOpen && (
                  <TripTransferPanel trip={trip} onOpen={handleOpenImportedTrip} />
                )}
              </div>
            </>
          )}
        </div>
      </main>

      <footer className="app-footer">
        <span>底图 © OpenStreetMap 贡献者 · 地图坐标系统 WGS84（经度、纬度）</span>
        <span>路线「示意直线」仅为方位参考，不代表真实导航路径。</span>
        <span>示例行程为演示数据；AI 规划内容由模型生成，出行前请核实开放时间与交通信息。</span>
      </footer>
    </div>
  )
}

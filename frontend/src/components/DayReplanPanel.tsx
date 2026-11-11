/**
 * 单日 AI 重规划独立预览面板（不接 App，由父级显式接线）。
 *
 * 边界：
 * - 面板不生成 fork id、不写存储、不修改 trip；onApply 是唯一可能替换页面的入口。
 * - 点击「生成」才 buildDayReplanRequest + 一次 adapter 调用；无自动请求、无重试。
 * - pending 期间表单与按钮禁用；可停止等待。AbortController + 单调 seq
 *   双保险：迟到的、无视 abort 的响应一律作废，不进预览。
 * - trip 对象 / revision / day 变化即 abort 并作废候选；已填指令保留可核对。
 * - 候选预览前再次核对 parent / day / date / version；不符直接拒绝，不展示。
 * - 用户显式「应用候选」才调 onApply(request, response)；同步返回失败时
 *   显示容量 / 过期等可操作错误，保留当前行程，不假定回调一定成功。
 * - 文案不出现 fork / revision / DTO 等实现术语；不声称候选已保存或已生效。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { ApiError, Trip, TripDay, TripStop, TravelMode } from '../lib/api'
import {
  buildDayReplanRequest,
  validateDayReplanResponse,
  MAX_REPLAN_TRAVELERS,
  type DayReplanApplyResult,
  type DayReplanRequest,
  type DayReplanResponse,
  type MapStatus,
} from '../lib/dayReplan'
import { replanDay } from '../lib/dayReplanApi'
import {
  bindTailBoundaryResponse,
  buildTailBoundaryRequest,
  buildDayReplanTailRequest,
  composeTailPreviewDay,
  type DayReplanTailApplyResult,
  type DayReplanTailScope,
  type TailBoundaryCurrent,
  type TailBoundarySelection,
} from '../lib/dayReplanTail'
import { refreshLegRoute } from '../lib/legRefreshApi'
import type { LegRefreshRequest, LegRefreshResponse } from '../lib/legRefresh'
import {
  PlanningConstraintsError,
  type DayReplanConstraintsOptions,
} from '../lib/planningConstraintsApi'
import type {
  ConstraintsBindingV1,
  ConstraintsV1,
  PlanScopeV1,
  WorkspaceRecordV1,
} from '../lib/workspaceTypes'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'

/**
 * 可选 F2 planning context：父级在面板渲染 / 打开时捕获当前内存工作区、
 * 约束与 epoch，并提供按真实 scope 生成 binding 的纯函数。未提供时面板
 * 请求体与旧行为完全一致（不发送 constraints）。
 */
export interface DayReplanPlanningContext {
  readonly constraints: ConstraintsV1
  readonly record: WorkspaceRecordV1
  readonly epoch: number
  readonly createBinding: (
    scope: PlanScopeV1,
  ) => { ok: true; value: ConstraintsBindingV1 } | { ok: false; message: string }
}

export type DayReplanAdapter = (
  request: DayReplanRequest,
  options?: { signal?: AbortSignal; planningConstraints?: DayReplanConstraintsOptions },
) => Promise<DayReplanResponse>

/** 后段衔接路线查询 adapter：默认走 legRefreshApi.refreshLegRoute；测试注入 mock。 */
export type TailLegRefreshAdapter = (
  request: LegRefreshRequest,
  options?: { signal?: AbortSignal },
) => Promise<LegRefreshResponse>

export type DayReplanPanelPlannerAvailability = 'ready' | 'unavailable' | 'unknown'

export interface DayReplanPanelProps {
  /** 当前页面正在显示的行程；面板只读，不修改。 */
  trip: Trip
  /** 目标日（1..7）。 */
  dayNumber: number
  /** 父级页面的版本号；候选生成与应用都以它为准。 */
  revision: number
  /** 规划能力状态：明确不可用时禁用生成；unknown 不当不可用处理。 */
  plannerAvailability?: DayReplanPanelPlannerAvailability
  /** 异步请求 adapter，默认走 dayReplanApi.replanDay；测试注入 mock。 */
  requestDay?: DayReplanAdapter
  /**
   * 用户显式点击「应用候选」时调用。父级负责生成 fork id、用最新 trip/revision
   * 调 applyDayReplan 并采纳结果；面板只按同步返回结果显示成功或失败。
   */
  onApply: (
    request: DayReplanRequest,
    response: DayReplanResponse,
    scope?: DayReplanTailScope,
    boundary?: TailBoundarySelection,
    current?: TailBoundaryCurrent,
  ) => DayReplanApplyResult | DayReplanTailApplyResult
  /** 关闭面板：只放弃候选 / 停止等待，不改旧行程。 */
  onClose: () => void
  /** 衔接路线查询 adapter；缺省用 legRefreshApi.refreshLegRoute（显式点击才请求）。 */
  refreshTailLeg?: TailLegRefreshAdapter
  /**
   * 可选 F2 规划上下文。提供时面板在发请求前按真实 scope 生成 binding，
   * 并把 planningConstraints 一并交给 adapter；不提供时请求体保持旧行为。
   */
  planningContext?: DayReplanPlanningContext | null
  /**
   * 可选：父级持有「实时输入快照」的 ref。面板每次渲染同步写入当前
   * `{ trip, revision, dayNumber, contentEpoch, inputEpoch }`（单调代际，A→B→A 不复活）。
   * App 的 U 级确认在提交时读取它做同步 final guard；未提供时旧行为不变。
   */
  liveInputRef?: { current: DayReplanLiveInputSnapshot | null }
  /**
   * 可选：影响规划的输入 / 上下文代际变化通知（指令 / 方式 / 人数 / 范围 / 锚点 /
   * 行程内容 / revision / day）。App 用它清除挂起的 U 级确认；未提供时旧行为不变。
   */
  onPlanningInputChanged?: () => void
}

/** 面板实时输入快照：App U 确认的同步 final guard 依据；每次渲染整体替换。 */
export interface DayReplanLiveInputSnapshot {
  trip: Trip
  revision: number
  dayNumber: number
  contentEpoch: number
  inputEpoch: number
}

type PanelError = { kind: 'build' | 'network' | 'server' | 'timeout' | 'abort' | 'bad_payload'; message: string }

type ApplyError = { message: string }

const MAP_STATUS_TEXT: Record<MapStatus, string> = {
  ready: '本日站点与相邻路线数据完整，可以照常绘图。',
  partial: '本日只有部分站点有坐标或部分路段缺路线数据，地图会显示可得的部分。',
  unavailable: '本日没有可用坐标，路线以文字安排为准，地图不绘制。',
  no_key: '服务端未配置地图服务：站点保留文字安排，坐标与路线未获取。',
  timeout: '获取地图数据超时：站点保留文字安排，坐标与路线未获取。',
  failed: '获取地图数据失败：站点保留文字安排，坐标与路线未获取。',
}

const ROUTE_TEXT: Record<TripDay['legs'][number]['route_type'], string> = {
  navigation: '导航路线',
  straight_line: '直线示意',
  unavailable: '路线待获取',
}

const PANEL_NOTE =
  'm-0 max-w-[72ch] text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]'
const SECTION_TITLE =
  'm-0 mb-2 text-sm font-semibold text-[color:var(--color-secondary-foreground)]'
const FIELD_LABEL = 'text-sm text-[color:var(--color-secondary-foreground)]'
const SECTION_BOX = 'min-w-0 rounded-[6px] border border-border bg-background p-3'
const NOTE_TEXT =
  'm-0 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]'
const INLINE_ACTIONS = 'flex flex-wrap items-center gap-3'

function formatTime(value: string | null): string {
  return value ?? '待定'
}

function formatDuration(value: number | null): string {
  if (value === null) return '未填停留'
  return `${value} 分钟`
}

function formatDistance(value: number | null): string {
  if (value === null) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${value} m`
}

function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && (err as { kind?: unknown }).kind !== undefined
}

/**
 * 生成候选时的上下文签名（只留在客户端内存，不进请求 / 日志 / Storage）：
 * 行程完整内容（render 期安全序列化，同对象内容修改也会改变签名）+ 原始输入
 * （指令 / 方式 / 人数 / 范围 / 锚点）+ trip id / revision / day 绑定。
 * 序列化失败返回 null：不可验证的上下文一律按已变化处理（fail closed）。
 */
function contextSignature(
  trip: Trip,
  dayNumber: number,
  revision: number,
  inputs: {
    instruction: string
    mode: TravelMode | ''
    travelers: string
    rangeMode: 'whole' | 'tail'
    anchorId: string
  },
): string | null {
  try {
    return JSON.stringify({
      trip: JSON.stringify(trip),
      dayNumber,
      revision,
      inputs: [inputs.instruction, inputs.mode, inputs.travelers, inputs.rangeMode, inputs.anchorId],
    })
  } catch {
    return null
  }
}

/** 与请求一致的 day 条目；找不到返回 null（构造阶段已经挡住，防御性兜底）。 */
function targetDay(trip: Trip, dayNumber: number): TripDay | null {
  const matches = trip.days.filter((day) => day.day === dayNumber)
  return matches.length === 1 ? matches[0] : null
}

/** 候选与本面板当前目标是否仍然一致；生成路径已由 seq 与 validate 覆盖，此导出供测试/父级核对复用。 */
export function candidateMatches(
  request: DayReplanRequest,
  response: DayReplanResponse,
  trip: Trip,
  revision: number,
): boolean {
  return (
    request.parent.trip_id === trip.id &&
    request.parent.revision === revision &&
    response.parent.trip_id === trip.id &&
    response.parent.revision === revision &&
    response.day.day === request.day &&
    response.day.date === request.date &&
    response.source === 'agent'
  )
}

function modeLabel(mode: TravelMode): string {
  return mode === 'walking' ? '步行' : '驾车'
}

/** 衔接路线查询失败 → 可展示文案；typed 状态原因原样可信（后端固定安全文案）。 */
function boundaryErrorText(err: unknown): string {
  if (isApiError(err)) {
    switch (err.kind) {
      case 'timeout':
        return '衔接路线查询超时，本次未返回路线。可以重新获取，或仅应用后段（衔接未知）。'
      case 'abort':
        return '已停止等待衔接路线，本次未返回路线。'
      case 'network':
        return '连接不上后端服务，无法查询衔接路线。可以稍后重试，或仅应用后段（衔接未知）。'
      case 'server':
        return '衔接路线服务暂时不可用，本次未返回路线。可以稍后重试，或仅应用后段（衔接未知）。'
      case 'bad_payload':
        return '衔接路线返回没有通过完整性检查，本次结果不使用。可以重新获取，或仅应用后段（衔接未知）。'
    }
  }
  return '衔接路线查询出现问题，本次未返回路线。可以重新获取，或仅应用后段（衔接未知）。'
}

export default function DayReplanPanel({
  trip,
  dayNumber,
  revision,
  plannerAvailability = 'unknown',
  requestDay,
  onApply,
  onClose,
  refreshTailLeg,
  planningContext = null,
  liveInputRef,
  onPlanningInputChanged,
}: DayReplanPanelProps) {
  const instructionId = useId()
  const instructionErrorId = `${instructionId}-error`
  const modeGroupId = useId()
  const travelersId = useId()
  const travelersErrorId = `${travelersId}-error`
  const rangeGroupId = useId()
  const anchorSelectId = useId()

  const day = targetDay(trip, dayNumber)
  const plannerUnavailable = plannerAvailability === 'unavailable'

  // 本日旧模式一致时预选；混合模式默认空，必须用户显式选。
  const initialMode = useMemo<TravelMode | ''>(() => {
    if (!day) return ''
    const modes = new Set(day.legs.map((leg) => leg.mode))
    if (modes.size === 1) return [...modes][0]
    return ''
  }, [day])

  const [instruction, setInstruction] = useState('')
  const [mode, setMode] = useState<TravelMode | ''>(initialMode)
  /** 范围模式：whole=整天（默认，旧行为）；tail=某站之后（显式选择）。 */
  const [rangeMode, setRangeMode] = useState<'whole' | 'tail'>('whole')
  /** 后段模式下的锚点站 id；空串表示未选。 */
  const [anchorId, setAnchorId] = useState('')
  /**
   * 同行人数（选填）：用字符串保存输入，留空就完全不往请求里写。
   * 不从旧行程或规划表单猜人数，也不默认 1。
   */
  const [travelers, setTravelers] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)
  const [candidate, setCandidate] = useState<{
    request: DayReplanRequest
    response: DayReplanResponse
    /** 整天候选为 null；后段候选记录生成时的 scope。 */
    scope: DayReplanTailScope | null
    /** 生成时的输入指纹序号；之后任何输入变化都使候选过期。 */
    inputEpoch: number
    /** 生成时的上下文内容版本；之后行程内容 / revision / day / 输入渲染值变化都使候选过期。 */
    contentEpoch: number
  } | null>(null)
  const [candidateInvalid, setCandidateInvalid] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<ApplyError | null>(null)
  const [showAllWarnings, setShowAllWarnings] = useState(false)

  /* ───────── 边界衔接路线（固定端点单段查询）状态与归属守卫 ───────── */

  /**
   * 已绑定成功的衔接路线（owner + request + ready response）；只存面板内存，
   * 不写 Trip / draft / budget / Storage。原 Trip / 候选 / scope 失效即随之失效。
   * epochs/身份守卫与处理函数在下方 contentEpochRef / inputEpoch 就绪之后定义。
   */
  const [boundaryEntry, setBoundaryEntry] = useState<TailBoundarySelection | null>(null)
  const [boundaryPending, setBoundaryPending] = useState(false)
  const [boundaryError, setBoundaryError] = useState<string | null>(null)
  const [boundaryNotice, setBoundaryNotice] = useState<string | null>(null)
  /** 衔接路线查询独立序号与 abort：与候选模型请求互不影响。 */
  const boundarySeqRef = useRef(0)
  const boundaryAbortRef = useRef<AbortController | null>(null)
  /**
   * 边界路线归属版本（单调）：trip / 候选响应 / scope 任一对象引用（Object.is）、
   * revision、day 变化即 +1；A→B→A 回到旧值也再 +1，永不复活。渲染期推进，不等 effect。
   */
  const boundaryEpochRef = useRef(0)
  const lastBoundaryIdentityRef = useRef<unknown[] | null>(null)

  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  /** 输入指纹的单调序号：指令/方式/人数/范围/锚点任何变化都 +1，旧候选永久作废（A-B-A 不复活）。 */
  const [inputEpoch, setInputEpoch] = useState(0)
  /**
   * 渲染期计算上下文内容签名：行程完整内容（同对象内容修改也会改变签名）+ 原始输入
   * + trip id / revision / day 绑定。只留在客户端内存，不进请求 / 日志 / Storage。
   * 序列化失败为 null：不可验证的上下文一律 fail closed（生成前拒绝、迟到结果丢弃）。
   */
  const signature = contextSignature(trip, dayNumber, revision, {
    instruction,
    mode,
    travelers,
    rangeMode,
    anchorId,
  })
  /**
   * 上下文内容版本（单调）：渲染时与上一渲染的签名比较，任一变化 +1。
   * 同对象内容修改、effect 尚未运行的输入变化都在这里被抓住；A→B→A 签名回到旧值
   * 也会再次 +1，永不复活。签名 null（不可序列化）同样计入版本变化，fail closed。
   */
  const contentEpochRef = useRef(0)
  const prevSignatureRef = useRef<string | null>(signature)
  if (prevSignatureRef.current !== signature) {
    prevSignatureRef.current = signature
    contentEpochRef.current += 1
  }
  /**
   * 最新上下文（每次渲染同步更新，捕获基元版本号，不自比旧对象）：
   * 迟到的成功/失败即使赶在 effect 之前返回，也必须与生成时捕获的内容版本与输入序号
   * 一致；inputEpoch 由 effect 单调递增，内容等值也不会复活。
   */
  const ctxRef = useRef<{ contentEpoch: number; epoch: number }>({
    contentEpoch: contentEpochRef.current,
    epoch: inputEpoch,
  })
  ctxRef.current = { contentEpoch: contentEpochRef.current, epoch: inputEpoch }
  /** 实时输入快照（每次渲染整体替换，捕获基元代际）：App U 确认的同步 final guard 依据。 */
  if (liveInputRef !== undefined) {
    liveInputRef.current = {
      trip,
      revision,
      dayNumber,
      contentEpoch: contentEpochRef.current,
      inputEpoch,
    }
  }

  /* ───────── 边界衔接路线：epochs/身份守卫（在 contentEpoch/inputEpoch 就绪后） ───────── */

  // 渲染期推进 boundaryEpoch：不等 effect，同帧锁两类 apply 与旧路线预览。
  const boundaryIdentity = [
    trip,
    candidate?.response ?? null,
    candidate?.scope ?? null,
    revision,
    dayNumber,
  ]
  const lastBoundaryIdentity = lastBoundaryIdentityRef.current
  let boundaryIdentityChanged = true
  if (lastBoundaryIdentity !== null && lastBoundaryIdentity.length === boundaryIdentity.length) {
    boundaryIdentityChanged = false
    for (let i = 0; i < boundaryIdentity.length; i += 1) {
      if (!Object.is(lastBoundaryIdentity[i], boundaryIdentity[i])) {
        boundaryIdentityChanged = true
        break
      }
    }
  }
  if (boundaryIdentityChanged) {
    boundaryEpochRef.current += 1
    lastBoundaryIdentityRef.current = boundaryIdentity
  }

  /**
   * 当前实时上下文（每次渲染重建，绝不从 boundary.owner.captured 读取）：
   * 引用 + revision + 三个单调 epoch，供 build/bind/compose/onApply 独立传入。
   */
  const boundaryCurrent: TailBoundaryCurrent = {
    trip,
    candidate: candidate?.response ?? (null as unknown as DayReplanResponse),
    scope: candidate?.scope ?? (null as unknown as DayReplanTailScope),
    revision,
    contentEpoch: contentEpochRef.current,
    inputEpoch,
    boundaryEpoch: boundaryEpochRef.current,
  }
  const boundaryCurrentRef = useRef(boundaryCurrent)
  boundaryCurrentRef.current = boundaryCurrent

  // 归属引用/epoch 守卫；candidateStale 在下方定义后由 currentBoundary 合成“非 stale”。
  const boundaryEpochOk =
    boundaryEntry !== null &&
    boundaryEntry.owner.trip === trip &&
    boundaryEntry.owner.candidate === (candidate?.response ?? null) &&
    boundaryEntry.owner.scope === (candidate?.scope ?? null) &&
    boundaryEntry.owner.captured.boundaryEpoch === boundaryEpochRef.current &&
    boundaryEntry.owner.captured.contentEpoch === contentEpochRef.current &&
    boundaryEntry.owner.captured.inputEpoch === inputEpoch

  // 归属变化 / 卸载：abort 在途路线请求并复位路线状态（展示正确性由渲染期守卫兜底）。
  useEffect(() => {
    boundarySeqRef.current += 1
    boundaryAbortRef.current?.abort()
    boundaryAbortRef.current = null
    setBoundaryPending(false)
    setBoundaryError(null)
    setBoundaryEntry(null)
    setBoundaryNotice(null)
    return () => {
      boundarySeqRef.current += 1
      boundaryAbortRef.current?.abort()
      boundaryAbortRef.current = null
    }
  }, [trip, revision, dayNumber, boundaryEpochRef.current])

  // trip 对象 / revision / day 变化：abort 在途请求、作废候选；指令保留供核对。
  useEffect(() => {
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setCandidate(null)
    setCandidateInvalid(null)
    setError(null)
    setApplyError(null)
    setShowAllWarnings(false)
    return () => {
      seqRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [trip, revision, dayNumber])

  useEffect(() => {
    setInputEpoch((epoch) => epoch + 1)
  }, [instruction, mode, travelers, rangeMode, anchorId])

  // 输入 / 上下文代际变化通知（可选）：App 清除挂起的 U 级确认。
  // 代际本身在渲染期同步推进；这里只负责让父级 UI 及时收起旧确认入口。
  const liveInputNotifyRef = useRef(onPlanningInputChanged)
  liveInputNotifyRef.current = onPlanningInputChanged
  const liveEpochKey = `${contentEpochRef.current}|${inputEpoch}`
  const liveEpochKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const previous = liveEpochKeyRef.current
    liveEpochKeyRef.current = liveEpochKey
    if (previous !== null && previous !== liveEpochKey) {
      liveInputNotifyRef.current?.()
    }
  }, [liveEpochKey])

  // 范围模式或锚点变化：直接清掉旧候选与预览——后段候选不能被当成整天候选继续用，
  // 反之亦然；换锚点后的旧后段候选也作废。
  useEffect(() => {
    setCandidate(null)
    setCandidateInvalid(null)
    setApplyError(null)
  }, [rangeMode, anchorId])

  useEffect(() => {
    setMode(initialMode)
  }, [initialMode])

  const instructionTooLong = instruction.length > 500
  const instructionEmpty = instruction.trim().length === 0
  const travelersText = travelers.trim()
  const travelersDigits = /^\d+$/.test(travelersText)
  const travelersValue = travelersText === '' ? null : travelersDigits ? Number(travelersText) : null
  const travelersInvalid =
    travelersText !== '' &&
    (travelersValue === null || travelersValue < 1 || travelersValue > MAX_REPLAN_TRAVELERS)
  // 后段模式额外要求锚点已选且不是末站；整天模式不看锚点。
  const anchorIndexSelected =
    rangeMode === 'whole'
      ? 0
      : day
        ? day.stops.findIndex((stop) => stop.id === anchorId)
        : -1
  const tailAnchorReady =
    rangeMode === 'whole' ||
    (anchorIndexSelected >= 0 && day !== null && anchorIndexSelected < day.stops.length - 1)
  const canGenerate =
    Boolean(day) &&
    !plannerUnavailable &&
    !pending &&
    !instructionEmpty &&
    !instructionTooLong &&
    !travelersInvalid &&
    mode !== '' &&
    tailAnchorReady

  function stopWaiting() {
    // 作废在途请求：seq 递增后，即使 adapter 忽略 abort 迟迟不落定，
    // 它的迟到结果也会被丢弃；面板不再等它，用户可以重新生成。
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
  }

  async function handleGenerate() {
    if (!day || pending || plannerUnavailable || travelersInvalid) return
    const options = {
      travel_mode: mode as TravelMode,
      parentRevision: revision,
      travelers: travelersValue,
    }
    // 整天走旧 build；后段走新 build（含固定范围说明合并与 scope 记录）。
    if (rangeMode === 'tail') {
      const builtTail = buildDayReplanTailRequest(trip, dayNumber, instruction, anchorIndexSelected, options)
      if (!builtTail.ok) {
        setError({ kind: 'build', message: builtTail.message })
        return
      }
      const planning = buildPlanningConstraints(builtTail.scope)
      if (!planning.ok) {
        setError({ kind: 'build', message: planning.message })
        return
      }
      await runGenerate(builtTail.request, builtTail.scope, planning.value)
      return
    }
    const built = buildDayReplanRequest(trip, dayNumber, instruction, options)
    if (!built.ok) {
      setError({ kind: 'build', message: built.message })
      return
    }
    const planning = buildPlanningConstraints(null)
    if (!planning.ok) {
      setError({ kind: 'build', message: planning.message })
      return
    }
    await runGenerate(built.request, null, planning.value)
  }

  /**
   * 请求前从父级捕获的 planning context 生成显式 scope / binding。
   * 不解析 instruction，不把整天当后段；上下文引用或 revision 变化直接拒绝。
   */
  function buildPlanningConstraints(
    scope: DayReplanTailScope | null,
  ):
    | { ok: true; value: DayReplanConstraintsOptions | undefined }
    | { ok: false; message: string } {
    if (planningContext === null) return { ok: true, value: undefined }
    if (planningContext.record.trip !== trip) {
      return {
        ok: false,
        message: '当前工作区行程对象已变化；本次没有发起请求，请关闭面板后重新打开。',
      }
    }
    if (planningContext.record.workspaceRevision !== revision) {
      return {
        ok: false,
        message: '当前工作区 revision 已变化；本次没有发起请求，请关闭面板后重新打开。',
      }
    }
    const planScope: PlanScopeV1 =
      scope === null
        ? { scope: 'day', day: dayNumber, anchorStopId: null }
        : { scope: 'day_tail', day: scope.day, anchorStopId: scope.anchorStopId }
    const binding = planningContext.createBinding(planScope)
    if (!binding.ok) return { ok: false, message: binding.message }
    return {
      ok: true,
      value: {
        constraints: planningContext.constraints,
        scope: planScope,
        record: planningContext.record,
        binding: binding.value,
        epoch: planningContext.epoch,
      },
    }
  }

  async function runGenerate(
    request: DayReplanRequest,
    scope: DayReplanTailScope | null,
    planningConstraints: DayReplanConstraintsOptions | undefined,
  ) {
    const epochAtGenerate = inputEpoch
    const ctxAtGenerate = ctxRef.current
    // 上下文不可序列化（签名 null）时 fail closed：不发起请求。
    if (signature === null) {
      setError({
        kind: 'build',
        message: '当前行程数据无法安全核对，不能生成调整候选。请检查行程内容后重试。',
      })
      return
    }
    const seq = seqRef.current + 1
    seqRef.current = seq
    const controller = new AbortController()
    abortRef.current = controller
    setPending(true)
    setError(null)
    setApplyError(null)
    setCandidate(null)
    setCandidateInvalid(null)
    setShowAllWarnings(false)
    try {
      const response = await (requestDay ?? replanDay)(request, {
        signal: controller.signal,
        ...(planningConstraints === undefined ? {} : { planningConstraints }),
      })
      if (seqRef.current !== seq || controller.signal.aborted) return
      // 最新上下文核对（render 期内容版本 + 输入序号）：行程内容（含同对象修改）/
      // revision / day / 原始输入任一渲染变化都作废，即使变化还没来得及触发 effect。
      const ctxNow = ctxRef.current
      if (
        ctxNow.contentEpoch !== ctxAtGenerate.contentEpoch ||
        ctxNow.epoch !== ctxAtGenerate.epoch
      ) {
        return
      }
      // 展示前再核对一次完整契约：不过关的响应不进预览。
      const validated = validateDayReplanResponse(response, request)
      if (!validated.ok) {
        setError({ kind: 'bad_payload', message: '返回的结果没有通过完整性检查，本次未生成候选。可以重新生成试试。' })
        return
      }
      setCandidate({ request, response: validated.response, scope, inputEpoch: epochAtGenerate, contentEpoch: ctxAtGenerate.contentEpoch })
    } catch (err) {
      if (seqRef.current !== seq || controller.signal.aborted) return
      // 失败提示同样只落在生成时的上下文上：内容版本或输入序号已变化就静默丢弃，
      // 不覆盖新状态。
      const ctxNow = ctxRef.current
      if (
        ctxNow.contentEpoch !== ctxAtGenerate.contentEpoch ||
        ctxNow.epoch !== ctxAtGenerate.epoch
      ) {
        return
      }
      if (isApiError(err)) {
        switch (err.kind) {
          case 'timeout':
            setError({ kind: 'timeout', message: '等待 AI 结果超时，本次未生成候选。可以重新生成试试。' })
            break
          case 'abort':
            setError({ kind: 'abort', message: '已停止等待，本次未生成候选。' })
            break
          case 'network':
            setError({ kind: 'network', message: '连接不上后端服务，请确认服务已启动后再试。' })
            break
          case 'server':
            setError({
              kind: 'server',
              message:
                err.status === 503
                  ? 'AI 规划服务暂时不可用。本地编辑不受影响，稍后可以再试。'
                  : err.status === 502
                    ? 'AI 规划服务暂时无法访问。本地编辑不受影响，稍后可以再试。'
                    : 'AI 规划请求处理失败。本地编辑不受影响，稍后可以再试。',
            })
            break
          case 'bad_payload':
            setError({ kind: 'bad_payload', message: '返回的结果没有通过完整性检查，本次未生成候选。可以重新生成试试。' })
            break
        }
      } else if (err instanceof PlanningConstraintsError) {
        // 约束 wire 在 fetch 之前就被拒绝：明确说明，绝不丢下 constraints 静默重试。
        setError({ kind: 'build', message: `${err.message} 本次没有发起请求。` })
      } else {
        setError({ kind: 'network', message: '生成候选时出现问题，本地行程没有改动。可以重新生成试试。' })
      }
    } finally {
      if (seqRef.current === seq) {
        setPending(false)
        abortRef.current = null
      }
    }
  }

  function handleApply() {
    if (!candidate || candidateInvalid) return
    const result = onApply(candidate.request, candidate.response, candidate.scope ?? undefined)
    if (result.ok) {
      // 成功由父级关面板 / 换行程；这里不重复提示，也不再改状态。
      return
    }
    setApplyError({ message: result.message })
  }

  /* ───────── 边界衔接路线处理 ───────── */

  /** 显式获取衔接路线：一次点击恰一次请求；构造失败只显示原因，不发请求。 */
  async function handleQueryBoundary() {
    if (!candidate || candidate.scope === null || candidateInvalid || boundaryPending) return
    if (currentBoundary !== null) return // 已有有效路线，不需要再查
    const built = buildTailBoundaryRequest(
      trip,
      candidate.scope,
      candidate.response,
      revision,
      boundaryCurrentRef.current,
    )
    if (!built.ok) {
      setBoundaryError(built.message)
      return
    }
    const seq = boundarySeqRef.current + 1
    boundarySeqRef.current = seq
    const controller = new AbortController()
    boundaryAbortRef.current = controller
    setBoundaryPending(true)
    setBoundaryError(null)
    setBoundaryEntry(null)
    setBoundaryNotice(null)
    const requestAtStart = built.request
    const ownerAtStart = built.owner
    const currentAtStart = boundaryCurrentRef.current
    try {
      const response = await (refreshTailLeg ?? refreshLegRoute)(built.request, {
        signal: controller.signal,
      })
      if (
        boundarySeqRef.current !== seq ||
        controller.signal.aborted ||
        boundaryCurrentRef.current.boundaryEpoch !== currentAtStart.boundaryEpoch ||
        boundaryCurrentRef.current.contentEpoch !== currentAtStart.contentEpoch ||
        boundaryCurrentRef.current.inputEpoch !== currentAtStart.inputEpoch
      ) {
        return
      }
      const bound = bindTailBoundaryResponse(
        ownerAtStart,
        requestAtStart,
        response,
        boundaryCurrentRef.current,
      )
      if (!bound.ok) {
        setBoundaryError(bound.message)
        return
      }
      setBoundaryEntry(bound.selection)
    } catch (err) {
      if (
        boundarySeqRef.current !== seq ||
        controller.signal.aborted ||
        boundaryCurrentRef.current.boundaryEpoch !== currentAtStart.boundaryEpoch ||
        boundaryCurrentRef.current.contentEpoch !== currentAtStart.contentEpoch ||
        boundaryCurrentRef.current.inputEpoch !== currentAtStart.inputEpoch
      ) {
        return
      }
      setBoundaryError(boundaryErrorText(err))
    } finally {
      if (
        boundarySeqRef.current === seq &&
        boundaryCurrentRef.current.boundaryEpoch === currentAtStart.boundaryEpoch &&
        boundaryCurrentRef.current.contentEpoch === currentAtStart.contentEpoch &&
        boundaryCurrentRef.current.inputEpoch === currentAtStart.inputEpoch
      ) {
        setBoundaryPending(false)
        if (boundaryAbortRef.current === controller) boundaryAbortRef.current = null
      }
    }
  }

  /** 停止等待衔接路线：只取消本页等待与当前结果；不删 AI 候选、不复活失效状态。 */
  function stopBoundaryWaiting() {
    boundarySeqRef.current += 1
    boundaryAbortRef.current?.abort()
    boundaryAbortRef.current = null
    setBoundaryPending(false)
    setBoundaryEntry(null)
    setBoundaryNotice(
      candidateStale
        ? '已停止等待衔接路线；当前后段候选已失效，不能应用。'
        : '已停止等待衔接路线；后段候选仍在，可仅应用后段（衔接未知）。',
    )
  }

  /** 舍弃衔接路线：候选仍有效时回 unknown 预览；失效候选不受影响也不复活。 */
  function discardBoundary() {
    if (candidateStale) return
    setBoundaryEntry(null)
    setBoundaryPending(false)
    setBoundaryError(null)
    setBoundaryNotice(null)
  }

  /** 「仅应用后段（衔接未知）」：不带 boundary 走旧链路；失效 selection 绝不当 unknown。 */
  function handleApplyUnknown() {
    if (!candidate || candidateInvalid || candidateStale) return
    const result = onApply(candidate.request, candidate.response, candidate.scope ?? undefined)
    if (result.ok) return
    setApplyError({ message: result.message })
  }

  /** 「应用后段与衔接路线」：携带当前渲染的 boundary + 实时 current；失效直接显示错误。 */
  function handleApplyBoundary() {
    if (!candidate || candidateInvalid || candidateStale) return
    if (currentBoundary === null) {
      setApplyError({ message: '衔接路线已失效，不能应用；请重新获取，或仅应用后段（衔接未知）。' })
      return
    }
    const result = onApply(
      candidate.request,
      candidate.response,
      candidate.scope ?? undefined,
      currentBoundary,
      boundaryCurrentRef.current,
    )
    if (result.ok) return
    setApplyError({ message: result.message })
  }

  if (!day) {
    return (
      <section
        className="grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5"
        aria-label="AI 调整单日安排"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="m-0 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]">AI 调整单日安排</h3>
          <Button variant="outline" onClick={onClose}>
            收起
          </Button>
        </div>
        <Alert variant="warning" role="note">
          <AlertDescription>当前行程里没有这一天的安排，无法发起 AI 调整。原始行程保持不变。</AlertDescription>
        </Alert>
      </section>
    )
  }

  const currentCandidate = candidate && !candidateInvalid ? candidate.response : null
  const currentRequest = candidate && !candidateInvalid ? candidate.request : null
  const warnings = currentCandidate?.warnings ?? []
  const visibleWarnings = showAllWarnings ? warnings : warnings.slice(0, 3)
  const hiddenWarningCount = warnings.length - visibleWarnings.length
  const canApply = currentCandidate !== null && candidateInvalid === null && !pending

  // 生成之后任何变化都使候选永久过期（A-B-A 不复活）：
  // - inputEpoch 单调序号：指令/方式/人数/范围/锚点变化 +1（effect），不做内容等值判断；
  // - contentEpoch 单调版本：行程完整内容（含同对象修改）/ revision / day / 原始输入
  //   渲染值与生成时不一致即过期——effect 尚未运行的窗口由它兜住；A→B→A 签名回到
  //   旧值也再 +1，永不复活；签名 null（不可序列化）同样计入版本变化。
  const candidateStale =
    candidate !== null &&
    currentRequest !== null &&
    (candidate.inputEpoch !== inputEpoch ||
      candidate.contentEpoch !== contentEpochRef.current ||
      currentRequest.parent.revision !== revision)

  // 渲染期守卫（在 candidateStale 定义后合成）：失效归属的路线预览与两类 apply 同帧锁死。
  const currentBoundary: TailBoundarySelection | null =
    boundaryEpochOk && !candidateStale ? boundaryEntry : null

  // 查询按钮的前置条件：候选有效、无在途查询、无已绑定路线、锚点与候选首站都有
  // 合法记录坐标且 id 可用于衔接接口（≤100 字、非空白、无控制字符）——缺一禁用并解释。
  const boundaryQueryStops = (() => {
    if (candidate === null || candidate.scope === null) return null
    const baseDay = trip.days.find((d) => d.day === candidate.scope?.day) ?? null
    const anchorStop = baseDay?.stops[candidate.scope.keptCount - 1] ?? null
    const tailFirstStop = candidate.response.day.stops[0] ?? null
    return { anchorStop, tailFirstStop }
  })()
  const boundaryStopUsable = (stop: TripStop | null | undefined): boolean => {
    if (!stop || stop.location === null) return false
    const { lng, lat } = stop.location
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false
    if (stop.id.length < 1 || stop.id.length > 100 || stop.id.trim().length === 0) return false
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/.test(stop.id)) return false
    return true
  }
  const boundaryQueryReady =
    currentBoundary === null &&
    candidate !== null &&
    !candidateStale &&
    candidateInvalid === null &&
    !boundaryPending &&
    candidate.scope !== null &&
    boundaryStopUsable(boundaryQueryStops?.anchorStop) &&
    boundaryStopUsable(boundaryQueryStops?.tailFirstStop)

  return (
    <section
      className="grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5 max-md:p-4"
      aria-label="AI 调整单日安排"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_260px]">
          <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-foreground)]">只调整这一天，其余天保持原样</p>
          <h3 className="m-0 mb-2 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]">
            第 {day.day} 天{day.date ? `（${day.date}）` : ''}：{day.title || '当日安排'}
          </h3>
          <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
            {trip.title}
            {pending ? <Badge variant="warning" role="status">正在生成候选…</Badge> : null}
          </p>
        </div>
        <Button variant="outline" onClick={onClose} disabled={false}>
          收起
        </Button>
      </div>

      {plannerUnavailable ? (
        <Alert variant="warning" role="note">
          <AlertDescription>
            AI 规划当前不可用，无法生成调整候选。本地编辑不受影响，仍可手动调整这一天的安排。
          </AlertDescription>
        </Alert>
      ) : null}

      <fieldset className="m-0 grid min-w-0 gap-3 rounded-[10px] border border-border p-4 disabled:opacity-75" disabled={pending || plannerUnavailable}>
        <legend className="px-2 text-sm font-semibold text-[color:var(--color-secondary-foreground)]">想怎么调整这一天</legend>
        <div className="grid min-w-0 gap-1" role="radiogroup" aria-labelledby={rangeGroupId}>
          <span id={rangeGroupId} className={FIELD_LABEL}>调整范围</span>
          <label className="mr-4 inline-flex min-h-6 items-center gap-2 text-sm">
            <input
              type="radio"
              name="drp-range"
              value="whole"
              checked={rangeMode === 'whole'}
              onChange={() => setRangeMode('whole')}
              disabled={pending || plannerUnavailable}
              className="size-4 accent-[color:var(--color-primary)]"
            />
            整天（默认：整日按候选替换）
          </label>
          <label className="mr-4 inline-flex min-h-6 items-center gap-2 text-sm">
            <input
              type="radio"
              name="drp-range"
              value="tail"
              checked={rangeMode === 'tail'}
              onChange={() => setRangeMode('tail')}
              disabled={pending || plannerUnavailable || day.stops.length < 2}
              className="size-4 accent-[color:var(--color-primary)]"
            />
            某站之后（保留该站及之前，替换之后的部分）
          </label>
        </div>
        {rangeMode === 'tail' ? (
          <div className="grid min-w-0 gap-1">
            <label htmlFor={anchorSelectId} className={FIELD_LABEL}>保留到哪一站（锚点）</label>
            <Select
              id={anchorSelectId}
              value={anchorId}
              onChange={(event) => setAnchorId(event.target.value)}
              disabled={pending || plannerUnavailable}
              className="max-w-[200px]"
            >
              <option value="">请选择锚点站</option>
              {day.stops.slice(0, -1).map((stop, index) => (
                <option key={stop.id} value={stop.id}>
                  {`第 ${index + 1} 站：${stop.name}（保留第 1–${index + 1} 站）`}
                </option>
              ))}
            </Select>
            {day.stops.length >= 2 ? (
              <p className={PANEL_NOTE}>
                {`选中的锚点站及之前的 ${anchorId && anchorIndexSelected >= 0 ? anchorIndexSelected + 1 : 'N'} 站与站间路线会原样保留；之后的部分由 AI 候选替换，锚点到新后段第一站的衔接路线不会重算。`}
              </p>
            ) : (
              <p className={PANEL_NOTE}>{`这一天只有 ${day.stops.length} 个站点，没有可替换的后段；后段模式至少需要 2 个站点。`}</p>
            )}
          </div>
        ) : null}
        <div className="grid min-w-0 gap-1">
          <label htmlFor={instructionId} className={FIELD_LABEL}>调整指令（1–500 字）</label>
          <Textarea
            id={instructionId}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            rows={3}
            maxLength={600}
            placeholder="例如：下午加一个安静的茶园，减少步行距离"
            aria-describedby={instructionTooLong ? instructionErrorId : undefined}
            aria-invalid={instructionTooLong || instructionEmpty ? true : undefined}
          />
          <p className={PANEL_NOTE} aria-live="polite">
            {instruction.length}/500
            {instructionTooLong ? (
              <span id={instructionErrorId} className="text-[color:var(--color-accent-foreground)]"> 已超过 500 字，请删减后再生成。</span>
            ) : null}
          </p>
        </div>
        <div className="grid min-w-0 gap-1" role="radiogroup" aria-labelledby={modeGroupId}>
          <span id={modeGroupId} className={FIELD_LABEL}>出行方式</span>
          {(['walking', 'driving'] as const).map((value) => (
            <label key={value} className="mr-4 inline-flex min-h-6 items-center gap-2 text-sm">
              <input
                type="radio"
                name="drp-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                disabled={pending || plannerUnavailable}
                className="size-4 accent-[color:var(--color-primary)]"
              />
              {modeLabel(value)}
            </label>
          ))}
          {initialMode === '' ? (
            <p className={PANEL_NOTE}>
              {day.legs.length > 0
                ? '本日现有路线包含多种方式，请选择这一次使用的方式。'
                : '这一天还没有路段：请选择这一次希望使用的出行方式。'}
            </p>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-1">
          <label htmlFor={travelersId} className={FIELD_LABEL}>同行人数（选填）</label>
          <Input
            id={travelersId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={travelers}
            onChange={(event) => setTravelers(event.target.value)}
            placeholder="留空表示不填"
            aria-invalid={travelersInvalid || undefined}
            aria-describedby={travelersInvalid ? travelersErrorId : undefined}
            disabled={pending || plannerUnavailable}
            className="max-w-[200px]"
          />
          <p className={PANEL_NOTE}>
            1–{MAX_REPLAN_TRAVELERS} 的整数；留空不会发送人数，也不会沿用规划表单里的旧人数。修改后需要重新生成候选。
          </p>
          {travelersInvalid ? (
            <p id={travelersErrorId} className="m-0 max-w-[72ch] text-xs leading-relaxed text-[color:var(--color-accent-foreground)] [overflow-wrap:anywhere]" role="alert">
              同行人数需要是 1–{MAX_REPLAN_TRAVELERS} 的整数，或留空不填。
            </p>
          ) : null}
        </div>
        <div className={INLINE_ACTIONS}>
          <Button
            onClick={() => {
              void handleGenerate()
            }}
            disabled={!canGenerate}
          >
            生成调整候选
          </Button>
        </div>
        <p className={PANEL_NOTE}>点击生成才会请求一次 AI 调整；不会自动生成，也不会自动重试。</p>
      </fieldset>

      {pending ? (
        <div className={INLINE_ACTIONS}>
          <Button variant="outline" onClick={stopWaiting}>
            停止等待
          </Button>
          <p className={PANEL_NOTE}>已提交的请求会继续在服务端处理，停止等待只是不再等它，不保证后端停止计算。</p>
        </div>
      ) : null}

      {error ? (
        <Alert variant="warning" role="alert">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      {candidateStale ? (
        <Alert variant="warning" role="status">
          <AlertDescription>
            调整指令、出行方式或同行人数已经变化，下面的候选基于修改前的内容，不能直接应用；可按新内容重新生成。
          </AlertDescription>
        </Alert>
      ) : null}

      {currentCandidate && candidate?.scope && !candidateStale ? (
        <TailPreview
          trip={trip}
          scope={candidate.scope}
          response={currentCandidate}
          currentRevision={revision}
          currentDay={day}
          warnings={warnings}
          visibleWarnings={visibleWarnings}
          hiddenWarningCount={hiddenWarningCount}
          onShowAllWarnings={() => setShowAllWarnings(true)}
          applyError={applyError}
          canApply={canApply && !candidateStale}
          onDiscard={() => {
            setCandidate(null)
            setCandidateInvalid(null)
            setApplyError(null)
          }}
          boundaryEntry={currentBoundary}
          boundaryCurrent={boundaryCurrent}
          boundaryPending={boundaryPending}
          boundaryError={boundaryError}
          boundaryNotice={boundaryNotice}
          boundaryQueryReady={boundaryQueryReady}
          onQueryBoundary={() => {
            void handleQueryBoundary()
          }}
          onStopBoundary={stopBoundaryWaiting}
          onDiscardBoundary={discardBoundary}
          onApplyUnknown={handleApplyUnknown}
          onApplyBoundary={handleApplyBoundary}
        />
      ) : currentCandidate ? (
        <div className="grid min-w-0 gap-3 rounded-[10px] border border-[color:var(--color-line-strong)] p-4" aria-label="候选预览">
          <h4 className="m-0 font-display text-md">候选预览（尚未应用到行程）</h4>
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <div className={SECTION_BOX}>
              <h5 className={SECTION_TITLE}>当前方案</h5>
              <StopTable day={day} />
            </div>
            <div className={SECTION_BOX}>
              <h5 className={SECTION_TITLE}>AI 候选</h5>
              <StopTable day={currentCandidate.day} candidate />
            </div>
          </div>
          <p className={NOTE_TEXT}>
            <strong>地图数据：</strong>
            {MAP_STATUS_TEXT[currentCandidate.map_status]}
          </p>
          <RouteSummary day={currentCandidate.day} />
          {warnings.length > 0 ? (
            <div className="grid gap-2">
              <h5 className="m-0 text-sm font-semibold text-[color:var(--color-secondary-foreground)]">
                本次返回提醒（{warnings.length} 条）
              </h5>
              <ul className="m-0 grid list-disc gap-1 pl-5 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
                {visibleWarnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
              {hiddenWarningCount > 0 ? (
                <Button
                  variant="link"
                  onClick={() => setShowAllWarnings(true)}
                  aria-expanded={false}
                  className="self-start px-0"
                >
                  展开其余 {hiddenWarningCount} 条提醒
                </Button>
              ) : null}
            </div>
          ) : null}
          {applyError ? (
            <Alert variant="warning" role="alert">
              <AlertDescription>{applyError.message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-center gap-3 max-md:flex-col max-md:items-stretch [&>button]:max-md:w-full">
            <Button
              onClick={handleApply}
              disabled={!canApply || candidateStale}
            >
              应用候选
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setCandidate(null)
                setCandidateInvalid(null)
                setApplyError(null)
              }}
            >
              放弃候选
            </Button>
          </div>
          <p className={PANEL_NOTE}>应用候选只替换这一天的全部安排，其余天不变；应用前当前行程不会被改动，也不会自动保存。</p>
        </div>
      ) : null}
    </section>
  )
}

function StopTable({ day, candidate = false }: { day: TripDay; candidate?: boolean }) {
  if (day.stops.length === 0) {
    return <p className={PANEL_NOTE}>这一天没有站点安排。</p>
  }
  return (
    <ol className="m-0 grid list-none gap-3 p-0">
      {day.stops.map((stop) => {
        const leg = day.legs.find((item) => item.to_stop_id === stop.id)
        return (
          <li key={stop.id} className="min-w-0 [&>p]:m-0">
            {leg ? (
              <p className={`py-1 text-xs ${leg.route_type === 'navigation' ? 'text-[color:var(--color-ok)]' : leg.route_type === 'unavailable' ? 'text-[color:var(--color-warn-ink)]' : 'text-muted-foreground'}`}>
                {ROUTE_TEXT[leg.route_type]} · {modeLabel(leg.mode)} · {formatDistance(leg.distance_m)}
                {leg.duration_minutes !== null ? ` · 约 ${leg.duration_minutes} 分钟` : ''}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              <span className="font-mono tabular-nums text-[color:var(--color-secondary-foreground)]">{formatTime(stop.time)}</span> · {formatDuration(stop.duration_minutes)}
            </p>
            <p className="text-base [overflow-wrap:anywhere]">{stop.name}</p>
            {candidate && stop.location === null ? (
              <p className="mt-1 text-xs text-[color:var(--color-warn-ink)]">该站点暂无坐标，地图不绘制此点。</p>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function RouteSummary({ day }: { day: TripDay }) {
  const navigable = day.legs.filter((leg) => leg.route_type !== 'unavailable')
  const unavailable = day.legs.length - navigable.length
  if (day.legs.length === 0) return null
  return (
    <p className={PANEL_NOTE}>
      路线概况：{day.legs.length} 段中 {navigable.length} 段有路线数据
      {unavailable > 0 ? `，${unavailable} 段待获取` : ''}。时刻与耗时为计划值，不代表实测交通或预约结果。
    </p>
  )
}

/**
 * 后段候选预览：区分冻结前段（原记录）与 AI 新后段（候选），
 * 展示衔接未知与数据来源边界；组合日由 composeTailPreviewDay 统一计算，
 * 与应用路径同一套检查与拼装。
 */
function TailPreview({
  trip,
  scope,
  response,
  currentRevision,
  currentDay,
  warnings,
  visibleWarnings,
  hiddenWarningCount,
  onShowAllWarnings,
  applyError,
  canApply,
  onDiscard,
  boundaryEntry,
  boundaryCurrent,
  boundaryPending,
  boundaryError,
  boundaryNotice,
  boundaryQueryReady,
  onQueryBoundary,
  onStopBoundary,
  onDiscardBoundary,
  onApplyUnknown,
  onApplyBoundary,
}: {
  trip: Trip
  scope: DayReplanTailScope
  response: DayReplanResponse
  /** 界面当前 revision：预览前用它（而非 scope 自带 revision）核对范围仍有效。 */
  currentRevision: number
  currentDay: TripDay
  warnings: string[]
  visibleWarnings: string[]
  hiddenWarningCount: number
  onShowAllWarnings: () => void
  applyError: ApplyError | null
  canApply: boolean
  onDiscard: () => void
  /** 当前仍有效的衔接路线；null 表示尚无路线或已失效（渲染期守卫结果）。 */
  boundaryEntry: TailBoundarySelection | null
  /** 当前实时上下文；带 boundary 的 compose 必须传入，纯层要求 current 与 boundary 成对。 */
  boundaryCurrent: TailBoundaryCurrent
  boundaryPending: boolean
  boundaryError: string | null
  boundaryNotice: string | null
  /** 是否允许发起衔接路线查询（候选有效且无在途查询）。 */
  boundaryQueryReady: boolean
  onQueryBoundary: () => void
  onStopBoundary: () => void
  onDiscardBoundary: () => void
  onApplyUnknown: () => void
  onApplyBoundary: () => void
}) {
  // 带 boundary 时用同一纯组合（失效 selection 会让 composed 失败，绝不降级 unknown 预览）。
  const composed = composeTailPreviewDay(
    trip,
    scope,
    response,
    currentRevision,
    boundaryEntry ?? undefined,
    boundaryEntry !== undefined ? boundaryCurrent : undefined,
  )
  if (!composed.ok) {
    return (
      <Alert variant="warning" role="alert">
        <AlertDescription>{composed.message}</AlertDescription>
      </Alert>
    )
  }
  const keptDay: TripDay = {
    day: currentDay.day,
    date: currentDay.date,
    title: currentDay.title,
    summary: currentDay.summary,
    stops: currentDay.stops.slice(0, scope.keptCount),
    legs: currentDay.legs.slice(0, Math.max(scope.keptCount - 1, 0)),
  }
  const boundaryLeg = composed.day.legs[scope.keptCount - 1]
  const hasBoundaryRoute = boundaryLeg !== undefined && boundaryLeg.route_type === 'navigation'
  return (
    <div className="grid min-w-0 gap-3 rounded-[10px] border border-[color:var(--color-line-strong)] p-4" aria-label="候选预览">
      <h4 className="m-0 font-display text-md">后段候选预览（尚未应用到行程）</h4>
      <p className={PANEL_NOTE}>
        {`本日前 ${composed.keptCount} 站原样保留（冻结段），之后 ${composed.tailStopCount} 站来自 AI 候选（新后段）；下面的组合方案只用于预览，不代表已应用。`}
      </p>
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <div className={SECTION_BOX}>
          <h5 className={SECTION_TITLE}>{`冻结保留（前 ${composed.keptCount} 站，原记录）`}</h5>
          <StopTable day={keptDay} />
        </div>
        <div className={SECTION_BOX}>
          <h5 className={SECTION_TITLE}>组合方案（冻结段 + AI 新后段）</h5>
          <StopTable day={composed.day} candidate />
        </div>
      </div>
      {composed.notices.map((notice, index) => (
        <Alert key={index} variant="warning" role="note">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ))}
      {hasBoundaryRoute ? (
        <Alert variant="warning" role="note">
          <AlertDescription>
            {`衔接路线来源：高德地图（WGS84），按两端记录坐标取得；未重新核对地址或地点身份，也不代表实时交通。距离 ${boundaryLeg.distance_m ?? '未知'} 米、耗时${boundaryLeg.duration_minutes == null ? '未知' : `约 ${boundaryLeg.duration_minutes} 分钟`}。`}
          </AlertDescription>
        </Alert>
      ) : null}
      <p className={NOTE_TEXT}>
        <strong>组合后地图数据：</strong>
        {MAP_STATUS_TEXT[composed.mapStatus]}
      </p>
      <p className={NOTE_TEXT}>
        <strong>原始后段地图数据（AI 返回时）：</strong>
        {MAP_STATUS_TEXT[response.map_status]}
      </p>
      <RouteSummary day={composed.day} />
      {warnings.length > 0 ? (
        <div className="grid gap-2">
          <h5 className="m-0 text-sm font-semibold text-[color:var(--color-secondary-foreground)]">{`本次返回提醒（${warnings.length} 条）`}</h5>
          <ul className="m-0 grid list-disc gap-1 pl-5 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
            {visibleWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          {hiddenWarningCount > 0 ? (
            <Button
              variant="link"
              onClick={onShowAllWarnings}
              aria-expanded={false}
              className="self-start px-0"
            >
              {`展开其余 ${hiddenWarningCount} 条提醒`}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* ───────── 衔接路线查询（显式一次，无自动请求/重试） ───────── */}
      {boundaryPending ? (
        <div className={INLINE_ACTIONS}>
          <Button variant="outline" onClick={onStopBoundary}>
            停止等待衔接路线
          </Button>
          <p className={PANEL_NOTE}>
            已提交的衔接路线查询会继续在服务端处理；停止等待只是不再等它，不保证后端或上游已停止或不计费。
          </p>
        </div>
      ) : null}
      {boundaryError ? (
        <Alert variant="warning" role="alert">
          <AlertDescription>{boundaryError}</AlertDescription>
        </Alert>
      ) : null}
      {boundaryNotice ? (
        <Alert variant="warning" role="note">
          <AlertDescription>{boundaryNotice}</AlertDescription>
        </Alert>
      ) : null}
      {!hasBoundaryRoute && !boundaryPending ? (
        <div className={INLINE_ACTIONS}>
          <Button
            variant="outline"
            onClick={onQueryBoundary}
            disabled={!boundaryQueryReady}
          >
            获取衔接路线
          </Button>
          {!boundaryQueryReady ? (
            <p className={PANEL_NOTE}>
              锚点或新后段首站缺少记录坐标（或站点 id 无法用于衔接查询）：无法按固定端点查询衔接路线；不会按地址重新定位、不会改名或截断、不会把缺失补成
              0。仍可仅应用后段（衔接未知）。
            </p>
          ) : (
            <p className={PANEL_NOTE}>
              按锚点与新后段首站记录的 WGS84 坐标向高德地图查询一次衔接路线（walking/driving
              与候选范围一致）；不会重新定位地址。不会自动查询或重试。
            </p>
          )}
        </div>
      ) : null}
      {hasBoundaryRoute ? (
        <div className={INLINE_ACTIONS}>
          <Button variant="outline" onClick={onDiscardBoundary}>
            舍弃衔接路线
          </Button>
          <p className={PANEL_NOTE}>舍弃后回到「衔接路线未重算」的候选预览，可重新显式获取。</p>
        </div>
      ) : null}

      {applyError ? (
        <Alert variant="warning" role="alert">
          <AlertDescription>{applyError.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 max-md:flex-col max-md:items-stretch [&>button]:max-md:w-full">
        {hasBoundaryRoute ? (
          <Button
            onClick={onApplyBoundary}
            disabled={!canApply || boundaryPending}
          >
            应用后段与衔接路线
          </Button>
        ) : null}
        <Button
          variant="outline"
          onClick={onApplyUnknown}
          disabled={!canApply || boundaryPending}
        >
          仅应用后段（衔接未知）
        </Button>
        <Button variant="outline" onClick={onDiscard}>
          放弃候选
        </Button>
      </div>
      <p className={PANEL_NOTE}>
        {hasBoundaryRoute
          ? '「应用后段与衔接路线」会把锚点到新后段首站的衔接路线一并应用：前段站点、时刻与站间路线原样保留，其它天不变；衔接路线按两端记录坐标取得，未核对地点身份。'
          : '「仅应用后段（衔接未知）」只替换锚点之后的部分：前段站点、时刻与站间路线原样保留，其它天不变；锚点衔接路线未重算。'}{' '}
        应用前当前行程不会被改动，也不会自动保存。
      </p>
    </div>
  )
}

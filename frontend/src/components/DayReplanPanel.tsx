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

import type { ApiError, Trip, TripDay, TravelMode } from '../lib/api'
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
  buildDayReplanTailRequest,
  composeTailPreviewDay,
  type DayReplanTailApplyResult,
  type DayReplanTailScope,
} from '../lib/dayReplanTail'
import './dayReplanPanel.css'

export type DayReplanAdapter = (
  request: DayReplanRequest,
  options?: { signal?: AbortSignal },
) => Promise<DayReplanResponse>

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
  ) => DayReplanApplyResult | DayReplanTailApplyResult
  /** 关闭面板：只放弃候选 / 停止等待，不改旧行程。 */
  onClose: () => void
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

export default function DayReplanPanel({
  trip,
  dayNumber,
  revision,
  plannerAvailability = 'unknown',
  requestDay,
  onApply,
  onClose,
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
      await runGenerate(builtTail.request, builtTail.scope)
      return
    }
    const built = buildDayReplanRequest(trip, dayNumber, instruction, options)
    if (!built.ok) {
      setError({ kind: 'build', message: built.message })
      return
    }
    await runGenerate(built.request, null)
  }

  async function runGenerate(request: DayReplanRequest, scope: DayReplanTailScope | null) {
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
      const response = await (requestDay ?? replanDay)(request, { signal: controller.signal })
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

  if (!day) {
    return (
      <section className="drp" aria-label="AI 调整单日安排">
        <div className="drp-head">
          <h3 className="drp-title">AI 调整单日安排</h3>
          <button type="button" className="drp-btn" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="drp-notice">当前行程里没有这一天的安排，无法发起 AI 调整。原始行程保持不变。</p>
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

  return (
    <section className="drp" aria-label="AI 调整单日安排">
      <div className="drp-head">
        <div className="drp-head-main">
          <p className="drp-eyebrow">只调整这一天，其余天保持原样</p>
          <h3 className="drp-title">
            第 {day.day} 天{day.date ? `（${day.date}）` : ''}：{day.title || '当日安排'}
          </h3>
          <p className="drp-meta">
            {trip.title}
            {pending ? <span className="drp-tag" role="status">正在生成候选…</span> : null}
          </p>
        </div>
        <button type="button" className="drp-btn" onClick={onClose} disabled={false}>
          关闭
        </button>
      </div>

      {plannerUnavailable ? (
        <p className="drp-notice" role="note">
          AI 规划当前不可用，无法生成调整候选。本地编辑不受影响，仍可手动调整这一天的安排。
        </p>
      ) : null}

      <fieldset className="drp-form" disabled={pending || plannerUnavailable}>
        <legend className="drp-form-legend">想怎么调整这一天</legend>
        <div className="drp-field" role="radiogroup" aria-labelledby={rangeGroupId}>
          <span id={rangeGroupId} className="drp-label">调整范围</span>
          <label className="drp-radio">
            <input
              type="radio"
              name="drp-range"
              value="whole"
              checked={rangeMode === 'whole'}
              onChange={() => setRangeMode('whole')}
              disabled={pending || plannerUnavailable}
            />
            整天（默认：整日按候选替换）
          </label>
          <label className="drp-radio">
            <input
              type="radio"
              name="drp-range"
              value="tail"
              checked={rangeMode === 'tail'}
              onChange={() => setRangeMode('tail')}
              disabled={pending || plannerUnavailable || day.stops.length < 2}
            />
            某站之后（保留该站及之前，替换之后的部分）
          </label>
        </div>
        {rangeMode === 'tail' ? (
          <div className="drp-field">
            <label htmlFor={anchorSelectId}>保留到哪一站（锚点）</label>
            <select
              id={anchorSelectId}
              value={anchorId}
              onChange={(event) => setAnchorId(event.target.value)}
              disabled={pending || plannerUnavailable}
            >
              <option value="">请选择锚点站</option>
              {day.stops.slice(0, -1).map((stop, index) => (
                <option key={stop.id} value={stop.id}>
                  {`第 ${index + 1} 站：${stop.name}（保留第 1–${index + 1} 站）`}
                </option>
              ))}
            </select>
            {day.stops.length >= 2 ? (
              <p className="drp-hint">
                {`选中的锚点站及之前的 ${anchorId && anchorIndexSelected >= 0 ? anchorIndexSelected + 1 : 'N'} 站与站间路线会原样保留；之后的部分由 AI 候选替换，锚点到新后段第一站的衔接路线不会重算。`}
              </p>
            ) : (
              <p className="drp-hint">{`这一天只有 ${day.stops.length} 个站点，没有可替换的后段；后段模式至少需要 2 个站点。`}</p>
            )}
          </div>
        ) : null}
        <div className="drp-field">
          <label htmlFor={instructionId}>调整指令（1–500 字）</label>
          <textarea
            id={instructionId}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            rows={3}
            maxLength={600}
            placeholder="例如：下午加一个安静的茶园，减少步行距离"
            aria-describedby={instructionTooLong ? instructionErrorId : undefined}
            aria-invalid={instructionTooLong || instructionEmpty ? true : undefined}
          />
          <p className="drp-hint" aria-live="polite">
            {instruction.length}/500
            {instructionTooLong ? (
              <span id={instructionErrorId} className="drp-error-text"> 已超过 500 字，请删减后再生成。</span>
            ) : null}
          </p>
        </div>
        <div className="drp-field" role="radiogroup" aria-labelledby={modeGroupId}>
          <span id={modeGroupId} className="drp-label">出行方式</span>
          {(['walking', 'driving'] as const).map((value) => (
            <label key={value} className="drp-radio">
              <input
                type="radio"
                name="drp-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
                disabled={pending || plannerUnavailable}
              />
              {modeLabel(value)}
            </label>
          ))}
          {initialMode === '' ? (
            <p className="drp-hint">
              {day.legs.length > 0
                ? '本日现有路线包含多种方式，请选择这一次使用的方式。'
                : '这一天还没有路段：请选择这一次希望使用的出行方式。'}
            </p>
          ) : null}
        </div>
        <div className="drp-field">
          <label htmlFor={travelersId}>同行人数（选填）</label>
          <input
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
          />
          <p className="drp-hint">
            1–{MAX_REPLAN_TRAVELERS} 的整数；留空不会发送人数，也不会沿用规划表单里的旧人数。修改后需要重新生成候选。
          </p>
          {travelersInvalid ? (
            <p id={travelersErrorId} className="drp-hint drp-error-text" role="alert">
              同行人数需要是 1–{MAX_REPLAN_TRAVELERS} 的整数，或留空不填。
            </p>
          ) : null}
        </div>
        <div className="drp-actions">
          <button
            type="button"
            className="drp-btn drp-btn-primary"
            onClick={() => {
              void handleGenerate()
            }}
            disabled={!canGenerate}
          >
            生成调整候选
          </button>
        </div>
        <p className="drp-hint">点击生成才会请求一次 AI 调整；不会自动生成，也不会自动重试。</p>
      </fieldset>

      {pending ? (
        <div className="drp-actions">
          <button type="button" className="drp-btn" onClick={stopWaiting}>
            停止等待
          </button>
          <p className="drp-hint">已提交的请求会继续在服务端处理，停止等待只是不再等它，不保证后端停止计算。</p>
        </div>
      ) : null}

      {error ? (
        <p className="drp-error" role="alert">
          {error.message}
        </p>
      ) : null}

      {candidateStale ? (
        <p className="drp-notice" role="status">
          调整指令、出行方式或同行人数已经变化，下面的候选基于修改前的内容，不能直接应用；可按新内容重新生成。
        </p>
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
          onApply={handleApply}
          onDiscard={() => {
            setCandidate(null)
            setCandidateInvalid(null)
            setApplyError(null)
          }}
        />
      ) : currentCandidate ? (
        <div className="drp-preview" aria-label="候选预览">
          <h4 className="drp-preview-title">候选预览（尚未应用到行程）</h4>
          <div className="drp-columns">
            <div className="drp-col">
              <h5 className="drp-col-title">当前方案</h5>
              <StopTable day={day} />
            </div>
            <div className="drp-col">
              <h5 className="drp-col-title">AI 候选</h5>
              <StopTable day={currentCandidate.day} candidate />
            </div>
          </div>
          <p className="drp-map-status">
            <strong>地图数据：</strong>
            {MAP_STATUS_TEXT[currentCandidate.map_status]}
          </p>
          <RouteSummary day={currentCandidate.day} />
          {warnings.length > 0 ? (
            <div className="drp-warnings">
              <h5 className="drp-col-title">
                本次返回提醒（{warnings.length} 条）
              </h5>
              <ul className="drp-warning-list">
                {visibleWarnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
              {hiddenWarningCount > 0 ? (
                <button
                  type="button"
                  className="drp-btn drp-btn-link"
                  onClick={() => setShowAllWarnings(true)}
                  aria-expanded={false}
                >
                  展开其余 {hiddenWarningCount} 条提醒
                </button>
              ) : null}
            </div>
          ) : null}
          {applyError ? (
            <p className="drp-error" role="alert">
              {applyError.message}
            </p>
          ) : null}
          <div className="drp-actions">
            <button
              type="button"
              className="drp-btn drp-btn-primary"
              onClick={handleApply}
              disabled={!canApply || candidateStale}
            >
              应用候选
            </button>
            <button
              type="button"
              className="drp-btn"
              onClick={() => {
                setCandidate(null)
                setCandidateInvalid(null)
                setApplyError(null)
              }}
            >
              放弃候选
            </button>
          </div>
          <p className="drp-hint">应用候选只替换这一天的全部安排，其余天不变；应用前当前行程不会被改动，也不会自动保存。</p>
        </div>
      ) : null}
    </section>
  )
}

function StopTable({ day, candidate = false }: { day: TripDay; candidate?: boolean }) {
  if (day.stops.length === 0) {
    return <p className="drp-hint">这一天没有站点安排。</p>
  }
  return (
    <ol className="drp-stops">
      {day.stops.map((stop) => {
        const leg = day.legs.find((item) => item.to_stop_id === stop.id)
        return (
          <li key={stop.id} className="drp-stop">
            {leg ? (
              <p className={`drp-leg drp-leg-${leg.route_type}`}>
                {ROUTE_TEXT[leg.route_type]} · {modeLabel(leg.mode)} · {formatDistance(leg.distance_m)}
                {leg.duration_minutes !== null ? ` · 约 ${leg.duration_minutes} 分钟` : ''}
              </p>
            ) : null}
            <p className="drp-stop-time">
              <span className="drp-mono">{formatTime(stop.time)}</span> · {formatDuration(stop.duration_minutes)}
            </p>
            <p className="drp-stop-name">{stop.name}</p>
            {candidate && stop.location === null ? (
              <p className="drp-stop-note">该站点暂无坐标，地图不绘制此点。</p>
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
    <p className="drp-hint">
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
  onApply,
  onDiscard,
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
  onApply: () => void
  onDiscard: () => void
}) {
  const composed = composeTailPreviewDay(trip, scope, response, currentRevision)
  if (!composed.ok) {
    return (
      <p className="drp-error" role="alert">
        {composed.message}
      </p>
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
  return (
    <div className="drp-preview" aria-label="候选预览">
      <h4 className="drp-preview-title">后段候选预览（尚未应用到行程）</h4>
      <p className="drp-hint">
        {`本日前 ${composed.keptCount} 站原样保留（冻结段），之后 ${composed.tailStopCount} 站来自 AI 候选（新后段）；下面的组合方案只用于预览，不代表已应用。`}
      </p>
      <div className="drp-columns">
        <div className="drp-col">
          <h5 className="drp-col-title">{`冻结保留（前 ${composed.keptCount} 站，原记录）`}</h5>
          <StopTable day={keptDay} />
        </div>
        <div className="drp-col">
          <h5 className="drp-col-title">组合方案（冻结段 + AI 新后段）</h5>
          <StopTable day={composed.day} candidate />
        </div>
      </div>
      {composed.notices.map((notice, index) => (
        <p key={index} className="drp-notice" role="note">
          {notice}
        </p>
      ))}
      <p className="drp-map-status">
        <strong>组合后地图数据：</strong>
        {MAP_STATUS_TEXT[composed.mapStatus]}
      </p>
      <p className="drp-map-status">
        <strong>原始后段地图数据（AI 返回时）：</strong>
        {MAP_STATUS_TEXT[response.map_status]}
      </p>
      <RouteSummary day={composed.day} />
      {warnings.length > 0 ? (
        <div className="drp-warnings">
          <h5 className="drp-col-title">{`本次返回提醒（${warnings.length} 条）`}</h5>
          <ul className="drp-warning-list">
            {visibleWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          {hiddenWarningCount > 0 ? (
            <button
              type="button"
              className="drp-btn drp-btn-link"
              onClick={onShowAllWarnings}
              aria-expanded={false}
            >
              {`展开其余 ${hiddenWarningCount} 条提醒`}
            </button>
          ) : null}
        </div>
      ) : null}
      {applyError ? (
        <p className="drp-error" role="alert">
          {applyError.message}
        </p>
      ) : null}
      <div className="drp-actions">
        <button
          type="button"
          className="drp-btn drp-btn-primary"
          onClick={onApply}
          disabled={!canApply}
        >
          应用后段候选
        </button>
        <button type="button" className="drp-btn" onClick={onDiscard}>
          放弃候选
        </button>
      </div>
      <p className="drp-hint">
        应用后段候选只替换锚点之后的部分：前段站点、时刻与站间路线原样保留，其它天不变；锚点衔接路线未重算。应用前当前行程不会被改动，也不会自动保存。
      </p>
    </div>
  )
}

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
  onApply: (request: DayReplanRequest, response: DayReplanResponse) => DayReplanApplyResult
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
  /**
   * 同行人数（选填）：用字符串保存输入，留空就完全不往请求里写。
   * 不从旧行程或规划表单猜人数，也不默认 1。
   */
  const [travelers, setTravelers] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)
  const [candidate, setCandidate] = useState<{ request: DayReplanRequest; response: DayReplanResponse } | null>(null)
  const [candidateInvalid, setCandidateInvalid] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<ApplyError | null>(null)
  const [showAllWarnings, setShowAllWarnings] = useState(false)

  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

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
  const canGenerate =
    Boolean(day) &&
    !plannerUnavailable &&
    !pending &&
    !instructionEmpty &&
    !instructionTooLong &&
    !travelersInvalid &&
    mode !== ''

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
    const built = buildDayReplanRequest(trip, dayNumber, instruction, options)
    if (!built.ok) {
      setError({ kind: 'build', message: built.message })
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
      const response = await (requestDay ?? replanDay)(built.request, { signal: controller.signal })
      if (seqRef.current !== seq || controller.signal.aborted) return
      // 展示前再核对一次完整契约：不过关的响应不进预览。
      const validated = validateDayReplanResponse(response, built.request)
      if (!validated.ok) {
        setError({ kind: 'bad_payload', message: '返回的结果没有通过完整性检查，本次未生成候选。可以重新生成试试。' })
        return
      }
      setCandidate({ request: built.request, response: validated.response })
    } catch (err) {
      if (seqRef.current !== seq || controller.signal.aborted) return
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
    const result = onApply(candidate.request, candidate.response)
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

  // 新输入、模式或同行人数改变后，旧候选基于旧条件，不能再用。
  const candidateStale =
    currentRequest !== null &&
    (currentRequest.instruction !== instruction ||
      currentRequest.travel_mode !== mode ||
      (currentRequest.travelers ?? null) !== travelersValue ||
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

      {currentCandidate ? (
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
          <p className="drp-hint">应用候选只替换这一天，其余天不变；应用前当前行程不会被改动，也不会自动保存。</p>
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

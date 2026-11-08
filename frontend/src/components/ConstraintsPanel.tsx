/**
 * F2 · 必去点与预约时间约束面板（受控组件）
 *
 * 边界：
 * - 只读 props；所有编辑先落组件内存草稿，点「应用约束改动」才通过 callback 交给工作区 owner。
 * - 不在组件内写 localStorage、不改 Trip、不改共享状态；应用 / 持久化由父级单一 transition 完成。
 * - H 级硬冲突时 apply 按钮禁用，且没有「仍然应用」入口；U 级必须勾选独立确认。
 * - 每次编辑 / 切换 / 取消 / 采纳 / 撤销都推进组件 epoch 并丢弃旧 apply ticket；
 *   内容 A→B→A 也不会复用旧确认。
 * - 时间来源默认 unknown；无显式 known 证据时按 U，不从 Trip.time 非空或冻结状态推断。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { Trip, TripDay, TripStop } from '../lib/api'
import {
  addConstraintItem,
  advanceConstraintsEpoch,
  checkConstraintsCapacity,
  cloneConstraints,
  constraintsContentEqual,
  constraintsFingerprint,
  createConstraintsApplyTicket,
  evaluateConstraintsAgainstTrip,
  makeConstraintItem,
  removeConstraintItem,
  replaceConstraintItem,
  type ConstraintIssue,
  type ConstraintTimeOrigin,
  type ConstraintsApplyTicketV1,
  type ConstraintsEvaluation,
  type ConstraintsEvaluationResult,
} from '../lib/constraints'
import type { ConstraintItemV1, ConstraintKindV1, ConstraintsV1, PlanScopeV1, WorkspaceRecordV1 } from '../lib/workspaceTypes'
import type { WorkspaceRuntimeCaptureV1 } from '../lib/workspace'
import { workspaceRuntimeRefsMatch } from '../lib/workspace'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

export interface ConstraintsPanelApplyRequest {
  /** 新的完整约束集合；父级负责 validate + 单一 transition。 */
  constraints: ConstraintsV1
  /** 本次硬门核对的最终候选 Trip（可能是 AI 候选；未改任何字段）。 */
  candidateTrip: Trip
  planScope: PlanScopeV1
  /** 生成 ticket 时的组件 epoch；父级用作 transition 守卫。 */
  epoch: number
  ticket: ConstraintsApplyTicketV1
  evaluation: ConstraintsEvaluation
}

export interface ConstraintsPanelApplyResult {
  ok: boolean
  message?: string
}

export type ConstraintsPanelApplyHandler = (
  request: ConstraintsPanelApplyRequest,
) => ConstraintsPanelApplyResult | void

export interface ConstraintsPanelProps {
  /** 当前工作区约束；受控输入，面板不会修改。 */
  constraints: ConstraintsV1
  /** 当前行程（只读硬门基准）。 */
  trip: Trip
  /** 当前工作区 revision；用于展示与 reset 判定。 */
  workspaceRevision: number
  /** 组件 epoch；每次编辑 / 切换 / 取消 / 采纳 / 撤销都会在内部推进。 */
  epoch: number
  /** 当前候选 Trip；缺省用 trip。 */
  candidateTrip?: Trip | null
  /** 生成 ticket 所需的完整工作区记录；没有时只能本地预览，不能 apply。 */
  record?: WorkspaceRecordV1 | null
  /** 与 record 同一代的实际对象引用捕获；没有引用门不能声称完整安全。 */
  runtimeCapture?: WorkspaceRuntimeCaptureV1 | null
  /** 当前请求 / 候选 scope；apply 必需。 */
  planScope?: PlanScopeV1 | null
  /**
   * stopId → 时间来源。缺省 / 未列出 / placeholder / unknown 一律按未知；
   * 不能因为 Trip.time 非空、或站点被冻结就推断 known。App 只有拿到可信已知
   * 来源时才显式传 'known'，否则由用户走 U 级独立确认。
   */
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
  /** day_tail 冻结段快照；由客户端完整检查。 */
  frozenStops?: readonly TripStop[] | null
  frozenStopIds?: readonly string[] | null
  /** 显式应用 callback；Panel 不写 workspace。 */
  onApply?: ConstraintsPanelApplyHandler
  onClose?: () => void
  /** 测试注入的时钟；只在用户点击保存 / 应用时调用。 */
  now?: () => number
}

type FormKind = ConstraintKindV1

interface ConstraintFormState {
  id: string | null
  kind: FormKind
  title: string
  day: string
  stopId: string
  startDate: string
  endDate: string
  startTime: string
  endTime: string
  durationMinutes: string
  notes: string
  priority: string
}

const KIND_LABEL: Record<ConstraintKindV1, string> = {
  must_visit: '必去',
  fixed_window: '预约窗口',
  reminder: '提醒',
}

const KIND_HINT: Record<ConstraintKindV1, string> = {
  must_visit: '必须出现在目标日；已知缺失是 H 级，不允许确认绕过。',
  fixed_window: '你填写的预约起止；完整起止 + 真实日期才可硬验证，任一必要端未知是 U 级。',
  reminder: '只提醒，不阻断应用；不会被说成已预订或已确认。',
}

/** W3b：面板级通用类名，从 constraintsPanel.css 迁来（shadcn + Tailwind）。 */
const PANEL = 'grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5 shadow-[var(--shadow-1)] max-md:p-4'
const FIELD_LABEL = 'text-sm leading-relaxed text-muted-foreground'
const CONTROL = 'min-h-11 w-full'
const BOX = 'grid gap-2 rounded-[10px] border border-border bg-background p-4'
const HINT = 'm-0 text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]'
const ISSUE_H = 'border-l-[3px] border-l-[color:var(--color-primary)] bg-[color:var(--color-primary)]'
const ISSUE_U = 'border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)]'
const KIND_BADGE =
  'inline-flex shrink-0 items-center rounded-full bg-[color:var(--color-primary)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-accent-foreground)]'

function formFromItem(item: ConstraintItemV1): ConstraintFormState {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    day: item.day === null ? '' : String(item.day),
    stopId: item.stopId ?? '',
    startDate: item.startDate ?? '',
    endDate: item.endDate ?? '',
    startTime: item.startTime ?? '',
    endTime: item.endTime ?? '',
    durationMinutes: item.durationMinutes === null ? '' : String(item.durationMinutes),
    notes: item.notes ?? '',
    priority: String(item.priority),
  }
}

function emptyForm(day: number | null): ConstraintFormState {
  return {
    id: null,
    kind: 'must_visit',
    title: '',
    day: day === null ? '' : String(day),
    stopId: '',
    startDate: '',
    endDate: '',
    startTime: '',
    endTime: '',
    durationMinutes: '',
    notes: '',
    priority: '1',
  }
}

function parseDayText(text: string): { ok: true; value: number | null } | { ok: false; message: string } {
  if (text.trim() === '') return { ok: true, value: null }
  if (!/^\d+$/.test(text.trim())) return { ok: false, message: '目标日必须是正整数天序号。' }
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1 || value > 366) {
    return { ok: false, message: '目标日必须在 1–366 之间。' }
  }
  return { ok: true, value }
}

function parseDurationText(text: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: '停留分钟必须是非负整数；留空表示未知，不能把未知当成 0。' }
  const value = Number(trimmed)
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    return { ok: false, message: '停留分钟必须在 0–100000 之间。' }
  }
  return { ok: true, value }
}

function describeWindow(item: ConstraintItemV1): string {
  const startDate = item.startDate ?? '日期未知'
  const startTime = item.startTime ?? '时刻未知'
  const endDate = item.endDate ?? '日期未知'
  const endTime = item.endTime ?? '时刻未知'
  const duration =
    item.durationMinutes === null ? '停留未知' : `停留 ${item.durationMinutes} 分钟`
  return `${startDate} ${startTime} → ${endDate} ${endTime}（${duration}）`
}

function describeItem(item: ConstraintItemV1): string {
  const day = item.day === null ? '未指定目标日' : `第 ${item.day} 天`
  const priority = `优先级 ${item.priority}`
  if (item.kind === 'fixed_window') {
    return `${day} · ${describeWindow(item)} · ${priority}`
  }
  if (item.kind === 'must_visit') {
    const target = item.stopId === null ? `按标题「${item.title}」唯一匹配` : `绑定站点 ${item.stopId}`
    return `${day} · ${target} · ${priority}`
  }
  return `${day} · 仅提醒，不阻断 · ${priority}`
}

/** H = accent 底、U = warn 底；返回 Tailwind 类名（W3b 由 cfp-issue-* 迁来）。 */
function issueTone(issue: ConstraintIssue): string {
  return issue.severity === 'H' ? ISSUE_H : ISSUE_U
}

function verdictText(evaluation: ConstraintsEvaluationResult): string {
  if (!evaluation.ok) return `约束数据不合法：${evaluation.message}`
  if (evaluation.verdict === 'blocked') {
    return '存在 H 级硬冲突：不能应用，也不能靠用户确认绕过。'
  }
  if (evaluation.verdict === 'needs_ack') {
    return '存在未核实时间端（U 级）：不能声称已满足；应用前必须独立确认。'
  }
  return '本地硬门通过：填写的时间端完整且当前候选未发现硬冲突；仍不代表已核实预约或营业状态。'
}

export default function ConstraintsPanel(props: ConstraintsPanelProps) {
  const {
    constraints,
    trip,
    workspaceRevision,
    candidateTrip = null,
    record = null,
    runtimeCapture = null,
    planScope = null,
    timeOrigins = null,
    frozenStops = null,
    frozenStopIds = null,
    onApply,
    onClose,
    now = Date.now,
  } = props

  const ids = useId()
  const baseFingerprint = constraintsFingerprint(constraints)?.canonical ?? ''
  const resetKey = `${trip.id}|${workspaceRevision}|${record?.updatedAt ?? 0}|${baseFingerprint}`

  const [draft, setDraft] = useState<ConstraintsV1>(() => cloneConstraints(constraints))
  const [sessionEpoch, setSessionEpoch] = useState(props.epoch)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<ConstraintFormState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [ackChecked, setAckChecked] = useState(false)
  const [ticket, setTicket] = useState<ConstraintsApplyTicketV1 | null>(null)
  const historyRef = useRef<ConstraintsV1[]>([])
  const evaluationContextRef = useRef<string | null>(null)

  useEffect(() => {
    setDraft(cloneConstraints(constraints))
    setSessionEpoch(props.epoch)
    setSelectedId(null)
    setForm(null)
    setNotice(null)
    setError(null)
    setConfirmRemoveId(null)
    setAckChecked(false)
    setTicket(null)
    historyRef.current = []
    // props.epoch 是父级切换 / 采纳后的新代；内容或 revision 变化同样失效。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, props.epoch])

  const evaluationContextKey = useMemo(
    () =>
      JSON.stringify({
        timeOrigins: timeOrigins ?? null,
        frozenStops: frozenStops ?? null,
        frozenStopIds: frozenStopIds ?? null,
      }),
    [timeOrigins, frozenStops, frozenStopIds],
  )

  useEffect(() => {
    if (evaluationContextRef.current === null) {
      evaluationContextRef.current = evaluationContextKey
      return
    }
    if (evaluationContextRef.current === evaluationContextKey) return
    // timeOrigins / frozen 变化会改变 H/U；旧 ticket 与 U ack 不得沿用。
    evaluationContextRef.current = evaluationContextKey
    setSessionEpoch((current) => {
      const next = advanceConstraintsEpoch(current)
      return next.ok ? next.value : current
    })
    setTicket(null)
    setAckChecked(false)
  }, [evaluationContextKey])

  const candidate = candidateTrip ?? trip
  const evaluation = useMemo(
    () =>
      evaluateConstraintsAgainstTrip({
        constraints: draft,
        trip: candidate,
        sourceTrip: trip,
        record,
        planScope,
        timeOrigins,
        frozenStops,
        frozenStopIds,
      }),
    [draft, candidate, trip, record, planScope, timeOrigins, frozenStops, frozenStopIds],
  )

  const dirty = !constraintsContentEqual(draft, constraints)
  const capacity = checkConstraintsCapacity(draft)
  const globalIssues = evaluation.ok
    ? evaluation.issues.filter((issue) => issue.constraintId === null)
    : []

  function bumpEpoch(): boolean {
    const next = advanceConstraintsEpoch(sessionEpoch)
    if (!next.ok) {
      setError(next.message)
      return false
    }
    setSessionEpoch(next.value)
    setTicket(null)
    setAckChecked(false)
    return true
  }

  function clearTransient(): void {
    setNotice(null)
    setError(null)
    setConfirmRemoveId(null)
  }

  function startAdd(): void {
    if (!bumpEpoch()) return
    clearTransient()
    setSelectedId(null)
    setForm(emptyForm(trip.days[0]?.day ?? null))
  }

  function startEdit(item: ConstraintItemV1): void {
    if (!bumpEpoch()) return
    clearTransient()
    setSelectedId(item.id)
    setForm(formFromItem(item))
  }

  function cancelForm(): void {
    if (!bumpEpoch()) return
    clearTransient()
    setForm(null)
    setNotice('已取消本次编辑；未应用任何改动。')
  }

  function handleSelect(id: string): void {
    if (id === selectedId) return
    if (!bumpEpoch()) return
    clearTransient()
    setSelectedId(id)
    setForm(null)
    setNotice('已切换查看的约束；旧的应用确认已失效。')
  }

  function handleSaveForm(): void {
    if (!form) return
    const dayParsed = parseDayText(form.day)
    if (!dayParsed.ok) {
      setError(dayParsed.message)
      return
    }
    if (form.kind === 'must_visit' && dayParsed.value === null) {
      setError('必去约束必须指定目标日；未知目标日不能当成硬约束。')
      return
    }
    const durationParsed = parseDurationText(form.durationMinutes)
    if (!durationParsed.ok) {
      setError(durationParsed.message)
      return
    }
    const priority = Number(form.priority)
    if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
      setError('优先级必须是 0–3。')
      return
    }
    const made = makeConstraintItem(
      {
        id: form.id ?? undefined,
        kind: form.kind,
        title: form.title,
        day: dayParsed.value,
        stopId: form.stopId === '' ? null : form.stopId,
        startDate: form.startDate === '' ? null : form.startDate,
        endDate: form.endDate === '' ? null : form.endDate,
        startTime: form.startTime === '' ? null : form.startTime,
        endTime: form.endTime === '' ? null : form.endTime,
        durationMinutes: durationParsed.value,
        notes: form.notes === '' ? null : form.notes,
        priority,
      },
      now(),
    )
    if (!made.ok) {
      setError(made.message)
      return
    }
    const next =
      form.id === null
        ? addConstraintItem(draft, made.value)
        : replaceConstraintItem(draft, made.value)
    if (!next.ok) {
      setError(next.message)
      return
    }
    if (!bumpEpoch()) return
    historyRef.current.push(cloneConstraints(draft))
    if (historyRef.current.length > 20) historyRef.current.shift()
    setDraft(next.value)
    setSelectedId(made.value.id)
    setForm(null)
    setConfirmRemoveId(null)
    setNotice(
      form.id === null
        ? `已加入约束「${made.value.title}」（仅内存草稿，未写工作区）。`
        : `已更新约束「${made.value.title}」（仅内存草稿，未写工作区）。`,
    )
  }

  function handleRemove(id: string): void {
    if (confirmRemoveId !== id) {
      setConfirmRemoveId(id)
      setNotice('再点一次「确认删除」才会移除这条约束；删除只影响约束，不改 Trip。')
      return
    }
    const next = removeConstraintItem(draft, id)
    if (!next.ok) {
      setError(next.message)
      return
    }
    if (!bumpEpoch()) return
    historyRef.current.push(cloneConstraints(draft))
    if (historyRef.current.length > 20) historyRef.current.shift()
    setDraft(next.value)
    setConfirmRemoveId(null)
    if (selectedId === id) setSelectedId(null)
    setNotice('已删除这条约束（仅内存草稿，未写工作区，不改 Trip）。')
  }

  function handleUndo(): void {
    const previous = historyRef.current.pop()
    if (!previous) {
      setNotice('没有可撤销的约束编辑。')
      return
    }
    if (!bumpEpoch()) return
    clearTransient()
    setDraft(previous)
    setSelectedId(null)
    setForm(null)
    setNotice('已撤销上一步约束编辑；仍需点「应用约束改动」才会写工作区。')
  }

  function handleRevert(): void {
    if (!bumpEpoch()) return
    clearTransient()
    setDraft(cloneConstraints(constraints))
    historyRef.current = []
    setSelectedId(null)
    setForm(null)
    setNotice('已还原为当前工作区约束；未写工作区。')
  }

  function handleFormKind(kind: FormKind): void {
    if (!form) return
    const day = form.day === '' && kind === 'must_visit' ? String(trip.days[0]?.day ?? '') : form.day
    setForm({ ...form, kind, day })
  }

  function handleFormDay(day: string): void {
    if (!form) return
    const parsed = parseDayText(day)
    const dayNumber = parsed.ok ? parsed.value : null
    const dayStops = dayNumber === null ? null : trip.days.find((entry) => entry.day === dayNumber)
    const stopId =
      form.stopId !== '' && dayStops && !dayStops.stops.some((stop) => stop.id === form.stopId)
        ? ''
        : form.stopId
    setForm({ ...form, day, stopId })
  }

  function handleApply(): void {
    clearTransient()
    if (!evaluation.ok) {
      setError(`约束数据不合法：${evaluation.message}`)
      return
    }
    if (evaluation.verdict === 'blocked') {
      setError('存在 H 级硬冲突；不能应用，也不能靠确认绕过。')
      return
    }
    if (evaluation.requiresAck && !ackChecked) {
      setError('存在未核实时间端；请先勾选独立确认「仍采用含未核实时间方案」。')
      return
    }
    if (!record || !planScope || !onApply) {
      setError(
        '当前面板没有接入完整工作区记录 / planScope / apply callback；只能本地预览，不能声称已应用。',
      )
      return
    }
    if (
      runtimeCapture &&
      runtimeCapture.epoch === sessionEpoch &&
      !workspaceRuntimeRefsMatch(runtimeCapture, record, sessionEpoch, {
        input: candidate,
      })
    ) {
      setError('工作区或候选的实际对象引用 / epoch 已变化；旧引用门失效，请重新捕获当前引用后再应用。')
      return
    }
    const created = createConstraintsApplyTicket({
      record,
      constraints: draft,
      candidateTrip: candidate,
      planScope,
      epoch: sessionEpoch,
      acknowledgedAt: now(),
      unverifiedConfirmed: ackChecked,
      timeOrigins,
      frozenStops,
      frozenStopIds,
    })
    if (!created.ok) {
      setError(created.message)
      return
    }
    let result: ConstraintsPanelApplyResult | void
    try {
      result = onApply({
        constraints: cloneConstraints(draft),
        candidateTrip: candidate,
        planScope,
        epoch: sessionEpoch,
        ticket: created.value,
        evaluation,
      })
    } catch {
      setError('应用 callback 执行失败；本次没有写工作区。')
      return
    }
    if (result && !result.ok) {
      setError(result.message ?? '父级拒绝了本次应用；工作区保持不变。')
      return
    }
    const successMessage =
      result !== undefined && result !== null ? result.message : undefined
    setNotice(
      successMessage ??
        '已提交应用请求；由工作区统一 transition 与持久化。本面板没有直接写任何存储。',
    )
    bumpEpoch()
    setTicket(created.value)
  }

  function handleClose(): void {
    if (!bumpEpoch()) return
    setTicket(null)
    setAckChecked(false)
    onClose?.()
  }

  const formDay = form ? parseDayText(form.day) : { ok: true as const, value: null }
  const formDayNumber = formDay.ok ? formDay.value : null
  const formDayStops: readonly TripStop[] =
    formDayNumber === null
      ? []
      : (trip.days.find((entry) => entry.day === formDayNumber)?.stops ?? [])

  return (
    <section className={PANEL} aria-labelledby={`${ids}-heading`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_260px]">
          <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-foreground)]">
            F2 · 必去与预约
          </p>
          <h2
            className="m-0 mb-2 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]"
            id={`${ids}-heading`}
          >
            必去点与预约时间约束
          </h2>
          <p className="m-0 max-w-[72ch] text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            这里记录的是你填写的必去点与预约时间，不代表已经预订、出票或确认。本地硬门只按填写值与行程记录推算。
          </p>
        </div>
        {onClose ? (
          <Button variant="outline" onClick={handleClose}>
            收起必去与预约
          </Button>
        ) : null}
      </header>

      <div className={BOX}>
        <p
          className="m-0 text-sm font-semibold leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]"
          data-testid="constraints-verdict"
          aria-live="polite"
        >
          {verdictText(evaluation)}
        </p>
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">
          {draft.items.length} 条约束 · {capacity.ok ? `${capacity.bytes} 字节` : capacity.message} ·
          工作区 revision {workspaceRevision} · 当前 epoch {sessionEpoch}
          {dirty ? ' · 有未应用的本地改动' : ' · 与当前工作区一致'}
        </p>
      </div>

      {globalIssues.length > 0 ? (
        <ul className="m-0 grid list-none gap-1.5 p-0" aria-label="全局硬门问题">
          {globalIssues.map((issue, index) => (
            <li
              key={`${issue.code}-${index}`}
              className={`grid gap-1 rounded-[6px] p-2.5 pl-3 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] ${issueTone(issue)}`}
            >
              <span className="inline-flex w-fit items-center rounded-full border border-border bg-card px-2 py-0.5 text-xs font-semibold">
                {issue.severity}
              </span>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      {evaluation.ok && evaluation.requiresAck ? (
        <div className="grid gap-2 rounded-[6px] border border-dashed border-[color:var(--color-warn-ink)]/50 bg-[color:var(--color-warn-bg)] p-3">
          <label className="flex min-h-11 items-center gap-2.5" htmlFor={`${ids}-ack`}>
            <Checkbox
              id={`${ids}-ack`}
              checked={ackChecked}
              onChange={(event) => {
                setAckChecked(event.target.checked)
                setTicket(null)
                setNotice('确认只在本次候选 / 工作区 / epoch 下有效；任何修改都会让它失效。')
              }}
            />
            <span className="text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
              我确认仍采用含未核实时间方案（绑定当前工作区与候选，任何修改后失效）
            </span>
          </label>
          <p className={HINT}>
            U 级只表示「时间端未核实」，不是硬冲突；不勾选就不能应用，也不能声称已满足。
          </p>
        </div>
      ) : null}

      {evaluation.ok && evaluation.verdict === 'blocked' ? (
        <p
          className="m-0 rounded-[6px] border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] p-3 text-sm font-medium leading-relaxed text-[color:var(--color-warn-ink)]"
          aria-label="H 级硬冲突说明"
        >
          H 级硬冲突不能由用户确认绕过；请先修正约束或行程，再重新检查。
        </p>
      ) : null}

      {evaluation.ok && evaluation.notices.length > 0 ? (
        <ul className="m-0 grid list-none gap-1 p-0 text-xs leading-relaxed text-muted-foreground" aria-label="本地硬门说明">
          {evaluation.notices.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      ) : null}

      {draft.items.length === 0 ? (
        <p className="m-0 text-sm leading-relaxed text-muted-foreground">
          还没有约束。可以添加「必去」或「预约窗口」；提醒不会阻断应用。
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0" aria-label="约束列表">
          {draft.items.map((item) => {
            const issues = evaluation.ok
              ? evaluation.issues.filter((issue) => issue.constraintId === item.id)
              : []
            return (
              <li
                key={item.id}
                className={
                  selectedId === item.id
                    ? 'grid gap-1.5 rounded-[10px] border border-[color:var(--color-primary)] bg-[color:var(--color-primary)]/40 p-3'
                    : 'grid gap-1.5 rounded-[10px] border border-border bg-background p-3'
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 bg-transparent p-0 text-left"
                    aria-pressed={selectedId === item.id}
                    aria-label={`查看约束 ${item.title}`}
                    onClick={() => handleSelect(item.id)}
                  >
                    <span className={KIND_BADGE}>{KIND_LABEL[item.kind]}</span>
                    <span className="min-w-0 break-words text-sm font-semibold leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
                      {item.title}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`编辑约束 ${item.title}`}
                      onClick={() => startEdit(item)}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={
                        confirmRemoveId === item.id
                          ? `确认删除约束 ${item.title}`
                          : `删除约束 ${item.title}`
                      }
                      onClick={() => handleRemove(item.id)}
                    >
                      {confirmRemoveId === item.id ? '确认删除' : '删除'}
                    </Button>
                  </div>
                </div>
                <p className="m-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                  {describeItem(item)}
                </p>
                {item.notes ? (
                  <p className="m-0 text-xs leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
                    备注：{item.notes}
                  </p>
                ) : null}
                {issues.length > 0 ? (
                  <ul className="m-0 grid list-none gap-1.5 p-0" aria-label={`约束 ${item.title} 的问题`}>
                    {issues.map((issue, index) => (
                      <li
                        key={`${issue.code}-${index}`}
                        className={`grid gap-1 rounded-[6px] p-2.5 pl-3 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] ${issueTone(issue)}`}
                      >
                        <span className="inline-flex w-fit items-center rounded-full border border-border bg-card px-2 py-0.5 text-xs font-semibold">
                          {issue.severity}
                        </span>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {form ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            handleSaveForm()
          }}
        >
          <fieldset className={BOX}>
            <legend className="px-1 font-display text-sm font-bold text-[color:var(--color-secondary-foreground)]">
              {form.id === null ? '添加约束' : `编辑约束「${form.title || '未命名'}」`}
            </legend>
            <p className={HINT}>{KIND_HINT[form.kind]}</p>

            <label className="grid gap-1.5" htmlFor={`${ids}-kind`}>
              <span className={FIELD_LABEL}>类型</span>
              <Select
                id={`${ids}-kind`}
                className={CONTROL}
                value={form.kind}
                onChange={(event) => handleFormKind(event.target.value as FormKind)}
              >
                <option value="must_visit">必去（must_visit）</option>
                <option value="fixed_window">预约窗口（fixed_window）</option>
                <option value="reminder">提醒（reminder）</option>
              </Select>
            </label>

            <label className="grid gap-1.5" htmlFor={`${ids}-title-field`}>
              <span className={FIELD_LABEL}>标题</span>
              <Input
                id={`${ids}-title-field`}
                className={CONTROL}
                type="text"
                maxLength={120}
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                required
              />
            </label>

            <label className="grid gap-1.5" htmlFor={`${ids}-day`}>
              <span className={FIELD_LABEL}>目标日</span>
              <Select
                id={`${ids}-day`}
                className={CONTROL}
                value={form.day}
                onChange={(event) => handleFormDay(event.target.value)}
              >
                <option value="">未指定</option>
                {trip.days.map((day) => (
                  <option key={day.day} value={String(day.day)}>
                    第 {day.day} 天{day.date ? `（${day.date}）` : ''}
                  </option>
                ))}
              </Select>
            </label>

            <label className="grid gap-1.5" htmlFor={`${ids}-stop`}>
              <span className={FIELD_LABEL}>绑定站点</span>
              <Select
                id={`${ids}-stop`}
                className={CONTROL}
                value={form.stopId}
                onChange={(event) => setForm({ ...form, stopId: event.target.value })}
              >
                <option value="">不绑定（按标题唯一匹配）</option>
                {formDayStops.map((stop) => (
                  <option key={stop.id} value={stop.id}>
                    {stop.name}（{stop.id}）
                  </option>
                ))}
              </Select>
            </label>
            <p className={HINT}>
              不绑定站点时，must_visit 用「标题 + 目标日」作为初始目标实体；同名多站会按 U 级处理，不会 silent 选第一个。
            </p>

            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              <label className="grid gap-1.5" htmlFor={`${ids}-start-date`}>
                <span className={FIELD_LABEL}>开始日期</span>
                <Input
                  id={`${ids}-start-date`}
                  className={CONTROL}
                  type="date"
                  value={form.startDate}
                  onChange={(event) => setForm({ ...form, startDate: event.target.value })}
                />
              </label>
              <label className="grid gap-1.5" htmlFor={`${ids}-end-date`}>
                <span className={FIELD_LABEL}>结束日期</span>
                <Input
                  id={`${ids}-end-date`}
                  className={CONTROL}
                  type="date"
                  value={form.endDate}
                  onChange={(event) => setForm({ ...form, endDate: event.target.value })}
                />
              </label>
              <label className="grid gap-1.5" htmlFor={`${ids}-start-time`}>
                <span className={FIELD_LABEL}>开始时刻</span>
                <Input
                  id={`${ids}-start-time`}
                  className={CONTROL}
                  type="time"
                  value={form.startTime}
                  onChange={(event) => setForm({ ...form, startTime: event.target.value })}
                />
              </label>
              <label className="grid gap-1.5" htmlFor={`${ids}-end-time`}>
                <span className={FIELD_LABEL}>结束时刻</span>
                <Input
                  id={`${ids}-end-time`}
                  className={CONTROL}
                  type="time"
                  value={form.endTime}
                  onChange={(event) => setForm({ ...form, endTime: event.target.value })}
                />
              </label>
            </div>

            <label className="grid gap-1.5" htmlFor={`${ids}-duration`}>
              <span className={FIELD_LABEL}>停留分钟</span>
              <Input
                id={`${ids}-duration`}
                className={CONTROL}
                type="text"
                inputMode="numeric"
                placeholder="留空 = 未知；0 = 已知零分钟"
                value={form.durationMinutes}
                onChange={(event) => setForm({ ...form, durationMinutes: event.target.value })}
              />
            </label>

            <label className="grid gap-1.5" htmlFor={`${ids}-notes`}>
              <span className={FIELD_LABEL}>备注</span>
              <Textarea
                id={`${ids}-notes`}
                className={CONTROL}
                maxLength={500}
                rows={2}
                placeholder="只保存在本地，不进入后端 prompt"
                value={form.notes}
                onChange={(event) => setForm({ ...form, notes: event.target.value })}
              />
            </label>

            <label className="grid gap-1.5" htmlFor={`${ids}-priority`}>
              <span className={FIELD_LABEL}>优先级</span>
              <Select
                id={`${ids}-priority`}
                className={CONTROL}
                value={form.priority}
                onChange={(event) => setForm({ ...form, priority: event.target.value })}
              >
                <option value="0">0 · 低</option>
                <option value="1">1 · 普通</option>
                <option value="2">2 · 高</option>
                <option value="3">3 · 最高</option>
              </Select>
            </label>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button type="submit">保存约束</Button>
              <Button variant="outline" onClick={cancelForm}>
                取消编辑
              </Button>
            </div>
          </fieldset>
        </form>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={startAdd} disabled={form !== null}>
          添加约束
        </Button>
        <Button
          variant="ghost"
          onClick={handleUndo}
          disabled={historyRef.current.length === 0 || form !== null}
        >
          撤销一次
        </Button>
        <Button variant="ghost" onClick={handleRevert} disabled={form !== null}>
          还原为当前约束
        </Button>
        <Button
          onClick={handleApply}
          disabled={
            !evaluation.ok ||
            evaluation.verdict === 'blocked' ||
            (evaluation.requiresAck && !ackChecked) ||
            !record ||
            !planScope ||
            !onApply ||
            form !== null
          }
        >
          应用约束改动
        </Button>
      </div>

      <p className={HINT}>
        应用按钮只把完整约束与 apply ticket 交给父级；Panel 不直接写 localStorage、不改 Trip。
        没有工作区记录 / scope / apply callback 时只能本地预览；每次 ticket 都会捕获当前 record
        与候选的实际引用 + epoch，不从旧 capture 反填 current。
      </p>

      {ticket ? (
        <p
          className="m-0 border-l-[3px] border-l-[color:var(--color-primary)] bg-secondary pl-3 font-mono text-xs leading-relaxed tabular-nums text-[color:var(--color-accent-foreground)] [overflow-wrap:anywhere]"
          data-testid="constraints-ticket"
        >
          已生成 apply ticket：候选 {ticket.candidate.short} · epoch {ticket.epoch} ·
          {ticket.ack ? ' 含 U 级独立确认' : ' 无需 U 级确认'}。任何编辑 / 切换 / 取消都会使它失效。
        </p>
      ) : null}

      <div aria-live="polite">
        {notice ? (
          <p className="m-0 text-sm leading-relaxed text-[color:var(--color-ok)] [overflow-wrap:anywhere]">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="m-0 text-sm font-semibold leading-relaxed text-[color:var(--color-accent-foreground)] [overflow-wrap:anywhere]">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** 供集成层 / 测试读取的当前候选 Trip 选择口径（不在组件外写状态）。 */
export function constraintsPanelCandidate(
  trip: Trip,
  candidateTrip: Trip | null | undefined,
): Trip {
  return candidateTrip ?? trip
}

/** 供集成层判断某天是否可作为约束目标；不读 storage。 */
export function constraintTargetDay(trip: Trip, day: number | null): TripDay | null {
  if (day === null) return null
  return trip.days.find((entry) => entry.day === day) ?? null
}

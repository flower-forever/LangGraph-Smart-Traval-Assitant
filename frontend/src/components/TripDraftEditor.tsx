import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'

import type { TripStop } from '../lib/api'
import {
  dailyEndTimeLimitResult,
  formatEndTimeClock,
  parseDailyEndTimeLimit,
  type DailyEndTimeScope,
  type EndTimeDayResult,
} from '../lib/draftEndTime'
import {
  MAX_DAILY_WALKING_DISTANCE_METERS,
  WALKING_DISTANCE_DISCLAIMER,
  dailyWalkingDistanceResult,
  formatWalkingMeters,
  parseDailyWalkingDistanceLimit,
  type DailyWalkingDistanceScope,
} from '../lib/draftWalkingDistance'
import {
  MAX_STOP_ADDRESS_LENGTH,
  MAX_STOP_DESCRIPTION_LENGTH,
  MAX_STOP_DURATION_MINUTES,
  MAX_STOP_NAME_LENGTH,
  MAX_USER_DAILY_STOP_LIMIT,
  STOP_TIME_PATTERN,
  addDraftStop,
  applyDraft,
  dailyStopLimitNotices,
  draftChangedDays,
  isDraftDirty,
  localChecksForDraft,
  moveDraftStop,
  removeDraftStop,
  undoDraft,
  updateDraftStop,
  type DailyStopLimitScope,
  type DraftApplySuccess,
  type DraftCheckKind,
  type DraftEditResult,
  type DraftLocalCheck,
  type TripDraft,
  type UpdateDraftStopPatch,
} from '../lib/tripDraft'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Alert, AlertDescription } from '@/components/ui/alert'

/** 本地检查一次最多先列 4 条；剩余条数如实标注，可展开，不静默吞掉。 */
const CHECK_PREVIEW_COUNT = 4
/** 编辑前提醒一次先列 3 条，同样如实标注剩余条数。 */
const WARNING_PREVIEW_COUNT = 3

const CHECK_KIND_LABEL: Record<DraftCheckKind, string> = {
  empty_day: '空日',
  missing_location: '缺坐标',
  unavailable_leg: '路线待重取',
  time_unreadable: '时间无法读取',
  time_order: '时间倒序',
  time_overlap: '时段重叠',
  possible_cross_day: '可能跨日',
}

/** 「每天最多站点数」可选值：1–8 的整数。 */
const DAILY_STOP_LIMIT_OPTIONS: readonly number[] = Array.from(
  { length: MAX_USER_DAILY_STOP_LIMIT },
  (_, index) => index + 1,
)

const END_TIME_KIND_LABEL: Record<string, string> = {
  start_late: '超过上限',
  end_over_limit: '超过上限',
  cross_day_over_limit: '跨日超限',
  time_unreadable: '待确认',
  duration_unknown: '待确认',
  time_order: '待确认',
}

type FormField = 'name' | 'address' | 'time' | 'duration' | 'description'

type FormState = Record<FormField, string>

type FieldErrors = Partial<Record<FormField, string>>

const FORM_FIELDS: readonly FormField[] = ['name', 'address', 'time', 'duration', 'description']

const EMPTY_FORM: FormState = {
  name: '',
  address: '',
  time: '',
  duration: '',
  description: '',
}

interface EditorSession {
  mode: 'edit' | 'add'
  dayNumber: number
  /** edit 时为被编辑站点 id；add 时为 null。 */
  stopId: string | null
  /** 打开表单时的草稿身份，保存前必须仍与当前草稿一致。 */
  forkTripId: string
  revision: number
  original: FormState
  originalDuration: number | null
  form: FormState
  errors: FieldErrors
  formError: string | null
}

type FocusTarget =
  | { kind: 'field'; field: FormField }
  | { kind: 'form-error' }
  | { kind: 'action-error' }
  | { kind: 'edit'; stopId: string }
  | { kind: 'add' }
  | { kind: 'confirm' }
  | { kind: 'discard' }
  | { kind: 'day' }

export interface TripDraftEditorProps {
  /** 父组件持有的受控草稿；本组件只通过 onDraftChange 请求更新。 */
  draft: TripDraft
  /** 当前要编辑的天（TripDay.day）。 */
  dayNumber: number
  onDraftChange: (next: TripDraft) => void
  onApply: (result: DraftApplySuccess) => void
  onDiscard: () => void
  /** 父组件用 UUID 等方式生成新站点 id；本组件不读存储、不调用 crypto。 */
  createStopId: () => string
  /** 表单里有未保存输入时通知父视图，用于阻止草稿外的切换。 */
  onInputDirtyChange?: (dirty: boolean) => void
  /** 单站表单打开 / 关闭时通知父视图。 */
  onEditingChange?: (editing: boolean) => void
  /** 站点名称可点选，用于地图与列表联动。 */
  onSelectStop?: (stopId: string) => void
}

function formFromStop(stop: TripStop): FormState {
  return {
    name: stop.name,
    address: stop.address,
    time: stop.time,
    duration: stop.duration_minutes === null ? '' : String(stop.duration_minutes),
    description: stop.description,
  }
}

function isFormDirty(session: EditorSession): boolean {
  return FORM_FIELDS.some((field) => session.form[field] !== session.original[field])
}

function describeStop(stop: TripStop, index: number): string {
  return `第 ${index + 1} 站「${stop.name}」`
}

function parseDurationText(
  raw: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const text = raw.trim()
  if (text === '') return { ok: true, value: null }
  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      message: `停留时长要填整数分钟（例如 45）；留空表示不填写，不会自动补时长。`,
    }
  }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value > MAX_STOP_DURATION_MINUTES) {
    return {
      ok: false,
      message: `停留时长需要在 0–${MAX_STOP_DURATION_MINUTES} 分钟之间，留空表示不填写。`,
    }
  }
  return { ok: true, value }
}

interface ValidationResult {
  errors: FieldErrors
  time: string
  duration: number | null
}

/**
 * 只校验「这次真的改了」的字段：已导入的宽字段（例如 300 字旧站名）不改动时，
 * 不应因为时间或描述编辑被二次拦截；tripDraft 的 updateDraftStop 也是同一口径。
 */
function validateSession(session: EditorSession): ValidationResult {
  const errors: FieldErrors = {}
  const isNew = session.mode === 'add'
  const { form, original } = session

  if (isNew || form.name !== original.name) {
    if (form.name.trim().length === 0) {
      errors.name = '站点名称不能为空。'
    } else if (form.name.length > MAX_STOP_NAME_LENGTH) {
      errors.name = `站点名称最多 ${MAX_STOP_NAME_LENGTH} 个字符（当前 ${form.name.length} 个），草稿未改动。`
    }
  }

  if (isNew || form.address !== original.address) {
    if (form.address.length > MAX_STOP_ADDRESS_LENGTH) {
      errors.address = `地址最多 ${MAX_STOP_ADDRESS_LENGTH} 个字符（当前 ${form.address.length} 个），草稿未改动。`
    }
  }

  const time = form.time.trim()
  if (isNew || time !== original.time) {
    if (time.length === 0) {
      errors.time = '请填写时间；新站点不会自动补一个默认时刻。'
    } else if (!STOP_TIME_PATTERN.test(time)) {
      errors.time = '时间需要是 24 小时制的 HH:MM（例如 09:30），草稿未改动。'
    }
  }

  const durationText = form.duration.trim()
  let duration = session.originalDuration
  if (isNew || durationText !== original.duration) {
    const parsed = parseDurationText(durationText)
    if (!parsed.ok) {
      errors.duration = parsed.message
    } else {
      duration = parsed.value
    }
  }

  if (isNew || form.description !== original.description) {
    if (form.description.length > MAX_STOP_DESCRIPTION_LENGTH) {
      errors.description = `描述最多 ${MAX_STOP_DESCRIPTION_LENGTH} 个字符（当前 ${form.description.length} 个），草稿未改动。`
    }
  }

  return { errors, time, duration }
}

function desiredPatches(session: EditorSession, validation: ValidationResult): UpdateDraftStopPatch {
  const { form } = session
  return {
    // 未改动的字段原样提交，tripDraft 会跳过与当前值相同的字段，不会截断旧数据。
    name: form.name,
    address: form.address,
    time: validation.time,
    duration_minutes: validation.duration,
    description: form.description,
  }
}

/**
 * 本地行程草稿编辑器。
 *
 * - 受控：草稿、当前天、应用与放弃都由父组件持有；本组件不读 localStorage、
 *   不调用 crypto / 网络 / 时间，也不自动保存。
 * - 单站表单是独立输入缓冲：清空重输不会每个按键都跑严格校验；只有点保存时才
 *   校验「改动过的字段」，失败时保留原输入并给出可定位的错误。
 * - 打开表单时记录 fork id 与 revision；保存前再核对一次，草稿被外部更新后
 *   旧输入不会落到新草稿里，而是留在表单中供复制或放弃。
 * - 表单打开期间结构动作（增删、移动、撤销、应用、放弃）暂停，避免输入被
 *   结构操作悄悄带走；父视图切换天也不会清掉输入，会明确提示它属于哪一天。
 * - 应用调用 tripDraft 的 applyDraft；失败（含 640 KB 容量拒绝）只显示错误，
 *   不触发 onApply。撤销只改草稿，不自动保存。
 */
export default function TripDraftEditor({
  draft,
  dayNumber,
  onDraftChange,
  onApply,
  onDiscard,
  createStopId,
  onInputDirtyChange,
  onEditingChange,
  onSelectStop,
}: TripDraftEditorProps) {
  const baseId = useId()
  const formFieldId = `${baseId}-form`

  const [session, setSession] = useState<EditorSession | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusTarget | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [checksExpanded, setChecksExpanded] = useState(false)
  const [warningsExpanded, setWarningsExpanded] = useState(false)
  /** 「每天最多站点数」偏好：默认关闭，只属于当前草稿会话的 UI 状态，不写入草稿、不保存。 */
  const [dailyStopLimitEnabled, setDailyStopLimitEnabled] = useState(false)
  const [dailyStopLimit, setDailyStopLimit] = useState(4)
  const [dailyStopLimitScope, setDailyStopLimitScope] = useState<DailyStopLimitScope>('all_days')
  /** 「每天最晚结束时间」偏好：与站点上限同路数，默认关闭，仅当前草稿会话。
   * 文本存原始输入以保留用户的中间态；点「检查」才解析，输入非法时在区内报错。 */
  const [endTimeEnabled, setEndTimeEnabled] = useState(false)
  const [endTimeText, setEndTimeText] = useState('22:00')
  const [endTimeScope, setEndTimeScope] = useState<DailyEndTimeScope>('all_days')
  /** 点「检查」后冻结的本次检查设置；null 表示尚未执行或已被后续操作清除。
   * 修改输入、范围或关闭开关都会清除旧结果，必须重新点「检查」；结果按当前草稿
   * 实时重算：同草稿切天、撤销都不会丢设置或结果。 */
  const [endTimeRun, setEndTimeRun] = useState<{
    limit: number
    scope: DailyEndTimeScope
  } | null>(null)
  const [endTimeError, setEndTimeError] = useState<string | null>(null)
  /** 「每天步行距离上限」偏好：与最晚结束时间同路数，默认关闭，仅当前草稿会话。
   * 文本存原始输入以保留中间态；点「检查」才解析，空 / 非法在区内明示（空不等于 0），
   * 仅此检查非法不阻断原编辑与应用。 */
  const [walkingDistanceEnabled, setWalkingDistanceEnabled] = useState(false)
  const [walkingDistanceText, setWalkingDistanceText] = useState('3000')
  const [walkingDistanceScope, setWalkingDistanceScope] =
    useState<DailyWalkingDistanceScope>('all_days')
  /** 点「检查」后冻结的本次检查设置；null 表示尚未执行或已被后续操作清除。
   * 修改输入、范围或关闭开关都会清除旧结果，必须重新点「检查」；结果按当前草稿
   * 实时重算：同草稿切天、编辑、撤销都会基于当前 legs 重读（新增 / 改地址让路段
   * 失效后自然变未知，不残留旧距离合计）。 */
  const [walkingDistanceRun, setWalkingDistanceRun] = useState<{
    limit: number
    scope: DailyWalkingDistanceScope
  } | null>(null)
  const [walkingDistanceError, setWalkingDistanceError] = useState<string | null>(null)

  /** 步行距离检查的 owner 身份：forkTripId + base 完整内容快照。
   * 每轮渲染都对 base 重新序列化（刻意不用 useMemo 按引用缓存）：
   * 同引用 base 被原地改任何站点 / 路线内容（含 geometry）都会立刻改变 key；
   * 新 base 对象内容相同同样改变 key（结合 base 引用身份推进 epoch）。
   * 序列化失败时 key 为 null（fail closed）：无法核对归属就一律按「已切换」处理，
   * 结果不渲染、检查不可用。 */
  let walkingOwnerKey: string | null = null
  try {
    walkingOwnerKey =
      typeof draft.forkTripId === 'string' && draft.forkTripId !== ''
        ? `${JSON.stringify(draft.forkTripId)}\u0000${JSON.stringify(draft.base)}`
        : null
  } catch {
    walkingOwnerKey = null
  }

  /** owner 变化推进单调 epoch：key 或 base 引用身份任一变化都算新会话，
   * 保证 A-B-A 回到旧 key 也不会复用旧 run；key 为 null（fail closed）时也推进。 */
  const walkingOwnerEpochRef = useRef(0)
  const walkingLastOwnerKeyRef = useRef<string | null | undefined>(undefined)
  const walkingLastBaseRefRef = useRef<unknown>(undefined)
  if (
    walkingLastOwnerKeyRef.current !== walkingOwnerKey ||
    walkingLastBaseRefRef.current !== draft.base
  ) {
    walkingOwnerEpochRef.current += 1
    walkingLastOwnerKeyRef.current = walkingOwnerKey
    walkingLastBaseRefRef.current = draft.base
  }

  /** 与当前可见 run 绑定的 owner epoch：run 在某次 owner 时代里点「检查」产生，
   * owner 变化后 epoch 不匹配的 run 一律视为过期，不会套到新草稿上渲染。 */
  const walkingRunEpochRef = useRef(0)

  /** 偏好设置只属于当前草稿会话：owner（forkTripId + base 完整内容快照）变化后回到
   * 默认禁用，避免旧草稿的上限偏好被带进新草稿的检查结果。旧 run / 旧结论在这轮
   * effect 之前也不会被渲染：结果计算只认与当前 owner epoch 同期的 run。 */
  useEffect(() => {
    setDailyStopLimitEnabled(false)
    setDailyStopLimit(4)
    setDailyStopLimitScope('all_days')
    setEndTimeEnabled(false)
    setEndTimeText('22:00')
    setEndTimeScope('all_days')
    setEndTimeRun(null)
    setEndTimeError(null)
    setWalkingDistanceEnabled(false)
    setWalkingDistanceText('3000')
    setWalkingDistanceScope('all_days')
    setWalkingDistanceRun(null)
    setWalkingDistanceError(null)
    // 重置完成后把当前 run 标成与新 owner 同期；下一次 owner 变化前不再重复重置。
    walkingRunEpochRef.current = walkingOwnerEpochRef.current
    // 依赖含 draft.base 引用身份：内容完全相同的新 base 对象也是新会话，
    // 必须重置偏好；同草稿重渲染时 base 引用不变，不会误触发。
  }, [draft.forkTripId, draft.base, walkingOwnerKey])

  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const addButtonRef = useRef<HTMLButtonElement | null>(null)
  const discardButtonRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLDivElement | null>(null)
  const formAlertRef = useRef<HTMLDivElement | null>(null)
  const actionAlertRef = useRef<HTMLDivElement | null>(null)
  const fieldRefs = useRef<Partial<Record<FormField, HTMLInputElement | HTMLTextAreaElement | null>>>({})
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>())

  const day = draft.days.find((item) => item.day === dayNumber) ?? null
  const changedDays = useMemo(() => draftChangedDays(draft), [draft])
  const dirty = useMemo(() => isDraftDirty(draft), [draft])
  const checks = useMemo(() => localChecksForDraft(draft), [draft])
  const dailyLimitNotices = useMemo(
    () =>
      dailyStopLimitEnabled
        ? dailyStopLimitNotices(draft, dailyStopLimit, dailyStopLimitScope)
        : [],
    [draft, dailyStopLimitEnabled, dailyStopLimit, dailyStopLimitScope],
  )
  /** 冻结设置对应的检查结果；只在开关启用时展示，草稿或冻结参数变化后自动重算。 */
  const endTimeDays = useMemo<EndTimeDayResult[] | null>(() => {
    if (!endTimeEnabled || !endTimeRun) return null
    const result = dailyEndTimeLimitResult(draft, endTimeRun.limit, endTimeRun.scope)
    return result.ok ? result.days : null
  }, [draft, endTimeRun, endTimeEnabled])
  /** 冻结设置对应的步行距离汇总。两条硬约束：
   * 1. owner 绑定：run 只在与它同期的 owner epoch 里有效；换草稿（含同 fork
   *    换 base、同引用 base 原地改内容）后、effect 重置生效前，旧 run / 旧结论
   *    不渲染，不闪现。
   * 2. 当前内容：这里刻意不用 useMemo——useMemo 按依赖（对象引用）缓存，
   *    同一个 draft 对象被原地改 legs 后重渲染会命中旧缓存。每轮渲染都基于
   *    当前 draft 的 legs 重新汇总，编辑 / 撤销 / 切天 / 原地变更都读新值。 */
  const walkingDistanceDays = (() => {
    if (!walkingDistanceEnabled || !walkingDistanceRun) return null
    if (walkingRunEpochRef.current !== walkingOwnerEpochRef.current) return null
    if (walkingOwnerKey === null) return null
    const result = dailyWalkingDistanceResult(
      draft,
      walkingDistanceRun.limit,
      walkingDistanceRun.scope,
    )
    return result.ok ? result.days : null
  })()
  const warnings = draft.base.warnings
  const sessionStale =
    session !== null &&
    (session.forkTripId !== draft.forkTripId || session.revision !== draft.revision)
  const sessionOffDay = session !== null && day !== null && session.dayNumber !== day.day

  const inputDirty = session !== null && isFormDirty(session)
  const editing = session !== null

  const dirtyCallbackRef = useRef(onInputDirtyChange)
  dirtyCallbackRef.current = onInputDirtyChange
  const editingCallbackRef = useRef(onEditingChange)
  editingCallbackRef.current = onEditingChange

  useEffect(() => {
    dirtyCallbackRef.current?.(inputDirty)
  }, [inputDirty])

  useEffect(() => {
    editingCallbackRef.current?.(editing)
  }, [editing])

  // 组件被父视图移除时，明确告诉父视图编辑会话已结束，避免它继续阻止切换。
  useEffect(() => {
    return () => {
      dirtyCallbackRef.current?.(false)
      editingCallbackRef.current?.(false)
    }
  }, [])

  // 草稿或当前天被外部替换时，旧的放弃确认不再指向同一份内容。
  useEffect(() => {
    setDiscardConfirm(false)
  }, [draft.revision, dayNumber])

  useEffect(() => {
    const target = focusRequest
    if (!target) return
    setFocusRequest(null)
    if (target.kind === 'field') {
      fieldRefs.current[target.field]?.focus()
      return
    }
    if (target.kind === 'form-error') {
      formAlertRef.current?.focus()
      return
    }
    if (target.kind === 'action-error') {
      actionAlertRef.current?.focus()
      return
    }
    if (target.kind === 'edit') {
      editButtonRefs.current.get(target.stopId)?.focus()
      if (!editButtonRefs.current.get(target.stopId)) headingRef.current?.focus()
      return
    }
    if (target.kind === 'add') {
      addButtonRef.current?.focus()
      return
    }
    if (target.kind === 'confirm') {
      confirmRef.current?.focus()
      return
    }
    if (target.kind === 'discard') {
      discardButtonRef.current?.focus()
      return
    }
    headingRef.current?.focus()
  }, [focusRequest])

  function openEdit(stop: TripStop) {
    setActionError(null)
    setNotice(null)
    setDiscardConfirm(false)
    const form = formFromStop(stop)
    setSession({
      mode: 'edit',
      dayNumber,
      stopId: stop.id,
      forkTripId: draft.forkTripId,
      revision: draft.revision,
      original: { ...form },
      originalDuration: stop.duration_minutes,
      form: { ...form },
      errors: {},
      formError: null,
    })
    setFocusRequest({ kind: 'field', field: 'name' })
  }

  function openAdd() {
    setActionError(null)
    setNotice(null)
    setDiscardConfirm(false)
    setSession({
      mode: 'add',
      dayNumber,
      stopId: null,
      forkTripId: draft.forkTripId,
      revision: draft.revision,
      original: { ...EMPTY_FORM },
      originalDuration: null,
      form: { ...EMPTY_FORM },
      errors: {},
      formError: null,
    })
    setFocusRequest({ kind: 'field', field: 'name' })
  }

  function cancelSession() {
    if (!session) return
    const target: FocusTarget =
      session.mode === 'edit' && session.stopId
        ? { kind: 'edit', stopId: session.stopId }
        : { kind: 'add' }
    setSession(null)
    setFocusRequest(target)
  }

  function updateField(field: FormField, value: string) {
    setSession((current) => {
      if (!current) return current
      const errors = { ...current.errors }
      delete errors[field]
      return {
        ...current,
        form: { ...current.form, [field]: value },
        errors,
        formError: null,
      }
    })
  }

  function setFormError(message: string) {
    setSession((current) => (current ? { ...current, formError: message } : current))
  }

  function closeAfterSave(target: FocusTarget, message: string) {
    setSession(null)
    setNotice(message)
    setFocusRequest(target)
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session) return

    // 保存前核对打开表单时的草稿身份：fork id / revision 任一变化都拒绝写入。
    if (sessionStale) {
      setFormError(
        '草稿在编辑期间被更新过，这次输入没有写入草稿。输入仍保留在表单里，' +
          '可以复制内容后取消，或放弃草稿后重新打开编辑。',
      )
      setFocusRequest({ kind: 'form-error' })
      return
    }

    const validation = validateSession(session)
    const errorFields = FORM_FIELDS.filter((field) => validation.errors[field])
    if (errorFields.length > 0) {
      setSession((current) =>
        current
          ? {
              ...current,
              errors: validation.errors,
              formError: `有 ${errorFields.length} 个字段未通过校验，输入已保留；修正后再保存。`,
            }
          : current,
      )
      setFocusRequest({ kind: 'field', field: errorFields[0] })
      return
    }

    if (!day) {
      setFormError(`草稿里没有第 ${session.dayNumber} 天，无法保存这次输入；输入仍保留在表单里。`)
      setFocusRequest({ kind: 'form-error' })
      return
    }

    const patch = desiredPatches(session, validation)

    if (session.mode === 'edit') {
      const stopId = session.stopId
      if (!stopId) {
        setFormError('找不到正在编辑的站点；输入仍保留在表单里。')
        return
      }
      const result = updateDraftStop(draft, session.dayNumber, stopId, patch)
      if (!result.ok) {
        setFormError(result.message)
        setFocusRequest({ kind: 'form-error' })
        return
      }
      if (!result.changed) {
        closeAfterSave({ kind: 'edit', stopId }, '这次输入与草稿里的当前值相同，草稿未改动。')
        return
      }
      onDraftChange(result.draft)
      closeAfterSave(
        { kind: 'edit', stopId },
        '已写入内存草稿，尚未保存或应用；名称 / 地址改动会让该站坐标与相关路段待重新获取。',
      )
      return
    }

    let stopId: string
    try {
      stopId = createStopId()
    } catch {
      setFormError('生成新站点 id 失败，输入仍保留在表单里；可以重试或取消。')
      setFocusRequest({ kind: 'form-error' })
      return
    }
    const result = addDraftStop(draft, session.dayNumber, {
      id: stopId,
      name: patch.name ?? '',
      time: patch.time ?? '',
      duration_minutes: patch.duration_minutes,
      description: patch.description,
      address: patch.address,
    })
    if (!result.ok) {
      setFormError(result.message)
      setFocusRequest({ kind: 'form-error' })
      return
    }
    if (!result.changed) {
      setFormError('新站点没有产生实际变化，草稿未改动。')
      return
    }
    onDraftChange(result.draft)
    closeAfterSave(
      { kind: 'edit', stopId },
      '已把新站点写入内存草稿（没有坐标，路线待重新获取）；尚未保存或应用。',
    )
  }

  function runDraftEdit(
    result: DraftEditResult,
    successText: string,
    focusAfter: FocusTarget,
  ): void {
    if (!result.ok) {
      setNotice(null)
      setActionError(result.message)
      setFocusRequest({ kind: 'action-error' })
      return
    }
    if (!result.changed) {
      setNotice('没有实际变化，草稿未改动。')
      return
    }
    setActionError(null)
    setNotice(successText)
    onDraftChange(result.draft)
    setFocusRequest(focusAfter)
  }

  function handleMove(stop: TripStop, index: number, direction: 'up' | 'down') {
    if (!day) return
    const result = moveDraftStop(draft, day.day, stop.id, direction)
    runDraftEdit(
      result,
      `已${direction === 'up' ? '上移' : '下移'}${describeStop(stop, index)}（仅改内存草稿，可撤销，未自动保存）。`,
      { kind: 'edit', stopId: stop.id },
    )
  }

  function handleRemove(stop: TripStop, index: number) {
    if (!day) return
    const result = removeDraftStop(draft, day.day, stop.id)
    runDraftEdit(
      result,
      `已从内存草稿删除${describeStop(stop, index)}（可撤销，未自动保存）。`,
      { kind: 'day' },
    )
  }

  function handleUndo() {
    setActionError(null)
    const result = undoDraft(draft)
    if (!result.ok) {
      setActionError(result.message)
      setFocusRequest({ kind: 'action-error' })
      return
    }
    if (!result.changed) {
      setNotice('没有可撤销的草稿操作。')
      return
    }
    setNotice('已撤销上一步草稿操作；撤销只改内存草稿，不会自动保存，也不会自动重新请求路线。')
    onDraftChange(result.draft)
    setFocusRequest({ kind: 'day' })
  }

  function handleApply() {
    if (session || !dirty) return
    setNotice(null)
    setActionError(null)
    const result = applyDraft(draft)
    if (!result.ok) {
      setActionError(
        `应用失败：${result.message} 草稿仍保留在内存里，可以继续修改，或放弃草稿回到原行程。`,
      )
      setFocusRequest({ kind: 'action-error' })
      return
    }
    if (!result.changed) {
      setNotice('草稿与原始行程没有内容差异，没有生成新的行程副本。')
      return
    }
    onApply(result)
    const omitted =
      result.omittedWarnings > 0
        ? `另有 ${result.omittedWarnings} 条编辑前提醒因 40 条上限没有保留，原始行程仍在。`
        : ''
    setNotice(
      `已应用到新的行程副本（${result.changedDays.map((item) => `第 ${item} 天`).join('、')}有修改）。` +
        `仍需手动保存到浏览器；导出的日历是新副本，不会更新之前导入的日历事件。${omitted}`,
    )
  }

  function handleDiscardClick() {
    if (session) return
    setActionError(null)
    setNotice(null)
    if (!dirty) {
      onDiscard()
      setDiscardConfirm(false)
      setNotice('草稿与原始行程一致，已关闭草稿状态。')
      setFocusRequest({ kind: 'day' })
      return
    }
    setDiscardConfirm(true)
    setFocusRequest({ kind: 'confirm' })
  }

  function handleConfirmDiscard() {
    setDiscardConfirm(false)
    setSession(null)
    setActionError(null)
    setNotice('已放弃草稿，未应用的修改已丢弃；原始行程没有被修改。')
    onDiscard()
    setFocusRequest({ kind: 'day' })
  }

  function handleCancelDiscard() {
    setDiscardConfirm(false)
    setFocusRequest({ kind: 'discard' })
  }

  function abandonOffDayInput() {
    setSession(null)
    setNotice('已放弃这次未保存的单站输入。')
    setFocusRequest({ kind: 'day' })
  }

  /** 点「检查」：先解析当前输入，非法就在区内报错；合法定为本次冻结设置。
   * 修改输入 / 范围 / 关闭开关都会清除旧结果（见各 onChange），禁用状态不会
   * 冒充已检查的结果。 */
  function handleEndTimeCheck() {
    if (!endTimeEnabled) return
    const parsed = parseDailyEndTimeLimit(endTimeText.trim())
    if (!parsed.ok) {
      setEndTimeError(parsed.message)
      return
    }
    setEndTimeError(null)
    setEndTimeRun({ limit: parsed.minutes, scope: endTimeScope })
  }

  /** 点「检查」：先解析当前输入，空 / 非法就在区内明示（空不等于 0，不静默裁值）；
   * 合法定为本次冻结设置，并绑定当前 owner epoch。修改输入 / 范围 / 关闭开关都会
   * 清除旧结果（见各 onChange）；owner 切换后旧 run 因 epoch 不匹配不会渲染。 */
  function handleWalkingDistanceCheck() {
    if (!walkingDistanceEnabled) return
    if (walkingOwnerKey === null) {
      setWalkingDistanceError(
        '当前草稿无法核对归属，步行距离检查不可用；请换草稿后重试。',
      )
      return
    }
    const parsed = parseDailyWalkingDistanceLimit(walkingDistanceText)
    if (!parsed.ok) {
      setWalkingDistanceError(parsed.message)
      return
    }
    setWalkingDistanceError(null)
    walkingRunEpochRef.current = walkingOwnerEpochRef.current
    setWalkingDistanceRun({ limit: parsed.meters, scope: walkingDistanceScope })
  }

  const checkPreview = checksExpanded ? checks : checks.slice(0, CHECK_PREVIEW_COUNT)
  const hiddenCheckCount = checks.length - CHECK_PREVIEW_COUNT
  const warningPreview = warningsExpanded ? warnings : warnings.slice(0, WARNING_PREVIEW_COUNT)
  const hiddenWarningCount = warnings.length - WARNING_PREVIEW_COUNT
  const sourceLabel = draft.base.source === 'example' ? '示例参考' : 'AI 规划'

  function renderStopForm(current: EditorSession) {
    const isNew = current.mode === 'add'
    const index = day
      ? day.stops.findIndex((stop) => stop.id === current.stopId)
      : -1
    const title = isNew
      ? `新增站点（第 ${current.dayNumber} 天末尾）`
      : `编辑第 ${index + 1} 站「${current.original.name}」`
    const errors = current.errors

    return (
      <form
        className="mt-3 grid gap-3 rounded-[10px] border border-[color:var(--color-line-strong)] bg-card p-4"
        onSubmit={handleSave}
        noValidate
        aria-label={title}
      >
        <h4 className="m-0 font-display text-md font-bold leading-normal [overflow-wrap:anywhere]">{title}</h4>
        <p className="m-0 max-w-[78ch] text-xs leading-relaxed text-muted-foreground">
          表单是独立的输入缓冲：可以先清空再重输，只有保存时才校验。保存只写入内存草稿，不会自动保存。
        </p>

        {sessionStale && (
          <Alert variant="warning" role="alert">
            <AlertDescription>
              草稿在编辑期间被更新过。当前输入仍保留在这里，但保存会被拒绝，不会写入新草稿；
              可以复制内容后取消，或放弃这次输入。
            </AlertDescription>
          </Alert>
        )}

        {current.formError && (
          <Alert variant="warning" role="alert" tabIndex={-1} ref={formAlertRef as unknown as React.Ref<HTMLDivElement>}>
            <AlertDescription>{current.formError}</AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1 [&>*]:min-w-0">
          <Field className="col-span-full">
            <FieldLabel htmlFor={`${formFieldId}-name`}>
              站点名称 <span aria-hidden="true" className="ml-0.5 text-[color:var(--color-accent-foreground)]">*</span>
            </FieldLabel>
            <Input
              id={`${formFieldId}-name`}
              name="name"
              value={current.form.name}
              onChange={(event) => updateField('name', event.target.value)}
              ref={(element) => {
                fieldRefs.current.name = element
              }}
              aria-required="true"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? `${formFieldId}-name-error` : undefined}
              placeholder="例如 断桥残雪"
              autoComplete="off"
            />
            {errors.name && (
              <FieldError id={`${formFieldId}-name-error`}>
                {errors.name}
              </FieldError>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor={`${formFieldId}-time`}>
              时间 <span aria-hidden="true" className="ml-0.5 text-[color:var(--color-accent-foreground)]">*</span>
            </FieldLabel>
            <Input
              id={`${formFieldId}-time`}
              name="time"
              value={current.form.time}
              onChange={(event) => updateField('time', event.target.value)}
              ref={(element) => {
                fieldRefs.current.time = element
              }}
              aria-required="true"
              aria-invalid={errors.time ? true : undefined}
              aria-describedby={
                errors.time ? `${formFieldId}-time-error` : `${formFieldId}-time-help`
              }
              placeholder="HH:MM，例如 09:00"
              inputMode="numeric"
              autoComplete="off"
            />
            {errors.time ? (
              <FieldError id={`${formFieldId}-time-error`}>
                {errors.time}
              </FieldError>
            ) : (
              <FieldDescription id={`${formFieldId}-time-help`}>
                24 小时制 HH:MM。新站点默认留空，需要主动填写，不会自动补时刻。
              </FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor={`${formFieldId}-duration`}>
              停留时长（分钟）
            </FieldLabel>
            <Input
              id={`${formFieldId}-duration`}
              name="duration"
              value={current.form.duration}
              onChange={(event) => updateField('duration', event.target.value)}
              ref={(element) => {
                fieldRefs.current.duration = element
              }}
              aria-invalid={errors.duration ? true : undefined}
              aria-describedby={
                errors.duration
                  ? `${formFieldId}-duration-error`
                  : `${formFieldId}-duration-help`
              }
              placeholder="留空表示不填写停留时长"
              inputMode="numeric"
              autoComplete="off"
            />
            {errors.duration ? (
              <FieldError id={`${formFieldId}-duration-error`}>
                {errors.duration}
              </FieldError>
            ) : (
              <FieldDescription id={`${formFieldId}-duration-help`}>
                留空表示 null，不会自动补一个停留时长。
              </FieldDescription>
            )}
          </Field>

          <Field className="col-span-full">
            <FieldLabel htmlFor={`${formFieldId}-address`}>
              地址
            </FieldLabel>
            <Input
              id={`${formFieldId}-address`}
              name="address"
              value={current.form.address}
              onChange={(event) => updateField('address', event.target.value)}
              ref={(element) => {
                fieldRefs.current.address = element
              }}
              aria-invalid={errors.address ? true : undefined}
              aria-describedby={errors.address ? `${formFieldId}-address-error` : undefined}
              placeholder="可留空；改地址会让坐标与相关路线待重新获取"
              autoComplete="off"
            />
            {errors.address && (
              <FieldError id={`${formFieldId}-address-error`}>
                {errors.address}
              </FieldError>
            )}
          </Field>

          <Field className="col-span-full">
            <FieldLabel htmlFor={`${formFieldId}-description`}>
              描述
            </FieldLabel>
            <Textarea
              id={`${formFieldId}-description`}
              name="description"
              rows={3}
              className="min-h-[84px] resize-y"
              value={current.form.description}
              onChange={(event) => updateField('description', event.target.value)}
              ref={(element) => {
                fieldRefs.current.description = element
              }}
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={
                errors.description ? `${formFieldId}-description-error` : undefined
              }
              placeholder="可留空"
            />
            {errors.description && (
              <FieldError id={`${formFieldId}-description-error`}>
                {errors.description}
              </FieldError>
            )}
          </Field>
        </div>

        {isNew && (
          <p className="m-0 max-w-[78ch] text-xs font-semibold leading-relaxed text-[color:var(--color-secondary-foreground)]">
            新站点没有坐标，这里不提供手填经纬度；插入后相关路段会标为待重新获取，不会用直线冒充已更新地图。
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-t-border pt-3">
          <Button type="submit">
            保存到草稿
          </Button>
          <Button variant="outline" onClick={cancelSession}>
            取消输入
          </Button>
          <span className="flex-[1_1_240px] text-xs leading-relaxed text-[color:var(--color-faint)]">
            保存只写内存草稿；改名称 / 地址才会清空该站坐标并使相关路段待重新获取，改时间 / 停留 / 描述不会。
          </span>
        </div>
      </form>
    )
  }

  return (
    <section className="grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5" role="region" aria-label="本地行程草稿编辑器">
      <header className="flex flex-wrap items-start justify-between gap-3 max-md:flex-col">
        <div className="min-w-0 flex-[1_1_260px]">
          <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-foreground)]">本地行程编辑 · 内存草稿</p>
          <h3 className="m-0 mb-2 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent-foreground)] focus-visible:outline-offset-2 focus-visible:rounded-[6px]" ref={headingRef} tabIndex={-1} id={`${baseId}-title`}>
            {draft.base.title}
          </h3>
          <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
            <Badge variant={draft.base.source === 'example' ? 'warning' : 'secondary'} className="text-[10px] tracking-[0.08em]" data-source={draft.base.source}>
              {sourceLabel}
            </Badge>
            <span className="font-mono tabular-nums text-[color:var(--color-secondary-foreground)]">
              {day ? `第 ${day.day} 天` : `第 ${dayNumber} 天（草稿里没有）`}
            </span>
            {day && <span>{day.date ?? '日期未填'}</span>}
            {day && day.title && <span className="text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">{day.title}</span>}
            {day && <span>{day.stops.length} 个站点</span>}
          </p>
          <p className="m-0 mt-2 max-w-[72ch] text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
            修改只写入这份内存草稿，不会自动保存到浏览器、也不会发送到后端。点「应用草稿」才会生成新的行程副本，
            之后仍需用现有的保存按钮手动保存。
          </p>
        </div>
        <p
          className={
            dirty
              ? 'm-0 shrink-0 self-start rounded-full border border-[color:var(--color-primary)] bg-accent-surface px-3 py-1 text-xs text-[color:var(--color-accent-foreground)]'
              : 'm-0 shrink-0 self-start rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground'
          }
        >
          {dirty
            ? `草稿已修改：${changedDays.map((item) => `第 ${item} 天`).join('、')}`
            : '草稿与原始行程一致'}
        </p>
      </header>

      {draft.base.source === 'example' && (
        <Alert variant="warning">
          <AlertDescription>
            这是示例行程（示例参考）：应用后仍保留示例身份，导出的日历会继续带「示例」标记，不会变成真实安排。
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          onClick={openAdd}
          ref={addButtonRef}
          disabled={session !== null || day === null}
        >
          新增站点
        </Button>
        <Button
          variant="outline"
          onClick={handleUndo}
          disabled={session !== null || draft.history.length === 0}
        >
          撤销草稿操作
        </Button>
        <Button
          onClick={handleApply}
          disabled={session !== null || !dirty}
        >
          应用草稿
        </Button>
        <Button
          variant="outline"
          onClick={handleDiscardClick}
          ref={discardButtonRef}
          disabled={session !== null}
        >
          放弃草稿
        </Button>
      </div>

      <p className="m-0 -mt-2 text-xs text-[color:var(--color-faint)]">
        撤销只改内存草稿，不会自动保存；应用也不会改变已保存的原记录，原保存记录要等你再次手动保存才会更新。
      </p>

      {session && (
        <Alert variant="default" role="note" className="bg-secondary">
          <AlertDescription>
            单站输入尚未保存：新增 / 删除 / 上下移动 / 撤销 / 应用 / 放弃在这个编辑器里已暂停，避免结构动作把输入带走。
            先保存到草稿或取消输入。
          </AlertDescription>
        </Alert>
      )}

      {sessionOffDay && session && (
        <div
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[0_6px_6px_0] border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[var(--color-warn-bg)] p-3"
          role="status"
        >
          <p className="m-0 flex-[1_1_240px] text-sm leading-relaxed text-[color:var(--color-warn-ink)]">
            第 {session.dayNumber} 天有一个未保存的单站输入，当前正在查看第 {day.day} 天；输入仍保留，
            回到第 {session.dayNumber} 天即可继续，或在这里放弃这次输入。
          </p>
          <Button variant="outline" onClick={abandonOffDayInput}>
            放弃这次输入
          </Button>
        </div>
      )}

      {discardConfirm && (
        <div
          className="rounded-[10px] border border-dashed border-[color:var(--color-primary)] bg-accent-surface p-3 focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent-foreground)] focus-visible:outline-offset-2"
          role="group"
          aria-label="确认放弃草稿"
          tabIndex={-1}
          ref={confirmRef}
        >
          <p className="m-0 mb-2 text-sm text-[color:var(--color-accent-foreground)]">确认放弃本地草稿？未应用的修改会丢失，当前查看的原始行程不会被修改。</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleConfirmDiscard}>
              确认放弃草稿
            </Button>
            <Button variant="outline" onClick={handleCancelDiscard}>
              继续编辑
            </Button>
          </div>
        </div>
      )}

      {actionError && (
        <Alert variant="warning" role="alert" tabIndex={-1} ref={actionAlertRef as unknown as React.Ref<HTMLDivElement>}>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <div aria-live="polite" aria-atomic="true">
        {notice && (
          <Alert variant="success">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
      </div>

      {day === null ? (
        <Alert variant="default" role="status" className="bg-secondary">
          <AlertDescription>
            这份草稿里没有第 {dayNumber} 天，无法编辑；草稿本身没有被修改，可以撤销、应用或放弃它。
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {day.stops.length === 0 && (
            <Alert variant="default" role="status" className="bg-secondary">
              <AlertDescription>
                第 {day.day} 天目前没有站点。本地编辑不会自动补站点；可以点「新增站点」手动加一个，也可以保持空日。
              </AlertDescription>
            </Alert>
          )}

          <ol className="m-0 list-none p-0" aria-label={`第 ${day.day} 天站点`}>
            {day.stops.map((stop, index) => {
              const isEditing =
                session !== null &&
                session.mode === 'edit' &&
                session.stopId === stop.id &&
                session.dayNumber === day.day
              return (
                <li
                  className={`border-t border-t-border py-3 first:border-t-0 ${isEditing ? 'rounded-[10px] border-t-border bg-background pl-3 shadow-[inset_3px_0_0_var(--color-primary)]' : ''}`}
                  key={stop.id}
                  data-editing={isEditing || undefined}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">第 {index + 1} 站</span>
                    {onSelectStop ? (
                      <button
                        type="button"
                        className="m-0 min-h-[28px] min-w-0 cursor-pointer appearance-none border-0 bg-none p-0 text-left font-[inherit] font-semibold text-foreground hover:text-[color:var(--color-accent-foreground)] hover:underline hover:underline-offset-[3px] focus-visible:rounded-[6px] focus-visible:outline-2 focus-visible:outline-[color:var(--color-accent-foreground)] focus-visible:outline-offset-2 [overflow-wrap:anywhere]"
                        onClick={() => onSelectStop(stop.id)}
                        aria-label={`在地图中查看${describeStop(stop, index)}`}
                      >
                        {stop.name}
                      </button>
                    ) : (
                      <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{stop.name}</span>
                    )}
                    <span className="font-mono text-sm tabular-nums text-[color:var(--color-secondary-foreground)]">{stop.time || '时间未填'}</span>
                    <span className="text-xs text-muted-foreground">
                      {stop.duration_minutes === null
                        ? '停留未填'
                        : `停留 ${stop.duration_minutes} 分钟`}
                    </span>
                    {stop.location === null && <Badge variant="outline" className="text-[10px]">无坐标</Badge>}
                  </div>
                  <p className="m-0 mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{stop.address || '未填写地址'}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Button
                      variant="ghost"
                      onClick={() => openEdit(stop)}
                      disabled={session !== null}
                      ref={(element) => {
                        if (element) editButtonRefs.current.set(stop.id, element)
                        else editButtonRefs.current.delete(stop.id)
                      }}
                      aria-label={`编辑${describeStop(stop, index)}`}
                    >
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => handleMove(stop, index, 'up')}
                      disabled={session !== null || index === 0}
                      aria-label={`上移${describeStop(stop, index)}`}
                    >
                      上移
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => handleMove(stop, index, 'down')}
                      disabled={session !== null || index === day.stops.length - 1}
                      aria-label={`下移${describeStop(stop, index)}`}
                    >
                      下移
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => handleRemove(stop, index)}
                      disabled={session !== null}
                      aria-label={`删除${describeStop(stop, index)}（可撤销）`}
                    >
                      删除
                    </Button>
                  </div>
                  {isEditing && session && renderStopForm(session)}
                </li>
              )
            })}
          </ol>

          {session?.mode === 'add' && session.dayNumber === day.day && renderStopForm(session)}
        </>
      )}

      <section className="grid min-w-0 gap-2 border-t border-t-border pt-3" aria-labelledby={`${baseId}-limit-title`}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h4 className="m-0 font-display text-base font-bold tracking-[0.02em]" id={`${baseId}-limit-title`}>
            每天最多站点数（偏好检查）
          </h4>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{dailyStopLimitEnabled ? `上限 ${dailyStopLimit} 站` : '未启用'}</span>
        </div>
        <p className="m-0 max-w-[80ch] text-xs leading-relaxed text-muted-foreground">
          这是只属于当前草稿会话的界面设置：不会被保存，也不写入行程或发送到后端。
          超过上限时只给提醒，不会自动删站；旧导入数据里超过 8 站的天照常显示和编辑。
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 [&>label]:inline-flex [&>label]:min-h-6 [&>label]:cursor-pointer [&>label]:items-center [&>label]:gap-2 [&>label]:text-sm">
          <label>
            <input
              type="checkbox"
              checked={dailyStopLimitEnabled}
              onChange={(event) => setDailyStopLimitEnabled(event.target.checked)}
              className="size-4 accent-[color:var(--color-primary)]"
            />{' '}
            启用每天站点数上限检查
          </label>
          <label>
            上限（每天站点数）{' '}
            <Select
              value={dailyStopLimit}
              onChange={(event) => setDailyStopLimit(Number(event.target.value))}
              disabled={!dailyStopLimitEnabled}
              aria-label="每天站点数上限"
              className="w-auto min-w-0"
            >
              {DAILY_STOP_LIMIT_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </label>
          <label>
            检查范围{' '}
            <Select
              value={dailyStopLimitScope}
              onChange={(event) => setDailyStopLimitScope(event.target.value as DailyStopLimitScope)}
              disabled={!dailyStopLimitEnabled}
              aria-label="上限检查范围"
              className="w-auto min-w-0"
            >
              <option value="all_days">所有天</option>
              <option value="changed_days">仅改动过的天</option>
            </Select>
          </label>
        </div>
        {dailyStopLimitEnabled && dailyLimitNotices.length === 0 ? (
          <p className="m-0 text-sm text-[color:var(--color-faint)]">
            {dailyStopLimitScope === 'changed_days' && draftChangedDays(draft).length === 0
              ? '草稿还没有改动过的天，切到「所有天」可检查整个行程。'
              : `当前没有天超过每天 ${dailyStopLimit} 站的上限。`}
          </p>
        ) : null}
        {dailyLimitNotices.length > 0 && (
          <ul className="m-0 grid list-none gap-2 p-0" aria-label="每天站点数上限提醒">
            {dailyLimitNotices.map((item) => (
              <li key={item.day} className="flex flex-wrap items-start gap-2 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
                <Badge variant="secondary" className="mt-0.5 shrink-0 font-mono text-[10px]">超过上限</Badge>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid min-w-0 gap-2 border-t border-t-border pt-3" aria-labelledby={`${baseId}-endtime-title`}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h4 className="m-0 font-display text-base font-bold tracking-[0.02em]" id={`${baseId}-endtime-title`}>
            每天最晚结束时间（偏好检查）
          </h4>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {endTimeEnabled
              ? endTimeRun
                ? `上限 ${formatEndTimeClock(endTimeRun.limit)}`
                : '已启用，待检查'
              : '未启用'}
          </span>
        </div>
        <p className="m-0 max-w-[80ch] text-xs leading-relaxed text-muted-foreground">
          这是只属于当前草稿会话的界面设置：不写入行程、不保存、不发给后端，也不会自动修改任何站点；
          草稿要改动或应用由你自己操作。修改输入或范围后旧结果会清除，需要重新点「检查」。
          检查覆盖当天的所有站点，不是只看末站；按填写的开始时刻与停留推算结束下界，
          未计入站间交通耗时，不代表行程不可行、不代表已核实营业或预约。
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 [&>label]:inline-flex [&>label]:min-h-6 [&>label]:cursor-pointer [&>label]:items-center [&>label]:gap-2 [&>label]:text-sm">
          <label>
            <input
              type="checkbox"
              checked={endTimeEnabled}
              onChange={(event) => {
                setEndTimeEnabled(event.target.checked)
                // 关闭开关后旧结果不再属于当前状态：连结果与报错一起清掉，
                // 重新启用后需要重新点「检查」。
                setEndTimeRun(null)
                setEndTimeError(null)
              }}
              className="size-4 accent-[color:var(--color-primary)]"
            />{' '}
            启用每天最晚结束检查
          </label>
          <label>
            最晚结束（HH:MM）{' '}
            <Input
              type="text"
              value={endTimeText}
              onChange={(event) => {
                setEndTimeText(event.target.value)
                // 输入变化说明当前结果不再对应可见设置：清掉旧结果，等重新检查。
                setEndTimeRun(null)
                setEndTimeError(null)
              }}
              disabled={!endTimeEnabled}
              placeholder="例如 22:00"
              inputMode="numeric"
              autoComplete="off"
              aria-label="最晚结束"
              aria-invalid={endTimeError ? true : undefined}
              className="w-auto min-w-0"
            />
          </label>
          <label>
            检查范围{' '}
            <Select
              value={endTimeScope}
              onChange={(event) => {
                setEndTimeScope(event.target.value as DailyEndTimeScope)
                // 范围变化同样作废旧结果，避免旧范围的结果冒充新设置。
                setEndTimeRun(null)
                setEndTimeError(null)
              }}
              disabled={!endTimeEnabled}
              aria-label="最晚结束检查范围"
              className="w-auto min-w-0"
            >
              <option value="all_days">所有天</option>
              <option value="changed_days">仅改动过的天</option>
            </Select>
          </label>
          <Button
            variant="outline"
            onClick={handleEndTimeCheck}
            disabled={!endTimeEnabled}
          >
            检查
          </Button>
        </div>
        {endTimeError && (
          <FieldError role="alert">
            {endTimeError}
          </FieldError>
        )}
        {endTimeEnabled && !endTimeRun && !endTimeError && (
          <p className="m-0 text-sm text-[color:var(--color-faint)]">
            设置好上限与范围后点「检查」出结果；结果只按点检查时的设置展示，
            修改输入或范围后会清除，需要重新检查。
          </p>
        )}
        {endTimeDays !== null && (
          <ul className="m-0 grid list-none gap-2 p-0" aria-label="最晚结束时间检查结果">
            {endTimeDays.map((dayResult) => (
              <li key={dayResult.day} className="flex flex-wrap items-start gap-2 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
                <Badge variant="secondary" className="mt-0.5 shrink-0 font-mono text-[10px]">
                  {dayResult.status === 'over_limit'
                    ? '超限'
                    : dayResult.status === 'unconfirmed'
                      ? '待确认'
                      : dayResult.status === 'empty_day'
                        ? '空日'
                        : '未发现超限'}
                </Badge>
                <div className="min-w-0">
                  {dayResult.summary}
                  {dayResult.findings.length > 0 && (
                    <ul className="m-0 grid list-none gap-2 p-0">
                      {dayResult.findings.map((finding, index) => (
                        <li key={`${finding.stopId}-${index}`} className="flex flex-wrap items-start gap-2 text-sm leading-relaxed [overflow-wrap:anywhere]">
                          <Badge variant="secondary" className="mt-0.5 shrink-0 font-mono text-[10px]">
                            {END_TIME_KIND_LABEL[finding.kind] ?? '待确认'}
                          </Badge>
                          <span>{finding.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid min-w-0 gap-2 border-t border-t-border pt-3" aria-labelledby={`${baseId}-walking-title`}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h4 className="m-0 font-display text-base font-bold tracking-[0.02em]" id={`${baseId}-walking-title`}>
            每天步行距离上限（偏好检查）
          </h4>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {walkingDistanceEnabled
              ? walkingDistanceRun
                ? `上限 ${formatWalkingMeters(walkingDistanceRun.limit)}`
                : '已启用，待检查'
              : '未启用'}
          </span>
        </div>
        <p className="m-0 max-w-[80ch] text-xs leading-relaxed text-muted-foreground">
          这是只属于当前草稿会话的界面设置：不写入行程、不保存、不发给后端，也不会自动修改任何站点。
          {WALKING_DISTANCE_DISCLAIMER}
          修改输入或范围后旧结果会清除，需要重新点「检查」；仅此检查的输入非法不会阻断原来的编辑与应用。
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 [&>label]:inline-flex [&>label]:min-h-6 [&>label]:cursor-pointer [&>label]:items-center [&>label]:gap-2 [&>label]:text-sm">
          <label>
            <input
              type="checkbox"
              checked={walkingDistanceEnabled}
              onChange={(event) => {
                setWalkingDistanceEnabled(event.target.checked)
                // 关闭开关后旧结果不再属于当前状态：连结果与报错一起清掉。
                setWalkingDistanceRun(null)
                setWalkingDistanceError(null)
              }}
              className="size-4 accent-[color:var(--color-primary)]"
            />{' '}
            启用每天步行距离检查
          </label>
          <label>
            每天步行距离上限（米，0–{MAX_DAILY_WALKING_DISTANCE_METERS}）{' '}
            <Input
              type="text"
              value={walkingDistanceText}
              onChange={(event) => {
                setWalkingDistanceText(event.target.value)
                // 输入变化说明当前结果不再对应可见设置：清掉旧结果，等重新检查。
                // 留空保留中间态，不静默变成 0。
                setWalkingDistanceRun(null)
                setWalkingDistanceError(null)
              }}
              disabled={!walkingDistanceEnabled}
              placeholder="例如 3000"
              inputMode="numeric"
              autoComplete="off"
              aria-label="每天步行距离上限"
              aria-invalid={walkingDistanceError ? true : undefined}
              className="w-auto min-w-0"
            />
          </label>
          <label>
            检查范围{' '}
            <Select
              value={walkingDistanceScope}
              onChange={(event) => {
                setWalkingDistanceScope(event.target.value as DailyWalkingDistanceScope)
                // 范围变化同样作废旧结果，避免旧范围的结果冒充新设置。
                setWalkingDistanceRun(null)
                setWalkingDistanceError(null)
              }}
              disabled={!walkingDistanceEnabled}
              aria-label="步行距离检查范围"
              className="w-auto min-w-0"
            >
              <option value="all_days">所有天</option>
              <option value="changed_days">仅改动过的天</option>
            </Select>
          </label>
          <Button
            variant="outline"
            onClick={handleWalkingDistanceCheck}
            disabled={!walkingDistanceEnabled}
          >
            检查
          </Button>
        </div>
        {walkingDistanceError && (
          <FieldError role="alert">
            {walkingDistanceError}
          </FieldError>
        )}
        {walkingDistanceEnabled && !walkingDistanceRun && !walkingDistanceError && (
          <p className="m-0 text-sm text-[color:var(--color-faint)]">
            设置好上限与范围后点「检查」出结果；结果只按点检查时的设置展示，
            修改输入或范围后会清除，需要重新检查。
          </p>
        )}
        {walkingDistanceDays !== null && walkingDistanceDays.length === 0 && (
          <p className="m-0 text-sm text-[color:var(--color-faint)]">
            {walkingDistanceScope === 'changed_days'
              ? '没有已改动过的天可检查；切到「所有天」可查看整个行程的已记录步行距离。'
              : '草稿里没有天可检查。'}
          </p>
        )}
        {walkingDistanceDays !== null && walkingDistanceDays.length > 0 && (
          <ul className="m-0 grid list-none gap-2 p-0" aria-label="每天步行距离检查结果">
            {walkingDistanceDays.map((dayResult) => (
              <li key={dayResult.day} className="flex flex-wrap items-start gap-2 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
                <Badge variant="secondary" className="mt-0.5 shrink-0 font-mono text-[10px]">
                  {dayResult.status === 'over_limit'
                    ? '已记录超限'
                    : dayResult.status === 'no_data'
                      ? '暂无数据'
                      : dayResult.status === 'unsafe_sum'
                        ? '合计异常'
                        : '未发现超限'}
                </Badge>
                <div className="min-w-0">
                  {dayResult.summary}
                  <p className="m-0 mt-1 text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
                    纳入 {dayResult.includedLegCount} 段导航步行
                    {dayResult.includedTotalMeters !== null
                      ? `，合计 ${formatWalkingMeters(dayResult.includedTotalMeters)}`
                      : '，合计未知'}
                    ；{dayResult.unknownWalkingLegCount} 段步行距离未知或示意；
                    {dayResult.drivingLegCount} 段驾车不计入步行。
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid min-w-0 gap-2 border-t border-t-border pt-3" aria-labelledby={`${baseId}-checks-title`}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h4 className="m-0 font-display text-base font-bold tracking-[0.02em]" id={`${baseId}-checks-title`}>
            当前本地检查
          </h4>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{checks.length} 条</span>
        </div>
        <p className="m-0 max-w-[80ch] text-xs leading-relaxed text-muted-foreground">
          按你填写的计划时间与停留计算，只覆盖草稿里改动过的天；不代表真实预约、营业状态或实测交通，
          也不是「最晚结束时间」偏好检查的结果（那在单独的区块里）。
          改时间 / 停留 / 描述不会清除已有坐标和路线；改名称 / 地址才会让该站坐标与相关路段待重新获取。
        </p>
        {checks.length === 0 ? (
          <p className="m-0 text-sm text-[color:var(--color-faint)]">
            {dirty ? '当前改动没有触发本地检查项。' : '草稿还没有改动，因此没有本地检查结果。'}
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0" data-testid="local-check-list">
            {checkPreview.map((check: DraftLocalCheck, index) => (
              <li key={`${check.kind}-${index}`} className="flex flex-wrap items-start gap-2 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
                <Badge variant="secondary" className="mt-0.5 shrink-0 font-mono text-[10px]">{CHECK_KIND_LABEL[check.kind]}</Badge>
                <span>{check.message}</span>
              </li>
            ))}
            {hiddenCheckCount > 0 && (
              <li className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[color:var(--color-faint)]">
                <Button
                  variant="ghost"
                  onClick={() => setChecksExpanded((current) => !current)}
                  aria-expanded={checksExpanded}
                >
                  {checksExpanded ? '收起检查列表' : `展开其余 ${hiddenCheckCount} 条检查`}
                </Button>
                <span>
                  {checksExpanded
                    ? `已显示全部 ${checks.length} 条`
                    : `已显示前 ${Math.min(CHECK_PREVIEW_COUNT, checks.length)} 条，共 ${checks.length} 条`}
                </span>
              </li>
            )}
          </ul>
        )}
      </section>

      <section
        className="grid min-w-0 gap-2 rounded-[0_6px_6px_0] border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[var(--color-warn-bg)] p-3"
        aria-labelledby={`${baseId}-warnings-title`}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <h4 className="m-0 font-display text-base font-bold tracking-[0.02em] [&+span]:text-[color:var(--color-warn-ink)]" id={`${baseId}-warnings-title`}>
            编辑前行程提醒（仅供参考）
          </h4>
          <span className="font-mono text-xs tabular-nums text-[color:var(--color-warn-ink)]">{warnings.length} 条</span>
        </div>
        <p className="m-0 max-w-[80ch] text-xs leading-relaxed text-[color:var(--color-warn-ink)]">
          以下是原始行程已有的提醒，属于编辑前的参考，尚未按草稿重新核对；它和上面的「当前本地检查」不是同一份结果，
          既不能当成仍然成立，也不能当成已经排除。
        </p>
        {warnings.length === 0 ? (
          <p className="m-0 text-sm text-[color:var(--color-warn-ink)]">原始行程没有提醒。这不代表当前草稿没有本地检查项。</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0" data-testid="base-warning-list">
            {warningPreview.map((warning: string, index: number) => (
              <li key={index} className="text-sm leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]">{warning}</li>
            ))}
            {hiddenWarningCount > 0 && (
              <li className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[color:var(--color-warn-ink)]">
                <Button
                  variant="ghost"
                  onClick={() => setWarningsExpanded((current) => !current)}
                  aria-expanded={warningsExpanded}
                >
                  {warningsExpanded
                    ? '收起提醒列表'
                    : `展开其余 ${hiddenWarningCount} 条提醒`}
                </Button>
                <span>
                  {warningsExpanded
                    ? `已显示全部 ${warnings.length} 条`
                    : `已显示前 ${Math.min(WARNING_PREVIEW_COUNT, warnings.length)} 条，共 ${warnings.length} 条`}
                </span>
              </li>
            )}
          </ul>
        )}
      </section>

      <p className="m-0 border-t border-t-border pt-3 text-xs leading-relaxed text-[color:var(--color-faint)]">
        应用后会生成新的行程副本。导出日历的事件会对应新副本，
        之前导入到日历的旧事件不会被更新或删除。
      </p>
    </section>
  )
}

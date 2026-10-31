import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'

import type { TripStop } from '../lib/api'
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
import './tripDraftEditor.css'

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

  // 偏好设置只属于当前草稿会话：换草稿（forkTripId 变化）后回到默认禁用，
  // 避免旧草稿的上限偏好被带进新草稿的检查结果。
  useEffect(() => {
    setDailyStopLimitEnabled(false)
    setDailyStopLimit(4)
    setDailyStopLimitScope('all_days')
  }, [draft.forkTripId])

  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const addButtonRef = useRef<HTMLButtonElement | null>(null)
  const discardButtonRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLDivElement | null>(null)
  const formAlertRef = useRef<HTMLParagraphElement | null>(null)
  const actionAlertRef = useRef<HTMLParagraphElement | null>(null)
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
        className="tde-form"
        onSubmit={handleSave}
        noValidate
        aria-label={title}
      >
        <h4 className="tde-form-title">{title}</h4>
        <p className="tde-form-note">
          表单是独立的输入缓冲：可以先清空再重输，只有保存时才校验。保存只写入内存草稿，不会自动保存。
        </p>

        {sessionStale && (
          <p className="tde-alert tde-alert-error" role="alert">
            草稿在编辑期间被更新过。当前输入仍保留在这里，但保存会被拒绝，不会写入新草稿；
            可以复制内容后取消，或放弃这次输入。
          </p>
        )}

        {current.formError && (
          <p className="tde-alert tde-alert-error" role="alert" tabIndex={-1} ref={formAlertRef}>
            {current.formError}
          </p>
        )}

        <div className="tde-form-grid">
          <div className="field tde-field tde-field-name">
            <label className="field-label" htmlFor={`${formFieldId}-name`}>
              站点名称 <span className="req" aria-hidden="true">*</span>
            </label>
            <input
              id={`${formFieldId}-name`}
              name="name"
              className="field-input"
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
              <p className="field-error" id={`${formFieldId}-name-error`}>
                {errors.name}
              </p>
            )}
          </div>

          <div className="field tde-field tde-field-time">
            <label className="field-label" htmlFor={`${formFieldId}-time`}>
              时间 <span className="req" aria-hidden="true">*</span>
            </label>
            <input
              id={`${formFieldId}-time`}
              name="time"
              className="field-input tde-time-input"
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
              <p className="field-error" id={`${formFieldId}-time-error`}>
                {errors.time}
              </p>
            ) : (
              <p className="field-help" id={`${formFieldId}-time-help`}>
                24 小时制 HH:MM。新站点默认留空，需要主动填写，不会自动补时刻。
              </p>
            )}
          </div>

          <div className="field tde-field tde-field-duration">
            <label className="field-label" htmlFor={`${formFieldId}-duration`}>
              停留时长（分钟）
            </label>
            <input
              id={`${formFieldId}-duration`}
              name="duration"
              className="field-input tde-duration-input"
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
              <p className="field-error" id={`${formFieldId}-duration-error`}>
                {errors.duration}
              </p>
            ) : (
              <p className="field-help" id={`${formFieldId}-duration-help`}>
                留空表示 null，不会自动补一个停留时长。
              </p>
            )}
          </div>

          <div className="field tde-field tde-field-address">
            <label className="field-label" htmlFor={`${formFieldId}-address`}>
              地址
            </label>
            <input
              id={`${formFieldId}-address`}
              name="address"
              className="field-input"
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
              <p className="field-error" id={`${formFieldId}-address-error`}>
                {errors.address}
              </p>
            )}
          </div>

          <div className="field tde-field tde-field-description">
            <label className="field-label" htmlFor={`${formFieldId}-description`}>
              描述
            </label>
            <textarea
              id={`${formFieldId}-description`}
              name="description"
              className="field-input tde-description-input"
              rows={3}
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
              <p className="field-error" id={`${formFieldId}-description-error`}>
                {errors.description}
              </p>
            )}
          </div>
        </div>

        {isNew && (
          <p className="tde-form-note tde-form-note-strong">
            新站点没有坐标，这里不提供手填经纬度；插入后相关路段会标为待重新获取，不会用直线冒充已更新地图。
          </p>
        )}

        <div className="tde-form-actions">
          <button type="submit" className="btn btn-primary">
            保存到草稿
          </button>
          <button type="button" className="btn btn-ghost" onClick={cancelSession}>
            取消输入
          </button>
          <span className="tde-form-hint">
            保存只写内存草稿；改名称 / 地址才会清空该站坐标并使相关路段待重新获取，改时间 / 停留 / 描述不会。
          </span>
        </div>
      </form>
    )
  }

  return (
    <section className="tde" role="region" aria-label="本地行程草稿编辑器">
      <header className="tde-head">
        <div className="tde-head-main">
          <p className="tde-eyebrow">本地行程编辑 · 内存草稿</p>
          <h3 className="tde-title" ref={headingRef} tabIndex={-1} id={`${baseId}-title`}>
            {draft.base.title}
          </h3>
          <p className="tde-meta">
            <span className="tde-source" data-source={draft.base.source}>
              {sourceLabel}
            </span>
            <span className="tde-day-chip">
              {day ? `第 ${day.day} 天` : `第 ${dayNumber} 天（草稿里没有）`}
            </span>
            {day && <span>{day.date ?? '日期未填'}</span>}
            {day && day.title && <span className="tde-day-title">{day.title}</span>}
            {day && <span>{day.stops.length} 个站点</span>}
          </p>
          <p className="tde-boundary">
            修改只写入这份内存草稿，不会自动保存到浏览器、也不会发送到后端。点「应用草稿」才会生成新的行程副本，
            之后仍需用现有的保存按钮手动保存。
          </p>
        </div>
        <p className="tde-dirty" data-dirty={dirty}>
          {dirty
            ? `草稿已修改：${changedDays.map((item) => `第 ${item} 天`).join('、')}`
            : '草稿与原始行程一致'}
        </p>
      </header>

      {draft.base.source === 'example' && (
        <p className="tde-example-note">
          这是示例行程（示例参考）：应用后仍保留示例身份，导出的日历会继续带「示例」标记，不会变成真实安排。
        </p>
      )}

      <div className="tde-toolbar">
        <button
          type="button"
          className="btn btn-save"
          onClick={openAdd}
          ref={addButtonRef}
          disabled={session !== null || day === null}
        >
          新增站点
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleUndo}
          disabled={session !== null || draft.history.length === 0}
        >
          撤销草稿操作
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleApply}
          disabled={session !== null || !dirty}
        >
          应用草稿
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleDiscardClick}
          ref={discardButtonRef}
          disabled={session !== null}
        >
          放弃草稿
        </button>
      </div>

      <p className="tde-toolbar-note">
        撤销只改内存草稿，不会自动保存；应用也不会改变已保存的原记录，原保存记录要等你再次手动保存才会更新。
      </p>

      {session && (
        <p className="tde-session-lock" role="note">
          单站输入尚未保存：新增 / 删除 / 上下移动 / 撤销 / 应用 / 放弃在这个编辑器里已暂停，避免结构动作把输入带走。
          先保存到草稿或取消输入。
        </p>
      )}

      {sessionOffDay && session && (
        <div className="tde-offday" role="status">
          <p>
            第 {session.dayNumber} 天有一个未保存的单站输入，当前正在查看第 {day.day} 天；输入仍保留，
            回到第 {session.dayNumber} 天即可继续，或在这里放弃这次输入。
          </p>
          <button type="button" className="btn btn-ghost" onClick={abandonOffDayInput}>
            放弃这次输入
          </button>
        </div>
      )}

      {discardConfirm && (
        <div
          className="tde-confirm"
          role="group"
          aria-label="确认放弃草稿"
          tabIndex={-1}
          ref={confirmRef}
        >
          <p>确认放弃本地草稿？未应用的修改会丢失，当前查看的原始行程不会被修改。</p>
          <div className="tde-confirm-actions">
            <button type="button" className="btn" onClick={handleConfirmDiscard}>
              确认放弃草稿
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleCancelDiscard}>
              继续编辑
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <p className="tde-alert tde-alert-error" role="alert" tabIndex={-1} ref={actionAlertRef}>
          {actionError}
        </p>
      )}

      <div aria-live="polite" aria-atomic="true">
        {notice && <p className="tde-notice">{notice}</p>}
      </div>

      {day === null ? (
        <p className="tde-empty" role="status">
          这份草稿里没有第 {dayNumber} 天，无法编辑；草稿本身没有被修改，可以撤销、应用或放弃它。
        </p>
      ) : (
        <>
          {day.stops.length === 0 && (
            <p className="tde-empty">
              第 {day.day} 天目前没有站点。本地编辑不会自动补站点；可以点「新增站点」手动加一个，也可以保持空日。
            </p>
          )}

          <ol className="tde-stops" aria-label={`第 ${day.day} 天站点`}>
            {day.stops.map((stop, index) => {
              const isEditing =
                session !== null &&
                session.mode === 'edit' &&
                session.stopId === stop.id &&
                session.dayNumber === day.day
              return (
                <li className="tde-stop" key={stop.id} data-editing={isEditing || undefined}>
                  <div className="tde-stop-head">
                    <span className="tde-stop-index">第 {index + 1} 站</span>
                    {onSelectStop ? (
                      <button
                        type="button"
                        className="tde-stop-link"
                        onClick={() => onSelectStop(stop.id)}
                        aria-label={`在地图中查看${describeStop(stop, index)}`}
                      >
                        {stop.name}
                      </button>
                    ) : (
                      <span className="tde-stop-name">{stop.name}</span>
                    )}
                    <span className="tde-stop-time">{stop.time || '时间未填'}</span>
                    <span className="tde-stop-duration">
                      {stop.duration_minutes === null
                        ? '停留未填'
                        : `停留 ${stop.duration_minutes} 分钟`}
                    </span>
                    {stop.location === null && <span className="tde-tag">无坐标</span>}
                  </div>
                  <p className="tde-stop-address">{stop.address || '未填写地址'}</p>
                  <div className="tde-stop-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => openEdit(stop)}
                      disabled={session !== null}
                      ref={(element) => {
                        if (element) editButtonRefs.current.set(stop.id, element)
                        else editButtonRefs.current.delete(stop.id)
                      }}
                      aria-label={`编辑${describeStop(stop, index)}`}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleMove(stop, index, 'up')}
                      disabled={session !== null || index === 0}
                      aria-label={`上移${describeStop(stop, index)}`}
                    >
                      上移
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleMove(stop, index, 'down')}
                      disabled={session !== null || index === day.stops.length - 1}
                      aria-label={`下移${describeStop(stop, index)}`}
                    >
                      下移
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleRemove(stop, index)}
                      disabled={session !== null}
                      aria-label={`删除${describeStop(stop, index)}（可撤销）`}
                    >
                      删除
                    </button>
                  </div>
                  {isEditing && session && renderStopForm(session)}
                </li>
              )
            })}
          </ol>

          {session?.mode === 'add' && session.dayNumber === day.day && renderStopForm(session)}
        </>
      )}

      <section className="tde-checks" aria-labelledby={`${baseId}-limit-title`}>
        <div className="tde-section-head">
          <h4 className="tde-section-title" id={`${baseId}-limit-title`}>
            每天最多站点数（偏好检查）
          </h4>
          <span className="tde-count">{dailyStopLimitEnabled ? `上限 ${dailyStopLimit} 站` : '未启用'}</span>
        </div>
        <p className="tde-section-note">
          这是只属于当前草稿会话的界面设置：不会被保存，也不写入行程或发送到后端。
          超过上限时只给提醒，不会自动删站；旧导入数据里超过 8 站的天照常显示和编辑。
        </p>
        <div className="tde-limit-controls">
          <label>
            <input
              type="checkbox"
              checked={dailyStopLimitEnabled}
              onChange={(event) => setDailyStopLimitEnabled(event.target.checked)}
            />{' '}
            启用每天站点数上限检查
          </label>
          <label>
            上限（每天站点数）{' '}
            <select
              value={dailyStopLimit}
              onChange={(event) => setDailyStopLimit(Number(event.target.value))}
              disabled={!dailyStopLimitEnabled}
              aria-label="每天站点数上限"
            >
              {DAILY_STOP_LIMIT_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            检查范围{' '}
            <select
              value={dailyStopLimitScope}
              onChange={(event) => setDailyStopLimitScope(event.target.value as DailyStopLimitScope)}
              disabled={!dailyStopLimitEnabled}
              aria-label="上限检查范围"
            >
              <option value="all_days">所有天</option>
              <option value="changed_days">仅改动过的天</option>
            </select>
          </label>
        </div>
        {dailyStopLimitEnabled && dailyLimitNotices.length === 0 ? (
          <p className="tde-section-empty">
            {dailyStopLimitScope === 'changed_days' && draftChangedDays(draft).length === 0
              ? '草稿还没有改动过的天，切到「所有天」可检查整个行程。'
              : `当前没有天超过每天 ${dailyStopLimit} 站的上限。`}
          </p>
        ) : null}
        {dailyLimitNotices.length > 0 && (
          <ul className="tde-check-list" aria-label="每天站点数上限提醒">
            {dailyLimitNotices.map((item) => (
              <li key={item.day} className="tde-check-item">
                <span className="tde-check-kind">超过上限</span>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="tde-checks" aria-labelledby={`${baseId}-checks-title`}>
        <div className="tde-section-head">
          <h4 className="tde-section-title" id={`${baseId}-checks-title`}>
            当前本地检查
          </h4>
          <span className="tde-count">{checks.length} 条</span>
        </div>
        <p className="tde-section-note">
          按你填写的计划时间与停留计算，只覆盖草稿里改动过的天；不代表真实预约、营业状态或实测交通。
          改时间 / 停留 / 描述不会清除已有坐标和路线；改名称 / 地址才会让该站坐标与相关路段待重新获取。
        </p>
        {checks.length === 0 ? (
          <p className="tde-section-empty">
            {dirty ? '当前改动没有触发本地检查项。' : '草稿还没有改动，因此没有本地检查结果。'}
          </p>
        ) : (
          <ul className="tde-check-list">
            {checkPreview.map((check: DraftLocalCheck, index) => (
              <li key={`${check.kind}-${index}`} className="tde-check-item">
                <span className="tde-check-kind">{CHECK_KIND_LABEL[check.kind]}</span>
                <span>{check.message}</span>
              </li>
            ))}
            {hiddenCheckCount > 0 && (
              <li className="tde-more">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setChecksExpanded((current) => !current)}
                  aria-expanded={checksExpanded}
                >
                  {checksExpanded ? '收起检查列表' : `展开其余 ${hiddenCheckCount} 条检查`}
                </button>
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

      <section className="tde-warnings" aria-labelledby={`${baseId}-warnings-title`}>
        <div className="tde-section-head">
          <h4 className="tde-section-title" id={`${baseId}-warnings-title`}>
            编辑前行程提醒（仅供参考）
          </h4>
          <span className="tde-count">{warnings.length} 条</span>
        </div>
        <p className="tde-section-note">
          以下是原始行程已有的提醒，属于编辑前的参考，尚未按草稿重新核对；它和上面的「当前本地检查」不是同一份结果，
          既不能当成仍然成立，也不能当成已经排除。
        </p>
        {warnings.length === 0 ? (
          <p className="tde-section-empty">原始行程没有提醒。这不代表当前草稿没有本地检查项。</p>
        ) : (
          <ul className="tde-warning-list">
            {warningPreview.map((warning: string, index: number) => (
              <li key={index}>{warning}</li>
            ))}
            {hiddenWarningCount > 0 && (
              <li className="tde-more">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setWarningsExpanded((current) => !current)}
                  aria-expanded={warningsExpanded}
                >
                  {warningsExpanded
                    ? '收起提醒列表'
                    : `展开其余 ${hiddenWarningCount} 条提醒`}
                </button>
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

      <p className="tde-calendar-note">
        应用后会生成新的行程副本。导出日历的事件会对应新副本，
        之前导入到日历的旧事件不会被更新或删除。
      </p>
    </section>
  )
}

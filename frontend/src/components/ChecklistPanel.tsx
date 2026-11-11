/**
 * F5 · 出行准备清单受控面板（不接 App，由 UI integrator 显式嵌入）。
 *
 * 边界：
 * - 完全受控：清单值只来自 props，所有修改通过 onChange(next, context) 交给父级；
 *   面板不写 storage、不碰 Trip、不生成工作区记录。
 * - 编辑表单是本地草稿；未点「保存」前不调用 onChange，取消即丢弃，不误写当前记录。
 * - 模板只展示建议；未勾选并点「添加所选」前 items 不变，新增项一律未准备。
 * - 撤销是 proposal：只有当前清单仍等于上一步结果时才可点；
 *   点了才调用 onChange，绝不自动回滚。
 * - stop / 约束失效只提示并提供「标记需重新关联」；不自动改、不删除任务。
 * - 文本全部走 React 节点转义，无 dangerouslySetInnerHTML。
 */
import { useId, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import type { Trip } from '../lib/api'
import type {
  ChecklistCategoryV1,
  ChecklistItemV1,
  ChecklistV1,
  ConstraintItemV1,
  ConstraintsV1,
} from '../lib/workspaceTypes'
import {
  CHECKLIST_CATEGORY_LABELS,
  CHECKLIST_CATEGORY_ORDER,
  CHECKLIST_FIELD_LIMITS,
  CHECKLIST_PREPARED_LABELS,
  CHECKLIST_TEMPLATES,
  addChecklistItem,
  applyChecklistTemplate,
  auditChecklistLinks,
  checklistItemNeedsRelink,
  collectChecklistStops,
  deleteChecklistItem,
  findChecklistTemplate,
  linkChecklistItemToConstraint,
  linkChecklistItemToStop,
  listChecklistTemplateSuggestions,
  markChecklistItemNeedsRelink,
  reconfirmChecklistItemWithConstraint,
  setChecklistItemDone,
  unlinkChecklistItem,
  unlinkChecklistItemFromConstraint,
  updateChecklistItem,
  type ChecklistMutationResult,
  type ChecklistRelinkIssue,
  type ChecklistRelinkReason,
} from '../lib/checklist'
import {
  CHECKLIST_SEASON_LABELS,
  checklistSuggestionSeason,
  suggestChecklistItems,
  type ChecklistSuggestion,
} from '../lib/checklistSuggestions'
import { createLogicalId } from '../lib/workspace'
import { canonicalJson } from '../lib/workspaceFingerprint'

export type ChecklistPanelStatus = 'ready' | 'readonly' | 'unavailable' | 'salvage' | 'corrupt'

export type ChecklistChangeAction =
  | 'add'
  | 'update'
  | 'toggle'
  | 'delete'
  | 'template'
  | 'relink'
  | 'reconfirm-constraint'
  | 'unlink'
  | 'unlink-constraint'
  | 'undo'

export interface ChecklistChangeContext {
  action: ChecklistChangeAction
  itemId?: string
  templateId?: string
}

export type ChecklistApplyResult = { ok: true } | { ok: false; message: string }

/**
 * 父级应使用统一工作区 adapter：校验 + 单键保存成功后返回 ok；
 * 失败（容量 / quota / 存储不可用）返回 ok:false，原记录与旧字节不变。
 */
export type ChecklistChangeHandler = (
  next: ChecklistV1,
  context: ChecklistChangeContext,
) => ChecklistApplyResult | Promise<ChecklistApplyResult>

export interface ChecklistPanelProps {
  /** 当前有效的 sidecar.checklist（唯一数据源）。 */
  checklist: ChecklistV1
  /** 当前行程只读快照；用于地点关联与失效审计。 */
  trip?: Trip | null
  /** 当前约束只读快照；用于预约关联与失效提示。 */
  constraints?: ConstraintsV1 | null
  /** 上一次已应用的约束快照；提供后才能发现「约束被删」。 */
  previousConstraints?: ConstraintsV1 | null
  /** ready 之外一律只读；salvage = 清单段损坏、未加载、原字节仍保留。 */
  status?: ChecklistPanelStatus
  /** 注入固定时间戳（测试 / 确定性）；省略时用 Date.now()。 */
  now?: number
  onChange: ChecklistChangeHandler
  /** 可选：父级收起入口；只收起视图，不改数据。 */
  onClose?: () => void
  /** 仅在 salvage 状态显示；由父级显式确认后重建记录，面板自身不写空清单。 */
  onRebuildRequest?: () => void
}

interface DraftState {
  category: ChecklistCategoryV1
  title: string
  date: string
  day: string
  stopId: string
  constraintId: string
  notes: string
}

const EMPTY_DRAFT: DraftState = {
  category: 'todo',
  title: '',
  date: '',
  day: '',
  stopId: '',
  constraintId: '',
  notes: '',
}

interface UndoProposal {
  before: ChecklistV1
  afterCanonical: string
}

const STATUS_NOTICES: Record<Exclude<ChecklistPanelStatus, 'ready'>, string> = {
  readonly: '当前清单为只读，尚未启用工作区记录；不会写入任何数据。',
  unavailable: '当前浏览器无法访问本地存储；清单不会保存，也不会假装已保存。',
  salvage: '清单数据损坏，未加载；原始数据保留，未写入。请显式重建后再编辑。',
  corrupt: '工作区记录损坏，暂不能编辑清单；原始数据保留。',
}

const PANEL_NOTE =
  'm-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]'
const FIELD_LABEL =
  'grid min-w-0 gap-1 text-sm text-[color:var(--color-muted-foreground)]'
const SECTION_TITLE = 'm-0 font-display text-md leading-[1.4] tracking-[0.02em]'
const PLAIN_LIST = 'm-0 grid list-none gap-2 p-0'

function parseDraftDay(value: string): number | null | 'invalid' {
  const text = value.trim()
  if (text === '') return null
  const day = Number(text)
  if (!Number.isInteger(day) || day < 1 || day > CHECKLIST_FIELD_LIMITS.day) return 'invalid'
  return day
}

function draftFromItem(item: ChecklistItemV1): DraftState {
  return {
    category: item.category,
    title: item.title,
    date: item.date ?? '',
    day: item.day === null ? '' : String(item.day),
    stopId: item.stopId ?? '',
    constraintId: typeof item.constraintId === 'string' ? item.constraintId : '',
    notes: item.notes ?? '',
  }
}

function sameDraft(a: DraftState, b: DraftState): boolean {
  return (
    a.category === b.category &&
    a.title === b.title &&
    a.date === b.date &&
    a.day === b.day &&
    a.stopId === b.stopId &&
    a.constraintId === b.constraintId &&
    a.notes === b.notes
  )
}

export default function ChecklistPanel({
  checklist,
  trip = null,
  constraints = null,
  previousConstraints = null,
  status = 'ready',
  now,
  onChange,
  onClose,
  onRebuildRequest,
}: ChecklistPanelProps) {
  const headingId = useId()
  const titleFieldId = useId()
  const categoryFieldId = useId()
  const dateFieldId = useId()
  const dayFieldId = useId()
  const stopFieldId = useId()
  const constraintFieldId = useId()
  const notesFieldId = useId()

  const ready = status === 'ready'
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT)
  const [baseline, setBaseline] = useState<DraftState>(EMPTY_DRAFT)
  const [formError, setFormError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [templateId, setTemplateId] = useState<string>(CHECKLIST_TEMPLATES[0]?.id ?? '')
  const [selectedSuggestions, setSelectedSuggestions] = useState<string[]>([])
  const [undo, setUndo] = useState<UndoProposal | null>(null)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string[]>([])

  const timestamp = () => now ?? Date.now()
  const stopOptions = useMemo(() => collectChecklistStops(trip), [trip])
  const stopMap = useMemo(() => new Map(stopOptions.map((stop) => [stop.stopId, stop])), [stopOptions])
  const constraintsKnown = constraints != null
  const constraintById = useMemo(
    () => new Map((constraints?.items ?? []).map((constraint) => [constraint.id, constraint])),
    [constraints],
  )
  const itemMap = useMemo(() => new Map(checklist.items.map((item) => [item.id, item])), [checklist.items])
  const constraintItems = constraints?.items ?? []
  const audit = useMemo(
    () => auditChecklistLinks(checklist, { trip, constraints, previousConstraints }),
    [checklist, trip, constraints, previousConstraints],
  )
  const suggestionCalendar = useMemo(() => {
    const dated = trip?.days.find(
      (day) => typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day.date),
    )
    if (dated && typeof dated.date === 'string') {
      const month = Number(dated.date.slice(5, 7))
      if (Number.isInteger(month) && month >= 1 && month <= 12) {
        return { month, source: 'trip' as const }
      }
    }
    const at = new Date(now ?? Date.now())
    return { month: at.getMonth() + 1, source: 'now' as const }
  }, [trip, now])
  const suggestionMonth = suggestionCalendar.month
  const suggestedSeason = checklistSuggestionSeason(suggestionMonth)
  const suggestionDestination = trip?.destination.trim() ?? ''
  const checklistSuggestions = useMemo(
    () =>
      suggestionsOpen
        ? suggestChecklistItems({
            destination: trip?.destination ?? '',
            days: trip?.days.length ?? 0,
            month: suggestionMonth,
            existingItems: checklist.items,
          })
        : [],
    [suggestionsOpen, trip, checklist.items, suggestionMonth],
  )
  const visibleChecklistSuggestions = checklistSuggestions.filter(
    (suggestion) => !dismissedSuggestions.includes(suggestion.id),
  )
  const currentCanonical = useMemo(() => {
    const result = canonicalJson(checklist)
    return result.ok ? result.text : null
  }, [checklist])
  const undoAvailable =
    undo !== null && currentCanonical !== null && currentCanonical === undo.afterCanonical
  const dirty = formOpen && !sameDraft(draft, baseline)

  const prepared = checklist.items.filter((item) => item.done).length

  const commit = async (next: ChecklistV1, context: ChecklistChangeContext): Promise<boolean> => {
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      const result = await onChange(next, context)
      if (!result.ok) {
        setError(result.message)
        return false
      }
      if (context.action === 'undo') {
        setUndo(null)
      } else {
        const after = canonicalJson(next)
        if (after.ok) {
          setUndo({ before: checklist, afterCanonical: after.text })
        } else {
          setUndo(null)
        }
      }
      return true
    } catch {
      setError('保存失败，当前清单未改变。')
      return false
    } finally {
      setPending(false)
    }
  }

  const commitMutation = async (
    result: ChecklistMutationResult,
    context: ChecklistChangeContext,
  ): Promise<boolean> => {
    if (!result.ok) {
      setError(result.message)
      return false
    }
    return commit(result.value, context)
  }

  const openAdd = () => {
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setBaseline(EMPTY_DRAFT)
    setFormError(null)
    setError(null)
    setFormOpen(true)
  }

  const openEdit = (item: ChecklistItemV1) => {
    const next = draftFromItem(item)
    setEditingId(item.id)
    setDraft(next)
    setBaseline(next)
    setFormError(null)
    setError(null)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setBaseline(EMPTY_DRAFT)
    setFormError(null)
  }

  const setDraftField = <K extends keyof DraftState>(key: K, value: DraftState[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }))
  }

  const selectedConstraint: ConstraintItemV1 | null =
    draft.constraintId === ''
      ? null
      : (constraintItems.find((constraint) => constraint.id === draft.constraintId) ?? null)

  const chooseConstraint = (id: string) => {
    const constraint = constraintItems.find((item) => item.id === id)
    if (!constraint) {
      setDraftField('constraintId', id)
      return
    }
    setDraft((previous) => ({
      ...previous,
      constraintId: id,
      date: constraint.startDate ?? previous.date,
      day: constraint.day === null ? previous.day : String(constraint.day),
      stopId: constraint.stopId ?? previous.stopId,
    }))
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || pending) return
    const title = draft.title.trim()
    if (title.length === 0) {
      setFormError('请填写清单标题。')
      return
    }
    const day = parseDraftDay(draft.day)
    if (day === 'invalid') {
      setFormError(`天序号需为 1–${CHECKLIST_FIELD_LIMITS.day} 的整数，或留空。`)
      return
    }
    const date = draft.date.trim() === '' ? null : draft.date.trim()
    const notes = draft.notes.trim() === '' ? null : draft.notes.trim()
    const stopId = draft.stopId.trim() === '' ? null : draft.stopId.trim()
    const at = timestamp()
    setFormError(null)

    if (editingId === null) {
      if (draft.constraintId !== '' && !selectedConstraint) {
        setFormError('所选预约已不在当前约束中；请重新选择，清单未添加。')
        return
      }
      let inputDay = day
      let inputDate = date
      let inputStopId = stopId
      if (selectedConstraint) {
        inputDay = selectedConstraint.day ?? inputDay
        inputDate = selectedConstraint.startDate ?? inputDate
        inputStopId = selectedConstraint.stopId ?? inputStopId
      }
      const result = addChecklistItem(
        checklist,
        {
          category: draft.category,
          title,
          date: inputDate,
          day: inputDay,
          stopId: inputStopId,
          ...(selectedConstraint ? { constraintId: selectedConstraint.id } : {}),
          notes,
        },
        { id: createLogicalId(), now: at },
      )
      if (await commitMutation(result, { action: 'add' })) {
        closeForm()
        setNotice('已添加清单项；它仍然是未准备状态。')
      }
      return
    }

    const original = itemMap.get(editingId) ?? null
    if (!original) {
      setError('要编辑的清单项已不存在；请刷新清单。')
      return
    }
    let current = checklist
    const updated = updateChecklistItem(
      current,
      editingId,
      { category: draft.category, title, date, day, notes },
      at,
    )
    if (!updated.ok) {
      setError(updated.message)
      return
    }
    current = updated.value

    if (stopId !== (original.stopId ?? null)) {
      if (stopId !== null) {
        const linked = linkChecklistItemToStop(current, editingId, { stopId, day }, at)
        if (!linked.ok) {
          setError(linked.message)
          return
        }
        current = linked.value
      } else if (original.stopId !== null) {
        const unlinked = unlinkChecklistItem(current, editingId, at)
        if (!unlinked.ok) {
          setError(unlinked.message)
          return
        }
        current = unlinked.value
      }
    }

    const originalConstraintId =
      typeof original.constraintId === 'string' ? original.constraintId : ''
    if (draft.constraintId !== originalConstraintId) {
      if (draft.constraintId === '') {
        const unlinked = unlinkChecklistItemFromConstraint(current, editingId, at)
        if (!unlinked.ok) {
          setError(unlinked.message)
          return
        }
        current = unlinked.value
      } else if (selectedConstraint) {
        const linked = linkChecklistItemToConstraint(current, editingId, selectedConstraint, at)
        if (!linked.ok) {
          setError(linked.message)
          return
        }
        current = linked.value
      } else {
        setError('所选预约已不在当前约束中；请重新选择，清单未保存。')
        return
      }
    }

    if (await commit(current, { action: 'update', itemId: editingId })) {
      closeForm()
      setNotice('已保存清单项。')
    }
  }

  const handleToggle = async (item: ChecklistItemV1) => {
    if (!ready || pending) return
    const result = setChecklistItemDone(checklist, item.id, !item.done, timestamp())
    await commitMutation(result, { action: 'toggle', itemId: item.id })
  }

  const handleDelete = async (item: ChecklistItemV1) => {
    if (!ready || pending) return
    const result = deleteChecklistItem(checklist, item.id)
    if (await commitMutation(result, { action: 'delete', itemId: item.id })) {
      if (editingId === item.id) closeForm()
      setNotice('已删除清单项；当前行程没有被改动。')
    }
  }

  const handleUnlink = async (item: ChecklistItemV1) => {
    if (!ready || pending) return
    const result = unlinkChecklistItem(checklist, item.id, timestamp())
    if (!result.ok) {
      setError(result.message)
      return
    }
    const nextNotes = result.value.items.find((entry) => entry.id === item.id)?.notes ?? null
    if (await commitMutation(result, { action: 'unlink', itemId: item.id })) {
      setDraft((previous) => ({ ...previous, stopId: '', notes: nextNotes ?? '' }))
      setBaseline((previous) => ({ ...previous, stopId: '', notes: nextNotes ?? '' }))
      setNotice('已解除地点关联；任务保留并标记为需重新关联。')
    }
  }

  const handleUnlinkFromConstraint = async (item: ChecklistItemV1) => {
    if (!ready || pending) return
    const result = unlinkChecklistItemFromConstraint(checklist, item.id, timestamp())
    if (await commitMutation(result, { action: 'unlink-constraint', itemId: item.id })) {
      setDraft((previous) => ({ ...previous, constraintId: '' }))
      setBaseline((previous) => ({ ...previous, constraintId: '' }))
      setNotice('已解除预约关联；日期、地点、备注与勾选状态都保留。')
    }
  }

  const handleRelinkNotice = async (issue: ChecklistRelinkIssue) => {
    if (!ready || pending) return
    const reason: ChecklistRelinkReason = issue.reason
    const result = markChecklistItemNeedsRelink(checklist, issue.itemId, reason, timestamp())
    if (!result.ok) {
      setError(result.message)
      return
    }
    const nextItem = result.value.items.find((entry) => entry.id === issue.itemId)
    if (await commitMutation(result, { action: 'relink', itemId: issue.itemId })) {
      if (nextItem && editingId === issue.itemId) {
        setDraft((previous) => ({
          ...previous,
          stopId: nextItem.stopId ?? '',
          notes: nextItem.notes ?? '',
        }))
        setBaseline((previous) => ({
          ...previous,
          stopId: nextItem.stopId ?? '',
          notes: nextItem.notes ?? '',
        }))
      }
      setNotice('已标记为需重新关联；任务与勾选状态都保留。')
    }
  }

  /**
   * 逐条「按当前预约重新核对」：只有这个动作才会把当前约束声明的锚点写回该条目，
   * 并由 audit 逐条解除它的 constraint_changed 提示。它不等于上面的「标记」，
   * 也影响不到关联同一约束的其它任务。
   */
  const handleReconfirmConstraint = async (issue: ChecklistRelinkIssue) => {
    if (!ready || pending) return
    const constraint =
      typeof issue.refId === 'string' ? (constraintById.get(issue.refId) ?? null) : null
    if (constraint === null) {
      setError('当前约束里找不到这条预约；「标记需重新关联」不能当成重新核对。')
      return
    }
    const result = reconfirmChecklistItemWithConstraint(checklist, issue.itemId, constraint, timestamp())
    if (!result.ok) {
      setError(result.message)
      return
    }
    const nextItem = result.value.items.find((entry) => entry.id === issue.itemId)
    if (await commitMutation(result, { action: 'reconfirm-constraint', itemId: issue.itemId })) {
      if (nextItem && editingId === issue.itemId) {
        setDraft((previous) => ({
          ...previous,
          date: nextItem.date ?? '',
          day: nextItem.day === null ? '' : String(nextItem.day),
          stopId: nextItem.stopId ?? '',
          notes: nextItem.notes ?? '',
        }))
        setBaseline((previous) => ({
          ...previous,
          date: nextItem.date ?? '',
          day: nextItem.day === null ? '' : String(nextItem.day),
          stopId: nextItem.stopId ?? '',
          notes: nextItem.notes ?? '',
        }))
      }
      setNotice('已按当前预约重新核对；该条目的复核提示解除，其它任务不受影响。')
    }
  }

  const handleUndo = async () => {
    if (!ready || pending || !undoAvailable || !undo) return
    await commit(undo.before, { action: 'undo' })
  }

  const handleTemplateChange = (id: string) => {
    setTemplateId(id)
    setSelectedSuggestions([])
    setError(null)
  }

  const toggleSuggestion = (id: string) => {
    setSelectedSuggestions((previous) =>
      previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
    )
  }

  const handleApplyTemplate = async () => {
    if (!ready || pending) return
    const result = applyChecklistTemplate(checklist, templateId, {
      selectedSuggestionIds: selectedSuggestions,
      now: timestamp(),
      idFactory: createLogicalId,
    })
    if (await commitMutation(result, { action: 'template', templateId })) {
      setSelectedSuggestions([])
      setTemplateOpen(false)
      setNotice('已按所选建议添加清单项；新增项都是未准备状态。')
    }
  }

  const toggleSuggestions = () => {
    if (suggestionsOpen) {
      setSuggestionsOpen(false)
      return
    }
    setDismissedSuggestions([])
    setSuggestionsOpen(true)
    setError(null)
  }

  /** 采纳 = 显式新增一条 done:false 条目；绝不自动勾选。 */
  const handleAdoptSuggestion = async (suggestion: ChecklistSuggestion) => {
    if (!ready || pending) return
    const id = createLogicalId()
    const result = addChecklistItem(
      checklist,
      {
        category: suggestion.category,
        title: suggestion.title,
        notes: `建议理由：${suggestion.reason}`,
      },
      { id, now: timestamp() },
    )
    if (await commitMutation(result, { action: 'add', itemId: id })) {
      setDismissedSuggestions((previous) =>
        previous.includes(suggestion.id) ? previous : [...previous, suggestion.id],
      )
      setNotice('已按建议添加为未准备条目；请自行核对后再勾选。')
    }
  }

  const dismissSuggestion = (suggestion: ChecklistSuggestion) => {
    setDismissedSuggestions((previous) =>
      previous.includes(suggestion.id) ? previous : [...previous, suggestion.id],
    )
    setNotice(`已丢弃「${suggestion.title}」；没有写入清单。`)
  }

  const template = findChecklistTemplate(templateId)
  const templateSuggestions = listChecklistTemplateSuggestions(templateId, checklist)
  const templateApplied = checklist.appliedTemplates.includes(templateId)
  const disabled = !ready || pending

  return (
    <section
      className="grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5 shadow-[var(--shadow-1)] max-md:p-4"
      aria-labelledby={headingId}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_260px]">
          <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-foreground)]">出行准备</p>
          <h2 className="m-0 mb-2 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]" id={headingId}>
            准备清单
          </h2>
          <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-muted-foreground)] [overflow-wrap:anywhere]">
            手工记录要准备的事；打勾只代表你已经准备或核对过，不代查票务状态。
          </p>
          <p className="m-0 mt-1 text-xs leading-[1.65] text-[color:var(--color-muted-foreground)] [overflow-wrap:anywhere]">
            共 {checklist.items.length} 项 · 已准备 {prepared} · 未准备 {checklist.items.length - prepared}
          </p>
        </div>
        {onClose ? (
          <Button variant="outline" onClick={onClose}>
            收起
          </Button>
        ) : null}
      </header>

      {status !== 'ready' ? (
        <div className="grid gap-2">
          <Alert variant="warning" role="status">
            <AlertDescription>{STATUS_NOTICES[status]}</AlertDescription>
          </Alert>
          {status === 'salvage' && onRebuildRequest ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={onRebuildRequest}>
                重建清单（需确认）
              </Button>
              <span className="text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
                仅在明确确认后由工作区 adapter 处理；不会自动把空清单写回原字节。
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {undo ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-border bg-background px-4 py-3"
          role="group"
          aria-label="撤销"
        >
          <span className={`text-sm leading-[1.65] [overflow-wrap:anywhere] ${undoAvailable ? 'text-[color:var(--color-muted-foreground)]' : 'text-[color:var(--color-faint)]'}`}>
            {undoAvailable ? '上一步已保存，可撤销一次。' : '当前清单已变化，撤销提案已失效。'}
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={handleUndo}
            disabled={!undoAvailable || disabled}
          >
            撤销上一步
          </Button>
        </div>
      ) : null}

      {audit.issues.length > 0 ||
      (audit.unrecordedConstraintItems.length > 0 && constraintItems.length > 0) ? (
        <section
          className="grid gap-2 rounded-[6px] border border-dashed border-[color:var(--color-primary)] bg-accent-surface p-4"
          aria-label="需重新关联的清单项"
        >
          <h3 className={SECTION_TITLE}>关联核对</h3>
          <p className={PANEL_NOTE}>
            下面的任务不会自动删除；标记后仍保留标题、备注与勾选状态。
          </p>
          {audit.issues.length > 0 ? (
            <ul className={PLAIN_LIST}>
              {audit.issues.map((issue) => (
                <li
                  key={`${issue.itemId}-${issue.reason}-${issue.refId ?? ''}`}
                  className="flex flex-wrap items-start justify-between gap-3 text-sm leading-[1.6] [overflow-wrap:anywhere]"
                >
                  <span>{issue.message}</span>
                  {issue.reason === 'stop_unlinked' ? (
                    <span className="inline-block rounded-full border border-[color:var(--color-line-strong)] bg-card px-2 py-0.5 text-xs text-[color:var(--color-accent-foreground)] [overflow-wrap:anywhere]">
                      已标记需重新关联
                    </span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleRelinkNotice(issue)}
                        disabled={disabled}
                      >
                        标记需重新关联
                      </Button>
                      {issue.reason === 'constraint_changed' ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleReconfirmConstraint(issue)}
                          disabled={disabled}
                        >
                          按当前预约重新核对
                        </Button>
                      ) : null}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {audit.unrecordedConstraintItems.length > 0 && constraintItems.length > 0 ? (
            <p className={PANEL_NOTE}>
              旧清单有 {audit.unrecordedConstraintItems.length} 项未记录预约关联；日期 / 地点仍独立保留，
              可在编辑中手动关联预约。
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={openAdd} disabled={disabled}>
          新增清单项
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setTemplateOpen((value) => !value)
            setSelectedSuggestions([])
            setError(null)
          }}
          disabled={disabled}
        >
          {templateOpen ? '收起模板' : '用模板'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={toggleSuggestions}
          disabled={disabled}
          aria-expanded={suggestionsOpen}
        >
          {suggestionsOpen ? '收起建议' : '建议携带物'}
        </Button>
        <span className="text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
          模板与建议都只给参考；勾选或采纳后不会自动变成已准备。
        </span>
      </div>

      {suggestionsOpen ? (
        <section
          className="grid gap-2 rounded-[6px] border border-dashed border-[color:var(--color-line-strong)] bg-secondary p-4"
          aria-label="清单建议"
          data-testid="checklist-suggestions"
        >
          <div className="grid min-w-0 gap-1">
            <h3 className={SECTION_TITLE}>建议携带物（本地推断 · 未核实）</h3>
            <p className={PANEL_NOTE}>
              目的地：{suggestionDestination === '' ? '未指定' : suggestionDestination}
              {trip ? ` · 行程 ${trip.days.length} 天` : ' · 行程未加载'}
              {' · '}
              {suggestionMonth} 月
              {suggestionCalendar.source === 'trip' ? '（按行程日期）' : '（按当前月份）'}
              {suggestedSeason === null ? '' : ` · ${CHECKLIST_SEASON_LABELS[suggestedSeason]}`}
            </p>
          </div>
          <p className={PANEL_NOTE}>
            只按目的地关键词、月份与天数做本地推断；不联网、不查询库存或预约。
            采纳只会新增未准备条目，不会自动勾选。
          </p>
          {visibleChecklistSuggestions.length === 0 ? (
            <p className={PANEL_NOTE} role="status">
              建议都处理完了；收起后再次打开可重新生成。
            </p>
          ) : (
            <ul className={PLAIN_LIST} aria-label="清单建议列表">
              {visibleChecklistSuggestions.map((suggestion) => (
                <li
                  className="flex flex-wrap items-start justify-between gap-3 rounded-[6px] border border-border bg-card p-3"
                  key={suggestion.id}
                >
                  <div className="grid min-w-0 flex-[1_1_220px] gap-1">
                    <p className="m-0 flex flex-wrap items-center gap-2 text-sm font-semibold leading-[1.5] [overflow-wrap:anywhere]">
                      {suggestion.title}
                      <span className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                        {CHECKLIST_CATEGORY_LABELS[suggestion.category]}
                      </span>
                    </p>
                    <p className={PANEL_NOTE}>{suggestion.reason}</p>
                    {suggestion.duplicateOf.length > 0 ? (
                      <p className="m-0 inline-block rounded-full border border-[color:var(--color-line-strong)] bg-card px-2 py-0.5 text-xs text-[color:var(--color-accent-foreground)] [overflow-wrap:anywhere]">
                        清单里已有「{suggestion.duplicateOf.join('、')}」；不会自动合并
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleAdoptSuggestion(suggestion)}
                      disabled={disabled || suggestion.duplicateOf.length > 0}
                    >
                      采纳
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => dismissSuggestion(suggestion)}
                      disabled={pending}
                    >
                      丢弃
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className={PANEL_NOTE}>
            采纳后条目仍是「未准备」；勾选只代表你自己核对过。
          </p>
        </section>
      ) : null}

      {templateOpen ? (
        <section className="grid gap-3 rounded-[6px] border border-border bg-background p-4" aria-label="模板建议">
          <label className={FIELD_LABEL} htmlFor={`${notesFieldId}-template`}>
            <span>选择模板</span>
            <Select
              id={`${notesFieldId}-template`}
              value={templateId}
              onChange={(event) => handleTemplateChange(event.target.value)}
              disabled={disabled}
            >
              {CHECKLIST_TEMPLATES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </Select>
          </label>
          {template ? (
            <>
              <p className={PANEL_NOTE}>{template.description}</p>
              {templateApplied ? (
                <p className="m-0 inline-block w-fit rounded-full border border-[color:var(--color-line-strong)] bg-card px-2 py-0.5 text-xs text-[color:var(--color-accent-foreground)] [overflow-wrap:anywhere]">
                  这个模板已经采纳过；可再次添加缺少的条目。
                </p>
              ) : null}
              <ul className="m-0 grid list-none gap-1 p-0">
                {templateSuggestions.map((suggestion) => (
                  <li key={suggestion.id}>
                    <label className="inline-flex min-h-6 cursor-pointer items-center gap-2 [overflow-wrap:anywhere]">
                      <Checkbox
                        checked={selectedSuggestions.includes(suggestion.id)}
                        onChange={() => toggleSuggestion(suggestion.id)}
                        disabled={disabled}
                      />
                      <span>
                        {suggestion.title}
                        <span className="text-xs text-muted-foreground"> · {CHECKLIST_CATEGORY_LABELS[suggestion.category]}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                onClick={handleApplyTemplate}
                disabled={disabled || selectedSuggestions.length === 0}
              >
                添加所选（{selectedSuggestions.length}）
              </Button>
            </>
          ) : (
            <p className={PANEL_NOTE}>模板不存在。</p>
          )}
        </section>
      ) : null}

      {formOpen ? (
        <form className="grid gap-3 rounded-[6px] border border-border bg-background p-4" onSubmit={handleSubmit}>
          <h3 className={SECTION_TITLE}>{editingId === null ? '新增清单项' : '编辑清单项'}</h3>
          {dirty ? (
            <p className={PANEL_NOTE}>
              编辑尚未保存；点「保存」前不会写入清单。
            </p>
          ) : null}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
            <label className={FIELD_LABEL} htmlFor={categoryFieldId}>
              <span>分类</span>
              <Select
                id={categoryFieldId}
                value={draft.category}
                onChange={(event) => setDraftField('category', event.target.value as ChecklistCategoryV1)}
                disabled={disabled}
              >
                {CHECKLIST_CATEGORY_ORDER.map((category) => (
                  <option key={category} value={category}>
                    {CHECKLIST_CATEGORY_LABELS[category]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="grid min-w-0 gap-1 text-sm text-[color:var(--color-muted-foreground)] col-span-full" htmlFor={titleFieldId}>
              <span>标题</span>
              <Input
                id={titleFieldId}
                type="text"
                value={draft.title}
                maxLength={CHECKLIST_FIELD_LIMITS.title}
                onChange={(event) => setDraftField('title', event.target.value)}
                disabled={disabled}
              />
            </label>
            <label className={FIELD_LABEL} htmlFor={dateFieldId}>
              <span>日期（可选）</span>
              <Input
                id={dateFieldId}
                type="date"
                value={draft.date}
                onChange={(event) => setDraftField('date', event.target.value)}
                disabled={disabled}
              />
            </label>
            <label className={FIELD_LABEL} htmlFor={dayFieldId}>
              <span>天序号（可选）</span>
              <Input
                id={dayFieldId}
                type="number"
                inputMode="numeric"
                min={1}
                max={CHECKLIST_FIELD_LIMITS.day}
                value={draft.day}
                onChange={(event) => setDraftField('day', event.target.value)}
                disabled={disabled}
              />
            </label>
            <label className={FIELD_LABEL} htmlFor={stopFieldId}>
              <span>关联地点（可选）</span>
              <Select
                id={stopFieldId}
                value={draft.stopId}
                onChange={(event) => {
                  const stopId = event.target.value
                  const stop = stopMap.get(stopId)
                  setDraft((previous) => ({
                    ...previous,
                    stopId,
                    day: stop ? String(stop.day) : previous.day,
                  }))
                }}
                disabled={disabled || stopOptions.length === 0}
              >
                <option value="">不关联地点</option>
                {stopOptions.map((stop) => (
                  <option key={`${stop.day}-${stop.stopId}`} value={stop.stopId}>
                    第 {stop.day} 天 · {stop.name}
                  </option>
                ))}
                {draft.stopId !== '' && !stopMap.has(draft.stopId) ? (
                  <option value={draft.stopId}>原地点已不在当前行程</option>
                ) : null}
              </Select>
            </label>
            <label className={FIELD_LABEL} htmlFor={constraintFieldId}>
              <span>关联预约（可选）</span>
              <Select
                id={constraintFieldId}
                value={draft.constraintId}
                onChange={(event) => chooseConstraint(event.target.value)}
                disabled={disabled || (constraintItems.length === 0 && draft.constraintId === '')}
              >
                <option value="">不关联预约</option>
                {constraintItems.map((constraint) => (
                  <option key={constraint.id} value={constraint.id}>
                    {constraint.title}
                  </option>
                ))}
                {draft.constraintId !== '' && !constraintById.has(draft.constraintId) ? (
                  <option value={draft.constraintId}>
                    {constraintsKnown
                      ? '原预约已不在当前约束中（需重新关联）'
                      : '已记录预约关联（当前约束未加载）'}
                  </option>
                ) : null}
              </Select>
            </label>
            <label className="grid min-w-0 gap-1 text-sm text-[color:var(--color-muted-foreground)] col-span-full" htmlFor={notesFieldId}>
              <span>备注（可选）</span>
              <Textarea
                id={notesFieldId}
                className="min-h-22"
                value={draft.notes}
                maxLength={CHECKLIST_FIELD_LIMITS.notes}
                onChange={(event) => setDraftField('notes', event.target.value)}
                disabled={disabled}
              />
            </label>
          </div>
          <p className={PANEL_NOTE}>
            关联预约会写入真实预约 ID，并带入其日期 / 天 / 地点；不会修改预约，也不代表预约已核实。
          </p>
          {formError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={disabled}>
              {editingId === null ? '添加这一项' : '保存修改'}
            </Button>
            <Button type="button" variant="outline" onClick={closeForm} disabled={pending}>
              取消
            </Button>
            {editingId !== null && (itemMap.get(editingId)?.stopId ?? null) !== null ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const item = itemMap.get(editingId)
                  if (item) void handleUnlink(item)
                }}
                disabled={disabled}
              >
                解除地点关联
              </Button>
            ) : null}
            {editingId !== null && typeof itemMap.get(editingId)?.constraintId === 'string' ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const item = itemMap.get(editingId)
                  if (item) void handleUnlinkFromConstraint(item)
                }}
                disabled={disabled}
              >
                解除预约关联
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {checklist.items.length === 0 ? (
        <p className={PANEL_NOTE}>
          还没有清单项。可以手工添加，或从模板挑选建议。
        </p>
      ) : (
        <ul className={PLAIN_LIST}>
          {checklist.items.map((item) => {
            const stop = item.stopId === null ? null : (stopMap.get(item.stopId) ?? null)
            const linkedConstraint =
              constraintsKnown && typeof item.constraintId === 'string'
                ? (constraintById.get(item.constraintId) ?? null)
                : null
            const danglingConstraint =
              constraintsKnown && typeof item.constraintId === 'string' && linkedConstraint === null
            const needsRelink = checklistItemNeedsRelink(item)
            const meta: string[] = []
            if (item.date !== null) meta.push(`日期 ${item.date}`)
            if (item.day !== null) meta.push(`第 ${item.day} 天`)
            if (stop) meta.push(`地点 ${stop.name}`)
            else if (item.stopId !== null) meta.push('关联地点已不在当前行程')
            else if (item.originalStopId !== null) meta.push('地点待重新关联')
            if (linkedConstraint) {
              meta.push(`关联预约 ${linkedConstraint.title}`)
            } else if (danglingConstraint) {
              meta.push('关联预约已失效，需重新关联')
            } else if (typeof item.constraintId === 'string') {
              meta.push('已记录预约关联（当前约束未加载）')
            }
            return (
              <li
                className="grid min-w-0 gap-1 rounded-[6px] border border-border bg-background px-4 py-3"
                key={item.id}
                data-checklist-item={item.id}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                  <label className="inline-flex min-h-6 cursor-pointer items-center gap-2 [overflow-wrap:anywhere]">
                    <Checkbox
                      checked={item.done}
                      onChange={() => handleToggle(item)}
                      disabled={disabled}
                      aria-label={`${item.title}：${item.done ? CHECKLIST_PREPARED_LABELS.done : CHECKLIST_PREPARED_LABELS.pending}`}
                    />
                    <span className="text-sm text-[color:var(--color-muted-foreground)]">
                      {item.done ? CHECKLIST_PREPARED_LABELS.done : CHECKLIST_PREPARED_LABELS.pending}
                    </span>
                  </label>
                  <span className="whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {CHECKLIST_CATEGORY_LABELS[item.category]}
                  </span>
                  <strong className="min-w-0 flex-[1_1_200px] text-sm font-semibold [overflow-wrap:anywhere]">{item.title}</strong>
                  <div className="flex flex-wrap gap-1 ml-auto">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(item)}
                      disabled={disabled}
                    >
                      编辑
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleDelete(item)}
                      disabled={disabled}
                      aria-label={`删除 ${item.title}`}
                    >
                      删除
                    </Button>
                  </div>
                </div>
                {meta.length > 0 ? (
                  <p className={PANEL_NOTE}>{meta.join(' · ')}</p>
                ) : null}
                {needsRelink ? (
                  <p className="m-0 inline-block w-fit rounded-full border border-[color:var(--color-line-strong)] bg-card px-2 py-0.5 text-xs text-[color:var(--color-accent-foreground)] [overflow-wrap:anywhere]">
                    需重新关联
                  </p>
                ) : null}
                {item.notes !== null ? (
                  <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-muted-foreground)] [overflow-wrap:anywhere] whitespace-pre-wrap">{item.notes}</p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

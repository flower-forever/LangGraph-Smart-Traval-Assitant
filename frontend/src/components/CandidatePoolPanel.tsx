/**
 * F3 候选地点池面板：受控组件，只提交变更意图，不读写存储、不改当前 Trip。
 *
 * 父级（存储 owner / App 集成）负责：
 * - 读取 / 保存 `CANDIDATES_STORAGE_KEY`、损坏保旧、quota、raw / revision 比对；
 * - 独立备份 / 导入的文件读取、预览与确认；
 * - 接收 `onAddToDraft` 后更新自己的 `TripDraft`；真正应用到 Trip 仍走既有草稿流程。
 *
 * 本面板自己只做：内存表单、纯函数校验、重复提示、筛选与草稿加入预览。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import type { CandidateItemV1, CandidatesRecordV1 } from '../lib/workspace'
import { createLogicalId } from '../lib/workspace'
import { findPoiCardByName, type PoiCardsRecordV1 } from '../lib/poiCards'
import type { TripDraft } from '../lib/tripDraft'
import {
  addCandidateToRecord,
  buildCandidateDraftProposal,
  copyCandidateFromStop,
  createManualCandidate,
  filterCandidates,
  findDuplicateCandidates,
  formatCandidateLocation,
  listCandidateTags,
  parseCandidateCoordinates,
  removeCandidateFromRecord,
  summarizeCandidatesRecord,
  updateCandidateInRecord,
  type CandidateDraftProposal,
  type CandidateMutation,
  type CandidatePoolResult,
  type CandidateStopSource,
} from '../lib/candidatePool'
import {
  CANDIDATE_PACE_LABELS,
  assistantSuggestedNote,
  derivePaceFromDraftDayStopCounts,
  suggestCandidatePlaces,
  type CandidateSuggestion,
} from '../lib/candidateSuggestions'

export type CandidatePoolStorageStatus =
  | 'ok'
  | 'empty'
  | 'loading'
  | 'unavailable'
  | 'corrupt'
  | 'anomaly'
  | 'unknown_version'
  | 'error'

export type CandidatePoolSaveStatus = 'idle' | 'pending' | 'saved' | 'error'

export interface CandidatePoolPanelProps {
  /**
   * 父级持有的候选库记录；null = 未加载 / 损坏 / 不可用。
   * 面板不会读 localStorage，也不会在 null 时凭空新建记录。
   */
  record: CandidatesRecordV1 | null
  /** 父级当前草稿；null = 没有打开的草稿。面板只读，不修改它。 */
  draft: TripDraft | null
  /** 父级从当前 Trip / 草稿整理出的可复制站点；面板不直接读 Trip。 */
  copySources?: readonly CandidateStopSource[]
  storageStatus?: CandidatePoolStorageStatus
  storageMessage?: string | null
  /**
   * 父级存储 owner 的不透明 raw / revision token。变化时本面板立即作废旧预览；
   * 本面板不解析它，也不自行读取任何 storage key。
   */
  storageRevision?: string | number | null
  saveStatus?: CandidatePoolSaveStatus
  saveMessage?: string | null
  /** 只有本地内存记录变化；父级更新 record 后才会反映到界面。 */
  onRecordChange: (next: CandidatesRecordV1) => void
  /** 显式持久化请求；父级 adapter 写 CANDIDATES_STORAGE_KEY 并回报结果。 */
  onSave: (record: CandidatesRecordV1) => void
  /** 显式备份导出请求；父级生成文件与同一份字节。 */
  onExport: (record: CandidatesRecordV1) => void
  /** 显式导入请求；父级负责读取、纯校验预览与确认。 */
  onImportRequest: () => void
  /** 只把预览草稿交给父级；本面板不写 Trip。 */
  onAddToDraft: (proposal: CandidateDraftProposal) => void
  /** 预览生成后的观察回调；不得把它当作已持久化。 */
  onPreview?: (proposal: CandidateDraftProposal) => void
  /**
   * 资料卡库记录（父级读好传入）：候选条目按名称归一化匹配资料卡，
   * 命中时显示「有资料卡」入口徽标。只读；本面板不写任何资料卡键。
   */
  poiCards?: PoiCardsRecordV1 | null
  /** 资料卡入口点击回调；父级决定打开哪个面板（本面板不内嵌编辑器）。 */
  onOpenPoiCard?: (candidateName: string) => void
  /** 显式时钟；测试可注入，默认 Date.now。 */
  now?: () => number
  /** 显式候选 id 工厂；测试可注入，默认 createLogicalId。 */
  createCandidateId?: () => string
  /** 显式新 visit id 工厂；不得复用候选 id。 */
  createVisitStopId?: () => string
  onClose?: () => void
}

interface CandidateFormState {
  name: string
  address: string
  notes: string
  tags: string
  priority: string
  lng: string
  lat: string
}

type MessageTone = 'info' | 'error' | 'success'

interface PanelMessage {
  tone: MessageTone
  text: string
}

interface DuplicateHint {
  candidateName: string
  items: CandidateItemV1[]
}

const defaultNow = () => Date.now()
const defaultCandidateId = () => createLogicalId()
const defaultVisitStopId = () => createLogicalId()

function emptyForm(): CandidateFormState {
  return {
    name: '',
    address: '',
    notes: '',
    tags: '',
    priority: '1',
    lng: '',
    lat: '',
  }
}

function formFromCandidate(candidate: CandidateItemV1): CandidateFormState {
  return {
    name: candidate.name,
    address: candidate.address ?? '',
    notes: candidate.notes ?? '',
    tags: candidate.tags.join('，'),
    priority: String(candidate.priority),
    lng: candidate.location === null ? '' : String(candidate.location.lng),
    lat: candidate.location === null ? '' : String(candidate.location.lat),
  }
}

function parseTagsInput(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
}

function parseOptionalDuration(value: string): number | null | 'invalid' {
  const text = value.trim()
  if (text.length === 0) return null
  const number = Number(text)
  if (!Number.isInteger(number) || number < 0) return 'invalid'
  return number
}

function recordKeyOf(record: CandidatesRecordV1 | null): string {
  if (record === null) return 'null'
  try {
    return JSON.stringify(record)
  } catch {
    return 'unserializable'
  }
}

function draftKeyOf(draft: TripDraft | null): string {
  if (draft === null) return 'null'
  return `${draft.base.id}|${draft.forkTripId}|${draft.revision}`
}

function isWritableStatus(status: CandidatePoolStorageStatus): boolean {
  return status === 'ok' || status === 'empty'
}

function storageNotice(status: CandidatePoolStorageStatus, message: string | null | undefined): string | null {
  switch (status) {
    case 'loading':
      return '候选库尚未加载；本面板不读本地键，也不会凭空新建记录。'
    case 'unavailable':
      return '当前浏览器无法访问本地存储；候选库未加载，不能保存。'
    case 'corrupt':
      return '候选库数据损坏；原始字节已保留，本面板只读，不会用清洗后的数据覆盖。'
    case 'anomaly':
      return '候选库有条目未通过校验；普通写入已拒绝，原始字节保留。'
    case 'unknown_version':
      return '候选库版本未知；原始字节保留，本面板只读。'
    case 'error':
      return message ?? '候选库读取失败；本面板不假装已经加载。'
    case 'empty':
      return '候选库为空；新增后仍需显式保存。'
    default:
      return null
  }
}

function sourceLabel(candidate: CandidateItemV1): string {
  if (candidate.source === 'manual') return '手工新增'
  return candidate.copiedFromStopId === null
    ? '从行程站点复制'
    : `从行程站点复制（${candidate.copiedFromStopId}）`
}

export default function CandidatePoolPanel({
  record,
  draft,
  copySources = [],
  storageStatus,
  storageMessage,
  storageRevision,
  saveStatus = 'idle',
  saveMessage,
  onRecordChange,
  onSave,
  onExport,
  onImportRequest,
  onAddToDraft,
  onPreview,
  poiCards = null,
  onOpenPoiCard,
  now = defaultNow,
  createCandidateId = defaultCandidateId,
  createVisitStopId = defaultVisitStopId,
  onClose,
}: CandidatePoolPanelProps) {
  const baseId = useId()
  const status = storageStatus ?? (record === null ? 'loading' : 'ok')
  const writable = record !== null && isWritableStatus(status) && saveStatus !== 'pending'
  const busy = saveStatus === 'pending'

  const [filterText, setFilterText] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [mode, setMode] = useState<'manual' | 'copy'>('manual')
  const [addForm, setAddForm] = useState<CandidateFormState>(emptyForm)
  const [copyStopId, setCopyStopId] = useState(() => copySources[0]?.stopId ?? '')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<CandidateFormState>(emptyForm)
  const [message, setMessage] = useState<PanelMessage | null>(null)
  const [duplicateHint, setDuplicateHint] = useState<DuplicateHint | null>(null)
  const [undo, setUndo] = useState<{ record: CandidatesRecordV1; label: string } | null>(null)
  const [addCandidateId, setAddCandidateId] = useState<string | null>(null)
  const [addDay, setAddDay] = useState<number>(() => draft?.days[0]?.day ?? 1)
  const [addTime, setAddTime] = useState('')
  const [addDuration, setAddDuration] = useState('')
  const [proposal, setProposal] = useState<CandidateDraftProposal | null>(null)
  const [proposalError, setProposalError] = useState<string | null>(null)
  /** 上下文真实变化后旧预览被作废时的显式状态；挂载首跑不提示。 */
  const [previewInvalid, setPreviewInvalid] = useState<string | null>(null)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const previewContextRef = useRef<{
    recordKey: string
    draftKey: string
    storageRevisionKey: string
  } | null>(null)

  const emittedKeyRef = useRef<string | null>(null)
  const previewContextKeyRef = useRef<{
    recordKey: string
    draftKey: string
    storageRevisionKey: string
  } | null>(null)
  const recordKey = useMemo(() => recordKeyOf(record), [record])
  const draftKey = useMemo(() => draftKeyOf(draft), [draft])
  const storageRevisionKey =
    storageRevision === undefined || storageRevision === null ? 'null' : String(storageRevision)

  // 候选库、草稿或父级 owner raw / revision 变化 → 旧预览立即失效。
  // 只在「真实外部上下文变化」时给出显式失效状态并清掉旧成功消息；挂载首跑不提示，
  // 面板自己刚提交的候选库编辑（emittedKeyRef 命中）也不改写消息状态，只按原行为清预览。
  useEffect(() => {
    const previous = previewContextKeyRef.current
    previewContextKeyRef.current = { recordKey, draftKey, storageRevisionKey }
    previewContextRef.current = null
    setProposal(null)
    setProposalError(null)
    if (previous === null) return
    const recordChangedExternally =
      recordKey !== previous.recordKey && emittedKeyRef.current !== recordKey
    const draftChanged = draftKey !== previous.draftKey
    const storageChanged = storageRevisionKey !== previous.storageRevisionKey
    if (recordChangedExternally || draftChanged || storageChanged) {
      // 旧成功消息（如「已生成预览」）随失效一起清除，不再残留误导
      setMessage(null)
      setPreviewInvalid('候选库、草稿或存储 owner revision 已变化；预览已失效，请重新生成预览。')
    }
  }, [recordKey, draftKey, storageRevisionKey])

  // 外部替换记录时，本组件的单步撤销快照也失效，避免把旧库写回去。
  useEffect(() => {
    if (recordKey !== emittedKeyRef.current) {
      setDirty(false)
      if (undo !== null) setUndo(null)
    }
  }, [recordKey, undo])

  // 只有父级明确报告 saved 才撤掉「本页有未保存变更」的提示。
  useEffect(() => {
    if (saveStatus === 'saved') setDirty(false)
  }, [saveStatus])

  const summary = useMemo(() => (record === null ? null : summarizeCandidatesRecord(record)), [record])
  const tags = useMemo(() => (record === null ? [] : listCandidateTags(record.items)), [record])
  const filtered = useMemo(
    () =>
      record === null
        ? []
        : filterCandidates(record.items, {
            text: filterText,
            tag: tagFilter === '__untagged__' ? null : tagFilter,
            untaggedOnly: tagFilter === '__untagged__',
          }),
    [record, filterText, tagFilter],
  )

  const duplicateById = useMemo(() => {
    const map = new Map<string, CandidateItemV1[]>()
    if (record === null) return map
    for (const item of record.items) {
      map.set(
        item.id,
        findDuplicateCandidates(record.items, item, { excludeId: item.id }),
      )
    }
    return map
  }, [record])

  const selectedCopy = useMemo(
    () => copySources.find((source) => source.stopId === copyStopId) ?? copySources[0] ?? null,
    [copySources, copyStopId],
  )
  const selectedDraftDay = useMemo(
    () => draft?.days.find((day) => day.day === addDay) ?? draft?.days[0] ?? null,
    [draft, addDay],
  )
  const pendingCandidate = useMemo(
    () => record?.items.find((item) => item.id === addCandidateId) ?? null,
    [record, addCandidateId],
  )
  const suggestionInput = useMemo(() => {
    const dayStopCounts = draft?.days.map((day) => day.stops.length) ?? []
    return {
      destination: draft?.base.destination ?? '',
      days: dayStopCounts.length > 0 ? dayStopCounts.length : 1,
      pace: derivePaceFromDraftDayStopCounts(dayStopCounts),
      existingCandidates: record?.items ?? [],
    }
  }, [draft, record])
  const suggestions = useMemo(
    () => (suggestionsOpen ? suggestCandidatePlaces(suggestionInput) : []),
    [suggestionsOpen, suggestionInput],
  )
  const visibleSuggestions = suggestions.filter(
    (suggestion) => !dismissedSuggestions.includes(suggestion.name),
  )
  const notice = storageNotice(status, storageMessage)

  function setError(text: string) {
    setMessage({ tone: 'error', text })
  }

  function setInfo(text: string) {
    setMessage({ tone: 'info', text })
  }

  function setSuccess(text: string) {
    setMessage({ tone: 'success', text })
  }

  function acceptMutation(
    result: CandidatePoolResult<CandidateMutation>,
    label: string,
    successText: string,
  ): CandidateMutation | null {
    if (!result.ok) {
      setError(result.message)
      return null
    }
    if (!result.value.changed) {
      setInfo('没有实际变化；候选库保持原样。')
      return null
    }
    if (record === null) {
      setError('候选库尚未加载，未写入。')
      return null
    }
    emittedKeyRef.current = recordKeyOf(result.value.record)
    setUndo({ record, label })
    setDirty(true)
    onRecordChange(result.value.record)
    setSuccess(successText)
    return result.value
  }

  function nextId(factory: () => string, label: string): string | null {
    try {
      return factory()
    } catch {
      setError(`${label}生成失败；没有写入，请稍后重试。`)
      return null
    }
  }

  function handleAddManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!writable || record === null) {
      setError('当前候选库只读，未写入。')
      return
    }
    const coordinates = parseCandidateCoordinates(addForm.lng, addForm.lat)
    if (!coordinates.ok) {
      setError(coordinates.message)
      return
    }
    const id = nextId(createCandidateId, '候选 id ')
    if (id === null) return
    const createdAt = now()
    const candidate = createManualCandidate(
      {
        id,
        name: addForm.name,
        address: addForm.address,
        notes: addForm.notes,
        tags: parseTagsInput(addForm.tags),
        priority: Number(addForm.priority),
        location: coordinates.value,
      },
      createdAt,
    )
    if (!candidate.ok) {
      setError(candidate.message)
      return
    }
    const result = addCandidateToRecord(record, candidate.value, createdAt)
    if (!result.ok) {
      setError(result.message)
      return
    }
    const mutation = acceptMutation(
      result,
      '手工新增候选',
      '已加入候选库的内存草稿；点「保存候选库」才会请求持久化，当前 Trip 未改动。',
    )
    if (mutation === null) return
    setDuplicateHint(
      mutation.duplicates.length > 0
        ? { candidateName: candidate.value.name, items: mutation.duplicates }
        : null,
    )
    setAddForm(emptyForm())
  }

  function handleAddCopy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!writable || record === null) {
      setError('当前候选库只读，未写入。')
      return
    }
    if (selectedCopy === null) {
      setError('当前行程没有可复制的站点；没有写入。')
      return
    }
    const id = nextId(createCandidateId, '候选 id ')
    if (id === null) return
    const createdAt = now()
    const candidate = copyCandidateFromStop(
      {
        id,
        stop: selectedCopy,
        notes: addForm.notes,
        tags: parseTagsInput(addForm.tags),
        priority: Number(addForm.priority),
      },
      createdAt,
    )
    if (!candidate.ok) {
      setError(candidate.message)
      return
    }
    const result = addCandidateToRecord(record, candidate.value, createdAt)
    if (!result.ok) {
      setError(result.message)
      return
    }
    const mutation = acceptMutation(
      result,
      '从行程站点复制候选',
      '已复制为候选库的内存草稿；来源标为 copied，当前 Trip 未改动。',
    )
    if (mutation === null) return
    setDuplicateHint(
      mutation.duplicates.length > 0
        ? { candidateName: candidate.value.name, items: mutation.duplicates }
        : null,
    )
    setAddForm(emptyForm())
  }

  function startEdit(candidate: CandidateItemV1) {
    setEditingId(candidate.id)
    setEditForm(formFromCandidate(candidate))
    setMessage(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditForm(emptyForm())
  }

  function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!writable || record === null || editingId === null) {
      setError('当前候选库只读，未写入。')
      return
    }
    const coordinates = parseCandidateCoordinates(editForm.lng, editForm.lat)
    if (!coordinates.ok) {
      setError(coordinates.message)
      return
    }
    const updatedAt = now()
    const result = updateCandidateInRecord(
      record,
      editingId,
      {
        name: editForm.name,
        address: editForm.address,
        notes: editForm.notes,
        tags: parseTagsInput(editForm.tags),
        priority: Number(editForm.priority),
        location: coordinates.value,
      },
      updatedAt,
    )
    if (!result.ok) {
      setError(result.message)
      return
    }
    if (!result.value.changed) {
      setInfo('没有实际变化；候选库保持原样。')
      setEditingId(null)
      setEditForm(emptyForm())
      return
    }
    const editedName = editForm.name.trim()
    const mutation = acceptMutation(
      result,
      '编辑候选',
      '已在内存中更新候选；点「保存候选库」才会请求持久化，当前 Trip 未改动。',
    )
    if (mutation === null) return
    setDuplicateHint(
      mutation.duplicates.length > 0
        ? { candidateName: editedName, items: mutation.duplicates }
        : null,
    )
    setEditingId(null)
    setEditForm(emptyForm())
  }

  function handleDelete(candidate: CandidateItemV1) {
    if (!writable || record === null) {
      setError('当前候选库只读，未删除。')
      return
    }
    const result = removeCandidateFromRecord(record, candidate.id, now())
    if (!result.ok) {
      setError(result.message)
      return
    }
    const mutation = acceptMutation(
      result,
      '删除候选',
      '已从候选库内存草稿移除；已加入行程的站点不会被删除。',
    )
    if (mutation === null) return
    if (duplicateHint !== null) setDuplicateHint(null)
  }

  function handleUndo() {
    if (undo === null) return
    emittedKeyRef.current = recordKeyOf(undo.record)
    onRecordChange(undo.record)
    setUndo(null)
    setDirty(true)
    previewContextRef.current = null
    setProposal(null)
    setProposalError(null)
    setInfo('已撤销上一步候选库变更；当前 Trip 未改动。')
  }

  function handleGenerateProposal() {
    if (!writable || record === null) {
      setError('当前候选库只读，未生成预览。')
      return
    }
    setProposal(null)
    setProposalError(null)
    previewContextRef.current = null
    if (pendingCandidate === null || selectedDraftDay === null || draft === null) {
      setError('当前没有可用的候选或草稿；未生成预览。')
      return
    }
    if (addTime.trim().length === 0) {
      setError('请先填写加入时间；不会自动补默认时刻。')
      return
    }
    const duration = parseOptionalDuration(addDuration)
    if (duration === 'invalid') {
      setError('停留分钟必须是留空或 0 以上的整数；未生成预览。')
      return
    }
    const visitId = nextId(createVisitStopId, '新站点 id ')
    if (visitId === null) return
    const result = buildCandidateDraftProposal({
      draft,
      candidate: pendingCandidate,
      day: selectedDraftDay.day,
      time: addTime,
      durationMinutes: duration,
      visitStopId: visitId,
    })
    if (!result.ok) {
      setProposal(null)
      previewContextRef.current = null
      setProposalError(result.message)
      return
    }
    previewContextRef.current = { recordKey, draftKey, storageRevisionKey }
    setProposal(result.value)
    setProposalError(null)
    setPreviewInvalid(null)
    setSuccess('已生成加入草稿的预览；尚未写入任何行程或存储。')
    onPreview?.(result.value)
  }

  function handleConfirmAdd() {
    if (proposal === null) return
    const context = previewContextRef.current
    if (
      context === null ||
      context.recordKey !== recordKey ||
      context.draftKey !== draftKey ||
      context.storageRevisionKey !== storageRevisionKey
    ) {
      previewContextRef.current = null
      setProposal(null)
      setProposalError('候选库、草稿或存储 owner revision 已变化；旧预览已失效，请重新生成。')
      return
    }
    onAddToDraft(proposal)
    previewContextRef.current = null
    setProposal(null)
    setProposalError(null)
    setPreviewInvalid(null)
    setAddCandidateId(null)
    setSuccess('已把这次加入交给父级草稿；本面板没有修改 Trip，也未写存储。')
  }

  function handleSave() {
    if (!writable || record === null) {
      setError('当前候选库只读，未发出保存请求。')
      return
    }
    onSave(record)
    setInfo('已发出保存请求；是否已持久化以父级存储 adapter 的结果为准，本面板不假装已保存。')
  }

  function handleExport() {
    if (record === null || !isWritableStatus(status)) {
      setError('当前候选库不可导出；未生成备份。')
      return
    }
    onExport(record)
    setInfo('已发出导出请求；文件由父级存储 adapter 生成，本面板不自行写文件。')
  }

  function handleImport() {
    onImportRequest()
    setInfo('已发出导入请求；父级负责读取、纯校验预览与显式确认，本面板不直接恢复。')
  }

  function toggleSuggestions() {
    if (suggestionsOpen) {
      setSuggestionsOpen(false)
      return
    }
    setDismissedSuggestions([])
    setSuggestionsOpen(true)
    setMessage(null)
  }

  /** 采纳 = 预填手工新增表单；绝不直接入池、绝不自造坐标。 */
  function adoptSuggestion(suggestion: CandidateSuggestion) {
    if (!writable || record === null) {
      setError('当前候选库只读，未填入表单。')
      return
    }
    setMode('manual')
    setAddForm({
      name: suggestion.name,
      address: '',
      notes: assistantSuggestedNote(suggestion.reason),
      tags: suggestion.scene,
      priority: '1',
      lng: '',
      lat: '',
    })
    setDuplicateHint(null)
    setInfo(
      `已把「${suggestion.name}」填入手工新增表单；坐标保持未知，点「添加到候选库」确认后才会入库。`,
    )
  }

  /** 丢弃只隐藏本条建议，零写入。 */
  function dismissSuggestion(suggestion: CandidateSuggestion) {
    setDismissedSuggestions((previous) =>
      previous.includes(suggestion.name) ? previous : [...previous, suggestion.name],
    )
    setInfo(`已丢弃「${suggestion.name}」；没有写入任何数据。`)
  }

  return (
    <section
      className="grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5 shadow-[var(--shadow-1)] max-md:p-4"
      aria-label="候选地点池"
      data-testid="candidate-pool-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_260px]">
          <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-ink)]">独立候选库 · 不写行程</p>
          <h3 className="m-0 mb-2 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]">候选地点池</h3>
          <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">
            攒下想去的地点，规划某天时再加入草稿。所有条目都是「未核实」，
            没有真实搜索、地理编码或账户同步。
          </p>
        </div>
        <Button variant="outline" onClick={onClose}>
          收起
        </Button>
      </div>

      {notice ? (
        <Alert role="note">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[6px] border border-border bg-background px-3 py-2 text-xs text-muted-foreground"
        data-testid="candidate-pool-stats"
      >
        <span>共 {summary?.count ?? 0} 条</span>
        <span>
          {summary?.bytes === null || summary === null
            ? '体积无法测量'
            : `${summary.bytes} / ${summary.maxBytes} 字节（UTF-8）`}
        </span>
        <span>
          上限 {summary?.maxCount ?? 200} 条 / 256 KiB
        </span>
        {filtered.length !== (summary?.count ?? 0) ? <span>当前筛选显示 {filtered.length} 条</span> : null}
      </div>

      <div className="grid minmax(0,1fr) grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <div className="grid min-w-0 gap-1">
          <label htmlFor={`${baseId}-filter-text`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">筛选候选（名称 / 地址 / 备注 / 标签）</label>
          <Input
            id={`${baseId}-filter-text`}
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder="输入关键词"
          />
        </div>
        <div className="grid min-w-0 gap-1">
          <label htmlFor={`${baseId}-filter-tag`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">按区域标签筛选</label>
          <Select
            id={`${baseId}-filter-tag`}
            value={tagFilter}
            onChange={(event) => setTagFilter(event.target.value)}
          >
            <option value="">全部区域</option>
            <option value="__untagged__">无标签</option>
            {tags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {!writable ? (
        <Alert variant="warning" role="note">
          <AlertDescription>
            当前候选库不可写：{status === 'unavailable' ? '本地存储不可用' : '数据状态不是可写状态'}。
            新增 / 编辑 / 删除 / 保存都已禁用，原始数据保持不变。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-3 rounded-[10px] border border-border bg-background p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="m-0 font-display text-md font-bold leading-[1.4] [overflow-wrap:anywhere]">新增候选</h4>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="候选来源">
              <Button
                type="button"
                variant={mode === 'manual' ? 'secondary' : 'outline'}
                aria-pressed={mode === 'manual'}
                onClick={() => setMode('manual')}
              >
                手工新增
              </Button>
              <Button
                type="button"
                variant={mode === 'copy' ? 'secondary' : 'outline'}
                aria-pressed={mode === 'copy'}
                onClick={() => setMode('copy')}
              >
                从行程站点复制
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={toggleSuggestions}
              aria-expanded={suggestionsOpen}
            >
              {suggestionsOpen ? '收起建议' : '帮我出出主意'}
            </Button>
          </div>
        </div>

        {suggestionsOpen ? (
          <section
            className="grid min-w-0 gap-2 rounded-[6px] border border-dashed border-[color:var(--color-line-strong)] bg-secondary px-4 py-3"
            aria-label="候选建议"
            data-testid="candidate-suggestions"
          >
            <div className="grid min-w-0 gap-1">
              <h5 className="m-0 font-display text-base font-bold leading-[1.45] [overflow-wrap:anywhere]">候选点子（本地推断 · 未核实）</h5>
              <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
                目的地：
                {suggestionInput.destination.trim() === ''
                  ? '未指定（只给通用点子）'
                  : suggestionInput.destination}
                {' · '}共 {suggestionInput.days} 天
                {' · '}节奏：{CANDIDATE_PACE_LABELS[suggestionInput.pace]}
              </p>
            </div>
            <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
              这里只是点子，没有搜索、地理编码或真实坐标；采纳只会预填下方手工新增表单，
              不会自动进池，也不会写任何存储键。
            </p>
            {visibleSuggestions.length === 0 ? (
              <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]" role="status">
                建议都处理完了；收起后再次打开可重新生成。
              </p>
            ) : (
              <ul className="m-0 grid list-none gap-2 p-0" aria-label="候选建议列表">
                {visibleSuggestions.map((suggestion) => (
                  <li
                    className="flex flex-wrap items-start justify-between gap-3 rounded-[6px] border border-border bg-card p-3"
                    key={suggestion.name}
                  >
                    <div className="grid min-w-0 flex-[1_1_240px] gap-1">
                      <p className="m-0 font-display text-sm font-bold leading-[1.5] [overflow-wrap:anywhere]">{suggestion.name}</p>
                      <p className="m-0 text-sm leading-[1.6] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">{suggestion.reason}</p>
                      <p className="m-0 text-xs leading-[1.6] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">
                        场景：{suggestion.scene} · 坐标未核实
                      </p>
                      {suggestion.duplicateOf.length > 0 ? (
                        <Alert variant="warning" role="note">
                          <AlertDescription>
                            可能重复：与
                            {suggestion.duplicateOf.map((name) => `「${name}」`).join('、')}
                            同名；不会自动合并。
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        onClick={() => adoptSuggestion(suggestion)}
                        disabled={!writable}
                      >
                        采纳
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => dismissSuggestion(suggestion)}
                      >
                        丢弃
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {mode === 'copy' ? (
          <div className="grid min-w-0 gap-1">
            <label htmlFor={`${baseId}-copy-stop`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">从哪个行程站点复制</label>
            <Select
              id={`${baseId}-copy-stop`}
              value={selectedCopy?.stopId ?? ''}
              onChange={(event) => setCopyStopId(event.target.value)}
              disabled={!writable || copySources.length === 0}
            >
              {copySources.length === 0 ? <option value="">当前行程没有可复制站点</option> : null}
              {copySources.map((source) => (
                <option key={source.stopId} value={source.stopId}>
                  {source.day === null ? '' : `第 ${source.day} 天 · `}
                  {source.name}
                  {source.address === null ? ' · 地址未知' : ` · ${source.address}`}
                </option>
              ))}
            </Select>
            {selectedCopy === null ? (
              <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">没有来源站点；本功能不按名称搜索或地理编码。</p>
            ) : (
              <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
                将复制名称、地址与坐标（未知仍为未知）；来源标为「从行程站点复制」，
                原站点不会被修改，也不会自动去重合并。
              </p>
            )}
          </div>
        ) : null}

        <form
          className="grid min-w-0 gap-3"
          onSubmit={mode === 'manual' ? handleAddManual : handleAddCopy}
          aria-label={mode === 'manual' ? '手工新增候选表单' : '复制候选表单'}
        >
          {mode === 'manual' ? (
            <>
              <div className="grid min-w-0 gap-1">
                <label htmlFor={`${baseId}-name`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">候选名称</label>
                <Input
                  id={`${baseId}-name`}
                  value={addForm.name}
                  onChange={(event) => setAddForm({ ...addForm, name: event.target.value })}
                  disabled={!writable}
                  required
                />
              </div>
              <div className="grid min-w-0 gap-1">
                <label htmlFor={`${baseId}-address`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">地址（可选）</label>
                <Input
                  id={`${baseId}-address`}
                  value={addForm.address}
                  onChange={(event) => setAddForm({ ...addForm, address: event.target.value })}
                  disabled={!writable}
                />
              </div>
            </>
          ) : null}

          <div className="grid min-w-0 gap-1">
            <label htmlFor={`${baseId}-notes`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">备注（可选）</label>
            <Textarea
              id={`${baseId}-notes`}
              value={addForm.notes}
              onChange={(event) => setAddForm({ ...addForm, notes: event.target.value })}
              disabled={!writable}
            />
          </div>
          <div className="grid min-w-0 gap-1">
            <label htmlFor={`${baseId}-tags`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">区域标签（用逗号分隔，可选）</label>
            <Input
              id={`${baseId}-tags`}
              value={addForm.tags}
              onChange={(event) => setAddForm({ ...addForm, tags: event.target.value })}
              disabled={!writable}
              placeholder="例如：西湖，步行"
            />
          </div>
          <div className="grid min-w-0 gap-1">
            <label htmlFor={`${baseId}-priority`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">优先级</label>
            <Select
              id={`${baseId}-priority`}
              value={addForm.priority}
              onChange={(event) => setAddForm({ ...addForm, priority: event.target.value })}
              disabled={!writable}
            >
              <option value="0">0 · 最低</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3 · 最高</option>
            </Select>
          </div>

          {mode === 'manual' ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
              <div className="grid min-w-0 gap-1">
                <label htmlFor={`${baseId}-lng`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">经度（可选）</label>
                <Input
                  id={`${baseId}-lng`}
                  inputMode="decimal"
                  value={addForm.lng}
                  onChange={(event) => setAddForm({ ...addForm, lng: event.target.value })}
                  disabled={!writable}
                  placeholder="留空 = 未知"
                />
              </div>
              <div className="grid min-w-0 gap-1">
                <label htmlFor={`${baseId}-lat`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">纬度（可选）</label>
                <Input
                  id={`${baseId}-lat`}
                  inputMode="decimal"
                  value={addForm.lat}
                  onChange={(event) => setAddForm({ ...addForm, lat: event.target.value })}
                  disabled={!writable}
                  placeholder="留空 = 未知"
                />
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              type="submit"
              disabled={!writable || (mode === 'copy' && selectedCopy === null)}
            >
              {mode === 'manual' ? '添加到候选库' : '复制为候选'}
            </Button>
            <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
              坐标留空表示未知；不会补 (0,0)、不会地理编码。手工来源只标 manual，复制来源只标 copied。
            </p>
          </div>
        </form>
      </div>

      {duplicateHint ? (
        <Alert variant="warning" role="status" data-testid="candidate-pool-duplicate">
          <AlertDescription>
            <strong>可能重复：</strong>
            「{duplicateHint.candidateName}」与
            {duplicateHint.items.map((item) => `「${item.name}」`).join('、')}
            同名同址。只提示，不自动合并、不自动覆盖；两条都可以保留。
          </AlertDescription>
        </Alert>
      ) : null}

      {message ? (
        <Alert
          variant={message.tone === 'error' ? 'warning' : message.tone === 'success' ? 'success' : 'default'}
          role={message.tone === 'error' ? 'alert' : 'status'}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="m-0 font-display text-md font-bold leading-[1.4] [overflow-wrap:anywhere]">候选列表</h4>
        {undo ? (
          <Button type="button" variant="outline" onClick={handleUndo} disabled={busy}>
            撤销上一步（{undo.label}）
          </Button>
        ) : null}
      </div>

      {record === null ? (
        <Alert role="note">
          <AlertDescription>
            候选库尚未加载或不可用；本面板不会读取本地键，也不会假装为空库。
          </AlertDescription>
        </Alert>
      ) : filtered.length === 0 ? (
        <Alert variant="warning" role="note">
          <AlertDescription>
            {record.items.length === 0
              ? '候选库还是空的；可以手工新增或从行程站点复制。'
              : '当前筛选没有命中的候选。筛选只影响显示，不会删除或改写条目。'}
          </AlertDescription>
        </Alert>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0" aria-label="候选地点列表">
          {filtered.map((candidate) => {
            const duplicates = duplicateById.get(candidate.id) ?? []
            return (
              <li
                className="grid min-w-0 gap-3 rounded-[10px] border border-border bg-background p-3"
                key={candidate.id}
                data-source={candidate.source}
                data-testid={`candidate-item-${candidate.id}`}
              >
                <div className="grid min-w-0 gap-1">
                  <h5 className="m-0 flex flex-wrap items-baseline gap-2 font-display text-base font-bold leading-[1.5] [overflow-wrap:anywhere]">
                    {candidate.name}
                    <Badge variant="default">{sourceLabel(candidate)}</Badge>
                    <Badge variant="outline">未核实</Badge>
                    <Badge variant="secondary">优先级 {candidate.priority}</Badge>
                    {(() => {
                      const card = findPoiCardByName(poiCards, candidate.name)
                      if (card === null) return null
                      return (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 rounded-full px-2 py-0.5 text-xs"
                          data-testid={`candidate-poi-card-${candidate.id}`}
                          aria-label={`查看 ${candidate.name} 的资料卡`}
                          onClick={() => onOpenPoiCard?.(candidate.name)}
                        >
                          有资料卡
                        </Button>
                      )
                    })()}
                  </h5>
                  <p className="m-0 text-sm leading-[1.6] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">{candidate.address ?? '地址未知'}</p>
                  {candidate.notes ? (
                    <p className="m-0 text-sm leading-[1.6] text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]">{candidate.notes}</p>
                  ) : null}
                  <p className="m-0 text-sm leading-[1.6] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">
                    {candidate.tags.length === 0 ? '无标签' : `区域：${candidate.tags.join('、')}`}
                  </p>
                  <p className="m-0 text-sm leading-[1.6] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">{formatCandidateLocation(candidate.location)}</p>
                  {duplicates.length > 0 ? (
                    <Alert variant="warning" role="note">
                      <AlertDescription>
                        可能重复：与
                        {duplicates.map((item) => `「${item.name}」`).join('、')}
                        同名同址。未自动合并。
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => startEdit(candidate)} disabled={!writable}>
                    编辑
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setAddCandidateId(candidate.id)
                      setAddTime('')
                      setAddDuration('')
                      previewContextRef.current = null
                      setProposal(null)
                      setProposalError(null)
                    }}
                    disabled={!writable || draft === null}
                  >
                    加入草稿
                  </Button>
                  <Button type="button" variant="destructive" onClick={() => handleDelete(candidate)} disabled={!writable}>
                    删除
                  </Button>
                </div>

                {editingId === candidate.id ? (
                  <form className="grid min-w-0 gap-3 rounded-[6px] border border-border bg-card p-3" onSubmit={handleEditSubmit} aria-label={`编辑候选 ${candidate.name}`}>
                    <div className="grid min-w-0 gap-1">
                      <label htmlFor={`${baseId}-edit-name`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">编辑名称</label>
                      <Input
                        id={`${baseId}-edit-name`}
                        value={editForm.name}
                        onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
                        disabled={!writable}
                        required
                      />
                    </div>
                    <div className="grid min-w-0 gap-1">
                      <label htmlFor={`${baseId}-edit-address`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">编辑地址（可选）</label>
                      <Input
                        id={`${baseId}-edit-address`}
                        value={editForm.address}
                        onChange={(event) => setEditForm({ ...editForm, address: event.target.value })}
                        disabled={!writable}
                      />
                    </div>
                    <div className="grid min-w-0 gap-1">
                      <label htmlFor={`${baseId}-edit-notes`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">编辑备注（可选）</label>
                      <Textarea
                        id={`${baseId}-edit-notes`}
                        value={editForm.notes}
                        onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })}
                        disabled={!writable}
                      />
                    </div>
                    <div className="grid min-w-0 gap-1">
                      <label htmlFor={`${baseId}-edit-tags`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">编辑区域标签（逗号分隔）</label>
                      <Input
                        id={`${baseId}-edit-tags`}
                        value={editForm.tags}
                        onChange={(event) => setEditForm({ ...editForm, tags: event.target.value })}
                        disabled={!writable}
                      />
                    </div>
                    <div className="grid min-w-0 gap-1">
                      <label htmlFor={`${baseId}-edit-priority`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">编辑优先级</label>
                      <Select
                        id={`${baseId}-edit-priority`}
                        value={editForm.priority}
                        onChange={(event) => setEditForm({ ...editForm, priority: event.target.value })}
                        disabled={!writable}
                      >
                        <option value="0">0 · 最低</option>
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="3">3 · 最高</option>
                      </Select>
                    </div>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
                      <div className="grid min-w-0 gap-1">
                        <label htmlFor={`${baseId}-edit-lng`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">编辑经度（可选）</label>
                        <Input
                          id={`${baseId}-edit-lng`}
                          inputMode="decimal"
                          value={editForm.lng}
                          onChange={(event) => setEditForm({ ...editForm, lng: event.target.value })}
                          disabled={!writable}
                          placeholder="留空 = 未知"
                        />
                      </div>
                      <div className="grid min-w-0 gap-1">
                        <label htmlFor={`${baseId}-edit-lat`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">编辑纬度（可选）</label>
                        <Input
                          id={`${baseId}-edit-lat`}
                          inputMode="decimal"
                          value={editForm.lat}
                          onChange={(event) => setEditForm({ ...editForm, lat: event.target.value })}
                          disabled={!writable}
                          placeholder="留空 = 未知"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="submit" disabled={!writable}>
                        保存这次编辑
                      </Button>
                      <Button type="button" variant="outline" onClick={cancelEdit}>
                        取消编辑
                      </Button>
                    </div>
                  </form>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {pendingCandidate !== null ? (
        <div className="grid min-w-0 gap-3 rounded-[6px] border border-border bg-card p-3" data-testid="candidate-pool-add-form">
          <h4 className="m-0 font-display text-md font-bold leading-[1.4] [overflow-wrap:anywhere]">把「{pendingCandidate.name}」加入第几天草稿</h4>
          {draft === null || selectedDraftDay === null ? (
            <Alert role="note">
              <AlertDescription>
                当前没有打开的草稿；请先在行程编辑里创建草稿。本面板不会直接写 Trip。
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
                <div className="grid min-w-0 gap-1">
                  <label htmlFor={`${baseId}-add-day`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">加入第几天草稿</label>
                  <Select
                    id={`${baseId}-add-day`}
                    value={selectedDraftDay.day}
                    onChange={(event) => setAddDay(Number(event.target.value))}
                  >
                    {draft.days.map((day) => (
                      <option key={day.day} value={day.day}>
                        第 {day.day} 天{day.date ? ` · ${day.date}` : ''}
                        {day.title ? ` · ${day.title}` : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid min-w-0 gap-1">
                  <label htmlFor={`${baseId}-add-time`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">加入时间（HH:MM）</label>
                  <Input
                    id={`${baseId}-add-time`}
                    value={addTime}
                    onChange={(event) => setAddTime(event.target.value)}
                    placeholder="例如 09:30"
                  />
                </div>
                <div className="grid min-w-0 gap-1">
                  <label htmlFor={`${baseId}-add-duration`} className="text-sm font-semibold text-[color:var(--color-ink-2)]">停留分钟（可选，留空为未知）</label>
                  <Input
                    id={`${baseId}-add-duration`}
                    inputMode="numeric"
                    value={addDuration}
                    onChange={(event) => setAddDuration(event.target.value)}
                    placeholder="留空 = 未知"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={handleGenerateProposal} disabled={!writable}>
                  生成加入预览
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setAddCandidateId(null)
                    previewContextRef.current = null
                    setProposal(null)
                    setProposalError(null)
                    setPreviewInvalid(null)
                  }}
                >
                  取消加入
                </Button>
                <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
                  时间必须由你填写；不会猜默认时刻。新站点使用独立 id，不复用候选 id。
                </p>
              </div>
            </>
          )}

          {proposalError ? (
            <Alert variant="warning" role="alert">
              <AlertDescription>{proposalError}</AlertDescription>
            </Alert>
          ) : null}

          {previewInvalid !== null && proposal === null ? (
            <Alert role="status">
              <AlertDescription>{previewInvalid}</AlertDescription>
            </Alert>
          ) : null}

          {proposal ? (
            <div className="grid min-w-0 gap-3 rounded-[6px] border border-border bg-card p-3" data-testid="candidate-pool-proposal">
              <h5 className="m-0 font-display text-base font-bold leading-[1.45] [overflow-wrap:anywhere]">
                预览（未写入）：第 {proposal.day} 天 · {proposal.candidateName} · {proposal.time}
              </h5>
              <p className="m-0 text-sm leading-[1.6] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">
                新站点 id：<code>{proposal.visitStopId}</code>（不复用候选 id）
              </p>
              <p className="m-0 text-sm leading-[1.6] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">
                草稿 revision {proposal.draftRevision} · 预览行程 {proposal.previewTripBytes} 字节 ·
                checkTripShape 已通过
              </p>
              <p className="m-0 text-sm leading-[1.6] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">
                {proposal.localChecks.length === 0
                  ? '本次预览没有新增本地检查项。'
                  : `本地检查 ${proposal.localChecks.length} 条：`}
              </p>
              {proposal.localChecks.length > 0 ? (
                <ul className="m-0 grid list-disc gap-1 pl-5 text-sm leading-[1.6] text-[color:var(--color-muted)] [overflow-wrap:anywhere]">
                  {proposal.localChecks.slice(0, 8).map((check, index) => (
                    <li key={`${check.kind}-${check.stopId ?? 'none'}-${index}`}>{check.message}</li>
                  ))}
                </ul>
              ) : null}
              <ul className="m-0 grid list-disc gap-1 pl-5 text-sm leading-[1.6] text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]">
                {proposal.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={handleConfirmAdd}>
                  确认加入草稿
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    previewContextRef.current = null
                    setProposal(null)
                    setProposalError(null)
                  }}
                >
                  取消预览
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="button" onClick={handleSave} disabled={!writable}>
            保存候选库
          </Button>
          <Button type="button" variant="outline" onClick={handleExport} disabled={record === null || !isWritableStatus(status)}>
            导出候选库备份
          </Button>
          <Button type="button" variant="outline" onClick={handleImport} disabled={busy}>
            导入候选库…
          </Button>
        </div>
        <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-muted)] [overflow-wrap:anywhere]" role="status">
          {saveStatus === 'pending'
            ? '正在请求父级存储 adapter 保存候选库…'
            : saveStatus === 'error'
              ? `父级存储 adapter 报告保存失败${saveMessage ? `：${saveMessage}` : ''}。当前显示的是本页内存状态，未持久化的变更仍在。`
              : dirty
                ? '本页有尚未保存的变更；父级上次保存结果不代表这些变更。'
                : saveStatus === 'saved'
                  ? '父级存储 adapter 报告：候选库已保存。'
                  : '尚未保存；所有增删改都只在本页内存里。'}
        </p>
        <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
          本面板不读 localStorage、不写 Trip；保存 / 导入 / 导出都由父级存储 adapter 执行，
          结果以它为准。导入必须由父级预览并显式确认，本面板不直接恢复。
        </p>
      </div>
    </section>
  )
}

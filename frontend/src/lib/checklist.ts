/**
 * F5 · 出行准备清单纯模块。
 *
 * 边界：
 * - 只操作 `ChecklistV1`（sidecar.checklist）的内存值；不读写 localStorage、不碰 Trip、
 *   不生成工作区记录。持久化由统一工作区 adapter 负责，且必须由用户显式保存。
 * - 所有 reducer 先构造下一版，再交给公共 `validateChecklist`（契约 owner 的唯一
 *   schema 门禁）复检；失败返回 failure 并保留入参对象，不做部分写入 / 截断。
 * - `done` 只表示「已准备 / 已核对」，不是预订、出票或库存确认。
 * - 模板只产出未勾选建议；`applyChecklistTemplate` 必须收到显式选中的建议 id。
 * - 删除 / 解绑 stop 不删除条目：保留 `originalStopId` 并在 notes 追加「需重新关联」。
 * - 预约关联使用 W1 释放的可选 `ChecklistItemV1.constraintId`：非 null 时精确记录
 *   目标 `ConstraintItemV1.id`，并同时保留日期 / 天 / stop 锚点供展示；锚点绝不
 *   替代外键。旧记录缺省 `undefined` 与显式 `null` 必须原样保留、互不归一。
 *   审计只按 ID 判定；删除约束后保留 dangling ID 与任务，只提示需重新关联。
 */
import type { Trip } from './api'
import type {
  ChecklistCategoryV1,
  ChecklistItemV1,
  ChecklistV1,
  ConstraintItemV1,
  ConstraintsV1,
  WorkspaceValidationFailure,
} from './workspaceTypes'
import {
  MAX_ANCHOR_DAY,
  MAX_APPLIED_TEMPLATES,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_NOTES_LENGTH,
  MAX_CHECKLIST_TITLE_LENGTH,
  MAX_TEMPLATE_ID_LENGTH,
  MAX_WORKSPACE_ID_LENGTH,
  MAX_WORKSPACE_SIDECAR_BYTES,
} from './workspaceTypes'
import { validateChecklist } from './workspace'
import { utf8ByteLength } from './savedTrips'

/* ───────── 文案 / 分类 ───────── */

export const CHECKLIST_CATEGORY_ORDER: readonly ChecklistCategoryV1[] = [
  'ticket',
  'appointment',
  'document',
  'luggage',
  'todo',
]

export const CHECKLIST_CATEGORY_LABELS: Readonly<Record<ChecklistCategoryV1, string>> = {
  ticket: '票务',
  appointment: '预约',
  document: '证件',
  luggage: '行李',
  todo: '待确认事项',
}

/** 勾选状态的固定文案；不出现「已预订 / 已出票 / 已确认」。 */
export const CHECKLIST_PREPARED_LABELS = {
  done: '已准备',
  pending: '未准备',
} as const

export const CHECKLIST_RELINK_NOTES = {
  stop_deleted: '原地点已不在行程中，需重新关联。',
  stop_unlinked: '已解除地点关联，需重新关联。',
  constraint_deleted: '原预约已不在当前约束中，需重新确认关联。',
  constraint_changed: '关联预约已变更，需重新确认关联。',
} as const

export type ChecklistRelinkReason = keyof typeof CHECKLIST_RELINK_NOTES

export function isChecklistCategory(value: unknown): value is ChecklistCategoryV1 {
  return typeof value === 'string' && (CHECKLIST_CATEGORY_ORDER as readonly string[]).includes(value)
}

export type ChecklistConstraintState = 'unrecorded' | 'unlinked' | 'linked'

/**
 * `undefined` / 属性缺省 = 旧 v1 未记录；`null` = 用户明确解除；string = 弱引用
 * Constraint.id。三者不可互相归一。
 */
export function checklistItemConstraintState(item: ChecklistItemV1): ChecklistConstraintState {
  if (!Object.hasOwn(item, 'constraintId') || item.constraintId === undefined) return 'unrecorded'
  return item.constraintId === null ? 'unlinked' : 'linked'
}

/* ───────── 结果类型 ───────── */

export type ChecklistFailureReason =
  | 'invalid_input'
  | 'invalid_checklist'
  | 'item_not_found'
  | 'duplicate_id'
  | 'limit_exceeded'
  | 'template_unknown'
  | 'suggestion_unknown'
  | 'no_selection'

export interface ChecklistFailure {
  ok: false
  reason: ChecklistFailureReason
  message: string
  path?: string
}

export type ChecklistMutationResult = { ok: true; value: ChecklistV1 } | ChecklistFailure

function fail(
  reason: ChecklistFailureReason,
  message: string,
  path?: string,
): ChecklistFailure {
  return path === undefined ? { ok: false, reason, message } : { ok: false, reason, message, path }
}

function fromValidation(failure: WorkspaceValidationFailure): ChecklistFailure {
  const reason: ChecklistFailureReason =
    failure.reason === 'limit_exceeded'
      ? 'limit_exceeded'
      : failure.reason === 'duplicate_id'
        ? 'duplicate_id'
        : 'invalid_checklist'
  return { ok: false, reason, message: failure.message, path: failure.path }
}

/** 清单段实际 UTF-8 字节（紧凑 JSON），与容量口径一致。 */
export function measureChecklistBytes(checklist: ChecklistV1): number {
  return utf8ByteLength(JSON.stringify(checklist))
}

/**
 * 所有 reducer 的统一出口：先走公共 validator（未知字段 / 字段上限 / 条数 / 重复 id），
 * 再按 sidecar 字节上限做保守预检。失败时调用方原对象不变。
 */
function finish(next: ChecklistV1): ChecklistMutationResult {
  const checked = validateChecklist(next)
  if (!checked.ok) return fromValidation(checked)
  let bytes: number
  try {
    bytes = measureChecklistBytes(checked.value)
  } catch {
    return fail('invalid_checklist', '清单无法序列化；未写入，原清单保持不变。')
  }
  if (bytes > MAX_WORKSPACE_SIDECAR_BYTES) {
    return fail(
      'limit_exceeded',
      `清单实际占用 ${bytes} 字节，超过 sidecar 上限 ${MAX_WORKSPACE_SIDECAR_BYTES} 字节；未写入，不截断。`,
      '$.items',
    )
  }
  return { ok: true, value: checked.value }
}

function copyChecklist(items: readonly ChecklistItemV1[], appliedTemplates: readonly string[]): ChecklistV1 {
  return { items: [...items], appliedTemplates: [...appliedTemplates] }
}

function findItem(checklist: ChecklistV1, id: string): ChecklistItemV1 | undefined {
  return checklist.items.find((item) => item.id === id)
}

function normalizeNullableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = value.trim()
  return text.length === 0 ? null : text
}

function appendNote(notes: string | null, message: string): string | null {
  if (notes !== null && notes.includes(message)) return notes
  return notes === null || notes.length === 0 ? message : `${notes}\n${message}`
}

/* ───────── 新增 / 编辑 / 勾选 / 删除 ───────── */

export interface ChecklistItemInput {
  category: ChecklistCategoryV1
  title: string
  date?: string | null
  day?: number | null
  stopId?: string | null
  /** 仅显式关联预约时传入；普通新增 / 模板不传，保持旧 v1 缺省。 */
  constraintId?: string | null
  notes?: string | null
}

export interface ChecklistCreateOptions {
  /** 调用方提供 id（纯函数不做随机）；面板用 createLogicalId()。 */
  id: string
  now: number
}

export interface ChecklistItemPatch {
  category?: ChecklistCategoryV1
  title?: string
  date?: string | null
  day?: number | null
  notes?: string | null
}

export interface ChecklistStopLink {
  stopId: string
  /** 关联 stop 所在天序号；省略则保留条目原值。 */
  day?: number | null
}

export function createChecklistItem(input: ChecklistItemInput, options: ChecklistCreateOptions): ChecklistItemV1 {
  return {
    id: options.id,
    category: input.category,
    title: input.title.trim(),
    done: false,
    date: normalizeNullableText(input.date),
    day: input.day ?? null,
    stopId: normalizeNullableText(input.stopId),
    originalStopId: null,
    ...(input.constraintId !== undefined ? { constraintId: input.constraintId } : {}),
    notes: normalizeNullableText(input.notes),
    updatedAt: options.now,
  }
}

/**
 * 手工新增。新条目一律 `done:false`（模板与手工都不偷偷变成已办）。
 */
export function addChecklistItem(
  checklist: ChecklistV1,
  input: ChecklistItemInput,
  options: ChecklistCreateOptions,
): ChecklistMutationResult {
  if (!isChecklistCategory(input.category)) {
    return fail('invalid_input', '清单分类不是允许的选项。', '$.category')
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    return fail('invalid_input', '清单标题不能为空。', '$.title')
  }
  if (checklist.items.some((item) => item.id === options.id)) {
    return fail('duplicate_id', '清单项 id 已存在；未写入。', '$.items')
  }
  if (checklist.items.length >= MAX_CHECKLIST_ITEMS) {
    return fail(
      'limit_exceeded',
      `清单最多 ${MAX_CHECKLIST_ITEMS} 项；未写入，不截断。`,
      '$.items',
    )
  }
  return finish(copyChecklist([...checklist.items, createChecklistItem(input, options)], checklist.appliedTemplates))
}

/** 编辑字段；不动 id / done / stop 关联（关联走显式 link / unlink）。 */
export function updateChecklistItem(
  checklist: ChecklistV1,
  id: string,
  patch: ChecklistItemPatch,
  now: number,
): ChecklistMutationResult {
  const current = findItem(checklist, id)
  if (!current) return fail('item_not_found', '要编辑的清单项不存在；原清单保持不变。', '$.items')
  if (patch.category !== undefined && !isChecklistCategory(patch.category)) {
    return fail('invalid_input', '清单分类不是允许的选项。', '$.category')
  }
  if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim().length === 0)) {
    return fail('invalid_input', '清单标题不能为空。', '$.title')
  }
  const nextItem: ChecklistItemV1 = {
    ...current,
    category: patch.category ?? current.category,
    title: patch.title === undefined ? current.title : patch.title.trim(),
    date: patch.date === undefined ? current.date : normalizeNullableText(patch.date),
    day: patch.day === undefined ? current.day : patch.day,
    notes: patch.notes === undefined ? current.notes : normalizeNullableText(patch.notes),
    updatedAt: now,
  }
  return finish(
    copyChecklist(
      checklist.items.map((item) => (item.id === id ? nextItem : item)),
      checklist.appliedTemplates,
    ),
  )
}

export function setChecklistItemDone(
  checklist: ChecklistV1,
  id: string,
  done: boolean,
  now: number,
): ChecklistMutationResult {
  const current = findItem(checklist, id)
  if (!current) return fail('item_not_found', '要勾选的清单项不存在；原清单保持不变。', '$.items')
  const nextItem: ChecklistItemV1 = { ...current, done, updatedAt: now }
  return finish(
    copyChecklist(
      checklist.items.map((item) => (item.id === id ? nextItem : item)),
      checklist.appliedTemplates,
    ),
  )
}

export function toggleChecklistItem(
  checklist: ChecklistV1,
  id: string,
  now: number,
): ChecklistMutationResult {
  const current = findItem(checklist, id)
  if (!current) return fail('item_not_found', '要勾选的清单项不存在；原清单保持不变。', '$.items')
  return setChecklistItemDone(checklist, id, !current.done, now)
}

/** 删除清单项；只删本地任务，不触碰 Trip / 约束。 */
export function deleteChecklistItem(checklist: ChecklistV1, id: string): ChecklistMutationResult {
  if (!findItem(checklist, id)) {
    return fail('item_not_found', '要删除的清单项不存在；原清单保持不变。', '$.items')
  }
  return finish(copyChecklist(checklist.items.filter((item) => item.id !== id), checklist.appliedTemplates))
}

/* ───────── 关联 / 解除关联 / 失效标记 ───────── */

/** 显式关联到行程里的 stop；关联成功后清除历史 originalStopId。 */
export function linkChecklistItemToStop(
  checklist: ChecklistV1,
  id: string,
  link: ChecklistStopLink,
  now: number,
): ChecklistMutationResult {
  const current = findItem(checklist, id)
  if (!current) return fail('item_not_found', '要关联的清单项不存在；原清单保持不变。', '$.items')
  const stopId = normalizeNullableText(link.stopId)
  if (stopId === null) return fail('invalid_input', '关联地点不能为空。', '$.stopId')
  const nextItem: ChecklistItemV1 = {
    ...current,
    stopId,
    originalStopId: null,
    day: link.day === undefined ? current.day : link.day,
    updatedAt: now,
  }
  return finish(
    copyChecklist(
      checklist.items.map((item) => (item.id === id ? nextItem : item)),
      checklist.appliedTemplates,
    ),
  )
}

/**
 * 显式解除地点关联：任务保留，`stopId` 置空、原 id 进 `originalStopId`，
 * notes 追加「需重新关联」。不做静默删除。
 */
export function unlinkChecklistItem(checklist: ChecklistV1, id: string, now: number): ChecklistMutationResult {
  const current = findItem(checklist, id)
  if (!current) return fail('item_not_found', '要解除关联的清单项不存在；原清单保持不变。', '$.items')
  if (current.stopId === null && current.originalStopId === null) return finish(copyChecklist(checklist.items, checklist.appliedTemplates))
  const nextItem: ChecklistItemV1 = {
    ...current,
    stopId: null,
    originalStopId: current.originalStopId ?? current.stopId,
    notes: appendNote(current.notes, CHECKLIST_RELINK_NOTES.stop_unlinked),
    updatedAt: now,
  }
  return finish(
    copyChecklist(
      checklist.items.map((item) => (item.id === id ? nextItem : item)),
      checklist.appliedTemplates,
    ),
  )
}

/**
 * 显式关联到 F2 约束：写入真实 `constraintId`，同时保留日期 / 天 / stop 锚点
 * 供展示与旧数据兼容；锚点不能替代 ID。不改约束、不修改 Trip。
 */
export function linkChecklistItemToConstraint(
  checklist: ChecklistV1,
  id: string,
  constraint: ConstraintItemV1,
  now: number,
): ChecklistMutationResult {
  const current = findItem(checklist, id)
  if (!current) return fail('item_not_found', '要关联的清单项不存在；原清单保持不变。', '$.items')
  const nextItem: ChecklistItemV1 = {
    ...current,
    constraintId: constraint.id,
    day: constraint.day ?? current.day,
    date: constraint.startDate ?? current.date,
    stopId: constraint.stopId ?? current.stopId,
    originalStopId: constraint.stopId === null ? current.originalStopId : null,
    updatedAt: now,
  }
  return finish(
    copyChecklist(
      checklist.items.map((item) => (item.id === id ? nextItem : item)),
      checklist.appliedTemplates,
    ),
  )
}

/**
 * 显式解除预约关联：只把 `constraintId` 写为 `null`；日期 / 天 / stop / notes
 * 与 done 全部保留，绝不把解除预约变成解除地点。旧缺省 undefined 不补 null。
 */
export function unlinkChecklistItemFromConstraint(
  checklist: ChecklistV1,
  id: string,
  now: number,
): ChecklistMutationResult {
  const current = findItem(checklist, id)
  if (!current) return fail('item_not_found', '要解除预约关联的清单项不存在；原清单保持不变。', '$.items')
  if (current.constraintId === undefined || current.constraintId === null) {
    return finish(copyChecklist(checklist.items, checklist.appliedTemplates))
  }
  const nextItem: ChecklistItemV1 = { ...current, constraintId: null, updatedAt: now }
  return finish(
    copyChecklist(
      checklist.items.map((item) => (item.id === id ? nextItem : item)),
      checklist.appliedTemplates,
    ),
  )
}

/**
 * 用户显式确认后标记「需重新关联」：
 * - stop 已删 / 已解绑 → stopId 置空，原 id 保留在 originalStopId；
 * - 约束已删 / 已变更 → 保留 `constraintId`（dangling 也保留）与日期 / 天 / stop，
 *   只追加复核提示；任务与 done 都不丢，不自动绑定别的约束。
 */
export function markChecklistItemNeedsRelink(
  checklist: ChecklistV1,
  id: string,
  reason: ChecklistRelinkReason,
  now: number,
): ChecklistMutationResult {
  const current = findItem(checklist, id)
  if (!current) return fail('item_not_found', '要标记的清单项不存在；原清单保持不变。', '$.items')
  const isConstraintReason = reason === 'constraint_deleted' || reason === 'constraint_changed'
  const nextItem: ChecklistItemV1 = isConstraintReason
    ? {
        ...current,
        notes: appendNote(current.notes, CHECKLIST_RELINK_NOTES[reason]),
        updatedAt: now,
      }
    : {
        ...current,
        stopId: null,
        originalStopId: current.originalStopId ?? current.stopId,
        notes: appendNote(current.notes, CHECKLIST_RELINK_NOTES[reason]),
        updatedAt: now,
      }
  return finish(
    copyChecklist(
      checklist.items.map((item) => (item.id === id ? nextItem : item)),
      checklist.appliedTemplates,
    ),
  )
}

export function checklistItemNeedsRelink(item: ChecklistItemV1): boolean {
  if (item.stopId === null && item.originalStopId !== null) return true
  if (item.notes === null) return false
  return Object.values(CHECKLIST_RELINK_NOTES).some((note) => item.notes?.includes(note) === true)
}

/* ───────── 关联审计（纯函数，不写任何状态） ───────── */

export interface ChecklistStopRef {
  stopId: string
  day: number
  name: string
}

export function collectChecklistStops(trip: Trip | null | undefined): ChecklistStopRef[] {
  if (!trip) return []
  const result: ChecklistStopRef[] = []
  for (const day of trip.days) {
    for (const stop of day.stops) {
      result.push({ stopId: stop.id, day: day.day, name: stop.name })
    }
  }
  return result
}

export interface ChecklistRelinkIssue {
  itemId: string
  reason: ChecklistRelinkReason
  /** 失效的 stop id / constraint id；仅作展示与追溯，不写回条目。 */
  refId: string | null
  message: string
}

export interface ChecklistAudit {
  issues: ChecklistRelinkIssue[]
  itemsNeedingRelink: string[]
  /**
   * 旧 v1 没有 `constraintId` 属性的条目。它们只是「未记录预约关联」，
   * 不是已关联 / 已删除预约的任务；仅用于提示，不做启发式绑定。
   */
  unrecordedConstraintItems: string[]
}

export interface ChecklistAuditOptions {
  trip?: Trip | null
  /** 当前约束（可为空）。为空 / 缺省时不判断约束 dangling，避免误报。 */
  constraints?: ConstraintsV1 | null
  /**
   * 上一次已应用的约束快照。只用于已知 ID 的标题提示与「同 ID 字段变更」检测；
   * 绝不把旧记录 / 启发式锚点变成关联事实，也不制造旧数据关联。
   */
  previousConstraints?: ConstraintsV1 | null
}

function constraintAnchorsDiffer(a: ConstraintItemV1, b: ConstraintItemV1): boolean {
  return a.day !== b.day || a.startDate !== b.startDate || a.stopId !== b.stopId
}

/**
 * 只按真实 `constraintId === ConstraintItemV1.id` 判定关联；不做同名 /
 * 同 date/day/stop 的启发式匹配。旧缺省 undefined 永远不视为已关联。
 */
export function constraintMatchesChecklistItem(
  item: ChecklistItemV1,
  constraint: ConstraintItemV1,
): boolean {
  return item.constraintId === constraint.id
}

/** F2 删除 / 变更约束时的精确影响面：只返回真正记录该 ID 的条目。 */
export function planConstraintRemovalImpact(
  checklist: ChecklistV1,
  removedConstraint: ConstraintItemV1,
): ChecklistItemV1[] {
  return checklist.items.filter((item) => item.constraintId === removedConstraint.id)
}

export function auditChecklistLinks(
  checklist: ChecklistV1,
  options: ChecklistAuditOptions = {},
): ChecklistAudit {
  const issues: ChecklistRelinkIssue[] = []
  const unrecordedConstraintItems: string[] = []
  const seen = new Set<string>()
  const push = (issue: ChecklistRelinkIssue) => {
    const key = `${issue.itemId}|${issue.reason}|${issue.refId ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push(issue)
  }

  if (options.trip) {
    const knownStops = new Set(collectChecklistStops(options.trip).map((stop) => stop.stopId))
    for (const item of checklist.items) {
      if (item.stopId !== null && !knownStops.has(item.stopId)) {
        push({
          itemId: item.id,
          reason: 'stop_deleted',
          refId: item.stopId,
          message: `「${item.title}」关联的地点已不在当前行程中；任务保留，可标记为需重新关联。`,
        })
      } else if (item.stopId === null && item.originalStopId !== null) {
        push({
          itemId: item.id,
          reason: 'stop_unlinked',
          refId: item.originalStopId,
          message: `「${item.title}」已解除地点关联；任务保留，可重新关联到当前行程地点。`,
        })
      }
    }
  }

  if (options.constraints) {
    const currentById = new Map(options.constraints.items.map((constraint) => [constraint.id, constraint]))
    const previousById = new Map(
      (options.previousConstraints?.items ?? []).map((constraint) => [constraint.id, constraint]),
    )
    for (const item of checklist.items) {
      const state = checklistItemConstraintState(item)
      if (state === 'unrecorded') {
        unrecordedConstraintItems.push(item.id)
        continue
      }
      if (state === 'unlinked') continue
      const constraintId = item.constraintId as string
      const current = currentById.get(constraintId)
      if (!current) {
        const previousTitle = previousById.get(constraintId)?.title ?? null
        push({
          itemId: item.id,
          reason: 'constraint_deleted',
          refId: constraintId,
          message: `「${item.title}」关联的预约${previousTitle ? `「${previousTitle}」` : ''}已不在当前约束中；任务保留，原关联 ID 保留，需重新确认关联。`,
        })
        continue
      }
      const previous = previousById.get(constraintId)
      const changed = previous !== undefined && constraintAnchorsDiffer(previous, current)
      if (changed) {
        push({
          itemId: item.id,
          reason: 'constraint_changed',
          refId: constraintId,
          message: `「${item.title}」关联的预约「${current.title}」已变更；任务保留，请复核日期 / 地点。`,
        })
      }
    }
  } else {
    for (const item of checklist.items) {
      if (checklistItemConstraintState(item) === 'unrecorded') unrecordedConstraintItems.push(item.id)
    }
  }

  return {
    issues,
    itemsNeedingRelink: [...new Set(issues.map((issue) => issue.itemId))],
    unrecordedConstraintItems,
  }
}

/* ───────── 模板（只建议，必须显式采纳） ───────── */

export interface ChecklistTemplateSuggestion {
  id: string
  category: ChecklistCategoryV1
  title: string
  notes: string | null
}

export interface ChecklistTemplate {
  id: string
  title: string
  description: string
  suggestions: readonly ChecklistTemplateSuggestion[]
}

export const CHECKLIST_TEMPLATES: readonly ChecklistTemplate[] = [
  {
    id: 'flight',
    title: '机票与乘机准备',
    description: '只生成未准备的核对建议，不查询出票或库存。',
    suggestions: [
      { id: 'flight-order', category: 'ticket', title: '核对机票订单与乘机人姓名', notes: '以你收到的订单为准，这里只记录本地核对。' },
      { id: 'flight-checkin', category: 'todo', title: '确认在线值机开放时间', notes: '以航空公司通知为准。' },
      { id: 'flight-document', category: 'document', title: '准备乘机所需证件', notes: null },
    ],
  },
  {
    id: 'train',
    title: '火车票与进站准备',
    description: '只生成未准备的核对建议。',
    suggestions: [
      { id: 'train-order', category: 'ticket', title: '核对车次、日期与席别', notes: '以你收到的订单为准。' },
      { id: 'train-station', category: 'todo', title: '确认出发车站与进站口', notes: null },
      { id: 'train-document', category: 'document', title: '准备取票 / 进站所需证件', notes: null },
    ],
  },
  {
    id: 'hotel',
    title: '住宿订单核对',
    description: '只生成未准备的核对建议，不查询库存。',
    suggestions: [
      { id: 'hotel-order', category: 'appointment', title: '核对住宿订单与入住 / 退房日期', notes: '以你收到的订单为准。' },
      { id: 'hotel-address', category: 'todo', title: '保存住宿地址与前台联系方式', notes: null },
    ],
  },
  {
    id: 'documents',
    title: '证件与随身材料',
    description: '只生成未准备的核对建议。',
    suggestions: [
      { id: 'doc-validity', category: 'document', title: '检查身份证 / 护照有效期', notes: null },
      { id: 'doc-visa', category: 'document', title: '准备签证 / 入境材料（如需要）', notes: null },
      { id: 'doc-backup', category: 'todo', title: '把证件照片备份到离线位置', notes: '不要把证件照片发到不可信的在线服务。' },
    ],
  },
  {
    id: 'power',
    title: '充电与电子设备',
    description: '只生成未准备的核对建议。',
    suggestions: [
      { id: 'power-phone', category: 'luggage', title: '手机与充电器', notes: null },
      { id: 'power-bank', category: 'luggage', title: '充电宝（按承运要求随身携带）', notes: null },
      { id: 'power-adapter', category: 'luggage', title: '转换插头（如目的地需要）', notes: null },
    ],
  },
  {
    id: 'medicine',
    title: '常用药与基础药品',
    description: '只生成未准备的核对建议，不提供医疗建议。',
    suggestions: [
      { id: 'med-personal', category: 'luggage', title: '个人常用药与处方（如有）', notes: null },
      { id: 'med-basic', category: 'luggage', title: '创可贴、肠胃药等基础药品', notes: null },
    ],
  },
  {
    id: 'rain',
    title: '雨具与防水',
    description: '只生成未准备的核对建议。',
    suggestions: [
      { id: 'rain-umbrella', category: 'luggage', title: '折叠伞或雨衣', notes: null },
      { id: 'rain-bag', category: 'luggage', title: '防水袋（保护证件与电子设备）', notes: null },
    ],
  },
  {
    id: 'appointment',
    title: '预约时间核对',
    description: '只生成未准备的核对建议，不查询预约库存。',
    suggestions: [
      { id: 'appointment-time', category: 'appointment', title: '核对已填写的预约日期与时间', notes: '以你填写的记录为准。' },
      { id: 'appointment-voucher', category: 'todo', title: '把预约凭证保存到离线位置', notes: null },
    ],
  },
]

export interface ChecklistTemplateSuggestionView extends ChecklistTemplateSuggestion {
  templateId: string
  /** 该模板是否已经采纳过（仅用于提示，不阻止再次显式添加）。 */
  templateApplied: boolean
}

export function findChecklistTemplate(templateId: string): ChecklistTemplate | null {
  return CHECKLIST_TEMPLATES.find((template) => template.id === templateId) ?? null
}

export function listChecklistTemplateSuggestions(
  templateId: string,
  checklist?: ChecklistV1 | null,
): ChecklistTemplateSuggestionView[] {
  const template = findChecklistTemplate(templateId)
  if (!template) return []
  const applied = checklist?.appliedTemplates.includes(template.id) === true
  return template.suggestions.map((suggestion) => ({
    ...suggestion,
    templateId: template.id,
    templateApplied: applied,
  }))
}

export interface ChecklistTemplateApplyOptions {
  selectedSuggestionIds: readonly string[]
  now: number
  /** 调用方提供新 id；纯函数不做随机。 */
  idFactory: () => string
}

/**
 * 采纳模板建议：只添加显式选中的建议，全部 `done:false`，并记录模板 id。
 * 未选中任何建议 → 失败，items 不变；模板本身绝不自动写入。
 */
export function applyChecklistTemplate(
  checklist: ChecklistV1,
  templateId: string,
  options: ChecklistTemplateApplyOptions,
): ChecklistMutationResult {
  const template = findChecklistTemplate(templateId)
  if (!template) return fail('template_unknown', '模板不存在；原清单保持不变。', '$.templateId')
  const selected = new Set(options.selectedSuggestionIds)
  if (selected.size === 0) return fail('no_selection', '请先选择要添加的模板建议；清单未改变。', '$.selectedSuggestionIds')
  const suggestions = template.suggestions.filter((suggestion) => selected.has(suggestion.id))
  if (suggestions.length !== selected.size) {
    return fail('suggestion_unknown', '所选模板建议不存在；原清单保持不变。', '$.selectedSuggestionIds')
  }
  if (checklist.items.length + suggestions.length > MAX_CHECKLIST_ITEMS) {
    return fail(
      'limit_exceeded',
      `清单最多 ${MAX_CHECKLIST_ITEMS} 项；本次会超出，未写入，不截断。`,
      '$.items',
    )
  }
  const newItems: ChecklistItemV1[] = suggestions.map((suggestion) => ({
    id: options.idFactory(),
    category: suggestion.category,
    title: suggestion.title,
    done: false,
    date: null,
    day: null,
    stopId: null,
    originalStopId: null,
    notes: suggestion.notes,
    updatedAt: options.now,
  }))
  const appliedTemplates = checklist.appliedTemplates.includes(template.id)
    ? [...checklist.appliedTemplates]
    : [...checklist.appliedTemplates, template.id]
  if (appliedTemplates.some((id) => id.length > MAX_TEMPLATE_ID_LENGTH)) {
    return fail('limit_exceeded', '模板 id 超出长度上限；原清单保持不变。', '$.appliedTemplates')
  }
  if (appliedTemplates.length > MAX_APPLIED_TEMPLATES) {
    return fail(
      'limit_exceeded',
      `已采纳模板最多 ${MAX_APPLIED_TEMPLATES} 个；未写入。`,
      '$.appliedTemplates',
    )
  }
  return finish(copyChecklist([...checklist.items, ...newItems], appliedTemplates))
}

/* ───────── F6 消费接口 ───────── */

export interface EffectiveChecklistItemV1 {
  id: string
  category: ChecklistCategoryV1
  title: string
  done: boolean
  /** 固定为「已准备 / 未准备」，供离线页直接展示。 */
  preparedLabel: (typeof CHECKLIST_PREPARED_LABELS)[keyof typeof CHECKLIST_PREPARED_LABELS]
  date: string | null
  day: number | null
  stopId: string | null
  originalStopId: string | null
  /**
   * 原样保留：缺省 = 旧记录未记录；null = 明确未关联；string = 弱引用 ID。
   * F6 可凭 ID 解析当前 constraints；dangling 只提示需重新关联，不宣称预约已确认。
   */
  constraintId?: string | null
  notes: string | null
  updatedAt: number
}

export interface EffectiveChecklistV1 {
  items: readonly EffectiveChecklistItemV1[]
  appliedTemplates: readonly string[]
  summary: {
    total: number
    prepared: number
    pending: number
  }
}

export type EffectiveChecklistResult = { ok: true; value: EffectiveChecklistV1 } | ChecklistFailure

/**
 * F6 / 离线页的唯一清单入口：只接受**当前** checklist，先走公共 validator，
 * 再投影白名单字段并冻结。不读 storage、不包含其它版本 / 恢复 raw / 会话数据。
 */
export function buildEffectiveChecklist(value: unknown): EffectiveChecklistResult {
  const checked = validateChecklist(value)
  if (!checked.ok) return fromValidation(checked)
  const items: EffectiveChecklistItemV1[] = checked.value.items.map((item) => ({
    id: item.id,
    category: item.category,
    title: item.title,
    done: item.done,
    preparedLabel: item.done ? CHECKLIST_PREPARED_LABELS.done : CHECKLIST_PREPARED_LABELS.pending,
    date: item.date,
    day: item.day,
    stopId: item.stopId,
    originalStopId: item.originalStopId,
    ...(Object.hasOwn(item, 'constraintId') ? { constraintId: item.constraintId ?? null } : {}),
    notes: item.notes,
    updatedAt: item.updatedAt,
  }))
  const prepared = items.filter((item) => item.done).length
  const effective: EffectiveChecklistV1 = {
    items: Object.freeze(items.map((item) => Object.freeze(item))),
    appliedTemplates: Object.freeze([...checked.value.appliedTemplates]),
    summary: Object.freeze({ total: items.length, prepared, pending: items.length - prepared }),
  }
  return { ok: true, value: Object.freeze(effective) }
}

export function checklistSummary(checklist: ChecklistV1): { total: number; prepared: number; pending: number } {
  const prepared = checklist.items.filter((item) => item.done).length
  return { total: checklist.items.length, prepared, pending: checklist.items.length - prepared }
}

/** 面板 / 边界测试用的上限常量转出（实际门禁仍在 validator）。 */
export const CHECKLIST_FIELD_LIMITS = {
  title: MAX_CHECKLIST_TITLE_LENGTH,
  notes: MAX_CHECKLIST_NOTES_LENGTH,
  items: MAX_CHECKLIST_ITEMS,
  appliedTemplates: MAX_APPLIED_TEMPLATES,
  templateId: MAX_TEMPLATE_ID_LENGTH,
  day: MAX_ANCHOR_DAY,
  constraintId: MAX_WORKSPACE_ID_LENGTH,
} as const

/**
 * F3 候选地点池：纯函数、不可变更新、不读写任何存储。
 *
 * 边界（与 docs/CANDIDATE_POOL.md、docs/WORKSPACE_SIDECAR.md 对齐）：
 * - 候选库是一条独立记录（`CandidatesRecordV1`），键由存储 owner 使用
 *   `CANDIDATES_STORAGE_KEY`；本模块不定义新键、不读 localStorage、不写 Trip。
 * - 所有写入先走公共 `validateCandidateItem` / `validateCandidatesRecord`，
 *   未知字段严格拒绝；容量用 `MAX_CANDIDATES_COUNT` / `MAX_CANDIDATES_BYTES`
 *   与紧凑 JSON 的真实 UTF-8 字节，不按字符数估算。
 * - 更新全部返回新对象；失败返回 failure，旧记录、旧条目与旧字节都不变。
 * - 候选 source 只有 `manual` / `copied`，界面必须标「未核实」；不 geocode，
 *   坐标 null 表示未知，`0` 是合法真实坐标。
 * - 去重只做提示：`dedupeKey` 命中时返回两条供用户判断，不自动合并 / 覆盖。
 * - 加入某日只生成草稿 / 预览 proposal：新 visit id 由调用方提供且不得复用
 *   候选 id；会走既有 `tripDraft.addDraftStop` 的每日 100 站限制，并用
 *   `applyDraft`（内含 `checkTripShape`）验证预览；绝不直接改当前 Trip。
 * - 备份 / 导入只提供纯 envelope 构造、校验与预览；文件读写、raw 冻结与
 *   持久保存属于存储 owner。
 */

import type { Trip, TripStop } from './api'
import type {
  CandidateItemV1,
  CandidatesBackupV1,
  CandidatesRecordV1,
  GeoPointV1,
} from './workspace'
import {
  BACKUP_VERSION,
  CANDIDATES_BACKUP_FORMAT,
  CANDIDATES_FORMAT,
  CANDIDATES_VERSION,
  MAX_CANDIDATES_BACKUP_FILE_BYTES,
  MAX_CANDIDATES_BYTES,
  MAX_CANDIDATES_COUNT,
  MAX_CANDIDATE_ADDRESS_LENGTH,
  MAX_CANDIDATE_NAME_LENGTH,
  MAX_CANDIDATE_NOTES_LENGTH,
  MAX_CANDIDATE_PRIORITY,
  MAX_CANDIDATE_TAGS,
  MAX_CANDIDATE_TAG_LENGTH,
  MAX_SAFE_WORKSPACE_REVISION,
  createCandidatesRecord,
  measureCandidatesRecordBytes,
  validateCandidateItem,
  validateCandidatesBackup,
  validateCandidatesRecord,
} from './workspace'
import type { WorkspaceValidationFailure } from './workspace'
import type { DraftFailure, DraftLocalCheck, NewDraftStop, TripDraft } from './tripDraft'
import {
  MAX_DRAFT_STOPS_PER_DAY,
  MAX_STOP_DURATION_MINUTES,
  MAX_STOP_ID_LENGTH,
  STOP_TIME_PATTERN,
  addDraftStop,
  applyDraft,
} from './tripDraft'
import { checkTripShape, savedTripRecordBytes, utf8ByteLength } from './savedTrips'

export type CandidatePoolFailureReason =
  | 'invalid_candidate'
  | 'invalid_record'
  | 'invalid_id'
  | 'invalid_name'
  | 'invalid_address'
  | 'invalid_notes'
  | 'invalid_tags'
  | 'invalid_priority'
  | 'invalid_location'
  | 'invalid_timestamp'
  | 'duplicate_candidate_id'
  | 'candidate_not_found'
  | 'candidates_count'
  | 'candidates_too_large'
  | 'invalid_backup'
  | 'invalid_json'
  | 'backup_too_large'
  | 'invalid_draft'
  | 'unknown_day'
  | 'daily_stop_limit'
  | 'invalid_time'
  | 'invalid_duration'
  | 'invalid_visit_id'
  | 'visit_id_conflict'
  | 'candidate_id_as_visit'
  | 'draft_failed'
  | 'trip_shape'
  | 'preview_failed'

export interface CandidatePoolFailure {
  ok: false
  reason: CandidatePoolFailureReason
  message: string
}

export type CandidatePoolResult<T> = { ok: true; value: T } | CandidatePoolFailure

export interface CandidateMutation {
  /** 新记录；失败时不会返回这个对象。 */
  record: CandidatesRecordV1
  /** false = 无实际变化，record 是原记录。 */
  changed: boolean
  /** 与本次写入同 name/address 的其它候选；只作提示，不自动合并。 */
  duplicates: CandidateItemV1[]
}

export interface CandidateRecordSummary {
  count: number
  bytes: number | null
  maxCount: number
  maxBytes: number
  tags: string[]
}

export interface CandidateBackupExport {
  backup: CandidatesBackupV1
  /** 与 envelope 完全一致的紧凑 JSON；预览 / 下载应使用同一份字节。 */
  json: string
  bytes: number
  itemCount: number
}

export interface CandidateImportPreview {
  backup: CandidatesBackupV1
  /** 已通过公共 validator 的候选记录；调用方仍需显式持久保存。 */
  record: CandidatesRecordV1
  itemCount: number
  exportedAt: number
  bytes: number
}

/** 父级提供的、可复制为候选的行程站点视图；面板不直接读 Trip。 */
export interface CandidateStopSource {
  stopId: string
  name: string
  address: string | null
  location: GeoPointV1 | null
  day: number | null
}

export interface CandidateManualInput {
  id: string
  name: string
  address?: string | null
  notes?: string | null
  tags?: readonly string[]
  priority?: number
  location?: GeoPointV1 | null
}

export interface CandidateCopyInput {
  id: string
  stop: CandidateStopSource
  notes?: string | null
  tags?: readonly string[]
  priority?: number
}

export interface CandidateUpdatePatch {
  name?: string
  address?: string | null
  notes?: string | null
  tags?: readonly string[]
  priority?: number
  location?: GeoPointV1 | null
}

export interface CandidateFilter {
  /** 名称 / 地址 / 备注 / 标签的归一化子串匹配。 */
  text?: string
  /** 精确区域标签；空字符串 / null 表示全部。 */
  tag?: string | null
  /** true 时只显示没有标签的候选；优先于 tag。 */
  untaggedOnly?: boolean
}

export interface CandidateDraftProposalInput {
  draft: TripDraft
  candidate: CandidateItemV1
  day: number
  /** 新站点开始时刻，必须由用户显式填写；不猜默认值。 */
  time: string
  durationMinutes?: number | null
  /** 新 occurrence id；必须由调用方新生成，且不得等于候选 id。 */
  visitStopId: string
}

export interface CandidateDraftProposal {
  previewOnly: true
  candidateId: string
  candidateUpdatedAt: number
  candidateName: string
  candidateLocation: GeoPointV1 | null
  day: number
  time: string
  visitStopId: string
  /** 新草稿（只含这次加入）；父级确认后才可替换自己的草稿。 */
  draft: TripDraft
  /** 由 applyDraft 生成的只读预览 Trip；绝不是当前 Trip / 已保存 Trip。 */
  previewTrip: Trip
  previewTripBytes: number
  /** 新加入的站点（属于 draft，不是当前 Trip）。 */
  stop: TripStop
  changedDays: number[]
  localChecks: DraftLocalCheck[]
  notices: string[]
  caveats: string[]
  /** 明确标记已跑过 checkTripShape（由 applyDraft 内部 + 本模块复核）。 */
  shapeChecked: true
  baseTripId: string
  forkTripId: string
  draftRevision: number
}

function fail(reason: CandidatePoolFailureReason, message: string): CandidatePoolFailure {
  return { ok: false, reason, message }
}

function fromValidation(
  failure: WorkspaceValidationFailure,
  reason: CandidatePoolFailureReason,
): CandidatePoolFailure {
  return fail(reason, `${failure.path}: ${failure.message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_SAFE_WORKSPACE_REVISION
  )
}

function checkTimestamp(value: unknown, label: string): CandidatePoolResult<number> {
  if (!isTimestamp(value)) {
    return fail('invalid_timestamp', `${label}必须是正整数安全整数时间戳。`)
  }
  return { ok: true, value }
}

function trimmedText(value: unknown, max: number, label: string): CandidatePoolResult<string> {
  if (typeof value !== 'string') return fail('invalid_name', `${label}必须是文本。`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return fail('invalid_name', `${label}不能为空。`)
  if (trimmed.length > max) return fail('invalid_name', `${label}最多 ${max} 个字符。`)
  return { ok: true, value: trimmed }
}

function optionalTrimmedText(
  value: unknown,
  max: number,
  reason: CandidatePoolFailureReason,
  label: string,
): CandidatePoolResult<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return fail(reason, `${label}必须是文本或 null。`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: true, value: null }
  if (trimmed.length > max) return fail(reason, `${label}最多 ${max} 个字符。`)
  return { ok: true, value: trimmed }
}

function normalizeTags(tags: unknown): CandidatePoolResult<string[]> {
  if (tags === undefined) return { ok: true, value: [] }
  if (!Array.isArray(tags)) return fail('invalid_tags', '区域标签必须是数组。')
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    if (typeof raw !== 'string') return fail('invalid_tags', '区域标签必须是文本。')
    const tag = raw.trim()
    if (tag.length === 0) return fail('invalid_tags', '区域标签不能是空白。')
    if (tag.length > MAX_CANDIDATE_TAG_LENGTH) {
      return fail('invalid_tags', `单个区域标签最多 ${MAX_CANDIDATE_TAG_LENGTH} 个字符。`)
    }
    if (seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  if (result.length > MAX_CANDIDATE_TAGS) {
    return fail('invalid_tags', `区域标签最多 ${MAX_CANDIDATE_TAGS} 个。`)
  }
  return { ok: true, value: result }
}

function normalizePriority(value: unknown): CandidatePoolResult<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return fail('invalid_priority', '优先级必须是 0–3 的整数。')
  }
  if (value < 0 || value > MAX_CANDIDATE_PRIORITY) {
    return fail('invalid_priority', `优先级必须在 0–${MAX_CANDIDATE_PRIORITY} 之间。`)
  }
  return { ok: true, value }
}

function normalizeLocation(value: unknown): CandidatePoolResult<GeoPointV1 | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (!isRecord(value)) return fail('invalid_location', '坐标必须是 {lng, lat} 对象或 null。')
  const lng = value.lng
  const lat = value.lat
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return fail('invalid_location', '经度必须是 -180–180 的有限数字。')
  }
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return fail('invalid_location', '纬度必须是 -90–90 的有限数字。')
  }
  // 0 是合法真实坐标；只有 null 表示未知。
  return { ok: true, value: { lng, lat } }
}

function cloneLocation(location: GeoPointV1 | null): GeoPointV1 | null {
  return location === null ? null : { lng: location.lng, lat: location.lat }
}

function cloneCandidate(item: CandidateItemV1): CandidateItemV1 {
  return {
    ...item,
    tags: [...item.tags],
    location: cloneLocation(item.location),
  }
}

function candidateContentEqual(a: CandidateItemV1, b: CandidateItemV1): boolean {
  return (
    a.name === b.name &&
    a.address === b.address &&
    a.notes === b.notes &&
    a.priority === b.priority &&
    a.source === b.source &&
    a.copiedFromStopId === b.copiedFromStopId &&
    a.location?.lng === b.location?.lng &&
    a.location?.lat === b.location?.lat &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  )
}

/** 去空白、大小写折叠、全角 / 半角归一；只用于重复提示与筛选。 */
export function normalizeCandidateText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 去重提示键；空地址与 null 地址等价。 */
export function candidateDedupeKey(
  candidate: Pick<CandidateItemV1, 'name' | 'address'>,
): string {
  return `${normalizeCandidateText(candidate.name)}|${normalizeCandidateText(candidate.address ?? '')}`
}

/** 返回与 candidate 同 key 的其它条目；只提示，不合并。 */
export function findDuplicateCandidates(
  items: readonly CandidateItemV1[],
  candidate: Pick<CandidateItemV1, 'id' | 'name' | 'address'>,
  options: { excludeId?: string } = {},
): CandidateItemV1[] {
  const key = candidateDedupeKey(candidate)
  const excludeId = options.excludeId ?? candidate.id
  return items.filter((item) => item.id !== excludeId && candidateDedupeKey(item) === key)
}

function buildCandidateItem(input: {
  id: unknown
  name: unknown
  address: unknown
  notes: unknown
  tags: unknown
  priority: unknown
  location: unknown
  source: 'manual' | 'copied'
  copiedFromStopId: string | null
  now: unknown
}): CandidatePoolResult<CandidateItemV1> {
  const now = checkTimestamp(input.now, '候选时间')
  if (!now.ok) return now
  if (typeof input.id !== 'string' || input.id.trim().length === 0) {
    return fail('invalid_id', '候选 id 必须是调用方提供的非空文本。')
  }
  const name = trimmedText(input.name, MAX_CANDIDATE_NAME_LENGTH, '候选名称')
  if (!name.ok) return name
  const address = optionalTrimmedText(
    input.address,
    MAX_CANDIDATE_ADDRESS_LENGTH,
    'invalid_address',
    '候选地址',
  )
  if (!address.ok) return address
  const notes = optionalTrimmedText(
    input.notes,
    MAX_CANDIDATE_NOTES_LENGTH,
    'invalid_notes',
    '候选备注',
  )
  if (!notes.ok) return notes
  const tags = normalizeTags(input.tags)
  if (!tags.ok) return tags
  const priority = normalizePriority(input.priority)
  if (!priority.ok) return priority
  const location = normalizeLocation(input.location)
  if (!location.ok) return location

  const parsed = validateCandidateItem({
    id: input.id,
    name: name.value,
    address: address.value,
    notes: notes.value,
    tags: tags.value,
    priority: priority.value,
    location: location.value,
    source: input.source,
    copiedFromStopId: input.copiedFromStopId,
    createdAt: now.value,
    updatedAt: now.value,
  })
  if (!parsed.ok) return fromValidation(parsed, 'invalid_candidate')
  return { ok: true, value: parsed.value }
}

/** 手工新增候选；source 固定 manual，copiedFromStopId 固定 null。 */
export function createManualCandidate(
  input: CandidateManualInput,
  now: number,
): CandidatePoolResult<CandidateItemV1> {
  if (!isRecord(input)) return fail('invalid_candidate', '手工候选输入必须是对象。')
  return buildCandidateItem({
    id: input.id,
    name: input.name,
    address: input.address ?? null,
    notes: input.notes ?? null,
    tags: input.tags ?? [],
    priority: input.priority ?? 1,
    location: input.location ?? null,
    source: 'manual',
    copiedFromStopId: null,
    now,
  })
}

/**
 * 从既有 stop 复制候选：名称 / 地址 / 坐标深拷贝；原 stop 坐标为 null 时仍为
 * null，绝不补 (0,0)。复制后与原 stop 完全隔离。
 */
export function copyCandidateFromStop(
  input: CandidateCopyInput,
  now: number,
): CandidatePoolResult<CandidateItemV1> {
  if (!isRecord(input) || !isRecord(input.stop)) {
    return fail('invalid_candidate', '复制候选输入与来源站点必须是对象。')
  }
  const stop = input.stop
  if (typeof stop.stopId !== 'string' || stop.stopId.trim().length === 0) {
    return fail('invalid_id', '来源站点 id 必须是非空文本。')
  }
  const location = normalizeLocation(stop.location)
  if (!location.ok) return location
  return buildCandidateItem({
    id: input.id,
    name: stop.name,
    address: stop.address ?? null,
    notes: input.notes ?? null,
    tags: input.tags ?? [],
    priority: input.priority ?? 1,
    location: location.value,
    source: 'copied',
    copiedFromStopId: stop.stopId,
    now,
  })
}

function commitCandidateRecord(
  items: readonly CandidateItemV1[],
  updatedAt: number,
): CandidatePoolResult<CandidatesRecordV1> {
  if (items.length > MAX_CANDIDATES_COUNT) {
    return fail(
      'candidates_count',
      `候选库最多 ${MAX_CANDIDATES_COUNT} 条（当前 ${items.length} 条）；未写入，未驱逐旧数据。`,
    )
  }
  const created = createCandidatesRecord(items, updatedAt)
  if (created.ok) return { ok: true, value: created.value }
  if (created.reason === 'limit_exceeded') {
    const raw: CandidatesRecordV1 = {
      format: CANDIDATES_FORMAT,
      version: CANDIDATES_VERSION,
      items: [...items],
      updatedAt,
    }
    const bytes = measureCandidatesRecordBytes(raw)
    return fail(
      'candidates_too_large',
      `候选库超过 ${MAX_CANDIDATES_BYTES} 字节的 UTF-8 上限` +
        `${bytes === null ? '' : `（实际 ${bytes} 字节）`}；未写入，未驱逐旧数据。`,
    )
  }
  return fromValidation(created, 'invalid_record')
}

/** 空候选库记录；由父级在确认「可安全新建」时显式调用。 */
export function createEmptyCandidateRecord(now: number): CandidatePoolResult<CandidatesRecordV1> {
  const time = checkTimestamp(now, '候选库更新时间')
  if (!time.ok) return time
  return commitCandidateRecord([], time.value)
}

/** 精确的紧凑 JSON UTF-8 字节数；null = 无法序列化。 */
export function candidateRecordBytes(record: CandidatesRecordV1): number | null {
  return measureCandidatesRecordBytes(record)
}

export function summarizeCandidatesRecord(record: CandidatesRecordV1): CandidateRecordSummary {
  return {
    count: record.items.length,
    bytes: candidateRecordBytes(record),
    maxCount: MAX_CANDIDATES_COUNT,
    maxBytes: MAX_CANDIDATES_BYTES,
    tags: listCandidateTags(record.items),
  }
}

/** 新增一条候选；重复只返回提示，两条都会保留。 */
export function addCandidateToRecord(
  record: CandidatesRecordV1,
  candidate: CandidateItemV1,
  now: number,
): CandidatePoolResult<CandidateMutation> {
  const time = checkTimestamp(now, '候选库更新时间')
  if (!time.ok) return time
  const parsedRecord = validateCandidatesRecord(record)
  if (!parsedRecord.ok) return fromValidation(parsedRecord, 'invalid_record')
  const parsedCandidate = validateCandidateItem(candidate)
  if (!parsedCandidate.ok) return fromValidation(parsedCandidate, 'invalid_candidate')
  if (parsedRecord.value.items.some((item) => item.id === parsedCandidate.value.id)) {
    return fail('duplicate_candidate_id', '候选 id 已存在；没有覆盖原条目。')
  }
  if (parsedRecord.value.items.length >= MAX_CANDIDATES_COUNT) {
    return fail(
      'candidates_count',
      `候选库最多 ${MAX_CANDIDATES_COUNT} 条（当前 ${parsedRecord.value.items.length} 条）；未写入，未驱逐旧数据。`,
    )
  }
  const duplicates = findDuplicateCandidates(parsedRecord.value.items, parsedCandidate.value)
  const nextItems = [...parsedRecord.value.items, cloneCandidate(parsedCandidate.value)]
  const committed = commitCandidateRecord(nextItems, time.value)
  if (!committed.ok) return committed
  return {
    ok: true,
    value: {
      record: committed.value,
      changed: true,
      duplicates: duplicates.map(cloneCandidate),
    },
  }
}

/** 编辑候选；source / copiedFromStopId / createdAt 不变，updatedAt 用 now。 */
export function updateCandidateInRecord(
  record: CandidatesRecordV1,
  candidateId: string,
  patch: CandidateUpdatePatch,
  now: number,
): CandidatePoolResult<CandidateMutation> {
  const time = checkTimestamp(now, '候选更新时间')
  if (!time.ok) return time
  const parsedRecord = validateCandidatesRecord(record)
  if (!parsedRecord.ok) return fromValidation(parsedRecord, 'invalid_record')
  const current = parsedRecord.value.items.find((item) => item.id === candidateId)
  if (!current) return fail('candidate_not_found', '候选库里没有这个条目；没有写入。')
  if (time.value < current.createdAt) {
    return fail('invalid_timestamp', '候选更新时间不能早于创建时间；没有写入。')
  }
  if (!isRecord(patch)) return fail('invalid_candidate', '候选修改内容必须是对象。')

  let name = current.name
  if (patch.name !== undefined) {
    const parsed = trimmedText(patch.name, MAX_CANDIDATE_NAME_LENGTH, '候选名称')
    if (!parsed.ok) return parsed
    name = parsed.value
  }
  let address = current.address
  if (patch.address !== undefined) {
    const parsed = optionalTrimmedText(
      patch.address,
      MAX_CANDIDATE_ADDRESS_LENGTH,
      'invalid_address',
      '候选地址',
    )
    if (!parsed.ok) return parsed
    address = parsed.value
  }
  let notes = current.notes
  if (patch.notes !== undefined) {
    const parsed = optionalTrimmedText(
      patch.notes,
      MAX_CANDIDATE_NOTES_LENGTH,
      'invalid_notes',
      '候选备注',
    )
    if (!parsed.ok) return parsed
    notes = parsed.value
  }
  let tags = current.tags
  if (patch.tags !== undefined) {
    const parsed = normalizeTags(patch.tags)
    if (!parsed.ok) return parsed
    tags = parsed.value
  }
  let priority = current.priority
  if (patch.priority !== undefined) {
    const parsed = normalizePriority(patch.priority)
    if (!parsed.ok) return parsed
    priority = parsed.value
  }
  let location = current.location
  if (patch.location !== undefined) {
    const parsed = normalizeLocation(patch.location)
    if (!parsed.ok) return parsed
    location = parsed.value
  }

  const next: CandidateItemV1 = {
    ...current,
    name,
    address,
    notes,
    tags,
    priority,
    location,
  }
  if (candidateContentEqual(current, next)) {
    return { ok: true, value: { record, changed: false, duplicates: [] } }
  }
  const updated: CandidateItemV1 = { ...next, updatedAt: time.value }
  const parsedUpdated = validateCandidateItem(updated)
  if (!parsedUpdated.ok) return fromValidation(parsedUpdated, 'invalid_candidate')
  const nextItems = parsedRecord.value.items.map((item) =>
    item.id === candidateId ? cloneCandidate(parsedUpdated.value) : item,
  )
  const duplicates = findDuplicateCandidates(nextItems, parsedUpdated.value, {
    excludeId: candidateId,
  })
  const committed = commitCandidateRecord(nextItems, time.value)
  if (!committed.ok) return committed
  return {
    ok: true,
    value: {
      record: committed.value,
      changed: true,
      duplicates: duplicates.map(cloneCandidate),
    },
  }
}

/**
 * 删除候选库条目。候选库与 Trip / applies 天然解耦：本函数只接收候选记录，
 * 不可能改动 Trip 站点或工作区 sidecar。
 */
export function removeCandidateFromRecord(
  record: CandidatesRecordV1,
  candidateId: string,
  now: number,
): CandidatePoolResult<CandidateMutation> {
  const time = checkTimestamp(now, '候选库更新时间')
  if (!time.ok) return time
  const parsedRecord = validateCandidatesRecord(record)
  if (!parsedRecord.ok) return fromValidation(parsedRecord, 'invalid_record')
  if (!parsedRecord.value.items.some((item) => item.id === candidateId)) {
    return fail('candidate_not_found', '候选库里没有这个条目；没有写入。')
  }
  const nextItems = parsedRecord.value.items.filter((item) => item.id !== candidateId)
  const committed = commitCandidateRecord(nextItems, time.value)
  if (!committed.ok) return committed
  return { ok: true, value: { record: committed.value, changed: true, duplicates: [] } }
}

/** 区域标签去重列表，保持首次出现顺序。 */
export function listCandidateTags(items: readonly CandidateItemV1[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    for (const tag of item.tags) {
      if (seen.has(tag)) continue
      seen.add(tag)
      result.push(tag)
    }
  }
  return result
}

/** 只读筛选；原条目对象与顺序不变，不写 currentTrip。 */
export function filterCandidates(
  items: readonly CandidateItemV1[],
  filter: CandidateFilter = {},
): CandidateItemV1[] {
  const text = normalizeCandidateText(filter.text ?? '')
  const tag = filter.tag === null || filter.tag === undefined ? '' : normalizeCandidateText(filter.tag)
  return items.filter((item) => {
    if (filter.untaggedOnly === true) {
      if (item.tags.length > 0) return false
    } else if (tag.length > 0) {
      if (!item.tags.some((candidateTag) => normalizeCandidateText(candidateTag) === tag)) {
        return false
      }
    }
    if (text.length === 0) return true
    const haystack = [
      item.name,
      item.address ?? '',
      item.notes ?? '',
      ...item.tags,
    ].map(normalizeCandidateText)
    return haystack.some((part) => part.includes(text))
  })
}

/**
 * 解析可选经纬度输入。两个都留空 = 坐标未知（null）；
 * 只填一个或超出范围 = typed failure；`0` 是合法值，不当作未知。
 */
export function parseCandidateCoordinates(
  lngText: string,
  latText: string,
): CandidatePoolResult<GeoPointV1 | null> {
  const lngRaw = lngText.trim()
  const latRaw = latText.trim()
  if (lngRaw.length === 0 && latRaw.length === 0) return { ok: true, value: null }
  if (lngRaw.length === 0 || latRaw.length === 0) {
    return fail('invalid_location', '经度与纬度必须同时留空或同时填写；没有写入。')
  }
  const lng = Number(lngRaw)
  const lat = Number(latRaw)
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return fail('invalid_location', '经度必须是 -180–180 的有限数字。')
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return fail('invalid_location', '纬度必须是 -90–90 的有限数字。')
  }
  return { ok: true, value: { lng, lat } }
}

/** 候选坐标的展示文本；null 明确写未知，0 原样写 0。 */
export function formatCandidateLocation(location: GeoPointV1 | null): string {
  if (location === null) return '坐标未知'
  return `经度 ${location.lng}，纬度 ${location.lat}`
}

/**
 * 构造候选库备份 envelope。只生成内存数据与同一份 JSON 字节；
 * 不下载、不写任何存储。文件大小按真实 UTF-8 字节校验。
 */
export function createCandidatesBackup(
  record: CandidatesRecordV1,
  exportedAt: number,
): CandidatePoolResult<CandidateBackupExport> {
  const time = checkTimestamp(exportedAt, '备份导出时间')
  if (!time.ok) return time
  const parsed = validateCandidatesRecord(record)
  if (!parsed.ok) return fromValidation(parsed, 'invalid_record')
  const backup: CandidatesBackupV1 = {
    format: CANDIDATES_BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: time.value,
    candidates: parsed.value,
  }
  const json = JSON.stringify(backup)
  const bytes = utf8ByteLength(json)
  const checked = validateCandidatesBackup(backup, bytes)
  if (!checked.ok) return fromValidation(checked, 'invalid_backup')
  return {
    ok: true,
    value: {
      backup: checked.value,
      json,
      bytes,
      itemCount: checked.value.candidates.items.length,
    },
  }
}

/**
 * 纯导入预览：只校验 envelope / 内部记录 / 文件字节，不写入、不自动恢复。
 * 调用方拿到 preview 后仍须显式确认与持久保存。
 */
export function previewCandidatesBackup(
  value: unknown,
  rawBytes?: number,
): CandidatePoolResult<CandidateImportPreview> {
  const checked = validateCandidatesBackup(value, rawBytes)
  if (!checked.ok) {
    const tooLarge =
      checked.reason === 'limit_exceeded' && checked.message.includes('备份文件')
    return fromValidation(checked, tooLarge ? 'backup_too_large' : 'invalid_backup')
  }
  let bytes = rawBytes
  if (bytes === undefined) {
    try {
      bytes = utf8ByteLength(JSON.stringify(checked.value))
    } catch {
      return fail('invalid_backup', '候选库备份无法序列化；没有导入。')
    }
  }
  return {
    ok: true,
    value: {
      backup: checked.value,
      record: checked.value.candidates,
      itemCount: checked.value.candidates.items.length,
      exportedAt: checked.value.exportedAt,
      bytes,
    },
  }
}

/** 从已经读入的备份 JSON 文本做纯预览；不做文件读取。 */
export function parseCandidatesBackupJson(text: string): CandidatePoolResult<CandidateImportPreview> {
  if (typeof text !== 'string') return fail('invalid_json', '候选库备份必须是 JSON 文本。')
  const bytes = utf8ByteLength(text)
  if (bytes > MAX_CANDIDATES_BACKUP_FILE_BYTES) {
    return fail(
      'backup_too_large',
      `候选库备份文件超过 ${MAX_CANDIDATES_BACKUP_FILE_BYTES} 字节上限（实际 ${bytes} 字节）；未导入，原数据不变。`,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return fail('invalid_json', '候选库备份不是合法 JSON；未导入，原数据不变。')
  }
  return previewCandidatesBackup(value, bytes)
}

function mapDraftFailure(failure: DraftFailure): CandidatePoolFailure {
  switch (failure.reason) {
    case 'unknown_day':
      return fail('unknown_day', failure.message)
    case 'stop_limit':
      return fail('daily_stop_limit', failure.message)
    case 'duplicate_stop_id':
      return fail('visit_id_conflict', failure.message)
    case 'invalid_time':
      return fail('invalid_time', failure.message)
    case 'invalid_duration':
      return fail('invalid_duration', failure.message)
    case 'invalid_stop_id':
      return fail('invalid_visit_id', failure.message)
    case 'invalid_name':
    case 'invalid_address':
    case 'invalid_description':
      return fail('invalid_candidate', failure.message)
    default:
      return fail('draft_failed', failure.message)
  }
}

function visitIdAlreadyUsed(draft: TripDraft, visitStopId: string): boolean {
  return draft.days.some((day) => day.stops.some((stop) => stop.id === visitStopId))
}

/**
 * 生成「把候选加入指定日草稿」的预览 proposal。
 *
 * - 只调用既有 `addDraftStop` 与 `applyDraft`，不写 storage、不写当前 Trip；
 * - 新 visit id 由调用方提供，不得等于候选 id，也不得与草稿内任何 stop 冲突；
 * - 每日 100 站限制与 Trip 结构 / 容量校验先于返回；
 * - 候选坐标保留在候选库：现有草稿新增站点只支持文字与地址，不把坐标写进行程。
 */
export function buildCandidateDraftProposal(
  input: CandidateDraftProposalInput,
): CandidatePoolResult<CandidateDraftProposal> {
  if (!isRecord(input) || !isRecord(input.draft) || !Array.isArray(input.draft.days)) {
    return fail('invalid_draft', '当前没有可用的行程草稿；没有生成预览。')
  }
  const candidate = validateCandidateItem(input.candidate)
  if (!candidate.ok) return fromValidation(candidate, 'invalid_candidate')
  if (!Number.isInteger(input.day) || input.day < 1) {
    return fail('unknown_day', '目标天必须是正整数；没有生成预览。')
  }
  const targetDay = input.draft.days.find((day) => day.day === input.day)
  if (!targetDay) {
    return fail('unknown_day', `当前草稿里没有第 ${input.day} 天；没有生成预览。`)
  }
  if (targetDay.stops.length >= MAX_DRAFT_STOPS_PER_DAY) {
    return fail(
      'daily_stop_limit',
      `第 ${input.day} 天已有 ${targetDay.stops.length} 个站点，达到本地结构上限 ` +
        `${MAX_DRAFT_STOPS_PER_DAY} 个；没有生成预览，也没有删改任何站点。`,
    )
  }
  const time = typeof input.time === 'string' ? input.time.trim() : ''
  if (!STOP_TIME_PATTERN.test(time)) {
    return fail('invalid_time', '加入时间必须是 24 小时制 HH:MM（例如 09:30）；没有生成预览。')
  }
  const durationMinutes = input.durationMinutes ?? null
  if (
    durationMinutes !== null &&
    (!Number.isInteger(durationMinutes) ||
      durationMinutes < 0 ||
      durationMinutes > MAX_STOP_DURATION_MINUTES)
  ) {
    return fail(
      'invalid_duration',
      `停留时长必须是 null 或 0–${MAX_STOP_DURATION_MINUTES} 的整数分钟；没有生成预览。`,
    )
  }
  const visitStopId = typeof input.visitStopId === 'string' ? input.visitStopId.trim() : ''
  if (visitStopId.length === 0 || visitStopId.length > MAX_STOP_ID_LENGTH) {
    return fail(
      'invalid_visit_id',
      `新站点 id 需要是 1–${MAX_STOP_ID_LENGTH} 个字符的非空文本；没有生成预览。`,
    )
  }
  if (visitStopId === candidate.value.id) {
    return fail('candidate_id_as_visit', '新站点 id 不能复用候选 id；没有生成预览。')
  }
  if (visitIdAlreadyUsed(input.draft, visitStopId)) {
    return fail('visit_id_conflict', '新站点 id 与草稿内已有站点冲突；没有生成预览。')
  }

  const newStop: NewDraftStop = {
    id: visitStopId,
    name: candidate.value.name,
    time,
    duration_minutes: durationMinutes,
    description: candidate.value.notes ?? '',
    address: candidate.value.address ?? '',
    // 现有草稿新增站点路径只接受文字，明确不带坐标；不把候选坐标冒充成已核实站点坐标。
    location: null,
  }
  const added = addDraftStop(input.draft, input.day, newStop)
  if (!added.ok) return mapDraftFailure(added)
  if (!added.changed) {
    return fail('preview_failed', '草稿没有发生预期的新增；没有生成预览。')
  }
  const applied = applyDraft(added.draft)
  if (!applied.ok) {
    return fail('trip_shape', `预览没有通过既有限站 / Trip 结构校验：${applied.message}`)
  }
  if (!applied.changed) {
    return fail('preview_failed', '预览没有产生 Trip 变化；没有生成预览。')
  }
  const shape = checkTripShape(applied.trip)
  if (!shape.ok) {
    return fail('trip_shape', `预览没有通过 Trip 结构校验：${shape.message}`)
  }
  const nextDay = added.draft.days.find((day) => day.day === input.day)
  const stop = nextDay?.stops.find((item) => item.id === visitStopId)
  if (!stop) {
    return fail('preview_failed', '预览里找不到新加入的站点；没有生成预览。')
  }
  const candidateLocation = cloneLocation(candidate.value.location)
  const caveats = [
    '这是加入草稿的预览：尚未写入任何行程或本地存储；只有父级显式接收后才会更新草稿。',
    candidateLocation === null
      ? '候选坐标未知；不会补 (0,0)，也不会自动地理编码。'
      : '候选坐标保留在候选库；当前草稿新增站点只支持名称与地址，不会把坐标写入行程站点，也不会地理编码。',
    '确认加入只改父级草稿；真正应用到行程仍需既有的草稿应用流程。',
  ]
  return {
    ok: true,
    value: {
      previewOnly: true,
      candidateId: candidate.value.id,
      candidateUpdatedAt: candidate.value.updatedAt,
      candidateName: candidate.value.name,
      candidateLocation,
      day: input.day,
      time,
      visitStopId,
      draft: added.draft,
      previewTrip: applied.trip,
      previewTripBytes: savedTripRecordBytes(applied.trip),
      stop,
      changedDays: applied.changedDays,
      localChecks: applied.localChecks,
      notices: applied.notices,
      caveats,
      shapeChecked: true,
      baseTripId: input.draft.base.id,
      forkTripId: input.draft.forkTripId,
      draftRevision: input.draft.revision,
    },
  }
}

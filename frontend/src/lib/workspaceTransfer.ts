/**
 * 三个独立备份文件 + 导入预览 / 确认 + 会话 v2 workspace 块的纯 adapter。
 *
 * 边界：
 * - parse / create 不读 localStorage；只有 prepare / confirm 才显式读取当前库。
 * - 工作区备份只含 workspace；候选 / 版本各自独立 envelope，互不打包。
 * - 文件上限按真实 UTF-8 字节计算，包含 envelope wrapper；预览 / 下载共用同一份 text。
 * - 导入必须经过 prepare（冻结 raw / revision / owner / input canonical）与显式 confirm；
 *   取消、重复确认、外部 tab 更新、输入变化都 typed 拒绝，不写半截。
 * - 旧 Trip JSON / 旧保存列表格式不会被误认为 workspace；旧 Trip 导入接口不在这里改。
 * - 会话 v2 只提供可调用的 workspace 块投影 / 重建；不自动恢复、不注册事件、不改 sessionRestore。
 */
import type { Trip } from './api'
import {
  BACKUP_VERSION,
  CANDIDATES_BACKUP_FORMAT,
  MAX_CANDIDATES_BACKUP_FILE_BYTES,
  MAX_VERSIONS_BACKUP_FILE_BYTES,
  MAX_WORKSPACE_BACKUP_FILE_BYTES,
  VERSIONS_BACKUP_FORMAT,
  WORKSPACE_BACKUP_FORMAT,
  WORKSPACE_FORMAT,
  WORKSPACE_VERSION,
  type BudgetSnapshotV1,
  type CandidatesBackupV1,
  type CandidatesRecordV1,
  type VersionsBackupV1,
  type VersionsRecordV1,
  type WorkspaceBackupV1,
  type WorkspaceMetaV1,
  type WorkspaceRecordV1,
  type WorkspaceSidecarV1,
  type WorkspaceValidationFailure,
  type WorkspaceValidationResult,
} from './workspaceTypes'
import {
  createLogicalId,
  nextWorkspaceRevision,
  validateCandidatesBackup,
  validateCandidatesRecord,
  validateVersionsBackup,
  validateVersionsRecord,
  validateWorkspaceBackup,
  validateWorkspaceRecord,
} from './workspace'
import { fingerprintOf } from './workspaceFingerprint'
import { utf8ByteLength } from './savedTrips'
import {
  commitCandidatesImport,
  commitVersionsImport,
  commitWorkspaceImport,
  currentStorageGeneration,
  getWorkspaceLockManager,
  loadCandidatesRecord,
  loadVersionsRecord,
  loadWorkspaceRecord,
  registerImportGenerationView,
  removeImportGenerationView,
  type StorageUndoHandle,
  type WorkspaceLockManager,
  type WorkspaceSaveFailureReason,
  type WorkspaceStorageLike,
} from './workspaceStorage'
import {
  CANDIDATES_STORAGE_KEY,
  VERSIONS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
} from './workspaceTypes'

/* ───────── 通用文件结果 ───────── */

export type BackupFailureReason =
  | 'invalid_options'
  | 'not_text'
  | 'too_large'
  | 'parse_error'
  | 'format_mismatch'
  | 'version_mismatch'
  | 'invalid_structure'

export interface BackupFailure {
  readonly ok: false
  readonly reason: BackupFailureReason
  readonly message: string
}

export interface BackupCreateSuccess<T> {
  readonly ok: true
  readonly backup: T
  readonly text: string
  readonly bytes: number
}

export interface BackupParseSuccess<T> {
  readonly ok: true
  readonly backup: T
  readonly bytes: number
}

export interface BackupParseOptions {
  /** 只能在固定 cap 之内收紧；缺省用公共 cap。 */
  readonly maxBytes?: number
}

function backupFailure(reason: BackupFailureReason, message: string): BackupFailure {
  return { ok: false, reason, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveLimit(limit: number | undefined, cap: number): number | null {
  if (limit === undefined) return cap
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > cap) return null
  return limit
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function toLargeMessage(bytes: number, limit: number, label: string): string {
  return `${label}约 ${bytes} 字节，超过 ${limit} 字节上限；没有读取或写入任何内容。`
}

function readBackupText(
  text: string,
  options: BackupParseOptions,
  cap: number,
  label: string,
): { ok: true; body: string; bytes: number } | BackupFailure {
  if (typeof text !== 'string') {
    return backupFailure('not_text', '文件内容不是文本，无法读取；未写入任何内容。')
  }
  const limit = resolveLimit(options.maxBytes, cap)
  if (limit === null) {
    return backupFailure(
      'invalid_options',
      `体积上限配置非法（必须是 1..${cap} 的整数）；未读取或写入任何内容。`,
    )
  }
  const bytes = utf8ByteLength(text)
  if (bytes > limit) return backupFailure('too_large', toLargeMessage(bytes, limit, label))
  return { ok: true, body: stripLeadingBom(text), bytes }
}

function parseJsonObject(body: string): Record<string, unknown> | null {
  if (body.trim() === '') return null
  try {
    const parsed = JSON.parse(body) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function invalidStructure(path: string, message: string): BackupFailure {
  return backupFailure('invalid_structure', `文件结构不符合当前约定（${path}）：${message}`)
}

function mapValidateFailure(
  result: WorkspaceValidationFailure,
  tooLarge: boolean,
): BackupFailure {
  if (tooLarge && result.reason === 'limit_exceeded') {
    return backupFailure('too_large', result.message)
  }
  return invalidStructure(result.path, result.message)
}

/* ───────── 工作区备份 ───────── */

export function createWorkspaceBackupFile(
  record: WorkspaceRecordV1,
  now: number,
): BackupCreateSuccess<WorkspaceBackupV1> | BackupFailure {
  const checked = validateWorkspaceRecord(record)
  if (!checked.ok) return mapValidateFailure(checked, true)
  const backup: WorkspaceBackupV1 = {
    format: WORKSPACE_BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    workspace: checked.value,
  }
  let text: string
  try {
    text = JSON.stringify(backup)
  } catch {
    return backupFailure('invalid_structure', '工作区备份无法序列化；没有生成文件。')
  }
  if (typeof text !== 'string') {
    return backupFailure('invalid_structure', '工作区备份无法序列化；没有生成文件。')
  }
  const bytes = utf8ByteLength(text)
  const validated = validateWorkspaceBackup(backup, bytes)
  if (!validated.ok) return mapValidateFailure(validated, true)
  return { ok: true, backup: validated.value, text, bytes }
}

export function parseWorkspaceBackupText(
  text: string,
  options: BackupParseOptions = {},
): BackupParseSuccess<WorkspaceBackupV1> | BackupFailure {
  const read = readBackupText(text, options, MAX_WORKSPACE_BACKUP_FILE_BYTES, '工作区备份文件')
  if (!read.ok) return read
  const parsed = parseJsonObject(read.body)
  if (!parsed) return backupFailure('parse_error', '文件内容不是合法 JSON 对象；未导入任何内容。')
  if (parsed.format !== WORKSPACE_BACKUP_FORMAT) {
    return backupFailure('format_mismatch', '这个文件不是本工具的工作区备份（format 不匹配）；未导入任何内容。')
  }
  if (parsed.version !== BACKUP_VERSION) {
    return backupFailure('version_mismatch', '这个工作区备份的版本不受支持；原始内容保留，未导入。')
  }
  const validated = validateWorkspaceBackup(parsed, read.bytes)
  if (!validated.ok) return mapValidateFailure(validated, true)
  return { ok: true, backup: validated.value, bytes: read.bytes }
}

/* ───────── 候选库备份 ───────── */

export function createCandidatesBackupFile(
  record: CandidatesRecordV1,
  now: number,
): BackupCreateSuccess<CandidatesBackupV1> | BackupFailure {
  const checked = validateCandidatesRecord(record)
  if (!checked.ok) return mapValidateFailure(checked, true)
  const backup: CandidatesBackupV1 = {
    format: CANDIDATES_BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    candidates: checked.value,
  }
  let text: string
  try {
    text = JSON.stringify(backup)
  } catch {
    return backupFailure('invalid_structure', '候选库备份无法序列化；没有生成文件。')
  }
  const bytes = utf8ByteLength(text)
  const validated = validateCandidatesBackup(backup, bytes)
  if (!validated.ok) return mapValidateFailure(validated, true)
  return { ok: true, backup: validated.value, text, bytes }
}

export function parseCandidatesBackupText(
  text: string,
  options: BackupParseOptions = {},
): BackupParseSuccess<CandidatesBackupV1> | BackupFailure {
  const read = readBackupText(text, options, MAX_CANDIDATES_BACKUP_FILE_BYTES, '候选库备份文件')
  if (!read.ok) return read
  const parsed = parseJsonObject(read.body)
  if (!parsed) return backupFailure('parse_error', '文件内容不是合法 JSON 对象；未导入任何内容。')
  if (parsed.format !== CANDIDATES_BACKUP_FORMAT) {
    return backupFailure('format_mismatch', '这个文件不是本工具的候选库备份（format 不匹配）；未导入任何内容。')
  }
  if (parsed.version !== BACKUP_VERSION) {
    return backupFailure('version_mismatch', '这个候选库备份的版本不受支持；原始内容保留，未导入。')
  }
  const validated = validateCandidatesBackup(parsed, read.bytes)
  if (!validated.ok) return mapValidateFailure(validated, true)
  return { ok: true, backup: validated.value, bytes: read.bytes }
}

/* ───────── 版本库备份 ───────── */

export function createVersionsBackupFile(
  record: VersionsRecordV1,
  now: number,
): BackupCreateSuccess<VersionsBackupV1> | BackupFailure {
  const checked = validateVersionsRecord(record)
  if (!checked.ok) return mapValidateFailure(checked, true)
  const backup: VersionsBackupV1 = {
    format: VERSIONS_BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    versions: checked.value,
  }
  let text: string
  try {
    text = JSON.stringify(backup)
  } catch {
    return backupFailure('invalid_structure', '版本库备份无法序列化；没有生成文件。')
  }
  const bytes = utf8ByteLength(text)
  const validated = validateVersionsBackup(backup, bytes)
  if (!validated.ok) return mapValidateFailure(validated, true)
  return { ok: true, backup: validated.value, text, bytes }
}

export function parseVersionsBackupText(
  text: string,
  options: BackupParseOptions = {},
): BackupParseSuccess<VersionsBackupV1> | BackupFailure {
  const read = readBackupText(text, options, MAX_VERSIONS_BACKUP_FILE_BYTES, '版本库备份文件')
  if (!read.ok) return read
  const parsed = parseJsonObject(read.body)
  if (!parsed) return backupFailure('parse_error', '文件内容不是合法 JSON 对象；未导入任何内容。')
  if (parsed.format !== VERSIONS_BACKUP_FORMAT) {
    return backupFailure('format_mismatch', '这个文件不是本工具的版本库备份（format 不匹配）；未导入任何内容。')
  }
  if (parsed.version !== BACKUP_VERSION) {
    return backupFailure('version_mismatch', '这个版本库备份的版本不受支持；原始内容保留，未导入。')
  }
  const validated = validateVersionsBackup(parsed, read.bytes)
  if (!validated.ok) return mapValidateFailure(validated, true)
  return { ok: true, backup: validated.value, bytes: read.bytes }
}

/* ───────── 导入预览 / 确认（内存冻结，不写直到 confirm） ───────── */

export type ImportPrepareFailureReason =
  | BackupFailureReason
  | 'unavailable'
  | 'source_store_blocked'
  | 'invalid'
  | 'too_large'

export type ImportPrepareFailure = {
  readonly ok: false
  readonly reason: ImportPrepareFailureReason
  readonly message: string
}

export interface PreparedImportBase {
  readonly ok: true
  readonly importId: string
  readonly fileBytes: number
  readonly previousRaw: string | null
  readonly previousStatus: 'ok' | 'empty'
  readonly writeReady: boolean
}

export interface PreparedWorkspaceImport extends PreparedImportBase {
  readonly kind: 'workspace'
  readonly importedRecord: WorkspaceRecordV1
  readonly previousRevision: number | null
  readonly previousOwnerId: string | null
  readonly previousWorkspaceId: string | null
  readonly previousTripId: string | null
  readonly nextRevision: number
}

export interface PreparedCandidatesImport extends PreparedImportBase {
  readonly kind: 'candidates'
  readonly importedRecord: CandidatesRecordV1
}

export interface PreparedVersionsImport extends PreparedImportBase {
  readonly kind: 'versions'
  readonly importedRecord: VersionsRecordV1
}

type PendingKind = 'workspace' | 'candidates' | 'versions'

interface PendingImportState {
  kind: PendingKind
  imported: unknown
  canonical: string
  previousRaw: string | null
  previousStatus: 'ok' | 'empty'
  previousRevision: number | null
  previousOwnerId: string | null
  previousWorkspaceId: string | null
  previousTripId: string | null
  nextRevision: number | null
  fileBytes: number
  /** prepare 时该库的写代际；confirm 前必须仍一致（同页 ABA 防护）。 */
  generation: number
  status: 'prepared' | 'confirming' | 'confirmed' | 'canceled' | 'superseded'
}

const pendingImports = new Map<string, PendingImportState>()

const INPUT_CHANGED_MESSAGE =
  '待导入的输入在预览之后发生了变化；这次操作没有写入，原数据保持不变。'

/**
 * M2 内存卫生：confirmed / canceled / superseded 是终态，下一次 prepare 前统一清理。
 * 不在终态发生时立刻删除，是为了让同一个句柄的重复 confirm / cancel 仍能返回
 * import_already_confirmed / import_cancelled，而不是退化成 import_expired。
 */
function prunePendingImports(): void {
  for (const [id, state] of pendingImports) {
    if (state.status === 'confirmed' || state.status === 'canceled' || state.status === 'superseded') {
      pendingImports.delete(id)
    }
  }
}

function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canonicalOf(value: unknown): string | null {
  const result = fingerprintOf(value)
  return result.ok ? result.fingerprint.canonical : null
}

function prepareFailure(
  reason: ImportPrepareFailureReason,
  message: string,
): ImportPrepareFailure {
  return { ok: false, reason, message }
}

function sourceBlocked(status: string, message: string): ImportPrepareFailure {
  return prepareFailure(
    'source_store_blocked',
    `当前库状态为 ${status}，不能覆盖原始字节。${message}`,
  )
}

function lockReady(locks: WorkspaceLockManager | null | undefined): boolean {
  const manager = locks === undefined ? getWorkspaceLockManager() : locks
  return manager !== null
}

function registerPending(
  kind: PendingKind,
  imported: unknown,
  canonical: string,
  previousRaw: string | null,
  previousStatus: 'ok' | 'empty',
  previousRevision: number | null,
  previousOwnerId: string | null,
  previousWorkspaceId: string | null,
  previousTripId: string | null,
  nextRevision: number | null,
  fileBytes: number,
): string {
  let importId = `import-${createLogicalId()}`
  while (pendingImports.has(importId)) {
    importId = `import-${createLogicalId()}`
  }
  prunePendingImports()
  pendingImports.set(importId, {
    kind,
    imported,
    canonical,
    previousRaw,
    previousStatus,
    previousRevision,
    previousOwnerId,
    previousWorkspaceId,
    previousTripId,
    nextRevision,
    fileBytes,
    generation: registerImportGenerationView(importId, keyForKind(kind)),
    status: 'prepared',
  })
  return importId
}

function keyForKind(kind: PendingKind): string {
  switch (kind) {
    case 'workspace':
      return WORKSPACE_STORAGE_KEY
    case 'candidates':
      return CANDIDATES_STORAGE_KEY
    case 'versions':
      return VERSIONS_STORAGE_KEY
  }
}

export interface PrepareImportOptions {
  storage?: WorkspaceStorageLike | null
  locks?: WorkspaceLockManager | null
}

export function prepareWorkspaceImport(
  text: string,
  options: PrepareImportOptions = {},
): PreparedWorkspaceImport | ImportPrepareFailure {
  const parsed = parseWorkspaceBackupText(text)
  if (!parsed.ok) return parsed
  const current = loadWorkspaceRecord(options.storage)
  if (current.status === 'unavailable') {
    return prepareFailure('unavailable', current.message)
  }
  if (current.status !== 'ok' && current.status !== 'empty') {
    return sourceBlocked(current.status, current.message)
  }
  const imported = parsed.backup.workspace
  const canonical = canonicalOf(imported)
  if (canonical === null) {
    return prepareFailure('invalid', '工作区备份内容无法生成完整 canonical 快照；未进入预览。')
  }
  let nextRevision = imported.workspaceRevision
  if (current.status === 'ok') {
    const next = nextWorkspaceRevision(current.record.workspaceRevision)
    if (!next.ok) return prepareFailure('invalid', next.message)
    nextRevision = next.value
  } else {
    nextRevision = 1
  }
  const stateImported = deepCloneJson(imported)
  const importId = registerPending(
    'workspace',
    stateImported,
    canonical,
    current.raw,
    current.status,
    current.status === 'ok' ? current.record.workspaceRevision : null,
    current.status === 'ok' ? current.record.ownerId : null,
    current.status === 'ok' ? current.record.workspaceId : null,
    current.status === 'ok' ? current.record.tripId : null,
    nextRevision,
    parsed.bytes,
  )
  return {
    ok: true,
    importId,
    kind: 'workspace',
    importedRecord: imported,
    fileBytes: parsed.bytes,
    previousRaw: current.raw,
    previousStatus: current.status,
    previousRevision: current.status === 'ok' ? current.record.workspaceRevision : null,
    previousOwnerId: current.status === 'ok' ? current.record.ownerId : null,
    previousWorkspaceId: current.status === 'ok' ? current.record.workspaceId : null,
    previousTripId: current.status === 'ok' ? current.record.tripId : null,
    nextRevision,
    writeReady: lockReady(options.locks),
  }
}

export function prepareCandidatesImport(
  text: string,
  options: PrepareImportOptions = {},
): PreparedCandidatesImport | ImportPrepareFailure {
  const parsed = parseCandidatesBackupText(text)
  if (!parsed.ok) return parsed
  const current = loadCandidatesRecord(options.storage)
  if (current.status === 'unavailable') {
    return prepareFailure('unavailable', current.message)
  }
  if (current.status !== 'ok' && current.status !== 'empty') {
    return sourceBlocked(current.status, current.message)
  }
  const imported = parsed.backup.candidates
  const canonical = canonicalOf(imported)
  if (canonical === null) {
    return prepareFailure('invalid', '候选库备份内容无法生成完整 canonical 快照；未进入预览。')
  }
  const importId = registerPending(
    'candidates',
    deepCloneJson(imported),
    canonical,
    current.raw,
    current.status,
    null,
    null,
    null,
    null,
    null,
    parsed.bytes,
  )
  return {
    ok: true,
    importId,
    kind: 'candidates',
    importedRecord: imported,
    fileBytes: parsed.bytes,
    previousRaw: current.raw,
    previousStatus: current.status,
    writeReady: lockReady(options.locks),
  }
}

export function prepareVersionsImport(
  text: string,
  options: PrepareImportOptions = {},
): PreparedVersionsImport | ImportPrepareFailure {
  const parsed = parseVersionsBackupText(text)
  if (!parsed.ok) return parsed
  const current = loadVersionsRecord(options.storage)
  if (current.status === 'unavailable') {
    return prepareFailure('unavailable', current.message)
  }
  if (current.status !== 'ok' && current.status !== 'empty') {
    return sourceBlocked(current.status, current.message)
  }
  const imported = parsed.backup.versions
  const canonical = canonicalOf(imported)
  if (canonical === null) {
    return prepareFailure('invalid', '版本库备份内容无法生成完整 canonical 快照；未进入预览。')
  }
  const importId = registerPending(
    'versions',
    deepCloneJson(imported),
    canonical,
    current.raw,
    current.status,
    null,
    null,
    null,
    null,
    null,
    parsed.bytes,
  )
  return {
    ok: true,
    importId,
    kind: 'versions',
    importedRecord: imported,
    fileBytes: parsed.bytes,
    previousRaw: current.raw,
    previousStatus: current.status,
    writeReady: lockReady(options.locks),
  }
}

function cancelFailure(
  reason: ImportConfirmFailureReason,
  message: string,
): { ok: false; reason: ImportConfirmFailureReason; message: string } {
  return { ok: false, reason, message }
}

export type ImportConfirmFailureReason =
  | WorkspaceSaveFailureReason
  | 'input_changed'
  | 'import_expired'
  | 'import_cancelled'
  | 'import_already_confirmed'
  | 'import_in_progress'
  | 'import_invalid'
  | 'import_superseded'

export type ImportCancelResult =
  | { ok: true; status: 'cancelled' }
  | { ok: false; reason: ImportConfirmFailureReason; message: string }

export function cancelPreparedImport(handle: { importId: string }): ImportCancelResult {
  const state = pendingImports.get(handle.importId)
  if (!state) return { ok: false, reason: 'import_expired', message: '导入预览已过期或不存在。' }
  if (state.status === 'confirmed') {
    return { ok: false, reason: 'import_already_confirmed', message: '这次导入已经确认写入。' }
  }
  if (state.status === 'confirming') {
    return { ok: false, reason: 'import_in_progress', message: '这次导入正在确认中。' }
  }
  state.status = 'canceled'
  removeImportGenerationView(handle.importId)
  return { ok: true, status: 'cancelled' }
}

/** 显式失效：与 storage 的 `invalidateLibraryGenerations` 等价（只针对单个句柄）。 */
export function invalidatePreparedImport(handle: { importId: string }): ImportCancelResult {
  const state = pendingImports.get(handle.importId)
  if (!state) return { ok: false, reason: 'import_expired', message: '导入预览已过期或不存在。' }
  if (state.status === 'confirmed') {
    return { ok: false, reason: 'import_already_confirmed', message: '这次导入已经确认写入。' }
  }
  if (state.status === 'confirming') {
    return { ok: false, reason: 'import_in_progress', message: '这次导入正在确认中。' }
  }
  state.status = 'superseded'
  removeImportGenerationView(handle.importId)
  return { ok: true, status: 'cancelled' }
}

export interface ConfirmImportOptions {
  storage?: WorkspaceStorageLike | null
  locks?: WorkspaceLockManager | null
  now: number
  undoTtlMs?: number
}

function lookupPending(
  importId: string,
  kind: PendingKind,
): { ok: true; state: PendingImportState } | { ok: false; reason: ImportConfirmFailureReason; message: string } {
  const state = pendingImports.get(importId)
  if (!state) return cancelFailure('import_expired', '导入预览已过期或不存在，请重新选择文件。')
  if (state.kind !== kind) {
    return cancelFailure('import_invalid', '导入句柄与库类型不匹配。')
  }
  // prepared 但代际已推进（同页其它成功写入 / 显式失效）→ 不再可确认。
  if (state.status === 'prepared' && state.generation !== currentStorageGeneration(keyForKind(kind))) {
    state.status = 'superseded'
  }
  switch (state.status) {
    case 'confirmed':
      return cancelFailure('import_already_confirmed', '这次导入已经确认写入，不能重复确认。')
    case 'canceled':
      return cancelFailure('import_cancelled', '这次导入已取消，没有写入任何内容。')
    case 'confirming':
      return cancelFailure('import_in_progress', '这次导入正在确认中。')
    case 'superseded':
      return cancelFailure(
        'import_superseded',
        '这次导入的预览已过期：期间本地数据有过其它成功写入或被显式失效；请重新预览。原数据未被改动。',
      )
    default:
      return { ok: true, state }
  }
}

function previewMatches(
  state: PendingImportState,
  preview: {
    previousRaw: string | null
    previousStatus: 'ok' | 'empty'
    previousRevision?: number | null
    previousOwnerId?: string | null
    previousWorkspaceId?: string | null
    previousTripId?: string | null
    nextRevision?: number | null
    fileBytes: number
    importedRecord: unknown
  },
): boolean {
  if (
    preview.previousRaw !== state.previousRaw ||
    preview.previousStatus !== state.previousStatus ||
    (preview.previousRevision ?? null) !== state.previousRevision ||
    (preview.previousOwnerId ?? null) !== state.previousOwnerId ||
    (preview.previousWorkspaceId ?? null) !== state.previousWorkspaceId ||
    (preview.previousTripId ?? null) !== state.previousTripId ||
    (preview.nextRevision ?? null) !== state.nextRevision ||
    preview.fileBytes !== state.fileBytes
  ) {
    return false
  }
  const canonical = canonicalOf(preview.importedRecord)
  return canonical !== null && canonical === state.canonical
}

export type ConfirmWorkspaceImportResult =
  | {
      ok: true
      status: 'imported'
      record: WorkspaceRecordV1
      raw: string
      bytes: number
      previousRaw: string | null
      undo: StorageUndoHandle
    }
  | { ok: false; reason: ImportConfirmFailureReason; message: string }

export async function confirmWorkspaceImport(
  handle: PreparedWorkspaceImport,
  options: ConfirmImportOptions,
): Promise<ConfirmWorkspaceImportResult> {
  const lookup = lookupPending(handle.importId, 'workspace')
  if (!lookup.ok) return lookup
  const state = lookup.state
  if (!previewMatches(state, handle)) {
    return cancelFailure('input_changed', INPUT_CHANGED_MESSAGE)
  }
  state.status = 'confirming'
  try {
    const result = await commitWorkspaceImport(
      state.imported as WorkspaceRecordV1,
      {
        expectedRaw: state.previousRaw,
        expectedRecordCanonical: state.canonical,
        expectedWorkspaceId: state.previousWorkspaceId,
        expectedOwnerId: state.previousOwnerId,
        expectedTripId: state.previousTripId,
        expectedRevision: state.previousRevision,
      },
      {
        storage: options.storage,
        locks: options.locks,
        now: options.now,
        undoTtlMs: options.undoTtlMs,
      },
    )
    if (!result.ok) {
      state.status = 'prepared'
      return { ok: false, reason: result.reason, message: result.message }
    }
    state.status = 'confirmed'
    removeImportGenerationView(handle.importId)
    return result
  } catch {
    state.status = 'prepared'
    return cancelFailure('unknown', '确认导入时发生未知错误；没有写入任何内容。')
  }
}

export type ConfirmCandidatesImportResult =
  | {
      ok: true
      status: 'imported'
      record: CandidatesRecordV1
      raw: string
      bytes: number
      previousRaw: string | null
      undo: StorageUndoHandle
    }
  | { ok: false; reason: ImportConfirmFailureReason; message: string }

export async function confirmCandidatesImport(
  handle: PreparedCandidatesImport,
  options: ConfirmImportOptions,
): Promise<ConfirmCandidatesImportResult> {
  const lookup = lookupPending(handle.importId, 'candidates')
  if (!lookup.ok) return lookup
  const state = lookup.state
  if (!previewMatches(state, handle)) {
    return cancelFailure('input_changed', INPUT_CHANGED_MESSAGE)
  }
  state.status = 'confirming'
  try {
    const result = await commitCandidatesImport(
      state.imported as CandidatesRecordV1,
      { expectedRaw: state.previousRaw, expectedRecordCanonical: state.canonical },
      {
        storage: options.storage,
        locks: options.locks,
        now: options.now,
        undoTtlMs: options.undoTtlMs,
      },
    )
    if (!result.ok) {
      state.status = 'prepared'
      return { ok: false, reason: result.reason, message: result.message }
    }
    state.status = 'confirmed'
    removeImportGenerationView(handle.importId)
    return result
  } catch {
    state.status = 'prepared'
    return cancelFailure('unknown', '确认导入时发生未知错误；没有写入任何内容。')
  }
}

export type ConfirmVersionsImportResult =
  | {
      ok: true
      status: 'imported'
      record: VersionsRecordV1
      raw: string
      bytes: number
      previousRaw: string | null
      undo: StorageUndoHandle
    }
  | { ok: false; reason: ImportConfirmFailureReason; message: string }

export async function confirmVersionsImport(
  handle: PreparedVersionsImport,
  options: ConfirmImportOptions,
): Promise<ConfirmVersionsImportResult> {
  const lookup = lookupPending(handle.importId, 'versions')
  if (!lookup.ok) return lookup
  const state = lookup.state
  if (!previewMatches(state, handle)) {
    return cancelFailure('input_changed', INPUT_CHANGED_MESSAGE)
  }
  state.status = 'confirming'
  try {
    const result = await commitVersionsImport(
      state.imported as VersionsRecordV1,
      { expectedRaw: state.previousRaw, expectedRecordCanonical: state.canonical },
      {
        storage: options.storage,
        locks: options.locks,
        now: options.now,
        undoTtlMs: options.undoTtlMs,
      },
    )
    if (!result.ok) {
      state.status = 'prepared'
      return { ok: false, reason: result.reason, message: result.message }
    }
    state.status = 'confirmed'
    removeImportGenerationView(handle.importId)
    return result
  } catch {
    state.status = 'prepared'
    return cancelFailure('unknown', '确认导入时发生未知错误；没有写入任何内容。')
  }
}

/* ───────── 会话 v2 workspace 块 adapter（纯函数，不接线） ───────── */

export interface SessionWorkspaceBlockV1 {
  readonly workspaceId: string
  readonly ownerId: string
  readonly workspaceRevision: number
  readonly updatedAt: number
  readonly sidecar: WorkspaceSidecarV1
  readonly meta: WorkspaceMetaV1
}

const SESSION_WORKSPACE_BLOCK_KEYS = [
  'workspaceId',
  'ownerId',
  'workspaceRevision',
  'updatedAt',
  'sidecar',
  'meta',
] as const

function sessionFailure(
  reason: WorkspaceValidationFailure['reason'],
  path: string,
  message: string,
): WorkspaceValidationFailure {
  return { ok: false, reason, path, message }
}

/** 写会话 v2 时使用的 workspace 块；不包含 Trip / budget（它们在 session 的既有位置）。 */
export function createSessionWorkspaceBlock(
  record: WorkspaceRecordV1,
): WorkspaceValidationResult<SessionWorkspaceBlockV1> {
  const checked = validateWorkspaceRecord(record)
  if (!checked.ok) return checked
  return {
    ok: true,
    value: {
      workspaceId: checked.value.workspaceId,
      ownerId: checked.value.ownerId,
      workspaceRevision: checked.value.workspaceRevision,
      updatedAt: checked.value.updatedAt,
      sidecar: checked.value.sidecar,
      meta: checked.value.meta,
    },
  }
}

export interface SessionWorkspaceRehydrateInput {
  readonly trip: Trip
  /** 已由 sessionRestore owner 按 binding 规则映射好的预算；本 adapter 不重新解释 binding。 */
  readonly budget: BudgetSnapshotV1 | null
  /** v2 的 session.workspace；null = 旧 v1 未关联。 */
  readonly workspace: unknown
}

/**
 * 从会话 v2 的 session.trip / 已映射 budget / workspace 块重建完整工作区记录。
 * - workspace === null → 返回 null（未关联），不自动生成 id / 不自动挂 sidecar。
 * - 严格拒绝 workspace 块未知字段；整条记录再走 validateWorkspaceRecord。
 * - 不读 / 写 localStorage，不注册事件。
 */
export function rehydrateWorkspaceFromSession(
  input: SessionWorkspaceRehydrateInput,
): WorkspaceValidationResult<WorkspaceRecordV1 | null> {
  if (input.workspace === null) return { ok: true, value: null }
  if (!isRecord(input.workspace)) {
    return sessionFailure('invalid_field', '$.workspace', 'session.workspace 必须是对象或 null。')
  }
  const keys = Object.keys(input.workspace)
  if (keys.length !== SESSION_WORKSPACE_BLOCK_KEYS.length) {
    return sessionFailure('unknown_field', '$.workspace', 'session.workspace 的字段集合不符合 v1 契约。')
  }
  for (const key of keys) {
    if (!(SESSION_WORKSPACE_BLOCK_KEYS as readonly string[]).includes(key)) {
      return sessionFailure('unknown_field', '$.workspace', 'session.workspace 含有未知字段。')
    }
  }
  const block = input.workspace as Record<string, unknown>
  const tripId =
    isRecord(input.trip) && typeof input.trip.id === 'string' ? input.trip.id : ''
  const candidate: WorkspaceRecordV1 = {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    workspaceId: block.workspaceId as string,
    ownerId: block.ownerId as string,
    tripId,
    trip: input.trip,
    sidecar: block.sidecar as WorkspaceSidecarV1,
    budget: input.budget,
    workspaceRevision: block.workspaceRevision as number,
    updatedAt: block.updatedAt as number,
    meta: block.meta as WorkspaceMetaV1,
  }
  return validateWorkspaceRecord(candidate)
}

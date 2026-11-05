/**
 * 工作区 / 候选库 / 版本库的 localStorage adapter。
 *
 * 边界（docs/WORKSPACE_SIDECAR.md §6 / 本批计划）：
 * - 三个键、三条记录、各自一次 setItem；没有跨键事务 / 补偿 rollback。
 * - 模块 import 时不读 localStorage；只有调用明确的 load / save / import / undo 才访问。
 * - 读取状态严格区分 ok / empty / unavailable / corrupt / anomaly / unknown_version。
 * - corrupt / anomaly / unknown_version 普通写入一律拒绝，原字节保持不动，不自动驱逐。
 * - 工作区保存必须带冻结 raw，并在同一把锁内重读比对；revision 只允许当前 +1。
 * - 候选库 / 版本库保存同样比对冻结 raw，但不触碰工作区键。
 * - 所有写操作需要可验证的跨 tab 互斥（Web Locks）。没有 lock 时读取仍可用，写入 typed 拒绝；
 *   不把同步 localStorage 冒充 CAS，也不使用 spin / sleep。
 * - 一次 undo 只恢复上一次 import 写入前的原始字节，并再次核当前 raw，绝不覆盖其它 tab 的更新。
 */
import {
  CANDIDATES_FORMAT,
  CANDIDATES_STORAGE_KEY,
  CANDIDATES_VERSION,
  MAX_CANDIDATES_BYTES,
  MAX_VERSIONS_TOTAL_BYTES,
  MAX_WORKSPACE_RECORD_BYTES,
  VERSIONS_FORMAT,
  VERSIONS_STORAGE_KEY,
  VERSIONS_VERSION,
  WORKSPACE_FORMAT,
  WORKSPACE_STORAGE_KEY,
  WORKSPACE_VERSION,
  type CandidatesRecordV1,
  type VersionsRecordV1,
  type WorkspaceRecordV1,
  type WorkspaceStoreStatus,
} from './workspaceTypes'
import {
  checkCandidatesRecordLimits,
  checkVersionsRecordLimits,
  checkWorkspaceRecordLimits,
  createLogicalId,
  emptyChecklist,
  nextWorkspaceRevision,
  validateCandidatesRecord,
  validateVersionsRecord,
  validateWorkspaceRecord,
} from './workspace'
import { fingerprintOf } from './workspaceFingerprint'
import { utf8ByteLength } from './savedTrips'

/* ───────── 存储形状与安全读取 ───────── */

export interface WorkspaceStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 读取 raw 的安全上限：合法记录上限 + 64 KiB 余量；超过不再 JSON.parse。 */
export const MAX_WORKSPACE_RAW_READ_BYTES = MAX_WORKSPACE_RECORD_BYTES + 64 * 1024
export const MAX_CANDIDATES_RAW_READ_BYTES = MAX_CANDIDATES_BYTES + 64 * 1024
export const MAX_VERSIONS_RAW_READ_BYTES = MAX_VERSIONS_TOTAL_BYTES + 64 * 1024

/** 同一 origin、同一库的稳定 lock 名；测试与集成方不应自行改名。 */
export const WORKSPACE_STORAGE_LOCK_NAME = `${WORKSPACE_STORAGE_KEY}:lock`
export const CANDIDATES_STORAGE_LOCK_NAME = `${CANDIDATES_STORAGE_KEY}:lock`
export const VERSIONS_STORAGE_LOCK_NAME = `${VERSIONS_STORAGE_KEY}:lock`

export const DEFAULT_UNDO_TTL_MS = 5 * 60 * 1000
export const MAX_UNDO_TTL_MS = 60 * 60 * 1000

const UNAVAILABLE_MESSAGE =
  '当前浏览器无法访问本地存储（可能是无痕模式、隐私设置禁用了站点数据，或页面不在浏览器环境中）。本次没有写入任何数据。'
const CORRUPT_MESSAGE =
  '本地数据已损坏或不是当前约定的结构。为避免覆盖原始内容，读取已停止，普通写入与导入不会执行。'
const ANOMALY_MESSAGE =
  '本地数据里存在无法严格识别的条目或超出上限的内容。原始字节被保留；普通写入与导入不会执行，避免用清洗后的数据覆盖原内容。'
const UNKNOWN_VERSION_MESSAGE =
  '本地数据的版本不是当前支持的版本。原始字节被保留，不会覆盖或自动迁移。'
const CONFLICT_MESSAGE = '另一处已更新本地数据；这次操作没有写入，原数据保持不变。'
const LOCK_UNAVAILABLE_MESSAGE =
  '当前浏览器不支持可验证的跨标签页互斥（Web Locks），或页面没有提供锁管理器。读取仍可用，但为避免丢更新，写入已被拒绝。'
const INPUT_CHANGED_MESSAGE = '待写入的输入在预览之后发生了变化；这次操作没有写入，原数据保持不变。'

export type WorkspaceReadStatus = WorkspaceStoreStatus

export interface StoreReadBase {
  readonly raw: string | null
  readonly bytes: number
  readonly message: string | null
}

export interface WorkspaceChecklistSalvage {
  /** 只用于只读展示：checklist 已被空清单替换，原字节仍在 raw 里。 */
  readonly record: WorkspaceRecordV1
  readonly checklistDamaged: true
}

export type WorkspaceRecordRead =
  | (StoreReadBase & { status: 'ok'; record: WorkspaceRecordV1; salvage: null; message: null })
  | (StoreReadBase & { status: 'empty'; record: null; salvage: null; message: null })
  | (StoreReadBase & {
      status: 'anomaly'
      record: null
      salvage: WorkspaceChecklistSalvage | null
      message: string
    })
  | (StoreReadBase & { status: 'corrupt'; record: null; salvage: null; message: string })
  | (StoreReadBase & { status: 'unknown_version'; record: null; salvage: null; message: string })
  | (StoreReadBase & { status: 'unavailable'; record: null; salvage: null; message: string })

export type StoreRead<T> =
  | (StoreReadBase & { status: 'ok'; record: T; message: null })
  | (StoreReadBase & { status: 'empty'; record: null; message: null })
  | (StoreReadBase & {
      status: 'anomaly' | 'corrupt' | 'unknown_version' | 'unavailable'
      record: null
      message: string
    })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isTimestamp(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0
}

export function getWorkspaceLocalStorage(): WorkspaceStorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return (window.localStorage as WorkspaceStorageLike | undefined) ?? null
  } catch {
    return null
  }
}

function resolveStorage(
  storage: WorkspaceStorageLike | null | undefined,
): WorkspaceStorageLike | null {
  return storage === undefined ? getWorkspaceLocalStorage() : storage
}

type RawRead =
  | { ok: true; raw: string | null; bytes: number }
  | { ok: false; reason: 'unavailable' | 'corrupt'; message: string }

function readRaw(storage: WorkspaceStorageLike, key: string): RawRead {
  let raw: unknown
  try {
    raw = storage.getItem(key)
  } catch {
    return { ok: false, reason: 'unavailable', message: UNAVAILABLE_MESSAGE }
  }
  if (raw === null) return { ok: true, raw: null, bytes: 0 }
  if (typeof raw !== 'string') {
    return {
      ok: false,
      reason: 'corrupt',
      message: '本地存储返回了非字符串内容；已停止读取，避免覆盖未知数据。',
    }
  }
  return { ok: true, raw, bytes: utf8ByteLength(raw) }
}

function emptyRead<T>(raw: string | null, bytes: number): StoreRead<T> {
  return { status: 'empty', raw, bytes, record: null, message: null }
}

function unavailableRead<T>(raw: string | null = null): StoreRead<T> {
  return { status: 'unavailable', raw, bytes: raw === null ? 0 : utf8ByteLength(raw), record: null, message: UNAVAILABLE_MESSAGE }
}

function corruptRead<T>(raw: string | null, bytes: number, message = CORRUPT_MESSAGE): StoreRead<T> {
  return { status: 'corrupt', raw, bytes, record: null, message }
}

function unknownVersionRead<T>(raw: string, bytes: number): StoreRead<T> {
  return { status: 'unknown_version', raw, bytes, record: null, message: UNKNOWN_VERSION_MESSAGE }
}

function anomalyRead<T>(raw: string, bytes: number): StoreRead<T> {
  return { status: 'anomaly', raw, bytes, record: null, message: ANOMALY_MESSAGE }
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false }
  }
}

function parseWorkspaceRaw(raw: string | null, bytes: number): WorkspaceRecordRead {
  if (raw === null || raw.trim() === '') {
    return { status: 'empty', raw, bytes, record: null, salvage: null, message: null }
  }
  if (bytes > MAX_WORKSPACE_RAW_READ_BYTES) {
    return {
      status: 'corrupt',
      raw,
      bytes,
      record: null,
      salvage: null,
      message: '本地工作区数据体积异常，超过可安全读取的上限；已停止读取，原始内容保留。',
    }
  }
  const parsed = parseJson(raw)
  if (!parsed.ok || !isRecord(parsed.value)) {
    return { status: 'corrupt', raw, bytes, record: null, salvage: null, message: CORRUPT_MESSAGE }
  }
  const value = parsed.value
  if (value.format !== WORKSPACE_FORMAT) {
    return { status: 'corrupt', raw, bytes, record: null, salvage: null, message: CORRUPT_MESSAGE }
  }
  if (value.version !== WORKSPACE_VERSION) {
    if (value.version === undefined) {
      return { status: 'corrupt', raw, bytes, record: null, salvage: null, message: CORRUPT_MESSAGE }
    }
    return {
      status: 'unknown_version',
      raw,
      bytes,
      record: null,
      salvage: null,
      message: UNKNOWN_VERSION_MESSAGE,
    }
  }

  const validated = validateWorkspaceRecord(value)
  if (validated.ok) {
    return { status: 'ok', raw, bytes, record: validated.value, salvage: null, message: null }
  }

  // 唯一的分段容错：仅 checklist 坏时允许只读 salvage；其它段坏一律整条 corrupt。
  const salvage = tryChecklistSalvage(value)
  if (salvage !== null) {
    return {
      status: 'anomaly',
      raw,
      bytes,
      record: null,
      salvage: { record: salvage, checklistDamaged: true },
      message:
        '工作区里的清单段损坏，清单未加载；行程与其它 sidecar 只读展示。原始字节保留，普通保存、导入和版本采用都会被拒绝，直到用户显式处理原记录。',
    }
  }
  return { status: 'anomaly', raw, bytes, record: null, salvage: null, message: ANOMALY_MESSAGE }
}

function tryChecklistSalvage(value: Record<string, unknown>): WorkspaceRecordV1 | null {
  const sidecar = value.sidecar
  if (!isRecord(sidecar)) return null
  const candidate: Record<string, unknown> = {
    ...value,
    sidecar: { ...sidecar, checklist: emptyChecklist() },
  }
  const validated = validateWorkspaceRecord(candidate)
  return validated.ok ? validated.value : null
}

export function loadWorkspaceRecord(
  storage: WorkspaceStorageLike | null | undefined = undefined,
): WorkspaceRecordRead {
  const store = resolveStorage(storage)
  if (!store) {
    return { status: 'unavailable', raw: null, bytes: 0, record: null, salvage: null, message: UNAVAILABLE_MESSAGE }
  }
  const read = readRaw(store, WORKSPACE_STORAGE_KEY)
  if (!read.ok) {
    return {
      status: read.reason,
      raw: null,
      bytes: 0,
      record: null,
      salvage: null,
      message: read.message,
    }
  }
  return parseWorkspaceRaw(read.raw, read.bytes)
}

function parseCandidatesRaw(raw: string | null, bytes: number): StoreRead<CandidatesRecordV1> {
  if (raw === null || raw.trim() === '') return emptyRead(raw, bytes)
  if (bytes > MAX_CANDIDATES_RAW_READ_BYTES) {
    return corruptRead(
      raw,
      bytes,
      '本地候选库体积异常，超过可安全读取的上限；已停止读取，原始内容保留。',
    )
  }
  const parsed = parseJson(raw)
  if (!parsed.ok || !isRecord(parsed.value)) return corruptRead(raw, bytes)
  const value = parsed.value
  if (value.format !== CANDIDATES_FORMAT) return corruptRead(raw, bytes)
  if (value.version !== CANDIDATES_VERSION) {
    if (value.version === undefined) return corruptRead(raw, bytes)
    return unknownVersionRead(raw, bytes)
  }
  const validated = validateCandidatesRecord(value)
  if (!validated.ok) return anomalyRead(raw, bytes)
  return { status: 'ok', raw, bytes, record: validated.value, message: null }
}

export function loadCandidatesRecord(
  storage: WorkspaceStorageLike | null | undefined = undefined,
): StoreRead<CandidatesRecordV1> {
  const store = resolveStorage(storage)
  if (!store) return unavailableRead()
  const read = readRaw(store, CANDIDATES_STORAGE_KEY)
  if (!read.ok) {
    return {
      status: read.reason,
      raw: null,
      bytes: 0,
      record: null,
      message: read.message,
    }
  }
  return parseCandidatesRaw(read.raw, read.bytes)
}

function parseVersionsRaw(raw: string | null, bytes: number): StoreRead<VersionsRecordV1> {
  if (raw === null || raw.trim() === '') return emptyRead(raw, bytes)
  if (bytes > MAX_VERSIONS_RAW_READ_BYTES) {
    return corruptRead(
      raw,
      bytes,
      '本地版本库体积异常，超过可安全读取的上限；已停止读取，原始内容保留。',
    )
  }
  const parsed = parseJson(raw)
  if (!parsed.ok || !isRecord(parsed.value)) return corruptRead(raw, bytes)
  const value = parsed.value
  if (value.format !== VERSIONS_FORMAT) return corruptRead(raw, bytes)
  if (value.version !== VERSIONS_VERSION) {
    if (value.version === undefined) return corruptRead(raw, bytes)
    return unknownVersionRead(raw, bytes)
  }
  const validated = validateVersionsRecord(value)
  if (!validated.ok) return anomalyRead(raw, bytes)
  return { status: 'ok', raw, bytes, record: validated.value, message: null }
}

export function loadVersionsRecord(
  storage: WorkspaceStorageLike | null | undefined = undefined,
): StoreRead<VersionsRecordV1> {
  const store = resolveStorage(storage)
  if (!store) return unavailableRead()
  const read = readRaw(store, VERSIONS_STORAGE_KEY)
  if (!read.ok) {
    return {
      status: read.reason,
      raw: null,
      bytes: 0,
      record: null,
      message: read.message,
    }
  }
  return parseVersionsRaw(read.raw, read.bytes)
}

/* ───────── 跨 tab 互斥：同页串行 + Web Locks ───────── */

export interface WorkspaceLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T> | T,
  ): Promise<T>
}

export function getWorkspaceLockManager(): WorkspaceLockManager | null {
  try {
    if (typeof navigator === 'undefined') return null
    const locks = (navigator as Navigator & { locks?: WorkspaceLockManager }).locks
    return locks && typeof locks.request === 'function' ? locks : null
  } catch {
    return null
  }
}

const pageQueues = new Map<string, Promise<void>>()

function enqueueSamePage<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = pageQueues.get(name) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  pageQueues.set(name, tail)
  void tail.then(() => {
    if (pageQueues.get(name) === tail) pageQueues.delete(name)
  })
  return run
}

/**
 * 同一页面串行 + Web Locks 跨 tab 互斥。`locks === undefined` 时尝试 navigator.locks；
 * 显式 `null` 表示不提供锁（写入会 typed 拒绝）。callback 不 spin、不 sleep。
 *
 * M3 修复：锁内 task 抛错单独映射为 `unknown`，与「锁真的不可用」区分；
 * 锁请求本身失败才返回 `lock_unavailable`。
 */
export type ExclusiveRun<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'lock_unavailable' | 'unknown'; message: string }

export async function runWorkspaceExclusive<T>(
  locks: WorkspaceLockManager | null | undefined,
  name: string,
  task: () => Promise<T>,
): Promise<ExclusiveRun<T>> {
  const manager = locks === undefined ? getWorkspaceLockManager() : locks
  if (!manager) {
    return { ok: false, reason: 'lock_unavailable', message: LOCK_UNAVAILABLE_MESSAGE }
  }
  let acquired = false
  try {
    return await enqueueSamePage(name, async () =>
      manager.request(name, { mode: 'exclusive' }, async () => {
        acquired = true
        return {
          ok: true as const,
          value: await task(),
        }
      }),
    )
  } catch (error) {
    if (acquired) {
      // 锁已成功获取；异常来自 task 本身（回调 bug / 序列化等），不是锁缺失。
      return {
        ok: false,
        reason: 'unknown',
        message: `写入流程在持锁期间发生未知错误${error instanceof Error && error.message ? `：${error.message}` : ''}；没有写入任何内容。`,
      }
    }
    return { ok: false, reason: 'lock_unavailable', message: LOCK_UNAVAILABLE_MESSAGE }
  }
}

/* ───────── 同页写代际（generation）：旧 prepared 句柄 / 旧 undo 的 ABA 防护 ───────── */

/**
 * 每个库一次成功的 write / confirm / undo 都会推进自己的 generation。
 * prepared import 句柄冻结创建时的 generation；confirm / undo 在锁内真正写入前
 * 先比对当前 generation，任何同页成功写入（哪怕字节被 undo 完整恢复成旧 raw）
 * 都会让旧句柄失效（`import_superseded`）。这是同页可验证的生命周期保证。
 *
 * **不覆盖外部 ABA**：其它 tab 的写入不经过本页 generation。跨 tab 一致性由
 * raw + revision 比对兜底；App 层必须监听 storage 事件推进自己的 epoch，并对
 * 每个库调用 `invalidateLibraryGenerations`（见文档 §7 / §11 的 App 义务）。
 */
const libraryGenerations = new Map<string, number>()

function currentGeneration(key: string): number {
  return libraryGenerations.get(key) ?? 0
}

/** 同模块内协作读取（workspaceTransfer 用）；对外用 getLibraryGeneration。 */
export function currentStorageGeneration(key: string): number {
  return currentGeneration(key)
}

function advanceGeneration(key: string): number {
  const next = currentGeneration(key) + 1
  libraryGenerations.set(key, next)
  return next
}

export interface LibraryGeneration {
  readonly key: string
  readonly generation: number
}

/**
 * 同页 pending import 登记的最小视图（storage 不持有导入内容本体，
 * 内容在 workspaceTransfer 的 pendingImports 里）。仅用于代际失效联动。
 */
interface ImportStateView {
  key: string
  frozenGeneration: number
  status: 'prepared' | 'confirming' | 'confirmed' | 'canceled' | 'superseded'
}

const pendingImportViews = new Map<string, ImportStateView>()

/** workspaceTransfer 注册 prepared 句柄视图（同模块内协作，不对外）。 */
export function registerImportGenerationView(
  importId: string,
  key: string,
): number {
  pendingImportViews.set(importId, {
    key,
    frozenGeneration: currentGeneration(key),
    status: 'prepared',
  })
  return currentGeneration(key)
}

/** workspaceTransfer 在终态时移除视图。 */
export function removeImportGenerationView(importId: string): void {
  pendingImportViews.delete(importId)
}

function setImportViewStatus(importId: string, status: ImportStateView['status']): void {
  const view = pendingImportViews.get(importId)
  if (view) view.status = status
}
void setImportViewStatus

/** 显式读取某库当前 generation（测试 / App live guard 用）。 */
export function getLibraryGeneration(key: string): LibraryGeneration {
  return { key, generation: currentGeneration(key) }
}

/**
 * 显式失效某库所有未确认 prepared 句柄与未用 undo 句柄（同页）。
 * App 在收到本 origin 的 storage 事件（即使 newRaw === oldRaw）时必须调用；
 * 除此之外，同页每次成功 write / confirm / undo 都会自动推进。
 */
export function invalidateLibraryGenerations(key: string): LibraryGeneration {
  const generation = advanceGeneration(key)
  for (const view of pendingImportViews.values()) {
    if (view.key === key && view.status === 'prepared') {
      view.status = 'superseded'
    }
  }
  // 未用 undo 不需要额外标记：generation 已推进，undo 锁内 ensureLiveGeneration
  // 会以 import_superseded 拒绝旧句柄，且不会覆盖其它写入。
  return { key, generation }
}

/** 可测试的 live guard：prepared 句柄是否仍指向当前代际。 */
export function preparedImportIsLive(handle: { importId: string }): boolean {
  const view = pendingImportViews.get(handle.importId)
  if (!view) return false
  return view.status === 'prepared' && currentGeneration(view.key) === view.frozenGeneration
}

function ensureLiveGeneration(key: string, generation: number):
  | { ok: true }
  | { ok: false; reason: 'import_superseded'; message: string } {
  if (generation !== currentGeneration(key)) {
    return {
      ok: false,
      reason: 'import_superseded',
      message: '这次导入的预览已经过期：期间本地数据有过其它成功写入或被显式失效；请重新预览。原数据未被改动。',
    }
  }
  return { ok: true }
}


/* ───────── 写入错误分类 ───────── */

export type StorageWriteFailureReason = 'quota' | 'unavailable' | 'blocked' | 'unknown'

export interface StorageWriteFailure {
  readonly ok: false
  readonly reason: StorageWriteFailureReason
  readonly message: string
}

export function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    if (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    ) {
      return true
    }
  }
  return (
    error instanceof Error &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

function isSecurityError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      (error.name === 'SecurityError' || error.code === 18)) ||
    (error instanceof Error && error.name === 'SecurityError')
  )
}

function isBlockedError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      (error.name === 'BlockedError' || error.name === 'NotAllowedError' || error.name === 'Blocked')) ||
    (error instanceof Error &&
      (error.name === 'BlockedError' || error.name === 'NotAllowedError' || error.name === 'Blocked'))
  )
}

function mapWriteError(error: unknown, action: string): StorageWriteFailure {
  if (isQuotaError(error)) {
    return {
      ok: false,
      reason: 'quota',
      message: `浏览器本地存储已满，${action}没有写入。已有数据保持原样；本工具不会自动驱逐旧数据，请先显式清理。`,
    }
  }
  if (isSecurityError(error) || isBlockedError(error)) {
    return {
      ok: false,
      reason: isBlockedError(error) ? 'blocked' : 'unavailable',
      message: `浏览器拒绝访问本地存储，${action}没有写入。已有数据保持原样。`,
    }
  }
  return {
    ok: false,
    reason: 'unknown',
    message: `写入本地存储失败，${action}没有完成。已有数据保持原样，请重试或检查浏览器设置。`,
  }
}

function writeRaw(
  storage: WorkspaceStorageLike,
  key: string,
  payload: string,
  action: string,
): StorageWriteFailure | null {
  try {
    storage.setItem(key, payload)
    return null
  } catch (error) {
    return mapWriteError(error, action)
  }
}

function removeRaw(
  storage: WorkspaceStorageLike,
  key: string,
  action: string,
): StorageWriteFailure | null {
  try {
    storage.removeItem(key)
    return null
  } catch (error) {
    return mapWriteError(error, action)
  }
}

/* ───────── 校验 / 序列化 ───────── */

function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function serializeJson(value: unknown): { ok: true; text: string; bytes: number } | { ok: false } {
  try {
    const text = JSON.stringify(value)
    if (typeof text !== 'string') return { ok: false }
    return { ok: true, text, bytes: utf8ByteLength(text) }
  } catch {
    return { ok: false }
  }
}

type PreparedWorkspace = {
  ok: true
  record: WorkspaceRecordV1
  payload: string
  bytes: number
}

type PreparedLibrary<T> = { ok: true; record: T; payload: string; bytes: number }

type PrepareFailure = { ok: false; reason: 'invalid' | 'too_large'; message: string }

function prepareWorkspace(record: WorkspaceRecordV1): PreparedWorkspace | PrepareFailure {
  const validated = validateWorkspaceRecord(record)
  if (!validated.ok) {
    return {
      ok: false,
      reason: validated.reason === 'limit_exceeded' ? 'too_large' : 'invalid',
      message: `工作区记录未通过严格校验（${validated.path}）：${validated.message}`,
    }
  }
  const frozen = deepCloneJson(validated.value)
  const limit = checkWorkspaceRecordLimits(frozen)
  if (!limit.ok) {
    return { ok: false, reason: 'too_large', message: limit.message }
  }
  const serialized = serializeJson(frozen)
  if (!serialized.ok) {
    return { ok: false, reason: 'invalid', message: '工作区记录无法序列化；没有写入。' }
  }
  if (serialized.bytes > MAX_WORKSPACE_RECORD_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      message: `工作区记录超过 2 MiB 上限（实际 ${serialized.bytes} 字节）；没有写入，旧数据保持不变。`,
    }
  }
  return { ok: true, record: frozen, payload: serialized.text, bytes: serialized.bytes }
}

function prepareCandidates(record: CandidatesRecordV1): PreparedLibrary<CandidatesRecordV1> | PrepareFailure {
  const validated = validateCandidatesRecord(record)
  if (!validated.ok) {
    return {
      ok: false,
      reason: validated.reason === 'limit_exceeded' ? 'too_large' : 'invalid',
      message: `候选库未通过严格校验（${validated.path}）：${validated.message}`,
    }
  }
  const frozen = deepCloneJson(validated.value)
  const limit = checkCandidatesRecordLimits(frozen)
  if (!limit.ok) return { ok: false, reason: 'too_large', message: limit.message }
  const serialized = serializeJson(frozen)
  if (!serialized.ok) {
    return { ok: false, reason: 'invalid', message: '候选库无法序列化；没有写入。' }
  }
  return { ok: true, record: frozen, payload: serialized.text, bytes: serialized.bytes }
}

function prepareVersions(record: VersionsRecordV1): PreparedLibrary<VersionsRecordV1> | PrepareFailure {
  const validated = validateVersionsRecord(record)
  if (!validated.ok) {
    return {
      ok: false,
      reason: validated.reason === 'limit_exceeded' ? 'too_large' : 'invalid',
      message: `版本库未通过严格校验（${validated.path}）：${validated.message}`,
    }
  }
  const frozen = deepCloneJson(validated.value)
  const limit = checkVersionsRecordLimits(frozen)
  if (!limit.ok) return { ok: false, reason: 'too_large', message: limit.message }
  const serialized = serializeJson(frozen)
  if (!serialized.ok) {
    return { ok: false, reason: 'invalid', message: '版本库无法序列化；没有写入。' }
  }
  return { ok: true, record: frozen, payload: serialized.text, bytes: serialized.bytes }
}

function canonicalOf(value: unknown): string | null {
  const result = fingerprintOf(value)
  return result.ok ? result.fingerprint.canonical : null
}

/* ───────── 保存 API ───────── */

export type WorkspaceSaveFailureReason =
  | 'invalid'
  | 'too_large'
  | 'unavailable'
  | 'blocked'
  | 'quota'
  | 'unknown'
  | 'lock_unavailable'
  | 'conflict'
  | 'input_changed'
  | 'owner_conflict'
  | 'revision_conflict'
  | 'corrupt'
  | 'anomaly'
  | 'unknown_version'

export interface WorkspaceSaveOptions {
  storage?: WorkspaceStorageLike | null
  locks?: WorkspaceLockManager | null
  /** 调用方读到的当前 raw；未写过的键用 null。必须与提交时 fresh read 完全一致。 */
  expectedRaw: string | null
  /** 可选：调用方当前的完整工作区 canonical；用于检测输入在预览后被改动。 */
  expectedBaseCanonical?: string
}

export type WorkspaceSaveResult =
  | {
      ok: true
      status: 'saved'
      key: string
      record: WorkspaceRecordV1
      raw: string
      bytes: number
    }
  | { ok: false; reason: WorkspaceSaveFailureReason; message: string }

function saveFailure(
  reason: WorkspaceSaveFailureReason,
  message: string,
): { ok: false; reason: WorkspaceSaveFailureReason; message: string } {
  return { ok: false, reason, message }
}

function readFailureToSave(
  read: WorkspaceRecordRead,
): { ok: false; reason: WorkspaceSaveFailureReason; message: string } {
  switch (read.status) {
    case 'corrupt':
      return saveFailure('corrupt', read.message)
    case 'anomaly':
      return saveFailure('anomaly', read.message)
    case 'unknown_version':
      return saveFailure('unknown_version', read.message)
    case 'unavailable':
      return saveFailure('unavailable', read.message)
    default:
      return saveFailure('conflict', CONFLICT_MESSAGE)
  }
}

/**
 * 保存一条完整工作区记录。
 *
 * - revision 门是**合法单调不回退**：新 revision 必须 > 持久 revision 且自身是
 *   合法安全整数（多次内存 transition 后一次显式保存是合法路径，D4）；
 * - identity（workspace / owner / trip）、expectedRaw 逐字节、可选完整 base canonical
 *   三个门保持不变——防丢更新靠它们，不靠相邻计数；
 * - **同 payload 幂等**：新记录与持久记录字节完全一致 → 直接返回 saved（不重写、
 *   不推进 generation），保存后 UI 状态重放不会误报冲突；
 * - revision 倒退 / 同 revision 不同内容仍然拒绝；
 * - current 为 corrupt / anomaly / unknown_version 时拒绝，不用新数据覆盖。
 * - 一次 setItem；成功返回后才报告 saved。失败时旧字节不变。
 * - 不直接设置 Trip：唯一入口是完整记录。
 */
export async function saveWorkspaceRecord(
  record: WorkspaceRecordV1,
  options: WorkspaceSaveOptions,
): Promise<WorkspaceSaveResult> {
  if (options.expectedRaw !== null && typeof options.expectedRaw !== 'string') {
    return saveFailure('invalid', 'expectedRaw 必须是字符串或 null。')
  }
  if (options.expectedBaseCanonical !== undefined && typeof options.expectedBaseCanonical !== 'string') {
    return saveFailure('invalid', 'expectedBaseCanonical 必须是字符串。')
  }
  const prepared = prepareWorkspace(record)
  if (!prepared.ok) return saveFailure(prepared.reason, prepared.message)

  const store = resolveStorage(options.storage)
  if (!store) return saveFailure('unavailable', UNAVAILABLE_MESSAGE)

  const run = await runWorkspaceExclusive(options.locks, WORKSPACE_STORAGE_LOCK_NAME, async () => {
    const currentRaw = readRaw(store, WORKSPACE_STORAGE_KEY)
    if (!currentRaw.ok) {
      return saveFailure(currentRaw.reason, currentRaw.message)
    }
    if (currentRaw.raw !== options.expectedRaw) {
      return saveFailure('conflict', CONFLICT_MESSAGE)
    }
    const current = parseWorkspaceRaw(currentRaw.raw, currentRaw.bytes)
    if (current.status === 'empty') {
      if (options.expectedBaseCanonical !== undefined) {
        return saveFailure('conflict', CONFLICT_MESSAGE)
      }
    } else if (current.status === 'ok') {
      if (options.expectedBaseCanonical !== undefined) {
        const canonical = canonicalOf(current.record)
        if (canonical === null || canonical !== options.expectedBaseCanonical) {
          return saveFailure('conflict', CONFLICT_MESSAGE)
        }
      }
      if (
        prepared.record.workspaceId !== current.record.workspaceId ||
        prepared.record.ownerId !== current.record.ownerId ||
        prepared.record.tripId !== current.record.tripId
      ) {
        return saveFailure(
          'owner_conflict',
          '新记录更换了 workspace / owner / trip identity；工作区只允许在同一个行程上保存，请新建工作区。',
        )
      }
      if (prepared.record.workspaceRevision === current.record.workspaceRevision) {
        if (prepared.payload === currentRaw.raw) {
          // 同 payload 幂等：内容与持久字节完全一致，不重写、不推进 generation。
          return {
            ok: true as const,
            status: 'saved' as const,
            key: WORKSPACE_STORAGE_KEY,
            record: prepared.record,
            raw: prepared.payload,
            bytes: prepared.bytes,
          }
        }
        return saveFailure(
          'revision_conflict',
          `工作区 revision 与持久值相同（${current.record.workspaceRevision}）但内容不同；revision 必须单调递增，没有写入。`,
        )
      }
      if (
        !Number.isSafeInteger(prepared.record.workspaceRevision) ||
        prepared.record.workspaceRevision <= current.record.workspaceRevision
      ) {
        return saveFailure(
          'revision_conflict',
          `工作区 revision 不能回退（持久 ${current.record.workspaceRevision}，收到 ${prepared.record.workspaceRevision}）；没有写入。`,
        )
      }
      const revisionCheck = nextWorkspaceRevision(prepared.record.workspaceRevision - 1)
      if (!revisionCheck.ok || revisionCheck.value !== prepared.record.workspaceRevision) {
        return saveFailure(
          'revision_conflict',
          `工作区 revision 必须是合法安全整数（收到 ${prepared.record.workspaceRevision}）；没有写入。`,
        )
      }
    } else {
      return readFailureToSave(current)
    }

    const writeError = writeRaw(store, WORKSPACE_STORAGE_KEY, prepared.payload, '工作区记录')
    if (writeError) return writeError
    advanceGeneration(WORKSPACE_STORAGE_KEY)
    return {
      ok: true as const,
      status: 'saved' as const,
      key: WORKSPACE_STORAGE_KEY,
      record: prepared.record,
      raw: prepared.payload,
      bytes: prepared.bytes,
    }
  })

  if (!run.ok) return saveFailure(run.reason, run.message)
  return run.value
}

export interface LibrarySaveOptions {
  storage?: WorkspaceStorageLike | null
  locks?: WorkspaceLockManager | null
  expectedRaw: string | null
  expectedBaseCanonical?: string
}

export type LibrarySaveResult<T> =
  | {
      ok: true
      status: 'saved'
      key: string
      record: T
      raw: string
      bytes: number
    }
  | { ok: false; reason: WorkspaceSaveFailureReason; message: string }

export type CandidatesSaveResult = LibrarySaveResult<CandidatesRecordV1>
export type VersionsSaveResult = LibrarySaveResult<VersionsRecordV1>

export async function saveCandidatesRecord(
  record: CandidatesRecordV1,
  options: LibrarySaveOptions,
): Promise<CandidatesSaveResult> {
  if (options.expectedRaw !== null && typeof options.expectedRaw !== 'string') {
    return saveFailure('invalid', 'expectedRaw 必须是字符串或 null。')
  }
  const prepared = prepareCandidates(record)
  if (!prepared.ok) return saveFailure(prepared.reason, prepared.message)
  const store = resolveStorage(options.storage)
  if (!store) return saveFailure('unavailable', UNAVAILABLE_MESSAGE)

  const run = await runWorkspaceExclusive(options.locks, CANDIDATES_STORAGE_LOCK_NAME, async () => {
    const currentRaw = readRaw(store, CANDIDATES_STORAGE_KEY)
    if (!currentRaw.ok) return saveFailure(currentRaw.reason, currentRaw.message)
    if (currentRaw.raw !== options.expectedRaw) return saveFailure('conflict', CONFLICT_MESSAGE)
    const current = parseCandidatesRaw(currentRaw.raw, currentRaw.bytes)
    if (current.status === 'ok') {
      if (options.expectedBaseCanonical !== undefined) {
        const canonical = canonicalOf(current.record)
        if (canonical === null || canonical !== options.expectedBaseCanonical) {
          return saveFailure('conflict', CONFLICT_MESSAGE)
        }
      }
    } else if (current.status !== 'empty') {
      return saveFailure(
        current.status === 'unavailable' ? 'unavailable' : current.status,
        current.message,
      )
    } else if (options.expectedBaseCanonical !== undefined) {
      return saveFailure('conflict', CONFLICT_MESSAGE)
    }
    const writeError = writeRaw(store, CANDIDATES_STORAGE_KEY, prepared.payload, '候选库')
    if (writeError) return writeError
    advanceGeneration(CANDIDATES_STORAGE_KEY)
    return {
      ok: true as const,
      status: 'saved' as const,
      key: CANDIDATES_STORAGE_KEY,
      record: prepared.record,
      raw: prepared.payload,
      bytes: prepared.bytes,
    }
  })
  if (!run.ok) return saveFailure(run.reason, run.message)
  return run.value
}

export async function saveVersionsRecord(
  record: VersionsRecordV1,
  options: LibrarySaveOptions,
): Promise<VersionsSaveResult> {
  if (options.expectedRaw !== null && typeof options.expectedRaw !== 'string') {
    return saveFailure('invalid', 'expectedRaw 必须是字符串或 null。')
  }
  const prepared = prepareVersions(record)
  if (!prepared.ok) return saveFailure(prepared.reason, prepared.message)
  const store = resolveStorage(options.storage)
  if (!store) return saveFailure('unavailable', UNAVAILABLE_MESSAGE)

  const run = await runWorkspaceExclusive(options.locks, VERSIONS_STORAGE_LOCK_NAME, async () => {
    const currentRaw = readRaw(store, VERSIONS_STORAGE_KEY)
    if (!currentRaw.ok) return saveFailure(currentRaw.reason, currentRaw.message)
    if (currentRaw.raw !== options.expectedRaw) return saveFailure('conflict', CONFLICT_MESSAGE)
    const current = parseVersionsRaw(currentRaw.raw, currentRaw.bytes)
    if (current.status === 'ok') {
      if (options.expectedBaseCanonical !== undefined) {
        const canonical = canonicalOf(current.record)
        if (canonical === null || canonical !== options.expectedBaseCanonical) {
          return saveFailure('conflict', CONFLICT_MESSAGE)
        }
      }
    } else if (current.status !== 'empty') {
      return saveFailure(
        current.status === 'unavailable' ? 'unavailable' : current.status,
        current.message,
      )
    } else if (options.expectedBaseCanonical !== undefined) {
      return saveFailure('conflict', CONFLICT_MESSAGE)
    }
    const writeError = writeRaw(store, VERSIONS_STORAGE_KEY, prepared.payload, '版本库')
    if (writeError) return writeError
    advanceGeneration(VERSIONS_STORAGE_KEY)
    return {
      ok: true as const,
      status: 'saved' as const,
      key: VERSIONS_STORAGE_KEY,
      record: prepared.record,
      raw: prepared.payload,
      bytes: prepared.bytes,
    }
  })
  if (!run.ok) return saveFailure(run.reason, run.message)
  return run.value
}

/* ───────── 明确导入提交（单键 + 一次 undo） ───────── */

export interface StorageUndoHandle {
  readonly undoId: string
  readonly key: string
  readonly expiresAt: number
}

interface UndoState {
  key: string
  previousRaw: string | null
  writtenRaw: string
  writtenRevision: number | null
  expiresAt: number
  used: boolean
  /** 创建 undo 时该库的写代际；恢复前必须仍一致。 */
  generation: number
}

const undoStates = new Map<string, UndoState>()

function issueUndo(
  key: string,
  previousRaw: string | null,
  writtenRaw: string,
  writtenRevision: number | null,
  now: number,
  ttlMs: number,
): StorageUndoHandle {
  pruneUndoStates(now)
  let undoId = createLogicalId()
  while (undoStates.has(undoId)) undoId = createLogicalId()
  undoStates.set(undoId, {
    key,
    previousRaw,
    writtenRaw,
    writtenRevision,
    expiresAt: now + ttlMs,
    used: false,
    generation: currentGeneration(key),
  })
  return { undoId, key, expiresAt: now + ttlMs }
}

/** M2 内存卫生：清理已用 / 已过期的 undo 状态；进程内没有跨页引用，删了就是删了。 */
function pruneUndoStates(now: number): void {
  for (const [id, state] of undoStates) {
    if (state.used || now >= state.expiresAt) {
      undoStates.delete(id)
    }
  }
}

function resolveUndoTtl(ttlMs: number | undefined): number | null {
  if (ttlMs === undefined) return DEFAULT_UNDO_TTL_MS
  if (!isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_UNDO_TTL_MS) return null
  return ttlMs
}

export interface WorkspaceImportExpectation {
  expectedRaw: string | null
  expectedRecordCanonical: string
  expectedWorkspaceId: string | null
  expectedOwnerId: string | null
  expectedTripId: string | null
  expectedRevision: number | null
}

export interface ImportCommitOptions {
  storage?: WorkspaceStorageLike | null
  locks?: WorkspaceLockManager | null
  now: number
  undoTtlMs?: number
}

export type WorkspaceImportCommitResult =
  | {
      ok: true
      status: 'imported'
      record: WorkspaceRecordV1
      raw: string
      bytes: number
      previousRaw: string | null
      undo: StorageUndoHandle
    }
  | {
      ok: false
      reason: WorkspaceSaveFailureReason | 'input_changed' | 'import_superseded'
      message: string
    }

/**
 * 明确导入一条工作区记录：调用前必须已经完成预览与用户确认。
 * revision 使用当前值 +1（不恢复备份里的旧值）；空库首次恢复也从 1 开始。
 */
export async function commitWorkspaceImport(
  record: WorkspaceRecordV1,
  expectation: WorkspaceImportExpectation,
  options: ImportCommitOptions,
): Promise<WorkspaceImportCommitResult> {
  if (expectation.expectedRaw !== null && typeof expectation.expectedRaw !== 'string') {
    return { ok: false, reason: 'invalid', message: 'expectedRaw 必须是字符串或 null。' }
  }
  const ttl = resolveUndoTtl(options.undoTtlMs)
  if (ttl === null) {
    return { ok: false, reason: 'invalid', message: 'undo 有效期必须是 1 小时以内的正整数毫秒。' }
  }
  if (!isTimestamp(options.now)) {
    return { ok: false, reason: 'invalid', message: 'now 必须是非负安全整数。' }
  }
  const validated = validateWorkspaceRecord(record)
  if (!validated.ok) {
    return {
      ok: false,
      reason: validated.reason === 'limit_exceeded' ? 'too_large' : 'invalid',
      message: `导入记录未通过严格校验（${validated.path}）：${validated.message}`,
    }
  }
  const frozen = deepCloneJson(validated.value)
  const canonical = canonicalOf(frozen)
  if (canonical === null || canonical !== expectation.expectedRecordCanonical) {
    return { ok: false, reason: 'input_changed', message: INPUT_CHANGED_MESSAGE }
  }
  const store = resolveStorage(options.storage)
  if (!store) return { ok: false, reason: 'unavailable', message: UNAVAILABLE_MESSAGE }

  const generation = currentGeneration(WORKSPACE_STORAGE_KEY)
  const run = await runWorkspaceExclusive(options.locks, WORKSPACE_STORAGE_LOCK_NAME, async () => {
    const live = ensureLiveGeneration(WORKSPACE_STORAGE_KEY, generation)
    if (!live.ok) return live
    const currentRaw = readRaw(store, WORKSPACE_STORAGE_KEY)
    if (!currentRaw.ok) {
      return { ok: false as const, reason: currentRaw.reason, message: currentRaw.message }
    }
    if (currentRaw.raw !== expectation.expectedRaw) {
      return { ok: false as const, reason: 'conflict' as const, message: CONFLICT_MESSAGE }
    }
    const current = parseWorkspaceRaw(currentRaw.raw, currentRaw.bytes)
    if (current.status === 'ok') {
      if (
        current.record.workspaceId !== expectation.expectedWorkspaceId ||
        current.record.ownerId !== expectation.expectedOwnerId ||
        current.record.tripId !== expectation.expectedTripId ||
        current.record.workspaceRevision !== expectation.expectedRevision
      ) {
        return { ok: false as const, reason: 'conflict' as const, message: CONFLICT_MESSAGE }
      }
    } else if (current.status === 'empty') {
      if (
        expectation.expectedWorkspaceId !== null ||
        expectation.expectedOwnerId !== null ||
        expectation.expectedTripId !== null ||
        expectation.expectedRevision !== null
      ) {
        return { ok: false as const, reason: 'conflict' as const, message: CONFLICT_MESSAGE }
      }
    } else {
      const mapped = readFailureToSave(current)
      return { ok: false as const, reason: mapped.reason, message: mapped.message }
    }

    let nextRevision = frozen.workspaceRevision
    if (current.status === 'ok') {
      const next = nextWorkspaceRevision(current.record.workspaceRevision)
      if (!next.ok) {
        return { ok: false as const, reason: 'revision_conflict' as const, message: next.message }
      }
      nextRevision = next.value
    } else {
      // 空库恢复不回放备份里的旧 revision；从 1 开始，避免复用旧历史。
      nextRevision = 1
    }
    const nextRecord: WorkspaceRecordV1 = {
      ...frozen,
      workspaceRevision: nextRevision,
      updatedAt: options.now,
      meta: { createdAt: frozen.meta.createdAt, label: frozen.meta.label },
    }
    const nextPrepared = prepareWorkspace(nextRecord)
    if (!nextPrepared.ok) {
      return { ok: false as const, reason: nextPrepared.reason, message: nextPrepared.message }
    }
    const writeError = writeRaw(store, WORKSPACE_STORAGE_KEY, nextPrepared.payload, '工作区导入')
    if (writeError) return writeError
    advanceGeneration(WORKSPACE_STORAGE_KEY)
    const undo = issueUndo(
      WORKSPACE_STORAGE_KEY,
      currentRaw.raw,
      nextPrepared.payload,
      nextRecord.workspaceRevision,
      options.now,
      ttl,
    )
    return {
      ok: true as const,
      status: 'imported' as const,
      record: nextRecord,
      raw: nextPrepared.payload,
      bytes: nextPrepared.bytes,
      previousRaw: currentRaw.raw,
      undo,
    }
  })
  if (!run.ok) return { ok: false, reason: run.reason, message: run.message }
  return run.value
}

export interface LibraryImportExpectation {
  expectedRaw: string | null
  expectedRecordCanonical: string
}

export type LibraryImportCommitResult<T> =
  | {
      ok: true
      status: 'imported'
      key: string
      record: T
      raw: string
      bytes: number
      previousRaw: string | null
      undo: StorageUndoHandle
    }
  | {
      ok: false
      reason: WorkspaceSaveFailureReason | 'input_changed' | 'import_superseded'
      message: string
    }

export async function commitCandidatesImport(
  record: CandidatesRecordV1,
  expectation: LibraryImportExpectation,
  options: ImportCommitOptions,
): Promise<LibraryImportCommitResult<CandidatesRecordV1>> {
  return commitLibraryImport(
    record,
    expectation,
    options,
    CANDIDATES_STORAGE_KEY,
    CANDIDATES_STORAGE_LOCK_NAME,
    '候选库',
    prepareCandidates,
    parseCandidatesRaw,
  )
}

export async function commitVersionsImport(
  record: VersionsRecordV1,
  expectation: LibraryImportExpectation,
  options: ImportCommitOptions,
): Promise<LibraryImportCommitResult<VersionsRecordV1>> {
  return commitLibraryImport(
    record,
    expectation,
    options,
    VERSIONS_STORAGE_KEY,
    VERSIONS_STORAGE_LOCK_NAME,
    '版本库',
    prepareVersions,
    parseVersionsRaw,
  )
}

async function commitLibraryImport<T>(
  record: T,
  expectation: LibraryImportExpectation,
  options: ImportCommitOptions,
  key: string,
  lockName: string,
  label: string,
  prepare: (value: T) => PreparedLibrary<T> | PrepareFailure,
  parse: (raw: string | null, bytes: number) => StoreRead<T>,
): Promise<LibraryImportCommitResult<T>> {
  if (expectation.expectedRaw !== null && typeof expectation.expectedRaw !== 'string') {
    return { ok: false, reason: 'invalid', message: 'expectedRaw 必须是字符串或 null。' }
  }
  const ttl = resolveUndoTtl(options.undoTtlMs)
  if (ttl === null) {
    return { ok: false, reason: 'invalid', message: 'undo 有效期必须是 1 小时以内的正整数毫秒。' }
  }
  if (!isTimestamp(options.now)) {
    return { ok: false, reason: 'invalid', message: 'now 必须是非负安全整数。' }
  }
  const prepared = prepare(record)
  if (!prepared.ok) return { ok: false, reason: prepared.reason, message: prepared.message }
  const canonical = canonicalOf(prepared.record)
  if (canonical === null || canonical !== expectation.expectedRecordCanonical) {
    return { ok: false, reason: 'input_changed', message: INPUT_CHANGED_MESSAGE }
  }
  const store = resolveStorage(options.storage)
  if (!store) return { ok: false, reason: 'unavailable', message: UNAVAILABLE_MESSAGE }

  const generation = currentGeneration(key)
  const run = await runWorkspaceExclusive(options.locks, lockName, async () => {
    const live = ensureLiveGeneration(key, generation)
    if (!live.ok) return live
    const currentRaw = readRaw(store, key)
    if (!currentRaw.ok) {
      return { ok: false as const, reason: currentRaw.reason, message: currentRaw.message }
    }
    if (currentRaw.raw !== expectation.expectedRaw) {
      return { ok: false as const, reason: 'conflict' as const, message: CONFLICT_MESSAGE }
    }
    const current = parse(currentRaw.raw, currentRaw.bytes)
    if (current.status !== 'ok' && current.status !== 'empty') {
      return {
        ok: false as const,
        reason: current.status === 'unavailable' ? ('unavailable' as const) : current.status,
        message: current.message,
      }
    }
    const writeError = writeRaw(store, key, prepared.payload, label)
    if (writeError) return writeError
    advanceGeneration(key)
    const undo = issueUndo(key, currentRaw.raw, prepared.payload, null, options.now, ttl)
    return {
      ok: true as const,
      status: 'imported' as const,
      key,
      record: prepared.record,
      raw: prepared.payload,
      bytes: prepared.bytes,
      previousRaw: currentRaw.raw,
      undo,
    }
  })
  if (!run.ok) return { ok: false, reason: run.reason, message: run.message }
  return run.value
}

/* ───────── 一次 undo ───────── */

export type UndoFailureReason =
  | WorkspaceSaveFailureReason
  | 'undo_invalid'
  | 'undo_used'
  | 'undo_expired'
  | 'import_superseded'

export type UndoResult =
  | { ok: true; key: string; restoredRaw: string | null }
  | { ok: false; reason: UndoFailureReason; message: string }

function undoLockName(key: string): string {
  if (key === WORKSPACE_STORAGE_KEY) return WORKSPACE_STORAGE_LOCK_NAME
  if (key === CANDIDATES_STORAGE_KEY) return CANDIDATES_STORAGE_LOCK_NAME
  if (key === VERSIONS_STORAGE_KEY) return VERSIONS_STORAGE_LOCK_NAME
  return `${key}:lock`
}

export interface UndoOptions {
  storage?: WorkspaceStorageLike | null
  locks?: WorkspaceLockManager | null
  now: number
}

/**
 * 一次 undo：只接受当前 raw 仍等于 import 写入值的情况；否则拒绝。
 * 不覆盖其它 tab 的更新，也不重放旧 revision。
 */
export async function undoStorageCommit(
  handle: StorageUndoHandle,
  options: UndoOptions,
): Promise<UndoResult> {
  if (
    !isRecord(handle) ||
    typeof handle.undoId !== 'string' ||
    typeof handle.key !== 'string' ||
    !isTimestamp(handle.expiresAt)
  ) {
    return { ok: false, reason: 'undo_invalid', message: 'undo 句柄无效。' }
  }
  if (!isTimestamp(options.now)) {
    return { ok: false, reason: 'invalid', message: 'now 必须是非负安全整数。' }
  }
  const state = undoStates.get(handle.undoId)
  if (!state || state.key !== handle.key) {
    return { ok: false, reason: 'undo_invalid', message: 'undo 句柄不存在或与库不匹配。' }
  }
  if (state.used) return { ok: false, reason: 'undo_used', message: '这次导入已经撤销过一次。' }
  if (options.now >= state.expiresAt) {
    return { ok: false, reason: 'undo_expired', message: '撤销窗口已过期；原数据未被改动。' }
  }
  const store = resolveStorage(options.storage)
  if (!store) return { ok: false, reason: 'unavailable', message: UNAVAILABLE_MESSAGE }

  const run = await runWorkspaceExclusive(options.locks, undoLockName(state.key), async () => {
    // 撤销前核对写代际：import 之后若本页有过其它成功写入（或显式失效），
    // 即使 raw 被其它操作完整回退到旧值，这次 undo 也不再有效（防 ABA 复活）。
    const live = ensureLiveGeneration(state.key, state.generation)
    if (!live.ok) return live
    const currentRaw = readRaw(store, state.key)
    if (!currentRaw.ok) {
      return { ok: false as const, reason: currentRaw.reason, message: currentRaw.message }
    }
    if (currentRaw.raw !== state.writtenRaw) {
      return { ok: false as const, reason: 'conflict' as const, message: CONFLICT_MESSAGE }
    }
    if (state.writtenRevision !== null) {
      const current = parseWorkspaceRaw(currentRaw.raw, currentRaw.bytes)
      if (current.status !== 'ok' || current.record.workspaceRevision !== state.writtenRevision) {
        return { ok: false as const, reason: 'conflict' as const, message: CONFLICT_MESSAGE }
      }
    }
    const writeError =
      state.previousRaw === null
        ? removeRaw(store, state.key, '撤销')
        : writeRaw(store, state.key, state.previousRaw, '撤销')
    if (writeError) return writeError
    const restoredRaw = state.previousRaw
    state.used = true
    // 保留轻量 used 标记到下一次 issueUndo/prune：同一句柄重复 undo 返回 undo_used，
    // 但不再持有整份旧 raw（大对象随撤销完成释放）。
    state.previousRaw = null
    state.writtenRaw = ''
    state.writtenRevision = null
    advanceGeneration(state.key)
    return { ok: true as const, key: state.key, restoredRaw }
  })
  if (!run.ok) return { ok: false, reason: run.reason, message: run.message }
  return run.value
}

/** 语义别名：一次导入撤销。 */
export async function undoImport(
  handle: StorageUndoHandle,
  options: UndoOptions,
): Promise<UndoResult> {
  return undoStorageCommit(handle, options)
}

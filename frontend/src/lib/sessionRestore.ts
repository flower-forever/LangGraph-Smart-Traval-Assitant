/**
 * 本机工作进度留存（opt-in 会话恢复）：独立 localStorage 键 + 有界自动写入。
 *
 * 设计边界（与 SESSION_RESUME 设计及协调者约束一致）：
 * - 默认关闭：只有独立 flag 键的值恰为 '1' 才算启用；未启用时数据键不读不写，
 *   正式 savedTrips 永不由本模块触碰。
 * - flag 与数据键独立带版本；关闭只停写，不删数据（删除走显式 removeSessionResumeData）。
 * - 单记录 envelope：{ format, version, savedAt, session }，session 为纯数据投影
 *   （Trip、未应用草稿 editedDays + fork/mode、费用原字符串 + binding、activeDay/draftMode）。
 * - 写门禁：整包 UTF-8 ≤ 1.5 MiB；Trip 单记录口径复用 savedTrips 的 640 KiB 规则。
 *   超限 / quota / SecurityError / 写前重读与 expectedRaw 不同 → typed 失败、保旧停写。
 * - 读协议：体积超读限或坏 JSON → corrupt；format/version 不符 → unknown_version；
 *   顶层未知键、缺 trip、任一块结构异常 → invalid（原子拒绝，不部分读取）。
 *   读取永不修改存储：损坏原始数据原样保留，等待用户显式删除或后续修复。
 * - 草稿重建走 createTripDraft + 既有校验：editedDays 天号唯一且 ∈ base 天集，
 *   组合投影 checkTripShape({...trip, days}) 复用现有规则；changedDays 由
 *   draftChangedDays 对 base 重导，不信任持久元数据；history 不留存。
 * - 费用 binding 是写快照时的本机一致性自述：current 仅由 budgetOwnerMatches 生成；
 *   stale（含 tripId/tripTitle）与 unbound 只作展示与重绑路径选择，不防篡改。
 *   恢复时 current 必须与当前 Trip id 一致且快照可验证才按新 revision 重绑；
 *   stale 用 revision=-1 + 固定哨兵快照重建 owner，必然失配，沿用/新建前保持只读。
 * - 跨标签：本模块不监听 storage 事件；调用方冻结 expectedRaw 传入，写前重读比对。
 */
import type { TravelMode, Trip, TripDay } from './api'
import { checkTripShape, savedTripRecordBytes, utf8ByteLength, type StorageLike } from './savedTrips'
import type { BudgetCategoryId, BudgetSessionState, BudgetTripContext } from './tripBudget'
import {
  budgetOwnerMatches,
  emptyBudgetSession,
  tripOwnerSnapshot,
} from './tripBudget'
import { createTripDraft, draftChangedDays, type TripDraft } from './tripDraft'

/* ───────── 常量与类型 ───────── */

export const SESSION_RESUME_FLAG_KEY = 'travel-assistant:session-resume:enabled:v1'
export const SESSION_RESUME_DATA_KEY = 'travel-assistant:session-resume:data:v1'
export const SESSION_RESUME_FORMAT = 'travel-assistant.session-resume'
export const SESSION_RESUME_VERSION = 1 as const

/** 整包写上限（1.5 MiB）；读上限再加 64 KiB，与 savedTrips 的口径一致 */
export const MAX_SESSION_RESUME_BYTES = 1_572_864
export const MAX_SESSION_RESUME_RAW_BYTES = MAX_SESSION_RESUME_BYTES + 64 * 1024

/** Trip 部分复用本地保存的单份口径（640 KiB，id + savedAt + trip） */
export const MAX_SESSION_TRIP_BYTES = 640 * 1024

/** 费用行上限与合法分类，与 tripBudget 一致 */
const MAX_BUDGET_ROWS = 32

/** stale 重建 owner 的哨兵快照：不以 '{' 开头，任何真实序列化串都不可能等于它 */
const STALE_OWNER_SENTINEL = '\u0000session-resume:stale\u0000'

export interface SessionResumeDraftPayload {
  readonly forkTripId: string
  readonly newLegMode: TravelMode
  /** 有未应用内容差异的天（保存时投影；重建后仍以 draftChangedDays 重导为准） */
  readonly editedDays: readonly { readonly day: number; readonly days: Trip['days'] }[]
}

export interface SessionResumeBudgetCurrent {
  readonly kind: 'current'
  readonly tripId: string
}

export interface SessionResumeBudgetStale {
  readonly kind: 'stale'
  /** 自述：仅展示，不能当真来源认证 */
  readonly tripId: string
  readonly tripTitle: string
}

export interface SessionResumeBudgetUnbound {
  readonly kind: 'unbound'
}

export type SessionResumeBudgetBinding =
  | SessionResumeBudgetCurrent
  | SessionResumeBudgetStale
  | SessionResumeBudgetUnbound

export interface SessionResumeBudgetBlock {
  readonly binding: SessionResumeBudgetBinding
  readonly budgetRaw: string
  readonly rows: readonly {
    readonly id: string
    readonly category: BudgetCategoryId
    readonly name: string
    readonly amountRaw: string
  }[]
}

export interface SessionResumeUiState {
  readonly activeDay: number
  readonly draftMode: TravelMode
  /**
   * 来源标记：true = 来自用户选择的备份文件；false = 明确的页面内生成/恢复来源；
   * null = 旧记录缺字段或本来就未知。三态必须原样贯穿再次留存，不能把未知降成
   * false 冒充“已确认非文件”。
   */
  readonly openedFromFile: boolean | null
}

/** 读取产物里的 ui：openedFromFile 为 null 表示旧记录没有该字段（来源未知） */
export interface SessionResumeUiLoaded {
  readonly activeDay: number
  readonly draftMode: TravelMode
  readonly openedFromFile: boolean | null
}

export interface SessionResumePayload {
  readonly trip: Trip
  readonly draft: SessionResumeDraftPayload | null
  readonly budget: SessionResumeBudgetBlock | null
  readonly ui: SessionResumeUiState
}

export interface SessionResumeRecord {
  readonly savedAt: number
  readonly session: {
    readonly trip: Trip
    readonly draft: SessionResumeDraftPayload | null
    readonly budget: SessionResumeBudgetBlock | null
    readonly ui: SessionResumeUiLoaded
  }
}

export type SessionResumeLoadStatus =
  | 'disabled'
  | 'empty'
  | 'pending'
  | 'corrupt'
  | 'unknown_version'
  | 'invalid'
  | 'unavailable'

export type SessionResumeLoad =
  /** raw 是本次解析实际读到的字符串，必须作为该 pending 的冻结写基准 */
  | { status: 'pending'; record: SessionResumeRecord; raw: string }
  /** empty 同样带上这次实际读到的 raw（null/空串/空白），避免调用方再读一次换基准 */
  | { status: 'empty'; raw: string | null }
  | { status: 'disabled' }
  | { status: 'corrupt' | 'unknown_version' | 'invalid' | 'unavailable'; message: string }

export type SessionWriteFailureReason =
  | 'quota'
  | 'unavailable'
  | 'unknown'
  | 'too_large'
  | 'conflict'
  | 'snapshot_failed'

export type SessionWriteResult =
  | { ok: true; bytes: number; savedAt: number; writtenRaw: string }
  | { ok: false; reason: SessionWriteFailureReason; message: string }

export type SessionFlagResult =
  | { ok: true }
  | { ok: false; reason: 'quota' | 'unavailable' | 'unknown'; message: string }

export type SessionRemoveResult =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'unknown'; message: string }

/** 取得可用的 localStorage；SSR / 测试无 window 时返回 null，异常视为不可用 */
export function getLocalStorageSafe(): StorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/* ───────── 工具 ───────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainString(value: unknown): value is string {
  return typeof value === 'string'
}

function isTravelMode(value: unknown): value is TravelMode {
  return value === 'walking' || value === 'driving'
}

function isSecurityError(error: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'SecurityError'
  )
}

function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    )
  }
  return (
    error instanceof Error &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  )
}

function writeFailureMessage(reason: SessionWriteFailureReason): string {
  switch (reason) {
    case 'quota':
      return '浏览器本地存储已满，工作进度留存已暂停；已有副本保持原样。请清理站点数据或删除恢复副本后重试。'
    case 'unavailable':
      return '浏览器拒绝写入本地存储（可能是隐私模式或站点数据被禁用），工作进度留存已暂停。'
    case 'too_large':
      return '当前工作进度序列化后超过本机留存的体积上限，这次没有写入；已有副本保持原样，当前页面不受影响。'
    case 'conflict':
      return '检测到另一个标签页更新了留存副本，本标签页已暂停自动留存以避免覆盖。可在确认后重新读取或接管。'
    case 'snapshot_failed':
      return '当前行程内容无法序列化，无法生成本机留存快照；留存已暂停，页面不受影响。'
    default:
      return '写入本地存储失败，工作进度留存已暂停；已有副本保持原样。'
  }
}

/* ───────── flag ───────── */

export function readSessionResumeFlag(storage: StorageLike | null): { enabled: boolean } {
  if (!storage) return { enabled: false }
  try {
    return { enabled: storage.getItem(SESSION_RESUME_FLAG_KEY) === '1' }
  } catch {
    return { enabled: false }
  }
}

export function isSessionResumeEnabled(storage: StorageLike | null): boolean {
  return readSessionResumeFlag(storage).enabled
}

export function setSessionResumeFlag(storage: StorageLike | null, enabled: boolean): SessionFlagResult {
  if (!storage) {
    return { ok: false, reason: 'unavailable', message: '当前环境没有可用的本地存储，无法更改留存设置。' }
  }
  try {
    storage.setItem(SESSION_RESUME_FLAG_KEY, enabled ? '1' : '0')
    return { ok: true }
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, reason: 'quota', message: writeFailureMessage('quota') }
    if (isSecurityError(error)) {
      return { ok: false, reason: 'unavailable', message: writeFailureMessage('unavailable') }
    }
    return { ok: false, reason: 'unknown', message: writeFailureMessage('unknown') }
  }
}

/** 关闭：移除 flag（回到「从未启用」语义），数据键与正式保存完全不动 */
export function clearSessionResumeFlag(storage: StorageLike | null): SessionFlagResult {
  if (!storage) {
    return { ok: false, reason: 'unavailable', message: '当前环境没有可用的本地存储，无法更改留存设置。' }
  }
  try {
    storage.removeItem(SESSION_RESUME_FLAG_KEY)
    return { ok: true }
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, reason: 'quota', message: writeFailureMessage('quota') }
    if (isSecurityError(error)) {
      return { ok: false, reason: 'unavailable', message: writeFailureMessage('unavailable') }
    }
    return { ok: false, reason: 'unknown', message: writeFailureMessage('unknown') }
  }
}

/* ───────── 序列化与投影 ───────── */

export interface SessionSnapshotInput {
  readonly trip: Trip
  readonly draft: TripDraft | null
  readonly budget: BudgetSessionState
  readonly ui: SessionResumeUiState
  /** 当前行程版本号；费用 current 判定依赖它 */
  readonly tripRevision: number
  /** tripOwnerSnapshot 的结果；null 表示当前 Trip 无法验证（如序列化失败） */
  readonly tripSnapshot?: string | null
}

/**
 * 把 App 会话投影成可持久化的纯数据块。
 * fail-closed：任一部分无法自证（快照不可验证且费用有 owner）→ 返回 null，
 * 调用方必须停写，绝不允许静默丢块落盘。
 * - draft：只留真正有内容差异的天 + fork/mode；无差异时投影为 null（这是合法空值，不是丢块）；
 * - budget：owner=null 仅空内容可投影为 unbound；有内容却无 owner 属协议矛盾，
 *   整次投影失败（返回 null，不静默丢块）；owner 非空但快照不可验证 → 同样失败；
 * - 金额原字符串（含坏值/0/空）原样保留，不解析、不拒写。
 */
export function buildPayloadFromSession(input: SessionSnapshotInput): SessionResumePayload | null {
  // Trip 与读端同尺：这里的 trip 来自 App 内存状态，但直接调用方可能传入任意对象。
  // 写出读端 checkTripShape 必拒的行程只会产出一份下次读取就 invalid 的副本，
  // 所以投影前先拒绝；调用方按既有 fail-closed 合同停写。
  if (!checkTripShape(input.trip).ok) return null
  const snapshotResult = tripOwnerSnapshot(input.trip)
  const snapshot = input.tripSnapshot !== undefined ? input.tripSnapshot : snapshotResult.ok ? snapshotResult.value : null

  // draft 投影：只导真正有内容差异的天
  let draftBlock: SessionResumeDraftPayload | null = null
  if (input.draft) {
    const changedDays = draftChangedDays(input.draft)
    if (changedDays.length > 0) {
      draftBlock = {
        forkTripId: input.draft.forkTripId,
        newLegMode: input.draft.newLegMode,
        editedDays: changedDays.map((dayNumber) => {
          const day = input.draft!.days.find((d) => d.day === dayNumber)
          return { day: dayNumber, days: day ? [day] : [] }
        }),
      }
    }
  }

  // budget 投影：owner 非空而快照不可验证 → 整次投影失败，不静默丢块
  let budgetBlock: SessionResumeBudgetBlock | null
  const session = input.budget
  if (session.owner === null) {
    // 未绑定且内容为空才是合法 unbound；有内容却无 owner 是协议矛盾，
    // 整次投影失败（不静默丢费用块，也不写出读端必然拒绝的副本）。
    if (session.budgetRaw !== '' || session.rows.length > 0) return null
    budgetBlock = { binding: { kind: 'unbound' }, budgetRaw: '', rows: [] }
  } else if (snapshot === null) {
    return null
  } else {
    const ctx: BudgetTripContext = {
      tripId: input.trip.id,
      revision: input.tripRevision,
      snapshot,
      tripTitle: input.trip.title,
    }
    const current = budgetOwnerMatches(session.owner, ctx)
    budgetBlock = {
      binding: current
        ? { kind: 'current', tripId: session.owner.tripId }
        : { kind: 'stale', tripId: session.owner.tripId, tripTitle: session.owner.tripTitle },
      budgetRaw: session.budgetRaw,
      rows: [...session.rows],
    }
  }

  return { trip: input.trip, draft: draftBlock, budget: budgetBlock, ui: input.ui }
}

/* ───────── 写入 ───────── */

export interface SessionWriteInput {
  readonly payload: SessionResumePayload
  /** 冻结的存储现值（上次读取/写入的 raw）；null 表示存储应为空 */
  readonly expectedRaw: string | null
}

/**
 * 有界自动留存写入。门禁顺序：
 * 1. 整包可序列化（失败 → snapshot_failed）；
 * 2. 整包 ≤ 1.5 MiB；
 * 3. Trip 单记录 ≤ 640 KiB（复用 savedTrips 口径）；
 * 4. 实际写出的 Trip 通过 checkTripShape（与读端同尺；序列化副作用如 toJSON
 *    改变了结构也在这里拒绝 → snapshot_failed，避免落下一份读端必拒的副本。
 *    排在体积门禁之后：超限行程维持既有 too_large 分类，不因结构同时非法而改判）；
 * 5. 写前重读与 expectedRaw 严格相等（不同 → conflict，保旧）；
 * 6. setItem，quota/SecurityError → typed 失败。
 * 任一步失败存储原样，调用方应停写。
 */
export function writeSessionResume(
  input: SessionWriteInput,
  storage: StorageLike | null,
): SessionWriteResult {
  if (!storage) {
    return { ok: false, reason: 'unavailable', message: writeFailureMessage('unavailable') }
  }

  let json: string
  try {
    json = JSON.stringify({
      format: SESSION_RESUME_FORMAT,
      version: SESSION_RESUME_VERSION,
      savedAt: Date.now(),
      session: input.payload,
    })
  } catch {
    return { ok: false, reason: 'snapshot_failed', message: writeFailureMessage('snapshot_failed') }
  }

  const bytes = utf8ByteLength(json)
  if (bytes > MAX_SESSION_RESUME_BYTES) {
    return { ok: false, reason: 'too_large', message: writeFailureMessage('too_large') }
  }

  // Trip 部分沿用本地保存的单份口径（与 640 KiB 规则同源，避免同一 Trip 能保存却不能留存）
  const tripBytes = savedTripRecordBytes(input.payload.trip)
  if (tripBytes > MAX_SESSION_TRIP_BYTES) {
    return { ok: false, reason: 'too_large', message: writeFailureMessage('too_large') }
  }

  // 同尺校验按「实际写出的字节」做：序列化（含 toJSON）可能改变 Trip 结构，
  // 内存形状合法不等于写出的形状合法。读端对 session.trip 用的是同一把尺子。
  let writtenTrip: unknown
  try {
    writtenTrip = (JSON.parse(json) as { session: { trip: unknown } }).session.trip
  } catch {
    // json 来自刚成功的 JSON.stringify，必然可解析；这里兜底与 snapshot_failed 同类
    return { ok: false, reason: 'snapshot_failed', message: writeFailureMessage('snapshot_failed') }
  }
  if (!checkTripShape(writtenTrip).ok) {
    return { ok: false, reason: 'snapshot_failed', message: writeFailureMessage('snapshot_failed') }
  }

  let current: string | null
  try {
    current = storage.getItem(SESSION_RESUME_DATA_KEY)
  } catch (error) {
    if (isSecurityError(error)) return { ok: false, reason: 'unavailable', message: writeFailureMessage('unavailable') }
    return { ok: false, reason: 'unknown', message: writeFailureMessage('unknown') }
  }
  if (current !== input.expectedRaw) {
    return { ok: false, reason: 'conflict', message: writeFailureMessage('conflict') }
  }

  try {
    storage.setItem(SESSION_RESUME_DATA_KEY, json)
    // 不做裸二次 getItem：成功路径直接把刚写入的串当作新基准（异常安全）
    return { ok: true, bytes, savedAt: Date.now(), writtenRaw: json }
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, reason: 'quota', message: writeFailureMessage('quota') }
    if (isSecurityError(error)) return { ok: false, reason: 'unavailable', message: writeFailureMessage('unavailable') }
    return { ok: false, reason: 'unknown', message: writeFailureMessage('unknown') }
  }
}

/* ───────── 读取 ───────── */

/**
 * 读取留存记录。只在 flag 开启时读数据键；任何失败都保旧：
 * 返回 corrupt/unknown_version/invalid 时存储原样，等待用户显式删除或接管。
 */
export function loadSessionResumeRecord(storage: StorageLike | null): SessionResumeLoad {
  if (!storage) {
    return { status: 'unavailable', message: '当前环境没有可用的本地存储，无法读取留存副本。' }
  }
  let enabled: boolean
  try {
    enabled = storage.getItem(SESSION_RESUME_FLAG_KEY) === '1'
  } catch {
    return { status: 'unavailable', message: '读取留存设置失败，留存副本暂不读取。' }
  }
  if (!enabled) return { status: 'disabled' }

  let raw: string | null
  try {
    raw = storage.getItem(SESSION_RESUME_DATA_KEY)
  } catch (error) {
    if (isSecurityError(error)) {
      return { status: 'unavailable', message: '浏览器拒绝读取本地存储，留存副本暂不可用。' }
    }
    return { status: 'unavailable', message: '读取留存副本失败，存储原样保留。' }
  }
  if (raw === null || raw.trim() === '') return { status: 'empty', raw }
  if (utf8ByteLength(raw) > MAX_SESSION_RESUME_RAW_BYTES) {
    return { status: 'corrupt', message: '留存副本体积异常，已停止读取；原始数据保留，等待显式删除或修复。' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'corrupt', message: '留存副本不是合法 JSON，可能已损坏；原始数据保留，等待显式删除或修复。' }
  }
  if (!isRecord(parsed)) {
    return { status: 'corrupt', message: '留存副本结构异常；原始数据保留，等待显式删除或修复。' }
  }
  const { format, version, savedAt, session } = parsed
  if (format !== SESSION_RESUME_FORMAT) {
    return { status: 'unknown_version', message: '留存副本的格式标识不受支持；原始数据保留。' }
  }
  if (version !== SESSION_RESUME_VERSION) {
    return { status: 'unknown_version', message: '留存副本的结构版本不受支持；原始数据保留。' }
  }
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt <= 0) {
    return { status: 'invalid', message: '留存副本的保存时间无效；原始数据保留。' }
  }
  // 顶层只认四个声明键：未知键一律 invalid（原子拒绝），不部分读取
  for (const key of Object.keys(parsed)) {
    if (key !== 'format' && key !== 'version' && key !== 'savedAt' && key !== 'session') {
      return { status: 'invalid', message: '留存副本包含未声明的字段，已按协议拒绝；原始数据保留。' }
    }
  }
  if (!isRecord(session)) {
    return { status: 'invalid', message: '留存副本缺少会话数据；原始数据保留。' }
  }

  const built = buildSessionFromStored(session)
  if (!built.ok) {
    return { status: 'invalid', message: built.message }
  }

  return {
    status: 'pending',
    record: {
      savedAt,
      session: {
        trip: built.trip,
        draft: built.draft,
        budget: built.budget,
        ui: built.ui,
      },
    },
    raw,
  }
}

/* ───────── 存储块校验（load 专用） ───────── */

type SessionBuildResult =
  | {
      ok: true
      trip: Trip
      draft: SessionResumeDraftPayload | null
      budget: SessionResumeBudgetBlock | null
      ui: SessionResumeUiLoaded
    }
  | { ok: false; message: string }

const INVALID_TRIP_MESSAGE = '留存副本里的行程结构没有通过本地校验；原始数据保留，等待显式删除或修复。'
const INVALID_DRAFT_MESSAGE = '留存副本里的草稿块结构异常；原始数据保留，等待显式删除或修复。'
const INVALID_BUDGET_MESSAGE = '留存副本里的费用块结构异常；原始数据保留，等待显式删除或修复。'
const INVALID_UI_MESSAGE = '留存副本里的界面状态异常；原始数据保留，等待显式删除或修复。'

function isValidCategoryId(value: unknown): value is BudgetCategoryId {
  return (
    value === 'transport' || value === 'stay' || value === 'food' || value === 'ticket' || value === 'other'
  )
}

function buildSessionFromStored(session: Record<string, unknown>): SessionBuildResult {
  // trip：复用 checkTripShape（与本地保存/导入同一套结构约束，兼容宽字段）
  if (!checkTripShape(session.trip).ok) {
    return { ok: false, message: INVALID_TRIP_MESSAGE }
  }
  const trip = session.trip as Trip

  // 顶层只认四个声明键
  for (const key of Object.keys(session)) {
    if (key !== 'trip' && key !== 'draft' && key !== 'budget' && key !== 'ui') {
      return { ok: false, message: '留存副本的会话数据包含未声明字段；原始数据保留。' }
    }
  }

  // draft 块
  let draft: SessionResumeDraftPayload | null = null
  if (session.draft !== null) {
    if (!isRecord(session.draft)) return { ok: false, message: INVALID_DRAFT_MESSAGE }
    const d = session.draft
    for (const key of Object.keys(d)) {
      if (key !== 'forkTripId' && key !== 'newLegMode' && key !== 'editedDays') {
        return { ok: false, message: INVALID_DRAFT_MESSAGE }
      }
      void key
    }
    if (!isPlainString(d.forkTripId) || d.forkTripId.length === 0 || d.forkTripId.length > 100) {
      return { ok: false, message: INVALID_DRAFT_MESSAGE }
    }
    if (d.forkTripId === trip.id) return { ok: false, message: INVALID_DRAFT_MESSAGE }
    if (!isTravelMode(d.newLegMode)) return { ok: false, message: INVALID_DRAFT_MESSAGE }
    if (!Array.isArray(d.editedDays)) return { ok: false, message: INVALID_DRAFT_MESSAGE }
    const seenDays = new Set<number>()
    const editedDays: { day: number; days: Trip['days'] }[] = []
    for (const entry of d.editedDays) {
      if (!isRecord(entry)) return { ok: false, message: INVALID_DRAFT_MESSAGE }
      for (const key of Object.keys(entry)) {
        if (key !== 'day' && key !== 'days') return { ok: false, message: INVALID_DRAFT_MESSAGE }
      }
      if (typeof entry.day !== 'number' || !Number.isSafeInteger(entry.day)) {
        return { ok: false, message: INVALID_DRAFT_MESSAGE }
      }
      if (seenDays.has(entry.day)) return { ok: false, message: INVALID_DRAFT_MESSAGE }
      seenDays.add(entry.day)
      // 每天必须恰有一个整天块，且内层天号与声明天号一致；空数组/多天/错天号都是结构损坏
      if (!Array.isArray(entry.days) || entry.days.length !== 1) {
        return { ok: false, message: INVALID_DRAFT_MESSAGE }
      }
      const editedDay = entry.days[0]
      if (!isRecord(editedDay) || editedDay.day !== entry.day) {
        return { ok: false, message: INVALID_DRAFT_MESSAGE }
      }
      // editedDay 天号必须属于 base 天集合（在下方统一检查；这里先收集）
      editedDays.push({ day: entry.day, days: entry.days as Trip['days'] })
    }
    // 天号 ∈ base 天集合
    const baseDayNumbers = new Set(trip.days.map((day) => day.day))
    for (const entry of editedDays) {
      if (!baseDayNumbers.has(entry.day)) return { ok: false, message: INVALID_DRAFT_MESSAGE }
    }
    // 组合投影复用 checkTripShape：editedDay 内容 + base 其余天，同一套规则
    const combinedDays = trip.days.map((baseDay) => {
      const replacement = editedDays.find((entry) => entry.day === baseDay.day)
      return replacement ? replacement.days[0] : baseDay
    })
    if (checkTripShape({ ...trip, days: combinedDays }).ok === false) {
      return { ok: false, message: INVALID_DRAFT_MESSAGE }
    }
    draft = { forkTripId: d.forkTripId, newLegMode: d.newLegMode, editedDays }
  }

  // budget 块
  let budget: SessionResumeBudgetBlock | null = null
  if (session.budget !== null) {
    if (!isRecord(session.budget)) return { ok: false, message: INVALID_BUDGET_MESSAGE }
    const b = session.budget
    for (const key of Object.keys(b)) {
      if (key !== 'binding' && key !== 'budgetRaw' && key !== 'rows') {
        return { ok: false, message: INVALID_BUDGET_MESSAGE }
      }
    }
    if (!isPlainString(b.budgetRaw)) return { ok: false, message: INVALID_BUDGET_MESSAGE }
    if (!Array.isArray(b.rows)) return { ok: false, message: INVALID_BUDGET_MESSAGE }
    if (b.rows.length > MAX_BUDGET_ROWS) return { ok: false, message: INVALID_BUDGET_MESSAGE }
    const seenRowIds = new Set<string>()
    const rows: { id: string; category: BudgetCategoryId; name: string; amountRaw: string }[] = []
    for (const row of b.rows) {
      if (!isRecord(row)) return { ok: false, message: INVALID_BUDGET_MESSAGE }
      for (const key of Object.keys(row)) {
        if (key !== 'id' && key !== 'category' && key !== 'name' && key !== 'amountRaw') {
          return { ok: false, message: INVALID_BUDGET_MESSAGE }
        }
      }
      if (!isPlainString(row.id) || row.id === '') return { ok: false, message: INVALID_BUDGET_MESSAGE }
      if (seenRowIds.has(row.id)) return { ok: false, message: INVALID_BUDGET_MESSAGE }
      seenRowIds.add(row.id)
      if (!isValidCategoryId(row.category)) return { ok: false, message: INVALID_BUDGET_MESSAGE }
      if (!isPlainString(row.name) || !isPlainString(row.amountRaw)) {
        return { ok: false, message: INVALID_BUDGET_MESSAGE }
      }
      rows.push({ id: row.id, category: row.category, name: row.name, amountRaw: row.amountRaw })
    }
    const binding = b.binding
    if (!isRecord(binding)) return { ok: false, message: INVALID_BUDGET_MESSAGE }
    const bindingKeys = Object.keys(binding)
    if (binding.kind === 'current') {
      if (bindingKeys.length !== 2 || !isPlainString(binding.tripId) || binding.tripId === '') {
        return { ok: false, message: INVALID_BUDGET_MESSAGE }
      }
      // current 自述必须与同一快照里的行程一致；指向别的行程是协议矛盾，原子拒绝
      if (binding.tripId !== trip.id) return { ok: false, message: INVALID_BUDGET_MESSAGE }
      budget = { binding: { kind: 'current', tripId: binding.tripId }, budgetRaw: b.budgetRaw, rows }
    } else if (binding.kind === 'stale') {
      if (
        bindingKeys.length !== 3 ||
        !isPlainString(binding.tripId) ||
        binding.tripId === '' ||
        !isPlainString(binding.tripTitle)
      ) {
        return { ok: false, message: INVALID_BUDGET_MESSAGE }
      }
      budget = {
        binding: { kind: 'stale', tripId: binding.tripId, tripTitle: binding.tripTitle },
        budgetRaw: b.budgetRaw,
        rows,
      }
    } else if (binding.kind === 'unbound') {
      if (bindingKeys.length !== 1) return { ok: false, message: INVALID_BUDGET_MESSAGE }
      // owner=null 但内容非空是不一致结构：原子拒绝，不静默丢
      if (b.budgetRaw !== '' || rows.length > 0) return { ok: false, message: INVALID_BUDGET_MESSAGE }
      budget = { binding: { kind: 'unbound' }, budgetRaw: '', rows: [] }
    } else {
      return { ok: false, message: INVALID_BUDGET_MESSAGE }
    }
  }

  // ui 块
  if (!isRecord(session.ui)) return { ok: false, message: INVALID_UI_MESSAGE }
  const ui = session.ui
  for (const key of Object.keys(ui)) {
    if (key !== 'activeDay' && key !== 'draftMode' && key !== 'openedFromFile') {
      return { ok: false, message: INVALID_UI_MESSAGE }
    }
  }
  if (typeof ui.activeDay !== 'number' || !Number.isSafeInteger(ui.activeDay) || ui.activeDay < 1) {
    return { ok: false, message: INVALID_UI_MESSAGE }
  }
  if (!isTravelMode(ui.draftMode)) return { ok: false, message: INVALID_UI_MESSAGE }
  // openedFromFile：三态。缺字段/null 是旧记录（来源未知），布尔按原值保留；
  // 再次留存必须继续写回 null，不能把未知降成 false。其它类型拒绝。
  let openedFromFile: boolean | null = null
  if (ui.openedFromFile === undefined || ui.openedFromFile === null) {
    openedFromFile = null
  } else if (typeof ui.openedFromFile === 'boolean') {
    openedFromFile = ui.openedFromFile
  } else {
    return { ok: false, message: INVALID_UI_MESSAGE }
  }

  return {
    ok: true,
    trip,
    draft,
    budget,
    ui: { activeDay: ui.activeDay, draftMode: ui.draftMode, openedFromFile },
  }
}

/* ───────── 恢复重建 ───────── */

export type DraftRebuildResult =
  | { ok: true; draft: TripDraft }
  | { ok: false; reason: 'invalid_draft'; message: string }

/**
 * 从留存块重建内存草稿：走 createTripDraft（fork/mode 既有校验），把通过校验的
 * editedDay 替换进 pristine 副本；changedDays 由 draftChangedDays 对 base 重导，
 * 不信任持久元数据；history 不留存（undo 自然 no-op）。
 * 传 null 表示无草稿可重建，返回 ok:true 且 draft 为 null。
 */
export function rebuildDraftFromTrip(
  session: SessionResumePayload | SessionResumeRecord['session'],
): { ok: true; draft: TripDraft | null } | { ok: false; message: string } {
  if (session.draft === null) return { ok: true, draft: null }
  // 组合投影：编辑天用留存块替换 base 对应天，再走 createTripDraft——
  // 它内部先 checkTripShape（组合尺），再克隆出与 cloneEditableDays 同构的
  // 可编辑结构副本（day/stops/legs/location 独立，geometry 与坐标点只读共享），
  // 未编辑天因此不再复用 session.trip.days 的原对象。
  const combinedDays: TripDay[] = session.trip.days.map((baseDay) => {
    const replacement = session.draft!.editedDays.find((entry) => entry.day === baseDay.day)
    return replacement ? replacement.days[0] : baseDay
  })
  const combinedTrip: Trip = { ...session.trip, days: combinedDays }
  const created = createTripDraft(combinedTrip, {
    forkTripId: session.draft.forkTripId,
    newLegMode: session.draft.newLegMode,
  })
  if (!created.ok) {
    return { ok: false, message: '留存草稿无法基于当前行程重建；原始数据保留。' }
  }
  // 直接调用本函数时也守住同一协议：每天唯一且属于 base，整天块恰好一个且天号一致
  const baseDayNumbers = new Set(session.trip.days.map((day) => day.day))
  const seenDays = new Set<number>()
  for (const entry of session.draft.editedDays) {
    const editedDay = entry.days[0]
    if (
      !baseDayNumbers.has(entry.day) ||
      seenDays.has(entry.day) ||
      entry.days.length !== 1 ||
      !editedDay ||
      editedDay.day !== entry.day
    ) {
      return { ok: false, message: '留存草稿的天结构异常，未执行恢复；原始数据保留。' }
    }
    seenDays.add(entry.day)
  }
  const draft: TripDraft = {
    ...created.draft,
    // base 必须指向原留存 Trip：combinedTrip 只是克隆用的组合投影，
    // discardDraft / draftChangedDays / applyDraft 的比对基准都要是原 Trip。
    base: session.trip,
    // 把编辑天作为「已操作过」候选集：真实差异仍由 draftChangedDays 对 base 重导，
    // 改回原值的天会自动消失（不信任持久标记）。
    changedDays: session.draft.editedDays.map((entry) => entry.day),
  }
  return { ok: true, draft }
}

export type BudgetRebuildResult =
  | { ok: true; session: BudgetSessionState }
  | { ok: false; reason: 'unverifiable' | 'mismatch'; message: string }

/**
 * 从留存块重建费用 session：
 * - unbound → emptyBudgetSession；
 * - current 且 tripId 与当前 Trip 一致且快照可验证 → 直接构造绑定新 revision 的 owner
 *   （result/undo 置空；内容不再二次校验，读取层已验证结构）；
 * - stale → owner 用 revision=-1 + 哨兵快照重建，必然失配，保持只读沿用/新建交互；
 * - current 但 tripId 不一致或快照不可验证 → typed 失败（不静默 fresh）。
 */
export function rebuildBudgetSession(
  session: SessionResumePayload | SessionResumeRecord['session'],
  ctx: BudgetTripContext,
): BudgetRebuildResult {
  const block = session.budget
  if (block === null) return { ok: true, session: emptyBudgetSession() }

  if (block.binding.kind === 'unbound') {
    return { ok: true, session: emptyBudgetSession() }
  }

  if (block.binding.kind === 'current') {
    if (!ctx.snapshot || block.binding.tripId !== ctx.tripId) {
      return {
        ok: false,
        reason: 'mismatch',
        message: '留存费用声明属于当前行程，但内容无法核实归属，未恢复费用；行程与草稿不受影响。',
      }
    }
    return {
      ok: true,
      session: {
        owner: {
          tripId: ctx.tripId,
          revision: ctx.revision,
          tripSnapshot: ctx.snapshot,
          tripTitle: ctx.tripTitle,
        },
        rows: block.rows,
        budgetRaw: block.budgetRaw,
        result: null,
        undo: null,
      },
    }
  }

  // stale：构造必然失配的 owner，交给既有只读沿用/新建交互
  const owner = {
    tripId: block.binding.tripId,
    revision: -1,
    tripSnapshot: STALE_OWNER_SENTINEL,
    tripTitle: block.binding.tripTitle,
  }
  return {
    ok: true,
    session: { owner, rows: block.rows, budgetRaw: block.budgetRaw, result: null, undo: null },
  }
}

/* ───────── 恢复预检（原子） ───────── */

export type SessionRestorePreview =
  | {
      ok: true
      draft: TripDraft | null
      budget: BudgetSessionState
      /** ui.activeDay 校验通过后的落点（无效天回第 1 天由调用方决定） */
      activeDay: number
      draftMode: TravelMode
      /** 来源标记：null = 旧记录没有该字段（未知，须保守提示） */
      openedFromFile: boolean | null
    }
  | { ok: false; message: string }

/**
 * 恢复前的原子预检：draft 与 budget 全部重建成功才返回 ok，
 * 不触碰任何存储、不产生副作用。调用方只有拿到 ok:true 才允许开始替换视图；
 * ok:false 时当前 trip/draft/budget 原样、在飞请求不动、raw 原样。
 * current 费用重绑使用调用方基于「将要恢复的 trip + 新 revision」构造的 ctx。
 */
export function previewSessionResume(
  record: SessionResumeRecord,
  nextRevision: number,
): SessionRestorePreview {
  const session = record.session

  // draft 重建
  const rebuiltDraft = rebuildDraftFromTrip({ trip: session.trip, draft: session.draft, budget: session.budget, ui: { activeDay: session.ui.activeDay, draftMode: session.ui.draftMode, openedFromFile: session.ui.openedFromFile } })
  if (!rebuiltDraft.ok) return { ok: false, message: rebuiltDraft.message }

  // 费用重建：ctx 基于恢复后的行程与新 revision
  const snapshotResult = tripOwnerSnapshot(session.trip)
  if (!snapshotResult.ok) {
    return { ok: false, message: '留存行程内容无法序列化核对，未执行恢复；原始数据保留。' }
  }
  const ctx: BudgetTripContext = {
    tripId: session.trip.id,
    revision: nextRevision,
    snapshot: snapshotResult.value,
    tripTitle: session.trip.title,
  }
  const rebuiltBudget = rebuildBudgetSession(
    { trip: session.trip, draft: session.draft, budget: session.budget, ui: { activeDay: session.ui.activeDay, draftMode: session.ui.draftMode, openedFromFile: session.ui.openedFromFile } },
    ctx,
  )
  if (!rebuiltBudget.ok) {
    return { ok: false, message: `${rebuiltBudget.message} 未执行恢复；原始数据保留。` }
  }

  return {
    ok: true,
    draft: rebuiltDraft.draft,
    budget: rebuiltBudget.session,
    activeDay: session.ui.activeDay,
    draftMode: session.ui.draftMode,
    openedFromFile: session.ui.openedFromFile,
  }
}

/* ───────── 删除 ───────── */

/** 只删数据键：flag 与正式保存完全不动。 */
export function removeSessionResumeData(storage: StorageLike | null): SessionRemoveResult {
  if (!storage) {
    return { ok: false, reason: 'unavailable', message: '当前环境没有可用的本地存储。' }
  }
  try {
    storage.removeItem(SESSION_RESUME_DATA_KEY)
    return { ok: true }
  } catch (error) {
    if (isSecurityError(error)) {
      return { ok: false, reason: 'unavailable', message: '浏览器拒绝删除留存副本；原始数据保留。' }
    }
    return { ok: false, reason: 'unknown', message: '删除留存副本失败；原始数据保留。' }
  }
}

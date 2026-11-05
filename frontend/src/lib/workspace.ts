/**
 * 工作区 / 候选库 / 版本库的公共契约实现：严格校验、白名单 builder、
 * revision transition、owner / fingerprint / epoch helper。
 *
 * 这里不读写 localStorage、不读时钟、不请求网络；持久化由后续
 * workspaceStorage.ts 按 docs/WORKSPACE_SIDECAR.md 实现。
 *
 * 两套机制分开：
 * - builder（create* / empty* / commit*）只投影已声明字段；
 * - validator 对未知字段一律拒绝，不做「清洗后覆盖原数据」。
 */
import type { Trip } from './api'
import {
  MAX_SAVED_TRIP_BYTES,
  checkTripShape,
  savedTripRecordBytes,
  utf8ByteLength,
} from './savedTrips'
import { MAX_BUDGET_ITEMS, isBudgetCategoryId } from './tripBudget'
import type { BudgetRowInput } from './tripBudget'
import {
  canonicalJson,
  fingerprintOf,
  fingerprintsMatch,
  isShortFingerprint,
} from './workspaceFingerprint'
import {
  BACKUP_VERSION,
  CANDIDATES_BACKUP_FORMAT,
  CANDIDATES_FORMAT,
  CANDIDATES_VERSION,
  MAX_ACCOMMODATION_NAME_LENGTH,
  MAX_ANCHOR_ADDRESS_LENGTH,
  MAX_ANCHOR_DAY,
  MAX_ANCHOR_NAME_LENGTH,
  MAX_APPLIED_TEMPLATES,
  MAX_APPLY_LINKS,
  MAX_BUDGET_AMOUNT_RAW_LENGTH,
  MAX_BUDGET_RAW_LENGTH,
  MAX_BUDGET_ROW_NAME_LENGTH,
  MAX_CANDIDATES_BACKUP_FILE_BYTES,
  MAX_CANDIDATES_BYTES,
  MAX_CANDIDATES_COUNT,
  MAX_CANDIDATE_ADDRESS_LENGTH,
  MAX_CANDIDATE_NAME_LENGTH,
  MAX_CANDIDATE_NOTES_LENGTH,
  MAX_CANDIDATE_PRIORITY,
  MAX_CANDIDATE_TAGS,
  MAX_CANDIDATE_TAG_LENGTH,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_NOTES_LENGTH,
  MAX_CHECKLIST_TITLE_LENGTH,
  MAX_CONSTRAINT_ITEMS,
  MAX_CONSTRAINT_NOTES_LENGTH,
  MAX_CONSTRAINT_PRIORITY,
  MAX_CONSTRAINT_TITLE_LENGTH,
  MAX_SAFE_WORKSPACE_REVISION,
  MAX_TEMPLATE_ID_LENGTH,
  MAX_TRANSPORT_NAME_LENGTH,
  MAX_VERSION_NAME_LENGTH,
  MAX_VERSION_SNAPSHOT_BYTES,
  MAX_VERSIONS_BACKUP_FILE_BYTES,
  MAX_VERSIONS_COUNT,
  MAX_VERSIONS_TOTAL_BYTES,
  MAX_WORKSPACE_BACKUP_FILE_BYTES,
  MAX_WORKSPACE_ID_LENGTH,
  MAX_WORKSPACE_LABEL_LENGTH,
  MAX_WORKSPACE_RECORD_BYTES,
  MAX_WORKSPACE_SIDECAR_BYTES,
  VERSIONS_BACKUP_FORMAT,
  VERSIONS_FORMAT,
  VERSIONS_VERSION,
  WORKSPACE_BACKUP_FORMAT,
  WORKSPACE_FORMAT,
  WORKSPACE_VERSION,
} from './workspaceTypes'
import type {
  AccommodationAnchorV1,
  AnchorsV1,
  ApplyLinkV1,
  BudgetSnapshotV1,
  CandidateItemV1,
  CandidatesBackupV1,
  CandidatesRecordV1,
  ChecklistItemV1,
  ChecklistV1,
  ConstraintItemV1,
  ConstraintsBindingV1,
  ConstraintsV1,
  DailyAnchorsV1,
  DayAnchorV1,
  GeoPointV1,
  PlanScopeV1,
  TransportAnchorV1,
  UnverifiedConstraintsAckV1,
  VersionSnapshotV1,
  VersionsBackupV1,
  VersionsRecordV1,
  WorkspaceBackupV1,
  WorkspaceFingerprintV1,
  WorkspaceIdentityV1,
  WorkspaceMetaV1,
  WorkspaceOwnerV1,
  WorkspaceRecordV1,
  WorkspaceSidecarV1,
  WorkspaceValidationReason,
  WorkspaceValidationResult,
} from './workspaceTypes'

export * from './workspaceTypes'

/* ───────── 基础工具 ───────── */

type JsonObject = Record<string, unknown>

function fail<T>(
  reason: WorkspaceValidationReason,
  path: string,
  message: string,
): WorkspaceValidationResult<T> {
  return { ok: false, reason, path, message }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

/**
 * 严格对象：未知键拒绝。
 * requiredKeys 必须存在；optionalKeys 可出现且只做已知字段校验，缺省合法（用于旧 v1
 * 兼容字段，不能把缺省自动补成 null）。
 */
function readObject(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): WorkspaceValidationResult<JsonObject> {
  if (!isRecord(value)) {
    return fail('not_object', path, `${path} 必须是对象。`)
  }
  for (const key of Object.keys(value)) {
    if (!requiredKeys.includes(key) && !optionalKeys.includes(key)) {
      return fail(
        'unknown_field',
        `${path}.${key}`,
        `字段 ${path}.${key} 未在当前版契约中声明；已拒绝，不做静默丢弃。`,
      )
    }
  }
  for (const key of requiredKeys) {
    if (!hasOwn(value, key)) {
      return fail('missing_field', `${path}.${key}`, `缺少必填字段 ${path}.${key}。`)
    }
  }
  return { ok: true, value }
}

interface TextRule {
  readonly max: number
  readonly min?: number
  readonly nonBlank?: boolean
}

function takeText(value: unknown, path: string, rule: TextRule): WorkspaceValidationResult<string | null> {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') {
    return fail('invalid_field', path, `${path} 必须是字符串或 null。`)
  }
  const min = rule.min ?? 0
  if (value.length < min || value.length > rule.max) {
    return fail('invalid_field', path, `${path} 的长度必须在 ${min}-${rule.max} 之间。`)
  }
  if (rule.nonBlank === true && value.trim().length === 0) {
    return fail('invalid_field', path, `${path} 不能为空白。`)
  }
  return { ok: true, value }
}

function requiredText(value: unknown, path: string, rule: TextRule): WorkspaceValidationResult<string> {
  const result = takeText(value, path, rule)
  if (!result.ok) return result
  if (result.value === null) return fail('invalid_field', path, `${path} 不能为 null。`)
  return { ok: true, value: result.value }
}

function optionalText(value: unknown, path: string, rule: TextRule): WorkspaceValidationResult<string | null> {
  return takeText(value, path, rule)
}

function takeNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
  integer = false,
): WorkspaceValidationResult<number | null> {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('invalid_field', path, `${path} 必须是有限数字或 null。`)
  }
  if (integer && !Number.isSafeInteger(value)) {
    return fail('invalid_field', path, `${path} 必须是安全整数或 null。`)
  }
  if (value < min || value > max) {
    return fail('invalid_field', path, `${path} 必须在 ${min}-${max} 之间。`)
  }
  return { ok: true, value }
}

function requiredNumber(value: unknown, path: string, min: number, max: number): WorkspaceValidationResult<number> {
  const result = takeNumber(value, path, min, max, true)
  if (!result.ok) return result
  if (result.value === null) return fail('invalid_field', path, `${path} 不能为 null。`)
  return { ok: true, value: result.value }
}

function requiredBoolean(value: unknown, path: string): WorkspaceValidationResult<boolean> {
  if (typeof value !== 'boolean') return fail('invalid_field', path, `${path} 必须是布尔值。`)
  return { ok: true, value }
}

function readArray(value: unknown, path: string): WorkspaceValidationResult<unknown[]> {
  if (!Array.isArray(value)) return fail('invalid_field', path, `${path} 必须是数组。`)
  return { ok: true, value }
}

function takeEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): WorkspaceValidationResult<T> {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return fail('invalid_field', path, `${path} 不是允许的枚举值。`)
  }
  return { ok: true, value: value as T }
}

function optionalEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): WorkspaceValidationResult<T | null> {
  if (value === null) return { ok: true, value: null }
  return takeEnum(value, path, allowed)
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** 严格 YYYY-MM-DD 且是真实日历日；不用 Date，避免时区偏移。 */
function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  return day <= daysInMonth(year, month)
}

function optionalDate(value: unknown, path: string): WorkspaceValidationResult<string | null> {
  const text = optionalText(value, path, { max: 10 })
  if (!text.ok) return text
  if (text.value === null) return text
  if (!isRealDate(text.value)) {
    return fail('invalid_field', path, `${path} 必须是真实日历日 YYYY-MM-DD，或 null。`)
  }
  return text
}

function optionalClock(value: unknown, path: string): WorkspaceValidationResult<string | null> {
  const text = optionalText(value, path, { max: 5 })
  if (!text.ok) return text
  if (text.value === null) return text
  if (!TIME_PATTERN.test(text.value)) {
    return fail('invalid_field', path, `${path} 必须是 HH:MM（24 小时制），或 null。`)
  }
  return text
}

function optionalId(value: unknown, path: string): WorkspaceValidationResult<string | null> {
  return optionalText(value, path, { max: MAX_WORKSPACE_ID_LENGTH, min: 1, nonBlank: true })
}

function requiredId(value: unknown, path: string): WorkspaceValidationResult<string> {
  return requiredText(value, path, { max: MAX_WORKSPACE_ID_LENGTH, min: 1, nonBlank: true })
}

function optionalDay(value: unknown, path: string): WorkspaceValidationResult<number | null> {
  return takeNumber(value, path, 1, MAX_ANCHOR_DAY, true)
}

function requiredDay(value: unknown, path: string): WorkspaceValidationResult<number> {
  return requiredNumber(value, path, 1, MAX_ANCHOR_DAY)
}

function requiredTimestamp(value: unknown, path: string): WorkspaceValidationResult<number> {
  return requiredNumber(value, path, 1, MAX_SAFE_WORKSPACE_REVISION)
}

function requiredRevision(value: unknown, path: string): WorkspaceValidationResult<number> {
  return requiredNumber(value, path, 0, MAX_SAFE_WORKSPACE_REVISION)
}

function optionalLocation(value: unknown, path: string): WorkspaceValidationResult<GeoPointV1 | null> {
  if (value === null) return { ok: true, value: null }
  const object = readObject(value, path, ['lng', 'lat'])
  if (!object.ok) return object
  const lng = takeNumber(object.value.lng, `${path}.lng`, -180, 180)
  if (!lng.ok) return lng
  if (lng.value === null) return fail('invalid_field', `${path}.lng`, `${path}.lng 不能为 null。`)
  const lat = takeNumber(object.value.lat, `${path}.lat`, -90, 90)
  if (!lat.ok) return lat
  if (lat.value === null) return fail('invalid_field', `${path}.lat`, `${path}.lat 不能为 null。`)
  return { ok: true, value: { lng: lng.value, lat: lat.value } }
}

function isCanonicalDayKey(key: string): boolean {
  const day = Number(key)
  return Number.isInteger(day) && day >= 1 && day <= MAX_ANCHOR_DAY && String(day) === key
}

/* ───────── 容量测量与限制 ───────── */

export type WorkspaceLimitFailureReason =
  | 'trip_too_large'
  | 'sidecar_too_large'
  | 'workspace_record_too_large'
  | 'candidates_count'
  | 'candidates_too_large'
  | 'version_snapshot_too_large'
  | 'versions_count'
  | 'versions_total_too_large'
  | 'workspace_backup_too_large'
  | 'candidates_backup_too_large'
  | 'versions_backup_too_large'

export interface WorkspaceLimitFailure {
  readonly ok: false
  readonly reason: WorkspaceLimitFailureReason
  readonly message: string
  readonly actual: number
  readonly limit: number
  readonly unit: 'bytes' | 'items'
}

export interface WorkspaceLimitSuccess {
  readonly ok: true
  readonly bytes: number
  readonly items: number
}

export type WorkspaceLimitResult = WorkspaceLimitSuccess | WorkspaceLimitFailure

function limitFailure(
  reason: WorkspaceLimitFailureReason,
  message: string,
  actual: number,
  limit: number,
  unit: 'bytes' | 'items',
): WorkspaceLimitFailure {
  return { ok: false, reason, message, actual, limit, unit }
}

/** 实际写出的紧凑 JSON 的 UTF-8 字节；失败返回 null（调用方按不可序列化拒绝）。 */
function jsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? utf8ByteLength(text) : null
  } catch {
    return null
  }
}

function canonicalBytes(value: unknown): number | null {
  const result = canonicalJson(value)
  return result.ok ? utf8ByteLength(result.text) : null
}

export function measureWorkspaceRecordBytes(record: WorkspaceRecordV1): number | null {
  return jsonBytes(record)
}

export function measureSidecarBytes(sidecar: WorkspaceSidecarV1): number | null {
  return jsonBytes(sidecar)
}

export function measureCandidatesRecordBytes(record: CandidatesRecordV1): number | null {
  return jsonBytes(record)
}

export function measureVersionsRecordBytes(record: VersionsRecordV1): number | null {
  return jsonBytes(record)
}

export function measureVersionSnapshotBytes(snapshot: VersionSnapshotV1): number | null {
  return jsonBytes(snapshot)
}

export function measureConstraintsCanonicalBytes(constraints: ConstraintsV1): number | null {
  return canonicalBytes(constraints)
}

export function checkWorkspaceRecordLimits(record: WorkspaceRecordV1): WorkspaceLimitResult {
  const tripBytes = savedTripRecordBytes(record.trip)
  if (tripBytes > MAX_SAVED_TRIP_BYTES) {
    return limitFailure(
      'trip_too_large',
      `行程本身超过既有 640 KiB 单份上限（实际 ${tripBytes} 字节）；工作区记录未保存。`,
      tripBytes,
      MAX_SAVED_TRIP_BYTES,
      'bytes',
    )
  }
  const sidecarBytes = jsonBytes(record.sidecar)
  if (sidecarBytes === null) {
    return limitFailure('sidecar_too_large', 'sidecar 无法序列化；工作区记录未保存。', 0, MAX_WORKSPACE_SIDECAR_BYTES, 'bytes')
  }
  if (sidecarBytes > MAX_WORKSPACE_SIDECAR_BYTES) {
    return limitFailure(
      'sidecar_too_large',
      `sidecar 超过 512 KiB 上限（实际 ${sidecarBytes} 字节）；工作区记录未保存，未驱逐旧数据。`,
      sidecarBytes,
      MAX_WORKSPACE_SIDECAR_BYTES,
      'bytes',
    )
  }
  const bytes = jsonBytes(record)
  if (bytes === null) {
    return limitFailure('workspace_record_too_large', '工作区记录无法序列化；未保存。', 0, MAX_WORKSPACE_RECORD_BYTES, 'bytes')
  }
  if (bytes > MAX_WORKSPACE_RECORD_BYTES) {
    return limitFailure(
      'workspace_record_too_large',
      `工作区记录超过 2 MiB 上限（实际 ${bytes} 字节）；未保存，未驱逐旧数据。`,
      bytes,
      MAX_WORKSPACE_RECORD_BYTES,
      'bytes',
    )
  }
  return { ok: true, bytes, items: 1 }
}

function checkSidecarLimit(sidecar: WorkspaceSidecarV1): WorkspaceLimitResult {
  const bytes = jsonBytes(sidecar)
  if (bytes === null) {
    return limitFailure('sidecar_too_large', 'sidecar 无法序列化；未保存。', 0, MAX_WORKSPACE_SIDECAR_BYTES, 'bytes')
  }
  if (bytes > MAX_WORKSPACE_SIDECAR_BYTES) {
    return limitFailure(
      'sidecar_too_large',
      `sidecar 超过 512 KiB 上限（实际 ${bytes} 字节）；未保存，未驱逐旧数据。`,
      bytes,
      MAX_WORKSPACE_SIDECAR_BYTES,
      'bytes',
    )
  }
  return { ok: true, bytes, items: 1 }
}

export function checkCandidatesRecordLimits(record: CandidatesRecordV1): WorkspaceLimitResult {
  if (record.items.length > MAX_CANDIDATES_COUNT) {
    return limitFailure(
      'candidates_count',
      `候选库最多 ${MAX_CANDIDATES_COUNT} 条（当前 ${record.items.length} 条）；未写入，未驱逐旧数据。`,
      record.items.length,
      MAX_CANDIDATES_COUNT,
      'items',
    )
  }
  const bytes = jsonBytes(record)
  if (bytes === null) {
    return limitFailure('candidates_too_large', '候选库无法序列化；未保存。', 0, MAX_CANDIDATES_BYTES, 'bytes')
  }
  if (bytes > MAX_CANDIDATES_BYTES) {
    return limitFailure(
      'candidates_too_large',
      `候选库超过 256 KiB 上限（实际 ${bytes} 字节）；未写入，未驱逐旧数据。`,
      bytes,
      MAX_CANDIDATES_BYTES,
      'bytes',
    )
  }
  return { ok: true, bytes, items: record.items.length }
}

export function checkVersionSnapshotLimits(snapshot: VersionSnapshotV1): WorkspaceLimitResult {
  const tripBytes = savedTripRecordBytes(snapshot.trip)
  if (tripBytes > MAX_SAVED_TRIP_BYTES) {
    return limitFailure(
      'version_snapshot_too_large',
      `版本里的行程超过既有 640 KiB 单份上限（实际 ${tripBytes} 字节）；版本未保存。`,
      tripBytes,
      MAX_SAVED_TRIP_BYTES,
      'bytes',
    )
  }
  const sidecarBytes = jsonBytes(snapshot.sidecar)
  if (sidecarBytes === null || sidecarBytes > MAX_WORKSPACE_SIDECAR_BYTES) {
    return limitFailure(
      'version_snapshot_too_large',
      `版本里的 sidecar 超过 512 KiB 上限；版本未保存。`,
      sidecarBytes ?? 0,
      MAX_WORKSPACE_SIDECAR_BYTES,
      'bytes',
    )
  }
  const bytes = jsonBytes(snapshot)
  if (bytes === null) {
    return limitFailure('version_snapshot_too_large', '版本快照无法序列化；未保存。', 0, MAX_VERSION_SNAPSHOT_BYTES, 'bytes')
  }
  if (bytes > MAX_VERSION_SNAPSHOT_BYTES) {
    return limitFailure(
      'version_snapshot_too_large',
      `单个版本快照超过 2 MiB 上限（实际 ${bytes} 字节）；未保存，未驱逐旧版本。`,
      bytes,
      MAX_VERSION_SNAPSHOT_BYTES,
      'bytes',
    )
  }
  return { ok: true, bytes, items: 1 }
}

export function checkVersionsRecordLimits(record: VersionsRecordV1): WorkspaceLimitResult {
  if (record.items.length > MAX_VERSIONS_COUNT) {
    return limitFailure(
      'versions_count',
      `版本库最多 ${MAX_VERSIONS_COUNT} 个版本（当前 ${record.items.length} 个）；未写入，未驱逐旧版本。`,
      record.items.length,
      MAX_VERSIONS_COUNT,
      'items',
    )
  }
  const bytes = jsonBytes(record)
  if (bytes === null) {
    return limitFailure('versions_total_too_large', '版本库无法序列化；未保存。', 0, MAX_VERSIONS_TOTAL_BYTES, 'bytes')
  }
  if (bytes > MAX_VERSIONS_TOTAL_BYTES) {
    return limitFailure(
      'versions_total_too_large',
      `版本库总量超过 4 MiB 上限（实际 ${bytes} 字节）；未写入，未驱逐旧版本。`,
      bytes,
      MAX_VERSIONS_TOTAL_BYTES,
      'bytes',
    )
  }
  return { ok: true, bytes, items: record.items.length }
}

function backupBytes(backup: unknown, rawBytes: number | undefined): number | null {
  if (rawBytes !== undefined) return rawBytes
  return jsonBytes(backup)
}

function checkBackupLimit(
  backup: unknown,
  rawBytes: number | undefined,
  limit: number,
  reason: WorkspaceLimitFailureReason,
  label: string,
): WorkspaceLimitResult {
  const bytes = backupBytes(backup, rawBytes)
  if (bytes === null) {
    return limitFailure(reason, `${label}无法序列化；未导入。`, 0, limit, 'bytes')
  }
  if (bytes > limit) {
    return limitFailure(
      reason,
      `${label}超过 ${limit} 字节上限（实际 ${bytes} 字节）；未导入，原数据不变。`,
      bytes,
      limit,
      'bytes',
    )
  }
  return { ok: true, bytes, items: 1 }
}

export function checkWorkspaceBackupLimits(
  backup: WorkspaceBackupV1,
  rawBytes?: number,
): WorkspaceLimitResult {
  return checkBackupLimit(
    backup,
    rawBytes,
    MAX_WORKSPACE_BACKUP_FILE_BYTES,
    'workspace_backup_too_large',
    '工作区备份文件',
  )
}

export function checkCandidatesBackupLimits(
  backup: CandidatesBackupV1,
  rawBytes?: number,
): WorkspaceLimitResult {
  return checkBackupLimit(
    backup,
    rawBytes,
    MAX_CANDIDATES_BACKUP_FILE_BYTES,
    'candidates_backup_too_large',
    '候选库备份文件',
  )
}

export function checkVersionsBackupLimits(
  backup: VersionsBackupV1,
  rawBytes?: number,
): WorkspaceLimitResult {
  return checkBackupLimit(
    backup,
    rawBytes,
    MAX_VERSIONS_BACKUP_FILE_BYTES,
    'versions_backup_too_large',
    '版本库备份文件',
  )
}

function limitToValidation<T>(result: WorkspaceLimitFailure): WorkspaceValidationResult<T> {
  return fail('limit_exceeded', '$', result.message)
}

function checkRawBytesArgument(rawBytes: unknown): WorkspaceValidationResult<number | undefined> {
  if (rawBytes === undefined) return { ok: true, value: undefined }
  if (typeof rawBytes !== 'number' || !Number.isSafeInteger(rawBytes) || rawBytes < 0) {
    return fail('invalid_field', '$.rawBytes', 'rawBytes 必须是非负安全整数。')
  }
  return { ok: true, value: rawBytes }
}

/* ───────── F1：锚点校验 ───────── */

function parseAccommodation(value: unknown, path: string): WorkspaceValidationResult<AccommodationAnchorV1 | null> {
  if (value === null) return { ok: true, value: null }
  const object = readObject(value, path, [
    'hotelId',
    'name',
    'address',
    'location',
    'locationSource',
    'checkInDate',
    'checkOutDate',
  ])
  if (!object.ok) return object
  const v = object.value
  const hotelId = optionalId(v.hotelId, `${path}.hotelId`)
  if (!hotelId.ok) return hotelId
  const name = optionalText(v.name, `${path}.name`, { max: MAX_ACCOMMODATION_NAME_LENGTH, min: 1, nonBlank: true })
  if (!name.ok) return name
  const address = optionalText(v.address, `${path}.address`, { max: MAX_ANCHOR_ADDRESS_LENGTH })
  if (!address.ok) return address
  const location = optionalLocation(v.location, `${path}.location`)
  if (!location.ok) return location
  const locationSource = optionalEnum(v.locationSource, `${path}.locationSource`, ['user_provided'] as const)
  if (!locationSource.ok) return locationSource
  const checkInDate = optionalDate(v.checkInDate, `${path}.checkInDate`)
  if (!checkInDate.ok) return checkInDate
  const checkOutDate = optionalDate(v.checkOutDate, `${path}.checkOutDate`)
  if (!checkOutDate.ok) return checkOutDate
  if (location.value !== null && locationSource.value !== 'user_provided') {
    return fail(
      'invalid_field',
      `${path}.locationSource`,
      '有真实坐标时 locationSource 必须是 user_provided；不把坐标来源冒充成已核实。',
    )
  }
  if (location.value === null && locationSource.value !== null) {
    return fail(
      'invalid_field',
      `${path}.locationSource`,
      '坐标未知时 locationSource 必须为 null。',
    )
  }
  return {
    ok: true,
    value: {
      hotelId: hotelId.value,
      name: name.value,
      address: address.value,
      location: location.value,
      locationSource: locationSource.value,
      checkInDate: checkInDate.value,
      checkOutDate: checkOutDate.value,
    },
  }
}

function parseDayAnchor(value: unknown, path: string): WorkspaceValidationResult<DayAnchorV1 | null> {
  if (value === null) return { ok: true, value: null }
  const object = readObject(value, path, [
    'anchorId',
    'kind',
    'stopId',
    'hotelId',
    'name',
    'address',
    'location',
    'time',
    'date',
  ])
  if (!object.ok) return object
  const v = object.value
  const anchorId = requiredId(v.anchorId, `${path}.anchorId`)
  if (!anchorId.ok) return anchorId
  const kind = takeEnum(v.kind, `${path}.kind`, ['stop', 'manual'] as const)
  if (!kind.ok) return kind
  const stopId = optionalId(v.stopId, `${path}.stopId`)
  if (!stopId.ok) return stopId
  const hotelId = optionalId(v.hotelId, `${path}.hotelId`)
  if (!hotelId.ok) return hotelId
  const name = requiredText(v.name, `${path}.name`, { max: MAX_ANCHOR_NAME_LENGTH, min: 1, nonBlank: true })
  if (!name.ok) return name
  const address = optionalText(v.address, `${path}.address`, { max: MAX_ANCHOR_ADDRESS_LENGTH })
  if (!address.ok) return address
  const location = optionalLocation(v.location, `${path}.location`)
  if (!location.ok) return location
  const time = optionalClock(v.time, `${path}.time`)
  if (!time.ok) return time
  const date = optionalDate(v.date, `${path}.date`)
  if (!date.ok) return date

  if (kind.value === 'stop' && stopId.value === null) {
    return fail('invalid_field', `${path}.stopId`, "kind='stop' 时 stopId 必填；不能只靠名称引用站点。")
  }
  if (kind.value === 'manual' && stopId.value !== null) {
    return fail('invalid_field', `${path}.stopId`, "kind='manual' 时 stopId 必须为 null；手工锚点不冒充已有站点。")
  }
  return {
    ok: true,
    value: {
      anchorId: anchorId.value,
      kind: kind.value,
      stopId: stopId.value,
      hotelId: hotelId.value,
      name: name.value,
      address: address.value,
      location: location.value,
      time: time.value,
      date: date.value,
    },
  }
}

function parseTransportAnchor(value: unknown, path: string): WorkspaceValidationResult<TransportAnchorV1 | null> {
  if (value === null) return { ok: true, value: null }
  const object = readObject(value, path, ['kind', 'name', 'date', 'time', 'location'])
  if (!object.ok) return object
  const v = object.value
  const kind = takeEnum(v.kind, `${path}.kind`, ['airport', 'station', 'other'] as const)
  if (!kind.ok) return kind
  const name = requiredText(v.name, `${path}.name`, { max: MAX_TRANSPORT_NAME_LENGTH, min: 1, nonBlank: true })
  if (!name.ok) return name
  const date = optionalDate(v.date, `${path}.date`)
  if (!date.ok) return date
  const time = optionalClock(v.time, `${path}.time`)
  if (!time.ok) return time
  const location = optionalLocation(v.location, `${path}.location`)
  if (!location.ok) return location
  return {
    ok: true,
    value: { kind: kind.value, name: name.value, date: date.value, time: time.value, location: location.value },
  }
}

function parseDailyAnchors(value: unknown, path: string): WorkspaceValidationResult<DailyAnchorsV1> {
  const object = readObject(value, path, ['start', 'end'])
  if (!object.ok) return object
  const start = parseDayAnchor(object.value.start, `${path}.start`)
  if (!start.ok) return start
  const end = parseDayAnchor(object.value.end, `${path}.end`)
  if (!end.ok) return end
  if (start.value === null && end.value === null) {
    return fail('invalid_field', path, '没有锚点的天请不要写入 daily；空条目会制造无意义的状态。')
  }
  return { ok: true, value: { start: start.value, end: end.value } }
}

function parseAnchors(value: unknown, path: string): WorkspaceValidationResult<AnchorsV1> {
  const object = readObject(value, path, ['accommodation', 'daily', 'arrival', 'departure'])
  if (!object.ok) return object
  const v = object.value
  const accommodation = parseAccommodation(v.accommodation, `${path}.accommodation`)
  if (!accommodation.ok) return accommodation
  if (!isRecord(v.daily)) return fail('invalid_field', `${path}.daily`, `${path}.daily 必须是以天序号为键的对象。`)
  const daily: Record<string, DailyAnchorsV1> = {}
  for (const key of Object.keys(v.daily)) {
    if (!isCanonicalDayKey(key)) {
      return fail('invalid_field', `${path}.daily.${key}`, 'daily 的键必须是 1-366 的规范十进制天序号。')
    }
    const parsed = parseDailyAnchors(v.daily[key], `${path}.daily.${key}`)
    if (!parsed.ok) return parsed
    daily[key] = parsed.value
  }
  const arrival = parseTransportAnchor(v.arrival, `${path}.arrival`)
  if (!arrival.ok) return arrival
  const departure = parseTransportAnchor(v.departure, `${path}.departure`)
  if (!departure.ok) return departure
  return {
    ok: true,
    value: { accommodation: accommodation.value, daily, arrival: arrival.value, departure: departure.value },
  }
}

export function validateAnchors(value: unknown): WorkspaceValidationResult<AnchorsV1> {
  return parseAnchors(value, '$')
}

export function emptyAnchors(): AnchorsV1 {
  return { accommodation: null, daily: {}, arrival: null, departure: null }
}

/* ───────── F2：约束校验 ───────── */

function parseConstraintItem(value: unknown, path: string): WorkspaceValidationResult<ConstraintItemV1> {
  const object = readObject(value, path, [
    'id',
    'kind',
    'title',
    'day',
    'stopId',
    'startDate',
    'endDate',
    'startTime',
    'endTime',
    'durationMinutes',
    'notes',
    'priority',
    'updatedAt',
  ])
  if (!object.ok) return object
  const v = object.value
  const id = requiredId(v.id, `${path}.id`)
  if (!id.ok) return id
  const kind = takeEnum(v.kind, `${path}.kind`, ['must_visit', 'fixed_window', 'reminder'] as const)
  if (!kind.ok) return kind
  const title = requiredText(v.title, `${path}.title`, { max: MAX_CONSTRAINT_TITLE_LENGTH, min: 1, nonBlank: true })
  if (!title.ok) return title
  const day = optionalDay(v.day, `${path}.day`)
  if (!day.ok) return day
  const stopId = optionalId(v.stopId, `${path}.stopId`)
  if (!stopId.ok) return stopId
  const startDate = optionalDate(v.startDate, `${path}.startDate`)
  if (!startDate.ok) return startDate
  const endDate = optionalDate(v.endDate, `${path}.endDate`)
  if (!endDate.ok) return endDate
  const startTime = optionalClock(v.startTime, `${path}.startTime`)
  if (!startTime.ok) return startTime
  const endTime = optionalClock(v.endTime, `${path}.endTime`)
  if (!endTime.ok) return endTime
  const durationMinutes = takeNumber(v.durationMinutes, `${path}.durationMinutes`, 0, 100_000, true)
  if (!durationMinutes.ok) return durationMinutes
  const notes = optionalText(v.notes, `${path}.notes`, { max: MAX_CONSTRAINT_NOTES_LENGTH })
  if (!notes.ok) return notes
  const priority = requiredNumber(v.priority, `${path}.priority`, 0, MAX_CONSTRAINT_PRIORITY)
  if (!priority.ok) return priority
  const updatedAt = requiredTimestamp(v.updatedAt, `${path}.updatedAt`)
  if (!updatedAt.ok) return updatedAt

  if (kind.value === 'must_visit' && day.value === null) {
    return fail('invalid_field', `${path}.day`, 'must_visit 必须指定目标天；未知目标天不能当成硬约束。')
  }
  if (endDate.value !== null && startDate.value === null) {
    return fail('invalid_field', `${path}.startDate`, '有 endDate 时必须同时给出 startDate；不把缺失开始日期猜成当天。')
  }
  if (endTime.value !== null && startTime.value === null) {
    return fail('invalid_field', `${path}.startTime`, '有 endTime 时必须同时给出 startTime；不把缺失开始时刻猜成 0 点。')
  }
  return {
    ok: true,
    value: {
      id: id.value,
      kind: kind.value,
      title: title.value,
      day: day.value,
      stopId: stopId.value,
      startDate: startDate.value,
      endDate: endDate.value,
      startTime: startTime.value,
      endTime: endTime.value,
      durationMinutes: durationMinutes.value,
      notes: notes.value,
      priority: priority.value,
      updatedAt: updatedAt.value,
    },
  }
}

function parseConstraints(value: unknown, path: string): WorkspaceValidationResult<ConstraintsV1> {
  const object = readObject(value, path, ['items'])
  if (!object.ok) return object
  const itemsRaw = readArray(object.value.items, `${path}.items`)
  if (!itemsRaw.ok) return itemsRaw
  if (itemsRaw.value.length > MAX_CONSTRAINT_ITEMS) {
    return fail(
      'limit_exceeded',
      `${path}.items`,
      `约束最多 ${MAX_CONSTRAINT_ITEMS} 条（当前 ${itemsRaw.value.length} 条）；未写入，不截断、不驱逐。`,
    )
  }
  const items: ConstraintItemV1[] = []
  const ids = new Set<string>()
  for (let index = 0; index < itemsRaw.value.length; index += 1) {
    const parsed = parseConstraintItem(itemsRaw.value[index], `${path}.items[${index}]`)
    if (!parsed.ok) return parsed
    if (ids.has(parsed.value.id)) {
      return fail('duplicate_id', `${path}.items[${index}].id`, '约束 id 重复；拒绝整份记录。')
    }
    ids.add(parsed.value.id)
    items.push(parsed.value)
  }
  return { ok: true, value: { items } }
}

export function validateConstraints(value: unknown): WorkspaceValidationResult<ConstraintsV1> {
  return parseConstraints(value, '$')
}

/**
 * 在 binding / planScope 关联层校验约束的目标语义；通用结构 validator 不做 Trip 关联。
 *
 * - trip_plan：请求没有 request.stops，任何 stopId 都不得伪造，必须为 null；must_visit
 *   用 title + day 表达尚未落 Trip 的初始目标。
 * - day / day_tail：item.day 必须为 null 或等于 scope.day；非 null stopId 必须存在于
 *   该日 stops。stopId=null 表示未绑定目标，后续按 doc §11.7 的 title/day 语义匹配，
 *   不能声称已由结构校验满足。
 *
 * 本函数不按名称挑选候选（day replan 会重写 output stop id）；H/U 匹配由 F2 适配层
 * 在完整 Trip 候选上执行。
 */
export function validateConstraintsForScope(
  constraints: ConstraintsV1,
  planScope: PlanScopeV1,
  record: WorkspaceRecordV1,
): WorkspaceValidationResult<ConstraintsV1> {
  const constraintsCheck = validateConstraints(constraints)
  if (!constraintsCheck.ok) return constraintsCheck
  const scopeCheck = validatePlanScope(planScope, record)
  if (!scopeCheck.ok) return scopeCheck

  if (scopeCheck.value.scope === 'trip_plan') {
    for (let index = 0; index < constraintsCheck.value.items.length; index += 1) {
      if (constraintsCheck.value.items[index].stopId !== null) {
        return fail(
          'invalid_field',
          `$.items[${index}].stopId`,
          'trip_plan 作用域没有 request.stops；绑定类约束的 stopId 必须为 null，不能伪造已有 stop。',
        )
      }
    }
    return constraintsCheck
  }

  const day = record.trip.days.find((entry) => entry.day === scopeCheck.value.day)
  if (!day) {
    return fail('invalid_field', '$.planScope.day', 'day / day_tail 作用域的目标天不存在。')
  }
  for (let index = 0; index < constraintsCheck.value.items.length; index += 1) {
    const item = constraintsCheck.value.items[index]
    if (item.day !== null && item.day !== scopeCheck.value.day) {
      return fail(
        'invalid_field',
        `$.items[${index}].day`,
        'day / day_tail 作用域的约束 day 必须为 null 或等于 scope.day；不能混入其它天的约束。',
      )
    }
    if (item.stopId !== null && !day.stops.some((stop) => stop.id === item.stopId)) {
      return fail(
        'invalid_field',
        `$.items[${index}].stopId`,
        'day / day_tail 绑定 stopId 时，该 stop 必须存在于 scope.day；不能跨天或引用不存在的 stop。',
      )
    }
  }
  return constraintsCheck
}

export function emptyConstraints(): ConstraintsV1 {
  return { items: [] }
}

/* ───────── F5：清单校验 ───────── */

function parseChecklistItem(value: unknown, path: string): WorkspaceValidationResult<ChecklistItemV1> {
  const object = readObject(
    value,
    path,
    [
      'id',
      'category',
      'title',
      'done',
      'date',
      'day',
      'stopId',
      'originalStopId',
      'notes',
      'updatedAt',
    ],
    ['constraintId'],
  )
  if (!object.ok) return object
  const v = object.value
  const id = requiredId(v.id, `${path}.id`)
  if (!id.ok) return id
  const category = takeEnum(v.category, `${path}.category`, [
    'ticket',
    'appointment',
    'document',
    'luggage',
    'todo',
  ] as const)
  if (!category.ok) return category
  const title = requiredText(v.title, `${path}.title`, { max: MAX_CHECKLIST_TITLE_LENGTH, min: 1, nonBlank: true })
  if (!title.ok) return title
  const done = requiredBoolean(v.done, `${path}.done`)
  if (!done.ok) return done
  const date = optionalDate(v.date, `${path}.date`)
  if (!date.ok) return date
  const day = optionalDay(v.day, `${path}.day`)
  if (!day.ok) return day
  const stopId = optionalId(v.stopId, `${path}.stopId`)
  if (!stopId.ok) return stopId
  const originalStopId = optionalId(v.originalStopId, `${path}.originalStopId`)
  if (!originalStopId.ok) return originalStopId
  let constraintId: string | null | undefined
  if (hasOwn(v, 'constraintId')) {
    const parsedConstraintId = optionalId(v.constraintId, `${path}.constraintId`)
    if (!parsedConstraintId.ok) return parsedConstraintId
    constraintId = parsedConstraintId.value
  }
  const notes = optionalText(v.notes, `${path}.notes`, { max: MAX_CHECKLIST_NOTES_LENGTH })
  if (!notes.ok) return notes
  const updatedAt = requiredTimestamp(v.updatedAt, `${path}.updatedAt`)
  if (!updatedAt.ok) return updatedAt
  return {
    ok: true,
    value: {
      id: id.value,
      category: category.value,
      title: title.value,
      done: done.value,
      date: date.value,
      day: day.value,
      stopId: stopId.value,
      originalStopId: originalStopId.value,
      ...(constraintId !== undefined ? { constraintId } : {}),
      notes: notes.value,
      updatedAt: updatedAt.value,
    },
  }
}

function parseChecklist(value: unknown, path: string): WorkspaceValidationResult<ChecklistV1> {
  const object = readObject(value, path, ['items', 'appliedTemplates'])
  if (!object.ok) return object
  const itemsRaw = readArray(object.value.items, `${path}.items`)
  if (!itemsRaw.ok) return itemsRaw
  if (itemsRaw.value.length > MAX_CHECKLIST_ITEMS) {
    return fail(
      'limit_exceeded',
      `${path}.items`,
      `清单最多 ${MAX_CHECKLIST_ITEMS} 项（当前 ${itemsRaw.value.length} 项）；未写入，不截断。`,
    )
  }
  const items: ChecklistItemV1[] = []
  const ids = new Set<string>()
  for (let index = 0; index < itemsRaw.value.length; index += 1) {
    const parsed = parseChecklistItem(itemsRaw.value[index], `${path}.items[${index}]`)
    if (!parsed.ok) return parsed
    if (ids.has(parsed.value.id)) {
      return fail('duplicate_id', `${path}.items[${index}].id`, '清单项 id 重复；拒绝整份记录。')
    }
    ids.add(parsed.value.id)
    items.push(parsed.value)
  }
  const templatesRaw = readArray(object.value.appliedTemplates, `${path}.appliedTemplates`)
  if (!templatesRaw.ok) return templatesRaw
  if (templatesRaw.value.length > MAX_APPLIED_TEMPLATES) {
    return fail(
      'limit_exceeded',
      `${path}.appliedTemplates`,
      `已采纳模板最多 ${MAX_APPLIED_TEMPLATES} 个；未写入，不截断。`,
    )
  }
  const appliedTemplates: string[] = []
  const templateIds = new Set<string>()
  for (let index = 0; index < templatesRaw.value.length; index += 1) {
    const templateId = requiredText(templatesRaw.value[index], `${path}.appliedTemplates[${index}]`, {
      max: MAX_TEMPLATE_ID_LENGTH,
      min: 1,
      nonBlank: true,
    })
    if (!templateId.ok) return templateId
    if (templateIds.has(templateId.value)) {
      return fail('duplicate_id', `${path}.appliedTemplates[${index}]`, '模板 id 重复。')
    }
    templateIds.add(templateId.value)
    appliedTemplates.push(templateId.value)
  }
  return { ok: true, value: { items, appliedTemplates } }
}

export function validateChecklist(value: unknown): WorkspaceValidationResult<ChecklistV1> {
  return parseChecklist(value, '$')
}

export function emptyChecklist(): ChecklistV1 {
  return { items: [], appliedTemplates: [] }
}

/* ───────── F3：候选使用关系 ───────── */

function parseApplyLink(value: unknown, path: string): WorkspaceValidationResult<ApplyLinkV1> {
  const object = readObject(value, path, ['candidateId', 'tripId', 'day', 'stopId'])
  if (!object.ok) return object
  const v = object.value
  const candidateId = requiredId(v.candidateId, `${path}.candidateId`)
  if (!candidateId.ok) return candidateId
  const tripId = requiredId(v.tripId, `${path}.tripId`)
  if (!tripId.ok) return tripId
  const day = requiredDay(v.day, `${path}.day`)
  if (!day.ok) return day
  const stopId = requiredId(v.stopId, `${path}.stopId`)
  if (!stopId.ok) return stopId
  return {
    ok: true,
    value: { candidateId: candidateId.value, tripId: tripId.value, day: day.value, stopId: stopId.value },
  }
}

export function validateApplyLink(value: unknown): WorkspaceValidationResult<ApplyLinkV1> {
  return parseApplyLink(value, '$')
}

function parseApplies(value: unknown, path: string): WorkspaceValidationResult<ApplyLinkV1[]> {
  const array = readArray(value, path)
  if (!array.ok) return array
  if (array.value.length > MAX_APPLY_LINKS) {
    return fail(
      'limit_exceeded',
      path,
      `使用关系最多 ${MAX_APPLY_LINKS} 条（当前 ${array.value.length} 条）；未写入。`,
    )
  }
  const links: ApplyLinkV1[] = []
  const seen = new Set<string>()
  for (let index = 0; index < array.value.length; index += 1) {
    const parsed = parseApplyLink(array.value[index], `${path}[${index}]`)
    if (!parsed.ok) return parsed
    const key = `${parsed.value.candidateId}\u0000${parsed.value.tripId}\u0000${parsed.value.day}\u0000${parsed.value.stopId}`
    if (seen.has(key)) {
      return fail('duplicate_id', `${path}[${index}]`, '同一条候选使用关系重复。')
    }
    seen.add(key)
    links.push(parsed.value)
  }
  return { ok: true, value: links }
}

export function validateApplyLinks(value: unknown): WorkspaceValidationResult<ApplyLinkV1[]> {
  return parseApplies(value, '$')
}

export function createApplyLink(
  candidateId: string,
  tripId: string,
  day: number,
  stopId: string,
): WorkspaceValidationResult<ApplyLinkV1> {
  return validateApplyLink({ candidateId, tripId, day, stopId })
}

/* ───────── 预算快照 ───────── */

function parseBudgetRow(value: unknown, path: string): WorkspaceValidationResult<BudgetRowInput> {
  const object = readObject(value, path, ['id', 'category', 'name', 'amountRaw'])
  if (!object.ok) return object
  const v = object.value
  const id = requiredId(v.id, `${path}.id`)
  if (!id.ok) return id
  if (typeof v.category !== 'string' || !isBudgetCategoryId(v.category)) {
    return fail('invalid_field', `${path}.category`, '预算分类不是合法选项。')
  }
  const name = requiredText(v.name, `${path}.name`, { max: MAX_BUDGET_ROW_NAME_LENGTH })
  if (!name.ok) return name
  const amountRaw = requiredText(v.amountRaw, `${path}.amountRaw`, { max: MAX_BUDGET_AMOUNT_RAW_LENGTH })
  if (!amountRaw.ok) return amountRaw
  return {
    ok: true,
    value: { id: id.value, category: v.category, name: name.value, amountRaw: amountRaw.value },
  }
}

function parseBudgetSnapshot(value: unknown, path: string): WorkspaceValidationResult<BudgetSnapshotV1 | null> {
  if (value === null) return { ok: true, value: null }
  const object = readObject(value, path, ['budgetRaw', 'rows'])
  if (!object.ok) return object
  const budgetRaw = requiredText(object.value.budgetRaw, `${path}.budgetRaw`, { max: MAX_BUDGET_RAW_LENGTH })
  if (!budgetRaw.ok) return budgetRaw
  const rowsRaw = readArray(object.value.rows, `${path}.rows`)
  if (!rowsRaw.ok) return rowsRaw
  if (rowsRaw.value.length > MAX_BUDGET_ITEMS) {
    return fail(
      'limit_exceeded',
      `${path}.rows`,
      `预算明细最多 ${MAX_BUDGET_ITEMS} 项（当前 ${rowsRaw.value.length} 项）；未写入。`,
    )
  }
  const rows: BudgetRowInput[] = []
  const ids = new Set<string>()
  for (let index = 0; index < rowsRaw.value.length; index += 1) {
    const parsed = parseBudgetRow(rowsRaw.value[index], `${path}.rows[${index}]`)
    if (!parsed.ok) return parsed
    if (ids.has(parsed.value.id)) {
      return fail('duplicate_id', `${path}.rows[${index}].id`, '预算行 id 重复。')
    }
    ids.add(parsed.value.id)
    rows.push(parsed.value)
  }
  return { ok: true, value: { budgetRaw: budgetRaw.value, rows } }
}

export function validateBudgetSnapshot(value: unknown): WorkspaceValidationResult<BudgetSnapshotV1 | null> {
  return parseBudgetSnapshot(value, '$')
}

export function emptyBudgetSnapshot(): BudgetSnapshotV1 {
  return { budgetRaw: '', rows: [] }
}

/* ───────── sidecar / 工作区记录 ───────── */

function parseSidecarStructure(value: unknown, path: string): WorkspaceValidationResult<WorkspaceSidecarV1> {
  const object = readObject(value, path, ['anchors', 'constraints', 'checklist', 'applies'])
  if (!object.ok) return object
  const anchors = parseAnchors(object.value.anchors, `${path}.anchors`)
  if (!anchors.ok) return anchors
  const constraints = parseConstraints(object.value.constraints, `${path}.constraints`)
  if (!constraints.ok) return constraints
  const checklist = parseChecklist(object.value.checklist, `${path}.checklist`)
  if (!checklist.ok) return checklist
  const applies = parseApplies(object.value.applies, `${path}.applies`)
  if (!applies.ok) return applies
  return {
    ok: true,
    value: {
      anchors: anchors.value,
      constraints: constraints.value,
      checklist: checklist.value,
      applies: applies.value,
    },
  }
}

export function validateWorkspaceSidecar(value: unknown): WorkspaceValidationResult<WorkspaceSidecarV1> {
  const parsed = parseSidecarStructure(value, '$')
  if (!parsed.ok) return parsed
  const limit = checkSidecarLimit(parsed.value)
  if (!limit.ok) return limitToValidation(limit)
  return parsed
}

export function emptySidecar(): WorkspaceSidecarV1 {
  return {
    anchors: emptyAnchors(),
    constraints: emptyConstraints(),
    checklist: emptyChecklist(),
    applies: [],
  }
}

function parseMeta(value: unknown, path: string): WorkspaceValidationResult<WorkspaceMetaV1> {
  const object = readObject(value, path, ['createdAt', 'label'])
  if (!object.ok) return object
  const createdAt = requiredTimestamp(object.value.createdAt, `${path}.createdAt`)
  if (!createdAt.ok) return createdAt
  const label = optionalText(object.value.label, `${path}.label`, { max: MAX_WORKSPACE_LABEL_LENGTH })
  if (!label.ok) return label
  return { ok: true, value: { createdAt: createdAt.value, label: label.value } }
}

function parseWorkspaceRecordStructure(value: unknown, path: string): WorkspaceValidationResult<WorkspaceRecordV1> {
  const object = readObject(value, path, [
    'format',
    'version',
    'workspaceId',
    'ownerId',
    'tripId',
    'trip',
    'sidecar',
    'budget',
    'workspaceRevision',
    'updatedAt',
    'meta',
  ])
  if (!object.ok) return object
  const v = object.value
  if (v.format !== WORKSPACE_FORMAT) {
    return fail('invalid_field', `${path}.format`, `format 必须是 ${WORKSPACE_FORMAT}。`)
  }
  if (v.version !== WORKSPACE_VERSION) {
    return fail('invalid_field', `${path}.version`, `version 必须是 ${WORKSPACE_VERSION}。`)
  }
  const workspaceId = requiredId(v.workspaceId, `${path}.workspaceId`)
  if (!workspaceId.ok) return workspaceId
  const ownerId = requiredId(v.ownerId, `${path}.ownerId`)
  if (!ownerId.ok) return ownerId
  const tripId = requiredId(v.tripId, `${path}.tripId`)
  if (!tripId.ok) return tripId
  const tripShape = checkTripShape(v.trip)
  if (!tripShape.ok) {
    return fail('invalid_trip', `${path}.trip`, `行程没有通过 checkTripShape：${tripShape.message}`)
  }
  if (!isRecord(v.trip) || typeof v.trip.id !== 'string') {
    return fail('invalid_trip', `${path}.trip`, '行程缺少 id。')
  }
  if (v.trip.id !== tripId.value) {
    return fail('invalid_field', `${path}.tripId`, 'tripId 必须与 trip.id 一致。')
  }
  const sidecar = parseSidecarStructure(v.sidecar, `${path}.sidecar`)
  if (!sidecar.ok) return sidecar
  const budget = parseBudgetSnapshot(v.budget, `${path}.budget`)
  if (!budget.ok) return budget
  const workspaceRevision = requiredRevision(v.workspaceRevision, `${path}.workspaceRevision`)
  if (!workspaceRevision.ok) return workspaceRevision
  const updatedAt = requiredTimestamp(v.updatedAt, `${path}.updatedAt`)
  if (!updatedAt.ok) return updatedAt
  const meta = parseMeta(v.meta, `${path}.meta`)
  if (!meta.ok) return meta
  return {
    ok: true,
    value: {
      format: WORKSPACE_FORMAT,
      version: WORKSPACE_VERSION,
      workspaceId: workspaceId.value,
      ownerId: ownerId.value,
      tripId: tripId.value,
      trip: v.trip as unknown as Trip,
      sidecar: sidecar.value,
      budget: budget.value,
      workspaceRevision: workspaceRevision.value,
      updatedAt: updatedAt.value,
      meta: meta.value,
    },
  }
}

export function validateWorkspaceRecord(value: unknown): WorkspaceValidationResult<WorkspaceRecordV1> {
  const parsed = parseWorkspaceRecordStructure(value, '$')
  if (!parsed.ok) return parsed
  const limit = checkWorkspaceRecordLimits(parsed.value)
  if (!limit.ok) return limitToValidation(limit)
  return parsed
}

export interface CreateWorkspaceRecordInput {
  readonly workspaceId: string
  readonly ownerId: string
  /** 新工作区绑定这一个 Trip；旧 Trip 导入默认不调用本 builder。 */
  readonly trip: Trip
  readonly workspaceRevision: number
  readonly now: number
  readonly sidecar?: WorkspaceSidecarV1
  readonly budget?: BudgetSnapshotV1 | null
  readonly label?: string | null
}

/**
 * 新建完整工作区记录。调用方必须显式提供 workspaceId / ownerId / revision；
 * 模块不生成 ID、不读时钟。只有用户显式「保存为工作区」时才应调用。
 */
export function createWorkspaceRecord(
  input: CreateWorkspaceRecordInput,
): WorkspaceValidationResult<WorkspaceRecordV1> {
  const tripId = isRecord(input.trip) && typeof input.trip.id === 'string' ? input.trip.id : ''
  const record: WorkspaceRecordV1 = {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    tripId,
    trip: input.trip,
    sidecar: input.sidecar ?? emptySidecar(),
    budget: input.budget ?? null,
    workspaceRevision: input.workspaceRevision,
    updatedAt: input.now,
    meta: { createdAt: input.now, label: input.label ?? null },
  }
  return validateWorkspaceRecord(record)
}

export function nextWorkspaceRevision(current: number): WorkspaceValidationResult<number> {
  if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
    return fail('invalid_field', '$.workspaceRevision', '当前 revision 必须是非负安全整数。')
  }
  if (current >= MAX_SAFE_WORKSPACE_REVISION) {
    return fail('limit_exceeded', '$.workspaceRevision', 'revision 已达到 JSON 安全整数上限，不能继续递增。')
  }
  return { ok: true, value: current + 1 }
}

export interface WorkspaceTransitionPatch {
  readonly trip?: Trip
  readonly sidecar?: WorkspaceSidecarV1
  readonly budget?: BudgetSnapshotV1 | null
  readonly label?: string | null
}

/**
 * 一次显式 transition：Trip + sidecar + budget 在内存中整体切换，revision 当前值 +1。
 *
 * - 绝不恢复旧 revision；采用版本 / 撤销也一样。
 * - 不允许借 transition 换 trip.id（换行程 = 新工作区）。
 * - 失败返回原记录不动；不在这里写存储。
 */
export function commitWorkspaceTransition(
  current: WorkspaceRecordV1,
  patch: WorkspaceTransitionPatch,
  now: number,
): WorkspaceValidationResult<WorkspaceRecordV1> {
  const currentCheck = validateWorkspaceRecord(current)
  if (!currentCheck.ok) return currentCheck

  const nextTrip = patch.trip ?? current.trip
  if (!isRecord(nextTrip) || nextTrip.id !== current.tripId) {
    return fail('invalid_field', '$.trip.id', '工作区只绑定一个行程；不能在 transition 中更换 trip.id，请新建工作区。')
  }
  const revision = nextWorkspaceRevision(current.workspaceRevision)
  if (!revision.ok) return revision
  const updatedAt = requiredTimestamp(now, '$.updatedAt')
  if (!updatedAt.ok) return updatedAt
  const label =
    patch.label !== undefined
      ? patch.label
      : current.meta.label

  const next: WorkspaceRecordV1 = {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    workspaceId: current.workspaceId,
    ownerId: current.ownerId,
    tripId: current.tripId,
    trip: nextTrip,
    sidecar: patch.sidecar ?? current.sidecar,
    budget: patch.budget !== undefined ? patch.budget : current.budget,
    workspaceRevision: revision.value,
    updatedAt: updatedAt.value,
    meta: { createdAt: current.meta.createdAt, label: label ?? null },
  }
  return validateWorkspaceRecord(next)
}

/* ───────── F3：候选库校验 ───────── */

function parseCandidateItem(value: unknown, path: string): WorkspaceValidationResult<CandidateItemV1> {
  const object = readObject(value, path, [
    'id',
    'name',
    'address',
    'notes',
    'tags',
    'priority',
    'location',
    'source',
    'copiedFromStopId',
    'createdAt',
    'updatedAt',
  ])
  if (!object.ok) return object
  const v = object.value
  const id = requiredId(v.id, `${path}.id`)
  if (!id.ok) return id
  const name = requiredText(v.name, `${path}.name`, { max: MAX_CANDIDATE_NAME_LENGTH, min: 1, nonBlank: true })
  if (!name.ok) return name
  const address = optionalText(v.address, `${path}.address`, { max: MAX_CANDIDATE_ADDRESS_LENGTH })
  if (!address.ok) return address
  const notes = optionalText(v.notes, `${path}.notes`, { max: MAX_CANDIDATE_NOTES_LENGTH })
  if (!notes.ok) return notes
  const tagsRaw = readArray(v.tags, `${path}.tags`)
  if (!tagsRaw.ok) return tagsRaw
  if (tagsRaw.value.length > MAX_CANDIDATE_TAGS) {
    return fail('limit_exceeded', `${path}.tags`, `候选标签最多 ${MAX_CANDIDATE_TAGS} 个。`)
  }
  const tags: string[] = []
  const seenTags = new Set<string>()
  for (let index = 0; index < tagsRaw.value.length; index += 1) {
    const tag = requiredText(tagsRaw.value[index], `${path}.tags[${index}]`, {
      max: MAX_CANDIDATE_TAG_LENGTH,
      min: 1,
      nonBlank: true,
    })
    if (!tag.ok) return tag
    if (seenTags.has(tag.value)) {
      return fail('duplicate_id', `${path}.tags[${index}]`, '候选标签重复。')
    }
    seenTags.add(tag.value)
    tags.push(tag.value)
  }
  const priority = requiredNumber(v.priority, `${path}.priority`, 0, MAX_CANDIDATE_PRIORITY)
  if (!priority.ok) return priority
  const location = optionalLocation(v.location, `${path}.location`)
  if (!location.ok) return location
  const source = takeEnum(v.source, `${path}.source`, ['manual', 'copied'] as const)
  if (!source.ok) return source
  const copiedFromStopId = optionalId(v.copiedFromStopId, `${path}.copiedFromStopId`)
  if (!copiedFromStopId.ok) return copiedFromStopId
  if (source.value === 'copied' && copiedFromStopId.value === null) {
    return fail('invalid_field', `${path}.copiedFromStopId`, "source='copied' 时必须记录来源 stop id。")
  }
  if (source.value === 'manual' && copiedFromStopId.value !== null) {
    return fail('invalid_field', `${path}.copiedFromStopId`, "source='manual' 时 copiedFromStopId 必须为 null。")
  }
  const createdAt = requiredTimestamp(v.createdAt, `${path}.createdAt`)
  if (!createdAt.ok) return createdAt
  const updatedAt = requiredTimestamp(v.updatedAt, `${path}.updatedAt`)
  if (!updatedAt.ok) return updatedAt
  if (updatedAt.value < createdAt.value) {
    return fail('invalid_field', `${path}.updatedAt`, 'updatedAt 不能早于 createdAt。')
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      address: address.value,
      notes: notes.value,
      tags,
      priority: priority.value,
      location: location.value,
      source: source.value,
      copiedFromStopId: copiedFromStopId.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    },
  }
}

export function validateCandidateItem(value: unknown): WorkspaceValidationResult<CandidateItemV1> {
  return parseCandidateItem(value, '$')
}

function parseCandidatesRecordStructure(value: unknown, path: string): WorkspaceValidationResult<CandidatesRecordV1> {
  const object = readObject(value, path, ['format', 'version', 'items', 'updatedAt'])
  if (!object.ok) return object
  const v = object.value
  if (v.format !== CANDIDATES_FORMAT) {
    return fail('invalid_field', `${path}.format`, `format 必须是 ${CANDIDATES_FORMAT}。`)
  }
  if (v.version !== CANDIDATES_VERSION) {
    return fail('invalid_field', `${path}.version`, `version 必须是 ${CANDIDATES_VERSION}。`)
  }
  const itemsRaw = readArray(v.items, `${path}.items`)
  if (!itemsRaw.ok) return itemsRaw
  if (itemsRaw.value.length > MAX_CANDIDATES_COUNT) {
    return fail(
      'limit_exceeded',
      `${path}.items`,
      `候选库最多 ${MAX_CANDIDATES_COUNT} 条（当前 ${itemsRaw.value.length} 条）；未写入。`,
    )
  }
  const items: CandidateItemV1[] = []
  const ids = new Set<string>()
  for (let index = 0; index < itemsRaw.value.length; index += 1) {
    const parsed = parseCandidateItem(itemsRaw.value[index], `${path}.items[${index}]`)
    if (!parsed.ok) return parsed
    if (ids.has(parsed.value.id)) {
      return fail('duplicate_id', `${path}.items[${index}].id`, '候选 id 重复；拒绝整份记录。')
    }
    ids.add(parsed.value.id)
    items.push(parsed.value)
  }
  const updatedAt = requiredTimestamp(v.updatedAt, `${path}.updatedAt`)
  if (!updatedAt.ok) return updatedAt
  return {
    ok: true,
    value: { format: CANDIDATES_FORMAT, version: CANDIDATES_VERSION, items, updatedAt: updatedAt.value },
  }
}

export function validateCandidatesRecord(value: unknown): WorkspaceValidationResult<CandidatesRecordV1> {
  const parsed = parseCandidatesRecordStructure(value, '$')
  if (!parsed.ok) return parsed
  const limit = checkCandidatesRecordLimits(parsed.value)
  if (!limit.ok) return limitToValidation(limit)
  return parsed
}

export function createCandidatesRecord(
  items: readonly CandidateItemV1[],
  updatedAt: number,
): WorkspaceValidationResult<CandidatesRecordV1> {
  return validateCandidatesRecord({
    format: CANDIDATES_FORMAT,
    version: CANDIDATES_VERSION,
    items: [...items],
    updatedAt,
  })
}

/* ───────── F4：版本库校验 ───────── */

function parseVersionSnapshotStructure(value: unknown, path: string): WorkspaceValidationResult<VersionSnapshotV1> {
  const object = readObject(value, path, [
    'id',
    'name',
    'createdAt',
    'workspaceRevision',
    'trip',
    'sidecar',
    'budget',
  ])
  if (!object.ok) return object
  const v = object.value
  const id = requiredId(v.id, `${path}.id`)
  if (!id.ok) return id
  const name = requiredText(v.name, `${path}.name`, { max: MAX_VERSION_NAME_LENGTH, min: 1, nonBlank: true })
  if (!name.ok) return name
  const createdAt = requiredTimestamp(v.createdAt, `${path}.createdAt`)
  if (!createdAt.ok) return createdAt
  const workspaceRevision = requiredRevision(v.workspaceRevision, `${path}.workspaceRevision`)
  if (!workspaceRevision.ok) return workspaceRevision
  const tripShape = checkTripShape(v.trip)
  if (!tripShape.ok) {
    return fail('invalid_trip', `${path}.trip`, `版本里的行程没有通过 checkTripShape：${tripShape.message}`)
  }
  const sidecar = parseSidecarStructure(v.sidecar, `${path}.sidecar`)
  if (!sidecar.ok) return sidecar
  const budget = parseBudgetSnapshot(v.budget, `${path}.budget`)
  if (!budget.ok) return budget
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      createdAt: createdAt.value,
      workspaceRevision: workspaceRevision.value,
      trip: v.trip as unknown as Trip,
      sidecar: sidecar.value,
      budget: budget.value,
    },
  }
}

export function validateVersionSnapshot(value: unknown): WorkspaceValidationResult<VersionSnapshotV1> {
  const parsed = parseVersionSnapshotStructure(value, '$')
  if (!parsed.ok) return parsed
  const limit = checkVersionSnapshotLimits(parsed.value)
  if (!limit.ok) return limitToValidation(limit)
  return parsed
}

function parseVersionsRecordStructure(value: unknown, path: string): WorkspaceValidationResult<VersionsRecordV1> {
  const object = readObject(value, path, ['format', 'version', 'items', 'updatedAt'])
  if (!object.ok) return object
  const v = object.value
  if (v.format !== VERSIONS_FORMAT) {
    return fail('invalid_field', `${path}.format`, `format 必须是 ${VERSIONS_FORMAT}。`)
  }
  if (v.version !== VERSIONS_VERSION) {
    return fail('invalid_field', `${path}.version`, `version 必须是 ${VERSIONS_VERSION}。`)
  }
  const itemsRaw = readArray(v.items, `${path}.items`)
  if (!itemsRaw.ok) return itemsRaw
  if (itemsRaw.value.length > MAX_VERSIONS_COUNT) {
    return fail(
      'limit_exceeded',
      `${path}.items`,
      `版本库最多 ${MAX_VERSIONS_COUNT} 个版本（当前 ${itemsRaw.value.length} 个）；未写入。`,
    )
  }
  const items: VersionSnapshotV1[] = []
  const ids = new Set<string>()
  for (let index = 0; index < itemsRaw.value.length; index += 1) {
    const parsed = parseVersionSnapshotStructure(itemsRaw.value[index], `${path}.items[${index}]`)
    if (!parsed.ok) return parsed
    if (ids.has(parsed.value.id)) {
      return fail('duplicate_id', `${path}.items[${index}].id`, '版本 id 重复；拒绝整份记录。')
    }
    ids.add(parsed.value.id)
    items.push(parsed.value)
  }
  const updatedAt = requiredTimestamp(v.updatedAt, `${path}.updatedAt`)
  if (!updatedAt.ok) return updatedAt
  return {
    ok: true,
    value: { format: VERSIONS_FORMAT, version: VERSIONS_VERSION, items, updatedAt: updatedAt.value },
  }
}

export function validateVersionsRecord(value: unknown): WorkspaceValidationResult<VersionsRecordV1> {
  const parsed = parseVersionsRecordStructure(value, '$')
  if (!parsed.ok) return parsed
  for (const item of parsed.value.items) {
    const limit = checkVersionSnapshotLimits(item)
    if (!limit.ok) return limitToValidation(limit)
  }
  const limit = checkVersionsRecordLimits(parsed.value)
  if (!limit.ok) return limitToValidation(limit)
  return parsed
}

export function createVersionsRecord(
  items: readonly VersionSnapshotV1[],
  updatedAt: number,
): WorkspaceValidationResult<VersionsRecordV1> {
  return validateVersionsRecord({
    format: VERSIONS_FORMAT,
    version: VERSIONS_VERSION,
    items: [...items],
    updatedAt,
  })
}

/* ───────── 三个独立备份文件 ───────── */

export function validateWorkspaceBackup(
  value: unknown,
  rawBytes?: number,
): WorkspaceValidationResult<WorkspaceBackupV1> {
  const bytesArg = checkRawBytesArgument(rawBytes)
  if (!bytesArg.ok) return bytesArg
  const object = readObject(value, '$', ['format', 'version', 'exportedAt', 'workspace'])
  if (!object.ok) return object
  const v = object.value
  if (v.format !== WORKSPACE_BACKUP_FORMAT) {
    return fail('invalid_field', '$.format', `format 必须是 ${WORKSPACE_BACKUP_FORMAT}。`)
  }
  if (v.version !== BACKUP_VERSION) {
    return fail('invalid_field', '$.version', `version 必须是 ${BACKUP_VERSION}。`)
  }
  const exportedAt = requiredTimestamp(v.exportedAt, '$.exportedAt')
  if (!exportedAt.ok) return exportedAt
  const workspace = validateWorkspaceRecord(v.workspace)
  if (!workspace.ok) return workspace
  const backup: WorkspaceBackupV1 = {
    format: WORKSPACE_BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: exportedAt.value,
    workspace: workspace.value,
  }
  const limit = checkWorkspaceBackupLimits(backup, bytesArg.value)
  if (!limit.ok) return limitToValidation(limit)
  return { ok: true, value: backup }
}

export function validateCandidatesBackup(
  value: unknown,
  rawBytes?: number,
): WorkspaceValidationResult<CandidatesBackupV1> {
  const bytesArg = checkRawBytesArgument(rawBytes)
  if (!bytesArg.ok) return bytesArg
  const object = readObject(value, '$', ['format', 'version', 'exportedAt', 'candidates'])
  if (!object.ok) return object
  const v = object.value
  if (v.format !== CANDIDATES_BACKUP_FORMAT) {
    return fail('invalid_field', '$.format', `format 必须是 ${CANDIDATES_BACKUP_FORMAT}。`)
  }
  if (v.version !== BACKUP_VERSION) {
    return fail('invalid_field', '$.version', `version 必须是 ${BACKUP_VERSION}。`)
  }
  const exportedAt = requiredTimestamp(v.exportedAt, '$.exportedAt')
  if (!exportedAt.ok) return exportedAt
  const candidates = validateCandidatesRecord(v.candidates)
  if (!candidates.ok) return candidates
  const backup: CandidatesBackupV1 = {
    format: CANDIDATES_BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: exportedAt.value,
    candidates: candidates.value,
  }
  const limit = checkCandidatesBackupLimits(backup, bytesArg.value)
  if (!limit.ok) return limitToValidation(limit)
  return { ok: true, value: backup }
}

export function validateVersionsBackup(
  value: unknown,
  rawBytes?: number,
): WorkspaceValidationResult<VersionsBackupV1> {
  const bytesArg = checkRawBytesArgument(rawBytes)
  if (!bytesArg.ok) return bytesArg
  const object = readObject(value, '$', ['format', 'version', 'exportedAt', 'versions'])
  if (!object.ok) return object
  const v = object.value
  if (v.format !== VERSIONS_BACKUP_FORMAT) {
    return fail('invalid_field', '$.format', `format 必须是 ${VERSIONS_BACKUP_FORMAT}。`)
  }
  if (v.version !== BACKUP_VERSION) {
    return fail('invalid_field', '$.version', `version 必须是 ${BACKUP_VERSION}。`)
  }
  const exportedAt = requiredTimestamp(v.exportedAt, '$.exportedAt')
  if (!exportedAt.ok) return exportedAt
  const versions = validateVersionsRecord(v.versions)
  if (!versions.ok) return versions
  const backup: VersionsBackupV1 = {
    format: VERSIONS_BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: exportedAt.value,
    versions: versions.value,
  }
  const limit = checkVersionsBackupLimits(backup, bytesArg.value)
  if (!limit.ok) return limitToValidation(limit)
  return { ok: true, value: backup }
}

/* ───────── owner / fingerprint / epoch ───────── */

export function workspaceIdentityOf(record: WorkspaceRecordV1): WorkspaceIdentityV1 {
  return {
    ownerId: record.ownerId,
    workspaceId: record.workspaceId,
    tripId: record.tripId,
    workspaceRevision: record.workspaceRevision,
  }
}

export function workspaceIdentityMatches(identity: WorkspaceIdentityV1, record: WorkspaceRecordV1): boolean {
  return (
    identity.ownerId === record.ownerId &&
    identity.workspaceId === record.workspaceId &&
    identity.tripId === record.tripId &&
    identity.workspaceRevision === record.workspaceRevision
  )
}

/**
 * 运行期引用捕获（不序列化、不写 storage）。
 *
 * canonical / identity / revision / epoch 只能证明内容与逻辑身份；它们不能证明“捕获时
 * 看到的就是当前对象”。apply / adopt / undo / import 在调用内容匹配前，必须先持有
 * 实际 record / trip / sidecar / budget（以及适用 candidate / version / input）引用，
 * 并检查 capturedRef === currentRef 且 epoch 相等。每次用户编辑 / 切换 / 采用 / 撤销 /
 * 导入 / 外部 storage 变化都必须推进对应 epoch，即使内容 A-B-A 相同也不能复用旧 pending。
 *
 * 该 helper 不会自动推进 epoch，也不能发现未观察到的原地字段突变；外部原地突变禁止，
 * transition 必须返回新对象，组件必须发事件通知。
 */
export interface WorkspaceRuntimeExtrasV1 {
  readonly candidate?: CandidateItemV1 | null
  readonly version?: VersionSnapshotV1 | null
  readonly input?: unknown
}

export interface WorkspaceRuntimeCaptureV1 {
  readonly record: WorkspaceRecordV1
  readonly trip: Trip
  readonly sidecar: WorkspaceSidecarV1
  readonly budget: BudgetSnapshotV1 | null
  readonly candidate: CandidateItemV1 | null
  readonly version: VersionSnapshotV1 | null
  readonly input: unknown
  readonly epoch: number
}

export function captureWorkspaceRuntime(
  record: WorkspaceRecordV1,
  epoch: number,
  extras: WorkspaceRuntimeExtrasV1 = {},
): WorkspaceValidationResult<WorkspaceRuntimeCaptureV1> {
  const recordCheck = validateWorkspaceRecord(record)
  if (!recordCheck.ok) return recordCheck
  const epochCheck = parseEpoch(epoch, '$.epoch')
  if (!epochCheck.ok) return epochCheck
  return {
    ok: true,
    value: {
      record,
      trip: record.trip,
      sidecar: record.sidecar,
      budget: record.budget,
      candidate: extras.candidate ?? null,
      version: extras.version ?? null,
      input: extras.input ?? null,
      epoch: epochCheck.value,
    },
  }
}

/** 只比较实际对象引用 + epoch；内容 / identity / revision 仍由调用方继续匹配。 */
export function workspaceRuntimeRefsMatch(
  capture: WorkspaceRuntimeCaptureV1,
  record: WorkspaceRecordV1,
  epoch: number,
  extras: WorkspaceRuntimeExtrasV1 = {},
): boolean {
  if (!Number.isSafeInteger(epoch) || epoch < 0) return false
  if (capture.epoch !== epoch) return false
  if (capture.record !== record) return false
  if (capture.trip !== record.trip) return false
  if (capture.sidecar !== record.sidecar) return false
  if (capture.budget !== record.budget) return false
  if (capture.candidate !== (extras.candidate ?? null)) return false
  if (capture.version !== (extras.version ?? null)) return false
  if (capture.input !== (extras.input ?? null)) return false
  return true
}

function parseFingerprint(
  value: unknown,
  path: string,
  maxCanonicalBytes: number,
): WorkspaceValidationResult<WorkspaceFingerprintV1> {
  const object = readObject(value, path, ['canonical', 'short'])
  if (!object.ok) return object
  const canonical = requiredText(object.value.canonical, `${path}.canonical`, {
    max: maxCanonicalBytes,
    min: 1,
  })
  if (!canonical.ok) return canonical
  if (!isShortFingerprint(object.value.short)) {
    return fail('invalid_field', `${path}.short`, '短指纹必须是 8 位小写十六进制字符串。')
  }
  return { ok: true, value: { canonical: canonical.value, short: object.value.short } }
}

export function validateWorkspaceIdentity(value: unknown): WorkspaceValidationResult<WorkspaceIdentityV1> {
  const object = readObject(value, '$', ['ownerId', 'workspaceId', 'tripId', 'workspaceRevision'])
  if (!object.ok) return object
  const ownerId = requiredId(object.value.ownerId, '$.ownerId')
  if (!ownerId.ok) return ownerId
  const workspaceId = requiredId(object.value.workspaceId, '$.workspaceId')
  if (!workspaceId.ok) return workspaceId
  const tripId = requiredId(object.value.tripId, '$.tripId')
  if (!tripId.ok) return tripId
  const workspaceRevision = requiredRevision(object.value.workspaceRevision, '$.workspaceRevision')
  if (!workspaceRevision.ok) return workspaceRevision
  return {
    ok: true,
    value: {
      ownerId: ownerId.value,
      workspaceId: workspaceId.value,
      tripId: tripId.value,
      workspaceRevision: workspaceRevision.value,
    },
  }
}

function parseEpoch(value: unknown, path: string): WorkspaceValidationResult<number> {
  return requiredNumber(value, path, 0, MAX_SAFE_WORKSPACE_REVISION)
}

export function validatePlanScope(
  value: unknown,
  record?: WorkspaceRecordV1,
): WorkspaceValidationResult<PlanScopeV1> {
  const object = readObject(value, '$.planScope', ['scope', 'day', 'anchorStopId'])
  if (!object.ok) return object
  const v = object.value
  const scope = takeEnum(v.scope, '$.planScope.scope', ['trip_plan', 'day', 'day_tail'] as const)
  if (!scope.ok) return scope
  const day = optionalDay(v.day, '$.planScope.day')
  if (!day.ok) return day
  const anchorStopId = optionalId(v.anchorStopId, '$.planScope.anchorStopId')
  if (!anchorStopId.ok) return anchorStopId
  if (scope.value === 'trip_plan') {
    if (day.value !== null || anchorStopId.value !== null) {
      return fail('invalid_field', '$.planScope', 'trip_plan 作用域不能带 day 或 anchorStopId。')
    }
  } else if (scope.value === 'day') {
    if (day.value === null || anchorStopId.value !== null) {
      return fail('invalid_field', '$.planScope', 'day 作用域必须带 day，且 anchorStopId 必须为 null。')
    }
  } else if (day.value === null || anchorStopId.value === null) {
    return fail('invalid_field', '$.planScope', 'day_tail 作用域必须同时带 day 与 anchorStopId。')
  }
  const parsed: PlanScopeV1 = { scope: scope.value, day: day.value, anchorStopId: anchorStopId.value }
  if (record !== undefined && !planScopeMatchesRecord(parsed, record)) {
    return fail('invalid_field', '$.planScope', '作用域与当前工作区不匹配（天或锚点 stop 不存在）。')
  }
  return { ok: true, value: parsed }
}

export function planScopeMatchesRecord(scope: PlanScopeV1, record: WorkspaceRecordV1): boolean {
  if (scope.scope === 'trip_plan') return true
  if (scope.day === null) return false
  const day = record.trip.days.find((item) => item.day === scope.day)
  if (!day) return false
  if (scope.scope === 'day_tail') {
    if (scope.anchorStopId === null) return false
    return day.stops.some((stop) => stop.id === scope.anchorStopId)
  }
  return true
}

export function validateWorkspaceOwner(value: unknown): WorkspaceValidationResult<WorkspaceOwnerV1> {
  const object = readObject(value, '$', [
    'ownerId',
    'workspaceId',
    'tripId',
    'workspaceRevision',
    'epoch',
    'snapshot',
  ])
  if (!object.ok) return object
  const v = object.value
  const ownerId = requiredId(v.ownerId, '$.ownerId')
  if (!ownerId.ok) return ownerId
  const workspaceId = requiredId(v.workspaceId, '$.workspaceId')
  if (!workspaceId.ok) return workspaceId
  const tripId = requiredId(v.tripId, '$.tripId')
  if (!tripId.ok) return tripId
  const workspaceRevision = requiredRevision(v.workspaceRevision, '$.workspaceRevision')
  if (!workspaceRevision.ok) return workspaceRevision
  const epoch = parseEpoch(v.epoch, '$.epoch')
  if (!epoch.ok) return epoch
  const snapshot = parseFingerprint(v.snapshot, '$.snapshot', MAX_WORKSPACE_RECORD_BYTES)
  if (!snapshot.ok) return snapshot
  return {
    ok: true,
    value: {
      ownerId: ownerId.value,
      workspaceId: workspaceId.value,
      tripId: tripId.value,
      workspaceRevision: workspaceRevision.value,
      epoch: epoch.value,
      snapshot: snapshot.value,
    },
  }
}

/**
 * 完整 owner token：整条工作区记录的 canonical 快照 + identity + revision + epoch。
 * 在途 AI / 路线 / 预算 / 备份 pending 都可用它做四件套守卫。
 */
export function createWorkspaceOwner(
  record: WorkspaceRecordV1,
  epoch: number,
): WorkspaceValidationResult<WorkspaceOwnerV1> {
  const recordCheck = validateWorkspaceRecord(record)
  if (!recordCheck.ok) return recordCheck
  const epochCheck = parseEpoch(epoch, '$.epoch')
  if (!epochCheck.ok) return epochCheck
  const fingerprint = fingerprintOf(record)
  if (!fingerprint.ok) {
    return fail('unserializable', fingerprint.path, fingerprint.message)
  }
  return {
    ok: true,
    value: {
      ...workspaceIdentityOf(record),
      epoch: epochCheck.value,
      snapshot: fingerprint.fingerprint,
    },
  }
}

/** owner 是否仍对应当前记录 + 当前 epoch；short 不参与，必须全文一致。 */
export function workspaceOwnerMatches(
  owner: WorkspaceOwnerV1,
  record: WorkspaceRecordV1,
  epoch: number,
): boolean {
  const ownerCheck = validateWorkspaceOwner(owner)
  if (!ownerCheck.ok) return false
  if (owner.epoch !== epoch) return false
  if (!workspaceIdentityMatches(owner, record)) return false
  const fingerprint = fingerprintOf(record)
  return fingerprint.ok && fingerprintsMatch(owner.snapshot, fingerprint.fingerprint)
}

/**
 * F2 候选绑定：owner 身份 + revision + 完整 constraints canonical + planScope + epoch。
 * 任何 Trip / 约束 / revision / epoch 变化都会失配；short 只作索引。
 */
export function createConstraintsBinding(
  record: WorkspaceRecordV1,
  constraints: ConstraintsV1,
  planScope: PlanScopeV1,
  epoch: number,
): WorkspaceValidationResult<ConstraintsBindingV1> {
  const recordCheck = validateWorkspaceRecord(record)
  if (!recordCheck.ok) return recordCheck
  const scopeCheck = validatePlanScope(planScope, record)
  if (!scopeCheck.ok) return scopeCheck
  const constraintsCheck = validateConstraintsForScope(constraints, scopeCheck.value, record)
  if (!constraintsCheck.ok) return constraintsCheck
  const epochCheck = parseEpoch(epoch, '$.epoch')
  if (!epochCheck.ok) return epochCheck
  const fingerprint = fingerprintOf(constraintsCheck.value)
  if (!fingerprint.ok) {
    return fail('unserializable', fingerprint.path, fingerprint.message)
  }
  return {
    ok: true,
    value: {
      owner: workspaceIdentityOf(record),
      constraints: fingerprint.fingerprint,
      planScope: scopeCheck.value,
      epoch: epochCheck.value,
    },
  }
}

export function constraintsBindingMatches(
  binding: ConstraintsBindingV1,
  record: WorkspaceRecordV1,
  constraints: ConstraintsV1,
  epoch: number,
): boolean {
  const object = readObject(binding, '$.binding', ['owner', 'constraints', 'planScope', 'epoch'])
  if (!object.ok) return false
  const owner = validateWorkspaceIdentity(object.value.owner)
  if (!owner.ok) return false
  if (!workspaceIdentityMatches(owner.value, record)) return false
  const bindingConstraints = parseFingerprint(object.value.constraints, '$.binding.constraints', MAX_WORKSPACE_SIDECAR_BYTES)
  if (!bindingConstraints.ok) return false
  const scope = validatePlanScope(object.value.planScope, record)
  if (!scope.ok) return false
  const scopedConstraints = validateConstraintsForScope(constraints, scope.value, record)
  if (!scopedConstraints.ok) return false
  const bindingEpoch = parseEpoch(object.value.epoch, '$.binding.epoch')
  if (!bindingEpoch.ok || bindingEpoch.value !== epoch) return false
  const current = fingerprintOf(scopedConstraints.value)
  return current.ok && fingerprintsMatch(bindingConstraints.value, current.fingerprint)
}

export function validateConstraintsBinding(value: unknown): WorkspaceValidationResult<ConstraintsBindingV1> {
  const object = readObject(value, '$.binding', ['owner', 'constraints', 'planScope', 'epoch'])
  if (!object.ok) return object
  const owner = validateWorkspaceIdentity(object.value.owner)
  if (!owner.ok) return owner
  const constraints = parseFingerprint(
    object.value.constraints,
    '$.binding.constraints',
    MAX_WORKSPACE_SIDECAR_BYTES,
  )
  if (!constraints.ok) return constraints
  const planScope = validatePlanScope(object.value.planScope)
  if (!planScope.ok) return planScope
  const epoch = parseEpoch(object.value.epoch, '$.binding.epoch')
  if (!epoch.ok) return epoch
  return {
    ok: true,
    value: {
      owner: owner.value,
      constraints: constraints.value,
      planScope: planScope.value,
      epoch: epoch.value,
    },
  }
}

/** U 级方案的独立确认；内容 / 身份 / revision / scope / epoch 任一变化即失效。 */
export function createUnverifiedConstraintsAck(
  record: WorkspaceRecordV1,
  constraints: ConstraintsV1,
  planScope: PlanScopeV1,
  epoch: number,
  acknowledgedAt: number,
): WorkspaceValidationResult<UnverifiedConstraintsAckV1> {
  const recordCheck = validateWorkspaceRecord(record)
  if (!recordCheck.ok) return recordCheck
  const scopeCheck = validatePlanScope(planScope, record)
  if (!scopeCheck.ok) return scopeCheck
  const constraintsCheck = validateConstraintsForScope(constraints, scopeCheck.value, record)
  if (!constraintsCheck.ok) return constraintsCheck
  const epochCheck = parseEpoch(epoch, '$.epoch')
  if (!epochCheck.ok) return epochCheck
  const acknowledgedCheck = requiredTimestamp(acknowledgedAt, '$.acknowledgedAt')
  if (!acknowledgedCheck.ok) return acknowledgedCheck
  const fingerprint = fingerprintOf(constraintsCheck.value)
  if (!fingerprint.ok) {
    return fail('unserializable', fingerprint.path, fingerprint.message)
  }
  return {
    ok: true,
    value: {
      ...workspaceIdentityOf(record),
      constraints: fingerprint.fingerprint,
      planScope: scopeCheck.value,
      epoch: epochCheck.value,
      acknowledgedAt: acknowledgedCheck.value,
    },
  }
}

export function validateUnverifiedConstraintsAck(
  value: unknown,
): WorkspaceValidationResult<UnverifiedConstraintsAckV1> {
  const object = readObject(value, '$', [
    'ownerId',
    'workspaceId',
    'tripId',
    'workspaceRevision',
    'constraints',
    'planScope',
    'epoch',
    'acknowledgedAt',
  ])
  if (!object.ok) return object
  const v = object.value
  const ownerId = requiredId(v.ownerId, '$.ownerId')
  if (!ownerId.ok) return ownerId
  const workspaceId = requiredId(v.workspaceId, '$.workspaceId')
  if (!workspaceId.ok) return workspaceId
  const tripId = requiredId(v.tripId, '$.tripId')
  if (!tripId.ok) return tripId
  const workspaceRevision = requiredRevision(v.workspaceRevision, '$.workspaceRevision')
  if (!workspaceRevision.ok) return workspaceRevision
  const constraints = parseFingerprint(v.constraints, '$.constraints', MAX_WORKSPACE_SIDECAR_BYTES)
  if (!constraints.ok) return constraints
  const planScope = validatePlanScope(v.planScope)
  if (!planScope.ok) return planScope
  const epoch = parseEpoch(v.epoch, '$.epoch')
  if (!epoch.ok) return epoch
  const acknowledgedAt = requiredTimestamp(v.acknowledgedAt, '$.acknowledgedAt')
  if (!acknowledgedAt.ok) return acknowledgedAt
  return {
    ok: true,
    value: {
      ownerId: ownerId.value,
      workspaceId: workspaceId.value,
      tripId: tripId.value,
      workspaceRevision: workspaceRevision.value,
      constraints: constraints.value,
      planScope: planScope.value,
      epoch: epoch.value,
      acknowledgedAt: acknowledgedAt.value,
    },
  }
}

export function unverifiedConstraintsAckMatches(
  ack: UnverifiedConstraintsAckV1,
  record: WorkspaceRecordV1,
  constraints: ConstraintsV1,
  epoch: number,
): boolean {
  const ackCheck = validateUnverifiedConstraintsAck(ack)
  if (!ackCheck.ok) return false
  if (ack.epoch !== epoch) return false
  if (!workspaceIdentityMatches(ack, record)) return false
  if (!planScopeMatchesRecord(ack.planScope, record)) return false
  const scopedConstraints = validateConstraintsForScope(constraints, ack.planScope, record)
  if (!scopedConstraints.ok) return false
  const current = fingerprintOf(scopedConstraints.value)
  return current.ok && fingerprintsMatch(ack.constraints, current.fingerprint)
}

/* ───────── 随机逻辑 ID（不是浏览器指纹） ───────── */

/**
 * 生成随机逻辑 ID。与 App 里既有的 newUuid 语义一致：优先 crypto.randomUUID，
 * 否则退回随机串。它不采集任何浏览器 / 设备信息，也不是指纹。
 *
 * 纯模块（anchors / constraints 等）仍优先接受调用方传入的 ID，方便测试与
 * 上层统一撤销；本 helper 只给需要现造 ID 的调用方使用。
 */
export function createLogicalId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

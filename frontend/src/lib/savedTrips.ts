import type { Trip } from './api'
import { isTripLike } from './api'

/**
 * 本地行程保存（仅当前浏览器）。
 *
 * 设计边界：
 * - 只写 localStorage，不请求后端、不上传、不跨设备同步；
 * - 显式点击「保存当前行程」才写入，读取不会顺手修改存储；
 * - 恢复数据必须重新过一遍结构校验，并受记录数 / 单条体积 / 总体积上限约束；
 * - 达到上限时 fail-closed：新增或更新明确失败，绝不自动淘汰任何旧记录；
 * - 存储里存在无法识别、重复或超限的记录时，读取只展示能确认的部分，
 *   任何普通保存 / 删除 / 撤销都拒绝写入，避免把跳过的原始数据覆盖掉；
 * - 损坏 JSON、无 window（SSR / 测试）、隐私模式禁用存储、配额满都返回可展示的状态，
 *   不抛异常给渲染层。
 */

/** localStorage 键名带版本号，未来结构变更时可另起键而不是误读旧数据 */
export const SAVED_TRIPS_STORAGE_KEY = 'travel-assistant:saved-trips:v1'
export const SAVED_TRIPS_VERSION = 1 as const

/** 最多保留 20 份；已达上限时新增保存会明确失败，不会自动丢弃旧记录 */
export const MAX_SAVED_TRIPS = 20
/** 单份行程序列化后的 UTF-8 体积上限（约 256 KB） */
export const MAX_SAVED_TRIP_BYTES = 256 * 1024
/** 全部保存记录的体积上限（约 1.5 MB），避免把 localStorage 塞满 */
export const MAX_SAVED_STORAGE_BYTES = 1_500_000

/** 读取上限比写入上限略宽，用于识别异常膨胀的存储值，而不是先解析再说 */
const MAX_RAW_STORED_BYTES = MAX_SAVED_STORAGE_BYTES + 64 * 1024

/** 数组 / 文本的硬上限：挡住损坏或恶意构造的巨型数据拖垮渲染 */
const MAX_DAYS = 31
const MAX_STOPS_PER_DAY = 100
const MAX_LEGS_PER_DAY = 100
const MAX_GEOMETRY_POINTS = 2_000
const MAX_TOTAL_STOPS = 5_000
const MAX_TOTAL_LEGS = 5_000
const MAX_WARNINGS = 50

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface SavedTrip {
  /** 与 trip.id 一致；同一行程重复保存时用它去重 */
  id: string
  /** 保存时刻（epoch ms） */
  savedAt: number
  trip: Trip
}

export type SavedTripsLoadStatus = 'ok' | 'empty' | 'unavailable' | 'corrupt'

export interface SavedTripsLoad {
  status: SavedTripsLoadStatus
  trips: SavedTrip[]
  /** 被忽略的无效 / 重复 / 超限记录数 */
  skipped: number
  message: string | null
}

export type SavedTripsFailureReason =
  | 'unavailable'
  | 'corrupt'
  /** 存储里有被忽略的无效 / 重复 / 超限记录：普通写入被拒绝，以免覆盖原始数据 */
  | 'anomaly'
  | 'invalid'
  | 'too_large'
  | 'limit'
  | 'quota'
  | 'missing'
  | 'unknown'

export type SaveTripResult =
  | {
      ok: true
      saved: SavedTrip
      /** 之前是否已有同一 trip.id 的记录 */
      existed: boolean
      /** 重复保存时内容是否变化（仅更新时间时为 false） */
      changed: boolean
      trips: SavedTrip[]
    }
  | { ok: false; reason: SavedTripsFailureReason; message: string }

export type DeleteSavedTripResult =
  | { ok: true; removed: SavedTrip; trips: SavedTrip[] }
  | { ok: false; reason: SavedTripsFailureReason; message: string }

export type UndoSavedTripResult =
  | {
      ok: true
      /** false 表示同 id 记录已在列表里（例如删除后又保存了同 id 的新版本），没有重复插入 */
      restored: boolean
      trips: SavedTrip[]
    }
  | { ok: false; reason: SavedTripsFailureReason; message: string }

export type ClearSavedTripsResult =
  | { ok: true }
  | { ok: false; reason: SavedTripsFailureReason; message: string }

const UNAVAILABLE_MESSAGE =
  '当前浏览器无法访问本地存储（可能是无痕模式、隐私设置禁用了站点数据，或页面不在浏览器环境中）。当前行程没有被保存。'

function failure(reason: SavedTripsFailureReason, message: string): { reason: SavedTripsFailureReason; message: string } {
  return { reason, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function textWithin(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null

/** 估算字符串 UTF-8 字节数，用于执行保存体积上限（不依赖 Blob） */
export function utf8ByteLength(value: string): number {
  if (encoder) return encoder.encode(value).byteLength
  let bytes = 0
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/**
 * 取得可用的 localStorage。SSR / 测试没有 window 时返回 null；
 * Safari 隐私模式等场景下访问 localStorage 本身就可能抛 SecurityError，也归为不可用。
 */
export function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

function isStorableTrip(value: unknown): value is Trip {
  if (!isTripLike(value)) return false
  const trip = value
  if (
    trip.id.length > 200 ||
    trip.destination.length > 200 ||
    trip.title.length > 500 ||
    trip.summary.length > 10_000 ||
    trip.warnings.length > MAX_WARNINGS ||
    !trip.warnings.every((warning) => warning.length <= 2_000) ||
    trip.days.length > MAX_DAYS
  ) {
    return false
  }

  const dayNumbers = new Set<number>()
  let totalStops = 0
  let totalLegs = 0

  for (const day of trip.days) {
    if (day.day < 1 || day.day > 366 || dayNumbers.has(day.day)) return false
    dayNumbers.add(day.day)
    if (
      day.title.length > 500 ||
      day.summary.length > 10_000 ||
      (day.date !== null && day.date.length > 64) ||
      day.stops.length > MAX_STOPS_PER_DAY ||
      day.legs.length > MAX_LEGS_PER_DAY
    ) {
      return false
    }
    totalStops += day.stops.length
    totalLegs += day.legs.length

    const stopIds = new Set<string>()
    for (const stop of day.stops) {
      if (stopIds.has(stop.id)) return false
      stopIds.add(stop.id)
      if (
        stop.id.length > 200 ||
        stop.name.length > 300 ||
        stop.time.length > 64 ||
        stop.description.length > 10_000 ||
        stop.address.length > 1_000 ||
        (stop.duration_minutes !== null &&
          (!isFiniteNumber(stop.duration_minutes) ||
            stop.duration_minutes < 0 ||
            stop.duration_minutes > 100_000)) ||
        (stop.location !== null &&
          (!isFiniteNumber(stop.location.lng) || !isFiniteNumber(stop.location.lat)))
      ) {
        return false
      }
    }

    for (const leg of day.legs) {
      if (
        leg.from_stop_id.length > 200 ||
        leg.to_stop_id.length > 200 ||
        leg.description.length > 5_000 ||
        (leg.distance_m !== null &&
          (!isFiniteNumber(leg.distance_m) || leg.distance_m < 0 || leg.distance_m > 10_000_000)) ||
        (leg.duration_minutes !== null &&
          (!isFiniteNumber(leg.duration_minutes) ||
            leg.duration_minutes < 0 ||
            leg.duration_minutes > 100_000)) ||
        leg.geometry.length > MAX_GEOMETRY_POINTS ||
        !leg.geometry.every((point) => isFiniteNumber(point.lng) && isFiniteNumber(point.lat))
      ) {
        return false
      }
    }
  }

  return totalStops <= MAX_TOTAL_STOPS && totalLegs <= MAX_TOTAL_LEGS
}

function isStoredTripRecord(value: unknown): value is SavedTrip {
  if (!isRecord(value)) return false
  const { id, savedAt, trip } = value
  if (!textWithin(id, 200) || id.length === 0) return false
  if (!isInteger(savedAt) || savedAt <= 0) return false
  if (!isStorableTrip(trip) || trip.id !== id) return false
  try {
    return utf8ByteLength(JSON.stringify(value)) <= MAX_SAVED_TRIP_BYTES
  } catch {
    return false
  }
}

function serializeEnvelope(trips: SavedTrip[]): string {
  return JSON.stringify({ version: SAVED_TRIPS_VERSION, trips })
}

function envelopeBytes(trips: SavedTrip[]): number {
  return utf8ByteLength(serializeEnvelope(trips))
}

function loadFailure(reason: 'unavailable' | 'corrupt', message: string): SavedTripsLoad {
  return { status: reason, trips: [], skipped: 0, message }
}

function isSecurityError(error: unknown): boolean {
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'SecurityError'
  )
}

function mapLoadError(error: unknown): SavedTripsLoad {
  if (isSecurityError(error)) {
    return loadFailure(
      'unavailable',
      '浏览器拒绝读取本地存储（可能是隐私模式或站点数据被禁用）。当前列表无法显示，保存和恢复暂不可用。',
    )
  }
  return loadFailure(
    'unavailable',
    `读取本地保存数据失败：${error instanceof Error ? error.message : String(error)}。当前行程不会被修改。`,
  )
}

/**
 * 读取并校验保存列表。返回的 trips 按 savedAt 从新到旧排列。
 * 单条无效不会影响其他记录；整体 JSON 坏了则返回 corrupt，让 UI 明确提示而不是假装没有数据。
 */
export function loadSavedTrips(storage: StorageLike | null = getLocalStorage()): SavedTripsLoad {
  if (!storage) return loadFailure('unavailable', UNAVAILABLE_MESSAGE)

  let raw: string | null
  try {
    raw = storage.getItem(SAVED_TRIPS_STORAGE_KEY)
  } catch (error) {
    return mapLoadError(error)
  }

  if (raw === null) {
    return { status: 'empty', trips: [], skipped: 0, message: null }
  }
  if (typeof raw !== 'string') {
    return loadFailure('corrupt', '本地保存数据的类型异常，已停止读取；保存已暂停，避免覆盖未知内容。')
  }
  if (raw.trim() === '') {
    return { status: 'empty', trips: [], skipped: 0, message: null }
  }
  const rawBytes = utf8ByteLength(raw)
  if (rawBytes > MAX_RAW_STORED_BYTES) {
    return loadFailure(
      'corrupt',
      `本地保存数据体积异常（约 ${Math.ceil(rawBytes / 1024)} KB），超过可安全读取的上限，已停止读取。`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return loadFailure('corrupt', '本地保存数据不是合法 JSON，可能已损坏。为避免覆盖，保存已暂停。')
  }

  if (
    !isRecord(parsed) ||
    parsed.version !== SAVED_TRIPS_VERSION ||
    !Array.isArray(parsed.trips)
  ) {
    return loadFailure('corrupt', '本地保存数据的版本或结构不符合当前前端约定，已停止读取。')
  }

  let skipped = 0
  const byId = new Map<string, SavedTrip>()
  for (const value of parsed.trips) {
    if (!isStoredTripRecord(value)) {
      skipped += 1
      continue
    }
    const previous = byId.get(value.id)
    if (previous) {
      skipped += 1
      if (previous.savedAt >= value.savedAt) continue
    }
    byId.set(value.id, value)
  }

  let trips = [...byId.values()].sort((a, b) => b.savedAt - a.savedAt)
  if (trips.length > MAX_SAVED_TRIPS) {
    skipped += trips.length - MAX_SAVED_TRIPS
    trips = trips.slice(0, MAX_SAVED_TRIPS)
  }
  // 总量超限时只保留较新的记录；单条已通过上限校验，不会无限循环
  while (trips.length > 0 && envelopeBytes(trips) > MAX_SAVED_STORAGE_BYTES) {
    trips = trips.slice(0, -1)
    skipped += 1
  }

  const message = skipped > 0
    ? `有 ${skipped} 条保存记录无法识别、重复或超出上限，已忽略并保留原始数据；为避免覆盖这些数据，保存、删除和撤销已暂停。`
    : null
  return {
    status: trips.length > 0 ? 'ok' : 'empty',
    trips,
    skipped,
    message,
  }
}

/**
 * 存储里存在无法完整还原的记录时，普通写入一律拒绝。
 * 不能只写回「能识别的那部分」，否则跳过的无效 / 重复 / 超限记录会被永久覆盖。
 */
function anomalyFailure(skipped: number): { reason: SavedTripsFailureReason; message: string } {
  return failure(
    'anomaly',
    `本地保存里还有 ${skipped} 条无法识别、重复或超出上限的记录。为避免覆盖这些原始数据，这次操作没有写入任何内容。` +
      '仍可查看和恢复能读到的记录；确认不再需要这些数据后，用「清除全部本地数据」重置后再继续。',
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

function mapWriteError(error: unknown): { reason: SavedTripsFailureReason; message: string } {
  if (isQuotaError(error)) {
    return failure(
      'quota',
      '浏览器本地存储已满，当前行程没有保存。请删除一些已保存行程后重试；清除浏览器站点数据也会一并删除这些行程。',
    )
  }
  if (isSecurityError(error)) {
    return failure('unavailable', '浏览器拒绝写入本地存储（可能是隐私模式或站点数据被禁用），当前行程没有保存。')
  }
  return failure(
    'unknown',
    `写入本地存储失败${error instanceof Error && error.message ? `：${error.message}` : ''}。当前行程没有保存，请重试或检查浏览器设置。`,
  )
}

function writeTrips(
  storage: StorageLike,
  trips: SavedTrip[],
): { reason: SavedTripsFailureReason; message: string } | null {
  let payload: string
  try {
    payload = serializeEnvelope(trips)
  } catch (error) {
    return failure(
      'unknown',
      `行程数据无法序列化${error instanceof Error && error.message ? `：${error.message}` : ''}，没有写入本地存储。`,
    )
  }
  try {
    storage.setItem(SAVED_TRIPS_STORAGE_KEY, payload)
    return null
  } catch (error) {
    return mapWriteError(error)
  }
}

/**
 * 保存当前行程到本地。同一 trip.id 重复保存只更新原记录（不产生重复项），
 * 并同步新的 savedAt。达到份数 / 总体积上限时明确失败并提示用户先删除，
 * 不会自动淘汰任何旧记录；存储里存在被忽略的记录时也拒绝写入。
 */
export function saveTripToStorage(
  trip: Trip,
  storage: StorageLike | null = getLocalStorage(),
): SaveTripResult {
  if (!storage) return { ok: false, ...failure('unavailable', UNAVAILABLE_MESSAGE) }
  if (!isStorableTrip(trip)) {
    return {
      ok: false,
      ...failure('invalid', '当前行程的数据结构不完整或包含异常字段，未保存到本地。请重新生成行程后再试。'),
    }
  }

  const current = loadSavedTrips(storage)
  if (current.status === 'unavailable') {
    return { ok: false, ...failure('unavailable', current.message ?? UNAVAILABLE_MESSAGE) }
  }
  if (current.status === 'corrupt') {
    return {
      ok: false,
      ...failure(
        'corrupt',
        `${current.message ?? '本地保存数据已损坏。'} 为避免覆盖旧数据，这次保存已暂停；请先在「已保存行程」里清除全部本地数据，或继续保留现有内容。`,
      ),
    }
  }
  if (current.skipped > 0) return { ok: false, ...anomalyFailure(current.skipped) }

  const previous = current.trips.find((record) => record.id === trip.id)
  const saved: SavedTrip = { id: trip.id, savedAt: Date.now(), trip }
  let recordBytes: number
  try {
    recordBytes = utf8ByteLength(JSON.stringify(saved))
  } catch (error) {
    return {
      ok: false,
      ...failure(
        'invalid',
        `当前行程无法序列化${error instanceof Error && error.message ? `：${error.message}` : ''}，未保存。`,
      ),
    }
  }
  if (recordBytes > MAX_SAVED_TRIP_BYTES) {
    return {
      ok: false,
      ...failure(
        'too_large',
        `这份行程序列化后约 ${Math.ceil(recordBytes / 1024)} KB，超过单份 ${Math.round(MAX_SAVED_TRIP_BYTES / 1024)} KB 的保存上限，未保存。可以精简行程或只保留天数较少的版本。`,
      ),
    }
  }

  const next = [saved, ...current.trips.filter((record) => record.id !== trip.id)]
    .sort((a, b) => b.savedAt - a.savedAt)

  // 数量上限：只剩「同 id 更新」不会增加条数，因此这里只挡真正的新增
  if (next.length > MAX_SAVED_TRIPS) {
    return {
      ok: false,
      ...failure(
        'limit',
        `本地最多保存 ${MAX_SAVED_TRIPS} 份行程，当前已有 ${current.trips.length} 份。为不丢掉已有记录，这次保存没有写入；请先在「已保存行程」里删除一份，再保存当前行程。`,
      ),
    }
  }
  if (envelopeBytes(next) > MAX_SAVED_STORAGE_BYTES) {
    return {
      ok: false,
      ...failure(
        'too_large',
        `保存当前行程后会超过本地总容量上限（约 ${Math.round(MAX_SAVED_STORAGE_BYTES / 1024)} KB）。为不丢掉已有记录，这次保存没有写入；请先删除一些已保存行程再试。`,
      ),
    }
  }

  const writeError = writeTrips(storage, next)
  if (writeError) return { ok: false, ...writeError }

  return {
    ok: true,
    saved,
    existed: Boolean(previous),
    changed: previous ? JSON.stringify(previous.trip) !== JSON.stringify(trip) : false,
    trips: next,
  }
}

/** 删除一条保存记录。UI 在内存里保留返回值，即可实现「撤销删除」 */
export function deleteSavedTrip(
  id: string,
  storage: StorageLike | null = getLocalStorage(),
): DeleteSavedTripResult {
  if (!storage) return { ok: false, ...failure('unavailable', UNAVAILABLE_MESSAGE) }
  const current = loadSavedTrips(storage)
  if (current.status === 'unavailable' || current.status === 'corrupt') {
    return {
      ok: false,
      ...failure(current.status, current.message ?? '读取本地保存数据失败，未删除任何内容。'),
    }
  }
  if (current.skipped > 0) return { ok: false, ...anomalyFailure(current.skipped) }
  const index = current.trips.findIndex((record) => record.id === id)
  if (index < 0) {
    return {
      ok: false,
      ...failure('missing', '这条保存记录已不存在，列表可能已在其他标签页更新。'),
    }
  }
  const removed = current.trips[index]
  const trips = current.trips.filter((record) => record.id !== id)
  const writeError = writeTrips(storage, trips)
  if (writeError) return { ok: false, ...writeError }
  return { ok: true, removed, trips }
}

/** 撤销删除：把原记录放回，按保存时间重新排序 */
export function undoSavedTripDeletion(
  record: SavedTrip,
  storage: StorageLike | null = getLocalStorage(),
): UndoSavedTripResult {
  if (!storage) return { ok: false, ...failure('unavailable', UNAVAILABLE_MESSAGE) }
  if (!isStoredTripRecord(record)) {
    return { ok: false, ...failure('invalid', '待恢复的保存记录已损坏，无法撤销删除。') }
  }
  const current = loadSavedTrips(storage)
  if (current.status === 'unavailable' || current.status === 'corrupt') {
    return {
      ok: false,
      ...failure(current.status, current.message ?? '读取本地保存数据失败，撤销未完成。'),
    }
  }
  if (current.skipped > 0) return { ok: false, ...anomalyFailure(current.skipped) }
  if (current.trips.some((item) => item.id === record.id)) {
    return { ok: true, restored: false, trips: current.trips }
  }

  const trips = [...current.trips, record].sort((a, b) => b.savedAt - a.savedAt)
  if (trips.length > MAX_SAVED_TRIPS) {
    return {
      ok: false,
      ...failure('limit', `本地最多保存 ${MAX_SAVED_TRIPS} 份行程，当前已满，撤销删除未完成。请先删除一份其他行程再撤销。`),
    }
  }
  if (envelopeBytes(trips) > MAX_SAVED_STORAGE_BYTES) {
    return {
      ok: false,
      ...failure('limit', '撤销后会超过本地保存的容量上限，未完成。请先删除一份其他行程再撤销。'),
    }
  }
  const writeError = writeTrips(storage, trips)
  if (writeError) return { ok: false, ...writeError }
  return { ok: true, restored: true, trips }
}

/** 清除损坏的本地保存数据（只用于用户明确确认后的修复流程） */
export function clearSavedTrips(storage: StorageLike | null = getLocalStorage()): ClearSavedTripsResult {
  if (!storage) return { ok: false, ...failure('unavailable', UNAVAILABLE_MESSAGE) }
  try {
    storage.removeItem(SAVED_TRIPS_STORAGE_KEY)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      ...failure(
        'unknown',
        `清除本地保存数据失败${error instanceof Error && error.message ? `：${error.message}` : ''}，请检查浏览器设置后重试。`,
      ),
    }
  }
}

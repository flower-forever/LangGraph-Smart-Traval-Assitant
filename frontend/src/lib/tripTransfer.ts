/**
 * 单份行程的版本化 JSON 备份与解析。
 *
 * 边界：
 * - 纯函数模块：不碰文件系统、不碰 localStorage、不发任何网络请求。浏览器侧的 Blob / 下载 /
 *   读文件在 ./tripFile.ts。
 * - 导出只写 ./api.ts 里 Trip 契约的已知字段，其余字段（包括长得像凭据的假 key）一律不落盘；
 *   投影按原值拷贝，坐标数字、leg geometry 的每个点、day.date 都逐字保留，不取整、不抽稀、不补全。
 * - 导出的是明文 JSON，包含用户可能自己填写的描述（行程摘要、站点描述等），不做脱敏。
 *   导出结果带 TRIP_JSON_SHARE_NOTICE，界面需要把这条提示展示给用户。
 * - 解析按「体积 → 语法（容忍一个前导 UTF-8 BOM）→ format/version → 结构」的顺序 fail-closed，
 *   失败文案是固定文本，不回显文件内容；本模块产出的字符串由调用方交给文本节点或文件下载，
 *   不作为 HTML 渲染。
 * - 结构校验复用 ./savedTrips.ts 的 checkTripShape：重复 day、重复站点 ID、字段超长、
 *   天数 / 站点 / 路段数量、每段 5000 点、全行程点数预算都和本地保存同一套约束，
 *   所以「能预览 / 能打开」的行程一定也能保存，反过来静态拒绝的行程也不会进预览。
 * - 单份体积同样复用 savedTrips 的口径（id + savedAt + trip 的记录字节），不只算 trip 本身，
 *   边界文件不会出现「导入通过、保存必然失败」。
 * - 体积上限只说明体积：达到上限是 too_large，不是 invalid；两者都不写任何数据。
 */

import type { Trip, TripDay, TripLeg, TripLocation, TripStop } from './api'
import { isTripLike } from './api'
import {
  MAX_GEOMETRY_POINTS_PER_LEG,
  MAX_SAVED_TRIP_BYTES,
  MAX_TOTAL_GEOMETRY_POINTS as SHARED_TOTAL_GEOMETRY_POINTS,
  checkTripShape,
  savedTripRecordBytes,
  utf8ByteLength,
} from './savedTrips'

/** 备份文件的 format 标识；改结构时必须同时升 version，避免旧前端误读新数据 */
export const TRIP_TRANSFER_FORMAT = 'travel-assistant.trip'

/** 当前写出的结构版本；解析时只认这个数字，字符串 '1' 也算不匹配 */
export const TRIP_TRANSFER_VERSION = 1

/** .json 备份的 MIME；带 charset 让接收端按 UTF-8 解码中文 */
export const TRIP_TRANSFER_MIME_TYPE = 'application/json;charset=utf-8'

export const TRIP_TRANSFER_FILE_EXTENSION = '.json'

/** trip 字段投影后的 UTF-8 上限（640 KB），与本地保存的单份上限同源 */
export const MAX_TRIP_TRANSFER_BYTES = MAX_SAVED_TRIP_BYTES

/** 文件级门禁：比 payload 上限多留 64 KB 给 format/version/exportedAt 与 JSON 空白 */
export const MAX_TRIP_FILE_BYTES = MAX_TRIP_TRANSFER_BYTES + 64 * 1024

/**
 * 全行程几何点数的预算（40 000），与 ./savedTrips.ts 共用同一个常量：
 * 每个点最省也要约 20 字节，40 000 点必然超过 640 KB，命中预算的行程只会得到 too_large。
 */
export const MAX_TOTAL_GEOMETRY_POINTS = SHARED_TOTAL_GEOMETRY_POINTS

/** 明文分享提醒：导出的是可读 JSON，里面可能有用户自己写的描述 */
export const TRIP_JSON_SHARE_NOTICE =
  '这是一份明文 JSON 文件：行程标题、站点名称、描述等字段按导出时的原样保存，' +
  '其中可能包含你自己填写的描述内容。分享或上传前请确认这些内容可以外传，本工具不做脱敏。'

const MESSAGE_PARSE_ERROR = '文件内容不是合法的 JSON，无法读取。请确认选择的是本工具导出的行程备份文件。'
const MESSAGE_NOT_TEXT = '文件内容不是文本，无法读取。请确认选择的是 UTF-8 编码的 JSON 备份文件。'
const MESSAGE_FORMAT_MISMATCH = '这个文件不是本工具的行程备份（format 字段不匹配），未导入任何内容。'
const MESSAGE_VERSION_MISMATCH =
  `备份文件的结构版本不受支持：当前只支持第 ${TRIP_TRANSFER_VERSION} 版的行程备份，未导入任何内容。`
const MESSAGE_INVALID_TRIP =
  '这份行程的数据结构不完整或包含异常内容（重复的天数、重复的站点 ID、字段超长、' +
  `天数 / 站点 / 路段数量异常，或单条路线几何超过 ${MAX_GEOMETRY_POINTS_PER_LEG} 个点），未导出或导入。`
const MESSAGE_GEOMETRY_BUDGET =
  `这份行程包含的路线几何点超过 ${MAX_TOTAL_GEOMETRY_POINTS} 个，体积必然超过单份 ` +
  `${Math.round(MAX_TRIP_TRANSFER_BYTES / 1024)} KB 的备份与本地保存上限，未导出或导入。`
const MESSAGE_INVALID_EXPORT_TIME = '导出时间无效，没有生成备份文件。'

/** 体积超限的固定文案；bytes / limit 都是本模块的常量或文件大小，不含文件内容 */
export function formatTooLargeMessage(bytes: number, limit = MAX_TRIP_FILE_BYTES): string {
  const sizeKb = Math.max(1, Math.ceil(bytes / 1024))
  const limitKb = Math.max(1, Math.round(limit / 1024))
  return `文件体积约 ${sizeKb} KB，超过 ${limitKb} KB 的上限，已拒绝，未导入任何内容。`
}

/**
 * 文件里的 exportedAt 是不可信数据：可以是任意长度、任意内容的字符串。
 * 这里只接受规范的 ISO 8601 时间戳（本工具写出的是 `toISOString()` 的 UTC 形式，
 * 同时兼容带 `±HH:MM` 时区偏移的写法），统一换算成 `YYYY-MM-DD HH:mm UTC` 再展示。
 *
 * 其他内容一律不原样回显：可能是超长文本、HTML 片段或误导性的说明，
 * 这里只给固定文案。这样界面不会被极长字符串撑坏，也不会把文件内容当成可信时间展示。
 */
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/

const DISPLAY_MISSING_EXPORT_TIME = '文件里没有记录导出时间'
const DISPLAY_UNREADABLE_EXPORT_TIME = '文件里记录的导出时间格式无法识别，已忽略'

/** 把文件自述的导出时间转成固定长度的展示文本；不合法内容不原样回显 */
export function formatTripExportedAt(value: string | null): string {
  if (value === null) return DISPLAY_MISSING_EXPORT_TIME
  const match = ISO_INSTANT_PATTERN.exec(value)
  if (!match) return DISPLAY_UNREADABLE_EXPORT_TIME

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  // 4 位年份从 1000 起：更早的年份交给 Date.UTC 会被映射成 1900 + year
  if (year < 1000 || year > 9999) return DISPLAY_UNREADABLE_EXPORT_TIME

  // Date.UTC 会把越界字段顺手进位（2 月 31 日 → 3 月 3 日），回读校验挡掉这种情况
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day ||
    utc.getUTCHours() !== hour ||
    utc.getUTCMinutes() !== minute ||
    utc.getUTCSeconds() !== second
  ) {
    return DISPLAY_UNREADABLE_EXPORT_TIME
  }

  const sign = match[7]
  let instant = utc
  if (sign) {
    const offsetHours = Number(match[8])
    const offsetMinutes = Number(match[9])
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
      return DISPLAY_UNREADABLE_EXPORT_TIME
    }
    const offset = (offsetHours * 60 + offsetMinutes) * (sign === '-' ? -1 : 1)
    instant = new Date(utc.getTime() - offset * 60_000)
  }

  const iso = instant.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

export type TripProjectionFailureReason = 'invalid_trip' | 'too_large'

export type TripProjection =
  | { ok: true; trip: Trip }
  | { ok: false; reason: TripProjectionFailureReason; message: string }

export type TripBackupFailureReason = 'invalid_trip' | 'too_large' | 'invalid_export_time'

export type TripBackup =
  | {
      ok: true
      /** 完整备份 JSON 文本（UTF-8，无 BOM，无网络） */
      json: string
      /** trip 字段投影后的 UTF-8 字节数（展示用；单份容量另按记录字节判定） */
      bytes: number
      /** ISO 8601 UTC 时间戳 */
      exportedAt: string
      /** 需要展示给用户的固定提示（明文分享提醒等） */
      notices: string[]
    }
  | { ok: false; reason: TripBackupFailureReason; message: string }

export type TripImportFailureReason =
  | 'too_large'
  | 'parse_error'
  | 'format_mismatch'
  | 'version_mismatch'
  | 'invalid_trip'

export interface TripImportSuccess {
  ok: true
  /** 投影后的行程：只含 Trip 已知字段 */
  trip: Trip
  /** 文件声明的导出时间；字段缺失或不是字符串时为 null */
  exportedAt: string | null
  /** 投影后 trip 的 UTF-8 字节数（展示用；单份容量另按记录字节判定） */
  bytes: number
  /** 需要展示给用户的固定提示（明文分享提醒等） */
  notices: string[]
}

export type TripImportFailure = { ok: false; reason: TripImportFailureReason; message: string }

export type TripImport = TripImportSuccess | TripImportFailure

/** 备份文件的结构；字段顺序固定，便于人眼比对 diff */
export interface TripBackupEnvelope {
  format: string
  version: number
  exportedAt: string
  trip: Trip
}

export interface TripBackupOptions {
  /** 导出时间；缺省取当前时间。测试传固定值 */
  now?: Date | number | string
}

export interface TripImportOptions {
  /** 文本 UTF-8 上限；缺省 MAX_TRIP_FILE_BYTES */
  maxBytes?: number
}

/** 投影失败的哨兵值；用独立 symbol 避免和 null / undefined 混淆 */
const FAIL = Symbol('trip-projection-failed')

type Probe<T> = T | typeof FAIL

interface ProjectionBudget {
  totalGeometryPoints: number
  failure: TripProjectionFailureReason | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectLocation(value: unknown): Probe<TripLocation> {
  if (!isRecord(value)) return FAIL
  const { lng, lat } = value
  if (typeof lng !== 'number' || !Number.isFinite(lng)) return FAIL
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return FAIL
  // 原值拷贝，不做取整：geometry 与后端返回逐点一致
  return { lng, lat }
}

function projectLocationOrNull(value: unknown): Probe<TripLocation | null> {
  if (value === null) return null
  return projectLocation(value)
}

function projectNumberOrNull(value: unknown): Probe<number | null> {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : FAIL
}

function projectStringOrNull(value: unknown): Probe<string | null> {
  if (value === null) return null
  return typeof value === 'string' ? value : FAIL
}

function projectStop(value: unknown): Probe<TripStop> {
  if (!isRecord(value)) return FAIL
  const { id, name, time, description, address } = value
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof time !== 'string' ||
    typeof description !== 'string' ||
    typeof address !== 'string'
  ) {
    return FAIL
  }
  const duration = projectNumberOrNull(value.duration_minutes)
  if (duration === FAIL) return FAIL
  const location = projectLocationOrNull(value.location)
  if (location === FAIL) return FAIL
  return { id, name, time, duration_minutes: duration, description, address, location }
}

function projectLeg(value: unknown, budget: ProjectionBudget): Probe<TripLeg> {
  if (!isRecord(value)) return FAIL
  const { from_stop_id: fromStopId, to_stop_id: toStopId, description } = value
  if (
    typeof fromStopId !== 'string' ||
    typeof toStopId !== 'string' ||
    typeof description !== 'string'
  ) {
    return FAIL
  }
  const mode = value.mode
  if (mode !== 'walking' && mode !== 'driving') return FAIL
  const routeType = value.route_type
  if (routeType !== 'navigation' && routeType !== 'straight_line' && routeType !== 'unavailable') {
    return FAIL
  }
  const distance = projectNumberOrNull(value.distance_m)
  if (distance === FAIL) return FAIL
  const duration = projectNumberOrNull(value.duration_minutes)
  if (duration === FAIL) return FAIL

  const geometry = value.geometry
  if (!Array.isArray(geometry)) return FAIL
  // 先看长度再逐点遍历：超长几何不进入循环，避免异常数据拖慢校验
  if (geometry.length > MAX_GEOMETRY_POINTS_PER_LEG) {
    budget.failure ??= 'invalid_trip'
    return FAIL
  }
  budget.totalGeometryPoints += geometry.length
  if (budget.totalGeometryPoints > MAX_TOTAL_GEOMETRY_POINTS) {
    budget.failure = 'too_large'
    return FAIL
  }
  const points: TripLocation[] = []
  for (const point of geometry) {
    const projected = projectLocation(point)
    if (projected === FAIL) {
      budget.failure ??= 'invalid_trip'
      return FAIL
    }
    points.push(projected)
  }

  return {
    from_stop_id: fromStopId,
    to_stop_id: toStopId,
    mode,
    route_type: routeType,
    distance_m: distance,
    duration_minutes: duration,
    geometry: points,
    description,
  }
}

function projectDay(value: unknown, budget: ProjectionBudget): Probe<TripDay> {
  if (!isRecord(value)) return FAIL
  const { day: dayNumber, title, summary } = value
  if (typeof dayNumber !== 'number' || !Number.isSafeInteger(dayNumber)) return FAIL
  if (typeof title !== 'string' || typeof summary !== 'string') return FAIL
  const date = projectStringOrNull(value.date)
  if (date === FAIL) return FAIL

  const rawStops = value.stops
  const rawLegs = value.legs
  if (!Array.isArray(rawStops) || !Array.isArray(rawLegs)) return FAIL

  const stops: TripStop[] = []
  for (const stop of rawStops) {
    const projected = projectStop(stop)
    if (projected === FAIL) {
      budget.failure ??= 'invalid_trip'
      return FAIL
    }
    stops.push(projected)
  }
  const legs: TripLeg[] = []
  for (const leg of rawLegs) {
    const projected = projectLeg(leg, budget)
    if (projected === FAIL) return FAIL
    legs.push(projected)
  }
  return { day: dayNumber, date, title, summary, stops, legs }
}

function projectTripValue(value: Record<string, unknown>, budget: ProjectionBudget): Probe<Trip> {
  const { id, destination, title, summary } = value
  if (
    typeof id !== 'string' ||
    typeof destination !== 'string' ||
    typeof title !== 'string' ||
    typeof summary !== 'string'
  ) {
    return FAIL
  }
  const source = value.source
  if (source !== 'example' && source !== 'agent') return FAIL
  if (value.map_coordinate_system !== 'WGS84') return FAIL

  const rawWarnings = value.warnings
  const rawDays = value.days
  if (!Array.isArray(rawWarnings) || !Array.isArray(rawDays)) return FAIL
  const warnings: string[] = []
  for (const warning of rawWarnings) {
    if (typeof warning !== 'string') return FAIL
    warnings.push(warning)
  }
  const days: TripDay[] = []
  for (const day of rawDays) {
    const projected = projectDay(day, budget)
    if (projected === FAIL) return FAIL
    days.push(projected)
  }

  return {
    id,
    source,
    destination,
    title,
    summary,
    map_coordinate_system: 'WGS84',
    warnings,
    days,
  }
}

/**
 * 把任意值投影成只含 Trip 已知字段的对象。
 * 未知字段被丢弃（不是报错）；字段类型或枚举不对、几何超过后端上限都算 invalid_trip。
 * 注意：这里只做投影，不做重复 day / 重复站点 ID / 字段长度等结构约束——那些与本地保存
 * 共用的约束在 checkTripForTransfer 里（导出 / 导入都经过它）。
 */
export function projectTrip(value: unknown): TripProjection {
  if (!isTripLike(value)) return { ok: false, reason: 'invalid_trip', message: MESSAGE_INVALID_TRIP }
  const budget: ProjectionBudget = { totalGeometryPoints: 0, failure: null }
  const projected = projectTripValue(value as unknown as Record<string, unknown>, budget)
  if (projected === FAIL) {
    return budget.failure === 'too_large'
      ? { ok: false, reason: 'too_large', message: MESSAGE_GEOMETRY_BUDGET }
      : { ok: false, reason: 'invalid_trip', message: MESSAGE_INVALID_TRIP }
  }
  return { ok: true, trip: projected }
}

function normalizeIsoTimestamp(value: Date | number | string | undefined): string | null {
  if (value === undefined) return new Date().toISOString()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function payloadTooLargeMessage(bytes: number): string {
  return (
    `这份行程连同保存记录元数据约 ${Math.ceil(bytes / 1024)} KB，超过单份备份上限 ` +
    `（${Math.round(MAX_TRIP_TRANSFER_BYTES / 1024)} KB，与本地保存同一口径），未导出或导入。` +
    '行程本身可以正常查看，导出大行程需要先缩短路线或减少天数。'
  )
}

type TripTransferCheck =
  | { ok: true; trip: Trip; bytes: number; recordBytes: number }
  | { ok: false; reason: 'invalid_trip' | 'too_large'; message: string }

/**
 * 备份导出 / 导入共用的校验，顺序固定：
 * 1. 严格投影（只留 Trip 契约字段，未知属性剔除，类型 / 枚举严格）；
 * 2. 单份容量：按本地保存同一个计算对象（id + savedAt + trip）算字节，不只算 trip 本身；
 * 3. 结构约束：直接复用 ./savedTrips.ts 的 checkTripShape（重复 day、重复站点 ID、
 *    字段长度、天数 / 站点 / 路段数量、每段 5000 点、全行程点数预算）。
 *
 * 容量放在结构之前是为了让「体积明显超限」先落成 too_large（结构问题可能是体积的副作用），
 * 两条路径都是 fail-closed：不生成文件、不写 localStorage、不进入预览。
 * 导出与导入共用本函数，所以不会有「备份文件能导入、保存却必然失败」的边界差。
 */
export function checkTripForTransfer(value: unknown): TripTransferCheck {
  const projection = projectTrip(value)
  if (!projection.ok) return { ok: false, reason: projection.reason, message: projection.message }
  const trip = projection.trip

  let bytes: number
  let recordBytes: number
  try {
    bytes = utf8ByteLength(JSON.stringify(trip))
    recordBytes = savedTripRecordBytes(trip)
  } catch {
    return { ok: false, reason: 'invalid_trip', message: MESSAGE_INVALID_TRIP }
  }
  if (recordBytes > MAX_TRIP_TRANSFER_BYTES) {
    return { ok: false, reason: 'too_large', message: payloadTooLargeMessage(recordBytes) }
  }

  const shape = checkTripShape(trip)
  if (!shape.ok) {
    return shape.reason === 'too_large'
      ? { ok: false, reason: 'too_large', message: MESSAGE_GEOMETRY_BUDGET }
      : { ok: false, reason: 'invalid_trip', message: MESSAGE_INVALID_TRIP }
  }

  return { ok: true, trip, bytes, recordBytes }
}

/**
 * 生成版本化备份 JSON。导出前先按 Trip 契约投影并过一遍与本地保存相同的结构 / 容量校验，
 * 未知字段不会写进文件。只返回文本与统计，不创建 Blob、不触发下载、不做任何 I/O。
 */
export function createTripBackup(trip: Trip, options: TripBackupOptions = {}): TripBackup {
  const checked = checkTripForTransfer(trip)
  if (!checked.ok) return { ok: false, reason: checked.reason, message: checked.message }

  const exportedAt = normalizeIsoTimestamp(options.now)
  if (exportedAt === null) {
    return { ok: false, reason: 'invalid_export_time', message: MESSAGE_INVALID_EXPORT_TIME }
  }

  const envelope: TripBackupEnvelope = {
    format: TRIP_TRANSFER_FORMAT,
    version: TRIP_TRANSFER_VERSION,
    exportedAt,
    trip: checked.trip,
  }
  return {
    ok: true,
    json: JSON.stringify(envelope),
    bytes: checked.bytes,
    exportedAt,
    notices: [TRIP_JSON_SHARE_NOTICE],
  }
}

function failure(reason: TripImportFailureReason, message: string): TripImportFailure {
  return { ok: false, reason, message }
}

/**
 * 去掉一个前导 UTF-8 BOM。Windows 记事本、Excel 另存等工具写出的 UTF-8 文件会带 U+FEFF，
 * JSON.parse 见到它会直接抛错，用户会误以为文件损坏。只剥一个，剥完仍是坏内容就照常 parse_error。
 */
function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 解析备份文本。顺序是固定的：文件体积门禁 → JSON 语法 → format → version → 结构与单份容量。
 * 体积门禁在 JSON.parse 之前执行，异常文件不会被解析，也不会因为解析失败的文案泄露内容。
 * 结构 / 容量校验与本地保存共用 checkTripForTransfer，预览能打开就一定存得下。
 */
export function parseTripBackup(text: string, options: TripImportOptions = {}): TripImport {
  const limit = options.maxBytes ?? MAX_TRIP_FILE_BYTES
  if (typeof text !== 'string') return failure('parse_error', MESSAGE_NOT_TEXT)

  // 体积按原始文本计，BOM 也算进用户选的这份文件
  const textBytes = utf8ByteLength(text)
  if (textBytes > limit) return failure('too_large', formatTooLargeMessage(textBytes, limit))

  const body = stripLeadingBom(text)
  if (body.trim() === '') return failure('parse_error', MESSAGE_PARSE_ERROR)

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return failure('parse_error', MESSAGE_PARSE_ERROR)
  }
  if (!isRecord(parsed)) return failure('format_mismatch', MESSAGE_FORMAT_MISMATCH)

  if (parsed.format !== TRIP_TRANSFER_FORMAT) {
    return failure('format_mismatch', MESSAGE_FORMAT_MISMATCH)
  }
  if (parsed.version !== TRIP_TRANSFER_VERSION) {
    return failure('version_mismatch', MESSAGE_VERSION_MISMATCH)
  }

  const checked = checkTripForTransfer(parsed.trip)
  if (!checked.ok) return { ok: false, reason: checked.reason, message: checked.message }

  return {
    ok: true,
    trip: checked.trip,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null,
    bytes: checked.bytes,
    notices: [TRIP_JSON_SHARE_NOTICE],
  }
}

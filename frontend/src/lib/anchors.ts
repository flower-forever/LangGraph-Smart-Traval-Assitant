/**
 * F1 · 住宿与抵离锚点（纯函数）。
 *
 * 边界（docs/ANCHORS.md / docs/WORKSPACE_SIDECAR.md）：
 * - 只消费 `workspaceTypes` / `workspace` 的公开契约；不复制 schema、不写 storage、
 *   不读时钟、不发网络请求、不 geocode、不自动补坐标、不自动重排站点。
 * - 用户填写的 WGS84 坐标原样保留；坐标未知用 null，0 是合法坐标值，绝不写成
 *   (0, 0) 冒充未知。`locationSource` 只有用户提供坐标时才是 'user_provided'。
 * - 酒店实体 `hotelId` 可共享；每次酒店 visit 生成独立的 stop occurrence id。
 *   已有 stop 只 link，不复制、不改冻结 id。
 * - 只产出 proposal（草稿 / 预览），不修改当前 Trip / 工作区。显式 apply 由父级
 *   回调调用 `applyAnchorsProposal`（内部走 `commitWorkspaceTransition`）。
 * - 锚点本身不是 Trip 停靠；proposal 用 placement 明确区分「链接已有 stop」/
 *   「将新增独立 occurrence」/「仅参考」。只有用户显式 apply 后才会进入工作区。
 */
import type { TravelMode, Trip, TripDay, TripLeg, TripStop } from './api'
import { checkTripShape } from './savedTrips'
import { MAX_DRAFT_STOPS_PER_DAY } from './tripDraft'
import type {
  AccommodationAnchorV1,
  AnchorsV1,
  DailyAnchorsV1,
  DayAnchorV1,
  GeoPointV1,
  TransportAnchorV1,
  WorkspaceOwnerV1,
  WorkspaceRecordV1,
  WorkspaceSidecarV1,
  WorkspaceValidationReason,
  WorkspaceValidationResult,
} from './workspaceTypes'
import {
  commitWorkspaceTransition,
  createLogicalId,
  createWorkspaceOwner,
  validateAnchors,
  validateWorkspaceRecord,
  validateWorkspaceSidecar,
  workspaceOwnerMatches,
} from './workspace'
import { canonicalValuesEqual } from './workspaceFingerprint'

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

export type AnchorsFailureReason =
  | 'invalid_record'
  | 'invalid_trip'
  | 'invalid_anchors'
  | 'invalid_id'
  | 'invalid_coordinate'
  | 'invalid_date'
  | 'invalid_time'
  | 'invalid_leg_mode'
  | 'empty_accommodation'
  | 'missing_name'
  | 'missing_stop'
  | 'unknown_day'
  | 'unknown_stop'
  | 'unknown_hotel'
  | 'invalid_stay_range'
  | 'anchor_outside_stay'
  | 'anchor_date_mismatch'
  | 'duplicate_id'
  | 'stop_limit'
  | 'owner_mismatch'
  | 'invalid_proposal'
  | 'postcondition_failed'

export interface AnchorsFailure {
  ok: false
  reason: AnchorsFailureReason
  message: string
  path?: string
}

export type AnchorsResult<T> = { ok: true; value: T } | AnchorsFailure

function failure(reason: AnchorsFailureReason, message: string, path?: string): AnchorsFailure {
  return path === undefined ? { ok: false, reason, message } : { ok: false, reason, message, path }
}

function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function validId(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && value.trim().length > 0
}

function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return day <= (leap ? 29 : 28)
  }
  return day <= ([4, 6, 9, 11].includes(month) ? 30 : 31)
}

function parseClock(value: string): number | null {
  if (!TIME_PATTERN.test(value)) return null
  const [hour, minute] = value.split(':')
  return Number(hour) * 60 + Number(minute)
}

function formatClock(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440
  const hour = Math.floor(normalized / 60)
  const minute = normalized % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function formatEndClock(totalMinutes: number): string {
  if (totalMinutes < 1440) return formatClock(totalMinutes)
  return `次日 ${formatClock(totalMinutes)}`
}

function cloneLocation(location: GeoPointV1 | null): GeoPointV1 | null {
  return location === null ? null : { lng: location.lng, lat: location.lat }
}

/* ───────── 表单 <-> 契约结构（表单只服务于面板，不进入 storage） ───────── */

export interface AccommodationForm {
  hotelId: string | null
  name: string
  address: string
  lng: string
  lat: string
  checkInDate: string
  checkOutDate: string
}

export interface DayAnchorForm {
  anchorId: string | null
  kind: 'stop' | 'manual'
  stopId: string
  hotelId: string
  name: string
  address: string
  lng: string
  lat: string
  time: string
  date: string
}

export interface TransportAnchorForm {
  kind: 'airport' | 'station' | 'other'
  name: string
  date: string
  time: string
  lng: string
  lat: string
}

export interface DailyAnchorForm {
  start: DayAnchorForm | null
  end: DayAnchorForm | null
}

export interface AnchorsForm {
  accommodation: AccommodationForm | null
  daily: Record<string, DailyAnchorForm>
  arrival: TransportAnchorForm | null
  departure: TransportAnchorForm | null
}

export type AnchorsIdKind = 'hotel' | 'anchor' | 'stop'
export type AnchorsIdFactory = (kind: AnchorsIdKind) => string

export function emptyAnchorsForm(): AnchorsForm {
  return { accommodation: null, daily: {}, arrival: null, departure: null }
}

export function emptyAccommodationForm(): AccommodationForm {
  return {
    hotelId: null,
    name: '',
    address: '',
    lng: '',
    lat: '',
    checkInDate: '',
    checkOutDate: '',
  }
}

export function emptyDayAnchorForm(): DayAnchorForm {
  return {
    anchorId: null,
    kind: 'manual',
    stopId: '',
    hotelId: '',
    name: '',
    address: '',
    lng: '',
    lat: '',
    time: '',
    date: '',
  }
}

export function emptyTransportAnchorForm(kind: TransportAnchorForm['kind'] = 'airport'): TransportAnchorForm {
  return { kind, name: '', date: '', time: '', lng: '', lat: '' }
}

function formLocation(lngText: string, latText: string, path: string): AnchorsResult<GeoPointV1 | null> {
  const lngRaw = lngText.trim()
  const latRaw = latText.trim()
  if (lngRaw.length === 0 && latRaw.length === 0) return { ok: true, value: null }
  if (lngRaw.length === 0 || latRaw.length === 0) {
    return failure(
      'invalid_coordinate',
      '经纬度必须同时留空或同时填写；只填一项时不会把另一项补成 0。',
      path,
    )
  }
  const lng = Number(lngRaw)
  const lat = Number(latRaw)
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    return failure('invalid_coordinate', '经度必须是 -180..180 的有限数字，或留空表示未知。', path)
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return failure('invalid_coordinate', '纬度必须是 -90..90 的有限数字，或留空表示未知。', path)
  }
  return { ok: true, value: { lng, lat } }
}

function buildAccommodation(
  form: AccommodationForm | null,
  createId: AnchorsIdFactory,
): AnchorsResult<AccommodationAnchorV1 | null> {
  if (form === null) return { ok: true, value: null }
  const name = textOrNull(form.name)
  const address = textOrNull(form.address)
  const checkInDate = textOrNull(form.checkInDate)
  const checkOutDate = textOrNull(form.checkOutDate)
  const location = formLocation(form.lng, form.lat, '$.accommodation.location')
  if (!location.ok) return location
  const existingHotelId = textOrNull(form.hotelId)
  const hasContent =
    name !== null ||
    address !== null ||
    location.value !== null ||
    checkInDate !== null ||
    checkOutDate !== null ||
    existingHotelId !== null
  if (!hasContent) return { ok: true, value: null }
  if (checkInDate !== null && !isRealDate(checkInDate)) {
    return failure('invalid_date', '入住日期必须是真实日历日 YYYY-MM-DD。', '$.accommodation.checkInDate')
  }
  if (checkOutDate !== null && !isRealDate(checkOutDate)) {
    return failure('invalid_date', '退房日期必须是真实日历日 YYYY-MM-DD。', '$.accommodation.checkOutDate')
  }
  const hotelId = existingHotelId ?? createId('hotel')
  if (!validId(hotelId)) {
    return failure('invalid_id', '住宿实体 id 必须是 1–200 个字符的非空文本。', '$.accommodation.hotelId')
  }
  return {
    ok: true,
    value: {
      hotelId,
      name,
      address,
      location: location.value,
      locationSource: location.value === null ? null : 'user_provided',
      checkInDate,
      checkOutDate,
    },
  }
}

function buildDayAnchor(
  form: DayAnchorForm | null,
  createId: AnchorsIdFactory,
  path: string,
): AnchorsResult<DayAnchorV1 | null> {
  if (form === null) return { ok: true, value: null }
  const name = textOrNull(form.name)
  const address = textOrNull(form.address)
  const time = textOrNull(form.time)
  const date = textOrNull(form.date)
  const kind = form.kind
  const stopId = kind === 'stop' ? textOrNull(form.stopId) : null
  const hotelId = textOrNull(form.hotelId)
  const location = formLocation(form.lng, form.lat, `${path}.location`)
  if (!location.ok) return location
  const existingAnchorId = textOrNull(form.anchorId)
  const hasContent =
    name !== null ||
    address !== null ||
    time !== null ||
    date !== null ||
    stopId !== null ||
    hotelId !== null ||
    location.value !== null ||
    existingAnchorId !== null ||
    kind === 'stop'
  if (!hasContent) return { ok: true, value: null }
  if (name === null) {
    return failure('missing_name', '锚点必须填写名称；手工地点不会自动命名。', `${path}.name`)
  }
  if (kind === 'stop' && stopId === null) {
    return failure('missing_stop', '引用已有站点时必须选择一个当前天的站点。', `${path}.stopId`)
  }
  if (time !== null && !TIME_PATTERN.test(time)) {
    return failure('invalid_time', '锚点时间必须是 HH:MM（24 小时制），或留空表示未知。', `${path}.time`)
  }
  if (date !== null && !isRealDate(date)) {
    return failure('invalid_date', '锚点日期必须是真实日历日 YYYY-MM-DD，或留空表示未知。', `${path}.date`)
  }
  const anchorId = existingAnchorId ?? createId('anchor')
  if (!validId(anchorId)) {
    return failure('invalid_id', '锚点 id 必须是 1–200 个字符的非空文本。', `${path}.anchorId`)
  }
  return {
    ok: true,
    value: {
      anchorId,
      kind,
      stopId,
      hotelId,
      name,
      address,
      location: location.value,
      time,
      date,
    },
  }
}

function buildTransportAnchor(
  form: TransportAnchorForm | null,
  path: string,
): AnchorsResult<TransportAnchorV1 | null> {
  if (form === null) return { ok: true, value: null }
  const name = textOrNull(form.name)
  const date = textOrNull(form.date)
  const time = textOrNull(form.time)
  const location = formLocation(form.lng, form.lat, `${path}.location`)
  if (!location.ok) return location
  const hasContent = name !== null || date !== null || time !== null || location.value !== null
  if (!hasContent) return { ok: true, value: null }
  if (name === null) {
    return failure('missing_name', '机场 / 车站名称不能为空；缺信息时请取消该项。', `${path}.name`)
  }
  if (date !== null && !isRealDate(date)) {
    return failure('invalid_date', '抵离日期必须是真实日历日 YYYY-MM-DD，或留空表示未知。', `${path}.date`)
  }
  if (time !== null && !TIME_PATTERN.test(time)) {
    return failure('invalid_time', '抵离时间必须是 HH:MM（24 小时制），或留空表示未知。', `${path}.time`)
  }
  return {
    ok: true,
    value: { kind: form.kind, name, date, time, location: location.value },
  }
}

/**
 * 表单 -> 契约结构。只做字段形状 / 日期 / 时间 / 坐标解析；与当前 Trip 的
 * day / stop / 入住范围匹配由 `createAnchorsProposal` 负责（它需要 Trip 上下文）。
 */
export function buildAnchorsFromForm(form: AnchorsForm, createId: AnchorsIdFactory): AnchorsResult<AnchorsV1> {
  const accommodation = buildAccommodation(form.accommodation, createId)
  if (!accommodation.ok) return accommodation

  const daily: Record<string, DailyAnchorsV1> = {}
  const anchorIds = new Set<string>()
  const dayKeys = Object.keys(form.daily).sort((left, right) => Number(left) - Number(right))
  for (const key of dayKeys) {
    if (!/^[1-9]\d*$/.test(key) || Number(key) > 366) {
      return failure('unknown_day', 'daily 的键必须是 1-366 的规范十进制天序号。', `$.daily.${key}`)
    }
    const entry = form.daily[key]
    if (entry === undefined) continue
    const start = buildDayAnchor(entry.start, createId, `$.daily.${key}.start`)
    if (!start.ok) return start
    const end = buildDayAnchor(entry.end, createId, `$.daily.${key}.end`)
    if (!end.ok) return end
    if (start.value === null && end.value === null) continue
    for (const anchor of [start.value, end.value]) {
      if (anchor === null) continue
      if (anchorIds.has(anchor.anchorId)) {
        return failure('duplicate_id', '同一份锚点里不能重复使用同一个 anchorId。', `$.daily.${key}`)
      }
      anchorIds.add(anchor.anchorId)
    }
    daily[key] = { start: start.value, end: end.value }
  }

  const arrival = buildTransportAnchor(form.arrival, '$.arrival')
  if (!arrival.ok) return arrival
  const departure = buildTransportAnchor(form.departure, '$.departure')
  if (!departure.ok) return departure

  const candidate: AnchorsV1 = {
    accommodation: accommodation.value,
    daily,
    arrival: arrival.value,
    departure: departure.value,
  }
  const checked = validateAnchors(candidate)
  if (!checked.ok) {
    return failure('invalid_anchors', `${checked.path}: ${checked.message}`, checked.path)
  }
  return { ok: true, value: checked.value }
}

export function anchorsToForm(anchors: AnchorsV1): AnchorsForm {
  const accommodation: AccommodationForm | null =
    anchors.accommodation === null
      ? null
      : {
          hotelId: anchors.accommodation.hotelId,
          name: anchors.accommodation.name ?? '',
          address: anchors.accommodation.address ?? '',
          lng: anchors.accommodation.location === null ? '' : String(anchors.accommodation.location.lng),
          lat: anchors.accommodation.location === null ? '' : String(anchors.accommodation.location.lat),
          checkInDate: anchors.accommodation.checkInDate ?? '',
          checkOutDate: anchors.accommodation.checkOutDate ?? '',
        }
  const daily: Record<string, DailyAnchorForm> = {}
  for (const key of Object.keys(anchors.daily)) {
    const entry = anchors.daily[key]
    daily[key] = {
      start: entry.start === null ? null : dayAnchorToForm(entry.start),
      end: entry.end === null ? null : dayAnchorToForm(entry.end),
    }
  }
  return {
    accommodation,
    daily,
    arrival: anchors.arrival === null ? null : transportAnchorToForm(anchors.arrival),
    departure: anchors.departure === null ? null : transportAnchorToForm(anchors.departure),
  }
}

function dayAnchorToForm(anchor: DayAnchorV1): DayAnchorForm {
  return {
    anchorId: anchor.anchorId,
    kind: anchor.kind,
    stopId: anchor.stopId ?? '',
    hotelId: anchor.hotelId ?? '',
    name: anchor.name,
    address: anchor.address ?? '',
    lng: anchor.location === null ? '' : String(anchor.location.lng),
    lat: anchor.location === null ? '' : String(anchor.location.lat),
    time: anchor.time ?? '',
    date: anchor.date ?? '',
  }
}

function transportAnchorToForm(anchor: TransportAnchorV1): TransportAnchorForm {
  return {
    kind: anchor.kind,
    name: anchor.name,
    date: anchor.date ?? '',
    time: anchor.time ?? '',
    lng: anchor.location === null ? '' : String(anchor.location.lng),
    lat: anchor.location === null ? '' : String(anchor.location.lat),
  }
}

/* ───────── proposal 结果类型 ───────── */

export type AnchorPlacementStatus = 'linked_existing' | 'new_occurrence' | 'reference_only'

/** 明确每个锚点与 Trip 的关系；proposal 阶段没有「已写入行程」状态。 */
export interface AnchorPlacement {
  anchorId: string
  day: number
  position: 'start' | 'end'
  status: AnchorPlacementStatus
  stopId: string | null
  hotelId: string | null
}

export interface AnchorStopOccurrence {
  anchorId: string
  day: number
  position: 'start' | 'end'
  hotelId: string
  stop: TripStop
}

export type AnchorConflictSeverity = 'block' | 'unverified'

export interface AnchorConflict {
  code: string
  severity: AnchorConflictSeverity
  day: number | null
  anchorId: string | null
  stopId: string | null
  message: string
}

/**
 * F2 最终硬门的明确接口：F2 在 apply 候选前调用 `evaluateAnchorsHardGate`。
 * - `blockers`：明确冲突（起锚点晚于首站、终锚点早于末站结束、引用 stop 已删等）。
 * - `unverified`：时间 / 停留 / 路段未知，不得声称已满足。
 * - `anchorsAreTripStops: false`：锚点本身不是 Trip 停靠；不要把侧栏锚点当成
 *   已在行程中的站点。
 */
export interface AnchorsHardGateReport {
  blockers: AnchorConflict[]
  unverified: AnchorConflict[]
  anchorsAreTripStops: false
}

export interface AnchorsProposal {
  /** 完整 owner：输入记录的 canonical 快照 + identity + revision + epoch。 */
  owner: WorkspaceOwnerV1
  baseRevision: number
  baseTripId: string
  /** 应用后应写入 `sidecar.anchors` 的值（酒店手动锚点会变成独立 stop 链接）。 */
  nextAnchors: AnchorsV1
  /** 只替换 anchors，其余 constraints / checklist / applies 原样保留。 */
  nextSidecar: WorkspaceSidecarV1
  /** 应用后应写入的 Trip；仅新增协议内的独立 occurrence，不改既有 stop / leg。 */
  trip: Trip
  occurrences: AnchorStopOccurrence[]
  placements: AnchorPlacement[]
  conflicts: AnchorConflict[]
  hardGate: AnchorsHardGateReport
  notices: string[]
  newLegMode: TravelMode
}

export interface CreateAnchorsProposalInput {
  record: WorkspaceRecordV1
  epoch: number
  anchors: AnchorsV1
  newLegMode: TravelMode
  /** 测试注入；缺省使用契约的 createLogicalId，不采集浏览器信息。 */
  createStopId?: () => string
}

/* ───────── 时间 / 冲突（供 F1 预览与 F2 硬门共用） ───────── */

function stopById(day: TripDay, stopId: string | null): TripStop | null {
  if (stopId === null) return null
  return day.stops.find((stop) => stop.id === stopId) ?? null
}

function sortedDayNumbers(anchors: AnchorsV1): string[] {
  return Object.keys(anchors.daily).sort((left, right) => Number(left) - Number(right))
}

/**
 * 评估锚点与当前 Trip 的时间 / 引用冲突。纯只读，不修改任何输入。
 * 只看当前 Trip 已有的站；proposal 新生成的酒店 occurrence 不在这里冒充已存在。
 */
export function evaluateAnchorsHardGate(trip: Trip, anchors: AnchorsV1): AnchorsHardGateReport {
  const blockers: AnchorConflict[] = []
  const unverified: AnchorConflict[] = []
  const anchorCheck = validateAnchors(anchors)
  if (!anchorCheck.ok) {
    blockers.push({
      code: 'invalid_anchors',
      severity: 'block',
      day: null,
      anchorId: null,
      stopId: null,
      message: `锚点结构不合法：${anchorCheck.message}`,
    })
    return { blockers, unverified, anchorsAreTripStops: false }
  }
  const normalized = anchorCheck.value
  const stay = normalized.accommodation
  if (stay !== null && stay.checkInDate !== null && stay.checkOutDate !== null && stay.checkInDate > stay.checkOutDate) {
    blockers.push({
      code: 'invalid_stay_range',
      severity: 'block',
      day: null,
      anchorId: null,
      stopId: null,
      message: '退房日期早于入住日期，住宿范围不合法。',
    })
  }
  for (const key of sortedDayNumbers(normalized)) {
    const dayNumber = Number(key)
    const day = trip.days.find((item) => item.day === dayNumber)
    if (!day) {
      blockers.push({
        code: 'unknown_day',
        severity: 'block',
        day: dayNumber,
        anchorId: null,
        stopId: null,
        message: `当前行程没有第 ${dayNumber} 天，锚点无法匹配。`,
      })
      continue
    }
    const entry = normalized.daily[key]
    const start = entry.start
    const end = entry.end
    if (start !== null) {
      const stop = start.kind === 'stop' ? stopById(day, start.stopId) : null
      if (start.kind === 'stop' && stop === null) {
        blockers.push({
          code: 'stop_missing',
          severity: 'block',
          day: dayNumber,
          anchorId: start.anchorId,
          stopId: start.stopId,
          message: `第 ${dayNumber} 天的起点引用的站点已不存在。`,
        })
      }
      if (start.date !== null && day.date !== null && start.date !== day.date) {
        blockers.push({
          code: 'anchor_date_mismatch',
          severity: 'block',
          day: dayNumber,
          anchorId: start.anchorId,
          stopId: start.stopId,
          message: `第 ${dayNumber} 天起点日期与行程当天日期不一致。`,
        })
      }
      if (stay !== null && start.hotelId === stay.hotelId && start.date !== null) {
        if (stay.checkInDate !== null && start.date < stay.checkInDate) {
          blockers.push({
            code: 'anchor_outside_stay',
            severity: 'block',
            day: dayNumber,
            anchorId: start.anchorId,
            stopId: start.stopId,
            message: `第 ${dayNumber} 天起点早于住宿入住日。`,
          })
        }
        if (stay.checkOutDate !== null && start.date > stay.checkOutDate) {
          blockers.push({
            code: 'anchor_outside_stay',
            severity: 'block',
            day: dayNumber,
            anchorId: start.anchorId,
            stopId: start.stopId,
            message: `第 ${dayNumber} 天起点晚于住宿退房日。`,
          })
        }
      }
      if (start.time !== null && day.stops.length > 0) {
        const first = day.stops[0]
        const firstStart = parseClock(first.time)
        const anchorStart = parseClock(start.time)
        if (firstStart === null) {
          unverified.push({
            code: 'first_stop_time_unreadable',
            severity: 'unverified',
            day: dayNumber,
            anchorId: start.anchorId,
            stopId: first.id,
            message: `第 ${dayNumber} 天首站时间无法解析，不能核对起点时间。`,
          })
        } else if (anchorStart !== null && firstStart < anchorStart) {
          blockers.push({
            code: 'start_after_first_stop',
            severity: 'block',
            day: dayNumber,
            anchorId: start.anchorId,
            stopId: first.id,
            message: `起点时间 ${start.time} 晚于第 ${dayNumber} 天首站开始时间 ${first.time}。`,
          })
        }
      }
    }
    if (end !== null) {
      const stop = end.kind === 'stop' ? stopById(day, end.stopId) : null
      if (end.kind === 'stop' && stop === null) {
        blockers.push({
          code: 'stop_missing',
          severity: 'block',
          day: dayNumber,
          anchorId: end.anchorId,
          stopId: end.stopId,
          message: `第 ${dayNumber} 天的终点引用的站点已不存在。`,
        })
      }
      if (end.date !== null && day.date !== null && end.date !== day.date) {
        blockers.push({
          code: 'anchor_date_mismatch',
          severity: 'block',
          day: dayNumber,
          anchorId: end.anchorId,
          stopId: end.stopId,
          message: `第 ${dayNumber} 天终点日期与行程当天日期不一致。`,
        })
      }
      if (stay !== null && end.hotelId === stay.hotelId && end.date !== null) {
        if (stay.checkInDate !== null && end.date < stay.checkInDate) {
          blockers.push({
            code: 'anchor_outside_stay',
            severity: 'block',
            day: dayNumber,
            anchorId: end.anchorId,
            stopId: end.stopId,
            message: `第 ${dayNumber} 天终点早于住宿入住日。`,
          })
        }
        if (stay.checkOutDate !== null && end.date > stay.checkOutDate) {
          blockers.push({
            code: 'anchor_outside_stay',
            severity: 'block',
            day: dayNumber,
            anchorId: end.anchorId,
            stopId: end.stopId,
            message: `第 ${dayNumber} 天终点晚于住宿退房日。`,
          })
        }
      }
      if (end.time !== null && day.stops.length > 0) {
        const last = day.stops[day.stops.length - 1]
        const lastStart = parseClock(last.time)
        if (lastStart === null) {
          unverified.push({
            code: 'last_stop_time_unreadable',
            severity: 'unverified',
            day: dayNumber,
            anchorId: end.anchorId,
            stopId: last.id,
            message: `第 ${dayNumber} 天末站时间无法解析，不能核对终点时间。`,
          })
        } else if (last.duration_minutes === null) {
          unverified.push({
            code: 'end_stop_duration_unknown',
            severity: 'unverified',
            day: dayNumber,
            anchorId: end.anchorId,
            stopId: last.id,
            message: `第 ${dayNumber} 天末站停留时间未知，不能确认是否早于终点 ${end.time} 结束。`,
          })
        } else {
          const endAt = lastStart + last.duration_minutes
          const anchorEnd = parseClock(end.time)
          if (anchorEnd !== null && endAt > anchorEnd) {
            blockers.push({
              code: 'end_after_anchor',
              severity: 'block',
              day: dayNumber,
              anchorId: end.anchorId,
              stopId: last.id,
              message: `第 ${dayNumber} 天末站最早 ${formatEndClock(endAt)} 结束，晚于终点时间 ${end.time}。`,
            })
          }
        }
      }
    }
    for (const leg of day.legs) {
      if (leg.duration_minutes === null) {
        unverified.push({
          code: 'leg_duration_unknown',
          severity: 'unverified',
          day: dayNumber,
          anchorId: null,
          stopId: leg.to_stop_id,
          message: `第 ${dayNumber} 天有相邻路段耗时未知，不能假设可达；不会按 0 分钟计算。`,
        })
      }
    }
  }
  return { blockers, unverified, anchorsAreTripStops: false }
}

/* ───────── Trip 草稿：只新增 occurrence，冻结既有内容 ───────── */

function legKey(fromStopId: string, toStopId: string): string {
  return `${JSON.stringify(fromStopId)}\u0000${JSON.stringify(toStopId)}`
}

const NEW_OCCURRENCE_LEG_DESCRIPTION = '新增住宿停靠，待重新获取路线'

function rebuildLegs(day: TripDay, stops: readonly TripStop[], mode: TravelMode): TripLeg[] {
  const oldStopById = new Map(day.stops.map((stop) => [stop.id, stop]))
  const oldLegByKey = new Map(day.legs.map((leg) => [legKey(leg.from_stop_id, leg.to_stop_id), leg]))
  const legs: TripLeg[] = []
  for (let index = 0; index + 1 < stops.length; index += 1) {
    const from = stops[index]
    const to = stops[index + 1]
    const previous = oldLegByKey.get(legKey(from.id, to.id))
    if (previous !== undefined && oldStopById.has(from.id) && oldStopById.has(to.id)) {
      legs.push(previous)
      continue
    }
    legs.push({
      from_stop_id: from.id,
      to_stop_id: to.id,
      mode,
      route_type: 'unavailable',
      distance_m: null,
      duration_minutes: null,
      geometry: [],
      description: NEW_OCCURRENCE_LEG_DESCRIPTION,
    })
  }
  return legs
}

function buildProposedTrip(
  trip: Trip,
  occurrences: readonly AnchorStopOccurrence[],
  mode: TravelMode,
): Trip {
  if (occurrences.length === 0) return trip
  const byDay = new Map<number, { start: TripStop[]; end: TripStop[] }>()
  for (const occurrence of occurrences) {
    const bucket = byDay.get(occurrence.day) ?? { start: [], end: [] }
    if (occurrence.position === 'start') bucket.start.push(occurrence.stop)
    else bucket.end.push(occurrence.stop)
    byDay.set(occurrence.day, bucket)
  }
  return {
    ...trip,
    days: trip.days.map((day) => {
      const bucket = byDay.get(day.day)
      if (bucket === undefined) return day
      const stops = [...bucket.start, ...day.stops, ...bucket.end]
      return { ...day, stops, legs: rebuildLegs(day, stops, mode) }
    }),
  }
}

function allStopIds(trip: Trip): Set<string> {
  const ids = new Set<string>()
  for (const day of trip.days) {
    for (const stop of day.stops) ids.add(stop.id)
  }
  return ids
}

function allocateStopId(
  factory: () => string,
  used: Set<string>,
): AnchorsResult<string> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = factory()
    if (!validId(candidate)) {
      return failure('invalid_id', '生成的 stop id 必须是 1–200 个字符的非空文本。')
    }
    if (!used.has(candidate)) {
      used.add(candidate)
      return { ok: true, value: candidate }
    }
  }
  return failure('duplicate_id', '无法生成不与现有站点 / 本次 occurrence 冲突的 stop id；未生成提案。')
}

/* ───────── proposal 构建 ───────── */

export function createAnchorsProposal(input: CreateAnchorsProposalInput): AnchorsResult<AnchorsProposal> {
  const recordCheck = validateWorkspaceRecord(input.record)
  if (!recordCheck.ok) {
    return failure('invalid_record', `工作区记录不合法：${recordCheck.path}: ${recordCheck.message}`)
  }
  const shape = checkTripShape(input.record.trip)
  if (!shape.ok) {
    return failure('invalid_trip', `当前行程没有通过 checkTripShape：${shape.message}`)
  }
  const anchorsCheck = validateAnchors(input.anchors)
  if (!anchorsCheck.ok) {
    return failure('invalid_anchors', `${anchorsCheck.path}: ${anchorsCheck.message}`, anchorsCheck.path)
  }
  if (input.newLegMode !== 'walking' && input.newLegMode !== 'driving') {
    return failure('invalid_leg_mode', '新增 occurrence 时必须显式给出 walking 或 driving，不能猜。')
  }
  const owner = createWorkspaceOwner(input.record, input.epoch)
  if (!owner.ok) {
    return failure('invalid_record', `无法为当前工作区生成 owner：${owner.message}`)
  }
  const anchors = anchorsCheck.value
  const stay = anchors.accommodation
  if (stay !== null) {
    const allNull =
      stay.hotelId === null &&
      stay.name === null &&
      stay.address === null &&
      stay.location === null &&
      stay.checkInDate === null &&
      stay.checkOutDate === null
    if (allNull) {
      return failure('empty_accommodation', '住宿信息全部为空；请填至少一项或移除住宿。', '$.accommodation')
    }
    if (stay.checkInDate !== null && stay.checkOutDate !== null && stay.checkInDate > stay.checkOutDate) {
      return failure('invalid_stay_range', '退房日期不能早于入住日期。', '$.accommodation.checkOutDate')
    }
  }

  const dayMap = new Map(input.record.trip.days.map((day) => [day.day, day]))
  const anchorIds = new Set<string>()
  const dayKeys = sortedDayNumbers(anchors)
  for (const key of dayKeys) {
    const dayNumber = Number(key)
    const day = dayMap.get(dayNumber)
    if (!day) {
      return failure('unknown_day', `当前行程没有第 ${dayNumber} 天，锚点未生成。`, `$.daily.${key}`)
    }
    const entry = anchors.daily[key]
    for (const [position, anchor] of [
      ['start', entry.start],
      ['end', entry.end],
    ] as const) {
      if (anchor === null) continue
      if (anchorIds.has(anchor.anchorId)) {
        return failure('duplicate_id', '同一份锚点里不能重复使用同一个 anchorId。', `$.daily.${key}.${position}`)
      }
      anchorIds.add(anchor.anchorId)
      if (anchor.hotelId !== null) {
        if (stay === null || stay.hotelId === null || stay.hotelId !== anchor.hotelId) {
          return failure(
            'unknown_hotel',
            `第 ${dayNumber} 天${position === 'start' ? '起点' : '终点'}引用的住宿实体不存在。`,
            `$.daily.${key}.${position}.hotelId`,
          )
        }
      }
      if (anchor.kind === 'stop' && stopById(day, anchor.stopId) === null) {
        return failure(
          'unknown_stop',
          `第 ${dayNumber} 天${position === 'start' ? '起点' : '终点'}引用的站点不存在于当天。`,
          `$.daily.${key}.${position}.stopId`,
        )
      }
      if (anchor.date !== null) {
        if (day.date !== null && anchor.date !== day.date) {
          return failure(
            'anchor_date_mismatch',
            `第 ${dayNumber} 天锚点日期 ${anchor.date} 与行程当天日期 ${day.date} 不一致。`,
            `$.daily.${key}.${position}.date`,
          )
        }
        if (anchor.hotelId !== null && stay !== null) {
          if (stay.checkInDate !== null && anchor.date < stay.checkInDate) {
            return failure(
              'anchor_outside_stay',
              `第 ${dayNumber} 天锚点日期早于入住日 ${stay.checkInDate}。`,
              `$.daily.${key}.${position}.date`,
            )
          }
          if (stay.checkOutDate !== null && anchor.date > stay.checkOutDate) {
            return failure(
              'anchor_outside_stay',
              `第 ${dayNumber} 天锚点日期晚于退房日 ${stay.checkOutDate}。`,
              `$.daily.${key}.${position}.date`,
            )
          }
        }
      }
    }
  }

  const usedStopIds = allStopIds(input.record.trip)
  const stopFactory = input.createStopId ?? (() => createLogicalId())
  const occurrences: AnchorStopOccurrence[] = []
  const nextDaily: Record<string, DailyAnchorsV1> = {}
  const placements: AnchorPlacement[] = []

  for (const key of dayKeys) {
    const dayNumber = Number(key)
    const day = dayMap.get(dayNumber)
    if (!day) continue
    const entry = anchors.daily[key]
    const nextEntry: DailyAnchorsV1 = { start: null, end: null }
    for (const [position, anchor] of [
      ['start', entry.start],
      ['end', entry.end],
    ] as const) {
      if (anchor === null) continue
      if (anchor.kind === 'manual' && anchor.hotelId !== null) {
        const hotel = stay
        if (hotel === null) {
          return failure('unknown_hotel', '住宿实体缺失，无法生成酒店停靠。', `$.daily.${key}.${position}`)
        }
        const idResult = allocateStopId(stopFactory, usedStopIds)
        if (!idResult.ok) return idResult
        const stop: TripStop = {
          id: idResult.value,
          name: anchor.name,
          time: anchor.time ?? '待定',
          duration_minutes: null,
          description: '你填写的住宿停靠（未预订；待重新获取路线）',
          address: anchor.address ?? hotel.address ?? '',
          location: cloneLocation(anchor.location ?? hotel.location),
        }
        const occurrence: AnchorStopOccurrence = {
          anchorId: anchor.anchorId,
          day: dayNumber,
          position,
          hotelId: anchor.hotelId,
          stop,
        }
        occurrences.push(occurrence)
        nextEntry[position] = {
          ...anchor,
          kind: 'stop',
          stopId: stop.id,
        }
        placements.push({
          anchorId: anchor.anchorId,
          day: dayNumber,
          position,
          status: 'new_occurrence',
          stopId: stop.id,
          hotelId: anchor.hotelId,
        })
      } else {
        nextEntry[position] = anchor
        placements.push({
          anchorId: anchor.anchorId,
          day: dayNumber,
          position,
          status: anchor.kind === 'stop' ? 'linked_existing' : 'reference_only',
          stopId: anchor.stopId,
          hotelId: anchor.hotelId,
        })
      }
    }
    nextDaily[key] = nextEntry
  }

  const occurrencesPerDay = new Map<number, number>()
  for (const occurrence of occurrences) {
    occurrencesPerDay.set(occurrence.day, (occurrencesPerDay.get(occurrence.day) ?? 0) + 1)
  }
  for (const [dayNumber, count] of occurrencesPerDay) {
    const day = dayMap.get(dayNumber)
    if (day && day.stops.length + count > MAX_DRAFT_STOPS_PER_DAY) {
      return failure(
        'stop_limit',
        `第 ${dayNumber} 天加入酒店停靠后会超过单日 ${MAX_DRAFT_STOPS_PER_DAY} 个站点的本地结构上限；未生成提案。`,
        `$.daily.${dayNumber}`,
      )
    }
  }

  const nextAnchors: AnchorsV1 = {
    accommodation: stay,
    daily: nextDaily,
    arrival: anchors.arrival,
    departure: anchors.departure,
  }
  const nextSidecar: WorkspaceSidecarV1 = { ...input.record.sidecar, anchors: nextAnchors }
  const sidecarCheck = validateWorkspaceSidecar(nextSidecar)
  if (!sidecarCheck.ok) {
    return failure(
      'postcondition_failed',
      `加入锚点后的 sidecar 没有通过契约校验：${sidecarCheck.path}: ${sidecarCheck.message}`,
    )
  }
  const proposedTrip = buildProposedTrip(input.record.trip, occurrences, input.newLegMode)
  const proposedShape = checkTripShape(proposedTrip)
  if (!proposedShape.ok) {
    return failure('postcondition_failed', `加入酒店停靠后的行程没有通过 checkTripShape：${proposedShape.message}`)
  }
  const hardGate = evaluateAnchorsHardGate(input.record.trip, anchors)
  const notices = buildNotices(anchors)
  return {
    ok: true,
    value: {
      owner: owner.value,
      baseRevision: input.record.workspaceRevision,
      baseTripId: input.record.tripId,
      nextAnchors,
      nextSidecar,
      trip: proposedTrip,
      occurrences,
      placements,
      conflicts: [...hardGate.blockers, ...hardGate.unverified],
      hardGate,
      notices,
      newLegMode: input.newLegMode,
    },
  }
}

function buildNotices(anchors: AnchorsV1): string[] {
  const notices = [
    '锚点只是你填写的计划参考：预览阶段不会写入行程，应用后也不会自动重排站点或补齐坐标。',
    '住宿信息来自你的填写，不代表酒店已经为你保留房间或完成预订；系统不会自动预订、查询房价或库存。',
  ]
  const stay = anchors.accommodation
  if (stay !== null) {
    if (stay.checkInDate !== null && stay.checkOutDate !== null) {
      notices.push(
        `住宿日期：${stay.checkInDate} 入住、${stay.checkOutDate} 退房（行程当地日期）；退房日只作离店参考，不自动生成行程站点。`,
      )
    } else if (stay.checkInDate !== null || stay.checkOutDate !== null) {
      notices.push('住宿日期只填写了一端；另一端未知，不自动补日期。')
    }
    if (stay.location === null) {
      notices.push('住宿坐标未知，距离与路线无法计算；不会 geocode，也不会补 (0, 0)。')
    } else {
      notices.push('住宿坐标是你填写的 WGS84 值；0 是有效坐标值，不代表未知。')
    }
  }
  if (anchors.arrival !== null && anchors.arrival.time === null) {
    notices.push('抵达时间未知，只作首日参考，不阻断保存。')
  }
  if (anchors.departure !== null && anchors.departure.time === null) {
    notices.push('离开时间未知，只作末日参考，不阻断保存。')
  }
  return notices
}

/* ───────── 显式 apply / 冻结校验 ───────── */

function sameTripMeta(left: Trip, right: Trip): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.destination === right.destination &&
    left.title === right.title &&
    left.summary === right.summary &&
    left.map_coordinate_system === right.map_coordinate_system &&
    canonicalValuesEqual(left.warnings, right.warnings)
  )
}

function sameDayMeta(left: TripDay, right: TripDay): boolean {
  return left.day === right.day && left.date === right.date && left.title === right.title && left.summary === right.summary
}

function verifyProposal(current: WorkspaceRecordV1, proposal: AnchorsProposal): AnchorsFailure | null {
  if (proposal.baseRevision !== current.workspaceRevision) {
    return failure('owner_mismatch', '工作区版本已变化，旧提案不能应用；请重新生成预览。')
  }
  if (proposal.baseTripId !== current.tripId || proposal.owner.tripId !== current.tripId) {
    return failure('owner_mismatch', '提案不属于当前行程，不能应用。')
  }
  if (!workspaceOwnerMatches(proposal.owner, current, proposal.owner.epoch)) {
    return failure('owner_mismatch', '提案所属的工作区内容或 epoch 已变化，旧提案失效。')
  }
  if (proposal.trip.id !== current.tripId) {
    return failure('invalid_proposal', '提案试图更换行程 id；工作区不允许这样做。')
  }
  const anchorsCheck = validateAnchors(proposal.nextAnchors)
  if (!anchorsCheck.ok) {
    return failure('invalid_proposal', `提案里的 anchors 不合法：${anchorsCheck.message}`)
  }
  if (!canonicalValuesEqual(proposal.nextSidecar.anchors, proposal.nextAnchors)) {
    return failure('invalid_proposal', '提案的 nextSidecar.anchors 与 nextAnchors 不一致。')
  }
  if (!canonicalValuesEqual(proposal.nextSidecar.constraints, current.sidecar.constraints)) {
    return failure('invalid_proposal', '锚点提案不能修改 constraints。')
  }
  if (!canonicalValuesEqual(proposal.nextSidecar.checklist, current.sidecar.checklist)) {
    return failure('invalid_proposal', '锚点提案不能修改 checklist。')
  }
  if (!canonicalValuesEqual(proposal.nextSidecar.applies, current.sidecar.applies)) {
    return failure('invalid_proposal', '锚点提案不能修改 applies。')
  }
  if (!sameTripMeta(proposal.trip, current.trip)) {
    return failure('invalid_proposal', '提案只能新增酒店停靠，不能修改行程标题 / 摘要 / warnings 等元数据。')
  }
  if (proposal.trip.days.length !== current.trip.days.length) {
    return failure('invalid_proposal', '提案不能增删行程天数。')
  }
  const currentDayNumbers = new Set(current.trip.days.map((day) => day.day))
  for (const occurrence of proposal.occurrences) {
    if (!currentDayNumbers.has(occurrence.day)) {
      return failure('invalid_proposal', `提案包含不存在的第 ${occurrence.day} 天 occurrence。`)
    }
    const proposedDay = proposal.trip.days.find((day) => day.day === occurrence.day)
    if (!proposedDay || !proposedDay.stops.some((stop) => canonicalValuesEqual(stop, occurrence.stop))) {
      return failure('invalid_proposal', '提案 occurrence 没有按声明进入对应天的站点列表。')
    }
    const anchor = proposal.nextAnchors.daily[String(occurrence.day)]
    const linked =
      anchor !== undefined &&
      (anchor.start?.anchorId === occurrence.anchorId || anchor.end?.anchorId === occurrence.anchorId)
    if (!linked) {
      return failure('invalid_proposal', '提案 occurrence 没有在 nextAnchors 中留下对应锚点。')
    }
  }
  for (const currentDay of current.trip.days) {
    const proposedDay = proposal.trip.days.find((day) => day.day === currentDay.day)
    if (!proposedDay) {
      return failure('invalid_proposal', `提案缺少第 ${currentDay.day} 天。`)
    }
    if (!sameDayMeta(proposedDay, currentDay)) {
      return failure('invalid_proposal', `提案不能修改第 ${currentDay.day} 天的标题 / 日期 / 摘要。`)
    }
    const dayOccurrences = proposal.occurrences.filter((occurrence) => occurrence.day === currentDay.day)
    if (dayOccurrences.length === 0) {
      if (!canonicalValuesEqual(proposedDay, currentDay)) {
        return failure('invalid_proposal', `第 ${currentDay.day} 天没有 occurrence，但内容被改动；已拒绝。`)
      }
      continue
    }
    const startStops = dayOccurrences.filter((occurrence) => occurrence.position === 'start').map((item) => item.stop)
    const endStops = dayOccurrences.filter((occurrence) => occurrence.position === 'end').map((item) => item.stop)
    const expectedStops = [...startStops, ...currentDay.stops, ...endStops]
    if (!canonicalValuesEqual(proposedDay.stops, expectedStops)) {
      return failure(
        'invalid_proposal',
        `第 ${currentDay.day} 天的站点不是「本次 occurrence + 原站点」的冻结顺序；已拒绝。`,
      )
    }
    const expectedLegs = rebuildLegs(currentDay, expectedStops, proposal.newLegMode)
    if (!canonicalValuesEqual(proposedDay.legs, expectedLegs)) {
      return failure('invalid_proposal', `第 ${currentDay.day} 天的路线与本次 occurrence 不一致；已拒绝。`)
    }
  }
  return null
}

/**
 * 显式应用 proposal：先核对完整 owner / revision / 冻结前缀，再走
 * `commitWorkspaceTransition`（Trip + sidecar 内存单一 transition，revision +1）。
 * 失败返回契约 failure，当前记录对象与存储字节都不变。本函数不写 storage。
 */
export function applyAnchorsProposal(
  current: WorkspaceRecordV1,
  proposal: AnchorsProposal,
  now: number,
): WorkspaceValidationResult<WorkspaceRecordV1> {
  const currentCheck = validateWorkspaceRecord(current)
  if (!currentCheck.ok) return currentCheck
  const verified = verifyProposal(current, proposal)
  if (verified !== null) {
    const reason: WorkspaceValidationReason =
      verified.reason === 'owner_mismatch' ? 'owner_mismatch' : 'invalid_field'
    return {
      ok: false,
      reason,
      path: verified.path ?? '$',
      message: verified.message,
    }
  }
  return commitWorkspaceTransition(current, { trip: proposal.trip, sidecar: proposal.nextSidecar }, now)
}

/** 明确导出给集成 owner 的检查：记录本身是否还匹配 proposal 的 owner / revision。 */
export function anchorsProposalMatches(proposal: AnchorsProposal, record: WorkspaceRecordV1): boolean {
  return (
    proposal.baseRevision === record.workspaceRevision &&
    proposal.baseTripId === record.tripId &&
    workspaceOwnerMatches(proposal.owner, record, proposal.owner.epoch)
  )
}

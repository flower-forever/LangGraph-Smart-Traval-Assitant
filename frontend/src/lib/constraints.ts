/**
 * F2 · 必去点与预约时间约束（纯本地模块）
 *
 * 边界：
 * - 不读写 localStorage、不调用后端、不改 Trip v1、不把 constraints 塞进 instruction。
 * - 所有编辑函数返回新对象，不修改入参；Trip 只读。
 * - 本地硬门分三级：pass / needs_ack（U 级）/ blocked（H 级）。
 *   H 级不可由用户确认绕过；U 级必须有独立确认，确认绑定当前工作区完整快照、
 *   候选 Trip 完整快照、实际对象引用、revision 与单调 epoch。
 * - 日期 / 时刻只按行程记录的当地日期与 HH:MM 做纯整数运算，不用浏览器时区转换。
 * - 时间来源默认 unknown：只有显式 timeOrigins[id] === 'known' 才按真实时刻核验；
 *   非空 Trip.time、冻结段存在本身都不构成已知证据。
 * - null = 未知，绝不补 0；0 是合法已知值（0 分钟停留、0 分钟交通）。
 * - AI 重写 stop id 后只允许唯一、无歧义、坐标不矛盾地映射；无法确证时给 U，不 silent 挑第一。
 * - day_tail 的冻结前缀在服务端不可见，因此本模块始终在最终合并 Trip 上检查完整行程。
 */

import type { Trip, TripDay, TripStop } from './api'
import {
  MAX_CONSTRAINT_ITEMS,
  MAX_CONSTRAINTS_BYTES,
  MAX_SAFE_WORKSPACE_REVISION,
  type ConstraintItemV1,
  type ConstraintKindV1,
  type ConstraintsBindingV1,
  type ConstraintsV1,
  type PlanScopeV1,
  type UnverifiedConstraintsAckV1,
  type WorkspaceFingerprintV1,
  type WorkspaceOwnerV1,
  type WorkspaceRecordV1,
  type WorkspaceValidationFailure,
  type WorkspaceValidationResult,
} from './workspaceTypes'
import {
  captureWorkspaceRuntime,
  constraintsBindingMatches,
  createConstraintsBinding,
  createLogicalId,
  createUnverifiedConstraintsAck,
  createWorkspaceOwner,
  emptyConstraints,
  unverifiedConstraintsAckMatches,
  validateConstraints,
  validateConstraintsForScope,
  validatePlanScope,
  validateWorkspaceRecord,
  workspaceOwnerMatches,
  workspaceRuntimeRefsMatch,
  type WorkspaceRuntimeCaptureV1,
} from './workspace'
import { fingerprintOf, fingerprintsMatch } from './workspaceFingerprint'

export { MAX_CONSTRAINT_ITEMS, MAX_CONSTRAINTS_BYTES }
export { emptyConstraints }

/* ───────── 基础解析：全部纯整数，不碰浏览器时区 ───────── */

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** 严格 24 小时制 HH:MM → 当天分钟；不是合法时钟返回 null。 */
export function parseConstraintClock(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null
  const match = CLOCK_PATTERN.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** Howard Hinnant 的 days_from_civil；只做日历日序，不经过 Date / 时区。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(adjustedYear / 400)
  const yearOfEra = adjustedYear - era * 400
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra - 719468
}

export interface ConstraintCivilDate {
  year: number
  month: number
  day: number
  /** 1970-01-01 = 0；只用于相对比较。 */
  ordinal: number
}

/** 严格 YYYY-MM-DD 且必须是真实日历日；不把 2026-02-30 当合法。 */
export function parseConstraintDate(value: string | null | undefined): ConstraintCivilDate | null {
  if (typeof value !== 'string') return null
  const match = DATE_PATTERN.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return null
  const maxDay = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]
  if (day > maxDay) return null
  return { year, month, day, ordinal: daysFromCivil(year, month, day) }
}

/** 当地日期 + 当地时刻 → 绝对分钟（日期序 × 1440 + 分钟），无时区转换。 */
export function constraintLocalMinute(
  date: string | null | undefined,
  time: string | null | undefined,
): number | null {
  const parsedDate = parseConstraintDate(date)
  const minutes = parseConstraintClock(time)
  if (!parsedDate || minutes === null) return null
  return parsedDate.ordinal * 1440 + minutes
}

/** 标题匹配口径：NFKC + 去首尾空白 + 合并空白 + 小写；不改写保存的原文。 */
export function normalizeConstraintTitle(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/* ───────── 容量 / 指纹 ───────── */

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** constraints 的紧凑 JSON UTF-8 字节；无法序列化时返回 Infinity（fail closed）。 */
export function constraintsByteLength(constraints: ConstraintsV1): number {
  try {
    return utf8ByteLength(JSON.stringify(constraints))
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export type ConstraintsCapacityResult =
  | { ok: true; count: number; bytes: number }
  | {
      ok: false
      reason: 'too_many' | 'too_large'
      count: number
      bytes: number
      message: string
    }

/** 条数 ≤24、紧凑 UTF-8 ≤16 KiB；超限明确失败，不截断、不丢条目。 */
export function checkConstraintsCapacity(constraints: ConstraintsV1): ConstraintsCapacityResult {
  const count = constraints.items.length
  const bytes = constraintsByteLength(constraints)
  if (count > MAX_CONSTRAINT_ITEMS) {
    return {
      ok: false,
      reason: 'too_many',
      count,
      bytes,
      message: `约束最多 ${MAX_CONSTRAINT_ITEMS} 条（当前 ${count} 条）；未写入，不截断、不驱逐。`,
    }
  }
  if (bytes > MAX_CONSTRAINTS_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      count,
      bytes,
      message: `约束 JSON 最多 ${MAX_CONSTRAINTS_BYTES} 字节（当前 ${bytes} 字节）；未写入，不截断、不丢条目。`,
    }
  }
  return { ok: true, count, bytes }
}

export function constraintsFingerprint(constraints: ConstraintsV1): WorkspaceFingerprintV1 | null {
  const result = fingerprintOf(constraints)
  return result.ok ? result.fingerprint : null
}

/** 完整 canonical 相等才算相同；short hash 不单独自证。 */
export function constraintsContentEqual(left: ConstraintsV1, right: ConstraintsV1): boolean {
  const leftFingerprint = constraintsFingerprint(left)
  const rightFingerprint = constraintsFingerprint(right)
  return leftFingerprint !== null && rightFingerprint !== null && fingerprintsMatch(leftFingerprint, rightFingerprint)
}

/** 深拷贝约束条目，避免组件草稿与工作区记录共享可变对象。 */
export function cloneConstraints(constraints: ConstraintsV1): ConstraintsV1 {
  return { items: constraints.items.map((item) => ({ ...item })) }
}

/* ───────── 编辑（返回新对象；不改 Trip / 原约束） ───────── */

export interface NewConstraintInput {
  id?: string
  kind: ConstraintKindV1
  title: string
  day?: number | null
  stopId?: string | null
  startDate?: string | null
  endDate?: string | null
  startTime?: string | null
  endTime?: string | null
  durationMinutes?: number | null
  notes?: string | null
  priority?: number
}

function failure(reason: WorkspaceValidationFailure['reason'], path: string, message: string): WorkspaceValidationFailure {
  return { ok: false, reason, path, message }
}

/** 由表单输入构造一条合法约束；updatedAt 由调用方传入，模块不读时钟。 */
export function makeConstraintItem(
  input: NewConstraintInput,
  now: number,
): WorkspaceValidationResult<ConstraintItemV1> {
  const notes = input.notes?.trim() ?? ''
  const item: ConstraintItemV1 = {
    id: input.id ?? createLogicalId(),
    kind: input.kind,
    title: input.title.trim(),
    day: input.day ?? null,
    stopId: input.stopId ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    durationMinutes: input.durationMinutes ?? null,
    notes: notes.length === 0 ? null : notes,
    priority: input.priority ?? 1,
    updatedAt: now,
  }
  const checked = validateConstraints({ items: [item] })
  if (!checked.ok) return checked
  return { ok: true, value: checked.value.items[0] }
}

function withCapacityCheck(validated: ConstraintsV1): WorkspaceValidationResult<ConstraintsV1> {
  const capacity = checkConstraintsCapacity(validated)
  if (!capacity.ok) {
    return failure('limit_exceeded', '$.items', capacity.message)
  }
  return { ok: true, value: validated }
}

/** 新增一条；拒绝 >24 条、重复 id、>16 KiB。 */
export function addConstraintItem(
  constraints: ConstraintsV1,
  item: ConstraintItemV1,
): WorkspaceValidationResult<ConstraintsV1> {
  if (constraints.items.length >= MAX_CONSTRAINT_ITEMS) {
    return failure(
      'limit_exceeded',
      '$.items',
      `约束最多 ${MAX_CONSTRAINT_ITEMS} 条；本次未添加，不截断、不驱逐。`,
    )
  }
  const checked = validateConstraints({ items: [...constraints.items, item] })
  if (!checked.ok) return checked
  return withCapacityCheck(checked.value)
}

/** 按 id 替换一条；id 必须已存在。 */
export function replaceConstraintItem(
  constraints: ConstraintsV1,
  item: ConstraintItemV1,
): WorkspaceValidationResult<ConstraintsV1> {
  if (!constraints.items.some((entry) => entry.id === item.id)) {
    return failure('missing_field', '$.items.id', '要更新的约束不存在；未做任何修改。')
  }
  const next = constraints.items.map((entry) => (entry.id === item.id ? item : entry))
  const checked = validateConstraints({ items: next })
  if (!checked.ok) return checked
  return withCapacityCheck(checked.value)
}

/** 按 id 删除一条；删除不存在的 id 明确失败。 */
export function removeConstraintItem(
  constraints: ConstraintsV1,
  id: string,
): WorkspaceValidationResult<ConstraintsV1> {
  if (!constraints.items.some((entry) => entry.id === id)) {
    return failure('missing_field', '$.items.id', '要删除的约束不存在；未做任何修改。')
  }
  const checked = validateConstraints({ items: constraints.items.filter((entry) => entry.id !== id) })
  if (!checked.ok) return checked
  return withCapacityCheck(checked.value)
}

/** 每次编辑 / 切换 / 取消 / 采纳 / 撤销都必须推进的单调 epoch。 */
export function advanceConstraintsEpoch(current: number): WorkspaceValidationResult<number> {
  if (!Number.isSafeInteger(current) || current < 0) {
    return failure('invalid_field', '$.epoch', 'epoch 必须是非负安全整数。')
  }
  if (current >= MAX_SAFE_WORKSPACE_REVISION) {
    return failure('invalid_field', '$.epoch', 'epoch 已达到安全整数上限，不能继续推进。')
  }
  return { ok: true, value: current + 1 }
}

/* ───────── 目标解析 / H·U 评估 ───────── */

export type ConstraintTimeOrigin = 'known' | 'placeholder' | 'unknown'

export type ConstraintIssueCode =
  | 'scope_mismatch'
  | 'frozen_stop_missing'
  | 'frozen_stop_changed'
  | 'must_visit_missing'
  | 'target_ambiguous'
  | 'target_deleted'
  | 'coordinate_conflict'
  | 'identity_unverified'
  | 'window_incomplete'
  | 'window_invalid'
  | 'window_overlap'
  | 'day_date_unknown'
  | 'date_mismatch'
  | 'stop_time_unknown'
  | 'stop_duration_unknown'
  | 'stop_before_window'
  | 'stop_after_window'
  | 'stop_duration_exceeds'
  | 'transit_unknown'
  | 'predecessor_unknown'
  | 'arrival_after_window'
  | 'arrival_after_stop_start'

export type ConstraintIssueSeverity = 'H' | 'U'

export interface ConstraintIssue {
  severity: ConstraintIssueSeverity
  code: ConstraintIssueCode
  message: string
  constraintId: string | null
  title: string | null
  day: number | null
  stopId: string | null
}

export type ConstraintTargetStatus =
  | 'exact'
  | 'unique_name'
  | 'entity_unique'
  | 'ambiguous'
  | 'missing'
  | 'coordinate_conflict'
  | 'identity_unverified'
  | 'not_bound'

export interface ConstraintTargetResolution {
  constraintId: string
  title: string
  day: number | null
  sourceStopId: string | null
  resolvedStopId: string | null
  status: ConstraintTargetStatus
  message: string | null
}

export type ConstraintsVerdict = 'pass' | 'needs_ack' | 'blocked'

export interface ConstraintsEvaluation {
  verdict: ConstraintsVerdict
  hardIssues: ConstraintIssue[]
  unknownIssues: ConstraintIssue[]
  issues: ConstraintIssue[]
  safeToApply: boolean
  requiresAck: boolean
  resolutions: ConstraintTargetResolution[]
  /** 仅供本地评估：已唯一映射到候选 Trip 的 stopId；null 目标不伪造 id。 */
  mappedConstraints: ConstraintsV1
  constraintsBytes: number
  notices: string[]
}

export type ConstraintsEvaluationFailureReason =
  | 'invalid_constraints'
  | 'over_capacity'
  | 'invalid_scope'

export type ConstraintsEvaluationResult =
  | ({ ok: true } & ConstraintsEvaluation)
  | {
      ok: false
      reason: ConstraintsEvaluationFailureReason
      message: string
      failure?: WorkspaceValidationFailure
    }

export interface EvaluateConstraintsInput {
  constraints: ConstraintsV1
  /** 最终要应用的完整 Trip（例如 day_tail 合并后的 Trip），不是仅后段。 */
  trip: Trip
  /** 生成候选前的基准 Trip；AI 重写 stop id 时用于唯一名称 / 坐标映射。缺省 = trip。 */
  sourceTrip?: Trip | null
  /**
   * 工作区 record；与 planScope 同时提供时，直接复用公共
   * validatePlanScope / validateConstraintsForScope，不在本模块重造 scope 规则。
   */
  record?: WorkspaceRecordV1 | null
  /** 请求 / 候选 scope；提供 record 时走公共 scope 校验。 */
  planScope?: PlanScopeV1 | null
  /**
   * stopId → 时间来源。缺省 / 未列出 / placeholder / unknown 一律按未知；
   * 只有显式 'known' 才按真实时刻核 H。不得从非空 Trip.time 推断 known。
   */
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
  /** day_tail 等冻结段快照；缺失或内容变化直接 H；冻结本身不证明时间已核实。 */
  frozenStops?: readonly TripStop[] | null
  frozenStopIds?: readonly string[] | null
}

interface FoundStop {
  day: TripDay
  stop: TripStop
  index: number
}

function findDay(trip: Trip, dayNumber: number | null): TripDay | null {
  if (dayNumber === null) return null
  return trip.days.find((day) => day.day === dayNumber) ?? null
}

function findStopById(trip: Trip, stopId: string | null): FoundStop | null {
  if (stopId === null) return null
  for (const day of trip.days) {
    const index = day.stops.findIndex((stop) => stop.id === stopId)
    if (index >= 0) return { day, stop: day.stops[index], index }
  }
  return null
}

function sameLocation(
  left: { lng: number; lat: number } | null,
  right: { lng: number; lat: number } | null,
): boolean {
  if (left === null && right === null) return true
  if (left === null || right === null) return false
  return left.lng === right.lng && left.lat === right.lat
}

function sameStopSnapshot(left: TripStop, right: TripStop): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.time === right.time &&
    left.duration_minutes === right.duration_minutes &&
    left.address === right.address &&
    left.description === right.description &&
    sameLocation(left.location, right.location)
  )
}

function stopTitleMatches(stop: TripStop, title: string): boolean {
  return normalizeConstraintTitle(stop.name) === normalizeConstraintTitle(title)
}

function resolveTargets(
  trip: Trip,
  sourceTrip: Trip,
  constraints: ConstraintsV1,
): ConstraintTargetResolution[] {
  return constraints.items.map((item) => {
    if (item.stopId === null) {
      if (item.kind !== 'must_visit') {
        return {
          constraintId: item.id,
          title: item.title,
          day: item.day,
          sourceStopId: null,
          resolvedStopId: null,
          status: 'not_bound',
          message: null,
        }
      }
      const targetDay = findDay(trip, item.day)
      if (!targetDay) {
        return {
          constraintId: item.id,
          title: item.title,
          day: item.day,
          sourceStopId: null,
          resolvedStopId: null,
          status: 'missing',
          message: `第 ${item.day ?? '未知'} 天不在当前行程里，必去目标无法定位。`,
        }
      }
      const matches = targetDay.stops.filter((stop) => stopTitleMatches(stop, item.title))
      if (matches.length === 0) {
        return {
          constraintId: item.id,
          title: item.title,
          day: item.day,
          sourceStopId: null,
          resolvedStopId: null,
          status: 'missing',
          message: `第 ${item.day} 天没有与「${item.title}」同名（规范化后）的站点，必去目标缺失。`,
        }
      }
      if (matches.length > 1) {
        return {
          constraintId: item.id,
          title: item.title,
          day: item.day,
          sourceStopId: null,
          resolvedStopId: null,
          status: 'ambiguous',
          message: `第 ${item.day} 天有 ${matches.length} 个同名站点，无法唯一确定必去目标；不替你挑第一个。`,
        }
      }
      return {
        constraintId: item.id,
        title: item.title,
        day: item.day,
        sourceStopId: null,
        resolvedStopId: matches[0].id,
        status: 'entity_unique',
        message: null,
      }
    }

    const sourceFound = findStopById(sourceTrip, item.stopId)
    const targetDayNumber = item.day ?? sourceFound?.day.day ?? null
    const targetDay = findDay(trip, targetDayNumber)
    if (!targetDay) {
      return {
        constraintId: item.id,
        title: item.title,
        day: targetDayNumber,
        sourceStopId: item.stopId,
        resolvedStopId: null,
        status: 'missing',
        message: `约束绑定的 stop「${item.stopId}」不在目标日 ${targetDayNumber ?? '未知'} 的当前行程里。`,
      }
    }
    const exact = targetDay.stops.find((stop) => stop.id === item.stopId)
    if (exact) {
      return {
        constraintId: item.id,
        title: item.title,
        day: targetDayNumber,
        sourceStopId: item.stopId,
        resolvedStopId: exact.id,
        status: 'exact',
        message: null,
      }
    }
    if (!sourceFound) {
      return {
        constraintId: item.id,
        title: item.title,
        day: targetDayNumber,
        sourceStopId: item.stopId,
        resolvedStopId: null,
        status: 'missing',
        message: `约束绑定的 stop「${item.stopId}」在基准行程中已不存在，无法确认保留。`,
      }
    }
    const candidates = targetDay.stops.filter((stop) =>
      stopTitleMatches(stop, sourceFound.stop.name),
    )
    if (candidates.length === 0) {
      return {
        constraintId: item.id,
        title: item.title,
        day: targetDayNumber,
        sourceStopId: item.stopId,
        resolvedStopId: null,
        status: 'missing',
        message: `候选行程第 ${targetDayNumber} 天没有与「${sourceFound.stop.name}」匹配的站点，绑定目标被删除。`,
      }
    }
    if (candidates.length > 1) {
      return {
        constraintId: item.id,
        title: item.title,
        day: targetDayNumber,
        sourceStopId: item.stopId,
        resolvedStopId: null,
        status: 'ambiguous',
        message: `候选行程第 ${targetDayNumber} 天有 ${candidates.length} 个同名站点，无法唯一映射；不 silent 挑第一个。`,
      }
    }
    const candidate = candidates[0]
    if (sourceFound.stop.location !== null && candidate.location !== null) {
      if (!sameLocation(sourceFound.stop.location, candidate.location)) {
        return {
          constraintId: item.id,
          title: item.title,
          day: targetDayNumber,
          sourceStopId: item.stopId,
          resolvedStopId: candidate.id,
          status: 'coordinate_conflict',
          message: `候选站点与基准站点同名但坐标不同，不能确认是同一地点；按未核实处理。`,
        }
      }
      return {
        constraintId: item.id,
        title: item.title,
        day: targetDayNumber,
        sourceStopId: item.stopId,
        resolvedStopId: candidate.id,
        status: 'unique_name',
        message: null,
      }
    }
    return {
      constraintId: item.id,
      title: item.title,
      day: targetDayNumber,
      sourceStopId: item.stopId,
      resolvedStopId: candidate.id,
      status: 'identity_unverified',
      message: `候选站点与基准站点同名，但至少一方坐标未知，无法确证是同一地点；按未核实处理。`,
    }
  })
}

function issueFor(
  severity: ConstraintIssueSeverity,
  code: ConstraintIssueCode,
  item: ConstraintItemV1 | null,
  message: string,
  overrides: Partial<Pick<ConstraintIssue, 'constraintId' | 'title' | 'day' | 'stopId'>> = {},
): ConstraintIssue {
  return {
    severity,
    code,
    message,
    constraintId: overrides.constraintId ?? item?.id ?? null,
    title: overrides.title ?? item?.title ?? null,
    day: overrides.day ?? item?.day ?? null,
    stopId: overrides.stopId ?? item?.stopId ?? null,
  }
}

function stopTimeEvidence(
  stop: TripStop,
  origins: Readonly<Record<string, ConstraintTimeOrigin>> | null | undefined,
): { minutes: number | null; origin: ConstraintTimeOrigin } {
  // fail-closed：没有显式 known 证据就按 unknown；非空 time / 冻结段存在都不算证据。
  const origin = origins?.[stop.id] ?? 'unknown'
  const minutes = parseConstraintClock(stop.time)
  if (origin !== 'known' || minutes === null) {
    return { minutes: null, origin: origin === 'known' ? 'unknown' : origin }
  }
  return { minutes, origin: 'known' }
}

function knownDuration(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
  return value
}

interface CompleteWindow {
  item: ConstraintItemV1
  start: number
  end: number
}

function checkScheduleForWindow(
  item: ConstraintItemV1,
  window: CompleteWindow,
  resolution: ConstraintTargetResolution | undefined,
  trip: Trip,
  origins: Readonly<Record<string, ConstraintTimeOrigin>> | null | undefined,
  hardIssues: ConstraintIssue[],
  unknownIssues: ConstraintIssue[],
): void {
  if (!resolution || resolution.resolvedStopId === null) return
  if (resolution.status !== 'exact' && resolution.status !== 'unique_name') return
  const found = findStopById(trip, resolution.resolvedStopId)
  if (!found) return
  const { day, stop, index } = found
  const dayDate = parseConstraintDate(day.date)
  if (!dayDate) {
    unknownIssues.push(
      issueFor(
        'U',
        'day_date_unknown',
        item,
        `目标日 ${day.day} 没有真实日期，无法把预约窗口与当地时刻对齐；按未核实处理。`,
        { day: day.day, stopId: stop.id },
      ),
    )
    return
  }
  const startDate = parseConstraintDate(item.startDate)
  const endDate = parseConstraintDate(item.endDate)
  if (!startDate || !endDate) return
  if (dayDate.ordinal < startDate.ordinal || dayDate.ordinal > endDate.ordinal) {
    hardIssues.push(
      issueFor(
        'H',
        'date_mismatch',
        item,
        `目标日 ${day.day} 的日期 ${day.date} 不在预约窗口的日期范围内，预约日期与行程日不一致。`,
        { day: day.day, stopId: stop.id },
      ),
    )
    return
  }

  const time = stopTimeEvidence(stop, origins)
  let startAbsolute: number | null = null
  if (time.minutes === null) {
    const originLabel = time.origin === 'placeholder' ? '占位值' : '未知值'
    unknownIssues.push(
      issueFor(
        'U',
        'stop_time_unknown',
        item,
        `目标站点「${stop.name}」的开始时刻是${originLabel}（${stop.time || '空'}），不能当作已知端硬核预约窗口。`,
        { day: day.day, stopId: stop.id },
      ),
    )
  } else {
    startAbsolute = dayDate.ordinal * 1440 + time.minutes
    if (startAbsolute < window.start) {
      hardIssues.push(
        issueFor(
          'H',
          'stop_before_window',
          item,
          `目标站点「${stop.name}」按填写时刻 ${stop.time} 早于预约窗口开始；当前候选没有落在预约窗口内。`,
          { day: day.day, stopId: stop.id },
        ),
      )
    } else if (startAbsolute > window.end) {
      hardIssues.push(
        issueFor(
          'H',
          'stop_after_window',
          item,
          `目标站点「${stop.name}」按填写时刻 ${stop.time} 晚于预约窗口结束；当前候选无法满足预约。`,
          { day: day.day, stopId: stop.id },
        ),
      )
    } else {
      const duration = knownDuration(stop.duration_minutes)
      if (duration === null) {
        unknownIssues.push(
          issueFor(
            'U',
            'stop_duration_unknown',
            item,
            `目标站点「${stop.name}」停留时长未知；不能确认在预约窗口内结束，也不补 0。`,
            { day: day.day, stopId: stop.id },
          ),
        )
      } else if (startAbsolute + duration > window.end) {
        hardIssues.push(
          issueFor(
            'H',
            'stop_duration_exceeds',
            item,
            `目标站点「${stop.name}」开始 ${stop.time}、停留 ${duration} 分钟，结束下界晚于预约窗口结束；当前候选不可能完整落在窗口内。`,
            { day: day.day, stopId: stop.id },
          ),
        )
      }
    }
  }

  if (index === 0) return
  const previous = day.stops[index - 1]
  const previousTime = stopTimeEvidence(previous, origins)
  const previousDuration = knownDuration(previous.duration_minutes)
  const leg = day.legs.find(
    (entry) => entry.from_stop_id === previous.id && entry.to_stop_id === stop.id,
  )
  if (!leg) {
    unknownIssues.push(
      issueFor(
        'U',
        'transit_unknown',
        item,
        `「${previous.name}」到「${stop.name}」之间没有可用的交通段记录，到达时刻未知；不假设可达。`,
        { day: day.day, stopId: stop.id },
      ),
    )
    return
  }
  const legDuration = knownDuration(leg.duration_minutes)
  if (legDuration === null) {
    unknownIssues.push(
      issueFor(
        'U',
        'transit_unknown',
        item,
        `「${previous.name}」到「${stop.name}」的交通耗时未知；到达时刻未知，不补 0、不假设可达。`,
        { day: day.day, stopId: stop.id },
      ),
    )
    return
  }
  if (previousTime.minutes === null || previousDuration === null) {
    unknownIssues.push(
      issueFor(
        'U',
        'predecessor_unknown',
        item,
        `前一站「${previous.name}」的开始时刻或停留时长未知，无法推算到达「${stop.name}」的下界。`,
        { day: day.day, stopId: stop.id },
      ),
    )
    return
  }
  const arrival = dayDate.ordinal * 1440 + previousTime.minutes + previousDuration + legDuration
  if (arrival > window.end) {
    hardIssues.push(
      issueFor(
        'H',
        'arrival_after_window',
        item,
        `按前一站与已知交通耗时推算，到达「${stop.name}」不早于窗口结束后；当前候选明确不可达。`,
        { day: day.day, stopId: stop.id },
      ),
    )
    return
  }
  if (startAbsolute !== null && arrival > startAbsolute) {
    hardIssues.push(
      issueFor(
        'H',
        'arrival_after_stop_start',
        item,
        `按前一站与已知交通耗时推算，到达「${stop.name}」晚于该站填写的开始时刻；当前候选时间自相矛盾。`,
        { day: day.day, stopId: stop.id },
      ),
    )
  }
}

/**
 * 在最终合并 Trip 上执行本地硬门。
 * 返回 pass / needs_ack / blocked 三种 typed 结论；不会写 workspace、不会改 Trip。
 */
export function evaluateConstraintsAgainstTrip(
  input: EvaluateConstraintsInput,
): ConstraintsEvaluationResult {
  const checked = validateConstraints(input.constraints)
  if (!checked.ok) {
    return { ok: false, reason: 'invalid_constraints', message: checked.message, failure: checked }
  }
  const capacity = checkConstraintsCapacity(checked.value)
  if (!capacity.ok) {
    return { ok: false, reason: 'over_capacity', message: capacity.message }
  }
  const constraints = checked.value
  const sourceTrip = input.sourceTrip ?? input.trip
  const resolutions = resolveTargets(input.trip, sourceTrip, constraints)
  const hardIssues: ConstraintIssue[] = []
  const unknownIssues: ConstraintIssue[] = []
  const notices: string[] = [
    '本地硬门只按你填写的日期、时刻与行程记录推算；没有核实真实预约、营业状态或交通。',
    '站点时刻默认按未核实处理；只有调用方显式提供 known 时间来源才参与 H 级硬核。',
    'null 表示未知，不会补 0；0 分钟停留 / 0 分钟交通是合法已知值。',
    '跨日窗口只按显式 startDate / endDate 计算；酒店连住不是景点预约。',
  ]

  if (input.planScope) {
    if (input.record) {
      // 直接复用公共 scope 逻辑：trip_plan 非 null stopId 拒绝；day/day_tail
      // 的 day / stop 关联与锚点存在性都在 validateConstraintsForScope 内。
      const scoped = validateConstraintsForScope(constraints, input.planScope, input.record)
      if (!scoped.ok) {
        return {
          ok: false,
          reason: 'invalid_scope',
          message: scoped.message,
          failure: scoped,
        }
      }
    } else {
      const scopeCheck = validatePlanScope(input.planScope)
      if (!scopeCheck.ok) {
        return {
          ok: false,
          reason: 'invalid_scope',
          message: scopeCheck.message,
          failure: scopeCheck,
        }
      }
    }
  }

  const frozenIds = new Set<string>()
  if (input.frozenStopIds) {
    for (const id of input.frozenStopIds) frozenIds.add(id)
  }
  if (input.frozenStops) {
    for (const frozen of input.frozenStops) {
      frozenIds.add(frozen.id)
      const current = findStopById(input.trip, frozen.id)
      if (!current) {
        hardIssues.push(
          issueFor(
            'H',
            'frozen_stop_missing',
            null,
            `冻结段站点「${frozen.name}」（${frozen.id}）在最终候选 Trip 中被删除；day_tail 冻结段必须由客户端完整保留。`,
            { stopId: frozen.id },
          ),
        )
      } else if (!sameStopSnapshot(frozen, current.stop)) {
        hardIssues.push(
          issueFor(
            'H',
            'frozen_stop_changed',
            null,
            `冻结段站点「${frozen.name}」被改动；冻结段必须原样保留，不能靠服务端回显证明。`,
            { stopId: frozen.id },
          ),
        )
      }
    }
  }
  for (const id of frozenIds) {
    const current = findStopById(input.trip, id)
    if (!current && !input.frozenStops?.some((stop) => stop.id === id)) {
      hardIssues.push(
        issueFor(
          'H',
          'frozen_stop_missing',
          null,
          `冻结段站点 ${id} 在最终候选 Trip 中不存在；冻结段必须由客户端完整保留。`,
          { stopId: id },
        ),
      )
    }
  }

  const resolutionById = new Map(resolutions.map((entry) => [entry.constraintId, entry]))
  const itemById = new Map(constraints.items.map((item) => [item.id, item]))

  for (const resolution of resolutions) {
    const item = itemById.get(resolution.constraintId)
    if (!item || item.kind === 'reminder') continue
    if (resolution.status === 'missing') {
      hardIssues.push(
        issueFor(
          'H',
          item.kind === 'must_visit' ? 'must_visit_missing' : 'target_deleted',
          item,
          resolution.message ?? '约束目标缺失，当前候选不能应用。',
          { day: resolution.day, stopId: resolution.sourceStopId },
        ),
      )
    } else if (resolution.status === 'ambiguous') {
      unknownIssues.push(
        issueFor(
          'U',
          'target_ambiguous',
          item,
          resolution.message ?? '约束目标存在多个同名候选，无法唯一确认；不 silent 挑第一个。',
          { day: resolution.day, stopId: resolution.sourceStopId },
        ),
      )
    } else if (resolution.status === 'coordinate_conflict') {
      unknownIssues.push(
        issueFor(
          'U',
          'coordinate_conflict',
          item,
          resolution.message ?? '候选站点与基准站点同名但坐标矛盾，不能确认为同一地点。',
          { day: resolution.day, stopId: resolution.sourceStopId },
        ),
      )
    } else if (resolution.status === 'identity_unverified') {
      unknownIssues.push(
        issueFor(
          'U',
          'identity_unverified',
          item,
          resolution.message ?? '候选站点身份无法确证；按未核实处理。',
          { day: resolution.day, stopId: resolution.sourceStopId },
        ),
      )
    }
  }

  const completeWindows: CompleteWindow[] = []
  for (const item of constraints.items) {
    if (item.kind !== 'fixed_window') continue
    const start = constraintLocalMinute(item.startDate, item.startTime)
    const end = constraintLocalMinute(item.endDate, item.endTime)
    if (start === null || end === null) {
      const missing: string[] = []
      if (item.startDate === null) missing.push('开始日期')
      if (item.endDate === null) missing.push('结束日期')
      if (item.startTime === null) missing.push('开始时刻')
      if (item.endTime === null) missing.push('结束时刻')
      unknownIssues.push(
        issueFor(
          'U',
          'window_incomplete',
          item,
          `预约窗口缺少${missing.join('、')}；必要时间端未知，不能声称已满足，应用前需独立确认。`,
        ),
      )
      continue
    }
    if (end < start) {
      hardIssues.push(
        issueFor(
          'H',
          'window_invalid',
          item,
          '预约窗口结束早于开始；同一日期内结束时刻不能早于开始时刻，跨午夜必须显式写次日 endDate。',
        ),
      )
      continue
    }
    const window: CompleteWindow = { item, start, end }
    completeWindows.push(window)
    checkScheduleForWindow(
      item,
      window,
      resolutionById.get(item.id),
      input.trip,
      input.timeOrigins,
      hardIssues,
      unknownIssues,
    )
    if (item.stopId === null) {
      const notice = `预约「${item.title}」的窗口本身完整，但尚未绑定站点；本地只能核对窗口结构与重叠，不能证明它落到了行程中。`
      if (!notices.includes(notice)) notices.push(notice)
    }
  }

  for (let left = 0; left < completeWindows.length; left += 1) {
    for (let right = left + 1; right < completeWindows.length; right += 1) {
      const a = completeWindows[left]
      const b = completeWindows[right]
      if (a.start < b.end && b.start < a.end) {
        hardIssues.push(
          issueFor(
            'H',
            'window_overlap',
            b.item,
            `预约「${a.item.title}」与「${b.item.title}」的时间窗口重叠；同时候选无法同时满足，直接禁止应用。`,
          ),
        )
      }
    }
  }

  const mappedConstraints: ConstraintsV1 = {
    items: constraints.items.map((item) => {
      const resolution = resolutionById.get(item.id)
      if (
        item.stopId !== null &&
        resolution &&
        (resolution.status === 'exact' || resolution.status === 'unique_name') &&
        resolution.resolvedStopId !== null
      ) {
        return { ...item, stopId: resolution.resolvedStopId }
      }
      return { ...item }
    }),
  }

  const issues = [...hardIssues, ...unknownIssues]
  const verdict: ConstraintsVerdict =
    hardIssues.length > 0 ? 'blocked' : unknownIssues.length > 0 ? 'needs_ack' : 'pass'

  return {
    ok: true,
    verdict,
    hardIssues,
    unknownIssues,
    issues,
    safeToApply: verdict === 'pass',
    requiresAck: verdict === 'needs_ack',
    resolutions,
    mappedConstraints,
    constraintsBytes: capacity.bytes,
    notices,
  }
}

/* ───────── 评估输入上下文：timeOrigins / frozen 变化必须使旧 ticket 失效 ───────── */

interface FrozenStopEvaluationContext {
  id: string
  name: string
  time: string
  durationMinutes: number | null
  address: string | null
  description: string | null
  location: { lng: number; lat: number } | null
}

function frozenStopEvaluationContext(stop: TripStop): FrozenStopEvaluationContext {
  return {
    id: stop.id,
    name: stop.name,
    time: stop.time,
    durationMinutes: stop.duration_minutes ?? null,
    address: stop.address ?? null,
    description: stop.description ?? null,
    location: stop.location ? { lng: stop.location.lng, lat: stop.location.lat } : null,
  }
}

/**
 * 把参与 H/U 判定的非 Trip / 非 constraints 输入（timeOrigins、冻结段）做成
 * 确定性指纹。缺省、空 map 与空数组都归一为 null，避免语义相同但引用不同的误失效。
 */
function evaluationContextFingerprint(input: {
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
  frozenStops?: readonly TripStop[] | null
  frozenStopIds?: readonly string[] | null
}): { ok: true; fingerprint: WorkspaceFingerprintV1 | null } | { ok: false; message: string } {
  const originEntries = input.timeOrigins
    ? Object.keys(input.timeOrigins)
        .sort()
        .map((id) => [id, input.timeOrigins![id]] as const)
    : []
  const frozenIds = new Set<string>()
  for (const id of input.frozenStopIds ?? []) frozenIds.add(id)
  for (const stop of input.frozenStops ?? []) frozenIds.add(stop.id)
  const frozenStops = (input.frozenStops ?? [])
    .map(frozenStopEvaluationContext)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  if (originEntries.length === 0 && frozenIds.size === 0 && frozenStops.length === 0) {
    return { ok: true, fingerprint: null }
  }
  const fingerprint = fingerprintOf({
    timeOrigins: originEntries,
    frozenStopIds: [...frozenIds].sort(),
    frozenStops,
  })
  if (!fingerprint.ok) return { ok: false, message: fingerprint.message }
  return { ok: true, fingerprint: fingerprint.fingerprint }
}

function evaluationContextsMatch(
  left: WorkspaceFingerprintV1 | null | undefined,
  right: WorkspaceFingerprintV1 | null,
): boolean {
  // 旧 ticket 无该字段时按“无附加评估输入”兼容；当前上下文非空则一律拒绝。
  if (left === undefined) return right === null
  if (left === null || right === null) return left === null && right === null
  return fingerprintsMatch(left, right)
}

/* ───────── apply ticket：U 确认 / 候选快照 / 实际引用 / epoch ───────── */

export type ConstraintsApplyFailureReason =
  | 'invalid_record'
  | 'invalid_constraints'
  | 'over_capacity'
  | 'invalid_scope'
  | 'invalid_epoch'
  | 'hard_blocked'
  | 'ack_required'
  | 'unserializable'
  | 'ref_mismatch'
  | 'ticket_stale'
  | 'scope_mismatch'

export interface ConstraintsApplyFailure {
  ok: false
  reason: ConstraintsApplyFailureReason
  message: string
  evaluation?: ConstraintsEvaluation
}

export interface ConstraintsApplyTicketV1 {
  /** 整条工作区记录的 canonical + identity + revision + epoch。 */
  readonly owner: WorkspaceOwnerV1
  /** 约束 canonical + identity + revision + scope + epoch。 */
  readonly binding: ConstraintsBindingV1
  /** 仅 U 级方案需要；绑定完整身份 / revision / constraints / scope / epoch。 */
  readonly ack: UnverifiedConstraintsAckV1 | null
  readonly candidateTripId: string
  /** 候选 Trip 完整 canonical；short 只作索引。 */
  readonly candidate: WorkspaceFingerprintV1
  /** timeOrigins + 冻结段等评估输入指纹；变化后旧 ticket / U ack 不可复用。旧 ticket 无此字段时视为 null。 */
  readonly evaluationContext?: WorkspaceFingerprintV1 | null
  readonly epoch: number
  /** 实际对象引用捕获；不序列化、不入 storage。 */
  readonly runtime: WorkspaceRuntimeCaptureV1
}

export interface CreateConstraintsApplyTicketInput {
  record: WorkspaceRecordV1
  constraints: ConstraintsV1
  candidateTrip: Trip
  planScope: PlanScopeV1
  epoch: number
  acknowledgedAt: number
  /** U 级方案必须显式勾选「仍采用含未核实时间方案」。 */
  unverifiedConfirmed: boolean
  /** 缺省 = 全部未知；只有显式 'known' 才按真实时刻核 H。 */
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
  frozenStops?: readonly TripStop[] | null
  frozenStopIds?: readonly string[] | null
}

function applyFailure(
  reason: ConstraintsApplyFailureReason,
  message: string,
  evaluation?: ConstraintsEvaluation,
): ConstraintsApplyFailure {
  return { ok: false, reason, message, evaluation }
}

/**
 * 生成 apply ticket。它只存在于内存：绑定 owner / binding / 可选 U ack / 候选完整快照 /
 * 实际引用 / epoch。任何编辑、切换、取消、采纳、撤销都必须丢弃旧 ticket 并推进 epoch。
 */
export function createConstraintsApplyTicket(
  input: CreateConstraintsApplyTicketInput,
): { ok: true; value: ConstraintsApplyTicketV1 } | ConstraintsApplyFailure {
  const recordCheck = validateWorkspaceRecord(input.record)
  if (!recordCheck.ok) {
    return applyFailure('invalid_record', `工作区记录不合法：${recordCheck.message}`)
  }
  const capacity = checkConstraintsCapacity(input.constraints)
  if (!capacity.ok) {
    return applyFailure('over_capacity', capacity.message)
  }
  const scopeCheck = validateConstraintsForScope(input.constraints, input.planScope, input.record)
  if (!scopeCheck.ok) {
    return applyFailure('invalid_scope', scopeCheck.message)
  }
  const evaluationContext = evaluationContextFingerprint({
    timeOrigins: input.timeOrigins,
    frozenStops: input.frozenStops,
    frozenStopIds: input.frozenStopIds,
  })
  if (!evaluationContext.ok) {
    return applyFailure('unserializable', `评估输入无法序列化：${evaluationContext.message}`)
  }
  const runtime = captureWorkspaceRuntime(input.record, input.epoch, { input: input.candidateTrip })
  if (!runtime.ok) {
    return applyFailure('invalid_epoch', runtime.message)
  }
  const evaluation = evaluateConstraintsAgainstTrip({
    constraints: input.constraints,
    trip: input.candidateTrip,
    sourceTrip: input.record.trip,
    record: input.record,
    planScope: input.planScope,
    timeOrigins: input.timeOrigins,
    frozenStops: input.frozenStops,
    frozenStopIds: input.frozenStopIds,
  })
  if (!evaluation.ok) {
    return applyFailure('invalid_constraints', evaluation.message)
  }
  if (evaluation.verdict === 'blocked') {
    return applyFailure(
      'hard_blocked',
      '存在 H 级硬冲突；不能应用，也不能靠用户确认绕过。',
      evaluation,
    )
  }
  if (evaluation.requiresAck && !input.unverifiedConfirmed) {
    return applyFailure(
      'ack_required',
      '存在未核实时间端；必须独立确认「仍采用含未核实时间方案」后才能应用。',
      evaluation,
    )
  }
  const owner = createWorkspaceOwner(input.record, input.epoch)
  if (!owner.ok) {
    return applyFailure('invalid_record', owner.message, evaluation)
  }
  const binding = createConstraintsBinding(
    input.record,
    input.constraints,
    input.planScope,
    input.epoch,
  )
  if (!binding.ok) {
    return applyFailure('invalid_scope', binding.message, evaluation)
  }
  const candidateFingerprint = fingerprintOf(input.candidateTrip)
  if (!candidateFingerprint.ok) {
    return applyFailure('unserializable', candidateFingerprint.message, evaluation)
  }
  let ack: UnverifiedConstraintsAckV1 | null = null
  if (evaluation.requiresAck) {
    const ackCheck = createUnverifiedConstraintsAck(
      input.record,
      input.constraints,
      input.planScope,
      input.epoch,
      input.acknowledgedAt,
    )
    if (!ackCheck.ok) {
      return applyFailure('ticket_stale', ackCheck.message, evaluation)
    }
    ack = ackCheck.value
  }
  return {
    ok: true,
    value: {
      owner: owner.value,
      binding: binding.value,
      ack,
      candidateTripId: input.candidateTrip.id,
      candidate: candidateFingerprint.fingerprint,
      evaluationContext: evaluationContext.fingerprint,
      epoch: input.epoch,
      runtime: runtime.value,
    },
  }
}

export interface CheckConstraintsApplyInput {
  ticket: ConstraintsApplyTicketV1
  record: WorkspaceRecordV1
  constraints: ConstraintsV1
  candidateTrip: Trip
  planScope: PlanScopeV1
  epoch: number
  /** 必须与 ticket 创建时一致；缺省 = 全部未知，不能从非空 time 推断 known。 */
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
  frozenStops?: readonly TripStop[] | null
  frozenStopIds?: readonly string[] | null
}

export interface ConstraintsApplyDecision {
  allowed: boolean
  reason: 'ok' | ConstraintsApplyFailureReason
  message: string
  evaluation: ConstraintsEvaluation | null
}

function planScopesEqual(left: PlanScopeV1, right: PlanScopeV1): boolean {
  return (
    left.scope === right.scope &&
    left.day === right.day &&
    left.anchorStopId === right.anchorStopId
  )
}

/**
 * 最终 apply guard。顺序：
 * 1) 在最终合并 Trip 上重跑 H/U；
 * 2) timeOrigins / 冻结段等评估输入指纹（变化即旧 ticket / U ack 失效）；
 * 3) 实际对象引用 + epoch 严格相等（workspaceRuntimeRefsMatch）；
 * 4) owner 完整 canonical + identity + revision + epoch；
 * 5) binding 的 constraints canonical + scope + epoch；
 * 6) 候选完整 canonical + tripId；
 * 7) U 级 ack 仍匹配。
 *
 * 任一项变化都拒绝；A→B→A 即使内容回到旧值，也会因 revision / epoch 前进而失效。
 */
export function checkConstraintsApply(input: CheckConstraintsApplyInput): ConstraintsApplyDecision {
  const recordCheck = validateWorkspaceRecord(input.record)
  if (!recordCheck.ok) {
    return {
      allowed: false,
      reason: 'invalid_record',
      message: `工作区记录不合法：${recordCheck.message}`,
      evaluation: null,
    }
  }
  const evaluation = evaluateConstraintsAgainstTrip({
    constraints: input.constraints,
    trip: input.candidateTrip,
    sourceTrip: input.record.trip,
    record: input.record,
    planScope: input.planScope,
    timeOrigins: input.timeOrigins,
    frozenStops: input.frozenStops,
    frozenStopIds: input.frozenStopIds,
  })
  if (!evaluation.ok) {
    return {
      allowed: false,
      reason: 'invalid_constraints',
      message: evaluation.message,
      evaluation: null,
    }
  }
  if (evaluation.verdict === 'blocked') {
    return {
      allowed: false,
      reason: 'hard_blocked',
      message: '存在 H 级硬冲突；不能应用，也不能靠用户确认绕过。',
      evaluation,
    }
  }
  const currentContext = evaluationContextFingerprint({
    timeOrigins: input.timeOrigins,
    frozenStops: input.frozenStops,
    frozenStopIds: input.frozenStopIds,
  })
  if (!currentContext.ok) {
    return {
      allowed: false,
      reason: 'ticket_stale',
      message: `评估输入无法序列化：${currentContext.message}`,
      evaluation,
    }
  }
  if (!evaluationContextsMatch(input.ticket.evaluationContext, currentContext.fingerprint)) {
    return {
      allowed: false,
      reason: 'ticket_stale',
      message: 'timeOrigins / 冻结段等评估输入已变化；旧 ticket 与 U 确认失效，请重新生成。',
      evaluation,
    }
  }
  if (evaluation.requiresAck && input.ticket.ack === null) {
    return {
      allowed: false,
      reason: 'ack_required',
      message: '存在未核实时间端；旧 ticket 没有独立确认，不能应用。',
      evaluation,
    }
  }
  if (!planScopesEqual(input.ticket.binding.planScope, input.planScope)) {
    return {
      allowed: false,
      reason: 'scope_mismatch',
      message: '候选 scope 与当前请求 scope 不一致；请重新生成候选。',
      evaluation,
    }
  }
  if (
    !workspaceRuntimeRefsMatch(input.ticket.runtime, input.record, input.epoch, {
      input: input.candidateTrip,
    })
  ) {
    return {
      allowed: false,
      reason: 'ref_mismatch',
      message: '工作区或候选的实际对象引用 / epoch 已变化；旧确认失效，请重新生成。',
      evaluation,
    }
  }
  if (!workspaceOwnerMatches(input.ticket.owner, input.record, input.epoch)) {
    return {
      allowed: false,
      reason: 'ticket_stale',
      message: '工作区完整快照、revision 或 epoch 已变化；旧确认失效，请重新生成。',
      evaluation,
    }
  }
  if (
    !constraintsBindingMatches(
      input.ticket.binding,
      input.record,
      input.constraints,
      input.epoch,
    )
  ) {
    return {
      allowed: false,
      reason: 'ticket_stale',
      message: '约束内容、scope、revision 或 epoch 已变化；旧确认失效，请重新生成。',
      evaluation,
    }
  }
  const candidateFingerprint = fingerprintOf(input.candidateTrip)
  if (
    !candidateFingerprint.ok ||
    input.ticket.candidateTripId !== input.candidateTrip.id ||
    !fingerprintsMatch(input.ticket.candidate, candidateFingerprint.fingerprint)
  ) {
    return {
      allowed: false,
      reason: 'ticket_stale',
      message: '候选 Trip 内容已变化；旧确认失效，请重新生成。',
      evaluation,
    }
  }
  if (
    evaluation.requiresAck &&
    (input.ticket.ack === null ||
      !unverifiedConstraintsAckMatches(
        input.ticket.ack,
        input.record,
        input.constraints,
        input.epoch,
      ))
  ) {
    return {
      allowed: false,
      reason: 'ticket_stale',
      message: '未核实时间方案的独立确认已失效；请重新确认后再应用。',
      evaluation,
    }
  }
  return {
    allowed: true,
    reason: 'ok',
    message: '本地硬门与引用 / epoch / 候选快照全部匹配，可以进入工作区 transition。',
    evaluation,
  }
}

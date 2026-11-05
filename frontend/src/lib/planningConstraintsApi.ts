/**
 * F2 · 规划 constraints 的前端 wire 适配层（唯一 writer）。
 *
 * 职责边界：
 * - 只把本地 camelCase `ConstraintsV1` 严格映射为后端 snake_case 的 `constraints`；
 *   不新增 endpoint，不改 map-refresh / leg-refresh，不碰 Trip v1。
 * - 输入先走冻结的 `validateConstraints`（未知字段、24 条上限、null/0 语义）；
 *   day / day_tail 再按当前 workspace record + binding + epoch 核对 scope / stop /
 *   parent / revision，并核对 request.stops 与 anchor 的可见性。
 * - scope 只来自显式参数，绝不解析 instruction 前缀；instruction 原文字段不读、不改、
 *   不截断，constraints 永远放在独立字段。
 * - 所有失败都是 typed result（builder）或 `PlanningConstraintsError`（HTTP 包装），
 *   调用方必须在 fetch 之前处理；绝不丢下 constraints 静默发旧请求。
 * - `fingerprint` 是完整本地 constraints canonical 的 8 位短索引，只是不透明索引；
 *   owner 权威判定仍由调用方的 binding + record + revision + epoch + 完整 canonical 完成。
 *
 * 契约唯一来源：docs/WORKSPACE_SIDECAR.md §11。
 */

import type { DayReplanRequest } from './dayReplan'
import { constraintsFingerprint } from './constraints'
import type {
  ConstraintItemV1,
  ConstraintsBindingV1,
  ConstraintsV1,
  PlanScopeKindV1,
  PlanScopeV1,
  WorkspaceRecordV1,
  WorkspaceValidationFailure,
} from './workspaceTypes'
import {
  MAX_CONSTRAINT_ITEMS,
  MAX_CONSTRAINTS_BYTES,
} from './workspaceTypes'
import {
  constraintsBindingMatches,
  validateConstraints,
  validateConstraintsForScope,
  validatePlanScope,
} from './workspace'

/** 后端现有规划 request 的上限（day_replan.py / TripPlanRequest 均为 1..7 天）。 */
const MAX_BACKEND_PLAN_DAYS = 7

/** 现有 DayReplanStop.id 上限；超过的本地 stop id 不能走规划通道。 */
const MAX_BACKEND_STOP_ID_LENGTH = 100

/** 与 backend `constraints` 对象严格一致的 wire 形状（snake_case）。 */
export interface PlanningConstraintWireItemV1 {
  id: string
  kind: ConstraintItemV1['kind']
  day: number | null
  stop_id: string | null
  title: string
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  duration_minutes: number | null
  priority: number
}

export interface PlanningConstraintsWireV1 {
  version: 1
  scope: PlanScopeKindV1
  day: number | null
  anchor_stop_id: string | null
  fingerprint: string
  items: PlanningConstraintWireItemV1[]
}

export type PlanningConstraintsBuildFailureReason =
  | 'invalid_input'
  | 'invalid_constraints'
  | 'invalid_scope'
  | 'missing_context'
  | 'invalid_record'
  | 'invalid_binding'
  | 'binding_mismatch'
  | 'request_mismatch'
  | 'stop_not_in_request'
  | 'reserved_field'
  | 'too_many'
  | 'too_large'
  | 'unserializable'

export interface PlanningConstraintsBuildFailure {
  ok: false
  reason: PlanningConstraintsBuildFailureReason
  /** 冻结 validator 的原始失败原因（若有），便于 UI 区分 unknown_field / limit_exceeded。 */
  workspaceReason?: WorkspaceValidationFailure['reason']
  path?: string
  message: string
}

export interface PlanningConstraintsBuildSuccess {
  ok: true
  constraints: PlanningConstraintsWireV1
  itemCount: number
  /** 实际 wire `constraints` 紧凑 JSON 的 UTF-8 字节数（含 fingerprint）。 */
  byteLength: number
}

export type PlanningConstraintsBuildResult =
  | PlanningConstraintsBuildSuccess
  | PlanningConstraintsBuildFailure

/**
 * day / day_tail 发送约束时必须给出的当前上下文。
 * `binding` 必须是候选生成时记录的约束绑定；`record` / `epoch` 必须是当前值。
 *
 * 调用方（App / F2 UI owner）必须先在运行期完成 React refs + safe epoch +
 * 完整 canonical 门，再传入这里；本 API 不持有 React refs，也不写任何状态 /
 * storage / pending。旧 run 的 finally / abort 清理由 UI owner 负责。
 */
export interface DayReplanConstraintsOptions {
  constraints: ConstraintsV1
  scope: PlanScopeV1
  record: WorkspaceRecordV1
  binding: ConstraintsBindingV1
  epoch: number
}

/** builder 输入：trip_plan 不需要 request / record / binding；day 系必须全部给出。 */
export interface BuildPlanningConstraintsInput {
  constraints: ConstraintsV1
  scope: PlanScopeV1
  /** day / day_tail 必填；只读取 day / parent / stops，不读取 instruction。 */
  request?: Pick<DayReplanRequest, 'day' | 'parent' | 'stops'> | null
  record?: WorkspaceRecordV1 | null
  binding?: ConstraintsBindingV1 | null
  epoch?: number | null
}

export const TRIP_PLAN_CONSTRAINTS_SCOPE: Readonly<PlanScopeV1> = Object.freeze({
  scope: 'trip_plan',
  day: null,
  anchorStopId: null,
})

/** typed failure：调用方应按 reason 展示，并保证没有发起 fetch。 */
export class PlanningConstraintsError extends Error {
  readonly reason: PlanningConstraintsBuildFailureReason
  readonly workspaceReason?: WorkspaceValidationFailure['reason']
  readonly path?: string

  constructor(failure: PlanningConstraintsBuildFailure) {
    super(failure.message)
    this.name = 'PlanningConstraintsError'
    this.reason = failure.reason
    this.workspaceReason = failure.workspaceReason
    this.path = failure.path
  }
}

function fail(
  reason: PlanningConstraintsBuildFailureReason,
  message: string,
  extra?: { workspaceReason?: WorkspaceValidationFailure['reason']; path?: string },
): PlanningConstraintsBuildFailure {
  return { ok: false, reason, message, ...extra }
}

function failFromValidation(
  reason: PlanningConstraintsBuildFailureReason,
  validation: WorkspaceValidationFailure,
): PlanningConstraintsBuildFailure {
  return fail(reason, validation.message, {
    workspaceReason: validation.reason,
    path: validation.path,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function toWireItem(item: ConstraintItemV1): PlanningConstraintWireItemV1 {
  // 只输出后端声明过的字段；notes / updatedAt 是本地字段，不发送。
  // 所有可空字段显式写 null，不省略，保持 null 与 0 的差异。
  return {
    id: item.id,
    kind: item.kind,
    day: item.day,
    stop_id: item.stopId,
    title: item.title,
    start_date: item.startDate,
    end_date: item.endDate,
    start_time: item.startTime,
    end_time: item.endTime,
    duration_minutes: item.durationMinutes,
    priority: item.priority,
  }
}

function requestStopIds(request: Pick<DayReplanRequest, 'stops'>): Set<string> | null {
  if (!Array.isArray(request.stops)) return null
  const ids = new Set<string>()
  for (const stop of request.stops) {
    if (!isRecord(stop) || typeof stop.id !== 'string' || stop.id.length === 0) return null
    ids.add(stop.id)
  }
  return ids
}

function checkDayRequestContext(
  input: BuildPlanningConstraintsInput,
  scope: PlanScopeV1,
  validatedConstraints: ConstraintsV1,
): PlanningConstraintsBuildFailure | null {
  const record = input.record
  const binding = input.binding
  const request = input.request
  if (!record || !binding || !request || input.epoch === undefined || input.epoch === null) {
    return fail('missing_context', 'day / day_tail 约束必须提供当前 record、binding、epoch 与请求。')
  }
  if (!isSafeCount(input.epoch)) {
    return fail('invalid_binding', '约束绑定的 epoch 必须是非负安全整数。')
  }
  if (!isRecord(request) || !isRecord(request.parent) || !Array.isArray(request.stops)) {
    return fail('request_mismatch', 'day / day_tail 请求缺少 day / parent / stops，未发起请求。')
  }
  if (hasOwn(request, 'constraints')) {
    return fail('reserved_field', '请求对象已自带 constraints 字段；拒绝覆盖或重复发送。')
  }
  if (
    typeof request.day !== 'number' ||
    !Number.isSafeInteger(request.day) ||
    request.day < 1 ||
    request.day > MAX_BACKEND_PLAN_DAYS
  ) {
    return fail('request_mismatch', 'day / day_tail 请求的目标日必须是 1-7 的整数。')
  }
  if (request.day !== scope.day) {
    return fail('request_mismatch', '约束 scope.day 必须等于请求的目标日。')
  }
  if (
    typeof request.parent.trip_id !== 'string' ||
    request.parent.trip_id !== record.tripId
  ) {
    return fail('request_mismatch', '请求 parent.trip_id 必须等于当前工作区的 tripId。')
  }
  if (!isSafeCount(request.parent.revision) || request.parent.revision !== record.workspaceRevision) {
    return fail('request_mismatch', '请求 parent.revision 必须等于当前工作区的 workspaceRevision。')
  }

  // binding 必须就是本次 scope / 当前 record / 当前 constraints / 当前 epoch 的绑定。
  if (!isRecord(binding) || !isRecord(binding.planScope)) {
    return fail('invalid_binding', '约束绑定结构无效；未发起请求。')
  }
  if (
    binding.planScope.scope !== scope.scope ||
    binding.planScope.day !== scope.day ||
    binding.planScope.anchorStopId !== scope.anchorStopId
  ) {
    return fail('binding_mismatch', '约束绑定的 planScope 与本次请求 scope 不一致；未发起请求。')
  }
  if (!constraintsBindingMatches(binding, record, validatedConstraints, input.epoch)) {
    return fail('binding_mismatch', '约束已变化或绑定与当前工作区 / revision / epoch 不一致；请重新生成。')
  }

  const stopIds = requestStopIds(request)
  if (!stopIds) {
    return fail('request_mismatch', '请求 stops 结构无效，无法核对约束的 stop_id。')
  }
  if (scope.scope === 'day_tail') {
    if (scope.anchorStopId === null || !stopIds.has(scope.anchorStopId)) {
      return fail('stop_not_in_request', 'day_tail 锚点必须存在于本次请求的 stops 中。')
    }
  }
  for (let index = 0; index < validatedConstraints.items.length; index += 1) {
    const stopId = validatedConstraints.items[index].stopId
    if (stopId !== null && !stopIds.has(stopId)) {
      return fail(
        'stop_not_in_request',
        `约束 items[${index}].stop_id 不存在于本次请求 stops；后端会 422，客户端不发送。`,
        { path: `$.items[${index}].stopId` },
      )
    }
  }
  return null
}

/**
 * 构造严格 wire constraints。纯函数：不读存储 / 网络 / 时钟，不修改任何入参。
 * 失败时调用方必须终止请求，不允许回退为不带 constraints 的旧请求。
 */
export function buildPlanningConstraintsWire(
  input: BuildPlanningConstraintsInput,
): PlanningConstraintsBuildResult {
  if (!isRecord(input)) {
    return fail('invalid_input', '约束构建参数必须是对象。')
  }
  if (!isRecord(input.scope)) {
    return fail('invalid_scope', '缺少显式规划 scope；不接受从 instruction 前缀推断。')
  }

  const scopeCheck = validatePlanScope(input.scope)
  if (!scopeCheck.ok) {
    return failFromValidation('invalid_scope', scopeCheck)
  }
  const scope = scopeCheck.value
  if (scope.scope !== 'trip_plan') {
    if (scope.day === null || scope.day < 1 || scope.day > MAX_BACKEND_PLAN_DAYS) {
      return fail('invalid_scope', 'day / day_tail 的目标日必须在后端支持的 1-7 内。')
    }
  }

  const constraintsCheck = validateConstraints(input.constraints)
  if (!constraintsCheck.ok) {
    if (constraintsCheck.reason === 'limit_exceeded') {
      return failFromValidation('too_many', constraintsCheck)
    }
    return failFromValidation('invalid_constraints', constraintsCheck)
  }
  const validated = constraintsCheck.value

  if (scope.scope === 'trip_plan') {
    // 初始规划没有 request.stops；任何非 null stop_id 都是伪造。
    for (let index = 0; index < validated.items.length; index += 1) {
      const item = validated.items[index]
      if (item.stopId !== null) {
        return fail(
          'invalid_constraints',
          'trip_plan 作用域没有 request.stops；must_visit / 绑定约束的 stop_id 必须为 null。',
          { path: `$.items[${index}].stopId` },
        )
      }
      if (item.day !== null && (item.day < 1 || item.day > MAX_BACKEND_PLAN_DAYS)) {
        return fail(
          'invalid_constraints',
          `约束 items[${index}].day 必须在后端支持的 1-7 内。`,
          { path: `$.items[${index}].day` },
        )
      }
    }
  } else {
    const record = input.record
    if (!record) {
      return fail('missing_context', 'day / day_tail 约束必须提供当前 workspace record。')
    }
    if (!isRecord(record) || !isRecord(record.trip) || !Array.isArray(record.trip.days)) {
      return fail('invalid_record', '当前 workspace record 结构无效，无法核对约束 scope。')
    }
    const recordScopeCheck = validatePlanScope(scope, record)
    if (!recordScopeCheck.ok) {
      return failFromValidation('invalid_scope', recordScopeCheck)
    }
    const scopedCheck = validateConstraintsForScope(validated, scope, record)
    if (!scopedCheck.ok) {
      return failFromValidation('invalid_constraints', scopedCheck)
    }
    for (let index = 0; index < validated.items.length; index += 1) {
      const stopId = validated.items[index].stopId
      if (stopId !== null && stopId.length > MAX_BACKEND_STOP_ID_LENGTH) {
        return fail(
          'invalid_constraints',
          `约束 items[${index}].stop_id 超过 ${MAX_BACKEND_STOP_ID_LENGTH} 字；现有 DayReplanStop.id 无法承载，不截断、不发送。`,
          { path: `$.items[${index}].stopId` },
        )
      }
    }
    const requestFailure = checkDayRequestContext(input, scope, validated)
    if (requestFailure) return requestFailure
  }

  const fingerprint = constraintsFingerprint(validated)
  if (!fingerprint) {
    return fail('unserializable', '约束无法生成 canonical 指纹；未发起请求。')
  }

  const wire: PlanningConstraintsWireV1 = {
    version: 1,
    scope: scope.scope,
    day: scope.day,
    anchor_stop_id: scope.anchorStopId,
    fingerprint: fingerprint.short,
    items: validated.items.map(toWireItem),
  }

  let serialized: string
  try {
    serialized = JSON.stringify(wire)
  } catch {
    return fail('unserializable', '约束无法序列化为 JSON；未发起请求。')
  }
  const byteLength = utf8ByteLength(serialized)
  if (wire.items.length > MAX_CONSTRAINT_ITEMS) {
    return fail('too_many', `约束最多 ${MAX_CONSTRAINT_ITEMS} 条（当前 ${wire.items.length} 条）；不截断、不丢条目。`)
  }
  if (byteLength > MAX_CONSTRAINTS_BYTES) {
    return fail(
      'too_large',
      `约束 wire JSON 最多 ${MAX_CONSTRAINTS_BYTES} 字节（当前 ${byteLength} 字节）；不发送，不截断。`,
    )
  }

  return {
    ok: true,
    constraints: wire,
    itemCount: wire.items.length,
    byteLength,
  }
}

/** 初始规划用：scope 固定 trip_plan；失败抛 typed error，fetch 必须为 0。 */
export function buildTripPlanConstraintsWire(constraints: ConstraintsV1): PlanningConstraintsBuildResult {
  return buildPlanningConstraintsWire({
    constraints,
    scope: TRIP_PLAN_CONSTRAINTS_SCOPE,
  })
}

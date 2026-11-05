/**
 * F4 · 行程版本与方案对比（纯模块）
 *
 * 边界：
 * - 快照 = 不可变 Trip v1 + sidecar + 手工预算快照 + 元数据；不扩展 Trip v1。
 * - 只做纯 snapshot / diff / adopt / undo / backup 预览；不读写 localStorage、
 *   不读时钟、不发网络请求、不直接修改当前工作区记录。
 * - 采用 / 撤销 proposal 携带完整目标内容、base 完整 canonical、revision 与 epoch；
 *   父级用 `commitWorkspaceTransition` 做一次内存 transition，再由统一存储 owner
 *   显式写入。proposal 只负责让旧 pending（AI / 路线 / 预算 / 备份）在
 *   revision + epoch 推进后全部失效，绝不回放快照里的旧 revision。
 * - 版本库的三个容量常量来自 `workspaceTypes.ts` / `workspace.ts`，本模块不复制数字。
 * - 预算费用用 `tripBudget.ts` 的十进制字符串精确算法；null = 未知，0 = 合法已知值，
 *   未知项不补 0、不伪造总价。
 * - 版本库备份 / 导入只处理版本库自身；不跨工作区 / 候选库做原子恢复。
 */
import type { Trip, TripDay, TripStop } from './api'
import { utf8ByteLength } from './savedTrips'
import { computeBudgetSummary, formatCents } from './tripBudget'
import {
  checkVersionSnapshotLimits,
  checkVersionsRecordLimits,
  commitWorkspaceTransition,
  createVersionsRecord,
  measureVersionSnapshotBytes,
  measureVersionsRecordBytes,
  nextWorkspaceRevision,
  validateVersionSnapshot,
  validateVersionsBackup,
  validateVersionsRecord,
  validateWorkspaceRecord,
  workspaceIdentityOf,
} from './workspace'
import {
  BACKUP_VERSION,
  MAX_SAFE_WORKSPACE_REVISION,
  MAX_VERSION_NAME_LENGTH,
  MAX_VERSIONS_BACKUP_FILE_BYTES,
  MAX_VERSIONS_COUNT,
  MAX_VERSIONS_TOTAL_BYTES,
  MAX_VERSION_SNAPSHOT_BYTES,
  VERSIONS_BACKUP_FORMAT,
  VERSIONS_FORMAT,
  VERSIONS_STORAGE_KEY,
  VERSIONS_VERSION,
  type BudgetSnapshotV1,
  type ConstraintItemV1,
  type VersionSnapshotV1,
  type VersionsBackupV1,
  type VersionsRecordV1,
  type WorkspaceFingerprintV1,
  type WorkspaceIdentityV1,
  type WorkspaceRecordV1,
  type WorkspaceSidecarV1,
  type WorkspaceValidationReason,
  type WorkspaceValidationResult,
} from './workspaceTypes'
import {
  canonicalJson,
  canonicalValuesEqual,
  fingerprintOf,
} from './workspaceFingerprint'

export {
  MAX_VERSION_NAME_LENGTH,
  MAX_VERSION_SNAPSHOT_BYTES,
  MAX_VERSIONS_BACKUP_FILE_BYTES,
  MAX_VERSIONS_COUNT,
  MAX_VERSIONS_TOTAL_BYTES,
  VERSIONS_FORMAT,
  VERSIONS_STORAGE_KEY,
  VERSIONS_VERSION,
}
export {
  checkVersionSnapshotLimits,
  checkVersionsRecordLimits,
  measureVersionSnapshotBytes,
  measureVersionsRecordBytes,
  validateVersionSnapshot,
  validateVersionsBackup,
  validateVersionsRecord,
}

/** 三个容量常量的只读聚合，方便 UI 显示与集成统一引用；数值仍来自 workspace 契约。 */
export const VERSION_LIMITS = Object.freeze({
  maxCount: MAX_VERSIONS_COUNT,
  maxTotalBytes: MAX_VERSIONS_TOTAL_BYTES,
  maxSnapshotBytes: MAX_VERSION_SNAPSHOT_BYTES,
  maxBackupBytes: MAX_VERSIONS_BACKUP_FILE_BYTES,
})

export type VersionsLibraryStatusV1 =
  | 'ok'
  | 'empty'
  | 'unavailable'
  | 'corrupt'
  | 'anomaly'
  | 'unknown_version'

/** 面板交给父级的保存请求；父级负责生成 id / 时间并显式落库。 */
export interface VersionSaveRequestV1 {
  readonly name: string
}

export interface CreateVersionSnapshotInputV1 {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  /** 保存时当前工作区的 revision；只记录，不用于恢复。 */
  readonly workspaceRevision: number
  readonly trip: Trip
  readonly sidecar: WorkspaceSidecarV1
  readonly budget: BudgetSnapshotV1 | null
}

function fail<T>(
  reason: WorkspaceValidationReason,
  path: string,
  message: string,
): WorkspaceValidationResult<T> {
  return { ok: false, reason, path, message }
}

function pathWithSuffix(path: string, canonicalPath: string): string {
  if (canonicalPath === '$') return path
  return `${path}${canonicalPath.slice(1)}`
}

/**
 * 用 canonical JSON 做 JSON 纯度检查并深拷贝：拒绝循环引用、undefined、函数、
 * BigInt、非有限数与非普通对象。数组顺序原样保留。
 */
function cloneJsonValue<T>(value: unknown, path: string): WorkspaceValidationResult<T> {
  const canonical = canonicalJson(value)
  if (!canonical.ok) {
    return fail(
      'unserializable',
      pathWithSuffix(path, canonical.path),
      `版本数据无法序列化：${canonical.message}`,
    )
  }
  try {
    return { ok: true, value: JSON.parse(canonical.text) as T }
  } catch {
    return fail('unserializable', path, '版本数据无法克隆；原始数据未被修改。')
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

function normalizeSnapshot(value: unknown, path = '$'): WorkspaceValidationResult<VersionSnapshotV1> {
  const cloned = cloneJsonValue<VersionSnapshotV1>(value, path)
  if (!cloned.ok) return cloned
  return validateVersionSnapshot(cloned.value)
}

/**
 * 创建不可变版本快照：深拷贝所有输入并冻结结果；后续编辑当前 Trip / sidecar /
 * budget 不会串改快照。名字重复是允许的，id 独立即可。
 */
export function createVersionSnapshot(
  input: CreateVersionSnapshotInputV1,
): WorkspaceValidationResult<VersionSnapshotV1> {
  const draft: VersionSnapshotV1 = {
    id: input.id,
    name: input.name,
    createdAt: input.createdAt,
    workspaceRevision: input.workspaceRevision,
    trip: input.trip,
    sidecar: input.sidecar,
    budget: input.budget,
  }
  const normalized = normalizeSnapshot(draft)
  if (!normalized.ok) return normalized
  return { ok: true, value: deepFreeze(normalized.value) }
}

/**
 * 把快照加入版本库。输入记录与快照都不会被修改；返回新记录。
 * 超过 10 个 / 4 MiB / 单快照 2 MiB 时明确失败，不驱逐旧版本。
 */
export function addVersionSnapshot(
  record: VersionsRecordV1 | null,
  snapshot: VersionSnapshotV1,
  updatedAt: number,
): WorkspaceValidationResult<VersionsRecordV1> {
  const normalized = normalizeSnapshot(snapshot)
  if (!normalized.ok) return normalized

  let baseItems: VersionSnapshotV1[] = []
  if (record !== null) {
    const cloned = cloneJsonValue<VersionsRecordV1>(record, '$.versions')
    if (!cloned.ok) return cloned
    const validated = validateVersionsRecord(cloned.value)
    if (!validated.ok) return validated
    baseItems = validated.value.items
  }

  if (baseItems.length >= MAX_VERSIONS_COUNT) {
    return fail(
      'limit_exceeded',
      '$.items',
      `版本库最多 ${MAX_VERSIONS_COUNT} 个版本（当前 ${baseItems.length} 个）；未写入，未驱逐旧版本。`,
    )
  }
  if (baseItems.some((item) => item.id === normalized.value.id)) {
    return fail('duplicate_id', '$.items.id', '版本 id 重复；拒绝整份记录。')
  }

  const created = createVersionsRecord([...baseItems, normalized.value], updatedAt)
  if (!created.ok) return created
  return { ok: true, value: deepFreeze(created.value) }
}

/* ───────── 预算 / 时间 / 距离的已知与未知 ───────── */

export interface VersionCostSummaryV1 {
  readonly state: 'missing' | 'present'
  /** 已知费用合计（分）；没有任何已知金额时为 null，不是 0。 */
  readonly knownTotalCents: number | null
  readonly knownTotalText: string | null
  readonly knownCount: number
  /** 未填 / 非法金额的项数；这些项不进入合计。 */
  readonly unknownCount: number
  readonly emptyCount: number
  readonly issueCount: number
  /** 全部项都已知且预算存在。空预算也可能 complete，但 total 仍为 null。 */
  readonly complete: boolean
  /** 只有全部项已知且有已知金额时才是总价；否则 null，不伪造总价。 */
  readonly totalCents: number | null
  readonly totalText: string | null
}

export function summarizeBudgetSnapshot(
  budget: BudgetSnapshotV1 | null,
): WorkspaceValidationResult<VersionCostSummaryV1> {
  if (budget === null) {
    return {
      ok: true,
      value: {
        state: 'missing',
        knownTotalCents: null,
        knownTotalText: null,
        knownCount: 0,
        unknownCount: 0,
        emptyCount: 0,
        issueCount: 0,
        complete: false,
        totalCents: null,
        totalText: null,
      },
    }
  }

  const computed = computeBudgetSummary({ rows: budget.rows, budgetRaw: budget.budgetRaw })
  if (!computed.ok) {
    return fail('invalid_field', '$.budget', computed.message)
  }
  const summary = computed.summary
  const unknownCount = summary.emptyCount + summary.issueCount
  const complete = unknownCount === 0
  const totalCents = complete ? summary.knownTotalCents : null
  return {
    ok: true,
    value: {
      state: 'present',
      knownTotalCents: summary.knownTotalCents,
      knownTotalText: summary.knownTotalText,
      knownCount: summary.knownCount,
      unknownCount,
      emptyCount: summary.emptyCount,
      issueCount: summary.issueCount,
      complete,
      totalCents,
      totalText: totalCents === null ? null : formatCents(totalCents),
    },
  }
}

export function summarizeVersionBudget(
  snapshot: VersionSnapshotV1,
): WorkspaceValidationResult<VersionCostSummaryV1> {
  const validated = validateVersionSnapshot(snapshot)
  if (!validated.ok) return validated
  return summarizeBudgetSnapshot(validated.value.budget)
}

export interface VersionMeasureSummaryV1 {
  /** 已知项合计；没有已知项时为 null，不是 0。 */
  readonly knownTotal: number | null
  readonly knownCount: number
  readonly unknownCount: number
  readonly complete: boolean
  /** 全部项已知且有已知项时才是总时长 / 总距离；否则 null。 */
  readonly total: number | null
}

export interface VersionMeasureDiffV1 {
  readonly before: VersionMeasureSummaryV1
  readonly after: VersionMeasureSummaryV1
  /** 两边都有已知合计时才计算差值；否则 null。 */
  readonly knownDelta: number | null
  readonly unknownDelta: number
  readonly complete: boolean
  /** 两边都完整且有合计时才计算总差值；否则 null。 */
  readonly totalDelta: number | null
}

type MeasureKind = 'time' | 'distance'

function measureValues(trip: Trip, kind: MeasureKind): (number | null)[] {
  const values: (number | null)[] = []
  for (const day of trip.days) {
    for (const stop of day.stops) {
      if (kind === 'time') values.push(stop.duration_minutes)
    }
    for (const leg of day.legs) {
      values.push(kind === 'time' ? leg.duration_minutes : leg.distance_m)
    }
  }
  return values
}

function summarizeMeasures(
  values: readonly (number | null)[],
): WorkspaceValidationResult<VersionMeasureSummaryV1> {
  let knownTotal = 0
  let knownCount = 0
  let unknownCount = 0
  for (const value of values) {
    if (value === null) {
      unknownCount += 1
      continue
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return fail('invalid_field', '$.trip', '版本里的时间 / 距离不是非负安全整数；拒绝比较。')
    }
    knownTotal += value
    if (!Number.isSafeInteger(knownTotal)) {
      return fail('limit_exceeded', '$.trip', '版本里的时间 / 距离合计超出安全整数范围；拒绝比较。')
    }
    knownCount += 1
  }
  const complete = unknownCount === 0
  const knownTotalOrNull = knownCount === 0 ? null : knownTotal
  return {
    ok: true,
    value: {
      knownTotal: knownTotalOrNull,
      knownCount,
      unknownCount,
      complete,
      total: complete ? knownTotalOrNull : null,
    },
  }
}

function measureDiff(
  before: Trip,
  after: Trip,
  kind: MeasureKind,
): WorkspaceValidationResult<VersionMeasureDiffV1> {
  const beforeSummary = summarizeMeasures(measureValues(before, kind))
  if (!beforeSummary.ok) return beforeSummary
  const afterSummary = summarizeMeasures(measureValues(after, kind))
  if (!afterSummary.ok) return afterSummary

  const a = beforeSummary.value
  const b = afterSummary.value
  const knownDelta = a.knownTotal === null || b.knownTotal === null ? null : b.knownTotal - a.knownTotal
  const totalDelta = a.total === null || b.total === null ? null : b.total - a.total
  return {
    ok: true,
    value: {
      before: a,
      after: b,
      knownDelta,
      unknownDelta: b.unknownCount - a.unknownCount,
      complete: a.complete && b.complete,
      totalDelta,
    },
  }
}

/* ───────── 版本对比 ───────── */

export interface VersionStopRefV1 {
  readonly id: string
  readonly name: string
  readonly day: number
  readonly dayTitle: string
  readonly time: string
  readonly durationMinutes: number | null
}

export interface VersionStopMoveV1 {
  readonly id: string
  readonly name: string
  readonly from: VersionStopRefV1
  readonly to: VersionStopRefV1
}

export interface VersionStopChangeV1 {
  readonly id: string
  readonly name: string
  readonly day: number
  readonly before: VersionStopRefV1
  readonly after: VersionStopRefV1
}

export interface VersionStopsDiffV1 {
  readonly added: VersionStopRefV1[]
  readonly removed: VersionStopRefV1[]
  readonly moved: VersionStopMoveV1[]
  readonly changed: VersionStopChangeV1[]
  readonly unchangedCount: number
}

export interface VersionConstraintChangeV1 {
  readonly id: string
  readonly title: string
  readonly before: ConstraintItemV1
  readonly after: ConstraintItemV1
}

export interface VersionConstraintsDiffV1 {
  readonly added: ConstraintItemV1[]
  readonly removed: ConstraintItemV1[]
  readonly changed: VersionConstraintChangeV1[]
  readonly unchangedCount: number
}

export interface VersionCostDiffV1 {
  readonly before: VersionCostSummaryV1
  readonly after: VersionCostSummaryV1
  /** 两边都有已知合计时才计算；否则 null。 */
  readonly knownDeltaCents: number | null
  readonly knownDeltaText: string | null
  readonly unknownDelta: number
  readonly complete: boolean
  /** 两边都完整且都有总价时才计算；否则 null，不伪造总价变化。 */
  readonly totalDeltaCents: number | null
  readonly totalDeltaText: string | null
}

export interface VersionDiffV1 {
  readonly before: {
    readonly id: string
    readonly name: string
    readonly createdAt: number
    readonly workspaceRevision: number
  }
  readonly after: {
    readonly id: string
    readonly name: string
    readonly createdAt: number
    readonly workspaceRevision: number
  }
  readonly stops: VersionStopsDiffV1
  readonly constraints: VersionConstraintsDiffV1
  readonly time: VersionMeasureDiffV1
  readonly distance: VersionMeasureDiffV1
  readonly cost: VersionCostDiffV1
}

interface StopOccurrence {
  readonly ref: VersionStopRefV1
  readonly stop: TripStop
}

function stopRefOf(day: TripDay, stop: TripStop): VersionStopRefV1 {
  return {
    id: stop.id,
    name: stop.name,
    day: day.day,
    dayTitle: day.title,
    time: stop.time,
    durationMinutes: stop.duration_minutes,
  }
}

function collectStops(trip: Trip): Map<string, StopOccurrence[]> {
  const map = new Map<string, StopOccurrence[]>()
  for (const day of trip.days) {
    for (const stop of day.stops) {
      const list = map.get(stop.id) ?? []
      list.push({ ref: stopRefOf(day, stop), stop })
      map.set(stop.id, list)
    }
  }
  return map
}

function diffStops(before: Trip, after: Trip): VersionStopsDiffV1 {
  const beforeMap = collectStops(before)
  const afterMap = collectStops(after)
  const added: VersionStopRefV1[] = []
  const removed: VersionStopRefV1[] = []
  const moved: VersionStopMoveV1[] = []
  const changed: VersionStopChangeV1[] = []
  let unchangedCount = 0

  const orderedIds = [...beforeMap.keys()]
  for (const id of afterMap.keys()) {
    if (!beforeMap.has(id)) orderedIds.push(id)
  }

  for (const id of orderedIds) {
    const aList = beforeMap.get(id) ?? []
    const bList = afterMap.get(id) ?? []
    const pairCount = Math.max(aList.length, bList.length)
    for (let index = 0; index < pairCount; index += 1) {
      const a = aList[index]
      const b = bList[index]
      if (a === undefined && b !== undefined) {
        added.push(b.ref)
      } else if (a !== undefined && b === undefined) {
        removed.push(a.ref)
      } else if (a !== undefined && b !== undefined) {
        if (a.ref.day !== b.ref.day) {
          moved.push({ id, name: b.ref.name, from: a.ref, to: b.ref })
        } else if (!canonicalValuesEqual(a.stop, b.stop)) {
          changed.push({ id, name: b.ref.name, day: b.ref.day, before: a.ref, after: b.ref })
        } else {
          unchangedCount += 1
        }
      }
    }
  }

  return { added, removed, moved, changed, unchangedCount }
}

function diffConstraints(
  before: readonly ConstraintItemV1[],
  after: readonly ConstraintItemV1[],
): VersionConstraintsDiffV1 {
  const beforeMap = new Map(before.map((item) => [item.id, item]))
  const afterMap = new Map(after.map((item) => [item.id, item]))
  const added: ConstraintItemV1[] = []
  const removed: ConstraintItemV1[] = []
  const changed: VersionConstraintChangeV1[] = []
  let unchangedCount = 0

  for (const item of before) {
    const next = afterMap.get(item.id)
    if (next === undefined) {
      removed.push(item)
    } else if (!canonicalValuesEqual(item, next)) {
      changed.push({ id: item.id, title: next.title, before: item, after: next })
    } else {
      unchangedCount += 1
    }
  }
  for (const item of after) {
    if (!beforeMap.has(item.id)) added.push(item)
  }
  return { added, removed, changed, unchangedCount }
}

function formatSignedCents(cents: number | null): string | null {
  if (cents === null) return null
  if (!Number.isSafeInteger(cents)) return null
  if (cents < 0) return `-${formatCents(-cents)}`
  return `+${formatCents(cents)}`
}

function diffCost(
  before: VersionCostSummaryV1,
  after: VersionCostSummaryV1,
): VersionCostDiffV1 {
  const knownDeltaCents =
    before.knownTotalCents === null || after.knownTotalCents === null
      ? null
      : after.knownTotalCents - before.knownTotalCents
  const complete =
    before.state === 'present' &&
    after.state === 'present' &&
    before.complete &&
    after.complete
  const totalDeltaCents =
    !complete || before.totalCents === null || after.totalCents === null
      ? null
      : after.totalCents - before.totalCents
  return {
    before,
    after,
    knownDeltaCents,
    knownDeltaText: formatSignedCents(knownDeltaCents),
    unknownDelta: after.unknownCount - before.unknownCount,
    complete,
    totalDeltaCents,
    totalDeltaText: formatSignedCents(totalDeltaCents),
  }
}

/**
 * 对比两个版本：站点按 id 识别新增 / 删除 / 跨日移动 / 同日内容变化；
 * 预约按 constraint id 对比；时间 / 距离 / 费用分别给出已知与未知，
 * 0 是合法已知值，未知不补 0，不完整的费用不给总价。
 */
export function diffVersions(
  beforeValue: VersionSnapshotV1,
  afterValue: VersionSnapshotV1,
): WorkspaceValidationResult<VersionDiffV1> {
  const before = normalizeSnapshot(beforeValue, '$.before')
  if (!before.ok) return before
  const after = normalizeSnapshot(afterValue, '$.after')
  if (!after.ok) return after

  const time = measureDiff(before.value.trip, after.value.trip, 'time')
  if (!time.ok) return time
  const distance = measureDiff(before.value.trip, after.value.trip, 'distance')
  if (!distance.ok) return distance
  const costBefore = summarizeBudgetSnapshot(before.value.budget)
  if (!costBefore.ok) return costBefore
  const costAfter = summarizeBudgetSnapshot(after.value.budget)
  if (!costAfter.ok) return costAfter

  return {
    ok: true,
    value: {
      before: {
        id: before.value.id,
        name: before.value.name,
        createdAt: before.value.createdAt,
        workspaceRevision: before.value.workspaceRevision,
      },
      after: {
        id: after.value.id,
        name: after.value.name,
        createdAt: after.value.createdAt,
        workspaceRevision: after.value.workspaceRevision,
      },
      stops: diffStops(before.value.trip, after.value.trip),
      constraints: diffConstraints(
        before.value.sidecar.constraints.items,
        after.value.sidecar.constraints.items,
      ),
      time: time.value,
      distance: distance.value,
      cost: diffCost(costBefore.value, costAfter.value),
    },
  }
}

/* ───────── 采用 / 撤销 proposal ───────── */

export interface VersionTransitionContextV1 {
  /** 组件级单调 epoch；采用 / 撤销后父级必须推进到 proposal.nextEpoch。 */
  readonly epoch: number
}

export interface VersionContentV1 {
  readonly trip: Trip
  readonly sidecar: WorkspaceSidecarV1
  readonly budget: BudgetSnapshotV1 | null
}

export interface VersionProposalBaseV1 {
  readonly identity: WorkspaceIdentityV1
  readonly epoch: number
  /** 提案创建时当前工作区记录的完整 canonical JSON；用于全文过期判断。 */
  readonly snapshot: WorkspaceFingerprintV1
}

export interface VersionProposalTargetV1 {
  readonly content: VersionContentV1
  /** 目标内容的完整 canonical JSON；防止 proposal 被外部改写后再应用。 */
  readonly snapshot: WorkspaceFingerprintV1
}

export type VersionReconfirmationKindV1 =
  | 'constraint'
  | 'checklist'
  | 'apply'
  | 'accommodation'
  | 'transport'
  | 'anchor'

/** 当前工作区有、但目标版本没有的条目；采用前明确列出，不静默套用。 */
export interface VersionReconfirmationItemV1 {
  readonly kind: VersionReconfirmationKindV1
  readonly id: string
  readonly label: string
}

export interface VersionAdoptProposalV1 {
  readonly kind: 'adopt_version'
  readonly versionId: string
  readonly versionName: string
  /** 快照里记录的旧 revision；只用于显示，绝不用于恢复。 */
  readonly versionRevision: number
  readonly base: VersionProposalBaseV1
  readonly target: VersionProposalTargetV1
  /** 当前 revision + 1；应用时还会按当前记录重新核对。 */
  readonly nextWorkspaceRevision: number
  readonly nextEpoch: number
  readonly needsReconfirmation: VersionReconfirmationItemV1[]
}

export interface VersionUndoProposalV1 {
  readonly kind: 'undo_version_adopt'
  readonly versionId: string
  readonly base: VersionProposalBaseV1
  /** 采用前的完整内容；撤销只恢复这段内容，revision / epoch 仍向前推进。 */
  readonly target: VersionProposalTargetV1
  readonly nextWorkspaceRevision: number
  readonly nextEpoch: number
}

export interface VersionTransitionInvalidationV1 {
  readonly workspaceRevision: number
  readonly epoch: number
  readonly reason: 'version_adopted' | 'version_undo'
}

export interface VersionAdoptResultV1 {
  readonly record: WorkspaceRecordV1
  readonly undo: VersionUndoProposalV1
  readonly invalidation: VersionTransitionInvalidationV1
}

export interface VersionUndoResultV1 {
  readonly record: WorkspaceRecordV1
  readonly invalidation: VersionTransitionInvalidationV1
}

function checkEpoch(value: number, path: string): WorkspaceValidationResult<number> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return fail('invalid_field', path, 'epoch 必须是非负安全整数。')
  }
  if (value >= MAX_SAFE_WORKSPACE_REVISION) {
    return fail('limit_exceeded', path, 'epoch 已达到 JSON 安全整数上限，不能继续递增。')
  }
  return { ok: true, value }
}

function nextEpochValue(value: number): WorkspaceValidationResult<number> {
  const checked = checkEpoch(value, '$.epoch')
  if (!checked.ok) return checked
  return { ok: true, value: checked.value + 1 }
}

function fingerprintOrFail(
  value: unknown,
  path: string,
): WorkspaceValidationResult<WorkspaceFingerprintV1> {
  const fingerprint = fingerprintOf(value)
  if (!fingerprint.ok) {
    return fail('unserializable', pathWithSuffix(path, fingerprint.path), fingerprint.message)
  }
  return { ok: true, value: fingerprint.fingerprint }
}

function contentOfVersion(version: VersionSnapshotV1): VersionContentV1 {
  return { trip: version.trip, sidecar: version.sidecar, budget: version.budget }
}

function proposalBaseOf(
  record: WorkspaceRecordV1,
  epoch: number,
): WorkspaceValidationResult<VersionProposalBaseV1> {
  const snapshot = fingerprintOrFail(record, '$.base')
  if (!snapshot.ok) return snapshot
  return {
    ok: true,
    value: {
      identity: workspaceIdentityOf(record),
      epoch,
      snapshot: snapshot.value,
    },
  }
}

function proposalTargetOf(
  content: VersionContentV1,
): WorkspaceValidationResult<VersionProposalTargetV1> {
  const snapshot = fingerprintOrFail(content, '$.target')
  if (!snapshot.ok) return snapshot
  return { ok: true, value: { content, snapshot: snapshot.value } }
}

function identityMatches(identity: WorkspaceIdentityV1, record: WorkspaceRecordV1): boolean {
  return (
    identity.ownerId === record.ownerId &&
    identity.workspaceId === record.workspaceId &&
    identity.tripId === record.tripId &&
    identity.workspaceRevision === record.workspaceRevision
  )
}

function anchorReconfirmation(
  current: WorkspaceSidecarV1,
  snapshot: WorkspaceSidecarV1,
): VersionReconfirmationItemV1[] {
  const items: VersionReconfirmationItemV1[] = []
  const currentAccommodation = current.anchors.accommodation
  if (
    currentAccommodation !== null &&
    !canonicalValuesEqual(currentAccommodation, snapshot.anchors.accommodation)
  ) {
    items.push({
      kind: 'accommodation',
      id: 'accommodation',
      label: currentAccommodation.name ?? currentAccommodation.hotelId ?? '住宿锚点',
    })
  }
  if (
    current.anchors.arrival !== null &&
    !canonicalValuesEqual(current.anchors.arrival, snapshot.anchors.arrival)
  ) {
    items.push({ kind: 'transport', id: 'arrival', label: `抵达：${current.anchors.arrival.name}` })
  }
  if (
    current.anchors.departure !== null &&
    !canonicalValuesEqual(current.anchors.departure, snapshot.anchors.departure)
  ) {
    items.push({
      kind: 'transport',
      id: 'departure',
      label: `离开：${current.anchors.departure.name}`,
    })
  }
  for (const dayKey of Object.keys(current.anchors.daily)) {
    const currentDay = current.anchors.daily[dayKey]
    const snapshotDay = snapshot.anchors.daily[dayKey]
    for (const edge of ['start', 'end'] as const) {
      const currentAnchor = currentDay[edge]
      if (currentAnchor === null) continue
      const snapshotAnchor = snapshotDay?.[edge] ?? null
      if (!canonicalValuesEqual(currentAnchor, snapshotAnchor)) {
        items.push({
          kind: 'anchor',
          id: `day:${dayKey}:${edge}`,
          label: `第 ${dayKey} 天${edge === 'start' ? '起点' : '终点'}：${currentAnchor.name}`,
        })
      }
    }
  }
  return items
}

function buildReconfirmation(
  current: WorkspaceRecordV1,
  targetVersion: VersionSnapshotV1,
): VersionReconfirmationItemV1[] {
  const items: VersionReconfirmationItemV1[] = []
  const snapshotConstraintIds = new Set(
    targetVersion.sidecar.constraints.items.map((item) => item.id),
  )
  for (const constraint of current.sidecar.constraints.items) {
    if (!snapshotConstraintIds.has(constraint.id)) {
      items.push({
        kind: 'constraint',
        id: constraint.id,
        label: `约束：${constraint.title}`,
      })
    }
  }

  const snapshotChecklistIds = new Set(targetVersion.sidecar.checklist.items.map((item) => item.id))
  for (const item of current.sidecar.checklist.items) {
    if (!snapshotChecklistIds.has(item.id)) {
      items.push({ kind: 'checklist', id: item.id, label: `清单：${item.title}` })
    }
  }

  const applyKey = (link: { candidateId: string; tripId: string; day: number; stopId: string }): string =>
    `${link.candidateId}\u0000${link.tripId}\u0000${link.day}\u0000${link.stopId}`
  const snapshotApplyKeys = new Set(targetVersion.sidecar.applies.map(applyKey))
  for (const link of current.sidecar.applies) {
    if (!snapshotApplyKeys.has(applyKey(link))) {
      items.push({
        kind: 'apply',
        id: applyKey(link),
        label: `候选引用：第 ${link.day} 天 ${link.stopId}`,
      })
    }
  }

  items.push(...anchorReconfirmation(current.sidecar, targetVersion.sidecar))
  return items
}

/**
 * 生成采用提案：不改当前记录、不写存储。提案携带完整当前 canonical、身份、
 * revision、epoch 与目标 Trip + sidecar + budget；父级确认后才执行 transition。
 */
export function planVersionAdopt(
  current: WorkspaceRecordV1,
  version: VersionSnapshotV1,
  context: VersionTransitionContextV1,
): WorkspaceValidationResult<VersionAdoptProposalV1> {
  const currentValid = validateWorkspaceRecord(current)
  if (!currentValid.ok) return currentValid
  const epoch = checkEpoch(context.epoch, '$.context.epoch')
  if (!epoch.ok) return epoch
  const versionValid = normalizeSnapshot(version, '$.version')
  if (!versionValid.ok) return versionValid
  if (versionValid.value.trip.id !== currentValid.value.tripId) {
    return fail(
      'owner_mismatch',
      '$.version.trip.id',
      '该版本属于另一个行程，不能在当前工作区采用；未修改任何数据。',
    )
  }

  const nextRevision = nextWorkspaceRevision(currentValid.value.workspaceRevision)
  if (!nextRevision.ok) return nextRevision
  const nextEpoch = nextEpochValue(context.epoch)
  if (!nextEpoch.ok) return nextEpoch
  const base = proposalBaseOf(currentValid.value, context.epoch)
  if (!base.ok) return base
  const target = proposalTargetOf(contentOfVersion(versionValid.value))
  if (!target.ok) return target

  return {
    ok: true,
    value: deepFreeze({
      kind: 'adopt_version',
      versionId: versionValid.value.id,
      versionName: versionValid.value.name,
      versionRevision: versionValid.value.workspaceRevision,
      base: base.value,
      target: target.value,
      nextWorkspaceRevision: nextRevision.value,
      nextEpoch: nextEpoch.value,
      needsReconfirmation: buildReconfirmation(currentValid.value, versionValid.value),
    }),
  }
}

function staleProposal<T>(message: string): WorkspaceValidationResult<T> {
  return fail('owner_mismatch', '$.proposal.base', message)
}

function verifyBase(
  current: WorkspaceRecordV1,
  base: VersionProposalBaseV1,
  context: VersionTransitionContextV1,
): WorkspaceValidationResult<true> {
  const epoch = checkEpoch(context.epoch, '$.context.epoch')
  if (!epoch.ok) return epoch
  if (base.epoch !== context.epoch) {
    return staleProposal('版本提案的 epoch 已过期；请重新预览后再采用。')
  }
  if (!identityMatches(base.identity, current)) {
    return staleProposal('当前工作区身份或 revision 已变化；请重新预览后再采用。')
  }
  const currentFingerprint = fingerprintOrFail(current, '$.current')
  if (!currentFingerprint.ok) return currentFingerprint
  if (currentFingerprint.value.canonical !== base.snapshot.canonical) {
    return staleProposal('当前工作区内容已变化（另一处已更新）；请重新预览后再采用。')
  }
  return { ok: true, value: true }
}

function verifyTarget(
  target: VersionProposalTargetV1,
): WorkspaceValidationResult<VersionContentV1> {
  const canonical = canonicalJson(target.content)
  if (!canonical.ok) {
    return fail('unserializable', '$.proposal.target.content', canonical.message)
  }
  if (canonical.text !== target.snapshot.canonical) {
    return fail(
      'invalid_field',
      '$.proposal.target',
      '版本提案的目标内容已被修改；拒绝采用，原记录未改变。',
    )
  }
  const cloned = cloneJsonValue<VersionContentV1>(target.content, '$.proposal.target.content')
  if (!cloned.ok) return cloned
  return cloned
}

function invalidation(
  record: WorkspaceRecordV1,
  epoch: number,
  reason: 'version_adopted' | 'version_undo',
): VersionTransitionInvalidationV1 {
  return { workspaceRevision: record.workspaceRevision, epoch, reason }
}

/**
 * 应用采用提案：先全文核对 base 身份 / revision / epoch / canonical，再在内存里
 * 一次 transition 切换 Trip + sidecar + budget。当前 revision + 1，绝不恢复
 * 快照里的旧 revision；返回的 undo 提案同样只恢复内容、下一次再 +1。
 * 不写 storage；持久化由父级显式调用统一存储 owner 完成。
 */
export function applyVersionAdoptProposal(
  current: WorkspaceRecordV1,
  proposal: VersionAdoptProposalV1,
  context: VersionTransitionContextV1,
  now: number,
): WorkspaceValidationResult<VersionAdoptResultV1> {
  const currentValid = validateWorkspaceRecord(current)
  if (!currentValid.ok) return currentValid
  if (proposal.kind !== 'adopt_version') {
    return fail('invalid_field', '$.proposal.kind', '不是采用版本的提案；拒绝应用。')
  }
  const baseOk = verifyBase(currentValid.value, proposal.base, context)
  if (!baseOk.ok) return baseOk
  const nextRevision = nextWorkspaceRevision(currentValid.value.workspaceRevision)
  if (!nextRevision.ok) return nextRevision
  if (proposal.nextWorkspaceRevision !== nextRevision.value) {
    return fail(
      'invalid_field',
      '$.proposal.nextWorkspaceRevision',
      '提案里的下一 revision 与当前记录不一致；拒绝采用，未回放旧 revision。',
    )
  }
  const nextEpoch = nextEpochValue(context.epoch)
  if (!nextEpoch.ok) return nextEpoch
  if (proposal.nextEpoch !== nextEpoch.value) {
    return staleProposal('提案里的下一 epoch 与当前 epoch 不一致；请重新预览。')
  }

  const target = verifyTarget(proposal.target)
  if (!target.ok) return target
  const transition = commitWorkspaceTransition(
    currentValid.value,
    {
      trip: target.value.trip,
      sidecar: target.value.sidecar,
      budget: target.value.budget,
    },
    now,
  )
  if (!transition.ok) return transition
  if (transition.value.workspaceRevision !== proposal.nextWorkspaceRevision) {
    return fail(
      'invalid_field',
      '$.workspaceRevision',
      'transition 后的 revision 与提案不一致；拒绝采用，未写存储。',
    )
  }

  const undoBase = proposalBaseOf(transition.value, proposal.nextEpoch)
  if (!undoBase.ok) return undoBase
  const undoNextRevision = nextWorkspaceRevision(transition.value.workspaceRevision)
  if (!undoNextRevision.ok) return undoNextRevision
  const undoNextEpoch = nextEpochValue(proposal.nextEpoch)
  if (!undoNextEpoch.ok) return undoNextEpoch
  const undoContent = cloneJsonValue<VersionContentV1>(
    {
      trip: currentValid.value.trip,
      sidecar: currentValid.value.sidecar,
      budget: currentValid.value.budget,
    },
    '$.undo.target',
  )
  if (!undoContent.ok) return undoContent
  const undoTarget = proposalTargetOf(undoContent.value)
  if (!undoTarget.ok) return undoTarget

  const undo = deepFreeze<VersionUndoProposalV1>({
    kind: 'undo_version_adopt',
    versionId: proposal.versionId,
    base: undoBase.value,
    target: undoTarget.value,
    nextWorkspaceRevision: undoNextRevision.value,
    nextEpoch: undoNextEpoch.value,
  })

  return {
    ok: true,
    value: {
      record: transition.value,
      undo,
      invalidation: invalidation(transition.value, proposal.nextEpoch, 'version_adopted'),
    },
  }
}

/**
 * 应用一次整体撤销：恢复采用前的 Trip + sidecar + budget，revision / epoch 仍
 * 当前值 +1。提案过期、ABA 或已用过时明确拒绝，保持当前记录不变。
 */
export function applyVersionUndoProposal(
  current: WorkspaceRecordV1,
  proposal: VersionUndoProposalV1,
  context: VersionTransitionContextV1,
  now: number,
): WorkspaceValidationResult<VersionUndoResultV1> {
  const currentValid = validateWorkspaceRecord(current)
  if (!currentValid.ok) return currentValid
  if (proposal.kind !== 'undo_version_adopt') {
    return fail('invalid_field', '$.proposal.kind', '不是撤销采用的提案；拒绝应用。')
  }
  const baseOk = verifyBase(currentValid.value, proposal.base, context)
  if (!baseOk.ok) return baseOk
  const nextRevision = nextWorkspaceRevision(currentValid.value.workspaceRevision)
  if (!nextRevision.ok) return nextRevision
  if (proposal.nextWorkspaceRevision !== nextRevision.value) {
    return fail(
      'invalid_field',
      '$.proposal.nextWorkspaceRevision',
      '撤销提案里的下一 revision 与当前记录不一致；拒绝撤销，未回放旧 revision。',
    )
  }
  const nextEpoch = nextEpochValue(context.epoch)
  if (!nextEpoch.ok) return nextEpoch
  if (proposal.nextEpoch !== nextEpoch.value) {
    return staleProposal('撤销提案的 epoch 已过期；请重新查看当前状态。')
  }

  const target = verifyTarget(proposal.target)
  if (!target.ok) return target
  const transition = commitWorkspaceTransition(
    currentValid.value,
    {
      trip: target.value.trip,
      sidecar: target.value.sidecar,
      budget: target.value.budget,
    },
    now,
  )
  if (!transition.ok) return transition
  if (transition.value.workspaceRevision !== proposal.nextWorkspaceRevision) {
    return fail(
      'invalid_field',
      '$.workspaceRevision',
      '撤销后的 revision 与提案不一致；拒绝撤销，未写存储。',
    )
  }
  return {
    ok: true,
    value: {
      record: transition.value,
      invalidation: invalidation(transition.value, proposal.nextEpoch, 'version_undo'),
    },
  }
}

/* ───────── 版本库备份 / 导入预览 ───────── */

export const VERSIONS_LIBRARY_SCOPE = 'versions-only' as const

export interface VersionsBackupPreviewV1 {
  readonly scope: typeof VERSIONS_LIBRARY_SCOPE
  readonly record: VersionsRecordV1
  readonly backup: VersionsBackupV1
  /** 预览与下载必须使用同一份字节。 */
  readonly text: string
  readonly bytes: number
}

export interface VersionsImportPreviewV1 {
  readonly scope: typeof VERSIONS_LIBRARY_SCOPE
  readonly record: VersionsRecordV1
  readonly backup: VersionsBackupV1
  /** 用户实际选中的文件文本；确认导入时不得重新生成。 */
  readonly text: string
  readonly bytes: number
}

/**
 * 生成版本库独立备份预览。只包含版本库自身；不包含工作区 / 候选库。
 */
export function buildVersionsBackupPreview(
  record: VersionsRecordV1,
  exportedAt: number,
): WorkspaceValidationResult<VersionsBackupPreviewV1> {
  const cloned = cloneJsonValue<VersionsRecordV1>(record, '$.versions')
  if (!cloned.ok) return cloned
  const validated = validateVersionsRecord(cloned.value)
  if (!validated.ok) return validated

  const backup: VersionsBackupV1 = {
    format: VERSIONS_BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    versions: validated.value,
  }
  const text = JSON.stringify(backup)
  const bytes = utf8ByteLength(text)
  const backupCheck = validateVersionsBackup(JSON.parse(text) as unknown, bytes)
  if (!backupCheck.ok) return backupCheck
  return {
    ok: true,
    value: {
      scope: VERSIONS_LIBRARY_SCOPE,
      record: backupCheck.value.versions,
      backup: backupCheck.value,
      text,
      bytes,
    },
  }
}

/**
 * 版本库导入预览：只解析 / 校验 / 展示，不写任何库。损坏、超限、未知字段或
 * 非版本库 envelope 都拒绝；原版本库字节不在本函数里改变。
 */
export function previewVersionsImport(
  rawText: string,
  rawBytes?: number,
): WorkspaceValidationResult<VersionsImportPreviewV1> {
  if (typeof rawText !== 'string') {
    return fail('invalid_field', '$.file', '备份内容必须是文本；未导入。')
  }
  const actualBytes = utf8ByteLength(rawText)
  if (rawBytes !== undefined) {
    if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) {
      return fail('invalid_field', '$.file.size', '文件字节数无效；未导入。')
    }
    if (rawBytes > MAX_VERSIONS_BACKUP_FILE_BYTES) {
      return fail(
        'limit_exceeded',
        '$.file.size',
        `版本库备份文件超过 8 MiB 上限（实际 ${rawBytes} 字节）；未导入，原版本库不变。`,
      )
    }
  }
  if (actualBytes > MAX_VERSIONS_BACKUP_FILE_BYTES) {
    return fail(
      'limit_exceeded',
      '$.file',
      `版本库备份文件超过 8 MiB 上限（实际 ${actualBytes} 字节）；未导入，原版本库不变。`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText) as unknown
  } catch {
    return fail('invalid_field', '$.file', '备份文件不是合法 JSON；未导入，原版本库不变。')
  }
  const validated = validateVersionsBackup(parsed, actualBytes)
  if (!validated.ok) return validated
  return {
    ok: true,
    value: {
      scope: VERSIONS_LIBRARY_SCOPE,
      record: validated.value.versions,
      backup: validated.value,
      text: rawText,
      bytes: actualBytes,
    },
  }
}

/**
 * 统一存储 owner 的版本库写入接缝。本模块只定义接口与一次单键写入计划，
 * 不实现 localStorage / quota / 跨 tab；具体由后续 workspaceStorage.ts 落地。
 */
export interface VersionsStorageAdapterV1 {
  readonly storageKey: typeof VERSIONS_STORAGE_KEY
  readRaw(): string | null
  writeRaw(text: string): void
}

export interface VersionsLibraryWritePlanV1 {
  readonly scope: typeof VERSIONS_LIBRARY_SCOPE
  readonly storageKey: typeof VERSIONS_STORAGE_KEY
  readonly record: VersionsRecordV1
  readonly text: string
  readonly bytes: number
}

/**
 * 生成一次单键写入的精确 payload；不写存储。版本库容量（10 / 4 MiB /
 * 单快照 2 MiB）在这里再次校验，超限明确失败、不驱逐旧版本。
 */
export function prepareVersionsLibraryWrite(
  record: VersionsRecordV1,
): WorkspaceValidationResult<VersionsLibraryWritePlanV1> {
  const cloned = cloneJsonValue<VersionsRecordV1>(record, '$.versions')
  if (!cloned.ok) return cloned
  const validated = validateVersionsRecord(cloned.value)
  if (!validated.ok) return validated
  const text = JSON.stringify(validated.value)
  const bytes = utf8ByteLength(text)
  const limit = checkVersionsRecordLimits(validated.value)
  if (!limit.ok) {
    return fail('limit_exceeded', '$.versions', limit.message)
  }
  return {
    ok: true,
    value: {
      scope: VERSIONS_LIBRARY_SCOPE,
      storageKey: VERSIONS_STORAGE_KEY,
      record: validated.value,
      text,
      bytes,
    },
  }
}

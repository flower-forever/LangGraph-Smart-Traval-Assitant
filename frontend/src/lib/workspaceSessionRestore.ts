/**
 * 会话恢复 v2 × 工作区的纯适配层。
 *
 * 职责边界：
 * - 只做准备（prepare）与显式确认（confirm）两个纯函数；不读 / 写 localStorage、
 *   不注册事件、不自动恢复、不调用任何 App setter。
 * - 输入必须是**当前已应用**的工作区记录（Trip + sidecar + 手工预算 + meta），
 *   不接受候选库 / 版本库 / 在途草稿；v1（无 workspace）明确返回 no_workspace，
 *   由父层沿用旧兼容流程（新空 sidecar），不得按 tripId / hash 自动读工作区库挂接。
 * - prepare 返回一个完整 proposal：record 是唯一目标状态，Trip / sidecar / budget
 *   必须在父层同一个事件处理器里整体替换，不允许先 setTrip 再补 sidecar。
 * - revision 永远按「当前工作区 revision + 1」计算，绝不回放会话快照里的旧 revision；
 *   epoch 只作为冻结身份返回，推进由 App 的 ref 统一控制。
 * - confirm 必须重验 prepare 时捕获的当前工作区**实际对象引用** + epoch + owner
 *   内容快照；同内容新引用、A-B-A、外部更新都会拒绝，旧 pending 不得复活。
 *
 * 与 sessionRestore.ts 的关系：sessionRestore 负责 v1/v2 payload 的读写与严格解析；
 * 本模块只把解析出的 workspace 记录变成可显式确认的整体恢复提案。
 */
import type { Trip } from './api'
import type {
  BudgetSnapshotV1,
  WorkspaceFingerprintV1,
  WorkspaceIdentityV1,
  WorkspaceMetaV1,
  WorkspaceOwnerV1,
  WorkspaceRecordV1,
  WorkspaceSidecarV1,
} from './workspaceTypes'
import type {
  SessionResumeLoad,
  SessionResumeRecord,
  SessionRestorePreview,
} from './sessionRestore'
import {
  previewSessionResume,
  sessionBudgetSnapshot,
} from './sessionRestore'
import { canonicalValuesEqual, fingerprintOf } from './workspaceFingerprint'
import {
  captureWorkspaceRuntime,
  commitWorkspaceTransition,
  createWorkspaceOwner,
  nextWorkspaceRevision,
  validateWorkspaceRecord,
  workspaceIdentityMatches,
  workspaceIdentityOf,
  workspaceOwnerMatches,
  workspaceRuntimeRefsMatch,
  type WorkspaceRuntimeCaptureV1,
} from './workspace'

export type SessionWorkspaceTransitionKind =
  | 'commit_same_trip'
  | 'new_workspace'
  | 'replace_trip'

export type SessionWorkspaceRestoreFailureReason =
  | 'workspace_invalid'
  | 'trip_mismatch'
  | 'budget_mismatch'
  | 'revision_limit'
  | 'epoch_limit'
  | 'unserializable'

export interface SessionWorkspaceRestoreFailure {
  readonly ok: false
  readonly reason: SessionWorkspaceRestoreFailureReason
  readonly message: string
}

export interface SessionWorkspaceApplyPlan {
  /** 父层必须在同一个 transition 里整体替换这三段，不得分开写。 */
  readonly trip: Trip
  readonly sidecar: WorkspaceSidecarV1
  readonly budget: BudgetSnapshotV1 | null
  readonly workspaceId: string
  readonly ownerId: string
  readonly tripId: string
  readonly workspaceRevision: number
  readonly meta: WorkspaceMetaV1
  readonly atomic: true
  /**
   * App 必须在应用前后推进自己的 epoch ref；本模块不修改外部状态。
   * old pending 的清理由 App 按 epoch 统一执行。
   */
  readonly requiresEpochAdvance: true
  readonly epochBefore: number
  readonly suggestedEpochAfter: number
}

export interface SessionWorkspaceFrozenInput {
  readonly raw: string | null
  readonly savedAt: number | null
  /** prepare 时看到的工作区记录内容快照；不是短 hash 授权。 */
  readonly workspace: WorkspaceFingerprintV1
}

export interface SessionWorkspaceRestoreProposal {
  readonly kind: 'session-workspace-restore'
  readonly transition: SessionWorkspaceTransitionKind
  /** 完整目标记录：Trip + sidecar + budget + revision/meta 全在这一份里。 */
  readonly record: WorkspaceRecordV1
  readonly identity: WorkspaceIdentityV1
  /** prepare 时的 owner token（epoch 为 prepare 传入的 epoch，仅作预览 / 冻结）。 */
  readonly owner: WorkspaceOwnerV1
  readonly snapshot: WorkspaceFingerprintV1
  readonly frozen: SessionWorkspaceFrozenInput
  /**
   * 当前工作区（prepare 时）的实际引用捕获。confirm 用它做引用门；
   * 父层不得用同内容的新对象替代。
   */
  readonly current: {
    readonly record: WorkspaceRecordV1 | null
    readonly capture: WorkspaceRuntimeCaptureV1 | null
    readonly owner: WorkspaceOwnerV1 | null
  }
  readonly previousWorkspaceRevision: number | null
  readonly nextWorkspaceRevision: number
  readonly apply: SessionWorkspaceApplyPlan
}

export interface SessionWorkspaceNoWorkspace {
  readonly ok: true
  readonly status: 'no_workspace'
  readonly frozen: {
    readonly raw: string | null
    readonly savedAt: number | null
  }
  readonly message: string
}

export type PreparedSessionWorkspaceRestore =
  | { readonly ok: true; readonly status: 'ready'; readonly proposal: SessionWorkspaceRestoreProposal }
  | SessionWorkspaceNoWorkspace
  | SessionWorkspaceRestoreFailure

export interface PrepareSessionWorkspaceRestoreInput {
  readonly session: SessionResumeRecord['session']
  readonly savedAt: number | null
  readonly raw: string | null
  /** 当前已持久 / 已应用的工作区记录；null = 本浏览器还没有工作区。 */
  readonly currentWorkspace: WorkspaceRecordV1 | null
  /** App 当前 workspace epoch（只冻结，不推进）。 */
  readonly epoch: number
  readonly now: number
}

function fail(
  reason: SessionWorkspaceRestoreFailureReason,
  message: string,
): SessionWorkspaceRestoreFailure {
  return { ok: false, reason, message }
}

function safeNextEpoch(epoch: number): number | null {
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null
  if (epoch >= Number.MAX_SAFE_INTEGER) return null
  return epoch + 1
}

/**
 * 显式恢复前的纯准备：把会话 payload 里已解析的 workspace 记录变成整体提案。
 *
 * - v1 / v2 workspace:null → status:'no_workspace'（不自动挂接任何工作区）。
 * - v2 workspace 必须与 session.trip 内容一致；预算只认 binding.current 且 tripId
 *   相同的映射，stale / unbound → null，绝不冒充当前预算。
 * - 当前工作区同 trip → 用公共 commitWorkspaceTransition 生成「当前 revision +1」的
 *   新对象，保留当前 workspaceId / ownerId / meta.createdAt。
 * - 当前工作区是别的 trip / 不存在 → 生成一份完整新记录；revision 仍取当前值 +1，
 *   绝不回放快照里的 revision。父层必须把这种提案当作显式换行程再确认。
 * - 失败时只返回 typed 失败，不产生任何写副作用。
 */
export function prepareSessionWorkspaceRestore(
  input: PrepareSessionWorkspaceRestoreInput,
): PreparedSessionWorkspaceRestore {
  const session = input.session
  const sourceWorkspace = session.workspace ?? null

  if (sourceWorkspace === null) {
    return {
      ok: true,
      status: 'no_workspace',
      frozen: { raw: input.raw, savedAt: input.savedAt },
      message:
        '这份留存没有工作区数据（旧 v1 或 v2 workspace:null）。按旧兼容流程只恢复 Trip；工作区 sidecar 视为空，不自动按 tripId / hash 读取或挂接工作区库。',
    }
  }

  const sourceCheck = validateWorkspaceRecord(sourceWorkspace)
  if (!sourceCheck.ok) {
    return fail('workspace_invalid', `会话里的工作区记录没有通过校验：${sourceCheck.message}`)
  }
  const source = sourceCheck.value

  if (!canonicalValuesEqual(source.trip, session.trip)) {
    return fail('trip_mismatch', '会话 workspace 块与 session.trip 不是同一份行程；整份恢复已拒绝。')
  }

  const mappedBudget = sessionBudgetSnapshot(session.budget, session.trip.id)
  if (!canonicalValuesEqual(source.budget, mappedBudget)) {
    return fail(
      'budget_mismatch',
      '会话 workspace 记录里的手工预算与 session.budget 映射结果不一致；整份恢复已拒绝，避免静默选一份。',
    )
  }

  const nextEpoch = safeNextEpoch(input.epoch)
  if (nextEpoch === null) {
    return fail('epoch_limit', '当前 workspace epoch 不是可递增的安全整数，恢复预览已拒绝。')
  }

  // 保留调用方的实际对象引用（validate 可能返回解析后的新对象，不能拿来替换 ref）。
  const current: WorkspaceRecordV1 | null = input.currentWorkspace
  if (current !== null) {
    const currentCheck = validateWorkspaceRecord(current)
    if (!currentCheck.ok) {
      return fail('workspace_invalid', `当前工作区记录没有通过校验：${currentCheck.message}`)
    }
  }

  const currentRevision = current?.workspaceRevision ?? 0
  const nextRevision = nextWorkspaceRevision(currentRevision)
  if (!nextRevision.ok) {
    return fail('revision_limit', nextRevision.message)
  }

  const frozenWorkspace = fingerprintOf(source)
  if (!frozenWorkspace.ok) {
    return fail('unserializable', frozenWorkspace.message)
  }

  let record: WorkspaceRecordV1
  let transition: SessionWorkspaceTransitionKind

  if (current !== null && current.tripId === session.trip.id) {
    // 同一行程：公共 transition 一次性换 Trip + sidecar + budget，revision=当前+1。
    const committed = commitWorkspaceTransition(
      current,
      {
        trip: session.trip,
        sidecar: source.sidecar,
        budget: mappedBudget,
      },
      input.now,
    )
    if (!committed.ok) {
      return fail('workspace_invalid', committed.message)
    }
    record = committed.value
    transition = 'commit_same_trip'
  } else {
    // 没有工作区，或当前工作区属于另一个 trip：生成一份完整新记录。
    // revision 仍按当前工作区 +1（无工作区时从 1 开始），不回放 source.workspaceRevision。
    const candidate: WorkspaceRecordV1 = {
      format: source.format,
      version: source.version,
      workspaceId: source.workspaceId,
      ownerId: source.ownerId,
      tripId: session.trip.id,
      trip: session.trip,
      sidecar: source.sidecar,
      budget: mappedBudget,
      workspaceRevision: nextRevision.value,
      updatedAt: input.now,
      meta: { createdAt: source.meta.createdAt, label: source.meta.label },
    }
    const validated = validateWorkspaceRecord(candidate)
    if (!validated.ok) {
      return fail('workspace_invalid', validated.message)
    }
    record = validated.value
    transition = current === null ? 'new_workspace' : 'replace_trip'
  }

  const snapshot = fingerprintOf(record)
  if (!snapshot.ok) {
    return fail('unserializable', snapshot.message)
  }
  const owner = createWorkspaceOwner(record, input.epoch)
  if (!owner.ok) {
    return fail('workspace_invalid', owner.message)
  }

  let currentCapture: WorkspaceRuntimeCaptureV1 | null = null
  let currentOwner: WorkspaceOwnerV1 | null = null
  if (current !== null) {
    const capture = captureWorkspaceRuntime(current, input.epoch, { input: input.raw })
    if (!capture.ok) {
      return fail('workspace_invalid', capture.message)
    }
    const currentOwnerResult = createWorkspaceOwner(current, input.epoch)
    if (!currentOwnerResult.ok) {
      return fail('workspace_invalid', currentOwnerResult.message)
    }
    currentCapture = capture.value
    currentOwner = currentOwnerResult.value
  }

  return {
    ok: true,
    status: 'ready',
    proposal: {
      kind: 'session-workspace-restore',
      transition,
      record,
      identity: workspaceIdentityOf(record),
      owner: owner.value,
      snapshot: snapshot.fingerprint,
      frozen: { raw: input.raw, savedAt: input.savedAt, workspace: frozenWorkspace.fingerprint },
      current: {
        record: current,
        capture: currentCapture,
        owner: currentOwner,
      },
      previousWorkspaceRevision: current?.workspaceRevision ?? null,
      nextWorkspaceRevision: record.workspaceRevision,
      apply: {
        trip: record.trip,
        sidecar: record.sidecar,
        budget: record.budget,
        workspaceId: record.workspaceId,
        ownerId: record.ownerId,
        tripId: record.tripId,
        workspaceRevision: record.workspaceRevision,
        meta: record.meta,
        atomic: true,
        requiresEpochAdvance: true,
        epochBefore: input.epoch,
        suggestedEpochAfter: nextEpoch,
      },
    },
  }
}

export type SessionWorkspaceConfirmFailureReason =
  | 'current_changed'
  | 'epoch_changed'
  | 'workspace_changed'
  | 'input_changed'
  | 'invalid_proposal'
  | 'epoch_limit'
  | 'unserializable'

export type SessionWorkspaceConfirmResult =
  | {
      readonly ok: true
      readonly record: WorkspaceRecordV1
      readonly owner: WorkspaceOwnerV1
      readonly runtime: WorkspaceRuntimeCaptureV1
      readonly apply: SessionWorkspaceApplyPlan
      /** App 应用后应使用的 epoch；由 App 的 ref 实际推进。 */
      readonly nextEpoch: number
    }
  | {
      readonly ok: false
      readonly reason: SessionWorkspaceConfirmFailureReason
      readonly message: string
    }

/**
 * 显式恢复的确认门：只有 prepare 后当前工作区对象、epoch、owner 内容全部未变才通过。
 *
 * 必须先过 actual refs + safe epoch，再比 owner 的完整 canonical 快照；同内容换新对象、
 * A-B-A、另一个 tab 更新、epoch 推进都返回 typed 失败，旧 proposal 不得复活。
 */
export interface ConfirmSessionWorkspaceRestoreOptions {
  /**
   * App 在确认时实际读到的会话内容键 raw。传入时必须与 prepare 冻结的 raw 逐字节
   * 相等；用于把“另一个 tab 已更新”挡在应用之前。省略则依赖调用方在外部先做 CAS。
   */
  readonly currentRaw?: string | null
}

export function confirmSessionWorkspaceRestore(
  prepared: Extract<PreparedSessionWorkspaceRestore, { ok: true; status: 'ready' }>,
  currentWorkspace: WorkspaceRecordV1 | null,
  epoch: number,
  options: ConfirmSessionWorkspaceRestoreOptions = {},
): SessionWorkspaceConfirmResult {
  const proposal = prepared.proposal
  if (options.currentRaw !== undefined && options.currentRaw !== proposal.frozen.raw) {
    return {
      ok: false,
      reason: 'input_changed',
      message: '留存副本已被另一个标签页或外部更新；恢复未执行，旧确认已失效。',
    }
  }
  const nextEpoch = safeNextEpoch(epoch)
  if (nextEpoch === null) {
    return { ok: false, reason: 'epoch_limit', message: '当前 workspace epoch 不是可递增的安全整数，恢复未执行。' }
  }
  // epoch 本身也是确认身份的一部分：即使没有当前工作区对象，旧 pending 也不能跨 epoch 复活。
  if (epoch !== proposal.apply.epochBefore) {
    return {
      ok: false,
      reason: 'epoch_changed',
      message: '当前 workspace epoch 已变化；恢复未执行，旧确认已失效。',
    }
  }

  if (proposal.current.record === null) {
    if (currentWorkspace !== null) {
      return {
        ok: false,
        reason: 'current_changed',
        message: '预览时还没有当前工作区，确认时已经出现；恢复未执行，双方数据保持原样。',
      }
    }
  } else {
    if (currentWorkspace === null) {
      return {
        ok: false,
        reason: 'current_changed',
        message: '预览时的当前工作区已不存在；恢复未执行，双方数据保持原样。',
      }
    }
    if (proposal.current.capture === null || proposal.current.owner === null) {
      return { ok: false, reason: 'invalid_proposal', message: '恢复提案缺少当前工作区引用门上下文。' }
    }
    const refsMatch = workspaceRuntimeRefsMatch(
      proposal.current.capture,
      currentWorkspace,
      epoch,
      { input: proposal.frozen.raw },
    )
    if (!refsMatch) {
      return {
        ok: false,
        reason: 'current_changed',
        message: '当前工作区对象或 epoch 已变化（包括同内容新引用 / A-B-A）；恢复未执行，旧确认已失效。',
      }
    }
    if (!workspaceOwnerMatches(proposal.current.owner, currentWorkspace, epoch)) {
      return {
        ok: false,
        reason: 'workspace_changed',
        message: '当前工作区内容已变化；恢复未执行，旧确认已失效。',
      }
    }
  }

  const check = validateWorkspaceRecord(proposal.record)
  if (!check.ok) {
    return { ok: false, reason: 'invalid_proposal', message: check.message }
  }
  if (!workspaceIdentityMatches(proposal.identity, check.value)) {
    return { ok: false, reason: 'invalid_proposal', message: '恢复提案的身份 / revision 已变化。' }
  }
  const snapshot = fingerprintOf(check.value)
  if (!snapshot.ok) {
    return { ok: false, reason: 'unserializable', message: snapshot.message }
  }

  const owner = createWorkspaceOwner(check.value, nextEpoch)
  if (!owner.ok) {
    return { ok: false, reason: 'invalid_proposal', message: owner.message }
  }
  const runtime = captureWorkspaceRuntime(check.value, nextEpoch, { input: proposal.frozen.raw })
  if (!runtime.ok) {
    return { ok: false, reason: 'invalid_proposal', message: runtime.message }
  }

  return {
    ok: true,
    record: check.value,
    owner: owner.value,
    runtime: runtime.value,
    apply: { ...proposal.apply, suggestedEpochAfter: nextEpoch },
    nextEpoch,
  }
}

/* ───────── 与既有 previewSessionResume 合成的单次预览 ───────── */

export interface PreviewSessionResumeWithWorkspaceInput {
  readonly load: Extract<SessionResumeLoad, { status: 'pending' }>
  readonly currentWorkspace: WorkspaceRecordV1 | null
  readonly epoch: number
  /** App 现有 Trip revision；草稿 / 预算重建使用 revision+1。 */
  readonly tripRevision: number
  readonly now: number
}

export interface SessionRestoreWorkspaceFrozen {
  readonly raw: string
  readonly savedAt: number
  readonly version: 1 | 2
}

export type PreviewSessionResumeWithWorkspaceResult =
  | {
      readonly ok: true
      readonly status: 'ready'
      readonly version: 1 | 2
      /** 既有草稿 / 预算 / UI 预览；父层仍按原方式应用。 */
      readonly base: Extract<SessionRestorePreview, { ok: true }>
      readonly workspace: SessionWorkspaceRestoreProposal
      readonly frozen: SessionRestoreWorkspaceFrozen
    }
  | {
      readonly ok: true
      readonly status: 'no_workspace'
      readonly version: 1 | 2
      readonly base: Extract<SessionRestorePreview, { ok: true }>
      readonly workspace: null
      readonly frozen: SessionRestoreWorkspaceFrozen
      readonly message: string
    }
  | { readonly ok: false; readonly message: string }

/**
 * 一次拿到「旧 v1 草稿 / 预算预览」与「v2 工作区整体提案」。
 * 任一失败都返回 ok:false，父层不得应用半份结果。
 */
export function previewSessionResumeWithWorkspace(
  input: PreviewSessionResumeWithWorkspaceInput,
): PreviewSessionResumeWithWorkspaceResult {
  const base = previewSessionResume(input.load.record, input.tripRevision + 1, {
    allowWorkspace: true,
  })
  if (!base.ok) {
    return { ok: false, message: base.message }
  }

  const prepared = prepareSessionWorkspaceRestore({
    session: input.load.record.session,
    savedAt: input.load.record.savedAt,
    raw: input.load.raw,
    currentWorkspace: input.currentWorkspace,
    epoch: input.epoch,
    now: input.now,
  })
  if (!prepared.ok) {
    return { ok: false, message: prepared.message }
  }

  const version =
    input.load.version ??
    (input.load.record.session.workspace === null || input.load.record.session.workspace === undefined
      ? 1
      : 2)
  const frozen: SessionRestoreWorkspaceFrozen = {
    raw: input.load.raw,
    savedAt: input.load.record.savedAt,
    version,
  }

  if (prepared.status === 'no_workspace') {
    return {
      ok: true,
      status: 'no_workspace',
      version,
      base,
      workspace: null,
      frozen,
      message: prepared.message,
    }
  }

  return { ok: true, status: 'ready', version, base, workspace: prepared.proposal, frozen }
}

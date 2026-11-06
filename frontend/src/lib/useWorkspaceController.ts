/**
 * 工作区 / 版本库 App 控制器（W8 UI 集成切片）。
 *
 * 边界：
 * - 内存权威记录只有一条 `WorkspaceRecordV1`：Trip + sidecar + budget 通过
 *   `commitWorkspaceTransition` 一次整体切换，不存在 Trip / sidecar / budget 三套独立状态。
 * - 读取只在用户显式动作时发生：打开工作区、打开版本库；不在挂载时自动读取，更不读取
 *   会话恢复内容键（SESSION_RESUME_DATA_KEY 一律不碰）。
 * - 写入走 `workspaceStorage.ts` 的 async Web Locks API；只有 `await` 返回 `ok:true`
 *   才更新「已保存」状态。版本库保存按钮只写版本库自身，不写工作区键。
 * - F4 采用 / 撤销是内存 transition，不是正式保存；revision 始终当前 +1，不回放快照
 *   旧 revision。运行期先核对实际对象引用 + epoch，再由 F4 模块核对 canonical / ID /
 *   revision / binding。异步晚到的结果不能覆盖新 owner。
 * - 每次编辑 / 切换 / 采用 / 撤销 / 导入 / 外部 storage 变化都推进 epoch；
 *   A-B-A 恢复相同内容也不能复用旧 pending。
 * - 外部 storage 变化只推进 epoch 并提示，不自动读取 / 不自动恢复。
 * - 不按 hash 自动挂接任何库；换 trip.id = 新工作区，sidecar 不继承。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { Trip } from './api'
import {
  captureWorkspaceRuntime,
  commitWorkspaceTransition,
  createLogicalId,
  createWorkspaceRecord,
  emptySidecar,
  nextWorkspaceRevision,
  validateWorkspaceRecord,
  workspaceRuntimeRefsMatch,
  type WorkspaceRuntimeCaptureV1,
} from './workspace'
import { canonicalValuesEqual, fingerprintOf } from './workspaceFingerprint'
import {
  DEFAULT_UNDO_TTL_MS,
  getWorkspaceLocalStorage,
  getWorkspaceLockManager,
  invalidateLibraryGenerations,
  loadVersionsRecord,
  loadWorkspaceRecord,
  saveVersionsRecord,
  saveWorkspaceRecord,
  undoImport,
  type WorkspaceLockManager,
  type WorkspaceRecordRead,
  type WorkspaceStorageLike,
} from './workspaceStorage'
import {
  cancelPreparedImport,
  confirmVersionsImport,
  prepareVersionsImport,
} from './workspaceTransfer'
import {
  addVersionSnapshot,
  applyVersionAdoptProposal,
  applyVersionUndoProposal,
  createVersionSnapshot,
  prepareVersionsLibraryWrite,
  type VersionAdoptProposalV1,
  type VersionUndoProposalV1,
  type VersionsImportPreviewV1,
  type VersionsLibraryStatusV1,
} from './versionSnapshots'
import {
  CANDIDATES_STORAGE_KEY,
  VERSIONS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  type BudgetSnapshotV1,
  type VersionsRecordV1,
  type WorkspaceRecordV1,
  type WorkspaceSidecarV1,
} from './workspaceTypes'

export type WorkspaceLinkStatus =
  | 'unloaded'
  | 'detached'
  | 'empty'
  | 'in_memory'
  | 'saved'
  | 'unavailable'
  | 'corrupt'
  | 'anomaly'
  | 'unknown_version'

export interface WorkspaceNotice {
  readonly tone: 'ok' | 'error' | 'info'
  readonly text: string
}

export interface WorkspaceActionResult {
  readonly ok: boolean
  readonly reason?: string
  readonly message?: string
}

/** applyTripChange 的结果：说明这次行程变更在工作区里的归属。 */
export type WorkspaceTripChangeResult =
  | { ok: true; kind: 'unlinked' | 'detached' | 'transitioned' | 'forked' }
  | { ok: false; reason: string; message: string }

/** 当前内存记录 + 同一时刻的 epoch / 实际引用捕获（父级预览前保存）。 */
export interface WorkspaceRuntimeHandle {
  readonly record: WorkspaceRecordV1
  readonly epoch: number
  readonly capture: WorkspaceRuntimeCaptureV1
}

export interface WorkspaceAdoptOptions {
  /** 恢复 v2 允许在内存无记录时安装一份新工作区（revision 1）。 */
  readonly allowNewWorkspace?: boolean
  /**
   * 内部 fork（草稿 / AI 整日 / 后段 / 地图刷新）产生新 trip.id 时，
   * 保留同一 workspaceId/ownerId/sidecar/budget 并重绑 tripId；revision 仍当前 +1。
   */
  readonly allowTripRebind?: boolean
  /** false = 只更新 controller 记录，由入口处理器自己投影界面（避免重复 +1）。 */
  readonly notify?: boolean
}

export interface WorkspacePatchInput {
  readonly trip?: Trip
  readonly sidecar?: WorkspaceSidecarV1
  readonly budget?: BudgetSnapshotV1 | null
}

export interface CreateWorkspaceInput {
  readonly trip: Trip
  readonly budget?: BudgetSnapshotV1 | null
  readonly label?: string | null
}

export interface UseWorkspaceControllerOptions {
  /** 省略 = 每次动作时取 window.localStorage；null = 明确不可用。 */
  readonly storage?: WorkspaceStorageLike | null
  /** 省略 = 每次动作时尝试 navigator.locks；null = 明确无锁（写入拒绝）。 */
  readonly locks?: WorkspaceLockManager | null
  /** 只用于测试 / 上层注入；默认 Date.now。 */
  readonly now?: () => number
  /** 内存记录切换后通知 App 投影 Trip / budget；不代表已持久保存。 */
  readonly onRecordApplied?: (record: WorkspaceRecordV1) => void
  /**
   * 观察到工作区 / 版本库 / 候选库的 storage 事件后通知 App（key=null 表示 clear）。
   * controller 已推进 epoch 并失效对应库 generation；App 只应作废旧预览 / 提示重载，
   * 不得自动读取或覆盖当前内存。
   */
  readonly onExternalStorageChange?: (key: string | null) => void
}

interface WorkspaceControllerState {
  readonly workspace: WorkspaceRecordV1 | null
  readonly workspaceStatus: WorkspaceLinkStatus
  readonly workspaceMessage: string | null
  readonly workspaceExternallyChanged: boolean
  readonly versions: VersionsRecordV1 | null
  readonly versionsStatus: VersionsLibraryStatusV1
  readonly versionsMessage: string | null
  readonly versionsLoaded: boolean
  readonly versionsExternallyChanged: boolean
  readonly epoch: number
  readonly busy: boolean
  readonly canWrite: boolean
  readonly notice: WorkspaceNotice | null
  readonly undoProposal: VersionUndoProposalV1 | null
  /** 最近一次版本库导入的撤销窗口截止时间；null = 没有可撤销的导入。 */
  readonly versionsImportUndoExpiresAt: number | null
}

export interface WorkspaceController extends WorkspaceControllerState {
  openWorkspace: () => WorkspaceActionResult
  createWorkspace: (input: CreateWorkspaceInput) => WorkspaceActionResult
  detach: () => boolean
  /**
   * 当前 Trip 变更的唯一最终 apply 门：工作区未关联时直接放行（kind:'unlinked'）；
   * 换 trip.id 解除关联（sidecar 不继承）；同 id 走一次整体 transition
   * （Trip + sidecar + budget 同时切换，revision 当前 +1，epoch 推进）。
   * budget 省略 = 保留记录里的现有预算快照；null = 明确清空。
   * 失败时旧记录不变，App 不得继续 setTrip。
   */
  applyTripChange: (trip: Trip, budget?: BudgetSnapshotV1 | null) => WorkspaceTripChangeResult
  /** 当前记录 + epoch + 实际引用；无记录返回 null。 */
  getRuntime: () => WorkspaceRuntimeHandle | null
  /**
   * 安装父级已经过自身 H/U / canonical / owner 门计算好的下一条记录。
   * 运行期先核对 capture 与当前实际 refs + epoch，再核对身份 / revision / tripId。
   * 默认不通知界面；恢复等需要整体投影时显式 notify。
   */
  adoptRecord: (
    next: WorkspaceRecordV1,
    capture: WorkspaceRuntimeCaptureV1 | null,
    options?: WorkspaceAdoptOptions,
  ) => WorkspaceActionResult
  /** 同 trip.id 的 Trip + sidecar + budget 单次 transition；先过实际引用门。 */
  applyPatch: (
    patch: WorkspacePatchInput,
    capture: WorkspaceRuntimeCaptureV1 | null,
    options?: { readonly notify?: boolean },
  ) => WorkspaceActionResult
  /**
   * 内部 fork：草稿 / AI 整日 / 后段 / 地图刷新产生新 trip.id 时，保留同一工作区
   * 身份与 sidecar/budget，只重绑 tripId，revision 当前 +1。显式换行程仍走
   * applyTripChange（解除关联）。
   */
  applyTripFork: (
    trip: Trip,
    budget: BudgetSnapshotV1 | null | undefined,
    capture: WorkspaceRuntimeCaptureV1 | null,
  ) => WorkspaceTripChangeResult
  saveWorkspace: (budget?: BudgetSnapshotV1 | null) => Promise<WorkspaceActionResult>
  openVersions: () => WorkspaceActionResult
  saveVersion: (name: string) => Promise<WorkspaceActionResult>
  /** 确认导入版本库备份（F4 面板已预览；这里在锁内一次写入并给一次撤销）。 */
  importVersions: (preview: VersionsImportPreviewV1) => Promise<WorkspaceActionResult>
  /** 撤销最近一次版本库导入（一次机会；锁内比对写入值）。 */
  undoVersionsImport: () => Promise<WorkspaceActionResult>
  adoptVersion: (proposal: VersionAdoptProposalV1) => WorkspaceActionResult
  undoAdopt: (proposal?: VersionUndoProposalV1) => WorkspaceActionResult
  dismissNotice: () => void
}

const UNAVAILABLE_TEXT =
  '当前浏览器无法访问本地存储（可能是无痕模式或站点设置禁用了站点数据）。没有写入任何数据。'
const READ_ONLY_TEXT =
  '当前浏览器不支持安全的本地写入互斥；工作区与版本库只能读取和导出，保存已停用。换用支持该能力的浏览器后可写入。'
const DETACHED_TEXT =
  '当前行程已切换：工作区约束在当前页面解除，不会套用到新行程。本地保存的工作区仍然存在，可在需要时显式打开。'

function failure(reason: string, message: string): WorkspaceActionResult {
  return { ok: false, reason, message }
}

function ok(): WorkspaceActionResult {
  return { ok: true }
}

function canonicalOf(value: unknown): string | null {
  const result = fingerprintOf(value)
  return result.ok ? result.fingerprint.canonical : null
}

function readFailureStatus(
  read: WorkspaceRecordRead,
): Extract<WorkspaceLinkStatus, 'unavailable' | 'corrupt' | 'anomaly' | 'unknown_version'> | null {
  switch (read.status) {
    case 'unavailable':
      return 'unavailable'
    case 'corrupt':
      return 'corrupt'
    case 'anomaly':
      return 'anomaly'
    case 'unknown_version':
      return 'unknown_version'
    default:
      return null
  }
}

/**
 * 单一工作区 / 版本库控制器。所有写操作串行（busy），所有成功 transition 推进 epoch。
 */
export function useWorkspaceController(
  options: UseWorkspaceControllerOptions = {},
): WorkspaceController {
  const storageOptionRef = useRef(options.storage)
  const locksOptionRef = useRef(options.locks)
  const nowRef = useRef(options.now ?? (() => Date.now()))
  const onRecordAppliedRef = useRef(options.onRecordApplied)
  const onExternalStorageChangeRef = useRef(options.onExternalStorageChange)
  storageOptionRef.current = options.storage
  locksOptionRef.current = options.locks
  nowRef.current = options.now ?? (() => Date.now())
  onRecordAppliedRef.current = options.onRecordApplied
  onExternalStorageChangeRef.current = options.onExternalStorageChange

  const workspaceRef = useRef<WorkspaceRecordV1 | null>(null)
  const versionsRef = useRef<VersionsRecordV1 | null>(null)
  const epochRef = useRef(0)
  const workspaceRawRef = useRef<string | null>(null)
  const workspaceCanonicalRef = useRef<string | null>(null)
  const versionsRawRef = useRef<string | null>(null)
  const versionsStatusRef = useRef<VersionsLibraryStatusV1>('empty')
  const versionsLoadedRef = useRef(false)
  const versionsImportUndoRef = useRef<{ undoId: string; key: string; expiresAt: number } | null>(null)
  const undoRef = useRef<VersionUndoProposalV1 | null>(null)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)

  const [workspace, setWorkspace] = useState<WorkspaceRecordV1 | null>(null)
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceLinkStatus>('unloaded')
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null)
  const [workspaceExternallyChanged, setWorkspaceExternallyChanged] = useState(false)
  const [versions, setVersions] = useState<VersionsRecordV1 | null>(null)
  const [versionsStatus, setVersionsStatus] = useState<VersionsLibraryStatusV1>('empty')
  const [versionsMessage, setVersionsMessage] = useState<string | null>(null)
  const [versionsLoaded, setVersionsLoaded] = useState(false)
  const [versionsExternallyChanged, setVersionsExternallyChanged] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null)
  const [undoProposal, setUndoProposal] = useState<VersionUndoProposalV1 | null>(null)
  const [versionsImportUndoExpiresAt, setVersionsImportUndoExpiresAt] = useState<number | null>(null)
  const [canWrite, setCanWrite] = useState(() => {
    const locks = options.locks === undefined ? getWorkspaceLockManager() : options.locks
    return locks !== null
  })

  useEffect(() => {
    // React StrictMode dev 会对每个 effect 额外跑一次 setup+cleanup（官方文档：
    // "run one extra setup+cleanup cycle in development for every Effect"）。
    // ref 不会重新初始化，所以 mounted 守卫必须在每次 setup 里显式恢复为 true；
    // cleanup 仍只在真正卸载时置 false。否则双挂载后所有 applyRecord / 异步落点
    // 都会被误判为已卸载，工作区状态永远不更新。
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const resolveStorage = useCallback((): WorkspaceStorageLike | null => {
    return storageOptionRef.current === undefined
      ? getWorkspaceLocalStorage()
      : storageOptionRef.current
  }, [])

  const resolveLocks = useCallback((): WorkspaceLockManager | null => {
    return locksOptionRef.current === undefined
      ? getWorkspaceLockManager()
      : locksOptionRef.current
  }, [])

  const advanceEpoch = useCallback((): number => {
    const next = epochRef.current + 1
    epochRef.current = next
    if (mountedRef.current) setEpoch(next)
    return next
  }, [])

  const clearUndo = useCallback(() => {
    undoRef.current = null
    if (mountedRef.current) setUndoProposal(null)
  }, [])

  const applyRecord = useCallback(
    (
      record: WorkspaceRecordV1,
      status: WorkspaceLinkStatus,
      nextEpoch?: number,
      notify = true,
    ) => {
      workspaceRef.current = record
      const value = nextEpoch ?? advanceEpoch()
      epochRef.current = value
      if (!mountedRef.current) return
      setWorkspace(record)
      setWorkspaceStatus(status)
      setEpoch(value)
      if (notify) onRecordAppliedRef.current?.(record)
    },
    [advanceEpoch],
  )

  const commitInMemoryRecord = useCallback(
    (record: WorkspaceRecordV1, nextEpoch?: number) => {
      clearUndo()
      applyRecord(record, 'in_memory', nextEpoch)
    },
    [applyRecord, clearUndo],
  )

  const setWorkspaceBlocked = useCallback((status: WorkspaceLinkStatus, message: string | null) => {
    if (!mountedRef.current) return
    setWorkspaceStatus(status)
    setWorkspaceMessage(message)
  }, [])

  const openWorkspace = useCallback((): WorkspaceActionResult => {
    const storage = resolveStorage()
    if (!storage) {
      setWorkspaceBlocked('unavailable', UNAVAILABLE_TEXT)
      setNotice({ tone: 'error', text: UNAVAILABLE_TEXT })
      return failure('unavailable', UNAVAILABLE_TEXT)
    }
    const read = loadWorkspaceRecord(storage)
    if (read.status === 'ok') {
      workspaceRawRef.current = read.raw
      workspaceCanonicalRef.current = canonicalOf(read.record)
      setWorkspaceMessage(null)
      setWorkspaceExternallyChanged(false)
      clearUndo()
      applyRecord(read.record, 'saved')
      setNotice({ tone: 'ok', text: '已打开本地保存的工作区；没有读取会话恢复副本。' })
      return ok()
    }
    if (read.status === 'empty') {
      if (workspaceRef.current === null) {
        workspaceRawRef.current = read.raw
        workspaceCanonicalRef.current = null
        setWorkspaceStatus('empty')
        setWorkspaceMessage('本地还没有保存的工作区。可以用当前行程新建一个。')
        setWorkspaceExternallyChanged(false)
      } else {
        setNotice({
          tone: 'info',
          text: '本地没有可打开的工作区；当前页面里的工作区没有改变。',
        })
      }
      return failure('empty', '本地还没有保存的工作区。')
    }
    const blocked = readFailureStatus(read)
    const status = blocked ?? 'corrupt'
    setWorkspaceBlocked(status, read.message)
    setNotice({ tone: 'error', text: read.message })
    return failure(status, read.message)
  }, [applyRecord, clearUndo, resolveStorage, setWorkspaceBlocked])

  const createWorkspace = useCallback(
    (input: CreateWorkspaceInput): WorkspaceActionResult => {
      if (workspaceRef.current !== null) {
        const message = '当前已经关联了一个工作区；先解除关联或重新打开，避免覆盖未保存内容。'
        setNotice({ tone: 'error', text: message })
        return failure('already_linked', message)
      }
      const storage = resolveStorage()
      if (!storage) {
        setWorkspaceBlocked('unavailable', UNAVAILABLE_TEXT)
        setNotice({ tone: 'error', text: UNAVAILABLE_TEXT })
        return failure('unavailable', UNAVAILABLE_TEXT)
      }
      // 显式创建也先读自己的键：已存在 / 损坏时拒绝，避免首次保存覆盖未知内容。
      const existing = loadWorkspaceRecord(storage)
      if (existing.status === 'ok') {
        const message = '本地已经有一个工作区。请先显式打开它；不会用当前行程覆盖已有记录。'
        setNotice({ tone: 'error', text: message })
        return failure('exists', message)
      }
      if (existing.status !== 'empty') {
        const blocked = readFailureStatus(existing) ?? 'corrupt'
        setWorkspaceBlocked(blocked, existing.message)
        setNotice({ tone: 'error', text: existing.message })
        return failure(blocked, existing.message)
      }

      const created = createWorkspaceRecord({
        workspaceId: createLogicalId(),
        ownerId: createLogicalId(),
        trip: input.trip,
        workspaceRevision: 1,
        now: nowRef.current(),
        sidecar: emptySidecar(),
        budget: input.budget ?? null,
        label: input.label ?? input.trip.title,
      })
      if (!created.ok) {
        setNotice({ tone: 'error', text: created.message })
        return failure(created.reason, created.message)
      }
      workspaceRawRef.current = existing.raw
      workspaceCanonicalRef.current = null
      setWorkspaceMessage(null)
      setWorkspaceExternallyChanged(false)
      commitInMemoryRecord(created.value)
      setNotice({
        tone: 'info',
        text: '已用当前行程新建工作区（只在内存中）。点「保存工作区」才会写入本地；版本库与工作区各自独立保存。',
      })
      return ok()
    },
    [commitInMemoryRecord, resolveStorage, setWorkspaceBlocked],
  )

  const detach = useCallback((): boolean => {
    if (workspaceRef.current === null) return false
    workspaceRef.current = null
    clearUndo()
    advanceEpoch()
    if (!mountedRef.current) return true
    setWorkspace(null)
    setWorkspaceStatus('detached')
    setWorkspaceMessage(DETACHED_TEXT)
    setWorkspaceExternallyChanged(false)
    setNotice({ tone: 'info', text: DETACHED_TEXT })
    return true
  }, [advanceEpoch, clearUndo])

  /**
   * 当前 Trip 变更的唯一最终 apply 门（内存 only，不写存储）：
   * - 工作区未关联 → 放行（App 继续旧流程；仍然不读任何库）；
   * - 换 trip.id → 解除关联（换行程 = 新工作区；sidecar 不继承，即使内容 / id 相同
   *   也不自动挂接；用户之后可以显式新建 / 打开）；
   * - 同 trip.id → 先过运行期引用门（实际 refs + safe epoch），再
   *   commitWorkspaceTransition 一次整体切换 Trip + sidecar + budget；
   *   revision 当前 +1、epoch 推进、旧采用撤销提案清除（A-B-A 不复活）。
   * 这里不触发 onRecordApplied 投影：App 的入口处理器自己做界面投影，
   * 避免双重投影把各入口自己的提示 / 选中状态冲掉。
   */
  const applyTripChange = useCallback(
    (trip: Trip, budget?: BudgetSnapshotV1 | null): WorkspaceTripChangeResult => {
      const current = workspaceRef.current
      if (current === null) return { ok: true, kind: 'unlinked' }
      if (trip.id !== current.tripId) {
        detach()
        return { ok: true, kind: 'detached' }
      }
      const capture = captureWorkspaceRuntime(current, epochRef.current)
      if (!capture.ok) {
        return { ok: false, reason: capture.reason, message: `没有应用这次行程变更：${capture.message}` }
      }
      if (!workspaceRuntimeRefsMatch(capture.value, current, epochRef.current)) {
        const message = '当前工作区已在其它操作中变化；这次行程变更未应用，请重试。'
        return { ok: false, reason: 'stale', message }
      }
      const transition = commitWorkspaceTransition(
        current,
        { trip, ...(budget === undefined ? {} : { budget }) },
        nowRef.current(),
      )
      if (!transition.ok) {
        return { ok: false, reason: transition.reason, message: `没有应用这次行程变更：${transition.message}` }
      }
      clearUndo()
      workspaceRef.current = transition.value
      advanceEpoch()
      if (mountedRef.current) {
        setWorkspace(transition.value)
        setWorkspaceStatus('in_memory')
        setWorkspaceExternallyChanged(false)
      }
      return { ok: true, kind: 'transitioned' }
    },
    [advanceEpoch, clearUndo, detach],
  )

  const getRuntime = useCallback((): WorkspaceRuntimeHandle | null => {
    const current = workspaceRef.current
    if (current === null) return null
    const capture = captureWorkspaceRuntime(current, epochRef.current)
    if (!capture.ok) return null
    return { record: current, epoch: epochRef.current, capture: capture.value }
  }, [])

  const adoptRecord = useCallback(
    (
      next: WorkspaceRecordV1,
      capture: WorkspaceRuntimeCaptureV1 | null,
      options: WorkspaceAdoptOptions = {},
    ): WorkspaceActionResult => {
      const nextCheck = validateWorkspaceRecord(next)
      if (!nextCheck.ok) {
        return failure(nextCheck.reason, `工作区记录没有通过校验：${nextCheck.message}`)
      }
      const current = workspaceRef.current
      if (current === null) {
        if (options.allowNewWorkspace !== true) {
          return failure('no_workspace', '当前没有关联工作区；这条记录不能直接安装。')
        }
        if (nextCheck.value.workspaceRevision !== 1) {
          return failure('invalid_revision', '新工作区记录的 revision 必须从 1 开始；未安装。')
        }
        clearUndo()
        applyRecord(nextCheck.value, 'in_memory', undefined, options.notify !== false)
        return ok()
      }
      if (capture === null) {
        return failure('stale', '缺少预览前的实际引用捕获；本次没有应用。')
      }
      if (!workspaceRuntimeRefsMatch(capture, current, epochRef.current)) {
        return failure('stale', '当前工作区对象或 epoch 已变化；本次没有应用，请重新操作。')
      }
      if (
        nextCheck.value.workspaceId !== current.workspaceId ||
        nextCheck.value.ownerId !== current.ownerId
      ) {
        return failure('owner_mismatch', '记录不属于当前工作区身份；本次没有应用。')
      }
      const revision = nextWorkspaceRevision(current.workspaceRevision)
      if (!revision.ok) return failure(revision.reason, revision.message)
      if (nextCheck.value.workspaceRevision !== revision.value) {
        return failure('invalid_revision', '新记录的 revision 必须是当前值 +1；本次没有应用。')
      }
      if (options.allowTripRebind !== true && nextCheck.value.tripId !== current.tripId) {
        return failure('invalid_trip', '记录更换了 trip.id；请使用显式的内部 fork 或新建工作区。')
      }
      clearUndo()
      applyRecord(nextCheck.value, 'in_memory', undefined, options.notify !== false)
      return ok()
    },
    [applyRecord, clearUndo],
  )

  const applyPatch = useCallback(
    (
      patch: WorkspacePatchInput,
      capture: WorkspaceRuntimeCaptureV1 | null,
      options: { readonly notify?: boolean } = {},
    ): WorkspaceActionResult => {
      const current = workspaceRef.current
      if (current === null) return failure('no_workspace', '当前没有关联工作区；本次没有应用。')
      if (capture === null) {
        return failure('stale', '缺少预览前的实际引用捕获；本次没有应用。')
      }
      if (!workspaceRuntimeRefsMatch(capture, current, epochRef.current)) {
        return failure('stale', '当前工作区对象或 epoch 已变化；本次没有应用，请重新操作。')
      }
      const transition = commitWorkspaceTransition(current, patch, nowRef.current())
      if (!transition.ok) {
        return failure(transition.reason, transition.message)
      }
      return adoptRecord(transition.value, capture, { notify: options.notify !== false })
    },
    [adoptRecord],
  )

  const applyTripFork = useCallback(
    (
      trip: Trip,
      budget: BudgetSnapshotV1 | null | undefined,
      capture: WorkspaceRuntimeCaptureV1 | null,
    ): WorkspaceTripChangeResult => {
      const current = workspaceRef.current
      if (current === null) return { ok: true, kind: 'unlinked' }
      if (trip.id === current.tripId) {
        const applied = applyPatch(
          { trip, ...(budget === undefined ? {} : { budget }) },
          capture,
        )
        return applied.ok
          ? { ok: true, kind: 'transitioned' }
          : { ok: false, reason: applied.reason ?? 'invalid_record', message: applied.message ?? '没有应用。' }
      }
      if (capture === null) {
        return { ok: false, reason: 'stale', message: '缺少预览前的实际引用捕获；本次没有应用。' }
      }
      if (!workspaceRuntimeRefsMatch(capture, current, epochRef.current)) {
        return {
          ok: false,
          reason: 'stale',
          message: '当前工作区对象或 epoch 已变化；这次行程副本未应用，请重新操作。',
        }
      }
      const revision = nextWorkspaceRevision(current.workspaceRevision)
      if (!revision.ok) {
        return { ok: false, reason: revision.reason, message: revision.message }
      }
      const next: WorkspaceRecordV1 = {
        ...current,
        tripId: trip.id,
        trip,
        sidecar: current.sidecar,
        budget: budget === undefined ? current.budget : budget,
        workspaceRevision: revision.value,
        updatedAt: nowRef.current(),
        meta: { ...current.meta },
      }
      const installed = adoptRecord(next, capture, {
        allowTripRebind: true,
        notify: true,
      })
      return installed.ok
        ? { ok: true, kind: 'forked' }
        : { ok: false, reason: installed.reason ?? 'invalid_record', message: installed.message ?? '没有应用。' }
    },
    [adoptRecord, applyPatch],
  )

  const saveWorkspace = useCallback(
    async (budget?: BudgetSnapshotV1 | null): Promise<WorkspaceActionResult> => {
      if (busyRef.current) return failure('busy', '另一个保存操作正在进行；本次没有写入。')
      const current = workspaceRef.current
      if (current === null) return failure('no_workspace', '当前没有关联工作区；没有写入。')
      const storage = resolveStorage()
      if (!storage) {
        setNotice({ tone: 'error', text: UNAVAILABLE_TEXT })
        return failure('unavailable', UNAVAILABLE_TEXT)
      }
      const locks = resolveLocks()
      if (locks === null) {
        if (mountedRef.current) setCanWrite(false)
        setNotice({ tone: 'error', text: READ_ONLY_TEXT })
        return failure('lock_unavailable', READ_ONLY_TEXT)
      }
      if (!mountedRef.current) return failure('unmounted', '组件已卸载；没有写入。')

      let recordToSave = current
      // 用户显式保存时可以把当前费用草稿的最新快照并入工作区；这是同一记录的一次 transition。
      if (budget !== undefined && !canonicalValuesEqual(current.budget, budget)) {
        const transition = commitWorkspaceTransition(current, { budget }, nowRef.current())
        if (!transition.ok) {
          setNotice({ tone: 'error', text: transition.message })
          return failure(transition.reason, transition.message)
        }
        recordToSave = transition.value
        // budget 已是 App 的当前输入；只更新工作区记录，不重复重置 App 的费用草稿。
        workspaceRef.current = recordToSave
        if (mountedRef.current) {
          setWorkspace(recordToSave)
          setWorkspaceStatus('in_memory')
        }
        advanceEpoch()
        clearUndo()
      }

      const expectedRaw = workspaceRawRef.current
      const expectedBaseCanonical = workspaceCanonicalRef.current
      busyRef.current = true
      if (mountedRef.current) setBusy(true)
      try {
        const result = await saveWorkspaceRecord(recordToSave, {
          storage,
          locks,
          expectedRaw,
          ...(expectedBaseCanonical === null
            ? {}
            : { expectedBaseCanonical }),
        })
        if (!mountedRef.current) {
          return result.ok ? ok() : failure(result.reason, result.message)
        }
        if (!result.ok) {
          setNotice({ tone: 'error', text: result.message })
          return failure(result.reason, result.message)
        }
        workspaceRawRef.current = result.raw
        workspaceCanonicalRef.current = canonicalOf(result.record)
        if (workspaceRef.current !== recordToSave) {
          // 保存期间又发生了新编辑：不能把旧返回对象当成当前记录，也不回退 revision。
          setNotice({
            tone: 'info',
            text: '本次内容已写入本地；但保存期间工作区又发生了变化，当前页面显示的新内容仍未保存。',
          })
          return ok()
        }
        workspaceRef.current = result.record
        setWorkspace(result.record)
        setWorkspaceStatus('saved')
        setWorkspaceMessage(null)
        setWorkspaceExternallyChanged(false)
        setNotice({
          tone: 'ok',
          text: `已保存工作区（revision ${result.record.workspaceRevision}）。只有这次 await 返回成功后页面才标记为已保存。`,
        })
        return ok()
      } finally {
        busyRef.current = false
        if (mountedRef.current) setBusy(false)
      }
    },
    [advanceEpoch, clearUndo, resolveLocks, resolveStorage],
  )

  const openVersions = useCallback((): WorkspaceActionResult => {
    const storage = resolveStorage()
    if (!storage) {
      versionsStatusRef.current = 'unavailable'
      versionsLoadedRef.current = true
      if (mountedRef.current) {
        setVersionsStatus('unavailable')
        setVersionsMessage(UNAVAILABLE_TEXT)
        setVersionsLoaded(true)
      }
      setNotice({ tone: 'error', text: UNAVAILABLE_TEXT })
      return failure('unavailable', UNAVAILABLE_TEXT)
    }
    const read = loadVersionsRecord(storage)
    versionsLoadedRef.current = true
    if (mountedRef.current) setVersionsLoaded(true)
    versionsRawRef.current = read.raw
    if (read.status === 'ok') {
      versionsRef.current = read.record
      versionsStatusRef.current = 'ok'
      if (mountedRef.current) {
        setVersions(read.record)
        setVersionsStatus('ok')
        setVersionsMessage(null)
        setVersionsExternallyChanged(false)
      }
      advanceEpoch()
      return ok()
    }
    if (read.status === 'empty') {
      versionsRef.current = null
      versionsStatusRef.current = 'empty'
      if (mountedRef.current) {
        setVersions(null)
        setVersionsStatus('empty')
        setVersionsMessage(null)
        setVersionsExternallyChanged(false)
      }
      advanceEpoch()
      return ok()
    }
    versionsRef.current = null
    versionsStatusRef.current = read.status
    if (mountedRef.current) {
      setVersions(null)
      setVersionsStatus(read.status)
      setVersionsMessage(read.message)
      setVersionsExternallyChanged(false)
    }
    setNotice({ tone: 'error', text: read.message })
    return failure(read.status, read.message)
  }, [advanceEpoch, resolveStorage])

  const saveVersion = useCallback(
    async (name: string): Promise<WorkspaceActionResult> => {
      if (busyRef.current) return failure('busy', '另一个保存操作正在进行；本次没有写入。')
      const current = workspaceRef.current
      if (current === null) {
        const message = '当前没有关联工作区，不能保存版本。'
        setNotice({ tone: 'error', text: message })
        return failure('no_workspace', message)
      }
      if (!versionsLoadedRef.current) {
        const message = '还没有读取版本库；请先打开版本库再保存版本。'
        setNotice({ tone: 'error', text: message })
        return failure('versions_not_loaded', message)
      }
      const versionsBase = versionsRef.current
      const capture = captureWorkspaceRuntime(current, epochRef.current)
      if (!capture.ok) {
        setNotice({ tone: 'error', text: capture.message })
        return failure(capture.reason, capture.message)
      }
      const now = nowRef.current()
      const snapshot = createVersionSnapshot({
        id: createLogicalId(),
        name,
        createdAt: now,
        workspaceRevision: current.workspaceRevision,
        trip: current.trip,
        sidecar: current.sidecar,
        budget: current.budget,
      })
      if (!snapshot.ok) {
        setNotice({ tone: 'error', text: snapshot.message })
        return failure(snapshot.reason, snapshot.message)
      }
      const added = addVersionSnapshot(versionsBase, snapshot.value, now)
      if (!added.ok) {
        setNotice({ tone: 'error', text: added.message })
        return failure(added.reason, added.message)
      }
      const plan = prepareVersionsLibraryWrite(added.value)
      if (!plan.ok) {
        setNotice({ tone: 'error', text: plan.message })
        return failure(plan.reason, plan.message)
      }
      const storage = resolveStorage()
      if (!storage) {
        setNotice({ tone: 'error', text: UNAVAILABLE_TEXT })
        return failure('unavailable', UNAVAILABLE_TEXT)
      }
      const locks = resolveLocks()
      if (locks === null) {
        if (mountedRef.current) setCanWrite(false)
        setNotice({ tone: 'error', text: READ_ONLY_TEXT })
        return failure('lock_unavailable', READ_ONLY_TEXT)
      }
      if (
        !workspaceRuntimeRefsMatch(capture.value, current, epochRef.current) ||
        versionsRef.current !== versionsBase
      ) {
        const message = '保存前当前工作区或版本库已变化；本次没有写入，请重新操作。'
        setNotice({ tone: 'error', text: message })
        return failure('stale', message)
      }

      busyRef.current = true
      if (mountedRef.current) setBusy(true)
      try {
        const result = await saveVersionsRecord(plan.value.record, {
          storage,
          locks,
          expectedRaw: versionsRawRef.current,
        })
        if (!mountedRef.current) {
          return result.ok ? ok() : failure(result.reason, result.message)
        }
        if (!result.ok) {
          setNotice({ tone: 'error', text: result.message })
          return failure(result.reason, result.message)
        }
        if (versionsRef.current !== versionsBase) {
          // 写入已发生，但内存版本库在等待期间被其它动作替换；不覆盖新状态，也不谎称列表已刷新。
          versionsRawRef.current = result.raw
          setNotice({
            tone: 'info',
            text: '版本库已写入，但等待期间列表发生了变化；请重新打开版本库确认，当前列表未被覆盖。',
          })
          return ok()
        }
        versionsRef.current = result.record
        versionsRawRef.current = result.raw
        versionsStatusRef.current = 'ok'
        setVersions(result.record)
        setVersionsStatus('ok')
        setVersionsMessage(null)
        setVersionsExternallyChanged(false)
        advanceEpoch()
        setNotice({
          tone: 'ok',
          text: `已保存版本《${name}》。保存的是点击时的 Trip、sidecar 与预算快照；工作区本身没有因此写入。`,
        })
        return ok()
      } finally {
        busyRef.current = false
        if (mountedRef.current) setBusy(false)
      }
    },
    [advanceEpoch, resolveLocks, resolveStorage],
  )

  /**
   * 确认导入版本库备份：F4 面板已做纯预览；这里再用统一 transfer 的
   * prepareVersionsImport 冻结旧 raw，confirmVersionsImport 在 Web Locks 内一次
   * setItem；await ok 才更新内存版本库。失败 typed（lock_unavailable / conflict /
   * 损坏 / 超限），原字节不变，并把 prepared 句柄取消（不静默重试）。
   * 成功后 epoch 推进（外部数据进入内存视图，旧采用预览 / 撤销全部失效）。
   */
  const importVersions = useCallback(
    async (preview: VersionsImportPreviewV1): Promise<WorkspaceActionResult> => {
      if (busyRef.current) return failure('busy', '另一个操作正在进行；本次没有导入。')
      const storage = resolveStorage()
      if (!storage) {
        setNotice({ tone: 'error', text: UNAVAILABLE_TEXT })
        return failure('unavailable', UNAVAILABLE_TEXT)
      }
      const locks = resolveLocks()
      if (locks === null) {
        if (mountedRef.current) setCanWrite(false)
        setNotice({ tone: 'error', text: READ_ONLY_TEXT })
        return failure('lock_unavailable', READ_ONLY_TEXT)
      }
      busyRef.current = true
      if (mountedRef.current) setBusy(true)
      try {
        const prepared = prepareVersionsImport(preview.text, { storage, locks })
        if (!prepared.ok) {
          setNotice({ tone: 'error', text: prepared.message })
          return failure(prepared.reason, prepared.message)
        }
        const confirmed = await confirmVersionsImport(prepared, {
          storage,
          locks,
          now: nowRef.current(),
          undoTtlMs: DEFAULT_UNDO_TTL_MS,
        })
        if (!confirmed.ok) {
          cancelPreparedImport({ importId: prepared.importId })
          setNotice({ tone: 'error', text: confirmed.message })
          return failure(confirmed.reason, confirmed.message)
        }
        versionsRef.current = confirmed.record
        versionsRawRef.current = confirmed.raw
        versionsStatusRef.current = 'ok'
        versionsImportUndoRef.current = confirmed.undo
        if (mountedRef.current) {
          setVersions(confirmed.record)
          setVersionsStatus('ok')
          setVersionsMessage(null)
          setVersionsExternallyChanged(false)
          setVersionsImportUndoExpiresAt(confirmed.undo.expiresAt)
        }
        advanceEpoch()
        setNotice({
          tone: 'ok',
          text: `版本库导入完成（${confirmed.record.items.length} 个版本）；在撤销窗口内可以撤销一次。原版本库字节在导入前已冻结，可整次回退。`,
        })
        return ok()
      } finally {
        busyRef.current = false
        if (mountedRef.current) setBusy(false)
      }
    },
    [advanceEpoch, resolveLocks, resolveStorage],
  )

  /** 撤销最近一次版本库导入：一次机会，锁内核对当前 raw 仍是导入写入值才回退。 */
  const undoVersionsImport = useCallback(async (): Promise<WorkspaceActionResult> => {
    const handle = versionsImportUndoRef.current
    if (handle === null) {
      return failure('nothing_to_undo', '没有可撤销的版本库导入。')
    }
    if (busyRef.current) return failure('busy', '另一个操作正在进行；本次没有撤销。')
    const storage = resolveStorage()
    if (!storage) {
      setNotice({ tone: 'error', text: UNAVAILABLE_TEXT })
      return failure('unavailable', UNAVAILABLE_TEXT)
    }
    const locks = resolveLocks()
    if (locks === null) {
      if (mountedRef.current) setCanWrite(false)
      setNotice({ tone: 'error', text: READ_ONLY_TEXT })
      return failure('lock_unavailable', READ_ONLY_TEXT)
    }
    busyRef.current = true
    if (mountedRef.current) setBusy(true)
    try {
      const undone = await undoImport(handle, { storage, locks, now: nowRef.current() })
      if (!undone.ok) {
        // 句柄一次性：已用过 / 过期就清掉；conflict 保留以便排查后重试
        if (undone.reason === 'undo_used' || undone.reason === 'undo_expired') {
          versionsImportUndoRef.current = null
          if (mountedRef.current) setVersionsImportUndoExpiresAt(null)
        }
        setNotice({ tone: 'error', text: undone.message })
        return failure(undone.reason, undone.message)
      }
      versionsImportUndoRef.current = null
      if (mountedRef.current) setVersionsImportUndoExpiresAt(null)
      // 回退后重新读自己的键刷新内存视图（不自动动其它库）
      const reloaded = loadVersionsRecord(storage)
      versionsRawRef.current = reloaded.raw
      versionsStatusRef.current =
        reloaded.status === 'ok' ? 'ok' : reloaded.status === 'empty' ? 'empty' : reloaded.status
      versionsRef.current = reloaded.status === 'ok' ? reloaded.record : null
      if (mountedRef.current) {
        setVersions(versionsRef.current)
        setVersionsStatus(versionsStatusRef.current)
        setVersionsMessage(
          reloaded.status === 'ok' || reloaded.status === 'empty' ? null : reloaded.message,
        )
        setVersionsExternallyChanged(false)
      }
      advanceEpoch()
      setNotice({ tone: 'ok', text: '已撤销最近一次版本库导入；原字节已恢复。' })
      return ok()
    } finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }, [advanceEpoch, resolveLocks, resolveStorage])

  const adoptVersion = useCallback(
    (proposal: VersionAdoptProposalV1): WorkspaceActionResult => {
      if (busyRef.current) return failure('busy', '另一个操作正在进行；本次没有采用。')
      const current = workspaceRef.current
      if (current === null) {
        const message = '当前没有关联工作区，不能采用版本。'
        setNotice({ tone: 'error', text: message })
        return failure('no_workspace', message)
      }
      if (!versionsLoadedRef.current) {
        const message = '版本库尚未读取；请重新打开版本库后再采用。'
        setNotice({ tone: 'error', text: message })
        return failure('versions_not_loaded', message)
      }
      const version = versionsRef.current?.items.find((item) => item.id === proposal.versionId) ?? null
      if (version === null) {
        const message = '该版本已不在当前版本库中；请重新预览，未采用任何内容。'
        setNotice({ tone: 'error', text: message })
        return failure('version_missing', message)
      }
      const capture = captureWorkspaceRuntime(current, epochRef.current, { version })
      if (!capture.ok) {
        setNotice({ tone: 'error', text: capture.message })
        return failure(capture.reason, capture.message)
      }
      if (
        !workspaceRuntimeRefsMatch(capture.value, current, epochRef.current, {
          version,
        })
      ) {
        const message = '采用前当前工作区对象或 epoch 已变化；请重新预览，未采用任何内容。'
        setNotice({ tone: 'error', text: message })
        return failure('stale', message)
      }
      const result = applyVersionAdoptProposal(
        current,
        proposal,
        { epoch: epochRef.current },
        nowRef.current(),
      )
      if (!result.ok) {
        setNotice({ tone: 'error', text: result.message })
        return failure(result.reason, result.message)
      }
      clearUndo()
      applyRecord(result.value.record, 'in_memory', result.value.invalidation.epoch)
      undoRef.current = result.value.undo
      if (mountedRef.current) setUndoProposal(result.value.undo)
      setNotice({
        tone: 'info',
        text: `已采用版本《${proposal.versionName}》：Trip、sidecar 与预算整体切换，revision 推进到 ${result.value.invalidation.workspaceRevision}，没有回放快照里的旧 revision。这一步只在内存中，点「保存工作区」才会写入本地。`,
      })
      return ok()
    },
    [applyRecord, clearUndo],
  )

  const undoAdopt = useCallback(
    (proposal?: VersionUndoProposalV1): WorkspaceActionResult => {
      if (busyRef.current) return failure('busy', '另一个操作正在进行；本次没有撤销。')
      const current = workspaceRef.current
      const stored = undoRef.current
      if (current === null || stored === null) {
        const message = '没有可撤销的版本采用。'
        setNotice({ tone: 'error', text: message })
        return failure('nothing_to_undo', message)
      }
      if (proposal !== undefined && proposal !== stored) {
        const message = '撤销提案已过期或不是当前保存的提案；未撤销任何内容。'
        setNotice({ tone: 'error', text: message })
        return failure('stale', message)
      }
      const capture = captureWorkspaceRuntime(current, epochRef.current)
      if (!capture.ok) {
        setNotice({ tone: 'error', text: capture.message })
        return failure(capture.reason, capture.message)
      }
      if (!workspaceRuntimeRefsMatch(capture.value, current, epochRef.current)) {
        const message = '撤销前当前工作区对象或 epoch 已变化；请重新查看当前状态。'
        setNotice({ tone: 'error', text: message })
        return failure('stale', message)
      }
      const result = applyVersionUndoProposal(
        current,
        stored,
        { epoch: epochRef.current },
        nowRef.current(),
      )
      if (!result.ok) {
        setNotice({ tone: 'error', text: result.message })
        return failure(result.reason, result.message)
      }
      clearUndo()
      applyRecord(result.value.record, 'in_memory', result.value.invalidation.epoch)
      setNotice({
        tone: 'info',
        text: `已整体撤销这次版本采用：Trip、sidecar 与预算一起恢复，revision 推进到 ${result.value.invalidation.workspaceRevision}（撤销也 +1）。这一步只在内存中，点「保存工作区」才会写入本地。`,
      })
      return ok()
    },
    [applyRecord, clearUndo],
  )

  const dismissNotice = useCallback(() => {
    setNotice(null)
  }, [])

  // 外部 storage 变化：只推进 epoch / 失效库代际 / 提示，不自动读取、不覆盖当前内存内容。
  useEffect(() => {
    const storage =
      storageOptionRef.current === undefined
        ? getWorkspaceLocalStorage()
        : storageOptionRef.current
    if (!storage) return
    const handler = (event: StorageEvent) => {
      if (event.storageArea !== null && event.storageArea !== storage) return
      const key = event.key
      if (
        key !== null &&
        key !== WORKSPACE_STORAGE_KEY &&
        key !== VERSIONS_STORAGE_KEY &&
        key !== CANDIDATES_STORAGE_KEY
      ) {
        return
      }
      // 三个库的任一观察事件（包括 clear / newValue===oldValue）都推进 App 运行期 epoch，
      // 并失效对应库的 generation：旧 prepared import / 旧预览不得在外部变化后复活。
      if (key === null) {
        invalidateLibraryGenerations(WORKSPACE_STORAGE_KEY)
        invalidateLibraryGenerations(VERSIONS_STORAGE_KEY)
        invalidateLibraryGenerations(CANDIDATES_STORAGE_KEY)
      } else {
        invalidateLibraryGenerations(key)
      }
      advanceEpoch()
      clearUndo()
      onExternalStorageChangeRef.current?.(key)
      if (key === null || key === WORKSPACE_STORAGE_KEY) {
        if (workspaceRef.current !== null) {
          setWorkspaceExternallyChanged(true)
          setNotice({
            tone: 'info',
            text: '另一处更新了本地工作区；当前页面没有自动覆盖或重新读取。需要最新内容时请重新打开工作区。',
          })
        }
      }
      if (key === null || key === VERSIONS_STORAGE_KEY) {
        if (versionsLoadedRef.current) {
          setVersionsExternallyChanged(true)
          setNotice({
            tone: 'info',
            text: '另一处更新了本地版本库；当前列表只读保留，不会自动覆盖。需要最新内容时请重新打开版本库。',
          })
        }
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [advanceEpoch, clearUndo])

  return {
    workspace,
    workspaceStatus,
    workspaceMessage,
    workspaceExternallyChanged,
    versions,
    versionsStatus,
    versionsMessage,
    versionsLoaded,
    versionsExternallyChanged,
    epoch,
    busy,
    canWrite,
    notice,
    undoProposal,
    versionsImportUndoExpiresAt,
    openWorkspace,
    createWorkspace,
    detach,
    applyTripChange,
    getRuntime,
    adoptRecord,
    applyPatch,
    applyTripFork,
    saveWorkspace,
    openVersions,
    saveVersion,
    importVersions,
    undoVersionsImport,
    adoptVersion,
    undoAdopt,
    dismissNotice,
  }
}

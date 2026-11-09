import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react'
import './app.css'
import IcsExportPanel from './components/IcsExportPanel'
import PlanForm from './components/PlanForm'
import ItineraryView from './components/ItineraryView'
import RouteFlowHint from './components/RouteFlowHint'
import ItineraryHealthCard from './components/ItineraryHealthCard'
import TodayPanel from './components/TodayPanel'
import { projectStopFacts } from './lib/stopFacts'
import { paceLabelOf, type HealthPace } from './lib/itineraryHealth'
import ShareCardPanel from './components/ShareCardPanel'
import SavedTripsPanel from './components/SavedTripsPanel'
import TripMap from './components/TripMap'
import TripTransferPanel from './components/TripTransferPanel'
import ThemeToggle from './components/ThemeToggle'
import TripDraftEditor from './components/TripDraftEditor'
import DayReplanPanel, {
  type DayReplanAdapter,
  type DayReplanLiveInputSnapshot,
} from './components/DayReplanPanel'
import AssistantDialogPanel, { type ReplanCandidateBase } from './components/AssistantDialogPanel'
import DayWeatherPanel from './components/DayWeatherPanel'
import DayPoiSourcesPanel from './components/DayPoiSourcesPanel'
import WebSourcesPanel from './components/WebSourcesPanel'
import MapRefreshPanel from './components/MapRefreshPanel'
import TripBudgetPanel from './components/TripBudgetPanel'
import WorkspaceHub from './components/WorkspaceHub'
import AnchorsPanel from './components/AnchorsPanel'
import ConstraintsPanel, {
  type ConstraintsPanelApplyRequest,
} from './components/ConstraintsPanel'
import ChecklistPanel, {
  type ChecklistChangeHandler,
} from './components/ChecklistPanel'
import CandidatePoolPanel, {
  type CandidatePoolSaveStatus,
  type CandidatePoolStorageStatus,
} from './components/CandidatePoolPanel'
import PoiCardPanel from './components/PoiCardPanel'
import PoiCardBackupPanel from './components/PoiCardBackupPanel'
import type { PoiCardPrefill } from './lib/poiCardPrefill'
import {
  createEmptyPoiCardsRecord,
  findPoiCardByName,
  loadPoiCardsRecord,
  savePoiCardsRecord,
  type PoiCardsRecordV1,
  type PoiCardsSaveResult,
} from './lib/poiCards'
import OfflineTripPanel from './components/OfflineTripPanel'
import { emptyBudgetSession, tripOwnerSnapshot, type BudgetSessionState } from './lib/tripBudget'
import { useWorkspaceController } from './lib/useWorkspaceController'
import { canonicalValuesEqual, fingerprintOf, fingerprintsMatch } from './lib/workspaceFingerprint'
import type { VersionsBackupPreviewV1 } from './lib/versionSnapshots'
import {
  CANDIDATES_STORAGE_KEY,
  type BudgetSnapshotV1,
  type CandidatesRecordV1,
  type ChecklistV1,
  type ConstraintsV1,
  type PlanScopeV1,
  type WorkspaceRecordV1,
} from './lib/workspaceTypes'
import { applyAnchorsProposal, type AnchorsProposal } from './lib/anchors'
import {
  checkConstraintsApply,
  evaluateConstraintsAgainstTrip,
} from './lib/constraints'
import {
  createConstraintsBinding,
  type WorkspaceRuntimeCaptureV1,
} from './lib/workspace'
import {
  cancelPreparedImport,
  confirmCandidatesImport,
  invalidatePreparedImport,
  prepareCandidatesImport,
  type PreparedCandidatesImport,
} from './lib/workspaceTransfer'
import {
  DEFAULT_UNDO_TTL_MS,
  getLibraryGeneration,
  getWorkspaceLockManager,
  loadCandidatesRecord,
  saveCandidatesRecord,
  undoImport,
  type StorageUndoHandle,
} from './lib/workspaceStorage'
import {
  createCandidatesBackup,
  createEmptyCandidateRecord,
  type CandidateDraftProposal,
  type CandidateStopSource,
} from './lib/candidatePool'
import {
  confirmSessionWorkspaceRestore,
  prepareSessionWorkspaceRestore,
} from './lib/workspaceSessionRestore'
import { ApiError, fetchExampleTrip, planTrip, probeBackendCapabilities } from './lib/api'
import { Button } from '@/components/ui/button'
import { createTripDraft, type DraftApplySuccess, type TripDraft } from './lib/tripDraft'
import {
  MAX_REPLAN_WARNINGS,
  applyDayReplan,
  type DayReplanApplyResult,
  type DayReplanRequest,
  type DayReplanResponse,
} from './lib/dayReplan'
import {
  applyDayReplanTail,
  type DayReplanTailApplyResult,
  type DayReplanTailScope,
  type TailBoundaryCurrent,
  type TailBoundarySelection,
} from './lib/dayReplanTail'
import { replanDay } from './lib/dayReplanApi'
import type { DayReplanConstraintsOptions } from './lib/planningConstraintsApi'
import {
  applyMapRefresh,
  type MapRefreshApplyResult,
  type MapRefreshRequest,
  type MapRefreshResponse,
} from './lib/mapRefresh'
import { formatDateTime } from './lib/format'
import SessionResumePanel from './components/SessionResumePanel'
import {
  SESSION_RESUME_DATA_KEY,
  getLocalStorageSafe,
  isSessionResumeEnabled,
  loadSessionResumeRecord,
  removeSessionResumeData,
  setSessionResumeFlag,
  writeSessionResume,
  buildPayloadFromSession,
  previewSessionResume,
  SESSION_RESUME_FLAG_KEY,
  type SessionResumeLoad,
} from './lib/sessionRestore'
import type { StorageLike } from './lib/savedTrips'
import type { AmapAvailability, BackendCapabilities, PlanRequest, PlannerAvailability, ProbeFailure, TravelMode, Trip } from './lib/api'

/** 站点 id / fork 行程 id 都由页面用 UUID 生成；无 crypto.randomUUID 的环境退回随机串 */
function newUuid(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

/**
 * 版本库备份下载：面板已经生成过预览，这里只把同一份 preview.text 写成文件，
 * 不重新生成、不改动内容；下载动作本身不触碰任何存储键。
 */
function downloadVersionsBackup(preview: VersionsBackupPreviewV1): void {
  const blob = new Blob([preview.text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `travel-assistant-versions-${new Date(preview.backup.exportedAt).toISOString().slice(0, 10)}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** 当前费用草稿 → 工作区 / 版本快照；只复制用户原输入，不保存派生合计。 */
function budgetSnapshotOfSession(session: BudgetSessionState): BudgetSnapshotV1 {
  return {
    budgetRaw: session.budgetRaw,
    rows: session.rows.map((row) => ({
      id: row.id,
      category: row.category,
      name: row.name,
      amountRaw: row.amountRaw,
    })),
  }
}

/**
 * AI day / day_tail 请求只携带当前 scope 可验证的约束：全局（day=null）+ 目标日，
 * 且 stopId 必须存在于目标日。其它天的约束仍完整保存在 sidecar，不丢、不改。
 */
function scopedConstraintsForDay(
  record: WorkspaceRecordV1,
  dayNumber: number,
): ConstraintsV1 {
  const day = record.trip.days.find((item) => item.day === dayNumber)
  const stopIds = new Set(day?.stops.map((stop) => stop.id) ?? [])
  return {
    items: record.sidecar.constraints.items.filter(
      (item) =>
        (item.day === null || item.day === dayNumber) &&
        (item.stopId === null || stopIds.has(item.stopId)),
    ),
  }
}

/** 留存用：当前 Trip 的内容快照；序列化失败返回 null（调用方停写） */
function tripOwnerSnapshotForResume(trip: Trip): string | null {
  const result = tripOwnerSnapshot(trip)
  return result.ok ? result.value : null
}

/** 异常安全的数据键读取；读取失败返回 null（不代表存储为空，仅冻结基准） */
function readDataRawSafe(storage: StorageLike | null): string | null {
  if (!storage) return null
  try {
    return storage.getItem(SESSION_RESUME_DATA_KEY)
  } catch {
    return null
  }
}

/** 恢复动作前的严格读取：读取异常不能被当成“存储为空”而放过 CAS 比对 */
function readDataRawForAction(
  storage: StorageLike | null,
): { ok: true; raw: string | null } | { ok: false } {
  if (!storage) return { ok: false }
  try {
    return { ok: true, raw: storage.getItem(SESSION_RESUME_DATA_KEY) }
  } catch {
    return { ok: false }
  }
}

type LoadPhase = 'initial' | 'loading' | 'ready' | 'failed'

/**
 * 请求结果的归属说明：只描述「当前展示的行程对应哪次请求」，
 * 是当前视图的临时状态，不写进 Trip、不进本地保存/备份。
 */
type RequestOutcome =
  | { kind: 'none' }
  /** 有一次规划请求在飞：下方是上次结果，新行程正在生成 */
  | { kind: 'pending'; destination: string }
  /** 最近一次规划失败（含超时/网络/5xx）：本次没有生成新行程 */
  | { kind: 'failed'; destination: string }
  /** 用户停止等待：这次结果没有等到，下方仍是上次结果 */
  | { kind: 'stopped'; destination: string }

/** 失败结论是谁给的。探活失败和业务请求失败必须分开说，不能互相冒充。 */
type FailureSource = 'probe' | 'request'

/** 后端探活结论。可达（reachable）与能规划（planner）分开记，不能互相替代。 */
interface BackendState {
  /** 完成过一次探活或拿到过业务结论 */
  checked: boolean
  /** 后端是可用的健康服务 */
  reachable: boolean
  /** 只有 health 明确表态才不是 unknown；unknown 不等于不可用 */
  planner: PlannerAvailability
  /** 失败分级；可达时为 null */
  failure: ProbeFailure | null
  /** 这条失败结论来自探活还是业务请求——决定文案怎么说，不能混 */
  failureSource: FailureSource | null
  /** 有探活在飞 */
  probing: boolean
  /** 当前后端服务是否配置了地图 Key；只有 health 明确表态才不是 unknown */
  amap: AmapAvailability
}

const BACKEND_INITIAL: BackendState = {
  checked: false,
  reachable: false,
  planner: 'unknown',
  failure: null,
  failureSource: null,
  probing: true,
  amap: 'unknown',
}

/** 探活失败时的固定提示：不复述后端 warnings，避免把绝对路径、密钥这类内容带进页面 */
const PROBE_FAILURE_HINT: Record<ProbeFailure, string> = {
  timeout: '健康检查超时没有回应。请确认后端已启动，或检查 Vite 的 /api 代理是否指向了正确的地址。',
  network: '健康检查请求没能送达后端。请确认后端已启动，或检查 Vite 的 /api 代理设置。',
  http: '健康检查返回了错误状态码。请确认 /api/health 确实被代理到后端，而不是静态服务器。',
  bad_payload: '健康检查没有返回约定的 JSON。/api 可能被 SPA fallback 或静态服务器接管了。',
}

/**
 * 业务请求失败时的固定提示：只承认「这一次调用没成」，
 * 不用健康检查的口径描述业务错误，也不复述后端返回的原文。
 */
const REQUEST_FAILURE_HINT =
  '这次失败来自业务请求，不是健康检查：它只说明这一次调用没拿到结果。点「重新检测」可以按健康检查重新确认后端状态。'

/** 头部失败原因提示的固定 id，供「重新检测」按钮 aria-describedby 引用 */
const BACKEND_HINT_ID = 'backend-hint'

/** 有业务请求成功就说明后端在线：health 只是辅助信号，不能推翻实际成功的数据请求 */
function markReachable(prev: BackendState): BackendState {
  return { ...prev, checked: true, reachable: true, failure: null, failureSource: null }
}

/**
 * 探活结论落到界面状态。业务请求在探活发出之后成功过（provenLater），
 * 就不接受这次「不可达」的迟到判定——常见于代理慢、探活超时这类误判。
 */
function mergeProbe(prev: BackendState, caps: BackendCapabilities, provenLater: boolean): BackendState {
  if (provenLater && !caps.reachable) return { ...markReachable(prev), probing: false }
  return {
    checked: true,
    reachable: caps.reachable,
    planner: caps.reachable ? caps.planner : 'unknown',
    failure: caps.failure,
    failureSource: caps.failure ? 'probe' : null,
    probing: false,
    amap: caps.reachable ? caps.amap : 'unknown',
  }
}

/**
 * 业务请求失败只降级「可达」，不动已经落地的规划能力结论：
 * planner_ready=false 是健康检查给出的能力判定，不该被一次无关的业务失败抹掉。
 */
function mergeRequestFailure(prev: BackendState, failure: ProbeFailure): BackendState {
  return { ...prev, checked: true, reachable: false, failure, failureSource: 'request' }
}

/** 业务失败里能说明「后端连接有问题」的只有传输层两种；结构错误不该升级成后端不可达 */
function requestFailureOf(err: unknown): ProbeFailure | null {
  if (!(err instanceof ApiError)) return null
  if (err.kind === 'timeout') return 'timeout'
  if (err.kind === 'network') return 'network'
  return null
}

function errorText(err: unknown): { title: string; detail: string } {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case 'network':
        return {
          title: '连不上后端服务',
          detail: '请确认后端已启动，并且 Vite 的 /api 代理（或 VITE_API_BASE 指向的地址）能访问到它。改好后刷新页面再试。',
        }
      case 'server':
        if (err.upstreamUnavailable) {
          // 后端没起 / 代理目标不可达时，开发服务器会回 500 text/plain，不是业务错误
          return {
            title: '连不上后端服务',
            detail: `开发服务器转发 /api 请求时没拿到后端响应（HTTP ${err.status ?? 500}）。请确认后端已启动、代理目标可达；若后端在别的地址，用 VITE_API_BASE 指定后重启 Vite。`,
          }
        }
        return {
          title: '后端处理失败',
          detail: err.detail ? `后端返回：${err.detail}` : `HTTP ${err.status ?? ''}，请稍后重试或查看后端日志。`,
        }
      case 'bad_payload':
        return {
          title: '数据格式不符合约定',
          detail: '后端返回的行程结构与前端契约不一致，请检查后端版本是否已更新（/api/trips）。',
        }
      case 'abort':
        return { title: '请求已取消', detail: '可以重新点击「生成行程」再试一次。' }
    }
  }
  return { title: '出错了', detail: err instanceof Error ? err.message : String(err) }
}

export default function App() {
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [trip, setTrip] = useState<Trip | null>(null)
  const [error, setError] = useState<{ title: string; detail: string } | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planCancelled, setPlanCancelled] = useState(false)
  /**
   * 当前行程相对最近一次规划请求的归属：pending/failed/stopped 都属于
   * 「这次请求」而不是 trip 本身，成功、恢复、导入时清空。
   */
  const [requestOutcome, setRequestOutcome] = useState<RequestOutcome>({ kind: 'none' })
  const [backend, setBackend] = useState<BackendState>(BACKEND_INITIAL)
  const [activeDay, setActiveDay] = useState(1)
  const [activeStopId, setActiveStopId] = useState<string | null>(null)
  /**
   * 最近一次规划用的节奏档位（S3）：null = 本页行程不是 pace 请求生成的
   * （示例 / 恢复 / 文件导入），结果页不显示节奏标注。
   */
  const [lastPlannedPace, setLastPlannedPace] = useState<HealthPace | null>(null)
  const [restoredAt, setRestoredAt] = useState<number | null>(null)
  /**
   * 当前行程是不是从用户选择的备份文件打开进来的。
   * 只用来加一句来源说明：文件里的 source 字段不能证明真实来源，
   * 也不能拿它当「本地保存恢复」来展示时间戳。
   */
  const [openedFromFile, setOpenedFromFile] = useState<boolean | null>(false)
  /** 备份 / 导入面板是否展开；默认收起，展开后才挂载面板 */
  const [transferOpen, setTransferOpen] = useState(false)
  /** 本日天气面板是否展开；收起后不挂载，未查询不请求 */
  const [weatherOpen, setWeatherOpen] = useState(false)
  /** 本日公开资料面板是否展开；收起后不挂载，未查询不请求 */
  const [poiSourcesOpen, setPoiSourcesOpen] = useState(false)
  /**
   * 本日公开资料面板「显式收起」标记：只有用户在面板里点了「收起」才置位，
   * 据此在入口重新挂载后把键盘焦点送回「查资料」按钮。编辑/AI/地图面板打开
   * 的隐式收起不置位——那不是用户在面板里的操作，不抢走当前焦点。
   */
  const poiSourcesExplicitCloseRef = useRef(false)
  const poiSourcesEntryRef = useRef<HTMLDivElement | null>(null)
  /**
   * 网页资料面板（Tavily 搜索摘要）是否展开；收起后不挂载，未查询不请求。
   * 结果只存面板内存：不写 Trip／费用／恢复副本，与「本日公开资料」互不替代。
   */
  const [webSourcesOpen, setWebSourcesOpen] = useState(false)
  /**
   * 网页资料面板「显式收起」标记：只有用户在面板里点了「收起」才置位，
   * 据此在入口重新挂载后把键盘焦点送回「查网页资料」按钮。编辑/AI/地图打开
   * 的隐式收起不置位——那不是用户在面板里的操作，不抢走当前焦点。
   */
  const webSourcesExplicitCloseRef = useRef(false)
  const webSourcesEntryRef = useRef<HTMLDivElement | null>(null)
  const transferBodyId = useId()
  const abortRef = useRef<AbortController | null>(null)
  const exampleAbortRef = useRef<AbortController | null>(null)
  /** 行程归属序号：恢复 / 规划成功都会 +1，迟到的示例响应据此丢弃 */
  const loadSeqRef = useRef(0)
  const planSeqRef = useRef(0)
  /** 探活归属序号：重新检测 / 规划成功都会 +1，迟到的探活结论据此丢弃 */
  const probeSeqRef = useRef(0)
  const probeControllerRef = useRef<AbortController | null>(null)
  /**
   * 后端结论版本号：探活得出一致结论、业务请求成功、业务失败被采纳，都会 +1。
   * 业务请求在发起时记下版本，失败回来时版本变了就说明其间已有更新的结论，这次失败不许覆盖它。
   */
  const backendConclusionSeqRef = useRef(0)
  /** 业务请求成功次数：探活发出后拿到过真实数据，就不再采信这次探活的失败结论 */
  const businessProofRef = useRef(0)
  const itineraryTopRef = useRef<HTMLDivElement | null>(null)
  const tripTitleRef = useRef<HTMLHeadingElement | null>(null)

  /* ───────── 本地编辑（内存草稿）状态 ───────── */

  /**
   * 正在编辑的本地草稿；null 表示当前没有打开编辑器。
   * 草稿只存在于内存：不写 localStorage、不发请求；「应用」后才成为当前行程。
   */
  const [draft, setDraft] = useState<TripDraft | null>(null)
  /** 新建相邻路段的出行方式，进入编辑前由用户显式选择，不猜、不混用 */
  const [draftMode, setDraftMode] = useState<TravelMode>('walking')
  /** 编辑草稿时出错的提示（创建草稿失败等），只在编辑区显示 */
  const [draftError, setDraftError] = useState<string | null>(null)
  /** 编辑器里打开了单站表单：父级据此暂停日切换等外部替换（回调同步，渲染值不直接参与布局） */
  const [, setEditorEditing] = useState(false)
  /** 单站表单里有未提交输入：日切换被明确挡住，避免输入被切换带走 */
  const [editorInputDirty, setEditorInputDirty] = useState(false)
  /** 应用草稿成功后的页面内提示；含撤销应用入口 */
  const [appliedNotice, setAppliedNotice] = useState<string | null>(null)
  /** 应用前的行程快照，供「撤销应用」恢复一次；只保留最近一次 */
  const undoApplyRef = useRef<Trip | null>(null)
  /** 「撤销应用」是否可用（快照存在且当前行程仍是应用产物） */
  const [canUndoApply, setCanUndoApply] = useState(false)

  /* ───────── F1 / F2 / F3 / F5 / F6 行程工具状态 ───────── */

  const [anchorsOpen, setAnchorsOpen] = useState(false)
  const [constraintsOpen, setConstraintsOpen] = useState(false)
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [candidatePoolOpen, setCandidatePoolOpen] = useState(false)
  /** 资料卡备份与恢复面板：独立键，不依赖工作区关联。 */
  const [poiCardBackupOpen, setPoiCardBackupOpen] = useState(false)

  /** 候选库独立键：只在显式打开 / 保存 / 导入 / 导出时读写，不挂到工作区记录。 */
  const [candidatesRecord, setCandidatesRecord] = useState<CandidatesRecordV1 | null>(null)
  const [candidatesStorageStatus, setCandidatesStorageStatus] =
    useState<CandidatePoolStorageStatus>('loading')
  const [candidatesStorageMessage, setCandidatesStorageMessage] = useState<string | null>(null)
  const [candidatesStorageRevision, setCandidatesStorageRevision] = useState<string | null>(null)
  const [candidatesSaveStatus, setCandidatesSaveStatus] = useState<CandidatePoolSaveStatus>('idle')
  const [candidatesSaveMessage, setCandidatesSaveMessage] = useState<string | null>(null)
  const [candidatesImportPreview, setCandidatesImportPreview] = useState<{
    readonly prepared: PreparedCandidatesImport
    readonly itemCount: number
    readonly fileName: string
  } | null>(null)
  const [candidatesImportMessage, setCandidatesImportMessage] = useState<string | null>(null)
  const [candidatesImportBusy, setCandidatesImportBusy] = useState(false)
  const [candidatesUndo, setCandidatesUndo] = useState<StorageUndoHandle | null>(null)
  const candidatesRawRef = useRef<string | null>(null)
  const candidatesPreparedRef = useRef<PreparedCandidatesImport | null>(null)
  const candidatesActionSeqRef = useRef(0)
  const candidatesFileInputRef = useRef<HTMLInputElement | null>(null)

  /* ───────── P · 景点资料卡（poiCards:v1 独立键；显式保存才写） ───────── */

  /** 资料卡库记录：只在显式打开资料卡面板 / 显式保存时读写，绝不自动写。 */
  const [poiCardsRecord, setPoiCardsRecord] = useState<PoiCardsRecordV1 | null>(null)
  /** 资料卡面板打开态；null = 关闭。值 = 正在查看 / 新建的卡 id（null id = 新建）。 */
  const [poiCardOpenId, setPoiCardOpenId] = useState<string | null | undefined>(undefined)
  /**
   * S3 收进管道：来源面板「收进」构造的预填载荷；null = 没有收进进行中。
   * 只有用户点「收进资料卡」才会设置；不采纳 / 关闭清空，零写入。
   * 收进复用 PoiCardPanel 编辑通道（新建态 + prefill）；保存走同一 handleSavePoiCards。
   */
  const [poiCardCollectPrefill, setPoiCardCollectPrefill] = useState<PoiCardPrefill | null>(null)
  const [poiCardsSaveStatus, setPoiCardsSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [poiCardsSaveMessage, setPoiCardsSaveMessage] = useState<string | null>(null)
  const poiCardsRawRef = useRef<string | null>(null)
  const poiCardsReadRef = useRef(false)
  /** poiCardsRecord 的同步引用：收进打开预填表单时从事件路径读最新记录 */
  const poiCardsRecordRef = useRef<PoiCardsRecordV1 | null>(null)
  poiCardsRecordRef.current = poiCardsRecord

  /**
   * 显式重新读取资料卡库（只读，零写入）：同步冻结 raw 与 record。
   * 空存储 → 合法空记录；corrupt / unknown_version / unavailable → null。
   * 打开备份面板时调用一次（显式打开 = 读取最新），冲突后也由用户显式调用。
   * 空白串按 empty 口径把冻结 raw 归一到 null，与 savePoiCardsRecord 的比对口径一致。
   */
  const reloadPoiCards = useCallback(() => {
    const read = loadPoiCardsRecord(storageRef.current ?? undefined)
    const nextRaw = read.status === 'empty' ? null : read.raw
    // 只有真正读到了本地库才允许短路；unavailable 的 raw 也是 null，
    // 不能当成「已加载的空库」，否则存储恢复后打开面板仍会误报不可用。
    const loaded = read.status !== 'unavailable'
    // raw 未变且已加载：不重建 record 引用。PoiCardPanel 的 useEffect 依赖
    // record；即使内容相同，新引用也会重置同屏未保存的表单编辑。
    if (loaded && poiCardsReadRef.current && nextRaw === poiCardsRawRef.current) return
    poiCardsReadRef.current = loaded
    poiCardsRawRef.current = nextRaw
    if (read.status === 'empty') {
      const empty = createEmptyPoiCardsRecord(Date.now())
      setPoiCardsRecord(empty.ok ? empty.value : null)
      return
    }
    setPoiCardsRecord(read.record)
  }, [])

  /**
   * 读取资料卡库（只读）：资料卡是展示位的辅助信息，跟随一次页面加载读取；
   * 读取失败 / corrupt 时保持 null，界面只少一个展示位，不阻断行程。
   * 空存储按「空库」处理（新建空记录）：收进 / 手动新建都从合法空库开始，
   * 不是假装有数据——存储里确实什么都没有。本函数从不写任何键。
   */
  const ensurePoiCardsLoaded = useCallback(() => {
    if (poiCardsReadRef.current) return
    reloadPoiCards()
  }, [reloadPoiCards])

  /**
   * 显式保存：把面板给的整条记录写入 poiCards:v1；失败时原字节不动。
   * 返回本次结果：资料卡编辑面板继续用共享保存状态；备份面板只按本次返回值
   * 显示导入成功 / 失败，避免把别处的 saved / error 误报成导入结果。
   */
  const handleSavePoiCards = useCallback(
    async (record: PoiCardsRecordV1): Promise<PoiCardsSaveResult> => {
      const storage = storageRef.current
      setPoiCardsSaveStatus('saving')
      setPoiCardsSaveMessage(null)
      let result: PoiCardsSaveResult
      try {
        result = await savePoiCardsRecord(record, {
          storage: storage ?? undefined,
          expectedRaw: poiCardsRawRef.current,
        })
      } catch {
        result = {
          ok: false,
          reason: 'unknown',
          message: '写入资料卡库失败；已有数据保持原样，请重试。',
        }
      }
      if (!result.ok) {
        setPoiCardsSaveStatus('error')
        setPoiCardsSaveMessage(result.message)
        return result
      }
      poiCardsRawRef.current = result.raw
      setPoiCardsRecord(result.record)
      setPoiCardsSaveStatus('saved')
      setPoiCardsSaveMessage(`已保存资料卡（${result.record.cards.length} 张，${result.bytes} 字节）。`)
      return result
    },
    [],
  )

  /**
   * S3 收进：来源面板「收进资料卡」→ 打开预填表单（PoiCardPanel 新建态 + prefill）。
   * 按名称归一化定位已有卡：唯一命中 → 打开编辑态补空字段（已有字段不覆盖，
   * 由用户在表单里核对合并）；0 / 多命中 → 新建预填表单（不猜）。
   * 本函数只设置内存态，零写入；用户在预填表单里显式保存才落盘。
   */
  const handleCollectPoiCard = useCallback(
    (prefill: PoiCardPrefill) => {
      ensurePoiCardsLoaded()
      setPoiCardCollectPrefill(prefill)
      setPoiCardsSaveStatus('idle')
      setPoiCardsSaveMessage(null)
      // 唯一命中已有卡 → 编辑态补空字段；否则新建预填态（两种都进同一确认流）。
      const read = poiCardsReadRef.current ? poiCardsRecordRef.current : null
      const match =
        read === null || prefill.name.trim().length === 0 ? null : findPoiCardByName(read, prefill.name)
      setPoiCardOpenId(match === null ? null : match.id)
    },
    [ensurePoiCardsLoaded],
  )

  /** 不采纳收进：丢弃预填与未保存编辑，关闭面板，零写入（面板 onClose 内联完成）。 */

  /**
   * S2 信息可信卡：停点展示位「去资料卡补充」入口 → 打开资料卡面板新建态。
   * 预填停点名（PoiCardPrefill 不带来源 provenance：入口本身没有来源，
   * 用户在面板里自己填写 / 保存，保存路径按 manual 标 provenance，不编造来源）。
   * 本函数只设置内存态，零写入；不自动抓取、不发请求。
   */
  const handleStopFactSupplement = useCallback((stopName: string) => {
    ensurePoiCardsLoaded()
    const name = stopName.trim()
    setPoiCardCollectPrefill(
      name.length === 0 ? null : { name, collectNotice: '从停点展示位进入：名称已预填，内容与来源请自行补充；保存前不写入本地。' },
    )
    setPoiCardsSaveStatus('idle')
    setPoiCardsSaveMessage(null)
    setPoiCardOpenId(null)
  }, [ensurePoiCardsLoaded])

  /** AI 候选的 U 级独立确认：存在时面板旁显示显式确认入口；H 级永不进入这里。 */
  const [aiPlanningAck, setAiPlanningAck] = useState<{
    readonly applied: Extract<DayReplanApplyResult, { ok: true }> | Extract<DayReplanTailApplyResult, { ok: true }>
    readonly request: DayReplanRequest
    readonly response: DayReplanResponse
    readonly tailScope?: DayReplanTailScope
    readonly boundary?: TailBoundarySelection
    readonly boundaryCurrent?: TailBoundaryCurrent
    readonly latestTrip: Trip
    readonly record: WorkspaceRecordV1 | null
    readonly capture: WorkspaceRuntimeCaptureV1 | null
    readonly epoch: number
    readonly revision: number
    /** U 确认挂起时面板的实时输入快照（内容 / 输入代际）；确认时逐字段复验。 */
    readonly live: DayReplanLiveInputSnapshot | null
    readonly message: string
  } | null>(null)
  /** 面板实时输入快照：由 DayReplanPanel 每次渲染写入；U 确认的同步 final guard 依据。 */
  const aiPlanningLiveRef = useRef<DayReplanLiveInputSnapshot | null>(null)

  /** 本地编辑 / AI / 地图应用前捕获的实际工作区引用；应用时不得现捕获自证。 */
  const draftWorkspaceCaptureRef = useRef<WorkspaceRuntimeCaptureV1 | null>(null)
  const aiWorkspaceCaptureRef = useRef<WorkspaceRuntimeCaptureV1 | null>(null)
  const aiPlanningEpochRef = useRef(0)
  const mapWorkspaceCaptureRef = useRef<WorkspaceRuntimeCaptureV1 | null>(null)

  /**
   * F5 清单审计的「上一次已应用的约束快照」（ChecklistPanel `previousConstraints`）：
   * - 必须是同 ID 约束被修改**之前**的真实值，并在后续无关 render / transition 里保持，
   *   直到用户对相应条目显式确认重新关联；传当前值会让 `constraint_changed` 恒不触发。
   * - `constraintsBaselineRef` 记录最近一次安装的约束内容；任何安装看到内容变化时，
   *   把旧 baseline 冻结为 previous。恢复 / 打开 / 新建 / 解绑都走这里，不在 effect 里改。
   * - 初始 / reload 为 null：null 与当前比较不产生任何 needsRelink 误报，也不把
   *   legacy / `constraintId: null` 当损坏（这些由面板现有 unrecorded 提示处理）。
   */
  const [checklistPreviousConstraints, setChecklistPreviousConstraints] =
    useState<ConstraintsV1 | null>(null)
  const constraintsBaselineRef = useRef<ConstraintsV1 | null>(null)
  /**
   * 页面行程版本号：所有会替换当前行程的入口（示例、规划成功、恢复、导入、
   * 本地应用、AI 候选应用、撤销应用）都会 +1。ref 同步可读，供事件处理器在
   * 调用 applyDayReplan 时核对最新版本；state 同时传给 AI 面板，行程被外部
   * 替换后旧候选立即失效。
   */
  const tripRevisionRef = useRef(0)
  const [tripRevision, setTripRevision] = useState(0)
  const bumpTripRevision = useCallback(() => {
    tripRevisionRef.current += 1
    setTripRevision(tripRevisionRef.current)
  }, [])

  /** 最新行程的同步引用：AI 候选应用必须以当前页面为准，不能读闭包里的旧值 */
  const tripRef = useRef<Trip | null>(null)
  tripRef.current = trip
  /** 留存写入用的同步引用（声明在下方状态之后统一赋值）：persistSessionResume 从事件路径读最新值 */
  const draftRef = useRef<TripDraft | null>(null)
  const budgetRef = useRef<BudgetSessionState>(emptyBudgetSession())
  const activeDayRef = useRef(1)
  const draftModeRef = useRef<TravelMode>('walking')

  /* ───────── 费用估算（手动 CNY，内存草稿）状态 ───────── */

  /**
   * 费用草稿 session：归 App 层所有，面板只是受控视图。
   * 关闭面板或临时打开地图 / AI / 编辑导致子组件卸载时，金额输入仍在这里，不丢钱数。
   * 不写 Storage、不发请求；刷新页面会丢失，界面有固定说明。
   */
  const [budgetSession, setBudgetSession] = useState<BudgetSessionState>(emptyBudgetSession)
  /** 留存写入用的同步引用：persistSessionResume 从事件路径读最新草稿/费用/界面状态 */
  draftRef.current = draft
  budgetRef.current = budgetSession
  activeDayRef.current = activeDay
  draftModeRef.current = draftMode
  /** 费用估算面板是否展开；默认收起，收起不清草稿 */
  const [budgetOpen, setBudgetOpen] = useState(false)
  /** 分享卡片面板是否展开（四期 S4）；只读预览，不写任何存储 */
  const [shareOpen, setShareOpen] = useState(false)
  /** 显式收起费用面板的标记：置位后焦点回「费用估算」入口按钮；隐式隐藏不置位不抢焦点 */
  const budgetExplicitCloseRef = useRef(false)
  const budgetEntryRef = useRef<HTMLDivElement | null>(null)

  /** 面板内点「收起」：标记显式收起，让焦点回到入口；其余行为不变 */
  const handleBudgetClose = useCallback(() => {
    budgetExplicitCloseRef.current = true
    setBudgetOpen(false)
  }, [])

  /**
   * 显式收起本日资料面板后，把键盘焦点送回重新挂载的「查资料」入口按钮。
   * 只在显式收起标记置位时执行一次并清除标记；隐式收起（编辑/AI/地图打开）
   * 不置位也不抢焦点，不改变旧天气面板与全局焦点行为。
   */
  useEffect(() => {
    if (poiSourcesOpen) return
    if (!poiSourcesExplicitCloseRef.current) return
    poiSourcesExplicitCloseRef.current = false
    const entry = poiSourcesEntryRef.current
    if (!entry) return
    const entryButton = entry.querySelector<HTMLButtonElement>('button')
    entryButton?.focus()
  }, [poiSourcesOpen])

  /** 面板内点「收起」：标记显式收起，让焦点回到入口；其余行为不变 */
  const handlePoiSourcesClose = useCallback(() => {
    poiSourcesExplicitCloseRef.current = true
    setPoiSourcesOpen(false)
  }, [])

  /**
   * 显式收起网页资料面板后，把键盘焦点送回重新挂载的「查网页资料」入口按钮。
   * 只在显式收起标记置位时执行一次并清除标记；隐式收起（编辑/AI/地图打开）
   * 不置位也不抢焦点。
   */
  useEffect(() => {
    if (webSourcesOpen) return
    if (!webSourcesExplicitCloseRef.current) return
    webSourcesExplicitCloseRef.current = false
    const entry = webSourcesEntryRef.current
    if (!entry) return
    const entryButton = entry.querySelector<HTMLButtonElement>('button')
    entryButton?.focus()
  }, [webSourcesOpen])

  /** 面板内点「收起」：标记显式收起，让焦点回到入口；其余行为不变 */
  const handleWebSourcesClose = useCallback(() => {
    webSourcesExplicitCloseRef.current = true
    setWebSourcesOpen(false)
  }, [])

  /** AI 单日调整请求序号：关闭面板 / 重新生成 / 应用成功都 +1，迟到的适配器结果据此作废 */
  const aiRequestSeqRef = useRef(0)
  /** AI 单日调整面板是否打开；与本地草稿互斥 */
  const [aiOpen, setAiOpen] = useState(false)
  /** 仅刷新地图面板是否打开；与本地草稿 / AI 面板互斥，打开期间暂停会替换行程的入口 */
  const [mapOpen, setMapOpen] = useState(false)
  /** A 切片 · AI 行程助手（对话式行程编辑）面板是否打开；与单日调整面板互斥 */
  const [assistantOpen, setAssistantOpen] = useState(false)

  /** 当前是否处于本地编辑状态（草稿已打开） */
  const editingDraft = draft !== null
  /** 本地草稿或 AI 单日面板打开时，都暂停会替换行程 / 写存储的外部入口 */
  const interactionPaused = editingDraft || aiOpen || mapOpen
  /** 暂停期间的公共说明 */
  const editPauseNote = editingDraft
    ? '本地编辑进行中：新行程规划、保存、恢复、导出备份和导出日历已暂停。请先「应用草稿」或「放弃草稿」回到原视图，再使用这些功能。'
    : aiOpen
      ? 'AI 单日调整进行中：新行程规划、保存、恢复、导出备份和导出日历已暂停。请先关闭 AI 面板，再使用这些功能。'
      : mapOpen
        ? '仅刷新地图进行中：新行程规划、保存、恢复、导入导出、撤销和日期切换已暂停。请先关闭面板，再使用这些功能。'
        : null

  /**
   * 显式收起费用面板后，把键盘焦点送回重新挂载的「费用估算」入口按钮。
   * 只在显式收起标记置位时执行一次并清除标记；隐式隐藏（编辑 / AI / 地图打开）
   * 不置位也不抢焦点，不改变其它面板的焦点行为。
   */
  useEffect(() => {
    if (editingDraft || aiOpen || mapOpen) return
    if (!budgetExplicitCloseRef.current) return
    budgetExplicitCloseRef.current = false
    budgetEntryRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [budgetOpen, editingDraft, aiOpen, mapOpen])

  /** 探活，可重复触发；旧结论靠序号挡住，不会盖掉新结果 */
  const runProbe = useCallback(() => {
    probeControllerRef.current?.abort()
    const controller = new AbortController()
    probeControllerRef.current = controller
    const sequence = probeSeqRef.current + 1
    probeSeqRef.current = sequence
    const proofAtStart = businessProofRef.current
    setBackend((prev) => ({ ...prev, probing: true }))
    void probeBackendCapabilities({ signal: controller.signal }).then((caps) => {
      if (probeControllerRef.current === controller) probeControllerRef.current = null
      if (sequence !== probeSeqRef.current) return
      backendConclusionSeqRef.current += 1
      const provenLater = businessProofRef.current !== proofAtStart
      setBackend((prev) => mergeProbe(prev, caps, provenLater))
    })
  }, [])

  /**
   * 业务请求失败落库。两条硬规则：
   * 1. 只有这次请求发出之后没有更新的后端结论，才轮得到它说话——旧失败不能盖掉新探活；
   * 2. 只降级「可达」，不写 planner：规划能力是 health 的判断，业务失败无从得知。
   */
  const applyRequestFailure = useCallback((failure: ProbeFailure, conclusionAtStart: number) => {
    if (backendConclusionSeqRef.current !== conclusionAtStart) return
    backendConclusionSeqRef.current += 1
    setBackend((prev) => mergeRequestFailure(prev, failure))
  }, [])

  // 首次进入：拉示例行程 + 探活
  useEffect(() => {
    let cancelled = false
    const exampleController = new AbortController()
    const sequence = loadSeqRef.current
    /** 示例请求出发时的后端结论版本，用来挡住「旧失败盖新探活」 */
    const conclusionAtStart = backendConclusionSeqRef.current
    exampleAbortRef.current = exampleController
    runProbe()
    // 资料卡库只读加载一次：展示位要用；失败只是没有展示位，不阻断行程。
    ensurePoiCardsLoaded()
    fetchExampleTrip({ signal: exampleController.signal })
      .then((t) => {
        if (cancelled || sequence !== loadSeqRef.current) return
        setTrip(t)
        bumpTripRevision()
        setPhase('ready')
        setOpenedFromFile(false)
        // 能拿到业务数据本身就说明后端在线；它不证明规划可用，所以 planner 仍以 health 为准
        businessProofRef.current += 1
        backendConclusionSeqRef.current += 1
        setBackend(markReachable)
      })
      .catch((err) => {
        if (cancelled || sequence !== loadSeqRef.current) return
        // 用户已经在加载途中恢复本地副本：旧请求即使忽略 abort 也不能改页面
        if (err instanceof ApiError && err.kind === 'abort') return
        setPhase('failed')
        setError(errorText(err))
        // 只有传输层失败才改变后端结论；结构错误是数据问题，不该说成连不上
        const failure = requestFailureOf(err)
        if (failure) applyRequestFailure(failure, conclusionAtStart)
      })
    return () => {
      cancelled = true
      // 序号 +1 让在飞探活的迟到结论直接作废
      probeSeqRef.current += 1
      probeControllerRef.current?.abort()
      probeControllerRef.current = null
      exampleController.abort()
      if (exampleAbortRef.current === exampleController) exampleAbortRef.current = null
    }
  }, [runProbe, applyRequestFailure, ensurePoiCardsLoaded])

  // 地图 marker、弹窗与列表共用同一个入口：幂等设置选中站点，空串表示收起
  const handleSelectStop = useCallback((stopId: string) => {
    setActiveStopId(stopId === '' ? null : stopId)
  }, [])

  // 日切换时清除选中站点
  useEffect(() => {
    setActiveStopId(null)
  }, [activeDay])

  /** 当前日：编辑时优先取草稿天数组，否则用当前行程；日签仍是唯一的导航事实 */
  const currentDay = (() => {
    if (draft) {
      const fromDraft = draft.days.find((d) => d.day === activeDay)
      if (fromDraft) return fromDraft
      const fromTrip = trip?.days.find((d) => d.day === activeDay)
      if (fromTrip) return fromTrip
    }
    return trip?.days.find((d) => d.day === activeDay) ?? trip?.days[0]
  })()

  const switchDay = useCallback(
    (dayNum: number) => {
      // AI 面板或仅刷新地图面板打开时目标日锁定：中途换天会让面板目标与当前日脱节。
      if (aiOpen || mapOpen) return
      // 有未提交的单站输入时明确挡住日切换：输入属于当前天，切换会把它晾在别的天。
      // 没有表单输入时允许跨日编辑同一份草稿（草稿由父级持有，切天不丢）。
      if (editingDraft && editorInputDirty) return
      setActiveDay(dayNum)
    },
    [aiOpen, mapOpen, editingDraft, editorInputDirty],
  )

  // tablist 方向键导航（WAI-APG）：左右键在日签间移动并激活
  const dayNavKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!trip || e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      // AI 面板或仅刷新地图面板打开时同样锁住目标日
      if (aiOpen || mapOpen) {
        e.preventDefault()
        return
      }
      // 键盘切天同样遵守「有未提交输入时暂停日切换」
      if (editingDraft && editorInputDirty) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      const days = trip.days
      const idx = days.findIndex((d) => d.day === activeDay)
      if (idx < 0) return
      const next = e.key === 'ArrowRight' ? (idx + 1) % days.length : (idx - 1 + days.length) % days.length
      const nextDay = days[next].day
      setActiveDay(nextDay)
      const el = document.getElementById(`day-tab-${nextDay}`)
      el?.focus()
    },
    [trip, activeDay, aiOpen, mapOpen, editingDraft, editorInputDirty],
  )

  const scrollToItinerary = useCallback(() => {
    // 滚动到行程区（不用 scrollIntoView，避免嵌入环境的滚动干扰）；
    // 同时把焦点放到行程标题，键盘用户从「恢复」按钮切回来后不会掉到 body。
    requestAnimationFrame(() => {
      const el = itineraryTopRef.current
      if (el) {
        const top = el.getBoundingClientRect().top + window.scrollY
        window.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' })
      }
      tripTitleRef.current?.focus({ preventScroll: true })
    })
  }, [])
  /* ───────── 本机工作进度留存（opt-in）状态 ───────── */

  /**
   * 留存功能状态机：off（未启用）→ idle（启用且无副本）→ pending（有待恢复副本，
   * 自动写整体暂停）→ 恢复/放弃后回 active。跨标签冲突或写失败进入 paused，
   * 只能由用户显式操作退出；editorInputDirty 时自动写暂停。
   */
  type ResumeUiState =
    | { kind: 'off' }
    | { kind: 'idle' }
    | { kind: 'pending'; load: Extract<SessionResumeLoad, { status: 'pending' }> }
    /** rawPreserved=false 只用于删除成功：旧副本已不存在，不能再声称原数据保留 */
    | { kind: 'problem'; message: string; canRestore: boolean; rawPreserved: boolean }

  const storageRef = useRef(getLocalStorageSafe())
  const [resumeEnabled, setResumeEnabled] = useState(false)
  const [resumeUi, setResumeUi] = useState<ResumeUiState>(() =>
    storageRef.current
      ? { kind: 'off' }
      : {
          kind: 'problem',
          message: '浏览器本地存储不可用（可能被隐私模式或站点设置禁用），工作进度留存未启用。',
          canRestore: false,
          rawPreserved: false,
        },
  )
  /** 冻结的存储现值：自动写与外部变化检测都以它为基准 */
  const resumeExpectedRawRef = useRef<string | null>(null)
  /** 自动写被冲突/写失败/删除后暂停：只能由用户显式操作解除 */
  const resumePausedRef = useRef(false)
  /** editorInputDirty 或 pending 期间挂起自动写（同步 ref，state 不参与守卫） */
  const resumeSuspendReasonRef = useRef<'dirty' | 'pending' | null>(null)
  /** editorInputDirty 的同步引用：子组件回调先写 ref，避免 effect 前的自动写窗口 */
  const editorInputDirtyRef = useRef(false)
  /** resumeUi 的同步引用：其它入口处理器（导入/保存恢复）需要感知 pending 状态 */
  const resumeUiRef = useRef<ResumeUiState>({ kind: 'off' })
  resumeUiRef.current = resumeUi
  /** resumeEnabled 的同步引用：persistSessionResume 判断是否需要把已启用的 UI 向下同步为 off */
  const resumeEnabledRef = useRef(false)
  resumeEnabledRef.current = resumeEnabled
  /** 来源标记同步引用：openedFromFile 当前值，写入快照 ui.openedFromFile */
  const openedFromFileRef = useRef<boolean | null>(false)
  openedFromFileRef.current = openedFromFile
  /** off 时存储里是否仍有副本（驱动「删除本机恢复副本」入口显示）；off 时不读内容键 */
  const [resumeHasDataState, setResumeHasDataState] = useState(false)
  const resumeHasData = resumeHasDataState
  /**
   * off 下的显式检查结果（仅用户点击「检查本机恢复副本」时才读数据键）：
   * generation 每次检查推进，是 off 删除确认身份的一部分；挂载/重载恒为 not_checked。
   */
  type ResumeManagementState =
    | { generation: 0; kind: 'not_checked' }
    | { generation: number; kind: 'found'; raw: string }
    | { generation: number; kind: 'not_found' }
    | { generation: number; kind: 'error'; message: string }
  const [resumeManagement, setResumeManagement] = useState<ResumeManagementState>({
    generation: 0,
    kind: 'not_checked',
  })
  const resumeManagementGenerationRef = useRef(0)

  /**
   * 子组件单站表单 dirty 变化的同步入口：先写 ref 再 setState。
   * 自动写 effect 在本函数返回前就可能被同一批渲染触发，不能等 effect 再更新守卫。
   */
  const updateEditorInputDirty = useCallback((dirty: boolean) => {
    editorInputDirtyRef.current = dirty
    setEditorInputDirty(dirty)
    if (dirty) {
      resumeSuspendReasonRef.current = 'dirty'
    } else if (resumeSuspendReasonRef.current === 'dirty') {
      resumeSuspendReasonRef.current = resumeUiRef.current.kind === 'pending' ? 'pending' : null
    }
  }, [])

  /**
   * 工作区记录切换后，App 只在同一事件里投影 Trip 与费用 session。
   * 记录本身是唯一权威；这里不是第二套独立状态，失败也不会把记录回填成旧值。
   * 该动作会作废在途 AI / 规划 / 示例结果与旧候选，并推进页面 Trip revision。
   */
  const applyWorkspaceRecord = useCallback(
    (record: WorkspaceRecordV1) => {
      planSeqRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
      loadSeqRef.current += 1
      exampleAbortRef.current?.abort()
      exampleAbortRef.current = null
      aiRequestSeqRef.current += 1
      setAiOpen(false)
      setMapOpen(false)
      setPlanLoading(false)
      setPlanCancelled(false)
      setDraft(null)
      setDraftError(null)
      setAppliedNotice(null)
      undoApplyRef.current = null
      setCanUndoApply(false)
      setEditorEditing(false)
      updateEditorInputDirty(false)
      setActiveStopId(null)

      bumpTripRevision()
      const nextRevision = tripRevisionRef.current
      setTrip(record.trip)
      const ownerSnapshot = tripOwnerSnapshot(record.trip)
      if (record.budget === null) {
        setBudgetSession(emptyBudgetSession())
      } else {
        setBudgetSession({
          owner: ownerSnapshot.ok
            ? {
                tripId: record.trip.id,
                revision: nextRevision,
                tripSnapshot: ownerSnapshot.value,
                tripTitle: record.trip.title,
              }
            : null,
          rows: record.budget.rows,
          budgetRaw: record.budget.budgetRaw,
          result: null,
          undo: null,
        })
      }
      setPhase('ready')
      setError(null)
      setRequestOutcome({ kind: 'none' })
      setRestoredAt(null)
      setOpenedFromFile(false)
      setActiveDay(record.trip.days[0]?.day ?? 1)
      // F5：约束内容在这次安装里变化时，把旧 baseline 冻结为清单审计的 previous；
      // baseline 缺失（首次安装 / 解绑后重新关联）只重建 baseline，不制造 previous 误报。
      const nextConstraints = record.sidecar.constraints
      const constraintsBaseline = constraintsBaselineRef.current
      if (constraintsBaseline === null) {
        setChecklistPreviousConstraints(null)
      } else if (!canonicalValuesEqual(constraintsBaseline, nextConstraints)) {
        setChecklistPreviousConstraints(constraintsBaseline)
      }
      constraintsBaselineRef.current = nextConstraints
    },
    [bumpTripRevision, updateEditorInputDirty],
  )

  const handleExternalStorageChange = useCallback((key: string | null) => {
    if (key !== null && key !== CANDIDATES_STORAGE_KEY) return
    const prepared = candidatesPreparedRef.current
    if (prepared !== null) {
      invalidatePreparedImport(prepared)
      candidatesPreparedRef.current = null
    }
    candidatesActionSeqRef.current += 1
    setCandidatesImportPreview(null)
    setCandidatesImportBusy(false)
    setCandidatesImportMessage('另一处更新了候选库；导入预览已失效，原库字节未改动。')
    setCandidatesStorageRevision(String(getLibraryGeneration(CANDIDATES_STORAGE_KEY).generation))
    setCandidatesUndo(null)
    setCandidatesSaveStatus('idle')
    setCandidatesSaveMessage('另一处更新了候选库；当前页面只读保留，重新打开候选池可读取最新内容。')
    setCandidatesStorageMessage('另一处更新了候选库；当前页面没有自动覆盖。重新打开候选池可读取最新内容。')
  }, [])

  const workspaceController = useWorkspaceController({
    onRecordApplied: applyWorkspaceRecord,
    onExternalStorageChange: handleExternalStorageChange,
  })

  const currentWorkspaceRecord = workspaceController.workspace
  const workspaceEpoch = workspaceController.epoch
  /** 工作区关联时，AI 请求 / 面板 revision 必须统一使用 workspaceRevision。 */
  const planningRevision = currentWorkspaceRecord?.workspaceRevision ?? tripRevision
  const planningRevisionRef = useRef(planningRevision)
  planningRevisionRef.current = planningRevision
  const workspaceRecordRef = useRef<WorkspaceRecordV1 | null>(currentWorkspaceRecord)
  workspaceRecordRef.current = currentWorkspaceRecord

  /**
   * 所有会替换当前 Trip 的入口统一先过工作区最终 apply 门：
   * - 工作区未关联 → 放行（旧行为不变，不读任何存储键）；
   * - 换 trip.id → 解除关联（sidecar / 候选库 / 版本库不跟随；用户之后可显式新建或打开）；
   * - 同 trip.id → 一次整体 transition（Trip + sidecar + 手工预算快照同时切换）。
   * 门失败时不得 setTrip：当前行程与界面状态完全不变，错误进全局横幅。
   * 约束 / 锚点 / 清单等 sidecar 编辑走 applyPatch，不在这个显式换行程入口里伪造已校验。
   */
  const commitTripChange = useCallback((next: Trip): boolean => {
    const session = budgetRef.current
    const budget =
      session.owner !== null && session.owner.tripId === next.id
        ? budgetSnapshotOfSession(session)
        : undefined
    const change = workspaceController.applyTripChange(next, budget)
    if (!change.ok) {
      setError({ title: '未能切换行程', detail: change.message ?? '工作区记录校验失败；当前行程保持不变。' })
      return false
    }
    return true
  }, [workspaceController])

  /**
   * 内部 fork（本地草稿 / AI 整日 / 尾段 / 地图刷新 / 撤销应用）的唯一 apply 门：
   * 已关联时保留 workspaceId / ownerId / sidecar / budget，只把 tripId 重绑到新副本，
   * revision 当前 +1；未关联时与旧行为一致。capture 必须是预览前捕获的实际引用，
   * 不能在这里现取 getRuntime 自证。
   */
  const commitInternalTripFork = useCallback(
    (
      next: Trip,
      capture?: WorkspaceRuntimeCaptureV1 | null,
    ): { ok: true; projected: boolean } | { ok: false; message: string } => {
      const actualCapture =
        capture !== undefined ? capture : (workspaceController.getRuntime()?.capture ?? null)
      const session = budgetRef.current
      const budget =
        session.owner !== null && session.owner.tripId === next.id
          ? budgetSnapshotOfSession(session)
          : undefined
      const change = workspaceController.applyTripFork(next, budget, actualCapture)
      if (!change.ok) {
        setError({
          title: '未能应用行程副本',
          detail: change.message ?? '工作区记录校验失败；当前行程保持不变。',
        })
        return { ok: false, message: change.message ?? '工作区记录校验失败；当前行程保持不变。' }
      }
      // linked 时 applyTripFork 会 notify，由 applyWorkspaceRecord 统一投影 Trip + budget；
      // 入口处理器不要再 setTrip / bump，避免 data-trip-revision 双增。
      return { ok: true, projected: change.kind !== 'unlinked' }
    },
    [workspaceController],
  )

  /**
   * 同一 trip.id 的内部副本替换后，费用草稿仍属于这份行程：只把 owner revision /
   * snapshot 重绑到当前 revision，保留用户输入。用于没有走 applyWorkspaceRecord 的入口。
   */
  const rebindBudgetOwnerAfterTripChange = useCallback((nextTrip: Trip) => {
    const snapshot = tripOwnerSnapshot(nextTrip)
    if (!snapshot.ok) return
    const revision = tripRevisionRef.current
    setBudgetSession((session) => {
      if (session.owner === null || session.owner.tripId !== nextTrip.id) return session
      return {
        ...session,
        owner: {
          tripId: nextTrip.id,
          revision,
          tripSnapshot: snapshot.value,
          tripTitle: nextTrip.title,
        },
        result: null,
        undo: null,
      }
    })
  }, [])

  /** 把当前会话快照写入留存键（App 内部统一入口，含所有守卫） */
  const persistSessionResume = useCallback(
    (options?: { force?: boolean }) => {
      const storage = storageRef.current
      if (!storage) return
      // 同页静默 flag off：同页 DevTools/扩展把 flag 置 0 不会派 StorageEvent（该事件
      // 本就不达同页），UI 停留已启用。只在既有自动写尝试走到这里时检测一次：
      // flag ≠ '1' → 把本标签 UI 向下同步为 off 并停写；原 raw、当前 Trip/草稿/费用、
      // hasStoredData 原样，不写 flag、不读数据键、不删不恢复。外部再把 flag 置 1
      // （同样无事件）不自动重启本标签，只有用户显式启用才恢复读取。
      if (!isSessionResumeEnabled(storage)) {
        if (resumeEnabledRef.current) {
          setResumeEnabled(false)
          setResumeUi({ kind: 'off' })
          resumeSuspendReasonRef.current = null
        }
        return
      }
      if (resumePausedRef.current && !options?.force) return
      if (resumeSuspendReasonRef.current !== null || editorInputDirtyRef.current) return
      const latestTrip = tripRef.current
      if (!latestTrip) return
      const snapshot = tripOwnerSnapshotForResume(latestTrip)
      const payload = buildPayloadFromSession({
        trip: latestTrip,
        draft: draftRef.current,
        budget: budgetRef.current,
        ui: {
          activeDay: activeDayRef.current,
          draftMode: draftModeRef.current,
          openedFromFile: openedFromFileRef.current,
        },
        tripRevision: tripRevisionRef.current,
        tripSnapshot: snapshot,
        workspace: workspaceRecordRef.current,
      })
      if (payload === null) {
        // 投影失败 = 有内容无法自证归属：整次停写，绝不静默丢块落盘
        resumePausedRef.current = true
        setResumeUi({
          kind: 'problem',
          message: '当前行程或费用内容无法自证归属，自动留存已暂停；已有副本原样。',
          canRestore: false,
          rawPreserved: true,
        })
        return
      }
      const result = writeSessionResume({ payload, expectedRaw: resumeExpectedRawRef.current }, storage)
      if (result.ok) {
        // 成功路径直接采用刚写入的串作新基准（异常安全，不二次读存储）
        resumeExpectedRawRef.current = result.writtenRaw
        // 写成功即有副本：同步 hasStoredData，关闭保留后删除入口不丢失（不二次读存储）
        setResumeHasDataState(true)
        return
      }
      // conflict / quota / unavailable / unknown / too_large：一律停自动写并显式说明，旧 raw 不动
      resumePausedRef.current = true
      setResumeUi({ kind: 'problem', message: result.message, canRestore: false, rawPreserved: true })
    },
    [],
  )

  /** 暂停自动写并给出可见 problem（ref 与 state 同步置位，不留渲染窗口） */
  const pauseResumeWrites = useCallback((message: string) => {
    resumePausedRef.current = true
    setResumeUi({ kind: 'problem', message, canRestore: false, rawPreserved: true })
  }, [])

  /** 存储整体不可用：明确未启用，且不能声称已有副本被保留 */
  const showStorageUnavailable = useCallback(() => {
    setResumeEnabled(false)
    setResumeUi({
      kind: 'problem',
      message: '浏览器本地存储不可用（可能被隐私模式或站点设置禁用），工作进度留存未启用。',
      canRestore: false,
      rawPreserved: false,
    })
  }, [])

  /** 会话变化（trip/revision/draft/budget/ui）后触发一次有界自动写 */
  useEffect(() => {
    if (!resumeEnabled) return
    if (resumeSuspendReasonRef.current !== null || editorInputDirtyRef.current) return
    if (resumePausedRef.current) return
    persistSessionResume()
  }, [
    resumeEnabled,
    trip,
    tripRevision,
    draft,
    budgetSession,
    activeDay,
    draftMode,
    editorInputDirty,
    // sidecar-only transition（清单 / 约束 / 锚点 applyPatch notify:false）不改 Trip /
    // budget 引用，但 controller 每次 transition 都会 advanceEpoch + setEpoch；
    // 不把 epoch 纳入依赖会让自动留存停在旧 revision 的 sidecar 上，reload 即丢编辑。
    // persistSessionResume 本身不改 epoch，不会自触发循环。
    workspaceController.epoch,
    persistSessionResume,
  ])

  /** 跨标签：任一留存键（含 flag）的 storage 事件 → 冲突暂停，冻结事件后现值 */
  useEffect(() => {
    if (!resumeEnabled) return
    const handler = (event: StorageEvent) => {
      if (event.storageArea !== storageRef.current) return
      // 数据键变化、flag 变化、以及 key=null（clear()）都视为外部接管
      const relevant = event.key === SESSION_RESUME_DATA_KEY || event.key === SESSION_RESUME_FLAG_KEY || event.key === null
      if (!relevant) return
      // 冻结当前存储现值（含本次事件写入后的值），本标签不再自动写；
      // 外部把 flag 关掉时同步停用本标签 UI；重新启用不自动复活写，须用户显式操作。
      try {
        resumeExpectedRawRef.current = storageRef.current?.getItem(SESSION_RESUME_DATA_KEY) ?? null
      } catch {
        resumeExpectedRawRef.current = null
      }
      const stillEnabled = isSessionResumeEnabled(storageRef.current)
      if (!stillEnabled) {
        setResumeEnabled(false)
        setResumeUi({ kind: 'off' })
        resumeSuspendReasonRef.current = null
        return
      }
      pauseResumeWrites('检测到另一个标签页更新了留存副本，本标签页已暂停自动留存。可用「删除本机恢复副本」或先关闭再开启以重新接管。')
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [resumeEnabled, pauseResumeWrites])

  /** 挂载 / 重新启用时读取副本 → pending；示例或规划结果不能覆盖它 */
  const refreshResumeFromStorage = useCallback(() => {
    const storage = storageRef.current
    if (!storage) {
      showStorageUnavailable()
      return
    }
    const enabled = isSessionResumeEnabled(storage)
    setResumeEnabled(enabled)
    if (!enabled) {
      setResumeUi({ kind: 'off' })
      resumeExpectedRawRef.current = null
      // off 默认零内容键读取：检查结果回到未检查，等待用户显式检查
      setResumeManagement({ generation: 0, kind: 'not_checked' })
      resumeManagementGenerationRef.current = 0
      return
    }
    const load = loadSessionResumeRecord(storage)
    // 所有异常路径：冻结 raw + ref 停写 + 可见 problem（同步，不给后续 effect 写入窗口）
    if (load.status === 'pending') {
      // 用这次解析实际读到的 raw 作为冻结基准，绝不再读一次当前值覆盖它
      resumeExpectedRawRef.current = load.raw
      resumePausedRef.current = false
      // 编辑器未提交输入优先于 pending 的挂起原因；dirty 结束时会回到 pending
      resumeSuspendReasonRef.current = editorInputDirtyRef.current ? 'dirty' : 'pending'
      setResumeHasDataState(true)
      setResumeUi({ kind: 'pending', load })
    } else if (load.status === 'empty') {
      // 空串/空白也算“空”；直接冻结 load 当次实际读到的 raw，绝不再读一次换基准
      resumeExpectedRawRef.current = load.raw
      resumePausedRef.current = false
      resumeSuspendReasonRef.current = editorInputDirtyRef.current ? 'dirty' : null
      setResumeHasDataState(false)
      setResumeUi({ kind: 'idle' })
    } else if (load.status === 'disabled') {
      setResumeUi({ kind: 'off' })
      resumeExpectedRawRef.current = null
      resumeSuspendReasonRef.current = null
    } else if (
      load.status === 'corrupt' ||
      load.status === 'unknown_version' ||
      load.status === 'invalid' ||
      load.status === 'unavailable'
    ) {
      // 异常路径：冻结 raw + ref 停写 + 可见 problem（同步，不给后续 effect 写入窗口）
      resumeExpectedRawRef.current = readDataRawSafe(storage)
      setResumeHasDataState(true)
      pauseResumeWrites(load.message)
    }
  }, [pauseResumeWrites, showStorageUnavailable])

  useEffect(() => {
    refreshResumeFromStorage()
  }, [refreshResumeFromStorage])

  const handleResumeEnable = useCallback(() => {
    // 首次 getter 抛异常/返回 null 时，允许在同页重试获取；仍不可用则明确反馈
    let storage = storageRef.current
    if (!storage) {
      storage = getLocalStorageSafe()
      storageRef.current = storage
    }
    if (!storage) {
      showStorageUnavailable()
      return
    }
    const result = setSessionResumeFlag(storage, true)
    if (!result.ok) {
      pauseResumeWrites(result.message)
      return
    }
    // 用户显式启用 = 接管：解除暂停并按当前存储内容重建 pending/idle
    resumePausedRef.current = false
    refreshResumeFromStorage()
  }, [refreshResumeFromStorage, pauseResumeWrites, showStorageUnavailable])

  const handleResumeDisable = useCallback(() => {
    const storage = storageRef.current
    if (!storage) {
      showStorageUnavailable()
      return
    }
    const result = setSessionResumeFlag(storage, false)
    if (!result.ok) {
      pauseResumeWrites(result.message)
      return
    }
    // 停写并回 off：按钮可再次开启；数据键与正式保存原样。
    // 关闭前已写成功的副本由 hasStoredData 记住，删除入口不丢；检查结果回未检查（不读内容键）。
    setResumeEnabled(false)
    resumeSuspendReasonRef.current = null
    setResumeUi({ kind: 'off' })
    setResumeManagement({ generation: 0, kind: 'not_checked' })
    resumeManagementGenerationRef.current = 0
  }, [pauseResumeWrites, showStorageUnavailable])

  /**
   * off 下显式「检查本机恢复副本」：唯一在关闭状态读数据键的入口。
   * 只读取一次 raw 展示管理反馈——不启用 flag、不写/删存储、不解析恢复、不改当前页面；
   * 每次点击都推进 generation，使检查打开的旧删除确认失效（防 ABA / 静默换 B）。
   * null → 未找到；空串/空白/坏 JSON/异版本同样是“存在 raw”，一律可管理删除。
   */
  const handleResumeCheckStoredData = useCallback(() => {
    const storage = storageRef.current
    if (!storage) {
      showStorageUnavailable()
      return
    }
    const current = readDataRawForAction(storage)
    resumeManagementGenerationRef.current += 1
    const generation = resumeManagementGenerationRef.current
    if (!current.ok) {
      // 诚实反馈：读取失败不能假称存在或未找到；存储原样，可重试
      setResumeManagement({
        generation,
        kind: 'error',
        message: '读取本机留存副本失败，检查未完成；存储原样保留，可重试。',
      })
      return
    }
    if (current.raw === null) {
      // 未找到：清空基准与副本状态；若之前检查到过副本，删除入口随之消失
      resumeExpectedRawRef.current = null
      setResumeHasDataState(false)
      setResumeManagement({ generation, kind: 'not_found' })
      return
    }
    // 任何存在 raw（含空串/空白/损坏/异版本）都冻结为可管理候选：
    // 同时作为该界面的删除 prepare 比对基准，让检查到的副本可独立两步删除
    resumeExpectedRawRef.current = current.raw
    setResumeHasDataState(true)
    setResumeManagement({ generation, kind: 'found', raw: current.raw })
  }, [showStorageUnavailable])

  /**
   * 删除前引导：只在当前 raw 仍等于该界面已冻结的候选 raw 时打开二次确认，
   * 并把这次实际读到的 raw 交给确认步骤做最终 compare-then-remove。
   */
  const handleResumePrepareDelete = useCallback((): { ok: true; raw: string | null } | { ok: false } => {
    const storage = storageRef.current
    if (!storage) {
      showStorageUnavailable()
      return { ok: false }
    }
    const current = readDataRawForAction(storage)
    if (!current.ok) {
      pauseResumeWrites('读取本机留存副本失败，删除未执行；当前页面和已有副本都没有改变。')
      return { ok: false }
    }
    if (current.raw !== resumeExpectedRawRef.current) {
      pauseResumeWrites(
        '检测到另一个标签页更新了留存副本，删除未执行；当前页面和对方副本都保持原样。请先关闭再开启留存以重新读取，确认后再删除。',
      )
      return { ok: false }
    }
    return { ok: true, raw: current.raw }
  }, [pauseResumeWrites, showStorageUnavailable])

  const handleResumeDelete = useCallback(
    (expectedRaw: string | null) => {
      const storage = storageRef.current
      if (!storage) {
        showStorageUnavailable()
        return
      }
      const current = readDataRawForAction(storage)
      if (!current.ok) {
        pauseResumeWrites('读取本机留存副本失败，删除未执行；当前页面和已有副本都没有改变。')
        return
      }
      if (current.raw !== expectedRaw) {
        pauseResumeWrites(
          '检测到另一个标签页更新了留存副本，删除未执行；当前页面和对方副本都保持原样。请先关闭再开启留存以重新读取，确认后再删除。',
        )
        return
      }
      const result = removeSessionResumeData(storage)
      if (!result.ok) {
        pauseResumeWrites(result.message)
        return
      }
      // 删除成功：副本不存在，expected 置空；按「删除后需再次显式启用/新变更才重新留存」策略，
      // 本标签保持 paused（防同 transition 立即默默重建），UI 给出明确说明。
      resumeExpectedRawRef.current = null
      resumeSuspendReasonRef.current = null
      resumePausedRef.current = true
      setResumeHasDataState(false)
      // off 检查流程的删除同样把检查结果清为未找到，旧检查候选不再残留
      resumeManagementGenerationRef.current += 1
      setResumeManagement({
        generation: resumeManagementGenerationRef.current,
        kind: 'not_found',
      })
      setResumeUi({
        kind: 'problem',
        message: resumeEnabled
          ? '已删除本机恢复副本。自动留存保持暂停；先点「关闭保留（已留存的副本会保留）」，再重新点「在此浏览器保留工作进度」即可重新开始留存当前进度。'
          : '已删除本机恢复副本。自动留存保持暂停；点「在此浏览器保留工作进度」可重新开始留存当前进度。',
        canRestore: false,
        rawPreserved: false,
      })
    },
    [resumeEnabled, pauseResumeWrites, showStorageUnavailable],
  )

  const handleResumeRestore = useCallback(() => {
    if (resumeUi.kind !== 'pending') return
    const storage = storageRef.current
    if (!storage) {
      pauseResumeWrites('浏览器本地存储不可用，恢复未执行；当前页面和已有副本都没有改变。')
      return
    }
    // CAS 守卫：动作前严格比对当前 raw 与「产出这份 pending 时实际解析的 raw」。
    // 不一致只停写并保留双方数据，绝不用当前值刷新 expectedRaw 去“解决”冲突。
    const current = readDataRawForAction(storage)
    if (!current.ok) {
      pauseResumeWrites('读取本机留存副本失败，恢复未执行；当前页面和已有副本都没有改变。')
      return
    }
    if (current.raw !== resumeUi.load.raw) {
      pauseResumeWrites(
        '检测到另一个标签页更新了留存副本，恢复未执行；当前页面和对方副本都保持原样。请先关闭再开启留存以重新读取，确认后再恢复。',
      )
      return
    }
    const record = resumeUi.load.record

    // 父级在预览前捕获实际内存 authority；currentWorkspace 只取 controller 当前内存记录，
    // 不用 loadWorkspaceRecord 的持久记录代替。prepared 与 confirm 必须使用同一份引用 / epoch。
    const runtime = workspaceController.getRuntime()
    const currentWorkspace = runtime?.record ?? null
    const epoch = runtime?.epoch ?? workspaceController.epoch
    const prepared = prepareSessionWorkspaceRestore({
      session: record.session,
      savedAt: record.savedAt,
      raw: resumeUi.load.raw,
      currentWorkspace,
      epoch,
      now: Date.now(),
    })
    if (!prepared.ok) {
      pauseResumeWrites(`恢复未执行：${prepared.message}`)
      return
    }
    // 旧草稿 / 预算 / UI 预览单独取；workspace 仍由 prepared 整体确认，不先 setTrip。
    const base = previewSessionResume(record, tripRevisionRef.current + 1, {
      allowWorkspace: true,
    })
    if (!base.ok) {
      pauseResumeWrites(`恢复未执行：${base.message}`)
      return
    }

    let workspaceNote: string
    if (prepared.status === 'ready') {
      // fresh read → confirm → 整体内存安装之间没有 await；B vs prepare A 必须拒绝。
      const fresh = loadSessionResumeRecord(storage)
      if (fresh.status !== 'pending') {
        pauseResumeWrites('留存副本在确认前已不可读（可能被外部更新或关闭留存）；恢复未执行，当前页面保持不变。')
        return
      }
      const confirmed = confirmSessionWorkspaceRestore(prepared, currentWorkspace, epoch, {
        currentRaw: fresh.raw,
      })
      if (!confirmed.ok) {
        pauseResumeWrites(`恢复未执行：${confirmed.message}`)
        return
      }
      const installed = workspaceController.adoptRecord(
        confirmed.record,
        runtime?.capture ?? null,
        { allowNewWorkspace: true, allowTripRebind: true, notify: true },
      )
      if (!installed.ok) {
        pauseResumeWrites(`恢复未执行：${installed.message ?? '工作区记录未能安装。'}`)
        return
      }
      workspaceNote =
        prepared.proposal.transition === 'replace_trip'
          ? '工作区记录已整体恢复，并替换了当前内存里的另一行程工作区；本地存储里的旧工作区没有自动改写。'
          : prepared.proposal.transition === 'new_workspace'
            ? '工作区记录已整体恢复到内存（新建工作区，revision 从 1 开始）；没有自动写入工作区键。'
            : '工作区记录（Trip + sidecar + 预算快照）已整体恢复；没有自动写入工作区键，候选库 / 版本库未改动。'
    } else {
      // v1 / v2 workspace:null：旧兼容流程只恢复 Trip；sidecar 视为空，不按 tripId/hash 挂接。
      if (workspaceController.workspace !== null) workspaceController.detach()
      if (!commitTripChange(record.session.trip)) return
      workspaceNote =
        '这份留存没有工作区数据（旧 v1 或 workspace:null）：只恢复 Trip，sidecar 为空；没有读取或挂接本地工作区。'
    }

    // 预检通过才作废全部在飞请求与旧候选
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    aiRequestSeqRef.current += 1
    setAiOpen(false)
    // 地图刷新面板自身持有在途请求；恢复时卸载它，交给面板 cleanup 中止旧请求
    setMapOpen(false)
    setPlanLoading(false)
    setPlanCancelled(false)
    setDraftError(null)
    setAppliedNotice(null)
    undoApplyRef.current = null
    setCanUndoApply(false)
    setEditorEditing(false)
    updateEditorInputDirty(false)
    setActiveStopId(null)

    setDraft(base.draft)
    if (prepared.status !== 'ready') {
      setTrip(record.session.trip)
      bumpTripRevision()
      rebindBudgetOwnerAfterTripChange(record.session.trip)
    }
    setBudgetSession(base.budget)

    setPhase('ready')
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setRestoredAt(null)
    // 来源边界：快照自述来自备份文件 → 保持「未向服务器核对」提示；
    // 旧记录缺来源标记 → 保守按未知提示；应用内正常进度不冒充刚打开文件。
    const sourceNote =
      base.openedFromFile === true
        ? '已从本机留存的工作进度恢复。这份进度当时的行程来自你选择的备份文件：页面仍未向服务器核对内容。'
        : base.openedFromFile === null
          ? '已从本机留存的工作进度恢复。这份进度没有记录来源标记，行程内容按未核实处理。'
          : '已从本机留存的工作进度恢复。'
    // 三态原样恢复：null（旧记录未知）必须继续保持未知，不能降成 false
    setOpenedFromFile(base.openedFromFile)
    setAppliedNotice(
      `${sourceNote}${workspaceNote}这不是「保存的行程」：要长期留存请在下方显式保存；未应用的草稿仍需你手动应用。`,
    )
    const restoredDayValid = record.session.trip.days.some((d) => d.day === base.activeDay)
    setActiveDay(restoredDayValid ? base.activeDay : (record.session.trip.days[0]?.day ?? 1))
    setDraftMode(base.draftMode)

    // 恢复不是删除：不 removeItem，也不重新读取当前 raw 覆盖冻结基准。
    // 下一次自动写仍以产出 pending 时的 raw 做单次 guarded 替换；若期间被更新则 conflict 保旧。
    resumeSuspendReasonRef.current = null
    resumePausedRef.current = false
    setResumeUi({ kind: 'idle' })
    scrollToItinerary()
  }, [
    resumeUi,
    workspaceController,
    bumpTripRevision,
    rebindBudgetOwnerAfterTripChange,
    scrollToItinerary,
    pauseResumeWrites,
    updateEditorInputDirty,
    commitTripChange,
  ])

  /* ───────── F1 / F2 / F3 / F5 / F6 真实接线 ───────── */

  /**
   * 费用草稿编辑也走同一工作区 authority：先按编辑前捕获的实际引用做一次
   * budget-only transition，成功后才更新 App 草稿；失败保留旧记录并显示原因。
   */
  const handleBudgetSessionChange = useCallback(
    (next: BudgetSessionState) => {
      const runtime = workspaceController.getRuntime()
      if (runtime !== null) {
        const applied = workspaceController.applyPatch(
          { budget: budgetSnapshotOfSession(next) },
          runtime.capture,
          { notify: false },
        )
        if (!applied.ok) {
          setError({
            title: '未能更新费用草稿',
            detail: applied.message ?? '工作区记录校验失败；费用输入保持原样。',
          })
          return
        }
      }
      setBudgetSession(next)
    },
    [workspaceController],
  )

  /** F1：锚点 / 酒店提案先按实际引用 + epoch 校验，再安装整体记录。 */
  const handleAnchorsApply = useCallback(
    (proposal: AnchorsProposal): { ok: true } | { ok: false; message: string } => {
      const runtime = workspaceController.getRuntime()
      if (runtime === null) {
        return { ok: false, message: '当前没有关联工作区，锚点改动未应用。' }
      }
      const applied = applyAnchorsProposal(runtime.record, proposal, Date.now())
      if (!applied.ok) {
        return { ok: false, message: applied.message }
      }
      const installed = workspaceController.adoptRecord(applied.value, runtime.capture, {
        notify: false,
      })
      if (!installed.ok) {
        return { ok: false, message: installed.message ?? '工作区记录没有通过校验，锚点改动未应用。' }
      }
      if (!canonicalValuesEqual(runtime.record.trip, applied.value.trip)) {
        setTrip(applied.value.trip)
        bumpTripRevision()
        rebindBudgetOwnerAfterTripChange(applied.value.trip)
        setActiveStopId((current) =>
          current && applied.value.trip.days.some((d) => d.stops.some((s) => s.id === current))
            ? current
            : null,
        )
      }
      return { ok: true }
    },
    [workspaceController, bumpTripRevision, rebindBudgetOwnerAfterTripChange],
  )

  /** F2：约束面板 apply 先过实际引用 / ticket / H-U / canonical 全套门，再单次 transition。 */
  const handleConstraintsApply = useCallback(
    (request: ConstraintsPanelApplyRequest): { ok: true } | { ok: false; message: string } => {
      const runtime = workspaceController.getRuntime()
      if (runtime === null) {
        return { ok: false, message: '当前没有关联工作区，约束改动未应用。' }
      }
      const ticketRuntime = request.ticket.runtime
      if (
        ticketRuntime.record !== runtime.record ||
        ticketRuntime.trip !== runtime.record.trip ||
        ticketRuntime.sidecar !== runtime.record.sidecar ||
        ticketRuntime.budget !== runtime.record.budget ||
        ticketRuntime.input !== request.candidateTrip
      ) {
        return {
          ok: false,
          message: '工作区或候选的实际对象引用已变化；旧确认失效，请重新生成。',
        }
      }
      if (!canonicalValuesEqual(request.candidateTrip, runtime.record.trip)) {
        return { ok: false, message: '约束候选不是当前工作区行程；未应用。' }
      }
      const decision = checkConstraintsApply({
        ticket: request.ticket,
        record: runtime.record,
        constraints: request.constraints,
        candidateTrip: request.candidateTrip,
        planScope: request.planScope,
        epoch: request.epoch,
      })
      if (!decision.allowed) {
        return { ok: false, message: decision.message }
      }
      const applied = workspaceController.applyPatch(
        {
          sidecar: {
            ...runtime.record.sidecar,
            constraints: request.constraints,
          },
        },
        runtime.capture,
        { notify: false },
      )
      if (!applied.ok) {
        return { ok: false, message: applied.message ?? '约束改动未应用；工作区保持不变。' }
      }
      // F5：把「修改前的真实约束」冻结为清单审计的 previous，直到用户显式确认重新关联；
      // 内容没变（原样重应用）时不制造 needsRelink。
      if (!canonicalValuesEqual(runtime.record.sidecar.constraints, request.constraints)) {
        setChecklistPreviousConstraints(runtime.record.sidecar.constraints)
        constraintsBaselineRef.current = request.constraints
      }
      return { ok: true }
    },
    [workspaceController],
  )

  /**
   * F5：清单受控 onChange 先生成整体 workspace transition；失败原记录不变。
   * 「标记需重新关联」（action:'relink'）只是追加生成标记，App 不在这里推进任何
   * previous 基线；逐条「按当前预约重新核对」（action:'reconfirm-constraint'）由
   * ChecklistPanel 调 checklist 纯函数完成锚点回写，提示由 audit 按各条目锚点判定，
   * 不存在全局 dismiss。
   */
  const handleChecklistChange = useCallback<ChecklistChangeHandler>((next: ChecklistV1) => {
    const runtime = workspaceController.getRuntime()
    if (runtime === null) {
      return { ok: false, message: '当前没有关联工作区，清单改动未应用。' }
    }
    const applied = workspaceController.applyPatch(
      {
        sidecar: {
          ...runtime.record.sidecar,
          checklist: next,
        },
      },
      runtime.capture,
      { notify: false },
    )
    return applied.ok
      ? { ok: true }
      : { ok: false, message: applied.message ?? '清单改动未应用；工作区保持不变。' }
  }, [workspaceController])

  /* ───────── F3 候选库：独立键的显式读 / 存 / 导出 / 导入确认 / 撤销 ───────── */

  const openCandidatePool = useCallback(() => {
    candidatesActionSeqRef.current += 1
    const read = loadCandidatesRecord(storageRef.current)
    candidatesRawRef.current = read.raw
    let record: CandidatesRecordV1 | null = read.record
    let status: CandidatePoolStorageStatus = read.status
    if (read.status === 'empty') {
      const empty = createEmptyCandidateRecord(Date.now())
      record = empty.ok ? empty.value : null
      status = 'empty'
    }
    setCandidatesRecord(record)
    setCandidatesStorageStatus(status)
    setCandidatesStorageMessage(read.message)
    setCandidatesStorageRevision(String(getLibraryGeneration(CANDIDATES_STORAGE_KEY).generation))
    setCandidatesSaveStatus('idle')
    setCandidatesSaveMessage(null)
    setCandidatesImportMessage(null)
    setCandidatesImportPreview(null)
    candidatesPreparedRef.current = null
    setCandidatesUndo(null)
    setAnchorsOpen(false)
    setConstraintsOpen(false)
    setChecklistOpen(false)
    setCandidatePoolOpen(true)
  }, [])

  const handleCandidatesRecordChange = useCallback((next: CandidatesRecordV1) => {
    setCandidatesRecord(next)
    setCandidatesSaveStatus('idle')
    setCandidatesSaveMessage('候选库有未保存的内存改动；点「保存候选库」才写入本地键。')
  }, [])

  const handleSaveCandidates = useCallback((record: CandidatesRecordV1) => {
    const storage = storageRef.current
    const locks = getWorkspaceLockManager()
    if (!storage || !locks) {
      setCandidatesSaveStatus('error')
      setCandidatesSaveMessage('当前浏览器无法安全写入候选库；原字节未改动。')
      return
    }
    const seq = candidatesActionSeqRef.current
    setCandidatesSaveStatus('pending')
    setCandidatesSaveMessage(null)
    void saveCandidatesRecord(record, {
      storage,
      locks,
      expectedRaw: candidatesRawRef.current,
    }).then((result) => {
      if (candidatesActionSeqRef.current !== seq) {
        setCandidatesSaveStatus('idle')
        setCandidatesSaveMessage('保存期间候选库或页面状态已变化；请重新打开候选池确认最新内容。')
        return
      }
      if (!result.ok) {
        setCandidatesSaveStatus('error')
        setCandidatesSaveMessage(result.message)
        return
      }
      candidatesRawRef.current = result.raw
      setCandidatesRecord(result.record)
      setCandidatesStorageStatus('ok')
      setCandidatesStorageMessage(null)
      setCandidatesStorageRevision(String(getLibraryGeneration(CANDIDATES_STORAGE_KEY).generation))
      setCandidatesSaveStatus('saved')
      setCandidatesSaveMessage(`已保存候选库（${result.record.items.length} 个候选，${result.bytes} 字节）。`)
      setCandidatesUndo(null)
    })
  }, [])

  const handleExportCandidates = useCallback((record: CandidatesRecordV1) => {
    const backup = createCandidatesBackup(record, Date.now())
    if (!backup.ok) {
      setCandidatesSaveStatus('error')
      setCandidatesSaveMessage(backup.message)
      return
    }
    const blob = new Blob([backup.value.json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `travel-assistant-candidates-${new Date(backup.value.backup.exportedAt)
      .toISOString()
      .slice(0, 10)}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    setCandidatesSaveMessage(`已导出 ${backup.value.itemCount} 个候选（${backup.value.bytes} 字节）；导出不写本地键。`)
  }, [])

  const handleCandidatesImportRequest = useCallback(() => {
    candidatesFileInputRef.current?.click()
  }, [])

  const handleCandidatesFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null
      event.target.value = ''
      if (file === null) return
      const storage = storageRef.current
      const locks = getWorkspaceLockManager()
      if (!storage || !locks) {
        setCandidatesImportMessage('当前浏览器无法安全写入候选库；导入未开始。')
        return
      }
      const seq = candidatesActionSeqRef.current
      void file.text().then((text) => {
        if (candidatesActionSeqRef.current !== seq) return
        const prepared = prepareCandidatesImport(text, { storage, locks })
        if (!prepared.ok) {
          setCandidatesImportMessage(prepared.message)
          return
        }
        candidatesPreparedRef.current = prepared
        setCandidatesImportPreview({
          prepared,
          itemCount: prepared.importedRecord.items.length,
          fileName: file.name,
        })
        setCandidatesImportMessage('备份文件已通过纯校验；确认后才会写入候选库。')
      })
    },
    [],
  )

  const handleConfirmCandidatesImport = useCallback(() => {
    const preview = candidatesImportPreview
    const storage = storageRef.current
    const locks = getWorkspaceLockManager()
    if (preview === null) return
    if (!storage || !locks) {
      setCandidatesImportMessage('当前浏览器无法安全写入候选库；导入未执行。')
      return
    }
    const seq = candidatesActionSeqRef.current
    setCandidatesImportBusy(true)
    setCandidatesImportMessage(null)
    void confirmCandidatesImport(preview.prepared, {
      storage,
      locks,
      now: Date.now(),
      undoTtlMs: DEFAULT_UNDO_TTL_MS,
    }).then((result) => {
      if (candidatesActionSeqRef.current !== seq) {
        setCandidatesImportBusy(false)
        return
      }
      setCandidatesImportBusy(false)
      if (!result.ok) {
        setCandidatesImportMessage(result.message)
        if (
          result.reason === 'import_superseded' ||
          result.reason === 'import_expired' ||
          result.reason === 'import_cancelled' ||
          result.reason === 'input_changed'
        ) {
          candidatesPreparedRef.current = null
          setCandidatesImportPreview(null)
        }
        return
      }
      candidatesPreparedRef.current = null
      setCandidatesImportPreview(null)
      candidatesRawRef.current = result.raw
      setCandidatesRecord(result.record)
      setCandidatesStorageStatus('ok')
      setCandidatesStorageMessage(null)
      setCandidatesStorageRevision(String(getLibraryGeneration(CANDIDATES_STORAGE_KEY).generation))
      setCandidatesSaveStatus('saved')
      setCandidatesSaveMessage(`已导入 ${result.record.items.length} 个候选；原字节已冻结，可撤销一次。`)
      setCandidatesImportMessage('候选库导入完成。')
      setCandidatesUndo(result.undo)
    })
  }, [candidatesImportPreview])

  const handleCancelCandidatesImport = useCallback(() => {
    const prepared = candidatesPreparedRef.current
    if (prepared !== null) cancelPreparedImport(prepared)
    candidatesPreparedRef.current = null
    setCandidatesImportPreview(null)
    setCandidatesImportBusy(false)
    setCandidatesImportMessage('已取消导入预览；候选库原字节未改动。')
  }, [])

  const handleUndoCandidatesImport = useCallback(() => {
    const handle = candidatesUndo
    const storage = storageRef.current
    const locks = getWorkspaceLockManager()
    if (handle === null || !storage || !locks) return
    const seq = candidatesActionSeqRef.current
    void undoImport(handle, { storage, locks, now: Date.now() }).then((result) => {
      if (candidatesActionSeqRef.current !== seq) return
      if (!result.ok) {
        setCandidatesSaveStatus('error')
        setCandidatesSaveMessage(result.message)
        if (result.reason === 'undo_used' || result.reason === 'undo_expired') {
          setCandidatesUndo(null)
        }
        return
      }
      setCandidatesUndo(null)
      const read = loadCandidatesRecord(storage)
      candidatesRawRef.current = read.raw
      let record: CandidatesRecordV1 | null = read.record
      let status: CandidatePoolStorageStatus = read.status
      if (read.status === 'empty') {
        const empty = createEmptyCandidateRecord(Date.now())
        record = empty.ok ? empty.value : null
        status = 'empty'
      }
      setCandidatesRecord(record)
      setCandidatesStorageStatus(status)
      setCandidatesStorageMessage(read.message)
      setCandidatesStorageRevision(String(getLibraryGeneration(CANDIDATES_STORAGE_KEY).generation))
      setCandidatesSaveStatus('idle')
      setCandidatesSaveMessage('已撤销最近一次候选库导入，恢复导入前字节。')
    })
  }, [candidatesUndo])

  /** F3 加入草稿：只更新父级草稿；真正应用到 Trip 仍走既有草稿应用流程。 */
  const handleCandidateAddToDraft = useCallback(
    (proposal: CandidateDraftProposal) => {
      if (draftRef.current === null) {
        draftWorkspaceCaptureRef.current = workspaceController.getRuntime()?.capture ?? null
      }
      setDraft(proposal.draft)
      setDraftMode(proposal.draft.newLegMode)
      setDraftError(null)
      setAppliedNotice(null)
      setActiveDay(proposal.day)
      setCandidatePoolOpen(false)
    },
    [workspaceController],
  )

  const handleResumeDiscardAndStart = useCallback(() => {
    if (resumeUi.kind !== 'pending') return
    const storage = storageRef.current
    if (!storage) return
    // 与恢复同一 CAS 守卫：只接受 pending 解析时冻结的 raw；外部已更新则放弃替换
    const current = readDataRawForAction(storage)
    if (!current.ok) {
      pauseResumeWrites('读取本机留存副本失败，未替换副本；当前页面和已有副本都没有改变。')
      return
    }
    if (current.raw !== resumeUi.load.raw) {
      pauseResumeWrites(
        '检测到另一个标签页更新了留存副本，未替换副本；当前页面和对方副本都保持原样。请先关闭再开启留存以重新读取，确认后再操作。',
      )
      return
    }
    // 先构造/校验当前页面 payload，成功才以旧 expectedRaw 做单次替换写；
    // 任何 quota/序列化/冲突失败：旧 raw 原样，pending 保持。
    const latestTrip = tripRef.current
    if (!latestTrip) {
      pauseResumeWrites('当前页面还没有可留存的行程，未替换副本；上次进度原样保留。')
      return
    }
    const snapshot = tripOwnerSnapshotForResume(latestTrip)
    const payload = buildPayloadFromSession({
      trip: latestTrip,
      draft: draftRef.current,
      budget: budgetRef.current,
      ui: {
        activeDay: activeDayRef.current,
        draftMode: draftModeRef.current,
        openedFromFile: openedFromFileRef.current,
      },
      tripRevision: tripRevisionRef.current,
      tripSnapshot: snapshot,
      workspace: workspaceRecordRef.current,
    })
    if (payload === null) {
      pauseResumeWrites('当前行程或费用内容无法自证归属，未替换副本；上次进度原样保留。')
      return
    }
    const result = writeSessionResume({ payload, expectedRaw: resumeExpectedRawRef.current }, storage)
    if (!result.ok) {
      pauseResumeWrites(`${result.message}（替换副本未完成，上次进度原样保留）`)
      return
    }
    resumeExpectedRawRef.current = result.writtenRaw
    resumeSuspendReasonRef.current = null
    resumePausedRef.current = false
    setResumeUi({ kind: 'idle' })
  }, [resumeUi, pauseResumeWrites])

  const handlePlan = useCallback(async (payload: PlanRequest) => {
    // 取消上一次未完成的规划请求，并用序号挡住已经 resolved、但回调还没执行的旧响应
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const sequence = planSeqRef.current + 1
    planSeqRef.current = sequence
    /** 规划请求出发时的后端结论版本，用来挡住「旧失败盖新探活」 */
    const conclusionAtStart = backendConclusionSeqRef.current
    setPlanLoading(true)
    setPlanCancelled(false)
    setError(null)
    setRequestOutcome({ kind: 'pending', destination: payload.destination })
    setLastPlannedPace(payload.pace ?? null)
    try {
      const t = await planTrip(payload, { signal: controller.signal })
      if (sequence !== planSeqRef.current) return
      // 新规划是显式新 owner：不继承当前工作区 sidecar / 候选 / 版本；先解除关联再应用。
      if (workspaceRecordRef.current !== null) workspaceController.detach()
      // 工作区最终 apply 门：门失败时不替换行程，本次规划结果不采纳
      if (!commitTripChange(t)) {
        setRequestOutcome({ kind: 'failed', destination: payload.destination })
        return
      }
      setTrip(t)
      bumpTripRevision()
      setPhase('ready')
      setRestoredAt(null)
      setOpenedFromFile(false)
      setActiveDay(t.days[0]?.day ?? 1)
      setActiveStopId(null)
      setRequestOutcome({ kind: 'none' })
      // 真正拿到规划结果，比 health 更有说服力：此时规划确定可用，迟到的探活不能推翻
      businessProofRef.current += 1
      backendConclusionSeqRef.current += 1
      probeSeqRef.current += 1
      probeControllerRef.current?.abort()
      probeControllerRef.current = null
      setBackend({ checked: true, reachable: true, planner: 'ready', failure: null, failureSource: null, probing: false, amap: 'unknown' })      // 新规划已接管页面，加载中的示例请求（即使忽略 abort）不能再覆盖
      loadSeqRef.current += 1
      scrollToItinerary()
    } catch (err) {
      if (sequence !== planSeqRef.current) return
      if (err instanceof ApiError && err.kind === 'abort') return
      // 传输层失败才动后端结论；业务错误（500 / 结构不符）由错误横幅说明，不能冒充health
      const failure = requestFailureOf(err)
      if (failure) applyRequestFailure(failure, conclusionAtStart)
      setError(errorText(err))
      setRequestOutcome({ kind: 'failed', destination: payload.destination })
    } finally {
      if (sequence === planSeqRef.current) {
        if (abortRef.current === controller) abortRef.current = null
        setPlanLoading(false)
      }
    }
  }, [scrollToItinerary, applyRequestFailure])

  /**
   * 停止等待：只让本页不再等这次结果，立刻恢复可提交状态。
   * 不承诺后端 / 上游模型停止处理或停止计费——请求可能已经在服务端跑完。
   */
  const handleStopWaiting = useCallback(() => {
    if (!planLoading) return
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPlanLoading(false)
    setPlanCancelled(true)
    setError(null)
    setRequestOutcome((prev) =>
      prev.kind === 'pending' ? { kind: 'stopped', destination: prev.destination } : { kind: 'stopped', destination: '' },
    )
  }, [planLoading])

  /**
   * 从本浏览器保存的副本恢复：取消未完成的规划请求与示例请求（避免旧响应覆盖恢复结果），
   * 回到第一天，并清空选中站点和地图弹窗。恢复也会替换当前行程：递增 revision。
   * 编辑草稿时该入口被禁用，正常不会走到这里；万一被调用（面板未禁用的路径），
   * 旧草稿立即作废而不是带着新 base 应用。
   */
  const handleRestoreSavedTrip = useCallback((restored: Trip, savedAt: number) => {
    if (!commitTripChange(restored)) return
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    // 恢复同样替换当前行程：AI 面板若在开（正常已禁用）立刻作废在途候选
    aiRequestSeqRef.current += 1
    setAiOpen(false)
    setPlanLoading(false)
    setPlanCancelled(false)
    setDraft(null)
    setDraftError(null)
    setAppliedNotice(null)
    undoApplyRef.current = null
    setCanUndoApply(false)
    setEditorEditing(false)
    updateEditorInputDirty(false)
    setTrip(restored)
    bumpTripRevision()
    rebindBudgetOwnerAfterTripChange(restored)
    setPhase('ready')
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setRestoredAt(savedAt)
    setOpenedFromFile(false)
    setActiveStopId(null)
    setActiveDay(restored.days[0]?.day ?? 1)
    // 显式恢复已保存行程只替换内存视图；留存 pending 副本继续保留并暂停自动写，
    // 只有用户明确恢复留存或确认放弃当前 pending 才移交。
    scrollToItinerary()
  }, [scrollToItinerary, updateEditorInputDirty])

  /**
   * 打开从备份文件导入的行程（TripTransferPanel 的「打开这份行程」）。
   *
   * - 只切换当前视图：不写 localStorage、不下载、不请求后端；需要保存走面板里显式的「保存到本地」；
   * - 作废在飞的示例 / 规划请求：序号 +1 再 abort，即使对方忽略 abort，迟到的响应也覆盖不了这份行程；
   * - 不设 restoredAt——那份时间戳只属于「本浏览器保存的副本」，不能拿来给文件里的行程用；
   * - 回到第一天并清空选中站点，避免停在上一个行程的某天 / 某个站点上。
   */
  const handleOpenImportedTrip = useCallback((imported: Trip) => {
    // 旧 Trip JSON 导入是显式新 owner：即使 trip.id 相同也不继承 sidecar / 约束 / 清单。
    if (workspaceRecordRef.current !== null) workspaceController.detach()
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    // 打开文件同样替换当前行程：AI 面板若在开（正常已禁用）立刻作废在途候选
    aiRequestSeqRef.current += 1
    setAiOpen(false)
    // 等待中的规划被这次打开接管：恢复可提交状态，也不再显示「已停止等待」的旧说明
    setPlanLoading(false)
    setPlanCancelled(false)
    // 打开文件同样替换当前行程：旧草稿作废（编辑期间此入口已被禁用，这里是兜底）
    setDraft(null)
    setDraftError(null)
    setAppliedNotice(null)
    undoApplyRef.current = null
    setCanUndoApply(false)
    setEditorEditing(false)
    updateEditorInputDirty(false)
    setTrip(imported)
    bumpTripRevision()
    setPhase('ready')
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setRestoredAt(null)
    setOpenedFromFile(true)
    setActiveStopId(null)
    setActiveDay(imported.days[0]?.day ?? 1)
    // 打开导入文件只替换内存视图；留存 pending 副本继续保留并暂停自动写，
    // 只有用户明确恢复留存或确认放弃当前 pending 才移交/覆盖。
    scrollToItinerary()
  }, [scrollToItinerary, updateEditorInputDirty])

  const dayTabs = trip?.days ?? []
  const tripIsExample = trip?.source === 'example'

  /* ───────── 本地编辑：进入 / 应用 / 放弃 / 撤销应用 ───────── */

  /**
   * 进入本地编辑：先作废并中止当前规划与示例等待（迟到的结果不允许在编辑期间覆盖页面），
   * 再用 UUID 创建新 fork 草稿。原行程与已保存数据完全不动。
   * 停止等待只取消本页的等待，不保证后端停止处理。
   */
  const handleStartEditing = useCallback(() => {
    if (!trip || draft || aiOpen || mapOpen) return
    draftWorkspaceCaptureRef.current = workspaceController.getRuntime()?.capture ?? null
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    setPlanLoading(false)
    setPlanCancelled(false)
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setDraftError(null)
    setAppliedNotice(null)
    setCanUndoApply(false)
    undoApplyRef.current = null
    // 面板打开期间本日资料收起卸载：不保留旧结果，也不自动重查
    setPoiSourcesOpen(false)
    // 网页资料面板同样收起卸载：面板自身 cleanup 已作废在途请求
    setWebSourcesOpen(false)
    const result = createTripDraft(trip, { forkTripId: newUuid(), newLegMode: draftMode })
    if (!result.ok) {
      setDraftError(`没能开始本地编辑：${result.message}`)
      return
    }
    setDraft(result.draft)
  }, [trip, draft, aiOpen, draftMode])

  /** 编辑期间用户换了出行方式：对未打开的草稿没有影响；草稿打开后选择被禁用 */
  const handleDraftModeChange = useCallback((mode: TravelMode) => {
    setDraftMode(mode)
  }, [])

  /**
   * 应用草稿成功：采纳新 fork Trip 为当前行程。旧错误与请求归属提示清空；
   * 保留仍然有效的日签；清掉已经不存在的选中站点；保留一次应用前快照供撤销应用。
   * 应用不会写 localStorage：用户之后仍需显式保存。
   */
  const handleDraftApply = useCallback((result: DraftApplySuccess) => {
    if (!result.changed) return
    // 内部 fork：同一工作区保留 sidecar / budget，只重绑 tripId；capture 在开始编辑前已捕获。
    const committed = commitInternalTripFork(result.trip, draftWorkspaceCaptureRef.current)
    if (!committed.ok) return
    draftWorkspaceCaptureRef.current = null
    undoApplyRef.current = trip
    setCanUndoApply(true)
    setDraft(null)
    setDraftError(null)
    setEditorEditing(false)
    updateEditorInputDirty(false)
    if (!committed.projected) {
      setTrip(result.trip)
      bumpTripRevision()
      rebindBudgetOwnerAfterTripChange(result.trip)
    }
    setPhase('ready')
    setError(null)
    setRequestOutcome({ kind: 'none' })
    // 新副本不是本浏览器保存的那份记录，不能继续显示「从已保存副本恢复」
    setRestoredAt(null)
    setAppliedNotice(
      '已把草稿应用成当前行程（新的行程副本）。这一步不会自动保存，需要保存请再点「保存当前行程」；' +
        '导出日历会生成新副本，不会更新之前导入的日历事件。',
    )
    const appliedDayValid = result.trip.days.some((d) => d.day === activeDay)
    if (!appliedDayValid) setActiveDay(result.trip.days[0]?.day ?? 1)
    setActiveStopId((current) =>
      current && result.trip.days.some((d) => d.stops.some((s) => s.id === current)) ? current : null,
    )
    scrollToItinerary()
  }, [
    trip,
    activeDay,
    bumpTripRevision,
    rebindBudgetOwnerAfterTripChange,
    commitInternalTripFork,
    scrollToItinerary,
    updateEditorInputDirty,
  ])

  /** 放弃草稿：回到原视图；原行程从未被改过，无需恢复 */
  const handleDraftDiscard = useCallback(() => {
    draftWorkspaceCaptureRef.current = null
    setDraft(null)
    setDraftError(null)
    setEditorEditing(false)
    updateEditorInputDirty(false)
  }, [updateEditorInputDirty])

  /** 撤销应用：回到应用前的那个行程。只影响当前视图，不删除用户已显式保存的副本 */
  const handleUndoApply = useCallback(() => {
    const snapshot = undoApplyRef.current
    if (!snapshot || !canUndoApply) return
    // 撤销应用也是内部 fork：回到应用前行程，同时保留工作区 sidecar / budget。
    const committed = commitInternalTripFork(snapshot)
    if (!committed.ok) return
    undoApplyRef.current = null
    setCanUndoApply(false)
    setDraft(null)
    setDraftError(null)
    setEditorEditing(false)
    updateEditorInputDirty(false)
    if (!committed.projected) {
      setTrip(snapshot)
      bumpTripRevision()
      rebindBudgetOwnerAfterTripChange(snapshot)
    }
    setPhase('ready')
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setRestoredAt(null)
    setAppliedNotice('已撤销应用，回到应用前的行程。已显式保存过的记录不受影响。')
    const dayValid = snapshot.days.some((d) => d.day === activeDay)
    if (!dayValid) setActiveDay(snapshot.days[0]?.day ?? 1)
    setActiveStopId((current) =>
      current && snapshot.days.some((d) => d.stops.some((s) => s.id === current)) ? current : null,
    )
    scrollToItinerary()
  }, [
    canUndoApply,
    activeDay,
    bumpTripRevision,
    rebindBudgetOwnerAfterTripChange,
    commitInternalTripFork,
    scrollToItinerary,
    updateEditorInputDirty,
  ])

  /* ───────── AI 单日调整：打开 / 请求适配 / 应用 / 关闭 ───────── */

  /**
   * 打开 AI 单日调整面板。和进入本地编辑一样，先作废并中止在飞的规划 / 示例请求，
   * 清掉旧错误与请求归属，避免迟到的结果在面板打开期间覆盖页面。
   * 草稿与 AI 面板互斥：有草稿时入口按钮被禁用，草稿输入不会被清掉。
   */
  const handleOpenAiPanel = useCallback(() => {
    if (!trip || draft || aiOpen || mapOpen) return
    const runtime = workspaceController.getRuntime()
    aiWorkspaceCaptureRef.current = runtime?.capture ?? null
    aiPlanningEpochRef.current = runtime?.epoch ?? workspaceController.epoch
    setAiPlanningAck(null)
    // 与 AI 行程助手互斥：两个面板都改行程，同时开着只会互相作废对方的候选。
    setAssistantOpen(false)
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    aiRequestSeqRef.current += 1
    setPlanLoading(false)
    setPlanCancelled(false)
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setDraftError(null)
    setAiOpen(true)
    // 面板打开期间本日资料收起卸载：不保留旧结果，也不自动重查
    setPoiSourcesOpen(false)
    // 网页资料面板同样收起卸载：面板自身 cleanup 已作废在途请求
    setWebSourcesOpen(false)
  }, [trip, draft, aiOpen])

  /** 关闭面板：作废在途候选请求；当前行程不变，也不代表服务端停止处理。 */
  const handleCloseAiPanel = useCallback(() => {
    aiRequestSeqRef.current += 1
    setAiPlanningAck(null)
    setAiOpen(false)
  }, [])

  /**
   * 面板实时输入代际变化（指令 / 方式 / 人数 / 范围 / 锚点 / 行程内容 / day）：
   * 清除挂起的 U 级确认入口。提交侧另有同步 final guard（比较面板 live 快照），
   * 不依赖这里的 effect 时序。
   */
  const handleAiPlanningInputChanged = useCallback(() => {
    setAiPlanningAck(null)
  }, [])

  /**
   * 面板的请求适配器：复用既有 postJson / replanDay 客户端与取消、超时、错误分类。
   * 有效的成功响应说明模型服务确实可用，可以把 planner 记为 ready；
   * 但只有仍是当前请求序号时才允许改后端结论——关闭面板、重新生成、应用成功后，
   * 旧请求即使迟到也不能把更新的健康 / 失败结论翻回去。
   */
  const handleAiRequestDay = useCallback<DayReplanAdapter>(
    (request, options) => {
      const seq = aiRequestSeqRef.current + 1
      aiRequestSeqRef.current = seq
      const conclusionAtStart = backendConclusionSeqRef.current
      return replanDay(request, options).then(
        (response) => {
          if (aiRequestSeqRef.current === seq) {
            businessProofRef.current += 1
            backendConclusionSeqRef.current += 1
            probeSeqRef.current += 1
            probeControllerRef.current?.abort()
            probeControllerRef.current = null
            setBackend((prev) => ({ ...markReachable(prev), planner: 'ready', probing: false }))
          }
          return response
        },
        (err: unknown) => {
          if (aiRequestSeqRef.current === seq) {
            const failure = requestFailureOf(err)
            if (failure) applyRequestFailure(failure, conclusionAtStart)
          }
          throw err
        },
      )
    },
    [applyRequestFailure],
  )

  /**
   * 应用 AI 候选的最终提交：内部 fork 保留 sidecar / budget；U 级确认已经由调用方
   * 在独立动作里完成。提交失败返回 typed 失败，当前行程不变。
   */
  const finishAiApply = useCallback(
    (
      applied: Extract<DayReplanApplyResult, { ok: true }> | Extract<DayReplanTailApplyResult, { ok: true }>,
      latestTrip: Trip,
      request: DayReplanRequest,
      tailScope?: DayReplanTailScope,
    ): DayReplanApplyResult | DayReplanTailApplyResult => {
      const committed = commitInternalTripFork(applied.trip, aiWorkspaceCaptureRef.current)
      if (!committed.ok) {
        return {
          ok: false,
          reason: 'invalid_base',
          message: '工作区记录校验未通过；AI 候选未应用，当前行程保持不变。',
        }
      }
      aiWorkspaceCaptureRef.current = null
      aiRequestSeqRef.current += 1
      undoApplyRef.current = latestTrip
      setCanUndoApply(true)
      if (!committed.projected) {
        setTrip(applied.trip)
        bumpTripRevision()
        rebindBudgetOwnerAfterTripChange(applied.trip)
      }
      setPhase('ready')
      setError(null)
      setRequestOutcome({ kind: 'none' })
      // 新副本不是本浏览器保存的那份记录，不能继续显示「从已保存副本恢复」
      setRestoredAt(null)
      setAiOpen(false)
      setAiPlanningAck(null)
      const dayValid = applied.trip.days.some((d) => d.day === activeDay)
      if (!dayValid) setActiveDay(applied.trip.days[0]?.day ?? 1)
      setActiveStopId((current) =>
        current && applied.trip.days.some((d) => d.stops.some((s) => s.id === current)) ? current : null,
      )
      // 'tail' in applied 收窄 union 后按 tail.boundaryKind 分支：采用路线不再说“未重算”。
      const boundaryKind: 'unavailable' | 'navigation' =
        'tail' in applied ? applied.tail.boundaryKind : 'unavailable'
      const tailBoundaryNote =
        boundaryKind === 'navigation'
          ? `锚点与新后段首站之间的衔接路线已按两端记录坐标一并应用（高德地图 WGS84，未重新核对地址或地点身份，也不代表实时交通）。`
          : `锚点衔接路线未重算。`
      setAppliedNotice(
        tailScope !== undefined
          ? `已把第 ${request.day} 天锚点之后的 AI 后段候选应用到当前行程（新的行程副本）；前 ${tailScope.keptCount} 站与站间路线原样保留，其它天和已有保存记录都没有被它改动，${tailBoundaryNote}` +
          '这次应用本身不会自动保存，保存仍由你显式操作；导出的日历是新副本，不会更新之前导入的事件。' +
          (applied.omittedWarnings > 0
            ? ` 有 ${applied.omittedWarnings} 条提醒因 ${MAX_REPLAN_WARNINGS} 条上限被省略，具体见行程提醒里的说明。`
            : '') +
          (openedFromFile
            ? ' 这份行程来自导入文件：本次只替换了这一天，其余内容仍未向服务器核对。'
            : '') +
          (applied.trip.source === 'example' ? ' 这次应用保留了原来的示例行程身份。' : '')
          : `已把第 ${request.day} 天的 AI 候选应用到当前行程（新的行程副本）；这次应用只替换这一天，其它天和已有保存记录都没有被它改动。` +
          '这次应用本身不会自动保存，保存仍由你显式操作；导出的日历是新副本，不会更新之前导入的事件。' +
          (applied.omittedWarnings > 0
            ? ` 有 ${applied.omittedWarnings} 条提醒因 ${MAX_REPLAN_WARNINGS} 条上限被省略，具体见行程提醒里的说明。`
            : '') +
          (openedFromFile
            ? ' 这份行程来自导入文件：本次只替换了这一天，其余内容仍未向服务器核对。'
            : '') +
          (applied.trip.source === 'example' ? ' 这次应用保留了原来的示例行程身份。' : ''),
      )
      scrollToItinerary()
      return applied
    },
    [
      activeDay,
      bumpTripRevision,
      rebindBudgetOwnerAfterTripChange,
      commitInternalTripFork,
      openedFromFile,
      scrollToItinerary,
    ],
  )

  /**
   * 面板里点了「应用候选」：父级用最新行程引用与统一 revision 重新走 applyDayReplan，
   * 绝不直接 setTrip 旧响应。工作区关联时先核对预览前的实际引用 + epoch，再在最终
   * 候选上跑 F2 的 H/U 门；H 硬冲突直接拒绝，U 级要求独立确认后才提交。
   */
  const handleAiApply = useCallback(
    (
      request: DayReplanRequest,
      response: DayReplanResponse,
      tailScope?: DayReplanTailScope,
      boundary?: TailBoundarySelection,
      boundaryCurrent?: TailBoundaryCurrent,
    ): DayReplanApplyResult | DayReplanTailApplyResult => {
      const latestTrip = tripRef.current
      if (!latestTrip) {
        return { ok: false, reason: 'invalid_base', message: '当前没有可应用的行程，AI 候选未应用。' }
      }
      if (tailScope === undefined && boundary !== undefined) {
        return {
          ok: false,
          reason: 'invalid_boundary',
          message: '衔接路线必须与后段候选一起应用；当前没有后段范围，衔接路线未应用。',
        }
      }
      const runtime = workspaceController.getRuntime()
      const revision = planningRevisionRef.current
      if (runtime !== null) {
        if (
          runtime.record.trip !== latestTrip ||
          runtime.epoch !== aiPlanningEpochRef.current ||
          runtime.record.workspaceRevision !== revision
        ) {
          return {
            ok: false,
            reason: 'invalid_base',
            message: '工作区或行程在候选预览后已变化；请关闭面板后重新生成候选。',
          }
        }
      }
      // 只有 scope === undefined 才走旧整天应用；任何有参（含非法 falsy 值）都走后段
      // 应用路径并由 verifyTailScope 做类型化失败，绝不降级成整天替换。
      const applied =
        tailScope === undefined
          ? applyDayReplan({
              baseTrip: latestTrip,
              request,
              response,
              currentRevision: revision,
              forkTripId: newUuid(),
            })
          : applyDayReplanTail({
              baseTrip: latestTrip,
              scope: tailScope,
              request,
              response,
              currentRevision: revision,
              forkTripId: newUuid(),
              boundary,
              current:
                boundary !== undefined
                  ? {
                      trip: latestTrip,
                      candidate: response,
                      scope: tailScope,
                      revision,
                      contentEpoch: boundaryCurrent?.contentEpoch ?? Number.NaN,
                      inputEpoch: boundaryCurrent?.inputEpoch ?? Number.NaN,
                      boundaryEpoch: boundaryCurrent?.boundaryEpoch ?? Number.NaN,
                    }
                  : undefined,
            })
      if (!applied.ok) return applied

      if (runtime !== null) {
        const scope: PlanScopeV1 =
          tailScope === undefined
            ? { scope: 'day', day: request.day, anchorStopId: null }
            : { scope: 'day_tail', day: tailScope.day, anchorStopId: tailScope.anchorStopId }
        const constraints = scopedConstraintsForDay(runtime.record, scope.day ?? request.day)
        const evaluation = evaluateConstraintsAgainstTrip({
          constraints,
          trip: applied.trip,
          sourceTrip: latestTrip,
          record: runtime.record,
          planScope: scope,
        })
        if (!evaluation.ok) {
          return { ok: false, reason: 'request_mismatch', message: evaluation.message }
        }
        if (evaluation.verdict === 'blocked') {
          return {
            ok: false,
            reason: 'request_mismatch',
            message: '存在 H 级硬冲突；AI 候选不能应用，也不能靠用户确认绕过。',
          }
        }
        if (evaluation.requiresAck) {
          setAiPlanningAck({
            applied,
            request,
            response,
            ...(tailScope === undefined ? {} : { tailScope }),
            ...(boundary === undefined ? {} : { boundary }),
            ...(boundaryCurrent === undefined ? {} : { boundaryCurrent }),
            latestTrip,
            record: runtime.record,
            capture: aiWorkspaceCaptureRef.current,
            epoch: aiPlanningEpochRef.current,
            revision,
            live: aiPlanningLiveRef.current,
            message: '候选含未核实时间端：必须独立确认「仍采用含未核实时间方案」后才能应用。',
          })
          return {
            ok: false,
            reason: 'request_mismatch',
            message: '候选含未核实时间端；请在面板下方独立确认后再应用。',
          }
        }
      }

      return finishAiApply(applied, latestTrip, request, tailScope)
    },
    [workspaceController, finishAiApply],
  )

  /** U 级独立确认：重新核对当前工作区 / 行程 / revision / 面板实时输入，再提交同一份候选。 */
  const handleAiPlanningAckConfirm = useCallback(() => {
    const pending = aiPlanningAck
    if (pending === null) return
    if (tripRef.current !== pending.latestTrip) {
      setAiPlanningAck(null)
      setError({
        title: 'AI 候选已失效',
        detail: '当前行程在确认前已变化；旧确认已作废，请重新生成候选。',
      })
      return
    }
    // 同步 final guard（不等 effect / 下一 render）：面板实时输入代际必须与确认挂起时
    // 逐字段一致。指令 / 方式 / 人数 / 范围 / 锚点 / 行程内容 / day 任一变化都会推进
    // 单调 contentEpoch（A→B→A 也 +1），旧确认（连同旧点击闭包）在这里被拒。
    const live = aiPlanningLiveRef.current
    if (
      pending.live === null ||
      live === null ||
      live.contentEpoch !== pending.live.contentEpoch ||
      live.inputEpoch !== pending.live.inputEpoch ||
      live.revision !== pending.live.revision ||
      live.dayNumber !== pending.live.dayNumber ||
      live.trip !== pending.live.trip
    ) {
      setAiPlanningAck(null)
      setError({
        title: 'AI 候选已失效',
        detail:
          '调整指令 / 出行方式 / 同行人数或范围在确认前已变化；旧确认已作废，请重新生成候选。当前行程与工作区没有改动。',
      })
      return
    }
    const runtime = workspaceController.getRuntime()
    if (
      (pending.record === null && runtime !== null) ||
      (pending.record !== null &&
        (runtime === null ||
          runtime.record !== pending.record ||
          runtime.epoch !== pending.epoch))
    ) {
      setAiPlanningAck(null)
      setError({
        title: 'AI 候选已失效',
        detail: '工作区或 epoch 在确认前已变化；旧确认已作废，请重新生成候选。',
      })
      return
    }
    if (planningRevisionRef.current !== pending.revision) {
      setAiPlanningAck(null)
      setError({
        title: 'AI 候选已失效',
        detail: '工作区 revision 在确认前已变化；旧确认已作废，请重新生成候选。',
      })
      return
    }
    if (pending.record !== null) {
      const scope: PlanScopeV1 =
        pending.tailScope === undefined
          ? { scope: 'day', day: pending.request.day, anchorStopId: null }
          : {
              scope: 'day_tail',
              day: pending.tailScope.day,
              anchorStopId: pending.tailScope.anchorStopId,
            }
      const evaluation = evaluateConstraintsAgainstTrip({
        constraints: scopedConstraintsForDay(pending.record, scope.day ?? pending.request.day),
        trip: pending.applied.trip,
        sourceTrip: pending.latestTrip,
        record: pending.record,
        planScope: scope,
      })
      if (!evaluation.ok || evaluation.verdict === 'blocked') {
        setAiPlanningAck(null)
        setError({
          title: 'AI 候选未应用',
          detail: !evaluation.ok
            ? evaluation.message
            : '存在 H 级硬冲突；AI 候选不能应用，也不能靠用户确认绕过。',
        })
        return
      }
    }
    const result = finishAiApply(
      pending.applied,
      pending.latestTrip,
      pending.request,
      pending.tailScope,
    )
    if (!result.ok) {
      setAiPlanningAck(null)
      setError({ title: 'AI 候选未应用', detail: result.message })
    }
  }, [aiPlanningAck, workspaceController, finishAiApply])

  /* ───────── A 切片 · AI 行程助手（对话式行程编辑） ───────── */

  /**
   * 打开 AI 行程助手：只挂载面板，不发请求、不写存储。
   * 与单日调整面板互斥：两个面板都会改行程，同时开着只会互相作废对方的候选。
   */
  const handleOpenAssistant = useCallback(() => {
    if (!trip || draft || assistantOpen) return
    // 打开面板是显式用户动作：此时才读一次候选库（独立键，只读），
    // 让「从收藏池加入」这类指令用得上候选；不读就不读，绝不写。
    if (candidatesRecord === null) {
      const read = loadCandidatesRecord(storageRef.current)
      if (read.record !== null) setCandidatesRecord(read.record)
    }
    // 重排类建议复用既有的单日重排落地流程（handleAiApply）：那里按「候选预览时
    // 的工作区引用 + epoch」核对基准，所以这里也必须在打开面板时捕获一次。
    // 否则工作区关联时，重排候选会被判成「预览后已变化」而永远落不了地。
    const runtime = workspaceController.getRuntime()
    aiWorkspaceCaptureRef.current = runtime?.capture ?? null
    aiPlanningEpochRef.current = runtime?.epoch ?? workspaceController.epoch
    setAiOpen(false)
    setAiPlanningAck(null)
    setAssistantOpen(true)
  }, [trip, draft, assistantOpen, candidatesRecord, workspaceController])

  /** 关闭 AI 行程助手：放弃在途提案；行程与已保存记录都不动。 */
  const handleCloseAssistant = useCallback(() => {
    setAssistantOpen(false)
  }, [])

  /**
   * 应用一次对话式改动：面板已经按工作区规则算好下一条记录（workspaceRevision + 1）。
   * 有关联工作区时用 controller 的 adoptRecord 装下这条记录（notify:false，面板要保持
   * 打开并显示「已应用 / 撤销」）；没有关联工作区时只换页面行程。
   * 失败时页面完全不变，也不碰已保存的记录。
   */
  const handleAssistantApplyRecord = useCallback(
    (next: WorkspaceRecordV1): { ok: boolean; message?: string } => {
      const runtime = workspaceController.getRuntime()
      if (runtime !== null) {
        const adopted = workspaceController.adoptRecord(next, runtime.capture, { notify: false })
        if (!adopted.ok) {
          const message = adopted.message ?? '工作区记录校验失败；当前行程保持不变。'
          setError({ title: '未能应用这条建议', detail: message })
          return { ok: false, message }
        }
      }
      // 两套 undo 互不干扰：助手这一层自带独立撤销（面板里的「撤销这条建议」），
      // 页面草稿栈那条「撤销应用」回退的是助手改动之前的行程 —— 助手一旦改动行程，
      // 它就不再指向「当前行程的上一层」，留着会被误点成连带撤销助手这次改动。
      // 助手应用（含撤销）都走这里，所以这里让旧入口彻底失效。
      undoApplyRef.current = null
      setCanUndoApply(false)
      setAppliedNotice(null)
      setTrip(next.trip)
      bumpTripRevision()
      rebindBudgetOwnerAfterTripChange(next.trip)
      setActiveStopId((current) =>
        current && next.trip.days.some((d) => d.stops.some((s) => s.id === current)) ? current : null,
      )
      setPhase('ready')
      setError(null)
      setRequestOutcome({ kind: 'none' })
      setRestoredAt(null)
      return { ok: true }
    },
    [bumpTripRevision, rebindBudgetOwnerAfterTripChange, workspaceController],
  )

  /**
   * 时间偏好 / 节奏调整类建议：交给既有的单日重排通道与既有应用流程，
   * 不新增端点，也不另起一套应用逻辑。
   *
   * 这里还有第二道闸门（面板那边已经按快照拒过一次）：候选是按「请求发出时」的
   * 工作区快照算出来的，行程在别处改过旧候选就绝不套用。
   * 底下单日重排只比版本，同版本内容变了它认不出来，所以这里把内容指纹也比上。
   */
  const handleAssistantReplanApply = useCallback(
    (
      request: DayReplanRequest,
      response: DayReplanResponse,
      base?: ReplanCandidateBase,
    ) => {
      if (base !== undefined) {
        if (planningRevisionRef.current !== base.revision) {
          return {
            ok: false,
            message: '行程在候选生成之后已经改过，这条重排候选没有应用；请重新生成建议。',
          }
        }
        // 有关联工作区时按整条记录比对指纹；没关联时页面版本号每次换行程都会推进，
        // 版本核对已经够用（此时没有可跨会话漂移的工作区记录）。
        const record = currentWorkspaceRecord
        if (record !== null) {
          const printed = fingerprintOf(record)
          if (!printed.ok || !fingerprintsMatch(printed.fingerprint, base.fingerprint)) {
            return {
              ok: false,
              message:
                '行程在候选生成之后已经改过（同版本内容变化也算），这条重排候选没有应用；请重新生成建议。',
            }
          }
        }
      }
      const result = handleAiApply(request, response)
      return { ok: result.ok, message: result.ok ? undefined : result.message }
    },
    [currentWorkspaceRecord, handleAiApply],
  )

  /**
   * 单日重排请求的 planningConstraints：复用既有 F2 约束绑定（同一套 scope 口径）。
   * 没关联工作区时不发 constraints，请求体与旧行为一致。
   */
  const buildAssistantPlanningConstraints = useCallback(
    (request: DayReplanRequest): DayReplanConstraintsOptions | undefined => {
      const record = currentWorkspaceRecord
      if (record === null) return undefined
      const scope: PlanScopeV1 = { scope: 'day', day: request.day, anchorStopId: null }
      const constraints = scopedConstraintsForDay(record, request.day)
      const binding = createConstraintsBinding(record, constraints, scope, workspaceEpoch)
      if (!binding.ok) return undefined
      return { constraints, scope, record, binding: binding.value, epoch: workspaceEpoch }
    },
    [currentWorkspaceRecord, workspaceEpoch],
  )

  /* ───────── 仅刷新地图：打开 / 应用 / 关闭 ───────── */

  /**
   * 打开「仅刷新地图」面板。和 AI 面板一样，先作废并中止在飞的规划 / 示例请求，
   * 清掉旧错误与请求归属，避免迟到的结果在面板打开期间替换页面。只要求当前日存在，
   * 不要求 planner_ready：这里只用地图服务，Key 缺失由接口以 no_key 原样说明。
   */
  const handleOpenMapRefresh = useCallback(() => {
    if (!trip || !currentDay || draft || aiOpen || mapOpen) return
    mapWorkspaceCaptureRef.current = workspaceController.getRuntime()?.capture ?? null
    planSeqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    loadSeqRef.current += 1
    exampleAbortRef.current?.abort()
    exampleAbortRef.current = null
    aiRequestSeqRef.current += 1
    setPlanLoading(false)
    setPlanCancelled(false)
    setError(null)
    setRequestOutcome({ kind: 'none' })
    setDraftError(null)
    // 面板打开期间天气收起卸载：不保留旧的查询结果，也不自动重查
    setWeatherOpen(false)
    // 面板打开期间本日资料收起卸载：不保留旧结果，也不自动重查
    setPoiSourcesOpen(false)
    // 网页资料面板同样收起卸载：面板自身 cleanup 已作废在途请求
    setWebSourcesOpen(false)
    setMapOpen(true)
  }, [trip, currentDay, draft, aiOpen, mapOpen])

  /** 关闭面板：当前行程不变；面板自己负责作废在途的地图请求。 */
  const handleCloseMapRefresh = useCallback(() => {
    setMapOpen(false)
  }, [])

  /**
   * 面板里点了「应用到行程」：父级当场读取最新 trip / revision 再走 applyMapRefresh，
   * 绝不直接 setTrip 旧响应。失败原样返回给面板显示，当前行程、撤销快照和保存记录都不动；
   * changed=false 同样不替换行程。成功才进同一个「撤销应用」快照并关闭面板。
   */
  const handleMapApply = useCallback(
    (request: MapRefreshRequest, response: MapRefreshResponse): MapRefreshApplyResult => {
      const latestTrip = tripRef.current
      if (!latestTrip) {
        return { ok: false, reason: 'invalid_base', message: '当前没有可应用的行程，地图刷新未应用。' } as MapRefreshApplyResult
      }
      const applied = applyMapRefresh({
        baseTrip: latestTrip,
        request,
        response,
        currentRevision: planningRevisionRef.current,
        forkTripId: newUuid(),
      })
      if (!applied.ok || !applied.changed) return applied

      // 内部 fork：工作区关联时保留 sidecar / budget；capture 在打开面板时已捕获。
      const committed = commitInternalTripFork(applied.trip, mapWorkspaceCaptureRef.current)
      if (!committed.ok) {
        return {
          ok: false,
          reason: 'invalid_base',
          message: '工作区记录校验未通过；地图刷新未应用，当前行程保持不变。',
        } as MapRefreshApplyResult
      }
      mapWorkspaceCaptureRef.current = null

      undoApplyRef.current = latestTrip
      setCanUndoApply(true)
      if (!committed.projected) {
        setTrip(applied.trip)
        bumpTripRevision()
        rebindBudgetOwnerAfterTripChange(applied.trip)
      }
      setPhase('ready')
      setError(null)
      setRequestOutcome({ kind: 'none' })
      // 新副本不是本浏览器保存的那份记录，不能继续显示「从已保存副本恢复」
      setRestoredAt(null)
      setMapOpen(false)
      const dayValid = applied.trip.days.some((d) => d.day === activeDay)
      if (!dayValid) setActiveDay(applied.trip.days[0]?.day ?? 1)
      setActiveStopId((current) =>
        current && applied.trip.days.some((d) => d.stops.some((s) => s.id === current)) ? current : null,
      )
      setAppliedNotice(
        `本次只更新了地图相关字段：文字、时间、地址说明和其它天都沿用原安排，沿旧路线也没有重新计算。` +
          '地图耗时来自这次地图服务的估算，不保证出行当天的实时交通。' +
          '这次更新只放在当前页面，不会自动保存；需要留存请再点「保存当前行程」。' +
          '可以点「撤销应用」回到更新前的行程；之前显式保存过的记录和导入的文件内容都不会被改动。',
      )
      scrollToItinerary()
      return applied
    },
    [
      activeDay,
      bumpTripRevision,
      rebindBudgetOwnerAfterTripChange,
      commitInternalTripFork,
      scrollToItinerary,
    ],
  )

  /**
   * 规划请求归属说明：有失败/停止/进行中，且页面有行程可看时，
   * 在行程标题旁注明「下方内容属于哪次结果」，避免旧行程被误读成新请求的答案。
   * pending 且 planLoading 时也显示——用户可能正在看行程区，需要知道下面是旧结果。
   */
  const outcomeNote = (() => {
    if (!trip) return null
    const dest =
      requestOutcome.kind !== 'none' && requestOutcome.destination ? `「${requestOutcome.destination}」` : ''
    switch (requestOutcome.kind) {
      case 'pending':
        return `正在生成${dest}的新行程；下方显示的仍是上一次的结果，生成完成后会自动替换。`
      case 'failed':
        return `刚才为${dest}生成行程的请求没有成功，本次没有生成新行程；下方显示的是上一次的结果，可以继续浏览。可修改参数后重新提交。`
      case 'stopped':
        return `已停止等待${dest || '这次'}的规划请求，本次没有拿到新行程；下方显示的是上一次的结果，可以继续浏览。`
      default:
        return null
    }
  })()

  // 只有后端明确返回 planner_ready=false 才锁提交；unknown 保持旧行为，照常允许
  const plannerUnavailable = backend.reachable && backend.planner === 'unavailable'
  const backendVisual = !backend.checked
    ? 'unknown'
    : !backend.reachable
      ? 'down'
      : plannerUnavailable
        ? 'degraded'
        : 'ok'
  /**
   * 失败原因一律用前端固定句，不回显后端 warnings（绝对路径、疑似密钥会被带进页面）。
   * 探活失败和业务失败各说各的：业务错误不借用健康检查的口径。
   */
  const backendHint = !backend.checked || backend.reachable
    ? null
    : backend.failureSource === 'request'
      ? REQUEST_FAILURE_HINT
      : backend.failure
        ? PROBE_FAILURE_HINT[backend.failure]
        : null
  // 状态胶囊里的一句话；结论不因重新检测而消失，进行中状态另加后缀（见 JSX）
  const backendStatusLabel = !backend.checked
    ? '正在检查后端…'
    : !backend.reachable
      ? backend.failureSource === 'request'
        ? '最近一次请求没成功——后端状态未确认'
        : '后端未连接——规划暂不可用'
      : plannerUnavailable
        ? '后端在线，规划暂不可用'
        : (
          <>
            <span>后端服务正常</span>
            <span className="tracking-[0.04em] text-[color:var(--color-secondary-foreground)]">
              {' · '}
              {backend.planner === 'ready' ? '可以生成行程' : '规划能力未知'}
              {backend.amap === 'not_configured' && ' · 地图 Key 未配置'}
            </span>
          </>
        )

  /**
   * 地图 Key 的说明只描述「当前后端服务」：它解释不了某份行程里坐标为什么缺
   * ——导入/恢复的行程由当时的生成环境决定，这里不能替历史结果背书。
   */
  const amapNote = backend.checked && backend.reachable && backend.amap === 'not_configured'
    ? '当前后端服务没有配置地图 Key：新规划的行程不会有站点坐标和导航路线。已经生成的行程（包括导入或恢复的）不受此说明影响，它们的坐标取决于各自生成时的服务配置。'
    : null

  const workspaceBudgetSnapshot = budgetSnapshotOfSession(budgetSession)
  const workspaceBudgetDirty =
    workspaceController.workspace !== null &&
    !canonicalValuesEqual(workspaceController.workspace.budget, workspaceBudgetSnapshot)

  /** 渲染期读取 controller 实际 refs：只用于给 F2 面板 / 离线导出传当前 capture。 */
  const workspaceRuntime = workspaceController.getRuntime()
  const constraintsScope: PlanScopeV1 | null =
    currentWorkspaceRecord === null
      ? null
      : {
          scope: 'day',
          day: currentWorkspaceRecord.trip.days.some((d) => d.day === activeDay)
            ? activeDay
            : (currentWorkspaceRecord.trip.days[0]?.day ?? 1),
          anchorStopId: null,
        }
  const constraintsRuntimeCapture =
    workspaceRuntime !== null && workspaceRuntime.record === currentWorkspaceRecord
      ? workspaceRuntime.capture
      : null

  /**
   * AI 单日 / 后段的 F2 planning context：只发当前天 + 全局约束；binding 绑定
   * 当前内存 record / revision / epoch。父级在面板渲染时捕获，不用请求时现取。
   */
  const aiPlanningContext = (() => {
    if (currentWorkspaceRecord === null || trip === null) return null
    if (currentWorkspaceRecord.trip !== trip) return null
    const day = currentWorkspaceRecord.trip.days.some((d) => d.day === activeDay)
      ? activeDay
      : currentWorkspaceRecord.trip.days[0]?.day
    if (day === undefined) return null
    const constraints = scopedConstraintsForDay(currentWorkspaceRecord, day)
    const record = currentWorkspaceRecord
    const epoch = workspaceEpoch
    return {
      constraints,
      record,
      epoch,
      createBinding: (scope: PlanScopeV1) => {
        const result = createConstraintsBinding(record, constraints, scope, epoch)
        return result.ok
          ? ({ ok: true, value: result.value } as const)
          : ({ ok: false, message: result.message } as const)
      },
    }
  })()

  /**
   * F3 没有打开草稿时用于「加入草稿」预览的临时 base；确认加入后才进入编辑。
   * 必须 useMemo 稳定：forkTripId 只随真实业务上下文（当前 Trip 副本 / 新路段方式）
   * 重新生成。若每次 render 都 newUuid()，切日期页签等无关渲染也会换掉 forkTripId，
   * CandidatePoolPanel 的 draftKey 随之失配，把「加入草稿」预览静默作废。
   * Trip / draftMode 变化 = 真实 owner / 输入上下文变化，此时旧预览本就应当失效。
   */
  const candidateDraftBase = useMemo(() => {
    if (trip === null) return null
    const result = createTripDraft(trip, { forkTripId: newUuid(), newLegMode: draftMode })
    return result.ok ? result.draft : null
  }, [trip, draftMode])
  const candidateCopySources: readonly CandidateStopSource[] = (() => {
    const sourceDays = draft?.days ?? trip?.days ?? []
    const sources: CandidateStopSource[] = []
    for (const day of sourceDays) {
      for (const stop of day.stops) {
        sources.push({
          stopId: stop.id,
          name: stop.name,
          address: stop.address ?? null,
          location: stop.location ?? null,
          day: day.day,
        })
      }
    }
    return sources
  })()

  /* ── W4 全局 shell：app.css 旧规则迁为工具类（UI_DESIGN §4 映射表） ──
   * 旧 .app-shell/.app-header/.brand/.app-main/.app-footer/ 入口卡类/
   * 出行方式切换/.day-tab/.error-banner/.skeleton/.visually-hidden/.wsh-* 等退役；
   * 提示条（edit-pause / day-switch / ai-pause / edit-pause-note）共用一组警示条样式。 */
  const SHELL = 'flex min-h-screen flex-col'
  const HEADER =
    'flex flex-wrap items-center gap-4 border-b border-[color:var(--color-line-strong)] bg-card px-6 py-4 max-[640px]:px-4 max-[640px]:py-3'
  const BRAND = 'flex items-baseline gap-3'
  const BRAND_MARK = 'font-display text-xl font-bold tracking-[0.06em] text-[color:var(--color-accent-foreground)]'
  const BRAND_SUB = 'text-xs tracking-[0.08em] text-muted-foreground'
  const MAIN = 'mx-auto w-full max-w-[1440px] flex-1 p-6 max-[640px]:p-4'
  const FOOTER =
    'flex flex-wrap gap-x-4 gap-y-2 border-t border-[color:var(--color-border)] px-6 py-4 text-xs text-[color:var(--color-faint)]'
  const TOPBAR_PROGRESS =
    'relative h-[2px] overflow-hidden bg-[color:var(--color-border)] after:absolute after:inset-y-0 after:left-0 after:hidden after:w-2/5 after:bg-[color:var(--color-primary)] data-[active=true]:after:block data-[active=true]:after:animate-[progress-slide_1.1s_var(--ease-in-out)_infinite]'
  const ENTRY_CARD =
    'mb-6 grid max-w-[72ch] gap-3 rounded-[10px] border border-[color:var(--color-line-strong)] bg-card p-4'
  const AI_ENTRY =
    'mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[10px] border border-[color:var(--color-line-strong)] bg-card p-4'
  const AI_ENTRY_COPY = 'grid min-w-0 flex-[1_1_320px] gap-1'
  const AI_ENTRY_COPY_P = 'm-0'
  const AI_ENTRY_ACTIONS = 'flex flex-col items-start gap-2 max-[640px]:w-full max-[640px]:items-stretch'
  const AI_PANEL_SLOT = 'mb-5 grid min-w-0 gap-3'
  const ENTRY_LABEL = 'm-0 text-sm font-semibold text-[color:var(--color-secondary-foreground)]'
  const ENTRY_HELP = 'm-0 text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]'
  const ENTRY_ACTIONS =
    'flex flex-wrap items-center gap-4 max-[640px]:flex-col max-[640px]:items-stretch max-[640px]:[&>button]:w-full'
  const ENTRY_ERROR = 'm-0 text-xs text-[color:var(--color-accent-foreground)]'
  const MODE_TOGGLE = 'flex gap-2'
  const MODE_OPTION =
    'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-4 py-2 transition-colors duration-150 ease-out hover:bg-secondary has-[input:checked]:border-[color:var(--color-primary)] has-[input:checked]:bg-accent-surface'
  const MODE_RADIO =
    'size-4 shrink-0 accent-[color:var(--color-primary)] outline-2 outline-offset-2 outline-[color:var(--color-accent-foreground)] focus-visible:outline'
  const WARN_NOTE =
    'border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] px-3 py-2 text-sm leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]'
  const EDIT_PAUSE_LEGEND = `${WARN_NOTE} m-0 mb-3 rounded-r-[6px]`
  const EDIT_PAUSE_NOTE = `m-0 rounded-r-[6px] ${WARN_NOTE}`
  const DAY_SWITCH_NOTE = `-mt-2 mb-4 rounded-r-[6px] ${WARN_NOTE}`
  const AI_PAUSE_NOTE = `m-0 max-w-[72ch] rounded-r-[6px] ${WARN_NOTE}`
  const PLAN_CANCEL_STATUS =
    'm-0 max-w-[72ch] rounded-r-[6px] text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]'
  const ERROR_BANNER =
    'mb-5 flex flex-wrap items-start gap-3 rounded-r-[6px] border border-[color:var(--color-line-strong)] border-l-[3px] border-l-[color:var(--color-primary)] bg-accent-surface px-4 py-3'
  const ERROR_BANNER_P =
    'm-0 flex min-w-[200px] flex-1 text-sm leading-relaxed text-[color:var(--color-foreground)] [overflow-wrap:anywhere]'
  const SAVED_OFFLINE = 'mb-6'
  const SAVED_OFFLINE_NOTE =
    'm-0 mb-3 max-w-[72ch] text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]'
  const RESTORED_NOTE =
    'mt-3 rounded-r-[6px] border-l-[3px] border-l-[color:var(--color-ok)] bg-secondary px-3 py-2 text-xs leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]'
  const TRIP_HEADER = 'mb-6 max-w-[72ch]'
  const TRIP_HEAD_ROW = 'flex flex-wrap items-baseline gap-3'
  const TRIP_SOURCE_TAG =
    'mb-3 inline-block rounded-full border border-[color:var(--color-line-strong)] px-[10px] py-[3px] text-xs font-semibold tracking-[0.1em] data-[source=example]:border-[color:var(--color-primary)] data-[source=example]:bg-accent-surface data-[source=example]:text-[color:var(--color-accent-foreground)] data-[source=agent]:bg-secondary data-[source=agent]:text-[color:var(--color-secondary-foreground)]'
  const TRIP_OUTCOME_NOTE =
    'm-0 min-w-0 flex-[1_1_260px] rounded-r-[6px] border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] px-3 py-1 text-xs leading-[1.6] text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]'
  const TRIP_TITLE =
    'mb-3 font-display text-[length:var(--text-display)] font-bold leading-[1.3] [overflow-wrap:anywhere] focus:outline-none'
  const TRIP_SUMMARY = 'm-0 max-w-[66ch] leading-relaxed text-[color:var(--color-secondary-foreground)]'
  const APPLY_RESULT_NOTE =
    'mb-5 flex flex-wrap items-center gap-3 rounded-r-[6px] border-l-[3px] border-l-[color:var(--color-ok)] bg-secondary px-4 py-3'
  const APPLY_RESULT_P =
    'm-0 min-w-0 flex-[1_1_320px] text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]'
  const WSH_TOOLS = 'mt-2 grid min-w-0 gap-3 border-t border-[color:var(--color-line-strong)] pt-3'
  const WSH_TOOLS_HEAD = 'flex flex-wrap items-start justify-between gap-3'
  const WSH_EYEBROW = 'm-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-foreground)]'
  const WSH_TOOL_NOTE =
    'm-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]'
  const WSH_TOOL_ACTIONS = 'flex flex-wrap gap-2 max-[640px]:flex-col max-[640px]:[&>button]:w-full'
  const WSH_TOOL_PANEL = 'grid min-w-0 gap-2'
  const WSH_BTN =
    'inline-flex min-h-9 cursor-pointer items-center justify-center rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-3 py-2 text-sm leading-[1.4] transition-colors duration-150 ease-out hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent-foreground)] disabled:pointer-events-none disabled:opacity-55'
  const WSH_BTN_PRIMARY =
    `${WSH_BTN} border-[color:var(--color-accent-foreground)] bg-[color:var(--color-accent-foreground)] font-semibold text-[color:var(--color-card)] hover:bg-primary hover:border-primary`
  const DAY_NAV = 'mb-5 flex flex-wrap gap-2'
  const DAY_TAB =
    'inline-flex min-h-11 min-w-19 cursor-pointer flex-col items-start rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-3 py-2 text-left transition-colors duration-150 ease-out aria-disabled:cursor-not-allowed aria-disabled:opacity-70 aria-selected:border-[color:var(--color-primary)] aria-selected:bg-accent-surface hover:bg-secondary hover:aria-selected:bg-accent-surface hover:aria-selected:border-[color:var(--color-primary)]'
  const DAY_TAB_NUM =
    'font-mono text-xs text-muted-foreground aria-selected:text-[color:var(--color-accent-foreground)]'
  const DAY_TAB_TITLE =
    'font-display text-[15px] leading-snug text-[color:var(--color-foreground)] [overflow-wrap:anywhere]'
  const SKELETON_BLOCK = 'rounded-[14px] border border-[color:var(--color-border)] bg-card p-5'
  const SKELETON_LINE =
    'h-[14px] w-2/5 rounded-[4px] bg-[linear-gradient(90deg,var(--color-secondary)_25%,var(--color-border)_50%,var(--color-secondary)_75%)] bg-[length:200%_100%] animate-[shimmer_1.4s_linear_infinite]'
  const TRIP_LAYOUT =
    'grid grid-cols-1 items-start gap-6 min-[901px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'
  const ITINERARY_PANE = 'min-w-0'
  const MAP_PANE = 'min-w-0 max-[900px]:static min-[901px]:sticky min-[901px]:top-4'
  const DRAFT_PREVIEW_NOTE =
    'mt-4 max-w-[72ch] rounded-r-[6px] border-l-[3px] border-l-[color:var(--color-line-strong)] bg-secondary px-3 py-2 text-xs leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]'
  const TRIP_TRANSFER_SLOT = 'mt-6 grid justify-items-start gap-2'

  return (
    <div className={SHELL}>
      <a className="sr-only focus:not-sr-only focus:static focus:m-0 focus:rounded-[6px] focus:bg-card focus:px-3 focus:py-2 focus:underline" href="#trip-section">跳到行程内容</a>

      <header className={HEADER}>
        <div className={BRAND}>
          <span className={BRAND_MARK}>路书</span>
          <span className={BRAND_SUB}>智能出行助手 · 逐日路线与中文讲解</span>
        </div>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex items-center gap-2 text-sm text-[color:var(--color-secondary-foreground)]"
            data-testid="backend-state"
            data-state={backendVisual}
          >
            <span
              className={`size-2 shrink-0 rounded-full ${
                backendVisual === 'degraded'
                  ? 'bg-[color:var(--color-warn-ink)]'
                  : backendVisual === 'unknown'
                    ? 'border border-[color:var(--color-line-strong)] bg-transparent'
                    : 'bg-[color:var(--color-ok)]'
              }`}
              aria-hidden="true"
            />
            {/* role=status 自带 polite 播报：重新检测的开始 / 结束都会念出来 */}
            <span role="status" aria-live="polite">
              {backendStatusLabel}
              {backend.probing && backend.checked && (
                <span className="text-[color:var(--color-faint)]">{' · '}正在重新检测…</span>
              )}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={runProbe}
            aria-busy={backend.probing || undefined}
            aria-describedby={backendHint ? BACKEND_HINT_ID : undefined}
            title="重新探测后端健康状态，不会刷新页面"
          >
            重新检测
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {backendHint && (
        <p className="m-0 border-b border-b-[color:var(--color-line-strong)] bg-secondary px-4 py-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]" id={BACKEND_HINT_ID}>
          {backendHint}
        </p>
      )}

      {amapNote && (
        <p className="m-0 border-b border-b-[color:var(--color-line-strong)] bg-secondary px-4 py-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {amapNote}
        </p>
      )}

      <div className={TOPBAR_PROGRESS} data-active={planLoading || phase === 'loading'} aria-hidden="true" />

      <main className={MAIN}>
        {/*
          本地编辑期间把规划表单整体包进 disabled fieldset：控件禁用且读屏会念出
          「已暂停」的说明。不传 loading=true——那会假装 AI 正在生成。
        */}
        <fieldset className="m-0 min-w-0 border-0 p-0 disabled:opacity-75" disabled={interactionPaused}>
          {editPauseNote && <legend className={EDIT_PAUSE_LEGEND}>{editPauseNote}</legend>}
          <PlanForm
            onSubmit={handlePlan}
            loading={planLoading}
            onCancel={handleStopWaiting}
            plannerUnavailable={plannerUnavailable}
          />
        </fieldset>

        {planCancelled && !planLoading && (
          <p className={PLAN_CANCEL_STATUS} role="status">
            已停止等待这次规划，可以立刻改参数重新提交；旧响应即使到达也会被忽略。
            这个动作只取消本页的等待，不能保证后端或上游模型立即停止处理，也不能保证不再计费。
          </p>
        )}

        {error && (
          <div className={ERROR_BANNER} role="alert">
            <p className={ERROR_BANNER_P}>
              <span className="font-semibold">{error.title}。</span>
              {error.detail}
            </p>
            {phase === 'failed' && (
              <Button onClick={() => window.location.reload()} className="min-h-11 px-5 text-base">重试</Button>
            )}
          </div>
        )}

        {phase === 'loading' && (
          <div aria-busy="true" aria-label="正在加载示例行程">
            <div className={SKELETON_BLOCK}>
              <div className={`${SKELETON_LINE} w-2/5`} />
              <div className={`${SKELETON_LINE} mt-3 w-4/5`} />
              <div className={`${SKELETON_LINE} mt-3 w-3/5`} />
            </div>
          </div>
        )}

        {!trip && (phase === 'loading' || phase === 'failed') && (
          <div className={SAVED_OFFLINE}>
            <p className={SAVED_OFFLINE_NOTE}>
              {phase === 'failed'
                ? '后端暂时不可用。这个浏览器里保存过的行程仍可离线恢复；恢复后可以继续查看，重新规划需要等后端恢复。'
                : '示例行程还在加载。这个浏览器里保存过的行程可以现在就恢复，不必等示例返回。'}
            </p>
            <SavedTripsPanel trip={null} onRestore={handleRestoreSavedTrip} />
          </div>
        )}

        <div ref={itineraryTopRef} id="trip-section" />
        {trip && (
          <section aria-label="行程安排" data-trip-revision={tripRevision}>
            <header className={TRIP_HEADER}>
              <div className={TRIP_HEAD_ROW}>
                <span className={TRIP_SOURCE_TAG} data-source={trip.source}>
                  {tripIsExample ? '示例行程' : 'AI 规划'}
                </span>
                {lastPlannedPace !== null && !tripIsExample && (
                  <span className={TRIP_SOURCE_TAG} data-testid="pace-tag" data-pace={lastPlannedPace}>
                    按{paceLabelOf(lastPlannedPace)}节奏
                  </span>
                )}
                {outcomeNote && (
                  /*
                   * 归属说明是当前请求/视图的临时状态：不写进 trip，保存/备份不会带上它。
                   * 失败细节由 role=alert 的错误横幅播报，这里只做视觉归属标注，
                   * 不再挂 live region，避免同一事件被读屏播报两遍。
                   */
                  <p className={TRIP_OUTCOME_NOTE} data-testid="request-status-note">
                    {outcomeNote}
                  </p>
                )}
              </div>
              <h2 className={TRIP_TITLE} ref={tripTitleRef} tabIndex={-1}>{trip.title}</h2>
              <p className={TRIP_SUMMARY}>{trip.summary}</p>
              {trip.warnings.length > 0 && (
                <div className="mt-4 rounded-r-[6px] border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] px-4 py-3">
                  <ul className="m-0 grid list-none gap-1 p-0">
                    {trip.warnings.map((w, i) => (
                      <li key={i} className="text-sm text-[color:var(--color-warn-ink)]">{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {restoredAt != null && !editingDraft && (
                <p className={RESTORED_NOTE}>
                  从本浏览器保存的副本恢复 · 保存于 {formatDateTime(restoredAt)}。这份副本不会同步到其他设备。
                </p>
              )}
              {openedFromFile && !editingDraft && (
                /*
                 * 来源说明：source 是文件里写的内容，标签本身证明不了真实来源。
                 * 样式沿用原 .trip-restored-note 的语义（成功恢复提示）。
                 */
                <p className={RESTORED_NOTE} data-note="imported-file">
                  这份行程来自你选择的备份文件：页面没有向服务器核对过内容。打开文件这个动作不会自动保存；
                  想把它留在这台电脑上，请在下面的「行程备份与导入」里点「保存到本地」。
                  上面的「示例行程 / AI 规划」标签取自文件里的 source 字段，只代表文件自己这么写，不能证明它的真实来源。
                </p>
              )}
            </header>

            {appliedNotice && !editingDraft && !aiOpen && !mapOpen && (
              <div className={APPLY_RESULT_NOTE} data-testid="apply-notice">
                <p className={APPLY_RESULT_P} role="status">{appliedNotice}</p>
                {canUndoApply && (
                  <Button type="button" variant="ghost" onClick={handleUndoApply} className="min-h-9">
                    撤销应用
                  </Button>
                )}
              </div>
            )}

            {!editingDraft && !aiOpen && !mapOpen && (
              <>
                <SavedTripsPanel trip={trip} onRestore={handleRestoreSavedTrip} />
                <IcsExportPanel trip={trip} key={`ics:${trip.id}`} />
                <WorkspaceHub
                  workspace={workspaceController.workspace}
                  workspaceStatus={workspaceController.workspaceStatus}
                  workspaceMessage={workspaceController.workspaceMessage}
                  workspaceExternallyChanged={workspaceController.workspaceExternallyChanged}
                  versions={workspaceController.versions}
                  versionsStatus={workspaceController.versionsStatus}
                  versionsMessage={workspaceController.versionsMessage}
                  versionsLoaded={workspaceController.versionsLoaded}
                  versionsExternallyChanged={workspaceController.versionsExternallyChanged}
                  epoch={workspaceController.epoch}
                  busy={workspaceController.busy}
                  canWrite={workspaceController.canWrite}
                  undoProposal={workspaceController.undoProposal}
                  notice={workspaceController.notice}
                  budgetDirty={workspaceBudgetDirty}
                  onOpenWorkspace={() => {
                    workspaceController.openWorkspace()
                  }}
                  onCreateWorkspace={() => {
                    workspaceController.createWorkspace({
                      trip,
                      budget: budgetSnapshotOfSession(budgetSession),
                      label: trip.title,
                    })
                  }}
                  onOpenVersions={() => {
                    workspaceController.openVersions()
                  }}
                  onSaveWorkspace={() => {
                    void workspaceController.saveWorkspace(budgetSnapshotOfSession(budgetSession))
                  }}
                  onDetach={() => {
                    workspaceController.detach()
                  }}
                  onSaveVersion={(request) => {
                    void workspaceController.saveVersion(request.name)
                  }}
                  onAdoptVersion={(proposal) => {
                    workspaceController.adoptVersion(proposal)
                  }}
                  onUndoAdopt={(proposal) => {
                    workspaceController.undoAdopt(proposal)
                  }}
                  onImportVersions={(preview) => {
                    void workspaceController.importVersions(preview)
                  }}
                  onDownloadVersionsBackup={downloadVersionsBackup}
                  onUndoVersionsImport={() => {
                    void workspaceController.undoVersionsImport()
                  }}
                  versionsImportUndoExpiresAt={workspaceController.versionsImportUndoExpiresAt}
                  onDismissNotice={workspaceController.dismissNotice}
                >
                  <section className={WSH_TOOLS} aria-label="行程工具">
                    <div className={WSH_TOOLS_HEAD}>
                      <div>
                        <p className={WSH_EYEBROW}>行程工具</p>
                        <p className={WSH_TOOL_NOTE}>
                          锚点 / 约束 / 清单 / 离线导出使用当前已应用的工作区记录；每次改动只做一次内存 transition，
                          不会自动写库。候选地点池与「资料卡备份与恢复」是独立键，打开 / 保存 / 导入都需要你显式操作。
                        </p>
                      </div>
                    </div>
                    <div className={WSH_TOOL_ACTIONS}>
                      <button
                        type="button"
                        className={WSH_BTN}
                        aria-expanded={anchorsOpen}
                        onClick={() => {
                          setAnchorsOpen((open) => !open)
                          setConstraintsOpen(false)
                          setChecklistOpen(false)
                          setCandidatePoolOpen(false)
                          setPoiCardBackupOpen(false)
                        }}
                        disabled={currentWorkspaceRecord === null}
                      >
                        住宿与抵离锚点
                      </button>
                      <button
                        type="button"
                        className={WSH_BTN}
                        aria-expanded={constraintsOpen}
                        onClick={() => {
                          setConstraintsOpen((open) => !open)
                          setAnchorsOpen(false)
                          setChecklistOpen(false)
                          setCandidatePoolOpen(false)
                          setPoiCardBackupOpen(false)
                        }}
                        disabled={currentWorkspaceRecord === null}
                      >
                        必去点与预约时间约束
                      </button>
                      <button
                        type="button"
                        className={WSH_BTN}
                        aria-expanded={checklistOpen}
                        onClick={() => {
                          setChecklistOpen((open) => !open)
                          setAnchorsOpen(false)
                          setConstraintsOpen(false)
                          setCandidatePoolOpen(false)
                          setPoiCardBackupOpen(false)
                        }}
                        disabled={currentWorkspaceRecord === null}
                      >
                        准备清单
                      </button>
                      <button
                        type="button"
                        className={WSH_BTN}
                        aria-expanded={candidatePoolOpen}
                        onClick={() => {
                          if (candidatePoolOpen) {
                            setCandidatePoolOpen(false)
                          } else {
                            setPoiCardBackupOpen(false)
                            openCandidatePool()
                          }
                        }}
                      >
                        候选地点池
                      </button>
                      <button
                        type="button"
                        className={WSH_BTN}
                        aria-expanded={poiCardBackupOpen}
                        onClick={() => {
                          if (poiCardBackupOpen) {
                            setPoiCardBackupOpen(false)
                          } else {
                            // 显式打开 = 读取最新；不写存储，只同步 record 与冻结 raw。
                            reloadPoiCards()
                            setPoiCardBackupOpen(true)
                          }
                          setAnchorsOpen(false)
                          setConstraintsOpen(false)
                          setChecklistOpen(false)
                          setCandidatePoolOpen(false)
                        }}
                      >
                        资料卡备份与恢复
                      </button>
                    </div>
                    {currentWorkspaceRecord === null ? (
                      <p className={WSH_TOOL_NOTE}>
                        锚点 / 约束 / 清单 / 离线导出需要先关联工作区；候选地点池和「资料卡备份与恢复」可以独立使用。
                      </p>
                    ) : null}

                    {anchorsOpen && currentWorkspaceRecord !== null ? (
                      <div className={WSH_TOOL_PANEL}>
                        <AnchorsPanel
                          key={`anchors:${currentWorkspaceRecord.workspaceId}:${currentWorkspaceRecord.workspaceRevision}`}
                          record={currentWorkspaceRecord}
                          epoch={workspaceEpoch}
                          newLegMode={draftMode}
                          onApply={handleAnchorsApply}
                          onClose={() => setAnchorsOpen(false)}
                        />
                      </div>
                    ) : null}

                    {constraintsOpen && currentWorkspaceRecord !== null ? (
                      <div className={WSH_TOOL_PANEL}>
                        <ConstraintsPanel
                          key={`constraints:${currentWorkspaceRecord.workspaceId}:${currentWorkspaceRecord.workspaceRevision}`}
                          constraints={currentWorkspaceRecord.sidecar.constraints}
                          trip={currentWorkspaceRecord.trip}
                          workspaceRevision={currentWorkspaceRecord.workspaceRevision}
                          epoch={workspaceEpoch}
                          candidateTrip={currentWorkspaceRecord.trip}
                          record={currentWorkspaceRecord}
                          runtimeCapture={constraintsRuntimeCapture}
                          planScope={constraintsScope}
                          onApply={handleConstraintsApply}
                          onClose={() => setConstraintsOpen(false)}
                        />
                      </div>
                    ) : null}

                    {checklistOpen && currentWorkspaceRecord !== null ? (
                      <div className={WSH_TOOL_PANEL}>
                        <ChecklistPanel
                          key={`checklist:${currentWorkspaceRecord.workspaceId}:${currentWorkspaceRecord.workspaceRevision}`}
                          checklist={currentWorkspaceRecord.sidecar.checklist}
                          trip={currentWorkspaceRecord.trip}
                          constraints={currentWorkspaceRecord.sidecar.constraints}
                          previousConstraints={checklistPreviousConstraints}
                          status="ready"
                          onChange={handleChecklistChange}
                          onClose={() => setChecklistOpen(false)}
                        />
                      </div>
                    ) : null}

                    {candidatePoolOpen ? (
                      <div className={WSH_TOOL_PANEL}>
                        <CandidatePoolPanel
                          record={candidatesRecord}
                          draft={draft ?? candidateDraftBase}
                          copySources={candidateCopySources}
                          storageStatus={candidatesStorageStatus}
                          storageMessage={candidatesStorageMessage}
                          storageRevision={candidatesStorageRevision}
                          saveStatus={candidatesSaveStatus}
                          saveMessage={candidatesSaveMessage}
                          onRecordChange={handleCandidatesRecordChange}
                          onSave={handleSaveCandidates}
                          onExport={handleExportCandidates}
                          onImportRequest={handleCandidatesImportRequest}
                          onAddToDraft={handleCandidateAddToDraft}
                          poiCards={poiCardsRecord}
                          onOpenPoiCard={(candidateName) => {
                            ensurePoiCardsLoaded()
                            // 候选条目 → 资料卡：按名称归一化定位已有卡；没有则新建态。
                            const read = poiCardsReadRef.current ? poiCardsRecord : null
                            const card =
                              read?.cards.find(
                                (item) =>
                                  item.name.trim().toLowerCase() === candidateName.trim().toLowerCase(),
                              ) ?? null
                            setPoiCardOpenId(card === null ? null : card.id)
                          }}
                          onClose={() => setCandidatePoolOpen(false)}
                        />
                        {candidatesImportPreview !== null ? (
                          <div className={WSH_TOOL_PANEL} role="region" aria-label="候选库导入预览">
                            <p className={WSH_TOOL_NOTE}>
                              文件《{candidatesImportPreview.fileName}》已通过纯校验，共{' '}
                              {candidatesImportPreview.itemCount} 个候选。确认后才会写入候选库；不会改动工作区或版本库。
                            </p>
                            <div className={WSH_TOOL_ACTIONS}>
                              <button
                                type="button"
                                className={WSH_BTN_PRIMARY}
                                onClick={handleConfirmCandidatesImport}
                                disabled={candidatesImportBusy}
                              >
                                确认导入候选库
                              </button>
                              <button
                                type="button"
                                className={WSH_BTN}
                                onClick={handleCancelCandidatesImport}
                                disabled={candidatesImportBusy}
                              >
                                取消导入
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {candidatesImportMessage !== null ? (
                          <p className={WSH_TOOL_NOTE} role="status">
                            {candidatesImportMessage}
                          </p>
                        ) : null}
                        {candidatesUndo !== null ? (
                          <button type="button" className={WSH_BTN} onClick={handleUndoCandidatesImport}>
                            撤销最近一次候选库导入
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    {poiCardBackupOpen ? (
                      <div className={WSH_TOOL_PANEL}>
                        <PoiCardBackupPanel
                          record={poiCardsRecord}
                          onSave={handleSavePoiCards}
                          onReload={reloadPoiCards}
                          onClose={() => setPoiCardBackupOpen(false)}
                        />
                      </div>
                    ) : null}

                    <input
                      ref={candidatesFileInputRef}
                      type="file"
                      accept="application/json,.json"
                      hidden
                      onChange={handleCandidatesFileChange}
                    />

                    {currentWorkspaceRecord !== null ? (
                      <div className={WSH_TOOL_PANEL}>
                        <OfflineTripPanel
                          record={currentWorkspaceRecord}
                          epoch={workspaceEpoch}
                        />
                      </div>
                    ) : null}
                  </section>
                </WorkspaceHub>
              </>
            )}

            {/* 本地编辑入口：行程下方、日签上方。编辑期间被现有草稿取代；AI 面板打开时收起 */}
            {!editingDraft && !aiOpen && !mapOpen && (
              <div className={ENTRY_CARD} data-testid="edit-entry">
                <div className="grid gap-1">
                  <span className={ENTRY_LABEL} id="edit-mode-label">新增路段的出行方式</span>
                  <div className={MODE_TOGGLE} role="radiogroup" aria-labelledby="edit-mode-label">
                    <label className={MODE_OPTION}>
                      <input
                        type="radio"
                        name="draft_leg_mode"
                        value="walking"
                        className={MODE_RADIO}
                        checked={draftMode === 'walking'}
                        onChange={() => handleDraftModeChange('walking')}
                      />
                      <span>步行</span>
                    </label>
                    <label className={MODE_OPTION}>
                      <input
                        type="radio"
                        name="draft_leg_mode"
                        value="driving"
                        className={MODE_RADIO}
                        checked={draftMode === 'driving'}
                        onChange={() => handleDraftModeChange('driving')}
                      />
                      <span>驾车</span>
                    </label>
                  </div>
                  <p className={ENTRY_HELP}>
                    本地编辑不会请求新路线：新增或重排站点后，涉及的新路段会标为「待重新获取」，
                    这里选定的方式只写进那条路段的标记，不会自动补距离或耗时。
                  </p>
                </div>
                <div className={ENTRY_ACTIONS}>
                  <Button
                    type="button"
                    onClick={handleStartEditing}
                    className="min-h-11 px-5 text-base font-semibold tracking-[0.08em]"
                  >
                    编辑这趟行程
                  </Button>
                  <p className={`${ENTRY_HELP} max-w-[46ch]`}>
                    在内存草稿里改站点文字、顺序和时间，不会自动保存，也不请求后端；应用后才替换当前显示的行程。
                  </p>
                </div>
                {draftError && (
                  <p className={ENTRY_ERROR} role="alert">{draftError}</p>
                )}
              </div>
            )}

            {/*
              AI 单日调整入口：目标固定为当前日。
              有本地草稿时按钮禁用——先应用或放弃草稿，避免把草稿输入晾在一边。
            */}
            {!editingDraft && !mapOpen && (
              <div className={ENTRY_CARD} data-testid="map-refresh-entry" data-day={currentDay?.day ?? activeDay}>
                <div>
                  <p className={ENTRY_LABEL}>仅刷新地图（第 {currentDay?.day ?? activeDay} 天）</p>
                  <p className={ENTRY_HELP}>
                    只按当前日已有的站点重新获取地图坐标与路段，不重新规划行程，也不需要 AI。
                    文字、时间、地址说明和其它天都保持不变；面板里会先让你选步行或驾车，再获取、预览，确认后才替换当前行程。
                    地图服务未配置 Key 时会直接说明，不影响你继续查看当前行程。
                  </p>
                </div>
                <div className={ENTRY_ACTIONS}>
                  <Button type="button" variant="outline" className="min-h-11 px-5 text-base" onClick={handleOpenMapRefresh}>
                    仅刷新地图
                  </Button>
                </div>
              </div>
            )}

            {!aiOpen && !mapOpen && (
              <div className={AI_ENTRY} data-testid="ai-entry" data-day={activeDay}>
                <div className={AI_ENTRY_COPY}>
                  <p className={`${ENTRY_LABEL} ${AI_ENTRY_COPY_P}`}>
                    AI 调整单日（目标：第 {activeDay} 天
                    {currentDay?.date ? ` · ${currentDay.date}` : ''}）
                  </p>
                  <p className={`${ENTRY_HELP} ${AI_ENTRY_COPY_P}`}>
                    只让 AI 重排这一天。候选会先和当前安排对比，你点「应用候选」之前，页面上的行程、地图和保存记录都不会变。
                  </p>
                  {editingDraft ? (
                    <p className={`${ENTRY_HELP} ${AI_ENTRY_COPY_P}`} role="note">
                      本地草稿正在编辑：先「应用草稿」或「放弃草稿」，再让 AI 调整这一天；草稿输入不会因此丢失。
                    </p>
                  ) : null}
                </div>
                <div className={AI_ENTRY_ACTIONS}>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 px-5 text-base"
                    onClick={handleOpenAiPanel}
                    disabled={editingDraft}
                  >
                    AI 调整这一天
                  </Button>
                </div>
              </div>
            )}

            {!aiOpen && !mapOpen && !assistantOpen && (
              <div className={AI_ENTRY} data-testid="assistant-entry">
                <div className={AI_ENTRY_COPY}>
                  <p className={`${ENTRY_LABEL} ${AI_ENTRY_COPY_P}`}>AI 行程助手（用一句话改行程）</p>
                  <p className={`${ENTRY_HELP} ${AI_ENTRY_COPY_P}`}>
                    说一句想怎么改，助手会先列出改动清单、标出还不确定的地方和冲突，你确认后才改当前行程。
                    改的是内存里的行程，不会自动保存；行程在别处变了，这条建议就作废。
                  </p>
                  {editingDraft ? (
                    <p className={`${ENTRY_HELP} ${AI_ENTRY_COPY_P}`} role="note">
                      本地草稿正在编辑：先「应用草稿」或「放弃草稿」，再用行程助手；草稿输入不会因此丢失。
                    </p>
                  ) : null}
                </div>
                <div className={AI_ENTRY_ACTIONS}>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 px-5 text-base"
                    onClick={handleOpenAssistant}
                    disabled={editingDraft}
                  >
                    AI 行程助手
                  </Button>
                </div>
              </div>
            )}

            {mapOpen && trip && (
              <div className={AI_PANEL_SLOT} data-testid="map-refresh-slot">
                <p className={AI_PAUSE_NOTE} role="note">
                  仅刷新地图面板打开着：规划、恢复、保存、导入导出、撤销和日期切换已暂停，关闭面板后恢复。
                  面板里的「停止等待」只停止本页等待，不保证地图服务停止处理。
                </p>
                <MapRefreshPanel
                  trip={trip}
                  day={currentDay ?? null}
                  revision={planningRevision}
                  openedFromFile={openedFromFile === true}
                  onApply={handleMapApply}
                  onClose={handleCloseMapRefresh}
                />
              </div>
            )}

            {aiOpen && (
              <div className={AI_PANEL_SLOT} data-testid="ai-panel-slot">
                <p className={AI_PAUSE_NOTE} role="note">
                  AI 调整面板打开着：日期切换、规划、恢复、保存、导出与备份已暂停，关闭面板后恢复。
                  面板里的「停止等待」只停止本页等待，不保证后端或上游模型停止处理，也不保证停止计费。
                </p>
                <DayReplanPanel
                  trip={trip}
                  dayNumber={activeDay}
                  revision={planningRevision}
                  plannerAvailability={backend.planner}
                  requestDay={handleAiRequestDay}
                  onApply={handleAiApply}
                  onClose={handleCloseAiPanel}
                  planningContext={aiPlanningContext}
                  liveInputRef={aiPlanningLiveRef}
                  onPlanningInputChanged={handleAiPlanningInputChanged}
                />
                {aiPlanningAck !== null ? (
                  <div className={AI_PANEL_SLOT} role="region" aria-label="未核实时间确认">
                    <p className={AI_PAUSE_NOTE} role="note">
                      {aiPlanningAck.message}
                      确认只对当前候选有效；H 级硬冲突没有确认入口。
                    </p>
                    <div className={ENTRY_ACTIONS}>
                      <Button
                        type="button"
                        onClick={handleAiPlanningAckConfirm}
                        className="min-h-11 px-5 text-base font-semibold tracking-[0.08em]"
                      >
                        仍采用含未核实时间方案并应用
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setAiPlanningAck(null)}
                        className="min-h-9"
                      >
                        取消这次确认
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {assistantOpen && trip && (
              <div className={AI_PANEL_SLOT} data-testid="assistant-dialog-slot">
                <p className={AI_PAUSE_NOTE} role="note">
                  AI 行程助手打开着：建议只在内存里计算与应用，不会自动保存；行程在别处被改动后，
                  这里挂起的建议会立刻作废，需要重新生成。
                </p>
                <AssistantDialogPanel
                  trip={trip}
                  record={currentWorkspaceRecord}
                  candidates={candidatesRecord?.items ?? []}
                  currentDay={activeDay}
                  travelMode={draftMode}
                  revision={planningRevision}
                  createLogicalId={newUuid}
                  onApplyRecord={handleAssistantApplyRecord}
                  requestDay={handleAiRequestDay}
                  onReplanApply={handleAssistantReplanApply}
                  planningConstraints={buildAssistantPlanningConstraints}
                  onClose={handleCloseAssistant}
                  poiCards={poiCardsRecord}
                />
              </div>
            )}

            {editingDraft && draft && (
              <TripDraftEditor
                draft={draft}
                dayNumber={currentDay?.day ?? draft.base.days[0]?.day ?? 1}
                onDraftChange={setDraft}
                onApply={handleDraftApply}
                onDiscard={handleDraftDiscard}
                createStopId={newUuid}
                onEditingChange={setEditorEditing}
                onInputDirtyChange={updateEditorInputDirty}
                onSelectStop={handleSelectStop}
              />
            )}

            <div className={DAY_NAV} role="tablist" aria-label="按日切换" onKeyDown={dayNavKeyDown}>
              {dayTabs.map((d) => {
                const selected = d.day === activeDay
                const blocked = aiOpen || mapOpen || (editingDraft && editorInputDirty)
                return (
                <button
                  key={d.day}
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  aria-controls="day-panel"
                  id={`day-tab-${d.day}`}
                  className={DAY_TAB}
                  onClick={() => switchDay(d.day)}
                  aria-disabled={blocked || undefined}
                  title={
                    mapOpen
                      ? '仅刷新地图面板打开着，目标日已锁定；关闭面板后可切换日期。'
                      : aiOpen
                        ? 'AI 调整面板打开着，目标日已锁定；关闭面板后可切换日期。'
                        : blocked
                        ? '有未保存的站点输入，先保存到草稿或取消输入，再切换日期。'
                        : undefined
                  }
                >
                  <span className={DAY_TAB_NUM}>D{d.day}{d.date ? ` · ${d.date.slice(5)}` : ''}</span>
                  <span className={DAY_TAB_TITLE}>{d.title || `第 ${d.day} 天`}</span>
                </button>
                )
              })}
            </div>
            {editingDraft && editorInputDirty && (
              <p className={DAY_SWITCH_NOTE} role="status">
                单站输入尚未保存：日期切换已暂停。输入属于当前正在编辑的天，先「保存到草稿」或「取消输入」再切换。
              </p>
            )}
            {mapOpen && (
              <p className={DAY_SWITCH_NOTE} data-testid="map-day-lock-note" role="status">
                仅刷新地图面板打开着：日期切换已暂停，目标固定为第 {activeDay} 天；关闭面板后恢复。
              </p>
            )}
            {aiOpen && (
              <p className={DAY_SWITCH_NOTE} data-testid="ai-day-lock-note" role="status">
                AI 调整面板打开着：日期切换已暂停，目标固定为第 {activeDay} 天；关闭面板后恢复。
              </p>
            )}

            {/*
              本日天气：独立于 AI / 规划，按本日站点记录坐标查询。
              本地编辑或 AI 面板打开时收起，减少上下文竞态；面板展开本身不发请求。
            */}
            {!editingDraft && !aiOpen && !mapOpen && currentDay && (
              <div className="weather-slot" data-testid="weather-slot">
                {weatherOpen ? (
                  <DayWeatherPanel
                    trip={trip}
                    day={currentDay}
                    revision={tripRevision}
                    openedFromFile={openedFromFile === true}
                    onClose={() => setWeatherOpen(false)}
                  />
                ) : (
                  <div className={ENTRY_CARD} data-testid="weather-entry">
                    <div>
                      <p className={ENTRY_LABEL}>本日天气（第 {currentDay.day} 天）</p>
                      <p className={ENTRY_HELP}>
                        按本日行程记录坐标查询天气。打开面板不会发请求，点「查询天气」才会请求一次；
                        结果只在本页内存里，不写进行程或本地保存。
                      </p>
                    </div>
                    <div className={ENTRY_ACTIONS}>
                      <Button type="button" variant="outline" className="min-h-11 px-5 text-base" onClick={() => setWeatherOpen(true)}>
                        查天气
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/*
              本日公开资料：独立于 AI / 规划 / 天气，按本日站点记录坐标查询
              OpenStreetMap 公开标签候选。本地编辑或 AI / 地图面板打开时收起，
              面板展开本身不发请求，只有点「查询附近资料」才请求一次。
            */}
            {!editingDraft && !aiOpen && !mapOpen && currentDay && (
              <div className="mb-6" data-testid="poi-sources-slot">
                {poiSourcesOpen ? (
                  <DayPoiSourcesPanel
                    trip={trip}
                    day={currentDay}
                    revision={tripRevision}
                    openedFromFile={openedFromFile === true}
                    activeStopId={activeStopId}
                    onCollectPoiCard={handleCollectPoiCard}
                    onClose={handlePoiSourcesClose}
                  />
                ) : (
                  <div className={ENTRY_CARD} data-testid="poi-sources-entry" ref={poiSourcesEntryRef}>
                    <div>
                      <p className={ENTRY_LABEL}>本日公开资料（第 {currentDay.day} 天）</p>
                      <p className={ENTRY_HELP}>
                        按本日行程记录坐标查询附近 OpenStreetMap 公开标签候选，身份未确认。
                        打开面板不会发请求，点「查询附近资料」才会请求一次；
                        结果只在本页内存里，不写进行程或本地保存。
                      </p>
                    </div>
                    <div className={ENTRY_ACTIONS}>
                      <Button type="button" variant="outline" className="min-h-11 px-5 text-base" onClick={() => setPoiSourcesOpen(true)}>
                        查资料
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/*
              网页资料：独立于 AI / 规划 / 天气 / 本日公开资料的 Tavily 搜索摘要入口。
              本地编辑或 AI / 地图面板打开时收起，面板展开本身不发请求；
              只有点「搜索网页资料」才请求一次，站点只作阅读上下文、无需坐标。
              结果只存面板内存，不写 Trip／费用／恢复副本。
            */}
            {!editingDraft && !aiOpen && !mapOpen && currentDay && (
              <div className="web-sources-slot" data-testid="web-sources-slot">
                {webSourcesOpen ? (
                  <WebSourcesPanel
                    trip={trip}
                    day={currentDay}
                    revision={tripRevision}
                    openedFromFile={openedFromFile}
                    activeStopId={activeStopId}
                    onCollectPoiCard={handleCollectPoiCard}
                    onClose={handleWebSourcesClose}
                  />
                ) : (
                  <div className={ENTRY_CARD} data-testid="web-sources-entry" ref={webSourcesEntryRef}>
                    <div>
                      <p className={ENTRY_LABEL}>网页资料（第 {currentDay.day} 天）</p>
                      <p className={ENTRY_HELP}>
                        用你输入的内容搜索 Tavily 网页摘要，未核实，不冒充官方信息。
                        打开面板不会发请求，点「搜索网页资料」才会请求一次；
                        结果只在本页内存里，不写进行程、费用或本地保存。
                      </p>
                    </div>
                    <div className={ENTRY_ACTIONS}>
                      <Button type="button" variant="outline" className="min-h-11 px-5 text-base" onClick={() => setWebSourcesOpen(true)}>
                        查网页资料
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/*
              费用估算：整趟 Trip 级的手动工具，独立于 AI / 规划 / 天气 / 资料。
              session 在 App 层：面板收起或临时打开地图 / AI / 编辑卸载后，输入不丢。
              编辑 / AI / 地图面板打开时收起入口，不动草稿。
            */}
            {!editingDraft && !aiOpen && !mapOpen && trip && (
              <div className="budget-slot" data-testid="budget-slot">
                {budgetOpen ? (
                  <TripBudgetPanel
                    trip={trip}
                    revision={tripRevision}
                    session={budgetSession}
                    onSessionChange={handleBudgetSessionChange}
                    onClose={handleBudgetClose}
                  />
                ) : (
                  <div className={ENTRY_CARD} data-testid="budget-entry" ref={budgetEntryRef}>
                    <div>
                      <p className={ENTRY_LABEL}>费用估算（手动填写）</p>
                      <p className={ENTRY_HELP}>
                        手动填费用算已知合计与分类小计，人民币 CNY 是固定输入单位；不查真实价格，不换汇。
                        草稿只在当前页面内存里：不随行程保存或导出，刷新会丢失。
                      </p>
                    </div>
                    <div className={ENTRY_ACTIONS}>
                      <Button type="button" variant="outline" className="min-h-11 px-5 text-base" onClick={() => setBudgetOpen(true)}>
                        费用估算
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className={TRIP_LAYOUT}>
              <div className={ITINERARY_PANE} id="day-panel" role="tabpanel" aria-labelledby={`day-tab-${activeDay}`}>
                {currentDay && trip && (
                  <TodayPanel
                    days={trip.days}
                    poiCardsRecord={poiCardsRecord}
                    poiCardsLoaded={poiCardsReadRef.current}
                    checklist={currentWorkspaceRecord?.sidecar.checklist.items ?? []}
                    constraints={currentWorkspaceRecord?.sidecar.constraints.items ?? []}
                    activeStopId={activeStopId}
                    onSelectStop={handleSelectStop}
                  />
                )}
                {currentDay && (
                  <ItineraryHealthCard
                    day={currentDay}
                    pace={lastPlannedPace ?? 'balanced'}
                    factsByStop={currentDay.stops.map(
                      (stop) => (poiCardsReadRef.current ? projectStopFacts(stop, poiCardsRecord, Date.now()) : null),
                    )}
                  />
                )}
                {currentDay && <RouteFlowHint day={currentDay} />}
                {currentDay && (
                  <ItineraryView
                    day={currentDay}
                    activeStopId={activeStopId}
                    onSelectStop={handleSelectStop}
                    poiCards={poiCardsRecord}
                    onOpenShare={() => setShareOpen(true)}
                    onOpenPoiCardPanel={handleStopFactSupplement}
                  />
                )}
              </div>
              <div className={MAP_PANE}>
                {currentDay && (
                  <TripMap
                    day={currentDay}
                    activeStopId={activeStopId}
                    onSelectStop={handleSelectStop}
                    key={`${trip.id}:${currentDay.day}`}
                  />
                )}
              </div>
            </div>
            {shareOpen && trip && currentDay && (
              <ShareCardPanel
                trip={trip}
                initialDay={activeDay}
                onClose={() => setShareOpen(false)}
              />
            )}
            {editingDraft && (
              <p className={DRAFT_PREVIEW_NOTE} data-testid="draft-preview-note" role="note">
                上面的行程和地图显示的是内存草稿的预览，还没有应用，也没有保存；
                当前行程的原始数据没有被修改，已保存的记录保持原样。
              </p>
            )}

            {/*
              P · 景点资料卡面板：poiCardOpenId !== undefined 时挂载。
              undefined = 关闭；null = 新建态；字符串 = 查看对应卡。
              编辑只在内存，「保存资料卡」显式提交才写 poiCards:v1；取消 / 关闭零写入。
              S3 收进：poiCardCollectPrefill 不为 null 时按收进态初始化新建表单
              （用户可改）；「不采纳，关闭」丢弃预填零写入。
            */}
            {poiCardOpenId !== undefined && (
              <div className={WSH_TOOL_PANEL} data-testid="poi-card-slot">
                <PoiCardPanel
                  record={poiCardsRecord}
                  cardId={poiCardOpenId}
                  prefill={poiCardCollectPrefill}
                  onSave={handleSavePoiCards}
                  saveStatus={poiCardsSaveStatus}
                  saveMessage={poiCardsSaveMessage}
                  createCardId={newUuid}
                  onClose={() => {
                    setPoiCardOpenId(undefined)
                    setPoiCardCollectPrefill(null)
                    setPoiCardsSaveStatus('idle')
                    setPoiCardsSaveMessage(null)
                  }}
                />
              </div>
            )}
          </section>
        )}

        {/*
          本机工作进度留存：默认关闭。启用后有界自动留存；有待恢复副本时显示概况卡，
          自动写暂停至用户选择。编辑器未提交输入期间同样暂停（输入不在留存范围）。
        */}
        <SessionResumePanel
          state={resumeUi}
          enabled={resumeEnabled}
          hasStoredData={resumeHasData}
          management={resumeManagement}
          onEnable={handleResumeEnable}
          onDisable={handleResumeDisable}
          onRestore={handleResumeRestore}
          onDiscardAndStart={handleResumeDiscardAndStart}
          onCheckStoredData={handleResumeCheckStoredData}
          onPrepareDelete={handleResumePrepareDelete}
          onDeleteData={handleResumeDelete}
        />

        {/*
          备份 / 导入的入口：默认收起，点一次展开。没有行程时也能进来导入，
          导出区自己会说明当前没有可导出的行程。展开后才挂载面板——面板的导出区会
          把当前行程标题再显示一遍，收起时页面里只保留行程标题本身。
        */}
        <div className={TRIP_TRANSFER_SLOT}>
          {editingDraft ? (
            <p className={EDIT_PAUSE_NOTE} role="note">
              本地编辑进行中：行程备份与导入（含保存到本地、下载备份）已暂停。请先「应用草稿」或「放弃草稿」再使用。
            </p>
          ) : aiOpen ? (
            <p className={EDIT_PAUSE_NOTE} role="note">
              AI 单日调整进行中：行程备份与导入（含保存到本地、下载备份）已暂停。请先关闭 AI 面板再使用。
            </p>
          ) : mapOpen ? (
            <p className={EDIT_PAUSE_NOTE} role="note">
              仅刷新地图进行中：行程备份与导入（含保存到本地、下载备份）已暂停。请先关闭面板再使用。
            </p>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setTransferOpen((open) => !open)}
                aria-expanded={transferOpen}
                aria-controls={transferBodyId}
                title="导入或导出本机 JSON 备份；没有行程时也可以先导入"
              >
                {transferOpen ? '收进行程备份与导入' : '行程备份与导入'}
              </Button>
              <div id={transferBodyId}>
                {transferOpen && (
                  <TripTransferPanel trip={trip} onOpen={handleOpenImportedTrip} />
                )}
              </div>
            </>
          )}
        </div>
      </main>

      <footer className={FOOTER}>
        <span>底图 © OpenStreetMap 贡献者 · 地图坐标系统 WGS84（经度、纬度）</span>
        <span>路线「示意直线」仅为方位参考，不代表真实导航路径。</span>
        <span>示例行程为演示数据；AI 规划内容由模型生成，出行前请核实开放时间与交通信息。</span>
      </footer>
    </div>
  )
}

/**
 * 工作区 sidecar / 候选库 / 版本库的公共类型与常量（唯一契约定义处）。
 *
 * 本文件只放类型与常量；运行时校验、builder、owner helper 在 ./workspace.ts，
 * canonical JSON 与短指纹在 ./workspaceFingerprint.ts。唯一权威说明见
 * docs/WORKSPACE_SIDECAR.md。
 *
 * 边界（与计划 §2 / §5 对齐）：
 * - Trip v1 不扩展：本文件的任何类型都不往 Trip 里塞字段。
 * - 三个逻辑库各用各的键，各自显式备份 / 导入；不做跨库事务。
 * - 坐标 null = 未知；绝不把未知写成 (0, 0)。
 * - 短 hash 只作索引 / 显示；owner 判定必须用完整 canonical JSON。
 * - 所有 ID 都是调用方提供的随机逻辑 ID，不是浏览器指纹。
 */
import type { Trip } from './api'
import type { BudgetRowInput } from './tripBudget'

/* ───────── 存储键（与计划 §2.1 一致） ───────── */

export const WORKSPACE_STORAGE_KEY = 'travel-assistant:workspace:v1'
export const CANDIDATES_STORAGE_KEY = 'travel-assistant:workspace:candidates:v1'
export const VERSIONS_STORAGE_KEY = 'travel-assistant:workspace:versions:v1'

/* ───────── 格式与版本 ───────── */

export const WORKSPACE_FORMAT = 'travel-assistant.workspace' as const
export const WORKSPACE_VERSION = 1 as const
export const CANDIDATES_FORMAT = 'travel-assistant.workspace.candidates' as const
export const CANDIDATES_VERSION = 1 as const
export const VERSIONS_FORMAT = 'travel-assistant.workspace.versions' as const
export const VERSIONS_VERSION = 1 as const

export const WORKSPACE_BACKUP_FORMAT = 'travel-assistant.workspace.backup' as const
export const CANDIDATES_BACKUP_FORMAT = 'travel-assistant.workspace.candidates.backup' as const
export const VERSIONS_BACKUP_FORMAT = 'travel-assistant.workspace.versions.backup' as const
export const BACKUP_VERSION = 1 as const

/* ───────── 容量常量（计划 §2.1 的唯一实现） ───────── */

/** 整条工作区记录（Trip + sidecar + budget + meta）的 UTF-8 上限。 */
export const MAX_WORKSPACE_RECORD_BYTES = 2 * 1024 * 1024
/** 工作区记录内 sidecar 段的 UTF-8 上限。 */
export const MAX_WORKSPACE_SIDECAR_BYTES = 512 * 1024
/** 候选库整库的 UTF-8 上限。 */
export const MAX_CANDIDATES_BYTES = 256 * 1024
export const MAX_CANDIDATES_COUNT = 200
export const MAX_VERSIONS_COUNT = 10
/** 版本库整库的 UTF-8 上限。 */
export const MAX_VERSIONS_TOTAL_BYTES = 4 * 1024 * 1024
/** 单个版本快照（Trip + sidecar + budget + metadata）的 UTF-8 上限。 */
export const MAX_VERSION_SNAPSHOT_BYTES = 2 * 1024 * 1024

export const MAX_WORKSPACE_BACKUP_FILE_BYTES = 2 * 1024 * 1024
export const MAX_CANDIDATES_BACKUP_FILE_BYTES = 512 * 1024
export const MAX_VERSIONS_BACKUP_FILE_BYTES = 8 * 1024 * 1024

/* ───────── 字段上限（新结构的严格校验用；不回溯约束旧 Trip） ───────── */

/** 单条逻辑 ID（workspace / owner / trip / stop / candidate…）。 */
export const MAX_WORKSPACE_ID_LENGTH = 200
export const MAX_WORKSPACE_LABEL_LENGTH = 200

export const MAX_ANCHOR_NAME_LENGTH = 120
export const MAX_ACCOMMODATION_NAME_LENGTH = 300
export const MAX_TRANSPORT_NAME_LENGTH = 300
export const MAX_ANCHOR_ADDRESS_LENGTH = 300
export const MAX_ANCHOR_DAY = 366

/** F2 约束：条数与序列化字节上限（后端契约同步使用）。 */
export const MAX_CONSTRAINT_ITEMS = 24
export const MAX_CONSTRAINTS_BYTES = 16 * 1024
export const MAX_CONSTRAINT_TITLE_LENGTH = 120
export const MAX_CONSTRAINT_NOTES_LENGTH = 500
export const MAX_CONSTRAINT_PRIORITY = 3

export const MAX_CHECKLIST_TITLE_LENGTH = 200
export const MAX_CHECKLIST_NOTES_LENGTH = 1000
export const MAX_CHECKLIST_ITEMS = 300
export const MAX_APPLIED_TEMPLATES = 50
export const MAX_TEMPLATE_ID_LENGTH = 100

export const MAX_APPLY_LINKS = 1000
export const MAX_BUDGET_RAW_LENGTH = 1000
export const MAX_BUDGET_ROW_NAME_LENGTH = 200
export const MAX_BUDGET_AMOUNT_RAW_LENGTH = 1000

export const MAX_CANDIDATE_NAME_LENGTH = 120
export const MAX_CANDIDATE_ADDRESS_LENGTH = 300
export const MAX_CANDIDATE_NOTES_LENGTH = 500
/** 七期 S7b：候选条目可选城市归属的长度上限。 */
export const MAX_CANDIDATE_CITY_LENGTH = 60
export const MAX_CANDIDATE_TAG_LENGTH = 50
export const MAX_CANDIDATE_TAGS = 20
export const MAX_CANDIDATE_PRIORITY = 3

export const MAX_VERSION_NAME_LENGTH = 200

/** revision / epoch 只接受 JSON 安全整数（与后端 MAX_SAFE_JSON_INTEGER 一致）。 */
export const MAX_SAFE_WORKSPACE_REVISION = Number.MAX_SAFE_INTEGER

/* ───────── 基础形状 ───────── */

/** WGS84 坐标。null 表示未知；本契约不接受用 (0, 0) 表示未知。 */
export interface GeoPointV1 {
  lng: number
  lat: number
}

/** 工作区记录的附加元数据；不参与业务判断。 */
export interface WorkspaceMetaV1 {
  /** 创建时刻（epoch ms），保存后不变。 */
  createdAt: number
  /** 用户可读标签；null = 未命名。 */
  label: string | null
}

/* ───────── F1：住宿与抵离锚点 ───────── */

/**
 * 住宿实体（酒店）信息。hotelId 是实体 identity，可在多个 visit 间共享；
 * 它不进入 Trip。所有未知项都是 null，不补默认值。
 */
export interface AccommodationAnchorV1 {
  hotelId: string | null
  name: string | null
  address: string | null
  /** 真实 WGS84；null = 未知。 */
  location: GeoPointV1 | null
  /** 只有用户自己填写坐标时才是 'user_provided'；null = 没有可核实的坐标。 */
  locationSource: 'user_provided' | null
  checkInDate: string | null
  checkOutDate: string | null
}

/**
 * 每日起点 / 终点锚点。
 * kind='stop' 时 stopId 必填，只引用已有 stop，不复制、不改其 id；
 * kind='manual' 时 stopId 必须为 null。hotelId 与 stopId 是两个维度：
 * hotelId 指向地点实体，stopId 指向 Trip 里一次具体停靠 occurrence。
 */
export interface DayAnchorV1 {
  /** 锚点自身 identity。 */
  anchorId: string
  kind: 'stop' | 'manual'
  stopId: string | null
  hotelId: string | null
  name: string
  address: string | null
  location: GeoPointV1 | null
  time: string | null
  date: string | null
}

export interface TransportAnchorV1 {
  kind: 'airport' | 'station' | 'other'
  name: string
  date: string | null
  time: string | null
  location: GeoPointV1 | null
}

export interface DailyAnchorsV1 {
  start: DayAnchorV1 | null
  end: DayAnchorV1 | null
}

export interface AnchorsV1 {
  accommodation: AccommodationAnchorV1 | null
  /** key 为 Trip 的天序号（'1'..'366'）；只放有锚点的天。 */
  daily: Record<string, DailyAnchorsV1>
  arrival: TransportAnchorV1 | null
  departure: TransportAnchorV1 | null
}

/* ───────── F2：必去点与预约时间约束 ───────── */

export type ConstraintKindV1 = 'must_visit' | 'fixed_window' | 'reminder'

/**
 * 一条约束。时间 / 日期的 null 一律是「未知」，不是 0 点或当天。
 * - must_visit：day + title 必填；stopId 可为 null，表示尚未落 Trip 的初始目标实体。
 *   trip_plan 作用域必须为 null（没有 request.stops，不能伪造 stop id）；day/day_tail
 *   非 null 时由 validateConstraintsForScope 验证该 stop 存在于目标日。
 * - fixed_window：startDate + startTime 是固定开始；endDate + endTime 完整时才可
 *   声称硬验证通过，任一端未知就是 U 级。跨日窗口用不同 startDate / endDate。
 * - reminder：只提醒，不阻断。
 */
export interface ConstraintItemV1 {
  id: string
  kind: ConstraintKindV1
  /** 目标天序号；null = 未指定。fixed_window 可以只靠日期表达；must_visit 必填。 */
  day: number | null
  /** null = 目标尚未落 Trip；非 null 时按 scope 层验证目标日存在，不得伪造。 */
  stopId: string | null
  title: string
  startDate: string | null
  endDate: string | null
  /** 行程当地时刻 HH:MM；null = 未知。 */
  startTime: string | null
  endTime: string | null
  /** 停留分钟数；null = 未知（不是 0）。 */
  durationMinutes: number | null
  notes: string | null
  /** 0..3；数值越大越优先。 */
  priority: number
  updatedAt: number
}

export interface ConstraintsV1 {
  items: ConstraintItemV1[]
}

/* ───────── F5：出行准备清单 ───────── */

export type ChecklistCategoryV1 = 'ticket' | 'appointment' | 'document' | 'luggage' | 'todo'

/**
 * 清单项。done 只表示「我准备/核对过了」，不代表已预订、已出票或已确认。
 * 删除被引用的 stop 时：stopId 置 null，originalStopId 保留最后一次已知的原 id，
 * 条目本身不删除。
 */
export interface ChecklistItemV1 {
  id: string
  category: ChecklistCategoryV1
  title: string
  done: boolean
  date: string | null
  day: number | null
  stopId: string | null
  /** stop 被删 / 解绑后保留的追溯 id；正常关联时为 null。 */
  originalStopId: string | null
  /**
   * 关联的预约约束 id（`ConstraintItemV1.id`）。
   * 可选以兼容旧 v1：缺省表示旧记录未携带，读取/重写时不得自动补 null。
   * 显式 null = 明确未关联；非 null 只校验 id 格式，允许约束删除后保留 dangling，
   * 由 F5 audit 结合当前 constraints 提示 needsRelink，不自动按同名/日期重绑。
   */
  constraintId?: string | null
  notes: string | null
  updatedAt: number
}

export interface ChecklistV1 {
  items: ChecklistItemV1[]
  /** 已采纳的模板 id；只记录用户逐条采纳过的模板。 */
  appliedTemplates: string[]
}

/* ───────── F3：候选使用关系（关系不进候选库） ───────── */

export interface ApplyLinkV1 {
  candidateId: string
  tripId: string
  day: number
  stopId: string
}

/* ───────── 工作区 sidecar / 预算 / 记录 ───────── */

export interface WorkspaceSidecarV1 {
  anchors: AnchorsV1
  constraints: ConstraintsV1
  checklist: ChecklistV1
  applies: ApplyLinkV1[]
}

/** 手工预算快照：只保存用户原字符串与行，不保存派生合计。 */
export interface BudgetSnapshotV1 {
  budgetRaw: string
  rows: BudgetRowInput[]
}

export interface WorkspaceRecordV1 {
  format: typeof WORKSPACE_FORMAT
  version: typeof WORKSPACE_VERSION
  workspaceId: string
  ownerId: string
  /** 必须与 trip.id 相同；工作区只绑定一个行程。 */
  tripId: string
  /** Trip v1 原样；不扩字段。 */
  trip: Trip
  sidecar: WorkspaceSidecarV1
  /** null = 明确没有可用的手工预算数据，不是 0。 */
  budget: BudgetSnapshotV1 | null
  workspaceRevision: number
  updatedAt: number
  meta: WorkspaceMetaV1
}

/* ───────── F3：候选库 ───────── */

export type CandidateSourceV1 = 'manual' | 'copied'

export interface CandidateItemV1 {
  id: string
  name: string
  address: string | null
  notes: string | null
  tags: string[]
  /** 0..3；数值越大越优先。 */
  priority: number
  /** null = 坐标未知；绝不写 (0, 0) 冒充。 */
  location: GeoPointV1 | null
  /** manual = 手工新建；copied = 从现有 stop 复制。 */
  source: CandidateSourceV1
  /** source='copied' 时必填；manual 时必须为 null。 */
  copiedFromStopId: string | null
  /**
   * 七期 S7b：候选所属城市（自由文本，trim 后最多 60 字符）。
   * 可选以兼容旧 v1：缺键 = 未登记城市，按全局条目可见；
   * 读取 / 重写旧记录时不得自动补 null，只有非空值才落键。
   */
  cityId?: string | null
  createdAt: number
  updatedAt: number
}

export interface CandidatesRecordV1 {
  format: typeof CANDIDATES_FORMAT
  version: typeof CANDIDATES_VERSION
  items: CandidateItemV1[]
  updatedAt: number
}

/* ───────── F4：版本库 ───────── */

/**
 * 不可变版本快照。workspaceRevision 只记录快照当时的 revision，
 * 采用 / 撤销时绝不恢复它；当前 revision 永远基于当前值 +1。
 * budget 为 null 表示该版本明确没有预算数据，不套用当前预算。
 */
export interface VersionSnapshotV1 {
  id: string
  name: string
  createdAt: number
  workspaceRevision: number
  trip: Trip
  sidecar: WorkspaceSidecarV1
  budget: BudgetSnapshotV1 | null
}

export interface VersionsRecordV1 {
  format: typeof VERSIONS_FORMAT
  version: typeof VERSIONS_VERSION
  items: VersionSnapshotV1[]
  updatedAt: number
}

/* ───────── 三个独立备份文件 ───────── */

export interface WorkspaceBackupV1 {
  format: typeof WORKSPACE_BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  exportedAt: number
  workspace: WorkspaceRecordV1
}

export interface CandidatesBackupV1 {
  format: typeof CANDIDATES_BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  exportedAt: number
  candidates: CandidatesRecordV1
}

export interface VersionsBackupV1 {
  format: typeof VERSIONS_BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  exportedAt: number
  versions: VersionsRecordV1
}

/* ───────── owner / fingerprint / epoch ───────── */

/** 完整 canonical JSON + 短 hash。短 hash 只作索引 / 显示，不能单独自证。 */
export interface WorkspaceFingerprintV1 {
  /** 完整 canonical JSON；owner 比较只认这个字段。 */
  canonical: string
  /** FNV-1a 32-bit 小写十六进制；只是索引 / 显示，允许碰撞。 */
  short: string
}

/** 便宜的身份组合：owner 不变时 revision 是内容变化的守卫。 */
export interface WorkspaceIdentityV1 {
  ownerId: string
  workspaceId: string
  tripId: string
  workspaceRevision: number
}

/** 完整 owner：身份 + 单调 epoch + 整条工作区记录的 canonical 快照。 */
export interface WorkspaceOwnerV1 extends WorkspaceIdentityV1 {
  epoch: number
  /** 完整工作区记录的 canonical JSON（权威内容快照；短 hash 只作索引）。 */
  snapshot: WorkspaceFingerprintV1
}

export type PlanScopeKindV1 = 'trip_plan' | 'day' | 'day_tail'

/** F2 的请求 / 候选作用域；后段 replan 必须绑定 anchorStopId。 */
export interface PlanScopeV1 {
  scope: PlanScopeKindV1
  day: number | null
  anchorStopId: string | null
}

/**
 * AI 候选的约束绑定。候选产生时记录；apply 前必须用当前工作区重算并全文比对。
 * constraints.canonical 是完整快照，short 只作索引。
 */
export interface ConstraintsBindingV1 {
  owner: WorkspaceIdentityV1
  constraints: WorkspaceFingerprintV1
  planScope: PlanScopeV1
  epoch: number
}

/** U 级（含未核实时间）方案的显式确认；任何身份 / revision / 约束 / epoch 变化即失效。 */
export interface UnverifiedConstraintsAckV1 extends WorkspaceIdentityV1 {
  constraints: WorkspaceFingerprintV1
  planScope: PlanScopeV1
  epoch: number
  acknowledgedAt: number
}

/* ───────── 校验结果 ───────── */

export type WorkspaceValidationReason =
  | 'not_object'
  | 'missing_field'
  | 'unknown_field'
  | 'invalid_field'
  | 'invalid_trip'
  | 'duplicate_id'
  | 'limit_exceeded'
  | 'unserializable'
  | 'owner_mismatch'

export interface WorkspaceValidationFailure {
  ok: false
  reason: WorkspaceValidationReason
  /** JSON 风格路径，如 `$.sidecar.constraints.items[0].kind`。 */
  path: string
  message: string
}

export type WorkspaceValidationResult<T> =
  | { ok: true; value: T }
  | WorkspaceValidationFailure

/** 工作区读取状态；实现见后续 workspaceStorage.ts。 */
export type WorkspaceStoreStatus =
  | 'ok'
  | 'empty'
  | 'unavailable'
  | 'corrupt'
  | 'anomaly'
  | 'unknown_version'

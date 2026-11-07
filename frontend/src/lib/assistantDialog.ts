/**
 * A 切片 · 对话式行程编辑：本地指令解析 → 结构化意图 → 提案卡计算（纯函数模块）。
 *
 * 边界（与 docs/ASSISTANT_DIALOG.md 对齐）：
 * - 本文件只含类型与纯函数：不 import React、不 fetch、不读写 localStorage、不读时钟、
 *   不调用 crypto；所有 id、时刻戳都由调用方提供。
 * - 解析是**本地确定性**的中文关键词 / 句式匹配：零联网、零外部 AI、零猜测。
 * - 五类意图：move_stop / add_from_pool / remove_stop / time_preference / pace_adjust；
 *   超出五类的输入一律解析为 unsupported（礼貌拒绝），不猜、不硬套。
 * - time_preference 与 pace_adjust 只产出「重排请求描述」（day + 偏好参数），由面板层
 *   喂给既有的 day replan 通道；本模块**不新增任何后端端点**。
 * - 硬门沿用 constraints.ts 的 evaluateConstraintsAgainstTrip：H 级直接禁 apply 且
 *   **不可 override**；U 级必须独立确认，确认绑定生成时的完整快照。
 * - 未知就是未知：null 表示未知，绝不补 0、绝不编造时刻 / 费用 / 坐标。
 * - 数字边界整 token 校验：时刻必须是合法 HH:MM（小时 0–23、分钟 0–59，`24:00`
 *   非法），天序号必须落在 1–366；非法值按未知处理并触发 needs_input，
 *   **绝不回退匹配成另一个时刻 / 另一天**。
 * - 在途提案零存储副作用：未应用前不写任何 storage key；应用也只是内存 transition，
 *   持久化仍由用户显式保存触发。
 *
 * 与既有模块的复用关系：
 * - constraints.ts：H/U 判定（evaluateConstraintsAgainstTrip）与标题归一（normalizeConstraintTitle）。
 * - candidatePool.ts：候选名归一（normalizeCandidateText）；候选坐标仍留在候选库。
 * - tripDraft.ts：天级编辑原语（copy-on-write、legs 重建、本地编辑摘要）。
 * - dayReplan.ts：既有单日重排请求构造（buildDayReplanRequest）。
 * - workspace.ts / workspaceFingerprint.ts：工作区 transition 与 canonical 指纹。
 */
import type { TravelMode, Trip, TripDay, TripStop } from './api'
import { normalizeCandidateText } from './candidatePool'
import {
  evaluateConstraintsAgainstTrip,
  normalizeConstraintTitle,
  type ConstraintIssue,
  type ConstraintTimeOrigin,
} from './constraints'
import { buildDayReplanRequest, type DayReplanRequest } from './dayReplan'
import {
  addDraftStop,
  applyDraft,
  createTripDraft,
  removeDraftStop,
  STOP_TIME_PATTERN,
  type TripDraft,
} from './tripDraft'
import { commitWorkspaceTransition } from './workspace'
import { fingerprintOf, fingerprintsMatch } from './workspaceFingerprint'
import type {
  CandidateItemV1,
  WorkspaceFingerprintV1,
  WorkspaceRecordV1,
} from './workspaceTypes'

/* ───────── 文案常量（边界见 docs/ASSISTANT_DIALOG.md §7：不得声称行程已经落实） ───────── */

/** 超出五类意图时的礼貌拒绝。 */
export const ASSISTANT_UNSUPPORTED_REASON =
  '暂时不支持这类操作，可以在行程面板里直接调整。'

/** 所有建议都带的未核实提示。 */
export const ASSISTANT_UNVERIFIED_NOTICE =
  '这是本地生成的建议：时间与地点都还没有核实，请以商家和官方渠道为准。'

/** 内存改动不落盘提示。 */
export const ASSISTANT_NO_SAVE_NOTICE =
  '这条建议只改内存里的行程，不会自动保存；保存、导出和备份仍由你显式操作。'

/** 时段占位时刻提示。 */
export const ASSISTANT_SLOT_TIME_NOTICE =
  '按时段安排的占位时刻只是计划值，还没有核实。'

/** 重排类提案的提示。 */
export const ASSISTANT_REPLAN_NOTICE =
  '这条建议交给既有的单日重排通道处理，会带上当前的必去点与预约时间约束再校验一次。'

/** 候选坐标不随站点进入行程的提示。 */
export const ASSISTANT_POOL_LOCATION_NOTICE =
  '收藏池候选的坐标留在候选库里；加入行程的站点不带坐标，也不会自动补一个假的坐标。'

/** 未知项的展示文案。 */
export const ASSISTANT_UNKNOWN_TEXT = '未知'

/* ───────── 意图 ───────── */

export type AssistantIntentKind =
  | 'move_stop'
  | 'add_from_pool'
  | 'remove_stop'
  | 'time_preference'
  | 'pace_adjust'
  | 'unsupported'

/** 时段：只用来决定插入位置与占位时刻，不用来编造精确时间。 */
export type AssistantSlot = 'morning' | 'afternoon' | 'evening'

export type AssistantTimePreference = 'stay_longer' | 'start_later' | 'start_earlier'
export type AssistantPacePreference = 'looser' | 'tighter'

/** 解析结果。每一项「没识别到」都是 null，不填默认值。 */
export interface AssistantParsedIntent {
  kind: AssistantIntentKind
  /** 目标站点 / 候选名原文；没识别到为 null。 */
  targetName: string | null
  /** 目标天序号（1..366）；没识别到、或指令里的天序号越界，为 null。 */
  day: number | null
  /** 目标时段；没识别到为 null。 */
  slot: AssistantSlot | null
  /** 显式时刻 HH:MM；没识别到、或指令里的时刻非法，为 null（非法时刻绝不回退成别的时刻）。 */
  time: string | null
  /** time_preference 的偏好方向；其它意图为 null。 */
  timePreference: AssistantTimePreference | null
  /** pace_adjust 的偏好方向；其它意图为 null。 */
  pacePreference: AssistantPacePreference | null
  /** 解析说明：命中了什么、缺了什么。 */
  notes: string[]
}

/* ───────── 提案卡 ───────── */

/** 站点级改动类型。 */
export type AssistantChangeType = 'add' | 'remove' | 'move' | 'time_change'

/** 时刻来源。slot_default 是按时段取的占位计划值，仍按未核实处理。 */
export type AssistantTimeSource = 'explicit' | 'inherited' | 'slot_default' | 'unknown'

/** 一条站点级改动。未知字段一律 null，由界面显示「未知」。 */
export interface AssistantProposalChange {
  type: AssistantChangeType
  /** 站点 id；未知为 null。 */
  stopId: string | null
  /** 站点 / 候选名原文。 */
  name: string
  /** 原所在天；未知为 null。 */
  fromDay: number | null
  /** 变更后所在天；未知为 null。 */
  toDay: number | null
  /** 变更前时刻；未知为 null（不补 0）。 */
  fromTime: string | null
  /** 变更后时刻；未知为 null（不补 0）。 */
  toTime: string | null
  timeSource: AssistantTimeSource
  /** 目标时段；未知为 null。 */
  slot: AssistantSlot | null
  /** 一句话说明。 */
  detail: string
}

/** 改动列表：已知与未知分列。 */
export interface AssistantProposalChanges {
  /** 已确定的改动。 */
  known: AssistantProposalChange[]
  /** 还有未知项的改动：目标没定位到、天没定、时刻未知；显示「未知」，不补 0、不编造。 */
  unknown: AssistantProposalChange[]
}

export type AssistantProposalStatus = 'pending' | 'applied' | 'discarded' | 'invalid'

/** 提案种类：改行程 / 走重排通道 / 不支持 / 还缺输入。 */
export type AssistantProposalKind = 'trip_change' | 'replan_request' | 'unsupported' | 'needs_input'

export type AssistantTimePreferenceParams = {
  kind: 'time_preference'
  effect: AssistantTimePreference
  day: number | null
  slot: AssistantSlot | null
  time: string | null
}

export type AssistantPacePreferenceParams = {
  kind: 'pace_adjust'
  effect: AssistantPacePreference
  day: number | null
  slot: AssistantSlot | null
}

export type AssistantPreferenceParams =
  | AssistantTimePreferenceParams
  | AssistantPacePreferenceParams

/** 重排请求描述：交给既有 day replan 通道，不新增端点。 */
export interface AssistantReplanRequest {
  /** 目标天。 */
  day: number
  /** 交给 buildDayReplanRequest 的指令原文。 */
  instruction: string
  /** 偏好参数（面板层展示用）。 */
  preference: AssistantPreferenceParams
}

/** U 级独立确认：绑定生成时的完整快照，快照一变即失效。 */
export interface AssistantUnverifiedAck {
  /** 确认绑定的 revision；必须等于提案生成时的 revision。 */
  revision: number
  /** 确认绑定的完整工作区指纹。 */
  fingerprint: WorkspaceFingerprintV1
  /** 确认时刻（epoch ms，由调用方提供）。 */
  acknowledgedAt: number
}

/** 提案卡。 */
export interface AssistantProposalCard {
  /** 提案 id：由调用方提供，本模块不生成随机 id。 */
  proposalId: string
  kind: AssistantProposalKind
  intent: AssistantIntentKind
  /** 原始指令。 */
  instruction: string
  /** 解析结果。 */
  parsed: AssistantParsedIntent
  /** 站点级改动（已知 / 未知分列）。 */
  changes: AssistantProposalChanges
  /** H / U 级冲突；直接来自 constraints.ts 的判定结果，不自造判定。 */
  conflicts: ConstraintIssue[]
  /** 一句话理由。 */
  reason: string
  /** 生成时的快照：工作区 revision。 */
  baseRevision: number
  /** 生成时的快照：整条工作区记录的完整指纹。 */
  baseFingerprint: WorkspaceFingerprintV1
  status: AssistantProposalStatus
  /** 应用用的候选行程；null = 本提案不直接改行程。 */
  candidateTrip: Trip | null
  /** 重排请求描述（time_preference / pace_adjust）。 */
  replanRequest: AssistantReplanRequest | null
  /** 既有单日重排通道的请求体；与 replanRequest 同时给出。 */
  replanApiRequest: DayReplanRequest | null
  /** 是否需要 U 级独立确认。 */
  requiresAck: boolean
  /** U 级确认；确认绑定生成时的快照。 */
  ack: AssistantUnverifiedAck | null
  /** 还缺「第几天」。 */
  needsDay: boolean
  /** 固定提示。 */
  notices: string[]
  /** status==='invalid' 时的原因。 */
  invalidReason: string | null
  /** 硬门本身没跑通时的原因（结构 / 容量不合法）。 */
  evaluationError: string | null
}

/* ───────── 输入 / 输出类型 ───────── */

export interface AssistantProposalInput {
  /** 提案 id；调用方提供。 */
  proposalId: string
  /** 原始指令。 */
  instruction: string
  /** 当前工作区记录；行程取 record.trip，约束取 record.sidecar.constraints。 */
  record: WorkspaceRecordV1
  /** 候选池（add_from_pool 用）。 */
  candidates: readonly CandidateItemV1[]
  /** 面板当前正在看的那天；用于「这天」这类相对指代；null = 未知。 */
  currentDay: number | null
  /** 出行方式；新建相邻路段时使用，调用方必须显式给出，本模块不猜。 */
  travelMode: TravelMode
  /** 调用方提供的 id：内存草稿容器用 fork id，新增站点用新 stop id。 */
  ids: {
    /** 内存草稿容器的 fork id；必须与 trip.id 不同（例如 createLogicalId()）。 */
    draftForkId: string
    /** 新增站点的 stop id（add_from_pool 必需）；必须与行程内已有 id 不同。 */
    newStopId: string | null
  }
  /**
   * stopId → 时间来源。缺省 / 未列出 / placeholder / unknown 一律按未知；
   * 只有显式 'known' 才按真实时刻参与 H 级硬核。
   */
  timeOrigins?: Readonly<Record<string, ConstraintTimeOrigin>> | null
}

export type AssistantProposalFailureReason = 'unserializable' | 'invalid_input'

export type AssistantProposalResult =
  | { ok: true; proposal: AssistantProposalCard }
  | { ok: false; reason: AssistantProposalFailureReason; message: string }

export interface AssistantApplyInput {
  /** 待应用的提案。 */
  proposal: AssistantProposalCard
  /** 应用时的真实工作区状态。 */
  record: WorkspaceRecordV1
  /** 现在时刻（epoch ms），用于工作区 transition。 */
  now: number
}

export type AssistantApplyFailureReason =
  | 'not_pending'
  | 'not_supported'
  | 'not_ready'
  | 'stale_revision'
  | 'stale_fingerprint'
  | 'ack_required'
  | 'ack_stale'
  | 'hard_blocked'
  | 'evaluation_failed'
  | 'transition_failed'

/** 撤销句柄：只保留应用后一层，不与行程草稿的 undo 栈串联。 */
export interface AssistantUndoHandle {
  proposalId: string
  /** 应用后的 revision；撤销时当前 revision 必须仍是它。 */
  appliedRevision: number
  /** 应用前的完整记录快照。 */
  previous: WorkspaceRecordV1
}

export type AssistantApplyResult =
  | {
      ok: true
      outcome: 'applied'
      proposal: AssistantProposalCard
      /** 应用后的工作区记录（workspaceRevision + 1）。 */
      record: WorkspaceRecordV1
      undo: AssistantUndoHandle
    }
  | { ok: true; outcome: 'replan_requested'; proposal: AssistantProposalCard; request: DayReplanRequest }
  | {
      ok: false
      outcome: 'rejected'
      reason: AssistantApplyFailureReason
      message: string
      /** 失败时的提案卡；失效时 status 已置为 'invalid'。 */
      proposal: AssistantProposalCard
      conflicts: ConstraintIssue[]
    }

export type AssistantUndoResult =
  | { ok: true; outcome: 'undone'; record: WorkspaceRecordV1 }
  | { ok: false; outcome: 'rejected'; reason: AssistantApplyFailureReason; message: string }

/* ───────── 解析用的词表 ───────── */

const MOVE_VERBS = ['挪到', '移到', '换到', '调到', '改到', '放到', '排到', '安排到'] as const
const REMOVE_VERBS = ['不要去', '别去', '去掉', '删掉', '删除', '移除', '取消'] as const
const ADD_VERBS = ['加到', '加进', '加在', '加入', '放进', '安排到'] as const
const POOL_MARKERS = ['收藏池', '候选池', '候选库', '收藏夹'] as const

const TARGET_PREFIXES = [
  '请帮我',
  '帮我',
  '麻烦你',
  '麻烦',
  '我想把',
  '我要把',
  '我想',
  '我要',
  '打算',
  '需要',
  '替我',
  '请',
  '把',
  '将',
] as const

const POOL_PARTICLES = ['里的', '中的', '内的', '里把', '中将', '里将'] as const

const TIME_PREFERENCE_PATTERNS: ReadonlyArray<[AssistantTimePreference, string[]]> = [
  ['stay_longer', ['停留久一点', '多待一会儿', '待久一点', '多留一会儿', '停留更久', '多待', '久一点']],
  ['start_later', ['晚点开始', '晚点出发', '晚一些开始', '晚一点开始', '推迟开始', '开始晚一点', '晚点']],
  ['start_earlier', ['早一点开始', '早点开始', '早一点出发', '早点出发', '提早开始', '开始早一点', '早些开始', '早一点']],
]

const PACE_PREFERENCE_PATTERNS: ReadonlyArray<[AssistantPacePreference, string[]]> = [
  ['looser', ['松一点', '松一些', '宽松', '轻松一点', '轻松些', '别那么赶', '不要那么赶', '排得松', '慢一点']],
  ['tighter', ['紧凑', '紧凑一点', '赶一点', '多排几个', '密一点', '充实一点', '排紧凑一点']],
]

/** 时段 → 计划占位时刻（只是计划值，硬门仍按未核实处理）。 */
const SLOT_DEFAULT_TIME: Readonly<Record<AssistantSlot, string>> = {
  morning: '09:00',
  afternoon: '14:00',
  evening: '19:00',
}

const SLOT_LABEL: Readonly<Record<AssistantSlot, string>> = {
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
}

const DAY_PATTERN = /第\s*(\d+)\s*天/
/**
 * 时刻 token 的形状：1–2 位小时 + 冒号 + 1–2 位分钟。
 *
 * 这里只取形状，合法与否交给 scanInstructionBoundaries 整 token 校验。
 * 旧写法 `([01]?\d|2[0-3]):([0-5]\d)` 会在「25:00」上回退匹配成「5:00」，
 * 于是凭空造出一个 05:00 —— 那是编造时刻，必须整 token 校验。
 */
const CLOCK_TOKEN_PATTERN = /(\d{1,2}):(\d{1,2})/g
/** 天序号的合法区间（与 anchors.ts 的天键口径一致）。 */
const MAX_DAY_NUMBER = 366

/* ───────── 解析 ───────── */

function normalizeInstruction(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** 指令里时刻与天序号的边界扫描结果。 */
interface InstructionBoundaries {
  /** 首个合法时刻（归一为 HH:MM）；指令里出现非法时刻时为 null。 */
  time: string | null
  /** 指令里出现但不合法的时刻原文（如 25:00）；没有为 null。 */
  invalidTime: string | null
  /** 指令里出现但越界的天序号原文（如 第 0 天）；没有为 null。 */
  invalidDay: string | null
}

/**
 * 扫描指令里的时刻与天序号，逐个整 token 校验边界。
 *
 * - 时刻：小时 0–23、分钟 0–59，分钟必须写两位（`9:30` 归一成 `09:30`，
 *   `9:5` 不算时刻）。`24:00` 一律非法 —— 与 constraints.ts / tripDraft.ts 的
 *   `STOP_TIME_PATTERN` 同一口径（本仓所有模块都不接受 24:00）。
 * - 天序号：1–366。
 * - **非法值不回退成别的值**：只要出现一个非法时刻，显式时刻一律为 `null`
 *   （宁可说不知道，也不编造一个 05:00）；越界天序号同理，不回落成别的天。
 */
function scanInstructionBoundaries(text: string): InstructionBoundaries {
  const normalized = normalizeInstruction(typeof text === 'string' ? text : '')
  const result: InstructionBoundaries = { time: null, invalidTime: null, invalidDay: null }
  let firstValidTime: string | null = null

  const clockPattern = new RegExp(CLOCK_TOKEN_PATTERN.source, 'g')
  let clockMatch = clockPattern.exec(normalized)
  while (clockMatch !== null) {
    const raw = clockMatch[0]
    const hour = Number.parseInt(clockMatch[1], 10)
    const minute = Number.parseInt(clockMatch[2], 10)
    const before = clockMatch.index > 0 ? normalized.charAt(clockMatch.index - 1) : ''
    const after = normalized.charAt(clockMatch.index + raw.length)
    // 与别的数字粘在一起（125:00 / 12:345）不是一个独立时刻，也不能拆开用。
    const glued = /\d/.test(before) || /\d/.test(after)
    const shaped = clockMatch[2].length === 2
    const legal =
      !glued &&
      shaped &&
      Number.isInteger(hour) &&
      Number.isInteger(minute) &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59
    if (!legal) {
      if (result.invalidTime === null) result.invalidTime = raw
    } else if (firstValidTime === null) {
      firstValidTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    }
    clockMatch = clockPattern.exec(normalized)
  }

  const dayPattern = new RegExp(DAY_PATTERN.source, 'g')
  let dayMatch = dayPattern.exec(normalized)
  while (dayMatch !== null) {
    const value = Number.parseInt(dayMatch[1], 10)
    if (!Number.isInteger(value) || value < 1 || value > MAX_DAY_NUMBER) {
      if (result.invalidDay === null) result.invalidDay = dayMatch[0].trim()
    }
    dayMatch = dayPattern.exec(normalized)
  }

  result.time = result.invalidTime === null ? firstValidTime : null
  return result
}

function findFirstToken(
  text: string,
  tokens: readonly string[],
): { index: number; token: string } | null {
  let best: { index: number; token: string } | null = null
  for (const token of tokens) {
    const index = text.indexOf(token)
    if (index < 0) continue
    if (
      best === null ||
      index < best.index ||
      (index === best.index && token.length > best.token.length)
    ) {
      best = { index, token }
    }
  }
  return best
}

function parseDayNumber(text: string): number | null {
  const match = DAY_PATTERN.exec(text)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  if (!Number.isInteger(value) || value < 1 || value > MAX_DAY_NUMBER) return null
  return value
}

function parseSlot(text: string): AssistantSlot | null {
  if (/晚上|傍晚|夜里|夜间|晚间/.test(text)) return 'evening'
  if (/中午|下午|午后/.test(text)) return 'afternoon'
  if (/早上|上午|清晨|一早/.test(text)) return 'morning'
  return null
}

function stripPrefixes(text: string, prefixes: readonly string[]): string {
  let current = text.trim()
  let changed = true
  while (changed) {
    changed = false
    for (const prefix of prefixes) {
      if (current.startsWith(prefix) && current.length > prefix.length) {
        current = current.slice(prefix.length).trim()
        changed = true
        break
      }
    }
  }
  return current
}

function unsupportedIntent(notes: string[]): AssistantParsedIntent {
  return {
    kind: 'unsupported',
    targetName: null,
    day: null,
    slot: null,
    time: null,
    timePreference: null,
    pacePreference: null,
    notes,
  }
}

/** 从「从收藏池里的西湖加到……」这类句式里取出候选名。 */
function extractPoolTarget(
  text: string,
  pool: { index: number; token: string },
  add: { index: number; token: string },
): string | null {
  const poolEnd = pool.index + pool.token.length
  const core = text.slice(poolEnd, add.index)
  let target = stripPrefixes(core, POOL_PARTICLES)
  target = stripPrefixes(target, ['把', '将'])
  if (target.length > 0) return target
  const before = text.slice(0, pool.index)
  const trimmed = stripPrefixes(before.replace(/从$/, ''), TARGET_PREFIXES)
  return trimmed.length > 0 ? trimmed : null
}

/** 从「去掉第 1 天的丝绸店」这类句式里取出天与站点名。 */
function extractRemoveTarget(
  text: string,
  remove: { index: number; token: string },
): { day: number | null; target: string | null } {
  let rest = text.slice(remove.index + remove.token.length).trim()
  let day: number | null = null
  const dayMatch = /^第\s*(\d+)\s*天\s*(?:的|里|中)?/.exec(rest)
  if (dayMatch) {
    const value = Number.parseInt(dayMatch[1], 10)
    if (Number.isInteger(value) && value >= 1 && value <= 366) day = value
    rest = rest.slice(dayMatch[0].length).trim()
  }
  const slotMatch = /^(?:早上|上午|清晨|中午|下午|午后|傍晚|晚上|夜里|夜间)\s*(?:的)?/.exec(rest)
  if (slotMatch) rest = rest.slice(slotMatch[0].length).trim()
  return { day, target: rest.length > 0 ? rest : null }
}

/** 从「把博物馆挪到第 2 天下午」这类句式里取出站点名。 */
function extractMoveTarget(text: string, move: { index: number; token: string }): string | null {
  let before = text.slice(0, move.index).trim()
  const pool = findFirstToken(before, POOL_MARKERS)
  if (pool) before = before.slice(0, pool.index).trim()
  const target = stripPrefixes(before, TARGET_PREFIXES)
  return target.length > 0 ? target : null
}

function matchTimePreference(text: string): AssistantTimePreference | null {
  for (const [effect, phrases] of TIME_PREFERENCE_PATTERNS) {
    for (const phrase of phrases) {
      if (text.includes(phrase)) return effect
    }
  }
  return null
}

function matchPacePreference(text: string): AssistantPacePreference | null {
  for (const [effect, phrases] of PACE_PREFERENCE_PATTERNS) {
    for (const phrase of phrases) {
      if (text.includes(phrase)) return effect
    }
  }
  return null
}

/**
 * 解析一条中文指令 → 结构化意图。
 *
 * 判定顺序是固定的：收藏池加入 → 删除 → 挪动 → 时间偏好 → 节奏调整 → 不支持。
 * 命中不了任何一类就返回 unsupported（礼貌拒绝），不猜、不硬套。
 */
export function parseAssistantIntent(text: string): AssistantParsedIntent {
  const normalized = normalizeInstruction(typeof text === 'string' ? text : '')
  if (!normalized) {
    return unsupportedIntent(['指令是空的，没有解析出任何意图。'])
  }

  const boundaries = scanInstructionBoundaries(normalized)
  const day = parseDayNumber(normalized)
  const slot = parseSlot(normalized)
  const time = boundaries.time
  const notes: string[] = []
  if (boundaries.invalidTime !== null) {
    notes.push(
      `时刻「${boundaries.invalidTime}」不是合法的 24 小时制时刻，已按未知处理，不回落成别的时刻。`,
    )
  }
  if (boundaries.invalidDay !== null) {
    notes.push(`「${boundaries.invalidDay}」不是有效的天序号（1–${MAX_DAY_NUMBER}），已按未知处理。`)
  }

  const pool = findFirstToken(normalized, POOL_MARKERS)
  if (pool) {
    const add = findFirstToken(normalized, ADD_VERBS)
    if (add) {
      const target = extractPoolTarget(normalized, pool, add)
      if (!target) {
        return unsupportedIntent([...notes, '提到收藏池，但没有说清楚要加入哪一个候选。'])
      }
      notes.push(`命中收藏池标记「${pool.token}」与加入动词「${add.token}」。`)
      return {
        kind: 'add_from_pool',
        targetName: target,
        day,
        slot,
        time,
        timePreference: null,
        pacePreference: null,
        notes,
      }
    }
  }

  const remove = findFirstToken(normalized, REMOVE_VERBS)
  if (remove) {
    const { day: removeDay, target } = extractRemoveTarget(normalized, remove)
    if (!target) {
      return unsupportedIntent([...notes, '有删除动词，但没有说清楚要删哪一个站点。'])
    }
    notes.push(`命中删除动词「${remove.token}」。`)
    return {
      kind: 'remove_stop',
      targetName: target,
      day: removeDay ?? day,
      slot,
      time,
      timePreference: null,
      pacePreference: null,
      notes,
    }
  }

  const move = findFirstToken(normalized, MOVE_VERBS)
  if (move) {
    const target = extractMoveTarget(normalized, move)
    if (!target) {
      return unsupportedIntent([...notes, '有挪动动词，但没有说清楚要挪哪一个站点。'])
    }
    notes.push(`命中挪动动词「${move.token}」。`)
    return {
      kind: 'move_stop',
      targetName: target,
      day,
      slot,
      time,
      timePreference: null,
      pacePreference: null,
      notes,
    }
  }

  const timePreference = matchTimePreference(normalized)
  if (timePreference) {
    notes.push(`命中时间偏好「${timePreference}」。`)
    return {
      kind: 'time_preference',
      targetName: null,
      day,
      slot,
      time,
      timePreference,
      pacePreference: null,
      notes,
    }
  }

  const pacePreference = matchPacePreference(normalized)
  if (pacePreference) {
    notes.push(`命中节奏偏好「${pacePreference}」。`)
    return {
      kind: 'pace_adjust',
      targetName: null,
      day,
      slot,
      time,
      timePreference: null,
      pacePreference,
      notes,
    }
  }

  return unsupportedIntent([...notes, '没有命中任何一类可执行的指令。'])
}

/* ───────── 行程定位工具 ───────── */

interface LocatedStop {
  day: number
  stop: TripStop
}

/** 按名字定位站点。优先精确匹配；同名多个 → 无法确定；找不到 → 没有找到。 */
function locateStop(
  trip: Trip,
  name: string,
  dayHint: number | null,
): { ok: true; found: LocatedStop } | { ok: false; message: string } {
  const days = dayHint === null ? trip.days : trip.days.filter((day) => day.day === dayHint)
  if (days.length === 0) {
    return { ok: false, message: `当前行程里没有第 ${dayHint} 天。` }
  }
  const exact: LocatedStop[] = []
  const loose: LocatedStop[] = []
  const target = normalizeConstraintTitle(name)
  for (const day of days) {
    for (const stop of day.stops) {
      if (stop.name === name) exact.push({ day: day.day, stop })
      else if (normalizeConstraintTitle(stop.name) === target) loose.push({ day: day.day, stop })
    }
  }
  const found = exact.length > 0 ? exact : loose
  if (found.length === 0) {
    return {
      ok: false,
      message: dayHint === null
        ? `当前行程里没有找到「${name}」。`
        : `第 ${dayHint} 天没有找到「${name}」。`,
    }
  }
  if (found.length > 1) {
    return {
      ok: false,
      message: `行程里有 ${found.length} 个同名站点「${name}」，无法确定是哪一个；不替你挑第一个。`,
    }
  }
  return { ok: true, found: found[0] }
}

/** 按名字定位收藏池候选。 */
function locateCandidate(
  candidates: readonly CandidateItemV1[],
  name: string,
): { ok: true; item: CandidateItemV1 } | { ok: false; message: string } {
  const exact = candidates.filter((item) => item.name === name)
  const found =
    exact.length > 0
      ? exact
      : candidates.filter((item) => normalizeCandidateText(item.name) === normalizeCandidateText(name))
  if (found.length === 0) {
    return { ok: false, message: `收藏池里没有找到「${name}」。` }
  }
  if (found.length > 1) {
    return {
      ok: false,
      message: `收藏池里有 ${found.length} 个同名候选「${name}」，无法确定是哪一个。`,
    }
  }
  return { ok: true, item: found[0] }
}

/** 站点时刻是否可读（严格 HH:MM）；不可读即未知，不补 0。 */
function readableTime(time: string): string | null {
  return STOP_TIME_PATTERN.test(time) ? time : null
}

function slotOfTime(time: string): AssistantSlot | null {
  if (!STOP_TIME_PATTERN.test(time)) return null
  const hour = Number.parseInt(time.slice(0, 2), 10)
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}

function slotRank(slot: AssistantSlot | null): number | null {
  if (slot === 'morning') return 0
  if (slot === 'afternoon') return 1
  if (slot === 'evening') return 2
  return null
}

/**
 * 时段 → 插入位置。只用当天已有的计划时刻做分桶；读不出的时刻不参与分桶。
 * 时段本身不改写任何站点时刻。
 */
function computeInsertIndex(day: TripDay | undefined, slot: AssistantSlot | null): number {
  const stops = day?.stops ?? []
  if (slot === null) return stops.length
  if (slot === 'morning') return 0
  const maxRank = slot === 'afternoon' ? 0 : 1
  let index = 0
  for (let position = 0; position < stops.length; position += 1) {
    const rank = slotRank(slotOfTime(stops[position].time))
    if (rank !== null && rank <= maxRank) index = position + 1
  }
  return index
}

/** 把新增站点换回原站点对象，保留坐标等原有字段（草稿新增路径只接受文字）。 */
function restoreStopObject(
  draft: TripDraft,
  dayNumber: number,
  stopId: string,
  stop: TripStop,
): TripDraft {
  const day = draft.days.find((item) => item.day === dayNumber)
  if (!day) return draft
  const index = day.stops.findIndex((item) => item.id === stopId)
  if (index < 0) return draft
  const stops = day.stops.map((item, position) => (position === index ? stop : item))
  const days = draft.days.map((item) => (item.day === dayNumber ? { ...item, stops } : item))
  return { ...draft, days }
}

/* ───────── 提案计算 ───────── */

function emptyChanges(): AssistantProposalChanges {
  return { known: [], unknown: [] }
}

function baseCard(
  input: AssistantProposalInput,
  parsed: AssistantParsedIntent,
  fingerprint: WorkspaceFingerprintV1,
): AssistantProposalCard {
  return {
    proposalId: input.proposalId,
    kind: 'needs_input',
    intent: parsed.kind,
    instruction: input.instruction,
    parsed,
    changes: emptyChanges(),
    conflicts: [],
    reason: '',
    baseRevision: input.record.workspaceRevision,
    baseFingerprint: fingerprint,
    status: 'pending',
    candidateTrip: null,
    replanRequest: null,
    replanApiRequest: null,
    requiresAck: false,
    ack: null,
    needsDay: false,
    notices: [ASSISTANT_UNVERIFIED_NOTICE],
    invalidReason: null,
    evaluationError: null,
  }
}

function unknownChange(
  type: AssistantChangeType,
  name: string,
  message: string,
  day: number | null,
): AssistantProposalChange {
  return {
    type,
    stopId: null,
    name,
    fromDay: null,
    toDay: day,
    fromTime: null,
    toTime: null,
    timeSource: 'unknown',
    slot: null,
    detail: message,
  }
}

function slotSuffix(slot: AssistantSlot | null): string {
  return slot === null ? '' : SLOT_LABEL[slot]
}

/** 重排通道的指令原文：只描述偏好，不夹带坐标、费用或任何未核实结论。 */
function buildReplanInstruction(parsed: AssistantParsedIntent, day: number): string {
  if (parsed.kind === 'time_preference') {
    if (parsed.timePreference === 'stay_longer') {
      return `第 ${day} 天整体停留更久一些：每个站点可以多留一些时间，站点之间不要排得太满。`
    }
    if (parsed.timePreference === 'start_later') {
      return `第 ${day} 天整体晚一点开始：把当天第一个站点往后挪，后面的站点顺序不变。`
    }
    if (parsed.timePreference === 'start_earlier') {
      return `第 ${day} 天整体早一点开始：把当天第一个站点往前挪，后面的站点顺序不变。`
    }
    return `第 ${day} 天按时间偏好调整一天的开始与停留。`
  }
  if (parsed.kind === 'pace_adjust') {
    if (parsed.pacePreference === 'looser') {
      return `第 ${day} 天安排松一点：适当减少当天站点数量，留出休息与机动时间。`
    }
    if (parsed.pacePreference === 'tighter') {
      return `第 ${day} 天安排紧凑一点：尽量把当天站点排得饱满一些，注意别超过单日站点上限。`
    }
    return `第 ${day} 天按节奏偏好调整当天的松紧。`
  }
  return `第 ${day} 天按你的要求调整。`
}

/**
 * 指令里的非法数字引用 → 一句话说明（null = 没有非法引用）。
 *
 * - 非法时刻只影响「挪动 / 加入」这两类需要定开始时刻的意图；
 *   删除与重排不按时刻做决定，因此不受影响。
 * - 越界天序号对四类都成立：绝不回落成 `currentDay` 或别的天。
 */
function describeInvalidReference(
  parsed: AssistantParsedIntent,
  boundaries: InstructionBoundaries,
): string | null {
  if (boundaries.invalidDay !== null) {
    return `指令里的「${boundaries.invalidDay}」不是有效的天序号（1–${MAX_DAY_NUMBER}），请说明是第几天。`
  }
  if (
    boundaries.invalidTime !== null &&
    (parsed.kind === 'move_stop' || parsed.kind === 'add_from_pool')
  ) {
    return `指令里的时刻「${boundaries.invalidTime}」不是合法的 24 小时制时刻（小时 0–23、分钟 0–59），请给一个合法时刻。`
  }
  return null
}

function buildReplanProposal(
  input: AssistantProposalInput,
  parsed: AssistantParsedIntent,
  base: AssistantProposalCard,
  boundaries: InstructionBoundaries,
): AssistantProposalResult {
  if (boundaries.invalidDay !== null) {
    const message = `指令里的「${boundaries.invalidDay}」不是有效的天序号（1–${MAX_DAY_NUMBER}），请说明是第几天。`
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        needsDay: true,
        reason: message,
      },
    }
  }
  const day = parsed.day ?? input.currentDay
  if (day === null) {
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        needsDay: true,
        reason: '需要先说明是第几天，才能生成单日重排请求。',
      },
    }
  }
  const instruction = buildReplanInstruction(parsed, day)
  const built = buildDayReplanRequest(input.record.trip, day, instruction, {
    travel_mode: input.travelMode,
    parentRevision: input.record.workspaceRevision,
  })
  if (!built.ok) {
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        reason: built.message,
        notices: [...base.notices, ASSISTANT_REPLAN_NOTICE],
      },
    }
  }
  const preference: AssistantPreferenceParams =
    parsed.kind === 'time_preference'
      ? {
          kind: 'time_preference',
          effect: parsed.timePreference ?? 'stay_longer',
          day,
          slot: parsed.slot,
          time: parsed.time,
        }
      : {
          kind: 'pace_adjust',
          effect: parsed.pacePreference ?? 'looser',
          day,
          slot: parsed.slot,
        }
  return {
    ok: true,
    proposal: {
      ...base,
      kind: 'replan_request',
      reason: `给第 ${day} 天生成一条单日重排请求：${instruction}`,
      replanRequest: { day, instruction, preference },
      replanApiRequest: built.request,
      notices: [...base.notices, ASSISTANT_REPLAN_NOTICE],
    },
  }
}

/** 沿用 constraints.ts 的既有 H/U 判定，不自造放宽版。 */
function evaluateCandidate(
  input: AssistantProposalInput,
  candidateTrip: Trip,
): { conflicts: ConstraintIssue[]; requiresAck: boolean; error: string | null } {
  const evaluation = evaluateConstraintsAgainstTrip({
    constraints: input.record.sidecar.constraints,
    trip: candidateTrip,
    sourceTrip: input.record.trip,
    timeOrigins: input.timeOrigins ?? null,
  })
  if (!evaluation.ok) {
    return { conflicts: [], requiresAck: false, error: evaluation.message }
  }
  return {
    conflicts: [...evaluation.hardIssues, ...evaluation.unknownIssues],
    requiresAck: evaluation.requiresAck,
    error: null,
  }
}

function buildTripChangeProposal(
  input: AssistantProposalInput,
  parsed: AssistantParsedIntent,
  base: AssistantProposalCard,
  boundaries: InstructionBoundaries,
): AssistantProposalResult {
  const trip = input.record.trip
  const notices = [...base.notices, ASSISTANT_NO_SAVE_NOTICE]
  const known: AssistantProposalChange[] = []
  const unknown: AssistantProposalChange[] = []

  // 非法时刻 / 越界天序号：按未知处理，绝不编造时刻、绝不回落到别的天。
  const invalidReference = describeInvalidReference(parsed, boundaries)
  if (invalidReference !== null) {
    const type: AssistantChangeType =
      parsed.kind === 'remove_stop' ? 'remove' : parsed.kind === 'add_from_pool' ? 'add' : 'move'
    unknown.push(unknownChange(type, parsed.targetName ?? '', invalidReference, parsed.day))
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        needsDay: boundaries.invalidDay !== null,
        changes: { known, unknown },
        reason: invalidReference,
        notices,
      },
    }
  }

  if (parsed.kind === 'remove_stop') {
    const name = parsed.targetName
    if (!name) {
      return {
        ok: true,
        proposal: { ...base, kind: 'unsupported', reason: ASSISTANT_UNSUPPORTED_REASON },
      }
    }
    const located = locateStop(trip, name, parsed.day)
    if (!located.ok) {
      unknown.push(unknownChange('remove', name, located.message, parsed.day))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: located.message,
          notices,
        },
      }
    }
    const stop = located.found.stop
    const draft = createTripDraft(trip, {
      forkTripId: input.ids.draftForkId,
      newLegMode: input.travelMode,
    })
    if (!draft.ok) {
      unknown.push(unknownChange('remove', name, draft.message, parsed.day))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: draft.message,
          notices,
        },
      }
    }
    const removed = removeDraftStop(draft.draft, located.found.day, stop.id)
    if (!removed.ok) {
      unknown.push(unknownChange('remove', name, removed.message, parsed.day))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: removed.message,
          notices,
        },
      }
    }
    const applied = applyDraft(removed.draft)
    if (!applied.ok || !applied.changed) {
      const message = applied.ok
        ? `删掉「${stop.name}」没有产生实际变化。`
        : applied.message
      unknown.push(unknownChange('remove', name, message, parsed.day))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: message,
          notices,
        },
      }
    }
    const change: AssistantProposalChange = {
      type: 'remove',
      stopId: stop.id,
      name: stop.name,
      fromDay: located.found.day,
      toDay: null,
      fromTime: readableTime(stop.time),
      toTime: null,
      timeSource: 'inherited',
      slot: null,
      detail: `删掉第 ${located.found.day} 天的「${stop.name}」。`,
    }
    known.push(change)
    const candidateTrip: Trip = { ...applied.trip, id: trip.id }
    const evaluation = evaluateCandidate(input, candidateTrip)
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'trip_change',
        changes: { known, unknown },
        conflicts: evaluation.conflicts,
        requiresAck: evaluation.requiresAck,
        evaluationError: evaluation.error,
        candidateTrip,
        reason: change.detail,
        notices,
      },
    }
  }

  if (parsed.kind === 'move_stop') {
    const name = parsed.targetName
    if (!name) {
      return {
        ok: true,
        proposal: { ...base, kind: 'unsupported', reason: ASSISTANT_UNSUPPORTED_REASON },
      }
    }
    const located = locateStop(trip, name, null)
    if (!located.ok) {
      unknown.push(unknownChange('move', name, located.message, parsed.day))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: located.message,
          notices,
        },
      }
    }
    const stop = located.found.stop
    const destDay = parsed.day ?? input.currentDay
    if (destDay === null) {
      const message = '没有说明挪到第几天。'
      unknown.push(unknownChange('move', name, message, null))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          needsDay: true,
          changes: { known, unknown },
          reason: message,
          notices,
        },
      }
    }
    if (!trip.days.some((day) => day.day === destDay)) {
      const message = `当前行程里没有第 ${destDay} 天。`
      unknown.push(unknownChange('move', name, message, destDay))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: message,
          notices,
        },
      }
    }
    const inherited = readableTime(stop.time)
    const nextTime = parsed.time ?? inherited ?? (parsed.slot ? SLOT_DEFAULT_TIME[parsed.slot] : null)
    if (nextTime === null) {
      const message = `没有说明「${stop.name}」挪过去之后的开始时间。`
      unknown.push(unknownChange('move', name, message, destDay))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: message,
          notices,
        },
      }
    }
    const timeSource: AssistantTimeSource = parsed.time
      ? 'explicit'
      : inherited !== null
        ? 'inherited'
        : 'slot_default'

    const draft = createTripDraft(trip, {
      forkTripId: input.ids.draftForkId,
      newLegMode: input.travelMode,
    })
    if (!draft.ok) {
      unknown.push(unknownChange('move', name, draft.message, destDay))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: draft.message,
          notices,
        },
      }
    }
    const removed = removeDraftStop(draft.draft, located.found.day, stop.id)
    if (!removed.ok) {
      unknown.push(unknownChange('move', name, removed.message, destDay))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: removed.message,
          notices,
        },
      }
    }
    const postDay = removed.draft.days.find((day) => day.day === destDay)
    const index = computeInsertIndex(postDay, parsed.slot)
    const added = addDraftStop(
      removed.draft,
      destDay,
      {
        id: stop.id,
        name: stop.name,
        time: nextTime,
        duration_minutes: stop.duration_minutes,
        description: stop.description,
        address: stop.address,
        location: null,
      },
      { index },
    )
    if (!added.ok) {
      unknown.push(unknownChange('move', name, added.message, destDay))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: added.message,
          notices,
        },
      }
    }
    const restored = restoreStopObject(added.draft, destDay, stop.id, { ...stop, time: nextTime })
    const applied = applyDraft(restored)
    if (!applied.ok || !applied.changed) {
      const message = applied.ok ? `挪动「${stop.name}」没有产生实际变化。` : applied.message
      unknown.push(unknownChange('move', name, message, destDay))
      return {
        ok: true,
        proposal: {
          ...base,
          kind: 'needs_input',
          changes: { known, unknown },
          reason: message,
          notices,
        },
      }
    }
    const change: AssistantProposalChange = {
      type: 'move',
      stopId: stop.id,
      name: stop.name,
      fromDay: located.found.day,
      toDay: destDay,
      fromTime: inherited,
      toTime: nextTime,
      timeSource,
      slot: parsed.slot,
      detail: `把「${stop.name}」从第 ${located.found.day} 天挪到第 ${destDay} 天${slotSuffix(parsed.slot)}。`,
    }
    known.push(change)
    if (inherited !== nextTime) {
      known.push({
        type: 'time_change',
        stopId: stop.id,
        name: stop.name,
        fromDay: located.found.day,
        toDay: destDay,
        fromTime: inherited,
        toTime: nextTime,
        timeSource,
        slot: parsed.slot,
        detail: `「${stop.name}」的开始时刻从 ${inherited ?? ASSISTANT_UNKNOWN_TEXT} 改成 ${nextTime}。`,
      })
    }
    const candidateTrip: Trip = { ...applied.trip, id: trip.id }
    const evaluation = evaluateCandidate(input, candidateTrip)
    const moveNotices =
      timeSource === 'slot_default' ? [...notices, ASSISTANT_SLOT_TIME_NOTICE] : notices
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'trip_change',
        changes: { known, unknown },
        conflicts: evaluation.conflicts,
        requiresAck: evaluation.requiresAck,
        evaluationError: evaluation.error,
        candidateTrip,
        reason: change.detail,
        notices: moveNotices,
      },
    }
  }

  // add_from_pool
  const name = parsed.targetName
  if (!name) {
    return {
      ok: true,
      proposal: { ...base, kind: 'unsupported', reason: ASSISTANT_UNSUPPORTED_REASON },
    }
  }
  const located = locateCandidate(input.candidates, name)
  if (!located.ok) {
    unknown.push(unknownChange('add', name, located.message, parsed.day))
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        changes: { known, unknown },
        reason: located.message,
        notices,
      },
    }
  }
  const candidate = located.item
  const destDay = parsed.day ?? input.currentDay
  if (destDay === null) {
    const message = '没有说明加到第几天。'
    unknown.push(unknownChange('add', name, message, null))
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        needsDay: true,
        changes: { known, unknown },
        reason: message,
        notices,
      },
    }
  }
  if (!trip.days.some((day) => day.day === destDay)) {
    const message = `当前行程里没有第 ${destDay} 天。`
    unknown.push(unknownChange('add', name, message, destDay))
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        changes: { known, unknown },
        reason: message,
        notices,
      },
    }
  }
  const startTime = parsed.time ?? (parsed.slot ? SLOT_DEFAULT_TIME[parsed.slot] : null)
  if (startTime === null) {
    const message = `没有说明「${candidate.name}」加入后的开始时间。`
    unknown.push(unknownChange('add', name, message, destDay))
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        changes: { known, unknown },
        reason: message,
        notices,
      },
    }
  }
  if (!input.ids.newStopId) {
    const message = '调用方没有提供新站点 id，没有生成加入方案。'
    unknown.push(unknownChange('add', name, message, destDay))
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        changes: { known, unknown },
        reason: message,
        notices,
      },
    }
  }
  const draft = createTripDraft(trip, {
    forkTripId: input.ids.draftForkId,
    newLegMode: input.travelMode,
  })
  if (!draft.ok) {
    unknown.push(unknownChange('add', name, draft.message, destDay))
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        changes: { known, unknown },
        reason: draft.message,
        notices,
      },
    }
  }
  const targetDay = draft.draft.days.find((day) => day.day === destDay)
  const index = computeInsertIndex(targetDay, parsed.slot)
  const added = addDraftStop(
    draft.draft,
    destDay,
    {
      id: input.ids.newStopId,
      name: candidate.name,
      time: startTime,
      // 停留时长未知：不补 0。
      duration_minutes: null,
      description: candidate.notes ?? '',
      address: candidate.address ?? '',
      // 坐标留在候选库：新增站点不带坐标，也不补 (0,0)。
      location: null,
    },
    { index },
  )
  if (!added.ok) {
    unknown.push(unknownChange('add', name, added.message, destDay))
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        changes: { known, unknown },
        reason: added.message,
        notices,
      },
    }
  }
  const applied = applyDraft(added.draft)
  if (!applied.ok || !applied.changed) {
    const message = applied.ok
      ? `把「${candidate.name}」加入第 ${destDay} 天没有产生实际变化。`
      : applied.message
    unknown.push(unknownChange('add', name, message, destDay))
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'needs_input',
        changes: { known, unknown },
        reason: message,
        notices,
      },
    }
  }
  const timeSource: AssistantTimeSource = parsed.time ? 'explicit' : 'slot_default'
  const change: AssistantProposalChange = {
    type: 'add',
    stopId: input.ids.newStopId,
    name: candidate.name,
    fromDay: null,
    toDay: destDay,
    fromTime: null,
    toTime: startTime,
    timeSource,
    slot: parsed.slot,
    detail: `把收藏池里的「${candidate.name}」加到第 ${destDay} 天${slotSuffix(parsed.slot)}。`,
  }
  known.push(change)
  const candidateTrip: Trip = { ...applied.trip, id: trip.id }
  const evaluation = evaluateCandidate(input, candidateTrip)
  const addNotices =
    timeSource === 'slot_default'
      ? [...notices, ASSISTANT_SLOT_TIME_NOTICE, ASSISTANT_POOL_LOCATION_NOTICE]
      : [...notices, ASSISTANT_POOL_LOCATION_NOTICE]
  return {
    ok: true,
    proposal: {
      ...base,
      kind: 'trip_change',
      changes: { known, unknown },
      conflicts: evaluation.conflicts,
      requiresAck: evaluation.requiresAck,
      evaluationError: evaluation.error,
      candidateTrip,
      reason: change.detail,
      notices: addNotices,
    },
  }
}

/**
 * 解析 + 计算一张提案卡。
 *
 * 这是纯函数：只读入参里的工作区记录与候选池，不改任何入参，不写任何存储。
 * 提案卡带 baseRevision / baseFingerprint 快照，应用层据此判定 ABA 失效。
 */
export function buildAssistantProposal(
  input: AssistantProposalInput,
): AssistantProposalResult {
  const parsed = parseAssistantIntent(input.instruction)
  const boundaries = scanInstructionBoundaries(input.instruction)
  const fingerprint = fingerprintOf(input.record)
  if (!fingerprint.ok) {
    return {
      ok: false,
      reason: 'unserializable',
      message: `当前工作区无法生成指纹：${fingerprint.message}`,
    }
  }
  const base = baseCard(input, parsed, fingerprint.fingerprint)

  if (parsed.kind === 'unsupported') {
    return {
      ok: true,
      proposal: {
        ...base,
        kind: 'unsupported',
        reason: ASSISTANT_UNSUPPORTED_REASON,
        notices: [...base.notices, ASSISTANT_UNSUPPORTED_REASON],
      },
    }
  }
  if (parsed.kind === 'time_preference' || parsed.kind === 'pace_adjust') {
    return buildReplanProposal(input, parsed, base, boundaries)
  }
  return buildTripChangeProposal(input, parsed, base, boundaries)
}

/* ───────── 应用 / 撤销 ───────── */

/** U 级独立确认：绑定生成时的完整快照。 */
export function confirmAssistantUnverified(
  proposal: AssistantProposalCard,
  acknowledgedAt: number,
): AssistantProposalCard {
  return {
    ...proposal,
    requiresAck: true,
    ack: {
      revision: proposal.baseRevision,
      fingerprint: proposal.baseFingerprint,
      acknowledgedAt,
    },
  }
}

/** 确认是否仍然绑定当前快照；任何变化都视为过期。 */
export function isAssistantAckFresh(
  proposal: AssistantProposalCard,
  record: WorkspaceRecordV1,
): boolean {
  const ack = proposal.ack
  if (!ack) return false
  if (ack.revision !== proposal.baseRevision) return false
  if (!fingerprintsMatch(ack.fingerprint, proposal.baseFingerprint)) return false
  if (record.workspaceRevision !== ack.revision) return false
  const current = fingerprintOf(record)
  return current.ok && fingerprintsMatch(current.fingerprint, ack.fingerprint)
}

function reject(
  proposal: AssistantProposalCard,
  reason: AssistantApplyFailureReason,
  message: string,
  conflicts: ConstraintIssue[] = [],
): AssistantApplyResult {
  return {
    ok: false,
    outcome: 'rejected',
    reason,
    message,
    proposal,
    conflicts,
  }
}

function rejectInvalid(
  proposal: AssistantProposalCard,
  reason: AssistantApplyFailureReason,
  message: string,
  conflicts: ConstraintIssue[] = [],
): AssistantApplyResult {
  return {
    ok: false,
    outcome: 'rejected',
    reason,
    message,
    proposal: { ...proposal, status: 'invalid', invalidReason: message },
    conflicts,
  }
}

/**
 * 应用一张提案。
 *
 * - 生效前先核对快照：revision 或指纹对不上 → 失效（invalid），绝不静默套用。
 * - H 级冲突直接拒绝，且**没有**任何确认绕过入口。
 * - U 级冲突必须有独立确认，且确认必须绑定当前快照。
 * - 应用是一次内存 transition：workspaceRevision + 1；本函数不写存储。
 */
export function applyAssistantProposal(input: AssistantApplyInput): AssistantApplyResult {
  const { proposal, record } = input

  if (proposal.status !== 'pending') {
    return reject(proposal, 'not_pending', '这条提案已经不是待确认状态，没有应用。')
  }
  if (proposal.kind === 'unsupported') {
    return reject(proposal, 'not_supported', ASSISTANT_UNSUPPORTED_REASON)
  }
  if (proposal.kind === 'needs_input' || proposal.needsDay) {
    return reject(proposal, 'not_ready', proposal.reason || '这条提案还缺少必要信息，没有应用。')
  }
  if (record.workspaceRevision !== proposal.baseRevision) {
    return rejectInvalid(
      proposal,
      'stale_revision',
      '工作区版本已经变化，这条提案已失效；请重新生成。',
    )
  }
  const current = fingerprintOf(record)
  if (!current.ok) {
    return reject(
      proposal,
      'transition_failed',
      `当前工作区无法序列化：${current.message}`,
    )
  }
  if (!fingerprintsMatch(current.fingerprint, proposal.baseFingerprint)) {
    return rejectInvalid(
      proposal,
      'stale_fingerprint',
      '工作区内容已经变化，这条提案已失效；请重新生成。',
    )
  }

  if (proposal.kind === 'replan_request') {
    if (!proposal.replanApiRequest) {
      return reject(proposal, 'not_ready', '这条重排请求还不完整，没有发起。')
    }
    return {
      ok: true,
      outcome: 'replan_requested',
      proposal,
      request: proposal.replanApiRequest,
    }
  }

  if (proposal.evaluationError) {
    return reject(
      proposal,
      'evaluation_failed',
      `约束硬门没有跑通，不能应用：${proposal.evaluationError}`,
    )
  }
  const hardIssues = proposal.conflicts.filter((issue) => issue.severity === 'H')
  if (hardIssues.length > 0) {
    return reject(
      proposal,
      'hard_blocked',
      '存在 H 级硬冲突，不能应用；这个结论不能靠确认绕过。',
      hardIssues,
    )
  }
  const unknownIssues = proposal.conflicts.filter((issue) => issue.severity === 'U')
  if (unknownIssues.length > 0) {
    if (!proposal.ack) {
      return reject(
        proposal,
        'ack_required',
        '有未核实的项目，需要单独确认后才能应用。',
        unknownIssues,
      )
    }
    if (!isAssistantAckFresh(proposal, record)) {
      return rejectInvalid(
        proposal,
        'ack_stale',
        '确认时的快照已经过期，需要重新确认后再应用。',
        unknownIssues,
      )
    }
  }
  if (!proposal.candidateTrip) {
    return reject(proposal, 'not_ready', '这条提案没有候选行程，没有应用。')
  }

  const next = commitWorkspaceTransition(record, { trip: proposal.candidateTrip }, input.now)
  if (!next.ok) {
    return reject(
      proposal,
      'transition_failed',
      `工作区没有接受这次改动：${next.message}`,
    )
  }
  return {
    ok: true,
    outcome: 'applied',
    proposal: { ...proposal, status: 'applied' },
    record: next.value,
    undo: {
      proposalId: proposal.proposalId,
      appliedRevision: next.value.workspaceRevision,
      previous: record,
    },
  }
}

/**
 * 撤销一次应用。只保留应用后一层，**不与行程草稿的 undo 栈串联**。
 * 撤销同样是一次 transition：revision 继续 +1，绝不恢复旧 revision。
 */
export function undoAssistantProposal(
  handle: AssistantUndoHandle,
  current: WorkspaceRecordV1,
  now: number,
): AssistantUndoResult {
  if (current.workspaceRevision !== handle.appliedRevision) {
    return {
      ok: false,
      outcome: 'rejected',
      reason: 'stale_revision',
      message: '工作区版本已经变化，这次撤销没有执行；请重新确认当前状态。',
    }
  }
  const next = commitWorkspaceTransition(current, { trip: handle.previous.trip }, now)
  if (!next.ok) {
    return {
      ok: false,
      outcome: 'rejected',
      reason: 'transition_failed',
      message: `工作区没有接受这次撤销：${next.message}`,
    }
  }
  return { ok: true, outcome: 'undone', record: next.value }
}

/** 放弃一条提案：只改卡片状态，零写入、零存储副作用。 */
export function discardAssistantProposal(
  proposal: AssistantProposalCard,
): AssistantProposalCard {
  return { ...proposal, status: 'discarded' }
}

/* ───────── 展示文案 ───────── */

/** 把一条改动渲染成一句话；未知项显示「未知」，绝不显示 0 或编造值。 */
export function describeAssistantChange(change: AssistantProposalChange): string {
  const from = change.fromTime ?? ASSISTANT_UNKNOWN_TEXT
  const to = change.toTime ?? ASSISTANT_UNKNOWN_TEXT
  const fromDay = change.fromDay ?? ASSISTANT_UNKNOWN_TEXT
  const toDay = change.toDay ?? ASSISTANT_UNKNOWN_TEXT
  let text: string
  switch (change.type) {
    case 'add':
      text = `新增「${change.name}」到第 ${toDay} 天`
      break
    case 'remove':
      text = `删除第 ${fromDay} 天的「${change.name}」`
      break
    case 'move':
      text = `把「${change.name}」从第 ${fromDay} 天挪到第 ${toDay} 天`
      break
    case 'time_change':
      text = `「${change.name}」的开始时刻从 ${from} 改成 ${to}`
      break
    default:
      text = change.detail
      break
  }
  if (change.type === 'time_change') return text
  const time = change.type === 'remove' ? from : to
  const suffix =
    change.timeSource === 'slot_default'
      ? '，按时段取的占位时刻，未核实'
      : change.timeSource === 'unknown'
        ? '，未知'
        : ''
  return `${text}（${time}${suffix}）`
}

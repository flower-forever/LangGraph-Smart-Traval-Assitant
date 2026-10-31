/**
 * 费用草稿文件备份与导入：纯函数模块（不碰 DOM / Blob / 网络 / 存储）。
 *
 * 边界（与 trip-budget-transfer-brief.md 对齐）：
 * - 这是草稿备份，不是报价单：金额是用户手填或此前确认导入的原字符串，
 *   空、0、未完 / 非法金额都原样保留，不因非法金额丢数据、不补 0、不截断。
 *   数字可计算性不做备份合法性门槛：算不出合计照样能备份 / 导入，计算仍走
 *   ./tripBudget.ts 的既有规则（未填不当 0、无效单独列出）。
 * - 导出只投影已知字段：trip 只写 { id, title } 自述（不能证明文件真的属于
 *   当前行程），draft 只写 budgetRaw 与 rows 的 id / category / name / amountRaw；
 *   session.owner.tripSnapshot / revision / undo / result / 未知 extra 一律不落盘。
 * - 同一草稿确定性输出：不写导出时间、不读时钟、不掺随机数。
 * - 解析按「体积 → 语法（容忍一个前导 UTF-8 BOM）→ format / version / currency →
 *   结构（行数、行 id 唯一、字段类型）」的顺序 fail-closed，失败文案固定，
 *   不回显文件内容；未知字段不进输出。
 * - 应用（applyBudgetImport）用 ./tripBudget.ts 的 createBudgetForTrip 建立
 *   当前 owner，再替换已验证的 rows / budgetRaw；undo 保存应用前的一层
 *   owner / rows / budgetRaw（不递归）。本模块不修改 ./tripBudget.ts。
 * - 文件名来自导出自述的元数据并安全净化；不伪造 Trip 对象去调旧导出函数。
 */

import {
  MAX_BUDGET_ITEMS,
  computeBudgetSummary,
  createBudgetForTrip,
  emptyBudgetSession,
  type BudgetCategoryId,
  type BudgetSessionState,
  type BudgetTripContext,
  isBudgetCategoryId,
} from './tripBudget'
import { utf8ByteLength } from './savedTrips'
import { sanitizeFilenamePart } from './icsFile'

/** 备份文件的 format 标识；与行程 JSON 备份的 'travel-assistant.trip' 互不相认 */
export const BUDGET_TRANSFER_FORMAT = 'travel-assistant.budget'

/** 当前写出的结构版本；解析时只认这个数字，字符串 '1' 也算不匹配 */
export const BUDGET_TRANSFER_VERSION = 1

/** .budget.json 的 MIME；带 charset 让接收端按 UTF-8 解码中文 */
export const BUDGET_TRANSFER_MIME_TYPE = 'application/json;charset=utf-8'

export const BUDGET_TRANSFER_FILE_EXTENSION = '.budget.json'

/** 生成的备份 JSON 的 UTF-8 总上限（256 KiB，实字节）；生成后与解析前都按它门禁 */
export const MAX_BUDGET_TRANSFER_BYTES = 256 * 1024

/** 导入时文件 / 文本统一上限；解析前再按真实 UTF-8 字节复核，BOM 也算进去 */
export const MAX_BUDGET_FILE_BYTES = MAX_BUDGET_TRANSFER_BYTES

/** 明文分享提醒：导出的是可读 JSON，里面可能有用户自己填写的名称 */
export const BUDGET_JSON_SHARE_NOTICE =
  '这是一份明文 JSON 文件：费用名称等字段按填写时的原样保存，' +
  '其中可能包含你自己填写的内容。分享或上传前请确认这些内容可以外传，本工具不做脱敏。'

/** 费用金额来源口径：界面与文档都需要把「都是你自己填的」改成这句 */
export const BUDGET_RECORD_SOURCE_TEXT =
  '金额是你输入或此前确认导入的记录，不是任何服务提供者的报价；实际花费没有经过核实。'

const MESSAGE_PARSE_ERROR = '文件内容不是合法的 JSON，无法读取。请确认选择的是本工具导出的费用备份文件。'
const MESSAGE_NOT_TEXT = '文件内容不是文本，无法读取。请确认选择的是 UTF-8 编码的费用备份文件。'
const MESSAGE_FORMAT_MISMATCH = '这个文件不是本工具的费用备份（format 字段不匹配），未导入任何内容。'
const MESSAGE_VERSION_MISMATCH =
  `备份文件的结构版本不受支持：当前只支持第 ${BUDGET_TRANSFER_VERSION} 版的费用备份，未导入任何内容。`
const MESSAGE_CURRENCY_MISMATCH = '这个文件记录的不是人民币 CNY 费用，未导入任何内容。'
const MESSAGE_INVALID_STRUCTURE =
  '这份费用备份的结构不完整或包含异常内容（缺少字段、字段类型不对、' +
  `费用项超过 ${MAX_BUDGET_ITEMS} 项或 id 重复），未导入任何内容。`

/** 体积超限的固定文案；bytes / limit 都是本模块的常量或文件大小，不含文件内容 */
export function formatBudgetTooLargeMessage(bytes: number, limit = MAX_BUDGET_FILE_BYTES): string {
  const sizeKb = Math.max(1, Math.ceil(bytes / 1024))
  const limitKb = Math.max(1, Math.round(limit / 1024))
  return `文件体积约 ${sizeKb} KB，超过 ${limitKb} KB 的上限，已拒绝，未导入任何内容。`
}

/* ───────── envelope 类型与投影 ───────── */

export interface BudgetTransferTripSelf {
  readonly id: string
  readonly title: string
}

export interface BudgetTransferRow {
  readonly id: string
  readonly category: BudgetCategoryId
  readonly name: string
  readonly amountRaw: string
}

export interface BudgetTransferDraft {
  readonly budgetRaw: string
  readonly rows: readonly BudgetTransferRow[]
}

export interface BudgetTransferEnvelope {
  readonly format: typeof BUDGET_TRANSFER_FORMAT
  readonly version: typeof BUDGET_TRANSFER_VERSION
  readonly currency: 'CNY'
  readonly trip: BudgetTransferTripSelf | null
  readonly draft: BudgetTransferDraft
}

/** 导出请求：session 的已知投影字段由调用方从受控 session 里取出 */
export interface BudgetExportInput {
  readonly tripId: string | null
  readonly tripTitle: string | null
  readonly budgetRaw: string
  readonly rows: readonly {
    readonly id: string
    readonly category: BudgetCategoryId
    readonly name: string
    readonly amountRaw: string
  }[]
}

export type BudgetExportFailureReason = 'invalid_input' | 'too_large'

export type BudgetExportResult =
  | {
      ok: true
      /** 完整备份 JSON 文本（UTF-8，无 BOM，无网络） */
      json: string
      /** json 文本的 UTF-8 字节数 */
      bytes: number
      /** 导出自述的行程归属（可能为 null：草稿还没有 owner） */
      trip: BudgetTransferTripSelf | null
      /** 需要展示给用户的固定提示（明文分享提醒等） */
      notices: string[]
    }
  | { ok: false; reason: BudgetExportFailureReason; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 导入行投影失败的哨兵；与 null / undefined 区分 */
const FAIL = Symbol('budget-projection-failed')

function projectRow(value: unknown): BudgetTransferRow | typeof FAIL {
  if (!isRecord(value)) return FAIL
  const { id, category, name, amountRaw } = value
  // 只拒绝空白 id（trim 后为空）：与 ./tripBudget.ts computeBudgetSummary 的结构约束对齐，
  // 不规范化 id 原文——非空白 id 原样保留。
  if (typeof id !== 'string' || id.trim() === '') return FAIL
  if (!isBudgetCategoryId(category)) return FAIL
  if (typeof name !== 'string') return FAIL
  if (typeof amountRaw !== 'string') return FAIL
  // 只投影这四个已知字段；行上的未知属性（extra）不进输出
  return { id, category, name, amountRaw }
}

function projectRows(value: unknown): readonly BudgetTransferRow[] | typeof FAIL {
  if (!Array.isArray(value)) return FAIL
  if (value.length > MAX_BUDGET_ITEMS) return FAIL
  const rows: BudgetTransferRow[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const row = projectRow(item)
    if (row === FAIL) return FAIL
    if (seen.has(row.id)) return FAIL
    seen.add(row.id)
    rows.push(row)
  }
  return rows
}

function projectDraft(value: unknown): BudgetTransferDraft | typeof FAIL {
  if (!isRecord(value)) return FAIL
  if (typeof value.budgetRaw !== 'string') return FAIL
  const rows = projectRows(value.rows)
  if (rows === FAIL) return FAIL
  return { budgetRaw: value.budgetRaw, rows }
}

function projectTripSelf(value: unknown): BudgetTransferTripSelf | null | typeof FAIL {
  if (value === null) return null
  if (!isRecord(value)) return FAIL
  const { id, title } = value
  if (typeof id !== 'string' || id.trim() === '') return FAIL
  if (typeof title !== 'string') return FAIL
  // trip 只投影 id 与 title 自述；其它字段（来源、快照等）不进输出
  return { id, title }
}

/**
 * 把受控 session 的字段投影成费用备份 envelope。
 * 输入只收已知字段：调用方不能把整个 session（含 owner.tripSnapshot / undo / result）
 * 交进来——本函数按字段逐个取值，多余属性天然不进输出。
 */
export function projectBudgetEnvelope(input: BudgetExportInput): BudgetTransferEnvelope {
  const rows: BudgetTransferRow[] = input.rows.map((row) => ({
    id: row.id,
    category: row.category,
    name: row.name,
    amountRaw: row.amountRaw,
  }))
  return {
    format: BUDGET_TRANSFER_FORMAT,
    version: BUDGET_TRANSFER_VERSION,
    currency: 'CNY',
    trip: input.tripId === null || input.tripTitle === null ? null : { id: input.tripId, title: input.tripTitle },
    draft: { budgetRaw: input.budgetRaw, rows },
  }
}

/**
 * 生成费用备份 JSON。同一份草稿逐字节相同：不写导出时间、不读时钟。
 * 生成后按 UTF-8 实际字节门禁（256 KiB）；超限 fail-closed 不产出半份文件。
 */
export function createBudgetBackup(input: BudgetExportInput): BudgetExportResult {
  if (input.budgetRaw === undefined || input.budgetRaw === null || typeof input.budgetRaw !== 'string') {
    return { ok: false, reason: 'invalid_input', message: MESSAGE_INVALID_STRUCTURE }
  }
  if (!Array.isArray(input.rows)) {
    return { ok: false, reason: 'invalid_input', message: MESSAGE_INVALID_STRUCTURE }
  }
  const seen = new Set<string>()
  for (const row of input.rows) {
    if (
      typeof row?.id !== 'string' ||
      row.id.trim() === '' ||
      !isBudgetCategoryId(row.category) ||
      typeof row.name !== 'string' ||
      typeof row.amountRaw !== 'string' ||
      seen.has(row.id)
    ) {
      return { ok: false, reason: 'invalid_input', message: MESSAGE_INVALID_STRUCTURE }
    }
    seen.add(row.id)
  }
  if (input.rows.length > MAX_BUDGET_ITEMS) {
    return { ok: false, reason: 'invalid_input', message: MESSAGE_INVALID_STRUCTURE }
  }

  const tripId =
    input.tripId === null || typeof input.tripId !== 'string' || input.tripId.trim() === ''
      ? null
      : input.tripId
  const tripTitle =
    input.tripTitle === null ? null : typeof input.tripTitle === 'string' ? input.tripTitle : null
  const envelope = projectBudgetEnvelope({
    tripId,
    tripTitle,
    budgetRaw: input.budgetRaw,
    rows: input.rows,
  })
  const json = JSON.stringify(envelope)
  const bytes = utf8ByteLength(json)
  if (bytes > MAX_BUDGET_TRANSFER_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      message: formatBudgetTooLargeMessage(bytes, MAX_BUDGET_TRANSFER_BYTES),
    }
  }
  return {
    ok: true,
    json,
    bytes,
    trip: envelope.trip,
    notices: [BUDGET_JSON_SHARE_NOTICE, BUDGET_RECORD_SOURCE_TEXT],
  }
}

/* ───────── 导入预览 ───────── */

export type BudgetImportFailureReason =
  | 'too_large'
  | 'parse_error'
  | 'format_mismatch'
  | 'version_mismatch'
  | 'currency_mismatch'
  | 'invalid_structure'
  | 'invalid_options'

export interface BudgetImportSuccess {
  ok: true
  /** 投影后的草稿：只含已知字段，原字符串原样保留 */
  draft: BudgetTransferDraft
  /** 文件自述的行程归属；字段缺失或 null 时为 null */
  trip: BudgetTransferTripSelf | null
  /** 投影后 envelope 的 UTF-8 字节数（展示用） */
  bytes: number
  /** 需要展示给用户的固定提示 */
  notices: string[]
}

export type BudgetImportFailure = { ok: false; reason: BudgetImportFailureReason; message: string }

export type BudgetImport = BudgetImportSuccess | BudgetImportFailure

export interface BudgetImportOptions {
  /** 文本 UTF-8 上限；缺省 MAX_BUDGET_FILE_BYTES */
  maxBytes?: number
}

function failure(reason: BudgetImportFailureReason, message: string): BudgetImportFailure {
  return { ok: false, reason, message }
}

/**
 * 体积上限配置校验：只允许在固定 cap 之内收紧（有限、正、整数、≤ 256 KiB）。
 * 非法配置是独立的 typed 错误（invalid_options），不能伪装成用户文件过大（too_large），
 * 也不能带着 NaN / Infinity 去比较从而绕过固定 cap。
 */
export function isValidBudgetByteLimit(limit: unknown): limit is number {
  return (
    typeof limit === 'number' &&
    Number.isFinite(limit) &&
    limit > 0 &&
    Number.isInteger(limit) &&
    limit <= MAX_BUDGET_FILE_BYTES
  )
}

const MESSAGE_INVALID_OPTIONS =
  '读取配置的体积上限非法（必须是不超过 256 KB 的正整数），未读取或导入任何内容。'

/** 去掉一个前导 UTF-8 BOM。只剥一个；剥完仍是坏内容就照常 parse_error */
function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 解析费用备份文本。顺序固定：体积门禁 → JSON 语法 → format → version → currency →
 * 结构（trip 自述、draft、行数与行 id 唯一、字段类型）。
 * 体积在 JSON.parse 之前执行；金额合法性不在这里判——这是草稿备份，
 * 空 / 0 / 非法金额原样保留，计算交给 ./tripBudget.ts 的既有规则。
 */
export function parseBudgetBackup(text: string, options: BudgetImportOptions = {}): BudgetImport {
  const limit = options.maxBytes ?? MAX_BUDGET_FILE_BYTES
  if (!isValidBudgetByteLimit(limit)) {
    return failure('invalid_options', MESSAGE_INVALID_OPTIONS)
  }
  if (typeof text !== 'string') return failure('parse_error', MESSAGE_NOT_TEXT)

  // 体积按原始文本计，BOM 也算进用户选的这份文件
  const textBytes = utf8ByteLength(text)
  if (textBytes > limit) return failure('too_large', formatBudgetTooLargeMessage(textBytes, limit))

  const body = stripLeadingBom(text)
  if (body.trim() === '') return failure('parse_error', MESSAGE_PARSE_ERROR)

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return failure('parse_error', MESSAGE_PARSE_ERROR)
  }
  if (!isRecord(parsed)) return failure('format_mismatch', MESSAGE_FORMAT_MISMATCH)

  if (parsed.format !== BUDGET_TRANSFER_FORMAT) {
    return failure('format_mismatch', MESSAGE_FORMAT_MISMATCH)
  }
  if (parsed.version !== BUDGET_TRANSFER_VERSION) {
    return failure('version_mismatch', MESSAGE_VERSION_MISMATCH)
  }
  if (parsed.currency !== 'CNY') {
    return failure('currency_mismatch', MESSAGE_CURRENCY_MISMATCH)
  }

  const trip = projectTripSelf(parsed.trip)
  if (trip === FAIL) return failure('invalid_structure', MESSAGE_INVALID_STRUCTURE)
  const draft = projectDraft(parsed.draft)
  if (draft === FAIL) return failure('invalid_structure', MESSAGE_INVALID_STRUCTURE)

  return {
    ok: true,
    draft,
    trip,
    bytes: textBytes,
    notices: [BUDGET_JSON_SHARE_NOTICE, BUDGET_RECORD_SOURCE_TEXT],
  }
}

/* ───────── 预览摘要：计算沿用旧规则，不把可计算性当备份合法性 ───────── */

/** 预览 / 应用确认都用的草稿摘要：条数、合法合计与无效项提醒（固定文案，不含文件 raw 异常） */
export type BudgetDraftSummaryView =
  | {
      readonly ok: true
      readonly rowCount: number
      readonly knownCount: number
      readonly emptyCount: number
      readonly issueCount: number
      readonly knownTotalText: string | null
      readonly hasAnyIssue: boolean
      readonly issueLines: readonly { rowId: string; label: string; message: string }[]
      readonly budgetKind: 'empty' | 'invalid' | 'valid'
    }
  | {
      /** 草稿结构违反 core 约束，不能摘要：不冒充「无金额 / 无问题 / 预算为空」 */
      readonly ok: false
      readonly rowCount: number
      readonly message: string
    }

const MESSAGE_UNSUMMARIZABLE =
  '这份草稿的结构不完整（存在空白 id 或字段类型异常），无法计算摘要；文件内容原样保留，未应用。'

/**
 * 与 ./tripBudget.ts computeBudgetSummary 同一已知字段结构约束：
 * 只拒绝 trim 空白的 id（不规范化 id 原文），以及类型 / 分类 / 行数异常。
 * parse / export / apply / summarize 共用，防止绕过 parse 的调用方。
 */
function draftStructureFailure(draft: BudgetTransferDraft): string | null {
  if (!Array.isArray(draft.rows)) return MESSAGE_UNSUMMARIZABLE
  if (draft.rows.length > MAX_BUDGET_ITEMS) return MESSAGE_UNSUMMARIZABLE
  if (typeof draft.budgetRaw !== 'string') return MESSAGE_UNSUMMARIZABLE
  const seen = new Set<string>()
  for (const row of draft.rows) {
    if (
      typeof row?.id !== 'string' ||
      row.id.trim() === '' ||
      !isBudgetCategoryId(row.category) ||
      typeof row.name !== 'string' ||
      typeof row.amountRaw !== 'string' ||
      seen.has(row.id)
    ) {
      return MESSAGE_UNSUMMARIZABLE
    }
    seen.add(row.id)
  }
  return null
}

/**
 * 用既有的 computeBudgetSummary 对草稿做一次只读摘要：
 * 数字可计算性与备份合法性解耦——算不出合计照样能预览 / 备份，
 * 摘要只负责提醒「哪些项无效、合计是多少下界」。
 * 草稿结构违反 core 约束（空白 id / 重复 id / 类型异常）时返回 ok=false 的
 * typed 失败：不冒充「没有合法金额、没有问题、预算为空」。
 */
export function summarizeBudgetDraft(draft: BudgetTransferDraft): BudgetDraftSummaryView {
  const structureError = draftStructureFailure(draft)
  if (structureError !== null) {
    return { ok: false, rowCount: draft.rows.length, message: structureError }
  }
  const computed = computeBudgetSummary({ rows: draft.rows, budgetRaw: draft.budgetRaw })
  if (!computed.ok) {
    // 结构约束已在上面与 core 对齐校验过，这里失败只可能是内部不变量被破坏：
    // 按不可摘要处理，固定文案不回显异常，也不冒充空摘要。
    return { ok: false, rowCount: draft.rows.length, message: MESSAGE_UNSUMMARIZABLE }
  }
  const summary = computed.summary
  return {
    ok: true,
    rowCount: draft.rows.length,
    knownCount: summary.knownCount,
    emptyCount: summary.emptyCount,
    issueCount: summary.issueCount,
    knownTotalText: summary.knownTotalText,
    hasAnyIssue: summary.issueCount > 0 || summary.emptyCount > 0,
    issueLines: summary.issueLines.map((line) => ({
      rowId: line.rowId,
      label: line.name.trim() === '' ? '未命名' : line.name,
      message: line.message,
    })),
    budgetKind: summary.budget.kind,
  }
}

/* ───────── 应用（确认导入才走） ───────── */

export type BudgetApplyFailureReason =
  | 'unverifiable_owner'
  | 'owner_mismatch'
  | 'invalid_request'
  | 'invalid_draft'

export type BudgetApplyResult =
  | { ok: true; session: BudgetSessionState }
  | { ok: false; reason: BudgetApplyFailureReason; message: string }

/**
 * 把已验证的候选草稿应用到当前行程的费用 session：
 * 先用 ./tripBudget.ts 的 createBudgetForTrip 建立当前 owner（复用它的
 * 快照校验与一层撤销语义），再替换 rows / budgetRaw，清空 result。
 * undo 保存应用前的当前 session（一层 owner / rows / budgetRaw，不递归）。
 * ctx.snapshot 为 null（无法验证当前 Trip）时 fail closed，拒绝应用。
 * 文件自述 metadata 不在这里使用——owner 只来自当前 ctx。
 */
export function applyBudgetImport(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
  draft: BudgetTransferDraft,
): BudgetApplyResult {
  if (ctx.snapshot === null) {
    return {
      ok: false,
      reason: 'unverifiable_owner',
      message: '当前行程内容无法确认归属，不能应用导入的费用：行程本身不受影响。',
    }
  }
  // 应用前与 parse / export 同一已知字段校验：异常候选固定失败，session 保持不变
  if (draftStructureFailure(draft) !== null) {
    return {
      ok: false,
      reason: 'invalid_draft',
      message: '这份费用备份的结构不完整（存在空白 id 或字段类型异常），未应用任何内容；当前费用不变。',
    }
  }
  const created = createBudgetForTrip(session, ctx)
  if (!created.ok) {
    return { ok: false, reason: 'owner_mismatch', message: created.message }
  }
  return {
    ok: true,
    session: {
      owner: created.session.owner,
      rows: draft.rows,
      budgetRaw: draft.budgetRaw,
      result: null,
      undo: created.session.undo,
    },
  }
}

/** 空费用 session 的统一入口（面板 / App 不必再直接依赖 tripBudget 的初始化） */
export function emptyBudgetSessionForTransfer(): BudgetSessionState {
  return emptyBudgetSession()
}

/* ───────── 文件名 ───────── */

const MAX_FILENAME_BASE = 80

function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/**
 * 生成安全、可读、稳定的备份文件名：固定 budget- 前缀（避 Windows 保留名）
 * + 行程标题与 id 自述，清洗非法字符并限长；固定 .budget.json 后缀。
 * 只用导出自述 metadata，不伪造 Trip 对象；同一草稿重复导出文件名一致。
 */
export function safeBudgetFilename(trip: { id: string; title: string } | null): string {
  const source =
    trip === null ? '' : `${sanitizeFilenamePart(trip.title)}-${sanitizeFilenamePart(trip.id)}`
  const cleaned = source.replace(/-+/g, '-').replace(/^-+|-+$/g, '').trim()
  const base = cleaned === '' ? 'budget' : `budget-${cleaned}`
  return `${truncateCodePoints(base, MAX_FILENAME_BASE).replace(/^[.\s-]+|[.\s-]+$/g, '') || 'budget'}${BUDGET_TRANSFER_FILE_EXTENSION}`
}

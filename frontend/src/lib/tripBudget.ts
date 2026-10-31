/**
 * 手动费用估算与预算提醒：纯函数模块（App 层持有 session，本模块不做 React）。
 *
 * 边界（与 trip-budget-brief.md 对齐）：
 * - 金额全部来自用户手填的字符串；模块不查询真实价格 / 库存 / 汇率，不读网络、
 *   存储、时钟或定位，也不把行程内容（POI、讲解、warnings）猜测成金额。
 * - CNY 是本工具固定的输入单位，不是按目的地推断的当地币种；不换汇，
 *   金额按整项总费用填写，不按人数或天数自动乘算。
 * - 金额按普通十进制字符串精确拆分为整数分：整数部分与小数部分分开转数字、
 *   小数位补足分位后相加，绝不做 Number(raw) * 100 这类浮点乘法——
 *   0.10 + 0.20 必须精确等于 0.30。
 * - 空白是「未填」，0 是合法金额，无效输入给结构化错误与固定文案，
 *   不悄悄补 0、不四舍五入、不截断；调用方负责保留用户原字符串。
 * - 上限：最多 32 项；单项金额与整趟总预算最大 99999999.99 元；最多 2 位小数。
 *   32 项上限使总和远小于 MAX_SAFE_INTEGER，仍对每步求和显式做安全整数检查。
 * - 结果是 typed 结构化数据，文案只用于展示，不当业务分支。
 * - 纯函数：不修改传入的 session / rows / Trip（deepFreeze 回归覆盖）。
 * - 草稿归属（owner）= Trip id + 统一 revision + 内容快照，三者必须同时匹配；
 *   只有用户显式「沿用 / 新建」才重新绑定。快照序列化失败时不能建立可验证
 *   归属，一律 fail closed：禁止编辑、绑定与计算，固定提示、不回显异常原文。
 * - 撤销只有一层，覆盖新增 / 删除 / 清空 / 字段编辑 / 沿用 / 新建全部费用操作；
 *   快照里不含 undo 自身（不递归），撤销不越过行程版本；不影响原 Trip 的撤销。
 */

export const MAX_BUDGET_ITEMS = 32
/** 单项金额与总预算的上限：99999999.99 元 = 9999999999 分。 */
export const MAX_AMOUNT_CENTS = 9999999999
export const AMOUNT_LIMIT_TEXT = '99999999.99'

export type BudgetCategoryId = 'transport' | 'stay' | 'food' | 'ticket' | 'other'

export interface BudgetCategory {
  readonly id: BudgetCategoryId
  readonly label: string
}

export const BUDGET_CATEGORIES: readonly BudgetCategory[] = [
  { id: 'transport', label: '交通' },
  { id: 'stay', label: '住宿' },
  { id: 'food', label: '餐饮' },
  { id: 'ticket', label: '门票' },
  { id: 'other', label: '其他' },
]

export function isBudgetCategoryId(value: unknown): value is BudgetCategoryId {
  return BUDGET_CATEGORIES.some((category) => category.id === value)
}

export function budgetCategoryLabel(id: BudgetCategoryId): string {
  return BUDGET_CATEGORIES.find((category) => category.id === id)?.label ?? '其他'
}

/* ───────── 金额解析与格式化 ───────── */

export type AmountInvalidReason = 'empty' | 'format' | 'decimals' | 'limit'

export interface AmountParseOk {
  readonly ok: true
  readonly cents: number
}

export interface AmountParseFailure {
  readonly ok: false
  readonly reason: AmountInvalidReason
  readonly message: string
}

export type AmountParseResult = AmountParseOk | AmountParseFailure

/** 普通十进制：整数位 + 最多 2 位小数；不接受负号、正负号、指数、千分位、全角数字。 */
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/

/**
 * 把用户手填的人民币金额字符串解析成整数分。
 * 只在解析时忽略首尾空白；原字符串由调用方保留展示。
 */
export function parseAmountYuan(raw: unknown): AmountParseResult {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      reason: 'format',
      message: '金额需要是普通十进制数字文本（例如 128 或 128.5）；原文已保留。',
    }
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    return {
      ok: false,
      reason: 'empty',
      message: '金额未填写：留空表示这一项费用未知，不会按 0 元计入。',
    }
  }
  if (/^\d+\.\d{3,}$/.test(trimmed)) {
    return {
      ok: false,
      reason: 'decimals',
      message: '金额最多 2 位小数（例如 12.50）；没有自动四舍五入或截断，原文已保留。',
    }
  }
  const match = AMOUNT_PATTERN.exec(trimmed)
  if (!match) {
    return {
      ok: false,
      reason: 'format',
      message:
        '金额需要是普通十进制数字（例如 128 或 128.5），不接受负数、科学计数法或其它写法；原文已保留。',
    }
  }
  // 整数部分与两位小数分开转数字再相加：whole*100 在本上限内是精确整数运算，
  // 不做 Number(raw) * 100 那种把小数整体丢给浮点乘法的写法。
  const wholeCents = Number(match[1]) * 100
  const cents = wholeCents + Number((match[2] ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(wholeCents) || !Number.isSafeInteger(cents) || cents > MAX_AMOUNT_CENTS) {
    return {
      ok: false,
      reason: 'limit',
      message: `单项金额最大 ${AMOUNT_LIMIT_TEXT} 元；原文已保留，没有自动改写。`,
    }
  }
  return { ok: true, cents }
}

/** 从整数分生成两位小数文本；输入违反前置条件时返回「—」，不伪造金额。 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return '—'
  const yuan = Math.floor(cents / 100)
  const fen = cents - yuan * 100
  return `${yuan}.${String(fen).padStart(2, '0')}`
}

export type SumCentsResult =
  | { ok: true; total: number }
  | { ok: false; reason: 'invalid_input' | 'overflow' }

/** 对整数分求和：每项与每步累计都显式做安全整数检查。 */
export function sumCents(values: readonly unknown[]): SumCentsResult {
  let total = 0
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return { ok: false, reason: 'invalid_input' }
    }
    total += value
    if (!Number.isSafeInteger(total)) return { ok: false, reason: 'overflow' }
  }
  return { ok: true, total }
}

/* ───────── 计算结果（typed 结构化） ───────── */

export interface BudgetRowInput {
  readonly id: string
  readonly category: BudgetCategoryId
  /** 可选名称，原样保留用户输入；不是服务提供者报价。 */
  readonly name: string
  /** 用户原字符串；解析只在计算时进行。 */
  readonly amountRaw: string
}

export interface BudgetComputeRequest {
  readonly rows: readonly BudgetRowInput[]
  readonly budgetRaw: string
}

export interface BudgetKnownLine {
  readonly rowId: string
  readonly category: BudgetCategoryId
  readonly name: string
  readonly amountRaw: string
  readonly cents: number
}

export interface BudgetEmptyLine {
  readonly rowId: string
  readonly category: BudgetCategoryId
  readonly name: string
}

export interface BudgetIssueLine {
  readonly rowId: string
  readonly category: BudgetCategoryId
  readonly name: string
  readonly amountRaw: string
  readonly reason: AmountInvalidReason
  readonly message: string
}

export interface BudgetCategorySubtotal {
  readonly category: BudgetCategoryId
  readonly label: string
  readonly count: number
  readonly cents: number
}

export type BudgetBudgetState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly reason: AmountInvalidReason; readonly message: string }
  | { readonly kind: 'valid'; readonly cents: number }

export type BudgetComparison =
  | {
      readonly kind: 'none'
      readonly reason: 'no_amounts' | 'budget_empty' | 'budget_invalid'
      readonly message: string
    }
  | { readonly kind: 'over'; readonly message: string }
  | { readonly kind: 'within'; readonly message: string }

export interface BudgetSummary {
  readonly hasKnownAmounts: boolean
  readonly knownCount: number
  readonly emptyCount: number
  readonly issueCount: number
  readonly knownTotalCents: number | null
  readonly knownTotalText: string | null
  readonly knownLines: readonly BudgetKnownLine[]
  readonly emptyLines: readonly BudgetEmptyLine[]
  readonly issueLines: readonly BudgetIssueLine[]
  readonly categorySubtotals: readonly BudgetCategorySubtotal[]
  readonly budget: BudgetBudgetState
  readonly comparison: BudgetComparison
  readonly notice: string
}

export type BudgetComputeInvalidReason =
  | 'invalid_request'
  | 'row_limit'
  | 'invalid_row'
  | 'sum_overflow'

export type BudgetComputeResult =
  | { ok: true; summary: BudgetSummary }
  | { ok: false; reason: BudgetComputeInvalidReason; message: string }

/**
 * 按当前填写内容计算一次：已知合计（下界）、分类小计、预算比较与逐项问题清单。
 * 分类小计只统计已填合法值；未填与无效不进入任何合计，也不补 0。
 *
 * 公共入口先显式校验结构约束（最多 32 项、行 id 非空唯一、分类有效、字段为文本），
 * 违反时给 typed 失败并拒绝整次计算，不把异常输入冒充「没有合法金额」或合计 0。
 */
export function computeBudgetSummary(request: BudgetComputeRequest): BudgetComputeResult {
  const knownLines: BudgetKnownLine[] = []
  const emptyLines: BudgetEmptyLine[] = []
  const issueLines: BudgetIssueLine[] = []

  const rows: readonly BudgetRowInput[] = request.rows
  if (!Array.isArray(rows)) {
    return { ok: false, reason: 'invalid_request', message: '费用明细不是列表，未计算。' }
  }
  if (rows.length > MAX_BUDGET_ITEMS) {
    return {
      ok: false,
      reason: 'row_limit',
      message: `费用明细最多 ${MAX_BUDGET_ITEMS} 项，超限未计算；请先删减项目。`,
    }
  }
  const seenIds = new Set<string>()
  for (const row of rows) {
    if (typeof row?.id !== 'string' || row.id === '') {
      return { ok: false, reason: 'invalid_row', message: '存在缺少有效 id 的费用项，未计算。' }
    }
    if (seenIds.has(row.id)) {
      return { ok: false, reason: 'invalid_row', message: `费用项 id「${row.id}」重复，未计算。` }
    }
    seenIds.add(row.id)
    if (!isBudgetCategoryId(row.category)) {
      return { ok: false, reason: 'invalid_row', message: `费用项「${row.id}」的分类不是有效选项，未计算。` }
    }
    if (typeof row.name !== 'string' || typeof row.amountRaw !== 'string') {
      return { ok: false, reason: 'invalid_row', message: `费用项「${row.id}」的名称或金额不是文本，未计算。` }
    }
  }

  for (const row of rows) {
    const parsed = parseAmountYuan(row.amountRaw)
    if (parsed.ok) {
      knownLines.push({
        rowId: row.id,
        category: row.category,
        name: row.name,
        amountRaw: row.amountRaw,
        cents: parsed.cents,
      })
    } else if (parsed.reason === 'empty') {
      emptyLines.push({ rowId: row.id, category: row.category, name: row.name })
    } else {
      issueLines.push({
        rowId: row.id,
        category: row.category,
        name: row.name,
        amountRaw: row.amountRaw,
        reason: parsed.reason,
        message: parsed.message,
      })
    }
  }

  const totalSum = sumCents(knownLines.map((line) => line.cents))
  // 可达性：单项 ≤ 9999999999 分、最多 32 项，总和上限 32 × 9999999999 = 319999999968，
  // 远小于 2^53，sumCents 不可能溢出；该失败分支只防御内部不变量被破坏，
  // 出现时按 typed 错误拒绝整次计算，不冒 0、不冒「无合法金额」。
  if (!totalSum.ok) {
    return {
      ok: false,
      reason: 'sum_overflow',
      message: '合计计算超出安全整数范围，未产生结果；请确认输入没有被外部改写。',
    }
  }
  const hasKnownAmounts = knownLines.length > 0
  // 没有任何合法金额时不造合计 0：总数保持 null，比较也不进行
  const knownTotalCents = hasKnownAmounts ? totalSum.total : null
  const knownTotalText = knownTotalCents === null ? null : formatCents(knownTotalCents)

  const categorySubtotals: BudgetCategorySubtotal[] = []
  for (const category of BUDGET_CATEGORIES) {
    const lines = knownLines.filter((line) => line.category === category.id)
    if (lines.length === 0) continue
    const sum = sumCents(lines.map((line) => line.cents))
    // 单分类合计 ≤ 总合计，总合计已通过安全整数检查，这里失败同样不可达；
    // 不再冒 0，直接按 typed 错误拒绝整次计算。
    if (!sum.ok) {
      return {
        ok: false,
        reason: 'sum_overflow',
        message: `分类「${category.label}」小计计算超出安全整数范围，未产生结果。`,
      }
    }
    categorySubtotals.push({
      category: category.id,
      label: category.label,
      count: lines.length,
      cents: sum.total,
    })
  }

  const budgetParsed = parseAmountYuan(request.budgetRaw)
  const budget: BudgetBudgetState = budgetParsed.ok
    ? { kind: 'valid', cents: budgetParsed.cents }
    : budgetParsed.reason === 'empty'
      ? { kind: 'empty' }
      : { kind: 'invalid', reason: budgetParsed.reason, message: budgetParsed.message }

  let comparison: BudgetComparison
  if (!hasKnownAmounts) {
    comparison = {
      kind: 'none',
      reason: 'no_amounts',
      message: '没有已填写的合法金额，没有产生合计，也不做预算比较。',
    }
  } else if (budget.kind === 'empty') {
    comparison = {
      kind: 'none',
      reason: 'budget_empty',
      message: '总预算没有填写，只给出已知合计，不做预算内或超预算的结论。',
    }
  } else if (budget.kind === 'invalid') {
    comparison = {
      kind: 'none',
      reason: 'budget_invalid',
      message: '总预算不是合法金额，只给出已知合计，不做预算内或超预算的结论。',
    }
  } else if (knownTotalCents !== null && budget.kind === 'valid' && knownTotalCents > budget.cents) {
    comparison = {
      kind: 'over',
      message:
        `已填写部分的合计 ${knownTotalText} 元，已超过所填预算 ${formatCents(budget.cents)} 元。` +
        '这只统计了已填写的合法金额：未填和无效的项目没有计入，实际花费可能更高。',
    }
  } else {
    comparison = {
      kind: 'within',
      message:
        `已填写部分的合计 ${knownTotalText} 元，未超过所填预算 ${formatCents(budget.cents)} 元。` +
        '这只说明已填部分未超：未填、无效和未记录的费用仍未知，不能据此认为整趟行程在预算内或可以支付。',
    }
  }

  const notice = hasKnownAmounts
    ? '合计只统计已填写的合法金额，未填或无效的未计入，实际花费未知。'
    : '暂无可合计金额：费用明细里没有任何合法金额。0 元是合法金额，填写后会计入合计。'

  const summary: BudgetSummary = {
    hasKnownAmounts,
    knownCount: knownLines.length,
    emptyCount: emptyLines.length,
    issueCount: issueLines.length,
    knownTotalCents,
    knownTotalText,
    knownLines,
    emptyLines,
    issueLines,
    categorySubtotals,
    budget,
    comparison,
    notice,
  }
  return { ok: true, summary }
}

/* ───────── 草稿归属（owner）与内容快照 ───────── */

export interface BudgetOwner {
  readonly tripId: string
  readonly revision: number
  /** 绑定时的行程内容快照（序列化串）。只有序列化成功才可能有 owner。 */
  readonly tripSnapshot: string
  readonly tripTitle: string
}

/** 当前行程的归属上下文，由 App 每次渲染提供；snapshot 为 null 表示无法验证。 */
export interface BudgetTripContext {
  readonly tripId: string
  readonly revision: number
  readonly snapshot: string | null
  readonly tripTitle: string
}

export type OwnerSnapshotResult = { ok: true; value: string } | { ok: false }

/**
 * 行程内容快照。序列化失败（循环引用 / BigInt 等被改写过的宿主对象）返回 ok=false：
 * 没有快照就无法证明「当前内容没变」，不能用固定失败字符串冒充有效匹配。
 */
export function tripOwnerSnapshot(trip: unknown): OwnerSnapshotResult {
  try {
    return { ok: true, value: JSON.stringify(trip) }
  } catch {
    return { ok: false }
  }
}

/** owner 与当前行程匹配要求 id、revision、内容快照三者同时一致。 */
export function budgetOwnerMatches(
  owner: BudgetOwner | null,
  ctx: Pick<BudgetTripContext, 'tripId' | 'revision' | 'snapshot'>,
): boolean {
  return (
    owner !== null &&
    ctx.snapshot !== null &&
    owner.tripId === ctx.tripId &&
    owner.revision === ctx.revision &&
    owner.tripSnapshot === ctx.snapshot
  )
}

/** session 里已有草稿但不再属于当前行程版本（只读保留，须显式沿用 / 新建）。 */
export function budgetSessionIsStale(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
): boolean {
  return session.owner !== null && !budgetOwnerMatches(session.owner, ctx)
}

export const OWNER_MISMATCH_TEXT =
  '这份费用草稿属于旧版本的行程，先「沿用」或「新建」才能继续编辑或计算。'
export const OWNER_UNVERIFIABLE_TEXT =
  '当前行程内容无法确认归属，费用草稿已锁定：不能编辑、沿用或计算；行程本身不受影响。'

/* ───────── 受控 session 与操作 ───────── */

export interface BudgetUndoSnapshot {
  readonly owner: BudgetOwner | null
  readonly rows: readonly BudgetRowInput[]
  readonly budgetRaw: string
}

export interface BudgetSessionState {
  /** 草稿归属；null 表示还没有绑定（第一次编辑时绑定当前行程版本）。 */
  readonly owner: BudgetOwner | null
  readonly rows: readonly BudgetRowInput[]
  readonly budgetRaw: string
  /** 最近一次显式计算的结果；任何输入 / 结构 / 归属变化都会清空。 */
  readonly result: BudgetSummary | null
  /** 一层撤销快照；不含 undo 自身与 result。 */
  readonly undo: BudgetUndoSnapshot | null
}

export function emptyBudgetSession(): BudgetSessionState {
  return { owner: null, rows: [], budgetRaw: '', result: null, undo: null }
}

export type BudgetOpFailureReason =
  | 'limit'
  | 'invalid_row_id'
  | 'duplicate_row_id'
  | 'unknown_row'
  | 'invalid_category'
  | 'no_owner'
  | 'owner_mismatch'
  | 'unverifiable_owner'
  | 'not_stale'
  | 'nothing_to_undo'
  | 'invalid_request'

export type BudgetOpResult =
  | { ok: true; session: BudgetSessionState }
  | { ok: false; reason: BudgetOpFailureReason; message: string }

function opFailure(reason: BudgetOpFailureReason, message: string): BudgetOpResult {
  return { ok: false, reason, message }
}

function ownerForCtx(ctx: BudgetTripContext): BudgetOwner | null {
  if (ctx.snapshot === null) return null
  return {
    tripId: ctx.tripId,
    revision: ctx.revision,
    tripSnapshot: ctx.snapshot,
    tripTitle: ctx.tripTitle,
  }
}

/**
 * 已有 owner 时校验它仍匹配当前行程；还没有 owner 时用当前行程绑定
 * （新草稿的第一次编辑绑定当时看到的行程版本；快照不可验证则 fail closed）。
 */
function ensureOwner(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
): { ok: true; owner: BudgetOwner } | { ok: false; reason: BudgetOpFailureReason; message: string } {
  if (session.owner === null) {
    const owner = ownerForCtx(ctx)
    if (!owner) return { ok: false, reason: 'unverifiable_owner', message: OWNER_UNVERIFIABLE_TEXT }
    return { ok: true, owner }
  }
  if (!budgetOwnerMatches(session.owner, ctx)) {
    return { ok: false, reason: 'owner_mismatch', message: OWNER_MISMATCH_TEXT }
  }
  return { ok: true, owner: session.owner }
}

/** 新增一行费用明细（空分类「其他」、名称与金额留空，由用户填写）。 */
export function addBudgetRow(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
  rowId: string,
): BudgetOpResult {
  const owner = ensureOwner(session, ctx)
  if (!owner.ok) return owner
  if (typeof rowId !== 'string' || rowId.trim() === '') {
    return opFailure('invalid_row_id', '新增费用项的 id 需要由调用方生成，操作未生效。')
  }
  if (session.rows.some((row) => row.id === rowId)) {
    return opFailure('duplicate_row_id', '新增费用项的 id 与已有项目重复，未新增。')
  }
  if (session.rows.length >= MAX_BUDGET_ITEMS) {
    return opFailure('limit', `费用明细最多 ${MAX_BUDGET_ITEMS} 项，未新增。`)
  }
  const undo: BudgetUndoSnapshot = {
    owner: session.owner,
    rows: session.rows,
    budgetRaw: session.budgetRaw,
  }
  const row: BudgetRowInput = { id: rowId, category: 'other', name: '', amountRaw: '' }
  return {
    ok: true,
    session: {
      owner: owner.owner,
      rows: [...session.rows, row],
      budgetRaw: session.budgetRaw,
      result: null,
      undo,
    },
  }
}

export interface BudgetRowPatch {
  /** 传 undefined 表示不修改；非法分类值整体拒绝，不静默改成「其他」。 */
  readonly category?: unknown
  readonly name?: string
  readonly amountRaw?: string
}

/** 修改一行的分类 / 名称 / 金额原字符串；与其它费用操作一致进一层撤销，并作废旧计算结果。 */
export function updateBudgetRow(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
  rowId: string,
  patch: BudgetRowPatch,
): BudgetOpResult {
  const owner = ensureOwner(session, ctx)
  if (!owner.ok) return owner
  const index = session.rows.findIndex((row) => row.id === rowId)
  if (index < 0) return opFailure('unknown_row', '费用明细里没有这一项，操作未生效。')
  const row = session.rows[index]
  let category = row.category
  if (patch.category !== undefined) {
    if (!isBudgetCategoryId(patch.category)) {
      return opFailure('invalid_category', '分类不是有效选项，操作未生效。')
    }
    category = patch.category
  }
  const name = patch.name === undefined ? row.name : patch.name
  const amountRaw = patch.amountRaw === undefined ? row.amountRaw : patch.amountRaw
  const nextRow: BudgetRowInput = { id: row.id, category, name, amountRaw }
  const rows = session.rows.map((item, i) => (i === index ? nextRow : item))
  const undo: BudgetUndoSnapshot = {
    owner: session.owner,
    rows: session.rows,
    budgetRaw: session.budgetRaw,
  }
  return {
    ok: true,
    session: { owner: owner.owner, rows, budgetRaw: session.budgetRaw, result: null, undo },
  }
}

/** 修改整趟预算原字符串；不校验合法性（计算时才解析），进一层撤销并作废旧计算结果。 */
export function updateBudgetTotal(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
  budgetRaw: string,
): BudgetOpResult {
  const owner = ensureOwner(session, ctx)
  if (!owner.ok) return owner
  const undo: BudgetUndoSnapshot = {
    owner: session.owner,
    rows: session.rows,
    budgetRaw: session.budgetRaw,
  }
  return { ok: true, session: { owner: owner.owner, rows: session.rows, budgetRaw, result: null, undo } }
}

/** 删除一行；进一层撤销。 */
export function removeBudgetRow(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
  rowId: string,
): BudgetOpResult {
  const owner = ensureOwner(session, ctx)
  if (!owner.ok) return owner
  const rows = session.rows.filter((row) => row.id !== rowId)
  if (rows.length === session.rows.length) {
    return opFailure('unknown_row', '费用明细里没有这一项，操作未生效。')
  }
  const undo: BudgetUndoSnapshot = {
    owner: session.owner,
    rows: session.rows,
    budgetRaw: session.budgetRaw,
  }
  return { ok: true, session: { owner: owner.owner, rows, budgetRaw: session.budgetRaw, result: null, undo } }
}

/** 清空本次费用（明细与总预算）；空 session 上是无变化的 no-op。可撤销一次。 */
export function clearBudget(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
): BudgetOpResult {
  const owner = ensureOwner(session, ctx)
  if (!owner.ok) return owner
  if (session.rows.length === 0 && session.budgetRaw === '') {
    return { ok: true, session }
  }
  const undo: BudgetUndoSnapshot = {
    owner: session.owner,
    rows: session.rows,
    budgetRaw: session.budgetRaw,
  }
  return {
    ok: true,
    session: { owner: owner.owner, rows: [], budgetRaw: '', result: null, undo },
  }
}

/**
 * 撤销上一步费用操作（一层，覆盖增删 / 清空 / 字段编辑 / 沿用 / 新建）；
 * 撤销本身把缓冲清掉，不递归，也不越过行程版本：快照不可验证或 owner 失配时拒绝。
 */
export function undoBudget(session: BudgetSessionState, ctx: BudgetTripContext): BudgetOpResult {
  if (ctx.snapshot === null) return opFailure('unverifiable_owner', OWNER_UNVERIFIABLE_TEXT)
  if (session.owner !== null && !budgetOwnerMatches(session.owner, ctx)) {
    return opFailure('owner_mismatch', OWNER_MISMATCH_TEXT)
  }
  if (!session.undo) return opFailure('nothing_to_undo', '没有可撤销的费用操作。')
  const snapshot = session.undo
  return {
    ok: true,
    session: {
      owner: snapshot.owner,
      rows: snapshot.rows,
      budgetRaw: snapshot.budgetRaw,
      result: null,
      undo: null,
    },
  }
}

/** 显式沿用：把旧草稿复制绑定到当前行程版本（只复制用户输入，重新绑定、清结果）。 */
export function adoptBudget(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
): BudgetOpResult {
  if (ctx.snapshot === null) return opFailure('unverifiable_owner', OWNER_UNVERIFIABLE_TEXT)
  if (session.owner === null) return opFailure('not_stale', '当前还没有费用草稿，无需沿用。')
  if (budgetOwnerMatches(session.owner, ctx)) {
    return opFailure('not_stale', '这份费用已经属于当前行程版本，无需沿用。')
  }
  const owner = ownerForCtx(ctx)
  if (!owner) return opFailure('unverifiable_owner', OWNER_UNVERIFIABLE_TEXT)
  const undo: BudgetUndoSnapshot = {
    owner: session.owner,
    rows: session.rows,
    budgetRaw: session.budgetRaw,
  }
  return {
    ok: true,
    session: { owner, rows: session.rows, budgetRaw: session.budgetRaw, result: null, undo },
  }
}

/** 显式新建：清空内容并绑定当前行程版本；旧内容可撤销一次。 */
export function createBudgetForTrip(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
): BudgetOpResult {
  if (ctx.snapshot === null) return opFailure('unverifiable_owner', OWNER_UNVERIFIABLE_TEXT)
  const owner = ownerForCtx(ctx)
  if (!owner) return opFailure('unverifiable_owner', OWNER_UNVERIFIABLE_TEXT)
  const undo: BudgetUndoSnapshot = {
    owner: session.owner,
    rows: session.rows,
    budgetRaw: session.budgetRaw,
  }
  return { ok: true, session: { owner, rows: [], budgetRaw: '', result: null, undo } }
}

/** 显式计算：只有归属可验证且匹配当前行程时才允许。 */
export function computeBudgetSession(
  session: BudgetSessionState,
  ctx: BudgetTripContext,
): BudgetOpResult {
  if (session.owner === null) {
    return opFailure('no_owner', '还没有可归属的行程版本：先填写内容或点「新建」，再计算。')
  }
  if (ctx.snapshot === null) return opFailure('unverifiable_owner', OWNER_UNVERIFIABLE_TEXT)
  if (!budgetOwnerMatches(session.owner, ctx)) {
    return opFailure('owner_mismatch', OWNER_MISMATCH_TEXT)
  }
  const computed = computeBudgetSummary({ rows: session.rows, budgetRaw: session.budgetRaw })
  if (!computed.ok) return opFailure('invalid_request', computed.message)
  return { ok: true, session: { ...session, result: computed.summary } }
}

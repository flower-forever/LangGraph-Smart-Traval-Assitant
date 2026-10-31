/**
 * tripBudget.ts 纯函数测试：分位精度、0 / 空 / 非法 / 上限 / 安全整数、
 * 分类合计、缺项不补 0、预算比较保守口径、公共入口 typed 校验与拒超限、
 * deepFreeze、owner / 版本 / 无法序列化、一层撤销覆盖全部费用操作、
 * 撤销不串 Trip、撤销不越过行程版本。全部离线，不读网络 / 存储 / 时钟。
 */
import { describe, expect, it } from 'vitest'

import { MOCK_TRIP } from './fixtures/trip'
import {
  AMOUNT_LIMIT_TEXT,
  MAX_AMOUNT_CENTS,
  MAX_BUDGET_ITEMS,
  OWNER_MISMATCH_TEXT,
  OWNER_UNVERIFIABLE_TEXT,
  addBudgetRow,
  adoptBudget,
  budgetOwnerMatches,
  budgetSessionIsStale,
  clearBudget,
  computeBudgetSession,
  computeBudgetSummary,
  createBudgetForTrip,
  emptyBudgetSession,
  formatCents,
  parseAmountYuan,
  removeBudgetRow,
  sumCents,
  tripOwnerSnapshot,
  undoBudget,
  updateBudgetRow,
  updateBudgetTotal,
  type BudgetComputeRequest,
  type BudgetRowInput,
  type BudgetSessionState,
  type BudgetSummary,
  type BudgetTripContext,
} from '../lib/tripBudget'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item)
    }
    Object.freeze(value)
  }
  return value
}

function row(id: string, amountRaw: string, category: BudgetRowInput['category'] = 'other', name = ''): BudgetRowInput {
  return { id, category, name, amountRaw }
}

/** 成功路径辅助：断言公共入口 typed 校验通过并返回 summary。 */
function compute(request: BudgetComputeRequest): BudgetSummary {
  const result = computeBudgetSummary(request)
  if (!result.ok) throw new Error(`computeBudgetSummary 意外失败：${result.message}`)
  return result.summary
}

/** 造一个归属 A 版本的 session：先空 session 绑定 ctxA，再加一行。 */
function sessionBoundTo(ctx: BudgetTripContext): BudgetSessionState {
  const created = createBudgetForTrip(emptyBudgetSession(), ctx)
  if (!created.ok) throw new Error(created.message)
  return created.session
}

function ctxOf(
  tripId: string,
  revision: number,
  snapshot: string | null,
  tripTitle = '测试行程',
): BudgetTripContext {
  return { tripId, revision, snapshot, tripTitle }
}

const CTX_A = ctxOf('trip-a', 1, '{"id":"trip-a","v":1}')
const CTX_A_SAME = ctxOf('trip-a', 1, '{"id":"trip-a","v":1}', '测试行程')
const CTX_B = ctxOf('trip-a', 2, '{"id":"trip-a","v":2}')
const CTX_NO_SNAP = ctxOf('trip-a', 1, null)

describe('parseAmountYuan：分位与精度', () => {
  it('0.10 + 0.20 精确等于 0.30，无浮点误差', () => {
    const a = parseAmountYuan('0.10')
    const b = parseAmountYuan('0.20')
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.cents + b.cents).toBe(30)
    }
  })

  it('0 是合法金额；空白是未填；前导零与纯整数正常解析', () => {
    expect(parseAmountYuan('0')).toEqual({ ok: true, cents: 0 })
    expect(parseAmountYuan('00.05')).toEqual({ ok: true, cents: 5 })
    expect(parseAmountYuan('128')).toEqual({ ok: true, cents: 12800 })
    expect(parseAmountYuan(' 12.5 ')).toEqual({ ok: true, cents: 1250 })
    expect(parseAmountYuan('   ').ok).toBe(false)
    const empty = parseAmountYuan('  ')
    expect(empty.ok === false && empty.reason).toBe('empty')
  })

  it('拒绝负数、正负号、科学计数、千分位、全角、多小数、多值', () => {
    for (const raw of ['-1', '+5', '1e3', '1,000', '１２３', '0.123', '12.3.4', '1 2', 'abc', '.5', '5.']) {
      const result = parseAmountYuan(raw)
      expect(result.ok, raw).toBe(false)
    }
    const multi = parseAmountYuan('12.345')
    expect(multi.ok === false && multi.reason).toBe('decimals')
  })

  it('超过 99999999.99 元拒绝；恰好上限合法', () => {
    expect(parseAmountYuan('99999999.99')).toEqual({ ok: true, cents: MAX_AMOUNT_CENTS })
    expect(parseAmountYuan('9999999999').ok).toBe(false)
    const over = parseAmountYuan('100000000')
    expect(over.ok === false && over.reason).toBe('limit')
    expect(parseAmountYuan('9999999999.00').ok).toBe(false)
  })

  it('非字符串输入拒绝且不抛错', () => {
    for (const raw of [null, undefined, 12, Number.NaN, {}, []]) {
      expect(parseAmountYuan(raw as unknown as string).ok).toBe(false)
    }
  })
})

describe('formatCents 与 sumCents', () => {
  it('从整数分生成两位小数；非法输入返回「—」不伪造', () => {
    expect(formatCents(0)).toBe('0.00')
    expect(formatCents(5)).toBe('0.05')
    expect(formatCents(30)).toBe('0.30')
    expect(formatCents(123456)).toBe('1234.56')
    expect(formatCents(MAX_AMOUNT_CENTS)).toBe(AMOUNT_LIMIT_TEXT)
    expect(formatCents(Number.NaN)).toBe('—')
    expect(formatCents(1.5)).toBe('—')
    expect(formatCents(-1)).toBe('—')
  })

  it('sumCents 拒绝非安全整数与负数，不静默吞掉', () => {
    const ok = sumCents([10, 20, 30])
    expect(ok.ok && ok.total).toBe(60)
    expect(sumCents([Number.MAX_SAFE_INTEGER + 1] as number[]).ok).toBe(false)
    expect(sumCents([-1]).ok).toBe(false)
    expect(sumCents([1.5]).ok).toBe(false)
  })

  it('sumCents 溢出单独可达：两步累计超 MAX_SAFE_INTEGER 报 overflow 不静默续算', () => {
    const overflow = sumCents([Number.MAX_SAFE_INTEGER, 1])
    expect(overflow.ok === false && overflow.reason).toBe('overflow')
  })
})

describe('computeBudgetSummary：已知合计与分类', () => {
  it('分类只算已填合法值；0 合法、空白与无效不进任何合计也不补 0', () => {
    const summary = compute({
      rows: [
        row('r1', '10.10', 'transport', '地铁'),
        row('r2', '0', 'transport', '摆渡'),
        row('r3', '', 'food', '晚餐'),
        row('r4', '1e3', 'ticket', '门票'),
        row('r5', '0.20', 'stay', '床位'),
      ],
      budgetRaw: '',
    })
    expect(summary.hasKnownAmounts).toBe(true)
    expect(summary.knownCount).toBe(3)
    expect(summary.emptyCount).toBe(1)
    expect(summary.issueCount).toBe(1)
    expect(summary.knownTotalCents).toBe(10 * 100 + 10 + 20)
    expect(summary.knownTotalText).toBe('10.30')
    const transport = summary.categorySubtotals.find((c) => c.category === 'transport')
    expect(transport?.cents).toBe(10 * 100 + 10)
    expect(transport?.count).toBe(2)
    // 餐饮只有留空行：没有该分类的小计，也不出现 0 值分类
    expect(summary.categorySubtotals.find((c) => c.category === 'food')).toBeUndefined()
    // 无效行原文保留在 issueLines，不当 0
    expect(summary.issueLines[0]?.amountRaw).toBe('1e3')
    expect(summary.emptyLines[0]?.category).toBe('food')
  })

  it('没有任何合法金额时不算合计、不做预算比较，不伪造 0 元合计', () => {
    const summary = compute({ rows: [row('r1', ''), row('r2', '-1')], budgetRaw: '100' })
    expect(summary.hasKnownAmounts).toBe(false)
    expect(summary.knownTotalCents).toBeNull()
    expect(summary.knownTotalText).toBeNull()
    expect(summary.comparison.kind).toBe('none')
    expect(summary.comparison.kind === 'none' && summary.comparison.reason).toBe('no_amounts')
    expect(summary.notice).toContain('暂无可合计金额')
  })

  it('全 0 元行：合法合计 0.00；预算 0 时 within 口径成立', () => {
    const summary = compute({ rows: [row('r1', '0')], budgetRaw: '0' })
    expect(summary.hasKnownAmounts).toBe(true)
    expect(summary.knownTotalText).toBe('0.00')
    expect(summary.comparison.kind).toBe('within')
  })

  it('预算留空或无效：只给已知合计，不给预算内 / 超预算结论', () => {
    const rows = [row('r1', '100')]
    const emptyBudget = compute({ rows, budgetRaw: '' })
    expect(emptyBudget.comparison.kind === 'none' && emptyBudget.comparison.reason).toBe('budget_empty')
    const badBudget = compute({ rows, budgetRaw: 'abc' })
    expect(badBudget.comparison.kind === 'none' && badBudget.comparison.reason).toBe('budget_invalid')
    expect(badBudget.budget.kind).toBe('invalid')
  })

  it('超过预算：明确「已填部分已超」并提醒未计入项', () => {
    const summary = compute({ rows: [row('r1', '60'), row('r2', '50', 'stay')], budgetRaw: '100' })
    expect(summary.comparison.kind).toBe('over')
    expect(summary.comparison.kind === 'over' && summary.comparison.message).toContain('已超过')
    expect(summary.comparison.kind === 'over' && summary.comparison.message).toContain('未填和无效')
  })

  it('未超预算：只说已填部分未超，不保证实际费用与可支付', () => {
    const summary = compute({ rows: [row('r1', '50')], budgetRaw: '100' })
    expect(summary.comparison.kind).toBe('within')
    expect(summary.comparison.kind === 'within' && summary.comparison.message).toContain('仍未知')
    expect(summary.comparison.kind === 'within' && summary.comparison.message).not.toContain('全程预算可行')
  })

  it('恰好等于预算不算超', () => {
    const summary = compute({ rows: [row('r1', '100')], budgetRaw: '100' })
    expect(summary.comparison.kind).toBe('within')
  })

  it('32 项上限下合计精确且安全整数', () => {
    const rows = Array.from({ length: MAX_BUDGET_ITEMS }, (_, i) => row(`r${i}`, '99999999.99'))
    const summary = compute({ rows, budgetRaw: '' })
    expect(summary.hasKnownAmounts).toBe(true)
    expect(summary.knownTotalCents).toBe(32 * MAX_AMOUNT_CENTS)
    expect(Number.isSafeInteger(summary.knownTotalCents)).toBe(true)
  })

  it('deepFreeze：传入的 rows / budgetRaw 不被修改', () => {
    const rows = deepFreeze([row('r1', '1.00'), row('r2', '2.00', 'food')])
    const request = deepFreeze({ rows, budgetRaw: '10' })
    expect(() => computeBudgetSummary(request)).not.toThrow()
    expect(request.rows[0]?.amountRaw).toBe('1.00')
  })
})

describe('computeBudgetSummary 公共入口 typed 校验：拒超限不冒 0 / 不冒无合法金额', () => {
  it('33 行超 32 项上限：row_limit 拒绝整次计算', () => {
    const rows = Array.from({ length: MAX_BUDGET_ITEMS + 1 }, (_, i) => row(`r${i}`, '1'))
    const result = computeBudgetSummary({ rows, budgetRaw: '' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('row_limit')
    expect(result.ok === false && result.message).toContain('32')
  })

  it('重复行 id：invalid_row 拒绝，不把两行当两笔独立费用静默算掉', () => {
    const result = computeBudgetSummary({ rows: [row('r1', '1'), row('r1', '2')], budgetRaw: '' })
    expect(result.ok === false && result.reason).toBe('invalid_row')
    expect(result.ok === false && result.message).toContain('r1')
  })

  it('缺 id、非法分类、非文本字段都 invalid_row 拒绝', () => {
    const missingId = computeBudgetSummary({
      rows: [{ id: '', category: 'other', name: '', amountRaw: '1' }],
      budgetRaw: '',
    })
    expect(missingId.ok === false && missingId.reason).toBe('invalid_row')
    const badCategory = computeBudgetSummary({
      rows: [{ id: 'r1', category: 'luxury' as unknown as BudgetRowInput['category'], name: '', amountRaw: '1' }],
      budgetRaw: '',
    })
    expect(badCategory.ok === false && badCategory.reason).toBe('invalid_row')
    const nonText = computeBudgetSummary({
      rows: [{ id: 'r1', category: 'other', name: 'x', amountRaw: 5 as unknown as string }],
      budgetRaw: '',
    })
    expect(nonText.ok === false && nonText.reason).toBe('invalid_row')
  })

  it('rows 不是列表：invalid_request 拒绝（防御性，正常调用方传不了这个形状）', () => {
    const result = computeBudgetSummary({
      rows: 'not-an-array' as unknown as BudgetComputeRequest['rows'],
      budgetRaw: '',
    })
    expect(result.ok === false && result.reason).toBe('invalid_request')
  })

  it('可达性说明：上限内 sumCents 不可能溢出，compute 不再有冒 0 分支；溢出只能在 sumCents 直测', () => {
    // 单项 ≤ 9999999999 分、最多 32 项 → 总和 ≤ 319999999968 < 2^53
    expect(32 * MAX_AMOUNT_CENTS).toBeLessThan(Number.MAX_SAFE_INTEGER)
    const rows = Array.from({ length: MAX_BUDGET_ITEMS }, (_, i) => row(`r${i}`, '99999999.99'))
    const result = computeBudgetSummary({ rows, budgetRaw: '' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.summary.knownTotalCents).toBe(32 * MAX_AMOUNT_CENTS)
    }
  })
})

describe('owner：id + revision + 内容快照', () => {
  it('三者全等才匹配；只同 id 或只同引用不算', () => {
    expect(budgetOwnerMatches({ tripId: 'trip-a', revision: 1, tripSnapshot: '{"id":"trip-a","v":1}', tripTitle: 't' }, CTX_A)).toBe(true)
    expect(
      budgetOwnerMatches(
        { tripId: 'trip-a', revision: 2, tripSnapshot: '{"v":1}', tripTitle: 't' },
        CTX_A,
      ),
      'revision 不同必须不匹配',
    ).toBe(false)
    expect(
      budgetOwnerMatches(
        { tripId: 'trip-a', revision: 1, tripSnapshot: '{"v":2}', tripTitle: 't' },
        CTX_A,
      ),
      '快照不同必须不匹配',
    ).toBe(false)
    expect(budgetOwnerMatches(null, CTX_A)).toBe(false)
    expect(budgetOwnerMatches({ tripId: 'trip-a', revision: 1, tripSnapshot: '{"v":1}', tripTitle: 't' }, CTX_NO_SNAP)).toBe(false)
  })

  it('内容快照对真实 Trip 稳定；序列化失败 fail closed', () => {
    const snap = tripOwnerSnapshot(MOCK_TRIP)
    expect(snap.ok).toBe(true)
    const evil: Record<string, unknown> = { id: 'x' }
    evil.self = evil
    expect(tripOwnerSnapshot(evil).ok).toBe(false)
  })

  it('版本变化后 session 是 stale；同 id 回到旧内容（A→B→A 场景前置）也不匹配新绑定', () => {
    const session = sessionBoundTo(CTX_A)
    expect(budgetSessionIsStale(session, CTX_A_SAME)).toBe(false)
    expect(budgetSessionIsStale(session, CTX_B)).toBe(true)
  })
})

describe('session 操作：绑定 / 沿用 / 新建 / 失配锁定', () => {
  it('没有 owner 的第一次编辑自动绑定当前版本', () => {
    const result = addBudgetRow(emptyBudgetSession(), CTX_A, 'r1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.session.owner?.tripId).toBe('trip-a')
      expect(result.session.owner?.tripSnapshot).toBe('{"id":"trip-a","v":1}')
    }
  })

  it('没有行程版本（snapshot null）时禁止编辑、沿用、新建、计算、撤销，fail closed', () => {
    const noSnap = CTX_NO_SNAP
    const bound = sessionBoundTo(CTX_A)
    expect(addBudgetRow(emptyBudgetSession(), noSnap, 'r1').ok).toBe(false)
    expect(addBudgetRow(bound, noSnap, 'r1').ok).toBe(false)
    expect(adoptBudget(bound, noSnap).ok).toBe(false)
    expect(createBudgetForTrip(emptyBudgetSession(), noSnap).ok).toBe(false)
    const failed = computeBudgetSession(bound, noSnap)
    expect(failed.ok === false && failed.message).toBe(OWNER_UNVERIFIABLE_TEXT)
    // 快照不可验证时，旧 session 也判定为 stale，界面必须锁定
    expect(budgetSessionIsStale(bound, noSnap)).toBe(true)
    // 撤销同样不越过不可验证的版本
    const undoBlocked = undoBudget(bound, noSnap)
    expect(undoBlocked.ok === false && undoBlocked.message).toBe(OWNER_UNVERIFIABLE_TEXT)
  })

  it('owner 失配：编辑 / 计算拒绝，旧内容只读保留', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const mismatched = updateBudgetRow(session, CTX_B, 'r1', { amountRaw: '5' })
    expect(mismatched.ok).toBe(false)
    expect(mismatched.ok === false && mismatched.message).toBe(OWNER_MISMATCH_TEXT)
    expect(session.rows).toHaveLength(1)
    expect(session.rows[0]?.amountRaw).toBe('')
    const compute = computeBudgetSession(session, CTX_B)
    expect(compute.ok).toBe(false)
  })

  it('沿用：复制内容重新绑定当前版本并清结果；已在当前版本时拒绝', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const computed = computeBudgetSession(session, CTX_A)
    if (!computed.ok) throw new Error(computed.message)
    session = computed.session
    expect(session.result).not.toBeNull()

    const adopted = adoptBudget(session, CTX_B)
    expect(adopted.ok).toBe(true)
    if (adopted.ok) {
      expect(adopted.session.owner?.revision).toBe(2)
      expect(adopted.session.rows).toHaveLength(1)
      expect(adopted.session.result).toBeNull()
      // 沿用可撤销一次：回到旧 owner
      const undone = undoBudget(adopted.session, CTX_B)
      expect(undone.ok && undone.session.owner?.revision).toBe(1)
    }
    expect(adoptBudget(session, CTX_A).ok).toBe(false)
    expect(adoptBudget(emptyBudgetSession(), CTX_A).ok).toBe(false)
  })

  it('A→B→A：revision 变过之后沿用产生的是新绑定，不是复活旧关系', () => {
    // 在 A 绑定草稿 → 行程变到 B（同 id 不同快照）→ 用户显式沿用绑定 B
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const adopted = adoptBudget(session, CTX_B)
    if (!adopted.ok) throw new Error(adopted.message)
    session = adopted.session
    // 行程回到内容与 A 相同的版本（新快照串相同即视为同版本；这里用第三个不同版本模拟）
    const ctxA2 = ctxOf('trip-a', 3, '{"id":"trip-a","v":1}', '测试行程')
    expect(budgetSessionIsStale(session, ctxA2)).toBe(true)
    // 沿用到 A2 后 owner 是 A2 的 revision，不是旧 A 的 revision=1
    const adopted2 = adoptBudget(session, ctxA2)
    if (!adopted2.ok) throw new Error(adopted2.message)
    expect(adopted2.session.owner?.revision).toBe(3)
    expect(budgetSessionIsStale(adopted2.session, CTX_A)).toBe(true)
  })

  it('新建：清空内容绑定当前版本；旧内容可撤销一次', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const created = createBudgetForTrip(session, CTX_B)
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.session.rows).toHaveLength(0)
      expect(created.session.budgetRaw).toBe('')
      expect(created.session.owner?.revision).toBe(2)
      const undone = undoBudget(created.session, CTX_B)
      expect(undone.ok && undone.session.rows).toHaveLength(1)
    }
  })
})

describe('行操作与一层撤销（覆盖全部费用操作）', () => {
  it('增删进一层撤销；撤销只回一步不递归', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    expect(session.rows).toHaveLength(1)

    const removed = removeBudgetRow(session, CTX_A, 'r1')
    if (!removed.ok) throw new Error(removed.message)
    session = removed.session
    expect(session.rows).toHaveLength(0)

    // 一次撤销回到删除前
    const undone = undoBudget(session, CTX_A)
    if (!undone.ok) throw new Error(undone.message)
    expect(undone.session.rows).toHaveLength(1)
    // 一层撤销到此为止：撤销本身清掉缓冲，不能无限递归
    expect(undoBudget(undone.session, CTX_A).ok).toBe(false)
  })

  it('新增后填金额再撤销：行保留、金额回到编辑前，不再整行消失', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const updated = updateBudgetRow(session, CTX_A, 'r1', { amountRaw: '1.00', name: '地铁' })
    if (!updated.ok) throw new Error(updated.message)
    session = updated.session
    // 字段编辑自己进撤销：快照是编辑前的那一行（空金额）
    expect(session.undo?.rows).toHaveLength(1)
    expect(session.undo?.rows[0]?.amountRaw).toBe('')

    const undone = undoBudget(session, CTX_A)
    if (!undone.ok) throw new Error(undone.message)
    // 行没有被整行撤掉，只是金额 / 名称回到编辑前
    expect(undone.session.rows).toHaveLength(1)
    expect(undone.session.rows[0]?.amountRaw).toBe('')
    expect(undone.session.rows[0]?.name).toBe('')
    expect(undoBudget(undone.session, CTX_A).ok).toBe(false)
  })

  it('连续字段编辑：undo 只回一步到上一次编辑前，不递归回放', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const first = updateBudgetRow(session, CTX_A, 'r1', { amountRaw: '1.00' })
    if (!first.ok) throw new Error(first.message)
    session = first.session
    const second = updateBudgetRow(session, CTX_A, 'r1', { amountRaw: '2.00' })
    if (!second.ok) throw new Error(second.message)
    session = second.session
    const undone = undoBudget(session, CTX_A)
    if (!undone.ok) throw new Error(undone.message)
    expect(undone.session.rows[0]?.amountRaw).toBe('1.00')
    expect(undoBudget(undone.session, CTX_A).ok).toBe(false)
  })

  it('结构变更后再编辑另一行：undo 回到编辑前，不复活被删行也不丢行', () => {
    let session = sessionBoundTo(CTX_A)
    const added1 = addBudgetRow(session, CTX_A, 'r1')
    if (!added1.ok) throw new Error(added1.message)
    session = added1.session
    const filled = updateBudgetRow(session, CTX_A, 'r1', { amountRaw: '1.00' })
    if (!filled.ok) throw new Error(filled.message)
    session = filled.session
    const added2 = addBudgetRow(session, CTX_A, 'r2')
    if (!added2.ok) throw new Error(added2.message)
    session = added2.session
    const removed = removeBudgetRow(session, CTX_A, 'r1')
    if (!removed.ok) throw new Error(removed.message)
    session = removed.session
    expect(session.rows.map((r) => r.id)).toEqual(['r2'])
    // 编辑 r2：这一步覆盖撤销缓冲，undo 回到「编辑 r2 前」而不是跳回删行前
    const edited = updateBudgetRow(session, CTX_A, 'r2', { amountRaw: '3.00' })
    if (!edited.ok) throw new Error(edited.message)
    session = edited.session
    const undone = undoBudget(session, CTX_A)
    if (!undone.ok) throw new Error(undone.message)
    // r2 保留编辑前的值；被删的 r1 不复活
    expect(undone.session.rows.map((r) => r.id)).toEqual(['r2'])
    expect(undone.session.rows[0]?.amountRaw).toBe('')
  })

  it('沿用后再编辑：undo 回到沿用刚完成的内容，不越过沿用', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const adopted = adoptBudget(session, CTX_B)
    if (!adopted.ok) throw new Error(adopted.message)
    session = adopted.session
    const edited = updateBudgetRow(session, CTX_B, 'r1', { amountRaw: '9.90' })
    if (!edited.ok) throw new Error(edited.message)
    session = edited.session
    const undone = undoBudget(session, CTX_B)
    if (!undone.ok) throw new Error(undone.message)
    expect(undone.session.owner?.revision).toBe(2)
    expect(undone.session.rows[0]?.amountRaw).toBe('')
  })

  it('清空费用：可撤销一次恢复明细与预算；空 session 上是 no-op', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const updated = updateBudgetTotal(session, CTX_A, '500')
    if (!updated.ok) throw new Error(updated.message)
    session = updated.session
    const cleared = clearBudget(session, CTX_A)
    if (!cleared.ok) throw new Error(cleared.message)
    expect(cleared.session.rows).toHaveLength(0)
    expect(cleared.session.budgetRaw).toBe('')
    const undone = undoBudget(cleared.session, CTX_A)
    if (!undone.ok) throw new Error(undone.message)
    expect(undone.session.budgetRaw).toBe('500')
    expect(undone.session.rows).toHaveLength(1)
    const emptyNoop = clearBudget(emptyBudgetSession(), CTX_A)
    expect(emptyNoop.ok && emptyNoop.session.rows).toHaveLength(0)
  })

  it('预算输入进一层撤销：undo 回到上一次预算改动前', () => {
    let session = sessionBoundTo(CTX_A)
    const first = updateBudgetTotal(session, CTX_A, '100')
    if (!first.ok) throw new Error(first.message)
    session = first.session
    const second = updateBudgetTotal(session, CTX_A, '200')
    if (!second.ok) throw new Error(second.message)
    session = second.session
    const undone = undoBudget(session, CTX_A)
    if (!undone.ok) throw new Error(undone.message)
    expect(undone.session.budgetRaw).toBe('100')
    expect(undoBudget(undone.session, CTX_A).ok).toBe(false)
  })

  it('撤销不越过行程版本：owner 失配或快照不可验证时拒绝', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const mismatch = undoBudget(session, CTX_B)
    expect(mismatch.ok === false && mismatch.message).toBe(OWNER_MISMATCH_TEXT)
    expect(session.rows).toHaveLength(1)
    // A→B→A 场景：行程回不到旧绑定，撤销也不能借道恢复旧 owner
    const ctxA2 = ctxOf('trip-a', 3, '{"id":"trip-a","v":1}', '测试行程')
    const adopt = adoptBudget(session, ctxA2)
    if (!adopt.ok) throw new Error(adopt.message)
    const backToOld = undoBudget(adopt.session, CTX_A)
    expect(backToOld.ok === false && backToOld.message).toBe(OWNER_MISMATCH_TEXT)
  })

  it('32 项上限、重复 id、未知行、非法分类都拒绝且不改 session', () => {
    let session = sessionBoundTo(CTX_A)
    for (let i = 0; i < MAX_BUDGET_ITEMS; i += 1) {
      const result = addBudgetRow(session, CTX_A, `r${i}`)
      if (!result.ok) throw new Error(result.message)
      session = result.session
    }
    const over = addBudgetRow(session, CTX_A, 'extra')
    expect(over.ok === false && over.reason).toBe('limit')
    expect(session.rows).toHaveLength(MAX_BUDGET_ITEMS)

    const dup = addBudgetRow(sessionBoundTo(CTX_A), CTX_A, 'r1')
    if (!dup.ok) throw new Error(dup.message)
    const dupAgain = addBudgetRow(dup.session, CTX_A, 'r1')
    expect(dupAgain.ok === false && dupAgain.reason).toBe('duplicate_row_id')
    expect(updateBudgetRow(dup.session, CTX_A, 'missing', { name: 'x' }).ok).toBe(false)
    const badCategory = updateBudgetRow(dup.session, CTX_A, 'r1', { category: 'luxury' })
    expect(badCategory.ok === false && badCategory.reason).toBe('invalid_category')
    const missingRemove = removeBudgetRow(dup.session, CTX_A, 'missing')
    expect(missingRemove.ok === false && missingRemove.reason).toBe('unknown_row')
  })

  it('操作不触发原 Trip 变化，也不把 undo 串进 Trip 的撤销', () => {
    const trip = deepFreeze(JSON.parse(JSON.stringify(MOCK_TRIP)) as typeof MOCK_TRIP)
    const snap = tripOwnerSnapshot(trip)
    if (!snap.ok) throw new Error('fixture snapshot failed')
    const ctx = ctxOf(trip.id, 7, snap.value, trip.title)
    let session = sessionBoundTo(ctx)
    const added = addBudgetRow(session, ctx, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const undone = undoBudget(session, ctx)
    expect(undone.ok).toBe(true)
    // 行程对象没有被写：JSON 串不变，Trip 自身的撤销机制与费用撤销无关
    expect(tripOwnerSnapshot(trip)).toEqual(snap)
  })

  it('deepFreeze：session 操作不修改传入 session / rows', () => {
    const frozenRows = deepFreeze<BudgetRowInput[]>([row('r1', '1.00')])
    const frozenSession = deepFreeze({
      owner: {
        tripId: 'trip-a',
        revision: 1,
        tripSnapshot: '{"id":"trip-a","v":1}',
        tripTitle: '测试行程',
      },
      rows: frozenRows,
      budgetRaw: '10',
      result: null,
      undo: null,
    })
    expect(() => updateBudgetRow(frozenSession, CTX_A, 'r1', { amountRaw: '2.00' })).not.toThrow()
    expect(() => addBudgetRow(frozenSession, CTX_A, 'r2')).not.toThrow()
    expect(() => clearBudget(frozenSession, CTX_A)).not.toThrow()
    expect(frozenSession.rows[0]?.amountRaw).toBe('1.00')
  })

  it('显式计算：绑定且匹配才产生结果；任何后续输入变化清空结果', () => {
    let session = sessionBoundTo(CTX_A)
    const added = addBudgetRow(session, CTX_A, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const updated = updateBudgetRow(session, CTX_A, 'r1', { amountRaw: '3.30' })
    if (!updated.ok) throw new Error(updated.message)
    session = updated.session
    const computed = computeBudgetSession(session, CTX_A)
    if (!computed.ok) throw new Error(computed.message)
    expect(computed.session.result?.knownTotalText).toBe('3.30')

    // 改金额 → 结果清空
    const afterEdit = updateBudgetRow(computed.session, CTX_A, 'r1', { amountRaw: '4.00' })
    if (!afterEdit.ok) throw new Error(afterEdit.message)
    expect(afterEdit.session.result).toBeNull()
    // 改预算 → 结果清空
    const computed2 = computeBudgetSession(afterEdit.session, CTX_A)
    if (!computed2.ok) throw new Error(computed2.message)
    const afterBudget = updateBudgetTotal(computed2.session, CTX_A, '100')
    if (!afterBudget.ok) throw new Error(afterBudget.message)
    expect(afterBudget.session.result).toBeNull()
    // 增删 / 清空 / 撤销 → 结果清空
    const computed3 = computeBudgetSession(afterBudget.session, CTX_A)
    if (!computed3.ok) throw new Error(computed3.message)
    const afterAdd = addBudgetRow(computed3.session, CTX_A, 'r2')
    if (!afterAdd.ok) throw new Error(afterAdd.message)
    expect(afterAdd.session.result).toBeNull()
    const computed4 = computeBudgetSession(afterAdd.session, CTX_A)
    if (!computed4.ok) throw new Error(computed4.message)
    const afterUndo = undoBudget(computed4.session, CTX_A)
    if (!afterUndo.ok) throw new Error(afterUndo.message)
    expect(afterUndo.session.result).toBeNull()
    // 未绑定 owner 时不能计算
    expect(computeBudgetSession(emptyBudgetSession(), CTX_A).ok).toBe(false)
  })
})

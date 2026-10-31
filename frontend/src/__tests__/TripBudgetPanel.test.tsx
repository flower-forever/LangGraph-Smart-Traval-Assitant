/**
 * TripBudgetPanel 面板测试：受控 session、显式计算、错误保留原字符串、
 * 撤销（含字段编辑）与清空、owner 失配只读与显式沿用 / 新建、
 * 无法验证快照锁定、行程变化后旧结果不渲染、快照逐渲染重算、
 * 行 id 在 session 内唯一、唯一播报区与标签关联。
 * 全部离线 DOM，不 mock 模块内部逻辑，不发请求、不写存储（挂载与全程断言）。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import TripBudgetPanel from '../components/TripBudgetPanel'
import {
  emptyBudgetSession,
  tripOwnerSnapshot,
  type BudgetSessionState,
  type BudgetTripContext,
} from '../lib/tripBudget'
import { MOCK_TRIP } from './fixtures/trip'

function ctxFor(trip: typeof MOCK_TRIP, revision: number): BudgetTripContext {
  const snap = tripOwnerSnapshot(trip)
  if (!snap.ok) throw new Error('fixture snapshot failed')
  return { tripId: trip.id, revision, snapshot: snap.value, tripTitle: trip.title }
}

let rowSeq = 0
function makeRowId(): string {
  rowSeq += 1
  return `row-${rowSeq}`
}

interface Harness {
  session: BudgetSessionState
  setSession: (next: BudgetSessionState) => void
}

interface PanelOpts {
  trip?: typeof MOCK_TRIP
  revision?: number
  session?: BudgetSessionState
}

function renderPanel(opts?: PanelOpts): { user: ReturnType<typeof userEvent.setup>; harness: Harness } {
  const trip = opts?.trip ?? MOCK_TRIP
  const revision = opts?.revision ?? 1
  const harness: Harness = {
    session: opts?.session ?? emptyBudgetSession(),
    setSession: () => {},
  }
  harness.setSession = (next: BudgetSessionState) => {
    harness.session = next
  }
  const user = userEvent.setup()
  /**
   * 受控 session 接线：面板回调里更新 harness.session 并用最新值重渲染，
   * 与 App 里 setState + 重渲染的语义一致。递归定义，任意交互深度都成立。
   */
  function uiFor(session: BudgetSessionState): ReactElement {
    return (
      <TripBudgetPanel
        trip={trip}
        revision={revision}
        session={session}
        onSessionChange={(next) => {
          harness.setSession(next)
          view.rerender(uiFor(next))
        }}
        onClose={() => {}}
      />
    )
  }
  const view = render(uiFor(harness.session))
  void view
  return { user, harness }
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: /费用估算/ })
}

/** 加一行、填金额（可选名称）的常用步骤 */
async function addRowWithAmount(
  user: ReturnType<typeof userEvent.setup>,
  amount: string,
  name?: string,
): Promise<void> {
  await user.click(within(panel()).getByRole('button', { name: '添加费用项' }))
  const rowNode = within(panel()).getAllByTestId('budget-row').at(-1)
  if (!rowNode) throw new Error('没有新增行')
  if (name !== undefined) {
    await user.type(within(rowNode).getByLabelText('名称（可留空）'), name)
  }
  await user.type(within(rowNode).getByLabelText('金额（元）'), amount)
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TripBudgetPanel：挂载与显式计算', () => {
  it('挂载零副作用：不发请求、不写存储；默认给出添加入口与说明', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    renderPanel()
    expect(panel()).toBeInTheDocument()
    expect(within(panel()).getByText(/不随行程保存或导出，刷新页面会丢失/)).toBeInTheDocument()
    expect(within(panel()).getByText(/人民币 CNY 是这里的固定输入单位/)).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: '计算已填费用' })).toBeInTheDocument()
    expect(window.localStorage.getItem('travel-assistant:saved-trips:v1')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('点计算才出结果：0.10 + 0.20 精确 0.30；金额错误保留原字符串且不当 0', async () => {
    const { user } = renderPanel()
    await addRowWithAmount(user, '0.10', '地铁')
    await addRowWithAmount(user, '0.20', '公交')
    await addRowWithAmount(user, '12.345', '记错的票')
    await user.click(within(panel()).getByRole('button', { name: '计算已填费用' }))

    const result = within(panel()).getByTestId('budget-result')
    expect(within(result).getByTestId('budget-known-total').textContent).toBe('0.30 元')
    // 错误项单独列出：原文 12.345、固定文案，没有被四舍五入成 12.35 或改写成 0
    const issues = within(result).getByTestId('budget-issues')
    expect(issues.textContent).toContain('12.345')
    expect(issues.textContent).toContain('最多 2 位小数')
    // 播报区只出现一条通告
    expect(within(panel()).getAllByTestId('budget-notice')).toHaveLength(1)
  })

  it('全部留空时计算：显示「暂无可合计金额」，不伪造合计 0', async () => {
    const { user } = renderPanel()
    await user.click(within(panel()).getByRole('button', { name: '添加费用项' }))
    await user.click(within(panel()).getByRole('button', { name: '计算已填费用' }))
    expect(within(panel()).getByTestId('budget-no-amounts')).toBeInTheDocument()
    expect(within(panel()).getByTestId('budget-notice').textContent).toContain('没有已填写的合法金额')
  })

  it('修改任何输入后旧结果清空，须重新点计算', async () => {
    const { user, harness } = renderPanel()
    await addRowWithAmount(user, '5')
    await user.click(within(panel()).getByRole('button', { name: '计算已填费用' }))
    expect(within(panel()).getByTestId('budget-result')).toBeInTheDocument()

    // 改金额：结果立即消失
    const rowNode = within(panel()).getAllByTestId('budget-row')[0]
    if (!rowNode) throw new Error('missing row')
    const amountInput = within(rowNode).getByLabelText('金额（元）') as HTMLInputElement
    await user.clear(amountInput)
    await user.type(amountInput, '8')
    expect(within(panel()).queryByTestId('budget-result')).toBeNull()
    expect(harness.session.result).toBeNull()

    // 重新计算出新结果
    await user.click(within(panel()).getByRole('button', { name: '计算已填费用' }))
    expect(within(panel()).getByTestId('budget-known-total').textContent).toBe('8.00 元')
  })

  it('超预算与预算留空的文案口径：合计只算已填合法金额', async () => {
    const { user } = renderPanel()
    await addRowWithAmount(user, '60')
    await addRowWithAmount(user, '50')
    const budgetInput = within(panel()).getByLabelText('整趟行程总预算（元，可留空）')
    await user.type(budgetInput, '100')
    await user.click(within(panel()).getByRole('button', { name: '计算已填费用' }))
    expect(within(panel()).getByTestId('budget-notice').textContent).toContain('已超过所填预算')

    await user.clear(budgetInput)
    await user.click(within(panel()).getByRole('button', { name: '计算已填费用' }))
    expect(within(panel()).getByTestId('budget-notice').textContent).toContain('不做预算内或超预算的结论')
  })
})

describe('TripBudgetPanel：撤销与清空', () => {
  it('删除可撤销一次；清空后撤销恢复金额；撤销缓冲不递归', async () => {
    const { user } = renderPanel()
    await addRowWithAmount(user, '42')
    const undoBtn = () => within(panel()).getByRole('button', { name: '撤销上一步' })
    // 加行本身就是可撤销的结构操作：撤销可用
    expect(undoBtn()).toBeEnabled()

    // 删除 → 撤销回 1 行
    await user.click(within(panel()).getByRole('button', { name: '删除第 1 项费用' }))
    expect(within(panel()).queryByTestId('budget-row')).toBeNull()
    await user.click(undoBtn())
    expect(within(panel()).getAllByTestId('budget-row')).toHaveLength(1)
    // 一层撤销到此为止：回删行前的状态已消费掉缓冲
    expect(undoBtn()).toBeDisabled()
    const restored = within(panel()).getAllByTestId('budget-row')[0]
    expect((within(restored).getByLabelText('金额（元）') as HTMLInputElement).value).toBe('42')

    // 清空 → 撤销恢复
    await user.click(within(panel()).getByRole('button', { name: '清空本次费用' }))
    expect(within(panel()).queryByTestId('budget-row')).toBeNull()
    const budgetInput = within(panel()).getByLabelText('整趟行程总预算（元，可留空）') as HTMLInputElement
    expect(budgetInput.value).toBe('')
    await user.click(undoBtn())
    expect(within(panel()).getAllByTestId('budget-row')).toHaveLength(1)
  })

  it('新增后填金额再撤销：行保留、金额回到编辑前，不再整行消失', async () => {
    const { user } = renderPanel()
    await addRowWithAmount(user, '42')
    const rowNode = within(panel()).getAllByTestId('budget-row')[0]
    if (!rowNode) throw new Error('missing row')
    const amountInput = within(rowNode).getByLabelText('金额（元）') as HTMLInputElement
    // 单次 change（模拟粘贴）：一次编辑进一层撤销
    fireEvent.change(amountInput, { target: { value: '99' } })
    await user.click(within(panel()).getByRole('button', { name: '撤销上一步' }))
    const afterUndo = within(panel()).getAllByTestId('budget-row')
    // 行还在：不是整行被撤掉；金额回到编辑前（42，不是更早的空白）
    expect(afterUndo).toHaveLength(1)
    expect((within(afterUndo[0]!).getByLabelText('金额（元）') as HTMLInputElement).value).toBe('42')
    expect(within(panel()).getByRole('button', { name: '撤销上一步' })).toBeDisabled()
  })

  it('删行后改另一行金额再撤销：回到编辑前，不复活被删行', async () => {
    const { user } = renderPanel()
    await addRowWithAmount(user, '1')
    await addRowWithAmount(user, '2')
    // 删除第 1 行
    await user.click(within(panel()).getByRole('button', { name: '删除第 1 项费用' }))
    let rows = within(panel()).getAllByTestId('budget-row')
    expect(rows).toHaveLength(1)
    // 编辑剩下的行
    const amountInput = within(rows[0]!).getByLabelText('金额（元）') as HTMLInputElement
    await user.clear(amountInput)
    await user.type(amountInput, '7')
    // undo：回到编辑前（空金额），不是回到删行前（两行）
    await user.click(within(panel()).getByRole('button', { name: '撤销上一步' }))
    rows = within(panel()).getAllByTestId('budget-row')
    expect(rows).toHaveLength(1)
    expect((within(rows[0]!).getByLabelText('金额（元）') as HTMLInputElement).value).toBe('')
  })
})

describe('TripBudgetPanel：owner 失配与锁定', () => {
  it('行程内容变化后：输入只读保留、不能编辑或计算，显式沿用恢复可编辑', async () => {
    // 先在 revision 1 里加一行
    const ctx1 = ctxFor(MOCK_TRIP, 1)
    let session = emptyBudgetSession()
    const { addBudgetRow, updateBudgetRow } = await import('../lib/tripBudget')
    const added = addBudgetRow(session, ctx1, makeRowId())
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const updated = updateBudgetRow(session, ctx1, session.rows[0]!.id, { amountRaw: '66' })
    if (!updated.ok) throw new Error(updated.message)
    session = updated.session

    // 行程版本推进：同一 Trip 对象、revision 变化（模拟应用编辑 / 撤销应用）
    const { user } = renderPanel({ revision: 2, session })
    const ownerNote = within(panel()).getByTestId('budget-owner-note')
    expect(ownerNote.textContent).toContain('旧版本的行程')
    // 金额原文只读保留
    const rowNode = within(panel()).getAllByTestId('budget-row')[0]
    expect((within(rowNode).getByLabelText('金额（元）') as HTMLInputElement).value).toBe('66')
    // 编辑被禁用（fieldset disabled）
    expect(within(rowNode).getByLabelText('金额（元）')).toBeDisabled()
    expect(within(panel()).getByRole('button', { name: '计算已填费用' })).toBeDisabled()

    // 显式沿用：重新绑定当前版本，清结果，可再编辑
    await user.click(within(panel()).getByRole('button', { name: '沿用这份费用到当前行程' }))
    expect(within(panel()).queryByTestId('budget-owner-note')).toBeNull()
    const rowAfter = within(panel()).getAllByTestId('budget-row')[0]
    const amount = within(rowAfter).getByLabelText('金额（元）')
    expect(amount).not.toBeDisabled()
    await user.click(within(panel()).getByRole('button', { name: '计算已填费用' }))
    expect(within(panel()).getByTestId('budget-known-total').textContent).toBe('66.00 元')
  })

  it('旧 Trip 计算过结果，切到 Trip B 后：旧合计与比较不渲染，不得当新结果', async () => {
    const ctx1 = ctxFor(MOCK_TRIP, 1)
    let session = emptyBudgetSession()
    const { addBudgetRow, updateBudgetRow, computeBudgetSession } = await import('../lib/tripBudget')
    const added = addBudgetRow(session, ctx1, makeRowId())
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const updated = updateBudgetRow(session, ctx1, session.rows[0]!.id, { amountRaw: '128.50' })
    if (!updated.ok) throw new Error(updated.message)
    session = updated.session
    const computed = computeBudgetSession(session, ctx1)
    if (!computed.ok) throw new Error(computed.message)
    session = computed.session
    expect(session.result).not.toBeNull()

    // 同一 Trip 对象、revision 推进（App 里 bumpTripRevision 的语义）：旧结果必须隐藏
    const { rerender } = render(<TripBudgetPanel trip={MOCK_TRIP} revision={1} session={session} onSessionChange={() => {}} onClose={() => {}} />)
    expect(within(panel()).getByTestId('budget-result')).toBeInTheDocument()
    rerender(<TripBudgetPanel trip={MOCK_TRIP} revision={2} session={session} onSessionChange={() => {}} onClose={() => {}} />)
    expect(within(panel()).queryByTestId('budget-result')).toBeNull()
    expect(within(panel()).queryByTestId('budget-notice')).toBeNull()
    // 只读锁定说明出现
    expect(within(panel()).getByTestId('budget-owner-note').textContent).toContain('旧版本的行程')

    // A→B→A：回到同内容但 revision 更大的版本，也不能恢复旧结果
    rerender(<TripBudgetPanel trip={MOCK_TRIP} revision={3} session={session} onSessionChange={() => {}} onClose={() => {}} />)
    expect(within(panel()).queryByTestId('budget-result')).toBeNull()
  })

  it('同 id 同引用但内容被原地修改：快照逐渲染重算，归属立即失配，不靠引用缓存', async () => {
    const ctx1 = ctxFor(MOCK_TRIP, 1)
    let session = emptyBudgetSession()
    const { addBudgetRow, updateBudgetRow, computeBudgetSession } = await import('../lib/tripBudget')
    const added = addBudgetRow(session, ctx1, makeRowId())
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const updated = updateBudgetRow(session, ctx1, session.rows[0]!.id, { amountRaw: '10' })
    if (!updated.ok) throw new Error(updated.message)
    session = updated.session
    const computed = computeBudgetSession(session, ctx1)
    if (!computed.ok) throw new Error(computed.message)
    session = computed.session

    // 可变 Trip：同引用原地改 title（模拟被改写过的宿主对象）
    const mutableTrip = JSON.parse(JSON.stringify(MOCK_TRIP)) as typeof MOCK_TRIP
    const { rerender } = render(<TripBudgetPanel trip={mutableTrip} revision={1} session={session} onSessionChange={() => {}} onClose={() => {}} />)
    expect(within(panel()).getByTestId('budget-result')).toBeInTheDocument()

    mutableTrip.title = '被原地改过的行程'
    rerender(<TripBudgetPanel trip={mutableTrip} revision={1} session={session} onSessionChange={() => {}} onClose={() => {}} />)
    // 同引用、同 revision，但内容快照变了 → 失配锁定，旧结果不渲染
    expect(within(panel()).getByTestId('budget-owner-note').textContent).toContain('旧版本的行程')
    expect(within(panel()).queryByTestId('budget-result')).toBeNull()
  })

  it('显式新建：清空内容绑定当前版本', async () => {
    const ctx1 = ctxFor(MOCK_TRIP, 1)
    const { addBudgetRow } = await import('../lib/tripBudget')
    let session = emptyBudgetSession()
    const added = addBudgetRow(session, ctx1, makeRowId())
    if (!added.ok) throw new Error(added.message)
    session = added.session

    const { user } = renderPanel({ revision: 3, session })
    await user.click(within(panel()).getByRole('button', { name: '新建当前行程费用草稿' }))
    expect(within(panel()).queryByTestId('budget-row')).toBeNull()
    expect(within(panel()).queryByTestId('budget-owner-note')).toBeNull()
    // 新建也可撤销一次
    await user.click(within(panel()).getByRole('button', { name: '撤销上一步' }))
    expect(within(panel()).getAllByTestId('budget-row')).toHaveLength(1)
  })

  it('A→B→A：沿用后的绑定跟随当前版本，不复活旧关系', async () => {
    const { addBudgetRow } = await import('../lib/tripBudget')
    const ctx1 = ctxFor(MOCK_TRIP, 1)
    let session = emptyBudgetSession()
    const added = addBudgetRow(session, ctx1, makeRowId())
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const { user } = renderPanel({ revision: 2, session })
    await user.click(within(panel()).getByRole('button', { name: '沿用这份费用到当前行程' }))
    expect(within(panel()).queryByTestId('budget-owner-note')).toBeNull()
    // 沿用后可再编辑并计算（owner 已重绑当前版本）
    await user.click(within(panel()).getByRole('button', { name: '计算已填费用' }))
    expect(within(panel()).getByTestId('budget-notice')).toBeInTheDocument()
  })

  it('快照无法验证（序列化失败）：整体锁定，不能沿用 / 新建 / 计算', async () => {
    const evilTrip = {
      ...MOCK_TRIP,
      days: MOCK_TRIP.days.map((day) => ({ ...day })),
    } as unknown as typeof MOCK_TRIP
    // 往 days 数组塞一个不可序列化的循环结构（类型层不合法，运行时构造）
    const cyclic: Record<string, unknown> = { marker: 'evil' }
    cyclic.self = cyclic
    ;(evilTrip as unknown as { __evil: unknown }).__evil = cyclic
    const ctx1 = ctxFor(MOCK_TRIP, 1)
    const { addBudgetRow } = await import('../lib/tripBudget')
    let session = emptyBudgetSession()
    const added = addBudgetRow(session, ctx1, makeRowId())
    if (!added.ok) throw new Error(added.message)
    session = added.session

    renderPanel({ trip: evilTrip, revision: 1, session })
    // 循环引用在 props 的 trip 上：快照序列化失败 → 锁定文案出现，操作禁用
    expect(within(panel()).getByTestId('budget-owner-note').textContent).toContain('无法确认归属')
    expect(within(panel()).getByRole('button', { name: '计算已填费用' })).toBeDisabled()
    expect(within(panel()).queryByRole('button', { name: '沿用这份费用到当前行程' })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: '新建当前行程费用草稿' })).toBeNull()
  })

  it('锁定时旧的操作错误被清掉，不冒当前行程的结论', async () => {
    const ctx1 = ctxFor(MOCK_TRIP, 1)
    let session = emptyBudgetSession()
    const { addBudgetRow } = await import('../lib/tripBudget')
    const added = addBudgetRow(session, ctx1, 'row-a')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    // 版本推进 → 锁定，面板内残留的操作错误一律清掉，不冒新行程的结论
    const mutable = JSON.parse(JSON.stringify(MOCK_TRIP)) as typeof MOCK_TRIP
    mutable.title = '锁定后的行程'
    renderPanel({ trip: mutable, revision: 2, session })
    expect(within(panel()).getByTestId('budget-owner-note').textContent).toContain('旧版本的行程')
    expect(within(panel()).queryByTestId('budget-action-error')).toBeNull()
  })
})

describe('TripBudgetPanel：行 id 与可达性', () => {
  it('每行有独立 label 关联；面板内只有一个 aria-live 播报区', async () => {
    const { user } = renderPanel()
    await addRowWithAmount(user, '1')
    await addRowWithAmount(user, '2')
    const rows = within(panel()).getAllByTestId('budget-row')
    expect(rows).toHaveLength(2)
    const first = rows[0]
    const second = rows[1]
    expect(within(first!).getByLabelText('金额（元）').id).not.toBe(
      within(second!).getByLabelText('金额（元）').id,
    )
    expect(within(first!).getByLabelText('分类')).toBeInTheDocument()
    expect(within(second!).getByLabelText('分类')).toBeInTheDocument()
    const liveRegions = panel().querySelectorAll('[aria-live="polite"]')
    expect(liveRegions).toHaveLength(1)
    // 删除按钮有明确指向
    expect(within(first!).getByRole('button', { name: '删除第 1 项费用' })).toBeInTheDocument()
  })

  it('行 id 在当前 session 内唯一：删行后重加不产生重复 id（不依赖时间戳）', async () => {
    const { user } = renderPanel()
    await addRowWithAmount(user, '1')
    const collectIds = () => {
      const ids = within(panel()).getAllByTestId('budget-row').map((r) => r.getAttribute('data-rowid'))
      for (const id of ids) {
        expect(id, `行 id 缺失`).not.toBeNull()
      }
      expect(new Set(ids).size, `行 id 重复：${ids.join(',')}`).toBe(ids.length)
      return ids
    }
    // 反复加删：新增 id 必须避开当前 session 已有的所有 id
    for (let round = 0; round < 5; round += 1) {
      await user.click(within(panel()).getByRole('button', { name: '添加费用项' }))
      const ids = collectIds()
      expect(within(panel()).queryByTestId('budget-action-error')).toBeNull()
      await user.click(within(panel()).getByRole('button', { name: `删除第 ${ids.length} 项费用` }))
      expect(within(panel()).getAllByTestId('budget-row')).toHaveLength(ids.length - 1)
    }
    // 关闭重开（卸载重挂）后再加：id 仍不与 session 里已有的重复
    cleanup()
    const ctx1 = ctxFor(MOCK_TRIP, 1)
    const { addBudgetRow } = await import('../lib/tripBudget')
    let session = emptyBudgetSession()
    const added = addBudgetRow(session, ctx1, 'budget-row-trip-moc-1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    renderPanel({ session })
    await user.click(within(panel()).getByRole('button', { name: '添加费用项' }))
    const ids = within(panel()).getAllByTestId('budget-row').map((r) => r.getAttribute('data-rowid'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('budget-row-trip-moc-2')
  })

  it('32 项上限：添加按钮禁用并提示', async () => {
    const { MAX_BUDGET_ITEMS } = await import('../lib/tripBudget')
    const ctx1 = ctxFor(MOCK_TRIP, 1)
    let session = emptyBudgetSession()
    const { addBudgetRow } = await import('../lib/tripBudget')
    for (let i = 0; i < MAX_BUDGET_ITEMS; i += 1) {
      const added = addBudgetRow(session, ctx1, `row-${i}`)
      if (!added.ok) throw new Error(added.message)
      session = added.session
    }
    const { user } = renderPanel({ session })
    const addBtn = within(panel()).getByRole('button', { name: '添加费用项' })
    expect(addBtn).toBeDisabled()
    // 满行时点不动：点一下也不会新增，最多 32 项的口径不变
    await user.click(addBtn)
    expect(within(panel()).getAllByTestId('budget-row')).toHaveLength(MAX_BUDGET_ITEMS)
  })
})

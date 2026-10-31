/**
 * App × TripBudgetPanel 接线集成测试：费用入口、关闭重开不丢草稿、
 * 临时编辑 / 地图 / AI 后草稿仍在、旧 Trip 内容与保存导出未动、
 * 无额外网络 / Storage / 下载、interactionPaused 边界不破。
 * mock fetch（复用既有 App integration mock 方式），渲染真实面板；不 mock 预算纯函数。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SAVED_TRIPS_STORAGE_KEY, saveTripToStorage } from '../lib/savedTrips'
import { MOCK_TRIP } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubHappyFetch(example: unknown = MOCK_TRIP) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(example))
    return Promise.reject(new TypeError(`unexpected url: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function budgetRegion(): HTMLElement {
  return screen.getByRole('region', { name: /费用估算/ })
}

async function openBudget(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '费用估算' }))
  await screen.findByRole('region', { name: /费用估算/ })
}

/** 面板里加一行并填金额 */
async function addRowWithAmount(
  user: ReturnType<typeof userEvent.setup>,
  amount: string,
): Promise<void> {
  await user.click(within(budgetRegion()).getByRole('button', { name: '添加费用项' }))
  const rows = within(budgetRegion()).getAllByTestId('budget-row')
  const rowNode = rows[rows.length - 1]
  if (!rowNode) throw new Error('没有新增行')
  await user.type(within(rowNode).getByLabelText('金额（元）'), amount)
}

describe('App 费用估算接线', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('入口默认收起；打开后可加行、计算；关闭重开后金额输入仍在', async () => {
    const fetchMock = stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 默认收起：只有入口按钮，没有面板
    expect(screen.queryByRole('region', { name: /费用估算/ })).toBeNull()
    expect(screen.getByTestId('budget-entry')).toBeInTheDocument()

    await openBudget(user)
    await addRowWithAmount(user, '128.50')
    await user.click(within(budgetRegion()).getByRole('button', { name: '计算已填费用' }))
    expect(within(budgetRegion()).getByTestId('budget-known-total').textContent).toBe('128.50 元')

    // 关闭 → 重开：草稿还在（session 在 App 层），结果保留到输入变化才作废
    await user.click(within(budgetRegion()).getByRole('button', { name: '收起' }))
    expect(screen.queryByRole('region', { name: /费用估算/ })).toBeNull()
    // 显式收起后焦点回到「费用估算」入口按钮，不掉到 body
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '费用估算' }))
    await openBudget(user)
    const rows = within(budgetRegion()).getAllByTestId('budget-row')
    const amount = within(rows[0]!).getByLabelText('金额（元）') as HTMLInputElement
    expect(amount.value).toBe('128.50')
    // 输入没变，结果仍在；改输入后结果清空，须重新计算
    expect(within(budgetRegion()).getByTestId('budget-result')).toBeInTheDocument()
    await user.clear(amount)
    await user.type(amount, '200')
    expect(within(budgetRegion()).queryByTestId('budget-result')).toBeNull()
    await user.click(within(budgetRegion()).getByRole('button', { name: '计算已填费用' }))
    expect(within(budgetRegion()).getByTestId('budget-known-total').textContent).toBe('200.00 元')
    // 无额外网络请求：预算全程不发 /api（除了挂载时的探活与示例）
    const urls = fetchMock.mock.calls.map(([u]) => String(u))
    expect(urls.filter((u) => u.includes('plan'))).toHaveLength(0)
  })

  it('临时打开本地编辑再放弃：费用草稿仍在且不触发原 Trip 撤销链', async () => {
    stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    await addRowWithAmount(user, '66.60')

    // 进本地编辑：费用入口被收起
    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    expect(screen.queryByRole('region', { name: /费用估算/ })).toBeNull()

    // 放弃编辑：回到原视图，费用面板重新挂载（budgetOpen 仍为 true），草稿还在
    await user.click(screen.getByRole('button', { name: '放弃草稿' }))
    await screen.findByRole('region', { name: /费用估算/ })
    const rowsAfter = within(budgetRegion()).getAllByTestId('budget-row')
    expect((within(rowsAfter[0]!).getByLabelText('金额（元）') as HTMLInputElement).value).toBe('66.60')

    // 本地存储逐字节不动；没有下载
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
  })

  it('临时打开地图刷新面板再关闭：费用草稿仍在；隐式隐藏不抢焦点', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    await addRowWithAmount(user, '12')

    // 隐式隐藏（打开地图）：费用面板卸载，但焦点不被预算关闭逻辑抢占
    await user.click(screen.getByRole('button', { name: '仅刷新地图' }))
    await screen.findByTestId('map-refresh-slot')
    expect(screen.queryByRole('region', { name: /费用估算/ })).toBeNull()

    await user.click(within(screen.getByTestId('map-refresh-slot')).getByRole('button', { name: '关闭' }))
    // 关闭地图面板：费用面板重新挂载，草稿仍在
    await screen.findByRole('region', { name: /费用估算/ })
    const rowsAfter = within(budgetRegion()).getAllByTestId('budget-row')
    expect((within(rowsAfter[0]!).getByLabelText('金额（元）') as HTMLInputElement).value).toBe('12')
  })

  it('行程版本变化（应用草稿）后：旧费用只读保留，须显式沿用或新建', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    await addRowWithAmount(user, '88')
    await user.click(within(budgetRegion()).getByRole('button', { name: '收起' }))

    // 应用一个本地编辑：Trip id + revision + 内容都变了
    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    const editor = screen.getByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const nameInput = within(editor).getByLabelText(/站点名称/)
    await user.clear(nameInput)
    await user.type(nameInput, '断桥·新版本')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await user.click(screen.getByRole('button', { name: '应用草稿' }))
    await screen.findByTestId('apply-notice')
    expect(container.textContent).toContain('断桥·新版本')

    // 打开费用面板：显示失配说明，旧金额只读保留
    await openBudget(user)
    expect(within(budgetRegion()).getByTestId('budget-owner-note').textContent).toContain('旧版本的行程')
    const rows = within(budgetRegion()).getAllByTestId('budget-row')
    const amount = within(rows[0]!).getByLabelText('金额（元）')
    expect((amount as HTMLInputElement).value).toBe('88')
    expect(amount).toBeDisabled()
    expect(within(budgetRegion()).getByRole('button', { name: '计算已填费用' })).toBeDisabled()

    // 显式沿用 → 重新可编辑、可计算
    await user.click(within(budgetRegion()).getByRole('button', { name: '沿用这份费用到当前行程' }))
    expect(within(budgetRegion()).queryByTestId('budget-owner-note')).toBeNull()
    await user.click(within(budgetRegion()).getByRole('button', { name: '计算已填费用' }))
    expect(within(budgetRegion()).getByTestId('budget-known-total').textContent).toBe('88.00 元')
  })

  it('预算操作不动行程 / 保存 / 导出：本地存储与网络边界', async () => {
    const fetchMock = stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const createObjectURL = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.create(URL, { createObjectURL: { value: createObjectURL } }))
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    await addRowWithAmount(user, '10')
    await user.click(within(budgetRegion()).getByRole('button', { name: '计算已填费用' }))
    await user.click(within(budgetRegion()).getByRole('button', { name: '清空本次费用' }))
    await user.click(within(budgetRegion()).getByRole('button', { name: '撤销上一步' }))

    // 行程内容不变、存储不变、没有 Blob / 下载、没有新网络请求
    expect(container.textContent).toContain('断桥残雪')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    expect(createObjectURL).not.toHaveBeenCalled()
    const urls = fetchMock.mock.calls.map(([u]) => String(u))
    expect(urls).toEqual(['/api/health', '/api/trips/example'])
    vi.unstubAllGlobals()
  })
})

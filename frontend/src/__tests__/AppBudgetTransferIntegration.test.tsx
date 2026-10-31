/**
 * App × TripBudgetTransfer 接线集成测试：费用面板内挂载、导出预览与下载、
 * 选择文件只预览、确认才改费用、撤销恢复替换前费用、行程版本变化后
 * 导出预览与导入 pending 作废、原预算计算与导出流程不变、
 * 无新增网络 / Storage / 下载。mock fetch（复用既有方式），渲染真实 App。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SAVED_TRIPS_STORAGE_KEY, saveTripToStorage } from '../lib/savedTrips'
import { createBudgetBackup } from '../lib/tripBudgetTransfer'
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

function transferRegion(): HTMLElement {
  return screen.getByTestId('budget-transfer')
}

async function openBudget(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '费用估算' }))
  await screen.findByRole('region', { name: /费用估算/ })
}

async function expandTransfer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(transferRegion()).getByRole('button', { name: '展开费用文件备份' }))
}

const IMPORT_JSON = JSON.stringify({
  format: 'travel-assistant.budget',
  version: 1,
  currency: 'CNY',
  trip: null,
  draft: {
    budgetRaw: '300',
    rows: [
      { id: 'i1', category: 'ticket', name: '导入门票', amountRaw: '80' },
      { id: 'i2', category: 'food', name: '', amountRaw: '' },
    ],
  },
})

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  window.localStorage.clear()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:budget-app'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  const urlStatics = URL as unknown as Record<string, unknown>
  delete urlStatics.createObjectURL
  delete urlStatics.revokeObjectURL
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App 费用文件备份接线', () => {
  it('费用面板内挂载备份子区域：收起时无入口展开；展开不生成不下载', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    expect(within(transferRegion()).getByRole('button', { name: '展开费用文件备份' })).toBeInTheDocument()
    expect(within(transferRegion()).queryByRole('button', { name: '预览费用备份' })).toBeNull()
    expect(URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('填费用 → 预览备份含这些输入 → 下载同一份 JSON → 计算与导出流程不受影响', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    await user.click(within(budgetRegion()).getByRole('button', { name: '添加费用项' }))
    const row = within(budgetRegion()).getAllByTestId('budget-row')[0]
    await user.type(within(row).getByLabelText('名称（可留空）'), '高铁票')
    await user.type(within(row).getByLabelText('金额（元）'), '128.50')

    await expandTransfer(user)
    await user.click(within(transferRegion()).getByRole('button', { name: '预览费用备份' }))
    const textarea = within(transferRegion()).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toContain('128.50')
    expect(textarea.value).toContain('高铁票')

    await user.click(within(transferRegion()).getByRole('button', { name: '下载费用备份 (.budget.json)' }))
    expect(URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)

    // 原预算计算不受影响
    await user.click(within(budgetRegion()).getByRole('button', { name: '计算已填费用' }))
    expect(within(budgetRegion()).getByTestId('budget-known-total').textContent).toBe('128.50 元')
  })

  it('选择费用文件 → 预览 → 确认替换：session 更新、可撤销恢复替换前费用', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    // 先手填一条，作为「替换前的费用」
    await user.click(within(budgetRegion()).getByRole('button', { name: '添加费用项' }))
    const row = within(budgetRegion()).getAllByTestId('budget-row')[0]
    await user.type(within(row).getByLabelText('金额（元）'), '50')

    await expandTransfer(user)
    const fileInput = within(transferRegion()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(
      fileInput,
      { name: 'b.budget.json', size: IMPORT_JSON.length, text: () => Promise.resolve(IMPORT_JSON) } as unknown as File,
    )
    await screen.findByTestId('budget-import-preview')
    expect(within(transferRegion()).getByTestId('budget-import-preview').textContent).toContain('导入门票')

    // 两步确认
    await user.click(within(transferRegion()).getByRole('button', { name: '替换当前费用草稿' }))
    await screen.findByTestId('budget-import-confirm-text')
    await user.click(within(transferRegion()).getByRole('button', { name: '确认替换费用' }))
    await screen.findByTestId('budget-import-notice')

    // 导入的 rows 替换了手填的 50
    const rows = within(budgetRegion()).getAllByTestId('budget-row')
    expect(rows).toHaveLength(2)
    expect((within(rows[0]).getByLabelText('金额（元）') as HTMLInputElement).value).toBe('80')

    // 撤销恢复替换前的费用（原 1 行 50）
    await user.click(within(budgetRegion()).getByRole('button', { name: '撤销上一步' }))
    const rowsAfterUndo = within(budgetRegion()).getAllByTestId('budget-row')
    expect(rowsAfterUndo).toHaveLength(1)
    expect((within(rowsAfterUndo[0]).getByLabelText('金额（元）') as HTMLInputElement).value).toBe('50')
  })

  it('行程版本变化（应用草稿）后：打开备份区，旧导出预览不存在，须重新预览；同 id 内容 A→B→A 不复活', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    await user.click(within(budgetRegion()).getByRole('button', { name: '添加费用项' }))
    const row = within(budgetRegion()).getAllByTestId('budget-row')[0]
    await user.type(within(row).getByLabelText('金额（元）'), '10')
    await expandTransfer(user)
    await user.click(within(transferRegion()).getByRole('button', { name: '预览费用备份' }))
    expect(within(transferRegion()).getByTestId('budget-export-preview')).toBeInTheDocument()

    // 先收起费用面板（既有模式），再应用本地编辑：Trip 内容变化 → 旧导出预览作废
    await user.click(within(budgetRegion()).getByRole('button', { name: '收起' }))
    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    const editor = screen.getByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    await user.type(within(editor).getByLabelText(/站点名称/), '·新')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await user.click(within(editor).getByRole('button', { name: '应用草稿' }))
    await screen.findByTestId('apply-notice')

    // 重新打开费用面板与备份区：旧导出预览已作废，须重新预览
    await openBudget(user)
    await expandTransfer(user)
    expect(within(transferRegion()).queryByTestId('budget-export-preview')).toBeNull()
    expect(within(transferRegion()).getByRole('button', { name: '预览费用备份' })).toBeEnabled()
  })

  it('无新增网络 / Storage / 自动下载：备份全程不发请求、不写存储', async () => {
    const fetchMock = stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    await expandTransfer(user)
    await user.click(within(transferRegion()).getByRole('button', { name: '预览费用备份' }))
    const fileInput = within(transferRegion()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(
      fileInput,
      { name: 'b.budget.json', size: IMPORT_JSON.length, text: () => Promise.resolve(IMPORT_JSON) } as unknown as File,
    )
    await screen.findByTestId('budget-import-preview')

    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    const urls = fetchMock.mock.calls.map(([u]) => String(u))
    expect(urls).toEqual(['/api/health', '/api/trips/example'])
  })

  it('面板说明与来源口径更新：显示「输入或此前确认导入的记录」；备份说明提到与行程 JSON 备份分开', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    expect(within(budgetRegion()).getByText(/输入或此前确认导入的记录/)).toBeInTheDocument()
    await expandTransfer(user)
    expect(within(transferRegion()).getByText(/与行程 JSON 备份是两个独立文件/)).toBeInTheDocument()
  })

  it('生成内容与纯函数一致：面板预览等于 createBudgetBackup 输出（同 owner 投影）', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openBudget(user)
    await expandTransfer(user)
    await user.click(within(transferRegion()).getByRole('button', { name: '预览费用备份' }))
    const textarea = within(transferRegion()).getByRole('textbox') as HTMLTextAreaElement
    // 无 owner：trip 自述为 null
    const expected = createBudgetBackup({ tripId: null, tripTitle: null, budgetRaw: '', rows: [] })
    if (!expected.ok) throw new Error(expected.message)
    expect(textarea.value).toBe(expected.json)
  })
})

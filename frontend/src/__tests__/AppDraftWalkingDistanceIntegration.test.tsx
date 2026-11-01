/**
 * App × 步行距离检查集成测试：示例 → 进编辑 → 显式检查 → 实际编辑导致路线未知 →
 * 应用 + 一层撤销 / 放弃。mock fetch，渲染真实 TripDraftEditor 与 TripMap；
 * 不 mock 草稿纯函数。确认阈值与结果不进 Trip / 保存导出、无新请求、无 Storage 写。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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

async function startEditing(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
  await screen.findByRole('region', { name: '本地行程草稿编辑器' })
}

function editorRegion(): HTMLElement {
  return screen.getByRole('region', { name: '本地行程草稿编辑器' })
}

function walkingSection(editor: HTMLElement): HTMLElement {
  return within(editor).getByRole('region', { name: '每天步行距离上限（偏好检查）' })
}

/** 启用步行距离检查（默认上限 3000）并显式点检查 */
async function runWalkingCheck(user: ReturnType<typeof userEvent.setup>) {
  const section = walkingSection(editorRegion())
  await user.click(within(section).getByRole('checkbox', { name: /启用每天步行距离检查/ }))
  await user.click(within(section).getByRole('button', { name: '检查' }))
}

/** 修改第一个站点的地址并保存到草稿（地点变化 → 相关导航路线失效为未知） */
async function readdressFirstStop(user: ReturnType<typeof userEvent.setup>) {
  const editor = editorRegion()
  await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
  const addressInput = within(editor).getByLabelText('地址')
  await user.clear(addressInput)
  await user.type(addressInput, '北山街改线 1 号')
  await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
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

describe('App × 步行距离检查接线', () => {
  it('示例 → 进编辑 → 检查（1100 米未超）→ 改地址使路线未知 → 结果按当前 legs 变「暂无数据」', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await runWalkingCheck(user)
    const section = walkingSection(editorRegion())
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)
    expect(within(section).getAllByText(/未发现超限/).length).toBeGreaterThan(0)

    // 实际编辑：改 s1 地址 → s1→s2 的 walking navigation 失效，距离未知
    await readdressFirstStop(user)
    await waitFor(() =>
      expect(within(section).queryByText(/合计 1100 米/)).toBeNull(),
    )
    expect(within(section).getAllByText(/暂无可统计的导航步行距离/).length).toBeGreaterThan(0)
    // 地图预览不再画失效的那条路线：原坐标站点只剩 s2
    await waitFor(() => expect(container.querySelectorAll('.stop-dot-wrapper')).toHaveLength(1))
  })

  it('应用 + 撤销应用：阈值与结果不进 Trip / 提醒，保存记录逐字节不动，无新请求无 Storage 写', async () => {
    const fetchMock = stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await runWalkingCheck(user)
    // 把上限改成已知会超的值并重新检查，确认超限提示也不进 Trip
    const section = walkingSection(editorRegion())
    const input = within(section).getByRole('textbox', { name: '每天步行距离上限' })
    await user.clear(input)
    await user.type(input, '500')
    await user.click(within(section).getByRole('button', { name: '检查' }))
    expect(within(section).getAllByText('已记录超限').length).toBeGreaterThan(0)

    // 保存步行检查结果的同时做一次会改变内容的时间编辑，保证应用能产生新副本
    const editor = editorRegion()
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const timeInput = within(editor).getByLabelText(/^时间/)
    await user.clear(timeInput)
    await user.type(timeInput, '08:15')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    await user.click(screen.getByRole('button', { name: '应用草稿' }))
    await screen.findByTestId('apply-notice')
    expect(screen.queryByRole('region', { name: '本地行程草稿编辑器' })).toBeNull()

    // 阈值 / 检查结论不写进应用后的 Trip：提醒、摘要与页面文案都不含步行上限
    const appliedText = container.textContent ?? ''
    expect(appliedText).not.toContain('步行距离上限')
    expect(appliedText).not.toContain('已记录超限')
    expect(appliedText).not.toContain('500 米')
    expect(appliedText).toContain('08:15')

    // 撤销应用：回到应用前的行程
    await user.click(screen.getByRole('button', { name: '撤销应用' }))
    await waitFor(() => expect(screen.queryByText('08:15')).toBeNull())

    // 无新请求（无 /api/trips/plan），原保存记录逐字节不动，步行检查本身没写 Storage
    const urls = fetchMock.mock.calls.map(([u]) => String(u))
    expect(urls).not.toContain('/api/trips/plan')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    // 恢复示例 / 应用等既有路径之外，本流程没有额外 setItem（seed 的那次除外）
    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('放弃草稿：检查设置只属于编辑会话，放弃后页面无残留，原行程与存储不变', async () => {
    const fetchMock = stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await runWalkingCheck(user)
    expect(within(walkingSection(editorRegion())).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    // 只检查未编辑：草稿与原始行程一致，「放弃草稿」直接生效，无页内确认步骤
    await user.click(screen.getByRole('button', { name: '放弃草稿' }))
    expect(screen.queryByRole('region', { name: '本地行程草稿编辑器' })).toBeNull()
    const text = container.textContent ?? ''
    expect(text).not.toContain('每天步行距离上限')
    expect(text).not.toContain('已记录导航步行距离合计')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    expect(fetchMock.mock.calls.map(([u]) => String(u))).not.toContain('/api/trips/plan')
  })

  it('编辑期间修改输入使旧结果清除且未重新检查：不显示任何过时结论，也不发请求', async () => {
    const fetchMock = stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await runWalkingCheck(user)
    const section = walkingSection(editorRegion())
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    // 改输入后旧结果立即失效（未重新检查），编辑器继续可用
    const input = within(section).getByRole('textbox', { name: '每天步行距离上限' })
    await user.clear(input)
    await user.type(input, '20000')
    expect(within(section).queryByText(/合计 1100 米/)).toBeNull()
    expect(within(section).getByText('已启用，待检查')).toBeInTheDocument()
    expect(screen.getByTestId('draft-preview-note')).toBeInTheDocument()
    expect(fetchMock.mock.calls.map(([u]) => String(u))).not.toContain('/api/trips/plan')
    expect(container.textContent).not.toContain('已记录超限')
  })
})

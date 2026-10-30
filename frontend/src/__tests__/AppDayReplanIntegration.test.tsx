/**
 * App × DayReplanPanel 接线集成测试：AI 单日调整入口、目标日锁定、候选预览不替换行程、
 * 显式应用 / 撤销应用、ID 冲突拒绝、模式互斥与后端结论守卫。
 *
 * 业务请求（health / example / replan）用 fetch mock；build / validate / apply 纯函数、
 * 本地存储与真实 App 组件不 mock。此文件不启动浏览器，也不发真实服务请求。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SAVED_TRIPS_STORAGE_KEY, saveTripToStorage } from '../lib/savedTrips'
import { createTripBackup } from '../lib/tripTransfer'
import type { DayReplanRequest, DayReplanResponse } from '../lib/dayReplan'
import { MOCK_TRIP } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function candidateFor(request: DayReplanRequest, stopIds: [string, string] = ['ai-d2-1', 'ai-d2-2']): DayReplanResponse {
  const [firstId, secondId] = stopIds
  return {
    day: {
      day: request.day,
      date: request.date,
      title: 'AI 调整后的运河线',
      summary: 'AI 候选摘要：拱宸桥与小河直街。',
      stops: [
        {
          id: firstId,
          name: '拱宸桥',
          time: '09:30',
          duration_minutes: 60,
          description: '运河边的石拱桥。',
          address: '杭州市拱墅区桥弄街',
          location: { lng: 120.14, lat: 30.32 },
        },
        {
          id: secondId,
          name: '小河直街',
          time: '11:00',
          duration_minutes: 90,
          description: '沿河老街区。',
          address: '杭州市拱墅区小河直街',
          location: { lng: 120.141, lat: 30.306 },
        },
      ],
      legs: [
        {
          from_stop_id: firstId,
          to_stop_id: secondId,
          mode: request.travel_mode,
          route_type: 'navigation',
          distance_m: 820,
          duration_minutes: 13,
          geometry: [
            { lng: 120.14, lat: 30.32 },
            { lng: 120.141, lat: 30.306 },
          ],
          description: '沿运河步行。',
        },
      ],
    },
    warnings: ['本次返回提醒：09:30 是计划时刻，不是已确认的预约时间。'],
    map_status: 'ready',
    parent: { ...request.parent },
    source: 'agent',
  }
}

type ReplanHandler = (request: DayReplanRequest) => Promise<Response> | Response

/** health / example 正常返回；replan 由每个用例决定如何应答 */
function stubFetch(options: { plannerReady?: boolean; replan?: ReplanHandler } = {}) {
  const healthBody: Record<string, unknown> = { status: 'healthy', amap_configured: true }
  if (options.plannerReady !== undefined) healthBody.planner_ready = options.plannerReady
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/health') return Promise.resolve(jsonResponse(healthBody))
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
    if (url === '/api/trips/days/replan') {
      const request = JSON.parse(String(init?.body)) as DayReplanRequest
      if (!options.replan) return Promise.reject(new TypeError('本用例不应发起 replan 请求'))
      return Promise.resolve(options.replan(request))
    }
    return Promise.reject(new TypeError(`unexpected url: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function replanUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/replan'))
}

/** 后端状态胶囊的可见文本（结论分散在多个 span 里，用容器文本断言更可靠） */
function backendText(): string {
  return document.querySelector('.backend-state')?.textContent ?? ''
}

async function openAiPanel(user: ReturnType<typeof userEvent.setup>, dayTab?: RegExp) {
  if (dayTab) await user.click(screen.getByRole('tab', { name: dayTab }))
  await user.click(screen.getByRole('button', { name: 'AI 调整这一天' }))
  await screen.findByRole('region', { name: 'AI 调整单日安排' })
}

/** 面板不猜出行方式：本日路线混合或为空时必须显式选一次 */
async function chooseWalking(user: ReturnType<typeof userEvent.setup>) {
  const panel = screen.getByRole('region', { name: 'AI 调整单日安排' })
  await user.click(within(panel).getByLabelText('步行'))
}

describe('App AI 单日调整接线', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('入口显示当前目标日；打开后不自动请求，候选只在面板对比区，原行程/地图/存储不变', async () => {
    const fetchMock = stubFetch({ replan: (request) => jsonResponse(candidateFor(request)) })
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 入口明确当前日
    expect(screen.getByTestId('ai-entry').textContent).toContain('第 1 天')
    await openAiPanel(user)

    // 打开面板本身不发 replan；日期切换、规划、保存、备份都被暂停
    expect(replanUrls(fetchMock)).toHaveLength(0)
    expect(screen.getByLabelText(/目的地/)).toBeDisabled()
    expect(screen.queryByRole('button', { name: '保存当前行程' })).toBeNull()
    expect(screen.queryByRole('button', { name: '行程备份与导入' })).toBeNull()
    await user.click(screen.getByRole('tab', { name: /龙井问茶/ }))
    expect(screen.getByRole('tab', { name: /西湖环湖/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('ai-day-lock-note').textContent).toContain('目标固定为第 1 天')

    await chooseWalking(user)
    await user.type(screen.getByLabelText(/调整指令/), '把第一天改得轻松一点。')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(replanUrls(fetchMock)).toHaveLength(1))
    expect(screen.getByText(/候选预览（尚未应用到行程）/)).toBeInTheDocument()
    // 候选名只出现在对比区；下方列表仍是原方案
    expect(screen.getByText('拱宸桥')).toBeInTheDocument()
    const itinerary = screen.getByRole('tabpanel')
    expect(within(itinerary).getByText('断桥残雪')).toBeInTheDocument()
    expect(within(itinerary).queryByText('拱宸桥')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: '杭州三日漫步路书' })).toBeInTheDocument()
    // 未应用：存储逐字节不动，也没有新规划请求
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('/api/trips/plan')

    // 关闭面板：日期切换、保存与备份入口恢复
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('region', { name: 'AI 调整单日安排' })).toBeNull()
    expect(screen.getByRole('button', { name: '保存当前行程' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '行程备份与导入' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /龙井问茶/ }))
    expect(screen.getByRole('tab', { name: /龙井问茶/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('应用第 2 天候选：只替换目标日，其余天与保存记录不变；可保存、可撤销应用', async () => {
    const fetchMock = stubFetch({ replan: (request) => jsonResponse(candidateFor(request)) })
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const section = screen.getByRole('region', { name: '行程安排' })
    const revisionBefore = Number(section.getAttribute('data-trip-revision'))
    expect(revisionBefore).toBeGreaterThan(0)

    await openAiPanel(user, /运河与老巷/)
    expect(screen.getByText(/第 2 天（2026-04-04）/)).toBeInTheDocument()
    await chooseWalking(user)
    await user.type(screen.getByLabelText(/调整指令/), '把第二天换成运河边慢走。')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled())
    const request = JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).includes('/replan'))?.[1]?.body))
    expect(request.day).toBe(2)
    expect(request.parent.trip_id).toBe(MOCK_TRIP.id)
    expect('travelers' in request).toBe(false)

    await user.click(screen.getByRole('button', { name: '应用候选' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'AI 调整单日安排' })).toBeNull())

    // 事件式应用说明：不自动保存、保留示例身份、日历是新副本
    const notice = screen.getByTestId('apply-notice')
    expect(notice.textContent).toContain('不会自动保存')
    expect(notice.textContent).toContain('保留了原来的示例行程身份')
    expect(notice.textContent).toContain('不会更新之前导入的事件')
    // 来源身份不升级：仍是示例
    expect(screen.getByText('示例行程')).toBeInTheDocument()
    // 目标日替换为候选内容
    expect(within(screen.getByRole('tabpanel')).getByText('拱宸桥')).toBeInTheDocument()
    expect(Number(section.getAttribute('data-trip-revision'))).toBe(revisionBefore + 1)
    // 原保存记录逐字节不动
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)

    // 其余天内容不变
    await user.click(screen.getByRole('tab', { name: /西湖环湖/ }))
    expect(within(screen.getByRole('tabpanel')).getByText('断桥残雪')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /龙井问茶/ }))
    expect(within(screen.getByRole('tabpanel')).getByText('龙井村')).toBeInTheDocument()

    // 用户显式保存后，提示仍只说「这次应用不自动保存」，不声称当前未保存
    await user.click(screen.getByRole('button', { name: '保存当前行程' }))
    await waitFor(() => expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).not.toBe(storageBefore))
    const storageAfterSave = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    expect(document.body.textContent).not.toContain('尚未保存')

    // 撤销应用：回到应用前行程；显式保存的新副本不被删除
    await user.click(screen.getByRole('button', { name: '撤销应用' }))
    await waitFor(() => expect(screen.queryByText('拱宸桥')).toBeNull())
    await user.click(screen.getByRole('tab', { name: /运河与老巷/ }))
    expect(within(screen.getByRole('tabpanel')).queryByText('拱宸桥')).toBeNull()
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageAfterSave)
  })

  it('候选站点与其它天 ID 冲突时父级拒绝应用，面板显示失败，行程不动', async () => {
    stubFetch({ replan: (request) => jsonResponse(candidateFor(request, ['s1', 'ai-d2-2'])) })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const section = screen.getByRole('region', { name: '行程安排' })
    const revisionBefore = Number(section.getAttribute('data-trip-revision'))

    await openAiPanel(user, /运河与老巷/)
    await chooseWalking(user)
    await user.type(screen.getByLabelText(/调整指令/), '把第二天换成运河边慢走。')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '应用候选' }))

    expect(await screen.findByText(/与其它天已有站点冲突/)).toBeInTheDocument()
    // 面板保持打开，当前行程与版本号都没有被改动
    expect(screen.getByRole('region', { name: 'AI 调整单日安排' })).toBeInTheDocument()
    expect(screen.queryByTestId('apply-notice')).toBeNull()
    expect(Number(section.getAttribute('data-trip-revision'))).toBe(revisionBefore)
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('从导入文件打开的行程应用 AI 候选后：来源说明与「未向服务器核对」保留，不升级成已验证', async () => {
    stubFetch({ replan: (request) => jsonResponse(candidateFor(request)) })
    const imported = {
      ...MOCK_TRIP,
      id: 'trip-imported-ai',
      source: 'agent' as const,
      title: '导入的运河行程',
    }
    const backup = createTripBackup(imported, { now: new Date('2026-03-01T00:00:00.000Z') })
    if (!backup.ok) throw new Error('fixture backup failed')
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await user.click(screen.getByRole('button', { name: '行程备份与导入' }))
    fireEvent.change(screen.getByLabelText(/选择备份文件/), {
      target: { files: [new File([backup.json], 'imported.json', { type: 'application/json' })] },
    })
    await screen.findByText('预览：导入的运河行程')
    await user.click(screen.getByRole('button', { name: '打开这份行程' }))
    await screen.findByRole('heading', { level: 2, name: '导入的运河行程' })
    expect(screen.getByText(/不能证明它的真实来源/)).toBeInTheDocument()

    await openAiPanel(user, /运河与老巷/)
    await chooseWalking(user)
    await user.type(screen.getByLabelText(/调整指令/), '换成运河边慢走。')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '应用候选' }))
    await screen.findByTestId('apply-notice')

    // 只换一天，不代表整份文件内容已被服务器核对
    expect(screen.getByTestId('apply-notice').textContent).toContain('其余内容仍未向服务器核对')
    expect(screen.getByText(/不能证明它的真实来源/)).toBeInTheDocument()
    expect(screen.getByText('AI 规划')).toBeInTheDocument()
    // 打开文件 + 应用候选都不写本机保存
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('本地草稿与 AI 面板互斥：草稿输入不丢，按钮禁用；放弃草稿后 AI 入口恢复', async () => {
    stubFetch({ replan: (request) => jsonResponse(candidateFor(request)) })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    const editor = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    expect(screen.getByRole('button', { name: 'AI 调整这一天' })).toBeDisabled()
    // 打开单站表单并输入但不保存
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const nameInput = within(editor).getByLabelText(/站点名称/)
    await user.clear(nameInput)
    await user.type(nameInput, '草稿里的新名字')
    // 禁用按钮不会打开 AI 面板，编辑器与未提交输入都保留
    await user.click(screen.getByRole('button', { name: 'AI 调整这一天' }))
    expect(screen.queryByRole('region', { name: 'AI 调整单日安排' })).toBeNull()
    expect(screen.getByRole('region', { name: '本地行程草稿编辑器' })).toBeInTheDocument()
    expect((within(editor).getByLabelText(/站点名称/) as HTMLInputElement).value).toBe('草稿里的新名字')

    // 先取消未提交的单站输入（结构动作在输入期间被暂停），再放弃草稿
    await user.click(within(editor).getByRole('button', { name: '取消输入' }))
    await waitFor(() => expect(within(editor).queryByLabelText(/站点名称/)).toBeNull())
    await user.click(within(editor).getByRole('button', { name: '放弃草稿' }))
    const confirm = screen.queryByRole('button', { name: '确认放弃草稿' })
    if (confirm) await user.click(confirm)
    await waitFor(() => expect(screen.queryByRole('region', { name: '本地行程草稿编辑器' })).toBeNull())
    expect(screen.getByRole('button', { name: 'AI 调整这一天' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'AI 调整这一天' }))
    expect(await screen.findByRole('region', { name: 'AI 调整单日安排' })).toBeInTheDocument()
  })

  it('planner 明确不可用时面板禁用生成并说明本地编辑仍可用', async () => {
    stubFetch({ plannerReady: false, replan: (request) => jsonResponse(candidateFor(request)) })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    await waitFor(() => expect(screen.getAllByText(/规划暂不可用/).length).toBeGreaterThan(0))

    await openAiPanel(user)
    expect(screen.getByText(/AI 规划当前不可用/)).toBeInTheDocument()
    expect(screen.getByText(/本地编辑不受影响/)).toBeInTheDocument()
    await user.type(screen.getByLabelText(/调整指令/), '改一下。')
    expect(screen.getByRole('button', { name: '生成调整候选' })).toBeDisabled()
  })

  it('关闭面板时仍在等待的请求即使迟到也不生成候选，也不改行程', async () => {
    let request: DayReplanRequest | null = null
    let resolveReplan!: (response: Response) => void
    const pendingReplan = new Promise<Response>((resolve) => {
      resolveReplan = resolve
    })
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy', planner_ready: true }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/days/replan') {
        request = JSON.parse(String(init?.body)) as DayReplanRequest
        return pendingReplan
      }
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const section = screen.getByRole('region', { name: '行程安排' })
    const revisionBefore = Number(section.getAttribute('data-trip-revision'))

    await openAiPanel(user)
    await chooseWalking(user)
    await user.type(screen.getByLabelText(/调整指令/), '把第一天改得轻松一点。')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(replanUrls(fetchMock)).toHaveLength(1))
    // 等待中关闭面板：候选作废，页面回到可操作状态
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('region', { name: 'AI 调整单日安排' })).toBeNull()

    // 迟到的响应到达：不出现候选 / 应用入口，行程与版本号都不变
    await act(async () => {
      resolveReplan(jsonResponse(candidateFor(request as DayReplanRequest)))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByText(/候选预览（尚未应用到行程）/)).toBeNull()
    expect(screen.queryByRole('button', { name: '应用候选' })).toBeNull()
    expect(screen.queryByTestId('apply-notice')).toBeNull()
    expect(screen.getByRole('heading', { level: 2, name: '杭州三日漫步路书' })).toBeInTheDocument()
    expect(Number(section.getAttribute('data-trip-revision'))).toBe(revisionBefore)
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('AI 成功会证明规划可用；迟到的健康检查不能把它翻成不可用', async () => {
    let resolveHealth!: (response: Response) => void
    const healthPromise = new Promise<Response>((resolve) => {
      resolveHealth = resolve
    })
    let replanRequest: DayReplanRequest | null = null
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/health') return healthPromise
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/days/replan') {
        replanRequest = JSON.parse(String(init?.body)) as DayReplanRequest
        return Promise.resolve(jsonResponse(candidateFor(replanRequest)))
      }
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    // 探活还没回来：规划能力未知，但面板允许发起一次调整
    expect(backendText()).toContain('规划能力未知')
    await openAiPanel(user)
    await chooseWalking(user)
    await user.type(screen.getByLabelText(/调整指令/), '把第一天改得轻松一点。')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled())
    // 有效的 AI 成功说明规划确实可用
    expect(backendText()).toContain('可以生成行程')
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('region', { name: 'AI 调整单日安排' })).toBeNull()

    // 迟到的探活（说规划不可用）不能把已经证明可用的结论翻回去
    await act(async () => {
      resolveHealth(jsonResponse({ status: 'healthy', planner_ready: false, amap_configured: true }))
      await Promise.resolve()
    })
    await waitFor(() => expect(backendText()).not.toContain('规划能力未知'))
    expect(backendText()).toContain('可以生成行程')
    expect(backendText()).not.toContain('规划暂不可用')
    expect(replanRequest).not.toBeNull()
    expect(screen.queryByTestId('apply-notice')).toBeNull()
  })
})

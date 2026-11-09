/**
 * App × WebSourcesPanel 集成测试：真实 App、真实 WebSourcesPanel、真实
 * webSourcesApi/webSources 客户端链路，只 mock fetch；未知 URL 立即失败，
 * 禁止真实网络兜底。覆盖 App 接线合同：
 * - 入口默认收起、打开零请求；显式点击恰好一次 POST /api/web-sources/search，
 *   body 只含规范化 query，不拼 Trip/坐标/Key；
 * - FEFF 与 padding 边界与共享规范化（Python strip 口径）一致；
 * - planner 不可用仍可独立查询；
 * - 切天/编辑/AI/地图/导入/保存恢复/会话恢复/新规划后旧结果立即失效，
 *   迟到响应不落地、零自动请求；
 * - 显式收起焦点回入口、隐式收起不抢焦点；关闭重开无旧结果、不重发；
 * - 搜索不改 Trip/费用/localStorage（预置数据逐字节原样）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import type { Trip } from '../lib/api'
import { SAVED_TRIPS_STORAGE_KEY, saveTripToStorage } from '../lib/savedTrips'
import {
  SESSION_RESUME_DATA_KEY,
  SESSION_RESUME_FLAG_KEY,
  setSessionResumeFlag,
} from '../lib/sessionRestore'
import { createTripBackup } from '../lib/tripTransfer'
import { WEB_SOURCES_SEARCH_PATH, type WebSearchReport } from '../lib/webSources'
import { MOCK_TRIP } from './fixtures/trip'
import { makeWebSearchReport } from './fixtures/webSources'

const QUERY = '西湖 旅游'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 按实发 body 构造合法信封：requested_query 必须等于本次规范化 query，否则整包校验失败 */
function webSearchResponse(init?: RequestInit, overrides: Partial<WebSearchReport> = {}): Response {
  const sent = (JSON.parse(String(init?.body)) as { query: string }).query
  return jsonResponse(makeWebSearchReport({ requested_query: sent, ...overrides }))
}

function stubAppFetch(
  options: {
    health?: unknown
    example?: unknown
    plan?: unknown
    searchImpl?: (init?: RequestInit) => Promise<Response>
  } = {},
) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/health') {
      return Promise.resolve(
        jsonResponse(options.health ?? { status: 'healthy', planner_ready: true, amap_configured: true }),
      )
    }
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(options.example ?? MOCK_TRIP))
    if (url === '/api/trips/plan' && options.plan !== undefined) {
      return Promise.resolve(jsonResponse(options.plan))
    }
    if (url === WEB_SOURCES_SEARCH_PATH) {
      return (options.searchImpl ?? ((i?: RequestInit) => Promise.resolve(webSearchResponse(i))))(init)
    }
    return Promise.reject(new TypeError(`未知 URL，测试禁止真实网络：${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function searchCalls(fetchMock: ReturnType<typeof vi.fn>): Array<[string, RequestInit | undefined]> {
  return fetchMock.mock.calls.filter(([url]) => String(url) === WEB_SOURCES_SEARCH_PATH) as Array<
    [string, RequestInit | undefined]
  >
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** 让整个 postJson → readJson → 校验链路（含迟到丢弃）排空到宏任务边界 */
async function flushAsyncQueue() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
  })
}

async function openWebSources(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '查网页资料' }))
  expect(screen.getByTestId('web-sources-panel')).toBeInTheDocument()
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value } })
}

async function searchOnce(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '搜索网页资料' }))
}

function stopRowButton(name: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>('[data-testid=stop-row]')).find((node) =>
    node.textContent?.includes(name),
  )
  if (!row) throw new Error(`找不到站点行：${name}`)
  return row
}

/** 与示例不同的第二份合法行程：保存恢复 / 会话恢复用 */
const PLAN_TRIP: Trip = {
  ...MOCK_TRIP,
  id: 'trip-ws-planned',
  source: 'agent',
  title: '南京两日规划行',
}

/** 导入用行程夹具：结构按 Trip 契约写全，才能通过备份解析校验 */
const IMPORTED_TRIP: Trip = {
  id: 'trip-ws-imported',
  source: 'agent',
  destination: '西安',
  title: '西安古城两日行',
  summary: '从备份文件导入的行程，用于验证网页资料面板的归属失效。',
  map_coordinate_system: 'WGS84',
  warnings: [],
  days: [
    {
      day: 1,
      date: '2026-05-01',
      title: '城墙与雁塔',
      summary: '上午登城墙，下午去大雁塔。',
      stops: [
        {
          id: 'ws-xa-s1',
          name: '永宁门',
          time: '09:00',
          duration_minutes: 45,
          description: '城墙南门，登城入口。',
          address: '西安市碑林区',
          location: { lng: 108.947, lat: 34.2515 },
        },
        {
          id: 'ws-xa-s2',
          name: '大雁塔',
          time: '14:00',
          duration_minutes: 60,
          description: '慈恩寺内的唐代砖塔。',
          address: '西安市雁塔区',
          location: { lng: 108.9642, lat: 34.2181 },
        },
      ],
      legs: [
        {
          from_stop_id: 'ws-xa-s1',
          to_stop_id: 'ws-xa-s2',
          mode: 'walking',
          route_type: 'navigation',
          distance_m: 3200,
          duration_minutes: 45,
          geometry: [
            { lng: 108.947, lat: 34.2515 },
            { lng: 108.9642, lat: 34.2181 },
          ],
          description: '沿南大街步行。',
        },
      ],
    },
  ],
}

function backupFileOf(trip: Trip): File {
  const backup = createTripBackup(trip, { now: new Date('2026-02-02T00:00:00.000Z') })
  if (!backup.ok) throw new Error(`生成备份失败：${backup.reason}`)
  return new File([backup.json], 'trip-backup.json', { type: 'application/json' })
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('App 网页资料接线集成', () => {
  it('入口默认收起；打开零请求；选中站点作为初始上下文；显式一次 POST 只含规范化 query；结果安全展示', async () => {
    expect(WEB_SOURCES_SEARCH_PATH).toBe('/api/web-sources/search')
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)

    await screen.findByRole('heading', { name: '杭州三日漫步路书' })
    // 默认收起：只有入口，没有面板，也没有任何搜索请求
    expect(screen.queryByTestId('web-sources-panel')).toBeNull()
    expect(screen.getByTestId('web-sources-entry')).toBeInTheDocument()
    expect(searchCalls(fetchMock)).toHaveLength(0)

    // 选中站点作为面板站点上下文的初始线索（只作初值，不参与 query）
    await user.click(stopRowButton('断桥残雪'))
    await openWebSources(user)
    expect(screen.getByLabelText('站点上下文（可选）')).toHaveValue('s1')
    expect(searchCalls(fetchMock)).toHaveLength(0)

    typeQuery(QUERY)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')

    const calls = searchCalls(fetchMock)
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]!
    expect(String(url)).toBe('/api/web-sources/search')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
    })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toEqual({ query: QUERY })
    expect(Object.keys(body)).toEqual(['query'])
    expect(String(init?.body)).not.toMatch(/tvly|api[_-]?key|trip-mock|断桥|30\.2726|120\.1576/)

    // 结果安全展示：状态、未核实标记、发布日期、安全链接与来源说明
    expect(screen.getByTestId('web-sources-status-tag')).toHaveTextContent('已返回')
    expect(screen.getByTestId('web-sources-unverified')).toBeInTheDocument()
    expect(screen.getByText('杭州西湖旅游攻略')).toBeInTheDocument()
    expect(screen.getByText('网页发布日期：2025-06-01')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'https://www.example-travel.com/xihu-guide' })
    expect(link).toHaveAttribute('href', 'https://www.example-travel.com/xihu-guide')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText(QUERY)).toBeInTheDocument()
    expect(screen.getByTestId('web-sources-attribution')).toHaveTextContent('Tavily')
    expect(screen.getByText(/搜索内容与结果只在本页内存里/)).toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
  })

  it('planner 不可用时网页资料入口仍可独立查询', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch({ health: { status: 'healthy', planner_ready: false, amap_configured: true } })
    render(<App />)

    await screen.findByRole('heading', { name: '杭州三日漫步路书' })
    expect(screen.getByText('后端在线，规划暂不可用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '规划暂不可用' })).toBeDisabled()
    expect(screen.getByTestId('web-sources-entry')).toBeInTheDocument()

    await openWebSources(user)
    typeQuery(QUERY)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(1)
  })

  it('FEFF 填充与 FEFF-only：body 实发原文（Python strip 不剥 FEFF），二次校验不误判', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await openWebSources(user)
    const rawWithFeff = `\uFEFF${QUERY}\uFEFF`
    typeQuery(rawWithFeff)
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')

    let calls = searchCalls(fetchMock)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ query: rawWithFeff })
    expect(screen.queryByTestId('web-sources-error')).toBeNull()

    // FEFF-only 非空白：合法可查询
    typeQuery('\uFEFF\uFEFF')
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    calls = searchCalls(fetchMock)
    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls[1]![1]?.body))).toEqual({ query: '\uFEFF\uFEFF' })
  })

  it('padding 边界：空白+300 astral+空白 规范化后合法发一次；301 码点禁用零请求', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await openWebSources(user)
    typeQuery(` \u2028 ${'🚀'.repeat(300)} \u00A0`)
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')

    let calls = searchCalls(fetchMock)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ query: '🚀'.repeat(300) })

    // 规范化后 301 码点：FEFF 不剥计入上限 → 禁用、零请求
    typeQuery('')
    typeQuery(`\uFEFF${'🚀'.repeat(299)}\uFEFF`)
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(screen.getByText(/当前输入不能作为查询/)).toBeInTheDocument()
    typeQuery(`x${'🚀'.repeat(300)}`)
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(searchCalls(fetchMock)).toHaveLength(1)
  })

  it('切天：面板保持、旧结果立即失效、零自动请求；再显式搜索发新请求', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await openWebSources(user)
    typeQuery(QUERY)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(1)

    await user.click(screen.getByRole('tab', { name: /D3/ }))
    await waitFor(() => expect(screen.queryByTestId('web-sources-result')).toBeNull())
    // 面板仍在（切天不卸载），标题换成第 3 天，但不自动请求
    expect(screen.getByTestId('web-sources-panel')).toBeInTheDocument()
    expect(screen.getByText('第 3 天 网页资料')).toBeInTheDocument()
    expect(searchCalls(fetchMock)).toHaveLength(1)

    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(2)
  })

  it('切天后迟到成功响应不落地；面板仍可再次显式查询', async () => {
    const user = userEvent.setup()
    let searchResponder: (init?: RequestInit) => Promise<Response> = (init) =>
      Promise.resolve(webSearchResponse(init))
    const fetchMock = stubAppFetch({ searchImpl: (init) => searchResponder(init) })
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    const deferred = deferredResponse()
    searchResponder = () => deferred.promise
    await openWebSources(user)
    typeQuery(QUERY)
    await searchOnce(user)
    expect(screen.getByTestId('web-sources-panel')).toHaveAttribute('aria-busy', 'true')

    await user.click(screen.getByRole('tab', { name: /D3/ }))
    await waitFor(() => expect(screen.queryByTestId('web-sources-result')).toBeNull())
    expect(screen.getByTestId('web-sources-panel')).not.toHaveAttribute('aria-busy')

    await act(async () => {
      deferred.resolve(jsonResponse(makeWebSearchReport({ requested_query: QUERY })))
      await flushAsyncQueue()
    })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(searchCalls(fetchMock)).toHaveLength(1)

    searchResponder = (init) => Promise.resolve(webSearchResponse(init))
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(2)
  })

  it('本地编辑打开：入口与面板卸载、迟到响应不落地；放弃草稿后重开是全新实例', async () => {
    const user = userEvent.setup()
    let searchResponder: (init?: RequestInit) => Promise<Response> = (init) =>
      Promise.resolve(webSearchResponse(init))
    const fetchMock = stubAppFetch({ searchImpl: (init) => searchResponder(init) })
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    const deferred = deferredResponse()
    searchResponder = () => deferred.promise
    await openWebSources(user)
    typeQuery(QUERY)
    await searchOnce(user)
    expect(screen.getByTestId('web-sources-panel')).toHaveAttribute('aria-busy', 'true')

    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    await waitFor(() => expect(screen.queryByTestId('web-sources-entry')).toBeNull())
    expect(screen.queryByTestId('web-sources-panel')).toBeNull()

    await act(async () => {
      deferred.resolve(jsonResponse(makeWebSearchReport({ requested_query: QUERY })))
      await flushAsyncQueue()
    })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(searchCalls(fetchMock)).toHaveLength(1)

    // 放弃草稿回到原视图：重新打开是全新实例——空输入、无旧结果、不重发
    await user.click(screen.getByRole('button', { name: '放弃草稿' }))
    // 草稿未修改：无需确认即关闭草稿状态，网页资料入口随编辑结束重新挂载
    await waitFor(() => expect(screen.getByTestId('web-sources-entry')).toBeInTheDocument())
    await openWebSources(user)
    expect(screen.getByLabelText('网页搜索内容')).toHaveValue('')
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(searchCalls(fetchMock)).toHaveLength(1)
  })

  it('AI / 地图面板打开时入口与面板卸载且零请求；关闭后入口恢复', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await openWebSources(user)
    await user.click(screen.getByRole('button', { name: 'AI 调整这一天' }))
    await waitFor(() => expect(screen.queryByTestId('web-sources-entry')).toBeNull())
    expect(screen.queryByTestId('web-sources-panel')).toBeNull()
    await user.click(screen.getByRole('button', { name: '收起' }))
    await waitFor(() => expect(screen.getByTestId('web-sources-entry')).toBeInTheDocument())

    await openWebSources(user)
    await user.click(screen.getByRole('button', { name: '仅刷新地图' }))
    await waitFor(() => expect(screen.queryByTestId('web-sources-entry')).toBeNull())
    expect(screen.queryByTestId('web-sources-panel')).toBeNull()
    await user.click(screen.getByRole('button', { name: '收起' }))
    await waitFor(() => expect(screen.getByTestId('web-sources-entry')).toBeInTheDocument())

    expect(searchCalls(fetchMock)).toHaveLength(0)
  })

  it('导入文件打开行程：迟到响应不落地、来源说明切到导入、零自动请求', async () => {
    const user = userEvent.setup()
    let searchResponder: (init?: RequestInit) => Promise<Response> = (init) =>
      Promise.resolve(webSearchResponse(init))
    const fetchMock = stubAppFetch({ searchImpl: (init) => searchResponder(init) })
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    const deferred = deferredResponse()
    searchResponder = () => deferred.promise
    await openWebSources(user)
    typeQuery(QUERY)
    await searchOnce(user)
    expect(screen.getByTestId('web-sources-panel')).toHaveAttribute('aria-busy', 'true')

    await user.click(screen.getByRole('button', { name: '行程备份与导入' }))
    fireEvent.change(screen.getByLabelText(/选择备份文件/), { target: { files: [backupFileOf(IMPORTED_TRIP)] } })
    await screen.findByText('预览：西安古城两日行')
    await user.click(screen.getByRole('button', { name: '打开这份行程' }))
    await screen.findByRole('heading', { name: '西安古城两日行' })

    // 面板保持但归属已换：旧结果隐藏，来源说明为导入文件，迟到响应不落地
    expect(screen.getByTestId('web-sources-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(screen.getByText(/当前行程来自导入文件/)).toBeInTheDocument()
    await act(async () => {
      deferred.resolve(jsonResponse(makeWebSearchReport({ requested_query: QUERY })))
      await flushAsyncQueue()
    })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(searchCalls(fetchMock)).toHaveLength(1)
  })

  it('恢复已保存行程：面板归属失效、旧结果消失、零自动请求', async () => {
    saveTripToStorage(PLAN_TRIP)
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await openWebSources(user)
    typeQuery(QUERY)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /已保存行程/ }))
    await user.click(screen.getByRole('button', { name: /恢复保存的行程/ }))
    await screen.findByRole('heading', { name: '南京两日规划行' })
    await waitFor(() => expect(screen.queryByTestId('web-sources-result')).toBeNull())
    expect(screen.getByTestId('web-sources-panel')).toBeInTheDocument()
    expect(searchCalls(fetchMock)).toHaveLength(1)
  })

  it('会话恢复（旧记录无来源标记）：恢复后 openedFromFile 三态 null 原值透传、旧结果失效', async () => {
    window.localStorage.setItem(
      SESSION_RESUME_DATA_KEY,
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 1_800_000_000_000,
        session: {
          trip: PLAN_TRIP,
          draft: null,
          budget: null,
          // 旧记录没有 openedFromFile 字段
          ui: { activeDay: 1, draftMode: 'walking' },
        },
      }),
    )
    setSessionResumeFlag(window.localStorage, true)
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await openWebSources(user)
    expect(screen.getByText(/当前行程来自应用内规划或本地编辑/)).toBeInTheDocument()
    typeQuery(QUERY)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '恢复上次的工作进度' }))
    await screen.findByRole('heading', { name: '南京两日规划行' })
    await waitFor(() => expect(screen.queryByTestId('web-sources-result')).toBeNull())
    expect(screen.getByTestId('web-sources-panel')).toBeInTheDocument()
    // null 原值透传：不能降级成 false 的「应用内规划」说明
    expect(screen.getByText(/没有来源标记/)).toBeInTheDocument()
    expect(searchCalls(fetchMock)).toHaveLength(1)
  })

  it('新规划成功替换行程：面板归属失效、旧结果消失、零自动请求', async () => {
    const planned: Trip = { ...MOCK_TRIP, id: 'trip-ws-plan-2', source: 'agent', title: '西安速览' }
    const user = userEvent.setup()
    const fetchMock = stubAppFetch({ plan: planned })
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await openWebSources(user)
    typeQuery(QUERY)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(1)

    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await screen.findByRole('heading', { name: '西安速览' })
    await waitFor(() => expect(screen.queryByTestId('web-sources-result')).toBeNull())
    expect(screen.getByTestId('web-sources-panel')).toBeInTheDocument()
    expect(searchCalls(fetchMock)).toHaveLength(1)
  })

  it('显式收起后键盘焦点回到「查网页资料」入口；编辑打开的隐式收起不抢焦点', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    // 显式收起：焦点回到入口按钮
    await openWebSources(user)
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByTestId('web-sources-entry')).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '查网页资料' }))

    // 隐式收起（打开本地编辑）不是用户在面板里的操作：不得调用 focus 抢走焦点
    await user.click(screen.getByRole('button', { name: '查网页资料' }))
    expect(screen.getByTestId('web-sources-panel')).toBeInTheDocument()
    const focusCalls: string[] = []
    const origFocus = HTMLElement.prototype.focus
    const patchedFocus = function (this: HTMLElement, o?: FocusOptions) {
      focusCalls.push(this.tagName)
      return origFocus.call(this, o)
    }
    HTMLElement.prototype.focus = patchedFocus
    try {
      await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
      await waitFor(() => expect(screen.queryByTestId('web-sources-entry')).toBeNull())
    } finally {
      HTMLElement.prototype.focus = origFocus
    }
    // 唯一的 BUTTON 调用来自 user-event 对被点按钮的指针语义聚焦，不是抢焦点逻辑
    expect(focusCalls).toEqual(['BUTTON'])
    expect(searchCalls(fetchMock)).toHaveLength(0)
  })

  it('显式关闭后重新打开：无旧结果、输入清空、不重发前次 query', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await openWebSources(user)
    typeQuery(QUERY)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.queryByTestId('web-sources-panel')).toBeNull()
    await openWebSources(user)
    expect(screen.getByLabelText('网页搜索内容')).toHaveValue('')
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(searchCalls(fetchMock)).toHaveLength(1)

    // 输入仍为空：确认没有自动重发前次 query；再手动搜索才发新请求
    await flushAsyncQueue()
    expect(screen.getByLabelText('网页搜索内容')).toHaveValue('')
    typeQuery(QUERY)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(2)
  })

  it('搜索零存储写：预置本地保存逐字节原样、费用输入不变、无新增 localStorage 键', async () => {
    saveTripToStorage(MOCK_TRIP)
    const savedRawBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    expect(savedRawBefore).not.toBeNull()

    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    // 费用草稿：打开面板、加一行、填金额
    await user.click(screen.getByRole('button', { name: '费用估算' }))
    const budgetRegion = screen.getByRole('region', { name: /费用估算/ })
    await user.click(within(budgetRegion).getByRole('button', { name: '添加费用项' }))
    const amountInput = within(budgetRegion).getByLabelText('金额（元）')
    await user.type(amountInput, '66.60')

    // 网页资料：显式搜索成功
    await openWebSources(user)
    typeQuery(QUERY)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(searchCalls(fetchMock)).toHaveLength(1)

    // Trip、费用、本地保存全部原样；除了预置的保存键没有任何新键
    expect(screen.getByRole('heading', { name: '杭州三日漫步路书' })).toBeInTheDocument()
    expect(
      (screen.getByRole('region', { name: /费用估算/ }).querySelector('[data-testid="budget-row"]') ??
        screen.getByLabelText('金额（元）')) as HTMLElement,
    ).toBeInTheDocument()
    expect((screen.getByLabelText('金额（元）') as HTMLInputElement).value).toBe('66.60')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(savedRawBefore)
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBeNull()
    expect(window.localStorage.length).toBe(1)
  })
})

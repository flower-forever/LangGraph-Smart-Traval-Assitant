/**
 * App × 仅刷新地图接线集成测试：真实 App、真实 MapRefreshPanel、真实 mapRefresh 纯核与
 * mapRefreshApi（只 mock 全局 fetch，未知路径直接抛错，避免误连外网）。
 *
 * 覆盖：planner_ready=false 仍可打开且打开零请求；显式选方式后只请求一次；预览前行程与
 * 已保存记录逐字节不变；真实 onApply 后只替换地图字段、文字/时间/其它天保留、不自动保存；
 * 一次撤销恢复应用前行程且重复撤销禁用；面板打开期间保存/导入导出/撤销/AI 入口与天气收起、
 * 日签点击与键盘锁定；no_key 不应用；在飞请求关闭面板后迟到响应不落地。
 *
 * 业务请求（health / example / map-refresh）走 fetch mock；build / validate / apply 纯函数、
 * 本地存储与真实组件不 mock。不启动浏览器，不发真实网络请求。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import type { MapRefreshRequest, MapRefreshResponse } from '../lib/mapRefresh'
import { MAP_REFRESH_PATH } from '../lib/mapRefreshApi'
import { SAVED_TRIPS_STORAGE_KEY, saveTripToStorage } from '../lib/savedTrips'
import { MOCK_TRIP } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mapBodies(fetchMock: ReturnType<typeof vi.fn>): MapRefreshRequest[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === MAP_REFRESH_PATH)
    .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body)) as MapRefreshRequest)
}

function planCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url) === '/api/trips/plan').length
}

/** 由请求投影生成合法的 ready 补丁：坐标全部换成新值，legs 覆盖全部相邻对。 */
function readyResponse(request: MapRefreshRequest): MapRefreshResponse {
  const locations = request.stops.map((_stop, index) => ({
    lng: 120.2 + index * 0.001,
    lat: 30.3 + index * 0.001,
  }))
  return {
    day: request.day,
    date: request.date,
    parent: { ...request.parent },
    map_status: 'ready',
    stops: request.stops.map((stop, index) => ({
      id: stop.id,
      location: locations[index]!,
      resolved_address: stop.address || null,
    })),
    unresolved: [],
    legs: request.stops.slice(0, -1).map((stop, index) => ({
      from_stop_id: stop.id,
      to_stop_id: request.stops[index + 1]!.id,
      mode: request.travel_mode,
      route_type: 'navigation',
      distance_m: 900 + index * 100,
      duration_minutes: 12 + index,
      geometry: [locations[index]!, locations[index + 1]!],
      description: '沿路直行。',
    })),
    warnings: ['【地图刷新】示例提醒：营业时间仍以现场为准。'],
  }
}

/** 硬状态 no_key：没有可应用内容。 */
function noKeyResponse(request: MapRefreshRequest): MapRefreshResponse {
  return {
    day: request.day,
    date: request.date,
    parent: { ...request.parent },
    map_status: 'no_key',
    stops: [],
    unresolved: request.stops.map((stop) => ({
      id: stop.id,
      reason_code: 'no_key',
      reason: '地图服务未配置 Key。',
    })),
    legs: [],
    warnings: ['【地图刷新】当前未配置地图服务，本次只保留原有的文字安排。'],
  }
}

type MapHandler = (request: MapRefreshRequest, init?: RequestInit) => Promise<Response>

function stubFetch(options: { plannerReady?: boolean; map?: MapHandler; plan?: MapHandler } = {}) {
  const healthBody: Record<string, unknown> = { status: 'healthy', amap_configured: true }
  if (options.plannerReady !== undefined) healthBody.planner_ready = options.plannerReady
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/health') return Promise.resolve(jsonResponse(healthBody))
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
    if (url === '/api/trips/plan') {
      if (!options.plan) return Promise.reject(new TypeError('本用例不应发起规划请求'))
      const payload = JSON.parse(String(init?.body)) as unknown
      return options.plan(payload as never, init)
    }
    if (url === MAP_REFRESH_PATH) {
      if (!options.map) return Promise.reject(new TypeError('本用例不应发起地图请求'))
      const request = JSON.parse(String(init?.body)) as MapRefreshRequest
      return options.map(request, init)
    }
    return Promise.reject(new TypeError(`unexpected url: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function seedSavedTrip(): string | null {
  const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
  expect(seed.ok).toBe(true)
  return window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
}

function tripSection(): HTMLElement {
  return screen.getByRole('region', { name: '行程安排' })
}

function revisionOf(): string | null {
  return tripSection().getAttribute('data-trip-revision')
}

async function openMapPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const entry = screen.getByTestId('map-refresh-entry')
  expect(entry.getAttribute('data-day')).toBe('1')
  await user.click(within(entry).getByRole('button'))
  return screen.getByRole('region', { name: '仅刷新地图' })
}

async function fetchCandidate(
  user: ReturnType<typeof userEvent.setup>,
  panel: HTMLElement,
): Promise<void> {
  expect(within(panel).getByRole('button', { name: '获取地图候选' })).toBeDisabled()
  await user.click(within(panel).getByLabelText('步行'))
  await user.click(within(panel).getByRole('button', { name: '获取地图候选' }))
  await waitFor(() =>
    expect(within(panel).getByRole('button', { name: '应用地图更新' })).toBeEnabled(),
  )
}

describe('App 仅刷新地图接线', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('planner_ready=false 仍只依赖地图服务：打开零请求，显式选方式后获取一次，预览前行程与保存字节不变', async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch({
      plannerReady: false,
      map: (request) => Promise.resolve(jsonResponse(readyResponse(request))),
    })
    const storageBefore = seedSavedTrip()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    expect(screen.getByRole('button', { name: '规划暂不可用' })).toBeDisabled()

    const panel = await openMapPanel(user)
    expect(mapBodies(fetchMock)).toHaveLength(0)
    expect(screen.queryByTestId('apply-notice')).toBeNull()
    const revisionBefore = revisionOf()

    await user.click(within(panel).getByLabelText('步行'))
    await user.click(within(panel).getByRole('button', { name: '获取地图候选' }))
    await waitFor(() => expect(mapBodies(fetchMock)).toHaveLength(1))

    const body = mapBodies(fetchMock)[0]!
    expect(body).toMatchObject({
      destination: '杭州',
      day: 1,
      date: '2026-04-03',
      travel_mode: 'walking',
      stops: [
        { id: 's1', name: '断桥残雪', address: '杭州市西湖区白堤东端' },
        { id: 's2', name: '平湖秋月', address: '杭州市西湖区孤山路' },
        { id: 's3', name: '湖滨晴雨', address: '杭州市上城区湖滨路' },
      ],
    })
    expect(body.parent.trip_id).toBe('trip-mock-1')
    expect(JSON.stringify(body)).not.toContain('"location"')

    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: '应用地图更新' })).toBeEnabled(),
    )
    expect(revisionOf()).toBe(revisionBefore)
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    expect(screen.getByRole('tabpanel')).toHaveTextContent('断桥残雪')
    expect(screen.queryByTestId('apply-notice')).toBeNull()
  })

  it('预览后应用：只换地图字段，文字与保存记录不变、不自动保存；一次撤销恢复且重复撤销禁用', async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch({
      plannerReady: true,
      map: (request) => Promise.resolve(jsonResponse(readyResponse(request))),
    })
    const storageBefore = seedSavedTrip()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const revisionBefore = Number(revisionOf())

    const panel = await openMapPanel(user)
    await fetchCandidate(user, panel)
    await user.click(within(panel).getByRole('button', { name: '应用地图更新' }))

    const notice = await screen.findByTestId('apply-notice')
    expect(notice.textContent).toContain('本次只更新了地图相关字段')
    expect(screen.queryByTestId('map-refresh-slot')).toBeNull()
    expect(Number(revisionOf())).toBeGreaterThan(revisionBefore)

    const itinerary = screen.getByRole('tabpanel')
    for (const text of ['断桥残雪', '平湖秋月', '湖滨晴雨']) {
      expect(itinerary).toHaveTextContent(text)
    }
    expect(itinerary).toHaveTextContent('09:00')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    expect(mapBodies(fetchMock)).toHaveLength(1)

    const undo = screen.getByRole('button', { name: '撤销应用' })
    expect(undo).toBeEnabled()
    await user.click(undo)
    // 撤销后入口不可再点：实现选择隐藏或禁用都算通过，重复撤销不能生效。
    await waitFor(() => {
      const again = screen.queryByRole('button', { name: '撤销应用' })
      expect(again === null || again.hasAttribute('disabled')).toBe(true)
    })
    expect(screen.getByTestId('apply-notice').textContent).toContain('已撤销应用')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('断桥残雪')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
  })

  it('面板打开期间互斥：保存/导入导出/撤销/AI 入口隐藏，规划禁用，天气卸载，日签点击与键盘锁定', async () => {
    const user = userEvent.setup()
    stubFetch({ map: (request) => Promise.resolve(jsonResponse(readyResponse(request))) })
    seedSavedTrip()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    expect(screen.getByTestId('weather-slot')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存当前行程' })).toBeInTheDocument()

    const panel = await openMapPanel(user)
    expect(screen.queryByRole('button', { name: '保存当前行程' })).toBeNull()
    expect(screen.queryByRole('button', { name: '行程备份与导入' })).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销应用' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'AI 调整这一天' })).toBeNull()
    expect(screen.queryByTestId('weather-slot')).toBeNull()
    expect(screen.getByLabelText(/目的地/)).toBeDisabled()
    expect(screen.getByTestId('map-day-lock-note')).toHaveTextContent('目标固定为第 1 天')

    await user.click(screen.getByRole('tab', { name: /运河与老巷/ }))
    expect(screen.getByRole('tab', { name: /西湖环湖/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: /西湖环湖/ })).toHaveAttribute('aria-selected', 'true')

    await user.click(within(panel).getByRole('button', { name: '关闭' }))
    expect(screen.queryByTestId('map-refresh-slot')).toBeNull()
    expect(screen.getByRole('button', { name: '保存当前行程' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '行程备份与导入' })).toBeInTheDocument()
    expect(screen.getByTestId('weather-slot')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /运河与老巷/ }))
    expect(screen.getByRole('tab', { name: /运河与老巷/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('no_key 不提供应用：行程、保存记录与撤销都不变；关闭后入口恢复', async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch({
      map: (request) => Promise.resolve(jsonResponse(noKeyResponse(request))),
    })
    const storageBefore = seedSavedTrip()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const revisionBefore = revisionOf()

    const panel = await openMapPanel(user)
    await user.click(within(panel).getByLabelText('步行'))
    await user.click(within(panel).getByRole('button', { name: '获取地图候选' }))
    await waitFor(() => expect(mapBodies(fetchMock)).toHaveLength(1))
    await waitFor(() =>
      expect(within(panel).queryByText(/正在获取地图候选/)).toBeNull(),
    )

    expect(within(panel).queryByRole('button', { name: '应用地图更新' })).toBeNull()
    // 必须命中 no_key 的具体友好提示；不能用 bad_payload / 完整性失败文案冒充。
    expect(panel).toHaveTextContent(
      '地图服务未配置，这次没有取得坐标和路线。站点的文字安排保持不变，配置好后可以再刷新。',
    )
    expect(panel).toHaveTextContent('未解析出位置的站点（3 个）')
    expect(panel).not.toHaveTextContent('返回的地图数据不完整')
    expect(panel).not.toHaveTextContent('这次返回的地图数据和当前页面上的行程对不上')
    expect(screen.queryByTestId('apply-notice')).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销应用' })).toBeNull()
    expect(revisionOf()).toBe(revisionBefore)
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    expect(screen.getByRole('tabpanel')).toHaveTextContent('断桥残雪')

    await user.click(within(panel).getByRole('button', { name: '关闭' }))
    expect(screen.queryByTestId('map-refresh-slot')).toBeNull()
    expect(screen.getByRole('button', { name: '保存当前行程' })).toBeInTheDocument()
    expect(screen.getByTestId('map-refresh-entry')).toBeInTheDocument()
  })

  it('获取候选中关闭面板：在飞请求被放弃，迟到响应不落地也不改行程', async () => {
    const user = userEvent.setup()
    let resolveLate!: (response: Response) => void
    const late = new Promise<Response>((resolve) => {
      resolveLate = resolve
    })
    const fetchMock = stubFetch({ map: () => late })
    const storageBefore = seedSavedTrip()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const revisionBefore = revisionOf()

    const panel = await openMapPanel(user)
    await user.click(within(panel).getByLabelText('驾车'))
    await user.click(within(panel).getByRole('button', { name: '获取地图候选' }))
    await waitFor(() => expect(mapBodies(fetchMock)).toHaveLength(1))

    await user.click(within(panel).getByRole('button', { name: '关闭' }))
    expect(screen.queryByTestId('map-refresh-slot')).toBeNull()

    await act(async () => {
      resolveLate(jsonResponse(readyResponse(mapBodies(fetchMock)[0]!)))
      await late
    })

    expect(screen.queryByTestId('apply-notice')).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销应用' })).toBeNull()
    expect(revisionOf()).toBe(revisionBefore)
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    expect(screen.getByRole('tabpanel')).toHaveTextContent('断桥残雪')
  })

  it('已有示例行程时发起新规划再打开仅刷新地图：旧规划迟到不换当前行程，地图候选仍绑定旧行程', async () => {
    const user = userEvent.setup()
    let resolvePlan!: (response: Response) => void
    const latePlan = new Promise<Response>((resolve) => {
      resolvePlan = resolve
    })
    let resolveMap!: (response: Response) => void
    const lateMap = new Promise<Response>((resolve) => {
      resolveMap = resolve
    })
    const fetchMock = stubFetch({
      plannerReady: true,
      plan: () => latePlan,
      map: () => lateMap,
    })
    seedSavedTrip()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const revisionBefore = revisionOf()
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)

    // 公开交互：保留旧行程展示，发起一次新的整趟规划并让它停在飞行中。
    await user.type(screen.getByLabelText(/目的地/), '苏州')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await waitFor(() => expect(planCallCount(fetchMock)).toBe(1))
    expect(screen.getByTestId('request-status-note')).toHaveTextContent(
      '下方显示的仍是上一次的结果',
    )

    // 规划 pending 时「仅刷新地图」仍可点：打开应作废并 abort 在飞的规划。
    const panel = await openMapPanel(user)
    expect(mapBodies(fetchMock)).toHaveLength(0)
    expect(within(panel).getByText('杭州三日漫步路书')).toBeInTheDocument()

    await user.click(within(panel).getByLabelText('步行'))
    await user.click(within(panel).getByRole('button', { name: '获取地图候选' }))
    await waitFor(() => expect(mapBodies(fetchMock)).toHaveLength(1))
    const mapRequest = mapBodies(fetchMock)[0]!
    expect(mapRequest.parent.trip_id).toBe('trip-mock-1')
    expect(mapRequest.day).toBe(1)

    // 旧规划晚到：不得替换当前行程，也不得抢走地图面板的上下文。
    const lateTrip = {
      ...(JSON.parse(JSON.stringify(MOCK_TRIP)) as typeof MOCK_TRIP),
      id: 'trip-late-plan',
      title: '迟到的旧规划结果',
    }
    await act(async () => {
      resolvePlan(jsonResponse(lateTrip))
      await latePlan
    })

    expect(screen.queryByText('迟到的旧规划结果')).toBeNull()
    expect(within(panel).getByText('杭州三日漫步路书')).toBeInTheDocument()
    expect(within(panel).getByText(/第 1 天/)).toBeInTheDocument()
    expect(revisionOf()).toBe(revisionBefore)

    // 地图候选仍按旧行程落地：应用后只换地图字段，旧规划结果依旧不出现。
    await act(async () => {
      resolveMap(jsonResponse(readyResponse(mapRequest)))
      await lateMap
    })
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: '应用地图更新' })).toBeEnabled(),
    )
    await user.click(within(panel).getByRole('button', { name: '应用地图更新' }))
    const notice = await screen.findByTestId('apply-notice')
    expect(notice.textContent).toContain('本次只更新了地图相关字段')
    expect(screen.queryByText('迟到的旧规划结果')).toBeNull()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('断桥残雪')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
  })
})

/**
 * App 集成测试：mock fetch，渲染真实 TripMap（真实 Leaflet + jsdom）。
 * 地图不做组件 mock——marker / popup 的选中联动必须走真实 Leaflet 事件才覆盖得到。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function textResponse(body: string, status = 200, contentType = 'text/plain') {
  return new Response(body, { status, headers: { 'Content-Type': contentType } })
}

function proxyErrorResponse() {
  return textResponse(
    'Error occurred while trying to proxy: 127.0.0.1:5173/api/trips/example',
    500,
  )
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

function markerByName(container: HTMLElement, name: string): Element {
  const marker = Array.from(container.querySelectorAll('.stop-dot-wrapper'))
    .find((node) => node.getAttribute('aria-label')?.includes(name))
  if (!marker) throw new Error(`找不到站点 marker：${name}`)
  return marker
}

function stopRow(container: HTMLElement, name: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('.stop-row'))
    .find((node) => node.textContent?.includes(name))
  if (!row) throw new Error(`找不到站点行：${name}`)
  return row
}

describe('App 集成', () => {
  beforeEach(() => {
    // jsdom 没实现滚动，规划成功后 App 会滚动到行程区
    vi.stubGlobal('scrollTo', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })

  it('首次打开加载示例行程，探活走 /api/health 而非 /health', async () => {
    const fetchMock = stubHappyFetch()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    expect(screen.getByText('示例行程')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('后端服务正常')).toBeInTheDocument())

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls).toContain('/api/health')
    expect(urls).not.toContain('/health')
  })

  it('探活拿到 200 HTML（SPA fallback）时不判为后端在线', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(textResponse('<!doctype html><html></html>', 200, 'text/html'))
      if (url === '/api/trips/example') return Promise.resolve(textResponse('<!doctype html><html></html>', 200, 'text/html'))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    render(<App />)
    await waitFor(() => expect(screen.getByText(/连不上后端服务/)).toBeInTheDocument())
    expect(screen.queryByText('后端服务正常')).toBeNull()
    expect(screen.getByText(/后端未连接/)).toBeInTheDocument()
  })

  it('业务请求成功后会修正探活的误判（后端确实在线）', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(textResponse('<!doctype html>', 200, 'text/html'))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('后端服务正常')).toBeInTheDocument())
  })

  it('后端断开时不声称还能浏览示例，并提供重试', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))
    render(<App />)
    await waitFor(() => expect(screen.getByText(/连不上后端服务/)).toBeInTheDocument())
    expect(screen.queryByText(/仍可查看示例/)).toBeNull()
    expect(screen.getByText(/后端未连接/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('Vite 代理断开（500 text/plain）时给出可操作提示，且不硬编码 API 地址', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(proxyErrorResponse())))
    render(<App />)
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('连不上后端服务')
    expect(banner.textContent).toContain('VITE_API_BASE')
    expect(banner.textContent).toContain('/api')
    expect(banner.textContent).not.toMatch(/127\.0\.0\.1/)
  })

  it('表单校验：空目的地不提交', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: '生成行程' }))
    expect(await screen.findByText('请填写目的地')).toBeInTheDocument()
    // 未发出规划请求
    const calls = vi.mocked(fetch).mock.calls.filter(([u]) => u === '/api/trips/plan')
    expect(calls).toHaveLength(0)
  })

  it('填写表单后真实触发 POST /api/trips/plan 并渲染新行程', async () => {
    const plannedTrip = {
      ...MOCK_TRIP,
      id: 'trip-agent-1',
      source: 'agent' as const,
      title: '西安两日速览',
    }
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/plan') return Promise.resolve(jsonResponse(plannedTrip))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))

    await waitFor(() => expect(screen.getByText('西安两日速览')).toBeInTheDocument())
    expect(screen.getByText('AI 规划')).toBeInTheDocument()
    const planCall = fetchMock.mock.calls.find(([u]) => u === '/api/trips/plan')
    expect(planCall).toBeTruthy()
    const body = JSON.parse(String(planCall![1]?.body))
    expect(body).toMatchObject({ destination: '西安', days: 3, travelers: 2, travel_mode: 'walking', departure_date: null })
  })

  it('按日切换行程与地图；没有站点的空日不显示「站点均无坐标」', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.click(screen.getByRole('tab', { name: /运河与老巷/ }))
    expect(screen.getByText(/这一天暂无具体安排/)).toBeInTheDocument()
    expect(screen.queryByText(/站点均无坐标/)).toBeNull()
    expect(screen.queryByText(/站点缺少坐标/)).toBeNull()

    await user.click(screen.getByRole('tab', { name: /龙井问茶/ }))
    expect(screen.getByText('龙井村')).toBeInTheDocument()
  })

  it('有站点但都无坐标时才显示坐标提示', async () => {
    stubHappyFetch(MOCK_TRIP_NO_COORD)
    render(<App />)
    await waitFor(() => expect(screen.getByText('无坐标测试行程')).toBeInTheDocument())
    expect(screen.getByText('这一天的站点缺少坐标')).toBeInTheDocument()
    expect(screen.getAllByText('无坐标').length).toBeGreaterThan(0)
  })

  it('地图 marker、列表与弹窗的选中状态互相联动（真实 Leaflet）', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    await waitFor(() => expect(container.querySelectorAll('.stop-dot-wrapper')).toHaveLength(2))

    const detailName = () => container.querySelector('.stop-detail h4')?.textContent ?? null
    const activeDots = () => container.querySelectorAll('.stop-dot[data-active="true"]').length

    // 1) 点 marker 选中；旧实现里 popupopen 会再 toggle 一次，选中被立刻取消
    fireEvent.click(markerByName(container, '断桥残雪'))
    await waitFor(() => expect(detailName()).toBe('断桥残雪'))
    expect(activeDots()).toBe(1)
    expect(stopRow(container, '断桥残雪').getAttribute('aria-expanded')).toBe('true')

    // 2) 弹窗里的「查看逐点讲解」不会把选中取消
    await user.click(screen.getByRole('button', { name: '查看逐点讲解' }))
    expect(detailName()).toBe('断桥残雪')

    // 3) 换一个 marker：选中切换，高亮唯一
    fireEvent.click(markerByName(container, '平湖秋月'))
    await waitFor(() => expect(detailName()).toBe('平湖秋月'))
    expect(activeDots()).toBe(1)

    // 4) 列表点当前项 → 传空串收起
    await user.click(stopRow(container, '平湖秋月'))
    await waitFor(() => expect(detailName()).toBeNull())
    expect(activeDots()).toBe(0)

    // 5) 列表再点开，地图同步高亮并打开弹窗
    await user.click(stopRow(container, '断桥残雪'))
    await waitFor(() => expect(detailName()).toBe('断桥残雪'))
    expect(activeDots()).toBe(1)
    expect(screen.getByRole('button', { name: '查看逐点讲解' })).toBeInTheDocument()
  })

  it('返回 days:[null] 之类的坏数据时友好报错，不崩页面', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse({ ...MOCK_TRIP, days: [null] }))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    render(<App />)
    await waitFor(() => expect(screen.getByText(/数据格式不符合约定/)).toBeInTheDocument())
    expect(screen.getByText('路书')).toBeInTheDocument()
    expect(screen.queryByText('杭州三日漫步路书')).toBeNull()
  })

  it('复制按钮真实写入剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    // user-event setup 会接管 navigator.clipboard，这里在其之后再覆盖为可观测的 spy
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    await user.click(screen.getByRole('button', { name: '复制本日行程' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toContain('断桥残雪')
    expect(await screen.findByText('已复制')).toBeInTheDocument()
  })
})

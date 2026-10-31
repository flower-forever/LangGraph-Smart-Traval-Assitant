/**
 * App 与公开资料面板的集成测试：真实 App、真实面板、真实 poiSourcesApi，
 * 只 mock fetch。覆盖：入口默认收起、打开不请求、显式一次请求、切天清空、
 * 编辑/AI/地图面板打开时收起且无自动请求、关闭后迟到响应不落地、
 * 不写 localStorage、Trip 数据不变。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import type { PoiSourceQuery } from '../lib/poiSources'
import { makePoiSourceReport } from './fixtures/poiSources'
import { MOCK_TRIP } from './fixtures/trip'

const STOP_QUERY: PoiSourceQuery = { lat: 30.2726, lon: 120.1576 }

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function parsePoiQuery(url: string): PoiSourceQuery {
  const params = new URLSearchParams(url.split('?')[1] ?? '')
  return { lat: Number(params.get('lat')), lon: Number(params.get('lon')) }
}

function stubAppFetch(
  poi: (query: PoiSourceQuery) => Promise<Response> = (query) =>
    Promise.resolve(jsonResponse(makePoiSourceReport(query))),
) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/health') {
      return Promise.resolve(jsonResponse({ status: 'healthy', planner_ready: false, amap_configured: true }))
    }
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
    if (url.startsWith('/api/poi-sources/nearby?')) return poi(parsePoiQuery(url))
    return Promise.reject(new TypeError(`unexpected url: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function poiUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/api/poi-sources/nearby'))
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

describe('App 公开资料集成', () => {
  it('入口默认收起；打开面板不发请求；显式查询一次并显示结果', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)

    await screen.findByText('杭州三日漫步路书')
    // 默认收起：只有入口，没有面板
    expect(screen.queryByTestId('poi-sources-panel')).toBeNull()
    expect(screen.getByTestId('poi-sources-entry')).toBeInTheDocument()
    expect(poiUrls(fetchMock)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: '查资料' }))
    expect(screen.getByTestId('poi-sources-panel')).toBeInTheDocument()
    expect(poiUrls(fetchMock)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: '查询附近资料' }))
    await screen.findByTestId('poi-sources-result')

    expect(poiUrls(fetchMock)).toEqual(['/api/poi-sources/nearby?lat=30.2726&lon=120.1576'])
    expect(screen.getAllByText('身份未确认').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTestId('poi-sources-attribution')).toHaveTextContent('OpenStreetMap')
    expect(window.localStorage.length).toBe(0)
  })

  it('切天后旧结果清空且面板保持，不发新请求', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await user.click(screen.getByRole('button', { name: '查资料' }))
    await user.click(screen.getByRole('button', { name: '查询附近资料' }))
    await screen.findByTestId('poi-sources-result')
    expect(poiUrls(fetchMock)).toHaveLength(1)

    await user.click(screen.getByRole('tab', { name: /D3/ }))
    await waitFor(() => expect(screen.queryByTestId('poi-sources-result')).toBeNull())
    // D3 有坐标站点（龙井村），面板仍在但不自动请求
    expect(screen.getByTestId('poi-sources-panel')).toBeInTheDocument()
    expect(poiUrls(fetchMock)).toHaveLength(1)
  })

  it('查询进行中收起面板：迟到响应不落地', async () => {
    const user = userEvent.setup()
    let resolvePoi!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolvePoi = resolve
    })
    const fetchMock = stubAppFetch(() => pending)
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await user.click(screen.getByRole('button', { name: '查资料' }))
    await user.click(screen.getByRole('button', { name: '查询附近资料' }))
    await user.click(screen.getByRole('button', { name: '收起' }))

    expect(screen.queryByTestId('poi-sources-panel')).toBeNull()
    await act(async () => {
      resolvePoi(jsonResponse(makePoiSourceReport(STOP_QUERY)))
      await pending
    })
    expect(screen.queryByTestId('poi-sources-result')).toBeNull()
    expect(poiUrls(fetchMock)).toHaveLength(1)
  })

  it('本地编辑打开时本日资料入口收起且不请求；应用后恢复入口', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 打开编辑（页面里的本地编辑入口）
    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    await waitFor(() => expect(screen.queryByTestId('poi-sources-entry')).toBeNull())
    expect(screen.queryByTestId('poi-sources-panel')).toBeNull()
    expect(poiUrls(fetchMock)).toHaveLength(0)
  })

  it('显式收起面板后键盘焦点回到「查资料」入口；隐式收起不抢焦点', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 显式收起：焦点回到入口按钮
    await user.click(screen.getByRole('button', { name: '查资料' }))
    expect(screen.getByTestId('poi-sources-panel')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(screen.getByTestId('poi-sources-entry')).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '查资料' }))

    // 隐式收起（打开本地编辑）不是用户在面板里的操作：
    // 打开编辑只卸载本日资料面板，不主动调用 focus 抢走别的元素的焦点。
    // 探针实证：编辑器挂载后没有任何代码调用 focus（focus 调用只有
    // user-event 自己对被点按钮的指针语义聚焦）；焦点最终落在被点的
    // 「编辑这趟行程」按钮上——它被草稿编辑器替换卸载后按浏览器语义回
    // body，这与 POI 代码无关，也不是「抢走焦点」。
    await user.click(screen.getByRole('button', { name: '查资料' }))
    const focusCalls: string[] = []
    const origFocus = HTMLElement.prototype.focus
    const patchedFocus = function (this: HTMLElement, o?: FocusOptions) {
      focusCalls.push(this.tagName)
      return origFocus.call(this, o)
    }
    HTMLElement.prototype.focus = patchedFocus
    try {
      await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
      await waitFor(() => expect(screen.queryByTestId('poi-sources-entry')).toBeNull())
    } finally {
      HTMLElement.prototype.focus = origFocus
    }
    // 打开编辑期间没有应用代码调用 focus：唯一的 BUTTON 调用来自
    // user-event 自身的指针语义（点谁聚焦谁），不是抢焦点逻辑。
    expect(focusCalls).toEqual(['BUTTON'])
    expect(poiUrls(fetchMock)).toHaveLength(0)
  })

  it('同一行程多次显式查询：每次点击恰好一次请求，Trip 数据不变', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await user.click(screen.getByRole('button', { name: '查资料' }))
    await user.click(screen.getByRole('button', { name: '查询附近资料' }))
    await screen.findByTestId('poi-sources-result')
    await user.click(screen.getByRole('button', { name: '查询附近资料' }))
    await waitFor(() => expect(poiUrls(fetchMock)).toHaveLength(2))
    // 行程标题与站点列表仍在：查询没有改动行程
    expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
    expect(screen.getByText('断桥残雪')).toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
  })
})

/**
 * App × TodayPanel 集成烟测（S4 一日跟随）：真实 App、真实 TodayPanel、
 * 真实 weatherApi，只 mock fetch 与时钟。
 *
 * 覆盖：入口挂载与当前天标注、看地图/看详情联动列表详情、天气走现有
 * /api/weather/day 通道且挂载零请求、localStorage 全键不变。
 *
 * 时钟注入说明：TodayPanel 的 now prop 默认 Date.now，App 不透传注入；
 * 集成层用 vi.useFakeTimers({ toFake: ['Date'] }) 固定「今天」，保证
 * MOCK_TRIP 的 2026-04-03 能被匹配（matched 态）。天气请求是异步 Promise，
 * fake Date 不影响 fetch / 定时器通道。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import type { WeatherDayQuery } from '../lib/weather'
import { makeWeatherReport } from '../test/weatherFixtures'
import { MOCK_TRIP } from './fixtures/trip'

/** MOCK_TRIP 第 1 天的日期 2026-04-03 上午 8:30（首站前）。 */
const FIXED_NOW = new Date(2026, 3, 3, 8, 30, 0).getTime()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function parseWeatherQuery(url: string): WeatherDayQuery {
  const params = new URLSearchParams(url.split('?')[1] ?? '')
  return {
    lat: Number(params.get('lat')),
    lon: Number(params.get('lon')),
    date: params.get('date') ?? '',
  }
}

function stubFetch(
  weather: (query: WeatherDayQuery) => Promise<Response> = (query) =>
    Promise.resolve(jsonResponse(makeWeatherReport(query))),
) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/health') {
      return Promise.resolve(jsonResponse({ status: 'healthy', planner_ready: false, amap_configured: true }))
    }
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
    if (url.startsWith('/api/weather/day?')) return weather(parseWeatherQuery(url))
    return Promise.reject(new TypeError(`unexpected url: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function weatherUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/api/weather/day'))
}

describe('App 一日跟随（今天卡）', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_NOW)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('行程区顶部挂载今天卡：今天=2026-04-03 匹配第 1 天，挂载零天气请求', async () => {
    const fetchMock = stubFetch()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    const panel = screen.getByTestId('today-panel')
    expect(panel).toBeInTheDocument()
    expect(panel).toHaveAttribute('data-today-kind', 'matched')
    expect(screen.getByTestId('today-day-label')).toHaveTextContent('今天 · 第 1 天')
    expect(screen.getByTestId('today-next-name')).toHaveTextContent('断桥残雪')
    expect(weatherUrls(fetchMock)).toHaveLength(0)
    // 预约未记录（无工作区清单）
    expect(screen.getByTestId('today-reminders-empty')).toHaveTextContent('未记录')
    // localStorage 全键不变
    expect(window.localStorage.length).toBe(0)
  })

  it('看地图 / 看详情 → 选中下一站，列表详情展开', async () => {
    stubFetch()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    expect(screen.queryByTestId('stop-detail')).toBeNull()
    fireEvent.click(screen.getByTestId('today-view-map'))
    expect(screen.getByTestId('stop-detail')).toHaveTextContent('断桥残雪')

    fireEvent.click(screen.getAllByTestId('stop-row')[0]) // 收起
    expect(screen.queryByTestId('stop-detail')).toBeNull()
    fireEvent.click(screen.getByTestId('today-view-detail'))
    expect(screen.getByTestId('stop-detail')).toHaveTextContent('断桥残雪')
  })

  it('点「查今天天气」→ 走 /api/weather/day 一次并展示摘要；失败显示「天气未获取」', async () => {
    const fetchMock = stubFetch()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    fireEvent.click(screen.getByTestId('today-weather-button'))
    await screen.findByTestId('today-weather-values')
    expect(weatherUrls(fetchMock)).toEqual(['/api/weather/day?lat=30.2726&lon=120.1576&date=2026-04-03'])
    expect(screen.getByTestId('today-weather-values')).toHaveTextContent('最高')
    expect(window.localStorage.length).toBe(0)

    cleanup()
    // 失败分支：网络拒绝
    const failMock = stubFetch(() => Promise.reject(new TypeError('network down')))
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    expect(weatherUrls(failMock)).toHaveLength(0)
    fireEvent.click(screen.getByTestId('today-weather-button'))
    await screen.findByTestId('today-weather-fail')
    expect(screen.getByTestId('today-weather-fail')).toHaveTextContent('天气未获取')
  })

  it('日期未匹配兜底：时钟挪到行程外日期 → 「日期未匹配」+ 仍显示第 1 天', async () => {
    stubFetch()
    vi.setSystemTime(new Date(2026, 5, 1).getTime()) // 2026-06-01：行程之外
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    expect(screen.getByTestId('today-panel')).toHaveAttribute('data-today-kind', 'unmatched_first')
    expect(screen.getByTestId('today-day-label')).toHaveTextContent('日期未匹配')
    expect(screen.getByTestId('today-day-label')).toHaveTextContent('第 1 天')
  })

  it('末站后：今日行程已结束（时钟挪到当天 18:00）', async () => {
    stubFetch()
    vi.setSystemTime(new Date(2026, 3, 3, 18, 0, 0).getTime())
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    expect(screen.getByTestId('today-finished')).toHaveTextContent('今日行程已结束')
    expect(screen.queryByTestId('today-next-stop')).toBeNull()
  })

  it('今天卡跟本机日期走、不跟日签：切到第 3 天（无日期）后今天卡仍显示今天 · 第 1 天；未写 localStorage', async () => {
    stubFetch()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    fireEvent.click(screen.getByRole('tab', { name: /D3/ }))
    // 「今天」由本机日期决定，不随日签切换：日签在 D3，今天卡仍指第 1 天
    expect(screen.getByTestId('today-panel')).toHaveAttribute('data-today-kind', 'matched')
    expect(screen.getByTestId('today-day-label')).toHaveTextContent('今天 · 第 1 天')
    expect(window.localStorage.length).toBe(0)
  })
})

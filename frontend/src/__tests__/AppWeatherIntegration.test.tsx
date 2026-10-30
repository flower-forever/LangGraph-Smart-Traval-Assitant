/**
 * App 与天气面板的集成烟测：真实 App、真实面板、真实 weatherApi，只 mock fetch。
 * 覆盖：打开不请求、显式一次请求、坐标来自当天记录、planner 不可用仍可查天气、
 * 切天后旧结果清空、关闭面板后迟到响应不落地、不写 localStorage。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import type { WeatherDayQuery } from '../lib/weather'
import { makeWeatherReport } from '../test/weatherFixtures'
import { MOCK_TRIP } from './fixtures/trip'

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

function stubWeatherFetch(
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

describe('App 天气集成', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('planner 不可用时仍可打开并查询天气；坐标取当天记录；只请求一次', async () => {
    const user = userEvent.setup()
    const fetchMock = stubWeatherFetch()
    render(<App />)

    await screen.findByText('杭州三日漫步路书')
    expect(screen.getByRole('button', { name: '规划暂不可用' })).toBeDisabled()
    expect(weatherUrls(fetchMock)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: '查天气' }))
    expect(screen.getByTestId('weather-panel')).toBeInTheDocument()
    expect(weatherUrls(fetchMock)).toHaveLength(0)
    expect(screen.getByLabelText('查询日期')).toHaveValue('2026-04-03')

    await user.click(screen.getByRole('button', { name: '查询天气' }))
    await screen.findByTestId('weather-values')

    expect(weatherUrls(fetchMock)).toEqual([
      '/api/weather/day?lat=30.2726&lon=120.1576&date=2026-04-03',
    ])
    expect(screen.getByText('本次获取时间')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Weather data by Open-Meteo.com' })).toBeVisible()
    expect(screen.getByRole('button', { name: '规划暂不可用' })).toBeDisabled()
    expect(window.localStorage.length).toBe(0)
  })

  it('切到没有日期的天：旧天气立即消失，日期留空并要求重选', async () => {
    const user = userEvent.setup()
    const fetchMock = stubWeatherFetch()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await user.click(screen.getByRole('button', { name: '查天气' }))
    await user.click(screen.getByRole('button', { name: '查询天气' }))
    await screen.findByTestId('weather-values')

    await user.click(screen.getByRole('tab', { name: /D3/ }))
    await waitFor(() => expect(screen.queryByTestId('weather-values')).toBeNull())
    expect(screen.getByLabelText('查询日期')).toHaveValue('')
    expect(screen.getByRole('button', { name: '查询天气' })).toBeDisabled()
    expect(weatherUrls(fetchMock)).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('查询日期'), { target: { value: '2026-04-05' } })
    await user.click(screen.getByRole('button', { name: '查询天气' }))
    await screen.findByTestId('weather-values')
    expect(weatherUrls(fetchMock)[1]).toBe(
      '/api/weather/day?lat=30.2226&lon=120.1131&date=2026-04-05',
    )
  })

  it('查询进行中收起面板：迟到响应不落地，也不留错误提示', async () => {
    const user = userEvent.setup()
    let resolveWeather!: (response: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveWeather = resolve
    })
    const fetchMock = stubWeatherFetch(() => pending)
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await user.click(screen.getByRole('button', { name: '查天气' }))
    await user.click(screen.getByRole('button', { name: '查询天气' }))
    await user.click(screen.getByRole('button', { name: '收起' }))

    expect(screen.queryByTestId('weather-panel')).toBeNull()
    await act(async () => {
      resolveWeather(jsonResponse(makeWeatherReport({ lat: 30.2726, lon: 120.1576, date: '2026-04-03' })))
      await pending
    })
    expect(screen.queryByTestId('weather-values')).toBeNull()
    expect(weatherUrls(fetchMock)).toHaveLength(1)
  })
})

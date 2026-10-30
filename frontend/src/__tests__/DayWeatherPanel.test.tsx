/**
 * DayWeatherPanel 用户路径测试：受控 React harness + 真实校验/展示逻辑。
 * 请求 adapter 全部 mock，不调用真实天气服务。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { ApiError } from '../lib/api'
import type { Trip, TripDay } from '../lib/api'
import type { WeatherDayQuery, WeatherDayReport } from '../lib/weather'
import DayWeatherPanel from '../components/DayWeatherPanel'
import type { WeatherAdapter } from '../lib/weatherApi'
import {
  CHECKED_AT,
  FETCHED_AT,
  makeCoverage,
  makeForecast,
  makeWeatherReport,
  makeWeatherTrip,
} from '../test/weatherFixtures'

const QUERY: WeatherDayQuery = { lat: 31.33, lon: 120.57, date: '2026-05-01' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type MockWeatherAdapter = Mock<WeatherAdapter>

function adapterMock(
  impl?: (query: WeatherDayQuery, options?: { signal?: AbortSignal }) => Promise<WeatherDayReport>,
): MockWeatherAdapter {
  return vi.fn<WeatherAdapter>(impl ?? ((query) => Promise.resolve(makeWeatherReport(query))))
}

interface RenderOptions {
  trip?: Trip
  day?: TripDay | null
  revision?: number
  openedFromFile?: boolean
  requestWeather?: WeatherAdapter
  onClose?: () => void
}

function renderPanel(options: RenderOptions = {}) {
  const trip = options.trip ?? makeWeatherTrip()
  const day = options.day === undefined ? trip.days[0] : options.day
  const requestWeather = (options.requestWeather ?? adapterMock()) as MockWeatherAdapter
  const onClose = options.onClose ?? vi.fn()
  const view = render(
    <DayWeatherPanel
      trip={trip}
      day={day}
      revision={options.revision ?? 1}
      openedFromFile={options.openedFromFile}
      requestWeather={requestWeather}
      onClose={onClose}
    />,
  )
  return { ...view, trip, day, requestWeather, onClose }
}

async function queryOnce(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '查询天气' }))
}

function valuesRegion() {
  return screen.getByTestId('weather-values')
}

function metricText(field: string): string {
  const metric = valuesRegion().querySelector<HTMLElement>(`[data-field="${field}"]`)
  if (!metric) throw new Error(`找不到指标 ${field}`)
  return metric.querySelector('dd')?.textContent ?? ''
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('初始状态与受控控件', () => {
  it('挂载不发请求；日期与站点取本日记录初值；署名链接可见', () => {
    const { requestWeather } = renderPanel()
    expect(requestWeather).not.toHaveBeenCalled()
    expect(screen.getByLabelText('查询日期')).toHaveValue('2026-05-01')
    expect(screen.getByLabelText('按哪条记录坐标查询')).toHaveValue('w1')
    expect(screen.getByTestId('weather-attribution')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Weather data by Open-Meteo.com' })).toHaveAttribute(
      'href',
      'https://open-meteo.com/',
    )
    expect(screen.getByText(/按行程记录坐标查询/)).toBeInTheDocument()
    expect(screen.queryByTestId('weather-result')).toBeNull()
  })

  it('day.date 缺失时日期留空并要求用户选择，而不是默认今天', async () => {
    const user = userEvent.setup()
    const trip = makeWeatherTrip()
    const { requestWeather } = renderPanel({ trip, day: trip.days[1] })

    const dateInput = screen.getByLabelText('查询日期')
    expect(dateInput).toHaveValue('')
    expect(screen.getByText(/请选择要查询的日期/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查询天气' })).toBeDisabled()
    expect(requestWeather).not.toHaveBeenCalled()

    fireEvent.change(dateInput, { target: { value: '2026-05-02' } })
    expect(screen.getByRole('button', { name: '查询天气' })).toBeEnabled()

    await queryOnce(user)
    expect(requestWeather).toHaveBeenCalledTimes(1)
    expect(requestWeather.mock.calls[0][0]).toEqual({ lat: 0, lon: 0, date: '2026-05-02' })
  })

  it('本日没有坐标站点时说明原因并禁用查询，不发请求', () => {
    const trip = makeWeatherTrip()
    const { requestWeather } = renderPanel({ trip, day: trip.days[3] })
    expect(screen.getByText(/本日没有带 WGS84 坐标的站点记录/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查询天气' })).toBeDisabled()
    expect(screen.getByText('本日没有可用坐标，查询已禁用。')).toBeInTheDocument()
    expect(requestWeather).not.toHaveBeenCalled()
  })

  it('示例行程与导入文件各自显示坐标来源标识', () => {
    const { unmount } = renderPanel()
    expect(screen.getByText('示例位置')).toBeInTheDocument()
    unmount()

    renderPanel({ openedFromFile: true })
    expect(screen.getByText('导入文件记录')).toBeInTheDocument()
  })
})

describe('显式查询与坐标来源', () => {
  it('点击一次只请求一次，使用所选站点记录坐标；0 与负坐标原样传入', async () => {
    const user = userEvent.setup()
    const trip = makeWeatherTrip()

    const first = renderPanel({ trip })
    await queryOnce(user)
    expect(first.requestWeather).toHaveBeenCalledTimes(1)
    expect(first.requestWeather.mock.calls[0][0]).toEqual(QUERY)
    first.unmount()

    const second = renderPanel({ trip, day: trip.days[2] })
    fireEvent.change(screen.getByLabelText('查询日期'), { target: { value: '2026-05-03' } })
    await queryOnce(user)
    expect(second.requestWeather).toHaveBeenCalledTimes(1)
    expect(second.requestWeather.mock.calls[0][0]).toEqual({
      lat: -33.86,
      lon: 151.21,
      date: '2026-05-03',
    })
  })

  it('切换站点后按新记录坐标查询', async () => {
    const user = userEvent.setup()
    const { requestWeather } = renderPanel()
    await user.selectOptions(screen.getByLabelText('按哪条记录坐标查询'), 'w1b')
    await queryOnce(user)
    expect(requestWeather.mock.calls[0][0]).toEqual({ lat: 31.31, lon: 120.56, date: '2026-05-01' })
  })
})

describe('结果展示', () => {
  it('0 值保留；null、单位不符显示未知；未知 WMO 代码保留代码', async () => {
    const user = userEvent.setup()
    const forecast = makeForecast(
      QUERY.date,
      {
        temperature_2m_max: -3,
        temperature_2m_min: null,
        precipitation_probability_max: 0,
        precipitation_sum: null,
        wind_speed_10m_max: 0,
        weather_code: 42,
      },
      { },
      ['temperature_2m_min', 'precipitation_sum'],
    )
    const report = makeWeatherReport(QUERY, { forecast })
    renderPanel({ requestWeather: adapterMock(() => Promise.resolve(report)) })

    await queryOnce(user)
    await screen.findByTestId('weather-values')

    expect(metricText('temperature_2m_max')).toBe('-3 °C')
    expect(metricText('temperature_2m_min')).toBe('未知')
    expect(metricText('precipitation_probability_max')).toBe('0%')
    expect(metricText('precipitation_sum')).toBe('未知')
    expect(metricText('wind_speed_10m_max')).toBe('0 km/h')
    expect(metricText('weather_code')).toBe('未知（代码 42）')
  })

  it('单位不符不展示裸数字', async () => {
    const user = userEvent.setup()
    const report = makeWeatherReport(QUERY, {
      forecast: makeForecast(QUERY.date, { temperature_2m_max: 20 }, { temperature_2m_max: 'K' }),
    })
    renderPanel({ requestWeather: adapterMock(() => Promise.resolve(report)) })
    await queryOnce(user)
    await screen.findByTestId('weather-values')
    expect(metricText('temperature_2m_max')).toBe('未知')
  })

  it('显示本次获取时间、查询发起时间、目的地天气时区与官方署名', async () => {
    const user = userEvent.setup()
    renderPanel()
    await queryOnce(user)
    await screen.findByTestId('weather-values')

    expect(screen.getByText('本次获取时间')).toBeInTheDocument()
    expect(screen.getByText('2026-10-30 04:00:02 UTC')).toBeInTheDocument()
    expect(screen.getByText('查询发起时间')).toBeInTheDocument()
    expect(screen.getByText('2026-10-30 04:00:00 UTC')).toBeInTheDocument()
    expect(screen.getByText('Asia/Shanghai（UTC+08:00）')).toBeInTheDocument()
    expect(screen.getByText(/31.33, 120.57（WGS84，按行程记录查询，未核验）/)).toBeInTheDocument()
    expect(screen.getByText(/31.38, 120.62（网格中心，不是站点精确位置）/)).toBeInTheDocument()
    expect(screen.queryByText(/预报更新时间/)).toBeNull()
    expect(screen.getByRole('link', { name: 'Weather data by Open-Meteo.com' })).toBeVisible()
  })

  it('out_of_range 只说明实际覆盖与该日暂无记录，不展示天气数值', async () => {
    const user = userEvent.setup()
    const report = makeWeatherReport(QUERY, {
      status: 'out_of_range',
      forecast: null,
      fetched_at: FETCHED_AT,
      coverage: makeCoverage('2026-05-10', '2026-05-20', 11),
    })
    renderPanel({ requestWeather: adapterMock(() => Promise.resolve(report)) })

    await queryOnce(user)
    const result = await screen.findByTestId('weather-result')
    expect(within(result).getAllByText(/2026-05-10 至 2026-05-20（共 11 天）/).length).toBeGreaterThan(0)
    expect(within(result).getByText(/这一天暂无记录/)).toBeInTheDocument()
    expect(screen.queryByTestId('weather-values')).toBeNull()
    expect(screen.queryByText('晴')).toBeNull()
  })
  it.each([
    ['invalid_request', /这次查询参数没有被天气服务接受/],
    ['timeout', /天气服务这次等待超时/],
    ['unavailable', /天气服务暂时不可用，没有返回预报/],
  ] as const)('状态 %s 只显示固定说明，不展示数值', async (status, text) => {
    const user = userEvent.setup()
    const report = makeWeatherReport(QUERY, {
      status,
      forecast: null,
      fetched_at: null,
      provider_timezone: null,
      provider_utc_offset_seconds: null,
      coverage: { first_date: null, last_date: null, count: 0 },
    })
    renderPanel({ requestWeather: adapterMock(() => Promise.resolve(report)) })

    await queryOnce(user)
    const result = await screen.findByTestId('weather-result')
    expect(within(result).getByText(text)).toBeInTheDocument()
    expect(screen.queryByTestId('weather-values')).toBeNull()
    expect(within(result).getAllByText('未知').length).toBeGreaterThan(0)
  })

  it('服务端 422 用固定文案，不展示数值', async () => {
    const user = userEvent.setup()
    renderPanel({
      requestWeather: adapterMock(() => Promise.reject(new ApiError('server', 'unprocessable', 422))),
    })
    await queryOnce(user)
    await screen.findByText(/这次查询的日期或坐标没有被天气服务接受/)
    expect(screen.queryByTestId('weather-values')).toBeNull()
  })
})

describe('失败与旧结果隔离', () => {
  it('超时 / 502 用固定文案，且清掉上一次成功的结果', async () => {
    const user = userEvent.setup()
    const success = makeWeatherReport(QUERY)
    const adapter = adapterMock()
      .mockResolvedValueOnce(success)
      .mockRejectedValueOnce(new ApiError('timeout', 'timeout'))
      .mockRejectedValueOnce(new ApiError('server', 'bad gateway', 502))
    renderPanel({ requestWeather: adapter })

    await queryOnce(user)
    await screen.findByTestId('weather-values')

    await queryOnce(user)
    await screen.findByText(/等待天气服务响应超时/)
    expect(screen.queryByTestId('weather-values')).toBeNull()
    expect(screen.queryByTestId('weather-result')).toBeNull()

    await queryOnce(user)
    await screen.findByText(/天气服务暂时不可用/)
    expect(screen.queryByTestId('weather-values')).toBeNull()
    expect(adapter).toHaveBeenCalledTimes(3)
  })

  it('失败不会自动重试', async () => {
    const user = userEvent.setup()
    const adapter = adapterMock(() => Promise.reject(new ApiError('network', 'offline')))
    renderPanel({ requestWeather: adapter })
    await queryOnce(user)
    await screen.findByText(/连不上后端服务/)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(adapter).toHaveBeenCalledTimes(1)
  })

  it('改日期或换站点立即清掉旧结果，且不自动查询', async () => {
    const user = userEvent.setup()
    const { requestWeather } = renderPanel()
    await queryOnce(user)
    await screen.findByTestId('weather-values')

    fireEvent.change(screen.getByLabelText('查询日期'), { target: { value: '2026-05-02' } })
    expect(screen.queryByTestId('weather-values')).toBeNull()
    expect(requestWeather).toHaveBeenCalledTimes(1)

    await queryOnce(user)
    await screen.findByTestId('weather-values')
    await user.selectOptions(screen.getByLabelText('按哪条记录坐标查询'), 'w1b')
    expect(screen.queryByTestId('weather-values')).toBeNull()
    expect(requestWeather).toHaveBeenCalledTimes(2)
  })

  it('切换天、revision 或 Trip 对象后旧结果不可见', async () => {
    const user = userEvent.setup()
    const trip = makeWeatherTrip()
    const adapter = adapterMock()
    const view = renderPanel({ trip, requestWeather: adapter })

    await queryOnce(user)
    await screen.findByTestId('weather-values')

    view.rerender(
      <DayWeatherPanel trip={trip} day={trip.days[1]} revision={1} requestWeather={adapter} />,
    )
    expect(screen.queryByTestId('weather-values')).toBeNull()
    expect(screen.getByLabelText('查询日期')).toHaveValue('')

    fireEvent.change(screen.getByLabelText('查询日期'), { target: { value: '2026-05-02' } })
    await queryOnce(user)
    await screen.findByTestId('weather-values')

    view.rerender(
      <DayWeatherPanel trip={trip} day={trip.days[1]} revision={2} requestWeather={adapter} />,
    )
    expect(screen.queryByTestId('weather-values')).toBeNull()

    fireEvent.change(screen.getByLabelText('查询日期'), { target: { value: '2026-05-02' } })
    await queryOnce(user)
    await screen.findByTestId('weather-values')

    const replaced = makeWeatherTrip({ id: 'trip-weather-2' })
    view.rerender(
      <DayWeatherPanel trip={replaced} day={replaced.days[1]} revision={2} requestWeather={adapter} />,
    )
    expect(screen.queryByTestId('weather-values')).toBeNull()
  })

  it('状态为 failed 时不展示上一次成功的天气', async () => {
    const user = userEvent.setup()
    const success = makeWeatherReport(QUERY)
    const failed = makeWeatherReport(QUERY, {
      status: 'failed',
      forecast: null,
      fetched_at: null,
      coverage: { first_date: null, last_date: null, count: 0 },
    })
    const adapter = adapterMock().mockResolvedValueOnce(success).mockResolvedValueOnce(failed)
    renderPanel({ requestWeather: adapter })

    await queryOnce(user)
    await screen.findByTestId('weather-values')
    await queryOnce(user)
    await screen.findByText(/天气服务这次没有返回可用的预报数据/)
    expect(screen.queryByTestId('weather-values')).toBeNull()
  })
})

describe('停止等待与迟到响应', () => {
  it('停止等待后迟到的响应不展示', async () => {
    const user = userEvent.setup()
    const pending = deferred<WeatherDayReport>()
    const adapter = adapterMock(() => pending.promise)
    renderPanel({ requestWeather: adapter })

    await queryOnce(user)
    expect(screen.getByText(/正在等待天气服务响应/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '停止等待' }))

    await act(async () => {
      pending.resolve(makeWeatherReport(QUERY))
      await pending.promise
    })

    expect(screen.queryByTestId('weather-values')).toBeNull()
    expect(screen.getByText(/已停止等待这次天气查询/)).toBeInTheDocument()
  })

  it('切换日期后迟到的旧响应不展示', async () => {
    const user = userEvent.setup()
    const pending = deferred<WeatherDayReport>()
    const adapter = adapterMock(() => pending.promise)
    renderPanel({ requestWeather: adapter })

    await queryOnce(user)
    fireEvent.change(screen.getByLabelText('查询日期'), { target: { value: '2026-05-02' } })

    await act(async () => {
      pending.resolve(makeWeatherReport(QUERY))
      await pending.promise
    })

    expect(screen.queryByTestId('weather-values')).toBeNull()
  })

  it('收起面板会调用 onClose，并阻止在途响应落地', async () => {
    const user = userEvent.setup()
    const pending = deferred<WeatherDayReport>()
    const adapter = adapterMock(() => pending.promise)
    const onClose = vi.fn()
    renderPanel({ requestWeather: adapter, onClose })

    await queryOnce(user)
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve(makeWeatherReport(QUERY))
      await pending.promise
    })
    expect(screen.queryByTestId('weather-values')).toBeNull()
  })

  it('卸载时中止在途请求，不抛未处理错误', async () => {
    const user = userEvent.setup()
    let receivedSignal: AbortSignal | undefined
    const pending = deferred<WeatherDayReport>()
    const adapter = adapterMock((_query, options) => {
      receivedSignal = options?.signal
      return pending.promise
    })
    const view = renderPanel({ requestWeather: adapter })

    await queryOnce(user)
    view.unmount()
    expect(receivedSignal?.aborted).toBe(true)
    pending.resolve(makeWeatherReport(QUERY))
  })
})

describe('副作用边界', () => {
  it('查询成功不改 Trip、不写 localStorage', async () => {
    const user = userEvent.setup()
    const trip = makeWeatherTrip()
    const snapshot = JSON.stringify(trip)
    renderPanel({ trip })
    await queryOnce(user)
    await screen.findByTestId('weather-values')

    expect(JSON.stringify(trip)).toBe(snapshot)
    expect(window.localStorage.length).toBe(0)
  })

  it('必需的署名文案与本次获取时间在无结果时也可读', () => {
    renderPanel()
    expect(screen.getByRole('link', { name: 'Weather data by Open-Meteo.com' })).toHaveAttribute(
      'href',
      'https://open-meteo.com/',
    )
    expect(screen.getByRole('link', { name: '数据源说明' })).toHaveAttribute(
      'href',
      'https://open-meteo.com/en/docs',
    )
    expect(CHECKED_AT).toBe('2026-10-30T04:00:00+00:00')
  })
})

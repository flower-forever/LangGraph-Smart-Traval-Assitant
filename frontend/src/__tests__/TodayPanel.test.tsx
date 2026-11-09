/**
 * TodayPanel 组件测试（S4 一日跟随）。
 *
 * 覆盖：三时刻场景（首站前 / 两站间 / 末站后）、四缺失（缺站时间 / 缺 leg 耗时 /
 * straight_line / 无坐标站点的天气禁用）、营业状态三态、天气失败文案、预约未记录、
 * 零写入（localStorage 全键不变）。时钟与天气 adapter 全部注入，不发真实请求。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TodayPanel from '../components/TodayPanel'
import type { TripDay, TripLeg, TripStop } from '../lib/api'
import type { ChecklistItemV1, ConstraintItemV1 } from '../lib/workspaceTypes'
import type { WeatherDayQuery, WeatherDayReport } from '../lib/weather'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import { makeWeatherReport, makeStop } from '../test/weatherFixtures'
import { POI_CARDS_FORMAT, POI_CARDS_VERSION } from '../lib/poiCards'

/* 固定时钟：2026-04-03 本地。 */
const MORNING = new Date(2026, 3, 3, 8, 30, 0).getTime()
const MIDMORNING = new Date(2026, 3, 3, 9, 30, 0).getTime()
const EVENING = new Date(2026, 3, 3, 18, 0, 0).getTime()
const NOW = vi.fn(() => MORNING)

function stop(id: string, name: string, time: string, patch: Partial<ReturnType<typeof makeStop>> = {}) {
  return { ...makeStop(id, name, { lng: 120.15, lat: 30.27 }, time), ...patch }
}

function legObj(from: string, to: string, patch: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 800,
    duration_minutes: 16,
    geometry: [],
    description: '',
    ...patch,
  }
}

function day(stops: TripStop[], legs: TripLeg[] = [], date: string | null = '2026-04-03'): TripDay {
  return { day: 1, date, title: '测试日', summary: '', stops, legs }
}

function checklistItem(patch: Partial<ChecklistItemV1>): ChecklistItemV1 {
  return {
    id: 'c1',
    category: 'appointment',
    title: '预约事项',
    done: false,
    date: null,
    day: 1,
    stopId: null,
    originalStopId: null,
    constraintId: null,
    notes: null,
    updatedAt: 0,
    ...patch,
  }
}

function constraintItem(patch: Partial<ConstraintItemV1>): ConstraintItemV1 {
  return {
    id: 'k1',
    kind: 'fixed_window',
    day: 1,
    stopId: null,
    title: '约束事项',
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    notes: null,
    priority: 0,
    updatedAt: 0,
    ...patch,
  }
}

/** 一张命中「断桥残雪」的资料卡：营业时间有值 + 有 provenance → sourced 态。 */
function cardRecord(name: string, openingHours: string, withProvenance: boolean): PoiCardsRecordV1 {
  return {
    format: POI_CARDS_FORMAT,
    version: POI_CARDS_VERSION,
    cards: [
      {
        id: 'card-1',
        identityKey: `${name}|`,
        name,
        intro: '介绍文本。',
        openingHours,
        ticket: '',
        images: [],
        provenance: {
          intro: withProvenance ? { source: 'manual', detail: null, recordedAt: 1700000000000 } : null,
          openingHours: withProvenance ? { source: 'manual', detail: null, recordedAt: 1700000000000 } : null,
          ticket: null,
        },
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    ],
    updatedAt: 1700000000000,
  }
}

interface RenderOpts {
  days?: readonly TripDay[]
  record?: PoiCardsRecordV1 | null
  loaded?: boolean
  checklist?: ChecklistItemV1[]
  constraints?: ConstraintItemV1[]
  now?: () => number
  requestWeather?: (query: WeatherDayQuery) => Promise<WeatherDayReport>
}

function renderPanel(opts: RenderOpts = {}) {
  return render(
    <TodayPanel
      days={opts.days ?? [day([stop('s1', '断桥残雪', '09:00'), stop('s2', '平湖秋月', '10:00')], [legObj('s1', 's2')])]}
      poiCardsRecord={opts.record ?? null}
      poiCardsLoaded={opts.loaded ?? false}
      checklist={opts.checklist ?? []}
      constraints={opts.constraints ?? []}
      activeStopId={null}
      onSelectStop={() => {}}
      now={opts.now ?? NOW}
      requestWeather={opts.requestWeather}
    />,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  NOW.mockImplementation(() => MORNING)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('三时刻场景', () => {
  it('首站前：下一站=第一站 09:00，第一站无上一站 → 出发时间未知', () => {
    renderPanel({ now: () => MORNING })
    expect(screen.getByTestId('today-day-label')).toHaveTextContent('今天 · 第 1 天')
    expect(screen.getByTestId('today-next-name')).toHaveTextContent('断桥残雪')
    expect(screen.getByTestId('today-next-time')).toHaveTextContent('09:00')
    expect(screen.getByTestId('today-departure-unknown')).toHaveTextContent('出发时间未知')
  })

  it('两站之间：下一站=第二站，建议出发 = 10:00 − 16 − 10 = 09:34', () => {
    renderPanel({ now: () => MIDMORNING })
    expect(screen.getByTestId('today-next-name')).toHaveTextContent('平湖秋月')
    expect(screen.getByTestId('today-departure-time')).toHaveTextContent('09:34')
    expect(screen.queryByTestId('today-departure-approx')).toBeNull()
  })

  it('末站后：今日行程已结束，无下一站、无出发建议', () => {
    renderPanel({ now: () => EVENING, days: [day([stop('s1', '断桥残雪', '09:00')])] })
    expect(screen.getByTestId('today-finished')).toHaveTextContent('今日行程已结束')
    expect(screen.queryByTestId('today-next-stop')).toBeNull()
    expect(screen.queryByTestId('today-departure')).toBeNull()
  })
})

describe('日期判定', () => {
  it('有日期但都不匹配本机 → 兜底第 1 天并如实标注（日期未匹配）', () => {
    renderPanel({ now: () => new Date(2026, 5, 1).getTime() })
    expect(screen.getByTestId('today-day-label')).toHaveTextContent('日期未匹配')
    expect(screen.getByTestId('today-day-label')).toHaveTextContent('第 1 天')
  })

  it('整份行程无日期 → 默认第 1 天并标「日期未知」', () => {
    renderPanel({ days: [day([stop('s1', '断桥残雪', '09:00')], [], null)] })
    expect(screen.getByTestId('today-day-label')).toHaveTextContent('日期未知')
  })
})

describe('四种缺失', () => {
  it('缺站时间：下一站=第一站且标「时间未知」', () => {
    renderPanel({ days: [day([stop('s1', '断桥残雪', '')])] })
    expect(screen.getByTestId('today-next-name')).toHaveTextContent('断桥残雪')
    expect(screen.getByTestId('today-next-time')).toHaveTextContent('时间未知')
  })

  it('缺 leg 耗时 → 出发时间未知，不编时刻', () => {
    renderPanel({
      now: () => MIDMORNING,
      days: [day([stop('s1', '断桥残雪', '09:00'), stop('s2', '平湖秋月', '10:00')], [legObj('s1', 's2', { duration_minutes: null })])],
    })
    expect(screen.getByTestId('today-departure-unknown')).toHaveTextContent('出发时间未知')
    expect(screen.queryByTestId('today-departure-time')).toBeNull()
  })

  it('straight_line 路段 → 给出建议但必须带「示意」标记', () => {
    renderPanel({
      now: () => MIDMORNING,
      days: [day([stop('s1', '断桥残雪', '09:00'), stop('s2', '平湖秋月', '10:00')], [legObj('s1', 's2', { route_type: 'straight_line' })])],
    })
    expect(screen.getByTestId('today-departure-time')).toHaveTextContent('09:34')
    expect(screen.getByTestId('today-departure-approx')).toHaveTextContent('示意')
  })

  it('缺 leg（无路程记录）→ 出发时间未知', () => {
    renderPanel({
      now: () => MIDMORNING,
      days: [day([stop('s1', '断桥残雪', '09:00'), stop('s2', '平湖秋月', '10:00')], [])],
    })
    expect(screen.getByTestId('today-departure-unknown')).toHaveTextContent('出发时间未知')
  })

  it('全部站点无坐标 → 天气按钮禁用（不按城市猜）', () => {
    const noCoord = { ...makeStop('s1', '断桥残雪', null, '09:00') }
    renderPanel({ days: [day([noCoord])] })
    expect(screen.getByTestId('today-weather-button')).toBeDisabled()
  })
})

describe('营业状态三态', () => {
  it('sourced（有值 + provenance）→ 营业时间文本 + 「有来源（待核对）」', () => {
    renderPanel({ record: cardRecord('断桥残雪', '全天开放', true), loaded: true })
    expect(screen.getByTestId('today-opening')).toHaveTextContent('营业时间：全天开放')
    expect(screen.getByTestId('today-opening')).toHaveTextContent('有来源（待核对）')
  })

  it('unverified（有值无 provenance）→ 「未核实」，不显示「营业中」', () => {
    renderPanel({ record: cardRecord('断桥残雪', '08:00-17:00', false), loaded: true })
    expect(screen.getByTestId('today-opening')).toHaveTextContent('08:00-17:00')
    expect(screen.getByTestId('today-opening')).toHaveTextContent('未核实')
    expect(screen.queryByText(/营业中/)).toBeNull()
  })

  it('unknown（无卡 / 未加载库）→ 「营业状态未知」', () => {
    renderPanel({ record: null, loaded: true })
    expect(screen.getByTestId('today-opening')).toHaveTextContent('营业状态未知')
    renderPanelUnloaded()
  })
  function renderPanelUnloaded() {
    cleanup()
    renderPanel({ record: cardRecord('断桥残雪', '全天开放', true), loaded: false })
    expect(screen.getByTestId('today-opening')).toHaveTextContent('营业状态未知')
  }
})

describe('天气', () => {
  it('挂载不请求；点按钮后请求一次并展示摘要；成功前显示「天气未获取」', async () => {
    const adapter = vi.fn((query: WeatherDayQuery) => Promise.resolve(makeWeatherReport(query)))
    renderPanel({ requestWeather: adapter })
    expect(screen.getByTestId('today-weather')).toHaveTextContent('天气未获取')
    expect(adapter).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('today-weather-button'))
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(adapter.mock.calls[0][0]).toEqual({ lat: 30.27, lon: 120.15, date: '2026-04-03' })

    await screen.findByTestId('today-weather-values')
    expect(screen.getByTestId('today-weather-values')).toHaveTextContent('最高')
  })

  it('天气失败（adapter reject）→ 「天气未获取」诚实文案，不编造', async () => {
    const adapter = vi.fn(() => Promise.reject(new TypeError('network down')))
    renderPanel({ requestWeather: adapter })
    fireEvent.click(screen.getByTestId('today-weather-button'))
    await screen.findByTestId('today-weather-fail')
    expect(screen.getByTestId('today-weather-fail')).toHaveTextContent('天气未获取')
  })

  it('status 非 available（provider 失败）→ 同样显示「天气未获取」', async () => {
    const adapter = vi.fn(
      (query: WeatherDayQuery) =>
        Promise.resolve(makeWeatherReport(query, { status: 'out_of_range', forecast: null, fetched_at: null })),
    )
    renderPanel({ requestWeather: adapter })
    fireEvent.click(screen.getByTestId('today-weather-button'))
    await screen.findByTestId('today-weather-fail')
    expect(screen.getByTestId('today-weather-fail')).toHaveTextContent('天气未获取')
  })
})

describe('预约提醒', () => {
  it('无记录 → 「未记录」', () => {
    renderPanel({})
    expect(screen.getByTestId('today-reminders-empty')).toHaveTextContent('未记录')
    expect(screen.queryByTestId('today-reminder-list')).toBeNull()
  })

  it('清单 appointment + 约束 fixed_window 命中当天 → 列表展示', () => {
    renderPanel({
      checklist: [checklistItem({ title: '博物馆预约' })],
      constraints: [constraintItem({ title: '入园时间窗' })],
    })
    const list = screen.getByTestId('today-reminder-list')
    expect(list).toHaveTextContent('博物馆预约（清单）')
    expect(list).toHaveTextContent('入园时间窗（约束）')
  })
})

describe('按钮与零写入', () => {
  it('看地图 / 看详情：都选中下一站（同一 handleSelectStop 通道）', () => {
    const onSelectStop = vi.fn()
    render(
      <TodayPanel
        days={[day([stop('s1', '断桥残雪', '09:00'), stop('s2', '平湖秋月', '10:00')], [legObj('s1', 's2')])]}
        poiCardsRecord={null}
        poiCardsLoaded={false}
        checklist={[]}
        constraints={[]}
        activeStopId={null}
        onSelectStop={onSelectStop}
        now={() => MIDMORNING}
      />,
    )
    fireEvent.click(screen.getByTestId('today-view-map'))
    expect(onSelectStop).toHaveBeenLastCalledWith('s2')
    fireEvent.click(screen.getByTestId('today-view-detail'))
    expect(onSelectStop).toHaveBeenLastCalledWith('s2')
  })

  it('零写入：渲染 + 查天气成功前后 localStorage 全键不变', async () => {
    const keysBefore = Object.keys(window.localStorage).sort()
    expect(keysBefore).toEqual([])
    const adapter = vi.fn((query: WeatherDayQuery) => Promise.resolve(makeWeatherReport(query)))
    renderPanel({ requestWeather: adapter })
    fireEvent.click(screen.getByTestId('today-weather-button'))
    await screen.findByTestId('today-weather-values')
    expect(Object.keys(window.localStorage).sort()).toEqual([])
    expect(window.localStorage.length).toBe(0)
  })

  it('空行程（无天）→ 整卡不渲染', () => {
    const { container } = renderPanel({ days: [] })
    expect(container.querySelector('[data-testid="today-panel"]')).toBeNull()
  })
})

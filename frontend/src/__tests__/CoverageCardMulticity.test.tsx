/**
 * 七期 S6 · 选择充分度卡多城分段测试。
 * 全离线：不读写 localStorage、不发请求；加入候选池只断言回调。
 * 覆盖：多城两段标题与计数 / 段内列表与按钮回调 / 单城 DOM 与旧路径一致 /
 * 缺画像文案（不伪造 0/0）/ 空桶与 null 桶不渲染。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CoveragePoolItem } from '../components/CoverageCardContent'
import CoverageCardContent from '../components/CoverageCardContent'
import CoverageCard from '../components/CoverageCard'
import type { CityProfile, Trip, TripDay } from '../lib/api'
import { projectTripCoverageByCity } from '../lib/tripCoverage'

function profileWithClassics(names: string[]): CityProfile {
  return {
    source: 'model_generated',
    classicList: names.map((name) => ({
      name,
      reason: `${name}的理由`,
      source: 'model_generated' as const,
    })),
  }
}

function dayWithStops(dayNumber: number, city: string, stopNames: string[]): TripDay {
  return {
    day: dayNumber,
    date: null,
    title: `第 ${dayNumber} 天`,
    summary: '',
    city,
    stops: stopNames.map((name, index) => ({
      id: `stop-${dayNumber}-${index}`,
      name,
      time: '09:00',
      duration_minutes: null,
      description: '',
      address: '',
      location: null,
    })),
    legs: [],
  }
}

function makeTrip(days: TripDay[], patch: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-coverage-card-multicity',
    source: 'example',
    destination: '杭州',
    title: '多城充分度测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days,
    ...patch,
  }
}

function multiCityTrip(missingSuzhouProfile = false): Trip {
  return makeTrip(
    [
      dayWithStops(1, '杭州', ['断桥']),
      dayWithStops(2, '杭州', []),
      dayWithStops(3, '苏州', ['拙政园']),
      dayWithStops(4, '苏州', []),
    ],
    {
      cityProfile: profileWithClassics(['断桥', '灵隐寺']),
      cityProfiles: missingSuzhouProfile
        ? { 杭州: profileWithClassics(['断桥', '灵隐寺']) }
        : {
            杭州: profileWithClassics(['断桥', '灵隐寺']),
            苏州: profileWithClassics(['拙政园', '虎丘']),
          },
    },
  )
}

function singleCityTrip(): Trip {
  return makeTrip([dayWithStops(1, '杭州', ['苏堤春晓', '浙江省博物馆', '九溪烟树'])], {
    cityProfile: profileWithClassics(['苏堤春晓', '浙江省博物馆', '断桥', '灵隐寺']),
    days: [
      {
        ...dayWithStops(1, '杭州', ['苏堤春晓', '浙江省博物馆', '九溪烟树']),
        city: undefined,
      },
    ],
  })
}

afterEach(() => {
  cleanup()
})

describe('CoverageCardContent · 多城分段', () => {
  it('两城各一段：标题「城市 · 已覆盖 X/N」，段内只含本城清单', () => {
    const trip = multiCityTrip()
    render(
      <CoverageCardContent trip={trip} buckets={projectTripCoverageByCity(trip)} />,
    )

    const hangzhou = screen.getByTestId('trip-coverage-city-0')
    const suzhou = screen.getByTestId('trip-coverage-city-1')
    expect(within(hangzhou).getByTestId('trip-coverage-city-title-0')).toHaveTextContent(
      '杭州 · 已覆盖 1/2',
    )
    expect(within(suzhou).getByTestId('trip-coverage-city-title-1')).toHaveTextContent(
      '苏州 · 已覆盖 1/2',
    )

    expect(
      within(within(hangzhou).getByTestId('city-0-trip-coverage-covered')).getByText('断桥'),
    ).toBeInTheDocument()
    expect(
      within(within(hangzhou).getByTestId('city-0-trip-coverage-uncovered')).getByText('灵隐寺'),
    ).toBeInTheDocument()
    expect(
      within(within(suzhou).getByTestId('city-1-trip-coverage-covered')).getByText('拙政园'),
    ).toBeInTheDocument()
    expect(within(suzhou).queryByText('断桥')).toBeNull()

    // 多城不显示单城全局统计行，也不显示旧单城摘要。
    expect(screen.queryByTestId('trip-coverage-summary')).toBeNull()
  })

  it('段内「加入候选池」按城回调，条目来自本城未安排清单', () => {
    const onAddToPool = vi.fn()
    const trip = multiCityTrip()
    render(
      <CoverageCardContent
        trip={trip}
        buckets={projectTripCoverageByCity(trip)}
        onAddToPool={onAddToPool}
      />,
    )

    fireEvent.click(screen.getByTestId('city-1-trip-coverage-add-0'))
    expect(onAddToPool).toHaveBeenCalledTimes(1)
    const item = onAddToPool.mock.calls[0]![0] as CoveragePoolItem
    expect(item.name).toBe('虎丘')
    expect(item.reason).toBe('虎丘的理由')
  })

  it('某城无画像：该段显示「本城暂无经典清单」，不伪造 0/0', () => {
    const trip = multiCityTrip(true)
    render(
      <CoverageCardContent trip={trip} buckets={projectTripCoverageByCity(trip)} />,
    )

    const suzhou = screen.getByTestId('trip-coverage-city-1')
    expect(within(suzhou).getByTestId('trip-coverage-city-title-1')).toHaveTextContent(/^苏州$/)
    expect(within(suzhou).getByText('本城暂无经典清单')).toBeInTheDocument()
    expect(screen.queryByText(/已覆盖 0\/0/)).toBeNull()
    expect(screen.queryByText(/已覆盖 1\/0/)).toBeNull()
  })

  it('折叠后分段移除，标题、徽章与提示仍在', () => {
    const trip = multiCityTrip()
    render(
      <CoverageCardContent trip={trip} buckets={projectTripCoverageByCity(trip)} />,
    )

    fireEvent.click(screen.getByTestId('trip-coverage-toggle'))
    expect(screen.queryByTestId('trip-coverage-body')).toBeNull()
    expect(screen.queryByTestId('trip-coverage-city-0')).toBeNull()
    expect(screen.getByTestId('trip-coverage-badge')).toBeInTheDocument()
    expect(screen.getByTestId('trip-coverage-disclaimer')).toBeInTheDocument()
  })
})

describe('CoverageCardContent · 单城 DOM 与旧路径一致', () => {
  it('传 1 个 bucket 与不传 buckets 的 DOM 完全相同（无城市名）', () => {
    const trip = singleCityTrip()
    const oldView = render(<CoverageCardContent trip={trip} />)
    const bucketedView = render(
      <CoverageCardContent trip={trip} buckets={projectTripCoverageByCity(trip)} />,
    )

    expect(bucketedView.container.innerHTML).toBe(oldView.container.innerHTML)
    expect(screen.getAllByTestId('trip-coverage-summary')[0]).toHaveTextContent(
      '已覆盖 2/4 · 未安排 2 条',
    )
    expect(screen.queryByTestId('trip-coverage-city-0')).toBeNull()
  })
})

describe('CoverageCard · 副城画像挂载守卫', () => {
  it('主城无 classicList、副城有时，整卡仍挂载并显示副城分段', async () => {
    const trip = multiCityTrip()
    const secondaryOnly: Trip = {
      ...trip,
      cityProfile: null,
      cityProfiles: { 苏州: profileWithClassics(['拙政园', '虎丘']) },
    }
    render(<CoverageCard trip={secondaryOnly} buckets={projectTripCoverageByCity(secondaryOnly)} />)
    expect(await screen.findByTestId('trip-coverage-city-1')).toBeInTheDocument()
  })
})

describe('CoverageCardContent · 空桶与 null 桶', () => {
  it('buckets=[]：整卡不渲染', () => {
    const view = render(<CoverageCardContent trip={multiCityTrip()} buckets={[]} />)
    expect(view.container).toBeEmptyDOMElement()
  })

  it('单桶 view=null：整卡不渲染（不显示伪统计）', () => {
    const view = render(
      <CoverageCardContent
        trip={singleCityTrip()}
        buckets={[{ city: '杭州', days: [1], view: null }]}
      />,
    )
    expect(view.container).toBeEmptyDOMElement()
  })
})

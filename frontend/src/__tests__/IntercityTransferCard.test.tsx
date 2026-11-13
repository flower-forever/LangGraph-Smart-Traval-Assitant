import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import IntercityTransferCard from '../components/IntercityTransferCard'
import type { Trip, TripDay, TripLeg } from '../lib/api'

function makeDay(dayNumber: number, city?: string | null, legs: TripLeg[] = []): TripDay {
  const base: TripDay = {
    day: dayNumber,
    date: null,
    title: `第 ${dayNumber} 天`,
    summary: '',
    stops: [],
    legs,
  }
  return city === undefined ? base : { ...base, city }
}

function makeTrip(days: TripDay[], patch: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-intercity',
    source: 'agent',
    destination: '杭州',
    title: '城际转移测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days,
    ...patch,
  }
}

function intercityLeg(patch: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: 'a2',
    to_stop_id: 'b1',
    mode: 'driving',
    route_type: 'straight_line',
    distance_m: 121_000,
    duration_minutes: 131,
    geometry: [],
    description: '城际转移：杭州 → 苏州。',
    transferKind: 'intercity',
    ...patch,
  }
}

const NOTICE = '具体班次与时刻未提供，请自行查询。'

afterEach(cleanup)

describe('IntercityTransferCard', () => {
  it('straight_line + 121km/131min：显示距离、2 小时 11 分、估算与班次未提供', () => {
    const day = makeDay(1, '杭州', [intercityLeg()])
    const nextDay = makeDay(2, '苏州')
    const trip = makeTrip([day, nextDay])

    render(<IntercityTransferCard trip={trip} day={day} nextDay={nextDay} />)

    const card = screen.getByTestId('intercity-transfer-card')
    expect(card).toHaveAttribute('data-transfer-kind', 'intercity')
    expect(card).toHaveAttribute('data-state', 'estimated')
    expect(screen.getByTestId('intercity-transfer-title')).toHaveTextContent('杭州 → 苏州')

    const estimate = screen.getByTestId('intercity-transfer-estimate')
    expect(estimate).toHaveTextContent('121')
    expect(estimate).toHaveTextContent('2 小时 11 分')
    expect(estimate).toHaveTextContent('估算')
    expect(screen.getByTestId('intercity-transfer-notice')).toHaveTextContent(NOTICE)
  })

  it('unavailable：距离与耗时未知 + 班次未提供', () => {
    const day = makeDay(1, '杭州', [
      intercityLeg({ route_type: 'unavailable', distance_m: null, duration_minutes: null }),
    ])
    const nextDay = makeDay(2, '苏州')
    const trip = makeTrip([day, nextDay])

    render(<IntercityTransferCard trip={trip} day={day} nextDay={nextDay} />)

    expect(screen.getByTestId('intercity-transfer-card')).toHaveAttribute('data-state', 'unknown')
    expect(screen.getByTestId('intercity-transfer-unknown')).toHaveTextContent('距离与耗时未知')
    expect(screen.queryByTestId('intercity-transfer-estimate')).toBeNull()
    expect(screen.getByTestId('intercity-transfer-notice')).toHaveTextContent(NOTICE)
  })

  it('straight_line 但耗时缺失：同样按未知态呈现，不补造数字', () => {
    const day = makeDay(1, '杭州', [intercityLeg({ duration_minutes: null })])
    const nextDay = makeDay(2, '苏州')
    const trip = makeTrip([day, nextDay])

    const { unmount } = render(<IntercityTransferCard trip={trip} day={day} nextDay={nextDay} />)
    expect(screen.getByTestId('intercity-transfer-card')).toHaveAttribute('data-state', 'unknown')
    expect(screen.getByTestId('intercity-transfer-unknown')).toHaveTextContent('距离与耗时未知')
    expect(screen.getByTestId('intercity-transfer-notice')).toHaveTextContent(NOTICE)
    unmount()
  })

  it('无 intercity leg：不渲染（container 为空）', () => {
    const day = makeDay(1, '杭州', [
      {
        from_stop_id: 'a1',
        to_stop_id: 'a2',
        mode: 'walking',
        route_type: 'navigation',
        distance_m: 800,
        duration_minutes: 12,
        geometry: [],
        description: '市内步行',
      },
    ])
    const trip = makeTrip([day])

    const { container } = render(<IntercityTransferCard trip={trip} day={day} nextDay={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('城市名取 day.city / nextDay.city，缺省回退 destination 与描述', () => {
    const dayNoCity = makeDay(1, undefined, [intercityLeg()])
    const nextDay = makeDay(2, '苏州')
    const trip = makeTrip([dayNoCity, nextDay])

    const first = render(<IntercityTransferCard trip={trip} day={dayNoCity} nextDay={nextDay} />)
    expect(screen.getByTestId('intercity-transfer-title')).toHaveTextContent('杭州 → 苏州')
    first.unmount()

    const day = makeDay(1, '杭州', [intercityLeg()])
    const nextNoCity = makeDay(2, undefined)
    const trip2 = makeTrip([day, nextNoCity], { destination: '苏州' })
    const second = render(<IntercityTransferCard trip={trip2} day={day} nextDay={nextNoCity} />)
    expect(screen.getByTestId('intercity-transfer-title')).toHaveTextContent('杭州 → 苏州')
    second.unmount()

    // 缺下一天：从 S1 描述的目标城回退；描述为空则「下一城」。
    const third = render(<IntercityTransferCard trip={trip} day={dayNoCity} nextDay={null} />)
    expect(screen.getByTestId('intercity-transfer-title')).toHaveTextContent('杭州 → 苏州')
    third.unmount()

    const noDescription = makeDay(1, '杭州', [intercityLeg({ description: '' })])
    const fourth = render(
      <IntercityTransferCard trip={makeTrip([noDescription])} day={noDescription} nextDay={null} />,
    )
    expect(screen.getByTestId('intercity-transfer-title')).toHaveTextContent('杭州 → 下一城')
    fourth.unmount()
  })
})

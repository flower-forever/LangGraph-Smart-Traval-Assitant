import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CitySegments from '../components/CitySegments'
import type { CityGroup } from '../lib/cityScope'
import type { TripDay } from '../lib/api'

function makeDay(dayNumber: number): TripDay {
  return {
    day: dayNumber,
    date: null,
    title: `第 ${dayNumber} 天`,
    summary: '',
    stops: [],
    legs: [],
  }
}

function group(city: string, fromDay: number, toDay: number): CityGroup {
  const days: TripDay[] = []
  for (let day = fromDay; day <= toDay; day += 1) days.push(makeDay(day))
  return { city, days, fromDay, toDay }
}

afterEach(cleanup)

describe('CitySegments', () => {
  it('单个城市段返回 null（单城零 DOM）', () => {
    const { container } = render(
      <CitySegments groups={[group('杭州', 1, 3)]} activeDay={2} onJump={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('两组：文案 / aria-pressed / 点击跳 fromDay / disabled 生效', () => {
    const onJump = vi.fn()
    const groups = [group('杭州', 1, 3), group('苏州', 4, 5)]

    const { rerender } = render(<CitySegments groups={groups} activeDay={2} onJump={onJump} />)

    expect(screen.getByRole('navigation', { name: '城市分段' })).toBeInTheDocument()
    const hangzhou = screen.getByRole('button', { name: '杭州 · 3 天' })
    const suzhou = screen.getByRole('button', { name: '苏州 · 2 天' })

    expect(hangzhou).toHaveAttribute('aria-pressed', 'true')
    expect(hangzhou).toHaveAttribute('data-city', '杭州')
    expect(hangzhou).toHaveAttribute('data-from-day', '1')
    expect(hangzhou).toHaveAttribute('data-to-day', '3')
    expect(suzhou).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(suzhou)
    expect(onJump).toHaveBeenCalledTimes(1)
    expect(onJump).toHaveBeenCalledWith(4)

    rerender(<CitySegments groups={groups} activeDay={5} onJump={onJump} disabled />)
    expect(screen.getByRole('button', { name: '杭州 · 3 天' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '苏州 · 2 天' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '苏州 · 2 天' })).toHaveAttribute('aria-pressed', 'true')
  })
})

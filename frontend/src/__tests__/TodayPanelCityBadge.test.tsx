import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import TodayPanel from '../components/TodayPanel'
import type { TripDay } from '../lib/api'

const NOW = new Date(2026, 3, 3, 8, 30, 0).getTime()

function makeDay(): TripDay {
  return {
    day: 1,
    date: null,
    title: '测试日',
    summary: '',
    stops: [],
    legs: [],
  }
}

function renderPanel(city?: string | null) {
  const day = makeDay()
  return render(
    <TodayPanel
      days={[day]}
      poiCardsRecord={null}
      poiCardsLoaded={false}
      checklist={[]}
      constraints={[]}
      activeStopId={null}
      onSelectStop={() => {}}
      now={() => NOW}
      city={city}
    />,
  )
}

afterEach(cleanup)

describe('TodayPanel 城市徽标', () => {
  it('不传 city 无徽标；传「苏州」显示；空串 / 空白不显示', () => {
    const none = renderPanel()
    expect(screen.getByTestId('today-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('today-city-badge')).toBeNull()
    none.unmount()

    const shown = renderPanel('苏州')
    expect(screen.getByTestId('today-city-badge')).toHaveTextContent('苏州')
    shown.unmount()

    const empty = renderPanel('')
    expect(screen.queryByTestId('today-city-badge')).toBeNull()
    empty.unmount()

    const blank = renderPanel('   ')
    expect(screen.queryByTestId('today-city-badge')).toBeNull()
    blank.unmount()

    const padded = renderPanel(' 苏州 ')
    expect(screen.getByTestId('today-city-badge')).toHaveTextContent('苏州')
    padded.unmount()
  })
})

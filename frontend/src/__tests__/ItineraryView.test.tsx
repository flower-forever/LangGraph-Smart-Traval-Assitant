/**
 * 行程视图切换（四期 S3）：默认列表、分段控件状态、切换零存储写入、
 * activeStopId 跨视图保留。离线确定性，不依赖 App 或网络。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ItineraryView from '../components/ItineraryView'
import { MOCK_TRIP } from './fixtures/trip'

const day = MOCK_TRIP.days[0]

function snapshotStorage(): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key !== null) snapshot.set(key, window.localStorage.getItem(key) ?? '')
  }
  return snapshot
}

function expectSameStorage(before: Map<string, string>) {
  const after = snapshotStorage()
  expect(after.size).toBe(before.size)
  for (const [key, raw] of before) {
    expect(after.get(key)).toBe(raw)
  }
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('ItineraryView · 视图切换', () => {
  it('默认列表视图，分段控件 aria-pressed 正确', () => {
    render(<ItineraryView day={day} activeStopId={null} onSelectStop={vi.fn()} />)

    expect(screen.getByRole('group', { name: '行程视图' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '列表' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '时间轴' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getAllByTestId('stop-row')).toHaveLength(day.stops.length)
    expect(screen.queryAllByTestId('timeline-stop')).toHaveLength(0)
  })

  it('点「时间轴」切到时间轴，点「列表」再切回', () => {
    render(<ItineraryView day={day} activeStopId={null} onSelectStop={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '时间轴' }))
    expect(screen.getByRole('button', { name: '时间轴' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '列表' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getAllByTestId('timeline-stop')).toHaveLength(day.stops.length)
    expect(screen.queryAllByTestId('stop-row')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    expect(screen.getByRole('button', { name: '列表' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByTestId('stop-row')).toHaveLength(day.stops.length)
    expect(screen.queryAllByTestId('timeline-stop')).toHaveLength(0)
  })

  it('来回切换不写 localStorage：全键 raw 逐字节一致', () => {
    window.localStorage.setItem('travel-assistant:saved-trips:v1', JSON.stringify({ trips: ['keep'] }))
    window.localStorage.setItem('unrelated:key', 'raw-value-原样')
    const before = snapshotStorage()

    render(<ItineraryView day={day} activeStopId={null} onSelectStop={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '时间轴' }))
    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    fireEvent.click(screen.getByRole('button', { name: '时间轴' }))

    expectSameStorage(before)
  })
})

describe('ItineraryView · 选中站点跨视图保留', () => {
  it('切换视图后 activeStopId 高亮仍在，且切换本身不触发 onSelectStop', () => {
    const onSelectStop = vi.fn()
    render(<ItineraryView day={day} activeStopId="s1" onSelectStop={onSelectStop} />)

    const listRows = screen.getAllByTestId('stop-row')
    expect(listRows[0]).toHaveAttribute('aria-current', 'true')
    expect(listRows[0]).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button', { name: '时间轴' }))
    const timelineNodes = screen.getAllByTestId('timeline-stop')
    expect(timelineNodes[0]).toHaveAttribute('aria-current', 'true')
    expect(timelineNodes[0]).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('timeline-stop-detail')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '列表' }))
    const listRowsAfter = screen.getAllByTestId('stop-row')
    expect(listRowsAfter[0]).toHaveAttribute('aria-current', 'true')
    expect(listRowsAfter[0]).toHaveAttribute('aria-expanded', 'true')

    expect(onSelectStop).not.toHaveBeenCalled()
  })

  it('时间轴里点节点仍回传父级 onSelectStop', () => {
    const onSelectStop = vi.fn()
    render(<ItineraryView day={day} activeStopId={null} onSelectStop={onSelectStop} />)
    fireEvent.click(screen.getByRole('button', { name: '时间轴' }))
    fireEvent.click(screen.getAllByTestId('timeline-stop')[1])
    expect(onSelectStop).toHaveBeenLastCalledWith('s2')
  })
})

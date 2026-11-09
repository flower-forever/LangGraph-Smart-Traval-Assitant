/**
 * 顺路度提示组件（四期 S5）：有建议才渲染、文案格式固定、无应用入口、零存储写入。
 * 全程离线、确定性，不涉及网络或计时。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import RouteFlowHint from '../components/RouteFlowHint'
import type { TripDay, TripStop } from '../lib/api'

function stop(id: string, name: string, lng: number, lat = 0): TripStop {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: null,
    description: '',
    address: '',
    location: { lng, lat },
  }
}

function makeDay(stops: TripStop[]): TripDay {
  return {
    day: 1,
    date: null,
    title: '测试日',
    summary: '',
    stops,
    legs: [],
  }
}

function snapshotStorage(): Array<[string, string]> {
  const entries: Array<[string, string]> = []
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key !== null) entries.push([key, window.localStorage.getItem(key) ?? ''])
  }
  return entries.sort(([a], [b]) => a.localeCompare(b))
}

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('route-flow-test:sentinel', 'raw-value-不能动')
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('RouteFlowHint', () => {
  const suggestionDay = makeDay([
    stop('s1', 'A', 0),
    stop('s2', 'B', 2),
    stop('s3', 'C', 1),
    stop('s4', 'D', 10),
  ])

  it('有建议时按固定格式渲染序号、百分比与公里，且没有应用按钮', () => {
    render(<RouteFlowHint day={suggestionDay} />)

    const card = screen.getByTestId('route-flow-hint')
    expect(card).toHaveAttribute('role', 'status')
    expect(
      within(card).getByText('本日路线可优化：第 2 站与第 3 站互换，路程约缩短 16.7%（约 222.4 公里）。'),
    ).toBeInTheDocument()
    expect(
      within(card).getByText(
        '只提示相邻两站的交换，不是全局最优路线；不会自动修改行程，是否调整请用编辑或 AI 助手。',
      ),
    ).toBeInTheDocument()
    expect(within(card).queryAllByRole('button')).toHaveLength(0)
  })

  it('没有可信建议时整卡不渲染（站点不足 / 坐标缺失）', () => {
    const twoStops = makeDay([stop('s1', 'A', 0), stop('s2', 'B', 1)])
    const { container } = render(<RouteFlowHint day={twoStops} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('route-flow-hint')).toBeNull()

    cleanup()
    const missingCoordinate = makeDay([
      stop('s1', 'A', 0),
      { ...stop('s2', 'B', 1), location: null },
      stop('s3', 'C', 2),
    ])
    const second = render(<RouteFlowHint day={missingCoordinate} />)
    expect(second.container).toBeEmptyDOMElement()
  })

  it('渲染与卸载前后 localStorage 全键 raw 全等（零写入）', () => {
    const before = snapshotStorage()
    const { unmount } = render(<RouteFlowHint day={suggestionDay} />)
    expect(snapshotStorage()).toEqual(before)

    unmount()
    expect(snapshotStorage()).toEqual(before)
  })

  it('提示卡使用可换行、无固定宽度的语义样式，375 窄屏不横溢', () => {
    render(<RouteFlowHint day={suggestionDay} />)
    const className = screen.getByTestId('route-flow-hint').className

    expect(className).toContain('min-w-0')
    expect(className).toContain('max-w-[72ch]')
    expect(className).toContain('[overflow-wrap:anywhere]')
    expect(className).toContain('bg-[color:var(--color-warn-bg)]')
  })
})

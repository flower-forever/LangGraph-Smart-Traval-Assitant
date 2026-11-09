/**
 * 时间轴视图（四期 S3）：停点顺序、缺失字段口径、站点展开与资料卡展示。
 * 全部离线、确定性；本文件不读写 localStorage，只验证纯展示行为。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TimelineView from '../components/TimelineView'
import type { TripDay } from '../lib/api'
import { createEmptyPoiCardsRecord, createPoiCard } from '../lib/poiCards'
import { MOCK_TRIP } from './fixtures/trip'

const day = MOCK_TRIP.days[0]

function makePoiCards(name: string, id = 'card-timeline-1') {
  const card = createPoiCard(
    {
      id,
      name,
      intro: '湖上景观。',
      openingHours: '全天',
      ticket: '免费',
      provenance: { intro: { source: 'manual', detail: '手工粘贴', recordedAt: 1 }, openingHours: null, ticket: null },
    },
    1_000,
  )
  if (!card.ok) throw new Error(card.message)
  const empty = createEmptyPoiCardsRecord(1_000)
  if (!empty.ok) throw new Error(empty.message)
  return { ...empty.value, cards: [card.value] }
}

afterEach(() => {
  cleanup()
})

describe('TimelineView · 结构与停点顺序', () => {
  it('按 Trip 数据顺序渲染停点，并保留天头信息', () => {
    render(<TimelineView day={day} activeStopId={null} onSelectStop={vi.fn()} />)

    const nodes = screen.getAllByTestId('timeline-stop')
    expect(nodes).toHaveLength(day.stops.length)
    day.stops.forEach((stop, i) => {
      expect(within(nodes[i]).getByText(stop.name)).toBeInTheDocument()
    })

    expect(screen.getByRole('heading', { name: '第 1 天 · 西湖环湖' })).toBeInTheDocument()
    expect(screen.getByText('2026 年 4 月 3 日 · 周五')).toBeInTheDocument()
    expect(screen.getByText('3 个站点')).toBeInTheDocument()
    expect(screen.getByText(day.summary)).toBeInTheDocument()
  })

  it('时间缺失时显示「时间未知」，不编造时刻', () => {
    const dayNoTime: TripDay = {
      ...day,
      stops: day.stops.map((stop, i) => (i === 0 ? { ...stop, time: '' } : stop)),
    }
    render(<TimelineView day={dayNoTime} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(screen.getByText('时间未知')).toBeInTheDocument()
    expect(screen.getByText('10:00')).toBeInTheDocument()
  })
})

describe('TimelineView · 站间交通段', () => {
  it('显示模式、路线类型、距离与时长', () => {
    render(<TimelineView day={day} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(screen.getByText('步行')).toBeInTheDocument()
    expect(screen.getByText('地图路线')).toBeInTheDocument()
    expect(screen.getByText('1.1 公里')).toBeInTheDocument()
    expect(screen.getByText('约 16 分钟')).toBeInTheDocument()
    expect(screen.getByText('驾车')).toBeInTheDocument()
    expect(screen.getByText('示意直线')).toBeInTheDocument()
  })

  it('leg 缺失或 to_stop 找不到时显示「未提供本段路线信息。」', () => {
    const dayNoLegs: TripDay = { ...day, legs: [] }
    render(<TimelineView day={dayNoLegs} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(screen.getAllByText('未提供本段路线信息。')).toHaveLength(day.stops.length - 1)

    const dayDanglingLeg: TripDay = {
      ...day,
      legs: day.legs.map((leg, i) => (i === 0 ? { ...leg, to_stop_id: 'missing-stop' } : leg)),
    }
    cleanup()
    render(<TimelineView day={dayDanglingLeg} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(screen.getAllByText('未提供本段路线信息。')).toHaveLength(1)
    expect(screen.getByText('驾车')).toBeInTheDocument()
  })

  it('leg 距离/时长缺失时使用既有「距离未知 / 时长未知」口径', () => {
    const dayMissingLegValues: TripDay = {
      ...day,
      legs: day.legs.map((leg) => ({ ...leg, distance_m: null, duration_minutes: null })),
    }
    render(<TimelineView day={dayMissingLegValues} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(screen.getAllByText('距离未知')).toHaveLength(2)
    expect(screen.getAllByText('时长未知')).toHaveLength(2)
  })

  it('navigation 且 geometry 不足时保留列表视图同款折线说明', () => {
    const dayNoGeometry: TripDay = {
      ...day,
      legs: day.legs.map((leg, i) => (i === 0 ? { ...leg, geometry: [] } : leg)),
    }
    render(<TimelineView day={dayNoGeometry} activeStopId={null} onSelectStop={vi.fn()} />)
    expect(screen.getByText('地图服务未返回折线，地图上只画两端示意，不算真实导航。')).toBeInTheDocument()
  })
})

describe('TimelineView · 展开与选中', () => {
  it('activeStopId 对应节点高亮，aria-current / aria-expanded 正确', () => {
    render(<TimelineView day={day} activeStopId="s2" onSelectStop={vi.fn()} />)
    const nodes = screen.getAllByTestId('timeline-stop')
    expect(nodes[1].getAttribute('aria-current')).toBe('true')
    expect(nodes[1].getAttribute('aria-expanded')).toBe('true')
    expect(nodes[0].getAttribute('aria-current')).toBeNull()
    expect(nodes[0].getAttribute('aria-expanded')).toBe('false')

    const detail = screen.getByTestId('timeline-stop-detail')
    expect(within(detail).getByRole('heading', { name: '平湖秋月' })).toBeInTheDocument()
  })

  it('点击节点展开详情，再点收起；onSelectStop 传 stop.id / 空串', () => {
    const onSelectStop = vi.fn()
    const { rerender } = render(<TimelineView day={day} activeStopId={null} onSelectStop={onSelectStop} />)
    fireEvent.click(screen.getAllByTestId('timeline-stop')[0])
    expect(onSelectStop).toHaveBeenLastCalledWith('s1')

    rerender(<TimelineView day={day} activeStopId="s1" onSelectStop={onSelectStop} />)
    expect(screen.getByTestId('timeline-stop-detail')).toBeInTheDocument()
    fireEvent.click(screen.getAllByTestId('timeline-stop')[0])
    expect(onSelectStop).toHaveBeenLastCalledWith('')
  })

  it('受控循环里可展开并再次收起', () => {
    function Harness() {
      const [active, setActive] = useState<string | null>(null)
      return (
        <TimelineView
          day={day}
          activeStopId={active}
          onSelectStop={(stopId) => setActive(stopId === '' ? null : stopId)}
        />
      )
    }
    render(<Harness />)
    const first = screen.getAllByTestId('timeline-stop')[0]
    fireEvent.click(first)
    expect(screen.getByTestId('timeline-stop-detail')).toBeInTheDocument()
    expect(screen.getAllByTestId('timeline-stop')[0].getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getAllByTestId('timeline-stop')[0])
    expect(screen.queryByTestId('timeline-stop-detail')).toBeNull()
  })

  it('展开区显示讲解、地址、时长、坐标与 OSM 链接', () => {
    render(<TimelineView day={day} activeStopId="s1" onSelectStop={vi.fn()} />)
    const detail = screen.getByTestId('timeline-stop-detail')
    expect(within(detail).getByText(day.stops[0].description)).toBeInTheDocument()
    expect(within(detail).getByText(/杭州市西湖区白堤东端/)).toBeInTheDocument()
    expect(within(detail).getByText(/约 40 分钟/)).toBeInTheDocument()
    expect(within(detail).getByText(/坐标 WGS84 30\.2726, 120\.1576/)).toBeInTheDocument()
    expect(within(detail).getByRole('link', { name: '在 OpenStreetMap 中查看' })).toBeInTheDocument()
  })

  it('无坐标站点显示「无坐标」徽标，展开区不出现 OSM 链接；缺失讲解/地址/时长使用兜底文案', () => {
    const bareDay: TripDay = {
      ...day,
      stops: [
        {
          ...day.stops[2],
          description: '',
          address: '',
          duration_minutes: null,
          location: null,
        },
      ],
      legs: [],
    }
    render(<TimelineView day={bareDay} activeStopId="s3" onSelectStop={vi.fn()} />)
    expect(screen.getByText('无坐标')).toBeInTheDocument()
    const detail = screen.getByTestId('timeline-stop-detail')
    expect(within(detail).getByText('后端暂未提供这一站点的讲解。')).toBeInTheDocument()
    expect(within(detail).getByText(/地址未知/)).toBeInTheDocument()
    expect(within(detail).getByText(/时长未知/)).toBeInTheDocument()
    expect(within(detail).queryByRole('link')).toBeNull()
  })
})

describe('TimelineView · 资料卡展示位', () => {
  const stopId = day.stops[0].id

  it('唯一命中时展示资料卡摘要与「按名称匹配，请自行核对」', () => {
    render(
      <TimelineView
        day={day}
        activeStopId={stopId}
        onSelectStop={vi.fn()}
        poiCards={makePoiCards(day.stops[0].name)}
      />,
    )
    const note = screen.getByRole('note', { name: `景点资料卡：${day.stops[0].name}` })
    expect(within(note).getByText('景点资料卡 · 未核实')).toBeInTheDocument()
    expect(within(note).getByText('介绍：湖上景观。')).toBeInTheDocument()
    expect(within(note).getByText('开放时间：全天')).toBeInTheDocument()
    expect(within(note).getByText('门票：免费')).toBeInTheDocument()
    expect(within(note).getByText(/按名称匹配，请自行核对/)).toBeInTheDocument()
  })

  it('无匹配或多命中时不显示资料卡', () => {
    const { unmount } = render(
      <TimelineView day={day} activeStopId={stopId} onSelectStop={vi.fn()} poiCards={makePoiCards('别的景点')} />,
    )
    expect(screen.queryByTestId(`stop-poi-card-${stopId}`)).toBeNull()
    unmount()

    const a = createPoiCard({ id: 'm1', name: day.stops[0].name, address: '地址A' }, 1_000)
    const b = createPoiCard({ id: 'm2', name: day.stops[0].name, address: '地址B' }, 1_000)
    if (!a.ok || !b.ok) throw new Error('fixture 失败')
    const empty = createEmptyPoiCardsRecord(1_000)
    if (!empty.ok) throw new Error('fixture 失败')
    render(
      <TimelineView
        day={day}
        activeStopId={stopId}
        onSelectStop={vi.fn()}
        poiCards={{ ...empty.value, cards: [a.value, b.value] }}
      />,
    )
    expect(screen.queryByTestId(`stop-poi-card-${stopId}`)).toBeNull()
  })
})

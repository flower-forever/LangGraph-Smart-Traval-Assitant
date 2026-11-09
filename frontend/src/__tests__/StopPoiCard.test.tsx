/**
 * S2 · 信息可信卡组件测试（StopPoiCard + StopFactBadge）。
 * 全离线：不读写 localStorage、不发请求；时间显式注入，零墙钟依赖。
 * 覆盖：sourced / unverified / 空值 / 无资料卡四种显示、179/181 天边界、
 * 旧卡（无 provenance）不崩不误标、来源详情展开、「去资料卡补充」入口。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StopPoiCard from '../components/StopPoiCard'
import { createEmptyPoiCardsRecord, createPoiCard, type PoiCardsRecordV1 } from '../lib/poiCards'
import type { TripStop } from '../lib/api'

const NOW = 1_800_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000

const stop: TripStop = {
  id: 's1',
  name: '断桥残雪',
  time: '09:00',
  duration_minutes: 40,
  description: '',
  address: '杭州市西湖区白堤东端',
  location: null,
}

function makeRecord(cards: PoiCardsRecordV1['cards']): PoiCardsRecordV1 {
  const empty = createEmptyPoiCardsRecord(1_000)
  if (!empty.ok) throw new Error(empty.message)
  return { ...empty.value, cards }
}

/** 手工构造卡：provenance 可精确控制（含旧卡 null）。 */
function makeCard(
  fields: { intro?: string; openingHours?: string; ticket?: string },
  provenance: PoiCardsRecordV1['cards'][number]['provenance'],
): PoiCardsRecordV1['cards'][number] {
  const card = createPoiCard(
    {
      id: 'card-1',
      name: stop.name,
      intro: fields.intro ?? '',
      openingHours: fields.openingHours ?? '',
      ticket: fields.ticket ?? '',
      provenance,
    },
    1_000,
  )
  if (!card.ok) throw new Error(card.message)
  return card.value
}

afterEach(() => {
  cleanup()
})

describe('StopPoiCard · 四种显示', () => {
  it('sourced：值 + 「有来源（待核对）」徽章，展开可见来源名 / 说明 / 记录日期', () => {
    const record = makeRecord([
      makeCard(
        { intro: '湖上景观。' },
        { intro: { source: 'tavily', detail: '页面摘录', recordedAt: NOW - 10 * DAY_MS }, openingHours: null, ticket: null },
      ),
    ])
    render(<StopPoiCard stop={stop} poiCards={record} now={() => NOW} />)
    const note = screen.getByRole('note', { name: `景点信息可信卡：${stop.name}` })
    expect(within(note).getByText('湖上景观。')).toBeInTheDocument()
    expect(within(note).getAllByText('有来源（待核对）').length).toBe(1)
    // 展开来源详情（details/summary）
    fireEvent.click(within(note).getByText('有来源（待核对）'))
    expect(within(note).getByText('来源：网页资料')).toBeInTheDocument()
    expect(within(note).getByText('来源说明：页面摘录')).toBeInTheDocument()
    expect(within(note).getByText(/记录日期：\d{4}-\d{2}-\d{2}/)).toBeInTheDocument()
    expect(within(note).getAllByText(/按名称匹配，请自行核对/).length).toBeGreaterThanOrEqual(1)
    // 红线：永不出现「已核实」
    expect(within(note).queryByText(/已核实/)).toBeNull()
  })

  it('unverified：有值无 provenance → 「未核实」徽章，无来源详情可展开', () => {
    const record = makeRecord([
      makeCard({ intro: '手工介绍。', openingHours: '全天' }, { intro: null, openingHours: null, ticket: null }),
    ])
    render(<StopPoiCard stop={stop} poiCards={record} now={() => NOW} />)
    const note = screen.getByRole('note', { name: `景点信息可信卡：${stop.name}` })
    expect(within(note).getAllByText('未核实').length).toBe(2)
    expect(within(note).queryByTestId('stop-fact-source-detail')).toBeNull()
    expect(within(note).queryByText(/已核实/)).toBeNull()
  })

  it('空值字段显示「未知」，即使该字段有 provenance', () => {
    const record = makeRecord([
      makeCard(
        { intro: '介绍。' },
        { intro: { source: 'manual', detail: null, recordedAt: NOW }, openingHours: null, ticket: null },
      ),
    ])
    render(<StopPoiCard stop={stop} poiCards={record} now={() => NOW} />)
    const note = screen.getByRole('note', { name: `景点信息可信卡：${stop.name}` })
    // openingHours / ticket 为空 → 只有徽章承担「未知」（值区不重复渲染）
    expect(within(note).getAllByText('未知').length).toBe(2)
    expect(within(note).getAllByText('未知')[0].getAttribute('data-status')).toBe('unknown')
  })

  it('无资料卡 / poiCards=null：三字段全「未知」，带「去资料卡补充」入口', () => {
    const onOpenPoiCardPanel = vi.fn()
    render(<StopPoiCard stop={stop} poiCards={null} now={() => NOW} onOpenPoiCardPanel={onOpenPoiCardPanel} />)
    const note = screen.getByRole('note', { name: `景点信息可信卡：${stop.name}` })
    expect(within(note).getAllByText('未知').length).toBe(3)
    const entry = within(note).getByTestId('stop-poi-card-supplement')
    fireEvent.click(entry)
    expect(onOpenPoiCardPanel).toHaveBeenCalledWith(stop.name)
    expect(onOpenPoiCardPanel).toHaveBeenCalledTimes(1)
  })

  it('无资料卡且未传入口回调：只显示未知，不渲染入口按钮', () => {
    render(<StopPoiCard stop={stop} poiCards={null} now={() => NOW} />)
    const note = screen.getByRole('note', { name: `景点信息可信卡：${stop.name}` })
    expect(within(note).queryByTestId('stop-poi-card-supplement')).toBeNull()
    expect(within(note).getAllByText('未知').length).toBe(3)
  })
})

describe('StopPoiCard · 时效标记', () => {
  it('179 天：sourced 但不显示「可能过期」', () => {
    const record = makeRecord([
      makeCard(
        { intro: '介绍。' },
        { intro: { source: 'osm', detail: null, recordedAt: NOW - 179 * DAY_MS }, openingHours: null, ticket: null },
      ),
    ])
    render(<StopPoiCard stop={stop} poiCards={record} now={() => NOW} />)
    expect(screen.queryByTestId('stop-fact-stale')).toBeNull()
  })

  it('181 天：sourced + 「可能过期」标记，且仍在来源详情展开区里', () => {
    const record = makeRecord([
      makeCard(
        { intro: '介绍。' },
        { intro: { source: 'osm', detail: null, recordedAt: NOW - 181 * DAY_MS }, openingHours: null, ticket: null },
      ),
    ])
    render(<StopPoiCard stop={stop} poiCards={record} now={() => NOW} />)
    fireEvent.click(screen.getByText('有来源（待核对）'))
    expect(screen.getByTestId('stop-fact-stale')).toBeInTheDocument()
    expect(screen.getByTestId('stop-fact-stale').textContent).toContain('可能过期')
    expect(screen.queryByText(/已核实/)).toBeNull()
  })
})

describe('StopPoiCard · 旧卡兼容', () => {
  it('旧卡（provenance 全 null）不崩：有值 → 未核实，空值 → 未知，无 sourced 徽章', () => {
    const record = makeRecord([makeCard({ intro: '旧卡介绍', ticket: '免费' }, { intro: null, openingHours: null, ticket: null })])
    render(<StopPoiCard stop={stop} poiCards={record} now={() => NOW} />)
    const note = screen.getByRole('note', { name: `景点信息可信卡：${stop.name}` })
    expect(within(note).getByText('旧卡介绍')).toBeInTheDocument()
    expect(within(note).getByText('免费')).toBeInTheDocument()
    expect(within(note).getAllByText('未核实').length).toBe(2)
    expect(within(note).getAllByText('未知').length).toBe(1)
    expect(within(note).queryByText('有来源（待核对）')).toBeNull()
    expect(within(note).queryByTestId('stop-fact-source-detail')).toBeNull()
    expect(within(note).queryByText(/已核实/)).toBeNull()
  })
})

describe('StopPoiCard · 匹配口径', () => {
  it('多命中（重名两条）→ findPoiCardByName 返回 null → 按无卡显示未知 + 入口', () => {
    const a = createPoiCard({ id: 'm1', name: stop.name, address: '地址A' }, 1_000)
    const b = createPoiCard({ id: 'm2', name: stop.name, address: '地址B' }, 1_000)
    if (!a.ok || !b.ok) throw new Error('fixture 失败')
    render(
      <StopPoiCard
        stop={stop}
        poiCards={makeRecord([a.value, b.value])}
        now={() => NOW}
        onOpenPoiCardPanel={vi.fn()}
      />,
    )
    const note = screen.getByRole('note', { name: `景点信息可信卡：${stop.name}` })
    expect(within(note).getAllByText('未知').length).toBe(3)
  })

  it('默认当前时间可用（不传 now 不崩）；徽章文案与 data-status 三态齐全', () => {
    const record = makeRecord([
      makeCard(
        { intro: '介绍。', openingHours: '全天' },
        {
          intro: { source: 'wikimedia', detail: null, recordedAt: Date.now() },
          openingHours: null,
          ticket: null,
        },
      ),
    ])
    render(<StopPoiCard stop={stop} poiCards={record} />)
    expect(screen.getAllByTestId('stop-fact-source-detail').length).toBe(1)
    expect(screen.getByText('有来源（待核对）').getAttribute('data-status')).toBe('sourced')
    expect(screen.getByText('未核实').getAttribute('data-status')).toBe('unverified')
  })
})

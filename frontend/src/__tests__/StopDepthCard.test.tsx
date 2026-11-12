/**
 * 六期 S5 · 景点深度卡组件测试。
 * 全离线：不读写 localStorage、不发请求；懒加载边界与投影降级都走 jsdom。
 * 覆盖：四分区完整渲染、AI 徽章与常驻提示、缺字段「未提供」、无深度不渲染、
 * 与 S2 三态徽章并存分工、lazy 边界。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import StopDepthCard from '../components/StopDepthCard'
import StopDepthCardContent from '../components/StopDepthCardContent'
import StopPoiCard from '../components/StopPoiCard'
import type { TripStop } from '../lib/api'
import { createEmptyPoiCardsRecord, createPoiCard, type PoiCardsRecordV1 } from '../lib/poiCards'

const stop: TripStop = {
  id: 's1',
  name: '断桥残雪',
  time: '09:00',
  duration_minutes: 40,
  description: '',
  address: '杭州市西湖区白堤东端',
  location: null,
  highlights: {
    items: ['湖面开阔，长堤一线', '春晓时分光线柔和'],
    source: 'model_generated',
  },
  suitableFor: { tags: ['nature', 'photo'], source: 'model_generated' },
  suggestedStayMinutes: { min: 60, max: 90, source: 'model_generated' },
  tips: { items: ['清晨与傍晚人少'], source: 'model_generated' },
}

const plainStop: TripStop = {
  id: 's2',
  name: '曲院风荷',
  time: '10:30',
  duration_minutes: 40,
  description: '',
  address: '',
  location: null,
}

afterEach(() => {
  cleanup()
})

describe('StopDepthCard · 完整深度', () => {
  it('四分区、AI 徽章、常驻提示与分工说明全部渲染', () => {
    render(<StopDepthCardContent stop={stop} />)
    const card = screen.getByTestId(`stop-depth-card-${stop.id}`)

    expect(within(card).getByTestId('stop-depth-badge')).toHaveTextContent('AI 生成·供参考')
    expect(within(card).getByTestId('stop-depth-disclaimer')).toHaveTextContent('出发前请自行确认')
    expect(within(card).getByText(/易变信息以下方核实状态为准/)).toBeInTheDocument()

    expect(within(card).getByText('湖面开阔，长堤一线')).toBeInTheDocument()
    expect(within(card).getByText('春晓时分光线柔和')).toBeInTheDocument()
    expect(within(card).getByText('自然')).toBeInTheDocument()
    expect(within(card).getByText('拍照')).toBeInTheDocument()
    expect(within(card).getByText('建议停留 60–90 分钟')).toBeInTheDocument()
    expect(within(card).getByText('清晨与傍晚人少')).toBeInTheDocument()
  })
})

describe('StopDepthCard · 生成时间（P6.5 X4）', () => {
  it('UTC 存储按本地日期显示「生成于 YYYY-MM-DD」，不裸显示 UTC', () => {
    const iso = '2026-11-12T23:30:00Z'
    const local = new Date(iso)
    const expected = [
      local.getFullYear(),
      String(local.getMonth() + 1).padStart(2, '0'),
      String(local.getDate()).padStart(2, '0'),
    ].join('-')

    render(<StopDepthCardContent stop={{ ...stop, depthGeneratedAt: iso }} />)
    const line = screen.getByTestId('stop-depth-generated-at')

    expect(line).toHaveTextContent(`生成于 ${expected}`)
    expect(line.textContent).not.toContain('T23:30')
    expect(line.textContent).not.toContain('Z')
  })

  it('旧行程没有该字段：卡片照常渲染，但不显示生成时间', () => {
    render(<StopDepthCardContent stop={stop} />)

    expect(screen.getByTestId(`stop-depth-card-${stop.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId('stop-depth-generated-at')).toBeNull()
  })

  it('坏值只影响这一行：不显示时间，四分区内容不受影响', () => {
    render(<StopDepthCardContent stop={{ ...stop, depthGeneratedAt: 'not-a-date' }} />)

    expect(screen.queryByTestId('stop-depth-generated-at')).toBeNull()
    expect(screen.getByText('湖面开阔，长堤一线')).toBeInTheDocument()
  })
})

describe('StopDepthCard · 缺字段降级', () => {
  it('只有看点时，其余三分区显示「未提供」', () => {
    render(
      <StopDepthCardContent
        stop={{ ...plainStop, highlights: { items: ['只有看点'], source: 'model_generated' } }}
      />,
    )
    const card = screen.getByTestId(`stop-depth-card-${plainStop.id}`)
    expect(within(card).getByText('只有看点')).toBeInTheDocument()
    for (const id of ['stop-depth-suitable', 'stop-depth-stay', 'stop-depth-tips']) {
      expect(within(within(card).getByTestId(id)).getByText('未提供')).toBeInTheDocument()
    }
  })

  it('无任一深度块：卡片整体不渲染（旧行程零残留）', () => {
    const contentRender = render(<StopDepthCardContent stop={plainStop} />)
    expect(contentRender.container).toBeEmptyDOMElement()
    contentRender.unmount()

    const wrapperRender = render(<StopDepthCard stop={plainStop} />)
    expect(wrapperRender.container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('stop-depth-loading')).toBeNull()
  })
})

describe('StopDepthCard · 与 S2 三态徽章并存', () => {
  function makeRecord(): PoiCardsRecordV1 {
    const empty = createEmptyPoiCardsRecord(1_000)
    if (!empty.ok) throw new Error(empty.message)
    const card = createPoiCard(
      {
        id: 'card-1',
        name: stop.name,
        intro: '湖上景观。',
        openingHours: '',
        ticket: '',
        provenance: { intro: null, openingHours: null, ticket: null },
      },
      1_000,
    )
    if (!card.ok) throw new Error(card.message)
    return { ...empty.value, cards: [card.value] }
  }

  it('稳定知识带 AI 生成徽章；易变事实仍显示 S2「未核实」徽章，二者同卡并存', async () => {
    render(<StopPoiCard stop={stop} poiCards={makeRecord()} now={() => 1_800_000_000_000} />)
    const note = screen.getByRole('note', { name: `景点信息可信卡：${stop.name}` })

    expect(await within(note).findByTestId('stop-depth-card-s1')).toBeInTheDocument()
    expect(within(note).getByTestId('stop-depth-badge')).toHaveTextContent('AI 生成·供参考')
    // 介绍有值但无 provenance → S2「未核实」；清晰分工，不冒充已核实。
    expect(within(note).getAllByText('未核实').length).toBe(1)
    expect(within(note).getByText('开放时间：')).toBeInTheDocument()
  })
})

describe('StopDepthCard · lazy 边界', () => {
  it('默认导出经 React.lazy 解析后正常渲染', async () => {
    render(<StopDepthCard stop={stop} />)
    expect(await screen.findByTestId(`stop-depth-card-${stop.id}`)).toBeInTheDocument()
    expect(screen.getByTestId('stop-depth-badge')).toHaveTextContent('AI 生成·供参考')
  })
})

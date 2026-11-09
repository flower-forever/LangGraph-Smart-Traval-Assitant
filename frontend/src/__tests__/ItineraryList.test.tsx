/** 复制兜底路径：jsdom 下没有真实剪贴板，必须能可控地验证成功/失败与临时节点清理 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ItineraryList, { copyText } from '../components/ItineraryList'
import { createEmptyPoiCardsRecord, createPoiCard } from '../lib/poiCards'
import { MOCK_TRIP } from './fixtures/trip'

const day = MOCK_TRIP.days[0]
const originalExecCommand = document.execCommand

function renderList() {
  return render(<ItineraryList day={day} activeStopId={null} onSelectStop={vi.fn()} />)
}

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

function setExecCommand(impl: unknown) {
  Object.defineProperty(document, 'execCommand', { value: impl, configurable: true, writable: true })
}

async function clickCopy(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '复制本日行程' }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setClipboard(undefined)
  setExecCommand(originalExecCommand)
})

describe('ItineraryList 复制', () => {
  it('剪贴板 API 可用时直接写入，不产生临时节点', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('已复制')).toBeInTheDocument())
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('断桥残雪')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('没有剪贴板 API 时退回 execCommand，并清理临时 textarea', async () => {
    setClipboard(undefined)
    const exec = vi.fn(() => true)
    setExecCommand(exec)
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('已复制')).toBeInTheDocument())
    expect(exec).toHaveBeenCalledWith('copy')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('execCommand 抛异常时提示失败，临时 textarea 也要清理', async () => {
    setClipboard(undefined)
    setExecCommand(() => {
      throw new Error('copy denied')
    })
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('复制失败，请手动选择')).toBeInTheDocument())
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('剪贴板被拒后兜底也失败时提示手动复制', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    setExecCommand(() => false)
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('复制失败，请手动选择')).toBeInTheDocument())
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('document.execCommand 不存在时优雅失败，不抛未捕获异常', async () => {
    setClipboard(undefined)
    setExecCommand(undefined)
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('复制失败，请手动选择')).toBeInTheDocument())
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('copyText 兜底失败时返回 false 且不留残余节点', async () => {
    setClipboard(undefined)
    setExecCommand(() => {
      throw new Error('boom')
    })
    await expect(copyText('第 1 天')).resolves.toBe(false)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('复制过程不打印 DEBUG 日志', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) })
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('已复制')).toBeInTheDocument())
    expect(logSpy).not.toHaveBeenCalled()
  })
})

describe('ItineraryList · 资料卡展示位（三期 S2 / 五期 S2 改造）', () => {
  const stopId = day.stops[0].id

  function makePoiCards(name: string) {
    const card = createPoiCard(
      {
        id: 'card-it-1',
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

  it('停点展开时按名称归一化显示信息可信卡，sourced 字段带徽章与来源', () => {
    render(
      <ItineraryList day={day} activeStopId={stopId} onSelectStop={vi.fn()} poiCards={makePoiCards(day.stops[0].name)} />,
    )
    const note = screen.getByRole('note', { name: new RegExp(`景点信息可信卡：${day.stops[0].name}`) })
    expect(within(note).getByText('介绍：')).toBeInTheDocument()
    expect(within(note).getByText('湖上景观。')).toBeInTheDocument()
    expect(within(note).getByText('开放时间：')).toBeInTheDocument()
    expect(within(note).getByText('全天')).toBeInTheDocument()
    expect(within(note).getByText('门票：')).toBeInTheDocument()
    expect(within(note).getByText('免费')).toBeInTheDocument()
    // sourced 徽章（intro 有 provenance）；openHours / ticket 无 provenance → 未核实
    expect(within(note).getAllByText('有来源（待核对）').length).toBe(1)
    expect(within(note).getAllByText('未核实').length).toBe(2)
    expect(within(note).getAllByText(/按名称匹配，请自行核对/).length).toBeGreaterThanOrEqual(1)
    // 红线：不出现「已核实」
    expect(within(note).queryByText(/已核实/)).toBeNull()
  })

  it('无资料卡 / 多命中：三字段「未知」+ 补充入口；列表组件默认不传入口回调', () => {
    // 无卡（未传入口回调 → 只显示未知，不渲染按钮）
    const { unmount } = render(
      <ItineraryList day={day} activeStopId={stopId} onSelectStop={vi.fn()} poiCards={null} />,
    )
    const note = screen.getByRole('note', { name: `景点信息可信卡：${day.stops[0].name}` })
    expect(within(note).getAllByText('未知').length).toBe(3)
    expect(within(note).queryByTestId('stop-poi-card-supplement')).toBeNull()
    unmount()

    // 多命中（重名两条）→ findPoiCardByName 返回 null → 同口径未知
    const a = createPoiCard({ id: 'm1', name: day.stops[0].name, address: '地址A' }, 1_000)
    const b = createPoiCard({ id: 'm2', name: day.stops[0].name, address: '地址B' }, 1_000)
    if (!a.ok || !b.ok) throw new Error('fixture 失败')
    const empty = createEmptyPoiCardsRecord(1_000)
    if (!empty.ok) throw new Error('fixture 失败')
    render(
      <ItineraryList
        day={day}
        activeStopId={stopId}
        onSelectStop={vi.fn()}
        poiCards={{ ...empty.value, cards: [a.value, b.value] }}
      />,
    )
    const note2 = screen.getByRole('note', { name: `景点信息可信卡：${day.stops[0].name}` })
    expect(within(note2).getAllByText('未知').length).toBe(3)
  })
})

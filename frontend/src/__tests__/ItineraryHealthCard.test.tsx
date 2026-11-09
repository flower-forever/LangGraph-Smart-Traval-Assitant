/**
 * S3 · 行程体检卡 UI 测试（ItineraryHealthCard.tsx）。
 * 纯派生组件：随 day/pace/facts 变化即时重算；「去调整」只滚动，不自动改行程。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import ItineraryHealthCard from '../components/ItineraryHealthCard'
import { projectStopFacts } from '../lib/stopFacts'
import { createEmptyPoiCardsRecord, createPoiCard, type PoiCardsRecordV1 } from '../lib/poiCards'
import type { TripDay, TripLeg, TripStop } from '../lib/api'

const NOW = 1_800_000_000_000

/** 造一张带营业时间文本的卡，用 S2 投影产出 facts（与生产同口径）。 */
function factsWithOpening(stops: TripStop[], openingByName: Record<string, string>) {
  const empty = createEmptyPoiCardsRecord(1000)
  if (!empty.ok) throw new Error(empty.message)
  const cards = Object.entries(openingByName).map(([name, openingHours], i) => {
    const created = createPoiCard(
      {
        id: `card-${i}`,
        name,
        openingHours,
        provenance: {
          intro: null,
          openingHours: { source: 'manual', detail: '手工', recordedAt: NOW },
          ticket: null,
        },
      },
      1000,
    )
    if (!created.ok) throw new Error(created.message)
    return created.value
  })
  const record: PoiCardsRecordV1 = { ...empty.value, cards }
  return stops.map((stop) => projectStopFacts(stop, record, NOW))
}

let seq = 0
function makeStop(overrides: Partial<TripStop> = {}): TripStop {
  seq += 1
  return {
    id: `s${seq}`,
    name: `站点${seq}`,
    time: '09:00',
    duration_minutes: 60,
    description: '',
    address: '',
    location: null,
    ...overrides,
  }
}

function makeDay(stops: TripStop[]): TripDay {
  const legs: TripLeg[] = stops.slice(0, -1).map((stop, i) => ({
    from_stop_id: stop.id,
    to_stop_id: stops[i + 1].id,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 500,
    duration_minutes: 10,
    geometry: [],
    description: '',
  }))
  return { day: 2, date: '2026-05-04', title: '第二天', summary: '', stops, legs }
}

describe('ItineraryHealthCard', () => {
  it('汇总行显示「X 项冲突 / Y 项需确认 / Z 项无法核对」', () => {
    // 闭馆日（warning，卡上「周一闭馆」+ 2026-05-04 周一）+ 无卡站（unknown）
    const museum = makeStop({ name: '市博物馆', time: '09:00' })
    const noCard = makeStop({ name: '无名亭', time: '10:30' })
    const day = makeDay([museum, noCard])
    render(
      <ItineraryHealthCard
        day={day}
        pace="balanced"
        factsByStop={[...factsWithOpening([museum], { 市博物馆: '周一闭馆' }), null]}
      />,
    )

    const summary = screen.getByTestId('health-summary')
    expect(summary.textContent).toContain('1 项冲突')
    expect(summary.textContent).toContain('0 项需确认')
    expect(summary.textContent).toContain('1 项无法核对')
    cleanup()
  })

  it('展开详情列出 message+evidence；suggestion 出现；注明节奏是建议不是保证', () => {
    const museum = makeStop({ name: '市博物馆', time: '09:00' })
    const day = makeDay([museum])
    render(
      <ItineraryHealthCard
        day={day}
        pace="balanced"
        factsByStop={factsWithOpening([museum], { 市博物馆: '周一闭馆' })}
      />,
    )

    fireEvent.click(screen.getByTestId('health-toggle'))
    const items = screen.getByTestId('health-items')
    expect(items.textContent).toContain('无法核对')
    expect(items.textContent).toContain('依据：')
    expect(screen.getByTestId('itinerary-health-card').textContent).toContain('节奏是建议，不是保证')
    cleanup()
  })

  it('全部正常时展开显示「未发现问题」，仍注明不是「已确认可行」', () => {
    const day = makeDay([])
    render(<ItineraryHealthCard day={day} pace="packed" factsByStop={[]} />)
    fireEvent.click(screen.getByTestId('health-toggle'))
    expect(screen.getByTestId('health-items').textContent).toContain('未发现问题')
    expect(screen.getByTestId('health-items').textContent).toContain('不是「已确认可行」')
    cleanup()
  })

  it('有冲突时显示「去调整」；无冲突无需确认时不显示', () => {
    const museum = makeStop({ name: '市博物馆', time: '09:00' })
    const warnDay = makeDay([museum])
    const { unmount } = render(
      <ItineraryHealthCard
        day={warnDay}
        pace="balanced"
        factsByStop={factsWithOpening([museum], { 市博物馆: '周一闭馆' })}
      />,
    )
    expect(screen.getByTestId('health-go-adjust')).toBeTruthy()
    unmount()

    const emptyDay = makeDay([])
    render(<ItineraryHealthCard day={emptyDay} pace="balanced" factsByStop={[]} />)
    expect(screen.queryByTestId('health-go-adjust')).toBeNull()
    cleanup()
  })

  it('点「去调整」按 data-testid 找到编辑入口并触发滚动（该入口没有 id）', () => {
    const museum = makeStop({ name: '市博物馆', time: '09:00' })
    const day = makeDay([museum])
    // 复刻 App 的真实 DOM：编辑入口只有 data-testid="edit-entry"，没有 id。
    const entry = document.createElement('div')
    entry.setAttribute('data-testid', 'edit-entry')
    const scrollIntoView = vi.fn()
    entry.scrollIntoView = scrollIntoView
    document.body.appendChild(entry)

    render(
      <ItineraryHealthCard
        day={day}
        pace="balanced"
        factsByStop={factsWithOpening([museum], { 市博物馆: '周一闭馆' })}
      />,
    )
    fireEvent.click(screen.getByTestId('health-go-adjust'))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })

    // 目标缺席时保持原有静默兜底：不抛错、不再滚动。
    entry.remove()
    expect(() => fireEvent.click(screen.getByTestId('health-go-adjust'))).not.toThrow()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('行程数据变化即时重算：同组件不同 day 输出不同汇总', () => {
    const quiet = makeDay([])
    // 9 站超 relaxed 上限 4：busy 日应报 1 项 pace 冲突（notice）
    const busy = makeDay(
      Array.from({ length: 9 }, (_, i) =>
        makeStop({ time: `${String(9 + i).padStart(2, '0')}:00`, duration_minutes: 30 }),
      ),
    )
    const { container } = render(<ItineraryHealthCard day={quiet} pace="relaxed" factsByStop={[]} />)
    const before = container.querySelector('[data-testid="health-summary"]')?.textContent
    const { container: container2 } = render(<ItineraryHealthCard day={busy} pace="relaxed" factsByStop={Array(9).fill(null)} />)
    const after = container2.querySelector('[data-testid="health-summary"]')?.textContent
    expect(before).toContain('0 项需确认')
    // busy 日 9 站 > relaxed 上限 4 → pace notice（需确认）；
    // 9 个无卡站的营业/闭馆各合并为一条 unknown（不按站数展开）→ 2 项无法核对
    expect(after).toContain('1 项需确认')
    expect(after).toContain('2 项无法核对')
    cleanup()
  })
})

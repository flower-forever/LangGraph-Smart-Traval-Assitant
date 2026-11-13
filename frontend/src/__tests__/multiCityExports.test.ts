/**
 * 七期 S7 · 多城导出：目的地 / 标题只换成城市序列，其余口径不变。
 */
import { describe, expect, it } from 'vitest'

import type { Trip, TripDay } from '../lib/api'
import { tripToIcs } from '../lib/calendar'
import { tripCityLabel } from '../lib/cityScope'
import { safeIcsFilename } from '../lib/icsFile'
import { buildOfflineRoadbook } from '../lib/offlineRoadbook'
import { buildShareCardData, renderShareCard } from '../lib/shareCard'
import { safeTripBackupFilename } from '../lib/tripFile'
import { tripToMarkdown } from '../lib/tripMarkdown'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_700_000_000_000

function withCities(cities: readonly string[], patch: Partial<Trip> = {}): Trip {
  const days: TripDay[] = cities.map((city, index) => {
    const source = MOCK_TRIP.days[Math.min(index, MOCK_TRIP.days.length - 1)]
    return {
      ...source,
      day: index + 1,
      title: `第 ${index + 1} 天`,
      city,
    }
  })
  // 保持 trip.id 与 MOCK_TRIP 一致：ICS UID 绑定 tripId，便于证明事件载荷不变。
  return { ...MOCK_TRIP, days, ...patch }
}

/** 取出指定 x 的多行 text 块，每块是它的 tspan 行文本。 */
function textBlocksAt(svg: string, x: number): string[][] {
  const blocks: string[][] = []
  const pattern = new RegExp(`<text x="${x}"[^>]*>([\\s\\S]*?)</text>`, 'g')
  for (const match of svg.matchAll(pattern)) {
    const inner = match[1]
    if (!inner.includes('<tspan')) continue
    blocks.push([...inner.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((item) => item[1]))
  }
  return blocks
}

describe('多城分享卡', () => {
  const trip = withCities(['杭州', '杭州', '苏州'])
  const day1 = trip.days[0]
  const data = buildShareCardData(trip, day1)

  it('数据层目的地是城市序列，并标记多城', () => {
    expect(tripCityLabel(trip)).toBe('杭州 · 苏州')
    expect(data.destination).toBe('杭州 · 苏州')
    expect(data.destinationIsMultiCity).toBe(true)
  })

  it('宣纸雅集页眉使用城市序列', () => {
    const svg = renderShareCard('xuanzhi', data)
    expect(svg).toContain('行旅 · 杭州 · 苏州')
    expect(svg).not.toContain('行旅 · 杭州<')
  })

  it('登机牌目的地最多两行、拼起来正好是完整城市序列', () => {
    const svg = renderShareCard('boarding', data)
    const blocks = textBlocksAt(svg, 104)
    expect(blocks.length).toBe(1)
    expect(blocks[0].length).toBeGreaterThan(0)
    expect(blocks[0].length).toBeLessThanOrEqual(2)
    expect(blocks[0].join('')).toBe('杭州 · 苏州')
  })

  it('旅行日报目的地列最多两行且不丢字', () => {
    const svg = renderShareCard('daily', data)
    const block = textBlocksAt(svg, 740).find((lines) => lines.join('').includes('杭州'))
    expect(block).toBeDefined()
    expect(block!.length).toBeLessThanOrEqual(2)
    expect(block!.join('')).toBe('杭州 · 苏州')
  })

  it('六城长标签仍在两行内，宣纸页眉不压到闲章', () => {
    const longTrip = withCities(['杭州', '苏州', '南京', '无锡', '常州', '镇江'])
    const longData = buildShareCardData(longTrip, longTrip.days[0])
    expect(longData.destination).toBe('杭州 · 苏州 · 南京 · 无锡 · 常州 · 镇江')

    const boarding = renderShareCard('boarding', longData)
    const boardingBlocks = textBlocksAt(boarding, 104)
    expect(boardingBlocks.length).toBe(1)
    expect(boardingBlocks[0].length).toBeLessThanOrEqual(2)
    expect(boardingBlocks[0].join('')).toBe(longData.destination)

    const xuanzhi = renderShareCard('xuanzhi', longData)
    const kicker = textBlocksAt(xuanzhi, 96).find((lines) => lines[0]?.startsWith('行旅 · '))
    expect(kicker).toBeDefined()
    expect(kicker!.length).toBeGreaterThan(0)
    expect(kicker!.length).toBeLessThanOrEqual(2)
    expect(kicker!.join('')).toBe(`行旅 · ${longData.destination}`)
  })
})

describe('多城路书 / Markdown / ICS / 文件名', () => {
  const trip = withCities(['杭州', '杭州', '苏州'])

  it('离线路书页眉目的地是城市序列，正文分页结构不变', () => {
    const result = buildOfflineRoadbook(trip, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.html).toContain('<p class="meta">杭州 · 苏州 · 3 天')
    expect(result.html).not.toContain('<p class="meta">杭州 · 3 天')
    expect(result.html).toContain('data-day-panel="1"')
    expect(result.html).toContain('data-day-panel="3"')
  })

  it('Markdown 元信息目的地是城市序列，表格与站点段落不变', () => {
    const result = tripToMarkdown(trip)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.markdown).toContain('- 目的地：杭州 · 苏州')
    expect(result.markdown).toContain('## 第 3 天')
  })

  it('ICS 事件载荷与单城完全相同（SUMMARY/DESCRIPTION 没有目的地字段）', () => {
    const multi = tripToIcs(trip, { now: new Date(0) })
    const single = tripToIcs(MOCK_TRIP, { now: new Date(0) })
    expect(multi.eventCount).toBe(single.eventCount)
    expect(multi.ics).toBe(single.ics)
  })

  it('下载文件名使用城市序列并沿用现有清洗规则', () => {
    expect(safeIcsFilename(trip)).toBe('杭州 · 苏州-杭州三日漫步路书.ics')
    expect(safeTripBackupFilename(trip)).toBe('杭州 · 苏州-杭州三日漫步路书.json')

    const unsafe = withCities(['../杭州/西湖', '苏州'], { title: 'A:B' })
    const ics = safeIcsFilename(unsafe)
    const backup = safeTripBackupFilename(unsafe)
    for (const name of [ics, backup]) {
      expect(name).not.toMatch(/[\\/:*?"<>|]/)
      expect(name).not.toContain('..')
    }
  })
})

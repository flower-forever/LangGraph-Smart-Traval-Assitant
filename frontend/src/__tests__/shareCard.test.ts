/**
 * 分享卡片数据管道 + 六风格 SVG 模板（四期 S4）。
 * 全部离线、确定性：不读网络、不写存储、不依赖当前时间。
 */
import { describe, expect, it } from 'vitest'
import type { Trip, TripDay } from '../lib/api'
import {
  DEFAULT_SHARE_CARD_STYLE,
  SHARE_CARD_STYLES,
  buildShareCardData,
  renderShareCard,
} from '../lib/shareCard'
import { MOCK_TRIP } from './fixtures/trip'

const day1 = MOCK_TRIP.days[0]

function dayWith(overrides: Partial<TripDay>): TripDay {
  return { ...day1, ...overrides }
}

function tripWith(day: TripDay): Trip {
  return { ...MOCK_TRIP, days: [day] }
}

describe('buildShareCardData · 数据管道', () => {
  it('取行程/日标题、日期与有序站名，时刻折叠秒并保留缺失为「时间未知」', () => {
    const day = dayWith({
      stops: [
        { ...day1.stops[0], time: '09:00:00' },
        { ...day1.stops[1], time: '' },
        { ...day1.stops[2], time: '   ' },
        { ...day1.stops[0], time: undefined as unknown as string },
      ],
    })
    const data = buildShareCardData(tripWith(day), day)

    expect(data.tripTitle).toBe(MOCK_TRIP.title)
    expect(data.destination).toBe(MOCK_TRIP.destination)
    expect(data.dayNumber).toBe(1)
    expect(data.dayTitle).toBe(day1.title)
    expect(data.date).toBe('2026-04-03')
    expect(data.stops).toEqual([
      { name: '断桥残雪', time: '09:00' },
      { name: '平湖秋月', time: '时间未知' },
      { name: '湖滨晴雨', time: '时间未知' },
      { name: '断桥残雪', time: '时间未知' },
    ])
  })

  it('交通摘要按固定顺序聚合：步行在前、驾车在后，只统计实际 leg', () => {
    const reversed = dayWith({
      legs: [
        { ...day1.legs[1], mode: 'driving' },
        { ...day1.legs[1], mode: 'driving' },
        { ...day1.legs[0], mode: 'walking' },
      ],
    })
    expect(buildShareCardData(tripWith(reversed), reversed).transportSummary).toBe(
      '步行 1 段 · 驾车 2 段',
    )

    const noLegs = dayWith({ legs: [] })
    expect(buildShareCardData(tripWith(noLegs), noLegs).transportSummary).toBe('交通方式未知')
  })

  it('默认风格固定为宣纸雅集，六风格顺序与标签精确', () => {
    expect(DEFAULT_SHARE_CARD_STYLE).toBe('xuanzhi')
    expect(SHARE_CARD_STYLES.map((item) => item.id)).toEqual([
      'xuanzhi',
      'daily',
      'almanac',
      'riso',
      'midnight',
      'boarding',
    ])
    expect(SHARE_CARD_STYLES.map((item) => item.label)).toEqual([
      '宣纸雅集',
      '旅行日报',
      '老黄历',
      '双色印刷海报',
      '夜航卡',
      '登机牌',
    ])
  })
})

describe('renderShareCard · 六风格内容与确定性', () => {
  const data = buildShareCardData(MOCK_TRIP, day1)

  it.each(SHARE_CARD_STYLES.map((item) => item.id))(
    '%s：同一输入两次渲染字符串全等，且是 1080×1440 SVG',
    (style) => {
      const first = renderShareCard(style, data)
      const second = renderShareCard(style, data)
      expect(second).toBe(first)
      expect(first.startsWith('<svg')).toBe(true)
      expect(first).toContain('xmlns="http://www.w3.org/2000/svg"')
      expect(first).toContain('viewBox="0 0 1080 1440"')
      expect(first).toContain(`data-style="${style}"`)
    },
  )

  it.each(SHARE_CARD_STYLES.map((item) => item.id))(
    '%s：包含行程名、第 N 天、日期、每个站名、交通摘要与脚标',
    (style) => {
      const svg = renderShareCard(style, data)
      expect(svg).toContain(data.tripTitle)
      expect(svg).toContain('第 1 天')
      expect(svg).toContain('2026-04-03')
      for (const stop of data.stops) {
        expect(svg).toContain(stop.name)
      }
      expect(svg).toContain('步行 1 段 · 驾车 1 段')
      expect(svg).toContain('由 旅行助手 生成')
      expect(svg).not.toContain('已预订')
      expect(svg).not.toContain('已确认')
      expect(svg).not.toContain('已出票')
    },
  )

  it('日期缺失时六风格都显示「日期未知」，不补假日期', () => {
    const undated = buildShareCardData(MOCK_TRIP, MOCK_TRIP.days[2])
    expect(undated.date).toBeNull()
    for (const { id } of SHARE_CARD_STYLES) {
      const svg = renderShareCard(id, undated)
      expect(svg).toContain('日期未知')
      expect(svg).not.toContain('null')
    }
  })

  it('站点时刻缺失时六风格都显示「时间未知」', () => {
    const day = dayWith({
      stops: day1.stops.map((stop) => ({ ...stop, time: '' })),
    })
    const missing = buildShareCardData(tripWith(day), day)
    for (const { id } of SHARE_CARD_STYLES) {
      expect(renderShareCard(id, missing)).toContain('时间未知')
    }
  })

  it('站名/行程名中的 & < > " \' 全部 XML 转义，不破坏 SVG', () => {
    const dangerous = 'A&B <C> "D" \'E\''
    const day = dayWith({
      stops: [{ ...day1.stops[0], name: dangerous }],
    })
    const risky = buildShareCardData(tripWith(day), day)
    risky.tripTitle = dangerous
    risky.dayTitle = dangerous

    for (const { id } of SHARE_CARD_STYLES) {
      const svg = renderShareCard(id, risky)
      expect(svg).toContain('&amp;')
      expect(svg).toContain('&lt;')
      expect(svg).toContain('&gt;')
      expect(svg).toContain('&quot;')
      expect(svg).toContain('&#39;')
      expect(svg).not.toContain('<C>')

      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      expect(doc.querySelector('parsererror')).toBeNull()
      expect(doc.documentElement.tagName.toLowerCase()).toBe('svg')
    }
  })

  it('不含坐标、门票价格、来源原文或存储键值', () => {
    for (const { id } of SHARE_CARD_STYLES) {
      const svg = renderShareCard(id, data)
      expect(svg).not.toContain('120.1576')
      expect(svg).not.toContain('30.2726')
      expect(svg).not.toContain('门票')
      expect(svg).not.toContain('localStorage')
      expect(svg).not.toContain('sessionStorage')
      expect(svg).not.toContain('travel-assistant:')
    }
  })

  it('六风格输出两两不同', () => {
    const outputs = SHARE_CARD_STYLES.map((item) => renderShareCard(item.id, data))
    expect(new Set(outputs).size).toBe(outputs.length)
  })

  it('站名很多时不截断文字，自动缩小字号', () => {
    const many = {
      ...data,
      stops: Array.from({ length: 18 }, (_, index) => ({
        name: `第${index + 1}站·很长的站名用于验证自动缩放与换行`,
        time: '09:00',
      })),
    }
    for (const { id } of SHARE_CARD_STYLES) {
      const svg = renderShareCard(id, many)
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const content = (doc.documentElement.textContent ?? '').replace(/\s+/g, '')
      for (const stop of many.stops) {
        expect(content).toContain(stop.name.replace(/\s+/g, ''))
      }
    }
  })
})

/**
 * 七期 S7 · 城市序列标签与单城导出逐字节不变。
 *
 * 单城基线哈希来自 S7 改动前的 HEAD 输出（MOCK_TRIP + 固定 now）；
 * 任何一个导出模块在单城路径上多写一个字节，这里都会红。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { Trip, TripDay } from '../lib/api'
import { tripCityLabel } from '../lib/cityScope'
import { tripToIcs } from '../lib/calendar'
import { safeIcsFilename } from '../lib/icsFile'
import { buildOfflineRoadbook } from '../lib/offlineRoadbook'
import { buildShareCardData, renderShareCard, SHARE_CARD_STYLES } from '../lib/shareCard'
import { safeTripBackupFilename } from '../lib/tripFile'
import { safeTripMarkdownFilename, tripToMarkdown } from '../lib/tripMarkdown'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_700_000_000_000

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function dayAt(dayNumber: number, city?: string | null): TripDay {
  return {
    day: dayNumber,
    date: null,
    title: `第 ${dayNumber} 天`,
    summary: '',
    stops: [],
    legs: [],
    ...(city === undefined ? {} : { city }),
  }
}

function tripWithDays(days: TripDay[], patch: Partial<Trip> = {}): Trip {
  return {
    ...MOCK_TRIP,
    id: 'trip-city-label',
    destination: '杭州',
    days,
    ...patch,
  }
}

describe('tripCityLabel', () => {
  it('单城 / 空行程返回 destination 原文（含首尾空白也不改写）', () => {
    const single = tripWithDays([dayAt(1, '杭州'), dayAt(2, '杭州')], { destination: ' 杭州 ' })
    expect(tripCityLabel(single)).toBe(' 杭州 ')
    expect(tripCityLabel(tripWithDays([]))).toBe('杭州')
    expect(tripCityLabel(MOCK_TRIP)).toBe('杭州')
  })

  it('多城按出现顺序去重后用 " · " 连接，连续同城只出现一次', () => {
    const two = tripWithDays([dayAt(1, '杭州'), dayAt(2, '杭州'), dayAt(3, '苏州')])
    expect(tripCityLabel(two)).toBe('杭州 · 苏州')

    const backAndForth = tripWithDays([
      dayAt(1, '杭州'),
      dayAt(2, '苏州'),
      dayAt(3, '杭州'),
      dayAt(4, '苏州'),
    ])
    expect(tripCityLabel(backAndForth)).toBe('杭州 · 苏州')
  })

  it('无 day.city 的旧行程永远回退 destination，不会被当成多城', () => {
    const legacy = tripWithDays([dayAt(1), dayAt(2), dayAt(3)])
    expect(tripCityLabel(legacy)).toBe('杭州')
  })
})

describe('单城导出与 HEAD 逐字节一致', () => {
  const day1 = MOCK_TRIP.days[0]
  const data = buildShareCardData(MOCK_TRIP, day1)

  it('分享卡数据层仍是单城 destination，且标记为非多城', () => {
    expect(data.destination).toBe('杭州')
    expect(data.destinationIsMultiCity).toBe(false)
  })

  it.each([
    ['xuanzhi', '13a68eb490231785d669f6050fd670f016c30ad901eda68985b89792bb3e72de'],
    ['daily', '825358cf2091f57a22252936b32731ececf3a79a9293b419001435ed2630bced'],
    ['almanac', '13286d0e42497f452532a43e801f42e33c148c38e07bfc96aeb88083216fc858'],
    ['riso', 'b5e9fa8cd523d8370b5f6a3216e5b54bd504cecc7e78ea4e9ab4b978c34d04f3'],
    ['midnight', '0d2ff9bb2cc07addf7adcfaa46fe10b14a44e056961cf1168dfa7e94fd8eda70'],
    ['boarding', '5c071771f3876f9640bc471d741efe67982202de4f904bfe6f2f72b94b148a15'],
  ] as const)('%s 模板与 HEAD 输出哈希一致', (style, expected) => {
    expect(SHARE_CARD_STYLES.some((item) => item.id === style)).toBe(true)
    expect(sha256(renderShareCard(style, data))).toBe(expected)
  })

  it('离线路书单城 HTML 与 HEAD 输出哈希一致', () => {
    const result = buildOfflineRoadbook(MOCK_TRIP, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(sha256(result.html)).toBe(
      '3f0da2b53947fda87fa4c0fc941a35f257884471a9370b602dc4d11f67077c87',
    )
  })

  it('Markdown 单城内容与 HEAD 输出哈希一致，文件名仍是旧口径', () => {
    const result = tripToMarkdown(MOCK_TRIP)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(sha256(result.markdown)).toBe(
      '11e193e7ff26851634607cad6de71b2a05d1332092aaf949dddf75d92a07e0df',
    )
    expect(result.filename).toBe('杭州-杭州三日漫步路书.md')
    expect(safeTripMarkdownFilename(MOCK_TRIP)).toBe('杭州-杭州三日漫步路书.md')
  })

  it('ICS 单城内容与 HEAD 输出哈希一致，文件名与备份文件名不变', () => {
    expect(sha256(tripToIcs(MOCK_TRIP, { now: new Date(0) }).ics)).toBe(
      'd37843551e03d38f3f174f992e313f13d29874bbc19acb7359c72b9a63403e34',
    )
    expect(safeIcsFilename(MOCK_TRIP)).toBe('杭州-杭州三日漫步路书.ics')
    expect(safeTripBackupFilename(MOCK_TRIP)).toBe('杭州-杭州三日漫步路书.json')
  })
})

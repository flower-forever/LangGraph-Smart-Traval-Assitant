/**
 * 五期 S5 · 离线 HTML 路书：单文件、每日 tab、三态来源徽章、HTML 转义、
 * 2 MiB 上限与文件名安全化。全部离线，不依赖真实浏览器下载。
 */
import { describe, expect, it } from 'vitest'
import type { Trip } from '../lib/api'
import {
  MAX_ROADBOOK_HTML_BYTES,
  ROADBOOK_DRAFT_BADGE,
  buildOfflineRoadbook,
  roadbookFileName,
} from '../lib/offlineRoadbook'
import { POI_CARDS_FORMAT, POI_CARDS_VERSION, type PoiCardsRecordV1 } from '../lib/poiCards'
import { utf8ByteLength } from '../lib/savedTrips'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_760_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000

function cloneTrip(): Trip {
  return JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
}

function poiRecord(introRecordedAt: number = NOW - 1000): PoiCardsRecordV1 {
  return {
    format: POI_CARDS_FORMAT,
    version: POI_CARDS_VERSION,
    cards: [
      {
        id: 'card-1',
        identityKey: '断桥残雪',
        name: '断桥残雪',
        intro: '白堤东端，冬日雪后桥面半融半积。',
        openingHours: '全天',
        ticket: '免费',
        images: [],
        provenance: {
          intro: { source: 'manual', detail: '手工粘贴', recordedAt: introRecordedAt },
          openingHours: null,
          ticket: { source: 'tavily', detail: '官网', recordedAt: NOW - 181 * DAY_MS },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    updatedAt: NOW,
  }
}

function buildOk(trip: Trip = MOCK_TRIP): string {
  const result = buildOfflineRoadbook(trip, { now: NOW })
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result.html
}

describe('buildOfflineRoadbook · 单文件结构', () => {
  it('每日 tab + 站点时间/停留/地址/交通 + 小地图，字节数与实际 UTF-8 一致', () => {
    const result = buildOfflineRoadbook(MOCK_TRIP, { now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const html = result.html

    expect(result.bytes).toBe(utf8ByteLength(html))
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="zh-CN">')
    expect((html.match(/data-day-tab=/g) ?? []).length).toBe(3)
    expect((html.match(/data-day-panel=/g) ?? []).length).toBe(3)
    expect(html).toContain('第 1 天 · 西湖环湖')
    expect(html).toContain('09:00 · 停留 40 分钟')
    expect(html).toContain('杭州市西湖区白堤东端')
    expect(html).toContain('交通：步行 · 地图路线（按记录原样，未重新计算）')
    expect(html).toContain('示意直线（不是导航结果）')
    expect(html).toContain('data-mini-map="true"')
    expect(html).toContain('位置未知（未画入地图）：湖滨晴雨')
  })

  it('无外部脚本/样式/图片/字体/瓦片请求，并有 CSP 兜底', () => {
    const html = buildOk()
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toMatch(/<img[^>]+src=/i)
    expect(html).not.toContain('@import')
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i)
    expect(html).not.toContain('fetch(')
    expect(html).not.toContain('XMLHttpRequest')
    expect(html).toContain("default-src 'none'")
  })

  it('无日期数据时给出空态，不抛异常', () => {
    const trip = { ...cloneTrip(), days: [] }
    const html = buildOk(trip)
    expect(html).toContain('路书为空')
  })
})

describe('buildOfflineRoadbook · 来源徽章', () => {
  it('无资料卡时三字段一律「未知」，不编造来源', () => {
    const html = buildOk()
    expect(html).toContain('没有唯一匹配的资料卡，三字段均未知。')
    expect(html).toContain('未知')
    expect(html).not.toContain('已核实')
  })

  it('复用 S2 三态：有来源（待核对）/ 未核实，并标出可能过期', () => {
    const html = buildOk()
    const result = buildOfflineRoadbook(MOCK_TRIP, { now: NOW, poiCards: poiRecord() })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const page = result.html
    expect(page).toContain('有来源（待核对）')
    expect(page).toContain('未核实')
    expect(page).toContain('来源：手动粘贴 · 手工粘贴')
    expect(page).toContain('来源：网页资料 · 官网')
    expect(page).toContain('可能过期（超过 180 天）')
    expect(page).toContain('记录于')
    expect(page).not.toContain('已核实')
    expect(html).not.toContain('有来源（待核对）')
  })

  it('草稿来源带「草稿未应用」徽章；已应用行程不带', () => {
    const draft = buildOfflineRoadbook(MOCK_TRIP, { now: NOW, isDraft: true })
    expect(draft.ok).toBe(true)
    if (!draft.ok) return
    expect(draft.html).toContain(ROADBOOK_DRAFT_BADGE)
    expect(buildOk()).not.toContain(ROADBOOK_DRAFT_BADGE)
  })

  it('「记录于」按本地时区取日期，不再使用 UTC 日期（北京时间 08:00 前不差一天）', () => {
    // 2026-11-10T20:00Z = 北京时间 2026-11-11 04:00，旧实现会写成 11-10。
    const recordedAt = Date.UTC(2026, 10, 10, 20, 0, 0)
    const local = new Date(recordedAt)
    const pad = (value: number) => String(value).padStart(2, '0')
    const localDate = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
    const result = buildOfflineRoadbook(MOCK_TRIP, {
      now: recordedAt + 1000,
      poiCards: poiRecord(recordedAt),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.html).toContain(`记录于 ${localDate}`)
    const utcDate = local.toISOString().slice(0, 10)
    if (utcDate !== localDate) {
      expect(result.html).not.toContain(`记录于 ${utcDate}`)
    }
  })

  it('页脚不再宣称「不含资料卡原文」，明确只含三字段摘要', () => {
    const html = buildOk()
    expect(html).not.toContain('不含资料卡原文')
    expect(html).toContain('资料卡三字段（介绍 / 开放时间 / 门票）摘要')
  })
})

describe('buildOfflineRoadbook · HTML 转义', () => {
  it('标题/站名/地址/摘要中的标签、引号与 </script> 全部转义', () => {
    const trip = cloneTrip()
    trip.title = '<script>alert("x")</script>'
    trip.days[0].stops[0].name = '"><img src=x onerror=alert(1)>'
    trip.days[0].stops[0].address = '<b>addr</b>'
    trip.days[0].summary = '</script><script>alert(2)</script>'
    const html = buildOk(trip)

    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>addr</b>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;&gt;&lt;img')
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(2)')
    expect(html).toContain('&lt;b&gt;addr&lt;/b&gt;')
  })
})

describe('buildOfflineRoadbook · 2 MiB 上限与文件名', () => {
  it('超过 2 MiB 返回明确失败，不返回半份 HTML、不截断', () => {
    const trip = cloneTrip()
    trip.days[0].stops[0].address = 'x'.repeat(MAX_ROADBOOK_HTML_BYTES)
    const result = buildOfflineRoadbook(trip, { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_large')
    expect(result.limit).toBe(MAX_ROADBOOK_HTML_BYTES)
    expect(result.bytes).toBeGreaterThan(result.limit)
    expect('html' in result).toBe(false)
  })

  it('调用方只能收紧上限', () => {
    const result = buildOfflineRoadbook(MOCK_TRIP, { now: NOW, maxBytes: 1000 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.limit).toBe(1000)
  })

  it('文件名含行程名时安全化：无路径分隔符与 Windows 保留字符', () => {
    const trip = { ...cloneTrip(), title: '../../A:B*?"<>|' }
    const name = roadbookFileName(trip)
    expect(name.startsWith('travel-assistant-roadbook-')).toBe(true)
    expect(name.endsWith('.html')).toBe(true)
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
    expect(roadbookFileName({ ...cloneTrip(), title: '   ' })).toBe(
      'travel-assistant-roadbook-trip.html',
    )
  })
})

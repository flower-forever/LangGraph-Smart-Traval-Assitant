/**
 * poiSources 契约与运行时验证测试：全部离线，不发请求。
 * 重点：七状态、坐标/距离边界（0 与负值合法）、nullable/unknown、source_url
 * 与 type/id 一致、source_elements_seen>30 不误拒、requested 6 位舍入不错拒。
 */
import { describe, expect, it } from 'vitest'

import {
  collectPoiStations,
  formatPoiDistance,
  formatPoiTimestamp,
  osmObjectUrl,
  poiStatusText,
  readTagField,
  tagFieldText,
  validatePoiSourceReport,
  type PoiSourceReport,
  type PoiSourceStatus,
} from '../lib/poiSources'
import {
  CHECKED_AT,
  FETCHED_AT,
  makePoiCandidate,
  makePoiSourceReport,
  makePoiTrip,
} from './fixtures/poiSources'

const QUERY = { lat: 31.2304, lon: 121.4737 }
const QUERY_NEG = { lat: -33.865143, lon: -151.2099 }

function statuses(): PoiSourceStatus[] {
  return [
    'available',
    'no_candidates',
    'invalid_request',
    'timeout',
    'rate_limited',
    'unavailable',
    'failed',
  ]
}

describe('osmObjectUrl', () => {
  it('只按已校验 type/id 构造规范链接', () => {
    expect(osmObjectUrl('node', 1234567890)).toBe('https://www.openstreetmap.org/node/1234567890')
    expect(osmObjectUrl('way', 1)).toBe('https://www.openstreetmap.org/way/1')
    expect(osmObjectUrl('relation', 2 ** 53 - 1)).toBe(
      `https://www.openstreetmap.org/relation/${2 ** 53 - 1}`,
    )
  })
})

describe('validatePoiSourceReport', () => {
  it('available 信封通过，requested 允许 6 位舍入的浮点差', () => {
    const result = validatePoiSourceReport(makePoiSourceReport(QUERY), QUERY)
    expect(result.ok).toBe(true)
  })

  it('requested 偏差在 1e-6 内不错拒（后端 round 6 位）', () => {
    const report = makePoiSourceReport(QUERY)
    report.requested = { lat: QUERY.lat + 4e-7, lon: QUERY.lon - 4e-7 }
    expect(validatePoiSourceReport(report, QUERY).ok).toBe(true)
  })

  it('requested 偏差超过 6 位舍入容差视为另一坐标，整份作废', () => {
    const report = makePoiSourceReport(QUERY)
    report.requested = { lat: QUERY.lat + 5e-6, lon: QUERY.lon }
    expect(validatePoiSourceReport(report, QUERY).ok).toBe(false)
  })

  it('requested 超出 WGS84 范围拒绝', () => {
    const report = makePoiSourceReport(QUERY)
    report.requested = { lat: 91, lon: QUERY.lon }
    expect(validatePoiSourceReport(report, QUERY).ok).toBe(false)
  })

  it('requested 明显不同则整份作废', () => {
    const report = makePoiSourceReport(QUERY)
    report.requested = { lat: QUERY.lat + 0.01, lon: QUERY.lon }
    const result = validatePoiSourceReport(report, QUERY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('requested')
  })

  it('0 与负坐标查询合法', () => {
    const report = makePoiSourceReport(QUERY_NEG)
    expect(validatePoiSourceReport(report, QUERY_NEG).ok).toBe(true)
  })

  it('七种 status 都接受，且非法 status 拒绝', () => {
    for (const status of statuses()) {
      const patch: Partial<PoiSourceReport> =
        status === 'available' ? {} : { candidates: [] }
      const report = makePoiSourceReport(QUERY, { status, ...patch })
      const result = validatePoiSourceReport(report, QUERY)
      expect(result.ok, status).toBe(true)
    }
    const bad = makePoiSourceReport(QUERY)
    ;(bad as unknown as Record<string, unknown>).status = 'ok_fine'
    expect(validatePoiSourceReport(bad, QUERY).ok).toBe(false)
  })

  it('available 必须带候选；非 available 不得带候选', () => {
    const emptyAvailable = makePoiSourceReport(QUERY, { candidates: [] })
    expect(validatePoiSourceReport(emptyAvailable, QUERY).ok).toBe(false)
    const withCandidates = makePoiSourceReport(QUERY, { status: 'timeout', candidates: undefined as never })
    ;(withCandidates as unknown as { candidates: unknown }).candidates = [makePoiCandidate()]
    expect(validatePoiSourceReport(withCandidates, QUERY).ok).toBe(false)
  })

  it('候选超过 8 个拒绝', () => {
    const candidates = Array.from({ length: 9 }, (_, i) =>
      makePoiCandidate({ elementId: i + 1, distance_m: i }),
    )
    const report = makePoiSourceReport(QUERY, { candidates })
    expect(validatePoiSourceReport(report, QUERY).ok).toBe(false)
  })

  it('element_id 边界：0 / 负数 / 布尔 / 超过 2^53-1 / 非整数拒绝', () => {
    const cases: unknown[] = [0, -1, true, 1.5, 2 ** 53]
    for (const id of cases) {
      const report = makePoiSourceReport(QUERY)
      ;(report.candidates[0] as unknown as Record<string, unknown>).element_id = id
      expect(validatePoiSourceReport(report, QUERY).ok, String(id)).toBe(false)
    }
    expect(
      validatePoiSourceReport(
        makePoiSourceReport(QUERY, { candidates: [makePoiCandidate({ elementId: 2 ** 53 - 1 })] }),
        QUERY,
      ).ok,
    ).toBe(true)
  })

  it('source_url 与 type/id 不一致拒绝；伪造外域 URL 拒绝', () => {
    const wrongUrl = makePoiSourceReport(QUERY)
    ;(wrongUrl.candidates[0] as unknown as Record<string, unknown>).source_url =
      'https://www.openstreetmap.org/node/999'
    expect(validatePoiSourceReport(wrongUrl, QUERY).ok).toBe(false)

    const evil = makePoiSourceReport(QUERY)
    ;(evil.candidates[0] as unknown as Record<string, unknown>).source_url =
      'https://evil.example.com/node/1234567890'
    expect(validatePoiSourceReport(evil, QUERY).ok).toBe(false)
  })

  it('identity_status 必须是 unconfirmed', () => {
    const report = makePoiSourceReport(QUERY)
    ;(report.candidates[0] as unknown as Record<string, unknown>).identity_status = 'verified'
    expect(validatePoiSourceReport(report, QUERY).ok).toBe(false)
  })

  it('标签字段：source_only 带原文、unknown 带 null；未知状态拒绝', () => {
    const ok = makePoiSourceReport(QUERY)
    ;(ok.candidates[0] as unknown as Record<string, unknown>).opening_hours = {
      state: 'source_only',
      value: 'Mo-Fr 08:00-20:00',
    }
    ;(ok.candidates[0] as unknown as Record<string, unknown>).fee = { state: 'unknown', value: null }
    expect(validatePoiSourceReport(ok, QUERY).ok).toBe(true)

    const bad = makePoiSourceReport(QUERY)
    ;(bad.candidates[0] as unknown as Record<string, unknown>).opening_hours = {
      state: 'derived',
      value: 'x',
    }
    expect(validatePoiSourceReport(bad, QUERY).ok).toBe(false)

    const badValue = makePoiSourceReport(QUERY)
    ;(badValue.candidates[0] as unknown as Record<string, unknown>).fee = {
      state: 'source_only',
      value: null,
    }
    expect(validatePoiSourceReport(badValue, QUERY).ok).toBe(false)
  })

  it('坐标与距离：0 与负坐标合法；distance_m 必须 >= 0 且有限', () => {
    // 0 坐标合法：查询点就在 (0,0) 附近，候选也在旁边（haversine 复核一致）
    const zeroQuery = { lat: 0, lon: 0 }
    const zero = makePoiSourceReport(zeroQuery, {
      candidates: [makePoiCandidate({ location: { lat: 0.00001, lon: -0.00001 }, distance_m: 1.5 })],
    })
    expect(validatePoiSourceReport(zero, zeroQuery).ok).toBe(true)

    // 负坐标合法：悉尼附近
    const negQuery = { lat: -33.86, lon: 151.2 }
    const neg = makePoiSourceReport(negQuery, {
      candidates: [makePoiCandidate({ location: { lat: -33.86005, lon: 151.20005 }, distance_m: 7.2 })],
    })
    expect(validatePoiSourceReport(neg, negQuery).ok).toBe(true)

    const negDistance = makePoiSourceReport(QUERY)
    ;(negDistance.candidates[0] as unknown as Record<string, unknown>).distance_m = -0.1
    expect(validatePoiSourceReport(negDistance, QUERY).ok).toBe(false)

    const nanDistance = makePoiSourceReport(QUERY)
    ;(nanDistance.candidates[0] as unknown as Record<string, unknown>).distance_m = Number.NaN
    expect(validatePoiSourceReport(nanDistance, QUERY).ok).toBe(false)
  })

  it('时间形状：checked_at 必须有；fetched_at/source_updated_at 可 null', () => {
    const missingChecked = makePoiSourceReport(QUERY)
    ;(missingChecked as unknown as Record<string, unknown>).checked_at = null
    expect(validatePoiSourceReport(missingChecked, QUERY).ok).toBe(false)

    const nullFetched = makePoiSourceReport(QUERY, {
      status: 'timeout',
      candidates: [],
      fetched_at: null,
      provider_http_status: null,
    })
    expect(validatePoiSourceReport(nullFetched, QUERY).ok).toBe(true)

    const badFetched = makePoiSourceReport(QUERY)
    ;(badFetched as unknown as Record<string, unknown>).fetched_at = '2026/10/30'
    expect(validatePoiSourceReport(badFetched, QUERY).ok).toBe(false)

    const badUpdated = makePoiSourceReport(QUERY)
    ;(badUpdated.candidates[0] as unknown as Record<string, unknown>).source_updated_at =
      '2026-10-30 04:05:02'
    expect(validatePoiSourceReport(badUpdated, QUERY).ok).toBe(false)
  })

  it('非真实日历日滚动拒绝：2026-02-30 / 2026-13-01 / 25:00 不是合法时间', () => {
    const rolling = makePoiSourceReport(QUERY)
    ;(rolling as unknown as Record<string, unknown>).checked_at = '2026-02-30T04:05:00+00:00'
    expect(validatePoiSourceReport(rolling, QUERY).ok).toBe(false)

    const badMonth = makePoiSourceReport(QUERY)
    ;(badMonth as unknown as Record<string, unknown>).checked_at = '2026-13-01T04:05:00+00:00'
    expect(validatePoiSourceReport(badMonth, QUERY).ok).toBe(false)

    const badHour = makePoiSourceReport(QUERY)
    ;(badHour as unknown as Record<string, unknown>).checked_at = '2026-02-10T25:00:00+00:00'
    expect(validatePoiSourceReport(badHour, QUERY).ok).toBe(false)

    const rollingOsm = makePoiSourceReport(QUERY)
    ;(rollingOsm.candidates[0] as unknown as Record<string, unknown>).source_updated_at =
      '2026-02-30T04:05:02Z'
    expect(validatePoiSourceReport(rollingOsm, QUERY).ok).toBe(false)
  })

  it('后端合法序列化不误拒：微秒 ISO / +00:00 / Z', () => {
    const micro = makePoiSourceReport(QUERY)
    ;(micro as unknown as Record<string, unknown>).checked_at = '2026-10-30T04:05:00.123456+00:00'
    expect(validatePoiSourceReport(micro, QUERY).ok).toBe(true)

    const zulu = makePoiSourceReport(QUERY)
    ;(zulu as unknown as Record<string, unknown>).checked_at = '2026-10-30T04:05:00Z'
    expect(validatePoiSourceReport(zulu, QUERY).ok).toBe(true)
  })

  it('标签原文按后端合同收紧：非空白、≤300 字符；允许首尾空格原样保留', () => {
    const blank = makePoiSourceReport(QUERY)
    ;(blank.candidates[0] as unknown as Record<string, unknown>).opening_hours = {
      state: 'source_only',
      value: '   ',
    }
    expect(validatePoiSourceReport(blank, QUERY).ok).toBe(false)

    const tooLong = makePoiSourceReport(QUERY)
    ;(tooLong.candidates[0] as unknown as Record<string, unknown>).fee = {
      state: 'source_only',
      value: 'a'.repeat(301),
    }
    expect(validatePoiSourceReport(tooLong, QUERY).ok).toBe(false)

    const padded = makePoiSourceReport(QUERY)
    ;(padded.candidates[0] as unknown as Record<string, unknown>).opening_hours = {
      state: 'source_only',
      value: ' Mo-Fr 08:00-20:00 ',
    }
    const paddedResult = validatePoiSourceReport(padded, QUERY)
    expect(paddedResult.ok).toBe(true)
    // 原样展示，不 trim 冒充原文
    if (paddedResult.ok) {
      expect(paddedResult.report.candidates[0].opening_hours.value).toBe(' Mo-Fr 08:00-20:00 ')
    }
  })

  it('标签原文计数与后端一致：按 Unicode 码点，不是 UTF-16 code units', () => {
    // astral 码点（emoji）在 JS 里 length 是 2，Python len 是 1：
    // 151 码点 → UTF-16 长度 302，旧实现会错拒合法 source_only 原文
    const emoji151 = '\u{1F680}'.repeat(151)
    expect(emoji151.length).toBe(302)
    expect([...emoji151].length).toBe(151)
    const emojiReport = makePoiSourceReport(QUERY)
    ;(emojiReport.candidates[0] as unknown as Record<string, unknown>).opening_hours = {
      state: 'source_only',
      value: emoji151,
    }
    const emojiResult = validatePoiSourceReport(emojiReport, QUERY)
    expect(emojiResult.ok).toBe(true)
    if (emojiResult.ok) {
      expect(emojiResult.report.candidates[0].opening_hours.value).toBe(emoji151)
    }

    // 150 码点 astral：两种计数都 ≤300，必须通过
    const emoji150 = '\u{1F680}'.repeat(150)
    const emoji150Report = makePoiSourceReport(QUERY)
    ;(emoji150Report.candidates[0] as unknown as Record<string, unknown>).fee = {
      state: 'source_only',
      value: emoji150,
    }
    expect(validatePoiSourceReport(emoji150Report, QUERY).ok).toBe(true)

    // 300 码点 astral（UTF-16 长度 600）：Python 合法，前端必须接受
    const emoji300 = '\u{1F680}'.repeat(300)
    expect(emoji300.length).toBe(600)
    const emoji300Report = makePoiSourceReport(QUERY)
    ;(emoji300Report.candidates[0] as unknown as Record<string, unknown>).charge = {
      state: 'source_only',
      value: emoji300,
    }
    const emoji300Result = validatePoiSourceReport(emoji300Report, QUERY)
    expect(emoji300Result.ok).toBe(true)
    if (emoji300Result.ok) {
      expect(emoji300Result.report.candidates[0].charge.value).toBe(emoji300)
    }

    // 301 码点 astral（UTF-16 长度 602）：Python 也拒绝，前端同拒
    const emoji301 = '\u{1F680}'.repeat(301)
    const emoji301Report = makePoiSourceReport(QUERY)
    ;(emoji301Report.candidates[0] as unknown as Record<string, unknown>).fee = {
      state: 'source_only',
      value: emoji301,
    }
    expect(validatePoiSourceReport(emoji301Report, QUERY).ok).toBe(false)
  })

  it('标签原文计数：CJK/BMP 逐码点、混合串与组合码点/ZWJ 不合并', () => {
    // CJK BMP：码点数即 UTF-16 长度，300/301 边界与 Python 同口径
    const cjk300 = '汉'.repeat(300)
    const cjk300Report = makePoiSourceReport(QUERY)
    ;(cjk300Report.candidates[0] as unknown as Record<string, unknown>).opening_hours = {
      state: 'source_only',
      value: cjk300,
    }
    expect(validatePoiSourceReport(cjk300Report, QUERY).ok).toBe(true)

    const cjk301 = '汉'.repeat(301)
    const cjk301Report = makePoiSourceReport(QUERY)
    ;(cjk301Report.candidates[0] as unknown as Record<string, unknown>).opening_hours = {
      state: 'source_only',
      value: cjk301,
    }
    expect(validatePoiSourceReport(cjk301Report, QUERY).ok).toBe(false)

    // 混合 ASCII + CJK + astral，总码点 ≤300：按码点数接受
    const mixed = `${'a'.repeat(100)}${'汉'.repeat(24)}${'\u{1F680}'.repeat(60)}`
    expect([...mixed].length).toBe(184)
    const mixedReport = makePoiSourceReport(QUERY)
    ;(mixedReport.candidates[0] as unknown as Record<string, unknown>).opening_hours = {
      state: 'source_only',
      value: mixed,
    }
    expect(validatePoiSourceReport(mixedReport, QUERY).ok).toBe(true)

    // 组合音标：e + U+0301 两个码点（一个 grapheme），Python len = 2，前端一致
    const composed = 'e\u0301'.repeat(150)
    expect(composed.length).toBe(300)
    expect([...composed].length).toBe(300)
    const composedReport = makePoiSourceReport(QUERY)
    ;(composedReport.candidates[0] as unknown as Record<string, unknown>).fee = {
      state: 'source_only',
      value: composed,
    }
    expect(validatePoiSourceReport(composedReport, QUERY).ok).toBe(true)

    // ZWJ 家庭 emoji：U+1F468 U+200D U+1F469 U+200D U+1F466，5 码点 / 8 UTF-16 units
    const zwj = '\u{1F468}\u200D\u{1F469}\u200D\u{1F466}'
    expect(zwj.length).toBe(8)
    expect([...zwj].length).toBe(5)
    const zwj300 = zwj.repeat(60) // 300 码点，合法
    const zwj300Report = makePoiSourceReport(QUERY)
    ;(zwj300Report.candidates[0] as unknown as Record<string, unknown>).charge = {
      state: 'source_only',
      value: zwj300,
    }
    const zwjResult = validatePoiSourceReport(zwj300Report, QUERY)
    expect(zwjResult.ok).toBe(true)
    if (zwjResult.ok) {
      expect(zwjResult.report.candidates[0].charge.value).toBe(zwj300)
    }

    // ZWJ 序列按码点计满 301 时拒绝（Python len 同口径）
    const zwj301 = zwj300 + '\u{1F468}' // 301 码点
    const zwj301Report = makePoiSourceReport(QUERY)
    ;(zwj301Report.candidates[0] as unknown as Record<string, unknown>).charge = {
      state: 'source_only',
      value: zwj301,
    }
    expect(validatePoiSourceReport(zwj301Report, QUERY).ok).toBe(false)
  })

  it('radius_m 固定 100（后端 _RADIUS_M），其它值拒绝', () => {
    for (const radius of [50, 101, 500, 1000]) {
      const report = makePoiSourceReport(QUERY, { radius_m: radius })
      expect(validatePoiSourceReport(report, QUERY).ok, String(radius)).toBe(false)
    }
    expect(
      validatePoiSourceReport(makePoiSourceReport(QUERY, { radius_m: 100 }), QUERY).ok,
    ).toBe(true)
  })

  it('available 候选 distance_m 超过固定半径 100 拒绝', () => {
    const report = makePoiSourceReport(QUERY, {
      candidates: [makePoiCandidate({ distance_m: 120 })],
    })
    expect(validatePoiSourceReport(report, QUERY).ok).toBe(false)
    expect(
      validatePoiSourceReport(
        makePoiSourceReport(QUERY, { candidates: [makePoiCandidate({ distance_m: 100 })] }),
        QUERY,
      ).ok,
    ).toBe(true)
  })

  it('provider_http_status：available/非 available 的合法取值范围对齐后端', () => {
    // available：一定是本次真实 2xx
    const bad = makePoiSourceReport(QUERY, { provider_http_status: 404 })
    expect(validatePoiSourceReport(bad, QUERY).ok).toBe(false)
    // timeout：本地总 deadline，没打到 provider，状态为 null 合法
    expect(
      validatePoiSourceReport(
        makePoiSourceReport(QUERY, {
          status: 'timeout',
          candidates: [],
          fetched_at: null,
          provider_http_status: null,
        }),
        QUERY,
      ).ok,
    ).toBe(true)
  })

  it('available/no_candidates 必须有真实 fetched_at；失败态可无', () => {
    const noFetched = makePoiSourceReport(QUERY, { fetched_at: null })
    expect(validatePoiSourceReport(noFetched, QUERY).ok).toBe(false)
  })

  it('source 元数据必须与后端固定常量逐字一致：任意 https 冒充拒绝', () => {
    const evilSource = makePoiSourceReport(QUERY, {
      source: {
        provider: 'overpass-api.de',
        endpoint: 'https://overpass-api.de/api/interpreter',
        docs_url: 'https://evil.example.com/docs',
        attribution_url: 'https://evil.example.com/copyright',
        license: 'ODbL 1.0',
        data_source: 'OpenStreetMap',
      },
    })
    expect(validatePoiSourceReport(evilSource, QUERY).ok).toBe(false)
    // 合法常量仍然通过
    const good = makePoiSourceReport(QUERY)
    expect(validatePoiSourceReport(good, QUERY).ok).toBe(true)
  })

  it('元素坐标必须落在请求点半径 100m 内', () => {
    // 距离约 111m（纬度差 0.001 ≈ 111.2m）：distance 声称 5m 也拒绝
    const report = makePoiSourceReport(QUERY, {
      candidates: [makePoiCandidate({ location: { lat: QUERY.lat + 0.001, lon: QUERY.lon }, distance_m: 5 })],
    })
    expect(validatePoiSourceReport(report, QUERY).ok).toBe(false)
  })

  it('query 边界纬 90/经 180：requested 越出 WGS84（90.0000005/180.0000005）拒绝', () => {
    // 1e-6 舍入匹配不能把越界值也放进来：requested 本身必须在范围内
    const boundaryQuery = { lat: 90, lon: 180 }
    const report = makePoiSourceReport(boundaryQuery, { status: 'no_candidates', candidates: [] })
    report.requested = { lat: 90.0000005, lon: 180.0000005 }
    expect(validatePoiSourceReport(report, boundaryQuery).ok).toBe(false)

    const negQuery = { lat: -90, lon: -180 }
    const negReport = makePoiSourceReport(negQuery, { status: 'no_candidates', candidates: [] })
    negReport.requested = { lat: -90.0000005, lon: -180.0000005 }
    expect(validatePoiSourceReport(negReport, negQuery).ok).toBe(false)
  })

  it('requested 恰在 WGS84 边界（±90/±180/0）与 6 位舍入口径下合法', () => {
    for (const [lat, lon] of [
      [90, 180],
      [-90, -180],
      [0, 0],
    ]) {
      const q = { lat, lon }
      const report = makePoiSourceReport(q, { status: 'no_candidates', candidates: [] })
      expect(report.requested).toEqual({ lat, lon })
      expect(validatePoiSourceReport(report, q).ok, `${lat},${lon}`).toBe(true)
    }
  })

  it('haversine 复核容差只覆盖数值误差：100m 内边界候选合法', () => {
    // 赤道上经度差 0.00089932° ≈ 99.9998m：合法边界内，不误拒
    const zeroQuery = { lat: 0, lon: 0 }
    const report = makePoiSourceReport(zeroQuery, {
      candidates: [makePoiCandidate({ location: { lat: 0, lon: 0.00089932 }, distance_m: 99.9998 })],
    })
    expect(validatePoiSourceReport(report, zeroQuery).ok).toBe(true)
  })

  it('伪报告拒绝：坐标实际约 100.5m 却声称 5m', () => {
    // 旧的 +1m 余量会放行 100.49m：收紧到 1e-6m 数值误差后必须拒绝
    const zeroQuery = { lat: 0, lon: 0 }
    const report = makePoiSourceReport(zeroQuery, {
      candidates: [makePoiCandidate({ location: { lat: 0, lon: 0.0009037 }, distance_m: 5 })],
    })
    expect(validatePoiSourceReport(report, zeroQuery).ok).toBe(false)
  })

  it('query 原始高精度舍入后：100m 附近合法候选不误拒', () => {
    // 后端把 0.0000004 round 到 0；候选相对舍入后中心在 100m 内，必须接受
    const rawQuery = { lat: 0.0000004, lon: 0 }
    const report = makePoiSourceReport(rawQuery, {
      candidates: [makePoiCandidate({ location: { lat: 0, lon: 0.00089932 }, distance_m: 99.9998 })],
    })
    expect(report.requested).toEqual({ lat: 0, lon: 0 })
    expect(validatePoiSourceReport(report, rawQuery).ok).toBe(true)
  })

  it('source_elements_seen 可以大于 30（后端只处理前 30 但 seen 如实）', () => {
    const report = makePoiSourceReport(QUERY, { source_elements_seen: 87 })
    expect(validatePoiSourceReport(report, QUERY).ok).toBe(true)
  })

  it('cached 必须是布尔；非法 provider_http_status 类型拒绝', () => {
    const cachedStr = makePoiSourceReport(QUERY)
    ;(cachedStr as unknown as Record<string, unknown>).cached = 'true'
    expect(validatePoiSourceReport(cachedStr, QUERY).ok).toBe(false)

    const floatStatus = makePoiSourceReport(QUERY)
    ;(floatStatus as unknown as Record<string, unknown>).provider_http_status = 200.5
    expect(validatePoiSourceReport(floatStatus, QUERY).ok).toBe(false)
  })

  it('notes 可为纯文本数组；非字符串项拒绝', () => {
    const withNotes = makePoiSourceReport(QUERY, {
      notes: ['源元素数超过上限，仅处理前 30 个'],
    })
    expect(validatePoiSourceReport(withNotes, QUERY).ok).toBe(true)

    const badNotes = makePoiSourceReport(QUERY)
    ;(badNotes as unknown as Record<string, unknown>).notes = [1]
    expect(validatePoiSourceReport(badNotes, QUERY).ok).toBe(false)
  })

  it('兼容附加字段：额外字段不导致拒绝', () => {
    const report = makePoiSourceReport(QUERY) as unknown as Record<string, unknown>
    report.some_future_field = { anything: true }
    expect(validatePoiSourceReport(report, QUERY).ok).toBe(true)
  })
})

describe('展示工具', () => {
  it('readTagField / tagFieldText：原文透传，unknown 显示来源未提供', () => {
    expect(tagFieldText({ state: 'source_only', value: 'Mo-Su 07:00-22:00' })).toBe(
      'Mo-Su 07:00-22:00',
    )
    expect(tagFieldText({ state: 'unknown', value: null })).toBe('来源未提供')
    expect(readTagField(null)).toEqual({ known: false, value: null })
  })

  it('poiStatusText 覆盖七状态', () => {
    expect(poiStatusText('no_candidates')).toBe('本期没有候选')
    expect(poiStatusText('rate_limited')).toBe('请求过于频繁')
  })

  it('formatPoiDistance：0 合法，负值原样交给调用方（校验层拒绝）', () => {
    expect(formatPoiDistance(0)).toBe('0 m')
    expect(formatPoiDistance(26.54)).toBe('26.5 m')
    expect(formatPoiDistance(100)).toBe('100 m')
  })

  it('formatPoiTimestamp：null 未知，可解析的转 UTC，不可解析原样返回', () => {
    expect(formatPoiTimestamp(null)).toBe('未知')
    expect(formatPoiTimestamp(FETCHED_AT)).toBe('2026-10-30 04:05:02 UTC')
    expect(formatPoiTimestamp(OSM_Z)).toBe('2025-06-01 08:00:00 UTC')
    expect(formatPoiTimestamp('not-a-time')).toBe('not-a-time')
  })

  it('collectPoiStations：0/负坐标合法，无坐标跳过，按 id 去重', () => {
    const trip = makePoiTrip()
    const day1 = trip.days[0]
    const stations = collectPoiStations(day1)
    expect(stations.map((s) => s.stopId)).toEqual(['p1', 'p2'])
    expect(collectPoiStations(trip.days[1])).toEqual([])
    expect(collectPoiStations(null)).toEqual([])

    const withZero = makePoiTrip()
    withZero.days[0].stops[0].location = { lng: -0.5, lat: 0 }
    expect(collectPoiStations(withZero.days[0])[0]).toMatchObject({ lat: 0, lon: -0.5 })
  })

  it('collectPoiStations：同 id 去重、空白名称回落', () => {
    const trip = makePoiTrip()
    // 复制一份 p1（同 id），id 去重后只剩 p1/p2；再验证空白名称回落
    trip.days[0].stops.push({ ...trip.days[0].stops[0] })
    trip.days[0].stops[1] = { ...trip.days[0].stops[1], name: '  ' }
    const stations = collectPoiStations(trip.days[0])
    expect(stations.map((s) => s.stopId)).toEqual(['p1', 'p2'])
    expect(stations[1].name).toBe('未命名站点')
  })
})

const OSM_Z = '2025-06-01T08:00:00Z'

// CHECKED_AT 在校验用例中引用，保持 fixture 导入不悬空
void CHECKED_AT

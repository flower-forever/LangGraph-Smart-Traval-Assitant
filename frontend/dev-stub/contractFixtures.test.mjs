/**
 * 契约夹具防漂移测试：contract-server 的响应构造器必须始终通过前端真实校验器。
 * 关键约束（与 runner 同源）：这里 import 的就是 runner 运行时调用的
 * buildPlanTrip / buildReplanResponse / buildMapRefreshResponse / buildWeatherReport /
 * buildPoiReport，不保留任何平行构造副本。构造器或前端契约任一侧变化，这里先红。
 *
 * replan / map-refresh 的响应校验依赖请求（parent / day / date / stops 投影），
 * 用前端真实 build 构造请求，再喂给桩构造器生成响应，最后用真实 validators 检验——
 * 与浏览器会话里的完整链路一致。
 */
import { describe, expect, it } from 'vitest'
import { isTripLike } from '../src/lib/api'
import { buildDayReplanRequest, validateDayReplanResponse } from '../src/lib/dayReplan'
import { buildMapRefreshRequest, validateMapRefreshResponse } from '../src/lib/mapRefresh'
import { validatePoiSourceReport } from '../src/lib/poiSources'
import { validateWeatherDayReport } from '../src/lib/weather'
import {
  isIsoCalendarDate,
  isShareableWebSourceUrl,
  normalizeWebSearchQuery,
  validateWebSearchReport,
} from '../src/lib/webSources'
import { WEB_SOURCES_MODES } from './webSourcesFixtures.mjs'
import {
  buildMapRefreshResponse,
  buildPlanTrip,
  buildPoiReport,
  buildReplanResponse,
  buildWeatherReport,
} from './contract-server.mjs'
import {
  buildWebSearchInvalidResponse,
  buildWebSearchReport,
  parseWebSearchRequestBody,
} from './webSourcesFixtures.mjs'

const planTrip = buildPlanTrip('plan')
const exampleTrip = buildPlanTrip('example')

describe('契约夹具与前端真实校验器（同源构造器）', () => {
  it('plan / example 行程通过 isTripLike，且两者可区分', () => {
    expect(isTripLike(planTrip)).toBe(true)
    expect(isTripLike(exampleTrip)).toBe(true)
    expect(exampleTrip.title).not.toBe(planTrip.title)
    expect(exampleTrip.source).toBe('example')
    expect(planTrip.source).toBe('agent')
  })

  it('replan：前端 build 构造请求 → 桩构造器生成响应 → validateDayReplanResponse', () => {
    const built = buildDayReplanRequest(planTrip, 1, '换成博物馆主题', {
      travel_mode: 'walking',
      parentRevision: 0,
    })
    if (!built.ok) throw new Error(`buildDayReplanRequest 意外失败：${built.message}`)
    const response = buildReplanResponse(built.request)
    const result = validateDayReplanResponse(response, built.request)
    if (!result.ok) {
      throw new Error(`validateDayReplanResponse 拒绝：${result.message ?? JSON.stringify(result)}`)
    }
    expect(result.ok).toBe(true)
    // parent 回显请求令牌
    expect(response.parent).toEqual(built.request.parent)
  })

  it('map-refresh：前端 build 构造请求 → 桩构造器生成响应 → validateMapRefreshResponse', () => {
    const built = buildMapRefreshRequest(planTrip, 1, {
      travel_mode: 'walking',
      parentRevision: 0,
    })
    if (!built.ok) throw new Error(`buildMapRefreshRequest 意外失败：${built.message}`)
    const response = buildMapRefreshResponse(built.request)
    const result = validateMapRefreshResponse(response, built.request)
    if (!result.ok) {
      throw new Error(`validateMapRefreshResponse 拒绝：${result.message ?? JSON.stringify(result)}`)
    }
    expect(result.ok).toBe(true)
    expect(response.parent).toEqual(built.request.parent)
  })

  it('weather：URL 查询参数 → 桩构造器 → validateWeatherDayReport', () => {
    const query = new URLSearchParams('lat=30.238&lon=120.148&date=2026-11-07')
    const built = buildWeatherReport(query)
    if (built.error) throw new Error(`buildWeatherReport 意外失败：${built.error}`)
    const result = validateWeatherDayReport(built.report, { lat: 30.238, lon: 120.148, date: '2026-11-07' })
    if (!result.ok) throw new Error(`validateWeatherDayReport 拒绝：${result.reason}`)
    expect(result.ok).toBe(true)
    expect(result.report.status).toBe('available')
    expect(result.report.requested_date).toBe('2026-11-07')
  })

  it('poi：URL 查询参数 → 桩构造器 → validatePoiSourceReport', () => {
    const query = new URLSearchParams('lat=30.238&lon=120.148')
    const built = buildPoiReport(query)
    if (built.error) throw new Error(`buildPoiReport 意外失败：${built.error}`)
    const result = validatePoiSourceReport(built.report, { lat: 30.238, lon: 120.148 })
    if (!result.ok) throw new Error(`validatePoiSourceReport 拒绝：${result.reason}`)
    expect(result.ok).toBe(true)
    expect(built.report.candidates.length).toBeGreaterThan(0)
  })

  it('非法查询参数返回 error（桩会回 400）', () => {
    expect(buildWeatherReport(new URLSearchParams('lat=x&lon=0&date=bad')).error).toBeTruthy()
    expect(buildPoiReport(new URLSearchParams('lat=x&lon=y')).error).toBeTruthy()
  })
})

/**
 * 网页资料搜索契约：与 runner 同源的 buildWebSearchReport 构造器 + 前端真实
 * validateWebSearchReport 闭环。构造器或前端契约任一侧漂移，这里先红。
 */
const WEB_QUERY = '西湖 开放时间'
const FEFF_QUERY = '\uFEFF西湖 开放时间'

function expectWebReportOk(built, sentQuery) {
  if (built.error) throw new Error(`buildWebSearchReport 意外失败：${built.error}`)
  const result = validateWebSearchReport(built.report, sentQuery)
  if (!result.ok) {
    throw new Error(`validateWebSearchReport 拒绝（${built.report.status}）：${result.reason}`)
  }
  return result.report
}

describe('网页资料搜索契约（同源构造器 + 真实校验器）', () => {
  it('构造器模式集合固定，可用模式都产出过真实校验的信封', () => {
    expect(WEB_SOURCES_MODES).toEqual([
      'available',
      'no_results',
      'no_usable_results',
      'no_key',
      'unavailable',
    ])
    for (const mode of WEB_SOURCES_MODES) {
      expectWebReportOk(buildWebSearchReport(mode, WEB_QUERY), WEB_QUERY)
    }
  })

  it('available：2 条安全 https 结果、纯文本摘录、真实 fixture 日期且不宣称已核实', () => {
    const report = expectWebReportOk(buildWebSearchReport('available', WEB_QUERY), WEB_QUERY)
    expect(report.status).toBe('available')
    expect(report.results).toHaveLength(2)
    expect(report.results_seen).toBe(2)
    for (const result of report.results) {
      expect(isShareableWebSourceUrl(result.url)).toBe(true)
      expect(result.url.startsWith('https://')).toBe(true)
      // 固定夹具不含 HTML 标记；完整信封已经通过真实 validator。
      expect(result.snippet === null || !/[<>]/u.test(result.snippet)).toBe(true)
      if (result.publication_date !== null) {
        expect(isIsoCalendarDate(result.publication_date)).toBe(true)
      }
    }
    expect(report.content_status).toBe('unverified')
    expect(report.notes.join(' ')).toContain('未核实')
    expect(report.checked_at).toBeTruthy()
    expect(report.fetched_at).toBeTruthy()
    expect(report.requested_query).toBe(WEB_QUERY)
    expect(report.provider_http_status).toBe(200)
    expect(report.source.provider).toBe('tavily')
    // 与组件测试同源：构造器不冒充其它 provider/endpoint
    expect(report.source.endpoint).toBe('https://api.tavily.com/search')
  })

  it('query 原样进入信封：FEFF 属 Python 非空白，必须原样保留不被 trim', () => {
    const normalized = normalizeWebSearchQuery(FEFF_QUERY)
    expect(normalized).toBe(FEFF_QUERY)
    const report = expectWebReportOk(buildWebSearchReport('available', FEFF_QUERY), FEFF_QUERY)
    expect(report.requested_query).toBe(FEFF_QUERY)
  })

  it('no_results：真空结果；no_usable_results：seen>0 且 results 空 + notes 说明', () => {
    const noResults = expectWebReportOk(buildWebSearchReport('no_results', WEB_QUERY), WEB_QUERY)
    expect(noResults.results).toEqual([])
    expect(noResults.results_seen).toBe(0)
    expect(noResults.fetched_at).toBeTruthy()

    const noUsable = expectWebReportOk(buildWebSearchReport('no_usable_results', WEB_QUERY), WEB_QUERY)
    expect(noUsable.results).toEqual([])
    expect(noUsable.results_seen).toBeGreaterThan(0)
    expect(noUsable.notes.join(' ')).toContain('无法安全展示')
    expect(noUsable.fetched_at).toBeTruthy()
  })

  it('no_key / unavailable：固定 reason、provider_http_status 语义一致、不携带结果', () => {
    for (const [mode, providerStatus] of [['no_key', null], ['unavailable', 503]]) {
      const report = expectWebReportOk(buildWebSearchReport(mode, WEB_QUERY), WEB_QUERY)
      expect(report.status).toBe(mode)
      expect(report.reason).toBeTruthy()
      expect(report.results).toEqual([])
      expect(report.results_seen).toBe(0)
      expect(report.fetched_at).toBeNull()
      expect(report.provider_http_status).toBe(providerStatus)
      expect(report.requested_query).toBe(WEB_QUERY)
      // 固定文案，不回显上游原文
      expect(report.reason).not.toContain('http')
      expect(report.checked_at).toBeTruthy()
    }
  })

  it('未知模式：构造器直接报 error（桩只实现约定模式）', () => {
    expect(buildWebSearchReport('rate_limited', WEB_QUERY).error).toBeTruthy()
    expect(buildWebSearchReport('available-but-wrong', WEB_QUERY).error).toBeTruthy()
  })
})

describe('网页资料搜索请求体（固定 422，不回显原文）', () => {
  it('合法 {query} 解析为 query；多余字段/非对象/缺 query 返回 422 信封', () => {
    expect(parseWebSearchRequestBody({ query: '西湖' })).toEqual({ query: '西湖' })
    expect(parseWebSearchRequestBody({ query: '西湖', max_results: 5 })?.query).toBeUndefined()
    expect(parseWebSearchRequestBody({ q: '西湖' })).toBeUndefined()
    expect(parseWebSearchRequestBody('西湖')).toBeUndefined()
    expect(parseWebSearchRequestBody(null)).toBeUndefined()
    expect(parseWebSearchRequestBody(undefined)).toBeUndefined()
    expect(parseWebSearchRequestBody(42)).toBeUndefined()
  })

  it('422 形状固定：固定 detail + report:null + x-web-sources-status 头', () => {
    const invalid = buildWebSearchInvalidResponse()
    expect(invalid.status).toBe(422)
    expect(invalid.body).toEqual({
      detail: 'query 必须为去除首尾空白后 1 到 300 个字符的文本',
      report: null,
    })
    expect(invalid.headers['x-web-sources-status']).toBe('invalid_request')
    // 不回显任何输入原文的通道：body 里没有第二个字符串字段
    expect(Object.keys(invalid.body)).toEqual(['detail', 'report'])
  })
})

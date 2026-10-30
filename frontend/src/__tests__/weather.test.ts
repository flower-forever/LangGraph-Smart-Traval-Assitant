/**
 * weather.ts 纯函数测试：DTO 校验、坐标/日期初值、WMO 映射与单位换算。
 * 不涉及网络与 React。
 */
import { describe, expect, it } from 'vitest'

import {
  collectWeatherStations,
  formatCoverage,
  formatUtcOffset,
  formatWeatherMetric,
  formatWeatherTimestamp,
  initialWeatherDate,
  isCalendarDate,
  readWeatherField,
  validateWeatherDayReport,
  weatherCodeLabel,
  weatherCodeText,
} from '../lib/weather'
import type { WeatherDayQuery } from '../lib/weather'
import { makeDay, makeForecast, makeStop, makeWeatherReport } from '../test/weatherFixtures'

const QUERY: WeatherDayQuery = { lat: 31.33, lon: 120.57, date: '2026-05-01' }

describe('日期与坐标初值', () => {
  it('只接受真实日历日的 YYYY-MM-DD', () => {
    expect(isCalendarDate('2026-05-01')).toBe(true)
    expect(isCalendarDate('2026-02-29')).toBe(false)
    expect(isCalendarDate('2026-13-01')).toBe(false)
    expect(isCalendarDate('2026-5-1')).toBe(false)
    expect(isCalendarDate(null)).toBe(false)
  })

  it('day.date 合法时作为初值，非法或缺失时返回空串（不冒充今天）', () => {
    expect(initialWeatherDate('2026-05-01')).toBe('2026-05-01')
    expect(initialWeatherDate('not-a-date')).toBe('')
    expect(initialWeatherDate(null)).toBe('')
    expect(initialWeatherDate(undefined)).toBe('')
  })
})

describe('本日站点坐标', () => {
  it('只取本日有合法 WGS84 坐标的站点，0 与负坐标不算缺值', () => {
    const day = makeDay(2, null, [
      makeStop('a', '零点', { lng: 0, lat: 0 }),
      makeStop('b', '南半球', { lng: 151.21, lat: -33.86 }),
      makeStop('c', '无坐标', null),
      makeStop('d', '经纬越界', { lng: 200, lat: 91 }),
    ])
    expect(collectWeatherStations(day)).toEqual([
      { stopId: 'a', name: '零点', lat: 0, lon: 0 },
      { stopId: 'b', name: '南半球', lat: -33.86, lon: 151.21 },
    ])
  })

  it('没有站点或没有坐标时返回空数组', () => {
    expect(collectWeatherStations(null)).toEqual([])
    expect(collectWeatherStations(makeDay(1, null, [makeStop('x', '无坐标', null)]))).toEqual([])
  })
})

describe('WeatherDayReport 校验', () => {
  it('接受与请求一致的 available 信封', () => {
    const result = validateWeatherDayReport(makeWeatherReport(QUERY), QUERY)
    expect(result.ok).toBe(true)
  })

  it('requested_date 与请求不一致时拒绝', () => {
    const result = validateWeatherDayReport(
      makeWeatherReport(QUERY, { requested_date: '2026-05-02' }),
      QUERY,
    )
    expect(result).toEqual({ ok: false, reason: 'requested_date 与本次请求不一致' })
  })

  it('coordinate.requested 与请求坐标不一致时拒绝', () => {
    const report = makeWeatherReport(QUERY)
    report.coordinate.requested = { lat: 31.34, lon: 120.57 }
    const result = validateWeatherDayReport(report, QUERY)
    expect(result.ok).toBe(false)
  })

  it('source 必须是 https 来源，verified 必须是 false', () => {
    const insecure = makeWeatherReport(QUERY)
    insecure.source.attribution_url = 'http://open-meteo.com/'
    expect(validateWeatherDayReport(insecure, QUERY).ok).toBe(false)

    const verified = makeWeatherReport(QUERY)
    // 显式构造一个不该出现的 verified=true，确认不会放行
    verified.coordinate = { ...verified.coordinate, verified: true as false }
    expect(validateWeatherDayReport(verified, QUERY).ok).toBe(false)
  })

  it('非 available 状态不能携带 forecast', () => {
    const report = makeWeatherReport(QUERY, { status: 'failed', forecast: makeForecast(QUERY.date) })
    const result = validateWeatherDayReport(report, QUERY)
    expect(result.ok).toBe(false)
  })

  it('out_of_range 必须带实际覆盖且日期在范围外', () => {
    const outside = makeWeatherReport(QUERY, {
      status: 'out_of_range',
      forecast: null,
      coverage: { first_date: '2026-05-02', last_date: '2026-05-10', count: 9 },
    })
    expect(validateWeatherDayReport(outside, QUERY).ok).toBe(true)

    const inside = makeWeatherReport(QUERY, {
      status: 'out_of_range',
      forecast: null,
      coverage: { first_date: '2026-04-30', last_date: '2026-05-10', count: 11 },
    })
    expect(validateWeatherDayReport(inside, QUERY).ok).toBe(false)
  })

  it('available 的日期必须在 coverage 内', () => {
    const report = makeWeatherReport(QUERY, {
      coverage: { first_date: '2026-05-02', last_date: '2026-05-10', count: 9 },
    })
    expect(validateWeatherDayReport(report, QUERY).ok).toBe(false)
  })

  it('六变量缺失或单位字段缺失时拒绝整份响应', () => {
    const report = makeWeatherReport(QUERY)
    delete (report.forecast as unknown as { values: Record<string, unknown> }).values.wind_speed_10m_max
    expect(validateWeatherDayReport(report, QUERY).ok).toBe(false)
  })
})

describe('WMO 代码与单位展示', () => {
  it('只映射官方表内代码，表外代码保留代码并显示未知', () => {
    expect(weatherCodeLabel(0)).toBe('晴')
    expect(weatherCodeLabel(95)).toBe('雷暴')
    expect(weatherCodeLabel(42)).toBeNull()
    expect(weatherCodeText(42)).toBe('未知（代码 42）')
    expect(weatherCodeText(null)).toBe('未知')
    expect(weatherCodeText(2.5)).toBe('未知')
  })

  it('0 值保留、null 与单位不符显示未知，负温可用', () => {
    const forecast = makeForecast(QUERY.date, {
      temperature_2m_max: -3,
      precipitation_probability_max: 0,
      precipitation_sum: 0,
      wind_speed_10m_max: null,
    })
    expect(formatWeatherMetric(readWeatherField(forecast, 'temperature_2m_max'))).toBe('-3 °C')
    expect(formatWeatherMetric(readWeatherField(forecast, 'precipitation_probability_max'))).toBe('0%')
    expect(formatWeatherMetric(readWeatherField(forecast, 'precipitation_sum'))).toBe('0 mm')
    expect(formatWeatherMetric(readWeatherField(forecast, 'wind_speed_10m_max'))).toBe('未知')

    const mismatched = makeForecast(QUERY.date, {}, { temperature_2m_min: 'K' })
    expect(formatWeatherMetric(readWeatherField(mismatched, 'temperature_2m_min'))).toBe('未知')
  })

  it('概率越界 / 负降水按未知处理，不展示可疑数字', () => {
    const forecast = makeForecast(QUERY.date, {
      precipitation_probability_max: 130,
      precipitation_sum: -1,
    })
    expect(readWeatherField(forecast, 'precipitation_probability_max').known).toBe(false)
    expect(readWeatherField(forecast, 'precipitation_sum').known).toBe(false)
  })

  it('时间与时区按 UTC 语义展示，未知就写未知', () => {
    expect(formatWeatherTimestamp('2026-10-30T04:00:02+00:00')).toBe('2026-10-30 04:00:02 UTC')
    expect(formatWeatherTimestamp(null)).toBe('未知')
    expect(formatUtcOffset(28800)).toBe('UTC+08:00')
    expect(formatUtcOffset(-18000)).toBe('UTC-05:00')
    expect(formatUtcOffset(null)).toBe('未知')
  })

  it('覆盖范围缺失时明确未知', () => {
    expect(formatCoverage({ first_date: '2026-05-01', last_date: '2026-05-16', count: 16 })).toBe(
      '2026-05-01 至 2026-05-16（共 16 天）',
    )
    expect(formatCoverage({ first_date: null, last_date: null, count: 0 })).toBe('未知')
  })
})

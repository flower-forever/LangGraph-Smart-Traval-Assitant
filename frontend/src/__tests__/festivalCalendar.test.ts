/**
 * 六期 S3 · 节日表相交测试（彩蛋②纯逻辑层）。
 * 覆盖：相交 / 单日 / 中段扫过 / 多节日取最早 / 2027 官方口径日期 / 不相交 /
 * 过表（2028 起）/ 缺日期 / 非法与溢出日期。零网络零存储零时钟。
 */
import { describe, expect, it } from 'vitest'

import { festivalGreetingFor } from '../lib/festivalCalendar'

interface DayLike {
  date: string | null
}

function daysWithDates(dates: Array<string | null>): { days: DayLike[] } {
  return { days: dates.map((date) => ({ date })) }
}

describe('festivalGreetingFor · 节日表相交', () => {
  it('行程区间覆盖节日：2026 端午命中「端午安康」', () => {
    const trip = daysWithDates(['2026-06-18', '2026-06-20'])
    expect(festivalGreetingFor(trip)).toEqual({ name: '端午', greeting: '端午安康' })
  })

  it('行程单日恰在节日内：2026 中秋', () => {
    const trip = daysWithDates(['2026-09-25', null])
    expect(festivalGreetingFor(trip)).toEqual({ name: '中秋', greeting: '中秋团圆' })
  })

  it('行程中段扫过节日（起点终点都不在节内）也命中', () => {
    const trip = daysWithDates(['2026-09-20', '2026-09-26', '2026-09-30'])
    expect(festivalGreetingFor(trip)).toEqual({ name: '中秋', greeting: '中秋团圆' })
  })

  it('命中多个节日取行程区间内最早开始的一个', () => {
    const trip = daysWithDates(['2026-09-26', '2026-10-03'])
    // 中秋 9.25–9.27 与国庆 10.1–10.7 都相交；中秋更早
    expect(festivalGreetingFor(trip)).toEqual({ name: '中秋', greeting: '中秋团圆' })
  })

  it('2027 春节（国务院口径 2.5–2.13）命中', () => {
    const trip = daysWithDates(['2027-02-05', '2027-02-07'])
    expect(festivalGreetingFor(trip)).toEqual({ name: '春节', greeting: '新春快乐' })
  })

  it('2027 端午单日（6.9）命中', () => {
    const trip = daysWithDates(['2027-06-09'])
    expect(festivalGreetingFor(trip)).toEqual({ name: '端午', greeting: '端午安康' })
  })

  it('2027 中秋单日（9.15）命中', () => {
    const trip = daysWithDates(['2027-09-15'])
    expect(festivalGreetingFor(trip)).toEqual({ name: '中秋', greeting: '中秋团圆' })
  })

  it('节日区间之外不相交：普通工作周无彩蛋', () => {
    const trip = daysWithDates(['2026-03-10', '2026-03-12'])
    expect(festivalGreetingFor(trip)).toBeNull()
  })

  it('过表（2028 起）返回 null，不报错', () => {
    expect(festivalGreetingFor(daysWithDates(['2028-01-01', '2028-01-03']))).toBeNull()
    expect(festivalGreetingFor(daysWithDates(['2029-10-01']))).toBeNull()
  })

  it('全部 day.date 缺失返回 null', () => {
    expect(festivalGreetingFor(daysWithDates([null, null]))).toBeNull()
  })

  it('非法日期字符串按无日期处理（不抛错）：月/日越界的溢出日期不算合法日期', () => {
    expect(festivalGreetingFor(daysWithDates(['2026-13-40', 'not-a-date']))).toBeNull()
    expect(festivalGreetingFor(daysWithDates(['2026-02-31']))).toBeNull()
  })

  it('空行程（无 days）返回 null', () => {
    expect(festivalGreetingFor(daysWithDates([]))).toBeNull()
  })
})

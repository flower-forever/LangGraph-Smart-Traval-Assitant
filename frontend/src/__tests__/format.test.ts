import { describe, expect, it } from 'vitest'
import { displayTime, formatDateTime, formatDistance, formatDuration, formatDate, stopSearchQuery } from '../lib/format'
import { dayToText } from '../components/ItineraryList'
import { MOCK_TRIP } from './fixtures/trip'

describe('format helpers', () => {
  it('displayTime 折叠秒', () => {
    expect(displayTime('09:00:00')).toBe('09:00')
    expect(displayTime('9:05')).toBe('9:05')
  })

  it('formatDuration', () => {
    expect(formatDuration(45)).toBe('约 45 分钟')
    expect(formatDuration(130)).toBe('约 2 小时 10 分钟')
    expect(formatDuration(null)).toBe('时长未知')
  })

  it('formatDistance', () => {
    expect(formatDistance(850)).toBe('850 米')
    expect(formatDistance(12340)).toBe('12.3 公里')
    expect(formatDistance(null)).toBe('距离未知')
  })

  it('formatDate 处理纯日期，不受时区影响', () => {
    expect(formatDate('2026-04-03')).toContain('2026 年 4 月 3 日')
    expect(formatDate(null)).toBe('')
  })

  it('formatDateTime 展示本地保存时间，非法值不显示伪造日期', () => {
    const timestamp = new Date(2026, 9, 29, 7, 43).getTime()
    expect(formatDateTime(timestamp)).toBe('2026 年 10 月 29 日 07:43')
    expect(formatDateTime(0)).toBe('时间未知')
    expect(formatDateTime(Number.NaN)).toBe('时间未知')
  })

  it('stopSearchQuery 拼接名称与地址', () => {
    expect(stopSearchQuery(MOCK_TRIP.days[0].stops[0])).toBe('断桥残雪 杭州市西湖区白堤东端')
  })
})

describe('dayToText 导出文本', () => {
  const text = dayToText(MOCK_TRIP.days[0])

  it('包含时刻、站名、讲解、路段信息', () => {
    expect(text).toContain('第 1 天 · 西湖环湖')
    expect(text).toContain('09:00 断桥残雪')
    expect(text).toContain('讲解：')
    expect(text).toContain('示意直线')
    expect(text).toContain('缺少坐标')
  })

  it('不包含 HTML 标签（模型文案按纯文本输出）', () => {
    expect(text).not.toMatch(/<[a-z][^>]*>/i)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trip } from '../lib/api'
import { tripToIcs } from '../lib/calendar'
import {
  ICS_MIME_TYPE,
  createIcsArtifact,
  downloadIcs,
  safeIcsFilename,
  sanitizeFilenamePart,
} from '../lib/icsFile'
import { MOCK_TRIP } from './fixtures/trip'

const FIXED_NOW = new Date('2026-01-01T08:00:00.000Z')

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 失败'))
    reader.readAsText(blob)
  })
}

function undatedTrip(): Trip {
  return {
    ...MOCK_TRIP,
    id: 'trip-undated',
    days: MOCK_TRIP.days.map((day) => ({ ...day, date: null })),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('safeIcsFilename：安全文件名', () => {
  it('用目的地与标题生成可读、稳定的中文文件名', () => {
    expect(safeIcsFilename(MOCK_TRIP)).toBe('杭州-杭州三日漫步路书.ics')
    expect(safeIcsFilename(MOCK_TRIP)).toBe(safeIcsFilename(MOCK_TRIP))
  })

  it('清掉路径分隔符、Windows 非法字符、控制字符与首尾点号', () => {
    const filename = safeIcsFilename({
      ...MOCK_TRIP,
      destination: '../杭州/西湖',
      title: '..A:*?"<>|B\u0001C. ',
    })
    expect(filename.endsWith('.ics')).toBe(true)
    expect(filename).not.toMatch(/[\\/:*?"<>|\u0000-\u001f]/)
    expect(filename.startsWith('.')).toBe(false)
    expect(filename).not.toContain('..')
    expect(filename.length).toBeLessThanOrEqual(84)
  })

  it('Windows 保留设备名不会直接当作文件名', () => {
    expect(safeIcsFilename({ ...MOCK_TRIP, destination: '', title: 'CON' })).toBe('trip-CON.ics')
    expect(safeIcsFilename({ ...MOCK_TRIP, destination: 'nul', title: '' })).toBe('trip-nul.ics')
  })

  it('标题为空时退到 trip.id，再退到 trip.ics；超长标题按码点截断', () => {
    expect(safeIcsFilename({ ...MOCK_TRIP, destination: '', title: '' })).toBe('trip-mock-1.ics')
    expect(safeIcsFilename({ ...MOCK_TRIP, id: '', destination: '  ', title: '  ' })).toBe('trip.ics')

    const long = safeIcsFilename({ ...MOCK_TRIP, destination: '', title: '路'.repeat(200) })
    expect(Array.from(long).length).toBeLessThanOrEqual(84)
    expect(long.endsWith('.ics')).toBe(true)
  })

  it('sanitizeFilenamePart 对非字符串输入返回空串', () => {
    expect(sanitizeFilenamePart(undefined)).toBe('')
    expect(sanitizeFilenamePart(42)).toBe('')
  })
})

describe('createIcsArtifact / downloadIcs', () => {
  it('生成 Blob 时使用 UTF-8 日历 MIME，内容与 tripToIcs 一致', () => {
    const artifact = createIcsArtifact(MOCK_TRIP, { now: FIXED_NOW })
    expect(artifact.filename).toBe('杭州-杭州三日漫步路书.ics')
    expect(artifact.blob.type).toBe(ICS_MIME_TYPE)
    expect(artifact.result.eventCount).toBe(3)
  })

  it('没有有效事件时不创建 Blob URL、不点击链接，也不下载空文件', () => {
    const createObjectURL = vi.fn(() => 'blob:never')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const outcome = downloadIcs(undatedTrip(), {
      now: FIXED_NOW,
      document,
      createObjectURL,
      revokeObjectURL,
      schedule: (callback) => callback(),
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('no_events')
    expect(outcome.result.eventCount).toBe(0)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('有事件时创建并回收 Blob URL，点击后移除临时链接', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:fake-ics')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const outcome = downloadIcs(MOCK_TRIP, {
      now: FIXED_NOW,
      document,
      createObjectURL,
      revokeObjectURL,
      schedule: (callback) => callback(),
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.filename).toBe('杭州-杭州三日漫步路书.ics')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe(ICS_MIME_TYPE)
    expect(click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-ics')
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)

    const text = await readBlob(blob)
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(text).toContain('BEGIN:VEVENT')
    expect(text).toContain('SUMMARY:【示例】断桥残雪')
    expect(text).not.toContain('NaN')
  })

  it('用户选的首日会传给导出结果；没有 document 时返回可展示的失败', () => {
    const undated = undatedTrip()
    const withDate = downloadIcs(undated, {
      now: FIXED_NOW,
      firstDate: '2028-02-27',
      document,
      createObjectURL: () => 'blob:dated',
      revokeObjectURL: () => {},
      schedule: (callback) => callback(),
    })
    expect(withDate.ok).toBe(true)
    if (!withDate.ok) return
    expect(withDate.result.provisionalDates).toHaveLength(3)
    expect(withDate.result.ics).toContain('DTSTART:20280229T100000')

    const noDocument = downloadIcs(MOCK_TRIP, {
      now: FIXED_NOW,
      document: null,
      schedule: (callback) => callback(),
    })
    expect(noDocument.ok).toBe(false)
    if (noDocument.ok) return
    expect(noDocument.reason).toBe('unsupported')
    if (noDocument.reason === 'unsupported') {
      expect(noDocument.message).toContain('无法创建下载链接')
    }
  })

  it('时区选项显式转发：下载的 Blob 与 tripToIcs 预览逐字节一致（UTC 模式）', async () => {
    const outcome = downloadIcs(MOCK_TRIP, {
      now: FIXED_NOW,
      timeZone: 'Asia/Shanghai',
      document,
      createObjectURL: () => 'blob:zone',
      revokeObjectURL: () => {},
      schedule: (callback) => callback(),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.exportTimeZone).toBe('Asia/Shanghai')
    const direct = tripToIcs(MOCK_TRIP, { now: FIXED_NOW, timeZone: 'Asia/Shanghai' })
    expect(outcome.result.ics).toBe(direct.ics)
    const text = await readBlob(outcome.blob)
    expect(text).toContain('DTSTART:20260403T010000Z')
  })

  it('createIcsArtifact 与 downloadIcs 在同一时区选项下结果一致', () => {
    const artifact = createIcsArtifact(MOCK_TRIP, { now: FIXED_NOW, timeZone: 'America/New_York' })
    const direct = tripToIcs(MOCK_TRIP, { now: FIXED_NOW, timeZone: 'America/New_York' })
    expect(artifact.result.ics).toBe(direct.ics)
    expect(artifact.result.exportTimeZone).toBe('America/New_York')
    expect(artifact.result.ics).toContain('DTSTART:20260403T130000Z')
  })

  it('无效时区：返回 invalid_timezone 而非 no_events，不创建 Blob URL、不点击链接', () => {
    const createObjectURL = vi.fn(() => 'blob:never')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const outcome = downloadIcs(MOCK_TRIP, {
      now: FIXED_NOW,
      timeZone: 'Not/AZone',
      document,
      createObjectURL,
      revokeObjectURL,
      schedule: (callback) => callback(),
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('invalid_timezone')
    expect(outcome.result.eventCount).toBe(0)
    // 判定依据是导出级 configurationError 元数据；真实站点仍逐站报 timezone_invalid
    expect(outcome.result.configurationError?.code).toBe('invalid_timezone')
    expect(outcome.result.skipped.some((entry) => entry.reason === 'timezone_invalid')).toBe(true)
    expect(outcome.result.skipped.every((entry) => entry.stopId !== '' || entry.reason !== 'timezone_invalid')).toBe(true)
    // 有日期的站点报 timezone_invalid；无日期的第 3 天仍按原优先级报 day_date_missing
    expect(outcome.result.skipped.some((entry) => entry.reason === 'day_date_missing')).toBe(true)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('无效时区与站点遍历解耦：空行程也报 invalid_timezone，不误报 no_events、不创建 Blob URL', () => {
    const createObjectURL = vi.fn(() => 'blob:never')
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    // 空 days：没有可遍历站点，invalid_timezone 不能被推断逻辑漏成 no_events
    const emptyTrip: Trip = { ...MOCK_TRIP, id: 'trip-empty', days: [] }
    const emptyOutcome = downloadIcs(emptyTrip, {
      now: FIXED_NOW,
      timeZone: 'Not/AZone',
      document,
      createObjectURL,
      revokeObjectURL,
      schedule: (callback) => callback(),
    })
    expect(emptyOutcome.ok).toBe(false)
    if (emptyOutcome.ok) return
    expect(emptyOutcome.reason).toBe('invalid_timezone')
    // 空行程时配置错误不进 skipped：没有站点就不该有站点级跳过记录，也不该有伪站点
    expect(emptyOutcome.result.skippedCount).toBe(0)
    expect(emptyOutcome.result.skipped).toEqual([])
    expect(emptyOutcome.result.configurationError?.code).toBe('invalid_timezone')
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()

    // 全部缺日期且未选首日：坏 zone 也必须报 invalid_timezone 而不是 no_events
    const undatedOutcome = downloadIcs(undatedTrip(), {
      now: FIXED_NOW,
      timeZone: 'Not/AZone',
      document,
      createObjectURL,
      revokeObjectURL,
      schedule: (callback) => callback(),
    })
    expect(undatedOutcome.ok).toBe(false)
    if (undatedOutcome.ok) return
    expect(undatedOutcome.reason).toBe('invalid_timezone')
    // 全缺日期时唯一 skip 是真实站点的 day_date_missing；坏 zone 只进 configurationError
    expect(undatedOutcome.result.skippedCount).toBeGreaterThan(0)
    expect(undatedOutcome.result.skipped.every((entry) => entry.day >= 1 && entry.stopId !== '')).toBe(true)
    expect(undatedOutcome.result.skipped.some((entry) => entry.reason === 'timezone_invalid')).toBe(false)
    expect(undatedOutcome.result.configurationError?.code).toBe('invalid_timezone')

    // 对照：合法时区的空/无日期行程仍然报 no_events，语义不受影响
    const validZoneEmpty = downloadIcs(emptyTrip, {
      now: FIXED_NOW,
      timeZone: 'Asia/Shanghai',
      document,
      createObjectURL,
      revokeObjectURL,
      schedule: (callback) => callback(),
    })
    expect(validZoneEmpty.ok).toBe(false)
    if (validZoneEmpty.ok) return
    expect(validZoneEmpty.reason).toBe('no_events')
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})

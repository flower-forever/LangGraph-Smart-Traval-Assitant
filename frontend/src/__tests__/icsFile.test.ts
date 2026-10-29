import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trip } from '../lib/api'
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
})

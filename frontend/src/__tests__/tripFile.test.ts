import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trip, TripLocation } from '../lib/api'
import { MAX_GEOMETRY_POINTS_PER_LEG, utf8ByteLength } from '../lib/savedTrips'
import type { TextFileReader, TripUploadLike } from '../lib/tripFile'
import {
  TRIP_URL_REVOKE_DELAY_MS,
  createTripBackupArtifact,
  downloadTripBackup,
  readTripBackupFile,
  safeTripBackupFilename,
} from '../lib/tripFile'
import {
  MAX_TRIP_FILE_BYTES,
  TRIP_JSON_SHARE_NOTICE,
  TRIP_TRANSFER_FORMAT,
  TRIP_TRANSFER_MIME_TYPE,
  TRIP_TRANSFER_VERSION,
} from '../lib/tripTransfer'
import { MOCK_TRIP } from './fixtures/trip'

const FIXED_NOW = new Date('2026-01-01T08:00:00.000Z')
/** 备份文件名上限：80 个码点 + '.json' */
const MAX_FILENAME_CODE_POINTS = 85

function backupTextOf(trip: Trip): string {
  const artifact = createTripBackupArtifact(trip, { now: FIXED_NOW })
  if (!artifact.ok) throw new Error(`生成备份失败：${artifact.reason}`)
  return artifact.json
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 失败'))
    reader.readAsText(blob)
  })
}

/** 只实现 read / error / abort 三种行为的假 FileReader */
function fakeReader(behavior: 'load' | 'error' | 'abort', text = ''): TextFileReader {
  const reader: TextFileReader = {
    result: null,
    error: null,
    onload: null,
    onerror: null,
    onabort: null,
    readAsText() {
      queueMicrotask(() => {
        if (behavior === 'load') {
          reader.result = text
          reader.onload?.()
          return
        }
        if (behavior === 'error') {
          reader.error = new Error('E: 读盘失败 /secret/path')
          reader.onerror?.()
          return
        }
        reader.onabort?.()
      })
    },
  }
  return reader
}

function deepPoints(count: number): TripLocation[] {
  return Array.from({ length: count }, (_, index) => ({
    lng: Number((120.123456789012 + index * 0.000012345678).toFixed(12)),
    lat: Number((30.987654321098 - index * 0.000009876543).toFixed(12)),
  }))
}

beforeEach(() => {
  window.localStorage.clear()
  document.body.innerHTML = ''
  // 默认把真实点击挡掉：jsdom 不实现下载导航，未 stub 的 click 会异步抛 "Not implemented"
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  window.localStorage.clear()
})

describe('safeTripBackupFilename：安全文件名', () => {
  it('用目的地与标题生成可读、稳定、可重复的 .json 文件名', () => {
    expect(safeTripBackupFilename(MOCK_TRIP)).toBe('杭州-杭州三日漫步路书.json')
    expect(safeTripBackupFilename(MOCK_TRIP)).toBe(safeTripBackupFilename(MOCK_TRIP))
  })

  it('清掉路径分隔符、Windows 非法字符与控制字符，不产生目录跳转', () => {
    const filename = safeTripBackupFilename({
      ...MOCK_TRIP,
      destination: '../../etc/杭州',
      title: '..A:*?"<>|B\u0000C\u001fD. ',
    })
    expect(filename.endsWith('.json')).toBe(true)
    expect(filename).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/)
    expect(filename.startsWith('.')).toBe(false)
    expect(filename).not.toContain('..')
    expect(filename).not.toContain('/')
  })

  it('Windows 保留设备名不会直接当作文件名', () => {
    expect(safeTripBackupFilename({ ...MOCK_TRIP, destination: '', title: 'CON' })).toBe(
      'trip-CON.json',
    )
    for (const reserved of ['nul', 'aux', 'com1', 'lpt9', 'PRN']) {
      const name = safeTripBackupFilename({ ...MOCK_TRIP, destination: '', title: reserved })
      expect(name).toBe(`trip-${reserved}.json`)
    }
  })

  it('标题为空时退到 trip.id，再退到 trip.json', () => {
    expect(safeTripBackupFilename({ ...MOCK_TRIP, destination: '', title: '' })).toBe(
      'trip-mock-1.json',
    )
    expect(safeTripBackupFilename({ ...MOCK_TRIP, id: '', destination: '  ', title: '  ' })).toBe(
      'trip.json',
    )
  })

  it('超长标题按码点截断，不切坏 emoji 代理对，总长有上限', () => {
    const long = safeTripBackupFilename({
      ...MOCK_TRIP,
      destination: '',
      title: '🚤'.repeat(300),
    })
    expect(Array.from(long).length).toBeLessThanOrEqual(MAX_FILENAME_CODE_POINTS)
    expect(long.endsWith('.json')).toBe(true)
    // 没有落单的高位代理项
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(long)).toBe(false)
    expect(/[\uDC00-\uDFFF]/.test(long.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false)
  })

  it('非字符串字段（脏数据）不会让文件名抛错', () => {
    const dirty = { ...MOCK_TRIP, destination: 42, title: null } as unknown as Trip
    expect(safeTripBackupFilename(dirty)).toBe('trip-mock-1.json')
  })
})

describe('createTripBackupArtifact：Blob 与内容', () => {
  it('产出带 UTF-8 charset 的 JSON Blob，内容与 tripTransfer 的文本逐字一致', async () => {
    const artifact = createTripBackupArtifact(MOCK_TRIP, { now: FIXED_NOW })
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return

    expect(artifact.filename).toBe('杭州-杭州三日漫步路书.json')
    expect(artifact.blob.type).toBe(TRIP_TRANSFER_MIME_TYPE)
    expect(artifact.blob.type).toContain('charset=utf-8')
    expect(artifact.json).toBe(backupTextOf(MOCK_TRIP))
    expect(artifact.exportedAt).toBe('2026-01-01T08:00:00.000Z')
    expect(artifact.notices).toEqual([TRIP_JSON_SHARE_NOTICE])

    const text = await readBlob(artifact.blob)
    expect(text).toBe(artifact.json)
    expect(text).toContain('杭州三日漫步路书')
    expect(text).not.toMatch(/^\uFEFF/)
  })

  it('结构不合法的行程不生成 Blob / 文件名', () => {
    const artifact = createTripBackupArtifact({ ...MOCK_TRIP, days: [] } as unknown as Trip, {
      now: FIXED_NOW,
    })
    expect(artifact.ok).toBe(false)
    if (artifact.ok) return
    expect(artifact.reason).toBe('invalid_trip')
    expect(artifact.message.length).toBeGreaterThan(0)
    expect('blob' in artifact).toBe(false)
  })

  it('导出时间无效时不生成备份', () => {
    const artifact = createTripBackupArtifact(MOCK_TRIP, { now: 'not-a-date' })
    expect(artifact.ok).toBe(false)
    if (artifact.ok) return
    expect(artifact.reason).toBe('invalid_export_time')
  })

  it('生成备份不碰 localStorage', () => {
    createTripBackupArtifact(MOCK_TRIP, { now: FIXED_NOW })
    expect(window.localStorage.length).toBe(0)
  })
})

describe('downloadTripBackup：显式下载与资源回收', () => {
  it('成功时创建一次性链接、点击一次、移除节点，并按延迟回收 Blob URL', () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:fake-trip')
    const revokeObjectURL = vi.fn()
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []
    const seen: Array<{ download: string; href: string }> = []
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        seen.push({ download: this.download, href: this.getAttribute('href') ?? '' })
      })

    const outcome = downloadTripBackup(MOCK_TRIP, {
      now: FIXED_NOW,
      document,
      createObjectURL,
      revokeObjectURL,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
      },
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe(TRIP_TRANSFER_MIME_TYPE)
    expect(click).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([{ download: '杭州-杭州三日漫步路书.json', href: 'blob:fake-trip' }])

    // 下载链接不留在 DOM 里
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)

    // 回收是延迟的：调度之前不 revoke
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0].delayMs).toBe(TRIP_URL_REVOKE_DELAY_MS)
    scheduled[0].callback()
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-trip')
  })

  it('revokeDelayMs 可覆盖，测试传 0 时立即调度', () => {
    const scheduled: number[] = []
    const outcome = downloadTripBackup(MOCK_TRIP, {
      now: FIXED_NOW,
      document,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
      revokeDelayMs: 0,
      schedule: (_callback, delayMs) => {
        scheduled.push(delayMs)
      },
    })
    expect(outcome.ok).toBe(true)
    expect(scheduled).toEqual([0])
  })

  it('没有 document 时返回 unsupported，不创建 URL、不点击', () => {
    const createObjectURL = vi.fn(() => 'blob:none')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const outcome = downloadTripBackup(MOCK_TRIP, {
      now: FIXED_NOW,
      document: null,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unsupported')
    expect(outcome.message).toContain('未下载任何文件')
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('浏览器不支持 createObjectURL 时返回 unsupported', () => {
    // 模拟老浏览器：全局 URL 没有 createObjectURL
    vi.stubGlobal('URL', {})
    const outcome = downloadTripBackup(MOCK_TRIP, { now: FIXED_NOW, document })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unsupported')
    expect(outcome.message).toContain('createObjectURL')
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
  })

  it('创建 Blob URL 抛错时返回 error，不点击、不 revoke', () => {
    const revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const outcome = downloadTripBackup(MOCK_TRIP, {
      now: FIXED_NOW,
      document,
      createObjectURL: () => {
        throw new Error('quota')
      },
      revokeObjectURL,
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('error')
    expect(outcome.message).toContain('创建下载链接失败')
    expect(outcome.message).toContain('未下载任何文件')
    expect(click).not.toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('点击抛错时立即回收 Blob URL、不安排延迟回收，且 DOM 不残留', () => {
    const revokeObjectURL = vi.fn()
    const schedule = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('blocked by popup policy')
    })

    const outcome = downloadTripBackup(MOCK_TRIP, {
      now: FIXED_NOW,
      document,
      createObjectURL: () => 'blob:boom',
      revokeObjectURL,
      schedule,
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('error')
    expect(outcome.message).toContain('触发下载失败')
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:boom')
    expect(schedule).not.toHaveBeenCalled()
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
  })

  it('行程不合法时不创建 URL、不点击', () => {
    const createObjectURL = vi.fn(() => 'blob:x')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const outcome = downloadTripBackup({ ...MOCK_TRIP, id: '' } as unknown as Trip, {
      now: FIXED_NOW,
      document,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('invalid_trip')
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('下载全程不写 localStorage', () => {
    downloadTripBackup(MOCK_TRIP, {
      now: FIXED_NOW,
      document,
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => {},
      schedule: () => {},
    })
    expect(window.localStorage.length).toBe(0)
  })
})

describe('readTripBackupFile：读文件前阻止超限', () => {
  it('File.size 超限时直接返回 too_large，完全不读取内容', async () => {
    const text = vi.fn(() => Promise.resolve(backupTextOf(MOCK_TRIP)))
    const file: TripUploadLike = { name: 'big.json', size: MAX_TRIP_FILE_BYTES + 1, text }

    const result = await readTripBackupFile(file)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_large')
    expect(result.message).toContain('KB')
    expect(result.message).toContain('已拒绝')
    expect(text).not.toHaveBeenCalled()
  })

  it('自定义 maxBytes 同样在读取前生效', async () => {
    const text = vi.fn(() => Promise.resolve('{}'))
    const result = await readTripBackupFile({ size: 11, text }, { maxBytes: 10 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_large')
    expect(text).not.toHaveBeenCalled()
  })

  it('File.size 撒谎（报小实际很大）时，仍被 UTF-8 体积门禁挡住', async () => {
    const huge = 'x'.repeat(MAX_TRIP_FILE_BYTES + 1)
    const result = await readTripBackupFile({ size: 10, text: () => Promise.resolve(huge) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_large')
    expect(result.message).not.toContain('xxxxxxxxxx')
  })

  it('缺少 size 时不误判超限，交给解析阶段按真实字节数判断', async () => {
    const result = await readTripBackupFile({
      text: () => Promise.resolve(JSON.stringify({ format: TRIP_TRANSFER_FORMAT, version: 3 })),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('version_mismatch')
  })

  it('File.size 异常（NaN / 负数 / Infinity / 非数字）时保守拒绝，不读取内容', async () => {
    for (const size of [Number.NaN, -1, Number.POSITIVE_INFINITY, '1024']) {
      const text = vi.fn(() => Promise.resolve(backupTextOf(MOCK_TRIP)))
      const result = await readTripBackupFile({
        name: 'odd.json',
        size,
        text,
      } as unknown as TripUploadLike)

      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('read_error')
      expect(result.message).toContain('文件大小信息异常')
      expect(result.message).not.toContain('杭州')
      expect(text).not.toHaveBeenCalled()
    }
  })
})

describe('readTripBackupFile：成功路径与往返', () => {
  it('File.text() 路径解析成功，行程与原始 MOCK_TRIP 一致', async () => {
    const result = await readTripBackupFile({
      name: 'trip.json',
      size: 1024,
      text: () => Promise.resolve(backupTextOf(MOCK_TRIP)),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip).toEqual(MOCK_TRIP)
    expect(result.exportedAt).toBe(FIXED_NOW.toISOString())
    expect(result.notices).toEqual([TRIP_JSON_SHARE_NOTICE])
    expect(result.bytes).toBe(utf8ByteLength(JSON.stringify(MOCK_TRIP)))
  })

  it('真实 File 对象也能读取（text 或 FileReader 兜底都算通过）', async () => {
    const file = new File([backupTextOf(MOCK_TRIP)], 'trip.json', { type: 'application/json' })
    const result = await readTripBackupFile(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip).toEqual(MOCK_TRIP)
  })

  it('带 UTF-8 BOM 的文件（记事本另存）也能读取', async () => {
    const text = `\uFEFF${backupTextOf(MOCK_TRIP)}`
    const file = new File([text], 'trip.json', { type: 'application/json' })
    const result = await readTripBackupFile(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip).toEqual(MOCK_TRIP)
  })

  it('没有 File.text() 时退到 FileReader', async () => {
    const factory = vi.fn(() => fakeReader('load', backupTextOf(MOCK_TRIP)))
    const result = await readTripBackupFile({ size: 2048 }, { fileReaderFactory: factory })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip).toEqual(MOCK_TRIP)
  })

  it('5000 点 geometry 经文件读取后逐点无损', async () => {
    const points = deepPoints(MAX_GEOMETRY_POINTS_PER_LEG)
    const trip: Trip = {
      ...MOCK_TRIP,
      days: [
        {
          day: 1,
          date: '2026-04-03',
          title: '长路线',
          summary: '',
          stops: MOCK_TRIP.days[0].stops.slice(0, 2),
          legs: [
            {
              from_stop_id: 's1',
              to_stop_id: 's2',
              mode: 'driving',
              route_type: 'navigation',
              distance_m: 12_345.678,
              duration_minutes: 42,
              geometry: points,
              description: '沿湖公路。',
            },
          ],
        },
      ],
    }

    const json = backupTextOf(trip)
    expect(utf8ByteLength(json)).toBeLessThanOrEqual(MAX_TRIP_FILE_BYTES)

    const result = await readTripBackupFile({
      size: utf8ByteLength(json),
      text: () => Promise.resolve(json),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const geometry = result.trip.days[0].legs[0].geometry
    expect(geometry).toHaveLength(MAX_GEOMETRY_POINTS_PER_LEG)
    expect(geometry).toEqual(points)
    expect(result.trip.days[0].legs[0].distance_m).toBe(12_345.678)
  })

  it('读取与解析全程不写 localStorage', async () => {
    await readTripBackupFile({ size: 1024, text: () => Promise.resolve(backupTextOf(MOCK_TRIP)) })
    expect(window.localStorage.length).toBe(0)
  })
})

describe('readTripBackupFile：失败分级', () => {
  it('传入的不是文件对象时给 read_error', async () => {
    for (const value of [null, undefined, 'trip.json', 42]) {
      const result = await readTripBackupFile(value as unknown as TripUploadLike)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('read_error')
      expect(result.message).toContain('读取文件失败')
    }
  })

  it('File.text() 返回非字符串或抛错时给 read_error，不回显内容', async () => {
    const nonString = await readTripBackupFile({
      size: 10,
      text: () => Promise.resolve(42 as unknown as string),
    })
    expect(nonString.ok).toBe(false)
    if (nonString.ok) return
    expect(nonString.reason).toBe('read_error')

    const thrown = await readTripBackupFile({
      size: 10,
      text: () => Promise.reject(new Error('EACCES C:\\Users\\secret\\trip.json')),
    })
    expect(thrown.ok).toBe(false)
    if (thrown.ok) return
    expect(thrown.reason).toBe('read_error')
    expect(thrown.message).toBe('读取文件失败，未导入任何内容。请重新选择文件或另存后再试。')
    expect(thrown.message).not.toContain('secret')
  })

  it('FileReader 出错给 read_error，取消给明确的取消文案', async () => {
    const failed = await readTripBackupFile(
      { size: 2048 },
      { fileReaderFactory: () => fakeReader('error') },
    )
    expect(failed.ok).toBe(false)
    if (failed.ok) return
    expect(failed.reason).toBe('read_error')
    expect(failed.message).toContain('读取文件失败')
    expect(failed.message).not.toContain('/secret/path')

    const aborted = await readTripBackupFile(
      { size: 2048 },
      { fileReaderFactory: () => fakeReader('abort') },
    )
    expect(aborted.ok).toBe(false)
    if (aborted.ok) return
    expect(aborted.reason).toBe('read_error')
    expect(aborted.message).toContain('取消')
  })

  it('File.text 与 FileReader 都不可用时给出明确文案', async () => {
    const result = await readTripBackupFile(
      { size: 1024 },
      { fileReaderFactory: () => null as unknown as TextFileReader },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('read_error')
    expect(result.message).toContain('File.text 与 FileReader 都不可用')
  })

  it('能读到内容但格式/版本/结构不对时，返回解析层的失败原因', async () => {
    const cases: Array<{ text: string; reason: string }> = [
      { text: '{', reason: 'parse_error' },
      { text: JSON.stringify(MOCK_TRIP), reason: 'format_mismatch' },
      {
        text: JSON.stringify({
          format: TRIP_TRANSFER_FORMAT,
          version: TRIP_TRANSFER_VERSION + 1,
          exportedAt: FIXED_NOW.toISOString(),
          trip: MOCK_TRIP,
        }),
        reason: 'version_mismatch',
      },
      {
        text: JSON.stringify({
          format: TRIP_TRANSFER_FORMAT,
          version: TRIP_TRANSFER_VERSION,
          trip: { id: 'x' },
        }),
        reason: 'invalid_trip',
      },
    ]

    for (const item of cases) {
      const result = await readTripBackupFile({
        size: 4096,
        text: () => Promise.resolve(item.text),
      })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe(item.reason)
    }
  })
})

describe('导出 → 下载 → 再导入：整条链路', () => {
  it('下载产出的 json 能被 readTripBackupFile 原样读回', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:roundtrip')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const outcome = downloadTripBackup(MOCK_TRIP, {
      now: FIXED_NOW,
      document,
      createObjectURL,
      revokeObjectURL: () => {},
      schedule: () => {},
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const reread = await readTripBackupFile({
      name: outcome.filename,
      size: utf8ByteLength(outcome.json),
      text: () => Promise.resolve(outcome.json),
    })
    expect(reread.ok).toBe(true)
    if (!reread.ok) return
    expect(reread.trip).toEqual(MOCK_TRIP)
  })
})

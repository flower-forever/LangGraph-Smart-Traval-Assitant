import { describe, expect, it } from 'vitest'
import type { Trip, TripLeg, TripLocation } from '../lib/api'
import {
  MAX_GEOMETRY_POINTS_PER_LEG,
  SAVED_TRIPS_STORAGE_KEY,
  checkTripShape,
  saveTripToStorage,
  savedTripRecordBytes,
  utf8ByteLength,
  type StorageLike,
} from '../lib/savedTrips'
import {
  MAX_TOTAL_GEOMETRY_POINTS,
  MAX_TRIP_FILE_BYTES,
  MAX_TRIP_TRANSFER_BYTES,
  TRIP_JSON_SHARE_NOTICE,
  TRIP_TRANSFER_FORMAT,
  TRIP_TRANSFER_VERSION,
  createTripBackup,
  formatTripExportedAt,
  parseTripBackup,
  projectTrip,
} from '../lib/tripTransfer'
import { MOCK_TRIP } from './fixtures/trip'

const FIXED_NOW = new Date('2026-01-01T08:00:00.000Z')

function envelopeJsonOf(trip: unknown): string {
  return JSON.stringify({
    format: TRIP_TRANSFER_FORMAT,
    version: TRIP_TRANSFER_VERSION,
    exportedAt: FIXED_NOW.toISOString(),
    trip,
  })
}

/** 只实现 get / set / remove 的内存存储，用来验证保存路径不写任何字节 */
function createMemoryStorage(): StorageLike & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

function backupJsonOf(trip: Trip): string {
  const backup = createTripBackup(trip, { now: FIXED_NOW })
  if (!backup.ok) throw new Error(`导出失败：${backup.reason}`)
  return backup.json
}

/** 12 位小数的坐标：用来验证导出/导入不会取整或抽稀 */
function deepPoints(count: number): TripLocation[] {
  return Array.from({ length: count }, (_, index) => ({
    lng: Number((120.123456789012 + index * 0.000012345678).toFixed(12)),
    lat: Number((30.987654321098 - index * 0.000009876543).toFixed(12)),
  }))
}

function legWith(points: TripLocation[], overrides: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: 's1',
    to_stop_id: 's2',
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 1234.5,
    duration_minutes: 16,
    geometry: points,
    description: '沿白堤步行。',
    ...overrides,
  }
}

function tripWithLegs(legs: TripLeg[]): Trip {
  return {
    ...MOCK_TRIP,
    days: [
      {
        day: 1,
        date: '2026-04-03',
        title: '长路线',
        summary: '',
        stops: MOCK_TRIP.days[0].stops.slice(0, 2),
        legs,
      },
    ],
  }
}

describe('createTripBackup：版本化信封', () => {
  it('只写 format / version / exportedAt / trip 四个字段', () => {
    const backup = createTripBackup(MOCK_TRIP, { now: FIXED_NOW })
    expect(backup.ok).toBe(true)
    if (!backup.ok) return

    const envelope = JSON.parse(backup.json) as Record<string, unknown>
    expect(Object.keys(envelope)).toEqual(['format', 'version', 'exportedAt', 'trip'])
    expect(envelope.format).toBe(TRIP_TRANSFER_FORMAT)
    expect(envelope.version).toBe(TRIP_TRANSFER_VERSION)
    expect(envelope.exportedAt).toBe('2026-01-01T08:00:00.000Z')
    expect(envelope.trip).toEqual(MOCK_TRIP)
    expect(backup.exportedAt).toBe('2026-01-01T08:00:00.000Z')
    expect(backup.notices).toEqual([TRIP_JSON_SHARE_NOTICE])
  })

  it('缺省导出时间是当前时间，换成数字时间戳也写成 ISO', () => {
    const auto = createTripBackup(MOCK_TRIP)
    expect(auto.ok).toBe(true)
    if (!auto.ok) return
    expect(auto.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const fromNumber = createTripBackup(MOCK_TRIP, { now: 0 })
    expect(fromNumber.ok).toBe(true)
    if (!fromNumber.ok) return
    expect(fromNumber.exportedAt).toBe('1970-01-01T00:00:00.000Z')
  })

  it('导出时间无法解析时明确失败，不生成文件', () => {
    const backup = createTripBackup(MOCK_TRIP, { now: 'not-a-date' })
    expect(backup.ok).toBe(false)
    if (backup.ok) return
    expect(backup.reason).toBe('invalid_export_time')
    expect(backup.message).toContain('导出时间无效')
  })
})

describe('createTripBackup：严格投影', () => {
  it('额外字段（包括像凭据的假 key）不写进文件，导入后只剩契约字段', () => {
    const dirty = {
      ...MOCK_TRIP,
      _fake_api_key: 'sk-should-not-be-written',
      internal_note: 'internal-should-not-be-written',
      days: MOCK_TRIP.days.map((day) => ({
        ...day,
        extra_day_field: 'day-extra-should-not-be-written',
        stops: day.stops.map((stop) => ({
          ...stop,
          _fake_key: 'stop-extra-should-not-be-written',
        })),
        legs: day.legs.map((leg) => ({ ...leg, hidden: 'leg-extra-should-not-be-written' })),
      })),
    } as unknown as Trip

    const json = backupJsonOf(dirty)
    expect(json).not.toContain('sk-should-not-be-written')
    expect(json).not.toContain('internal-should-not-be-written')
    expect(json).not.toContain('day-extra-should-not-be-written')
    expect(json).not.toContain('stop-extra-should-not-be-written')
    expect(json).not.toContain('leg-extra-should-not-be-written')
    expect(json).not.toContain('_fake_api_key')
    expect(json).not.toContain('_fake_key')
    expect(json).not.toContain('internal_note')

    const imported = parseTripBackup(json)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.trip).toEqual(MOCK_TRIP)
    expect(Object.keys(imported.trip).sort()).toEqual([
      'days',
      'destination',
      'id',
      'map_coordinate_system',
      'source',
      'summary',
      'title',
      'warnings',
    ])
  })

  it('日期字符串与 null 都原样保留', () => {
    const imported = parseTripBackup(backupJsonOf(MOCK_TRIP))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.trip.days.map((day) => day.date)).toEqual(['2026-04-03', '2026-04-04', null])
  })

  it('结构不合法的行程不会被导出', () => {
    const broken = { ...MOCK_TRIP, days: [] } as unknown as Trip
    const backup = createTripBackup(broken, { now: FIXED_NOW })
    expect(backup.ok).toBe(false)
    if (backup.ok) return
    expect(backup.reason).toBe('invalid_trip')
    expect(projectTrip(broken).ok).toBe(false)
  })
})

describe('createTripBackup / parseTripBackup：UTF-8 与长路线', () => {
  it('按 UTF-8 字节计体积，中文与 emoji 不按 UTF-16 码元算', () => {
    const trip: Trip = { ...MOCK_TRIP, summary: '西湖 emoji 🚤 与日文 こんにちは' }
    const backup = createTripBackup(trip, { now: FIXED_NOW })
    expect(backup.ok).toBe(true)
    if (!backup.ok) return

    const projected = JSON.stringify((JSON.parse(backup.json) as { trip: unknown }).trip)
    expect(backup.bytes).toBe(utf8ByteLength(projected))
    expect(backup.bytes).toBeGreaterThan(projected.length)
    expect(utf8ByteLength(backup.json)).toBeGreaterThan(backup.bytes)
  })

  it('5000 点 geometry 往返逐点无损，日期与 self 字段不变', () => {
    const points = deepPoints(MAX_GEOMETRY_POINTS_PER_LEG)
    const trip = tripWithLegs([legWith(points)])

    const backup = createTripBackup(trip, { now: FIXED_NOW })
    expect(backup.ok).toBe(true)
    if (!backup.ok) return
    expect(backup.bytes).toBeLessThanOrEqual(MAX_TRIP_TRANSFER_BYTES)

    const imported = parseTripBackup(backup.json)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return

    const geometry = imported.trip.days[0].legs[0].geometry
    expect(geometry).toHaveLength(MAX_GEOMETRY_POINTS_PER_LEG)
    expect(geometry).toEqual(points)
    expect(geometry[0]).toEqual(points[0])
    expect(geometry[points.length - 1]).toEqual(points[points.length - 1])
    // 再导一次，字节数完全相同：序列化是确定性的
    const again = createTripBackup(imported.trip, { now: FIXED_NOW })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.json).toBe(backup.json)
  })

  it('单条 leg 超过后端 5000 点上限时拒绝导出与导入', () => {
    const tooMany = deepPoints(MAX_GEOMETRY_POINTS_PER_LEG + 1)
    const backup = createTripBackup(tripWithLegs([legWith(tooMany)]), { now: FIXED_NOW })
    expect(backup.ok).toBe(false)
    if (backup.ok) return
    expect(backup.reason).toBe('invalid_trip')
    expect(backup.message).toContain(String(MAX_GEOMETRY_POINTS_PER_LEG))

    const forged = JSON.stringify({
      format: TRIP_TRANSFER_FORMAT,
      version: TRIP_TRANSFER_VERSION,
      exportedAt: FIXED_NOW.toISOString(),
      trip: tripWithLegs([legWith(tooMany)]),
    })
    const imported = parseTripBackup(forged)
    expect(imported.ok).toBe(false)
    if (imported.ok) return
    expect(imported.reason).toBe('invalid_trip')
  })

  it('几何总点数超过预算时按 too_large 拒绝，而不是当成结构损坏', () => {
    const points = deepPoints(MAX_GEOMETRY_POINTS_PER_LEG)
    const legCount = Math.floor(MAX_TOTAL_GEOMETRY_POINTS / MAX_GEOMETRY_POINTS_PER_LEG) + 1
    const legs = Array.from({ length: legCount }, (_, index) =>
      legWith(points, {
        from_stop_id: `s${index}`,
        to_stop_id: `s${index + 1}`,
      }),
    )
    const backup = createTripBackup(tripWithLegs(legs), { now: FIXED_NOW })
    expect(backup.ok).toBe(false)
    if (backup.ok) return
    expect(backup.reason).toBe('too_large')
  })

  it('payload 超过 640 KB 时拒绝导出，体积提示带 KB 数字', () => {
    const trip: Trip = { ...MOCK_TRIP, summary: 'x'.repeat(700 * 1024) }
    const backup = createTripBackup(trip, { now: FIXED_NOW })
    expect(backup.ok).toBe(false)
    if (backup.ok) return
    expect(backup.reason).toBe('too_large')
    expect(backup.message).toContain('KB')
  })
})

describe('parseTripBackup：失败分级与固定文案', () => {
  const good = (): Record<string, unknown> => ({
    format: TRIP_TRANSFER_FORMAT,
    version: TRIP_TRANSFER_VERSION,
    exportedAt: FIXED_NOW.toISOString(),
    trip: MOCK_TRIP,
  })

  it('非法 JSON / 空文本给 parse_error，文案不回显内容', () => {
    for (const text of ['{', '', '   ', '<html>oops</html>']) {
      const result = parseTripBackup(text)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('parse_error')
      expect(result.message).toContain('不是合法的 JSON')
      expect(result.message).not.toContain('<html>')
    }
  })

  it('带一个前导 UTF-8 BOM 的文件仍能导入，两个 BOM 仍按坏 JSON 拒绝', () => {
    const text = JSON.stringify(good())
    const withBom = parseTripBackup(`\uFEFF${text}`)
    expect(withBom.ok).toBe(true)
    if (!withBom.ok) return
    expect(withBom.trip).toEqual(MOCK_TRIP)

    const doubled = parseTripBackup(`\uFEFF\uFEFF${text}`)
    expect(doubled.ok).toBe(false)
    if (doubled.ok) return
    expect(doubled.reason).toBe('parse_error')
  })

  it('不是本工具备份（缺少 format / 随便一个 JSON）给 format_mismatch', () => {
    const missingFormat: Record<string, unknown> = { ...good() }
    delete missingFormat.format
    const payloads: unknown[] = [missingFormat, { hello: 'world' }, [], 'text', 42, null]

    for (const payload of payloads) {
      const result = parseTripBackup(JSON.stringify(payload))
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('format_mismatch')
      expect(result.message).toContain('format')
    }
  })

  it('原始 Trip（没有信封）也按 format_mismatch 处理', () => {
    const result = parseTripBackup(JSON.stringify(MOCK_TRIP))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('format_mismatch')
  })

  it('版本不对一律 version_mismatch：2 和字符串 "1" 都不接受', () => {
    for (const version of [2, 0, '1', null]) {
      const result = parseTripBackup(JSON.stringify({ ...good(), version }))
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('version_mismatch')
      expect(result.message).toContain(`第 ${TRIP_TRANSFER_VERSION} 版`)
    }
  })

  it('trip 结构损坏给 invalid_trip', () => {
    const broken = parseTripBackup(JSON.stringify({ ...good(), trip: { id: 'x' } }))
    expect(broken.ok).toBe(false)
    if (broken.ok) return
    expect(broken.reason).toBe('invalid_trip')

    const noTrip = parseTripBackup(JSON.stringify({ format: TRIP_TRANSFER_FORMAT, version: 1 }))
    expect(noTrip.ok).toBe(false)
    if (noTrip.ok) return
    expect(noTrip.reason).toBe('invalid_trip')
  })

  it('文本超限时在解析前就拒绝（内容是坏 JSON 也只能得到 too_large）', () => {
    const oversized = 'x'.repeat(MAX_TRIP_FILE_BYTES + 1)
    const result = parseTripBackup(oversized)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_large')
    expect(result.message).toContain('KB')

    const strict = parseTripBackup('{}', { maxBytes: 1 })
    expect(strict.ok).toBe(false)
    if (strict.ok) return
    expect(strict.reason).toBe('too_large')
  })

  it('payload 卡在文件上限内、但超过 640 KB 时给 too_large', () => {
    const envelope = JSON.stringify({ ...good(), trip: { ...MOCK_TRIP, summary: 'y'.repeat(700 * 1024) } })
    expect(utf8ByteLength(envelope)).toBeLessThanOrEqual(MAX_TRIP_FILE_BYTES)
    const result = parseTripBackup(envelope)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_large')
    expect(result.message).toContain('单份备份上限')
  })

  it('成功时返回投影后的行程、导出时间与明文提醒', () => {
    const result = parseTripBackup(JSON.stringify(good()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.trip).toEqual(MOCK_TRIP)
    expect(result.exportedAt).toBe(FIXED_NOW.toISOString())
    expect(result.bytes).toBe(utf8ByteLength(JSON.stringify(MOCK_TRIP)))
    expect(result.notices).toEqual([TRIP_JSON_SHARE_NOTICE])

    const withoutTime = parseTripBackup(
      JSON.stringify({ format: TRIP_TRANSFER_FORMAT, version: 1, trip: MOCK_TRIP }),
    )
    expect(withoutTime.ok).toBe(true)
    if (!withoutTime.ok) return
    expect(withoutTime.exportedAt).toBeNull()
  })
})

/**
 * 导入 / 导出必须和本地保存共用同一套结构约束：边界文件不能出现
 * 「预览能打开、保存必然失败」或反过来「预览被拒、保存却能过」。
 */
describe('tripTransfer：结构约束与 savedTrips 共用一套', () => {
  const stop = MOCK_TRIP.days[0].stops[0]

  /** 结构上应被拒绝的行程：体积都很小，失败原因只能是结构 */
  const structureCases: Array<{ name: string; trip: Trip }> = [
    {
      name: '重复的 day',
      trip: { ...MOCK_TRIP, days: [{ ...MOCK_TRIP.days[0] }, { ...MOCK_TRIP.days[0] }] },
    },
    {
      name: '同一天里重复的站点 ID',
      trip: {
        ...MOCK_TRIP,
        days: [{ ...MOCK_TRIP.days[0], stops: [stop, { ...stop }], legs: [] }],
      },
    },
    {
      name: '标题超长（501 字符）',
      trip: { ...MOCK_TRIP, title: 't'.repeat(501) },
    },
    {
      name: '单条 leg 的几何超过后端 5000 点上限',
      trip: tripWithLegs([legWith(deepPoints(MAX_GEOMETRY_POINTS_PER_LEG + 1))]),
    },
    {
      name: '超过 31 天的行程（60 天）',
      trip: {
        ...MOCK_TRIP,
        warnings: [],
        days: Array.from({ length: 60 }, (_, index) => ({
          day: index + 1,
          date: null,
          title: `第 ${index + 1} 天`,
          summary: '',
          stops: [],
          legs: [],
        })),
      },
    },
  ]

  it('checkTripShape 与 parseTripBackup / createTripBackup 的结论完全一致', () => {
    for (const item of structureCases) {
      // 体积都很小，不会被体积门禁提前挡掉
      expect(utf8ByteLength(JSON.stringify(item.trip))).toBeLessThan(MAX_TRIP_TRANSFER_BYTES)

      const shape = checkTripShape(item.trip)
      expect(shape.ok, `${item.name} 应被结构校验拒绝`).toBe(false)
      if (shape.ok) continue
      expect(shape.reason).toBe('invalid')

      const imported = parseTripBackup(envelopeJsonOf(item.trip))
      expect(imported.ok, `${item.name} 不应能导入`).toBe(false)
      if (imported.ok) continue
      expect(imported.reason).toBe('invalid_trip')

      const backup = createTripBackup(item.trip, { now: FIXED_NOW })
      expect(backup.ok, `${item.name} 不应能导出`).toBe(false)
      if (backup.ok) continue
      expect(backup.reason).toBe('invalid_trip')
    }
  })

  it('重复 day 与 60 天的拒绝文案是固定文本，不回显任何行程内容', () => {
    const duplicated = structureCases[0].trip
    const manyDays = structureCases[4].trip
    for (const trip of [duplicated, manyDays]) {
      const result = parseTripBackup(envelopeJsonOf(trip))
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason).toBe('invalid_trip')
      expect(result.message).toContain('重复的天数')
      expect(result.message).toContain('未导出或导入')
    }
  })
})

/**
 * 640 KiB 边界：单份容量的计算对象是「实际写下的记录」（id + savedAt + trip），
 * 不是只算 trip 本身。否则 trip 恰好卡在 640 KiB 的文件能预览，保存却必然超限。
 */
describe('tripTransfer：640 KiB 边界与本地保存结果一致', () => {
  const POINT = { lng: 120.1, lat: 30.9 }
  /** 25 000 个点（5 段，每段 5000），序列化后约 610 KB，留给 warnings 做 1 字节级微调 */
  const LEG_POINT_COUNTS = [5_000, 5_000, 5_000, 5_000, 5_000]

  /**
   * 造一份 trip 字节数精确等于 targetTripBytes 的合法行程：
   * 几何负责大头，warnings 负责逐字节补齐（每条 ≤ 2000 字符、最多 50 条）。
   */
  function boundaryTrip(id: string, targetTripBytes: number): Trip {
    const [stopA, stopB] = MOCK_TRIP.days[0].stops
    const legs: TripLeg[] = LEG_POINT_COUNTS.map((count) => ({
      from_stop_id: stopA.id,
      to_stop_id: stopB.id,
      mode: 'walking',
      route_type: 'navigation',
      distance_m: 1,
      duration_minutes: 1,
      geometry: Array.from({ length: count }, () => ({ ...POINT })),
      description: '',
    }))
    const base: Trip = {
      ...MOCK_TRIP,
      id,
      warnings: [],
      days: [
        { day: 1, date: null, title: '容量边界', summary: '', stops: [stopA, stopB], legs },
      ],
    }

    let warnings: string[] = []
    for (let guard = 0; guard < 60; guard += 1) {
      const current = utf8ByteLength(JSON.stringify({ ...base, warnings }))
      const remaining = targetTripBytes - current
      if (remaining === 0) return { ...base, warnings }
      if (remaining < 0) throw new Error(`目标体积 ${targetTripBytes} 小于基础体积 ${current}`)
      if (warnings.length >= 50) throw new Error('补齐体积失败：warnings 数量超出上限')
      // 新加一条 warning 还会带入两个引号（非首条再加一个逗号）
      const overhead = 2 + (warnings.length > 0 ? 1 : 0)
      const chunk = Math.min(remaining - overhead, 2_000)
      if (chunk <= 0) throw new Error('剩余误差小于一条 warning 的开销，无法精确补齐')
      warnings = [...warnings, 'w'.repeat(chunk)]
    }
    throw new Error('补齐体积失败：迭代次数超出上限')
  }

  it('trip 本身未超限、加上记录元数据后超限：导出 / 导入 / 保存一致拒绝，不写任何字节', () => {
    const trip = boundaryTrip('boundary-over', MAX_TRIP_TRANSFER_BYTES - 10)
    const tripBytes = utf8ByteLength(JSON.stringify(trip))
    const recordBytes = savedTripRecordBytes(trip)

    // 这就是缺陷所在：只按 trip 算（tripBytes）会以为「能导入」，真正保存却必然失败
    expect(tripBytes).toBeLessThanOrEqual(MAX_TRIP_TRANSFER_BYTES)
    expect(recordBytes).toBeGreaterThan(MAX_TRIP_TRANSFER_BYTES)

    const backup = createTripBackup(trip, { now: FIXED_NOW })
    expect(backup.ok).toBe(false)
    if (backup.ok) return
    expect(backup.reason).toBe('too_large')
    expect(backup.message).toContain('单份备份上限')

    const imported = parseTripBackup(envelopeJsonOf(trip))
    expect(imported.ok).toBe(false)
    if (imported.ok) return
    expect(imported.reason).toBe('too_large')

    const storage = createMemoryStorage()
    const saved = saveTripToStorage(trip, storage)
    expect(saved.ok).toBe(false)
    if (saved.ok) return
    expect(saved.reason).toBe('too_large')
    // fail-closed：一个字节都不写
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBeUndefined()
  }, 30_000)

  it('加上记录元数据仍然放得下：导出 → 导入 → 保存三处结果一致', () => {
    const trip = boundaryTrip('boundary-under', MAX_TRIP_TRANSFER_BYTES - 200)
    const recordBytes = savedTripRecordBytes(trip)
    expect(recordBytes).toBeLessThanOrEqual(MAX_TRIP_TRANSFER_BYTES)

    const backup = createTripBackup(trip, { now: FIXED_NOW })
    expect(backup.ok).toBe(true)
    if (!backup.ok) return

    const imported = parseTripBackup(backup.json)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.trip).toEqual(trip)

    const storage = createMemoryStorage()
    const saved = saveTripToStorage(trip, storage)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    // 真正写下的记录字节与容量口径逐字节一致（savedAt 都是 13 位）
    const raw = storage.data.get(SAVED_TRIPS_STORAGE_KEY)
    expect(raw).toBeTruthy()
    const record = (JSON.parse(raw as string) as { trips: unknown[] }).trips[0]
    expect(utf8ByteLength(JSON.stringify(record))).toBe(recordBytes)
    expect(saved.trips[0].trip).toEqual(trip)
  }, 30_000)
})

/**
 * exportedAt 是文件自述、不是可信数据。展示层只认规范 ISO 8601，
 * 其余内容（超长文案、HTML 片段、随手写的说明）一律换成固定文案，不原样渲染。
 */
describe('formatTripExportedAt：只按规范 ISO 展示，其他内容不原样回显', () => {
  it('本工具写出的 UTC 时间统一显示为分钟精度', () => {
    expect(formatTripExportedAt('2026-01-01T08:00:00.000Z')).toBe('2026-01-01 08:00 UTC')
    expect(formatTripExportedAt('2026-01-01T08:00:00Z')).toBe('2026-01-01 08:00 UTC')
    // 小数秒超过 3 位也按规范接受，展示时截到分钟
    expect(formatTripExportedAt('2026-01-01T08:00:00.123456789Z')).toBe('2026-01-01 08:00 UTC')
  })

  it('带时区偏移的时间换算成 UTC，不按本机时区猜测', () => {
    expect(formatTripExportedAt('2026-01-01T16:00:00+08:00')).toBe('2026-01-01 08:00 UTC')
    expect(formatTripExportedAt('2026-01-01T00:30:00-05:00')).toBe('2026-01-01 05:30 UTC')
    // 跨日换算
    expect(formatTripExportedAt('2026-01-01T23:30:00-05:00')).toBe('2026-01-02 04:30 UTC')
  })

  it('缺少导出时间时给固定说明', () => {
    expect(formatTripExportedAt(null)).toBe('文件里没有记录导出时间')
  })

  it('超长文案、HTML 片段、非规范和越界日期都不原样回显', () => {
    const longText = `2026-01-01T08:00:00Z ${'x'.repeat(5000)}`
    const hostile = '<img src=x onerror="alert(1)">'
    const values = [
      '',
      '   ',
      'not-a-date',
      '2026-01-01',
      '2026-13-01T00:00:00Z',
      '2026-02-31T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T08:00:60Z',
      '2026-01-01T08:00:00+15:00',
      ' 2026-01-01T08:00:00Z',
      longText,
      hostile,
    ]
    for (const value of values) {
      const display = formatTripExportedAt(value)
      expect(display).toBe('文件里记录的导出时间格式无法识别，已忽略')
      expect(display).not.toContain('xxxx')
      expect(display).not.toContain('onerror')
      expect(display).not.toContain('<img')
    }
  })

  it('展示文本长度固定，不随输入长度增长', () => {
    const short = formatTripExportedAt('nope')
    const long = formatTripExportedAt('nope'.repeat(10_000))
    expect(long).toBe(short)
    expect(long.length).toBeLessThan(40)
  })
})

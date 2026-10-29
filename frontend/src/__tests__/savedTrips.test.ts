import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_GEOMETRY_POINTS_PER_LEG,
  MAX_SAVED_STORAGE_BYTES,
  MAX_SAVED_TRIP_BYTES,
  MAX_SAVED_TRIPS,
  SAVED_TRIPS_STORAGE_KEY,
  SAVED_TRIPS_VERSION,
  clearSavedTrips,
  deleteSavedTrip,
  getLocalStorage,
  loadSavedTrips,
  saveTripToStorage,
  undoSavedTripDeletion,
  utf8ByteLength,
  type SavedTrip,
  type StorageLike,
} from '../lib/savedTrips'
import type { Trip, TripLeg, TripLocation } from '../lib/api'
import { MOCK_TRIP } from './fixtures/trip'

interface MemoryStorage extends StorageLike {
  readonly data: Map<string, string>
  failNextWrite(error: Error): void
}

function createMemoryStorage(): MemoryStorage {
  const data = new Map<string, string>()
  let nextWriteError: Error | null = null
  return {
    data,
    failNextWrite(error: Error) {
      nextWriteError = error
    },
    getItem(key: string) {
      return data.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (nextWriteError) {
        const error = nextWriteError
        nextWriteError = null
        throw error
      }
      data.set(key, value)
    },
    removeItem(key: string) {
      data.delete(key)
    },
  }
}

function writeEnvelope(storage: MemoryStorage, trips: unknown[]): void {
  storage.data.set(SAVED_TRIPS_STORAGE_KEY, JSON.stringify({ version: SAVED_TRIPS_VERSION, trips }))
}

function cloneTrip(overrides: Partial<Trip> = {}): Trip {
  return { ...MOCK_TRIP, ...overrides }
}

function record(id: string, savedAt: number, trip: Trip = cloneTrip({ id })): SavedTrip {
  return { id, savedAt, trip }
}

/** 与后端 WGS84 输出量级一致的合成坐标：7 位小数，单点序列化约 38 字节 */
function pointAt(seed: number): TripLocation {
  return {
    lng: Number((116.3974285 + seed * 0.0000001).toFixed(7)),
    lat: Number((39.9092301 + seed * 0.0000001).toFixed(7)),
  }
}

function geometry(count: number, offset = 0): TripLocation[] {
  return Array.from({ length: count }, (_, index) => pointAt(offset + index))
}

/** 单段长路线行程：两个站点 + 一条 navigation leg，点数由参数决定 */
function tripWithRoute(id: string, points: number): Trip {
  const startStop = { ...MOCK_TRIP.days[0].stops[0], id: `${id}-start`, name: '起点' }
  const endStop = { ...MOCK_TRIP.days[0].stops[1], id: `${id}-end`, name: '终点' }
  return {
    ...MOCK_TRIP,
    id,
    destination: '北京',
    title: `单段 ${points} 点路线`,
    days: [
      {
        day: 1,
        date: null,
        title: '长路线',
        summary: '',
        stops: [startStop, endStop],
        legs: [
          {
            from_stop_id: startStop.id,
            to_stop_id: endStop.id,
            mode: 'walking',
            route_type: 'navigation',
            distance_m: 1200,
            duration_minutes: 18,
            geometry: geometry(points),
            description: '合成步行路线',
          },
        ],
      },
    ],
  }
}

/** 同一天里挂多条长路线，用来触达全行程几何点数预算 */
function tripWithLegs(id: string, legCount: number, pointsPerLeg: number): Trip {
  const trip = tripWithRoute(id, pointsPerLeg)
  const day = trip.days[0]
  const leg: TripLeg = day.legs[0]
  return {
    ...trip,
    days: [{ ...day, legs: Array.from({ length: legCount }, () => ({ ...leg })) }],
  }
}

/**
 * 评审给的真实样本：7 天 × 8 站，每天 8 段路线（前 7 段相邻、第 8 段回起点），
 * 每段 150 个几何点，共 56 × 150 = 8 400 个点，约 315–335 KB。
 */
function sevenDayEightStopTrip(id: string): Trip {
  const makeDay = (dayIndex: number): Trip['days'][number] => ({
    day: dayIndex + 1,
    date: null,
    title: `第 ${dayIndex + 1} 天`,
    summary: '按顺序走完当天 8 个站点，再回到起点附近的落脚点。',
    stops: Array.from({ length: 8 }, (_, stopIndex) => ({
      id: `d${dayIndex + 1}-s${stopIndex + 1}`,
      name: `第 ${dayIndex + 1} 天站点 ${stopIndex + 1}`,
      time: `${String(8 + stopIndex).padStart(2, '0')}:00`,
      duration_minutes: 30,
      description: '合成测试站点，用来验证合法长路线能完整保存。',
      address: '北京市东城区某条测试街道',
      location: pointAt(dayIndex * 100 + stopIndex),
    })),
    legs: Array.from({ length: 8 }, (_, legIndex) => ({
      from_stop_id: `d${dayIndex + 1}-s${legIndex + 1}`,
      to_stop_id: `d${dayIndex + 1}-s${((legIndex + 1) % 8) + 1}`,
      mode: 'walking',
      route_type: 'navigation',
      distance_m: 900,
      duration_minutes: 14,
      geometry: geometry(150, dayIndex * 1000 + legIndex * 150),
      description: '合成路线几何，150 个点。',
    })),
  })

  return {
    ...MOCK_TRIP,
    id,
    destination: '北京',
    title: '七日八站合成行程',
    summary: '合成数据：7 天 × 8 站 × 每段 150 个几何点，用于容量边界测试。',
    warnings: [],
    days: Array.from({ length: 7 }, (_, dayIndex) => makeDay(dayIndex)),
  }
}

let now = 1_760_000_000_000

beforeEach(() => {
  now = 1_760_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('savedTrips 存取', () => {
  it('显式保存后能完整读回 TripPlan（含 source 与 warnings）', () => {
    const storage = createMemoryStorage()
    expect(loadSavedTrips(storage)).toMatchObject({ status: 'empty', trips: [] })

    const result = saveTripToStorage(MOCK_TRIP, storage)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.existed).toBe(false)
    expect(result.trips).toHaveLength(1)
    expect(result.saved.trip.source).toBe('example')
    expect(result.saved.trip.warnings).toEqual(MOCK_TRIP.warnings)
    expect(result.saved.trip.days).toHaveLength(3)
    expect(result.saved.savedAt).toBe(now)

    const loaded = loadSavedTrips(storage)
    expect(loaded.status).toBe('ok')
    expect(loaded.skipped).toBe(0)
    expect(loaded.trips).toHaveLength(1)
    expect(loaded.trips[0].trip).toEqual(MOCK_TRIP)
    expect(loaded.trips[0].trip.source).toBe('example')
    expect(loaded.trips[0].trip.warnings).toEqual(MOCK_TRIP.warnings)
  })

  it('重复保存同一个 trip.id 只更新时间，不产生重复记录；内容变化时标记 changed', () => {
    const storage = createMemoryStorage()
    const first = saveTripToStorage(MOCK_TRIP, storage)
    expect(first.ok).toBe(true)

    now += 1_000
    const changedTrip = cloneTrip({ title: '杭州三日漫步路书（更新版）' })
    const second = saveTripToStorage(changedTrip, storage)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.existed).toBe(true)
    expect(second.changed).toBe(true)
    expect(second.trips).toHaveLength(1)
    expect(second.saved.savedAt).toBe(now)
    expect(second.trips[0].trip.title).toBe('杭州三日漫步路书（更新版）')

    now += 1_000
    const third = saveTripToStorage(changedTrip, storage)
    expect(third.ok).toBe(true)
    if (!third.ok) return
    expect(third.existed).toBe(true)
    expect(third.changed).toBe(false)
    expect(third.trips).toHaveLength(1)

    const raw = storage.data.get(SAVED_TRIPS_STORAGE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!) as { trips: unknown[] }
    expect(parsed.trips).toHaveLength(1)
  })

  it('删除后可以撤销，撤销的记录保留原保存时间和顺序', () => {
    const storage = createMemoryStorage()
    now += 1_000
    const older = record('older', now, cloneTrip({ id: 'older', title: '较早保存' }))
    now += 1_000
    const newer = record('newer', now, cloneTrip({ id: 'newer', title: '较晚保存' }))
    writeEnvelope(storage, [newer, older])

    const deleted = deleteSavedTrip('older', storage)
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.removed.trip.title).toBe('较早保存')
    expect(deleted.trips.map((item) => item.id)).toEqual(['newer'])

    const undone = undoSavedTripDeletion(deleted.removed, storage)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.trips.map((item) => item.id)).toEqual(['newer', 'older'])
    expect(undone.trips[1].savedAt).toBe(older.savedAt)
    expect(loadSavedTrips(storage).trips).toHaveLength(2)
  })
})

describe('savedTrips 损坏与写入失败', () => {
  it('损坏 JSON 返回 corrupt，保存暂停且不覆盖旧内容；清除后可重新保存', () => {
    const storage = createMemoryStorage()
    const broken = '{"version":1,"trips":['
    storage.data.set(SAVED_TRIPS_STORAGE_KEY, broken)

    const loaded = loadSavedTrips(storage)
    expect(loaded.status).toBe('corrupt')
    expect(loaded.trips).toEqual([])
    expect(loaded.message).toContain('JSON')

    const save = saveTripToStorage(MOCK_TRIP, storage)
    expect(save.ok).toBe(false)
    if (save.ok) return
    expect(save.reason).toBe('corrupt')
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(broken)

    const remove = deleteSavedTrip(MOCK_TRIP.id, storage)
    expect(remove.ok).toBe(false)
    if (!remove.ok) expect(remove.reason).toBe('corrupt')
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(broken)

    const undo = undoSavedTripDeletion(record(MOCK_TRIP.id, now, MOCK_TRIP), storage)
    expect(undo.ok).toBe(false)
    if (!undo.ok) expect(undo.reason).toBe('corrupt')
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(broken)

    expect(clearSavedTrips(storage)).toEqual({ ok: true })
    expect(loadSavedTrips(storage).status).toBe('empty')
    expect(saveTripToStorage(MOCK_TRIP, storage).ok).toBe(true)
  })

  it('版本不匹配或 envelopes 结构不对时按损坏处理', () => {
    const storage = createMemoryStorage()
    storage.data.set(SAVED_TRIPS_STORAGE_KEY, JSON.stringify({ version: 999, trips: [] }))
    expect(loadSavedTrips(storage).status).toBe('corrupt')

    storage.data.set(SAVED_TRIPS_STORAGE_KEY, JSON.stringify({ version: SAVED_TRIPS_VERSION, trips: 'nope' }))
    expect(loadSavedTrips(storage).status).toBe('corrupt')
  })

  it('配额满时返回 quota，当前行程不写入', () => {
    const storage = createMemoryStorage()
    storage.failNextWrite(new DOMException('quota', 'QuotaExceededError'))
    const result = saveTripToStorage(MOCK_TRIP, storage)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('quota')
    expect(result.message).toContain('已满')
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBeUndefined()
  })

  it('SecurityError 视为存储不可用', () => {
    const storage = createMemoryStorage()
    storage.failNextWrite(new DOMException('denied', 'SecurityError'))
    const result = saveTripToStorage(MOCK_TRIP, storage)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unavailable')
  })

  it('无 window（SSR / 测试环境）时不抛异常，返回 unavailable', () => {
    vi.stubGlobal('window', undefined)
    expect(getLocalStorage()).toBeNull()
    expect(loadSavedTrips()).toMatchObject({ status: 'unavailable', trips: [] })

    const result = saveTripToStorage(MOCK_TRIP)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unavailable')
  })
})

describe('savedTrips 校验与上限', () => {
  it('忽略无效、重复的记录，保留同 id 中较新的一份', () => {
    const storage = createMemoryStorage()
    const older = record(MOCK_TRIP.id, now - 1_000, cloneTrip({ title: '旧标题' }))
    const newer = record(MOCK_TRIP.id, now, cloneTrip({ title: '新标题' }))
    const invalid = { id: 'broken', savedAt: now, trip: { ...MOCK_TRIP, days: [null] } }
    writeEnvelope(storage, [older, invalid, newer])

    const loaded = loadSavedTrips(storage)
    expect(loaded.status).toBe('ok')
    expect(loaded.trips).toHaveLength(1)
    expect(loaded.trips[0].trip.title).toBe('新标题')
    expect(loaded.skipped).toBe(2)
    expect(loaded.message).toContain('2 条')
  })

  it(`最多保留 ${MAX_SAVED_TRIPS} 条，优先保留较新的记录`, () => {
    const storage = createMemoryStorage()
    const records = Array.from({ length: MAX_SAVED_TRIPS + 5 }, (_, index) =>
      record(`trip-${index}`, now - 10_000 + index, cloneTrip({ id: `trip-${index}`, title: `行程 ${index}` })),
    )
    writeEnvelope(storage, records)

    const loaded = loadSavedTrips(storage)
    expect(loaded.trips).toHaveLength(MAX_SAVED_TRIPS)
    expect(loaded.trips[0].id).toBe(`trip-${MAX_SAVED_TRIPS + 4}`)
    expect(loaded.trips.at(-1)?.id).toBe('trip-5')
    expect(loaded.skipped).toBe(5)
    expect(loaded.message).toContain('已忽略')
  })

  it('单份超过体积上限时拒绝保存：已有记录与原始字节不变，提示可查看和导出日历', () => {
    const stop = MOCK_TRIP.days[0].stops[0]
    const oversizeTrip: Trip = {
      ...MOCK_TRIP,
      id: 'oversize-trip',
      days: Array.from({ length: 8 }, (_, dayIndex) => ({
        day: dayIndex + 1,
        date: null,
        title: `第 ${dayIndex + 1} 天`,
        summary: '',
        legs: [],
        stops: Array.from({ length: 40 }, (_, stopIndex) => ({
          ...stop,
          id: `big-${dayIndex}-${stopIndex}`,
          name: `站点 ${stopIndex}`,
          description: '很长的讲解'.repeat(200),
          address: '地址',
          location: null,
        })),
      })),
    }

    const storage = createMemoryStorage()
    expect(saveTripToStorage(MOCK_TRIP, storage).ok).toBe(true)
    const before = storage.data.get(SAVED_TRIPS_STORAGE_KEY)
    now += 1_000

    const result = saveTripToStorage(oversizeTrip, storage)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_large')
    expect(result.message).toContain(`${Math.round(MAX_SAVED_TRIP_BYTES / 1024)} KB`)
    expect(result.message).toContain('没有保存')
    // 提示只说当前真实存在的能力：查看当前行程 + 导出日历，不再建议不存在的「精简行程」
    expect(result.message).toContain('导出日历')
    expect(result.message).not.toContain('精简')
    // fail-closed：不写一个字节，旧记录仍在
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(before)
    const loaded = loadSavedTrips(storage)
    expect(loaded.skipped).toBe(0)
    expect(loaded.trips.map((item) => item.id)).toEqual([MOCK_TRIP.id])
    expect(loaded.trips[0].trip).toEqual(MOCK_TRIP)
  })

  it('结构异常（重复日期、空站点 id）的行程拒绝保存', () => {
    const storage = createMemoryStorage()
    const stop = MOCK_TRIP.days[0].stops[0]
    const duplicateDays: Trip = {
      ...MOCK_TRIP,
      days: [
        { ...MOCK_TRIP.days[0], stops: [{ ...stop, id: '' }], legs: [] },
        { ...MOCK_TRIP.days[0] },
      ],
    }
    const result = saveTripToStorage(duplicateDays, storage)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid')
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBeUndefined()
  })

  it(`保存第 ${MAX_SAVED_TRIPS + 1} 份时明确失败，不淘汰旧记录、不写入任何字节`, () => {
    const storage = createMemoryStorage()
    const existing = Array.from({ length: MAX_SAVED_TRIPS }, (_, index) =>
      record(`old-${index}`, now - 20_000 + index, cloneTrip({ id: `old-${index}`, title: `旧行程 ${index}` })),
    )
    writeEnvelope(storage, existing)
    const before = storage.data.get(SAVED_TRIPS_STORAGE_KEY)
    now += 1_000

    const result = saveTripToStorage(cloneTrip({ id: 'new-trip', title: '新行程' }), storage)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('limit')
    expect(result.message).toContain(`最多保存 ${MAX_SAVED_TRIPS} 份`)
    // 容量满时 fail-closed：既不淘汰最旧记录，也不允许写入哪怕一个字节
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(before)
    const loaded = loadSavedTrips(storage)
    expect(loaded.trips).toHaveLength(MAX_SAVED_TRIPS)
    expect(loaded.trips.some((item) => item.id === 'new-trip')).toBe(false)
    expect(loaded.trips.some((item) => item.id === 'old-0')).toBe(true)
  })

  it('存储里有无法识别的记录时，保存 / 删除 / 撤销都拒绝写入并保持原始字节', () => {
    const storage = createMemoryStorage()
    const valid = record('keep-me', now, cloneTrip({ id: 'keep-me', title: '可读行程' }))
    const duplicate = record('keep-me', now - 5_000, cloneTrip({ id: 'keep-me', title: '重复旧版本' }))
    const broken = { id: 'broken', savedAt: now, trip: { ...MOCK_TRIP, days: [null] } }
    writeEnvelope(storage, [valid, duplicate, broken])
    const before = storage.data.get(SAVED_TRIPS_STORAGE_KEY)

    const loaded = loadSavedTrips(storage)
    expect(loaded.trips.map((item) => item.id)).toEqual(['keep-me'])
    expect(loaded.skipped).toBe(2)
    expect(loaded.message).toContain('原始数据')

    const save = saveTripToStorage(cloneTrip({ id: 'fresh', title: '新行程' }), storage)
    expect(save.ok).toBe(false)
    if (!save.ok) expect(save.reason).toBe('anomaly')
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(before)

    const remove = deleteSavedTrip('keep-me', storage)
    expect(remove.ok).toBe(false)
    if (!remove.ok) expect(remove.reason).toBe('anomaly')
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(before)

    const undo = undoSavedTripDeletion(valid, storage)
    expect(undo.ok).toBe(false)
    if (!undo.ok) expect(undo.reason).toBe('anomaly')
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(before)

    // 只有用户明确确认的清除才允许丢弃原始字节
    expect(clearSavedTrips(storage)).toEqual({ ok: true })
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBeUndefined()
  })

  it('撤销删除时同 id 已有新版本，不覆盖新版本且返回 restored=false', () => {
    const storage = createMemoryStorage()
    const first = saveTripToStorage(MOCK_TRIP, storage)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const deleted = deleteSavedTrip(MOCK_TRIP.id, storage)
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return

    now += 1_000
    const newer = saveTripToStorage(cloneTrip({ title: '新版本标题' }), storage)
    expect(newer.ok).toBe(true)

    const undone = undoSavedTripDeletion(deleted.removed, storage)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.restored).toBe(false)
    expect(undone.trips).toHaveLength(1)
    expect(undone.trips[0].trip.title).toBe('新版本标题')
  })

  it('存储原始字符串过大时停止读取，避免解析巨型数据', () => {
    const storage = createMemoryStorage()
    storage.data.set(SAVED_TRIPS_STORAGE_KEY, 'x'.repeat(MAX_SAVED_STORAGE_BYTES + 100_000))
    const loaded = loadSavedTrips(storage)
    expect(loaded.status).toBe('corrupt')
    expect(loaded.message).toContain('体积异常')
  })

  it('撤销删除后超过数量上限时明确失败，不偷偷丢数据', () => {
    const storage = createMemoryStorage()
    const full = Array.from({ length: MAX_SAVED_TRIPS }, (_, index) =>
      record(`trip-${index}`, now - index, cloneTrip({ id: `trip-${index}` })),
    )
    writeEnvelope(storage, full)
    const removed = record('removed', now - 100, cloneTrip({ id: 'removed' }))
    const result = undoSavedTripDeletion(removed, storage)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('limit')
    expect(loadSavedTrips(storage).trips).toHaveLength(MAX_SAVED_TRIPS)
  })
})

/**
 * 后端 travel_itinerary.py 的 `_MAX_ROUTE_GEOMETRY_POINTS = 5000` 说明合法路线可以有几千个点。
 * 这组用例锁住前端校验与后端契约一致（不再把 2001 点误判为坏数据），
 * 同时保证容量不足时只给 too_large、不静默丢数据。
 */
describe('savedTrips 长路线几何与容量边界', () => {
  it('单段 2001 点与 5000 点的合法路线都能通过结构校验并原样恢复', () => {
    const storage = createMemoryStorage()

    for (const points of [2001, 5000]) {
      const trip = tripWithRoute(`route-${points}`, points)
      const result = saveTripToStorage(trip, storage)
      // 5000 点单段路线约 190 KB，必须在 640 KB 单份上限内真的存下去，不能只是「结构合法」
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const loaded = loadSavedTrips(storage)
      expect(loaded.skipped).toBe(0)
      const restored = loaded.trips.find((item) => item.id === trip.id)
      expect(restored).toBeDefined()
      expect(restored?.trip.days[0].legs).toHaveLength(1)
      expect(restored?.trip.days[0].legs[0].geometry).toHaveLength(points)
      // 存的是同一份数据：不抽稀、不改点
      expect(restored?.trip).toEqual(trip)
    }
  }, 20_000)

  it(`超过后端 ${MAX_GEOMETRY_POINTS_PER_LEG} 点上限的路线判为结构错误，且不写任何字节`, () => {
    const storage = createMemoryStorage()
    expect(saveTripToStorage(MOCK_TRIP, storage).ok).toBe(true)
    const before = storage.data.get(SAVED_TRIPS_STORAGE_KEY)
    now += 1_000

    const result = saveTripToStorage(
      tripWithRoute('route-over-contract', MAX_GEOMETRY_POINTS_PER_LEG + 1),
      storage,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid')
    expect(result.message).toContain(String(MAX_GEOMETRY_POINTS_PER_LEG))
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(before)
    expect(loadSavedTrips(storage).trips.map((item) => item.id)).toEqual([MOCK_TRIP.id])
  })

  it('7 天 × 8 站 × 每段 150 点（约 315–335 KB）的合规行程可以保存，恢复后数据完整', () => {
    const trip = sevenDayEightStopTrip('seven-day-eight-stop')
    const storage = createMemoryStorage()

    const result = saveTripToStorage(trip, storage)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const raw = storage.data.get(SAVED_TRIPS_STORAGE_KEY)
    expect(raw).toBeTruthy()
    const rawBytes = utf8ByteLength(raw!)
    // 旧的 256 KB 单份上限会误杀这份合法样本
    expect(rawBytes).toBeGreaterThan(256 * 1024)
    expect(rawBytes).toBeLessThan(MAX_SAVED_TRIP_BYTES)

    const loaded = loadSavedTrips(storage)
    expect(loaded.status).toBe('ok')
    expect(loaded.skipped).toBe(0)
    expect(loaded.trips).toHaveLength(1)

    const restored = loaded.trips[0].trip
    expect(restored).toEqual(trip)
    expect(restored.days).toHaveLength(7)
    expect(restored.days.every((day) => day.stops.length === 8)).toBe(true)
    expect(restored.days.every((day) => day.legs.length === 8)).toBe(true)
    expect(
      restored.days.every((day) => day.legs.every((leg) => leg.geometry.length === 150)),
    ).toBe(true)
  }, 20_000)

  it('总体容量放不下时 fail-closed：原始字节不变、旧记录不丢、提示先删除其他行程', () => {
    const storage = createMemoryStorage()
    // 每段 4 000 点 × 4 段 = 16 000 点，单段不超后端 5 000 点上限，单份约 560 KB
    const trips = Array.from({ length: 3 }, (_, index) =>
      tripWithLegs(`capacity-${index}`, 4, 4_000),
    )
    const singleRecordBytes = utf8ByteLength(
      JSON.stringify({ id: trips[0].id, savedAt: now, trip: trips[0] }),
    )
    // 单份合规，两份放得下，三份必然超过总量上限
    expect(singleRecordBytes).toBeLessThan(MAX_SAVED_TRIP_BYTES)
    expect(singleRecordBytes * 2).toBeLessThan(MAX_SAVED_STORAGE_BYTES)
    expect(singleRecordBytes * 3).toBeGreaterThan(MAX_SAVED_STORAGE_BYTES)

    for (const trip of trips.slice(0, 2)) {
      expect(saveTripToStorage(trip, storage).ok).toBe(true)
    }
    const before = storage.data.get(SAVED_TRIPS_STORAGE_KEY)
    now += 1_000

    const third = saveTripToStorage(trips[2], storage)
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.reason).toBe('too_large')
    expect(third.message).toContain('总容量上限')
    expect(third.message).toContain('导出日历')
    expect(third.message).toContain('删除')

    // 一个字节都不写，旧记录完好
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(before)
    const loaded = loadSavedTrips(storage)
    expect(loaded.skipped).toBe(0)
    expect(loaded.trips.map((item) => item.id).sort()).toEqual(['capacity-0', 'capacity-1'])
    expect(loaded.trips.every((item) => item.trip.days[0].legs[0].geometry.length === 4_000)).toBe(
      true,
    )
  }, 30_000)

  it('几何点数超出校验预算但结构合法时给 too_large，而不是误判 invalid', () => {
    const storage = createMemoryStorage()
    const trip = tripWithLegs('geometry-budget', 9, MAX_GEOMETRY_POINTS_PER_LEG)

    const result = saveTripToStorage(trip, storage)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_large')
    expect(result.message).toContain('几何点')
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBeUndefined()
  })

  it('重复保存同一份长路线仍然只保留一条，内容一致', () => {
    const storage = createMemoryStorage()
    const trip = tripWithRoute('route-repeat', 2001)

    const first = saveTripToStorage(trip, storage)
    expect(first.ok).toBe(true)
    now += 1_000
    const second = saveTripToStorage(trip, storage)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.existed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.trips).toHaveLength(1)

    const loaded = loadSavedTrips(storage)
    expect(loaded.trips).toHaveLength(1)
    expect(loaded.trips[0].trip).toEqual(trip)
    expect(loaded.trips[0].savedAt).toBe(now)
  }, 20_000)

  it('读取时总量超限只丢最旧的记录，逐条扣减的字节数与整包重算一致（含 emoji 标题）', () => {
    const storage = createMemoryStorage()
    const records = [0, 1, 2].map((index) => {
      const trip = {
        ...tripWithLegs(`trim-${index}`, 3, 4_800),
        title: `🗺️ 超长路线 ${index} 🚗`,
      }
      return record(trip.id, now - index, trip)
    })
    writeEnvelope(storage, records)
    const raw = storage.data.get(SAVED_TRIPS_STORAGE_KEY)!
    // 单份都在 640 KB 内，但三份加起来已超过总容量上限
    expect(utf8ByteLength(raw)).toBeGreaterThan(MAX_SAVED_STORAGE_BYTES)

    // 暴力解：按 savedAt 从新到旧，整包体积不超上限的最长前缀
    let expected = [...records].sort((a, b) => b.savedAt - a.savedAt)
    while (expected.length > 0) {
      const envelope = JSON.stringify({ version: SAVED_TRIPS_VERSION, trips: expected })
      if (utf8ByteLength(envelope) <= MAX_SAVED_STORAGE_BYTES) break
      expected = expected.slice(0, -1)
    }
    expect(expected).toHaveLength(2)

    const loaded = loadSavedTrips(storage)
    expect(loaded.skipped).toBe(1)
    expect(loaded.trips.map((item) => item.id)).toEqual(expected.map((item) => item.id))
    // 保留下来的仍是完整的原始数据（含 4 字节 emoji 与整段几何）
    expect(loaded.trips[0].trip.title).toContain('🗺️')
    expect(loaded.trips[0].trip.days[0].legs[0].geometry).toHaveLength(4_800)
  }, 30_000)
})

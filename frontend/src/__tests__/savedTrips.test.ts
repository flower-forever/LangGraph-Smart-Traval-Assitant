import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
  type SavedTrip,
  type StorageLike,
} from '../lib/savedTrips'
import type { Trip } from '../lib/api'
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

  it('单份超过体积上限时拒绝保存', () => {
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
    const result = saveTripToStorage(oversizeTrip, storage)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too_large')
    expect(result.message).toContain(`${Math.round(MAX_SAVED_TRIP_BYTES / 1024)} KB`)
    expect(storage.data.get(SAVED_TRIPS_STORAGE_KEY)).toBeUndefined()
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

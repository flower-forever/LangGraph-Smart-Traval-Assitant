import { describe, expect, it } from 'vitest'

import type { TravelMode, Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import {
  MAX_SAVED_TRIP_BYTES,
  checkTripShape,
  loadSavedTrips,
  saveTripToStorage,
  savedTripRecordBytes,
  type StorageLike,
} from '../lib/savedTrips'
import { createTripBackup, parseTripBackup } from '../lib/tripTransfer'
import {
  LOCAL_EDIT_DISCLAIMER,
  LOCAL_EDIT_WARNINGS_NOTICE,
  MAX_DRAFT_STOPS_PER_DAY,
  MAX_EDIT_WARNINGS,
  MAX_UNDO_STEPS,
  UNAVAILABLE_LEG_DESCRIPTION,
  addDraftStop,
  applyDraft,
  createTripDraft,
  dailyStopLimitNotices,
  discardDraft,
  isDraftDirty,
  localChecksForDraft,
  moveDraftStop,
  removeDraftStop,
  undoDraft,
  updateDraftStop,
  type DraftApplySuccess,
  type DraftEditResult,
  type DraftFailureReason,
  type NewDraftStop,
  type TripDraft,
  type UpdateDraftStopPatch,
} from '../lib/tripDraft'
import { MOCK_TRIP, MOCK_TRIP_SAME_COORD } from './fixtures/trip'

function cloneTrip(trip: Trip = MOCK_TRIP): Trip {
  return JSON.parse(JSON.stringify(trip)) as Trip
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item)
    }
    Object.freeze(value)
  }
  return value
}

function makeDraft(
  base: Trip,
  forkTripId = 'trip-fork-1',
  newLegMode: TravelMode = 'walking',
): TripDraft {
  const created = createTripDraft(base, { forkTripId, newLegMode })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

function edit(result: DraftEditResult): TripDraft {
  if (!result.ok) throw new Error(result.message)
  return result.draft
}

function applyOk(draft: TripDraft): DraftApplySuccess {
  const result = applyDraft(draft)
  if (!result.ok) throw new Error(result.message)
  return result
}

function dayOf(trip: { days: readonly TripDay[] }, dayNumber: number): TripDay {
  const day = trip.days.find((item) => item.day === dayNumber)
  if (!day) throw new Error(`missing day ${dayNumber}`)
  return day
}

function stopOf(day: TripDay, stopId: string): TripStop {
  const stop = day.stops.find((item) => item.id === stopId)
  if (!stop) throw new Error(`missing stop ${stopId}`)
  return stop
}

function assertLegReferences(day: TripDay): void {
  const stopIds = new Set(day.stops.map((stop) => stop.id))
  expect(stopIds.size).toBe(day.stops.length)
  for (const leg of day.legs) {
    expect(stopIds.has(leg.from_stop_id)).toBe(true)
    expect(stopIds.has(leg.to_stop_id)).toBe(true)
  }
  expect(day.legs).toHaveLength(Math.max(0, day.stops.length - 1))
}

function memoryStorage(): StorageLike {
  const data = new Map<string, string>()
  return {
    getItem(key: string) {
      return data.get(key) ?? null
    },
    setItem(key: string, value: string) {
      data.set(key, value)
    },
    removeItem(key: string) {
      data.delete(key)
    },
  }
}

function tripWithWarnings(count: number): Trip {
  const trip = cloneTrip()
  trip.warnings = Array.from({ length: count }, (_, index) => `旧提醒 ${index + 1}`)
  return trip
}

describe('createTripDraft', () => {
  it('创建草稿不修改 base，未改天保持引用，历史为空', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)

    expect(draft.base).toBe(base)
    expect(draft.forkTripId).toBe('trip-fork-1')
    expect(draft.newLegMode).toBe('walking')
    expect(draft.days[0]).toBe(base.days[0])
    expect(draft.days[1]).toBe(base.days[1])
    expect(draft.changedDays).toEqual([])
    expect(draft.history).toEqual([])
    expect(draft.revision).toBe(0)
    expect(isDraftDirty(draft)).toBe(false)
  })

  it('拒绝不合法 base、fork id 与出行方式', () => {
    const valid = cloneTrip()

    expect(
      createTripDraft({ ...valid, days: [] }, { forkTripId: 'f1', newLegMode: 'walking' }),
    ).toMatchObject({ ok: false, reason: 'invalid_base' })

    expect(
      createTripDraft(valid, { forkTripId: valid.id, newLegMode: 'walking' }),
    ).toMatchObject({ ok: false, reason: 'invalid_fork_id' })
    expect(
      createTripDraft(valid, { forkTripId: '', newLegMode: 'walking' }),
    ).toMatchObject({ ok: false, reason: 'invalid_fork_id' })
    expect(
      createTripDraft(valid, { forkTripId: '   ', newLegMode: 'walking' }),
    ).toMatchObject({ ok: false, reason: 'invalid_fork_id' })
    expect(
      createTripDraft(valid, { forkTripId: 'x'.repeat(101), newLegMode: 'walking' }),
    ).toMatchObject({ ok: false, reason: 'invalid_fork_id' })
    expect(
      createTripDraft(valid, { forkTripId: 'f1', newLegMode: 'bike' as TravelMode }),
    ).toMatchObject({ ok: false, reason: 'invalid_mode' })
  })

  it('接受长度正好 100 的 fork id，并在应用时使用它', () => {
    const forkId = 'f'.repeat(100)
    const draft = makeDraft(deepFreeze(cloneTrip()), forkId)
    const edited = edit(updateDraftStop(draft, 1, 's1', { time: '09:10' }))
    const applied = applyOk(edited)

    expect(applied.trip.id).toBe(forkId)
    expect(applied.trip.id).not.toBe(draft.base.id)
  })
})

describe('修改地点：名称 / 地址', () => {
  it('改名称会清坐标、让相关旧路段 unavailable，不牵连无关路段', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)
    const updated = edit(updateDraftStop(draft, 1, 's1', { name: '断桥新名' }))
    const day = dayOf(updated, 1)

    expect(stopOf(day, 's1').name).toBe('断桥新名')
    expect(stopOf(day, 's1').location).toBeNull()
    expect(day.legs).toHaveLength(2)
    expect(day.legs[0]).toMatchObject({
      from_stop_id: 's1',
      to_stop_id: 's2',
      mode: 'walking',
      route_type: 'unavailable',
      distance_m: null,
      duration_minutes: null,
      geometry: [],
      description: UNAVAILABLE_LEG_DESCRIPTION,
    })
    // s2 → s3 与改动站点无关，仍原样复用
    expect(day.legs[1]).toBe(base.days[0].legs[1])
    assertLegReferences(day)

    // 冻结的 base 没有被动过
    expect(stopOf(base.days[0], 's1').name).toBe('断桥残雪')
    expect(stopOf(base.days[0], 's1').location).toEqual({ lng: 120.1576, lat: 30.2726 })

    const applied = applyOk(updated)
    expect(stopOf(applied.trip.days[0], 's1').location).toBeNull()
    expect(applied.trip.days[0].legs[0].geometry).toEqual([])
    expect(applied.trip.days[0].legs[1]).toBe(base.days[0].legs[1])
    expect(checkTripShape(applied.trip).ok).toBe(true)
  })

  it('改地址同样清坐标并失效相关路段，保留当天其他路段', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)
    const updated = edit(
      updateDraftStop(draft, 1, 's2', { address: '杭州市西湖区北山街' }),
    )
    const day = dayOf(updated, 1)

    expect(stopOf(day, 's2').address).toBe('杭州市西湖区北山街')
    expect(stopOf(day, 's2').location).toBeNull()
    expect(day.legs[0].route_type).toBe('unavailable')
    expect(day.legs[1].route_type).toBe('unavailable')
    expect(day.legs[0].geometry).toEqual([])
    expect(day.legs[1].geometry).toEqual([])
    expect(day.legs[0].description).toBe(UNAVAILABLE_LEG_DESCRIPTION)
    expect(day.legs[1].description).toBe(UNAVAILABLE_LEG_DESCRIPTION)
  })
})

describe('只改时间 / 停留 / 描述：保留坐标和几何', () => {
  it('改时间保留 location 与每段路线的 geometry 引用', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)
    const updated = edit(updateDraftStop(draft, 1, 's1', { time: '09:45' }))
    const day = dayOf(updated, 1)

    expect(stopOf(day, 's1').time).toBe('09:45')
    expect(stopOf(day, 's1').location).toEqual({ lng: 120.1576, lat: 30.2726 })
    expect(day.legs[0]).toBe(base.days[0].legs[0])
    expect(day.legs[1]).toBe(base.days[0].legs[1])

    const applied = applyOk(updated)
    expect(applied.trip.days[0].legs[0].geometry).toBe(base.days[0].legs[0].geometry)
    expect(checkTripShape(applied.trip).ok).toBe(true)
  })

  it('改停留时长与描述同样保留几何', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)
    const updated = edit(
      updateDraftStop(draft, 1, 's2', {
        duration_minutes: 75,
        description: '改过的描述',
      }),
    )
    const day = dayOf(updated, 1)

    expect(stopOf(day, 's2').duration_minutes).toBe(75)
    expect(stopOf(day, 's2').description).toBe('改过的描述')
    expect(stopOf(day, 's2').location).toEqual({ lng: 120.1522, lat: 30.2631 })
    expect(day.legs[0]).toBe(base.days[0].legs[0])
    expect(day.legs[1]).toBe(base.days[0].legs[1])
  })

  it('旧数据里比后端宽的字段在改时间时不会被二次校验或截断', () => {
    const wide = cloneTrip()
    wide.days[0].stops[0].name = '长'.repeat(300)
    wide.days[0].stops[0].address = '路'.repeat(1000)
    expect(checkTripShape(wide).ok).toBe(true)

    const draft = makeDraft(wide)
    const changed = edit(
      updateDraftStop(draft, 1, 's1', {
        // 界面把整张表单提交回来：旧的长站名原样带上，不应被 120 字新上限卡住
        name: '长'.repeat(300),
        time: '09:10',
      }),
    )
    const applied = applyOk(changed)

    expect(stopOf(applied.trip.days[0], 's1').name).toBe('长'.repeat(300))
    expect(stopOf(applied.trip.days[0], 's1').address).toBe('路'.repeat(1000))
    expect(checkTripShape(applied.trip).ok).toBe(true)
  })

  it('导入日 legs 为空时，只改 time/duration/description 的 day.legs 引用与内容保持原样', () => {
    // 前端 checkTripShape 接受 legs 为空的导入日（同坐标夹具即如此）
    const imported = cloneTrip()
    imported.id = 'trip-imported'
    imported.days = [MOCK_TRIP_SAME_COORD.days[0]]
    expect(checkTripShape(imported).ok).toBe(true)
    expect(imported.days[0].legs).toEqual([])

    const beforeLegs = imported.days[0].legs
    const draft = makeDraft(imported)
    let edited = edit(updateDraftStop(draft, 1, 'd1', { time: '09:30' }))
    edited = edit(updateDraftStop(edited, 1, 'd2', { duration_minutes: 70 }))
    edited = edit(updateDraftStop(edited, 1, 'd3', { description: '只改文字' }))
    const day = dayOf(edited, 1)

    expect(day.legs).toBe(beforeLegs)
    expect(day.legs).toEqual([])
    expect(stopOf(day, 'd1').time).toBe('09:30')
    expect(stopOf(day, 'd2').duration_minutes).toBe(70)
    expect(stopOf(day, 'd3').description).toBe('只改文字')
    // 坐标没有被时间编辑碰掉
    expect(stopOf(day, 'd1').location).toEqual({ lng: 120.0972, lat: 30.2408 })
  })

  it('导入日 legs 非标准邻接时，time-only 编辑保持每个现有 leg 原对象', () => {
    // checkTripShape 不校验邻接：这段 legs 跳过 d3、含一条 d2→d1 的「逆序」段，都是合法导入
    const imported = cloneTrip()
    imported.id = 'trip-imported-2'
    const oddLegs: TripLeg[] = [
      {
        from_stop_id: 'd1',
        to_stop_id: 'd3',
        mode: 'walking',
        route_type: 'navigation',
        distance_m: 900,
        duration_minutes: 11,
        geometry: [{ lng: 120.0972, lat: 30.2408 }],
        description: '导入数据里的非标准邻接',
      },
      {
        from_stop_id: 'd2',
        to_stop_id: 'd1',
        mode: 'driving',
        route_type: 'straight_line',
        distance_m: 100,
        duration_minutes: 2,
        geometry: [],
        description: '逆序段',
      },
    ]
    imported.days = [{ ...MOCK_TRIP_SAME_COORD.days[0], legs: oddLegs }]
    expect(checkTripShape(imported).ok).toBe(true)

    const beforeLegs = imported.days[0].legs
    const draft = makeDraft(imported)
    const edited = edit(updateDraftStop(draft, 1, 'd2', { time: '17:30' }))
    const day = dayOf(edited, 1)

    expect(day.legs).toHaveLength(2)
    expect(day.legs[0]).toBe(beforeLegs[0])
    expect(day.legs[1]).toBe(beforeLegs[1])
    expect(stopOf(day, 'd2').time).toBe('17:30')
  })
})

describe('增删与重排', () => {
  it('空日可以先加一个站，再加第二个站生成 unavailable 新路段', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)
    const first = edit(
      addDraftStop(draft, 2, {
        id: 'e1',
        name: '运河茶楼',
        time: '14:00',
        duration_minutes: 40,
        address: '杭州市拱墅区',
      }),
    )
    let day = dayOf(first, 2)
    expect(day.stops.map((stop) => stop.id)).toEqual(['e1'])
    expect(day.legs).toEqual([])

    const second = edit(
      addDraftStop(first, 2, {
        id: 'e2',
        name: '拱宸桥',
        time: '15:30',
      }),
    )
    day = dayOf(second, 2)
    expect(day.stops.map((stop) => stop.id)).toEqual(['e1', 'e2'])
    expect(day.legs).toHaveLength(1)
    expect(day.legs[0]).toMatchObject({
      from_stop_id: 'e1',
      to_stop_id: 'e2',
      mode: 'walking',
      route_type: 'unavailable',
      distance_m: null,
      duration_minutes: null,
      geometry: [],
      description: UNAVAILABLE_LEG_DESCRIPTION,
    })
    assertLegReferences(day)

    const applied = applyOk(second)
    expect(applied.trip.days[1].summary).toContain('第 2 天')
    expect(applied.trip.days[1].summary).toContain('现有 2 个站点')
    expect(applied.trip.days[0]).toBe(base.days[0])
    expect(applied.trip.days[2]).toBe(base.days[2])
    expect(checkTripShape(applied.trip).ok).toBe(true)
  })

  it('新路段使用调用方显式传入的 newLegMode，复用路段保留原 mode', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base, 'trip-fork-driving', 'driving')
    const first = edit(
      addDraftStop(draft, 2, { id: 'd1', name: '新站一', time: '14:00' }),
    )
    const second = edit(
      addDraftStop(first, 2, { id: 'd2', name: '新站二', time: '15:00' }),
    )
    expect(dayOf(second, 2).legs[0].mode).toBe('driving')

    // 改名称只让涉及该站的路段失效；无关旧路段仍保留原来的 driving
    const renamed = edit(updateDraftStop(makeDraft(base), 1, 's1', { name: '新断桥' }))
    const day = dayOf(renamed, 1)
    expect(day.legs[0].mode).toBe('walking')
    expect(day.legs[1]).toBe(base.days[0].legs[1])
    expect(day.legs[1].mode).toBe('driving')
  })

  it('新增站点 id 与全行程已有 id 冲突时拒绝，且不改动草稿', () => {
    const draft = makeDraft(deepFreeze(cloneTrip()))
    const before = JSON.stringify(draft)
    const result = addDraftStop(draft, 2, {
      id: 's4',
      name: '重复站点',
      time: '10:00',
    })

    expect(result).toMatchObject({ ok: false, reason: 'duplicate_stop_id' })
    expect(JSON.stringify(draft)).toBe(before)
    expect(draft.revision).toBe(0)
  })

  it('删除中间站后重建相邻关系，不留悬空路段', () => {
    const draft = edit(removeDraftStop(makeDraft(deepFreeze(cloneTrip())), 1, 's2'))
    const day = dayOf(draft, 1)

    expect(day.stops.map((stop) => stop.id)).toEqual(['s1', 's3'])
    expect(day.legs).toHaveLength(1)
    expect(day.legs[0]).toMatchObject({
      from_stop_id: 's1',
      to_stop_id: 's3',
      route_type: 'unavailable',
      geometry: [],
    })
    assertLegReferences(day)
  })

  it('允许把一天删空，应用后仍合法，并能再次增站', () => {
    const base = deepFreeze(cloneTrip())
    let draft = makeDraft(base)
    for (const stopId of ['s1', 's2', 's3']) {
      draft = edit(removeDraftStop(draft, 1, stopId))
    }
    let day = dayOf(draft, 1)
    expect(day.stops).toEqual([])
    expect(day.legs).toEqual([])
    assertLegReferences(day)

    const applied = applyOk(draft)
    expect(applied.trip.days[0].stops).toEqual([])
    expect(applied.trip.days[0].legs).toEqual([])
    expect(applied.trip.days[0].summary).toContain('没有站点')
    expect(checkTripShape(applied.trip).ok).toBe(true)
    expect(applied.localChecks.some((check) => check.kind === 'empty_day')).toBe(true)

    const readded = edit(
      addDraftStop(draft, 1, { id: 'n1', name: '重开站点', time: '12:00' }),
    )
    expect(dayOf(readded, 1).stops.map((stop) => stop.id)).toEqual(['n1'])
  })

  it('上移 / 下移按新相邻关系重建；保留下来的邻接复用旧路段', () => {
    const base = deepFreeze(cloneTrip())
    let draft = makeDraft(base)
    draft = edit(
      addDraftStop(draft, 1, {
        id: 'm4',
        name: '苏堤春晓',
        time: '13:00',
      }),
    )
    // 追加 m4 时 s3→m4 是新关系，s1→s2 仍是原邻接
    expect(dayOf(draft, 1).legs[0]).toBe(base.days[0].legs[0])

    const moved = edit(moveDraftStop(draft, 1, 'm4', 'up'))
    const day = dayOf(moved, 1)
    expect(day.stops.map((stop) => stop.id)).toEqual(['s1', 's2', 'm4', 's3'])
    expect(day.legs[0]).toBe(base.days[0].legs[0])
    expect(day.legs[1]).toMatchObject({
      from_stop_id: 's2',
      to_stop_id: 'm4',
      route_type: 'unavailable',
      geometry: [],
    })
    expect(day.legs[2]).toMatchObject({
      from_stop_id: 'm4',
      to_stop_id: 's3',
      route_type: 'unavailable',
      geometry: [],
    })
    assertLegReferences(day)

    // 顶部再上移、底部再下移都是 no-op
    expect(moveDraftStop(moved, 1, 's1', 'up')).toMatchObject({ ok: true, changed: false })
  })

  it('移动不存在的站点返回 unknown_stop，草稿不变', () => {
    const draft = makeDraft(deepFreeze(cloneTrip()))
    const before = JSON.stringify(draft)
    const result = moveDraftStop(draft, 1, 'nope', 'down')

    expect(result).toMatchObject({ ok: false, reason: 'unknown_stop' })
    expect(JSON.stringify(draft)).toBe(before)
  })

  it('单日站点数达到本地结构上限时拒绝新增', () => {
    const crowded = cloneTrip()
    crowded.days[0] = {
      ...crowded.days[0],
      stops: Array.from({ length: MAX_DRAFT_STOPS_PER_DAY }, (_, index) => ({
        id: `c${index}`,
        name: `站点 ${index}`,
        time: '09:00',
        duration_minutes: null,
        description: '',
        address: '',
        location: null,
      })),
      legs: [],
    }
    expect(checkTripShape(crowded).ok).toBe(true)
    const draft = makeDraft(crowded)
    const result = addDraftStop(draft, 1, {
      id: 'overflow',
      name: '溢出站点',
      time: '10:00',
    })

    expect(result).toMatchObject({ ok: false, reason: 'stop_limit' })
  })
})

describe('撤销与放弃', () => {
  it('撤销回到 base 引用，空历史撤销是 no-op', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)
    const edited = edit(updateDraftStop(draft, 1, 's1', { name: '新名' }))
    const undone = edit(undoDraft(edited))

    expect(undone.days).toBe(base.days)
    expect(undone.changedDays).toEqual([])
    expect(undone.days[0]).toBe(base.days[0])
    expect(undoDraft(draft)).toMatchObject({ ok: true, changed: false })
  })

  it('撤销历史有界，且不复制 geometry', () => {
    const base = deepFreeze(cloneTrip())
    let draft = makeDraft(base)
    for (let index = 0; index < MAX_UNDO_STEPS + 5; index += 1) {
      draft = edit(
        updateDraftStop(draft, 1, 's1', { time: index % 2 === 0 ? '09:10' : '09:20' }),
      )
      expect(draft.history.length).toBeLessThanOrEqual(MAX_UNDO_STEPS)
    }
    expect(draft.history).toHaveLength(MAX_UNDO_STEPS)
    expect(draft.history[0].days[0].legs[0].geometry).toBe(base.days[0].legs[0].geometry)

    let undone = 0
    for (let index = 0; index < MAX_UNDO_STEPS + 5; index += 1) {
      const result = undoDraft(draft)
      if (!result.ok || !result.changed) break
      undone += 1
      draft = result.draft
    }
    expect(undone).toBe(MAX_UNDO_STEPS)
    expect(undoDraft(draft)).toMatchObject({ ok: true, changed: false })
  })

  it('放弃草稿返回原始 base，不产生副本字段', () => {
    const base = deepFreeze(cloneTrip())
    const draft = edit(updateDraftStop(makeDraft(base), 1, 's1', { name: '未应用的改名' }))

    const discarded = discardDraft(draft)
    expect(discarded).toBe(base)
    expect(JSON.stringify(discarded)).toBe(JSON.stringify(base))
  })
})

describe('导入 ID 含控制字符时的路段键无歧义', () => {
  function leg(from: string, to: string, distance: number): TripLeg {
    return {
      from_stop_id: from,
      to_stop_id: to,
      mode: 'walking',
      route_type: 'navigation',
      distance_m: distance,
      duration_minutes: null,
      geometry: [],
      description: `leg ${from}->${to}`,
    }
  }

  function tripWithIds(...ids: string[]): Trip {
    const trip = cloneTrip()
    trip.id = 'trip-nul'
    trip.days = [
      {
        day: 1,
        date: null,
        title: '控制字符 ID',
        summary: '',
        stops: ids.map((id, index) => ({
          id,
          name: `站点 ${index}`,
          time: '09:00',
          duration_minutes: null,
          description: '',
          address: '',
          location: null,
        })),
        legs: [],
      },
    ]
    return trip
  }

  it('删除中间站时，含 \u0000 的相邻组合不会互相冒充复用', () => {
    // ["a\u0000b", "a", "b"]：旧邻接 a\0b→a 与新邻接 a→b 若用 \u0000 拼接会得到同一个键
    const ids = ['a\u0000b', 'a', 'b']
    const base = tripWithIds(...ids)
    base.days[0].legs = [leg('a\u0000b', 'a', 100), leg('a', 'b', 200)]
    expect(checkTripShape(base).ok).toBe(true)

    const draft = makeDraft(base)
    const removed = edit(removeDraftStop(draft, 1, 'a\u0000b'))
    const day = dayOf(removed, 1)

    expect(day.stops.map((stop) => stop.id)).toEqual(['a', 'b'])
    expect(day.legs).toHaveLength(1)
    // a→b 的旧路段确实存在且未被动过，应原样复用
    expect(day.legs[0]).toBe(base.days[0].legs[1])
    expect(day.legs[0].distance_m).toBe(200)
    expect(day.legs[0].description).toBe('leg a->b')
  })

  it('同键不同含义的邻接不会错拿别人的路段', () => {
    // 旧邻接 a→b\0c 与 a\0b→c 用 \u0000 拼出的键都是 "a\0b\0c"：
    // Map 里后写入的 a\0b→c 会覆盖 a→b\0c。在头部加一站后 a→b\0c 仍是邻接，
    // 复用判断却会错拿 a\0b→c 的路段内容。
    const base = tripWithIds('a', 'b\u0000c', 'a\u0000b', 'c')
    base.days[0].legs = [
      leg('a', 'b\u0000c', 100),
      leg('b\u0000c', 'a\u0000b', 50),
      leg('a\u0000b', 'c', 999),
    ]
    expect(checkTripShape(base).ok).toBe(true)

    const draft = makeDraft(base)
    const added = edit(addDraftStop(draft, 1, { id: 'q', name: '队头', time: '08:00' }, { index: 0 }))
    const day = dayOf(added, 1)
    expect(day.stops.map((stop) => stop.id)).toEqual(['q', 'a', 'b\u0000c', 'a\u0000b', 'c'])
    expect(day.legs).toHaveLength(4)
    // q→a 是新邻接，unavailable；a→b\0c 仍存在，必须复用它自己的旧路段（100 米）
    expect(day.legs[0]).toMatchObject({ from_stop_id: 'q', to_stop_id: 'a', route_type: 'unavailable' })
    expect(day.legs[1]).toBe(base.days[0].legs[0])
    expect(day.legs[1].distance_m).toBe(100)
    // b\0c→a\0b 邻接未变，复用；a\0b→c 邻接未变，复用
    expect(day.legs[2]).toBe(base.days[0].legs[1])
    expect(day.legs[3]).toBe(base.days[0].legs[2])
  })
})

describe('改名再改回：坐标不自动恢复，undo 才回到原值', () => {
  it('改回原名后站点身份与 base 一致但坐标保持失效，摘要仍按实际路段描述', () => {
    const base = deepFreeze(cloneTrip())
    let draft = makeDraft(base)
    draft = edit(updateDraftStop(draft, 1, 's1', { name: '新断桥' }))
    expect(stopOf(dayOf(draft, 1), 's1').location).toBeNull()

    draft = edit(updateDraftStop(draft, 1, 's1', { name: '断桥残雪' }))
    const day = dayOf(draft, 1)

    // 文本一致、坐标仍是失效的 null：这不是完整 no-op，草稿仍算 dirty
    expect(stopOf(day, 's1').name).toBe('断桥残雪')
    expect(stopOf(day, 's1').location).toBeNull()
    expect(day.legs[0].route_type).toBe('unavailable')
    expect(isDraftDirty(draft)).toBe(true)

    // 应用后摘要说的是实际状态：1 段失效、1 段保留，而不是「全部待重取」
    const applied = applyOk(draft)
    expect(applied.trip.days[0].summary).toContain('1 段相邻路线待重新获取')
    expect(applied.trip.days[0].summary).toContain('1 段相邻路线保留原样')
  })

  it('undo 恢复原坐标与原路段；time-only 改回仍是完整 no-op', () => {
    const base = deepFreeze(cloneTrip())
    let draft = makeDraft(base)
    draft = edit(updateDraftStop(draft, 1, 's1', { name: '新断桥' }))
    draft = edit(updateDraftStop(draft, 1, 's1', { name: '断桥残雪' }))

    // 两次撤销回到最初：undo 只恢复上一状态，改回原名那步本身保留失效坐标
    const once = edit(undoDraft(draft))
    expect(stopOf(dayOf(once, 1), 's1').name).toBe('新断桥')
    expect(stopOf(dayOf(once, 1), 's1').location).toBeNull()
    const undone = edit(undoDraft(once))
    expect(stopOf(dayOf(undone, 1), 's1').location).toEqual({ lng: 120.1576, lat: 30.2726 })
    expect(dayOf(undone, 1).legs[0]).toBe(base.days[0].legs[0])

    const timeOnly = edit(updateDraftStop(makeDraft(base), 1, 's1', { time: '09:30' }))
    const timeBack = edit(updateDraftStop(timeOnly, 1, 's1', { time: '09:00' }))
    expect(isDraftDirty(timeBack)).toBe(false)
    expect(applyOk(timeBack).changed).toBe(false)
  })
})

describe('applyDraft：摘要、提醒与形状', () => {
  it('无变化时应用是 no-op：不换 id、不追加提醒', () => {
    const base = deepFreeze(cloneTrip())
    const applied = applyOk(makeDraft(base))

    expect(applied.changed).toBe(false)
    expect(applied.trip).toBe(base)
    expect(applied.changedDays).toEqual([])
    expect(applied.localChecks).toEqual([])
    expect(applied.omittedWarnings).toBe(0)
    expect(applied.notices).toEqual([])
    expect(applied.trip.warnings).toBe(base.warnings)
  })

  it('同值更新与「改了又改回」都不算变化', () => {
    const base = deepFreeze(cloneTrip())
    const draft = makeDraft(base)

    expect(updateDraftStop(draft, 1, 's1', { time: '09:00' })).toMatchObject({
      ok: true,
      changed: false,
    })

    let edited = edit(updateDraftStop(draft, 1, 's1', { time: '09:15' }))
    edited = edit(updateDraftStop(edited, 1, 's1', { time: '09:00' }))
    expect(isDraftDirty(edited)).toBe(false)

    const applied = applyOk(edited)
    expect(applied.changed).toBe(false)
    expect(applied.trip).toBe(base)
    expect(localChecksForDraft(edited)).toEqual([])
  })

  it('时间-only 编辑保留了导航，摘要不再声称全部路线需要重新获取', () => {
    const applied = applyOk(
      edit(updateDraftStop(makeDraft(deepFreeze(cloneTrip())), 1, 's1', { time: '09:45' })),
    )
    const summary = applied.trip.days[0].summary

    // s1→s2、s2→s3 都原样保留，没有任何待重取路段
    expect(applied.trip.days[0].legs[0].route_type).toBe('navigation')
    expect(summary).not.toContain('需要重新获取')
    expect(summary).toContain('2 段相邻路线保留原样')
  })

  it('改名后失效了部分路段，摘要按实际失效数描述', () => {
    const applied = applyOk(
      edit(updateDraftStop(makeDraft(deepFreeze(cloneTrip())), 1, 's1', { name: '新断桥' })),
    )
    const summary = applied.trip.days[0].summary

    // s1→s2 失效、s2→s3 保留
    expect(applied.trip.days[0].legs[0].route_type).toBe('unavailable')
    expect(applied.trip.days[0].legs[1].route_type).toBe('straight_line')
    expect(summary).toContain('1 段相邻路线待重新获取')
    expect(summary).toContain('1 段相邻路线保留原样')
  })

  it('应用更新被改天与全行程 summary，其他天保持原样', () => {
    const base = deepFreeze(cloneTrip())
    const applied = applyOk(
      edit(updateDraftStop(makeDraft(base), 1, 's1', { time: '09:45' })),
    )

    expect(applied.changed).toBe(true)
    expect(applied.trip.id).toBe('trip-fork-1')
    expect(applied.trip.source).toBe('example')
    expect(applied.trip.summary).toContain('本地编辑副本')
    expect(applied.trip.summary).toContain('第 1 天')
    expect(applied.trip.summary).not.toBe(base.summary)
    expect(applied.trip.days[0].summary).toContain('第 1 天')
    expect(applied.trip.days[0].summary).toContain('现有 3 个站点')
    expect(applied.trip.days[1]).toBe(base.days[1])
    expect(applied.trip.days[2]).toBe(base.days[2])
    expect(applied.trip.days[1].summary).toBe(base.days[1].summary)
    expect(applied.trip.days[2].summary).toBe(base.days[2].summary)
    expect(applied.changedDays).toEqual([1])
  })

  it('warnings 第一项是持久化的本地编辑说明，旧提醒保留为编辑前参考', () => {
    const base = deepFreeze(cloneTrip())
    const applied = applyOk(
      edit(updateDraftStop(makeDraft(base), 1, 's1', { name: '新断桥' })),
    )

    expect(applied.trip.warnings[0]).toContain('本地编辑说明')
    expect(applied.trip.warnings[0]).toContain('尚未重新规划')
    expect(applied.trip.warnings[0]).toContain('不能当成仍然成立')
    expect(applied.trip.warnings[0]).toContain('不能当成已经排除')
    expect(applied.trip.warnings[1]).toBe(base.warnings[0])
    expect(applied.trip.warnings).toHaveLength(2)
    expect(applied.omittedWarnings).toBe(0)
    expect(applied.notices).toContain(LOCAL_EDIT_DISCLAIMER)
    expect(applied.notices).toContain(LOCAL_EDIT_WARNINGS_NOTICE)
  })

  it('输出只含 Trip v1 字段，不塞草稿元数据', () => {
    const applied = applyOk(
      edit(updateDraftStop(makeDraft(deepFreeze(cloneTrip())), 1, 's1', { time: '09:20' })),
    )

    expect(Object.keys(applied.trip).sort()).toEqual(
      ['id', 'source', 'destination', 'title', 'summary', 'map_coordinate_system', 'warnings', 'days'].sort(),
    )
    expect(Object.keys(applied.trip.days[0]).sort()).toEqual(
      ['day', 'date', 'title', 'summary', 'stops', 'legs'].sort(),
    )
  })

  it('40 条提醒边界：总数不超过 40，省略条数写进说明', () => {
    const base = tripWithWarnings(40)
    expect(checkTripShape(base).ok).toBe(true)
    const applied = applyOk(
      edit(updateDraftStop(makeDraft(base), 1, 's1', { time: '09:10' })),
    )

    expect(applied.trip.warnings).toHaveLength(MAX_EDIT_WARNINGS)
    expect(applied.omittedWarnings).toBe(1)
    expect(applied.trip.warnings[0]).toContain('省略 1 条')
    expect(applied.trip.warnings[1]).toBe('旧提醒 1')
    expect(applied.trip.warnings[MAX_EDIT_WARNINGS - 1]).toBe('旧提醒 39')
    expect(base.warnings).toHaveLength(40)
  })

  it('前端比后端宽的 45 条提醒：应用时明确计数省略，不默默截断', () => {
    const base = tripWithWarnings(45)
    expect(checkTripShape(base).ok).toBe(true)
    const applied = applyOk(
      edit(updateDraftStop(makeDraft(base), 1, 's1', { time: '09:10' })),
    )

    expect(applied.trip.warnings).toHaveLength(MAX_EDIT_WARNINGS)
    expect(applied.omittedWarnings).toBe(6)
    expect(applied.trip.warnings[0]).toContain('省略 6 条')
    expect(applied.trip.warnings[0]).toContain('原始行程副本仍保留')
    expect(base.warnings).toHaveLength(45)
  })

  it('应用结果超过本地保存 / 备份容量时明确拒绝，不返回存不下的副本', () => {
    const base = cloneTrip()
    base.warnings = []
    const stopCount = 100
    base.days = [
      {
        day: 1,
        date: null,
        title: '容量边界',
        summary: '',
        stops: Array.from({ length: stopCount }, (_, index) => ({
          id: `cap-${index}`,
          name: `容量站点 ${index}`,
          time: '09:00',
          duration_minutes: null,
          description: 'x'.repeat(6000),
          address: '',
          location: null,
        })),
        legs: [],
      },
    ]
    const initialBytes = savedTripRecordBytes(base)
    const extra = Math.max(0, Math.ceil((MAX_SAVED_TRIP_BYTES - 200 - initialBytes) / stopCount))
    base.days[0].stops = base.days[0].stops.map((stop) => ({
      ...stop,
      description: stop.description + 'y'.repeat(extra),
    }))

    expect(checkTripShape(base).ok).toBe(true)
    expect(savedTripRecordBytes(base)).toBeLessThanOrEqual(MAX_SAVED_TRIP_BYTES)
    expect(MAX_SAVED_TRIP_BYTES - savedTripRecordBytes(base)).toBeLessThan(1024)

    const edited = edit(
      updateDraftStop(makeDraft(base), 1, 'cap-0', { name: '容量改名' }),
    )
    const applied = applyDraft(edited)

    expect(applied.ok).toBe(false)
    if (!applied.ok) {
      expect(applied.reason).toBe('postcondition_failed')
      expect(applied.message).toContain('超过')
    }
    expect(base.days[0].stops[0].name).toBe('容量站点 0')
  })

  it('同一草稿多次应用复用 fork id，结果逐字节一致', () => {    const draft = edit(
      updateDraftStop(makeDraft(deepFreeze(cloneTrip())), 1, 's1', { time: '09:35' }),
    )
    const first = applyOk(draft)
    const second = applyOk(draft)

    expect(first.trip.id).toBe(second.trip.id)
    expect(JSON.stringify(first.trip)).toBe(JSON.stringify(second.trip))
  })

  it('应用后仍通过 checkTripShape、JSON 备份往返和本地保存形状', () => {
    const applied = applyOk(
      edit(updateDraftStop(makeDraft(cloneTrip()), 1, 's1', { name: '新断桥' })),
    )
    expect(checkTripShape(applied.trip).ok).toBe(true)

    const backup = createTripBackup(applied.trip, { now: new Date('2026-01-02T03:04:05Z') })
    expect(backup.ok).toBe(true)
    if (backup.ok) {
      const parsed = parseTripBackup(backup.json)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(parsed.trip).toEqual(applied.trip)
        expect(parsed.trip.warnings[0]).toContain('本地编辑说明')
        expect(parsed.trip.source).toBe('example')
        expect(parsed.trip.id).toBe('trip-fork-1')
      }
    }

    const storage = memoryStorage()
    const saved = saveTripToStorage(applied.trip, storage)
    expect(saved.ok).toBe(true)
    const loaded = loadSavedTrips(storage)
    expect(loaded.status).toBe('ok')
    expect(loaded.trips).toHaveLength(1)
    expect(loaded.trips[0].trip.id).toBe('trip-fork-1')
    expect(loaded.trips[0].trip.warnings[0]).toContain('本地编辑说明')
    expect(savedTripRecordBytes(applied.trip)).toBeGreaterThan(0)
  })
})

describe('本地检查与旧提醒分开', () => {
  it('名称被改后给出缺坐标与待重取路线检查，但不写进 warnings', () => {
    const base = deepFreeze(cloneTrip())
    const applied = applyOk(
      edit(updateDraftStop(makeDraft(base), 1, 's1', { name: '新断桥' })),
    )
    const kinds = applied.localChecks.map((check) => check.kind)

    expect(kinds).toContain('missing_location')
    expect(kinds).toContain('unavailable_leg')
    expect(applied.trip.warnings[0]).toContain('本地编辑说明')
    expect(applied.trip.warnings.some((warning) => warning.includes('待重新获取路线'))).toBe(false)
  })

  it('同日且时钟未倒序时，按停留时长可确认的重叠会被识别', () => {
    // s1 09:00 停留 200 分钟到 12:40，s2 10:00 开始：同日、时钟未倒序、可确认重叠
    const draft = edit(
      updateDraftStop(makeDraft(deepFreeze(cloneTrip())), 1, 's1', { duration_minutes: 200 }),
    )
    const checks = localChecksForDraft(draft)

    expect(checks.some((check) => check.kind === 'time_overlap')).toBe(true)
    expect(checks.some((check) => check.kind === 'time_order')).toBe(false)
  })

  it('时钟倒序只提示倒序/可能跨日，不同时断言同日重叠', () => {
    // s1 12:00 → s2 10:00：时钟倒序，上一站停留结束 12:40 晚于 10:00，
    // 但倒序本身可能是跨日安排，不能同时给出确定的同日重叠结论
    const draft = edit(
      updateDraftStop(makeDraft(deepFreeze(cloneTrip())), 1, 's1', { time: '12:00' }),
    )
    const checks = localChecksForDraft(draft)

    expect(checks.some((check) => check.kind === 'time_order')).toBe(true)
    expect(checks.some((check) => check.kind === 'time_overlap')).toBe(false)
  })

  it('23:30→00:30 只提示可能跨日，不报确定的同日重叠', () => {
    let draft = makeDraft(deepFreeze(cloneTrip()))
    draft = edit(updateDraftStop(draft, 1, 's2', { time: '23:30', duration_minutes: 60 }))
    draft = edit(updateDraftStop(draft, 1, 's3', { time: '00:30' }))
    const checks = localChecksForDraft(draft)

    expect(checks.some((check) => check.kind === 'time_order')).toBe(true)
    expect(checks.some((check) => check.kind === 'time_overlap')).toBe(false)
  })

  it('导入旧停留是小数或超过一天时，给保守提示而不是格式出 09:1.5 或误写次日', () => {
    const fractional = cloneTrip()
    fractional.days[0].stops[2].duration_minutes = 1.5
    expect(checkTripShape(fractional).ok).toBe(true)
    const fractionalDraft = edit(
      updateDraftStop(makeDraft(fractional), 1, 's3', { description: '触发当天检查' }),
    )
    const fractionalChecks = localChecksForDraft(fractionalDraft)
    for (const check of fractionalChecks) {
      expect(check.message).not.toMatch(/\d{1,2}:\d{1,2}\.\d/)
    }
    expect(fractionalChecks.some((check) => check.message.includes('无法可靠推算'))).toBe(true)

    const multiDay = cloneTrip()
    multiDay.days[0].stops[2].duration_minutes = 3000
    expect(checkTripShape(multiDay).ok).toBe(true)
    const multiDayDraft = edit(
      updateDraftStop(makeDraft(multiDay), 1, 's3', { description: '触发当天检查' }),
    )
    const multiDayChecks = localChecksForDraft(multiDayDraft)
    for (const check of multiDayChecks) {
      expect(check.message).not.toMatch(/\d{1,2}:\d{1,2}\.\d/)
    }
    expect(multiDayChecks.some((check) => check.message.includes('无法可靠推算'))).toBe(true)
    expect(multiDayChecks.some((check) => check.message.includes('跨到次日'))).toBe(false)
  })

  it('可能跨日与无法解析的时间都有明确检查', () => {
    let draft = makeDraft(deepFreeze(cloneTrip()))
    draft = edit(
      updateDraftStop(draft, 1, 's3', { time: '23:30', duration_minutes: 120 }),
    )
    expect(localChecksForDraft(draft).some((check) => check.kind === 'possible_cross_day')).toBe(
      true,
    )

    const odd = cloneTrip()
    odd.days[0].stops[1].time = '上午十点'
    const oddDraft = edit(
      updateDraftStop(makeDraft(odd), 1, 's3', { description: '触发当天检查' }),
    )
    const unreadable = localChecksForDraft(oddDraft).find((check) => check.kind === 'time_unreadable')
    expect(unreadable).toBeDefined()
    expect(unreadable?.message).toContain('不会自动改写')
  })
})

describe('输入校验与失败保留草稿', () => {
  it('修改字段拒绝非法名称 / 地址 / 描述 / 时间 / 停留', () => {
    const draft = makeDraft(deepFreeze(cloneTrip()))
    const cases: Array<[UpdateDraftStopPatch, DraftFailureReason]> = [
      [{ name: '' }, 'invalid_name'],
      [{ name: '   ' }, 'invalid_name'],
      [{ name: 'x'.repeat(121) }, 'invalid_name'],
      [{ address: 'x'.repeat(301) }, 'invalid_address'],
      [{ description: 'x'.repeat(1001) }, 'invalid_description'],
      [{ time: '9:00' }, 'invalid_time'],
      [{ time: '24:00' }, 'invalid_time'],
      [{ time: '09:60' }, 'invalid_time'],
      [{ time: '09:00:00' }, 'invalid_time'],
      [{ time: '09:00 ' }, 'invalid_time'],
      [{ duration_minutes: -1 }, 'invalid_duration'],
      [{ duration_minutes: 1441 }, 'invalid_duration'],
      [{ duration_minutes: 1.5 }, 'invalid_duration'],
    ]

    for (const [patch, reason] of cases) {
      const result = updateDraftStop(draft, 1, 's1', patch)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe(reason)
    }
    expect(draft.revision).toBe(0)
    expect(draft.history).toEqual([])
    expect(JSON.stringify(draft.days)).toBe(JSON.stringify(MOCK_TRIP.days))
  })

  it('合法边界值可以写入并通过结构校验', () => {
    const draft = makeDraft(deepFreeze(cloneTrip()))
    const updated = edit(
      updateDraftStop(draft, 1, 's1', {
        name: 'x'.repeat(120),
        address: 'y'.repeat(300),
        description: 'z'.repeat(1000),
        time: '23:59',
        duration_minutes: 1440,
      }),
    )
    const applied = applyOk(updated)

    expect(stopOf(applied.trip.days[0], 's1').name).toHaveLength(120)
    expect(stopOf(applied.trip.days[0], 's1').address).toHaveLength(300)
    expect(stopOf(applied.trip.days[0], 's1').description).toHaveLength(1000)
    expect(stopOf(applied.trip.days[0], 's1').time).toBe('23:59')
    expect(stopOf(applied.trip.days[0], 's1').duration_minutes).toBe(1440)
    expect(checkTripShape(applied.trip).ok).toBe(true)
  })

  it('新增站点拒绝非法 id / 名称 / 时间 / 停留 / 插入位置', () => {
    const draft = makeDraft(deepFreeze(cloneTrip()))
    const cases: Array<[NewDraftStop, DraftFailureReason]> = [
      [{ id: '', name: '站点', time: '09:00' }, 'invalid_stop_id'],
      [{ id: 'x'.repeat(101), name: '站点', time: '09:00' }, 'invalid_stop_id'],
      [{ id: 'n1', name: '', time: '09:00' }, 'invalid_name'],
      [{ id: 'n1', name: 'x'.repeat(121), time: '09:00' }, 'invalid_name'],
      [{ id: 'n1', name: '站点', time: '25:00' }, 'invalid_time'],
      [{ id: 'n1', name: '站点', time: '09:00', duration_minutes: 1441 }, 'invalid_duration'],
      // 首迭代新增站点只有文字、没有可信定位来源：任何非空坐标都拒绝。
      // as unknown 模拟不受类型约束的调用方（旧代码、脚本、手写 JSON）
      [
        { id: 'n1', name: '站点', time: '09:00', location: { lng: 120.1, lat: 30.2 } } as unknown as NewDraftStop,
        'invalid_location',
      ],
      [
        { id: 'n1', name: '站点', time: '09:00', location: { lng: 181, lat: 30 } } as unknown as NewDraftStop,
        'invalid_location',
      ],
    ]

    for (const [stop, reason] of cases) {
      const result = addDraftStop(draft, 2, stop)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe(reason)
    }
    // 拒绝后原草稿不动
    expect(draft.revision).toBe(0)
    expect(dayOf(draft, 2).stops).toEqual([])
    expect(addDraftStop(draft, 2, { id: 'n1', name: '站点', time: '09:00' }, { index: 1 })).toMatchObject(
      { ok: false, reason: 'invalid_index' },
    )
    expect(addDraftStop(draft, 99, { id: 'n1', name: '站点', time: '09:00' })).toMatchObject({
      ok: false,
      reason: 'unknown_day',
    })
    expect(updateDraftStop(draft, 1, 'nope', { time: '09:00' })).toMatchObject({
      ok: false,
      reason: 'unknown_stop',
    })
  })

  it('新增站点类型层不接受坐标：null/缺省都得到无坐标站点', () => {
    const draft = makeDraft(deepFreeze(cloneTrip()))
    const withNull = edit(addDraftStop(draft, 2, { id: 'n1', name: '站点A', time: '09:00', location: null }))
    expect(stopOf(dayOf(withNull, 2), 'n1').location).toBeNull()

    const omitted = edit(addDraftStop(draft, 2, { id: 'n2', name: '站点B', time: '09:00' }))
    expect(stopOf(dayOf(omitted, 2), 'n2').location).toBeNull()

    // 类型收紧：NewDraftStop 的 location 只允许 null / 缺省。下面这行若去掉
    // as unknown，编译期就报错（对象坐标不可赋给 null | undefined）。
    // @ts-expect-error 首迭代新增站点没有可信定位来源，NewDraftStop 不接受非空坐标
    const withCoords = {
      id: 'n3',
      name: '站点C',
      time: '09:00',
      location: { lng: 120.1, lat: 30.2 },
    } as NewDraftStop
    expect(withCoords.location).toBeDefined()
    expect(addDraftStop(draft, 2, withCoords)).toMatchObject({ ok: false, reason: 'invalid_location' })
  })
})

describe('dailyStopLimitNotices：用户自设的每天站点上限', () => {
  it('默认关闭由调用方控制：函数只在上限合法时产出提醒，非法上限返回空数组', () => {
    const draft = makeDraft(cloneTrip())
    expect(dailyStopLimitNotices(draft, 0, 'all_days')).toEqual([])
    expect(dailyStopLimitNotices(draft, 9, 'all_days')).toEqual([])
    expect(dailyStopLimitNotices(draft, 1.5, 'all_days')).toEqual([])
    // 第 1 天 3 站、第 3 天 1 站，上限 2 时只有第 1 天超。
    const notices = dailyStopLimitNotices(draft, 2, 'all_days')
    expect(notices).toHaveLength(1)
    expect(notices[0].day).toBe(1)
    expect(notices[0].stopCount).toBe(3)
    expect(notices[0].message).toContain('超过你设置的每天最多 2 站上限')
    expect(notices[0].message).toContain('没有自动删除')
  })

  it('8→9 站产生提醒，删回 8 站后提醒消失；旧大天数照常可读', () => {
    const base = cloneTrip()
    base.days[0].stops = Array.from({ length: 8 }, (_, index) => ({
      id: `d1s${index + 1}`,
      name: `站 ${index + 1}`,
      time: `0${index}:00`.slice(-5),
      duration_minutes: null,
      description: '',
      address: '',
      location: null,
    }))
    let draft = makeDraft(base)
    // 没改过任何天时上限检查也能覆盖旧数据（这是纯展示函数，不依赖 changedDays）。
    expect(dailyStopLimitNotices(draft, 8, 'all_days')).toEqual([])

    draft = edit(
      addDraftStop(draft, 1, { id: 'd1s9', name: '第 9 站', time: '17:00' }),
    )
    const over = dailyStopLimitNotices(draft, 8, 'all_days')
    expect(over).toHaveLength(1)
    expect(over[0].stopCount).toBe(9)

    draft = edit(removeDraftStop(draft, 1, 'd1s9'))
    expect(dailyStopLimitNotices(draft, 8, 'all_days')).toEqual([])

    // 旧导入数据 10 站也不阻止读取：提醒归提醒，站点数据还在。
    const bigBase = cloneTrip()
    bigBase.days[0].stops = Array.from({ length: 10 }, (_, index) => ({
      id: `big${index + 1}`,
      name: `旧站 ${index + 1}`,
      time: '09:00',
      duration_minutes: null,
      description: '',
      address: '',
      location: null,
    }))
    const bigDraft = makeDraft(bigBase)
    const bigNotices = dailyStopLimitNotices(bigDraft, 8, 'all_days')
    expect(bigNotices).toHaveLength(1)
    expect(dayOf(bigDraft, 1).stops).toHaveLength(10)
  })

  it('范围 changed_days 只检查改动过的天；提示不进入 applyDraft 结果', () => {
    const base = cloneTrip()
    // 第 1 天 3 站（不改）、第 2 天空（改成 0 站不超限）、第 3 天 1 站不动。
    const draft = makeDraft(base)
    const allScope = dailyStopLimitNotices(draft, 2, 'changed_days')
    expect(allScope).toEqual([])

    const edited = edit(updateDraftStop(draft, 3, 's4', { description: '改一下描述' }))
    // 第 3 天只有 1 站，不超限；第 1 天虽超限但没改动，changed_days 下不提醒。
    expect(dailyStopLimitNotices(edited, 2, 'changed_days')).toEqual([])
    expect(dailyStopLimitNotices(edited, 2, 'all_days')).toHaveLength(1)

    const withAdd = edit(addDraftStop(edited, 2, { id: 'd2s1', name: '运河站', time: '09:00' }))
    // 上限 1：第 2 天现在 1 站不超；给第 2 天再加一站才超。
    const withAdd2 = edit(addDraftStop(withAdd, 2, { id: 'd2s2', name: '小河直街', time: '10:00' }))
    expect(dailyStopLimitNotices(withAdd2, 1, 'changed_days').map((item) => item.day)).toEqual([2])

    // 上限检查不影响 applyDraft：结果里没有这个偏好的痕迹。
    const applied = applyOk(withAdd)
    expect(applied.localChecks.every((check) => check.kind !== undefined)).toBe(true)
    expect(JSON.stringify(applied.trip)).not.toContain('超过你设置的每天最多')
  })
})

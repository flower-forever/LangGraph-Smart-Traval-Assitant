/**
 * webSourcesOwner 归属快照纯函数测试：完整内容快照、序列化 fail closed、key 等价类。
 * 不触 UI、不发请求。对象 identity（新引用同内容也算新归属）由组件层叠加判定，
 * 这里只测内容序列化部分。
 */
import { describe, expect, it } from 'vitest'

import type { Trip } from '../lib/api'
import { MOCK_TRIP } from './fixtures/trip'
import { serializeOwnerSnapshot, type OwnerSnapshotInput } from '../lib/webSourcesOwner'

function deepTrip(): Trip {
  return JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
}

function snap(
  input: Partial<OwnerSnapshotInput> = {},
): { ok: true; key: string } | { ok: false } {
  const trip = input.trip ?? deepTrip()
  const result = serializeOwnerSnapshot({
    trip,
    day: input.day !== undefined ? input.day : trip.days[0],
    revision: input.revision ?? 1,
    rawQuery: input.rawQuery ?? '',
    selectedStopId: input.selectedStopId ?? null,
    openedFromFile: input.openedFromFile ?? null,
  })
  return result.ok ? { ok: true, key: result.key } : { ok: false }
}

describe('serializeOwnerSnapshot', () => {
  it('完整快照含 trip 内容、day、selectedStop、rawQuery 与来源三态', () => {
    const trip = deepTrip()
    const result = snap({
      trip,
      rawQuery: ' 西湖 ',
      selectedStopId: 's2',
      revision: 3,
      openedFromFile: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.key).toContain(trip.id)
    expect(result.key).toContain('西湖')
    expect(result.key).toContain('"s2"')
    expect(result.key).toContain('[3,true,"s2"')
    expect(result.key).toContain('true')
  })

  it('day=null：day 段为 null，且当天内容不再直接进 key（trip 全量仍在）', () => {
    const trip = deepTrip()
    const a = snap({ trip, day: null, rawQuery: 'x' })
    trip.days[0].title = '改了也不影响'
    const b = snap({ trip, day: null, rawQuery: 'x' })
    // trip 全量序列化仍随内容变化（面板 day=null 时禁查询，key 变化只是保守失效）
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.key).not.toBe(b.key)
    expect(a.key.endsWith('null')).toBe(true)
  })

  it('day=null 时 revision/rawQuery 变化仍影响 key', () => {
    const a = snap({ day: null, rawQuery: 'x', revision: 1 })
    const b = snap({ day: null, rawQuery: 'x', revision: 2 })
    const c = snap({ day: null, rawQuery: 'y', revision: 1 })
    expect(a.ok && b.ok && c.ok).toBe(true)
    if (!a.ok || !b.ok || !c.ok) return
    expect(a.key).not.toBe(b.key)
    expect(a.key).not.toBe(c.key)
  })

  it('循环引用：fail closed 返回 not_serializable', () => {
    const trip = deepTrip()
    ;(trip as { loop?: unknown }).loop = trip
    const result = snap({ trip, rawQuery: 'x' })
    expect(result.ok).toBe(false)
  })

  it('toJSON 抛错同样 fail closed', () => {
    const trip = deepTrip()
    ;(trip as { hostile?: unknown }).hostile = {
      toJSON() {
        throw new Error('boom')
      },
    }
    const result = snap({ trip, rawQuery: 'x' })
    expect(result.ok).toBe(false)
  })

  it('同引用原地修改任意字段：key 变化（概要/未选中日/站点名/leg 距离）', () => {
    const trip = deepTrip()
    const before = snap({ trip, rawQuery: 'x' })
    trip.summary = '改'
    trip.days[1].title = '改'
    trip.days[0].stops[0].name = '改'
    trip.days[0].legs[0].distance_m = 999
    const after = snap({ trip, rawQuery: 'x' })
    expect(before.ok && after.ok && before.key !== after.key).toBe(true)
  })

  it('新引用同 id/revision 同内容：key 相同（identity 由组件层叠加）', () => {
    const trip = deepTrip()
    const clone = deepTrip()
    const a = snap({ trip, rawQuery: 'x' })
    const b = snap({ trip: clone, rawQuery: 'x' })
    expect(a.ok && b.ok && a.key === b.key).toBe(true)
  })

  it('rawQuery 空白变化：key 变化（不用 trim 口径）', () => {
    const trip = deepTrip()
    const a = snap({ trip, rawQuery: 'x' })
    const b = snap({ trip, rawQuery: 'x ' })
    expect(a.ok && b.ok && a.key !== b.key).toBe(true)
  })
})

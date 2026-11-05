import { describe, expect, it } from 'vitest'

import type { Trip } from '../lib/api'
import {
  anchorsToForm,
  applyAnchorsProposal,
  anchorsProposalMatches,
  buildAnchorsFromForm,
  createAnchorsProposal,
  emptyAccommodationForm,
  emptyAnchorsForm,
  emptyDayAnchorForm,
  evaluateAnchorsHardGate,
  type CreateAnchorsProposalInput,
} from '../lib/anchors'
import type { AnchorsV1, DayAnchorV1, WorkspaceRecordV1 } from '../lib/workspaceTypes'
import { createWorkspaceRecord } from '../lib/workspace'
import { checkTripShape } from '../lib/savedTrips'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_760_000_000_000

function makeRecord(trip: Trip = MOCK_TRIP, revision = 3): WorkspaceRecordV1 {
  const result = createWorkspaceRecord({
    workspaceId: 'ws-1',
    ownerId: 'owner-1',
    trip,
    workspaceRevision: revision,
    now: NOW,
  })
  if (!result.ok) throw new Error(`record fixture failed: ${result.message}`)
  return result.value
}

function hotelAnchors(overrides: Partial<NonNullable<AnchorsV1['accommodation']>> = {}): AnchorsV1 {
  return {
    accommodation: {
      hotelId: 'h1',
      name: '中央酒店',
      address: '中央路 1 号',
      location: null,
      locationSource: null,
      checkInDate: '2026-04-03',
      checkOutDate: '2026-04-05',
      ...overrides,
    },
    daily: {},
    arrival: null,
    departure: null,
  }
}

function dayAnchor(overrides: Partial<DayAnchorV1> = {}): DayAnchorV1 {
  return {
    anchorId: 'a1',
    kind: 'manual',
    stopId: null,
    hotelId: 'h1',
    name: '中央酒店',
    address: null,
    location: null,
    time: null,
    date: null,
    ...overrides,
  }
}

function proposalFor(
  anchors: AnchorsV1,
  options: {
    record?: WorkspaceRecordV1
    epoch?: number
    createStopId?: () => string
    newLegMode?: 'walking' | 'driving'
  } = {},
) {
  const input: CreateAnchorsProposalInput = {
    record: options.record ?? makeRecord(),
    epoch: options.epoch ?? 7,
    anchors,
    newLegMode: options.newLegMode ?? 'walking',
    createStopId: options.createStopId ?? (() => 'occ-1'),
  }
  const result = createAnchorsProposal(input)
  if (!result.ok) throw new Error(`proposal failed: ${result.reason}: ${result.message}`)
  return { record: input.record, proposal: result.value }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('buildAnchorsFromForm：手工输入与 null/0 语义', () => {
  it('只填名称和日期时坐标是 null，locationSource 也是 null', () => {
    const form = emptyAnchorsForm()
    form.accommodation = {
      ...emptyAccommodationForm(),
      hotelId: 'h1',
      name: '中央酒店',
      checkInDate: '2026-04-03',
      checkOutDate: '2026-04-05',
    }
    const built = buildAnchorsFromForm(form, (kind) => `${kind}-1`)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.value.accommodation).toMatchObject({
      hotelId: 'h1',
      name: '中央酒店',
      location: null,
      locationSource: null,
      checkInDate: '2026-04-03',
      checkOutDate: '2026-04-05',
    })
  })

  it('用户填写 0,0 是有效坐标，不当作未知', () => {
    const form = emptyAnchorsForm()
    form.accommodation = {
      ...emptyAccommodationForm(),
      hotelId: 'h1',
      name: '零点酒店',
      lng: '0',
      lat: '0',
    }
    const built = buildAnchorsFromForm(form, (kind) => `${kind}-1`)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.value.accommodation?.location).toEqual({ lng: 0, lat: 0 })
    expect(built.value.accommodation?.locationSource).toBe('user_provided')
  })

  it('只填一端坐标时明确失败，不把另一端补 0', () => {
    const form = emptyAnchorsForm()
    form.accommodation = { ...emptyAccommodationForm(), name: '酒店', lng: '120' }
    const built = buildAnchorsFromForm(form, (kind) => `${kind}-1`)
    expect(built).toMatchObject({ ok: false, reason: 'invalid_coordinate' })
  })

  it('坏日期 / 坏时间 / 空名称都返回 typed failure', () => {
    const badDate = emptyAnchorsForm()
    badDate.accommodation = { ...emptyAccommodationForm(), name: '酒店', checkInDate: '2026-02-30' }
    expect(buildAnchorsFromForm(badDate, (kind) => `${kind}-1`)).toMatchObject({
      ok: false,
      reason: 'invalid_date',
    })

    const badTime = emptyAnchorsForm()
    badTime.daily['1'] = {
      start: { ...emptyDayAnchorForm(), anchorId: 'a1', name: '起点', time: '24:00' },
      end: null,
    }
    expect(buildAnchorsFromForm(badTime, (kind) => `${kind}-1`)).toMatchObject({
      ok: false,
      reason: 'invalid_time',
    })

    const emptyName = emptyAnchorsForm()
    emptyName.daily['1'] = {
      start: { ...emptyDayAnchorForm(), anchorId: 'a1', kind: 'stop', stopId: 's1' },
      end: null,
    }
    expect(buildAnchorsFromForm(emptyName, (kind) => `${kind}-1`)).toMatchObject({
      ok: false,
      reason: 'missing_name',
    })
  })

  it('表单往返保留已有 anchor / hotel id 与 null 坐标', () => {
    const anchors = hotelAnchors()
    anchors.daily['1'] = {
      start: dayAnchor({ anchorId: 'a-start', kind: 'stop', stopId: 's1', hotelId: null, name: '断桥残雪' }),
      end: null,
    }
    const form = anchorsToForm(anchors)
    const rebuilt = buildAnchorsFromForm(form, (kind) => `${kind}-new`)
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(rebuilt.value).toEqual(anchors)
  })
})

describe('createAnchorsProposal：酒店 occurrence / link / 冻结前缀', () => {
  it('同一酒店同日首末生成两个独立 stop id，hotelId 共享，原 Trip 不变', () => {
    const record = makeRecord()
    const beforeTrip = clone(record.trip)
    const anchors = hotelAnchors()
    anchors.daily['1'] = {
      start: dayAnchor({ anchorId: 'a-start' }),
      end: dayAnchor({ anchorId: 'a-end', name: '中央酒店（晚）' }),
    }
    let sequence = 0
    const { proposal } = proposalFor(anchors, {
      record,
      createStopId: () => `occ-${++sequence}`,
    })

    expect(proposal.occurrences).toHaveLength(2)
    const [start, end] = proposal.occurrences
    expect(start.stop.id).toBe('occ-1')
    expect(end.stop.id).toBe('occ-2')
    expect(start.stop.id).not.toBe(end.stop.id)
    expect(start.hotelId).toBe('h1')
    expect(end.hotelId).toBe('h1')
    expect(proposal.nextAnchors.daily['1'].start).toMatchObject({
      kind: 'stop',
      stopId: 'occ-1',
      hotelId: 'h1',
    })
    expect(proposal.nextAnchors.daily['1'].end).toMatchObject({
      kind: 'stop',
      stopId: 'occ-2',
      hotelId: 'h1',
    })

    const day1 = proposal.trip.days.find((day) => day.day === 1)
    if (!day1) throw new Error('missing day 1')
    expect(day1.stops.map((stop) => stop.id)).toEqual(['occ-1', 's1', 's2', 's3', 'occ-2'])
    expect(day1.stops.slice(1, -1)).toEqual(beforeTrip.days[0].stops)
    expect(day1.legs[1]).toEqual(beforeTrip.days[0].legs[0])
    expect(day1.legs[2]).toEqual(beforeTrip.days[0].legs[1])
    expect(day1.legs[0]).toMatchObject({ route_type: 'unavailable', duration_minutes: null })
    expect(day1.legs[3]).toMatchObject({ route_type: 'unavailable', duration_minutes: null })
    expect(checkTripShape(proposal.trip).ok).toBe(true)
    expect(proposal.trip.days[1]).toBe(record.trip.days[1])
    expect(proposal.trip.days[2]).toBe(record.trip.days[2])
    expect(record.trip).toEqual(beforeTrip)
  })

  it('同一酒店跨天不复用会碰撞的 stop id', () => {
    const anchors = hotelAnchors()
    anchors.daily['1'] = { start: dayAnchor({ anchorId: 'a-day1' }), end: null }
    anchors.daily['2'] = {
      start: dayAnchor({ anchorId: 'a-day2', name: '中央酒店（次日）' }),
      end: null,
    }
    let sequence = 0
    const { proposal } = proposalFor(anchors, { createStopId: () => `occ-${++sequence}` })
    expect(proposal.occurrences).toHaveLength(2)
    expect(proposal.occurrences[0].stop.id).not.toBe(proposal.occurrences[1].stop.id)
    expect(proposal.nextAnchors.daily['1'].start?.stopId).toBe('occ-1')
    expect(proposal.nextAnchors.daily['2'].start?.stopId).toBe('occ-2')
    expect(proposal.trip.days[1].stops.map((stop) => stop.id)).toEqual(['occ-2'])
  })

  it('引用已有 stop 只 link，不复制、不改 id，Trip 引用不变', () => {
    const record = makeRecord()
    const before = clone(record)
    const anchors: AnchorsV1 = {
      accommodation: null,
      daily: {
        '1': {
          start: dayAnchor({
            anchorId: 'a-link',
            kind: 'stop',
            stopId: 's2',
            hotelId: null,
            name: '平湖秋月',
          }),
          end: null,
        },
      },
      arrival: null,
      departure: null,
    }
    const { proposal } = proposalFor(anchors, { record })
    expect(proposal.occurrences).toHaveLength(0)
    expect(proposal.trip).toBe(record.trip)
    expect(proposal.trip.days[0].stops.map((stop) => stop.id)).toEqual(['s1', 's2', 's3'])
    expect(proposal.placements[0]).toMatchObject({
      status: 'linked_existing',
      stopId: 's2',
    })
    expect(record).toEqual(before)
  })

  it('手工非酒店 anchor 只作参考，不生成 stop', () => {
    const anchors: AnchorsV1 = {
      accommodation: null,
      daily: {
        '1': {
          start: dayAnchor({
            anchorId: 'a-ref',
            kind: 'manual',
            hotelId: null,
            name: '朋友家',
            address: '某路 2 号',
          }),
          end: null,
        },
      },
      arrival: null,
      departure: null,
    }
    const { proposal } = proposalFor(anchors)
    expect(proposal.occurrences).toHaveLength(0)
    expect(proposal.placements[0]).toMatchObject({ status: 'reference_only', stopId: null })
    expect(proposal.nextAnchors.daily['1'].start).toMatchObject({ kind: 'manual', stopId: null })
  })

  it('坐标 0,0 原样进入 occurrence，不变成 null', () => {
    const anchors = hotelAnchors({ location: { lng: 0, lat: 0 }, locationSource: 'user_provided' })
    anchors.daily['1'] = {
      start: dayAnchor({ anchorId: 'a-zero', location: { lng: 0, lat: 0 } }),
      end: null,
    }
    const { proposal } = proposalFor(anchors)
    expect(proposal.occurrences[0].stop.location).toEqual({ lng: 0, lat: 0 })
  })

  it('坏日期 / 不存在 day / 不存在 stop / 停留范围都 typed 拒绝', () => {
    const badRange = hotelAnchors({ checkInDate: '2026-04-05', checkOutDate: '2026-04-03' })
    const range = createAnchorsProposal({
      record: makeRecord(),
      epoch: 1,
      anchors: badRange,
      newLegMode: 'walking',
      createStopId: () => 'occ-1',
    })
    expect(range).toMatchObject({ ok: false, reason: 'invalid_stay_range' })

    const unknownDay = hotelAnchors()
    unknownDay.daily['9'] = { start: dayAnchor({ anchorId: 'a9' }), end: null }
    expect(
      createAnchorsProposal({
        record: makeRecord(),
        epoch: 1,
        anchors: unknownDay,
        newLegMode: 'walking',
        createStopId: () => 'occ-1',
      }),
    ).toMatchObject({ ok: false, reason: 'unknown_day' })

    const unknownStop = hotelAnchors({ hotelId: null, name: null, checkInDate: null, checkOutDate: null })
    unknownStop.daily['1'] = {
      start: dayAnchor({
        anchorId: 'a-stop',
        kind: 'stop',
        stopId: 's4',
        hotelId: null,
        name: '龙井村',
      }),
      end: null,
    }
    expect(
      createAnchorsProposal({
        record: makeRecord(),
        epoch: 1,
        anchors: unknownStop,
        newLegMode: 'walking',
        createStopId: () => 'occ-1',
      }),
    ).toMatchObject({ ok: false, reason: 'unknown_stop' })

    const outsideStay = hotelAnchors({ checkInDate: '2026-04-05', checkOutDate: '2026-04-06' })
    outsideStay.daily['2'] = {
      start: dayAnchor({ anchorId: 'a-out', date: '2026-04-04' }),
      end: null,
    }
    expect(
      createAnchorsProposal({
        record: makeRecord(),
        epoch: 1,
        anchors: outsideStay,
        newLegMode: 'walking',
        createStopId: () => 'occ-1',
      }),
    ).toMatchObject({ ok: false, reason: 'anchor_outside_stay' })

    const dateMismatch = hotelAnchors()
    dateMismatch.daily['1'] = {
      start: dayAnchor({ anchorId: 'a-date', date: '2026-04-04' }),
      end: null,
    }
    expect(
      createAnchorsProposal({
        record: makeRecord(),
        epoch: 1,
        anchors: dateMismatch,
        newLegMode: 'walking',
        createStopId: () => 'occ-1',
      }),
    ).toMatchObject({ ok: false, reason: 'anchor_date_mismatch' })
  })

  it('单日站点已到 100 时拒绝新增 occurrence', () => {
    const fullStops = Array.from({ length: 100 }, (_, index) => ({
      id: `x${index}`,
      name: `站 ${index}`,
      time: '09:00',
      duration_minutes: null,
      description: '',
      address: '',
      location: null,
    }))
    const trip: Trip = {
      ...MOCK_TRIP,
      days: MOCK_TRIP.days.map((day) => (day.day === 1 ? { ...day, stops: fullStops, legs: [] } : day)),
    }
    expect(checkTripShape(trip).ok).toBe(true)
    const anchors = hotelAnchors()
    anchors.daily['1'] = { start: dayAnchor({ anchorId: 'a-limit' }), end: null }
    const result = createAnchorsProposal({
      record: makeRecord(trip),
      epoch: 1,
      anchors,
      newLegMode: 'walking',
      createStopId: () => 'occ-limit',
    })
    expect(result).toMatchObject({ ok: false, reason: 'stop_limit' })
  })

  it('失败时输入 record / anchors 原样不变', () => {
    const record = makeRecord()
    const beforeRecord = clone(record)
    const anchors = hotelAnchors()
    anchors.daily['9'] = { start: dayAnchor({ anchorId: 'a-missing-day' }), end: null }
    const beforeAnchors = clone(anchors)
    const result = createAnchorsProposal({
      record,
      epoch: 1,
      anchors,
      newLegMode: 'walking',
      createStopId: () => 'occ-never',
    })
    expect(result).toMatchObject({ ok: false, reason: 'unknown_day' })
    expect(record).toEqual(beforeRecord)
    expect(anchors).toEqual(beforeAnchors)
  })

  it('stop id 工厂持续碰撞时拒绝，不覆盖既有 id', () => {
    const anchors = hotelAnchors()
    anchors.daily['1'] = { start: dayAnchor({ anchorId: 'a-dup' }), end: null }
    const result = createAnchorsProposal({
      record: makeRecord(),
      epoch: 1,
      anchors,
      newLegMode: 'walking',
      createStopId: () => 's1',
    })
    expect(result).toMatchObject({ ok: false, reason: 'duplicate_id' })
  })
})

describe('applyAnchorsProposal：显式 transition 与失败保旧', () => {
  it('成功应用走 revision +1，旧记录对象不变；旧 proposal 第二次失效', () => {
    const anchors = hotelAnchors()
    anchors.daily['1'] = { start: dayAnchor({ anchorId: 'a-apply' }), end: null }
    const { record, proposal } = proposalFor(anchors)
    const before = clone(record)
    expect(anchorsProposalMatches(proposal, record)).toBe(true)

    const applied = applyAnchorsProposal(record, proposal, NOW + 1)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.value.workspaceRevision).toBe(record.workspaceRevision + 1)
    expect(applied.value.trip).toEqual(proposal.trip)
    expect(applied.value.sidecar.anchors).toEqual(proposal.nextAnchors)
    expect(record).toEqual(before)
    expect(anchorsProposalMatches(proposal, applied.value)).toBe(false)

    const appliedBefore = clone(applied.value)
    const stale = applyAnchorsProposal(applied.value, proposal, NOW + 2)
    expect(stale).toMatchObject({ ok: false, reason: 'owner_mismatch' })
    expect(applied.value).toEqual(appliedBefore)
  })

  it('已应用后再次预览不会重复生成同一酒店的 occurrence', () => {
    const anchors = hotelAnchors()
    anchors.daily['1'] = { start: dayAnchor({ anchorId: 'a-reapply' }), end: null }
    const { record, proposal } = proposalFor(anchors)
    const applied = applyAnchorsProposal(record, proposal, NOW + 1)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return

    const again = createAnchorsProposal({
      record: applied.value,
      epoch: 8,
      anchors: applied.value.sidecar.anchors,
      newLegMode: 'walking',
      createStopId: () => {
        throw new Error('已链接的酒店停靠不应再生成新 id')
      },
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.occurrences).toHaveLength(0)
    expect(again.value.trip).toBe(applied.value.trip)
  })

  it('没有 occurrence 的 anchors-only 提案不要求既有 legs 完整重建', () => {
    const anchors: AnchorsV1 = {
      accommodation: null,
      daily: {
        '3': {
          start: dayAnchor({
            anchorId: 'a-day3',
            kind: 'manual',
            hotelId: null,
            name: '龙井村口',
          }),
          end: null,
        },
      },
      arrival: null,
      departure: null,
    }
    const { record, proposal } = proposalFor(anchors)
    expect(proposal.trip).toBe(record.trip)
    const applied = applyAnchorsProposal(record, proposal, NOW + 1)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.value.sidecar.anchors).toEqual(anchors)
    expect(applied.value.trip).toBe(record.trip)
  })

  it('被篡改的 title / 隐藏新增站点都会被冻结校验拒绝', () => {
    const anchors = hotelAnchors()
    anchors.daily['1'] = { start: dayAnchor({ anchorId: 'a-tamper' }), end: null }
    const { record, proposal } = proposalFor(anchors)
    const before = clone(record)

    const titleTamper = { ...proposal, trip: { ...proposal.trip, title: '偷偷改标题' } }
    expect(applyAnchorsProposal(record, titleTamper, NOW + 1)).toMatchObject({
      ok: false,
      reason: 'invalid_field',
    })

    const hiddenStop = {
      ...proposal,
      trip: {
        ...proposal.trip,
        days: proposal.trip.days.map((day) =>
          day.day === 1
            ? {
                ...day,
                stops: [
                  ...day.stops,
                  {
                    id: 'hidden',
                    name: '隐藏站',
                    time: '08:00',
                    duration_minutes: null,
                    description: '',
                    address: '',
                    location: null,
                  },
                ],
              }
            : day,
        ),
      },
    }
    expect(applyAnchorsProposal(record, hiddenStop, NOW + 1)).toMatchObject({
      ok: false,
      reason: 'invalid_field',
    })
    expect(record).toEqual(before)
  })
})

describe('evaluateAnchorsHardGate：F2 明确接口', () => {
  it('起锚点晚于首站、终锚点早于末站结束是 blockers；锚点永远不是 Trip 站点', () => {
    const trip: Trip = {
      ...MOCK_TRIP,
      days: MOCK_TRIP.days.map((day) =>
        day.day === 1
          ? {
              ...day,
              stops: day.stops.map((stop) => (stop.id === 's3' ? { ...stop, duration_minutes: 45 } : stop)),
            }
          : day,
      ),
    }
    const anchors = hotelAnchors({ hotelId: null, name: null, checkInDate: null, checkOutDate: null })
    anchors.daily['1'] = {
      start: dayAnchor({ anchorId: 'a-start', hotelId: null, name: '起点', time: '10:00' }),
      end: dayAnchor({ anchorId: 'a-end', hotelId: null, name: '终点', time: '12:00' }),
    }
    const report = evaluateAnchorsHardGate(trip, anchors)
    expect(report.anchorsAreTripStops).toBe(false)
    expect(report.blockers.map((item) => item.code)).toContain('start_after_first_stop')
    expect(report.blockers.map((item) => item.code)).toContain('end_after_anchor')
  })

  it('末站停留未知 / 路段耗时未知是 unverified，不补 0', () => {
    const trip: Trip = {
      ...MOCK_TRIP,
      days: MOCK_TRIP.days.map((day) =>
        day.day === 1
          ? {
              ...day,
              legs: day.legs.map((leg, index) =>
                index === 0 ? { ...leg, duration_minutes: null, route_type: 'unavailable', geometry: [] } : leg,
              ),
            }
          : day,
      ),
    }
    const anchors = hotelAnchors({ hotelId: null, name: null, checkInDate: null, checkOutDate: null })
    anchors.daily['1'] = {
      start: null,
      end: dayAnchor({ anchorId: 'a-end', hotelId: null, name: '终点', time: '23:00' }),
    }
    const report = evaluateAnchorsHardGate(trip, anchors)
    expect(report.unverified.map((item) => item.code)).toContain('end_stop_duration_unknown')
    expect(report.unverified.map((item) => item.code)).toContain('leg_duration_unknown')
    expect(report.blockers).toHaveLength(0)
  })

  it('引用已被删除的 stop 是 blocker；非法住宿范围也是 blocker', () => {
    const anchors = hotelAnchors({ checkInDate: '2026-04-05', checkOutDate: '2026-04-03' })
    anchors.daily['1'] = {
      start: dayAnchor({ anchorId: 'a-missing', kind: 'stop', stopId: 'gone', hotelId: null, name: '消失站' }),
      end: null,
    }
    const report = evaluateAnchorsHardGate(MOCK_TRIP, anchors)
    expect(report.blockers.map((item) => item.code)).toContain('stop_missing')
    expect(report.blockers.map((item) => item.code)).toContain('invalid_stay_range')
  })
})

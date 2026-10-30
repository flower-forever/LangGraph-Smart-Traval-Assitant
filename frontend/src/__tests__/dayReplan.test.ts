import { describe, expect, it } from 'vitest'

import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
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
  AI_REPLAN_WARNING_PREFIX,
  DAY_REPLAN_APPLY_NOTICE,
  MAX_REPLAN_STOPS_PER_DAY,
  MAX_REPLAN_WARNING_LENGTH,
  MAX_REPLAN_WARNINGS,
  PRE_ADJUSTMENT_WARNING_PREFIX,
  WARNING_OMISSION_PREFIX,
  applyDayReplan,
  buildDayReplanRequest,
  classifyDayMapStatus,
  validateDayReplanResponse,
  type BuildDayReplanOptions,
  type DayReplanApplySuccess,
  type DayReplanRequest,
  type DayReplanResponse,
  type MapStatus,
} from '../lib/dayReplan'

// ==================== 本地夹具（不改共用 fixtures） ====================

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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

function locatedStop(
  id: string,
  name: string,
  time: string,
  lng: number,
  lat: number,
  extra: Partial<TripStop> = {},
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes: 60,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location: { lng, lat },
    ...extra,
  }
}

function unlocatedStop(id: string, name: string, time: string, extra: Partial<TripStop> = {}): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes: null,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location: null,
    ...extra,
  }
}

function navigationLeg(from: string, to: string, fromCoord: { lng: number; lat: number }, toCoord: { lng: number; lat: number }): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 900,
    duration_minutes: 12,
    geometry: [
      { ...fromCoord },
      { lng: (fromCoord.lng + toCoord.lng) / 2, lat: (fromCoord.lat + toCoord.lat) / 2 },
      { ...toCoord },
    ],
    description: '导航路线。',
  }
}

function unavailableLeg(from: string, to: string): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'unavailable',
    distance_m: null,
    duration_minutes: null,
    geometry: [],
    description: '尚未获取地图路线数据。',
  }
}

const REVISION = 7
const BASE_ID = 'trip-local-replan-1'

function makeBase(): Trip {
  const day1Stop = locatedStop('s1', '拙政园', '09:00', 120.62, 31.32)
  const day2StopA = locatedStop('s2', '虎丘', '10:00', 120.57, 31.33)
  const day2StopB = locatedStop('s3', '寒山寺', '13:00', 120.56, 31.31)
  return {
    id: BASE_ID,
    source: 'example',
    destination: '苏州',
    title: '苏州三日测试行程',
    summary: '原始摘要：示例数据。',
    map_coordinate_system: 'WGS84',
    warnings: ['调整前提醒 A', '调整前提醒 B'],
    days: [
      {
        day: 1,
        date: '2026-05-01',
        title: '第一天',
        summary: '第一天摘要。',
        stops: [day1Stop],
        legs: [],
      },
      {
        day: 2,
        date: '2026-05-02',
        title: '第二天',
        summary: '第二天摘要。',
        stops: [day2StopA, day2StopB],
        legs: [
          navigationLeg(
            's2',
            's3',
            day2StopA.location as { lng: number; lat: number },
            day2StopB.location as { lng: number; lat: number },
          ),
        ],
      },
      {
        day: 3,
        date: null,
        title: '第三天',
        summary: '第三天摘要。',
        stops: [locatedStop('s4', '网师园', '09:30', 120.63, 31.3)],
        legs: [],
      },
    ],
  }
}

function buildRequest(
  base: Trip,
  day = 2,
  instruction = '把第二天安排得轻松一点，保留虎丘。',
  options: Partial<BuildDayReplanOptions> = {},
): DayReplanRequest {
  const result = buildDayReplanRequest(base, day, instruction, {
    travel_mode: 'walking',
    parentRevision: REVISION,
    ...options,
  })
  if (!result.ok) throw new Error(result.message)
  return result.request
}

function candidateFor(
  dayNumber: number,
  date: string | null,
  status: MapStatus,
  warnings: string[] = [
    '本次返回提醒：09:30 是占位时间，不是模型给出的真实时刻。',
    '地图数据超时：已保留文字行程，坐标与路线未获取。',
  ],
): DayReplanResponse {
  const idA = `replan-${dayNumber}-aa-1`
  const idB = `replan-${dayNumber}-aa-2`
  let day: TripDay
  if (status === 'ready') {
    const coordA = { lng: 120.61, lat: 31.32 }
    const coordB = { lng: 120.59, lat: 31.31 }
    day = {
      day: dayNumber,
      date,
      title: 'AI 调整后的第二天',
      summary: 'AI 候选摘要。',
      stops: [locatedStop(idA, '山塘街', '09:30', coordA.lng, coordA.lat), locatedStop(idB, '留园', '11:00', coordB.lng, coordB.lat)],
      legs: [navigationLeg(idA, idB, coordA, coordB)],
    }
  } else if (status === 'partial') {
    day = {
      day: dayNumber,
      date,
      title: 'AI 调整后的第二天',
      summary: 'AI 候选摘要。',
      stops: [locatedStop(idA, '山塘街', '09:30', 120.61, 31.32), unlocatedStop(idB, '留园', '11:00')],
      legs: [unavailableLeg(idA, idB)],
    }
  } else {
    day = {
      day: dayNumber,
      date,
      title: 'AI 调整后的第二天',
      summary: 'AI 候选摘要。',
      stops: [unlocatedStop(idA, '山塘街', '09:30'), unlocatedStop(idB, '留园', '11:00')],
      legs: [unavailableLeg(idA, idB)],
    }
  }
  return {
    day,
    warnings: [...warnings],
    map_status: status,
    parent: { trip_id: 'placeholder', revision: 0 },
    source: 'agent',
  }
}

function withParent(response: DayReplanResponse, request: DayReplanRequest): DayReplanResponse {
  return {
    ...response,
    parent: { trip_id: request.parent.trip_id, revision: request.parent.revision },
  }
}

function applyOrThrow(
  baseTrip: Trip,
  request: DayReplanRequest,
  response: DayReplanResponse,
  currentRevision = REVISION,
  forkTripId = 'trip-fork-replan-1',
): DayReplanApplySuccess {
  const result = applyDayReplan({ baseTrip, request, response, currentRevision, forkTripId })
  if (!result.ok) throw new Error(`应用失败：${result.reason} ${result.message}`)
  return result
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

function targetDayOf(base: Trip, dayNumber = 2): TripDay {
  const day = base.days.find((item) => item.day === dayNumber)
  if (!day) throw new Error(`missing day ${dayNumber}`)
  return day
}

// ==================== 请求构造 ====================

describe('buildDayReplanRequest', () => {
  it('只投影目标日站点文字字段，不带 location / geometry，不改原 Trip', () => {
    const base = deepFreeze(deepClone(makeBase()))
    const snapshot = JSON.stringify(base)
    const request = buildRequest(base, 2, '把第二天改得轻松一些', { travel_mode: 'driving' })

    expect(request.destination).toBe('苏州')
    expect(request.day).toBe(2)
    expect(request.date).toBe('2026-05-02')
    expect(request.travel_mode).toBe('driving')
    expect(request.instruction).toBe('把第二天改得轻松一些')
    expect(request.parent).toEqual({ trip_id: BASE_ID, revision: REVISION })
    expect(request.stops).toHaveLength(2)
    for (const stop of request.stops) {
      expect(Object.keys(stop).sort()).toEqual([
        'address',
        'description',
        'duration_minutes',
        'id',
        'name',
        'time',
      ])
    }
    expect(request.stops[0]).toEqual({
      id: 's2',
      name: '虎丘',
      description: '虎丘的描述',
      address: '虎丘的地址',
      time: '10:00',
      duration_minutes: 60,
    })
    const serialized = JSON.stringify(request)
    for (const forbidden of ['location', 'geometry', 'lng', 'lat']) {
      expect(serialized).not.toContain(forbidden)
    }
    expect('travelers' in request).toBe(false)
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it('显式 travelers 才写进请求，null / 省略都不写', () => {
    const base = makeBase()
    expect(buildRequest(base, 2, '调整', { travelers: 3 }).travelers).toBe(3)
    expect('travelers' in buildRequest(base, 2, '调整', { travelers: null })).toBe(false)
    expect('travelers' in buildRequest(base, 2, '调整')).toBe(false)
  })

  it('接受非目标日的宽导入字段，只校验这次真正要发送的目标日', () => {
    const base = makeBase()
    const day1 = targetDayOf(base, 1)
    day1.stops[0].name = '宽'.repeat(300)
    day1.stops[0].time = '9:00'
    day1.stops[0].address = '路'.repeat(1000)
    const request = buildRequest(base, 2)
    expect(request.stops).toHaveLength(2)
    expect(JSON.stringify(base)).toContain('9:00')
  })

  it('目标日宽 / 坏输入明确拒绝且不截字、不截站', () => {
    const cases: Array<{ label: string; prepare: (base: Trip) => void; reason: string }> = [
      {
        label: 'destination 81 字',
        prepare: (base) => {
          base.destination = '目'.repeat(81)
        },
        reason: 'invalid_destination',
      },
      {
        label: 'day=8',
        prepare: () => undefined,
        reason: 'invalid_day',
      },
      {
        label: '日期非严格 YYYY-MM-DD',
        prepare: (base) => {
          targetDayOf(base).date = '2026-5-2'
        },
        reason: 'invalid_date',
      },
      {
        label: '日期不是真实日历日',
        prepare: (base) => {
          targetDayOf(base).date = '2026-02-30'
        },
        reason: 'invalid_date',
      },
      {
        label: '目标日 9 站',
        prepare: (base) => {
          const day = targetDayOf(base)
          day.stops = Array.from({ length: MAX_REPLAN_STOPS_PER_DAY + 1 }, (_, index) =>
            unlocatedStop(`x-${index}`, `站点${index}`, '09:00'),
          )
          day.legs = []
        },
        reason: 'too_many_stops',
      },
      {
        label: '站名 121 字',
        prepare: (base) => {
          targetDayOf(base).stops[0].name = '名'.repeat(121)
        },
        reason: 'invalid_stop',
      },
      {
        label: '地址 301 字',
        prepare: (base) => {
          targetDayOf(base).stops[0].address = '址'.repeat(301)
        },
        reason: 'invalid_stop',
      },
      {
        label: '描述 1001 字',
        prepare: (base) => {
          targetDayOf(base).stops[0].description = '述'.repeat(1001)
        },
        reason: 'invalid_stop',
      },
      {
        label: '时间 9:00',
        prepare: (base) => {
          targetDayOf(base).stops[0].time = '9:00'
        },
        reason: 'invalid_stop',
      },
      {
        label: '时间 24:00',
        prepare: (base) => {
          targetDayOf(base).stops[0].time = '24:00'
        },
        reason: 'invalid_stop',
      },
      {
        label: '停留 1441',
        prepare: (base) => {
          targetDayOf(base).stops[0].duration_minutes = 1441
        },
        reason: 'invalid_stop',
      },
      {
        label: '停留 1.5',
        prepare: (base) => {
          targetDayOf(base).stops[0].duration_minutes = 1.5
        },
        reason: 'invalid_stop',
      },
      {
        label: '站点 id 101 字',
        prepare: (base) => {
          targetDayOf(base).stops[0].id = 'i'.repeat(101)
        },
        reason: 'invalid_stop',
      },
      {
        label: '站点 id 重复',
        prepare: (base) => {
          targetDayOf(base).stops[1].id = targetDayOf(base).stops[0].id
        },
        reason: 'duplicate_stop_id',
      },
    ]

    for (const testCase of cases) {
      const base = makeBase()
      testCase.prepare(base)
      const snapshot = JSON.stringify(base)
      const day = testCase.label === 'day=8' ? 8 : 2
      const result = buildDayReplanRequest(base, day, '调整', {
        travel_mode: 'walking',
        parentRevision: REVISION,
      })
      expect(result.ok, testCase.label).toBe(false)
      if (!result.ok) {
        expect(result.reason, testCase.label).toBe(testCase.reason)
        expect(result.message.length, testCase.label).toBeGreaterThan(0)
      }
      expect(JSON.stringify(base), testCase.label).toBe(snapshot)
    }
  })

  it('指令、父 revision、人数与模式不合规时拒绝', () => {
    const base = makeBase()
    const cases: Array<{ label: string; instruction: string; options: BuildDayReplanOptions; reason: string }> = [
      {
        label: '空白指令',
        instruction: '   ',
        options: { travel_mode: 'walking', parentRevision: REVISION },
        reason: 'invalid_instruction',
      },
      {
        label: '指令 501 字',
        instruction: '令'.repeat(501),
        options: { travel_mode: 'walking', parentRevision: REVISION },
        reason: 'invalid_instruction',
      },
      {
        label: 'revision 超过安全整数',
        instruction: '调整',
        options: { travel_mode: 'walking', parentRevision: Number.MAX_SAFE_INTEGER + 1 },
        reason: 'invalid_parent_revision',
      },
      {
        label: 'revision 是布尔值',
        instruction: '调整',
        options: { travel_mode: 'walking', parentRevision: true as unknown as number },
        reason: 'invalid_parent_revision',
      },
      {
        label: '人数 0',
        instruction: '调整',
        options: { travel_mode: 'walking', parentRevision: REVISION, travelers: 0 },
        reason: 'invalid_travelers',
      },
      {
        label: '人数 51',
        instruction: '调整',
        options: { travel_mode: 'walking', parentRevision: REVISION, travelers: 51 },
        reason: 'invalid_travelers',
      },
      {
        label: '人数 1.5',
        instruction: '调整',
        options: { travel_mode: 'walking', parentRevision: REVISION, travelers: 1.5 },
        reason: 'invalid_travelers',
      },
      {
        label: '模式 transit',
        instruction: '调整',
        options: { travel_mode: 'transit' as unknown as BuildDayReplanOptions['travel_mode'], parentRevision: REVISION },
        reason: 'invalid_mode',
      },
    ]
    for (const testCase of cases) {
      const result = buildDayReplanRequest(base, 2, testCase.instruction, testCase.options)
      expect(result.ok, testCase.label).toBe(false)
      if (!result.ok) expect(result.reason, testCase.label).toBe(testCase.reason)
    }
  })

  it('日期为 null 与目标日重复 / 缺失时拒绝', () => {
    const nullable = makeBase()
    expect(buildRequest(nullable, 3).date).toBeNull()
    const duplicate = makeBase()
    duplicate.days.push(deepClone(targetDayOf(duplicate)))
    const duplicateResult = buildDayReplanRequest(duplicate, 2, '调整', {
      travel_mode: 'walking',
      parentRevision: REVISION,
    })
    expect(duplicateResult.ok).toBe(false)
    if (!duplicateResult.ok) expect(duplicateResult.reason).toBe('duplicate_day')
    const missingResult = buildDayReplanRequest(makeBase(), 6, '调整', {
      travel_mode: 'walking',
      parentRevision: REVISION,
    })
    expect(missingResult.ok).toBe(false)
    if (!missingResult.ok) expect(missingResult.reason).toBe('unknown_day')
  })
})

// ==================== 响应校验 ====================

describe('validateDayReplanResponse', () => {
  function valid(): { base: Trip; request: DayReplanRequest; response: DayReplanResponse } {
    const base = makeBase()
    const request = buildRequest(base)
    return { base, request, response: withParent(candidateFor(2, request.date, 'no_key'), request) }
  }

  it('接受 no_key / ready / partial / unavailable / timeout / failed 的一致响应', () => {
    const { request } = valid()
    for (const status of ['no_key', 'timeout', 'failed', 'unavailable', 'partial', 'ready'] as MapStatus[]) {
      const response = withParent(candidateFor(2, request.date, status), request)
      const result = validateDayReplanResponse(response, request)
      expect(result.ok, status).toBe(true)
      if (result.ok) {
        expect(result.response.map_status).toBe(status)
        expect(result.response.day.day).toBe(2)
      }
    }
  })

  it('ready 的坐标与相邻导航完整，分类函数与响应状态一致', () => {
    const { request } = valid()
    const response = withParent(candidateFor(2, request.date, 'ready'), request)
    expect(classifyDayMapStatus(response.day)).toBe('ready')
    expect(validateDayReplanResponse(response, request).ok).toBe(true)
  })

  it('source / map_status / parent / day / date 不一致时拒绝', () => {
    const { request, response } = valid()
    const sourceBad = { ...response, source: 'example' } as unknown
    expect(validateDayReplanResponse(sourceBad, request).ok).toBe(false)

    const statusBad = deepClone(response) as unknown as Record<string, unknown>
    statusBad.map_status = 'bogus'
    expect(validateDayReplanResponse(statusBad, request).ok).toBe(false)

    const parentDayBad = withParent(deepClone(response), request)
    parentDayBad.parent = { trip_id: request.parent.trip_id, revision: request.parent.revision + 1 }
    expect(validateDayReplanResponse(parentDayBad, request).ok).toBe(false)

    const parentTripBad = withParent(deepClone(response), request)
    parentTripBad.parent = { trip_id: 'other-trip', revision: request.parent.revision }
    expect(validateDayReplanResponse(parentTripBad, request).ok).toBe(false)

    const dayBad = withParent(deepClone(response), request)
    dayBad.day.day = 3
    expect(validateDayReplanResponse(dayBad, request).ok).toBe(false)

    const dateBad = withParent(deepClone(response), request)
    dateBad.day.date = '2026-05-03'
    expect(validateDayReplanResponse(dateBad, request).ok).toBe(false)

    const extraKey = { ...deepClone(response), extra: true } as unknown
    expect(validateDayReplanResponse(extraKey, request).ok).toBe(false)
  })

  it('站点重复、坐标越界 / 非有限值、未知字段时拒绝', () => {
    const { request } = valid()
    const cases: Array<{ label: string; mutate: (response: DayReplanResponse) => void }> = [
      {
        label: '重复站点 id',
        mutate: (response) => {
          response.day.stops[1].id = response.day.stops[0].id
        },
      },
      {
        label: '经度越界',
        mutate: (response) => {
          response.day.stops[0].location = { lng: 181, lat: 31 }
        },
      },
      {
        label: '纬度越界',
        mutate: (response) => {
          response.day.stops[0].location = { lng: 120, lat: -91 }
        },
      },
      {
        label: 'NaN 坐标',
        mutate: (response) => {
          response.day.stops[0].location = { lng: Number.NaN, lat: 31 }
        },
      },
      {
        label: '字符串坐标',
        mutate: (response) => {
          response.day.stops[0].location = { lng: '120' as unknown as number, lat: 31 }
        },
      },
      {
        label: '站点未知字段',
        mutate: (response) => {
          ;(response.day.stops[0] as unknown as Record<string, unknown>).extra = true
        },
      },
      {
        label: '站点时间不是 HH:MM',
        mutate: (response) => {
          response.day.stops[0].time = '9:30'
        },
      },
    ]
    for (const testCase of cases) {
      const response = withParent(candidateFor(2, request.date, 'ready'), request)
      testCase.mutate(response)
      expect(validateDayReplanResponse(response, request).ok, testCase.label).toBe(false)
    }
  })

  it('leg 悬空 / 错序 / 数量不符 / route_type 与 geometry 不一致时拒绝', () => {
    const { request } = valid()
    const cases: Array<{ label: string; mutate: (response: DayReplanResponse) => void }> = [
      {
        label: '悬空引用',
        mutate: (response) => {
          response.day.legs[0].to_stop_id = 'missing'
        },
      },
      {
        label: '相邻链错序',
        mutate: (response) => {
          const leg = response.day.legs[0]
          const from = leg.from_stop_id
          leg.from_stop_id = leg.to_stop_id
          leg.to_stop_id = from
        },
      },
      {
        label: 'legs 数量不符',
        mutate: (response) => {
          response.day.legs = []
        },
      },
      {
        label: 'navigation 只有 1 点',
        mutate: (response) => {
          response.day.legs[0].geometry = response.day.legs[0].geometry.slice(0, 1)
        },
      },
      {
        label: 'unavailable 带旧线',
        mutate: (response) => {
          response.day.legs[0].route_type = 'unavailable'
        },
      },
      {
        label: 'straight_line 没有端点',
        mutate: (response) => {
          response.day.legs[0].route_type = 'straight_line'
          response.day.legs[0].geometry = []
        },
      },
      {
        label: 'unavailable 带距离',
        mutate: (response) => {
          response.day.legs[0].route_type = 'unavailable'
          response.day.legs[0].geometry = []
          response.day.legs[0].distance_m = 10
        },
      },
    ]
    for (const testCase of cases) {
      const response = withParent(candidateFor(2, request.date, 'ready'), request)
      testCase.mutate(response)
      expect(validateDayReplanResponse(response, request).ok, testCase.label).toBe(false)
    }
  })

  it('warnings 超过 40 条或单条超过 2000 字时拒绝', () => {
    const { request } = valid()
    const tooMany = withParent(candidateFor(2, request.date, 'no_key'), request)
    tooMany.warnings = Array.from({ length: MAX_REPLAN_WARNINGS + 1 }, (_, index) => `提醒 ${index}`)
    expect(validateDayReplanResponse(tooMany, request).ok).toBe(false)

    const tooLong = withParent(candidateFor(2, request.date, 'no_key'), request)
    tooLong.warnings = ['w'.repeat(MAX_REPLAN_WARNING_LENGTH + 1)]
    expect(validateDayReplanResponse(tooLong, request).ok).toBe(false)
  })

  it('map_status 与数据完整度不符时拒绝，不自动修成导航', () => {
    const { request } = valid()
    const readyData = withParent(candidateFor(2, request.date, 'ready'), request)
    const inconsistent: Array<[MapStatus, DayReplanResponse]> = [
      ['partial', readyData],
      ['unavailable', readyData],
      ['no_key', readyData],
      ['ready', withParent(candidateFor(2, request.date, 'no_key'), request)],
    ]
    for (const [status, response] of inconsistent) {
      const bad = deepClone(response)
      bad.map_status = status
      const result = validateDayReplanResponse(bad, request)
      expect(result.ok, `status=${status}`).toBe(false)
    }
  })

  it('全部有坐标但含直线降级时 partial 仍然合法', () => {
    const { request } = valid()
    const response = withParent(candidateFor(2, request.date, 'ready'), request)
    response.map_status = 'partial'
    response.day.legs[0].route_type = 'straight_line'
    expect(classifyDayMapStatus(response.day)).toBe('partial')
    expect(validateDayReplanResponse(response, request).ok).toBe(true)
  })
})

// ==================== 应用 ====================

describe('applyDayReplan', () => {
  it('day=2 只替换第 2 天，其它天对象 / geometry 原引用与字节不变，深冻结输入不被修改', () => {
    const base = makeBase()
    const request = buildRequest(base)
    const response = withParent(candidateFor(2, request.date, 'no_key'), request)
    const baseSnapshot = JSON.stringify(base)
    deepFreeze(base)
    deepFreeze(request)
    deepFreeze(response)

    const result = applyOrThrow(base, request, response)

    expect(result.trip.id).toBe('trip-fork-replan-1')
    expect(result.trip.source).toBe('example')
    expect(result.trip.destination).toBe('苏州')
    expect(result.trip.title).toBe('苏州三日测试行程')
    expect(result.trip.map_coordinate_system).toBe('WGS84')
    expect(result.changedDays).toEqual([2])
    expect(result.trip.days).toHaveLength(3)
    expect(result.trip.days[0]).toBe(base.days[0])
    expect(result.trip.days[2]).toBe(base.days[2])
    expect(result.trip.days[1]).not.toBe(base.days[1])
    expect(result.trip.days[1]).toEqual(response.day)
    expect(JSON.stringify([result.trip.days[0], result.trip.days[2]])).toBe(
      JSON.stringify([base.days[0], base.days[2]]),
    )
    expect(result.trip.summary).toContain('第2天已按 AI 候选替换')
    expect(result.trip.summary).toContain('其余 2 天沿用调整前安排')
    expect(result.trip.warnings[0].startsWith(AI_REPLAN_WARNING_PREFIX)).toBe(true)
    expect(result.trip.warnings).toContain('本次返回提醒：09:30 是占位时间，不是模型给出的真实时刻。')
    expect(result.trip.warnings).toContain('地图数据超时：已保留文字行程，坐标与路线未获取。')
    expect(checkTripShape(result.trip).ok).toBe(true)
    expect(JSON.stringify(base)).toBe(baseSnapshot)
    expect(result.notices).toContain(DAY_REPLAN_APPLY_NOTICE)
    expect(result.omittedWarnings).toBe(0)
  })

  it('ready 候选的坐标与导航几何逐点保留', () => {
    const base = makeBase()
    const request = buildRequest(base)
    const response = withParent(candidateFor(2, request.date, 'ready'), request)
    const result = applyOrThrow(base, request, response)
    expect(result.trip.days[1].stops[0].location).toEqual(response.day.stops[0].location)
    expect(result.trip.days[1].legs[0].geometry).toEqual(response.day.legs[0].geometry)
    expect(checkTripShape(result.trip).ok).toBe(true)
  })

  it('父 revision / 父 id / response parent 不匹配与过期请求都拒绝', () => {
    const base = makeBase()
    const request = buildRequest(base)
    const response = withParent(candidateFor(2, request.date, 'no_key'), request)

    const stale = applyDayReplan({
      baseTrip: base,
      request,
      response,
      currentRevision: REVISION + 1,
      forkTripId: 'trip-fork-replan-2',
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toBe('stale_request')

    const wrongParent = applyDayReplan({
      baseTrip: base,
      request: { ...request, parent: { trip_id: 'other-trip', revision: REVISION } },
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-fork-replan-2',
    })
    expect(wrongParent.ok).toBe(false)
    if (!wrongParent.ok) expect(wrongParent.reason).toBe('parent_mismatch')

    const wrongResponseParent = withParent(deepClone(response), request)
    wrongResponseParent.parent = { trip_id: request.parent.trip_id, revision: REVISION + 1 }
    const badResponse = applyDayReplan({
      baseTrip: base,
      request,
      response: wrongResponseParent,
      currentRevision: REVISION,
      forkTripId: 'trip-fork-replan-2',
    })
    expect(badResponse.ok).toBe(false)
    if (!badResponse.ok) expect(badResponse.reason).toBe('invalid_response')

    const dateChanged = applyDayReplan({
      baseTrip: base,
      request: { ...request, date: '2026-05-09' },
      response: withParent(candidateFor(2, '2026-05-09', 'no_key'), { ...request, date: '2026-05-09' }),
      currentRevision: REVISION,
      forkTripId: 'trip-fork-replan-2',
    })
    expect(dateChanged.ok).toBe(false)
    if (!dateChanged.ok) expect(dateChanged.reason).toBe('stale_request')
  })

  it('fork id 与 base 相同、超长时拒绝；候选站点跨天撞 id 时拒绝', () => {
    const base = makeBase()
    const request = buildRequest(base)
    const response = withParent(candidateFor(2, request.date, 'no_key'), request)
    const sameId = applyDayReplan({
      baseTrip: base,
      request,
      response,
      currentRevision: REVISION,
      forkTripId: BASE_ID,
    })
    expect(sameId.ok).toBe(false)
    if (!sameId.ok) expect(sameId.reason).toBe('invalid_fork_id')

    const longId = applyDayReplan({
      baseTrip: base,
      request,
      response,
      currentRevision: REVISION,
      forkTripId: 'f'.repeat(101),
    })
    expect(longId.ok).toBe(false)
    if (!longId.ok) expect(longId.reason).toBe('invalid_fork_id')

    const conflict = withParent(candidateFor(2, request.date, 'no_key'), request)
    conflict.day.stops[0].id = 's4'
    conflict.day.legs[0].from_stop_id = 's4'
    const conflictResult = applyDayReplan({
      baseTrip: base,
      request,
      response: conflict,
      currentRevision: REVISION,
      forkTripId: 'trip-fork-replan-3',
    })
    expect(conflictResult.ok).toBe(false)
    if (!conflictResult.ok) expect(conflictResult.reason).toBe('cross_day_id_conflict')
    expect(base.days[2].stops[0].id).toBe('s4')
  })

  it('新提醒放得下时全部保留，旧提醒带独立分段头；2000 字原文不被加前缀', () => {
    const base = makeBase()
    base.warnings = ['调整前提醒 A', '调整前提醒 B']
    const request = buildRequest(base)
    const longWarning = 'w'.repeat(MAX_REPLAN_WARNING_LENGTH)
    const response = withParent(
      candidateFor(2, request.date, 'no_key', [longWarning, '地图数据超时：已保留文字行程。']),
      request,
    )
    const result = applyOrThrow(base, request, response)
    expect(result.trip.warnings).toContain(longWarning)
    expect(result.trip.warnings).toContain('调整前提醒 A')
    expect(result.trip.warnings).toContain('调整前提醒 B')
    expect(result.trip.warnings.some((warning) => warning.startsWith(PRE_ADJUSTMENT_WARNING_PREFIX))).toBe(true)
    expect(result.omittedWarnings).toBe(0)
    expect(result.trip.warnings.length).toBe(1 + 2 + 1 + 2)
  })

  it('35 条新提醒 + 10 条旧提醒：保留新提醒首末项，准确省略旧提醒 8 条', () => {
    const base = makeBase()
    base.warnings = Array.from({ length: 10 }, (_, index) => `旧提醒 ${index + 1}`)
    const request = buildRequest(base)
    const newWarnings = Array.from({ length: 35 }, (_, index) => {
      if (index === 0) return 'AI 免责声明：以下时间与路线均为计划值。'
      if (index === 34) return '服务端末尾汇总：已省略 3 条冲突提醒。'
      return `本次提醒 ${index}`
    })
    const response = withParent(candidateFor(2, request.date, 'no_key', newWarnings), request)
    const result = applyOrThrow(base, request, response)

    expect(result.trip.warnings).toHaveLength(MAX_REPLAN_WARNINGS)
    expect(result.keptNewWarnings).toBe(35)
    expect(result.omittedNewWarnings).toBe(0)
    expect(result.keptOldWarnings).toBe(2)
    expect(result.omittedOldWarnings).toBe(8)
    expect(result.trip.warnings[0].startsWith(AI_REPLAN_WARNING_PREFIX)).toBe(true)
    expect(result.trip.warnings[1]).toBe('AI 免责声明：以下时间与路线均为计划值。')
    expect(result.trip.warnings[35]).toBe('服务端末尾汇总：已省略 3 条冲突提醒。')
    expect(result.trip.warnings[36].startsWith(PRE_ADJUSTMENT_WARNING_PREFIX)).toBe(true)
    expect(result.trip.warnings[37]).toBe('旧提醒 1')
    expect(result.trip.warnings[38]).toBe('旧提醒 2')
    expect(result.trip.warnings[39].startsWith(WARNING_OMISSION_PREFIX)).toBe(true)
    expect(result.trip.warnings[39]).toContain('省略0条本次返回提醒/8条调整前提醒')
    expect(result.trip.warnings[39]).toContain('不代表实际冲突总数')
  })

  it('40 条新提醒 + 10 条旧提醒：保留首末项，省略计数为 2 / 10', () => {
    const base = makeBase()
    base.warnings = Array.from({ length: 10 }, (_, index) => `旧提醒 ${index + 1}`)
    const request = buildRequest(base)
    const newWarnings = Array.from({ length: 40 }, (_, index) => {
      if (index === 0) return 'AI 免责声明：以下时间与路线均为计划值。'
      if (index === 39) return '服务端末尾汇总：已省略 5 条冲突提醒。'
      return `本次提醒 ${index}`
    })
    const response = withParent(candidateFor(2, request.date, 'no_key', newWarnings), request)
    const result = applyOrThrow(base, request, response)

    expect(result.trip.warnings).toHaveLength(MAX_REPLAN_WARNINGS)
    expect(result.keptNewWarnings).toBe(38)
    expect(result.omittedNewWarnings).toBe(2)
    expect(result.keptOldWarnings).toBe(0)
    expect(result.omittedOldWarnings).toBe(10)
    expect(result.trip.warnings[1]).toBe('AI 免责声明：以下时间与路线均为计划值。')
    expect(result.trip.warnings).toContain('服务端末尾汇总：已省略 5 条冲突提醒。')
    // 旧提醒一条都没保留：首部说明不能再说「后面还有调整前提醒」
    expect(result.trip.warnings[0].startsWith(AI_REPLAN_WARNING_PREFIX)).toBe(true)
    expect(result.trip.warnings[0]).not.toContain('调整前提醒')
    expect(result.trip.warnings[39].startsWith(WARNING_OMISSION_PREFIX)).toBe(true)
    expect(result.trip.warnings[39]).toContain('省略2条本次返回提醒/10条调整前提醒')
    expect(result.trip.warnings.some((warning) => warning.startsWith(PRE_ADJUSTMENT_WARNING_PREFIX))).toBe(false)
  })

  it('自定义提醒以已知分段头字眼开头时原文保留，不当成生成段删除', () => {
    const userWarnings = [
      '【调整前提醒】博物馆周一闭馆，需核实。',
      '【AI单日调整】是我手动记的复盘备注，不是系统分段头。',
      '【提醒省略】上次对话里手动记的待办，别丢。',
    ]
    const base = makeBase()
    base.warnings = [...userWarnings]
    const request = buildRequest(base)
    const response = withParent(candidateFor(2, request.date, 'no_key'), request)
    const result = applyOrThrow(base, request, response)

    for (const warning of userWarnings) {
      expect(result.trip.warnings, warning).toContain(warning)
    }
    expect(result.keptOldWarnings).toBe(3)
    expect(result.omittedOldWarnings).toBe(0)
    expect(result.omittedNewWarnings).toBe(0)
    expect(result.trip.warnings).toHaveLength(1 + 2 + 1 + 3)
  })

  it('两轮应用：首轮溢出的【提醒省略】记录不会在第二轮消失', () => {
    const base = makeBase()
    base.warnings = Array.from({ length: 10 }, (_, index) => `旧提醒 ${index + 1}`)
    const firstRequest = buildRequest(base)
    const firstNew = Array.from({ length: 40 }, (_, index) => {
      if (index === 0) return '首轮首条：占位时间说明。'
      if (index === 39) return '服务端末尾汇总：已省略 5 条冲突提醒。'
      return `首轮提醒 ${index}`
    })
    const first = applyOrThrow(
      base,
      firstRequest,
      withParent(candidateFor(2, firstRequest.date, 'no_key', firstNew), firstRequest),
    )
    expect(first.trip.warnings).toHaveLength(MAX_REPLAN_WARNINGS)
    expect(first.omittedNewWarnings).toBe(2)
    expect(first.omittedOldWarnings).toBe(10)
    expect(first.trip.warnings.some((warning) => warning.startsWith(WARNING_OMISSION_PREFIX))).toBe(true)
    expect(first.trip.warnings).toContain('服务端末尾汇总：已省略 5 条冲突提醒。')

    const secondRequest = buildRequest(first.trip, 2, '再调整一次', { parentRevision: REVISION + 1 })
    const secondNew = ['第二轮提醒 A', '第二轮提醒 B', '第二轮提醒 C']
    const second = applyOrThrow(
      first.trip,
      secondRequest,
      withParent(candidateFor(2, secondRequest.date, 'no_key', secondNew), secondRequest),
      REVISION + 1,
      'trip-fork-replan-2',
    )

    expect(second.trip.warnings).toHaveLength(MAX_REPLAN_WARNINGS)
    // 首轮省略过条目这件事必须留下，不能因为省略行带生成前缀就一起被摘掉。
    expect(second.trip.warnings.some((warning) => warning.includes('历史提醒不完整'))).toBe(true)
    for (const warning of secondNew) {
      expect(second.trip.warnings, warning).toContain(warning)
    }
    // 本轮的省略计数只指本轮返回条目，不冒充底层实际冲突数。
    expect(second.omittedNewWarnings).toBe(0)
    expect(second.keptOldWarnings + second.omittedOldWarnings).toBe(38)
    expect(second.trip.warnings[39].startsWith(WARNING_OMISSION_PREFIX)).toBe(true)
    expect(second.trip.warnings[39]).toContain('省略0条本次返回提醒/5条调整前提醒')
    expect(second.trip.warnings[39]).toContain('不代表实际冲突总数')
  })

  it('首轮只因继承的旧提醒溢出时，第二轮没有新的省略行也保留历史不完整说明', () => {
    const base = makeBase()
    base.warnings = Array.from({ length: 40 }, (_, index) => `旧提醒 ${index + 1}`)
    const firstRequest = buildRequest(base)
    const first = applyOrThrow(
      base,
      firstRequest,
      withParent(candidateFor(2, firstRequest.date, 'no_key', []), firstRequest),
    )
    expect(first.omittedNewWarnings).toBe(0)
    expect(first.omittedOldWarnings).toBe(3)
    expect(first.trip.warnings).toHaveLength(MAX_REPLAN_WARNINGS)
    expect(first.trip.warnings.some((warning) => warning.startsWith(WARNING_OMISSION_PREFIX))).toBe(true)

    const secondRequest = buildRequest(first.trip, 2, '再调整一次', { parentRevision: REVISION + 1 })
    const second = applyOrThrow(
      first.trip,
      secondRequest,
      withParent(candidateFor(2, secondRequest.date, 'no_key', []), secondRequest),
      REVISION + 1,
      'trip-fork-replan-2',
    )
    expect(second.trip.warnings).toHaveLength(MAX_REPLAN_WARNINGS)
    expect(second.trip.warnings.some((warning) => warning.startsWith(WARNING_OMISSION_PREFIX))).toBe(false)
    expect(second.trip.warnings.some((warning) => warning.includes('历史提醒不完整'))).toBe(true)
  })

  it('连续三轮应用：历史不完整说明只保留一条，第三轮不再省略也不丢该事实', () => {
    const base = makeBase()
    base.warnings = Array.from({ length: 10 }, (_, index) => `旧提醒 ${index + 1}`)
    const firstRequest = buildRequest(base)
    const firstNew = Array.from({ length: 40 }, (_, index) => `第一轮提醒 ${index + 1}`)
    const first = applyOrThrow(
      base,
      firstRequest,
      withParent(candidateFor(2, firstRequest.date, 'no_key', firstNew), firstRequest),
    )
    const secondRequest = buildRequest(first.trip, 2, '再调整一次', { parentRevision: REVISION + 1 })
    const second = applyOrThrow(
      first.trip,
      secondRequest,
      withParent(candidateFor(2, secondRequest.date, 'no_key', ['第二轮提醒 1']), secondRequest),
      REVISION + 1,
      'trip-fork-replan-2',
    )
    const thirdRequest = buildRequest(second.trip, 2, '第三次调整', { parentRevision: REVISION + 2 })
    const third = applyOrThrow(
      second.trip,
      thirdRequest,
      withParent(candidateFor(2, thirdRequest.date, 'no_key', ['第三轮提醒 1']), thirdRequest),
      REVISION + 2,
      'trip-fork-replan-3',
    )

    expect(third.trip.warnings).toHaveLength(MAX_REPLAN_WARNINGS)
    expect(third.trip.warnings.filter((warning) => warning.startsWith(AI_REPLAN_WARNING_PREFIX))).toHaveLength(1)
    expect(third.trip.warnings.filter((warning) => warning.startsWith(PRE_ADJUSTMENT_WARNING_PREFIX))).toHaveLength(1)
    expect(third.trip.warnings.filter((warning) => warning.includes('历史提醒不完整'))).toHaveLength(1)
    expect(third.trip.warnings.filter((warning) => warning.startsWith(WARNING_OMISSION_PREFIX))).toHaveLength(0)
    expect(third.omittedWarnings).toBe(0)
    expect(third.trip.warnings).toContain('第三轮提醒 1')
    expect(third.trip.warnings).toContain('第一轮提醒 1')
    expect(third.trip.warnings).toContain('第二轮提醒 1')
    expect(checkTripShape(third.trip).ok).toBe(true)
  })

  it('无提醒 / 只有旧提醒 / 只有新提醒都只生成一组干净分段', () => {
    const cases: Array<{
      label: string
      newWarnings: string[]
      oldWarnings: string[]
      hasOldHeader: boolean
    }> = [
      { label: '无提醒', newWarnings: [], oldWarnings: [], hasOldHeader: false },
      { label: '只有旧提醒', newWarnings: [], oldWarnings: ['旧提醒 1'], hasOldHeader: true },
      { label: '只有新提醒', newWarnings: ['新提醒 1'], oldWarnings: [], hasOldHeader: false },
    ]
    for (const testCase of cases) {
      const base = makeBase()
      base.warnings = [...testCase.oldWarnings]
      const request = buildRequest(base)
      const result = applyOrThrow(
        base,
        request,
        withParent(candidateFor(2, request.date, 'no_key', testCase.newWarnings), request),
      )
      expect(result.trip.warnings[0].startsWith(AI_REPLAN_WARNING_PREFIX), testCase.label).toBe(true)
      const oldHeaders = result.trip.warnings.filter((warning) =>
        warning.startsWith(PRE_ADJUSTMENT_WARNING_PREFIX),
      )
      expect(oldHeaders, testCase.label).toHaveLength(testCase.hasOldHeader ? 1 : 0)
      expect(result.trip.warnings.includes('新提醒 1'), testCase.label).toBe(
        testCase.newWarnings.length > 0,
      )
      expect(result.omittedWarnings, testCase.label).toBe(0)
      expect(
        result.trip.warnings.some((warning) => warning.startsWith(WARNING_OMISSION_PREFIX)),
        testCase.label,
      ).toBe(false)
      expect(checkTripShape(result.trip).ok, testCase.label).toBe(true)
    }
  })

  it('二次应用只保留一组分段头，摘要不叠加', () => {
    const base = makeBase()
    const firstRequest = buildRequest(base)
    const first = applyOrThrow(
      base,
      firstRequest,
      withParent(candidateFor(2, firstRequest.date, 'no_key'), firstRequest),
    )

    const secondRequest = buildRequest(first.trip, 2, '再调整一次', { parentRevision: REVISION + 1 })
    const second = applyOrThrow(
      first.trip,
      secondRequest,
      withParent(candidateFor(2, secondRequest.date, 'no_key'), secondRequest),
      REVISION + 1,
      'trip-fork-replan-2',
    )
    expect(second.trip.warnings.filter((warning) => warning.startsWith(AI_REPLAN_WARNING_PREFIX))).toHaveLength(1)
    expect(second.trip.warnings.filter((warning) => warning.startsWith(PRE_ADJUSTMENT_WARNING_PREFIX))).toHaveLength(1)
    expect(second.trip.summary.match(/AI 单日调整副本/g)).toHaveLength(1)
    expect(second.trip.summary).toContain('第2天已按 AI 候选替换')
  })

  it('example 行程保存 / 读取与 JSON 备份往返后，新提醒与目标日原样保留', () => {
    const base = makeBase()
    const request = buildRequest(base)
    const response = withParent(candidateFor(2, request.date, 'no_key'), request)
    const result = applyOrThrow(base, request, response)
    const trip = result.trip
    expect(trip.source).toBe('example')

    const storage = memoryStorage()
    const saved = saveTripToStorage(trip, storage)
    expect(saved.ok).toBe(true)
    const loaded = loadSavedTrips(storage)
    expect(loaded.status).toBe('ok')
    const stored = loaded.trips[0].trip
    expect(stored.source).toBe('example')
    expect(stored.warnings).toEqual(trip.warnings)
    expect(stored.days[1]).toEqual(trip.days[1])
    expect(stored.summary).toBe(trip.summary)

    const backup = createTripBackup(trip, { now: '2026-10-30T00:00:00.000Z' })
    if (!backup.ok) throw new Error(backup.message)
    const parsed = parseTripBackup(backup.json)
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.trip.source).toBe('example')
    expect(parsed.trip.warnings).toEqual(trip.warnings)
    expect(parsed.trip.days[1]).toEqual(trip.days[1])
    expect(parsed.trip.warnings).toContain('本次返回提醒：09:30 是占位时间，不是模型给出的真实时刻。')
  })

  it('应用后超过 640 KB 时明确拒绝，原始行程与候选几何都不被截断', () => {
    const base = makeBase()
    const bigStops: TripStop[] = Array.from({ length: 7 }, (_, index) =>
      locatedStop(`big-${index}`, `大站点${index}`, '09:00', 120, 30, { description: '', address: '' }),
    )
    const legPointCounts = [5000, 5000, 5000, 5000, 5000, 4000]
    const bigLegs: TripLeg[] = legPointCounts.map((count, index) => ({
      from_stop_id: `big-${index}`,
      to_stop_id: `big-${index + 1}`,
      mode: 'walking',
      route_type: 'navigation',
      distance_m: null,
      duration_minutes: null,
      geometry: Array.from({ length: count }, () => ({ lng: 120, lat: 30 })),
      description: '',
    }))
    base.days[0] = {
      day: 1,
      date: '2026-05-01',
      title: '第一天',
      summary: '',
      stops: bigStops,
      legs: bigLegs,
    }
    expect(checkTripShape(base).ok).toBe(true)
    expect(savedTripRecordBytes(base)).toBeLessThan(MAX_SAVED_TRIP_BYTES)

    const request = buildRequest(base)
    const warnings = Array.from({ length: MAX_REPLAN_WARNINGS }, () => 'w'.repeat(MAX_REPLAN_WARNING_LENGTH))
    const response = withParent(candidateFor(2, request.date, 'no_key', warnings), request)
    const baseSnapshot = JSON.stringify(base)
    const result = applyDayReplan({
      baseTrip: base,
      request,
      response,
      currentRevision: REVISION,
      forkTripId: 'trip-fork-replan-capacity',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('capacity_exceeded')
      expect(result.message).toContain('640 KB')
    }
    expect(JSON.stringify(base)).toBe(baseSnapshot)
  })
})

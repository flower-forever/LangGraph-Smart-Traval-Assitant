/**
 * F2 规划 constraints wire 适配层的目标测试。
 *
 * 只 mock fetch；不连真实后端、不读 .env / _repro、不写存储。
 * 覆盖：
 * - 旧调用（省略 constraints）请求体逐字不变；
 * - trip_plan / day / day_tail 的 camelCase → snake_case 映射；
 * - scope / parent / revision / binding / stop 关联的 typed 失败与 fetch 0；
 * - 24 条 / 16 KiB / 未知字段 / readonly 输入；
 * - instruction 原文完整、响应 parser 不放宽、422/502/abort 保旧且不重试。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, planTrip, type PlanRequest, type Trip } from '../lib/api'
import { replanDay } from '../lib/dayReplanApi'
import {
  buildDayReplanRequest,
  type DayReplanRequest,
  type DayReplanResponse,
} from '../lib/dayReplan'
import { constraintsFingerprint } from '../lib/constraints'
import { createConstraintsBinding, createWorkspaceRecord } from '../lib/workspace'
import {
  PlanningConstraintsError,
  TRIP_PLAN_CONSTRAINTS_SCOPE,
  buildPlanningConstraintsWire,
} from '../lib/planningConstraintsApi'
import type {
  ConstraintItemV1,
  ConstraintsBindingV1,
  ConstraintsV1,
  PlanScopeV1,
  WorkspaceRecordV1,
} from '../lib/workspaceTypes'

/* ───────── 夹具 ───────── */

function locatedStop(id: string, name: string, time: string, lng: number, lat: number) {
  return {
    id,
    name,
    time,
    duration_minutes: 60,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location: { lng, lat },
  }
}

function navLeg(from: string, to: string, a: { lng: number; lat: number }, b: { lng: number; lat: number }) {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking' as const,
    route_type: 'navigation' as const,
    distance_m: 900,
    duration_minutes: 12,
    geometry: [{ ...a }, { ...b }],
    description: '导航路线。',
  }
}

function makeTrip(): Trip {
  const s1 = locatedStop('s1', '虎丘', '10:00', 120.57, 31.33)
  const s2 = locatedStop('s2', '寒山寺', '13:00', 120.56, 31.31)
  const s3 = locatedStop('s3', '拙政园', '09:30', 120.63, 31.32)
  return {
    id: 'trip-1',
    source: 'example',
    destination: '苏州',
    title: '苏州两日测试行程',
    summary: '原始摘要。',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [
      {
        day: 1,
        date: '2026-05-01',
        title: '第一天',
        summary: '第一天摘要。',
        stops: [s1, s2],
        legs: [navLeg('s1', 's2', { lng: 120.57, lat: 31.33 }, { lng: 120.56, lat: 31.31 })],
      },
      {
        day: 2,
        date: '2026-05-02',
        title: '第二天',
        summary: '第二天摘要。',
        stops: [s3],
        legs: [],
      },
    ],
  }
}

function makeRecord(revision = 5): WorkspaceRecordV1 {
  const created = createWorkspaceRecord({
    workspaceId: 'ws-1',
    ownerId: 'owner-1',
    trip: makeTrip(),
    workspaceRevision: revision,
    now: 1_700_000_000_000,
  })
  if (!created.ok) throw new Error(created.message)
  return created.value
}

function makeConstraint(overrides: Partial<ConstraintItemV1> = {}): ConstraintItemV1 {
  return {
    id: 'constraint-1',
    kind: 'must_visit',
    day: 1,
    stopId: null,
    title: '虎丘',
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    notes: '本地备注，不进 wire。',
    priority: 2,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function makeConstraints(items: ConstraintItemV1[] = [makeConstraint()]): ConstraintsV1 {
  return { items }
}

function makeDayRequest(record: WorkspaceRecordV1, day = 1): DayReplanRequest {
  const built = buildDayReplanRequest(record.trip, day, '把上午排轻松一点：先去虎丘，不要删寒山寺。', {
    travel_mode: 'walking',
    parentRevision: record.workspaceRevision,
  })
  if (!built.ok) throw new Error(built.message)
  return built.request
}

function makeDayContext(
  record: WorkspaceRecordV1,
  constraints: ConstraintsV1,
  scope: PlanScopeV1,
  epoch = 3,
): { constraints: ConstraintsV1; scope: PlanScopeV1; record: WorkspaceRecordV1; binding: ConstraintsBindingV1; epoch: number } {
  const binding = createConstraintsBinding(record, constraints, scope, epoch)
  if (!binding.ok) throw new Error(binding.message)
  return { constraints, scope, record, binding: binding.value, epoch }
}

function makeResponse(request: DayReplanRequest): DayReplanResponse {
  const a = locatedStop('r1', '山塘街', '09:30', 120.61, 31.32)
  const b = locatedStop('r2', '留园', '11:00', 120.59, 31.31)
  return {
    day: {
      day: request.day,
      date: request.date,
      title: 'AI 调整后的第一天',
      summary: 'AI 候选摘要。',
      stops: [a, b],
      legs: [navLeg('r1', 'r2', { lng: 120.61, lat: 31.32 }, { lng: 120.59, lat: 31.31 })],
    },
    warnings: [],
    map_status: 'ready',
    parent: { ...request.parent },
    source: 'agent',
  }
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const PLAN_REQUEST: PlanRequest = {
  destination: '苏州',
  days: 2,
  departure_date: null,
  travelers: 2,
  preferences: '',
  travel_mode: 'walking',
}

function tripPlanScope(): PlanScopeV1 {
  return { ...TRIP_PLAN_CONSTRAINTS_SCOPE }
}

/* ───────── builder：trip_plan ───────── */

describe('buildPlanningConstraintsWire · trip_plan', () => {
  it('严格映射 camelCase → snake_case，显式保留 null，省略 notes / updatedAt', () => {
    const constraints = makeConstraints([
      makeConstraint({ id: 'c1', day: 2, stopId: null, title: '博物馆', durationMinutes: 0 }),
      makeConstraint({
        id: 'c2',
        kind: 'fixed_window',
        day: null,
        stopId: null,
        title: '预约',
        startDate: '2026-05-01',
        startTime: '14:00',
        endDate: null,
        endTime: null,
        durationMinutes: null,
        priority: 3,
      }),
    ])
    const result = buildPlanningConstraintsWire({ constraints, scope: tripPlanScope() })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.constraints).toMatchObject({
      version: 1,
      scope: 'trip_plan',
      day: null,
      anchor_stop_id: null,
      fingerprint: constraintsFingerprint(constraints)?.short,
    })
    expect(result.constraints.items[0]).toEqual({
      id: 'c1',
      kind: 'must_visit',
      day: 2,
      stop_id: null,
      title: '博物馆',
      start_date: null,
      end_date: null,
      start_time: null,
      end_time: null,
      duration_minutes: 0,
      priority: 2,
    })
    expect(result.constraints.items[0]).not.toHaveProperty('notes')
    expect(result.constraints.items[0]).not.toHaveProperty('updatedAt')
    expect(result.itemCount).toBe(2)
    expect(result.byteLength).toBe(new TextEncoder().encode(JSON.stringify(result.constraints)).length)
  })

  it('trip_plan 的非 null stop_id 明确失败，不伪造 request.stops', () => {
    const result = buildPlanningConstraintsWire({
      constraints: makeConstraints([makeConstraint({ stopId: 's1' })]),
      scope: tripPlanScope(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid_constraints')
      expect(result.path).toContain('stopId')
    }
  })

  it('25 条明确 too_many，不截断', () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      makeConstraint({ id: `c-${index}`, day: 1 }),
    )
    const result = buildPlanningConstraintsWire({
      constraints: makeConstraints(items),
      scope: tripPlanScope(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('too_many')
  })

  it('wire JSON 超过 16 KiB 明确 too_large，不发送', () => {
    const items = Array.from({ length: 24 }, (_, index) =>
      makeConstraint({
        id: `${'约'.repeat(196)}${String(index).padStart(3, '0')}`,
        title: '馆'.repeat(120),
        day: 1,
      }),
    )
    const result = buildPlanningConstraintsWire({
      constraints: makeConstraints(items),
      scope: tripPlanScope(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('too_large')
  })

  it('constraints 内部未知字段拒绝', () => {
    const constraints = {
      items: [{ ...makeConstraint(), unknownField: true }],
    } as unknown as ConstraintsV1
    const result = buildPlanningConstraintsWire({ constraints, scope: tripPlanScope() })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid_constraints')
      expect(result.workspaceReason).toBe('unknown_field')
    }
  })

  it('scope 非法 / 带未知字段时 typed 失败', () => {
    const invalidShape = buildPlanningConstraintsWire({
      constraints: makeConstraints(),
      scope: { scope: 'week', day: null, anchorStopId: null } as unknown as PlanScopeV1,
    })
    expect(invalidShape.ok).toBe(false)
    if (!invalidShape.ok) expect(invalidShape.reason).toBe('invalid_scope')

    const extra = buildPlanningConstraintsWire({
      constraints: makeConstraints(),
      scope: { ...tripPlanScope(), extra: true } as unknown as PlanScopeV1,
    })
    expect(extra.ok).toBe(false)
    if (!extra.ok) expect(extra.reason).toBe('invalid_scope')
  })

  it('深冻结输入不被修改', () => {
    const constraints = makeConstraints([makeConstraint()])
    const before = JSON.stringify(constraints)
    Object.freeze(constraints.items[0])
    Object.freeze(constraints.items)
    Object.freeze(constraints)
    const result = buildPlanningConstraintsWire({ constraints, scope: tripPlanScope() })
    expect(result.ok).toBe(true)
    expect(JSON.stringify(constraints)).toBe(before)
  })
})

/* ───────── builder：day / day_tail ───────── */

describe('buildPlanningConstraintsWire · day / day_tail', () => {
  it('day scope 使用当前 record，stop_id 映射为已有站点', () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const scope: PlanScopeV1 = { scope: 'day', day: 1, anchorStopId: null }
    const context = makeDayContext(record, constraints, scope)
    const request = makeDayRequest(record)
    const result = buildPlanningConstraintsWire({ ...context, request })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.constraints.scope).toBe('day')
      expect(result.constraints.day).toBe(1)
      expect(result.constraints.anchor_stop_id).toBe(null)
      expect(result.constraints.items[0].stop_id).toBe('s1')
    }
  })

  it('day_tail 显式 scope + anchor，且 anchor 必须在 request.stops 中', () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const scope: PlanScopeV1 = { scope: 'day_tail', day: 1, anchorStopId: 's1' }
    const context = makeDayContext(record, constraints, scope)
    const request = makeDayRequest(record)
    const result = buildPlanningConstraintsWire({ ...context, request })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.constraints.scope).toBe('day_tail')
      expect(result.constraints.anchor_stop_id).toBe('s1')
    }

    const withoutAnchor = { ...request, stops: request.stops.filter((stop) => stop.id !== 's1') }
    const missing = buildPlanningConstraintsWire({ ...context, request: withoutAnchor })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('stop_not_in_request')
  })

  it('parent / revision 与当前 record 不一致时失败', () => {
    const record = makeRecord(5)
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const scope: PlanScopeV1 = { scope: 'day', day: 1, anchorStopId: null }
    const context = makeDayContext(record, constraints, scope)
    const request = makeDayRequest(record)
    const stale = { ...request, parent: { ...request.parent, revision: 4 } }
    const result = buildPlanningConstraintsWire({ ...context, request: stale })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('request_mismatch')
  })

  it('binding 与当前 constraints 不一致时失败', () => {
    const record = makeRecord()
    const scope: PlanScopeV1 = { scope: 'day', day: 1, anchorStopId: null }
    const bound = makeConstraints([makeConstraint({ stopId: 's1', day: 1, title: '虎丘' })])
    const context = makeDayContext(record, bound, scope)
    const changed = makeConstraints([makeConstraint({ stopId: 's1', day: 1, title: '寒山寺' })])
    const request = makeDayRequest(record)
    const result = buildPlanningConstraintsWire({ ...context, constraints: changed, request })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('binding_mismatch')
  })

  it('day scope 混入其它天的约束失败', () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: null, day: 2 })])
    const result = buildPlanningConstraintsWire({
      constraints,
      scope: { scope: 'day', day: 1, anchorStopId: null },
      record,
      request: makeDayRequest(record),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_constraints')
  })

  it('约束 stop_id 不在本次 request.stops 时失败', () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's2', day: 1 })])
    const scope: PlanScopeV1 = { scope: 'day', day: 1, anchorStopId: null }
    const context = makeDayContext(record, constraints, scope)
    const request = makeDayRequest(record)
    const truncated = { ...request, stops: request.stops.filter((stop) => stop.id !== 's2') }
    const result = buildPlanningConstraintsWire({ ...context, request: truncated })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stop_not_in_request')
  })

  it('day / day_tail 缺少 record / binding / epoch 时失败', () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const result = buildPlanningConstraintsWire({
      constraints,
      scope: { scope: 'day', day: 1, anchorStopId: null },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing_context')
    expect(record.workspaceRevision).toBe(5)
  })
})

/* ───────── planTrip HTTP 包装 ───────── */

describe('planTrip · 可选 planningConstraints', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('省略 planningConstraints 时请求体逐字为旧 JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeTrip()))
    vi.stubGlobal('fetch', fetchMock)
    await planTrip(PLAN_REQUEST)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.body).toBe(JSON.stringify(PLAN_REQUEST))
    expect(JSON.parse(init.body)).not.toHaveProperty('constraints')
  })

  it('给出 constraints 时附加严格 wire 字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeTrip()))
    vi.stubGlobal('fetch', fetchMock)
    const constraints = makeConstraints([makeConstraint({ day: 2, stopId: null, title: '博物馆' })])
    await planTrip(PLAN_REQUEST, { planningConstraints: constraints })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.destination).toBe('苏州')
    expect(body.constraints).toMatchObject({
      version: 1,
      scope: 'trip_plan',
      day: null,
      anchor_stop_id: null,
      items: [expect.objectContaining({ stop_id: null, title: '博物馆' })],
    })
    expect(body.constraints.items[0]).not.toHaveProperty('notes')
  })

  it('constraints 无效时 typed 失败且 fetch 0', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const items = Array.from({ length: 25 }, (_, index) => makeConstraint({ id: `c-${index}` }))
    const err = await planTrip(PLAN_REQUEST, {
      planningConstraints: makeConstraints(items),
    }).catch((error: unknown) => error)
    expect(err).toBeInstanceOf(PlanningConstraintsError)
    expect((err as PlanningConstraintsError).reason).toBe('too_many')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('constraints 含未知字段时 typed 失败且 fetch 0', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const bad = { items: [{ ...makeConstraint(), surprise: 1 }] } as unknown as ConstraintsV1
    const err = await planTrip(PLAN_REQUEST, { planningConstraints: bad }).catch((error: unknown) => error)
    expect(err).toBeInstanceOf(PlanningConstraintsError)
    expect((err as PlanningConstraintsError).reason).toBe('invalid_constraints')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/* ───────── replanDay HTTP 包装 ───────── */

describe('replanDay · 可选 planningConstraints', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('省略 planningConstraints 时请求体逐字为旧 JSON，且不带 constraints', async () => {
    const record = makeRecord()
    const request = makeDayRequest(record)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeResponse(request)))
    vi.stubGlobal('fetch', fetchMock)
    await replanDay(request)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.body).toBe(JSON.stringify(request))
    expect(JSON.parse(init.body)).not.toHaveProperty('constraints')
  })

  it('给出 constraints 时 wire 字段正确，instruction 原文完整保留', async () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const context = makeDayContext(record, constraints, { scope: 'day', day: 1, anchorStopId: null })
    const request = makeDayRequest(record)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeResponse(request)))
    vi.stubGlobal('fetch', fetchMock)
    const response = await replanDay(request, { planningConstraints: context })
    expect(response.parent).toEqual(request.parent)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.instruction).toBe(request.instruction)
    expect(body.stops).toEqual(request.stops)
    expect(body.constraints).toMatchObject({
      version: 1,
      scope: 'day',
      day: 1,
      anchor_stop_id: null,
      items: [expect.objectContaining({ stop_id: 's1' })],
    })
  })

  it('请求 parent 过期时 typed 失败且 fetch 0', async () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const context = makeDayContext(record, constraints, { scope: 'day', day: 1, anchorStopId: null })
    const request = makeDayRequest(record)
    const stale = { ...request, parent: { ...request.parent, revision: 4 } }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const err = await replanDay(stale, { planningConstraints: context }).catch((error: unknown) => error)
    expect(err).toBeInstanceOf(PlanningConstraintsError)
    expect((err as PlanningConstraintsError).reason).toBe('request_mismatch')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('scope 与请求 / 绑定不一致时 typed 失败且 fetch 0', async () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const request = makeDayRequest(record)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const wrongDay = makeDayContext(
      record,
      makeConstraints([makeConstraint({ stopId: null, day: 2 })]),
      { scope: 'day', day: 2, anchorStopId: null },
    )
    const err = await replanDay(request, { planningConstraints: wrongDay }).catch((error: unknown) => error)
    expect(err).toBeInstanceOf(PlanningConstraintsError)
    expect(fetchMock).not.toHaveBeenCalled()

    const withoutAnchor = makeDayContext(record, constraints, { scope: 'day_tail', day: 1, anchorStopId: 's1' })
    const noAnchorRequest = { ...request, stops: request.stops.filter((stop) => stop.id !== 's1') }
    const err2 = await replanDay(noAnchorRequest, { planningConstraints: withoutAnchor }).catch((error: unknown) => error)
    expect(err2).toBeInstanceOf(PlanningConstraintsError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('422 保持既有 ApiError(server) 分类，只发一次', async () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const context = makeDayContext(record, constraints, { scope: 'day', day: 1, anchorStopId: null })
    const request = makeDayRequest(record)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: 'constraints 超限' }, 422))
    vi.stubGlobal('fetch', fetchMock)
    const err = (await replanDay(request, { planningConstraints: context }).catch((error: unknown) => error)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('server')
    expect(err.status).toBe(422)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('502 保持既有 ApiError(server) 分类，只发一次', async () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const context = makeDayContext(record, constraints, { scope: 'day', day: 1, anchorStopId: null })
    const request = makeDayRequest(record)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: '约束缺失安全失败' }, 502))
    vi.stubGlobal('fetch', fetchMock)
    const err = (await replanDay(request, { planningConstraints: context }).catch((error: unknown) => error)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('server')
    expect(err.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('abort 保持 ApiError(abort)，不隐式重试', async () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const context = makeDayContext(record, constraints, { scope: 'day', day: 1, anchorStopId: null })
    const request = makeDayRequest(record)
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('请求已中止', 'AbortError'))
        if (init.signal?.aborted) rejectAbort()
        else init.signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const err = (await replanDay(request, {
      planningConstraints: context,
      signal: controller.signal,
    }).catch((error: unknown) => error)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('abort')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('响应 parser 不放宽：带 constraints 的调用仍拒绝坏响应', async () => {
    const record = makeRecord()
    const constraints = makeConstraints([makeConstraint({ stopId: 's1', day: 1 })])
    const context = makeDayContext(record, constraints, { scope: 'day', day: 1, anchorStopId: null })
    const request = makeDayRequest(record)
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ foo: 'bar' }))
    vi.stubGlobal('fetch', fetchMock)
    const err = (await replanDay(request, { planningConstraints: context }).catch((error: unknown) => error)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.kind).toBe('bad_payload')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

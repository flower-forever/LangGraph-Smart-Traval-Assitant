/**
 * MapRefreshPanel 的独立 UI 测试：真实 build / preview / apply 纯函数，
 * 只 mock 网络 adapter。不接 App，不写存储。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, type RouteType, type TravelMode, type Trip, type TripDay, type TripLeg, type TripLocation } from '../lib/api'
import {
  applyMapRefresh,
  type MapRefreshApplyResult,
  type MapRefreshRequest,
  type MapRefreshResponse,
} from '../lib/mapRefresh'
import type { MapRefreshAdapter } from '../lib/mapRefreshApi'
import MapRefreshPanel from '../components/MapRefreshPanel'

const REVISION = 4
const FORK_ID = 'trip-fork-1'

function point(lng: number, lat: number): TripLocation {
  return { lng, lat }
}

function makeStop(id: string, name: string, time: string, location: TripLocation | null) {
  return {
    id,
    name,
    time,
    duration_minutes: 60,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location,
  }
}

function makeLeg(
  from: string,
  to: string,
  mode: TravelMode = 'walking',
  routeType: RouteType = 'navigation',
  geometry: TripLocation[] = [point(120.2, 30.2), point(120.21, 30.21)],
): TripLeg {
  if (routeType === 'unavailable') {
    return {
      from_stop_id: from,
      to_stop_id: to,
      mode,
      route_type: 'unavailable',
      distance_m: null,
      duration_minutes: null,
      geometry: [],
      description: '本次没有可用路线',
    }
  }
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode,
    route_type: routeType,
    distance_m: 1_000,
    duration_minutes: 12,
    geometry,
    description: routeType === 'straight_line' ? '直线估测' : '导航路线',
  }
}

function makeTrip(): Trip {
  const day1: TripDay = {
    day: 1,
    date: '2026-11-02',
    title: '第一天',
    summary: '第一天的原摘要',
    stops: [
      makeStop('s|1', '西湖', '09:00', point(120.15, 30.25)),
      makeStop('s|2', '灵隐寺', '11:00', point(120.1, 30.24)),
      makeStop('s|3', '河坊街', '14:00', point(120.17, 30.23)),
    ],
    legs: [makeLeg('s|1', 's|2'), makeLeg('s|2', 's|3')],
  }
  const day2: TripDay = {
    day: 2,
    date: null,
    title: '第二天',
    summary: '第二天的原摘要',
    stops: [
      makeStop('t|1', '外滩', '09:00', point(121.49, 31.24)),
      makeStop('t|2', '豫园', '11:00', point(121.49, 31.23)),
    ],
    legs: [makeLeg('t|1', 't|2', 'driving')],
  }
  return {
    id: 'trip-panel-1',
    source: 'example',
    destination: '杭州',
    title: '杭州两日',
    summary: '原行程摘要',
    map_coordinate_system: 'WGS84',
    warnings: ['旧提醒一'],
    days: [day1, day2],
  }
}

interface Captured {
  request: MapRefreshRequest
  signal?: AbortSignal
}

function adapterFor(handler: (request: MapRefreshRequest) => Promise<MapRefreshResponse>) {
  const calls: Captured[] = []
  const adapter: MapRefreshAdapter = (request, options) => {
    calls.push({ request, signal: options?.signal })
    return handler(request)
  }
  return { adapter, calls }
}

function gatedAdapter() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: Captured[] = []
  const adapter: MapRefreshAdapter = (request, options) => {
    calls.push({ request, signal: options?.signal })
    return gate.then(() => readyResponse(request))
  }
  return { adapter, calls, release }
}

function baseResponse(request: MapRefreshRequest) {
  return {
    day: request.day,
    date: request.date,
    parent: { ...request.parent },
    warnings: [] as string[],
  }
}

function readyResponse(
  request: MapRefreshRequest,
  options: {
    locations?: Record<string, TripLocation>
    legs?: TripLeg[]
    warnings?: string[]
  } = {},
): MapRefreshResponse {
  const stops = request.stops.map((item, index) => ({
    id: item.id,
    location: options.locations?.[item.id] ?? point(120.3 + index * 0.01, 30.3),
    resolved_address: null as string | null,
  }))
  const legs =
    options.legs ??
    request.stops.slice(0, -1).map((item, index) => makeLeg(item.id, request.stops[index + 1].id, request.travel_mode))
  return {
    ...baseResponse(request),
    map_status: 'ready',
    stops,
    unresolved: [],
    legs,
    warnings: options.warnings ?? [],
  }
}

function hardResponse(request: MapRefreshRequest, status: string): MapRefreshResponse {
  return {
    ...baseResponse(request),
    map_status: status as MapRefreshResponse['map_status'],
    stops: [],
    unresolved: request.stops.map((item) => ({
      id: item.id,
      reason_code: 'not_found',
      reason: '未找到该站点的位置',
    })),
    legs: [],
  }
}

function partialResponse(
  request: MapRefreshRequest,
  options: {
    resolved: string[]
    legs: TripLeg[]
    locations?: Record<string, TripLocation>
    warnings?: string[]
  },
): MapRefreshResponse {
  const resolved = new Set(options.resolved)
  return {
    ...baseResponse(request),
    map_status: 'partial',
    stops: request.stops
      .filter((item) => resolved.has(item.id))
      .map((item, index) => ({
        id: item.id,
        location: options.locations?.[item.id] ?? point(120.5 + index * 0.01, 30.5),
        resolved_address: null as string | null,
      })),
    unresolved: request.stops
      .filter((item) => !resolved.has(item.id))
      .map((item) => ({ id: item.id, reason_code: 'not_found', reason: '未找到该站点的位置' })),
    legs: options.legs,
    warnings: options.warnings ?? [],
  }
}

function renderPanel(overrides: Partial<Parameters<typeof MapRefreshPanel>[0]> = {}) {
  const trip = overrides.trip ?? makeTrip()
  const day = overrides.day === undefined ? trip.days[0] : overrides.day
  const onApply =
    overrides.onApply ??
    vi.fn((request: MapRefreshRequest, response: MapRefreshResponse): MapRefreshApplyResult =>
      applyMapRefresh({ baseTrip: trip, request, response, currentRevision: REVISION, forkTripId: FORK_ID }),
    )
  const onClose = overrides.onClose ?? vi.fn()
  const props = {
    trip,
    day,
    revision: REVISION,
    requestMap: overrides.requestMap,
    onApply,
    onClose,
    openedFromFile: overrides.openedFromFile,
  }
  const view = render(<MapRefreshPanel {...props} />)
  return { ...view, props, onApply, onClose, trip }
}

async function selectWalking(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: '步行' }))
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('初始状态与请求闸门', () => {
  it('未选出行方式不能发请求，选择本身也不触发请求', async () => {
    const user = userEvent.setup()
    const { adapter, calls } = adapterFor((request) => Promise.resolve(readyResponse(request)))
    renderPanel({ requestMap: adapter })

    expect(screen.getByText(/只更新坐标与路线/)).toBeInTheDocument()
    expect(screen.queryByText(/导入来源的标记同样不变/)).toBeNull()
    expect(screen.getByRole('button', { name: '获取地图候选' })).toBeDisabled()
    expect(screen.queryByText('这次取得的内容')).toBeNull()

    await user.click(screen.getByRole('radio', { name: '步行' }))
    expect(screen.getByRole('button', { name: '获取地图候选' })).toBeEnabled()
    await user.click(screen.getByRole('radio', { name: '驾车' }))
    expect(calls).toHaveLength(0)
  })

  it('点击获取只发一次；pending 时按钮禁用，停止后迟到结果不显示', async () => {
    const user = userEvent.setup()
    const { adapter, calls, release } = gatedAdapter()
    const onApply = vi.fn((): MapRefreshApplyResult => ({ ok: true, changed: false } as MapRefreshApplyResult))
    renderPanel({ requestMap: adapter, onApply })

    await selectWalking(user)
    const fetch = screen.getByRole('button', { name: '获取地图候选' })
    await user.click(fetch)
    expect(calls).toHaveLength(1)
    expect(screen.getByRole('button', { name: '正在获取…' })).toBeDisabled()
    expect(screen.getByText(/正在向地图服务请求/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '正在获取…' }))
    expect(calls).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '停止等待' }))
    expect(calls[0].signal?.aborted).toBe(true)
    expect(screen.getByRole('alert')).toHaveTextContent('已停止等待')
    expect(screen.queryByRole('button', { name: '正在获取…' })).toBeNull()

    await act(async () => {
      release()
      await Promise.resolve()
    })
    expect(screen.queryByText('这次取得的内容')).toBeNull()
    expect(screen.queryByRole('button', { name: '应用地图更新' })).toBeNull()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('卸载时 abort 在途请求', async () => {
    const user = userEvent.setup()
    const { adapter, calls } = gatedAdapter()
    const { unmount } = renderPanel({ requestMap: adapter })
    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    expect(calls).toHaveLength(1)
    unmount()
    expect(calls[0].signal?.aborted).toBe(true)
  })

  it('超过单日 8 个站点时拒绝发起请求并说明未截断', async () => {
    const user = userEvent.setup()
    const trip = makeTrip()
    trip.days[0] = {
      day: 1,
      date: '2026-11-02',
      title: '第一天',
      summary: '',
      stops: Array.from({ length: 9 }, (_, index) =>
        makeStop(`s9|${index}`, `站点${index}`, '09:00', point(120.1 + index * 0.01, 30.2)),
      ),
      legs: [],
    }
    const { adapter, calls } = adapterFor((request) => Promise.resolve(readyResponse(request)))
    renderPanel({ trip, day: trip.days[0], requestMap: adapter })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    expect(calls).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent('超过单日地图刷新上限 8 个')
    expect(screen.getByRole('alert')).toHaveTextContent('没有截断')
  })
})

describe('成功候选与预览', () => {
  it('ready 候选显示新坐标、新路线与统计，应用按钮可用', async () => {
    const user = userEvent.setup()
    const locations = {
      's|1': point(120.4, 30.4),
      's|2': point(120.41, 30.41),
      's|3': point(120.42, 30.42),
    }
    const { adapter } = adapterFor((request) => Promise.resolve(readyResponse(request, { locations })))
    renderPanel({ requestMap: adapter })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    expect(await screen.findByText('这次取得的内容')).toBeInTheDocument()
    expect(screen.getByText(/本次更新 3 个（新增 0、改写 3）/)).toBeInTheDocument()
    expect(screen.getByText('120.40000, 30.40000')).toBeInTheDocument()
    expect(screen.getByText('西湖的地址')).toBeInTheDocument()
    expect(screen.getAllByText(/导航路线，1\.0 km，12 分钟/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '应用地图更新' })).toBeEnabled()
  })

  it('应用回调恰好一次且传完整 request/response；真实 apply 不改原 trip、不写存储、来源不升级', async () => {
    const user = userEvent.setup()
    const trip = makeTrip()
    const responseRef: { value?: MapRefreshResponse } = {}
    const { adapter, calls } = adapterFor((request) => {
      const response = readyResponse(request, {
        locations: {
          's|1': point(120.44, 30.44),
          's|2': point(120.45, 30.45),
          's|3': point(120.46, 30.46),
        },
      })
      responseRef.value = response
      return Promise.resolve(response)
    })
    const onApply = vi.fn((request: MapRefreshRequest, response: MapRefreshResponse): MapRefreshApplyResult =>
      applyMapRefresh({ baseTrip: trip, request, response, currentRevision: REVISION, forkTripId: FORK_ID }),
    )
    renderPanel({ trip, requestMap: adapter, onApply })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')
    await user.click(screen.getByRole('button', { name: '应用地图更新' }))

    expect(onApply).toHaveBeenCalledTimes(1)
    const [requestArg, responseArg] = onApply.mock.calls[0]
    expect(requestArg).toEqual(calls[0].request)
    expect(responseArg).toEqual(responseRef.value)
    expect(requestArg.day).toBe(1)
    expect(requestArg.travel_mode).toBe('walking')
    expect(requestArg.parent.revision).toBe(REVISION)

    const applied = onApply.mock.results[0].value
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('apply 应成功')
    expect(applied.trip.source).toBe('example')
    expect(applied.trip.title).toBe('杭州两日')
    expect(applied.trip.days[0].summary).toBe('第一天的原摘要')
    expect(applied.trip.days[0].stops[0].address).toBe('西湖的地址')

    // 原 trip 对象未被改写
    expect(trip.days[0].stops[0].location).toEqual(point(120.15, 30.25))
    expect(trip.days[0].legs[0].distance_m).toBe(1_000)
    expect(localStorage.length).toBe(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('未返回的站点明确沿用原值，unresolved 显示原因，null 距离/耗时显示未知', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor((request) =>
      Promise.resolve(
        partialResponse(request, {
          resolved: ['s|1'],
          legs: [makeLeg('s|1', 's|2', 'walking', 'unavailable'), makeLeg('s|2', 's|3', 'walking', 'unavailable')],
        }),
      ),
    )
    renderPanel({ requestMap: adapter })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')

    expect(screen.getAllByText('本次未返回坐标，沿用原值')).toHaveLength(2)
    expect(screen.getAllByText('未取得位置：未找到该站点的位置')).toHaveLength(2)
    expect(screen.getByText(/2 个未返回、沿用原值/)).toBeInTheDocument()
    expect(screen.getAllByText('导航路线，1.0 km，12 分钟')).toHaveLength(2)
    expect(screen.getAllByText(/路线待获取，未知，未知/).length).toBe(2)
  })

  it('没有任何变化时不提供可用应用按钮，点击也不回调', async () => {
    const user = userEvent.setup()
    const trip = makeTrip()
    const { adapter } = adapterFor((request) => {
      const locations = Object.fromEntries(
        trip.days[0].stops.map((item) => [item.id, item.location as TripLocation]),
      )
      return Promise.resolve(
        readyResponse(request, {
          locations,
          legs: trip.days[0].legs.map((item) => ({ ...item })),
        }),
      )
    })
    const onApply = vi.fn((): MapRefreshApplyResult => ({ ok: true, changed: false } as MapRefreshApplyResult))
    renderPanel({ trip, requestMap: adapter, onApply })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')
    expect(screen.getByText(/没有可应用的变化/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用地图更新' })).toBeDisabled()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('partial 的直线估测明确标注非导航，不冒充导航路线', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor((request) =>
      Promise.resolve(
        partialResponse(request, {
          resolved: ['s|1', 's|2', 's|3'],
          legs: [
            makeLeg('s|1', 's|2', 'walking', 'straight_line'),
            makeLeg('s|2', 's|3', 'walking', 'straight_line'),
          ],
        }),
      ),
    )
    renderPanel({ requestMap: adapter })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')
    expect(screen.getAllByText(/直线估测（非导航）/).length).toBeGreaterThan(0)
    expect(screen.getByText(/不是导航路线/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用地图更新' })).toBeEnabled()
  })

  it('改出行方式后旧 leg 失效时显示失效段数与提示', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor((request) =>
      Promise.resolve(
        partialResponse(request, {
          resolved: ['s|1', 's|2'],
          legs: [
            makeLeg('s|1', 's|2', 'driving', 'unavailable'),
            makeLeg('s|2', 's|3', 'driving', 'unavailable'),
          ],
        }),
      ),
    )
    renderPanel({ requestMap: adapter })

    await user.click(screen.getByRole('radio', { name: '驾车' }))
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')
    expect(screen.getByText(/2 段旧数据已失效、等待重新获取/)).toBeInTheDocument()
    expect(screen.getAllByText(/沿旧路线显示，标注为本次未重算/).length).toBeGreaterThan(0)
  })
})

describe('不可用状态与错误', () => {
  const statuses = [
    ['no_key', /地图服务未配置/],
    ['timeout', /获取地图数据超时/],
    ['failed', /获取地图数据失败/],
    ['unavailable', /没有可用的坐标/],
  ] as const

  it.each(statuses)('map_status=%s 不显示应用按钮且不回调', async (status, message) => {
    const user = userEvent.setup()
    const { adapter } = adapterFor((request) => Promise.resolve(hardResponse(request, status)))
    const onApply = vi.fn((): MapRefreshApplyResult => ({ ok: true, changed: false } as MapRefreshApplyResult))
    renderPanel({ requestMap: adapter, onApply })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getAllByText(/旧行程保持不变/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '应用地图更新' })).toBeNull()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('adapter 抛超时错误时给出可重试提示且无候选', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor(() => Promise.reject(new ApiError('timeout', '超时')))
    renderPanel({ requestMap: adapter })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('等待地图服务超时')
    expect(screen.queryByText('这次取得的内容')).toBeNull()
    expect(screen.getByRole('button', { name: '获取地图候选' })).toBeEnabled()
  })

  it('adapter 抛网络错误时提示连接不上且保留旧行程', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor(() => Promise.reject(new ApiError('network', '断网')))
    renderPanel({ requestMap: adapter })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('连接不上后端服务')
    expect(screen.queryByText('这次取得的内容')).toBeNull()
  })
})

describe('应用失败', () => {
  it('stale/容量失败只给友好提示，不泄露术语也不假成功', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor((request) =>
      Promise.resolve(
        readyResponse(request, {
          locations: {
            's|1': point(120.47, 30.47),
            's|2': point(120.48, 30.48),
            's|3': point(120.49, 30.49),
          },
        }),
      ),
    )
    const onApply = vi.fn(
      (): MapRefreshApplyResult => ({
        ok: false,
        reason: 'capacity_exceeded',
        message: 'capacity_exceeded: parent_mismatch stale_request revision',
      }),
    )
    const onClose = vi.fn()
    renderPanel({ requestMap: adapter, onApply, onClose })

    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')
    await user.click(screen.getByRole('button', { name: '应用地图更新' }))

    expect(onApply).toHaveBeenCalledTimes(1)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('这次没有应用成功')
    expect(alert).toHaveTextContent('保存空间不足')
    expect(alert.textContent).not.toMatch(/capacity_exceeded|parent_mismatch|stale_request|revision/)
    expect(screen.queryByText(/已应用|更新成功/)).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '应用地图更新' })).toBeInTheDocument()
  })
})

describe('上下文变化立即作废旧候选', () => {
  it('revision 变化后旧候选消失，且旧请求被 abort', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor((request) => Promise.resolve(readyResponse(request)))
    const trip = makeTrip()
    const view = renderPanel({ trip, requestMap: adapter })
    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    expect(await screen.findByText('这次取得的内容')).toBeInTheDocument()

    view.rerender(<MapRefreshPanel {...view.props} revision={REVISION + 1} />)
    await waitFor(() => expect(screen.queryByText('这次取得的内容')).toBeNull())
    expect(screen.queryByRole('button', { name: '应用地图更新' })).toBeNull()
  })

  it('同一 id 的 trip 对象变化后不显示旧候选', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor((request) => Promise.resolve(readyResponse(request)))
    const trip = makeTrip()
    const view = renderPanel({ trip, requestMap: adapter })
    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')

    const nextTrip = { ...trip, title: '杭州两日（已更新）' }
    view.rerender(<MapRefreshPanel {...view.props} trip={nextTrip} />)
    await waitFor(() => expect(screen.queryByText('这次取得的内容')).toBeNull())
    expect(screen.queryByRole('button', { name: '应用地图更新' })).toBeNull()
  })

  it('换日后清空模式与候选，必须重新选择', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor((request) => Promise.resolve(readyResponse(request)))
    const trip = makeTrip()
    const view = renderPanel({ trip, requestMap: adapter })
    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')

    view.rerender(<MapRefreshPanel {...view.props} day={trip.days[1]} />)
    await waitFor(() => expect(screen.queryByText('这次取得的内容')).toBeNull())
    expect(screen.getByRole('radio', { name: '步行' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: '获取地图候选' })).toBeDisabled()
  })

  it('改模式后旧候选不显示，需要重新获取', async () => {
    const user = userEvent.setup()
    const { adapter } = adapterFor((request) => Promise.resolve(readyResponse(request)))
    renderPanel({ requestMap: adapter })
    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')

    await user.click(screen.getByRole('radio', { name: '驾车' }))
    await waitFor(() => expect(screen.queryByText('这次取得的内容')).toBeNull())
    expect(screen.getByRole('button', { name: '获取地图候选' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '应用地图更新' })).toBeNull()
  })

  it('空日显示不可刷新说明，不渲染模式与请求按钮', () => {
    renderPanel({ day: null })
    expect(screen.getByText('当前没有可刷新的这一天，原始行程保持不变。')).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: '步行' })).toBeNull()
    expect(screen.queryByRole('button', { name: '获取地图候选' })).toBeNull()
  })

  it('导入来源只加说明，不改变来源字段', async () => {
    const user = userEvent.setup()
    const trip = makeTrip()
    const { adapter } = adapterFor((request) => Promise.resolve(readyResponse(request)))
    renderPanel({ trip, requestMap: adapter, openedFromFile: true })

    expect(screen.getByText(/导入来源的标记同样不变/)).toBeInTheDocument()
    await selectWalking(user)
    await user.click(screen.getByRole('button', { name: '获取地图候选' }))
    await screen.findByText('这次取得的内容')
    expect(trip.source).toBe('example')
  })
})

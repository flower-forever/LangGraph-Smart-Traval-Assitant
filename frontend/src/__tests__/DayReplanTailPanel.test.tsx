/**
 * DayReplanPanel 后段模式 UI 测试：默认整天旧行为、显式选范围/锚点、生成只预览、
 * 冻结与新后段差异展示、改输入/锚点作废含 A-B-A、取消晚成功、最新 ref。
 * 网络 adapter 全部 mock，业务纯函数不 mock；离线无真实请求。
 */
import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Trip, TripLeg, TripStop } from '../lib/api'
import {
  applyDayReplan,
  type DayReplanApplyResult,
  type DayReplanRequest,
  type DayReplanResponse,
} from '../lib/dayReplan'
import { applyDayReplanTail } from '../lib/dayReplanTail'
import type { DayReplanTailScope } from '../lib/dayReplanTail'
import DayReplanPanel from '../components/DayReplanPanel'

function locatedStop(id: string, name: string, time: string, lng: number, lat: number): TripStop {
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

function navLeg(from: string, to: string, a: { lng: number; lat: number }, b: { lng: number; lat: number }): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 900,
    duration_minutes: 12,
    geometry: [{ ...a }, { ...b }],
    description: '导航路线。',
  }
}

const REVISION = 3

function makeBase(): Trip {
  const a = locatedStop('s1', '虎丘', '09:00', 120.57, 31.33)
  const b = locatedStop('s2', '寒山寺', '11:00', 120.56, 31.31)
  const c = locatedStop('s3', '留园', '14:00', 120.59, 31.32)
  return {
    id: 'trip-tail-panel-1',
    source: 'example',
    destination: '苏州',
    title: '苏州单日测试行程',
    summary: '原始摘要。',
    map_coordinate_system: 'WGS84',
    warnings: ['调整前提醒 A'],
    days: [
      {
        day: 1,
        date: '2026-05-02',
        title: '第二天',
        summary: '第二天摘要。',
        stops: [a, b, c],
        legs: [
          navLeg('s1', 's2', { lng: 120.57, lat: 31.33 }, { lng: 120.56, lat: 31.31 }),
          navLeg('s2', 's3', { lng: 120.56, lat: 31.31 }, { lng: 120.59, lat: 31.32 }),
        ],
      },
    ],
  }
}

/** 构造一个 ready 候选（单新站），parent 与请求一致。 */
function tailCandidate(request: DayReplanRequest, stopId = 'r1', time = '13:00'): DayReplanResponse {
  return {
    day: {
      day: request.day,
      date: request.date,
      title: 'AI 后段候选',
      summary: 'AI 候选摘要。',
      stops: [locatedStop(stopId, '新后段站', time, 120.58, 31.3)],
      legs: [],
    },
    warnings: ['本次返回提醒：13:00 是计划时刻。'],
    map_status: 'ready',
    parent: { ...request.parent },
    source: 'agent',
  }
}

interface HarnessProps {
  base: Trip
  revision?: number
  adapter?: (request: DayReplanRequest, options?: { signal?: AbortSignal }) => Promise<DayReplanResponse>
  onApplySpy?: (
    request: DayReplanRequest,
    response: DayReplanResponse,
    scope?: DayReplanTailScope,
  ) => DayReplanApplyResult | { ok: true; trip: Trip } | { ok: false; reason: string; message: string }
}

/**
 * 受控 harness：模拟父级——tripRef 持最新行程、显式走真实 apply；
 * onApplySpy 存在时只记录调用参数（返回值由 spy 决定）。
 */
function Harness({ base, revision = REVISION, adapter, onApplySpy }: HarnessProps) {
  const tripRef = useRef(base)
  tripRef.current = base
  const [, setTick] = useState(0)
  return (
    <DayReplanPanel
      trip={base}
      dayNumber={1}
      revision={revision}
      plannerAvailability="ready"
      requestDay={adapter}
      onApply={(request, response, scope) => {
        if (onApplySpy) {
          const spied = onApplySpy(request, response, scope)
          // spy 只记录参数：未配置返回值时给面板一个成功结果，避免事件处理器读 undefined.ok
          return (spied ?? { ok: true }) as DayReplanApplyResult
        }
        const result = scope
          ? applyDayReplanTail({
              baseTrip: tripRef.current,
              scope,
              response,
              currentRevision: revision,
              forkTripId: 'trip-tail-panel-fork',
            })
          : applyDayReplan({
              baseTrip: tripRef.current,
              request,
              response,
              currentRevision: revision,
              forkTripId: 'trip-tail-panel-fork',
            })
        if (result.ok) setTick((t) => t + 1)
        return result
      }}
      onClose={() => {}}
    />
  )
}

async function generateTailCandidate(user: ReturnType<typeof userEvent.setup>, base: Trip) {
  const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
  render(<Harness base={base} adapter={adapter} />)
  // 显式切到后段模式并选锚点（第 2 站寒山寺，保留 2 站）
  await user.click(screen.getByRole('radio', { name: /某站之后/ }))
  await user.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
  await user.type(screen.getByLabelText(/调整指令/), '换成安静的安排。')
  await user.click(screen.getByRole('button', { name: '生成调整候选' }))
  await waitFor(() => expect(screen.getByText(/后段候选预览（尚未应用到行程）/)).toBeInTheDocument())
  return adapter
}

describe('DayReplanPanel 后段模式', () => {
  afterEach(cleanup)

  it('默认整天模式：范围选「整天」、无锚点下拉、生成走旧路径且预览是整天候选', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
    render(<Harness base={base} adapter={adapter} />)
    expect((screen.getByRole('radio', { name: /整天/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByLabelText(/保留到哪一站/)).toBeNull()
    await userEvent.type(screen.getByLabelText(/调整指令/), '整日调整。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/候选预览（尚未应用到行程）/)).toBeInTheDocument())
    expect(screen.queryByText(/后段候选预览/)).toBeNull()
    expect(screen.getByRole('button', { name: '应用候选' })).toBeInTheDocument()
  })

  it('单站日后段单选禁用；后段模式未选锚点时生成禁用', async () => {
    const base = makeBase()
    base.days[0] = { ...base.days[0], stops: [base.days[0].stops[0]], legs: [] }
    const { unmount } = render(<Harness base={base} adapter={vi.fn()} />)
    expect((screen.getByRole('radio', { name: /某站之后/ }) as HTMLInputElement).disabled).toBe(true)
    unmount()

    // 恢复三站：可切后段，但没选锚点时生成禁用
    const full = makeBase()
    render(<Harness base={full} adapter={vi.fn()} />)
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.type(screen.getByLabelText(/调整指令/), 'x')
    expect(screen.getByRole('button', { name: '生成调整候选' })).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    expect(screen.getByRole('button', { name: '生成调整候选' })).not.toBeDisabled()
  })

  it('显式生成才请求一次；预览区分冻结段与 AI 新后段并说明衔接未重算', async () => {
    const base = makeBase()
    const adapter = await generateTailCandidate(userEvent.setup(), base)
    expect(adapter).toHaveBeenCalledTimes(1)
    // 冻结段展示原记录
    expect(screen.getByText(/冻结保留（前 2 站，原记录）/)).toBeInTheDocument()
    expect(screen.getByText(/组合方案（冻结段 \+ AI 新后段）/)).toBeInTheDocument()
    expect(screen.getAllByText(/未重算/).length).toBeGreaterThan(0)
    // 应用按钮是后段专属文案
    expect(screen.getByRole('button', { name: '应用后段候选' })).toBeInTheDocument()
    // 预览不等于应用：当前行程没有变
    expect(base.days[0].stops).toHaveLength(3)
  })

  it('显式应用：onApply 收到第三参 scope；成功走真实 tail apply', async () => {
    const base = makeBase()
    const onApplySpy = vi.fn<
      (
        request: DayReplanRequest,
        response: DayReplanResponse,
        scope?: DayReplanTailScope,
      ) => DayReplanApplyResult
    >()
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
    render(<Harness base={base} adapter={adapter} onApplySpy={onApplySpy} />)
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '换成安静的安排。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用后段候选' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '应用后段候选' }))
    expect(onApplySpy).toHaveBeenCalledTimes(1)
    const [, , scope] = onApplySpy.mock.calls[0]
    expect(scope).toBeDefined()
    expect(scope?.kind).toBe('tail')
    expect(scope?.keptCount).toBe(2)
    expect(scope?.anchorStopId).toBe('s2')
  })

  it('整天应用：onApply 第三参为 undefined', async () => {
    const base = makeBase()
    const onApplySpy = vi.fn<
      (
        request: DayReplanRequest,
        response: DayReplanResponse,
        scope?: DayReplanTailScope,
      ) => DayReplanApplyResult
    >()
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
    render(<Harness base={base} adapter={adapter} onApplySpy={onApplySpy} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '整日调整。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '应用候选' }))
    expect(onApplySpy).toHaveBeenCalledTimes(1)
    const [, , scope] = onApplySpy.mock.calls[0]
    expect(scope).toBeUndefined()
  })

  it('改指令 / 改锚点 / A-B-A：旧候选作废且不复活', async () => {
    const base = makeBase()
    const user = userEvent.setup()
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
    render(<Harness base={base} adapter={adapter} />)
    await user.click(screen.getByRole('radio', { name: /某站之后/ }))
    await user.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await user.type(screen.getByLabelText(/调整指令/), '第一版指令。')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用后段候选' })).toBeEnabled())

    // 改指令：作废；旧 TailPreview 不再渲染，应用入口整个消失
    const input = screen.getByLabelText(/调整指令/) as HTMLTextAreaElement
    await user.clear(input)
    await user.type(input, '第二版指令。')
    expect(screen.queryByText(/后段候选预览（尚未应用到行程）/)).toBeNull()
    expect(screen.queryByRole('button', { name: '应用后段候选' })).toBeNull()
    expect(screen.getByText(/基于修改前的内容，不能直接应用/)).toBeInTheDocument()

    // 回到第一版指令（A-B-A）：预览不复活，必须重新生成
    await user.clear(input)
    await user.type(input, '第一版指令。')
    expect(screen.queryByRole('button', { name: '应用后段候选' })).toBeNull()
    expect(adapter).toHaveBeenCalledTimes(1)
  })

  it('切回整天模式后旧后段候选不可应用；锚点换站后旧候选作废', async () => {
    const base = makeBase()
    const user = userEvent.setup()
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
    render(<Harness base={base} adapter={adapter} />)
    await user.click(screen.getByRole('radio', { name: /某站之后/ }))
    await user.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await user.type(screen.getByLabelText(/调整指令/), '指令。')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用后段候选' })).toBeEnabled())

    // 切回整天：后段预览消失，旧候选被清掉，必须重新生成才可应用
    await user.click(screen.getByRole('radio', { name: /整天/ }))
    expect(screen.queryByText(/后段候选预览/)).toBeNull()
    expect(screen.queryByRole('button', { name: '应用候选' })).toBeNull()
    expect(screen.queryByRole('button', { name: '应用后段候选' })).toBeNull()

    // 重新切回后段并生成（锚点换成第 1 站）：旧候选不复活
    await user.click(screen.getByRole('radio', { name: /某站之后/ }))
    await user.selectOptions(screen.getByLabelText(/保留到哪一站/), 's1')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用后段候选' })).toBeEnabled())
    expect(adapter).toHaveBeenCalledTimes(2)
  })

  it('取消等待：adapter 忽略 abort 的迟到成功不进预览', async () => {
    const base = makeBase()
    const late: { resolve: ((response: DayReplanResponse) => void) | null } = { resolve: null }
    const adapter = vi.fn().mockImplementation(
      () =>
        new Promise<DayReplanResponse>((resolve) => {
          late.resolve = resolve
        }),
    )
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '指令。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await userEvent.click(screen.getByRole('button', { name: '停止等待' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '生成调整候选' })).not.toBeDisabled())
    late.resolve?.(tailCandidate((adapter.mock.calls[0] as unknown as [DayReplanRequest])[0]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText(/后段候选预览/)).toBeNull()
  })

  it('失败保旧：apply 返回错误时显示单一通告，原行程不变', async () => {
    const base = makeBase()
    const onApplySpy = vi.fn<
      (
        request: DayReplanRequest,
        response: DayReplanResponse,
        scope?: DayReplanTailScope,
      ) => DayReplanApplyResult
    >().mockReturnValue({
      ok: false,
      reason: 'stale_scope' as never,
      message: '行程内容已经变化（包括原地修改），这份后段候选基于旧内容，不能应用。',
    })
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
    render(<Harness base={base} adapter={adapter} onApplySpy={onApplySpy} />)
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '指令。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用后段候选' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '应用后段候选' }))
    expect(screen.getByText(/基于旧内容，不能应用/)).toBeInTheDocument()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(base.days[0].stops).toHaveLength(3)
  })

  it('trip 对象变化后后段候选被作废（render guard）', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
    const { rerender } = render(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '指令。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/后段候选预览/)).toBeInTheDocument())
    const nextTrip = { ...base, summary: '变化的摘要。' }
    rerender(
      <DayReplanPanel
        trip={nextTrip}
        dayNumber={1}
        revision={REVISION + 1}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText(/后段候选预览/)).toBeNull()
  })

  it('改指令后 stale：TailPreview 整个不渲染（不只禁用按钮）且展示作废原因', async () => {
    const base = makeBase()
    const user = userEvent.setup()
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
    render(<Harness base={base} adapter={adapter} />)
    await user.click(screen.getByRole('radio', { name: /某站之后/ }))
    await user.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await user.type(screen.getByLabelText(/调整指令/), '第一版。')
    await user.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/后段候选预览（尚未应用到行程）/)).toBeInTheDocument())
    // 改指令后：旧预览永久消失，不能只 disable 而继续渲染旧组合结果
    await user.clear(screen.getByLabelText(/调整指令/))
    await user.type(screen.getByLabelText(/调整指令/), '第二版。')
    expect(screen.queryByText(/后段候选预览（尚未应用到行程）/)).toBeNull()
    expect(screen.getByText(/基于修改前的内容，不能直接应用/)).toBeInTheDocument()
  })

  it('预览展示原始后段地图状态（no_key 原因可见），不冒组合成功', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => {
      const response = tailCandidate(request)
      // no_key 合法形态：所有站点坐标 null、所有 legs unavailable
      response.map_status = 'no_key'
      response.day.stops = [
        { ...response.day.stops[0], location: null },
      ]
      response.day.legs = []
      response.warnings = ['服务端未配置地图 Key，站点坐标与路线未获取。']
      return response
    })
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '换安排。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/后段候选预览（尚未应用到行程）/)).toBeInTheDocument())
    // 原始后段地图数据状态独立展示，no_key 原因不被组合状态覆盖
    expect(screen.getByText(/原始后段地图数据（AI 返回时）：/)).toBeInTheDocument()
    expect(screen.getByText(/服务端未配置地图服务/)).toBeInTheDocument()
    // 原始候选 warnings 原样可见（不只显示 notices）
    expect(screen.getByText(/服务端未配置地图 Key，站点坐标与路线未获取。/)).toBeInTheDocument()
  })

  it('迟到成功赶在 effect 之前：ctx 守卫丢弃，不落进已变化的上下文', async () => {
    const base = makeBase()
    const late: { resolve: ((response: DayReplanResponse) => void) | null } = { resolve: null }
    const adapter = vi.fn().mockImplementation(
      () =>
        new Promise<DayReplanResponse>((resolve) => {
          late.resolve = resolve
        }),
    )
    const { rerender } = render(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '指令。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1))
    // 同步变化 trip 对象（新 revision）：effect 里的 seq 递增可能尚未运行，
    // 但 ctxRef 已在渲染时更新，迟到成功必须被丢弃
    const nextTrip = { ...base, summary: '外部变更。' }
    rerender(
      <DayReplanPanel
        trip={nextTrip}
        dayNumber={1}
        revision={REVISION + 1}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await act(async () => {
      late.resolve?.(tailCandidate((adapter.mock.calls[0] as unknown as [DayReplanRequest])[0]))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByText(/后段候选预览/)).toBeNull()
  })

  it('同对象内容修改的迟到成功：赶在 effect 之前也丢弃（render 期签名）', async () => {
    const base = makeBase()
    const late: { resolve: ((response: DayReplanResponse) => void) | null } = { resolve: null }
    const adapter = vi.fn().mockImplementation(
      () =>
        new Promise<DayReplanResponse>((resolve) => {
          late.resolve = resolve
        }),
    )
    const { rerender } = render(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '指令。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1))
    // 同一对象原地修改内容（不换引用、不改 revision）：ctxRef 指针比较抓不住，
    // 内容签名必须抓住；effect 尚未运行也要丢弃
    ;(base.days[0].stops[2] as { name: string }).name = '原地改名'
    rerender(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await act(async () => {
      late.resolve?.(tailCandidate((adapter.mock.calls[0] as unknown as [DayReplanRequest])[0]))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByText(/后段候选预览/)).toBeNull()
  })

  it('行程内容 A→B→A：contentEpoch 单调，旧候选不复活（不只内容等值）', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request: DayReplanRequest) => tailCandidate(request))
    const { rerender } = render(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '指令。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/后段候选预览/)).toBeInTheDocument())

    // A→B：换一个 trip 对象（父级更新）
    const tripB = { ...base, title: 'B 版行程' }
    rerender(
      <DayReplanPanel
        trip={tripB}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText(/后段候选预览/)).toBeNull()

    // B→A：内容回到与生成时等值（同引用同内容），但版本号已单调递增，不复活
    rerender(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText(/后段候选预览/)).toBeNull()
    expect(screen.queryByRole('button', { name: '应用后段候选' })).toBeNull()
  })

  it('原始输入变化后失效旧候选但等待 effect：内容版本在渲染时已变化', async () => {
    // 用 fireEvent 同步改输入再立即 resolve：inputEpoch 的 effect 还没跑，
    // 但 contentEpoch（含原始输入）已在渲染时递增，迟到结果必须丢弃。
    const base = makeBase()
    const late: { resolve: ((response: DayReplanResponse) => void) | null } = { resolve: null }
    const adapter = vi.fn().mockImplementation(
      () =>
        new Promise<DayReplanResponse>((resolve) => {
          late.resolve = resolve
        }),
    )
    render(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '指令。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1))
    // 同步改指令并立即 resolve：effect（inputEpoch +1）尚未运行
    fireEvent.change(screen.getByLabelText(/调整指令/), { target: { value: '改过的指令。' } })
    await act(async () => {
      late.resolve?.(tailCandidate((adapter.mock.calls[0] as unknown as [DayReplanRequest])[0]))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByText(/后段候选预览/)).toBeNull()
  })

  it('迟到失败同样受 ctx 守卫：内容变化后错误提示不落进新上下文', async () => {
    const base = makeBase()
    const late: { reject: ((err: unknown) => void) | null } = { reject: null }
    const adapter = vi.fn().mockImplementation(
      () =>
        new Promise<DayReplanResponse>((_, reject) => {
          late.reject = reject
        }),
    )
    const { rerender } = render(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '指令。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1))
    // 同对象内容修改后拒绝连接的错误迟到：不覆盖新上下文
    ;(base.days[0].stops[2] as { name: string }).name = '原地改名二'
    rerender(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await act(async () => {
      late.reject?.(new TypeError('network down'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('上下文不可序列化：生成前 fail closed，不发请求', async () => {
    // 循环引用无法 JSON.stringify：模拟不可序列化行程（类型上强制转型）
    const base = makeBase() as Trip & { circular?: unknown }
    const holder: { self?: unknown } = {}
    holder.self = holder
    base.circular = holder
    const adapter = vi.fn()
    render(
      <DayReplanPanel
        trip={base}
        dayNumber={1}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    await userEvent.type(screen.getByLabelText(/调整指令/), '指令。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    expect(await screen.findByText(/无法序列化成快照，无法安全记录后段范围/)).toBeInTheDocument()
    expect(adapter).not.toHaveBeenCalled()
  })

  it('指令合并后超 500 字：显示明确错误与可用长度，不发请求', async () => {
    const base = makeBase()
    const adapter = vi.fn()
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.click(screen.getByRole('radio', { name: /某站之后/ }))
    await userEvent.selectOptions(screen.getByLabelText(/保留到哪一站/), 's2')
    fireEvent.change(screen.getByLabelText(/调整指令/), { target: { value: '长'.repeat(470) } })
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    expect(await screen.findByText(/没有截断/)).toBeInTheDocument()
    expect(screen.getByText(/留给你的指令只有/)).toBeInTheDocument()
    expect(adapter).not.toHaveBeenCalled()
  })
})

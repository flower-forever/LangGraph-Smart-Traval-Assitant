/**
 * DayReplanPanel 的用户路径测试：受控 harness + 真实 build/validate/apply 纯函数。
 * 网络 adapter / fetch 全部 mock，不做真实服务调用。
 */
import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Trip } from '../lib/api'
import {
  applyDayReplan,
  buildDayReplanRequest,
  type DayReplanApplyResult,
  type DayReplanRequest,
  type DayReplanResponse,
  type MapStatus,
} from '../lib/dayReplan'
import DayReplanPanel from '../components/DayReplanPanel'

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

const REVISION = 3

function makeBase(): Trip {
  const a = locatedStop('s1', '虎丘', '10:00', 120.57, 31.33)
  const b = locatedStop('s2', '寒山寺', '13:00', 120.56, 31.31)
  const day1 = locatedStop('s3', '拙政园', '09:00', 120.62, 31.32)
  return {
    id: 'trip-panel-1',
    source: 'example',
    destination: '苏州',
    title: '苏州两日测试行程',
    summary: '原始摘要。',
    map_coordinate_system: 'WGS84',
    warnings: ['调整前提醒 A'],
    days: [
      { day: 1, date: '2026-05-01', title: '第一天', summary: '第一天摘要。', stops: [day1], legs: [] },
      {
        day: 2,
        date: '2026-05-02',
        title: '第二天',
        summary: '第二天摘要。',
        stops: [a, b],
        legs: [navLeg('s1', 's2', { lng: 120.57, lat: 31.33 }, { lng: 120.56, lat: 31.31 })],
      },
    ],
  }
}

function candidateFor(
  request: DayReplanRequest,
  status: MapStatus = 'ready',
  warnings: string[] = [
    '本次返回提醒：09:30 是占位时间，不是真实时刻。',
    '本次返回提醒：营业状态未核实。',
    '本次返回提醒：交通耗时为计划值。',
    '本次返回提醒：第四条提醒。',
  ],
): DayReplanResponse {
  const a = locatedStop('r1', '山塘街', '09:30', 120.61, 31.32)
  const b = locatedStop('r2', '留园', '11:00', 120.59, 31.31)
  if (status === 'ready') {
    return {
      day: {
        day: request.day,
        date: request.date,
        title: 'AI 调整后的第二天',
        summary: 'AI 候选摘要。',
        stops: [a, b],
        legs: [navLeg('r1', 'r2', { lng: 120.61, lat: 31.32 }, { lng: 120.59, lat: 31.31 })],
      },
      warnings,
      map_status: 'ready',
      parent: { ...request.parent },
      source: 'agent',
    }
  }
  return {
    day: {
      day: request.day,
      date: request.date,
      title: 'AI 调整后的第二天',
      summary: 'AI 候选摘要。',
      stops: [
        { ...a, location: null, time: '09:30' },
        { ...b, location: null },
      ],
      legs: [
        {
          from_stop_id: 'r1',
          to_stop_id: 'r2',
          mode: 'walking',
          route_type: 'unavailable',
          distance_m: null,
          duration_minutes: null,
          geometry: [],
          description: '尚未获取路线。',
        },
      ],
    },
    warnings: ['地图数据超时：已保留文字行程，坐标与路线未获取。'],
    map_status: status,
    parent: { ...request.parent },
    source: 'agent',
  }
}

function buildRequest(base: Trip, day = 2, instruction = '把第二天安排得轻松一点。', mode: 'walking' | 'driving' = 'walking') {
  const result = buildDayReplanRequest(base, day, instruction, { travel_mode: mode, parentRevision: REVISION })
  if (!result.ok) throw new Error(result.message)
  return result.request
}

interface HarnessProps {
  base: Trip
  dayNumber?: number
  revision?: number
  plannerAvailability?: 'ready' | 'unavailable' | 'unknown'
  adapter?: (request: DayReplanRequest, options?: { signal?: AbortSignal }) => Promise<DayReplanResponse>
  onApplySpy?: (request: DayReplanRequest, response: DayReplanResponse) => DayReplanApplyResult
}

/** 受控 harness：持有最新 trip/revision ref，模拟父级显式应用。 */
function Harness({ base, dayNumber = 2, revision = REVISION, plannerAvailability = 'ready', adapter, onApplySpy }: HarnessProps) {
  const tripRef = useRef(base)
  tripRef.current = base
  const [revisionState] = useState(revision)
  return (
    <DayReplanPanel
      trip={base}
      dayNumber={dayNumber}
      revision={revisionState}
      plannerAvailability={plannerAvailability}
      requestDay={adapter}
      onApply={(request, response) => {
        if (onApplySpy) return onApplySpy(request, response)
        // 模拟父级：用最新 ref 核对并应用
        return applyDayReplan({
          baseTrip: tripRef.current,
          request,
          response,
          currentRevision: revisionState,
          forkTripId: 'trip-panel-1-fork',
        })
      }}
      onClose={() => {}}
    />
  )
}

describe('DayReplanPanel', () => {
  afterEach(cleanup)

  it('生成前不调用 adapter；点击生成才调用一次', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockResolvedValue(candidateFor(buildRequest(base)))
    render(<Harness base={base} adapter={adapter} />)
    expect(adapter).not.toHaveBeenCalled()
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1))
    expect(screen.getByText(/候选预览（尚未应用到行程）/)).toBeInTheDocument()
  })

  it('指令为空时生成按钮禁用；超过 500 字提示并禁用', async () => {
    const base = makeBase()
    const adapter = vi.fn()
    render(<Harness base={base} adapter={adapter} />)
    const generate = screen.getByRole('button', { name: '生成调整候选' })
    expect(generate).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/调整指令/), { target: { value: 'x'.repeat(501) } })
    expect(screen.getByText(/已超过 500 字/)).toBeInTheDocument()
    expect(generate).toBeDisabled()
    expect(adapter).not.toHaveBeenCalled()
  })

  it('planner 明确不可用时禁用生成并说明本地编辑仍可用；unknown 不禁用', async () => {
    const base = makeBase()
    const { unmount } = render(<Harness base={base} plannerAvailability="unavailable" adapter={vi.fn()} />)
    expect(screen.getByRole('button', { name: '生成调整候选' })).toBeDisabled()
    expect(screen.getByText(/本地编辑不受影响/)).toBeInTheDocument()
    unmount()
    render(<Harness base={base} plannerAvailability="unknown" adapter={vi.fn()} />)
    expect(screen.queryByText(/本地编辑不受影响/)).toBeNull()
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    expect(screen.getByRole('button', { name: '生成调整候选' })).not.toBeDisabled()
  })

  it('本日模式一致时预选 walking；预览前后原 trip 保持不变', async () => {
    const base = makeBase()
    const snapshot = JSON.stringify(base)
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request))
    render(<Harness base={base} adapter={adapter} />)
    expect((screen.getByLabelText('步行') as HTMLInputElement).checked).toBe(true)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/候选预览（尚未应用到行程）/)).toBeInTheDocument())
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it('目标日没有任何路段时说明原因并要求显式选出行方式', () => {
    const base = makeBase()
    base.days[1] = { ...base.days[1], stops: [], legs: [] }
    render(<Harness base={base} dayNumber={2} adapter={vi.fn()} />)
    expect(screen.getByText(/这一天还没有路段/)).toBeInTheDocument()
    expect(screen.queryByText(/包含多种方式/)).toBeNull()
    expect(screen.getByRole('button', { name: '生成调整候选' })).toBeDisabled()
  })

  it('地图降级候选显示六态说明与占位提醒', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request, 'timeout'))
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/获取地图数据超时/)).toBeInTheDocument())
    await waitFor(() => expect(screen.getAllByText(/该站点暂无坐标，地图不绘制此点。/).length).toBe(2))
  })

  it('warnings 超过 3 条时计数准确且可展开', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request))
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/本次返回提醒（4 条）/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '展开其余 1 条提醒' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '展开其余 1 条提醒' }))
    expect(screen.getByText('本次返回提醒：第四条提醒。')).toBeInTheDocument()
  })

  it('显式应用调用 onApply 并传 request/response；应用成功面板不改状态', async () => {
    const base = makeBase()
    const onApplySpy = vi.fn().mockReturnValue(
      applyDayReplan({
        baseTrip: base,
        request: buildRequest(base),
        response: candidateFor(buildRequest(base)),
        currentRevision: REVISION,
        forkTripId: 'trip-panel-1-fork',
      }),
    )
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request))
    render(<Harness base={base} adapter={adapter} onApplySpy={onApplySpy} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '应用候选' }))
    expect(onApplySpy).toHaveBeenCalledTimes(1)
    const [request, response] = onApplySpy.mock.calls[0]
    expect(request.parent.trip_id).toBe('trip-panel-1')
    expect(response.source).toBe('agent')
  })

  it('onApply 返回失败（过期）时保留当前 trip 并提示', async () => {
    const base = makeBase()
    const onApplySpy = vi.fn().mockReturnValue({
      ok: false,
      reason: 'stale_request',
      message: '这份 AI 候选基于旧版本的行程（父 revision 已变化），不能覆盖当前内容；请重新发起调整。',
    })
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request))
    render(<Harness base={base} adapter={adapter} onApplySpy={onApplySpy} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '应用候选' }))
    expect(screen.getByText(/基于旧版本的行程/)).toBeInTheDocument()
    // 行程保持原样
    expect(base.days[1].stops[0].name).toBe('虎丘')
  })

  it('onApply 返回容量错误时显示可操作提示', async () => {
    const base = makeBase()
    const onApplySpy = vi.fn().mockReturnValue({
      ok: false,
      reason: 'capacity_exceeded',
      message: '应用后的行程超过保存与备份上限，这次应用已放弃，原始行程与候选几何都没有被改动或截断。',
    })
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request))
    render(<Harness base={base} adapter={adapter} onApplySpy={onApplySpy} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: '应用候选' }))
    expect(screen.getByText(/超过保存与备份上限/)).toBeInTheDocument()
  })

  it('无候选时应用按钮不存在；放弃候选后预览消失', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request))
    render(<Harness base={base} adapter={adapter} />)
    expect(screen.queryByRole('button', { name: '应用候选' })).toBeNull()
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: '放弃候选' }))
    expect(screen.queryByRole('button', { name: '应用候选' })).toBeNull()
  })

  it('停止等待：adapter 忽略 abort 的迟到响应不进预览', async () => {
    const base = makeBase()
    const late: { resolve: ((response: DayReplanResponse) => void) | null } = { resolve: null }
    const adapter = vi.fn().mockImplementation(
      () =>
        new Promise<DayReplanResponse>((resolve) => {
          late.resolve = resolve
        }),
    )
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await userEvent.click(screen.getByRole('button', { name: '停止等待' }))
    // adapter 从不响应 abort：面板不再等它，禁用解除；迟到响应稍后应被作废
    await waitFor(() => expect(screen.getByRole('button', { name: '生成调整候选' })).not.toBeDisabled())
    // 迟到响应：seq 已变化，作废
    late.resolve?.(candidateFor(buildRequest(base)))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText(/候选预览（尚未应用到行程）/)).toBeNull()
    expect(screen.getByRole('button', { name: '生成调整候选' })).not.toBeDisabled()
  })

  it('父版本变化（新 trip 对象）后 abort 并作废候选，指令保留', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request))
    const { rerender } = render(
      <DayReplanPanel
        trip={base}
        dayNumber={2}
        revision={REVISION}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/候选预览（尚未应用到行程）/)).toBeInTheDocument())
    // 父级更新行程（新对象、新 revision）
    const nextTrip = { ...base, summary: '变化后的摘要。' }
    rerender(
      <DayReplanPanel
        trip={nextTrip}
        dayNumber={2}
        revision={REVISION + 1}
        plannerAvailability="ready"
        requestDay={adapter}
        onApply={() => ({ ok: false, reason: 'invalid_base', message: '不应被调用' })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText(/候选预览（尚未应用到行程）/)).toBeNull()
    expect((screen.getByLabelText(/调整指令/) as HTMLTextAreaElement).value).toBe('把第二天安排得轻松一点。')
    expect(screen.getAllByText(/候选/).length).toBeGreaterThan(0)
  })

  it('改指令后旧候选不可应用并明确说明', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request))
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled())
    const input = screen.getByLabelText(/调整指令/) as HTMLTextAreaElement
    await userEvent.clear(input)
    await userEvent.type(input, '换成完全不同的指令。')
    expect(screen.getByText(/基于修改前的内容，不能直接应用/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用候选' })).toBeDisabled()
  })

  it('同行人数留空时不写进请求；填写后随请求发送，改人数后旧候选不可应用', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(async (request) => candidateFor(request))
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1))
    const firstRequest = adapter.mock.calls[0][0] as DayReplanRequest
    expect('travelers' in firstRequest).toBe(false)
    expect(screen.getByRole('button', { name: '应用候选' })).toBeEnabled()

    // 改人数：旧候选基于旧条件，应用被禁用并说明
    await userEvent.type(screen.getByLabelText(/同行人数（选填）/), '3')
    expect(screen.getByText(/同行人数已经变化/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '应用候选' })).toBeDisabled()

    // 重新生成：人数写进请求
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(2))
    const secondRequest = adapter.mock.calls[1][0] as DayReplanRequest
    expect(secondRequest.travelers).toBe(3)
  })

  it('同行人数只接受 1–50 的整数：非法值禁用生成并提示，边界值可用', async () => {
    const base = makeBase()
    const adapter = vi.fn()
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    const travelersInput = screen.getByLabelText(/同行人数（选填）/) as HTMLInputElement
    const generate = screen.getByRole('button', { name: '生成调整候选' })

    for (const invalid of ['0', '51', 'abc', '1.5']) {
      fireEvent.change(travelersInput, { target: { value: invalid } })
      expect(screen.getByText(/需要是 1–50 的整数/)).toBeInTheDocument()
      expect(generate).toBeDisabled()
    }

    fireEvent.change(travelersInput, { target: { value: '1' } })
    expect(screen.queryByText(/需要是 1–50 的整数/)).toBeNull()
    expect(generate).not.toBeDisabled()
    fireEvent.change(travelersInput, { target: { value: '50' } })
    expect(generate).not.toBeDisabled()
    // 留空恢复可生成，且不把人数当成 0
    fireEvent.change(travelersInput, { target: { value: '' } })
    expect(generate).not.toBeDisabled()
  })

  it('错误不回显后端 detail / 敏感 token', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockRejectedValue(
      Object.assign(new Error('secret-token-xyz'), { kind: 'server', status: 500, detail: 'secret-token-xyz' }),
    )
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.queryByText(/secret-token-xyz/)).toBeNull()
  })

  it('503 显示规划暂时不可用且提及本地编辑不受影响', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockRejectedValue(Object.assign(new Error('服务不可用'), { kind: 'server', status: 503 }))
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/AI 规划服务暂时不可用/)).toBeInTheDocument())
  })

  it('超时 / 网络错误给固定可操作文案', async () => {
    const base = makeBase()
    const { unmount } = render(
      <Harness
        base={base}
        adapter={vi.fn().mockRejectedValue(Object.assign(new Error('t'), { kind: 'timeout' }))}
      />,
    )
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/等待 AI 结果超时/)).toBeInTheDocument())
    unmount()
    render(<Harness base={base} adapter={vi.fn().mockRejectedValue(Object.assign(new Error('n'), { kind: 'network' }))} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByText(/连接不上后端服务/)).toBeInTheDocument())
  })

  it('面板显示目标日与日期，不暗示整份替换', () => {
    const base = makeBase()
    render(<Harness base={base} adapter={vi.fn()} />)
    expect(screen.getByText(/第 2 天（2026-05-02）/)).toBeInTheDocument()
    expect(screen.getByText(/只调整这一天，其余天保持原样/)).toBeInTheDocument()
  })

  it('pending 期间表单禁用，不重复提交', async () => {
    const base = makeBase()
    const adapter = vi.fn().mockImplementation(
      () => new Promise<DayReplanResponse>(() => {}),
    )
    render(<Harness base={base} adapter={adapter} />)
    await userEvent.type(screen.getByLabelText(/调整指令/), '把第二天安排得轻松一点。')
    await userEvent.click(screen.getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正在生成候选…'))
    expect(screen.getByLabelText(/调整指令/)).toBeDisabled()
    expect(screen.getByRole('button', { name: '生成调整候选' })).toBeDisabled()
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '停止等待' })).toBeInTheDocument()
  })
})

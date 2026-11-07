/**
 * AssistantDialogPanel 面板级测试：提案卡渲染、H 级禁 apply、U 级独立确认、
 * 应用 / 撤销、不采纳零写入、提案失效提示、重排通道与失败保旧。
 *
 * 全部离线：网络用注入的 mock adapter，存储用 spy 断言零写入；
 * 真实纯函数（assistantDialog / constraints / workspace）不 mock。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AssistantDialogPanel, {
  replanCandidateIsStale,
  type ReplanCandidateBase,
} from '../components/AssistantDialogPanel'
import {
  ASSISTANT_POOL_LOCATION_NOTICE,
  ASSISTANT_SLOT_TIME_NOTICE,
  ASSISTANT_UNVERIFIED_NOTICE,
  ASSISTANT_UNKNOWN_TEXT,
} from '../lib/assistantDialog'
import type { TravelMode, Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import type { DayReplanAdapter } from '../components/DayReplanPanel'
import type { DayReplanRequest, DayReplanResponse } from '../lib/dayReplan'
import type { DayReplanConstraintsOptions } from '../lib/planningConstraintsApi'
import { createWorkspaceRecord, emptySidecar } from '../lib/workspace'
import { createEmptyPoiCardsRecord, createPoiCard, type PoiCardsRecordV1 } from '../lib/poiCards'
import type {
  CandidateItemV1,
  ConstraintItemV1,
  WorkspaceRecordV1,
} from '../lib/workspaceTypes'

/* ───────── 本地夹具（不读 storage / 不连后端） ───────── */

const NOW = 1_760_000_000_000
let sequence = 0

function location(lng: number, lat: number) {
  return { lng, lat }
}

function stop(
  id: string,
  name: string,
  time: string,
  duration_minutes: number | null = 60,
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes,
    description: `${name}的描述`,
    address: `${name}的地址`,
    location: location(121.47, 31.23),
  }
}

function leg(from: string, to: string): TripLeg {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 500,
    duration_minutes: 30,
    geometry: [location(121.47, 31.23), location(121.48, 31.24)],
    description: '测试路线',
  }
}

function day(dayNumber: number, date: string | null, stops: TripStop[], legs: TripLeg[] = []): TripDay {
  return { day: dayNumber, date, title: `第${dayNumber}天`, summary: '', stops, legs }
}

function baseTrip(): Trip {
  return {
    id: 'trip-1',
    source: 'agent',
    destination: '上海',
    title: '测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [
      day(
        1,
        '2026-04-03',
        [stop('s-silk', '丝绸店', '09:00', 60), stop('s-museum', '博物馆', '14:30', 30)],
        [leg('s-silk', 's-museum')],
      ),
      day(2, '2026-04-04', [stop('s-westlake', '西湖', '10:00', 90)]),
    ],
  }
}

function constraintItem(overrides: Partial<ConstraintItemV1>): ConstraintItemV1 {
  return {
    id: 'c1',
    kind: 'must_visit',
    day: 1,
    stopId: null,
    title: '丝绸店',
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    notes: null,
    priority: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeRecord(
  tripValue: Trip = baseTrip(),
  constraints: ConstraintItemV1[] = [],
): WorkspaceRecordV1 {
  const result = createWorkspaceRecord({
    workspaceId: 'ws-1',
    ownerId: 'owner-1',
    trip: tripValue,
    workspaceRevision: 1,
    now: 1_000,
    sidecar: { ...emptySidecar(), constraints: { items: constraints } },
  })
  if (!result.ok) throw new Error(`工作区记录不合法：${result.message}`)
  return result.value
}

function candidate(name: string): CandidateItemV1 {
  sequence += 1
  return {
    id: `c-${sequence}`,
    name,
    address: `${name}的地址`,
    notes: null,
    tags: [],
    priority: 1,
    location: location(120.1, 30.2),
    source: 'manual',
    copiedFromStopId: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function replanResponse(request: DayReplanRequest): DayReplanResponse {
  return {
    day: {
      day: request.day,
      date: request.date,
      title: '重排后的这一天',
      summary: '候选摘要。',
      stops: [
        {
          id: 'ai-1',
          name: '丝绸店',
          time: '10:00',
          duration_minutes: 90,
          description: '多留一会儿。',
          address: '丝绸店的地址',
          location: location(121.47, 31.23),
        },
      ],
      legs: [],
    },
    warnings: [],
    map_status: 'ready',
    parent: { ...request.parent },
    source: 'agent',
  }
}

/* ───────── 受控 harness ───────── */

interface HarnessProps {
  trip?: Trip
  /** 工作区记录；null = 面板走「未关联工作区」的内存记录路径。 */
  record?: WorkspaceRecordV1 | null
  candidates?: CandidateItemV1[]
  currentDay?: number | null
  travelMode?: TravelMode
  requestDay?: DayReplanAdapter
  onReplanApply?: (request: DayReplanRequest, response: DayReplanResponse) => { ok: boolean; message?: string }
  planningConstraints?: (request: DayReplanRequest) => DayReplanConstraintsOptions | undefined
  poiCards?: PoiCardsRecordV1 | null
}

function Harness({
  trip: initialTrip = baseTrip(),
  record: initialRecord = null,
  candidates = [],
  currentDay = 1,
  travelMode = 'walking',
  requestDay,
  onReplanApply,
  planningConstraints,
  poiCards,
}: HarnessProps) {
  const [trip, setTrip] = useState<Trip>(initialTrip)
  const [record, setRecord] = useState<WorkspaceRecordV1 | null>(initialRecord)
  const [revision, setRevision] = useState<number>(initialRecord?.workspaceRevision ?? 1)
  /** 「在别处改动行程」按钮：模拟行程在面板之外被改掉。 */
  const [bumped, setBumped] = useState(false)
  /** 「同版本内容变化」按钮：revision 不变、只有内容变了（ABA 的另一半）。 */
  const [sameRevisionChanged, setSameRevisionChanged] = useState(false)

  const effectiveTrip = bumped
    ? { ...trip, title: `${trip.title}（别处改过）` }
    : sameRevisionChanged
      ? { ...trip, title: `${trip.title}（同版本改过）` }
      : trip

  return (
    <div>
      <p data-testid="harness-stops">
        {effectiveTrip.days.flatMap((day) => day.stops.map((item) => item.name)).join('、')}
      </p>
      <p data-testid="harness-day1">
        {effectiveTrip.days.find((day) => day.day === 1)?.stops.map((item) => item.name).join('、')}
      </p>
      <p data-testid="harness-day2">
        {effectiveTrip.days.find((day) => day.day === 2)?.stops.map((item) => item.name).join('、')}
      </p>
      <p data-testid="harness-revision">{revision}</p>
      <button
        type="button"
        onClick={() => {
          setBumped(true)
          setTrip((current) => ({ ...current, title: `${current.title}（别处改过）` }))
          if (record !== null) {
            setRecord((current) =>
              current === null
                ? null
                : { ...current, trip: { ...current.trip, title: `${current.trip.title}（别处改过）` } },
            )
          }
          setRevision((current) => current + 1)
        }}
      >
        模拟别处改动
      </button>
      <button
        type="button"
        onClick={() => {
          // revision 不变：只有内容变了 —— ABA 的另一半（指纹不一致）
          setSameRevisionChanged(true)
          setTrip((current) => ({ ...current, title: `${current.title}（同版本改过）` }))
          if (record !== null) {
            setRecord((current) =>
              current === null
                ? null
                : { ...current, trip: { ...current.trip, title: `${current.trip.title}（同版本改过）` } },
            )
          }
        }}
      >
        模拟同版本内容变化
      </button>
      <AssistantDialogPanel
        trip={effectiveTrip}
        record={record}
        candidates={candidates}
        currentDay={currentDay}
        travelMode={travelMode}
        revision={revision}
        createLogicalId={() => `panel-id-${++sequence}`}
        onApplyRecord={(next) => {
          setTrip(next.trip)
          if (initialRecord !== null) setRecord(next)
          setRevision(next.workspaceRevision)
          return { ok: true }
        }}
        requestDay={requestDay}
        onReplanApply={onReplanApply}
        planningConstraints={planningConstraints}
        onClose={() => {}}
        poiCards={poiCards}
        now={() => NOW}
      />
    </div>
  )
}

async function generate(user: ReturnType<typeof userEvent.setup>, instruction: string) {
  await user.clear(screen.getByLabelText(/想怎么改/))
  await user.type(screen.getByLabelText(/想怎么改/), instruction)
  await user.click(screen.getByRole('button', { name: '生成建议' }))
}

function panel() {
  return screen.getByRole('region', { name: 'AI 行程助手' })
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/* ───────── 渲染与提案卡 ───────── */

describe('AI 行程助手 · 提案卡渲染', () => {
  it('输入指令后给出意图类别、改动清单、理由与未核实提示', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(within(panel()).getByRole('button', { name: '生成建议' })).toBeDisabled()

    await generate(user, '去掉第 1 天的丝绸店')

    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText('删除站点')).toBeInTheDocument()
    expect(within(card).getByText(/删掉第 1 天的「丝绸店」/)).toBeInTheDocument()
    expect(within(card).getByText(ASSISTANT_UNVERIFIED_NOTICE)).toBeInTheDocument()
    // 已知 / 未知分列
    expect(within(card).getByText('已确定的改动')).toBeInTheDocument()
    expect(within(card).getByText('还不确定的改动')).toBeInTheDocument()
    // 没有未确定的改动时明说没有
    expect(within(card).getByText('没有不确定的改动。')).toBeInTheDocument()
  })

  it('找不到的站点列为未知改动，显示「未知」，不补 0', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await generate(user, '把不存在的景点挪到第 2 天下午')

    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText('没有已确定的改动。')).toBeInTheDocument()
    expect(within(card).getByText(ASSISTANT_UNKNOWN_TEXT)).toBeInTheDocument()
    expect(
      within(card).getAllByText(/当前行程里没有找到「不存在的景点」/).length,
    ).toBeGreaterThan(0)
    // 未知项绝不显示 0 分钟 / 00:00
    expect(card.textContent).not.toContain('00:00')
  })

  it('超出五类的指令礼貌拒绝，不可应用', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await generate(user, '帮我订一张明天去上海的机票')

    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText('暂不支持这类操作')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '应用建议' })).toBeDisabled()
  })

  it('从收藏池加入站点：候选坐标留在候选库，占位时刻标注未核实', async () => {
    const user = userEvent.setup()
    render(<Harness candidates={[candidate('西湖')]} />)
    await generate(user, '把收藏池里的西湖加到第 2 天晚上')

    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText('从收藏池加入站点')).toBeInTheDocument()
    expect(within(card).getByText(/新增「西湖」到第 2 天/)).toBeInTheDocument()
    // 时段占位时刻只是计划值：必须标注来源
    expect(within(card).getByText(ASSISTANT_SLOT_TIME_NOTICE)).toBeInTheDocument()
    // 候选坐标留在候选库
    expect(within(card).getByText(ASSISTANT_POOL_LOCATION_NOTICE)).toBeInTheDocument()
  })

  it('挪动站点：已知改动列出原天与目标天，未知项不补 0', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await generate(user, '把博物馆挪到第 2 天下午')

    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText('挪动站点')).toBeInTheDocument()
    expect(within(card).getAllByText(/把「博物馆」从第 1 天挪到第 2 天/).length).toBeGreaterThan(0)
    // 未知项绝不显示 0 分钟 / 00:00
    expect(card.textContent).not.toContain('00:00')
  })
})

/* ───────── 五类指令的 UI 全链路 ───────── */

describe('AI 行程助手 · 五类指令 UI 链路', () => {
  it('挪动站点：输入 → 提案 → 应用 → 生效 → 撤销', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.getByTestId('harness-day1')).toHaveTextContent('丝绸店、博物馆')

    await generate(user, '把博物馆挪到第 2 天下午')
    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText('挪动站点')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '应用建议' }))

    // 生效：博物馆从第 1 天挪到第 2 天
    await waitFor(() => expect(screen.getByTestId('harness-day1')).toHaveTextContent('丝绸店'))
    expect(screen.getByTestId('harness-day1')).not.toHaveTextContent('博物馆')
    expect(screen.getByTestId('harness-day2')).toHaveTextContent('博物馆')
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('2')

    // 撤销：回到原样，版本继续 +1
    await user.click(within(panel()).getByRole('button', { name: '撤销这条建议' }))
    await waitFor(() => expect(screen.getByTestId('harness-day1')).toHaveTextContent('丝绸店、博物馆'))
    expect(screen.getByTestId('harness-day2')).not.toHaveTextContent('博物馆')
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('3')
  })

  it('从收藏池加入站点：输入 → 提案 → 应用 → 生效 → 撤销', async () => {
    const user = userEvent.setup()
    render(<Harness candidates={[candidate('灵隐寺')]} />)

    await generate(user, '把收藏池里的灵隐寺加到第 2 天晚上')
    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText('从收藏池加入站点')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '应用建议' }))

    // 生效：新增站点进了第 2 天
    await waitFor(() => expect(screen.getByTestId('harness-day2')).toHaveTextContent('灵隐寺'))
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('2')

    await user.click(within(panel()).getByRole('button', { name: '撤销这条建议' }))
    await waitFor(() => expect(screen.getByTestId('harness-day2')).not.toHaveTextContent('灵隐寺'))
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('3')
  })

  it('节奏调整：输入 → 提案 → 走既有重排通道 → 应用候选 → 生效', async () => {
    const requests: DayReplanRequest[] = []
    const requestDay: DayReplanAdapter = async (request) => {
      requests.push(request)
      return replanResponse(request)
    }
    const onReplanApply = vi.fn(() => ({ ok: true }))
    const user = userEvent.setup()
    render(<Harness requestDay={requestDay} onReplanApply={onReplanApply} />)

    await generate(user, '第 1 天松一点')
    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText('节奏调整（交给单日重排）')).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: '应用建议' }))
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].day).toBe(1)

    await user.click(await screen.findByRole('button', { name: '应用重排候选' }))
    expect(onReplanApply).toHaveBeenCalledTimes(1)
  })
})

/* ───────── 硬门 ───────── */

describe('AI 行程助手 · 硬门', () => {
  it('H 级冲突：显示冲突并禁用应用，没有任何确认绕过入口', async () => {
    const user = userEvent.setup()
    const record = makeRecord(baseTrip(), [constraintItem({ kind: 'must_visit', day: 1, title: '丝绸店' })])
    render(<Harness record={record} />)
    await generate(user, '去掉第 1 天的丝绸店')

    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText(/冲突（/)).toBeInTheDocument()
    expect(within(card).getByText(/必去目标缺失/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '应用建议' })).toBeDisabled()
    // H 级没有 U 级确认入口
    expect(within(card).queryByLabelText('仍采用含未核实时间方案')).toBeNull()
  })

  it('U 级：必须单独勾选确认才能应用；勾选后行程一变就失效', async () => {
    const user = userEvent.setup()
    const record = makeRecord(baseTrip(), [
      constraintItem({
        kind: 'fixed_window',
        day: 1,
        stopId: 's-silk',
        title: '丝绸店',
        startDate: '2026-04-03',
        endDate: '2026-04-03',
        startTime: '08:00',
        endTime: '12:00',
      }),
    ])
    render(<Harness record={record} />)
    await generate(user, '把博物馆挪到第 2 天下午')

    const card = within(panel()).getByLabelText('建议卡片')
    const ack = within(card).getByLabelText('仍采用含未核实时间方案') as HTMLInputElement
    expect(ack.checked).toBe(false)
    // 没有确认就不能应用
    expect(within(card).getByRole('button', { name: '应用建议' })).toBeDisabled()

    await user.click(ack)
    expect((within(card).getByLabelText('仍采用含未核实时间方案') as HTMLInputElement).checked).toBe(true)
    expect(within(card).getByRole('button', { name: '应用建议' })).toBeEnabled()

    // 行程在别处变了：确认绑定的是旧快照，提案立刻失效
    await user.click(screen.getByRole('button', { name: '模拟别处改动' }))
    await waitFor(() => expect(within(panel()).getByText(/提案已失效，请重新生成/)).toBeInTheDocument())
    expect(within(panel()).getByRole('button', { name: '应用建议' })).toBeDisabled()
  })
})

/* ───────── 应用 / 撤销 / 不采纳 ───────── */

describe('AI 行程助手 · 应用与撤销', () => {
  it('应用后行程生效、版本 +1，并可撤销回原样', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.getByTestId('harness-stops')).toHaveTextContent('丝绸店、博物馆')
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('1')

    await generate(user, '去掉第 1 天的丝绸店')
    await user.click(within(panel()).getByRole('button', { name: '应用建议' }))

    await waitFor(() => expect(screen.getByTestId('harness-stops')).toHaveTextContent('博物馆'))
    expect(screen.getByTestId('harness-stops')).not.toHaveTextContent('丝绸店')
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('2')
    expect(within(panel()).getByText('已应用')).toBeInTheDocument()

    await user.click(within(panel()).getByRole('button', { name: '撤销这条建议' }))
    await waitFor(() => expect(screen.getByTestId('harness-stops')).toHaveTextContent('丝绸店、博物馆'))
    // 撤销也是一次 transition：版本继续 +1，不回放旧版本
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('3')
  })

  it('不采纳：零写入、零存储副作用、行程不动', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem')
    const user = userEvent.setup()
    render(<Harness />)

    await generate(user, '去掉第 1 天的丝绸店')
    await user.click(within(panel()).getByRole('button', { name: '不采纳' }))

    expect(within(panel()).getByText('已放弃')).toBeInTheDocument()
    expect(screen.getByTestId('harness-stops')).toHaveTextContent('丝绸店、博物馆')
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('1')
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })

  it('在途提案遇到行程变更：显示失效提示，绝不套用旧提案', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await generate(user, '去掉第 1 天的丝绸店')
    expect(within(panel()).getByRole('button', { name: '应用建议' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '模拟别处改动' }))
    await waitFor(() => expect(within(panel()).getByText(/提案已失效，请重新生成/)).toBeInTheDocument())
    expect(within(panel()).getByRole('button', { name: '应用建议' })).toBeDisabled()
    expect(screen.getByTestId('harness-stops')).toHaveTextContent('丝绸店、博物馆')
  })

  it('提案失效后可以「重新生成」：按同一条指令对新行程重算一张新提案', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await generate(user, '去掉第 1 天的丝绸店')

    await user.click(screen.getByRole('button', { name: '模拟别处改动' }))
    await waitFor(() => expect(within(panel()).getByRole('button', { name: '重新生成' })).toBeInTheDocument())

    await user.click(within(panel()).getByRole('button', { name: '重新生成' }))
    await waitFor(() => expect(within(panel()).getByRole('button', { name: '应用建议' })).toBeEnabled())
    // 新提案按新行程重算：丝绸店还在，就不再报「找不到」
    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getAllByText(/删掉第 1 天的「丝绸店」/).length).toBeGreaterThan(0)
  })

  it('ABA 的另一半：版本没变、只有内容变了 → 指纹不一致，旧提案同样作废', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await generate(user, '去掉第 1 天的丝绸店')
    expect(within(panel()).getByRole('button', { name: '应用建议' })).toBeEnabled()

    // 版本号不动，只有行程内容变了：revision 对得上，指纹对不上
    await user.click(screen.getByRole('button', { name: '模拟同版本内容变化' }))
    await waitFor(() => expect(within(panel()).getByText(/提案已失效，请重新生成/)).toBeInTheDocument())
    expect(within(panel()).getByRole('button', { name: '应用建议' })).toBeDisabled()
    expect(screen.getByTestId('harness-stops')).toHaveTextContent('丝绸店、博物馆')
  })
})

/* ───────── 只保留一条待确认提案 ───────── */

describe('AI 行程助手 · 一次只保留一条待确认提案', () => {
  it('已有待确认提案时提交新指令：先问要不要替换，旧提案零写入丢弃', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const user = userEvent.setup()
    render(<Harness />)

    await generate(user, '去掉第 1 天的丝绸店')
    const firstCard = within(panel()).getByLabelText('建议卡片')
    expect(within(firstCard).getByText(/删掉第 1 天的「丝绸店」/)).toBeInTheDocument()

    // 直接提交新指令 → 出现替换确认，旧提案还在（还没被丢弃）
    await generate(user, '去掉第 1 天的博物馆')
    expect(within(panel()).getByRole('region', { name: /替换/ })).toBeInTheDocument()
    expect(within(panel()).getByText(/已有一条待确认的提案/)).toBeInTheDocument()
    expect(within(firstCard).getByText(/删掉第 1 天的「丝绸店」/)).toBeInTheDocument()

    // 确认替换：换成新指令的提案，旧提案被丢弃（零写入）
    await user.click(within(panel()).getByRole('button', { name: '替换并生成' }))
    await waitFor(() =>
      expect(
        within(within(panel()).getByLabelText('建议卡片')).getByText(/删掉第 1 天的「博物馆」/),
      ).toBeInTheDocument(),
    )
    expect(
      within(within(panel()).getByLabelText('建议卡片')).queryByText(/删掉第 1 天的「丝绸店」/),
    ).toBeNull()
    expect(setItem).not.toHaveBeenCalled()
    // 行程没动
    expect(screen.getByTestId('harness-stops')).toHaveTextContent('丝绸店、博物馆')
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('1')
  })

  it('取消替换：旧提案原样保留，新指令留在输入框里', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await generate(user, '去掉第 1 天的丝绸店')
    await generate(user, '去掉第 1 天的博物馆')
    await user.click(within(panel()).getByRole('button', { name: '保留原提案' }))

    expect(within(panel()).queryByRole('region', { name: /替换/ })).toBeNull()
    expect(
      within(within(panel()).getByLabelText('建议卡片')).getByText(/删掉第 1 天的「丝绸店」/),
    ).toBeInTheDocument()
    expect(screen.getByTestId('harness-stops')).toHaveTextContent('丝绸店、博物馆')
  })
})

/* ───────── 重排通道与失败保旧 ───────── */

describe('AI 行程助手 · 重排通道', () => {
  it('时间偏好类指令走既有 replanDay 通道，并附上 planningConstraints', async () => {
    const calls: Array<{ request: DayReplanRequest; hadConstraints: boolean }> = []
    const requestDay: DayReplanAdapter = async (request, options) => {
      calls.push({ request, hadConstraints: options?.planningConstraints !== undefined })
      return replanResponse(request)
    }
    const onReplanApply = vi.fn(() => ({ ok: true }))
    const user = userEvent.setup()
    render(
      <Harness
        requestDay={requestDay}
        onReplanApply={onReplanApply}
        planningConstraints={() => ({}) as DayReplanConstraintsOptions}
      />,
    )

    await generate(user, '第 1 天停留久一点')
    const card = within(panel()).getByLabelText('建议卡片')
    expect(within(card).getByText('时间偏好（交给单日重排）')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '应用建议' })).toBeEnabled()

    await user.click(within(card).getByRole('button', { name: '应用建议' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].request.day).toBe(1)
    expect(calls[0].hadConstraints).toBe(true)

    await user.click(await screen.findByRole('button', { name: '应用重排候选' }))
    expect(onReplanApply).toHaveBeenCalledTimes(1)
  })

  it('重排请求失败：旧数据不变，错误写进面板', async () => {
    const requestDay: DayReplanAdapter = async () => {
      throw new Error('后端不可用')
    }
    const user = userEvent.setup()
    render(<Harness requestDay={requestDay} />)

    await generate(user, '第 1 天停留久一点')
    await user.click(within(panel()).getByRole('button', { name: '应用建议' }))

    await waitFor(() => expect(within(panel()).getByRole('alert')).toBeInTheDocument())
    expect(within(panel()).getByRole('alert').textContent).toContain('当前行程保持不变')
    expect(screen.getByTestId('harness-stops')).toHaveTextContent('丝绸店、博物馆')
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('1')
  })

  it('ABA：版本没变、只有内容变了 → 重排候选作废，按钮禁用且处理器拒绝', async () => {
    const requests: DayReplanRequest[] = []
    const requestDay: DayReplanAdapter = async (request) => {
      requests.push(request)
      return replanResponse(request)
    }
    const onReplanApply = vi.fn(() => ({ ok: true }))
    const user = userEvent.setup()
    render(<Harness requestDay={requestDay} onReplanApply={onReplanApply} />)

    await generate(user, '第 1 天停留久一点')
    await user.click(within(panel()).getByRole('button', { name: '应用建议' }))
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(await screen.findByRole('button', { name: '应用重排候选' })).toBeEnabled()

    // 版本没变、只有内容变了（ABA 的另一半）：底层单日重排只比版本，认不出来，
    // 助手层必须自己把内容指纹也比上。
    await user.click(screen.getByRole('button', { name: '模拟同版本内容变化' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '应用重排候选' })).toBeDisabled(),
    )
    expect(within(panel()).getByText(/这条重排候选已经失效/)).toBeInTheDocument()

    // 处理器不会被调用：旧候选既没有被套用，也没有落到行程上
    await user.click(screen.getByRole('button', { name: '应用重排候选' }))
    expect(onReplanApply).not.toHaveBeenCalled()
    expect(screen.getByTestId('harness-stops')).toHaveTextContent('丝绸店、博物馆')
    expect(screen.getByTestId('harness-revision')).toHaveTextContent('1')
  })
})

/* ───────── 候选失效判定（按钮禁用与处理器拒绝共用同一口径） ───────── */

describe('AI 行程助手 · 重排候选失效判定', () => {
  const base: ReplanCandidateBase = {
    revision: 7,
    fingerprint: { canonical: '{"trip":"a"}', short: '0123abcd' },
  }
  const same = { revision: 7, fingerprint: base.fingerprint }
  const other = {
    revision: 7,
    fingerprint: { canonical: '{"trip":"b"}', short: '89abcdef' },
  }

  it('版本一致、内容一致 → 候选仍然有效', () => {
    expect(replanCandidateIsStale(base, same)).toBe(false)
  })

  it('版本漂移 → 候选作废', () => {
    expect(replanCandidateIsStale(base, { ...same, revision: 8 })).toBe(true)
  })

  it('ABA：版本没变、只有内容变了 → 候选作废', () => {
    expect(replanCandidateIsStale(base, { revision: 7, fingerprint: other.fingerprint })).toBe(true)
  })

  it('取不到当前快照 → 一律按已变化处理（fail closed）', () => {
    expect(replanCandidateIsStale(base, { revision: null, fingerprint: same.fingerprint })).toBe(true)
    expect(replanCandidateIsStale(base, { revision: 7, fingerprint: null })).toBe(true)
  })
})

describe('AI 行程助手 · 资料卡只读徽标（三期 S2）', () => {
  function makePoiCardsFor(name: string): PoiCardsRecordV1 {
    const emptyResult = createEmptyPoiCardsRecord(NOW)
    if (!emptyResult.ok) throw new Error(emptyResult.message)
    const card = createPoiCard({ id: 'card-adp-1', name, intro: '助手卡。' }, NOW)
    if (!card.ok) throw new Error(card.message)
    return { ...emptyResult.value, cards: [card.value] }
  }

  it('提案目标名命中资料卡时显示「有资料卡」只读徽标，不改提案内容', async () => {
    const user = userEvent.setup()
    render(<Harness poiCards={makePoiCardsFor('丝绸店')} />)
    await generate(user, '去掉第 1 天的丝绸店')
    const card = within(panel()).getByLabelText('建议卡片')
    const badge = within(card).getByTestId('assistant-poi-card-badge')
    expect(badge).toHaveTextContent('有资料卡')
    expect(badge).toHaveTextContent(/按名称匹配/)
    // 徽标不把资料卡内容带进提案
    expect(within(card).queryByText('助手卡。')).toBeNull()
  })

  it('未命中时不显示徽标，提案卡渲染不受影响', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await generate(user, '去掉第 1 天的丝绸店')
    expect(screen.queryByTestId('assistant-poi-card-badge')).toBeNull()
    expect(within(panel()).getByLabelText('建议卡片')).toBeInTheDocument()
  })
})

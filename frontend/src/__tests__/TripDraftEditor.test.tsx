/**
 * TripDraftEditor 的用户路径测试：受控 harness + 真实的 tripDraft 纯函数。
 *
 * 不 mock tripDraft 模块：地址编辑是否清坐标、时间编辑是否保留 geometry、
 * 应用是否生成 fork 副本、容量拒绝是否阻止 onApply，都由真实函数的结果验证。
 * 只替换 fetch / 存储写入并断言它们没有被自动调用。
 */
import { useRef, useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Trip, TripDay, TripStop, TravelMode } from '../lib/api'
import { MAX_SAVED_TRIP_BYTES, savedTripRecordBytes } from '../lib/savedTrips'
import { parseDailyEndTimeLimit } from '../lib/draftEndTime'
import {
  applyDraft,
  createTripDraft,
  isDraftDirty,
  updateDraftStop,
  type DraftApplySuccess,
  type DraftEditResult,
  type TripDraft,
} from '../lib/tripDraft'
import TripDraftEditor from '../components/TripDraftEditor'
import { MOCK_TRIP } from './fixtures/trip'

function cloneTrip(): Trip {
  return JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
}

function makeDraft(base: Trip = cloneTrip(), forkTripId = 'trip-fork-editor'): TripDraft {
  const created = createTripDraft(base, { forkTripId, newLegMode: 'walking' })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

function asDraft(result: DraftEditResult): TripDraft {
  if (!result.ok) throw new Error(result.message)
  return result.draft
}

function dayOf(draft: TripDraft, dayNumber: number): TripDay {
  const day = draft.days.find((item) => item.day === dayNumber)
  if (!day) throw new Error(`草稿里没有第 ${dayNumber} 天`)
  return day
}

function stopOf(draft: TripDraft, dayNumber: number, stopId: string): TripStop {
  const stop = dayOf(draft, dayNumber).stops.find((item) => item.id === stopId)
  if (!stop) throw new Error(`草稿里没有站点 ${stopId}`)
  return stop
}

interface HarnessProps {
  initialDraft: TripDraft
  initialDay?: number
  latestRef?: { current: TripDraft | null }
  onCreateStopId?: () => string
  onApplySpy?: (result: DraftApplySuccess) => void
  onChangeSpy?: (next: TripDraft) => void
}

/**
 * 受控父视图的最小实现：自己持有草稿 / 当前天 / 选中站点 / 回调状态，
 * 并在卡片外提供「外部更新草稿」「外部换 fork」「外部切换天」按钮，
 * 用来验证编辑会话遇到父视图变化时的行为。
 */
function Harness({
  initialDraft,
  initialDay = 1,
  latestRef,
  onCreateStopId,
  onApplySpy,
  onChangeSpy,
}: HarnessProps) {
  const [draft, setDraft] = useState(initialDraft)
  const [dayNumber, setDayNumber] = useState(initialDay)
  const [applied, setApplied] = useState<DraftApplySuccess | null>(null)
  const [discardCount, setDiscardCount] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [inputDirty, setInputDirty] = useState(false)
  const [editing, setEditing] = useState(false)
  const idCounter = useRef(0)

  if (latestRef) latestRef.current = draft

  const createStopId =
    onCreateStopId ??
    (() => {
      idCounter.current += 1
      return `new-stop-${idCounter.current}`
    })

  const handleDraftChange = (next: TripDraft) => {
    setDraft(next)
    onChangeSpy?.(next)
  }

  const handleDiscard = () => {
    setDiscardCount((count) => count + 1)
    const fresh = createTripDraft(initialDraft.base, {
      forkTripId: initialDraft.forkTripId,
      newLegMode: initialDraft.newLegMode,
    })
    if (fresh.ok) setDraft(fresh.draft)
  }

  const externalUpdate = () => {
    setDraft(asDraft(updateDraftStop(draft, 1, 's2', { description: '外部更新后的描述' })))
  }

  const externalFork = () => {
    setDraft(makeDraft(draft.base, 'trip-fork-other'))
  }

  return (
    <div>
      <div>
        <button type="button" onClick={() => setDayNumber(1)}>
          外部切换到第 1 天
        </button>
        <button type="button" onClick={() => setDayNumber(2)}>
          外部切换到第 2 天
        </button>
        <button type="button" onClick={externalUpdate}>
          外部更新草稿
        </button>
        <button type="button" onClick={externalFork}>
          外部换 fork 草稿
        </button>
      </div>
      <TripDraftEditor
        draft={draft}
        dayNumber={dayNumber}
        onDraftChange={handleDraftChange}
        onApply={(result) => {
          setApplied(result)
          onApplySpy?.(result)
        }}
        onDiscard={handleDiscard}
        createStopId={createStopId}
        onInputDirtyChange={setInputDirty}
        onEditingChange={setEditing}
        onSelectStop={(stopId) => setSelected((current) => [...current, stopId])}
      />
      <output data-testid="draft-revision">{draft.revision}</output>
      <output data-testid="dirty">{String(isDraftDirty(draft))}</output>
      <output data-testid="applied">{applied ? applied.trip.id : ''}</output>
      <output data-testid="discard-count">{discardCount}</output>
      <output data-testid="selected">{selected.join(',')}</output>
      <output data-testid="input-dirty">{String(inputDirty)}</output>
      <output data-testid="editing">{String(editing)}</output>
    </div>
  )
}

function editorRegion(): HTMLElement {
  return screen.getByRole('region', { name: '本地行程草稿编辑器' })
}

async function openEdit(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
): Promise<HTMLElement> {
  await user.click(within(editorRegion()).getByRole('button', { name: label }))
  return editorRegion()
}

function firstAlert(container: HTMLElement): HTMLElement {
  return within(container).getByRole('alert')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TripDraftEditor 展示与边界', () => {
  it('显示所编辑行程 / 天 / 内存草稿边界，无变化时禁用应用和撤销', () => {
    const draft = makeDraft()
    render(<Harness initialDraft={draft} />)
    const editor = editorRegion()

    expect(
      within(editor).getByRole('heading', { name: '杭州三日漫步路书' }),
    ).toBeInTheDocument()
    expect(within(editor).getByText('示例参考')).toBeInTheDocument()
    expect(within(editor).getByText('第 1 天')).toBeInTheDocument()
    expect(within(editor).getByText('2026-04-03')).toBeInTheDocument()
    expect(within(editor).getByText(/本地行程编辑 · 内存草稿/)).toBeInTheDocument()
    expect(within(editor).getByText(/不会自动保存到浏览器/)).toBeInTheDocument()
    expect(within(editor).getByText(/草稿与原始行程一致/)).toBeInTheDocument()

    expect(within(editor).getByRole('button', { name: '应用草稿' })).toBeDisabled()
    expect(within(editor).getByRole('button', { name: '撤销草稿操作' })).toBeDisabled()
    expect(within(editor).getByRole('button', { name: '放弃草稿' })).toBeEnabled()
    expect(within(editor).getByText(/应用后会生成新的行程副本/)).toBeInTheDocument()
    expect(within(editor).getByText(/不会被更新或删除/)).toBeInTheDocument()
  })

  it('点了站点名称时通知父视图做地图联动', async () => {
    const user = userEvent.setup()
    render(<Harness initialDraft={makeDraft()} />)
    const editor = editorRegion()

    await user.click(
      within(editor).getByRole('button', { name: '在地图中查看第 1 站「断桥残雪」' }),
    )
    expect(screen.getByTestId('selected')).toHaveTextContent('s1')
  })
})

describe('TripDraftEditor 单站编辑', () => {
  it('改地址保存后调用草稿，坐标清空且相关路段变为待重新获取', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const latest: { current: TripDraft | null } = { current: null }
    const onChangeSpy = vi.fn()
    render(
      <Harness initialDraft={draft} latestRef={latest} onChangeSpy={onChangeSpy} />,
    )
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')

    const address = within(editor).getByLabelText('地址')
    await user.clear(address)
    await user.type(address, '杭州市北山街 1 号')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    expect(onChangeSpy).toHaveBeenCalledTimes(1)
    const next = latest.current
    expect(next).not.toBeNull()
    const stop = stopOf(next as TripDraft, 1, 's1')
    expect(stop.address).toBe('杭州市北山街 1 号')
    expect(stop.location).toBeNull()
    const legs = dayOf(next as TripDraft, 1).legs
    expect(legs).toHaveLength(2)
    // 只有涉及被改站点的路段失效；s2 → s3 两端身份与坐标都没变，原样保留
    expect(legs[0].route_type).toBe('unavailable')
    expect(legs[0].geometry).toEqual([])
    expect(legs[0].distance_m).toBeNull()
    expect(legs[0].duration_minutes).toBeNull()
    expect(legs[1]).toMatchObject({
      route_type: 'straight_line',
      distance_m: 1800,
      description: '示意直线，仅表示方位。',
    })

    expect(within(editor).getByRole('button', { name: '应用草稿' })).toBeEnabled()
    expect(within(editor).getAllByText('缺坐标').length).toBeGreaterThanOrEqual(1)
    expect(within(editor).getAllByText(/待重新获取路线/).length).toBeGreaterThan(0)
    // 旧提醒属于编辑前参考，和当前本地检查分开显示
    expect(within(editor).getByText(/编辑前行程提醒/)).toBeInTheDocument()
    expect(within(editor).getByText(/示例数据仅用于演示界面/)).toBeInTheDocument()
  })

  it('改时间 / 停留只更新计划值，保留坐标与已取到的路线 geometry', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const latest: { current: TripDraft | null } = { current: null }
    render(<Harness initialDraft={draft} latestRef={latest} />)
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const geometryBefore = dayOf(draft, 1).legs[0].geometry.length

    const time = within(editor).getByLabelText(/^时间/)
    const duration = within(editor).getByLabelText(/停留时长（分钟）/)
    await user.clear(time)
    await user.type(time, '09:30')
    await user.clear(duration)
    await user.type(duration, '10')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    const next = latest.current as TripDraft
    const stop = stopOf(next, 1, 's1')
    expect(stop.time).toBe('09:30')
    expect(stop.duration_minutes).toBe(10)
    const day = dayOf(next, 1)
    expect(day.legs[0].route_type).toBe('navigation')
    expect(day.legs[0].distance_m).toBe(1100)
    expect(day.legs[0].geometry).toHaveLength(geometryBefore)
    // 时间 / 停留编辑不会被误报成「路线需要重新获取」；s3 原本就缺坐标，仍如实显示
    expect(within(editor).queryByText('路线待重取')).toBeNull()
    expect(within(editor).queryByText('时间倒序')).toBeNull()
  })

  it('输入缓冲允许先清空再重输；非法值不调用草稿、保留输入并关联错误', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const latest: { current: TripDraft | null } = { current: null }
    const onChangeSpy = vi.fn()
    render(
      <Harness initialDraft={draft} latestRef={latest} onChangeSpy={onChangeSpy} />,
    )
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const name = within(editor).getByLabelText(/站点名称/)
    const time = within(editor).getByLabelText(/^时间/)

    await user.clear(name)
    expect(name).toHaveValue('')
    expect(within(editor).queryByText(/站点名称不能为空/)).toBeNull()
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('0')
    await user.type(name, '断桥新')

    await user.clear(time)
    await user.type(time, '9:00')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    expect(onChangeSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('0')
    expect(time).toHaveValue('9:00')
    expect(time).toHaveAttribute('aria-invalid', 'true')
    const describedBy = time.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)).toHaveTextContent(/24 小时制/)
    expect(firstAlert(editor)).toHaveTextContent(/未通过校验/)
    expect(within(editor).getByLabelText(/站点名称/)).toHaveValue('断桥新')

    // 修正后用键盘 Enter 提交，仍然走真实更新函数
    await user.clear(time)
    await user.type(time, '09:15{Enter}')
    expect(onChangeSpy).toHaveBeenCalledTimes(1)
    const saved = stopOf(latest.current as TripDraft, 1, 's1')
    expect(saved.time).toBe('09:15')
    expect(saved.name).toBe('断桥新')
  })

  it('旧导入的宽字段原样显示，只改时间不会被二次校验或截断', async () => {
    const user = userEvent.setup()
    const base = cloneTrip()
    const longName = '长'.repeat(300)
    base.days[0].stops[0].name = longName
    const draft = makeDraft(base)
    const latest: { current: TripDraft | null } = { current: null }
    const onChangeSpy = vi.fn()
    render(
      <Harness initialDraft={draft} latestRef={latest} onChangeSpy={onChangeSpy} />,
    )
    const editor = await openEdit(user, `编辑第 1 站「${longName}」`)
    const name = within(editor).getByLabelText(/站点名称/)
    expect(name).toHaveValue(longName)
    expect(name).not.toHaveAttribute('maxlength')

    const time = within(editor).getByLabelText(/^时间/)
    await user.clear(time)
    await user.type(time, '09:20')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    expect(onChangeSpy).toHaveBeenCalledTimes(1)
    const saved = stopOf(latest.current as TripDraft, 1, 's1')
    expect(saved.time).toBe('09:20')
    expect(saved.name).toBe(longName)
  })
})

describe('TripDraftEditor 增删、重排与撤销', () => {
  it('空日可以新增站点；时间默认空、停留留空为 null、新站点没有坐标', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const latest: { current: TripDraft | null } = { current: null }
    const createStopId = vi.fn(() => 'new-stop-1')
    render(
      <Harness
        initialDraft={draft}
        initialDay={2}
        latestRef={latest}
        onCreateStopId={createStopId}
      />,
    )
    const editor = editorRegion()
    expect(within(editor).getByText(/第 2 天目前没有站点/)).toBeInTheDocument()

    await user.click(within(editor).getByRole('button', { name: '新增站点' }))
    expect(screen.getByTestId('editing')).toHaveTextContent('true')
    const time = within(editor).getByLabelText(/^时间/)
    expect(time).toHaveValue('')
    expect(within(editor).getByLabelText(/停留时长（分钟）/)).toHaveValue('')
    expect(within(editor).queryByLabelText(/经度|纬度/)).toBeNull()
    expect(within(editor).getByText(/新站点没有坐标/)).toBeInTheDocument()

    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    expect(createStopId).not.toHaveBeenCalled()
    expect(within(editor).getByText(/站点名称不能为空/)).toBeInTheDocument()
    expect(within(editor).getByText(/请填写时间/)).toBeInTheDocument()
    expect(dayOf(latest.current as TripDraft, 2).stops).toHaveLength(0)

    await user.type(within(editor).getByLabelText(/站点名称/), '拱宸桥')
    await user.type(time, '14:00')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    expect(createStopId).toHaveBeenCalledTimes(1)
    const day2 = dayOf(latest.current as TripDraft, 2)
    expect(day2.stops).toHaveLength(1)
    expect(day2.stops[0]).toMatchObject({
      id: 'new-stop-1',
      name: '拱宸桥',
      time: '14:00',
      duration_minutes: null,
      address: '',
      location: null,
    })
    expect(day2.legs).toEqual([])
    expect(within(editor).getByText('拱宸桥')).toBeInTheDocument()
  })

  it('上下移动和删除只改草稿，结构操作可被撤销回原状态', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const latest: { current: TripDraft | null } = { current: null }
    render(<Harness initialDraft={draft} latestRef={latest} />)
    const editor = editorRegion()

    await user.click(
      within(editor).getByRole('button', { name: '下移第 1 站「断桥残雪」' }),
    )
    let day = dayOf(latest.current as TripDraft, 1)
    expect(day.stops.map((stop) => stop.id)).toEqual(['s2', 's1', 's3'])
    expect(day.legs).toHaveLength(2)
    expect(day.legs[0].from_stop_id).toBe('s2')
    expect(day.legs[0].route_type).toBe('unavailable')

    await user.click(
      within(editor).getByRole('button', { name: /删除第 3 站「湖滨晴雨」/ }),
    )
    day = dayOf(latest.current as TripDraft, 1)
    expect(day.stops.map((stop) => stop.id)).toEqual(['s2', 's1'])
    expect(day.legs).toHaveLength(1)
    expect(day.legs[0]).toMatchObject({ from_stop_id: 's2', to_stop_id: 's1' })

    const undo = within(editor).getByRole('button', { name: '撤销草稿操作' })
    await user.click(undo)
    day = dayOf(latest.current as TripDraft, 1)
    expect(day.stops.map((stop) => stop.id)).toEqual(['s2', 's1', 's3'])
    await user.click(undo)
    day = dayOf(latest.current as TripDraft, 1)
    expect(day.stops.map((stop) => stop.id)).toEqual(['s1', 's2', 's3'])
    expect(within(editor).getByText(/已撤销上一步草稿操作/)).toBeInTheDocument()
  })

  it('撤销时间修改后回到原值，应用重新变为禁用', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const latest: { current: TripDraft | null } = { current: null }
    render(<Harness initialDraft={draft} latestRef={latest} />)
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const time = within(editor).getByLabelText(/^时间/)
    await user.clear(time)
    await user.type(time, '10:30')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    expect(within(editor).getByRole('button', { name: '应用草稿' })).toBeEnabled()

    await user.click(within(editor).getByRole('button', { name: '撤销草稿操作' }))
    expect(stopOf(latest.current as TripDraft, 1, 's1').time).toBe('09:00')
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
    expect(within(editor).getByRole('button', { name: '应用草稿' })).toBeDisabled()
    expect(within(editor).getByText(/也不会自动重新请求路线/)).toBeInTheDocument()
  })
})

describe('TripDraftEditor 应用与放弃', () => {
  it('应用调用真实 applyDraft 并把成功结果交给父视图', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const onApplySpy = vi.fn()
    render(<Harness initialDraft={draft} onApplySpy={onApplySpy} />)
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const description = within(editor).getByLabelText('描述')
    await user.clear(description)
    await user.type(description, '更新后的本地描述')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    await user.click(within(editor).getByRole('button', { name: '应用草稿' }))

    expect(onApplySpy).toHaveBeenCalledTimes(1)
    const result = onApplySpy.mock.calls[0][0] as DraftApplySuccess
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.trip.id).toBe(draft.forkTripId)
    expect(result.trip.days[0].stops[0].description).toBe('更新后的本地描述')
    expect(result.trip.days[0].summary).toContain('本地编辑后')
    expect(result.trip.warnings[0]).toContain('本地编辑说明')
    expect(screen.getByTestId('applied')).toHaveTextContent(draft.forkTripId)
    expect(within(editor).getByText(/已应用到新的行程副本/)).toBeInTheDocument()
  })

  it('有修改的放弃草稿使用页内确认，不调用原生 confirm', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    const draft = makeDraft()
    const latest: { current: TripDraft | null } = { current: null }
    render(<Harness initialDraft={draft} latestRef={latest} />)
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const description = within(editor).getByLabelText('描述')
    await user.clear(description)
    await user.type(description, '准备放弃的描述')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    await user.click(within(editor).getByRole('button', { name: '放弃草稿' }))
    expect(
      within(editor).getByRole('group', { name: '确认放弃草稿' }),
    ).toBeInTheDocument()
    expect(confirmSpy).not.toHaveBeenCalled()

    await user.click(within(editor).getByRole('button', { name: '继续编辑' }))
    expect(within(editor).queryByRole('group', { name: '确认放弃草稿' })).toBeNull()
    expect(screen.getByTestId('dirty')).toHaveTextContent('true')
    expect(stopOf(latest.current as TripDraft, 1, 's1').description).toBe(
      '准备放弃的描述',
    )

    await user.click(within(editor).getByRole('button', { name: '放弃草稿' }))
    await user.click(within(editor).getByRole('button', { name: '确认放弃草稿' }))
    expect(screen.getByTestId('discard-count')).toHaveTextContent('1')
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
    expect(stopOf(latest.current as TripDraft, 1, 's1').description).toBe(
      draft.base.days[0].stops[0].description,
    )
    expect(within(editor).getByText(/已放弃草稿/)).toBeInTheDocument()
  })

  it('应用失败（640 KB 容量拒绝）只显示错误，不调用 onApply', async () => {
    const user = userEvent.setup()
    const base = cloneTrip()
    const day = base.days[0]
    day.stops.push(
      {
        id: 'big-4',
        name: '大站四',
        time: '12:00',
        duration_minutes: null,
        description: '',
        address: '',
        location: { lng: 120.4, lat: 30.4 },
      },
      {
        id: 'big-5',
        name: '大站五',
        time: '13:00',
        duration_minutes: null,
        description: '',
        address: '',
        location: { lng: 120.5, lat: 30.5 },
      },
    )
    const longPoints = (seed: number) =>
      Array.from({ length: 4800 }, (_, index) => ({
        lng: 120.123456 + seed * 0.01 + index * 0.000001,
        lat: 30.654321 + index * 0.000001,
      }))
    day.legs = [0, 1, 2, 3].map((index) => ({
      from_stop_id: day.stops[index].id,
      to_stop_id: day.stops[index + 1].id,
      mode: 'walking' as TravelMode,
      route_type: 'navigation' as const,
      distance_m: 1000,
      duration_minutes: 10,
      geometry: longPoints(index),
      description: '长路线',
    }))
    expect(savedTripRecordBytes(base)).toBeGreaterThan(MAX_SAVED_TRIP_BYTES)

    const draft = makeDraft(base)
    const onApplySpy = vi.fn()
    render(<Harness initialDraft={draft} onApplySpy={onApplySpy} />)
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const time = within(editor).getByLabelText(/^时间/)
    await user.clear(time)
    await user.type(time, '09:10')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    await user.click(within(editor).getByRole('button', { name: '应用草稿' }))

    expect(onApplySpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('applied')).toHaveTextContent('')
    const alert = firstAlert(editor)
    expect(alert).toHaveTextContent(/应用失败/)
    expect(alert).toHaveTextContent(/640 KB/)
    expect(alert).toHaveTextContent(/原始行程保持不变/)
    expect(screen.getByTestId('dirty')).toHaveTextContent('true')
  })
})

describe('TripDraftEditor 编辑会话保护', () => {
  it('表单打开时结构动作暂停，外部切天不会丢掉未提交输入', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const latest: { current: TripDraft | null } = { current: null }
    const createStopId = vi.fn()
    render(
      <Harness
        initialDraft={draft}
        latestRef={latest}
        onCreateStopId={createStopId}
      />,
    )
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const name = within(editor).getByLabelText(/站点名称/)
    await user.type(name, '-改')

    expect(within(editor).getByRole('button', { name: '新增站点' })).toBeDisabled()
    expect(within(editor).getByRole('button', { name: '撤销草稿操作' })).toBeDisabled()
    expect(within(editor).getByRole('button', { name: '应用草稿' })).toBeDisabled()
    expect(within(editor).getByRole('button', { name: '放弃草稿' })).toBeDisabled()
    expect(within(editor).getByText(/单站输入尚未保存/)).toBeInTheDocument()
    expect(screen.getByTestId('editing')).toHaveTextContent('true')
    expect(screen.getByTestId('input-dirty')).toHaveTextContent('true')
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('0')

    await user.click(screen.getByRole('button', { name: '外部切换到第 2 天' }))
    expect(
      within(editorRegion()).getByText(/第 1 天有一个未保存的单站输入/),
    ).toBeInTheDocument()
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('0')

    await user.click(screen.getByRole('button', { name: '外部切换到第 1 天' }))
    expect(within(editorRegion()).getByLabelText(/站点名称/)).toHaveValue(
      '断桥残雪-改',
    )
    expect(createStopId).not.toHaveBeenCalled()

    await user.click(within(editorRegion()).getByRole('button', { name: '取消输入' }))
    expect(screen.getByTestId('editing')).toHaveTextContent('false')
    expect(screen.getByTestId('input-dirty')).toHaveTextContent('false')
    expect(within(editorRegion()).getByRole('button', { name: '新增站点' })).toBeEnabled()
  })

  it('草稿 revision 被外部更新后，旧输入保留但不会写入新草稿', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const onChangeSpy = vi.fn()
    render(
      <Harness initialDraft={draft} onChangeSpy={onChangeSpy} />,
    )
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const address = within(editor).getByLabelText('地址')
    await user.clear(address)
    await user.type(address, '旧会话输入的地址')

    await user.click(screen.getByRole('button', { name: '外部更新草稿' }))
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('1')
    expect(within(editorRegion()).getByText(/草稿在编辑期间被更新过/)).toBeInTheDocument()

    await user.click(
      within(editorRegion()).getByRole('button', { name: '保存到草稿' }),
    )
    expect(onChangeSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('1')
    expect(within(editorRegion()).getByLabelText('地址')).toHaveValue(
      '旧会话输入的地址',
    )
    expect(within(editorRegion()).getAllByText(/不会写入新草稿/).length).toBeGreaterThan(0)
    expect(stopOf(draft, 1, 's1').address).toBe(
      '杭州市西湖区白堤东端',
    )
  })

  it('草稿身份在打开表单后被换掉时同样拒绝保存', async () => {
    const user = userEvent.setup()
    const draft = makeDraft()
    const latest: { current: TripDraft | null } = { current: null }
    const onChangeSpy = vi.fn()
    render(
      <Harness initialDraft={draft} latestRef={latest} onChangeSpy={onChangeSpy} />,
    )
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const name = within(editor).getByLabelText(/站点名称/)
    await user.type(name, '-旧会话')

    await user.click(screen.getByRole('button', { name: '外部换 fork 草稿' }))
    expect((latest.current as TripDraft).forkTripId).toBe('trip-fork-other')
    expect(screen.getByTestId('draft-revision')).toHaveTextContent('0')

    await user.click(
      within(editorRegion()).getByRole('button', { name: '保存到草稿' }),
    )
    expect(onChangeSpy).not.toHaveBeenCalled()
    expect((latest.current as TripDraft).forkTripId).toBe('trip-fork-other')
    expect(within(editorRegion()).getByLabelText(/站点名称/)).toHaveValue(
      '断桥残雪-旧会话',
    )
  })
})

describe('TripDraftEditor 检查、可访问性与无自动副作用', () => {
  it('本地检查多时先显示前 4 条并准确标注剩余；旧提醒单独展开', async () => {
    const user = userEvent.setup()
    const base = cloneTrip()
    base.warnings = ['旧提醒 1', '旧提醒 2', '旧提醒 3', '旧提醒 4', '旧提醒 5']
    let draft = makeDraft(base)
    for (const stopId of ['s1', 's2', 's3']) {
      draft = asDraft(updateDraftStop(draft, 1, stopId, { name: `${stopId}-改名` }))
    }
    render(<Harness initialDraft={draft} />)
    const editor = editorRegion()
    const checksSection = within(editor).getByRole('region', { name: '当前本地检查' })
    const warningsSection = within(editor).getByRole('region', {
      name: '编辑前行程提醒（仅供参考）',
    })

    expect(within(checksSection).getByText('5 条')).toBeInTheDocument()
    expect(checksSection.querySelectorAll('.tde-check-item')).toHaveLength(4)
    const expandChecks = within(checksSection).getByRole('button', {
      name: '展开其余 1 条检查',
    })
    expect(expandChecks).toHaveAttribute('aria-expanded', 'false')
    expect(within(checksSection).getByText(/已显示前 4 条，共 5 条/)).toBeInTheDocument()

    await user.click(expandChecks)
    expect(checksSection.querySelectorAll('.tde-check-item')).toHaveLength(5)
    expect(within(checksSection).getByText(/已显示全部 5 条/)).toBeInTheDocument()
    expect(
      within(checksSection).getByRole('button', { name: '收起检查列表' }),
    ).toHaveAttribute('aria-expanded', 'true')

    expect(warningsSection.querySelectorAll('.tde-warning-list > li:not(.tde-more)')).toHaveLength(3)
    expect(within(warningsSection).queryByText('旧提醒 4')).toBeNull()
    await user.click(
      within(warningsSection).getByRole('button', { name: '展开其余 2 条提醒' }),
    )
    expect(within(warningsSection).getByText('旧提醒 4')).toBeInTheDocument()
    expect(within(warningsSection).getByText(/已显示全部 5 条/)).toBeInTheDocument()
  })

  it('标签、按钮 type、错误 aria、同名站点序号与焦点回收都可用', async () => {
    const user = userEvent.setup()
    const base = cloneTrip()
    base.days[0].stops[1].name = '断桥残雪'
    render(<Harness initialDraft={makeDraft(base)} />)
    const editor = editorRegion()

    const firstEdit = within(editor).getByRole('button', {
      name: '编辑第 1 站「断桥残雪」',
    })
    const secondEdit = within(editor).getByRole('button', {
      name: '编辑第 2 站「断桥残雪」',
    })
    expect(firstEdit).toHaveAttribute('type', 'button')
    expect(secondEdit).toHaveAttribute('type', 'button')

    await user.click(firstEdit)
    const name = within(editor).getByLabelText(/站点名称/)
    expect(name).toHaveFocus()
    expect(within(editor).getByLabelText('地址')).toBeInTheDocument()
    expect(within(editor).getByLabelText(/停留时长（分钟）/)).toBeInTheDocument()
    expect(within(editor).getByLabelText('描述')).toBeInTheDocument()
    expect(
      within(editor).getByRole('button', { name: '保存到草稿' }),
    ).toHaveAttribute('type', 'submit')

    await user.click(within(editor).getByRole('button', { name: '取消输入' }))
    expect(firstEdit).toHaveFocus()
    expect(screen.getByTestId('editing')).toHaveTextContent('false')
    expect(within(editor).getAllByText('第 1 站').length).toBeGreaterThan(0)
    expect(within(editor).getAllByText('第 2 站').length).toBeGreaterThan(0)
  })

  it('编辑、应用、撤销过程中不自动写存储、不发网络请求', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')))
    vi.stubGlobal('fetch', fetchSpy)
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem')
    const draft = makeDraft()
    render(<Harness initialDraft={draft} />)
    const editor = await openEdit(user, '编辑第 1 站「断桥残雪」')
    const time = within(editor).getByLabelText(/^时间/)
    await user.clear(time)
    await user.type(time, '09:40')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await user.click(within(editor).getByRole('button', { name: '应用草稿' }))
    await user.click(within(editor).getByRole('button', { name: '撤销草稿操作' }))

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getItemSpy).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(removeItemSpy).not.toHaveBeenCalled()
    expect(applyDraft(draft).ok).toBe(true)
  })

  it('每天站点上限默认关闭且不影响现有检查；启用后 8→9 站出提醒，删回 8 站取消', async () => {
    const user = userEvent.setup()
    const base = cloneTrip()
    base.days[0].stops = Array.from({ length: 8 }, (_, index) => ({
      id: `d1s${index + 1}`,
      name: `站 ${index + 1}`,
      time: `0${index + 1}:00`.slice(-5),
      duration_minutes: null,
      description: '',
      address: '',
      location: null,
    }))
    let draft = makeDraft(base)
    render(<Harness initialDraft={draft} />)
    const editor = editorRegion()
    const limitSection = within(editor).getByRole('region', {
      name: '每天最多站点数（偏好检查）',
    })

    // 默认关闭：没有提醒，也不影响本地检查区块。
    expect(within(limitSection).getByText('未启用')).toBeInTheDocument()
    expect(within(limitSection).queryByText(/超过你设置的每天最多/)).toBeNull()
    expect(
      within(editor).getByRole('region', { name: '当前本地检查' }),
    ).toBeInTheDocument()

    const toggle = within(limitSection).getByRole('checkbox', {
      name: /启用每天站点数上限检查/,
    })
    const limitSelect = within(limitSection).getByRole('combobox', {
      name: '每天站点数上限',
    })
    expect(limitSelect).toBeDisabled()
    await user.click(toggle)
    expect(limitSelect).toBeEnabled()

    // 先把上限调到 8（默认值是 4），8 站时不应提醒。
    await user.selectOptions(limitSelect, '8')
    expect(within(limitSection).queryByText(/超过你设置的每天最多/)).toBeNull()

    // 新增第 9 站（先开新增表单要经过 toolbar；直接用真实纯函数更新草稿更贴近单元口径，
    // 但这里走 UI：勾选后通过 harness 外部按钮不可行，所以用编辑器的新增路径）。
    await user.click(within(editor).getByRole('button', { name: '新增站点' }))
    await user.type(within(editor).getByLabelText(/站点名称/), '第 9 站')
    await user.type(within(editor).getByLabelText(/^时间/), '17:00')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    expect(within(limitSection).getByText(/超过你设置的每天最多 8 站上限/)).toBeInTheDocument()
    // 提醒明确区分：这是偏好提醒，不代表不可行，也没删站。
    expect(within(limitSection).getByText(/不代表行程不可行/)).toBeInTheDocument()
  })

  it('上限设置是会话级 UI 状态：删除站点后提醒消失，且不触发存储或网络', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')))
    vi.stubGlobal('fetch', fetchSpy)
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const base = cloneTrip()
    base.days[0].stops = Array.from({ length: 9 }, (_, index) => ({
      id: `d1s${index + 1}`,
      name: `站 ${index + 1}`,
      time: `0${index + 1}:00`.slice(-5),
      duration_minutes: null,
      description: '',
      address: '',
      location: null,
    }))
    render(<Harness initialDraft={makeDraft(base)} />)
    const editor = editorRegion()
    const limitSection = within(editor).getByRole('region', {
      name: '每天最多站点数（偏好检查）',
    })
    await user.click(
      within(limitSection).getByRole('checkbox', { name: /启用每天站点数上限检查/ }),
    )
    const limitSelect = within(limitSection).getByRole('combobox', {
      name: '每天站点数上限',
    })
    await user.selectOptions(limitSelect, '8')
    expect(within(limitSection).getByText(/超过你设置的每天最多 8 站上限/)).toBeInTheDocument()

    // 旧大数据可读：9 站都显示，删除后恢复到 8，提醒取消。
    expect(within(editor).getAllByText(/第 \d+ 站/).length).toBeGreaterThanOrEqual(9)
    await user.click(
      within(editor).getByRole('button', { name: '删除第 1 站「站 1」（可撤销）' }),
    )
    expect(within(limitSection).queryByText(/超过你设置的每天最多/)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('换 forkTripId 后偏好不从旧草稿泄漏：上限检查回到默认禁用', async () => {
    const user = userEvent.setup()
    const base = cloneTrip()
    base.days[0].stops = Array.from({ length: 9 }, (_, index) => ({
      id: `d1s${index + 1}`,
      name: `站 ${index + 1}`,
      time: `0${index + 1}:00`.slice(-5),
      duration_minutes: null,
      description: '',
      address: '',
      location: null,
    }))
    render(<Harness initialDraft={makeDraft(base)} />)
    const editor = editorRegion()
    const limitSection = within(editor).getByRole('region', {
      name: '每天最多站点数（偏好检查）',
    })

    // 在旧草稿里启用偏好并改成非默认值：启用 + 上限 8 + 仅改动过的天。
    await user.click(
      within(limitSection).getByRole('checkbox', { name: /启用每天站点数上限检查/ }),
    )
    await user.selectOptions(
      within(limitSection).getByRole('combobox', { name: '每天站点数上限' }),
      '8',
    )
    await user.selectOptions(
      within(limitSection).getByRole('combobox', { name: '上限检查范围' }),
      'changed_days',
    )
    expect(within(limitSection).getByText('上限 8 站')).toBeInTheDocument()

    // 外部换 forkTripId：偏好必须回到默认，而不是把旧草稿的设置带进新草稿。
    await user.click(screen.getByRole('button', { name: '外部换 fork 草稿' }))
    expect(within(limitSection).getByText('未启用')).toBeInTheDocument()
    expect(
      within(limitSection).getByRole('combobox', { name: '每天站点数上限' }),
    ).toBeDisabled()
    expect(
      within(limitSection).getByRole('combobox', { name: '上限检查范围' }),
    ).toBeDisabled()
    expect(
      within(limitSection).getByRole('combobox', { name: '每天站点数上限' }),
    ).toHaveValue('4')
    expect(
      within(limitSection).getByRole('combobox', { name: '上限检查范围' }),
    ).toHaveValue('all_days')
    expect(within(limitSection).queryByText(/超过你设置的每天最多/)).toBeNull()
  })

  describe('每天最晚结束时间偏好', () => {
    function endTimeSection(editor: HTMLElement): HTMLElement {
      return within(editor).getByRole('region', { name: '每天最晚结束时间（偏好检查）' })
    }

    it('默认关闭，结果区不出现；启用后需显式点检查才出结果', async () => {
      const user = userEvent.setup()
      render(<Harness initialDraft={makeDraft()} />)
      const editor = editorRegion()
      const section = endTimeSection(editor)

      expect(within(section).getByText('未启用')).toBeInTheDocument()
      expect(within(section).queryByText(/不虚构结束时刻/)).toBeNull()
      expect(
        within(section).getByRole('textbox', { name: '最晚结束' }),
      ).toBeDisabled()
      expect(within(section).getByRole('button', { name: '检查' })).toBeDisabled()

      await user.click(
        within(section).getByRole('checkbox', { name: /启用每天最晚结束检查/ }),
      )
      expect(within(section).getByText('已启用，待检查')).toBeInTheDocument()
      expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()

      await user.click(within(section).getByRole('button', { name: '检查' }))
      // 默认上限 22:00，夹具各天都在上限内：显示保守的「未发现超限」而非无声通过。
      expect(within(section).getAllByText(/未发现超过最晚结束时间/).length).toBeGreaterThan(0)
      expect(within(section).getAllByText(/仍需人工确认交通/).length).toBeGreaterThan(0)
    })

    it('上限非法时区内报错且不产生结果；修正后可重新检查', async () => {
      const user = userEvent.setup()
      render(<Harness initialDraft={makeDraft()} />)
      const editor = editorRegion()
      const section = endTimeSection(editor)
      const input = within(section).getByRole('textbox', { name: '最晚结束' })

      await user.click(
        within(section).getByRole('checkbox', { name: /启用每天最晚结束检查/ }),
      )
      await user.clear(input)
      await user.type(input, '9:00')
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getByRole('alert')).toHaveTextContent(/24 小时制/)
      expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()
      expect(input).toHaveAttribute('aria-invalid', 'true')

      await user.clear(input)
      await user.type(input, '10:30')
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).queryByRole('alert')).toBeNull()
      // 第 1 天 s3 11:30 开始，晚于 10:30 上限 → 明确超限；与停留无关。
      expect(within(section).getAllByText('超过上限').length).toBeGreaterThan(0)
      expect(within(section).getByText(/开始时刻 11:30 已晚于/)).toBeInTheDocument()
    })

    it('关闭开关清除旧结果：关→开流程回到「待检查」，不残留上一次检查的结论', async () => {
      const user = userEvent.setup()
      render(<Harness initialDraft={makeDraft()} />)
      const editor = editorRegion()
      const section = endTimeSection(editor)
      const toggle = within(section).getByRole('checkbox', {
        name: /启用每天最晚结束检查/,
      })

      // 检查一次，结果出现。
      await user.click(toggle)
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getAllByText(/未发现超过最晚结束时间/).length).toBeGreaterThan(0)

      // 关闭开关：结果与「已启用」标识一起消失，不能让禁用状态冒充已检查。
      await user.click(toggle)
      expect(within(section).getByText('未启用')).toBeInTheDocument()
      expect(within(section).queryByText(/未发现超过最晚结束时间/)).toBeNull()
      expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()

      // 重新打开：回到「已启用，待检查」，需要重新点检查。
      await user.click(toggle)
      expect(within(section).getByText('已启用，待检查')).toBeInTheDocument()
      expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getAllByText(/未发现超过最晚结束时间/).length).toBeGreaterThan(0)
    })

    it('修改输入或范围后旧结果清除，需重新检查；未检查的新设置不冒充已生效', async () => {
      const user = userEvent.setup()
      let draft = makeDraft()
      // 第 1 天 s1 09:00 + 600 分钟 → 结束下界 19:00。
      const edited = updateDraftStop(draft, 1, 's1', { duration_minutes: 600 })
      if (!edited.ok) throw new Error(edited.message)
      draft = edited.draft
      render(<Harness initialDraft={draft} />)
      const editor = editorRegion()
      const section = endTimeSection(editor)
      const input = within(section).getByRole('textbox', { name: '最晚结束' })
      const scopeSelect = within(section).getByRole('combobox', {
        name: '最晚结束检查范围',
      })

      // 有效检查一次：上限 23:00，第 1 天下界 19:00 未超，无证据。
      await user.click(
        within(section).getByRole('checkbox', { name: /启用每天最晚结束检查/ }),
      )
      await user.clear(input)
      await user.type(input, '23:00')
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getAllByText(/未发现超过最晚结束时间/).length).toBeGreaterThan(0)

      // 改输入（仍未点检查）：旧结果立刻清除，也不能显示报错冒充检查结论。
      await user.clear(input)
      await user.type(input, '18:00')
      expect(within(section).queryByText(/未发现超过最晚结束时间/)).toBeNull()
      expect(within(section).queryByRole('alert')).toBeNull()
      expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()

      // 重新检查新输入：按 18:00 出结果，下界 19:00 超限。
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getAllByText(/结束不早于 19:00/).length).toBeGreaterThan(0)

      // 改范围同样清除旧结果，直到重新检查。
      await user.selectOptions(scopeSelect, 'changed_days')
      expect(within(section).queryByText(/结束不早于 19:00/)).toBeNull()
      expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()
      await user.click(within(section).getByRole('button', { name: '检查' }))
      // 这份草稿改过第 1 天，changed_days 下该天仍按 18:00 检查并超限。
      expect(within(section).getAllByText(/结束不早于 19:00/).length).toBeGreaterThan(0)
    })

    it('非法输入报错后修改输入即清掉报错与旧结果；重新检查合法输入恢复展示', async () => {
      const user = userEvent.setup()
      render(<Harness initialDraft={makeDraft()} />)
      const section = endTimeSection(editorRegion())
      const input = within(section).getByRole('textbox', { name: '最晚结束' })

      await user.click(
        within(section).getByRole('checkbox', { name: /启用每天最晚结束检查/ }),
      )
      await user.clear(input)
      await user.type(input, '9:00')
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getByRole('alert')).toHaveTextContent(/24 小时制/)

      // 修改非法输入：报错与旧状态一起清除，回到「待检查」，不再显示过时报错。
      await user.clear(input)
      await user.type(input, '21:00')
      expect(within(section).queryByRole('alert')).toBeNull()
      expect(within(section).getByText('已启用，待检查')).toBeInTheDocument()

      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).queryByRole('alert')).toBeNull()
      expect(within(section).getAllByText(/未发现超过最晚结束时间/).length).toBeGreaterThan(0)
    })

    it('用户设置后出提醒；同草稿切天不丢设置与结果，撤销后结果仍按冻结上限展示', async () => {
      const user = userEvent.setup()
      let draft = makeDraft()
      // 第 1 天 s1 09:00 + 600 分钟 → 结束下界 19:00，超 18:00 上限。
      const edited = updateDraftStop(draft, 1, 's1', { duration_minutes: 600 })
      if (!edited.ok) throw new Error(edited.message)
      draft = edited.draft
      render(<Harness initialDraft={draft} />)
      const editor = editorRegion()
      const section = endTimeSection(editor)
      const input = within(section).getByRole('textbox', { name: '最晚结束' })

      await user.click(
        within(section).getByRole('checkbox', { name: /启用每天最晚结束检查/ }),
      )
      await user.clear(input)
      await user.type(input, '18:00')
      await user.click(within(section).getByRole('button', { name: '检查' }))

      expect(within(section).getByText('上限 18:00')).toBeInTheDocument()
      expect(within(section).getByText(/结束不早于 19:00/)).toBeInTheDocument()
      expect(within(section).getAllByText('超过上限').length).toBeGreaterThan(0)

      // 同草稿切到第 2 天（空日）：设置与结果都保留，不因切天误丢。
      await user.click(screen.getByRole('button', { name: '外部切换到第 2 天' }))
      const onDay2 = endTimeSection(editorRegion())
      expect(within(onDay2).getByText('上限 18:00')).toBeInTheDocument()
      expect(within(onDay2).getByText(/结束不早于 19:00/)).toBeInTheDocument()
      // 空日的天级结论也不丢：单独标注，不虚构结束。
      expect(within(onDay2).getByText(/没有站点，不虚构结束时刻/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: '外部切换到第 1 天' }))

      // 撤销这次停留编辑：结果按冻结上限重算，第 1 天回到未发现超限。
      await user.click(within(editorRegion()).getByRole('button', { name: '撤销草稿操作' }))
      const afterUndo = endTimeSection(editorRegion())
      expect(within(afterUndo).getByText('上限 18:00')).toBeInTheDocument()
      expect(within(afterUndo).queryByText(/结束不早于 19:00/)).toBeNull()
    })

    it('换 forkTripId 后结束时间偏好重置：开关、输入、范围与结果都回默认', async () => {
      const user = userEvent.setup()
      render(<Harness initialDraft={makeDraft()} />)
      const section = endTimeSection(editorRegion())
      const input = within(section).getByRole('textbox', { name: '最晚结束' })

      await user.click(
        within(section).getByRole('checkbox', { name: /启用每天最晚结束检查/ }),
      )
      await user.clear(input)
      await user.type(input, '20:00')
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getByText(/上限 20:00/)).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: '外部换 fork 草稿' }))
      const fresh = endTimeSection(editorRegion())
      expect(within(fresh).getByText('未启用')).toBeInTheDocument()
      expect(within(fresh).getByRole('textbox', { name: '最晚结束' })).toHaveValue('22:00')
      expect(
        within(fresh).getByRole('combobox', { name: '最晚结束检查范围' }),
      ).toHaveValue('all_days')
      expect(within(fresh).queryByText(/第 \d+ 天/)).toBeNull()
    })

    it('结束时间检查过程不写存储、不发网络请求；解析函数与站点时间同口径', async () => {
      const user = userEvent.setup()
      const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')))
      vi.stubGlobal('fetch', fetchSpy)
      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
      const draft = makeDraft()
      render(<Harness initialDraft={draft} />)
      const section = endTimeSection(editorRegion())
      const input = within(section).getByRole('textbox', { name: '最晚结束' })

      await user.click(
        within(section).getByRole('checkbox', { name: /启用每天最晚结束检查/ }),
      )
      await user.type(input, '22')
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getByRole('alert')).toBeInTheDocument()
      // 修改输入会清掉报错（见关闭/清除回归）；这里直接清空重输合法值再检查。
      await user.clear(input)
      await user.type(input, '22:30')
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getAllByText(/未发现超过最晚结束时间/).length).toBeGreaterThan(0)

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(getItemSpy).not.toHaveBeenCalled()
      expect(setItemSpy).not.toHaveBeenCalled()
      // 与 STOP_TIME_PATTERN 同口径：24:00 不是合法站点时间，也不是合法上限。
      expect(parseDailyEndTimeLimit('24:00').ok).toBe(false)
      expect(parseDailyEndTimeLimit('22:30')).toEqual({ ok: true, minutes: 1350 })
    })
  })
})

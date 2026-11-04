/**
 * 创建隔离与步行检查 owner 归属回归（本文件只补既有测试未覆盖的语义缺口）：
 *
 * 1. createTripDraft 创建时把可编辑 day / stops / legs / location 与 base 解除共享：
 *    值相等、对象独立；geometry 数组与坐标点按只读叶节点合同继续共享；
 *    draft.base 仍是原 Trip，discard 与无变化 apply 仍返回 base 本身。
 * 2. 步行距离检查的 owner 每次渲染基于 base 完整内容快照（不按引用 memo），
 *    并结合 forkTripId 与 base 引用身份推进单调 epoch：
 *    - 同浅元数据（id / title / source / destination / 天序号相同）但站点或路线
 *      内容不同的新 base，必须重置偏好并使旧 run 失效；
 *    - 同引用 base 被原地改任何内容（含 legs 距离）后，旧 run 在渲染期即失效，
 *      不闪现旧合计；
 *    - 内容相同的新克隆 base（新对象身份）同样进入新会话；
 *    - 真 ABA（同 fork id 回到旧 owner key）不复活旧 run；
 *    - base 无法序列化时 fail closed：旧结果不渲染，偏好回默认；
 *    - 正常草稿编辑 / 撤销 / 切天只动工作结构、base 不变时设置与结果保留。
 */
import { useRef, useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import type { Trip, TripDay, TripLocation } from '../lib/api'
import { checkTripShape } from '../lib/savedTrips'
import {
  applyDraft,
  createTripDraft,
  discardDraft,
  updateDraftStop,
  undoDraft,
  type DraftApplySuccess,
  type DraftEditResult,
  type TripDraft,
} from '../lib/tripDraft'
import TripDraftEditor from '../components/TripDraftEditor'
import { MOCK_TRIP } from './fixtures/trip'

function cloneTrip(): Trip {
  return JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
}

function makeDraft(base: Trip, forkTripId = 'trip-fork-owner-a'): TripDraft {
  const created = createTripDraft(base, { forkTripId, newLegMode: 'walking' })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

function asDraft(result: DraftEditResult): TripDraft {
  if (!result.ok) throw new Error(result.message)
  return result.draft
}

function applyOk(draft: TripDraft): DraftApplySuccess {
  const result = applyDraft(draft)
  if (!result.ok) throw new Error(result.message)
  return result
}

interface OwnerHarnessProps {
  initialDraft: TripDraft
  latestRef?: { current: TripDraft | null }
}

function OwnerHarness({ initialDraft, latestRef }: OwnerHarnessProps) {
  const [draft, setDraft] = useState(initialDraft)
  const [dayNumber, setDayNumber] = useState(1)
  const idCounter = useRef(0)
  const [, forceRender] = useState(0)

  if (latestRef) latestRef.current = draft

  return (
    <div>
      <div>
        <button type="button" onClick={() => setDayNumber(2)}>
          外部切换到第 2 天
        </button>
        <button type="button" onClick={() => forceRender((value) => value + 1)}>
          外部触发重渲染
        </button>
        <button
          type="button"
          onClick={() => {
            // 同浅元数据（id / source / title / destination / 天序号不变），
            // 但站点路线内容不同：s1→s2 的导航步行距离 1100 → 900。
            const freshBase = JSON.parse(JSON.stringify(initialDraft.base)) as Trip
            freshBase.days[0].legs[0].distance_m = 900
            const fresh = createTripDraft(freshBase, {
              forkTripId: initialDraft.forkTripId,
              newLegMode: initialDraft.newLegMode,
            })
            if (fresh.ok) setDraft(fresh.draft)
          }}
        >
          外部换同元数据新内容base
        </button>
        <button
          type="button"
          onClick={() => {
            // 不换 draft 引用、不换 base 引用：原地改 base 内容后普通重渲染。
            const current = latestRef?.current ?? draft
            ;(current.base.days as TripDay[])[0].legs[0].distance_m = 900
            forceRender((value) => value + 1)
          }}
        >
          同引用改base内容并重渲染
        </button>
        <button
          type="button"
          onClick={() => {
            // 内容与 base 完全相同的新克隆对象：按新会话处理。
            const freshBase = JSON.parse(JSON.stringify(initialDraft.base)) as Trip
            const fresh = createTripDraft(freshBase, {
              forkTripId: initialDraft.forkTripId,
              newLegMode: initialDraft.newLegMode,
            })
            if (fresh.ok) setDraft(fresh.draft)
          }}
        >
          外部换同内容克隆base
        </button>
        <button
          type="button"
          onClick={() => {
            const fresh = createTripDraft(draft.base, {
              forkTripId: 'trip-fork-owner-b',
              newLegMode: draft.newLegMode,
            })
            if (fresh.ok) setDraft(fresh.draft)
          }}
        >
          外部换到B会话
        </button>
        <button
          type="button"
          onClick={() => {
            // 回到最初 fork id：owner key 与最初相同时也不得复活旧 run。
            const fresh = createTripDraft(draft.base, {
              forkTripId: initialDraft.forkTripId,
              newLegMode: draft.newLegMode,
            })
            if (fresh.ok) setDraft(fresh.draft)
          }}
        >
          外部换回原A会话
        </button>
        <button
          type="button"
          onClick={() => {
            // base.summary 指向循环结构：JSON 序列化必然失败，但 days 仍是合法数组，
            // 其余渲染路径不受影响——精确命中 owner「序列化失败 fail closed」语义。
            const hostile = JSON.parse(JSON.stringify(initialDraft.base)) as Record<string, unknown>
            const cyclic: Record<string, unknown> = {}
            cyclic.self = cyclic
            hostile.summary = cyclic
            setDraft({ ...draft, base: hostile as unknown as Trip })
          }}
        >
          外部换不可序列化base
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(asDraft(updateDraftStop(draft, 1, 's1', { description: '正常编辑' })))
          }}
        >
          外部正常编辑草稿
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(asDraft(undoDraft(draft)))
          }}
        >
          外部撤销草稿
        </button>
      </div>
      <TripDraftEditor
        draft={draft}
        dayNumber={dayNumber}
        onDraftChange={(next) => setDraft(next)}
        onApply={() => {}}
        onDiscard={() => {}}
        createStopId={() => {
          idCounter.current += 1
          return `new-stop-${idCounter.current}`
        }}
      />
    </div>
  )
}

function editorRegion(): HTMLElement {
  return screen.getByRole('region', { name: '本地行程草稿编辑器' })
}

function walkingSection(editor: HTMLElement): HTMLElement {
  return within(editor).getByRole('region', { name: '每天步行距离上限（偏好检查）' })
}

async function enableAndCheck(
  user: ReturnType<typeof userEvent.setup>,
  section: HTMLElement,
): Promise<void> {
  await user.click(within(section).getByRole('checkbox', { name: /启用每天步行距离检查/ }))
  await user.click(within(section).getByRole('button', { name: '检查' }))
}

afterEach(() => {
  cleanup()
})

describe('createTripDraft 创建隔离：可编辑结构与 base 解除别名', () => {
  it('location 的未声明附加字段全程保留：创建值相等对象独立，真实编辑 apply 后仍在且 base 未改', () => {
    // 旧 JSON 备份→加载→编辑的真实路径：checkTripShape 只校验 lng/lat 合法，
    // 不拒绝 location 上的未声明字段（例如标注来源与置信度）。
    // 克隆必须保留全部可枚举字段，不能重建成仅 {lng, lat}；且这条路径必须走
    // 「确实产生变化的编辑 + apply」，不能用 no-op apply（它返回 base 本身，
    // 会掩盖克隆阶段丢字段）。
    const base = cloneTrip()
    const labeled = base.days[0].stops[0].location
    if (labeled === null) throw new Error('fixture stop should have location')
    const wideLocation = {
      ...labeled,
      label: 'x',
      confidence: 0.8,
    } as TripLocation & { label: string; confidence: number }
    base.days[0].stops[0].location = wideLocation
    const wideBase = base as Trip & {
      days: Array<{ stops: Array<{ location: TripLocation & Record<string, unknown> }> }>
    }
    expect(checkTripShape(wideBase).ok).toBe(true)

    const draft = makeDraft(wideBase)
    // 创建即与 base 值完整相等（含附加字段），location 对象独立。
    expect(draft.days[0].stops[0].location).not.toBe(wideLocation)
    expect(draft.days[0].stops[0].location).toEqual(wideLocation)
    expect(draft.days[0].stops[0].location).toMatchObject({ label: 'x', confidence: 0.8 })

    // 一次确实产生变化的编辑（改时间），再 apply：附加字段必须原样带到应用结果。
    const edited = asDraft(updateDraftStop(draft, 1, 's1', { time: '09:50' }))
    expect(edited.days[0].stops[0].time).toBe('09:50')
    const applied = applyOk(edited)
    const appliedLocation = applied.trip.days[0].stops[0].location
    if (appliedLocation === null) throw new Error('time-only edit keeps location')
    expect(appliedLocation).toMatchObject({
      lng: wideLocation.lng,
      lat: wideLocation.lat,
      label: 'x',
      confidence: 0.8,
    })

    // base 全程未被改写：附加字段仍只在 base 与草稿里，应用结果是带附加字段的新副本。
    expect(applied.trip).not.toBe(wideBase)
    expect(wideBase.days[0].stops[0].location).toBe(wideLocation)
    expect(wideBase.days[0].stops[0].location).toMatchObject({ label: 'x', confidence: 0.8 })
    // 改时间不触碰 location：草稿里的宽 location 与 base 的字段逐一相同但对象独立。
    expect(edited.days[0].stops[0].location).not.toBe(wideLocation)
    expect(edited.days[0].stops[0].location).toEqual(wideLocation)
  })
  it('草稿结构与 base 值相等但对象独立，geometry 仍共享，base 引用保留', () => {
    const base = cloneTrip()
    const draft = makeDraft(base)

    expect(draft.base).toBe(base)
    // 值完全相等（含宽字段），但不是同一组对象。
    expect(JSON.stringify(draft.days)).toBe(JSON.stringify(base.days))
    expect(draft.days).not.toBe(base.days)
    for (let index = 0; index < base.days.length; index += 1) {
      const draftDay = draft.days[index]
      const baseDay = base.days[index]
      expect(draftDay).not.toBe(baseDay)
      expect(draftDay.stops).not.toBe(baseDay.stops)
      expect(draftDay.legs).not.toBe(baseDay.legs)
      for (let stopIndex = 0; stopIndex < baseDay.stops.length; stopIndex += 1) {
        expect(draftDay.stops[stopIndex]).not.toBe(baseDay.stops[stopIndex])
        const baseLocation = baseDay.stops[stopIndex].location
        const draftLocation = draftDay.stops[stopIndex].location
        if (baseLocation === null) {
          expect(draftLocation).toBeNull()
        } else {
          expect(draftLocation).not.toBe(baseLocation)
          expect(draftLocation).toEqual(baseLocation)
        }
      }
      for (let legIndex = 0; legIndex < baseDay.legs.length; legIndex += 1) {
        expect(draftDay.legs[legIndex]).not.toBe(baseDay.legs[legIndex])
        // geometry 数组与坐标点按只读叶节点合同与 base 共享，不重复克隆。
        expect(draftDay.legs[legIndex].geometry).toBe(baseDay.legs[legIndex].geometry)
      }
    }
  })

  it('编辑草稿不写进 base：改 s1 描述后 base 内容逐字节不变，discard 返回原 base', () => {
    const base = cloneTrip()
    const baseSnapshot = JSON.stringify(base)
    const draft = makeDraft(base)
    const edited = asDraft(updateDraftStop(draft, 1, 's1', { description: '隔离后的描述' }))

    expect(JSON.stringify(base)).toBe(baseSnapshot)
    expect(draft.days[0].stops[0].description).not.toBe('隔离后的描述')
    expect(edited.days[0].stops[0].description).toBe('隔离后的描述')

    const discarded = discardDraft(edited)
    expect(discarded).toBe(base)
    expect(JSON.stringify(discarded)).toBe(baseSnapshot)
  })

  it('克隆不丢兼容宽字段：300 字站名与 1000 字地址在草稿结构里保持', () => {
    const base = cloneTrip()
    base.days[0].stops[0].name = '长'.repeat(300)
    base.days[0].stops[0].address = '路'.repeat(1000)
    const draft = makeDraft(base)

    expect(draft.days[0].stops[0]).not.toBe(base.days[0].stops[0])
    expect(draft.days[0].stops[0].name).toBe('长'.repeat(300))
    expect(draft.days[0].stops[0].address).toBe('路'.repeat(1000))
    expect(JSON.stringify(draft.days)).toBe(JSON.stringify(base.days))
  })
})

describe('步行检查 owner：完整 base 快照 + fork 与 base 引用 epoch', () => {
  it('同元数据但站点/路线内容不同的新 base：偏好重置、旧结论不渲染，新会话检查按新内容出结论', async () => {
    const user = userEvent.setup()
    const latest: { current: TripDraft | null } = { current: null }
    render(<OwnerHarness initialDraft={makeDraft(cloneTrip())} latestRef={latest} />)
    let section = walkingSection(editorRegion())

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '外部换同元数据新内容base' }))
    section = walkingSection(editorRegion())
    // 同一批断言：旧合计不闪现、偏好整体回默认（渲染期 + effect 后都成立）。
    expect(within(section).queryAllByText(/合计 1100 米/)).toHaveLength(0)
    expect(within(section).getByText('未启用')).toBeInTheDocument()
    expect(
      within(section).getByRole('textbox', { name: '每天步行距离上限' }),
    ).toHaveValue('3000')

    // 新会话重新检查：读到新 base 的 900 米，不再冒用旧内容。
    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 900 米/).length).toBeGreaterThan(0)
    expect(within(section).queryAllByText(/合计 1100 米/)).toHaveLength(0)
  })

  it('同引用 base 原地改 legs 后重渲染：旧 run 渲染期即失效、偏好回默认；工作结构不受影响', async () => {
    const user = userEvent.setup()
    const latest: { current: TripDraft | null } = { current: null }
    render(<OwnerHarness initialDraft={makeDraft(cloneTrip())} latestRef={latest} />)
    let section = walkingSection(editorRegion())

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '同引用改base内容并重渲染' }))
    // 前置确认 base 内容确实被原地改了，而草稿工作结构保持创建时的隔离副本。
    expect(latest.current?.base.days[0].legs[0].distance_m).toBe(900)
    expect(latest.current?.days[0].legs[0].distance_m).toBe(1100)

    section = walkingSection(editorRegion())
    expect(within(section).queryAllByText(/合计 1100 米/)).toHaveLength(0)
    expect(within(section).queryByText(/合计 900 米/)).toBeNull()
    expect(within(section).getByText('未启用')).toBeInTheDocument()
  })

  it('内容相同的新克隆 base（新对象身份）同样进入新会话：偏好重置、旧结论不渲染', async () => {
    const user = userEvent.setup()
    const latest: { current: TripDraft | null } = { current: null }
    render(<OwnerHarness initialDraft={makeDraft(cloneTrip())} latestRef={latest} />)
    const beforeBase = latest.current?.base
    const section = walkingSection(editorRegion())

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '外部换同内容克隆base' }))
    // 点击前先捕获 base 引用：点击后 base 是全新克隆对象（内容相同、身份不同）。
    expect(latest.current?.base).not.toBe(beforeBase)
    const after = walkingSection(editorRegion())
    expect(within(after).queryAllByText(/合计 1100 米/)).toHaveLength(0)
    expect(within(after).getByText('未启用')).toBeInTheDocument()
  })

  it('真 ABA：A→B→回到同 fork id 的 A，旧 run 不复活', async () => {
    const user = userEvent.setup()
    render(<OwnerHarness initialDraft={makeDraft(cloneTrip())} />)
    let section = walkingSection(editorRegion())

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '外部换到B会话' }))
    section = walkingSection(editorRegion())
    expect(within(section).getByText('未启用')).toBeInTheDocument()
    expect(within(section).queryAllByText(/合计 1100 米/)).toHaveLength(0)

    // 回到与最初相同的 fork id：owner key 返回旧值也不得复活旧 run。
    await user.click(screen.getByRole('button', { name: '外部换回原A会话' }))
    section = walkingSection(editorRegion())
    expect(within(section).queryAllByText(/合计 1100 米/)).toHaveLength(0)
    expect(within(section).getByText('未启用')).toBeInTheDocument()

    // 显式重新检查得到的是新 run，而不是复活的旧结论。
    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)
  })

  it('不可序列化 base fail closed：旧结果不渲染，偏好回默认', async () => {
    const user = userEvent.setup()
    render(<OwnerHarness initialDraft={makeDraft(cloneTrip())} />)
    let section = walkingSection(editorRegion())

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '外部换不可序列化base' }))
    section = walkingSection(editorRegion())
    expect(within(section).queryAllByText(/合计 1100 米/)).toHaveLength(0)
    expect(within(section).getByText('未启用')).toBeInTheDocument()
  })

  it('正常草稿编辑 / 撤销 / 切天不动 base：设置与结果保留并按当前 legs 重算', async () => {
    const user = userEvent.setup()
    const latest: { current: TripDraft | null } = { current: null }
    render(<OwnerHarness initialDraft={makeDraft(cloneTrip())} latestRef={latest} />)
    const baseSnapshot = JSON.stringify(latest.current?.base)
    let section = walkingSection(editorRegion())

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '外部正常编辑草稿' }))
    section = walkingSection(editorRegion())
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)
    expect(within(section).getByText('上限 3000 米')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '外部撤销草稿' }))
    section = walkingSection(editorRegion())
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '外部切换到第 2 天' }))
    section = walkingSection(editorRegion())
    expect(within(section).getByText('上限 3000 米')).toBeInTheDocument()
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    // 全程 base 没有被任何路径改写。
    expect(JSON.stringify(latest.current?.base)).toBe(baseSnapshot)
  })
})

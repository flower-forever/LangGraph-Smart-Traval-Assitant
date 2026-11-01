/**
 * TripDraftEditor × 步行距离检查的用户路径测试：受控 harness + 真实纯函数。
 *
 * 不 mock draftWalkingDistance：统计口径、失效与重算由真实函数在当前草稿上验证。
 * 只替换 fetch / 存储写入并断言它们没有被自动调用。
 */
import { useRef, useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Trip, TripLeg } from '../lib/api'
import {
  applyDraft,
  createTripDraft,
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

function makeDraft(base: Trip = cloneTrip(), forkTripId = 'trip-fork-walking-editor'): TripDraft {
  const created = createTripDraft(base, { forkTripId, newLegMode: 'walking' })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

function asDraft(result: DraftEditResult): TripDraft {
  if (!result.ok) throw new Error(result.message)
  return result.draft
}

interface HarnessProps {
  initialDraft: TripDraft
  initialDay?: number
  latestRef?: { current: TripDraft | null }
  onApplySpy?: (result: DraftApplySuccess) => void
  onChangeSpy?: (next: TripDraft) => void
}

function Harness({ initialDraft, initialDay = 1, latestRef, onApplySpy, onChangeSpy }: HarnessProps) {
  const [draft, setDraft] = useState(initialDraft)
  const [dayNumber, setDayNumber] = useState(initialDay)
  const idCounter = useRef(0)
  const [, forceRender] = useState(0)

  if (latestRef) latestRef.current = draft

  const handleDraftChange = (next: TripDraft) => {
    setDraft(next)
    onChangeSpy?.(next)
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
        <button type="button" onClick={() => forceRender((value) => value + 1)}>
          外部触发重渲染
        </button>
        <button
          type="button"
          onClick={() => setDraft(asDraft(updateDraftStop(draft, 1, 's2', { description: '外部更新后的描述' })))}
        >
          外部更新草稿
        </button>
        <button
          type="button"
          onClick={() => {
            const fresh = createTripDraft(initialDraft.base, {
              forkTripId: 'trip-fork-other-walking',
              newLegMode: initialDraft.newLegMode,
            })
            if (fresh.ok) setDraft(fresh.draft)
          }}
        >
          外部换 fork 草稿
        </button>
        <button
          type="button"
          onClick={() => {
            // 同一个 forkTripId、换一个 base（另一份行程副本）：验证 owner 绑定
            // 不只看 fork id，base 身份变化也要重置偏好。
            const freshBase = JSON.parse(JSON.stringify(initialDraft.base)) as Trip
            freshBase.id = `${initialDraft.base.id}-variant`
            freshBase.title = '另一份 base 的行程'
            const fresh = createTripDraft(freshBase, {
              forkTripId: initialDraft.forkTripId,
              newLegMode: initialDraft.newLegMode,
            })
            if (fresh.ok) setDraft(fresh.draft)
          }}
        >
          外部换同 fork 另一 base 草稿
        </button>
      </div>
      <TripDraftEditor
        draft={draft}
        dayNumber={dayNumber}
        onDraftChange={handleDraftChange}
        onApply={(result) => {
          onApplySpy?.(result)
        }}
        onDiscard={() => {}}
        createStopId={() => {
          idCounter.current += 1
          return `new-stop-${idCounter.current}`
        }}
      />
      <output data-testid="draft-revision">{draft.revision}</output>
    </div>
  )
}

function editorRegion(): HTMLElement {
  return screen.getByRole('region', { name: '本地行程草稿编辑器' })
}

function walkingSection(editor: HTMLElement): HTMLElement {
  return within(editor).getByRole('region', { name: '每天步行距离上限（偏好检查）' })
}

function enableAndCheck(
  user: ReturnType<typeof userEvent.setup>,
  section: HTMLElement,
): Promise<void> {
  return (async () => {
    await user.click(within(section).getByRole('checkbox', { name: /启用每天步行距离检查/ }))
    await user.click(within(section).getByRole('button', { name: '检查' }))
  })()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('每天步行距离上限偏好：默认状态与显式检查', () => {
  it('默认关闭：无结果、输入与范围禁用、按钮禁用；原 endtime / 站点上限区块不受影响', () => {
    render(<Harness initialDraft={makeDraft()} />)
    const editor = editorRegion()
    const section = walkingSection(editor)

    expect(within(section).getByText('未启用')).toBeInTheDocument()
    expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()
    expect(
      within(section).getByRole('textbox', { name: '每天步行距离上限' }),
    ).toBeDisabled()
    expect(
      within(section).getByRole('combobox', { name: '步行距离检查范围' }),
    ).toBeDisabled()
    expect(within(section).getByRole('button', { name: '检查' })).toBeDisabled()
    // 未检查时没有任何天级结论，也没有自动跑检查
    expect(within(section).queryByText(/已记录导航步行距离合计/)).toBeNull()

    // 旧偏好区块原样存在
    expect(
      within(editor).getByRole('region', { name: '每天最多站点数（偏好检查）' }),
    ).toBeInTheDocument()
    expect(
      within(editor).getByRole('region', { name: '每天最晚结束时间（偏好检查）' }),
    ).toBeInTheDocument()
  })

  it('启用后显式检查：按夹具第 1 天 walking navigation 1100 米出「未发现超限」并含固定口径', async () => {
    const user = userEvent.setup()
    render(<Harness initialDraft={makeDraft()} />)
    const editor = editorRegion()
    const section = walkingSection(editor)

    await enableAndCheck(user, section)
    // 夹具第 1 天：s1→s2 walking navigation 1100 米；s2→s3 是 driving straight_line。
    expect(within(section).getByText('上限 3000 米')).toBeInTheDocument()
    expect(within(section).getAllByText(/已记录导航步行距离合计 1100 米/).length).toBeGreaterThan(0)
    expect(within(section).getAllByText(/未发现超限/).length).toBeGreaterThan(0)
    expect(within(section).getAllByText(/不代表实际全天步行量/).length).toBeGreaterThan(0)
    expect(within(section).getByText(/仅统计标记为导航步行的有效距离记录/)).toBeInTheDocument()
    // 明细行：1 段纳入、1 段驾车不计入
    expect(within(section).getAllByText(/纳入 1 段导航步行/).length).toBeGreaterThan(0)
    expect(within(section).getAllByText(/1 段驾车不计入步行/).length).toBeGreaterThan(0)
  })

  it('上限 0 是合法输入：有已记录距离就报「已记录超限」，空不是 0', async () => {
    const user = userEvent.setup()
    render(<Harness initialDraft={makeDraft()} />)
    const editor = editorRegion()
    const section = walkingSection(editor)
    const input = within(section).getByRole('textbox', { name: '每天步行距离上限' })

    await user.click(within(section).getByRole('checkbox', { name: /启用每天步行距离检查/ }))
    await user.clear(input)
    await user.type(input, '0')
    await user.click(within(section).getByRole('button', { name: '检查' }))
    expect(within(section).getAllByText('已记录超限').length).toBeGreaterThan(0)
    expect(within(section).getAllByText(/超过你设置的每天 0 米上限/).length).toBeGreaterThan(0)

    // 空输入不等于 0：明确报「留空不等于 0」，不静默按 0 检查
    await user.clear(input)
    await user.click(within(section).getByRole('button', { name: '检查' }))
    expect(within(section).getByRole('alert')).toHaveTextContent(/留空不等于 0/)
    expect(within(section).queryByText(/已记录导航步行距离合计/)).toBeNull()
  })

  it('非法输入（负数 / 小数 / 非数 / 超限）明示报错且不产生结果；仅此检查不阻断原编辑与应用', async () => {
    const user = userEvent.setup()
    const onApplySpy = vi.fn()
    const latest: { current: TripDraft | null } = { current: null }
    render(<Harness initialDraft={makeDraft()} latestRef={latest} onApplySpy={onApplySpy} />)
    const editor = editorRegion()
    const section = walkingSection(editor)
    const input = within(section).getByRole('textbox', { name: '每天步行距离上限' })

    await user.click(within(section).getByRole('checkbox', { name: /启用每天步行距离检查/ }))
    for (const bad of ['-5', '3.5', 'abc', '100001']) {
      await user.clear(input)
      await user.type(input, bad)
      await user.click(within(section).getByRole('button', { name: '检查' }))
      expect(within(section).getByRole('alert'), bad).toBeInTheDocument()
      expect(within(section).queryByText(/已记录导航步行距离合计/)).toBeNull()
    }

    // 修回合法值再检查后正常出结果
    await user.clear(input)
    await user.type(input, '1000')
    await user.click(within(section).getByRole('button', { name: '检查' }))
    expect(within(section).getAllByText('已记录超限').length).toBeGreaterThan(0)

    // 检查处于超限提示状态也不阻断原编辑路径：改描述保存 → 应用成功
    await user.click(within(editor).getByRole('button', { name: '编辑第 1 站「断桥残雪」' }))
    const description = within(editor).getByLabelText('描述')
    await user.clear(description)
    await user.type(description, '步行检查不阻断应用')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await user.click(within(editor).getByRole('button', { name: '应用草稿' }))
    expect(onApplySpy).toHaveBeenCalledTimes(1)
  })

  it('范围 changed_days 且没有改动天：明确「没有已改动过的天可检查」，不冒「未超限」', async () => {
    const user = userEvent.setup()
    render(<Harness initialDraft={makeDraft()} />)
    const editor = editorRegion()
    const section = walkingSection(editor)
    const scopeSelect = within(section).getByRole('combobox', { name: '步行距离检查范围' })

    await user.click(within(section).getByRole('checkbox', { name: /启用每天步行距离检查/ }))
    await user.selectOptions(scopeSelect, 'changed_days')
    await user.click(within(section).getByRole('button', { name: '检查' }))
    expect(within(section).getByText(/没有已改动过的天可检查/)).toBeInTheDocument()
    expect(within(section).queryByText(/已记录导航步行距离合计/)).toBeNull()
    expect(within(section).queryByText(/未发现超限/)).toBeNull()
  })
})

describe('步行距离检查：输入 / 范围 / 开关变化与结果失效', () => {
  it('修改输入或范围立即清除旧结果；重新检查按新设置出结论', async () => {
    const user = userEvent.setup()
    render(<Harness initialDraft={makeDraft()} />)
    const editor = editorRegion()
    const section = walkingSection(editor)
    const input = within(section).getByRole('textbox', { name: '每天步行距离上限' })
    const scopeSelect = within(section).getByRole('combobox', { name: '步行距离检查范围' })

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.clear(input)
    await user.type(input, '500')
    expect(within(section).queryByText(/合计 1100 米/)).toBeNull()
    expect(within(section).queryByRole('alert')).toBeNull()
    expect(within(section).getByText('已启用，待检查')).toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: '检查' }))
    expect(within(section).getAllByText('已记录超限').length).toBeGreaterThan(0)

    await user.selectOptions(scopeSelect, 'changed_days')
    expect(within(section).queryByText(/已记录超限/)).toBeNull()
    expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()
  })

  it('关闭开关清除结果；重新开启回到「已启用，待检查」，不残留旧结论', async () => {
    const user = userEvent.setup()
    render(<Harness initialDraft={makeDraft()} />)
    const editor = editorRegion()
    const section = walkingSection(editor)
    const toggle = within(section).getByRole('checkbox', { name: /启用每天步行距离检查/ })

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.click(toggle)
    expect(within(section).getByText('未启用')).toBeInTheDocument()
    expect(within(section).queryByText(/合计 1100 米/)).toBeNull()
    expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()

    await user.click(toggle)
    expect(within(section).getByText('已启用，待检查')).toBeInTheDocument()
    expect(within(section).queryByText(/合计 1100 米/)).toBeNull()
  })

  it('同草稿编辑使路段失效后按当前 legs 重算：改 s2 地址后 navigation 变 unavailable，合计变「暂无可统计」', async () => {
    const user = userEvent.setup()
    const latest: { current: TripDraft | null } = { current: null }
    render(<Harness initialDraft={makeDraft()} latestRef={latest} />)
    const editor = editorRegion()
    const section = walkingSection(editor)

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    // 改 s2 的地址：s1→s2 的 walking navigation 失效为 unavailable（距离 null）。
    await user.click(within(editor).getByRole('button', { name: '编辑第 2 站「平湖秋月」' }))
    const address = within(editor).getByLabelText('地址')
    await user.clear(address)
    await user.type(address, '孤山路改线 2 号')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))

    // 不能拿旧距离合计：结果立即按当前 legs 重新汇总，这一天已没有可纳入段。
    const day1 = within(section).getAllByText(/暂无可统计的导航步行距离/).length
    expect(day1).toBeGreaterThan(0)
    expect(within(section).queryByText(/合计 1100 米/)).toBeNull()
    const legs = latest.current?.days.find((day) => day.day === 1)?.legs ?? []
    expect(legs[0].route_type).toBe('unavailable')
    expect(legs[0].distance_m).toBeNull()
  })

  it('编辑后按当前 legs 重算、撤销恢复；同草稿切天设置与结果不丢', async () => {
    const user = userEvent.setup()
    const latest: { current: TripDraft | null } = { current: null }
    render(<Harness initialDraft={makeDraft()} latestRef={latest} />)
    const editor = editorRegion()
    const section = walkingSection(editor)

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    // 先做一次可撤销的真实编辑（改 s1 时间：不清坐标、不失效路线），再撤销回原值。
    await user.click(within(editor).getByRole('button', { name: '编辑第 1 站「断桥残雪」' }))
    const time = within(editor).getByLabelText(/^时间/)
    await user.clear(time)
    await user.type(time, '09:40')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    // 时间编辑不改 legs：合计仍是 1100（按当前草稿重算，不因编辑而丢）。
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    await user.click(within(editorRegion()).getByRole('button', { name: '撤销草稿操作' }))
    const afterUndo = walkingSection(editorRegion())
    expect(within(afterUndo).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    // 同草稿切到第 2 天（空日）：设置与结果都保留，空日单独「暂无数据」。
    await user.click(screen.getByRole('button', { name: '外部切换到第 2 天' }))
    const onDay2 = walkingSection(editorRegion())
    expect(within(onDay2).getByText('上限 3000 米')).toBeInTheDocument()
    expect(within(onDay2).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)
    expect(within(onDay2).getAllByText(/暂无可统计的导航步行距离/).length).toBeGreaterThan(0)
  })

  it('换 forkTripId 后步行距离偏好重置：开关、输入、范围与结果回默认，A-B-A 不复活', async () => {
    const user = userEvent.setup()
    render(<Harness initialDraft={makeDraft()} />)
    const editor = editorRegion()
    let section = walkingSection(editor)
    const input = within(section).getByRole('textbox', { name: '每天步行距离上限' })

    await user.click(within(section).getByRole('checkbox', { name: /启用每天步行距离检查/ }))
    await user.clear(input)
    await user.type(input, '500')
    await user.click(within(section).getByRole('button', { name: '检查' }))
    expect(within(section).getAllByText('已记录超限').length).toBeGreaterThan(0)

    // 换 fork：偏好整体回默认，旧 run 与结论不带走
    await user.click(screen.getByRole('button', { name: '外部换 fork 草稿' }))
    section = walkingSection(editorRegion())
    expect(within(section).getByText('未启用')).toBeInTheDocument()
    expect(
      within(section).getByRole('textbox', { name: '每天步行距离上限' }),
    ).toHaveValue('3000')
    expect(
      within(section).getByRole('combobox', { name: '步行距离检查范围' }),
    ).toHaveValue('all_days')
    expect(within(section).queryByText(/已记录超限/)).toBeNull()
    expect(within(section).queryByText(/第 \d+ 天/)).toBeNull()

    // A-B-A：换回原 fork 身份的新草稿同样不带旧 run（不是复活旧结论）
    await user.click(screen.getByRole('button', { name: '外部换 fork 草稿' }))
    section = walkingSection(editorRegion())
    expect(within(section).getByText('未启用')).toBeInTheDocument()
    expect(within(section).queryByText(/已记录超限/)).toBeNull()
  })

  it('同 forkTripId 换 base 草稿同样重置：旧 run / 旧结论不套到新 base 上', async () => {
    const user = userEvent.setup()
    render(<Harness initialDraft={makeDraft()} />)
    const section = walkingSection(editorRegion())
    const input = within(section).getByRole('textbox', { name: '每天步行距离上限' })

    await user.click(within(section).getByRole('checkbox', { name: /启用每天步行距离检查/ }))
    await user.clear(input)
    await user.type(input, '500')
    await user.click(within(section).getByRole('button', { name: '检查' }))
    expect(within(section).getAllByText('已记录超限').length).toBeGreaterThan(0)

    // 同一个 forkTripId、另一个 base（另一个行程）的草稿：偏好必须回默认，
    // 旧 run 不能套在别人的 base 上继续出「已记录超限」。
    await user.click(screen.getByRole('button', { name: '外部换同 fork 另一 base 草稿' }))
    const after = walkingSection(editorRegion())
    expect(within(after).getByText('未启用')).toBeInTheDocument()
    expect(
      within(after).getByRole('textbox', { name: '每天步行距离上限' }),
    ).toHaveValue('3000')
    expect(within(after).queryByText(/已记录超限/)).toBeNull()
    expect(within(after).queryByText(/第 \d+ 天/)).toBeNull()
  })

  it('同 draft 对象原地改 legs.distance_m 后重渲染：结果按当前 legs 重算，不残留旧合计', async () => {
    const user = userEvent.setup()
    const holder: { current: TripDraft | null } = { current: null }
    render(<Harness initialDraft={makeDraft()} latestRef={holder} />)
    const section = walkingSection(editorRegion())

    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    // 同一个 draft 对象原地改 legs 的 distance_m（不换引用、不动 revision），
    // 再触发一次普通重渲染：结果必须按当前内容重读，不能吃旧 memo。
    const draft = holder.current
    if (!draft) throw new Error('draft missing')
    const day1 = draft.days.find((item) => item.day === 1)
    if (!day1) throw new Error('day 1 missing')
    day1.legs[0].distance_m = 900
    await user.click(screen.getByRole('button', { name: '外部触发重渲染' }))
    expect(within(section).getAllByText(/合计 900 米/).length).toBeGreaterThan(0)
    expect(within(section).queryByText(/合计 1100 米/)).toBeNull()
  })
})

describe('步行距离检查：无自动副作用', () => {
  it('检查过程不写存储、不发网络请求；应用路径照常可用', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network disabled in test')))
    vi.stubGlobal('fetch', fetchSpy)
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const onApplySpy = vi.fn()
    const draft = makeDraft()
    render(<Harness initialDraft={draft} onApplySpy={onApplySpy} />)
    const editor = editorRegion()

    await enableAndCheck(user, walkingSection(editor))
    expect(within(walkingSection(editorRegion())).getAllByText(/合计 1100 米/).length).toBeGreaterThan(0)

    // 原编辑与应用路径照常
    await user.click(within(editor).getByRole('button', { name: '编辑第 1 站「断桥残雪」' }))
    const time = within(editor).getByLabelText(/^时间/)
    await user.clear(time)
    await user.type(time, '09:40')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await user.click(within(editor).getByRole('button', { name: '应用草稿' }))
    expect(onApplySpy).toHaveBeenCalledTimes(1)
    const applied = onApplySpy.mock.calls[0][0] as DraftApplySuccess
    expect(applied.trip.warnings.join('\n')).not.toContain('步行距离')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getItemSpy).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(applyDraft(draft).ok).toBe(true)
  })

  it('driving-only 夹具不推步行：全驾车一天显示「暂无数据」且不出现「0 米」结论', async () => {
    const user = userEvent.setup()
    const base = cloneTrip()
    const legs: TripLeg[] = base.days[0].legs.map((item) => ({
      ...item,
      mode: 'driving',
      route_type: 'navigation',
    }))
    base.days[0].legs = legs
    render(<Harness initialDraft={makeDraft(base)} />)
    const section = walkingSection(editorRegion())
    await enableAndCheck(user, section)
    expect(within(section).getAllByText(/暂无可统计的导航步行距离/).length).toBeGreaterThan(0)
    expect(within(section).getAllByText(/2 段驾车不计入步行/).length).toBeGreaterThan(0)
    expect(within(section).queryByText(/已记录导航步行距离合计 0 米/)).toBeNull()
  })
})

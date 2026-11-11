/**
 * S8 · 体检条目级动作入口测试。
 *
 * 只对 notice 的 pace / meal_gap 条目给按钮；unknown / warning 与其它 code 不出按钮；
 * 点击只把条目交给父级，不直接写任何数据。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import HealthActionEntry from '../components/HealthActionEntry'
import type { HealthItem } from '../lib/itineraryHealth'

afterEach(cleanup)

const PACE: HealthItem = {
  code: 'pace',
  level: 'notice',
  message: '行程比均衡节奏偏紧。',
  evidence: '第 1→2 站缓冲约 5 分钟。',
  suggestion: '可删减站点或拉长时间。',
}

const MEAL: HealthItem = {
  code: 'meal_gap',
  level: 'notice',
  message: '正餐窗口偏紧。',
  evidence: '午餐窗口最大空档 20 分钟。',
  suggestion: '可留出用餐时间。',
}

describe('HealthActionEntry', () => {
  it('pace notice 显示「建议顺延」，点击把条目交给父级', async () => {
    const user = userEvent.setup()
    const onSuggestPostpone = vi.fn()
    render(<HealthActionEntry item={PACE} onSuggestPostpone={onSuggestPostpone} />)
    await user.click(screen.getByTestId('health-suggest-postpone'))
    expect(onSuggestPostpone).toHaveBeenCalledWith(PACE)
    expect(screen.queryByTestId('health-suggest-meal')).toBeNull()
  })

  it('meal_gap notice 显示「补一餐」，点击把条目交给父级', async () => {
    const user = userEvent.setup()
    const onSuggestMeal = vi.fn()
    render(<HealthActionEntry item={MEAL} onSuggestMeal={onSuggestMeal} />)
    await user.click(screen.getByTestId('health-suggest-meal'))
    expect(onSuggestMeal).toHaveBeenCalledWith(MEAL)
    expect(screen.queryByTestId('health-suggest-postpone')).toBeNull()
  })

  it('unknown / warning 与其它 code 不出按钮', () => {
    const { rerender } = render(
      <HealthActionEntry
        item={{ ...PACE, level: 'unknown' }}
        onSuggestPostpone={vi.fn()}
        onSuggestMeal={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('health-action-entry')).toBeNull()

    rerender(
      <HealthActionEntry
        item={{ ...MEAL, level: 'warning' }}
        onSuggestPostpone={vi.fn()}
        onSuggestMeal={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('health-action-entry')).toBeNull()

    rerender(
      <HealthActionEntry
        item={{ ...PACE, code: 'backtrack' }}
        onSuggestPostpone={vi.fn()}
        onSuggestMeal={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('health-action-entry')).toBeNull()
  })

  it('父级未提供回调时保持纯展示，不凭空出按钮', () => {
    render(<HealthActionEntry item={PACE} />)
    expect(screen.queryByTestId('health-action-entry')).toBeNull()
  })
})

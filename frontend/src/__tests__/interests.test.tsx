/**
 * S6 · 个性化兴趣：枚举、归一化、展示文案与结果页标注的定向测试。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import InterestTag from '../components/InterestTag'
import {
  INTEREST_OPTIONS,
  PLAN_INTEREST_VALUES,
  interestLabelOf,
  interestSummary,
  isPlanInterest,
  normalizeInterests,
} from '../lib/interests'

describe('S6 · 兴趣枚举与归一化', () => {
  it('提供 6 个固定兴趣选项，顺序固定', () => {
    expect(PLAN_INTEREST_VALUES).toEqual([
      'history',
      'food',
      'nature',
      'photo',
      'family',
      'elder_friendly',
    ])
    expect(INTEREST_OPTIONS.map((option) => option.value)).toEqual([...PLAN_INTEREST_VALUES])
    for (const option of INTEREST_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.help.length).toBeGreaterThan(0)
    }
  })

  it('未知值被丢弃，不透传', () => {
    expect(isPlanInterest('history')).toBe(true)
    expect(isPlanInterest('shopping')).toBe(false)
    expect(isPlanInterest(null)).toBe(false)
    expect(normalizeInterests(['history', 'shopping', 42, 'food'])).toEqual(['history', 'food'])
  })

  it('去重并按固定顺序归一', () => {
    expect(normalizeInterests(['food', 'history', 'food'])).toEqual(['history', 'food'])
    expect(normalizeInterests(['photo', 'nature'])).toEqual(['nature', 'photo'])
  })

  it('空数组与非数组都归一成空数组', () => {
    expect(normalizeInterests([])).toEqual([])
    expect(normalizeInterests(null)).toEqual([])
    expect(normalizeInterests(undefined)).toEqual([])
    expect(normalizeInterests('history' as unknown as unknown[])).toEqual([])
  })

  it('展示文案用中文名；空时是空字符串', () => {
    expect(interestLabelOf('history')).toBe('历史')
    expect(interestLabelOf('elder_friendly')).toBe('老人友好')
    expect(interestSummary(['history', 'food'])).toBe('历史、美食')
    expect(interestSummary([])).toBe('')
  })
})

describe('S6 · 结果页兴趣标注', () => {
  afterEach(() => {
    cleanup()
  })

  it('渲染「兴趣：历史、美食」，并带上可断言的 testid', () => {
    render(<InterestTag interests={['history', 'food']} />)
    const tag = screen.getByTestId('interest-tag')
    expect(tag.textContent).toBe('兴趣：历史、美食')
    expect(tag).toHaveAttribute('data-interests', 'history,food')
  })

  it('不选兴趣时不渲染任何标注', () => {
    const { container } = render(<InterestTag interests={[]} />)
    expect(screen.queryByTestId('interest-tag')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('不显示任何评分或百分比', () => {
    render(<InterestTag interests={['nature']} />)
    const text = screen.getByTestId('interest-tag').textContent ?? ''
    expect(text).not.toMatch(/[0-9]+\s*%/)
    expect(text).not.toMatch(/评分|得分|匹配度/)
  })
})

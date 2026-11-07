import { describe, expect, it } from 'vitest'

import {
  CHECKLIST_SEASON_LABELS,
  checklistSuggestionSeason,
  suggestChecklistItems,
  type ChecklistSuggestionInput,
} from '../lib/checklistSuggestions'

const CATEGORIES = ['ticket', 'appointment', 'document', 'luggage', 'todo']

const BASE: ChecklistSuggestionInput = {
  destination: '青岛',
  days: 2,
  month: 7,
  existingItems: [],
}

describe('checklistSuggestions · 纯本地生成', () => {
  it('同输入恒同输出；条数有上限、id / 标题不重复、分类合法', () => {
    const input: ChecklistSuggestionInput = {
      destination: '海岛山地乐园温泉',
      days: 7,
      month: 8,
      existingItems: [],
    }
    const first = suggestChecklistItems(input)
    const second = suggestChecklistItems(input)

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(10)
    expect(new Set(first.map((suggestion) => suggestion.id)).size).toBe(first.length)
    expect(new Set(first.map((suggestion) => suggestion.title)).size).toBe(first.length)
    for (const suggestion of first) {
      expect(CATEGORIES).toContain(suggestion.category)
      expect(suggestion.reason.trim().length).toBeGreaterThan(0)
    }
  })

  it('夏天海边给出防晒与雨具，且始终包含证件类核心建议', () => {
    const list = suggestChecklistItems(BASE)
    expect(list.some((suggestion) => suggestion.title.includes('防晒'))).toBe(true)
    expect(list.some((suggestion) => suggestion.title.includes('折叠伞'))).toBe(true)
    expect(list.some((suggestion) => suggestion.title === '证件复印件与离线备份')).toBe(true)
    expect(list.some((suggestion) => suggestion.title === '手机充电器与数据线')).toBe(true)
  })

  it('冬天山里给保暖建议，不给夏季防晒', () => {
    const list = suggestChecklistItems({
      destination: '长白山',
      days: 2,
      month: 1,
      existingItems: [],
    })
    expect(list.some((suggestion) => suggestion.title.includes('保暖内衣'))).toBe(true)
    expect(list.some((suggestion) => suggestion.title.includes('防晒'))).toBe(false)
    expect(list.some((suggestion) => suggestion.title.includes('驱蚊'))).toBe(false)
  })

  it('按天数增加换洗与洗衣建议，短行程不出现', () => {
    const short = suggestChecklistItems({
      destination: '杭州',
      days: 2,
      month: 3,
      existingItems: [],
    })
    const long = suggestChecklistItems({
      destination: '杭州',
      days: 5,
      month: 3,
      existingItems: [],
    })
    const week = suggestChecklistItems({
      destination: '杭州',
      days: 7,
      month: 3,
      existingItems: [],
    })

    expect(short.some((suggestion) => suggestion.title === '换洗衣物与收纳袋')).toBe(false)
    expect(long.some((suggestion) => suggestion.title === '换洗衣物与收纳袋')).toBe(true)
    expect(week.some((suggestion) => suggestion.title === '旅行装洗衣液或晾衣绳')).toBe(true)
  })

  it('清单已有同标题时标记 duplicateOf，不自动合并、不修改输入', () => {
    const existingItems = [{ title: '证件复印件与离线备份' }]
    const snapshot = JSON.parse(JSON.stringify(existingItems))
    const list = suggestChecklistItems({ ...BASE, existingItems })
    const doc = list.find((suggestion) => suggestion.title === '证件复印件与离线备份')

    expect(doc?.duplicateOf).toEqual(['证件复印件与离线备份'])
    expect(list.filter((suggestion) => suggestion.title === '证件复印件与离线备份')).toHaveLength(1)
    expect(existingItems).toEqual(snapshot)
  })

  it('月份非法时不按季节推断，只保留非季节建议', () => {
    for (const month of [null, 0, 13, 1.5]) {
      const list = suggestChecklistItems({
        destination: '',
        days: 1,
        month: month as number | null,
        existingItems: [],
      })
      expect(list.some((suggestion) => suggestion.title.includes('防晒'))).toBe(false)
      expect(list.some((suggestion) => suggestion.title.includes('保暖内衣'))).toBe(false)
      expect(list.some((suggestion) => suggestion.title.includes('润唇膏'))).toBe(false)
    }
  })

  it('非法天数按 1 处理，不产生多日换洗建议', () => {
    const list = suggestChecklistItems({
      destination: '',
      days: 0,
      month: null,
      existingItems: [],
    })
    expect(list.some((suggestion) => suggestion.title === '换洗衣物与收纳袋')).toBe(false)
    expect(list.some((suggestion) => suggestion.title === '常用药与创可贴')).toBe(true)
  })
})

describe('checklistSuggestions · 季节映射', () => {
  it('1–12 月映射到四季，越界与 null 返回 null', () => {
    expect(checklistSuggestionSeason(1)).toBe('winter')
    expect(checklistSuggestionSeason(3)).toBe('spring')
    expect(checklistSuggestionSeason(6)).toBe('summer')
    expect(checklistSuggestionSeason(9)).toBe('autumn')
    expect(checklistSuggestionSeason(12)).toBe('winter')
    expect(checklistSuggestionSeason(null)).toBeNull()
    expect(checklistSuggestionSeason(0)).toBeNull()
    expect(checklistSuggestionSeason(13)).toBeNull()
    expect(checklistSuggestionSeason(2.5)).toBeNull()
  })

  it('季节文案是中文固定标签', () => {
    expect(CHECKLIST_SEASON_LABELS).toEqual({
      spring: '春季',
      summer: '夏季',
      autumn: '秋季',
      winter: '冬季',
    })
  })
})

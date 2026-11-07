import { describe, expect, it } from 'vitest'

import {
  ASSISTANT_SUGGESTED_NOTE_TAG,
  CANDIDATE_PACE_LABELS,
  assistantSuggestedNote,
  derivePaceFromDraftDayStopCounts,
  suggestCandidatePlaces,
  type CandidateSuggestionInput,
} from '../lib/candidateSuggestions'

const BASE: CandidateSuggestionInput = {
  destination: '青岛',
  days: 2,
  pace: 'balanced',
}

describe('candidateSuggestions · 纯本地生成', () => {
  it('同输入恒同输出；每条都有名称 / 理由 / 场景，坐标恒为 null', () => {
    const first = suggestCandidatePlaces(BASE)
    const second = suggestCandidatePlaces(BASE)

    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(10)
    for (const suggestion of first) {
      expect(suggestion.name.trim().length).toBeGreaterThan(0)
      expect(suggestion.reason.trim().length).toBeGreaterThan(0)
      expect(suggestion.scene.trim().length).toBeGreaterThan(0)
      // 绝不补 (0,0)：坐标没有真实来源时只能是 null。
      expect(suggestion.location).toBeNull()
    }
  })

  it('目的地关键词命中海滨规则，并给出场景相关的点子', () => {
    const list = suggestCandidatePlaces(BASE)
    expect(list.some((suggestion) => suggestion.scene === '海滨')).toBe(true)
    expect(list.some((suggestion) => suggestion.name.includes('海'))).toBe(true)
  })

  it('场景规则有排除：乐园不会同时命中园林规则', () => {
    const list = suggestCandidatePlaces({ destination: '欢乐乐园', days: 1, pace: 'balanced' })
    expect(list.some((suggestion) => suggestion.name.includes('乐园开园'))).toBe(true)
    expect(list.some((suggestion) => suggestion.name.includes('园林'))).toBe(false)
    expect(list.some((suggestion) => suggestion.name.includes('社区公园'))).toBe(false)
  })

  it('节奏与天数补充项按规则出现', () => {
    const compact = suggestCandidatePlaces({ ...BASE, pace: 'compact' })
    const relaxed = suggestCandidatePlaces({ ...BASE, pace: 'relaxed' })
    const longTrip = suggestCandidatePlaces({ ...BASE, days: 5 })

    expect(compact.some((suggestion) => suggestion.name.includes('半天留白'))).toBe(true)
    expect(relaxed.some((suggestion) => suggestion.name.includes('周边小镇'))).toBe(true)
    expect(longTrip.some((suggestion) => suggestion.name === '远郊半日点')).toBe(true)
  })

  it('已有候选同名时只提示可能重复，不修改输入、不自动合并', () => {
    const existingCandidates = [
      { name: '当地早市或菜市场', address: null },
      { name: '城市制高点观景台', address: '某条路 1 号' },
    ]
    const snapshot = JSON.parse(JSON.stringify(existingCandidates))
    const list = suggestCandidatePlaces({
      ...BASE,
      destination: '',
      existingCandidates,
    })

    const market = list.find((suggestion) => suggestion.name === '当地早市或菜市场')
    const tower = list.find((suggestion) => suggestion.name === '城市制高点观景台')
    expect(market?.duplicateOf).toEqual(['当地早市或菜市场'])
    // 建议没有地址；名称相同即提示，完整 dedupeKey 仍在真正入库时判定。
    expect(tower?.duplicateOf).toEqual(['城市制高点观景台'])
    expect(existingCandidates).toEqual(snapshot)
    expect(list.filter((suggestion) => suggestion.name === '当地早市或菜市场')).toHaveLength(1)
  })

  it('多种场景叠加时截断到固定条数，名称不重复', () => {
    const list = suggestCandidatePlaces({
      destination: '海岛山地古城乐园温泉',
      days: 8,
      pace: 'compact',
    })
    expect(list).toHaveLength(10)
    expect(new Set(list.map((suggestion) => suggestion.name)).size).toBe(list.length)
  })

  it('非法天数按 1 处理；空目的地仍给通用建议', () => {
    const list = suggestCandidatePlaces({ destination: '', days: 0, pace: 'balanced' })
    expect(list.some((suggestion) => suggestion.name === '当地早市或菜市场')).toBe(true)
    expect(list.some((suggestion) => suggestion.name === '城市制高点观景台')).toBe(true)
    expect(list.some((suggestion) => suggestion.name === '远郊半日点')).toBe(false)
  })
})

describe('candidateSuggestions · 辅助函数', () => {
  it('从草稿日均站点数推导节奏', () => {
    expect(derivePaceFromDraftDayStopCounts([])).toBe('balanced')
    expect(derivePaceFromDraftDayStopCounts([5, 5])).toBe('compact')
    expect(derivePaceFromDraftDayStopCounts([2, 2])).toBe('relaxed')
    expect(derivePaceFromDraftDayStopCounts([3, 4])).toBe('balanced')
  })

  it('assistant-suggested 标记写入备注文本，source 枚举不新增', () => {
    expect(ASSISTANT_SUGGESTED_NOTE_TAG).toBe('assistant-suggested')
    expect(assistantSuggestedNote('一句话理由')).toBe('[assistant-suggested] 一句话理由')
    expect(CANDIDATE_PACE_LABELS.compact).toBe('紧凑')
  })
})

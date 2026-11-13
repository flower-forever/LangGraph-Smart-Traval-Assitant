/**
 * 七期 S7 · 候选池 / 资料卡 / 换一换 / 补一餐的城市归属过滤。
 *
 * 旧记录（无 cityId）必须保持全局可见，且往返 JSON 不新增键。
 */
import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TripDay, TripStop } from '../lib/api'
import {
  addCandidateToRecord,
  copyCandidateFromStop,
  createEmptyCandidateRecord,
  createManualCandidate,
  filterCandidates,
} from '../lib/candidatePool'
import {
  addPoiCard,
  createEmptyPoiCardsRecord,
  createPoiCard,
  updatePoiCard,
  validatePoiCardsRecord,
} from '../lib/poiCards'
import { buildSwapCandidates } from '../lib/stopSwap'
import type { CandidateItemV1 } from '../lib/workspace'
import MealSuggestPanel from '../components/MealSuggestPanel'

const NOW = 1_800_000_000_000

type CityCandidate = CandidateItemV1 & { cityId?: string | null }

function candidate(id: string, name: string, cityId?: string, tags: string[] = []): CityCandidate {
  return {
    id,
    name,
    address: null,
    notes: null,
    tags,
    priority: 1,
    location: null,
    source: 'manual',
    copiedFromStopId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...(cityId === undefined ? {} : { cityId }),
  }
}

const HANGZHOU = candidate('hz', '杭州小馆', '杭州', ['餐厅'])
const SUZHOU = candidate('sz', '苏州面馆', '苏州', ['面馆'])
const GLOBAL = candidate('global', '老字号餐厅', undefined, ['餐厅'])

describe('filterCandidates · 城市口径', () => {
  const items = [HANGZHOU, SUZHOU, GLOBAL]

  it('指定城市只返回同城 + 全局条目，顺序保持不变', () => {
    expect(filterCandidates(items, { cityId: '苏州' }).map((item) => item.id)).toEqual([
      'sz',
      'global',
    ])
    expect(filterCandidates(items, { cityId: '杭州' }).map((item) => item.id)).toEqual([
      'hz',
      'global',
    ])
  })

  it('城市名先 trim / 归一化；空串与 null 等同不过滤', () => {
    expect(filterCandidates(items, { cityId: ' 苏州 ' }).map((item) => item.id)).toEqual([
      'sz',
      'global',
    ])
    expect(filterCandidates(items, { cityId: null }).map((item) => item.id)).toEqual([
      'hz',
      'sz',
      'global',
    ])
    expect(filterCandidates(items, { cityId: '' }).map((item) => item.id)).toEqual([
      'hz',
      'sz',
      'global',
    ])
  })

  it('城市过滤与文本 / 标签过滤叠加，不修改原条目', () => {
    const snapshot = items.map((item) => ({ ...item }))
    expect(
      filterCandidates(items, { cityId: '苏州', text: '面' }).map((item) => item.id),
    ).toEqual(['sz'])
    expect(items).toEqual(snapshot)
  })
})

describe('候选库旧记录键集合不变', () => {
  const ITEM_KEYS = [
    'id',
    'name',
    'address',
    'notes',
    'tags',
    'priority',
    'location',
    'source',
    'copiedFromStopId',
    'createdAt',
    'updatedAt',
  ]

  it('手工新增 / 复制站点仍不写 cityId，往返键集合与旧版一致', () => {
    const empty = createEmptyCandidateRecord(NOW)
    expect(empty.ok).toBe(true)
    if (!empty.ok) return

    const manual = createManualCandidate({ id: 'm1', name: '西湖' }, NOW)
    expect(manual.ok).toBe(true)
    if (!manual.ok) return
    const added = addCandidateToRecord(empty.value, manual.value, NOW)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const stored = added.value.record.items[0]
    expect(Object.keys(stored)).toEqual(ITEM_KEYS)
    expect(JSON.stringify(stored)).not.toContain('cityId')

    const copied = copyCandidateFromStop(
      {
        id: 'm2',
        stop: {
          stopId: 's1',
          name: '断桥残雪',
          address: null,
          location: null,
          day: 1,
        },
      },
      NOW + 1,
    )
    expect(copied.ok).toBe(true)
    if (!copied.ok) return
    const addedCopy = addCandidateToRecord(empty.value, copied.value, NOW + 1)
    expect(addedCopy.ok).toBe(true)
    if (!addedCopy.ok) return
    expect(Object.keys(addedCopy.value.record.items[0])).toEqual(ITEM_KEYS)
  })
})

describe('poiCards · cityId 可选透传', () => {
  it('旧卡 / 新建无城市卡不新增 cityId 键', () => {
    const oldCard = createPoiCard({ id: 'p1', name: '西湖' }, NOW)
    expect(oldCard.ok).toBe(true)
    if (!oldCard.ok) return
    expect(Object.keys(oldCard.value)).toEqual([
      'id',
      'identityKey',
      'name',
      'intro',
      'openingHours',
      'ticket',
      'images',
      'provenance',
      'createdAt',
      'updatedAt',
    ])

    const empty = createEmptyPoiCardsRecord(NOW)
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    const added = addPoiCard(empty.value, oldCard.value, NOW)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const roundtrip = validatePoiCardsRecord(JSON.parse(JSON.stringify(added.value)))
    expect(roundtrip.ok).toBe(true)
    if (!roundtrip.ok) return
    expect(Object.keys(roundtrip.value.cards[0])).toEqual(Object.keys(oldCard.value))
  })

  it('新建 / 更新保留城市，清空后键被移除', () => {
    const card = createPoiCard({ id: 'p2', name: '拙政园', cityId: ' 苏州 ' }, NOW)
    expect(card.ok).toBe(true)
    if (!card.ok) return
    expect(card.value.cityId).toBe('苏州')

    const empty = createEmptyPoiCardsRecord(NOW)
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    const added = addPoiCard(empty.value, card.value, NOW)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const roundtrip = validatePoiCardsRecord(JSON.parse(JSON.stringify(added.value)))
    expect(roundtrip.ok).toBe(true)
    if (!roundtrip.ok) return
    expect(roundtrip.value.cards[0].cityId).toBe('苏州')

    const cleared = updatePoiCard(added.value, 'p2', { cityId: '   ' }, NOW + 1)
    expect(cleared.ok).toBe(true)
    if (!cleared.ok) return
    expect(cleared.value.cards[0].cityId).toBeUndefined()
    expect(Object.keys(cleared.value.cards[0])).not.toContain('cityId')
  })
})

describe('换一换 / 补一餐按城市过滤', () => {
  function makeStop(): TripStop {
    return {
      id: 's1',
      name: '平江路',
      time: '09:00',
      duration_minutes: 60,
      description: '',
      address: '',
      location: null,
    }
  }

  it('buildSwapCandidates 传 city 时只取同城 + 全局；不传时与旧行为一致', () => {
    const stop = makeStop()
    const scoped = buildSwapCandidates({
      stop,
      candidates: [HANGZHOU, SUZHOU, GLOBAL],
      now: NOW,
      city: '苏州',
    })
    expect(scoped.map((item) => item.id).sort()).toEqual(['candidate:global', 'candidate:sz'])
    expect(scoped.map((item) => item.name)).not.toContain('杭州小馆')

    const all = buildSwapCandidates({
      stop,
      candidates: [HANGZHOU, SUZHOU, GLOBAL],
      now: NOW,
    })
    expect(all.map((item) => item.id).sort()).toEqual([
      'candidate:global',
      'candidate:hz',
      'candidate:sz',
    ])
  })

  it('MealSuggestPanel 传 city 时只显示同城 + 全局；不传时全部显示', () => {
    const day: TripDay = {
      day: 1,
      date: '2026-04-03',
      title: '第一天',
      summary: '',
      stops: [
        {
          id: 's1',
          name: '早餐铺',
          time: '09:00',
          duration_minutes: 60,
          description: '',
          address: '',
          location: null,
        },
        {
          id: 's2',
          name: '下午茶',
          time: '14:00',
          duration_minutes: 60,
          description: '',
          address: '',
          location: null,
        },
      ],
      legs: [],
    }
    const props = {
      baseDay: day,
      draft: null,
      onCreateDraft: () => ({ ok: false as const, reason: 'invalid_name' as const, message: 'unused' }),
      onDraftChange: () => {},
      candidates: [HANGZHOU, SUZHOU, GLOBAL],
      createStopId: () => 'meal-stop',
      now: NOW,
      onClose: () => {},
    }

    render(createElement(MealSuggestPanel, { ...props, city: '苏州' }))
    expect(screen.queryByText('杭州小馆')).toBeNull()
    expect(screen.getByText('苏州面馆')).toBeTruthy()
    expect(screen.getByText('老字号餐厅')).toBeTruthy()

    cleanup()
    render(createElement(MealSuggestPanel, props))
    expect(screen.getByText('杭州小馆')).toBeTruthy()
    expect(screen.getByText('苏州面馆')).toBeTruthy()
    expect(screen.getByText('老字号餐厅')).toBeTruthy()
  })
})

afterEach(() => {
  cleanup()
})

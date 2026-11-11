/**
 * 六期 S5 · 景点深度投影测试。
 * 全离线：纯函数，不读写存储、不发请求。
 * 覆盖：完整 / 部分 / 坏块 / 裸数组与中文别名 / 上限 / 全缺省返回 null /
 * 字段级不做过期（输出恰好四个展示字段，没有 stale）。
 */
import { describe, expect, it } from 'vitest'
import type { TripStop } from '../lib/api'
import {
  STOP_DEPTH_MAX_ITEM_LENGTH,
  projectStopDepth,
} from '../lib/stopDepth'

function makeStop(depth: Partial<TripStop> = {}): TripStop {
  return {
    id: 's1',
    name: '断桥残雪',
    time: '09:00',
    duration_minutes: 40,
    description: '',
    address: '',
    location: null,
    ...depth,
  }
}

const fullDepth = {
  highlights: {
    items: ['湖面开阔，长堤一线', '春晓时分光线柔和'],
    source: 'model_generated' as const,
  },
  suitableFor: {
    tags: ['nature', 'photo'],
    source: 'model_generated' as const,
  },
  suggestedStayMinutes: { min: 60, max: 90, source: 'model_generated' as const },
  tips: {
    items: ['清晨与傍晚人少', '沿堤可步行串联北山街'],
    source: 'model_generated' as const,
  },
}

describe('projectStopDepth · 完整与部分', () => {
  it('完整深度：四块全部投影，适合标签映射中文', () => {
    const view = projectStopDepth(makeStop(fullDepth))
    expect(view).not.toBeNull()
    expect(view?.highlights).toEqual(['湖面开阔，长堤一线', '春晓时分光线柔和'])
    expect(view?.suitableFor).toEqual([
      { value: 'nature', label: '自然' },
      { value: 'photo', label: '拍照' },
    ])
    expect(view?.suggestedStayMinutes).toEqual({ min: 60, max: 90 })
    expect(view?.tips).toEqual(['清晨与傍晚人少', '沿堤可步行串联北山街'])
  })

  it('部分深度：只有一块时不补造其它块', () => {
    const view = projectStopDepth(
      makeStop({ highlights: { items: ['只有看点'], source: 'model_generated' } }),
    )
    expect(view?.highlights).toEqual(['只有看点'])
    expect(view?.suitableFor).toEqual([])
    expect(view?.suggestedStayMinutes).toBeNull()
    expect(view?.tips).toEqual([])
  })

  it('无深度 / 空深度 / 坏深度：返回 null（组件据此不渲染）', () => {
    expect(projectStopDepth(null)).toBeNull()
    expect(projectStopDepth(undefined)).toBeNull()
    expect(projectStopDepth(makeStop())).toBeNull()
    const malformed = makeStop({
      highlights: { items: [], source: 'model_generated' },
      suitableFor: { tags: ['not-a-tag'], source: 'model_generated' },
      suggestedStayMinutes: { min: 90, max: 30, source: 'model_generated' },
      tips: { items: ['   '], source: 'model_generated' },
    })
    expect(projectStopDepth(malformed)).toBeNull()
  })

  it('输出恰好四个展示字段：深度字段不参与 180 天过期标记', () => {
    const view = projectStopDepth(makeStop(fullDepth))
    expect(Object.keys(view ?? {}).sort()).toEqual([
      'highlights',
      'suggestedStayMinutes',
      'suitableFor',
      'tips',
    ])
    expect(view).not.toHaveProperty('stale')
    expect(view).not.toHaveProperty('recordedAt')
  })
})

describe('projectStopDepth · 容错与上限', () => {
  it('裸数组形态与中文标签别名都能收下', () => {
    const view = projectStopDepth(
      makeStop({
        highlights: ['裸数组看点'],
        suitableFor: ['历史', '老人友好', 'unknown'],
        tips: ['裸数组贴士'],
      } as unknown as Partial<TripStop>),
    )
    expect(view?.highlights).toEqual(['裸数组看点'])
    expect(view?.suitableFor).toEqual([
      { value: 'history', label: '历史' },
      { value: 'elder_friendly', label: '老人友好' },
    ])
    expect(view?.tips).toEqual(['裸数组贴士'])
  })

  it('文本空白归一、超长截断、重复条目去重', () => {
    const long = '很长的看点'.repeat(40)
    const view = projectStopDepth(
      makeStop({
        highlights: {
          items: ['  湖面   开阔  ', '湖面 开阔', long],
          source: 'model_generated',
        },
      }),
    )
    expect(view?.highlights).toHaveLength(2)
    expect(view?.highlights[0]).toBe('湖面 开阔')
    expect(view?.highlights[1]).toHaveLength(STOP_DEPTH_MAX_ITEM_LENGTH)
  })

  it('看点 / 贴士最多 3 条、适合标签最多 6 个', () => {
    const view = projectStopDepth(
      makeStop({
        highlights: {
          items: ['A', 'B', 'C', 'D'],
          source: 'model_generated',
        },
        suitableFor: {
          tags: ['history', 'food', 'nature', 'photo', 'family', 'elder_friendly', 'history'],
          source: 'model_generated',
        },
        tips: { items: ['T1', 'T2', 'T3', 'T4'], source: 'model_generated' },
      }),
    )
    expect(view?.highlights).toEqual(['A', 'B', 'C'])
    expect(view?.suitableFor.map((tag) => tag.value)).toEqual([
      'history',
      'food',
      'nature',
      'photo',
      'family',
      'elder_friendly',
    ])
    expect(view?.tips).toEqual(['T1', 'T2', 'T3'])
  })

  it('建议停留必须是整数区间且在 5–1440 分钟内', () => {
    const outOfRange = makeStop({
      suggestedStayMinutes: { min: 1, max: 2000, source: 'model_generated' },
    })
    expect(projectStopDepth(outOfRange)).toBeNull()

    const fractional = makeStop({
      suggestedStayMinutes: { min: 30.5, max: 60, source: 'model_generated' },
    })
    expect(projectStopDepth(fractional)).toBeNull()
  })
})

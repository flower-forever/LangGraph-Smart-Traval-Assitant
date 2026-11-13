/**
 * 六期 S4 · cityProfile 投影补充测试（七期 S8 · S6-30）。
 *
 * 只钉一件事：经典清单必须先过滤空名 / 去重，再截断到 15 条。
 * 旧实现先 slice(0, 15) 再过滤，前部脏数据会把后面的有效条目挤掉，结果可能 < 15。
 */
import { describe, expect, it } from 'vitest'
import type { CityProfile, CityProfileClassicItem } from '../lib/api'
import { projectCityProfile } from '../lib/cityProfile'

function classic(name: string, reason = ''): CityProfileClassicItem {
  return { name, reason, source: 'model_generated' }
}

describe('城市导览 · 经典清单裁剪顺序（S6-30）', () => {
  it('前部空名与重复不挤占配额：输出 15 条、全部非空、无重复、顺序保持输入顺序', () => {
    // 20 条有效且互不重复的候选，按 00–19 顺序排列。
    const validNames = Array.from({ length: 20 }, (_, index) =>
      `经典景点${String(index).padStart(2, '0')}`,
    )

    // 前部脏数据：3 条空名 + 2 条重复（重复的是最早出现的两个有效名）。
    const classicList: CityProfileClassicItem[] = [
      classic('   ', '空名 1'),
      classic('', '空名 2'),
      classic('经典景点00', '第一条有效'),
      classic('经典景点01', '第二条有效'),
      classic('经典景点00', '重复 1'),
      classic('经典景点01', '重复 2'),
      classic(' \t ', '空名 3'),
      ...validNames.slice(2).map((name, index) => classic(name, `有效 ${index + 2}`)),
    ]

    const view = projectCityProfile({
      source: 'model_generated',
      classicList,
    } as CityProfile)

    expect(view).not.toBeNull()
    const list = view?.classicList ?? []
    expect(list).toHaveLength(15)
    expect(list.every((item) => item.name.trim().length > 0)).toBe(true)
    expect(new Set(list.map((item) => item.name)).size).toBe(15)
    expect(list.map((item) => item.name)).toEqual(validNames.slice(0, 15))
    expect(list[0].reason).toBe('第一条有效')
  })
})

/**
 * 六期 S6 · 选择充分度投影测试（lib/tripCoverage.ts）。
 * 全离线纯函数：不读写存储、不发请求。
 * 覆盖：精确命中 / NFKC 全角·大小写·空白容忍 / 简繁按既有口径不折叠（如实未识别）/
 * 多站点同经典 / 未识别站点不进统计 / 空与残缺 classicList 不渲染 / 上限 / 坏 days 防御。
 */
import { describe, expect, it } from 'vitest'

import type { CityProfile, TripDay } from '../lib/api'
import { projectTripCoverage, tripCoverageNameKey } from '../lib/tripCoverage'

function profileWithClassics(classics: Array<{ name: string; reason?: string }>): CityProfile {
  return {
    source: 'model_generated',
    classicList: classics.map((item) => ({
      name: item.name,
      reason: item.reason ?? `${item.name}的理由`,
      source: 'model_generated' as const,
    })),
  }
}

function daysWithStops(stopNames: string[]): TripDay[] {
  return [
    {
      day: 1,
      date: null,
      title: '第一天',
      summary: '',
      stops: stopNames.map((name, index) => ({
        id: `stop-${index}`,
        name,
        time: '09:00',
        duration_minutes: null,
        description: '',
        address: '',
        location: null,
      })),
      legs: [],
    },
  ]
}

describe('tripCoverageNameKey · 归一化口径与 findPoiCardByName 同款', () => {
  it('NFKC + 空白折叠 + 小写；与 normalizeCandidateText 输出一致', () => {
    expect(tripCoverageNameKey('  Ｗｅｓｔ   ＬＡＫＥ ')).toBe('west lake')
    expect(tripCoverageNameKey('西湖（断桥）')).toBe(tripCoverageNameKey('西湖(断桥)'))
  })
})

describe('projectTripCoverage · 已覆盖 / 未安排 / 统计', () => {
  it('命中的经典项进 covered 并记录匹配站点；未命中进 uncovered；X/N 正确', () => {
    const view = projectTripCoverage(
      daysWithStops(['苏堤春晓', '浙江省博物馆', '九溪烟树']),
      profileWithClassics([
        { name: '苏堤春晓' },
        { name: '浙江省博物馆', reason: '镇馆之宝' },
        { name: '断桥' },
        { name: '灵隐寺' },
      ]),
    )
    expect(view).not.toBeNull()
    expect(view!.total).toBe(4)
    expect(view!.covered.map((item) => item.name)).toEqual(['苏堤春晓', '浙江省博物馆'])
    expect(view!.covered[0]!.matchedStops).toEqual(['苏堤春晓'])
    expect(view!.covered[1]!.reason).toBe('镇馆之宝')
    expect(view!.uncovered.map((item) => item.name)).toEqual(['断桥', '灵隐寺'])
    // 已覆盖 2/4 · 未安排 2 条：两侧互补，X + Y = N
    expect(view!.covered.length + view!.uncovered.length).toBe(view!.total)
  })

  it('同一经典项被多个同名站点覆盖：matchedStops 去重保序、只计一条', () => {
    const days = daysWithStops(['断桥'])
    days.push({
      day: 2,
      date: null,
      title: '第二天',
      summary: '',
      stops: [{ ...days[0]!.stops[0]!, id: 'stop-again' }],
      legs: [],
    })
    const view = projectTripCoverage(days, profileWithClassics([{ name: '断桥' }]))
    expect(view!.covered).toHaveLength(1)
    expect(view!.covered[0]!.matchedStops).toEqual(['断桥'])
    expect(view!.total).toBe(1)
    expect(view!.uncovered).toHaveLength(0)
  })

  it('全角/大小写/空白差异按 NFKC 归一后命中', () => {
    const view = projectTripCoverage(
      daysWithStops(['west lake']),
      profileWithClassics([{ name: 'Ｗｅｓｔ ＬＡＫＥ' }]),
    )
    expect(view!.covered).toHaveLength(1)
    expect(view!.covered[0]!.matchedStops).toEqual(['west lake'])
  })

  it('简繁差异按既有口径不折叠：如实进未安排 + 未识别，不硬凑命中', () => {
    const view = projectTripCoverage(
      daysWithStops(['东坡亭']),
      profileWithClassics([{ name: '東坡亭' }]),
    )
    expect(view!.covered).toHaveLength(0)
    expect(view!.uncovered.map((item) => item.name)).toEqual(['東坡亭'])
    expect(view!.unrecognizedStops).toEqual(['东坡亭'])
  })

  it('行程站点不在经典清单口径内：进 unrecognizedStops，不影响 X/N 统计', () => {
    const view = projectTripCoverage(
      daysWithStops(['苏堤春晓', '某无名茶馆']),
      profileWithClassics([{ name: '苏堤春晓' }, { name: '断桥' }]),
    )
    expect(view!.unrecognizedStops).toEqual(['某无名茶馆'])
    expect(view!.total).toBe(2)
    expect(view!.covered).toHaveLength(1)
    expect(view!.uncovered).toHaveLength(1)
  })

  it('reason 缺失投影为 null，未安排条目保留 null 不编造', () => {
    const profile = profileWithClassics([{ name: '断桥', reason: '' }])
    // reason 为空串 → projectCityProfile 清洗为 null
    const view = projectTripCoverage(daysWithStops([]), profile)
    expect(view!.uncovered[0]!.reason).toBeNull()
  })
})

describe('projectTripCoverage · 降级与防御', () => {
  it('无 cityProfile / classicList 为空 / 只有余块：返回 null（不渲染伪统计）', () => {
    expect(projectTripCoverage(daysWithStops(['断桥']), null)).toBeNull()
    expect(projectTripCoverage(daysWithStops(['断桥']), undefined)).toBeNull()
    expect(projectTripCoverage(daysWithStops(['断桥']), { source: 'model_generated' })).toBeNull()
    expect(
      projectTripCoverage(
        daysWithStops(['断桥']),
        profileWithClassics([]),
      ),
    ).toBeNull()
    expect(
      projectTripCoverage(
        daysWithStops(['断桥']),
        // classicList 里全是坏条目 → 清洗后为空 → null
        { source: 'model_generated', classicList: [{ name: '  ', reason: 'x', source: 'model_generated' }] },
      ),
    ).toBeNull()
  })

  it('classicList 超 15 条沿用城市卡上限（复用 projectCityProfile 清洗）', () => {
    const classics = Array.from({ length: 20 }, (_, index) => ({ name: `经典${index + 1}` }))
    const view = projectTripCoverage(daysWithStops([]), profileWithClassics(classics))
    expect(view!.total).toBe(15)
    expect(view!.uncovered).toHaveLength(15)
  })

  it('days / stops / name 坏数据逐层跳过，不抛错', () => {
    const brokenDays = [
      null,
      { day: 1, stops: null },
      { day: 2, stops: [null, { id: 'x' }, { id: 'y', name: '   ' }] },
      { day: 3, stops: [{ id: 'z', name: '断桥' }] },
    ] as unknown as TripDay[]
    const view = projectTripCoverage(brokenDays, profileWithClassics([{ name: '断桥' }]))
    expect(view!.covered).toHaveLength(1)
    expect(view!.covered[0]!.matchedStops).toEqual(['断桥'])
    expect(view!.unrecognizedStops).toEqual([])
  })

  it('days 缺省（旧数据只有画像）：全经典进未安排，统计如实 0/N', () => {
    const view = projectTripCoverage(undefined, profileWithClassics([{ name: '断桥' }]))
    expect(view).not.toBeNull()
    expect(view!.covered).toHaveLength(0)
    expect(view!.uncovered).toHaveLength(1)
    expect(view!.total).toBe(1)
  })
})

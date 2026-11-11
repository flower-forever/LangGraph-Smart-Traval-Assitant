/**
 * 六期 S5 · 景点深度契约兼容测试。
 * 旧行程（无深度字段）与新行程（带深度字段）必须同时通过
 * isTripLike / checkTripShape；深度块只做最浅守卫，坏块不拖垮整份行程。
 */
import { describe, expect, it } from 'vitest'
import { isTripLike } from '../lib/api'
import type { TripStop } from '../lib/api'
import { checkTripShape } from '../lib/savedTrips'

const oldStop: TripStop = {
  id: 's1',
  name: '西湖',
  time: '09:00',
  duration_minutes: 90,
  description: '',
  address: '',
  location: null,
}

const oldTrip = {
  id: 'trip-old',
  source: 'agent' as const,
  destination: '杭州',
  title: '旧行程',
  summary: '',
  map_coordinate_system: 'WGS84' as const,
  warnings: [],
  days: [
    {
      day: 1,
      date: null,
      title: '第1天',
      summary: '',
      stops: [oldStop],
      legs: [],
    },
  ],
}

const depth = {
  highlights: { items: ['湖面开阔'], source: 'model_generated' as const },
  suitableFor: { tags: ['nature'], source: 'model_generated' as const },
  suggestedStayMinutes: { min: 60, max: 90, source: 'model_generated' as const },
  tips: { items: ['清晨人少'], source: 'model_generated' as const },
}

describe('景点深度契约兼容', () => {
  it('旧行程无深度字段：isTripLike 与 checkTripShape 照常放行', () => {
    expect(isTripLike(oldTrip)).toBe(true)
    expect(checkTripShape(oldTrip).ok).toBe(true)
  })

  it('新行程带完整深度字段：两形态都放行', () => {
    const newTrip = {
      ...oldTrip,
      days: [{ ...oldTrip.days[0], stops: [{ ...oldStop, ...depth }] }],
    }
    expect(isTripLike(newTrip)).toBe(true)
    expect(checkTripShape(newTrip).ok).toBe(true)
  })

  it('深度字段为 null 也放行（后端缺块时的响应形态）', () => {
    const nullTrip = {
      ...oldTrip,
      days: [
        {
          ...oldTrip.days[0],
          stops: [
            { ...oldStop, highlights: null, suitableFor: null, suggestedStayMinutes: null, tips: null },
          ],
        },
      ],
    }
    expect(isTripLike(nullTrip)).toBe(true)
    expect(checkTripShape(nullTrip).ok).toBe(true)
  })

  it('深度块不是对象：拒绝整份行程（结构性坏数据）', () => {
    const badTrip = {
      ...oldTrip,
      days: [{ ...oldTrip.days[0], stops: [{ ...oldStop, highlights: 'oops' }] }],
    }
    expect(isTripLike(badTrip)).toBe(false)
    expect(checkTripShape(badTrip).ok).toBe(false)
  })

  it('深度块内部字段残缺：结构仍放行，由投影逐块降级', () => {
    const raggedTrip = {
      ...oldTrip,
      days: [
        {
          ...oldTrip.days[0],
          stops: [
            {
              ...oldStop,
              highlights: {},
              suitableFor: { tags: 'nope' },
              suggestedStayMinutes: { min: 'x', max: 2 },
              tips: [],
            },
          ],
        },
      ],
    }
    expect(isTripLike(raggedTrip)).toBe(true)
    expect(checkTripShape(raggedTrip).ok).toBe(true)
  })
})

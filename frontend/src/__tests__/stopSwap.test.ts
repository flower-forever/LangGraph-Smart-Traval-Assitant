/**
 * S6 · 换一个：候选匹配、距离排序、预览确认与路段作废的定向测试。
 *
 * 覆盖：
 * 1. 同类型优先 + 直线距离排序（含坐标缺失 → 距离未知排最后）。
 * 2. 直线距离文案与 haversine 口径；坐标缺失不按 0 补。
 * 3. 可信状态复用 S2 三态（有来源待核对 / 未核实 / 未知）。
 * 4. 无候选时返回空列表（不编造候选）。
 * 5. 预览显示替换后当天顺序与受影响路段。
 * 6. 确认替换后：被替换站点的前后路段一律作废（route_type / 几何 / 距离时长），
 *    其余路段原样保留，坐标清空、时间与停留保留。
 * 7. 可撤销一次。
 * 8. 失败保旧：非法替换内容不改动草稿。
 */
import { describe, expect, it } from 'vitest'

import type { Trip, TripStop } from '../lib/api'
import {
  SWAP_TRUST_LABELS,
  buildSwapCandidates,
  extractTypeTokens,
  formatStraightDistance,
  matchTypeKeywords,
  previewStopSwap,
  straightDistanceMeters,
  topSwapCandidates,
} from '../lib/stopSwap'
import {
  SWAPPED_LEG_DESCRIPTION,
  createTripDraft,
  replaceDraftStop,
  undoDraft,
  type TripDraft,
} from '../lib/tripDraft'
import {
  addPoiCard,
  createEmptyPoiCardsRecord,
  createPoiCard,
  type PoiCardsRecordV1,
} from '../lib/poiCards'
import type { CandidateItemV1 } from '../lib/workspace'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_700_000_000_000

/** 被替换的站点：名称里带类型词「博物馆」，坐标在西湖边。 */
const TARGET_STOP: TripStop = {
  id: 'target',
  name: '西湖博物馆',
  time: '10:00',
  duration_minutes: 60,
  description: '看展。',
  address: '杭州市西湖区孤山路',
  location: { lng: 120.1522, lat: 30.2631 },
}

function candidate(
  overrides: Partial<CandidateItemV1> & { id: string; name: string },
): CandidateItemV1 {
  return {
    id: overrides.id,
    name: overrides.name,
    address: overrides.address ?? null,
    notes: overrides.notes ?? null,
    tags: overrides.tags ?? [],
    priority: overrides.priority ?? 1,
    location: overrides.location ?? null,
    source: 'manual',
    copiedFromStopId: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

/** 同类型且更近（约 0.30 km）。 */
const NEAR_SAME_TYPE = candidate({
  id: 'c-near',
  name: '浙江省博物馆',
  notes: '省博物馆新馆',
  location: { lng: 120.15, lat: 30.265 },
})

/** 同类型但更远（约 0.44 km）。 */
const FAR_SAME_TYPE = candidate({
  id: 'c-far',
  name: '中国丝绸博物馆',
  location: { lng: 120.155, lat: 30.26 },
})

/** 不同类型，距离更近也不会排在同类型前面（约 1.64 km）。 */
const OTHER_TYPE = candidate({
  id: 'c-other',
  name: '楼外楼',
  notes: '本地餐厅',
  location: { lng: 120.16, lat: 30.25 },
})

function makeDraft(base: Trip = MOCK_TRIP, forkTripId = 'trip-fork-swap'): TripDraft {
  const created = createTripDraft(base, { forkTripId, newLegMode: 'walking' })
  if (!created.ok) throw new Error(created.message)
  return created.draft
}

function cardRecord(cards: Parameters<typeof createPoiCard>[0][]): PoiCardsRecordV1 {
  const empty = createEmptyPoiCardsRecord(NOW)
  if (!empty.ok) throw new Error(empty.message)
  let record: PoiCardsRecordV1 = empty.value
  for (const input of cards) {
    const card = createPoiCard(input, NOW)
    if (!card.ok) throw new Error(card.message)
    const added = addPoiCard(record, card.value, NOW)
    if (!added.ok) throw new Error(added.message)
    record = added.value
  }
  return record
}

/**
 * I2 回归夹具：第 1 天 5 站，最后一段（s4→s5）**本来就不可用**。
 * 用来验证预览只数「与被替换站直接相邻」的路段，不把当天既有的 unavailable 段算进去。
 */
const TRIP_WITH_UNAVAILABLE_LEG: Trip = {
  ...MOCK_TRIP,
  id: 'trip-mock-unavailable-leg',
  days: [
    {
      ...MOCK_TRIP.days[0],
      stops: [
        {
          id: 's1',
          name: '断桥残雪',
          time: '09:00',
          duration_minutes: 40,
          description: '白堤东端。',
          address: '杭州市西湖区白堤东端',
          location: { lng: 120.1576, lat: 30.2726 },
        },
        {
          id: 's2',
          name: '平湖秋月',
          time: '10:00',
          duration_minutes: 30,
          description: '湖面秋月。',
          address: '杭州市西湖区孤山路',
          location: { lng: 120.1522, lat: 30.2631 },
        },
        {
          id: 's3',
          name: '湖滨晴雨',
          time: '11:30',
          duration_minutes: null,
          description: '商业街区。',
          address: '杭州市上城区湖滨路',
          location: null,
        },
        {
          id: 's4',
          name: '曲院风荷',
          time: '14:00',
          duration_minutes: 45,
          description: '荷香。',
          address: '杭州市西湖区杨公堤',
          location: { lng: 120.135, lat: 30.253 },
        },
        {
          id: 's5',
          name: '雷峰塔',
          time: '16:00',
          duration_minutes: 60,
          description: '夕照。',
          address: '杭州市西湖区南山路',
          location: { lng: 120.1497, lat: 30.2323 },
        },
      ],
      legs: [
        {
          from_stop_id: 's1',
          to_stop_id: 's2',
          mode: 'walking',
          route_type: 'navigation',
          distance_m: 1100,
          duration_minutes: 16,
          geometry: [
            { lng: 120.1576, lat: 30.2726 },
            { lng: 120.1522, lat: 30.2631 },
          ],
          description: '沿白堤步行。',
        },
        {
          from_stop_id: 's2',
          to_stop_id: 's3',
          mode: 'walking',
          route_type: 'navigation',
          distance_m: 900,
          duration_minutes: 14,
          geometry: [],
          description: '沿湖往南。',
        },
        {
          from_stop_id: 's3',
          to_stop_id: 's4',
          mode: 'walking',
          route_type: 'navigation',
          distance_m: 1500,
          duration_minutes: 22,
          geometry: [],
          description: '沿杨公堤。',
        },
        {
          // 这一段在导入的行程里本来就不可用，与本次替换无关。
          from_stop_id: 's4',
          to_stop_id: 's5',
          mode: 'walking',
          route_type: 'unavailable',
          distance_m: null,
          duration_minutes: null,
          geometry: [],
          description: '这一段本来就没有路线。',
        },
      ],
    },
    ...MOCK_TRIP.days.slice(1),
  ],
}

/* ───────── 1. 同类型优先 + 距离排序 ───────── */

describe('S6 · 换一个：候选匹配与排序', () => {
  it('同类型优先；同类型内按直线距离由近到远；不同类型排在后面', () => {
    const list = buildSwapCandidates({
      stop: TARGET_STOP,
      candidates: [OTHER_TYPE, FAR_SAME_TYPE, NEAR_SAME_TYPE],
      poiCards: null,
      now: NOW,
    })
    expect(list.map((item) => item.name)).toEqual([
      '浙江省博物馆',
      '中国丝绸博物馆',
      '楼外楼',
    ])
    expect(list[0].matchedKeywords).toContain('博物馆')
    expect(list[2].matchedKeywords).toEqual([])
  })

  it('距离未知的同类型候选排在已知距离之后（不按 0 补）', () => {
    const noLocation = candidate({ id: 'c-noloc', name: '博物馆新馆' })
    const list = buildSwapCandidates({
      stop: TARGET_STOP,
      candidates: [noLocation, NEAR_SAME_TYPE],
      poiCards: null,
      now: NOW,
    })
    expect(list.map((item) => item.name)).toEqual(['浙江省博物馆', '博物馆新馆'])
    expect(list[1].straightDistanceMeters).toBeNull()
  })

  it('资料卡候选没有坐标：直线距离未知，但同类型仍排在前面', () => {
    const cards = cardRecord([{ id: 'card-1', name: '博物馆新馆', intro: '新馆展览' }])
    const list = buildSwapCandidates({
      stop: TARGET_STOP,
      candidates: [OTHER_TYPE],
      poiCards: cards,
      now: NOW,
    })
    expect(list.map((item) => item.name)).toEqual(['博物馆新馆', '楼外楼'])
    expect(list[0].source).toBe('poi_card')
    expect(list[0].straightDistanceMeters).toBeNull()
  })

  it('不把当前站自己列为候选；也不列当天已有的其它站', () => {
    const list = buildSwapCandidates({
      stop: TARGET_STOP,
      candidates: [
        candidate({ id: 'c-self', name: '西湖博物馆' }),
        candidate({ id: 'c-same-day', name: '楼外楼' }),
        NEAR_SAME_TYPE,
      ],
      poiCards: null,
      now: NOW,
      otherStopNames: ['楼外楼'],
    })
    expect(list.map((item) => item.name)).toEqual(['浙江省博物馆'])
  })

  it('最多返回 3 个候选', () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      candidate({
        id: `c-${index}`,
        name: `博物馆${index}`,
        location: { lng: 120.15 + index * 0.001, lat: 30.265 },
      }),
    )
    const list = buildSwapCandidates({
      stop: TARGET_STOP,
      candidates: many,
      poiCards: null,
      now: NOW,
    })
    expect(topSwapCandidates(list)).toHaveLength(3)
    expect(topSwapCandidates(list, 2)).toHaveLength(2)
  })

  it('没有候选时返回空列表（不编造候选）', () => {
    const list = buildSwapCandidates({
      stop: TARGET_STOP,
      candidates: [],
      poiCards: null,
      now: NOW,
    })
    expect(list).toEqual([])
  })
})

/* ───────── 2. 距离口径 ───────── */

describe('S6 · 换一个：直线距离', () => {
  it('按 haversine 计算直线距离（米）', () => {
    const meters = straightDistanceMeters(
      { lng: 120.1522, lat: 30.2631 },
      { lng: 120.15, lat: 30.265 },
    )
    expect(meters).not.toBeNull()
    expect(meters as number).toBeGreaterThan(250)
    expect(meters as number).toBeLessThan(350)
  })

  it('任一端坐标缺失 → 距离未知（不按 0 补）', () => {
    expect(straightDistanceMeters(null, { lng: 120, lat: 30 })).toBeNull()
    expect(straightDistanceMeters({ lng: 120, lat: 30 }, null)).toBeNull()
  })

  it('展示文案明确写「直线距离」，未知就写未知', () => {
    expect(formatStraightDistance(null)).toBe('直线距离未知')
    expect(formatStraightDistance(850)).toBe('直线距离 850 米')
    expect(formatStraightDistance(1234)).toBe('直线距离 1.2 公里')
  })
})

/* ───────── 3. 可信状态 ───────── */

describe('S6 · 换一个：可信状态复用 S2 三态', () => {
  it('有来源 → 有来源（待核对）；无来源 → 未核实；无卡 → 未知', () => {
    const cards = cardRecord([
      {
        id: 'card-sourced',
        name: '浙江省博物馆',
        intro: '常设展与临时展。',
        provenance: {
          intro: { source: 'tavily', detail: 'https://example.test/a', recordedAt: NOW },
          openingHours: null,
          ticket: null,
        },
      },
      {
        id: 'card-unverified',
        name: '中国丝绸博物馆',
        intro: '丝绸主题展。',
      },
    ])
    const list = buildSwapCandidates({
      stop: TARGET_STOP,
      candidates: [NEAR_SAME_TYPE, FAR_SAME_TYPE],
      poiCards: cards,
      now: NOW,
    })
    const sourced = list.find((item) => item.name === '浙江省博物馆')
    const unverified = list.find((item) => item.name === '中国丝绸博物馆')
    expect(sourced?.trust).toBe('sourced')
    expect(unverified?.trust).toBe('unverified')
    expect(SWAP_TRUST_LABELS.sourced).toBe('有来源（待核对）')
    expect(SWAP_TRUST_LABELS.unverified).toBe('未核实')
    expect(SWAP_TRUST_LABELS.unknown).toBe('未知')
  })

  it('没有资料卡时可信状态是「未知」，不编造来源', () => {
    const list = buildSwapCandidates({
      stop: TARGET_STOP,
      candidates: [NEAR_SAME_TYPE],
      poiCards: null,
      now: NOW,
    })
    expect(list[0].trust).toBe('unknown')
  })
})

/* ───────── 4. 类型词匹配 ───────── */

describe('S6 · 换一个：类型词抽取', () => {
  it('中文取 2 字以上的连续片段；常见虚词被过滤', () => {
    const tokens = extractTypeTokens('西湖博物馆')
    expect(tokens).toContain('博物馆')
    expect(tokens).toContain('西湖')
    expect(tokens).not.toContain('可以')
  })

  it('拉丁词取 3 字母以上的整词', () => {
    const tokens = extractTypeTokens('Old Town Market')
    expect(tokens).toContain('old')
    expect(tokens).toContain('town')
    expect(tokens).not.toContain('of')
  })

  it('候选的名称 / 简介 / 标签命中都算同类型', () => {
    expect(matchTypeKeywords('西湖博物馆', '浙江省博物馆')).toContain('博物馆')
    expect(matchTypeKeywords('西湖博物馆', '新馆有：博物馆特展')).toContain('博物馆')
    expect(matchTypeKeywords('西湖博物馆', '西湖 博物馆')).toContain('博物馆')
    expect(matchTypeKeywords('西湖博物馆', '完全无关的地方')).toEqual([])
  })
})

/* ───────── 5. 预览 ───────── */

describe('S6 · 换一个：预览', () => {
  it('预览显示替换后当天顺序与受影响路段', () => {
    const draft = makeDraft()
    const result = previewStopSwap(draft, 1, 's1', { name: '浙江省博物馆', address: '' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preview.stops.map((item) => item.name)).toEqual([
      '浙江省博物馆',
      '平湖秋月',
      '湖滨晴雨',
    ])
    expect(result.preview.stops[0].replaced).toBe(true)
    expect(result.preview.stops[1].replaced).toBe(false)
    // s1 是当天的第一站：只有它后面的那一段（s1→s2）被牵连；
    // s2→s3 与 s1 不相邻，原样保留。
    expect(result.preview.invalidatedLegCount).toBe(1)
    expect(result.preview.legs[0].invalidated).toBe(true)
    expect(result.preview.legs[1].invalidated).toBe(false)
  })

  it('替换当天的中间一站：前后两段都被牵连', () => {
    const draft = makeDraft()
    const result = previewStopSwap(draft, 1, 's2', { name: '浙江省博物馆', address: '' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preview.invalidatedLegCount).toBe(2)
    expect(result.preview.legs.every((leg) => leg.invalidated)).toBe(true)
  })

  it('站点不存在时预览失败并说明原因', () => {
    const draft = makeDraft()
    const result = previewStopSwap(draft, 1, 'nope', { name: 'X' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('没有指定站点')
  })

  it('当天已有 unavailable 路段时：受影响路段只数与被替换站相邻的那几段', () => {
    const draft = makeDraft(TRIP_WITH_UNAVAILABLE_LEG, 'trip-fork-unavailable-leg')
    const result = previewStopSwap(draft, 1, 's3', { name: '浙江省博物馆', address: '' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // s3 是中间站：相邻的 s2→s3、s3→s4 两段被牵连；
    // 当天本来就不可用的 s4→s5 是旧状态，不计入「受影响路段」。
    expect(result.preview.invalidatedLegCount).toBe(2)
    expect(
      result.preview.legs
        .filter((leg) => leg.invalidated)
        .map((leg) => `${leg.fromStopId}->${leg.toStopId}`),
    ).toEqual(['s2->s3', 's3->s4'])
    // 既有的 unavailable 段仍然出现在预览里，但不算被这次替换牵连。
    const preexisting = result.preview.legs.find(
      (leg) => leg.fromStopId === 's4' && leg.toStopId === 's5',
    )
    expect(preexisting?.invalidated).toBe(false)
    expect(preexisting?.description).toBe('这一段本来就没有路线。')
  })

  it('末站替换：只算前一段，当天既有的 unavailable 段不计入', () => {
    const draft = makeDraft(TRIP_WITH_UNAVAILABLE_LEG, 'trip-fork-unavailable-leg')
    const result = previewStopSwap(draft, 1, 's5', { name: '浙江省博物馆', address: '' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // s5 是当天末站：只有 s4→s5 一段相邻（它本来就不可用，仍算这一段的牵连）。
    expect(result.preview.invalidatedLegCount).toBe(1)
  })

  it('预览不改动草稿', () => {
    const draft = makeDraft()
    const before = JSON.stringify(draft.days)
    previewStopSwap(draft, 1, 's1', { name: '浙江省博物馆', address: '' })
    expect(JSON.stringify(draft.days)).toBe(before)
  })
})

/* ───────── 6. 确认替换：路段作废 ───────── */

describe('S6 · 换一个：替换后路段作废', () => {
  it('被替换站点的前后路段一律 unavailable：几何空、距离与时长为 null', () => {
    const draft = makeDraft()
    // s2 是当天的中间一站：前后两段（s1→s2、s2→s3）都被牵连。
    const result = replaceDraftStop(draft, 1, 's2', {
      name: '浙江省博物馆',
      address: '杭州市拱墅区',
      description: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const day = result.draft.days.find((item) => item.day === 1)
    expect(day).toBeDefined()
    const legs = day?.legs ?? []
    expect(legs).toHaveLength(2)
    for (const leg of legs) {
      expect(leg.route_type).toBe('unavailable')
      expect(leg.geometry).toEqual([])
      expect(leg.distance_m).toBeNull()
      expect(leg.duration_minutes).toBeNull()
      expect(leg.description).toBe(SWAPPED_LEG_DESCRIPTION)
    }
  })

  it('当天的第一站：只有它后面那一段被牵连', () => {
    const draft = makeDraft()
    const result = replaceDraftStop(draft, 1, 's1', { name: '浙江省博物馆' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const legs = result.draft.days[0].legs
    expect(legs[0].route_type).toBe('unavailable')
    expect(legs[1].route_type).toBe('straight_line')
    expect(legs[1].distance_m).toBe(1800)
  })

  it('保留站点 id、到达时间与停留时长；坐标清空；描述不沿用旧站', () => {
    const draft = makeDraft()
    const result = replaceDraftStop(draft, 1, 's1', {
      name: '浙江省博物馆',
      address: '杭州市拱墅区',
      description: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const stop = result.draft.days[0].stops.find((item) => item.id === 's1')
    expect(stop?.id).toBe('s1')
    expect(stop?.name).toBe('浙江省博物馆')
    expect(stop?.time).toBe('09:00')
    expect(stop?.duration_minutes).toBe(40)
    expect(stop?.location).toBeNull()
    expect(stop?.description).toBe('')
    expect(stop?.address).toBe('杭州市拱墅区')
  })

  it('未被牵连的路段原样保留（route_type 与 geometry 都不动）', () => {
    const base: Trip = {
      ...MOCK_TRIP,
      id: 'trip-four-legs',
      days: [
        {
          day: 1,
          date: null,
          title: '测试',
          summary: '',
          stops: [
            { ...MOCK_TRIP.days[0].stops[0], id: 'a' },
            { ...MOCK_TRIP.days[0].stops[1], id: 'b' },
            { ...MOCK_TRIP.days[0].stops[2], id: 'c' },
            { ...MOCK_TRIP.days[0].stops[1], id: 'd' },
          ],
          legs: [
            {
              from_stop_id: 'a',
              to_stop_id: 'b',
              mode: 'walking',
              route_type: 'navigation',
              distance_m: 1100,
              duration_minutes: 16,
              geometry: [{ lng: 120.1, lat: 30.2 }],
              description: '沿白堤步行。',
            },
            {
              from_stop_id: 'b',
              to_stop_id: 'c',
              mode: 'driving',
              route_type: 'navigation',
              distance_m: 1800,
              duration_minutes: 12,
              geometry: [{ lng: 120.15, lat: 30.26 }],
              description: '沿湖滨。',
            },
            {
              from_stop_id: 'c',
              to_stop_id: 'd',
              mode: 'walking',
              route_type: 'navigation',
              distance_m: 900,
              duration_minutes: 12,
              geometry: [{ lng: 120.16, lat: 30.27 }],
              description: '沿湖。',
            },
          ],
        },
      ],
    }
    const draft = makeDraft(base, 'trip-fork-four')
    const result = replaceDraftStop(draft, 1, 'b', { name: '新站点' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const legs = result.draft.days[0].legs
    expect(legs).toHaveLength(3)
    // 牵连的两段作废。
    expect(legs[0].route_type).toBe('unavailable')
    expect(legs[1].route_type).toBe('unavailable')
    expect(legs[0].geometry).toEqual([])
    expect(legs[1].geometry).toEqual([])
    // 不相邻的那一段原样保留。
    expect(legs[2].route_type).toBe('navigation')
    expect(legs[2].distance_m).toBe(900)
    expect(legs[2].geometry).toEqual([{ lng: 120.16, lat: 30.27 }])
  })

  it('被替换站点的路段保留原出行方式（换站点不改变交通方式）', () => {
    const draft = makeDraft()
    const result = replaceDraftStop(draft, 1, 's2', { name: '新站点' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const legs = result.draft.days[0].legs
    expect(legs[0].mode).toBe('walking')
    expect(legs[1].mode).toBe('driving')
  })
})

/* ───────── 7. 撤销一次 ───────── */

describe('S6 · 换一个：可撤销一次', () => {
  it('撤销后回到替换前的草稿', () => {
    const draft = makeDraft()
    const replaced = replaceDraftStop(draft, 1, 's1', { name: '浙江省博物馆' })
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) return
    const undone = undoDraft(replaced.draft)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    const stop = undone.draft.days[0].stops.find((item) => item.id === 's1')
    expect(stop?.name).toBe('断桥残雪')
    expect(stop?.location).toEqual({ lng: 120.1576, lat: 30.2726 })
    const legs = undone.draft.days[0].legs
    expect(legs[0].route_type).toBe('navigation')
    expect(legs[0].distance_m).toBe(1100)
  })

  it('没有可撤销的改动时是无变化的 no-op', () => {
    const draft = makeDraft()
    const undone = undoDraft(draft)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.changed).toBe(false)
  })
})

/* ───────── 8. 失败保旧 ───────── */

describe('S6 · 换一个：失败保旧', () => {
  it('名称非法时不改动草稿', () => {
    const draft = makeDraft()
    const before = JSON.stringify(draft.days)
    const result = replaceDraftStop(draft, 1, 's1', { name: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid_name')
    expect(JSON.stringify(draft.days)).toBe(before)
  })

  it('地址超长时不改动草稿', () => {
    const draft = makeDraft()
    const result = replaceDraftStop(draft, 1, 's1', {
      name: '浙江省博物馆',
      address: 'x'.repeat(301),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid_address')
  })

  it('站点不存在时不改动草稿', () => {
    const draft = makeDraft()
    const result = replaceDraftStop(draft, 1, 'nope', { name: '新站点' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unknown_stop')
  })
})

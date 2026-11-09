/**
 * S2 · 信息可信卡投影纯函数测试（stopFacts.ts）。
 * 离线、确定性：当前时间显式传参；不碰存储、不发请求。
 */
import { describe, expect, it } from 'vitest'
import { createEmptyPoiCardsRecord, createPoiCard, type PoiCardsRecordV1 } from '../lib/poiCards'
import { projectStopFacts, STOP_FACT_STALE_DAYS, STOP_FACT_STALE_MS } from '../lib/stopFacts'
import type { TripStop } from '../lib/api'

const NOW = 1_800_000_000_000 // 固定「当前时间」，全文件确定性

const DAY_MS = 24 * 60 * 60 * 1000

function makeStop(overrides: Partial<TripStop> = {}): TripStop {
  return {
    id: 's1',
    name: '断桥残雪',
    time: '09:00',
    duration_minutes: 40,
    description: '',
    address: '杭州市西湖区白堤东端',
    location: null,
    ...overrides,
  }
}

function makeRecord(cards: PoiCardsRecordV1['cards']): PoiCardsRecordV1 {
  const empty = createEmptyPoiCardsRecord(1_000)
  if (!empty.ok) throw new Error(empty.message)
  return { ...empty.value, cards }
}

function makeCard(
  overrides: Partial<Parameters<typeof createPoiCard>[0]> = {},
  provenanceOverride?: Parameters<typeof createPoiCard>[0]['provenance'],
): PoiCardsRecordV1['cards'][number] {
  const provenance =
    provenanceOverride !== undefined
      ? provenanceOverride
      : overrides.provenance ?? {
          intro: { source: 'tavily' as const, detail: '页面摘录', recordedAt: NOW - 10 * DAY_MS },
          openingHours: null,
          ticket: null,
        }
  const card = createPoiCard(
    { id: 'card-1', name: '断桥残雪', intro: '', openingHours: '', ticket: '', ...overrides, provenance },
    1_000,
  )
  if (!card.ok) throw new Error(card.message)
  return card.value
}

describe('projectStopFacts · 三态', () => {
  it('sourced：字段有值且 provenance 有 source → sourced，带来源与 recordedAt，不 stale', () => {
    const record = makeRecord([
      makeCard({ intro: '湖上景观。', provenance: { intro: { source: 'tavily', detail: '页面摘录', recordedAt: NOW - 10 * DAY_MS }, openingHours: null, ticket: null } }),
    ])
    const facts = projectStopFacts(makeStop(), record, NOW)
    expect(facts.matched).toBe(true)
    expect(facts.cardName).toBe('断桥残雪')
    expect(facts.intro).toEqual({
      value: '湖上景观。',
      status: 'sourced',
      source: 'tavily',
      sourceDetail: '页面摘录',
      recordedAt: NOW - 10 * DAY_MS,
      stale: false,
    })
    // openingHours / ticket 值为空：unknown（空值没有可信内容可展示，即使有 provenance 也是 unknown）
    expect(facts.openingHours).toMatchObject({ value: null, status: 'unknown', stale: false })
    expect(facts.ticket).toMatchObject({ value: null, status: 'unknown' })
  })

  it('unverified：字段有值但无 provenance → unverified（旧卡兼容，不误标 sourced）', () => {
    const record = makeRecord([
      makeCard(
        { intro: '手工整理的介绍。', openingHours: '全天', ticket: '免费' },
        { intro: null, openingHours: null, ticket: null },
      ),
    ])
    const facts = projectStopFacts(makeStop(), record, NOW)
    expect(facts.intro).toMatchObject({ value: '手工整理的介绍。', status: 'unverified', source: null, stale: false })
    expect(facts.openingHours).toMatchObject({ value: '全天', status: 'unverified' })
    expect(facts.ticket).toMatchObject({ value: '免费', status: 'unverified' })
  })

  it('unknown：字段为空 → unknown；有 provenance 的空字段也是 unknown（空值没有可信内容）', () => {
    const record = makeRecord([
      makeCard({
        intro: '',
        provenance: {
          intro: { source: 'manual', detail: null, recordedAt: NOW },
          openingHours: null,
          ticket: null,
        },
      }),
    ])
    const facts = projectStopFacts(makeStop(), record, NOW)
    expect(facts.intro.status).toBe('unknown')
    expect(facts.intro.value).toBe(null)
    expect(facts.intro.stale).toBe(false)
  })

  it('unknown：无资料卡 / 多命中 → matched=false，三字段全 unknown', () => {
    const facts = projectStopFacts(makeStop(), null, NOW)
    expect(facts.matched).toBe(false)
    expect(facts.cardName).toBe(null)
    expect(facts.intro).toMatchObject({ value: null, status: 'unknown', stale: false })
    expect(facts.openingHours).toMatchObject({ status: 'unknown' })
    expect(facts.ticket).toMatchObject({ status: 'unknown' })

    // 多命中（重名两条）→ findPoiCardByName 返回 null → 同口径 unknown
    const a = createPoiCard({ id: 'm1', name: '断桥残雪', address: '地址A' }, 1_000)
    const b = createPoiCard({ id: 'm2', name: '断桥残雪', address: '地址B' }, 1_000)
    if (!a.ok || !b.ok) throw new Error('fixture 失败')
    const multi = projectStopFacts(makeStop(), makeRecord([a.value, b.value]), NOW)
    expect(multi.matched).toBe(false)
    expect(multi.intro.status).toBe('unknown')
  })

  it('名称归一化匹配：全角 / 大小写 / 空白差异不影响命中（复用 findPoiCardByName 口径）', () => {
    const record = makeRecord([makeCard({ name: '断桥残雪' })])
    const facts = projectStopFacts(makeStop({ name: '  断桥残雪 ' }), record, NOW)
    expect(facts.matched).toBe(true)
  })
})

describe('projectStopFacts · 180 天时效边界', () => {
  const provenanceAt = (recordedAt: number) => ({
    intro: { source: 'manual' as const, detail: null, recordedAt },
    openingHours: null,
    ticket: null,
  })

  it(`常量集中定义：STOP_FACT_STALE_DAYS = ${STOP_FACT_STALE_DAYS}，且 tests 与实现同一常量`, () => {
    expect(STOP_FACT_STALE_DAYS).toBe(180)
    expect(STOP_FACT_STALE_MS).toBe(180 * DAY_MS)
  })

  it('179 天：不标 stale', () => {
    const record = makeRecord([makeCard({ intro: '介绍。' }, provenanceAt(NOW - 179 * DAY_MS))])
    const facts = projectStopFacts(makeStop(), record, NOW)
    expect(facts.intro.status).toBe('sourced')
    expect(facts.intro.stale).toBe(false)
  })

  it('恰好 180 天：不算超过，不标 stale', () => {
    const record = makeRecord([makeCard({ intro: '介绍。' }, provenanceAt(NOW - 180 * DAY_MS))])
    const facts = projectStopFacts(makeStop(), record, NOW)
    expect(facts.intro.stale).toBe(false)
  })

  it('181 天：标 stale', () => {
    const record = makeRecord([makeCard({ intro: '介绍。' }, provenanceAt(NOW - 181 * DAY_MS))])
    const facts = projectStopFacts(makeStop(), record, NOW)
    expect(facts.intro.status).toBe('sourced')
    expect(facts.intro.stale).toBe(true)
    expect(facts.openingHours.stale).toBe(false) // 无 provenance 不参与时效
  })

  it('未来时间戳（recordedAt > now）：不算过期，不崩', () => {
    const record = makeRecord([makeCard({ intro: '介绍。' }, provenanceAt(NOW + 5 * DAY_MS))])
    const facts = projectStopFacts(makeStop(), record, NOW)
    expect(facts.intro.stale).toBe(false)
  })
})

describe('projectStopFacts · 旧卡与手工来源', () => {
  it('旧卡（provenance 三字段全 null）不崩、不误标：有值 → unverified，空值 → unknown', () => {
    const legacy = createPoiCard(
      { id: 'legacy-1', name: '断桥残雪', intro: '旧卡介绍', openingHours: '', ticket: '免费' },
      1_000,
    )
    if (!legacy.ok) throw new Error(legacy.message)
    const facts = projectStopFacts(makeStop(), makeRecord([legacy.value]), NOW)
    expect(facts.matched).toBe(true)
    expect(facts.intro).toMatchObject({ value: '旧卡介绍', status: 'unverified' })
    expect(facts.openingHours).toMatchObject({ value: null, status: 'unknown' })
    expect(facts.ticket).toMatchObject({ value: '免费', status: 'unverified' })
  })

  it('手工填写的资料（manual provenance）也是 sourced：有来源待核对，不冒充官方', () => {
    const record = makeRecord([
      makeCard({
        intro: '自己整理的介绍。',
        provenance: {
          intro: { source: 'manual', detail: '手工粘贴', recordedAt: NOW - DAY_MS },
          openingHours: null,
          ticket: null,
        },
      }),
    ])
    const facts = projectStopFacts(makeStop(), record, NOW)
    expect(facts.intro).toMatchObject({ status: 'sourced', source: 'manual', sourceDetail: '手工粘贴' })
  })

  it('provenance 形状异常（来源字段缺失）按 unverified 处理，不崩', () => {
    const record = makeRecord([
      makeCard(
        { intro: '介绍。' },
        // 借 createPoiCard 校验放行 null intro；这里直接构造缺 source 的对象绕过类型，
        // 投影必须对残缺 provenance 兜底（不崩 → unverified）。
        { intro: null, openingHours: null, ticket: null },
      ),
    ])
    // 手工把 intro provenance 换成残缺对象（缺 source），模拟异常存储形状。
    const card = record.cards[0] as PoiCardsRecordV1['cards'][number]
    ;(card.provenance.intro as unknown) = { detail: '残缺', recordedAt: NOW }
    const facts = projectStopFacts(makeStop(), record, NOW)
    expect(facts.intro.status).toBe('unverified')
    expect(facts.intro.stale).toBe(false)
  })
})

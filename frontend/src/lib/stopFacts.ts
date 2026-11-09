/**
 * S2 · 信息可信卡：停点资料卡只读投影（五期计划 §3）。
 *
 * 边界（与 poiCards.ts 同一纪律）：
 * - **纯函数投影**：输入 TripStop + PoiCardsRecordV1 + 当前时间（当前时间作为参数传入，
 *   便于测试），输出展示事实；不碰任何存储、不发任何请求、零副作用。
 * - 卡匹配复用 `findPoiCardByName` 名称归一化口径（0 / 多命中都返回 null，不猜）。
 * - **不改 PoiCardV1 契约**：只读卡上已有字段；旧卡（无 provenance）照常投影，
 *   不会崩、不会误标 sourced。
 * - 三态只此三种：sourced（有值且有来源）→「有来源（待核对）」；unverified（有值无来源）
 *   →「未核实」；unknown（空值 / 无卡）→「未知」。**手工填写的资料也算 sourced**
 *   （有来源待核对）：manual 是 provenance.source 的合法值，绝不冒充官方核实——
 *   本模块不区分来源种类，只区分「有没有 provenance」。
 * - 时效：字段 provenance.recordedAt 距当前时间超过 STOP_FACT_STALE_DAYS 天
 *   → stale=true，UI 加「可能过期」标记；无 provenance 的字段没有 recordedAt，不参与时效。
 * - 页面上限是「有来源（待核对）」：本模块与配套 UI **永不出现「已核实」**，
 *   也不编造来源——status 只由「字段值 + provenance」两个已有事实决定。
 */

import { findPoiCardByName, type PoiCardFieldProvenanceV1, type PoiCardsRecordV1 } from './poiCards'
import type { TripStop } from './api'

/**
 * 时效阈值（集中一处）：recordedAt 距 now 超过 180 天 → stale。
 * 边界语义：恰好 180 天不标（180 * 24 * 3600 * 1000 ms 之差不算超过），
 * 测试钉住 179 天不标 / 181 天标。
 */
export const STOP_FACT_STALE_DAYS = 180
export const STOP_FACT_STALE_MS = STOP_FACT_STALE_DAYS * 24 * 60 * 60 * 1000

/** 字段可信三态；除这三种没有别的值。 */
export type StopFactStatus = 'sourced' | 'unverified' | 'unknown'

/** 三字段之一的投影结果：展示值 + 可信状态 + 来源事实。 */
export interface StopFactField {
  /** 展示值；null = 未知（空值 / 无卡），UI 显示「未知」。 */
  value: string | null
  status: StopFactStatus
  /** 来源键（manual / tavily / osm / wikimedia）；仅 sourced 有。 */
  source: PoiCardFieldProvenanceV1['source'] | null
  /** 来源说明（页面 URL / 「手工粘贴」等）；可为 null。 */
  sourceDetail: string | null
  /** 来源录入时刻（epoch ms）；仅 sourced 有。 */
  recordedAt: number | null
  /** recordedAt 距 now > 180 天；仅 sourced 才可能为 true。 */
  stale: boolean
}

/** 一个停点的三字段投影。 */
export interface StopFacts {
  /** 是否唯一名称命中了资料卡；false = 无卡 / 多命中（三字段全 unknown）。 */
  matched: boolean
  /** 命中卡上记录的名称（与停点名归一化相等）；未命中为 null。 */
  cardName: string | null
  intro: StopFactField
  openingHours: StopFactField
  ticket: StopFactField
}

/** 单字段投影：值 + provenance + now → 三态。不编造：provenance 缺失即 unverified。 */
function projectField(
  rawValue: string,
  provenance: PoiCardFieldProvenanceV1 | null,
  now: number,
): StopFactField {
  const value = rawValue.trim()
  if (value.length === 0) {
    // 空值：一律 unknown（有 provenance 也不标——空字段没有可信内容可展示）。
    return { value: null, status: 'unknown', source: null, sourceDetail: null, recordedAt: null, stale: false }
  }
  if (provenance === null || typeof provenance.source !== 'string') {
    // 有值但无来源：unverified。旧卡无 provenance 走这里；
    // provenance 形状残缺（缺 source）也按 unverified 兜底，不误标 sourced。
    return { value, status: 'unverified', source: null, sourceDetail: null, recordedAt: null, stale: false }
  }
  return {
    value,
    status: 'sourced',
    source: provenance.source,
    sourceDetail: provenance.detail,
    recordedAt: provenance.recordedAt,
    stale:
      typeof provenance.recordedAt === 'number' &&
      Number.isFinite(provenance.recordedAt) &&
      now - provenance.recordedAt > STOP_FACT_STALE_MS,
  }
}

/**
 * 停点资料卡只读投影：按名称归一化唯一命中资料卡，把 intro / openingHours /
 * ticket 三个字段各投影成 { value, status, source, sourceDetail, recordedAt, stale }。
 * 无卡 / 多命中 → matched=false，三字段全 unknown（UI 显示「未知」+ 补充入口）。
 */
export function projectStopFacts(stop: TripStop, record: PoiCardsRecordV1 | null, now: number): StopFacts {
  const card = findPoiCardByName(record, stop.name)
  if (card === null) {
    const unknownField = (): StopFactField => ({
      value: null,
      status: 'unknown',
      source: null,
      sourceDetail: null,
      recordedAt: null,
      stale: false,
    })
    return {
      matched: false,
      cardName: null,
      intro: unknownField(),
      openingHours: unknownField(),
      ticket: unknownField(),
    }
  }
  return {
    matched: true,
    cardName: card.name,
    intro: projectField(card.intro, card.provenance.intro, now),
    openingHours: projectField(card.openingHours, card.provenance.openingHours, now),
    ticket: projectField(card.ticket, card.provenance.ticket, now),
  }
}

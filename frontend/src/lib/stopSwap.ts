/**
 * S6 · 换一个：候选筛选、直线距离排序与替换预览（五期计划 §7.1）。
 *
 * 边界（与 stopFacts / routeFlow / itineraryHealth 同一纪律）：
 * - **纯函数**：零存储、零网络、零副作用；同输入同输出。
 * - 候选来源只有两处现成数据：候选地点池（CandidatesRecordV1）与资料卡库
 *   （PoiCardsRecordV1）。**不新增任何外部搜索或网络请求。**
 * - 可信状态复用 S2 的 `projectStopFacts` 三态（sourced / unverified / unknown），
 *   不另造一套「已核实」；资料卡没有匹配上就是「未知」，不补来源。
 * - 距离一律是 haversine **直线**距离，界面必须标「直线距离」；
 *   任一端坐标缺失就是「距离未知」，绝不按 0 补。
 * - 排序：**同类型优先**（名称 / 简介 / 用户标签命中当前站名的类型词），
 *   同类型内按直线距离由近到远；距离未知的排在已知之后。
 * - 预览只算「替换后当天顺序 + 受影响路段」，**不写任何行程**；
 *   预览用的就是真正执行替换的那个纯函数，所以预览与结果不会漂移。
 */

import type { TripLeg, TripLocation, TripStop } from './api'
import { filterCandidates, normalizeCandidateText } from './candidatePool'
import type { PoiCardsRecordV1 } from './poiCards'
import { haversineKm } from './routeFlow'
import { projectStopFacts, type StopFactStatus } from './stopFacts'
import type { DraftStopReplacement, TripDraft } from './tripDraft'
import { replaceDraftStop } from './tripDraft'
import type { CandidateItemV1 } from './workspace'

/** 一次最多展示几个候选。 */
export const SWAP_CANDIDATE_LIMIT = 3

/** 候选来源：候选地点池 / 资料卡库。 */
export type SwapCandidateSource = 'candidate_pool' | 'poi_card'

/** 一个可替换的候选。 */
export interface SwapCandidate {
  /** 稳定 id：`candidate:<候选池 id>` / `card:<资料卡 id>`。 */
  id: string
  source: SwapCandidateSource
  name: string
  address: string | null
  /** 直线距离（米）；null = 坐标未知（原站或候选任一端缺坐标）。 */
  straightDistanceMeters: number | null
  /** 同类型命中的类型词；空数组 = 没有命中同类型关键词。 */
  matchedKeywords: string[]
  /** 可信状态：S2 三态。 */
  trust: StopFactStatus
  /** 一句话理由：只说能核对的事实。 */
  reason: string
  /** 候选坐标（只有候选池有；资料卡没有坐标字段，恒为 null）。 */
  location: TripLocation | null
}

/** 候选筛选的输入。 */
export interface SwapCandidateInput {
  /** 被替换的站点。 */
  stop: TripStop
  /** 候选池条目；可空（没有候选池时只有资料卡来源）。 */
  candidates?: readonly CandidateItemV1[] | null
  /** 资料卡库；可空。 */
  poiCards?: PoiCardsRecordV1 | null
  /** 可信状态判定用的当前时刻（由调用方传入，便于测试）。 */
  now: number
  /** 同一天里其它站点的名字：用于排除重复站点。 */
  otherStopNames?: readonly string[]
  /**
   * 七期 S7：当前城市。传入时先按「同城 + 全局」过滤候选池；
   * 缺省 / 空串 = 与旧行为一致（全部候选池条目）。
   */
  city?: string | null
}

/** 可信状态的中文说明；与 S2 语义一致，绝不出现「已核实」。 */
export const SWAP_TRUST_LABELS: Record<StopFactStatus, string> = {
  sourced: '有来源（待核对）',
  unverified: '未核实',
  unknown: '未知',
}

/* ───────── 类型词抽取与匹配 ───────── */

/** CJK 统一表意文字（含扩展 A 与兼容表意文字）。 */
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿]/
/** 抽取时的分段：连续中文一段，连续拉丁字母数字一段。 */
const RUN_PATTERN = /[㐀-䶿一-鿿豈-﫿]+|[a-z0-9]+/g

/** 类型词最短长度：中文 2 字（「西湖」）、拉丁 3 字母（避免 a、an 这类噪声）。 */
const MIN_CJK_TOKEN_LENGTH = 2
const MIN_LATIN_TOKEN_LENGTH = 3
/** 类型词最长长度：再长就不像「类型」了。 */
const MAX_TOKEN_LENGTH = 6
/** 单段文本最多抽多少个类型词，限制匹配成本。 */
const MAX_TOKENS_PER_TEXT = 60

/**
 * 常见词过滤：这些二字组合几乎不携带「类型」信息，
 * 命中它们只会让理由变得莫名其妙（例如「可以」「一个」）。
 */
const TOKEN_STOPWORDS: ReadonlySet<string> = new Set([
  '一个',
  '一些',
  '一下',
  '可以',
  '不是',
  '不要',
  '之后',
  '之前',
  '地方',
  '我们',
  '通过',
  '这个',
  '进行',
  '还有',
  '或者',
  '特别',
  '时候',
  '其中',
  '可能',
  '需要',
  '非常',
  '主要',
  '适合',
  '整个',
  '以及',
  '值得',
])

/**
 * 从站名里抽「类型词」：中文取 2–6 字的连续片段，拉丁取 3 字母以上的整词。
 * 只看名字：类型信息在站名里，简介里的长句不该被当成类型信号。
 */
export function extractTypeTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const tokens: string[] = []
  const seen = new Set<string>()
  const runs = normalized.match(RUN_PATTERN) ?? []
  for (const run of runs) {
    if (CJK_PATTERN.test(run)) {
      const maxLength = Math.min(MAX_TOKEN_LENGTH, run.length)
      for (let length = MIN_CJK_TOKEN_LENGTH; length <= maxLength; length += 1) {
        for (let start = 0; start + length <= run.length; start += 1) {
          const token = run.slice(start, start + length)
          if (TOKEN_STOPWORDS.has(token) || seen.has(token)) continue
          seen.add(token)
          tokens.push(token)
        }
      }
    } else {
      if (run.length < MIN_LATIN_TOKEN_LENGTH || seen.has(run)) continue
      seen.add(run)
      tokens.push(run)
    }
    if (tokens.length >= MAX_TOKENS_PER_TEXT) break
  }
  return tokens
}

/**
 * 候选与当前站的「同类型」命中词：当前站名里的类型词，
 * 出现在候选的名称 / 简介 / 地址 / 用户标签里就算命中。
 * 返回按长度降序的命中词（更长 = 更具体）。
 */
export function matchTypeKeywords(
  stopName: string,
  candidateText: string,
): string[] {
  const haystack = normalizeCandidateText(candidateText)
  if (haystack.length === 0) return []
  const tokens = extractTypeTokens(stopName)
  const hits = new Set<string>()
  for (const token of tokens) {
    if (haystack.includes(token)) hits.add(token)
  }
  return [...hits].sort((left, right) => {
    if (right.length !== left.length) return right.length - left.length
    return left.localeCompare(right)
  })
}

/* ───────── 距离 ───────── */

/** 直线距离（米）。任一端坐标缺失或非法 → null（不按 0 补）。 */
export function straightDistanceMeters(
  from: TripLocation | null,
  to: TripLocation | null,
): number | null {
  if (from === null || to === null) return null
  const km = haversineKm(
    { lng: from.lng, lat: from.lat },
    { lng: to.lng, lat: to.lat },
  )
  if (!Number.isFinite(km)) return null
  return km * 1000
}

/** 直线距离的展示文案；null 明确写「未知」，不写 0。 */
export function formatStraightDistance(meters: number | null): string {
  if (meters === null) return '直线距离未知'
  if (meters < 1000) return `直线距离 ${Math.round(meters)} 米`
  return `直线距离 ${(meters / 1000).toFixed(1)} 公里`
}

/* ───────── 候选构建 ───────── */

function trustOf(
  name: string,
  address: string | null,
  location: TripLocation | null,
  poiCards: PoiCardsRecordV1 | null,
  now: number,
): StopFactStatus {
  const probe: TripStop = {
    id: `swap-probe:${name}`,
    name,
    time: '',
    duration_minutes: null,
    description: '',
    address: address ?? '',
    location,
  }
  const facts = projectStopFacts(probe, poiCards, now)
  const statuses: StopFactStatus[] = [
    facts.intro.status,
    facts.openingHours.status,
    facts.ticket.status,
  ]
  if (statuses.includes('sourced')) return 'sourced'
  if (statuses.includes('unverified')) return 'unverified'
  return 'unknown'
}

function reasonOf(
  source: SwapCandidateSource,
  matchedKeywords: readonly string[],
): string {
  const sourceLabel = source === 'candidate_pool' ? '候选池' : '资料卡库'
  if (matchedKeywords.length > 0) {
    const shown = matchedKeywords.slice(0, 3).map((word) => `「${word}」`).join('')
    return `与当前站同为${shown}类型（来自${sourceLabel}）`
  }
  return `来自${sourceLabel}，没有命中同类型关键词`
}

function candidateLocation(item: CandidateItemV1): TripLocation | null {
  if (item.location === null) return null
  return { lng: item.location.lng, lat: item.location.lat }
}

/**
 * 构建候选列表并排序。同类型优先，其次直线距离由近到远。
 * 不修改入参；同输入同输出。
 */
export function buildSwapCandidates(input: SwapCandidateInput): SwapCandidate[] {
  const stop = input.stop
  const poiCards = input.poiCards ?? null
  const now = input.now
  const stopNameKey = normalizeCandidateText(stop.name)

  /** 当天已经有的站点名（归一化）：避免换一个换出个重复站点。 */
  const takenNames = new Set<string>()
  for (const name of input.otherStopNames ?? []) {
    const key = normalizeCandidateText(name)
    if (key.length > 0) takenNames.add(key)
  }
  takenNames.add(stopNameKey)

  const result: SwapCandidate[] = []
  const city = typeof input.city === 'string' ? input.city.trim() : ''
  const pool =
    city === ''
      ? (input.candidates ?? [])
      : filterCandidates(input.candidates ?? [], { cityId: city })

  for (const item of pool) {
    const nameKey = normalizeCandidateText(item.name)
    if (nameKey.length === 0 || takenNames.has(nameKey)) continue
    const location = candidateLocation(item)
    const searchable = [item.name, item.address ?? '', item.notes ?? '', ...item.tags].join(' ')
    const matchedKeywords = matchTypeKeywords(stop.name, searchable)
    result.push({
      id: `candidate:${item.id}`,
      source: 'candidate_pool',
      name: item.name,
      address: item.address ?? null,
      straightDistanceMeters: straightDistanceMeters(stop.location, location),
      matchedKeywords,
      trust: trustOf(item.name, item.address ?? null, location, poiCards, now),
      reason: reasonOf('candidate_pool', matchedKeywords),
      location,
    })
  }

  for (const card of poiCards?.cards ?? []) {
    const nameKey = normalizeCandidateText(card.name)
    if (nameKey.length === 0 || takenNames.has(nameKey)) continue
    const searchable = [card.name, card.intro ?? ''].join(' ')
    const matchedKeywords = matchTypeKeywords(stop.name, searchable)
    result.push({
      id: `card:${card.id}`,
      source: 'poi_card',
      name: card.name,
      address: null,
      // 资料卡没有坐标字段：直线距离只能是未知。
      straightDistanceMeters: null,
      matchedKeywords,
      trust: trustOf(card.name, null, null, poiCards, now),
      reason: reasonOf('poi_card', matchedKeywords),
      location: null,
    })
  }

  result.sort((left, right) => {
    const leftMatched = left.matchedKeywords.length > 0 ? 1 : 0
    const rightMatched = right.matchedKeywords.length > 0 ? 1 : 0
    if (leftMatched !== rightMatched) return rightMatched - leftMatched
    const leftDistance = left.straightDistanceMeters
    const rightDistance = right.straightDistanceMeters
    if (leftDistance === null && rightDistance !== null) return 1
    if (leftDistance !== null && rightDistance === null) return -1
    if (leftDistance !== null && rightDistance !== null && leftDistance !== rightDistance) {
      return leftDistance - rightDistance
    }
    const leftWeight = left.matchedKeywords.reduce((total, word) => total + word.length, 0)
    const rightWeight = right.matchedKeywords.reduce((total, word) => total + word.length, 0)
    if (leftWeight !== rightWeight) return rightWeight - leftWeight
    return left.name.localeCompare(right.name)
  })

  return result
}

/** 截取前 N 个候选（默认 3）。 */
export function topSwapCandidates(
  candidates: readonly SwapCandidate[],
  limit: number = SWAP_CANDIDATE_LIMIT,
): SwapCandidate[] {
  if (!Number.isInteger(limit) || limit <= 0) return []
  return candidates.slice(0, limit)
}

/* ───────── 替换预览 ───────── */

/** 预览里的一站。 */
export interface SwapPreviewStop {
  /** 当天顺序（1 起）。 */
  index: number
  id: string
  name: string
  time: string
  /** true = 这一站是替换后的新站。 */
  replaced: boolean
}

/** 预览里的一段路。 */
export interface SwapPreviewLeg {
  fromStopId: string
  toStopId: string
  /** true = 这段路**被这次替换**牵连作废（待重新获取路线）。
   *  当天本来就不可用的路段不算牵连（那是旧状态，不是这次替换造成的）。 */
  invalidated: boolean
  /** 作废原因说明；未作废时是原说明。 */
  description: string
}

/** 替换预览结果。 */
export interface SwapPreview {
  day: number
  stops: SwapPreviewStop[]
  legs: SwapPreviewLeg[]
  /** 被作废的路段数（只数与被替换站直接相邻的那几段）。 */
  invalidatedLegCount: number
  /** 预览里替换后的站点名。 */
  newStopName: string
}

export type SwapPreviewResult =
  | { ok: true; preview: SwapPreview }
  | { ok: false; message: string }

/**
 * 生成替换预览。内部调用的就是真正执行替换的 `replaceDraftStop`，
 * 所以预览里的顺序与路段状态和确认后的结果完全一致。
 * 预览**不写行程**：只返回计算结果。
 */
export function previewStopSwap(
  draft: TripDraft,
  dayNumber: number,
  stopId: string,
  replacement: DraftStopReplacement,
): SwapPreviewResult {
  const before = draft.days.find((day) => day.day === dayNumber)
  if (!before) return { ok: false, message: `草稿里没有第 ${dayNumber} 天，无法预览替换。` }
  const beforeStop = before.stops.find((stop) => stop.id === stopId)
  if (!beforeStop) return { ok: false, message: '这一天的站点列表里没有指定站点，无法预览替换。' }

  const replaced = replaceDraftStop(draft, dayNumber, stopId, replacement)
  if (!replaced.ok) return { ok: false, message: replaced.message }
  if (!replaced.changed) return { ok: false, message: '替换没有产生实际变化，未生成预览。' }

  const after = replaced.draft.days.find((day) => day.day === dayNumber)
  if (!after) return { ok: false, message: '替换后找不到当天行程，无法生成预览。' }

  const afterStop = after.stops.find((stop) => stop.id === stopId)
  /** 受影响路段 = 与被替换站**直接相邻**的那几段，判据与 `replaceDraftStop` 内部
   *  `invalidateLegsAroundKeepingMode` 完全一致：中间站前后两段、第一站只有后段、
   *  末站只有前段。当天本来就不可用的其他路段不计入（那是旧状态）。 */
  const isAffectedLeg = (leg: TripLeg) =>
    leg.from_stop_id === stopId || leg.to_stop_id === stopId
  const affectedLegs = after.legs.filter((leg: TripLeg) => isAffectedLeg(leg))
  return {
    ok: true,
    preview: {
      day: dayNumber,
      stops: after.stops.map((stop, index) => ({
        index: index + 1,
        id: stop.id,
        name: stop.name,
        time: stop.time,
        replaced: stop.id === stopId,
      })),
      legs: after.legs.map((leg: TripLeg) => ({
        fromStopId: leg.from_stop_id,
        toStopId: leg.to_stop_id,
        invalidated: isAffectedLeg(leg) && leg.route_type === 'unavailable',
        description: leg.description,
      })),
      invalidatedLegCount: affectedLegs.filter(
        (leg: TripLeg) => leg.route_type === 'unavailable',
      ).length,
      newStopName: afterStop?.name ?? replacement.name,
    },
  }
}

/** 预览里受影响的路线说明文案。 */
export const SWAP_PREVIEW_LEG_NOTE =
  '被替换站点前后的路段会标为「路线待重取」：距离与耗时留空，不沿用旧路线。'

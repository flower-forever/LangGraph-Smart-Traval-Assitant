/**
 * S8 · 用餐空档与补一餐候选（纯函数投影）。
 *
 * 边界（与 itineraryHealth / stopSwap / tripDraft 同一纪律）：
 * - **时窗口径与五期体检一致**：午餐 11:30–13:30、晚餐 17:30–19:30；
 *   占用 = 站点到达时刻 + 整数停留分钟；任一站点时间 / 停留不可解析 → 「无法核对」，
 *   不按 0 补、不猜。
 * - **只找不重叠的空档**：只有窗口内至少 45 分钟连续空档才插入；没有就明确说
 *   「没有可用空档」，不提供会与现有站点重叠的方案。窗口内全部空档仍如实返回，
 *   供界面解释为什么不能插。
 * - **候选只来自两处现成记录**：候选地点池与资料卡库；名称或标签命中餐饮关键词
 *   才算候选，不做外部搜索、不编造。两库都没有 → 空数组（界面沉默显示「暂无」）。
 * - **插入沿换一纪律**：走既有 `addDraftStop`，新站前后路段重建为 unavailable
 *   （geometry=[]、distance_m / duration_minutes=null、「待重新获取路线」），
 *   不沿用旧路线；新站没有坐标（location=null），直线距离写「未知」。
 * - **写入是一次编辑**：addDraftStop 本身只产生一个撤销步；失败时草稿完全不变。
 */

import type { TripDay, TripLocation, TripStop } from './api'
import { normalizeCandidateText } from './candidatePool'
import type { PoiCardsRecordV1 } from './poiCards'
import { projectStopFacts, type StopFactStatus } from './stopFacts'
import { straightDistanceMeters } from './stopSwap'
import type { DraftEditResult, TripDraft } from './tripDraft'
import { addDraftStop } from './tripDraft'
import type { CandidateItemV1 } from './workspace'

/** 与五期体检完全一致的用餐窗口（改这里必须同步体检规则）。 */
export const MEAL_WINDOWS = {
  lunch: { label: '午餐', start: '11:30', end: '13:30' },
  dinner: { label: '晚餐', start: '17:30', end: '19:30' },
} as const

export type MealWindowKey = keyof typeof MEAL_WINDOWS

/** 一餐至少需要占用 / 空出的分钟数（与体检 MAIN_MEAL_MIN_MINUTES 对齐）。 */
export const MEAL_MINUTES = 45

/** 一次最多展示几个餐饮候选（沿换一的 3 个上限）。 */
export const MEAL_CANDIDATE_LIMIT = 3

/** 判断「先插在哪个空档」时的窗口顺序：午餐在前，晚餐在后。 */
const WINDOW_ORDER: readonly MealWindowKey[] = ['lunch', 'dinner']

/** 餐饮关键词：中文按常见店名 / 标签词，拉丁按小写词根；不做模糊推断。 */
const MEAL_KEYWORDS: readonly string[] = [
  '餐厅',
  '餐馆',
  '饭馆',
  '饭店',
  '食府',
  '食店',
  '酒楼',
  '酒家',
  '小吃',
  '美食',
  '食堂',
  '餐吧',
  '咖啡馆',
  '咖啡',
  '茶餐厅',
  '茶馆',
  '茶楼',
  '早茶',
  '面馆',
  '粉店',
  '火锅',
  '烧烤',
  '烘焙',
  '甜品',
  '糕点',
  'restaurant',
  'cafe',
  'coffee',
  'bistro',
  'diner',
  'eatery',
  'bakery',
  'noodle',
  'hotpot',
  'bbq',
  'food',
]

/* ───────── 时间与窗口 ───────── */

function parseHhMm(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

function formatClock(total: number): string {
  const hour = Math.floor(total / 60)
  const minute = total % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 停留分钟数：缺失 / 非有限 / 负数 / 非整数 → null（不按 0 补）。 */
function stopDurationMinutes(stop: TripStop): number | null {
  if (typeof stop.duration_minutes !== 'number') return null
  if (!Number.isFinite(stop.duration_minutes)) return null
  if (!Number.isInteger(stop.duration_minutes)) return null
  if (stop.duration_minutes < 0) return null
  return stop.duration_minutes
}

/* ───────── 空档扫描 ───────── */

/** 用餐窗口内的一段连续空档。 */
export interface MealGap {
  window: MealWindowKey
  label: string
  /** HH:MM。 */
  start: string
  /** HH:MM。 */
  end: string
  minutes: number
}

export type MealGapScan =
  | { ok: true; gaps: MealGap[] }
  | {
      ok: false
      reason: 'empty_day' | 'unreadable_time'
      message: string
    }

/**
 * 扫描一天内午餐 / 晚餐窗口的空档。窗口内的占用只按站点到达 + 停留计算；
 * 路段时间不计入占用（与五期体检同口径）。返回的空档可能不足 45 分钟。
 */
export function scanMealGaps(day: TripDay): MealGapScan {
  if (day.stops.length === 0) {
    return {
      ok: false,
      reason: 'empty_day',
      message: '当天还没有站点，无法定位用餐空档；先安排景点再补餐。',
    }
  }

  const occupied: Array<{ start: number; end: number }> = []
  for (let i = 0; i < day.stops.length; i += 1) {
    const stop = day.stops[i]
    const arrival = parseHhMm(stop.time)
    if (arrival === null) {
      return {
        ok: false,
        reason: 'unreadable_time',
        message: `第 ${i + 1} 站「${stop.name}」的时间不是 HH:MM，无法定位用餐空档；缺失的时间不按 0 补。`,
      }
    }
    const duration = stopDurationMinutes(stop)
    if (duration === null) {
      return {
        ok: false,
        reason: 'unreadable_time',
        message: `第 ${i + 1} 站「${stop.name}」的停留时长缺失或不是整数分钟，无法定位用餐空档；缺失的停留不按 0 补。`,
      }
    }
    occupied.push({ start: arrival, end: arrival + duration })
  }
  occupied.sort((left, right) => left.start - right.start)

  const gaps: MealGap[] = []
  for (const key of WINDOW_ORDER) {
    const window = MEAL_WINDOWS[key]
    const windowStart = parseHhMm(window.start)
    const windowEnd = parseHhMm(window.end)
    if (windowStart === null || windowEnd === null) continue
    let cursor = windowStart
    for (const span of occupied) {
      if (span.end <= cursor) continue
      if (span.start >= windowEnd) break
      if (span.start > cursor) {
        const end = Math.min(span.start, windowEnd)
        if (end > cursor) {
          gaps.push({
            window: key,
            label: window.label,
            start: formatClock(cursor),
            end: formatClock(end),
            minutes: end - cursor,
          })
        }
      }
      cursor = Math.max(cursor, span.end)
      if (cursor >= windowEnd) break
    }
    if (cursor < windowEnd) {
      gaps.push({
        window: key,
        label: window.label,
        start: formatClock(cursor),
        end: formatClock(windowEnd),
        minutes: windowEnd - cursor,
      })
    }
  }
  return { ok: true, gaps }
}

/* ───────── 插入位置 ───────── */

/** 一个可插入的用餐空档及其在原站点数组里的位置。 */
export interface MealInsertionSlot {
  window: MealWindowKey
  label: string
  /** 新站到达时刻（= 空档起点）。 */
  startTime: string
  /** 新站离开时刻（= 起点 + 45 分钟）。 */
  endTime: string
  minutes: number
  /** 插入位置：新站将占据原 stops 数组的这个索引（0 = 最前）。 */
  index: number
  /** 紧邻的前一站 / 后一站（用于展示位置与直线距离锚点）。 */
  afterStopId: string | null
  afterStopName: string | null
  beforeStopId: string | null
  beforeStopName: string | null
  /** 空档本身的总长度（可能大于 45）。 */
  gapMinutes: number
}

export type MealInsertionResult =
  | { ok: true; slot: MealInsertionSlot; gaps: MealGap[] }
  | {
      ok: false
      reason: 'empty_day' | 'unreadable_time' | 'no_slot'
      message: string
      gaps: MealGap[]
    }

/**
 * 找「最近的可用用餐空档」：按午餐 → 晚餐顺序，取当天最早一个 ≥45 分钟的空档。
 * 没有这样的空档 → no_slot（不提供会重叠的插入方案）。
 */
export function findMealInsertion(day: TripDay): MealInsertionResult {
  const scan = scanMealGaps(day)
  if (!scan.ok) {
    return { ok: false, reason: scan.reason, message: scan.message, gaps: [] }
  }
  const usable = scan.gaps.find((gap) => gap.minutes >= MEAL_MINUTES)
  if (usable === undefined) {
    const largest = scan.gaps.reduce((max, gap) => Math.max(max, gap.minutes), 0)
    const largestText = largest > 0 ? `最大空档只有 ${largest} 分钟` : '两个窗口都没有空档'
    return {
      ok: false,
      reason: 'no_slot',
      message:
        `午餐与晚餐窗口内都没有 ${MEAL_MINUTES} 分钟连续空档（${largestText}）；` +
        '插入会与现有站点时段重叠，本面板不提供会重叠的方案。可先用「建议顺延」拉开时段，或手动调整。',
      gaps: scan.gaps,
    }
  }

  const gapStart = parseHhMm(usable.start)
  if (gapStart === null) {
    return {
      ok: false,
      reason: 'unreadable_time',
      message: '用餐空档的起点无法解析，未生成插入位置。',
      gaps: scan.gaps,
    }
  }
  let index = day.stops.length
  for (let i = 0; i < day.stops.length; i += 1) {
    const arrival = parseHhMm(day.stops[i].time)
    if (arrival !== null && arrival >= gapStart) {
      index = i
      break
    }
  }
  const after = index > 0 ? day.stops[index - 1] : null
  const before = index < day.stops.length ? day.stops[index] : null
  return {
    ok: true,
    gaps: scan.gaps,
    slot: {
      window: usable.window,
      label: usable.label,
      startTime: usable.start,
      endTime: formatClock(gapStart + MEAL_MINUTES),
      minutes: MEAL_MINUTES,
      index,
      afterStopId: after?.id ?? null,
      afterStopName: after?.name ?? null,
      beforeStopId: before?.id ?? null,
      beforeStopName: before?.name ?? null,
      gapMinutes: usable.minutes,
    },
  }
}

/* ───────── 餐饮候选 ───────── */

export type MealCandidateSource = 'candidate_pool' | 'poi_card'

/** 一个餐饮候选；字段与换一候选同规格，便于界面复用同一套可信状态文案。 */
export interface MealCandidate {
  /** 稳定 id：`candidate:<候选池 id>` / `card:<资料卡 id>`。 */
  id: string
  source: MealCandidateSource
  name: string
  address: string | null
  /** 直线距离（米）；无坐标锚点或候选无坐标 → null。 */
  straightDistanceMeters: number | null
  /** 命中的餐饮关键词（名称命中在前）。 */
  matchedKeywords: string[]
  /** true = 名称本身命中，而不只是标签命中。 */
  matchedInName: boolean
  /** S2 三态可信状态。 */
  trust: StopFactStatus
  /** 一句话理由：只说能核对的事实。 */
  reason: string
  location: TripLocation | null
}

export interface MealCandidateInput {
  candidates?: readonly CandidateItemV1[] | null
  poiCards?: PoiCardsRecordV1 | null
  /** 直线距离锚点：空档前 / 后最近的站点；null = 距离未知。 */
  anchorStop?: TripStop | null
  /** 当天已有站点名：排除重复插入。 */
  existingStopNames?: readonly string[]
  /** 可信状态判定用的当前时刻（由调用方传入，便于测试）。 */
  now: number
}

function keywordHits(text: string): string[] {
  if (text.length === 0) return []
  return MEAL_KEYWORDS.filter((keyword) => text.includes(keyword))
}

function reasonOf(
  source: MealCandidateSource,
  matchedInName: boolean,
  matchedKeywords: readonly string[],
): string {
  const sourceLabel = source === 'candidate_pool' ? '候选池' : '资料卡库'
  const keyword = matchedKeywords[0] ?? ''
  const where = matchedInName ? '名称' : '标签'
  return `${sourceLabel}条目，${where}含餐饮关键词「${keyword}」`
}

function trustOf(
  name: string,
  address: string | null,
  location: TripLocation | null,
  poiCards: PoiCardsRecordV1 | null,
  now: number,
): StopFactStatus {
  const probe: TripStop = {
    id: `meal-probe:${name}`,
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

/**
 * 从候选池与资料卡库按餐饮关键词过滤。名称命中优先于仅标签命中，
 * 同档按直线距离（有坐标的在前、近的在前），最后按名称排序；最多 3 个。
 */
export function buildMealCandidates(input: MealCandidateInput): MealCandidate[] {
  const poiCards = input.poiCards ?? null
  const anchor = input.anchorStop ?? null
  const takenNames = new Set<string>()
  for (const name of input.existingStopNames ?? []) {
    const key = normalizeCandidateText(name)
    if (key.length > 0) takenNames.add(key)
  }

  const result: MealCandidate[] = []
  for (const item of input.candidates ?? []) {
    const nameKey = normalizeCandidateText(item.name)
    if (nameKey.length === 0 || takenNames.has(nameKey)) continue
    const nameHits = keywordHits(normalizeCandidateText(item.name))
    const tagHits = keywordHits(normalizeCandidateText(item.tags.join(' ')))
    if (nameHits.length === 0 && tagHits.length === 0) continue
    takenNames.add(nameKey)
    const location =
      item.location === null ? null : { lng: item.location.lng, lat: item.location.lat }
    const matchedKeywords = [...nameHits, ...tagHits.filter((word) => !nameHits.includes(word))]
    result.push({
      id: `candidate:${item.id}`,
      source: 'candidate_pool',
      name: item.name,
      address: item.address ?? null,
      straightDistanceMeters: straightDistanceMeters(anchor?.location ?? null, location),
      matchedKeywords,
      matchedInName: nameHits.length > 0,
      trust: trustOf(item.name, item.address ?? null, location, poiCards, input.now),
      reason: reasonOf('candidate_pool', nameHits.length > 0, matchedKeywords),
      location,
    })
  }

  for (const card of poiCards?.cards ?? []) {
    const nameKey = normalizeCandidateText(card.name)
    if (nameKey.length === 0 || takenNames.has(nameKey)) continue
    const nameHits = keywordHits(normalizeCandidateText(card.name))
    if (nameHits.length === 0) continue
    takenNames.add(nameKey)
    result.push({
      id: `card:${card.id}`,
      source: 'poi_card',
      name: card.name,
      address: null,
      // 资料卡没有坐标字段：直线距离只能是未知。
      straightDistanceMeters: null,
      matchedKeywords: nameHits,
      matchedInName: true,
      trust: trustOf(card.name, null, null, poiCards, input.now),
      reason: reasonOf('poi_card', true, nameHits),
      location: null,
    })
  }

  result.sort((left, right) => {
    if (left.matchedInName !== right.matchedInName) return left.matchedInName ? -1 : 1
    const leftDistance = left.straightDistanceMeters
    const rightDistance = right.straightDistanceMeters
    if (leftDistance === null && rightDistance !== null) return 1
    if (leftDistance !== null && rightDistance === null) return -1
    if (leftDistance !== null && rightDistance !== null && leftDistance !== rightDistance) {
      return leftDistance - rightDistance
    }
    return left.name.localeCompare(right.name)
  })
  return result
}

/** 截取前 N 个候选（默认 3）。 */
export function topMealCandidates(
  candidates: readonly MealCandidate[],
  limit: number = MEAL_CANDIDATE_LIMIT,
): MealCandidate[] {
  if (!Number.isInteger(limit) || limit <= 0) return []
  return candidates.slice(0, limit)
}

/* ───────── 写入草稿 ───────── */

/**
 * 在已预览的空档插入餐饮站。防御性校验：预览后空档位置已变化 / 站点数变了 →
 * 拒绝写入并保持草稿原样。成功时走 `addDraftStop`，新站前后路段作废，
 * 撤销栈只增加一项。
 */
export function applyMealInsertionToDraft(
  draft: TripDraft,
  dayNumber: number,
  slot: MealInsertionSlot,
  candidate: MealCandidate,
  stopId: string,
): DraftEditResult {
  const day = draft.days.find((item) => item.day === dayNumber)
  if (!day) {
    return {
      ok: false,
      reason: 'unknown_day',
      message: `草稿里没有第 ${dayNumber} 天，补餐未生效。`,
    }
  }
  const current = findMealInsertion(day)
  if (
    !current.ok ||
    current.slot.window !== slot.window ||
    current.slot.startTime !== slot.startTime ||
    current.slot.index !== slot.index
  ) {
    return {
      ok: false,
      reason: 'postcondition_failed',
      message: '用餐空档在预览后已变化（可能有新的编辑），这次补餐没有写入；请重新预览。',
    }
  }
  return addDraftStop(
    draft,
    dayNumber,
    {
      id: stopId,
      name: candidate.name,
      time: slot.startTime,
      duration_minutes: MEAL_MINUTES,
      description: '',
      address: candidate.address ?? '',
    },
    { index: slot.index },
  )
}

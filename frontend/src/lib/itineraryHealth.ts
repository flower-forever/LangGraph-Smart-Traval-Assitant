/**
 * S3 · 行程体检：只读的行程问题检查器（五期计划 §4.1）。
 *
 * 边界纪律（与 stopFacts / routeFlow 同一血统）：
 * - **纯函数**：输入 TripDay + 节奏 + 可信字段查询（S2 投影），输出问题清单；
 *   不碰存储、不发请求、不改行程。行程数据变化时由调用方重算，不落任何存储。
 * - **保守判定**：证据不足 → unknown（「无法核对」），绝不按 0 补齐，
 *   绝不输出「已确认可行」。营业时间解析不了就不判，不猜。
 * - **可信字段只认 S2 投影口径**：openingHours 必须是投影后有值的字段
 *   （sourced 或 unverified）才参与判定；unknown（空值 / 无卡）→ 该项「无法核对」。
 *   投影层已经保证不编造来源；本模块只区分「有没有可信文本」。
 * - 所有时间解析（HH:MM、营业区间、闭馆日）都是**保守白名单式**：
 *   只认明确、无歧义的文本；含糊形状（「全天」、多段区间、含文案）一律放弃判定。
 */

import type { TripDay, TripLeg, TripStop } from './api'
import { findIntercityLeg } from './cityScope'
import { isMealStopLike, type MealWindowKey } from './mealGap'
import type { StopFactField, StopFacts } from './stopFacts'
import { analyzeDayRoute, haversineKm } from './routeFlow'

/** 节奏档位：与后端 pace 字段同一枚举；缺省 balanced。 */
export type HealthPace = 'relaxed' | 'balanced' | 'packed'

/** 问题级别：unknown 专指「数据不足无法核对」，不是「没问题」。 */
export type HealthLevel = 'ok' | 'notice' | 'warning' | 'unknown'

/** 问题类别；detour 是可选加分项（高德荒谬绕行段检测）。 */
export type HealthCode =
  | 'opening_conflict'
  | 'closed_day'
  | 'meal_gap'
  | 'pace'
  | 'intercity_transfer'
  | 'backtrack'
  | 'unknown_time'
  | 'detour'

/** 一条体检结果。message 给用户看，evidence 是判定依据，suggestion 只指向手动入口。 */
export interface HealthItem {
  code: HealthCode
  level: HealthLevel
  /** 一句话说明问题（或「无法核对」的原因）。 */
  message: string
  /** 判定依据：引用了哪些站、什么文本、什么阈值；unknown 项说明缺什么数据。 */
  evidence: string
  /** 只指向手动入口的说明；unknown 项为 null。 */
  suggestion: string | null
  /**
   * S8-36：meal_gap 首个出问题的用餐窗口，供「补一餐」优先选择。
   * 仅 meal_gap notice 携带；其他条目 / unknown 缺省不写。
   */
  preferredWindow?: MealWindowKey
}

/** 一天的体检输出：问题清单 + 汇总计数。 */
export interface DayHealthReport {
  items: HealthItem[]
  /** 汇总：X 项冲突（warning）/ Y 项需确认（notice）/ Z 项无法核对（unknown）。 */
  counts: { warning: number; notice: number; unknown: number }
}

/** 节奏阈值表：每天最多站数 / 日跨度上限（分钟）/ 站间缓冲下限（分钟）。 */
export const PACE_LIMITS: Record<HealthPace, {
  maxStops: number
  maxDaySpanMinutes: number
  minBufferMinutes: number
}> = {
  relaxed: { maxStops: 4, maxDaySpanMinutes: 8 * 60, minBufferMinutes: 20 },
  balanced: { maxStops: 6, maxDaySpanMinutes: 10 * 60, minBufferMinutes: 15 },
  packed: { maxStops: 8, maxDaySpanMinutes: 12 * 60, minBufferMinutes: 10 },
}

/** 正餐窗口：午餐与晚餐，各要求至少 MAIN_MEAL_MIN_MINUTES 的空档。 */
const LUNCH_WINDOW = { start: '11:30', end: '13:30' } as const
const DINNER_WINDOW = { start: '17:30', end: '19:30' } as const
const MAIN_MEAL_MIN_MINUTES = 45

/* ───────── 时间解析（保守白名单） ───────── */

/** HH:MM（24 小时制）→ 当日分钟数；非法返回 null。 */
function parseHhMm(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * 分钟数 → 中文时长（仅用于 evidence 文案）。
 * 不用 HH:MM：日跨度与阈值都是「时长」，写成 12:35 会被读成时刻（五期-3 审计项）。
 * 整小时不带「0 分」，不足 1 小时只写分钟。
 */
function formatDurationCn(total: number): string {
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes} 分钟`
  if (minutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${minutes} 分`
}

/** 当日分钟数 → HH:MM（仅用于城际到达时刻的 evidence / message）。 */
function formatClock(total: number): string {
  const hour = Math.floor(total / 60)
  const minute = total % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * 单段营业区间「09:00-17:00」（支持全角／半角连字符与冒号）→ [start, end] 分钟。
 * 只认「时间-时间」一个区间的文本：多段（顿号/逗号/第二条）、「全天」、带「周X」
 * 等含糊形状一律返回 null（不猜）。
 */
function parseSingleOpeningRange(text: string): { start: number; end: number } | null {
  const normalized = text
    .trim()
    .replace(/[－–—～〜]/g, '-')
    .replace(/：/g, ':')
    .replace(/\s+/g, '')
  // 只允许「HH:MM-HH:MM」这一种形状：首尾之外不得出现其它时间或说明文字。
  const match = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(normalized)
  if (!match) return null
  const start = parseHhMm(match[1])
  const end = parseHhMm(match[2])
  if (start === null || end === null) return null
  if (end <= start) return null // 跨午夜 / 零区间不判，宁可放弃
  return { start, end }
}

/** 星期几（0=周日..6=周六）→ 中文表述集合（「周一」与「星期一」两种写法）。 */
const WEEKDAY_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['周日', '星期日'],
  ['周一', '星期一'],
  ['周二', '星期二'],
  ['周三', '星期三'],
  ['周四', '星期四'],
  ['周五', '星期五'],
  ['周六', '星期六'],
]

/**
 * 从营业时间文本里识别**明确的闭馆日**：「周一闭馆」「每周二闭馆」「星期三闭馆」。
 * 只认「（每周）星期X（全天）闭馆」这一种明确句式，且一次只处理一个闭馆日；
 * 多个闭馆日 / 区间写法（「周一至周二闭馆」）不猜，返回 null。
 */
function parseClosedDay(text: string): number | null {
  const normalized = text.replace(/\s+/g, '')
  const match = /^(?:每周|每)?(周|星期)([一二三四五六日天])闭馆$/.exec(normalized)
  if (!match) return null
  const index = WEEKDAY_NAMES.findIndex(([a, b]) => a === match[1] + match[2] || b === match[1] + match[2])
  return index >= 0 ? index : null
}

/** YYYY-MM-DD → 星期几（0=周日..6=周六）；非法返回 null。 */
function weekdayOfDate(date: string | null): number | null {
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(y, m - 1, d))
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    return null
  }
  return parsed.getUTCDay()
}

/** 停点停留分钟数：缺失或非法返回 null（不按 0 补）。 */
function stopDurationMinutes(stop: TripStop): number | null {
  if (typeof stop.duration_minutes !== 'number' || !Number.isFinite(stop.duration_minutes)) {
    return null
  }
  return stop.duration_minutes
}

/** 相邻两站之间的路段时间（分钟）：任一段不可用 → null（不按 0 补）。 */
function legDurationMinutes(day: TripDay, index: number): number | null {
  const leg = day.legs[index]
  if (leg === undefined) return null
  if (leg.from_stop_id !== day.stops[index]?.id || leg.to_stop_id !== day.stops[index + 1]?.id) {
    return null
  }
  if (leg.route_type === 'unavailable') return null
  if (typeof leg.duration_minutes !== 'number' || !Number.isFinite(leg.duration_minutes)) {
    return null
  }
  return leg.duration_minutes
}

/* ───────── 各规则 ───────── */

/**
 * 营业冲突：仅当营业时间文本可保守解析为单段区间、且站点到达时间可解析时判定。
 * 解析不了 → 无法核对（unknown），不猜。
 */
function checkOpeningConflicts(
  day: TripDay,
  factsByStop: ReadonlyArray<StopFacts | null>,
): HealthItem | null {
  const conflicts: string[] = []
  const uncheckable: string[] = []

  day.stops.forEach((stop, index) => {
    const opening = factsByStop[index]?.openingHours
    if (!opening || opening.value === null) {
      // 无卡 / 空值：没有可信文本可核对，不单独报「无法核对」——
      // 有行程必有资料可补，unknown_time 已覆盖时间缺失；这里只统计可核对对象。
      uncheckable.push(stop.name)
      return
    }
    const range = parseSingleOpeningRange(opening.value)
    const arrival = parseHhMm(stop.time)
    if (range === null || arrival === null) {
      uncheckable.push(stop.name)
      return
    }
    if (arrival < range.start || arrival >= range.end) {
      conflicts.push(
        `${stop.name}（${opening.value}，到达 ${stop.time}）`,
      )
    }
  })

  if (conflicts.length > 0) {
    return {
      code: 'opening_conflict',
      level: 'warning',
      message: `有 ${conflicts.length} 个站点的到达时间落在营业时间之外。`,
      evidence: conflicts.join('；') + '。营业时间取自资料卡，到达时间取自行程表。',
      suggestion: '请用「编辑这趟行程」或「AI 调整单日」手动调整时间或顺序。',
    }
  }
  if (uncheckable.length > 0 && day.stops.length > 0) {
    return {
      code: 'opening_conflict',
      level: 'unknown',
      message: `无法核对 ${uncheckable.length} 个站点的营业时间是否冲突。`,
      evidence: `${uncheckable.join('、')}：资料卡上没有可解析的营业时间文本（只认「09:00-17:00」这类单段格式），不猜不判。`,
      suggestion: null,
    }
  }
  return null
}

/**
 * 闭馆日：识别「周一闭馆」等明确文本，与 day.date 星期比对。
 * 日期缺失 / 文本解析不了 → 无法核对；文本明确且不是当天 → 正常，不报。
 */
function checkClosedDay(
  day: TripDay,
  factsByStop: ReadonlyArray<StopFacts | null>,
): HealthItem | null {
  const weekday = weekdayOfDate(day.date)
  if (weekday === null) {
    // 整天没日期：只要行程里有站点，就无法核对闭馆日（不猜）。
    if (day.stops.length === 0) return null
    return {
      code: 'closed_day',
      level: 'unknown',
      message: '无法核对闭馆日：这一天没有可解析的日期。',
      evidence: `第 ${day.day} 天 date 缺失或不是 YYYY-MM-DD；闭馆日判定需要具体日期与「周一闭馆」这类明确文本比对。`,
      suggestion: null,
    }
  }

  const closedStops: string[] = []
  const uncheckable: string[] = []
  day.stops.forEach((stop, index) => {
    const opening = factsByStop[index]?.openingHours
    if (!opening || opening.value === null) {
      // 无卡 / 空值 / 区间文本：闭馆日无法核对。但「09:00-17:00」这类区间文本
      // 虽然解析不出闭馆日，也绝不是闭馆声明——区间营业意味着不闭馆，
      // 这里按「文本明确、不涉闭馆」处理，不并入 unknown，避免正常行程误报。
      if (opening && opening.value !== null && parseSingleOpeningRange(opening.value) !== null) {
        return
      }
      uncheckable.push(stop.name)
      return
    }
    const closedDay = parseClosedDay(opening.value)
    if (closedDay === null) {
      if (parseSingleOpeningRange(opening.value) !== null) return
      uncheckable.push(stop.name)
      return
    }
    if (closedDay === weekday) {
      closedStops.push(`${stop.name}（${opening.value}，当天是${WEEKDAY_NAMES[weekday][0]}）`)
    }
  })

  if (closedStops.length > 0) {
    return {
      code: 'closed_day',
      level: 'warning',
      message: `有 ${closedStops.length} 个站点当天可能是闭馆日。`,
      evidence: closedStops.join('；') + '。闭馆日取自资料卡明确文本「周X闭馆」。',
      suggestion: '请用「编辑这趟行程」移除或替换该站点，或核对当年实际开放安排。',
    }
  }
  if (uncheckable.length > 0) {
    return {
      code: 'closed_day',
      level: 'unknown',
      message: `无法核对 ${uncheckable.length} 个站点的闭馆日。`,
      evidence: `${uncheckable.join('、')}：资料卡上没有「周X闭馆」这类明确闭馆文本，也没有可解析的营业区间，本体检不猜。`,
      suggestion: null,
    }
  }
  return null
}

/** 一个窗口在当日占用轨迹里的最大空档（分钟）；轨迹不可解析 → null。 */
function largestFreeGapInWindow(
  occupied: ReadonlyArray<{ start: number; end: number }>,
  window: { start: string; end: string },
): number | null {
  const windowStart = parseHhMm(window.start)
  const windowEnd = parseHhMm(window.end)
  if (windowStart === null || windowEnd === null) return null
  let gap = windowEnd - windowStart
  for (const span of occupied) {
    const overlapStart = Math.max(span.start, windowStart)
    const overlapEnd = Math.min(span.end, windowEnd)
    if (overlapEnd > overlapStart) {
      gap -= overlapEnd - overlapStart
    }
  }
  return gap
}

/**
 * 用餐窗口：午餐 / 晚餐窗口内至少各留 45 分钟连续空档。
 * 站点时间或停留缺失 → 无法核对；不自动认定沿途有餐馆。
 */
function checkMealGaps(day: TripDay): HealthItem | null {
  const occupied: Array<{ start: number; end: number }> = []
  let timeMissing = false

  for (let i = 0; i < day.stops.length; i += 1) {
    const stop = day.stops[i]
    const arrival = parseHhMm(stop.time)
    if (arrival === null) {
      timeMissing = true
      continue
    }
    const duration = stopDurationMinutes(stop)
    if (duration === null) {
      timeMissing = true
      continue
    }
    occupied.push({ start: arrival, end: arrival + duration })
  }

  if (timeMissing) {
    return {
      code: 'meal_gap',
      level: 'unknown',
      message: '无法核对用餐窗口：部分站点缺到达时间或停留时长。',
      evidence: '用餐判定需要每个站点的 HH:MM 到达时间与整数停留分钟数；缺失的时间不按 0 补。',
      suggestion: null,
    }
  }
  if (day.stops.length === 0) return null

  const problems: string[] = []
  /** S8-36：记录首个出问题的窗口，供补餐面板「优先体检提示窗口」。 */
  let preferredWindow: MealWindowKey | undefined
  /** S8-39：窗口内已有餐饮站 → 视为已安排正餐，不再按空档不足报 notice。 */
  const mealStops: string[] = []
  const windows: Array<[MealWindowKey, string, { start: string; end: string }]> = [
    ['lunch', '午餐', LUNCH_WINDOW],
    ['dinner', '晚餐', DINNER_WINDOW],
  ]
  for (const [key, label, window] of windows) {
    const windowStart = parseHhMm(window.start)
    const windowEnd = parseHhMm(window.end)
    // 口径：到达时间落在窗口内（左闭右开）且站名 / 描述命中餐饮关键词。
    // 只认行程里已经安排的站，不推断沿途是否有餐馆。
    const mealStop =
      windowStart === null || windowEnd === null
        ? undefined
        : day.stops.find((stop) => {
            const arrival = parseHhMm(stop.time)
            return (
              arrival !== null &&
              arrival >= windowStart &&
              arrival < windowEnd &&
              isMealStopLike(stop)
            )
          })
    if (mealStop !== undefined) {
      mealStops.push(`${label}（${mealStop.time}「${mealStop.name}」）`)
      continue
    }
    const gap = largestFreeGapInWindow(occupied, window)
    if (gap === null) continue
    if (gap < MAIN_MEAL_MIN_MINUTES) {
      problems.push(`${label}（${window.start}–${window.end}）窗口内最大空档仅 ${gap} 分钟`)
      if (preferredWindow === undefined) preferredWindow = key
    }
  }

  if (problems.length > 0) {
    const mealStopNote =
      mealStops.length > 0
        ? `已识别到餐饮站：${mealStops.join('、')}，对应窗口按已安排正餐处理。`
        : ''
    return {
      code: 'meal_gap',
      level: 'notice',
      message: `正餐窗口偏紧：${problems.length === 2 ? '午餐与晚餐' : problems[0]}安排可能没有留足正餐时间。`,
      evidence:
        `${problems.join('；')}。` +
        mealStopNote +
        `要求 ${LUNCH_WINDOW.start}-${LUNCH_WINDOW.end} 与 ` +
        `${DINNER_WINDOW.start}-${DINNER_WINDOW.end} 各留至少 ${MAIN_MEAL_MIN_MINUTES} 分钟；` +
        '占用按站点到达时间 + 停留时长计算。本体检不确认沿途是否有餐馆。',
      suggestion: '可在「编辑这趟行程」里留出用餐时间，或让「AI 调整单日」避开饭点。',
      ...(preferredWindow === undefined ? {} : { preferredWindow }),
    }
  }
  return null
}

/**
 * 节奏：三档阈值（站数 / 日跨度 / 站间缓冲）。
 * 缺时间 / 停留 / 路段时间 → 该项 unknown，不按 0 补。
 */
function checkPace(day: TripDay, pace: HealthPace): HealthItem | null {
  const limits = PACE_LIMITS[pace]
  const paceLabel = pace === 'relaxed' ? '松弛' : pace === 'packed' ? '紧凑' : '均衡'
  const problems: string[] = []

  // 1) 站数：总是可判（站点个数就是事实）。
  if (day.stops.length > limits.maxStops) {
    problems.push(`站点 ${day.stops.length} 个，超过${paceLabel}节奏上限 ${limits.maxStops} 个`)
  }

  // 2) 日跨度：首站到达 → 末站离开。任何时间/停留缺失 → 无法核对。
  let spanKnown = true
  if (day.stops.length > 0) {
    const first = parseHhMm(day.stops[0].time)
    const lastArrival = parseHhMm(day.stops[day.stops.length - 1].time)
    const lastDuration = stopDurationMinutes(day.stops[day.stops.length - 1])
    if (first === null || lastArrival === null || lastDuration === null) {
      spanKnown = false
    } else {
      const span = lastArrival + lastDuration - first
      if (span > limits.maxDaySpanMinutes) {
        problems.push(
          `日跨度约 ${formatDurationCn(span)}（${day.stops[0].time} 到达至末站离开），超过${paceLabel}节奏上限 ${formatDurationCn(limits.maxDaySpanMinutes)}`,
        )
      }
    }
  }

  // 3) 站间缓冲：到达+停留+路段时间 与下一站到达之差。任一环缺失 → 无法核对。
  let bufferKnown = true
  if (day.stops.length >= 2) {
    for (let i = 0; i < day.stops.length - 1; i += 1) {
      const arrival = parseHhMm(day.stops[i].time)
      const duration = stopDurationMinutes(day.stops[i])
      const leg = legDurationMinutes(day, i)
      const nextArrival = parseHhMm(day.stops[i + 1].time)
      if (arrival === null || duration === null || leg === null || nextArrival === null) {
        bufferKnown = false
        break
      }
      const buffer = nextArrival - (arrival + duration + leg)
      if (buffer < limits.minBufferMinutes) {
        problems.push(
          `第 ${i + 1}→${i + 2} 站缓冲约 ${buffer} 分钟，低于${paceLabel}节奏下限 ${limits.minBufferMinutes} 分钟`,
        )
      }
    }
  }

  const unknownParts: string[] = []
  if (day.stops.length > 0 && !spanKnown) unknownParts.push('日跨度（缺首末站时间或停留）')
  if (day.stops.length >= 2 && !bufferKnown) unknownParts.push('站间缓冲（缺站点时间、停留或路段时长）')

  if (unknownParts.length > 0 && problems.length === 0) {
    return {
      code: 'pace',
      level: 'unknown',
      message: `无法按${paceLabel}节奏完整核对：${unknownParts.join('、')}数据缺失。`,
      evidence: `缺失项：${unknownParts.join('、')}。${paceLabel}节奏阈值：≤${limits.maxStops} 站、日跨度≤${formatDurationCn(limits.maxDaySpanMinutes)}、站间缓冲≥${limits.minBufferMinutes} 分钟。缺失的数据（含路段时长）不按 0 补，只报可核实的部分。`,
      suggestion: null,
    }
  }
  if (problems.length > 0) {
    const note = unknownParts.length > 0 ? `（另有 ${unknownParts.join('、')} 数据缺失未核对）` : ''
    return {
      code: 'pace',
      level: 'notice',
      message: `行程比${paceLabel}节奏偏紧。${note}`,
      evidence: problems.join('；') + `。${paceLabel}节奏阈值：≤${limits.maxStops} 站、日跨度≤${formatDurationCn(limits.maxDaySpanMinutes)}、站间缓冲≥${limits.minBufferMinutes} 分钟。`,
      suggestion: '可用「编辑这趟行程」删减站点或拉长时间，或交给「AI 调整单日」重排。',
    }
  }
  return null
}

/**
 * 城际转移（七期 S5）：当天最后一条 `transferKind='intercity'` 的 leg。
 *
 * - 绕行：`distance_m` 与两端 haversine 直线距离比对，超过 1.6 倍 → notice。
 *   S1 的 straight_line 距离 = 直线，比为 1.0，不误报；真实路线距离接入后生效。
 * - 时间：当天末站离开（到达 + 停留）+ 城际耗时 晚于下一天首站到达 → notice。
 * - leg / 坐标 / 时间 / 下一天缺失 → unknown（不猜、不按 0 补）。
 * - 单城无城际 leg → null，零输出。
 */
export const INTERCITY_DETOUR_RATIO = 1.6

function checkIntercityTransfer(day: TripDay, nextDay: TripDay | null): HealthItem | null {
  const leg = findIntercityLeg(day)
  if (leg === null) return null

  const problems: string[] = []
  const unknownParts: string[] = []
  const evidenceParts: string[] = []

  const fromStop = day.stops.find((stop) => stop.id === leg.from_stop_id) ?? null
  const nextFirstStop = nextDay?.stops[0] ?? null
  // 到达站：优先在下一天找（契约：城际段连接当日末站与次日首站），找不到再看当天。
  const toStop =
    nextDay?.stops.find((stop) => stop.id === leg.to_stop_id) ??
    day.stops.find((stop) => stop.id === leg.to_stop_id) ??
    null

  if (fromStop === null) unknownParts.push('城际段的出发站不在当天行程里')
  if (nextDay === null) unknownParts.push('没有下一天行程，无法核对城际到达时间')
  else if (nextFirstStop === null) unknownParts.push('下一天没有站点，无法核对城际到达时间')

  const routeUsable = leg.route_type !== 'unavailable'
  if (!routeUsable) {
    unknownParts.push('城际段路线待重新获取（route_type=unavailable）')
  }

  /* 1) 绕行检查：路线距离 vs 端点直线距离。 */
  const legMeters =
    routeUsable && typeof leg.distance_m === 'number' && Number.isFinite(leg.distance_m)
      ? leg.distance_m
      : null
  const straightKm =
    fromStop?.location != null && toStop?.location != null
      ? haversineKm(fromStop.location, toStop.location)
      : Number.NaN
  const straightMeters = Number.isFinite(straightKm) ? straightKm * 1000 : null

  if (routeUsable) {
    if (legMeters === null) unknownParts.push('城际段缺路线距离 distance_m')
    if (straightMeters === null) unknownParts.push('城际段端点缺可用坐标')
  }
  if (legMeters !== null && straightMeters !== null) {
    evidenceParts.push(
      `路线距离 ${(legMeters / 1000).toFixed(1)} 公里 / 两端直线 ${(straightMeters / 1000).toFixed(1)} 公里`,
    )
    if (legMeters > straightMeters * INTERCITY_DETOUR_RATIO) {
      problems.push(
        `城际转移绕行异常：路线距离约 ${(legMeters / 1000).toFixed(1)} 公里，` +
          `两端直线仅 ${(straightMeters / 1000).toFixed(1)} 公里（超过 ${INTERCITY_DETOUR_RATIO} 倍）。`,
      )
    }
  }

  /* 2) 时间检查：末站离开 + 城际耗时 vs 下一天首站到达。 */
  const legMinutes =
    routeUsable && typeof leg.duration_minutes === 'number' && Number.isFinite(leg.duration_minutes)
      ? leg.duration_minutes
      : null
  const lastArrival = fromStop !== null ? parseHhMm(fromStop.time) : null
  const lastDuration = fromStop !== null ? stopDurationMinutes(fromStop) : null
  const departAt =
    lastArrival !== null && lastDuration !== null ? lastArrival + lastDuration : null
  const nextArrival = nextFirstStop !== null ? parseHhMm(nextFirstStop.time) : null

  if (routeUsable && legMinutes === null) unknownParts.push('城际段缺耗时 duration_minutes')
  if (fromStop !== null && (lastArrival === null || lastDuration === null)) {
    unknownParts.push('当天末站缺到达时间或停留时长')
  }
  if (nextFirstStop !== null && nextArrival === null) {
    unknownParts.push('下一天首站缺到达时间')
  }
  if (departAt !== null && legMinutes !== null) {
    const expectedArrival = departAt + legMinutes
    evidenceParts.push(
      `末站 ${formatClock(departAt)} 离开 + 城际 ${legMinutes} 分钟 = ${formatClock(expectedArrival % (24 * 60))}`,
    )
    if (expectedArrival >= 24 * 60) {
      // 跨午夜：当日时刻不可直接比较，宁可放弃判定。
      unknownParts.push('城际耗时跨越午夜，无法用当日时刻核对')
    } else if (nextArrival !== null && nextArrival < expectedArrival) {
      problems.push(
        `城际转移时间不足：预计 ${formatClock(expectedArrival)} 抵达，` +
          `但下一天首站 ${nextFirstStop?.time} 已安排到达（早 ${expectedArrival - nextArrival} 分钟）。`,
      )
    }
  }

  if (problems.length > 0) {
    const note = unknownParts.length > 0 ? `（另有未核对项：${unknownParts.join('、')}）` : ''
    return {
      code: 'intercity_transfer',
      level: 'notice',
      message: problems.join('；') + note,
      evidence:
        `${evidenceParts.join('；')}。` +
        `城际段按 legs 的 transferKind='intercity' 识别；绕行阈值为直线的 ${INTERCITY_DETOUR_RATIO} 倍，` +
        '时间按「末站离开 + 城际耗时」与下一天首站到达比对。',
      suggestion: '请用「编辑这趟行程」调整城际段或次日首站时间；本体检不会自动修改行程。',
    }
  }
  if (unknownParts.length > 0) {
    const fromLabel = fromStop?.name ?? leg.from_stop_id
    const toLabel = toStop?.name ?? leg.to_stop_id
    return {
      code: 'intercity_transfer',
      level: 'unknown',
      message: `无法完整核对城际转移：${unknownParts.join('、')}。`,
      evidence:
        `城际段（${fromLabel} → ${toLabel}）数据不全；` +
        '缺失项不按 0 补，绕行与时间两项都不猜测。' +
        (evidenceParts.length > 0 ? evidenceParts.join('；') + '。' : ''),
      suggestion: null,
    }
  }
  return null
}

/**
 * 折返：复用 routeFlow 的相邻交换分析；缩短 ≥10% 才提示「顺序可优化」，
 * 不自动改。坐标缺失等 → 沉默（routeFlow 自己的 unknown 语义），本规则不再叠加。
 *
 * 七期 S5 防御性豁免：`transferKind='intercity'` 的 leg 不参与同日回溯。
 * `analyzeDayRoute` 只吃 stops、本就不读 legs，所以这里无需额外过滤；
 * 追加城际段前后 backtrack 输出必须完全一致（回归用例 6 钉住）。
 * 站级城市（stop.cityId）留八期，同日跨城站对不在本片识别范围。
 */
function checkBacktrack(day: TripDay): HealthItem | null {
  const analysis = analyzeDayRoute(
    day.stops.map((stop) => ({
      name: stop.name,
      lat: stop.location?.lat ?? null,
      lng: stop.location?.lng ?? null,
    })),
  )
  if (analysis.status !== 'suggestion') return null
  const { index, improvementRatio, savedKm } = analysis.suggestion
  const percent = (improvementRatio * 100).toFixed(1)
  const km = savedKm.toFixed(1)
  return {
    code: 'backtrack',
    level: 'notice',
    message: `顺序可优化：第 ${index} 站与第 ${index + 1} 站互换，本日路程约缩短 ${percent}%（约 ${km} 公里）。`,
    evidence: `按站点记录坐标（WGS84）计算相邻两站交换前后的 haversine 总路程；缩短 ≥10% 才提示，不是全局最优路线。`,
    suggestion: '请用「编辑这趟行程」手动交换两站，或交给「AI 调整单日」；本体检不会自动修改行程。',
  }
}

/**
 * 折返之外的超长路段检测（可选加分项）：单段直线距离 ≥ DETOUR_KM_LIMIT 公里
 * 视为可疑绕行段（S1 实测高德出现过 97km 级荒谬路段）。坐标缺失 → 沉默。
 */
export const DETOUR_KM_LIMIT = 30

function checkDetour(day: TripDay): HealthItem | null {
  const points = day.stops.map((stop) => stop.location)
  if (points.some((point) => point === null || !Number.isFinite(point.lng) || !Number.isFinite(point.lat))) {
    return null
  }
  // 七期 S5：按 from_stop_id/to_stop_id 精确匹配站点对，legs 缺段 / 插入城际段时不再按
  // 位置错位；城际转移段本身是跨城长距离，不参与同日 detour（绕行交给 intercity_transfer）。
  const legByPair = new Map<string, TripLeg>()
  for (const leg of day.legs) {
    if (leg.transferKind === 'intercity') continue
    legByPair.set(`${leg.from_stop_id}\u0000${leg.to_stop_id}`, leg)
  }
  let worstIndex = -1
  let worstKm = 0
  for (let i = 1; i < points.length; i += 1) {
    const leg = legByPair.get(`${day.stops[i - 1].id}\u0000${day.stops[i].id}`)
    const legKm =
      leg !== undefined && typeof leg.distance_m === 'number' && Number.isFinite(leg.distance_m)
        ? leg.distance_m / 1000
        : null
    if (legKm === null) continue
    if (legKm > worstKm) {
      worstKm = legKm
      worstIndex = i
    }
  }
  if (worstIndex < 0 || worstKm < DETOUR_KM_LIMIT) return null
  return {
    code: 'detour',
    level: 'notice',
    message: `第 ${worstIndex}→${worstIndex + 1} 站路段约 ${worstKm.toFixed(1)} 公里，明显超出城市游览的常见尺度，可能存在绕行。`,
    evidence: `路段距离取自行程 legs 的 distance_m（地图服务写入）；单段 ≥ ${DETOUR_KM_LIMIT} 公里才提示。`,
    suggestion: '建议核对这两站的地址是否同名混淆，可用「仅刷新地图」重取路段或手动调整站点。',
  }
}

/**
 * 未知时间：关键时间 / 交通缺失单独列「需人工确认」。
 * 只有当确实缺数据时才产出；不缺 → null。
 */
function checkUnknownTime(day: TripDay): HealthItem | null {
  const missingTime = day.stops.filter((stop) => parseHhMm(stop.time) === null).map((stop) => stop.name)
  const missingDuration = day.stops
    .filter((stop) => stopDurationMinutes(stop) === null)
    .map((stop) => stop.name)
  const legs = day.legs.filter(
    (leg) =>
      leg.route_type === 'unavailable' ||
      typeof leg.duration_minutes !== 'number' ||
      !Number.isFinite(leg.duration_minutes),
  )
  const hasLegProblem = day.stops.length >= 2 && legs.length > 0

  if (missingTime.length === 0 && missingDuration.length === 0 && !hasLegProblem) return null

  const parts: string[] = []
  if (missingTime.length > 0) parts.push(`${missingTime.length} 个站点缺到达时间（${missingTime.join('、')}）`)
  if (missingDuration.length > 0) parts.push(`${missingDuration.length} 个站点缺停留时长（${missingDuration.join('、')}）`)
  if (hasLegProblem) parts.push(`${legs.length} 段路缺耗时或标记待重新获取`)

  return {
    code: 'unknown_time',
    level: 'unknown',
    message: '时间信息不完整，需要人工确认：' + parts.join('；') + '。',
    evidence: '行程表里的时间 / 停留 / 路段耗时是体检判定的输入；这些字段缺失时相关规则输出「无法核对」，不按 0 补齐。',
    suggestion: '可在「编辑这趟行程」补齐时间，或用「仅刷新地图」补路段耗时。',
  }
}

/* ───────── 汇总 ───────── */

function summarize(items: readonly HealthItem[]): DayHealthReport['counts'] {
  let warning = 0
  let notice = 0
  let unknown = 0
  for (const item of items) {
    if (item.level === 'warning') warning += 1
    else if (item.level === 'notice') notice += 1
    else if (item.level === 'unknown') unknown += 1
  }
  return { warning, notice, unknown }
}

/**
 * 一天的体检。输入：当天行程 + 节奏档位 + 每站的可信字段查询（S2 投影，可为 null）。
 * 输出只读问题清单；同输入同输出；零副作用。
 *
 * rules 顺序固定：opening → closed → meal → pace → intercity_transfer → backtrack →
 * detour → unknown_time。
 *
 * 七期 S5：`nextDay` 可选（默认 null），只用于城际转移的时间核对；
 * 旧调用不传时行为除「有城际段会报 unknown」外与五期完全一致。
 */
export function inspectDayHealth(
  day: TripDay,
  pace: HealthPace,
  factsByStop: ReadonlyArray<StopFacts | null>,
  nextDay: TripDay | null = null,
): DayHealthReport {
  const items: HealthItem[] = []
  const push = (item: HealthItem | null) => {
    if (item !== null) items.push(item)
  }

  push(checkOpeningConflicts(day, factsByStop))
  push(checkClosedDay(day, factsByStop))
  push(checkMealGaps(day))
  push(checkPace(day, pace))
  push(checkIntercityTransfer(day, nextDay))
  push(checkBacktrack(day))
  push(checkDetour(day))
  push(checkUnknownTime(day))

  return { items, counts: summarize(items) }
}

/** 节奏展示名（结果页「按均衡节奏」等文案共用）。 */
export function paceLabelOf(pace: HealthPace): string {
  return pace === 'relaxed' ? '松弛' : pace === 'packed' ? '紧凑' : '均衡'
}

/** 导出给 UI / 测试复用的类型与常量别名。 */
export type { StopFactField, StopFacts }

/**
 * S4 · 一日跟随：「今天」只读投影（五期计划 §5）。
 *
 * 边界纪律（与 stopFacts / itineraryHealth 同一血统）：
 * - **纯函数**：输入 TripDay / 清单 / 约束 + 当前时间（时钟由调用方注入，
 *   生产 Date.now、测试传固定时刻），输出展示事实；不碰存储、不发请求、零副作用。
 * - **保守判定**：时间解析是白名单式（HH:MM / HH:MM:SS 折叠），解析不了就标
 *   「时间未知」，绝不猜；路程耗时缺失 → 「出发时间未知」，绝不按 0 补齐。
 * - **不冒充**：straight_line 路段的耗时只作出发建议并标 approximate（示意），
 *   不冒充导航时长；预约提醒只收录清单 / 约束里已有记录，没有就是没有。
 * - 出发建议 = 站时间 − 路程耗时 − 出发缓冲；只对「有上一站 leg 且耗时已知」
 *   的站给出，第一站没有上一站路程数据，同样诚实标未知。
 */

import type { TripDay, TripStop } from './api'
import { MODE_LABELS } from './format'
import { isCalendarDate } from './weather'
import type { ChecklistItemV1, ConstraintItemV1 } from './workspaceTypes'

/** 出发建议的固定缓冲（分钟）：到站前留出的余量。 */
export const DEPARTURE_BUFFER_MINUTES = 10

/* ───────── 时钟与时间解析 ───────── */

/** 本机日期键 YYYY-MM-DD（本地时区拆字段，不用 toISOString 的 UTC 偏移）。 */
export function localDateKey(nowMs: number): string {
  const d = new Date(nowMs)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 当前时刻的当日分钟数（本地时区）；时钟非法返回 0。 */
export function minutesOfDay(nowMs: number): number {
  const d = new Date(nowMs)
  if (Number.isNaN(d.getTime())) return 0
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * 站点时刻 → 当日分钟数。白名单：HH:MM 或 HH:MM:SS（秒折叠丢弃，与 displayTime
 * 同一容忍度）；超出 24h / 60min 或形状含糊一律 null（时间未知）。
 */
export function parseStopTimeMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(time.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/** 当日分钟数 → HH:MM；越界（跨零点 / 非法）返回空串，由调用方按未知处理。 */
export function minutesToHhMm(total: number): string {
  if (!Number.isFinite(total) || total < 0 || total >= 1440) return ''
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/* ───────── 当前天判定 ───────── */

export type TodayDayKind = 'matched' | 'unmatched_first' | 'no_dates'

export interface TodayDayPick {
  /** 判定出的「今天」；行程没有任何天时为 null（卡片不渲染）。 */
  day: TripDay | null
  /**
   * matched：某天 date 与本机日期一致；unmatched_first：有日期但都没对上，
   * 兜底取第 1 天并如实标注；no_dates：整份行程没有合法日期，默认第 1 天。
   */
  kind: TodayDayKind
}

/** 当前天判定：按本机日期匹配 day.date；匹配不到兜底第 1 天，不猜其它天。 */
export function pickTodayDay(days: readonly TripDay[], nowMs: number): TodayDayPick {
  if (!Array.isArray(days) || days.length === 0) return { day: null, kind: 'no_dates' }
  const hasDated = days.some((d) => isCalendarDate(d.date))
  if (!hasDated) return { day: days[0], kind: 'no_dates' }
  const key = localDateKey(nowMs)
  const matched = days.find((d) => d.date === key)
  if (matched) return { day: matched, kind: 'matched' }
  return { day: days[0], kind: 'unmatched_first' }
}

/* ───────── 下一站判定 ───────── */

export type NextStopKind = 'no_stops' | 'upcoming' | 'finished'

export interface NextStopPick {
  kind: NextStopKind
  /** upcoming 时的站点；no_stops / finished 为 null。 */
  stop: TripStop | null
  /** 站点在 day.stops 里的下标；无站点为 -1。 */
  index: number
  /** false = 站点时刻解析不了，UI 标「时间未知」。 */
  timeKnown: boolean
  /** upcoming 的位置语义；finished 固定 after_last。 */
  position: 'before_first' | 'between' | 'after_last' | null
}

/**
 * 下一站判定（保守顺序）：
 * 1. 第一站时刻解析不了 → 直接取第一站并标「时间未知」（时刻缺失时无法排序，
 *    按规格「时间缺失取第一站」处理，即便后面有带时刻的站）。
 * 2. 否则按 time 找第一个未过去的站（恰好等于当前时刻算未过去）。
 * 3. 带时刻的站都过去了、但还有缺时刻的站 → 取第一个缺时刻的站（它的时刻
 *    未知，不能断言行程已结束）。
 * 4. 全部带时刻且都过去 → 「今日行程已结束」。
 */
export function pickNextStop(day: TripDay | null, nowMs: number): NextStopPick {
  const stops = day?.stops ?? []
  if (stops.length === 0) {
    return { kind: 'no_stops', stop: null, index: -1, timeKnown: false, position: null }
  }
  if (parseStopTimeMinutes(stops[0].time) === null) {
    return { kind: 'upcoming', stop: stops[0], index: 0, timeKnown: false, position: 'before_first' }
  }
  const now = minutesOfDay(nowMs)
  for (let i = 0; i < stops.length; i++) {
    const min = parseStopTimeMinutes(stops[i].time)
    if (min !== null && min >= now) {
      return {
        kind: 'upcoming',
        stop: stops[i],
        index: i,
        timeKnown: true,
        position: i === 0 ? 'before_first' : 'between',
      }
    }
  }
  for (let i = 1; i < stops.length; i++) {
    if (parseStopTimeMinutes(stops[i].time) === null) {
      return { kind: 'upcoming', stop: stops[i], index: i, timeKnown: false, position: 'between' }
    }
  }
  return {
    kind: 'finished',
    stop: null,
    index: stops.length - 1,
    timeKnown: true,
    position: 'after_last',
  }
}

/* ───────── 出发时间建议 ───────── */

export type DepartureKind =
  | 'no_prev'
  | 'suggested'
  | 'no_leg'
  | 'no_duration'
  | 'unknown_time'
  | 'out_of_range'
  | 'invalid'

export interface DepartureSuggestion {
  kind: DepartureKind
  /** 建议出发时刻 HH:MM；仅 suggested 有值。 */
  timeText: string | null
  /** 路程说明（「步行约 16 分钟」）；仅 suggested 有值。 */
  legText: string | null
  /** true = straight_line 路段：耗时是示意估算，UI 必须标「示意」。 */
  approximate: boolean
}

const NO_DEPARTURE = (kind: DepartureKind, approximate = false): DepartureSuggestion => ({
  kind,
  timeText: null,
  legText: null,
  approximate,
})

/**
 * 出发时间建议：站时间 − 上一站到这站的路程耗时 − 出发缓冲。
 * 无上一站 / 无 leg / 耗时缺失 / 推算越过零点 → 对应的未知档，绝不编时刻。
 */
export function departureFor(day: TripDay, next: NextStopPick): DepartureSuggestion {
  if (next.kind !== 'upcoming' || next.stop === null || next.index < 0) {
    return NO_DEPARTURE('invalid')
  }
  const stop = next.stop
  const stopMin = parseStopTimeMinutes(stop.time)
  if (stopMin === null) return NO_DEPARTURE('unknown_time')
  if (next.index === 0) return NO_DEPARTURE('no_prev')
  const prev = day.stops[next.index - 1]
  if (!prev) return NO_DEPARTURE('no_leg')
  const leg = day.legs.find((l) => l.to_stop_id === stop.id && l.from_stop_id === prev.id)
  if (!leg) return NO_DEPARTURE('no_leg')
  const approximate = leg.route_type === 'straight_line'
  const duration = leg.duration_minutes
  if (duration === null || !Number.isFinite(duration) || duration < 0) {
    return NO_DEPARTURE('no_duration', approximate)
  }
  const departAt = stopMin - duration - DEPARTURE_BUFFER_MINUTES
  if (departAt < 0 || departAt >= 1440) {
    return NO_DEPARTURE('out_of_range', approximate)
  }
  return {
    kind: 'suggested',
    timeText: minutesToHhMm(departAt),
    legText: `${MODE_LABELS[leg.mode]}约 ${Math.round(duration)} 分钟`,
    approximate,
  }
}

/* ───────── 预约提醒 ───────── */

export interface TodayReminder {
  title: string
  from: 'checklist' | 'constraint'
}

/**
 * 收集「今天」的预约提醒：只读清单（appointment 项）与约束（fixed_window 项）里
 * 已有的记录；按天序号或（未指定天时）日期匹配到今天才收录，去重保序。
 * 没有任何记录 → 空数组，UI 显示「未记录」，绝不编造预约。
 */
export function collectTodayReminders(
  day: TripDay,
  checklist: readonly ChecklistItemV1[],
  constraints: readonly ConstraintItemV1[],
): TodayReminder[] {
  const out: TodayReminder[] = []
  const seen = new Set<string>()
  for (const item of checklist) {
    if (item.category !== 'appointment') continue
    const byDay = item.day === day.day
    const byDate = item.day === null && item.date !== null && item.date === day.date
    if (!byDay && !byDate) continue
    if (seen.has(item.title)) continue
    seen.add(item.title)
    out.push({ title: item.title, from: 'checklist' })
  }
  for (const c of constraints) {
    if (c.kind !== 'fixed_window') continue
    const byDay = c.day === day.day
    const byDate = c.day === null && c.startDate !== null && c.startDate === day.date
    if (!byDay && !byDate) continue
    if (seen.has(c.title)) continue
    seen.add(c.title)
    out.push({ title: c.title, from: 'constraint' })
  }
  return out
}

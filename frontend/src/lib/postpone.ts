/**
 * S8 · 时刻顺延：从某一站起整体后移 15 / 30 分钟的纯投影与草稿写入。
 *
 * 边界（与 itineraryHealth / stopSwap / tripDraft 同一纪律）：
 * - **纯函数**：投影只读 day，返回「前后对照」对象，不改原对象、不写存储、不发网络。
 * - **只改时刻**：顺延不增删站点、不重排、不重新取路线；站点身份与 legs 原样保留
 *   （与 tripDraft.updateDraftStop 的「只改 time」语义一致）。
 * - **跨天不动**：五期既有口径把「到达 + 停留结束超过 24:00」视为可能跨日。
 *   本模块不把 24:10 悄悄写成 00:10（那会被误读成当天更早），而是：
 *   从第一个会跨到次日的站起**保持原时刻**；若目标站自己就会跨日，整次顺延不可用，
 *   直接返回失败并写明原因。边界处若与保持原时刻的下一站发生时间倒序，列入 conflicts
 *   明示，不静默写入。
 * - **停留缺失不按 0 补**：缺失 / 非整数的停留时长不参与「结束时刻」与跨日判断，
 *   只按到达时刻判断；在 notes 里如实写明「无法判断是否跨日」。
 * - **写入是一次编辑**：确认后所有顺延站合并为草稿撤销栈里的**一项**，
 *   因此「撤销一次」就能整体回到顺延前；失败时草稿完全不变。
 */

import type { TripDay, TripStop } from './api'
import type { HealthPace } from './itineraryHealth'
import { PACE_LIMITS } from './itineraryHealth'
import type { DraftEditResult, DraftFailure, TripDraft } from './tripDraft'
import { MAX_UNDO_STEPS, updateDraftStop } from './tripDraft'

/** 一次可选的顺延分钟数：只提供体检条目里建议的 15 / 30。 */
export const POSTPONE_MINUTES = [15, 30] as const
export type PostponeMinutes = (typeof POSTPONE_MINUTES)[number]

/** 一天的分钟数；到达或结束超过它即视为跨到次日。 */
const DAY_MINUTES = 1440

/** 严格 HH:MM（24 小时制）；非法返回 null，不猜。 */
function parseHhMm(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** 分钟数 → HH:MM（当日 0–1439）。 */
function formatClock(total: number): string {
  const hour = Math.floor(total / 60)
  const minute = total % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 分钟数 → 展示文本；≥24:00 明确写「次日 HH:MM」，绝不折叠成当天时刻。 */
function formatClockMaybeNextDay(total: number): string {
  if (total >= DAY_MINUTES) return `次日 ${formatClock(total - DAY_MINUTES)}`
  return formatClock(total)
}

/**
 * 停留分钟数：只接受非负**整数**。非整数旧数据不猜结束时刻（与「不按 0 补」同源），
 * 返回 null 并在 notes 里说明。
 */
function stopDurationMinutes(stop: TripStop): number | null {
  if (typeof stop.duration_minutes !== 'number') return null
  if (!Number.isFinite(stop.duration_minutes)) return null
  if (!Number.isInteger(stop.duration_minutes)) return null
  if (stop.duration_minutes < 0) return null
  return stop.duration_minutes
}

/** 相邻两站之间的路段时间；缺 leg / 邻接不匹配 / unavailable / 非数字 → null。 */
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

/* ───────── 投影 ───────── */

/** 预览里的一站：顺延前 / 后时刻与是否真的被后移。 */
export interface PostponeStopPreview {
  /** 当天序号（1 起）。 */
  index: number
  id: string
  name: string
  /** 原到达时刻（HH:MM）。 */
  timeBefore: string
  /** 顺延后的到达时刻；未顺延的站与 timeBefore 相同。 */
  timeAfter: string
  /** 原结束时刻（到达 + 停留）；停留缺失 / 非整数 → null。 */
  endBefore: string | null
  /** 顺延后的结束时刻；未顺延的站与 endBefore 相同。 >=24:00 写「次日 HH:MM」。 */
  endAfter: string | null
  /** true = 这一站真的后移了 minutes 分钟。 */
  shifted: boolean
  /** 保持原时刻的原因；顺延的站为 null。 */
  heldReason: string | null
}

/** 一次顺延的级联投影。 */
export interface PostponeProjection {
  day: number
  /** 目标站 id：从这一站起（含）整体后移。 */
  targetStopId: string
  /** 目标站序号（1 起）。 */
  targetIndex: number
  minutes: PostponeMinutes
  /** 当天全部站点（含目标站之前未改动的站），按原顺序。 */
  stops: PostponeStopPreview[]
  /** 真正被后移的站数。 */
  shiftedCount: number
  /** 因避开跨日而保持原时刻的站数（都在顺延段末尾）。 */
  heldCount: number
  /** 明确冲突：边界处顺延后的结束时刻晚于保持原时刻的下一站等。 */
  conflicts: string[]
  /** 需要用户知道、但不阻止写入的说明。 */
  notes: string[]
}

export type PostponeFailureReason =
  | 'invalid_minutes'
  | 'unknown_stop'
  | 'unreadable_time'
  | 'midnight'

export interface PostponeFailure {
  ok: false
  reason: PostponeFailureReason
  message: string
}

export type PostponeProjectionResult =
  | { ok: true; projection: PostponeProjection }
  | PostponeFailure

/**
 * 生成「从 targetStopId 起整体后移 minutes 分钟」的级联预览。
 * 不改 day、不改 Trip 契约；同输入同输出。
 */
export function projectPostpone(
  day: TripDay,
  targetStopId: string,
  minutes: number,
): PostponeProjectionResult {
  if (minutes !== 15 && minutes !== 30) {
    return {
      ok: false,
      reason: 'invalid_minutes',
      message: '顺延分钟数只能是 15 或 30，未生成预览。',
    }
  }
  const targetIndex = day.stops.findIndex((stop) => stop.id === targetStopId)
  if (targetIndex < 0) {
    return {
      ok: false,
      reason: 'unknown_stop',
      message: '这一天的站点列表里没有指定站点，未生成预览。',
    }
  }
  if (day.stops.length === 0) {
    return {
      ok: false,
      reason: 'unknown_stop',
      message: '当天没有站点，无法顺延。',
    }
  }

  const arrivals: Array<number | null> = day.stops.map((stop) => parseHhMm(stop.time))
  for (let i = targetIndex; i < day.stops.length; i += 1) {
    if (arrivals[i] === null) {
      return {
        ok: false,
        reason: 'unreadable_time',
        message: `第 ${i + 1} 站「${day.stops[i].name}」的时间不是 HH:MM，无法预览顺延；缺失的时间不按 0 补。`,
      }
    }
  }

  const previews: PostponeStopPreview[] = []
  /** 内部同时保留分钟数，用于边界冲突比较（展示文本不参与计算）。 */
  const endAfterMinutes: Array<number | null> = []
  let held = false
  let firstHeldIndex: number | null = null

  for (let i = 0; i < day.stops.length; i += 1) {
    const stop = day.stops[i]
    const arrival = arrivals[i]
    const duration = stopDurationMinutes(stop)
    const endBefore = arrival === null || duration === null ? null : arrival + duration

    if (i < targetIndex) {
      previews.push({
        index: i + 1,
        id: stop.id,
        name: stop.name,
        timeBefore: stop.time,
        timeAfter: stop.time,
        endBefore: endBefore === null ? null : formatClockMaybeNextDay(endBefore),
        endAfter: endBefore === null ? null : formatClockMaybeNextDay(endBefore),
        shifted: false,
        heldReason: null,
      })
      endAfterMinutes.push(endBefore)
      continue
    }

    if (arrival === null) {
      // 前面已经校验过，这里只是让类型收窄；不会发生。
      return {
        ok: false,
        reason: 'unreadable_time',
        message: `第 ${i + 1} 站「${stop.name}」的时间不是 HH:MM，无法预览顺延。`,
      }
    }

    if (held) {
      previews.push({
        index: i + 1,
        id: stop.id,
        name: stop.name,
        timeBefore: stop.time,
        timeAfter: stop.time,
        endBefore: endBefore === null ? null : formatClockMaybeNextDay(endBefore),
        endAfter: endBefore === null ? null : formatClockMaybeNextDay(endBefore),
        shifted: false,
        heldReason: '前面的顺延段为避开跨日保持原时刻，这一站同样不后移。',
      })
      endAfterMinutes.push(endBefore)
      continue
    }

    const shiftedArrival = arrival + minutes
    const shiftedEnd = duration === null ? null : shiftedArrival + duration
    const arrivalCrosses = shiftedArrival >= DAY_MINUTES
    /** 原计划本就跨日（结束 >24:00）不算「这次顺延新增的跨日」。 */
    const newEndCrosses =
      shiftedEnd !== null &&
      shiftedEnd > DAY_MINUTES &&
      (endBefore === null || endBefore <= DAY_MINUTES)

    if (arrivalCrosses || newEndCrosses) {
      if (i === targetIndex) {
        const reason =
          arrivalCrosses
            ? `到达时刻会变成次日 ${formatClock(shiftedArrival - DAY_MINUTES)}`
            : `结束时刻会变成次日 ${formatClock((shiftedEnd ?? DAY_MINUTES) - DAY_MINUTES)}`
        return {
          ok: false,
          reason: 'midnight',
          message: `顺延 ${minutes} 分钟会让「${stop.name}」跨到次日（${stop.time} 起，${reason}）。本方案不可用；请改选更小的顺延或手动调整。`,
        }
      }
      held = true
      firstHeldIndex = i
      previews.push({
        index: i + 1,
        id: stop.id,
        name: stop.name,
        timeBefore: stop.time,
        timeAfter: stop.time,
        endBefore: endBefore === null ? null : formatClockMaybeNextDay(endBefore),
        endAfter: endBefore === null ? null : formatClockMaybeNextDay(endBefore),
        shifted: false,
        heldReason: `再顺延 ${minutes} 分钟会跨到次日，这一站起保持原时刻；不把 24:00 之后的时刻折叠成当天。`,
      })
      endAfterMinutes.push(endBefore)
      continue
    }

    previews.push({
      index: i + 1,
      id: stop.id,
      name: stop.name,
      timeBefore: stop.time,
      timeAfter: formatClockMaybeNextDay(shiftedArrival),
      endBefore: endBefore === null ? null : formatClockMaybeNextDay(endBefore),
      endAfter: shiftedEnd === null ? null : formatClockMaybeNextDay(shiftedEnd),
      shifted: true,
      heldReason: null,
    })
    endAfterMinutes.push(shiftedEnd)
  }

  const shiftedCount = previews.filter((stop) => stop.shifted).length
  const heldCount = previews.filter((stop) => stop.heldReason !== null).length
  const conflicts: string[] = []
  const notes: string[] = []

  if (firstHeldIndex !== null) {
    const lastShiftedIndex = firstHeldIndex - 1
    const lastShifted = previews[lastShiftedIndex]
    const heldStop = previews[firstHeldIndex]
    const heldArrival = parseHhMm(heldStop.timeBefore)
    const lastShiftedEnd = endAfterMinutes[lastShiftedIndex]
    if (heldArrival !== null && lastShifted !== undefined && lastShifted.shifted) {
      if (lastShiftedEnd === null) {
        if (parseHhMm(lastShifted.timeAfter) !== null && (parseHhMm(lastShifted.timeAfter) ?? 0) > heldArrival) {
          conflicts.push(
            `第 ${lastShifted.index} 站顺延后 ${lastShifted.timeAfter} 晚于第 ${heldStop.index} 站的 ${heldStop.timeBefore}（该站为避开跨日保持原时刻），需要手动调整后续站点。`,
          )
        } else {
          notes.push(
            `第 ${lastShifted.index} 站「${lastShifted.name}」停留时长缺失或不是整数，无法判断顺延后是否与第 ${heldStop.index} 站重叠。`,
          )
        }
      } else if (lastShiftedEnd > heldArrival) {
        conflicts.push(
          `第 ${lastShifted.index} 站顺延后结束于 ${formatClockMaybeNextDay(lastShiftedEnd)}，晚于第 ${heldStop.index} 站的 ${heldStop.timeBefore}（该站为避开跨日保持原时刻），需要手动调整后续站点。`,
        )
      }
    }
    notes.push(
      `第 ${(firstHeldIndex ?? 0) + 1} 站起共 ${heldCount} 站为避开跨日保持原时刻；顺延段与后半段之间可能需要手动衔接。`,
    )
  }

  for (const stop of previews) {
    if (!stop.shifted) continue
    const duration = stopDurationMinutes(day.stops[stop.index - 1])
    if (duration === null) {
      notes.push(
        `第 ${stop.index} 站「${stop.name}」停留时长缺失或不是整数，无法判断顺延后是否跨日或与下一站重叠。`,
      )
      continue
    }
    const end = endAfterMinutes[stop.index - 1]
    const endBeforeValue =
      parseHhMm(stop.timeBefore) === null ? null : (parseHhMm(stop.timeBefore) ?? 0) + duration
    if (end !== null && end > DAY_MINUTES && endBeforeValue !== null && endBeforeValue > DAY_MINUTES) {
      notes.push(
        `第 ${stop.index} 站「${stop.name}」原计划就结束于${formatClockMaybeNextDay(endBeforeValue)}，顺延后仍按可能跨日处理。`,
      )
    }
  }

  notes.push('顺延只改时刻：不减少站点、不缩短日跨度，也不会重新获取路线或自动保存。')

  return {
    ok: true,
    projection: {
      day: day.day,
      targetStopId,
      targetIndex: targetIndex + 1,
      minutes,
      stops: previews,
      shiftedCount,
      heldCount,
      conflicts,
      notes,
    },
  }
}

/* ───────── 体检建议目标 ───────── */

/** 体检建议的顺延起点：把不足的站间缓冲补出来的下一站。 */
export interface PostponeSuggestion {
  /** 建议从这一站起后移（0 起索引）。 */
  stopIndex: number
  stopId: string
  /** 不足缓冲所在路段（0 起）：第 i→i+1 段。 */
  legIndex: number
  /** 当前缓冲分钟数（可为负）。 */
  bufferMinutes: number
  message: string
}

/**
 * 用与五期体检同口径的阈值，找第一段缓冲不足的相邻路段；
 * 返回该路段**下一站**作为顺延起点（后移它及其后所有站，才能补出缓冲）。
 * 缺少时间 / 停留 / 路段时间的路段不猜，跳过；没有可判定的不足 → null。
 */
export function suggestPostponeTarget(day: TripDay, pace: HealthPace): PostponeSuggestion | null {
  const limits = PACE_LIMITS[pace]
  for (let i = 0; i + 1 < day.stops.length; i += 1) {
    const arrival = parseHhMm(day.stops[i].time)
    const duration = stopDurationMinutes(day.stops[i])
    const leg = legDurationMinutes(day, i)
    const nextArrival = parseHhMm(day.stops[i + 1].time)
    if (arrival === null || duration === null || leg === null || nextArrival === null) continue
    const buffer = nextArrival - (arrival + duration + leg)
    if (buffer < limits.minBufferMinutes) {
      const nextStop = day.stops[i + 1]
      return {
        stopIndex: i + 1,
        stopId: nextStop.id,
        legIndex: i,
        bufferMinutes: buffer,
        message: `第 ${i + 1}→${i + 2} 站当前缓冲约 ${buffer} 分钟，低于节奏下限 ${limits.minBufferMinutes} 分钟；建议从第 ${i + 2} 站「${nextStop.name}」起顺延。`,
      }
    }
  }
  return null
}

/* ───────── 写入草稿 ───────── */

function draftFailure(
  reason: DraftFailure['reason'],
  message: string,
): DraftFailure {
  return { ok: false, reason, message }
}

/**
 * 把已预览的顺延写进草稿。所有被顺延站的时刻修改合并成**一个**撤销步：
 * 历史里只记录顺延前的整份天数组，revision 只 +1，因此「撤销一次」恢复全部时刻。
 *
 * 防御性校验：预览后草稿又被改过（目标站之后的站点顺序或原时刻变了）→ 拒绝写入，
 * 草稿保持原样；绝不把预览结果套到已经变化的行程上。
 */
export function applyPostponeToDraft(
  draft: TripDraft,
  projection: PostponeProjection,
): DraftEditResult {
  const day = draft.days.find((item) => item.day === projection.day)
  if (!day) {
    return draftFailure('unknown_day', `草稿里没有第 ${projection.day} 天，顺延未生效。`)
  }
  const targetIndex = projection.targetIndex - 1
  const affected = projection.stops.slice(targetIndex)
  const current = day.stops.slice(targetIndex)
  if (
    affected.length !== current.length ||
    affected.some((stop, index) => stop.id !== current[index]?.id || stop.timeBefore !== current[index]?.time)
  ) {
    return draftFailure(
      'postcondition_failed',
      '草稿在上次预览后又有改动（站点顺序或原时刻已变化），这次顺延没有写入；请重新预览。',
    )
  }
  if (projection.shiftedCount === 0) {
    return { ok: true, draft, changed: false }
  }

  let working = draft
  let changed = false
  for (const stop of projection.stops) {
    if (!stop.shifted) continue
    const result = updateDraftStop(working, projection.day, stop.id, { time: stop.timeAfter })
    if (!result.ok) return result
    working = result.draft
    if (result.changed) changed = true
  }
  if (!changed) {
    return { ok: true, draft, changed: false }
  }

  // 合并撤销步：中间每一步的 history 项都丢掉，只留下「顺延前」这一项。
  const historyEntry = { days: draft.days, changedDays: draft.changedDays }
  const history = [...draft.history, historyEntry].slice(-MAX_UNDO_STEPS)
  return {
    ok: true,
    changed: true,
    draft: { ...working, history, revision: draft.revision + 1 },
  }
}

/**
 * 「每天最晚结束时间」偏好检查：纯函数、只读。
 *
 * 边界（与每日站点上限偏好同一路数，界面接线见 TripDraftEditor）：
 * - 不修改草稿或原行程的任何对象；不读 localStorage、不调用网络 / Date / crypto；
 * - 设置只属于当前草稿会话，不写入 Trip v1、不参与 applyDraft、不发给后端；
 * - 检查覆盖当天全部站点，不是只看末站：按每站填写的开始时刻与已知合法整数
 *   停留（0–1440 分钟）推出「结束不早于」的下界；站间交通耗时未知，一律不计入，
 *   也不按 0 补齐，文案如实写「未计入交通耗时，仍需人工确认」。
 * - 只有能由填写值直接确认的结论才写 over_limit；缺停留、旧时间无法解析、
 *   旧数据里小数或超长停留、时钟倒序这些情形给结构化 unconfirmed，
 *   unconfirmed 与明确的 over_limit 允许同天并存。
 * - 边界相等不算超限：结束下界恰好等于上限、或开始时刻恰好等于上限且停留为 0，
 *   都不报 over_limit。
 * - 结束下界达到或超过 1440（含恰好跨过午夜的次日 00:00）必然超过任何合法同日
 *   上限（上限最大 23:59 = 1439 分钟），统一按「次日 HH:MM」的跨日超限表述，
 *   不做模 24 后冒充当天时刻。
 * - 空日不虚构结束时刻，单独返回 empty_day；上限非法返回结构化错误而非抛错。
 * - 兼容旧宽字段与旧大站数：不校验站名长度、不限制站点数，原值原样只读。
 */

import { STOP_TIME_PATTERN, draftChangedDays, type TripDraft } from './tripDraft'

/** 上限允许的取值范围：0–1439 分钟（当天 00:00–23:59），与严格 HH:MM 解析一致，
 * 24:00 不是合法上限。站点停留 1440 分钟是可知合法时长，与上限口径是两回事。 */
export const MAX_DAILY_END_TIME_MINUTES = 1439

export type DailyEndTimeScope = 'all_days' | 'changed_days'

export type EndTimeFindingStatus = 'over_limit' | 'unconfirmed'

export type EndTimeFindingKind =
  | 'start_late'
  | 'end_over_limit'
  | 'cross_day_over_limit'
  | 'time_unreadable'
  | 'duration_unknown'
  | 'time_order'

export type EndTimeDayStatus =
  | 'empty_day'
  | 'over_limit'
  | 'unconfirmed'
  | 'no_evidence'

/** 单站的待确认 / 超限结论。no_evidence 的站不产生条目，避免把「没发现」刷成噪音。 */
export interface EndTimeStopFinding {
  stopId: string
  status: EndTimeFindingStatus
  kind: EndTimeFindingKind
  message: string
}

export interface EndTimeDayResult {
  day: number
  status: EndTimeDayStatus
  /** 超限与待确认条目；空日与全部 no_evidence 的天为空数组。 */
  findings: EndTimeStopFinding[]
  /** 天级一句话结论：空日 / 未发现超限的保守表述，或超限与待确认条数的汇总。 */
  summary: string
}

export type DailyEndTimeCheckResult =
  | { ok: true; limitMinutes: number; scope: DailyEndTimeScope; days: EndTimeDayResult[] }
  | { ok: false; reason: 'invalid_limit'; message: string }

/** 把 HH:MM 文本解析成上限分钟数；严格 24 小时制（复用 STOP_TIME_PATTERN，与站点
 * 时间同一口径，24:00 不接受），上限范围即 00:00–23:59（0–1439 分钟）。 */
export function parseDailyEndTimeLimit(
  text: string,
): { ok: true; minutes: number } | { ok: false; message: string } {
  if (!STOP_TIME_PATTERN.test(text)) {
    return {
      ok: false,
      message: '最晚结束时间需要是 24 小时制的 HH:MM（例如 22:00），当前设置未生效。',
    }
  }
  const minutes = Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5))
  return { ok: true, minutes }
}

/** 分钟数 → HH:MM 文本；只用于展示上限与推算出的结束下界。 */
export function formatEndTimeClock(minutes: number): string {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function isKnownDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1440
  )
}

function stopLabel(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return '未命名站点'
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed
}

function limitLabel(minutes: number): string {
  return formatEndTimeClock(minutes)
}

/**
 * 单站结论：
 * - 时间不可解析 → unconfirmed；
 * - 开始时刻晚于上限 → over_limit（与停留无关，因为结束不会早于开始）；
 * - 停留为已知合法整数 → 结束下界 = 开始 + 停留：
 *   - 下界 > 上限 → over_limit（下界达到或超过 1440 时按「次日 HH:MM」表述）；
 *   - 其余 → 不产生条目（含边界相等）；
 * - 停留缺失或非法（null、小数、负数、超 1440）→ unconfirmed。
 */
function findingForStop(
  dayNumber: number,
  stopId: string,
  stopName: string,
  time: string,
  duration: unknown,
  limit: number,
): EndTimeStopFinding | null {
  const dayLabel = `第 ${dayNumber} 天`
  const label = `「${stopLabel(stopName)}」`
  if (!STOP_TIME_PATTERN.test(time)) {
    return {
      stopId,
      status: 'unconfirmed',
      kind: 'time_unreadable',
      message:
        `${dayLabel}${label}的时间不是 24 小时制 HH:MM，无法按填写值推算结束时刻，` +
        '不能确认是否超过最晚结束时间。',
    }
  }
  const start = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
  if (start > limit) {
    return {
      stopId,
      status: 'over_limit',
      kind: 'start_late',
      message:
        `${dayLabel}${label}开始时刻 ${time} 已晚于你设置的最晚结束时间 ${limitLabel(limit)}；` +
        '按填写值该站不可能在上限前结束（计划值推算，未计入交通耗时）。',
    }
  }
  if (!isKnownDuration(duration)) {
    return {
      stopId,
      status: 'unconfirmed',
      kind: 'duration_unknown',
      message:
        `${dayLabel}${label}开始于 ${time}，停留时长缺失或不是 0–1440 的整数分钟，` +
        '无法推算结束时刻，不能确认是否超过最晚结束时间。',
    }
  }
  const endLowerBound = start + duration
  if (endLowerBound > limit) {
    if (endLowerBound >= 1440) {
      return {
        stopId,
        status: 'over_limit',
        kind: 'cross_day_over_limit',
        message:
          `${dayLabel}${label}按填写的开始 ${time} 与停留 ${duration} 分钟，` +
          `结束不早于次日 ${formatEndTimeClock(endLowerBound - 1440)}（跨午夜，按次日时刻计），` +
          `晚于上限 ${limitLabel(limit)}（计划值推算，未计入交通耗时）。`,
      }
    }
    return {
      stopId,
      status: 'over_limit',
      kind: 'end_over_limit',
      message:
        `${dayLabel}${label}按填写的开始 ${time} 与停留 ${duration} 分钟，` +
        `结束不早于 ${formatEndTimeClock(endLowerBound)}，晚于你设置的最晚结束时间 ${limitLabel(limit)}` +
        '（计划值推算，未计入站间交通耗时）。',
    }
  }
  // 结束下界 ≤ 上限（含恰好等于上限的边界）：没有超限证据。
  return null
}

/**
 * 按用户设置的最晚结束时间生成逐日提醒，只描述「按填写值能否确认」，
 * 不代表行程不可行、不代表已核实营业或预约，也不会自动改任何站点。
 * 上限无效时返回结构化错误；scope=changed_days 时只检查这次编辑真正改过的天
 * （复用 tripDraft.draftChangedDays 的口径）。
 */
export function dailyEndTimeLimitResult(
  draft: TripDraft,
  limit: number,
  scope: DailyEndTimeScope,
): DailyEndTimeCheckResult {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_DAILY_END_TIME_MINUTES) {
    return {
      ok: false,
      reason: 'invalid_limit',
      message:
        `最晚结束时间需要是 0–${MAX_DAILY_END_TIME_MINUTES} 的整数分钟（00:00–23:59），` +
        '当前设置无效，本次检查未执行。',
    }
  }
  if (scope !== 'all_days' && scope !== 'changed_days') {
    return {
      ok: false,
      reason: 'invalid_limit',
      message: '检查范围只能是 all_days 或 changed_days，当前设置无效，本次检查未执行。',
    }
  }
  const changedSet = new Set(draftChangedDays(draft))
  const targetDays =
    scope === 'changed_days'
      ? draft.days.filter((day) => changedSet.has(day.day))
      : draft.days
  const days: EndTimeDayResult[] = targetDays.map((day) => {
    if (day.stops.length === 0) {
      return {
        day: day.day,
        status: 'empty_day',
        findings: [],
        summary: `第 ${day.day} 天没有站点，不虚构结束时刻；最晚结束时间不适用于空日。`,
      }
    }
    const findings: EndTimeStopFinding[] = []
    let previousStart: number | null = null
    for (const stop of day.stops) {
      const finding = findingForStop(
        day.day,
        stop.id,
        stop.name,
        stop.time,
        stop.duration_minutes,
        limit,
      )
      if (finding) findings.push(finding)
      // 时钟倒序：同一天里后出现的站开始时刻早于前一站。逐站的结束下界仍然成立
      // （结束不会早于该站自己的开始加停留），但「当天几点结束」整体变得不可靠，
      // 单独给一条 unconfirmed，允许与逐站 over_limit 并存。
      if (STOP_TIME_PATTERN.test(stop.time)) {
        const start = Number(stop.time.slice(0, 2)) * 60 + Number(stop.time.slice(3, 5))
        if (previousStart !== null && start < previousStart) {
          findings.push({
            stopId: stop.id,
            status: 'unconfirmed',
            kind: 'time_order',
            message:
              `第 ${day.day} 天「${stopLabel(stop.name)}」的时间 ${stop.time} 早于前一站的填写时刻，` +
              '时钟顺序异常，当天的实际结束时刻推算不可靠，需要人工确认。',
          })
        }
        previousStart = start
      } else {
        previousStart = null
      }
    }
    if (findings.length === 0) {
      return {
        day: day.day,
        status: 'no_evidence',
        findings: [],
        summary:
          `第 ${day.day} 天按可知的填写值未发现超过最晚结束时间 ${limitLabel(limit)} 的站点；` +
          '结束下界未计入未知的站间交通耗时，仍需人工确认交通。',
      }
    }
    const overCount = findings.filter((item) => item.status === 'over_limit').length
    const unconfirmedCount = findings.length - overCount
    const parts: string[] = []
    if (overCount > 0) parts.push(`${overCount} 条按填写值可确认超过上限`)
    if (unconfirmedCount > 0) parts.push(`${unconfirmedCount} 条无法确认、需人工核对`)
    return {
      day: day.day,
      status: overCount > 0 ? 'over_limit' : 'unconfirmed',
      findings,
      summary:
        `第 ${day.day} 天有 ${parts.join('，')}（计划值推算，未计入交通耗时，` +
        '不代表行程不可行，也没有自动修改任何站点）。',
    }
  })
  return { ok: true, limitMinutes: limit, scope, days }
}

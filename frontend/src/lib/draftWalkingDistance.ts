/**
 * 「每天步行距离上限」偏好检查：纯函数、只读。
 *
 * 边界（与最晚结束时间偏好同一路数，界面接线见 TripDraftEditor）：
 * - 不修改草稿或原行程的任何对象；不读 localStorage、不调用网络 / Date / crypto；
 * - 设置只属于当前草稿会话，不写入 Trip v1、不参与 applyDraft、不发给后端；
 * - 只统计 mode='walking' 且 route_type='navigation'、distance_m 为有限非负数的
 *   已记录导航估算距离：显式 0 是合法记录，小数距离同样是合法记录——不因非整数
 *   把它判坏；金额分那种「必须整数」的限制不适用于距离，求和按原 finite 值相加，
 *   不在数据层 round / 截断 / 改写。
 * - walking 的 straight_line / unavailable、导航距离缺失（null）、负数、NaN /
 *   Infinity、以及未知 / 非法 mode 一律归为未纳入或未知：示意距离不混入导航合计，
 *   driving 不从驾车里程里猜末端步行，类型非法不猜 walking。未知 mode 与
 *   leg 结构不完整的段单独计为 unclassified：不冒充步行未知数，但会让当天
 *   保持覆盖不足，不出现「全已知未超」结论。
 * - 一天没有任何可纳入段时合计为 null（「暂无可统计导航步行距离」），绝不冒 0；
 *   有 0 距离合法记录时合计为 0，同时未知段仍独立计数可见。
 * - 求和不能安全表示（非有限结果或超出 Number.MAX_SAFE_INTEGER）时返回结构化
 *   unsafe 状态：绝不返回 0、不裁值、不冒「未超限」。
 * - 显示层用约数（「约」）标注估算值；比较（超过 / 未超）始终基于原始合计，
 *   不依赖显示舍入。
 * - 兼容旧宽字段与旧大站数：不校验站名长度、不限制站点数，原值原样只读。
 */

import { draftChangedDays, type TripDraft } from './tripDraft'

/** 上限允许的取值范围：0..100000 整数米。0 合法（可当作「不允许任何已记录步行」
 * 的口径去核对记录），100000 是界面允许的最大整数米。 */
export const MAX_DAILY_WALKING_DISTANCE_METERS = 100000

export type DailyWalkingDistanceScope = 'all_days' | 'changed_days'

/** 单日汇总状态：
 * - no_data：没有任何可纳入的导航步行段，也没有「部分已知」的比较依据；
 * - over_limit：已记录合计明确超过上限；
 * - under_limit_known_partial：已记录部分未超上限，但存在未知段，不能确认全量；
 * - under_limit_full_known：已记录部分未超上限，且当天没有未知步行段可提示；
 * - unsafe_sum：合计无法安全表示，不能给出任何比较结论；
 * - invalid_limit：上限本身运行时非法，未执行任何比较。 */
export type WalkingDayStatus =
  | 'no_data'
  | 'over_limit'
  | 'under_limit_known_partial'
  | 'under_limit_full_known'
  | 'unsafe_sum'
  | 'invalid_limit'

export interface WalkingDayResult {
  day: number
  status: WalkingDayStatus
  /** 已记录导航步行合计（米）；没有可纳入段时为 null，不冒 0。 */
  includedTotalMeters: number | null
  /** 已纳入的导航步行段数（含 0 距离段）。 */
  includedLegCount: number
  /** 当天未被纳入的 walking 段数（straight_line / unavailable / 距离缺失或非法）。 */
  unknownWalkingLegCount: number
  /** 当天 mode 无法识别、或 leg 结构本身不完整的段数：不猜 walking，
   * 不并入步行未知计数，但会明确说明并保持覆盖不足。 */
  unclassifiedLegCount: number
  /** 当天 driving 段数：不计入步行，也不从它推步行。 */
  drivingLegCount: number
  /** 天级一句话结论：保守表述，绝不声称全天步行合格。 */
  summary: string
}

export type DailyWalkingDistanceCheckResult =
  | {
      ok: true
      limitMeters: number
      scope: DailyWalkingDistanceScope
      days: WalkingDayResult[]
    }
  | { ok: false; reason: 'invalid_limit'; message: string }

/**
 * 把用户输入解析成上限整数米。
 * - 空白不是 0：返回 not_entered，界面保留「未填写」的明示；
 * - 负数、小数、非数字、超上限都以 typed 失败返回，不静默裁值；
 * - 非 null 的非字符串 runtime 输入（数字、布尔等）也按 typed invalid 处理，
 *   不因 .trim 之类抛未捕获异常；false / null / 0 数字不会被折算成 0 米；
 * - 不把金额分的整数限制套到距离：这里只约束「上限」本身必须是整数，
 *   路线记录里的小数距离仍是合法数据（见 per-day 汇总）。
 */
export function parseDailyWalkingDistanceLimit(
  text: string,
):
  | { ok: true; meters: number }
  | { ok: false; kind: 'not_entered' | 'invalid'; message: string } {
  if (typeof text !== 'string') {
    return {
      ok: false,
      kind: 'invalid',
      message:
        '步行距离上限需要以文本形式填写 0–100000 的整数米；当前输入类型无效，本次检查未执行。',
    }
  }
  const trimmed = text.trim()
  if (trimmed === '') {
    return {
      ok: false,
      kind: 'not_entered',
      message: '还没有填写步行距离上限：留空不等于 0，本次检查未执行。',
    }
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      kind: 'invalid',
      message: '步行距离上限需要是 0–100000 的整数米（例如 3000），当前输入未生效。',
    }
  }
  const meters = Number(trimmed)
  if (!Number.isSafeInteger(meters) || meters > MAX_DAILY_WALKING_DISTANCE_METERS) {
    return {
      ok: false,
      kind: 'invalid',
      message: `步行距离上限需要在 0–${MAX_DAILY_WALKING_DISTANCE_METERS} 整数米之间，当前输入未生效。`,
    }
  }
  return { ok: true, meters }
}

/** 米数 → 展示文本。能安全整数显示原值；小数或超出安全整数时用「约」标注估算。 */
export function formatWalkingMeters(meters: number): string {
  if (Number.isSafeInteger(meters)) return `${meters} 米`
  const rounded = Math.round(meters)
  if (Number.isSafeInteger(rounded)) return `约 ${rounded} 米`
  return `约 ${meters.toExponential(3)} 米`
}

function isKnownNavigationDistance(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  )
}

function sumKnownDistances(values: readonly number[]): number | null {
  // 逐项累加前先判断当前累计是否安全：任何一步不能安全表示就整体放弃，
  // 不返回部分和、不裁值、不返回 0。
  let total = 0
  for (const value of values) {
    const next = total + value
    if (!Number.isFinite(next) || Math.abs(next) > Number.MAX_SAFE_INTEGER) {
      return null
    }
    total = next
  }
  return total
}

function dayLabel(dayNumber: number): string {
  return `第 ${dayNumber} 天`
}

/**
 * 单天步行距离汇总。只读：输入天对象原样使用，不改任何字段。
 *
 * 上限必须是 0..100000 的整数：运行时收到非法上限（负数 / 小数 / NaN 等）时
 * 返回 typed invalid_limit，不产生任何比较结论，也不抛未捕获异常。
 */
export function summarizeDayWalkingDistance(
  day: {
    day: number
    legs: readonly {
      mode: string
      route_type: string
      distance_m: number | null
    }[]
  },
  limitMeters: number,
): WalkingDayResult {
  if (
    typeof limitMeters !== 'number' ||
    !Number.isInteger(limitMeters) ||
    limitMeters < 0 ||
    limitMeters > MAX_DAILY_WALKING_DISTANCE_METERS
  ) {
    return {
      day: typeof day?.day === 'number' ? day.day : 0,
      status: 'invalid_limit',
      includedTotalMeters: null,
      includedLegCount: 0,
      unknownWalkingLegCount: 0,
      unclassifiedLegCount: 0,
      drivingLegCount: 0,
      summary:
        '步行距离上限设置无效，本次检查未执行；没有产生任何「超过 / 未超过」的比较结论。',
    }
  }

  let includedCount = 0
  let unknownWalkingCount = 0
  let unclassifiedCount = 0
  let drivingCount = 0
  const includedDistances: number[] = []

  for (const leg of day.legs ?? []) {
    if (leg === null || typeof leg !== 'object') {
      // leg 结构本身不完整：按无充分数据处理，明确单独计数，不猜 walking。
      unclassifiedCount += 1
      continue
    }
    if (leg.mode === 'walking') {
      if (leg.route_type === 'navigation' && isKnownNavigationDistance(leg.distance_m)) {
        includedCount += 1
        includedDistances.push(leg.distance_m)
      } else {
        // walking 的直线示意 / 待重取 / 距离缺失或非法（负数、NaN、Infinity）：
        // 未纳入合计，独立计数为未知，不用 0 补齐。
        unknownWalkingCount += 1
      }
    } else if (leg.mode === 'driving') {
      // driving 不算步行：不从驾车里程猜末端步行，也不把驾车距离混进步行合计。
      drivingCount += 1
    } else {
      // 未知 mode 不猜 walking：单独计数并在结论里说明，保持覆盖不足，
      // 不能既不算步行又宣称「全已知」。
      unclassifiedCount += 1
    }
  }

  // 无法识别的段让覆盖确认失效：只要有未分类段，就不能宣称「全已知未超」。
  const hasIncluded = includedCount > 0
  const total = hasIncluded ? sumKnownDistances(includedDistances) : null

  if (total === null) {
    if (hasIncluded) {
      return {
        day: day.day,
        status: 'unsafe_sum',
        includedTotalMeters: null,
        includedLegCount: includedCount,
        unknownWalkingLegCount: unknownWalkingCount,
        unclassifiedLegCount: unclassifiedCount,
        drivingLegCount: drivingCount,
        summary:
          `${dayLabel(day.day)}的 ${includedCount} 段已记录导航步行距离相加后无法安全表示，` +
          '本次检查不能给出合计或比较结论；未裁剪任何数据，也未当作 0 或未超限。',
      }
    }
    return {
      day: day.day,
      status: 'no_data',
      includedTotalMeters: null,
      includedLegCount: 0,
      unknownWalkingLegCount: unknownWalkingCount,
      unclassifiedLegCount: unclassifiedCount,
      drivingLegCount: drivingCount,
      summary: noDataSummary(day.day, unknownWalkingCount, unclassifiedCount, drivingCount),
    }
  }

  const partial = unknownWalkingCount > 0 || unclassifiedCount > 0
  if (total > limitMeters) {
    return {
      day: day.day,
      status: 'over_limit',
      includedTotalMeters: total,
      includedLegCount: includedCount,
      unknownWalkingLegCount: unknownWalkingCount,
      unclassifiedLegCount: unclassifiedCount,
      drivingLegCount: drivingCount,
      summary:
        `${dayLabel(day.day)}已记录导航步行距离合计 ${formatWalkingMeters(total)}` +
        `（${includedCount} 段），超过你设置的每天 ${limitMeters} 米上限；` +
        (partial
          ? '另有路段步行距离未知，实际步行量可能更多。'
          : '这是已有估算记录的合计，不代表实际全天步行量。') +
        '没有自动修改任何站点，由你自行决定如何调整。',
    }
  }

  return {
    day: day.day,
    status: partial ? 'under_limit_known_partial' : 'under_limit_full_known',
    includedTotalMeters: total,
    includedLegCount: includedCount,
    unknownWalkingLegCount: unknownWalkingCount,
    unclassifiedLegCount: unclassifiedCount,
    drivingLegCount: drivingCount,
    summary: underLimitSummary(
      day.day,
      total,
      includedCount,
      limitMeters,
      partial,
      unknownWalkingCount,
      unclassifiedCount,
      drivingCount,
    ),
  }
}

function noDataSummary(
  dayNumber: number,
  unknownCount: number,
  unclassifiedCount: number,
  drivingCount: number,
): string {
  const parts: string[] = []
  if (unknownCount > 0) parts.push(`${unknownCount} 段步行路线距离未知或为示意`)
  if (unclassifiedCount > 0) parts.push(`${unclassifiedCount} 段路线出行方式无法识别`)
  if (drivingCount > 0) parts.push(`${drivingCount} 段驾车路线不计入步行`)
  const detail = parts.length > 0 ? `（${parts.join('；')}）` : ''
  return (
    `${dayLabel(dayNumber)}暂无可统计的导航步行距离${detail}；` +
    '合计按未知处理，不能当作全天步行 0 米，也不能据此认为符合或超出上限。'
  )
}

function underLimitSummary(
  dayNumber: number,
  total: number,
  includedCount: number,
  limitMeters: number,
  partial: boolean,
  unknownCount: number,
  unclassifiedCount: number,
  drivingCount: number,
): string {
  const drivingText = drivingCount > 0 ? `；另有 ${drivingCount} 段驾车路线不计入步行` : ''
  if (partial) {
    const unknownParts: string[] = []
    if (unknownCount > 0) unknownParts.push(`${unknownCount} 段步行路线距离未知或为示意`)
    if (unclassifiedCount > 0) unknownParts.push(`${unclassifiedCount} 段路线出行方式无法识别`)
    return (
      `${dayLabel(dayNumber)}已记录导航步行距离合计 ${formatWalkingMeters(total)}` +
      `（${includedCount} 段），未超过你设置的每天 ${limitMeters} 米上限；` +
      `但另有 ${unknownParts.join('、')}${drivingText}，` +
      '不能确认全天步行量是否在上限内，也不代表实际步行合格。'
    )
  }
  return (
    `${dayLabel(dayNumber)}已记录导航步行距离合计 ${formatWalkingMeters(total)}` +
    `（${includedCount} 段），未超过你设置的每天 ${limitMeters} 米上限${drivingText}；` +
    '这只是已有导航估算记录的结论，不代表实际全天步行量，也未重新核实路线。'
  )
}

/**
 * 按用户设置的每天步行距离上限生成逐日汇总。
 * scope=changed_days 只检查这次编辑真正改过的天（复用 tripDraft.draftChangedDays 口径）；
 * 上限非法返回结构化错误。只读：不改草稿、不写 Trip、不发请求。
 */
export function dailyWalkingDistanceResult(
  draft: TripDraft,
  limitMeters: number,
  scope: DailyWalkingDistanceScope,
): DailyWalkingDistanceCheckResult {
  if (
    typeof limitMeters !== 'number' ||
    !Number.isInteger(limitMeters) ||
    limitMeters < 0 ||
    limitMeters > MAX_DAILY_WALKING_DISTANCE_METERS
  ) {
    return {
      ok: false,
      reason: 'invalid_limit',
      message:
        `步行距离上限需要是 0–${MAX_DAILY_WALKING_DISTANCE_METERS} 的整数米，` +
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
  return {
    ok: true,
    limitMeters,
    scope,
    days: targetDays.map((day) => summarizeDayWalkingDistance(day, limitMeters)),
  }
}

/** 固定可见口径：只统计已有导航估算、不代表实际全天步行量。 */
export const WALKING_DISTANCE_DISCLAIMER =
  '仅统计标记为导航步行的有效距离记录；未包含示意/未知、景点内/站内/路线未记录的步行，' +
  '不代表实际全天步行量；数据为已有估算，未重新核实。'

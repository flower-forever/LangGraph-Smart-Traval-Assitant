/**
 * 目的地 IANA 时区 → UTC 的纯转换模块（无 IO、无本地时区依赖、无第三方依赖）。
 *
 * 设计约束（配合 calendar.ts 的导出语义，本模块不反向导入 calendar，避免运行时循环导入）：
 * - 只用 Intl.DateTimeFormat 的显式 timeZone 取某时区的当地墙上时间，绝不经过机器本地
 *   Date 的 getter/解析路径；locale 固定 en-US，calendar/numberingSystem/hourCycle 显式
 *   指定（gregory / latn / h23），保证 formatToParts 的字段与数值跨环境稳定。
 * - 不把时区当固定偏移，不假设夏令时切换恰好一小时（Lord Howe 是半小时、查塔姆标准
 *   偏移本身是 +12:45、太平洋诸岛存在跨日变更）：通过在目标时刻前后 ±1 天采样偏移，
 *   把候选 UTC 限制在 [naive - maxOffset, naive - minOffset] 内，并对每个候选做严格的
 *   当地墙上时间往返校验。
 * - 只有「唯一解」才允许导出：DST 结束的重复时刻返回 ambiguous（列出全部候选 UTC），
 *   DST 开始的不存在时刻返回 nonexistent；调用方（calendar.ts）据此跳过并给出可见原因，
 *   不自行挑选第一次/第二次解，也不挪动时间。
 * - 偏移枚举用「二分找切换边界」完成，粒度假设：tzdb 偏移为整秒、相邻切换间隔远大于 1ms。
 *   真实时区在 48 小时窗口内至多两三次切换，该假设成立；极端构造数据会落到 nonexistent，
 *   属于保守拒绝而不是错误输出。
 */

export interface ZonedLocalParts {
  /** formatToParts 的 era 值（en-US short：'AD' / 'BC'） */
  era: string
  /** 当地墙上时间的年月日时分秒（公历，24 小时制 0..23） */
  y: number
  m: number
  d: number
  h: number
  mi: number
  s: number
}

export type ZonedUtcResolution =
  | { kind: 'unique'; epochMs: number }
  | { kind: 'ambiguous'; epochMsList: number[] }
  | { kind: 'nonexistent' }
  | { kind: 'invalid_input' }

const formatterCache = new Map<string, Intl.DateTimeFormat | null>()

/** 缓存上限防御：时区名来自用户输入，超出直接清空重来，避免无限增长 */
const FORMATTER_CACHE_LIMIT = 128

function getFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone)
  if (cached !== undefined) return cached
  if (formatterCache.size > FORMATTER_CACHE_LIMIT) formatterCache.clear()
  let formatter: Intl.DateTimeFormat | null = null
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      calendar: 'gregory',
      numberingSystem: 'latn',
    })
  } catch {
    formatter = null
  }
  formatterCache.set(timeZone, formatter)
  return formatter
}

/**
 * 判断一个字符串是否是当前运行环境（ICU/tzdata）支持的 IANA 时区名。
 * 接受首尾空白；空串与非字符串一律 false。这是唯一权威判断，调用方不得自行猜测。
 * IANA 名称匹配与 ICU 一致（大小写不敏感，如 Asia/Shanghai 与 asia/shanghai 等价）。
 */
export function isSupportedIanaTimeZone(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false
  const trimmed = candidate.trim()
  if (!trimmed || trimmed.length > 128) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed, hourCycle: 'h23' })
    return true
  } catch {
    return false
  }
}

/**
 * 把一个 UTC 时刻格式化成 timeZone 的当地墙上时间字段。
 * 失败（时区不受支持、时刻非法、BC 纪元等）返回 null。
 */
export function formatZonedLocalParts(timeZone: string, epochMs: number): ZonedLocalParts | null {
  const formatter = getFormatter(timeZone)
  // Date 的合法范围是 ±8.64e15 ms（TimeClip）；超出的有限数值虽然 Number.isFinite，
  // 但 formatToParts 会抛 RangeError，这里必须挡住并按失败返回 null。
  if (formatter === null || !Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_VALID_EPOCH_MS) {
    return null
  }
  let parts: Partial<ZonedLocalParts>
  try {
    parts = {}
    for (const part of formatter.formatToParts(new Date(epochMs))) {
      switch (part.type) {
        case 'era':
          parts.era = part.value
          break
        case 'year':
          parts.y = Number(part.value)
          break
        case 'month':
          parts.m = Number(part.value)
          break
        case 'day':
          parts.d = Number(part.value)
          break
        case 'hour':
          parts.h = Number(part.value)
          break
        case 'minute':
          parts.mi = Number(part.value)
          break
        case 'second':
          parts.s = Number(part.value)
          break
        default:
          break
      }
    }
  } catch {
    return null
  }
  const fields = [parts.y, parts.m, parts.d, parts.h, parts.mi, parts.s]
  if (parts.era === undefined || fields.some((value) => typeof value !== 'number' || Number.isNaN(value))) {
    return null
  }
  return parts as ZonedLocalParts
}

const DAY_MS = 86_400_000
/** Date 构造函数可表示的毫秒上限（ECMA-262 TimeClip 边界 ±8.64e15） */
const MAX_VALID_EPOCH_MS = 8.64e15
/** 单个 48 小时窗口内偏移枚举的防御上限；真实时区到不了（最多 2~3 段） */
const MAX_DISTINCT_OFFSETS = 8

function offsetAt(timeZone: string, t: number): number {
  const parts = formatZonedLocalParts(timeZone, t)
  if (parts === null || parts.era === 'BC') return Number.NaN
  // Intl 输出只到秒；t 的亚秒部分不参与 formatToParts，偏移必须对齐到秒，
  // 否则二分采样到非秒对齐毫秒时会得到带亚秒残差的假偏移，污染偏移枚举。
  return Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.mi, parts.s) - Math.floor(t / 1000) * 1000
}

/**
 * 在 [from, to] 内枚举所有不同的 UTC 偏移：offsetFrom/offsetTo 是两端实测偏移，
 * 中点偏移与两端都不同则递归两侧，直到区间宽度 ≤1ms。真实时区切换极少，递归很浅。
 */
function collectSegmentOffsets(
  timeZone: string,
  from: number,
  to: number,
  offsetFrom: number,
  offsetTo: number,
  offsets: Set<number>,
): void {
  if (offsets.size > MAX_DISTINCT_OFFSETS) return
  if (to - from <= 1) {
    offsets.add(offsetFrom)
    offsets.add(offsetTo)
    return
  }
  const mid = Math.floor((from + to) / 2)
  const offsetMid = offsetAt(timeZone, mid)
  if (!Number.isFinite(offsetMid)) return
  if (offsetMid === offsetFrom) {
    collectSegmentOffsets(timeZone, mid, to, offsetMid, offsetTo, offsets)
  } else if (offsetMid === offsetTo) {
    collectSegmentOffsets(timeZone, from, mid, offsetFrom, offsetMid, offsets)
  } else {
    collectSegmentOffsets(timeZone, from, mid, offsetFrom, offsetMid, offsets)
    collectSegmentOffsets(timeZone, mid, to, offsetMid, offsetTo, offsets)
  }
}

/**
 * 把「某 IANA 时区的当地墙上时间」解析为唯一的 UTC 时刻（毫秒）。
 * 输入是已经过 calendar.ts 严格校验的当地日期/时刻分量；模块内仍做防御校验。
 *
 * 返回：
 * - unique：唯一 UTC 时刻，已通过「用该 UTC 反查当地墙上时间 == 输入」的严格往返校验；
 * - ambiguous：DST 重复时刻，epochMsList 是全部候选 UTC（升序、去重），调用方必须跳过；
 * - nonexistent：DST 空档里的不存在时刻，调用方必须跳过；
 * - invalid_input：分量越界或时区不受支持（正常调用链不会出现）。
 */
export function resolveZonedLocalToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): ZonedUtcResolution {
  const fields = [year, month, day, hour, minute, second]
  if (typeof timeZone !== 'string' || !fields.every(Number.isSafeInteger)) {
    return { kind: 'invalid_input' }
  }
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return { kind: 'invalid_input' }
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return { kind: 'invalid_input' }
  }
  const formatter = getFormatter(timeZone)
  if (formatter === null) return { kind: 'invalid_input' }

  const matchesLocal = (t: number): boolean => {
    const parts = formatZonedLocalParts(timeZone, t)
    return (
      parts !== null &&
      parts.era !== 'BC' &&
      parts.y === year &&
      parts.m === month &&
      parts.d === day &&
      parts.h === hour &&
      parts.mi === minute &&
      parts.s === second
    )
  }

  const naive = Date.UTC(year, month - 1, day, hour, minute, second)
  const offBefore = offsetAt(timeZone, naive - DAY_MS)
  const offAfter = offsetAt(timeZone, naive + DAY_MS)
  if (!Number.isFinite(offBefore) || !Number.isFinite(offAfter)) return { kind: 'nonexistent' }

  // 快路径：±1 天偏移相同，说明目标附近大概率无切换；候选解再用 ±1s 探针确认
  // 侧翼偏移也没变，才允许直接判唯一。任何疑点都落到下面的完整枚举路径。
  if (offBefore === offAfter) {
    const candidate = naive - offBefore
    if (matchesLocal(candidate)) {
      const offSide1 = offsetAt(timeZone, candidate - 1000)
      const offSide2 = offsetAt(timeZone, candidate + 1000)
      if (offSide1 === offBefore && offSide2 === offBefore) {
        return { kind: 'unique', epochMs: candidate }
      }
    }
  }

  const offsets = new Set<number>([offBefore, offAfter])
  collectSegmentOffsets(timeZone, naive - DAY_MS, naive + DAY_MS, offBefore, offAfter, offsets)
  if (offsets.size > MAX_DISTINCT_OFFSETS) return { kind: 'nonexistent' }

  const matches: number[] = []
  for (const offset of offsets) {
    const candidate = naive - offset
    if (matchesLocal(candidate) && !matches.includes(candidate)) matches.push(candidate)
  }
  if (matches.length === 0) return { kind: 'nonexistent' }
  if (matches.length === 1) return { kind: 'unique', epochMs: matches[0] }
  return { kind: 'ambiguous', epochMsList: matches.sort((a, b) => a - b) }
}

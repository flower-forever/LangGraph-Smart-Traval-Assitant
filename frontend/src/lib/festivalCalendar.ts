/**
 * 六期 S3 · 内置 2026–2027 公历节日表与相交判定（纯逻辑，零副作用）。
 *
 * 单独成文件的原因（S1 闸门纪律：主包不回涨）：App 层落印只需要「日期区间相交 →
 * 问候语」这一个函数；成都水印与 credits 箴言都在 lazy chunk（RouteReplayPanel /
 * ShareCardPanel / offlineRoadbook）里。把节日表放在这里，主包只带上 ~1 KB 的表，
 * 不连带水印 SVG 与箴言清单。
 *
 * 边界：
 * - 不碰 DOM / 存储 / 网络 / 时钟；同一输入两次输出相同（确定性）。
 * - 节日表写死 2026–2027 公历放假区间（以国务院办公厅当年放假安排通知为口径），
 *   「2027 年后需增补」；2028 起的行程过表返回 null（无彩蛋、不报错）。
 * - 非法日期（格式不对 / 月日越界 / 2026-02-31 型溢出）按无日期处理，不抛错。
 */

export interface FestivalGreeting {
  /** 节日名（如「端午」）。 */
  name: string
  /** 问候语（如「端午安康」）；直接显示在落印章下的小字。 */
  greeting: string
}

interface FestivalEntry {
  /** 放假首日（含），数字编码 YYYYMMDD。 */
  start: number
  /** 放假末日（含），数字编码 YYYYMMDD。 */
  end: number
  greeting: FestivalGreeting
}

/**
 * 内置 2026–2027 公历节日放假区间（闭区间 [start, end]，数字编码 YYYYMMDD）。
 * 日期写死，口径为国务院办公厅当年放假安排通知：
 * - 2026：元旦 1.1–1.3；春节 2.15–2.23；清明 4.4–4.6；劳动节 5.1–5.5；
 *   端午 6.19–6.21；中秋 9.25–9.27；国庆 10.1–10.7。
 * - 2027：元旦 1.1–1.3；春节 2.5–2.13；清明 4.3–4.5；劳动节 5.1–5.5；
 *   端午 6.9（单日）；中秋 9.15（单日）；国庆 10.1–10.7。
 *
 * TODO(七期)：2027 年后需增补——2028 起的行程不在表内，返回 null（无彩蛋不报错）。
 */
const FESTIVAL_TABLE: readonly FestivalEntry[] = [
  { start: 20260101, end: 20260103, greeting: { name: '元旦', greeting: '元旦快乐' } },
  { start: 20260215, end: 20260223, greeting: { name: '春节', greeting: '新春快乐' } },
  { start: 20260404, end: 20260406, greeting: { name: '清明', greeting: '踏青时节·出行平安' } },
  { start: 20260501, end: 20260505, greeting: { name: '五一', greeting: '劳动节快乐' } },
  { start: 20260619, end: 20260621, greeting: { name: '端午', greeting: '端午安康' } },
  { start: 20260925, end: 20260927, greeting: { name: '中秋', greeting: '中秋团圆' } },
  { start: 20261001, end: 20261007, greeting: { name: '国庆', greeting: '国庆愉快' } },
  { start: 20270101, end: 20270103, greeting: { name: '元旦', greeting: '元旦快乐' } },
  { start: 20270205, end: 20270213, greeting: { name: '春节', greeting: '新春快乐' } },
  { start: 20270403, end: 20270405, greeting: { name: '清明', greeting: '踏青时节·出行平安' } },
  { start: 20270501, end: 20270505, greeting: { name: '五一', greeting: '劳动节快乐' } },
  { start: 20270609, end: 20270609, greeting: { name: '端午', greeting: '端午安康' } },
  { start: 20270915, end: 20270915, greeting: { name: '中秋', greeting: '中秋团圆' } },
  { start: 20271001, end: 20271007, greeting: { name: '国庆', greeting: '国庆愉快' } },
]

/**
 * YYYY-MM-DD → 数字编码 YYYYMMDD（如 2026-06-19 → 20260619）。
 * 非法格式 / 月日越界 / 2026-02-31 型溢出返回 null（不抛错）。
 * 数字编码可直接整数比较，无需 Date 解析。
 */
function encodeDay(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const encoded = year * 10000 + month * 100 + day
  // 用 UTC Date round-trip 校验真实存在的日历日（2026-02-31 型溢出返回 null）
  const roundTrip = new Date(Date.UTC(year, month - 1, day))
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null
  }
  return encoded
}

/**
 * 行程日期区间与节日表相交判定：取行程全部 day.date 的最小 / 最大值围成闭区间，
 * 与任一节日区间相交即命中（行程中段扫过节日也算——出行撞上节日同样值得问候）。
 * 同一行程命中多个节日时取行程区间内「最早开始」的一个，输出确定。
 * 无合法日期 / 过表（2028 起）返回 null。
 */
export function festivalGreetingFor(trip: { days: ReadonlyArray<{ date: string | null }> }): FestivalGreeting | null {
  const dates: Array<number> = []
  for (const day of trip.days) {
    const encoded = encodeDay(day.date ?? '')
    if (encoded !== null) dates.push(encoded)
  }
  if (dates.length === 0) return null
  const tripStart = Math.min(...dates)
  const tripEnd = Math.max(...dates)

  let best: FestivalEntry | null = null
  let bestStart = Number.POSITIVE_INFINITY
  for (const entry of FESTIVAL_TABLE) {
    // 数字编码直接整数比较（闭区间相交：tripStart <= entry.end && tripEnd >= entry.start）
    if (tripStart <= entry.end && tripEnd >= entry.start && entry.start < bestStart) {
      best = entry
      bestStart = entry.start
    }
  }
  return best === null ? null : { ...best.greeting }
}

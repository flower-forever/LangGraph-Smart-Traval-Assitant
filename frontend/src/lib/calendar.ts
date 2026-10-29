/**
 * 行程 → .ics 导出纯函数，数据契约见 ./api.ts 的 Trip/TripDay/TripStop。
 * UI 后续只需要：取 result.ics 存成 .ics 文件下载；skipped/notices 用于提示。
 *
 * 设计约束：
 * - 只为「所在日有合法日期 + 站点时刻合法」的站点生成 VEVENT；其余站点跳过并记录原因。
 * - 起止时间不带时区（floating local time）：导入端按导入设备的本地时区解释。
 * - duration_minutes 只在是 1..MAX_STAY_MINUTES 的整数时才写 DTEND；缺失、≤0、非整数、
 *   超上限都不写 DTEND/DURATION，不按任何默认时长补算，并在 missingDurationCount/notices
 *   里说明。有效时长用 UTC 日历日滚动（Date.UTC 溢出自动进位）计算结束时间，跨午夜、
 *   跨月、跨年都成立。
 * - 缺结束时间的 VEVENT 只有 DTSTART，属于 RFC 5545 允许的「时刻事件」；导入端可能按自身
 *   默认时长显示结束时间，但这不是导出数据的一部分。
 * - 文本按 RFC 5545 §3.3.11 转义（反斜杠、分号、逗号、换行）；其余控制字符、DEL、C1 控制符
 *   与孤立代理对直接剥离，防止控制字符注入。
 * - 逻辑行超 75 个 UTF-8 八位字节时按完整码点边界折行（续行以一个空格开头，空格计入该物理行），
 *   不会在中文/4 字节字符中间切开。
 * - UID 由 (tripId, 日期, 开始时刻, stopId) 做双轮 FNV-1a 哈希，不掺入时长/结束时间：
 *   同一事件重复导出 UID 不变，时长从缺失变为已知也不变，哈希结果不含站名、目的地等可读文本。
 *   同一 (日期, 开始时刻, stopId) 重复出现时按确定性序号再哈希，保证 UID 唯一。
 * - 不虚构时间或预约状态：不写 STATUS/ORGANIZER/URL；示例行程（source === 'example'）
 *   在事件标题加【示例】前缀，并在描述里注明「示例行程数据」。
 */

import type { Trip, TripStop, TripDay } from './api'

/** 单场事件停留时长上限（分钟）；超过视为数据错误，不写结束时间 */
export const MAX_STAY_MINUTES = 1440

export type IcsSkipReason =
  | 'day_date_missing'
  | 'day_date_invalid'
  | 'stop_time_invalid'
  | 'stop_name_missing'

export interface IcsSkip {
  day: number
  stopId: string
  stopName: string
  reason: IcsSkipReason
  message: string
}

export interface IcsExportOptions {
  /** 生成 DTSTAMP 用的固定时间（测试用）；缺省为当前时间 */
  now?: Date
  /**
   * 用户明确选择的首日（YYYY-MM-DD）。只有整份行程的所有 day.date 都为空时才生效：
   * 按 (day.day - 1) 天临时推算日期，仅用于本次导出，不写回、不修改原行程。
   * 只要存在任意真实日期，该选项一律被忽略，缺失的日期只跳过并提示，绝不覆盖或伪造。
   */
  firstDate?: string
}

/** 按首日与天序号推算出的一条临时日期（仅用于本次导出） */
export interface IcsProvisionalDate {
  day: number
  /** ISO 日期 YYYY-MM-DD */
  date: string
}

export interface IcsExportResult {
  /** 转义与折行后的完整 .ics 文本；行与行之间、结尾处都是 CRLF */
  ics: string
  eventCount: number
  skippedCount: number
  skipped: IcsSkip[]
  /** 停留时长缺失/无效、因而没有写 DTEND/DURATION 的站点数 */
  missingDurationCount: number
  /** 需要连同导出结果一起向用户说明的语义（时区、示例标识、缺失结束时间、坐标取舍、临时日期） */
  notices: string[]
  /** 是否使用了 firstDate 推算临时日期 */
  firstDateUsed: boolean
  /** 推算出的临时日期，按天序号升序；firstDateUsed 为 false 时为空数组 */
  provisionalDates: IcsProvisionalDate[]
}

/** 行程的日期覆盖情况，用于决定导出前是否需要让用户明确选择首日 */
export interface TripDateCoverage {
  /** 有效天数（忽略数组里的 null） */
  totalDays: number
  /** 有真实合法日期的天数 */
  datedDays: number
  /** 无日期的天序号，按原顺序 */
  undatedDays: number[]
  /**
   * 所有 day.date 都为空（没有真实日期，也没有写错的日期文本）。
   * 这是唯一允许按首日推算临时日期的情形。
   */
  allDatesMissing: boolean
  /** 是否存在非空但无法解析的日期文本 */
  hasInvalidDateText: boolean
  /** 是否需要用户先明确选首日（缺全部日期，且至少一天有站点） */
  needsFirstDate: boolean
}

interface IcsDatePoint {
  y: number
  m: number
  d: number
}

interface IcsTimePoint {
  h: number
  m: number
  s: number
}

/** 真 · 日历表校验：用 Date.UTC 往返一次，挡住 2026-02-30 这类假日期 */
function isRealCalendarDate(y: number, m: number, d: number): boolean {
  const roundtrip = new Date(Date.UTC(y, m - 1, d))
  return (
    roundtrip.getUTCFullYear() === y &&
    roundtrip.getUTCMonth() === m - 1 &&
    roundtrip.getUTCDate() === d
  )
}

/**
 * 日历日滚动：base 加 offset 天，用 Date.UTC 的溢出进位处理跨月、跨年与闰年，
 * 不经过本地时区和 DST。年份溢出 4 位范围时返回 null。
 */
function addCalendarDays(base: IcsDatePoint, offset: number): IcsDatePoint | null {
  if (!Number.isSafeInteger(offset)) return null
  const rolled = new Date(Date.UTC(base.y, base.m - 1, base.d + offset))
  if (Number.isNaN(rolled.getTime())) return null
  const y = rolled.getUTCFullYear()
  if (y < 1000 || y > 9999) return null
  return { y, m: rolled.getUTCMonth() + 1, d: rolled.getUTCDate() }
}

function toIsoDate(point: IcsDatePoint): string {
  return `${String(point.y).padStart(4, '0')}-${pad2(point.m)}-${pad2(point.d)}`
}

/**
 * 解析行程日历用的日期。只收 YYYY-MM-DD 精确格式（允许首尾空白），
 * 年份限定 1000..9999，并做真日历校验（闰年由 Date.UTC 处理）。
 */
export function parseIcsDate(raw: string): IcsDatePoint | null {
  if (typeof raw !== 'string') return null
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!matched) return null
  const y = Number(matched[1])
  const m = Number(matched[2])
  const d = Number(matched[3])
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) return null
  if (!isRealCalendarDate(y, m, d)) return null
  return { y, m, d }
}

/**
 * 解析站点时刻。收 HH:MM 或 HH:MM:SS（小时允许 1~2 位），秒数只做合法性校验并保留进输出；
 * 时/分/秒越界或格式不符返回 null。
 */
export function parseIcsTime(raw: string): IcsTimePoint | null {
  if (typeof raw !== 'string') return null
  const matched = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim())
  if (!matched) return null
  const h = Number(matched[1])
  const m = Number(matched[2])
  const s = matched[3] ? Number(matched[3]) : 0
  if (h > 23 || m > 59 || s > 59) return null
  return { h, m, s }
}

/**
 * 汇总行程的日期覆盖情况。UI 用它判断是否需要先让用户选首日：
 * 只有「所有天都为空」才允许临时推算，部分缺失一律只跳过。
 */
export function tripDateCoverage(trip: Trip): TripDateCoverage {
  const rawDays = Array.isArray((trip as Trip | undefined)?.days) ? trip.days : []
  const days = rawDays.filter((day): day is TripDay => Boolean(day))
  const undatedDays: number[] = []
  let datedDays = 0
  let blankDays = 0
  let hasInvalidDateText = false
  for (const day of days) {
    if (parseIcsDate(day.date ?? '') !== null) {
      datedDays += 1
      continue
    }
    undatedDays.push(day.day)
    const raw = typeof day.date === 'string' ? day.date.trim() : ''
    if (raw) hasInvalidDateText = true
    else blankDays += 1
  }
  const allDatesMissing = days.length > 0 && datedDays === 0 && blankDays === days.length
  const needsFirstDate =
    allDatesMissing && days.some((day) => Array.isArray(day.stops) && day.stops.length > 0)
  return {
    totalDays: days.length,
    datedDays,
    undatedDays,
    allDatesMissing,
    hasInvalidDateText,
    needsFirstDate,
  }
}

/**
 * RFC 5545 §3.3.11 TEXT 转义 + 控制字符清理：
 * 反斜杠、分号、逗号按规则转义；CRLF/CR/LF 统一转成 `\n`；
 * 其余 ASCII 控制字符、DEL、C1 控制符与孤立代理对直接剥离。转义顺序保证
 * 原文里的字面反斜杠和由换行引入的反斜杠互不污染。
 */
export function escapeIcsText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const normalized = raw.replace(/\r\n?/g, '\n')
  let cleaned = ''
  for (const ch of normalized) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 10) {
      // LF 保留，逻辑行 assembled 后统一转成 \n；其余控制字符一律剥离
      cleaned += ch
      continue
    }
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) continue
    // 孤立代理对（合法的成对代理会作为一个整体码点迭代，cp > 0xFFFF，不会落到这里）
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    cleaned += ch
  }
  return cleaned
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

/** 码点 → UTF-8 八位字节宽度 */
function utf8Octets(cp: number): number {
  if (cp <= 0x7f) return 1
  if (cp <= 0x7ff) return 2
  if (cp <= 0xffff) return 3
  return 4
}

/**
 * RFC 5545 §3.1 折行：逻辑行超 75 个 UTF-8 八位字节即拆分，物理行之间用 CRLF 连接、
 * 续行前加一个空格（该空格计入续行自身的 75 字节）。折点只落在完整码点边界，
 * 含 4 字节字符的行同样安全。返回的字符串行尾不带 CRLF。
 */
export function foldIcsLine(line: string): string {
  const chunks: string[] = []
  let current = ''
  let currentOctets = 0
  for (const ch of line) {
    const octets = utf8Octets(ch.codePointAt(0) ?? 0)
    if (currentOctets + octets <= 75) {
      current += ch
      currentOctets += octets
    } else {
      chunks.push(current)
      current = ' ' + ch
      currentOctets = 1 + octets
    }
  }
  chunks.push(current)
  return chunks.join('\r\n')
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatDateKey(d: IcsDatePoint): string {
  return `${d.y}${pad2(d.m)}${pad2(d.d)}`
}

function formatTimeKey(t: IcsTimePoint): string {
  return `${pad2(t.h)}${pad2(t.m)}${pad2(t.s)}`
}

/** DTSTAMP 用 UTC 秒级时间戳；输入异常时的兜底值是 Unix 纪元，仅供防御性路径 */
function formatDtStamp(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return '19700101T000000Z'
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`
}

/** 只有 1..MAX_STAY_MINUTES 的整数才算已知时长；其余一律视为「结束时间未知」 */
function isKnownDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_STAY_MINUTES
  )
}

/**
 * 结束时间 = 开始时间 + stayMinutes，用 Date.UTC 的溢出进位做日历日滚动，
 * 不经过任何本地时区/DST 参与的运算。年份溢出 4 位时返回 null。
 */
function computeEnd(
  date: IcsDatePoint,
  clock: IcsTimePoint,
  stayMinutes: number,
): { date: IcsDatePoint; time: IcsTimePoint } | null {
  const end = new Date(Date.UTC(date.y, date.m - 1, date.d, clock.h, clock.m + stayMinutes, clock.s))
  const y = end.getUTCFullYear()
  if (y < 1000 || y > 9999) return null
  return {
    date: { y, m: end.getUTCMonth() + 1, d: end.getUTCDate() },
    time: { h: end.getUTCHours(), m: end.getUTCMinutes(), s: end.getUTCSeconds() },
  }
}

/** 32 位 FNV-1a：按 UTF-16 码元运算，跨平台稳定、无随机性 */
function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0')
}

/**
 * UID = 双轮哈希 16 位 hex + 固定域。只绑定事件身份（行程、日期、开始时刻、站点、重复序号），
 * 不含时长/结束时间，因此时长未知或后来补全都稳定；重复导出同一事件得到同一 UID，
 * 且不含可读行程文本。
 */
function buildIcsUid(
  tripId: string,
  date: IcsDatePoint,
  startKey: string,
  stopId: string,
  occurrence: number,
): string {
  const key = `ics-v2|${tripId}|${formatDateKey(date)}|${startKey}|${stopId}|n=${occurrence}`
  const h1 = fnv1a32(key, 0x811c9dc5)
  const h2 = fnv1a32(`${key}\u0001h2`, 0x1b873593)
  return `${hex8(h1)}${hex8(h2)}@travel-assistant.local`
}

/** 跳过记录里的站点展示名：名字空就退到 id，再退到占位文本 */
function stopLabel(stop: TripStop): string {
  const name = typeof stop.name === 'string' ? stop.name.trim() : ''
  return name || stop.id || '未命名站点'
}

function buildSkip(
  day: TripDay,
  stop: TripStop,
  reason: IcsSkipReason,
  message?: string,
): IcsSkip {
  let resolved = message ?? ''
  if (!resolved) {
    const label = stopLabel(stop)
    if (reason === 'day_date_missing') {
      resolved = `第 ${day.day} 天没有日期（date 为空），站点「${label}」缺少日历所需日期`
    } else if (reason === 'day_date_invalid') {
      resolved = `第 ${day.day} 天日期「${String(day.date)}」不是合法日历日期，站点「${label}」无法创建日历事件`
    } else if (reason === 'stop_time_invalid') {
      resolved = `站点「${label}」时刻不是合法的 HH:MM(:SS)，无法创建日历事件`
    } else {
      resolved = `站点「${label}」没有名称，日历事件缺少标题，已跳过`
    }
  }
  return {
    day: day.day,
    stopId: stop.id,
    stopName: stop.name,
    reason,
    message: resolved,
  }
}

/**
 * 把一个 Trip 转成可被主流日历（iOS 日历 / Google Calendar / Outlook）导入的 .ics 文本。
 * 纯函数：不做 IO、不读环境变量、不访问网络，也不依赖本地时区。
 * options.now 只影响 DTSTAMP（对象创建时间），可传固定值获得确定性输出。
 * options.firstDate 只在整份行程都缺日期时生效，按天序号临时推算，不修改原行程。
 */
export function tripToIcs(trip: Trip, options?: IcsExportOptions): IcsExportResult {
  const skipped: IcsSkip[] = []
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//travel-assistant//Trip ICS Export//ZH-CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]
  let eventCount = 0
  let missingDurationCount = 0
  const usedUids = new Set<string>()
  const stamp = formatDtStamp(options?.now ?? new Date())
  const tripId = typeof trip?.id === 'string' ? trip.id : ''
  const days: TripDay[] = Array.isArray((trip as Trip | undefined)?.days) ? trip.days : []
  const coverage = tripDateCoverage(trip)
  const requestedFirstDate = typeof options?.firstDate === 'string' ? options.firstDate.trim() : ''
  const firstDatePoint = requestedFirstDate ? parseIcsDate(requestedFirstDate) : null
  // 只有整份行程都缺日期时才允许推算；已有任意真实日期时一律忽略首日参数
  const baseDate = coverage.allDatesMissing ? firstDatePoint : null
  const provisionalDates: IcsProvisionalDate[] = []

  for (const day of days) {
    if (!day) continue
    const stops: TripStop[] = Array.isArray(day.stops) ? day.stops : []
    let datePoint = parseIcsDate(day.date ?? '')
    if (datePoint === null && baseDate !== null) {
      if (Number.isSafeInteger(day.day) && day.day >= 1 && day.day <= 366) {
        const derived = addCalendarDays(baseDate, day.day - 1)
        if (derived !== null) {
          datePoint = derived
          provisionalDates.push({ day: day.day, date: toIsoDate(derived) })
        }
      }
    }
    if (datePoint === null) {
      // 日级原因：日期缺失（date 为 null/空串）或非法（写得不规范/不存在的日历日）
      const rawDate = typeof day.date === 'string' ? day.date.trim() : ''
      const reason: IcsSkipReason = rawDate ? 'day_date_invalid' : 'day_date_missing'
      for (const stop of stops) {
        if (!stop) continue
        const message =
          reason === 'day_date_missing' && coverage.allDatesMissing
            ? `第 ${day.day} 天没有日期（date 为空），站点「${stopLabel(stop)}」缺少日历所需日期；请先选择行程首日再导出`
            : undefined
        skipped.push(buildSkip(day, stop, reason, message))
      }
      continue
    }

    for (const stop of stops) {
      if (!stop) continue
      const timePoint = parseIcsTime(stop.time ?? '')
      if (timePoint === null) {
        const rawTime = typeof stop.time === 'string' ? stop.time.trim() : ''
        skipped.push(
          buildSkip(
            day,
            stop,
            'stop_time_invalid',
            rawTime
              ? `站点「${stopLabel(stop)}」时刻「${rawTime}」不是合法的 HH:MM(:SS) 时间`
              : `站点「${stopLabel(stop)}」没有开始时刻，无法创建日历事件`,
          ),
        )
        continue
      }
      const name = typeof stop.name === 'string' ? stop.name : ''
      if (!name.trim()) {
        skipped.push(buildSkip(day, stop, 'stop_name_missing'))
        continue
      }

      const duration: unknown = stop.duration_minutes
      const hasKnownDuration = isKnownDuration(duration)
      let endKey: string | null = null
      if (hasKnownDuration) {
        const end = computeEnd(datePoint, timePoint, duration)
        if (end === null) {
          // 4 位年份的极端边界，正常数据到不了这里
          skipped.push(
            buildSkip(day, stop, 'stop_time_invalid', `站点「${stopLabel(stop)}」结束时间超出 4 位年份范围，已跳过`),
          )
          continue
        }
        endKey = `${formatDateKey(end.date)}T${formatTimeKey(end.time)}`
      }

      const startKey = `${formatDateKey(datePoint)}T${formatTimeKey(timePoint)}`
      const stopId = stop.id ?? ''
      let occurrence = 0
      let uid = buildIcsUid(tripId, datePoint, startKey, stopId, occurrence)
      // 同一 (日期, 开始时刻, stopId) 重复出现时，用确定性序号再哈希，保证 UID 仍唯一
      while (usedUids.has(uid)) {
        occurrence += 1
        uid = buildIcsUid(tripId, datePoint, startKey, stopId, occurrence)
      }
      usedUids.add(uid)

      const isExample = trip?.source === 'example'
      const summaryRaw = isExample ? `【示例】${name}` : name
      const descriptionParts: string[] = []
      const description = typeof stop.description === 'string' ? stop.description.trim() : ''
      if (description) descriptionParts.push(description)
      if (isExample) descriptionParts.push('示例行程数据，仅用于演示，未包含任何真实预约。')
      const address = typeof stop.address === 'string' ? stop.address.trim() : ''

      lines.push('BEGIN:VEVENT')
      lines.push(`UID:${uid}`)
      lines.push(`DTSTAMP:${stamp}`)
      lines.push(`DTSTART:${startKey}`)
      // 只有已知时长才写 DTEND；时长未知时保持时刻事件，不用 DURATION 或默认值补一个结束时间
      if (endKey !== null) lines.push(`DTEND:${endKey}`)
      lines.push(`SUMMARY:${escapeIcsText(summaryRaw)}`)
      if (descriptionParts.length > 0) {
        lines.push(`DESCRIPTION:${escapeIcsText(descriptionParts.join('\n'))}`)
      }
      if (address) lines.push(`LOCATION:${escapeIcsText(address)}`)
      lines.push('END:VEVENT')
      eventCount += 1
      if (!hasKnownDuration) missingDurationCount += 1
    }
  }

  lines.push('END:VCALENDAR')
  const ics = lines.map(foldIcsLine).join('\r\n') + '\r\n'

  const notices: string[] = []
  if (eventCount > 0) {
    notices.push(
      '开始时间（以及已知的结束时间）不带时区（floating local time）：日历导入后按导入设备的本地时区解释这些时刻，' +
        '跨时区出行或设备时区与行程地不同时，日历上的时间会随设备时区变化，导入后请抽查第一场事件的开始时间。',
    )
    notices.push(
      '坐标（WGS84）不是 .ics 文本字段能表达的内容，LOCATION 一律使用站点地址；地址或讲解为空的站点会省略对应字段，不做填充。',
    )
  } else {
    notices.push('没有可导出的站点：所有站点都缺少合法的日期或开始时刻，未生成任何日历事件。')
  }
  if (eventCount > 0 && trip.source === 'example') {
    notices.push('本行程属于示例源：事件标题带【示例】前缀，描述注明未含真实预约，避免被误认成已确认安排。')
  }
  if (missingDurationCount > 0) {
    notices.push(
      `有 ${missingDurationCount} 个站点缺少有效的停留时长（缺失、为 0、负数、非整数或超过 ${MAX_STAY_MINUTES} 分钟），` +
        '这些事件只写入开始时间，没有写结束时间，也没有用默认时长补算。',
    )
    notices.push(
      '上述事件缺少已知的结束时间；日历应用导入后可能按自身默认时长显示一个结束时间，' +
        '该结束时间不是行程数据的一部分，需要准确时长时请在导入后手动调整。',
    )
  }

  const firstDateUsed = baseDate !== null && provisionalDates.length > 0
  if (baseDate !== null && provisionalDates.length > 0) {
    const sample = provisionalDates.slice(0, 3)
      .map((item) => `第 ${item.day} 天 ${item.date}`)
      .join('、')
    notices.push(
      `这份行程的全部 ${coverage.totalDays} 天都没有日期（date 为空）。已按你明确选择的首日 ${toIsoDate(baseDate)} ` +
        `与行程天序号临时推算日期（${sample}${provisionalDates.length > 3 ? ' 等' : ''}；跨月、跨年和闰年按真实日历计算）。` +
        '这些日期只用于本次导出，不会修改、写回或自动保存原行程，也不会被当成真实日期。',
    )
  } else if (coverage.allDatesMissing) {
    if (requestedFirstDate && firstDatePoint === null) {
      notices.push('你选择的首日不是合法的 YYYY-MM-DD 日期，已忽略，没有推算任何临时日期。')
    } else {
      notices.push(
        '这份行程的所有天都没有日期（date 为空）。为避免凭空捏造日期，未生成任何事件；' +
          '请先明确选择行程首日，再按第几天推算临时日期（仅用于本次导出）。',
      )
    }
  } else if (coverage.undatedDays.length > 0) {
    notices.push(
      `第 ${coverage.undatedDays.join('、')} 天没有可用的日期，这些天的站点已跳过。` +
        '这份行程其他天有真实日期，为避免覆盖或伪造日期，没有按第几天自动推算缺失日期。',
    )
  }
  if (requestedFirstDate && !coverage.allDatesMissing) {
    notices.push('这份行程已有真实日期，选择的首日被忽略；已有日期不会被覆盖，缺失日期只跳过。')
  }

  return {
    ics,
    eventCount,
    skippedCount: skipped.length,
    skipped,
    missingDurationCount,
    notices,
    firstDateUsed,
    provisionalDates: provisionalDates.sort((a, b) => a.day - b.day),
  }
}

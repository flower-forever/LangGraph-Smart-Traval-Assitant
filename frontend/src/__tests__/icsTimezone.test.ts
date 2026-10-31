import { describe, expect, it } from 'vitest'
import {
  formatZonedLocalParts,
  isSupportedIanaTimeZone,
  resolveZonedLocalToUtc,
} from '../lib/icsTimezone'

const iso = (epochMs: number): string => new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('isSupportedIanaTimeZone', () => {
  it('接受常见 IANA 名称与首尾空白，拒绝空串与非字符串', () => {
    expect(isSupportedIanaTimeZone('Asia/Shanghai')).toBe(true)
    expect(isSupportedIanaTimeZone('  America/New_York\n')).toBe(true)
    expect(isSupportedIanaTimeZone('UTC')).toBe(true)
    expect(isSupportedIanaTimeZone('')).toBe(false)
    expect(isSupportedIanaTimeZone('   ')).toBe(false)
    expect(isSupportedIanaTimeZone(undefined)).toBe(false)
    expect(isSupportedIanaTimeZone(42)).toBe(false)
  })

  it('IANA 名称匹配与 ICU 一致：大小写不敏感（asia/shanghai 等价于 Asia/Shanghai）', () => {
    expect(isSupportedIanaTimeZone('asia/shanghai')).toBe(true)
    expect(isSupportedIanaTimeZone('AMERICA/NEW_YORK')).toBe(true)
    const result = resolveZonedLocalToUtc('asia/shanghai', 2026, 11, 1, 9, 0)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-11-01T01:00:00Z')
  })

  it('拒绝不是时区名的自由文本（真实错误必须显示，不能静默回退）', () => {
    expect(isSupportedIanaTimeZone('Shanghai')).toBe(false)
    expect(isSupportedIanaTimeZone('GMT+8')).toBe(false)
    expect(isSupportedIanaTimeZone('America／New_York')).toBe(false)
  })
})

describe('resolveZonedLocalToUtc：常规唯一时刻', () => {
  it('上海 2026-11-01 09:00 → 01:00Z（UTC+8，无 DST）', () => {
    const result = resolveZonedLocalToUtc('Asia/Shanghai', 2026, 11, 1, 9, 0)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-11-01T01:00:00Z')
  })

  it('纽约夏季偏移 -4：2026-07-15 09:00 → 13:00Z', () => {
    const result = resolveZonedLocalToUtc('America/New_York', 2026, 7, 15, 9, 0)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-07-15T13:00:00Z')
  })

  it('纽约冬季偏移 -5：2026-12-15 09:00 → 14:00Z（同当地时刻、不同 UTC）', () => {
    const result = resolveZonedLocalToUtc('America/New_York', 2026, 12, 15, 9, 0)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-12-15T14:00:00Z')
  })

  it('加德满都非整小时偏移 +5:45：2026-05-01 09:00 → 03:15Z', () => {
    const result = resolveZonedLocalToUtc('Asia/Kathmandu', 2026, 5, 1, 9, 0)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-05-01T03:15:00Z')
  })

  it('Lord Howe 标准时 +10:30：2026-06-01 09:00 → 22:30Z（前一天 UTC）', () => {
    const result = resolveZonedLocalToUtc('Australia/Lord_Howe', 2026, 6, 1, 9, 0)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-05-31T22:30:00Z')
  })

  it('秒数参与解析：上海 2026-04-03 10:15:30 → 02:15:30Z', () => {
    const result = resolveZonedLocalToUtc('Asia/Shanghai', 2026, 4, 3, 10, 15, 30)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-04-03T02:15:30Z')
  })

  it('太平洋/查塔姆 +12:45 整点偏移：2026-06-01 09:00 → 2026-05-31 20:15Z', () => {
    const result = resolveZonedLocalToUtc('Pacific/Chatham', 2026, 6, 1, 9, 0)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-05-31T20:15:00Z')
  })
})

describe('resolveZonedLocalToUtc：DST 空档与重复时刻', () => {
  it('纽约 2026-03-08 02:30 不存在（春季拨快跳过），结构化 nonexistent', () => {
    const result = resolveZonedLocalToUtc('America/New_York', 2026, 3, 8, 2, 30)
    expect(result).toEqual({ kind: 'nonexistent' })
  })

  it('纽约 2026-11-01 01:30 重复（秋季拨回），两个候选 UTC 都列出且升序', () => {
    const result = resolveZonedLocalToUtc('America/New_York', 2026, 11, 1, 1, 30)
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.epochMsList.map(iso)).toEqual([
        '2026-11-01T05:30:00Z',
        '2026-11-01T06:30:00Z',
      ])
    }
  })

  it('重叠时段的边缘时刻同样双解：纽约 2026-11-01 01:00 与 01:59:59', () => {
    const whole = resolveZonedLocalToUtc('America/New_York', 2026, 11, 1, 1, 0)
    expect(whole.kind).toBe('ambiguous')
    const edge = resolveZonedLocalToUtc('America/New_York', 2026, 11, 1, 1, 59, 59)
    expect(edge.kind).toBe('ambiguous')
  })

  it('重叠时段之外只回拨一侧：纽约 2026-11-01 00:30 → 04:30Z（EDT -4）', () => {
    const result = resolveZonedLocalToUtc('America/New_York', 2026, 11, 1, 0, 30)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-11-01T04:30:00Z')
  })

  it('拨回完成后唯一：纽约 2026-11-01 02:30 → 07:30Z（EST -5）', () => {
    const result = resolveZonedLocalToUtc('America/New_York', 2026, 11, 1, 2, 30)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-11-01T07:30:00Z')
  })

  it('Lord Howe 半小时 DST：2026-10-04 02:15 空档不存在、02:45 重复（±30 分钟）', () => {
    // Lord Howe 春季切换：2026-10-04 02:00 拨快到 02:30，本地 02:00..02:29 不存在
    expect(resolveZonedLocalToUtc('Australia/Lord_Howe', 2026, 10, 4, 2, 15)).toEqual({
      kind: 'nonexistent',
    })
    // 秋季切换：2027-04-04 02:00 拨回到 01:30，本地 01:30..01:59 重复
    const overlap = resolveZonedLocalToUtc('Australia/Lord_Howe', 2027, 4, 4, 1, 45)
    expect(overlap.kind).toBe('ambiguous')
  })

  it('Lord Howe 夏令时 +11：2026-01-15 09:00 → 2026-01-14 22:00Z', () => {
    const result = resolveZonedLocalToUtc('Australia/Lord_Howe', 2026, 1, 15, 9, 0)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2026-01-14T22:00:00Z')
  })

  it('跨日变更（Apia 2011-12-30 整日被跳过）：该日任何时刻都不存在', () => {
    expect(resolveZonedLocalToUtc('Pacific/Apia', 2011, 12, 30, 9, 0)).toEqual({
      kind: 'nonexistent',
    })
    expect(resolveZonedLocalToUtc('Pacific/Apia', 2011, 12, 30, 0, 0)).toEqual({
      kind: 'nonexistent',
    })
    expect(resolveZonedLocalToUtc('Pacific/Apia', 2011, 12, 30, 23, 59)).toEqual({
      kind: 'nonexistent',
    })
  })

  it('Apia 跳日前的时刻仍唯一：2011-12-29 09:00 → 同日 19:00Z（当时偏移 -10）', () => {
    const result = resolveZonedLocalToUtc('Pacific/Apia', 2011, 12, 29, 9, 0)
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') expect(iso(result.epochMs)).toBe('2011-12-29T19:00:00Z')
  })
})

describe('resolveZonedLocalToUtc：输入校验与不可变性', () => {
  it('分量越界返回 invalid_input，不抛异常', () => {
    expect(resolveZonedLocalToUtc('Asia/Shanghai', 2026, 13, 1, 9, 0).kind).toBe('invalid_input')
    expect(resolveZonedLocalToUtc('Asia/Shanghai', 2026, 4, 3, 24, 0).kind).toBe('invalid_input')
    expect(resolveZonedLocalToUtc('Asia/Shanghai', 2026, 4, 3, 9, 60).kind).toBe('invalid_input')
    expect(resolveZonedLocalToUtc('Asia/Shanghai', 2026, 4, 3, 9, 0, 60).kind).toBe('invalid_input')
    expect(resolveZonedLocalToUtc('Asia/Shanghai', 999, 4, 3, 9, 0).kind).toBe('invalid_input')
  })

  it('分量合法但日历上不存在的日期（4 月 31 日）返回 nonexistent，不编造时刻', () => {
    expect(resolveZonedLocalToUtc('Asia/Shanghai', 2026, 4, 31, 9, 0)).toEqual({ kind: 'nonexistent' })
  })

  it('不支持的时区返回 invalid_input', () => {
    expect(resolveZonedLocalToUtc('Mars/Olympus', 2026, 4, 3, 9, 0).kind).toBe('invalid_input')
    expect(resolveZonedLocalToUtc('', 2026, 4, 3, 9, 0).kind).toBe('invalid_input')
  })

  it('不修改任何输入（值语义，无可变副作用）', () => {
    const zone = 'Asia/Shanghai'
    resolveZonedLocalToUtc(zone, 2026, 4, 3, 9, 0)
    expect(zone).toBe('Asia/Shanghai')
  })
})

describe('formatZonedLocalParts', () => {
  it('同一 UTC 在不同时区读出不同的当地墙上时间（显式 timeZone，不依赖机器时区）', () => {
    const instant = Date.UTC(2026, 6, 15, 13, 0, 0)
    const ny = formatZonedLocalParts('America/New_York', instant)
    const sh = formatZonedLocalParts('Asia/Shanghai', instant)
    expect(ny).toMatchObject({ era: 'AD', y: 2026, m: 7, d: 15, h: 9, mi: 0, s: 0 })
    expect(sh).toMatchObject({ era: 'AD', y: 2026, m: 7, d: 15, h: 21, mi: 0, s: 0 })
  })

  it('无效时区或非法时刻返回 null', () => {
    expect(formatZonedLocalParts('No/Such-Zone', Date.UTC(2026, 0, 1))).toBeNull()
    expect(formatZonedLocalParts('Asia/Shanghai', Number.NaN)).toBeNull()
    expect(formatZonedLocalParts('Asia/Shanghai', Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('超 Date TimeClip 范围的有限 epoch 返回 null 而不抛 RangeError（±8.64e15 边界）', () => {
    // 边界值本身可表示；超出 1ms 即抛 RangeError，必须被防御成 null
    expect(formatZonedLocalParts('Asia/Shanghai', 8.64e15)).not.toBeNull()
    expect(formatZonedLocalParts('Asia/Shanghai', -8.64e15)).not.toBeNull()
    expect(formatZonedLocalParts('Asia/Shanghai', 8.64e15 + 1)).toBeNull()
    expect(formatZonedLocalParts('Asia/Shanghai', -8.64e15 - 1)).toBeNull()
  })
})

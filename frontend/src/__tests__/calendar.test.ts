import type { Trip, TripDay, TripStop } from '../lib/api'
import { describe, expect, it } from 'vitest'
import {
  MAX_STAY_MINUTES,
  escapeIcsText,
  foldIcsLine,
  parseIcsDate,
  parseIcsTime,
  tripDateCoverage,
  tripToIcs,
} from '../lib/calendar'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD } from './fixtures/trip'

/** 与实现无关的独立字节计数，专门用来核对 75 八位字节折行 */
const utf8ByteLen = (text: string): number => new TextEncoder().encode(text).length

/** RFC 折行的逆向：删掉「CRLF+单个空格」还原逻辑行（数据里的换行都已转义，不会误伤） */
const unfoldIcs = (ics: string): string => ics.replace(/\r\n /g, '')

/** 物理行列表（去掉末尾空串）：一行一个元素，用于逐行断言 */
const splitIcsLines = (ics: string): string[] => ics.split('\r\n').slice(0, -1)

const icsUids = (ics: string): string[] =>
  ics
    .split('\r\n')
    .filter((line) => line.startsWith('UID:'))
    .map((line) => line.slice(4))

/** 逻辑行视角下的 VEVENT 列表：每个事件一个属性行数组，方便断言某事件有没有 DTEND */
function icsEvents(ics: string): string[][] {
  const events: string[][] = []
  let current: string[] | null = null
  for (const line of unfoldIcs(ics).split('\r\n')) {
    if (line === 'BEGIN:VEVENT') {
      current = []
    } else if (line === 'END:VEVENT') {
      if (current) events.push(current)
      current = null
    } else if (current) {
      current.push(line)
    }
  }
  return events
}

const summaryOf = (event: string[]): string =>
  event.find((line) => line.startsWith('SUMMARY:'))?.slice('SUMMARY:'.length) ?? ''

/** 按 SUMMARY 找事件；测试里的站名唯一，重复名不用于这里 */
function eventsBySummary(ics: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const event of icsEvents(ics)) map.set(summaryOf(event), event)
  return map
}

const FIXED_NOW = new Date('2026-01-01T08:00:00.000Z')

function buildTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-test-1',
    source: 'agent',
    destination: '杭州',
    title: '测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [],
    ...overrides,
  }
}

function mkDay(day: number, date: string | null, stops: TripStop[]): TripDay {
  return { day, date, title: `第 ${day} 天`, summary: '', stops, legs: [] }
}

function mkStop(
  id: string,
  time: string,
  durationMinutes: number | null,
  name = '',
  patch: Partial<TripStop> = {},
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes: durationMinutes,
    description: '',
    address: '',
    location: null,
    ...patch,
  }
}

describe('escapeIcsText：TEXT 转义与控制字符清理', () => {
  it('转义反斜杠、分号、逗号，普通文本原样保留（含中文）', () => {
    expect(escapeIcsText('A\\B;C,D')).toBe('A\\\\B\\;C\\,D')
    expect(escapeIcsText('西湖醋鱼')).toBe('西湖醋鱼')
    expect(escapeIcsText('')).toBe('')
    expect(escapeIcsText(undefined)).toBe('')
    expect(escapeIcsText(42)).toBe('')
  })

  it('换行（LF/CR/CRLF）统一转成 \\n', () => {
    expect(escapeIcsText('第一段\n第二段')).toBe('第一段\\n第二段')
    expect(escapeIcsText('窗\r\n景')).toBe('窗\\n景')
    expect(escapeIcsText('孤\r行')).toBe('孤\\n行')
  })

  it('剥离控制字符、DEL、C1 控制符与孤立代理对，防止注入', () => {
    expect(escapeIcsText('断\u0007桥\u001b残\u007f雪')).toBe('断桥残雪')
    expect(escapeIcsText('京\u0093杭\t大\n运河')).toBe('京杭大\\n运河')
    expect(escapeIcsText('钱塘\uD800潮')).toBe('钱塘潮')
  })
})

describe('foldIcsLine：75 八位字节折行', () => {
  it('75 字节以内不折叠，超出后续行以单个空格开头', () => {
    expect(foldIcsLine('A'.repeat(75))).toBe('A'.repeat(75))
    expect(foldIcsLine('A'.repeat(76))).toBe('A'.repeat(75) + '\r\n A')
  })

  it('按完整码点折行，不会在中文中间切开，展开后与原行一致', () => {
    const line = 'K:' + '湖'.repeat(26)
    const folded = foldIcsLine(line)
    expect(folded).toBe('K:' + '湖'.repeat(24) + '\r\n ' + '湖'.repeat(2))
    expect(unfoldIcs(folded)).toBe(line)
  })
})

describe('parseIcsDate / parseIcsTime：严格校验', () => {
  it('日期只收合法的 YYYY-MM-DD 日历日', () => {
    expect(parseIcsDate('2026-04-03')).toEqual({ y: 2026, m: 4, d: 3 })
    expect(parseIcsDate(' 2026-04-03 ')).toEqual({ y: 2026, m: 4, d: 3 })
    expect(parseIcsDate('2024-02-29')).toEqual({ y: 2024, m: 2, d: 29 })
    expect(parseIcsDate('2026-02-30')).toBeNull()
    expect(parseIcsDate('2026-13-01')).toBeNull()
    expect(parseIcsDate('2026-4-3')).toBeNull()
    expect(parseIcsDate('2026-04-03T09:00')).toBeNull()
    expect(parseIcsDate('')).toBeNull()
  })

  it('时刻只收 HH:MM(:SS)，越界与自由文本一律拒绝', () => {
    expect(parseIcsTime('09:00')).toEqual({ h: 9, m: 0, s: 0 })
    expect(parseIcsTime('9:05')).toEqual({ h: 9, m: 5, s: 0 })
    expect(parseIcsTime(' 10:15:30 ')).toEqual({ h: 10, m: 15, s: 30 })
    expect(parseIcsTime('09:00:00')).toEqual({ h: 9, m: 0, s: 0 })
    expect(parseIcsTime('25:00')).toBeNull()
    expect(parseIcsTime('09:99')).toBeNull()
    expect(parseIcsTime('10:15:61')).toBeNull()
    expect(parseIcsTime('早上九点')).toBeNull()
    expect(parseIcsTime('')).toBeNull()
  })
})

describe('tripToIcs：示例行程夹具 MOCK_TRIP', () => {
  const result = tripToIcs(MOCK_TRIP, { now: FIXED_NOW })
  const lineList = splitIcsLines(result.ics)

  it('导出 3 条（day1 三个站点）、跳过 1 条（day3 无日期），计数闭合', () => {
    expect(result.eventCount).toBe(3)
    expect(result.skippedCount).toBe(1)
    expect(result.missingDurationCount).toBe(1) // 湖滨晴雨 duration_minutes 为 null
    expect(result.eventCount + result.skippedCount).toBe(
      MOCK_TRIP.days.reduce((sum, day) => sum + day.stops.length, 0),
    )
    expect(result.skipped).toEqual([
      {
        day: 3,
        stopId: 's4',
        stopName: '龙井村',
        reason: 'day_date_missing',
        message: '第 3 天没有日期（date 为空），站点「龙井村」缺少日历所需日期',
      },
    ])
  })

  it('VCALENDAR 骨架与三条事件的开始时间正确，未知时长的第三条没有 DTEND', () => {
    expect(lineList.slice(0, 6)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//travel-assistant//Trip ICS Export//ZH-CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
    ])
    expect(lineList).toContain('DTSTAMP:20260101T080000Z')
    expect(lineList).toContain('DTSTART:20260403T090000')
    expect(lineList).toContain('DTEND:20260403T094000')
    expect(lineList).toContain('DTSTART:20260403T100000')
    expect(lineList).toContain('DTEND:20260403T103000')
    expect(lineList).toContain('DTSTART:20260403T113000')

    const events = icsEvents(result.ics)
    expect(events).toHaveLength(3)
    const missing = events[2]
    expect(missing).toContain('SUMMARY:【示例】湖滨晴雨')
    expect(missing.some((line) => line.startsWith('DTEND:'))).toBe(false)
    expect(missing.some((line) => line.startsWith('DURATION:'))).toBe(false)
    // 只有两个已知时长的事件带 DTEND
    expect(lineList.filter((line) => line.startsWith('DTEND:'))).toEqual([
      'DTEND:20260403T094000',
      'DTEND:20260403T103000',
    ])
    expect(lineList[lineList.length - 1]).toBe('END:VCALENDAR')
  })

  it('浮点本地时间：DTSTART/DTEND 不带时区标记（Z 或 TZID）', () => {
    expect(result.ics).not.toContain('TZID')
    for (const line of lineList) {
      if (line.startsWith('DTSTART:') || line.startsWith('DTEND:')) {
        expect(line.slice(line.indexOf(':') + 1)).toMatch(/^\d{8}T\d{6}$/)
      }
    }
  })

  it('示例源标识：SUMMARY 全部带【示例】前缀，说明文字里注明未含真实预约', () => {
    const summaries = lineList.filter((line) => line.startsWith('SUMMARY:'))
    expect(summaries).toEqual([
      'SUMMARY:【示例】断桥残雪',
      'SUMMARY:【示例】平湖秋月',
      'SUMMARY:【示例】湖滨晴雨',
    ])
    const joined = result.notices.join('\n')
    expect(joined).toContain('floating local time')
    expect(joined).toContain('导入设备')
    expect(joined).toContain('【示例】')
    expect(joined).toContain('有 1 个站点缺少有效的停留时长')
    expect(joined).toContain('没有写结束时间')
    expect(joined).toContain('默认时长')
    expect(joined).not.toContain('已按默认')
  })

  it('LOCATION 用地址文本、不含坐标；每条物理行 ≤75 个 UTF-8 字节且全为 CRLF', () => {
    expect(result.ics).toContain('LOCATION:杭州市西湖区白堤东端')
    expect(result.ics).not.toContain('120.')
    expect(result.ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    const withoutCrlf = result.ics.replace(/\r\n/g, '')
    expect(withoutCrlf).not.toContain('\n')
    expect(withoutCrlf).not.toContain('\r')
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/.test(withoutCrlf)).toBe(false)
    for (const line of lineList) {
      expect(utf8ByteLen(line)).toBeLessThanOrEqual(75)
    }
  })

  it('同样输入重复导出，输出逐字节一致（固定 DTSTAMP）', () => {
    expect(result.ics).toBe(tripToIcs(MOCK_TRIP, { now: FIXED_NOW }).ics)
  })
})

describe('tripToIcs：日期与时刻校验的跳过语义', () => {
  it('日期缺失/非法、时刻非法的站点跳过并给出原因，秒数合法时保留', () => {
    const trip = buildTrip({
      days: [
        mkDay(1, '2026-04-03', [
          mkStop('a', '09:00', 30, '正常站'),
          mkStop('b', '25:00', 30, '超时段'),
          mkStop('c', '09:99', 30, '坏分针'),
        ]),
        mkDay(2, '2026-02-30', [mkStop('d', '09:00', 30, '假日期')]),
        mkDay(3, null, [mkStop('e', '09:00', 30, '无日期')]),
        mkDay(4, '', [mkStop('f', '09:00', 30, '空日期')]),
        mkDay(5, '2026-1-5', [mkStop('g', '09:00', 30, '短格式日期')]),
        mkDay(6, '2026-04-05', [mkStop('h', '10:15:30', 45, '带秒')]),
      ],
    })
    const result = tripToIcs(trip, { now: FIXED_NOW })
    expect(result.eventCount).toBe(2)
    expect(result.skippedCount).toBe(6)
    expect(result.eventCount + result.skippedCount).toBe(8)
    expect(result.missingDurationCount).toBe(0)

    const reasonById = new Map(result.skipped.map((entry) => [entry.stopId, entry.reason]))
    expect(reasonById.get('b')).toBe('stop_time_invalid')
    expect(reasonById.get('c')).toBe('stop_time_invalid')
    expect(reasonById.get('d')).toBe('day_date_invalid')
    expect(reasonById.get('e')).toBe('day_date_missing')
    expect(reasonById.get('f')).toBe('day_date_missing')
    expect(reasonById.get('g')).toBe('day_date_invalid')

    const lineList = result.ics.split('\r\n')
    expect(lineList).toContain('DTSTART:20260405T101530')
    expect(lineList).toContain('DTEND:20260405T110030')
  })

  it('站点名称为空（含纯空白）也跳过', () => {
    const trip = buildTrip({
      days: [mkDay(1, '2026-04-05', [mkStop('x', '08:00', 20), mkStop('y', '08:30', 20, '   ')])],
    })
    const result = tripToIcs(trip, { now: FIXED_NOW })
    expect(result.eventCount).toBe(0)
    expect(result.skippedCount).toBe(2)
    expect(new Set(result.skipped.map((entry) => entry.reason))).toEqual(new Set(['stop_name_missing']))
  })

  it('agent 来源不加【示例】前缀；无描述无地址时省略 DESCRIPTION/LOCATION', () => {
    const trip = buildTrip({
      source: 'agent',
      days: [
        mkDay(1, '2026-04-05', [
          mkStop('a', '09:00', 30, '自由活动', { address: '西湖区某路' }),
          mkStop('b', '10:00', 30, '纯名字站点'),
        ]),
      ],
    })
    const result = tripToIcs(trip, { now: FIXED_NOW })
    const lineList = splitIcsLines(result.ics)
    expect(lineList).toContain('SUMMARY:自由活动')
    expect(lineList.join('\n')).not.toContain('【示例】')
    expect(result.notices.join('\n')).not.toContain('示例源')
    // 描述为空 → 不写 DESCRIPTION（a/b 的 description 均为空）；地址非空 → 写 LOCATION
    expect(lineList.some((line) => line.startsWith('DESCRIPTION:'))).toBe(false)
    expect(lineList).toContain('LOCATION:西湖区某路')
  })
})

describe('tripToIcs：时长语义（已知时长才写 DTEND，不虚构结束时间）', () => {
  it('缺失/为 0/负数/非整数/超上限都不写 DTEND，只有有效时长写并计数', () => {
    const trip = buildTrip({
      days: [
        mkDay(1, '2026-04-05', [
          mkStop('a', '09:00', null, 'A站'),
          mkStop('b', '09:00', 0, 'B站'),
          mkStop('c', '09:00', 60.5, 'C站'),
          mkStop('d', '09:00', MAX_STAY_MINUTES + 1, 'D站'),
          mkStop('e', '09:00', -10, 'E站'),
          mkStop('f', '09:00', 45, 'F站'),
        ]),
      ],
    })
    const result = tripToIcs(trip, { now: FIXED_NOW })
    expect(result.eventCount).toBe(6)
    expect(result.skippedCount).toBe(0)
    expect(result.missingDurationCount).toBe(5)
    expect(result.ics).not.toContain('DURATION:')

    const events = eventsBySummary(result.ics)
    for (const name of ['A站', 'B站', 'C站', 'D站', 'E站']) {
      const event = events.get(name)
      expect(event).toBeDefined()
      expect(event).toContain('DTSTART:20260405T090000')
      expect(event?.some((line) => line.startsWith('DTEND:'))).toBe(false)
      expect(event?.some((line) => line.startsWith('DURATION:'))).toBe(false)
    }

    const known = events.get('F站')
    expect(known).toContain('DTEND:20260405T094500')
    expect(splitIcsLines(result.ics).filter((line) => line.startsWith('DTEND:'))).toEqual([
      'DTEND:20260405T094500',
    ])

    const joined = result.notices.join('\n')
    expect(joined).toContain('有 5 个站点缺少有效的停留时长')
    expect(joined).toContain(String(MAX_STAY_MINUTES))
    expect(joined).toContain('没有写结束时间')
    expect(joined).toContain('默认时长显示')
    expect(joined).not.toContain('已按默认')
  })

  it('NaN/Infinity 等非法数值同样视为未知时长，不写 DTEND', () => {
    const result = tripToIcs(
      buildTrip({
        days: [
          mkDay(1, '2026-04-05', [
            mkStop('n1', '09:00', Number.NaN, 'NaN站'),
            mkStop('n2', '09:00', Number.POSITIVE_INFINITY, 'Infinity站'),
            mkStop('n3', '09:00', Number.NEGATIVE_INFINITY, '负Infinity站'),
          ]),
        ],
      }),
      { now: FIXED_NOW },
    )
    expect(result.eventCount).toBe(3)
    expect(result.missingDurationCount).toBe(3)
    expect(splitIcsLines(result.ics).some((line) => line.startsWith('DTEND:'))).toBe(false)
    expect(result.ics).not.toContain('DURATION:')
  })

  it('只统计已导出的缺失时长事件，被跳过的事件不计入', () => {
    const result = tripToIcs(
      buildTrip({
        days: [
          mkDay(1, '2026-04-05', [
            mkStop('ok', '09:00', null, '无时长站'),
            mkStop('bad', '25:00', null, '坏时刻站'),
          ]),
        ],
      }),
      { now: FIXED_NOW },
    )
    expect(result.eventCount).toBe(1)
    expect(result.skippedCount).toBe(1)
    expect(result.missingDurationCount).toBe(1)
    expect(result.ics.match(/^DTSTART:/gm)).toHaveLength(1)
    expect(result.ics).not.toContain('DTEND:')
  })

  it('跨午夜时长：23:30+90 分钟的 DTEND 落到第二天但不落错误日', () => {
    const result = tripToIcs(
      buildTrip({ days: [mkDay(1, '2026-04-05', [mkStop('n', '23:30', 90, '夜行')])] }),
      { now: FIXED_NOW },
    )
    expect(result.eventCount).toBe(1)
    expect(result.missingDurationCount).toBe(0)
    expect(result.ics).toContain('DTSTART:20260405T233000')
    expect(result.ics).toContain('DTEND:20260406T010000')
  })

  it('满 24 小时（MAX_STAY_MINUTES）合法：跨到且只跨到次日同时刻', () => {
    const result = tripToIcs(
      buildTrip({ days: [mkDay(1, '2026-04-05', [mkStop('w', '00:00', MAX_STAY_MINUTES, '全天')])] }),
      { now: FIXED_NOW },
    )
    expect(result.missingDurationCount).toBe(0)
    expect(result.ics).toContain('DTSTART:20260405T000000')
    expect(result.ics).toContain('DTEND:20260406T000000')
  })
})

describe('tripToIcs：事件字段的转义与折行', () => {
  it('标题/描述/地址里的分号、逗号、反斜杠与真实换行都被转义', () => {
    const result = tripToIcs(
      buildTrip({
        days: [
          mkDay(1, '2026-04-05', [
            mkStop('a', '09:00', 30, '分组;盒饭,刀\\叉', {
              description: '一\n二;第二段,半角',
              address: '路A;B',
            }),
          ]),
        ],
      }),
      { now: FIXED_NOW },
    )
    const logical = unfoldIcs(result.ics)
    expect(logical).toContain('SUMMARY:分组\\;盒饭\\,刀\\\\叉')
    expect(logical).toContain('DESCRIPTION:一\\n二\\;第二段\\,半角')
    expect(logical).toContain('LOCATION:路A\\;B')
  })

  it('恶意换行被转义：文件里不存在裸 LF/CR 或原始控制字符', () => {
    const result = tripToIcs(
      buildTrip({
        days: [
          mkDay(1, '2026-04-05', [
            mkStop('a', '09:00', 30, '名字\u0007带屑', { description: '行一\r\n行二\u001b' }),
          ]),
        ],
      }),
      { now: FIXED_NOW },
    )
    const withoutCrlf = result.ics.replace(/\r\n/g, '')
    expect(withoutCrlf).not.toContain('\n')
    expect(withoutCrlf).not.toContain('\r')
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/.test(withoutCrlf)).toBe(false)
  })

  it('长中文描述按 75 字节折行：每个物理行 ≤75 字节、展开后内容无损', () => {
    const description = '湖'.repeat(40) + '\n' + '柳'.repeat(40)
    const result = tripToIcs(
      buildTrip({
        source: 'example',
        days: [mkDay(1, '2026-04-05', [mkStop('a', '09:00', 90, '西湖', { description })])],
      }),
      { now: FIXED_NOW },
    )
    const logical = unfoldIcs(result.ics)
    expect(logical).toContain(`DESCRIPTION:${'湖'.repeat(40)}\\n${'柳'.repeat(40)}`)
    const physicalLines = splitIcsLines(result.ics)
    expect(physicalLines.length).toBeGreaterThan(result.eventCount + 6) // 确实发生了折叠
    for (const line of physicalLines) {
      expect(utf8ByteLen(line)).toBeLessThanOrEqual(75)
    }
  })
})

describe('tripToIcs：UID 稳定性与隐私', () => {
  const first = tripToIcs(MOCK_TRIP, { now: FIXED_NOW })

  it('UID 只含 16 位 hex + 固定域，行数与导出数一致且互不相同', () => {
    const uidList = icsUids(first.ics)
    expect(uidList).toHaveLength(3)
    for (const uid of uidList) {
      expect(uid).toMatch(/^[0-9a-f]{16}@travel-assistant\.local$/)
    }
    expect(new Set(uidList).size).toBe(3)
  })

  it('UID 不泄露站名/目的地等文本，只随行程 id、日期、开始时刻、站点 id 变化', () => {
    const uidList = icsUids(first.ics)
    expect(uidList.join('\n')).not.toMatch(/断桥|杭州|示例|白堤/)

    // 改目的地/标题/简介：UID 不变（这些文本不参与 UID）
    const renamed = tripToIcs(
      { ...MOCK_TRIP, destination: '苏州', title: '完全不同的标题', summary: '换掉的简介' },
      { now: FIXED_NOW },
    )
    expect(icsUids(renamed.ics)).toEqual(uidList)

    // 改日期：该日事件的 UID 改变
    const shifted = tripToIcs(
      {
        ...MOCK_TRIP,
        days: [
          { ...MOCK_TRIP.days[0], date: '2026-04-10' },
          MOCK_TRIP.days[1],
          MOCK_TRIP.days[2],
        ],
      },
      { now: FIXED_NOW },
    )
    const shiftedUids = icsUids(shifted.ics)
    expect(shifted.ics).toContain('DTSTART:20260410T090000')
    expect(shiftedUids[0]).not.toBe(uidList[0])
    expect(shiftedUids).toHaveLength(3)
  })

  it('时长缺失的 UID 稳定，补上已知时长后 UID 仍不变', () => {
    const missingTrip = buildTrip({
      days: [mkDay(1, '2026-04-05', [mkStop('u', '09:00', null, '未知时长')])],
    })
    const knownTrip = buildTrip({
      days: [mkDay(1, '2026-04-05', [mkStop('u', '09:00', 90, '未知时长')])],
    })
    const missing = tripToIcs(missingTrip, { now: FIXED_NOW })
    const known = tripToIcs(knownTrip, { now: FIXED_NOW })

    expect(missing.ics).not.toContain('DTEND:')
    expect(known.ics).toContain('DTEND:20260405T103000')
    expect(icsUids(missing.ics)).toEqual(icsUids(known.ics))
    expect(icsUids(missing.ics)[0]).toMatch(/^[0-9a-f]{16}@travel-assistant\.local$/)
    expect(tripToIcs(missingTrip, { now: FIXED_NOW }).ics).toBe(missing.ics)
  })

  it('重复 (日期, 开始时刻, stopId) 仍生成唯一 UID，且重复导出稳定', () => {
    const trip = buildTrip({
      days: [
        mkDay(1, '2026-04-05', [
          mkStop('dup', '09:00', null, '重复一'),
          mkStop('dup', '09:00', 90, '重复二'),
        ]),
      ],
    })
    const result = tripToIcs(trip, { now: FIXED_NOW })
    const uidList = icsUids(result.ics)
    expect(result.eventCount).toBe(2)
    expect(uidList).toHaveLength(2)
    expect(new Set(uidList).size).toBe(2)
    expect(tripToIcs(trip, { now: FIXED_NOW }).ics).toBe(result.ics)
  })
})

describe('tripToIcs：整份行程缺日期时由用户明确选择首日', () => {
  function undatedTrip(): Trip {
    return buildTrip({
      id: 'trip-no-dates',
      source: 'example',
      days: [
        mkDay(1, null, [mkStop('a', '09:00', 60, '甲站')]),
        mkDay(2, null, [mkStop('b', '10:00', null, '乙站')]),
        mkDay(3, null, [mkStop('c', '09:00', 120, '丙站')]),
      ],
    })
  }

  it('tripDateCoverage 只把「全部日期为空」标成需要首日；部分缺失不算', () => {
    const none = tripDateCoverage(undatedTrip())
    expect(none).toMatchObject({
      totalDays: 3,
      datedDays: 0,
      undatedDays: [1, 2, 3],
      allDatesMissing: true,
      hasInvalidDateText: false,
      needsFirstDate: true,
    })

    const partial = tripDateCoverage(MOCK_TRIP)
    expect(partial).toMatchObject({
      totalDays: 3,
      datedDays: 2,
      undatedDays: [3],
      allDatesMissing: false,
      needsFirstDate: false,
    })
  })

  it('按 day 编号推算临时日期：跨月、闰年都按真实日历计算，示例标识保留', () => {
    const result = tripToIcs(undatedTrip(), { now: FIXED_NOW, firstDate: '2028-02-27' })
    expect(result.firstDateUsed).toBe(true)
    expect(result.provisionalDates).toEqual([
      { day: 1, date: '2028-02-27' },
      { day: 2, date: '2028-02-28' },
      { day: 3, date: '2028-02-29' },
    ])
    const starts = splitIcsLines(result.ics).filter((line) => line.startsWith('DTSTART:'))
    expect(starts).toEqual([
      'DTSTART:20280227T090000',
      'DTSTART:20280228T100000',
      'DTSTART:20280229T090000',
    ])
    // 示例源标识仍然保留，临时日期不会把它变成「真实行程」
    const summaries = splitIcsLines(result.ics).filter((line) => line.startsWith('SUMMARY:'))
    expect(summaries.every((line) => line.startsWith('SUMMARY:【示例】'))).toBe(true)
    expect(result.notices.join('\n')).toContain('临时推算日期')
  })

  it('跨月与跨年：1 月 31 日 + 1 天、12 月 31 日 + 1 天都交给真实日历滚动', () => {
    const monthEdge = tripToIcs(
      buildTrip({
        days: [
          mkDay(1, null, [mkStop('m1', '09:00', null, '一月末')]),
          mkDay(2, null, [mkStop('m2', '09:00', null, '二月一')]),
        ],
      }),
      { now: FIXED_NOW, firstDate: '2026-01-31' },
    )
    expect(monthEdge.provisionalDates.map((item) => item.date)).toEqual(['2026-01-31', '2026-02-01'])

    const yearEdge = tripToIcs(
      buildTrip({
        days: [
          mkDay(1, null, [mkStop('y1', '09:00', null, '元旦前')]),
          mkDay(2, null, [mkStop('y2', '09:00', null, '元旦')]),
        ],
      }),
      { now: FIXED_NOW, firstDate: '2026-12-31' },
    )
    expect(yearEdge.provisionalDates.map((item) => item.date)).toEqual(['2026-12-31', '2027-01-01'])
  })

  it('没有选择首日时不推算、不导出任何事件，并明确提示先选首日', () => {
    const result = tripToIcs(undatedTrip(), { now: FIXED_NOW })
    expect(result.eventCount).toBe(0)
    expect(result.firstDateUsed).toBe(false)
    expect(result.provisionalDates).toEqual([])
    expect(result.skippedCount).toBe(3)
    expect(result.skipped.every((item) => item.reason === 'day_date_missing')).toBe(true)
    expect(result.skipped.every((item) => item.message.includes('请先选择行程首日'))).toBe(true)
    expect(result.ics).not.toContain('BEGIN:VEVENT')
    expect(result.notices.join('\n')).toContain('请先明确选择行程首日')
  })

  it('首日不是合法日期时忽略该参数，不生成事件', () => {
    const result = tripToIcs(undatedTrip(), { now: FIXED_NOW, firstDate: '2026-02-30' })
    expect(result.eventCount).toBe(0)
    expect(result.firstDateUsed).toBe(false)
    expect(result.provisionalDates).toEqual([])
    expect(result.notices.join('\n')).toContain('不是合法的 YYYY-MM-DD')
  })

  it('部分日期缺失时即使传首日也只跳过，已有真实日期不被覆盖', () => {
    const result = tripToIcs(MOCK_TRIP, { now: FIXED_NOW, firstDate: '2028-03-01' })
    expect(result.eventCount).toBe(3)
    expect(result.firstDateUsed).toBe(false)
    expect(result.provisionalDates).toEqual([])
    const starts = splitIcsLines(result.ics).filter((line) => line.startsWith('DTSTART:'))
    expect(starts).toEqual([
      'DTSTART:20260403T090000',
      'DTSTART:20260403T100000',
      'DTSTART:20260403T113000',
    ])
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].day).toBe(3)
    const joined = result.notices.join('\n')
    expect(joined).toContain('第 3 天没有可用的日期')
    expect(joined).toContain('选择的首日被忽略')
  })

  it('日期文本非空但非法时不算「全部缺失」，也不会被首日覆盖', () => {
    const trip = buildTrip({
      days: [
        mkDay(1, '2026-02-30', [mkStop('bad', '09:00', null, '假日期站')]),
        mkDay(2, null, [mkStop('blank', '09:00', null, '空日期站')]),
      ],
    })
    const coverage = tripDateCoverage(trip)
    expect(coverage.allDatesMissing).toBe(false)
    expect(coverage.needsFirstDate).toBe(false)
    expect(coverage.hasInvalidDateText).toBe(true)

    const result = tripToIcs(trip, { now: FIXED_NOW, firstDate: '2026-03-01' })
    expect(result.eventCount).toBe(0)
    expect(result.firstDateUsed).toBe(false)
    expect(result.skipped.map((item) => item.reason)).toEqual(['day_date_invalid', 'day_date_missing'])
  })

  it('临时日期只用于导出，不修改原行程对象', () => {
    const trip = undatedTrip()
    const snapshot = JSON.parse(JSON.stringify(trip))
    tripToIcs(trip, { now: FIXED_NOW, firstDate: '2026-12-30' })
    expect(trip).toEqual(snapshot)
  })
})

describe('tripToIcs：空导出与文件骨架', () => {
  it('全部站点不可用时仍输出合法的空 VCALENDAR，并明确说明', () => {
    const result = tripToIcs(MOCK_TRIP_NO_COORD, { now: FIXED_NOW })
    expect(result.eventCount).toBe(0)
    expect(result.skippedCount).toBe(1)
    expect(result.missingDurationCount).toBe(0)
    expect(result.skipped[0].reason).toBe('day_date_missing')
    expect(result.ics).toContain('BEGIN:VCALENDAR')
    expect(result.ics).toContain('END:VCALENDAR')
    expect(result.ics).not.toContain('BEGIN:VEVENT')
    expect(result.notices[0]).toContain('没有可导出')
    expect(result.ics.endsWith('\r\n')).toBe(true)
  })

  it('不虚构预约状态或时长：整个文件没有 STATUS/ORGANIZER/URL/DURATION 行', () => {
    expect(/^(STATUS|ORGANIZER|URL|DURATION):/m.test(firstTripIcs())).toBe(false)
  })
})

function firstTripIcs(): string {
  return tripToIcs(MOCK_TRIP, { now: FIXED_NOW }).ics
}

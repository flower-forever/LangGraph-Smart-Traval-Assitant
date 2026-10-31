import { describe, expect, it } from 'vitest'
import type { Trip, TripLeg, TripLocation } from '../lib/api'
import { MAX_TOTAL_GEOMETRY_POINTS } from '../lib/savedTrips'
import {
  MAX_TRIP_MARKDOWN_BYTES,
  TRIP_MARKDOWN_README_NOTE,
  TRIP_MARKDOWN_SHARE_NOTICE,
  safeTripMarkdownFilename,
  tripToMarkdown,
} from '../lib/tripMarkdown'
import { utf8ByteLength } from '../lib/savedTrips'
import { MOCK_TRIP } from './fixtures/trip'

function markdownOf(trip: Trip): string {
  const result = tripToMarkdown(trip)
  if (!result.ok) throw new Error(`生成失败：${result.reason} ${result.message}`)
  return result.markdown
}

function legWith(points: TripLocation[], overrides: Partial<TripLeg> = {}): TripLeg {
  return {
    from_stop_id: 's1',
    to_stop_id: 's2',
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 1100,
    duration_minutes: 16,
    geometry: points,
    description: '沿白堤步行。',
    ...overrides,
  }
}

describe('tripToMarkdown：基础投影', () => {
  it('投影标题、目的地、摘要、来源、天数与逐日结构', () => {
    const md = markdownOf(MOCK_TRIP)
    expect(md.startsWith('# 杭州三日漫步路书\n')).toBe(true)
    expect(md).toContain('- 目的地：杭州')
    expect(md).toContain('示例行程（记录自述 source=example）')
    expect(md).toContain('- 天数：3')
    expect(md).toContain('一条覆盖西湖、运河与龙井的慢节奏路线')
    expect(md).toContain('## 第 1 天（2026\\-04\\-03）')
    expect(md).toContain('## 第 2 天（2026\\-04\\-04）')
    expect(md).toContain('## 第 3 天（日期未提供）')
    expect(md).toContain('### 西湖环湖')
    expect(md).toContain('### 龙井问茶')
  })

  it('station 行按记录顺序展示时间 / 停留 / 地址 / 描述，坐标纯文本', () => {
    const md = markdownOf(MOCK_TRIP)
    expect(md).toContain('- 断桥残雪（09:00，停留 40 分钟）')
    // 数字里的点会被保守转义（\-  \. 均为合法 CommonMark 转义），渲染后仍是原字符
    expect(md).toContain('坐标：WGS84 经度 120\\.1576，纬度 30\\.2726')
    expect(md).toContain('描述：白堤东端，冬日雪后桥面半融半积，远望如断。')
    expect(md).toContain('- 湖滨晴雨（11:30，停留 未提供）')
    expect(md).toContain('坐标：未提供')
  })

  it('0 是合法记录值，不得当作缺失', () => {
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-zero',
      days: [
        {
          ...MOCK_TRIP.days[0],
          stops: [
            {
              ...MOCK_TRIP.days[0].stops[0],
              duration_minutes: 0,
            },
          ],
          legs: [
            legWith([], { distance_m: 0, duration_minutes: 0, route_type: 'straight_line' }),
          ],
        },
      ],
    }
    const md = markdownOf(trip)
    expect(md).toContain('停留 0 分钟')
    expect(md).toContain('记录距离：0 米')
    expect(md).toContain('记录耗时：0 分钟')
    expect(md).not.toContain('记录距离：未提供')
  })

  it('null 距离 / 耗时写未提供，路段缺失不合成', () => {
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-null-leg',
      days: [
        {
          ...MOCK_TRIP.days[0],
          legs: [legWith([], { distance_m: null, duration_minutes: null })],
        },
      ],
    }
    const md = markdownOf(trip)
    expect(md).toContain('记录距离：未提供')
    expect(md).toContain('记录耗时：未提供')
    expect(md).toContain('断桥残雪 → 平湖秋月')
  })

  it('leg 的 from/to 引用不到站点时如实标注，不猜名字', () => {
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-orphan-leg',
      days: [
        {
          ...MOCK_TRIP.days[0],
          legs: [legWith([], { from_stop_id: 'ghost-a', to_stop_id: 'ghost-b' })],
        },
      ],
    }
    const md = markdownOf(trip)
    expect(md).toContain('（记录里的站点 ID 未匹配到站点） → （记录里的站点 ID 未匹配到站点）')
  })

  it('三种 route_type 明确区分：直线不说导航，未知不说可达', () => {
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-route-types',
      days: [
        {
          ...MOCK_TRIP.days[0],
          legs: [
            legWith([], { route_type: 'navigation' }),
            legWith([], { route_type: 'straight_line' }),
            legWith([], { route_type: 'unavailable' }),
          ],
        },
      ],
    }
    const md = markdownOf(trip)
    expect(md).toContain('导航路线（按记录原样导出，本次未重新计算路线）')
    expect(md).toContain('示意直线（不是导航结果，无真实道路）')
    expect(md).toContain('路线不可用（本次没有可用的路线数据）')
    expect(md).toContain('方式：步行')
  })

  it('旧宽字段时间按记录值保留，不改成推断日期', () => {
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-wide-time',
      days: [
        {
          ...MOCK_TRIP.days[0],
          stops: [
            {
              ...MOCK_TRIP.days[0].stops[0],
              time: '9点刚过',
            },
          ],
          legs: [],
        },
      ],
    }
    const md = markdownOf(trip)
    expect(md).toContain('- 断桥残雪（9点刚过，停留 40 分钟）')
  })

  it('warnings 原样进入「记录内提示」小节', () => {
    const md = markdownOf(MOCK_TRIP)
    expect(md).toContain('## 记录内提示（warnings）')
    expect(md).toContain('- 示例数据仅用于演示界面，实际行程请以规划结果为准。')
  })

  it('结构字符被转义：日期与坐标数字都做保守转义', () => {
    const md = markdownOf(MOCK_TRIP)
    expect(md).toContain('## 第 1 天（2026\\-04\\-03）')
    expect(md).toContain('WGS84 经度 120\\.1576')
  })

  it('空日（无站点无路段）有明确说明', () => {
    const md = markdownOf(MOCK_TRIP)
    expect(md).toContain('（记录里这一天没有站点与路段。）')
  })

  it('重复名不同 id 的两个站点都按记录输出，不合并', () => {
    const base = MOCK_TRIP.days[0].stops[0]
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-dup-name',
      days: [
        {
          ...MOCK_TRIP.days[0],
          stops: [
            { ...base, id: 'dup-1', time: '09:00', description: '上午那趟。' },
            { ...base, id: 'dup-2', time: '18:00', description: '傍晚再访。' },
          ],
          legs: [],
        },
      ],
    }
    const md = markdownOf(trip)
    expect(md).toContain('- 断桥残雪（09:00，停留 40 分钟）')
    expect(md).toContain('- 断桥残雪（18:00，停留 40 分钟）')
    expect(md).toContain('上午那趟。')
    expect(md).toContain('傍晚再访。')
  })

  it('不输出 geometry 巨量点列', () => {
    const md = markdownOf(MOCK_TRIP)
    expect(md).not.toContain('120.1576,')
    expect(md).not.toContain('geometry')
    // 站点坐标只出现一次（纯文本），不逐点罗列路线
    expect(md.split('WGS84 经度 120\\.1576').length - 1).toBe(1)
  })

  it('同一 Trip 确定性输出：两次生成逐字节相同，不含导出时间', () => {
    const a = markdownOf(MOCK_TRIP)
    const b = markdownOf(MOCK_TRIP)
    expect(a).toBe(b)
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    expect(a).toContain(TRIP_MARKDOWN_README_NOTE)
  })
})

describe('tripToMarkdown：转义与信任边界', () => {
  it('中文、多行、Markdown 与 HTML 控制字符都被转义为纯文本', () => {
    const evil = '# 标题注入\n## 二级\n```code```\n[链接](https://example.com)\n![图片](https://example.com/x.png)\n| 表 | 格 |\n<script>alert(1)</script>\n<script>x</script>'
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-evil',
      title: evil,
      summary: evil,
      days: [
        {
          day: 1,
          date: null,
          title: evil,
          summary: evil,
          stops: [
            {
              id: 'e1',
              name: evil,
              time: '09:00',
              duration_minutes: null,
              description: evil,
              address: evil,
              location: null,
            },
          ],
          legs: [],
        },
      ],
    }
    const md = markdownOf(trip)
    // 行首结构字符全部带反斜杠转义或被折叠
    expect(md).not.toContain('\n# 标题注入')
    expect(md).not.toContain('\n## 二级')
    expect(md).not.toContain('```')
    expect(md).not.toContain('[链接]')
    expect(md).not.toContain('![图片]')
    expect(md).not.toContain('| 表 | 格 |')
    expect(md).not.toContain('<script>')
    expect(md).toContain('&lt;script&gt;')
    // HTML 结构不成为可执行结构：img/script 标签文本不再以 < 开头出现
    expect(md).not.toMatch(/<\s*(script|img|iframe)/i)
  })

  it('原始反斜杠被转义：恶意控制串与普通 Windows 路径都按纯文本表现', () => {
    const evil = '按\\*强调\\*解析\\n# 假标题'
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-backslash',
      title: evil,
      days: [
        {
          day: 1,
          date: null,
          title: evil,
          summary: '',
          stops: [
            {
              id: 'b1',
              name: 'C:\\Users\\测试\\笔记',
              time: '09:00',
              duration_minutes: null,
              description: evil,
              address: 'D:\\照片\\2026',
              location: null,
            },
          ],
          legs: [],
        },
      ],
    }
    const md = markdownOf(trip)
    // 每个原始反斜杠都成对出现（\\），不会有裸反斜杠把后续字符重新解成结构
    expect(md).toContain('C:\\\\Users\\\\测试\\\\笔记')
    expect(md).toContain('D:\\\\照片\\\\2026')
    expect(md).toContain('按\\\\\\*强调\\\\\\*解析')
    expect(md).not.toMatch(/(^|[^\\])\\\*/)
  })

  it('控制字符以可见 U+XXXX 记号无损保留，不静默删除；换行保留为硬换行', () => {
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-control',
      title: '第一行\n第二行\t制表',
      days: [
        {
          day: 1,
          date: null,
          title: '记录',
          summary: '含 NUL：\u0000 和 BEL：\u0007',
          stops: [],
          legs: [],
        },
      ],
    }
    const md = markdownOf(trip)
    expect(md).toContain('U+0000')
    expect(md).toContain('U+0007')
    expect(md).toContain('U+0009')
    // 换行不折叠：两行都保留（第二行随硬换行出现在下一行）
    expect(md).toContain('第一行  \n第二行')
    // 原文里的控制字符不再以原始字节形式出现
    expect(md).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/)
  })

  it('原记录里的营业 / 票价 / 天气说法原样输出，不删除也不新增', () => {
    const trip: Trip = {
      ...MOCK_TRIP,
      id: 'trip-business-claims',
      summary: '门票 80 元，8:30 开门，周末有雨请带伞，需要提前在公众号预约。',
      days: [
        {
          ...MOCK_TRIP.days[0],
          stops: [
            {
              ...MOCK_TRIP.days[0].stops[0],
              description: '现场购票 45 元，工作日 9:00 营业。',
            },
          ],
        },
      ],
    }
    const md = markdownOf(trip)
    expect(md).toContain('门票 80 元')
    expect(md).toContain('8:30 开门')
    expect(md).toContain('周末有雨请带伞')
    expect(md).toContain('需要提前在公众号预约')
    expect(md).toContain('现场购票 45 元')
    expect(md).toContain('工作日 9:00 营业')
    // 同时保留「导出不核实」的固定说明
    expect(md).toContain('都没有因导出而核实')
  })

  it('source 只作记录自述：不冒充真实模型来源', () => {
    const result = tripToMarkdown({ ...MOCK_TRIP, source: 'agent' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.markdown).toContain('生成行程（记录自述 source=agent）')
    expect(result.markdown).toContain('不能证明文件的真实生成方')
    // 分享提醒放在 notices（界面展示），不写进文件正文
    expect(result.notices).toContain(TRIP_MARKDOWN_SHARE_NOTICE)
    expect(result.markdown).not.toContain('不做脱敏')
  })

  it('未输出未知 extra 字段与凭据状对象', () => {
    const trip = {
      ...MOCK_TRIP,
      id: 'trip-extra',
      apiKey: 'sk-should-not-leak',
      secretToken: { value: 'leak-me' },
      days: [
        {
          ...MOCK_TRIP.days[0],
          extraNote: 'should-not-appear',
          stops: [{ ...MOCK_TRIP.days[0].stops[0], password: 'leak' } as never],
          legs: [],
        },
      ],
    } as unknown as Trip
    const md = markdownOf(trip)
    expect(md).not.toContain('sk-should-not-leak')
    expect(md).not.toContain('leak-me')
    expect(md).not.toContain('should-not-appear')
    expect(md).not.toContain('leak')
  })
})

describe('tripToMarkdown：fail-closed 与门禁', () => {
  it('非 TripLike 输入返回 invalid_trip 固定文案，不回显内容', () => {
    const result = tripToMarkdown(null as unknown as Trip)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid_trip')
      expect(result.message).not.toContain('null')
    }
  })

  it('结构非法（重复站点 ID）返回 invalid_trip', () => {
    const bad = {
      ...MOCK_TRIP,
      id: 'trip-dup-id',
      days: [
        {
          ...MOCK_TRIP.days[0],
          stops: [
            MOCK_TRIP.days[0].stops[0],
            { ...MOCK_TRIP.days[0].stops[0], time: '10:00' },
          ],
        },
      ],
    }
    const result = tripToMarkdown(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_trip')
  })

  it('深冻结输入不报错且不修改 Trip', () => {
    const deepFreeze = <T,>(value: T): T => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.values(value as Record<string, unknown>).forEach(deepFreeze)
        Object.freeze(value)
      }
      if (Array.isArray(value)) {
        value.forEach(deepFreeze)
        Object.freeze(value)
      }
      return value
    }
    const frozen = deepFreeze(JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip)
    const before = JSON.stringify(frozen)
    const result = tripToMarkdown(frozen)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(frozen)).toBe(before)
  })

  it('超过 UTF-8 字节上限返回 too_large 固定文案', () => {
    const result = tripToMarkdown(MOCK_TRIP, { maxBytes: 16 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('too_large')
      expect(result.message).toContain('超过')
      expect(result.message).not.toContain('杭州')
    }
  })

  it('非法 maxBytes 配置返回 bad_limit 固定文案，不伪装成行程非法', () => {
    const invalidLimits = [NaN, Infinity, -Infinity, 0, -1, 16.5 * 1024 * 1024]
    for (const maxBytes of invalidLimits) {
      const result = tripToMarkdown(MOCK_TRIP, { maxBytes })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('bad_limit')
        expect(result.message).toContain('上限不合法')
        expect(result.message).not.toContain('数据结构')
      }
    }
    // 收紧上限合法；等于上限也合法
    expect(tripToMarkdown(MOCK_TRIP, { maxBytes: MAX_TRIP_MARKDOWN_BYTES }).ok).toBe(true)
  })

  it('几何点预算超限的行程结构校验直接拒绝', () => {
    const points: TripLocation[] = Array.from(
      { length: MAX_TOTAL_GEOMETRY_POINTS + 1 },
      () => ({ lng: 120, lat: 30 }),
    )
    const huge: Trip = {
      ...MOCK_TRIP,
      id: 'trip-huge',
      days: [{ ...MOCK_TRIP.days[0], legs: [legWith(points)] }],
    }
    const result = tripToMarkdown(huge)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_trip')
  })

  it('正常输出的 UTF-8 字节数与实际内容一致', () => {
    const result = tripToMarkdown(MOCK_TRIP)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytes).toBe(utf8ByteLength(result.markdown))
      expect(result.bytes).toBeLessThanOrEqual(MAX_TRIP_MARKDOWN_BYTES)
      expect(result.notices).toContain(TRIP_MARKDOWN_SHARE_NOTICE)
    }
  })
})

describe('safeTripMarkdownFilename', () => {
  it('与 JSON 备份同名不同后缀', () => {
    expect(safeTripMarkdownFilename(MOCK_TRIP)).toBe('杭州-杭州三日漫步路书.md')
    expect(safeTripMarkdownFilename(MOCK_TRIP)).toBe(safeTripMarkdownFilename(MOCK_TRIP))
  })

  it('清洗非法字符，不产生路径跳转，保留 .md 后缀', () => {
    const name = safeTripMarkdownFilename({
      ...MOCK_TRIP,
      destination: '../../etc/杭州',
      title: '..A:*?"<>|B\u0000C',
    })
    expect(name.endsWith('.md')).toBe(true)
    expect(name).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/)
    expect(name.startsWith('.')).toBe(false)
  })

  it('空标题退到 trip.id，再退到 trip.md；Windows 保留名加前缀', () => {
    expect(safeTripMarkdownFilename({ ...MOCK_TRIP, destination: '', title: '' })).toBe(
      'trip-mock-1.md',
    )
    expect(safeTripMarkdownFilename({ ...MOCK_TRIP, destination: '', title: 'CON' })).toBe(
      'trip-CON.md',
    )
  })
})

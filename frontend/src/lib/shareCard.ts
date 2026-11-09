/**
 * 行程分享卡片（四期 S4）：数据管道 + 六个纯 SVG 模板。
 *
 * 边界：
 * - 只读 Trip / TripDay，不写任何存储、不发请求、不读来源文本。
 * - 输出只含：行程名、目的地、第 N 天、当日标题、日期、有序站名（含时间窗）、
 *   交通方式摘要、底部「由 旅行助手 生成」。不含坐标、门票价格、来源原文、
 *   任何存储键值，也不出现「已预订 / 已确认 / 已出票」。
 * - 同一输入两次 render 字符串全等：不使用 Date.now / Math.random / Intl。
 *   日期只做字符串展示，不做时区换算。
 * - 六个模板各自是纯函数，共享同一份 ShareCardData；配色/字体栈固定在
 *   本文件的 STYLE_TOKENS 常量里，不跟随 App 深浅主题。
 * - 字体全部使用系统字体栈；不同操作系统缺少某款字体时由下一档回退，
 *   跨平台渲染差异属于预期，不影响内容与确定性。
 * - 站名过长 / 站点过多时自动换行并逐级缩小字号与行距，不截断站名文字。
 */

import type { Trip, TripDay } from './api'
import { displayTime } from './format'

export type ShareCardStyle =
  | 'xuanzhi'
  | 'daily'
  | 'almanac'
  | 'riso'
  | 'midnight'
  | 'boarding'

export interface ShareCardData {
  tripTitle: string
  destination: string
  dayNumber: number
  dayTitle: string
  date: string | null
  stops: { name: string; time: string }[]
  transportSummary: string
}

export const SHARE_CARD_STYLES: ReadonlyArray<{
  id: ShareCardStyle
  label: string
  description: string
}> = [
  { id: 'xuanzhi', label: '宣纸雅集', description: '米白宣纸、朱砂点缀、楷体标题' },
  { id: 'daily', label: '旅行日报', description: '报纸分栏、宋体大标题、今日要闻' },
  { id: 'almanac', label: '老黄历', description: '日期大字、宜出行、朱红边框' },
  { id: 'riso', label: '双色印刷海报', description: '墨绿橘红撞色、粗黑站名、印刷噪点' },
  { id: 'midnight', label: '夜航卡', description: '深墨底、暖金细线、米白文字' },
  { id: 'boarding', label: '登机牌', description: '等宽数字、虚线撕裂线、打孔边' },
]

export const DEFAULT_SHARE_CARD_STYLE: ShareCardStyle = 'xuanzhi'

/* ────────────────────────────── 数据管道 ────────────────────────────── */

/** 交通摘要按固定顺序聚合：步行在前、驾车在后；只统计实际存在的 leg。 */
export function buildShareCardData(trip: Trip, day: TripDay): ShareCardData {
  let walking = 0
  let driving = 0
  for (const leg of day.legs) {
    if (leg.mode === 'walking') walking += 1
    else if (leg.mode === 'driving') driving += 1
  }
  const parts: string[] = []
  if (walking > 0) parts.push(`步行 ${walking} 段`)
  if (driving > 0) parts.push(`驾车 ${driving} 段`)

  return {
    tripTitle: trip.title,
    destination: trip.destination,
    dayNumber: day.day,
    dayTitle: day.title,
    date: day.date,
    stops: day.stops.map((stop) => {
      const rawTime = typeof stop.time === 'string' ? stop.time : ''
      const time = displayTime(rawTime).trim()
      return { name: stop.name, time: time === '' ? '时间未知' : time }
    }),
    transportSummary: parts.length > 0 ? parts.join(' · ') : '交通方式未知',
  }
}

/* ────────────────────────────── 通用工具 ────────────────────────────── */

/** XML 转义；同时移除 XML 1.0 不允许的控制字符，防止站名破坏 SVG。 */
function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 单行化：换行/制表折叠为空格，压缩连续空白。不改变用户可见字符顺序。 */
function normalizeInline(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 估算字符宽度（单位 em）：CJK/全角按 1，拉丁字母/数字按约 0.56。 */
function charUnits(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  if (code > 0x2e80) return 1
  if (ch === ' ') return 0.35
  if (ch >= 'A' && ch <= 'Z') return 0.66
  if (ch >= '0' && ch <= '9') return 0.56
  if (ch >= 'a' && ch <= 'z') return 0.56
  return 0.5
}

function textUnits(value: string): number {
  let units = 0
  for (const ch of value) units += charUnits(ch)
  return units
}

/**
 * 按 em 宽度确定性换行。优先在空格处断行；断行处保留空格，保证
 * 所有 tspan 的 textContent 拼接后仍是原文字符序列（不吞词、不截断）。
 */
function wrapText(value: string, maxEm: number): string[] {
  const text = normalizeInline(value)
  if (text === '') return ['']
  const limit = Math.max(1, maxEm)
  const lines: string[] = []
  let line = ''
  let units = 0

  for (const ch of text) {
    const width = charUnits(ch)
    if (units + width > limit && line !== '') {
      const breakAt = line.lastIndexOf(' ')
      if (breakAt > 0 && breakAt < line.length - 1) {
        lines.push(line.slice(0, breakAt + 1))
        line = line.slice(breakAt + 1)
        units = textUnits(line)
      } else {
        lines.push(line)
        line = ''
        units = 0
      }
      if (ch === ' ') continue
    }
    line += ch
    units += width
  }

  if (line !== '') lines.push(line)
  return lines.length > 0 ? lines : ['']
}

interface FittedText {
  fontSize: number
  lineHeight: number
  lines: string[]
  /** 文本块总高度（含行距，不含首行上方的空白） */
  height: number
}

/** 标题类自适应：先按最大字号换行，超出可用高度就逐级缩小，永不截断。 */
function fitText(
  value: string,
  options: {
    maxWidth: number
    maxFont: number
    minFont: number
    maxHeight: number
    lineHeightRatio?: number
  },
): FittedText {
  const ratio = options.lineHeightRatio ?? 1.16
  let fontSize = options.maxFont
  let lines = wrapText(value, options.maxWidth / fontSize)
  let lineHeight = fontSize * ratio

  while (lines.length * lineHeight > options.maxHeight && fontSize > options.minFont) {
    fontSize = Math.max(options.minFont, fontSize - 2)
    lines = wrapText(value, options.maxWidth / fontSize)
    lineHeight = fontSize * ratio
  }

  return { fontSize, lineHeight, lines, height: lines.length * lineHeight }
}

interface TextOptions {
  x: number
  y: number
  size: number
  fill: string
  font: string
  weight?: string | number
  anchor?: 'start' | 'middle' | 'end'
  spacing?: number
  opacity?: number
}

function textEl(content: string, options: TextOptions): string {
  const anchor = options.anchor ? ` text-anchor="${options.anchor}"` : ''
  const weight = options.weight !== undefined ? ` font-weight="${options.weight}"` : ''
  const spacing = options.spacing !== undefined ? ` letter-spacing="${options.spacing}"` : ''
  const opacity = options.opacity !== undefined ? ` opacity="${options.opacity}"` : ''
  return (
    `<text x="${options.x}" y="${options.y}" font-family="${options.font}"` +
    ` font-size="${options.size}" fill="${options.fill}"${weight}${anchor}${spacing}${opacity}>` +
    `${escapeXml(content)}</text>`
  )
}

function multilineText(
  lines: string[],
  options: TextOptions & { lineHeight: number },
): string {
  const anchor = options.anchor ? ` text-anchor="${options.anchor}"` : ''
  const weight = options.weight !== undefined ? ` font-weight="${options.weight}"` : ''
  const spacing = options.spacing !== undefined ? ` letter-spacing="${options.spacing}"` : ''
  const opacity = options.opacity !== undefined ? ` opacity="${options.opacity}"` : ''
  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? '' : ` dy="${options.lineHeight}"`
      return `<tspan x="${options.x}"${dy}>${escapeXml(line)}</tspan>`
    })
    .join('')
  return (
    `<text x="${options.x}" y="${options.y}" font-family="${options.font}"` +
    ` font-size="${options.size}" fill="${options.fill}"${weight}${anchor}${spacing}${opacity}>` +
    `${tspans}</text>`
  )
}

/** 日期只做字符串展示：合法 YYYY-MM-DD 原样使用，缺失显示「日期未知」。 */
function dateLabel(value: string | null): string {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? '日期未知' : trimmed
}

function parseDateParts(value: string | null): { year: string; month: string; day: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '')
  if (!match) return null
  return { year: match[1], month: match[2], day: match[3] }
}

const EMPTY_STOPS = '本日暂无站点'

/* ────────────────────────────── 站点列表布局 ────────────────────────────── */

interface StopEntryLayout {
  time: string
  nameLines: string[]
  /** 相对列表顶部的偏移（px） */
  top: number
}

interface StopListLayout {
  fontSize: number
  lineHeight: number
  gap: number
  timeWidth: number
  entries: StopEntryLayout[]
  height: number
}

function layoutStops(
  stops: ShareCardData['stops'],
  options: {
    width: number
    maxHeight: number
    maxFont: number
    minFont: number
    timeWidthEm?: number
    lineHeightRatio?: number
    gapEm?: number
  },
): StopListLayout {
  const timeWidthEm = options.timeWidthEm ?? 3.5
  const lineHeightRatio = options.lineHeightRatio ?? 1.45
  const gapEm = options.gapEm ?? 0.55
  const available = Math.max(120, options.maxHeight)

  const build = (fontSize: number): StopListLayout => {
    const timeWidth = fontSize * timeWidthEm
    const nameWidthEm = Math.max(2, (options.width - timeWidth) / fontSize)
    const lineHeight = fontSize * lineHeightRatio
    const gap = fontSize * gapEm
    let top = 0
    const entries = stops.map((stop) => {
      const nameLines = wrapText(stop.name === '' ? '名称未知' : stop.name, nameWidthEm)
      const entry: StopEntryLayout = { time: stop.time, nameLines, top }
      top += Math.max(1, nameLines.length) * lineHeight + gap
      return entry
    })
    return {
      fontSize,
      lineHeight,
      gap,
      timeWidth,
      entries,
      height: Math.max(0, top - gap),
    }
  }

  let fontSize = options.maxFont
  let layout = build(fontSize)
  while (layout.height > available && fontSize > options.minFont) {
    fontSize = Math.max(options.minFont, fontSize - 2)
    layout = build(fontSize)
  }
  return layout
}

function renderStopList(
  layout: StopListLayout,
  options: {
    x: number
    y: number
    timeFill: string
    nameFill: string
    timeFont: string
    nameFont: string
    timeSizeRatio?: number
    nameWeight?: string | number
    timeOpacity?: number
    nameOpacity?: number
    index?: { x: number; fill: string; font: string; sizeRatio: number }
  },
): string {
  const timeSizeRatio = options.timeSizeRatio ?? 0.64
  const parts: string[] = []
  for (let index = 0; index < layout.entries.length; index += 1) {
    const entry = layout.entries[index]
    const baseline = options.y + entry.top + layout.fontSize * 0.8
    if (options.index) {
      parts.push(
        textEl(String(index + 1).padStart(2, '0'), {
          x: options.index.x,
          y: baseline,
          size: layout.fontSize * options.index.sizeRatio,
          fill: options.index.fill,
          font: options.index.font,
          weight: 700,
        }),
      )
    }
    parts.push(
      textEl(entry.time, {
        x: options.x,
        y: baseline,
        size: layout.fontSize * timeSizeRatio,
        fill: options.timeFill,
        font: options.timeFont,
        opacity: options.timeOpacity,
      }),
    )
    const nameX = options.x + layout.timeWidth
    const tspans = entry.nameLines
      .map((line, lineIndex) => {
        const dy = lineIndex === 0 ? '' : ` dy="${layout.lineHeight}"`
        return `<tspan x="${nameX}"${dy}>${escapeXml(line)}</tspan>`
      })
      .join('')
    parts.push(
      `<text x="${nameX}" y="${baseline}" font-family="${options.nameFont}"` +
        ` font-size="${layout.fontSize}" fill="${options.nameFill}"` +
        `${options.nameWeight !== undefined ? ` font-weight="${options.nameWeight}"` : ''}` +
        `${options.nameOpacity !== undefined ? ` opacity="${options.nameOpacity}"` : ''}>` +
        `${tspans}</text>`,
    )
  }
  return parts.join('')
}

/* ────────────────────────────── 风格 token ────────────────────────────── */

interface StyleTokens {
  background: string
  paper: string
  ink: string
  muted: string
  accent: string
  accent2: string
  titleFont: string
  bodyFont: string
  monoFont: string
}

const SERIF = "'Songti SC','SimSun','Noto Serif SC','Source Han Serif SC',serif"
const KAI = "'KaiTi','STKaiti','Kaiti SC','Noto Serif SC',serif"
const SANS = "'Microsoft YaHei','PingFang SC','Noto Sans SC','Hiragino Sans GB',sans-serif"
const HEAVY = "'Arial Black','Microsoft YaHei','PingFang SC','Noto Sans SC',sans-serif"
const MONO = "'Cascadia Mono','Consolas','SFMono-Regular','Menlo',monospace"

/**
 * 六风格固定 token（hex + 字体栈），刻意不引用 theme.css：
 * 分享卡片无论 App 处于浅色还是深色，导出/预览颜色都保持一致。
 */
const STYLE_TOKENS: Record<ShareCardStyle, StyleTokens> = {
  xuanzhi: {
    background: '#F5EFE1',
    paper: '#FBF6E9',
    ink: '#2B2620',
    muted: '#7A6F60',
    accent: '#B03A2E',
    accent2: '#C99A3C',
    titleFont: KAI,
    bodyFont: KAI,
    monoFont: MONO,
  },
  daily: {
    background: '#F2EFE6',
    paper: '#FAF8F1',
    ink: '#191919',
    muted: '#5B5852',
    accent: '#8E1B16',
    accent2: '#2F2F2F',
    titleFont: SERIF,
    bodyFont: SERIF,
    monoFont: MONO,
  },
  almanac: {
    background: '#F3E3BC',
    paper: '#FBF0D2',
    ink: '#3A2A18',
    muted: '#7A5C36',
    accent: '#B23B2C',
    accent2: '#C99A3C',
    titleFont: SERIF,
    bodyFont: SERIF,
    monoFont: MONO,
  },
  riso: {
    background: '#F2E7CF',
    paper: '#F7F0DE',
    ink: '#101010',
    muted: '#456052',
    accent: '#0E3B2E',
    accent2: '#E4572E',
    titleFont: HEAVY,
    bodyFont: SANS,
    monoFont: MONO,
  },
  midnight: {
    background: '#0A111F',
    paper: '#111B2E',
    ink: '#F2EAD8',
    muted: '#8E97A8',
    accent: '#D9B36C',
    accent2: '#6E7FA3',
    titleFont: SERIF,
    bodyFont: SANS,
    monoFont: MONO,
  },
  boarding: {
    background: '#E9EFEC',
    paper: '#F7FAF8',
    ink: '#16211F',
    muted: '#5A6B66',
    accent: '#0F766E',
    accent2: '#C2410C',
    titleFont: SANS,
    bodyFont: SANS,
    monoFont: MONO,
  },
}

/* ────────────────────────────── 模板 1 · 宣纸雅集 ────────────────────────────── */

function renderXuanzhi(data: ShareCardData): string {
  const c = STYLE_TOKENS.xuanzhi
  const parts: string[] = []

  parts.push(`<rect width="1080" height="1440" fill="${c.background}"/>`)
  // 固定位置的纸纤维横纹，不随数据变化
  parts.push(
    `<g stroke="${c.ink}" stroke-opacity="0.045" stroke-width="1">` +
      [110, 210, 310, 410, 510, 610, 710, 810, 910, 1010, 1110, 1210, 1310]
        .map((y) => `<line x1="54" y1="${y}" x2="1026" y2="${y}"/>`)
        .join('') +
      `</g>`,
  )
  parts.push(`<rect x="36" y="36" width="1008" height="1368" fill="none" stroke="${c.accent}" stroke-width="2"/>`)
  parts.push(
    `<rect x="48" y="48" width="984" height="1344" fill="none" stroke="${c.accent}"` +
      ` stroke-opacity="0.45" stroke-width="0.8"/>`,
  )
  // 朱砂闲章
  parts.push(`<rect x="876" y="96" width="104" height="104" rx="6" fill="${c.accent}"/>`)
  parts.push(
    textEl('行', {
      x: 928,
      y: 168,
      size: 56,
      fill: c.paper,
      font: c.titleFont,
      anchor: 'middle',
    }),
  )

  parts.push(
    textEl(`行旅 · ${data.destination}`, {
      x: 96,
      y: 132,
      size: 24,
      fill: c.accent,
      font: c.bodyFont,
      spacing: 7,
    }),
  )

  const title = fitText(data.tripTitle, {
    maxWidth: 760,
    maxFont: 64,
    minFont: 40,
    maxHeight: 230,
    lineHeightRatio: 1.16,
  })
  const titleTop = 244
  parts.push(
    multilineText(title.lines, {
      x: 96,
      y: titleTop,
      size: title.fontSize,
      fill: c.ink,
      font: c.titleFont,
      lineHeight: title.lineHeight,
      weight: 700,
    }),
  )
  const titleBottom = titleTop + (title.lines.length - 1) * title.lineHeight

  const metaY = titleBottom + 62
  parts.push(
    textEl(`第 ${data.dayNumber} 天`, {
      x: 96,
      y: metaY,
      size: 30,
      fill: c.accent,
      font: c.bodyFont,
      weight: 700,
      spacing: 2,
    }),
  )
  const dayTitle = fitText(data.dayTitle, {
    maxWidth: 560,
    maxFont: 30,
    minFont: 20,
    maxHeight: 80,
    lineHeightRatio: 1.35,
  })
  parts.push(
    multilineText(dayTitle.lines, {
      x: 244,
      y: metaY,
      size: dayTitle.fontSize,
      fill: c.ink,
      font: c.bodyFont,
      lineHeight: dayTitle.lineHeight,
      opacity: 0.86,
    }),
  )
  parts.push(
    textEl(dateLabel(data.date), {
      x: 984,
      y: metaY,
      size: 24,
      fill: c.muted,
      font: c.monoFont,
      anchor: 'end',
      spacing: 1,
    }),
  )

  const listTop = Math.max(metaY + 92, 430)
  const transportRuleY = 1178
  const listMax = Math.max(150, transportRuleY - 36 - listTop)
  parts.push(`<line x1="96" y1="${listTop - 44}" x2="984" y2="${listTop - 44}" stroke="${c.accent}" stroke-opacity="0.35"/>`)
  parts.push(
    textEl('行程', {
      x: 96,
      y: listTop - 60,
      size: 22,
      fill: c.accent,
      font: c.bodyFont,
      spacing: 8,
    }),
  )

  if (data.stops.length === 0) {
    parts.push(
      textEl(EMPTY_STOPS, {
        x: 96,
        y: listTop + 44,
        size: 30,
        fill: c.muted,
        font: c.bodyFont,
      }),
    )
  } else {
    const layout = layoutStops(data.stops, {
      width: 888,
      maxHeight: listMax,
      maxFont: 42,
      minFont: 16,
      timeWidthEm: 3.6,
    })
    parts.push(
      renderStopList(layout, {
        x: 96,
        y: listTop,
        timeFill: c.accent,
        nameFill: c.ink,
        timeFont: c.monoFont,
        nameFont: c.bodyFont,
        timeSizeRatio: 0.6,
      }),
    )
  }

  parts.push(`<line x1="96" y1="${transportRuleY}" x2="984" y2="${transportRuleY}" stroke="${c.accent}" stroke-opacity="0.35"/>`)
  parts.push(
    textEl('交通', {
      x: 96,
      y: transportRuleY + 48,
      size: 24,
      fill: c.accent,
      font: c.bodyFont,
      spacing: 6,
    }),
  )
  parts.push(
    textEl(data.transportSummary, {
      x: 196,
      y: transportRuleY + 48,
      size: 30,
      fill: c.ink,
      font: c.bodyFont,
    }),
  )

  parts.push(
    textEl('由 旅行助手 生成', {
      x: 540,
      y: 1342,
      size: 22,
      fill: c.muted,
      font: c.bodyFont,
      anchor: 'middle',
      spacing: 5,
    }),
  )
  parts.push(
    textEl('XUAN ZHI · TRAVEL NOTE', {
      x: 540,
      y: 1382,
      size: 13,
      fill: c.muted,
      font: c.monoFont,
      anchor: 'middle',
      spacing: 5,
      opacity: 0.65,
    }),
  )

  return parts.join('')
}

/* ────────────────────────────── 模板 2 · 旅行日报 ────────────────────────────── */

function renderDaily(data: ShareCardData): string {
  const c = STYLE_TOKENS.daily
  const parts: string[] = []

  parts.push(`<rect width="1080" height="1440" fill="${c.background}"/>`)
  parts.push(`<line x1="54" y1="56" x2="1026" y2="56" stroke="${c.ink}" stroke-width="3"/>`)
  parts.push(`<line x1="54" y1="66" x2="1026" y2="66" stroke="${c.ink}" stroke-width="1"/>`)
  parts.push(
    textEl('TRAVEL DAILY', {
      x: 56,
      y: 104,
      size: 20,
      fill: c.ink,
      font: c.monoFont,
      spacing: 4,
    }),
  )
  parts.push(
    textEl(`第 ${data.dayNumber} 天 · ${dateLabel(data.date)}`, {
      x: 1024,
      y: 104,
      size: 19,
      fill: c.muted,
      font: c.monoFont,
      anchor: 'end',
      spacing: 1,
    }),
  )
  parts.push(
    textEl('旅行日报', {
      x: 54,
      y: 204,
      size: 96,
      fill: c.ink,
      font: c.titleFont,
      weight: 700,
      spacing: 10,
    }),
  )
  parts.push(`<line x1="54" y1="226" x2="1026" y2="226" stroke="${c.accent}" stroke-width="3"/>`)

  const title = fitText(data.tripTitle, {
    maxWidth: 940,
    maxFont: 58,
    minFont: 36,
    maxHeight: 170,
    lineHeightRatio: 1.16,
  })
  const titleTop = 306
  parts.push(
    multilineText(title.lines, {
      x: 54,
      y: titleTop,
      size: title.fontSize,
      fill: c.ink,
      font: c.titleFont,
      lineHeight: title.lineHeight,
      weight: 700,
    }),
  )
  const titleBottom = titleTop + (title.lines.length - 1) * title.lineHeight

  const deckY = titleBottom + 52
  const deck = fitText(data.dayTitle, {
    maxWidth: 940,
    maxFont: 28,
    minFont: 18,
    maxHeight: 84,
    lineHeightRatio: 1.4,
  })
  parts.push(
    multilineText(deck.lines, {
      x: 54,
      y: deckY,
      size: deck.fontSize,
      fill: c.muted,
      font: c.bodyFont,
      lineHeight: deck.lineHeight,
    }),
  )
  const deckBottom = deckY + (deck.lines.length - 1) * deck.lineHeight
  const ruleY = deckBottom + 40
  parts.push(`<line x1="54" y1="${ruleY}" x2="1026" y2="${ruleY}" stroke="${c.ink}" stroke-width="1"/>`)

  const listTop = ruleY + 62
  const listMax = Math.max(180, 1200 - listTop)
  const columnX = 700
  parts.push(
    textEl('今日要闻 / ITINERARY', {
      x: 54,
      y: listTop - 24,
      size: 18,
      fill: c.accent,
      font: c.monoFont,
      spacing: 3,
      weight: 700,
    }),
  )
  parts.push(`<line x1="${columnX}" y1="${listTop - 30}" x2="${columnX}" y2="1210" stroke="${c.ink}" stroke-opacity="0.45"/>`)

  if (data.stops.length === 0) {
    parts.push(
      textEl(EMPTY_STOPS, {
        x: 54,
        y: listTop + 40,
        size: 28,
        fill: c.muted,
        font: c.bodyFont,
      }),
    )
  } else {
    const layout = layoutStops(data.stops, {
      width: 600,
      maxHeight: listMax,
      maxFont: 34,
      minFont: 15,
      timeWidthEm: 3.3,
    })
    parts.push(
      renderStopList(layout, {
        x: 54,
        y: listTop,
        timeFill: c.accent,
        nameFill: c.ink,
        timeFont: c.monoFont,
        nameFont: c.bodyFont,
        timeSizeRatio: 0.62,
        nameWeight: 600,
      }),
    )
  }

  const sideX = columnX + 40
  parts.push(
    textEl(`第 ${data.dayNumber} 天`, {
      x: sideX,
      y: listTop + 34,
      size: 58,
      fill: c.ink,
      font: c.titleFont,
      weight: 700,
    }),
  )
  parts.push(
    textEl(dateLabel(data.date), {
      x: sideX,
      y: listTop + 78,
      size: 19,
      fill: c.muted,
      font: c.monoFont,
      spacing: 1,
    }),
  )
  parts.push(`<line x1="${sideX}" y1="${listTop + 106}" x2="1024" y2="${listTop + 106}" stroke="${c.ink}" stroke-opacity="0.4"/>`)

  const destination = fitText(data.destination, {
    maxWidth: 264,
    maxFont: 32,
    minFont: 20,
    maxHeight: 100,
    lineHeightRatio: 1.3,
  })
  parts.push(
    textEl('目的地', {
      x: sideX,
      y: listTop + 148,
      size: 16,
      fill: c.accent,
      font: c.monoFont,
      spacing: 4,
    }),
  )
  parts.push(
    multilineText(destination.lines, {
      x: sideX,
      y: listTop + 190,
      size: destination.fontSize,
      fill: c.ink,
      font: c.titleFont,
      lineHeight: destination.lineHeight,
      weight: 700,
    }),
  )

  parts.push(
    textEl('交通摘要', {
      x: sideX,
      y: listTop + 330,
      size: 16,
      fill: c.accent,
      font: c.monoFont,
      spacing: 4,
    }),
  )
  const summary = wrapText(data.transportSummary, 240 / 22)
  parts.push(
    multilineText(summary, {
      x: sideX,
      y: listTop + 370,
      size: 22,
      fill: c.ink,
      font: c.bodyFont,
      lineHeight: 30,
    }),
  )

  parts.push(
    textEl('SHARE EDITION', {
      x: sideX,
      y: 1150,
      size: 15,
      fill: c.muted,
      font: c.monoFont,
      spacing: 3,
      opacity: 0.8,
    }),
  )
  parts.push(
    textEl('由 旅行助手 生成', {
      x: 540,
      y: 1342,
      size: 21,
      fill: c.muted,
      font: c.bodyFont,
      anchor: 'middle',
      spacing: 4,
    }),
  )

  return parts.join('')
}

/* ────────────────────────────── 模板 3 · 老黄历 ────────────────────────────── */

function renderAlmanac(data: ShareCardData): string {
  const c = STYLE_TOKENS.almanac
  const parts: string[] = []
  const date = parseDateParts(data.date)

  parts.push(`<rect width="1080" height="1440" fill="${c.background}"/>`)
  parts.push(`<rect x="28" y="28" width="1024" height="1384" fill="none" stroke="${c.accent}" stroke-width="4"/>`)
  parts.push(`<rect x="42" y="42" width="996" height="1356" fill="none" stroke="${c.accent}" stroke-opacity="0.45"/>`)

  parts.push(
    textEl('老 黄 历', {
      x: 540,
      y: 104,
      size: 46,
      fill: c.accent,
      font: c.titleFont,
      anchor: 'middle',
      weight: 700,
      spacing: 8,
    }),
  )
  parts.push(
    textEl(data.tripTitle, {
      x: 540,
      y: 152,
      size: 24,
      fill: c.ink,
      font: c.bodyFont,
      anchor: 'middle',
      opacity: 0.88,
    }),
  )

  if (date) {
    parts.push(
      textEl(`${date.year} · ${date.month}`, {
        x: 540,
        y: 214,
        size: 30,
        fill: c.muted,
        font: c.monoFont,
        anchor: 'middle',
        spacing: 6,
      }),
    )
    parts.push(
      textEl(date.day, {
        x: 540,
        y: 382,
        size: 178,
        fill: c.accent,
        font: c.titleFont,
        anchor: 'middle',
        weight: 700,
      }),
    )
    parts.push(
      textEl(dateLabel(data.date), {
        x: 540,
        y: 440,
        size: 28,
        fill: c.ink,
        font: c.monoFont,
        anchor: 'middle',
        spacing: 2,
      }),
    )
  } else {
    parts.push(
      textEl('日期未知', {
        x: 540,
        y: 340,
        size: 88,
        fill: c.accent,
        font: c.titleFont,
        anchor: 'middle',
        weight: 700,
        spacing: 8,
      }),
    )
  }

  parts.push(`<rect x="336" y="472" width="408" height="78" rx="8" fill="${c.paper}" stroke="${c.accent}" stroke-width="3"/>`)
  parts.push(
    textEl('宜：出行', {
      x: 540,
      y: 525,
      size: 38,
      fill: c.accent,
      font: c.titleFont,
      anchor: 'middle',
      weight: 700,
      spacing: 5,
    }),
  )
  parts.push(
    textEl('忌：犹豫', {
      x: 540,
      y: 586,
      size: 20,
      fill: c.muted,
      font: c.bodyFont,
      anchor: 'middle',
      spacing: 4,
    }),
  )

  const dayLine = fitText(`第 ${data.dayNumber} 天 · ${data.dayTitle}`, {
    maxWidth: 760,
    maxFont: 32,
    minFont: 20,
    maxHeight: 80,
    lineHeightRatio: 1.35,
  })
  parts.push(
    multilineText(dayLine.lines, {
      x: 540,
      y: 640,
      size: dayLine.fontSize,
      fill: c.ink,
      font: c.titleFont,
      lineHeight: dayLine.lineHeight,
      anchor: 'middle',
      weight: 700,
    }),
  )
  const dayBottom = 640 + (dayLine.lines.length - 1) * dayLine.lineHeight

  const listTop = Math.max(dayBottom + 52, 700)
  const transportY = 1252
  const listMax = Math.max(140, transportY - 62 - listTop)
  parts.push(`<line x1="150" y1="${listTop - 30}" x2="930" y2="${listTop - 30}" stroke="${c.accent}" stroke-opacity="0.4"/>`)

  if (data.stops.length === 0) {
    parts.push(
      textEl(EMPTY_STOPS, {
        x: 540,
        y: listTop + 42,
        size: 30,
        fill: c.muted,
        font: c.bodyFont,
        anchor: 'middle',
      }),
    )
  } else {
    const layout = layoutStops(data.stops, {
      width: 780,
      maxHeight: listMax,
      maxFont: 36,
      minFont: 15,
      timeWidthEm: 3.5,
    })
    parts.push(
      renderStopList(layout, {
        x: 150,
        y: listTop,
        timeFill: c.accent,
        nameFill: c.ink,
        timeFont: c.monoFont,
        nameFont: c.bodyFont,
        timeSizeRatio: 0.6,
      }),
    )
  }

  parts.push(`<line x1="150" y1="${transportY - 42}" x2="930" y2="${transportY - 42}" stroke="${c.accent}" stroke-opacity="0.4"/>`)
  parts.push(
    textEl(`出行：${data.transportSummary}`, {
      x: 540,
      y: transportY,
      size: 28,
      fill: c.ink,
      font: c.bodyFont,
      anchor: 'middle',
      spacing: 1,
    }),
  )
  parts.push(
    textEl('由 旅行助手 生成', {
      x: 540,
      y: 1344,
      size: 21,
      fill: c.muted,
      font: c.bodyFont,
      anchor: 'middle',
      spacing: 4,
    }),
  )

  return parts.join('')
}

/* ────────────────────────────── 模板 4 · 双色印刷海报 ────────────────────────────── */

function barcode(seed: string, width: number, height: number): string {
  let state = 7
  for (const ch of seed) state = (state * 48271 + (ch.codePointAt(0) ?? 0)) % 2147483647
  const bars: string[] = []
  let x = 0
  let index = 0
  while (x < width && index < 40) {
    state = (state * 48271) % 2147483647
    const barWidth = 2 + (state % 5)
    state = (state * 48271) % 2147483647
    const gap = 2 + (state % 5)
    if (index % 2 === 0) {
      bars.push(`<rect x="${x}" y="0" width="${barWidth}" height="${height}" fill="#16211F"/>`)
    }
    x += barWidth + gap
    index += 1
  }
  return bars.join('')
}

function renderRiso(data: ShareCardData): string {
  const c = STYLE_TOKENS.riso
  const parts: string[] = []

  parts.push(`<rect width="1080" height="1440" fill="${c.background}"/>`)
  parts.push(`<rect width="1080" height="330" fill="${c.accent}"/>`)
  parts.push(`<circle cx="930" cy="164" r="126" fill="${c.accent2}"/>`)
  parts.push(`<rect y="330" width="1080" height="16" fill="${c.accent2}"/>`)
  parts.push(
    textEl('RISOGRAPH / TRAVEL', {
      x: 66,
      y: 88,
      size: 20,
      fill: c.accent2,
      font: c.monoFont,
      spacing: 4,
      weight: 700,
    }),
  )

  const title = fitText(data.tripTitle, {
    maxWidth: 740,
    maxFont: 78,
    minFont: 44,
    maxHeight: 170,
    lineHeightRatio: 1.08,
  })
  parts.push(
    multilineText(title.lines, {
      x: 66,
      y: 196,
      size: title.fontSize,
      fill: c.paper,
      font: c.titleFont,
      lineHeight: title.lineHeight,
      weight: 900,
    }),
  )
  const titleBottom = 196 + (title.lines.length - 1) * title.lineHeight
  parts.push(
    textEl(`第 ${data.dayNumber} 天`, {
      x: 66,
      y: Math.min(302, titleBottom + 62),
      size: 26,
      fill: c.accent2,
      font: c.monoFont,
      weight: 700,
      spacing: 4,
    }),
  )

  const dayTitle = fitText(data.dayTitle, {
    maxWidth: 900,
    maxFont: 34,
    minFont: 20,
    maxHeight: 76,
    lineHeightRatio: 1.3,
  })
  parts.push(
    multilineText(dayTitle.lines, {
      x: 66,
      y: 400,
      size: dayTitle.fontSize,
      fill: c.accent,
      font: c.titleFont,
      lineHeight: dayTitle.lineHeight,
      weight: 700,
    }),
  )
  const dayBottom = 400 + (dayTitle.lines.length - 1) * dayTitle.lineHeight
  parts.push(
    textEl(dateLabel(data.date), {
      x: 1014,
      y: 400,
      size: 24,
      fill: c.ink,
      font: c.monoFont,
      anchor: 'end',
      spacing: 2,
    }),
  )
  const ruleY = dayBottom + 30
  parts.push(`<line x1="66" y1="${ruleY}" x2="1014" y2="${ruleY}" stroke="${c.accent}" stroke-width="5"/>`)

  const listTop = ruleY + 58
  const listMax = Math.max(160, 1150 - listTop)
  if (data.stops.length === 0) {
    parts.push(
      textEl(EMPTY_STOPS, {
        x: 100,
        y: listTop + 40,
        size: 34,
        fill: c.muted,
        font: c.bodyFont,
      }),
    )
  } else {
    const layout = layoutStops(data.stops, {
      width: 800,
      maxHeight: listMax,
      maxFont: 46,
      minFont: 16,
      timeWidthEm: 3.4,
      lineHeightRatio: 1.35,
    })
    parts.push(
      renderStopList(layout, {
        x: 200,
        y: listTop,
        timeFill: c.accent,
        nameFill: c.ink,
        timeFont: c.monoFont,
        nameFont: c.titleFont,
        timeSizeRatio: 0.55,
        nameWeight: 900,
        index: { x: 96, fill: c.accent2, font: c.monoFont, sizeRatio: 0.72 },
      }),
    )
  }

  // 固定点阵噪点：同一输入字符串固定，不使用随机数
  parts.push(
    `<defs><pattern id="riso-noise" width="18" height="18" patternUnits="userSpaceOnUse">` +
      `<circle cx="4" cy="4" r="1.4" fill="${c.accent}" opacity="0.12"/>` +
      `<circle cx="13" cy="12" r="1" fill="${c.accent2}" opacity="0.1"/>` +
      `</pattern></defs>`,
  )
  parts.push(`<rect width="1080" height="1440" fill="url(#riso-noise)"/>`)

  parts.push(`<rect y="1186" width="1080" height="92" fill="${c.accent}"/>`)
  parts.push(
    textEl(`交通 · ${data.transportSummary}`, {
      x: 66,
      y: 1243,
      size: 28,
      fill: c.paper,
      font: c.bodyFont,
      weight: 700,
      spacing: 1,
    }),
  )
  parts.push(
    textEl('由 旅行助手 生成', {
      x: 540,
      y: 1338,
      size: 22,
      fill: c.accent,
      font: c.bodyFont,
      anchor: 'middle',
      weight: 700,
      spacing: 4,
    }),
  )

  return parts.join('')
}

/* ────────────────────────────── 模板 5 · 夜航卡 ────────────────────────────── */

const MIDNIGHT_STARS = Array.from({ length: 46 }, (_, index) => ({
  x: 36 + ((index * 197) % 1000),
  y: 76 + ((index * 331) % 1260),
  r: index % 7 === 0 ? 2.2 : 1.1,
  opacity: 0.22 + ((index * 13) % 45) / 100,
}))

function renderMidnight(data: ShareCardData): string {
  const c = STYLE_TOKENS.midnight
  const parts: string[] = []

  parts.push(`<rect width="1080" height="1440" fill="${c.background}"/>`)
  for (const star of MIDNIGHT_STARS) {
    parts.push(
      `<circle cx="${star.x}" cy="${star.y}" r="${star.r}" fill="${c.ink}" opacity="${star.opacity.toFixed(2)}"/>`,
    )
  }
  parts.push(`<line x1="54" y1="72" x2="1026" y2="72" stroke="${c.accent}" stroke-width="1" stroke-opacity="0.7"/>`)
  parts.push(
    textEl('NIGHT FLIGHT · 夜航卡', {
      x: 56,
      y: 118,
      size: 20,
      fill: c.accent,
      font: c.monoFont,
      spacing: 5,
    }),
  )
  parts.push(
    textEl(dateLabel(data.date), {
      x: 1024,
      y: 118,
      size: 19,
      fill: c.muted,
      font: c.monoFont,
      anchor: 'end',
    }),
  )

  const title = fitText(data.tripTitle, {
    maxWidth: 900,
    maxFont: 66,
    minFont: 40,
    maxHeight: 200,
    lineHeightRatio: 1.14,
  })
  const titleTop = 232
  parts.push(
    multilineText(title.lines, {
      x: 90,
      y: titleTop,
      size: title.fontSize,
      fill: c.ink,
      font: c.titleFont,
      lineHeight: title.lineHeight,
      weight: 700,
    }),
  )
  const titleBottom = titleTop + (title.lines.length - 1) * title.lineHeight

  const metaY = titleBottom + 66
  parts.push(
    textEl(`第 ${data.dayNumber} 天`, {
      x: 90,
      y: metaY,
      size: 30,
      fill: c.accent,
      font: c.monoFont,
      spacing: 3,
      weight: 700,
    }),
  )
  const dayTitle = fitText(data.dayTitle, {
    maxWidth: 640,
    maxFont: 30,
    minFont: 18,
    maxHeight: 80,
    lineHeightRatio: 1.35,
  })
  parts.push(
    multilineText(dayTitle.lines, {
      x: 250,
      y: metaY,
      size: dayTitle.fontSize,
      fill: c.ink,
      font: c.bodyFont,
      lineHeight: dayTitle.lineHeight,
      opacity: 0.82,
    }),
  )
  const metaBottom = metaY + (dayTitle.lines.length - 1) * dayTitle.lineHeight
  parts.push(`<line x1="90" y1="${metaBottom + 42}" x2="990" y2="${metaBottom + 42}" stroke="${c.accent}" stroke-opacity="0.45"/>`)

  const listTop = metaBottom + 100
  const transportRuleY = 1178
  const listMax = Math.max(150, transportRuleY - 50 - listTop)

  if (data.stops.length === 0) {
    parts.push(
      textEl(EMPTY_STOPS, {
        x: 190,
        y: listTop + 42,
        size: 30,
        fill: c.muted,
        font: c.bodyFont,
      }),
    )
  } else {
    const layout = layoutStops(data.stops, {
      width: 760,
      maxHeight: listMax,
      maxFont: 40,
      minFont: 15,
      timeWidthEm: 3.6,
    })
    // 航线：固定 x=130 的竖线与节点圆点，逐个站点点亮
    const first = layout.entries[0]
    const last = layout.entries[layout.entries.length - 1]
    if (first && last) {
      const lineTop = listTop + first.top + layout.fontSize * 0.45
      const lineBottom = listTop + last.top + layout.fontSize * 0.45
      parts.push(
        `<line x1="130" y1="${lineTop}" x2="130" y2="${lineBottom}" stroke="${c.accent}"` +
          ` stroke-width="1.5" stroke-opacity="0.55"/>`,
      )
      for (const entry of layout.entries) {
        const cy = listTop + entry.top + layout.fontSize * 0.45
        parts.push(`<circle cx="130" cy="${cy}" r="7" fill="${c.background}" stroke="${c.accent}" stroke-width="2"/>`)
        parts.push(`<circle cx="130" cy="${cy}" r="2.6" fill="${c.accent}"/>`)
      }
    }
    parts.push(
      renderStopList(layout, {
        x: 190,
        y: listTop,
        timeFill: c.accent,
        nameFill: c.ink,
        timeFont: c.monoFont,
        nameFont: c.bodyFont,
        timeSizeRatio: 0.6,
      }),
    )
  }

  parts.push(`<line x1="90" y1="${transportRuleY}" x2="990" y2="${transportRuleY}" stroke="${c.accent}" stroke-opacity="0.45"/>`)
  parts.push(
    textEl('TRANSPORT / 交通', {
      x: 90,
      y: transportRuleY + 42,
      size: 18,
      fill: c.accent,
      font: c.monoFont,
      spacing: 3,
    }),
  )
  parts.push(
    textEl(data.transportSummary, {
      x: 330,
      y: transportRuleY + 42,
      size: 28,
      fill: c.ink,
      font: c.bodyFont,
    }),
  )
  parts.push(
    textEl('由 旅行助手 生成', {
      x: 540,
      y: 1342,
      size: 21,
      fill: c.muted,
      font: c.bodyFont,
      anchor: 'middle',
      spacing: 4,
    }),
  )

  return parts.join('')
}

/* ────────────────────────────── 模板 6 · 登机牌 ────────────────────────────── */

function renderBoarding(data: ShareCardData): string {
  const c = STYLE_TOKENS.boarding
  const parts: string[] = []
  const tearX = 720

  parts.push(`<rect width="1080" height="1440" fill="${c.background}"/>`)
  parts.push(`<rect x="36" y="50" width="1008" height="1340" rx="26" fill="${c.paper}" stroke="${c.ink}" stroke-width="2"/>`)
  // 上下打孔：用背景色圆盖住卡片边缘，形成半圆缺口
  parts.push(`<circle cx="${tearX}" cy="50" r="26" fill="${c.background}"/>`)
  parts.push(`<circle cx="${tearX}" cy="1390" r="26" fill="${c.background}"/>`)
  parts.push(
    `<line x1="${tearX}" y1="78" x2="${tearX}" y2="1362" stroke="${c.muted}"` +
      ` stroke-width="2" stroke-dasharray="10 10" stroke-opacity="0.75"/>`,
  )

  parts.push(
    textEl('BOARDING PASS', {
      x: 80,
      y: 136,
      size: 40,
      fill: c.ink,
      font: c.monoFont,
      spacing: 3,
      weight: 700,
    }),
  )
  parts.push(
    textEl('旅行助手', {
      x: 640,
      y: 134,
      size: 20,
      fill: c.muted,
      font: c.bodyFont,
      anchor: 'end',
      spacing: 4,
    }),
  )
  parts.push(`<line x1="80" y1="162" x2="640" y2="162" stroke="${c.ink}" stroke-width="1.5"/>`)

  const title = fitText(data.tripTitle, {
    maxWidth: 560,
    maxFont: 42,
    minFont: 26,
    maxHeight: 110,
    lineHeightRatio: 1.18,
  })
  parts.push(
    multilineText(title.lines, {
      x: 80,
      y: 214,
      size: title.fontSize,
      fill: c.ink,
      font: c.titleFont,
      lineHeight: title.lineHeight,
      weight: 700,
    }),
  )
  const titleBottom = 214 + (title.lines.length - 1) * title.lineHeight

  const infoY = titleBottom + 58
  parts.push(
    textEl('DAY', {
      x: 80,
      y: infoY,
      size: 15,
      fill: c.muted,
      font: c.monoFont,
      spacing: 3,
    }),
  )
  parts.push(
    textEl(String(data.dayNumber).padStart(2, '0'), {
      x: 80,
      y: infoY + 44,
      size: 44,
      fill: c.ink,
      font: c.monoFont,
      weight: 700,
    }),
  )
  parts.push(
    textEl('第 ' + data.dayNumber + ' 天', {
      x: 190,
      y: infoY + 40,
      size: 26,
      fill: c.ink,
      font: c.bodyFont,
      weight: 700,
    }),
  )
  parts.push(
    textEl('DATE', {
      x: 400,
      y: infoY,
      size: 15,
      fill: c.muted,
      font: c.monoFont,
      spacing: 3,
    }),
  )
  parts.push(
    textEl(dateLabel(data.date), {
      x: 400,
      y: infoY + 40,
      size: 24,
      fill: c.ink,
      font: c.monoFont,
      spacing: 1,
    }),
  )

  const stampY = infoY + 96
  parts.push(
    `<rect x="80" y="${stampY}" width="560" height="126" rx="12" fill="none"` +
      ` stroke="${c.accent}" stroke-width="2" stroke-dasharray="8 7"/>`,
  )
  parts.push(
    textEl('出发 → 抵达', {
      x: 104,
      y: stampY + 40,
      size: 18,
      fill: c.accent,
      font: c.monoFont,
      spacing: 3,
    }),
  )
  parts.push(
    textEl(data.destination, {
      x: 104,
      y: stampY + 94,
      size: 42,
      fill: c.accent,
      font: c.titleFont,
      weight: 800,
    }),
  )
  parts.push(
    `<circle cx="590" cy="${stampY + 63}" r="42" fill="none" stroke="${c.accent2}" stroke-width="3" transform="rotate(-12 590 ${stampY + 63})"/>`,
  )
  parts.push(
    textEl('TRAVEL', {
      x: 590,
      y: stampY + 58,
      size: 15,
      fill: c.accent2,
      font: c.monoFont,
      anchor: 'middle',
      spacing: 2,
      weight: 700,
    }),
  )
  parts.push(
    textEl('STAMP', {
      x: 590,
      y: stampY + 79,
      size: 13,
      fill: c.accent2,
      font: c.monoFont,
      anchor: 'middle',
      spacing: 2,
    }),
  )

  const listTop = stampY + 186
  const listMax = Math.max(130, 1205 - listTop)
  parts.push(
    textEl('ITINERARY / 行程', {
      x: 80,
      y: listTop - 26,
      size: 16,
      fill: c.muted,
      font: c.monoFont,
      spacing: 3,
    }),
  )

  if (data.stops.length === 0) {
    parts.push(
      textEl(EMPTY_STOPS, {
        x: 80,
        y: listTop + 34,
        size: 26,
        fill: c.muted,
        font: c.bodyFont,
      }),
    )
  } else {
    const layout = layoutStops(data.stops, {
      width: 560,
      maxHeight: listMax,
      maxFont: 30,
      minFont: 14,
      timeWidthEm: 3.6,
    })
    parts.push(
      renderStopList(layout, {
        x: 80,
        y: listTop,
        timeFill: c.accent,
        nameFill: c.ink,
        timeFont: c.monoFont,
        nameFont: c.bodyFont,
        timeSizeRatio: 0.64,
        nameWeight: 600,
      }),
    )
    for (let index = 0; index < layout.entries.length - 1; index += 1) {
      const entry = layout.entries[index]
      const next = layout.entries[index + 1]
      const ruleY = listTop + entry.top + (next.top - entry.top) - layout.gap / 2
      parts.push(
        `<line x1="80" y1="${ruleY}" x2="640" y2="${ruleY}" stroke="${c.muted}"` +
          ` stroke-width="1" stroke-dasharray="5 6" stroke-opacity="0.55"/>`,
      )
    }
  }

  // 右侧票根
  parts.push(
    textEl('DAY', {
      x: 768,
      y: 236,
      size: 15,
      fill: c.muted,
      font: c.monoFont,
      spacing: 3,
    }),
  )
  parts.push(
    textEl(String(data.dayNumber).padStart(2, '0'), {
      x: 768,
      y: 320,
      size: 76,
      fill: c.ink,
      font: c.monoFont,
      weight: 700,
    }),
  )
  parts.push(
    textEl('DATE', {
      x: 768,
      y: 390,
      size: 15,
      fill: c.muted,
      font: c.monoFont,
      spacing: 3,
    }),
  )
  parts.push(
    textEl(dateLabel(data.date), {
      x: 768,
      y: 426,
      size: 20,
      fill: c.ink,
      font: c.monoFont,
    }),
  )
  parts.push(`<line x1="768" y1="466" x2="1004" y2="466" stroke="${c.muted}" stroke-opacity="0.5"/>`)
  parts.push(
    textEl('TRANSPORT', {
      x: 768,
      y: 506,
      size: 15,
      fill: c.muted,
      font: c.monoFont,
      spacing: 2,
    }),
  )
  const summary = wrapText(data.transportSummary, 224 / 21)
  parts.push(
    multilineText(summary, {
      x: 768,
      y: 542,
      size: 21,
      fill: c.ink,
      font: c.bodyFont,
      lineHeight: 29,
    }),
  )

  parts.push(`<rect x="768" y="860" width="236" height="96" fill="none" stroke="${c.ink}" stroke-opacity="0.35"/>`)
  parts.push(`<g transform="translate(774 866)">${barcode(`${data.tripTitle}|${data.dayNumber}|${data.date ?? ''}`, 224, 84)}</g>`)
  parts.push(
    textEl('TRAVEL ASSISTANT', {
      x: 768,
      y: 1004,
      size: 13,
      fill: c.muted,
      font: c.monoFont,
      spacing: 2,
    }),
  )
  parts.push(
    textEl(data.dayTitle, {
      x: 768,
      y: 1050,
      size: 18,
      fill: c.ink,
      font: c.bodyFont,
      weight: 700,
    }),
  )

  parts.push(
    textEl('由 旅行助手 生成', {
      x: 80,
      y: 1344,
      size: 20,
      fill: c.muted,
      font: c.bodyFont,
      spacing: 4,
    }),
  )

  return parts.join('')
}

/* ────────────────────────────── 导出入口 ────────────────────────────── */

const STYLE_RENDERERS: Record<ShareCardStyle, (data: ShareCardData) => string> = {
  xuanzhi: renderXuanzhi,
  daily: renderDaily,
  almanac: renderAlmanac,
  riso: renderRiso,
  midnight: renderMidnight,
  boarding: renderBoarding,
}

/**
 * 渲染 1080×1440 的完整 SVG 字符串。返回值可直接作为 innerHTML 使用，
 * 也可直接保存为 .svg 文件。所有用户文本都经过 XML 转义。
 */
export function renderShareCard(style: ShareCardStyle, data: ShareCardData): string {
  const renderer = STYLE_RENDERERS[style] ?? renderXuanzhi
  const styleMeta = SHARE_CARD_STYLES.find((item) => item.id === style)
  const label = styleMeta?.label ?? '分享卡片'
  const accessible = `${data.tripTitle} · 第 ${data.dayNumber} 天 · ${label}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1440"` +
    ` width="1080" height="1440" role="img" aria-label="${escapeXml(accessible)}"` +
    ` data-style="${style}">` +
    `<title>${escapeXml(accessible)}</title>` +
    renderer(data) +
    `</svg>`
  )
}

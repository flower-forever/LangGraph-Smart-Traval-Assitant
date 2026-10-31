/**
 * 可读路书 Markdown 导出（纯函数，不碰任何 I/O）。
 *
 * 边界：
 * - 只投影 ./api.ts 里 Trip 契约的已知字段；未知字段（包括可能夹带凭据的 extra 属性）一律不进输出。
 * - 不猜值：null / 缺失字段写「未提供」；0 是合法记录值，按 0 展示，不当缺失补数。
 * - 本模块不自行添加、也不核实营业、票价、预约、天气等信息；用户原记录里提到这些内容时
 *   原样保留，文件固定说明里写明「没有因导出而核实」。独立 POI / 天气信封不进入导出。
 * - geometry 不进输出：几千个点对阅读毫无价值，距离与耗时只写记录值。
 * - 用户文本按纯文本转义：反斜杠、Markdown 结构字符、HTML 实体；控制字符（含 DEL / C1 / Tab）
 *   以可见的 U+XXXX 记号无损保留，换行以「行尾两空格 + 换行」的硬换行表示——不删除、
 *   不规范化业务内容，也不会制造标题 / 反引号 / 表格 / 图片 / 链接 / 可执行 HTML。
 * - 输出上限 1 MiB（UTF-8 实际字节）。调用方传入的自定义上限只能收紧（正数且不超过 1 MiB），
 *   非法配置返回独立的 bad_limit 固定文案，不伪装成行程非法；超限 fail-closed 不截断、不回显内容。
 * - 相同 Trip 确定性输出：不写导出时间，不读时钟。
 */

import type { Trip, TripDay, TripLeg, TripStop } from './api'
import { isTripLike } from './api'
import { checkTripShape, utf8ByteLength } from './savedTrips'
import { safeTripBackupFilename } from './tripFile'

/** Markdown 输出的 UTF-8 字节上限（1 MiB） */
export const MAX_TRIP_MARKDOWN_BYTES = 1024 * 1024

/** 导出文件固定 .md 后缀；文件名清洗复用 tripFile 的安全 base */
export const TRIP_MARKDOWN_MIME_TYPE = 'text/markdown;charset=utf-8'

/** 行程来源只作「记录自述」展示；证明不了文件真的来自谁 */
export const TRIP_SOURCE_LABELS = {
  example: '示例行程（记录自述 source=example）',
  agent: '生成行程（记录自述 source=agent）',
} as const

const MISSING = '未提供'
/** 行程级说明：固定文本，不含时间戳，保证同一 Trip 确定性输出 */
export const TRIP_MARKDOWN_README_NOTE =
  '> 本文件是当前记录的阅读版导出：营业时间、票务与路线实时状态都没有因导出而核实，出行前请自行确认。' +
  '要恢复行程继续编辑，请使用 JSON 备份文件，不要用本文件。'

/** 用户自己的描述不做自动脱敏；分享前提醒检查一次 */
export const TRIP_MARKDOWN_SHARE_NOTICE =
  '导出内容包含你自己填写的标题、摘要与描述，工具不做脱敏；分享前请检查一次。'

const MESSAGE_INVALID_TRIP =
  '当前行程的数据结构不完整或包含异常字段（重复天数、重复站点 ID、字段超长、数量异常等），没有生成 Markdown。'
const MESSAGE_BAD_LIMIT =
  '导出配置的输出上限不合法（必须是不超过 1 MiB 的正数），没有生成文件。这是程序配置问题，与行程内容无关。'
const MESSAGE_TOO_LARGE = (bytes: number, limit: number): string =>
  `生成的 Markdown 约 ${Math.max(1, Math.ceil(bytes / 1024))} KB，超过 ${Math.round(limit / 1024)} KB 的输出上限，没有生成文件。行程本身可以正常查看。`

/** 生成 .md 文件名：与 JSON 备份同名不同后缀，同一行程文件名稳定 */
export function safeTripMarkdownFilename(trip: Trip): string {
  return safeTripBackupFilename(trip).replace(/\.json$/, '.md')
}

export type TripMarkdownFailureReason = 'invalid_trip' | 'too_large' | 'bad_limit'

export type TripMarkdownResult =
  | { ok: true; markdown: string; bytes: number; filename: string; notices: string[] }
  | { ok: false; reason: TripMarkdownFailureReason; message: string }

/**
 * 单行内的 Markdown / HTML 结构字符。反斜杠必须一并转义：
 * 裸反斜杠会把它后面已转义的字符（如 `\*`）重新解成结构，等于给注入开了后门。
 */
const STRUCTURE_CHARS = /[\\`*_{}[\]()#+\-.!|>~]/g

/** 控制字符（C0 除 \n \r 外、DEL、C1、Tab）：不删除、不替换成空格，转成可见 U+XXXX 记号 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\t]/g

function controlMarker(char: string): string {
  return `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * 单行转义。顺序固定：先 HTML 实体（& < >），再结构字符（含反斜杠），
 * 控制字符记号最后插入——记号里的 `+` 是生成文本，不再参与转义。
 */
function escapeLine(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(STRUCTURE_CHARS, '\\$&')
    .replace(CONTROL_CHARS, controlMarker)
}

/**
 * 用户文本转义：换行保留为「行尾两空格 + 换行」的 Markdown 硬换行，语义无损；
 * 每行独立转义，多行内容不会拼出标题 / 代码块 / 表格等结构。
 */
function escapeUserText(raw: string): string {
  return raw
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map(escapeLine)
    .join('  \n')
}

/** 有坐标就纯文本展示（WGS84，数字同样过转义）；无坐标写未提供，不编造位置 */
function formatCoordinate(stop: TripStop): string {
  if (!stop.location) return MISSING
  return `WGS84 经度 ${escapeUserText(String(stop.location.lng))}，纬度 ${escapeUserText(String(stop.location.lat))}`
}

/** 停留时长：null 是「未提供」，0 是合法记录值照写 */
function formatStopDuration(minutes: number | null): string {
  if (minutes === null) return MISSING
  return `${minutes} 分钟`
}

/** 路段距离：null 是「未提供」，0 米是合法记录值照写 */
function formatLegDistance(meters: number | null): string {
  if (meters === null) return MISSING
  return `${meters} 米`
}

/** 路段耗时：null 是「未提供」，0 分钟是合法记录值照写 */
function formatLegDuration(minutes: number | null): string {
  if (minutes === null) return MISSING
  return `${minutes} 分钟`
}

const ROUTE_TYPE_LABELS: Record<TripLeg['route_type'], string> = {
  navigation: '导航路线（按记录原样导出，本次未重新计算路线）',
  straight_line: '示意直线（不是导航结果，无真实道路）',
  unavailable: '路线不可用（本次没有可用的路线数据）',
}

const MODE_LABELS: Record<TripLeg['mode'], string> = {
  walking: '步行',
  driving: '驾车',
}

function legLine(day: TripDay, leg: TripLeg): string {
  const byId = new Map(day.stops.map((stop) => [stop.id, stop.name]))
  const from = byId.get(leg.from_stop_id)
  const to = byId.get(leg.to_stop_id)
  const fromName = from ?? '（记录里的站点 ID 未匹配到站点）'
  const toName = to ?? '（记录里的站点 ID 未匹配到站点）'
  const parts = [
    `- ${escapeUserText(fromName)} → ${escapeUserText(toName)}：`,
    `${ROUTE_TYPE_LABELS[leg.route_type]}；方式：${MODE_LABELS[leg.mode]}；`,
    `记录距离：${formatLegDistance(leg.distance_m)}；记录耗时：${formatLegDuration(leg.duration_minutes)}。`,
  ]
  const line = parts.join(' ')
  return leg.description.trim() !== ''
    ? `${line} 说明：${escapeUserText(leg.description)}`
    : line
}

function stopLine(stop: TripStop): string {
  const lines: string[] = []
  const head =
    `- ${escapeUserText(stop.name)}（${escapeUserText(stop.time)}，停留 ${formatStopDuration(stop.duration_minutes)}）`
  lines.push(head)
  const details: string[] = []
  if (stop.address.trim() !== '') details.push(`地址：${escapeUserText(stop.address)}`)
  else details.push(`地址：${MISSING}`)
  details.push(`坐标：${formatCoordinate(stop)}`)
  if (stop.description.trim() !== '') details.push(`描述：${escapeUserText(stop.description)}`)
  lines.push(`  - ${details.join('；')}`)
  return lines.join('\n')
}

function daySection(day: TripDay): string[] {
  const out: string[] = []
  out.push(`## 第 ${day.day} 天${day.date ? `（${escapeUserText(day.date)}）` : '（日期未提供）'}`)
  out.push(`### ${escapeUserText(day.title)}`)
  if (day.summary.trim() !== '') out.push(escapeUserText(day.summary))
  if (day.stops.length === 0 && day.legs.length === 0) {
    out.push('（记录里这一天没有站点与路段。）')
    return out
  }
  if (day.stops.length > 0) {
    out.push('#### 站点（按记录顺序）')
    for (const stop of day.stops) out.push(stopLine(stop))
  } else {
    out.push('（记录里这一天没有站点。）')
  }
  if (day.legs.length > 0) {
    out.push('#### 路段（按记录顺序）')
    for (const leg of day.legs) out.push(legLine(day, leg))
  } else {
    out.push('（记录里这一天没有路段。）')
  }
  return out
}

/**
 * 生成可读路书 Markdown。
 * 校验顺序固定：输出上限配置 → 契约与结构（复用与本地保存同一套 checkTripShape）→ 生成 → UTF-8 字节门禁。
 * 自定义 maxBytes 只允许收紧上限：必须是正数且不超过默认 1 MiB，其余一律 bad_limit 固定文案，
 * 不伪装成行程非法。各失败路径都 fail-closed：不产出半份文件，固定文案不回显行程内容。
 * 同一 Trip（深相等）输出逐字节相同：不写导出时间，不读时钟。
 */
export function tripToMarkdown(trip: Trip, options: { maxBytes?: number } = {}): TripMarkdownResult {
  if (options.maxBytes !== undefined) {
    const configured = options.maxBytes
    if (
      typeof configured !== 'number' ||
      !Number.isFinite(configured) ||
      configured <= 0 ||
      configured > MAX_TRIP_MARKDOWN_BYTES
    ) {
      return { ok: false, reason: 'bad_limit', message: MESSAGE_BAD_LIMIT }
    }
  }
  const limit = options.maxBytes ?? MAX_TRIP_MARKDOWN_BYTES

  if (!isTripLike(trip)) {
    return { ok: false, reason: 'invalid_trip', message: MESSAGE_INVALID_TRIP }
  }
  const shape = checkTripShape(trip)
  if (!shape.ok) {
    return { ok: false, reason: 'invalid_trip', message: MESSAGE_INVALID_TRIP }
  }

  const lines: string[] = []
  lines.push(`# ${escapeUserText(trip.title || MISSING)}`)
  lines.push('')
  lines.push(`- 目的地：${escapeUserText(trip.destination || MISSING)}`)
  lines.push(`- 行程来源：${TRIP_SOURCE_LABELS[trip.source]}`)
  lines.push(`- 天数：${trip.days.length}`)
  if (trip.summary.trim() !== '') lines.push(`- 摘要：${escapeUserText(trip.summary)}`)
  lines.push('')
  lines.push(TRIP_MARKDOWN_README_NOTE)
  lines.push('')

  if (trip.warnings.length > 0) {
    lines.push('## 记录内提示（warnings）')
    for (const warning of trip.warnings) lines.push(`- ${escapeUserText(warning)}`)
    lines.push('')
  }

  for (const day of trip.days) lines.push(...daySection(day), '')

  lines.push('---')
  lines.push('')
  lines.push('说明：本文件由当前记录导出，行程来源字段按记录自述展示，不能证明文件的真实生成方。')

  const markdown = lines.join('\n')
  const bytes = utf8ByteLength(markdown)
  if (bytes > limit) {
    return { ok: false, reason: 'too_large', message: MESSAGE_TOO_LARGE(bytes, limit) }
  }

  return {
    ok: true,
    markdown,
    bytes,
    filename: safeTripMarkdownFilename(trip),
    notices: [TRIP_MARKDOWN_README_NOTE, TRIP_MARKDOWN_SHARE_NOTICE],
  }
}

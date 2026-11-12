/**
 * 六期 S5 景点深度卡投影：把可选、可能残缺的站点深度字段收敛成展示视图。
 *
 * 边界（与 stopFacts / cityProfile 同一纪律）：
 * - **纯函数投影**：输入 TripStop，输出展示知识；不读写存储、不发请求、零副作用。
 * - 逐字段降级：缺块 / 坏块只影响自己，绝不因为深度展示让整份行程崩掉。
 * - 上限与后端契约一致：看点 / 贴士各最多 3 条、适合标签最多 6 个、单条文本最多 80 字。
 * - 只做展示清洗（空白归一 + 截断 + 去重），不补造任何内容。
 * - **不做过期标记（字段级登记）**：深度字段没有 recordedAt —— 模型生成时间不是
 *   资料来源时间，用它算 180 天时效会把「何时生成」冒充「何时核实」。这类内容
 *   是稳定知识（看点 / 适合谁 / 停留建议 / 贴士），易变事实（营业时间 / 票价 /
 *   预约政策）由后端过滤器整块剔除，仍走 S2 三态核实。因此本模块不输出 stale。
 */

import { interestLabelOf, isPlanInterest, type PlanInterest } from './interests'
import type { TripStop } from './api'

/** 看点 / 贴士单条上限，与后端 max_length 一致。 */
export const STOP_DEPTH_MAX_ITEM_LENGTH = 80
export const STOP_DEPTH_MAX_ITEMS = 3
export const STOP_DEPTH_MIN_STAY_MINUTES = 5
export const STOP_DEPTH_MAX_STAY_MINUTES = 1440

export interface StopDepthTagView {
  value: PlanInterest
  /** 中文展示名；与五期兴趣选择器同一映射。 */
  label: string
}

export interface StopDepthView {
  highlights: string[]
  suitableFor: StopDepthTagView[]
  suggestedStayMinutes: { min: number; max: number } | null
  tips: string[]
}

/** 模型偶尔把标签写成中文；与后端同一张别名表，避免同义值重复展示。 */
const TAG_ALIASES: Record<string, PlanInterest> = {
  历史: 'history',
  美食: 'food',
  自然: 'nature',
  拍照: 'photo',
  亲子: 'family',
  老人友好: 'elder_friendly',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 文本兼容 `{ text }` 与裸字符串；空白归一后为空则视为未提供。 */
function textOf(value: unknown): string | null {
  const raw = isRecord(value) ? value.text : value
  if (typeof raw !== 'string') return null
  const text = raw.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, STOP_DEPTH_MAX_ITEM_LENGTH) : null
}

/** 列表块兼容 `{ items }` 与裸数组；逐条清洗、去重、截断。 */
function itemsOf(value: unknown): string[] {
  const raw = isRecord(value) ? value.items : value
  if (!Array.isArray(raw)) return []
  const items: string[] = []
  for (const entry of raw.slice(0, STOP_DEPTH_MAX_ITEMS)) {
    const text = textOf(entry)
    if (text && !items.includes(text)) items.push(text)
  }
  return items
}

/** 标签块兼容 `{ tags }` 与裸数组；只保留五期兴趣枚举，未知值丢弃。 */
function tagsOf(value: unknown): StopDepthTagView[] {
  const raw = isRecord(value) ? value.tags : value
  if (!Array.isArray(raw)) return []
  const tags: StopDepthTagView[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const text = entry.trim()
    const canonical = TAG_ALIASES[text] ?? text
    if (!isPlanInterest(canonical)) continue
    if (tags.some((tag) => tag.value === canonical)) continue
    tags.push({ value: canonical, label: interestLabelOf(canonical) })
  }
  return tags
}

function stayOf(value: unknown): { min: number; max: number } | null {
  if (!isRecord(value)) return null
  const { min, max } = value
  if (typeof min !== 'number' || typeof max !== 'number') return null
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null
  if (min < STOP_DEPTH_MIN_STAY_MINUTES || max > STOP_DEPTH_MAX_STAY_MINUTES) return null
  if (min > max) return null
  return { min, max }
}

/** 没有任何可用块时返回 null，调用方据此完全不渲染深度卡。 */
export function projectStopDepth(stop: TripStop | null | undefined): StopDepthView | null {
  if (!stop || typeof stop !== 'object') return null
  const view: StopDepthView = {
    highlights: itemsOf(stop.highlights),
    suitableFor: tagsOf(stop.suitableFor),
    suggestedStayMinutes: stayOf(stop.suggestedStayMinutes),
    tips: itemsOf(stop.tips),
  }
  const hasContent =
    view.highlights.length > 0 ||
    view.suitableFor.length > 0 ||
    view.suggestedStayMinutes !== null ||
    view.tips.length > 0
  return hasContent ? view : null
}

/**
 * P6.5 X4：深度生成时间的展示投影——**UTC 存储，本地日期展示**。
 *
 * - 输出 `YYYY-MM-DD`，用本地时区的 getFullYear/getMonth/getDate 逐段拼，
 *   禁止直接切 ISO 字符串前 10 位（S9 教训：UTC 日期会差一天）。
 * - 必须带显式时区（`Z` 或 `±HH:MM`）：无时区的 ISO 会被 `new Date` 按本地时间解析，
 *   等于把来源不明的字符串冒充本地日期。
 * - 缺字段 / 坏值 / 非字符串一律返回 null：旧行程不显示，绝不伪造。
 * - 与 `projectStopDepth` 分开输出：内容块投影的字段集合已由既有用例锁定；
 *   时间戳是元数据，坏值只影响这一行，不影响卡片内容。
 * - 不接 180 天过期逻辑：`recordedAt`（资料来源时间）与生成时间体系分开。
 */
const DEPTH_GENERATED_AT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function projectDepthGeneratedDate(
  stop: TripStop | null | undefined,
): string | null {
  if (!stop || typeof stop !== 'object') return null
  const raw = stop.depthGeneratedAt
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!DEPTH_GENERATED_AT_RE.test(text)) return null
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return null
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

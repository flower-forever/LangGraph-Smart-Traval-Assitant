import type { CityProfile } from './api'

/**
 * 六期 S4 城市导览投影：把可选、可能残缺的 cityProfile 收敛成展示视图。
 *
 * - 纯函数、零副作用：不读写存储、不发请求、不碰 Trip 其它字段。
 * - 缺块 / 坏块逐块降级为 null 或空列表，绝不因为展示字段让整份行程崩掉。
 * - 上限与后端契约一致：片区最多 6 个、经典清单最多 15 条、每片区代表景点最多 3 个。
 * - 只做展示清洗（空白归一 + 截断），不补造任何内容。
 */

export interface CityProfileDaysView {
  min: number
  max: number
}

export interface CityProfileDistrictView {
  name: string
  summary: string | null
  attractions: string[]
}

export interface CityProfileClassicView {
  name: string
  reason: string | null
}

export interface CityProfileView {
  oneLineImpression: string | null
  suggestedDays: CityProfileDaysView | null
  districts: CityProfileDistrictView[]
  seasonTips: string | null
  classicList: CityProfileClassicView[]
}

const MAX_DISTRICTS = 6
const MAX_CLASSICS = 15
const MAX_ATTRACTIONS = 3
const MAX_DAYS = 7

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 文本块兼容 `{ text }` 与裸字符串；空白归一后为空则视为未提供。 */
function textOf(value: unknown, maxLength: number): string | null {
  const raw = isRecord(value) ? value.text : value
  if (typeof raw !== 'string') return null
  const text = raw.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, maxLength) : null
}

function daysOf(value: unknown): CityProfileDaysView | null {
  if (!isRecord(value)) return null
  const { min, max } = value
  if (typeof min !== 'number' || typeof max !== 'number') return null
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null
  if (min < 1 || max > MAX_DAYS || min > max) return null
  return { min, max }
}

function districtsOf(value: unknown): CityProfileDistrictView[] {
  if (!Array.isArray(value)) return []
  const districts: CityProfileDistrictView[] = []
  for (const entry of value.slice(0, MAX_DISTRICTS)) {
    if (!isRecord(entry)) continue
    const name = textOf(entry.name, 40)
    if (!name) continue
    const attractions: string[] = []
    if (Array.isArray(entry.attractions)) {
      for (const item of entry.attractions.slice(0, MAX_ATTRACTIONS)) {
        const attraction = textOf(item, 40)
        if (attraction && !attractions.includes(attraction)) attractions.push(attraction)
      }
    }
    districts.push({ name, summary: textOf(entry.summary, 120), attractions })
  }
  return districts
}

function classicsOf(value: unknown): CityProfileClassicView[] {
  if (!Array.isArray(value)) return []
  const classics: CityProfileClassicView[] = []
  const seen = new Set<string>()
  // 先遍历全部候选，过滤空名 / 去重后再截断：前部脏数据不能把后面的有效条目挤掉。
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const name = textOf(entry.name, 60)
    if (!name || seen.has(name)) continue
    seen.add(name)
    classics.push({ name, reason: textOf(entry.reason, 120) })
  }
  return classics.slice(0, MAX_CLASSICS)
}

/** 没有任何可用块时返回 null，调用方据此完全不渲染城市卡。 */
export function projectCityProfile(
  profile: CityProfile | null | undefined,
): CityProfileView | null {
  if (!profile || typeof profile !== 'object') return null
  const view: CityProfileView = {
    oneLineImpression: textOf(profile.oneLineImpression, 120),
    suggestedDays: daysOf(profile.suggestedDays),
    districts: districtsOf(profile.districts),
    seasonTips: textOf(profile.seasonTips, 120),
    classicList: classicsOf(profile.classicList),
  }
  const hasContent =
    view.oneLineImpression !== null ||
    view.suggestedDays !== null ||
    view.districts.length > 0 ||
    view.seasonTips !== null ||
    view.classicList.length > 0
  return hasContent ? view : null
}

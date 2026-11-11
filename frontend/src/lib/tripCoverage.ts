import type { CityProfile, TripDay } from './api'
import { normalizeCandidateText } from './candidatePool'
import { projectCityProfile } from './cityProfile'

/**
 * 六期 S6 选择充分度投影：行程站点 vs 城市经典清单（classicList）对比。
 *
 * - 纯函数、零副作用：不读写存储、不发请求、不改行程；「加入候选池」由组件
 *   发回调、父级走既有显式写路径，本模块与存储完全无关。
 * - classicList 清洗复用 `projectCityProfile`（与城市卡同一口径：空白归一、
 *   去重、上限 15、逐条降级），不另造一份。
 * - 名称归一化沿 `findPoiCardByName` 同款（`normalizeCandidateText`：NFKC +
 *   空白折叠 + 小写），**精确相等**才算命中；匹配不上如实进「未识别 / 未安排」，
 *   不做子串、别名表或简繁折叠（既有口径没有，不另造）。
 * - 统计 X/N 只来自经典清单两侧：已覆盖 X（命中条数）/ 总数 N；行程站点里
 *   匹配不上任何经典项的只如实说明（未识别），不进覆盖统计。
 */

export interface TripCoverageCoveredItem {
  name: string
  reason: string | null
  /** 命中该经典项的行程站点名（原始名，去重保序；同一站点名可覆盖同名经典项）。 */
  matchedStops: string[]
}

export interface TripCoverageUnarrangedItem {
  name: string
  reason: string | null
}

export interface TripCoverageView {
  /** classicList 清洗后的条数；X/N 的 N。 */
  total: number
  covered: TripCoverageCoveredItem[]
  /** 未安排 = total − covered.length；每条可由用户「加入候选池」。 */
  uncovered: TripCoverageUnarrangedItem[]
  /** 匹配不上任何经典项的行程站点名（去重保序）；只如实说明，不计入统计。 */
  unrecognizedStops: string[]
}

/** 名称归一化键：与 `poiCardNameKey` / `findPoiCardByName` 完全同款，不另造口径。 */
export function tripCoverageNameKey(name: string): string {
  return normalizeCandidateText(name)
}

/**
 * 投影行程覆盖情况。classicList 缺失或为空时返回 null——调用方据此完全不渲染
 * 充分度卡（不显示「覆盖 0/0」这类伪统计）。
 */
export function projectTripCoverage(
  days: TripDay[] | null | undefined,
  profile: CityProfile | null | undefined,
): TripCoverageView | null {
  const classicList = projectCityProfile(profile)?.classicList ?? []
  if (classicList.length === 0) return null

  // 站点名逐层防御：days / stops 非数组、name 非字符串都跳过；按归一化键分桶，
  // 同键保留去重后的原始名（首现顺序）。
  const stopNamesByKey = new Map<string, string[]>()
  for (const day of Array.isArray(days) ? days : []) {
    const stops = day && Array.isArray(day.stops) ? day.stops : []
    for (const stop of stops) {
      const name =
        typeof (stop as { name?: unknown } | null | undefined)?.name === 'string'
          ? (stop as { name: string }).name.replace(/\s+/g, ' ').trim()
          : ''
      if (!name) continue
      const key = tripCoverageNameKey(name)
      if (key.length === 0) continue
      const bucket = stopNamesByKey.get(key)
      if (bucket) {
        if (!bucket.includes(name)) bucket.push(name)
      } else {
        stopNamesByKey.set(key, [name])
      }
    }
  }

  const covered: TripCoverageCoveredItem[] = []
  const uncovered: TripCoverageUnarrangedItem[] = []
  for (const classic of classicList) {
    const key = tripCoverageNameKey(classic.name)
    const matchedStops = key.length > 0 ? (stopNamesByKey.get(key) ?? []) : []
    if (matchedStops.length > 0) {
      covered.push({ name: classic.name, reason: classic.reason, matchedStops: [...matchedStops] })
    } else {
      uncovered.push({ name: classic.name, reason: classic.reason })
    }
  }

  const classicKeys = new Set(
    classicList.map((classic) => tripCoverageNameKey(classic.name)).filter((key) => key.length > 0),
  )
  const unrecognizedStops: string[] = []
  for (const [key, names] of stopNamesByKey) {
    if (classicKeys.has(key)) continue
    for (const name of names) {
      if (!unrecognizedStops.includes(name)) unrecognizedStops.push(name)
    }
  }

  return { total: classicList.length, covered, uncovered, unrecognizedStops }
}

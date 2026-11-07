/**
 * 候选地点池 · 帮我出出主意（二期 C-1）：纯本地规则生成候选点子。
 *
 * 边界（与 docs/CANDIDATE_POOL.md §9 对齐）：
 * - 零网络：只做「目的地关键词 → 场景」的固定表匹配 + 通用补充项；
 *   不读写任何存储、不读时钟、不发任何请求；同输入恒同输出（确定性）。
 * - 建议是「点子」不是真实地点：坐标没有真实来源，location 恒为 null，
 *   绝不补 (0,0)，也不地理编码；界面固定标「未核实」。
 * - 不新增 source 枚举值（PM 裁决）：采纳只是把建议预填进面板既有的
 *   「手工新增」表单，备注由 assistantSuggestedNote 打上 assistant-suggested
 *   标记；用户显式确认后走既有 createManualCandidate / addCandidateToRecord，
 *   source 仍是 manual。本模块绝不直接入池、绝不写候选库。
 * - 去重只提示：按既有 normalizeCandidateText（dedupeKey 的归一化部分）对名称
 *   做比对；建议没有地址，完整 dedupeKey（名称+地址）判定发生在真正入库的
 *   addCandidateToRecord。命中只显示「可能重复」，不自动合并、不自动丢弃。
 */

import type { CandidateItemV1 } from './workspace'
import { candidateDedupeKey, normalizeCandidateText } from './candidatePool'

/** 备注里的建议标记；source 不新增枚举（PM 裁决），采纳后仍是 manual。 */
export const ASSISTANT_SUGGESTED_NOTE_TAG = 'assistant-suggested'

/** 采纳建议时预填进备注的文本；用户可改，确认后随候选一起入库。 */
export function assistantSuggestedNote(reason: string): string {
  return `[${ASSISTANT_SUGGESTED_NOTE_TAG}] ${reason}`
}

export type CandidatePaceV1 = 'compact' | 'balanced' | 'relaxed'

export const CANDIDATE_PACE_LABELS: Readonly<Record<CandidatePaceV1, string>> = {
  compact: '紧凑',
  balanced: '均衡',
  relaxed: '松散',
}

export interface CandidateSuggestionInput {
  /** 目的地名称；只按包含的关键词做场景匹配，留空则只给通用建议。 */
  destination: string
  /** 行程天数；非正整数按 1 处理。 */
  days: number
  /** 当前行程节奏。 */
  pace: CandidatePaceV1
  /** 已有候选（只读 name / address），用于「可能重复」提示；不会被修改。 */
  existingCandidates?: readonly Pick<CandidateItemV1, 'name' | 'address'>[]
}

export interface CandidateSuggestion {
  /** 建议名称；是「点子」而非真实地点，采纳后由用户改成真实目标。 */
  name: string
  /** 一句话理由；采纳时随 assistant-suggested 标记预填进备注。 */
  reason: string
  /** 场景标签；采纳时预填为区域标签。 */
  scene: string
  /** 坐标没有真实来源：恒为 null，绝不补 (0,0)，也不地理编码。 */
  location: null
  /** 与既有候选名称（归一化）相同时列出对方名称；只提示，不自动合并。 */
  duplicateOf: string[]
}

interface ScenarioSuggestion {
  name: string
  reason: string
  scene: string
}

interface ScenarioRule {
  scene: string
  keywords: readonly string[]
  /** 命中任一 exclude 时跳过本规则（避免「乐园」同时命中「园」的园林规则）。 */
  exclude?: readonly string[]
  suggestions: readonly ScenarioSuggestion[]
}

const SCENARIO_RULES: readonly ScenarioRule[] = [
  {
    scene: '海滨',
    keywords: ['海', '岛', '湾', '滩', '滨', '礁'],
    suggestions: [
      { name: '海滨步行道或海堤观景点', reason: '海滨目的地常见的免费散步与看海点位。', scene: '海滨' },
      { name: '出海或观光船码头区域', reason: '海滨城市通常有游船码头，可顺路看看班次与价格。', scene: '海滨' },
      { name: '海鲜市场或渔港早市', reason: '靠海的目的地常有渔市，适合上午前往。', scene: '市井' },
    ],
  },
  {
    scene: '江河',
    keywords: ['江', '河', '溪', '浦'],
    suggestions: [
      { name: '滨江或滨河步道', reason: '江河城市多有两岸步道，傍晚时段体验较好。', scene: '江河' },
      { name: '跨江桥或观景桥', reason: '桥上是免费的制高点，可顺路安排。', scene: '观景' },
    ],
  },
  {
    scene: '湖泊',
    keywords: ['湖', '泊', '潭'],
    suggestions: [
      { name: '环湖步道的一段', reason: '湖泊目的地适合挑一段环湖路步行，不必走完全程。', scene: '湖泊' },
      { name: '湖畔日出或日落点位', reason: '湖面朝向决定日出日落效果，可先确认方位。', scene: '观景' },
      { name: '湖上游船码头', reason: '湖区一般有游船，可作为体力不足时的替代路线。', scene: '湖泊' },
    ],
  },
  {
    scene: '山岳',
    keywords: ['山', '峰', '岭', '岳', '峡', '谷'],
    suggestions: [
      { name: '登山步道入口与缆车下站', reason: '先确认上下山的两条路线，再决定步行或缆车。', scene: '山岳' },
      { name: '山顶或半山观景台', reason: '山地行程通常以观景台为折返点，注意往返用时。', scene: '观景' },
      { name: '山脚古寺或村落', reason: '山岳目的地山脚常有村落或寺庙，可作为缓冲行程。', scene: '古迹' },
    ],
  },
  {
    scene: '古迹宗教',
    keywords: ['寺', '庙', '庵', '祠', '塔', '陵', '古城', '古镇', '老街'],
    suggestions: [
      { name: '古街或老城区的晨间时段', reason: '开放初期人少光线好，适合慢慢逛。', scene: '古迹' },
      { name: '本地老字号小吃集中街区', reason: '古城区通常聚集老字号，可作为一餐的落点。', scene: '市井' },
    ],
  },
  {
    scene: '展馆',
    keywords: ['博物馆', '美术馆', '科技馆', '展览'],
    suggestions: [
      { name: '城市博物馆常设展', reason: '常设展不用赶展期，适合行程第一天建立背景。', scene: '展馆' },
      { name: '美术馆或临时特展', reason: '特展可能限流或需预约，行前需自行核实。', scene: '展馆' },
    ],
  },
  {
    scene: '园林',
    keywords: ['园', '苑'],
    exclude: ['乐园', '动物园'],
    suggestions: [
      { name: '经典园林或公园的清早时段', reason: '园林类景点清早人少，体验更接近日常。', scene: '园林' },
      { name: '本地人常去的社区公园', reason: '社区公园免费且贴近本地生活节奏。', scene: '园林' },
    ],
  },
  {
    scene: '主题乐园',
    keywords: ['乐园', '动物园', '水族', '海洋馆'],
    suggestions: [
      { name: '乐园开园前的入园动线', reason: '乐园类建议赶开园，热门项目先排。', scene: '乐园' },
      { name: '园区外的配套餐饮街区', reason: '乐园周边常有餐饮街区，可作为闭园后的落点。', scene: '乐园' },
    ],
  },
  {
    scene: '温泉',
    keywords: ['温泉', '汤'],
    suggestions: [
      { name: '温泉街区的一处汤所', reason: '温泉目的地可把汤所安排在傍晚，缓解步行疲劳。', scene: '温泉' },
    ],
  },
  {
    scene: '冰雪',
    keywords: ['雪'],
    suggestions: [
      { name: '冰雪活动场地（雪场或滑冰场）', reason: '有冰雪的目的地可安排半日冰雪体验。', scene: '冰雪' },
      { name: '观景索道或山顶暖房', reason: '冰雪天户外停留短，选有暖气的观景点更舒适。', scene: '冰雪' },
    ],
  },
  {
    scene: '旷野',
    keywords: ['草原', '沙漠', '漠', '戈壁'],
    suggestions: [
      { name: '日出或日落观景点', reason: '旷野目的地视线开阔，晨昏时段最出效果。', scene: '旷野' },
      { name: '当地牧区或沙丘边缘的营地', reason: '不深入腹地也能体验地貌，注意往返车程。', scene: '旷野' },
    ],
  },
]

const UNIVERSAL_SUGGESTIONS: readonly ScenarioSuggestion[] = [
  { name: '当地早市或菜市场', reason: '想快速感受本地生活，早市比景点更直接。', scene: '市井' },
  { name: '城市制高点观景台', reason: '登高一趟就能对城市方位建立整体印象。', scene: '观景' },
  { name: '歇脚点：茶馆或咖啡馆', reason: '行程里留一处可以坐下来休息的落点。', scene: '休整' },
]

/** 建议条数上限；超出按固定顺序截断，保证输出确定。 */
const MAX_SUGGESTIONS = 10

/**
 * 与现有候选做「可能重复」提示。
 * 建议没有地址，完整 `candidateDedupeKey`（名称 + 地址）只在真正入库时判定；
 * 这里复用同一归一化：名称相同即提示，另外也接受完整 key 命中。
 */
function findDuplicateNames(
  existing: readonly Pick<CandidateItemV1, 'name' | 'address'>[],
  name: string,
): string[] {
  const nameKey = normalizeCandidateText(name)
  const dedupeKey = candidateDedupeKey({ name, address: null })
  return existing
    .filter(
      (candidate) =>
        normalizeCandidateText(candidate.name) === nameKey ||
        candidateDedupeKey(candidate) === dedupeKey,
    )
    .map((candidate) => candidate.name)
}

/**
 * 纯本地生成候选建议。零网络、零写入；同输入恒同输出。
 * 命中多个场景时按固定表顺序拼接，再接通用建议与节奏 / 天数补充。
 */
export function suggestCandidatePlaces(input: CandidateSuggestionInput): CandidateSuggestion[] {
  const destination = typeof input.destination === 'string' ? input.destination : ''
  const days = Number.isInteger(input.days) && input.days >= 1 ? input.days : 1
  const existing = input.existingCandidates ?? []
  const raw: ScenarioSuggestion[] = []

  for (const rule of SCENARIO_RULES) {
    if (rule.exclude !== undefined && rule.exclude.some((word) => destination.includes(word))) {
      continue
    }
    if (!rule.keywords.some((word) => destination.includes(word))) continue
    raw.push(...rule.suggestions)
  }
  raw.push(...UNIVERSAL_SUGGESTIONS)
  if (input.pace === 'compact') {
    raw.push({
      name: '半天留白：不安排具体点位',
      reason: '当前节奏偏紧，留半天机动，用来消化延误与临时兴趣。',
      scene: '休整',
    })
  }
  if (input.pace === 'relaxed') {
    raw.push({
      name: '周边小镇或邻区半日点',
      reason: '节奏宽松，可以考虑加一个邻近区域的半日点。',
      scene: '深度',
    })
  }
  if (days >= 4) {
    raw.push({
      name: '远郊半日点',
      reason: `行程共 ${days} 天，可考虑安排一次远郊往返。`,
      scene: '深度',
    })
  }

  const seen = new Set<string>()
  const result: CandidateSuggestion[] = []
  for (const item of raw) {
    if (seen.has(item.name)) continue
    seen.add(item.name)
    const duplicateOf = findDuplicateNames(existing, item.name)
    result.push({
      name: item.name,
      reason: item.reason,
      scene: item.scene,
      location: null,
      duplicateOf,
    })
    if (result.length >= MAX_SUGGESTIONS) break
  }
  return result
}

/**
 * 由草稿每天站点数推导节奏：日均 ≥5 站为紧凑、≤2 站为松散、其余均衡。
 * 只是建议输入的只读推断值；面板把结果显示给用户，不另存偏好。
 */
export function derivePaceFromDraftDayStopCounts(counts: readonly number[]): CandidatePaceV1 {
  if (counts.length === 0) return 'balanced'
  const total = counts.reduce((sum, value) => sum + value, 0)
  const average = total / counts.length
  if (average >= 5) return 'compact'
  if (average <= 2) return 'relaxed'
  return 'balanced'
}

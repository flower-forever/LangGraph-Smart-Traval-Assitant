/**
 * F5 · 出行准备清单 · 智能建议（二期 C-1）：纯本地规则生成携带物 / 准备事项。
 *
 * 边界：
 * - 零网络：只做「目的地关键词 + 月份季节 + 天数」的固定表匹配；
 *   不读写任何存储、不发 fetch、不读时钟（月份由调用方传入）；
 *   同输入恒同输出（确定性）。
 * - 建议只是待办点子，不是票务 / 库存 / 预约状态；不声称任何事项已预订或已确认。
 * - 本模块只返回数据，绝不直接改清单；采纳由面板显式调用
 *   `addChecklistItem`，新增条目一律 `done:false`，文案继续用「已准备 / 未准备」。
 * - 与清单现有条目标题（NFKC + 空白折叠 + 小写）相同时标记 `duplicateOf`；
 *   面板据此提示「清单里已有」，不自动合并、不自动跳过用户操作。
 */

import type { ChecklistCategoryV1, ChecklistItemV1 } from './workspaceTypes'

export type ChecklistSeason = 'spring' | 'summer' | 'autumn' | 'winter'

export const CHECKLIST_SEASON_LABELS: Readonly<Record<ChecklistSeason, string>> = {
  spring: '春季',
  summer: '夏季',
  autumn: '秋季',
  winter: '冬季',
}

/** 1–12 映射季节；null / 非整数 / 越界 = 不按季节推断。 */
export function checklistSuggestionSeason(month: number | null): ChecklistSeason | null {
  if (month === null || !Number.isInteger(month) || month < 1 || month > 12) return null
  if (month >= 3 && month <= 5) return 'spring'
  if (month >= 6 && month <= 8) return 'summer'
  if (month >= 9 && month <= 11) return 'autumn'
  return 'winter'
}

export interface ChecklistSuggestionInput {
  /** 目的地名称；只按包含的关键词做场景匹配，留空则只给通用建议。 */
  destination: string
  /** 行程天数；非正整数按 1 处理。 */
  days: number
  /** 出发月份 1–12；null = 不按季节推断。 */
  month: number | null
  /** 当前清单条目（只读标题），用于「清单里已有」提示；不会被修改。 */
  existingItems?: readonly Pick<ChecklistItemV1, 'title'>[]
}

export interface ChecklistSuggestion {
  /** 稳定的规则 id；只用于 React key / 丢弃状态，不是清单条目 id。 */
  id: string
  title: string
  category: ChecklistCategoryV1
  /** 一句话理由；采纳时写入条目备注。 */
  reason: string
  /** 与现有清单标题相同的条目；只提示，不自动合并。 */
  duplicateOf: string[]
}

interface RawSuggestion {
  id: string
  title: string
  category: ChecklistCategoryV1
  reason: string
}

/** 最基本的随身 / 证件事项：任何目的地、任何季节都值得核对。 */
const CORE_SUGGESTIONS: readonly RawSuggestion[] = [
  {
    id: 'doc-copy',
    title: '证件复印件与离线备份',
    category: 'document',
    reason: '证件丢失时，复印件或离线照片能加快补办；不要把证件照片发到不可信的服务。',
  },
  {
    id: 'charger',
    title: '手机充电器与数据线',
    category: 'luggage',
    reason: '每天导航与拍照都靠手机，充电配件按行程天数准备。',
  },
]

/** 优先级低于目的地 / 天气的通用补充项。 */
const EXTRA_SUGGESTIONS: readonly RawSuggestion[] = [
  {
    id: 'medicine',
    title: '常用药与创可贴',
    category: 'luggage',
    reason: '异地买药不方便，按自己的用药习惯带少量基础药品。',
  },
  {
    id: 'hotel-contact',
    title: '住宿地址与前台电话（离线保存）',
    category: 'todo',
    reason: '到店前可能没有网络，把地址和电话保存在离线位置。',
  },
]

interface DestinationRule {
  keywords: readonly string[]
  suggestions: readonly RawSuggestion[]
}

const DESTINATION_RULES: readonly DestinationRule[] = [
  {
    keywords: ['海', '岛', '湾', '滩', '滨', '礁'],
    suggestions: [
      {
        id: 'sea-shoes',
        title: '沙滩鞋或防滑拖鞋',
        category: 'luggage',
        reason: '海滨路面湿滑，普通鞋袜容易打湿且不好干。',
      },
      {
        id: 'sea-swim',
        title: '泳衣或速干衣物',
        category: 'luggage',
        reason: '有海滩或水上活动时，速干衣物比棉质衣物更实用。',
      },
      {
        id: 'sea-sun',
        title: '防晒霜与遮阳帽',
        category: 'luggage',
        reason: '海边紫外线反射强，阴天也建议防晒。',
      },
    ],
  },
  {
    keywords: ['山', '峰', '岭', '岳', '峡', '谷'],
    suggestions: [
      {
        id: 'mountain-shoes',
        title: '防滑徒步鞋',
        category: 'luggage',
        reason: '山地石阶与土路湿滑，普通平底鞋抓地力不够。',
      },
      {
        id: 'mountain-jacket',
        title: '薄外套或防风衣',
        category: 'luggage',
        reason: '山上风大且早晚温差明显，比城区更需要一件外套。',
      },
    ],
  },
  {
    keywords: ['雪', '冰'],
    suggestions: [
      {
        id: 'snow-gloves',
        title: '保暖手套与帽子',
        category: 'luggage',
        reason: '冰雪目的地体感温度低，手部和头部最容易失温。',
      },
      {
        id: 'snow-boots',
        title: '防滑雪地靴',
        category: 'luggage',
        reason: '结冰路面需要防滑鞋底，普通运动鞋容易打滑。',
      },
    ],
  },
  {
    keywords: ['温泉', '汤'],
    suggestions: [
      {
        id: 'onsen-swim',
        title: '泳衣与防水袋',
        category: 'luggage',
        reason: '温泉 / 汤所可能要求泳衣或分装湿衣物，先按场所规则确认。',
      },
    ],
  },
  {
    keywords: ['乐园', '动物园', '水族', '海洋馆'],
    suggestions: [
      {
        id: 'park-ticket',
        title: '门票或预约凭证（离线保存）',
        category: 'ticket',
        reason: '乐园类入园常需扫码或核对预约，提前保存离线凭证。',
      },
      {
        id: 'park-power',
        title: '充电宝（按园区 / 承运要求）',
        category: 'luggage',
        reason: '园区停留时间长，拍照与排队都耗电；容量需符合携带规定。',
      },
    ],
  },
  {
    keywords: ['博物馆', '美术馆', '展馆'],
    suggestions: [
      {
        id: 'museum-id',
        title: '预约凭证与身份证',
        category: 'document',
        reason: '展馆常需实名预约或现场核验，证件与凭证分开放更稳妥。',
      },
    ],
  },
  {
    keywords: ['古城', '古镇', '寺', '庙', '塔', '老街'],
    suggestions: [
      {
        id: 'oldtown-shoes',
        title: '舒适步行鞋',
        category: 'luggage',
        reason: '古城 / 老街多为石板路，步行时间长，鞋底缓震很重要。',
      },
    ],
  },
]

const SEASON_RULES: Readonly<Record<ChecklistSeason, readonly RawSuggestion[]>> = {
  spring: [
    {
      id: 'spring-jacket',
      title: '薄外套（早晚温差）',
      category: 'luggage',
      reason: '春季昼夜温差大，中午与早晚体感差异明显。',
    },
    {
      id: 'spring-mask',
      title: '花粉口罩（如有过敏）',
      category: 'luggage',
      reason: '春季花粉浓度高，过敏人群可提前准备口罩。',
    },
  ],
  summer: [
    {
      id: 'summer-sun',
      title: '防晒霜（SPF 30+）',
      category: 'luggage',
      reason: '夏季紫外线强，户外活动需要补涂防晒。',
    },
    {
      id: 'summer-hat',
      title: '遮阳帽与太阳镜',
      category: 'luggage',
      reason: '正午户外遮阳能明显降低体感温度。',
    },
    {
      id: 'summer-mosquito',
      title: '驱蚊液',
      category: 'luggage',
      reason: '夏季傍晚户外蚊虫多，尤其是水边与绿地。',
    },
  ],
  autumn: [
    {
      id: 'autumn-jacket',
      title: '薄外套与长裤',
      category: 'luggage',
      reason: '秋季降温快，早晚需要比白天多一层衣物。',
    },
    {
      id: 'autumn-lip',
      title: '润唇膏与面霜',
      category: 'luggage',
      reason: '秋季空气干燥，长时间户外容易嘴唇与皮肤干裂。',
    },
  ],
  winter: [
    {
      id: 'winter-thermal',
      title: '保暖内衣与手套',
      category: 'luggage',
      reason: '冬季户外停留时，分层保暖比单件厚衣更灵活。',
    },
    {
      id: 'winter-lip',
      title: '润唇膏与面霜',
      category: 'luggage',
      reason: '冬季干冷，风大时嘴唇与皮肤容易干裂。',
    },
  ],
}

const RAIN_MONTHS: readonly number[] = [4, 5, 6, 7, 8, 9]
const RAIN_KEYWORDS: readonly string[] = ['雨', '江南', '海', '岛', '湾', '滩', '滨']

const RAIN_SUGGESTIONS: readonly RawSuggestion[] = [
  {
    id: 'rain-umbrella',
    title: '折叠伞或轻便雨衣',
    category: 'luggage',
    reason: '雨季或水边目的地阵雨多，轻便雨具比一次性雨衣耐用。',
  },
  {
    id: 'rain-drybag',
    title: '防水袋（证件与电子设备）',
    category: 'luggage',
    reason: '把证件、手机和充电宝集中防水，突然下雨时不至于手忙脚乱。',
  },
]

/** 建议条数上限；超出按固定顺序截断，保证输出确定。 */
const MAX_SUGGESTIONS = 10

function normalizeTitle(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

function validMonth(value: number | null): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 12
    ? value
    : null
}

/**
 * 纯本地生成清单建议。零网络、零写入；同输入恒同输出。
 * 顺序固定：核心证件 / 充电 → 目的地场景 → 雨具 → 季节 → 天数 → 通用补充。
 */
export function suggestChecklistItems(input: ChecklistSuggestionInput): ChecklistSuggestion[] {
  const destination = typeof input.destination === 'string' ? input.destination : ''
  const days = Number.isInteger(input.days) && input.days >= 1 ? input.days : 1
  const existing = input.existingItems ?? []
  const month = validMonth(input.month)
  const season = checklistSuggestionSeason(month)
  const raw: RawSuggestion[] = [...CORE_SUGGESTIONS]

  for (const rule of DESTINATION_RULES) {
    if (rule.keywords.some((word) => destination.includes(word))) raw.push(...rule.suggestions)
  }

  const rainySeason = month !== null && RAIN_MONTHS.includes(month)
  const rainyDestination = RAIN_KEYWORDS.some((word) => destination.includes(word))
  if (rainySeason || rainyDestination) raw.push(...RAIN_SUGGESTIONS)

  if (season !== null) raw.push(...SEASON_RULES[season])

  if (days >= 4) {
    raw.push({
      id: 'days-laundry',
      title: '换洗衣物与收纳袋',
      category: 'luggage',
      reason: `行程共 ${days} 天，按天数准备换洗衣物，并留出装脏衣物的收纳袋。`,
    })
  }
  if (days >= 6) {
    raw.push({
      id: 'days-detergent',
      title: '旅行装洗衣液或晾衣绳',
      category: 'luggage',
      reason: '超过一周的行程可考虑途中简单洗衣，减少随身行李重量。',
    })
  }

  raw.push(...EXTRA_SUGGESTIONS)

  const seen = new Set<string>()
  const result: ChecklistSuggestion[] = []
  for (const item of raw) {
    const key = normalizeTitle(item.title)
    if (seen.has(key)) continue
    seen.add(key)
    const duplicateOf = [
      ...new Set(
        existing
          .filter((existingItem) => normalizeTitle(existingItem.title) === key)
          .map((existingItem) => existingItem.title),
      ),
    ]
    result.push({
      id: item.id,
      title: item.title,
      category: item.category,
      reason: item.reason,
      duplicateOf,
    })
    if (result.length >= MAX_SUGGESTIONS) break
  }
  return result
}

/**
 * S6 · 个性化兴趣：结构化兴趣标签（五期计划 §7.2）。
 *
 * 边界（与 stopFacts / routeFlow 同一纪律）：
 * - **纯常量与纯函数**：零存储、零网络、零副作用；同输入同输出。
 * - 兴趣永远是**可选增强**：不选就不进请求体（旧请求逐字节兼容）；
 *   选了也只是把偏好告诉规划器，不承诺「一定安排到」，不给兴趣打分。
 * - 枚举值固定 6 个，前后端共用同一套取值；未知值一律丢弃而不是透传。
 * - 顺序按枚举固定顺序归一（history → food → nature → photo → family → elder_friendly），
 *   同一组兴趣永远序列化成同一个请求体，便于去重与断言。
 */

/** 兴趣枚举：与后端 interests 字段同一套取值。 */
export type PlanInterest =
  | 'history'
  | 'food'
  | 'nature'
  | 'photo'
  | 'family'
  | 'elder_friendly'

/** 固定顺序；序列化与展示都按这个顺序走。 */
export const PLAN_INTEREST_VALUES: readonly PlanInterest[] = [
  'history',
  'food',
  'nature',
  'photo',
  'family',
  'elder_friendly',
]

/** 表单选项：label 是给用户看的中文名，help 是一句话说明。 */
export const INTEREST_OPTIONS: ReadonlyArray<{
  value: PlanInterest
  label: string
  help: string
}> = [
  { value: 'history', label: '历史', help: '古迹、老街、博物馆与历史街区' },
  { value: 'food', label: '美食', help: '本地小吃、特色餐厅与地方饮食' },
  { value: 'nature', label: '自然', help: '山水、公园、湖面与户外景观' },
  { value: 'photo', label: '拍照', help: '出片机位、观景角度与适合停留的机位' },
  { value: 'family', label: '亲子', help: '适合带孩子走的动线与场馆' },
  { value: 'elder_friendly', label: '老人友好', help: '少爬坡、少换乘、动线平缓' },
]

const INTEREST_LABELS: Record<PlanInterest, string> = {
  history: '历史',
  food: '美食',
  nature: '自然',
  photo: '拍照',
  family: '亲子',
  elder_friendly: '老人友好',
}

/** 中文展示名；未知值不会进来（normalizeInterests 已过滤）。 */
export function interestLabelOf(value: PlanInterest): string {
  return INTEREST_LABELS[value]
}

/** 是否是受支持的兴趣取值。 */
export function isPlanInterest(value: unknown): value is PlanInterest {
  return typeof value === 'string' && (PLAN_INTEREST_VALUES as readonly string[]).includes(value)
}

/**
 * 归一化一组兴趣：丢弃未知值、去重、按枚举固定顺序排序。
 * 空数组是合法结果（= 不选兴趣）。
 */
export function normalizeInterests(values: readonly unknown[] | null | undefined): PlanInterest[] {
  if (!Array.isArray(values)) return []
  const picked = new Set<PlanInterest>()
  for (const value of values) {
    if (isPlanInterest(value)) picked.add(value)
  }
  return PLAN_INTEREST_VALUES.filter((value) => picked.has(value))
}

/**
 * 展示文案：「历史、美食」。空数组返回空字符串（调用方据此不渲染标注）。
 */
export function interestSummary(values: readonly PlanInterest[]): string {
  return normalizeInterests(values).map(interestLabelOf).join('、')
}

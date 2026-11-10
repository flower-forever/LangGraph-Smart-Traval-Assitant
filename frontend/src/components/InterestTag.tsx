/**
 * S6 · 结果页的「兴趣」标注（五期计划 §7.2）。
 *
 * 边界：
 * - 只展示用户当时勾选过的兴趣；不选就不渲染任何标注。
 * - 只写「兴趣：历史、美食」这类事实，**不显示伪精确评分**，
 *   也不暗示这些兴趣一定被安排到了。
 * - 组件自带样式，不依赖 App.tsx 里的局部常量，便于单独测试。
 */

import { interestSummary, type PlanInterest } from '../lib/interests'

/** 与 App.tsx TRIP_SOURCE_TAG 同款的标签样式（agent 配色）。 */
const TAG_CLASS =
  'mb-3 inline-block rounded-full border border-[color:var(--color-line-strong)] bg-secondary px-[10px] py-[3px] text-xs font-semibold tracking-[0.1em] text-[color:var(--color-secondary-foreground)]'

export interface InterestTagProps {
  /** 用户勾选的兴趣；空数组不渲染。 */
  interests: readonly PlanInterest[]
}

export default function InterestTag({ interests }: InterestTagProps) {
  const summary = interestSummary(interests)
  if (summary.length === 0) return null
  return (
    <span
      className={TAG_CLASS}
      data-testid="interest-tag"
      data-interests={interests.join(',')}
      title="这是你在规划时勾选的兴趣偏好，不代表一定安排到了这些内容。"
    >
      兴趣：{summary}
    </span>
  )
}

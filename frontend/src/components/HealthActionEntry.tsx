/**
 * S8 · 体检条目级动作入口（「建议顺延」/「补一餐」）。
 *
 * 真实挂载点由 PM 接入 ItineraryHealthCard 的条目 `<li>` 内（作者禁改 App.tsx；
 * 本组件保持独立，卡片仍可无动作纯展示）。只对 `notice` 级别的
 * `pace` / `meal_gap` 条目出现；`unknown` 说明数据不足，不能给出会写草稿的方案。
 *
 * 纯展示：点击只把条目交回父级，由父级决定打开哪个 lazy 面板；零存储、零网络。
 */

import type { HealthItem } from '../lib/itineraryHealth'

export interface HealthActionEntryProps {
  item: HealthItem
  /** 打开「建议顺延」面板；缺省 = 该条目不给顺延入口。 */
  onSuggestPostpone?: (item: HealthItem) => void
  /** 打开「补一餐」面板；缺省 = 该条目不给补餐入口。 */
  onSuggestMeal?: (item: HealthItem) => void
}

const ACTION_BUTTON_CLASS =
  'min-h-8 cursor-pointer rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-3 py-1 text-xs hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent-foreground)]'

export default function HealthActionEntry({
  item,
  onSuggestPostpone,
  onSuggestMeal,
}: HealthActionEntryProps) {
  if (item.level !== 'notice') return null
  const showPostpone = item.code === 'pace' && onSuggestPostpone !== undefined
  const showMeal = item.code === 'meal_gap' && onSuggestMeal !== undefined
  if (!showPostpone && !showMeal) return null

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2"
      data-testid="health-action-entry"
      data-health-code={item.code}
    >
      {showPostpone && (
        <button
          type="button"
          data-testid="health-suggest-postpone"
          className={ACTION_BUTTON_CLASS}
          onClick={() => onSuggestPostpone?.(item)}
        >
          建议顺延
        </button>
      )}
      {showMeal && (
        <button
          type="button"
          data-testid="health-suggest-meal"
          className={ACTION_BUTTON_CLASS}
          onClick={() => onSuggestMeal?.(item)}
        >
          补一餐
        </button>
      )}
    </div>
  )
}

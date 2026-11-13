import type { CityGroup } from '../lib/cityScope'
import { cn } from '../lib/utils'

/**
 * 七期 S3 城市分段导航。
 *
 * - 纯展示：不持有状态、不发请求，跳转完全交给 `onJump`。
 * - `groups.length <= 1` 直接返回 null：单城旧行程零 DOM、零视觉变化。
 * - `aria-pressed` 表示当前天落在该城市段；禁用时按钮整体不可点。
 */

export interface CitySegmentsProps {
  groups: CityGroup[]
  activeDay: number
  onJump: (day: number) => void
  disabled?: boolean
}

const BUTTON =
  'inline-flex min-h-8 cursor-pointer items-center justify-center rounded-[4px] px-3 py-1 text-xs leading-[1.4] transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent-foreground)]'

export default function CitySegments({ groups, activeDay, onJump, disabled = false }: CitySegmentsProps) {
  if (groups.length <= 1) return null

  return (
    <nav
      aria-label="城市分段"
      data-testid="city-segments"
      className="mb-3 flex w-fit flex-wrap items-center gap-1 rounded-[6px] border border-[color:var(--color-line-strong)] bg-background p-0.5"
    >
      {groups.map((group) => {
        const active = activeDay >= group.fromDay && activeDay <= group.toDay
        return (
          <button
            key={`${group.city}:${group.fromDay}`}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            data-city={group.city}
            data-from-day={group.fromDay}
            data-to-day={group.toDay}
            onClick={() => onJump(group.fromDay)}
            className={cn(
              BUTTON,
              active
                ? 'bg-accent-surface font-semibold text-[color:var(--color-accent-foreground)]'
                : 'text-[color:var(--color-secondary-foreground)] hover:bg-secondary',
              disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
            )}
          >
            {group.city} · {group.days.length} 天
          </button>
        )
      })}
    </nav>
  )
}

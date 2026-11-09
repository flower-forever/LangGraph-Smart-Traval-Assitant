/**
 * 主题切换控件（四期 S2）：跟随系统 / 浅色 / 深色 三态分段按钮。
 * 无自己的状态，读写全在 useTheme（存储键与 DOM 落点见 lib/theme.ts）。
 * 放在 App header 的后端状态胶囊同一组里；窄屏由外层 flex-wrap 换行，不挤破 375。
 */
import { useTheme } from '@/lib/useTheme'
import type { ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

function ThemeToggle() {
  const { preference, setPreference } = useTheme()

  return (
    <div
      role="group"
      aria-label="主题"
      data-testid="theme-toggle"
      className="flex flex-wrap items-center gap-1 rounded-[6px] border border-[color:var(--color-line-strong)] bg-background p-0.5"
    >
      {OPTIONS.map(({ value, label }) => {
        const active = preference === value
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => setPreference(value)}
            className={cn(
              'inline-flex min-h-7 cursor-pointer items-center justify-center rounded-[4px] px-2 py-0.5 text-xs leading-[1.4] transition-colors duration-150 ease-out',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent-foreground)]',
              active
                ? 'bg-accent-surface font-semibold text-[color:var(--color-accent-foreground)]'
                : 'text-[color:var(--color-secondary-foreground)] hover:bg-secondary',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

export default ThemeToggle

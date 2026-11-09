import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Checkbox（手工落盘，原生 input 兜底）：Radix checkbox 需要额外依赖且 jsdom
 * 适配，本仓 checked 受控用法与原生一致。整行 label 包裹（A11 命中区 ≥24px），
 * 保留 role=checkbox / aria 属性语义，样式按宣纸主题勾选态。
 *
 * 技术限制（W2 验收登记）：SVG data-URI 里的勾选 stroke 色无法用 CSS 变量，
 * 下面 %23faf6ea 是浅色 theme.css --card（oklch(98.4% 0.008 85)）的 sRGB 近似值
 * （浅色勾选态 = 朱砂底 + 纸色勾）；四期 S2 深色下 --primary 提亮，勾色改用深墨
 * %2316140f（.dark 下 --primary-foreground = oklch(19% 0.01 85) 的 sRGB 近似），
 * 用 dark: 变体切换。深色未选中态用 dark:bg-none 隐藏勾图（否则深墨勾叠在
 * 深 card 上约 1.13:1，只剩极淡可见的噪点）；只有 checked 才显示深色勾。
 * 改主题时需同步这些值（theme.css 是唯一权威）。
 */
function Checkbox({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        'size-4 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-input bg-card',
        'transition-colors duration-150 ease-out',
        'checked:border-primary checked:bg-primary',
        'bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20fill%3D%27none%27%20stroke%3D%27%23faf6ea%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%20d%3D%27M3%208.5l3.2%203.2L13%205%27%2F%3E%3C%2Fsvg%3E")] dark:bg-none dark:checked:bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20fill%3D%27none%27%20stroke%3D%27%2316140f%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%20d%3D%27M3%208.5l3.2%203.2L13%205%27%2F%3E%3C%2Fsvg%3E")]',
        'bg-[length:12px_12px] bg-[center] bg-no-repeat',
        'checked:bg-primary',
        'disabled:cursor-not-allowed disabled:opacity-55 disabled:bg-secondary disabled:.checked:bg-secondary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className,
      )}
      {...props}
    />
  )
}

export { Checkbox }

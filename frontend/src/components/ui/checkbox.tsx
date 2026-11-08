import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Checkbox（手工落盘，原生 input 兜底）：Radix checkbox 需要额外依赖且 jsdom
 * 适配，本仓 checked 受控用法与原生一致。整行 label 包裹（A11 命中区 ≥24px），
 * 保留 role=checkbox / aria 属性语义，样式按宣纸主题勾选态。
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
        'bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20fill%3D%27none%27%20stroke%3D%27%23faf6ea%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%20d%3D%27M3%208.5l3.2%203.2L13%205%27%2F%3E%3C%2Fsvg%3E")]',
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

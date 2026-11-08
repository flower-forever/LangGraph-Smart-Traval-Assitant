import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Select（手工落盘，原生 select 兜底）：现有面板全部用原生 select + label，
 * 测试用 user.selectOptions 依赖原生行为；引入 Radix Select 属行为变化，
 * 不在本波范围。样式与 Input 同一描边 / 凹面底。
 */
function Select({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      data-slot="select"
      className={cn(
        'flex h-9 w-full min-w-0 cursor-pointer appearance-none rounded-[6px] border border-input bg-secondary px-3 py-1 pr-8 text-base',
        'bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%2712%27%20height%3D%2712%27%20viewBox%3D%270%200%2012%2012%27%3E%3Cpath%20fill%3D%27none%27%20stroke%3D%27%23405640%27%20stroke-width%3D%271.5%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%20d%3D%27M3%204.5l3%203%203-3%27%2F%3E%3C%2Fsvg%3E")] bg-[length:12px_12px] bg-[right_0.5rem_center] bg-no-repeat',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'aria-invalid:border-destructive',
        'disabled:cursor-not-allowed disabled:opacity-55',
        className,
      )}
      {...props}
    />
  )
}

export { Select }

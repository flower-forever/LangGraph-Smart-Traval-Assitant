import * as React from 'react'
import { cn } from '@/lib/utils'

/** shadcn/ui Input（new-york 变体，手工落盘）。底色用凹面 paper-3（--secondary），单层描边。 */
function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-[6px] border border-input bg-secondary px-3 py-1 text-base',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'aria-invalid:border-destructive',
        'disabled:pointer-events-none disabled:opacity-55 disabled:bg-secondary disabled:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Input }

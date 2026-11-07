import * as React from 'react'
import { cn } from '@/lib/utils'

/** shadcn/ui Badge（new-york 变体，手工落盘）。UI_DESIGN §3.2：Badge 只保留五档。 */
const badgeVariants = {
  default: 'border-transparent bg-primary text-primary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  outline: 'border-border bg-transparent text-muted-foreground',
  warning: 'border-transparent bg-[var(--color-warn-bg)] text-[var(--color-warn-ink)]',
  success: 'border-transparent bg-[var(--color-ok)]/15 text-[var(--color-ok)]',
} as const

export type BadgeVariant = keyof typeof badgeVariants

export interface BadgeProps extends React.ComponentProps<'span'> {
  variant?: BadgeVariant
}

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      data-variant={variant}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-none',
        badgeVariants[variant],
        className,
      )}
      {...props}
    />
  )
}

export { Badge, badgeVariants }

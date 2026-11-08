import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * Alert（shadcn/ui new-york 变体，手工落盘）。
 * UI_DESIGN 映射表：.error-banner / .adp-error / .drp-error / 提示条 → Alert。
 * variant：default（中性）/ destructive（危险、role=alert 场景）/
 * warning（琥珀）/ success（就绪）。role 由使用方显式给（不合并语义）。
 */
const alertVariants = {
  default: 'border-border bg-card text-card-foreground',
  destructive:
    'border-destructive/60 bg-destructive/10 text-destructive [&>svg]:text-destructive',
  warning:
    'border-[var(--color-warn-ink)]/40 bg-[var(--color-warn-bg)] text-[var(--color-warn-ink)]',
  success:
    'border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 text-[var(--color-ok)]',
} as const

export type AlertVariant = keyof typeof alertVariants

export interface AlertProps extends React.ComponentProps<'div'> {
  variant?: AlertVariant
}

function Alert({ className, variant = 'default', ...props }: AlertProps) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role={undefined}
      className={cn(
        'relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-[6px] border px-3 py-2.5 text-sm',
        'has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-2.5',
        alertVariants[variant],
        className,
      )}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight', className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'col-start-2 grid justify-items-start gap-1 text-sm text-current/85 [&_p]:leading-relaxed',
        className,
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }

import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn/ui Field（new-york 变体，手工落盘）。
 * 映射表：.field-label / .field-help → Field + FieldDescription；保留 htmlFor / aria-describedby。
 * FieldError 不带默认 role：与迁移前的 .field-error（无 role=alert）语义一致；
 * 需要 live region 的调用方显式传 role="alert"。
 */
function Field({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field"
      className={cn('flex flex-col gap-1.5', className)}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="field-label"
      className={cn('text-sm font-medium leading-none text-foreground', className)}
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-xs leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  )
}

function FieldError({ className, role, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      role={role}
      data-slot="field-error"
      className={cn('text-xs leading-relaxed text-destructive', className)}
      {...props}
    />
  )
}

export { Field, FieldLabel, FieldDescription, FieldError }

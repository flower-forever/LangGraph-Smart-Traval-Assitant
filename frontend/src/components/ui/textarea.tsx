import * as React from 'react'
import { cn } from '@/lib/utils'

/** shadcn/ui Textarea（new-york 变体，手工落盘）。与 Input 同一描边 / 凹面底。 */
function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-16 w-full rounded-[6px] border border-input bg-secondary px-3 py-2 text-base',
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

export { Textarea }

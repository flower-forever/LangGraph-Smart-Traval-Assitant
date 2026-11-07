import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn/ui Button（new-york 变体，手工落盘：components.json 已配好，不走 CLI）。
 * 语义变量来自 src/theme.css（宣纸/朱砂桥接）。
 * 注意：迁移期不用 bg-accent / bg-muted 工具类（tokens.css 同名冲突），
 * 需要 accent 底色时用 bg-accent-surface / bg-muted-surface（见 UI_DESIGN.md §2.4）。
 */
const buttonVariants = {
  default:
    'bg-primary text-primary-foreground shadow-none hover:bg-primary/90',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline:
    'border border-border bg-transparent text-foreground hover:bg-secondary',
  ghost: 'bg-transparent text-foreground hover:bg-secondary',
  destructive:
    'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  link: 'text-primary underline-offset-4 hover:underline',
}

const buttonSizes = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 px-3 text-sm',
  lg: 'h-10 px-6',
  icon: 'size-9',
}

export type ButtonVariant = keyof typeof buttonVariants
export type ButtonSize = keyof typeof buttonSizes

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

function Button({ className, variant = 'default', size = 'default', type = 'button', ...props }: ButtonProps) {
  return (
    <button
      type={type}
      data-variant={variant}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[6px] text-sm font-medium',
        'transition-colors duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'disabled:pointer-events-none disabled:opacity-55 disabled:bg-secondary disabled:text-muted-foreground',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    />
  )
}

export { Button, buttonVariants }

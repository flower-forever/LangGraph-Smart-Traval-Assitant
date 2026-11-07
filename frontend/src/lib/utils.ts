import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui 约定的 class 合并助手：clsx 处理条件类名，tailwind-merge 去重冲突的工具类 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

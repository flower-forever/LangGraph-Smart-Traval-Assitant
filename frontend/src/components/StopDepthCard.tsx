import { lazy, Suspense } from 'react'

import type { TripStop } from '../lib/api'

/**
 * 六期 S5 景点深度卡 · 懒加载边界。
 *
 * 投影与实现都放在 `StopDepthCardContent` / `lib/stopDepth.ts`，由 `lazy()`
 * 按需加载；主包只保留本包装器与最小的存在性检查，避免主包回涨。
 * `StopPoiCard` 静态引用本文件即可，不需要再包一层 lazy/Suspense。
 */

export interface StopDepthCardProps {
  stop: TripStop
}

const StopDepthCardContent = lazy(() => import('./StopDepthCardContent'))

/**
 * 只判断「有没有任一深度块」，不做内容清洗；完整投影留在懒加载实现体里。
 * 旧行程没有深度字段 → 直接不渲染，也不会闪一次 loading。
 */
function hasAnyDepth(stop: TripStop): boolean {
  return Boolean(
    stop.highlights || stop.suitableFor || stop.suggestedStayMinutes || stop.tips,
  )
}

function StopDepthLoadingFallback() {
  return (
    <div
      className="mt-3 rounded-[8px] border border-[color:var(--color-line-strong)] bg-secondary/50 px-3 py-2 text-xs text-[color:var(--color-secondary-foreground)]"
      role="status"
      aria-live="polite"
      data-testid="stop-depth-loading"
    >
      正在加载景点深度…
    </div>
  )
}

export default function StopDepthCard(props: StopDepthCardProps) {
  if (!hasAnyDepth(props.stop)) return null
  return (
    <Suspense fallback={<StopDepthLoadingFallback />}>
      <StopDepthCardContent {...props} />
    </Suspense>
  )
}

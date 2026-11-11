import { lazy, Suspense } from 'react'

import type { Trip } from '../lib/api'
import { DETOUR_INTERCEPT_MIN_KM } from '../lib/detourThresholds'
import type { DetourInterceptCardProps } from './DetourInterceptContent'

/**
 * 六期 S7 · 绕行拦截卡 lazy 边界。
 *
 * 真实实现（投影 + 卡片）在 `DetourInterceptContent`，由 `lazy()` 按需加载；
 * 主包只留这个极小的包装器与必要条件预筛。
 *
 * PM 接线时动态 import 本文件，在行程区顶部挂载即可，不需要在 App.tsx 再包一层
 * lazy/Suspense。
 */

const DetourInterceptContent = lazy(() => import('./DetourInterceptContent'))

/**
 * 轻量预筛：命中条件含「实际里程 ≥ 30km」，所以没有任何 ≥30km 路段的行程一定不会
 * 命中。这里只做必要条件判断（不引入 haversine/倍数逻辑），既不会漏掉命中，也避免
 * 为普通行程加载独立 chunk。阈值与 `detourThresholds.ts` 同源。
 */
function mayHaveDetour(trip: Trip | null | undefined): boolean {
  const days = trip?.days
  if (!Array.isArray(days)) return false
  for (const day of days) {
    const legs = day?.legs
    if (!Array.isArray(legs)) continue
    for (const leg of legs) {
      if (
        typeof leg?.distance_m === 'number' &&
        Number.isFinite(leg.distance_m) &&
        leg.distance_m >= DETOUR_INTERCEPT_MIN_KM * 1000
      ) {
        return true
      }
    }
  }
  return false
}

function DetourInterceptLoadingFallback() {
  return (
    <div
      className="mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-4 py-3 text-sm text-[color:var(--color-secondary-foreground)]"
      role="status"
      aria-live="polite"
      data-testid="detour-intercept-loading"
    >
      正在核对绕行路段…
    </div>
  )
}

export default function DetourInterceptCard(props: DetourInterceptCardProps) {
  if (!mayHaveDetour(props.trip)) return null
  return (
    <Suspense fallback={<DetourInterceptLoadingFallback />}>
      <DetourInterceptContent {...props} />
    </Suspense>
  )
}

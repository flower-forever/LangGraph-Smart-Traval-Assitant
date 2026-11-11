import { lazy, Suspense } from 'react'

import type { Trip } from '../lib/api'
import type { CoverageCardProps } from './CoverageCardContent'

/**
 * 六期 S6 选择充分度卡 · 懒加载边界。
 *
 * 组件实现与 `lib/tripCoverage.ts` 投影都放在 `CoverageCardContent` 里，
 * 由 `lazy()` 按需加载；主包只保留本包装器与最小的存在性检查，避免主包回涨。
 * PM 接线时静态 import 本文件（`import CoverageCard from './components/CoverageCard'`），
 * 在行程区城市卡之后挂一行即可；不需要在 App.tsx 再包一层 lazy/Suspense。
 */

const CoverageCardContent = lazy(() => import('./CoverageCardContent'))

/**
 * 只判断「有没有可用 classicList」，不做内容清洗；完整投影留在懒加载实现体里。
 * 无 cityProfile / 无 classicList → 直接不渲染，也不会闪一次 loading（无伪统计）。
 */
function hasClassicList(trip: Trip | null | undefined): boolean {
  return Boolean(
    trip?.cityProfile &&
      Array.isArray(trip.cityProfile.classicList) &&
      trip.cityProfile.classicList.length > 0,
  )
}

function CoverageCardLoadingFallback() {
  return (
    <div
      className="mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-4 py-3 text-sm text-[color:var(--color-secondary-foreground)]"
      role="status"
      aria-live="polite"
      data-testid="trip-coverage-loading"
    >
      正在加载选择充分度…
    </div>
  )
}

export default function CoverageCard(props: CoverageCardProps) {
  if (!hasClassicList(props.trip)) return null
  return (
    <Suspense fallback={<CoverageCardLoadingFallback />}>
      <CoverageCardContent {...props} />
    </Suspense>
  )
}

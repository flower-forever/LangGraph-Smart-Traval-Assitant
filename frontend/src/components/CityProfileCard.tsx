import { lazy, Suspense } from 'react'

import type { CityProfileCardProps } from './CityProfileCardContent'

/**
 * 六期 S4 城市导览卡 · 懒加载边界。
 *
 * 组件实现与 `lib/cityProfile.ts` 投影都放在 `CityProfileCardContent` 里，
 * 由 `lazy()` 按需加载；主包只保留本包装器与 Suspense fallback。
 * PM 接线时静态 import 本文件即可（`import CityProfileCard from './components/CityProfileCard'`），
 * 不需要在 App.tsx 再包一层 lazy/Suspense。
 */

const CityProfileCardContent = lazy(() => import('./CityProfileCardContent'))

function CityProfileLoadingFallback() {
  return (
    <div
      className="mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-4 py-3 text-sm text-[color:var(--color-secondary-foreground)]"
      role="status"
      aria-live="polite"
      data-testid="city-profile-loading"
    >
      正在加载城市导览…
    </div>
  )
}

export default function CityProfileCard(props: CityProfileCardProps) {
  return (
    <Suspense fallback={<CityProfileLoadingFallback />}>
      <CityProfileCardContent {...props} />
    </Suspense>
  )
}

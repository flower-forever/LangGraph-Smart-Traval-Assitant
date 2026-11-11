import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { Trip } from '../lib/api'
import {
  formatDetourEvidence,
  formatDetourRatio,
  projectDetourIntercept,
} from '../lib/detourIntercept'

/**
 * 六期 S7 · 绕行拦截卡（真实实现体）。
 *
 * - 只由 `DetourInterceptCard.tsx` 的 `lazy(() => import(...))` 加载，独立 chunk；
 *   卡片只在规划结果存在可疑绕行时出现，不增加主包常驻成本。
 * - 纯派生：输入 trip.days 即得命中清单，不写存储、不发请求、不改行程。
 * - 两个动作：「保留原样」（调 onKeep，父级把本次行程加入会话内抑制集合）与
 *   「去调整」（调 onGoAdjust(day)，父级跳现有编辑器并选中该天）。
 * - 文案不恐吓：只说「绕行较远，可能不是最优路线」；不宣称路线错误，也不自动改。
 * - 无命中完全不渲染（不显示「未发现绕行」这类伪结论）。
 */

export interface DetourInterceptCardProps {
  trip?: Trip | null
  /** 用户选择「保留原样」；父级负责本次行程在会话内不再自动弹。 */
  onKeep?: () => void
  /** 用户选择「去调整」；参数为第一条命中路段所在天号。 */
  onGoAdjust?: (day: number) => void
}

export default function DetourInterceptCardContent({
  trip,
  onKeep,
  onGoAdjust,
}: DetourInterceptCardProps) {
  // 本地也做一次即时收起：即使父级状态更新被延迟，点过「保留原样」后卡片也不会
  // 停在原地。会话级的「同一次行程不重弹」仍由父级的按 trip id 集合负责。
  const tripKey = trip?.id ?? ''
  const [keptTripKey, setKeptTripKey] = useState<string | null>(null)

  const hits = projectDetourIntercept(trip?.days ?? null)
  if (hits.length === 0) return null
  if (keptTripKey !== null && keptTripKey === tripKey) return null

  const handleKeep = () => {
    setKeptTripKey(tripKey)
    onKeep?.()
  }

  const firstDay = hits[0].day

  return (
    <section
      data-testid="detour-intercept-card"
      aria-label="绕行提示"
      className="mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-4 py-3 text-sm leading-relaxed"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 font-semibold">
          绕行较远的路段
          <span
            data-testid="detour-intercept-count"
            className="ml-2 font-normal text-[color:var(--color-faint)]"
          >
            共 {hits.length} 段
          </span>
        </p>
        <span
          data-testid="detour-intercept-badge"
          className="rounded-full border border-[color:var(--color-line-strong)] bg-secondary px-2 py-0.5 text-xs text-[color:var(--color-secondary-foreground)]"
        >
          直线 × 实际里程
        </span>
      </div>

      <p className="m-0 mt-1 text-[color:var(--color-faint)]">
        这些路段绕行较远，可能不是最优路线；不影响已经生成的行程。
      </p>

      <ul
        data-testid="detour-intercept-hits"
        className="m-0 mt-2 grid list-none gap-2 p-0"
      >
        {hits.map((hit, index) => (
          <li
            key={`${hit.day}-${hit.stopIndex}-${index}`}
            data-testid={`detour-intercept-hit-${index}`}
            data-day={hit.day}
            className="rounded-[6px] bg-secondary/60 px-3 py-2"
          >
            <p className="m-0">
              第 {hit.day} 天 · 第 {hit.stopIndex}→{hit.stopIndex + 1} 站：
              {hit.fromName} → {hit.toName}
            </p>
            <p
              data-testid={`detour-intercept-evidence-${index}`}
              className="m-0 mt-1 text-xs text-[color:var(--color-faint)] [overflow-wrap:anywhere]"
            >
              依据：{formatDetourEvidence(hit)}（{formatDetourRatio(hit)}）
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="detour-intercept-adjust"
          onClick={() => onGoAdjust?.(firstDay)}
        >
          去调整
        </Button>
        <Button type="button" size="sm" data-testid="detour-intercept-keep" onClick={handleKeep}>
          保留原样
        </Button>
        <span className="text-xs text-[color:var(--color-faint)]">
          保留后本次行程不再自动提示；体检卡里仍可查看。
        </span>
      </div>
    </section>
  )
}

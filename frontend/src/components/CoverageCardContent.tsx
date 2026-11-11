import { useState } from 'react'

import type { Trip } from '../lib/api'
import { projectTripCoverage } from '../lib/tripCoverage'

/**
 * 六期 S6 选择充分度卡（信息深度 C）· 懒加载实现体。
 *
 * 本文件只被 `CoverageCard.tsx` 的 `lazy(() => import(...))` 引用，
 * 与 `lib/tripCoverage.ts` 投影一起落在独立 chunk，避免主包回涨。
 *
 * - 只读展示 + 显式回调：不写存储、不发请求、不改行程；「加入候选池」只发
 *   `onAddToPool` 回调，写入由父级走既有候选库显式写路径（本组件零存储接触）。
 * - 无 cityProfile / 无 classicList：投影返回 null → 整卡不渲染（无伪统计）。
 * - 文案口径：只说「经典清单里你还没安排」，不宣称权威必去；徽章
 *   「AI 生成·供参考」与「出发前请自行确认」提示常驻，折叠时不消失。
 * - 未识别站点如实说明，不计入覆盖统计，不硬凑。
 * - 样式全部用组件内 Tailwind 类，不新增全局 CSS。
 */

export interface CoveragePoolItem {
  name: string
  reason: string | null
}

export interface CoverageCardProps {
  trip?: Trip | null
  /** 用户点「加入候选池」时触发；父级按既有候选库写入路径显式落盘（可删、有反馈）。 */
  onAddToPool?: (item: CoveragePoolItem) => void
  /** 默认展开；折叠只是组件内状态，不持久化。 */
  defaultOpen?: boolean
}

const SECTION_TITLE =
  'm-0 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-secondary-foreground)]'
const SECTION_BODY = 'm-0 mt-1 text-sm text-foreground'
const MUTED = 'text-[color:var(--color-faint)]'
const ADD_BUTTON =
  'mt-1.5 inline-flex min-h-9 cursor-pointer items-center rounded-[6px] border border-[color:var(--color-line-strong)] bg-card px-3 text-xs text-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent-foreground)] disabled:cursor-not-allowed disabled:opacity-60'

/** 未识别站点名的展示上限；超出用「等 N 个」如实收口，不渲染无限长列表。 */
const MAX_UNRECOGNIZED_SHOWN = 12

export default function CoverageCardContent({
  trip,
  onAddToPool,
  defaultOpen = true,
}: CoverageCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  // 已点「加入候选池」的条目名；乐观标记，写入结果以父级保存状态提示为准。
  const [addedNames, setAddedNames] = useState<ReadonlySet<string>>(() => new Set())

  const view = projectTripCoverage(trip?.days, trip?.cityProfile ?? null)
  if (!view) return null

  function handleAdd(item: CoveragePoolItem) {
    if (!onAddToPool) return
    onAddToPool(item)
    setAddedNames((prev) => {
      const next = new Set(prev)
      next.add(item.name)
      return next
    })
  }

  const shownUnrecognized = view.unrecognizedStops.slice(0, MAX_UNRECOGNIZED_SHOWN)
  const hiddenUnrecognized = view.unrecognizedStops.length - shownUnrecognized.length

  return (
    <section
      data-testid="trip-coverage-card"
      aria-label="选择充分度"
      className="mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-4 py-3 text-sm leading-relaxed"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 flex flex-wrap items-center gap-2 font-semibold">
          选择充分度
          <span
            data-testid="trip-coverage-badge"
            className="rounded-full border border-[color:var(--color-line-strong)] bg-secondary px-2 py-0.5 text-xs font-normal text-[color:var(--color-secondary-foreground)]"
          >
            AI 生成·供参考
          </span>
        </p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          data-testid="trip-coverage-toggle"
          className="min-h-9 cursor-pointer rounded-[6px] px-2 py-1 text-xs text-[color:var(--color-secondary-foreground)] hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent-foreground)]"
        >
          {open ? '收起' : '展开'}
        </button>
      </div>

      <p
        data-testid="trip-coverage-summary"
        className="m-0 mt-2 text-sm font-medium text-foreground"
      >
        已覆盖 {view.covered.length}/{view.total} · 未安排 {view.uncovered.length} 条
      </p>

      {open && (
        <div data-testid="trip-coverage-body" className="mt-3 grid gap-3">
          <section data-testid="trip-coverage-covered" aria-label="已安排的经典">
            <h3 className={SECTION_TITLE}>已安排的经典</h3>
            {view.covered.length === 0 ? (
              <p className={`${SECTION_BODY} ${MUTED}`}>行程还没有安排经典清单里的条目。</p>
            ) : (
              <ul className="m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0">
                {view.covered.map((item) => (
                  <li
                    key={item.name}
                    className="rounded-full border border-[color:var(--color-line-strong)] bg-secondary/60 px-2 py-0.5 text-xs text-foreground"
                  >
                    {item.name}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="trip-coverage-uncovered" aria-label="经典清单里你还没安排">
            <h3 className={SECTION_TITLE}>经典清单里你还没安排</h3>
            {view.uncovered.length === 0 ? (
              <p className={`${SECTION_BODY} ${MUTED}`}>经典清单里的条目都已安排。</p>
            ) : (
              <>
                <ul className="m-0 mt-1 grid list-none gap-2 p-0">
                  {view.uncovered.map((item, index) => {
                    const added = addedNames.has(item.name)
                    return (
                      <li key={item.name} className="rounded-[6px] bg-secondary/60 px-3 py-2">
                        <p className="m-0">
                          <span className="font-semibold">{item.name}</span>
                          {item.reason && <span>：{item.reason}</span>}
                        </p>
                        {onAddToPool && (
                          <button
                            type="button"
                            data-testid={`trip-coverage-add-${index}`}
                            onClick={() => handleAdd(item)}
                            disabled={added}
                            className={ADD_BUTTON}
                          >
                            {added ? '已加入候选池 ✓' : '加入候选池'}
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
                {onAddToPool && (
                  <p className={`m-0 mt-1 text-[11px] ${MUTED}`}>
                    加入后可在候选池面板查看或删除；写入结果以页面保存状态提示为准。
                  </p>
                )}
              </>
            )}
          </section>

          {view.unrecognizedStops.length > 0 && (
            <p data-testid="trip-coverage-unrecognized" className={`m-0 text-[11px] ${MUTED}`}>
              另有 {view.unrecognizedStops.length} 个行程站点不在经典清单口径内（未识别，未计入覆盖统计）：
              {shownUnrecognized.join('、')}
              {hiddenUnrecognized > 0 ? ` 等 ${view.unrecognizedStops.length} 个` : ''}。
            </p>
          )}
        </div>
      )}

      <p data-testid="trip-coverage-disclaimer" className={`m-0 mt-2 text-xs ${MUTED}`}>
        经典清单由 AI 生成，仅供选择参考，不构成权威必去推荐；出发前请自行确认。
      </p>
    </section>
  )
}

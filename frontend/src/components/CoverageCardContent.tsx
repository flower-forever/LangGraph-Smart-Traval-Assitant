import { useState } from 'react'

import type { Trip } from '../lib/api'
import type { CityCoverageBucket, TripCoverageView } from '../lib/tripCoverage'
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
 * - 七期 S6：传入 `buckets` 且 ≥2 城时按城市分段；≤1 城保持六期 DOM 不变
 *   （不显示城市名）。不自动切城、不发请求、不写存储。
 * - 样式全部用组件内 Tailwind 类，不新增全局 CSS。
 */

export interface CoveragePoolItem {
  name: string
  reason: string | null
}

export interface CoverageCardProps {
  trip?: Trip | null
  /**
   * 七期 S6：按城市分段的覆盖桶（`projectTripCoverageByCity` 的输出）。
   * 缺省时走旧的单城投影（trip.days + trip.cityProfile）。
   */
  buckets?: CityCoverageBucket[]
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
  buckets,
  onAddToPool,
  defaultOpen = true,
}: CoverageCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  // 已点「加入候选池」的条目名；乐观标记，写入结果以父级保存状态提示为准。
  const [addedNames, setAddedNames] = useState<ReadonlySet<string>>(() => new Set())

  // 多城分段只在明确传入 ≥2 个桶时启用；1 个桶仍走单城 DOM（不显示城市名）。
  const cityBuckets: CityCoverageBucket[] =
    Array.isArray(buckets) && buckets.length > 1 ? buckets : []
  const multiCity = cityBuckets.length > 1
  const singleView: TripCoverageView | null = multiCity
    ? null
    : buckets === undefined
      ? projectTripCoverage(trip?.days, trip?.cityProfile ?? null)
      : buckets.length === 1
        ? buckets[0].view
        : null
  if (!multiCity && !singleView) return null

  function handleAdd(item: CoveragePoolItem, addedKey: string) {
    if (!onAddToPool) return
    onAddToPool(item)
    setAddedNames((prev) => {
      const next = new Set(prev)
      next.add(addedKey)
      return next
    })
  }

  /**
   * 单个覆盖视图的正文（已覆盖 / 未安排 / 未识别）。
   * `testIdPrefix` 为空串时与六期 DOM 完全一致；多城段内加前缀避免重复 id。
   */
  function renderCoverageDetails(view: TripCoverageView, testIdPrefix: string) {
    const shownUnrecognized = view.unrecognizedStops.slice(0, MAX_UNRECOGNIZED_SHOWN)
    const hiddenUnrecognized = view.unrecognizedStops.length - shownUnrecognized.length

    return (
      <>
        <section
          data-testid={`${testIdPrefix}trip-coverage-covered`}
          aria-label="已安排的经典"
        >
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

        <section
          data-testid={`${testIdPrefix}trip-coverage-uncovered`}
          aria-label="经典清单里你还没安排"
        >
          <h3 className={SECTION_TITLE}>经典清单里你还没安排</h3>
          {view.uncovered.length === 0 ? (
            <p className={`${SECTION_BODY} ${MUTED}`}>经典清单里的条目都已安排。</p>
          ) : (
            <>
              <ul className="m-0 mt-1 grid list-none gap-2 p-0">
                {view.uncovered.map((item, index) => {
                  // 多城下同名经典可能分属不同城市；乐观标记按段作用域，避免误禁用。
                  const addedKey = `${testIdPrefix}${item.name}`
                  const added = addedNames.has(addedKey)
                  return (
                    <li key={item.name} className="rounded-[6px] bg-secondary/60 px-3 py-2">
                      <p className="m-0">
                        <span className="font-semibold">{item.name}</span>
                        {item.reason && <span>：{item.reason}</span>}
                      </p>
                      {onAddToPool && (
                        <button
                          type="button"
                          data-testid={`${testIdPrefix}trip-coverage-add-${index}`}
                          onClick={() => handleAdd(item, addedKey)}
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
          <p
            data-testid={`${testIdPrefix}trip-coverage-unrecognized`}
            className={`m-0 text-[11px] ${MUTED}`}
          >
            另有 {view.unrecognizedStops.length} 个行程站点不在经典清单口径内（未识别，未计入覆盖统计）：
            {shownUnrecognized.join('、')}
            {hiddenUnrecognized > 0 ? ` 共 ${view.unrecognizedStops.length} 个` : ''}。
          </p>
        )}
      </>
    )
  }

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

      {!multiCity && singleView && (
        <p
          data-testid="trip-coverage-summary"
          className="m-0 mt-2 text-sm font-medium text-foreground"
        >
          已覆盖 {singleView.covered.length}/{singleView.total} · 未安排 {singleView.uncovered.length} 条
        </p>
      )}

      {open && (
        <div data-testid="trip-coverage-body" className="mt-3 grid gap-3">
          {multiCity
            ? cityBuckets.map((bucket, bucketIndex) => (
                <section
                  key={`${bucket.city}-${bucketIndex}`}
                  data-testid={`trip-coverage-city-${bucketIndex}`}
                  aria-label={`${bucket.city} 覆盖情况`}
                  className="rounded-[6px] bg-secondary/40 px-3 py-2"
                >
                  <h3
                    data-testid={`trip-coverage-city-title-${bucketIndex}`}
                    className="m-0 text-sm font-semibold text-foreground"
                  >
                    {bucket.view
                      ? `${bucket.city} · 已覆盖 ${bucket.view.covered.length}/${bucket.view.total}`
                      : bucket.city}
                  </h3>
                  {bucket.view ? (
                    <div className="mt-2 grid gap-3">
                      {renderCoverageDetails(bucket.view, `city-${bucketIndex}-`)}
                    </div>
                  ) : (
                    <p className={`m-0 mt-1 text-sm ${MUTED}`}>本城暂无经典清单</p>
                  )}
                </section>
              ))
            : renderCoverageDetails(singleView as TripCoverageView, '')}
        </div>
      )}

      <p data-testid="trip-coverage-disclaimer" className={`m-0 mt-2 text-xs ${MUTED}`}>
        经典清单由 AI 生成，仅供选择参考，不构成权威必去推荐；出发前请自行确认。
      </p>
    </section>
  )
}

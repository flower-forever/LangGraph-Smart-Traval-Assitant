import { useState } from 'react'
import type { TripDay } from '../lib/api'
import type { StopFacts } from '../lib/stopFacts'
import { inspectDayHealth, type HealthItem, type HealthPace } from '../lib/itineraryHealth'
import HealthActionEntry from './HealthActionEntry'

/**
 * 行程体检卡（五期 S3 规格 B）：只读展示当日体检结果。
 *
 * - 纯派生：inspectDayHealth 输入 props 即得结果，不落存储、不发请求、不改行程。
 * - 「去调整」只滚动到编辑入口（edit-entry），不自动应用任何修改。
 * - 全部数据可核对且无问题时显示「未发现问题」，仍注明不是保证。
 */

interface ItineraryHealthCardProps {
  day: TripDay
  pace: HealthPace
  /** 每站的可信字段查询（S2 投影结果，与 day.stops 等长对齐）。 */
  factsByStop: ReadonlyArray<StopFacts | null>
  /** 七期 S5：下一天（城际转移的时间核对用）；缺省按无下一天处理。 */
  nextDay?: TripDay | null
  /** 六期 S8：条目级「建议顺延」入口；缺省 = 该条目不显示入口。 */
  onSuggestPostpone?: (item: HealthItem) => void
  /** 六期 S8：条目级「补一餐」入口；缺省 = 该条目不显示入口。 */
  onSuggestMeal?: (item: HealthItem) => void
}

const LEVEL_BADGE: Partial<Record<HealthItem['level'], { label: string; tone: string }>> = {
  warning: { label: '冲突', tone: 'text-[color:var(--color-warn-ink)]' },
  notice: { label: '需确认', tone: 'text-[color:var(--color-info-ink,inherit)]' },
  unknown: { label: '无法核对', tone: 'text-[color:var(--color-faint)]' },
}

export default function ItineraryHealthCard({
  day,
  pace,
  factsByStop,
  nextDay = null,
  onSuggestPostpone,
  onSuggestMeal,
}: ItineraryHealthCardProps) {
  const [open, setOpen] = useState(false)
  const report = inspectDayHealth(day, pace, factsByStop, nextDay)
  const { counts } = report

  const summary =
    `${counts.warning} 项冲突 / ${counts.notice} 项需确认 / ${counts.unknown} 项无法核对`

  const goToEdit = () => {
    // 编辑入口由 App 用 data-testid 标注（无 id），因此按 testid 查找；找不到时静默不动。
    document
      .querySelector('[data-testid="edit-entry"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div
      data-testid="itinerary-health-card"
      data-health-warning={counts.warning}
      data-health-notice={counts.notice}
      data-health-unknown={counts.unknown}
      className="mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-4 py-3 text-sm leading-relaxed"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 font-semibold">
          行程体检 · 第 {day.day} 天
          <span className="ml-2 font-normal text-[color:var(--color-faint)]" data-testid="health-summary">
            {summary}
          </span>
        </p>
        <div className="flex items-center gap-2">
          {counts.warning + counts.notice > 0 && (
            <button
              type="button"
              onClick={goToEdit}
              data-testid="health-go-adjust"
              className="cursor-pointer rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-3 py-1 text-xs hover:bg-secondary"
            >
              去调整
            </button>
          )}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((prev) => !prev)}
            data-testid="health-toggle"
            className="cursor-pointer rounded-[6px] px-2 py-1 text-xs text-[color:var(--color-secondary-foreground)] hover:bg-secondary"
          >
            {open ? '收起' : '展开详情'}
          </button>
        </div>
      </div>

      {open && (
        <ul className="m-0 mt-3 grid list-none gap-2 p-0" data-testid="health-items">
          {report.items.length === 0 ? (
            <li className="text-[color:var(--color-faint)]">
              当天未发现问题。体检只覆盖营业时间、闭馆日、用餐窗口、节奏、折返与时间完整性，
              且依赖资料卡与行程表数据——「未发现问题」不是「已确认可行」。
            </li>
          ) : (
            report.items.map((item, i) => {
              const badge = LEVEL_BADGE[item.level]
              return (
                <li key={`${item.code}-${i}`} className="rounded-[6px] bg-secondary/60 px-3 py-2" data-code={item.code}>
                  <p className="m-0">
                    {badge && (
                      <span className={`mr-2 text-xs font-semibold ${badge.tone}`}>
                        【{badge.label}】
                      </span>
                    )}
                    {item.message}
                  </p>
                  <p className="m-0 mt-1 text-xs text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
                    依据：{item.evidence}
                  </p>
                  {item.suggestion !== null && (
                    <p className="m-0 mt-1 text-xs">{item.suggestion}</p>
                  )}
                  <HealthActionEntry
                    item={item}
                    onSuggestPostpone={onSuggestPostpone}
                    onSuggestMeal={onSuggestMeal}
                  />
                </li>
              )
            })
          )}
        </ul>
      )}
      <p className="m-0 mt-2 text-xs text-[color:var(--color-faint)]">
        节奏档位：{pace === 'relaxed' ? '松弛' : pace === 'packed' ? '紧凑' : '均衡'}。节奏是建议，不是保证；
        体检纯本地计算，不会自动修改行程。
      </p>
    </div>
  )
}

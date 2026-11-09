import { useState } from 'react'
import type { TripDay } from '../lib/api'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import { cn } from '@/lib/utils'
import ItineraryList from './ItineraryList'
import TimelineView from './TimelineView'

interface ItineraryViewProps {
  day: TripDay
  activeStopId: string | null
  onSelectStop: (stopId: string) => void
  /** 资料卡库（父级读好传入；null = 未加载）。仅展示，不写任何键。 */
  poiCards?: PoiCardsRecordV1 | null
}

type ItineraryViewMode = 'list' | 'timeline'

const VIEW_OPTIONS: ReadonlyArray<{ value: ItineraryViewMode; label: string }> = [
  { value: 'list', label: '列表' },
  { value: 'timeline', label: '时间轴' },
]

/**
 * 行程视图切换（四期 S3）：列表 / 时间轴两种只读视图。
 * 当前视图只是组件内状态：默认列表，不持久化、不写任何存储键；
 * activeStopId 由父级持有，切换视图不会改变当前选中站点。
 */
export default function ItineraryView({ day, activeStopId, onSelectStop, poiCards = null }: ItineraryViewProps) {
  const [view, setView] = useState<ItineraryViewMode>('list')

  return (
    <div>
      <div
        role="group"
        aria-label="行程视图"
        data-testid="itinerary-view-toggle"
        className="mb-3 flex w-fit flex-wrap items-center gap-1 rounded-[6px] border border-[color:var(--color-line-strong)] bg-background p-0.5"
      >
        {VIEW_OPTIONS.map(({ value, label }) => {
          const active = view === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => setView(value)}
              className={cn(
                'inline-flex min-h-8 cursor-pointer items-center justify-center rounded-[4px] px-3 py-1 text-xs leading-[1.4] transition-colors duration-150 ease-out',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent-foreground)]',
                active
                  ? 'bg-accent-surface font-semibold text-[color:var(--color-accent-foreground)]'
                  : 'text-[color:var(--color-secondary-foreground)] hover:bg-secondary',
              )}
            >
              {label}
            </button>
          )
        })}
      </div>

      {view === 'list'
        ? <ItineraryList day={day} activeStopId={activeStopId} onSelectStop={onSelectStop} poiCards={poiCards} />
        : <TimelineView day={day} activeStopId={activeStopId} onSelectStop={onSelectStop} poiCards={poiCards} />}
    </div>
  )
}

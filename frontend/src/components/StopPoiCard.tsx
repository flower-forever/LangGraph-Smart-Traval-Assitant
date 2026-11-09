import type { TripStop } from '../lib/api'
import { findPoiCardByName, type PoiCardsRecordV1 } from '../lib/poiCards'

interface StopPoiCardProps {
  stop: TripStop
  /** 资料卡库（父级读好传入；null = 未加载）。只展示唯一名称命中，不写任何键。 */
  poiCards: PoiCardsRecordV1 | null
}

/**
 * 停点资料卡摘要（四期 S3 抽出）：列表视图与时间轴视图共用同一渲染口径。
 * findPoiCardByName 已保证 0 命中 / 多命中都返回 null，此时不渲染展示位。
 */
export default function StopPoiCard({ stop, poiCards }: StopPoiCardProps) {
  const card = findPoiCardByName(poiCards, stop.name)
  if (card === null) return null

  return (
    <div
      className="mt-3 rounded-[10px] border border-border bg-card p-3"
      data-testid={`stop-poi-card-${stop.id}`}
      role="note"
      aria-label={`景点资料卡：${card.name}`}
    >
      <p className="m-0 mb-1 text-sm font-semibold text-foreground">景点资料卡 · 未核实</p>
      <p className="m-0 mb-1 text-sm text-[color:var(--color-secondary-foreground)]">介绍：{card.intro.trim() || '未知'}</p>
      <p className="m-0 mb-1 text-sm text-[color:var(--color-secondary-foreground)]">开放时间：{card.openingHours.trim() || '未知'}</p>
      <p className="m-0 mb-1 text-sm text-[color:var(--color-secondary-foreground)]">门票：{card.ticket.trim() || '未知'}</p>
      <p className="m-0 text-xs text-muted-foreground">
        按名称匹配，请自行核对
        {card.provenance.intro?.source ? ` · 来源：${card.provenance.intro.source}` : ''}
      </p>
    </div>
  )
}

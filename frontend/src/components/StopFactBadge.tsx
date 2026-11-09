/**
 * S2 · 信息可信卡：三态徽章 + 「可能过期」附加标记（五期计划 §3）。
 *
 * 展示口径（全应用统一，文案集中在此，别处不得另造）：
 * - sourced →「有来源（待核对）」：来源名 + 记录日期可展开（details/summary）；
 *   本期上限如此，**永不显示「已核实」**。
 * - unverified →「未核实」：有值但无 provenance。
 * - unknown →「未知」：空值 / 无资料卡。
 * - stale=true 时附加「可能过期」标记（sourced 才可能 stale）。
 * 纯展示组件：无状态、无存储、无请求；来源详情用原生 <details>，不引全局状态。
 */

import { STOP_FACT_STALE_DAYS, type StopFactField, type StopFactStatus } from '../lib/stopFacts'
import type { PoiCardImageSource } from '../lib/poiCards'

/** 来源键 → 展示名；与 PoiCardPanel 的 SOURCE_LABEL 同一映射，不另造口径。 */
const SOURCE_LABEL: Record<PoiCardImageSource, string> = {
  manual: '手动粘贴',
  tavily: '网页资料',
  osm: '协作地图',
  wikimedia: 'Wikimedia',
}

/** 三态 → 徽章文案。集中定义；「已核实」不在映射里，也不允许出现在别处。 */
export const STOP_FACT_STATUS_LABEL: Record<StopFactStatus, string> = {
  sourced: '有来源（待核对）',
  unverified: '未核实',
  unknown: '未知',
}

/** 三态 → 徽章样式（宣纸体系：来源=成功绿弱化、未核实=琥珀、未知=弱化描边）。 */
const STATUS_BADGE_CLASS: Record<StopFactStatus, string> = {
  sourced: 'border-[color:var(--color-ok)] text-[color:var(--color-ok)]',
  unverified: 'border-[color:var(--color-warn-ink)] text-[color:var(--color-warn-ink)]',
  unknown: 'border-border text-[color:var(--color-faint)]',
}

/** recordedAt → 本地日期展示；非法时间戳显示「记录时间未知」，不编造。 */
function recordedDateLabel(recordedAt: number): string {
  const at = new Date(recordedAt)
  if (Number.isNaN(at.getTime())) return '记录时间未知'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

interface StopFactBadgeProps {
  /** 投影后的单字段事实。 */
  fact: StopFactField
  /**
   * 展开来源详情的可访问名（含字段名，由调用方传，如「介绍来源：断桥残雪」）；
   * 挂在 <details> 上，供读屏器区分三个同形展开区。
   */
  detailLabel: string
}

/**
 * 单字段状态徽章：sourced 时包一层可展开详情（来源名 + 说明 + 记录日期 + 时效），
 * 其余两态只有徽章本身。stale 的 sourced 附加「可能过期」。
 */
export default function StopFactBadge({ fact, detailLabel }: StopFactBadgeProps) {
  const badge = (
    <span
      className={`inline-flex items-center rounded-[4px] border px-1.5 py-px text-[10px] tracking-[0.04em] ${STATUS_BADGE_CLASS[fact.status]}`}
      data-status={fact.status}
    >
      {STOP_FACT_STATUS_LABEL[fact.status]}
    </span>
  )

  if (fact.status !== 'sourced') return badge

  const summary = (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {badge}
      <span className="text-[11px] text-muted-foreground">来源：{SOURCE_LABEL[fact.source ?? 'manual']}</span>
      {fact.stale && (
        <span
          className="inline-flex items-center rounded-[4px] border border-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] px-1.5 py-px text-[10px] text-[color:var(--color-warn-ink)]"
          data-testid="stop-fact-stale"
        >
          可能过期（超过 {STOP_FACT_STALE_DAYS} 天）
        </span>
      )}
    </span>
  )

  return (
    <details className="inline-flex flex-col" data-testid="stop-fact-source-detail" aria-label={detailLabel}>
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{summary}</summary>
      <span className="mt-1 block text-[11px] leading-[1.6] text-muted-foreground">
        {fact.sourceDetail ? <span className="block">来源说明：{fact.sourceDetail}</span> : null}
        <span className="block">记录日期：{recordedDateLabel(fact.recordedAt ?? 0)}</span>
        <span className="block">按名称匹配，请自行核对</span>
      </span>
    </details>
  )
}

/**
 * S8 · 补一餐面板（lazy 可加载的默认导出）。
 *
 * 流程：体检条目级入口 → 3 个餐饮候选 → 选定后预览插入时间与位置
 * → 显式确认才写入草稿（无草稿时先走既有 fork 路径）；插入沿换一纪律作废相邻路段。
 *
 * 边界：
 * - 候选只来自候选池与资料卡库，按名称 / 标签的餐饮关键词过滤；不做外部搜索。
 * - 时窗口径与五期体检一致（午餐 11:30–13:30 / 晚餐 17:30–19:30），只插入
 *   至少 45 分钟的连续空档；没有空档就明说，不提供会重叠的方案。
 * - 双库都没有餐饮条目 → 沉默显示「暂无餐饮候选」，不编造。
 * - 先预览再确认、失败保旧、可撤销一次、零自动保存。
 */

import { useMemo, useState, type RefObject } from 'react'

import type { TripDay } from '../lib/api'
import { filterCandidates } from '../lib/candidatePool'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import type { CandidateItemV1 } from '../lib/workspace'
import {
  MEAL_CANDIDATE_LIMIT,
  MEAL_WINDOWS,
  applyMealInsertionToDraft,
  buildMealCandidates,
  findMealInsertion,
  topMealCandidates,
  type MealCandidate,
  type MealInsertionSlot,
  type MealWindowKey,
} from '../lib/mealGap'
import { SWAP_TRUST_LABELS, formatStraightDistance } from '../lib/stopSwap'
import type { DraftCreateResult, TripDraft } from '../lib/tripDraft'
import { undoDraft } from '../lib/tripDraft'
import { useDialogFocus } from '../lib/useDialogFocus'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'

export interface MealSuggestPanelProps {
  /** 当前展示的那一天（原行程或草稿均可；有草稿时以草稿当天为准）。 */
  baseDay: TripDay
  /** 父级持有的草稿；null = 尚未进入本地编辑。 */
  draft: TripDraft | null
  /** 无草稿时创建 fork 草稿（父级用 createTripDraft + 新 UUID + newLegMode 实现）。 */
  onCreateDraft: () => DraftCreateResult
  /** 请求父级更新内存草稿；面板自身不保存。 */
  onDraftChange: (next: TripDraft) => void
  /** 候选池条目；可空（未接入时只有资料卡来源）。 */
  candidates?: readonly CandidateItemV1[] | null
  /**
   * 七期 S7：当前城市。传入时候选池只取「同城 + 全局」；
   * 缺省 / 空串 = 与旧行为一致。
   */
  city?: string | null
  /**
   * S8-36：体检提示的用餐窗口。传入时优先在该窗口找空档；
   * 该窗口没有 45 分钟空档才回退到另一窗口，并在面板明示回退。
   */
  preferredWindow?: MealWindowKey | null
  /** 资料卡库；可空。 */
  poiCards?: PoiCardsRecordV1 | null
  /** 新站点 id 由调用方生成（与 TripDraftEditor 的 createStopId 同一纪律）。 */
  createStopId: () => string
  /** 可信状态判定用的当前时刻；测试可固定。 */
  now?: number
  onClose: () => void
  /** 写入 / 撤销成功后通知父级重跑体检（可选；体检卡随草稿变化会自动重算）。 */
  onHealthRecheck?: (day: number) => void
  returnFocusTo?: RefObject<HTMLElement | null> | null
}

interface PreviewState {
  candidate: MealCandidate
  slot: MealInsertionSlot
  /** 预览时的草稿 revision；null = 预览时还没有草稿。 */
  revision: number | null
}

interface AppliedState {
  revision: number
  day: number
  candidateName: string
}

/** 插入位置说明：前一站 / 后一站都按原站点序号描述。 */
function positionText(slot: MealInsertionSlot): string {
  const after =
    slot.afterStopName === null
      ? '当天最前'
      : `第 ${slot.index} 站「${slot.afterStopName}」之后`
  const before =
    slot.beforeStopName === null
      ? '当天末尾'
      : `第 ${slot.index + 1} 站「${slot.beforeStopName}」之前`
  return `${after}、${before}`
}

export default function MealSuggestPanel({
  baseDay,
  draft,
  onCreateDraft,
  onDraftChange,
  candidates = null,
  city = null,
  preferredWindow = null,
  poiCards = null,
  createStopId,
  now,
  onClose,
  onHealthRecheck,
  returnFocusTo = null,
}: MealSuggestPanelProps) {
  const day = draft?.days.find((item) => item.day === baseDay.day) ?? baseDay
  const nowValue = now ?? Date.now()

  const insertion = useMemo(
    () => findMealInsertion(day, preferredWindow),
    [day, preferredWindow],
  )
  const anchorStop = useMemo(() => {
    if (!insertion.ok) return null
    return day.stops[insertion.slot.index - 1] ?? day.stops[insertion.slot.index] ?? null
  }, [day, insertion])

  const scopedCandidates = useMemo(() => {
    if (candidates === null) return null
    const key = typeof city === 'string' ? city.trim() : ''
    return key === '' ? candidates : filterCandidates(candidates, { cityId: key })
  }, [candidates, city])

  const mealCandidates = useMemo(() => {
    if (!insertion.ok) return []
    return topMealCandidates(
      buildMealCandidates({
        candidates: scopedCandidates,
        poiCards: poiCards ?? null,
        anchorStop,
        existingStopNames: day.stops.map((stop) => stop.name),
        now: nowValue,
      }),
      MEAL_CANDIDATE_LIMIT,
    )
    // scopedCandidates / poiCards 是父组件给的记录引用；变了就重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertion, anchorStop, day, scopedCandidates, poiCards])

  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [applied, setApplied] = useState<AppliedState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const panelRef = useDialogFocus<HTMLElement>({
    onEscape: onClose,
    trapTab: false,
    returnFocusTo,
  })

  function resetPreview() {
    setPreview(null)
    setError(null)
    setNotice(null)
  }

  function handlePreview(candidate: MealCandidate) {
    if (!insertion.ok) return
    setError(null)
    setNotice(null)
    setPreview({
      candidate,
      slot: insertion.slot,
      revision: draft?.revision ?? null,
    })
  }

  function handleConfirm() {
    if (!preview) return
    setError(null)
    let working = draft
    let createdNow = false
    if (working === null) {
      const created = onCreateDraft()
      if (!created.ok) {
        setError(`没能创建草稿：${created.message}`)
        return
      }
      working = created.draft
      createdNow = true
    }
    let stopId: string
    try {
      stopId = createStopId()
    } catch {
      setError('生成新站点 id 失败，这次补餐没有写入；草稿保持原样。')
      return
    }
    const written = applyMealInsertionToDraft(
      working,
      day.day,
      preview.slot,
      preview.candidate,
      stopId,
      preferredWindow,
    )
    if (!written.ok) {
      setError(written.message)
      setPreview(null)
      return
    }
    if (!written.changed) {
      setError('补餐没有产生实际变化，草稿未改动。')
      return
    }
    onDraftChange(written.draft)
    setApplied({
      revision: written.draft.revision,
      day: day.day,
      candidateName: preview.candidate.name,
    })
    setPreview(null)
    setNotice(
      `${createdNow ? '已基于当前行程创建本地草稿，并' : ''}在第 ${day.day} 天` +
        `${preview.slot.label}空档 ${preview.slot.startTime}–${preview.slot.endTime} 插入` +
        `「${preview.candidate.name}」（只改内存草稿，未自动保存）。` +
        '新站前后路段已标为「路线待重取」，不沿用旧路线。',
    )
    onHealthRecheck?.(day.day)
  }

  function handleUndo() {
    if (!applied || draft === null) return
    setError(null)
    const result = undoDraft(draft)
    if (!result.ok) {
      setError(result.message)
      return
    }
    if (!result.changed) {
      setError('没有可撤销的草稿操作；草稿保持原样。')
      return
    }
    onDraftChange(result.draft)
    setApplied(null)
    setNotice(`已撤销这次补餐，「${applied.candidateName}」已从草稿移除（只改内存草稿，未自动保存）。`)
    onHealthRecheck?.(applied.day)
  }

  const canUndo = applied !== null && draft !== null && draft.revision === applied.revision
  const previewIsStale =
    preview !== null &&
    draft !== null &&
    preview.revision !== null &&
    draft.revision !== preview.revision
  const affectedLegCount = insertion.ok
    ? (insertion.slot.index > 0 ? 1 : 0) +
      (insertion.slot.index < day.stops.length ? 1 : 0)
    : 0
  const preferredLabel =
    preferredWindow === null ? null : MEAL_WINDOWS[preferredWindow].label
  const windowFallback =
    insertion.ok && preferredLabel !== null && insertion.slot.window !== preferredWindow

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="oc-panel-enter-fast mt-3 grid min-w-0 gap-3 rounded-[10px] border border-[color:var(--color-line-strong)] bg-background p-4"
      aria-label={`第 ${day.day} 天补一餐`}
      data-testid="meal-suggest-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-[1_1_240px]">
          <h4 className="m-0 font-display text-md font-bold leading-normal [overflow-wrap:anywhere]">
            补一餐：第 {day.day} 天
          </h4>
          <p className="m-0 mt-1 max-w-[76ch] text-xs leading-relaxed text-muted-foreground">
            候选只来自候选池与资料卡库（名称或标签含餐饮关键词），不做外部搜索。
            用餐窗口与体检同口径：午餐 11:30–13:30、晚餐 17:30–19:30；
            只插入至少 45 分钟的连续空档，先预览后确认，不会自动保存。
          </p>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="关闭补餐面板">
          关闭
        </Button>
      </div>

      {!insertion.ok && (
        <Alert variant="warning" role="status" data-testid="meal-slot-missing">
          <AlertDescription>{insertion.message}</AlertDescription>
        </Alert>
      )}

      {insertion.ok && (
        <p
          className="m-0 rounded-[6px] bg-secondary/60 px-3 py-2 text-xs leading-relaxed"
          data-testid="meal-slot"
        >
          最近用餐空档：{insertion.slot.label} {insertion.slot.startTime}–{insertion.slot.endTime}
          （本餐 {insertion.slot.minutes} 分钟，空档共 {insertion.slot.gapMinutes} 分钟）；
          插入位置：{positionText(insertion.slot)}。
        </p>
      )}

      {windowFallback && (
        <p
          className="m-0 rounded-[6px] border border-[color:var(--color-line)] px-3 py-2 text-xs leading-relaxed text-[color:var(--color-warn-ink)]"
          role="status"
          data-testid="meal-window-fallback"
        >
          体检提示{preferredLabel}窗口偏紧：该窗口内没有 45 分钟连续空档，已改用
          {insertion.slot.label}空档。如需留在{preferredLabel}，请先用「建议顺延」拉开时段。
        </p>
      )}

      {draft === null && (
        <p className="m-0 text-xs leading-relaxed text-[color:var(--color-faint)]" data-testid="meal-fork-note">
          当前没有草稿：确认后会基于当前行程创建一个本地草稿（fork 副本），这一步不会自动保存；
          原行程保持不变。
        </p>
      )}

      {error && (
        <Alert variant="warning" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert variant="success" role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      {applied && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button variant="outline" onClick={handleUndo} disabled={!canUndo} data-testid="meal-undo">
            撤销这次补餐
          </Button>
          {!canUndo && (
            <span className="text-xs text-[color:var(--color-faint)]">
              草稿在上次补餐之后又有改动，这里不再提供撤销；可以用编辑器的「撤销草稿操作」回退。
            </span>
          )}
        </div>
      )}

      {insertion.ok && mealCandidates.length === 0 && (
        <p className="m-0 text-sm text-muted-foreground" data-testid="meal-empty">
          暂无餐饮候选。候选池与资料卡库里还没有名称或标签含餐饮关键词的条目；
          这里不会编造候选，也不会插入任何站点。
        </p>
      )}

      {insertion.ok && mealCandidates.length > 0 && (
        <ol className="m-0 grid list-none gap-3 p-0" aria-label="餐饮候选">
          {mealCandidates.map((candidate) => (
            <li
              key={candidate.id}
              className="grid gap-2 rounded-[8px] border border-border p-3"
              data-testid="meal-candidate"
              data-candidate-id={candidate.id}
              data-candidate-source={candidate.source}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{candidate.name}</span>
                <Badge variant="outline" className="text-[10px]">
                  {formatStraightDistance(candidate.straightDistanceMeters)}
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  可信状态：{SWAP_TRUST_LABELS[candidate.trust]}
                </Badge>
              </div>
              <p className="m-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {candidate.reason}
              </p>
              <div>
                <Button variant="outline" onClick={() => handlePreview(candidate)}>
                  预览插入
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {preview && (
        <div
          className="grid gap-2 rounded-[8px] border border-dashed border-[color:var(--color-primary)] bg-accent-surface p-3"
          data-testid="meal-preview"
          role="group"
          aria-label="补餐插入预览"
        >
          <p className="m-0 text-sm font-semibold text-[color:var(--color-accent-foreground)]">
            插入预览：「{preview.candidate.name}」
          </p>
          <p className="m-0 text-sm">
            时间：第 {day.day} 天 {preview.slot.startTime}–{preview.slot.endTime}（{preview.slot.minutes} 分钟，
            {preview.slot.label}空档）
          </p>
          <p className="m-0 text-sm">位置：{positionText(preview.slot)}</p>
          <p className="m-0 text-xs leading-relaxed text-[color:var(--color-secondary-foreground)]">
            插入后有 {affectedLegCount} 段相邻路线会标为「路线待重取」（unavailable、几何为空、
            距离与耗时留空），不沿用旧路线；新站没有可信坐标，直线距离未知。
          </p>
          {previewIsStale && (
            <p className="m-0 text-xs text-[color:var(--color-warn-ink)]" data-testid="meal-stale-note">
              草稿在预览后又有改动：确认时会按最新草稿校验，空档已变化会拒绝写入并保持草稿原样。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleConfirm} data-testid="meal-confirm">
              确认插入草稿
            </Button>
            <Button variant="outline" onClick={resetPreview}>
              取消预览
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

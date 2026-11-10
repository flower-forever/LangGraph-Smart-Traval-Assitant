/**
 * S6 · 换一个：站点替换面板（五期计划 §7.1）。
 *
 * 边界：
 * - **只改内存草稿**：面板不读 localStorage、不调用网络、不自动保存；
 *   写入草稿必须经过父组件的 onDraftChange，最终仍要用户手动「应用草稿」。
 * - **先预览再确认**：默认只列候选；点「预览」才显示替换后当天顺序与受影响路段；
 *   确认之后才写入草稿。没确认就离开面板不会改动草稿。
 * - **可撤销一次**：替换成功后提供「撤销这次更换」，走草稿自己的撤销栈；
 *   只在「这次替换就是最后一次改动」时可用。
 * - **失败保旧**：任何一步失败都只显示错误，草稿保持原样。
 * - **不编造**：没有候选就写「暂无候选」；坐标缺失就写「直线距离未知」；
 *  不补 (0,0)、不估距离、不沿用旧路线。
 */

import { useMemo, useState, type RefObject } from 'react'

import type { TripStop } from '../lib/api'
import type { TripDraft } from '../lib/tripDraft'
import { replaceDraftStop, undoDraft } from '../lib/tripDraft'
import {
  SWAP_CANDIDATE_LIMIT,
  SWAP_PREVIEW_LEG_NOTE,
  SWAP_TRUST_LABELS,
  buildSwapCandidates,
  formatStraightDistance,
  previewStopSwap,
  topSwapCandidates,
  type SwapCandidate,
  type SwapPreview,
} from '../lib/stopSwap'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import type { CandidateItemV1 } from '../lib/workspace'
import { useDialogFocus } from '../lib/useDialogFocus'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'

export interface StopSwapPanelProps {
  /** 当前草稿（只读使用；写入通过 onDraftChange）。 */
  draft: TripDraft
  /** 当天序号（TripDay.day）。 */
  dayNumber: number
  /** 被替换的站点。 */
  stop: TripStop
  /** 父组件持有的受控草稿；本组件只通过 onDraftChange 请求更新。 */
  onDraftChange: (next: TripDraft) => void
  /** 候选池条目；可空（未接入时只有资料卡来源）。 */
  candidates?: readonly CandidateItemV1[] | null
  /** 资料卡库；可空。 */
  poiCards?: PoiCardsRecordV1 | null
  /** 关闭面板。 */
  onClose: () => void
  /**
   * 关闭后焦点归还目标。入口按钮在面板打开期间会被禁用，浏览器会把焦点
   * 移到 body；不传时退回挂载前记录的 activeElement。
   */
  returnFocusTo?: RefObject<HTMLElement | null> | null
}

interface AppliedState {
  /** 替换后的站点名。 */
  stopName: string
  /** 替换完成后草稿的 revision：只有草稿没再被改动时才能撤销。 */
  revision: number
}

/**
 * 替换面板。候选按「同类型优先 + 直线距离由近到远」排序，最多展示 3 个。
 */
export default function StopSwapPanel({
  draft,
  dayNumber,
  stop,
  onDraftChange,
  candidates = null,
  poiCards = null,
  onClose,
  returnFocusTo = null,
}: StopSwapPanelProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<SwapPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [applied, setApplied] = useState<AppliedState | null>(null)
  // 内联面板不是 aria-modal：只做 Esc 关闭 + 焦点进入/归还，不圈定 Tab。
  const panelRef = useDialogFocus<HTMLElement>({
    onEscape: onClose,
    trapTab: false,
    returnFocusTo,
  })

  const day = draft.days.find((item) => item.day === dayNumber) ?? null
  const otherStopNames = useMemo(
    () => (day ? day.stops.filter((item) => item.id !== stop.id).map((item) => item.name) : []),
    [day, stop.id],
  )

  const candidatesList = useMemo(
    () =>
      buildSwapCandidates({
        stop,
        candidates: candidates ?? null,
        poiCards: poiCards ?? null,
        now: Date.now(),
        otherStopNames,
      }),
    // candidates / poiCards 是父组件给的记录引用；变了就重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stop, candidates, poiCards, otherStopNames],
  )
  const shown = topSwapCandidates(candidatesList, SWAP_CANDIDATE_LIMIT)
  const selected: SwapCandidate | null =
    shown.find((item) => item.id === selectedId) ?? null

  function handlePreview(candidate: SwapCandidate) {
    setError(null)
    setNotice(null)
    const result = previewStopSwap(draft, dayNumber, stop.id, {
      name: candidate.name,
      address: candidate.address ?? '',
      // 描述是旧站的介绍，换站后必须清空；候选资料的可信内容在资料卡里单独展示。
      description: null,
    })
    if (!result.ok) {
      setPreview(null)
      setError(result.message)
      return
    }
    setSelectedId(candidate.id)
    setPreview(result.preview)
  }

  function handleConfirm() {
    if (!selected || !preview) return
    setError(null)
    // 真正写入草稿：仍然只是内存草稿，不自动保存、不请求后端。
    const written = replaceDraftStop(draft, dayNumber, stop.id, {
      name: selected.name,
      address: selected.address ?? '',
      description: null,
    })
    if (!written.ok) {
      setError(written.message)
      setPreview(null)
      return
    }
    if (!written.changed) {
      setError('替换没有产生实际变化，草稿未改动。')
      return
    }
    onDraftChange(written.draft)
    setApplied({ stopName: selected.name, revision: written.draft.revision })
    setPreview(null)
    setSelectedId(null)
    setNotice(
      `已把第 ${dayNumber} 天的「${stop.name}」换成「${selected.name}」（只改内存草稿，未自动保存）。` +
        '被替换站点前后的路段已标为「路线待重取」，不沿用旧路线。',
    )
  }

  function handleUndo() {
    if (!applied) return
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
    setNotice(`已撤销这次更换，「${applied.stopName}」的替换已回退（只改内存草稿，未自动保存）。`)
  }

  const canUndo = applied !== null && draft.revision === applied.revision

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="oc-panel-enter-fast mt-3 grid gap-3 rounded-[10px] border border-[color:var(--color-line-strong)] bg-background p-4"
      aria-label={`更换第 ${dayNumber} 天的站点`}
      data-testid="stop-swap-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-[1_1_240px]">
          <h4 className="m-0 font-display text-md font-bold leading-normal [overflow-wrap:anywhere]">
            换一个：第 {dayNumber} 天「{stop.name}」
          </h4>
          <p className="m-0 mt-1 max-w-[76ch] text-xs leading-relaxed text-muted-foreground">
            候选只来自候选池与资料卡库，不做外部搜索。距离是直线距离，坐标缺失就写未知；
            替换前先预览，确认后才写入内存草稿（不会自动保存）。
          </p>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="关闭更换面板" data-dialog-initial-focus>
          关闭
        </Button>
      </div>

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
          <Button variant="outline" onClick={handleUndo} disabled={!canUndo}>
            撤销这次更换
          </Button>
          {!canUndo && (
            <span className="text-xs text-[color:var(--color-faint)]">
              草稿在上次更换之后又有改动，这里不再提供撤销；可以用上方「撤销草稿操作」回退。
            </span>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground" data-testid="stop-swap-empty">
          暂无候选。候选池与资料卡库里还没有能换的类型条目；这里不会编造候选，也不会替换任何站点。
        </p>
      ) : (
        <ol className="m-0 grid list-none gap-3 p-0" aria-label="替换候选">
          {shown.map((candidate) => (
            <li
              key={candidate.id}
              className="grid gap-2 rounded-[8px] border border-border p-3"
              data-testid="stop-swap-candidate"
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
                  预览替换
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {preview && (
        <div
          className="grid gap-2 rounded-[8px] border border-dashed border-[color:var(--color-primary)] bg-accent-surface p-3"
          data-testid="stop-swap-preview"
          role="group"
          aria-label="替换预览"
        >
          <p className="m-0 text-sm font-semibold text-[color:var(--color-accent-foreground)]">
            替换预览（第 {preview.day} 天）
          </p>
          <ol className="m-0 grid list-none gap-1 p-0">
            {preview.stops.map((item) => (
              <li
                key={item.id}
                className="text-sm [overflow-wrap:anywhere]"
                data-replaced={item.replaced || undefined}
              >
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  第 {item.index} 站
                </span>{' '}
                <span className={item.replaced ? 'font-semibold' : ''}>{item.name}</span>{' '}
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {item.time || '时间未填'}
                </span>
                {item.replaced && (
                  <span className="ml-1 text-xs text-[color:var(--color-accent-foreground)]">
                    （替换后）
                  </span>
                )}
              </li>
            ))}
          </ol>
          <p className="m-0 text-xs leading-relaxed text-[color:var(--color-secondary-foreground)]">
            受影响路段 {preview.invalidatedLegCount} 段会标为「路线待重取」。{SWAP_PREVIEW_LEG_NOTE}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleConfirm}>确认替换</Button>
            <Button
              variant="outline"
              onClick={() => {
                setPreview(null)
                setSelectedId(null)
              }}
            >
              取消
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

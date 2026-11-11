/**
 * S8 · 建议顺延面板（lazy 可加载的默认导出）。
 *
 * 流程：体检条目级入口 → 选起点 / 15 或 30 分钟 → 预览级联前后对照
 * → 显式确认才写入草稿（无草稿时先走既有 fork 路径创建草稿）。
 *
 * 边界：
 * - **先预览再确认**：预览不写任何草稿；确认前离开面板零改动。
 * - **失败保旧**：创建草稿、写入草稿任一步失败都只显示错误，不动现有草稿 / 行程。
 * - **可撤销一次**：所有顺延站在草稿撤销栈里合并为一项，撤销一次整体恢复。
 * - **零自动保存**：只通过 onDraftChange 更新父级内存草稿；不读 localStorage、不发网络。
 * - **跨天口径**：由 lib/postpone 投影决定（会跨日的站保持原时刻；目标站自己会跨日
 *   则整次不可用），面板如实展示 conflicts / notes，不静默写入。
 */

import { useMemo, useState, type RefObject } from 'react'

import type { TripDay } from '../lib/api'
import type { HealthPace } from '../lib/itineraryHealth'
import {
  POSTPONE_MINUTES,
  applyPostponeToDraft,
  projectPostpone,
  suggestPostponeTarget,
  type PostponeMinutes,
  type PostponeProjection,
} from '../lib/postpone'
import type { DraftCreateResult, TripDraft } from '../lib/tripDraft'
import { undoDraft } from '../lib/tripDraft'
import { useDialogFocus } from '../lib/useDialogFocus'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'

export interface PostponePanelProps {
  /** 当前展示的那一天（原行程或草稿均可；有草稿时以草稿当天为准）。 */
  baseDay: TripDay
  /** 当前节奏档位：用于给出「从哪一站起」的体检建议。 */
  pace: HealthPace
  /** 父级持有的草稿；null = 尚未进入本地编辑。 */
  draft: TripDraft | null
  /** 无草稿时创建 fork 草稿（父级用 createTripDraft + 新 UUID + newLegMode 实现）。 */
  onCreateDraft: () => DraftCreateResult
  /** 请求父级更新内存草稿；面板自身不保存。 */
  onDraftChange: (next: TripDraft) => void
  /** 关闭面板。 */
  onClose: () => void
  /** 写入 / 撤销成功后通知父级重跑体检（可选；体检卡随草稿变化会自动重算）。 */
  onHealthRecheck?: (day: number) => void
  /** 关闭后焦点归还目标。 */
  returnFocusTo?: RefObject<HTMLElement | null> | null
}

interface PreviewState {
  projection: PostponeProjection
  /** 预览时的草稿 revision；null = 预览时还没有草稿。 */
  revision: number | null
}

interface AppliedState {
  revision: number
  day: number
  label: string
}

export default function PostponePanel({
  baseDay,
  pace,
  draft,
  onCreateDraft,
  onDraftChange,
  onClose,
  onHealthRecheck,
  returnFocusTo = null,
}: PostponePanelProps) {
  const day = draft?.days.find((item) => item.day === baseDay.day) ?? baseDay

  const suggestion = useMemo(() => suggestPostponeTarget(day, pace), [day, pace])
  const initialStopId =
    suggestion?.stopId ?? day.stops[day.stops.length - 1]?.id ?? day.stops[0]?.id ?? ''

  const [targetStopId, setTargetStopId] = useState<string>(initialStopId)
  const [minutes, setMinutes] = useState<PostponeMinutes>(15)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [applied, setApplied] = useState<AppliedState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const panelRef = useDialogFocus<HTMLElement>({
    onEscape: onClose,
    trapTab: false,
    returnFocusTo,
  })

  const selectedStopId =
    day.stops.some((stop) => stop.id === targetStopId) ? targetStopId : initialStopId

  function resetPreview() {
    setPreview(null)
    setError(null)
    setNotice(null)
  }

  function handlePreview() {
    setError(null)
    setNotice(null)
    const result = projectPostpone(day, selectedStopId, minutes)
    if (!result.ok) {
      setPreview(null)
      setError(result.message)
      return
    }
    setPreview({ projection: result.projection, revision: draft?.revision ?? null })
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
    const written = applyPostponeToDraft(working, preview.projection)
    if (!written.ok) {
      setError(written.message)
      setPreview(null)
      return
    }
    if (!written.changed) {
      setError('顺延没有产生实际变化，草稿未改动。')
      return
    }
    onDraftChange(written.draft)
    setApplied({
      revision: written.draft.revision,
      day: preview.projection.day,
      label: `第 ${preview.projection.targetIndex} 站起 ${preview.projection.shiftedCount} 站`,
    })
    setPreview(null)
    setNotice(
      `${createdNow ? '已基于当前行程创建本地草稿，并' : ''}把第 ${preview.projection.day} 天` +
        `从第 ${preview.projection.targetIndex} 站起的 ${preview.projection.shiftedCount} 站顺延 ` +
        `${preview.projection.minutes} 分钟（只改内存草稿，未自动保存）。` +
        (preview.projection.heldCount > 0
          ? `末尾 ${preview.projection.heldCount} 站为避开跨日保持原时刻。`
          : ''),
    )
    onHealthRecheck?.(preview.projection.day)
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
    setNotice(`已撤销这次顺延，${applied.label}的时刻已恢复（只改内存草稿，未自动保存）。`)
    onHealthRecheck?.(applied.day)
  }

  const canUndo = applied !== null && draft !== null && draft.revision === applied.revision
  const previewIsStale =
    preview !== null &&
    draft !== null &&
    preview.revision !== null &&
    draft.revision !== preview.revision

  if (day.stops.length === 0) {
    return (
      <section
        ref={panelRef}
        tabIndex={-1}
        className="oc-panel-enter-fast mt-3 grid gap-3 rounded-[10px] border border-[color:var(--color-line-strong)] bg-background p-4"
        aria-label={`第 ${day.day} 天顺延建议`}
        data-testid="postpone-panel"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <h4 className="m-0 font-display text-md font-bold leading-normal">
            建议顺延：第 {day.day} 天
          </h4>
          <Button variant="ghost" onClick={onClose} aria-label="关闭顺延面板">
            关闭
          </Button>
        </div>
        <p className="m-0 text-sm text-muted-foreground" data-testid="postpone-empty">
          当天没有站点，无法顺延；这里不会自动添加站点，也不会自动保存。
        </p>
      </section>
    )
  }

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className="oc-panel-enter-fast mt-3 grid min-w-0 gap-3 rounded-[10px] border border-[color:var(--color-line-strong)] bg-background p-4"
      aria-label={`第 ${day.day} 天顺延建议`}
      data-testid="postpone-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-[1_1_240px]">
          <h4 className="m-0 font-display text-md font-bold leading-normal [overflow-wrap:anywhere]">
            建议顺延：第 {day.day} 天
          </h4>
          <p className="m-0 mt-1 max-w-[76ch] text-xs leading-relaxed text-muted-foreground">
            顺延只改时刻：从选定站起整体后移，不增删站点、不重排、不重新获取路线。
            先预览前后对照，确认后才写入内存草稿；不会自动保存。
          </p>
        </div>
        <Button variant="ghost" onClick={onClose} aria-label="关闭顺延面板">
          关闭
        </Button>
      </div>

      {suggestion !== null && (
        <p
          className="m-0 rounded-[6px] bg-secondary/60 px-3 py-2 text-xs leading-relaxed"
          data-testid="postpone-suggestion"
        >
          {suggestion.message}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <label className="grid min-w-0 flex-[1_1_260px] gap-1 text-xs">
          <span className="font-semibold">从哪一站开始顺延</span>
          <Select
            value={selectedStopId}
            onChange={(event) => {
              setTargetStopId(event.target.value)
              resetPreview()
            }}
            aria-label="从哪一站开始顺延"
            data-testid="postpone-target"
            data-dialog-initial-focus
          >
            {day.stops.map((stop, index) => (
              <option key={stop.id} value={stop.id}>
                第 {index + 1} 站 · {stop.name}（{stop.time || '时间未填'}）
              </option>
            ))}
          </Select>
        </label>

        <div className="grid gap-1 text-xs">
          <span className="font-semibold">顺延分钟</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="顺延分钟">
            {POSTPONE_MINUTES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={minutes === value}
                data-testid={`postpone-minutes-${value}`}
                onClick={() => {
                  setMinutes(value)
                  resetPreview()
                }}
                className="min-h-9 cursor-pointer rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-3 py-1 text-sm aria-pressed:border-[color:var(--color-primary)] aria-pressed:bg-accent-surface aria-pressed:font-semibold"
              >
                {value} 分钟
              </button>
            ))}
          </div>
        </div>

        <Button variant="outline" onClick={handlePreview} data-testid="postpone-preview-action">
          预览顺延
        </Button>
      </div>

      {draft === null && (
        <p className="m-0 text-xs leading-relaxed text-[color:var(--color-faint)]" data-testid="postpone-fork-note">
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
          <Button variant="outline" onClick={handleUndo} disabled={!canUndo} data-testid="postpone-undo">
            撤销这次顺延
          </Button>
          {!canUndo && (
            <span className="text-xs text-[color:var(--color-faint)]">
              草稿在上次顺延之后又有改动，这里不再提供撤销；可以用编辑器的「撤销草稿操作」回退。
            </span>
          )}
        </div>
      )}

      {preview && (
        <div
          className="grid gap-2 rounded-[8px] border border-dashed border-[color:var(--color-primary)] bg-accent-surface p-3"
          data-testid="postpone-preview"
          role="group"
          aria-label="顺延预览"
        >
          <p className="m-0 text-sm font-semibold text-[color:var(--color-accent-foreground)]">
            顺延预览：第 {preview.projection.targetIndex} 站起 {preview.projection.shiftedCount} 站
            {' '}各后移 {preview.projection.minutes} 分钟
          </p>

          <ol className="m-0 grid list-none gap-1 p-0" aria-label="顺延前后对照">
            {preview.projection.stops.map((stop) => (
              <li
                key={stop.id}
                className="text-sm [overflow-wrap:anywhere]"
                data-testid="postpone-preview-stop"
                data-shifted={stop.shifted || undefined}
                data-held={stop.heldReason !== null || undefined}
              >
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  第 {stop.index} 站
                </span>{' '}
                <span className={stop.shifted ? 'font-semibold' : ''}>{stop.name}</span>{' '}
                <span className="font-mono text-xs tabular-nums">
                  {stop.timeBefore} → {stop.shifted ? stop.timeAfter : '不变'}
                </span>
                {stop.endAfter !== null && stop.shifted && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    （停留后 {stop.endAfter}）
                  </span>
                )}
                {stop.heldReason !== null && (
                  <span className="ml-1 text-xs text-[color:var(--color-warn-ink)]">
                    （保持原时刻：{stop.heldReason}）
                  </span>
                )}
              </li>
            ))}
          </ol>

          {preview.projection.conflicts.length > 0 && (
            <div
              className="rounded-[6px] border border-[color:var(--color-warn-ink)]/40 bg-[color:var(--color-warn-bg)] px-3 py-2 text-xs leading-relaxed text-[color:var(--color-warn-ink)]"
              role="alert"
              data-testid="postpone-conflict"
            >
              {preview.projection.conflicts.map((conflict) => (
                <p key={conflict} className="m-0">
                  {conflict}
                </p>
              ))}
            </div>
          )}

          <ul className="m-0 grid list-none gap-1 p-0 text-xs text-muted-foreground">
            {preview.projection.notes.map((note) => (
              <li key={note} data-testid="postpone-note">
                {note}
              </li>
            ))}
          </ul>

          {previewIsStale && (
            <p className="m-0 text-xs text-[color:var(--color-warn-ink)]" data-testid="postpone-stale-note">
              草稿在预览后又有改动：确认时会按最新草稿校验，时刻对不上会拒绝写入并保持草稿原样。
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleConfirm} data-testid="postpone-confirm">
              确认写入草稿
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

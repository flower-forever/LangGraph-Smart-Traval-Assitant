import { useEffect, useId, useRef, useState } from 'react'
import type { Trip } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { countStops } from '../lib/mapData'
import {
  MAX_SAVED_STORAGE_BYTES,
  MAX_SAVED_TRIP_BYTES,
  MAX_SAVED_TRIPS,
  clearSavedTrips,
  deleteSavedTrip,
  loadSavedTrips,
  saveTripToStorage,
  undoSavedTripDeletion,
  type SavedTrip,
  type SavedTripsLoad,
} from '../lib/savedTrips'

export interface SavedTripsPanelProps {
  /** 当前正在查看的行程；后端不可用、还没有行程时为 null，此时只允许浏览和恢复 */
  trip: Trip | null
  onRestore: (trip: Trip, savedAt: number) => void
}

type NoticeTone = 'ok' | 'warn' | 'error'

interface Notice {
  tone: NoticeTone
  text: string
}

type FocusTarget =
  | { kind: 'list' }
  | { kind: 'heading' }
  | { kind: 'undo' }
  | { kind: 'item'; id: string }

function stateFromTrips(trips: SavedTrip[]): SavedTripsLoad {
  return {
    status: trips.length > 0 ? 'ok' : 'empty',
    trips,
    skipped: 0,
    message: null,
  }
}

const INITIAL_LOAD: SavedTripsLoad = { status: 'empty', trips: [], skipped: 0, message: null }

function humanBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`
}

/**
 * 本地保存 / 恢复 / 删除入口。
 *
 * - 不自动保存：只有点「保存当前行程」才写 localStorage；
 * - 不自动改动已有保存：读取只做校验，损坏数据必须由用户明确清除；
 * - 删除不弹系统确认框，改为页面内可撤销；撤销条保留到用户撤销、关闭或下一次删除。
 */
export default function SavedTripsPanel({ trip, onRestore }: SavedTripsPanelProps) {
  // 不在渲染期读 localStorage：SSR / 并发渲染都安全，挂载后再刷新列表
  const [state, setState] = useState<SavedTripsLoad>(INITIAL_LOAD)
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [undoRecord, setUndoRecord] = useState<SavedTrip | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null)

  const panelId = useId()
  const scopeNoteId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const undoButtonRef = useRef<HTMLButtonElement | null>(null)
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    setState(loadSavedTrips())
  }, [])

  // 删除后把焦点送到撤销按钮；撤销/关闭后回到列表，避免焦点丢到 body
  useEffect(() => {
    if (!focusTarget) return
    if (focusTarget.kind === 'list') listRef.current?.focus()
    else if (focusTarget.kind === 'heading') headingRef.current?.focus()
    else if (focusTarget.kind === 'undo') undoButtonRef.current?.focus()
    else itemButtonRefs.current.get(focusTarget.id)?.focus()
    setFocusTarget(null)
  }, [focusTarget, state])

  const handleToggle = () => {
    const next = !open
    setOpen(next)
    setConfirmClear(false)
    // 打开时重新读一次，避免用户在别的标签页删过记录后看到过期列表
    if (next) setState(loadSavedTrips())
  }

  const handleSave = () => {
    if (!trip) return
    const result = saveTripToStorage(trip)
    if (!result.ok) {
      // 达到上限 / 存储异常时展开列表，方便用户删除记录或走明确的清除流程；
      // 不做任何自动淘汰，也不覆盖原始数据。
      if (
        result.reason === 'corrupt' ||
        result.reason === 'anomaly' ||
        result.reason === 'limit' ||
        result.reason === 'too_large' ||
        result.reason === 'unavailable'
      ) {
        setOpen(true)
        setState(loadSavedTrips())
        setConfirmClear(false)
      }
      setNotice({ tone: 'error', text: result.message })
      return
    }

    setState(stateFromTrips(result.trips))
    setConfirmClear(false)

    let text: string
    if (!result.existed) {
      text = `已保存《${trip.title}》到当前浏览器与当前网址。仅此设备可见，不会上传或同步到其他设备。`
    } else if (result.changed) {
      text = `《${trip.title}》之前已保存过，已用当前内容更新保存版本，没有产生重复记录。`
    } else {
      text = `《${trip.title}》之前已保存过，已更新保存时间，没有产生重复记录。`
    }
    if (trip.source === 'example') {
      text += ' 这是示例行程，列表中会继续标注「示例」。'
    }
    setNotice({ tone: 'ok', text })
  }

  const handleDelete = (record: SavedTrip) => {
    const result = deleteSavedTrip(record.id)
    if (!result.ok) {
      if (
        result.reason === 'missing' ||
        result.reason === 'corrupt' ||
        result.reason === 'anomaly' ||
        result.reason === 'limit' ||
        result.reason === 'unavailable'
      ) {
        setState(loadSavedTrips())
      }
      setNotice({ tone: 'error', text: result.message })
      return
    }
    setState(stateFromTrips(result.trips))
    setNotice({ tone: 'ok', text: `已删除《${record.trip.title}》。可撤销。` })
    setUndoRecord(result.removed)
    setFocusTarget({ kind: 'undo' })
  }

  const handleUndo = () => {
    if (!undoRecord) return
    const target = undoRecord
    const result = undoSavedTripDeletion(target)
    if (!result.ok) {
      if (
        result.reason === 'corrupt' ||
        result.reason === 'anomaly' ||
        result.reason === 'limit' ||
        result.reason === 'unavailable'
      ) {
        setState(loadSavedTrips())
      }
      setNotice({ tone: 'error', text: result.message })
      return
    }
    setState(stateFromTrips(result.trips))
    setUndoRecord(null)
    if (!result.restored) {
      setNotice({ tone: 'warn', text: `《${target.trip.title}》已经在保存列表中，无需撤销。` })
      setFocusTarget(result.trips.length > 0 ? { kind: 'list' } : { kind: 'heading' })
      return
    }
    setNotice({ tone: 'ok', text: `已撤销删除，《${target.trip.title}》已恢复到列表。` })
    setFocusTarget({ kind: 'item', id: target.id })
  }

  const handleDismissUndo = () => {
    setUndoRecord(null)
    setFocusTarget(state.trips.length > 0 ? { kind: 'list' } : { kind: 'heading' })
  }

  const handleClearStorage = () => {
    const result = clearSavedTrips()
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.message })
      return
    }
    setState(loadSavedTrips())
    setConfirmClear(false)
    setNotice({ tone: 'ok', text: '已清除当前浏览器的全部本地保存数据，可以重新保存当前行程。' })
    setFocusTarget({ kind: 'heading' })
  }

  // 清除是不可撤销操作：必须由用户主动点开，再二次确认
  const clearControls = (kind: 'corrupt' | 'anomaly') => {
    const actionLabel = kind === 'corrupt' ? '清除损坏数据' : '清除全部本地数据'
    const groupLabel = kind === 'corrupt' ? '确认清除损坏数据' : '确认清除全部本地数据'
    const confirmText =
      kind === 'corrupt'
        ? '确认清除？此操作无法撤销，会删除本浏览器里无法读取的本地数据（能读到的保存行程也会一起删除）。'
        : '确认清除？此操作无法撤销，会删除本浏览器里所有保存的行程，包括无法识别的那部分原始数据。'
    return !confirmClear ? (
      <button type="button" className="btn btn-ghost" onClick={() => setConfirmClear(true)}>
        {actionLabel}
      </button>
    ) : (
      <div className="saved-confirm" role="group" aria-label={groupLabel}>
        <span>{confirmText}</span>
        <button type="button" className="btn" onClick={handleClearStorage}>确认清除</button>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirmClear(false)}>取消</button>
      </div>
    )
  }

  const handleRestore = (record: SavedTrip) => {
    onRestore(record.trip, record.savedAt)
    setOpen(false)
    setConfirmClear(false)
    setNotice({
      tone: 'ok',
      text: `已恢复《${record.trip.title}》，从行程第一天开始显示。仅此浏览器的本地副本，不会同步到其他设备。`,
    })
  }

  const savedCount = state.trips.length
  const savedSuffix = state.status === 'corrupt'
    ? '（数据异常）'
    : state.status === 'unavailable'
      ? '（不可用）'
      : savedCount > 0
        ? `（${savedCount}${state.skipped > 0 ? '，有异常记录' : ''}）`
        : state.skipped > 0
          ? '（有异常记录）'
          : ''

  return (
    <div className="saved-area" role="region" aria-label="本地行程保存">
      <div className="saved-toolbar">
        <div className="saved-actions">
          {trip ? (
            <button
              type="button"
              className="btn btn-save"
              onClick={handleSave}
              aria-describedby={scopeNoteId}
            >
              保存当前行程
            </button>
          ) : (
            <span className="saved-no-trip">当前还没有打开行程，不能保存；可以恢复下面的本地副本。</span>
          )}
          <button
            type="button"
            className="btn saved-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={handleToggle}
          >
            已保存行程{savedSuffix}
          </button>
          <span className="saved-scope-note" id={scopeNoteId}>
            仅保存在当前浏览器与当前网址，不上传、不跨设备同步
          </span>
        </div>
        <div className="saved-notice-live" aria-live="polite" aria-atomic="true">
          {notice && (
            <p className="saved-notice" data-tone={notice.tone}>
              {notice.text}
            </p>
          )}
        </div>
      </div>

      {open && (
        <section className="saved-panel" id={panelId} aria-label="已保存的行程列表">
          <div className="saved-panel-head">
            <h3 className="saved-panel-title" ref={headingRef} tabIndex={-1}>
              已保存的行程
            </h3>
            <p className="saved-panel-note">
              保存在当前浏览器与当前网址的本地存储中，最多 {MAX_SAVED_TRIPS} 份，单份约 {humanBytes(MAX_SAVED_TRIP_BYTES)}，
              总计约 {humanBytes(MAX_SAVED_STORAGE_BYTES)}。达到上限时不会自动替换旧记录，需要先删除一份再保存。
              清除浏览器站点数据会一并删除这些记录。
            </p>
          </div>

          {state.status === 'unavailable' && (
            <div className="saved-state" data-tone="error" role="status">
              {state.message ?? '当前浏览器无法访问本地存储，保存和恢复暂不可用。'}
            </div>
          )}

          {state.status === 'corrupt' && (
            <div className="saved-state" data-tone="error" role="alert">
              <p>{state.message ?? '本地保存数据已损坏。'}</p>
              <p className="saved-state-note">
                为避免覆盖无法读取的旧数据，保存已暂停。确认不再需要这些旧数据后，可以清除后重新保存。
              </p>
              {clearControls('corrupt')}
            </div>
          )}

          {(state.status === 'ok' || state.status === 'empty') && state.skipped > 0 && (
            <div className="saved-state" data-tone="warn" role="status">
              <p>{state.message ?? '本地保存里有无法识别的记录。'}</p>
              <p className="saved-state-note">
                仍可查看和恢复能读到的记录；在确认不再需要这些数据前，不会写入或覆盖原始内容。
                需要继续保存或删除时，请先清除全部本地数据。
              </p>
              {clearControls('anomaly')}
            </div>
          )}

          {state.status !== 'unavailable' && state.status !== 'corrupt' && (
            <>
              {undoRecord && (
                <div className="saved-undo" role="group" aria-label="删除撤销">
                  <span role="status">已删除《{undoRecord.trip.title}》。</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    ref={undoButtonRef}
                    onClick={handleUndo}
                  >
                    撤销删除
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    aria-label="关闭删除撤销提示"
                    onClick={handleDismissUndo}
                  >
                    关闭
                  </button>
                  <span className="saved-undo-hint">关闭页面后无法恢复。</span>
                </div>
              )}

              {state.trips.length === 0 ? (
                <p className="saved-empty">
                  {state.skipped > 0
                    ? '没有能安全读取的保存记录。原始数据仍保留在浏览器里，未做修改。'
                    : trip
                      ? '还没有保存的行程。点击上方「保存当前行程」，当前这份行程会留在本浏览器里。'
                      : '这个浏览器里还没有保存过的行程。等后端恢复、打开一份行程后，就可以保存到本地。'}
                </p>
              ) : (
                <ul className="saved-list" ref={listRef} tabIndex={-1} aria-label="保存的行程">
                  {state.trips.map((record) => {
                    const isCurrent = trip !== null && record.id === trip.id
                    const savedAtLabel = formatDateTime(record.savedAt)
                    return (
                      <li className="saved-item" key={record.id} data-current={isCurrent || undefined}>
                        <div className="saved-item-head">
                          <span className="saved-source-tag" data-source={record.trip.source}>
                            {record.trip.source === 'example' ? '示例' : 'AI 规划'}
                          </span>
                          <h4 className="saved-item-title">{record.trip.title}</h4>
                          {isCurrent && <span className="saved-current-tag">当前行程</span>}
                        </div>
                        <p className="saved-item-meta">
                          {record.trip.destination} · {record.trip.days.length} 天 ·{' '}
                          {countStops(record.trip)} 个站点 · 保存于 {savedAtLabel}
                        </p>
                        {record.trip.source === 'example' && (
                          <p className="saved-item-note">示例数据，仅用于演示，不是实际出行安排。</p>
                        )}
                        {record.trip.warnings.length > 0 && (
                          <p className="saved-item-note">
                            保存时保留了 {record.trip.warnings.length} 条行程提醒。
                          </p>
                        )}
                        <div className="saved-item-actions">
                          <button
                            type="button"
                            className="btn"
                            aria-label={`恢复保存的行程《${record.trip.title}》（保存于 ${savedAtLabel}）`}
                            ref={(element) => {
                              if (element) itemButtonRefs.current.set(record.id, element)
                              else itemButtonRefs.current.delete(record.id)
                            }}
                            onClick={() => handleRestore(record)}
                          >
                            恢复这份行程
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            aria-label={`删除保存的行程《${record.trip.title}》（保存于 ${savedAtLabel}）`}
                            onClick={() => handleDelete(record)}
                          >
                            删除
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </section>
      )}
    </div>
  )
}

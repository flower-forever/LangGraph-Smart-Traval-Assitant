import { useEffect, useId, useRef, useState } from 'react'
import type { Trip } from '../lib/api'
import {
  TRIP_MARKDOWN_SHARE_NOTICE,
  TRIP_SOURCE_LABELS,
  tripToMarkdown,
  type TripMarkdownResult,
} from '../lib/tripMarkdown'
import { downloadTripMarkdown } from '../lib/tripMarkdownFile'
import './tripMarkdownExport.css'

export interface TripMarkdownExportProps {
  trip: Trip
}

type NoticeTone = 'ok' | 'warn' | 'error'

interface Notice {
  tone: NoticeTone
  text: string
}

/** 预览快照：绑定生成时的完整内容，不只绑定 trip.id 或对象引用 */
interface MarkdownPreview {
  tripId: string
  /** 生成时的行程内容快照（序列化串），渲染期守卫用它判断「预览还算不算数」；
   *  只有序列化成功才可能有预览，序列化失败在生成时就 fail-closed 拒绝 */
  tripSnapshot: string
  markdown: string
  bytes: number
  filename: string
}

/**
 * 内容快照。序列化失败（循环引用 / BigInt 等理论上进不了 Trip，但宿主可能传入被改写过的对象）
 * 返回 ok=false，调用方把这类预览永久作废：序列化不了的快照无法证明「当前内容没变」，
 * 不能靠一个可撞车的哨兵串假装它能比。
 */
function tripSnapshot(trip: Trip): { ok: true; value: string } | { ok: false } {
  try {
    return { ok: true, value: JSON.stringify(trip) }
  } catch {
    return { ok: false }
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '体积未知'
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function failureText(result: Extract<TripMarkdownResult, { ok: false }>): string {
  if (result.reason === 'too_large') return result.message
  if (result.reason === 'bad_limit') return result.message
  return '当前行程的数据结构不完整或包含异常字段，没有生成 Markdown。行程本身仍可正常查看。'
}

/**
 * 可读路书（.md）导出子入口。
 *
 * 边界：
 * - 挂载 / 展开 / 行程变化都不生成文本、不建 Blob URL、不下载、不发请求、不写存储；
 * - 只有点「预览路书（Markdown）」才生成一次文本并展示为只读纯文本（不渲染 HTML / Markdown）；
 * - 预览之后才出现「下载路书 (.md)」与「放弃预览」；下载只把当前预览的同一份文本交给浏览器，
 *   不在下载时重新生成；
 * - 换行程、同 id 内容变化、撤销 / 导入等任何内容变化：渲染期守卫立即作废旧预览并清掉它，
 *   不只靠 effect 事后清理；旧预览不复活、旧下载通告不挂到新行程上，用户须重新预览；
 * - 上下文变化作废是在渲染期比较 + effect 永久清除两道：A→B→A 不会让旧预览复活；
 * - 放弃预览焦点回「预览路书（Markdown）」按钮，不抢其他控件焦点；
 * - 失败不改行程、不写存储；错误文案固定，不回显原始异常。
 */
export default function TripMarkdownExport({ trip }: TripMarkdownExportProps) {
  const [preview, setPreview] = useState<MarkdownPreview | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const headingId = useId()
  const generateId = useId()
  const previewHeadingId = useId()
  const previewTextId = useId()

  const generateButtonRef = useRef<HTMLButtonElement | null>(null)
  /**
   * 放弃预览时预览区连同「放弃预览」按钮一起卸载，焦点会掉到 body：
   * 标记一次，提交后把焦点交回生成按钮。
   */
  const discardFocusRef = useRef(false)

  /** 放弃预览后把焦点交回「预览路书（Markdown）」按钮；预览区卸载发生在同一提交里 */
  useEffect(() => {
    if (discardFocusRef.current) {
      discardFocusRef.current = false
      generateButtonRef.current?.focus()
    }
  })

  const snapshot = tripSnapshot(trip)
  // 渲染期守卫：id 或内容快照任一不一致、或当前快照序列化失败，预览立即作废。
  // 作废是「本次渲染不展示」，state 里的旧预览还要靠下面的 effect 永久清掉，
  // 否则 A→B→A 时 state 里的旧 A 预览会复活。
  const stale =
    preview !== null &&
    (!snapshot.ok || preview.tripId !== trip.id || preview.tripSnapshot !== snapshot.value)
  const livePreview = stale ? null : preview

  // 上下文一变就永久作废：清掉旧预览与旧通告。
  // 预览存在时按快照差异清（旧下载/生成通告不能挂到新行程上）；
  // 预览为 null 时（比如生成失败留下的错误通告）只要行程内容与上次渲染时不同也清——
  // 否则换到一份新行程或同 id 改回正确内容后，旧错误通告会一直挂着误导用户。
  // 不在这里自动重新生成——重新预览必须由用户点击。
  const lastSeenSnapshotRef = useRef<string | null>(null)
  const contextChanged = lastSeenSnapshotRef.current !== null &&
    lastSeenSnapshotRef.current !== (snapshot.ok ? snapshot.value : null)
  useEffect(() => {
    if (stale || contextChanged) {
      setPreview(null)
      setNotice(null)
    }
    lastSeenSnapshotRef.current = snapshot.ok ? snapshot.value : null
  })

  const handlePreview = () => {
    setNotice(null)
    const result = tripToMarkdown(trip)
    if (result.ok) {
      const snap = tripSnapshot(trip)
      if (!snap.ok) {
        // 快照都序列化不了就没法做内容守卫，fail-closed 不给预览
        setPreview(null)
        setNotice({
          tone: 'error',
          text: '当前行程的内容无法生成预览守卫，没有生成 Markdown。行程本身仍可正常查看。',
        })
        return
      }
      setPreview({
        tripId: trip.id,
        tripSnapshot: snap.value,
        markdown: result.markdown,
        bytes: result.bytes,
        filename: result.filename,
      })
      return
    }
    setPreview(null)
    setNotice({ tone: 'error', text: failureText(result) })
  }

  const handleDiscard = () => {
    discardFocusRef.current = true
    setPreview(null)
    setNotice(null)
  }

  const handleDownload = () => {
    if (!livePreview) return
    setNotice(null)
    // 只把已预览的这份文本交给下载函数；函数本身不接收生成入口，不会出现另一份内容
    const outcome = downloadTripMarkdown(trip, livePreview.markdown)
    if (outcome.ok) {
      setNotice({
        tone: 'ok',
        text:
          `已发起浏览器下载 ${outcome.filename}（${formatBytes(outcome.bytes)}）。` +
          '是否已保存到磁盘以浏览器为准；文件不会上传，也不会修改这份行程。',
      })
      return
    }
    // 下载失败保留合法预览，可直接重试；错误文案固定，不回显原始异常
    setNotice({ tone: 'error', text: outcome.message })
  }

  return (
    <div className="trip-md" role="region" aria-labelledby={headingId}>
      <h4 className="trip-md-subheading" id={headingId}>导出可读路书（Markdown）</h4>
      <p className="trip-md-lead">
        生成一份便于阅读和分享的每日路书文本文件（.md）。它只用于阅读：恢复行程请用上面的 JSON 备份。
      </p>

      <div className="trip-md-actions">
        <button
          type="button"
          ref={generateButtonRef}
          className="btn"
          onClick={handlePreview}
          aria-describedby={`${generateId}`}
        >
          预览路书（Markdown）
        </button>
      </div>
      <p className="trip-md-hint" id={generateId}>
        生成只发生在页面里：不联网、不写本地存储，也不会自动下载文件。下载要等预览之后单独点击。
      </p>

      {/* 唯一的状态播报区：有预览时也只在这里渲染一条 notice，不重复播报 */}
      <div className="trip-md-live" aria-live="polite" aria-atomic="true">
        {notice && (
          <p className="trip-md-notice" data-tone={notice.tone} data-testid="trip-md-notice">
            {notice.text}
          </p>
        )}
      </div>

      {livePreview && (
        <div className="trip-md-preview">
          <h5 className="trip-md-preview-title" id={previewHeadingId}>
            预览：{livePreview.filename}
          </h5>
          <p className="trip-md-meta">
            约 {formatBytes(livePreview.bytes)}（UTF-8 字节） · 行程来源：{TRIP_SOURCE_LABELS[trip.source]}
          </p>
          {/* 只读纯文本预览：textarea 不解析任何 HTML / Markdown，用户文本保持原样显示 */}
          <textarea
            id={previewTextId}
            className="trip-md-text"
            aria-labelledby={previewHeadingId}
            readOnly
            rows={10}
            wrap="soft"
            value={livePreview.markdown}
          />
          <p className="trip-md-hint">
            预览是只读纯文本，文件内容就是上面的文字。行程内容一旦变化，这里的预览与下载会立即作废，需要重新生成。
          </p>
          <div className="trip-md-actions">
            <button type="button" className="btn btn-primary" onClick={handleDownload}>
              下载路书 (.md)
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleDiscard}>
              放弃预览
            </button>
          </div>
        </div>
      )}

      <div className="trip-md-privacy">
        <p className="trip-md-privacy-title">分享前请留意</p>
        <ul className="trip-md-privacy-list">
          <li>{TRIP_MARKDOWN_SHARE_NOTICE}</li>
          <li>
            「行程来源」按记录里的 source 字段自述展示，不能证明文件真的由谁生成；
            导出按原记录整理，不新增也不核实营业、票价、预约或天气信息。
          </li>
        </ul>
      </div>
    </div>
  )
}

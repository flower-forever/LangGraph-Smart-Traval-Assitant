import { useEffect, useId, useRef, useState } from 'react'
import { canonicalJson } from '../lib/workspaceFingerprint'
import type { WorkspaceRecordV1 } from '../lib/workspaceTypes'
import { captureWorkspaceRuntime, workspaceRuntimeRefsMatch } from '../lib/workspace'
import type { WorkspaceRuntimeCaptureV1 } from '../lib/workspace'
import {
  OFFLINE_TRIP_DATA_SCOPE_NOTICE,
  OFFLINE_TRIP_HTML_MIME_TYPE,
  OFFLINE_TRIP_SHARE_NOTICE,
  OFFLINE_TRIP_UNVERIFIED_NOTICE,
  tripToOfflineHtml,
} from '../lib/offlineTripHtml'
import { Button } from '@/components/ui/button'

/** createObjectURL 后延迟回收：给浏览器留出发起下载的时间（Firefox 同步回收会取消下载） */
export const OFFLINE_TRIP_HTML_URL_REVOKE_DELAY_MS = 1000

export interface OfflineTripPanelProps {
  /**
   * 当前完整、已应用的 WorkspaceRecordV1。
   *
   * 组件不读 localStorage、不读会话恢复 raw、不写任何存储；App integrator 只需把
   * 当前有效的工作区记录传进来。组件内部仍会重新走 validator 并 fail-closed。
   */
  record: WorkspaceRecordV1
  /**
   * 父级运行期 epoch（单调、非负安全整数）。缺省 0 只用于兼容尚未接入的旧调用方；
   * App 集成后必须在用户编辑、采用、撤销、导入、切换工作区 / 候选 / 版本以及外部
   * storage 变化时推进 epoch 并传入。组件不会自动推进 epoch。
   *
   * 预览会捕获实际 record / trip / sidecar / budget 引用 + 该 epoch + 内容快照；
   * 任一项变化（包括同内容换引用、A→B→A）都会作废旧预览。契约见
   * docs/WORKSPACE_SIDECAR.md §5.1.1。
   */
  epoch?: number
}

type NoticeTone = 'ok' | 'warn' | 'error'

interface Notice {
  tone: NoticeTone
  text: string
}

/**
 * 预览快照：同时绑定生成时的实际对象引用 + safe epoch + 内容快照 + 运行期版本号。
 * 只比较内容会让「同内容换引用」和 A→B→A 复用旧预览；版本号保证即使 epoch 回退，
 * 只要中间观察过变化，旧预览也不会复活。
 */
interface OfflinePreview {
  snapshot: string
  capture: WorkspaceRuntimeCaptureV1
  contextVersion: number
  html: string
  bytes: number
  filename: string
  exportedAtText: string
  workspaceRevision: number
}

export interface OfflineTripHtmlDownloadOptions {
  /** 测试 / 非浏览器环境注入用；缺省取全局 document */
  document?: Document | null
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  /** 回收延迟，测试可传 0 */
  revokeDelayMs?: number
  /** 延迟调度器，测试可注入；缺省 setTimeout */
  schedule?: (callback: () => void, delayMs: number) => void
}

export type OfflineTripHtmlDownloadFailureReason = 'unsupported' | 'error' | 'missing_content'

export type OfflineTripHtmlDownloadOutcome =
  | { ok: true; filename: string; blob: Blob; html: string; bytes: number }
  | { ok: false; reason: OfflineTripHtmlDownloadFailureReason; message: string }

const MESSAGE_CREATE_FAILED = '创建下载链接失败，未下载任何文件。请重试；如果一直失败，检查浏览器的下载设置。'
const MESSAGE_TRIGGER_FAILED = '触发下载失败，未下载任何文件。请重试；如果一直失败，检查浏览器的下载设置。'
const MESSAGE_MISSING_CONTENT = '还没有可下载的预览内容。请先生成并确认预览，再下载。'

function safeRevoke(revoke: (url: string) => void, objectUrl: string): void {
  try {
    revoke(objectUrl)
  } catch {
    /* 清理失败静默，不影响业务结果 */
  }
}

function safeRemove(anchor: HTMLAnchorElement): void {
  try {
    anchor.remove()
  } catch {
    /* 清理失败静默 */
  }
}

/**
 * 显式下载已预览的离线 HTML。
 *
 * 只接收调用方已经展示给用户的同一份 html 文本；不接收生成入口，不存在下载时
 * 悄悄重新生成另一份内容的可能。Blob URL 延迟回收；失败固定文案，不回显异常原文。
 */
export function downloadOfflineTripHtml(
  html: string | null | undefined,
  filename: string | null | undefined,
  options: OfflineTripHtmlDownloadOptions = {},
): OfflineTripHtmlDownloadOutcome {
  const {
    document: doc = typeof document !== 'undefined' ? document : null,
    createObjectURL,
    revokeObjectURL,
    revokeDelayMs = OFFLINE_TRIP_HTML_URL_REVOKE_DELAY_MS,
    schedule,
  } = options

  if (typeof html !== 'string' || html === '' || typeof filename !== 'string' || filename === '') {
    return { ok: false, reason: 'missing_content', message: MESSAGE_MISSING_CONTENT }
  }

  if (!doc) {
    return { ok: false, reason: 'unsupported', message: '当前环境无法创建下载链接，未下载任何文件。' }
  }

  const create =
    createObjectURL ??
    (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL.bind(URL)
      : null)
  const revoke =
    revokeObjectURL ??
    (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function'
      ? URL.revokeObjectURL.bind(URL)
      : null)
  if (!create || !revoke) {
    return {
      ok: false,
      reason: 'unsupported',
      message: '当前浏览器不支持创建本地下载链接（URL.createObjectURL 不可用），未下载任何文件。',
    }
  }

  let blob: Blob
  try {
    blob = new Blob([html], { type: OFFLINE_TRIP_HTML_MIME_TYPE })
  } catch {
    return { ok: false, reason: 'error', message: MESSAGE_CREATE_FAILED }
  }

  let objectUrl: string
  try {
    objectUrl = create(blob)
  } catch {
    return { ok: false, reason: 'error', message: MESSAGE_CREATE_FAILED }
  }

  let anchor: HTMLAnchorElement
  try {
    anchor = doc.createElement('a')
  } catch {
    safeRevoke(revoke, objectUrl)
    return { ok: false, reason: 'error', message: MESSAGE_CREATE_FAILED }
  }

  try {
    anchor.href = objectUrl
    anchor.download = filename
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
  } catch {
    safeRevoke(revoke, objectUrl)
    return { ok: false, reason: 'error', message: MESSAGE_CREATE_FAILED }
  }

  try {
    doc.body.appendChild(anchor)
  } catch {
    safeRemove(anchor)
    safeRevoke(revoke, objectUrl)
    return { ok: false, reason: 'error', message: MESSAGE_TRIGGER_FAILED }
  }

  let clicked = false
  try {
    anchor.click()
    clicked = true
  } catch {
    /* 点击失败：立即回收，不留下不会被使用的 Blob URL */
  } finally {
    safeRemove(anchor)
  }

  if (!clicked) {
    safeRevoke(revoke, objectUrl)
    return { ok: false, reason: 'error', message: MESSAGE_TRIGGER_FAILED }
  }

  let revoked = false
  const revokeOnce = () => {
    if (revoked) return
    revoked = true
    safeRevoke(revoke, objectUrl)
  }
  const defaultSchedule = (callback: () => void, delayMs: number) => {
    setTimeout(callback, delayMs)
  }
  try {
    ;(schedule ?? defaultSchedule)(revokeOnce, revokeDelayMs)
  } catch {
    try {
      defaultSchedule(revokeOnce, revokeDelayMs)
    } catch {
      /* 默认调度也失败：best-effort，URL 交由浏览器最终回收 */
    }
  }

  return { ok: true, filename, blob, html, bytes: blob.size }
}

/**
 * 记录内容快照。使用契约里的 canonical JSON（对象键排序、数组保序、不调用 toJSON），
 * 比普通 JSON.stringify 更严格：循环引用 / NaN / undefined / BigInt / 抛错 getter
 * 都返回 null。无法证明「当前内容没变」时不得保留旧预览，调用方按 fail-closed 处理。
 */
function recordSnapshot(record: WorkspaceRecordV1): string | null {
  try {
    const canonical = canonicalJson(record)
    return canonical.ok ? canonical.text : null
  } catch {
    return null
  }
}

/** 缺省 epoch 兼容旧调用方；显式传入时必须是安全非负整数，否则 fail closed。 */
function normalizeEpoch(epoch: number | undefined): number | null {
  if (epoch === undefined) return 0
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null
}

interface RuntimeContextView {
  record: WorkspaceRecordV1
  trip: WorkspaceRecordV1['trip']
  sidecar: WorkspaceRecordV1['sidecar']
  budget: WorkspaceRecordV1['budget']
  epoch: number
  snapshot: string | null
}

function sameRuntimeContext(a: RuntimeContextView, b: RuntimeContextView): boolean {
  return (
    a.record === b.record &&
    a.trip === b.trip &&
    a.sidecar === b.sidecar &&
    a.budget === b.budget &&
    a.epoch === b.epoch &&
    a.snapshot === b.snapshot
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '体积未知'
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** W3b：notice 与隐私清单通用类名，从 OfflineTripPanel.css 迁来（shadcn + Tailwind）。 */
const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
  ok: 'bg-[color:var(--color-primary)]/40 text-[color:var(--color-accent-foreground)]',
  warn: 'bg-[color:var(--color-warn-bg)] text-[color:var(--color-secondary-foreground)]',
  error: 'bg-[color:var(--color-warn-bg)] text-[color:var(--color-warn-ink)]',
}
const NOTICE =
  'm-0 rounded-[6px] p-3 text-sm leading-relaxed font-medium [overflow-wrap:anywhere]'

/**
 * 离线随身行程页（单文件 HTML）子入口。
 *
 * 边界：
 * - 挂载 / 展开 / 记录变化都不生成 HTML、不建 Blob URL、不下载、不发请求、不写存储；
 * - 只有点「预览离线行程页」才生成一次，并在 sandbox="" 的 iframe srcdoc 中展示；
 * - 预览之后才出现「下载离线页 (.html)」；下载只把当前预览的同一份 HTML 交给浏览器，
 *   不在下载时重新生成；
 * - 预览捕获实际 record / trip / sidecar / budget 引用 + safe epoch + 内容快照 +
 *   运行期版本号；任一项变化（包括同内容换引用、epoch A→B→A）都会作废旧预览；
 *   渲染期守卫立即失效，effect 永久清除，下载前再次核对引用 / epoch / 快照；
 * - 失败不改工作区、不写存储；错误文案固定，不回显原始异常或用户内容；
 * - 页面本身无脚本、无远程资源；iframe sandbox 为空，不执行脚本、不加载外部资源。
 */
export default function OfflineTripPanel({ record, epoch }: OfflineTripPanelProps) {
  const [preview, setPreview] = useState<OfflinePreview | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const headingId = useId()
  const generateId = useId()
  const previewHeadingId = useId()

  const generateButtonRef = useRef<HTMLButtonElement | null>(null)
  const discardFocusRef = useRef(false)
  const preserveNoticeRef = useRef(false)

  useEffect(() => {
    if (discardFocusRef.current) {
      discardFocusRef.current = false
      generateButtonRef.current?.focus()
    }
  })

  const epochValue = normalizeEpoch(epoch)
  const safeEpoch = epochValue ?? 0
  const snapshot = recordSnapshot(record)
  const currentContext: RuntimeContextView = {
    record,
    trip: record.trip,
    sidecar: record.sidecar,
    budget: record.budget,
    epoch: safeEpoch,
    snapshot,
  }
  const contextRef = useRef<RuntimeContextView | null>(null)
  const contextVersionRef = useRef(0)
  if (contextRef.current === null) {
    contextRef.current = currentContext
  } else if (!sameRuntimeContext(contextRef.current, currentContext)) {
    contextRef.current = currentContext
    contextVersionRef.current += 1
  }
  const contextVersion = contextVersionRef.current

  const refsMatch =
    preview !== null &&
    epochValue !== null &&
    workspaceRuntimeRefsMatch(preview.capture, record, epochValue)
  const stale =
    preview !== null &&
    (snapshot === null ||
      preview.snapshot !== snapshot ||
      preview.contextVersion !== contextVersion ||
      !refsMatch)
  const livePreview = stale ? null : preview

  const lastSeenContextVersionRef = useRef<number | null>(null)
  const contextChanged =
    lastSeenContextVersionRef.current !== null &&
    lastSeenContextVersionRef.current !== contextVersion
  useEffect(() => {
    if (stale || contextChanged) {
      setPreview(null)
      // 失效下载的提示必须让用户看见；其它旧通知随旧预览一起清掉。
      if (!preserveNoticeRef.current) setNotice(null)
    }
    preserveNoticeRef.current = false
    lastSeenContextVersionRef.current = contextVersion
  })

  const handlePreview = () => {
    setNotice(null)
    if (epochValue === null) {
      setPreview(null)
      setNotice({
        tone: 'error',
        text: '父级传入的运行期 epoch 不合法（必须是安全非负整数），没有生成预览。工作区数据没有改变。',
      })
      return
    }
    // 点击时重新取快照：渲染与点击之间记录若被原地改写，预览仍绑定当前内容。
    const currentSnapshot = recordSnapshot(record)
    if (currentSnapshot === null) {
      setPreview(null)
      setNotice({
        tone: 'error',
        text: '当前工作区记录无法序列化为可验证的快照（可能包含循环引用或不可序列化字段），没有生成预览。工作区数据没有改变。',
      })
      return
    }
    const result = tripToOfflineHtml(record, { exportedAt: Date.now() })
    if (!result.ok) {
      setPreview(null)
      setNotice({ tone: 'error', text: result.message })
      return
    }
    const capture = captureWorkspaceRuntime(record, epochValue)
    if (!capture.ok) {
      setPreview(null)
      setNotice({
        tone: 'error',
        text: '当前运行期上下文无法捕获（记录或 epoch 不合法），没有生成预览。工作区数据没有改变。',
      })
      return
    }
    setPreview({
      snapshot: currentSnapshot,
      capture: capture.value,
      contextVersion,
      html: result.html,
      bytes: result.bytes,
      filename: result.filename,
      exportedAtText: result.exportedAtText,
      workspaceRevision: record.workspaceRevision,
    })
  }

  const handleDiscard = () => {
    discardFocusRef.current = true
    setPreview(null)
    setNotice(null)
  }

  const handleDownload = () => {
    if (!livePreview) return
    setNotice(null)
    const currentSnapshot = recordSnapshot(record)
    const currentRefsMatch =
      epochValue !== null && workspaceRuntimeRefsMatch(livePreview.capture, record, epochValue)
    if (
      currentSnapshot === null ||
      currentSnapshot !== livePreview.snapshot ||
      !currentRefsMatch ||
      livePreview.contextVersion !== contextVersion
    ) {
      // 这个提示必须活过同一提交里的清理 effect，否则用户只看到按钮消失、不知道为什么。
      preserveNoticeRef.current = true
      setPreview(null)
      setNotice({
        tone: 'error',
        text: '工作区记录或运行期上下文已变化，旧预览已失效；请重新预览后再下载。',
      })
      return
    }
    const outcome = downloadOfflineTripHtml(livePreview.html, livePreview.filename)
    if (outcome.ok) {
      setNotice({
        tone: 'ok',
        text:
          `已发起浏览器下载 ${outcome.filename}（${formatBytes(outcome.bytes)}）。` +
          '是否已保存到磁盘以浏览器为准；文件不会上传，也不会修改这份工作区。',
      })
      return
    }
    setNotice({ tone: 'error', text: outcome.message })
  }

  return (
    <div className="grid min-w-0 gap-3" role="region" aria-labelledby={headingId}>
      <h4
        className="m-0 font-display text-md font-bold leading-normal [overflow-wrap:anywhere]"
        id={headingId}
      >
        离线随身行程页（单文件 HTML）
      </h4>
      <p className="m-0 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        生成一份可双击打开、可打印的单文件行程页：包含当前已应用方案的每日顺序、时间与地址、预约 / 锚点说明、交通摘要、已知费用和准备清单。
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          ref={generateButtonRef}
          onClick={handlePreview}
          aria-describedby={generateId}
        >
          预览离线行程页
        </Button>
      </div>
      <p
        className="m-0 text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]"
        id={generateId}
      >
        生成只发生在页面里：不联网、不读写本地存储，也不会自动下载。页面是静态 HTML，不含脚本或外部资源；下载要等预览之后单独点击。
      </p>

      <div aria-live="polite" aria-atomic="true">
        {notice && (
          <p
            className={`${NOTICE} ${NOTICE_TONE_CLASS[notice.tone]}`}
            data-tone={notice.tone}
            data-testid="offline-trip-notice"
          >
            {notice.text}
          </p>
        )}
      </div>

      {livePreview && (
        <div className="grid min-w-0 gap-3 rounded-[10px] border border-border bg-background p-4">
          <h5
            className="m-0 text-sm font-bold leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]"
            id={previewHeadingId}
          >
            预览：{livePreview.filename}
          </h5>
          <p className="m-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            约 {formatBytes(livePreview.bytes)}（UTF-8 字节） · 生成时间：{livePreview.exportedAtText} · 工作区 revision：{livePreview.workspaceRevision}
          </p>
          <iframe
            className="h-80 w-full rounded-[6px] border border-border bg-background"
            title="离线行程页预览"
            sandbox=""
            srcDoc={livePreview.html}
            referrerPolicy="no-referrer"
          />
          <p className="m-0 text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
            预览在 sandbox 空的 iframe 中打开：不执行脚本、不加载外部资源。下载的是上面这份预览的同一份字节；工作区内容或运行期上下文一旦变化，预览与下载会立即作废，需要重新生成。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleDownload}>下载离线页 (.html)</Button>
            <Button variant="ghost" onClick={handleDiscard}>
              放弃预览
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-1.5 border-t border-t-border pt-3">
        <p className="m-0 text-sm font-semibold text-[color:var(--color-secondary-foreground)]">分享前请留意</p>
        <ul className="m-0 grid list-none gap-1 p-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {/* A2 合并：DATA_SCOPE_NOTICE 已含「不含候选库、版本库…」一句，原第 4 条与之重复，合并为一条。 */}
          <li>{OFFLINE_TRIP_DATA_SCOPE_NOTICE}</li>
          <li>{OFFLINE_TRIP_UNVERIFIED_NOTICE}</li>
          <li>{OFFLINE_TRIP_SHARE_NOTICE}</li>
        </ul>
      </div>
    </div>
  )
}

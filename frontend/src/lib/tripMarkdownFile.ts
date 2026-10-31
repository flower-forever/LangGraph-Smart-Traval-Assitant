/**
 * 可读路书 Markdown 的浏览器侧下载封装。
 *
 * 边界（与 ./tripFile.ts 的 JSON 下载同模式）：
 * - 只有显式传入已生成好的文本才创建 Blob 与 Blob URL；本模块不生成内容（生成在 ./tripMarkdown.ts），
 *   也不做网络请求、不写 localStorage。
 * - createObjectURL 成功后延迟回收（Firefox 同步回收会取消下载）；点击失败立即回收。
 * - 任何失败都不向渲染层抛异常；错误文案固定，不回显原始异常文本或路径。
 * - Blob 构造、anchor 属性设置、appendChild、延迟调度的异常全部在管控内：
 *   未发起下载的失败会回收已创建的 URL 并移除已插入的 anchor；点击已发起后调度失败时
 *   先改用默认延迟调度兜底，默认调度也失败才按 best-effort 交由浏览器页面关闭时回收。
 *   不做无条件同步回收——那会取消 Firefox 已开始的下载。
 * - 回收动作幂等：注入的调度器可能先执行回调再抛错，兜底再注册一次也不会重复回收。
 * - 清理动作（revoke / anchor.remove）自身的异常单独吞掉，不冒充业务成功或失败。
 * - 下载只表示「已发起浏览器下载」，不保证文件已落盘。
 */

import type { Trip } from './api'
import { safeTripMarkdownFilename, TRIP_MARKDOWN_MIME_TYPE } from './tripMarkdown'

/** createObjectURL 后延迟回收：给浏览器留出发起下载的时间 */
export const TRIP_MARKDOWN_URL_REVOKE_DELAY_MS = 1000

export interface TripMarkdownArtifact {
  filename: string
  blob: Blob
  markdown: string
  bytes: number
}

export type TripMarkdownDownloadFailureReason = 'unsupported' | 'error' | 'missing_text'

export interface TripMarkdownDownloadOptions {
  /** 测试 / 非浏览器环境注入用；缺省取全局 document */
  document?: Document | null
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  /** 回收延迟，测试可传 0 */
  revokeDelayMs?: number
  /** 延迟调度器，测试可注入；缺省 setTimeout */
  schedule?: (callback: () => void, delayMs: number) => void
}

export type TripMarkdownDownloadOutcome =
  | ({ ok: true } & TripMarkdownArtifact)
  | { ok: false; reason: TripMarkdownDownloadFailureReason; message: string }

const MESSAGE_CREATE_FAILED = '创建下载链接失败，未下载任何文件。请重试；如果一直失败，检查浏览器的下载设置。'
const MESSAGE_TRIGGER_FAILED = '触发下载失败，未下载任何文件。请重试；如果一直失败，检查浏览器的下载设置。'

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
 * 显式触发一次 .md 下载。
 * 调用方必须传入「用户已经预览过的同一份文本」——本函数不接收生成入口，不存在
 * 下载时悄悄重新生成另一份内容的可能；文本缺失时 fail-closed 返回 missing_text。
 */
export function downloadTripMarkdown(
  trip: Trip,
  markdown: string | null | undefined,
  options: TripMarkdownDownloadOptions = {},
): TripMarkdownDownloadOutcome {
  const {
    document: doc = typeof document !== 'undefined' ? document : null,
    createObjectURL,
    revokeObjectURL,
    revokeDelayMs = TRIP_MARKDOWN_URL_REVOKE_DELAY_MS,
    schedule,
  } = options

  if (typeof markdown !== 'string' || markdown === '') {
    return {
      ok: false,
      reason: 'missing_text',
      message: '还没有可下载的预览内容。请先生成并确认预览，再下载。',
    }
  }

  if (!doc) {
    return {
      ok: false,
      reason: 'unsupported',
      message: '当前环境无法创建下载链接，未下载任何文件。',
    }
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

  const filename = safeTripMarkdownFilename(trip)

  // Blob 构造（可能因非法参数抛错）也纳入管控；此前它在 try 外，异常会直接逃出事件
  let blob: Blob
  try {
    blob = new Blob([markdown], { type: TRIP_MARKDOWN_MIME_TYPE })
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

  // href / download / rel / 样式的设置都可能被宿主拦截抛错，统一按「URL 已建、未插入」处理：
  // 回收 URL 后返回固定失败文案
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
    // appendChild 半途抛错时可能已挂上节点：remove 对未挂载节点是空操作，统一清理无害
    safeRemove(anchor)
    safeRevoke(revoke, objectUrl)
    return { ok: false, reason: 'error', message: MESSAGE_TRIGGER_FAILED }
  }

  let clicked = false
  try {
    anchor.click()
    clicked = true
  } catch {
    // 点击失败：立即回收，不留下不会被使用的 Blob URL
  } finally {
    safeRemove(anchor)
  }

  if (!clicked) {
    safeRevoke(revoke, objectUrl)
    return { ok: false, reason: 'error', message: MESSAGE_TRIGGER_FAILED }
  }

  // 延迟回收。schedule 自身抛错不能让异常逃出事件，也不能冒充下载失败：
  // 点击已经发起，结果按成功处理，改用默认 setTimeout 兜底延迟回收；
  // 连默认调度都失败时才 best-effort 交给浏览器页面关闭回收。回收幂等，
  // 注入调度器「先执行回调再抛错」不会导致重复回收。
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

  return { ok: true, filename, blob, markdown, bytes: blob.size }
}

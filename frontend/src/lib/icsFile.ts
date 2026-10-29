import type { Trip } from './api'
import { tripToIcs, type IcsExportOptions, type IcsExportResult } from './calendar'

/** .ics 的标准 MIME；带 charset 让导入端按 UTF-8 解码中文 */
export const ICS_MIME_TYPE = 'text/calendar;charset=utf-8'

/**
 * createObjectURL 后延迟回收：给浏览器留出发起下载的时间。
 * Firefox 在点击后立刻 revoke 会取消下载，所以不能同步回收。
 */
export const ICS_URL_REVOKE_DELAY_MS = 1000

const MAX_FILENAME_BASE = 80
/** Windows 保留设备名不能直接做文件名（CON.ics 也不允许） */
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/**
 * 把任意标题/目的地清洗成可安全落盘的文件名片段：
 * 去掉路径分隔符、Windows 非法字符、控制字符，折叠空白与多余点号，再去掉首尾的点 / 空格 / 连字符。
 * 保留中文和常见符号，不做音译。
 */
export function sanitizeFilenamePart(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
  return truncateCodePoints(cleaned, MAX_FILENAME_BASE).replace(/^[.\s-]+|[.\s-]+$/g, '')
}

/**
 * 生成安全、可读、稳定的 .ics 文件名：
 * 目的地 + 行程标题，清洗非法字符并限长；空标题退到 trip.id，再退到 trip.ics。
 * 不包含时间戳，保证同一行程重复导出的文件名一致。
 */
export function safeIcsFilename(trip: Trip): string {
  const destination = sanitizeFilenamePart(trip?.destination)
  const title = sanitizeFilenamePart(trip?.title)
  let base = [destination, title]
    .filter(Boolean)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim()
  if (!base) base = sanitizeFilenamePart(trip?.id) || 'trip'
  base = truncateCodePoints(base, MAX_FILENAME_BASE).replace(/^[.\s-]+|[.\s-]+$/g, '')
  if (!base) base = 'trip'
  if (RESERVED_WINDOWS_NAME.test(base)) base = `trip-${base}`
  return `${base}.ics`
}

export interface IcsArtifact {
  result: IcsExportResult
  filename: string
  blob: Blob
}

/** 生成下载用的 .ics 内容与文件名（纯函数 + Blob，不触发任何下载） */
export function createIcsArtifact(trip: Trip, options: IcsExportOptions = {}): IcsArtifact {
  const result = tripToIcs(trip, options)
  return {
    result,
    filename: safeIcsFilename(trip),
    blob: new Blob([result.ics], { type: ICS_MIME_TYPE }),
  }
}

export interface IcsDownloadOptions extends IcsExportOptions {
  /** 测试 / 非浏览器环境注入用；缺省取全局 document */
  document?: Document | null
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  /** 回收延迟，测试可传 0 */
  revokeDelayMs?: number
  /** 延迟调度器，测试可注入；缺省 setTimeout */
  schedule?: (callback: () => void, delayMs: number) => void
}

export type IcsDownloadOutcome =
  | { ok: true; filename: string; result: IcsExportResult; blob: Blob }
  | { ok: false; reason: 'no_events'; filename: string; result: IcsExportResult }
  | {
      ok: false
      reason: 'unsupported' | 'error'
      filename: string
      result: IcsExportResult
      message: string
    }

/**
 * 显式触发一次 .ics 下载。没有有效事件（eventCount === 0）时直接返回 no_events，
 * 不创建 Blob URL、不点击链接，避免下载空文件。
 * 其余失败（无 document / 不支持 createObjectURL / 点击抛错）也都返回可展示的结果，不向渲染层抛异常。
 */
export function downloadIcs(trip: Trip, options: IcsDownloadOptions = {}): IcsDownloadOutcome {
  const {
    document: doc = typeof document !== 'undefined' ? document : null,
    createObjectURL,
    revokeObjectURL,
    revokeDelayMs = ICS_URL_REVOKE_DELAY_MS,
    schedule,
    now,
    firstDate,
  } = options
  const result = tripToIcs(trip, { now, firstDate })
  const filename = safeIcsFilename(trip)

  if (result.eventCount === 0) {
    return { ok: false, reason: 'no_events', filename, result }
  }
  if (!doc) {
    return {
      ok: false,
      reason: 'unsupported',
      filename,
      result,
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
      filename,
      result,
      message: '当前浏览器不支持创建本地下载链接（URL.createObjectURL 不可用），未下载任何文件。',
    }
  }

  const blob = new Blob([result.ics], { type: ICS_MIME_TYPE })
  let objectUrl: string
  try {
    objectUrl = create(blob)
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      filename,
      result,
      message: `创建下载链接失败${error instanceof Error && error.message ? `：${error.message}` : ''}，未下载任何文件。`,
    }
  }

  const anchor = doc.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  doc.body.appendChild(anchor)
  try {
    anchor.click()
  } catch (error) {
    // 点击失败时立即回收，避免留下不会被使用的 Blob URL
    revoke(objectUrl)
    return {
      ok: false,
      reason: 'error',
      filename,
      result,
      message: `触发下载失败${error instanceof Error && error.message ? `：${error.message}` : ''}，未下载任何文件。`,
    }
  } finally {
    anchor.remove()
  }

  const later = schedule ?? ((callback: () => void, delayMs: number) => { setTimeout(callback, delayMs) })
  later(() => revoke(objectUrl), revokeDelayMs)

  return { ok: true, filename, result, blob }
}

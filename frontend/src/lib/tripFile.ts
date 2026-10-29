/**
 * 行程 JSON 备份的浏览器侧封装：文件名、Blob、显式下载、读取用户选中的文件。
 *
 * 边界：
 * - 只在用户显式点击时触发一次下载；没有网络请求，不上传，不写 localStorage，不覆盖任何已有文件
 *   （交给浏览器的另存为 / 下载目录，冲突名由浏览器自己加后缀）。
 * - 体积门禁在读文件之前执行：先用 File.size 判断，超限直接返回，不调用 text() / FileReader；
 *   File.size 不是有限非负数（NaN / Infinity / 负数）时也保守拒绝，不拿不可信的体积放行。
 * - File.text() 优先；旧浏览器或测试环境退到 FileReader。
 * - 失败都返回可展示的结果对象，不向渲染层抛异常；失败文案是固定文本（体积数字除外），
 *   不回显文件内容。
 * - 本模块产出的文本只用于文件下载，不参与 HTML 渲染。
 */

import type { Trip } from './api'
import { sanitizeFilenamePart } from './icsFile'
import type {
  TripBackupFailureReason,
  TripBackupOptions,
  TripImport,
  TripImportOptions,
} from './tripTransfer'
import {
  MAX_TRIP_FILE_BYTES,
  TRIP_TRANSFER_MIME_TYPE,
  createTripBackup,
  formatTooLargeMessage,
  parseTripBackup,
} from './tripTransfer'

/** createObjectURL 后延迟回收：给浏览器留出发起下载的时间（Firefox 同步回收会取消下载） */
export const TRIP_URL_REVOKE_DELAY_MS = 1000

const MAX_FILENAME_BASE = 80
/** Windows 保留设备名不能直接做文件名（CON.json 也不允许） */
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/**
 * 生成安全、可读、稳定的备份文件名：目的地 + 标题，清洗非法字符并限长。
 * 空标题退到 trip.id，再退到 trip.json；不含时间戳，同一行程重复导出文件名一致。
 */
export function safeTripBackupFilename(trip: Trip): string {
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
  return `${base}.json`
}

export interface TripArtifact {
  filename: string
  /** UTF-8 编码的 JSON Blob（带 charset） */
  blob: Blob
  json: string
  /** trip 字段的 UTF-8 字节数 */
  bytes: number
  exportedAt: string
  /** 需要展示给用户的固定提示（明文分享提醒等） */
  notices: string[]
}

export type TripArtifactOutcome =
  | ({ ok: true } & TripArtifact)
  | { ok: false; reason: TripBackupFailureReason; message: string }

/** 只生成内容与 Blob，不触发下载（供测试或自定义下载流程使用） */
export function createTripBackupArtifact(
  trip: Trip,
  options: TripBackupOptions = {},
): TripArtifactOutcome {
  const backup = createTripBackup(trip, options)
  if (!backup.ok) return { ok: false, reason: backup.reason, message: backup.message }
  return {
    ok: true,
    filename: safeTripBackupFilename(trip),
    blob: new Blob([backup.json], { type: TRIP_TRANSFER_MIME_TYPE }),
    json: backup.json,
    bytes: backup.bytes,
    exportedAt: backup.exportedAt,
    notices: backup.notices,
  }
}

export type TripDownloadFailureReason = TripBackupFailureReason | 'unsupported' | 'error'

export interface TripDownloadOptions extends TripBackupOptions {
  /** 测试 / 非浏览器环境注入用；缺省取全局 document */
  document?: Document | null
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  /** 回收延迟，测试可传 0 */
  revokeDelayMs?: number
  /** 延迟调度器，测试可注入；缺省 setTimeout */
  schedule?: (callback: () => void, delayMs: number) => void
}

export type TripDownloadOutcome =
  | ({ ok: true } & TripArtifact)
  | { ok: false; reason: TripDownloadFailureReason; message: string }

/**
 * 显式触发一次 .json 备份下载。没有 document / 不支持 createObjectURL / 点击抛错都返回可展示的结果。
 * 成功后按 TRIP_URL_REVOKE_DELAY_MS 回收 Blob URL，避免长时间占用内存。
 */
export function downloadTripBackup(trip: Trip, options: TripDownloadOptions = {}): TripDownloadOutcome {
  const {
    document: doc = typeof document !== 'undefined' ? document : null,
    createObjectURL,
    revokeObjectURL,
    revokeDelayMs = TRIP_URL_REVOKE_DELAY_MS,
    schedule,
    now,
  } = options

  const artifact = createTripBackupArtifact(trip, { now })
  if (!artifact.ok) return artifact
  const { filename, blob, json, bytes, exportedAt, notices } = artifact

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

  let objectUrl: string
  try {
    objectUrl = create(blob)
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
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
      message: `触发下载失败${error instanceof Error && error.message ? `：${error.message}` : ''}，未下载任何文件。`,
    }
  } finally {
    anchor.remove()
  }

  const later =
    schedule ??
    ((callback: () => void, delayMs: number) => {
      setTimeout(callback, delayMs)
    })
  later(() => revoke(objectUrl), revokeDelayMs)

  return { ok: true, filename, blob, json, bytes, exportedAt, notices }
}

/** 只依赖 File 的 size / text，测试可以传最小对象 */
export interface TripUploadLike {
  readonly name?: string
  readonly size?: number
  text?: () => Promise<string>
}

/** FileReader 的最小接口，便于注入假实现 */
export interface TextFileReader {
  result: string | ArrayBuffer | null
  error: unknown
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  readAsText(file: unknown): void
}

export interface TripFileReadOptions extends TripImportOptions {
  /** 没有 File.text() 时用 FileReader 兜底；注入便于测试 */
  fileReaderFactory?: () => TextFileReader
}

/** 解析结果，外加读取阶段的失败（read_error） */
export type TripFileImportResult = TripImport | { ok: false; reason: 'read_error'; message: string }

const MESSAGE_READ_ERROR = '读取文件失败，未导入任何内容。请重新选择文件或另存后再试。'
const MESSAGE_READ_CANCELLED = '文件读取被取消，未导入任何内容。'
const MESSAGE_NO_READER = '当前环境无法读取本地文件（File.text 与 FileReader 都不可用），未导入任何内容。'
/**
 * File.size 异常（NaN、负数、Infinity、非数字）时的固定文案。
 * 体积门禁依赖 size，读不出可信体积就保守拒绝，不拿它去判断「可能没超限」。
 */
const MESSAGE_SIZE_INVALID =
  '文件大小信息异常，无法确认是否超过体积上限，为安全起见没有读取这份文件。请重新选择文件或另存后再试。'

function readWithFileReader(file: TripUploadLike, reader: TextFileReader): Promise<string> {
  return new Promise((resolve, reject) => {
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('文件内容不是文本'))
    }
    reader.onerror = () => reject(reader.error ?? new Error(MESSAGE_READ_ERROR))
    reader.onabort = () => reject(new Error(MESSAGE_READ_CANCELLED))
    try {
      reader.readAsText(file)
    } catch (error) {
      reject(error)
    }
  })
}

function defaultFileReader(): TextFileReader | null {
  if (typeof FileReader === 'undefined') return null
  return new FileReader() as unknown as TextFileReader
}

/**
 * 读取用户选中的备份文件并解析。
 * 先按 File.size 做体积门禁（超限不读取内容），再按 File.text → FileReader 的顺序取文本，
 * 最后交给 parseTripBackup 做语法 / format / version / 结构校验。
 */
export async function readTripBackupFile(
  file: TripUploadLike,
  options: TripFileReadOptions = {},
): Promise<TripFileImportResult> {
  const limit = options.maxBytes ?? MAX_TRIP_FILE_BYTES
  if (typeof file !== 'object' || file === null) {
    return { ok: false, reason: 'read_error', message: MESSAGE_READ_ERROR }
  }

  // 体积门禁只看 File.size：缺省（undefined）交给解析阶段按真实字节判断；
  // 声明了但不是有限非负数（NaN / Infinity / 负数）就保守拒绝，不读取任何内容
  const rawSize: unknown = file.size
  if (rawSize !== undefined) {
    if (typeof rawSize !== 'number' || !Number.isFinite(rawSize) || rawSize < 0) {
      return { ok: false, reason: 'read_error', message: MESSAGE_SIZE_INVALID }
    }
    if (rawSize > limit) {
      return { ok: false, reason: 'too_large', message: formatTooLargeMessage(rawSize, limit) }
    }
  }

  let text: string
  const textMethod = file.text
  if (typeof textMethod === 'function') {
    try {
      const raw = await textMethod.call(file)
      if (typeof raw !== 'string') {
        return { ok: false, reason: 'read_error', message: MESSAGE_READ_ERROR }
      }
      text = raw
    } catch {
      return { ok: false, reason: 'read_error', message: MESSAGE_READ_ERROR }
    }
  } else {
    const reader = options.fileReaderFactory ? options.fileReaderFactory() : defaultFileReader()
    if (!reader) {
      return { ok: false, reason: 'read_error', message: MESSAGE_NO_READER }
    }
    try {
      text = await readWithFileReader(file, reader)
    } catch (error) {
      const cancelled = error instanceof Error && error.message === MESSAGE_READ_CANCELLED
      return {
        ok: false,
        reason: 'read_error',
        message: cancelled ? MESSAGE_READ_CANCELLED : MESSAGE_READ_ERROR,
      }
    }
  }

  // parseTripBackup 会再按 UTF-8 字节数判一次体积：File.size 与实际文本不一致时也不会漏判
  return parseTripBackup(text, { maxBytes: limit })
}

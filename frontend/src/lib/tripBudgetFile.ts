/**
 * 费用备份的浏览器侧封装：文件名、Blob、显式下载、读取用户选中的文件。
 *
 * 边界（与 ./tripMarkdownFile.ts 已修模式一致）：
 * - 只有显式传入已生成好的文本才创建 Blob 与 Blob URL；本模块不生成内容
 *   （生成在 ./tripBudgetTransfer.ts），不发网络请求、不写 localStorage。
 * - createObjectURL 成功后延迟回收（Firefox 同步回收会取消下载）；点击失败立即回收。
 * - 任何失败都不向渲染层抛异常；错误文案固定，不回显原始异常文本或路径。
 * - Blob 构造、anchor 属性设置、appendChild、延迟调度的异常全部在管控内：
 *   未发起下载的失败回收已创建的 URL 并移除已插入的 anchor；点击已发起后调度失败
 *   先用默认延迟调度兜底，默认调度也失败才 best-effort 交由浏览器页面关闭时回收。
 *   回收动作幂等：注入的调度器可能先执行回调再抛错，兜底再注册也不会重复回收。
 * - 清理动作（revoke / anchor.remove）自身的异常单独吞掉，不冒充业务成功或失败。
 * - 下载只表示「已发起浏览器下载」，不保证文件已落盘。
 * - 读文件：体积上限配置先按 isValidBudgetByteLimit 校验（只能收紧，非法是独立的
 *   typed 错误，不伪装成用户文件过大）；File.size 必须存在且为非负整数（缺失 /
 *   非有限 / 负数 / 小数都保守拒绝），没有可信 size 就不读内容。
 * - 解码合同：优先字节路径（File.arrayBuffer / FileReader.readAsArrayBuffer）+
 *   TextDecoder('utf-8', { fatal: true, ignoreBOM: true })——严格 UTF-8，坏编码
 *   固定错误，不做静默替换；BOM 不在解码层吞掉，原样交给解析层「最多剥一个」：
 *   单 BOM 允许、双 BOM 拒绝。仅当字节接口本来不可用才退回 File.text /
 *   readAsText（该路径的解码合同由宿主决定，见模块尾部局限说明）；
 *   字节接口存在但读取失败时不降级到文本路径，固定 read_error。
 * - FileReader 的创建（含注入工厂）也在 try 内：工厂抛错落入固定 outcome，
 *   raw 异常不逃出 async 函数。
 * - 解析交给 ./tripBudgetTransfer.ts 的 parseBudgetBackup。
 */

import type {
  BudgetImport,
  BudgetImportOptions,
} from './tripBudgetTransfer'
import {
  BUDGET_TRANSFER_MIME_TYPE,
  MAX_BUDGET_FILE_BYTES,
  formatBudgetTooLargeMessage,
  parseBudgetBackup,
  safeBudgetFilename,
} from './tripBudgetTransfer'

/** createObjectURL 后延迟回收：给浏览器留出发起下载的时间 */
export const BUDGET_URL_REVOKE_DELAY_MS = 1000

export interface BudgetArtifact {
  filename: string
  blob: Blob
  json: string
  bytes: number
}

export type BudgetDownloadFailureReason = 'unsupported' | 'error' | 'missing_text'

export interface BudgetDownloadOptions {
  /** 测试 / 非浏览器环境注入用；缺省取全局 document */
  document?: Document | null
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  /** 回收延迟，测试可传 0 */
  revokeDelayMs?: number
  /** 延迟调度器，测试可注入；缺省 setTimeout */
  schedule?: (callback: () => void, delayMs: number) => void
}

export type BudgetDownloadOutcome =
  | ({ ok: true } & BudgetArtifact)
  | { ok: false; reason: BudgetDownloadFailureReason; message: string }

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
 * 显式触发一次 .budget.json 下载。
 * 调用方必须传入「用户已经预览过的同一份 JSON」与导出自述 metadata——本函数不接收
 * 生成入口，不存在下载时悄悄重新生成另一份内容的可能；文本缺失时 fail-closed。
 * 文件名与预览展示统一走 safeBudgetFilename，显示名与实际下载名一致。
 */
export function downloadBudgetBackup(
  json: string | null | undefined,
  trip: { id: string; title: string } | null,
  options: BudgetDownloadOptions = {},
): BudgetDownloadOutcome {
  const {
    document: doc = typeof document !== 'undefined' ? document : null,
    createObjectURL,
    revokeObjectURL,
    revokeDelayMs = BUDGET_URL_REVOKE_DELAY_MS,
    schedule,
  } = options

  if (typeof json !== 'string' || json === '') {
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

  const filename = safeBudgetFilename(trip)

  // Blob 构造（可能因非法参数抛错）也纳入管控
  let blob: Blob
  try {
    blob = new Blob([json], { type: BUDGET_TRANSFER_MIME_TYPE })
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

  // href / download / rel / 样式设置可能被宿主拦截抛错：按「URL 已建、未插入」处理
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
  // 点击已经发起，按成功处理，改用默认 setTimeout 兜底；默认调度也失败时
  // best-effort 交给浏览器页面关闭回收。回收幂等，先执行回调再抛错不会重复回收。
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

  return { ok: true, filename, blob, json, bytes: blob.size }
}

/* ───────── 读取用户选中的文件 ───────── */

/** 只依赖 File 的 size 与内容读取方法，测试可以传最小对象 */
export interface BudgetUploadLike {
  readonly name?: string
  readonly size?: number
  /** 字节路径：优先使用，配合严格 UTF-8 解码（保留 BOM 合同） */
  arrayBuffer?: () => Promise<ArrayBuffer>
  /** 兜底文本路径：字节路径不可用时的最后手段（解码合同由宿主决定） */
  text?: () => Promise<string>
}

/** FileReader 的最小接口，便于注入假实现 */
export interface BudgetTextFileReader {
  result: string | ArrayBuffer | null
  error: unknown
  onload: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  readAsText(file: unknown): void
  /** 有字节路径时优先；缺省宿主 FileReader 自带 */
  readAsArrayBuffer?(file: unknown): void
}

export interface BudgetFileReadOptions extends BudgetImportOptions {
  /** 没有 File.arrayBuffer / File.text 时用 FileReader 兜底；注入便于测试 */
  fileReaderFactory?: () => BudgetTextFileReader
}

/** 解析结果，外加读取阶段的失败（read_error） */
export type BudgetFileImportResult = BudgetImport | { ok: false; reason: 'read_error'; message: string }

const MESSAGE_READ_ERROR = '读取文件失败，未导入任何内容。请重新选择文件或另存后再试。'
const MESSAGE_READ_CANCELLED = '文件读取被取消，未导入任何内容。'
const MESSAGE_NO_READER = '当前环境无法读取本地文件（可用读取方式都不可用），未导入任何内容。'
const MESSAGE_NOT_UTF8 = '文件内容不是有效的 UTF-8 编码文本，无法读取。请确认选择的是 UTF-8 编码的费用备份文件。'
/**
 * File.size 异常（缺失、NaN、负数、Infinity、小数、非数字）时的固定文案。
 * 体积门禁依赖可信 size：读不出可信体积就保守拒绝，不拿「可能没超限」去赌无界读取。
 */
const MESSAGE_SIZE_INVALID =
  '文件大小信息异常或缺失，无法确认是否超过体积上限，为安全起见没有读取这份文件。请重新选择文件或另存后再试。'
const MESSAGE_OPTIONS_INVALID =
  '读取配置的体积上限非法（必须是不超过 256 KB 的正整数），未读取或导入任何内容。'

function readWithFileReader(file: BudgetUploadLike, reader: BudgetTextFileReader): Promise<string | ArrayBuffer | null> {
  return new Promise((resolve, reject) => {
    reader.onload = () => {
      resolve(reader.result)
    }
    reader.onerror = () => reject(reader.error ?? new Error(MESSAGE_READ_ERROR))
    reader.onabort = () => reject(new Error(MESSAGE_READ_CANCELLED))
    try {
      if (typeof reader.readAsArrayBuffer === 'function') reader.readAsArrayBuffer(file)
      else reader.readAsText(file)
    } catch (error) {
      reject(error)
    }
  })
}

function defaultFileReader(): BudgetTextFileReader | null {
  if (typeof FileReader === 'undefined') return null
  return new FileReader() as unknown as BudgetTextFileReader
}

function isArrayBufferValue(value: unknown): value is ArrayBuffer {
  // 不用 instanceof：jsdom / 跨 realm 的 ArrayBuffer 不在同一个 realm 链上，
  // instanceof 会误判；Object.prototype.toString 在 realm 间稳定，
  // 再校验 byteLength 数字（TextDecoder / byteLength 门禁都依赖它）。
  return (
    Object.prototype.toString.call(value) === '[object ArrayBuffer]' &&
    typeof (value as ArrayBuffer).byteLength === 'number'
  )
}

function isDecoderAvailable(): boolean {
  return typeof TextDecoder === 'function'
}

/**
 * 严格 UTF-8 解码：fatal 拒绝坏编码（不做静默替换），ignoreBOM 保留前导 BOM
 * 原文交给解析层「最多剥一个」——单 BOM 允许、双 BOM 拒绝。
 */
function decodeStrictUtf8(bytes: ArrayBuffer): { ok: true; text: string } | { ok: false } {
  if (!isDecoderAvailable()) return { ok: false }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return { ok: true, text }
  } catch {
    return { ok: false }
  }
}

type ReadOutcome =
  | { kind: 'bytes'; bytes: ArrayBuffer }
  | { kind: 'text'; text: string }
  | { kind: 'failure'; message: string }

/** 按字节优先的顺序取内容；每一步的异常都收进固定 outcome，不向调用方抛。 */
async function readContent(
  file: BudgetUploadLike,
  options: BudgetFileReadOptions,
): Promise<ReadOutcome> {
  // 1) File.arrayBuffer：浏览器 File / jsdom Blob 都有，字节最可信。
  //    接口存在但读取失败（reject / 返回非 ArrayBuffer）固定失败，不降级到
  //    宿主解码的文本路径：一次失败的严格字节读取不能被悄悄降级成
  //    BOM 被吞 / 坏编码被静默替换的文本。
  if (typeof file.arrayBuffer === 'function') {
    try {
      const buffer = await file.arrayBuffer.call(file)
      if (isArrayBufferValue(buffer)) return { kind: 'bytes', bytes: buffer }
      return { kind: 'failure', message: MESSAGE_READ_ERROR }
    } catch {
      return { kind: 'failure', message: MESSAGE_READ_ERROR }
    }
  }

  // 2) File.text：仅当字节接口本来不可用才允许的兼容路径（解码合同由宿主决定）
  const textMethod = file.text
  if (typeof textMethod === 'function') {
    try {
      const raw = await textMethod.call(file)
      if (typeof raw !== 'string') return { kind: 'failure', message: MESSAGE_READ_ERROR }
      return { kind: 'text', text: raw }
    } catch {
      return { kind: 'failure', message: MESSAGE_READ_ERROR }
    }
  }

  // 3) FileReader（创建也在 try 内，工厂抛错落入固定 outcome）。
  //    放在 text 之后：jsdom 的 readAsText 对非 Blob 对象同步抛 TypeError，
  //    先试 FileReader 会把 fake 文件的解析错误吃成 read_error。
  let reader: BudgetTextFileReader | null = null
  try {
    reader = options.fileReaderFactory ? options.fileReaderFactory() : defaultFileReader()
  } catch {
    reader = null
  }
  if (reader) {
    try {
      const result = await readWithFileReader(file, reader)
      if (isArrayBufferValue(result)) return { kind: 'bytes', bytes: result }
      if (typeof result === 'string') return { kind: 'text', text: result }
      return { kind: 'failure', message: MESSAGE_READ_ERROR }
    } catch (error) {
      const cancelled = error instanceof Error && error.message === MESSAGE_READ_CANCELLED
      return { kind: 'failure', message: cancelled ? MESSAGE_READ_CANCELLED : MESSAGE_READ_ERROR }
    }
  }

  return { kind: 'failure', message: MESSAGE_NO_READER }
}

/**
 * 读取用户选中的费用备份文件并解析。
 * 顺序：体积上限配置校验（只允许收紧，非法是独立配置错误）→ File.size 门禁
 * （缺失 / 非有限 / 负数 / 小数一律保守拒绝，超限不读取内容）→ 取内容
 * （字节路径 → File.text → FileReader；字节路径严格 UTF-8 解码，BOM 保留给解析层；
 * 字节接口存在但读取失败固定 read_error，不降级文本）→
 * parseBudgetBackup 做语法 / format / version / currency / 结构校验。真实浏览器的
 * File 总有 arrayBuffer，严格 UTF-8 / BOM 合同在真实环境恒生效；文本路径的解码
 * 合同由宿主决定。
 */
export async function readBudgetBackupFile(
  file: BudgetUploadLike,
  options: BudgetFileReadOptions = {},
): Promise<BudgetFileImportResult> {
  const limit = options.maxBytes ?? MAX_BUDGET_FILE_BYTES
  if (
    typeof limit !== 'number' ||
    !Number.isFinite(limit) ||
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > MAX_BUDGET_FILE_BYTES
  ) {
    return { ok: false, reason: 'invalid_options', message: MESSAGE_OPTIONS_INVALID }
  }
  if (typeof file !== 'object' || file === null) {
    return { ok: false, reason: 'read_error', message: MESSAGE_READ_ERROR }
  }

  // 体积门禁只信 File.size：缺失或异常一律保守拒绝，不发起任何读取
  const rawSize: unknown = file.size
  if (typeof rawSize !== 'number' || !Number.isFinite(rawSize) || !Number.isInteger(rawSize) || rawSize < 0) {
    return { ok: false, reason: 'read_error', message: MESSAGE_SIZE_INVALID }
  }
  if (rawSize > limit) {
    return { ok: false, reason: 'too_large', message: formatBudgetTooLargeMessage(rawSize, limit) }
  }

  const content = await readContent(file, options)
  if (content.kind === 'failure') {
    return { ok: false, reason: 'read_error', message: content.message }
  }

  if (content.kind === 'bytes') {
    // 字节级复核（BOM 也算进这份文件），超限不解码
    if (content.bytes.byteLength > limit) {
      return { ok: false, reason: 'too_large', message: formatBudgetTooLargeMessage(content.bytes.byteLength, limit) }
    }
    const decoded = decodeStrictUtf8(content.bytes)
    if (!decoded.ok) {
      return { ok: false, reason: 'read_error', message: MESSAGE_NOT_UTF8 }
    }
    // 严格解码保留 BOM 原文：单 BOM 由解析层剥掉，双 BOM 落成 parse_error
    return parseBudgetBackup(decoded.text, { maxBytes: limit })
  }

  // 文本兜底路径：体积按真实 UTF-8 字节复核；解码合同由宿主决定（见局限说明）
  return parseBudgetBackup(content.text, { maxBytes: limit })
}

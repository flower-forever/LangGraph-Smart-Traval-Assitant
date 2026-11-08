import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import type { Trip } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { countStops } from '../lib/mapData'
import {
  getLocalStorage,
  loadSavedTrips,
  saveTripToStorage,
  type StorageLike,
} from '../lib/savedTrips'
import {
  downloadTripBackup,
  readTripBackupFile,
  safeTripBackupFilename,
  type TripFileImportResult,
} from '../lib/tripFile'
import { TRIP_JSON_SHARE_NOTICE, formatTripExportedAt } from '../lib/tripTransfer'
import TripMarkdownExport from './TripMarkdownExport'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface TripTransferPanelProps {
  /** 当前正在查看的行程；没有行程时为 null / 省略，此时只能导入 */
  trip?: Trip | null
  /** 用户点「打开这份行程」时回调；不传则只预览，不提供打开按钮 */
  onOpen?: (trip: Trip) => void
  /**
   * 存储实现，缺省用当前浏览器的 localStorage。
   * 显式传 null 表示「存储不可用」，用于宿主自管存储或测试注入。
   */
  storage?: StorageLike | null
}

type NoticeTone = 'ok' | 'warn' | 'error'

interface Notice {
  tone: NoticeTone
  text: string
}

/** 预览结果：只保留从文件解析出来、可以展示给用户的字段 */
interface Preview {
  trip: Trip
  exportedAt: string | null
  bytes: number
}

/** 待确认的替换：记录用户确认前看到的本地副本快照，确认时用它检测变化 */
interface PendingReplace {
  trip: Trip
  existingSavedAt: number
  existingTitle: string
  /**
   * 本地副本的完整内容快照（trip 序列化）。只比 savedAt 不够：
   * 同一毫秒内其他标签页改写内容时 savedAt 可能相同，会被当成「没变」而静默覆盖。
   */
  existingSnapshot: string
}

const GENERIC_STORAGE_UNAVAILABLE = '当前浏览器无法访问本地存储，这次没有写入任何内容。'
const GENERIC_STORAGE_READ_FAILED =
  '读取本地保存数据失败，这次没有写入任何内容。请检查浏览器设置或改用其他浏览器后重试。'
const GENERIC_STORAGE_ANOMALY =
  '本地保存里存在无法识别、重复或超出上限的记录。为避免覆盖这些原始数据，这次没有写入任何内容。'
const GENERIC_STORAGE_WRITE_FAILED =
  '写入本地存储失败，当前行程没有保存，已有记录保持原样。请重试；如果一直失败，检查浏览器是否允许本站使用本地存储。'

/** 内容快照：序列化失败（理论上不会发生）时返回空串，两侧都为空即视为没有变化 */
function tripSnapshot(trip: Trip): string {
  try {
    return JSON.stringify(trip)
  } catch {
    return ''
  }
}

/**
 * 读取失败的界面文案。
 * lib/savedTrips 在「读存储抛异常」的兜底分支里会带上浏览器原始异常文本（可能包含本机路径、
 * 站点设置等细节），界面一律换成固定文案，不把原生异常原样回显。
 */
function storageLoadFailureText(snapshot: { status: string; message: string | null }): string {
  if (snapshot.status === 'unavailable') return GENERIC_STORAGE_READ_FAILED
  const message = snapshot.message
  return message && message.trim() !== '' ? message : GENERIC_STORAGE_READ_FAILED
}

/**
 * 保存失败的界面文案。'unknown'（写存储 / 序列化抛错）与 'unavailable' 可能夹带原生异常文本，
 * 这里换成固定文案；其余原因（体积 / 结构 / 数量 / 配额 / 损坏 / 异常记录）的文案本身就是固定的。
 */
function saveFailureText(outcome: { reason: string; message: string }): string {
  if (outcome.reason === 'unknown') return GENERIC_STORAGE_WRITE_FAILED
  if (outcome.reason === 'unavailable') return GENERIC_STORAGE_UNAVAILABLE
  return outcome.message && outcome.message.trim() !== '' ? outcome.message : GENERIC_STORAGE_WRITE_FAILED
}

/**
 * 备份失败时的固定文案。体积 / 结构 / 导出时间的文案由 lib/tripTransfer 提供（都是固定文本，
 * 不回显文件内容）；下载环境相关的失败在这里换成界面文案，不把浏览器原始错误直接抛给用户。
 */
function exportFailureText(outcome: { reason: string; message: string }): string {
  if (outcome.reason === 'unsupported') {
    return '当前浏览器无法创建本地下载链接，没有下载任何文件。可以换一个浏览器，或检查是否禁用了下载。'
  }
  if (outcome.reason === 'error') {
    return '触发下载失败，没有下载任何文件。请重试；如果一直失败，检查浏览器的下载设置。'
  }
  return outcome.message
}

/** 导入失败文案：lib/tripFile 与 lib/tripTransfer 的失败文案都是固定文本，不回显文件内容 */
function importFailureText(outcome: Extract<TripFileImportResult, { ok: false }>): string {
  if (typeof outcome.message === 'string' && outcome.message.trim() !== '') return outcome.message
  return '这个文件无法导入，未写入任何内容。请确认选择的是本工具导出的行程备份。'
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '体积未知'
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** W3b：样式从 tripTransfer.css 迁来（shadcn + Tailwind）；.btn-save 一并退役为 shadcn Button。 */
const FIELD_LABEL = 'text-sm leading-relaxed text-muted-foreground'
const HINT = 'm-0 text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]'
const SUBHEADING =
  'm-0 font-display text-md font-bold leading-normal [overflow-wrap:anywhere]'
const SECTION_BOX = 'grid min-w-0 gap-3 rounded-[10px] border border-border bg-background p-4'
const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
  ok: 'bg-[color:var(--color-primary)]/40 text-[color:var(--color-accent-foreground)]',
  warn: 'bg-[color:var(--color-warn-bg)] text-[color:var(--color-secondary-foreground)]',
  error: 'bg-[color:var(--color-warn-bg)] text-[color:var(--color-warn-ink)]',
}
const NOTICE =
  'm-0 rounded-[6px] p-3 text-sm leading-relaxed font-medium [overflow-wrap:anywhere]'
const CODE =
  'rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-xs [overflow-wrap:anywhere]'

/**
 * 行程备份的导入 / 导出入口。
 *
 * - 只有点「下载行程备份」才生成并下载文件；渲染、预览、打开都不会触发下载；
 * - 选择文件后只用 readTripBackupFile 解析并预览，不写 localStorage、不自动覆盖；
 * - 保存前重新读一次本地存储：同 ID 必须由用户在页面内二次确认，确认时再读一次，
 *   并同时比对 savedAt 与本地副本的完整内容快照，任一变化都拒绝写入并刷新快照；
 * - localStorage 没有跨标签页的原子 compare-and-swap：「读 → 比对 → 写」之间其他标签页仍可能写入，
 *   这里只能缩小覆盖窗口、发现变化就拒绝，不声称绝对原子；
 * - 取消、放弃预览、无效文件都不写存储；页面内不使用 confirm / alert / prompt。
 */
export default function TripTransferPanel({ trip = null, onOpen, storage }: TripTransferPanelProps) {
  const [exportNotice, setExportNotice] = useState<Notice | null>(null)
  const [fileNotice, setFileNotice] = useState<Notice | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [reading, setReading] = useState(false)
  const [saveNotice, setSaveNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<PendingReplace | null>(null)

  const headingId = useId()
  const exportHeadingId = useId()
  const exportHintId = useId()
  const importHeadingId = useId()
  const fileId = useId()
  const fileHintId = useId()
  const previewHeadingId = useId()
  const confirmId = useId()

  /** 每次选择文件递增；晚到的旧读取结果直接丢弃，避免两次选择互相覆盖 */
  const readSeqRef = useRef(0)
  const aliveRef = useRef(true)
  const saveButtonRef = useRef<HTMLButtonElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  /** 上一次渲染时是否显示着内联确认：用它判断确认块是什么时候被关掉的 */
  const hadPendingRef = useRef(false)
  /**
   * 刚刚点了「放弃预览」。
   * 放弃预览会把整个预览区连同里面的按钮一起卸载，被聚焦的按钮消失后焦点会掉到 body，
   * 这里记一笔，提交后统一交回文件选择框。
   */
  const discardFocusRef = useRef(false)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /**
   * 焦点回位。不声明依赖：放弃预览在没有待确认（pending 一直是 null）时也要触发，
   * 只监听 pending 的 effect 在那条路径上根本不会重跑。
   * 只在提交后同步聚焦，不用定时器；组件卸载后 effect 不会再执行，晚到的异步读取也碰不到焦点。
   */
  useEffect(() => {
    const hadPending = hadPendingRef.current
    hadPendingRef.current = pending !== null

    if (discardFocusRef.current) {
      discardFocusRef.current = false
      // 放弃预览：预览区（含触发它的按钮）已经卸载，交回文件选择框
      fileInputRef.current?.focus()
      return
    }

    if (!hadPending || pending !== null) return
    // 确认块关闭（取消或确认替换）后焦点会掉到 body：交回触发它的「保存到本地」；
    // 如果预览也一起关掉了，交回文件选择框
    const target = saveButtonRef.current ?? fileInputRef.current
    target?.focus()
  })

  const resolveStorage = (): StorageLike | null =>
    storage === undefined ? getLocalStorage() : storage

  const handleExport = () => {
    if (!trip) return
    setExportNotice(null)
    const outcome = downloadTripBackup(trip)
    if (outcome.ok) {
      setExportNotice({
        tone: 'ok',
        text:
          `已开始下载 ${outcome.filename}（${formatBytes(outcome.bytes)}）。` +
          '文件只保存在你自己的电脑上，不会上传，也不会自动加入本地保存列表。',
      })
      return
    }
    setExportNotice({ tone: 'error', text: exportFailureText(outcome) })
  }

  const clearPreviewState = () => {
    setPreview(null)
    setPending(null)
    setSaveNotice(null)
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files && input.files.length > 0 ? input.files[0] : null
    // 立刻清空，用户重新选同一个文件时仍会触发 change；已取到的 file 引用不受影响
    input.value = ''

    if (!file) return

    const seq = readSeqRef.current + 1
    readSeqRef.current = seq
    setReading(true)
    setFileNotice(null)
    setExportNotice(null)
    clearPreviewState()

    const result = await readTripBackupFile(file)

    if (!aliveRef.current || seq !== readSeqRef.current) return
    setReading(false)
    if (result.ok) {
      setPreview({ trip: result.trip, exportedAt: result.exportedAt, bytes: result.bytes })
      return
    }
    setFileNotice({ tone: 'error', text: importFailureText(result) })
  }

  const handleDiscard = () => {
    // 无论有没有待确认的替换，放弃预览都会把触发它的按钮一起卸载：标记一次焦点回位
    discardFocusRef.current = true
    clearPreviewState()
    setFileNotice(null)
  }

  const handleOpen = () => {
    if (!preview || !onOpen) return
    onOpen(preview.trip)
    setSaveNotice({
      tone: 'ok',
      text: '已把这份行程交给页面打开；还没有写入本地保存，需要的话再点「保存到本地」。',
    })
  }

  const commitSave = (target: Trip) => {
    const result = saveTripToStorage(target, resolveStorage())
    if (!result.ok) {
      setPending(null)
      setSaveNotice({ tone: 'error', text: saveFailureText(result) })
      return
    }
    setPending(null)
    if (!result.existed) {
      setSaveNotice({
        tone: 'ok',
        text: `已保存《${target.title}》到当前浏览器的本地保存（新增一份），没有上传，也没有改动其他记录。`,
      })
      return
    }
    setSaveNotice({
      tone: 'ok',
      text: result.changed
        ? `已替换本地副本《${target.title}》：内容已更新，没有产生重复记录。`
        : `本地副本《${target.title}》内容一致，只更新了保存时间。`,
    })
  }

  const handleSaveClick = () => {
    if (!preview) return
    setSaveNotice(null)
    const store = resolveStorage()
    if (!store) {
      setSaveNotice({ tone: 'error', text: GENERIC_STORAGE_UNAVAILABLE })
      return
    }

    const snapshot = loadSavedTrips(store)
    if (snapshot.status === 'unavailable' || snapshot.status === 'corrupt') {
      setSaveNotice({
        tone: 'error',
        text: storageLoadFailureText(snapshot),
      })
      return
    }
    if (snapshot.skipped > 0) {
      setSaveNotice({ tone: 'warn', text: snapshot.message ?? GENERIC_STORAGE_ANOMALY })
      return
    }

    const existing = snapshot.trips.find((record) => record.id === preview.trip.id)
    if (existing) {
      // 相同 ID：先要用户明确知道「会替换本地副本且无法撤销」，不直接写。
      // 快照同时记下 savedAt 与完整内容，确认时才拿得出「期间是否变过」的证据
      setPending({
        trip: preview.trip,
        existingSavedAt: existing.savedAt,
        existingTitle: existing.trip.title,
        existingSnapshot: tripSnapshot(existing.trip),
      })
      return
    }
    commitSave(preview.trip)
  }

  const handleConfirmReplace = () => {
    if (!pending) return
    const store = resolveStorage()
    if (!store) {
      setPending(null)
      setSaveNotice({ tone: 'error', text: GENERIC_STORAGE_UNAVAILABLE })
      return
    }

    // 确认前再读一次：预览之后别的标签页可能新增、修改或删掉了同 ID 的副本
    const snapshot = loadSavedTrips(store)
    if (snapshot.status === 'unavailable' || snapshot.status === 'corrupt') {
      setPending(null)
      setSaveNotice({ tone: 'error', text: storageLoadFailureText(snapshot) })
      return
    }
    if (snapshot.skipped > 0) {
      setPending(null)
      setSaveNotice({ tone: 'warn', text: snapshot.message ?? GENERIC_STORAGE_ANOMALY })
      return
    }

    const existing = snapshot.trips.find((record) => record.id === pending.trip.id)
    if (!existing) {
      setPending(null)
      setSaveNotice({
        tone: 'warn',
        text: '确认前本地副本已经不在了（可能在其他标签页被删除），这次没有写入。要保存请再点一次「保存到本地」重新检查。',
      })
      return
    }
    const currentSnapshot = tripSnapshot(existing.trip)
    // savedAt 相同不代表内容相同：同一毫秒内其他标签页可以改写内容。两样都比，任一变化就拒绝
    if (existing.savedAt !== pending.existingSavedAt || currentSnapshot !== pending.existingSnapshot) {
      // 用户看到的快照已经过期：刷新快照并要求重新确认，不覆盖新副本
      setPending({
        trip: pending.trip,
        existingSavedAt: existing.savedAt,
        existingTitle: existing.trip.title,
        existingSnapshot: currentSnapshot,
      })
      setSaveNotice({
        tone: 'warn',
        text: '本地副本在确认前发生了变化（可能在其他标签页被更新，或内容在同一毫秒内被改写），这次没有写入。请对照上面的最新信息再确认一次。',
      })
      return
    }
    commitSave(pending.trip)
  }

  const handleCancelReplace = () => {
    setPending(null)
    setSaveNotice({ tone: 'warn', text: '已取消替换，本地保存没有变化。' })
  }

  const stopCount = trip ? countStops(trip) : 0
  const exportFilename = trip ? safeTripBackupFilename(trip) : null
  const previewStopCount = preview ? countStops(preview.trip) : 0

  return (
    <div className="grid min-w-0 gap-4" role="region" aria-labelledby={headingId}>
      <div className="grid gap-1.5">
        <h3
          className="m-0 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]"
          id={headingId}
        >
          行程备份与导入
        </h3>
        <p className="m-0 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          备份是一份明文 JSON 文件，只在你点击时下载；导入会先预览，默认不写入本地保存，也不会覆盖已保存的行程。
          有当前行程时，下方还提供只用于阅读分享的 Markdown 路书导出。
        </p>
      </div>

      <section className={SECTION_BOX} aria-labelledby={exportHeadingId}>
        <h4 className={SUBHEADING} id={exportHeadingId}>
          导出当前行程
        </h4>

        {trip ? (
          <>
            <p className="m-0 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
              当前行程：<strong>{trip.title}</strong>
              {trip.destination ? ` · ${trip.destination}` : ''}
              {` · 共 ${trip.days.length} 天 / ${stopCount} 个站点`}
            </p>
            <p className="m-0 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
              文件名：<code className={CODE}>{exportFilename}</code>
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleExport} aria-describedby={exportHintId}>
                下载行程备份 (.json)
              </Button>
            </div>
            <p className={HINT} id={exportHintId}>
              文件由浏览器下载到你自己的电脑，不会上传，不会修改这份行程，也不会自动加入本地保存列表。
            </p>
          </>
        ) : (
          <p className={HINT}>
            当前还没有打开行程，暂时不能导出。可以先从下面的备份文件导入，或在页面里生成行程后再回来。
          </p>
        )}

        <div aria-live="polite" aria-atomic="true">
          {exportNotice && (
            <p className={`${NOTICE} ${NOTICE_TONE_CLASS[exportNotice.tone]}`} data-tone={exportNotice.tone}>
              {exportNotice.text}
            </p>
          )}
        </div>
      </section>

      <section className={SECTION_BOX} aria-labelledby={importHeadingId}>
        <h4 className={SUBHEADING} id={importHeadingId}>
          从备份文件导入
        </h4>

        <div className="grid gap-1.5">
          <label className={FIELD_LABEL} htmlFor={fileId}>
            选择备份文件（.json）
          </label>
          <Input
            id={fileId}
            ref={fileInputRef}
            className="min-h-11 w-full"
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            aria-describedby={fileHintId}
            aria-busy={reading || undefined}
          />
          <p className={HINT} id={fileHintId}>
            选择后先在页面里预览，只有你点「保存到本地」才会写入当前浏览器；无效或超出体积上限的文件会被直接拒绝。
            读取失败后可以重新选同一个文件再试。
          </p>
        </div>

        {reading && (
          <p
            className="m-0 border-l-[3px] border-l-[color:var(--color-primary)] pl-3 text-sm leading-relaxed text-muted-foreground"
            role="status"
          >
            正在读取文件…
          </p>
        )}

        <div aria-live="polite" aria-atomic="true">
          {fileNotice && (
            <p className={`${NOTICE} ${NOTICE_TONE_CLASS[fileNotice.tone]}`} data-tone={fileNotice.tone}>
              {fileNotice.text}
            </p>
          )}
        </div>

        {preview && (
          <div className="grid min-w-0 gap-3 rounded-[10px] border border-border bg-card p-4">
            <h5
              className="m-0 text-sm font-bold leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]"
              id={previewHeadingId}
            >
              预览：{preview.trip.title}
            </h5>
            <dl
              className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 max-md:grid-cols-1"
              aria-labelledby={previewHeadingId}
            >
              <div>
                <dt className="text-xs text-muted-foreground">目的地</dt>
                <dd className="m-0 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
                  {preview.trip.destination || '未填写'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">规模</dt>
                <dd className="m-0 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
                  {`${preview.trip.days.length} 天 · ${previewStopCount} 个站点`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">行程来源（文件自述）</dt>
                <dd className="m-0 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
                  {preview.trip.source === 'example' ? '示例行程' : '生成行程'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">行程 ID</dt>
                <dd className="m-0">
                  <code className={CODE}>{preview.trip.id}</code>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">导出时间（文件自述）</dt>
                <dd className="m-0 font-mono text-sm leading-relaxed tabular-nums text-[color:var(--color-secondary-foreground)]">
                  {formatTripExportedAt(preview.exportedAt)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">数据体积</dt>
                <dd className="m-0 font-mono text-sm leading-relaxed tabular-nums text-[color:var(--color-secondary-foreground)]">
                  {formatBytes(preview.bytes)}
                </dd>
              </div>
            </dl>

            {/*
              信任边界：source / exportedAt 都是文件里写的字段，解析器只能校验格式，
              证明不了行程真的来自哪里、也证明不了这个时间真的发生过。
            */}
            <p className={HINT} data-testid="trip-transfer-provenance-hint">
              上面的「行程来源」和「导出时间」取自文件里的 source 与 exportedAt 字段：它们只代表文件自己是这么写的，
              不能证明这份行程的真实来源，也不能证明这个时间就是实际导出时间。
            </p>

            <p className={HINT}>
              预览只是把文件内容显示在页面里，还没有写入本地保存；放弃预览不会留下任何记录。
            </p>

            <div className="flex flex-wrap items-center gap-3">
              {onOpen && (
                <Button onClick={handleOpen}>打开这份行程</Button>
              )}
              <Button variant="secondary" ref={saveButtonRef} onClick={handleSaveClick}>
                保存到本地
              </Button>
              <Button variant="ghost" onClick={handleDiscard}>
                放弃预览
              </Button>
            </div>

            {onOpen ? null : (
              <p className={HINT}>
                当前页面还没接入「打开行程」的处理：这里只做预览，不会替换主视图。
              </p>
            )}

            {pending && (
              <div className="grid gap-2 rounded-[6px] border border-dashed border-[color:var(--color-warn-ink)]/50 bg-[color:var(--color-warn-bg)] p-3">
                {/*
                  role="alert" 只包文字：把按钮放进 alert 区域会让读屏把交互控件当成公告内容，
                  焦点进入时也不会有一次可靠的朗读。按钮放在紧邻的 group 里，用 aria-describedby
                  关联这段说明，键盘从「保存到本地」往后 Tab 就能到达。
                */}
                <p className="m-0 text-sm font-medium leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]" id={confirmId} role="alert">
                  本地已存在同一 ID 的保存记录《{pending.existingTitle}》（保存于{' '}
                  {formatDateTime(pending.existingSavedAt)}）。继续保存会替换这份本地副本，
                  替换后无法撤销，也不会保留旧版本。
                </p>
                <div
                  className="flex flex-wrap items-center gap-3"
                  role="group"
                  aria-label="替换本地副本确认"
                  aria-describedby={confirmId}
                >
                  <Button onClick={handleConfirmReplace}>确认替换本地副本</Button>
                  <Button variant="ghost" onClick={handleCancelReplace}>
                    取消替换
                  </Button>
                </div>
              </div>
            )}

            <div aria-live="polite" aria-atomic="true">
              {saveNotice && (
                <p className={`${NOTICE} ${NOTICE_TONE_CLASS[saveNotice.tone]}`} data-tone={saveNotice.tone}>
                  {saveNotice.text}
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* 可读路书（.md）导出子入口：与 JSON 备份互相独立，只服务当前行程，没有行程时不挂载 */}
      {trip && <TripMarkdownExport trip={trip} />}

      <div className="grid gap-1.5 border-t border-t-border pt-3">
        <p className="m-0 text-sm font-semibold text-[color:var(--color-secondary-foreground)]">分享前请留意</p>
        <ul className="m-0 grid list-none gap-1 p-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          <li>{TRIP_JSON_SHARE_NOTICE}</li>
          <li>
            备份里可能有你自己写的行程摘要、站点描述和地址，无法保证其中不含敏感信息；
            分享、发群或上传到网盘前请自行检查。
          </li>
        </ul>
      </div>
    </div>
  )
}

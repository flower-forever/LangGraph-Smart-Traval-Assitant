/**
 * 四期 S6 · 资料卡备份与恢复面板。
 *
 * 边界（与 docs/POI_CARD_BACKUP.md 对齐）：
 * - **导出零写入**：只读 record → build/serialize → 浏览器下载；不碰 localStorage。
 * - **导入先预览、确认才写入**：选择文件只读取文本并在内存里解析；失败不写任何键。
 *   只有「确认导入」才把合并计划交给父级 onSave（App 的 handleSavePoiCards，
 *   带 expectedRaw 冻结门）。取消 / 关闭 / 换文件都清空预览，零写入。
 * - **导入结果归本面板**：await onSave 返回的本次结果，只按它显示成功 / 失败；
 *   不读取父级共享的资料卡编辑保存状态，避免把别处的 saved / error 误报成导入结果。
 * - **预览实时计算**：新增 / 已存在分组与覆盖警告由当前 record + 文件卡片 + 策略
 *   重新计算；确认时使用同一份 plan。库在预览后变化会提示核对。
 * - 本面板不 import 任何存储模块、不发网络请求；唯一写入路径是 onSave。
 * - 文案红线：不出现「已预订 / 已确认 / 已出票」；未知显示「未知」。
 */
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  MAX_POI_CARDS_BACKUP_BYTES,
  buildPoiCardBackup,
  parsePoiCardBackup,
  planPoiCardImport,
  poiCardBackupFileName,
  serializePoiCardBackup,
  type PoiCardImportPlan,
  type PoiCardImportStrategy,
} from '../lib/poiCardBackup'
import type { PoiCardV1, PoiCardsRecordV1, PoiCardsSaveResult } from '../lib/poiCards'

export interface PoiCardBackupPanelProps {
  /** 父级读好的资料卡库；null = 未加载 / 不可用（只读提示，不假装为空）。 */
  record: PoiCardsRecordV1 | null
  /** 确认导入后的唯一写入请求；父级负责 expectedRaw 冲突门与存储写入。 */
  onSave: (record: PoiCardsRecordV1) => Promise<PoiCardsSaveResult>
  /** 显式重新读取资料卡库（只读）；冲突后由用户点击「重新载入资料卡库」触发。 */
  onReload: () => void
  /** 收起面板（预览与内存态随卸载丢弃，零写入）。 */
  onClose: () => void
  /** 当前时刻（epoch ms）；测试可注入，默认 Date.now。 */
  now?: () => number
}

interface PreviewState {
  fileName: string
  cards: PoiCardV1[]
  /** 预览建立时的库签名；用于提示「资料卡库已更新」。 */
  baseSignature: string
}

type ImportStatus = 'idle' | 'saving' | 'saved' | 'error'

const PANEL =
  'grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5 shadow-[var(--shadow-1)] max-md:p-4'
const SECTION_BOX = 'grid gap-3 rounded-[10px] border border-border bg-background p-4'
const HINT = 'm-0 text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]'
const NOTICE =
  'm-0 rounded-[6px] border border-[color:var(--color-line-strong)] bg-secondary p-3 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]'
const ERROR_NOTICE =
  'm-0 rounded-[6px] border border-[color:var(--color-warn-ink)]/40 bg-[color:var(--color-warn-bg)] p-3 text-sm font-medium leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]'
const WARN_NOTICE =
  'm-0 rounded-[6px] border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] p-3 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]'
const GROUP_LIST = 'm-0 grid list-none gap-1 p-0 text-sm leading-relaxed'
const GROUP_NAME = 'text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]'

/** 只在显式点击时创建本地下载；失败返回 false，不向渲染层抛异常。 */
function downloadBackupFile(text: string, fileName: string): boolean {
  try {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    return true
  } catch {
    return false
  }
}

/**
 * 读取选中文件的文本：优先 File.text()，不可用或失败时退回 FileReader
 * （与 tripFile.ts 同一容错口径；旧浏览器 / jsdom 没有 Blob.text）。
 */
async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    try {
      const value = await file.text()
      if (typeof value === 'string') return value
    } catch {
      // 落到 FileReader
    }
  }
  return await new Promise<string>((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('当前环境无法读取本地文件。'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('文件内容不是文本。'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败。'))
    reader.onabort = () => reject(new Error('文件读取被取消。'))
    reader.readAsText(file)
  })
}

/**
 * 只用于「预览之后库是否变化」的轻量签名：分组只依赖 id / identityKey。
 * 用 JSON 数组编码，避免 id / identityKey 内的分隔符造成拼接碰撞；不序列化整库。
 */
function recordSignature(record: PoiCardsRecordV1 | null): string {
  if (record === null) return 'unavailable'
  return JSON.stringify(record.cards.map((card) => [card.id, card.identityKey]))
}

export default function PoiCardBackupPanel({
  record,
  onSave,
  onReload,
  onClose,
  now = () => Date.now(),
}: PoiCardBackupPanelProps) {
  const headingId = useId()
  const exportHeadingId = useId()
  const importHeadingId = useId()
  const fileId = useId()
  const fileHelpId = useId()
  const strategyName = useId()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const readSeqRef = useRef(0)
  const mountedRef = useRef(true)
  /** 防止同一 tick 内双击「确认导入」触发两次写入。 */
  const savingRef = useRef(false)
  /** 稳定 now 引用：默认参数每次渲染是新函数，避免 plan 无谓重算。 */
  const nowRef = useRef(now)
  nowRef.current = now

  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [strategy, setStrategy] = useState<PoiCardImportStrategy>('skip')
  const [error, setError] = useState<string | null>(null)
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [importStatus, setImportStatus] = useState<ImportStatus>('idle')
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [importConflict, setImportConflict] = useState(false)
  const [lastSummary, setLastSummary] = useState<string | null>(null)

  // 卸载后 in-flight 读取 / 保存的结果不再更新本面板。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      readSeqRef.current += 1
    }
  }, [])

  const parsedCards = preview === null ? null : preview.cards
  const existingKeys = useMemo(
    () => new Set((record === null ? [] : record.cards).map((card) => card.identityKey)),
    [record],
  )
  const previewGroups = useMemo(() => {
    if (parsedCards === null) return { added: [] as PoiCardV1[], existing: [] as PoiCardV1[] }
    const added: PoiCardV1[] = []
    const existing: PoiCardV1[] = []
    for (const card of parsedCards) {
      if (existingKeys.has(card.identityKey)) existing.push(card)
      else added.push(card)
    }
    return { added, existing }
  }, [parsedCards, existingKeys])

  // 确认与预览共用同一份 plan；record / 文件 / 策略变化都会立即重算。
  const plan = useMemo<PoiCardImportPlan | null>(() => {
    if (record === null || parsedCards === null) return null
    return planPoiCardImport(record, parsedCards, strategy, nowRef.current())
  }, [record, parsedCards, strategy])

  const recordChanged =
    preview !== null && preview.baseSignature !== recordSignature(record)
  const planError = plan !== null && !plan.ok ? plan.message : null
  const canConfirm = plan !== null && plan.ok && importStatus !== 'saving'

  const handleExport = () => {
    if (record === null) return
    setExportNotice(null)
    const timestamp = nowRef.current()
    const backup = buildPoiCardBackup(record, timestamp)
    const fileName = poiCardBackupFileName(timestamp)
    const text = serializePoiCardBackup(backup)
    if (!downloadBackupFile(text, fileName)) {
      setExportNotice('当前浏览器无法创建本地下载链接，未下载任何文件；资料卡库未改动。')
      return
    }
    setExportNotice(
      `已开始下载 ${fileName}（${record.cards.length} 张卡）。文件只保存在本机，不会上传，也不会写入或修改任何本地记录。`,
    )
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files && input.files.length > 0 ? input.files[0] : null
    // 立刻清空：重新选同一个文件仍会触发 change；已取到的 file 引用不受影响。
    input.value = ''
    if (!file) return

    // 新选择让上一次读取失效，并清空旧预览 / 旧导入结果（零写入）。
    const seq = readSeqRef.current + 1
    readSeqRef.current = seq
    setReading(false)
    setPreview(null)
    setStrategy('skip')
    setError(null)
    setImportStatus('idle')
    setImportMessage(null)
    setImportConflict(false)
    setLastSummary(null)

    if (record === null) {
      setError('资料卡库当前不可用或未能读取；为避免覆盖未知数据，不能导入。资料卡库未改动。')
      return
    }

    // 先看 file.size，超限直接 typed 拒绝，不把整个文件读进内存。
    if (file.size > MAX_POI_CARDS_BACKUP_BYTES) {
      setError(
        `备份文件超过 ${MAX_POI_CARDS_BACKUP_BYTES} 字节的 UTF-8 上限（实际 ${file.size} 字节），没有读取，资料卡库未改动。`,
      )
      return
    }

    setReading(true)
    let text: string
    try {
      text = await readFileText(file)
    } catch {
      if (seq !== readSeqRef.current || !mountedRef.current) return
      setReading(false)
      setError('读取文件失败，没有解析，资料卡库未改动。可以重新选择这个文件再试。')
      return
    }
    if (seq !== readSeqRef.current || !mountedRef.current) return
    setReading(false)

    const parsed = parsePoiCardBackup(text)
    if (!parsed.ok) {
      setError(parsed.message)
      return
    }

    setPreview({
      fileName: file.name,
      cards: parsed.cards,
      baseSignature: recordSignature(record),
    })
  }

  const handleConfirm = async () => {
    if (savingRef.current) return
    if (record === null || preview === null || plan === null || !plan.ok) return
    savingRef.current = true
    // 固定本次确认使用的 plan 与统计；onSave 期间其它状态变化不影响本次统计。
    const approved = plan
    const approvedStrategy = strategy
    const total = preview.cards.length
    setError(null)
    setLastSummary(null)
    setImportStatus('saving')
    setImportMessage(null)
    setImportConflict(false)

    let result: PoiCardsSaveResult
    try {
      // 分组 / 计数来自同一份 approved plan；updatedAt 用确认时刻，
      // 避免预览停留很久后把计划生成时间当成导入时间写入。
      result = await onSave({ ...approved.record, updatedAt: nowRef.current() })
    } catch {
      savingRef.current = false
      if (!mountedRef.current) return
      setImportStatus('error')
      setImportMessage('写入资料卡库时发生异常；已有数据保持原样，请重试。')
      setImportConflict(false)
      return
    }
    savingRef.current = false
    if (!mountedRef.current) return
    if (!result.ok) {
      setImportStatus('error')
      setImportMessage(result.message)
      setImportConflict(result.reason === 'conflict')
      return
    }

    const overwritten = approvedStrategy === 'overwrite' ? approved.preview.existing.length : 0
    const skipped = approvedStrategy === 'skip' ? approved.preview.existing.length : 0
    setImportStatus('saved')
    setImportMessage(null)
    setImportConflict(false)
    setLastSummary(
      `已导入 ${total} 张卡（新增 ${approved.preview.added.length} / 覆盖 ${overwritten} / 跳过 ${skipped}）。`,
    )
    setPreview(null)
    setStrategy('skip')
    setError(null)
  }

  const handleCancel = () => {
    setPreview(null)
    setStrategy('skip')
    setError(null)
  }

  /** 冲突后重新读取最新库；清空旧预览，用户重新选文件即可用新 expectedRaw 导入。 */
  const handleReload = () => {
    readSeqRef.current += 1
    setReading(false)
    setPreview(null)
    setStrategy('skip')
    setError(null)
    setImportStatus('idle')
    setImportMessage(null)
    setImportConflict(false)
    setLastSummary(null)
    onReload()
  }

  const overwriteCount = previewGroups.existing.length

  return (
    <div className={PANEL} role="region" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3
            className="m-0 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]"
            id={headingId}
          >
            资料卡备份与恢复
          </h3>
          <p className="m-0 mt-1 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            导出为本地 JSON；导入先预览，确认后才写入资料卡库。
          </p>
        </div>
        <Button variant="outline" onClick={onClose}>
          收起
        </Button>
      </div>

      <section className={SECTION_BOX} aria-labelledby={exportHeadingId}>
        <h4 className="m-0 text-sm font-bold leading-relaxed text-[color:var(--color-secondary-foreground)]" id={exportHeadingId}>
          导出资料卡备份
        </h4>
        <p className="m-0 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
          {record === null
            ? '资料卡库当前不可用或未能读取，暂时不能导出。'
            : `当前资料卡库共 ${record.cards.length} 张卡。`}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleExport} disabled={record === null}>
            导出资料卡备份
          </Button>
        </div>
        <p className={HINT}>
          导出只读取资料卡库，不会写入或修改任何本地记录。文件只包含卡片数据，不含工作区、候选库或版本库内容，也不会访问网络。
        </p>
        <div aria-live="polite" aria-atomic="true">
          {exportNotice !== null ? <p className={NOTICE}>{exportNotice}</p> : null}
        </div>
      </section>

      <section className={SECTION_BOX} aria-labelledby={importHeadingId}>
        <h4 className="m-0 text-sm font-bold leading-relaxed text-[color:var(--color-secondary-foreground)]" id={importHeadingId}>
          导入资料卡备份
        </h4>
        <p className="m-0 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
          选择 JSON 备份文件后先预览新增与已存在的卡片；只有点「确认导入」才会写入资料卡库。
        </p>
        <input
          ref={fileInputRef}
          id={fileId}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="选择资料卡备份文件"
          aria-describedby={fileHelpId}
          onChange={handleFileChange}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={record === null || reading || importStatus === 'saving'}
            aria-busy={reading || undefined}
          >
            {reading ? '正在读取…' : '选择备份文件'}
          </Button>
          {reading ? (
            <span className="text-sm text-muted-foreground" role="status">
              正在读取文件…
            </span>
          ) : null}
        </div>
        <p className={HINT} id={fileHelpId}>
          仅接受 .json 文件；原始文本上限 {MAX_POI_CARDS_BACKUP_BYTES} 字节。版本不是 1、结构不合法或卡片重复的文件会被拒绝，资料卡库保持原样。
          {record === null ? ' 当前资料卡库不可用或未能读取，导入已停用。' : ''}
        </p>

        <div aria-live="polite" aria-atomic="true">
          {error !== null ? (
            <p className={ERROR_NOTICE} role="alert">
              {error}
            </p>
          ) : null}
        </div>

        {preview !== null ? (
          <div className="grid min-w-0 gap-3 rounded-[10px] border border-border bg-card p-4" role="region" aria-label="导入预览">
            <p className="m-0 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]">
              文件《{preview.fileName}》：共 {preview.cards.length} 张；新增 {previewGroups.added.length} 张 / 已存在{' '}
              {previewGroups.existing.length} 张。
            </p>

            {recordChanged ? (
              <p className={WARN_NOTICE}>
                资料卡库已更新，请核对下方的新增 / 已存在数量与覆盖提示后再确认。
              </p>
            ) : null}

            <div className="grid gap-2 min-[520px]:grid-cols-2">
              <div>
                <p className="m-0 text-xs font-semibold text-muted-foreground">新增</p>
                {previewGroups.added.length === 0 ? (
                  <p className={HINT}>没有新增卡片。</p>
                ) : (
                  <ul className={GROUP_LIST}>
                    {previewGroups.added.map((card) => (
                      <li className={GROUP_NAME} key={card.id}>
                        {card.name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="m-0 text-xs font-semibold text-muted-foreground">已存在</p>
                {previewGroups.existing.length === 0 ? (
                  <p className={HINT}>没有已存在的卡片。</p>
                ) : (
                  <ul className={GROUP_LIST}>
                    {previewGroups.existing.map((card) => (
                      <li className={GROUP_NAME} key={card.id}>
                        {card.name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
              <legend className="text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
                已存在资料卡的处理方式
              </legend>
              <label className="flex items-start gap-2 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
                <input
                  type="radio"
                  name={strategyName}
                  checked={strategy === 'skip'}
                  onChange={() => setStrategy('skip')}
                  className="mt-0.5 size-4 shrink-0 accent-[color:var(--color-accent-foreground)]"
                />
                <span>跳过已存在（保留本地版本）</span>
              </label>
              <label className="flex items-start gap-2 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)]">
                <input
                  type="radio"
                  name={strategyName}
                  checked={strategy === 'overwrite'}
                  onChange={() => setStrategy('overwrite')}
                  className="mt-0.5 size-4 shrink-0 accent-[color:var(--color-accent-foreground)]"
                />
                <span>覆盖已存在（用文件版本替换本地）</span>
              </label>
            </fieldset>

            {strategy === 'overwrite' ? (
              <p className={WARN_NOTICE}>
                覆盖将替换已存在的 {overwriteCount} 张卡；其它卡保持不变。确认前不会写入。
              </p>
            ) : null}

            {planError !== null ? (
              <p className={ERROR_NOTICE} role="alert">
                无法生成导入计划：{planError}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void handleConfirm()} disabled={!canConfirm}>
                确认导入
              </Button>
              <Button variant="outline" onClick={handleCancel} disabled={importStatus === 'saving'}>
                取消导入
              </Button>
            </div>
          </div>
        ) : null}

        <div aria-live="polite" aria-atomic="true">
          {importStatus === 'saving' ? (
            <p className={NOTICE} role="status">
              正在写入资料卡库…
            </p>
          ) : null}
          {importStatus === 'error' && importMessage !== null ? (
            <p className={ERROR_NOTICE} role="alert">
              导入失败：{importMessage} 资料卡库原字节未改动。
            </p>
          ) : null}
          {importConflict ? (
            <div className="grid gap-2">
              <p className={WARN_NOTICE}>
                资料卡库已被其它入口更新，本次导入没有写入。请重新载入资料卡库，再重新选择文件预览。
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={handleReload}>
                  重新载入资料卡库
                </Button>
              </div>
            </div>
          ) : null}
          {lastSummary !== null ? <p className={NOTICE} role="status">{lastSummary}</p> : null}
        </div>
      </section>
    </div>
  )
}

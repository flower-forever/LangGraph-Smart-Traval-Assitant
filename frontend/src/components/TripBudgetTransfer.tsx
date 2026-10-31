import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import type { Trip } from '../lib/api'
import {
  BUDGET_RECORD_SOURCE_TEXT,
  applyBudgetImport,
  createBudgetBackup,
  safeBudgetFilename,
  summarizeBudgetDraft,
  type BudgetTransferDraft,
  type BudgetTransferTripSelf,
} from '../lib/tripBudgetTransfer'
import { downloadBudgetBackup, readBudgetBackupFile } from '../lib/tripBudgetFile'
import {
  tripOwnerSnapshot,
  type BudgetSessionState,
  type BudgetTripContext,
} from '../lib/tripBudget'
import './tripBudgetTransfer.css'

export interface TripBudgetTransferProps {
  /** 当前页面正在显示的行程；子面板只读，不修改。 */
  trip: Trip
  /** 父级页面的行程版本号；与内容快照一起构成归属。 */
  revision: number
  /** 受控费用 session：App 层持有。 */
  session: BudgetSessionState
  /** session 变化回调；App 层 setState。 */
  onSessionChange: (session: BudgetSessionState) => void
}

type NoticeTone = 'ok' | 'warn' | 'error'

interface Notice {
  tone: NoticeTone
  text: string
}

/**
 * 导出预览：绑定生成时实际费用 owner 的全部已知字段（tripId / revision /
 * tripSnapshot / tripTitle）与费用输入快照。ownerKey 不用当前 Trip ctx——
 * 沿用 / 新建 / owner 变化都会让旧预览永久作废；绑定输入保证输入变化作废。
 */
interface ExportPreview {
  /** 生成时实际费用 owner 的完整指纹（草稿还没有 owner 时为 null） */
  ownerKey: string | null
  /** 生成时的费用输入快照（budgetRaw + rows 序列化） */
  inputSnapshot: string
  json: string
  bytes: number
  trip: BudgetTransferTripSelf | null
  filename: string
}

/**
 * 导入预览：文件解析结果 + 审阅信息。
 * ctxKey 绑定选择文件时的目标 ctx 指纹：目标变化（Trip / revision / 内容 /
 * 可验证性切换）后这份候选不能自动留成新目标的预览，永久作废不复活。
 */
interface ImportPreview {
  draft: BudgetTransferDraft
  fileTrip: BudgetTransferTripSelf | null
  bytes: number
  /** 选择时的目标 ctx 指纹（ctx 不可序列化时为 null，也是一种合法目标状态） */
  ctxKey: string | null
}

/**
 * 待确认的替换：绑定当前 Trip id + revision + 内容快照、候选内容指纹、
 * 确认时当前费用 owner 全指纹与费用输入快照。确认时任何一项变化都作废 pending。
 */
interface PendingImport {
  tripId: string
  revision: number
  tripSnapshot: string
  candidateDraft: BudgetTransferDraft
  /** 候选内容指纹（rows + budgetRaw 序列化）；候选被换文件替换后旧确认永久作废 */
  candidateSnapshot: string
  /** 开始替换时当前费用 owner 的完整指纹（null 也算一种状态） */
  currentOwnerKey: string | null
  /** 开始替换时当前 session 的费用输入快照（budgetRaw + rows 序列化） */
  currentInputSnapshot: string
}

/**
 * lastSeen 初始化哨兵：与「上一轮真实值就是 null（ctx / 快照不可序列化）」区分。
 * 否则 null→valid 的目标变化会被误当首次渲染初始化，跳过读取作废与候选清理。
 */
const CTX_UNSEEN = Symbol('tbt-ctx-unseen')

/** 费用输入快照：budgetRaw + rows 逐字段序列化（不含 owner / undo / result） */
function budgetInputSnapshot(session: BudgetSessionState): string {
  return JSON.stringify({
    budgetRaw: session.budgetRaw,
    rows: session.rows.map((row) => ({
      id: row.id,
      category: row.category,
      name: row.name,
      amountRaw: row.amountRaw,
    })),
  })
}

/** 当前费用 owner 的完整指纹：全部已知字段（tripId / revision / tripSnapshot / tripTitle）。
 *  与「当前 Trip ctx key」不同——沿用 / 新建改变 session.owner 时指纹跟着变。 */
function ownerFingerprintOf(session: BudgetSessionState): string | null {
  const owner = session.owner
  if (owner === null) return null
  return JSON.stringify({
    tripId: owner.tripId,
    revision: owner.revision,
    tripSnapshot: owner.tripSnapshot,
    tripTitle: owner.tripTitle,
  })
}

/** 当前 Trip ctx key：用于导入守卫（应用目标必须还是当前渲染的行程版本） */
function ctxKeyOf(ctx: BudgetTripContext): string | null {
  if (ctx.snapshot === null) return null
  return JSON.stringify({ tripId: ctx.tripId, revision: ctx.revision, snapshot: ctx.snapshot })
}

/** 候选内容指纹：与 budgetInputSnapshot 同一序列化（rows + budgetRaw） */
function candidateSnapshotOf(draft: BudgetTransferDraft): string {
  return JSON.stringify({
    budgetRaw: draft.budgetRaw,
    rows: draft.rows.map((row) => ({
      id: row.id,
      category: row.category,
      name: row.name,
      amountRaw: row.amountRaw,
    })),
  })
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '体积未知'
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function exportFailureText(result: { ok: false; reason: string; message: string }): string {
  if (result.reason === 'invalid_input') {
    return '当前费用草稿包含无法备份的异常结构，没有生成备份文件。草稿本身不受影响。'
  }
  return result.message
}

const CATEGORY_LABELS: Record<string, string> = {
  transport: '交通',
  stay: '住宿',
  food: '餐饮',
  ticket: '门票',
  other: '其他',
}

/**
 * 费用草稿文件备份与导入子面板（挂在费用面板内部，默认收起）。
 *
 * 边界：
 * - 展开 / 挂载 / 行程变化都不生成文件或 Blob URL；点「预览费用备份」才纯函数生成 JSON，
 *   点「下载费用备份」才把同一份已预览 JSON 交给浏览器，不在下载时重新生成。
 *   预览文件名与实际下载同名（同一个 safeBudgetFilename，来自导出自述 owner）。
 * - 导出预览绑定生成时实际费用 owner 全指纹 + 输入快照：owner 或输入任何变化立即
 *   永久作废（渲染期守卫 + effect 清理，A→B→A 不复活）；允许备份旧 owner 草稿救回输入，
 *   文件自述写原行程标题，不冒充当前行程。当前 Trip 不可验证时仍可备份已有 owner 草稿。
 * - 选择文件只本地解析预览，不改费用 session、不写存储、不下载；
 *   读取用「序号 + 选择时 ctx 指纹 + 卸载」三重守卫：ctx 指纹与渲染期同步更新的
 *   latestCtxKeyRef 比较（不等 effect），Trip / revision / 内容切换也让在途读取作废；
 *   旧读取晚回 / 上下文变化（含不可验证↔可验证）/ 失败一律不改新候选、不出提示、
 *   不动当前费用；导入候选记下选择时的目标 ctx 指纹，目标变化后渲染期隐藏 +
 *   effect 永久清理，不能自动留成新目标的预览，A→B→A 不复活；
 *   收起 / 放弃 / 卸载都使读取作废并清理状态。
 * - 应用走两步内联确认（无 alert / confirm 弹窗）：确认绑定当前 Trip id + revision +
 *   内容快照 + 候选内容指纹 + 当前费用 owner 全指纹与输入快照，渲染期同步守卫 +
 *   effect 永久清理，任何变化（含换文件）作废 pending，A→B→A 不复活。
 *   无法验证当前 Trip 快照时只能查看，不能应用。
 * - 取消 / 收起只丢预览，App 里的费用草稿不丢。
 * - 无自动文件读取 / 下载 / 存储；文本全部 React 转义，不渲染 HTML / Markdown。
 */
export default function TripBudgetTransfer({ trip, revision, session, onSessionChange }: TripBudgetTransferProps) {
  const [open, setOpen] = useState(false)
  const [exportPreview, setExportPreview] = useState<ExportPreview | null>(null)
  const [exportNotice, setExportNotice] = useState<Notice | null>(null)
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null)
  const [importNotice, setImportNotice] = useState<Notice | null>(null)
  const [reading, setReading] = useState(false)
  const [pending, setPending] = useState<PendingImport | null>(null)

  const headingId = useId()
  const fileId = useId()
  const fileHintId = useId()
  const exportTextId = useId()

  const readSeqRef = useRef(0)
  const aliveRef = useRef(true)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const openToggleRef = useRef<HTMLButtonElement | null>(null)
  const exportPreviewButtonRef = useRef<HTMLButtonElement | null>(null)
  const discardFocusRef = useRef<'collapse' | 'export' | null>(null)
  /** 上一轮渲染见到的 Trip 内容快照；变化即永久清理旧预览与读取结果。
   *  独立哨兵初始化：快照可为 null（不可序列化），null→valid 也是目标变化。 */
  const lastSeenTripSnapshotRef = useRef<string | null | typeof CTX_UNSEEN>(CTX_UNSEEN)
  /** 上一轮渲染见到的 Trip ctx 指纹；切换 Trip / revision / 内容即递增读取序号 */
  const lastSeenCtxKeyRef = useRef<string | null | typeof CTX_UNSEEN>(CTX_UNSEEN)
  /** 渲染期同步更新的最新 ctx 指纹：async 读取守卫比较最新上下文，不等 effect */
  const latestCtxKeyRef = useRef<string | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /** 收起 / 放弃预览后把焦点交回相应入口；不抢其他控件焦点 */
  useEffect(() => {
    if (discardFocusRef.current === 'collapse') {
      discardFocusRef.current = null
      openToggleRef.current?.focus()
    } else if (discardFocusRef.current === 'export') {
      discardFocusRef.current = null
      exportPreviewButtonRef.current?.focus()
    }
  })

  const snap = tripOwnerSnapshot(trip)
  const ctx: BudgetTripContext = {
    tripId: trip.id,
    revision,
    snapshot: snap.ok ? snap.value : null,
    tripTitle: trip.title,
  }
  const inputSnapshot = budgetInputSnapshot(session)
  const sessionOwnerKey = ownerFingerprintOf(session)
  const currentCtxKey = ctxKeyOf(ctx)
  const tripSnapshotValue = snap.ok ? snap.value : null
  // 渲染期即更新：任何重渲染之后，async 读取守卫比较到的都是最新目标，不依赖 effect 时序
  latestCtxKeyRef.current = currentCtxKey

  /**
   * 渲染期守卫（同步，先于任何 effect）：
   * - 导出预览：生成时实际费用 owner 全指纹或输入任一变化 → 立即不展示。
   * - pending：应用目标 ctx、候选内容、当前费用 owner 或输入任一变化 → 立即不展示。
   * state 里的旧数据靠下面的 effect 永久清掉（A→B→A 不复活）。
   */
  const exportStale =
    exportPreview !== null &&
    (exportPreview.ownerKey !== sessionOwnerKey ||
      exportPreview.inputSnapshot !== inputSnapshot)
  const liveExportPreview = exportStale ? null : exportPreview

  /**
   * 导入候选的目标守卫（渲染期同步）：候选记着选择时的目标 ctx 指纹，
   * 目标变化（Trip / revision / 内容 / 可验证性切换）后立即隐藏，
   * 不自动留成新目标的预览；state 里的旧候选靠下面的 effect 永久清掉。
   */
  const importPreviewStale = importPreview !== null && importPreview.ctxKey !== currentCtxKey
  const liveImportPreview = importPreviewStale ? null : importPreview

  const pendingStale =
    pending !== null &&
    (currentCtxKey === null ||
      pending.tripId !== ctx.tripId ||
      pending.revision !== ctx.revision ||
      pending.tripSnapshot !== tripSnapshotValue ||
      pending.currentOwnerKey !== sessionOwnerKey ||
      pending.currentInputSnapshot !== inputSnapshot)

  /**
   * 上下文一变就永久作废导出预览与 pending（A→B→A 不复活）；
   * Trip / revision / 内容 / 可验证性切换也让在途读取与导入候选全部作废
   * （候选绑定选择时的目标，不能自动留成新目标的预览）。
   */
  const tripContextChanged =
    lastSeenTripSnapshotRef.current !== CTX_UNSEEN &&
    lastSeenTripSnapshotRef.current !== tripSnapshotValue
  const ctxKeyChanged =
    lastSeenCtxKeyRef.current !== CTX_UNSEEN && lastSeenCtxKeyRef.current !== currentCtxKey
  useEffect(() => {
    if (ctxKeyChanged) {
      // Trip / revision / 内容切换：让还在途的旧读取全部作废
      readSeqRef.current += 1
      setReading(false)
    }
    if (exportStale || tripContextChanged) {
      setExportPreview(null)
      setExportNotice(null)
    }
    if (tripContextChanged || ctxKeyChanged) {
      setPending(null)
      // 候选绑定选择时的目标：目标变化后永久清理，不能自动留成新目标的预览
      setImportPreview(null)
    }
    lastSeenTripSnapshotRef.current = tripSnapshotValue
    lastSeenCtxKeyRef.current = currentCtxKey
  })

  /** 应用确认期间任何绑定变化：作废 pending（候选保留，可重新确认） */
  useEffect(() => {
    if (pending === null) return
    if (pendingStale) {
      setPending(null)
    }
  })

  const handleToggle = () => {
    const next = !open
    if (!next) {
      // 收起：丢弃预览、确认、导入提示与在途读取，收起再开不能复活旧确认
      discardFocusRef.current = 'collapse'
      readSeqRef.current += 1
      setReading(false)
      setExportPreview(null)
      setExportNotice(null)
      setImportPreview(null)
      setImportNotice(null)
      setPending(null)
    }
    setOpen(next)
  }

  const handleExportPreview = () => {
    setExportNotice(null)
    const owner = session.owner
    const result = createBudgetBackup({
      tripId: owner === null ? null : owner.tripId,
      tripTitle: owner === null ? null : owner.tripTitle,
      budgetRaw: session.budgetRaw,
      rows: session.rows,
    })
    if (!result.ok) {
      setExportPreview(null)
      setExportNotice({ tone: 'error', text: exportFailureText(result) })
      return
    }
    setExportPreview({
      // 绑定生成时实际费用 owner 的全指纹：owner 或输入变化都永久作废
      ownerKey: sessionOwnerKey,
      inputSnapshot,
      json: result.json,
      bytes: result.bytes,
      trip: result.trip,
      // 与实际下载同名：同一个 safeBudgetFilename，来自导出自述的 owner metadata
      filename: safeBudgetFilename(result.trip),
    })
  }

  const handleExportDownload = () => {
    if (!liveExportPreview) return
    setExportNotice(null)
    const outcome = downloadBudgetBackup(liveExportPreview.json, liveExportPreview.trip)
    if (outcome.ok) {
      setExportNotice({
        tone: 'ok',
        text:
          `已发起浏览器下载 ${outcome.filename}（${formatBytes(outcome.bytes)}）。` +
          '是否已存到磁盘以浏览器为准；文件不会上传，也不会修改费用草稿。',
      })
      return
    }
    // 失败保留合法预览，可直接重试
    setExportNotice({ tone: 'error', text: outcome.message })
  }

  const handleExportDiscard = () => {
    discardFocusRef.current = 'export'
    setExportPreview(null)
    setExportNotice(null)
  }

  /** 使在途读取与导入状态全部失效（放弃预览 / 收起 / 卸载前共用） */
  const invalidateImportState = () => {
    readSeqRef.current += 1
    setReading(false)
    setImportPreview(null)
    setImportNotice(null)
    setPending(null)
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files && input.files.length > 0 ? input.files[0] : null
    // 立刻清空，重新选同一个文件仍会触发 change
    input.value = ''
    if (!file) return

    const seq = readSeqRef.current + 1
    readSeqRef.current = seq
    // 选择时捕获目标 ctx 指纹（渲染期 ref 即最新值）。读取晚回时与渲染期更新的
    // latestCtxKeyRef 比较——目标变了（含不可验证↔可验证）就不落地，不等 effect
    const ctxKeyAtSelect = latestCtxKeyRef.current
    setReading(true)
    setImportNotice(null)
    // 选新文件先清旧候选与 pending
    setImportPreview(null)
    setPending(null)

    const result = await readBudgetBackupFile(file)

    // 卸载 / 更新文件晚回 / 读取期间切换 Trip 或 revision / ctx 变得不可验证或恢复可验证：
    // 直接忽略，不覆盖新结果、不改提示、不动当前费用
    if (
      !aliveRef.current ||
      seq !== readSeqRef.current ||
      ctxKeyAtSelect !== latestCtxKeyRef.current
    ) {
      return
    }
    setReading(false)
    if (result.ok) {
      setImportPreview({
        draft: result.draft,
        fileTrip: result.trip,
        bytes: result.bytes,
        ctxKey: ctxKeyAtSelect,
      })
      return
    }
    setImportNotice({ tone: 'error', text: result.message })
  }

  const handleImportDiscard = () => {
    invalidateImportState()
    fileInputRef.current?.focus()
  }

  const handleStartReplace = () => {
    if (!liveImportPreview) return
    setImportNotice(null)
    // 无法验证当前 Trip 快照：只能查看，不能应用（按钮同时禁用，这里再守一道）
    if (tripSnapshotValue === null) return
    setPending({
      tripId: ctx.tripId,
      revision: ctx.revision,
      tripSnapshot: tripSnapshotValue,
      candidateDraft: liveImportPreview.draft,
      candidateSnapshot: candidateSnapshotOf(liveImportPreview.draft),
      currentOwnerKey: sessionOwnerKey,
      currentInputSnapshot: inputSnapshot,
    })
  }

  const handleCancelReplace = () => {
    setPending(null)
    setImportNotice({ tone: 'warn', text: '已取消替换，当前费用没有变化。' })
  }

  const handleConfirmReplace = () => {
    if (!pending) return
    setImportNotice(null)
    // 最终确认时用最新 ctx / session 重新校验（目标 + 候选 + 当前费用 owner / 输入）
    if (
      pendingStale ||
      pending.tripId !== ctx.tripId ||
      pending.revision !== ctx.revision ||
      tripSnapshotValue === null ||
      pending.tripSnapshot !== tripSnapshotValue ||
      pending.currentOwnerKey !== sessionOwnerKey ||
      pending.currentInputSnapshot !== inputSnapshot ||
      pending.candidateSnapshot !== candidateSnapshotOf(pending.candidateDraft)
    ) {
      setPending(null)
      setImportNotice({
        tone: 'error',
        text: '确认期间行程或费用发生了变化，这次没有替换。请重新预览文件并再次确认。',
      })
      return
    }
    const applied = applyBudgetImport(session, ctx, pending.candidateDraft)
    if (!applied.ok) {
      setPending(null)
      setImportNotice({ tone: 'error', text: applied.message })
      return
    }
    onSessionChange(applied.session)
    setPending(null)
    setImportNotice({
      tone: 'ok',
      text: `已替换当前费用草稿：${pending.candidateDraft.rows.length} 项费用已导入。点「撤销上一步」可恢复替换前的费用。`,
    })
  }

  const unverifiableTrip = tripSnapshotValue === null
  const exportSummary = liveExportPreview
    ? summarizeBudgetDraft({ budgetRaw: session.budgetRaw, rows: session.rows })
    : null
  const importSummary = liveImportPreview ? summarizeBudgetDraft(liveImportPreview.draft) : null

  return (
    <div className="tbt" role="region" aria-labelledby={headingId} data-testid="budget-transfer">
      <h4 className="tbt-heading" id={headingId}>费用文件备份与导入</h4>
      <button
        type="button"
        ref={openToggleRef}
        className="tbt-toggle"
        aria-expanded={open}
        onClick={handleToggle}
      >
        {open ? '收起费用文件备份' : '展开费用文件备份'}
      </button>

      {open && (
        <div className="tbt-body">
          <p className="tbt-lead">
            费用草稿只在本页内存里：刷新页面会丢失。可以先把草稿下载成一份费用备份文件，
            之后再用「选择文件」导入并确认替换来恢复。这与行程 JSON 备份是两个独立文件，互不通用。
          </p>

          {/* ── 导出 ── */}
          <section className="tbt-section" aria-label="导出费用备份">
            <h5 className="tbt-subheading">导出费用备份</h5>
            <div className="tbt-actions">
              <button
                type="button"
                ref={exportPreviewButtonRef}
                className="tbt-btn"
                onClick={handleExportPreview}
              >
                预览费用备份
              </button>
            </div>
            <p className="tbt-hint">
              点「预览」才在页面里生成只读预览；下载要等预览之后单独点击。生成不联网、不写存储、不自动下载。
            </p>

            {liveExportPreview && exportSummary && exportSummary.ok && (
              <div className="tbt-preview" data-testid="budget-export-preview">
                <h6 className="tbt-preview-title" id={exportTextId}>
                  预览：{liveExportPreview.filename}
                </h6>
                <p className="tbt-meta">
                  约 {formatBytes(liveExportPreview.bytes)}（UTF-8 字节） · 费用 {exportSummary.rowCount} 项
                  {exportSummary.knownTotalText !== null
                    ? ` · 已填合法金额合计 ${exportSummary.knownTotalText} 元`
                    : ' · 没有可合计的合法金额'}
                </p>
                {liveExportPreview.trip !== null ? (
                  <p className="tbt-meta" data-testid="budget-export-owner">
                    备份自述的原行程：{liveExportPreview.trip.title === '' ? '未命名' : liveExportPreview.trip.title}
                    （这是导出时的自述记录，不代表它属于当前行程版本）
                  </p>
                ) : (
                  <p className="tbt-meta" data-testid="budget-export-owner">
                    这份草稿还没有绑定行程版本，备份里不记录行程归属。
                  </p>
                )}
                {exportSummary.issueCount > 0 && (
                  <p className="tbt-warn">
                    其中 {exportSummary.issueCount} 项金额无效、{exportSummary.emptyCount} 项未填写：
                    都按原字符串保留在文件里，不会补 0 或丢数据。
                  </p>
                )}
                {/* 只读纯文本预览：textarea 不解析任何 HTML / JSON 结构 */}
                <textarea
                  className="tbt-text"
                  aria-labelledby={exportTextId}
                  readOnly
                  rows={8}
                  wrap="soft"
                  value={liveExportPreview.json}
                />
                <div className="tbt-actions">
                  <button type="button" className="tbt-btn tbt-btn-primary" onClick={handleExportDownload}>
                    下载费用备份 (.budget.json)
                  </button>
                  <button type="button" className="tbt-btn" onClick={handleExportDiscard}>
                    放弃导出预览
                  </button>
                </div>
              </div>
            )}
          </section>

          <div className="tbt-live" aria-live="polite" aria-atomic="true">
            {exportNotice && (
              <p className="tbt-notice" data-tone={exportNotice.tone} data-testid="budget-export-notice">
                {exportNotice.text}
              </p>
            )}
          </div>

          {/* ── 导入 ── */}
          <section className="tbt-section" aria-label="从费用备份文件导入">
            <h5 className="tbt-subheading">从费用备份文件导入</h5>
            <div className="tbt-file">
              <label className="tbt-label" htmlFor={fileId}>选择费用备份文件（.budget.json）</label>
              <input
                id={fileId}
                ref={fileInputRef}
                className="tbt-input"
                type="file"
                accept=".json,application/json"
                onChange={handleFileChange}
                aria-describedby={fileHintId}
                aria-busy={reading || undefined}
              />
              <p className="tbt-hint" id={fileHintId}>
                选择后先在页面里预览，只有你点「确认替换费用」才会替换当前费用草稿；
                无效或超出 256 KB 上限的文件会被直接拒绝。读取失败后可以重新选同一个文件再试。
              </p>
            </div>

            {reading && <p className="tbt-status" role="status">正在读取文件…</p>}

            {liveImportPreview && importSummary && importSummary.ok && (
              <div className="tbt-preview" data-testid="budget-import-preview">
                <h6 className="tbt-preview-title">导入预览</h6>
                <p className="tbt-meta">
                  文件约 {formatBytes(liveImportPreview.bytes)} · 费用 {importSummary.rowCount} 项
                  {importSummary.knownTotalText !== null
                    ? ` · 已填合法金额合计 ${importSummary.knownTotalText} 元`
                    : ' · 没有可合计的合法金额'}
                </p>
                {liveImportPreview.fileTrip !== null ? (
                  <p className="tbt-meta" data-testid="budget-import-file-trip">
                    文件自述的行程：{liveImportPreview.fileTrip.title === '' ? '未命名' : liveImportPreview.fileTrip.title}
                    （只是文件里的记录，不能证明它真的来自这份行程）
                  </p>
                ) : (
                  <p className="tbt-meta" data-testid="budget-import-file-trip">
                    文件里没有记录行程归属。
                  </p>
                )}
                <p className="tbt-meta" data-testid="budget-import-target">
                  应用目标：当前行程「{trip.title}」。导入只替换费用草稿，不恢复行程本身。
                </p>
                {liveImportPreview.draft.rows.length === 0 && liveImportPreview.draft.budgetRaw === '' ? (
                  <p className="tbt-warn" data-testid="budget-import-empty">
                    这份备份里没有费用项，也没有填总预算。确认替换会把当前费用清空。
                  </p>
                ) : (
                  <>
                    {importSummary.emptyCount > 0 && (
                      <p className="tbt-warn">
                        {importSummary.emptyCount} 项金额未填写：按原样保留，不会按 0 计入合计。
                      </p>
                    )}
                    {importSummary.issueCount > 0 && (
                      <p className="tbt-warn">
                        {importSummary.issueCount} 项金额无效：原字符串保留在草稿里，计算时不计入合计。
                      </p>
                    )}
                  </>
                )}
                <ul className="tbt-rows" data-testid="budget-import-rows">
                  {liveImportPreview.draft.rows.map((row) => (
                    <li key={row.id} className="tbt-row-line">
                      {row.name.trim() === '' ? '未命名' : row.name}（{CATEGORY_LABELS[row.category] ?? '其他'}）
                      ：{row.amountRaw.trim() === '' ? '（未填）' : row.amountRaw} 元
                    </li>
                  ))}
                </ul>

                {pending ? (
                  <div className="tbt-confirm">
                    <p className="tbt-confirm-text" role="alert" data-testid="budget-import-confirm-text">
                      当前费用有 {session.rows.length} 项
                      {session.budgetRaw !== '' ? `，总预算 ${session.budgetRaw} 元` : '，总预算未填'}。
                      确认后这份文件的费用（{pending.candidateDraft.rows.length} 项）会替换当前费用草稿，
                      替换后可用「撤销上一步」恢复一次。
                    </p>
                    <div className="tbt-actions" role="group" aria-label="替换当前费用确认">
                      <button type="button" className="tbt-btn tbt-btn-primary" onClick={handleConfirmReplace}>
                        确认替换费用
                      </button>
                      <button type="button" className="tbt-btn" onClick={handleCancelReplace}>
                        取消替换
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="tbt-actions">
                    <button
                      type="button"
                      className="tbt-btn"
                      onClick={handleStartReplace}
                      disabled={unverifiableTrip}
                    >
                      替换当前费用草稿
                    </button>
                  </div>
                )}
                {unverifiableTrip && (
                  <p className="tbt-warn" data-testid="budget-import-locked">
                    当前行程内容无法确认归属：可以查看这份文件，不能应用到当前费用。
                  </p>
                )}
                <div className="tbt-actions">
                  <button type="button" className="tbt-btn" onClick={handleImportDiscard}>
                    放弃导入预览
                  </button>
                </div>
              </div>
            )}
          </section>

          <div className="tbt-live" aria-live="polite" aria-atomic="true">
            {importNotice && (
              <p className="tbt-notice" data-tone={importNotice.tone} data-testid="budget-import-notice">
                {importNotice.text}
              </p>
            )}
          </div>

          <p className="tbt-hint">{BUDGET_RECORD_SOURCE_TEXT}</p>
        </div>
      )}
    </div>
  )
}

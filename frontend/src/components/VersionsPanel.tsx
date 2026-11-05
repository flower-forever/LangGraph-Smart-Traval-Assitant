/**
 * F4 · 行程版本与方案对比面板（受控可集成，尚未接入 App）。
 *
 * 边界：
 * - 版本库数据由父级通过 props 提供；面板不读 localStorage、不写存储、不发请求。
 * - 保存 / 采用 / 撤销 / 导入都只通过显式 callback 交给父级；父级负责
 *   `commitWorkspaceTransition`、统一存储 owner 与真实 revision / epoch 推进。
 * - 采用必须先「预览」再「确认」；预览只生成 proposal，不调用 apply。
 * - 空预算 / 未知费用 / 0 元 / 未知时间距离都分开显示，不补 0、不伪造总价。
 * - 版本库备份 / 导入只预览版本库自身；不声称跨工作区 / 候选库原子恢复。
 */
import { useEffect, useId, useMemo, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'

import type { VersionsRecordV1, WorkspaceRecordV1 } from '../lib/workspaceTypes'
import {
  MAX_VERSION_NAME_LENGTH,
  VERSION_LIMITS,
  buildVersionsBackupPreview,
  diffVersions,
  planVersionAdopt,
  previewVersionsImport,
  summarizeBudgetSnapshot,
  type VersionAdoptProposalV1,
  type VersionCostSummaryV1,
  type VersionDiffV1,
  type VersionMeasureSummaryV1,
  type VersionSaveRequestV1,
  type VersionStopRefV1,
  type VersionsBackupPreviewV1,
  type VersionsImportPreviewV1,
  type VersionsLibraryStatusV1,
  type VersionUndoProposalV1,
} from '../lib/versionSnapshots'
import { formatDateTime } from '../lib/format'
import './VersionsPanel.css'

export interface VersionsPanelProps {
  /** 当前工作区记录；null = 还没有可保存的行程。面板只读。 */
  current: WorkspaceRecordV1 | null
  /** 版本库记录；null = 尚未加载 / 空库。 */
  versions: VersionsRecordV1 | null
  /** 组件级单调 epoch；父级在采用 / 撤销后推进到 proposal.nextEpoch。 */
  epoch: number
  /** 版本库读取状态；缺省按是否已有记录推断。 */
  libraryStatus?: VersionsLibraryStatusV1
  /** 父级持有的最近一次采用 undo 提案；没有则不显示撤销。 */
  undoProposal?: VersionUndoProposalV1 | null
  busy?: boolean
  /** 显式保存请求；父级生成 id / 时间并写版本库。 */
  onSaveVersion: (request: VersionSaveRequestV1) => void
  /** 显式确认采用；只有点「确认采用此版本」后才会调用。 */
  onAdoptVersion: (proposal: VersionAdoptProposalV1) => void
  /** 显式撤销最近一次采用；父级整体 transition 并推进 revision / epoch。 */
  onUndoAdopt: (proposal: VersionUndoProposalV1) => void
  /** 确认导入后交给父级；缺省时不显示确认按钮。 */
  onImportVersions?: (preview: VersionsImportPreviewV1) => void
  /** 下载由父级接入；面板不直接写文件。 */
  onDownloadBackup?: (preview: VersionsBackupPreviewV1) => void
  onClose?: () => void
  /** 测试 / 上层可注入时钟；只用于备份预览的 exportedAt。 */
  now?: () => number
}

const STATUS_TEXT: Record<VersionsLibraryStatusV1, string> = {
  ok: '',
  empty: '版本库还是空的；保存第一个版本后会出现在这里。',
  unavailable: '当前浏览器无法访问本地存储；不会假装已保存。',
  corrupt: '版本库原始数据无法读取；保留原字节，普通写入已拒绝。',
  anomaly: '版本库里有无效条目；保留原始字节，普通写入已拒绝。',
  unknown_version: '版本库版本无法识别；保留原样，未覆盖。',
}

function isWriteBlocked(status: VersionsLibraryStatusV1): boolean {
  return (
    status === 'unavailable' ||
    status === 'corrupt' ||
    status === 'anomaly' ||
    status === 'unknown_version'
  )
}

function formatMeasureSummary(summary: VersionMeasureSummaryV1, unit: string): string {
  if (summary.knownTotal === null) {
    return summary.unknownCount > 0
      ? `没有已知数值；另有 ${summary.unknownCount} 项未知`
      : '没有可比较的数据'
  }
  const known = `已知合计 ${summary.knownTotal} ${unit}`
  if (summary.unknownCount > 0) return `${known}；另有 ${summary.unknownCount} 项未知`
  return `${known}（全部已知）`
}

function formatCostSummary(summary: VersionCostSummaryV1): string {
  if (summary.state === 'missing') return '该版本没有预算数据（未知，不套用当前预算）'
  if (summary.knownTotalCents === null) {
    if (summary.unknownCount === 0) {
      return '预算快照存在，但没有费用项；0 元只在用户明确填写时才算已知'
    }
    return `没有已填写的合法金额；另有 ${summary.unknownCount} 项未知`
  }
  const known = `已知合计 ${summary.knownTotalText} 元`
  if (summary.totalText !== null) return `${known}（全部已知，合计 ${summary.totalText} 元）`
  return `${known}；另有 ${summary.unknownCount} 项未知，不显示总价`
}

function stopRefText(ref: VersionStopRefV1): string {
  const duration =
    ref.durationMinutes === null ? '停留未知' : `停留 ${ref.durationMinutes} 分钟`
  return `第 ${ref.day} 天 · ${ref.name}${ref.time === '' ? '' : ` · ${ref.time}`} · ${duration}`
}

function constraintText(item: { id: string; kind: string; title: string }): string {
  return `${item.title}（${item.kind}，id: ${item.id}）`
}

function costChangeText(diff: VersionDiffV1['cost']): string {
  if (diff.totalDeltaText !== null) return `总价变化 ${diff.totalDeltaText} 元`
  if (diff.knownDeltaText !== null) {
    return `已知合计变化 ${diff.knownDeltaText} 元；存在未知项或预算缺失，不显示总价变化`
  }
  return '无法比较总价：存在未知项或预算缺失；不会用 0 补未知'
}

function DiffView({ diff }: { diff: VersionDiffV1 }) {
  const added = diff.stops.added
  const removed = diff.stops.removed
  const moved = diff.stops.moved
  const changed = diff.stops.changed
  const constraintsAdded = diff.constraints.added
  const constraintsRemoved = diff.constraints.removed
  const constraintsChanged = diff.constraints.changed

  return (
    <div className="vrs-diff">
      <p className="vrs-diff-summary">
        站点：新增 {added.length} · 删除 {removed.length} · 跨日移动 {moved.length} · 同日变化{' '}
        {changed.length} · 未变化 {diff.stops.unchangedCount}
      </p>
      <p className="vrs-diff-summary">
        预约：新增 {constraintsAdded.length} · 删除 {constraintsRemoved.length} · 变化{' '}
        {constraintsChanged.length} · 未变化 {diff.constraints.unchangedCount}
      </p>

      <dl className="vrs-facts">
        <div>
          <dt>用时 · {diff.before.name}</dt>
          <dd>{formatMeasureSummary(diff.time.before, '分钟')}</dd>
        </div>
        <div>
          <dt>用时 · {diff.after.name}</dt>
          <dd>{formatMeasureSummary(diff.time.after, '分钟')}</dd>
        </div>
        <div>
          <dt>距离 · {diff.before.name}</dt>
          <dd>{formatMeasureSummary(diff.distance.before, '米')}</dd>
        </div>
        <div>
          <dt>距离 · {diff.after.name}</dt>
          <dd>{formatMeasureSummary(diff.distance.after, '米')}</dd>
        </div>
        <div>
          <dt>费用 · {diff.before.name}</dt>
          <dd>{formatCostSummary(diff.cost.before)}</dd>
        </div>
        <div>
          <dt>费用 · {diff.after.name}</dt>
          <dd>{formatCostSummary(diff.cost.after)}</dd>
        </div>
      </dl>
      <p className="vrs-diff-summary">{costChangeText(diff.cost)}</p>

      <details className="vrs-details" open>
        <summary>站点与预约明细</summary>
        {added.length === 0 && removed.length === 0 && moved.length === 0 && changed.length === 0 ? (
          <p className="vrs-muted">没有站点差异。</p>
        ) : (
          <ul className="vrs-diff-list">
            {added.map((ref) => (
              <li key={`added-${ref.id}-${ref.day}`}>新增：{stopRefText(ref)}</li>
            ))}
            {removed.map((ref) => (
              <li key={`removed-${ref.id}-${ref.day}`}>删除：{stopRefText(ref)}</li>
            ))}
            {moved.map((move) => (
              <li key={`moved-${move.id}-${move.from.day}-${move.to.day}`}>
                跨日移动：{move.name} 从第 {move.from.day} 天到第 {move.to.day} 天
                （id: {move.id}）
              </li>
            ))}
            {changed.map((change) => (
              <li key={`changed-${change.id}-${change.day}`}>
                同日变化：{change.name}（第 {change.day} 天）
              </li>
            ))}
          </ul>
        )}

        {constraintsAdded.length === 0 &&
        constraintsRemoved.length === 0 &&
        constraintsChanged.length === 0 ? (
          <p className="vrs-muted">没有预约差异。</p>
        ) : (
          <ul className="vrs-diff-list">
            {constraintsAdded.map((item) => (
              <li key={`constraint-added-${item.id}`}>预约新增：{constraintText(item)}</li>
            ))}
            {constraintsRemoved.map((item) => (
              <li key={`constraint-removed-${item.id}`}>预约删除：{constraintText(item)}</li>
            ))}
            {constraintsChanged.map((change) => (
              <li key={`constraint-changed-${change.id}`}>
                预约变化：{constraintText(change.after)}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  )
}

export default function VersionsPanel({
  current,
  versions,
  epoch,
  libraryStatus,
  undoProposal,
  busy = false,
  onSaveVersion,
  onAdoptVersion,
  onUndoAdopt,
  onImportVersions,
  onDownloadBackup,
  onClose,
  now = Date.now,
}: VersionsPanelProps) {
  const headingId = useId()
  const liveId = useId()
  const nameId = useId()
  const nameHelpId = useId()
  const saveHeadingId = useId()
  const listHeadingId = useId()
  const previewHeadingId = useId()
  const diffHeadingId = useId()
  const diffAIdInput = useId()
  const diffBIdInput = useId()
  const backupHeadingId = useId()
  const fileId = useId()

  const [name, setName] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pendingAdopt, setPendingAdopt] = useState<VersionAdoptProposalV1 | null>(null)
  const [diffAId, setDiffAId] = useState('')
  const [diffBId, setDiffBId] = useState('')
  const [backupPreview, setBackupPreview] = useState<VersionsBackupPreviewV1 | null>(null)
  const [importPreview, setImportPreview] = useState<VersionsImportPreviewV1 | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileBusy, setFileBusy] = useState(false)

  const items = versions?.items ?? []
  const status = libraryStatus ?? (versions === null ? 'empty' : 'ok')
  const blocked = isWriteBlocked(status)
  const versionIdsKey = JSON.stringify(items.map((item) => item.id))
  const currentKey =
    current === null
      ? 'none'
      : `${current.ownerId}\u0000${current.workspaceId}\u0000${current.tripId}\u0000${current.workspaceRevision}\u0000${current.updatedAt}`
  const currentVersionLabel = current === null ? '未打开工作区' : `revision ${current.workspaceRevision}`

  useEffect(() => {
    setPendingAdopt(null)
    setPreviewError(null)
  }, [currentKey, epoch])

  useEffect(() => {
    const ids = JSON.parse(versionIdsKey) as string[]
    setDiffAId((previous) => (previous !== '' && ids.includes(previous) ? previous : ids[0] ?? ''))
    setDiffBId((previous) =>
      previous !== '' && ids.includes(previous) ? previous : ids[1] ?? ids[0] ?? '',
    )
  }, [versionIdsKey])

  const diffState = useMemo(() => {
    if (diffAId === '' || diffBId === '') return { diff: null, error: null }
    const before = items.find((item) => item.id === diffAId)
    const after = items.find((item) => item.id === diffBId)
    if (before === undefined || after === undefined) {
      return { diff: null, error: '选中的版本已不在版本库里，请重新选择。' }
    }
    const result = diffVersions(before, after)
    return result.ok
      ? { diff: result.value, error: null }
      : { diff: null, error: result.message }
  }, [diffAId, diffBId, items])

  function handleSave(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (busy) return
    if (current === null) {
      setSaveError('当前没有打开的工作区记录，不能保存版本。')
      return
    }
    if (blocked) {
      setSaveError('版本库当前不可写；请先处理损坏 / 未知版本，原数据保持不变。')
      return
    }
    const trimmed = name.trim()
    if (trimmed === '') {
      setSaveError('请先给版本起一个名字。')
      return
    }
    if (trimmed.length > MAX_VERSION_NAME_LENGTH) {
      setSaveError(`版本名最多 ${MAX_VERSION_NAME_LENGTH} 个字符。`)
      return
    }
    setSaveError(null)
    onSaveVersion({ name: trimmed })
  }

  function handlePreviewAdopt(versionId: string): void {
    if (busy || blocked) return
    if (current === null) {
      setPreviewError('当前没有打开的工作区记录，不能采用版本。')
      return
    }
    const version = items.find((item) => item.id === versionId)
    if (version === undefined) {
      setPreviewError('该版本已不在版本库里，请重新选择。')
      return
    }
    const result = planVersionAdopt(current, version, { epoch })
    if (!result.ok) {
      setPendingAdopt(null)
      setPreviewError(result.message)
      return
    }
    setPreviewError(null)
    setPendingAdopt(result.value)
  }

  function handleConfirmAdopt(): void {
    if (busy || pendingAdopt === null) return
    const proposal = pendingAdopt
    setPendingAdopt(null)
    onAdoptVersion(proposal)
  }

  function handleUndo(): void {
    if (busy || undoProposal === null || undoProposal === undefined) return
    onUndoAdopt(undoProposal)
  }

  function handleExportPreview(): void {
    if (versions === null) {
      setFileError('版本库为空，没有可备份的内容。')
      return
    }
    const result = buildVersionsBackupPreview(versions, now())
    if (!result.ok) {
      setBackupPreview(null)
      setFileError(result.message)
      return
    }
    setFileError(null)
    setBackupPreview(result.value)
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    if (blocked) return
    const input = event.currentTarget
    const file = input.files?.[0]
    if (file === undefined) return
    setFileBusy(true)
    setFileError(null)
    setImportPreview(null)
    try {
      const text = await file.text()
      const result = previewVersionsImport(text, file.size)
      if (!result.ok) {
        setFileError(result.message)
      } else {
        setImportPreview(result.value)
      }
    } catch {
      setFileError('读取备份文件失败；原版本库不变，未导入。')
    } finally {
      setFileBusy(false)
      input.value = ''
    }
  }

  function handleConfirmImport(): void {
    if (busy || blocked || importPreview === null || onImportVersions === undefined) return
    const preview = importPreview
    setImportPreview(null)
    onImportVersions(preview)
  }

  const previewBudget =
    pendingAdopt === null
      ? null
      : summarizeBudgetSnapshot(pendingAdopt.target.content.budget)
  const canSave = current !== null && !blocked && !busy

  return (
    <section className="vrs" role="region" aria-label="行程版本与方案对比" aria-labelledby={headingId}>
      <header className="vrs-head">
        <div className="vrs-head-main">
          <p className="vrs-eyebrow">版本库</p>
          <h2 className="vrs-title" id={headingId}>
            行程版本与方案对比
          </h2>
          <p className="vrs-note">
            显式命名的不可变快照：保存当前 Trip、sidecar 与预算；后续编辑不会串改旧版本。
            面板不自动分叉、不自动驱逐旧版本。
          </p>
        </div>
        {onClose !== undefined ? (
          <button type="button" className="vrs-btn" onClick={onClose}>
            收起版本面板
          </button>
        ) : null}
      </header>

      <p className="vrs-live" id={liveId} role="status">
        {previewError ?? saveError ?? fileError ?? ''}
      </p>

      {blocked ? (
        <p className="vrs-alert" role="alert">
          {STATUS_TEXT[status]}
        </p>
      ) : null}
      {status === 'empty' ? <p className="vrs-muted">{STATUS_TEXT.empty}</p> : null}

      <section className="vrs-block" aria-labelledby={saveHeadingId}>
        <h3 className="vrs-block-title" id={saveHeadingId}>
          保存当前版本
        </h3>
        <p className="vrs-muted">
          当前：{currentVersionLabel}
          {current === null
            ? ''
            : current.budget === null
              ? ' · 预算：没有预算数据'
              : ' · 预算：含预算快照'}
        </p>
        <form className="vrs-save-form" onSubmit={handleSave}>
          <label className="vrs-field" htmlFor={nameId}>
            <span>版本名称</span>
            <input
              id={nameId}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setSaveError(null)
              }}
              aria-describedby={nameHelpId}
              disabled={busy || blocked}
              placeholder="例如：方案 A · 少走路"
              autoComplete="off"
            />
          </label>
          <button type="submit" className="vrs-btn vrs-btn-primary" disabled={!canSave}>
            保存为版本
          </button>
        </form>
        <p className="vrs-hint" id={nameHelpId}>
          保存只记录当前内容；不会调用 AI、不会自动分叉。同名版本会各自成为独立条目。
        </p>
        {current === null ? (
          <p className="vrs-alert">还没有打开的工作区记录，保存已禁用。</p>
        ) : null}
      </section>

      <section className="vrs-block" aria-labelledby={listHeadingId}>
        <h3 className="vrs-block-title" id={listHeadingId}>
          已保存版本（{items.length}/{VERSION_LIMITS.maxCount}）
        </h3>
        {items.length === 0 ? (
          <p className="vrs-empty">还没有保存的版本。</p>
        ) : (
          <ul className="vrs-list">
            {items.map((version) => (
              <li className="vrs-item" key={version.id}>
                <div className="vrs-item-main">
                  <h4 className="vrs-item-title">{version.name}</h4>
                  <p className="vrs-muted">
                    {formatDateTime(version.createdAt)} · 快照 revision{' '}
                    {version.workspaceRevision} ·{' '}
                    {version.budget === null ? '没有预算数据' : '含预算快照'}
                  </p>
                </div>
                <button
                  type="button"
                  className="vrs-btn"
                  onClick={() => handlePreviewAdopt(version.id)}
                  disabled={busy || current === null || blocked}
                  aria-label={`预览采用版本 ${version.name}（${formatDateTime(version.createdAt)}）`}
                >
                  预览采用
                </button>
              </li>
            ))}
          </ul>
        )}
        {items.length >= VERSION_LIMITS.maxCount ? (
          <p className="vrs-alert">
            已达到 {VERSION_LIMITS.maxCount} 个版本上限；新保存会明确失败，不会自动驱逐旧版本。
          </p>
        ) : null}
      </section>

      {pendingAdopt !== null ? (
        <section className="vrs-preview" aria-labelledby={previewHeadingId}>
          <h3 className="vrs-block-title" id={previewHeadingId}>
            采用预览：{pendingAdopt.versionName}
          </h3>
          <p>
            将一次整体恢复该版本的 Trip、sidecar 与预算；当前记录在确认前不会改变。
          </p>
          <ul className="vrs-plain-list">
            <li>
              revision：当前 {current?.workspaceRevision ?? '未知'} →{' '}
              {pendingAdopt.nextWorkspaceRevision}；快照内旧 revision{' '}
              {pendingAdopt.versionRevision} 不会恢复。
            </li>
            <li>
              epoch：{pendingAdopt.base.epoch} → {pendingAdopt.nextEpoch}；在途 AI 候选、路线刷新、
              预算 pending 与备份 pending 会全部失效。
            </li>
            <li>
              目标内容：{pendingAdopt.target.content.trip.days.length} 天，
              {pendingAdopt.target.content.sidecar.constraints.items.length} 条约束，
              {pendingAdopt.target.content.sidecar.checklist.items.length} 条清单。
            </li>
            <li>
              预算：
              {pendingAdopt.target.content.budget === null
                ? '该版本没有预算数据；采用后预算明确缺失，不会套用当前预算。'
                : previewBudget !== null && previewBudget.ok
                  ? formatCostSummary(previewBudget.value)
                  : '含预算快照；采用时会再次校验。'}
            </li>
          </ul>

          {pendingAdopt.needsReconfirmation.length === 0 ? (
            <p className="vrs-muted">当前工作区没有该版本之外的额外条目。</p>
          ) : (
            <>
              <p className="vrs-alert">
                以下当前工作区条目不在该版本中，采用后不会恢复；请先确认或取消预览：
              </p>
              <ul className="vrs-plain-list">
                {pendingAdopt.needsReconfirmation.map((item) => (
                  <li key={`${item.kind}-${item.id}`}>
                    {item.label}（{item.kind}）
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="vrs-actions">
            <button
              type="button"
              className="vrs-btn vrs-btn-primary"
              onClick={handleConfirmAdopt}
              disabled={busy}
            >
              确认采用此版本
            </button>
            <button
              type="button"
              className="vrs-btn"
              onClick={() => {
                setPendingAdopt(null)
                setPreviewError(null)
              }}
              disabled={busy}
            >
              取消预览
            </button>
          </div>
          <p className="vrs-hint">
            只有点「确认采用此版本」才会把完整 proposal 交给父级；面板不写存储。
          </p>
        </section>
      ) : null}

      {undoProposal !== null && undoProposal !== undefined ? (
        <section className="vrs-preview" aria-label="最近一次采用可撤销">
          <h3 className="vrs-block-title">最近一次采用可整体撤销</h3>
          <p>
            撤销会恢复采用前的 Trip、sidecar 与预算；revision 仍从当前{' '}
            {undoProposal.base.identity.workspaceRevision} →{' '}
            {undoProposal.nextWorkspaceRevision}，epoch → {undoProposal.nextEpoch}。
            不会回放旧 revision，也不会只撤销其中一段。
          </p>
          <div className="vrs-actions">
            <button
              type="button"
              className="vrs-btn vrs-btn-primary"
              onClick={handleUndo}
              disabled={busy}
            >
              撤销本次采用
            </button>
          </div>
        </section>
      ) : null}

      <section className="vrs-block" aria-labelledby={diffHeadingId}>
        <h3 className="vrs-block-title" id={diffHeadingId}>
          两个版本对比
        </h3>
        {items.length < 2 ? (
          <p className="vrs-muted">至少保存两个版本后才能对比。</p>
        ) : (
          <>
            <div className="vrs-selects">
              <label className="vrs-field" htmlFor={diffAIdInput}>
                <span>版本 A</span>
                <select
                  id={diffAIdInput}
                  value={diffAId}
                  onChange={(event) => setDiffAId(event.target.value)}
                >
                  {items.map((version) => (
                    <option key={`a-${version.id}`} value={version.id}>
                      {version.name} · {formatDateTime(version.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="vrs-field" htmlFor={diffBIdInput}>
                <span>版本 B</span>
                <select
                  id={diffBIdInput}
                  value={diffBId}
                  onChange={(event) => setDiffBId(event.target.value)}
                >
                  {items.map((version) => (
                    <option key={`b-${version.id}`} value={version.id}>
                      {version.name} · {formatDateTime(version.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {diffState.error !== null ? (
              <p className="vrs-alert" role="alert">
                {diffState.error}
              </p>
            ) : null}
            {diffState.diff !== null ? <DiffView diff={diffState.diff} /> : null}
          </>
        )}
      </section>

      <section className="vrs-block" aria-labelledby={backupHeadingId}>
        <h3 className="vrs-block-title" id={backupHeadingId}>
          版本库独立备份 / 导入
        </h3>
        <p className="vrs-muted">
          只处理版本库自身，不包含工作区或候选库；不做跨库原子恢复。导入只预览，确认后才交给
          父级显式保存。
        </p>
        <div className="vrs-actions">
          <button
            type="button"
            className="vrs-btn"
            onClick={handleExportPreview}
            disabled={busy || items.length === 0}
          >
            预览版本库备份
          </button>
          {backupPreview !== null && onDownloadBackup !== undefined ? (
            <button
              type="button"
              className="vrs-btn"
              onClick={() => onDownloadBackup(backupPreview)}
              disabled={busy}
            >
              下载备份文件
            </button>
          ) : null}
          <label className="vrs-file" htmlFor={fileId}>
            <span>选择版本库备份文件</span>
            <input
              id={fileId}
              type="file"
              accept="application/json,.json"
              onChange={handleFileChange}
              disabled={busy || fileBusy || blocked}
            />
          </label>
        </div>
        {fileBusy ? <p className="vrs-muted">正在读取文件…</p> : null}
        {fileError !== null ? (
          <p className="vrs-alert" role="alert">
            {fileError}
          </p>
        ) : null}

        {backupPreview !== null ? (
          <div className="vrs-small-preview">
            <p>
              备份预览：仅版本库 · {backupPreview.record.items.length} 个版本 ·{' '}
              {backupPreview.bytes} 字节（UTF-8）
            </p>
            <p className="vrs-hint">
              预览与下载使用同一份字节；面板不直接写文件，下载由父级 callback 接入。
            </p>
            <button
              type="button"
              className="vrs-btn"
              onClick={() => {
                setBackupPreview(null)
                setFileError(null)
              }}
              disabled={busy}
            >
              关闭备份预览
            </button>
          </div>
        ) : null}

        {importPreview !== null ? (
          <div className="vrs-small-preview">
            <p>
              导入预览：仅版本库 · {importPreview.record.items.length} 个版本 ·{' '}
              {importPreview.bytes} 字节（UTF-8）· 未写入
            </p>
            <div className="vrs-actions">
              <button
                type="button"
                className="vrs-btn vrs-btn-primary"
                onClick={handleConfirmImport}
                disabled={busy || blocked || onImportVersions === undefined}
              >
                确认导入版本库
              </button>
              <button
                type="button"
                className="vrs-btn"
                onClick={() => setImportPreview(null)}
                disabled={busy}
              >
                取消导入
              </button>
            </div>
            {onImportVersions === undefined ? (
              <p className="vrs-hint">父级尚未接入导入 callback；当前只保留预览。</p>
            ) : null}
          </div>
        ) : null}
      </section>
    </section>
  )
}

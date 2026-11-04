/**
 * 本机工作进度留存面板：opt-in 开关、待恢复概况、恢复 / 放弃 / 关闭 / 删除入口。
 *
 * 边界（与 SESSION_RESUME 设计一致）：
 * - 纯受控组件：所有状态与动作由 App 层传入，本组件不读 localStorage、不发请求；
 * - pending 概况只展示保存时快照的自述（标题/天数/草稿有无/费用条数/时间），
 *   不声称内容已向服务器核实；损坏 / 协议不符时恢复按钮禁用并保留原 raw 说明；
 * - 「放弃恢复并开始留存」必须内联确认后才替换副本，绝不用模糊「放弃」偷清数据；
 * - 「关闭保留」只停写并保留数据键；「删除本机恢复副本」独立内联确认，只删恢复数据，
 *   不触碰正式保存的行程。
 */
import { useId, useRef, useState } from 'react'
import type { SessionResumeLoad } from '../lib/sessionRestore'
import { formatDateTime } from '../lib/format'

export interface SessionResumeCardSummary {
  tripTitle: string
  dayCount: number
  hasDraft: boolean
  budgetRowCount: number
  savedAt: number | null
  /** 来源自述：来自文件 / 来源未知 / 应用内进度，各用固定文案 */
  sourceNote: string
}

interface SessionResumePanelProps {
  /** null = 功能整体不可用（无 window.localStorage 等），入口不渲染开关 */
  state:
    | { kind: 'off' }
    | { kind: 'idle' }
    | { kind: 'pending'; load: Extract<SessionResumeLoad, { status: 'pending' }> }
    | { kind: 'problem'; message: string; canRestore: boolean; rawPreserved: boolean }
  /** 开关当前是否启用（独立于 state：off 但数据键可能保留） */
  enabled: boolean
  /** off 时存储里是否还有恢复副本（决定是否显示删除入口） */
  hasStoredData: boolean
  /**
   * off（含关闭后 reload）下的显式检查结果：generation 每次检查推进，
   * 是删除确认身份的一部分——旧确认不能跨检查复用（防 ABA / 静默换 B）。
   * undefined 视为未检查（兼容未传入的旧调用方）；挂载/重载恒为 not_checked。
   */
  management?:
    | { generation: 0; kind: 'not_checked' }
    | { generation: number; kind: 'found'; raw: string }
    | { generation: number; kind: 'not_found' }
    | { generation: number; kind: 'error'; message: string }
  onEnable: () => void
  onDisable: () => void
  onRestore: () => void
  onDiscardAndStart: () => void
  /** off 下显式「检查本机恢复副本」：唯一允许读数据键的入口（点击时才读） */
  onCheckStoredData?: () => void
  /** 删除前引导：只有当前 raw 仍等于已冻结候选时才允许打开确认 */
  onPrepareDelete: () => { ok: true; raw: string | null } | { ok: false }
  /** 确认删除时把打开确认时冻结的 raw 交回 App 做 compare-then-remove */
  onDeleteData: (expectedRaw: string | null) => void
}

export default function SessionResumePanel({
  state,
  enabled,
  hasStoredData,
  management,
  onEnable,
  onDisable,
  onRestore,
  onDiscardAndStart,
  onCheckStoredData,
  onPrepareDelete,
  onDeleteData,
}: SessionResumePanelProps) {
  const [discardConfirmEpoch, setDiscardConfirmEpoch] = useState<number | null>(null)
  const [deleteConfirmEpoch, setDeleteConfirmEpoch] = useState<number | null>(null)
  const [deleteExpectedRaw, setDeleteExpectedRaw] = useState<string | null>(null)
  const discardConfirmRef = useRef<HTMLDivElement | null>(null)
  const deleteConfirmRef = useRef<HTMLDivElement | null>(null)
  const noteId = useId()

  const pending = state.kind === 'pending' ? state.load.record.session : null
  const summary: SessionResumeCardSummary | null = pending
    ? {
        tripTitle: pending.trip.title,
        dayCount: pending.trip.days.length,
        hasDraft: pending.draft !== null,
        budgetRowCount: pending.budget?.rows.length ?? 0,
        savedAt: state.kind === 'pending' ? state.load.record.savedAt : null,
        sourceNote:
          pending.ui.openedFromFile === true
            ? '这份进度当时的行程来自你选择的备份文件，页面没有向服务器核对过'
            : pending.ui.openedFromFile === null
              ? '这份进度没有记录来源标记，行程内容按未核实处理'
              : '这些内容来自上次本页面的留存快照，页面没有向服务器核对过',
      }
    : null

  /**
   * 确认态身份。状态种类、启用开关、pending 候选 raw 或 problem 文案任一变化都会推进
   * epoch；旧确认在同一渲染中立即失效，不等 effect（避免残留可点击窗口）。
   * 同一 pending 的稳定重渲染 key 不变，用户合法确认不会被误清。
   * off 检查的 generation/raw 也纳入身份：再次检查（即使同候选）或读到不同候选
   * 都推进 epoch，检查打开的旧确认绝不复用（防 ABA 与静默换 B）。
   */
  // 旧测试可能不传 management；未传时按未检查处理，不影响既有 pending/problem 身份
  const offManagement = management ?? { generation: 0, kind: 'not_checked' as const }
  const confirmContextKey = [
    state.kind,
    enabled ? '1' : '0',
    state.kind === 'pending' ? state.load.raw : '',
    state.kind === 'problem'
      ? `${state.message}|${state.canRestore ? '1' : '0'}|${state.rawPreserved ? '1' : '0'}`
      : '',
    offManagement.kind === 'found' && (state.kind === 'off' || state.kind === 'idle')
      ? `${offManagement.generation}\u0000found\u0000${offManagement.raw}`
      : '',
  ].join('\u0000')
  const confirmEpochRef = useRef(0)
  const lastContextRef = useRef(confirmContextKey)
  if (lastContextRef.current !== confirmContextKey) {
    lastContextRef.current = confirmContextKey
    confirmEpochRef.current += 1
  }
  const confirmEpoch = confirmEpochRef.current
  const discardConfirm = discardConfirmEpoch === confirmEpoch
  const deleteConfirm = deleteConfirmEpoch === confirmEpoch

  // 删除入口在功能启用（含 paused/problem）、「关闭但副本仍在」与「off 显式检查发现副本」时可用：
  // 损坏/冲突/关闭后想清掉副本，都必须有显式清除通道。
  // off 且尚未检查（not_checked）时不显示删除入口：默认零内容键读取，先检查才知道有没有副本
  const offCheckedFound = state.kind === 'off' && offManagement.kind === 'found'
  const canManageData = enabled || hasStoredData || state.kind === 'problem' || offCheckedFound

  return (
    <section className="session-resume" data-testid="session-resume-card" aria-label="本机工作进度留存">
      <div className="session-resume-head">
        <p className="field-label">在此浏览器保留工作进度</p>
        {!enabled && (
          <button type="button" className="btn" onClick={onEnable}>
            在此浏览器保留工作进度
          </button>
        )}
        {enabled && (
          <button type="button" className="btn btn-ghost" onClick={onDisable}>
            关闭保留（已留存的副本会保留）
          </button>
        )}
      </div>
      <p className="field-help" id={noteId}>
        启用后本页面会把当前行程、未应用的草稿修改和手工费用原字符串自动留存到本浏览器，
        下次打开时先给你看概况，由你决定是否恢复。只在本地保存，不联网、不同步设备，
        也不等于「保存行程」：正式保存仍需点「保存当前行程」。编辑器里未提交的表单输入、
        撤销历史和 AI 检查结论不会留存。
      </p>

      {state.kind === 'problem' && (
        <p className="field-error" role="alert">
          {state.message}
          {state.rawPreserved &&
            !state.canRestore &&
            ' 原始数据已原样保留；可用下方「删除本机恢复副本」清除后再重新开始。'}
        </p>
      )}

      {state.kind === 'off' && (
        <div className="session-resume-manage">
          <p className="field-help">
            关闭保留后，之前留存的副本仍会留在这台浏览器里。点「检查本机恢复副本」才会读取一次本地副本；
            检查不会开启留存，也不会恢复或改动当前页面内容。
          </p>
          <button type="button" className="btn btn-ghost" onClick={onCheckStoredData}>
            检查本机恢复副本
          </button>
          {offManagement.kind === 'found' && (
            <p className="field-help" role="status">
              检查到这台浏览器仍留有恢复副本（留存已关闭，不会自动恢复）。可用下方「删除本机恢复副本」独立清除。
            </p>
          )}
          {offManagement.kind === 'not_found' && (
            <p className="field-help" role="status">
              未找到本机恢复副本：这台浏览器当前没有留存的恢复数据。
            </p>
          )}
          {offManagement.kind === 'error' && (
            <p className="field-error" role="alert">
              {offManagement.message}
            </p>
          )}
        </div>
      )}

      {summary && state.kind === 'pending' && (
        <div className="session-resume-pending">
          <p>
            有上次的工作进度待恢复（保存于 {summary.savedAt === null ? '未知时间' : formatDateTime(summary.savedAt)}）：
            《{summary.tripTitle}》共 {summary.dayCount} 天
            {summary.hasDraft ? '，含未应用的草稿修改' : ''}
            {summary.budgetRowCount > 0 ? `，${summary.budgetRowCount} 条手工费用` : ''}。
            {summary.sourceNote}；点「恢复」才会替换当前页面。
          </p>
          <div className="session-resume-actions">
            <button type="button" className="btn btn-primary" onClick={onRestore}>
              恢复上次的工作进度
            </button>
            {!discardConfirm ? (
              <button type="button" className="btn" onClick={() => setDiscardConfirmEpoch(confirmEpoch)}>
                放弃恢复并开始留存当前进度
              </button>
            ) : (
              <div className="session-resume-confirm" ref={discardConfirmRef} role="group">
                <span>这会用当前页面内容替换上次留存并继续自动留存，上次的副本将被覆盖。确定？</span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDiscardConfirmEpoch(null)
                    onDiscardAndStart()
                  }}
                >
                  确认放弃恢复
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setDiscardConfirmEpoch(null)}>
                  取消
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {canManageData && (
        <div className="session-resume-manage">
          {!deleteConfirm ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                const prepared = onPrepareDelete()
                if (!prepared.ok) return
                setDeleteExpectedRaw(prepared.raw)
                setDeleteConfirmEpoch(confirmEpoch)
              }}
            >
              删除本机恢复副本
            </button>
          ) : (
            <div className="session-resume-confirm" ref={deleteConfirmRef} role="group">
              <span>只删除本机留存的恢复副本，不影响已保存的行程与备份文件。确定删除？</span>
              <button
                type="button"
                className="btn"
                data-variant="destructive"
                onClick={() => {
                  setDeleteConfirmEpoch(null)
                  onDeleteData(deleteExpectedRaw)
                }}
              >
                确认删除副本
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleteConfirmEpoch(null)}>
                取消
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

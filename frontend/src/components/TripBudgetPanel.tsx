/**
 * 费用估算面板（受控组件，App 层持有 session）。
 *
 * 边界：
 * - session（归属 / 明细 / 预算 / 结果 / 撤销）全部由父级通过 props 持有：
 *   面板卸载（关闭、临时打开地图 / AI / 编辑）不会丢草稿；挂载本身零副作用。
 * - 只有点「计算已填费用」才产生结果；任何输入、增删、清空、撤销、沿用、
 *   新建都把旧结果清掉（result 置 null），旧结论不挂新输入。
 * - 撤销覆盖全部费用操作（含字段编辑）一层；不越过行程版本。
 * - 行程内容快照每次渲染重算，不用对象引用做缓存；新增行 id 在当前
 *   session 内唯一，不依赖时间戳。
 * - 错误输入保留原字符串，给固定文案，不当 0 使用，不回显异常原文。
 * - 行程 / 版本 / 内容变化导致 owner 失配：输入只读保留，禁止编辑与计算，
 *   旧计算结果不渲染，须显式「沿用」或「新建」后重新计算；无法验证快照时
 *   整块锁定（fail closed）。
 * - 不发请求、不写存储、不下载、不动 Trip；名称 / 金额是手填输入，
 *   不是服务提供者报价；不声称已保存。
 * - 文本一律 React 文本节点渲染，不使用 dangerouslySetInnerHTML。
 */
import { useEffect, useId, useState } from 'react'
import type { Trip } from '../lib/api'
import {
  AMOUNT_LIMIT_TEXT,
  BUDGET_CATEGORIES,
  MAX_BUDGET_ITEMS,
  OWNER_MISMATCH_TEXT,
  OWNER_UNVERIFIABLE_TEXT,
  addBudgetRow,
  adoptBudget,
  budgetCategoryLabel,
  budgetSessionIsStale,
  clearBudget,
  computeBudgetSession,
  createBudgetForTrip,
  emptyBudgetSession,
  formatCents,
  removeBudgetRow,
  tripOwnerSnapshot,
  undoBudget,
  updateBudgetRow,
  updateBudgetTotal,
  type BudgetCategoryId,
  type BudgetSessionState,
  type BudgetTripContext,
} from '../lib/tripBudget'
import './tripBudgetPanel.css'

export interface TripBudgetPanelProps {
  /** 当前页面正在显示的行程；面板只读，不修改。 */
  trip: Trip
  /** 父级页面的行程版本号；与内容快照一起构成归属。 */
  revision: number
  /** 受控 session：App 层持有，关闭 / 重开面板不丢失。 */
  session: BudgetSessionState
  /** session 变化回调；App 层 setState。 */
  onSessionChange: (session: BudgetSessionState) => void
  /** 收起面板：只隐藏，不清草稿。 */
  onClose: () => void
}

/** 新增费用项 id 由面板生成；测试可用注入替换，默认走传入的 newId。 */
export interface TripBudgetPanelOptions {
  newId?: () => string
}

function memoryNotice(): string {
  return '费用草稿只在当前页面内存里：不随行程保存或导出，刷新页面会丢失。'
}

export default function TripBudgetPanel({
  trip,
  revision,
  session,
  onSessionChange,
  onClose,
}: TripBudgetPanelProps) {
  const headingId = useId()
  const liveId = useId()
  const nameIdPrefix = useId()
  const amountIdPrefix = useId()
  const budgetInputId = useId()
  const budgetHelpId = `${budgetInputId}-help`

  const [actionError, setActionError] = useState<string | null>(null)
  const [rowLimitReached, setRowLimitReached] = useState(false)

  /**
   * 行程内容快照：每次渲染重算，不用对象引用做缓存条件。
   * 同一个 Trip 对象被原地改内容（同引用不同内容）时也能立刻反映出来；
   * 序列化失败时 snapshot 为 null，判定为不可验证并整块锁定。
   */
  const snap = tripOwnerSnapshot(trip)
  const ctx: BudgetTripContext = {
    tripId: trip.id,
    revision,
    snapshot: snap.ok ? snap.value : null,
    tripTitle: trip.title,
  }
  const unverifiable = !snap.ok
  const stale = session.owner !== null && !unverifiable && budgetSessionIsStale(session, ctx)
  const locked = unverifiable || stale
  const noTripVersion = session.owner === null

  /** 行程变化 / 锁定时清掉面板内操作错误与行数上限提示，不让旧结论挂着新行程。 */
  useEffect(() => {
    if (locked) {
      setActionError(null)
      setRowLimitReached(false)
    }
  }, [locked])

  /**
   * 新增行 id：在当前 session 已有 id 之外取最小未用序号，不依赖时间戳唯一。
   * 关闭重开面板或固定时钟下也不会重复；undo 恢复旧行后若占用了序号，
   * 下一次新增会自动跳到下一个未用值（duplicate 检查仍由 addBudgetRow 兕底）。
   */
  function nextRowId(): string {
    const prefix = `budget-row-${trip.id.slice(0, 8)}-`
    for (let n = 1; ; n += 1) {
      const candidate = `${prefix}${n}`
      if (!session.rows.some((row) => row.id === candidate)) return candidate
    }
  }

  /** 所有改写 session 的操作都经这里：失败给固定文案，成功清操作错误。 */
  function run(op: () => ReturnType<typeof addBudgetRow>) {
    setActionError(null)
    const outcome = op()
    if (outcome.ok) {
      onSessionChange(outcome.session)
      setRowLimitReached(false)
    } else {
      if (outcome.reason === 'limit') setRowLimitReached(true)
      setActionError(outcome.message)
    }
  }

  function handleAddRow() {
    run(() => addBudgetRow(session, ctx, nextRowId()))
  }

  function handleRemoveRow(rowId: string) {
    run(() => removeBudgetRow(session, ctx, rowId))
  }

  function handleClear() {
    run(() => clearBudget(session, ctx))
  }

  function handleUndo() {
    run(() => undoBudget(session, ctx))
  }

  function handleAdopt() {
    run(() => adoptBudget(session, ctx))
  }

  function handleCreate() {
    run(() => createBudgetForTrip(session, ctx))
  }

  function handleCompute() {
    run(() => computeBudgetSession(session, ctx))
  }

  function handleFieldChange(rowId: string, patch: { name?: string; amountRaw?: string; category?: BudgetCategoryId }) {
    run(() => updateBudgetRow(session, ctx, rowId, patch))
  }

  function handleBudgetChange(raw: string) {
    run(() => updateBudgetTotal(session, ctx, raw))
  }

  /**
   * 计算结果只在「归属可验证且匹配当前行程」时展示：行程切换 / revision 推进 /
   * 内容变化后旧结果一律不渲染（标题已是新行程，不能挂旧合计）；
   * 显式沿用 / 新建已在 lib 层清空 result，须重新点计算。
   */
  const result = locked ? null : session.result

  function labelFor(field: 'name' | 'amount', index: number): string {
    return field === 'name' ? `${nameIdPrefix}-${index}` : `${amountIdPrefix}-${index}`
  }

  return (
    <section
      className="tbg"
      role="region"
      aria-labelledby={headingId}
      data-testid="trip-budget-panel"
      aria-busy={false}
    >
      <div className="tbg-head">
        <div className="tbg-head-main">
          <p className="tbg-eyebrow">行程级工具 · 不写行程</p>
          <h3 className="tbg-title" id={headingId}>
            费用估算（{trip.title}）
          </h3>
        </div>
        <button type="button" className="tbg-btn" onClick={onClose}>
          收起
        </button>
      </div>

      <p className="tbg-note">
        手动填写费用做估算：人民币 CNY 是这里的固定输入单位，金额按整项总费用填，
        不按人数或天数自动乘算，也不会去查询真实价格、库存或汇率。
        名称和金额都是你自己填的记录，不是任何服务提供者的报价。
      </p>
      <p className="tbg-memory-note" role="note">{memoryNotice()}</p>

      {locked && (
        <div className="tbg-stale-actions">
          <p className="tbg-owner-note" role="status" data-testid="budget-owner-note">
            {stale
              ? `${OWNER_MISMATCH_TEXT} 旧草稿属于${session.owner?.tripTitle ? `「${session.owner.tripTitle}」` : '旧行程'}，内容在下方只读保留。`
              : OWNER_UNVERIFIABLE_TEXT}
          </p>
          {stale && !unverifiable && (
            <>
              <button type="button" className="tbg-btn" onClick={handleAdopt}>
                沿用这份费用到当前行程
              </button>
              <button type="button" className="tbg-btn" onClick={handleCreate}>
                新建当前行程费用草稿
              </button>
            </>
          )}
        </div>
      )}

      {noTripVersion && !locked && (
        <p className="tbg-owner-note" role="status">
          还没有绑定行程版本：直接填写或新增后，会自动归属当前显示的这版行程。
        </p>
      )}

      <fieldset className="tbg-body" disabled={locked}>
        <legend className="visually-hidden">费用明细与预算</legend>

        <div className="tbg-budget">
          <label htmlFor={budgetInputId}>整趟行程总预算（元，可留空）</label>
          <input
            id={budgetInputId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={session.budgetRaw}
            onChange={(event) => handleBudgetChange(event.target.value)}
            aria-describedby={budgetHelpId}
            placeholder={`例如 5000 或 ${AMOUNT_LIMIT_TEXT}`}
          />
          <p id={budgetHelpId} className="tbg-hint">
            预算留空就不做预算比较；单项与预算最多 {AMOUNT_LIMIT_TEXT} 元、2 位小数。
          </p>
        </div>

        <div className="tbg-rows">
          {session.rows.length === 0 ? (
            <p className="tbg-empty" role="note">
              还没有费用明细。点「添加费用项」开始填写；留空的金额不会按 0 计入。
            </p>
          ) : (
            session.rows.map((row, index) => {
            return (
                <div className="tbg-row" key={row.id} data-testid="budget-row" data-rowid={row.id}>
                  <div className="tbg-row-field tbg-row-category">
                    <label htmlFor={`${labelFor('name', index)}-cat`}>分类</label>
                    <select
                      id={`${labelFor('name', index)}-cat`}
                      value={row.category}
                      onChange={(event) =>
                        handleFieldChange(row.id, { category: event.target.value as BudgetCategoryId })
                      }
                    >
                      {BUDGET_CATEGORIES.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="tbg-row-field tbg-row-name">
                    <label htmlFor={labelFor('name', index)}>名称（可留空）</label>
                    <input
                      id={labelFor('name', index)}
                      type="text"
                      autoComplete="off"
                      value={row.name}
                      maxLength={60}
                      onChange={(event) => handleFieldChange(row.id, { name: event.target.value })}
                      placeholder="例如 高铁票"
                    />
                  </div>
                  <div className="tbg-row-field tbg-row-amount">
                    <label htmlFor={labelFor('amount', index)}>金额（元）</label>
                    <input
                      id={labelFor('amount', index)}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={row.amountRaw}
                      onChange={(event) => handleFieldChange(row.id, { amountRaw: event.target.value })}
                      placeholder="0 也算一项"
                    />
                  </div>
                  <button
                    type="button"
                    className="tbg-btn tbg-row-remove"
                    onClick={() => handleRemoveRow(row.id)}
                    aria-label={`删除第 ${index + 1} 项费用`}
                  >
                    删除
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="tbg-actions">
          <button
            type="button"
            className="tbg-btn"
            onClick={handleAddRow}
            disabled={session.rows.length >= MAX_BUDGET_ITEMS}
          >
            添加费用项
          </button>
          <button type="button" className="tbg-btn" onClick={handleClear}>
            清空本次费用
          </button>
          <button
            type="button"
            className="tbg-btn"
            onClick={handleUndo}
            disabled={session.undo === null}
          >
            撤销上一步
          </button>
          <button type="button" className="tbg-btn tbg-btn-primary" onClick={handleCompute}>
            计算已填费用
          </button>
        </div>

        {rowLimitReached && (
          <p className="tbg-hint" role="note">
            费用明细最多 {MAX_BUDGET_ITEMS} 项；先删减或合并项目后再添加。
          </p>
        )}
        {actionError && (
          <p className="tbg-error" role="alert" data-testid="budget-action-error">
            {actionError}
          </p>
        )}
      </fieldset>

      <div className="tbg-live" aria-live="polite" aria-atomic="true" id={liveId}>
        {result && (
          <p className="tbg-notice" data-testid="budget-notice" data-tone={result.comparison.kind}>
            {result.comparison.kind === 'none'
              ? result.comparison.message
              : result.comparison.message}
          </p>
        )}
      </div>

      {result && (
        <div className="tbg-result" data-testid="budget-result">
          <h4 className="tbg-result-title">计算结果</h4>
          {result.hasKnownAmounts ? (
            <dl className="tbg-facts">
              <div>
                <dt>已知合计（{result.knownCount} 项）</dt>
                <dd data-testid="budget-known-total">{result.knownTotalText} 元</dd>
              </div>
              {result.categorySubtotals.map((subtotal) => (
                <div key={subtotal.category}>
                  <dt>
                    {subtotal.label}（{subtotal.count} 项）
                  </dt>
                  <dd>{formatCents(subtotal.cents)} 元</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="tbg-empty-result" data-testid="budget-no-amounts">
              暂无可合计金额。
            </p>
          )}

          {result.emptyCount > 0 && (
            <p className="tbg-missing">
              未填写金额的 {result.emptyCount} 项没有计入合计（含 0 元以外留空的行）：
              {result.emptyLines.map((line, index) => (
                <span key={line.rowId}>
                  {index > 0 ? '、' : ''}
                  {line.name.trim() === '' ? '未命名' : line.name}（{budgetCategoryLabel(line.category)}）
                </span>
              ))}
              。
            </p>
          )}

          {result.issueCount > 0 && (
            <div className="tbg-issues" data-testid="budget-issues">
              <p className="tbg-issues-title">以下 {result.issueCount} 项金额无效，未计入合计，原文已保留：</p>
              <ul>
                {result.issueLines.map((line) => (
                  <li key={line.rowId}>
                    {line.name.trim() === '' ? '未命名' : line.name}
                    （{budgetCategoryLabel(line.category)}）金额「{line.amountRaw}」：{line.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="tbg-hint">{result.notice}</p>
        </div>
      )}
    </section>
  )
}

/** 供 App 在没有草稿时取初始 session（避免 App 直接 import 内部形状以外的东西）。 */
export { emptyBudgetSession }

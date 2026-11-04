/**
 * 网页资料面板（Tavily 搜索摘要；独立信封，不接 Trip v1）。
 *
 * 边界：
 * - 只在用户点「搜索网页资料」时请求一次；挂载、展开、切天、选站、改输入、
 *   改 revision 都不发请求，也不自动重试。query 是用户实际输入的原文，
 *   不自动拼接站点/行程内容。
 * - 归属：每次渲染对完整 Trip 内容、当前 day、选中站点、来源三态、
 *   activeStopId 与 query 原文做完整序列化快照（webSourcesOwner），叠加
 *   对象 identity 与单调 epoch。任一变化即作废在途请求并隐藏旧结果；
 *   快照无法序列化时 fail closed（禁查询、隐藏旧结果、取消在途）。
 * - 响应/异常/finally 各自独立检查请求序号、归属 epoch 与 AbortSignal；
 *   忽略 abort 的 adapter 的迟到响应也不落地；旧请求的 finally 不结束新请求。
 * - 通过校验的信封按状态诚实展示（available / no_results / no_usable_results
 *   及业务失败各用固定文案，reason 一律不回显）；no_results 与
 *   no_usable_results 分开，后者不是「没有搜索结果」。HTTP/超时/网络/取消/
 *   坏结构用固定安全文案，不回显上游 reason/detail、异常文本或 Key。渲染前
 *   再调 validateWebSearchReport，防注入 adapter 绕过校验。
 * - 标题/摘录/notes 全部按纯文本渲染；链接只展示已通过 URL 安全校验的
 *   https，target=_blank + rel=noopener noreferrer。全部内容「未核实」，
 *   不冒充官方信息、营业时间、票价或实时库存。
 * - 结果只存组件内存：不写 Trip、不写费用、不写草稿、不写 localStorage。
 */
import { useEffect, useId, useRef, useState } from 'react'

import type { ApiError, Trip, TripDay } from '../lib/api'
import {
  normalizeWebSearchQuery,
  validateWebSearchReport,
  WEB_SOURCES_MAX_QUERY_CODEPOINTS,
  type WebSearchReport,
  type WebSourceStatus,
} from '../lib/webSources'
import { searchWebSources } from '../lib/webSourcesApi'
import { serializeOwnerSnapshot } from '../lib/webSourcesOwner'
import './webSourcesPanel.css'

export interface WebSourcesPanelProps {
  /** 当前页面正在显示的行程；面板只读，不修改。 */
  trip: Trip
  /** 当前日；null 表示当前没有可显示的一天。 */
  day: TripDay | null
  /** 父级页面的行程版本号；变化即作废旧结果。 */
  revision: number
  /** 当前行程来源三态：来自导入文件 / 应用内生成 / 未知。只影响说明。 */
  openedFromFile?: boolean | null
  /**
   * 当前选中的站点 id：仅作为站点下拉的初始选择线索；后续地图选中变化
   * 不再拉动本面板的选择，但会作废旧结果（归属变化）。站点无需坐标；
   * 这不是按坐标查询。
   */
  activeStopId?: string | null
  /** 异步请求 adapter，默认走 webSourcesApi.searchWebSources；测试注入 mock。 */
  requestWebSources?: (
    rawQuery: string,
    options?: { signal?: AbortSignal },
  ) => Promise<WebSearchReport>
  /** 收起面板：停止等待并清结果，不改行程。 */
  onClose?: () => void
}

/** 当日本日站点下拉选项：无需坐标，全部站点可选。 */
interface StopOption {
  stopId: string
  name: string
}

interface PanelError {
  message: string
}

interface WebResultEntry {
  report: WebSearchReport
  /** 发起本次查询时的归属快照 key（含 rawQuery 原文）。 */
  ownerKey: string
  epoch: number
}

/**
 * 传输层失败文案全部用前端固定句，不复述 provider / 后端 reason / detail /
 * 异常文本 / Key。业务失败信封本身通过校验后按状态展示固定解释。
 */
const ERROR_TEXT = {
  bad_payload: '返回的网页资料没有通过完整性检查，本次结果没有展示。行程内容不受影响。',
  timeout: '等待网页资料服务响应超时。这次没有拿到新结果，可以重新点「搜索网页资料」再试一次。',
  network: '连不上后端服务，本次没有拿到网页资料。请确认后端已启动后再试。',
  server: '网页资料搜索请求失败，这次没有拿到结果，可以稍后再试。',
  abort: '已停止等待这次网页资料查询，本次结果不展示。',
} as const

/** 十种业务状态的固定展示名（信封 reason 一律不回显）。 */
const STATUS_LABEL: Record<WebSourceStatus, string> = {
  available: '已返回',
  no_results: '没有搜索结果',
  no_usable_results: '结果无法安全展示',
  invalid_request: '查询参数未接受',
  no_key: '未配置搜索 Key',
  timeout: '查询超时',
  rate_limited: '请求过于频繁',
  unauthorized: '搜索授权未通过',
  unavailable: '搜索服务不可用',
  failed: '本次查询失败',
}

const NO_RESULTS_TEXT =
  '这次查询没有拿到搜索结果。这只说明本次查询条件下没有返回条目，不代表该地点不存在，也不代表资料不成立。'

/** no_usable_results：如实说明取得了多少条、为什么不能展示。 */
function noUsableText(report: WebSearchReport): string {
  return (
    `上游返回了 ${report.results_seen} 条，但全部未通过安全链接检查，无法安全展示。` +
    '这是保守过滤的结果，不代表该地点不存在，也不代表上游没有搜索结果。'
  )
}

const UNVERIFIED_TEXT =
  '以下全部内容来自 Tavily 搜索摘要，未核实：不代表官方信息、营业时间、票价、实时库存或身份确认。' +
  '搜索摘要不是本应用对行程的核实结论。'

const MEMORY_NOTE = '搜索内容与结果只在本页内存里，不写进行程、费用或本地保存，也不影响规划与地图。'

const TIME_NOTE =
  'checked_at 是本次查询发起的时间，fetched_at 是成功读取上游结果的时间；查询发起时间不代表资料更新时间。'

/**
 * 不可用提示（保守合并句，不重复实现 Python 空白表；上限数字来自既有常量）。
 */
const QUERY_UNAVAILABLE_HINT =
  `当前输入不能作为查询：需要 1–${WEB_SOURCES_MAX_QUERY_CODEPOINTS} 个字符（按服务端同一规范化口径计算），` +
  '且不能含有无法使用的字符。请修改后再搜索。'

/** 面板数据不可序列化时的固定提示（fail closed）。 */
const SNAPSHOT_BROKEN_TEXT =
  '当前页面数据无法安全序列化，网页资料查询已停用并隐藏旧结果；行程内容不受影响。'

function errorTextForApi(err: ApiError): string {
  switch (err.kind) {
    case 'timeout':
      return ERROR_TEXT.timeout
    case 'abort':
      return ERROR_TEXT.abort
    case 'server':
      return ERROR_TEXT.server
    case 'network':
      return ERROR_TEXT.network
    case 'bad_payload':
      return ERROR_TEXT.bad_payload
  }
}

/** 空结果与业务失败的固定解释（不回显 reason 原文）。 */
function businessFailureText(report: WebSearchReport): string {
  switch (report.status) {
    case 'no_results':
      return NO_RESULTS_TEXT
    case 'no_usable_results':
      return noUsableText(report)
    case 'invalid_request':
      return '这次查询内容没有被服务接受，请修改查询后重试。'
    case 'no_key':
      return '服务端没有配置搜索 Key，这次没有执行查询。行程内容不受影响。'
    case 'timeout':
      return '搜索服务这次等待超时，没有拿到结果。可以稍后再试。'
    case 'rate_limited':
      return '搜索服务请求过于频繁，这次没有拿到结果。可以稍后再试。'
    case 'unauthorized':
      return '搜索授权没有通过，这次没有拿到结果。可以稍后再试。'
    case 'unavailable':
      return '搜索服务暂时不可用，这次没有拿到结果。可以稍后再试。'
    default:
      return '搜索服务响应异常，这次没有拿到结果。可以稍后再试。'
  }
}

/** UTC ISO → `YYYY-MM-DD HH:mm:ss UTC`；解析不了就原样返回，不伪造时间。 */
function formatUtcTimestamp(value: string | null, fallback: string): string {
  if (!value) return fallback
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return value
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

/** 本日全部站点（无需坐标）；按记录顺序，按 stop id 去重。 */
function collectStopOptions(day: TripDay | null): StopOption[] {
  if (!day || !Array.isArray(day.stops)) return []
  const seen = new Set<string>()
  const options: StopOption[] = []
  for (const stop of day.stops) {
    if (typeof stop?.id !== 'string' || stop.id === '' || seen.has(stop.id)) continue
    seen.add(stop.id)
    options.push({
      stopId: stop.id,
      name: typeof stop.name === 'string' && stop.name.trim() !== '' ? stop.name : '未命名站点',
    })
  }
  return options
}

/**
 * 本地输入准入：唯一判据是 lib/webSources.ts 的 normalizeWebSearchQuery
 * （与后端 Python str.strip() 同口径）。不复制空白表、不用 JS trim、
 * 不按原文码点先限：FEFF 是合法正文、U+001C–1F/U+0085 属 Python 空白。
 * 展示提示只区分「不可用（含纯空白）/超限/坏 Unicode」，不再细分空白种类。
 */
type QueryLocalState = { kind: 'unavailable' } | { kind: 'ok' }

function queryLocalState(raw: string): QueryLocalState {
  return normalizeWebSearchQuery(raw) === null ? { kind: 'unavailable' } : { kind: 'ok' }
}

function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && (err as { kind?: unknown }).kind !== undefined
}

/**
 * 与 adapter 同口径的规范化：渲染前二次核对信封 requested_query 时使用。
 * 直接复用 lib/webSources.ts 的 normalizeWebSearchQuery（Python strip 口径），
 * 不自造 trim：FEFF 保留剥离语义与后端一致，validateWebSearchReport 内部
 * 也按同一函数 normalize sentQuery。
 */
function sentQueryOf(raw: string): string {
  return normalizeWebSearchQuery(raw) ?? ''
}

export default function WebSourcesPanel({
  trip,
  day,
  revision,
  openedFromFile = null,
  activeStopId = null,
  requestWebSources,
  onClose,
}: WebSourcesPanelProps) {
  const queryInputId = useId()
  const stopSelectId = useId()

  const stopOptions = collectStopOptions(day)

  // activeStopId 只作初值线索：后续地图选中变化不再拉动本面板的选择
  const [selectedStopId, setSelectedStopId] = useState<string | null>(() => {
    if (stopOptions.some((s) => s.stopId === activeStopId)) return activeStopId
    return stopOptions[0]?.stopId ?? null
  })
  const [rawQuery, setRawQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)
  const [entry, setEntry] = useState<WebResultEntry | null>(null)

  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const epochRef = useRef(0)
  const lastOwnerRef = useRef<{ identity: unknown[] | null; key: string | null }>({
    identity: null,
    key: null,
  })

  // 归属 identity：trip/day 对象引用 + 标量 props + 面板自身输入。任何新引用
  // （同 id/revision 同内容的 clone 也算）都是新归属。渲染期推进 epoch：
  // 显示守卫不等 effect。
  const identity = [trip, day, revision, openedFromFile, activeStopId, rawQuery, selectedStopId]
  const lastIdentity = lastOwnerRef.current.identity
  let identityChanged = true
  if (lastIdentity !== null && lastIdentity.length === identity.length) {
    identityChanged = false
    for (let i = 0; i < identity.length; i += 1) {
      if (!Object.is(lastIdentity[i], identity[i])) {
        identityChanged = true
        break
      }
    }
  }
  if (identityChanged) {
    epochRef.current += 1
    lastOwnerRef.current = { identity, key: null }
  }

  // 每次渲染都重算完整快照（不用 useMemo：必须捕获同引用原地修改）。
  // 无法序列化时 fail closed：禁查询、隐藏旧结果、取消在途。
  let snapshotBroken = false
  let ownerKey: string | null = null
  const snapshot = serializeOwnerSnapshot({
    trip,
    day,
    revision,
    rawQuery,
    selectedStopId,
    activeStopId,
    openedFromFile,
  })
  if (!snapshot.ok) {
    snapshotBroken = true
  } else {
    ownerKey = snapshot.key
    if (lastOwnerRef.current.key !== ownerKey) {
      lastOwnerRef.current.key = ownerKey
      if (!identityChanged) epochRef.current += 1
    }
  }
  const renderEpoch = epochRef.current

  // 显示守卫：entry 必须属于当前 epoch 且快照 key 完全一致，否则一律不显示。
  // 这是渲染期守卫；effect 只是资源清理，不承担展示正确性。
  const currentEntry =
    entry && entry.epoch === renderEpoch && ownerKey !== null && entry.ownerKey === ownerKey
      ? entry
      : null
  const report = currentEntry?.report ?? null

  const localState = queryLocalState(rawQuery)
  const queryReady = localState.kind === 'ok' && !snapshotBroken

  // 归属变化（含关闭/卸载）：作废在途请求、清错误与旧结果。显示由上面的
  // 渲染期守卫兜底；这里负责真实的资源取消与状态复位。
  useEffect(() => {
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setError(null)
    setEntry(null)
    return () => {
      seqRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
    // 快照 key 覆盖全部内容变化；引用变化由 epoch 逻辑单独处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, revision, day, openedFromFile, activeStopId, selectedStopId, ownerKey])

  // fail closed（快照不可序列化）：立即取消在途请求并清等待状态。
  useEffect(() => {
    if (!snapshotBroken) return
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setError(null)
    setEntry(null)
  }, [snapshotBroken])

  function stopWaiting() {
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setError({ message: ERROR_TEXT.abort })
    // 固定安全语义：停止等待不保留本次结果，也不保留上次结果（本组件无 stale 态）
    setEntry(null)
  }

  function handleClose() {
    stopWaiting()
    onClose?.()
  }

  async function handleSearch() {
    if (pending || !queryReady || snapshotBroken || !ownerKey) return
    const raw = rawQuery
    const ownerKeyAtStart = ownerKey
    const epochAtStart = epochRef.current
    const seq = seqRef.current + 1
    seqRef.current = seq
    const controller = new AbortController()
    abortRef.current = controller
    setPending(true)
    // 固定安全语义：新查询开始即清旧结果与旧错误（不保留上次结果）
    setError(null)
    setEntry(null)

    const search = requestWebSources ?? searchWebSources
    try {
      const response = await search(raw, { signal: controller.signal })
      if (
        seqRef.current !== seq ||
        controller.signal.aborted ||
        epochRef.current !== epochAtStart
      ) {
        return
      }
      // 展示前再核对一次：adapter 可能被替换，不能假设它已校验过；
      // 同时核对 requested_query 等于本次规范化实发 query（防注入 adapter）。
      const validated = validateWebSearchReport(response, sentQueryOf(raw))
      if (!validated.ok) {
        setError({ message: ERROR_TEXT.bad_payload })
        return
      }
      setEntry({
        report: validated.report,
        ownerKey: ownerKeyAtStart,
        epoch: epochAtStart,
      })
    } catch (err) {
      if (
        seqRef.current !== seq ||
        controller.signal.aborted ||
        epochRef.current !== epochAtStart
      ) {
        return
      }
      setError({ message: isApiError(err) ? errorTextForApi(err) : ERROR_TEXT.network })
    } finally {
      // 只有「仍然是当前请求」时才收 pending；旧请求的 finally 不结束新请求
      if (seqRef.current === seq && epochRef.current === epochAtStart) {
        setPending(false)
        if (abortRef.current === controller) abortRef.current = null
      }
    }
  }

  if (!day) {
    return (
      <section className="wsp" aria-label="网页资料" data-testid="web-sources-panel">
        <div className="wsp-head">
          <div className="wsp-head-main">
            <p className="wsp-eyebrow">独立资料查询</p>
            <h3 className="wsp-title">网页资料</h3>
          </div>
          <button type="button" className="wsp-btn" onClick={handleClose}>
            收起
          </button>
        </div>
        <p className="wsp-notice" role="note">
          当前行程里没有可显示的这一天，无法搜索网页资料。行程内容保持不变。
        </p>
      </section>
    )
  }

  const sourceNote =
    openedFromFile === true
      ? '当前行程来自导入文件。'
      : openedFromFile === false
        ? '当前行程来自应用内规划或本地编辑。'
        : '当前行程没有来源标记，按未核实处理。'

  return (
    <section
      className="wsp"
      aria-label="网页资料"
      aria-busy={pending || undefined}
      data-testid="web-sources-panel"
    >
      <div className="wsp-head">
        <div className="wsp-head-main">
          <p className="wsp-eyebrow">独立资料查询 · Tavily 搜索摘要 · 不写行程</p>
          <h3 className="wsp-title">
            第 {day.day} 天{day.date ? ` · ${day.date}` : ''} 网页资料
          </h3>
          <p className="wsp-meta-line">
            {trip.title}
            {day.title ? ` · ${day.title}` : ''}
          </p>
        </div>
        <button type="button" className="wsp-btn" onClick={handleClose}>
          收起
        </button>
      </div>

      <p className="wsp-note">
        {sourceNote}
        查询只使用下面输入框里的内容：不会自动拼接行程或站点，也不会在切天、选站时自动搜索。
      </p>

      {snapshotBroken ? (
        <p className="wsp-error" role="alert" data-testid="web-sources-snapshot-broken">
          {SNAPSHOT_BROKEN_TEXT}
        </p>
      ) : null}

      <div className="wsp-form">
        <div className="wsp-field">
          <label htmlFor={queryInputId}>网页搜索内容</label>
          <input
            id={queryInputId}
            type="text"
            value={rawQuery}
            onChange={(event) => setRawQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {localState.kind === 'unavailable' ? (
            <p className="wsp-hint">{QUERY_UNAVAILABLE_HINT}</p>
          ) : null}
        </div>

        {stopOptions.length > 0 ? (
          <div className="wsp-field">
            <label htmlFor={stopSelectId}>站点上下文（可选）</label>
            <select
              id={stopSelectId}
              value={selectedStopId ?? ''}
              onChange={(event) => setSelectedStopId(event.target.value || null)}
            >
              {stopOptions.map((option) => (
                <option key={option.stopId} value={option.stopId}>
                  {option.name}
                </option>
              ))}
            </select>
            <p className="wsp-hint">站点只作为阅读上下文：不参与查询内容，也不修改地图选中。</p>
          </div>
        ) : (
          <p className="wsp-hint">本日没有站点记录；这不影响搜索，查询内容以上面输入框为准。</p>
        )}

        <div className="wsp-actions">
          <button
            type="button"
            className="wsp-btn wsp-btn-primary"
            onClick={() => {
              void handleSearch()
            }}
            disabled={pending || !queryReady}
          >
            搜索网页资料
          </button>
          {pending ? (
            <button type="button" className="wsp-btn" onClick={stopWaiting}>
              停止等待
            </button>
          ) : null}
          <p className="wsp-hint wsp-request-hint">
            只有点这一次按钮才会请求一次；不会自动查询，也不会自动重试。
          </p>
        </div>
      </div>

      {pending ? (
        <p className="wsp-pending" role="status">
          正在等待网页资料服务响应。可以停止等待：这只结束本页的等待，不保证后端或上游停止处理。
        </p>
      ) : null}

      {error ? (
        <p className="wsp-error" role="alert" data-testid="web-sources-error">
          {error.message}
        </p>
      ) : null}

      {report ? <ReportBlock report={report} /> : null}

      <p className="wsp-memory-note">{MEMORY_NOTE}</p>

      <p className="wsp-attribution" data-testid="web-sources-attribution">
        数据来源：Tavily Search API（搜索摘要）·{' '}
        <a
          href={report?.source.docs_url ?? 'https://docs.tavily.com/api-reference/endpoint/search'}
          target="_blank"
          rel="noopener noreferrer"
        >
          接口说明
        </a>
        {' · '}与附近公开资料（OpenStreetMap）是不同来源，互不替代。
      </p>
    </section>
  )
}

function ReportBlock({ report }: { report: WebSearchReport }) {
  const checkedAt = formatUtcTimestamp(report.checked_at, '时间未知')
  const fetchedAt = formatUtcTimestamp(report.fetched_at, '未知（未成功获取）')
  return (
    <div className="wsp-result" data-status={report.status} data-testid="web-sources-result">
      <div className="wsp-result-head">
        <h4 className="wsp-result-title">网页搜索摘要</h4>
        <span className="wsp-tag" data-testid="web-sources-status-tag">
          {STATUS_LABEL[report.status]}
        </span>
      </div>

      <p className="wsp-unverified" data-testid="web-sources-unverified" role="note">
        {UNVERIFIED_TEXT}
      </p>

      {report.status === 'available' ? (
        <>
          <ol className="wsp-results">
            {report.results.map((result, index) => (
              <ResultItem key={`${result.url}-${index}`} result={result} />
            ))}
          </ol>
          {report.notes.length > 0 ? (
            <p className="wsp-hint" data-testid="web-sources-notes">
              来源处理说明：{report.notes.join('；')}
            </p>
          ) : null}
        </>
      ) : (
        <p className="wsp-notice" role="status" data-testid="web-sources-empty">
          {businessFailureText(report)}
        </p>
      )}

      <dl className="wsp-facts">
        <div>
          <dt>查询发起时间</dt>
          <dd>{checkedAt}</dd>
        </div>
        <div>
          <dt>本次获取时间</dt>
          <dd>{fetchedAt}</dd>
        </div>
        <div>
          <dt>实发查询</dt>
          <dd>{report.requested_query ?? '（invalid_request：未发送）'}</dd>
        </div>
        <div>
          <dt>上游返回条目</dt>
          <dd>{report.results_seen} 条</dd>
        </div>
      </dl>
      <p className="wsp-hint">{TIME_NOTE}</p>
    </div>
  )
}

function ResultItem({ result }: { result: WebSearchReport['results'][number] }) {
  return (
    <li className="wsp-result-item">
      <p className="wsp-result-item-title">
        {result.title ?? '（来源未提供标题）'}
        <span className="wsp-tag wsp-tag-unverified">未核实</span>
      </p>
      <p className="wsp-result-item-link">
        <a href={result.url} target="_blank" rel="noopener noreferrer">
          {result.url}
        </a>
      </p>
      {result.snippet !== null ? (
        <p className="wsp-result-item-snippet">
          {result.snippet}
          {result.snippet_truncated ? '（摘录超长，已截断显示）' : ''}
        </p>
      ) : (
        <p className="wsp-result-item-snippet">（来源未提供摘录）</p>
      )}
      <p className="wsp-result-item-date">
        网页发布日期：{result.publication_date ?? '未知（来源未提供）'}
      </p>
    </li>
  )
}

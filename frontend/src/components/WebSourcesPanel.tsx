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
import type { PoiCardPrefill } from '../lib/poiCardPrefill'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

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
  /**
   * 收进资料卡：把一条搜索结果作为预填载荷交给父级（App 打开预填表单）。
   * 本面板只构造载荷、不落盘；不点「收进」不构造、零写入。
   */
  onCollectPoiCard?: (prefill: PoiCardPrefill) => void
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
 * 一条 Tavily 结果 → 收进预填载荷（只构造，不落盘；确认保存才写 poiCards:v1）。
 * intro 预填标题 + 摘录（缺则只摘录，都缺留空）；名称留空 = 来源没有可当名称的
 * 字段，用户必须填写。字段 provenance 标 tavily + 页面 URL detail；一切内容
 * 默认「未核实」。Tavily 摘要信封没有图片字段（契约 WebSearchResult 只有页面
 * URL，页面 URL 不是图片、不冒充图片预填）；用户在预填表单里自行贴入的图片
 * URL 按 source=tavily + attribution 标页面来源（imageSourceHint 通道）。
 */
export function collectPrefillFromWebResult(
  result: WebSearchReport['results'][number],
  collectedAt: number,
): PoiCardPrefill {
  const title = result.title?.trim() ?? ''
  const snippet = result.snippet?.trim() ?? ''
  const introParts: string[] = []
  if (title.length > 0) introParts.push(title)
  if (snippet.length > 0) introParts.push(snippet)
  const intro = introParts.join('\n').slice(0, 2000)
  const hasIntro = intro.length > 0
  return {
    name: '',
    intro,
    openingHours: '',
    ticket: '',
    provenance: hasIntro
      ? {
          intro: { source: 'tavily', detail: result.url, recordedAt: collectedAt },
        }
      : null,
    collectNotice:
      '预填自 Tavily 网页搜索摘要，未核实；不代表官方信息、营业时间或票价。请核对后保存，不采纳则零写入。',
    imageSourceHint: 'tavily',
    imageAttributionHint: title.length > 0 ? title : result.url,
  }
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

/** W3b：面板级通用类名，从 webSourcesPanel.css 迁来（shadcn + Tailwind）。 */
const PANEL = 'grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5 shadow-[var(--shadow-1)] max-md:p-4'
const HINT = 'm-0 text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]'
const TAG =
  'inline-flex shrink-0 items-center rounded-full bg-[color:var(--color-accent-soft)] px-2.5 py-0.5 text-xs font-medium text-[color:var(--color-accent-ink)]'
const TAG_UNVERIFIED =
  'inline-flex shrink-0 items-center rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground'
const RESULT_BOX = 'grid min-w-0 gap-3 rounded-[10px] border border-border bg-background p-4'
const ERROR_STYLE =
  'm-0 rounded-[6px] border border-[color:var(--color-warn-ink)]/40 bg-[color:var(--color-warn-bg)] p-3 text-sm font-medium leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]'

export default function WebSourcesPanel({
  trip,
  day,
  revision,
  openedFromFile = null,
  activeStopId = null,
  requestWebSources,
  onCollectPoiCard,
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
      <section className={PANEL} aria-label="网页资料" data-testid="web-sources-panel">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_260px]">
            <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-ink)]">
              独立资料查询
            </p>
            <h3 className="m-0 mb-2 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]">
              网页资料
            </h3>
          </div>
          <Button variant="outline" onClick={handleClose}>
            收起
          </Button>
        </div>
        <p className="m-0 border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] p-3 text-sm leading-relaxed text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]" role="note">
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
      className={PANEL}
      aria-label="网页资料"
      aria-busy={pending || undefined}
      data-testid="web-sources-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_260px]">
          <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-ink)]">
            独立资料查询 · Tavily 搜索摘要 · 不写行程
          </p>
          <h3 className="m-0 mb-2 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]">
            第 {day.day} 天{day.date ? ` · ${day.date}` : ''} 网页资料
          </h3>
          <p className="m-0 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {trip.title}
            {day.title ? ` · ${day.title}` : ''}
          </p>
        </div>
        <Button variant="outline" onClick={handleClose}>
          收起
        </Button>
      </div>

      <p className="m-0 max-w-[72ch] text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        {sourceNote}
        查询只使用下面输入框里的内容：不会自动拼接行程或站点，也不会在切天、选站时自动搜索。
      </p>

      {snapshotBroken ? (
        <p className={ERROR_STYLE} role="alert" data-testid="web-sources-snapshot-broken">
          {SNAPSHOT_BROKEN_TEXT}
        </p>
      ) : null}

      <div className="grid gap-4 rounded-[10px] border border-border bg-background p-4">
        <div className="grid gap-1.5">
          <label className="text-sm leading-relaxed text-muted-foreground" htmlFor={queryInputId}>
            网页搜索内容
          </label>
          <Input
            id={queryInputId}
            className="min-h-11 w-full"
            type="text"
            value={rawQuery}
            onChange={(event) => setRawQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {localState.kind === 'unavailable' ? <p className={HINT}>{QUERY_UNAVAILABLE_HINT}</p> : null}
        </div>

        {stopOptions.length > 0 ? (
          <div className="grid gap-1.5">
            <label className="text-sm leading-relaxed text-muted-foreground" htmlFor={stopSelectId}>
              站点上下文（可选）
            </label>
            <Select
              id={stopSelectId}
              className="min-h-11 w-full"
              value={selectedStopId ?? ''}
              onChange={(event) => setSelectedStopId(event.target.value || null)}
            >
              {stopOptions.map((option) => (
                <option key={option.stopId} value={option.stopId}>
                  {option.name}
                </option>
              ))}
            </Select>
            <p className={HINT}>站点只作为阅读上下文：不参与查询内容，也不修改地图选中。</p>
          </div>
        ) : (
          <p className={HINT}>本日没有站点记录；这不影响搜索，查询内容以上面输入框为准。</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              void handleSearch()
            }}
            disabled={pending || !queryReady}
          >
            搜索网页资料
          </Button>
          {pending ? (
            <Button variant="outline" onClick={stopWaiting}>
              停止等待
            </Button>
          ) : null}
          <p className={HINT}>只有点这一次按钮才会请求一次；不会自动查询，也不会自动重试。</p>
        </div>
      </div>

      {pending ? (
        <p
          className="m-0 border-l-[3px] border-l-[color:var(--color-accent)] pl-3 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
          role="status"
        >
          正在等待网页资料服务响应。可以停止等待：这只结束本页的等待，不保证后端或上游停止处理。
        </p>
      ) : null}

      {error ? (
        <p className={ERROR_STYLE} role="alert" data-testid="web-sources-error">
          {error.message}
        </p>
      ) : null}

      {report ? <ReportBlock report={report} onCollectPoiCard={onCollectPoiCard} /> : null}

      <p className={HINT}>{MEMORY_NOTE}</p>

      <p
        className="m-0 border-t border-t-border pt-3 text-xs leading-[1.7] text-muted-foreground [overflow-wrap:anywhere]"
        data-testid="web-sources-attribution"
      >
        数据来源：Tavily Search API（搜索摘要）·{' '}
        <a
          className="text-[color:var(--color-accent-ink)] underline-offset-2 [text-decoration-thickness:1px]"
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

function ReportBlock({
  report,
  onCollectPoiCard,
}: {
  report: WebSearchReport
  onCollectPoiCard?: (prefill: PoiCardPrefill) => void
}) {
  const checkedAt = formatUtcTimestamp(report.checked_at, '时间未知')
  const fetchedAt = formatUtcTimestamp(report.fetched_at, '未知（未成功获取）')
  return (
    <div className={RESULT_BOX} data-status={report.status} data-testid="web-sources-result">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="m-0 font-display text-md font-bold leading-normal [overflow-wrap:anywhere]">
          网页搜索摘要
        </h4>
        <span className={TAG} data-testid="web-sources-status-tag">
          {STATUS_LABEL[report.status]}
        </span>
      </div>

      <p
        className="m-0 rounded-[6px] border border-dashed border-[color:var(--color-accent)]/50 bg-[color:var(--color-accent-soft)]/40 p-3 text-sm leading-relaxed text-[color:var(--color-accent-ink)] [overflow-wrap:anywhere]"
        data-testid="web-sources-unverified"
        role="note"
      >
        {UNVERIFIED_TEXT}
      </p>

      {report.status === 'available' ? (
        <>
          <ol className="m-0 grid list-none gap-3 p-0">
            {report.results.map((result, index) => (
              <ResultItem
                key={`${result.url}-${index}`}
                result={result}
                onCollectPoiCard={onCollectPoiCard}
              />
            ))}
          </ol>
          {report.notes.length > 0 ? (
            <p className={HINT} data-testid="web-sources-notes">
              来源处理说明：{report.notes.join('；')}
            </p>
          ) : null}
        </>
      ) : (
        <p
          className="m-0 border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] p-3 text-sm leading-relaxed text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]"
          role="status"
          data-testid="web-sources-empty"
        >
          {businessFailureText(report)}
        </p>
      )}

      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-t-border pt-2 max-md:grid-cols-1">
        <div>
          <dt className="text-xs text-muted-foreground">查询发起时间</dt>
          <dd className="m-0 font-mono text-sm leading-relaxed tabular-nums text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]">
            {checkedAt}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">本次获取时间</dt>
          <dd className="m-0 font-mono text-sm leading-relaxed tabular-nums text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]">
            {fetchedAt}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">实发查询</dt>
          <dd className="m-0 text-sm leading-relaxed text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]">
            {report.requested_query ?? '（invalid_request：未发送）'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">上游返回条目</dt>
          <dd className="m-0 font-mono text-sm leading-relaxed tabular-nums text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]">
            {report.results_seen} 条
          </dd>
        </div>
      </dl>
      <p className={HINT}>{TIME_NOTE}</p>
    </div>
  )
}

function ResultItem({
  result,
  onCollectPoiCard,
}: {
  result: WebSearchReport['results'][number]
  onCollectPoiCard?: (prefill: PoiCardPrefill) => void
}) {
  return (
    <li className="grid min-w-0 gap-1.5 rounded-[6px] border border-border bg-card p-3">
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm font-semibold leading-relaxed text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]">
        {result.title ?? '（来源未提供标题）'}
        <span className={TAG_UNVERIFIED}>未核实</span>
      </p>
      <p className="m-0 min-w-0 break-all text-sm leading-relaxed [overflow-wrap:anywhere]">
        <a
          className="text-[color:var(--color-accent-ink)] underline-offset-2 [text-decoration-thickness:1px]"
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {result.url}
        </a>
      </p>
      {result.snippet !== null ? (
        <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-[color:var(--color-ink-2)] [overflow-wrap:anywhere]">
          {result.snippet}
          {result.snippet_truncated ? '（摘录超长，已截断显示）' : ''}
        </p>
      ) : (
        <p className="m-0 text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          （来源未提供摘录）
        </p>
      )}
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">
        网页发布日期：{result.publication_date ?? '未知（来源未提供）'}
      </p>
      {onCollectPoiCard ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            data-testid="web-sources-collect"
            aria-label={`收进资料卡：${result.title ?? result.url}`}
            onClick={() => {
              onCollectPoiCard(collectPrefillFromWebResult(result, Date.now()))
            }}
          >
            收进资料卡
          </Button>
          <span className={HINT}>打开预填表单，确认保存才写入；不采纳零写入。</span>
        </div>
      ) : null}
    </li>
  )
}

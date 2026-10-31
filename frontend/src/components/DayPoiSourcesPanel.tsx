/**
 * 本日公开资料候选面板（独立信封，不接 Trip v1）。
 *
 * 边界：
 * - 只在用户点「查询附近资料」时请求一次；挂载、展开、切天、换站点、
 *   改 revision 都不发请求，也不自动重试。
 * - 坐标只取本日行程记录里带 WGS84 坐标的站点；0 / 负坐标是合法值。
 *   本日没有坐标就禁用查询，不改用其它天、浏览器定位或按城市猜。
 * - 查到的是附近公开资料候选而非原站点已核实：候选 identity_status 恒为
 *   unconfirmed；opening_hours/fee/charge 只透传来源标签原文，不解析成
 *   实时营业、免费与否或票价币种。
 * - 获取时间（retrieved_at/checked_at）与对象编辑时间（source_updated_at，
 *   缺失为未知）分开显示；缓存命中保留原时间，不伪装成新抓取。
 * - 查询进行中可停止。停止 / 关闭 / 切行程 / revision / 站点 / 坐标变化都
 *   递增序号并 abort，迟到的响应一律丢弃（adapter 忽略 abort 也不落地）。
 * - same-query 刷新失败可保留上次成功候选，但必须明确标注；不同 query
 *   一律清理。合法 no_candidates 清掉旧候选并说明不代表地点不存在。
 * - 结果只存组件内存：不写 Trip、不写 localStorage、不改地图、不触发 AI。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { ApiError, Trip, TripDay } from '../lib/api'
import {
  collectPoiStations,
  formatPoiCoordinate,
  formatPoiDistance,
  formatPoiTimestamp,
  osmObjectUrl,
  poiStatusText,
  tagFieldText,
  validatePoiSourceReport,
  type PoiSourceCandidate,
  type PoiSourceQuery,
  type PoiSourceReport,
} from '../lib/poiSources'
import { fetchPoiSourcesNearby, type PoiSourcesAdapter } from '../lib/poiSourcesApi'
import './dayPoiSourcesPanel.css'

export interface DayPoiSourcesPanelProps {
  /** 当前页面正在显示的行程；面板只读，不修改。 */
  trip: Trip
  /** 当前日；null 表示当前没有可显示的一天。 */
  day: TripDay | null
  /** 父级页面的行程版本号；变化即作废旧结果。 */
  revision: number
  /** 当前行程来自导入文件：只影响坐标来源标识，不影响查询。 */
  openedFromFile?: boolean
  /**
   * 当前选中的站点 id：仅作为站点下拉的初始选择线索。
   * 没有这个站或它没有坐标时回落到第一个可用站点；面板不反向修改地图选中。
   */
  activeStopId?: string | null
  /** 异步请求 adapter，默认走 poiSourcesApi.fetchPoiSourcesNearby；测试注入 mock。 */
  requestPoiSources?: PoiSourcesAdapter
  /** 收起面板：只停止等待与清结果，不改行程。 */
  onClose?: () => void
}

type PanelErrorKind =
  | 'no_station'
  | 'timeout'
  | 'network'
  | 'server'
  | 'abort'
  | 'bad_payload'

interface PanelError {
  kind: PanelErrorKind
  message: string
}

interface PoiResultEntry {
  report: PoiSourceReport
  stopId: string
  stopName: string
  lat: number
  lon: number
  dayNumber: number
  tripId: string
  revision: number
}

/**
 * 失败文案全部用前端固定句，不复述 provider / 后端 reason / detail 原文。
 * same-query 刷新失败时不设 error，而是保留旧结果并加 stale 提示。
 */
const ERROR_TEXT: Record<PanelErrorKind, string> = {
  no_station: '本日没有可用的记录坐标，无法查询附近资料。',
  timeout: '等待公开资料服务响应超时。这次没有拿到新结果，可以重新点「查询附近资料」再试一次。',
  network: '连不上后端服务，本次没有拿到公开资料。请确认后端已启动后再试。',
  server: '公开资料查询请求失败，这次没有拿到结果，可以稍后再试。',
  abort: '已停止等待这次公开资料查询，本次结果不展示。',
  bad_payload: '返回的公开资料没有通过完整性检查，本次结果没有展示。',
}

const STALE_NOTICE =
  '本次没有拿到新结果，下面显示的是上次查询的结果（时间为上次获取时间），不是本次的结论。'

const NO_CANDIDATES_TEXT =
  '本期没有找到带公开字段（opening_hours / fee / charge）的附近候选。这只说明本次查询条件下没有可用公开字段候选，不代表该地点在地图或现实中不存在。'

const SCOPE_NOTE =
  '按行程记录坐标查询 100 米内：只用本日站点记录里的 WGS84 坐标，不用浏览器定位、不按城市猜，也不去其它天找坐标。' +
  '结果是附近公开资料候选，身份未确认——距离近、名称相似都不是身份确认，选择候选不代表原站点已核实。'

const MEMORY_NOTE =
  '结果只在本页内存里，不写进行程或本地保存，也不改地图与规划内容。'

/** 面板内可复现的上次查询上下文：same-query 判定用 */
interface LastQueryContext {
  query: PoiSourceQuery
  stopId: string
  stopName: string
  dayNumber: number
  tripId: string
  revision: number
}

function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && (err as { kind?: unknown }).kind !== undefined
}

function errorForApi(err: ApiError): PanelError {
  switch (err.kind) {
    case 'timeout':
      return { kind: 'timeout', message: ERROR_TEXT.timeout }
    case 'abort':
      return { kind: 'abort', message: ERROR_TEXT.abort }
    case 'server':
      return {
        kind: 'server',
        message:
          err.status === 502 || err.status === 503
            ? '公开资料服务暂时不可用，本次没有拿到结果。该查询是独立功能，行程其它部分不受影响；可以稍后再试。'
            : err.status === 422
              ? '这次查询的坐标没有被公开资料服务接受，请核对后重试。'
              : `公开资料查询请求失败（HTTP ${err.status ?? '未知'}），这次没有拿到结果，可以稍后再试。`,
      }
    case 'network':
      return { kind: 'network', message: ERROR_TEXT.network }
    case 'bad_payload':
      return { kind: 'bad_payload', message: ERROR_TEXT.bad_payload }
  }
}

function sameQuery(a: PoiSourceQuery, b: PoiSourceQuery): boolean {
  // 后端把请求坐标 round 到 6 位小数；判定上下文一致也用容差，不用浮点全等
  return Math.abs(a.lat - b.lat) <= 1e-5 && Math.abs(a.lon - b.lon) <= 1e-5
}

export default function DayPoiSourcesPanel({
  trip,
  day,
  revision,
  openedFromFile,
  activeStopId = null,
  requestPoiSources,
  onClose,
}: DayPoiSourcesPanelProps) {
  const stationSelectId = useId()

  const stations = useMemo(() => collectPoiStations(day), [day])
  const stationsKey = stations.map((s) => s.stopId).join('|')
  // 站点 id 集合不变但坐标可能被编辑：坐标变了同样作废旧结果
  const coordsKey = stations.map((s) => `${s.stopId}:${s.lat},${s.lon}`).join('|')

  // activeStopId 只作初值线索：后续切地图选中不再拉动本面板的选择（不自动改查询）
  const [stationId, setStationId] = useState<string>(() => {
    const fromActive = stations.find((s) => s.stopId === activeStopId)
    return fromActive?.stopId ?? stations[0]?.stopId ?? ''
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)
  const [entry, setEntry] = useState<PoiResultEntry | null>(null)
  const [stale, setStale] = useState(false)
  const lastQueryRef = useRef<LastQueryContext | null>(null)

  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // 行程 / revision / 当天 / 站点集合 / 站点坐标变化：作废在途请求与旧结果。
  // 用稳定字符串做依赖，避免每次渲染的新数组触发重置。
  useEffect(() => {
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    lastQueryRef.current = null
    setPending(false)
    setError(null)
    setEntry(null)
    setStale(false)
    setStationId(() => {
      const fromActive = stations.find((s) => s.stopId === activeStopId)
      return fromActive?.stopId ?? stations[0]?.stopId ?? ''
    })
    return () => {
      seqRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, revision, day, stationsKey, coordsKey])

  const station = stations.find((s) => s.stopId === stationId) ?? stations[0] ?? null

  /**
   * 只展示与当前行程 / revision / 站点（含坐标）完全一致的结果。
   * 这样即使 effect 还没跑，改选站点后也看不到旧结果。
   */
  const currentEntry =
    entry &&
    entry.tripId === trip.id &&
    entry.revision === revision &&
    entry.dayNumber === day?.day &&
    entry.stopId === station?.stopId &&
    station &&
    entry.lat === station.lat &&
    entry.lon === station.lon
      ? entry
      : null
  const report = currentEntry?.report ?? null
  // stale 标注只在结果仍属于当前查询上下文时展示
  const showStale = stale && currentEntry !== null

  function stopWaiting(markAbort: boolean) {
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    if (markAbort) {
      setError({ kind: 'abort', message: ERROR_TEXT.abort })
      // 手动停止等待：屏幕上剩下的旧候选（若属于当前查询上下文）不是
      // 本次结论，明确标「上次结果」，避免被误读成本次查询的答案。
      // 第一次查询就停止时没有旧候选，entry 为 null，无 stale 可标。
      if (lastQueryRef.current !== null) {
        setStale(true)
      }
    }
  }

  function handleClose() {
    stopWaiting(false)
    onClose?.()
  }

  async function handleQuery() {
    if (pending || !day || !station) return

    const query: PoiSourceQuery = { lat: station.lat, lon: station.lon }
    const previous = lastQueryRef.current
    const sameQueryRetry =
      previous !== null &&
      previous.stopId === station.stopId &&
      previous.dayNumber === day.day &&
      previous.tripId === trip.id &&
      previous.revision === revision &&
      sameQuery(previous.query, query)

    const seq = seqRef.current + 1
    seqRef.current = seq
    const controller = new AbortController()
    abortRef.current = controller
    setPending(true)
    setError(null)
    // same-query 刷新保留旧候选直到新结果落地；不同 query 立即清理
    if (!sameQueryRetry) {
      setEntry(null)
      setStale(false)
    }

    try {
      const response = await (requestPoiSources ?? fetchPoiSourcesNearby)(query, {
        signal: controller.signal,
      })
      if (seqRef.current !== seq || controller.signal.aborted) return
      // 展示前再核对一次：adapter 可能被替换，不能假设它已经校验过。
      const validated = validatePoiSourceReport(response, query)
      if (!validated.ok) {
        setError({ kind: 'bad_payload', message: ERROR_TEXT.bad_payload })
        if (sameQueryRetry) setStale(true)
        return
      }
      const report = validated.report
      if (report.status === 'available' || report.status === 'no_candidates') {
        // 合法终态：覆盖旧候选（no_candidates 清空并说明）；same-query 失败的
        // stale 标注同时撤掉——现在有新结论了，不再说「下面是上次结果」。
        setStale(false)
        lastQueryRef.current = {
          query,
          stopId: station.stopId,
          stopName: station.name,
          dayNumber: day.day,
          tripId: trip.id,
          revision,
        }
        setEntry({
          report,
          stopId: station.stopId,
          stopName: station.name,
          lat: station.lat,
          lon: station.lon,
          dayNumber: day.day,
          tripId: trip.id,
          revision,
        })
        setError(null)
      } else {
        // 后端业务失败态（timeout/rate_limited/unavailable/failed/invalid_request）：
        // 信封本身合法但没有候选。same-query 时保留旧成功候选并标注。
        if (sameQueryRetry && entry !== null) {
          setStale(true)
        } else {
          setEntry(null)
          setStale(false)
        }
        setError({
          kind: 'server',
          message:
            report.status === 'rate_limited'
              ? '公开资料服务请求过于频繁，这次没有拿到新结果。可以稍后再试。'
              : report.status === 'invalid_request'
                ? '这次查询的坐标没有被公开资料服务接受，请核对后重试。'
                : `公开资料服务这次未能完成查询（${poiStatusText(report.status)}），没有拿到新结果。可以稍后再试。`,
        })
      }
    } catch (err) {
      if (seqRef.current !== seq || controller.signal.aborted) return
      if (isApiError(err)) {
        setError(errorForApi(err))
      } else {
        setError({
          kind: 'network',
          message: '查询附近资料时出现问题，本次没有拿到结果。行程没有因此改动，可以再试一次。',
        })
      }
      if (sameQueryRetry && entry !== null) setStale(true)
    } finally {
      if (seqRef.current === seq) {
        setPending(false)
        abortRef.current = null
      }
    }
  }

  if (!day) {
    return (
      <section className="dps" aria-label="本日公开资料候选">
        <div className="dps-head">
          <div className="dps-head-main">
            <p className="dps-eyebrow">独立资料查询</p>
            <h3 className="dps-title">附近公开资料</h3>
          </div>
          <button type="button" className="dps-btn" onClick={handleClose}>
            收起
          </button>
        </div>
        <p className="dps-notice" role="note">
          当前行程里没有可显示的这一天，无法查询附近资料。行程内容保持不变。
        </p>
      </section>
    )
  }

  /**
   * 当前行程是不是导入文件：影响坐标来源徽标。面板只在有坐标可选时展示它，
   * 与天气面板一致：只影响说明文案，不影响查询。
   */
  const fromFileBadge = openedFromFile

  return (
    <section
      className="dps"
      aria-label="本日公开资料候选"
      aria-busy={pending || undefined}
      data-testid="poi-sources-panel"
    >
      <div className="dps-head">
        <div className="dps-head-main">
          <p className="dps-eyebrow">独立资料查询 · 不写行程</p>
          <h3 className="dps-title">
            第 {day.day} 天{day.date ? ` · ${day.date}` : ''} 附近公开资料
          </h3>
          <p className="dps-meta-line">
            {trip.title}
            {day.title ? ` · ${day.title}` : ''}
            {pending ? (
              <span className="dps-tag" role="status">
                正在查询…
              </span>
            ) : null}
          </p>
        </div>
        <button type="button" className="dps-btn" onClick={handleClose}>
          收起
        </button>
      </div>

      <p className="dps-note">
        {SCOPE_NOTE}
        {fromFileBadge ? '当前行程来自导入文件：坐标来自文件里的记录。' : null}
      </p>

      {stations.length === 0 ? (
        <>
          <p className="dps-empty" role="note">
            本日没有带 WGS84 坐标的站点记录，无法查询附近资料。这里不会改用其它天、浏览器位置或按城市推测的坐标。
          </p>
          <div className="dps-actions">
            <button type="button" className="dps-btn dps-btn-primary" disabled>
              查询附近资料
            </button>
            <p className="dps-hint">本日没有可用坐标，查询已禁用。</p>
          </div>
        </>
      ) : (
        <div className="dps-form">
          <div className="dps-field">
            <label htmlFor={stationSelectId}>按哪条记录坐标查询</label>
            <select
              id={stationSelectId}
              value={station?.stopId ?? ''}
              onChange={(event) => setStationId(event.target.value)}
              disabled={pending}
            >
              {stations.map((option) => (
                <option key={option.stopId} value={option.stopId}>
                  {option.name} · {formatPoiCoordinate(option.lat)}, {formatPoiCoordinate(option.lon)}
                </option>
              ))}
            </select>
            {station ? (
              <p className="dps-hint">
                本次将按「{station.name}」的记录坐标查询：纬度 {formatPoiCoordinate(station.lat)}，经度{' '}
                {formatPoiCoordinate(station.lon)}（WGS84）。
              </p>
            ) : null}
          </div>

          <div className="dps-actions">
            <button
              type="button"
              className="dps-btn dps-btn-primary"
              onClick={() => {
                void handleQuery()
              }}
              disabled={pending}
            >
              查询附近资料
            </button>
            {pending ? (
              <button type="button" className="dps-btn" onClick={() => stopWaiting(true)}>
                停止等待
              </button>
            ) : null}
            <p className="dps-hint dps-request-hint">
              只有点这一次按钮才会请求一次附近资料；不会自动查询，也不会自动重试。
            </p>
          </div>
        </div>
      )}

      {pending ? (
        <p className="dps-pending" role="status">
          正在等待公开资料服务响应。可以停止等待：这只结束本页的等待，不保证后端或上游停止处理。
        </p>
      ) : null}

      {error ? (
        <p className="dps-error" role="alert">
          {error.message}
        </p>
      ) : null}

      {report ? (
        <ReportBlock report={report} stationName={currentEntry?.stopName ?? station?.name ?? ''} stale={showStale} />
      ) : null}

      <p className="dps-memory-note">{MEMORY_NOTE}</p>

      <Attribution report={report} />
    </section>
  )
}

function ReportBlock({
  report,
  stationName,
  stale,
}: {
  report: PoiSourceReport
  stationName: string
  stale: boolean
}) {
  return (
    <div className="dps-result" data-status={report.status} data-testid="poi-sources-result">
      <div className="dps-result-head">
        <h4 className="dps-result-title">
          {report.status === 'available' ? '附近公开资料候选' : '公开资料结果'}
          {stationName ? ` · 按「${stationName}」记录坐标` : ''}
        </h4>
        <span className="dps-tag" data-testid="poi-sources-status-tag">
          {poiStatusText(report.status)}
        </span>
      </div>

      {stale ? (
        <p className="dps-notice" role="status" data-testid="poi-sources-stale">
          {STALE_NOTICE}
        </p>
      ) : null}

      {report.status === 'available' ? (
        <>
          {report.cached ? (
            <p className="dps-hint" data-testid="poi-sources-cached">
              这份结果来自服务端的近期缓存，下面的获取时间是缓存里保存的原时间，不是这次点击的时间。
            </p>
          ) : null}
          <ol className="dps-candidates">
            {report.candidates.map((candidate) => (
              <CandidateItem key={`${candidate.element_type}-${candidate.element_id}`} candidate={candidate} />
            ))}
          </ol>
          {report.notes.length > 0 ? (
            <p className="dps-hint" data-testid="poi-sources-notes">
              来源处理说明：{report.notes.join('；')}
            </p>
          ) : null}
        </>
      ) : report.status === 'no_candidates' ? (
        <p className="dps-notice" role="status">
          {NO_CANDIDATES_TEXT}
        </p>
      ) : (
        <p className="dps-notice" role="status">
          {poiStatusText(report.status)}：{STATUS_EXPLAIN[report.status]}
        </p>
      )}

      <dl className="dps-facts">
        <div>
          <dt>数据来源</dt>
          <dd>
            {report.source.provider}（{report.source.data_source}）
          </dd>
        </div>
        <div>
          <dt>查询发起时间</dt>
          <dd>{formatPoiTimestamp(report.checked_at)}</dd>
        </div>
        <div>
          <dt>本次获取时间</dt>
          <dd>{formatPoiTimestamp(report.fetched_at)}</dd>
        </div>
        <div>
          <dt>请求坐标</dt>
          <dd>
            {formatPoiCoordinate(report.requested?.lat ?? Number.NaN)},{' '}
            {formatPoiCoordinate(report.requested?.lon ?? Number.NaN)}（WGS84，按行程记录查询，未核验）
          </dd>
        </div>
        <div>
          <dt>查询半径</dt>
          <dd>{formatPoiDistance(report.radius_m)}</dd>
        </div>
        <div>
          <dt>候选身份</dt>
          <dd>全部为公开资料候选，身份未确认（unconfirmed）</dd>
        </div>
      </dl>
    </div>
  )
}

const STATUS_EXPLAIN: Record<string, string> = {
  invalid_request: '这次查询的坐标没有被服务接受。',
  timeout: '服务这次等待超时。',
  rate_limited: '请求过于频繁，稍后再试。',
  unavailable: '服务暂时不可用。',
  failed: '服务响应异常。',
}

function CandidateItem({ candidate }: { candidate: PoiSourceCandidate }) {
  return (
    <li className="dps-candidate">
      <p className="dps-candidate-name">
        {candidate.name ?? '（来源未提供名称）'}
        <span className="dps-candidate-distance">距离约 {formatPoiDistance(candidate.distance_m)}</span>
      </p>
      <p className="dps-candidate-meta">
        <a
          href={osmObjectUrl(candidate.element_type, candidate.element_id)}
          target="_blank"
          rel="noopener noreferrer"
        >
          OSM 对象（{candidate.element_type}）
        </a>
        <span className="dps-tag dps-tag-unconfirmed">身份未确认</span>
      </p>
      <dl className="dps-candidate-tags">
        <div>
          <dt>opening_hours</dt>
          <dd>{tagFieldText(candidate.opening_hours)}</dd>
        </div>
        <div>
          <dt>fee</dt>
          <dd>{tagFieldText(candidate.fee)}</dd>
        </div>
        <div>
          <dt>charge</dt>
          <dd>{tagFieldText(candidate.charge)}</dd>
        </div>
        <div>
          <dt>来源获取时间</dt>
          <dd>{formatPoiTimestamp(candidate.retrieved_at)}</dd>
        </div>
        <div>
          <dt>对象编辑时间</dt>
          <dd>
            {candidate.source_updated_at
              ? formatPoiTimestamp(candidate.source_updated_at)
              : '未知（来源未提供）'}
          </dd>
        </div>
      </dl>
      <p className="dps-hint">
        标签值是 OSM 贡献者写的原文，只说明地图上记录了什么，不等于实时营业状态、
        不证明免费或包含票价；原文超过来源长度上限时显示为未知。
      </p>
    </li>
  )
}

function Attribution({ report }: { report: PoiSourceReport | null }) {
  return (
    <p className="dps-attribution" data-testid="poi-sources-attribution">
      数据 ©{' '}
      <a
        href={report?.source.attribution_url ?? 'https://www.openstreetmap.org/copyright'}
        target="_blank"
        rel="noopener noreferrer"
      >
        OpenStreetMap 贡献者
      </a>
      {' · '}
      <a
        href={report?.source.docs_url ?? 'https://wiki.openstreetmap.org/wiki/Overpass_API'}
        target="_blank"
        rel="noopener noreferrer"
      >
        Overpass API 说明
      </a>
      {report ? ` · 许可：${report.source.license}` : ' · 许可：ODbL 1.0'}
    </p>
  )
}

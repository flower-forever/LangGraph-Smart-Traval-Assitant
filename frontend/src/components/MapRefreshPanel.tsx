/**
 * 单日「仅刷新地图」面板（不接 App，由父级显式接线）。
 *
 * 边界：
 * - 只更新站点坐标与相邻路线；原地址、时间、说明、提醒都不改写。
 * - 打开、换日、改出行方式都不发请求；用户点「获取地图候选」才发一次。
 * - 不生成 UUID、不写存储、不 setTrip；onApply 是唯一入口，由父级用最新
 *   trip / revision 落地，面板只按同步返回结果显示成功或失败。
 * - 不调用模型，AI 规划是否可用都不影响这里。
 * - AbortController + 单调 seq：换日、改模式、停止、关闭、卸载都清候选并作废迟到响应。
 * - 候选与请求绑定快照（trip 对象、revision、day、mode），渲染时同步核对，
 *   不等 effect 才隐藏旧结果。
 */
import { useEffect, useId, useRef, useState } from 'react'

import type { ApiError, RouteType, Trip, TripDay, TripLocation, TravelMode } from '../lib/api'
import {
  buildMapRefreshRequest,
  previewMapRefresh,
  type MapRefreshApplyResult,
  type MapRefreshPreviewResult,
  type MapRefreshRequest,
  type MapRefreshResponse,
} from '../lib/mapRefresh'
import { refreshDayMap, type MapRefreshAdapter } from '../lib/mapRefreshApi'
import './mapRefreshPanel.css'

export type { MapRefreshAdapter }

export interface MapRefreshPanelProps {
  /** 当前页面显示的行程；面板只读，不修改。 */
  trip: Trip
  /** 要刷新的那一天；其他天不显示也不参与。 */
  day: TripDay | null
  /** 父级页面版本号；候选的取得与应用都以它为准。 */
  revision: number
  /** 行程来自导入文件：只用于说明来源标签不会被改写。 */
  openedFromFile?: boolean
  /** 异步请求 adapter，默认走 mapRefreshApi.refreshDayMap；测试注入 mock。 */
  requestMap?: MapRefreshAdapter
  /** 用户显式点击「应用地图更新」时调用；父级负责用最新快照 apply。 */
  onApply: (request: MapRefreshRequest, response: MapRefreshResponse) => MapRefreshApplyResult
  /** 关闭面板：放弃候选，不改旧行程。 */
  onClose: () => void
}

type PanelError = { kind: 'build' | 'network' | 'server' | 'timeout' | 'bad_payload' | 'stopped'; message: string }

interface Snapshot {
  trip: Trip
  revision: number
  dayNumber: number
  mode: TravelMode
}

interface Candidate {
  request: MapRefreshRequest
  response: MapRefreshResponse
  preview: MapRefreshPreviewResult
  snapshot: Snapshot
}

/** 这些状态说明服务端这次没拿到可用地图数据：没有可应用内容，禁止应用。 */
const HARD_STATUSES: ReadonlySet<string> = new Set<string>(['unavailable', 'no_key', 'timeout', 'failed'])

const HARD_STATUS_TEXT: Record<string, string> = {
  no_key: '地图服务未配置，这次没有取得坐标和路线。站点的文字安排保持不变，配置好后可以再刷新。',
  timeout: '获取地图数据超时，这次没有取得坐标和路线。站点的文字安排保持不变。',
  failed: '获取地图数据失败，这次没有取得坐标和路线。站点的文字安排保持不变，稍后可以再试。',
  unavailable: '这一天没有可用的坐标，这次没有可应用的地图数据。站点的文字安排保持不变。',
}

const ROUTE_TEXT: Record<RouteType, string> = {
  navigation: '导航路线',
  straight_line: '直线估测（非导航）',
  unavailable: '路线待获取',
}

const APPLY_FAILED_TEXT =
  '这次没有应用成功：页面上的行程可能已经变化，或者保存空间不足。当前行程保持不变，请关闭面板后重新打开再试。'

const PREVIEW_FAILED_TEXT =
  '这次返回的地图数据和当前页面上的行程对不上，可能是页面上的行程刚改过。旧行程没有变动，请关闭面板后重新打开再试。'

function formatTime(value: string | null): string {
  return value ?? '时间待定'
}

function formatDistance(value: number | null): string {
  if (value === null) return '未知'
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${value} m`
}

function formatDuration(value: number | null): string {
  return value === null ? '未知' : `${value} 分钟`
}

function formatLocation(value: TripLocation | null): string {
  return value === null ? '缺少坐标' : `${value.lng.toFixed(5)}, ${value.lat.toFixed(5)}`
}

function modeLabel(mode: TravelMode): string {
  return mode === 'walking' ? '步行' : '驾车'
}

function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && (err as { kind?: unknown }).kind !== undefined
}

/** 站点两两相邻的段（端点顺序即行走顺序）。 */
function adjacentPairs(stops: TripDay['stops']): Array<{ from: TripDay['stops'][number]; to: TripDay['stops'][number] }> {
  const pairs: Array<{ from: TripDay['stops'][number]; to: TripDay['stops'][number] }> = []
  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index]
    const to = stops[index + 1]
    if (from && to) pairs.push({ from, to })
  }
  return pairs
}

function pairKey(fromStopId: string, toStopId: string): string {
  return `${fromStopId}->${toStopId}`
}

export default function MapRefreshPanel({
  trip,
  day,
  revision,
  openedFromFile = false,
  requestMap,
  onApply,
  onClose,
}: MapRefreshPanelProps) {
  const baseId = useId()
  const modeHintId = `${baseId}-mode-hint`
  const modeErrorId = `${baseId}-mode-error`
  const statsHintId = `${baseId}-stats-hint`

  const [mode, setMode] = useState<TravelMode | ''>('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [showAllWarnings, setShowAllWarnings] = useState(false)

  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // 换日：出行方式必须重新明确选择，不沿用上一天，也不从旧 leg 里猜。
  useEffect(() => {
    setMode('')
  }, [day])

  // trip 对象 / revision / day / mode 变化：abort 在途请求并作废候选。
  useEffect(() => {
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setCandidate(null)
    setError(null)
    setApplyError(null)
    setShowAllWarnings(false)
    return () => {
      seqRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [trip, revision, day, mode])

  const dayNumber = day ? day.day : -1
  const selectedMode = mode

  function stopWaiting() {
    // 只结束本页面的等待：seq 递增 + abort，迟到的结果一律丢弃。
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setError({
      kind: 'stopped',
      message: '已停止等待，本次没有取得候选。这里只结束页面上的等待，不保证服务端已经停止处理。',
    })
  }

  async function handleFetch() {
    if (!day || selectedMode === '' || pending) return
    const built = buildMapRefreshRequest(trip, day.day, {
      travel_mode: selectedMode,
      parentRevision: revision,
    })
    if (!built.ok) {
      setError({ kind: 'build', message: built.message })
      return
    }
    const snapshot: Snapshot = { trip, revision, dayNumber: day.day, mode: selectedMode }
    const seq = seqRef.current + 1
    seqRef.current = seq
    const controller = new AbortController()
    abortRef.current = controller
    setPending(true)
    setError(null)
    setApplyError(null)
    setCandidate(null)
    setShowAllWarnings(false)
    try {
      const response = await (requestMap ?? refreshDayMap)(built.request, { signal: controller.signal })
      if (seqRef.current !== seq || controller.signal.aborted) return
      // 候选与本面板当前快照绑定：预览用的就是这次请求的 baseTrip / revision。
      const preview = previewMapRefresh({
        baseTrip: trip,
        request: built.request,
        response,
        currentRevision: revision,
      })
      if (seqRef.current !== seq || controller.signal.aborted) return
      setCandidate({ request: built.request, response, preview, snapshot })
    } catch (err) {
      if (seqRef.current !== seq || controller.signal.aborted) return
      if (isApiError(err)) {
        switch (err.kind) {
          case 'timeout':
            setError({
              kind: 'timeout',
              message: '等待地图服务超时，这次没有取得候选。旧行程没有改动，稍后可以再试。',
            })
            break
          case 'abort':
            setError({ kind: 'stopped', message: '已停止等待，本次没有取得候选。' })
            break
          case 'network':
            setError({
              kind: 'network',
              message: '连接不上后端服务，这次没有取得候选。旧行程没有改动，请确认服务已启动后再试。',
            })
            break
          case 'server':
            setError({
              kind: 'server',
              message:
                err.status === 503
                  ? '地图服务暂时不可用，这次没有取得候选。站点的文字安排不变，稍后可以再试。'
                  : '地图请求处理失败，这次没有取得候选。旧行程没有改动，稍后可以再试。',
            })
            break
          case 'bad_payload':
            setError({
              kind: 'bad_payload',
              message: '返回的地图数据不完整，这次没有取得候选。旧行程没有改动，可以再试一次。',
            })
            break
        }
      } else {
        setError({ kind: 'network', message: '获取地图候选时出现问题，这次没有取得候选。旧行程没有改动。' })
      }
    } finally {
      if (seqRef.current === seq) {
        setPending(false)
        abortRef.current = null
      }
    }
  }

  // 渲染时同步核对快照：context 一变，旧候选立刻不显示，不等 effect。
  const live =
    candidate !== null &&
    candidate.snapshot.trip === trip &&
    candidate.snapshot.revision === revision &&
    candidate.snapshot.dayNumber === dayNumber &&
    candidate.snapshot.mode === mode
      ? candidate
      : null

  const hardStatus = live !== null && HARD_STATUSES.has(live.response.map_status) ? live.response.map_status : null
  const preview = live !== null && live.preview.ok && hardStatus === null ? live.preview : null
  const previewFailed = live !== null && !live.preview.ok && hardStatus === null
  const canApply = preview !== null && preview.changed && !pending

  function handleApply() {
    if (!live || !canApply) return
    const result = onApply(live.request, live.response)
    if (result.ok) {
      // 成功由父级关闭面板并替换行程；这里不改状态、不重复提示。
      return
    }
    setApplyError(APPLY_FAILED_TEXT)
  }

  if (!day) {
    return (
      <section className="mrp" aria-label="仅刷新地图">
        <div className="mrp-head">
          <div className="mrp-head-main">
            <h3 className="mrp-title">仅刷新地图</h3>
          </div>
          <button type="button" className="mrp-btn" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="mrp-notice">当前没有可刷新的这一天，原始行程保持不变。</p>
      </section>
    )
  }

  const dayTitle = `第 ${day.day} 天${day.date ? `（${day.date}）` : ''}：${day.title || '当日安排'}`
  const resolvedById = new Map(live ? live.response.stops.map((stop) => [stop.id, stop]) : [])
  const unresolvedById = new Map(live ? live.response.unresolved.map((item) => [item.id, item]) : [])
  const oldLegs = new Map(day.legs.map((leg) => [pairKey(leg.from_stop_id, leg.to_stop_id), leg]))
  const newLegs = new Map(live ? live.response.legs.map((leg) => [pairKey(leg.from_stop_id, leg.to_stop_id), leg]) : [])
  const pairs = adjacentPairs(day.stops)
  const warnings = preview ? preview.warnings : []
  const visibleWarnings = showAllWarnings ? warnings : warnings.slice(0, 3)
  const hiddenWarningCount = warnings.length - visibleWarnings.length
  const notices = preview ? preview.notices : []

  return (
    <section className="mrp" aria-label="仅刷新地图">
      <div className="mrp-head">
        <div className="mrp-head-main">
          <p className="mrp-eyebrow">只更新坐标与路线，其余内容原样保留</p>
          <h3 className="mrp-title">仅刷新地图</h3>
          <p className="mrp-meta">
            <span className="mrp-tag">{dayTitle}</span>
            <span>{trip.title}</span>
            {pending ? (
              <span className="mrp-tag" role="status">
                正在获取地图候选…
              </span>
            ) : null}
          </p>
        </div>
        <button type="button" className="mrp-btn" onClick={onClose}>
          关闭
        </button>
      </div>

      <p className="mrp-intro">
        这次只更新站点坐标和相邻路线。原有的地址、时间、说明都保留不动，其他天也不受影响。
        {openedFromFile ? '导入来源的标记同样不变。' : ''}
      </p>

      <fieldset className="mrp-form" disabled={pending}>
        <legend className="mrp-form-legend">这一天的出行方式</legend>
        <p className="mrp-hint" id={modeHintId}>
          路线是按出行方式估算的，请先明确选一项，再获取候选。没有选择时不会发起请求。
        </p>
        <div className="mrp-modes">
          <label className="mrp-mode">
            <input
              type="radio"
              name={`${baseId}-mode`}
              value="walking"
              checked={mode === 'walking'}
              onChange={() => setMode('walking')}
              aria-describedby={mode === '' ? modeErrorId : undefined}
            />
            <span>步行</span>
          </label>
          <label className="mrp-mode">
            <input
              type="radio"
              name={`${baseId}-mode`}
              value="driving"
              checked={mode === 'driving'}
              onChange={() => setMode('driving')}
              aria-describedby={mode === '' ? modeErrorId : undefined}
            />
            <span>驾车</span>
          </label>
        </div>
        <p className="mrp-hint" id={modeErrorId}>
          行程里一段步行一段驾车时，这里也只选一种：候选会按同一方式重算这一天的相邻路线。
        </p>
        <p className="mrp-hint">
          站点缺少坐标也可以刷新，这正是它的用途；服务会重新解析站点的位置。
        </p>
      </fieldset>

      <div className="mrp-actions">
        <button
          type="button"
          className="mrp-btn mrp-btn-primary"
          onClick={handleFetch}
          disabled={pending || mode === ''}
        >
          {pending ? '正在获取…' : '获取地图候选'}
        </button>
        {pending ? (
          <button type="button" className="mrp-btn" onClick={stopWaiting}>
            停止等待
          </button>
        ) : null}
        <span className="mrp-hint">一次只发一个请求；候选取到后不会自动保存。</span>
      </div>

      {error ? (
        <p className="mrp-error" role="alert">
          {error.message}
        </p>
      ) : null}

      {pending ? (
        <p className="mrp-status" role="status">
          正在向地图服务请求这一天的坐标与路线。等待可以随时停止，停止后旧行程完全不变。
        </p>
      ) : null}

      {live && hardStatus ? (
        <div className="mrp-block">
          <p className="mrp-notice" role="status">
            {HARD_STATUS_TEXT[hardStatus] ?? '这次没有取得可用的地图数据，旧行程保持不变。'}
          </p>
          {live.response.unresolved.length > 0 ? (
            <details className="mrp-details">
              <summary>未解析出位置的站点（{live.response.unresolved.length} 个）</summary>
              <ul className="mrp-list">
                {live.response.unresolved.map((item) => (
                  <li key={item.id} className="mrp-stop">
                    <span className="mrp-stop-name">{item.id}</span>
                    <span className="mrp-hint">{item.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <p className="mrp-hint">这种情况下没有可应用的内容，旧行程保持不变。</p>
        </div>
      ) : null}

      {previewFailed ? (
        <p className="mrp-notice" role="alert">
          {PREVIEW_FAILED_TEXT}
        </p>
      ) : null}

      {preview ? (
        <div className="mrp-result">
          <h4 className="mrp-section-title">这次取得的内容</h4>
          <dl className="mrp-stats" aria-describedby={statsHintId}>
            <div className="mrp-stat">
              <dt>站点坐标</dt>
              <dd>
                本次更新 {preview.points.refreshed} 个（新增 {preview.points.added}、改写{' '}
                {preview.points.updated}），{preview.points.unchanged} 个与现在相同，{preview.points.notReturned}{' '}
                个未返回、沿用原值。
              </dd>
            </div>
            <div className="mrp-stat">
              <dt>相邻路线</dt>
              <dd>
                {preview.legs.refreshed} 段用本次新路线，{preview.legs.retained} 段沿用旧路线（本次未重算），
                {preview.legs.invalidated} 段旧数据已失效、等待重新获取。
              </dd>
            </div>
            <div className="mrp-stat">
              <dt>本日提醒</dt>
              <dd>
                本次取回 {preview.warningStats.newWarningCount} 条，显示 {preview.warningStats.keptNewWarnings}{' '}
                条；另有 {preview.omittedWarnings} 条本次未显示。
              </dd>
            </div>
          </dl>
          <p className="mrp-hint" id={statsHintId}>
            「本次取得」说的是从服务取回的数量，不代表行程里有这么多坐标真的变了。
          </p>

          {preview.changed ? null : (
            <p className="mrp-notice" role="status">
              这次取得的数据和现在的行程一致，没有可应用的变化：可能本来就有相同的坐标与路线，也可能服务这次没给新数据。旧行程保持不变。
            </p>
          )}

          {notices.length > 0 ? (
            <ul className="mrp-list">
              {notices.map((notice, index) => (
                <li key={`notice-${index}`} className="mrp-hint">
                  {notice}
                </li>
              ))}
            </ul>
          ) : null}

          {warnings.length > 0 ? (
            <div className="mrp-block">
              <h5 className="mrp-sub-title">本日提醒（{warnings.length} 条）</h5>
              <ul className="mrp-list">
                {visibleWarnings.map((warning, index) => (
                  <li key={`warning-${index}`}>{warning}</li>
                ))}
              </ul>
              {hiddenWarningCount > 0 ? (
                <button type="button" className="mrp-btn mrp-btn-ghost" onClick={() => setShowAllWarnings(true)}>
                  再展开 {hiddenWarningCount} 条
                </button>
              ) : null}
            </div>
          ) : null}

          <h4 className="mrp-section-title">站点坐标对照</h4>
          <ul className="mrp-list">
            {day.stops.map((stop) => {
              const resolved = resolvedById.get(stop.id)
              const unresolved = unresolvedById.get(stop.id)
              return (
                <li key={stop.id} className="mrp-stop">
                  <div className="mrp-stop-head">
                    <span className="mrp-stop-name">{stop.name || '未命名站点'}</span>
                    <span className="mrp-hint">{formatTime(stop.time)}</span>
                  </div>
                  <dl className="mrp-kv">
                    <div className="mrp-kv-row">
                      <dt>原坐标</dt>
                      <dd>{formatLocation(stop.location)}</dd>
                    </div>
                    <div className="mrp-kv-row">
                      <dt>候选坐标</dt>
                      <dd>
                        {resolved ? formatLocation(resolved.location) : '本次未返回坐标，沿用原值'}
                      </dd>
                    </div>
                    <div className="mrp-kv-row">
                      <dt>原地址</dt>
                      <dd>{stop.address || '未填写'}</dd>
                    </div>
                    <div className="mrp-kv-row">
                      <dt>解析地址</dt>
                      <dd>
                        {resolved && resolved.resolved_address ? (
                          <>
                            {resolved.resolved_address}
                            <span className="mrp-hint">（仅展示，不回写到原地址，也不代表实地已核验）</span>
                          </>
                        ) : (
                          '本次没有解析地址'
                        )}
                      </dd>
                    </div>
                  </dl>
                  {unresolved ? <p className="mrp-hint">未取得位置：{unresolved.reason}</p> : null}
                </li>
              )
            })}
          </ul>

          <h4 className="mrp-section-title">相邻路线对照</h4>
          {pairs.length === 0 ? (
            <p className="mrp-hint">这一天只有一个站点或没有站点，没有相邻路线需要对照。</p>
          ) : (
            <ul className="mrp-list">
              {pairs.map(({ from, to }) => {
                const key = pairKey(from.id, to.id)
                const oldLeg = oldLegs.get(key)
                const newLeg = newLegs.get(key)
                return (
                  <li key={key} className="mrp-pair">
                    <div className="mrp-stop-head">
                      <span className="mrp-stop-name">
                        {from.name || '未命名站点'} → {to.name || '未命名站点'}
                      </span>
                      <span className="mrp-hint">{oldLeg ? modeLabel(oldLeg.mode) : '方式未记录'}</span>
                    </div>
                    <dl className="mrp-kv">
                      <div className="mrp-kv-row">
                        <dt>旧路线</dt>
                        <dd>
                          {oldLeg
                            ? `${ROUTE_TEXT[oldLeg.route_type]}，${formatDistance(oldLeg.distance_m)}，${formatDuration(oldLeg.duration_minutes)}`
                            : '暂无路线数据'}
                        </dd>
                      </div>
                      <div className="mrp-kv-row">
                        <dt>候选路线</dt>
                        <dd>
                          {newLeg
                            ? `${ROUTE_TEXT[newLeg.route_type]}，${formatDistance(newLeg.distance_m)}，${formatDuration(newLeg.duration_minutes)}`
                            : '本次未返回，沿用旧路线（本次未重算）'}
                        </dd>
                      </div>
                    </dl>
                    {newLeg && newLeg.route_type === 'unavailable' ? (
                      <p className="mrp-hint">这一段本次没取到路线，沿旧路线显示，标注为本次未重算。</p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}

          <div className="mrp-actions">
            <button
              type="button"
              className="mrp-btn mrp-btn-primary"
              onClick={handleApply}
              disabled={!canApply}
            >
              应用地图更新
            </button>
            {preview.changed ? null : <span className="mrp-hint">没有变化时不提供应用按钮。</span>}
          </div>

          {applyError ? (
            <p className="mrp-error" role="alert">
              {applyError}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="mrp-foot">
        这里不会自动保存，也不改动行程的来源、预算和别的字段。导航耗时是本次服务估算，不保证出行当天的实际交通；
        「直线估测」不是导航路线。
      </p>
    </section>
  )
}

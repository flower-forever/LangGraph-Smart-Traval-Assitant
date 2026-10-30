/**
 * 本日天气查询面板（独立信封，不接 Trip v1）。
 *
 * 边界：
 * - 只在用户点「查询天气」时请求一次；挂载、切天、换站点、改日期都不发请求，也不自动重试。
 * - 坐标只取本日行程记录里带 WGS84 坐标的站点；0 / 负坐标是合法值。
 *   本日没有坐标就禁用查询，不改用其它天、浏览器定位或按城市猜。
 * - day.date 合法时作为初值；不合法就空着，要求用户自己选日期，不默认今天。
 * - 查询进行中可停止等待。停止 / 关闭 / 切换行程 / revision / 站点 / 日期都会
 *   递增序号并 abort，迟到的响应一律丢弃。停止只结束本页等待，不保证后端停止处理。
 * - 结果只存在组件内存：不写 Trip、不写 localStorage、不改地图或预算。
 * - 非 available 或传输失败时清掉旧结果，绝不让上一次成功的天气冒充本次。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { ApiError, Trip, TripDay } from '../lib/api'
import {
  OPEN_METEO_ATTRIBUTION_URL,
  OPEN_METEO_DOCS_URL,
  collectWeatherStations,
  formatCoverage,
  formatUtcOffset,
  formatWeatherMetric,
  formatWeatherTimestamp,
  initialWeatherDate,
  isCalendarDate,
  readWeatherField,
  validateWeatherDayReport,
  weatherCodeText,
  type WeatherDayForecast,
  type WeatherDayQuery,
  type WeatherDayReport,
  type WeatherField,
} from '../lib/weather'
import { fetchDayWeather, type WeatherAdapter } from '../lib/weatherApi'
import './dayWeatherPanel.css'

export interface DayWeatherPanelProps {
  /** 当前页面正在显示的行程；面板只读，不修改。 */
  trip: Trip
  /** 当前日；null 表示当前没有可显示的一天。 */
  day: TripDay | null
  /** 父级页面的行程版本号；变化即作废旧结果。 */
  revision: number
  /** 当前行程来自导入文件：只影响坐标来源标识，不影响查询。 */
  openedFromFile?: boolean
  /** 异步请求 adapter，默认走 weatherApi.fetchDayWeather；测试注入 mock。 */
  requestWeather?: WeatherAdapter
  /** 收起面板：只停止等待与清结果，不改行程。 */
  onClose?: () => void
}

type PanelErrorKind =
  | 'no_station'
  | 'missing_date'
  | 'invalid_date'
  | 'timeout'
  | 'network'
  | 'server'
  | 'abort'
  | 'bad_payload'

interface PanelError {
  kind: PanelErrorKind
  message: string
}

interface WeatherResultEntry {
  report: WeatherDayReport
  stationId: string
  stationName: string
  date: string
  dayNumber: number
  tripId: string
  revision: number
}

const FIELD_LABELS: Record<WeatherField, string> = {
  temperature_2m_max: '最高温',
  temperature_2m_min: '最低温',
  precipitation_probability_max: '降水概率',
  precipitation_sum: '降水量',
  wind_speed_10m_max: '最大风速',
  weather_code: '天气类型',
}

/** 失败文案全部用前端固定句，不复述 provider / 后端原文 */
const ERROR_TEXT: Record<PanelErrorKind, string> = {
  no_station: '本日没有可用的记录坐标，无法查询天气。',
  missing_date: '请先选择要查询的日期。',
  invalid_date: '查询日期不是合法的日历日，请重新选择。',
  timeout: '等待天气服务响应超时。这次没有拿到结果，可以重新点「查询天气」再试一次。',
  network: '连不上后端服务，本次没有拿到天气。请确认后端已启动后再试。',
  server: '天气查询请求失败，这次没有拿到结果，可以稍后再试。',
  abort: '已停止等待这次天气查询，本次结果不展示。',
  bad_payload: '返回的天气数据没有通过完整性检查，本次结果没有展示。',
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
            ? '天气服务暂时不可用，本次没有拿到结果。天气查询是独立功能，行程其它部分不受影响；可以稍后再试。'
            : err.status === 422
              ? '这次查询的日期或坐标没有被天气服务接受，请核对后重试。'
              : ERRORS_SERVER_FALLBACK(err.status),
      }
    case 'network':
      return { kind: 'network', message: ERROR_TEXT.network }
    case 'bad_payload':
      return { kind: 'bad_payload', message: ERROR_TEXT.bad_payload }
  }
}

function ERRORS_SERVER_FALLBACK(status: number | undefined): string {
  return `天气查询请求失败（HTTP ${status ?? '未知'}），这次没有拿到结果，可以稍后再试。`
}

/** 后端状态字段对应的固定说明；不复述 reason 原文 */
const STATUS_TEXT: Record<Exclude<WeatherDayReport['status'], 'available'>, string> = {
  out_of_range: '所选日期不在来源当前覆盖范围内。',
  invalid_request: '这次查询参数没有被天气服务接受，请核对日期与坐标。',
  timeout: '天气服务这次等待超时，没有返回预报。',
  unavailable: '天气服务暂时不可用，没有返回预报。',
  failed: '天气服务这次没有返回可用的预报数据。',
}

const NETWORK_NOTE =
  '天气结果只在本页内存里，不写进行程或本地保存，也不改地图与预算。'

function dayDate(day: TripDay | null): string | null {
  return day ? initialWeatherDate(day.date) || null : null
}

export default function DayWeatherPanel({
  trip,
  day,
  revision,
  openedFromFile = false,
  requestWeather,
  onClose,
}: DayWeatherPanelProps) {
  const stationSelectId = useId()
  const dateInputId = useId()
  const dateHelpId = `${dateInputId}-help`

  const stations = useMemo(() => collectWeatherStations(day), [day])
  const stationsKey = stations.map((s) => s.stopId).join('|')

  const [stationId, setStationId] = useState<string>(() => stations[0]?.stopId ?? '')
  const [date, setDate] = useState<string>(() => dayDate(day) ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)
  const [entry, setEntry] = useState<WeatherResultEntry | null>(null)

  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  // 行程 / revision / 当天 / 站点集合变化：作废在途请求与旧结果，回到这一天自己的初值。
  // stationsKey 用稳定字符串，避免每次渲染的新数组触发重置。
  useEffect(() => {
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    setError(null)
    setEntry(null)
    setStationId(stations[0]?.stopId ?? '')
    setDate(dayDate(day) ?? '')
    return () => {
      seqRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip, revision, day, stationsKey])

  const station = stations.find((s) => s.stopId === stationId) ?? stations[0] ?? null
  const dateValid = isCalendarDate(date)
  const canQuery = Boolean(day) && stations.length > 0 && station !== null && dateValid && !pending

  /**
   * 只展示与当前行程 / revision / 站点 / 日期完全一致的结果。
   * 这样即使 effect 还没跑，改选日期或站点后也看不到旧结果。
   */
  const currentEntry =
    entry &&
    entry.tripId === trip.id &&
    entry.revision === revision &&
    entry.dayNumber === day?.day &&
    entry.stationId === station?.stopId &&
    entry.date === date
      ? entry
      : null
  const report = currentEntry?.report ?? null
  const currentStationName = currentEntry?.stationName ?? station?.name ?? ''

  function stopWaiting(markAbort: boolean) {
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setPending(false)
    if (markAbort) setError({ kind: 'abort', message: ERROR_TEXT.abort })
  }

  function handleClose() {
    stopWaiting(false)
    onClose?.()
  }

  async function handleQuery() {
    if (pending) return
    if (!day) return
    if (!station) {
      setError({ kind: 'no_station', message: ERROR_TEXT.no_station })
      return
    }
    if (!date) {
      setError({ kind: 'missing_date', message: ERROR_TEXT.missing_date })
      return
    }
    if (!isCalendarDate(date)) {
      setError({ kind: 'invalid_date', message: ERROR_TEXT.invalid_date })
      return
    }

    const query: WeatherDayQuery = { lat: station.lat, lon: station.lon, date }
    const seq = seqRef.current + 1
    seqRef.current = seq
    const controller = new AbortController()
    abortRef.current = controller
    setPending(true)
    setError(null)
    setEntry(null)

    try {
      const response = await (requestWeather ?? fetchDayWeather)(query, {
        signal: controller.signal,
      })
      if (seqRef.current !== seq || controller.signal.aborted) return
      // 展示前再核对一次：adapter 可能被替换，不能假设它已经校验过。
      const validated = validateWeatherDayReport(response, query)
      if (!validated.ok) {
        setError({ kind: 'bad_payload', message: ERROR_TEXT.bad_payload })
        return
      }
      setEntry({
        report: validated.report,
        stationId: station.stopId,
        stationName: station.name,
        date,
        dayNumber: day.day,
        tripId: trip.id,
        revision,
      })
    } catch (err) {
      if (seqRef.current !== seq || controller.signal.aborted) return
      if (isApiError(err)) {
        setError(errorForApi(err))
      } else {
        setError({
          kind: 'network',
          message: '查询天气时出现问题，本次没有拿到结果。行程没有因此改动，可以再试一次。',
        })
      }
    } finally {
      if (seqRef.current === seq) {
        setPending(false)
        abortRef.current = null
      }
    }
  }

  if (!day) {
    return (
      <section className="dwp" aria-label="本日天气查询">
        <div className="dwp-head">
          <div className="dwp-head-main">
            <p className="dwp-eyebrow">独立天气查询</p>
            <h3 className="dwp-title">天气查询</h3>
          </div>
          <button type="button" className="dwp-btn" onClick={handleClose}>
            收起
          </button>
        </div>
        <p className="dwp-notice" role="note">
          当前行程里没有可显示的这一天，无法查询天气。行程内容保持不变。
        </p>
        <Attribution license={null} docsUrl={null} attributionUrl={null} />
      </section>
    )
  }

  const exampleCoordinate = trip.source === 'example'

  return (
    <section className="dwp" aria-label="本日天气查询" aria-busy={pending || undefined} data-testid="weather-panel">
      <div className="dwp-head">
        <div className="dwp-head-main">
          <p className="dwp-eyebrow">独立天气查询 · 不写行程</p>
          <h3 className="dwp-title">
            第 {day.day} 天{day.date ? ` · ${day.date}` : ''} 天气
          </h3>
          <p className="dwp-meta-line">
            {trip.title}
            {day.title ? ` · ${day.title}` : ''}
            {pending ? (
              <span className="dwp-tag" role="status">
                正在查询…
              </span>
            ) : null}
          </p>
        </div>
        <button type="button" className="dwp-btn" onClick={handleClose}>
          收起
        </button>
      </div>

      <p className="dwp-note">
        按行程记录坐标查询：只用本日站点记录里的 WGS84 坐标，不用浏览器定位、不按城市猜，也不去其它天找坐标。
        这些坐标来自行程记录，未做地理编码，也不代表站点精确位置。
        {exampleCoordinate ? <span className="dwp-badge">示例位置</span> : null}
        {openedFromFile ? <span className="dwp-badge">导入文件记录</span> : null}
      </p>

      {stations.length === 0 ? (
        <>
          <p className="dwp-empty" role="note">
            本日没有带 WGS84 坐标的站点记录，无法查询天气。可以回到行程里补充坐标，或换一个本日自带坐标的行程；
            这里不会改用其它天、浏览器位置或按城市推测的坐标。
          </p>
          <div className="dwp-actions">
            <button type="button" className="dwp-btn dwp-btn-primary" disabled>
              查询天气
            </button>
            <p className="dwp-hint">本日没有可用坐标，查询已禁用。</p>
          </div>
        </>
      ) : (
        <div className="dwp-form">
          <div className="dwp-field">
            <label htmlFor={stationSelectId}>按哪条记录坐标查询</label>
            <select
              id={stationSelectId}
              value={station?.stopId ?? ''}
              onChange={(event) => setStationId(event.target.value)}
              disabled={pending}
            >
              {stations.map((option) => (
                <option key={option.stopId} value={option.stopId}>
                  {option.name} · {formatCoord(option.lat)}, {formatCoord(option.lon)}
                </option>
              ))}
            </select>
            {station ? (
              <p className="dwp-hint">
                本次将按「{station.name}」的记录坐标查询：纬度 {formatCoord(station.lat)}，经度{' '}
                {formatCoord(station.lon)}（WGS84）。
              </p>
            ) : null}
          </div>

          <div className="dwp-field">
            <label htmlFor={dateInputId}>查询日期</label>
            <input
              id={dateInputId}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              disabled={pending}
              aria-invalid={date !== '' && !dateValid ? true : undefined}
              aria-describedby={!date || !dateValid ? dateHelpId : undefined}
            />
            <p id={dateHelpId} className="dwp-hint">
              {!date
                ? '请选择要查询的日期：没有用今天代替行程里的出行日。'
                : !dateValid
                  ? '这个日期不是合法的日历日，请重新选择。'
                  : '默认取这一天的 date 字段；也可以改成你关心的其它日期。'}
            </p>
          </div>

          <div className="dwp-actions">
            <button
              type="button"
              className="dwp-btn dwp-btn-primary"
              onClick={() => {
                void handleQuery()
              }}
              disabled={!canQuery}
            >
              查询天气
            </button>
            {pending ? (
              <button type="button" className="dwp-btn" onClick={() => stopWaiting(true)}>
                停止等待
              </button>
            ) : null}
            <p className="dwp-hint dwp-request-hint">
              只有点这一次按钮才会请求一次天气；不会自动查询，也不会自动重试。
            </p>
          </div>
        </div>
      )}

      {pending ? (
        <p className="dwp-pending" role="status">
          正在等待天气服务响应。可以停止等待：这只结束本页的等待，不保证后端或上游停止处理。
        </p>
      ) : null}

      {error ? (
        <p className="dwp-error" role="alert">
          {error.message}
        </p>
      ) : null}

      {report ? (
        <ReportBlock
          report={report}
          stationName={currentStationName}
          date={date}
          coverageText={formatCoverage(report.coverage)}
        />
      ) : null}

      <p className="dwp-memory-note">{NETWORK_NOTE}</p>

      <Attribution
        license={report?.source.license ?? null}
        docsUrl={report?.source.docs_url ?? null}
        attributionUrl={report?.source.attribution_url ?? null}
      />
    </section>
  )
}

function formatCoord(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6
  return String(rounded)
}

function ReportBlock({
  report,
  stationName,
  date,
  coverageText,
}: {
  report: WeatherDayReport
  stationName: string
  date: string
  coverageText: string
}) {
  const timezoneText = report.provider_timezone
    ? `${report.provider_timezone}${
        report.provider_utc_offset_seconds === null
          ? ''
          : `（${formatUtcOffset(report.provider_utc_offset_seconds)}）`
      }`
    : report.provider_utc_offset_seconds === null
      ? '未知'
      : `未知（偏移 ${formatUtcOffset(report.provider_utc_offset_seconds)}）`

  return (
    <div className="dwp-result" data-status={report.status} data-testid="weather-result">
      {report.status === 'available' && report.forecast ? (
        <>
          <div className="dwp-result-head">
            <h4 className="dwp-result-title">
              {report.forecast.date} 的单日预报
              {report.requested_date === date ? '' : ` · 请求日期 ${report.requested_date ?? '未知'}`}
            </h4>
            <span className="dwp-tag dwp-tag-ok">已返回</span>
          </div>
          <ForecastGrid forecast={report.forecast} />
          <p className="dwp-note">
            以上是 {report.source.provider} 针对该坐标网格点的单日预报。网格点可能偏离请求点，不是「{stationName || '所选站点'}」的精确位置。
          </p>
        </>
      ) : (
        <div className="dwp-result-head">
          <h4 className="dwp-result-title">天气结果</h4>
          <span className="dwp-tag" data-testid="weather-status-tag">
            {statusLabel(report.status)}
          </span>
        </div>
      )}

      {report.status === 'available' ? null : report.status === 'out_of_range' ? (
        <p className="dwp-notice" role="status">
          所选日期 {report.requested_date ?? date} 不在来源当前覆盖范围内。来源当前实际覆盖{' '}
          {coverageText}；这一天暂无记录。这里不会用其它日期的天气代替。
        </p>
      ) : (
        <p className="dwp-notice" role="status">
          {STATUS_TEXT[report.status]} 这不代表当前行程或其它日期有问题。
        </p>
      )}

      <dl className="dwp-facts">
        <div>
          <dt>来源</dt>
          <dd>
            {report.source.provider}
            {' · '}
            <a href={report.source.docs_url} target="_blank" rel="noreferrer">
              数据说明
            </a>
            {' · '}
            {report.source.license}
          </dd>
        </div>
        <div>
          <dt>目的地天气时区</dt>
          <dd>{timezoneText}</dd>
        </div>
        <div>
          <dt>查询日期</dt>
          <dd>{report.requested_date ?? '未知'}</dd>
        </div>
        <div>
          <dt>查询发起时间</dt>
          <dd>{formatWeatherTimestamp(report.checked_at)}</dd>
        </div>
        <div>
          <dt>本次获取时间</dt>
          <dd>{formatWeatherTimestamp(report.fetched_at)}</dd>
        </div>
        <div>
          <dt>来源覆盖</dt>
          <dd>{coverageText}</dd>
        </div>
        <div>
          <dt>请求坐标</dt>
          <dd>
            {formatCoord(report.coordinate.requested.lat)},{' '}
            {formatCoord(report.coordinate.requested.lon)}（WGS84，按行程记录查询，未核验）
          </dd>
        </div>
        <div>
          <dt>采样网格点</dt>
          <dd>
            {report.coordinate.grid
              ? `${formatCoord(report.coordinate.grid.lat)}, ${formatCoord(
                  report.coordinate.grid.lon,
                )}（网格中心，不是站点精确位置）`
              : '未知'}
          </dd>
        </div>
      </dl>
    </div>
  )
}

function statusLabel(status: WeatherDayReport['status']): string {
  switch (status) {
    case 'available':
      return '已返回'
    case 'out_of_range':
      return '超出覆盖范围'
    case 'invalid_request':
      return '参数未接受'
    case 'timeout':
      return '超时'
    case 'unavailable':
      return '暂时不可用'
    case 'failed':
      return '本次失败'
  }
}

function ForecastGrid({ forecast }: { forecast: WeatherDayForecast }) {
  return (
    <dl className="dwp-grid" data-testid="weather-values">
      {(Object.keys(FIELD_LABELS) as WeatherField[]).map((field) => {
        const reading = readWeatherField(forecast, field)
        const display =
          field === 'weather_code'
            ? reading.known
              ? weatherCodeText(reading.value)
              : '未知'
            : formatWeatherMetric(reading)
        return (
          <div className="dwp-metric" key={field} data-field={field}>
            <dt>{FIELD_LABELS[field]}</dt>
            <dd>{display}</dd>
          </div>
        )
      })}
    </dl>
  )
}

function Attribution({
  license,
  docsUrl,
  attributionUrl,
}: {
  license: string | null
  docsUrl: string | null
  attributionUrl: string | null
}) {
  return (
    <p className="dwp-attribution" data-testid="weather-attribution">
      <a
        href={attributionUrl ?? OPEN_METEO_ATTRIBUTION_URL}
        target="_blank"
        rel="noreferrer"
      >
        Weather data by Open-Meteo.com
      </a>
      {' · '}
      <a href={docsUrl ?? OPEN_METEO_DOCS_URL} target="_blank" rel="noreferrer">
        数据源说明
      </a>
      {license ? ` · 许可：${license}` : null}
    </p>
  )
}

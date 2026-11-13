import { useEffect, useRef, useState } from 'react'

import type { TripDay } from '../lib/api'
import {
  DEPARTURE_BUFFER_MINUTES,
  collectTodayReminders,
  departureFor,
  localDateKey,
  minutesToHhMm,
  minutesOfDay,
  pickNextStop,
  pickTodayDay,
} from '../lib/todayView'
import { projectStopFacts, type StopFactField, type StopFacts } from '../lib/stopFacts'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import type { ChecklistItemV1, ConstraintItemV1 } from '../lib/workspaceTypes'
import { displayTime } from '../lib/format'
import { fetchDayWeather, type WeatherAdapter } from '../lib/weatherApi'
import { collectWeatherStations, formatWeatherMetric, isCalendarDate, readWeatherField, weatherCodeText } from '../lib/weather'
import {
  SPEECH_RATE_OPTIONS,
  buildStopNarration,
  speechNotice,
  useSpeechNarration,
} from '../lib/speech'
import StopFactBadge from './StopFactBadge'
import { cn } from '../lib/utils'

/**
 * S4 · 一日跟随：「今天」卡（五期计划 §5）。
 *
 * 边界：
 * - **纯投影 + 按需天气**：挂载、渲染不发任何请求；只有点「查今天天气」才走
 *   一次现有 /api/weather/day 通道（复用 weatherApi，不新增网络能力）。
 * - 零写入：结果只在组件内存，不碰 localStorage / Trip / 草稿。
 * - 当前天按本机日期匹配 day.date；匹配不到兜底第 1 天并如实标注；
 *   整份行程无日期同样默认第 1 天并标「日期未知」。
 * - 下一站 / 出发时间 / 营业状态 / 预约提醒全部诚实口径：缺数据显示
 *   「时间未知 / 出发时间未知 / 未核实 / 未记录」，绝不编造，straight_line
 *   路段耗时标「示意」，不冒充导航时长。
 * - 时钟与天气 adapter 均可注入（now / requestWeather），生产用默认实现。
 */

export interface TodayPanelProps {
  /** 行程的全部天（当前天判定按本机日期在其中匹配）。 */
  days: readonly TripDay[]
  /** 资料卡库记录；null = 没有可用资料卡库。 */
  poiCardsRecord: PoiCardsRecordV1 | null
  /** 资料卡库是否已成功读过；false 时营业状态按「未知」口径。 */
  poiCardsLoaded: boolean
  /** 出行准备清单（appointment 项参与预约提醒）；无工作区传空数组。 */
  checklist: readonly ChecklistItemV1[]
  /** 约束（fixed_window 项参与预约提醒）；无工作区传空数组。 */
  constraints: readonly ConstraintItemV1[]
  /** 选中站点（与列表 / 地图同一事实）；看地图 / 看详情即选中下一站。 */
  activeStopId: string | null
  onSelectStop: (stopId: string) => void
  /** 时钟注入：生产 Date.now，测试传固定时刻。 */
  now?: () => number
  /** 天气 adapter 注入：默认 weatherApi.fetchDayWeather，测试传 mock。 */
  requestWeather?: WeatherAdapter
  /** 七期 S3：当前天所在城市；仅多城行程传入，不传时输出与旧版完全一致。 */
  city?: string | null
}

type WeatherView =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ok'; summary: string }
  | { phase: 'fail'; message: string; blocked: boolean }

const WEATHER_FAIL_TEXT = {
  no_station: '天气未获取（本日没有可用的记录坐标）',
  no_date: '天气未获取（本日日期未知）',
  error: '天气未获取',
} as const

/** 营业状态 unknown 态的兜底字段（与 stopFacts 的 unknown 形状一致）。 */
const UNKNOWN_OPENING: StopFactField = {
  value: null,
  status: 'unknown',
  source: null,
  sourceDetail: null,
  recordedAt: null,
  stale: false,
}

const CARD =
  'mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-4 py-3 text-sm leading-relaxed'
const LABEL = 'm-0 font-semibold'
const MUTED = 'text-[color:var(--color-faint)]'
const BADGE =
  'inline-flex items-center rounded-[4px] border border-[color:var(--color-warn-ink)] px-1.5 py-px text-[10px] text-[color:var(--color-warn-ink)]'
const ACTION =
  'min-h-11 cursor-pointer rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-4 text-sm hover:bg-secondary'

export default function TodayPanel({
  days,
  poiCardsRecord,
  poiCardsLoaded,
  checklist,
  constraints,
  onSelectStop,
  now = Date.now,
  requestWeather,
  city,
}: TodayPanelProps) {
  const nowMs = now()
  const pick = pickTodayDay(days, nowMs)
  const day = pick.day

  /* ── 天气（按需一次；结果绑定当前天，切天自动回落 idle） ── */
  // hooks 无条件调用：day 为 null 时以空 key 挂着，随后统一早退
  const dayKey = day === null ? '' : `${day.day}|${day.date ?? ''}`
  /* ── S7 连续语音讲解：显式点击才播放；换天 / 卸载自动停止 ── */
  const speech = useSpeechNarration()
  useEffect(() => {
    // 换天时停止本日朗读，避免继续读另一天的站点；stop 是稳定回调
    speech.stop()
  }, [dayKey, speech.stop])
  const [weather, setWeather] = useState<{ key: string; view: WeatherView }>({ key: '', view: { phase: 'idle' } })
  const weatherView: WeatherView = weather.key === dayKey ? weather.view : { phase: 'idle' }
  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      // 卸载时终止在途请求；迟到响应由序号判废
      seqRef.current += 1
      abortRef.current?.abort()
    },
    [],
  )

  if (day === null) return null

  const stations = collectWeatherStations(day)
  const weatherDateOk = isCalendarDate(day.date)
  const weatherBlocked = !weatherDateOk || stations.length === 0

  const handleWeather = () => {
    if (weatherBlocked) return
    const date = day.date
    if (!weatherDateOk || date === null) return
    const seq = ++seqRef.current
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setWeather({ key: dayKey, view: { phase: 'loading' } })
    const adapter = requestWeather ?? fetchDayWeather
    adapter({ lat: stations[0].lat, lon: stations[0].lon, date }, { signal: ctrl.signal })
      .then((report) => {
        if (seq !== seqRef.current) return
        const forecast = report.status === 'available' ? report.forecast : null
        if (forecast === null) {
          setWeather({ key: dayKey, view: { phase: 'fail', message: WEATHER_FAIL_TEXT.error, blocked: false } })
          return
        }
        const station = stations[0]
        const summary =
          `${weatherCodeText(forecast.values.weather_code)} · 最高 ${formatWeatherMetric(readWeatherField(forecast, 'temperature_2m_max'))}` +
          ` / 最低 ${formatWeatherMetric(readWeatherField(forecast, 'temperature_2m_min'))}` +
          ` · 降水 ${formatWeatherMetric(readWeatherField(forecast, 'precipitation_probability_max'))}` +
          `（${station.name}）`
        setWeather({ key: dayKey, view: { phase: 'ok', summary } })
      })
      .catch(() => {
        if (seq !== seqRef.current) return
        setWeather({ key: dayKey, view: { phase: 'fail', message: WEATHER_FAIL_TEXT.error, blocked: false } })
      })
  }

  /* ── 下一站 / 出发 / 营业状态 ── */
  const next = pickNextStop(day, nowMs)
  const dep = next.kind === 'upcoming' ? departureFor(day, next) : null
  const facts: StopFacts | null =
    next.kind === 'upcoming' && next.stop !== null && poiCardsLoaded
      ? projectStopFacts(next.stop, poiCardsRecord, nowMs)
      : null
  const opening = facts?.openingHours ?? UNKNOWN_OPENING

  /* ── 预约提醒 ── */
  const reminders = collectTodayReminders(day, checklist, constraints)

  const dayLabel =
    pick.kind === 'matched'
      ? `今天 · 第 ${day.day} 天${day.date ? `（${day.date.slice(5)}）` : ''}`
      : pick.kind === 'unmatched_first'
        ? `行程第 ${day.day} 天（日期未匹配）`
        : `行程第 ${day.day} 天（日期未知）`
  const clockText = localDateKey(nowMs) === '' ? null : minutesToHhMm(minutesOfDay(nowMs))
  /* 七期 S3：城市徽标只在显式传入非空城市时渲染，单城/旧调用零 DOM 变化。 */
  const cityBadge = typeof city === 'string' ? city.trim() : ''

  /* ── S7 本日连续讲解 ── */
  const narrationItems = day.stops.map((stop, index) => ({
    id: stop.id,
    text: buildStopNarration(stop, { index }),
  }))
  const speechBlocked = !speech.supported || speech.voiceStatus === 'missing'
  const speakingDay =
    speech.status !== 'idle' && narrationItems.some((item) => item.id === speech.currentId)
  const speechNoticeText = speechNotice(speech.supported, speech.voiceStatus, speech.failure)
  const speechStatusText = speechNoticeText
    ? speechNoticeText
    : speakingDay
      ? `正在朗读第 ${(speech.index ?? 0) + 1} 站 / 共 ${narrationItems.length} 站${speech.status === 'paused' ? '（已暂停）' : ''}`
      : '按站点顺序朗读本日讲解；只在点击后播放，不上传文本'
  const handleListenDay = () => {
    if (speechBlocked) return
    if (speakingDay) {
      if (speech.status === 'paused') speech.resume()
      else speech.pause()
      return
    }
    speech.play(narrationItems)
  }

  return (
    <div data-testid="today-panel" data-today-kind={pick.kind} className={cn(CARD, 'oc-panel-enter-fast')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={LABEL} data-testid="today-day-label">{dayLabel}</p>
        {cityBadge !== '' && (
          <span
            className="inline-flex items-center rounded-full border border-[color:var(--color-line-strong)] bg-secondary px-2 py-0.5 text-xs font-normal text-[color:var(--color-secondary-foreground)]"
            data-testid="today-city-badge"
          >
            {cityBadge}
          </span>
        )}
        {clockText !== null && (
          <p className={`m-0 font-mono text-xs ${MUTED}`} data-testid="today-clock">现在 {clockText}</p>
        )}
      </div>

      {next.kind === 'no_stops' && (
        <p className="m-0 mt-2" data-testid="today-next-empty">今天没有安排站点</p>
      )}
      {next.kind === 'finished' && (
        <p className="m-0 mt-2" data-testid="today-finished">今日行程已结束</p>
      )}
      {next.kind === 'upcoming' && next.stop !== null && (
        <>
          <p className="m-0 mt-2" data-testid="today-next-stop">
            下一站 · 第 {next.index + 1} 站（共 {day.stops.length} 站）：
            <span className="font-semibold" data-testid="today-next-name">「{next.stop.name}」</span>
            <span className={`ml-2 font-mono ${MUTED}`} data-testid="today-next-time">
              {next.timeKnown ? displayTime(next.stop.time) : '时间未知'}
            </span>
          </p>
          {dep !== null && (
            <p className="m-0 mt-1" data-testid="today-departure">
              {dep.kind === 'suggested' ? (
                <>
                  建议出发 <span className="font-mono font-semibold" data-testid="today-departure-time">{dep.timeText}</span>
                  （{dep.legText}
                  {dep.approximate && <span className={BADGE} data-testid="today-departure-approx">示意</span>}
                  ，含 {DEPARTURE_BUFFER_MINUTES} 分钟缓冲）
                </>
              ) : (
                <span data-testid="today-departure-unknown">出发时间未知</span>
              )}
            </p>
          )}
          <div className="m-0 mt-1 flex flex-wrap items-center gap-2" data-testid="today-opening">
            {opening.value !== null ? (
              <>
                <span>营业时间：{opening.value}</span>
                <StopFactBadge fact={opening} detailLabel={`营业时间来源：${next.stop.name}`} />
              </>
            ) : (
              <>
                <span>营业状态未知</span>
                <StopFactBadge fact={opening} detailLabel={`营业时间来源：${next.stop.name}`} />
              </>
            )}
          </div>
        </>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="today-weather">
        {weatherView.phase === 'ok' && (
          <span data-testid="today-weather-values">{weatherView.summary}</span>
        )}
        {weatherView.phase === 'loading' && (
          <span data-testid="today-weather-loading" role="status">天气查询中…</span>
        )}
        {weatherView.phase === 'fail' && (
          <span data-testid="today-weather-fail">{weatherView.message}</span>
        )}
        {weatherView.phase === 'idle' && <span className={MUTED}>天气未获取</span>}
        <button
          type="button"
          className={ACTION}
          disabled={weatherBlocked || weatherView.phase === 'loading'}
          onClick={handleWeather}
          data-testid="today-weather-button"
        >
          {weatherView.phase === 'loading' ? '查询中…' : '查今天天气'}
        </button>
      </div>

      <div className="mt-2" data-testid="today-reminders">
        <p className="m-0 text-xs font-semibold">今日预约与时间窗</p>
        {reminders.length === 0 ? (
          <p className="m-0 mt-1 text-xs text-muted-foreground" data-testid="today-reminders-empty">未记录</p>
        ) : (
          <ul className="m-0 mt-1 grid list-none gap-1 p-0" data-testid="today-reminder-list">
            {reminders.map((r) => (
              <li key={`${r.from}:${r.title}`} className="text-xs" data-testid="today-reminder-item">
                {r.title}（{r.from === 'checklist' ? '清单' : '约束'}）
              </li>
            ))}
          </ul>
        )}
      </div>

      <div
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"
        data-testid="today-speech"
      >
        <button
          type="button"
          className={ACTION}
          onClick={handleListenDay}
          disabled={speechBlocked || narrationItems.length === 0}
          aria-pressed={speakingDay}
          data-testid="today-listen-day"
        >
          {speakingDay
            ? speech.status === 'paused'
              ? '继续本日讲解'
              : '暂停本日讲解'
            : '连续播放本日讲解'}
        </button>
        {speakingDay && (
          <button
            type="button"
            className={ACTION}
            onClick={() => speech.stop()}
            data-testid="today-speech-stop"
          >
            停止
          </button>
        )}
        {speech.supported && speech.voiceStatus !== 'missing' && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            语速
            <select
              className="min-h-9 rounded-[6px] border border-border bg-background px-1.5 text-xs"
              data-testid="today-speech-rate"
              value={String(speech.rate)}
              onChange={(event) => speech.setRate(Number(event.target.value))}
            >
              {SPEECH_RATE_OPTIONS.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}x
                </option>
              ))}
            </select>
          </label>
        )}
        <span
          className="text-xs text-muted-foreground"
          aria-live="polite"
          data-testid="today-speech-status"
        >
          {narrationItems.length === 0 ? '本日没有可讲解的站点' : speechStatusText}
        </span>
      </div>

      {next.kind === 'upcoming' && next.stop !== null && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className={ACTION}
            onClick={() => onSelectStop(next.stop!.id)}
            data-testid="today-view-map"
          >
            看地图
          </button>
          <button
            type="button"
            className={ACTION}
            onClick={() => onSelectStop(next.stop!.id)}
            data-testid="today-view-detail"
          >
            看详情
          </button>
        </div>
      )}
    </div>
  )
}

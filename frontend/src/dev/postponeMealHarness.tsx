/**
 * 六期 S8 · 时刻顺延 / 补一餐 E2E 挂载入口（仅离线浏览器验收用）。
 *
 * 背景：真实挂载点在 App.tsx 行程区（体检卡条目入口 → lazy 面板，PM 接线项，
 * 作者禁改 App.tsx）。本页在真实浏览器里挂载同一批组件，并按报告 §6 的接线样板
 * 实现父级状态：
 * - draft 只在内存：无草稿时面板确认后调用 createTripDraft（既有 fork 路径），
 *   有草稿时通过 onDraftChange 更新；不落任何存储。
 * - 体检卡与条目动作入口共用同一个 currentDay（有草稿时取草稿天），写入后即时重算。
 * - onHealthRecheck 只记录调用次数与天号，证明「应用后自动重跑体检」回调被触发。
 *
 * 边界：本文件与 postpone-meal-harness.html 只被 E2E 引用，不进主包、不进构建产物；
 * 零网络、零存储写入。
 */
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

// 全局样式与主应用同一份（app.css → tailwindcss + theme.css 六主题变量）。
import '../app.css'

import ItineraryHealthCard from '../components/ItineraryHealthCard'
import HealthActionEntry from '../components/HealthActionEntry'
import PostponePanel from '../components/PostponePanel'
import MealSuggestPanel from '../components/MealSuggestPanel'
import type { Trip, TripDay, TripLeg, TripStop } from '../lib/api'
import { inspectDayHealth, type HealthPace } from '../lib/itineraryHealth'
import type { MealWindowKey } from '../lib/mealGap'
import { createTripDraft, type TripDraft } from '../lib/tripDraft'
import type { CandidateItemV1 } from '../lib/workspace'

const PACE: HealthPace = 'balanced'
const NOW = 1_800_000_000_000

function makeStop(
  id: string,
  name: string,
  time: string,
  duration: number,
  location: { lng: number; lat: number } | null = null,
): TripStop {
  return {
    id,
    name,
    time,
    duration_minutes: duration,
    description: '',
    address: '',
    location,
  }
}

function makeLeg(from: TripStop, to: TripStop, duration: number): TripLeg {
  return {
    from_stop_id: from.id,
    to_stop_id: to.id,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: 600,
    duration_minutes: duration,
    geometry: [],
    description: 'E2E 桩路线',
  }
}

function makeDay(idPrefix: string): TripDay {
  const stops: TripStop[] =
    idPrefix === 'postpone'
      ? [
          makeStop('p-s1', '断桥残雪', '09:00', 60),
          makeStop('p-s2', '平湖秋月', '10:10', 30),
          makeStop('p-s3', '湖滨晴雨', '11:00', 30),
          makeStop('p-s4', '柳浪闻莺', '14:00', 60),
        ]
      : [
          makeStop('m-s1', '灵隐寺', '09:00', 90),
          makeStop('m-s2', '龙井村', '11:00', 60, { lng: 120.15, lat: 30.28 }),
          makeStop('m-s3', '西湖', '13:00', 60),
          makeStop('m-s4', '河坊街', '17:00', 120),
        ]
  const legMinutes = idPrefix === 'postpone' ? [5, 5, 10] : [10, 10, 10]
  return {
    day: 1,
    date: '2026-04-03',
    title: '第一天',
    summary: 'E2E 桩数据',
    stops,
    legs: stops.slice(0, -1).map((stop, index) => makeLeg(stop, stops[index + 1], legMinutes[index])),
  }
}

function makeTrip(variant: 'postpone' | 'meal'): Trip {
  return {
    id: `e2e-s8-${variant}-trip`,
    source: 'example',
    destination: '杭州',
    title: variant === 'postpone' ? '顺延 E2E 行程' : '补餐 E2E 行程',
    summary: '只服务 S8 E2E；不进主包、不进构建产物。',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [makeDay(variant)],
  }
}

function candidate(
  id: string,
  name: string,
  tags: string[],
  location: { lng: number; lat: number } | null,
): CandidateItemV1 {
  return {
    id,
    name,
    address: null,
    notes: null,
    tags,
    priority: 1,
    location,
    source: 'manual',
    copiedFromStopId: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

const MEAL_CANDIDATES: readonly CandidateItemV1[] = [
  candidate('c1', '楼外楼餐厅', [], { lng: 120.1501, lat: 30.2801 }),
  candidate('c2', '龙井茶餐厅', [], { lng: 120.5, lat: 30.5 }),
  candidate('c3', '老字号面馆', ['地方小吃'], null),
  candidate('c4', '断桥残雪', [], null),
]

const params = new URLSearchParams(window.location.search)
const variant: 'postpone' | 'meal' = params.get('variant') === 'meal' ? 'meal' : 'postpone'
const emptyCandidates = params.get('candidates') === 'empty'
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

const TRIP = makeTrip(variant)

function HarnessApp() {
  const [draft, setDraft] = useState<TripDraft | null>(null)
  const [panel, setPanel] = useState<'postpone' | 'meal' | null>(null)
  const [mealPreferredWindow, setMealPreferredWindow] = useState<MealWindowKey | null>(null)
  const [recheckCount, setRecheckCount] = useState(0)
  const [recheckDay, setRecheckDay] = useState<number | null>(null)
  const stopSeqRef = useRef(0)

  const day = draft?.days[0] ?? TRIP.days[0]
  const factsByStop = day.stops.map(() => null)
  const report = inspectDayHealth(day, PACE, factsByStop)

  function createDraft() {
    return createTripDraft(TRIP, { forkTripId: `e2e-s8-${variant}-fork`, newLegMode: 'walking' })
  }

  function createStopId() {
    stopSeqRef.current += 1
    return `e2e-meal-stop-${stopSeqRef.current}`
  }

  function handleRecheck(dayNumber: number) {
    setRecheckCount((count) => count + 1)
    setRecheckDay(dayNumber)
  }

  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 16, margin: '0 0 12px' }}>
        S8 顺延 / 补餐 · E2E 挂载页（{variant}
        {emptyCandidates ? ' · 无候选' : ''}）
      </h1>

      <ItineraryHealthCard day={day} pace={PACE} factsByStop={factsByStop} />

      <section
        aria-label="体检条目动作入口（模拟 PM 接进卡内条目）"
        data-testid="s8-health-actions"
        style={{ display: 'grid', gap: 4, margin: '0 0 12px' }}
      >
        {report.items.map((item, index) => (
          <div key={`${item.code}-${index}`} data-health-item-code={item.code}>
            <HealthActionEntry
              item={item}
              onSuggestPostpone={() => setPanel('postpone')}
              onSuggestMeal={(item) => {
                setMealPreferredWindow(item.preferredWindow ?? null)
                setPanel('meal')
              }}
            />
          </div>
        ))}
      </section>

      {panel === 'postpone' && (
        <PostponePanel
          baseDay={TRIP.days[0]}
          pace={PACE}
          draft={draft}
          onCreateDraft={createDraft}
          onDraftChange={setDraft}
          onClose={() => setPanel(null)}
          onHealthRecheck={handleRecheck}
        />
      )}

      {panel === 'meal' && (
        <MealSuggestPanel
          baseDay={TRIP.days[0]}
          draft={draft}
          preferredWindow={mealPreferredWindow}
          onCreateDraft={createDraft}
          onDraftChange={setDraft}
          candidates={emptyCandidates ? [] : MEAL_CANDIDATES}
          poiCards={null}
          createStopId={createStopId}
          now={NOW}
          onClose={() => setPanel(null)}
          onHealthRecheck={handleRecheck}
        />
      )}

      <section style={{ display: 'grid', gap: 4, marginTop: 16, fontSize: 13 }}>
        <p data-testid="s8-draft-status" style={{ margin: 0 }}>
          {draft === null
            ? '未创建草稿（原始行程）'
            : day.stops.map((stop) => `${stop.time} ${stop.name}`).join(' | ')}
        </p>
        <p data-testid="s8-draft-revision" style={{ margin: 0 }}>
          revision：{draft?.revision ?? 'none'}
        </p>
        <p data-testid="s8-stop-count" style={{ margin: 0 }}>
          站点数：{day.stops.length}
        </p>
        <p data-testid="s8-unavailable-legs" style={{ margin: 0 }}>
          待重取路段：{day.legs.filter((leg) => leg.route_type === 'unavailable').length}
        </p>
        <p data-testid="s8-recheck-count" style={{ margin: 0 }}>
          体检重跑次数：{recheckCount}（最后一次：{recheckDay === null ? '无' : `第 ${recheckDay} 天`}）
        </p>
        <p data-testid="s8-health-counts" style={{ margin: 0 }}>
          冲突 {report.counts.warning} / 需确认 {report.counts.notice} / 无法核对{' '}
          {report.counts.unknown}
        </p>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<HarnessApp />)

/**
 * 六期 S7 · 绕行拦截卡 E2E 挂载入口（仅离线浏览器验收用）。
 *
 * 背景：拦截卡的真实挂载点在 App.tsx 行程区顶部（PM 接线项，作者禁改 App.tsx）。
 * 本页在真实浏览器里挂载同一个 `DetourInterceptCard`，并按报告 §6 的建议实现
 * 父级接线样板：
 * - suppression：`Set<trip.id>` 只存内存（零写入）；刷新后重新判定。
 * - onKeep：把当前 trip.id 加入集合；卡片不再自动出现，但体检卡仍挂载可查。
 * - onGoAdjust(day)：记录请求的天号（真实接线时 = setActiveDay(day) + 打开编辑器）。
 * - 「重新挂载当前行程」按钮模拟父级重渲染 / 卡片卸载再挂载，验证会话内不重弹。
 *
 * 边界：本文件与 detour-harness.html 只被 E2E 引用，不进主包、不进构建产物；
 * 零网络、零存储写入。
 */
import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'

// 全局样式与主应用同一份（app.css → tailwindcss + theme.css 六主题变量）。
import '../app.css'

import DetourInterceptCard from '../components/DetourInterceptCard'
import ItineraryHealthCard from '../components/ItineraryHealthCard'
import type { Trip, TripDay } from '../lib/api'

function day1(from: { name: string; lng: number; lat: number }, to: { name: string; lng: number; lat: number }, meters: number): TripDay {
  return {
    day: 1,
    date: null,
    title: '第一天',
    summary: 'E2E 桩数据',
    stops: [
      {
        id: 's-1',
        name: from.name,
        time: '09:00',
        duration_minutes: 90,
        description: '',
        address: '',
        location: { lng: from.lng, lat: from.lat },
      },
      {
        id: 's-2',
        name: to.name,
        time: '11:00',
        duration_minutes: 90,
        description: '',
        address: '',
        location: { lng: to.lng, lat: to.lat },
      },
    ],
    legs: [
      {
        from_stop_id: 's-1',
        to_stop_id: 's-2',
        mode: 'driving',
        route_type: 'navigation',
        distance_m: meters,
        duration_minutes: 60,
        geometry: [],
        description: '',
      },
    ],
  }
}

function makeTrip(id: string, title: string, day: TripDay): Trip {
  return {
    id,
    source: 'agent',
    destination: '张家界',
    title,
    summary: '只服务绕行拦截 E2E；不进主包、不进构建产物。',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [day],
  }
}

/** 97.2km 型：直线约 26.3km，规划 97.2km（约 3.7 倍）→ 拦截。 */
const HIT_TRIP = makeTrip(
  'e2e-detour-hit',
  '97.2km 型绕行样本',
  day1(
    { name: '武陵源标志门', lng: 110.5465, lat: 29.3455 },
    { name: '天门山索道', lng: 110.478, lat: 29.117 },
    97_200,
  ),
)

/** 山形合理绕行：直线约 20.0km，实际 40km（2 倍）→ 不拦截；体检仍提示 ≥30km。 */
const WINDING_TRIP = makeTrip(
  'e2e-detour-winding',
  '合理绕行样本',
  day1(
    { name: '山脚游客中心', lng: 110.5, lat: 29.3 },
    { name: '山顶观景台', lng: 110.5, lat: 29.48 },
    40_000,
  ),
)

/** 比例很高但不足 30km 地板：直线约 5.0km，实际 25km → 不拦截。 */
const BELOW_FLOOR_TRIP = makeTrip(
  'e2e-detour-below-floor',
  '短途样本',
  day1(
    { name: '城区酒店', lng: 110.5, lat: 29.3 },
    { name: '城郊古镇', lng: 110.5, lat: 29.345 },
    25_000,
  ),
)

const params = new URLSearchParams(window.location.search)
const variant = params.get('variant') ?? 'hit'
const TRIP =
  variant === 'winding' ? WINDING_TRIP : variant === 'below-floor' ? BELOW_FLOOR_TRIP : HIT_TRIP
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')

function DetourHarnessApp() {
  // PM 接线建议：只存内存 Set，按 trip id；刷新后重新判定是合理行为。
  const [suppressedTripIds, setSuppressedTripIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const [adjustDay, setAdjustDay] = useState<number | null>(null)
  const [mountKey, setMountKey] = useState(0)

  const suppressed = suppressedTripIds.has(TRIP.id)

  const handleKeep = useCallback(() => {
    setSuppressedTripIds((previous) => {
      const next = new Set(previous)
      next.add(TRIP.id)
      return next
    })
  }, [])

  const handleGoAdjust = useCallback((day: number) => {
    setAdjustDay(day)
  }, [])

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 16, margin: '0 0 12px' }}>
        绕行拦截卡 · E2E 挂载页（{variant}）
      </h1>

      <div key={mountKey} data-testid="detour-harness-mount">
        {!suppressed && (
          <DetourInterceptCard
            trip={TRIP}
            onKeep={handleKeep}
            onGoAdjust={handleGoAdjust}
          />
        )}
        {suppressed && (
          <p
            data-testid="detour-harness-suppressed"
            role="status"
            style={{ margin: '0 0 16px', fontSize: 13 }}
          >
            本次行程已选择「保留原样」：会话内不再自动出现拦截卡。
          </p>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          data-testid="detour-harness-remount"
          onClick={() => setMountKey((value) => value + 1)}
          style={{ minHeight: 36, padding: '0 12px' }}
        >
          E2E：重新挂载当前行程
        </button>
        <span data-testid="detour-harness-mount-count" style={{ fontSize: 13 }}>
          重新挂载次数：{mountKey}
        </span>
      </div>

      <p data-testid="detour-harness-adjust-status" role="status" style={{ fontSize: 13 }}>
        {adjustDay === null ? '尚未请求调整' : `已请求编辑：第 ${adjustDay} 天`}
      </p>

      <p data-testid="detour-harness-variant" hidden>
        {variant}
      </p>

      <ItineraryHealthCard
        day={TRIP.days[0]}
        pace="balanced"
        factsByStop={TRIP.days[0].stops.map(() => null)}
      />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<DetourHarnessApp />)

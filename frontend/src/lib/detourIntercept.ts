/**
 * 六期 S7 · 绕行拦截投影：规划成功后，在前端纯本地判断「实际路段比直线远太多」。
 *
 * 口径来源（不另造）：
 * - 实际距离：行程 legs 的 `distance_m`（地图服务写入），与五期体检 detour 同一来源。
 * - 直线距离：`routeFlow.haversineKm`（WGS84 平均半径 6371.0088 km），与五期体检
 *   backtrack 同一 haversine 实现。
 *
 * 与五期体检 detour 的差异（如实说明）：
 * - 体检 detour 现实现只判「单段 distance_m ≥ 30km」，并不比较直线距离；因此不存在
 *   可直接复用的「倍数」口径。
 * - 本投影保留同一 30km 地板与同一距离来源，再叠加「实际 ≥ 直线 3 倍」。所以本投影
 *   更严，命中集合是体检提示的子集：体检仍会提示 30km 级长路段，本卡只拦比例也异常
 *   的段。五期体检规则本切片不改（S7 不回改五期行为）。
 *
 * 为什么阈值保守（3 倍 + 30km）：
 * - 盘山公路、轮渡、单行道绕行、跨城直达都可能让实际里程达到直线的 1.5–2.5 倍；
 *   只有「3 倍以上且绝对里程 ≥30km」才算可能不是最优路线，避免把合理绕行报成错误。
 * - 宁可漏报也不误报：这是可关闭的提示，不是自动改行程，也不是安全性断言。
 *
 * 边界：
 * - 任一站 `location` 缺失或坐标非法 → 跳过该站对（不猜坐标，不按 0 补）。
 * - 路段缺失 / `distance_m` 非有限数或为负 → 跳过该站对。
 * - 两站坐标完全相同（直线 0）时比例无意义，但仍按 30km 地板拦截：ratio 记为
 *   `Infinity`，展示层如实写「倍数无法计算」；不伪装成数据缺失。
 * - 纯函数、零副作用；同输入同输出。
 */

import type { TripDay, TripLeg } from './api'
import { haversineKm } from './routeFlow'
import { DETOUR_INTERCEPT_MIN_KM, DETOUR_INTERCEPT_RATIO } from './detourThresholds'

export { DETOUR_INTERCEPT_MIN_KM, DETOUR_INTERCEPT_RATIO }

/** 一条命中路段。 */
export interface DetourHit {
  /** 天号（TripDay.day 原值）。 */
  day: number
  /** 该段起点在当天 stops 中的 1-based 序号；终点为 stopIndex + 1。 */
  stopIndex: number
  fromName: string
  toName: string
  /** haversine 直线距离（公里）。 */
  straightKm: number
  /** legs.distance_m / 1000（公里）。 */
  actualKm: number
  /** actualKm / straightKm；两站坐标相同时为 Infinity。 */
  ratio: number
}

function legDistanceKm(leg: TripLeg): number | null {
  const meters = leg.distance_m
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return null
  return meters / 1000
}

/**
 * 找第 index 段（0-based，连接 stops[index] 与 stops[index + 1]）对应的 leg。
 * 优先按 from/to 站点 id 精确匹配（legs 顺序被打乱时仍正确）；历史数据缺 id 时
 * 退回同序位置，与体检 detour 的按序口径一致。
 */
function legForSegment(
  day: TripDay,
  index: number,
  fromStopId: string,
  toStopId: string,
): TripLeg | null {
  const legs = Array.isArray(day.legs) ? day.legs : []
  const positional = legs[index]
  if (
    positional !== undefined &&
    positional.from_stop_id === fromStopId &&
    positional.to_stop_id === toStopId
  ) {
    return positional
  }
  const matched = legs.find(
    (leg) => leg.from_stop_id === fromStopId && leg.to_stop_id === toStopId,
  )
  if (matched !== undefined) return matched
  if (positional !== undefined && !positional.from_stop_id && !positional.to_stop_id) {
    return positional
  }
  return null
}

/**
 * 投影整趟行程的命中路段，按天号 / 站序自然顺序返回；无命中返回空数组。
 * 只读输入，不改行程、不写存储、不发请求。
 */
export function projectDetourIntercept(
  days: readonly TripDay[] | null | undefined,
): DetourHit[] {
  const hits: DetourHit[] = []
  if (!Array.isArray(days)) return hits

  for (const day of days) {
    const stops = Array.isArray(day?.stops) ? day.stops : []
    for (let index = 1; index < stops.length; index += 1) {
      const from = stops[index - 1]
      const to = stops[index]
      if (!from?.location || !to?.location) continue

      const straightKm = haversineKm(from.location, to.location)
      if (!Number.isFinite(straightKm)) continue

      const leg = legForSegment(day, index - 1, from.id, to.id)
      if (leg === null) continue
      const actualKm = legDistanceKm(leg)
      if (actualKm === null) continue

      if (actualKm < DETOUR_INTERCEPT_MIN_KM) continue
      if (actualKm < straightKm * DETOUR_INTERCEPT_RATIO) continue

      hits.push({
        day: day.day,
        stopIndex: index,
        fromName: from.name,
        toName: to.name,
        straightKm,
        actualKm,
        ratio: straightKm > 0 ? actualKm / straightKm : Number.POSITIVE_INFINITY,
      })
    }
  }

  return hits
}

/** 证据主句：「直线 A km，规划 B km」；两位小数统一由这里格式化。 */
export function formatDetourEvidence(hit: DetourHit): string {
  const straight =
    hit.straightKm > 0 ? `${hit.straightKm.toFixed(1)} km` : '0.0 km（两站坐标相同）'
  return `直线 ${straight}，规划 ${hit.actualKm.toFixed(1)} km`
}

/** 倍数文案；坐标相同时如实写「无法计算」，不写 ∞。 */
export function formatDetourRatio(hit: DetourHit): string {
  return Number.isFinite(hit.ratio) ? `约 ${hit.ratio.toFixed(1)} 倍` : '倍数无法计算'
}

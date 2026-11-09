/**
 * 顺路度提示（四期 S5）：只分析、不修改行程。
 *
 * 口径：按当日 stops 原顺序计算相邻站 haversine 总路程，枚举全部相邻两站交换
 * （n−1 种），取交换后总路程最短的一种。最短交换使总路程缩短 ≥10% 才提示。
 * 这是对「相邻交换」的局部比较，不是全局最优路线；坐标缺失/非法时总路程不可知，
 * 诚实沉默，绝不拿 (0,0) 或默认值填充。
 */

/** 相邻交换使总路程缩短至少 10% 才提示；不是全局最优路线。 */
export const SWAP_IMPROVEMENT_THRESHOLD = 0.10

/**
 * 浮点容差：haversine 按分段距离累加，精确 10% 的几何构造在真实纬度/尺度上
 * 可能算出 0.09999999999998 之类的值。这里仅吸收浮点累加误差，不放宽业务阈值：
 * 9.9% 与 10% 相差 0.001，远大于本容差。
 */
const IMPROVEMENT_EPSILON = 1e-9

export interface RouteFlowStop {
  name: string
  lat?: number | null
  lng?: number | null
}

export interface RouteFlowSuggestion {
  /** 被交换两站中第一站在当日 stops 中的 1-based 序号。 */
  index: number
  /** (交换前总路程 − 交换后最短总路程) / 交换前总路程。 */
  improvementRatio: number
  /** 交换后节省的直线距离（公里）。 */
  savedKm: number
}

export type RouteFlowAnalysis =
  | { status: 'suggestion'; suggestion: RouteFlowSuggestion }
  | {
      status: 'none'
      reason: 'too_few_stops' | 'missing_coordinates' | 'no_improvement' | 'zero_distance'
    }

export interface RouteFlowPoint {
  lat?: number | null
  lng?: number | null
}

const EARTH_RADIUS_KM = 6371.0088

function isValidPoint(point: RouteFlowPoint): point is { lat: number; lng: number } {
  return (
    typeof point.lat === 'number' &&
    Number.isFinite(point.lat) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    typeof point.lng === 'number' &&
    Number.isFinite(point.lng) &&
    point.lng >= -180 &&
    point.lng <= 180
  )
}

/**
 * 标准 haversine 球面距离，WGS84 平均半径 6371.0088 km。
 * 任一坐标缺失、非有限数或越界时返回 NaN（不编造坐标、不静默补 0）。
 */
export function haversineKm(a: RouteFlowPoint, b: RouteFlowPoint): number {
  if (!isValidPoint(a) || !isValidPoint(b)) return Number.NaN

  const toRadians = Math.PI / 180
  const lat1 = a.lat * toRadians
  const lat2 = b.lat * toRadians
  const deltaLat = (b.lat - a.lat) * toRadians
  const deltaLng = (b.lng - a.lng) * toRadians

  const sinLat = Math.sin(deltaLat / 2)
  const sinLng = Math.sin(deltaLng / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  const clamped = Math.min(1, Math.max(0, h))

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(clamped))
}

function routeLengthKm(points: RouteFlowPoint[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    total += haversineKm(points[i - 1], points[i])
  }
  return total
}

/**
 * 分析当日站点顺序是否存在值得提示的相邻交换。
 *
 * - stops.length < 3 → too_few_stops（两站/一站没有可交换的空间）。
 * - 任一站坐标缺失、NaN/Infinity 或越界 → missing_coordinates（总路程不可知）。
 * - 原顺序总路程为 0 → zero_distance。
 * - 枚举 n−1 种相邻交换，取交换后总路程最短者；并列取最小 1-based index。
 * - 最短交换缩短比例 ≥ SWAP_IMPROVEMENT_THRESHOLD → suggestion，否则 no_improvement。
 *
 * 不修改入参；同输入同输出。
 */
export function analyzeDayRoute(stops: RouteFlowStop[]): RouteFlowAnalysis {
  if (stops.length < 3) return { status: 'none', reason: 'too_few_stops' }
  if (!stops.every(isValidPoint)) return { status: 'none', reason: 'missing_coordinates' }

  const points = stops.map((stop) => ({ lat: stop.lat, lng: stop.lng }))
  const beforeKm = routeLengthKm(points)
  if (beforeKm === 0) return { status: 'none', reason: 'zero_distance' }

  let bestAfterKm = Number.POSITIVE_INFINITY
  let bestIndex = 0

  for (let i = 0; i < points.length - 1; i += 1) {
    const swapped = points.slice()
    const first = swapped[i]
    swapped[i] = swapped[i + 1]
    swapped[i + 1] = first
    const afterKm = routeLengthKm(swapped)
    // 严格小于：并列时保留更小的 index，保证确定性。
    if (afterKm < bestAfterKm) {
      bestAfterKm = afterKm
      bestIndex = i
    }
  }

  const savedKm = beforeKm - bestAfterKm
  const improvementRatio = savedKm / beforeKm

  if (improvementRatio >= SWAP_IMPROVEMENT_THRESHOLD - IMPROVEMENT_EPSILON) {
    return {
      status: 'suggestion',
      suggestion: {
        index: bestIndex + 1,
        improvementRatio,
        savedKm,
      },
    }
  }

  return { status: 'none', reason: 'no_improvement' }
}

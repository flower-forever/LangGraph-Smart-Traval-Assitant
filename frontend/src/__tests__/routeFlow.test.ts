import { describe, expect, it } from 'vitest'
import {
  analyzeDayRoute,
  haversineKm,
  SWAP_IMPROVEMENT_THRESHOLD,
  type RouteFlowStop,
} from '../lib/routeFlow'

/** 赤道上 1° 经差的 haversine 距离，作为几何构造的基准。 */
const DEGREE_KM = (2 * Math.PI * 6371.0088) / 360

function point(name: string, lng: number, lat = 0): RouteFlowStop {
  return { name, lat, lng }
}

interface BoundaryGeometry {
  scale?: number
  baseLat?: number
  baseLng?: number
}

/**
 * 四点共线构造（经度固定、纬度递增）：A(0) → B(2s) → C(s) → D(d·s)。
 * 交换 B/C 后路程固定缩短 2s°，交换前为 (d + 2)s°，
 * 因此缩短比例 = 2 / (d + 2)。d 由目标比例反解；s 控制几何尺度。
 * 沿纬度方向构造，球面距离与经度无关，便于在真实基点上精确复现 10%。
 */
function boundaryStops(
  ratio: number,
  { scale = 1, baseLat = 0, baseLng = 0 }: BoundaryGeometry = {},
): RouteFlowStop[] {
  const d = 2 / ratio - 2
  return [
    { name: 'A', lat: baseLat, lng: baseLng },
    { name: 'B', lat: baseLat + 2 * scale, lng: baseLng },
    { name: 'C', lat: baseLat + 1 * scale, lng: baseLng },
    { name: 'D', lat: baseLat + d * scale, lng: baseLng },
  ]
}

const BOUNDARY_SCALES = [0.01, 1, 3] as const
const BOUNDARY_BASES = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 121.47 },
  { lat: 0, lng: -122.4 },
  { lat: 31.23, lng: 121.47 },
  { lat: -33.9, lng: -122.4 },
] as const

function boundaryCases(ratio: number): Array<{ label: string; stops: RouteFlowStop[] }> {
  return BOUNDARY_SCALES.flatMap((scale) =>
    BOUNDARY_BASES.map((base) => ({
      label: `scale=${scale} base=${base.lat},${base.lng}`,
      stops: boundaryStops(ratio, { scale, baseLat: base.lat, baseLng: base.lng }),
    })),
  )
}

describe('haversineKm', () => {
  it('赤道 1° 经差约 111.195 km，误差小于 0.5%', () => {
    const distance = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })
    expect(Number.isFinite(distance)).toBe(true)
    expect(distance).toBeCloseTo(DEGREE_KM, 9)
    expect(Math.abs(distance - DEGREE_KM) / DEGREE_KM).toBeLessThan(0.005)
  })

  it('同经度纬度 0→1° 与赤道 1° 等距；同一点距离为 0', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(DEGREE_KM, 9)
    expect(haversineKm({ lat: 30, lng: 120 }, { lat: 30, lng: 120 })).toBe(0)
  })

  it('缺失、非有限或越界坐标返回 NaN，不按 (0,0) 计算', () => {
    const origin = { lat: 0, lng: 0 }
    const invalid = [
      { lat: undefined, lng: 0 },
      { lat: 0, lng: null },
      { lat: Number.NaN, lng: 0 },
      { lat: 0, lng: Number.POSITIVE_INFINITY },
      { lat: 90.0001, lng: 0 },
      { lat: -90.0001, lng: 0 },
      { lat: 0, lng: 180.0001 },
      { lat: 0, lng: -180.0001 },
    ]
    for (const candidate of invalid) {
      expect(Number.isNaN(haversineKm(origin, candidate))).toBe(true)
      expect(Number.isNaN(haversineKm(candidate, origin))).toBe(true)
    }
  })
})

describe('analyzeDayRoute — 明确绕路', () => {
  it('四点折返路线给出第 2 站与第 3 站互换，比例与节省公里正确', () => {
    const stops = [point('A', 0), point('B', 2), point('C', 1), point('D', 10)]
    const analysis = analyzeDayRoute(stops)

    expect(analysis.status).toBe('suggestion')
    if (analysis.status !== 'suggestion') return
    expect(analysis.suggestion.index).toBe(2)
    expect(analysis.suggestion.improvementRatio).toBeCloseTo(1 / 6, 12)
    expect(analysis.suggestion.savedKm).toBeCloseTo(2 * DEGREE_KM, 6)
    expect(analysis.suggestion.savedKm).toBeGreaterThan(0)
  })
})

describe('analyzeDayRoute — 10% 阈值边界', () => {
  it(`阈值常量为 ${SWAP_IMPROVEMENT_THRESHOLD}（10%）`, () => {
    expect(SWAP_IMPROVEMENT_THRESHOLD).toBe(0.1)
  })

  it('多个尺度/基点下精确 10% → suggestion（边界含浮点容差）', () => {
    for (const { label, stops } of boundaryCases(0.1)) {
      const analysis = analyzeDayRoute(stops)
      expect(analysis.status, label).toBe('suggestion')
      if (analysis.status !== 'suggestion') continue
      expect(analysis.suggestion.index, label).toBe(2)
      expect(Math.abs(analysis.suggestion.improvementRatio - 0.1), label).toBeLessThan(1e-8)
      expect(analysis.suggestion.improvementRatio, label).toBeGreaterThanOrEqual(
        SWAP_IMPROVEMENT_THRESHOLD - 1e-9,
      )
    }
  })

  it('多个尺度/基点下约 9.9% → none / no_improvement（未被容差放宽）', () => {
    for (const { label, stops } of boundaryCases(0.099)) {
      expect(analyzeDayRoute(stops), label).toEqual({
        status: 'none',
        reason: 'no_improvement',
      })
    }
  })

  it('多个尺度/基点下约 10.1% → suggestion', () => {
    for (const { label, stops } of boundaryCases(0.101)) {
      const analysis = analyzeDayRoute(stops)
      expect(analysis.status, label).toBe('suggestion')
      if (analysis.status !== 'suggestion') continue
      expect(analysis.suggestion.improvementRatio, label).toBeGreaterThan(0.1)
    }
  })
})

describe('analyzeDayRoute — 诚实沉默', () => {
  it('两站及以下 → too_few_stops', () => {
    expect(analyzeDayRoute([])).toEqual({ status: 'none', reason: 'too_few_stops' })
    expect(analyzeDayRoute([point('A', 0)])).toEqual({ status: 'none', reason: 'too_few_stops' })
    expect(analyzeDayRoute([point('A', 0), point('B', 1)])).toEqual({
      status: 'none',
      reason: 'too_few_stops',
    })
  })

  it('三站但任一坐标缺失、NaN 或越界 → missing_coordinates', () => {
    const base: RouteFlowStop[] = [point('A', 0), point('B', 2), point('C', 1)]
    const badOverrides: Array<Partial<RouteFlowStop>> = [
      { lat: undefined },
      { lat: null },
      { lng: null },
      { lat: Number.NaN },
      { lng: Number.POSITIVE_INFINITY },
      { lat: 91 },
      { lat: -91 },
      { lng: 181 },
      { lng: -181 },
    ]

    for (const override of badOverrides) {
      const stops = base.map((stop, index) => (index === 1 ? { ...stop, ...override } : stop))
      expect(analyzeDayRoute(stops)).toEqual({ status: 'none', reason: 'missing_coordinates' })
    }
  })

  it('原顺序已经最优（交换不缩短）→ no_improvement', () => {
    const stops = [point('A', 0), point('B', 1), point('C', 2), point('D', 3)]
    expect(analyzeDayRoute(stops)).toEqual({ status: 'none', reason: 'no_improvement' })
  })

  it('全程同坐标 → zero_distance', () => {
    const stops = [
      { name: 'A', lat: 30, lng: 120 },
      { name: 'B', lat: 30, lng: 120 },
      { name: 'C', lat: 30, lng: 120 },
    ]
    expect(analyzeDayRoute(stops)).toEqual({ status: 'none', reason: 'zero_distance' })
  })
})

describe('analyzeDayRoute — 确定性与纯函数', () => {
  it('同输入两次分析结果全等，且不修改入参', () => {
    const stops = [point('A', 0), point('B', 2), point('C', 1), point('D', 10)]
    const before = JSON.stringify(stops)

    const first = analyzeDayRoute(stops)
    const second = analyzeDayRoute(stops)

    expect(second).toEqual(first)
    expect(JSON.stringify(stops)).toBe(before)
  })
})

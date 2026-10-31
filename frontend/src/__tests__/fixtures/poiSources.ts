/**
 * POI 公开资料测试夹具：构造 PoiSourceReport 与含/不含坐标的行程。
 * 所有数据是编造的示例数据，只给离线测试用，不参与构建产物，不代表任何
 * 真实 OSM 对象的现状。
 */
import type { Trip, TripDay } from '../../lib/api'
import type {
  PoiSourceCandidate,
  PoiSourceReport,
  PoiSourceQuery,
  PoiTagField,
} from '../../lib/poiSources'

export const CHECKED_AT = '2026-10-30T04:05:00+00:00'
export const FETCHED_AT = '2026-10-30T04:05:02+00:00'
export const OSM_UPDATED_AT = '2025-06-01T08:00:00Z'

export function tagSourceOnly(value: string): PoiTagField {
  return { state: 'source_only', value }
}

export function tagUnknown(): PoiTagField {
  return { state: 'unknown', value: null }
}

export function makePoiCandidate(
  overrides: Partial<PoiSourceCandidate> & { elementType?: PoiSourceCandidate['element_type']; elementId?: number } = {},
): PoiSourceCandidate {
  const { elementType = 'node', elementId = 1234567890, ...rest } = overrides
  return {
    element_type: elementType,
    element_id: elementId,
    name: '示例便利店（虚构）',
    location: { lat: 31.23041, lon: 121.47371 },
    distance_m: 1.2,
    source_url: `https://www.openstreetmap.org/${elementType}/${elementId}`,
    retrieved_at: FETCHED_AT,
    source_updated_at: OSM_UPDATED_AT,
    identity_status: 'unconfirmed',
    opening_hours: tagSourceOnly('Mo-Su 07:00-22:00'),
    fee: tagUnknown(),
    charge: tagUnknown(),
    ...rest,
  }
}

export const POI_FIXTURE_QUERY: PoiSourceQuery = { lat: 31.2304, lon: 121.4737 }

/** 默认 available 信封：requested 用 6 位舍入值，模拟后端 round(6) 行为。
 * 候选坐标相对 query 派生（约 1.4m / 37m 外），保证 haversine 复核与查询一致。 */
export function makePoiSourceReport(
  query: PoiSourceQuery,
  patch: Partial<PoiSourceReport> = {},
): PoiSourceReport {
  const lat = Math.round(query.lat * 1e6) / 1e6
  const lon = Math.round(query.lon * 1e6) / 1e6
  return {
    status: 'available',
    reason: null,
    provider_http_status: 200,
    checked_at: CHECKED_AT,
    fetched_at: FETCHED_AT,
    requested: { lat, lon },
    radius_m: 100,
    cached: false,
    source: {
      provider: 'overpass-api.de',
      endpoint: 'https://overpass-api.de/api/interpreter',
      docs_url: 'https://wiki.openstreetmap.org/wiki/Overpass_API',
      attribution_url: 'https://www.openstreetmap.org/copyright',
      license: 'ODbL 1.0',
      data_source: 'OpenStreetMap',
    },
    source_elements_seen: 2,
    candidates: [
      makePoiCandidate({ location: { lat: lat + 0.00001, lon: lon + 0.00001 } }),
      makePoiCandidate({
        elementType: 'way',
        elementId: 987654321,
        name: null,
        location: { lat: lat + 0.0002, lon: lon + 0.0002 },
        distance_m: 26.5,
        fee: tagSourceOnly('yes'),
      }),
    ],
    notes: [],
    ...patch,
  }
}

/** 含坐标 / 无坐标 / 多日（其中一天无日期无坐标）的示例行程 */
export function makePoiTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'trip-poi-1',
    source: 'example',
    destination: '示例市',
    title: '示例行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [
      {
        day: 1,
        date: '2026-05-01',
        title: '老城半日',
        summary: '',
        stops: [
          {
            id: 'p1',
            name: '老城门',
            time: '09:00',
            duration_minutes: 40,
            description: '',
            address: '',
            location: { lng: 121.4737, lat: 31.2304 },
          },
          {
            id: 'p2',
            name: '河边石桥',
            time: '10:30',
            duration_minutes: 20,
            description: '',
            address: '',
            location: { lng: -0.1276, lat: 51.5072 },
          },
          {
            id: 'p3',
            name: '无名岔口',
            time: '12:00',
            duration_minutes: null,
            description: '',
            address: '',
            location: null,
          },
        ],
        legs: [],
      },
      {
        day: 2,
        date: null,
        title: '全程无坐标',
        summary: '',
        stops: [
          {
            id: 'p4',
            name: '某无名站点',
            time: '09:00',
            duration_minutes: null,
            description: '',
            address: '',
            location: null,
          },
        ],
        legs: [],
      },
    ],
    ...overrides,
  }
}

export function tripDay(trip: Trip, day: number): TripDay | null {
  return trip.days.find((d) => d.day === day) ?? null
}

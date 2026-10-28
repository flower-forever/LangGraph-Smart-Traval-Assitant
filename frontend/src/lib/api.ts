/** 与后端约定的行程数据契约（travel_itinerary.py 输出结构） */

export type TravelMode = 'walking' | 'driving'

export type RouteType = 'navigation' | 'straight_line' | 'unavailable'

export interface TripLocation {
  /** WGS84 经度 */
  lng: number
  /** WGS84 纬度 */
  lat: number
}

export interface TripStop {
  id: string
  name: string
  time: string
  duration_minutes: number | null
  description: string
  address: string
  location: TripLocation | null
}

export interface TripLeg {
  from_stop_id: string
  to_stop_id: string
  mode: TravelMode
  route_type: RouteType
  distance_m: number | null
  duration_minutes: number | null
  /** [lng, lat] 序列 */
  geometry: TripLocation[]
  description: string
}

export interface TripDay {
  day: number
  date: string | null
  title: string
  summary: string
  stops: TripStop[]
  legs: TripLeg[]
}

export interface Trip {
  id: string
  source: 'example' | 'agent'
  destination: string
  title: string
  summary: string
  map_coordinate_system: 'WGS84'
  warnings: string[]
  days: TripDay[]
}

export interface PlanRequest {
  destination: string
  /** 1..7 */
  days: number
  /** YYYY-MM-DD 或 null */
  departure_date: string | null
  travelers: number
  preferences: string
  travel_mode: TravelMode
}

export type ApiErrorKind =
  | 'network'      // 后端不可达 / 超时
  | 'server'       // 后端返回 4xx/5xx
  | 'abort'        // 用户取消
  | 'bad_payload'  // 返回结构不符合契约

export class ApiError extends Error {
  kind: ApiErrorKind
  status?: number
  /** 后端 detail 字段（若有） */
  detail?: string
  /**
   * 5xx 且响应体不是 JSON。最常见的原因是后端没启动、Vite 的 /api 代理目标
   * 不可达，或后端异常退出——这三种都该提示「连不上」而不是「处理失败」。
   */
  upstreamUnavailable: boolean

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
    detail?: string,
    upstreamUnavailable = false,
  ) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.detail = detail
    this.upstreamUnavailable = upstreamUnavailable
  }
}

export interface ApiOptions {
  signal?: AbortSignal
  /** 覆盖 VITE_API_BASE，测试或多环境部署时用 */
  baseUrl?: string
}

/** 健康探针走 /api 前缀，才能被 Vite 开发代理转发到后端 */
export const HEALTH_PATH = '/api/health'
/** 探活默认超时：不能卡住首屏 */
export const HEALTH_TIMEOUT_MS = 3000

function apiBase(options?: ApiOptions): string {
  const base = options?.baseUrl ?? import.meta.env.VITE_API_BASE ?? ''
  return base.replace(/\/+$/, '')
}

/** 健康响应必须是 JSON 对象且 status 为 healthy；HTML fallback 的 200 不算数 */
function isHealthyPayload(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  return (body as { status?: unknown }).status === 'healthy'
}

/**
 * 探活：GET {base}/api/health。
 * 静态服务器（或 SPA fallback）对未知路径也会回 200 HTML，因此不能只看 res.ok；
 * 必须解析出契约里的 JSON，且 status === 'healthy'。
 */
export async function probeBackend(options?: ApiOptions & { timeoutMs?: number }): Promise<boolean> {
  const controller = new AbortController()
  const callerSignal = options?.signal
  const abort = () => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', abort, { once: true })
  }
  const timer = setTimeout(abort, options?.timeoutMs ?? HEALTH_TIMEOUT_MS)
  try {
    const res = await fetch(apiBase(options) + HEALTH_PATH, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return false
    const body: unknown = await res.json()
    return isHealthyPayload(body)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', abort)
  }
}

const JSON_BODY_START = /^\s*[[{]/

async function parseErrorResponse(res: Response): Promise<ApiError> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  let raw = ''
  try {
    raw = await res.text()
  } catch {
    raw = ''
  }
  const looksJson = contentType.includes('json') || JSON_BODY_START.test(raw)
  let detail: string | undefined
  if (looksJson) {
    try {
      const body: unknown = JSON.parse(raw)
      if (body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string') {
        detail = (body as { detail: string }).detail
      }
    } catch {
      /* 声明了 JSON 却解析不了，按非结构化错误处理 */
    }
  }
  // Vite 代理在后端未启动时回 500 + text/plain（Error occurred while trying to proxy…）。
  // FastAPI 未捕获异常也会给出非 JSON 的 5xx。两者都不能当「业务处理失败」。
  const upstreamUnavailable = res.status >= 500 && detail === undefined && !looksJson
  return new ApiError(
    'server',
    `后端返回错误（HTTP ${res.status}）`,
    res.status,
    detail,
    upstreamUnavailable,
  )
}

/** 读业务 JSON；把 SPA fallback 的 HTML 200 识别成「没连上后端」，而不是数据格式错误 */
async function readJson<T>(res: Response): Promise<T> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  let text: string
  try {
    text = await res.text()
  } catch {
    throw new ApiError('bad_payload', '后端响应读取失败')
  }
  if (!contentType.includes('json') && /^\s*</.test(text)) {
    throw new ApiError('network', '接口返回的是 HTML 页面，/api 请求可能没有代理到后端')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError('bad_payload', '后端返回的不是合法 JSON')
  }
}

async function requestJson<T>(path: string, options?: ApiOptions): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiBase(options) + path, {
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('abort', '请求已取消')
    }
    throw new ApiError('network', '无法连接后端服务，请确认 api_server 已启动')
  }
  if (!res.ok) throw await parseErrorResponse(res)
  return readJson<T>(res)
}

async function postJson<T>(path: string, body: unknown, options?: ApiOptions): Promise<T> {
  let res: Response
  try {
    res = await fetch(apiBase(options) + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('abort', '请求已取消')
    }
    throw new ApiError('network', '无法连接后端服务，请确认 api_server 已启动')
  }
  if (!res.ok) throw await parseErrorResponse(res)
  return readJson<T>(res)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPlainString(value: unknown): value is string {
  return typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value)
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

/** 坐标只校验是数字：越界值交给 format.validCoord 在展示前过滤（不在这里丢结构） */
function isLocationLike(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.lng) && isFiniteNumber(value.lat)
}

function isStopLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isPlainString(value.name) &&
    isPlainString(value.time) &&
    isNullableNumber(value.duration_minutes) &&
    isPlainString(value.description) &&
    isPlainString(value.address) &&
    (value.location === null || isLocationLike(value.location))
  )
}

function isLegLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.from_stop_id) &&
    isNonEmptyString(value.to_stop_id) &&
    (value.mode === 'walking' || value.mode === 'driving') &&
    (value.route_type === 'navigation' ||
      value.route_type === 'straight_line' ||
      value.route_type === 'unavailable') &&
    isNullableNumber(value.distance_m) &&
    isNullableNumber(value.duration_minutes) &&
    Array.isArray(value.geometry) &&
    value.geometry.every(isLocationLike) &&
    isPlainString(value.description)
  )
}

function isDayLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.day === 'number' &&
    Number.isInteger(value.day) &&
    isNullableString(value.date) &&
    isPlainString(value.title) &&
    isPlainString(value.summary) &&
    Array.isArray(value.stops) &&
    value.stops.every(isStopLike) &&
    Array.isArray(value.legs) &&
    value.legs.every(isLegLike)
  )
}

/**
 * 契约校验：顶层字段 + 每个 day + day 内 stops/legs 的关键结构。
 * 只挡会让渲染崩掉的坏数据（例如 days: [null]），不做坐标是否可画、leg 引用是否成环这类业务校验。
 */
export function isTripLike(value: unknown): value is Trip {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    (value.source === 'example' || value.source === 'agent') &&
    isNonEmptyString(value.destination) &&
    isPlainString(value.title) &&
    isPlainString(value.summary) &&
    value.map_coordinate_system === 'WGS84' &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isPlainString) &&
    Array.isArray(value.days) &&
    value.days.length > 0 &&
    value.days.every(isDayLike)
  )
}

export async function fetchExampleTrip(options?: ApiOptions): Promise<Trip> {
  const data = await requestJson<unknown>('/api/trips/example', options)
  if (!isTripLike(data)) {
    throw new ApiError('bad_payload', '示例行程返回结构不符合契约')
  }
  return data
}

export async function planTrip(payload: PlanRequest, options?: ApiOptions): Promise<Trip> {
  const data = await postJson<unknown>('/api/trips/plan', payload, options)
  if (!isTripLike(data)) {
    throw new ApiError('bad_payload', '规划结果结构不符合契约')
  }
  return data
}

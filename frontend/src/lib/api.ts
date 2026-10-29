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
  | 'network'      // 后端不可达 / 连接中途断开
  | 'server'       // 后端返回 4xx/5xx
  | 'abort'        // 调用方主动取消
  | 'timeout'      // 等待响应超时（含响应头到达之后的响应体阶段）
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
  /**
   * 整个请求（含响应体读取）的超时，毫秒。
   * 不传就不设超时：AI 规划本来就可能跑很久，该由调用方的 signal 决定取不取消。
   */
  timeoutMs?: number
}

/** 健康探针走 /api 前缀，才能被 Vite 开发代理转发到后端 */
export const HEALTH_PATH = '/api/health'
/** 探活默认超时：不能卡住首屏 */
export const HEALTH_TIMEOUT_MS = 3000

function apiBase(options?: ApiOptions): string {
  const base = options?.baseUrl ?? import.meta.env.VITE_API_BASE ?? ''
  return base.replace(/\/+$/, '')
}

/**
 * 请求时钟：把「调用方取消」和「超时」分开记，被打断的请求才能归类对。
 * 计时覆盖整个请求生命周期，包括响应头到达之后的响应体读取——
 * 后端先回了 200 头、body 卡住时属于超时，不是结构错误（bad_payload）。
 */
interface RequestClock {
  signal: AbortSignal
  timedOut(): boolean
  abortedByCaller(): boolean
  /**
   * 与信号中止竞速。底层读取不一定响应 abort——真实浏览器会中断响应体，
   * 但 polyfill / 代理 / keep-alive 场景里 res.text() 可能一直挂着。
   * 用 race 保证「响应头已到、body 卡住」也能按时落到 timeout，而不是永远等下去。
   */
  race<T>(promise: Promise<T>): Promise<T>
  dispose(): void
}

function createRequestClock(options?: ApiOptions): RequestClock {
  const controller = new AbortController()
  const caller = options?.signal
  const timeoutMs = options?.timeoutMs
  let timedOut = false
  let callerAborted = false
  const onCallerAbort = () => {
    callerAborted = true
    controller.abort()
  }
  if (caller) {
    if (caller.aborted) onCallerAbort()
    else caller.addEventListener('abort', onCallerAbort, { once: true })
  }
  const abortError = () => {
    if (typeof DOMException === 'function') return new DOMException('请求已中止', 'AbortError')
    const err = new Error('请求已中止')
    err.name = 'AbortError'
    return err
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    abortedByCaller: () => callerAborted,
    race<T>(promise: Promise<T>): Promise<T> {
      const { signal } = controller
      if (signal.aborted) {
        // 已经中止就别再挂着读取了，顺手把它的拒绝吃掉，避免 unhandled rejection
        promise.catch(() => {})
        return Promise.reject(abortError())
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort)
          // 底层读取可能不响应 abort，挂着的那个 promise 要自己兜住
          promise.catch(() => {})
          reject(abortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
          (value) => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          (err) => {
            signal.removeEventListener('abort', onAbort)
            reject(err)
          },
        )
      })
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    },
  }
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

/**
 * 把「被打断」的请求归类：先认自己的超时，再认调用方取消；都不是就返回 null，
 * 让调用方按真实故障（网络错误、HTTP 错误等）处理。
 */
function interruptedApiError(clock: RequestClock, err: unknown): ApiError | null {
  if (clock.timedOut()) return new ApiError('timeout', '等待后端响应超时，没在限定时间内拿到完整结果')
  if (clock.abortedByCaller() || isAbortError(err)) return new ApiError('abort', '请求已取消')
  return null
}

/**
 * 规划能力。只有后端明确表态才算数：
 * - 'ready'：health 里 planner_ready 是布尔 true
 * - 'unavailable'：health 里 planner_ready 是布尔 false
 * - 'unknown'：字段缺失、类型不对（例如字符串 "false"）、旧后端或 stub——不能当 false 处理
 */
export type PlannerAvailability = 'ready' | 'unavailable' | 'unknown'

/**
 * 当前后端服务的地图（高德）配置状态。只回答「这个服务进程」：
 * 它说明不了历史行程的坐标从哪来——导入/恢复的行程由文件或存储自己说话。
 */
export type AmapAvailability = 'configured' | 'not_configured' | 'unknown'

/** 探活失败分级，与请求层 network/server/bad_payload 的口径对齐，另加超时 */
export type ProbeFailure = 'timeout' | 'network' | 'http' | 'bad_payload'

/** 探活结论：后端是否可达，与规划是否可用，是两件事 */
export interface BackendCapabilities {
  /** 后端是活着的、契约内的健康服务（status=healthy 的 JSON） */
  reachable: boolean
  /** 规划能力；reachable=false 时固定 unknown，没连上就无从判断 */
  planner: PlannerAvailability
  /** 失败分级；reachable=true 时为 null */
  failure: ProbeFailure | null
  /** 当前后端服务是否配置了地图 Key；reachable=false 时固定 unknown */
  amap: AmapAvailability
}

const UNREACHABLE: BackendCapabilities = { reachable: false, planner: 'unknown', failure: 'network', amap: 'unknown' }

/** 健康响应必须是 JSON 对象且 status 为 healthy；HTML fallback 的 200 不算数 */
function isHealthyPayload(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
  return (body as { status?: unknown }).status === 'healthy'
}

/** 只认布尔字面量：缺字段、null、"false" 之类一律未知，绝不猜成不可用 */
function readPlannerAvailability(body: unknown): PlannerAvailability {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'unknown'
  const value = (body as { planner_ready?: unknown }).planner_ready
  if (value === true) return 'ready'
  if (value === false) return 'unavailable'
  return 'unknown'
}

/** amap_configured 同样只认布尔字面量；说明的是「当前服务」，不是历史行程的坐标来源 */
function readAmapAvailability(body: unknown): AmapAvailability {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'unknown'
  const value = (body as { amap_configured?: unknown }).amap_configured
  if (value === true) return 'configured'
  if (value === false) return 'not_configured'
  return 'unknown'
}

/**
 * 探活：GET {base}/api/health，返回「可达」与「规划能力」两件事。
 * 静态服务器（或 SPA fallback）对未知路径也会回 200 HTML，因此不能只看 res.ok；
 * 必须解析出契约里的 JSON，且 status === 'healthy'。
 * 本函数不抛错，失败原因收敛成 failure 分级，调用方按需展示。
 */
export async function probeBackendCapabilities(
  options?: ApiOptions & { timeoutMs?: number },
): Promise<BackendCapabilities> {
  const clock = createRequestClock({ ...options, timeoutMs: options?.timeoutMs ?? HEALTH_TIMEOUT_MS })
  try {
    const res = await fetch(apiBase(options) + HEALTH_PATH, {
      headers: { Accept: 'application/json' },
      signal: clock.signal,
    })
    if (!res.ok) return { reachable: false, planner: 'unknown', failure: 'http', amap: 'unknown' }
    let body: unknown
    try {
      // 响应头到了、body 还在路上：超时后立刻归类，不等底层读取自己醒悟
      body = await clock.race(res.json())
    } catch {
      // 响应头先到、body 阶段被超时打断：这是超时，不是返回结构有问题。
      // 只有真正读完却解析不了（200 + HTML 的 SPA fallback / 静态服务器）才算 bad_payload。
      if (clock.timedOut()) return { reachable: false, planner: 'unknown', failure: 'timeout', amap: 'unknown' }
      if (clock.abortedByCaller()) return { ...UNREACHABLE, failure: 'network' }
      return { reachable: false, planner: 'unknown', failure: 'bad_payload', amap: 'unknown' }
    }
    if (!isHealthyPayload(body)) {
      return { reachable: false, planner: 'unknown', failure: 'bad_payload', amap: 'unknown' }
    }
    // 兼容旧后端与 stub：字段缺失时 planner/amap 是 unknown，不是 false
    return { reachable: true, planner: readPlannerAvailability(body), failure: null, amap: readAmapAvailability(body) }
  } catch {
    return { ...UNREACHABLE, failure: clock.timedOut() ? 'timeout' : 'network' }
  } finally {
    clock.dispose()
  }
}

/**
 * 旧调用入口，只回答「后端是否可达」。
 * 需要知道能不能规划时用 probeBackendCapabilities——可达不等于规划可用。
 */
export async function probeBackend(options?: ApiOptions & { timeoutMs?: number }): Promise<boolean> {
  const caps = await probeBackendCapabilities(options)
  return caps.reachable
}

const JSON_BODY_START = /^\s*[[{]/

async function parseErrorResponse(res: Response, clock: RequestClock): Promise<ApiError> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  let raw = ''
  try {
    raw = await clock.race(res.text())
  } catch (err) {
    // 读错误响应体时被打断，优先报「超时 / 取消」，别让它变成一条假的业务错误
    const interrupted = interruptedApiError(clock, err)
    if (interrupted) throw interrupted
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

/**
 * 读业务 JSON。三类失败要分开：
 * - 读取过程被打断（超时 / 取消）：按 timeout 或 abort 报，不能算结构问题
 * - 读到的是 HTML 200：SPA fallback，等于没代理到后端
 * - 读完整了却不是合法 JSON：才是 bad_payload
 */
async function readJson<T>(res: Response, clock: RequestClock): Promise<T> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  let text: string
  try {
    text = await clock.race(res.text())
  } catch (err) {
    const interrupted = interruptedApiError(clock, err)
    if (interrupted) throw interrupted
    throw new ApiError('network', '读取后端响应时连接中断')
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
  const clock = createRequestClock(options)
  try {
    let res: Response
    try {
      res = await fetch(apiBase(options) + path, {
        headers: { Accept: 'application/json' },
        signal: clock.signal,
      })
    } catch (err) {
      const interrupted = interruptedApiError(clock, err)
      if (interrupted) throw interrupted
      throw new ApiError('network', '无法连接后端服务，请确认 api_server 已启动')
    }
    if (!res.ok) throw await parseErrorResponse(res, clock)
    return await readJson<T>(res, clock)
  } finally {
    clock.dispose()
  }
}

async function postJson<T>(path: string, body: unknown, options?: ApiOptions): Promise<T> {
  const clock = createRequestClock(options)
  try {
    let res: Response
    try {
      res = await fetch(apiBase(options) + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: clock.signal,
      })
    } catch (err) {
      const interrupted = interruptedApiError(clock, err)
      if (interrupted) throw interrupted
      throw new ApiError('network', '无法连接后端服务，请确认 api_server 已启动')
    }
    if (!res.ok) throw await parseErrorResponse(res, clock)
    return await readJson<T>(res, clock)
  } finally {
    clock.dispose()
  }
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

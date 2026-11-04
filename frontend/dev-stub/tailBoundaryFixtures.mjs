/**
 * 固定端点衔接路线（POST /api/trips/days/leg-refresh）契约桩夹具 +
 * 后段候选（【后段重规划】）replan fixture 构造器。
 * 与 tailBoundaryFixtures.test.mjs / runner 同源：这里产出的信封就是浏览器
 * 验收会话里桩返回的原文；测试用前端真实 validateLegRefreshResponse /
 * validateDayReplanResponse 闭环——构造器或前端契约任一侧漂移先红。
 *
 * 离线桩边界：本模块零网络原语、不调用真实高德/模型；信封形状逐字段镜像
 * 已验收的 backend leg_refresh.py + api_server.py wire（固定 reason 文案、
 * amap/WGS84/官方 v5 direction endpoint、navigation leg、严格 422 不回显
 * input）。距离/耗时是固定测试值（按 G 建议锚点对 s-e2e-2 → ai-tail-e2e-1
 * 用后端纯 service 离线探针取得），不代表真实导航。
 */

/** 桩实现的模式集合：ready / 0 距离变体 / 四种 typed 失败 */
export const TAIL_LEG_REFRESH_MODES = [
  'ready',
  'ready_zero_distance',
  'no_key',
  'timeout',
  'unavailable',
  'failed',
]

/** 与 leg_refresh.py._ENDPOINTS 一致：endpoint 按 mode 固定，不接受调用方指定 */
const LEG_REFRESH_ENDPOINTS = {
  walking: '/v5/direction/walking',
  driving: '/v5/direction/driving',
}

/** 与 leg_refresh.py._REASONS 逐字一致：固定安全文案，不回显异常/Key/上游正文 */
const LEG_REFRESH_REASONS = {
  no_key: '服务端未配置高德地图 Key，本次未执行任何路线查询。',
  timeout: '衔接路线查询超时，本次未返回路线。',
  unavailable: '高德地图路线服务暂时不可用，本次未返回路线。',
  failed: '衔接路线数据不可用，本次未返回路线。',
}

/** 与 leg_refresh.py._LEG_DESCRIPTIONS 逐字一致：ready leg 的固定说明 */
const LEG_REFRESH_LEG_DESCRIPTIONS = {
  walking:
    '按两端记录的 WGS84 坐标向高德地图查询步行衔接段；未重新核对地址或' +
    '地点身份，几何为路网吸附结果，端点坐标未改写。',
  driving:
    '按两端记录的 WGS84 坐标向高德地图查询驾车衔接段；未重新核对地址或' +
    '地点身份，几何为路网吸附结果，端点坐标未改写。',
}

/** 与 api_server.py._LEG_REFRESH_INVALID_BODY_DETAIL 逐字一致：唯一 422 文案 */
const LEG_REFRESH_INVALID_DETAIL =
  '请求体不符合固定端点衔接路线接口要求，本次未执行任何路线查询。'

/**
 * ready 信封的固定距离/耗时（0 距离变体固定 0/null）。
 * 来源：后端纯 service 离线探针（G 建议锚点对 s-e2e-2 → ai-tail-e2e-1），
 * 只作固定测试值；几何首末点由请求端点加固定小偏移模拟路网吸附，
 * 始终落在既有吸附容差内，不把几何首末点改写回站点坐标。
 */
const READY_PROFILES = {
  walking: { distance_m: 2850, duration_minutes: 41 },
  driving: { distance_m: 2340, duration_minutes: 9 },
}

/** 后段候选识别前缀：与 dayReplanTail.buildDayReplanTailRequest 固定说明一致 */
export const TAIL_REPLAN_INSTRUCTION_PREFIX = '【后段重规划】'

// ==================== 请求解析（镜像 pydantic strict wire） ====================

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/
const REQUEST_KEYS = new Set(['parent', 'day', 'date', 'travel_mode', 'from_stop', 'to_stop'])
const PARENT_KEYS = new Set(['trip_id', 'revision'])
const STOP_KEYS = new Set(['id', 'location'])
const LOCATION_KEYS = new Set(['lng', 'lat'])
const MAX_DAYS = 7
const MAX_ID_LENGTH = 100

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value, allowed) {
  const keys = Object.keys(value)
  if (keys.length !== allowed.size) return false
  return keys.every((key) => allowed.has(key))
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBoundedOpaqueId(value) {
  return (
    typeof value === 'string' &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= MAX_ID_LENGTH &&
    value.trim().length > 0 &&
    !CONTROL_CHARS.test(value)
  )
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** 严格 YYYY-MM-DD 且是真实日历日；与前端 isStrictDate 同口径 */
function isStrictDate(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  return day <= daysInMonth(year, month)
}

/**
 * 严格解析 leg-refresh 请求体：只接受 {parent, day, date, travel_mode,
 * from_stop, to_stop} 六个显式字段，多余字段/缺字段/bool 冒充数值/字符串数值/
 * 非有限数/越界/相同站点 id 一律形状不符（返回 null），由路由折成固定 422。
 * date 按前端契约要求显式携带（null 或合法日期）；0 坐标合法。
 * 返回投影后的新对象，调用方不得修改原 body。
 */
export function parseLegRefreshRequestBody(body) {
  if (!isPlainObject(body) || !hasExactKeys(body, REQUEST_KEYS)) return null

  const parent = body.parent
  if (!isPlainObject(parent) || !hasExactKeys(parent, PARENT_KEYS)) return null
  if (!isBoundedOpaqueId(parent.trip_id)) return null
  if (typeof parent.revision !== 'number' || !Number.isSafeInteger(parent.revision) || parent.revision < 0) {
    return null
  }

  if (typeof body.day !== 'number' || !Number.isInteger(body.day) || body.day < 1 || body.day > MAX_DAYS) {
    return null
  }
  if (body.date !== null && !isStrictDate(body.date)) return null
  if (body.travel_mode !== 'walking' && body.travel_mode !== 'driving') return null

  const readStop = (stop) => {
    if (!isPlainObject(stop) || !hasExactKeys(stop, STOP_KEYS)) return null
    if (!isBoundedOpaqueId(stop.id)) return null
    const location = stop.location
    if (!isPlainObject(location) || !hasExactKeys(location, LOCATION_KEYS)) return null
    if (!isFiniteNumber(location.lng) || location.lng < -180 || location.lng > 180) return null
    if (!isFiniteNumber(location.lat) || location.lat < -90 || location.lat > 90) return null
    return { id: stop.id, location: { lng: location.lng, lat: location.lat } }
  }
  const fromStop = readStop(body.from_stop)
  if (!fromStop) return null
  const toStop = readStop(body.to_stop)
  if (!toStop) return null
  if (fromStop.id === toStop.id) return null

  return {
    request: {
      parent: { trip_id: parent.trip_id, revision: parent.revision },
      day: body.day,
      date: body.date,
      travel_mode: body.travel_mode,
      from_stop: fromStop,
      to_stop: toStop,
    },
  }
}

/** 后端唯一 422 形状：固定 detail、不回显 input / 字段名 / 原始 body */
export function buildLegRefreshInvalidResponse() {
  return { status: 422, body: { detail: LEG_REFRESH_INVALID_DETAIL } }
}

// ==================== 响应构造（镜像 leg_refresh.py wire） ====================

function nowIso() {
  return new Date().toISOString().replace('Z', '+00:00')
}

function round6(value) {
  return Number(value.toFixed(6))
}

/** 几何首末点按固定小偏移模拟路网吸附（约 20m，远小于既有吸附容差） */
function buildSnappedGeometry(request) {
  const from = request.from_stop.location
  const to = request.to_stop.location
  return [
    { lng: round6(from.lng + 0.0002), lat: round6(from.lat - 0.0001) },
    { lng: round6((from.lng + to.lng) / 2), lat: round6((from.lat + to.lat) / 2) },
    { lng: round6(to.lng - 0.0002), lat: round6(to.lat + 0.0001) },
  ]
}

/**
 * 构造 leg-refresh 响应信封：
 * - ready / ready_zero_distance：回显请求字段 + 恰好一个 navigation leg
 *   （0 距离变体 distance_m=0、duration_minutes=null）；reason=null；
 * - 其余 typed 失败：leg=null + 固定安全 reason（逐字镜像后端）；
 * - source 固定 amap / WGS84 / 按 mode 的官方 v5 endpoint；checked_at 为当前时刻。
 * 未知模式返回 error（桩只实现约定模式）。
 */
export function buildLegRefreshResponse(mode, request) {
  if (!TAIL_LEG_REFRESH_MODES.includes(mode)) {
    return { error: `契约桩未实现的衔接路线模式：${mode}` }
  }
  const echo = {
    parent: { trip_id: request.parent.trip_id, revision: request.parent.revision },
    day: request.day,
    date: request.date,
    travel_mode: request.travel_mode,
    from_stop: {
      id: request.from_stop.id,
      location: { lng: request.from_stop.location.lng, lat: request.from_stop.location.lat },
    },
    to_stop: {
      id: request.to_stop.id,
      location: { lng: request.to_stop.location.lng, lat: request.to_stop.location.lat },
    },
  }
  const source = {
    provider: 'amap',
    coordinate_system: 'WGS84',
    endpoint: LEG_REFRESH_ENDPOINTS[request.travel_mode],
  }
  const checkedAt = nowIso()

  if (mode === 'ready' || mode === 'ready_zero_distance') {
    const profile =
      mode === 'ready' ? READY_PROFILES[request.travel_mode] : { distance_m: 0, duration_minutes: null }
    return {
      report: {
        ...echo,
        map_status: 'ready',
        leg: {
          from_stop_id: request.from_stop.id,
          to_stop_id: request.to_stop.id,
          mode: request.travel_mode,
          route_type: 'navigation',
          distance_m: profile.distance_m,
          duration_minutes: profile.duration_minutes,
          geometry: buildSnappedGeometry(request),
          description: LEG_REFRESH_LEG_DESCRIPTIONS[request.travel_mode],
        },
        reason: null,
        source,
        checked_at: checkedAt,
      },
    }
  }

  return {
    report: {
      ...echo,
      map_status: mode,
      leg: null,
      reason: LEG_REFRESH_REASONS[mode],
      source,
      checked_at: checkedAt,
    },
  }
}

// ==================== 后段候选 replan fixture（【后段重规划】专用） ====================

/**
 * 后段候选日模板（day/date 按请求回填）。首站时刻 13:00 晚于 G 建议锚点
 * s-e2e-2（10:30 + 40min 停留 = 11:10 冻结下界），不会触发 time_conflict；
 * 站点 id 独立命名空间，不与既有任何天的站点冲突。全部为固定测试值。
 */
const REPLAN_TAIL_DAY_TEMPLATE = {
  title: 'AI 契约候选·后段茶博馆线',
  summary: '契约桩固定的后段候选：两个测试站点，首站时刻满足冻结段结束下界。',
  stops: [
    {
      id: 'ai-tail-e2e-1',
      name: '杭州花圃',
      time: '13:00',
      duration_minutes: 120,
      description: '契约桩后段候选站点：首站，时刻满足冻结下界，坐标为固定测试值。',
      address: '杭州市西湖区西山路（测试地址）',
      location: { lng: 120.1264, lat: 30.2412 },
    },
    {
      id: 'ai-tail-e2e-2',
      name: '茅家埠',
      time: '15:00',
      duration_minutes: 60,
      description: '契约桩后段候选站点：第二站，坐标为固定测试值。',
      address: '杭州市西湖区茅家埠（测试地址）',
      location: { lng: 120.1148, lat: 30.2321 },
    },
  ],
}

const REPLAN_TAIL_LEG_PROFILES = {
  walking: { distance_m: 1250, duration_minutes: 19 },
  driving: { distance_m: 900, duration_minutes: 5 },
}

const REPLAN_TAIL_WARNINGS = ['契约桩提醒：后段候选为固定测试数据，不是真实模型输出。']

/**
 * 构造后段候选响应：day.day / day.date / parent 按请求回填，候选内部 leg 的
 * mode 跟随请求 travel_mode。只替换响应内容，不改整日 fixture 路径。
 */
export function buildTailReplanResponse(request) {
  const travelMode = request?.travel_mode === 'driving' ? 'driving' : 'walking'
  const [first, second] = REPLAN_TAIL_DAY_TEMPLATE.stops
  const legProfile = REPLAN_TAIL_LEG_PROFILES[travelMode]
  return {
    day: {
      day: request?.day ?? 1,
      date: request?.date ?? null,
      title: REPLAN_TAIL_DAY_TEMPLATE.title,
      summary: REPLAN_TAIL_DAY_TEMPLATE.summary,
      stops: REPLAN_TAIL_DAY_TEMPLATE.stops.map((stop) => ({
        ...stop,
        location: { lng: stop.location.lng, lat: stop.location.lat },
      })),
      legs: [
        {
          from_stop_id: first.id,
          to_stop_id: second.id,
          mode: travelMode,
          route_type: 'navigation',
          distance_m: legProfile.distance_m,
          duration_minutes: legProfile.duration_minutes,
          geometry: [
            { lng: first.location.lng, lat: first.location.lat },
            { lng: round6((first.location.lng + second.location.lng) / 2), lat: round6((first.location.lat + second.location.lat) / 2) },
            { lng: second.location.lng, lat: second.location.lat },
          ],
          description: '契约桩候选路线：固定折线，不代表真实导航。',
        },
      ],
    },
    warnings: [...REPLAN_TAIL_WARNINGS],
    map_status: 'ready',
    parent: request?.parent ?? { trip_id: '', revision: 0 },
    source: 'agent',
  }
}

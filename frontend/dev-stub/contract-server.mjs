/**
 * E2E 专用契约桩（仅 runner 创建，不提供 CLI 入口）：
 * - 默认 dev-stub/server.mjs 保持 example + 503 不变；本模块只服务浏览器验收，
 *   提供 plan / replan / map-refresh / leg-refresh / weather / poi-sources / web-sources
 *   的当前契约信封。
 * - 场景（scenario）与延迟门（gate）由 runner 持有的内存 control 控制，
 *   不暴露任何 HTTP 控制端点：控制面与数据面同进程，外部无法触碰。
 * - 每个请求记录在 requests 数组里，runner 结束时核对路径与请求体。
 * - 信封构造器（weather / poi / map / replan）全部导出，contractFixtures.test.mjs
 *   与 runner 走同一份构造器 + 前端真实 validators，不留平行构造副本。
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  buildWebSearchInvalidResponse,
  buildWebSearchReport,
  parseWebSearchRequestBody,
} from './webSourcesFixtures.mjs'
import {
  buildLegRefreshInvalidResponse,
  buildLegRefreshResponse,
  buildTailReplanResponse,
  parseLegRefreshRequestBody,
  TAIL_REPLAN_INSTRUCTION_PREFIX,
} from './tailBoundaryFixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = JSON.parse(readFileSync(resolve(here, 'contractFixtures.json'), 'utf-8'))

/**
 * 场景状态。runner 在场景间切换：
 * - planMode: 'ok' | 'fail503'
 * - planDelay / replanDelay: gate（null 表示直通；非 null 时请求挂起直到 release）
 */
export function createContractState() {
  return {
    planMode: 'ok',
    planDelay: null,
    replanDelay: null,
    /** 网页资料模式：null = 默认 available；'no_results' | 'no_usable_results' | 'no_key' | 'unavailable' */
    webSourcesMode: null,
    /** 网页资料 deferred gate：null 直通；非 null 时请求挂起直到 release（供关闭迟到场景） */
    webSourcesDelay: null,
    /**
     * 衔接路线模式：null = 默认 ready；'ready_zero_distance' | 'no_key' | 'timeout' |
     * 'unavailable' | 'failed'（tailBoundaryFixtures.TAIL_LEG_REFRESH_MODES）
     */
    legRefreshMode: null,
    /** 衔接路线 deferred gate：null 直通；非 null 时请求挂起直到 release */
    legRefreshDelay: null,
    /** 每条 { path, method, body, seq, settled }；校验与定序用 */
    requests: [],
    /** 每条 { path, status, seq }；审计用 */
    responses: [],
  }
}

function nowIso() {
  return new Date().toISOString().replace('Z', '+00:00')
}

function nextSeq(control) {
  return control.requests.length
}

function isPlainBody(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 固定 1×1 蓝色 PNG（Leaflet 只要求是合法图片即可标记 tile-loaded） */
export const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** runner 拦截瓦片请求时用的 base64 形态（同一图块） */
export const TILE_PNG_BASE64 = TILE_PNG.toString('base64')

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (raw === '') return resolveBody(undefined)
      try {
        resolveBody(JSON.parse(raw))
      } catch {
        rejectBody(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', rejectBody)
  })
}

/** 坐标按站点 id 稳定派生（西湖附近 bbox）：对任何当前行程的投影都成立 */
export function derivedCoordinate(seedText, salt = 7) {
  let hash = salt
  for (let index = 0; index < seedText.length; index += 1) {
    hash = (hash * 31 + seedText.charCodeAt(index)) >>> 0
  }
  return { lng: 120.1 + (hash % 900) / 10000, lat: 30.15 + ((hash >> 5) % 900) / 10000 }
}

/**
 * 构造 map-refresh 响应信封：坐标与路线按请求站点 id 派生，
 * 任何当前行程（含本地编辑/AI 应用后的 fork）都满足 validateMapRefreshResponse。
 */
export function buildMapRefreshResponse(request) {
  const requestedStops = Array.isArray(request?.stops) ? request.stops : []
  const located = requestedStops.map((stop) => ({
    id: stop.id,
    location: derivedCoordinate(String(stop.id), 7),
    resolved_address: `${stop.address || stop.name || stop.id}（契约桩解析）`,
  }))
  const legs = []
  for (let index = 0; index < located.length - 1; index += 1) {
    const from = located[index].location
    const to = located[index + 1].location
    legs.push({
      from_stop_id: located[index].id,
      to_stop_id: located[index + 1].id,
      mode: request?.travel_mode === 'driving' ? 'driving' : 'walking',
      route_type: 'navigation',
      distance_m: 600 + index * 250,
      duration_minutes: 9 + index * 3,
      geometry: [
        from,
        { lng: (from.lng + to.lng) / 2, lat: (from.lat + to.lat) / 2 },
        to,
      ],
      description: '契约桩测试路线：按请求站点派生的固定折线，不代表真实导航。',
    })
  }
  return {
    day: request?.day ?? 1,
    date: request?.date ?? null,
    parent: request?.parent ?? { trip_id: '', revision: 0 },
    map_status: 'ready',
    stops: located,
    unresolved: [],
    legs,
    warnings: ['契约桩提醒：坐标与路线为按请求派生的固定测试值，不代表真实地图服务。'],
  }
}

/** 构造 replan 响应信封：day.date 按请求回填（DAY_KEYS 不含 date，但校验要求与请求一致） */
export function buildReplanResponse(request) {
  const day = fixtures.replanDay.day
  return {
    day: { ...day, date: request?.date ?? null },
    warnings: fixtures.replanDay.warnings,
    map_status: 'ready',
    parent: request?.parent ?? { trip_id: '', revision: 0 },
    source: 'agent',
  }
}

/** 构造 plan / example 行程信封；example 变体标题/来源可区分，生成前后 UI 变化才可断言 */
export function buildPlanTrip(variant = 'plan') {
  if (variant === 'example') {
    return { ...fixtures.planTrip, source: 'example', title: '契约桩示例·杭州三日（离线验收）' }
  }
  return fixtures.planTrip
}

/**
 * 实例化 weather 信封：requested/grid 用查询坐标，forecast.date 用查询日期。
 * 返回 { report } 或 { error }（非法查询给 400）。
 */
export function buildWeatherReport(query) {
  const lat = Number(query.get('lat'))
  const lon = Number(query.get('lon'))
  const date = query.get('date') ?? ''
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'lat/lon/date 查询参数不合法' }
  }
  const round6 = (value) => Number(value.toFixed(6))
  const template = fixtures.weatherTemplate
  return {
    report: {
      ...template,
      requested_date: date,
      checked_at: nowIso(),
      fetched_at: nowIso(),
      coordinate: {
        ...template.coordinate,
        requested: { lat: round6(lat), lon: round6(lon) },
        grid: { lat: round6(lat + 0.05), lon: round6(lon + 0.05) },
      },
      forecast: { ...template.forecast, date },
    },
  }
}

/**
 * 实例化 poi 信封：requested 用查询坐标，候选位置 = 查询坐标 + 固定偏移（6 位舍入），
 * source_url 按规范链接构造，满足 validatePoiSourceReport 的全部硬校验。
 */
export function buildPoiReport(query) {
  const lat = Number(query.get('lat'))
  const lon = Number(query.get('lon'))
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { error: 'lat/lon 查询参数不合法' }
  }
  const round6 = (value) => Number(value.toFixed(6))
  const requested = { lat: round6(lat), lon: round6(lon) }
  const fetchedAt = nowIso()
  const template = fixtures.poiTemplate
  const candidates = template.elements.map((element) => ({
    element_type: element.element_type,
    element_id: element.element_id,
    name: element.name,
    location: {
      lat: round6(requested.lat + element.dlat),
      lon: round6(requested.lon + element.dlng),
    },
    distance_m: element.distance_m,
    source_url: `https://www.openstreetmap.org/${element.element_type}/${element.element_id}`,
    retrieved_at: fetchedAt,
    source_updated_at: element.source_updated_at,
    identity_status: 'unconfirmed',
    opening_hours: element.opening_hours,
    fee: element.fee,
    charge: element.charge,
  }))
  return {
    report: {
      status: 'available',
      reason: null,
      provider_http_status: 200,
      checked_at: nowIso(),
      fetched_at: fetchedAt,
      requested,
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
      source_elements_seen: template.source_elements_seen,
      candidates,
      notes: template.notes,
    },
  }
}

// ==================== 网页资料搜索（/api/web-sources/search） ====================
// 构造器与请求体/422 形状在 ./webSourcesFixtures.mjs（与 contractFixtures.test /
// webSourcesFixtures.test 同源）；这里只保留路由接线与 control 状态。

/**
 * 创建契约桩。control 由 runner 持有（createContractState 的返回值）。
 * 返回未监听的 http.Server；runner 负责 listen 与 close。
 */
export function createContractServer(control) {
  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method ?? 'GET'
      const seq = nextSeq(control)
      let body
      try {
        body = await readBody(req)
      } catch {
        // 网页资料路由沿后端合同把坏 JSON 折成同一固定 422；leg-refresh 的坏 JSON
        // 在后端也是 RequestValidationError → 固定 422（_SafeLegRefreshRoute）；
        // 其余路由保持原 400 行为
        if (method === 'POST' && path === '/api/web-sources/search') {
          const invalid = buildWebSearchInvalidResponse()
          sendJson(res, invalid.status, invalid.body, invalid.headers)
          control.requests.push({ path, method, body: undefined, seq, settled: Promise.resolve('bad_json') })
          control.responses.push({ path, status: invalid.status, seq })
          return
        }
        if (method === 'POST' && path === '/api/trips/days/leg-refresh') {
          const invalid = buildLegRefreshInvalidResponse()
          sendJson(res, invalid.status, invalid.body)
          control.requests.push({ path, method, body: undefined, seq, settled: Promise.resolve('bad_json') })
          control.responses.push({ path, status: invalid.status, seq })
          return
        }
        sendJson(res, 400, { detail: '请求体不是合法 JSON' })
        control.requests.push({ path, method, body: undefined, seq, settled: Promise.resolve('bad_json') })
        control.responses.push({ path, status: 400, seq })
        return
      }
      let settleRecorded
      const settledPromise = new Promise((resolveSettled) => {
        settleRecorded = resolveSettled
      })
      control.requests.push({
        path,
        method,
        body,
        seq,
        /** resolve 值：'responded' | 'aborted'（客户端断开）；runner 据此显式定序 */
        settled: settledPromise,
      })

      const record = (status) => {
        control.responses.push({ path, status, seq })
        settleRecorded(status === 0 ? 'aborted' : 'responded')
      }

      // 客户端（浏览器）提前断开：abort 类适配器场景的显式信号
      res.on('close', () => {
        if (!res.writableEnded) settleRecorded('aborted')
      })

      try {
        if (method === 'GET' && (path === '/api/health' || path === '/health')) {
          sendJson(res, 200, { status: 'healthy', planner_ready: true, amap_configured: true })
          record(200)
          return
        }

        if (method === 'GET' && path === '/api/trips/example') {
          sendJson(res, 200, buildPlanTrip('example'))
          record(200)
          return
        }

        if (method === 'POST' && path === '/api/trips/plan') {
          if (control.planMode === 'fail503') {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
            res.end('upstream unavailable (contract stub)')
            record(503)
            return
          }
          if (control.planDelay) {
            await new Promise((resolveGate) => control.planDelay.waiters.push(resolveGate))
          }
          sendJson(res, 200, buildPlanTrip('plan'))
          record(200)
          return
        }

        if (method === 'POST' && path === '/api/trips/days/replan') {
          if (control.replanDelay) {
            await new Promise((resolveGate) => control.replanDelay.waiters.push(resolveGate))
          }
          // 【后段重规划】走专用尾段候选：首站时刻满足冻结段下界，否则 knownTailLowerBound
          // 会以 time_conflict 拒绝组合、E2E 到不了衔接路线按钮；整日请求原样走既有 fixture。
          const isTailReplan =
            isPlainBody(body) &&
            typeof body.instruction === 'string' &&
            body.instruction.startsWith(TAIL_REPLAN_INSTRUCTION_PREFIX)
          const built = isTailReplan ? buildTailReplanResponse(body) : buildReplanResponse(body)
          sendJson(res, 200, built)
          record(200)
          return
        }

        if (method === 'POST' && path === '/api/trips/days/map-refresh') {
          sendJson(res, 200, buildMapRefreshResponse(body))
          record(200)
          return
        }

        if (method === 'POST' && path === '/api/trips/days/leg-refresh') {
          // 本地形状不符：固定 422，0 次上游尝试，绝不回显 input / 原始 body。
          const parsed = parseLegRefreshRequestBody(body)
          if (!parsed) {
            const invalid = buildLegRefreshInvalidResponse()
            sendJson(res, invalid.status, invalid.body)
            record(invalid.status)
            return
          }
          if (control.legRefreshDelay) {
            await new Promise((resolveGate) => control.legRefreshDelay.waiters.push(resolveGate))
          }
          // 离线 fixture：不调用真实高德；一次显式请求只记录一次、只产出一个信封。
          const built = buildLegRefreshResponse(control.legRefreshMode ?? 'ready', parsed.request)
          if (built.error) {
            sendJson(res, 500, { detail: built.error })
            record(500)
            return
          }
          sendJson(res, 200, built.report)
          record(200)
          return
        }

        if (method === 'GET' && path === '/api/weather/day') {
          const built = buildWeatherReport(url.searchParams)
          if (built.error) {
            sendJson(res, 400, { detail: built.error })
            record(400)
            return
          }
          sendJson(res, 200, built.report)
          record(200)
          return
        }

        if (method === 'GET' && path === '/api/poi-sources/nearby') {
          const built = buildPoiReport(url.searchParams)
          if (built.error) {
            sendJson(res, 400, { detail: built.error })
            record(400)
            return
          }
          sendJson(res, 200, built.report)
          record(200)
          return
        }

        if (method === 'POST' && path === '/api/web-sources/search') {
          // 本地形状不符：固定 422，0 次上游尝试，绝不回显原始 body。
          // 注意 query 不在此 trim：client 已规范化，桩原样 echo（FEFF 合法保留）。
          const parsed = parseWebSearchRequestBody(body)
          if (!parsed) {
            const invalid = buildWebSearchInvalidResponse()
            sendJson(res, invalid.status, invalid.body, invalid.headers)
            record(invalid.status)
            return
          }
          if (control.webSourcesDelay) {
            await new Promise((resolveGate) => control.webSourcesDelay.waiters.push(resolveGate))
          }
          const built = buildWebSearchReport(control.webSourcesMode ?? 'available', parsed.query)
          if (built.error) {
            sendJson(res, 500, { detail: built.error })
            record(500)
            return
          }
          // 与后端一致：typed 信封 HTTP 200 + x-web-sources-status 头（含业务失败）
          sendJson(res, 200, built.report, { 'x-web-sources-status': built.report.status })
          record(200)
          return
        }

        sendJson(res, 404, { detail: `契约桩未实现 ${method} ${path}` })
        record(404)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { detail: '契约桩内部错误' })
        else res.end()
        record(500)
      }
    })()
  })
}

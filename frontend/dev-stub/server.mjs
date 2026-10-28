/**
 * 开发桩服务器（仅前端联调，不属于生产代码）：
 * - GET /health、GET /api/health：探活
 * - GET  /api/trips/example：固定的杭州示例行程，标题、摘要、warnings 都标注「固定示例」
 * - POST /api/trips/plan：503，明确说明本桩不提供真实规划
 *
 * 示例中的路段只有「示意直线 straight_line」或「路线不可用 unavailable」：
 * distance_m / duration_minutes 一律为 null，geometry 为空，
 * 既不代表地图服务的导航结果，也不来自智能体。
 *
 * 用法：node dev-stub/server.mjs  （监听 127.0.0.1:8001）
 */
import http from 'node:http'
import { pathToFileURL } from 'node:url'

export const STUB_PLAN_DETAIL = '开发示例服务不提供真实规划，请启动配置密钥的后端（api_server.py）后再试。'

const PORT = Number(process.env.STUB_PORT || 8001)

/** 固定示例行程：不随请求变化，也不包含任何真实导航数据 */
export function exampleTrip() {
  return {
    id: 'trip-stub-example-1',
    source: 'example',
    destination: '杭州（固定示例）',
    title: '【固定示例】杭州三日漫步路书',
    summary: '一份写死的杭州三日示例，只用来检查界面渲染，不随请求变化。它不是真实规划结果，也没有真实导航数据；真实行程请启动后端生成。',
    map_coordinate_system: 'WGS84',
    warnings: [
      '固定示例（开发桩数据）：仅用于前端联调，不是真实行程，也不来自智能体。',
      '不含真实导航：所有路段仅为「示意直线」或「路线不可用」，距离与耗时一律未知（null）。',
      '需要真实规划请启动配置密钥的后端（api_server.py）；本桩不提供该能力。',
    ],
    days: [
      {
        day: 1,
        date: '2026-11-07',
        title: '西湖环湖',
        summary: '从断桥出发沿白堤步行，经孤山，午后到湖滨休整。',
        stops: [
          { id: 's1', name: '断桥残雪', time: '09:00', duration_minutes: 40, description: '白堤东端，冬日雪后桥面半融半积，远望如断。此处是环湖起点，早上人少光线好。', address: '杭州市西湖区白堤东端', location: { lng: 120.1576, lat: 30.2726 } },
          { id: 's2', name: '平湖秋月', time: '10:00', duration_minutes: 30, description: '孤山东南角的临湖平台，视野开阔，适合歇脚看水。', address: '杭州市西湖区孤山路', location: { lng: 120.1522, lat: 30.2631 } },
          { id: 's3', name: '浙江省博物馆（孤山馆区）', time: '10:40', duration_minutes: 90, description: '看一小时的江南文物常设展，注意周一闭馆。', address: '杭州市西湖区孤山路25号', location: { lng: 120.1493, lat: 30.2604 } },
          { id: 's4', name: '楼外楼', time: '12:10', duration_minutes: 60, description: '百年老店，西湖醋鱼与龙井虾仁。饭点人多，建议错峰。', address: '杭州市西湖区孤山路30号', location: { lng: 120.1486, lat: 30.2595 } },
          { id: 's5', name: '湖滨晴雨', time: '14:00', duration_minutes: 50, description: '湖滨步行街与西湖交界，商业配套全，适合休整与买水。', address: '杭州市上城区湖滨路', location: { lng: 120.1622, lat: 30.2531 } },
        ],
        legs: [
          { from_stop_id: 's1', to_stop_id: 's2', mode: 'walking', route_type: 'straight_line', distance_m: null, duration_minutes: null, geometry: [], description: '固定示例路段：地图上只连两点示意，未提供真实折线、距离与耗时。' },
          { from_stop_id: 's2', to_stop_id: 's3', mode: 'walking', route_type: 'straight_line', distance_m: null, duration_minutes: null, geometry: [], description: '固定示例路段：两点直连示意，不代表实际步行路线。' },
          { from_stop_id: 's3', to_stop_id: 's4', mode: 'walking', route_type: 'straight_line', distance_m: null, duration_minutes: null, geometry: [], description: '固定示例路段：两点直连示意，距离与耗时未知。' },
          { from_stop_id: 's4', to_stop_id: 's5', mode: 'driving', route_type: 'unavailable', distance_m: null, duration_minutes: null, geometry: [], description: '路线不可用：固定示例未提供本段真实路线，地图上不画线。' },
        ],
      },
      {
        day: 2,
        date: '2026-11-08',
        title: '运河与老巷',
        summary: '拱宸桥一带的运河老肌理，节奏放慢。',
        stops: [
          { id: 's6', name: '拱宸桥', time: '09:30', duration_minutes: 40, description: '京杭大运河南端终点标志，三孔石拱桥，桥面坡度缓。', address: '杭州市拱墅区桥弄街', location: { lng: 120.1404, lat: 30.3299 } },
          { id: 's7', name: '桥西历史文化街区', time: '10:20', duration_minutes: 80, description: '保留下来的厂房与里弄，手作店与茶馆适合慢逛。', address: '杭州市拱墅区小河路', location: { lng: 120.1371, lat: 30.3258 } },
          { id: 's8', name: '中国伞博物馆', time: '13:30', duration_minutes: 60, description: '伞的工艺史展陈，免费参观，注意周一闭馆。', address: '杭州市拱墅区小河路336号', location: { lng: 120.1358, lat: 30.3237 } },
        ],
        legs: [
          { from_stop_id: 's6', to_stop_id: 's7', mode: 'walking', route_type: 'straight_line', distance_m: null, duration_minutes: null, geometry: [], description: '固定示例路段：两点直连示意，距离与耗时未知。' },
          { from_stop_id: 's7', to_stop_id: 's8', mode: 'walking', route_type: 'straight_line', distance_m: null, duration_minutes: null, geometry: [], description: '固定示例路段：两点直连示意，距离与耗时未知。' },
        ],
      },
      {
        day: 3,
        date: '2026-11-09',
        title: '龙井问茶',
        summary: '茶园半日，回程前留白。',
        stops: [
          { id: 's9', name: '龙井村', time: '09:30', duration_minutes: 120, description: '狮峰龙井核心产区，村内茶舍可小坐，春季有茶农炒茶。', address: '杭州市西湖区龙井路', location: { lng: 120.1131, lat: 30.2226 } },
          { id: 's10', name: '九溪烟树', time: '13:00', duration_minutes: 90, description: '溪流、枫杨与茶园交错的谷地，步行道平缓。', address: '杭州市西湖区九溪路', location: { lng: 120.1252, lat: 30.1972 } },
        ],
        legs: [
          { from_stop_id: 's9', to_stop_id: 's10', mode: 'driving', route_type: 'unavailable', distance_m: null, duration_minutes: null, geometry: [], description: '路线不可用：固定示例不提供路线几何，地图上不画线，距离与耗时未知。' },
        ],
      },
    ],
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** 供测试直接起服务；只有直接执行 node dev-stub/server.mjs 时才监听端口 */
export function createStubServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/health' || url.pathname === '/api/health') {
      sendJson(res, 200, { status: 'healthy', stub: true })
      return
    }
    if (url.pathname === '/api/trips/example' && req.method === 'GET') {
      sendJson(res, 200, exampleTrip())
      return
    }
    if (url.pathname === '/api/trips/plan' && req.method === 'POST') {
      // 不伪造智能体结果，也不回显请求里的目的地
      req.resume()
      sendJson(res, 503, { detail: STUB_PLAN_DETAIL, stub: true })
      return
    }
    sendJson(res, 404, { detail: `未实现的路径 ${url.pathname}` })
  })
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const server = createStubServer()
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[dev-stub] 开发示例服务已启动: http://127.0.0.1:${PORT}（仅固定示例与探活，不提供规划）`)
  })
}

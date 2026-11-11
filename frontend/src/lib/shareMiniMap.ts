/**
 * 五期 S5 · 路线小地图（纯 SVG）。
 *
 * 边界：
 * - 纯函数：只读 TripDay，不碰 DOM / 存储 / 网络 / 时钟；同一输入两次输出逐字节相同。
 * - 投影只做等距圆柱近似（经度按中心纬度余弦压缩），不是导航结果，也不请求地图瓦片。
 * - 三种路段：navigation 实线；straight_line 虚线并标「示意」；unavailable 不画线，
 *   只在图例里写「路线未知 N 段」。navigation 的 geometry 不足 2 个合法点时降级为
 *   示意直线（与 lib/mapData.ts 同一口径），绝不冒充真实导航。
 * - 缺坐标 / 非法坐标的站点不进图，按原顺序列在 unknownStops，绝不补 (0,0) 或默认坐标。
 * - 所有用户文本（站名、aria-label）都做 XML 转义；控制字符直接移除。
 * - 站点编号使用当日原始顺序（含缺坐标站点占号），方便与路书正文对照。
 * - 分享卡尾部的组合块固定 1080×1440，与既有六风格卡片的 PNG 光栅化尺寸一致，
 *   不改动 lib/shareCard.ts 的任何模板。
 */

import type { RouteType, TripDay, TripLocation } from './api'
import { validCoord } from './format'
import { pandaWatermarkFor } from './travelEasterEggs'

export const SHARE_MINI_MAP_WIDTH = 960
export const SHARE_MINI_MAP_HEIGHT = 320

const PADDING_X = 36
const PADDING_TOP = 24
const PADDING_BOTTOM = 64
const DOT_RADIUS = 12

const CARD_WIDTH = 1080
const CARD_HEIGHT = 1440

export interface ShareMiniMap {
  /** null = 本日没有任何可用坐标，调用方应省略整个小地图块。 */
  svg: string | null
  /** 缺坐标 / 非法坐标的站名，按当日顺序；不伪造坐标。 */
  unknownStops: string[]
  /** 实际出现的路段类型，按首次出现顺序。 */
  routeTypes: RouteType[]
}

/** 成都暗号水印选项（六期 S3 彩蛋①）：传 destination 才可能触发。 */
export interface ShareMiniMapOptions {
  /** 行程目的地；含「成都」时小地图角落追加淡色小熊猫剪影水印（纯装饰）。 */
  destination?: string
}

interface LocatedStop {
  /** 当日 1-based 序号（缺坐标站点也占号）。 */
  index: number
  stopId: string
  name: string
  loc: { lng: number; lat: number }
}

interface Point {
  lng: number
  lat: number
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function escapeXml(value: string): string {
  return value
    .replace(CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 固定 1 位小数；整数不带小数点，避免不同格式器产生差异。 */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function locatedStops(day: TripDay): { located: LocatedStop[]; unknownStops: string[] } {
  const located: LocatedStop[] = []
  const unknownStops: string[] = []
  day.stops.forEach((stop, index) => {
    const loc = validCoord(stop.location)
    if (loc) {
      located.push({ index: index + 1, stopId: stop.id, name: stop.name, loc })
    } else {
      unknownStops.push(stop.name)
    }
  })
  return { located, unknownStops }
}

function boundsPoints(day: TripDay, located: LocatedStop[]): Point[] {
  const points: Point[] = located.map((item) => item.loc)
  for (const leg of day.legs) {
    if (leg.route_type !== 'navigation') continue
    for (const raw of leg.geometry ?? []) {
      const point = validCoord(raw as TripLocation)
      if (point) points.push(point)
    }
  }
  return points
}

interface Projection {
  project: (loc: { lng: number; lat: number }) => { x: number; y: number }
}

function buildProjection(points: Point[]): Projection {
  let minLng = Number.POSITIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.lng < minLng) minLng = point.lng
    if (point.lng > maxLng) maxLng = point.lng
    if (point.lat < minLat) minLat = point.lat
    if (point.lat > maxLat) maxLat = point.lat
  }

  const centerLat = (minLat + maxLat) / 2
  const cosLat = Math.max(0.01, Math.cos((centerLat * Math.PI) / 180))
  const minX = minLng * cosLat
  const maxX = maxLng * cosLat
  const minY = -maxLat
  const maxY = -minLat
  const spanX = Math.max(maxX - minX, 1e-6)
  const spanY = Math.max(maxY - minY, 1e-6)
  const innerWidth = SHARE_MINI_MAP_WIDTH - PADDING_X * 2
  const innerHeight = SHARE_MINI_MAP_HEIGHT - PADDING_TOP - PADDING_BOTTOM
  const scale = Math.min(innerWidth / spanX, innerHeight / spanY)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const plotCenterX = SHARE_MINI_MAP_WIDTH / 2
  const plotCenterY = PADDING_TOP + innerHeight / 2

  return {
    project: (loc) => ({
      x: plotCenterX + (loc.lng * cosLat - centerX) * scale,
      y: plotCenterY + (-loc.lat - centerY) * scale,
    }),
  }
}

/**
 * 生成某一天的路线小地图。无任何可用坐标时返回 svg=null（调用方省略整块，
 * 而不是画一张空地图）。
 *
 * 六期 S3 彩蛋①（成都暗号）：options.destination 含「成都」时，SVG 末尾追加一枚
 * 淡色小熊猫剪影水印（确定性输出、纯装饰）。水印在所有路线与站点之后绘制，
 * 不改变几何、坐标分组、图例与既有断言的结构；非成都 / 不传 destination 无此块。
 */
export function buildShareMiniMap(day: TripDay, options: ShareMiniMapOptions = {}): ShareMiniMap {
  const { located, unknownStops } = locatedStops(day)
  if (located.length === 0) {
    return { svg: null, unknownStops, routeTypes: [] }
  }

  const { project } = buildProjection(boundsPoints(day, located))
  const locatedById = new Map(located.map((item) => [item.stopId, item]))

  const routeTypes: RouteType[] = []
  const seenTypes = new Set<RouteType>()
  const addRouteType = (type: RouteType) => {
    if (seenTypes.has(type)) return
    seenTypes.add(type)
    routeTypes.push(type)
  }

  const routeShapes: string[] = []
  const straightLabels: string[] = []
  let unavailableCount = 0

  for (const leg of day.legs) {
    const from = locatedById.get(leg.from_stop_id)
    const to = locatedById.get(leg.to_stop_id)

    if (leg.route_type === 'unavailable' || !from || !to) {
      addRouteType('unavailable')
      unavailableCount += 1
      continue
    }

    if (leg.route_type === 'navigation') {
      const geometry: Point[] = []
      for (const raw of leg.geometry ?? []) {
        const point = validCoord(raw as TripLocation)
        if (point) geometry.push(point)
      }
      if (geometry.length >= 2) {
        addRouteType('navigation')
        const points = geometry
          .map((point) => {
            const projected = project(point)
            return `${formatNumber(projected.x)},${formatNumber(projected.y)}`
          })
          .join(' ')
        routeShapes.push(
          `<polyline data-route="navigation" fill="none" stroke="#2f6f4e" stroke-width="3"` +
            ` stroke-linecap="round" stroke-linejoin="round" points="${points}"/>`,
        )
        continue
      }
      // geometry 不足：降级为示意直线，明确不是导航结果
    }

    addRouteType('straight_line')
    const a = project(from.loc)
    const b = project(to.loc)
    routeShapes.push(
      `<line data-route="straight_line" x1="${formatNumber(a.x)}" y1="${formatNumber(a.y)}"` +
        ` x2="${formatNumber(b.x)}" y2="${formatNumber(b.y)}" stroke="#8a7f68" stroke-width="2.5"` +
        ` stroke-dasharray="8 6" stroke-linecap="round"/>`,
    )
    // 标签放在中点垂直偏移处：水平线不再压住端点圆点（S8 验收 Minor）。
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy) || 1
    const labelX = (a.x + b.x) / 2 + (-dy / length) * 14
    const labelY = (a.y + b.y) / 2 + (dx / length) * 14
    straightLabels.push(
      `<text data-route-label="straight_line" x="${formatNumber(labelX)}"` +
        ` y="${formatNumber(labelY)}" text-anchor="middle" dominant-baseline="central" font-size="14"` +
        ` fill="#6b6355">示意</text>`,
    )
  }

  const dots = located.map((item) => {
    const point = project(item.loc)
    return (
      `<g data-stop-index="${item.index}" data-stop-id="${escapeXml(item.stopId)}">` +
      `<title>第 ${item.index} 站：${escapeXml(item.name)}</title>` +
      `<circle cx="${formatNumber(point.x)}" cy="${formatNumber(point.y)}" r="${DOT_RADIUS}"` +
      ` fill="#ffffff" stroke="#2f3b34" stroke-width="2"/>` +
      `<text x="${formatNumber(point.x)}" y="${formatNumber(point.y)}" text-anchor="middle"` +
      ` dominant-baseline="central" font-size="13" font-weight="700" fill="#2f3b34">${item.index}</text>` +
      `</g>`
    )
  })

  const legendParts: string[] = []
  if (seenTypes.has('navigation')) legendParts.push('实线：导航路线')
  if (seenTypes.has('straight_line')) legendParts.push('虚线：示意直线（非导航）')
  if (seenTypes.has('unavailable')) legendParts.push(`路线未知：${unavailableCount} 段`)
  if (legendParts.length === 0) legendParts.push('本日没有可绘制的路段')

  const legend =
    `<text x="${PADDING_X}" y="${SHARE_MINI_MAP_HEIGHT - 24}" font-size="14" fill="#6b6355">` +
    `${escapeXml(legendParts.join(' · '))}</text>`

  const aria =
    `第 ${day.day} 天路线小地图：${located.length} 个可定位站点` +
    (unknownStops.length > 0 ? `，${unknownStops.length} 个位置未知` : '')

  // 成都暗号（六期 S3 彩蛋①）：水印放最后（贴右下角），不遮版心的站点编号圆点；
  // 确定性片段，不影响几何、图例与 aria。
  const watermark = pandaWatermarkFor(options.destination ?? '')
  const watermarkFragment = watermark === null ? '' : watermark.svgFragment

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHARE_MINI_MAP_WIDTH} ${SHARE_MINI_MAP_HEIGHT}"` +
    ` width="${SHARE_MINI_MAP_WIDTH}" height="${SHARE_MINI_MAP_HEIGHT}" role="img"` +
    ` aria-label="${escapeXml(aria)}" data-mini-map="true">` +
    `<title>${escapeXml(aria)}</title>` +
    `<rect x="0" y="0" width="${SHARE_MINI_MAP_WIDTH}" height="${SHARE_MINI_MAP_HEIGHT}" rx="12"` +
    ` fill="#f8f5ec" stroke="#d8cfba" stroke-width="1.5"/>` +
    routeShapes.join('') +
    straightLabels.join('') +
    dots.join('') +
    legend +
    watermarkFragment +
    `</svg>`

  return { svg, unknownStops, routeTypes }
}

function svgInner(svg: string): string | null {
  const start = svg.indexOf('>')
  const end = svg.lastIndexOf('</svg>')
  if (start < 0 || end <= start) return null
  return svg.slice(start + 1, end)
}

export interface ShareCardMiniMapOptions {
  /** 组合块的无障碍标题；缺省「路线小地图」。 */
  label?: string
  /**
   * 组合块底色；传所选卡片的模板背景（shareCardThemeColors），深色卡不会在
   * 两侧露出浅色边带。缺省沿用旧底色（仅调用方未传时）。
   */
  background?: string
  /** 组合块正文色（标题）；缺省沿用旧深棕色。 */
  ink?: string
  /** 组合块弱化文字色（位置未知提示、分隔线）；缺省沿用旧灰棕色。 */
  muted?: string
}

/**
 * 把路线小地图作为统一尾部块拼到既有六风格卡片下方（固定 1080×1440）。
 * - 不改 lib/shareCard.ts 的模板：只取卡片的 inner SVG，缩放后放进新根节点。
 * - 小地图无坐标（svg=null）时原样返回卡片 SVG，不添加空块。
 * - 缺坐标站点在底部再列一次「位置未知」；最多展示 3 个名字，其余用数量概括，
 *   完整名单在离线路书里逐条列出。
 */
export function appendMiniMapToShareCard(
  cardSvg: string,
  map: ShareMiniMap,
  options: ShareCardMiniMapOptions = {},
): string {
  if (map.svg === null) return cardSvg
  const cardInner = svgInner(cardSvg)
  const mapInner = svgInner(map.svg)
  if (cardInner === null || mapInner === null) return cardSvg

  const unknown = map.unknownStops.map((name) => name.trim()).filter((name) => name !== '')
  const unknownText =
    unknown.length === 0
      ? ''
      : `位置未知：${unknown.slice(0, 3).join('、')}` +
        (unknown.length > 3 ? ` 等 ${unknown.length} 处` : '')
  const label = options.label ?? '路线小地图'
  const hexOr = (value: string | undefined, fallback: string) =>
    value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
  const background = hexOr(options.background, '#fbf8f1')
  const ink = hexOr(options.ink, '#3f3a30')
  const muted = hexOr(options.muted, '#6b6355')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}"` +
    ` width="${CARD_WIDTH}" height="${CARD_HEIGHT}" role="img"` +
    ` aria-label="${escapeXml(`${label} · 分享卡`)}" data-share-minimap="true">` +
    `<rect x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${background}"/>` +
    `<g transform="translate(151.2 0) scale(0.72)">${cardInner}</g>` +
    `<line x1="48" y1="1052" x2="1032" y2="1052" stroke="${muted}" stroke-opacity="0.55" stroke-width="1.5"/>` +
    `<text x="540" y="1086" text-anchor="middle" font-family="system-ui, sans-serif"` +
    ` font-size="28" font-weight="700" fill="${ink}">${escapeXml(label)}</text>` +
    `<g transform="translate(60 1100)">${mapInner}</g>` +
    (unknownText === ''
      ? ''
      : `<text x="540" y="1432" text-anchor="middle" font-family="system-ui, sans-serif"` +
        ` font-size="15" fill="${muted}">${escapeXml(unknownText)}</text>`) +
    `</svg>`
  )
}

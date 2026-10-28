import type { TripStop } from './api'

/** 三种路段类型的展示语义 */
export const ROUTE_LABELS = {
  navigation: '地图路线',
  straight_line: '示意直线',
  unavailable: '路线不可用',
} as const

export const MODE_LABELS = {
  walking: '步行',
  driving: '驾车',
} as const

/** 时刻字符串兜底清洗：把后端可能出现的 "09:00:00" 折叠为 "09:00" */
export function displayTime(time: string): string {
  const m = /^(\d{1,2}:\d{2})(?::\d{2})?$/.exec(time.trim())
  return m ? m[1] : time.trim()
}

export function formatDuration(minutes: number | null): string {
  if (minutes == null || Number.isNaN(minutes)) return '时长未知'
  if (minutes <= 0) return '约 0 分钟'
  if (minutes < 60) return `约 ${Math.round(minutes)} 分钟`
  const h = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  return rest > 0 ? `约 ${h} 小时 ${rest} 分钟` : `约 ${h} 小时`
}

export function formatDistance(meters: number | null): string {
  if (meters == null || Number.isNaN(meters) || meters < 0) return '距离未知'
  if (meters < 1000) return `${Math.round(meters)} 米`
  return `${(meters / 1000).toFixed(1)} 公里`
}

/** 日期展示：无时区歧义，date 字符串按纯日期解析（YYYY-MM-DD） */
export function formatDate(date: string | null): string {
  if (!date) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) return date
  const [, y, mo, d] = m
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const dt = new Date(Number(y), Number(mo) - 1, Number(d))
  if (Number.isNaN(dt.getTime())) return date
  return `${y} 年 ${Number(mo)} 月 ${Number(d)} 日 · ${weekdays[dt.getDay()]}`
}

/** 站点在 OSM 上的检索词：名称 + 地址，避免捏造详情链接 */
export function stopSearchQuery(stop: TripStop): string {
  return stop.address ? `${stop.name} ${stop.address}` : stop.name
}

export function osmSearchUrl(stop: TripStop): string {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(stopSearchQuery(stop))}`
}

/** 数值清洗：非法坐标返回 null */
export function validCoord(loc: { lng: number; lat: number } | null): { lng: number; lat: number } | null {
  if (!loc) return null
  const { lng, lat } = loc
  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  if (lat < -90 || lat > 90) return null
  if (lng < -180 || lng > 180) return null
  return { lng, lat }
}

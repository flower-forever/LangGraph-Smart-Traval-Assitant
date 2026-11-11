/**
 * 五期 S5 · 离线 HTML 路书（单文件）。
 *
 * 边界：
 * - 纯函数生成：只读 Trip / PoiCardsRecordV1 / now，不碰 DOM、存储、网络。
 * - 单文件：CSS 与脚本全部内联；不引用远程脚本、字体、图片、地图瓦片，
 *   页面还带 CSP（default-src 'none'）兜底，断网可打开。
 * - 每日 tab；站点含时间 / 停留 / 地址 / 到站交通；来源徽章复用 S2
 *   `projectStopFacts` 的三态（有来源（待核对）/ 未核实 / 未知），永不显示「已核实」。
 * - 路线小地图复用 lib/shareMiniMap.ts；缺坐标站点单列「位置未知」，不伪造坐标。
 *   六期 S3 彩蛋①：目的地带「成都」时小地图角落追加淡色小熊猫剪影水印（纯装饰）。
 * - 所有用户文本按 HTML 文本 / 属性上下文完整转义；用户文本里的网址只显示为文本。
 * - 输出上限 2 MiB（UTF-8 实际字节）：超限 fail-closed，返回明确失败，不截断。
 * - 文件名安全化复用 lib/shareCardFile.ts 的同一口径（路径分隔符 / Windows 保留字符）。
 */

import type { Trip, TripDay, TripLeg, TripStop } from './api'
import { displayTime, formatDistance, formatDuration, MODE_LABELS } from './format'
import type { PoiCardImageSource, PoiCardsRecordV1 } from './poiCards'
import { buildShareMiniMap } from './shareMiniMap'
import { safeShareCardFileName } from './shareCardFile'
import { utf8ByteLength } from './savedTrips'
import {
  projectStopFacts,
  STOP_FACT_STALE_DAYS,
  type StopFactField,
  type StopFactStatus,
  type StopFacts,
} from './stopFacts'

export const MAX_ROADBOOK_HTML_BYTES = 2 * 1024 * 1024
export const ROADBOOK_MIME_TYPE = 'text/html;charset=utf-8'
export const ROADBOOK_DRAFT_BADGE = '草稿未应用，分享的是草稿'

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** HTML 文本 / 属性上下文转义；控制字符直接移除，避免不可见字符破坏排版。 */
function escapeHtml(raw: string): string {
  return raw
    .replace(CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function textOr(value: string | null | undefined, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return escapeHtml(trimmed === '' ? fallback : trimmed)
}

function numberText(value: number): string {
  return escapeHtml(String(value))
}

/** 停留：null / 非有限数 = 未知；0 是合法值（停留 0 分钟），不当作未知。 */
function stayLabel(minutes: number | null): string {
  if (minutes === null || typeof minutes !== 'number' || !Number.isFinite(minutes)) {
    return '停留未知'
  }
  return `停留 ${numberText(minutes)} 分钟`
}

/** 三态文案与 StopFactBadge 完全一致；这里集中一份，避免路书另造口径。 */
const FACT_STATUS_LABEL: Record<StopFactStatus, string> = {
  sourced: '有来源（待核对）',
  unverified: '未核实',
  unknown: '未知',
}

/** 来源键展示名与 StopFactBadge 一致。 */
const SOURCE_LABEL: Record<PoiCardImageSource, string> = {
  manual: '手动粘贴',
  tavily: '网页资料',
  osm: '协作地图',
  wikimedia: 'Wikimedia',
}

const ROUTE_TEXT: Record<TripLeg['route_type'], string> = {
  navigation: '地图路线（按记录原样，未重新计算）',
  straight_line: '示意直线（不是导航结果）',
  unavailable: '路线不可用',
}

const FACT_FIELDS: ReadonlyArray<{ key: keyof Pick<StopFacts, 'intro' | 'openingHours' | 'ticket'>; label: string }> = [
  { key: 'intro', label: '介绍' },
  { key: 'openingHours', label: '开放时间' },
  { key: 'ticket', label: '门票' },
]

/** recordedAt → 本地时区日期（与 StopFactBadge 同口径；不用 toISOString 的 UTC 日期）。 */
function recordedDateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '记录时间未知'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function factRow(label: string, fact: StopFactField): string {
  const value = fact.value === null ? '' : `<span class="fact-value">${escapeHtml(fact.value)}</span>`
  const sourceName = SOURCE_LABEL[fact.source ?? 'manual']
  const source =
    fact.status === 'sourced'
      ? `<span class="fact-source">来源：${escapeHtml(sourceName)}` +
        (fact.sourceDetail ? ` · ${escapeHtml(fact.sourceDetail)}` : '') +
        (fact.recordedAt !== null ? ` · 记录于 ${escapeHtml(recordedDateLabel(fact.recordedAt))}` : '') +
        `</span>`
      : ''
  const stale = fact.stale
    ? `<span class="fact-stale">可能过期（超过 ${STOP_FACT_STALE_DAYS} 天）</span>`
    : ''
  return (
    `<li><span class="fact-label">${escapeHtml(label)}</span>` +
    `${value}<span class="badge badge-${fact.status}">${FACT_STATUS_LABEL[fact.status]}</span>` +
    `${source}${stale}</li>`
  )
}

function factsHtml(stop: TripStop, poiCards: PoiCardsRecordV1 | null, now: number): string {
  const facts = projectStopFacts(stop, poiCards, now)
  const heading = facts.matched
    ? `资料卡：${escapeHtml(facts.cardName ?? stop.name)}（按名称匹配，请自行核对）`
    : '没有唯一匹配的资料卡，三字段均未知。'
  const rows = FACT_FIELDS.map((field) => factRow(field.label, facts[field.key])).join('')
  return (
    `<div class="facts"><p class="facts-title">信息可信度 · ${heading}</p>` +
    `<ul>${rows}</ul></div>`
  )
}

function transportHtml(leg: TripLeg | undefined): string {
  if (!leg) return '<p class="stop-transport">交通：未记录到上一站的路段。</p>'
  const parts = [
    MODE_LABELS[leg.mode] ?? '交通方式未知',
    ROUTE_TEXT[leg.route_type] ?? '路线类型未知',
    formatDistance(leg.distance_m),
    formatDuration(leg.duration_minutes),
  ]
  return `<p class="stop-transport">交通：${parts.map((part) => escapeHtml(part)).join(' · ')}</p>`
}

function stopHtml(
  stop: TripStop,
  index: number,
  day: TripDay,
  poiCards: PoiCardsRecordV1 | null,
  now: number,
): string {
  const leg = day.legs.find((item) => item.to_stop_id === stop.id)
  const time = displayTime(typeof stop.time === 'string' ? stop.time : '').trim()
  return (
    `<li class="stop" data-stop-index="${index + 1}">` +
    `<div class="stop-head"><span class="stop-index">${index + 1}</span>` +
    `<h3>${textOr(stop.name, '未命名站点')}</h3>` +
    `<span class="stop-time">${escapeHtml(time === '' ? '时间未知' : time)} · ${stayLabel(stop.duration_minutes)}</span></div>` +
    `<p class="stop-address">地址：${textOr(stop.address, '地址未知')}</p>` +
    transportHtml(leg) +
    factsHtml(stop, poiCards, now) +
    `</li>`
  )
}

function miniMapHtml(day: TripDay, destination: string): string {
  // 六期 S3 彩蛋①：目的地带「成都」时小地图角落追加淡色小熊猫剪影水印（纯装饰，
  // 不影响几何 / 坐标分组）；非成都传空串无水印。
  const map = buildShareMiniMap(day, { destination })
  const unknown = map.unknownStops.map((name) => (name.trim() === '' ? '未命名站点' : name))
  const unknownLine =
    unknown.length > 0
      ? `<p class="mini-unknown">位置未知（未画入地图）：${unknown.map(escapeHtml).join('、')}</p>`
      : ''
  if (map.svg === null) {
    return `<div class="mini-map mini-map-empty"><p>本日站点都没有可用坐标，未绘制路线小地图。</p>${unknownLine}</div>`
  }
  return `<div class="mini-map">${map.svg}${unknownLine}</div>`
}

function dayHtml(
  day: TripDay,
  index: number,
  poiCards: PoiCardsRecordV1 | null,
  now: number,
  destination: string,
): string {
  const dayNumber = numberText(day.day)
  const walking = day.legs.filter((leg) => leg.mode === 'walking').length
  const driving = day.legs.filter((leg) => leg.mode === 'driving').length
  const transportParts: string[] = []
  if (walking > 0) transportParts.push(`步行 ${walking} 段`)
  if (driving > 0) transportParts.push(`驾车 ${driving} 段`)
  const transport = transportParts.length > 0 ? transportParts.join(' · ') : '交通方式未记录'
  const summary = day.summary.trim()
  const stops =
    day.stops.length === 0
      ? '<p class="empty">本日暂无站点。</p>'
      : `<ol class="stops">${day.stops
          .map((stop, stopIndex) => stopHtml(stop, stopIndex, day, poiCards, now))
          .join('')}</ol>`

  return (
    `<section class="day" id="day-panel-${dayNumber}" data-day-panel="${dayNumber}"` +
    ` role="tabpanel" aria-labelledby="day-tab-${dayNumber}"${index === 0 ? '' : ' hidden'}>` +
    `<h2>第 ${dayNumber} 天 · ${textOr(day.title, '未命名的一天')}</h2>` +
    `<p class="day-meta">${textOr(day.date, '日期未知')} · ${day.stops.length} 个站点 · ${escapeHtml(transport)}</p>` +
    (summary === '' ? '' : `<p class="day-summary">${escapeHtml(summary)}</p>`) +
    miniMapHtml(day, destination) +
    stops +
    `</section>`
  )
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f4ec;--card:#fffdf7;--ink:#2f3b34;--muted:#6b6355;--line:#d8cfba;--accent:#8c3b2e;--ok:#2f6f4e;--warn:#8a5a00;--warn-bg:#fff4d6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.65}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 48px}
.kicker{margin:0;font-size:12px;letter-spacing:.16em;color:var(--accent);font-weight:700}
h1{margin:6px 0 4px;font-size:clamp(24px,4vw,34px);line-height:1.25;overflow-wrap:anywhere}
.meta{margin:0;color:var(--muted);font-size:14px}
.draft-badge{display:inline-block;margin:10px 0 0;padding:4px 10px;border:1px solid #b7791f;border-radius:4px;background:var(--warn-bg);color:var(--warn);font-size:13px;font-weight:700}
.notice{margin:12px 0 0;padding:10px 12px;border-left:3px solid var(--line);background:var(--card);color:var(--muted);font-size:13px}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 6px}
.tab{appearance:none;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);padding:8px 12px;font:inherit;font-size:14px;cursor:pointer}
.tab[aria-selected="true"]{border-color:var(--accent);background:#f3e3df;color:var(--accent);font-weight:700}
.day[hidden]{display:none}
.day{margin-top:18px}
h2{margin:0;font-size:22px;line-height:1.35;overflow-wrap:anywhere}
.day-meta{margin:4px 0 0;color:var(--muted);font-size:14px}
.day-summary{margin:10px 0 0;color:var(--ink)}
.mini-map{margin:16px 0 0;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.mini-map svg{display:block;width:100%;height:auto}
.mini-unknown{margin:8px 0 0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.mini-map-empty p{margin:0;color:var(--muted);font-size:13px}
.stops{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:12px}
.stop{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:12px 14px}
.stop-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.stop-index{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;border-radius:50%;background:var(--ink);color:#fff;font-size:13px;font-weight:700}
.stop h3{margin:0;font-size:18px;line-height:1.4;overflow-wrap:anywhere}
.stop-time{color:var(--muted);font-size:13px}
.stop-address,.stop-transport{margin:6px 0 0;font-size:14px;overflow-wrap:anywhere}
.stop-address{color:var(--muted)}
.facts{margin-top:10px;padding-top:8px;border-top:1px dashed var(--line)}
.facts-title{margin:0;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.facts ul{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:4px}
.facts li{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:13px}
.fact-label{color:var(--muted);flex:0 0 auto}
.fact-value{overflow-wrap:anywhere}
.badge{display:inline-flex;align-items:center;border:1px solid;border-radius:4px;padding:0 5px;font-size:11px;line-height:1.6;white-space:nowrap}
.badge-sourced{border-color:var(--ok);color:var(--ok)}
.badge-unverified{border-color:var(--warn);color:var(--warn)}
.badge-unknown{border-color:var(--line);color:var(--muted)}
.fact-source,.fact-stale{font-size:11px;color:var(--muted);overflow-wrap:anywhere}
.fact-stale{color:var(--warn)}
.empty{margin:16px 0 0;color:var(--muted)}
.empty-trip{margin:24px 0;padding:16px;border:1px dashed var(--line);border-radius:10px;color:var(--muted)}
footer{margin-top:32px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media print{.tabs{display:none}.day[hidden]{display:block!important}.stop{break-inside:avoid}}
`

const SCRIPT = `
(function () {
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-day-tab]'));
  var panels = Array.prototype.slice.call(document.querySelectorAll('[data-day-panel]'));
  if (!tabs.length) return;
  function show(day) {
    tabs.forEach(function (tab) {
      var active = tab.getAttribute('data-day-tab') === day;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.setAttribute('tabindex', active ? '0' : '-1');
    });
    panels.forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-day-panel') !== day;
    });
  }
  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () {
      show(tab.getAttribute('data-day-tab'));
    });
    tab.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      var step = event.key === 'ArrowRight' ? 1 : tabs.length - 1;
      var next = tabs[(index + step) % tabs.length];
      show(next.getAttribute('data-day-tab'));
      next.focus();
    });
  });
})();
`

export interface OfflineRoadbookOptions {
  /** 资料卡库；null / 缺省 = 全部「未知」，不编造来源。 */
  poiCards?: PoiCardsRecordV1 | null
  /** 当前时刻（epoch ms），用于资料卡时效；缺省 Date.now。 */
  now?: number
  /** 是否标注「草稿未应用」；缺省 false。 */
  isDraft?: boolean
  /** 只允许收紧输出上限（字节）；缺省 2 MiB。 */
  maxBytes?: number
}

export type OfflineRoadbookResult =
  | { ok: true; html: string; bytes: number; fileName: string }
  | { ok: false; reason: 'too_large'; bytes: number; limit: number }

export function roadbookFileName(trip: Trip): string {
  const title = typeof trip.title === 'string' ? trip.title.trim() : ''
  return safeShareCardFileName(`travel-assistant-roadbook-${title === '' ? 'trip' : title}.html`)
}

/** 生成单文件离线 HTML 路书；超限返回明确失败，不生成半份 / 截断文件。 */
export function buildOfflineRoadbook(
  trip: Trip,
  options: OfflineRoadbookOptions = {},
): OfflineRoadbookResult {
  const now =
    typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const poiCards = options.poiCards ?? null
  const isDraft = options.isDraft === true
  const configured = options.maxBytes
  const limit =
    typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? Math.min(configured, MAX_ROADBOOK_HTML_BYTES)
      : MAX_ROADBOOK_HTML_BYTES

  const stopCount = trip.days.reduce((sum, day) => sum + day.stops.length, 0)
  const tabs = trip.days
    .map((day, index) => {
      const dayNumber = numberText(day.day)
      const selected = index === 0 ? 'true' : 'false'
      const tabindex = index === 0 ? '0' : '-1'
      return (
        `<button type="button" class="tab" role="tab" id="day-tab-${dayNumber}"` +
        ` data-day-tab="${dayNumber}" aria-controls="day-panel-${dayNumber}"` +
        ` aria-selected="${selected}" tabindex="${tabindex}">` +
        `第 ${dayNumber} 天 · ${textOr(day.title, '未命名的一天')}</button>`
      )
    })
    .join('')
  const days = trip.days
    .map((day, index) => dayHtml(day, index, poiCards, now, trip.destination))
    .join('')
  const body =
    trip.days.length === 0
      ? '<p class="empty-trip">这份行程还没有任何日期数据，路书为空。</p>'
      : `<nav class="tabs" role="tablist" aria-label="按天查看">${tabs}</nav><main>${days}</main>`
  const title = textOr(trip.title, '未命名行程')

  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"/>` +
    `<title>${title} · 离线路书</title><style>${STYLE}</style></head><body><div class="wrap">` +
    `<header><p class="kicker">旅行助手 · 离线路书</p><h1>${title}</h1>` +
    `<p class="meta">${textOr(trip.destination, '目的地未知')} · ${trip.days.length} 天 · ${stopCount} 个站点</p>` +
    (isDraft ? `<p class="draft-badge">${escapeHtml(ROADBOOK_DRAFT_BADGE)}</p>` : '') +
    '<p class="notice">本页是单文件离线页面：样式与脚本全部内联，不会发起任何网络请求；内容按记录原样整理，未联网核实营业、票务或交通。</p>' +
    `</header>${body}` +
    '<footer>由 旅行助手 生成 · 本页只含这一份行程与资料卡三字段（介绍 / 开放时间 / 门票）摘要，不含存储键值或密钥。</footer>' +
    `</div><noscript><style>.day[hidden]{display:block!important}</style></noscript>` +
    `<script>${SCRIPT}</script></body></html>`

  const bytes = utf8ByteLength(html)
  if (bytes > limit) {
    return { ok: false, reason: 'too_large', bytes, limit }
  }
  return { ok: true, html, bytes, fileName: roadbookFileName(trip) }
}

const URL_REVOKE_DELAY_MS = 1000

/**
 * 显式下载离线路书 HTML；只有调用本函数才会建 Blob / Blob URL / <a download>。
 * 不写 localStorage / sessionStorage，不发请求。
 */
export function downloadRoadbookHtml(html: string, fileName: string): boolean {
  if (typeof html !== 'string' || html.trim() === '') return false
  if (typeof document === 'undefined') return false
  const createObjectURL =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL.bind(URL)
      : null
  const revokeObjectURL =
    typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function'
      ? URL.revokeObjectURL.bind(URL)
      : null
  if (!createObjectURL || !revokeObjectURL) return false

  let objectUrl: string | null = null
  let anchor: HTMLAnchorElement | null = null
  try {
    const blob = new Blob([html], { type: ROADBOOK_MIME_TYPE })
    objectUrl = createObjectURL(blob)
    anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = safeShareCardFileName(fileName)
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    anchor = null
  } catch {
    if (anchor) {
      try {
        anchor.remove()
      } catch {
        /* 清理失败静默 */
      }
    }
    if (objectUrl !== null) {
      try {
        revokeObjectURL(objectUrl)
      } catch {
        /* 清理失败静默 */
      }
    }
    return false
  }

  const url = objectUrl
  setTimeout(() => {
    try {
      revokeObjectURL(url)
    } catch {
      /* 回收失败静默 */
    }
  }, URL_REVOKE_DELAY_MS)
  return true
}

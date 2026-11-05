/**
 * 离线随身行程页（单文件 HTML）生成器：纯函数，不碰 DOM、网络、存储或时钟。
 *
 * 边界（与 F6 规格、docs/WORKSPACE_SIDECAR.md 对齐）：
 * - 只接受当前完整的 `WorkspaceRecordV1`，先走契约 validator；失败按 fail-closed
 *   返回固定文案，不生成半份文件，也不读写任何存储。
 * - 只投影 Trip v1 / sidecar / budget 的已知字段；Trip 上可能夹带的额外属性不会被
 *   展开或序列化进页面。
 * - 页面是**无脚本静态 HTML**：样式全部内联，不嵌入 JSON、不输出 `<script>`，
 *   因此不存在 `</script>` 逃逸面；所有用户文本仍按 HTML 文本上下文完整转义。
 * - 不引用任何远程脚本 / 字体 / 图片 / 地图瓦片 / CSS @import / url()；不自动联网，
 *   也不做 Service Worker。用户文本里的网址只作为纯文本显示，不生成可点击链接。
 * - `null` 一律显示为未知，`0` 是合法记录值；缺坐标显示「坐标未知」，不补 (0,0)。
 * - 导出时间由调用方传入（组件在用户点预览时取一次），本模块不读时钟；同一记录 +
 *   同一时间输出逐字节相同。
 * - 输出上限默认 4 MiB（UTF-8 实际字节），调用方只能收紧；超限 fail-closed。
 */

import type { Trip, TripDay, TripStop } from './api'
import { utf8ByteLength } from './savedTrips'
import { safeTripBackupFilename } from './tripFile'
import { budgetCategoryLabel, computeBudgetSummary, formatCents } from './tripBudget'
import type {
  ChecklistItemV1,
  ConstraintItemV1,
  DayAnchorV1,
  GeoPointV1,
  TransportAnchorV1,
  WorkspaceRecordV1,
} from './workspaceTypes'
import { auditChecklistLinks, checklistItemConstraintState } from './checklist'
import { validateWorkspaceRecord } from './workspace'

/** 单文件离线页的 UTF-8 输出上限（4 MiB）。 */
export const MAX_OFFLINE_TRIP_HTML_BYTES = 4 * 1024 * 1024

/** 下载文件 MIME；页面本身是 UTF-8 文本。 */
export const OFFLINE_TRIP_HTML_MIME_TYPE = 'text/html;charset=utf-8'

/** 页面与面板共用的固定提示：只含当前工作区这一份已应用行程。 */
export const OFFLINE_TRIP_DATA_SCOPE_NOTICE =
  '本页只包含当前工作区里的这一份已应用行程：不含候选库、版本库、会话恢复数据、本地存储原文或密钥。'

/** 页面与面板共用的固定提示：导出不等于核实。 */
export const OFFLINE_TRIP_UNVERIFIED_NOTICE =
  '页面内容按记录原样整理；生成与打开都不会联网核实营业、票务、预约、交通或费用，也不代表下单成功、出票或商家受理。'

/** 页面与面板共用的固定提示：分享前检查用户自己的描述。 */
export const OFFLINE_TRIP_SHARE_NOTICE =
  '导出内容包含你填写的标题、地址、备注、预约与清单；工具不做脱敏，分享前请检查一次。'

const MISSING = '未填写'
const COORDINATE_UNKNOWN = '坐标未知（记录没有填写；不补 0）'
const MAX_DATE_MS = 8_640_000_000_000_000

const CONSTRAINT_KIND_LABELS: Record<ConstraintItemV1['kind'], string> = {
  must_visit: '必去要求',
  fixed_window: '预约窗口',
  reminder: '提醒',
}

const CHECKLIST_CATEGORY_LABELS: Record<ChecklistItemV1['category'], string> = {
  ticket: '票务',
  appointment: '预约',
  document: '证件',
  luggage: '行李',
  todo: '待办',
}

const ROUTE_TYPE_LABELS: Record<TripDay['legs'][number]['route_type'], string> = {
  navigation: '导航路线（按记录原样展示，未重新计算）',
  straight_line: '示意直线（不是导航结果，无真实道路）',
  unavailable: '路线不可用（记录中没有可用路线）',
}

const MODE_LABELS: Record<TripDay['legs'][number]['mode'], string> = {
  walking: '步行',
  driving: '驾车',
}

const TRANSPORT_KIND_LABELS: Record<TransportAnchorV1['kind'], string> = {
  airport: '机场',
  station: '车站',
  other: '其他抵离点',
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

function controlMarker(char: string): string {
  return `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * HTML 文本 / 属性上下文的完整转义。
 * 页面不嵌入 JSON 或脚本；即便用户文本包含 `</script>`、引号、`<img onerror>`，
 * 这里也会先把结构字符变成实体，绝不依赖「删掉几个字符」的假安全。
 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(CONTROL_CHARS, controlMarker)
}

function textOr(value: string | null | undefined, fallback = MISSING): string {
  if (value === null || value === undefined || value === '') return escapeHtml(fallback)
  return escapeHtml(value)
}

function numberText(value: number): string {
  return escapeHtml(String(value))
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return '未知（不是 0 分钟）'
  return `${numberText(minutes)} 分钟`
}

function formatDistance(meters: number | null): string {
  if (meters === null) return '未知（不是 0 米）'
  return `${numberText(meters)} 米`
}

function formatCoordinate(location: GeoPointV1 | null): string {
  if (location === null) return COORDINATE_UNKNOWN
  return `经度 ${numberText(location.lng)}，纬度 ${numberText(location.lat)}（记录值，未核实）`
}

function formatClock(value: string | null): string {
  return value === null || value === '' ? '时间未知' : escapeHtml(value)
}

function formatDate(value: string | null): string {
  return value === null || value === '' ? '日期未知' : escapeHtml(value)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

interface EpochText {
  text: string
  iso: string
}

/** 本机时区 + 明确 offset + UTC ISO，避免「导出时间」被误读成别的时刻。 */
function formatEpoch(ms: number): EpochText | null {
  const date = new Date(ms)
  const time = date.getTime()
  if (!Number.isFinite(time)) return null
  const iso = date.toISOString()
  const local =
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  const zone = `UTC${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
  return { text: `${local}（${zone}；${iso}）`, iso }
}

function recordTimeText(ms: number): string {
  const formatted = formatEpoch(ms)
  return formatted === null ? `记录值 ${numberText(ms)}（超出可显示范围）` : formatted.text
}

function tripSourceLabel(source: Trip['source']): string {
  return source === 'example'
    ? '示例行程（记录自述 source=example）'
    : '生成行程（记录自述 source=agent）'
}

function findStop(day: TripDay, stopId: string | null): TripStop | null {
  if (stopId === null) return null
  return day.stops.find((stop) => stop.id === stopId) ?? null
}

function stopReference(day: TripDay, stopId: string): string {
  const stop = findStop(day, stopId)
  return stop === null
    ? `未在当前行程中找到（ID：${escapeHtml(stopId)}）`
    : `${escapeHtml(stop.name)}（ID：${escapeHtml(stop.id)}）`
}

function renderAnchor(label: string, anchor: DayAnchorV1, day: TripDay): string {
  const kind =
    anchor.kind === 'stop'
      ? `引用行程站点：${stopReference(day, anchor.stopId ?? '')}`
      : '手工锚点（未关联行程站点）'
  const hotel = anchor.hotelId === null ? '' : `<p class="detail">酒店实体 ID：${escapeHtml(anchor.hotelId)}</p>`
  return `
    <li class="anchor">
      <p class="anchor-head"><span class="label">${escapeHtml(label)}</span><strong class="prewrap">${textOr(anchor.name)}</strong><span class="time">${formatClock(anchor.time)}</span></p>
      <p class="detail">${kind}</p>
      <p class="detail">日期：${formatDate(anchor.date)}；地址：${textOr(anchor.address)}</p>
      <p class="detail">${formatCoordinate(anchor.location)}</p>
      ${hotel}
    </li>`
}

function renderDayAnchors(day: TripDay, record: WorkspaceRecordV1): string {
  const entry = record.sidecar.anchors.daily[String(day.day)]
  if (entry === undefined) {
    return `<p class="empty">这一天没有记录起止锚点。</p>`
  }
  const items: string[] = []
  if (entry.start !== null) items.push(renderAnchor('当天起点', entry.start, day))
  if (entry.end !== null) items.push(renderAnchor('当天终点', entry.end, day))
  return `<ul class="anchor-list">${items.join('')}</ul>`
}

function renderStop(stop: TripStop, index: number): string {
  return `
    <li class="stop">
      <div class="stop-head">
        <span class="stop-seq" aria-hidden="true">${index + 1}</span>
        <div>
          <h4 class="stop-name prewrap">${textOr(stop.name, '（空名称）')}</h4>
          <p class="stop-meta">记录时间：${formatClock(stop.time)} · 停留时长：${formatDuration(stop.duration_minutes)}</p>
        </div>
      </div>
      <p class="detail"><span class="label">地址</span>${textOr(stop.address)}</p>
      <p class="detail"><span class="label">坐标</span>${formatCoordinate(stop.location)}</p>
      <p class="detail prewrap"><span class="label">描述</span>${textOr(stop.description)}</p>
      <p class="source">来源：当前行程记录（记录值，未重新核实）。</p>
    </li>`
}

function renderLeg(day: TripDay, leg: TripDay['legs'][number]): string {
  const from = findStop(day, leg.from_stop_id)
  const to = findStop(day, leg.to_stop_id)
  const fromName = from === null ? '（记录中的站点 ID 未匹配到站点）' : escapeHtml(from.name)
  const toName = to === null ? '（记录中的站点 ID 未匹配到站点）' : escapeHtml(to.name)
  const description =
    leg.description.trim() === '' ? '' : `<p class="detail prewrap"><span class="label">说明</span>${escapeHtml(leg.description)}</p>`
  return `
    <li class="leg">
      <p class="leg-head">${fromName} → ${toName}</p>
      <p class="detail">方式：${MODE_LABELS[leg.mode]}；路线：${ROUTE_TYPE_LABELS[leg.route_type]}</p>
      <p class="detail">记录距离：${formatDistance(leg.distance_m)}；记录耗时：${formatDuration(leg.duration_minutes)}</p>
      ${description}
    </li>`
}

function constraintDateText(item: ConstraintItemV1): string {
  if (item.startDate === null && item.endDate === null) return '日期未填写'
  if (item.endDate === null) return `开始日期：${formatDate(item.startDate)}；结束日期：未填写`
  if (item.startDate === item.endDate) return `日期：${formatDate(item.startDate)}`
  return `日期：${formatDate(item.startDate)} 至 ${formatDate(item.endDate)}`
}

function constraintTimeText(item: ConstraintItemV1): string {
  if (item.startTime === null && item.endTime === null) return '时间未填写'
  if (item.endTime === null) return `开始时间：${formatClock(item.startTime)}；结束时间：未填写`
  return `时间：${formatClock(item.startTime)}–${formatClock(item.endTime)}（行程当地时刻）`
}

function constraintTargetText(item: ConstraintItemV1, record: WorkspaceRecordV1): string {
  const day = item.day === null ? '未指定天' : `第 ${numberText(item.day)} 天`
  let target: string
  if (item.stopId === null) {
    target = '未绑定具体站点'
  } else if (item.day === null) {
    target = `站点 ID：${escapeHtml(item.stopId)}（未指定天，无法唯一匹配）`
  } else {
    const tripDay = record.trip.days.find((candidate) => candidate.day === item.day)
    target =
      tripDay === undefined
        ? `站点 ID：${escapeHtml(item.stopId)}（当前行程中没有第 ${numberText(item.day)} 天）`
        : `绑定站点：${stopReference(tripDay, item.stopId)}`
  }
  return `目标：${day}；${target}`
}

function renderConstraint(item: ConstraintItemV1, record: WorkspaceRecordV1): string {
  const duration =
    item.durationMinutes === null
      ? '未知（不按 0 分钟计；无法据此判断后续是否赶得上）'
      : `${numberText(item.durationMinutes)} 分钟（记录值）`
  return `
    <li class="constraint">
      <p class="constraint-head"><strong>${CONSTRAINT_KIND_LABELS[item.kind]}</strong>：<span class="prewrap">${textOr(item.title)}</span></p>
      <p class="detail">${constraintDateText(item)}；${constraintTimeText(item)}</p>
      <p class="detail">${constraintTargetText(item, record)}</p>
      <p class="detail">停留时长：${duration}；优先级：${numberText(item.priority)}（0–3，记录值）</p>
      <p class="detail prewrap">备注：${textOr(item.notes)}</p>
      <p class="unverified">按记录填写，未核实；不代表商家受理。</p>
    </li>`
}

function renderDay(day: TripDay, record: WorkspaceRecordV1): string {
  const constraints = record.sidecar.constraints.items.filter((item) => item.day === day.day)
  const stops =
    day.stops.length === 0
      ? `<p class="empty">记录里这一天没有站点。</p>`
      : `<ol class="stops">${day.stops.map((stop, index) => renderStop(stop, index)).join('')}</ol>`
  const legs =
    day.legs.length === 0
      ? `<p class="empty">记录里没有路段摘要。</p>`
      : `<ul class="legs">${day.legs.map((leg) => renderLeg(day, leg)).join('')}</ul>`
  const dayConstraints =
    constraints.length === 0
      ? `<p class="empty">这一天没有绑定到本日的预约或提醒。</p>`
      : `<ul class="constraints">${constraints.map((item) => renderConstraint(item, record)).join('')}</ul>`
  const summary =
    day.summary.trim() === '' ? '' : `<p class="day-summary prewrap">${escapeHtml(day.summary)}</p>`
  return `
    <article class="day" id="day-${numberText(day.day)}" data-day="${numberText(day.day)}">
      <header class="day-head">
        <h3>第 ${numberText(day.day)} 天 <span class="day-date">${formatDate(day.date)}</span></h3>
        <p class="day-title prewrap">${textOr(day.title)}</p>
      </header>
      ${summary}
      <h4>起止锚点</h4>
      ${renderDayAnchors(day, record)}
      <h4>站点顺序</h4>
      ${stops}
      <h4>当天预约与提醒</h4>
      ${dayConstraints}
      <h4>交通摘要</h4>
      ${legs}
    </article>`
}

function stopLocations(record: WorkspaceRecordV1, stopId: string | null, day: number | null): string {
  if (stopId === null) return '未绑定站点'
  const days = day === null ? record.trip.days : record.trip.days.filter((candidate) => candidate.day === day)
  const matches: string[] = []
  for (const tripDay of days) {
    for (const stop of tripDay.stops) {
      if (stop.id === stopId) matches.push(`第 ${numberText(tripDay.day)} 天 · ${escapeHtml(stop.name)}（ID：${escapeHtml(stop.id)}）`)
    }
  }
  return matches.length === 0
    ? `未在当前行程中找到（ID：${escapeHtml(stopId)}）`
    : matches.join('；')
}

interface ChecklistConstraintLink {
  constraint: ConstraintItemV1 | null
  danglingId: string | null
}

/**
 * 只按记录里的 `constraintId` 精确匹配当前约束；不做同名 / 同日期 / 同站点认领。
 * 旧 v1 缺省属性与显式 `null` 都是普通条目，不补关联，也不提示为损坏。
 */
function checklistConstraintLink(
  item: ChecklistItemV1,
  record: WorkspaceRecordV1,
  danglingConstraintByItem: ReadonlyMap<string, string>,
): ChecklistConstraintLink {
  if (checklistItemConstraintState(item) !== 'linked') {
    return { constraint: null, danglingId: null }
  }
  const constraintId = item.constraintId
  if (typeof constraintId !== 'string') return { constraint: null, danglingId: null }
  const danglingId = danglingConstraintByItem.get(item.id) ?? null
  if (danglingId !== null) return { constraint: null, danglingId }
  const constraint =
    record.sidecar.constraints.items.find((candidate) => candidate.id === constraintId) ?? null
  return { constraint, danglingId: constraint === null ? constraintId : null }
}

function renderChecklistItem(
  item: ChecklistItemV1,
  record: WorkspaceRecordV1,
  danglingConstraintByItem: ReadonlyMap<string, string>,
): string {
  const target =
    item.stopId === null
      ? item.originalStopId === null
        ? '未关联站点'
        : `需重新关联（原站点 ID：${escapeHtml(item.originalStopId)}）`
      : stopLocations(record, item.stopId, item.day)
  const date = item.date === null ? '日期未填写' : formatDate(item.date)
  const day = item.day === null ? '未指定天' : `第 ${numberText(item.day)} 天`
  const link = checklistConstraintLink(item, record, danglingConstraintByItem)
  const constraintDetail =
    link.danglingId !== null
      ? `<p class="detail check-relink">需重新关联：关联预约已不在当前行程（原关联 ID：${escapeHtml(link.danglingId)}）；任务与完成状态保留，不自动改绑其他预约。</p>`
      : link.constraint !== null
        ? `<p class="detail">关联预约：${textOr(link.constraint.title)}（ID：${escapeHtml(link.constraint.id)}）；仅按记录中的关联 ID 对应，未核实。</p>`
        : ''
  return `
    <li class="check-item" data-done="${item.done ? 'true' : 'false'}">
      <p class="check-head"><span class="check-state">${item.done ? '已准备' : '未准备'}</span><strong class="prewrap">${textOr(item.title)}</strong></p>
      <p class="detail">分类：${CHECKLIST_CATEGORY_LABELS[item.category]}；${date}；${day}；关联站点：${target}</p>
      ${constraintDetail}
      <p class="detail prewrap">备注：${textOr(item.notes)}</p>
    </li>`
}

function renderChecklist(record: WorkspaceRecordV1): string {
  const checklist = record.sidecar.checklist
  const audit = auditChecklistLinks(checklist, { constraints: record.sidecar.constraints })
  const danglingConstraintByItem = new Map<string, string>()
  for (const issue of audit.issues) {
    if (issue.reason === 'constraint_deleted' && issue.refId !== null) {
      danglingConstraintByItem.set(issue.itemId, issue.refId)
    }
  }
  const items =
    checklist.items.length === 0
      ? `<p class="empty">清单里还没有条目。</p>`
      : `<ul class="checklist">${checklist.items.map((item) => renderChecklistItem(item, record, danglingConstraintByItem)).join('')}</ul>`
  const templates =
    checklist.appliedTemplates.length === 0
      ? '无'
      : `${numberText(checklist.appliedTemplates.length)} 个（${checklist.appliedTemplates.map((id) => escapeHtml(id)).join('、')}）`
  return `
    <section class="card" aria-labelledby="checklist-title">
      <h2 id="checklist-title">出行准备清单</h2>
      <p class="muted">「已准备」只表示你在记录里勾选过，不代表下单成功、出票或商家受理。</p>
      ${items}
      <p class="muted">已采纳模板：${templates}</p>
    </section>`
}

function budgetTotalText(record: WorkspaceRecordV1, summary: ReturnType<typeof computeBudgetSummary>): string {
  if (record.budget === null) return '当前工作区记录明确没有预算数据（不等于 0 元）。'
  if (!summary.ok) return '费用明细无法计算，未给出合计；金额未知，不按 0 元计。'
  const budget = summary.summary.budget
  if (budget.kind === 'empty') return '总预算：未填写（未知，不按 0 元计）。'
  if (budget.kind === 'invalid') {
    return `总预算：原文无法按金额解析（未知，不按 0 元计）：${escapeHtml(record.budget.budgetRaw)}`
  }
  return `总预算：${formatCents(budget.cents)} 元（按你填写的原文；不是商家报价）。`
}

function renderBudget(record: WorkspaceRecordV1): string {
  if (record.budget === null) {
    return `
      <section class="card" aria-labelledby="budget-title">
        <h2 id="budget-title">已知费用</h2>
        <p class="empty">当前工作区记录明确没有预算数据（不等于 0 元）。</p>
      </section>`
  }

  const summary = computeBudgetSummary({ rows: record.budget.rows, budgetRaw: record.budget.budgetRaw })
  const knownById = new Map<string, { cents: number; amountRaw: string }>()
  const emptyIds = new Set<string>()
  const issueById = new Map<string, string>()
  if (summary.ok) {
    for (const line of summary.summary.knownLines) {
      knownById.set(line.rowId, { cents: line.cents, amountRaw: line.amountRaw })
    }
    for (const line of summary.summary.emptyLines) emptyIds.add(line.rowId)
    for (const line of summary.summary.issueLines) issueById.set(line.rowId, line.reason)
  }

  const rows =
    record.budget.rows.length === 0
      ? `<p class="empty">费用明细没有条目。</p>`
      : `<table>
          <thead><tr><th>项目</th><th>分类</th><th>金额（记录）</th><th>状态</th></tr></thead>
          <tbody>
            ${record.budget.rows
              .map((row) => {
                const known = knownById.get(row.id)
                const state =
                  known !== undefined
                    ? `已填写（已知${known.cents === 0 ? ' 0 元' : ''}）`
                    : emptyIds.has(row.id)
                      ? '未填写（未知，不按 0 元计）'
                      : issueById.has(row.id)
                        ? '无法解析（未知，不按 0 元计）'
                        : '未知（未计算）'
                const amount =
                  row.amountRaw === ''
                    ? '未填写'
                    : `${escapeHtml(row.amountRaw)}${known === undefined ? '' : `（${formatCents(known.cents)} 元）`}`
                return `<tr><td class="prewrap">${textOr(row.name)}</td><td>${budgetCategoryLabel(row.category)}</td><td class="prewrap">${amount}</td><td>${state}</td></tr>`
              })
              .join('')}
          </tbody>
        </table>`

  let knownTotal: string
  let comparison = ''
  if (!summary.ok) {
    knownTotal = '没有给出合计；金额未知，不按 0 元计。'
  } else {
    const s = summary.summary
    knownTotal =
      s.knownTotalText === null
        ? '没有可合计的合法金额（不等于 0 元）。'
        : `${s.knownTotalText} 元（只统计已填写的合法金额）`
    const unknownParts: string[] = []
    if (s.emptyCount > 0) unknownParts.push(`${s.emptyCount} 项未填写`)
    if (s.issueCount > 0) unknownParts.push(`${s.issueCount} 项无法解析`)
    if (s.knownCount > 0 && unknownParts.length > 0) {
      knownTotal += `；另有 ${unknownParts.join('、')}，均未计入。`
    }
    comparison = `<p class="detail">预算比较（仅已知部分）：${escapeHtml(s.comparison.message)}</p>`
    if (s.categorySubtotals.length > 0) {
      comparison += `<ul class="subtotals">${s.categorySubtotals
        .map((item) => `<li>${item.label}：${formatCents(item.cents)} 元（${item.count} 项已知）</li>`)
        .join('')}</ul>`
    }
  }

  return `
    <section class="card" aria-labelledby="budget-title">
      <h2 id="budget-title">已知费用</h2>
      <p class="muted">金额来自你手工填写的预算；本页不查询报价、不换汇，未填写或无法解析的项目不按 0 元计。</p>
      <p>${budgetTotalText(record, summary)}</p>
      ${rows}
      <p class="detail"><strong>已知合计：</strong>${knownTotal}</p>
      ${comparison}
      <p class="muted">这里只反映记录里的手工金额，不代表实际花费、可支付金额或商家报价。</p>
    </section>`
}

function renderAccommodation(record: WorkspaceRecordV1): string {
  const accommodation = record.sidecar.anchors.accommodation
  if (accommodation === null) {
    return `<p class="empty">住宿信息未填写；这表示记录里没有，不代表订好或商家受理。</p>`
  }
  const location =
    accommodation.location === null
      ? `${COORDINATE_UNKNOWN}；坐标来源：无。`
      : `${formatCoordinate(accommodation.location)}；坐标来源：用户填写（记录自述）。`
  return `
    <div class="anchor-card">
      <p class="anchor-head"><span class="label">住宿（你填写的信息）</span><strong class="prewrap">${textOr(accommodation.name)}</strong></p>
      <p class="detail">地址：${textOr(accommodation.address)}</p>
      <p class="detail">入住：${formatDate(accommodation.checkInDate)}；退房：${formatDate(accommodation.checkOutDate)}</p>
      <p class="detail">${location}</p>
      <p class="unverified">按记录展示，未核实；不代表订好或商家受理。</p>
    </div>`
}

function renderTransport(label: string, anchor: TransportAnchorV1 | null): string {
  if (anchor === null) return `<p class="empty">${label}：未填写。</p>`
  return `
    <div class="anchor-card">
      <p class="anchor-head"><span class="label">${label}</span><strong class="prewrap">${textOr(anchor.name)}</strong></p>
      <p class="detail">类型：${TRANSPORT_KIND_LABELS[anchor.kind]}；日期：${formatDate(anchor.date)}；时间：${formatClock(anchor.time)}</p>
      <p class="detail">${formatCoordinate(anchor.location)}</p>
    </div>`
}

function renderAnchors(record: WorkspaceRecordV1): string {
  const anchors = record.sidecar.anchors
  return `
    <section class="card" aria-labelledby="anchors-title">
      <h2 id="anchors-title">住宿与抵离锚点</h2>
      <p class="muted">以下都是你填写 / 当前记录里的信息，未与酒店、机场或车站核对。</p>
      ${renderAccommodation(record)}
      ${renderTransport('到达信息', anchors.arrival)}
      ${renderTransport('离开信息', anchors.departure)}
    </section>`
}

function renderUnboundConstraints(record: WorkspaceRecordV1): string {
  const dayNumbers = new Set(record.trip.days.map((day) => day.day))
  const unbound = record.sidecar.constraints.items.filter(
    (item) => item.day === null || !dayNumbers.has(item.day),
  )
  if (unbound.length === 0) return ''
  return `
    <section class="card" aria-labelledby="unbound-constraints-title">
      <h2 id="unbound-constraints-title">未绑定到具体天数的约束</h2>
      <p class="muted">这些约束没有指定当前行程中的某一天；按记录原样列出。</p>
      <ul class="constraints">${unbound.map((item) => renderConstraint(item, record)).join('')}</ul>
    </section>`
}

function renderWarnings(record: WorkspaceRecordV1): string {
  if (record.trip.warnings.length === 0) return ''
  return `
    <section class="card" aria-labelledby="warnings-title">
      <h2 id="warnings-title">记录内提示（warnings）</h2>
      <ul class="warnings">${record.trip.warnings
        .map((warning) => `<li class="prewrap">${textOr(warning)}</li>`)
        .join('')}</ul>
      <p class="muted">这些是行程记录自带的提示，不是本页新增的核实结论。</p>
    </section>`
}

function renderPage(record: WorkspaceRecordV1, exportedAtText: string): string {
  const trip = record.trip
  const title = trip.title.trim() === '' ? `${trip.destination} 离线随身行程` : trip.title
  const daySections = trip.days.map((day) => renderDay(day, record)).join('')
  const label =
    record.meta.label === null || record.meta.label.trim() === ''
      ? '未命名工作区'
      : record.meta.label
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)} · 离线随身行程</title>
<style>${OFFLINE_TRIP_CSS}</style>
</head>
<body>
<main class="page">
  <header class="hero">
    <p class="kicker">离线随身行程 · 单文件 HTML</p>
    <h1 class="prewrap">${escapeHtml(title)}</h1>
    <p class="lede">${escapeHtml(trip.destination)} · ${numberText(trip.days.length)} 天</p>
    ${trip.summary.trim() === '' ? '' : `<p class="lede prewrap">${escapeHtml(trip.summary)}</p>`}
    <p class="meta">导出页生成时间：${escapeHtml(exportedAtText)}</p>
    <p class="notice">${escapeHtml(OFFLINE_TRIP_UNVERIFIED_NOTICE)}</p>
    <p class="notice notice-secondary">${escapeHtml(OFFLINE_TRIP_DATA_SCOPE_NOTICE)}</p>
  </header>

  <section class="card" aria-labelledby="source-title">
    <h2 id="source-title">数据来源与导出范围</h2>
    <dl class="facts">
      <div><dt>数据来源</dt><dd>当前工作区记录（工作区 ID：${escapeHtml(record.workspaceId)}；行程 ID：${escapeHtml(record.tripId)}）</dd></div>
      <div><dt>工作区</dt><dd>${escapeHtml(label)}</dd></div>
      <div><dt>工作区 revision</dt><dd>${numberText(record.workspaceRevision)}</dd></div>
      <div><dt>记录更新时间</dt><dd>${recordTimeText(record.updatedAt)}</dd></div>
      <div><dt>导出页生成时间</dt><dd>${escapeHtml(exportedAtText)}</dd></div>
      <div><dt>行程来源</dt><dd>${tripSourceLabel(trip.source)}</dd></div>
      <div><dt>不包含</dt><dd>候选库、版本库、会话恢复数据、本地存储原文、密钥。</dd></div>
    </dl>
    <p class="muted">以下是你当前工作区中这一份已应用行程，不是其他版本或候选；每日站点按记录顺序展示。</p>
  </section>

  ${renderAnchors(record)}

  <section class="days" aria-labelledby="days-title">
    <h2 id="days-title">每日行程（按当前已应用方案顺序）</h2>
    ${daySections}
  </section>

  ${renderUnboundConstraints(record)}
  ${renderChecklist(record)}
  ${renderBudget(record)}
  ${renderWarnings(record)}

  <footer class="footer">
    <p>数据来源：当前工作区记录（工作区 ID：${escapeHtml(record.workspaceId)}；行程 ID：${escapeHtml(record.tripId)}；revision ${numberText(record.workspaceRevision)}）。</p>
    <p>导出页生成时间：${escapeHtml(exportedAtText)}。下载复用预览的同一份字节，下载时不会重新生成或改写时间。</p>
    <p>${escapeHtml(OFFLINE_TRIP_DATA_SCOPE_NOTICE)}</p>
    <p>${escapeHtml(OFFLINE_TRIP_UNVERIFIED_NOTICE)}</p>
    <p>${escapeHtml(OFFLINE_TRIP_SHARE_NOTICE)}</p>
  </footer>
</main>
</body>
</html>`
}

export type OfflineTripHtmlFailureReason =
  | 'invalid_record'
  | 'too_large'
  | 'bad_limit'
  | 'bad_exported_at'

export interface OfflineTripHtmlOptions {
  /** 预览 / 导出时刻（epoch ms），由调用方在用户点击时传入；本模块不读时钟。 */
  exportedAt: number
  /** 只允许收紧的 UTF-8 输出上限；缺省 4 MiB。 */
  maxBytes?: number
}

export interface OfflineTripHtmlArtifact {
  html: string
  bytes: number
  filename: string
  exportedAt: number
  exportedAtText: string
  exportedAtIso: string
  notices: string[]
}

export type OfflineTripHtmlResult =
  | ({ ok: true } & OfflineTripHtmlArtifact)
  | { ok: false; reason: OfflineTripHtmlFailureReason; message: string }

const MESSAGE_INVALID_RECORD =
  '当前工作区记录不完整或包含异常字段（未知字段、重复 ID、NaN、循环引用、超限等），没有生成离线页。当前工作区数据没有改变。'
const MESSAGE_BAD_LIMIT =
  '导出配置的输出上限不合法（必须是正数且不超过 4 MiB），没有生成文件。这是程序配置问题，与工作区内容无关。'
const MESSAGE_BAD_EXPORTED_AT =
  '导出时间不合法，没有生成离线页。这是程序配置问题，与工作区内容无关。'

function tooLargeMessage(bytes: number, limit: number): string {
  return `生成的离线页约 ${Math.max(1, Math.ceil(bytes / 1024))} KB，超过 ${Math.max(1, Math.round(limit / 1024))} KB 的输出上限，没有生成文件。当前工作区数据没有改变。`
}

/** 生成 .html 文件名：与 JSON 备份同名不同后缀，清洗规则复用 tripFile。 */
export function safeOfflineTripHtmlFilename(trip: Trip): string {
  return safeTripBackupFilename(trip).replace(/\.json$/, '.html')
}

/**
 * 生成单文件离线行程页。
 *
 * 校验顺序固定：导出时间 → 输出上限 → 完整工作区记录 → 生成 → UTF-8 字节门禁。
 * 所有失败都返回固定文案的 typed 结果，不产出半份 HTML；不读写 storage、不发请求、
 * 不读时钟、不修改输入。
 */
export function tripToOfflineHtml(
  record: WorkspaceRecordV1,
  options: OfflineTripHtmlOptions,
): OfflineTripHtmlResult {
  const exportedAt = options?.exportedAt
  if (
    typeof exportedAt !== 'number' ||
    !Number.isSafeInteger(exportedAt) ||
    exportedAt <= 0 ||
    exportedAt > MAX_DATE_MS
  ) {
    return { ok: false, reason: 'bad_exported_at', message: MESSAGE_BAD_EXPORTED_AT }
  }
  const exportedAtParts = formatEpoch(exportedAt)
  if (exportedAtParts === null) {
    return { ok: false, reason: 'bad_exported_at', message: MESSAGE_BAD_EXPORTED_AT }
  }

  const configured = options?.maxBytes
  if (
    configured !== undefined &&
    (typeof configured !== 'number' ||
      !Number.isFinite(configured) ||
      configured <= 0 ||
      configured > MAX_OFFLINE_TRIP_HTML_BYTES)
  ) {
    return { ok: false, reason: 'bad_limit', message: MESSAGE_BAD_LIMIT }
  }
  const limit = configured ?? MAX_OFFLINE_TRIP_HTML_BYTES

  let validated: WorkspaceRecordV1
  try {
    const result = validateWorkspaceRecord(record)
    if (!result.ok) {
      return { ok: false, reason: 'invalid_record', message: MESSAGE_INVALID_RECORD }
    }
    validated = result.value
  } catch {
    return { ok: false, reason: 'invalid_record', message: MESSAGE_INVALID_RECORD }
  }

  let html: string
  try {
    html = renderPage(validated, exportedAtParts.text)
  } catch {
    return { ok: false, reason: 'invalid_record', message: MESSAGE_INVALID_RECORD }
  }

  const bytes = utf8ByteLength(html)
  if (bytes > limit) {
    return { ok: false, reason: 'too_large', message: tooLargeMessage(bytes, limit) }
  }

  return {
    ok: true,
    html,
    bytes,
    filename: safeOfflineTripHtmlFilename(validated.trip),
    exportedAt,
    exportedAtText: exportedAtParts.text,
    exportedAtIso: exportedAtParts.iso,
    notices: [
      OFFLINE_TRIP_DATA_SCOPE_NOTICE,
      OFFLINE_TRIP_UNVERIFIED_NOTICE,
      OFFLINE_TRIP_SHARE_NOTICE,
    ],
  }
}

const OFFLINE_TRIP_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: #f3ede1;
  color: #2b2a26;
  font-family: "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans SC", sans-serif;
  font-size: 15px;
  line-height: 1.75;
  text-wrap: pretty;
}
.page { max-width: 940px; margin: 0 auto; padding: 32px 20px 56px; }
.hero { border-bottom: 2px solid #a94732; padding-bottom: 20px; margin-bottom: 24px; }
.kicker { margin: 0; color: #8a3b2a; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; }
h1, h2, h3, h4 { font-family: "Songti SC", "Noto Serif SC", "SimSun", serif; color: #241f1a; }
h1 { margin: 8px 0; font-size: clamp(28px, 5vw, 42px); line-height: 1.2; }
h2 { margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid #d8cbb4; font-size: 24px; line-height: 1.3; }
h3 { margin: 0; font-size: 22px; line-height: 1.35; }
h4 { margin: 20px 0 8px; font-size: 16px; line-height: 1.4; }
.lede { margin: 0; color: #5c564b; }
.meta { margin: 6px 0; color: #6d665a; font-size: 13px; }
.notice {
  margin: 12px 0 0;
  padding: 12px 16px;
  border-left: 4px solid #a94732;
  background: #fffaf0;
  color: #3a342b;
  font-size: 13px;
}
.notice-secondary { border-left-color: #8b806c; background: #f8f2e6; }
.card {
  margin: 18px 0;
  padding: 18px 20px;
  border: 1px solid #d8cbb4;
  border-radius: 10px;
  background: #fffdf8;
}
.facts { display: grid; gap: 8px; margin: 0; }
.facts div { display: grid; grid-template-columns: 120px 1fr; gap: 12px; }
.facts dt { color: #6d665a; font-weight: 600; }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.anchor-card { margin-top: 12px; padding: 14px 16px; border: 1px solid #e3d8c4; border-radius: 8px; background: #fdf9f0; }
.anchor-head, .stop-head, .leg-head, .constraint-head, .check-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; margin: 0; }
.label { color: #6d665a; font-weight: 600; }
.time { color: #8a3b2a; font-family: "JetBrains Mono", Consolas, monospace; font-size: 13px; }
.detail { margin: 5px 0; }
.source { margin: 6px 0 0; color: #6d665a; font-size: 12px; }
.unverified { margin: 6px 0 0; color: #8a3b2a; font-size: 12px; }
.check-relink { color: #8a3b2a; font-weight: 600; }
.muted { margin: 6px 0; color: #6d665a; font-size: 13px; }
.empty { margin: 8px 0; color: #6d665a; font-size: 14px; }
.prewrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.day { margin-top: 28px; padding-top: 22px; border-top: 1px solid #d8cbb4; page-break-inside: avoid; }
.day-head { margin-bottom: 10px; }
.day-date { margin-left: 8px; color: #6d665a; font-family: "JetBrains Mono", Consolas, monospace; font-size: 14px; font-weight: 400; }
.day-title { margin: 4px 0 0; color: #4a443a; }
.day-summary { margin: 8px 0 0; color: #4a443a; }
.anchor-list, .stops, .constraints, .legs, .checklist, .warnings, .subtotals { margin: 8px 0 0; padding-left: 1.35em; }
.anchor-list, .stops, .constraints, .legs, .checklist { list-style: none; padding-left: 0; }
.anchor, .constraint, .leg, .check-item { margin: 10px 0; padding: 12px 14px; border: 1px solid #e8decc; border-radius: 8px; background: #fdfaf3; }
.stop { margin: 12px 0; padding: 0 0 12px 42px; border-bottom: 1px dashed #e3d8c4; position: relative; }
.stop:last-child { border-bottom: 0; padding-bottom: 0; }
.stop-seq {
  position: absolute;
  left: 0;
  top: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #a94732;
  color: #fffaf0;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 13px;
}
.stop-name { margin: 0; font-size: 17px; }
.stop-meta { margin: 2px 0 0; color: #6d665a; font-size: 13px; }
.check-state { display: inline-block; padding: 1px 8px; border-radius: 999px; background: #efe5d2; color: #5c4a36; font-size: 12px; font-weight: 700; }
.check-item[data-done="true"] .check-state { background: #dce8d8; color: #31502b; }
table { width: 100%; margin-top: 10px; border-collapse: collapse; font-size: 14px; }
th, td { padding: 8px 10px; border-bottom: 1px solid #e8decc; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { color: #6d665a; font-size: 12px; font-weight: 700; }
.subtotals { padding-left: 1.2em; color: #4a443a; font-size: 13px; }
.footer { margin-top: 32px; padding-top: 16px; border-top: 2px solid #a94732; color: #5c564b; font-size: 12px; }
.footer p { margin: 6px 0; }
a { color: inherit; }
@media (max-width: 640px) {
  .page { padding: 20px 14px 40px; }
  .facts div { grid-template-columns: 1fr; gap: 2px; }
  .stop { padding-left: 36px; }
  table { display: block; overflow-x: auto; }
}
@page { margin: 14mm; }
@media print {
  body { background: #fff; color: #000; font-size: 11pt; }
  .page { max-width: none; padding: 0; }
  .card, .anchor, .constraint, .leg, .check-item, .day { break-inside: avoid; }
  .notice, .card, .anchor-card, .anchor, .constraint, .leg, .check-item { background: #fff; }
  a { color: inherit; text-decoration: none; }
}
`

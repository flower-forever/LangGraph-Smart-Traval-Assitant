/**
 * 本地行程草稿：纯函数、copy-on-write。
 *
 * 边界（与 editing-brief.md 对齐，界面接线属于后续任务）：
 * - 不读 localStorage，不调用 crypto / 网络 / Date，也不自动保存或请求外部服务；
 *   fork 行程 id 与新增站点 id 全部由调用方提供，模块不枚举已保存记录、不生成 id。
 * - 原 Trip 与草稿都按只读处理：每次编辑返回新的草稿，原行程、未修改的天、
 *   未修改站点的对象和 geometry 逐点保持同一引用；这样大几何不会被来回克隆。
 * - 修改名称 / 地址视为「地点变了」：该站 location 置 null，涉及它的旧路段改成
 *   unavailable（geometry=[]、distance_m/duration_minutes=null），说明统一写
 *   UNAVAILABLE_LEG_DESCRIPTION；只改时间 / 停留 / 描述时坐标与 geometry 原样保留。
 * - 增删 / 重排后按新的相邻顺序重建当天的 legs：只有两端站点 id 与原坐标都没变、
 *   同方向邻接仍然存在的旧路段才原样复用；新相邻关系一律 unavailable，
 *   新路段的 mode 取调用方创建草稿时显式传入的 newLegMode，不猜、不冒充用户已选。
 * - 修改字段才严格校验新值：name 120、address 300、description 1000、HH:MM、
 *   duration 为 null 或 0–1440 整数。未被修改的旧字段不做二次校验、不截断、不修复，
 *   所以前端比后端宽的已导入数据（例如 300 字的旧站名）不会因为改了一个时间就被静默改写。
 * - 应用后：被改天与全行程 summary 换成诚实的本地编辑概要；warnings 第一项写固定说明，
 *   其余旧提醒保留为「编辑前参考」；总数压到后端上限 40 条以内，省略时在说明里写明条数。
 *   旧提醒不按「第 N 天」子串猜测删除，也不会伪装成当前已重新核对。
 * - 应用返回的仍是 Trip v1 已知字段，不塞草稿元数据；未修改天保持原对象，
 *   因此通过 checkTripShape、JSON 备份往返、本地保存都沿用现有形状。
 * - 无实际内容变化时 applyDraft 是 no-op：不换 id、不追加提醒、不返回新 Trip。
 */

import type { TravelMode, Trip, TripDay, TripLeg, TripLocation, TripStop } from './api'
import { MAX_SAVED_TRIP_BYTES, checkTripShape, savedTripRecordBytes } from './savedTrips'

/** 后端 TripPlan.warnings 上限（travel_itinerary.py 的 MAX_TRIP_WARNINGS）。 */
export const MAX_EDIT_WARNINGS = 40

/** 撤销历史上限：只保留最近 20 次状态；历史项与当前草稿共享未修改的天与 geometry。 */
export const MAX_UNDO_STEPS = 20

/** 后端 TripPlan.id / Stop.id 的 max_length。 */
export const MAX_FORK_TRIP_ID_LENGTH = 100
export const MAX_STOP_ID_LENGTH = 100

/**
 * 新增 / 修改站点的字段上限，与后端 Stop 模型一致。
 * 注意：这些上限只约束「这次真的改了的值」，不回溯约束旧数据。
 */
export const MAX_STOP_NAME_LENGTH = 120
export const MAX_STOP_ADDRESS_LENGTH = 300
export const MAX_STOP_DESCRIPTION_LENGTH = 1000
export const MAX_STOP_DURATION_MINUTES = 1440

/** 与 ./savedTrips.ts 的 checkTripShape 单日站点上限一致，避免 apply 后突然超结构。 */
export const MAX_DRAFT_STOPS_PER_DAY = 100

/** 合法站点时间：严格 HH:MM，24 小时制；不接受 9:00、24:00、09:00:00。 */
export const STOP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** 新相邻关系没有可信路线时的固定说明。 */
export const UNAVAILABLE_LEG_DESCRIPTION = '本地编辑后待重新获取路线'

/** 界面上需要展示的固定提示（不写进行程）。 */
export const LOCAL_EDIT_DISCLAIMER =
  '本次只做本地编辑：不会自动保存，也不会请求后端或其他外部服务；编辑结果不代表真实预约、营业状态或实测交通。'
export const LOCAL_EDIT_WARNINGS_NOTICE =
  '行程提醒第一项是本地编辑说明；它后面的旧提醒是编辑前生成的参考，尚未重新核对。当前本地检查是另一份结果，两者需要分开显示。'

export type DraftFailureReason =
  | 'invalid_base'
  | 'base_too_large'
  | 'invalid_fork_id'
  | 'invalid_mode'
  | 'unknown_day'
  | 'unknown_stop'
  | 'invalid_stop_id'
  | 'duplicate_stop_id'
  | 'stop_limit'
  | 'invalid_index'
  | 'invalid_direction'
  | 'invalid_name'
  | 'invalid_address'
  | 'invalid_time'
  | 'invalid_duration'
  | 'invalid_description'
  | 'invalid_location'
  | 'postcondition_failed'

export interface DraftFailure {
  ok: false
  reason: DraftFailureReason
  message: string
}

/** 草稿撤销栈的一项。只存天数组引用与标记，不复制 geometry。 */
export interface DraftHistoryEntry {
  readonly days: readonly TripDay[]
  readonly changedDays: readonly number[]
}

export interface TripDraft {
  /** 原始行程；本模块从不修改它，discardDraft 直接返回它。 */
  readonly base: Trip
  /** 应用后写入 Trip.id 的 fork id；同一草稿多次应用复用同一个。 */
  readonly forkTripId: string
  /** 新建相邻路段时显式使用的出行方式。 */
  readonly newLegMode: TravelMode
  /** 当前草稿的天：只有被改过的天是新对象，其余与 base 共享。 */
  readonly days: readonly TripDay[]
  /** 被操作过的天序号（升序）；apply 时还会再和 base 做内容比对。 */
  readonly changedDays: readonly number[]
  /** 有界撤销栈，最新一项在末尾。 */
  readonly history: readonly DraftHistoryEntry[]
  /** 每次有效编辑 / 撤销 +1，供界面判断草稿是否更新。 */
  readonly revision: number
}

export interface CreateTripDraftOptions {
  /** 必须以 UUID 等方式由调用方生成：非空、≤100 字符、且不等于 base.id。 */
  forkTripId: string
  /** 新增相邻路段使用的出行方式；必须显式给出，模块不会猜。 */
  newLegMode: TravelMode
}

export interface UpdateDraftStopPatch {
  name?: string
  address?: string
  time?: string
  duration_minutes?: number | null
  description?: string
}

export interface NewDraftStop {
  id: string
  name: string
  time: string
  duration_minutes?: number | null
  description?: string
  address?: string
  /**
   * 首迭代新增站点只有文字，没有可信定位来源：只允许 null（显式表示无坐标）或
   * 整个字段缺省。不接受调用方随手填的经纬度数字，也不提供坐标校验通道；
   * 带可信坐标的候选日应走独立受校验的替换日 API，而不是普通新增站点。
   */
  location?: null
}

export interface AddDraftStopOptions {
  /** 插入位置，0..当天现有站数；缺省追加到末尾。 */
  index?: number
}

export type DraftEditResult =
  | { ok: true; draft: TripDraft; changed: boolean }
  | DraftFailure

export type DraftCreateResult =
  | { ok: true; draft: TripDraft }
  | DraftFailure

export type DraftCheckKind =
  | 'empty_day'
  | 'missing_location'
  | 'unavailable_leg'
  | 'time_unreadable'
  | 'time_order'
  | 'time_overlap'
  | 'possible_cross_day'

/**
 * 本地检查结果：只覆盖被改过的天，措辞按「计划值」描述，
 * 不代表预约、营业时间或实测交通结论。它与 Trip.warnings 里的旧提醒分开返回。
 */
export interface DraftLocalCheck {
  kind: DraftCheckKind
  day: number
  stopId: string | null
  message: string
}

export interface DraftApplySuccess {
  ok: true
  /** false 表示草稿最终内容与 base 完全一致，返回的 trip 就是 base 本身。 */
  changed: boolean
  trip: Trip
  /** 这次真正有内容变化的天（升序）。 */
  changedDays: number[]
  /** 被改天的本地检查，供界面与旧 warnings 分开显示。 */
  localChecks: DraftLocalCheck[]
  /** 为了不超过 40 条提醒而省略的旧提醒条数；0 表示全部保留。 */
  omittedWarnings: number
  /** 固定提示，不写进行程。 */
  notices: string[]
}

export type DraftApplyFailure = { ok: false; reason: 'postcondition_failed'; message: string }

export type DraftApplyResult = DraftApplySuccess | DraftApplyFailure

function failure(reason: DraftFailureReason, message: string): DraftFailure {
  return { ok: false, reason, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTravelMode(value: unknown): value is TravelMode {
  return value === 'walking' || value === 'driving'
}

function isValidForkTripId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_FORK_TRIP_ID_LENGTH &&
    value.trim().length > 0
  )
}

function isValidStopId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_STOP_ID_LENGTH &&
    value.trim().length > 0
  )
}

function isValidStopName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_STOP_NAME_LENGTH &&
    value.trim().length > 0
  )
}

function isValidAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STOP_ADDRESS_LENGTH
}

function isValidDescription(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STOP_DESCRIPTION_LENGTH
}

function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && STOP_TIME_PATTERN.test(value)
}

function isValidDuration(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_STOP_DURATION_MINUTES)
  )
}

function sameLocation(a: TripLocation | null, b: TripLocation | null): boolean {
  if (a === null || b === null) return a === b
  return a.lng === b.lng && a.lat === b.lat
}

function sameStop(a: TripStop, b: TripStop): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.time === b.time &&
    a.duration_minutes === b.duration_minutes &&
    a.description === b.description &&
    a.address === b.address &&
    sameLocation(a.location, b.location)
  )
}

function sameLeg(a: TripLeg, b: TripLeg): boolean {
  if (
    a.from_stop_id !== b.from_stop_id ||
    a.to_stop_id !== b.to_stop_id ||
    a.mode !== b.mode ||
    a.route_type !== b.route_type ||
    a.distance_m !== b.distance_m ||
    a.duration_minutes !== b.duration_minutes ||
    a.description !== b.description
  ) {
    return false
  }
  if (a.geometry.length !== b.geometry.length) return false
  return a.geometry.every((point, index) => {
    const other = b.geometry[index]
    return point.lng === other.lng && point.lat === other.lat
  })
}

/** 逐字段比较（含 geometry 逐点）；仅在「被操作过的天」上调用，成本与改动的天数同阶。 */
function sameDayContent(a: TripDay, b: TripDay): boolean {
  if (
    a.day !== b.day ||
    a.date !== b.date ||
    a.title !== b.title ||
    a.summary !== b.summary ||
    a.stops.length !== b.stops.length ||
    a.legs.length !== b.legs.length
  ) {
    return false
  }
  for (let index = 0; index < a.stops.length; index += 1) {
    if (!sameStop(a.stops[index], b.stops[index])) return false
  }
  for (let index = 0; index < a.legs.length; index += 1) {
    if (!sameLeg(a.legs[index], b.legs[index])) return false
  }
  return true
}

function parseClock(value: string): number | null {
  if (!STOP_TIME_PATTERN.test(value)) return null
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))
}

function formatClock(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const hour = Math.floor(normalized / 60)
  const minute = normalized % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function findDay(draft: TripDraft, dayNumber: number): TripDay | undefined {
  return draft.days.find((day) => day.day === dayNumber)
}

function calendarDayLabel(dayNumber: number): string {
  return `第 ${dayNumber} 天`
}

function hasStopId(days: readonly TripDay[], id: string): boolean {
  return days.some((day) => day.stops.some((stop) => stop.id === id))
}

function legKey(fromStopId: string, toStopId: string): string {
  // JSON.stringify 会转义 \u0000、引号、反斜杠等所有控制字符，两个不同 (from, to)
  // 组合不可能拼出同一个键；站点 id 来自导入数据，可以包含任意字符。
  return `${JSON.stringify(fromStopId)}\u0000${JSON.stringify(toStopId)}`
}

/**
 * 按新站点顺序重建当天 legs。
 * 复用条件：旧路段同方向存在、两端站点都在旧天里、本次没有把任一端标记为地点变更、
 * 且两端坐标与旧天逐值相等。其余相邻关系一律生成 unavailable，不猜直线或距离。
 */
function rebuildLegs(
  day: TripDay,
  stops: readonly TripStop[],
  mode: TravelMode,
  placeChangedStopIds: ReadonlySet<string>,
): TripLeg[] {
  const oldStopById = new Map(day.stops.map((stop) => [stop.id, stop]))
  const oldLegByKey = new Map(day.legs.map((leg) => [legKey(leg.from_stop_id, leg.to_stop_id), leg]))
  const legs: TripLeg[] = []
  for (let index = 0; index + 1 < stops.length; index += 1) {
    const from = stops[index]
    const to = stops[index + 1]
    const previous = oldLegByKey.get(legKey(from.id, to.id))
    const oldFrom = oldStopById.get(from.id)
    const oldTo = oldStopById.get(to.id)
    const reusable =
      previous !== undefined &&
      oldFrom !== undefined &&
      oldTo !== undefined &&
      !placeChangedStopIds.has(from.id) &&
      !placeChangedStopIds.has(to.id) &&
      sameLocation(oldFrom.location, from.location) &&
      sameLocation(oldTo.location, to.location)
    if (reusable) {
      legs.push(previous)
      continue
    }
    legs.push({
      from_stop_id: from.id,
      to_stop_id: to.id,
      mode,
      route_type: 'unavailable',
      distance_m: null,
      duration_minutes: null,
      geometry: [],
      description: UNAVAILABLE_LEG_DESCRIPTION,
    })
  }
  return legs
}

/**
 * 改 name / address 后重建涉及被改站点的路段：其他现有路段原样保留引用与 geometry，
 * 涉及被改站点的路段改成 unavailable。站点顺序没有变，所以不按邻接整体重建，
 * 只对每个现有 leg 判断是否被牵连。
 */
function invalidateLegsAround(
  legs: readonly TripLeg[],
  placeChangedStopId: string,
  mode: TravelMode,
): TripLeg[] {
  return legs.map((leg) => {
    if (leg.from_stop_id !== placeChangedStopId && leg.to_stop_id !== placeChangedStopId) {
      return leg
    }
    return {
      from_stop_id: leg.from_stop_id,
      to_stop_id: leg.to_stop_id,
      mode,
      route_type: 'unavailable',
      distance_m: null,
      duration_minutes: null,
      geometry: [],
      description: UNAVAILABLE_LEG_DESCRIPTION,
    }
  })
}

function commitDay(draft: TripDraft, previousDay: TripDay, nextDay: TripDay): DraftEditResult {
  if (sameDayContent(previousDay, nextDay)) {
    return { ok: true, draft, changed: false }
  }
  const days = draft.days.map((day) => (day.day === previousDay.day ? nextDay : day))
  const changedDays = draft.changedDays.includes(previousDay.day)
    ? draft.changedDays
    : [...draft.changedDays, previousDay.day].sort((left, right) => left - right)
  const historyEntry: DraftHistoryEntry = { days: draft.days, changedDays: draft.changedDays }
  const history = [...draft.history, historyEntry].slice(-MAX_UNDO_STEPS)
  return {
    ok: true,
    changed: true,
    draft: { ...draft, days, changedDays, history, revision: draft.revision + 1 },
  }
}

interface StopPatchOutcome {
  stop: TripStop
  changed: boolean
  touchesPlace: boolean
}

/**
 * 只校验「这次提供了且与旧值不同」的字段。
 * 这样界面把整张表单提交上来时，旧数据里合法的宽字段（例如 300 字旧站名）不会被二次卡住。
 */
function applyStopPatch(
  current: TripStop,
  patch: UpdateDraftStopPatch,
): { ok: true; outcome: StopPatchOutcome } | DraftFailure {
  if (!isRecord(patch)) {
    return failure('invalid_name', '站点修改内容必须是对象，草稿未改动。')
  }
  let name = current.name
  let address = current.address
  let time = current.time
  let durationMinutes = current.duration_minutes
  let description = current.description
  let changed = false
  let touchesPlace = false

  if (patch.name !== undefined && patch.name !== current.name) {
    if (!isValidStopName(patch.name)) {
      return failure(
        'invalid_name',
        `站点名称需要是 1–${MAX_STOP_NAME_LENGTH} 个字符的非空文本，草稿未改动。`,
      )
    }
    name = patch.name
    changed = true
    touchesPlace = true
  }
  if (patch.address !== undefined && patch.address !== current.address) {
    if (!isValidAddress(patch.address)) {
      return failure(
        'invalid_address',
        `站点地址最多 ${MAX_STOP_ADDRESS_LENGTH} 个字符，草稿未改动。`,
      )
    }
    address = patch.address
    changed = true
    touchesPlace = true
  }
  if (patch.time !== undefined && patch.time !== current.time) {
    if (!isValidTime(patch.time)) {
      return failure('invalid_time', '站点时间必须是 24 小时制的 HH:MM（例如 09:30），草稿未改动。')
    }
    time = patch.time
    changed = true
  }
  if (
    patch.duration_minutes !== undefined &&
    patch.duration_minutes !== current.duration_minutes
  ) {
    if (!isValidDuration(patch.duration_minutes)) {
      return failure(
        'invalid_duration',
        `停留时长必须是 null 或 0–${MAX_STOP_DURATION_MINUTES} 的整数分钟，草稿未改动。`,
      )
    }
    durationMinutes = patch.duration_minutes
    changed = true
  }
  if (patch.description !== undefined && patch.description !== current.description) {
    if (!isValidDescription(patch.description)) {
      return failure(
        'invalid_description',
        `站点描述最多 ${MAX_STOP_DESCRIPTION_LENGTH} 个字符，草稿未改动。`,
      )
    }
    description = patch.description
    changed = true
  }

  if (!changed) {
    return { ok: true, outcome: { stop: current, changed: false, touchesPlace: false } }
  }

  const stop: TripStop = {
    id: current.id,
    name,
    time,
    duration_minutes: durationMinutes,
    description,
    address,
    // 地点变了就不再信任旧坐标；只改时间 / 停留 / 描述时坐标原样保留。
    location: touchesPlace ? null : current.location,
  }
  return { ok: true, outcome: { stop, changed: true, touchesPlace } }
}

function buildNewStop(input: NewDraftStop): { ok: true; stop: TripStop } | DraftFailure {
  if (!isRecord(input)) {
    return failure('invalid_stop_id', '新增站点内容必须是对象，草稿未改动。')
  }
  if (!isValidStopId(input.id)) {
    return failure(
      'invalid_stop_id',
      `新增站点 id 需要是 1–${MAX_STOP_ID_LENGTH} 个字符的非空文本，草稿未改动。`,
    )
  }
  if (!isValidStopName(input.name)) {
    return failure(
      'invalid_name',
      `新增站点名称需要是 1–${MAX_STOP_NAME_LENGTH} 个字符的非空文本，草稿未改动。`,
    )
  }
  if (!isValidTime(input.time)) {
    return failure('invalid_time', '新增站点时间必须是 24 小时制的 HH:MM（例如 09:30），草稿未改动。')
  }
  const durationMinutes = input.duration_minutes === undefined ? null : input.duration_minutes
  if (!isValidDuration(durationMinutes)) {
    return failure(
      'invalid_duration',
      `新增站点停留时长必须是 null 或 0–${MAX_STOP_DURATION_MINUTES} 的整数分钟，草稿未改动。`,
    )
  }
  const description = input.description === undefined ? '' : input.description
  if (!isValidDescription(description)) {
    return failure(
      'invalid_description',
      `新增站点描述最多 ${MAX_STOP_DESCRIPTION_LENGTH} 个字符，草稿未改动。`,
    )
  }
  const address = input.address === undefined ? '' : input.address
  if (!isValidAddress(address)) {
    return failure(
      'invalid_address',
      `新增站点地址最多 ${MAX_STOP_ADDRESS_LENGTH} 个字符，草稿未改动。`,
    )
  }
  let location: TripLocation | null = null
  if (input.location !== undefined && input.location !== null) {
    // 运行时兜底：类型层已不接受对象坐标，这里仍明确拒绝而不是当真。
    return failure(
      'invalid_location',
      '首迭代新增站点只有文字，不具备可信定位来源；不接受手填坐标，请用 location: null 或省略该字段。草稿未改动。',
    )
  }
  return {
    ok: true,
    stop: {
      id: input.id,
      name: input.name,
      time: input.time,
      duration_minutes: durationMinutes,
      description,
      address,
      location,
    },
  }
}

/**
 * 创建草稿。base 必须是 checkTripShape 认可的 Trip；fork id 由调用方生成，
 * 必须非空、≤100 字符且不同于 base.id。base 本身不会被复制或改写。
 */
export function createTripDraft(base: Trip, options: CreateTripDraftOptions): DraftCreateResult {
  const shape = checkTripShape(base)
  if (!shape.ok) {
    return failure(
      shape.reason === 'too_large' ? 'base_too_large' : 'invalid_base',
      shape.reason === 'too_large'
        ? '原始行程包含的路线几何超过本地编辑可安全处理的上限，未创建草稿；原行程保持不变。'
        : '原始行程的数据结构不完整，未创建草稿；原行程保持不变。',
    )
  }
  if (!isValidForkTripId(options?.forkTripId)) {
    return failure(
      'invalid_fork_id',
      `fork 行程 id 需要是 1–${MAX_FORK_TRIP_ID_LENGTH} 个字符的非空文本，且必须由调用方新生成，未创建草稿。`,
    )
  }
  if (options.forkTripId === base.id) {
    return failure(
      'invalid_fork_id',
      'fork 行程 id 不能与原始行程 id 相同，否则会覆盖原行程，未创建草稿。',
    )
  }
  if (!isTravelMode(options.newLegMode)) {
    return failure('invalid_mode', '新建路段的出行方式必须是 walking 或 driving，未创建草稿。')
  }
  return {
    ok: true,
    draft: {
      base,
      forkTripId: options.forkTripId,
      newLegMode: options.newLegMode,
      days: base.days,
      changedDays: [],
      history: [],
      revision: 0,
    },
  }
}

/**
 * 修改站点文字字段。name / address 一旦真的变化，该站坐标清空、相关旧路段失效；
 * time / duration / description 变化保留坐标和 geometry。无实际变化时返回同一个草稿。
 */
export function updateDraftStop(
  draft: TripDraft,
  dayNumber: number,
  stopId: string,
  patch: UpdateDraftStopPatch,
): DraftEditResult {
  const day = findDay(draft, dayNumber)
  if (!day) {
    return failure('unknown_day', `草稿里没有${calendarDayLabel(dayNumber)}，操作未生效。`)
  }
  const stopIndex = day.stops.findIndex((stop) => stop.id === stopId)
  if (stopIndex < 0) {
    return failure('unknown_stop', '这一天的站点列表里没有指定站点，操作未生效。')
  }
  const outcome = applyStopPatch(day.stops[stopIndex], patch)
  if (!outcome.ok) return outcome
  if (!outcome.outcome.changed) {
    return { ok: true, draft, changed: false }
  }
  const stops = day.stops.map((stop, index) => (index === stopIndex ? outcome.outcome.stop : stop))
  // 只改 time / duration / description：站点身份与顺序都没变，现有 legs（含 geometry）
  // 整体原样保留——包括导入数据里 legs 为空或非标准邻接的情况，不为时间编辑动路线。
  // 改 name / address：顺序未变，只把涉及该站的现有路段改 unavailable，
  // 其余路段保留原引用；新增 / 删除 / 重排才按新邻接重建（见 rebuildLegs）。
  const legs = outcome.outcome.touchesPlace
    ? invalidateLegsAround(day.legs, outcome.outcome.stop.id, draft.newLegMode)
    : day.legs
  const nextDay: TripDay = {
    ...day,
    stops,
    legs,
  }
  return commitDay(draft, day, nextDay)
}

/** 在指定天插入新站点；新站点默认没有坐标，相关新路段一律 unavailable。 */
export function addDraftStop(
  draft: TripDraft,
  dayNumber: number,
  stop: NewDraftStop,
  options: AddDraftStopOptions = {},
): DraftEditResult {
  const day = findDay(draft, dayNumber)
  if (!day) {
    return failure('unknown_day', `草稿里没有${calendarDayLabel(dayNumber)}，操作未生效。`)
  }
  const index = options.index === undefined ? day.stops.length : options.index
  if (!Number.isInteger(index) || index < 0 || index > day.stops.length) {
    return failure('invalid_index', '新增站点的插入位置超出当天站点范围，操作未生效。')
  }
  if (day.stops.length >= MAX_DRAFT_STOPS_PER_DAY) {
    return failure(
      'stop_limit',
      `单日站点数已达到本地结构上限 ${MAX_DRAFT_STOPS_PER_DAY} 个，未新增站点。`,
    )
  }
  const built = buildNewStop(stop)
  if (!built.ok) return built
  if (hasStopId(draft.days, built.stop.id)) {
    return failure(
      'duplicate_stop_id',
      '新增站点 id 与行程内已有站点重复；不会自动改写任何站点 id，未新增站点。',
    )
  }
  const stops = [...day.stops]
  stops.splice(index, 0, built.stop)
  const nextDay: TripDay = {
    ...day,
    stops,
    legs: rebuildLegs(day, stops, draft.newLegMode, new Set<string>()),
  }
  return commitDay(draft, day, nextDay)
}

/** 删除指定站点；当天被删空也允许，后续可以再增站。 */
export function removeDraftStop(
  draft: TripDraft,
  dayNumber: number,
  stopId: string,
): DraftEditResult {
  const day = findDay(draft, dayNumber)
  if (!day) {
    return failure('unknown_day', `草稿里没有${calendarDayLabel(dayNumber)}，操作未生效。`)
  }
  const stopIndex = day.stops.findIndex((stop) => stop.id === stopId)
  if (stopIndex < 0) {
    return failure('unknown_stop', '这一天的站点列表里没有指定站点，操作未生效。')
  }
  const stops = day.stops.filter((stop) => stop.id !== stopId)
  const nextDay: TripDay = {
    ...day,
    stops,
    legs: rebuildLegs(day, stops, draft.newLegMode, new Set<string>()),
  }
  return commitDay(draft, day, nextDay)
}

/** 上移 / 下移一个位置；已在边界时是无变化的 no-op。 */
export function moveDraftStop(
  draft: TripDraft,
  dayNumber: number,
  stopId: string,
  direction: 'up' | 'down',
): DraftEditResult {
  if (direction !== 'up' && direction !== 'down') {
    return failure('invalid_direction', '移动方向只能是 up 或 down，操作未生效。')
  }
  const day = findDay(draft, dayNumber)
  if (!day) {
    return failure('unknown_day', `草稿里没有${calendarDayLabel(dayNumber)}，操作未生效。`)
  }
  const fromIndex = day.stops.findIndex((stop) => stop.id === stopId)
  if (fromIndex < 0) {
    return failure('unknown_stop', '这一天的站点列表里没有指定站点，操作未生效。')
  }
  const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1
  if (toIndex < 0 || toIndex >= day.stops.length) {
    return { ok: true, draft, changed: false }
  }
  const stops = [...day.stops]
  const [moved] = stops.splice(fromIndex, 1)
  stops.splice(toIndex, 0, moved)
  const nextDay: TripDay = {
    ...day,
    stops,
    legs: rebuildLegs(day, stops, draft.newLegMode, new Set<string>()),
  }
  return commitDay(draft, day, nextDay)
}

/** 撤销最近一次编辑；历史为空时是无变化的 no-op。 */
export function undoDraft(draft: TripDraft): DraftEditResult {
  const previous = draft.history[draft.history.length - 1]
  if (!previous) {
    return { ok: true, draft, changed: false }
  }
  return {
    ok: true,
    changed: true,
    draft: {
      ...draft,
      days: previous.days,
      changedDays: previous.changedDays,
      history: draft.history.slice(0, -1),
      revision: draft.revision + 1,
    },
  }
}

/** 放弃草稿：返回未被修改的 base 本身，不产生新 Trip、不写任何额外字段。 */
export function discardDraft(draft: TripDraft): Trip {
  return draft.base
}

/** 草稿里真正与 base 有内容差异的天（会做逐字段比较，所以改回原值后会消失）。 */
export function draftChangedDays(draft: TripDraft): number[] {
  const baseByDay = new Map(draft.base.days.map((day) => [day.day, day]))
  const draftByDay = new Map(draft.days.map((day) => [day.day, day]))
  return draft.changedDays.filter((dayNumber) => {
    const baseDay = baseByDay.get(dayNumber)
    const draftDay = draftByDay.get(dayNumber)
    return baseDay !== undefined && draftDay !== undefined && !sameDayContent(baseDay, draftDay)
  })
}

export function isDraftDirty(draft: TripDraft): boolean {
  return draftChangedDays(draft).length > 0
}

function displayStopName(stop: TripStop): string {
  const trimmed = stop.name.trim()
  if (trimmed.length === 0) return '未命名站点'
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed
}

/**
 * 单天本地检查。只做能由填写值直接确认的检查，不照抄后端的完整冲突算法，
 * 也不用未知交通耗时 0 去声称「可行」。
 */
function localChecksForDay(day: TripDay): DraftLocalCheck[] {
  const checks: DraftLocalCheck[] = []
  const dayLabel = calendarDayLabel(day.day)
  if (day.stops.length === 0) {
    checks.push({
      kind: 'empty_day',
      day: day.day,
      stopId: null,
      message: `${dayLabel}目前没有站点；本地编辑不会自动补站点。`,
    })
    return checks
  }

  const nameById = new Map(day.stops.map((stop) => [stop.id, stop]))
  let previousStop: TripStop | null = null
  let previousStart: number | null = null
  let previousEnd: number | null = null

  for (const stop of day.stops) {
    if (stop.location === null) {
      checks.push({
        kind: 'missing_location',
        day: day.day,
        stopId: stop.id,
        message: `${dayLabel}「${displayStopName(stop)}」缺少坐标，地图上无法定位，位置尚未确认。`,
      })
    }

    const start = parseClock(stop.time)
    if (start === null) {
      checks.push({
        kind: 'time_unreadable',
        day: day.day,
        stopId: stop.id,
        message: `${dayLabel}「${displayStopName(stop)}」的时间不是 HH:MM，无法做本地时间检查，也不会自动改写。`,
      })
      previousStop = stop
      previousStart = null
      previousEnd = null
      continue
    }

    if (previousStop !== null && previousStart !== null) {
      if (start < previousStart) {
        checks.push({
          kind: 'time_order',
          day: day.day,
          stopId: stop.id,
          message:
            `${dayLabel}「${displayStopName(stop)}」的时间 ${stop.time} 早于上一站 ` +
            `「${displayStopName(previousStop)}」的 ${previousStop.time}，可能是时间倒序或需要跨日安排（按填写值做的本地检查）。`,
        })
      } else if (previousEnd !== null && previousEnd > start) {
        // 只有时钟顺序正常（同日可确认）才谈得上「确定重叠」；倒序本身可能跨日，
        // 同时给两个结论会把「可能跨日」误报成确定的同日冲突。
        const previousDuration = previousStop.duration_minutes ?? 0
        checks.push({
          kind: 'time_overlap',
          day: day.day,
          stopId: stop.id,
          message:
            `${dayLabel}按上一站填写的停留 ${previousDuration} 分钟，到 ${formatClock(previousEnd)} 才结束，` +
            `晚于本站 ${stop.time}，计划时段重叠（计划值，不代表真实预约或交通）。`,
        })
      }
    }

    previousStop = stop
    previousStart = start
    previousEnd = stop.duration_minutes === null ? null : start + stop.duration_minutes
  }

  const lastStop = day.stops[day.stops.length - 1]
  const lastStart = parseClock(lastStop.time)
  if (lastStart !== null) {
    const lastDuration = lastStop.duration_minutes ?? 0
    // 导入旧数据的停留可以是小数或超过一天的分钟数（前端旧边界比新编辑宽）。
    // 这时结束时刻没法可靠格式化成 HH:MM，也不该把多天结束写死成「次日」，
    // 原值原样保留，只给一条保守可读的提示。
    if (!Number.isInteger(lastDuration) || lastDuration > MAX_STOP_DURATION_MINUTES) {
      checks.push({
        kind: 'possible_cross_day',
        day: day.day,
        stopId: lastStop.id,
        message:
          `${dayLabel}「${displayStopName(lastStop)}」开始于 ${lastStop.time}，停留为 ${lastDuration} 分钟，` +
          '无法可靠推算当天结束时刻，可能跨到更晚；原值已原样保留，需要自行确认（计划值，不代表实际安排）。',
      })
    } else {
      const lastEnd = lastStart + lastDuration
      if (lastEnd > 1440) {
        checks.push({
          kind: 'possible_cross_day',
          day: day.day,
          stopId: lastStop.id,
          message:
            `${dayLabel}最后一站按填写停留结束于 ${formatClock(lastEnd)}，可能跨到次日，` +
            '需要自行确认（计划值，不代表实际安排）。',
        })
      }
    }
  }

  for (const leg of day.legs) {
    if (leg.route_type !== 'unavailable') continue
    const from = nameById.get(leg.from_stop_id)
    const to = nameById.get(leg.to_stop_id)
    checks.push({
      kind: 'unavailable_leg',
      day: day.day,
      stopId: to?.id ?? from?.id ?? null,
      message:
        `${dayLabel}「${from ? displayStopName(from) : leg.from_stop_id} → ` +
        `${to ? displayStopName(to) : leg.to_stop_id}」路段待重新获取路线，未提供距离和耗时。`,
    })
  }

  return checks
}

/** 当前草稿里被改天的本地检查；没有实际变化时返回空数组。 */
export function localChecksForDraft(draft: TripDraft): DraftLocalCheck[] {
  const byDay = new Map(draft.days.map((day) => [day.day, day]))
  const checks: DraftLocalCheck[] = []
  for (const dayNumber of draftChangedDays(draft)) {
    const day = byDay.get(dayNumber)
    if (day) checks.push(...localChecksForDay(day))
  }
  return checks
}

function buildDaySummary(day: TripDay, checks: readonly DraftLocalCheck[]): string {
  const stopsText = day.stops.length === 0 ? '当天没有站点' : `现有 ${day.stops.length} 个站点`
  // 按当天 legs 的实际状态描述：时间-only 编辑保留了原导航，不能笼统说「全部待重取」；
  // 失效与保留分开计数，0 项的那类不写。
  const unavailableLegCount = day.legs.filter((leg) => leg.route_type === 'unavailable').length
  const keptLegCount = day.legs.length - unavailableLegCount
  const routeParts: string[] = []
  if (unavailableLegCount > 0) {
    routeParts.push(`${unavailableLegCount} 段相邻路线待重新获取`)
  }
  if (keptLegCount > 0) {
    routeParts.push(`${keptLegCount} 段相邻路线保留原样`)
  }
  const routeText =
    routeParts.length > 0 ? routeParts.join('，') : '没有相邻路段需要重新获取'
  const checkText =
    checks.length > 0
      ? `本地检查有 ${checks.length} 条待确认`
      : '本地检查未发现时间或站点顺序问题'
  return (
    `本地编辑后${calendarDayLabel(day.day)}：${stopsText}；${routeText}；${checkText}。` +
    '本概要只描述本地修改，不代表已重新规划、已核实交通或已确认预约。'
  )
}

function buildTripSummary(days: readonly TripDay[], changedDays: readonly number[]): string {
  const totalStops = days.reduce((total, day) => total + day.stops.length, 0)
  const changedText = changedDays.map((dayNumber) => calendarDayLabel(dayNumber)).join('、')
  return (
    `本地编辑副本（未重新规划）：共 ${days.length} 天、${totalStops} 个站点；` +
    `${changedText}有本地修改，相关路线与时间需要复核。原推荐摘要不再代表当前方案。`
  )
}

function buildEditNotice(changedDays: readonly number[], omittedWarnings: number): string {
  const changedText = changedDays.map((dayNumber) => calendarDayLabel(dayNumber)).join('、')
  const omittedText =
    omittedWarnings > 0
      ? `为不超过 ${MAX_EDIT_WARNINGS} 条提醒上限，已省略 ${omittedWarnings} 条编辑前提醒的原文；原始行程副本仍保留。`
      : `提醒总数未超过 ${MAX_EDIT_WARNINGS} 条，编辑前的提醒原文全部保留。`
  return (
    `本地编辑说明：本行程在本地修改了${changedText}，尚未重新规划，也未重新获取路线。` +
    '除本条说明外，其余提醒都是编辑前生成的参考，尚未按当前行程重新核对，' +
    '既不能当成仍然成立，也不能当成已经排除。' +
    omittedText
  )
}

/**
 * 显式应用草稿，返回 Trip 副本。
 * - 没有实际变化：changed=false，trip 就是 base，不新建 id、不追加提醒；
 * - 有变化：id 用 forkTripId，source / destination / title / map_coordinate_system 保持原值，
 *   warnings = [固定本地编辑说明, ...旧提醒（最多 39 条）]，
 *   被改天的 summary 与全行程 summary 换成诚实的本地编辑概要，未改天保持原对象。
 * 生成后会再过一遍 checkTripShape；万一失败则整次应用被拒绝，原行程不受影响。
 */
export function applyDraft(draft: TripDraft): DraftApplyResult {
  const effectiveChangedDays = draftChangedDays(draft)
  if (effectiveChangedDays.length === 0) {
    return {
      ok: true,
      changed: false,
      trip: draft.base,
      changedDays: [],
      localChecks: [],
      omittedWarnings: 0,
      notices: [],
    }
  }

  const changedSet = new Set(effectiveChangedDays)
  const checksByDay = new Map<number, DraftLocalCheck[]>()
  const localChecks: DraftLocalCheck[] = []
  for (const dayNumber of effectiveChangedDays) {
    const day = draft.days.find((item) => item.day === dayNumber)
    if (!day) continue
    const checks = localChecksForDay(day)
    checksByDay.set(dayNumber, checks)
    localChecks.push(...checks)
  }

  const days: TripDay[] = draft.days.map((day) => {
    if (!changedSet.has(day.day)) return day
    const checks = checksByDay.get(day.day) ?? []
    return { ...day, summary: buildDaySummary(day, checks) }
  })

  const keptWarnings = draft.base.warnings.slice(0, MAX_EDIT_WARNINGS - 1)
  const omittedWarnings = draft.base.warnings.length - keptWarnings.length
  const warnings = [buildEditNotice(effectiveChangedDays, omittedWarnings), ...keptWarnings]

  const trip: Trip = {
    id: draft.forkTripId,
    source: draft.base.source,
    destination: draft.base.destination,
    title: draft.base.title,
    summary: buildTripSummary(days, effectiveChangedDays),
    map_coordinate_system: draft.base.map_coordinate_system,
    warnings,
    days,
  }

  const shape = checkTripShape(trip)
  if (!shape.ok) {
    return {
      ok: false,
      reason: 'postcondition_failed',
      message: '应用后的行程没有通过本地结构校验，这次应用已放弃，原始行程保持不变。',
    }
  }

  // 与本地保存 / JSON 备份用同一把尺子（id + savedAt + trip）。编辑说明与摘要是新增文本，
  // 极端情况下会把一份接近 640 KB 的行程顶过上限；宁可在这里明确拒绝，也不返回一份存不下的副本。
  let recordBytes: number
  try {
    recordBytes = savedTripRecordBytes(trip)
  } catch {
    return {
      ok: false,
      reason: 'postcondition_failed',
      message: '应用后的行程无法序列化，这次应用已放弃，原始行程保持不变。',
    }
  }
  if (recordBytes > MAX_SAVED_TRIP_BYTES) {
    return {
      ok: false,
      reason: 'postcondition_failed',
      message:
        `应用后的行程约 ${Math.ceil(recordBytes / 1024)} KB，会超过本地单份保存与 JSON 备份的 ` +
        `${Math.round(MAX_SAVED_TRIP_BYTES / 1024)} KB 上限，这次应用已放弃，原始行程保持不变。` +
        '可以先删减描述或缩短行程，再重新编辑。',
    }
  }

  return {
    ok: true,
    changed: true,
    trip,
    changedDays: [...effectiveChangedDays],
    localChecks,
    omittedWarnings,
    notices: [LOCAL_EDIT_DISCLAIMER, LOCAL_EDIT_WARNINGS_NOTICE],
  }
}

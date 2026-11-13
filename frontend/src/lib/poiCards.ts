/**
 * P · 景点资料卡：独立库（poiCards:v1）的纯数据层 + localStorage adapter。
 *
 * 边界（与三期计划 §2 / docs/POI_CARDS.md 对齐）：
 * - 资料卡是一条**独立记录**，键 `POI_CARDS_STORAGE_KEY`；与工作区 / 候选库 /
 *   版本库互不相干。本模块**永不读写**其它任何键，也永不写 Trip / 费用 / 候选库。
 * - 模块 import 时不读 localStorage；只有显式 load / save 才访问存储。
 * - 读取状态严格区分 ok / empty / unavailable / corrupt / unknown_version；
 *   corrupt / unknown_version 拒绝写入，原字节保持不动。
 * - 所有内容默认「未核实」：逐字段 provenance（来源 + 录入时间）由调用方提供，
 *   本模块只校验形状，不编造来源。
 * - 图片仅存 URL 与署名元数据；CRUD **零网络调用**（无任何请求 API；测试自查）。
 * - 资料卡没有坐标字段（无坐标可编造），也不出现 (0,0)。
 * - `identityKey` 复用候选池 dedupeKey 同款「名称+地址」归一化
 *   （normalizeCandidateText / candidateDedupeKey），不另造口径。卡片本体不存地址
 *   （契约字段清单没有 address）；地址只在创建 / 更新时经入参参与 identityKey，
 *   之后随 identityKey 固化。停点匹配按名称归一化，另见 poiCardNameKey。
 */
import {
  MAX_CANDIDATE_NAME_LENGTH,
} from './workspaceTypes'
import { candidateDedupeKey, normalizeCandidateText } from './candidatePool'
import { utf8ByteLength } from './savedTrips'

/* ───────── 存储键 / 格式 / 容量 ───────── */

/** 独立存储键：与 workspace / candidates / versions 三库并列，互不触碰。 */
export const POI_CARDS_STORAGE_KEY = 'travel-assistant:poi-cards:v1'

export const POI_CARDS_FORMAT = 'travel-assistant.poi-cards' as const
export const POI_CARDS_VERSION = 1 as const

/** 整库 UTF-8 字节上限（紧凑 JSON 真实字节）。 */
export const MAX_POI_CARDS_BYTES = 512 * 1024
/** 资料卡条数上限。 */
export const MAX_POI_CARDS_COUNT = 200
/** 单卡 intro 上限（字符数；计划 §2.1）。 */
export const MAX_POI_CARD_INTRO_LENGTH = 2000
/** 单卡最多图片数（仅 URL 引用，不存图）。 */
export const MAX_POI_CARD_IMAGES = 8
/** URL / 短文本字段上限。 */
export const MAX_POI_CARD_URL_LENGTH = 1000
export const MAX_POI_CARD_FIELD_LENGTH = 300
export const MAX_POI_CARD_IMAGE_CAPTION_LENGTH = 200
export const MAX_POI_CARD_ATTRIBUTION_LENGTH = 300
export const MAX_POI_CARD_LICENSE_LENGTH = 100

export type PoiCardImageSource = 'manual' | 'tavily' | 'osm' | 'wikimedia'

/** 一张图片引用：只有 URL 与署名元数据，绝不内嵌图片数据。 */
export interface CardImageV1 {
  url: string
  caption: string | null
  source: PoiCardImageSource
  attribution: string | null
  license: string | null
  addedAt: number
}

/** 逐字段来源：null = 该字段从未填写 / 没有来源；有值时默认「未核实」。 */
export interface PoiCardFieldProvenanceV1 {
  source: PoiCardImageSource
  /** 来源说明（页面 URL / OSM 对象 / 「手工粘贴」等；展示用）。 */
  detail: string | null
  /** 来源录入时刻（epoch ms）。 */
  recordedAt: number
}

export interface PoiCardProvenanceV1 {
  intro: PoiCardFieldProvenanceV1 | null
  openingHours: PoiCardFieldProvenanceV1 | null
  ticket: PoiCardFieldProvenanceV1 | null
}

/** 一张景点资料卡。无坐标字段：无坐标可编造。 */
export interface PoiCardV1 {
  id: string
  /** 复用候选池 dedupeKey 同款「名称+地址」归一化键；创建后随更新重算名称段。 */
  identityKey: string
  /**
   * 七期 S7：可选城市归属。缺省 = 全局卡（任何城市可见）；
   * 旧卡不因校验 / 投影新增这个键。
   */
  cityId?: string | null
  name: string
  /** 最多 2000 字；空字符串 = 未填写。 */
  intro: string
  /** 空字符串 = 未填写（展示时显示「未知」）。 */
  openingHours: string
  ticket: string
  images: CardImageV1[]
  provenance: PoiCardProvenanceV1
  createdAt: number
  updatedAt: number
}

/** 资料卡库记录：单键单条。 */
export interface PoiCardsRecordV1 {
  format: typeof POI_CARDS_FORMAT
  version: typeof POI_CARDS_VERSION
  cards: PoiCardV1[]
  updatedAt: number
}

export type PoiCardsReadStatus =
  | 'ok'
  | 'empty'
  | 'unavailable'
  | 'corrupt'
  | 'unknown_version'

export interface PoiCardsRead {
  status: PoiCardsReadStatus
  /** 原始字节；empty = null。 */
  raw: string | null
  bytes: number
  record: PoiCardsRecordV1 | null
  message: string | null
}

export type PoiCardsWriteFailureReason =
  | 'invalid'
  | 'too_large'
  | 'too_many'
  | 'duplicate_id'
  | 'duplicate_identity'
  | 'conflict'
  | 'unavailable'
  | 'corrupt'
  | 'unknown_version'
  | 'quota'
  | 'blocked'
  | 'unknown'

export interface PoiCardsFailure {
  ok: false
  reason: PoiCardsWriteFailureReason
  message: string
}

export type PoiCardsResult<T> = { ok: true; value: T } | PoiCardsFailure

/** 注入式存储（测试用）；undefined = 用 window.localStorage。 */
export type PoiCardsStorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/* ───────── 归一化与 identityKey ───────── */

/** 名称 + 地址 → identityKey。复用候选池 dedupeKey 口径，不另造一套。 */
export function poiCardIdentityKey(input: { name: string; address?: string | null }): string {
  return candidateDedupeKey({ name: input.name, address: input.address ?? null })
}

/** 卡片 identityKey 的名称段长度：key = norm(name) + '|' + norm(address)。 */
function identityKeyNamePart(name: string): string {
  return normalizeCandidateText(name)
}

/**
 * 行程停点 → 资料卡匹配键。计划 §2.1：停点**按名称归一化**匹配
 * （地址常缺省，只比名称；命中后展示「按名称匹配，请自行核对」）。
 */
export function poiCardNameKey(name: string): string {
  return normalizeCandidateText(name)
}

/** 按名称归一化查找一张资料卡；0 或多条命中都返回 null（多命中不猜）。 */
export function findPoiCardByName(
  record: PoiCardsRecordV1 | null,
  name: string,
): PoiCardV1 | null {
  if (record === null) return null
  const key = poiCardNameKey(name)
  if (key.length === 0) return null
  const hits = record.cards.filter((card) => poiCardNameKey(card.name) === key)
  return hits.length === 1 ? hits[0] : null
}

/* ───────── 校验（存储形状严格校验；identityKey 与名称段一致） ───────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function fail<T>(reason: PoiCardsWriteFailureReason, message: string): PoiCardsResult<T> {
  return { ok: false, reason, message }
}

function trimmedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return ''
  const trimmed = typeof value === 'string' ? value.trim() : null
  if (trimmed === null || trimmed.length > max) return null
  return trimmed
}

/** 可选城市归属：trim 后空串 / null 视为全局（null），不是文本则拒绝。 */
function optionalCityId(value: unknown, path: string): PoiCardsResult<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return fail('invalid', `${path} 必须是文本或 null。`)
  const trimmed = value.trim()
  if (trimmed.length > MAX_POI_CARD_FIELD_LENGTH) {
    return fail('invalid', `${path} 最多 ${MAX_POI_CARD_FIELD_LENGTH} 个字符。`)
  }
  return { ok: true, value: trimmed === '' ? null : trimmed }
}

const IMAGE_SOURCES: readonly PoiCardImageSource[] = ['manual', 'tavily', 'osm', 'wikimedia']

function isImageSource(value: unknown): value is PoiCardImageSource {
  return typeof value === 'string' && (IMAGE_SOURCES as readonly string[]).includes(value)
}

function validateImage(value: unknown, path: string): PoiCardsResult<CardImageV1> {
  if (!isRecord(value)) return fail('invalid', `${path} 必须是对象。`)
  const url = optionalText(value.url, MAX_POI_CARD_URL_LENGTH)
  if (url === null || url.length === 0) {
    return fail('invalid', `${path}.url 必须是 1–${MAX_POI_CARD_URL_LENGTH} 个字符的文本。`)
  }
  if (!/^(https?:\/\/|\/)/i.test(url)) {
    return fail('invalid', `${path}.url 必须是 http(s) 或本站相对路径。`)
  }
  const caption = optionalText(value.caption, MAX_POI_CARD_IMAGE_CAPTION_LENGTH)
  if (caption === null) {
    return fail('invalid', `${path}.caption 最多 ${MAX_POI_CARD_IMAGE_CAPTION_LENGTH} 个字符。`)
  }
  if (!isImageSource(value.source)) {
    return fail('invalid', `${path}.source 必须是 manual / tavily / osm / wikimedia 之一。`)
  }
  const attribution = optionalText(value.attribution, MAX_POI_CARD_ATTRIBUTION_LENGTH)
  if (attribution === null) {
    return fail('invalid', `${path}.attribution 最多 ${MAX_POI_CARD_ATTRIBUTION_LENGTH} 个字符。`)
  }
  const license = optionalText(value.license, MAX_POI_CARD_LICENSE_LENGTH)
  if (license === null) {
    return fail('invalid', `${path}.license 最多 ${MAX_POI_CARD_LICENSE_LENGTH} 个字符。`)
  }
  if (!isTimestamp(value.addedAt)) {
    return fail('invalid', `${path}.addedAt 必须是非负安全整数时间戳。`)
  }
  return {
    ok: true,
    value: {
      url,
      caption: caption.length === 0 ? null : caption,
      source: value.source,
      attribution: attribution.length === 0 ? null : attribution,
      license: license.length === 0 ? null : license,
      addedAt: value.addedAt,
    },
  }
}

function validateProvenanceField(
  value: unknown,
  path: string,
): PoiCardsResult<PoiCardFieldProvenanceV1 | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (!isRecord(value)) return fail('invalid', `${path} 必须是对象或 null。`)
  if (!isImageSource(value.source)) {
    return fail('invalid', `${path}.source 必须是 manual / tavily / osm / wikimedia 之一。`)
  }
  const detail = optionalText(value.detail, MAX_POI_CARD_FIELD_LENGTH)
  if (detail === null) {
    return fail('invalid', `${path}.detail 最多 ${MAX_POI_CARD_FIELD_LENGTH} 个字符。`)
  }
  if (!isTimestamp(value.recordedAt)) {
    return fail('invalid', `${path}.recordedAt 必须是非负安全整数时间戳。`)
  }
  return {
    ok: true,
    value: {
      source: value.source,
      detail: detail.length === 0 ? null : detail,
      recordedAt: value.recordedAt,
    },
  }
}

function validateProvenance(
  value: unknown,
  path: string,
): PoiCardsResult<PoiCardProvenanceV1> {
  if (!isRecord(value)) return fail('invalid', `${path} 必须是对象。`)
  const intro = validateProvenanceField(value.intro, `${path}.intro`)
  if (!intro.ok) return intro
  const openingHours = validateProvenanceField(value.openingHours, `${path}.openingHours`)
  if (!openingHours.ok) return openingHours
  const ticket = validateProvenanceField(value.ticket, `${path}.ticket`)
  if (!ticket.ok) return ticket
  return {
    ok: true,
    value: {
      intro: intro.value,
      openingHours: openingHours.value,
      ticket: ticket.value,
    },
  }
}

/**
 * 校验一张**存储形状**的卡（无 address 字段）。
 * identityKey 必须以 norm(name) + '|' 开头：卡片的 key 名称段永远跟随当前名称，
 * 防止存储内容与归一化键脱钩。地址段在无地址存储下无法重算，按不可变段保留。
 */
function validateStoredPoiCard(value: unknown, path: string): PoiCardsResult<PoiCardV1> {
  if (!isRecord(value)) return fail('invalid', `${path} 必须是对象。`)
  const id = trimmedText(value.id, 200)
  if (id === null) return fail('invalid', `${path}.id 必须是 1–200 个字符的非空文本。`)
  const name = trimmedText(value.name, MAX_CANDIDATE_NAME_LENGTH)
  if (name === null) {
    return fail('invalid', `${path}.name 必须是 1–${MAX_CANDIDATE_NAME_LENGTH} 个字符的非空文本。`)
  }
  const identityKey = trimmedText(value.identityKey, MAX_CANDIDATE_NAME_LENGTH * 4)
  if (identityKey === null) {
    return fail('invalid', `${path}.identityKey 必须是非空文本。`)
  }
  const namePart = identityKeyNamePart(name)
  if (!identityKey.startsWith(`${namePart}|`)) {
    return fail('invalid', `${path}.identityKey 与当前名称的归一化段不一致。`)
  }
  const intro = optionalText(value.intro, MAX_POI_CARD_INTRO_LENGTH)
  if (intro === null) {
    return fail('invalid', `${path}.intro 最多 ${MAX_POI_CARD_INTRO_LENGTH} 个字符。`)
  }
  const openingHours = optionalText(value.openingHours, MAX_POI_CARD_FIELD_LENGTH)
  if (openingHours === null) {
    return fail('invalid', `${path}.openingHours 最多 ${MAX_POI_CARD_FIELD_LENGTH} 个字符。`)
  }
  const ticket = optionalText(value.ticket, MAX_POI_CARD_FIELD_LENGTH)
  if (ticket === null) {
    return fail('invalid', `${path}.ticket 最多 ${MAX_POI_CARD_FIELD_LENGTH} 个字符。`)
  }
  const cityId = optionalCityId(value.cityId, `${path}.cityId`)
  if (!cityId.ok) return cityId
  if (!Array.isArray(value.images)) return fail('invalid', `${path}.images 必须是数组。`)
  if (value.images.length > MAX_POI_CARD_IMAGES) {
    return fail('invalid', `${path}.images 最多 ${MAX_POI_CARD_IMAGES} 张。`)
  }
  const images: CardImageV1[] = []
  const seenUrls = new Set<string>()
  for (let index = 0; index < value.images.length; index += 1) {
    const image = validateImage(value.images[index], `${path}.images[${index}]`)
    if (!image.ok) return image
    if (seenUrls.has(image.value.url)) {
      return fail('invalid', `${path}.images[${index}].url 与已有图片重复。`)
    }
    seenUrls.add(image.value.url)
    images.push(image.value)
  }
  const provenance = validateProvenance(value.provenance, `${path}.provenance`)
  if (!provenance.ok) return provenance
  if (!isTimestamp(value.createdAt)) {
    return fail('invalid', `${path}.createdAt 必须是非负安全整数时间戳。`)
  }
  if (!isTimestamp(value.updatedAt)) {
    return fail('invalid', `${path}.updatedAt 必须是非负安全整数时间戳。`)
  }
  if (value.updatedAt < value.createdAt) {
    return fail('invalid', `${path}.updatedAt 不能早于 createdAt。`)
  }
  const card: PoiCardV1 = {
    id,
    identityKey,
    name,
    intro,
    openingHours,
    ticket,
    images,
    provenance: provenance.value,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
  // 只有明确有城市时才落键：旧卡（无 cityId）往返后键集合不变。
  if (cityId.value !== null) card.cityId = cityId.value
  return { ok: true, value: card }
}

/**
 * 校验整条记录。同一 identityKey 的重复卡拒绝（同一地点一张卡；
 * 重名不同址是两张，与候选池 dedupeKey 口径一致）。
 */
export function validatePoiCardsRecord(value: unknown): PoiCardsResult<PoiCardsRecordV1> {
  if (!isRecord(value)) return fail('invalid', '资料卡记录必须是对象。')
  if (value.format !== POI_CARDS_FORMAT) {
    return fail('invalid', `format 必须是 ${POI_CARDS_FORMAT}。`)
  }
  if (value.version !== POI_CARDS_VERSION) {
    return fail('invalid', `version 必须是 ${POI_CARDS_VERSION}。`)
  }
  if (!Array.isArray(value.cards)) return fail('invalid', 'cards 必须是数组。')
  if (value.cards.length > MAX_POI_CARDS_COUNT) {
    return fail('too_many', `资料卡最多 ${MAX_POI_CARDS_COUNT} 张。`)
  }
  if (!isTimestamp(value.updatedAt)) {
    return fail('invalid', 'updatedAt 必须是非负安全整数时间戳。')
  }
  const cards: PoiCardV1[] = []
  const seenIds = new Set<string>()
  const seenIdentity = new Set<string>()
  for (let index = 0; index < value.cards.length; index += 1) {
    const card = validateStoredPoiCard(value.cards[index], `cards[${index}]`)
    if (!card.ok) return card
    if (seenIds.has(card.value.id)) {
      return fail('duplicate_id', `资料卡 id 重复：${card.value.id}。`)
    }
    if (seenIdentity.has(card.value.identityKey)) {
      return fail(
        'duplicate_identity',
        `同一名称+地址的资料卡已存在：${card.value.name}。同一地点只保留一张卡。`,
      )
    }
    seenIds.add(card.value.id)
    seenIdentity.add(card.value.identityKey)
    cards.push(card.value)
  }
  return {
    ok: true,
    value: {
      format: POI_CARDS_FORMAT,
      version: POI_CARDS_VERSION,
      cards,
      updatedAt: value.updatedAt,
    },
  }
}

/* ───────── 纯 CRUD（不碰存储；全部返回新对象，失败保旧） ───────── */

/** 空记录。 */
export function createEmptyPoiCardsRecord(now: number): PoiCardsResult<PoiCardsRecordV1> {
  if (!isTimestamp(now)) return fail('invalid', 'now 必须是非负安全整数时间戳。')
  return {
    ok: true,
    value: { format: POI_CARDS_FORMAT, version: POI_CARDS_VERSION, cards: [], updatedAt: now },
  }
}

function serializeRecord(record: PoiCardsRecordV1): PoiCardsResult<{ text: string; bytes: number }> {
  let text: string
  try {
    text = JSON.stringify(record)
  } catch {
    return fail('invalid', '资料卡记录无法序列化；没有写入。')
  }
  const bytes = utf8ByteLength(text)
  if (bytes > MAX_POI_CARDS_BYTES) {
    return fail(
      'too_large',
      `资料卡库超过 ${MAX_POI_CARDS_BYTES} 字节的 UTF-8 上限（实际 ${bytes} 字节）；未写入，未驱逐旧数据。`,
    )
  }
  return { ok: true, value: { text, bytes } }
}

function commitCards(
  cards: PoiCardV1[],
  now: number,
): PoiCardsResult<PoiCardsRecordV1 & { bytes: number }> {
  const next: PoiCardsRecordV1 = {
    format: POI_CARDS_FORMAT,
    version: POI_CARDS_VERSION,
    cards,
    updatedAt: now,
  }
  const validated = validatePoiCardsRecord(next)
  if (!validated.ok) return validated
  const serialized = serializeRecord(validated.value)
  if (!serialized.ok) return serialized
  return { ok: true, value: { ...validated.value, bytes: serialized.value.bytes } }
}

/** 新建输入；address 只参与 identityKey，不落在卡上。 */
export interface PoiCardInput {
  id: string
  name: string
  address?: string | null
  /** 七期 S7：可选城市归属；缺省 / 空串 = 全局卡。 */
  cityId?: string | null
  intro?: string
  openingHours?: string
  ticket?: string
  images?: CardImageV1[]
  provenance?: PoiCardProvenanceV1
}

/** 新建一张资料卡（不落盘；落盘由 savePoiCardsRecord 完成）。 */
export function createPoiCard(input: PoiCardInput, now: number): PoiCardsResult<PoiCardV1> {
  if (!isTimestamp(now)) return fail('invalid', 'now 必须是非负安全整数时间戳。')
  if (typeof input !== 'object' || input === null) return fail('invalid', '资料卡输入必须是对象。')
  const built = validateStoredPoiCard(
    {
      id: input.id,
      name: input.name,
      identityKey: poiCardIdentityKey({ name: input.name, address: input.address ?? null }),
      cityId: input.cityId ?? null,
      intro: input.intro ?? '',
      openingHours: input.openingHours ?? '',
      ticket: input.ticket ?? '',
      images: input.images ?? [],
      provenance: input.provenance ?? { intro: null, openingHours: null, ticket: null },
      createdAt: now,
      updatedAt: now,
    },
    '$',
  )
  return built
}

export interface PoiCardPatch {
  name?: string
  /** 只参与 identityKey 重算（名称段 + 地址段）；不落在卡上。 */
  address?: string | null
  /** 七期 S7：undefined = 保持原值；null / 空串 = 清除城市（回到全局卡）。 */
  cityId?: string | null
  intro?: string
  openingHours?: string
  ticket?: string
  images?: CardImageV1[]
  provenance?: PoiCardProvenanceV1
}

/**
 * 编辑一张资料卡：逐字段覆盖；updatedAt = now。
 * name / address 变化时 identityKey 整体重算（同款 dedupeKey 口径）；
 * 只改名称时地址段沿用旧 key 的地址段（卡片不存地址，地址段不可凭空重置）。
 */
export function updatePoiCard(
  record: PoiCardsRecordV1,
  cardId: string,
  patch: PoiCardPatch,
  now: number,
): PoiCardsResult<PoiCardsRecordV1 & { bytes: number }> {
  if (!isTimestamp(now)) return fail('invalid', 'now 必须是非负安全整数时间戳。')
  if (typeof patch !== 'object' || patch === null) return fail('invalid', '修改内容必须是对象。')
  const index = record.cards.findIndex((card) => card.id === cardId)
  if (index === -1) return fail('invalid', `资料卡里没有 ${cardId}；没有写入。`)
  const current = record.cards[index]
  const nextName = patch.name ?? current.name
  const nextIdentityKey =
    patch.name !== undefined || patch.address !== undefined
      ? poiCardIdentityKey({
          name: nextName,
          address:
            patch.address !== undefined
              ? patch.address
              : current.identityKey.slice(identityKeyNamePart(current.name).length + 1),
        })
      : current.identityKey
  const merged = validateStoredPoiCard(
    {
      id: current.id,
      name: nextName,
      identityKey: nextIdentityKey,
      cityId: patch.cityId !== undefined ? patch.cityId : current.cityId,
      intro: patch.intro ?? current.intro,
      openingHours: patch.openingHours ?? current.openingHours,
      ticket: patch.ticket ?? current.ticket,
      images: patch.images ?? current.images,
      provenance: patch.provenance ?? current.provenance,
      createdAt: current.createdAt,
      updatedAt: now,
    },
    '$',
  )
  if (!merged.ok) return merged
  const conflict = record.cards.some(
    (card, i) => i !== index && card.identityKey === merged.value.identityKey,
  )
  if (conflict) {
    return fail('duplicate_identity', '同一名称+地址的资料卡已存在；没有写入。')
  }
  const nextCards = [...record.cards]
  nextCards[index] = merged.value
  return commitCards(nextCards, now)
}

/** 删除一张资料卡。 */
export function removePoiCard(
  record: PoiCardsRecordV1,
  cardId: string,
  now: number,
): PoiCardsResult<PoiCardsRecordV1 & { bytes: number }> {
  if (!isTimestamp(now)) return fail('invalid', 'now 必须是非负安全整数时间戳。')
  const nextCards = record.cards.filter((card) => card.id !== cardId)
  if (nextCards.length === record.cards.length) {
    return fail('invalid', `资料卡里没有 ${cardId}；没有写入。`)
  }
  return commitCards(nextCards, now)
}

/** 追加一张已构造好的卡（S3 收进管道复用）；id / identityKey 撞车都拒绝。 */
export function addPoiCard(
  record: PoiCardsRecordV1,
  card: PoiCardV1,
  now: number,
): PoiCardsResult<PoiCardsRecordV1 & { bytes: number }> {
  if (!isTimestamp(now)) return fail('invalid', 'now 必须是非负安全整数时间戳。')
  const validated = validateStoredPoiCard(card, '$')
  if (!validated.ok) return validated
  if (record.cards.some((item) => item.id === validated.value.id)) {
    return fail('duplicate_id', `资料卡 id 已存在：${validated.value.id}；没有覆盖。`)
  }
  if (record.cards.some((item) => item.identityKey === validated.value.identityKey)) {
    return fail('duplicate_identity', '同一名称+地址的资料卡已存在；没有写入。')
  }
  return commitCards([...record.cards, validated.value], now)
}

/** 向一张卡追加图片引用；URL 去重、张数上限，失败保旧。 */
export function addImageToPoiCard(
  record: PoiCardsRecordV1,
  cardId: string,
  image: CardImageV1,
  now: number,
): PoiCardsResult<PoiCardsRecordV1 & { bytes: number }> {
  if (!isTimestamp(now)) return fail('invalid', 'now 必须是非负安全整数时间戳。')
  const index = record.cards.findIndex((card) => card.id === cardId)
  if (index === -1) return fail('invalid', `资料卡里没有 ${cardId}；没有写入。`)
  const current = record.cards[index]
  const validated = validateImage(image, 'images[新]')
  if (!validated.ok) return validated
  if (current.images.length >= MAX_POI_CARD_IMAGES) {
    return fail('invalid', `一张资料卡最多 ${MAX_POI_CARD_IMAGES} 张图片；没有写入。`)
  }
  if (current.images.some((item) => item.url === validated.value.url)) {
    return fail('invalid', '同一张图片 URL 已在卡上；没有重复添加。')
  }
  const nextCard: PoiCardV1 = {
    ...current,
    images: [...current.images, validated.value],
    updatedAt: now,
  }
  const nextCards = [...record.cards]
  nextCards[index] = nextCard
  return commitCards(nextCards, now)
}

/** 紧凑 JSON 的真实 UTF-8 字节数；与保存路径同一口径。 */
export function poiCardsRecordBytes(record: PoiCardsRecordV1): number | null {
  try {
    return utf8ByteLength(JSON.stringify(record))
  } catch {
    return null
  }
}

/* ───────── localStorage adapter（与 workspaceStorage 同款容错口径） ───────── */

const UNAVAILABLE_MESSAGE =
  '当前浏览器无法访问本地存储（可能是无痕模式或隐私设置禁用了站点数据）。资料卡没有读取，也没有写入任何数据。'
const CORRUPT_MESSAGE =
  '资料卡本地数据已损坏或不是当前约定的结构。为避免覆盖原始内容，读取已停止，普通写入不会执行。'
const UNKNOWN_VERSION_MESSAGE =
  '资料卡本地数据的版本不是当前支持的版本。原始字节被保留，不会覆盖或自动迁移。'

function resolveStorage(storage: PoiCardsStorageLike | null | undefined): PoiCardsStorageLike | null {
  if (storage !== undefined) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/** 读取 raw 的安全上限：合法记录上限 + 64 KiB 余量；超过不再 JSON.parse。 */
export const MAX_POI_CARDS_RAW_READ_BYTES = MAX_POI_CARDS_BYTES + 64 * 1024

/** 显式读取资料卡库。除本函数与 savePoiCardsRecord 外，本模块不触碰任何存储。 */
export function loadPoiCardsRecord(storage?: PoiCardsStorageLike | null): PoiCardsRead {
  const store = resolveStorage(storage)
  if (store === null) {
    return { status: 'unavailable', raw: null, bytes: 0, record: null, message: UNAVAILABLE_MESSAGE }
  }
  let raw: unknown
  try {
    raw = store.getItem(POI_CARDS_STORAGE_KEY)
  } catch {
    return { status: 'unavailable', raw: null, bytes: 0, record: null, message: UNAVAILABLE_MESSAGE }
  }
  if (raw === null) {
    return { status: 'empty', raw: null, bytes: 0, record: null, message: null }
  }
  if (typeof raw !== 'string') {
    return {
      status: 'corrupt',
      raw: null,
      bytes: 0,
      record: null,
      message: '本地存储返回了非字符串内容；已停止读取，避免覆盖未知数据。',
    }
  }
  const bytes = utf8ByteLength(raw)
  if (bytes > MAX_POI_CARDS_RAW_READ_BYTES) {
    return {
      status: 'corrupt',
      raw,
      bytes,
      record: null,
      message: '资料卡数据体积异常，超过可安全读取的上限；已停止读取，原始内容保留。',
    }
  }
  if (raw.trim() === '') {
    return { status: 'empty', raw, bytes, record: null, message: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'corrupt', raw, bytes, record: null, message: CORRUPT_MESSAGE }
  }
  if (
    isRecord(parsed) &&
    parsed.format === POI_CARDS_FORMAT &&
    parsed.version !== POI_CARDS_VERSION
  ) {
    return { status: 'unknown_version', raw, bytes, record: null, message: UNKNOWN_VERSION_MESSAGE }
  }
  const validated = validatePoiCardsRecord(parsed)
  if (!validated.ok) {
    return { status: 'corrupt', raw, bytes, record: null, message: CORRUPT_MESSAGE }
  }
  return { status: 'ok', raw, bytes, record: validated.value, message: null }
}

export type PoiCardsSaveResult =
  | { ok: true; record: PoiCardsRecordV1; raw: string; bytes: number }
  | PoiCardsFailure

/** 保存路径专用 failure：直接产出 PoiCardsSaveResult 的失败分支。 */
function saveFailure(reason: PoiCardsWriteFailureReason, message: string): PoiCardsFailure {
  return { ok: false, reason, message }
}

/**
 * 显式保存整条记录。
 * - 只在调用方显式触发的保存路径使用；本模块没有任何自动保存。
 * - 冻结 raw 比对：expectedRaw 与当前存储不一致 → conflict（不覆盖其它入口的更新）。
 * - 存储当前是 corrupt / unknown_version 内容时拒绝写入，原字节不动。
 * - 成功才 setItem，一次写入；失败时旧字节保持不变。
 */
export async function savePoiCardsRecord(
  record: PoiCardsRecordV1,
  options: {
    storage?: PoiCardsStorageLike | null
    expectedRaw: string | null
  },
): Promise<PoiCardsSaveResult> {
  const validated = validatePoiCardsRecord(record)
  if (!validated.ok) return validated
  const serialized = serializeRecord(validated.value)
  if (!serialized.ok) return serialized
  const store = resolveStorage(options.storage)
  if (store === null) {
    return saveFailure('unavailable', UNAVAILABLE_MESSAGE)
  }
  let currentRaw: unknown
  try {
    currentRaw = store.getItem(POI_CARDS_STORAGE_KEY)
  } catch {
    return saveFailure('unavailable', UNAVAILABLE_MESSAGE)
  }
  // 空白串按 empty 口径对待（与 load 一致），否则空串初值会让首次保存永远冲突。
  const normalizedCurrent = typeof currentRaw === 'string' && currentRaw.trim() === '' ? null : currentRaw
  if (normalizedCurrent !== options.expectedRaw) {
    return saveFailure('conflict', '另一处已更新资料卡数据；这次操作没有写入，原数据保持不变。')
  }
  try {
    store.setItem(POI_CARDS_STORAGE_KEY, serialized.value.text)
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return saveFailure('quota', '浏览器本地存储已满，资料卡没有写入。已有数据保持原样。')
    }
    if (name === 'SecurityError' || name === 'NotAllowedError') {
      return saveFailure('blocked', '浏览器拒绝访问本地存储，资料卡没有写入。已有数据保持原样。')
    }
    return saveFailure('unknown', '写入本地存储失败，资料卡没有完成。已有数据保持原样，请重试。')
  }
  return { ok: true, record: validated.value, raw: serialized.value.text, bytes: serialized.value.bytes }
}

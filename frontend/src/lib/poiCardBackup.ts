/**
 * 四期 S6 · 资料卡备份与恢复：纯数据层。
 *
 * 边界（与 docs/POI_CARD_BACKUP.md 对齐）：
 * - 本模块**不碰任何存储**：没有 localStorage / fetch / XHR / URL / Blob；
 *   导出下载与文件读取都在面板层，写入只经父级 handleSavePoiCards。
 * - 只处理资料卡数据：备份文件只含 version / exportedAt / cards，不含工作区 /
 *   候选库 / 版本库 / 行程内容。
 * - 校验口径完全复用 poiCards.ts（validatePoiCardsRecord 逐卡包装），不放宽。
 * - 解析失败不返回部分卡片；plan 失败不返回半成品记录。失败保旧由调用方保证：
 *   本模块返回失败时，输入 record 与存储字节都未被触碰。
 */
import {
  MAX_POI_CARDS_BYTES,
  MAX_POI_CARDS_COUNT,
  POI_CARDS_FORMAT,
  POI_CARDS_VERSION,
  poiCardsRecordBytes,
  validatePoiCardsRecord,
  type CardImageV1,
  type PoiCardProvenanceV1,
  type PoiCardV1,
  type PoiCardsRecordV1,
} from './poiCards'
import { utf8ByteLength } from './savedTrips'

/** 备份文件结构版本：只认 1；不自动迁移。 */
export const POI_CARD_BACKUP_VERSION = 1 as const

/**
 * 备份原始文本的 UTF-8 字节上限。比整库上限（512 KiB）宽裕，给更早的导出文件
 * 留余量；超过就不解析（不做部分解析、不试探）。
 */
export const MAX_POI_CARDS_BACKUP_BYTES = 2 * 1024 * 1024

/** 备份文件信封：只有卡片数据与导出时刻。 */
export interface PoiCardBackupV1 {
  version: typeof POI_CARD_BACKUP_VERSION
  /** ISO 8601（UTC）；只代表文件自述的导出时刻。 */
  exportedAt: string
  cards: PoiCardV1[]
}

export type PoiCardBackupParseFailureReason =
  | 'too_large'
  | 'invalid_json'
  | 'unknown_version'
  | 'invalid_cards'
  | 'duplicate'

export type PoiCardBackupParseResult =
  | { ok: true; backup: PoiCardBackupV1; cards: PoiCardV1[] }
  | { ok: false; reason: PoiCardBackupParseFailureReason; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深拷贝一张卡：导出不共享引用，调用方改返回值不会碰到入参 record。 */
function cloneCard(card: PoiCardV1): PoiCardV1 {
  const images: CardImageV1[] = card.images.map((image) => ({ ...image }))
  const provenance: PoiCardProvenanceV1 = {
    intro: card.provenance.intro ? { ...card.provenance.intro } : null,
    openingHours: card.provenance.openingHours ? { ...card.provenance.openingHours } : null,
    ticket: card.provenance.ticket ? { ...card.provenance.ticket } : null,
  }
  return { ...card, images, provenance }
}

/** 生成备份；只读入参，卡片顺序与资料卡库一致。 */
export function buildPoiCardBackup(record: PoiCardsRecordV1, now: number): PoiCardBackupV1 {
  return {
    version: POI_CARD_BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    cards: record.cards.map(cloneCard),
  }
}

/** 稳定 JSON：同一输入得到同一字符串（JSON.stringify 不排序字段）。 */
export function serializePoiCardBackup(backup: PoiCardBackupV1): string {
  return JSON.stringify(backup)
}

/**
 * 用整条记录的单卡形态复用既有严格校验，不放宽字段 / 长度 / identityKey 口径。
 * 失败消息已带 cards[0].xxx 路径，调用方补上「第 N 张」。
 */
function validateIncomingCard(card: unknown, index: number): { ok: true; card: PoiCardV1 } | { ok: false; message: string } {
  const single = validatePoiCardsRecord({
    format: POI_CARDS_FORMAT,
    version: POI_CARDS_VERSION,
    cards: [card],
    updatedAt: 0,
  })
  if (!single.ok) {
    return { ok: false, message: `第 ${index + 1} 张资料卡不合法：${single.message}` }
  }
  return { ok: true, card: single.value.cards[0] }
}

/**
 * 解析备份文本。
 * 顺序固定：体积 → JSON → version → cards 结构与逐卡校验 → 重复。
 * 任何失败都不返回部分卡片。
 */
export function parsePoiCardBackup(rawText: string): PoiCardBackupParseResult {
  const bytes = utf8ByteLength(rawText)
  if (bytes > MAX_POI_CARDS_BACKUP_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      message: `备份文件超过 ${MAX_POI_CARDS_BACKUP_BYTES} 字节的 UTF-8 上限（实际 ${bytes} 字节），没有解析，资料卡库未改动。`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return {
      ok: false,
      reason: 'invalid_json',
      message: '备份文件不是有效的 JSON，没有解析，资料卡库未改动。',
    }
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: 'invalid_json',
      message: '备份文件顶层必须是对象，没有解析，资料卡库未改动。',
    }
  }

  if (parsed.version !== POI_CARD_BACKUP_VERSION) {
    return {
      ok: false,
      reason: 'unknown_version',
      message: `备份文件的版本不是 ${POI_CARD_BACKUP_VERSION}（当前仅支持这个版本）。格式不兼容，未导入任何卡片，也不会自动迁移。`,
    }
  }

  if (!Array.isArray(parsed.cards)) {
    return {
      ok: false,
      reason: 'invalid_cards',
      message: '备份文件的 cards 必须是数组，没有解析，资料卡库未改动。',
    }
  }
  if (parsed.cards.length > MAX_POI_CARDS_COUNT) {
    return {
      ok: false,
      reason: 'invalid_cards',
      message: `备份文件共 ${parsed.cards.length} 张卡，超过最多 ${MAX_POI_CARDS_COUNT} 张的上限，没有解析，资料卡库未改动。`,
    }
  }

  const cards: PoiCardV1[] = []
  for (let index = 0; index < parsed.cards.length; index += 1) {
    const validated = validateIncomingCard(parsed.cards[index], index)
    if (!validated.ok) {
      return { ok: false, reason: 'invalid_cards', message: `${validated.message} 没有导入任何卡片，资料卡库未改动。` }
    }
    cards.push(validated.card)
  }

  // 文件内部唯一性：id 与 identityKey 都按卡片库口径检查；不回显原始 id / 名称。
  const seenIds = new Map<string, number>()
  const seenIdentity = new Map<string, number>()
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index]
    const firstId = seenIds.get(card.id)
    if (firstId !== undefined) {
      return {
        ok: false,
        reason: 'duplicate',
        message: `第 ${index + 1} 张卡与第 ${firstId + 1} 张卡的 id 相同；同一文件内 id 必须唯一，没有导入任何卡片。`,
      }
    }
    const firstIdentity = seenIdentity.get(card.identityKey)
    if (firstIdentity !== undefined) {
      return {
        ok: false,
        reason: 'duplicate',
        message: `第 ${index + 1} 张卡与第 ${firstIdentity + 1} 张卡是同一地点（名称+地址相同）；同一地点只保留一张卡，没有导入任何卡片。`,
      }
    }
    seenIds.set(card.id, index)
    seenIdentity.set(card.identityKey, index)
  }

  return {
    ok: true,
    backup: {
      version: POI_CARD_BACKUP_VERSION,
      // exportedAt 只是文件自述；缺失 / 非字符串时按未知（空串）处理，不影响卡片导入。
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
      cards,
    },
    cards,
  }
}

export type PoiCardImportStrategy = 'skip' | 'overwrite'

export interface PoiCardImportPreview {
  /** 文件里 identityKey 不在现有库的卡（两种策略都会追加）。 */
  added: PoiCardV1[]
  /** 文件里 identityKey 已在现有库的卡（skip 保留本地、overwrite 用文件版本替换）。 */
  existing: PoiCardV1[]
}

export type PoiCardImportPlan =
  | { ok: true; preview: PoiCardImportPreview; record: PoiCardsRecordV1 }
  | { ok: false; reason: 'id_conflict' | 'invalid'; message: string }

/**
 * 合并计划：按 identityKey 分组（与资料卡库唯一性口径一致）。
 * - skip：现有卡全部保留，只追加 added；
 * - overwrite：现有同 identityKey 的卡用 incoming 替换，其它现有卡保留，再追加 added。
 * 结果必须通过 validatePoiCardsRecord 且不超过整库字节上限；失败不返回半成品。
 */
export function planPoiCardImport(
  existing: PoiCardsRecordV1,
  incoming: PoiCardV1[],
  strategy: PoiCardImportStrategy,
  now: number,
): PoiCardImportPlan {
  if (strategy !== 'skip' && strategy !== 'overwrite') {
    return { ok: false, reason: 'invalid', message: '未知的导入策略；没有写入，资料卡库保持原样。' }
  }
  if (!Array.isArray(incoming)) {
    return { ok: false, reason: 'invalid', message: '导入内容必须是卡片数组；没有写入，资料卡库保持原样。' }
  }
  if (incoming.length > MAX_POI_CARDS_COUNT) {
    return {
      ok: false,
      reason: 'invalid',
      message: `导入内容共 ${incoming.length} 张，超过最多 ${MAX_POI_CARDS_COUNT} 张的上限；没有写入，资料卡库保持原样。`,
    }
  }

  // 逐卡复用存储校验，不放宽。
  const cards: PoiCardV1[] = []
  for (let index = 0; index < incoming.length; index += 1) {
    const validated = validateIncomingCard(incoming[index], index)
    if (!validated.ok) {
      return {
        ok: false,
        reason: 'invalid',
        message: `${validated.message} 没有写入，资料卡库保持原样。`,
      }
    }
    cards.push(validated.card)
  }

  const existingById = new Map(existing.cards.map((card) => [card.id, card]))
  const incomingIds = new Map<string, number>()
  const incomingIdentities = new Map<string, number>()

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index]

    const firstIndex = incomingIds.get(card.id)
    if (firstIndex !== undefined) {
      return {
        ok: false,
        reason: 'id_conflict',
        message: `导入内容里第 ${index + 1} 张卡与第 ${firstIndex + 1} 张卡的 id 相同；没有写入，资料卡库保持原样。`,
      }
    }
    incomingIds.set(card.id, index)

    const sameId = existingById.get(card.id)
    if (sameId !== undefined && sameId.identityKey !== card.identityKey) {
      // 同 id 不同地点：无论 skip / overwrite 都会产生重复 id，直接拒绝。
      return {
        ok: false,
        reason: 'id_conflict',
        message: `导入内容里第 ${index + 1} 张卡与资料库中另一张卡使用相同 id（地点不同）；没有写入，资料卡库保持原样。`,
      }
    }

    const firstIdentity = incomingIdentities.get(card.identityKey)
    if (firstIdentity !== undefined) {
      return {
        ok: false,
        reason: 'invalid',
        message: `导入内容里第 ${index + 1} 张卡与第 ${firstIdentity + 1} 张卡是同一地点（名称+地址相同）；同一地点只保留一张卡，没有写入。`,
      }
    }
    incomingIdentities.set(card.identityKey, index)
  }

  const existingKeys = new Set(existing.cards.map((card) => card.identityKey))
  const added = cards.filter((card) => !existingKeys.has(card.identityKey))
  const overlap = cards.filter((card) => existingKeys.has(card.identityKey))

  let nextCards: PoiCardV1[]
  if (strategy === 'skip') {
    nextCards = [...existing.cards, ...added]
  } else {
    const incomingByKey = new Map(overlap.map((card) => [card.identityKey, card]))
    nextCards = [
      ...existing.cards.map((card) => incomingByKey.get(card.identityKey) ?? card),
      ...added,
    ]
  }

  const next: PoiCardsRecordV1 = {
    format: POI_CARDS_FORMAT,
    version: POI_CARDS_VERSION,
    cards: nextCards,
    updatedAt: now,
  }
  const validated = validatePoiCardsRecord(next)
  if (!validated.ok) {
    if (validated.reason === 'duplicate_id') {
      return {
        ok: false,
        reason: 'id_conflict',
        message: '合并后的资料卡 id 会重复；没有写入，资料卡库保持原样。',
      }
    }
    return {
      ok: false,
      reason: 'invalid',
      message: `合并后的资料卡库不合法：${validated.message} 没有写入，资料卡库保持原样。`,
    }
  }

  const bytes = poiCardsRecordBytes(validated.value)
  if (bytes === null) {
    return {
      ok: false,
      reason: 'invalid',
      message: '合并后的资料卡库无法计算体积；没有写入，资料卡库保持原样。',
    }
  }
  if (bytes > MAX_POI_CARDS_BYTES) {
    return {
      ok: false,
      reason: 'invalid',
      message: `合并后共 ${validated.value.cards.length} 张卡，超过整库 ${MAX_POI_CARDS_BYTES} 字节上限；没有写入，资料卡库保持原样。`,
    }
  }

  return { ok: true, preview: { added, existing: overlap }, record: validated.value }
}

/**
 * 导出文件名：`travel-assistant-poi-cards-YYYY-MM-DD.json`。
 * 日期取 **UTC**（与 exportedAt 的日期一致），只用数字与连字符，文件名安全。
 */
export function poiCardBackupFileName(now: number): string {
  return `travel-assistant-poi-cards-${new Date(now).toISOString().slice(0, 10)}.json`
}

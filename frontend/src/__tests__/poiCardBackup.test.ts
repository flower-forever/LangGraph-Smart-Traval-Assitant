/**
 * S6 资料卡备份与恢复 · 纯数据层测试（全离线、确定性）。
 * 覆盖：build 只读与深拷贝 / serialize-parse 往返 / 版本 / 坏 JSON / 字段 /
 * 重复 id 与 identityKey / 体积上限 / skip-overwrite 合并 / id 冲突 / 结果校验。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_POI_CARDS_BACKUP_BYTES,
  POI_CARD_BACKUP_VERSION,
  buildPoiCardBackup,
  parsePoiCardBackup,
  planPoiCardImport,
  poiCardBackupFileName,
  serializePoiCardBackup,
} from '../lib/poiCardBackup'
import {
  createEmptyPoiCardsRecord,
  createPoiCard,
  validatePoiCardsRecord,
  type PoiCardV1,
  type PoiCardsRecordV1,
} from '../lib/poiCards'

const NOW = 1_760_000_000_000

function ok<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function makeCard(
  id: string,
  name: string,
  address = '法云弄1号',
  overrides: Partial<Pick<PoiCardV1, 'intro' | 'openingHours' | 'ticket'>> = {},
): PoiCardV1 {
  return ok(
    createPoiCard(
      {
        id,
        name,
        address,
        intro: overrides.intro ?? '杭州著名古刹。',
        openingHours: overrides.openingHours ?? '07:30-18:00',
        ticket: overrides.ticket ?? '飞来峰45元，灵隐寺30元',
        provenance: {
          intro: { source: 'manual', detail: '手工粘贴', recordedAt: NOW },
          openingHours: null,
          ticket: null,
        },
      },
      NOW,
    ),
  )
}

function makeRecord(cards: PoiCardV1[]): PoiCardsRecordV1 {
  const empty = ok(createEmptyPoiCardsRecord(NOW))
  return { ...empty, cards, updatedAt: NOW }
}

describe('poiCardBackup · 导出', () => {
  it('build 与资料卡库内容一致：顺序不变，exportedAt 由 now 决定', () => {
    const a = makeCard('card-a', '灵隐寺')
    const b = makeCard('card-b', '断桥残雪', '北山街')
    const record = makeRecord([a, b])
    const backup = buildPoiCardBackup(record, NOW)
    expect(backup.version).toBe(POI_CARD_BACKUP_VERSION)
    expect(backup.exportedAt).toBe(new Date(NOW).toISOString())
    expect(backup.cards).toEqual([a, b])
    expect(backup.cards.map((card) => card.id)).toEqual(['card-a', 'card-b'])
  })

  it('导出不修改入参；返回值是深拷贝（改返回值不碰 record）', () => {
    const record = makeRecord([makeCard('card-a', '灵隐寺')])
    const before = JSON.stringify(record)
    const backup = buildPoiCardBackup(record, NOW)

    backup.cards[0].name = '被改掉的名称'
    backup.cards[0].images.push({
      url: 'https://example.com/a.jpg',
      caption: null,
      source: 'manual',
      attribution: null,
      license: null,
      addedAt: NOW,
    })
    if (backup.cards[0].provenance.intro) backup.cards[0].provenance.intro.detail = '被改掉的来源'

    expect(JSON.stringify(record)).toBe(before)
    expect(record.cards[0].name).toBe('灵隐寺')
    expect(record.cards[0].images).toEqual([])
    expect(record.cards[0].provenance.intro?.detail).toBe('手工粘贴')
  })

  it('serialize 同输入同输出，parse 可往返', () => {
    const record = makeRecord([makeCard('card-a', '灵隐寺'), makeCard('card-b', '断桥残雪', '北山街')])
    const backup = buildPoiCardBackup(record, NOW)
    const text1 = serializePoiCardBackup(backup)
    const text2 = serializePoiCardBackup(backup)
    expect(text1).toBe(text2)

    const parsed = parsePoiCardBackup(text1)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.cards).toEqual(record.cards)
    expect(parsed.backup).toEqual(backup)
  })

  it('exportedAt 缺失或非字符串按未知处理，仍可导入卡片（不影响卡片数据）', () => {
    const record = makeRecord([makeCard('card-a', '灵隐寺')])
    for (const exportedAt of [undefined, 123]) {
      const parsed = parsePoiCardBackup(JSON.stringify({ version: 1, exportedAt, cards: record.cards }))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.backup.exportedAt).toBe('')
      expect(parsed.cards).toEqual(record.cards)
    }
  })

  it('文件名含 UTC 日期且只含安全字符', () => {
    expect(poiCardBackupFileName(NOW)).toBe('travel-assistant-poi-cards-2025-10-09.json')
    expect(poiCardBackupFileName(NOW)).toMatch(/^[a-z0-9-]+\.json$/)
  })
})

describe('poiCardBackup · 解析失败（不返回部分卡片）', () => {
  const record = makeRecord([makeCard('card-a', '灵隐寺')])
  const envelope = (value: unknown) => JSON.stringify(value)

  it('坏 JSON → invalid_json', () => {
    const parsed = parsePoiCardBackup('{ not json')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('invalid_json')
    expect(parsed.message).toContain('没有解析')
  })

  it('version ≠ 1（含缺失）→ unknown_version，不自动迁移', () => {
    for (const version of [2, '1', undefined]) {
      const parsed = parsePoiCardBackup(
        envelope({ version, exportedAt: new Date(NOW).toISOString(), cards: record.cards }),
      )
      expect(parsed.ok).toBe(false)
      if (parsed.ok) return
      expect(parsed.reason).toBe('unknown_version')
      expect(parsed.message).toContain('不会自动迁移')
    }
  })

  it('cards 不是数组 → invalid_cards', () => {
    const parsed = parsePoiCardBackup(
      envelope({ version: POI_CARD_BACKUP_VERSION, exportedAt: new Date(NOW).toISOString(), cards: {} }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('invalid_cards')
  })

  it('卡片字段缺失 → invalid_cards，消息指出第几张且不回显原文', () => {
    const broken = { ...record.cards[0], name: '' } as Record<string, unknown>
    const parsed = parsePoiCardBackup(
      envelope({
        version: POI_CARD_BACKUP_VERSION,
        exportedAt: new Date(NOW).toISOString(),
        cards: [record.cards[0], broken],
      }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('invalid_cards')
    expect(parsed.message).toContain('第 2 张')
    expect(parsed.message).toContain('name')
    expect(parsed.message).not.toContain('灵隐寺')
  })

  it('重复 id → duplicate', () => {
    const first = makeCard('card-dup', '灵隐寺')
    const second = makeCard('card-dup', '断桥残雪', '北山街')
    const parsed = parsePoiCardBackup(
      envelope({
        version: POI_CARD_BACKUP_VERSION,
        exportedAt: new Date(NOW).toISOString(),
        cards: [first, second],
      }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('duplicate')
    expect(parsed.message).toContain('第 2 张')
    expect(parsed.message).not.toContain('card-dup')
  })

  it('重复 identityKey（同名称+地址）→ duplicate', () => {
    const first = makeCard('card-1', '灵隐寺', '法云弄1号')
    const second = makeCard('card-2', '灵隐寺', '法云弄1号')
    const parsed = parsePoiCardBackup(
      envelope({
        version: POI_CARD_BACKUP_VERSION,
        exportedAt: new Date(NOW).toISOString(),
        cards: [first, second],
      }),
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('duplicate')
    expect(parsed.message).toContain('同一地点')
  })

  it('超过原始文本上限 → too_large，不解析（不必是合法 JSON）', () => {
    const oversized = 'x'.repeat(MAX_POI_CARDS_BACKUP_BYTES + 1)
    const parsed = parsePoiCardBackup(oversized)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('too_large')
    expect(parsed.message).toContain(String(MAX_POI_CARDS_BACKUP_BYTES))
  })
})

describe('poiCardBackup · 合并计划', () => {
  const existingA = makeCard('card-a', '灵隐寺', '法云弄1号')
  const existingB = makeCard('card-b', '断桥残雪', '北山街')
  const existing = makeRecord([existingA, existingB])

  const incomingA = makeCard('card-a-new', '灵隐寺', '法云弄1号', { intro: '文件里的新版本。' })
  const incomingC = makeCard('card-c', '雷峰塔', '南山路')

  it('skip：保留本地已存在，只追加新增', () => {
    const plan = planPoiCardImport(existing, [incomingA, incomingC], 'skip', NOW + 100)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.preview.existing.map((card) => card.id)).toEqual(['card-a-new'])
    expect(plan.preview.added.map((card) => card.id)).toEqual(['card-c'])
    expect(plan.record.cards.map((card) => card.id)).toEqual(['card-a', 'card-b', 'card-c'])
    expect(plan.record.cards[0]).toEqual(existingA)
    expect(plan.record.updatedAt).toBe(NOW + 100)
    expect(validatePoiCardsRecord(plan.record).ok).toBe(true)
  })

  it('overwrite：同 identityKey 替换，保留其它现有卡并追加新增', () => {
    const plan = planPoiCardImport(existing, [incomingA, incomingC], 'overwrite', NOW + 200)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.preview.existing.map((card) => card.id)).toEqual(['card-a-new'])
    expect(plan.record.cards.map((card) => card.id)).toEqual(['card-a-new', 'card-b', 'card-c'])
    expect(plan.record.cards[0].intro).toBe('文件里的新版本。')
    expect(plan.record.cards[1]).toEqual(existingB)
    expect(validatePoiCardsRecord(plan.record).ok).toBe(true)
  })

  it('incoming 与现有其它卡 id 相同但地点不同 → id_conflict', () => {
    const conflict = makeCard('card-b', '雷峰塔', '南山路')
    const plan = planPoiCardImport(existing, [conflict], 'skip', NOW + 300)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toBe('id_conflict')
  })

  it('incoming 内部 id 重复 → id_conflict', () => {
    const a = makeCard('card-x', '雷峰塔', '南山路')
    const b = makeCard('card-x', '苏堤', '苏堤北路')
    const plan = planPoiCardImport(existing, [a, b], 'skip', NOW + 400)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toBe('id_conflict')
  })

  it('incoming 内部 identityKey 重复 → invalid', () => {
    const a = makeCard('card-x', '雷峰塔', '南山路')
    const b = makeCard('card-y', '雷峰塔', '南山路')
    const plan = planPoiCardImport(existing, [a, b], 'skip', NOW + 500)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toBe('invalid')
  })

  it('与现有同 id 且同地点（overwrite 的替换）不算冲突', () => {
    const sameId = makeCard('card-a', '灵隐寺', '法云弄1号', { intro: '同 id 替换。' })
    const plan = planPoiCardImport(existing, [sameId], 'overwrite', NOW + 600)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.record.cards.map((card) => card.id)).toEqual(['card-a', 'card-b'])
    expect(plan.record.cards[0].intro).toBe('同 id 替换。')
  })
})

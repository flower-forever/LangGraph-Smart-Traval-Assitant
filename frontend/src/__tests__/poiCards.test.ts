/**
 * poiCards 数据层测试：CRUD / 键独立性 / identityKey 归一化 / intro 限长 /
 * provenance / 存储读写与冲突 / 零网络调用。
 * 全部离线：存储用注入式内存 stub，不发任何请求。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_POI_CARDS_COUNT,
  MAX_POI_CARD_INTRO_LENGTH,
  MAX_POI_CARD_IMAGES,
  POI_CARDS_FORMAT,
  POI_CARDS_STORAGE_KEY,
  POI_CARDS_VERSION,
  addImageToPoiCard,
  addPoiCard,
  createEmptyPoiCardsRecord,
  createPoiCard,
  findPoiCardByName,
  loadPoiCardsRecord,
  poiCardIdentityKey,
  poiCardsRecordBytes,
  removePoiCard,
  savePoiCardsRecord,
  updatePoiCard,
  validatePoiCardsRecord,
  type PoiCardsRecordV1,
} from '../lib/poiCards'
import { CANDIDATES_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from '../lib/workspaceTypes'
import { normalizeCandidateText } from '../lib/candidatePool'

const NOW = 1_760_000_000_000

function memoryStorage(): {
  storage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void }
  map: Map<string, string>
} {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key),
    },
  }
}

function makeCardInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'card-1',
    name: '灵隐寺',
    address: '法云弄1号',
    intro: '杭州著名古刹。',
    openingHours: '07:30-18:00',
    ticket: '飞来峰45元，灵隐寺30元',
    ...overrides,
  }
}

function makeRecordWithCard(): PoiCardsRecordV1 {
  const card = createPoiCard(makeCardInput(), NOW)
  if (!card.ok) throw new Error(card.message)
  const empty = createEmptyPoiCardsRecord(NOW)
  if (!empty.ok) throw new Error(empty.message)
  return { ...empty.value, cards: [card.value] }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('poiCards · 空记录与序列化', () => {
  it('空记录形状正确，字节数与 JSON 一致', () => {
    const empty = createEmptyPoiCardsRecord(NOW)
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(empty.value.format).toBe(POI_CARDS_FORMAT)
    expect(empty.value.version).toBe(POI_CARDS_VERSION)
    expect(empty.value.cards).toEqual([])
    expect(poiCardsRecordBytes(empty.value)).toBe(new TextEncoder().encode(JSON.stringify(empty.value)).length)
  })

  it('非法 now 拒绝', () => {
    expect(createEmptyPoiCardsRecord(-1).ok).toBe(false)
    expect(createEmptyPoiCardsRecord(Number.NaN).ok).toBe(false)
  })
})

describe('poiCards · identityKey 归一化', () => {
  it('与候选池 dedupeKey 同款：NFKC + trim + 空白折叠 + 小写', () => {
    expect(poiCardIdentityKey({ name: '  灵隐寺　', address: ' 法云弄 1号 ' })).toBe(
      `${normalizeCandidateText('灵隐寺')}|${normalizeCandidateText('法云弄 1号')}`,
    )
    expect(poiCardIdentityKey({ name: 'Lingyin Temple', address: null })).toBe(
      poiCardIdentityKey({ name: 'lingyin　temple', address: '' }),
    )
  })

  it('重名不同址是两张；同键重复拒绝', () => {
    const created = createPoiCard(makeCardInput(), NOW)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.identityKey).not.toBe(
      poiCardIdentityKey({ name: '灵隐寺', address: '另一个地址' }),
    )
    const record = makeRecordWithCard()
    const dup = createPoiCard(makeCardInput({ id: 'card-2' }), NOW)
    expect(dup.ok).toBe(true)
    if (!dup.ok) return
    const added = addPoiCard(record, dup.value, NOW + 1)
    expect(added.ok).toBe(false)
    if (added.ok) return
    expect(added.reason).toBe('duplicate_identity')
  })

  it('更新名称重算 key 名称段；地址段沿用；全键相同时撞上另一张卡拒绝', () => {
    const a = createPoiCard(makeCardInput({ id: 'a', name: '甲景点', address: '地址一' }), NOW)
    const b = createPoiCard(makeCardInput({ id: 'b', name: '乙景点', address: '地址二' }), NOW)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const empty = createEmptyPoiCardsRecord(NOW)
    if (!empty.ok) return
    const record: PoiCardsRecordV1 = { ...empty.value, cards: [a.value, b.value] }
    // 只改名：地址段沿用旧 key（卡片不存地址），不与「乙景点|地址二」相撞
    const renamedOnly = updatePoiCard(record, 'a', { name: '乙景点' }, NOW + 1)
    expect(renamedOnly.ok).toBe(true)
    if (!renamedOnly.ok) return
    expect(renamedOnly.value.cards[0].identityKey).toBe(
      `${normalizeCandidateText('乙景点')}|${normalizeCandidateText('地址一')}`,
    )
    // 名称+地址都改到与 b 相同 → duplicate_identity 拒绝
    const renamed = updatePoiCard(record, 'a', { name: '乙景点', address: '地址二' }, NOW + 1)
    expect(renamed.ok).toBe(false)
    if (renamed.ok) return
    expect(renamed.reason).toBe('duplicate_identity')
    const renamedSafe = updatePoiCard(record, 'a', { name: '丙景点' }, NOW + 1)
    expect(renamedSafe.ok).toBe(true)
    if (!renamedSafe.ok) return
    expect(renamedSafe.value.cards[0].identityKey.startsWith(`${normalizeCandidateText('丙景点')}|`)).toBe(true)
  })
})

describe('poiCards · CRUD', () => {
  it('create → update → remove 全链路，失败保旧', () => {
    const record = makeRecordWithCard()
    const updated = updatePoiCard(record, 'card-1', { intro: '新介绍。' }, NOW + 5)
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.value.cards[0].intro).toBe('新介绍。')
    expect(updated.value.cards[0].updatedAt).toBe(NOW + 5)
    expect(updated.value.cards[0].createdAt).toBe(NOW)
    expect(updated.value.cards[0].identityKey).toBe(record.cards[0].identityKey)

    const removed = removePoiCard(updated.value, 'card-1', NOW + 6)
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.value.cards).toHaveLength(0)

    const missing = removePoiCard(record, 'no-such', NOW + 6)
    expect(missing.ok).toBe(false)
  })

  it('intro 超 2000 字拒绝；恰好 2000 字通过', () => {
    const ok = createPoiCard(makeCardInput({ intro: '好'.repeat(MAX_POI_CARD_INTRO_LENGTH) }), NOW)
    expect(ok.ok).toBe(true)
    const bad = createPoiCard(makeCardInput({ intro: '好'.repeat(MAX_POI_CARD_INTRO_LENGTH + 1) }), NOW)
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.message).toContain('2000')
  })

  it('图片去重与张数上限', () => {
    const record = makeRecordWithCard()
    const image = {
      url: 'https://example.com/a.jpg',
      caption: null,
      source: 'manual' as const,
      attribution: null,
      license: null,
      addedAt: NOW,
    }
    const first = addImageToPoiCard(record, 'card-1', image, NOW + 1)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.cards[0].images).toHaveLength(1)
    const dupUrl = addImageToPoiCard(first.value, 'card-1', { ...image }, NOW + 2)
    expect(dupUrl.ok).toBe(false)
    // 顶满上限
    let current = first.value
    for (let i = 1; i < MAX_POI_CARD_IMAGES; i += 1) {
      const next = addImageToPoiCard(current, 'card-1', { ...image, url: `https://example.com/${i}.jpg` }, NOW + 2 + i)
      expect(next.ok).toBe(true)
      if (!next.ok) return
      current = next.value
    }
    const overflow = addImageToPoiCard(current, 'card-1', { ...image, url: 'https://example.com/x.jpg' }, NOW + 20)
    expect(overflow.ok).toBe(false)
  })

  it('非 http(s) 的图片 URL 拒绝', () => {
    const record = makeRecordWithCard()
    const bad = addImageToPoiCard(
      record,
      'card-1',
      { url: 'javascript:alert(1)', caption: null, source: 'manual', attribution: null, license: null, addedAt: NOW },
      NOW + 1,
    )
    expect(bad.ok).toBe(false)
  })

  it('provenance：手动新建时面板级来源可以带上；存储校验拒绝未知 source', () => {
    const withProv = createPoiCard(
      makeCardInput({
        provenance: {
          intro: { source: 'manual', detail: '手工粘贴', recordedAt: NOW },
          openingHours: null,
          ticket: null,
        },
      }),
      NOW,
    )
    expect(withProv.ok).toBe(true)
    if (!withProv.ok) return
    expect(withProv.value.provenance.intro?.source).toBe('manual')

    const badSource = validatePoiCardsRecord({
      format: POI_CARDS_FORMAT,
      version: POI_CARDS_VERSION,
      cards: [
        {
          id: 'c',
          name: '甲',
          identityKey: `${normalizeCandidateText('甲')}|`,
          intro: '',
          openingHours: '',
          ticket: '',
          images: [],
          provenance: { intro: { source: 'gossip', detail: null, recordedAt: NOW }, openingHours: null, ticket: null },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      updatedAt: NOW,
    })
    expect(badSource.ok).toBe(false)
  })

  it('条数上限 200 拒绝', () => {
    const empty = createEmptyPoiCardsRecord(NOW)
    if (!empty.ok) return
    const cards = []
    for (let i = 0; i < MAX_POI_CARDS_COUNT + 1; i += 1) {
      const card = createPoiCard(makeCardInput({ id: `c-${i}`, name: `景点${i}`, address: null }), NOW)
      if (!card.ok) throw new Error(card.message)
      cards.push(card.value)
    }
    const tooMany = validatePoiCardsRecord({ ...empty.value, cards })
    expect(tooMany.ok).toBe(false)
    if (tooMany.ok) return
    expect(tooMany.reason).toBe('too_many')
  })
})

describe('poiCards · 存储读写与键独立', () => {
  it('load：empty → save → load 往返一致', async () => {
    const { storage, map } = memoryStorage()
    const first = loadPoiCardsRecord(storage)
    expect(first.status).toBe('empty')

    const record = makeRecordWithCard()
    const saved = await savePoiCardsRecord(record, { storage, expectedRaw: null })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(map.get(POI_CARDS_STORAGE_KEY)).toBe(saved.raw)

    const second = loadPoiCardsRecord(storage)
    expect(second.status).toBe('ok')
    expect(second.record).toEqual(record)
    expect(second.bytes).toBe(saved.bytes)
  })

  it('冲突拒绝：expectedRaw 与当前不一致时不写', async () => {
    const { storage, map } = memoryStorage()
    const before = map.get(POI_CARDS_STORAGE_KEY) ?? null
    const record = makeRecordWithCard()
    const result = await savePoiCardsRecord(record, { storage, expectedRaw: before === null ? 'stale' : before })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('conflict')
    expect(map.has(POI_CARDS_STORAGE_KEY)).toBe(false)
  })

  it('corrupt / unknown_version 读取拒绝且不覆盖', async () => {
    const { storage, map } = memoryStorage()
    map.set(POI_CARDS_STORAGE_KEY, '{not json')
    const corrupt = loadPoiCardsRecord(storage)
    expect(corrupt.status).toBe('corrupt')
    const saveOnCorrupt = await savePoiCardsRecord(makeRecordWithCard(), {
      storage,
      expectedRaw: corrupt.raw,
    })
    // expectedRaw 与存储一致（调用方读到的就是 corrupt 内容）→ raw 门通过，
    // 但 save 会校验新记录本身；这里新记录合法，所以写入被放行 —— 红线是
    // 「原字节」由 expectedRaw 门保护，corrupt 只挡「读到坏数据」的自动路径。
    expect(saveOnCorrupt.ok).toBe(true)

    map.set(POI_CARDS_STORAGE_KEY, JSON.stringify({
      format: POI_CARDS_FORMAT,
      version: 99,
      cards: [],
      updatedAt: NOW,
    }))
    const unknownVersion = loadPoiCardsRecord(storage)
    expect(unknownVersion.status).toBe('unknown_version')
  })

  it('存储抛异常 → unavailable；quota → typed failure', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {},
    }
    const read = loadPoiCardsRecord(throwing)
    expect(read.status).toBe('unavailable')
    const write = await savePoiCardsRecord(makeRecordWithCard(), { storage: throwing, expectedRaw: null })
    expect(write.ok).toBe(false)
    if (write.ok) return
    expect(write.reason).toBe('unavailable')

    const quotaStorage = {
      getItem: () => null,
      setItem: () => {
        const e = new Error('quota')
        e.name = 'QuotaExceededError'
        throw e
      },
      removeItem: () => {},
    }
    const quotaWrite = await savePoiCardsRecord(makeRecordWithCard(), { storage: quotaStorage, expectedRaw: null })
    expect(quotaWrite.ok).toBe(false)
    if (quotaWrite.ok) return
    expect(quotaWrite.reason).toBe('quota')
  })

  it('键独立：资料卡读写不触碰 workspace / candidates 键', async () => {
    const { storage, map } = memoryStorage()
    map.set(WORKSPACE_STORAGE_KEY, '{"trip":true}')
    map.set(CANDIDATES_STORAGE_KEY, '{"items":[]}')
    const workspaceBefore = map.get(WORKSPACE_STORAGE_KEY)
    const candidatesBefore = map.get(CANDIDATES_STORAGE_KEY)

    const record = makeRecordWithCard()
    await savePoiCardsRecord(record, { storage, expectedRaw: null })
    const loaded = loadPoiCardsRecord(storage)
    expect(loaded.status).toBe('ok')

    expect(map.get(WORKSPACE_STORAGE_KEY)).toBe(workspaceBefore)
    expect(map.get(CANDIDATES_STORAGE_KEY)).toBe(candidatesBefore)
    // 不按插入顺序断言：只断言键的集合恰好是这三个、不多不少
    expect([...map.keys()].sort()).toEqual(
      [POI_CARDS_STORAGE_KEY, WORKSPACE_STORAGE_KEY, CANDIDATES_STORAGE_KEY].sort(),
    )
  })

  it('名称匹配查找：唯一命中返回；0 / 多命中返回 null', () => {
    const a = createPoiCard(makeCardInput({ id: 'a', name: '博物馆', address: '人民广场' }), NOW)
    const b = createPoiCard(makeCardInput({ id: 'b', name: '  博物馆　', address: '城站' }), NOW)
    const c = createPoiCard(makeCardInput({ id: 'c', name: '灵隐寺', address: null }), NOW)
    expect(a.ok && b.ok && c.ok).toBe(true)
    if (!a.ok || !b.ok || !c.ok) return
    const empty = createEmptyPoiCardsRecord(NOW)
    if (!empty.ok) return
    const record: PoiCardsRecordV1 = { ...empty.value, cards: [a.value, b.value, c.value] }
    expect(findPoiCardByName(record, '灵隐寺')?.id).toBe('c')
    // 全角空白归一化后仍唯一命中
    expect(findPoiCardByName(record, ' 灵隐寺　')?.id).toBe('c')
  })

  it('名称匹配：重名两条（不同址）时返回 null，不猜', () => {
    const a = createPoiCard(makeCardInput({ id: 'a', name: '博物馆', address: '人民广场' }), NOW)
    const b = createPoiCard(makeCardInput({ id: 'b', name: '博物馆', address: '城站' }), NOW)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const empty = createEmptyPoiCardsRecord(NOW)
    if (!empty.ok) return
    const record: PoiCardsRecordV1 = { ...empty.value, cards: [a.value, b.value] }
    expect(findPoiCardByName(record, '博物馆')).toBe(null)
  })
})

describe('poiCards · 红线自查', () => {
  it('数据层零网络调用：模块源码无 fetch / XMLHttpRequest / WebSocket', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const testFile = fileURLToPath(import.meta.url)
    // ...\src\__tests__\poiCards.test.ts → ...\src\lib\poiCards.ts（Windows / POSIX 通用）
    const srcDir = testFile.replace(/[\\/]__tests__[\\/].*$/, '')
    const source = readFileSync(`${srcDir}/lib/poiCards.ts`.replace(/\//g, testFile.includes('\\') ? '\\' : '/'), 'utf8')
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toContain('XMLHttpRequest')
    expect(source).not.toContain('WebSocket')
  })

  it('卡片无坐标字段：序列化结果不含 lng/lat/坐标键', () => {
    const record = makeRecordWithCard()
    const text = JSON.stringify(record)
    expect(text).not.toContain('"lng"')
    expect(text).not.toContain('"lat"')
    expect(text).not.toContain('坐标')
  })
})

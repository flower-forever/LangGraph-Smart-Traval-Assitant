/**
 * 七期 S7b · 候选条目 cityId 的写入与持久化。
 *
 * - 旧记录（无 cityId）必须原样通过，键集合与 JSON 不变；
 * - 带 cityId 的记录可 round-trip；空串 / 纯空白 / null 不落键；
 * - 手工新增 / 从 stop 复制 / 更新三条写入路径都覆盖；
 * - 未知字段仍然严格拒绝，不因扩展 cityId 而放宽。
 */
import { describe, expect, it } from 'vitest'

import type { CandidateItemV1, CandidatesRecordV1 } from '../lib/workspace'
import {
  MAX_CANDIDATE_CITY_LENGTH,
  validateCandidateItem,
  validateCandidatesRecord,
} from '../lib/workspace'
import {
  addCandidateToRecord,
  copyCandidateFromStop,
  createEmptyCandidateRecord,
  createManualCandidate,
  updateCandidateInRecord,
  type CandidatePoolResult,
} from '../lib/candidatePool'

const NOW = 1_800_000_100_000

const LEGACY_KEYS = [
  'id',
  'name',
  'address',
  'notes',
  'tags',
  'priority',
  'location',
  'source',
  'copiedFromStopId',
  'createdAt',
  'updatedAt',
]

function legacyCandidate(overrides: Partial<CandidateItemV1> = {}): CandidateItemV1 {
  return {
    id: 'candidate-legacy',
    name: '西湖',
    address: null,
    notes: null,
    tags: ['景点'],
    priority: 1,
    location: null,
    source: 'manual',
    copiedFromStopId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function ok<T>(result: CandidatePoolResult<T>): T {
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function hasCityKey(item: CandidateItemV1): boolean {
  return Object.prototype.hasOwnProperty.call(item, 'cityId')
}

function roundtripRecord(record: CandidatesRecordV1): CandidatesRecordV1 {
  const parsed = validateCandidatesRecord(JSON.parse(JSON.stringify(record)))
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.value
}

describe('workspace · CandidateItemV1.cityId 可选字段', () => {
  it('旧记录（无 cityId）通过，且解析结果不新增键、JSON 完全不变', () => {
    const legacy = legacyCandidate()
    const parsed = validateCandidateItem(JSON.parse(JSON.stringify(legacy)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(Object.keys(parsed.value)).toEqual(LEGACY_KEYS)
    expect(hasCityKey(parsed.value)).toBe(false)
    expect(JSON.stringify(parsed.value)).toBe(JSON.stringify(legacy))
  })

  it('带 cityId 的记录 trim 后 round-trip，键集只多 cityId', () => {
    const parsed = validateCandidateItem({
      ...legacyCandidate(),
      cityId: ' 苏州 ',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.cityId).toBe('苏州')
    expect(Object.keys(parsed.value)).toEqual([...LEGACY_KEYS, 'cityId'])

    const again = validateCandidateItem(JSON.parse(JSON.stringify(parsed.value)))
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.cityId).toBe('苏州')
  })

  it('空串 / 纯空白 / null / undefined 均不落键', () => {
    for (const cityId of ['', '   ', null, undefined]) {
      const parsed = validateCandidateItem({ ...legacyCandidate(), cityId })
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(hasCityKey(parsed.value)).toBe(false)
      expect(Object.keys(parsed.value)).toEqual(LEGACY_KEYS)
      expect(JSON.stringify(parsed.value)).not.toContain('cityId')
    }
  })

  it('未知字段仍被拒绝，带 cityId 也不放宽', () => {
    const unknownOnly = validateCandidateItem({ ...legacyCandidate(), extra: true })
    expect(unknownOnly.ok).toBe(false)
    if (unknownOnly.ok) return
    expect(unknownOnly.reason).toBe('unknown_field')

    const unknownWithCity = validateCandidateItem({
      ...legacyCandidate(),
      cityId: '苏州',
      extra: true,
    })
    expect(unknownWithCity.ok).toBe(false)
    if (unknownWithCity.ok) return
    expect(unknownWithCity.reason).toBe('unknown_field')
  })

  it('cityId 上限 60 字符，非文本拒绝', () => {
    const atLimit = validateCandidateItem({
      ...legacyCandidate(),
      cityId: '城'.repeat(MAX_CANDIDATE_CITY_LENGTH),
    })
    expect(atLimit.ok).toBe(true)

    const tooLong = validateCandidateItem({
      ...legacyCandidate(),
      cityId: '城'.repeat(MAX_CANDIDATE_CITY_LENGTH + 1),
    })
    expect(tooLong.ok).toBe(false)
    if (tooLong.ok) return
    expect(tooLong.reason).toBe('invalid_field')

    const notText = validateCandidateItem({ ...legacyCandidate(), cityId: 123 })
    expect(notText.ok).toBe(false)
    if (notText.ok) return
    expect(notText.reason).toBe('invalid_field')
  })
})

describe('candidatePool · cityId 写入与更新', () => {
  it('手工新增带 cityId 时落键；空串 / 未传不落键', () => {
    const withCity = ok(
      createManualCandidate({ id: 'manual-city', name: '拙政园', cityId: ' 苏州 ' }, NOW),
    )
    expect(withCity.cityId).toBe('苏州')
    expect(Object.keys(withCity)).toEqual([...LEGACY_KEYS, 'cityId'])

    const empty = ok(createEmptyCandidateRecord(NOW))
    const added = ok(addCandidateToRecord(empty, withCity, NOW))
    const stored = added.record.items[0]
    expect(stored.cityId).toBe('苏州')
    expect(roundtripRecord(added.record).items[0].cityId).toBe('苏州')

    const blank = ok(
      createManualCandidate({ id: 'manual-blank', name: '狮子林', cityId: '   ' }, NOW),
    )
    expect(hasCityKey(blank)).toBe(false)

    const omitted = ok(createManualCandidate({ id: 'manual-none', name: '留园' }, NOW))
    expect(hasCityKey(omitted)).toBe(false)
  })

  it('从 stop 复制带 cityId 时落键；不传时保持旧键集', () => {
    const stop = {
      stopId: 's1',
      name: '平江路',
      address: null,
      location: null,
      day: 1,
    }
    const copied = ok(copyCandidateFromStop({ id: 'copy-city', stop, cityId: '杭州' }, NOW))
    expect(copied.cityId).toBe('杭州')
    expect(copied.source).toBe('copied')

    const legacyCopy = ok(copyCandidateFromStop({ id: 'copy-legacy', stop }, NOW))
    expect(hasCityKey(legacyCopy)).toBe(false)
    expect(Object.keys(legacyCopy)).toEqual(LEGACY_KEYS)
  })

  it('更新可设置、保持与清除 cityId；清除后键被移除', () => {
    const empty = ok(createEmptyCandidateRecord(NOW))
    const base = ok(createManualCandidate({ id: 'update-city', name: '山塘街' }, NOW))
    const added = ok(addCandidateToRecord(empty, base, NOW))

    const set = ok(updateCandidateInRecord(added.record, base.id, { cityId: ' 上海 ' }, NOW + 1))
    expect(set.changed).toBe(true)
    expect(set.record.items[0].cityId).toBe('上海')
    expect(roundtripRecord(set.record).items[0].cityId).toBe('上海')

    const keep = ok(updateCandidateInRecord(set.record, base.id, { notes: '夜景' }, NOW + 2))
    expect(keep.record.items[0].cityId).toBe('上海')

    const clearedNull = ok(
      updateCandidateInRecord(keep.record, base.id, { cityId: null }, NOW + 3),
    )
    expect(hasCityKey(clearedNull.record.items[0])).toBe(false)
    expect(JSON.stringify(clearedNull.record)).not.toContain('cityId')

    const setAgain = ok(
      updateCandidateInRecord(clearedNull.record, base.id, { cityId: '杭州' }, NOW + 4),
    )
    const clearedBlank = ok(
      updateCandidateInRecord(setAgain.record, base.id, { cityId: '   ' }, NOW + 5),
    )
    expect(hasCityKey(clearedBlank.record.items[0])).toBe(false)
  })

  it('非法 cityId 在创建 / 更新时明确失败，旧记录不变', () => {
    const tooLong = '城'.repeat(MAX_CANDIDATE_CITY_LENGTH + 1)
    const created = createManualCandidate({ id: 'bad-city', name: '某处', cityId: tooLong }, NOW)
    expect(created.ok).toBe(false)
    if (created.ok) return
    expect(created.reason).toBe('invalid_city')

    const empty = ok(createEmptyCandidateRecord(NOW))
    const base = ok(createManualCandidate({ id: 'keep-city', name: '某处', cityId: '苏州' }, NOW))
    const added = ok(addCandidateToRecord(empty, base, NOW))
    const before = JSON.parse(JSON.stringify(added.record)) as CandidatesRecordV1

    const updated = updateCandidateInRecord(added.record, base.id, { cityId: tooLong }, NOW + 1)
    expect(updated.ok).toBe(false)
    if (updated.ok) return
    expect(updated.reason).toBe('invalid_city')
    expect(added.record).toEqual(before)
    expect(added.record.items[0].cityId).toBe('苏州')
  })
})

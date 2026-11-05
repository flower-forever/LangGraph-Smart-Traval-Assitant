import { beforeEach, describe, expect, it } from 'vitest'

import { MOCK_TRIP } from './fixtures/trip'
import type { Trip } from '../lib/api'
import type { CandidateItemV1, CandidatesRecordV1 } from '../lib/workspace'
import {
  CANDIDATES_BACKUP_FORMAT,
  CANDIDATES_FORMAT,
  CANDIDATES_VERSION,
  MAX_CANDIDATES_BACKUP_FILE_BYTES,
  MAX_CANDIDATES_BYTES,
  MAX_CANDIDATES_COUNT,
  createCandidatesRecord,
} from '../lib/workspace'
import {
  addCandidateToRecord,
  buildCandidateDraftProposal,
  candidateDedupeKey,
  candidateRecordBytes,
  copyCandidateFromStop,
  createCandidatesBackup,
  createEmptyCandidateRecord,
  createManualCandidate,
  filterCandidates,
  findDuplicateCandidates,
  formatCandidateLocation,
  listCandidateTags,
  normalizeCandidateText,
  parseCandidateCoordinates,
  parseCandidatesBackupJson,
  previewCandidatesBackup,
  removeCandidateFromRecord,
  summarizeCandidatesRecord,
  updateCandidateInRecord,
  type CandidateManualInput,
  type CandidatePoolFailure,
  type CandidatePoolResult,
  type CandidateStopSource,
} from '../lib/candidatePool'
import { createTripDraft } from '../lib/tripDraft'
import { checkTripShape, utf8ByteLength } from '../lib/savedTrips'

const NOW = 1_760_000_000_000
let sequence = 0

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function ok<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function fail(result: CandidatePoolResult<unknown>): CandidatePoolFailure {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a failure')
  return result
}

function manualCandidate(overrides: Partial<CandidateManualInput> = {}): CandidateItemV1 {
  sequence += 1
  return ok(
    createManualCandidate(
      {
        id: overrides.id ?? `candidate-${sequence}`,
        name: overrides.name ?? `候选地点 ${sequence}`,
        address: overrides.address ?? null,
        notes: overrides.notes ?? null,
        tags: overrides.tags ?? [],
        priority: overrides.priority ?? 1,
        location: overrides.location ?? null,
      },
      NOW,
    ),
  )
}

function makeRecord(items: CandidateItemV1[], updatedAt = NOW): CandidatesRecordV1 {
  return ok(createCandidatesRecord(items, updatedAt))
}

function makeDraft(trip: Trip = clone(MOCK_TRIP)) {
  const result = createTripDraft(trip, { forkTripId: 'trip-fork-f3', newLegMode: 'walking' })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.draft
}

beforeEach(() => {
  sequence = 0
  window.localStorage.clear()
})

describe('重复提示、手工 / copied 来源与深隔离', () => {
  it('同名同址（含空白、大小写、全角归一）只提示重复，不自动合并', () => {
    const first = manualCandidate({ name: ' 西湖 博物馆 ', address: '北山街 1 号' })
    const second = manualCandidate({ name: '西湖 博物馆', address: '北山街 1 号' })
    const record = makeRecord([first])

    const mutation = ok(addCandidateToRecord(record, second, NOW + 1))
    expect(mutation.duplicates.map((item) => item.id)).toEqual([first.id])
    expect(mutation.record.items).toHaveLength(2)
    expect(mutation.record.items.map((item) => item.id)).toEqual([first.id, second.id])

    const fullWidth = manualCandidate({ name: 'ＡＢＣ', address: '一号' })
    const ascii = manualCandidate({ name: 'abc', address: '一号' })
    expect(candidateDedupeKey(fullWidth)).toBe(candidateDedupeKey(ascii))
    expect(normalizeCandidateText('  ＡＢＣ　西湖  ')).toBe('abc 西湖')
    expect(findDuplicateCandidates([fullWidth], ascii)).toHaveLength(1)
    expect(findDuplicateCandidates([fullWidth], fullWidth)).toHaveLength(0)
  })

  it('手工来源诚实：source=manual 且 copiedFromStopId=null', () => {
    const candidate = manualCandidate({ name: '灵隐寺' })
    expect(candidate.source).toBe('manual')
    expect(candidate.copiedFromStopId).toBeNull()
  })

  it('从 stop 复制：source=copied、来源 id 正确、坐标深拷贝且不与原 stop 别名共享', () => {
    const sourceLocation = { lng: 120.1576, lat: 30.2726 }
    const source: CandidateStopSource = {
      stopId: 's1',
      name: '断桥残雪',
      address: '杭州市西湖区白堤东端',
      location: sourceLocation,
      day: 1,
    }
    const copied = ok(
      copyCandidateFromStop(
        { id: 'copy-1', stop: source, tags: ['西湖'], notes: '复制备注', priority: 2 },
        NOW,
      ),
    )
    expect(copied.source).toBe('copied')
    expect(copied.copiedFromStopId).toBe('s1')
    expect(copied.name).toBe('断桥残雪')
    expect(copied.address).toBe('杭州市西湖区白堤东端')
    expect(copied.location).toEqual({ lng: 120.1576, lat: 30.2726 })
    expect(copied.location).not.toBe(sourceLocation)

    source.name = '改过名的原站点'
    source.address = '改过地址'
    sourceLocation.lng = 0
    sourceLocation.lat = 0
    expect(copied.name).toBe('断桥残雪')
    expect(copied.address).toBe('杭州市西湖区白堤东端')
    expect(copied.location).toEqual({ lng: 120.1576, lat: 30.2726 })

    copied.tags.push('新标签')
    if (copied.location !== null) copied.location.lng = 1
    expect(source.name).toBe('改过名的原站点')
    expect(sourceLocation.lng).toBe(0)
    expect(copied.location).toEqual({ lng: 1, lat: 30.2726 })
  })

  it('原 stop 坐标为 null 时复制候选仍为 null，绝不补 (0,0)', () => {
    const source: CandidateStopSource = {
      stopId: 's3',
      name: '湖滨晴雨',
      address: '杭州市上城区湖滨路',
      location: null,
      day: 1,
    }
    const copied = ok(copyCandidateFromStop({ id: 'copy-null', stop: source }, NOW))
    expect(copied.location).toBeNull()
    expect(formatCandidateLocation(copied.location)).toBe('坐标未知')
  })

  it('坐标 0 合法；留空才是未知；只填一半或越界明确失败', () => {
    const zero = manualCandidate({ name: '零点', location: { lng: 0, lat: 0 } })
    expect(zero.location).toEqual({ lng: 0, lat: 0 })
    expect(formatCandidateLocation(zero.location)).toBe('经度 0，纬度 0')

    expect(ok(parseCandidateCoordinates('', '  '))).toBeNull()
    expect(ok(parseCandidateCoordinates('0', '0'))).toEqual({ lng: 0, lat: 0 })
    expect(fail(parseCandidateCoordinates('0', '')).reason).toBe('invalid_location')
    expect(fail(parseCandidateCoordinates('', '30')).reason).toBe('invalid_location')
    expect(fail(parseCandidateCoordinates('181', '30')).reason).toBe('invalid_location')
    expect(fail(parseCandidateCoordinates('120', '-91')).reason).toBe('invalid_location')
  })
})

describe('不可变更新、编辑与删除', () => {
  it('新增 / 编辑 / 删除都不修改旧记录、旧条目、旧标签与旧坐标', () => {
    const candidate = manualCandidate({ name: '甲', tags: ['西湖'], location: { lng: 120, lat: 30 } })
    const record = makeRecord([candidate])
    const beforeRecord = clone(record)
    Object.freeze(record)
    Object.freeze(record.items)
    Object.freeze(candidate.tags)
    Object.freeze(candidate.location)

    const added = ok(addCandidateToRecord(record, manualCandidate({ name: '乙' }), NOW + 1))
    expect(record).toEqual(beforeRecord)
    expect(record.items).toHaveLength(1)
    expect(added.record.items).toHaveLength(2)

    const edited = ok(
      updateCandidateInRecord(
        added.record,
        candidate.id,
        { name: '甲改', tags: ['西湖', '步行'], priority: 3 },
        NOW + 2,
      ),
    )
    expect(edited.changed).toBe(true)
    expect(added.record.items[0].name).toBe('甲')
    expect(edited.record.items[0].name).toBe('甲改')
    expect(edited.record.items[0].createdAt).toBe(candidate.createdAt)
    expect(edited.record.items[0].updatedAt).toBe(NOW + 2)
    expect(edited.record.items[0].source).toBe('manual')

    const removed = ok(removeCandidateFromRecord(edited.record, candidate.id, NOW + 3))
    expect(removed.record.items).toHaveLength(1)
    expect(edited.record.items).toHaveLength(2)
    expect(removed.record.items[0].name).toBe('乙')
  })

  it('编辑无实际变化不更新 updatedAt；now 早于 createdAt 明确失败且保旧', () => {
    const candidate = manualCandidate({ name: '甲' })
    const record = makeRecord([candidate])
    const noChange = ok(updateCandidateInRecord(record, candidate.id, { name: '甲' }, NOW + 10))
    expect(noChange.changed).toBe(false)
    expect(noChange.record).toBe(record)

    const tooEarly = fail(updateCandidateInRecord(record, candidate.id, { name: '乙' }, NOW - 1))
    expect(tooEarly.reason).toBe('invalid_timestamp')
    expect(record.items[0].name).toBe('甲')
  })

  it('删除不存在的候选明确失败；删候选不触碰任何 Trip 数据结构', () => {
    const record = makeRecord([manualCandidate({ name: '甲' })])
    expect(fail(removeCandidateFromRecord(record, 'missing', NOW + 1)).reason).toBe(
      'candidate_not_found',
    )

    const trip = clone(MOCK_TRIP)
    const beforeTrip = clone(trip)
    const applies = [{ candidateId: 'x', tripId: trip.id, day: 1, stopId: 's1' }]
    const beforeApplies = clone(applies)
    ok(removeCandidateFromRecord(record, record.items[0].id, NOW + 1))
    expect(trip).toEqual(beforeTrip)
    expect(applies).toEqual(beforeApplies)
  })
})

describe('容量：200 条与 256 KiB 的真实 UTF-8 字节', () => {
  it('第 201 条明确失败，旧库保持不变', () => {
    expect(MAX_CANDIDATES_COUNT).toBe(200)
    expect(MAX_CANDIDATES_BYTES).toBe(262_144)
    let record = ok(createEmptyCandidateRecord(NOW))
    for (let index = 0; index < MAX_CANDIDATES_COUNT; index += 1) {
      record = ok(
        addCandidateToRecord(record, manualCandidate({ id: `count-${index}`, name: `A${index}` }), NOW + index),
      ).record
    }
    const before = clone(record)
    const result = fail(
      addCandidateToRecord(record, manualCandidate({ id: 'count-200', name: 'A200' }), NOW + 201),
    )
    expect(result.reason).toBe('candidates_count')
    expect(record).toEqual(before)
    expect(record.items).toHaveLength(200)
  })

  it('中文备注按 UTF-8 字节计算；超 256 KiB 明确失败且旧库不变', () => {
    expect(utf8ByteLength('汉')).toBe(3)
    let record = ok(createEmptyCandidateRecord(NOW))
    let index = 0
    let failure: CandidatePoolFailure | null = null
    while (index < MAX_CANDIDATES_COUNT) {
      const candidate = manualCandidate({
        id: `bytes-${index}`,
        name: `中文地点${index}`,
        notes: '汉'.repeat(500),
      })
      const result = addCandidateToRecord(record, candidate, NOW + index)
      if (!result.ok) {
        failure = result
        break
      }
      record = result.value.record
      index += 1
    }
    expect(failure).not.toBeNull()
    expect(failure?.reason).toBe('candidates_too_large')
    expect(record.items.length).toBeLessThan(MAX_CANDIDATES_COUNT)
    const bytes = candidateRecordBytes(record)
    expect(bytes).not.toBeNull()
    expect(bytes).toBe(utf8ByteLength(JSON.stringify(record)))
    expect(bytes).toBeLessThanOrEqual(MAX_CANDIDATES_BYTES)
    expect(summarizeCandidatesRecord(record).bytes).toBe(bytes)
    expect(summarizeCandidatesRecord(record).count).toBe(record.items.length)
  })
})

describe('区域 / 标签 / 文本筛选', () => {
  it('按标签、无标签与归一化文本筛选；只读、不改变原数组', () => {
    const westLake = manualCandidate({ name: '断桥', tags: ['西湖'] })
    const westLakeWalk = manualCandidate({ name: '白堤', tags: ['西湖', '步行'] })
    const untagged = manualCandidate({ name: 'ＡＢＣ 公园', tags: [] })
    const canal = manualCandidate({ name: '拱宸桥', tags: ['运河'] })
    const items = [westLake, westLakeWalk, untagged, canal]
    const before = clone(items)

    expect(filterCandidates(items, { tag: '西湖' }).map((item) => item.id)).toEqual([
      westLake.id,
      westLakeWalk.id,
    ])
    expect(filterCandidates(items, { untaggedOnly: true }).map((item) => item.id)).toEqual([
      untagged.id,
    ])
    expect(filterCandidates(items, { text: 'abc' }).map((item) => item.id)).toEqual([untagged.id])
    expect(filterCandidates(items, { text: '运河' }).map((item) => item.id)).toEqual([canal.id])
    expect(filterCandidates(items, { text: '步行' }).map((item) => item.id)).toEqual([
      westLakeWalk.id,
    ])
    expect(filterCandidates(items, { tag: '不存在' })).toEqual([])
    expect(listCandidateTags(items)).toEqual(['西湖', '步行', '运河'])
    expect(items).toEqual(before)
    expect(filterCandidates(items, { tag: '西湖' })[0]).toBe(westLake)
  })
})

describe('加入草稿 / 预览 proposal', () => {
  it('生成独立 visit id 的草稿预览；不改当前 Trip / 草稿；坐标不写进行程', () => {
    const trip = clone(MOCK_TRIP)
    const beforeTrip = clone(trip)
    const draft = makeDraft(trip)
    const beforeDraft = clone(draft)
    const candidate = manualCandidate({
      name: '新地点',
      address: '某路 1 号',
      notes: '候选备注',
      location: { lng: 120.2, lat: 30.3 },
    })

    const proposal = ok(
      buildCandidateDraftProposal({
        draft,
        candidate,
        day: 2,
        time: '09:30',
        durationMinutes: 45,
        visitStopId: 'visit-f3-1',
      }),
    )
    expect(proposal.previewOnly).toBe(true)
    expect(proposal.visitStopId).toBe('visit-f3-1')
    expect(proposal.visitStopId).not.toBe(candidate.id)
    expect(proposal.stop.id).toBe('visit-f3-1')
    expect(proposal.stop.name).toBe('新地点')
    expect(proposal.stop.time).toBe('09:30')
    expect(proposal.stop.duration_minutes).toBe(45)
    expect(proposal.stop.address).toBe('某路 1 号')
    expect(proposal.stop.location).toBeNull()
    expect(proposal.caveats.join(' ')).toMatch(/坐标保留在候选库/)
    expect(proposal.shapeChecked).toBe(true)
    expect(proposal.previewTripBytes).toBeGreaterThan(0)
    expect(checkTripShape(proposal.previewTrip).ok).toBe(true)
    const previewDay = proposal.previewTrip.days.find((day) => day.day === 2)
    expect(previewDay?.stops.some((stop) => stop.id === 'visit-f3-1')).toBe(true)
    expect(trip).toEqual(beforeTrip)
    expect(draft).toEqual(beforeDraft)
    expect(candidate.location).toEqual({ lng: 120.2, lat: 30.3 })
  })

  it('候选坐标为 null 时预览站点仍为 null，并明确提示不补 0 / 不地理编码', () => {
    const draft = makeDraft()
    const candidate = manualCandidate({ name: '无坐标地点', location: null })
    const proposal = ok(
      buildCandidateDraftProposal({
        draft,
        candidate,
        day: 2,
        time: '10:00',
        visitStopId: 'visit-f3-null',
      }),
    )
    expect(proposal.stop.location).toBeNull()
    expect(proposal.caveats.join(' ')).toMatch(/不会补 \(0,0\)/)
  })

  it('不存在 day、满 100 站、时间非法、visit id 复用候选 id / 已存在都明确失败且保旧', () => {
    const draft = makeDraft()
    const beforeDraft = clone(draft)
    const candidate = manualCandidate({ name: '候选' })

    expect(
      fail(
        buildCandidateDraftProposal({
          draft,
          candidate,
          day: 99,
          time: '09:00',
          visitStopId: 'visit-unknown',
        }),
      ).reason,
    ).toBe('unknown_day')

    expect(
      fail(
        buildCandidateDraftProposal({
          draft,
          candidate,
          day: 1,
          time: '9:00',
          visitStopId: 'visit-bad-time',
        }),
      ).reason,
    ).toBe('invalid_time')

    expect(
      fail(
        buildCandidateDraftProposal({
          draft,
          candidate,
          day: 1,
          time: '09:00',
          visitStopId: candidate.id,
        }),
      ).reason,
    ).toBe('candidate_id_as_visit')

    expect(
      fail(
        buildCandidateDraftProposal({
          draft,
          candidate,
          day: 1,
          time: '09:00',
          visitStopId: 's2',
        }),
      ).reason,
    ).toBe('visit_id_conflict')

    const fullTrip = clone(MOCK_TRIP)
    fullTrip.days[0].stops = Array.from({ length: 100 }, (_, index) => ({
      id: `full-${index}`,
      name: `满站 ${index}`,
      time: '09:00',
      duration_minutes: null,
      description: '',
      address: '',
      location: null,
    }))
    fullTrip.days[0].legs = []
    expect(checkTripShape(fullTrip).ok).toBe(true)
    const fullDraft = makeDraft(fullTrip)
    const beforeFullDraft = clone(fullDraft)
    expect(
      fail(
        buildCandidateDraftProposal({
          draft: fullDraft,
          candidate,
          day: 1,
          time: '09:00',
          visitStopId: 'visit-full',
        }),
      ).reason,
    ).toBe('daily_stop_limit')

    expect(draft).toEqual(beforeDraft)
    expect(fullDraft).toEqual(beforeFullDraft)
  })

  it('候选含未知字段时按契约拒绝，不生成预览', () => {
    const draft = makeDraft()
    const candidate = manualCandidate({ name: '候选' })
    const withUnknown = { ...candidate, extra: 'reject me' } as CandidateItemV1
    expect(
      fail(
        buildCandidateDraftProposal({
          draft,
          candidate: withUnknown,
          day: 2,
          time: '09:00',
          visitStopId: 'visit-unknown-field',
        }),
      ).reason,
    ).toBe('invalid_candidate')
  })

  it('删除候选不删已加入的 Trip 点：预览 Trip、当前 Trip、草稿与 applies 都保持', () => {
    const trip = clone(MOCK_TRIP)
    const beforeTrip = clone(trip)
    const draft = makeDraft(trip)
    const beforeDraft = clone(draft)
    const candidate = manualCandidate({ name: '会被删除的候选' })
    const proposal = ok(
      buildCandidateDraftProposal({
        draft,
        candidate,
        day: 2,
        time: '09:30',
        visitStopId: 'visit-keep-in-trip',
      }),
    )
    const beforePreview = clone(proposal.previewTrip)
    const record = makeRecord([candidate])
    const applies = [{ candidateId: candidate.id, tripId: trip.id, day: 2, stopId: 'visit-keep-in-trip' }]
    const beforeApplies = clone(applies)

    const removed = ok(removeCandidateFromRecord(record, candidate.id, NOW + 2))
    expect(removed.record.items).toEqual([])
    expect(trip).toEqual(beforeTrip)
    expect(draft).toEqual(beforeDraft)
    expect(proposal.previewTrip).toEqual(beforePreview)
    expect(
      proposal.previewTrip.days
        .find((day) => day.day === 2)
        ?.stops.some((stop) => stop.id === 'visit-keep-in-trip'),
    ).toBe(true)
    expect(applies).toEqual(beforeApplies)
  })
})

describe('备份 / 导入：纯校验与 preview，不写存储、不默认恢复', () => {
  it('导出 envelope 与同一份 JSON 字节；preview 读回完整记录且不写 localStorage', () => {
    const record = makeRecord([
      manualCandidate({ name: '灵隐寺', address: '法云弄', tags: ['西湖'] }),
    ])
    const exported = ok(createCandidatesBackup(record, NOW + 5))
    expect(exported.backup.format).toBe(CANDIDATES_BACKUP_FORMAT)
    expect(exported.backup.version).toBe(1)
    expect(exported.backup.exportedAt).toBe(NOW + 5)
    expect(exported.itemCount).toBe(1)
    expect(exported.bytes).toBe(utf8ByteLength(exported.json))
    const parsed = JSON.parse(exported.json) as unknown
    expect(parsed).toEqual(exported.backup)

    const preview = ok(previewCandidatesBackup(parsed, exported.bytes))
    expect(preview.record).toEqual(record)
    expect(preview.itemCount).toBe(1)
    expect(preview.bytes).toBe(exported.bytes)
    expect(window.localStorage.length).toBe(0)
  })

  it('损坏 / 未知字段 / 超文件上限都失败；原库与原始记录不变', () => {
    const record = makeRecord([manualCandidate({ name: '甲' })])
    const before = clone(record)
    const exported = ok(createCandidatesBackup(record, NOW))
    const parsed = JSON.parse(exported.json) as Record<string, unknown>

    expect(fail(previewCandidatesBackup({ ...parsed, extra: true })).reason).toBe('invalid_backup')
    const badCandidate = clone(parsed) as {
      candidates: { items: Array<Record<string, unknown>> }
    }
    badCandidate.candidates.items[0].extra = true
    expect(fail(previewCandidatesBackup(badCandidate)).reason).toBe('invalid_backup')
    expect(
      fail(previewCandidatesBackup(parsed, MAX_CANDIDATES_BACKUP_FILE_BYTES + 1)).reason,
    ).toBe('backup_too_large')
    expect(record).toEqual(before)
    expect(window.localStorage.length).toBe(0)

    expect(fail(parseCandidatesBackupJson('{')).reason).toBe('invalid_json')
    expect(
      fail(parseCandidatesBackupJson('x'.repeat(MAX_CANDIDATES_BACKUP_FILE_BYTES + 1))).reason,
    ).toBe('backup_too_large')
    expect(fail(createCandidatesBackup(record, 0)).reason).toBe('invalid_timestamp')
  })

  it('未知字段在候选 / 候选库层严格拒绝，写入失败保旧', () => {
    const candidate = manualCandidate({ name: '甲' })
    const record = makeRecord([candidate])
    const recordWithUnknown = { ...record, extra: true } as CandidatesRecordV1
    expect(
      fail(addCandidateToRecord(recordWithUnknown, manualCandidate({ name: '乙' }), NOW + 1)).reason,
    ).toBe('invalid_record')

    const candidateWithUnknown = { ...candidate, extra: true } as CandidateItemV1
    const before = clone(record)
    expect(
      fail(addCandidateToRecord(record, candidateWithUnknown, NOW + 1)).reason,
    ).toBe('invalid_candidate')
    expect(record).toEqual(before)
  })

  it('候选库格式常量仍使用公共契约值，不另建 key / 副本 schema', () => {
    expect(CANDIDATES_FORMAT).toBe('travel-assistant.workspace.candidates')
    expect(CANDIDATES_VERSION).toBe(1)
  })
})

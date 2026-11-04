/**
 * sessionRestore 纯函数测试：flag 语义、envelope 门禁、写入守卫、恢复协议、
 * 草稿/费用块重建、跨标签冲突、宽字段兼容与损坏数据保旧。
 * 全部离线 jsdom，不发任何网络请求。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOCK_TRIP } from './fixtures/trip'
import {
  SESSION_RESUME_DATA_KEY,
  SESSION_RESUME_FLAG_KEY,
  clearSessionResumeFlag,
  isSessionResumeEnabled,
  loadSessionResumeRecord,
  readSessionResumeFlag,
  removeSessionResumeData,
  setSessionResumeFlag,
  writeSessionResume,
  type SessionResumePayload,
} from '../lib/sessionRestore'
import {
  addBudgetRow,
  budgetSessionIsStale,
  emptyBudgetSession,
  tripOwnerSnapshot,
  updateBudgetRow,
} from '../lib/tripBudget'
import type { BudgetSessionState } from '../lib/tripBudget'
import {
  applyDraft,
  createTripDraft,
  discardDraft,
  draftChangedDays,
  updateDraftStop,
  undoDraft,
} from '../lib/tripDraft'
import {
  buildPayloadFromSession,
  previewSessionResume,
  rebuildBudgetSession,
  rebuildDraftFromTrip,
} from '../lib/sessionRestore'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

/** 写 flag + 数据键：读取/重建协议用例需要「已启用」前提 */
function seedWithFlag(raw: string) {
  window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
  window.localStorage.setItem(SESSION_RESUME_DATA_KEY, raw)
}

/** 构造一个已绑定 owner 的费用 session（首次编辑即绑定） */
function boundBudgetSession(trip: typeof MOCK_TRIP, revision: number): BudgetSessionState {
  const snap = tripOwnerSnapshot(trip)
  if (!snap.ok) throw new Error('fixture 序列化失败')
  const ctx = { tripId: trip.id, revision, snapshot: snap.value, tripTitle: trip.title }
  let session = emptyBudgetSession()
  const added = addBudgetRow(session, ctx, 'row-1')
  if (!added.ok) throw new Error(`fixture addBudgetRow 失败：${added.message}`)
  session = added.session
  const updated = updateBudgetRow(session, ctx, 'row-1', { name: '高铁票', amountRaw: '128.5' })
  if (!updated.ok) throw new Error(`fixture updateBudgetRow 失败：${updated.message}`)
  return updated.session
}

function payloadOf(overrides?: {
  trip?: unknown
  draft?: unknown
  budget?: unknown
  ui?: unknown
}): SessionResumePayload {
  return {
    trip: (overrides?.trip ?? MOCK_TRIP) as SessionResumePayload['trip'],
    draft: (overrides?.draft ?? null) as SessionResumePayload['draft'],
    budget: (overrides?.budget ?? null) as SessionResumePayload['budget'],
    ui: (overrides?.ui ?? { activeDay: 1, draftMode: 'walking' }) as SessionResumePayload['ui'],
  }
}

function throwingStorage(error: Error): Storage {
  return {
    length: 0,
    clear() {},
    getItem() {
      throw error
    },
    key() {
      return null
    },
    removeItem() {
      throw error
    },
    setItem() {
      throw error
    },
  }
}

describe('sessionRestore 启用 flag', () => {
  it('默认关闭：未写 flag 判定为关闭，数据键存在也不读', () => {
    expect(readSessionResumeFlag(window.localStorage).enabled).toBe(false)
    expect(isSessionResumeEnabled(window.localStorage)).toBe(false)
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, '{"format":"x"}')
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('disabled')
  })

  it('启用与关闭：只认字符串 "1"，清除后回到关闭且 flag 键被移除', () => {
    setSessionResumeFlag(window.localStorage, true)
    expect(readSessionResumeFlag(window.localStorage).enabled).toBe(true)
    expect(isSessionResumeEnabled(window.localStorage)).toBe(true)
    clearSessionResumeFlag(window.localStorage)
    expect(readSessionResumeFlag(window.localStorage).enabled).toBe(false)
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBeNull()
  })

  it('flag 写失败 quota → typed 失败不抛异常；读失败 → 视为未启用', () => {
    const quota = throwingStorage(new DOMException('quota', 'QuotaExceededError'))
    const result = setSessionResumeFlag(quota, true)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toBe('quota')

    const sec = throwingStorage(new DOMException('denied', 'SecurityError'))
    expect(readSessionResumeFlag(sec).enabled).toBe(false)
    const r2 = setSessionResumeFlag(sec, true)
    expect(r2.ok).toBe(false)
    expect(r2.ok ? '' : r2.reason).toBe('unavailable')
  })
})

describe('sessionRestore 写入门禁', () => {
  it('写入成功：envelope 结构正确，读取往返 trip 一致', () => {
    setSessionResumeFlag(window.localStorage, true)
    const result = writeSessionResume({ payload: payloadOf(), expectedRaw: null }, window.localStorage)
    expect(result.ok).toBe(true)
    const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { format: string; version: number; savedAt: number; session: unknown }
    expect(parsed.format).toBe('travel-assistant.session-resume')
    expect(parsed.version).toBe(1)
    expect(typeof parsed.savedAt).toBe('number')
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    expect(loaded.record.session.trip.id).toBe(MOCK_TRIP.id)
    expect(loaded.record.savedAt).toBe(parsed.savedAt)
  })

  it('写前重读与 expectedRaw 不同（他标签先写）→ conflict，原 raw 逐字节保留', () => {
    const existingRaw =
      '{"format":"travel-assistant.session-resume","version":1,"savedAt":1,"session":{"trip":null}}'
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, existingRaw)
    const result = writeSessionResume(
      { payload: payloadOf(), expectedRaw: '{"different":"raw"}' },
      window.localStorage,
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toBe('conflict')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(existingRaw)
  })

  it('payload 无法序列化（循环引用）→ snapshot_failed，存储原样', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const result = writeSessionResume(
      { payload: { ...payloadOf(), trip: circular as unknown as SessionResumePayload['trip'] }, expectedRaw: null },
      window.localStorage,
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toBe('snapshot_failed')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()
  })

  it('整包超 1.5MiB → too_large 保旧；读侧超限 → corrupt', () => {
    const bigTrip = { ...MOCK_TRIP, summary: '巨'.repeat(1600 * 1024) }
    const result = writeSessionResume(
      { payload: { ...payloadOf(), trip: bigTrip }, expectedRaw: null },
      window.localStorage,
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toBe('too_large')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()

    // 合法写入后再把存储值放大到超过读侧门禁 → corrupt 而不是解析
    setSessionResumeFlag(window.localStorage, true)
    const okWrite = writeSessionResume({ payload: payloadOf(), expectedRaw: null }, window.localStorage)
    expect(okWrite.ok).toBe(true)
    const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, raw + '填充'.repeat(40 * 1024))
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('corrupt')
  })

  it('Trip 单记录超 640KiB（整包仍低于 1.5MiB）→ too_large 保旧', () => {
    // 700 KiB ASCII summary：整包约 720 KiB < 1.5 MiB，但 Trip 记录已超 640 KiB 口径
    const bigTrip = { ...MOCK_TRIP, summary: 'a'.repeat(700 * 1024) }
    const result = writeSessionResume(
      { payload: { ...payloadOf(), trip: bigTrip }, expectedRaw: null },
      window.localStorage,
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toBe('too_large')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()
  })

  it('quota → typed quota；SecurityError → unavailable，均保旧', () => {
    const rawBefore = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    const quotaStorage: Storage = {
      length: 0,
      clear() {},
      getItem: () => null,
      key: () => null,
      removeItem() {},
      setItem() {
        throw new DOMException('quota', 'QuotaExceededError')
      },
    }
    const r1 = writeSessionResume({ payload: payloadOf(), expectedRaw: null }, quotaStorage)
    expect(r1.ok).toBe(false)
    expect(r1.ok ? '' : r1.reason).toBe('quota')

    const secStorage: Storage = {
      length: 0,
      clear() {},
      getItem() {
        throw new DOMException('denied', 'SecurityError')
      },
      key: () => null,
      removeItem() {},
      setItem() {
        throw new DOMException('denied', 'SecurityError')
      },
    }
    const r2 = writeSessionResume({ payload: payloadOf(), expectedRaw: null }, secStorage)
    expect(r2.ok).toBe(false)
    expect(r2.ok ? '' : r2.reason).toBe('unavailable')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawBefore)
  })
})

describe('sessionRestore 读取协议', () => {
  it('无记录 → empty；坏 JSON → corrupt；未知版本 → unknown_version', () => {
    seedWithFlag('')
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('empty')
    seedWithFlag('{oops')
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('corrupt')
    seedWithFlag(
      JSON.stringify({ format: 'travel-assistant.session-resume', version: 99, savedAt: 1, session: {} }),
    )
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('unknown_version')
  })

  it('empty 携带当次实际 raw：null / 空串 / 空白都原样返回，供调用方冻结', () => {
    seedWithFlag('')
    window.localStorage.removeItem(SESSION_RESUME_DATA_KEY)
    const noRecord = loadSessionResumeRecord(window.localStorage)
    expect(noRecord.status).toBe('empty')
    if (noRecord.status !== 'empty') return
    expect(noRecord.raw).toBeNull()

    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, '')
    const emptyString = loadSessionResumeRecord(window.localStorage)
    expect(emptyString.status).toBe('empty')
    if (emptyString.status !== 'empty') return
    expect(emptyString.raw).toBe('')

    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, '   ')
    const whitespace = loadSessionResumeRecord(window.localStorage)
    expect(whitespace.status).toBe('empty')
    if (whitespace.status !== 'empty') return
    expect(whitespace.raw).toBe('   ')
  })

  it('顶层未知键 / session 缺 trip → invalid（原子拒绝，不部分读取）', () => {
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: payloadOf(),
        extra: '未声明字段',
      }),
    )
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('invalid')

    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: { draft: null, budget: null, ui: { activeDay: 1, draftMode: 'walking' } },
      }),
    )
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('invalid')
  })

  it('trip 结构不过 checkTripShape → invalid，raw 保留', () => {
    const badTrip = { ...MOCK_TRIP, days: [] }
    seedWithFlag(
      JSON.stringify({ format: 'travel-assistant.session-resume', version: 1, savedAt: 5, session: payloadOf({ trip: badTrip }) }),
    )
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('invalid')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull()
  })

  it('envelope 内宽字段（location 附带未声明字段）不判 invalid：checkTripShape 语义一致', () => {
    const wideTrip = {
      ...MOCK_TRIP,
      days: MOCK_TRIP.days.map((day) => ({
        ...day,
        stops: day.stops.map((stop) =>
          stop.location === null
            ? stop
            : { ...stop, location: { ...stop.location, note: '来源自述' } },
        ),
      })),
    }
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: payloadOf({ trip: wideTrip }),
      }),
    )
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    const firstStop = loaded.record.session.trip.days[0]!.stops[0]!
    expect((firstStop.location as unknown as { note?: string }).note).toBe('来源自述')
  })

  it('draft 块结构异常（编辑天不属于 base / 重复天号 / fork 等于 trip id）→ invalid', () => {
    const badDraft1 = { forkTripId: 'fork-x', newLegMode: 'walking', editedDays: [{ day: 9, days: MOCK_TRIP.days }] }
    const badDraft2 = { forkTripId: 'fork-x', newLegMode: 'walking', editedDays: [
      { day: 1, days: MOCK_TRIP.days.filter((d) => d.day === 1) },
      { day: 1, days: MOCK_TRIP.days.filter((d) => d.day === 1) },
    ] }
    const badDraft3 = { forkTripId: MOCK_TRIP.id, newLegMode: 'walking', editedDays: [] }
    const dayOne = MOCK_TRIP.days.filter((d) => d.day === 1)
    const dayTwo = MOCK_TRIP.days.filter((d) => d.day === 2)
    const badDraft4 = { forkTripId: 'fork-x', newLegMode: 'walking', editedDays: [{ day: 1, days: [] }] }
    const badDraft5 = { forkTripId: 'fork-x', newLegMode: 'walking', editedDays: [{ day: 1, days: [...dayOne, ...dayTwo] }] }
    const badDraft6 = { forkTripId: 'fork-x', newLegMode: 'walking', editedDays: [{ day: 1, days: dayTwo }] }
    for (const draft of [badDraft1, badDraft2, badDraft3, badDraft4, badDraft5, badDraft6]) {
      seedWithFlag(
        JSON.stringify({ format: 'travel-assistant.session-resume', version: 1, savedAt: 5, session: payloadOf({ draft }) }),
      )
      expect(loadSessionResumeRecord(window.localStorage).status).toBe('invalid')
    }
  })

  it('budget 块结构异常（owner=null 但 rows 非空 / 行超 32 / id 重复）→ invalid', () => {
    const rows32 = Array.from({ length: 32 }, (_, i) => ({ id: `r${i}`, category: 'other', name: '', amountRaw: '' }))
    const cases: unknown[] = [
      { binding: { kind: 'unbound' }, budgetRaw: '', rows: [{ id: 'r1', category: 'other', name: '', amountRaw: '' }] },
      { binding: { kind: 'current', tripId: MOCK_TRIP.id }, budgetRaw: '', rows: Array.from({ length: 33 }, (_, i) => ({ id: `r${i}`, category: 'other', name: '', amountRaw: '' })) },
      { binding: { kind: 'current', tripId: MOCK_TRIP.id }, budgetRaw: '', rows: [...rows32, { id: 'r0', category: 'other', name: '', amountRaw: '' }] },
      { binding: { kind: 'nonsense' }, budgetRaw: '', rows: [] },
    ]
    for (const budget of cases) {
      seedWithFlag(
        JSON.stringify({ format: 'travel-assistant.session-resume', version: 1, savedAt: 5, session: payloadOf({ budget }) }),
      )
      expect(loadSessionResumeRecord(window.localStorage).status).toBe('invalid')
    }
  })

  it('金额坏字符串（中间态）原样通过：不判 invalid、不丢原文', () => {
    const budget = {
      binding: { kind: 'current', tripId: MOCK_TRIP.id },
      budgetRaw: '12.345',
      rows: [{ id: 'r1', category: 'food', name: '晚饭', amountRaw: '不是数字' }],
    }
    seedWithFlag(
      JSON.stringify({ format: 'travel-assistant.session-resume', version: 1, savedAt: 5, session: payloadOf({ budget }) }),
    )
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    const b = loaded.record.session.budget
    expect(b).not.toBeNull()
    expect(b!.budgetRaw).toBe('12.345')
    expect(b!.rows[0]!.amountRaw).toBe('不是数字')
  })

  it('空费用未绑定（binding unbound 且 rows/budgetRaw 全空）合法保存与读取', () => {
    const budget = { binding: { kind: 'unbound' }, budgetRaw: '', rows: [] }
    seedWithFlag(
      JSON.stringify({ format: 'travel-assistant.session-resume', version: 1, savedAt: 5, session: payloadOf({ budget }) }),
    )
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('pending')
  })
})

describe('sessionRestore 快照投影（sessionPayloadOf）', () => {
  it('draft：从 TripDraft 提取 editedDays + fork/mode，不存 history/revision', () => {
    const created = createTripDraft(MOCK_TRIP, { forkTripId: 'fork-abc', newLegMode: 'driving' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const edited = updateDraftStop(created.draft, 1, 's1', { name: '断桥残雪（改）' })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    const payload = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: edited.draft,
      budget: emptyBudgetSession(),
      ui: { activeDay: 1, draftMode: 'driving', openedFromFile: false },
      tripRevision: 3,
    })
    if (payload === null) throw new Error('payload null')
    expect(payload.draft).not.toBeNull()
    expect(payload.draft!.forkTripId).toBe('fork-abc')
    expect(payload.draft!.newLegMode).toBe('driving')
    expect(payload.draft!.editedDays.map((d) => d.day)).toEqual([1])
    expect(JSON.stringify(payload.draft)).not.toContain('history')
    expect(JSON.stringify(payload.draft)).not.toContain('"revision"')
  })

  it('draft 无实际内容差异（editedDays 与 base 相同值）→ 投影为 null', () => {
    const created = createTripDraft(MOCK_TRIP, { forkTripId: 'fork-abc', newLegMode: 'walking' })
    if (!created.ok) throw new Error('unreachable')
    const payload = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: created.draft,
      budget: emptyBudgetSession(),
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 1,
    })
    if (payload === null) throw new Error('payload null')
    expect(payload.draft).toBeNull()
  })

  it('budget current：owner 与当前 trip+revision 匹配才记 current（含 tripId）', () => {
    const session = boundBudgetSession(MOCK_TRIP, 7)
    const snap = tripOwnerSnapshot(MOCK_TRIP)
    if (!snap.ok) throw new Error('unreachable')
    const payload = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: null,
      budget: session,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 7,
      tripSnapshot: snap.value,
    })
    expect(payload === null).toBe(false)
    if (payload === null) return
    expect(payload.budget).not.toBeNull()
    expect(payload.budget!.binding.kind).toBe('current')
    expect(payload.budget!.rows).toEqual([{ id: 'row-1', category: 'other', name: '高铁票', amountRaw: '128.5' }])
    expect(payload.budget!.budgetRaw).toBe('')
  })

  it('budget stale：owner 存在但不匹配 → stale + id/title 自述', () => {
    const session = boundBudgetSession(MOCK_TRIP, 7)
    const snap = tripOwnerSnapshot(MOCK_TRIP)
    if (!snap.ok) throw new Error('unreachable')
    const payload = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: null,
      budget: session,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 9,
      tripSnapshot: snap.value,
    })
    if (payload === null) throw new Error('payload null')
    expect(payload.budget!.binding.kind).toBe('stale')
    if (payload.budget!.binding.kind !== 'stale') return
    expect(payload.budget!.binding.tripId).toBe(MOCK_TRIP.id)
    expect(payload.budget!.binding.tripTitle).toBe(MOCK_TRIP.title)
  })

  it('budget 未绑定空费用 → unbound 块保留（不静默丢）；不可验证快照 + 有 owner → 投影 null', () => {
    const emptySession = emptyBudgetSession()
    const p1 = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: null,
      budget: emptySession,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 1,
      tripSnapshot: null,
    })
    if (p1 === null) throw new Error('p1 null')
    expect(p1.budget).not.toBeNull()
    expect(p1.budget!.binding.kind).toBe('unbound')

    const session = boundBudgetSession(MOCK_TRIP, 2)
    const block = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: null,
      budget: session,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 1,
      tripSnapshot: null,
    })
    // owner 非空但快照不可验证：整次投影失败（不能只丢费用块落盘其余）
    expect(block).toBeNull()
  })
})

describe('sessionRestore 恢复重建', () => {
  it('rebuildDraftFromTrip：走 createTripDraft + editedDays 替换，changedDays 由 draftChangedDays 重导', () => {
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: payloadOf({
          draft: {
            forkTripId: 'fork-r1',
            newLegMode: 'walking',
            editedDays: [
              {
                day: 1,
                days: MOCK_TRIP.days
                  .filter((d) => d.day === 1)
                  .map((d) => ({
                    ...d,
                    stops: d.stops.map((s) => (s.id === 's1' ? { ...s, name: '断桥残雪（改）' } : s)),
                  })),
              },
            ],
          },
        }),
      }),
    )
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    const rebuilt = rebuildDraftFromTrip(loaded.record.session)
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok || rebuilt.draft === null) return
    const draft = rebuilt.draft
    expect(draft.forkTripId).toBe('fork-r1')
    expect(draft.history).toEqual([])
    expect(draftChangedDays(draft)).toEqual([1])
    expect(draft.days.find((d) => d.day === 1)!.stops[0]!.name).toBe('断桥残雪（改）')
    // base 天完整保留
    expect(draft.days.find((d) => d.day === 2)).toBeDefined()
    // 应用 / 放弃语义安全
    const applied = applyDraft(draft)
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.changed).toBe(true)
    expect(applied.trip.id).toBe('fork-r1')
    const discarded = discardDraft(draft)
    expect(discarded.id).toBe(MOCK_TRIP.id)
  })

  it('rebuildDraftFromTrip 直接调用也拒绝空/多天/错天号的 editedDay', () => {
    const forged = {
      trip: MOCK_TRIP,
      draft: {
        forkTripId: 'fork-forged',
        newLegMode: 'walking' as const,
        editedDays: [
          { day: 1, days: [] },
          { day: 2, days: MOCK_TRIP.days.filter((d) => d.day === 2) },
        ],
      },
      budget: null,
      ui: { activeDay: 1, draftMode: 'walking' as const, openedFromFile: false },
    }
    const rebuilt = rebuildDraftFromTrip(forged)
    expect(rebuilt.ok).toBe(false)
  })

  it('editedDay 内容与 base 完全相同 → draftChangedDays 重导为空（不信任持久标记）', () => {
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: payloadOf({
          draft: {
            forkTripId: 'fork-r2',
            newLegMode: 'walking',
            editedDays: [{ day: 1, days: MOCK_TRIP.days.filter((d) => d.day === 1) }],
          },
        }),
      }),
    )
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    const rebuilt = rebuildDraftFromTrip(loaded.record.session)
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok || rebuilt.draft === null) return
    expect(draftChangedDays(rebuilt.draft)).toEqual([])
  })

  it('rebuildBudgetSession：current + tripId 一致 → 按新 revision 重绑（editable）；tripId 不一致 → typed 失败', () => {
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: payloadOf({
          budget: {
            binding: { kind: 'current', tripId: MOCK_TRIP.id },
            budgetRaw: '500',
            rows: [{ id: 'r1', category: 'stay', name: '酒店', amountRaw: '350.00' }],
          },
        }),
      }),
    )
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    const snap = tripOwnerSnapshot(MOCK_TRIP)
    if (!snap.ok) throw new Error('unreachable')
    const ctx = { tripId: MOCK_TRIP.id, revision: 42, snapshot: snap.value, tripTitle: MOCK_TRIP.title }
    const rebuilt = rebuildBudgetSession(loaded.record.session, ctx)
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(rebuilt.session.owner).not.toBeNull()
    expect(rebuilt.session.owner!.revision).toBe(42)
    expect(rebuilt.session.result).toBeNull()
    expect(rebuilt.session.undo).toBeNull()
    expect(rebuilt.session.rows[0]!.amountRaw).toBe('350.00')
    expect(budgetSessionIsStale(rebuilt.session, ctx)).toBe(false)

    const wrongTripCtx = { ...ctx, tripId: 'other-trip' }
    const mismatch = rebuildBudgetSession(loaded.record.session, wrongTripCtx)
    expect(mismatch.ok).toBe(false)
  })

  it('rebuildBudgetSession：stale → owner 必然失配，走既有沿用/新建，不自动 fresh', () => {
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: payloadOf({
          budget: {
            binding: { kind: 'stale', tripId: 'trip-old', tripTitle: '旧行程' },
            budgetRaw: '',
            rows: [{ id: 'r1', category: 'food', name: '面', amountRaw: '18' }],
          },
        }),
      }),
    )
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    const snap = tripOwnerSnapshot(MOCK_TRIP)
    if (!snap.ok) throw new Error('unreachable')
    const ctx = { tripId: MOCK_TRIP.id, revision: 1, snapshot: snap.value, tripTitle: MOCK_TRIP.title }
    const rebuilt = rebuildBudgetSession(loaded.record.session, ctx)
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(budgetSessionIsStale(rebuilt.session, ctx)).toBe(true)
    // 失配 owner 的编辑被既有 API 拒绝
    const editAttempt = addBudgetRow(rebuilt.session, ctx, 'r-new')
    expect(editAttempt.ok).toBe(false)
  })

  it('rebuildBudgetSession：unbound 空费用 → emptyBudgetSession', () => {
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: payloadOf({
          budget: { binding: { kind: 'unbound' }, budgetRaw: '', rows: [] },
        }),
      }),
    )
    const loaded = loadSessionResumeRecord(window.localStorage)
    if (loaded.status !== 'pending') throw new Error(String(loaded.status))
    const snap = tripOwnerSnapshot(MOCK_TRIP)
    if (!snap.ok) throw new Error('unreachable')
    const rebuilt = rebuildBudgetSession(loaded.record.session, {
      tripId: MOCK_TRIP.id,
      revision: 1,
      snapshot: snap.value,
      tripTitle: MOCK_TRIP.title,
    })
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(rebuilt.session.owner).toBeNull()
    expect(rebuilt.session.rows).toEqual([])
  })

  it('快照不可验证（snapshot null）时 current 费用拒绝重绑，不静默 fresh', () => {
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: payloadOf({
          budget: {
            binding: { kind: 'current', tripId: MOCK_TRIP.id },
            budgetRaw: '',
            rows: [{ id: 'r1', category: 'other', name: '', amountRaw: '5' }],
          },
        }),
      }),
    )
    const loaded = loadSessionResumeRecord(window.localStorage)
    if (loaded.status !== 'pending') throw new Error(String(loaded.status))
    const rebuilt = rebuildBudgetSession(loaded.record.session, {
      tripId: MOCK_TRIP.id,
      revision: 1,
      snapshot: null,
      tripTitle: MOCK_TRIP.title,
    })
    expect(rebuilt.ok).toBe(false)
  })
})

describe('sessionRestore 删除', () => {
  it('removeSessionResumeData 只删数据键，flag 与 savedTrips 不动', () => {
    setSessionResumeFlag(window.localStorage, true)
    writeSessionResume({ payload: payloadOf(), expectedRaw: null }, window.localStorage)
    const SAVED_KEY = 'travel-assistant:saved-trips:v1'
    window.localStorage.setItem(SAVED_KEY, '[正式保存]')
    const result = removeSessionResumeData(window.localStorage)
    expect(result.ok).toBe(true)
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('1')
    expect(window.localStorage.getItem(SAVED_KEY)).toBe('[正式保存]')
  })

  it('removeSessionResumeData 失败 → typed 失败保旧', () => {
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, 'keep')
    const sec = throwingStorage(new DOMException('denied', 'SecurityError'))
    const result = removeSessionResumeData(sec)
    expect(result.ok).toBe(false)
  })
})

describe('sessionRestore 修复回归（D 系列）', () => {
  it('D2: budget current.tripId 与 session.trip.id 不一致 → load 原子拒绝 invalid', () => {
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 5,
        session: payloadOf({
          budget: {
            binding: { kind: 'current', tripId: 'trip-别的' },
            budgetRaw: '',
            rows: [{ id: 'r1', category: 'other', name: '', amountRaw: '1' }],
          },
        }),
      }),
    )
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('invalid')
    // 原始 raw 保留
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull()
  })

  it('D4: owner 非空 + 提供的快照为 null → buildPayloadFromSession 返回 null（整次失败）', () => {
    const session = boundBudgetSession(MOCK_TRIP, 3)
    const payload = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: null,
      budget: session,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 5,
      tripSnapshot: null,
    })
    expect(payload).toBeNull()
  })

  it('D4: owner=null 但 rows/budgetRaw 非空 → 整次投影失败，不写出读端必拒的 unbound', () => {
    // App 层正常不可能构造（addBudgetRow 首次编辑即绑定 owner）；协议要求 unbound 全空，
    // 所以投影端必须整包 fail-closed，而不是落盘后让下一次读取判 invalid。
    const manual: BudgetSessionState = {
      owner: null,
      rows: [{ id: 'r1', category: 'food', name: '面', amountRaw: '' }],
      budgetRaw: '',
      result: null,
      undo: null,
    }
    const payload = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: null,
      budget: manual,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 1,
    })
    expect(payload).toBeNull()

    const withRaw = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: null,
      budget: { ...manual, rows: [], budgetRaw: '12.5' },
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 1,
    })
    expect(withRaw).toBeNull()
  })

  it('D7: ui.openedFromFile=true 保存→读取 pending；缺字段旧记录 → openedFromFile=null', () => {
    const write = writeSessionResume(
      {
        payload: payloadOf({ ui: { activeDay: 2, draftMode: 'driving', openedFromFile: true } }),
        expectedRaw: null,
      },
      window.localStorage,
    )
    expect(write.ok).toBe(true)
    setSessionResumeFlag(window.localStorage, true)
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    expect(loaded.record.session.ui.openedFromFile).toBe(true)

    // 旧记录缺 openedFromFile：合法读取，来源未知
    const legacySession = {
      trip: MOCK_TRIP,
      draft: null,
      budget: null,
      ui: { activeDay: 1, draftMode: 'walking' },
    }
    window.localStorage.setItem(
      SESSION_RESUME_DATA_KEY,
      JSON.stringify({ format: 'travel-assistant.session-resume', version: 1, savedAt: 9, session: legacySession }),
    )
    const legacy = loadSessionResumeRecord(window.localStorage)
    expect(legacy.status).toBe('pending')
    if (legacy.status !== 'pending') return
    expect(legacy.record.session.ui.openedFromFile).toBeNull()
    // ui.openedFromFile 类型异常 → invalid
    const badUi = { ...legacySession, ui: { activeDay: 1, draftMode: 'walking', openedFromFile: 'yes' } }
    window.localStorage.setItem(
      SESSION_RESUME_DATA_KEY,
      JSON.stringify({ format: 'travel-assistant.session-resume', version: 1, savedAt: 9, session: badUi }),
    )
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('invalid')
  })

  it('D2: previewSessionResume 原子预检——draft 与 budget 都可重建才 ok；失败不改存储', () => {
    const write = writeSessionResume(
      {
        payload: {
          trip: MOCK_TRIP,
          draft: {
            forkTripId: 'fork-p1',
            newLegMode: 'walking',
            editedDays: [
              {
                day: 1,
                days: [
                  {
                    ...MOCK_TRIP.days[0]!,
                    stops: [{ ...MOCK_TRIP.days[0]!.stops[0]!, name: '改过的站' }],
                  },
                ],
              },
            ],
          },
          budget: {
            binding: { kind: 'current', tripId: MOCK_TRIP.id },
            budgetRaw: '99',
            rows: [{ id: 'r1', category: 'other', name: 'x', amountRaw: '9' }],
          },
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        },
        expectedRaw: null,
      },
      window.localStorage,
    )
    expect(write.ok).toBe(true)
    setSessionResumeFlag(window.localStorage, true)
    const loaded = loadSessionResumeRecord(window.localStorage)
    if (loaded.status !== 'pending') throw new Error(String(loaded.status))
    const before = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    const preview = previewSessionResume(loaded.record, 42)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.draft?.forkTripId).toBe('fork-p1')
    expect(preview.budget.owner?.revision).toBe(42)
    expect(preview.openedFromFile).toBe(false)
    // 预检零副作用
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(before)
  })

  it('D1: 写成功返回 writtenRaw（不依赖二次读）；读取端 pending', () => {
    const write = writeSessionResume({ payload: payloadOf(), expectedRaw: null }, window.localStorage)
    expect(write.ok).toBe(true)
    if (!write.ok) return
    expect(write.writtenRaw).toContain('"session"')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(write.writtenRaw)
  })
})

/* ───────── 说明：buildPayloadFromSession / rebuildDraftFromTrip / rebuildBudgetSession 已在顶部导入 ───────── */

function isoPayloadOf(overrides?: {
  trip?: unknown
  draft?: unknown
  budget?: unknown
  ui?: unknown
}): SessionResumePayload {
  return {
    trip: (overrides?.trip ?? MOCK_TRIP) as SessionResumePayload['trip'],
    draft: (overrides?.draft ?? null) as SessionResumePayload['draft'],
    budget: (overrides?.budget ?? null) as SessionResumePayload['budget'],
    ui: (overrides?.ui ?? {
      activeDay: 1,
      draftMode: 'walking',
      openedFromFile: false,
    }) as SessionResumePayload['ui'],
  }
}

function freshTrip(): typeof MOCK_TRIP {
  return structuredClone(MOCK_TRIP)
}

/** day 3（未编辑天之外的单站天）被编辑的持久化 session；trip 用本地克隆防测试间串扰 */
function sessionWithEditedDay3(trip: typeof MOCK_TRIP = freshTrip()): SessionResumePayload {
  return isoPayloadOf({
    trip,
    draft: {
      forkTripId: 'fork-iso',
      newLegMode: 'walking',
      editedDays: [
        {
          day: 3,
          days: [
            {
              ...trip.days[2]!,
              stops: trip.days[2]!.stops.map((s) =>
                s.id === 's4' ? { ...s, name: 'iso-edited-s4' } : s,
              ),
            },
          ],
        },
      ],
    },
  })
}

function rebuild(session: SessionResumePayload): NonNullable<Extract<ReturnType<typeof rebuildDraftFromTrip>, { ok: true }>['draft']> {
  const rebuilt = rebuildDraftFromTrip(session)
  expect(rebuilt.ok).toBe(true)
  if (!rebuilt.ok || rebuilt.draft === null) throw new Error('rebuild failed')
  return rebuilt.draft
}

describe('sessionRestore 恢复重建隔离（修复 A）', () => {
  it('未编辑天与编辑天都不别名 base/记录：day/stop/location/leg 独立（直接调用）', () => {
    const session = sessionWithEditedDay3()
    const draft = rebuild(session)
    // day 对象独立（未编辑天 + 编辑天）
    expect(draft.days[0]).not.toBe(session.trip.days[0])
    expect(draft.days[1]).not.toBe(session.trip.days[1])
    expect(draft.days[2]).not.toBe(session.trip.days[2])
    // 未编辑天的数组、站点、location 独立（day1 s1 有坐标）
    expect(draft.days[0].stops).not.toBe(session.trip.days[0].stops)
    expect(draft.days[0].stops[0]).not.toBe(session.trip.days[0].stops[0])
    expect(draft.days[0].stops[0].location).not.toBe(session.trip.days[0].stops[0].location)
    expect(draft.days[0].stops[0].location).toEqual(session.trip.days[0].stops[0].location)
    // 编辑天：与持久化 editedDays 块独立
    expect(draft.days[2]).not.toBe(session.draft!.editedDays[0]!.days[0])
    expect(draft.days[2].stops).not.toBe(session.draft!.editedDays[0]!.days[0].stops)
    expect(draft.days[2].stops[0]).not.toBe(session.draft!.editedDays[0]!.days[0].stops[0])
  })

  it('geometry 与坐标点保持只读共享：未编辑天 draft 与 base 同引用', () => {
    const session = sessionWithEditedDay3()
    const draft = rebuild(session)
    expect(draft.days[0].legs[0].geometry).toBe(session.trip.days[0].legs[0].geometry)
    expect(draft.days[0].legs[1].geometry).toBe(session.trip.days[0].legs[1].geometry)
  })

  it('草稿内就地修改不污染 base 与持久化记录（双向隔离）', () => {
    const session = sessionWithEditedDay3()
    const draft = rebuild(session)
    const baseName = session.trip.days[0].stops[0].name
    const recordName = session.draft!.editedDays[0]!.days[0].stops[0].name
    // 就地改未编辑天（day1 s1）与编辑天（day3 s4）
    ;(draft.days[0].stops[0] as { name: string }).name = '就地改草稿'
    ;(draft.days[2].stops[0] as { name: string }).name = '就地改编辑天'
    expect(session.trip.days[0].stops[0].name).toBe(baseName)
    expect(session.trip.days[2].stops[0].name).not.toBe('就地改编辑天')
    expect(session.draft!.editedDays[0]!.days[0].stops[0].name).toBe(recordName)
  })

  it('重建后 copy-on-write 编辑与 undo/changedDays 合同不变', () => {
    const session = sessionWithEditedDay3()
    const draft = rebuild(session)
    expect(draft.changedDays).toEqual([3])
    expect(draft.history).toEqual([])
    expect(draftChangedDays(draft)).toEqual([3])
    const edited = updateDraftStop(draft, 1, 's1', { name: 'cw-edit' })
    expect(edited.ok).toBe(true)
    if (!edited.ok) return
    expect(edited.draft.changedDays).toEqual([1, 3])
    expect(draftChangedDays(edited.draft)).toEqual([1, 3])
    expect(session.trip.days[0].stops[0].name).not.toBe('cw-edit')
    const undone = undoDraft(edited.draft)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.draft.changedDays).toEqual([3])
    expect(undone.draft.days[0].stops[0].name).toEqual(session.trip.days[0].stops[0].name)
    expect(draftChangedDays(undone.draft)).toEqual([3])
  })

  it('扩展坐标字段按 cloneEditableDays 策略保留，location 对象独立', () => {
    const wide = {
      ...freshTrip(),
      days: freshTrip().days.map((day) => ({
        ...day,
        stops: day.stops.map((stop) =>
          stop.location === null
            ? stop
            : { ...stop, location: { ...stop.location, note: '来源标注' } },
        ),
      })),
    }
    const session = sessionWithEditedDay3(wide as typeof MOCK_TRIP)
    const draft = rebuild(session)
    const draftLoc = draft.days[2].stops[0].location as { lng: number; lat: number; note?: string }
    expect(draftLoc.note).toBe('来源标注')
    expect(draftLoc).not.toBe(session.trip.days[2].stops[0].location)
    // 只改时间：坐标与扩展字段原样保留，且不写回 base
    const timeEdit = updateDraftStop(draft, 3, 's4', { time: '11:00' })
    expect(timeEdit.ok).toBe(true)
    if (!timeEdit.ok) return
    const editedLoc = timeEdit.draft.days[2].stops[0].location as { note?: string }
    expect(editedLoc.note).toBe('来源标注')
    expect(session.trip.days[2].stops[0].location).not.toBe(timeEdit.draft.days[2].stops[0].location)
  })

  it('write → load → rebuild 全链路同样隔离（jsdom localStorage）', () => {
    setSessionResumeFlag(window.localStorage, true)
    const session = sessionWithEditedDay3()
    const write = writeSessionResume({ payload: session, expectedRaw: null }, window.localStorage)
    expect(write.ok).toBe(true)
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    const draft = rebuild(
      isoPayloadOf({
        trip: loaded.record.session.trip,
        draft: loaded.record.session.draft,
        budget: loaded.record.session.budget,
        ui: loaded.record.session.ui,
      }),
    )
    expect(draft.days[0]).not.toBe(loaded.record.session.trip.days[0])
    expect(draft.days[2]).not.toBe(loaded.record.session.draft!.editedDays[0]!.days[0])
    // geometry 与加载出的 base trip 仍同引用（只读共享）
    expect(draft.days[0].legs[0].geometry).toBe(loaded.record.session.trip.days[0].legs[0].geometry)
  })
})

describe('sessionRestore 写门禁同尺校验（修复 B）', () => {
  it('buildPayloadFromSession：非法 Trip（空 days / 重复 day / 重复 stop id）→ null', () => {
    const dupDay = { ...MOCK_TRIP, days: [MOCK_TRIP.days[0]!, { ...MOCK_TRIP.days[0]! }] }
    const dupStop = {
      ...MOCK_TRIP,
      days: [
        {
          ...MOCK_TRIP.days[0]!,
          stops: [MOCK_TRIP.days[0]!.stops[0]!, { ...MOCK_TRIP.days[0]!.stops[0]! }],
        },
      ],
    }
    const badTrips: unknown[] = [{ ...MOCK_TRIP, days: [] }, dupDay, dupStop]
    for (const badTrip of badTrips) {
      const payload = buildPayloadFromSession({
        trip: badTrip as typeof MOCK_TRIP,
        draft: null,
        budget: emptyBudgetSession(),
        ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        tripRevision: 1,
      })
      expect(payload).toBeNull()
    }
  })

  it('writeSessionResume：读端必拒的非法 Trip → typed snapshot_failed，存储原样', () => {
    setSessionResumeFlag(window.localStorage, true)
    const ok = writeSessionResume({ payload: isoPayloadOf(), expectedRaw: null }, window.localStorage)
    expect(ok.ok).toBe(true)
    const before = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    const result = writeSessionResume(
      { payload: isoPayloadOf({ trip: { ...MOCK_TRIP, days: [] } }), expectedRaw: before },
      window.localStorage,
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toBe('snapshot_failed')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(before)
  })

  it('writeSessionResume：重复 day / 重复 stop id 同样拒写', () => {
    setSessionResumeFlag(window.localStorage, true)
    const dupDay = { ...MOCK_TRIP, days: [MOCK_TRIP.days[0]!, { ...MOCK_TRIP.days[0]! }] }
    const dupStop = {
      ...MOCK_TRIP,
      days: [
        {
          ...MOCK_TRIP.days[0]!,
          stops: [MOCK_TRIP.days[0]!.stops[0]!, { ...MOCK_TRIP.days[0]!.stops[0]! }],
        },
      ],
    }
    for (const badTrip of [dupDay, dupStop]) {
      const result = writeSessionResume(
        { payload: isoPayloadOf({ trip: badTrip }), expectedRaw: null },
        window.localStorage,
      )
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.reason).toBe('snapshot_failed')
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()
    }
  })

  it('toJSON 改变结构：内存形状合法、实际写出非法 → snapshot_failed（按写出字节验证）', () => {
    setSessionResumeFlag(window.localStorage, true)
    const tricky = {
      ...MOCK_TRIP,
      toJSON() {
        return { ...MOCK_TRIP, days: [] }
      },
    } as unknown as typeof MOCK_TRIP
    const result = writeSessionResume(
      { payload: isoPayloadOf({ trip: tricky }), expectedRaw: null },
      window.localStorage,
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toBe('snapshot_failed')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()
  })

  it('同尺不误伤：有效 Trip + 空白/坏金额/0 金额 + openedFromFile null 正常 write → load pending', () => {
    setSessionResumeFlag(window.localStorage, true)
    const payload = isoPayloadOf({
      budget: {
        binding: { kind: 'current', tripId: MOCK_TRIP.id },
        budgetRaw: '',
        rows: [
          { id: 'r1', category: 'food', name: 'a', amountRaw: '' },
          { id: 'r2', category: 'other', name: 'b', amountRaw: 'abc' },
          { id: 'r3', category: 'stay', name: 'c', amountRaw: '0' },
        ],
      },
      ui: { activeDay: 2, draftMode: 'driving', openedFromFile: null },
    })
    const result = writeSessionResume({ payload, expectedRaw: null }, window.localStorage)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('pending')
    if (loaded.status !== 'pending') return
    expect(loaded.record.session.budget!.rows.map((r) => r.amountRaw)).toEqual(['', 'abc', '0'])
    expect(loaded.record.session.ui.openedFromFile).toBeNull()
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(result.writtenRaw)
  })
})


/**
 * sessionRestore v2 × workspace 适配回归：
 * - v1 原字节 / 原行为不变；v1 不读工作区库、不按 tripId/hash 自动挂 sidecar；
 * - v2 完整往返（Trip + sidecar + 手工预算 + identity/meta），workspace 块不重复 Trip/预算；
 * - 缺字段 / 未知字段 / 冲突预算 / 损坏 checklist 全部原子拒绝并保旧；
 * - 容量：v2 独立上限不误伤合法 640 KiB Trip + 512 KiB sidecar，也不无限大；
 * - prepare → confirm 的引用 + epoch + CAS 门；无 workspace 明确返回；
 * - 默认关闭按内容键分别计读取次数。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOCK_TRIP } from './fixtures/trip'
import {
  MAX_SESSION_RESUME_BYTES,
  MAX_SESSION_RESUME_V2_BYTES,
  SESSION_RESUME_DATA_KEY,
  SESSION_RESUME_FLAG_KEY,
  buildPayloadFromSession,
  loadSessionResumeRecord,
  previewSessionResume,
  sessionBudgetSnapshot,
  setSessionResumeFlag,
  writeSessionResume,
  type SessionResumeBudgetBlock,
  type SessionResumePayload,
} from '../lib/sessionRestore'
import {
  createWorkspaceRecord,
  emptySidecar,
  validateWorkspaceRecord,
} from '../lib/workspace'
import type { Trip } from '../lib/api'
import {
  WORKSPACE_STORAGE_KEY,
  type ChecklistItemV1,
  type WorkspaceRecordV1,
} from '../lib/workspaceTypes'
import { createSessionWorkspaceBlock } from '../lib/workspaceTransfer'
import { emptyBudgetSession } from '../lib/tripBudget'
import {
  confirmSessionWorkspaceRestore,
  prepareSessionWorkspaceRestore,
  previewSessionResumeWithWorkspace,
} from '../lib/workspaceSessionRestore'

const NOW = 1_800_000_000_000

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

function makeChecklistItem(overrides: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return {
    id: 'check-1',
    category: 'ticket',
    title: '预约确认单',
    done: false,
    date: null,
    day: 1,
    stopId: 's2',
    originalStopId: null,
    constraintId: 'constraint-1',
    notes: null,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeWorkspace(overrides: Partial<WorkspaceRecordV1> = {}): WorkspaceRecordV1 {
  const created = createWorkspaceRecord({
    workspaceId: 'workspace-w1',
    ownerId: 'owner-w1',
    trip: MOCK_TRIP,
    workspaceRevision: 3,
    now: NOW - 1000,
    sidecar: {
      ...emptySidecar(),
      checklist: { items: [makeChecklistItem()], appliedTemplates: [] },
    },
    budget: {
      budgetRaw: '500',
      rows: [{ id: 'row-1', category: 'other', name: '高铁票', amountRaw: '128.5' }],
    },
    label: '会话工作区',
  })
  if (!created.ok) throw new Error(`fixture workspace 创建失败：${created.message}`)
  return { ...created.value, ...overrides }
}

function currentBudgetBlock(workspace: WorkspaceRecordV1): SessionResumeBudgetBlock | null {
  if (workspace.budget === null) return null
  return {
    binding: { kind: 'current', tripId: workspace.tripId },
    budgetRaw: workspace.budget.budgetRaw,
    rows: workspace.budget.rows,
  }
}

function payloadFor(
  workspace: WorkspaceRecordV1,
  overrides: Partial<SessionResumePayload> = {},
): SessionResumePayload {
  return {
    trip: workspace.trip,
    draft: null,
    budget: currentBudgetBlock(workspace),
    ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
    workspace,
    ...overrides,
  }
}

function seedWithFlag(raw: string): void {
  window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
  window.localStorage.setItem(SESSION_RESUME_DATA_KEY, raw)
}

function pendingLoad() {
  const loaded = loadSessionResumeRecord(window.localStorage)
  if (loaded.status !== 'pending') throw new Error(`expected pending, got ${loaded.status}`)
  return loaded
}

function countingStorage(): { storage: Storage; keys: string[] } {
  const keys: string[] = []
  const storage: Storage = {
    get length() {
      return window.localStorage.length
    },
    clear() {
      window.localStorage.clear()
    },
    getItem(key: string) {
      keys.push(key)
      return window.localStorage.getItem(key)
    },
    key(index: number) {
      return window.localStorage.key(index)
    },
    removeItem(key: string) {
      window.localStorage.removeItem(key)
    },
    setItem(key: string, value: string) {
      window.localStorage.setItem(key, value)
    },
  }
  return { storage, keys }
}

function largeTrip(stopCount: number, descriptionLength: number): Trip {
  const stops = Array.from({ length: stopCount }, (_, index) => ({
    id: `large-s${index}`,
    name: `站点 ${index}`,
    time: '09:00',
    duration_minutes: 30,
    description: 'x'.repeat(descriptionLength),
    address: '杭州市',
    location: null,
  }))
  return {
    ...MOCK_TRIP,
    title: '大行程',
    summary: '',
    days: [
      {
        day: 1,
        date: '2026-04-03',
        title: '大日',
        summary: '',
        stops,
        legs: [],
      },
    ],
  }
}

function largeSidecar(): WorkspaceRecordV1['sidecar'] {
  const items = Array.from({ length: 300 }, (_, index) => ({
    ...makeChecklistItem({ id: `check-${index}`, title: 't'.repeat(200), notes: 'n'.repeat(1000) }),
  }))
  return {
    ...emptySidecar(),
    checklist: { items, appliedTemplates: [] },
  }
}

describe('sessionRestore v2 / v1 兼容', () => {
  it('无 workspace 时仍写 outer v1，session 只有原四键；读取 workspace 为 null', () => {
    setSessionResumeFlag(window.localStorage, true)
    const payload: SessionResumePayload = {
      trip: MOCK_TRIP,
      draft: null,
      budget: null,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
    }
    const write = writeSessionResume({ payload, expectedRaw: null }, window.localStorage)
    expect(write.ok).toBe(true)
    const parsed = JSON.parse(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!) as {
      version: number
      session: Record<string, unknown>
    }
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.session)).toEqual(['trip', 'draft', 'budget', 'ui'])

    const loaded = pendingLoad()
    expect(loaded.version).toBe(1)
    expect(loaded.record.session.workspace).toBeNull()
    expect(loaded.record.session.trip.id).toBe(MOCK_TRIP.id)
  })

  it('v1 出现 workspace 键仍按旧严格协议 invalid；原 raw 保留', () => {
    const session = {
      trip: MOCK_TRIP,
      draft: null,
      budget: null,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      workspace: null,
    }
    const raw = JSON.stringify({
      format: 'travel-assistant.session-resume',
      version: 1,
      savedAt: NOW,
      session,
    })
    seedWithFlag(raw)
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('invalid')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(raw)
  })

  it('v2 完整往返：workspace 块只含六键，不重复 Trip/预算，sidecar 与预算读回一致', () => {
    const record = makeWorkspace()
    setSessionResumeFlag(window.localStorage, true)
    const write = writeSessionResume({ payload: payloadFor(record), expectedRaw: null }, window.localStorage)
    expect(write.ok).toBe(true)
    if (!write.ok) return

    const parsed = JSON.parse(write.writtenRaw) as {
      version: number
      session: { workspace: Record<string, unknown> }
    }
    expect(parsed.version).toBe(2)
    expect(Object.keys(parsed.session.workspace).sort()).toEqual(
      ['meta', 'ownerId', 'sidecar', 'updatedAt', 'workspaceId', 'workspaceRevision'].sort(),
    )
    expect(parsed.session.workspace).not.toHaveProperty('trip')
    expect(parsed.session.workspace).not.toHaveProperty('budget')

    const loaded = pendingLoad()
    expect(loaded.version).toBe(2)
    const restored = loaded.record.session.workspace
    expect(restored).not.toBeNull()
    if (!restored) return
    expect(restored.trip).toEqual(MOCK_TRIP)
    expect(restored.sidecar).toEqual(record.sidecar)
    expect(restored.sidecar.checklist.items[0]!.constraintId).toBe('constraint-1')
    expect(restored.budget).toEqual(record.budget)
    expect(restored.workspaceRevision).toBe(record.workspaceRevision)
    expect(restored.workspaceId).toBe(record.workspaceId)
    expect(validateWorkspaceRecord(restored).ok).toBe(true)
  })

  it('现有 v2 不能被无 workspace 的写静默降级为 v1；显式 allowWorkspaceDrop 才允许', () => {
    const record = makeWorkspace()
    setSessionResumeFlag(window.localStorage, true)
    const v2 = writeSessionResume({ payload: payloadFor(record), expectedRaw: null }, window.localStorage)
    expect(v2.ok).toBe(true)
    if (!v2.ok) return

    const v1Payload: SessionResumePayload = {
      trip: MOCK_TRIP,
      draft: null,
      budget: null,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
    }
    const blocked = writeSessionResume(
      { payload: v1Payload, expectedRaw: v2.writtenRaw },
      window.localStorage,
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.ok ? '' : blocked.reason).toBe('workspace_conflict')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(v2.writtenRaw)

    const allowed = writeSessionResume(
      { payload: v1Payload, expectedRaw: v2.writtenRaw, allowWorkspaceDrop: true },
      window.localStorage,
    )
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    const parsed = JSON.parse(allowed.writtenRaw) as { version: number }
    expect(parsed.version).toBe(1)
  })

  it('v2 workspace:null 合法读取但明确无工作区；缺 workspace 键 / 块内未知字段 invalid', () => {
    const base = {
      trip: MOCK_TRIP,
      draft: null,
      budget: null,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
    }
    seedWithFlag(JSON.stringify({ format: 'travel-assistant.session-resume', version: 2, savedAt: NOW, session: base }))
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('invalid')

    const withNull = JSON.stringify({
      format: 'travel-assistant.session-resume',
      version: 2,
      savedAt: NOW,
      session: { ...base, workspace: null },
    })
    seedWithFlag(withNull)
    const loaded = pendingLoad()
    expect(loaded.record.session.workspace).toBeNull()

    const record = makeWorkspace()
    const block = createSessionWorkspaceBlock(record)
    if (!block.ok) throw new Error(block.message)
    seedWithFlag(
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 2,
        savedAt: NOW,
        session: {
          ...base,
          budget: currentBudgetBlock(record),
          workspace: { ...block.value, trip: MOCK_TRIP },
        },
      }),
    )
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('invalid')
  })

  it('v2 预算只按 current + tripId 映射；stale/unbound/null 不冒充，冲突写入 fail closed', () => {
    const workspace = makeWorkspace({ budget: null })
    expect(sessionBudgetSnapshot(null, workspace.tripId)).toBeNull()
    expect(
      sessionBudgetSnapshot(
        { binding: { kind: 'stale', tripId: workspace.tripId, tripTitle: '旧' }, budgetRaw: '', rows: [] },
        workspace.tripId,
      ),
    ).toBeNull()
    expect(
      sessionBudgetSnapshot({ binding: { kind: 'unbound' }, budgetRaw: '', rows: [] }, workspace.tripId),
    ).toBeNull()
    expect(sessionBudgetSnapshot(currentBudgetBlock(makeWorkspace()), MOCK_TRIP.id)).toEqual(
      makeWorkspace().budget,
    )

    setSessionResumeFlag(window.localStorage, true)
    const staleBudget: SessionResumeBudgetBlock = {
      binding: { kind: 'stale', tripId: workspace.tripId, tripTitle: '旧行程' },
      budgetRaw: '',
      rows: [{ id: 'r1', category: 'food', name: '面', amountRaw: '18' }],
    }
    const writeStale = writeSessionResume(
      { payload: payloadFor(workspace, { budget: staleBudget }), expectedRaw: null },
      window.localStorage,
    )
    expect(writeStale.ok).toBe(true)
    if (!writeStale.ok) return
    const loadedStale = pendingLoad()
    expect(loadedStale.record.session.workspace!.budget).toBeNull()
    expect(loadedStale.record.session.budget!.binding.kind).toBe('stale')

    // workspace 里有预算但 session.budget 映射为 null → conflict，旧 raw 原样
    const mismatched = makeWorkspace()
    const before = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    const conflict = writeSessionResume(
      { payload: payloadFor(mismatched, { budget: null }), expectedRaw: before },
      window.localStorage,
    )
    expect(conflict.ok).toBe(false)
    expect(conflict.ok ? '' : conflict.reason).toBe('workspace_conflict')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(before)
  })

  it('checklist 段损坏 → 整份 invalid，提示人工修复，raw 原样且不写空清单', () => {
    const record = makeWorkspace()
    const rawRecord = structuredClone(record) as WorkspaceRecordV1
    rawRecord.sidecar.checklist.items[0]!.notes = 'x'.repeat(1001)
    const block = createSessionWorkspaceBlock(record)
    if (!block.ok) throw new Error(block.message)
    const brokenBlock = {
      ...block.value,
      sidecar: rawRecord.sidecar,
    }
    const raw = JSON.stringify({
      format: 'travel-assistant.session-resume',
      version: 2,
      savedAt: NOW,
      session: {
        trip: MOCK_TRIP,
        draft: null,
        budget: currentBudgetBlock(record),
        ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        workspace: brokenBlock,
      },
    })
    seedWithFlag(raw)
    const loaded = loadSessionResumeRecord(window.localStorage)
    expect(loaded.status).toBe('invalid')
    if (loaded.status !== 'invalid') return
    expect(loaded.message).toContain('清单')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(raw)
  })

  it('v2 超过独立 3 MiB 上限 → too_large 保旧；不沿用旧 1.5 MiB 误伤合法 workspace', () => {
    const trip = largeTrip(60, 9800)
    const created = createWorkspaceRecord({
      workspaceId: 'workspace-large',
      ownerId: 'owner-large',
      trip,
      workspaceRevision: 2,
      now: NOW,
      sidecar: largeSidecar(),
      budget: null,
    })
    if (!created.ok) throw new Error(created.message)
    const workspace = created.value
    expect(validateWorkspaceRecord(workspace).ok).toBe(true)

    setSessionResumeFlag(window.localStorage, true)
    const day = trip.days[0]!
    const payload: SessionResumePayload = {
      trip,
      draft: {
        forkTripId: 'fork-large',
        newLegMode: 'walking',
        editedDays: [{ day: 1, days: [day] }],
      },
      budget: null,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      workspace,
    }
    const write = writeSessionResume({ payload, expectedRaw: null }, window.localStorage)
    expect(write.ok).toBe(true)
    if (!write.ok) return
    expect(write.bytes).toBeGreaterThan(MAX_SESSION_RESUME_BYTES)
    expect(write.bytes).toBeLessThanOrEqual(MAX_SESSION_RESUME_V2_BYTES)
    expect(pendingLoad().record.session.workspace!.sidecar.checklist.items).toHaveLength(300)

    // 超 3 MiB：4 个编辑日 × 100 站 × 9000 字符，写前即拒绝，原 raw 不动
    const before = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    const hugeDays = Array.from({ length: 4 }, (_, dayIndex) => {
      const stops = Array.from({ length: 100 }, (_, stopIndex) => ({
        id: `huge-${dayIndex}-${stopIndex}`,
        name: `站点 ${stopIndex}`,
        time: '09:00',
        duration_minutes: 30,
        description: 'y'.repeat(9000),
        address: '杭州市',
        location: null,
      }))
      return { day: dayIndex + 1, date: '2026-04-03', title: '大日', summary: '', stops, legs: [] }
    })
    const hugeTrip: Trip = {
      ...trip,
      days: hugeDays.map((day) => ({ ...day, stops: [], legs: [] })),
    }
    const hugeWorkspace = makeWorkspace({
      trip: hugeTrip,
      workspaceRevision: 9,
      sidecar: emptySidecar(),
      budget: null,
    })
    const hugeWrite = writeSessionResume(
      {
        payload: {
          trip: hugeTrip,
          draft: {
            forkTripId: 'fork-huge',
            newLegMode: 'walking',
            editedDays: hugeDays.map((d) => ({ day: d.day, days: [d] })),
          },
          budget: null,
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
          workspace: hugeWorkspace,
        },
        expectedRaw: before,
      },
      window.localStorage,
    )
    expect(hugeWrite.ok).toBe(false)
    expect(hugeWrite.ok ? '' : hugeWrite.reason).toBe('too_large')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(before)
  })

  it('未知版本 / 坏 JSON / getter 抛错均保旧；v1 读取不碰工作区库键', () => {
    const rawV2 = JSON.stringify({
      format: 'travel-assistant.session-resume',
      version: 3,
      savedAt: NOW,
      session: { trip: MOCK_TRIP, draft: null, budget: null, ui: { activeDay: 1, draftMode: 'walking' } },
    })
    seedWithFlag(rawV2)
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('unknown_version')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawV2)

    const v1 = {
      format: 'travel-assistant.session-resume',
      version: 1,
      savedAt: NOW,
      session: {
        trip: MOCK_TRIP,
        draft: null,
        budget: null,
        ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      },
    }
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({ unrelated: true }))
    seedWithFlag(JSON.stringify(v1))
    const counting = countingStorage()
    const loaded = loadSessionResumeRecord(counting.storage)
    expect(loaded.status).toBe('pending')
    expect(counting.keys).toContain(SESSION_RESUME_FLAG_KEY)
    expect(counting.keys).toContain(SESSION_RESUME_DATA_KEY)
    expect(counting.keys).not.toContain(WORKSPACE_STORAGE_KEY)

    const throwing = {
      get length() {
        return 0
      },
      clear() {},
      getItem() {
        throw new DOMException('denied', 'SecurityError')
      },
      key() {
        return null
      },
      removeItem() {},
      setItem() {},
    } as Storage
    expect(loadSessionResumeRecord(throwing).status).toBe('unavailable')

    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, '{oops')
    expect(loadSessionResumeRecord(window.localStorage).status).toBe('corrupt')
  })

  it('默认关闭：只读 flag 键，不读数据键 / 工作区键', () => {
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '0')
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, '{"x":1}')
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, '{"x":1}')
    const counting = countingStorage()
    expect(loadSessionResumeRecord(counting.storage).status).toBe('disabled')
    expect(counting.keys).toEqual([SESSION_RESUME_FLAG_KEY])
  })
})

describe('workspaceSessionRestore prepare / confirm', () => {
  it('v1 / v2 workspace:null → 明确 no_workspace，不按 tripId 自动挂接工作区库记录', () => {
    const session = {
      trip: MOCK_TRIP,
      draft: null,
      budget: null,
      ui: { activeDay: 1, draftMode: 'walking' as const, openedFromFile: false },
      workspace: null,
    }
    const prepared = prepareSessionWorkspaceRestore({
      session,
      savedAt: NOW,
      raw: 'raw-v1',
      currentWorkspace: makeWorkspace(),
      epoch: 4,
      now: NOW,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.status).toBe('no_workspace')
    if (prepared.status !== 'no_workspace') return
    expect(prepared.message).toContain('不自动')
  })

  it('同 trip：整体 transition revision=当前+1，confirm 引用 + epoch + 内容全部匹配才通过', () => {
    const source = makeWorkspace()
    const current = makeWorkspace({
      workspaceId: 'workspace-current',
      ownerId: 'owner-current',
      workspaceRevision: 7,
      sidecar: emptySidecar(),
      budget: null,
    })
    const prepared = prepareSessionWorkspaceRestore({
      session: {
        trip: source.trip,
        draft: null,
        budget: currentBudgetBlock(source),
        ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        workspace: source,
      },
      savedAt: NOW,
      raw: 'raw-v2',
      currentWorkspace: current,
      epoch: 5,
      now: NOW,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok || prepared.status !== 'ready') throw new Error('expected ready')
    expect(prepared.proposal.transition).toBe('commit_same_trip')
    expect(prepared.proposal.record.workspaceRevision).toBe(8)
    expect(prepared.proposal.record.workspaceId).toBe(current.workspaceId)
    expect(prepared.proposal.record.sidecar).toEqual(source.sidecar)
    expect(prepared.proposal.record.budget).toEqual(source.budget)
    expect(prepared.proposal.apply.atomic).toBe(true)
    expect(prepared.proposal.apply.requiresEpochAdvance).toBe(true)
    expect(prepared.proposal.apply.suggestedEpochAfter).toBe(6)

    const confirmed = confirmSessionWorkspaceRestore(prepared, current, 5)
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    expect(confirmed.record.workspaceRevision).toBe(8)
    expect(confirmed.nextEpoch).toBe(6)
    expect(confirmed.owner.epoch).toBe(6)
    expect(confirmed.runtime.epoch).toBe(6)

    const rawMismatch = confirmSessionWorkspaceRestore(prepared, current, 5, {
      currentRaw: 'other-raw',
    })
    expect(rawMismatch.ok).toBe(false)
    expect(rawMismatch.ok ? '' : rawMismatch.reason).toBe('input_changed')

    // 同内容新引用：ref 门拒绝
    const clone = structuredClone(current) as WorkspaceRecordV1
    const cloneConfirm = confirmSessionWorkspaceRestore(prepared, clone, 5)
    expect(cloneConfirm.ok).toBe(false)
    expect(cloneConfirm.ok ? '' : cloneConfirm.reason).toBe('current_changed')

    // epoch 已推进（A→B→A 也一样）：旧确认失效
    const epochConfirm = confirmSessionWorkspaceRestore(prepared, current, 6)
    expect(epochConfirm.ok).toBe(false)
    expect(epochConfirm.ok ? '' : epochConfirm.reason).toBe('epoch_changed')
  })

  it('无当前工作区 → revision 1；当前是别的 trip → replace_trip 且不复用快照 revision', () => {
    const source = makeWorkspace()
    const session = {
      trip: source.trip,
      draft: null,
      budget: currentBudgetBlock(source),
      ui: { activeDay: 1, draftMode: 'walking' as const, openedFromFile: false },
      workspace: source,
    }
    const fresh = prepareSessionWorkspaceRestore({
      session,
      savedAt: NOW,
      raw: 'raw',
      currentWorkspace: null,
      epoch: 1,
      now: NOW,
    })
    expect(fresh.ok && fresh.status === 'ready').toBe(true)
    if (!fresh.ok || fresh.status !== 'ready') return
    expect(fresh.proposal.transition).toBe('new_workspace')
    expect(fresh.proposal.record.workspaceRevision).toBe(1)
    expect(fresh.proposal.record.workspaceId).toBe(source.workspaceId)

    const otherTrip = { ...MOCK_TRIP, id: 'trip-other' }
    const otherWorkspace = makeWorkspace({ trip: otherTrip, tripId: otherTrip.id, workspaceRevision: 11 })
    const replace = prepareSessionWorkspaceRestore({
      session,
      savedAt: NOW,
      raw: 'raw',
      currentWorkspace: otherWorkspace,
      epoch: 2,
      now: NOW,
    })
    expect(replace.ok && replace.status === 'ready').toBe(true)
    if (!replace.ok || replace.status !== 'ready') return
    expect(replace.proposal.transition).toBe('replace_trip')
    expect(replace.proposal.record.workspaceRevision).toBe(12)
    expect(replace.proposal.record.trip.id).toBe(MOCK_TRIP.id)
    expect(replace.proposal.record.workspaceId).toBe(source.workspaceId)
  })

  it('workspace 与 session trip / 预算冲突 → typed 失败，不产生 proposal', () => {
    const source = makeWorkspace()
    const tripMismatch = prepareSessionWorkspaceRestore({
      session: {
        trip: { ...MOCK_TRIP, id: 'trip-different' },
        draft: null,
        budget: currentBudgetBlock(source),
        ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        workspace: source,
      },
      savedAt: NOW,
      raw: 'raw',
      currentWorkspace: null,
      epoch: 1,
      now: NOW,
    })
    expect(tripMismatch.ok).toBe(false)
    expect(tripMismatch.ok ? '' : tripMismatch.reason).toBe('trip_mismatch')

    const budgetMismatch = prepareSessionWorkspaceRestore({
      session: {
        trip: source.trip,
        draft: null,
        budget: null,
        ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        workspace: source,
      },
      savedAt: NOW,
      raw: 'raw',
      currentWorkspace: null,
      epoch: 1,
      now: NOW,
    })
    expect(budgetMismatch.ok).toBe(false)
    expect(budgetMismatch.ok ? '' : budgetMismatch.reason).toBe('budget_mismatch')
  })

  it('合成预览：v2 ready 同时返回草稿/预算 base 与整体 workspace；v1 no_workspace', () => {
    const source = makeWorkspace()
    setSessionResumeFlag(window.localStorage, true)
    const write = writeSessionResume({ payload: payloadFor(source), expectedRaw: null }, window.localStorage)
    expect(write.ok).toBe(true)
    const load = pendingLoad()
    // 旧入口不能只恢复 Trip / 草稿 / 预算而把 sidecar 留在旧状态
    expect(previewSessionResume(load.record, 5).ok).toBe(false)

    const before = JSON.stringify(structuredClone(source))
    const ready = previewSessionResumeWithWorkspace({
      load,
      currentWorkspace: null,
      epoch: 3,
      tripRevision: 4,
      now: NOW,
    })
    expect(ready.ok && ready.status === 'ready').toBe(true)
    if (!ready.ok || ready.status !== 'ready') return
    expect(ready.base.budget.owner?.revision).toBe(5)
    expect(ready.workspace.record.trip).toEqual(source.trip)
    expect(ready.workspace.record.workspaceRevision).toBe(1)
    expect(JSON.stringify(structuredClone(source))).toBe(before)

    // v1 同样合成预览 → no_workspace，base 仍可恢复
    const v1Payload: SessionResumePayload = {
      trip: MOCK_TRIP,
      draft: null,
      budget: null,
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
    }
    const v1Write = writeSessionResume(
      {
        payload: v1Payload,
        expectedRaw: window.localStorage.getItem(SESSION_RESUME_DATA_KEY),
        allowWorkspaceDrop: true,
      },
      window.localStorage,
    )
    expect(v1Write.ok).toBe(true)
    const v1Load = pendingLoad()
    const noWorkspace = previewSessionResumeWithWorkspace({
      load: v1Load,
      currentWorkspace: source,
      epoch: 3,
      tripRevision: 4,
      now: NOW,
    })
    expect(noWorkspace.ok && noWorkspace.status === 'no_workspace').toBe(true)
    if (!noWorkspace.ok || noWorkspace.status !== 'no_workspace') return
    expect(noWorkspace.workspace).toBeNull()
    expect(noWorkspace.base.ok).toBe(true)
  })

  it('buildPayloadFromSession 传入已应用 workspace：Trip/预算一致才产出，v1 不自动生成', () => {
    const source = makeWorkspace()
    const withWorkspace = buildPayloadFromSession({
      trip: source.trip,
      draft: null,
      budget: {
        owner: { tripId: source.tripId, revision: 3, tripSnapshot: JSON.stringify(source.trip), tripTitle: source.trip.title },
        rows: source.budget!.rows,
        budgetRaw: source.budget!.budgetRaw,
        result: null,
        undo: null,
      },
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 3,
      workspace: source,
    })
    expect(withWorkspace).not.toBeNull()
    expect(withWorkspace?.workspace?.workspaceId).toBe(source.workspaceId)

    const noWorkspace = buildPayloadFromSession({
      trip: MOCK_TRIP,
      draft: null,
      budget: emptyBudgetSession(),
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      tripRevision: 1,
    })
    expect(noWorkspace?.workspace).toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOCK_TRIP } from './fixtures/trip'
import type { Trip } from '../lib/api'
import {
  CANDIDATES_FORMAT,
  CANDIDATES_STORAGE_KEY,
  CANDIDATES_VERSION,
  VERSIONS_FORMAT,
  VERSIONS_STORAGE_KEY,
  VERSIONS_VERSION,
  WORKSPACE_FORMAT,
  WORKSPACE_STORAGE_KEY,
  type CandidateItemV1,
  type CandidatesRecordV1,
  type ApplyLinkV1,
  type ChecklistItemV1,
  type VersionSnapshotV1,
  type VersionsRecordV1,
  type WorkspaceRecordV1,
  type WorkspaceValidationResult,
} from '../lib/workspace'
import {
  CANDIDATES_STORAGE_LOCK_NAME,
  VERSIONS_STORAGE_LOCK_NAME,
  WORKSPACE_STORAGE_LOCK_NAME,
  getWorkspaceLocalStorage,
  getLibraryGeneration,
  loadCandidatesRecord,
  loadVersionsRecord,
  loadWorkspaceRecord,
  saveCandidatesRecord,
  saveVersionsRecord,
  saveWorkspaceRecord,
  type WorkspaceLockManager,
  type WorkspaceStorageLike,
} from '../lib/workspaceStorage'
import {
  commitWorkspaceTransition,
  createCandidatesRecord,
  createVersionsRecord,
  createWorkspaceRecord,
  emptyBudgetSnapshot,
  emptySidecar,
} from '../lib/workspace'
import { fingerprintOf } from '../lib/workspaceFingerprint'
import { SESSION_RESUME_DATA_KEY } from '../lib/sessionRestore'

const NOW = 1_760_000_000_000

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function expectOk<T>(result: WorkspaceValidationResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`${result.path}: ${result.message}`)
  return result.value
}

function canonical(value: unknown): string {
  const result = fingerprintOf(value)
  if (!result.ok) throw new Error(result.message)
  return result.fingerprint.canonical
}

function makeTrip(): Trip {
  return clone(MOCK_TRIP)
}

function makeRecord(overrides: Partial<WorkspaceRecordV1> = {}): WorkspaceRecordV1 {
  const record = expectOk(
    createWorkspaceRecord({
      workspaceId: 'workspace-1',
      ownerId: 'owner-1',
      trip: makeTrip(),
      workspaceRevision: 0,
      now: NOW,
      sidecar: emptySidecar(),
      budget: null,
      label: '测试工作区',
    }),
  )
  return { ...record, ...overrides }
}

function makeCandidate(overrides: Partial<CandidateItemV1> = {}): CandidateItemV1 {
  return {
    id: 'candidate-1',
    name: '灵隐寺',
    address: null,
    notes: null,
    tags: ['西湖'],
    priority: 1,
    location: null,
    source: 'manual',
    copiedFromStopId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeCandidatesRecord(items: CandidateItemV1[] = [makeCandidate()]): CandidatesRecordV1 {
  return expectOk(createCandidatesRecord(items, NOW))
}

function makeVersion(overrides: Partial<VersionSnapshotV1> = {}): VersionSnapshotV1 {
  return {
    id: 'version-1',
    name: '方案 A',
    createdAt: NOW,
    workspaceRevision: 0,
    trip: makeTrip(),
    sidecar: emptySidecar(),
    budget: null,
    ...overrides,
  }
}

function makeVersionsRecord(items: VersionSnapshotV1[] = [makeVersion()]): VersionsRecordV1 {
  return expectOk(createVersionsRecord(items, NOW))
}

class MemoryStorage implements WorkspaceStorageLike {
  readonly data = new Map<string, string>()
  readonly calls: { op: 'get' | 'set' | 'remove'; key: string }[] = []
  getError: unknown = null
  setError: unknown = null
  removeError: unknown = null

  getItem(key: string): string | null {
    this.calls.push({ op: 'get', key })
    if (this.getError) throw this.getError
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.calls.push({ op: 'set', key })
    if (this.setError) throw this.setError
    this.data.set(key, value)
  }

  removeItem(key: string): void {
    this.calls.push({ op: 'remove', key })
    if (this.removeError) throw this.removeError
    this.data.delete(key)
  }

  clearCalls(): void {
    this.calls.length = 0
  }

  keysFor(op: 'get' | 'set' | 'remove'): string[] {
    return this.calls.filter((call) => call.op === op).map((call) => call.key)
  }
}

class MemoryLocks implements WorkspaceLockManager {
  readonly names: string[] = []
  readonly modes: string[] = []
  active = 0
  maxActive = 0

  async request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T> | T,
  ): Promise<T> {
    this.names.push(name)
    this.modes.push(options.mode)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      return await callback()
    } finally {
      this.active -= 1
    }
  }
}

/** 模拟真实 Web Locks 的按名字串行；用于跨 module 实例（模拟两个 tab）测试。 */
class SerialLocks implements WorkspaceLockManager {
  readonly names: string[] = []
  private readonly tails = new Map<string, Promise<void>>()

  async request<T>(
    name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<T> | T,
  ): Promise<T> {
    this.names.push(name)
    const previous = this.tails.get(name) ?? Promise.resolve()
    const run = previous.then(() => callback())
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(name, tail)
    return run
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('workspace read status', () => {
  it('distinguishes missing key, empty string and a valid full record', () => {
    const storage = new MemoryStorage()
    expect(loadWorkspaceRecord(storage).status).toBe('empty')

    storage.setItem(WORKSPACE_STORAGE_KEY, '   ')
    const blank = loadWorkspaceRecord(storage)
    expect(blank.status).toBe('empty')
    expect(blank.raw).toBe('   ')

    const record = makeRecord()
    const raw = JSON.stringify(record)
    storage.setItem(WORKSPACE_STORAGE_KEY, raw)
    const loaded = loadWorkspaceRecord(storage)
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') throw new Error('expected ok')
    expect(loaded.record).toEqual(record)
    expect(loaded.raw).toBe(raw)
    expect(loaded.bytes).toBe(new TextEncoder().encode(raw).byteLength)
  })

  it('reports unavailable without throwing when storage is absent or the getter throws', () => {
    expect(loadWorkspaceRecord(null).status).toBe('unavailable')
    expect(loadCandidatesRecord(null).status).toBe('unavailable')
    expect(loadVersionsRecord(null).status).toBe('unavailable')

    const storage = new MemoryStorage()
    storage.getError = new DOMException('denied', 'SecurityError')
    expect(loadWorkspaceRecord(storage).status).toBe('unavailable')
    expect(loadCandidatesRecord(storage).status).toBe('unavailable')
    expect(loadVersionsRecord(storage).status).toBe('unavailable')
  })

  it('keeps corrupt and unknown-version bytes while reporting the right status', () => {
    const storage = new MemoryStorage()
    storage.setItem(WORKSPACE_STORAGE_KEY, '{not-json')
    const corrupt = loadWorkspaceRecord(storage)
    expect(corrupt.status).toBe('corrupt')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe('{not-json')

    const record = makeRecord()
    const unknown = JSON.stringify({ ...record, version: 2 })
    storage.setItem(WORKSPACE_STORAGE_KEY, unknown)
    const unknownRead = loadWorkspaceRecord(storage)
    expect(unknownRead.status).toBe('unknown_version')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(unknown)

    const candidateUnknown = JSON.stringify({ ...makeCandidatesRecord(), version: 2 })
    storage.setItem(CANDIDATES_STORAGE_KEY, candidateUnknown)
    expect(loadCandidatesRecord(storage).status).toBe('unknown_version')
    expect(storage.data.get(CANDIDATES_STORAGE_KEY)).toBe(candidateUnknown)

    const versionUnknown = JSON.stringify({ ...makeVersionsRecord(), version: 2 })
    storage.setItem(VERSIONS_STORAGE_KEY, versionUnknown)
    expect(loadVersionsRecord(storage).status).toBe('unknown_version')
    expect(storage.data.get(VERSIONS_STORAGE_KEY)).toBe(versionUnknown)
  })

  it('marks candidate and version libraries anomaly when any internal entry is invalid', () => {
    const storage = new MemoryStorage()
    const candidates = makeCandidatesRecord()
    const brokenCandidates = clone(candidates) as CandidatesRecordV1
    brokenCandidates.items[0].name = ''
    const candidateRaw = JSON.stringify(brokenCandidates)
    storage.setItem(CANDIDATES_STORAGE_KEY, candidateRaw)
    expect(loadCandidatesRecord(storage).status).toBe('anomaly')
    expect(storage.data.get(CANDIDATES_STORAGE_KEY)).toBe(candidateRaw)

    const versions = makeVersionsRecord()
    const brokenVersions = clone(versions) as VersionsRecordV1
    brokenVersions.items[0].name = ''
    const versionRaw = JSON.stringify(brokenVersions)
    storage.setItem(VERSIONS_STORAGE_KEY, versionRaw)
    expect(loadVersionsRecord(storage).status).toBe('anomaly')
    expect(storage.data.get(VERSIONS_STORAGE_KEY)).toBe(versionRaw)
  })

  it('salvages only a damaged checklist for read-only display and never writes the empty list back', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const record = makeRecord()
    const broken = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
    const sidecar = broken.sidecar as Record<string, unknown>
    sidecar.checklist = { items: [{ id: '', category: 'not-a-category' }], appliedTemplates: [] }
    const raw = JSON.stringify(broken)
    storage.setItem(WORKSPACE_STORAGE_KEY, raw)

    const loaded = loadWorkspaceRecord(storage)
    expect(loaded.status).toBe('anomaly')
    if (loaded.status !== 'anomaly') throw new Error('expected anomaly')
    expect(loaded.salvage?.checklistDamaged).toBe(true)
    expect(loaded.salvage?.record.sidecar.checklist.items).toEqual([])
    expect(loaded.raw).toBe(raw)

    const result = await saveWorkspaceRecord(record, {
      storage,
      locks,
      expectedRaw: raw,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.reason).toBe('anomaly')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(raw)
  })

  it('does not treat a broken anchors or constraints section as salvage', () => {
    const storage = new MemoryStorage()
    const record = makeRecord()
    const broken = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
    const sidecar = broken.sidecar as Record<string, unknown>
    sidecar.anchors = { accommodation: 'nope' }
    storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(broken))
    const loaded = loadWorkspaceRecord(storage)
    expect(loaded.status).toBe('anomaly')
    if (loaded.status !== 'anomaly') throw new Error('expected anomaly')
    expect(loaded.salvage).toBeNull()
  })
})

describe('workspace explicit save', () => {
  it('reports saved only after one successful setItem and enforces revision current + 1', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const initial = makeRecord()
    const first = await saveWorkspaceRecord(initial, {
      storage,
      locks,
      expectedRaw: null,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.message)
    expect(storage.keysFor('set')).toEqual([WORKSPACE_STORAGE_KEY])
    expect(first.raw).toBe(JSON.stringify(initial))

    const next = expectOk(
      commitWorkspaceTransition(initial, { label: '第二版' }, NOW + 1),
    )
    const second = await saveWorkspaceRecord(next, {
      storage,
      locks,
      expectedRaw: first.raw,
      expectedBaseCanonical: canonical(initial),
    })
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error(second.message)
    expect(second.record.workspaceRevision).toBe(1)
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(second.raw)
    expect(locks.names).toEqual([WORKSPACE_STORAGE_LOCK_NAME, WORKSPACE_STORAGE_LOCK_NAME])
    expect(locks.modes).toEqual(['exclusive', 'exclusive'])
  })

  it('rejects stale raw, changed base canonical, same-revision changes and owner changes; allows monotonic skips', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const initial = makeRecord()
    const first = await saveWorkspaceRecord(initial, { storage, locks, expectedRaw: null })
    if (!first.ok) throw new Error(first.message)

    const stale = await saveWorkspaceRecord(
      expectOk(commitWorkspaceTransition(initial, {}, NOW + 1)),
      { storage, locks, expectedRaw: 'stale-raw' },
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) throw new Error('expected stale failure')
    expect(stale.reason).toBe('conflict')

    const changedBase = await saveWorkspaceRecord(
      expectOk(commitWorkspaceTransition(initial, {}, NOW + 1)),
      { storage, locks, expectedRaw: first.raw, expectedBaseCanonical: 'not-the-base' },
    )
    expect(changedBase.ok).toBe(false)
    if (changedBase.ok) throw new Error('expected base failure')
    expect(changedBase.reason).toBe('conflict')

    const sameRevision = await saveWorkspaceRecord(
      expectOk(commitWorkspaceTransition(initial, {}, NOW + 1)),
      { storage, locks, expectedRaw: first.raw, expectedBaseCanonical: canonical(initial) },
    )
    expect(sameRevision.ok).toBe(true)

    const currentRaw = storage.data.get(WORKSPACE_STORAGE_KEY) ?? ''
    // 同 revision 但内容不同（updatedAt 变了）→ 仍然拒绝；同字节才幂等。
    const equalRevision = await saveWorkspaceRecord(
      { ...initial, workspaceRevision: 1, updatedAt: NOW + 2 },
      { storage, locks, expectedRaw: currentRaw },
    )
    expect(equalRevision.ok).toBe(false)
    if (equalRevision.ok) throw new Error('expected equal revision failure')
    expect(equalRevision.reason).toBe('revision_conflict')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(currentRaw)

    // 同 payload 幂等：字节完全一致（identity + revision + updatedAt 都相同）→ 直接 saved。
    const persisted = JSON.parse(currentRaw) as WorkspaceRecordV1
    storage.clearCalls()
    const idempotent = await saveWorkspaceRecord(persisted, {
      storage,
      locks,
      expectedRaw: currentRaw,
    })
    expect(idempotent.ok).toBe(true)
    if (!idempotent.ok) throw new Error(idempotent.message)
    expect(idempotent.raw).toBe(currentRaw)
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(currentRaw)
    // 幂等成功不得产生第二次 setItem，也不推进 generation。
    expect(storage.keysFor('set')).toEqual([])

    // revision 倒退 → 拒绝。
    const regression = await saveWorkspaceRecord(
      { ...initial, workspaceRevision: 0, updatedAt: NOW + 2 },
      { storage, locks, expectedRaw: currentRaw },
    )
    expect(regression.ok).toBe(false)
    if (regression.ok) throw new Error('expected regression failure')
    expect(regression.reason).toBe('revision_conflict')

    // 跳号（rev 3）也是合法单调：新 revision > 持久值即可（多次内存 transition 后保存）。
    const skipped = await saveWorkspaceRecord(
      { ...initial, workspaceRevision: 3, updatedAt: NOW + 3 },
      { storage, locks, expectedRaw: currentRaw },
    )
    expect(skipped.ok).toBe(true)
    if (!skipped.ok) throw new Error(skipped.message)
    expect(skipped.record.workspaceRevision).toBe(3)
    const afterSkip = storage.data.get(WORKSPACE_STORAGE_KEY) ?? ''

    const ownerChange = await saveWorkspaceRecord(
      { ...initial, ownerId: 'other-owner', workspaceRevision: 4, updatedAt: NOW + 4 },
      { storage, locks, expectedRaw: afterSkip },
    )
    expect(ownerChange.ok).toBe(false)
    if (ownerChange.ok) throw new Error('expected owner failure')
    expect(ownerChange.reason).toBe('owner_conflict')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(afterSkip)
  })

  it('allows two unsaved in-memory transitions before one explicit save (P1 regression)', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const initial = makeRecord()
    const first = await saveWorkspaceRecord(initial, { storage, locks, expectedRaw: null })
    if (!first.ok) throw new Error(first.message)

    // 两次合法内存 transition（rev2、rev3，都未显式保存），再一次显式保存。
    const step1 = expectOk(commitWorkspaceTransition(initial, {}, NOW + 1))
    expect(step1.workspaceRevision).toBe(1)
    const step2 = expectOk(commitWorkspaceTransition(step1, {}, NOW + 2))
    expect(step2.workspaceRevision).toBe(2)

    const saved = await saveWorkspaceRecord(step2, {
      storage,
      locks,
      expectedRaw: first.raw,
      expectedBaseCanonical: canonical(initial),
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) throw new Error(saved.message)
    expect(saved.record.workspaceRevision).toBe(2)
    expect(saved.record.updatedAt).toBe(NOW + 2)
    expect(JSON.parse(storage.data.get(WORKSPACE_STORAGE_KEY) ?? '')).toEqual(step2)

    // 保存后重放同一 payload → 幂等 saved，不再 revision_conflict（P2 regression）。
    const replay = await saveWorkspaceRecord(step2, {
      storage,
      locks,
      expectedRaw: saved.raw,
    })
    expect(replay.ok).toBe(true)
    if (!replay.ok) throw new Error(replay.message)
    expect(replay.raw).toBe(saved.raw)
  })

  it('keeps old bytes on quota, blocked, getter and lock failures', async () => {
    const record = makeRecord()

    const quotaStorage = new MemoryStorage()
    quotaStorage.setError = new DOMException('full', 'QuotaExceededError')
    const quota = await saveWorkspaceRecord(record, {
      storage: quotaStorage,
      locks: new MemoryLocks(),
      expectedRaw: null,
    })
    expect(quota.ok).toBe(false)
    if (quota.ok) throw new Error('expected quota failure')
    expect(quota.reason).toBe('quota')
    expect(quotaStorage.data.size).toBe(0)

    const blockedStorage = new MemoryStorage()
    blockedStorage.setError = new DOMException('blocked', 'BlockedError')
    const blocked = await saveWorkspaceRecord(record, {
      storage: blockedStorage,
      locks: new MemoryLocks(),
      expectedRaw: null,
    })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) throw new Error('expected blocked failure')
    expect(blocked.reason).toBe('blocked')

    const getterStorage = new MemoryStorage()
    getterStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(record))
    getterStorage.getError = new DOMException('denied', 'SecurityError')
    const getter = await saveWorkspaceRecord(record, {
      storage: getterStorage,
      locks: new MemoryLocks(),
      expectedRaw: JSON.stringify(record),
    })
    expect(getter.ok).toBe(false)
    if (getter.ok) throw new Error('expected getter failure')
    expect(getter.reason).toBe('unavailable')

    const lockStorage = new MemoryStorage()
    const noLock = await saveWorkspaceRecord(record, {
      storage: lockStorage,
      locks: null,
      expectedRaw: null,
    })
    expect(noLock.ok).toBe(false)
    if (noLock.ok) throw new Error('expected lock failure')
    expect(noLock.reason).toBe('lock_unavailable')
    expect(lockStorage.calls).toEqual([])
  })

  it('does not poison the writer queue after a quota failure and retries cleanly', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const record = makeRecord()
    const before = getLibraryGeneration(WORKSPACE_STORAGE_KEY).generation

    storage.setError = new DOMException('full', 'QuotaExceededError')
    const failed = await saveWorkspaceRecord(record, {
      storage,
      locks,
      expectedRaw: null,
    })
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('expected quota failure')
    expect(failed.reason).toBe('quota')
    expect(storage.data.size).toBe(0)
    // 失败写入不得推进 generation，也不得留下会挡住下一次写入的队列状态。
    expect(getLibraryGeneration(WORKSPACE_STORAGE_KEY).generation).toBe(before)

    storage.setError = null
    const retried = await saveWorkspaceRecord(record, {
      storage,
      locks,
      expectedRaw: null,
    })
    expect(retried.ok).toBe(true)
    if (!retried.ok) throw new Error(retried.message)
    expect(getLibraryGeneration(WORKSPACE_STORAGE_KEY).generation).toBe(before + 1)
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(retried.raw)
  })

  it('serializes two same-page writers and lets exactly one win', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const initial = makeRecord()
    const first = await saveWorkspaceRecord(initial, { storage, locks, expectedRaw: null })
    if (!first.ok) throw new Error(first.message)

    const left = { ...initial, workspaceRevision: 1, updatedAt: NOW + 1, meta: { ...initial.meta, label: '左' } }
    const right = { ...initial, workspaceRevision: 1, updatedAt: NOW + 2, meta: { ...initial.meta, label: '右' } }
    const [a, b] = await Promise.all([
      saveWorkspaceRecord(left, { storage, locks, expectedRaw: first.raw }),
      saveWorkspaceRecord(right, { storage, locks, expectedRaw: first.raw }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const rejected = a.ok ? b : a
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('expected one conflict')
    expect(rejected.reason).toBe('conflict')
    expect(locks.maxActive).toBe(1)
    const persisted = JSON.parse(storage.data.get(WORKSPACE_STORAGE_KEY) ?? '') as WorkspaceRecordV1
    expect(persisted.workspaceRevision).toBe(1)
  })

  it('uses the same stable Web Lock name across two module instances (tab boundary)', async () => {
    const storage = new MemoryStorage()
    const locks = new SerialLocks()
    const initial = makeRecord()
    const first = await saveWorkspaceRecord(initial, { storage, locks, expectedRaw: null })
    if (!first.ok) throw new Error(first.message)
    locks.names.length = 0

    vi.resetModules()
    const tabB = await import('../lib/workspaceStorage')
    expect(tabB.WORKSPACE_STORAGE_LOCK_NAME).toBe(WORKSPACE_STORAGE_LOCK_NAME)

    const left = { ...initial, workspaceRevision: 1, updatedAt: NOW + 1, meta: { ...initial.meta, label: 'tab-a' } }
    const right = { ...initial, workspaceRevision: 1, updatedAt: NOW + 2, meta: { ...initial.meta, label: 'tab-b' } }
    const [a, b] = await Promise.all([
      saveWorkspaceRecord(left, { storage, locks, expectedRaw: first.raw }),
      tabB.saveWorkspaceRecord(right, { storage, locks, expectedRaw: first.raw }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const rejected = a.ok ? b : a
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('expected cross-tab conflict')
    expect(rejected.reason).toBe('conflict')
    expect(locks.names).toEqual([WORKSPACE_STORAGE_LOCK_NAME, WORKSPACE_STORAGE_LOCK_NAME])
    const persisted = JSON.parse(storage.data.get(WORKSPACE_STORAGE_KEY) ?? '') as WorkspaceRecordV1
    expect(persisted.workspaceRevision).toBe(1)
  })

  it('refuses a sidecar over the 512 KiB cap before writing, keeping the store empty', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const record = makeRecord()
    const sidecar = clone(emptySidecar())
    sidecar.checklist.items = Array.from(
      { length: 300 },
      (_, index): ChecklistItemV1 => ({
        id: `check-${index}`,
        category: 'todo',
        title: 'x'.repeat(200),
        done: false,
        date: null,
        day: null,
        stopId: null,
        originalStopId: null,
        notes: 'y'.repeat(1000),
        updatedAt: NOW,
      }),
    )
    sidecar.applies = Array.from(
      { length: 1000 },
      (_, index): ApplyLinkV1 => ({
        candidateId: `candidate-${index}-`.padEnd(200, 'a'),
        tripId: record.tripId,
        day: 1,
        stopId: `stop-${index}-`.padEnd(200, 'b'),
      }),
    )
    expect(new TextEncoder().encode(JSON.stringify(sidecar)).byteLength).toBeGreaterThan(512 * 1024)
    const huge = makeRecord({ sidecar })
    const result = await saveWorkspaceRecord(huge, {
      storage,
      locks,
      expectedRaw: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected too large')
    expect(result.reason).toBe('too_large')
    expect(storage.data.size).toBe(0)
    expect(storage.keysFor('set')).toEqual([])
  })

  it('refuses to write over corrupt, anomaly and unknown-version raw', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const record = makeRecord()

    storage.setItem(WORKSPACE_STORAGE_KEY, '{bad')
    const corrupt = await saveWorkspaceRecord(record, {
      storage,
      locks,
      expectedRaw: '{bad',
    })
    expect(corrupt.ok).toBe(false)
    if (corrupt.ok) throw new Error('expected corrupt')
    expect(corrupt.reason).toBe('corrupt')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe('{bad')

    const unknownRaw = JSON.stringify({ ...record, version: 2 })
    storage.setItem(WORKSPACE_STORAGE_KEY, unknownRaw)
    const unknown = await saveWorkspaceRecord(record, {
      storage,
      locks,
      expectedRaw: unknownRaw,
    })
    expect(unknown.ok).toBe(false)
    if (unknown.ok) throw new Error('expected unknown version')
    expect(unknown.reason).toBe('unknown_version')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(unknownRaw)
  })

  it('does not add storage event listeners or read session-resume content keys', async () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const storage = new MemoryStorage()
    storage.setItem(SESSION_RESUME_DATA_KEY, 'session-secret')
    storage.clearCalls()
    const locks = new MemoryLocks()
    const saved = await saveWorkspaceRecord(makeRecord(), {
      storage,
      locks,
      expectedRaw: null,
    })
    expect(saved.ok).toBe(true)
    expect(addListener.mock.calls.some((call) => call[0] === 'storage')).toBe(false)
    expect(storage.keysFor('get')).toEqual([WORKSPACE_STORAGE_KEY])
    expect(storage.keysFor('get')).not.toContain(SESSION_RESUME_DATA_KEY)
  })

  it('keeps null budget and explicit empty budget distinct across a read-back', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const initial = makeRecord({ budget: null })
    const first = await saveWorkspaceRecord(initial, { storage, locks, expectedRaw: null })
    if (!first.ok) throw new Error(first.message)
    const loadedNull = loadWorkspaceRecord(storage)
    expect(loadedNull.status).toBe('ok')
    if (loadedNull.status !== 'ok') throw new Error('expected ok')
    expect(loadedNull.record.budget).toBeNull()

    const next = expectOk(
      commitWorkspaceTransition(initial, { budget: emptyBudgetSnapshot() }, NOW + 1),
    )
    const second = await saveWorkspaceRecord(next, {
      storage,
      locks,
      expectedRaw: first.raw,
      expectedBaseCanonical: canonical(initial),
    })
    expect(second.ok).toBe(true)
    const loadedEmpty = loadWorkspaceRecord(storage)
    expect(loadedEmpty.status).toBe('ok')
    if (loadedEmpty.status !== 'ok') throw new Error('expected ok')
    expect(loadedEmpty.record.budget).toEqual(emptyBudgetSnapshot())
    expect(loadedEmpty.record.budget).not.toBeNull()
  })

  it('preserves 0 and null as different values inside the sidecar', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const sidecar = clone(emptySidecar())
    sidecar.constraints.items = [
      {
        id: 'constraint-zero',
        kind: 'reminder',
        title: '已知零分钟',
        day: null,
        stopId: null,
        startDate: null,
        endDate: null,
        startTime: null,
        endTime: null,
        durationMinutes: 0,
        notes: null,
        priority: 0,
        updatedAt: NOW,
      },
      {
        id: 'constraint-unknown',
        kind: 'reminder',
        title: '未知分钟',
        day: null,
        stopId: null,
        startDate: null,
        endDate: null,
        startTime: null,
        endTime: null,
        durationMinutes: null,
        notes: null,
        priority: 0,
        updatedAt: NOW,
      },
    ]
    const record = makeRecord({ sidecar })
    const saved = await saveWorkspaceRecord(record, { storage, locks, expectedRaw: null })
    expect(saved.ok).toBe(true)
    const loaded = loadWorkspaceRecord(storage)
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') throw new Error('expected ok')
    expect(loaded.record.sidecar.constraints.items[0].durationMinutes).toBe(0)
    expect(loaded.record.sidecar.constraints.items[1].durationMinutes).toBeNull()
    expect(loaded.record.sidecar).toEqual(sidecar)
  })
})

describe('independent candidates / versions storage', () => {
  it('writes candidates and versions without touching each other or the workspace key', async () => {
    const workspaceStorage = new MemoryStorage()
    const locks = new MemoryLocks()
    const workspace = makeRecord()
    const workspaceSave = await saveWorkspaceRecord(workspace, {
      storage: workspaceStorage,
      locks,
      expectedRaw: null,
    })
    expect(workspaceSave.ok).toBe(true)
    const workspaceRaw = workspaceStorage.data.get(WORKSPACE_STORAGE_KEY)

    const storage = new MemoryStorage()
    storage.setItem(SESSION_RESUME_DATA_KEY, 'session-content-must-not-be-read')
    storage.clearCalls()
    const candidates = makeCandidatesRecord()
    const candidateSave = await saveCandidatesRecord(candidates, {
      storage,
      locks,
      expectedRaw: null,
    })
    expect(candidateSave.ok).toBe(true)
    expect(storage.keysFor('set')).toEqual([CANDIDATES_STORAGE_KEY])
    expect(storage.data.has(WORKSPACE_STORAGE_KEY)).toBe(false)
    expect(storage.keysFor('get')).toEqual([CANDIDATES_STORAGE_KEY])

    storage.data.clear()
    storage.clearCalls()
    const versions = makeVersionsRecord()
    const versionSave = await saveVersionsRecord(versions, {
      storage,
      locks,
      expectedRaw: null,
    })
    expect(versionSave.ok).toBe(true)
    expect(storage.keysFor('set')).toEqual([VERSIONS_STORAGE_KEY])
    expect(storage.data.has(WORKSPACE_STORAGE_KEY)).toBe(false)
    expect(storage.data.has(CANDIDATES_STORAGE_KEY)).toBe(false)
    expect(storage.keysFor('get')).toEqual([VERSIONS_STORAGE_KEY])

    expect(workspaceStorage.data.get(WORKSPACE_STORAGE_KEY)).toBe(workspaceRaw)
    expect(locks.names).toEqual([
      WORKSPACE_STORAGE_LOCK_NAME,
      CANDIDATES_STORAGE_LOCK_NAME,
      VERSIONS_STORAGE_LOCK_NAME,
    ])
  })

  it('refuses candidate anomaly / count overflow and preserves original bytes', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const valid = makeCandidatesRecord()
    const broken = clone(valid) as CandidatesRecordV1
    broken.items[0].name = ''
    const raw = JSON.stringify(broken)
    storage.setItem(CANDIDATES_STORAGE_KEY, raw)

    const anomaly = await saveCandidatesRecord(valid, {
      storage,
      locks,
      expectedRaw: raw,
    })
    expect(anomaly.ok).toBe(false)
    if (anomaly.ok) throw new Error('expected anomaly')
    expect(anomaly.reason).toBe('anomaly')
    expect(storage.data.get(CANDIDATES_STORAGE_KEY)).toBe(raw)

    const tooMany: CandidatesRecordV1 = {
      ...valid,
      items: Array.from({ length: 201 }, (_, index) =>
        makeCandidate({ id: `candidate-${index}` }),
      ),
    }
    storage.data.delete(CANDIDATES_STORAGE_KEY)
    const overflow = await saveCandidatesRecord(tooMany, {
      storage,
      locks,
      expectedRaw: null,
    })
    expect(overflow.ok).toBe(false)
    expect(storage.data.has(CANDIDATES_STORAGE_KEY)).toBe(false)
  })

  it('refuses version anomaly without rewriting the library', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const valid = makeVersionsRecord()
    const broken = clone(valid) as VersionsRecordV1
    broken.items[0].name = ''
    const raw = JSON.stringify(broken)
    storage.setItem(VERSIONS_STORAGE_KEY, raw)
    const result = await saveVersionsRecord(valid, {
      storage,
      locks,
      expectedRaw: raw,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected anomaly')
    expect(result.reason).toBe('anomaly')
    expect(storage.data.get(VERSIONS_STORAGE_KEY)).toBe(raw)
  })

  it('keeps the candidate/version format constants aligned with stored records', () => {
    expect(makeCandidatesRecord().format).toBe(CANDIDATES_FORMAT)
    expect(makeCandidatesRecord().version).toBe(CANDIDATES_VERSION)
    expect(makeVersionsRecord().format).toBe(VERSIONS_FORMAT)
    expect(makeVersionsRecord().version).toBe(VERSIONS_VERSION)
    expect(makeRecord().format).toBe(WORKSPACE_FORMAT)
  })

  it('does not read localStorage when the storage module is imported', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    vi.resetModules()
    await import('../lib/workspaceStorage')
    expect(getItem).not.toHaveBeenCalled()
    expect(getWorkspaceLocalStorage()).not.toBeNull()
  })
})

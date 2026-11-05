import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOCK_TRIP } from './fixtures/trip'
import type { Trip } from '../lib/api'
import {
  WORKSPACE_STORAGE_KEY,
  CANDIDATES_STORAGE_KEY,
  VERSIONS_STORAGE_KEY,
  MAX_CANDIDATES_BACKUP_FILE_BYTES,
  MAX_WORKSPACE_BACKUP_FILE_BYTES,
  type BudgetSnapshotV1,
  type CandidateItemV1,
  type CandidatesRecordV1,
  type VersionSnapshotV1,
  type VersionsRecordV1,
  type WorkspaceRecordV1,
  type WorkspaceValidationResult,
} from '../lib/workspace'
import {
  createWorkspaceRecord,
  createCandidatesRecord,
  createVersionsRecord,
  emptyBudgetSnapshot,
  emptySidecar,
  commitWorkspaceTransition,
} from '../lib/workspace'
import {
  CANDIDATES_STORAGE_LOCK_NAME,
  VERSIONS_STORAGE_LOCK_NAME,
  WORKSPACE_STORAGE_LOCK_NAME,
  loadCandidatesRecord,
  loadVersionsRecord,
  loadWorkspaceRecord,
  preparedImportIsLive,
  saveWorkspaceRecord,
  undoStorageCommit,
  type WorkspaceLockManager,
  type WorkspaceStorageLike,
} from '../lib/workspaceStorage'
import {
  cancelPreparedImport,
  confirmCandidatesImport,
  confirmVersionsImport,
  confirmWorkspaceImport,
  createCandidatesBackupFile,
  createSessionWorkspaceBlock,
  createVersionsBackupFile,
  createWorkspaceBackupFile,
  invalidatePreparedImport,
  parseCandidatesBackupText,
  parseWorkspaceBackupText,
  prepareCandidatesImport,
  prepareVersionsImport,
  prepareWorkspaceImport,
  rehydrateWorkspaceFromSession,
} from '../lib/workspaceTransfer'
import { utf8ByteLength } from '../lib/savedTrips'

const NOW = 1_760_000_000_000

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function expectOk<T>(result: WorkspaceValidationResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`${result.path}: ${result.message}`)
  return result.value
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

function makeCandidate(id = 'candidate-1'): CandidateItemV1 {
  return {
    id,
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
  }
}

function makeCandidatesRecord(): CandidatesRecordV1 {
  return expectOk(createCandidatesRecord([makeCandidate()], NOW))
}

function makeVersion(): VersionSnapshotV1 {
  return {
    id: 'version-1',
    name: '方案 A',
    createdAt: NOW,
    workspaceRevision: 0,
    trip: makeTrip(),
    sidecar: emptySidecar(),
    budget: null,
  }
}

function makeVersionsRecord(): VersionsRecordV1 {
  return expectOk(createVersionsRecord([makeVersion()], NOW))
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
  active = 0
  maxActive = 0

  async request<T>(
    name: string,
    _options: { mode: 'exclusive' },
    callback: () => Promise<T> | T,
  ): Promise<T> {
    this.names.push(name)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      return await callback()
    } finally {
      this.active -= 1
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function seedWorkspace(
  storage: MemoryStorage,
  locks: MemoryLocks,
  record: WorkspaceRecordV1 = makeRecord(),
): Promise<{ record: WorkspaceRecordV1; raw: string }> {
  const saved = await saveWorkspaceRecord(record, {
    storage,
    locks,
    expectedRaw: null,
  })
  if (!saved.ok) throw new Error(saved.message)
  return { record: saved.record, raw: saved.raw }
}

describe('three independent backup files', () => {
  it('measures the full UTF-8 envelope, including wrapper overhead', () => {
    const record = makeRecord({ budget: emptyBudgetSnapshot() })
    const created = createWorkspaceBackupFile(record, NOW)
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.message)

    expect(created.bytes).toBe(utf8ByteLength(created.text))
    const innerBytes = utf8ByteLength(JSON.stringify(record))
    expect(created.bytes).toBeGreaterThan(innerBytes)

    const parsed = parseWorkspaceBackupText(created.text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.message)
    expect(parsed.bytes).toBe(created.bytes)
    expect(parsed.backup.workspace).toEqual(record)

    const tooTight = parseWorkspaceBackupText(created.text, { maxBytes: innerBytes })
    expect(tooTight.ok).toBe(false)
    if (tooTight.ok) throw new Error('expected wrapper overhead failure')
    expect(tooTight.reason).toBe('too_large')
  })

  it('does not mistake old Trip JSON or the saved-trip list for a workspace backup', () => {
    const oldTrip = parseWorkspaceBackupText(JSON.stringify(MOCK_TRIP))
    expect(oldTrip.ok).toBe(false)
    if (oldTrip.ok) throw new Error('expected format mismatch')
    expect(oldTrip.reason).toBe('format_mismatch')

    const savedList = parseWorkspaceBackupText(
      JSON.stringify({ version: 1, trips: [{ id: MOCK_TRIP.id, savedAt: NOW, trip: MOCK_TRIP }] }),
    )
    expect(savedList.ok).toBe(false)
    if (savedList.ok) throw new Error('expected format mismatch')
    expect(savedList.reason).toBe('format_mismatch')
  })

  it('reports parse, version and UTF-8 byte-limit failures without touching storage', () => {
    const storage = new MemoryStorage()
    const record = makeRecord()
    const created = createWorkspaceBackupFile(record, NOW)
    if (!created.ok) throw new Error(created.message)

    expect(parseWorkspaceBackupText('not json').ok).toBe(false)
    const wrongVersion = parseWorkspaceBackupText(
      JSON.stringify({ ...created.backup, version: 2 }),
    )
    expect(wrongVersion.ok).toBe(false)
    if (wrongVersion.ok) throw new Error('expected version mismatch')
    expect(wrongVersion.reason).toBe('version_mismatch')

    const bytes = utf8ByteLength(created.text)
    expect(bytes).toBeGreaterThan(created.text.length)
    const utf8Limited = parseWorkspaceBackupText(created.text, {
      maxBytes: created.text.length,
    })
    expect(utf8Limited.ok).toBe(false)
    if (utf8Limited.ok) throw new Error('expected UTF-8 limit failure')
    expect(utf8Limited.reason).toBe('too_large')

    expect(parseWorkspaceBackupText(created.text, { maxBytes: 0 }).ok).toBe(false)
    expect(
      parseWorkspaceBackupText(created.text, { maxBytes: MAX_WORKSPACE_BACKUP_FILE_BYTES + 1 }).ok,
    ).toBe(false)
    expect(storage.calls).toEqual([])
  })

  it('enforces the candidates file cap on the actual raw text before parsing', () => {
    const oversized = ' '.repeat(MAX_CANDIDATES_BACKUP_FILE_BYTES + 1)
    const parsed = parseCandidatesBackupText(oversized)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected too large')
    expect(parsed.reason).toBe('too_large')
  })
})

describe('workspace import preview / confirm / undo', () => {
  it('previews without writing, confirms with revision current + 1, then undoes exactly once', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    storage.clearCalls()
    const prepared = prepareWorkspaceImport(backup.text, { storage, locks })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.message)
    expect(prepared.previousRaw).toBe(seeded.raw)
    expect(prepared.previousRevision).toBe(0)
    expect(prepared.nextRevision).toBe(1)
    expect(prepared.writeReady).toBe(true)
    expect(storage.keysFor('set')).toEqual([])
    expect(loadWorkspaceRecord(storage).status).toBe('ok')

    const confirmed = await confirmWorkspaceImport(prepared, {
      storage,
      locks,
      now: NOW + 10,
    })
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) throw new Error(confirmed.message)
    expect(confirmed.record.workspaceRevision).toBe(1)
    expect(confirmed.record.updatedAt).toBe(NOW + 10)
    expect(confirmed.record.trip).toEqual(seeded.record.trip)
    expect(storage.keysFor('set')).toEqual([WORKSPACE_STORAGE_KEY])
    expect(locks.names).toContain(WORKSPACE_STORAGE_LOCK_NAME)

    const undone = await undoStorageCommit(confirmed.undo, {
      storage,
      locks,
      now: NOW + 20,
    })
    expect(undone.ok).toBe(true)
    if (!undone.ok) throw new Error(undone.message)
    expect(undone.restoredRaw).toBe(seeded.raw)
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(seeded.raw)

    const again = await undoStorageCommit(confirmed.undo, {
      storage,
      locks,
      now: NOW + 30,
    })
    expect(again.ok).toBe(false)
    if (again.ok) throw new Error('expected one-shot undo')
    expect(again.reason).toBe('undo_used')
  })

  it('cancels a preview and rejects confirming it; repeated confirm is also rejected', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    const canceled = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!canceled.ok) throw new Error(canceled.message)
    expect(cancelPreparedImport(canceled).ok).toBe(true)
    storage.clearCalls()
    const afterCancel = await confirmWorkspaceImport(canceled, {
      storage,
      locks,
      now: NOW + 10,
    })
    expect(afterCancel.ok).toBe(false)
    if (afterCancel.ok) throw new Error('expected canceled')
    expect(afterCancel.reason).toBe('import_cancelled')
    expect(storage.keysFor('set')).toEqual([])

    const second = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!second.ok) throw new Error(second.message)
    const firstConfirm = await confirmWorkspaceImport(second, {
      storage,
      locks,
      now: NOW + 11,
    })
    expect(firstConfirm.ok).toBe(true)
    const repeat = await confirmWorkspaceImport(second, {
      storage,
      locks,
      now: NOW + 12,
    })
    expect(repeat.ok).toBe(false)
    if (repeat.ok) throw new Error('expected repeated confirm failure')
    expect(repeat.reason).toBe('import_already_confirmed')
  })

  it('rejects confirm when another tab changed the raw after preview', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    const prepared = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!prepared.ok) throw new Error(prepared.message)

    const external = expectOk(commitWorkspaceTransition(seeded.record, {}, NOW + 50))
    const externalRaw = JSON.stringify(external)
    storage.setItem(WORKSPACE_STORAGE_KEY, externalRaw)
    storage.clearCalls()

    const confirmed = await confirmWorkspaceImport(prepared, {
      storage,
      locks,
      now: NOW + 60,
    })
    expect(confirmed.ok).toBe(false)
    if (confirmed.ok) throw new Error('expected conflict')
    expect(confirmed.reason).toBe('conflict')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(externalRaw)
    expect(storage.keysFor('set')).toEqual([])
  })

  it('rejects confirm when the preview input was mutated after prepare', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    const prepared = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!prepared.ok) throw new Error(prepared.message)
    prepared.importedRecord.trip.title = '被篡改的标题'
    storage.clearCalls()

    const confirmed = await confirmWorkspaceImport(prepared, {
      storage,
      locks,
      now: NOW + 60,
    })
    expect(confirmed.ok).toBe(false)
    if (confirmed.ok) throw new Error('expected input change')
    expect(confirmed.reason).toBe('input_changed')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(seeded.raw)
    expect(storage.keysFor('set')).toEqual([])
  })

  it('allows exactly one of two concurrent confirms to win', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    const [left, right] = await Promise.all([
      Promise.resolve(prepareWorkspaceImport(backup.text, { storage, locks })),
      Promise.resolve(prepareWorkspaceImport(backup.text, { storage, locks })),
    ])
    if (!left.ok) throw new Error(left.message)
    if (!right.ok) throw new Error(right.message)
    expect(left.importId).not.toBe(right.importId)
    expect(left.previousRaw).toBe(seeded.raw)
    expect(right.previousRaw).toBe(seeded.raw)

    storage.clearCalls()
    const results = await Promise.all([
      confirmWorkspaceImport(left, { storage, locks, now: NOW + 70 }),
      confirmWorkspaceImport(right, { storage, locks, now: NOW + 71 }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const failed = results.find((result) => !result.ok)
    expect(failed).toBeDefined()
    if (failed && !failed.ok) expect(failed.reason).toBe('import_superseded')
    expect(storage.keysFor('set')).toEqual([WORKSPACE_STORAGE_KEY])
    expect(locks.maxActive).toBe(1)
  })

  it('rejects a prepared import after a later write was undone back to the old raw (ABA)', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    const first = prepareWorkspaceImport(backup.text, { storage, locks })
    const second = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!first.ok) throw new Error(first.message)
    if (!second.ok) throw new Error(second.message)

    const confirmed = await confirmWorkspaceImport(first, {
      storage,
      locks,
      now: NOW + 10,
    })
    if (!confirmed.ok) throw new Error(confirmed.message)
    const undone = await undoStorageCommit(confirmed.undo, {
      storage,
      locks,
      now: NOW + 20,
    })
    expect(undone.ok).toBe(true)
    // 写后撤销把持久 raw 完整恢复成 prepare 时的旧值：raw 比较已看不出变化，
    // 但同页 generation 已推进两次，旧 prepared 句柄必须失效，不能复活。
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(seeded.raw)

    storage.clearCalls()
    const resurrect = await confirmWorkspaceImport(second, {
      storage,
      locks,
      now: NOW + 30,
    })
    expect(resurrect.ok).toBe(false)
    if (resurrect.ok) throw new Error('expected superseded prepared handle')
    expect(resurrect.reason).toBe('import_superseded')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(seeded.raw)
    expect(storage.keysFor('set')).toEqual([])
  })

  it('does not let a late undo overwrite a later local import', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    const first = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!first.ok) throw new Error(first.message)
    const firstConfirmed = await confirmWorkspaceImport(first, {
      storage,
      locks,
      now: NOW + 10,
    })
    if (!firstConfirmed.ok) throw new Error(firstConfirmed.message)

    const second = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!second.ok) throw new Error(second.message)
    const secondConfirmed = await confirmWorkspaceImport(second, {
      storage,
      locks,
      now: NOW + 20,
    })
    if (!secondConfirmed.ok) throw new Error(secondConfirmed.message)
    const currentRaw = storage.data.get(WORKSPACE_STORAGE_KEY)
    expect(currentRaw).toBe(secondConfirmed.raw)

    const late = await undoStorageCommit(firstConfirmed.undo, {
      storage,
      locks,
      now: NOW + 30,
    })
    expect(late.ok).toBe(false)
    if (late.ok) throw new Error('expected superseded undo')
    expect(late.reason).toBe('import_superseded')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(currentRaw)
  })

  it('invalidates a prepared handle explicitly without writing', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    const prepared = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!prepared.ok) throw new Error(prepared.message)
    expect(preparedImportIsLive(prepared)).toBe(true)
    const invalidated = invalidatePreparedImport(prepared)
    expect(invalidated.ok).toBe(true)
    expect(preparedImportIsLive(prepared)).toBe(false)

    storage.clearCalls()
    const confirmed = await confirmWorkspaceImport(prepared, {
      storage,
      locks,
      now: NOW + 10,
    })
    expect(confirmed.ok).toBe(false)
    if (confirmed.ok) throw new Error('expected invalidated handle')
    expect(confirmed.reason).toBe('import_superseded')
    expect(storage.keysFor('set')).toEqual([])
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(seeded.raw)
  })

  it('rejects undo after another tab update or after the undo window', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    const prepared = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!prepared.ok) throw new Error(prepared.message)
    const confirmed = await confirmWorkspaceImport(prepared, {
      storage,
      locks,
      now: NOW + 100,
      undoTtlMs: 1000,
    })
    if (!confirmed.ok) throw new Error(confirmed.message)

    const expired = await undoStorageCommit(confirmed.undo, {
      storage,
      locks,
      now: NOW + 1200,
    })
    expect(expired.ok).toBe(false)
    if (expired.ok) throw new Error('expected expiry')
    expect(expired.reason).toBe('undo_expired')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(confirmed.raw)

    const secondPrepared = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!secondPrepared.ok) throw new Error(secondPrepared.message)
    const secondConfirmed = await confirmWorkspaceImport(secondPrepared, {
      storage,
      locks,
      now: NOW + 1300,
      undoTtlMs: 10_000,
    })
    if (!secondConfirmed.ok) throw new Error(secondConfirmed.message)

    const external = expectOk(commitWorkspaceTransition(secondConfirmed.record, {}, NOW + 1350))
    const externalRaw = JSON.stringify(external)
    storage.setItem(WORKSPACE_STORAGE_KEY, externalRaw)
    const conflict = await undoStorageCommit(secondConfirmed.undo, {
      storage,
      locks,
      now: NOW + 1400,
    })
    expect(conflict.ok).toBe(false)
    if (conflict.ok) throw new Error('expected conflict')
    expect(conflict.reason).toBe('conflict')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(externalRaw)
  })

  it('restores an empty key with removeItem and retries after a removeItem failure', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const record = makeRecord()
    const backup = createWorkspaceBackupFile(record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    const prepared = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!prepared.ok) throw new Error(prepared.message)
    const confirmed = await confirmWorkspaceImport(prepared, {
      storage,
      locks,
      now: NOW + 10,
    })
    if (!confirmed.ok) throw new Error(confirmed.message)
    expect(confirmed.record.workspaceRevision).toBe(1)

    storage.removeError = new DOMException('denied', 'SecurityError')
    const failed = await undoStorageCommit(confirmed.undo, {
      storage,
      locks,
      now: NOW + 20,
    })
    expect(failed.ok).toBe(false)
    if (failed.ok) throw new Error('expected remove failure')
    expect(failed.reason).toBe('unavailable')
    expect(storage.data.has(WORKSPACE_STORAGE_KEY)).toBe(true)

    storage.removeError = null
    const retried = await undoStorageCommit(confirmed.undo, {
      storage,
      locks,
      now: NOW + 21,
    })
    expect(retried.ok).toBe(true)
    if (!retried.ok) throw new Error(retried.message)
    expect(retried.restoredRaw).toBeNull()
    expect(storage.data.has(WORKSPACE_STORAGE_KEY)).toBe(false)
  })

  it('refuses to prepare over corrupt source bytes and does not read another library', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const record = makeRecord()
    const backup = createWorkspaceBackupFile(record, NOW)
    if (!backup.ok) throw new Error(backup.message)

    storage.setItem(WORKSPACE_STORAGE_KEY, '{corrupt')
    storage.clearCalls()
    const prepared = prepareWorkspaceImport(backup.text, { storage, locks })
    expect(prepared.ok).toBe(false)
    if (prepared.ok) throw new Error('expected source blocked')
    expect(prepared.reason).toBe('source_store_blocked')
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe('{corrupt')
    expect(storage.keysFor('get')).toEqual([WORKSPACE_STORAGE_KEY])
  })

  it('refuses confirm without a lock manager but keeps the preview readable', async () => {
    const storage = new MemoryStorage()
    const record = makeRecord()
    const backup = createWorkspaceBackupFile(record, NOW)
    if (!backup.ok) throw new Error(backup.message)
    const prepared = prepareWorkspaceImport(backup.text, { storage, locks: null })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.message)
    expect(prepared.writeReady).toBe(false)

    storage.clearCalls()
    const refused = await confirmWorkspaceImport(prepared, {
      storage,
      locks: null,
      now: NOW + 10,
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected lock refusal')
    expect(refused.reason).toBe('lock_unavailable')
    expect(storage.keysFor('set')).toEqual([])

    const locks = new MemoryLocks()
    const accepted = await confirmWorkspaceImport(prepared, {
      storage,
      locks,
      now: NOW + 11,
    })
    expect(accepted.ok).toBe(true)
  })

  it('does not register storage events and does not read candidates/versions/session keys', async () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const seeded = await seedWorkspace(storage, locks)
    const backup = createWorkspaceBackupFile(seeded.record, NOW)
    if (!backup.ok) throw new Error(backup.message)
    const prepared = prepareWorkspaceImport(backup.text, { storage, locks })
    if (!prepared.ok) throw new Error(prepared.message)

    const before = addListener.mock.calls.filter((call) => call[0] === 'storage').length
    storage.clearCalls()
    const confirmed = await confirmWorkspaceImport(prepared, {
      storage,
      locks,
      now: NOW + 10,
    })
    if (!confirmed.ok) throw new Error(confirmed.message)
    await undoStorageCommit(confirmed.undo, { storage, locks, now: NOW + 20 })
    const after = addListener.mock.calls.filter((call) => call[0] === 'storage').length
    expect(after).toBe(before)
    for (const key of storage.calls.map((call) => call.key)) {
      expect([WORKSPACE_STORAGE_KEY, CANDIDATES_STORAGE_KEY, VERSIONS_STORAGE_KEY]).toContain(key)
      expect(key).not.toContain('session-resume')
    }
    expect(storage.keysFor('set')).toEqual([WORKSPACE_STORAGE_KEY, WORKSPACE_STORAGE_KEY])
  })
})

describe('independent candidates / versions import', () => {
  it('confirms and undoes a candidates import without touching workspace or versions', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const workspaceSeeded = await seedWorkspace(storage, locks)
    const candidates = makeCandidatesRecord()
    const backup = createCandidatesBackupFile(candidates, NOW)
    if (!backup.ok) throw new Error(backup.message)

    storage.clearCalls()
    const prepared = prepareCandidatesImport(backup.text, { storage, locks })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.message)
    expect(prepared.previousStatus).toBe('empty')
    expect(storage.keysFor('set')).toEqual([])

    const confirmed = await confirmCandidatesImport(prepared, {
      storage,
      locks,
      now: NOW + 10,
    })
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) throw new Error(confirmed.message)
    expect(storage.keysFor('set')).toEqual([CANDIDATES_STORAGE_KEY])
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(workspaceSeeded.raw)
    expect(storage.data.has(VERSIONS_STORAGE_KEY)).toBe(false)
    expect(loadCandidatesRecord(storage).status).toBe('ok')
    expect(locks.names).toContain(CANDIDATES_STORAGE_LOCK_NAME)

    const undone = await undoStorageCommit(confirmed.undo, {
      storage,
      locks,
      now: NOW + 20,
    })
    expect(undone.ok).toBe(true)
    expect(storage.data.has(CANDIDATES_STORAGE_KEY)).toBe(false)
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(workspaceSeeded.raw)
  })

  it('confirms and undoes a versions import without touching workspace or candidates', async () => {
    const storage = new MemoryStorage()
    const locks = new MemoryLocks()
    const workspaceSeeded = await seedWorkspace(storage, locks)
    const versions = makeVersionsRecord()
    const backup = createVersionsBackupFile(versions, NOW)
    if (!backup.ok) throw new Error(backup.message)

    storage.clearCalls()
    const prepared = prepareVersionsImport(backup.text, { storage, locks })
    if (!prepared.ok) throw new Error(prepared.message)
    const confirmed = await confirmVersionsImport(prepared, {
      storage,
      locks,
      now: NOW + 10,
    })
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) throw new Error(confirmed.message)
    expect(storage.keysFor('set')).toEqual([VERSIONS_STORAGE_KEY])
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(workspaceSeeded.raw)
    expect(storage.data.has(CANDIDATES_STORAGE_KEY)).toBe(false)
    expect(loadVersionsRecord(storage).status).toBe('ok')
    expect(locks.names).toContain(VERSIONS_STORAGE_LOCK_NAME)

    const undone = await undoStorageCommit(confirmed.undo, {
      storage,
      locks,
      now: NOW + 20,
    })
    expect(undone.ok).toBe(true)
    expect(storage.data.has(VERSIONS_STORAGE_KEY)).toBe(false)
    expect(storage.data.get(WORKSPACE_STORAGE_KEY)).toBe(workspaceSeeded.raw)
  })

  it('rejects a workspace backup as a candidates backup and vice versa', () => {
    const workspaceBackup = createWorkspaceBackupFile(makeRecord(), NOW)
    if (!workspaceBackup.ok) throw new Error(workspaceBackup.message)
    expect(parseCandidatesBackupText(workspaceBackup.text).ok).toBe(false)

    const candidatesBackup = createCandidatesBackupFile(makeCandidatesRecord(), NOW)
    if (!candidatesBackup.ok) throw new Error(candidatesBackup.message)
    const wrong = parseWorkspaceBackupText(candidatesBackup.text)
    expect(wrong.ok).toBe(false)
    if (wrong.ok) throw new Error('expected format mismatch')
    expect(wrong.reason).toBe('format_mismatch')

    const versionsBackup = createVersionsBackupFile(makeVersionsRecord(), NOW)
    if (!versionsBackup.ok) throw new Error(versionsBackup.message)
    const wrongVersions = parseCandidatesBackupText(versionsBackup.text)
    expect(wrongVersions.ok).toBe(false)
    if (wrongVersions.ok) throw new Error('expected format mismatch')
    expect(wrongVersions.reason).toBe('format_mismatch')
  })
})

describe('session v2 workspace block adapter', () => {
  it('projects a full record into the v2 block and rehydrates it without storage access', () => {
    const storage = new MemoryStorage()
    const record = makeRecord({ budget: emptyBudgetSnapshot() })
    const block = expectOk(createSessionWorkspaceBlock(record))
    expect(block.workspaceId).toBe(record.workspaceId)
    expect(block.ownerId).toBe(record.ownerId)
    expect(block.workspaceRevision).toBe(record.workspaceRevision)
    expect(block.sidecar).toEqual(record.sidecar)
    expect(block.meta).toEqual(record.meta)
    expect(Object.keys(block).sort()).toEqual(
      ['workspaceId', 'ownerId', 'workspaceRevision', 'updatedAt', 'sidecar', 'meta'].sort(),
    )

    const rehydrated = rehydrateWorkspaceFromSession({
      trip: record.trip,
      budget: record.budget,
      workspace: block,
    })
    expect(rehydrated.ok).toBe(true)
    if (!rehydrated.ok) throw new Error(rehydrated.message)
    expect(rehydrated.value).toEqual(record)
    expect(storage.calls).toEqual([])
  })

  it('keeps null workspace and null budget distinct from an explicit empty budget', () => {
    const record = makeRecord({ budget: null })
    const block = expectOk(createSessionWorkspaceBlock(record))

    const unassociated = rehydrateWorkspaceFromSession({
      trip: record.trip,
      budget: null,
      workspace: null,
    })
    expect(unassociated.ok).toBe(true)
    if (!unassociated.ok) throw new Error(unassociated.message)
    expect(unassociated.value).toBeNull()

    const withNull = rehydrateWorkspaceFromSession({
      trip: record.trip,
      budget: null,
      workspace: block,
    })
    if (!withNull.ok || withNull.value === null) throw new Error('expected record')
    expect(withNull.value.budget).toBeNull()

    const emptyBudget: BudgetSnapshotV1 = emptyBudgetSnapshot()
    const withEmpty = rehydrateWorkspaceFromSession({
      trip: record.trip,
      budget: emptyBudget,
      workspace: block,
    })
    if (!withEmpty.ok || withEmpty.value === null) throw new Error('expected record')
    expect(withEmpty.value.budget).toEqual(emptyBudget)
    expect(withEmpty.value.budget).not.toBeNull()
  })

  it('rejects unknown fields and a missing workspace value', () => {
    const record = makeRecord()
    const block = expectOk(createSessionWorkspaceBlock(record))
    const unknown = rehydrateWorkspaceFromSession({
      trip: record.trip,
      budget: null,
      workspace: { ...block, extra: true },
    })
    expect(unknown.ok).toBe(false)
    if (unknown.ok) throw new Error('expected unknown field')
    expect(unknown.reason).toBe('unknown_field')

    const missing = rehydrateWorkspaceFromSession({
      trip: record.trip,
      budget: null,
      workspace: undefined,
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('expected invalid field')
    expect(missing.reason).toBe('invalid_field')
  })
})

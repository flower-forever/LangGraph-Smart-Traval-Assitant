/**
 * useWorkspaceController 单元测试（W8 App 集成切片）。
 *
 * 覆盖：未关联放行 / 显式新建 / 同 id 整体 transition / 换 trip.id 解除关联、
 * 版本库显式打开与保存（await ok 才算 saved、无锁 typed 拒绝）、
 * F4 采用 → 一次撤销 → ABA 旧提案失效、版本库导入 + 一次撤销、
 * 全程不读会话恢复键与 savedTrips 键（按 key 分别断言）。
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Trip } from '../lib/api'
import { useWorkspaceController } from '../lib/useWorkspaceController'
import { emptySidecar } from '../lib/workspace'
import {
  createVersionSnapshot,
  planVersionAdopt,
  previewVersionsImport,
  type VersionAdoptProposalV1,
} from '../lib/versionSnapshots'
import { createVersionsBackupFile } from '../lib/workspaceTransfer'
import { SAVED_TRIPS_STORAGE_KEY } from '../lib/savedTrips'
import { SESSION_RESUME_DATA_KEY } from '../lib/sessionRestore'
import type {
  WorkspaceLockManager,
  WorkspaceStorageLike,
} from '../lib/workspaceStorage'
import { getLibraryGeneration } from '../lib/workspaceStorage'
import type {
  WorkspaceActionResult,
  WorkspaceTripChangeResult,
} from '../lib/useWorkspaceController'
import {
  CANDIDATES_STORAGE_KEY,
  VERSIONS_FORMAT,
  VERSIONS_VERSION,
  type BudgetSnapshotV1,
  type VersionsRecordV1,
} from '../lib/workspaceTypes'
import { MOCK_TRIP } from './fixtures/trip'

function makeStorage(): {
  storage: WorkspaceStorageLike
  map: Map<string, string>
  reads: string[]
  writes: string[]
} {
  const map = new Map<string, string>()
  const reads: string[] = []
  const writes: string[] = []
  const storage: WorkspaceStorageLike = {
    getItem(key: string): string | null {
      reads.push(key)
      return map.has(key) ? (map.get(key) as string) : null
    },
    setItem(key: string, value: string): void {
      writes.push(key)
      map.set(key, value)
    },
    removeItem(key: string): void {
      map.delete(key)
    },
  }
  return { storage, map, reads, writes }
}

function makeLocks(): WorkspaceLockManager {
  return {
    request: async <T,>(
      _name: string,
      _options: { mode: 'exclusive' },
      callback: () => Promise<T> | T,
    ): Promise<T> => await callback(),
  }
}

const tripA: Trip = MOCK_TRIP
const tripB: Trip = { ...MOCK_TRIP, summary: '修改过的行程摘要（同 id 内容变化）' }
const tripOther: Trip = { ...MOCK_TRIP, id: 'trip-other-1' }

const budgetA: BudgetSnapshotV1 = {
  budgetRaw: '100',
  rows: [{ id: 'r1', category: 'food', name: '午饭', amountRaw: '12.50' }],
}
const budgetB: BudgetSnapshotV1 = {
  budgetRaw: '200',
  rows: [{ id: 'r2', category: 'ticket', name: '门票', amountRaw: '80' }],
}

describe('useWorkspaceController：Trip 变更最终 apply 门', () => {
  it('未关联工作区时 applyTripChange 直接放行，且不读任何存储键', () => {
    const { storage, reads } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    let outcome: WorkspaceTripChangeResult | undefined
    act(() => {
      outcome = result.current.applyTripChange(tripA, null)
    })
    expect(outcome).toEqual({ ok: true, kind: 'unlinked' })
    expect(result.current.workspace).toBeNull()
    expect(reads).toEqual([])
  })

  it('createWorkspace 建立内存记录：revision 1、预算快照随记录、epoch 推进；不写存储', () => {
    const { storage, map } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    let outcome: WorkspaceActionResult | undefined
    act(() => {
      outcome = result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    expect(outcome?.ok).toBe(true)
    expect(result.current.workspace).not.toBeNull()
    expect(result.current.workspace?.workspaceRevision).toBe(1)
    expect(result.current.workspace?.budget).toEqual(budgetA)
    expect(result.current.epoch).toBe(1)
    expect(result.current.workspaceStatus).toBe('in_memory')
    expect(map.size).toBe(0)
  })

  it('同 trip.id 内容变更走一次整体 transition：Trip 与预算一起切换、revision +1', () => {
    const { storage } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    let outcome: WorkspaceTripChangeResult | undefined
    act(() => {
      outcome = result.current.applyTripChange(tripB, budgetB)
    })
    expect(outcome).toEqual({ ok: true, kind: 'transitioned' })
    expect(result.current.workspace?.workspaceRevision).toBe(2)
    expect(result.current.workspace?.trip.summary).toBe(tripB.summary)
    expect(result.current.workspace?.budget).toEqual(budgetB)
    expect(result.current.epoch).toBe(2)
    expect(result.current.undoProposal).toBeNull()
  })

  it('换 trip.id 解除关联：工作区不再链接，sidecar / 预算不跟随新行程', () => {
    const { storage } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    let outcome: WorkspaceTripChangeResult | undefined
    act(() => {
      outcome = result.current.applyTripChange(tripOther)
    })
    expect(outcome).toEqual({ ok: true, kind: 'detached' })
    expect(result.current.workspace).toBeNull()
    expect(result.current.workspaceStatus).toBe('detached')
    expect(result.current.epoch).toBe(2)
  })

  it('同 id 变更 budget 省略时保留记录里的现有预算快照', () => {
    const { storage } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    act(() => {
      result.current.applyTripChange(tripB)
    })
    expect(result.current.workspace?.budget).toEqual(budgetA)
    expect(result.current.workspace?.trip.summary).toBe(tripB.summary)
  })
})

describe('useWorkspaceController：版本库显式保存', () => {
  it('未打开版本库时保存被 typed 拒绝；打开后保存 await ok 才更新列表并写入自身键', async () => {
    const { storage, map, reads } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA })
    })
    let denied: WorkspaceActionResult | undefined
    await act(async () => {
      denied = await result.current.saveVersion('方案A')
    })
    expect(denied?.ok).toBe(false)
    expect(denied?.reason).toBe('versions_not_loaded')
    expect(map.has('travel-assistant:workspace:versions:v1')).toBe(false)

    let opened: WorkspaceActionResult | undefined
    act(() => {
      opened = result.current.openVersions()
    })
    expect(opened?.ok).toBe(true)

    let saved: WorkspaceActionResult | undefined
    await act(async () => {
      saved = await result.current.saveVersion('方案A')
    })
    expect(saved?.ok).toBe(true)
    expect(result.current.versions?.items).toHaveLength(1)
    expect(result.current.versions?.items[0]?.name).toBe('方案A')
    expect(result.current.versions?.items[0]?.workspaceRevision).toBe(1)
    const raw = map.get('travel-assistant:workspace:versions:v1')
    expect(raw).toBeDefined()
    expect(raw).toContain('方案A')
    // 工作区键没有被顺带写入：保存版本只写版本库自身
    expect(map.has('travel-assistant:workspace:v1')).toBe(false)
    // 不读取会话恢复 / savedTrips 键
    expect(reads).not.toContain(SESSION_RESUME_DATA_KEY)
    expect(reads).not.toContain(SAVED_TRIPS_STORAGE_KEY)
  })

  it('无锁时保存版本返回 lock_unavailable，版本库与原字节都不变', async () => {
    const { storage, map } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: null }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA })
    })
    act(() => {
      result.current.openVersions()
    })
    expect(result.current.canWrite).toBe(false)
    let saved: WorkspaceActionResult | undefined
    await act(async () => {
      saved = await result.current.saveVersion('方案A')
    })
    expect(saved?.ok).toBe(false)
    expect(saved?.reason).toBe('lock_unavailable')
    expect(result.current.versions).toBeNull()
    expect(map.has('travel-assistant:workspace:versions:v1')).toBe(false)
  })
})

describe('useWorkspaceController：F4 采用 / 撤销 / ABA', () => {
  it('采用提案整体切换 Trip+sidecar+budget，revision 当前 +1；撤销也 +1；旧提案不复活', async () => {
    const { storage } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    act(() => {
      result.current.openVersions()
    })
    let saved: WorkspaceActionResult | undefined
    await act(async () => {
      saved = await result.current.saveVersion('方案A')
    })
    expect(saved?.ok).toBe(true)
    const version = result.current.versions?.items[0]
    expect(version).toBeDefined()

    const revisionBefore = result.current.workspace?.workspaceRevision ?? 0
    const epochBefore = result.current.epoch
    // 纯函数，无需 act：提案基于当前记录与当前 epoch
    const planned = planVersionAdopt(
      result.current.workspace as NonNullable<typeof result.current.workspace>,
      version!,
      { epoch: epochBefore },
    )
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const proposal: VersionAdoptProposalV1 = planned.value

    let adopted: WorkspaceActionResult | undefined
    act(() => {
      adopted = result.current.adoptVersion(proposal)
    })
    expect(adopted?.ok).toBe(true)
    expect(result.current.workspace?.workspaceRevision).toBe(revisionBefore + 1)
    expect(result.current.undoProposal).not.toBeNull()
    // Trip / sidecar / budget 一起切到版本快照内容（toEqual 不依赖键序：快照经 canonical 克隆）
    expect(result.current.workspace?.trip).toEqual(version!.trip)
    expect(result.current.workspace?.budget).toEqual(version!.budget)

    // 撤销：一次机会，整体恢复，revision 继续 +1
    let undone: WorkspaceActionResult | undefined
    act(() => {
      undone = result.current.undoAdopt()
    })
    expect(undone?.ok).toBe(true)
    expect(result.current.workspace?.workspaceRevision).toBe(revisionBefore + 2)
    expect(result.current.workspace?.trip).toEqual(tripA)
    expect(result.current.workspace?.budget).toEqual(budgetA)
    expect(result.current.undoProposal).toBeNull()

    // A-B-A：撤销后旧提案已过期（revision / epoch 已推进），重新应用被拒绝
    let stale: WorkspaceActionResult | undefined
    act(() => {
      stale = result.current.adoptVersion(proposal)
    })
    expect(stale?.ok).toBe(false)
    expect(result.current.workspace?.workspaceRevision).toBe(revisionBefore + 2)
  })
})

describe('useWorkspaceController：版本库导入与一次撤销', () => {
  it('确认导入写自身键并提供撤销；撤销恢复导入前字节（空库则移除键）', async () => {
    const { storage, map, reads } = makeStorage()
    const snapshot = createVersionSnapshot({
      id: 'v-import-1',
      name: '导入版本',
      createdAt: 1000,
      workspaceRevision: 1,
      trip: tripA,
      sidecar: emptySidecar(),
      budget: null,
    })
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    const record: VersionsRecordV1 = {
      format: VERSIONS_FORMAT,
      version: VERSIONS_VERSION,
      items: [snapshot.value],
      updatedAt: 1000,
    }
    const backup = createVersionsBackupFile(record, 2000)
    expect(backup.ok).toBe(true)
    if (!backup.ok) return
    const preview = previewVersionsImport(backup.text)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return

    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    let imported: WorkspaceActionResult | undefined
    await act(async () => {
      imported = await result.current.importVersions(preview.value)
    })
    expect(imported?.ok).toBe(true)
    expect(result.current.versions?.items).toHaveLength(1)
    expect(map.get('travel-assistant:workspace:versions:v1')).toContain('导入版本')
    expect(result.current.versionsImportUndoExpiresAt).not.toBeNull()

    let undone: WorkspaceActionResult | undefined
    await act(async () => {
      undone = await result.current.undoVersionsImport()
    })
    expect(undone?.ok).toBe(true)
    expect(map.has('travel-assistant:workspace:versions:v1')).toBe(false)
    expect(result.current.versions).toBeNull()
    expect(result.current.versionsImportUndoExpiresAt).toBeNull()
    expect(reads).not.toContain(SESSION_RESUME_DATA_KEY)
    expect(reads).not.toContain(SAVED_TRIPS_STORAGE_KEY)
  })
})

describe('useWorkspaceController：内部 fork / patch / adopt / 外部事件', () => {
  it('applyTripFork 新 trip.id 保留 workspaceId/ownerId/sidecar/budget，只重绑 tripId，revision+1', () => {
    const { storage } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    const before = result.current.workspace
    expect(before).not.toBeNull()
    const runtime = result.current.getRuntime()
    expect(runtime?.record).toBe(before)
    const forked: Trip = { ...tripA, id: 'trip-fork-1', summary: 'forked' }

    let outcome: WorkspaceTripChangeResult | undefined
    act(() => {
      outcome = result.current.applyTripFork(forked, budgetB, runtime?.capture ?? null)
    })
    expect(outcome).toEqual({ ok: true, kind: 'forked' })
    const after = result.current.workspace
    expect(after?.workspaceId).toBe(before?.workspaceId)
    expect(after?.ownerId).toBe(before?.ownerId)
    expect(after?.tripId).toBe('trip-fork-1')
    expect(after?.trip).toBe(forked)
    expect(after?.sidecar).toEqual(before?.sidecar)
    expect(after?.budget).toEqual(budgetB)
    expect(after?.workspaceRevision).toBe((before?.workspaceRevision ?? 0) + 1)
  })

  it('applyPatch 先过实际引用门：旧 capture 在 transition 后返回 stale，记录不变', () => {
    const { storage } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    const capture = result.current.getRuntime()?.capture ?? null
    let first: WorkspaceActionResult | undefined
    act(() => {
      first = result.current.applyPatch({ budget: budgetB }, capture, { notify: false })
    })
    expect(first?.ok).toBe(true)
    const recordAfterFirst = result.current.workspace
    let stale: WorkspaceActionResult | undefined
    act(() => {
      stale = result.current.applyPatch({ budget: budgetA }, capture, { notify: false })
    })
    expect(stale?.ok).toBe(false)
    expect(stale?.reason).toBe('stale')
    expect(result.current.workspace).toBe(recordAfterFirst)
  })

  it('adoptRecord 拒绝非当前+1 revision / 缺 capture；正确记录安装后 epoch 推进', () => {
    const { storage } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    const current = result.current.workspace
    expect(current).not.toBeNull()
    const runtime = result.current.getRuntime()
    if (current === null || runtime === null) return
    const wrongRevision = { ...current, workspaceRevision: current.workspaceRevision + 2 }
    let rejected: WorkspaceActionResult | undefined
    act(() => {
      rejected = result.current.adoptRecord(wrongRevision, runtime.capture, { notify: false })
    })
    expect(rejected?.ok).toBe(false)
    expect(rejected?.reason).toBe('invalid_revision')

    const next = { ...current, workspaceRevision: current.workspaceRevision + 1, updatedAt: current.updatedAt + 1 }
    let installed: WorkspaceActionResult | undefined
    act(() => {
      installed = result.current.adoptRecord(next, runtime.capture, { notify: false })
    })
    expect(installed?.ok).toBe(true)
    expect(result.current.workspace).toEqual(next)
    expect(result.current.epoch).toBe(runtime.epoch + 1)
  })

  it('候选库 storage 事件也推进 epoch、失效 generation 并通知 App；不自动读取', () => {
    const { storage, reads } = makeStorage()
    const onExternalStorageChange = vi.fn()
    const { result } = renderHook(() =>
      useWorkspaceController({
        storage,
        locks: makeLocks(),
        onExternalStorageChange,
      }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA })
    })
    const epochBefore = result.current.epoch
    const generationBefore = getLibraryGeneration(CANDIDATES_STORAGE_KEY).generation
    const readsBefore = reads.length
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: CANDIDATES_STORAGE_KEY, storageArea: null }),
      )
    })
    expect(result.current.epoch).toBe(epochBefore + 1)
    expect(getLibraryGeneration(CANDIDATES_STORAGE_KEY).generation).toBeGreaterThan(generationBefore)
    expect(onExternalStorageChange).toHaveBeenCalledWith(CANDIDATES_STORAGE_KEY)
    expect(reads.length).toBe(readsBefore)
  })
})

describe('useWorkspaceController：工作区显式保存', () => {
  it('首次保存 await ok 才标记 saved；相同字节重复保存幂等成功且不额外写', async () => {
    const { storage, map, writes } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    let saved: WorkspaceActionResult | undefined
    await act(async () => {
      saved = await result.current.saveWorkspace()
    })
    expect(saved?.ok).toBe(true)
    expect(result.current.workspaceStatus).toBe('saved')
    expect(map.has('travel-assistant:workspace:v1')).toBe(true)
    expect(writes.filter((key) => key === 'travel-assistant:workspace:v1')).toHaveLength(1)

    // 存储修复后：同一份字节 / 同一 revision 是幂等成功，不再 setItem，也不 renumber。
    let again: WorkspaceActionResult | undefined
    await act(async () => {
      again = await result.current.saveWorkspace()
    })
    expect(again?.ok).toBe(true)
    expect(writes.filter((key) => key === 'travel-assistant:workspace:v1')).toHaveLength(1)
    expect(result.current.workspace?.workspaceRevision).toBe(1)
  })

  it('内存 revision 3 可显式保存到持久 revision 1 之上，结果仍是 revision 3（不回退）', async () => {
    const { storage, map, writes } = makeStorage()
    const { result } = renderHook(() =>
      useWorkspaceController({ storage, locks: makeLocks() }),
    )
    act(() => {
      result.current.createWorkspace({ trip: tripA, budget: budgetA })
    })
    await act(async () => {
      await result.current.saveWorkspace()
    })
    expect(map.get('travel-assistant:workspace:v1')).toContain('"workspaceRevision":1')

    act(() => {
      result.current.applyTripChange({ ...tripA, summary: 'memory 2' })
      result.current.applyTripChange({ ...tripA, summary: 'memory 3' })
    })
    expect(result.current.workspace?.workspaceRevision).toBe(3)

    let saved: WorkspaceActionResult | undefined
    await act(async () => {
      saved = await result.current.saveWorkspace()
    })
    expect(saved?.ok).toBe(true)
    expect(result.current.workspaceStatus).toBe('saved')
    const raw = map.get('travel-assistant:workspace:v1')
    expect(raw).toContain('"workspaceRevision":3')
    expect(raw).toContain('memory 3')
    expect(writes.filter((key) => key === 'travel-assistant:workspace:v1')).toHaveLength(2)
  })
})

import { describe, expect, it } from 'vitest'
import { MOCK_TRIP } from './fixtures/trip'
import type { Trip } from '../lib/api'
import {
  MAX_VERSION_SNAPSHOT_BYTES,
  MAX_VERSIONS_COUNT,
  MAX_VERSIONS_TOTAL_BYTES,
  VERSION_LIMITS,
  addVersionSnapshot,
  applyVersionAdoptProposal,
  applyVersionUndoProposal,
  buildVersionsBackupPreview,
  createVersionSnapshot,
  diffVersions,
  measureVersionSnapshotBytes,
  planVersionAdopt,
  prepareVersionsLibraryWrite,
  previewVersionsImport,
  summarizeBudgetSnapshot,
  summarizeVersionBudget,
  validateVersionSnapshot,
  validateVersionsRecord,
} from '../lib/versionSnapshots'
import {
  createWorkspaceRecord,
  emptySidecar,
} from '../lib/workspace'
import type {
  BudgetSnapshotV1,
  ConstraintItemV1,
  VersionSnapshotV1,
  VersionsRecordV1,
  WorkspaceRecordV1,
  WorkspaceValidationFailure,
  WorkspaceValidationResult,
} from '../lib/workspaceTypes'

const NOW = 1_760_000_000_000

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function expectOk<T>(result: WorkspaceValidationResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(`${result.path}: ${result.message}`)
  return result.value
}

function expectFailure<T>(result: WorkspaceValidationResult<T>): WorkspaceValidationFailure {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a validation failure')
  return result
}

function makeTrip(): Trip {
  return clone(MOCK_TRIP)
}

function makeConstraint(overrides: Partial<ConstraintItemV1> = {}): ConstraintItemV1 {
  return {
    id: 'constraint-1',
    kind: 'fixed_window',
    title: '博物馆预约',
    day: 1,
    stopId: 's1',
    startDate: '2026-04-03',
    endDate: '2026-04-03',
    startTime: '14:00',
    endTime: '16:00',
    durationMinutes: 120,
    notes: null,
    priority: 2,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeBudget(
  rows: BudgetSnapshotV1['rows'],
  budgetRaw = '',
): BudgetSnapshotV1 {
  return { budgetRaw, rows }
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

function makeSnapshot(overrides: Partial<VersionSnapshotV1> = {}): VersionSnapshotV1 {
  const version = makeVersion(overrides)
  return expectOk(
    createVersionSnapshot({
      id: version.id,
      name: version.name,
      createdAt: version.createdAt,
      workspaceRevision: version.workspaceRevision,
      trip: version.trip,
      sidecar: version.sidecar,
      budget: version.budget,
    }),
  )
}

function makeRecord(overrides: Partial<WorkspaceRecordV1> = {}): WorkspaceRecordV1 {
  const record = expectOk(
    createWorkspaceRecord({
      workspaceId: 'workspace-1',
      ownerId: 'owner-1',
      trip: makeTrip(),
      workspaceRevision: 7,
      now: NOW,
      sidecar: emptySidecar(),
      budget: null,
      label: '测试工作区',
    }),
  )
  return { ...record, ...overrides }
}

function makeStop(id: string, name: string, duration: number | null = 10) {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: duration,
    description: '',
    address: '',
    location: null,
  }
}

function makeDay(day: number, stops: ReturnType<typeof makeStop>[]) {
  return {
    day,
    date: null,
    title: `第 ${day} 天`,
    summary: '',
    stops,
    legs: [],
  }
}

function makeHeavyTrip(): Trip {
  const trip = makeTrip()
  trip.days = [1, 2].map((day) => ({
    day,
    date: null,
    title: `重数据日 ${day}`,
    summary: '',
    stops: Array.from({ length: 22 }, (_, index) => ({
      id: `heavy-${day}-${index}`,
      name: `重数据点 ${index}`,
      time: '09:00',
      duration_minutes: 0,
      description: 'x'.repeat(10_000),
      address: '',
      location: null,
    })),
    legs: [],
  }))
  return trip
}

describe('F4 快照不可变与预算归属', () => {
  it('保存后继续编辑原 Trip / sidecar / budget 不会串改旧版本；快照深层冻结', () => {
    const trip = makeTrip()
    const sidecar = emptySidecar()
    sidecar.constraints.items.push(makeConstraint())
    const budget = makeBudget(
      [{ id: 'row-1', category: 'food', name: '午餐', amountRaw: '10.00' }],
      '100',
    )

    const snapshot = expectOk(
      createVersionSnapshot({
        id: 'version-1',
        name: '方案 A',
        createdAt: NOW,
        workspaceRevision: 7,
        trip,
        sidecar,
        budget,
      }),
    )

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.trip)).toBe(true)
    expect(Object.isFrozen(snapshot.trip.days[0])).toBe(true)
    expect(Object.isFrozen(snapshot.sidecar.constraints.items[0])).toBe(true)
    expect(Object.isFrozen(snapshot.budget?.rows[0])).toBe(true)

    trip.days[0].stops[0].name = '被后续编辑改掉'
    sidecar.constraints.items[0].title = '被后续编辑改掉'
    budget.rows[0] = { ...budget.rows[0], amountRaw: '999.99' }
    budget.budgetRaw = '999.99'

    expect(snapshot.trip.days[0].stops[0].name).toBe('断桥残雪')
    expect(snapshot.sidecar.constraints.items[0].title).toBe('博物馆预约')
    expect(snapshot.budget?.rows[0].amountRaw).toBe('10.00')
    expect(snapshot.budget?.budgetRaw).toBe('100')
    expect(validateVersionSnapshot(snapshot).ok).toBe(true)
  })

  it('预算快照是独立副本；采用无预算旧版本后预算明确为 null，不套当前预算', () => {
    const currentBudget = makeBudget(
      [{ id: 'row-current', category: 'stay', name: '当前酒店', amountRaw: '500.00' }],
      '1000',
    )
    const current = makeRecord({ budget: currentBudget })
    const textOnly = makeSnapshot({
      id: 'legacy-no-budget',
      name: '无预算旧版',
      workspaceRevision: 2,
      budget: null,
    })

    const proposal = expectOk(planVersionAdopt(current, textOnly, { epoch: 11 }))
    expect(proposal.target.content.budget).toBeNull()
    expect(proposal.nextWorkspaceRevision).toBe(8)

    const adopted = expectOk(
      applyVersionAdoptProposal(current, proposal, { epoch: 11 }, NOW + 1_000),
    )
    expect(adopted.record.budget).toBeNull()
    expect(adopted.record.workspaceRevision).toBe(8)
    expect(current.budget).toEqual(currentBudget)
  })

  it('合法 0 是已知值：0.00 元、0 分钟、0 米都不被当成未知', () => {
    const zeroBudget = makeBudget(
      [{ id: 'row-zero', category: 'other', name: '免费项目', amountRaw: '0' }],
      '0',
    )
    const zeroSummary = expectOk(summarizeBudgetSnapshot(zeroBudget))
    expect(zeroSummary.knownTotalCents).toBe(0)
    expect(zeroSummary.knownTotalText).toBe('0.00')
    expect(zeroSummary.unknownCount).toBe(0)
    expect(zeroSummary.complete).toBe(true)
    expect(zeroSummary.totalCents).toBe(0)
    expect(zeroSummary.totalText).toBe('0.00')

    const trip = makeTrip()
    trip.days = [
      {
        day: 1,
        date: null,
        title: '零值日',
        summary: '',
        stops: [makeStop('zero-stop', '零停留', 0)],
        legs: [
          {
            from_stop_id: 'zero-stop',
            to_stop_id: 'zero-stop',
            mode: 'walking',
            route_type: 'straight_line',
            distance_m: 0,
            duration_minutes: 0,
            geometry: [],
            description: '',
          },
        ],
      },
    ]
    const version = makeSnapshot({ id: 'zero-version', trip, budget: zeroBudget })
    const diff = expectOk(diffVersions(version, version))
    expect(diff.time.before.knownTotal).toBe(0)
    expect(diff.time.before.total).toBe(0)
    expect(diff.time.before.unknownCount).toBe(0)
    expect(diff.distance.before.knownTotal).toBe(0)
    expect(diff.distance.before.total).toBe(0)
    expect(diff.time.after.unknownCount).toBe(0)
  })

  it('重复名字仍各自独立 id，互不覆盖', () => {
    const first = expectOk(addVersionSnapshot(null, makeSnapshot({ id: 'v1', name: '方案 A' }), NOW))
    const second = expectOk(
      addVersionSnapshot(
        first,
        makeSnapshot({ id: 'v2', name: '方案 A', createdAt: NOW + 1 }),
        NOW + 2,
      ),
    )
    expect(second.items.map((item) => item.id)).toEqual(['v1', 'v2'])
    expect(second.items.map((item) => item.name)).toEqual(['方案 A', '方案 A'])
    expect(validateVersionsRecord(second).ok).toBe(true)
  })
})

describe('F4 版本对比', () => {
  it('按 stop id 识别新增 / 删除 / 跨日移动；预约按 id 对比', () => {
    const beforeTrip = makeTrip()
    beforeTrip.days = [
      makeDay(1, [makeStop('s1', '断桥'), makeStop('s2', '平湖'), makeStop('s3', '将删除')]),
      makeDay(2, []),
    ]
    const afterTrip = makeTrip()
    afterTrip.days = [
      makeDay(1, [makeStop('s2', '平湖')]),
      makeDay(2, [makeStop('s1', '断桥'), makeStop('s4', '新增点')]),
    ]

    const beforeSidecar = emptySidecar()
    beforeSidecar.constraints.items.push(
      makeConstraint({ id: 'c1', title: '保留预约' }),
      makeConstraint({ id: 'c2', title: '将删除预约' }),
      makeConstraint({ id: 'c3', title: '将变化预约' }),
    )
    const afterSidecar = emptySidecar()
    afterSidecar.constraints.items.push(
      makeConstraint({ id: 'c1', title: '保留预约' }),
      makeConstraint({ id: 'c3', title: '变化后的预约' }),
      makeConstraint({ id: 'c4', title: '新增预约' }),
    )

    const before = makeSnapshot({
      id: 'v-before',
      name: '方案 A',
      trip: beforeTrip,
      sidecar: beforeSidecar,
    })
    const after = makeSnapshot({
      id: 'v-after',
      name: '方案 B',
      trip: afterTrip,
      sidecar: afterSidecar,
    })

    const diff = expectOk(diffVersions(before, after))
    expect(diff.stops.added.map((item) => item.id)).toEqual(['s4'])
    expect(diff.stops.removed.map((item) => item.id)).toEqual(['s3'])
    expect(diff.stops.moved).toHaveLength(1)
    expect(diff.stops.moved[0].id).toBe('s1')
    expect(diff.stops.moved[0].from.day).toBe(1)
    expect(diff.stops.moved[0].to.day).toBe(2)
    expect(diff.stops.unchangedCount).toBe(1)
    expect(diff.constraints.added.map((item) => item.id)).toEqual(['c4'])
    expect(diff.constraints.removed.map((item) => item.id)).toEqual(['c2'])
    expect(diff.constraints.changed.map((item) => item.id)).toEqual(['c3'])
    expect(diff.constraints.unchangedCount).toBe(1)
  })

  it('费用用精确十进制；存在未知项时不显示总价，0 与 null 分开', () => {
    const beforeBudget = makeBudget(
      [
        { id: 'r1', category: 'food', name: '早餐', amountRaw: '0.10' },
        { id: 'r2', category: 'food', name: '午餐', amountRaw: '0.20' },
        { id: 'r3', category: 'ticket', name: '门票未知', amountRaw: '' },
      ],
      '',
    )
    const afterBudget = makeBudget(
      [
        { id: 'r1', category: 'food', name: '早餐', amountRaw: '0.20' },
        { id: 'r2', category: 'food', name: '午餐', amountRaw: '0.10' },
        { id: 'r4', category: 'other', name: '明确免费', amountRaw: '0' },
      ],
      '',
    )
    const before = makeSnapshot({ id: 'v-cost-a', name: '费用 A', budget: beforeBudget })
    const after = makeSnapshot({ id: 'v-cost-b', name: '费用 B', budget: afterBudget })
    const diff = expectOk(diffVersions(before, after))

    expect(diff.cost.before.knownTotalCents).toBe(30)
    expect(diff.cost.before.knownTotalText).toBe('0.30')
    expect(diff.cost.before.unknownCount).toBe(1)
    expect(diff.cost.before.complete).toBe(false)
    expect(diff.cost.before.totalCents).toBeNull()
    expect(diff.cost.before.totalText).toBeNull()
    expect(diff.cost.after.complete).toBe(true)
    expect(diff.cost.after.knownTotalText).toBe('0.30')
    expect(diff.cost.after.totalText).toBe('0.30')
    expect(diff.cost.totalDeltaCents).toBeNull()
    expect(diff.cost.knownDeltaText).toBe('+0.00')
    expect(diff.cost.unknownDelta).toBe(-1)

    expect(expectOk(summarizeVersionBudget(after)).knownTotalText).toBe('0.30')
  })

  it('时间 / 距离的已知与未知分列，null 不补 0', () => {
    const beforeTrip = makeTrip()
    beforeTrip.days = [
      {
        day: 1,
        date: null,
        title: '未知日',
        summary: '',
        stops: [makeStop('unknown-stop', '未知停留', null)],
        legs: [
          {
            from_stop_id: 'unknown-stop',
            to_stop_id: 'unknown-stop',
            mode: 'walking',
            route_type: 'unavailable',
            distance_m: null,
            duration_minutes: null,
            geometry: [],
            description: '',
          },
        ],
      },
    ]
    const afterTrip = makeTrip()
    afterTrip.days = [
      {
        day: 1,
        date: null,
        title: '已知零',
        summary: '',
        stops: [makeStop('zero-stop', '零停留', 0)],
        legs: [
          {
            from_stop_id: 'zero-stop',
            to_stop_id: 'zero-stop',
            mode: 'walking',
            route_type: 'straight_line',
            distance_m: 0,
            duration_minutes: 0,
            geometry: [],
            description: '',
          },
        ],
      },
    ]
    const before = makeSnapshot({ id: 'v-unknown', trip: beforeTrip })
    const after = makeSnapshot({ id: 'v-zero', trip: afterTrip })
    const diff = expectOk(diffVersions(before, after))

    expect(diff.time.before.knownTotal).toBeNull()
    expect(diff.time.before.unknownCount).toBe(2)
    expect(diff.time.before.total).toBeNull()
    expect(diff.time.after.knownTotal).toBe(0)
    expect(diff.time.after.unknownCount).toBe(0)
    expect(diff.time.after.total).toBe(0)
    expect(diff.distance.before.knownTotal).toBeNull()
    expect(diff.distance.before.unknownCount).toBe(1)
    expect(diff.distance.after.knownTotal).toBe(0)
    expect(diff.distance.after.total).toBe(0)
  })
})

describe('F4 采用 / 撤销与 revision / epoch', () => {
  it('采用后 revision = 当前 + 1，绝不恢复快照旧 revision；一次 undo 整体恢复内容且再 +1', () => {
    const beforeSidecar = emptySidecar()
    beforeSidecar.constraints.items.push(makeConstraint({ id: 'before-c', title: '采用前约束' }))
    const beforeBudget = makeBudget(
      [{ id: 'row-before', category: 'food', name: '采用前预算', amountRaw: '10.00' }],
      '100',
    )
    const current = makeRecord({
      workspaceRevision: 7,
      sidecar: beforeSidecar,
      budget: beforeBudget,
    })

    const versionTrip = makeTrip()
    versionTrip.title = '版本 B 的行程'
    const versionSidecar = emptySidecar()
    versionSidecar.constraints.items.push(makeConstraint({ id: 'version-c', title: '版本约束' }))
    const versionBudget = makeBudget(
      [{ id: 'row-version', category: 'ticket', name: '版本门票', amountRaw: '88.00' }],
      '500',
    )
    const version = makeSnapshot({
      id: 'v-old',
      name: '旧方案 B',
      workspaceRevision: 2,
      trip: versionTrip,
      sidecar: versionSidecar,
      budget: versionBudget,
    })

    const proposal = expectOk(planVersionAdopt(current, version, { epoch: 11 }))
    expect(proposal.nextWorkspaceRevision).toBe(8)
    expect(proposal.nextEpoch).toBe(12)
    expect(proposal.versionRevision).toBe(2)

    const adopted = expectOk(
      applyVersionAdoptProposal(current, proposal, { epoch: 11 }, NOW + 1_000),
    )
    expect(adopted.record.workspaceRevision).toBe(8)
    expect(adopted.record.workspaceRevision).not.toBe(version.workspaceRevision)
    expect(adopted.record.trip.title).toBe('版本 B 的行程')
    expect(adopted.record.sidecar).toEqual(versionSidecar)
    expect(adopted.record.budget).toEqual(versionBudget)
    expect(adopted.invalidation).toEqual({
      workspaceRevision: 8,
      epoch: 12,
      reason: 'version_adopted',
    })
    expect(adopted.undo.nextWorkspaceRevision).toBe(9)
    expect(adopted.undo.nextEpoch).toBe(13)

    // 原 current 对象不被修改
    expect(current.workspaceRevision).toBe(7)
    expect(current.trip.title).toBe(MOCK_TRIP.title)

    const undone = expectOk(
      applyVersionUndoProposal(
        adopted.record,
        adopted.undo,
        { epoch: adopted.invalidation.epoch },
        NOW + 2_000,
      ),
    )
    expect(undone.record.workspaceRevision).toBe(9)
    expect(undone.record.workspaceRevision).not.toBe(current.workspaceRevision)
    expect(undone.record.trip).toEqual(current.trip)
    expect(undone.record.sidecar).toEqual(beforeSidecar)
    expect(undone.record.budget).toEqual(beforeBudget)
    expect(undone.invalidation).toEqual({
      workspaceRevision: 9,
      epoch: 13,
      reason: 'version_undo',
    })

    // ABA：内容回到采用前，但旧 proposal 仍因 revision / canonical 过期而拒绝。
    const aba = expectFailure(
      applyVersionAdoptProposal(undone.record, proposal, { epoch: 11 }, NOW + 3_000),
    )
    expect(aba.reason).toBe('owner_mismatch')
    expect(aba.message).toContain('已变化')

    // 旧 proposal 也不可重放。
    const replay = expectFailure(
      applyVersionAdoptProposal(adopted.record, proposal, { epoch: 11 }, NOW + 4_000),
    )
    expect(replay.reason).toBe('owner_mismatch')
  })

  it('epoch 变化、内容变化与重复使用同一 undo 都拒绝，当前记录保持不变', () => {
    const current = makeRecord({ workspaceRevision: 3 })
    const version = makeSnapshot({
      id: 'v-epoch',
      name: '版本',
      workspaceRevision: 1,
      trip: makeTrip(),
    })
    const proposal = expectOk(planVersionAdopt(current, version, { epoch: 5 }))

    const wrongEpoch = expectFailure(
      applyVersionAdoptProposal(current, proposal, { epoch: 6 }, NOW + 1_000),
    )
    expect(wrongEpoch.reason).toBe('owner_mismatch')

    const changed = { ...current, updatedAt: NOW + 1 }
    const changedContent = expectFailure(
      applyVersionAdoptProposal(changed, proposal, { epoch: 5 }, NOW + 1_000),
    )
    expect(changedContent.reason).toBe('owner_mismatch')

    const adopted = expectOk(
      applyVersionAdoptProposal(current, proposal, { epoch: 5 }, NOW + 2_000),
    )
    const firstUndo = expectOk(
      applyVersionUndoProposal(
        adopted.record,
        adopted.undo,
        { epoch: adopted.invalidation.epoch },
        NOW + 3_000,
      ),
    )
    const reuseUndo = expectFailure(
      applyVersionUndoProposal(
        firstUndo.record,
        adopted.undo,
        { epoch: adopted.invalidation.epoch },
        NOW + 4_000,
      ),
    )
    expect(reuseUndo.reason).toBe('owner_mismatch')
  })

  it('当前工作区额外条目列入需重新确认，不静默套用', () => {
    const currentSidecar = emptySidecar()
    currentSidecar.constraints.items.push(
      makeConstraint({ id: 'keep', title: '版本里也有' }),
      makeConstraint({ id: 'extra', title: '只存在当前工作区' }),
    )
    currentSidecar.checklist.items.push({
      id: 'check-extra',
      category: 'todo',
      title: '当前额外清单',
      done: false,
      date: null,
      day: null,
      stopId: null,
      originalStopId: null,
      notes: null,
      updatedAt: NOW,
    })
    const current = makeRecord({ sidecar: currentSidecar })

    const versionSidecar = emptySidecar()
    versionSidecar.constraints.items.push(makeConstraint({ id: 'keep', title: '版本里也有' }))
    const version = makeSnapshot({
      id: 'v-extra',
      name: '只有部分条目的版本',
      sidecar: versionSidecar,
    })

    const proposal = expectOk(planVersionAdopt(current, version, { epoch: 1 }))
    const labels = proposal.needsReconfirmation.map((item) => item.label)
    expect(labels).toContain('约束：只存在当前工作区')
    expect(labels).toContain('清单：当前额外清单')
    expect(labels).not.toContain('约束：版本里也有')
  })
})

describe('F4 容量、备份与导入预览', () => {
  it('版本数最多 10；第 11 个明确失败且旧版本不被驱逐', () => {
    let record: VersionsRecordV1 | null = null
    for (let index = 0; index < MAX_VERSIONS_COUNT; index += 1) {
      record = expectOk(
        addVersionSnapshot(
          record,
          makeSnapshot({ id: `v-${index}`, name: `版本 ${index}` }),
          NOW + index,
        ),
      )
    }
    if (record === null) throw new Error('record missing')
    const before = JSON.stringify(record)
    const overflow = expectFailure(
      addVersionSnapshot(record, makeSnapshot({ id: 'v-overflow', name: '第 11 个' }), NOW + 99),
    )
    expect(overflow.reason).toBe('limit_exceeded')
    expect(JSON.stringify(record)).toBe(before)
    expect(record.items).toHaveLength(MAX_VERSIONS_COUNT)
  })

  it('版本库总量 4 MiB：接近上限后新增强制失败，不驱逐旧版本', () => {
    const heavyTrip = makeHeavyTrip()
    let record: VersionsRecordV1 | null = null
    let added = 0
    let failure: WorkspaceValidationFailure | null = null
    for (let index = 0; index < MAX_VERSIONS_COUNT; index += 1) {
      const result = addVersionSnapshot(
        record,
        makeSnapshot({ id: `heavy-${index}`, name: `重数据版本 ${index}`, trip: clone(heavyTrip) }),
        NOW + index,
      )
      if (!result.ok) {
        failure = result
        break
      }
      record = result.value
      added += 1
    }
    expect(failure?.reason).toBe('limit_exceeded')
    expect(added).toBeGreaterThanOrEqual(2)
    expect(record?.items.length).toBe(added)
    expect(MAX_VERSIONS_TOTAL_BYTES).toBe(4 * 1024 * 1024)
    expect(MAX_VERSION_SNAPSHOT_BYTES).toBe(2 * 1024 * 1024)
    expect(VERSION_LIMITS.maxCount).toBe(MAX_VERSIONS_COUNT)
    expect(VERSION_LIMITS.maxTotalBytes).toBe(MAX_VERSIONS_TOTAL_BYTES)
  })

  it('过大 Trip / 循环引用 / 未知字段都拒绝，原记录不变', () => {
    const oversizedTrip = makeHeavyTrip()
    oversizedTrip.days = [1, 2, 3].map((day) => ({
      day,
      date: null,
      title: `超限 ${day}`,
      summary: '',
      stops: Array.from({ length: 80 }, (_, index) => ({
        id: `oversized-${day}-${index}`,
        name: `超限点 ${index}`,
        time: '09:00',
        duration_minutes: 0,
        description: 'x'.repeat(10_000),
        address: '',
        location: null,
      })),
      legs: [],
    }))
    const oversized = expectFailure(
      createVersionSnapshot({
        id: 'v-oversized',
        name: '过大',
        createdAt: NOW,
        workspaceRevision: 0,
        trip: oversizedTrip,
        sidecar: emptySidecar(),
        budget: null,
      }),
    )
    expect(oversized.reason).toBe('limit_exceeded')

    const cyclicTrip = makeTrip() as Trip & { self?: unknown }
    cyclicTrip.self = cyclicTrip
    const cyclic = expectFailure(
      createVersionSnapshot({
        id: 'v-cycle',
        name: '循环',
        createdAt: NOW,
        workspaceRevision: 0,
        trip: cyclicTrip,
        sidecar: emptySidecar(),
        budget: null,
      }),
    )
    expect(cyclic.reason).toBe('unserializable')

    const unknown = expectFailure(validateVersionSnapshot({ ...makeVersion(), extra: true }))
    expect(unknown.reason).toBe('unknown_field')
  })

  it('UTF-8 字节口径按实际序列化计算', () => {
    const snapshot = makeSnapshot({ id: 'v-utf8', name: '杭州🚄方案' })
    const expected = new TextEncoder().encode(JSON.stringify(snapshot)).length
    expect(measureVersionSnapshotBytes(snapshot)).toBe(expected)
    expect(expected).toBeGreaterThan(JSON.stringify(snapshot).length)
  })

  it('版本库备份 / 导入预览只含版本库；损坏 / 未知字段拒绝且不改变原记录', () => {
    const record = expectOk(
      addVersionSnapshot(
        expectOk(addVersionSnapshot(null, makeSnapshot({ id: 'b1', name: '备份 A' }), NOW)),
        makeSnapshot({ id: 'b2', name: '备份 B' }),
        NOW + 1,
      ),
    )
    const before = JSON.stringify(record)
    const preview = expectOk(buildVersionsBackupPreview(record, NOW + 2))
    expect(preview.scope).toBe('versions-only')
    expect(preview.bytes).toBe(new TextEncoder().encode(preview.text).length)
    const envelope = JSON.parse(preview.text) as Record<string, unknown>
    expect(Object.keys(envelope).sort()).toEqual(['exportedAt', 'format', 'version', 'versions'])
    expect(envelope.format).toBe('travel-assistant.workspace.versions.backup')

    const imported = expectOk(previewVersionsImport(preview.text, preview.bytes))
    expect(imported.scope).toBe('versions-only')
    expect(imported.record).toEqual(record)
    expect(JSON.stringify(record)).toBe(before)

    const corrupt = expectFailure(previewVersionsImport('{'))
    expect(corrupt.message).toContain('不是合法 JSON')

    const unknownEnvelope = JSON.parse(preview.text) as Record<string, unknown>
    unknownEnvelope.extra = true
    const unknown = expectFailure(previewVersionsImport(JSON.stringify(unknownEnvelope)))
    expect(unknown.reason).toBe('unknown_field')

    const plan = expectOk(prepareVersionsLibraryWrite(record))
    expect(plan.storageKey).toBe('travel-assistant:workspace:versions:v1')
    expect(plan.scope).toBe('versions-only')
    expect(plan.bytes).toBe(new TextEncoder().encode(plan.text).length)
    expect(JSON.stringify(record)).toBe(before)
  })
})

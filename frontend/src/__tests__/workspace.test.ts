import { describe, expect, it } from 'vitest'
import { MOCK_TRIP } from './fixtures/trip'
import type { Trip } from '../lib/api'
import {
  BACKUP_VERSION,
  CANDIDATES_BACKUP_FORMAT,
  CANDIDATES_FORMAT,
  CANDIDATES_VERSION,
  MAX_CANDIDATES_COUNT,
  MAX_CANDIDATE_TAGS,
  MAX_CHECKLIST_ITEMS,
  MAX_CONSTRAINT_ITEMS,
  MAX_SAFE_WORKSPACE_REVISION,
  MAX_VERSION_SNAPSHOT_BYTES,
  MAX_VERSIONS_COUNT,
  MAX_WORKSPACE_BACKUP_FILE_BYTES,
  MAX_WORKSPACE_RECORD_BYTES,
  MAX_WORKSPACE_SIDECAR_BYTES,
  VERSIONS_BACKUP_FORMAT,
  VERSIONS_FORMAT,
  VERSIONS_VERSION,
  WORKSPACE_BACKUP_FORMAT,
  WORKSPACE_FORMAT,
  WORKSPACE_VERSION,
  checkCandidatesRecordLimits,
  checkVersionSnapshotLimits,
  checkVersionsRecordLimits,
  captureWorkspaceRuntime,
  checkWorkspaceRecordLimits,
  commitWorkspaceTransition,
  constraintsBindingMatches,
  createApplyLink,
  createCandidatesRecord,
  createConstraintsBinding,
  createLogicalId,
  createUnverifiedConstraintsAck,
  createVersionsRecord,
  createWorkspaceOwner,
  createWorkspaceRecord,
  emptyAnchors,
  emptyBudgetSnapshot,
  emptyChecklist,
  emptyConstraints,
  emptySidecar,
  measureSidecarBytes,
  measureWorkspaceRecordBytes,
  nextWorkspaceRevision,
  unverifiedConstraintsAckMatches,
  validateAnchors,
  validateApplyLinks,
  validateCandidateItem,
  validateCandidatesBackup,
  validateCandidatesRecord,
  validateChecklist,
  validateConstraints,
  validateConstraintsBinding,
  validateConstraintsForScope,
  validatePlanScope,
  validateUnverifiedConstraintsAck,
  validateVersionSnapshot,
  validateVersionsBackup,
  validateVersionsRecord,
  validateWorkspaceBackup,
  validateWorkspaceOwner,
  validateWorkspaceRecord,
  validateWorkspaceSidecar,
  workspaceIdentityMatches,
  workspaceOwnerMatches,
  workspaceRuntimeRefsMatch,
} from '../lib/workspace'
import type {
  CandidateItemV1,
  ChecklistItemV1,
  ConstraintItemV1,
  PlanScopeV1,
  VersionSnapshotV1,
  VersionsRecordV1,
  WorkspaceRecordV1,
  WorkspaceValidationFailure,
  WorkspaceValidationResult,
} from '../lib/workspace'

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
    notes: null,
    updatedAt: NOW,
    ...overrides,
  }
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

describe('workspace record builder / strict validation', () => {
  it('builds a complete record with Trip v1, empty sidecar and null budget', () => {
    const record = makeRecord()
    expect(record.format).toBe(WORKSPACE_FORMAT)
    expect(record.version).toBe(WORKSPACE_VERSION)
    expect(record.tripId).toBe(MOCK_TRIP.id)
    expect(record.budget).toBeNull()
    expect(record.sidecar).toEqual(emptySidecar())
    expect(validateWorkspaceRecord(record).ok).toBe(true)
  })

  it('rejects unknown fields at every declared layer', () => {
    expect(expectFailure(validateWorkspaceRecord({ ...makeRecord(), extra: true })).reason).toBe(
      'unknown_field',
    )
    expect(
      expectFailure(
        validateWorkspaceRecord({
          ...makeRecord(),
          sidecar: { ...emptySidecar(), extra: true },
        }),
      ).reason,
    ).toBe('unknown_field')
    expect(
      expectFailure(
        validateWorkspaceRecord({
          ...makeRecord(),
          meta: { createdAt: NOW, label: null, extra: true },
        }),
      ).reason,
    ).toBe('unknown_field')
    expect(expectFailure(validateCandidateItem({ ...makeCandidate(), extra: true })).reason).toBe(
      'unknown_field',
    )
    expect(expectFailure(validateVersionSnapshot({ ...makeVersion(), extra: true })).reason).toBe(
      'unknown_field',
    )
  })

  it('rejects missing fields and Trip v1 id mismatch', () => {
    const { meta: _meta, ...withoutMeta } = makeRecord()
    expect(expectFailure(validateWorkspaceRecord(withoutMeta)).reason).toBe('missing_field')
    expect(expectFailure(validateWorkspaceRecord({ ...makeRecord(), tripId: 'other-trip' })).reason).toBe(
      'invalid_field',
    )
  })

  it('uses checkTripShape as the Trip gate and never accepts a non-Trip', () => {
    expect(
      expectFailure(
        validateWorkspaceRecord({ ...makeRecord(), trip: { ...makeTrip(), days: [] } }),
      ).reason,
    ).toBe('invalid_trip')
  })

  it('measures real UTF-8 bytes, including CJK and emoji', () => {
    const record = makeRecord({ meta: { createdAt: NOW, label: '杭州🚄' } })
    const expected = new TextEncoder().encode(JSON.stringify(record)).length
    expect(measureWorkspaceRecordBytes(record)).toBe(expected)
    expect(expected).toBeGreaterThan(JSON.stringify(record).length)
  })
})

describe('sidecar and sub-section limits', () => {
  it('rejects a sidecar over 512 KiB without truncating', () => {
    const applies = Array.from({ length: 1000 }, (_, index) => ({
      candidateId: `c${String(index).padStart(4, '0')}`.padEnd(200, 'x'),
      tripId: 't'.repeat(200),
      day: 1,
      stopId: `s${String(index).padStart(4, '0')}`.padEnd(200, 'y'),
    }))
    const sidecar = { ...emptySidecar(), applies }
    expect(measureSidecarBytes(sidecar)).toBeGreaterThan(MAX_WORKSPACE_SIDECAR_BYTES)
    expect(expectFailure(validateWorkspaceSidecar(sidecar)).reason).toBe('limit_exceeded')
  })

  it('does not enforce arbitrary byte caps on the sidecar sub-sections themselves', () => {
    expect(validateAnchors(emptyAnchors()).ok).toBe(true)
    expect(validateConstraints(emptyConstraints()).ok).toBe(true)
    expect(validateChecklist(emptyChecklist()).ok).toBe(true)
  })
})

describe('F1 anchors', () => {
  it('accepts a stop anchor and a manual anchor with the right shape', () => {
    const anchors = emptyAnchors()
    anchors.daily['1'] = {
      start: {
        anchorId: 'anchor-1',
        kind: 'stop',
        stopId: 's1',
        hotelId: 'hotel-1',
        name: '断桥残雪',
        address: null,
        location: null,
        time: '09:00',
        date: '2026-04-03',
      },
      end: {
        anchorId: 'anchor-2',
        kind: 'manual',
        stopId: null,
        hotelId: 'hotel-1',
        name: '酒店大堂',
        address: null,
        location: null,
        time: null,
        date: null,
      },
    }
    expect(validateAnchors(anchors).ok).toBe(true)
  })

  it('rejects non-canonical day keys, empty daily entries and dangling kind/stop combinations', () => {
    const anchors = emptyAnchors()
    anchors.daily['01'] = {
      start: {
        anchorId: 'a',
        kind: 'manual',
        stopId: null,
        hotelId: null,
        name: '某处',
        address: null,
        location: null,
        time: null,
        date: null,
      },
      end: null,
    }
    expect(expectFailure(validateAnchors(anchors)).reason).toBe('invalid_field')

    const emptyDaily = emptyAnchors()
    emptyDaily.daily['1'] = { start: null, end: null }
    expect(expectFailure(validateAnchors(emptyDaily)).reason).toBe('invalid_field')

    const stopWithoutId = emptyAnchors()
    stopWithoutId.daily['1'] = {
      start: {
        anchorId: 'a',
        kind: 'stop',
        stopId: null,
        hotelId: null,
        name: '某处',
        address: null,
        location: null,
        time: null,
        date: null,
      },
      end: null,
    }
    expect(expectFailure(validateAnchors(stopWithoutId)).reason).toBe('invalid_field')

    const manualWithStop = emptyAnchors()
    manualWithStop.daily['1'] = {
      start: {
        anchorId: 'a',
        kind: 'manual',
        stopId: 's1',
        hotelId: null,
        name: '某处',
        address: null,
        location: null,
        time: null,
        date: null,
      },
      end: null,
    }
    expect(expectFailure(validateAnchors(manualWithStop)).reason).toBe('invalid_field')
  })

  it('keeps unknown coordinates null and enforces locationSource consistency', () => {
    const anchors = emptyAnchors()
    anchors.accommodation = {
      hotelId: null,
      name: '某酒店',
      address: null,
      location: null,
      locationSource: null,
      checkInDate: '2026-04-03',
      checkOutDate: '2026-04-05',
    }
    expect(validateAnchors(anchors).ok).toBe(true)

    anchors.accommodation.location = { lng: 120.1, lat: 30.2 }
    expect(expectFailure(validateAnchors(anchors)).reason).toBe('invalid_field')

    anchors.accommodation.location = null
    anchors.accommodation.locationSource = 'user_provided'
    expect(expectFailure(validateAnchors(anchors)).reason).toBe('invalid_field')
  })

  it('rejects impossible calendar dates and non-HH:MM times', () => {
    const anchors = emptyAnchors()
    anchors.arrival = {
      kind: 'airport',
      name: '机场',
      date: '2026-02-30',
      time: '9:00',
      location: null,
    }
    expect(expectFailure(validateAnchors(anchors)).reason).toBe('invalid_field')
  })
})

describe('F2 constraints', () => {
  it('accepts a complete fixed window and a null-time reminder', () => {
    const reminders = makeConstraint({
      id: 'reminder-1',
      kind: 'reminder',
      day: null,
      stopId: null,
      startDate: null,
      endDate: null,
      startTime: null,
      endTime: null,
      durationMinutes: null,
      priority: 0,
    })
    expect(validateConstraints({ items: [makeConstraint(), reminders] }).ok).toBe(true)
  })

  it('accepts an initial must_visit target with null stopId and requires day + title', () => {
    const initial = makeConstraint({
      kind: 'must_visit',
      day: 2,
      stopId: null,
      startDate: null,
      endDate: null,
      startTime: null,
      endTime: null,
      durationMinutes: null,
      title: '还没有落到 Trip 的必去点',
    })
    const parsed = expectOk(validateConstraints({ items: [initial] }))
    expect(parsed.items[0].stopId).toBeNull()
    expect(parsed.items[0].title).toBe('还没有落到 Trip 的必去点')
    expect(parsed.items[0].day).toBe(2)

    expect(
      expectFailure(
        validateConstraints({
          items: [makeConstraint({ ...initial, day: null })],
        }),
      ).reason,
    ).toBe('invalid_field')
    expect(
      expectFailure(
        validateConstraints({
          items: [makeConstraint({ ...initial, title: '   ' })],
        }),
      ).reason,
    ).toBe('invalid_field')
    expect(
      expectFailure(
        validateConstraints({
          items: [
            makeConstraint({
              startDate: null,
              startTime: null,
            }),
          ],
        }),
      ).reason,
    ).toBe('invalid_field')
  })

  it('checks bound stops against the scope day without inventing stop ids', () => {
    const record = makeRecord()
    const dayScope: PlanScopeV1 = { scope: 'day', day: 1, anchorStopId: null }
    const tripPlanScope: PlanScopeV1 = { scope: 'trip_plan', day: null, anchorStopId: null }
    const initial = {
      items: [
        makeConstraint({
          kind: 'must_visit',
          day: 1,
          stopId: null,
          startDate: null,
          endDate: null,
          startTime: null,
          endTime: null,
          durationMinutes: null,
        }),
      ],
    }

    expect(validateConstraintsForScope(initial, dayScope, record).ok).toBe(true)
    expect(validateConstraintsForScope(initial, tripPlanScope, record).ok).toBe(true)
    expect(createConstraintsBinding(record, initial, dayScope, 1).ok).toBe(true)
    expect(createConstraintsBinding(record, initial, tripPlanScope, 1).ok).toBe(true)
    expect(createUnverifiedConstraintsAck(record, initial, tripPlanScope, 1, NOW + 1).ok).toBe(true)
    expect(
      createUnverifiedConstraintsAck(
        record,
        { items: [makeConstraint({ kind: 'must_visit', day: 1, stopId: 's1' })] },
        tripPlanScope,
        1,
        NOW + 1,
      ).ok,
    ).toBe(false)

    // trip_plan 没有 request.stops：非 null stopId 一律拒绝，不能伪造。
    expect(
      expectFailure(
        createConstraintsBinding(
          record,
          { items: [makeConstraint({ kind: 'must_visit', day: 1, stopId: 's1' })] },
          tripPlanScope,
          1,
        ),
      ).reason,
    ).toBe('invalid_field')
    expect(
      expectFailure(
        createConstraintsBinding(
          record,
          { items: [makeConstraint({ kind: 'fixed_window', day: 1, stopId: 's1' })] },
          tripPlanScope,
          1,
        ),
      ).reason,
    ).toBe('invalid_field')

    // day scope 的 stopId 必须存在于该日。
    expect(
      expectFailure(
        createConstraintsBinding(
          record,
          { items: [makeConstraint({ kind: 'must_visit', day: 1, stopId: 's4' })] },
          dayScope,
          1,
        ),
      ).reason,
    ).toBe('invalid_field')

    // 把其它天的约束混入 day scope 也拒绝。
    expect(
      expectFailure(
        createConstraintsBinding(
          record,
          { items: [makeConstraint({ kind: 'must_visit', day: 2, stopId: null })] },
          dayScope,
          1,
        ),
      ).reason,
    ).toBe('invalid_field')
  })

  it('keeps duplicate titles and unknown time fields as U-level data, not structures to auto-match', () => {
    const duplicateTitles = {
      items: [
        makeConstraint({
          id: 'must-1',
          kind: 'must_visit',
          day: 1,
          stopId: null,
          title: '同名地点',
          startDate: null,
          endDate: null,
          startTime: '09:00',
          endTime: null,
          durationMinutes: null,
        }),
        makeConstraint({
          id: 'must-2',
          kind: 'must_visit',
          day: 1,
          stopId: null,
          title: '同名地点',
          startDate: null,
          endDate: null,
          startTime: '09:00',
          endTime: null,
          durationMinutes: null,
        }),
      ],
    }
    const parsed = expectOk(validateConstraints(duplicateTitles))
    expect(parsed.items).toHaveLength(2)
    expect(parsed.items[0].durationMinutes).toBeNull()
    expect(parsed.items[0].startTime).toBe('09:00')

    // 结构层允许同名；F2 必须按 §11.7 将其视为 U，不能挑第一个或声称已满足。
    expect(
      validateConstraintsForScope(
        duplicateTitles,
        { scope: 'day', day: 1, anchorStopId: null },
        makeRecord(),
      ).ok,
    ).toBe(true)
  })

  it('rejects invalid dates, duplicate ids and over-limit item counts', () => {
    expect(
      expectFailure(validateConstraints({ items: [makeConstraint({ startDate: '2026-02-30' })] })).reason,
    ).toBe('invalid_field')

    expect(
      expectFailure(
        validateConstraints({
          items: [makeConstraint({ id: 'same' }), makeConstraint({ id: 'same' })],
        }),
      ).reason,
    ).toBe('duplicate_id')

    const tooMany = Array.from({ length: MAX_CONSTRAINT_ITEMS + 1 }, (_, index) =>
      makeConstraint({ id: `constraint-${index}` }),
    )
    expect(expectFailure(validateConstraints({ items: tooMany })).reason).toBe('limit_exceeded')
  })
})

describe('F5 checklist', () => {
  it('keeps done separate from Trip and preserves originalStopId for re-linking', () => {
    const checklist = {
      items: [
        makeChecklistItem({
          done: true,
          stopId: null,
          originalStopId: 's2',
          notes: '原 stop 已删除，需要重新关联',
        }),
      ],
      appliedTemplates: [],
    }
    const record = makeRecord({ sidecar: { ...emptySidecar(), checklist } })
    expect(validateWorkspaceRecord(record).ok).toBe(true)
    expect(JSON.stringify(record.trip)).toBe(JSON.stringify(MOCK_TRIP))
  })

  it('rejects duplicate item ids and template ids', () => {
    expect(
      expectFailure(
        validateChecklist({
          items: [makeChecklistItem({ id: 'same' }), makeChecklistItem({ id: 'same' })],
          appliedTemplates: [],
        }),
      ).reason,
    ).toBe('duplicate_id')
    expect(
      expectFailure(
        validateChecklist({
          items: [],
          appliedTemplates: ['template-1', 'template-1'],
        }),
      ).reason,
    ).toBe('duplicate_id')
  })

  it('rejects an over-limit checklist without dropping items', () => {
    const items = Array.from({ length: MAX_CHECKLIST_ITEMS + 1 }, (_, index) =>
      makeChecklistItem({ id: `check-${index}` }),
    )
    expect(expectFailure(validateChecklist({ items, appliedTemplates: [] })).reason).toBe(
      'limit_exceeded',
    )
  })
})

describe('F3 candidates', () => {
  it('accepts manual and copied sources with explicit null coordinates', () => {
    const manual = makeCandidate()
    const copied = makeCandidate({
      id: 'candidate-2',
      source: 'copied',
      copiedFromStopId: 's1',
      location: { lng: 120.1, lat: 30.2 },
    })
    expect(validateCandidateItem(manual).ok).toBe(true)
    expect(validateCandidateItem(copied).ok).toBe(true)
    expect(expectOk(validateCandidateItem(manual)).location).toBeNull()
  })

  it('rejects source/copiedFromStopId mismatches and invalid priorities', () => {
    expect(
      expectFailure(validateCandidateItem(makeCandidate({ source: 'copied' }))).reason,
    ).toBe('invalid_field')
    expect(
      expectFailure(
        validateCandidateItem(makeCandidate({ copiedFromStopId: 's1' })),
      ).reason,
    ).toBe('invalid_field')
    expect(expectFailure(validateCandidateItem(makeCandidate({ priority: 4 }))).reason).toBe(
      'invalid_field',
    )
  })

  it('rejects duplicate tags, duplicate ids and over-limit counts', () => {
    expect(
      expectFailure(
        validateCandidateItem(makeCandidate({ tags: ['西湖', '西湖'] })),
      ).reason,
    ).toBe('duplicate_id')
    expect(
      expectFailure(
        validateCandidatesRecord({
          format: CANDIDATES_FORMAT,
          version: CANDIDATES_VERSION,
          items: [makeCandidate({ id: 'same' }), makeCandidate({ id: 'same' })],
          updatedAt: NOW,
        }),
      ).reason,
    ).toBe('duplicate_id')

    const tooMany = Array.from({ length: MAX_CANDIDATES_COUNT + 1 }, (_, index) =>
      makeCandidate({ id: `candidate-${index}` }),
    )
    expect(
      expectFailure(
        validateCandidatesRecord({
          format: CANDIDATES_FORMAT,
          version: CANDIDATES_VERSION,
          items: tooMany,
          updatedAt: NOW,
        }),
      ).reason,
    ).toBe('limit_exceeded')
  })

  it('rejects a candidate library over 256 KiB without eviction', () => {
    const items = Array.from({ length: 200 }, (_, index) =>
      makeCandidate({
        id: `candidate-${index}`,
        name: '名'.repeat(120),
        address: '址'.repeat(300),
        notes: '注'.repeat(500),
        tags: Array.from({ length: MAX_CANDIDATE_TAGS }, (_, tagIndex) =>
          `tag-${tagIndex}`.padEnd(50, 'x'),
        ),
      }),
    )
    const record = {
      format: CANDIDATES_FORMAT,
      version: CANDIDATES_VERSION,
      items,
      updatedAt: NOW,
    } as const
    expect(checkCandidatesRecordLimits(record).ok).toBe(false)
    expect(expectFailure(validateCandidatesRecord(record)).reason).toBe('limit_exceeded')
  })

  it('validates apply links and rejects duplicate use relations', () => {
    expect(createApplyLink('candidate-1', MOCK_TRIP.id, 1, 's1').ok).toBe(true)
    expect(expectFailure(createApplyLink('candidate-1', MOCK_TRIP.id, 0, 's1')).reason).toBe(
      'invalid_field',
    )
    expect(
      expectFailure(
        validateApplyLinks([
          { candidateId: 'candidate-1', tripId: MOCK_TRIP.id, day: 1, stopId: 's1' },
          { candidateId: 'candidate-1', tripId: MOCK_TRIP.id, day: 1, stopId: 's1' },
        ]),
      ).reason,
    ).toBe('duplicate_id')
  })
})

describe('F4 versions', () => {
  it('accepts a snapshot with explicit null budget and keeps it immutable by value', () => {
    const snapshot = expectOk(validateVersionSnapshot(makeVersion()))
    expect(snapshot.budget).toBeNull()
    expect(snapshot.workspaceRevision).toBe(0)
  })

  it('rejects duplicate ids and over-limit version counts', () => {
    expect(
      expectFailure(
        validateVersionsRecord({
          format: VERSIONS_FORMAT,
          version: VERSIONS_VERSION,
          items: [makeVersion({ id: 'same' }), makeVersion({ id: 'same' })],
          updatedAt: NOW,
        }),
      ).reason,
    ).toBe('duplicate_id')

    const tooMany = Array.from({ length: MAX_VERSIONS_COUNT + 1 }, (_, index) =>
      makeVersion({ id: `version-${index}` }),
    )
    expect(
      expectFailure(
        validateVersionsRecord({
          format: VERSIONS_FORMAT,
          version: VERSIONS_VERSION,
          items: tooMany,
          updatedAt: NOW,
        }),
      ).reason,
    ).toBe('limit_exceeded')
  })

  it('enforces snapshot and total byte guards without dropping versions', () => {
    const oversized = {
      ...makeVersion(),
      budget: { budgetRaw: 'x'.repeat(MAX_VERSION_SNAPSHOT_BYTES + 1024), rows: [] },
    }
    expect(checkVersionSnapshotLimits(oversized).ok).toBe(false)

    const totalRecord: VersionsRecordV1 = {
      format: VERSIONS_FORMAT,
      version: VERSIONS_VERSION,
      items: Array.from({ length: MAX_VERSIONS_COUNT }, (_, index) => ({
        ...makeVersion({ id: `version-${index}` }),
        budget: { budgetRaw: 'x'.repeat(500_000), rows: [] },
      })),
      updatedAt: NOW,
    }
    expect(checkVersionsRecordLimits(totalRecord).ok).toBe(false)
  })

  it('builds a versions record from explicit items', () => {
    const record = expectOk(createVersionsRecord([makeVersion()], NOW))
    expect(record.items).toHaveLength(1)
    expect(record.format).toBe(VERSIONS_FORMAT)
  })
})

describe('capacity guards for record-level safety nets', () => {
  it('rejects a workspace record over 2 MiB even before storage', () => {
    const record = {
      ...makeRecord(),
      meta: { createdAt: NOW, label: 'x'.repeat(MAX_WORKSPACE_RECORD_BYTES + 1024) },
    }
    expect(checkWorkspaceRecordLimits(record).ok).toBe(false)
  })

  it('rejects a version snapshot over 2 MiB even when called directly', () => {
    const snapshot = {
      ...makeVersion(),
      budget: { budgetRaw: 'x'.repeat(MAX_VERSION_SNAPSHOT_BYTES + 1024), rows: [] },
    }
    expect(checkVersionSnapshotLimits(snapshot).ok).toBe(false)
  })
})

describe('revision / transition', () => {
  it('increments revision monotonically and refuses overflow', () => {
    expect(expectOk(nextWorkspaceRevision(0))).toBe(1)
    expect(expectFailure(nextWorkspaceRevision(-1)).reason).toBe('invalid_field')
    expect(
      expectFailure(nextWorkspaceRevision(MAX_SAFE_WORKSPACE_REVISION)).reason,
    ).toBe('limit_exceeded')
  })

  it('switches Trip + sidecar + budget together and bumps revision by exactly one', () => {
    const record = makeRecord({ budget: emptyBudgetSnapshot() })
    const next = expectOk(
      commitWorkspaceTransition(
        record,
        { budget: null, label: '采用后' },
        NOW + 1,
      ),
    )
    expect(next.workspaceRevision).toBe(record.workspaceRevision + 1)
    expect(next.budget).toBeNull()
    expect(next.meta.createdAt).toBe(record.meta.createdAt)
    expect(next.meta.label).toBe('采用后')
    expect(record.budget).not.toBeNull()
  })

  it('never changes trip identity via transition', () => {
    const record = makeRecord()
    const otherTrip = { ...makeTrip(), id: 'other-trip' }
    expect(expectFailure(commitWorkspaceTransition(record, { trip: otherTrip }, NOW + 1)).reason).toBe(
      'invalid_field',
    )
  })

  it('fails closed and leaves the original record untouched on an oversized next state', () => {
    const record = makeRecord()
    const before = JSON.stringify(record)
    const applies = Array.from({ length: 1000 }, (_, index) => ({
      candidateId: `c${index}`.padEnd(200, 'x'),
      tripId: 't'.repeat(200),
      day: 1,
      stopId: `s${index}`.padEnd(200, 'y'),
    }))
    const next = commitWorkspaceTransition(
      record,
      { sidecar: { ...emptySidecar(), applies } },
      NOW + 1,
    )
    expect(next.ok).toBe(false)
    expect(JSON.stringify(record)).toBe(before)
  })
})

describe('owner / binding / acknowledgement', () => {
  it('owner token matches only the same full canonical record + epoch', () => {
    const record = makeRecord()
    const owner = expectOk(createWorkspaceOwner(record, 7))
    expect(validateWorkspaceOwner(owner).ok).toBe(true)
    expect(workspaceOwnerMatches(owner, record, 7)).toBe(true)
    expect(workspaceOwnerMatches(owner, record, 8)).toBe(false)
    expect(workspaceIdentityMatches(owner, record)).toBe(true)

    const changed = expectOk(commitWorkspaceTransition(record, {}, NOW + 1))
    expect(workspaceOwnerMatches(owner, changed, 7)).toBe(false)
  })

  it('captures actual runtime refs and rejects same-content new refs / stale epochs', () => {
    const record = makeRecord()
    const capture = expectOk(captureWorkspaceRuntime(record, 3))
    expect(workspaceRuntimeRefsMatch(capture, record, 3)).toBe(true)
    expect(workspaceRuntimeRefsMatch(capture, record, 4)).toBe(false)

    // 同内容但新对象引用：内容 helper 可能仍相等，runtime 门必须先拒绝。
    const sameContent = clone(record)
    expect(workspaceRuntimeRefsMatch(capture, sameContent, 3)).toBe(false)
    const transitioned = expectOk(commitWorkspaceTransition(record, {}, NOW + 1))
    expect(workspaceRuntimeRefsMatch(capture, transitioned, 3)).toBe(false)

    // candidate / version / input 也按实际引用比较，而不是只看内容。
    const candidate = makeCandidate()
    const withCandidate = expectOk(captureWorkspaceRuntime(record, 3, { candidate }))
    expect(workspaceRuntimeRefsMatch(withCandidate, record, 3, { candidate })).toBe(true)
    expect(
      workspaceRuntimeRefsMatch(withCandidate, record, 3, { candidate: clone(candidate) }),
    ).toBe(false)
  })

  it('constraints binding invalidates on revision, content, scope and epoch changes', () => {
    const constraints = { items: [makeConstraint()] }
    const record = makeRecord({ sidecar: { ...emptySidecar(), constraints } })
    const scope: PlanScopeV1 = { scope: 'day', day: 1, anchorStopId: null }
    const binding = expectOk(createConstraintsBinding(record, constraints, scope, 3))
    expect(validateConstraintsBinding(binding).ok).toBe(true)
    expect(constraintsBindingMatches(binding, record, constraints, 3)).toBe(true)
    expect(
      constraintsBindingMatches(binding, record, { items: [makeConstraint({ title: '改了' })] }, 3),
    ).toBe(false)
    expect(constraintsBindingMatches(binding, record, constraints, 4)).toBe(false)

    const changedRecord = expectOk(
      commitWorkspaceTransition(record, { budget: emptyBudgetSnapshot() }, NOW + 1),
    )
    expect(constraintsBindingMatches(binding, changedRecord, constraints, 3)).toBe(false)

    expect(
      expectFailure(
        createConstraintsBinding(record, constraints, { ...scope, anchorStopId: 'missing' }, 3),
      ).reason,
    ).toBe('invalid_field')
  })

  it('U-level acknowledgement expires with content, revision and epoch', () => {
    const constraints = { items: [makeConstraint()] }
    const record = makeRecord({ sidecar: { ...emptySidecar(), constraints } })
    const scope: PlanScopeV1 = { scope: 'day', day: 1, anchorStopId: null }
    const ack = expectOk(createUnverifiedConstraintsAck(record, constraints, scope, 5, NOW + 1))
    expect(validateUnverifiedConstraintsAck(ack).ok).toBe(true)
    expect(unverifiedConstraintsAckMatches(ack, record, constraints, 5)).toBe(true)
    expect(
      unverifiedConstraintsAckMatches(
        ack,
        record,
        { items: [makeConstraint({ notes: '新备注' })] },
        5,
      ),
    ).toBe(false)
    expect(unverifiedConstraintsAckMatches(ack, record, constraints, 6)).toBe(false)

    const changedRecord = expectOk(
      commitWorkspaceTransition(record, { budget: emptyBudgetSnapshot() }, NOW + 1),
    )
    expect(unverifiedConstraintsAckMatches(ack, changedRecord, constraints, 5)).toBe(false)
  })

  it('binds tail scope to an existing anchor stop', () => {
    const record = makeRecord()
    const scope: PlanScopeV1 = { scope: 'day_tail', day: 1, anchorStopId: 's2' }
    expect(validatePlanScope(scope, record).ok).toBe(true)
    expect(
      expectFailure(validatePlanScope({ ...scope, anchorStopId: 'missing' }, record)).reason,
    ).toBe('invalid_field')
    expect(
      expectFailure(validatePlanScope({ scope: 'trip_plan', day: 1, anchorStopId: null }, record)).reason,
    ).toBe('invalid_field')
  })
})

describe('backups are separate, strict and bounded', () => {
  it('validates a workspace backup and its actual file byte limit', () => {
    const backup = {
      format: WORKSPACE_BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: NOW,
      workspace: makeRecord(),
    }
    expect(validateWorkspaceBackup(backup).ok).toBe(true)
    expect(expectFailure(validateWorkspaceBackup({ ...backup, extra: true })).reason).toBe(
      'unknown_field',
    )
    expect(
      expectFailure(validateWorkspaceBackup(backup, MAX_WORKSPACE_BACKUP_FILE_BYTES + 1)).reason,
    ).toBe('limit_exceeded')
  })

  it('validates candidates and versions backups as independent libraries', () => {
    const candidates = expectOk(createCandidatesRecord([makeCandidate()], NOW))
    const candidatesBackup = {
      format: CANDIDATES_BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: NOW,
      candidates,
    }
    expect(validateCandidatesBackup(candidatesBackup).ok).toBe(true)
    expect(expectFailure(validateCandidatesBackup({ ...candidatesBackup, format: 'wrong' })).reason).toBe(
      'invalid_field',
    )

    const versions = expectOk(createVersionsRecord([makeVersion()], NOW))
    const versionsBackup = {
      format: VERSIONS_BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: NOW,
      versions,
    }
    expect(validateVersionsBackup(versionsBackup).ok).toBe(true)
    expect(expectFailure(validateVersionsBackup({ ...versionsBackup, extra: true })).reason).toBe(
      'unknown_field',
    )
  })
})

describe('logical ids', () => {
  it('creates random-looking non-empty ids without browser fingerprinting', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createLogicalId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
  })
})

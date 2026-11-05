/**
 * F5 清单纯函数测试：增改勾选不可变、模板只建议、关联消失不丢任务、
 * 约束删除提案、字段 null / 0 / 空、容量与无效输入保旧、F6 有效清单投影。
 * 不读写 storage、不请求网络、不修改 Trip。
 */
import { describe, expect, it } from 'vitest'

import type { Trip, TripStop } from '../lib/api'
import type {
  ChecklistItemV1,
  ChecklistV1,
  ConstraintItemV1,
} from '../lib/workspaceTypes'
import { emptyChecklist, validateChecklist } from '../lib/workspace'
import {
  CHECKLIST_RELINK_NOTES,
  addChecklistItem,
  applyChecklistTemplate,
  auditChecklistLinks,
  buildEffectiveChecklist,
  checklistItemConstraintState,
  checklistItemNeedsRelink,
  checklistSummary,
  constraintMatchesChecklistItem,
  deleteChecklistItem,
  linkChecklistItemToConstraint,
  linkChecklistItemToStop,
  listChecklistTemplateSuggestions,
  markChecklistItemNeedsRelink,
  measureChecklistBytes,
  planConstraintRemovalImpact,
  setChecklistItemDone,
  toggleChecklistItem,
  unlinkChecklistItem,
  unlinkChecklistItemFromConstraint,
  updateChecklistItem,
} from '../lib/checklist'

const NOW = 1_760_000_000_000
const LATER = NOW + 60_000

function makeItem(overrides: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return {
    id: 'check-1',
    category: 'ticket',
    title: '核对机票订单',
    done: false,
    date: null,
    day: null,
    stopId: null,
    originalStopId: null,
    notes: null,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeChecklist(items: ChecklistItemV1[] = [], appliedTemplates: string[] = []): ChecklistV1 {
  return { items, appliedTemplates }
}

function makeStop(id: string, name: string): TripStop {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: 60,
    description: '',
    address: '',
    location: null,
  }
}

function makeTrip(stops: TripStop[] = [makeStop('s1', '博物馆')]): Trip {
  return {
    id: 'trip-1',
    source: 'example',
    destination: '苏州',
    title: '测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: [
      {
        day: 1,
        date: '2026-04-03',
        title: '第一天',
        summary: '',
        stops,
        legs: [],
      },
    ],
  }
}

function makeConstraint(overrides: Partial<ConstraintItemV1> = {}): ConstraintItemV1 {
  return {
    id: 'c1',
    kind: 'fixed_window',
    day: 1,
    stopId: 's1',
    title: '博物馆预约',
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

function expectOk(result: ReturnType<typeof addChecklistItem>): ChecklistV1 {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

describe('checklist add / edit / toggle / delete', () => {
  it('adds a not-done item with null fields, without mutating the input', () => {
    const before = makeChecklist([makeItem({ id: 'keep' })])
    const snapshot = JSON.stringify(before)
    const result = addChecklistItem(
      before,
      {
        category: 'document',
        title: '  护照  ',
        date: '',
        day: null,
        stopId: '',
        notes: '',
      },
      { id: 'check-2', now: LATER },
    )
    const after = expectOk(result)
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(after).not.toBe(before)
    expect(after.items).not.toBe(before.items)
    expect(after.items).toHaveLength(2)
    expect(after.items[1]).toEqual({
      id: 'check-2',
      category: 'document',
      title: '护照',
      done: false,
      date: null,
      day: null,
      stopId: null,
      originalStopId: null,
      notes: null,
      updatedAt: LATER,
    })
  })

  it('keeps null distinct from 0 and rejects invalid date / day / title / notes', () => {
    const base = makeChecklist()
    const ok = expectOk(
      addChecklistItem(
        base,
        { category: 'todo', title: '待确认', date: null, day: null, notes: null },
        { id: 'n1', now: NOW },
      ),
    )
    expect(ok.items[0].day).toBeNull()
    expect(ok.items[0].date).toBeNull()
    expect(ok.items[0].notes).toBeNull()

    const cases = [
      { input: { category: 'todo' as const, title: ' ', date: null, day: null }, label: 'empty title' },
      { input: { category: 'todo' as const, title: 'x'.repeat(201), date: null, day: null }, label: 'long title' },
      { input: { category: 'todo' as const, title: 'ok', date: null, day: 0 }, label: 'day 0' },
      { input: { category: 'todo' as const, title: 'ok', date: '2026-02-30', day: null }, label: 'bad date' },
      { input: { category: 'todo' as const, title: 'ok', date: null, day: null, notes: 'n'.repeat(1001) }, label: 'long notes' },
    ]
    for (const entry of cases) {
      const before = JSON.stringify(base)
      const result = addChecklistItem(base, entry.input, { id: `bad-${entry.label}`, now: NOW })
      expect(result.ok, entry.label).toBe(false)
      expect(JSON.stringify(base)).toBe(before)
    }
  })

  it('updates editable fields only, preserving id / done / stop / originalStopId', () => {
    const before = makeChecklist([
      makeItem({ id: 'a', done: true, stopId: 's1', originalStopId: 'old', notes: '旧备注' }),
    ])
    const beforeSnapshot = JSON.stringify(before)
    const after = expectOk(
      updateChecklistItem(
        before,
        'a',
        { category: 'appointment', title: '  新标题  ', date: '2026-04-04', day: 2, notes: '' },
        LATER,
      ),
    )
    expect(after.items[0]).toMatchObject({
      id: 'a',
      category: 'appointment',
      title: '新标题',
      done: true,
      date: '2026-04-04',
      day: 2,
      stopId: 's1',
      originalStopId: 'old',
      notes: null,
      updatedAt: LATER,
    })
    expect(JSON.stringify(before.items[0])).not.toBe(JSON.stringify(after.items[0]))
    const failed = updateChecklistItem(before, 'a', { title: '   ' }, LATER)
    expect(failed.ok).toBe(false)
    expect(JSON.stringify(before)).toBe(beforeSnapshot)
  })

  it('toggles done without touching the Trip object', () => {
    const trip = makeTrip()
    const tripSnapshot = JSON.stringify(trip)
    const before = makeChecklist([makeItem({ done: false })])
    const done = expectOk(setChecklistItemDone(before, 'check-1', true, LATER))
    expect(done.items[0].done).toBe(true)
    expect(JSON.stringify(trip)).toBe(tripSnapshot)
    const back = expectOk(toggleChecklistItem(done, 'check-1', LATER + 1))
    expect(back.items[0].done).toBe(false)
    expect(JSON.stringify(trip)).toBe(tripSnapshot)
  })

  it('deletes only the checklist item and keeps templates / other items', () => {
    const before = makeChecklist([makeItem({ id: 'a' }), makeItem({ id: 'b' })], ['flight'])
    const after = expectOk(deleteChecklistItem(before, 'a'))
    expect(after.items.map((item) => item.id)).toEqual(['b'])
    expect(after.appliedTemplates).toEqual(['flight'])
    expect(deleteChecklistItem(before, 'missing').ok).toBe(false)
  })

  it('rejects duplicate ids without mutating the input', () => {
    const before = makeChecklist([makeItem({ id: 'dup' })])
    const result = addChecklistItem(
      before,
      { category: 'todo', title: '重复' },
      { id: 'dup', now: NOW },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('duplicate_id')
    expect(before.items).toHaveLength(1)
  })

  it('fails at 300 items and on checklist bytes over the sidecar limit, keeping the old value', () => {
    const full = makeChecklist(
      Array.from({ length: 300 }, (_, index) => makeItem({ id: `i-${index}`, title: `事项 ${index}` })),
    )
    const fullSnapshot = JSON.stringify(full)
    const tooMany = addChecklistItem(full, { category: 'todo', title: '第 301 项' }, { id: 'i-301', now: NOW })
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.reason).toBe('limit_exceeded')
    expect(JSON.stringify(full)).toBe(fullSnapshot)

    const heavy = makeChecklist(
      Array.from({ length: 200 }, (_, index) =>
        makeItem({ id: `h-${index}`, title: `重项 ${index}`, notes: '需'.repeat(1000) }),
      ),
    )
    expect(measureChecklistBytes(heavy)).toBeGreaterThan(524_288)
    const heavySnapshot = JSON.stringify(heavy)
    const tooHeavy = addChecklistItem(heavy, { category: 'todo', title: '再一项' }, { id: 'h-extra', now: NOW })
    expect(tooHeavy.ok).toBe(false)
    if (!tooHeavy.ok) {
      expect(tooHeavy.reason).toBe('limit_exceeded')
      expect(tooHeavy.message).toContain('字节')
    }
    expect(JSON.stringify(heavy)).toBe(heavySnapshot)
  })
})

describe('checklist templates', () => {
  it('produces suggestions only and never auto-adds or auto-completes', () => {
    const before = emptyChecklist()
    const snapshot = JSON.stringify(before)
    const suggestions = listChecklistTemplateSuggestions('flight', before)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(JSON.stringify(before)).toBe(snapshot)

    const result = applyChecklistTemplate(before, 'flight', {
      selectedSuggestionIds: [suggestions[0].id],
      now: LATER,
      idFactory: () => 'generated-1',
    })
    const after = expectOk(result)
    expect(after.items).toHaveLength(1)
    expect(after.items[0]).toMatchObject({ id: 'generated-1', done: false, date: null, day: null, stopId: null })
    expect(after.appliedTemplates).toEqual(['flight'])
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('requires an explicit selection and rejects unknown templates', () => {
    const before = emptyChecklist()
    const none = applyChecklistTemplate(before, 'flight', {
      selectedSuggestionIds: [],
      now: NOW,
      idFactory: () => 'x',
    })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.reason).toBe('no_selection')
    expect(before.items).toHaveLength(0)

    const unknown = applyChecklistTemplate(before, 'missing', {
      selectedSuggestionIds: ['whatever'],
      now: NOW,
      idFactory: () => 'x',
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toBe('template_unknown')

    const unknownSuggestion = applyChecklistTemplate(before, 'flight', {
      selectedSuggestionIds: ['missing-suggestion'],
      now: NOW,
      idFactory: () => 'x',
    })
    expect(unknownSuggestion.ok).toBe(false)
    if (!unknownSuggestion.ok) expect(unknownSuggestion.reason).toBe('suggestion_unknown')
  })

  it('records a template once and allows explicit re-adding of missing items', () => {
    const first = expectOk(
      applyChecklistTemplate(emptyChecklist(), 'flight', {
        selectedSuggestionIds: ['flight-order'],
        now: NOW,
        idFactory: () => 'one',
      }),
    )
    const second = expectOk(
      applyChecklistTemplate(first, 'flight', {
        selectedSuggestionIds: ['flight-document'],
        now: LATER,
        idFactory: () => 'two',
      }),
    )
    expect(second.items.map((item) => item.id)).toEqual(['one', 'two'])
    expect(second.items.every((item) => item.done === false)).toBe(true)
    expect(second.appliedTemplates).toEqual(['flight'])
  })

  it('fails when applied templates would exceed 50, keeping the old checklist', () => {
    const before = makeChecklist(
      [],
      Array.from({ length: 50 }, (_, index) => `template-${index}`),
    )
    const snapshot = JSON.stringify(before)
    const result = applyChecklistTemplate(before, 'flight', {
      selectedSuggestionIds: ['flight-order'],
      now: NOW,
      idFactory: () => 'x',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('limit_exceeded')
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('checklist links / deleted stop / deleted constraint', () => {
  it('links to a stop and clears originalStopId on a successful re-link', () => {
    const before = makeChecklist([makeItem({ originalStopId: 'old' })])
    const after = expectOk(linkChecklistItemToStop(before, 'check-1', { stopId: 's1', day: 1 }, LATER))
    expect(after.items[0]).toMatchObject({ stopId: 's1', originalStopId: null, day: 1 })
    expect(JSON.stringify(before.items[0])).not.toBe(JSON.stringify(after.items[0]))
  })

  it('unlinks without deleting the task and marks it for re-linking', () => {
    const before = makeChecklist([makeItem({ done: true, stopId: 's1', notes: '旧备注' })])
    const after = expectOk(unlinkChecklistItem(before, 'check-1', LATER))
    expect(after.items[0]).toMatchObject({
      id: 'check-1',
      done: true,
      stopId: null,
      originalStopId: 's1',
      notes: `旧备注\n${CHECKLIST_RELINK_NOTES.stop_unlinked}`,
      updatedAt: LATER,
    })
    expect(after.items).toHaveLength(1)
    expect(checklistItemNeedsRelink(after.items[0])).toBe(true)
  })

  it('marks a deleted stop while preserving title / notes / done / originalStopId', () => {
    const before = makeChecklist([makeItem({ done: true, title: '博物馆门票', stopId: 'gone', notes: '保留我' })])
    const snapshot = JSON.stringify(before)
    const after = expectOk(markChecklistItemNeedsRelink(before, 'check-1', 'stop_deleted', LATER))
    expect(after.items[0]).toMatchObject({
      title: '博物馆门票',
      done: true,
      stopId: null,
      originalStopId: 'gone',
      notes: `保留我\n${CHECKLIST_RELINK_NOTES.stop_deleted}`,
    })
    expect(JSON.stringify(before)).toBe(snapshot)
    const twice = expectOk(markChecklistItemNeedsRelink(after, 'check-1', 'stop_deleted', LATER + 1))
    expect(twice.items[0].notes).toBe(after.items[0].notes)
  })

  it('keeps date / day / stop when a constraint is deleted, only adding a review note', () => {
    const before = makeChecklist([
      makeItem({
        done: true,
        category: 'appointment',
        title: '博物馆预约',
        date: '2026-04-03',
        day: 1,
        stopId: 's1',
        constraintId: 'C',
      }),
    ])
    const after = expectOk(markChecklistItemNeedsRelink(before, 'check-1', 'constraint_deleted', LATER))
    expect(after.items[0]).toMatchObject({
      constraintId: 'C',
      done: true,
      date: '2026-04-03',
      day: 1,
      stopId: 's1',
      notes: CHECKLIST_RELINK_NOTES.constraint_deleted,
    })
  })

  it('writes the real constraint id while keeping copied date / day / stop anchors', () => {
    const trip = makeTrip()
    const tripSnapshot = JSON.stringify(trip)
    const constraint = makeConstraint()
    const constraintSnapshot = JSON.stringify(constraint)
    const before = makeChecklist([makeItem({ date: '2026-01-01', day: 3, stopId: null })])
    const after = expectOk(linkChecklistItemToConstraint(before, 'check-1', constraint, LATER))
    expect(after.items[0]).toMatchObject({
      constraintId: 'c1',
      date: '2026-04-03',
      day: 1,
      stopId: 's1',
      originalStopId: null,
    })
    expect(JSON.stringify(constraint)).toBe(constraintSnapshot)
    expect(JSON.stringify(trip)).toBe(tripSnapshot)
  })

  it('unlinks only the constraint id and leaves date / day / stop / notes / done intact', () => {
    const linked = makeChecklist([
      makeItem({
        category: 'appointment',
        constraintId: 'C',
        done: true,
        date: '2026-04-05',
        day: 2,
        stopId: 's1',
        notes: '用户手工备注',
      }),
    ])
    const unlinked = expectOk(unlinkChecklistItemFromConstraint(linked, 'check-1', LATER))
    expect(unlinked.items[0]).toMatchObject({
      constraintId: null,
      done: true,
      date: '2026-04-05',
      day: 2,
      stopId: 's1',
      notes: '用户手工备注',
    })
    const stillLinked = expectOk(
      linkChecklistItemToConstraint(linked, 'check-1', makeConstraint({ id: 'C' }), LATER),
    )
    const stopUnlinked = expectOk(unlinkChecklistItem(stillLinked, 'check-1', LATER + 1))
    expect(stopUnlinked.items[0].constraintId).toBe('C')

    const legacy = makeChecklist([makeItem({ id: 'legacy', stopId: null })])
    const legacyUnlinked = expectOk(unlinkChecklistItemFromConstraint(legacy, 'legacy', LATER))
    expect(Object.hasOwn(legacyUnlinked.items[0], 'constraintId')).toBe(false)
    const explicit = makeChecklist([makeItem({ id: 'explicit', constraintId: null, stopId: null })])
    const explicitUnlinked = expectOk(unlinkChecklistItemFromConstraint(explicit, 'explicit', LATER))
    expect(explicitUnlinked.items[0].constraintId).toBeNull()
  })

  it('fails a note append that would exceed 1000 characters, keeping the old item', () => {
    const before = makeChecklist([makeItem({ stopId: 's1', notes: 'a'.repeat(1000) })])
    const snapshot = JSON.stringify(before)
    const result = markChecklistItemNeedsRelink(before, 'check-1', 'stop_deleted', LATER)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('checklist audit (pure proposals)', () => {
  it('reports a missing stop without mutating checklist or Trip', () => {
    const trip = makeTrip([makeStop('s1', '博物馆')])
    const tripSnapshot = JSON.stringify(trip)
    const checklist = makeChecklist([makeItem({ done: true, stopId: 's2' })])
    const checklistSnapshot = JSON.stringify(checklist)
    const audit = auditChecklistLinks(checklist, { trip })
    expect(audit.issues).toHaveLength(1)
    expect(audit.issues[0]).toMatchObject({ itemId: 'check-1', reason: 'stop_deleted', refId: 's2' })
    expect(audit.itemsNeedingRelink).toEqual(['check-1'])
    expect(JSON.stringify(checklist)).toBe(checklistSnapshot)
    expect(JSON.stringify(trip)).toBe(tripSnapshot)
  })

  it('reports an already-unlinked item and still keeps it in the list', () => {
    const checklist = makeChecklist([makeItem({ stopId: null, originalStopId: 's9' })])
    const audit = auditChecklistLinks(checklist, { trip: makeTrip() })
    expect(audit.issues[0]).toMatchObject({ reason: 'stop_unlinked', refId: 's9' })
    expect(checklist.items).toHaveLength(1)
  })

  it('uses the recorded constraintId exactly: deleting A never blames a task linked to B on the same stop', () => {
    const a = makeConstraint({
      id: 'A',
      title: '预约 A',
      stopId: 's1',
      day: 1,
      startDate: null,
      endDate: null,
      startTime: null,
      endTime: null,
      durationMinutes: null,
    })
    const b = makeConstraint({ id: 'B', title: '预约 B', stopId: 's1', day: 1 })
    const linked = expectOk(
      linkChecklistItemToConstraint(
        makeChecklist([makeItem({ category: 'appointment', stopId: 's1', day: 1, done: true })]),
        'check-1',
        b,
        LATER,
      ),
    )
    expect(linked.items[0].constraintId).toBe('B')

    const aRemoved = auditChecklistLinks(linked, {
      constraints: { items: [b] },
      previousConstraints: { items: [a, b] },
    })
    expect(aRemoved.issues).toHaveLength(0)
    expect(aRemoved.itemsNeedingRelink).toHaveLength(0)

    const bRemoved = auditChecklistLinks(linked, {
      constraints: { items: [a] },
      previousConstraints: { items: [a, b] },
    })
    expect(bRemoved.issues).toHaveLength(1)
    expect(bRemoved.issues[0]).toMatchObject({ itemId: 'check-1', reason: 'constraint_deleted', refId: 'B' })
    expect(planConstraintRemovalImpact(linked, a)).toHaveLength(0)
    expect(planConstraintRemovalImpact(linked, b)).toHaveLength(1)
    expect(constraintMatchesChecklistItem(linked.items[0], a)).toBe(false)
    expect(constraintMatchesChecklistItem(linked.items[0], b)).toBe(true)
  })

  it('does not auto-bind a same-name, same-anchor constraint with a different id', () => {
    const a = makeConstraint({ id: 'A', title: '同名预约', stopId: 's1', startDate: '2026-04-03' })
    const b = makeConstraint({ id: 'B', title: '同名预约', stopId: 's1', startDate: '2026-04-03' })
    const linked = expectOk(
      linkChecklistItemToConstraint(makeChecklist([makeItem({ category: 'appointment', stopId: 's1', date: '2026-04-03' })]), 'check-1', a, LATER),
    )
    const audit = auditChecklistLinks(linked, {
      constraints: { items: [b] },
      previousConstraints: { items: [a, b] },
    })
    expect(audit.issues).toHaveLength(1)
    expect(audit.issues[0]).toMatchObject({ reason: 'constraint_deleted', refId: 'A' })
    expect(constraintMatchesChecklistItem(linked.items[0], b)).toBe(false)
    expect(planConstraintRemovalImpact(linked, b)).toHaveLength(0)
  })

  it('keeps a deleted constraint item and its foreign id, then marks needsRelink without rebinding', () => {
    const linked = expectOk(
      linkChecklistItemToConstraint(
        makeChecklist([
          makeItem({ category: 'appointment', done: true, stopId: 's1', day: 1, date: '2026-04-03', notes: '手工备注' }),
        ]),
        'check-1',
        makeConstraint({ id: 'C' }),
        LATER,
      ),
    )
    const snapshot = JSON.stringify(linked)
    const marked = expectOk(markChecklistItemNeedsRelink(linked, 'check-1', 'constraint_deleted', LATER + 1))
    expect(JSON.stringify(linked)).toBe(snapshot)
    expect(marked.items[0]).toMatchObject({
      id: 'check-1',
      constraintId: 'C',
      done: true,
      stopId: 's1',
      day: 1,
      date: '2026-04-03',
      notes: `手工备注\n${CHECKLIST_RELINK_NOTES.constraint_deleted}`,
    })
    expect(checklistItemNeedsRelink(marked.items[0])).toBe(true)
  })

  it('detects a known-id constraint change and keeps date / day / stop / done', () => {
    const previous = makeConstraint({ id: 'C', startDate: '2026-04-03' })
    const current = makeConstraint({ id: 'C', startDate: '2026-04-04' })
    const checklist = makeChecklist([
      makeItem({
        category: 'appointment',
        done: true,
        constraintId: 'C',
        stopId: 's1',
        day: 1,
        date: '2026-04-03',
      }),
    ])
    const audit = auditChecklistLinks(checklist, {
      constraints: { items: [current] },
      previousConstraints: { items: [previous] },
    })
    expect(audit.issues).toHaveLength(1)
    expect(audit.issues[0]).toMatchObject({ reason: 'constraint_changed', refId: 'C' })
    const marked = expectOk(markChecklistItemNeedsRelink(checklist, 'check-1', 'constraint_changed', LATER))
    expect(marked.items[0]).toMatchObject({
      constraintId: 'C',
      done: true,
      date: '2026-04-03',
      day: 1,
      stopId: 's1',
    })
    expect(marked.items[0].notes).toBe(CHECKLIST_RELINK_NOTES.constraint_changed)
  })

  it('does not infer a constraint change from manually edited item anchors', () => {
    const same = makeConstraint({ id: 'C', startDate: '2026-04-03' })
    const checklist = makeChecklist([
      makeItem({
        category: 'appointment',
        constraintId: 'C',
        date: '2026-04-09',
        day: 5,
        stopId: 's9',
      }),
    ])
    const audit = auditChecklistLinks(checklist, {
      constraints: { items: [same] },
      previousConstraints: { items: [same] },
    })
    expect(audit.issues).toHaveLength(0)
    expect(audit.unrecordedConstraintItems).toHaveLength(0)
  })

  it('keeps legacy undefined apart from explicit null and never invents associations from previous constraints', () => {
    const removed = makeConstraint()
    const legacy = makeItem({ category: 'appointment', stopId: 's1', date: '2026-04-03', day: 1 })
    expect(checklistItemConstraintState(legacy)).toBe('unrecorded')
    const legacyAudit = auditChecklistLinks(makeChecklist([legacy]), {
      constraints: { items: [] },
      previousConstraints: { items: [removed] },
    })
    expect(legacyAudit.issues).toHaveLength(0)
    expect(legacyAudit.unrecordedConstraintItems).toEqual(['check-1'])

    const legacyStillPresent = auditChecklistLinks(makeChecklist([legacy]), {
      constraints: { items: [removed] },
      previousConstraints: { items: [removed] },
    })
    expect(legacyStillPresent.issues).toHaveLength(0)
    expect(legacyStillPresent.unrecordedConstraintItems).toEqual(['check-1'])

    const explicitNull = makeItem({ category: 'appointment', constraintId: null, stopId: 's1' })
    expect(checklistItemConstraintState(explicitNull)).toBe('unlinked')
    const nullAudit = auditChecklistLinks(makeChecklist([explicitNull]), {
      constraints: { items: [] },
      previousConstraints: { items: [removed] },
    })
    expect(nullAudit.issues).toHaveLength(0)
    expect(nullAudit.unrecordedConstraintItems).toHaveLength(0)
  })

  it('accepts the shared optional constraintId field through the public validator', () => {
    const linked = makeChecklist([makeItem({ constraintId: 'c1' })])
    expect(validateChecklist(linked).ok).toBe(true)
    const unlinked = makeChecklist([makeItem({ constraintId: null })])
    expect(validateChecklist(unlinked).ok).toBe(true)
    const invalid = validateChecklist(makeChecklist([makeItem({ constraintId: '   ' })]))
    expect(invalid.ok).toBe(false)
  })

  it('preserves unrecorded / explicit-null / linked constraint state through every reducer and the F6 projection', () => {
    const assertState = (checklist: ChecklistV1, id: string, state: 'unrecorded' | 'unlinked' | 'linked') => {
      const item = checklist.items.find((entry) => entry.id === id)
      expect(item, id).toBeDefined()
      if (!item) return
      expect(checklistItemConstraintState(item), id).toBe(state)
      expect(Object.hasOwn(item, 'constraintId'), id).toBe(state !== 'unrecorded')
      if (state === 'linked') expect(item.constraintId, id).toBe('C')
      if (state === 'unlinked') expect(item.constraintId, id).toBeNull()
    }
    let checklist = makeChecklist([
      makeItem({ id: 'legacy', title: '旧条目', stopId: null }),
      makeItem({ id: 'explicit-null', title: '明确未关联', constraintId: null, stopId: null }),
      makeItem({ id: 'linked', title: '已关联', constraintId: 'C', stopId: null }),
    ])

    for (const id of ['legacy', 'explicit-null', 'linked']) {
      checklist = expectOk(updateChecklistItem(checklist, id, { title: `已改 ${id}`, notes: '手工备注' }, LATER))
      checklist = expectOk(toggleChecklistItem(checklist, id, LATER))
      checklist = expectOk(linkChecklistItemToStop(checklist, id, { stopId: 's1', day: 1 }, LATER))
      checklist = expectOk(markChecklistItemNeedsRelink(checklist, id, 'stop_deleted', LATER))
    }
    assertState(checklist, 'legacy', 'unrecorded')
    assertState(checklist, 'explicit-null', 'unlinked')
    assertState(checklist, 'linked', 'linked')

    checklist = expectOk(
      applyChecklistTemplate(checklist, 'flight', {
        selectedSuggestionIds: ['flight-order'],
        now: LATER,
        idFactory: () => 'template-new',
      }),
    )
    assertState(checklist, 'legacy', 'unrecorded')
    assertState(checklist, 'explicit-null', 'unlinked')
    assertState(checklist, 'linked', 'linked')
    assertState(checklist, 'template-new', 'unrecorded')

    const effective = buildEffectiveChecklist(checklist)
    expect(effective.ok).toBe(true)
    if (!effective.ok) return
    const byId = new Map(effective.value.items.map((item) => [item.id, item]))
    expect(Object.hasOwn(byId.get('legacy')!, 'constraintId')).toBe(false)
    expect(byId.get('explicit-null')!.constraintId).toBeNull()
    expect(byId.get('linked')!.constraintId).toBe('C')
    expect(Object.hasOwn(byId.get('template-new')!, 'constraintId')).toBe(false)
  })
})

describe('checklist effective view for F6', () => {
  it('returns only whitelisted fields, prepared labels, and counts', () => {
    const source = makeChecklist(
      [
        makeItem({ id: 'a', done: true, title: '<script>alert(1)</script>', notes: '<img src=x>' }),
        makeItem({ id: 'b', done: false }),
      ],
      ['flight'],
    )
    const built = buildEffectiveChecklist(source)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.value.summary).toEqual({ total: 2, prepared: 1, pending: 1 })
    expect(built.value.items.map((item) => item.preparedLabel)).toEqual(['已准备', '未准备'])
    expect(built.value.items[0].title).toBe('<script>alert(1)</script>')
    expect(built.value.items[0].notes).toBe('<img src=x>')
    expect(Object.keys(built.value.items[0]).sort()).toEqual(
      [
        'category',
        'date',
        'day',
        'done',
        'id',
        'notes',
        'originalStopId',
        'preparedLabel',
        'stopId',
        'title',
        'updatedAt',
      ].sort(),
    )
    expect(Object.isFrozen(built.value)).toBe(true)
    expect(Object.isFrozen(built.value.items)).toBe(true)
    expect(Object.isFrozen(built.value.items[0])).toBe(true)

    const mutated = [...source.items, makeItem({ id: 'c' })]
    expect(source.items).toHaveLength(2)
    expect(mutated).toHaveLength(3)
    expect(built.value.appliedTemplates).toEqual(['flight'])
  })

  it('rejects an invalid checklist instead of projecting partial data', () => {
    const invalid = {
      items: [{ ...makeItem(), category: 'not-a-category' }],
      appliedTemplates: [],
    }
    const result = buildEffectiveChecklist(invalid)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_checklist')
  })

  it('summarizes prepared / pending without touching Trip', () => {
    const checklist = makeChecklist([makeItem({ id: 'a', done: true }), makeItem({ id: 'b' })])
    expect(checklistSummary(checklist)).toEqual({ total: 2, prepared: 1, pending: 1 })
  })
})

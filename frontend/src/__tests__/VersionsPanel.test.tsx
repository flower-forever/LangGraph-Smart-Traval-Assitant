/**
 * F4 VersionsPanel 面板测试：受控 props、显式保存 callback、采用必须先预览再确认、
 * 未确认前绝不调用 apply、缺少预算明确显示、当前额外条目列入重新确认、
 * 版本对比展示跨日移动与未知费用、独立备份预览、撤销 callback。
 * 全部离线 DOM；面板不读 / 写 localStorage，不发请求。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VersionsPanel from '../components/VersionsPanel'
import { MOCK_TRIP } from './fixtures/trip'
import {
  addVersionSnapshot,
  applyVersionAdoptProposal,
  buildVersionsBackupPreview,
  createVersionSnapshot,
  planVersionAdopt,
  type VersionAdoptProposalV1,
  type VersionsBackupPreviewV1,
  type VersionUndoProposalV1,
} from '../lib/versionSnapshots'
import { createWorkspaceRecord, emptySidecar } from '../lib/workspace'
import type {
  BudgetSnapshotV1,
  ConstraintItemV1,
  VersionSnapshotV1,
  VersionsRecordV1,
  WorkspaceRecordV1,
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

function makeRecord(overrides: Partial<WorkspaceRecordV1> = {}): WorkspaceRecordV1 {
  const sidecar = emptySidecar()
  sidecar.constraints.items.push(
    makeConstraint({ id: 'current-extra', title: '只存在当前工作区' }),
  )
  sidecar.checklist.items.push({
    id: 'current-checklist',
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
  const record = expectOk(
    createWorkspaceRecord({
      workspaceId: 'workspace-1',
      ownerId: 'owner-1',
      trip: clone(MOCK_TRIP),
      workspaceRevision: 7,
      now: NOW,
      sidecar,
      budget: makeBudget(
        [{ id: 'current-row', category: 'food', name: '当前预算', amountRaw: '100.00' }],
        '500',
      ),
      label: '测试工作区',
    }),
  )
  return { ...record, ...overrides }
}

function makeSnapshot(overrides: Partial<VersionSnapshotV1> = {}): VersionSnapshotV1 {
  const version = {
    id: 'version-1',
    name: '方案 A',
    createdAt: NOW,
    workspaceRevision: 3,
    trip: clone(MOCK_TRIP),
    sidecar: emptySidecar(),
    budget: null,
    ...overrides,
  }
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

function makeVersions(...snapshots: VersionSnapshotV1[]): VersionsRecordV1 {
  let record: VersionsRecordV1 | null = null
  snapshots.forEach((snapshot, index) => {
    record = expectOk(addVersionSnapshot(record, snapshot, NOW + index))
  })
  if (record === null) throw new Error('versions record missing')
  return record
}

function makeStop(id: string, name: string) {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: 10,
    description: '',
    address: '',
    location: null,
  }
}

function makeMovedTrip(): VersionSnapshotV1['trip'] {
  const trip = clone(MOCK_TRIP)
  trip.days = [
    {
      day: 1,
      date: null,
      title: '第一天',
      summary: '',
      stops: [makeStop('s1', '跨日点'), makeStop('s2', '保留点')],
      legs: [],
    },
    {
      day: 2,
      date: null,
      title: '第二天',
      summary: '',
      stops: [],
      legs: [],
    },
  ]
  return trip
}

function makeAfterMoveTrip(): VersionSnapshotV1['trip'] {
  const trip = clone(MOCK_TRIP)
  trip.days = [
    {
      day: 1,
      date: null,
      title: '第一天',
      summary: '',
      stops: [makeStop('s2', '保留点')],
      legs: [],
    },
    {
      day: 2,
      date: null,
      title: '第二天',
      summary: '',
      stops: [makeStop('s1', '跨日点'), makeStop('s4', '新点')],
      legs: [],
    },
  ]
  return trip
}

interface RenderOptions {
  current?: WorkspaceRecordV1 | null
  versions?: VersionsRecordV1 | null
  epoch?: number
  undoProposal?: VersionUndoProposalV1 | null
}

function renderPanel(options: RenderOptions = {}) {
  const current = options.current === undefined ? makeRecord() : options.current
  const versions =
    options.versions === undefined
      ? makeVersions(makeSnapshot({ id: 'v1', name: '方案 A' }))
      : options.versions
  const epoch = options.epoch ?? 3
  const onSaveVersion = vi.fn()
  const onAdoptVersion = vi.fn()
  const onUndoAdopt = vi.fn()
  const onImportVersions = vi.fn()
  const onDownloadBackup = vi.fn()
  const view = render(
    <VersionsPanel
      current={current}
      versions={versions}
      epoch={epoch}
      undoProposal={options.undoProposal}
      onSaveVersion={onSaveVersion}
      onAdoptVersion={onAdoptVersion}
      onUndoAdopt={onUndoAdopt}
      onImportVersions={onImportVersions}
      onDownloadBackup={onDownloadBackup}
      onClose={() => {}}
      now={() => NOW}
    />,
  )
  return {
    view,
    current,
    versions,
    epoch,
    onSaveVersion,
    onAdoptVersion,
    onUndoAdopt,
    onImportVersions,
    onDownloadBackup,
  }
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: '行程版本与方案对比' })
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn())
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('VersionsPanel：受控挂载与保存', () => {
  it('挂载只渲染受控 props：不读存储、不发请求、不自动 apply', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { onAdoptVersion } = renderPanel()

    expect(panel()).toBeInTheDocument()
    expect(within(panel()).getByText(/后续编辑不会串改旧版本/)).toBeInTheDocument()
    expect(within(panel()).getAllByText(/方案 A/).length).toBeGreaterThan(0)
    expect(getItem).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(onAdoptVersion).not.toHaveBeenCalled()
  })

  it('显式命名后才调用保存 callback；空名字只提示，不调用', async () => {
    const user = userEvent.setup()
    const { onSaveVersion } = renderPanel()
    const input = within(panel()).getByLabelText('版本名称')
    const button = within(panel()).getByRole('button', { name: '保存为版本' })

    await user.type(input, '  方案 A  ')
    await user.click(button)
    expect(onSaveVersion).toHaveBeenCalledTimes(1)
    expect(onSaveVersion).toHaveBeenCalledWith({ name: '方案 A' })

    await user.clear(input)
    await user.click(button)
    expect(onSaveVersion).toHaveBeenCalledTimes(1)
    expect(within(panel()).getByText('请先给版本起一个名字。')).toBeInTheDocument()
  })
})

describe('VersionsPanel：采用预览、确认与撤销', () => {
  it('先预览不 apply；缺预算明确显示；当前额外条目列入重新确认；确认后才回调', async () => {
    const user = userEvent.setup()
    const { onAdoptVersion } = renderPanel()

    const previewButton = within(panel()).getAllByRole('button', {
      name: /预览采用版本 方案 A/,
    })[0]
    await user.click(previewButton)

    expect(onAdoptVersion).not.toHaveBeenCalled()
    expect(within(panel()).getByText(/采用预览：方案 A/)).toBeInTheDocument()
    expect(
      within(panel()).getByText(/该版本没有预算数据；采用后预算明确缺失，不会套用当前预算/),
    ).toBeInTheDocument()
    expect(within(panel()).getByText(/只存在当前工作区/)).toBeInTheDocument()
    expect(within(panel()).getByText(/当前额外清单/)).toBeInTheDocument()
    expect(within(panel()).getByText(/快照内旧 revision 3 不会恢复/)).toBeInTheDocument()

    await user.click(within(panel()).getByRole('button', { name: '取消预览' }))
    expect(within(panel()).queryByText(/采用预览：方案 A/)).not.toBeInTheDocument()
    expect(onAdoptVersion).not.toHaveBeenCalled()

    await user.click(
      within(panel()).getAllByRole('button', { name: /预览采用版本 方案 A/ })[0],
    )
    await user.click(within(panel()).getByRole('button', { name: '确认采用此版本' }))

    expect(onAdoptVersion).toHaveBeenCalledTimes(1)
    const proposal = onAdoptVersion.mock.calls[0][0] as VersionAdoptProposalV1
    expect(proposal.nextWorkspaceRevision).toBe(8)
    expect(proposal.target.content.budget).toBeNull()
    expect(within(panel()).queryByText(/采用预览：方案 A/)).not.toBeInTheDocument()
  })

  it('存在 undo 提案时只通过显式按钮回调；不直接恢复旧 revision', async () => {
    const user = userEvent.setup()
    const current = makeRecord()
    const version = makeSnapshot({ id: 'v-undo', name: '可撤销版本' })
    const proposal = expectOk(planVersionAdopt(current, version, { epoch: 3 }))
    const adopted = expectOk(
      applyVersionAdoptProposal(current, proposal, { epoch: 3 }, NOW + 1_000),
    )
    const versions = makeVersions(version)
    const onUndoAdopt = vi.fn()

    const view = render(
      <VersionsPanel
        current={adopted.record}
        versions={versions}
        epoch={adopted.invalidation.epoch}
        undoProposal={adopted.undo}
        onSaveVersion={vi.fn()}
        onAdoptVersion={vi.fn()}
        onUndoAdopt={onUndoAdopt}
        onClose={() => {}}
        now={() => NOW}
      />,
    )
    const undoButton = within(view.container).getByRole('button', { name: '撤销本次采用' })
    expect(within(view.container).getByText(/最近一次采用可整体撤销/)).toBeInTheDocument()
    expect(onUndoAdopt).not.toHaveBeenCalled()
    await user.click(undoButton)
    expect(onUndoAdopt).toHaveBeenCalledTimes(1)
    expect(onUndoAdopt).toHaveBeenCalledWith(adopted.undo)
    expect(adopted.undo.nextWorkspaceRevision).toBe(adopted.record.workspaceRevision + 1)
    expect(within(view.container).getByText(/不会回放旧 revision/)).toBeInTheDocument()
  })
})

describe('VersionsPanel：对比与独立备份', () => {
  it('默认选择两个版本并显示跨日移动 / 未知费用 / 精确已知合计', () => {
    const beforeTrip = makeMovedTrip()
    const afterTrip = makeAfterMoveTrip()
    const beforeBudget = makeBudget(
      [
        { id: 'r1', category: 'food', name: '早餐', amountRaw: '0.10' },
        { id: 'r2', category: 'food', name: '午餐', amountRaw: '0.20' },
      ],
      '',
    )
    const afterBudget = makeBudget(
      [
        { id: 'r1', category: 'food', name: '早餐', amountRaw: '0.10' },
        { id: 'r2', category: 'food', name: '午餐', amountRaw: '' },
      ],
      '',
    )
    const before = makeSnapshot({
      id: 'v-diff-a',
      name: '对比 A',
      trip: beforeTrip,
      budget: beforeBudget,
    })
    const after = makeSnapshot({
      id: 'v-diff-b',
      name: '对比 B',
      trip: afterTrip,
      budget: afterBudget,
    })
    renderPanel({ versions: makeVersions(before, after) })

    expect(within(panel()).getByText(/跨日移动：跨日点 从第 1 天到第 2 天/)).toBeInTheDocument()
    expect(within(panel()).getByText(/新增：第 2 天 · 新点/)).toBeInTheDocument()
    expect(within(panel()).getAllByText(/已知合计 0.30 元/).length).toBeGreaterThan(0)
    expect(
      within(panel()).getByText(/存在未知项或预算缺失，不显示总价变化/),
    ).toBeInTheDocument()
  })

  it('备份预览只显示版本库范围；下载按钮调用 callback，未点击前不调用', async () => {
    const user = userEvent.setup()
    const { onDownloadBackup } = renderPanel()

    await user.click(within(panel()).getByRole('button', { name: '预览版本库备份' }))
    expect(within(panel()).getByText(/备份预览：仅版本库/)).toBeInTheDocument()
    expect(onDownloadBackup).not.toHaveBeenCalled()

    await user.click(within(panel()).getByRole('button', { name: '下载备份文件' }))
    expect(onDownloadBackup).toHaveBeenCalledTimes(1)
    const preview = onDownloadBackup.mock.calls[0][0] as VersionsBackupPreviewV1
    expect(preview.scope).toBe('versions-only')
    expect(preview.record.items).toHaveLength(1)
  })

  it('导入文件只生成预览；确认按钮才调用导入 callback，原版本库未被面板改写', async () => {
    const user = userEvent.setup()
    const sourceRecord = makeVersions(
      makeSnapshot({ id: 'import-a', name: '导入 A' }),
      makeSnapshot({ id: 'import-b', name: '导入 B', createdAt: NOW + 1 }),
    )
    const backup = expectOk(buildVersionsBackupPreview(sourceRecord, NOW + 2))
    const { onImportVersions, versions } = renderPanel({ versions: sourceRecord })
    const before = JSON.stringify(versions)

    const input = within(panel()).getByLabelText('选择版本库备份文件')
    await user.upload(input, {
      name: 'versions.backup.json',
      type: 'application/json',
      size: backup.text.length,
      text: () => Promise.resolve(backup.text),
    } as unknown as File)

    expect(await within(panel()).findByText(/导入预览：仅版本库/)).toBeInTheDocument()
    expect(onImportVersions).not.toHaveBeenCalled()
    expect(JSON.stringify(versions)).toBe(before)

    await user.click(within(panel()).getByRole('button', { name: '确认导入版本库' }))
    expect(onImportVersions).toHaveBeenCalledTimes(1)
    const preview = onImportVersions.mock.calls[0][0] as { scope: string; record: VersionsRecordV1 }
    expect(preview.scope).toBe('versions-only')
    expect(preview.record.items).toHaveLength(2)
    expect(JSON.stringify(versions)).toBe(before)
  })
})

/**
 * CandidatePoolPanel 用户路径测试：受控 harness + 真实纯函数。
 * 不连接任何存储 / 网络；所有持久化与导入导出回调都是显式 mock。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CandidatePoolPanel, {
  type CandidatePoolSaveStatus,
  type CandidatePoolStorageStatus,
} from '../components/CandidatePoolPanel'
import {
  type CandidateDraftProposal,
  type CandidateManualInput,
  type CandidateStopSource,
  createManualCandidate,
} from '../lib/candidatePool'
import type { CandidateItemV1, CandidatesRecordV1 } from '../lib/workspace'
import { createCandidatesRecord } from '../lib/workspace'
import type { Trip } from '../lib/api'
import type { TripDraft } from '../lib/tripDraft'
import { createTripDraft } from '../lib/tripDraft'
import { MOCK_TRIP } from './fixtures/trip'

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

function makeCandidate(overrides: Partial<CandidateManualInput> = {}): CandidateItemV1 {
  sequence += 1
  return ok(
    createManualCandidate(
      {
        id: overrides.id ?? `fixture-candidate-${sequence}`,
        name: overrides.name ?? `夹具地点 ${sequence}`,
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

function makeDraft(trip: Trip = clone(MOCK_TRIP)): TripDraft {
  const result = createTripDraft(trip, { forkTripId: 'trip-fork-panel', newLegMode: 'walking' })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.draft
}

const COPY_SOURCE: CandidateStopSource = {
  stopId: 's1',
  name: '断桥残雪',
  address: '杭州市西湖区白堤东端',
  location: { lng: 120.1576, lat: 30.2726 },
  day: 1,
}

interface HarnessProps {
  initialRecord: CandidatesRecordV1
  draft?: TripDraft | null
  copySources?: readonly CandidateStopSource[]
  storageStatus?: CandidatePoolStorageStatus
  storageMessage?: string | null
  storageRevision?: string | number | null
  saveStatus?: CandidatePoolSaveStatus
  saveMessage?: string | null
  onSave?: (record: CandidatesRecordV1) => void
  onExport?: (record: CandidatesRecordV1) => void
  onImportRequest?: () => void
  onAddToDraft?: (proposal: CandidateDraftProposal) => void
  onPreview?: (proposal: CandidateDraftProposal) => void
  onRecordChange?: (record: CandidatesRecordV1) => void
  createCandidateId?: () => string
  createVisitStopId?: () => string
}

function Harness({
  initialRecord,
  draft = null,
  copySources = [],
  storageStatus,
  storageMessage,
  storageRevision,
  saveStatus = 'idle',
  saveMessage,
  onSave = () => {},
  onExport = () => {},
  onImportRequest = () => {},
  onAddToDraft = () => {},
  onPreview,
  onRecordChange,
  createCandidateId = () => `panel-candidate-${++sequence}`,
  createVisitStopId = () => `panel-visit-${++sequence}`,
}: HarnessProps) {
  const [record, setRecord] = useState<CandidatesRecordV1>(initialRecord)
  return (
    <CandidatePoolPanel
      record={record}
      draft={draft}
      copySources={copySources}
      storageStatus={storageStatus}
      storageMessage={storageMessage}
      storageRevision={storageRevision}
      saveStatus={saveStatus}
      saveMessage={saveMessage}
      onRecordChange={(next) => {
        setRecord(next)
        onRecordChange?.(next)
      }}
      onSave={onSave}
      onExport={onExport}
      onImportRequest={onImportRequest}
      onAddToDraft={onAddToDraft}
      onPreview={onPreview}
      now={() => NOW}
      createCandidateId={createCandidateId}
      createVisitStopId={createVisitStopId}
    />
  )
}

function renderHarness(overrides: Partial<HarnessProps> = {}) {
  const callbacks = {
    onSave: vi.fn(),
    onExport: vi.fn(),
    onImportRequest: vi.fn(),
    onAddToDraft: vi.fn(),
    onPreview: vi.fn(),
    onRecordChange: vi.fn(),
  }
  const IDs = {
    candidateSeq: 0,
    visitSeq: 0,
  }
  const props: HarnessProps = {
    initialRecord: makeRecord([]),
    draft: makeDraft(),
    copySources: [COPY_SOURCE],
    createCandidateId: () => {
      IDs.candidateSeq += 1
      return `panel-candidate-${IDs.candidateSeq}`
    },
    createVisitStopId: () => {
      IDs.visitSeq += 1
      return `panel-visit-${IDs.visitSeq}`
    },
    ...callbacks,
    ...overrides,
  }
  const view = render(<Harness {...props} />)
  return { ...view, props, callbacks, IDs }
}

function fillManualForm(overrides: {
  name?: string
  address?: string
  notes?: string
  tags?: string
  priority?: string
  lng?: string
  lat?: string
} = {}) {
  if (overrides.name !== undefined) {
    fireEvent.change(screen.getByLabelText('候选名称'), { target: { value: overrides.name } })
  }
  if (overrides.address !== undefined) {
    fireEvent.change(screen.getByLabelText('地址（可选）'), {
      target: { value: overrides.address },
    })
  }
  if (overrides.notes !== undefined) {
    fireEvent.change(screen.getByLabelText('备注（可选）'), {
      target: { value: overrides.notes },
    })
  }
  if (overrides.tags !== undefined) {
    fireEvent.change(screen.getByLabelText('区域标签（用逗号分隔，可选）'), {
      target: { value: overrides.tags },
    })
  }
  if (overrides.priority !== undefined) {
    fireEvent.change(screen.getByLabelText('优先级'), { target: { value: overrides.priority } })
  }
  if (overrides.lng !== undefined) {
    fireEvent.change(screen.getByLabelText('经度（可选）'), { target: { value: overrides.lng } })
  }
  if (overrides.lat !== undefined) {
    fireEvent.change(screen.getByLabelText('纬度（可选）'), { target: { value: overrides.lat } })
  }
}

async function addManual(
  user: ReturnType<typeof userEvent.setup>,
  overrides: Parameters<typeof fillManualForm>[0] = {},
) {
  fillManualForm(overrides)
  await user.click(screen.getByRole('button', { name: '添加到候选库' }))
}

async function openDraftAdd(
  user: ReturnType<typeof userEvent.setup>,
  candidateId: string,
  day = 2,
  time = '09:30',
  duration = '45',
) {
  const item = screen.getByTestId(`candidate-item-${candidateId}`)
  await user.click(within(item).getByRole('button', { name: '加入草稿' }))
  fireEvent.change(screen.getByLabelText('加入第几天草稿'), { target: { value: String(day) } })
  fireEvent.change(screen.getByLabelText('加入时间（HH:MM）'), { target: { value: time } })
  fireEvent.change(screen.getByLabelText('停留分钟（可选，留空为未知）'), {
    target: { value: duration },
  })
  await user.click(screen.getByRole('button', { name: '生成加入预览' }))
}

beforeEach(() => {
  sequence = 0
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('挂载与显式回调边界', () => {
  it('挂载不调用任何持久化回调、不读 localStorage；来源与未核实标记可见', () => {
    const candidate = makeCandidate({ name: '灵隐寺', tags: ['西湖'] })
    const { callbacks } = renderHarness({ initialRecord: makeRecord([candidate]) })

    expect(callbacks.onSave).not.toHaveBeenCalled()
    expect(callbacks.onExport).not.toHaveBeenCalled()
    expect(callbacks.onImportRequest).not.toHaveBeenCalled()
    expect(callbacks.onAddToDraft).not.toHaveBeenCalled()
    expect(callbacks.onPreview).not.toHaveBeenCalled()
    expect(callbacks.onRecordChange).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(0)
    expect(screen.getByRole('heading', { name: '候选地点池' })).toBeInTheDocument()
    expect(screen.getByTestId('candidate-pool-stats')).toHaveTextContent('共 1 条')
    expect(screen.getAllByText('手工新增').length).toBeGreaterThan(0)
    expect(screen.getAllByText('未核实').length).toBeGreaterThan(0)
    expect(screen.getByText('尚未保存；所有增删改都只在本页内存里。')).toBeInTheDocument()
    expect(screen.getByLabelText('候选名称')).toBeInTheDocument()
  })
})

describe('手工新增、复制与重复提示', () => {
  it('手工新增：坐标 0 合法、标签去重、source=manual；只回传内存记录', async () => {
    const user = userEvent.setup()
    const { callbacks } = renderHarness()
    await addManual(user, {
      name: '零点公园',
      address: '某路 0 号',
      notes: '备注',
      tags: '西湖，步行，西湖',
      priority: '3',
      lng: '0',
      lat: '0',
    })

    expect(callbacks.onRecordChange).toHaveBeenCalledTimes(1)
    const next = callbacks.onRecordChange.mock.calls[0][0] as CandidatesRecordV1
    expect(next.items).toHaveLength(1)
    const item = next.items[0]
    expect(item.name).toBe('零点公园')
    expect(item.address).toBe('某路 0 号')
    expect(item.tags).toEqual(['西湖', '步行'])
    expect(item.priority).toBe(3)
    expect(item.location).toEqual({ lng: 0, lat: 0 })
    expect(item.source).toBe('manual')
    expect(item.copiedFromStopId).toBeNull()
    expect(callbacks.onSave).not.toHaveBeenCalled()
    expect(callbacks.onAddToDraft).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(0)
    expect(screen.getByText('经度 0，纬度 0')).toBeInTheDocument()
    expect(screen.getAllByText('手工新增').length).toBeGreaterThan(0)
    expect(screen.getByText('优先级 3')).toBeInTheDocument()
  })

  it('同名同址第二次新增：提示可能重复，两条都保留，不自动合并', async () => {
    const user = userEvent.setup()
    const { callbacks } = renderHarness()
    await addManual(user, { name: '西湖博物馆', address: '北山街 1 号', tags: '西湖' })
    await addManual(user, { name: '西湖博物馆', address: '北山街 1 号', tags: '西湖' })

    expect(callbacks.onRecordChange).toHaveBeenCalledTimes(2)
    const next = callbacks.onRecordChange.mock.calls[1][0] as CandidatesRecordV1
    expect(next.items).toHaveLength(2)
    expect(screen.getAllByTestId(/candidate-item-/)).toHaveLength(2)
    expect(screen.getByTestId('candidate-pool-duplicate')).toHaveTextContent('不自动合并')
    expect(window.localStorage.length).toBe(0)
  })

  it('从行程站点复制：source=copied、copiedFromStopId 正确、坐标不丢；原来源对象不被修改', async () => {
    const user = userEvent.setup()
    const source = clone(COPY_SOURCE)
    const { callbacks } = renderHarness({ copySources: [source] })
    await user.click(screen.getByRole('button', { name: '从行程站点复制' }))
    fireEvent.change(screen.getByLabelText('备注（可选）'), { target: { value: '复制备注' } })
    fireEvent.change(screen.getByLabelText('区域标签（用逗号分隔，可选）'), {
      target: { value: '西湖' },
    })
    await user.click(screen.getByRole('button', { name: '复制为候选' }))

    expect(callbacks.onRecordChange).toHaveBeenCalledTimes(1)
    const item = (callbacks.onRecordChange.mock.calls[0][0] as CandidatesRecordV1).items[0]
    expect(item.source).toBe('copied')
    expect(item.copiedFromStopId).toBe('s1')
    expect(item.name).toBe('断桥残雪')
    expect(item.address).toBe('杭州市西湖区白堤东端')
    expect(item.location).toEqual({ lng: 120.1576, lat: 30.2726 })
    expect(source).toEqual(COPY_SOURCE)
    expect(screen.getByText('从行程站点复制（s1）')).toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
  })
})

describe('编辑、筛选与删除', () => {
  it('编辑只改内存记录，不调用保存 / 加入草稿；清空坐标后明确显示未知', async () => {
    const user = userEvent.setup()
    const candidate = makeCandidate({
      name: '旧名字',
      address: '旧地址',
      location: { lng: 120, lat: 30 },
    })
    const draft = makeDraft()
    const beforeDraft = clone(draft)
    const { callbacks } = renderHarness({
      initialRecord: makeRecord([candidate]),
      draft,
    })
    const item = screen.getByTestId(`candidate-item-${candidate.id}`)
    await user.click(within(item).getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('编辑名称'), { target: { value: '新名字' } })
    fireEvent.change(screen.getByLabelText('编辑地址（可选）'), {
      target: { value: '新地址' },
    })
    fireEvent.change(screen.getByLabelText('编辑区域标签（逗号分隔）'), {
      target: { value: '运河，步行' },
    })
    fireEvent.change(screen.getByLabelText('编辑优先级'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('编辑经度（可选）'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('编辑纬度（可选）'), { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: '保存这次编辑' }))

    expect(callbacks.onRecordChange).toHaveBeenCalledTimes(1)
    const updated = (callbacks.onRecordChange.mock.calls[0][0] as CandidatesRecordV1).items[0]
    expect(updated.name).toBe('新名字')
    expect(updated.address).toBe('新地址')
    expect(updated.tags).toEqual(['运河', '步行'])
    expect(updated.priority).toBe(2)
    expect(updated.location).toBeNull()
    expect(updated.source).toBe('manual')
    expect(updated.createdAt).toBe(candidate.createdAt)
    expect(callbacks.onSave).not.toHaveBeenCalled()
    expect(callbacks.onAddToDraft).not.toHaveBeenCalled()
    expect(screen.getByText('坐标未知')).toBeInTheDocument()
    expect(draft).toEqual(beforeDraft)
    expect(window.localStorage.length).toBe(0)
  })

  it('按标签 / 无标签 / 文本筛选只影响显示，不触发记录回调', async () => {
    const user = userEvent.setup()
    const westLake = makeCandidate({ id: 'filter-west', name: '断桥', tags: ['西湖'] })
    const canal = makeCandidate({ id: 'filter-canal', name: '拱宸桥', tags: ['运河'] })
    const untagged = makeCandidate({ id: 'filter-none', name: '无标签公园', tags: [] })
    const { callbacks } = renderHarness({
      initialRecord: makeRecord([westLake, canal, untagged]),
    })

    fireEvent.change(screen.getByLabelText('按区域标签筛选'), { target: { value: '西湖' } })
    expect(screen.getByTestId('candidate-item-filter-west')).toBeInTheDocument()
    expect(screen.queryByTestId('candidate-item-filter-canal')).toBeNull()
    expect(screen.queryByTestId('candidate-item-filter-none')).toBeNull()

    fireEvent.change(screen.getByLabelText('按区域标签筛选'), { target: { value: '__untagged__' } })
    expect(screen.queryByTestId('candidate-item-filter-west')).toBeNull()
    expect(screen.getByTestId('candidate-item-filter-none')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('按区域标签筛选'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('筛选候选（名称 / 地址 / 备注 / 标签）'), {
      target: { value: '拱宸' },
    })
    expect(screen.getByTestId('candidate-item-filter-canal')).toBeInTheDocument()
    expect(screen.queryByTestId('candidate-item-filter-west')).toBeNull()

    // 编辑表单打开但不提交，也只是本地状态。
    const item = screen.getByTestId('candidate-item-filter-canal')
    await user.click(within(item).getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('编辑名称'), { target: { value: '暂存草稿' } })
    expect(callbacks.onRecordChange).not.toHaveBeenCalled()
    expect(callbacks.onSave).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(0)
  })

  it('删除候选只回传候选库新记录；草稿与来源对象不变', async () => {
    const user = userEvent.setup()
    const candidate = makeCandidate({ name: '待删除' })
    const draft = makeDraft()
    const beforeDraft = clone(draft)
    const source = clone(COPY_SOURCE)
    const { callbacks } = renderHarness({
      initialRecord: makeRecord([candidate]),
      draft,
      copySources: [source],
    })
    const item = screen.getByTestId(`candidate-item-${candidate.id}`)
    await user.click(within(item).getByRole('button', { name: '删除' }))

    expect(callbacks.onRecordChange).toHaveBeenCalledTimes(1)
    expect((callbacks.onRecordChange.mock.calls[0][0] as CandidatesRecordV1).items).toEqual([])
    expect(callbacks.onAddToDraft).not.toHaveBeenCalled()
    expect(draft).toEqual(beforeDraft)
    expect(source).toEqual(COPY_SOURCE)
    expect(screen.getByText(/已加入行程的站点不会被删除/)).toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
  })
})

describe('加入草稿预览与 revision 失效', () => {
  it('先生成预览；新 visit id 不复用候选 id；确认后才回传父级草稿', async () => {
    const user = userEvent.setup()
    const candidate = makeCandidate({ name: '新地点', notes: '备注', location: null })
    const draft = makeDraft()
    const beforeDraft = clone(draft)
    const beforeTrip = clone(draft.base)
    const { callbacks } = renderHarness({
      initialRecord: makeRecord([candidate]),
      draft,
    })

    await openDraftAdd(user, candidate.id, 2, '09:30', '45')

    expect(callbacks.onPreview).toHaveBeenCalledTimes(1)
    const proposal = callbacks.onPreview.mock.calls[0][0] as CandidateDraftProposal
    expect(proposal.previewOnly).toBe(true)
    expect(proposal.visitStopId).toBe('panel-visit-1')
    expect(proposal.visitStopId).not.toBe(candidate.id)
    expect(proposal.stop.id).toBe('panel-visit-1')
    expect(proposal.day).toBe(2)
    expect(proposal.stop.location).toBeNull()
    const proposalBox = screen.getByTestId('candidate-pool-proposal')
    expect(proposalBox).toBeInTheDocument()
    expect(within(proposalBox).getByText(/预览（未写入）/)).toBeInTheDocument()
    expect(within(proposalBox).getByText(/不复用候选 id/)).toBeInTheDocument()
    expect(within(proposalBox).getByText(/checkTripShape 已通过/)).toBeInTheDocument()
    expect(within(proposalBox).getByText(/尚未写入任何行程或本地存储/)).toBeInTheDocument()
    expect(within(proposalBox).getByText(/缺少坐标/)).toBeInTheDocument()
    expect(callbacks.onAddToDraft).not.toHaveBeenCalled()
    expect(draft).toEqual(beforeDraft)
    expect(draft.base).toEqual(beforeTrip)
    expect(window.localStorage.length).toBe(0)

    await user.click(screen.getByRole('button', { name: '确认加入草稿' }))
    expect(callbacks.onAddToDraft).toHaveBeenCalledTimes(1)
    expect(callbacks.onAddToDraft.mock.calls[0][0]).toEqual(proposal)
    expect(screen.queryByTestId('candidate-pool-proposal')).toBeNull()
    expect(screen.getByText(/没有修改 Trip，也未写存储/)).toBeInTheDocument()
    expect(draft).toEqual(beforeDraft)
    expect(window.localStorage.length).toBe(0)
  })

  it('草稿 revision 变化后旧预览立即失效，确认按钮消失', async () => {
    const user = userEvent.setup()
    const candidate = makeCandidate({ name: '预览失效' })
    const draft = makeDraft()
    const props: HarnessProps = {
      initialRecord: makeRecord([candidate]),
      draft,
    }
    const { rerender } = render(<Harness {...props} />)
    await openDraftAdd(user, candidate.id, 2, '09:00', '')
    expect(screen.getByTestId('candidate-pool-proposal')).toBeInTheDocument()

    const changedDraft: TripDraft = { ...draft, revision: draft.revision + 1 }
    rerender(<Harness {...props} draft={changedDraft} />)
    await waitFor(() => {
      expect(screen.queryByTestId('candidate-pool-proposal')).toBeNull()
    })
    expect(screen.queryByRole('button', { name: '确认加入草稿' })).toBeNull()
  })

  it('父级 owner raw / revision token 变化后旧预览立即失效', async () => {
    const user = userEvent.setup()
    const candidate = makeCandidate({ name: 'owner token 失效' })
    const draft = makeDraft()
    const props: HarnessProps = {
      initialRecord: makeRecord([candidate]),
      draft,
      storageRevision: 'raw-1',
    }
    const { rerender } = render(<Harness {...props} />)
    await openDraftAdd(user, candidate.id, 2, '09:00', '')
    expect(screen.getByTestId('candidate-pool-proposal')).toBeInTheDocument()

    rerender(<Harness {...props} storageRevision="raw-2" />)
    await waitFor(() => {
      expect(screen.queryByTestId('candidate-pool-proposal')).toBeNull()
    })
    expect(screen.queryByRole('button', { name: '确认加入草稿' })).toBeNull()
  })

  it('满 100 站、时间非法、visit id 复用候选 id 都明确失败；不产生 onPreview / onAddToDraft', async () => {
    const user = userEvent.setup()
    const candidate = makeCandidate({ id: 'panel-candidate-1', name: '候选' })
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
    const fullDraft = makeDraft(fullTrip)
    const { callbacks } = renderHarness({
      initialRecord: makeRecord([candidate]),
      draft: fullDraft,
    })

    await openDraftAdd(user, candidate.id, 1, '09:00', '')
    expect(screen.getByText(/达到本地结构上限/)).toBeInTheDocument()
    expect(callbacks.onPreview).not.toHaveBeenCalled()
    expect(callbacks.onAddToDraft).not.toHaveBeenCalled()

    cleanup()
    const normalDraft = makeDraft()
    const second = renderHarness({
      initialRecord: makeRecord([candidate]),
      draft: normalDraft,
      createVisitStopId: () => 'panel-candidate-1',
    })
    await openDraftAdd(user, candidate.id, 2, '09:00', '')
    expect(screen.getByText(/新站点 id 不能复用候选 id/)).toBeInTheDocument()
    expect(second.callbacks.onPreview).not.toHaveBeenCalled()
    expect(second.callbacks.onAddToDraft).not.toHaveBeenCalled()

    cleanup()
    const third = renderHarness({
      initialRecord: makeRecord([candidate]),
      draft: makeDraft(),
    })
    await openDraftAdd(user, candidate.id, 2, '9:00', '')
    expect(screen.getByText(/加入时间必须是 24 小时制/)).toBeInTheDocument()
    expect(third.callbacks.onPreview).not.toHaveBeenCalled()
  })
})

describe('保存 / 导出 / 导入与只读状态', () => {
  it('保存 / 导出 / 导入都只在显式点击时调用父级回调；不写 localStorage', async () => {
    const user = userEvent.setup()
    const record = makeRecord([makeCandidate({ name: '甲' })])
    const { callbacks, props } = renderHarness({ initialRecord: record })

    await user.click(screen.getByRole('button', { name: '保存候选库' }))
    expect(callbacks.onSave).toHaveBeenCalledWith(record)
    expect(screen.getByText(/不假装已保存/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '导出候选库备份' }))
    expect(callbacks.onExport).toHaveBeenCalledWith(record)

    await user.click(screen.getByRole('button', { name: '导入候选库…' }))
    expect(callbacks.onImportRequest).toHaveBeenCalledTimes(1)

    expect(callbacks.onRecordChange).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(0)

    const view = render(<Harness {...props} initialRecord={record} saveStatus="saved" />)
    expect(screen.getByText('父级存储 adapter 报告：候选库已保存。')).toBeInTheDocument()
    view.unmount()
  })

  it('损坏 / 不可写状态禁用变更与保存，并明确不覆盖原始字节', () => {
    const candidate = makeCandidate({ name: '只读条目' })
    renderHarness({
      initialRecord: makeRecord([candidate]),
      storageStatus: 'corrupt',
    })

    expect(screen.getByText(/候选库数据损坏/)).toBeInTheDocument()
    expect(screen.getByText(/原始字节已保留/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加到候选库' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存候选库' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '导出候选库备份' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '导入候选库…' })).toBeEnabled()
    expect(screen.getByText(/当前候选库不可写/)).toBeInTheDocument()
  })

  it('父级报告 saved 后继续编辑，界面不把新变更说成已保存', async () => {
    const user = userEvent.setup()
    renderHarness({ saveStatus: 'saved' })
    expect(screen.getByText('父级存储 adapter 报告：候选库已保存。')).toBeInTheDocument()

    await addManual(user, { name: '新增之后' })
    expect(screen.getByText(/本页有尚未保存的变更/)).toBeInTheDocument()
    expect(screen.queryByText('父级存储 adapter 报告：候选库已保存。')).toBeNull()
  })

  it('候选库满 200 条时新增明确失败，旧记录保持不变', async () => {
    const user = userEvent.setup()
    const items = Array.from({ length: 200 }, (_, index) =>
      makeCandidate({ id: `limit-${index}`, name: `A${index}` }),
    )
    const record = makeRecord(items)
    const { callbacks } = renderHarness({ initialRecord: record })
    await addManual(user, { name: '第 201 条' })

    expect(callbacks.onRecordChange).not.toHaveBeenCalled()
    expect(screen.getByText(/最多 200 条/)).toBeInTheDocument()
    expect(screen.getByTestId('candidate-pool-stats')).toHaveTextContent('共 200 条')
    expect(window.localStorage.length).toBe(0)
  })
})

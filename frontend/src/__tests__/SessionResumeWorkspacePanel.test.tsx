/**
 * SessionResumePanel × v2 workspace 概况回归：
 * - v2 待恢复卡只读展示工作区段计数，不声称候选 / 版本库一起恢复；
 * - v1 卡片不出现工作区数据提示；
 * - 既有确认身份仍由 pending raw 推进，workspace 内容变化不能复用旧删除确认。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionResumePanel from '../components/SessionResumePanel'
import { emptySidecar, createWorkspaceRecord } from '../lib/workspace'
import type { SessionResumeLoad } from '../lib/sessionRestore'
import type { ConstraintItemV1, WorkspaceRecordV1 } from '../lib/workspaceTypes'
import { MOCK_TRIP } from './fixtures/trip'

type PendingLoad = Extract<SessionResumeLoad, { status: 'pending' }>
const NOW = 1_800_000_000_000

function makeConstraint(): ConstraintItemV1 {
  return {
    id: 'constraint-1',
    kind: 'must_visit',
    title: '博物馆',
    day: 1,
    stopId: null,
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    durationMinutes: null,
    notes: null,
    priority: 2,
    updatedAt: NOW,
  }
}

function makeWorkspace(): WorkspaceRecordV1 {
  const created = createWorkspaceRecord({
    workspaceId: 'workspace-panel',
    ownerId: 'owner-panel',
    trip: MOCK_TRIP,
    workspaceRevision: 2,
    now: NOW,
    sidecar: {
      ...emptySidecar(),
      constraints: { items: [makeConstraint()] },
      checklist: {
        items: [
          {
            id: 'check-1',
            category: 'ticket',
            title: '预约确认单',
            done: false,
            date: null,
            day: 1,
            stopId: null,
            originalStopId: null,
            notes: null,
            updatedAt: NOW,
          },
        ],
        appliedTemplates: [],
      },
    },
    budget: null,
  })
  if (!created.ok) throw new Error(created.message)
  return created.value
}

function pendingLoad(workspace: WorkspaceRecordV1 | null, raw: string): PendingLoad {
  return {
    status: 'pending',
    version: workspace ? 2 : 1,
    raw,
    record: {
      savedAt: NOW,
      session: {
        trip: MOCK_TRIP,
        draft: null,
        budget: null,
        ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        workspace,
      },
    },
  }
}

function renderPanel(state: Parameters<typeof SessionResumePanel>[0]['state']) {
  return render(
    <SessionResumePanel
      state={state}
      enabled
      hasStoredData
      onEnable={vi.fn()}
      onDisable={vi.fn()}
      onRestore={vi.fn()}
      onDiscardAndStart={vi.fn()}
      onPrepareDelete={vi.fn(() => ({ ok: true as const, raw: 'raw-v2' }))}
      onDeleteData={vi.fn()}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SessionResumePanel v2 workspace 概况', () => {
  it('v2 显示工作区段计数，并保持「点恢复才替换」语义', () => {
    renderPanel({ kind: 'pending', load: pendingLoad(makeWorkspace(), 'raw-v2') })
    expect(screen.getByText(/含工作区数据/)).toBeInTheDocument()
    expect(screen.getByText(/1 条必去\/预约约束/)).toBeInTheDocument()
    expect(screen.getByText(/1 项准备清单/)).toBeInTheDocument()
    expect(screen.getByText(/不会只换其中一项/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复上次的工作进度' })).toBeInTheDocument()
  })

  it('v1 不出现工作区数据提示', () => {
    renderPanel({ kind: 'pending', load: pendingLoad(null, 'raw-v1') })
    expect(screen.queryByText(/含工作区数据/)).toBeNull()
  })

  it('同一 workspace 不同 raw 也不能复用旧删除确认', () => {
    const workspace = makeWorkspace()
    const view = renderPanel({ kind: 'pending', load: pendingLoad(workspace, 'raw-A') })
    fireEvent.click(screen.getByRole('button', { name: '删除本机恢复副本' }))
    expect(screen.getByRole('button', { name: '确认删除副本' })).toBeInTheDocument()

    view.rerender(
      <SessionResumePanel
        state={{ kind: 'pending', load: pendingLoad(workspace, 'raw-B') }}
        enabled
        hasStoredData
        onEnable={vi.fn()}
        onDisable={vi.fn()}
        onRestore={vi.fn()}
        onDiscardAndStart={vi.fn()}
        onPrepareDelete={vi.fn(() => ({ ok: true as const, raw: 'raw-B' }))}
        onDeleteData={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: '确认删除副本' })).toBeNull()
  })
})

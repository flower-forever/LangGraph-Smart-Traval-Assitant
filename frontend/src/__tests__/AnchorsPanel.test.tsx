import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AnchorsPanel from '../components/AnchorsPanel'
import type { AnchorsProposal } from '../lib/anchors'
import type { WorkspaceRecordV1 } from '../lib/workspaceTypes'
import { createWorkspaceRecord } from '../lib/workspace'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_760_000_000_000

function makeRecord(): WorkspaceRecordV1 {
  const result = createWorkspaceRecord({
    workspaceId: 'ws-panel',
    ownerId: 'owner-panel',
    trip: MOCK_TRIP,
    workspaceRevision: 5,
    now: NOW,
  })
  if (!result.ok) throw new Error(`record fixture failed: ${result.message}`)
  return result.value
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

interface RenderOptions {
  record?: WorkspaceRecordV1
  onApplyResult?: { ok: true } | { ok: false; message: string }
}

function renderPanel(options: RenderOptions = {}) {
  const record = options.record ?? makeRecord()
  const onApply = vi.fn<(proposal: AnchorsProposal) => { ok: true } | { ok: false; message: string } | void>(
    () => options.onApplyResult ?? { ok: true },
  )
  const onClose = vi.fn()
  let sequence = 0
  const createId = (kind: 'hotel' | 'anchor' | 'stop') => `${kind}-${++sequence}`
  const view = render(
    <AnchorsPanel
      record={record}
      epoch={7}
      newLegMode="walking"
      onApply={onApply}
      onClose={onClose}
      createId={createId}
    />,
  )
  return { ...view, record, onApply, onClose }
}

async function addHotel(
  user: ReturnType<typeof userEvent.setup>,
  input: { name?: string; checkIn?: string; checkOut?: string } = {},
): Promise<void> {
  await user.click(screen.getByRole('button', { name: '添加住宿信息' }))
  await user.type(screen.getByLabelText('住宿名称'), input.name ?? '中央酒店')
  await user.type(screen.getByLabelText('入住日期（当地）'), input.checkIn ?? '2026-04-03')
  await user.type(screen.getByLabelText('退房日期（当地）'), input.checkOut ?? '2026-04-05')
}

function day1(): HTMLElement {
  return screen.getByTestId('anchors-day-1')
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AnchorsPanel：受控入口与零副作用', () => {
  it('挂载不写 storage、不发请求；收起调用父级回调', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const user = userEvent.setup()
    const { onClose } = renderPanel()
    expect(screen.getByRole('region', { name: '住宿与抵离锚点' })).toBeInTheDocument()
    expect(screen.getByText(/未接入 App/)).toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fetchSpy.mockRestore()
  })

  it('用户编辑不会改当前 record / Trip，也不会自动 apply', async () => {
    const user = userEvent.setup()
    const { record, onApply } = renderPanel()
    const before = clone(record)
    await addHotel(user)
    await user.click(within(day1()).getByRole('checkbox', { name: '使用起点锚点' }))
    expect(record).toEqual(before)
    expect(onApply).not.toHaveBeenCalled()
  })
})

describe('AnchorsPanel：预览 / 应用 / 取消', () => {
  it('同一酒店同日首末预览出两个独立 occurrence；只有点应用才回调', async () => {
    const user = userEvent.setup()
    const { record, onApply } = renderPanel()
    const before = clone(record)
    await addHotel(user)
    await user.click(within(day1()).getByRole('checkbox', { name: '使用起点锚点' }))
    await user.click(within(day1()).getByRole('checkbox', { name: '使用终点锚点' }))

    await user.click(screen.getByRole('button', { name: '预览提案' }))
    const occurrences = within(screen.getByTestId('anchors-occurrences')).getAllByRole('listitem')
    expect(occurrences).toHaveLength(2)
    expect(screen.getByText(/提案预览（尚未应用）/)).toBeInTheDocument()
    expect(onApply).not.toHaveBeenCalled()
    expect(record).toEqual(before)

    await user.click(screen.getByRole('button', { name: '应用提案' }))
    expect(onApply).toHaveBeenCalledTimes(1)
    const proposal = onApply.mock.calls[0][0]
    expect(proposal.baseRevision).toBe(record.workspaceRevision)
    expect(proposal.owner.tripId).toBe(record.tripId)
    expect(proposal.occurrences).toHaveLength(2)
    expect(proposal.occurrences[0].hotelId).toBe(proposal.occurrences[1].hotelId)
    expect(proposal.occurrences[0].stop.id).not.toBe(proposal.occurrences[1].stop.id)
    expect(window.localStorage.length).toBe(0)
  })

  it('链接已有 stop 只预览为 link，不生成 occurrence', async () => {
    const user = userEvent.setup()
    const { onApply } = renderPanel()
    await user.click(within(day1()).getByRole('checkbox', { name: '使用起点锚点' }))
    const editor = within(day1()).getByTestId('anchors-editor-起点')
    await user.selectOptions(within(editor).getByLabelText('类型'), 'stop')
    await user.selectOptions(within(editor).getByLabelText('已有站点'), 's2')

    await user.click(screen.getByRole('button', { name: '预览提案' }))
    expect(screen.queryByTestId('anchors-occurrences')).toBeNull()
    expect(screen.getByTestId('anchors-placements').textContent).toContain('链接已有站点 s2，不复制')
    expect(onApply).not.toHaveBeenCalled()
  })

  it('取消预览保留表单与 record，不调用 apply', async () => {
    const user = userEvent.setup()
    const { record, onApply } = renderPanel()
    const before = clone(record)
    await addHotel(user)
    await user.click(within(day1()).getByRole('checkbox', { name: '使用起点锚点' }))
    await user.click(screen.getByRole('button', { name: '预览提案' }))
    expect(screen.getByTestId('anchors-preview')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '取消预览' }))
    expect(screen.queryByTestId('anchors-preview')).toBeNull()
    expect(screen.getByText(/预览已取消/)).toBeInTheDocument()
    expect(screen.getByLabelText('住宿名称')).toHaveValue('中央酒店')
    expect(record).toEqual(before)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('修改输入后旧预览清空，应用按钮重新禁用', async () => {
    const user = userEvent.setup()
    renderPanel()
    await addHotel(user)
    await user.click(screen.getByRole('button', { name: '预览提案' }))
    expect(screen.getByTestId('anchors-preview')).toBeInTheDocument()

    await user.type(screen.getByLabelText('住宿名称'), '（改）')
    expect(screen.queryByTestId('anchors-preview')).toBeNull()
    expect(screen.getByRole('button', { name: '应用提案' })).toBeDisabled()
  })

  it('父级 apply 失败时显示错误并保留预览，record 不变', async () => {
    const user = userEvent.setup()
    const { record, onApply } = renderPanel({
      onApplyResult: { ok: false, message: '模拟保存失败：旧数据未改变' },
    })
    const before = clone(record)
    await addHotel(user)
    await user.click(within(day1()).getByRole('checkbox', { name: '使用起点锚点' }))
    await user.click(screen.getByRole('button', { name: '预览提案' }))
    await user.click(screen.getByRole('button', { name: '应用提案' }))

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('anchors-error').textContent).toContain('模拟保存失败')
    expect(screen.getByTestId('anchors-preview')).toBeInTheDocument()
    expect(record).toEqual(before)
    expect(window.localStorage.length).toBe(0)
  })

  it('坏日期在预览阶段 typed 失败，不调用 apply、不改 record', async () => {
    const user = userEvent.setup()
    const { record, onApply } = renderPanel()
    const before = clone(record)
    await addHotel(user, { checkIn: '2026-02-30' })
    await user.click(screen.getByRole('button', { name: '预览提案' }))
    expect(screen.getByTestId('anchors-error').textContent).toContain('真实日历日')
    expect(onApply).not.toHaveBeenCalled()
    expect(record).toEqual(before)
  })

  it('预览显示明确时间冲突与待确认，不偷偷改 Trip', async () => {
    const user = userEvent.setup()
    const { record } = renderPanel()
    const before = clone(record)
    await addHotel(user)
    await user.click(within(day1()).getByRole('checkbox', { name: '使用起点锚点' }))
    const editor = within(day1()).getByTestId('anchors-editor-起点')
    await user.type(within(editor).getByLabelText('时间（HH:MM，可留空）'), '10:00')
    await user.click(screen.getByRole('button', { name: '预览提案' }))

    expect(screen.getByTestId('anchors-blockers').textContent).toContain('晚于')
    expect(record).toEqual(before)
    expect(screen.getByText(/锚点只是你填写的计划参考/)).toBeInTheDocument()
  })
})

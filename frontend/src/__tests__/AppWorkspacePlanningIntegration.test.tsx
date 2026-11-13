/**
 * App × F1/F2/F3/F5/F6 真实接线测试：
 * - 单一工作区记录：清单 / 约束 / 锚点 apply 都走一次内存 transition，revision +1；
 * - 候选库独立键：显式保存写入自己的键，不触碰工作区键；
 * - 离线页：显式预览后才出现下载入口，使用当前 record + epoch；
 * - 所有改动都不自动写工作区键。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import { CANDIDATES_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from '../lib/workspaceTypes'
import type { WorkspaceLockManager } from '../lib/workspaceStorage'
import { CHECKLIST_RELINK_NOTES } from '../lib/checklist'
import {
  addCandidateToRecord,
  createCandidatesBackup,
  createEmptyCandidateRecord,
} from '../lib/candidatePool'
import { MOCK_TRIP } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubHappyFetch(example: unknown = MOCK_TRIP) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(example))
    return Promise.reject(new TypeError(`unexpected url: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function installLocks(): void {
  const chains = new Map<string, Promise<unknown>>()
  const manager: WorkspaceLockManager = {
    request: async <T,>(
      name: string,
      _options: { mode: 'exclusive' },
      callback: () => Promise<T> | T,
    ): Promise<T> => {
      const previous = chains.get(name) ?? Promise.resolve()
      const run = previous.then(
        () => callback(),
        () => callback(),
      )
      chains.set(
        name,
        run.then(
          () => undefined,
          () => undefined,
        ),
      )
      return await run
    },
  }
  Object.defineProperty(window.navigator, 'locks', { configurable: true, value: manager })
}

function hubRegion(): HTMLElement {
  return screen.getByRole('region', { name: '工作区与版本' })
}

async function setupLinkedWorkspace(user: ReturnType<typeof userEvent.setup>) {
  render(<App />)
  await screen.findByText(MOCK_TRIP.title)
  await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
  expect(await screen.findByText(/已关联《/)).toBeInTheDocument()
}

describe('App × 行程工具真实接线', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
    stubHappyFetch()
    installLocks()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // @ts-expect-error 测试环境清理注入的锁
    delete window.navigator.locks
  })

  it('F5 清单：受控 onChange 生成整体 transition，revision +1 且不自动写工作区键', async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)

    await user.click(screen.getByRole('button', { name: '准备清单' }))
    await user.click(await screen.findByRole('button', { name: '新增清单项' }))
    await user.type(screen.getByLabelText('标题'), '护照')
    await user.click(screen.getByRole('button', { name: '添加这一项' }))

    expect(await screen.findByText('护照')).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('revision 2')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('F2 约束：应用必去点约束走一次 transition，revision +1 且不自动写工作区键', async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)

    await user.click(screen.getByRole('button', { name: '必去点与预约时间约束' }))
    await user.click(await screen.findByRole('button', { name: '添加约束' }))
    await user.type(screen.getByLabelText('标题'), '断桥残雪')
    await user.click(screen.getByRole('button', { name: '保存约束' }))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))

    expect(hubRegion().textContent).toContain('revision 2')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('F1 锚点：预览后显式应用，整体 transition 保留约束/清单并 revision +1', async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)

    await user.click(screen.getByRole('button', { name: '住宿与抵离锚点' }))
    await user.click(await screen.findByRole('button', { name: '添加住宿信息' }))
    await user.type(screen.getByLabelText('住宿名称'), '中央酒店')
    await user.type(screen.getByLabelText('入住日期（当地）'), '2026-04-03')
    await user.type(screen.getByLabelText('退房日期（当地）'), '2026-04-05')
    await user.click(screen.getByRole('button', { name: '预览提案' }))
    await user.click(screen.getByRole('button', { name: '应用提案' }))

    expect(hubRegion().textContent).toContain('revision 2')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('F3 候选库：显式保存只写候选库自己的键，不触碰工作区键', async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)

    await user.click(screen.getByRole('button', { name: '候选地点池' }))
    await user.type(await screen.findByLabelText('候选名称'), '西湖')
    await user.click(screen.getByRole('button', { name: '添加到候选库' }))
    await user.click(screen.getByRole('button', { name: '保存候选库' }))

    expect(await screen.findByText(/候选库已保存/)).toBeInTheDocument()
    expect(window.localStorage.getItem(CANDIDATES_STORAGE_KEY)).toContain('西湖')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('F3 候选库导出：只下载同一份备份字节，不写本地键', async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)
    await user.click(screen.getByRole('button', { name: '候选地点池' }))
    await user.type(await screen.findByLabelText('候选名称'), '西湖')
    await user.click(screen.getByRole('button', { name: '添加到候选库' }))
    await user.click(screen.getByRole('button', { name: '保存候选库' }))
    await screen.findByText(/候选库已保存/)
    const rawBefore = window.localStorage.getItem(CANDIDATES_STORAGE_KEY)

    let exportedJson: string | null = null
    const BlobStub = class {
      constructor(parts: BlobPart[]) {
        exportedJson = String(parts[0] ?? '')
      }
    }
    vi.stubGlobal('Blob', BlobStub)
    const createObjectURL = vi.fn(() => 'blob:candidates')
    const revokeObjectURL = vi.fn()
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})
    vi.stubGlobal(
      'URL',
      Object.create(URL, {
        createObjectURL: { value: createObjectURL },
        revokeObjectURL: { value: revokeObjectURL },
      }),
    )
    try {
      await user.click(screen.getByRole('button', { name: '导出候选库备份' }))
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:candidates')
      const parsed = JSON.parse(exportedJson as unknown as string) as {
        format: string
        version: number
        candidates: { items: Array<{ name: string }> }
      }
      expect(parsed.format).toBe('travel-assistant.workspace.candidates.backup')
      expect(parsed.candidates.items.map((item) => item.name)).toContain('西湖')
    } finally {
      anchorClick.mockRestore()
      vi.unstubAllGlobals()
      stubHappyFetch()
    }
    expect(window.localStorage.getItem(CANDIDATES_STORAGE_KEY)).toBe(rawBefore)
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('F3 候选库导入：先纯校验预览，确认后写入并可撤销回导入前字节', async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)
    await user.click(screen.getByRole('button', { name: '候选地点池' }))
    await user.type(await screen.findByLabelText('候选名称'), '西湖')
    await user.click(screen.getByRole('button', { name: '添加到候选库' }))
    await user.click(screen.getByRole('button', { name: '保存候选库' }))
    await screen.findByText(/候选库已保存/)
    const rawBefore = window.localStorage.getItem(CANDIDATES_STORAGE_KEY)
    expect(rawBefore).not.toBeNull()

    // 构造一份合法候选库备份（导入端只认公共 envelope）
    const empty = createEmptyCandidateRecord(2_000)
    if (!empty.ok) throw new Error(empty.message)
    const added = addCandidateToRecord(
      empty.value,
      {
        id: 'cand-import-1',
        name: '灵隐寺',
        address: null,
        notes: null,
        tags: [],
        priority: 1,
        location: null,
        source: 'manual',
        copiedFromStopId: null,
        createdAt: 2_000,
        updatedAt: 2_000,
      },
      2_000,
    )
    if (!added.ok) throw new Error(added.message)
    const backup = createCandidatesBackup(added.value.record, 2_000)
    if (!backup.ok) throw new Error(backup.message)
    const file = new File([backup.value.json], 'candidates-backup.json', {
      type: 'application/json',
    })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: async () => backup.value.json,
    })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).not.toBeNull()
    fireEvent.change(input, { target: { files: [file] } })

    const preview = await screen.findByRole('region', { name: '候选库导入预览' })
    expect(preview.textContent).toContain('1 个候选')
    expect(window.localStorage.getItem(CANDIDATES_STORAGE_KEY)).toBe(rawBefore)

    await user.click(within(preview).getByRole('button', { name: '确认导入候选库' }))
    expect(await screen.findByText(/候选库导入完成/)).toBeInTheDocument()
    expect(window.localStorage.getItem(CANDIDATES_STORAGE_KEY)).toContain('灵隐寺')

    await user.click(screen.getByRole('button', { name: '撤销最近一次候选库导入' }))
    await waitFor(() =>
      expect(window.localStorage.getItem(CANDIDATES_STORAGE_KEY)).toBe(rawBefore),
    )
    expect(window.localStorage.getItem(CANDIDATES_STORAGE_KEY)).toContain('西湖')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('F6 离线页：显式预览后才出现下载入口，不读写存储', async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)

    const panel = screen.getByRole('region', { name: '离线随身行程页（单文件 HTML）' })
    expect(within(panel).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
    await user.click(within(panel).getByRole('button', { name: '预览离线行程页' }))
    expect(await within(panel).findByRole('button', { name: '下载离线页 (.html)' })).toBeInTheDocument()
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  /* ───────── F5 × F2：同 ID 预约修改后的 needsRelink 审计 ───────── */

  function hubRevision(): number {
    const match = hubRegion().textContent.match(/revision (\d+)/)
    return match ? Number(match[1]) : 0
  }

  async function addMustVisitConstraint(
    user: ReturnType<typeof userEvent.setup>,
    title: string,
  ): Promise<void> {
    const revisionBefore = hubRevision()
    await user.click(screen.getByRole('button', { name: '必去点与预约时间约束' }))
    await screen.findByRole('region', { name: '必去点与预约时间约束' })
    await user.click(screen.getByRole('button', { name: '添加约束' }))
    await user.type(screen.getByLabelText('标题'), title)
    await user.click(screen.getByRole('button', { name: '保存约束' }))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    await waitFor(() => expect(hubRevision()).toBe(revisionBefore + 1))
    await user.click(screen.getByRole('button', { name: '必去点与预约时间约束' }))
  }

  /** 修改已有约束的绑定站点（null → 具体 stop），触发同 ID 锚点变化。 */
  async function bindConstraintStop(
    user: ReturnType<typeof userEvent.setup>,
    constraintTitle: string,
    stopOptionText: string,
  ): Promise<void> {
    const revisionBefore = hubRevision()
    await user.click(screen.getByRole('button', { name: '必去点与预约时间约束' }))
    await screen.findByRole('region', { name: '必去点与预约时间约束' })
    await user.click(screen.getByRole('button', { name: `编辑约束 ${constraintTitle}` }))
    const stopSelect = screen.getByLabelText('绑定站点') as HTMLSelectElement
    const option = Array.from(stopSelect.options).find((entry) =>
      entry.textContent?.startsWith(stopOptionText),
    )
    if (!option) throw new Error(`找不到绑定站点选项：${stopOptionText}`)
    await user.selectOptions(stopSelect, option.value)
    await user.click(screen.getByRole('button', { name: '保存约束' }))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    await waitFor(() => expect(hubRevision()).toBe(revisionBefore + 1))
    await user.click(screen.getByRole('button', { name: '必去点与预约时间约束' }))
  }

  async function addLinkedChecklistItem(
    user: ReturnType<typeof userEvent.setup>,
    title: string,
    constraintTitle: string,
  ): Promise<void> {
    if (screen.queryByRole('button', { name: '新增清单项' }) === null) {
      await user.click(screen.getByRole('button', { name: '准备清单' }))
    }
    await user.click(screen.getByRole('button', { name: '新增清单项' }))
    await user.type(screen.getByLabelText('标题'), title)
    const constraintSelect = screen.getByLabelText('关联预约（可选）') as HTMLSelectElement
    const option = Array.from(constraintSelect.options).find(
      (entry) => entry.textContent?.trim() === constraintTitle,
    )
    if (!option) throw new Error(`找不到关联预约选项：${constraintTitle}`)
    await user.selectOptions(constraintSelect, option.value)
    await user.click(screen.getByRole('button', { name: '添加这一项' }))
    await screen.findByText(title)
  }

  it('F5 同 ID 预约修改：关联任务显示需复核，任务与 done 保留，不自动写工作区键', { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)
    await addMustVisitConstraint(user, '断桥残雪')

    await addLinkedChecklistItem(user, '核对预约A', '断桥残雪')
    // 未修改约束时不误报
    expect(screen.queryByRole('region', { name: '需重新关联的清单项' })).toBeNull()
    await user.click(screen.getByLabelText('核对预约A：未准备'))
    await user.click(screen.getByRole('button', { name: '准备清单' }))

    // 同 ID 约束改绑定站点：日期 / 地点锚点变化，关联任务必须提示复核
    await bindConstraintStop(user, '断桥残雪', '断桥残雪')

    await user.click(screen.getByRole('button', { name: '准备清单' }))
    const audit = await screen.findByRole('region', { name: '需重新关联的清单项' })
    expect(audit.textContent).toContain('核对预约A')
    expect(audit.textContent).toContain('已变更')
    // 任务与 done 都不丢
    expect(screen.getByLabelText('核对预约A：已准备')).toBeInTheDocument()
    expect(screen.getByText('核对预约A')).toBeInTheDocument()
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('F5 逐条语义：mark 只是标记，逐条「按当前预约重新核对」才解除；另一条任务不受影响', { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)
    await addMustVisitConstraint(user, '断桥残雪')
    await addMustVisitConstraint(user, '平湖秋月')

    await addLinkedChecklistItem(user, '核对预约A', '断桥残雪')
    await addLinkedChecklistItem(user, '核对预约B', '平湖秋月')
    await user.click(screen.getByLabelText('核对预约A：未准备'))
    await user.click(screen.getByRole('button', { name: '准备清单' }))

    await bindConstraintStop(user, '断桥残雪', '断桥残雪')

    await user.click(screen.getByRole('button', { name: '准备清单' }))
    const audit = await screen.findByRole('region', { name: '需重新关联的清单项' })
    expect(audit.textContent).toContain('核对预约A')
    // 只影响被改约束的关联任务：B 的任务不误伤
    expect(audit.textContent).not.toContain('核对预约B')

    // mark 只是标记：A 出现生成标记但提示仍在；未受影响的 B 从头到尾没有提示
    const auditAfterChange = screen.getByRole('region', { name: '需重新关联的清单项' })
    const rowA = within(auditAfterChange).getAllByRole('listitem')[0]
    fireEvent.click(within(rowA).getByRole('button', { name: '标记需重新关联' }))
    await waitFor(() =>
      expect(screen.getByText(CHECKLIST_RELINK_NOTES.constraint_changed)).toBeInTheDocument(),
    )
    expect(screen.getByRole('region', { name: '需重新关联的清单项' }).textContent).toContain('核对预约A')
    expect(screen.getByRole('region', { name: '需重新关联的清单项' }).textContent).not.toContain(
      '核对预约B',
    )

    // 真正重新核对 A：只解除 A 的提示；A 的 done / 锚点更新可见，B 原样
    const rowForReconfirm = within(
      screen.getByRole('region', { name: '需重新关联的清单项' }),
    ).getAllByRole('listitem')[0]
    fireEvent.click(within(rowForReconfirm).getByRole('button', { name: '按当前预约重新核对' }))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '需重新关联的清单项' })).toBeNull(),
    )
    // A 条目：done 保留、生成标记随核对解除、地点锚点已更新到当前约束
    expect(screen.getByLabelText('核对预约A：已准备')).toBeInTheDocument()
    expect(screen.queryByText(CHECKLIST_RELINK_NOTES.constraint_changed)).toBeNull()
    expect(screen.getAllByText(/地点 断桥残雪/).length).toBeGreaterThan(0)
    // B 任务原样存在；无关勾选不产生任何提示
    await user.click(screen.getByLabelText('核对预约B：未准备'))
    expect(screen.queryByRole('region', { name: '需重新关联的清单项' })).toBeNull()
    expect(screen.getByText('核对预约B')).toBeInTheDocument()
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('F3 候选加入草稿：切日期页签等无关渲染不作废预览；确认后进入草稿编辑（新 visit id / caveat 不变）', async () => {
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)

    await user.click(screen.getByRole('button', { name: '候选地点池' }))
    await user.type(screen.getByLabelText('候选名称'), '灵隐新址')
    await user.click(screen.getByRole('button', { name: '添加到候选库' }))
    await screen.findByText('灵隐新址')

    const row = screen.getByText('灵隐新址').closest('li')
    if (row === null) throw new Error('找不到候选条目')
    await user.click(within(row).getByRole('button', { name: '加入草稿' }))
    await user.type(screen.getByLabelText('加入时间（HH:MM）'), '10:00')
    await user.click(screen.getByRole('button', { name: '生成加入预览' }))

    const proposal = screen.getByTestId('candidate-pool-proposal')
    expect(within(proposal).getByText(/不复用候选 id/)).toBeInTheDocument()
    // 手工候选没有坐标：caveat 必须可见，不补 (0,0)
    expect(within(proposal).getByText(/候选坐标未知；不会补 \(0,0\)/)).toBeInTheDocument()

    // 切日期页签 = 无关渲染：预览不被静默作废
    await user.click(screen.getByRole('tab', { name: /龙井问茶/ }))
    expect(screen.getByTestId('candidate-pool-proposal')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '确认加入草稿' }))
    expect(await screen.findByTestId('draft-preview-note')).toBeInTheDocument()
    expect(screen.getAllByText('灵隐新址').length).toBeGreaterThan(0)
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })
})

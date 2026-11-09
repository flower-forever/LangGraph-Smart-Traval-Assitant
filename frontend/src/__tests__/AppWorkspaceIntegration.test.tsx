/**
 * App × WorkspaceHub 接线集成测试：
 * - 默认关闭：渲染后不读版本库 / 工作区键，更不读会话恢复数据键；
 * - 无锁环境（jsdom 默认）：写入 typed 停用，不假装可用；
 * - 有锁：新建工作区 → 打开版本库 → 显式保存版本 → 预览采用 → 确认采用（Trip/budget
 *   整体切换、revision 当前 +1）→ 一次撤销；
 * - 同 id 行程替换（恢复已保存行程）走整体 transition，工作区保持关联且 revision +1。
 * mock fetch（复用既有 App integration mock 方式）；不 mock 工作区 / 版本库纯函数。
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import { saveTripToStorage } from '../lib/savedTrips'
import {
  SESSION_RESUME_DATA_KEY,
  loadSessionResumeRecord,
  setSessionResumeFlag,
  writeSessionResume,
} from '../lib/sessionRestore'
import {
  VERSIONS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  type WorkspaceRecordV1,
  type WorkspaceSidecarV1,
} from '../lib/workspaceTypes'
import { createWorkspaceRecord, emptySidecar } from '../lib/workspace'
import type { WorkspaceLockManager } from '../lib/workspaceStorage'
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

/** jsdom 没有 navigator.locks：注入一个最小可用的互斥管理器（串行队列）。 */
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
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: manager,
  })
}

function hubRegion(): HTMLElement {
  return screen.getByRole('region', { name: '工作区与版本' })
}

describe('App 工作区与版本接线', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
    stubHappyFetch()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // @ts-expect-error 测试环境清理注入的锁
    delete window.navigator.locks
  })

  it('默认关闭：渲染后不读工作区 / 版本库键，也不读会话恢复数据键', async () => {
    const readKeys: string[] = []
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation((key: string) => {
      readKeys.push(key)
      return localStorage.getItem(key)
    })
    render(<App />)
    await screen.findByText(MOCK_TRIP.title)
    const hub = hubRegion()
    expect(hub).toBeInTheDocument()
    expect(hub.textContent).toContain('尚未读取版本库')
    expect(screen.queryByRole('region', { name: '行程版本与方案对比' })).not.toBeInTheDocument()
    for (const key of readKeys) {
      expect(key).not.toBe(SESSION_RESUME_DATA_KEY)
      expect(key).not.toBe(VERSIONS_STORAGE_KEY)
      expect(key).not.toBe(WORKSPACE_STORAGE_KEY)
    }
    spy.mockRestore()
  })

  it('无锁环境：写入 typed 停用（创建/保存禁用），读取入口保持可用', async () => {
    // 显式移除锁：jsdom 可能自带 navigator.locks，这里按「明确无锁」的语义注入 undefined
    Object.defineProperty(window.navigator, 'locks', { configurable: true, value: undefined })
    render(<App />)
    await screen.findByText(MOCK_TRIP.title)
    expect(hubRegion().textContent).toContain('保存已停用')
    expect(screen.getByRole('button', { name: '用当前行程新建工作区' })).toBeDisabled()
    // 只读入口不受锁影响：无锁 = 只读，不是整体禁用
    expect(screen.getByRole('button', { name: '打开版本库' })).toBeEnabled()
    await userEvent.setup().click(screen.getByRole('button', { name: '打开版本库' }))
    expect(await screen.findByText('版本库为空。')).toBeInTheDocument()
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(VERSIONS_STORAGE_KEY)).toBeNull()
  })

  it('有锁：新建工作区 → 打开版本库 → 保存版本 → 预览采用 → 确认采用 → 一次撤销', { timeout: 20_000 }, async () => {
    installLocks()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(MOCK_TRIP.title)

    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    expect(await screen.findByText(/已关联《/)).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('revision 1')

    await user.click(screen.getByRole('button', { name: '打开版本库' }))
    const versionsPanel = await screen.findByRole('region', { name: '行程版本与方案对比' })
    expect(versionsPanel).toBeInTheDocument()

    await user.type(screen.getByLabelText('版本名称'), '方案 A')
    await user.click(screen.getByRole('button', { name: '保存为版本' }))
    expect(await screen.findByText(/已保存版本《方案 A》/)).toBeInTheDocument()
    const versionsRaw = window.localStorage.getItem(VERSIONS_STORAGE_KEY)
    expect(versionsRaw).not.toBeNull()
    expect(versionsRaw).toContain('方案 A')

    // 采用：先预览再确认（按钮 accessible name = aria-label，含版本名与创建时间）
    await user.click(within(versionsPanel).getByRole('button', { name: /预览采用版本 方案 A/ }))
    await user.click(screen.getByRole('button', { name: '确认采用此版本' }))
    expect(await screen.findByText(/已采用版本/)).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('revision 2')

    // 一次整体撤销
    await user.click(screen.getByRole('button', { name: '撤销本次采用' }))
    expect(await screen.findByText(/已整体撤销这次版本采用/)).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('revision 3')
    // 版本库键不被采用 / 撤销改写
    const afterUndo = window.localStorage.getItem(VERSIONS_STORAGE_KEY)
    expect(afterUndo).not.toBeNull()
    expect(afterUndo).toContain('方案 A')
  })

  it('同 id 行程替换走整体 transition：恢复同一份已保存行程后工作区 revision +1 且保持关联', async () => {
    installLocks()
    const saved = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(saved.ok).toBe(true)
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(MOCK_TRIP.title)

    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    expect(await screen.findByText(/已关联《/)).toBeInTheDocument()

    // 已保存行程面板默认收起：展开列表再恢复（同 trip.id → 整体 transition）
    await user.click(screen.getByRole('button', { name: /已保存行程/ }))
    await user.click(screen.getByRole('button', { name: /恢复保存的行程/ }))
    // 门通过：工作区保持关联，revision 由 1 → 2；未进入 detached 提示
    expect(await screen.findByText(/revision 2/)).toBeInTheDocument()
    expect(hubRegion().textContent).not.toContain('工作区约束在当前页面解除')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  /* ───────── 会话恢复 v2：workspace 整体提案 + 真实内存 refs / fresh raw ───────── */

  function sidecarWithChecklist(title: string): WorkspaceSidecarV1 {
    const sidecar = emptySidecar()
    return {
      ...sidecar,
      checklist: {
        items: [
          {
            id: 'chk-session-1',
            category: 'document',
            title,
            done: false,
            date: null,
            day: null,
            stopId: null,
            originalStopId: null,
            constraintId: null,
            notes: null,
            updatedAt: 1_000,
          },
        ],
        appliedTemplates: [],
      },
    }
  }

  function sessionWorkspaceRecord(
    revision: number,
    sidecar: WorkspaceSidecarV1,
    workspaceId = 'ws-session-1',
  ): WorkspaceRecordV1 {
    const made = createWorkspaceRecord({
      workspaceId,
      ownerId: 'owner-session-1',
      trip: MOCK_TRIP,
      workspaceRevision: revision,
      now: 1_000,
      sidecar,
    })
    if (!made.ok) throw new Error(made.message)
    return made.value
  }

  function seedSessionRecord(workspace?: WorkspaceRecordV1) {
    const written = writeSessionResume(
      {
        payload: {
          trip: MOCK_TRIP,
          draft: null,
          budget: null,
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
          ...(workspace === undefined ? {} : { workspace }),
        },
        expectedRaw: null,
      },
      window.localStorage,
    )
    if (!written.ok) throw new Error(written.message)
    return written.writtenRaw
  }

  async function openChecklistAndAdd(user: ReturnType<typeof userEvent.setup>, title: string) {
    await user.click(screen.getByRole('button', { name: '准备清单' }))
    await user.click(screen.getByRole('button', { name: '新增清单项' }))
    await user.type(screen.getByLabelText('标题'), title)
    await user.click(screen.getByRole('button', { name: '添加这一项' }))
    await screen.findByText(title)
  }

  it('恢复 v2 新工作区：整体安装 Trip + sidecar，revision 从 1 开始，不自动写工作区键', async () => {
    const record = sessionWorkspaceRecord(7, sidecarWithChecklist('护照'))
    seedSessionRecord(record)
    setSessionResumeFlag(window.localStorage, true)

    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))

    expect(await screen.findByText(/工作区记录已整体恢复到内存/)).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('已关联')
    // 新工作区从当前 0 + 1 开始，不回放快照里的 revision 7
    expect(hubRegion().textContent).toContain('revision 1')
    // sidecar 一并恢复
    await user.click(screen.getByRole('button', { name: '准备清单' }))
    expect(await screen.findByText('护照')).toBeInTheDocument()
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('恢复 v2 到已有同 id 内存工作区：当前 revision 3 → 4，raw 基线不自动写库', { timeout: 20_000 }, async () => {
    installLocks()
    const record = sessionWorkspaceRecord(9, sidecarWithChecklist('护照'))
    seedSessionRecord(record)

    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(MOCK_TRIP.title)
    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    expect(await screen.findByText(/已关联《/)).toBeInTheDocument()
    // 两次清单 transition：revision 1 → 3
    await openChecklistAndAdd(user, '身份证')
    await user.click(screen.getByRole('button', { name: '新增清单项' }))
    await user.type(screen.getByLabelText('标题'), '充电器')
    await user.click(screen.getByRole('button', { name: '添加这一项' }))
    await screen.findByText('充电器')
    expect(hubRegion().textContent).toContain('revision 3')

    // 启用留存时读取已播种的 v2 副本（不自动写回）
    await user.click(screen.getByRole('button', { name: /在此浏览器保留工作进度/ }))
    const card = await screen.findByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))

    expect(await screen.findByText(/工作区记录（Trip \+ sidecar \+ 预算快照）已整体恢复/)).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('revision 4')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
    // 恢复不是删除：留存键仍存在；启用态下的下一次自动写以恢复后的 revision 4 为基线
    const rawAfter = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    expect(rawAfter).not.toBeNull()
    const parsedAfter = JSON.parse(rawAfter as string) as {
      session: { workspace: { workspaceRevision: number } }
    }
    expect(parsedAfter.session.workspace.workspaceRevision).toBe(4)
  })

  it('恢复前 raw A→B：拒绝恢复，B 逐字节保留，页面与工作区内存不变', async () => {
    const rawA = seedSessionRecord(sessionWorkspaceRecord(3, sidecarWithChecklist('护照')))
    setSessionResumeFlag(window.localStorage, true)

    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    // 外部（另一标签页）把副本换成 B
    const writtenB = writeSessionResume(
      {
        payload: {
          trip: MOCK_TRIP,
          draft: null,
          budget: null,
          ui: { activeDay: 2, draftMode: 'driving', openedFromFile: true },
          workspace: sessionWorkspaceRecord(4, sidecarWithChecklist('别的清单')),
        },
        expectedRaw: rawA,
      },
      window.localStorage,
    )
    if (!writtenB.ok) throw new Error(writtenB.message)
    const rawB = writtenB.writtenRaw
    expect(rawB).not.toBe(rawA)

    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))

    expect(await screen.findByText(/检测到另一个标签页更新了留存副本/)).toBeInTheDocument()
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawB)
    // 页面仍是示例行程，没有装上 A 或 B 的 workspace
    expect(screen.getByText(MOCK_TRIP.title)).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('用当前行程新建工作区')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('v1 恢复只还原 Trip：解除当前工作区，不按同 tripId 挂接存储里的 sidecar', { timeout: 20_000 }, async () => {
    installLocks()
    seedSessionRecord()

    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(MOCK_TRIP.title)
    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    expect(await screen.findByText(/已关联《/)).toBeInTheDocument()
    await openChecklistAndAdd(user, '内存里的护照')
    await user.click(screen.getByRole('button', { name: '准备清单' }))

    // 现在 localStorage 里有一份同一 trip.id 的完整工作区；v1 恢复不得自动读取或挂接
    const storedWorkspace = sessionWorkspaceRecord(5, sidecarWithChecklist('存储里的护照'), 'ws-stored-1')
    const storedRaw = JSON.stringify(storedWorkspace)
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, storedRaw)

    await user.click(screen.getByRole('button', { name: /在此浏览器保留工作进度/ }))
    const card = await screen.findByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))

    expect(await screen.findByText(/没有工作区数据/)).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('用当前行程新建工作区')
    expect(screen.queryByText('内存里的护照')).toBeNull()
    // 存储里的工作区原文既没被读取挂接，也没被改写
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(storedRaw)
  })

  it('StrictMode：双 setup+cleanup 后工作区状态仍真实更新（新建 → 关联 → F5 transition）', { timeout: 20_000 }, async () => {
    installLocks()
    const user = userEvent.setup()
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    await screen.findByText(MOCK_TRIP.title)

    // StrictMode dev 会给每个 effect 跑一次额外的 setup+cleanup；
    // hook 的 mounted guard 必须在 setup 里恢复，否则这里永远停在「未关联」。
    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    expect(await screen.findByText(/已关联《/)).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('revision 1')

    await user.click(screen.getByRole('button', { name: '准备清单' }))
    await user.click(screen.getByRole('button', { name: '新增清单项' }))
    await user.type(screen.getByLabelText('标题'), 'StrictMode 护照')
    await user.click(screen.getByRole('button', { name: '添加这一项' }))
    expect(await screen.findByText('StrictMode 护照')).toBeInTheDocument()
    expect(hubRegion().textContent).toContain('revision 2')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  /* ───────── 会话留存 × sidecar-only transition ───────── */

  interface SeededSessionWorkspace {
    workspaceRevision: number
    sidecar: {
      checklist: { items: Array<{ title: string }> }
      constraints: { items: Array<{ title: string }> }
      anchors: { accommodation: { name: string } | null }
    }
  }

  function parseSessionWorkspace(): SeededSessionWorkspace | null {
    const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as {
      session: { workspace: SeededSessionWorkspace | null }
    }
    return parsed.session.workspace
  }

  function countSessionWrites(spy: ReturnType<typeof vi.spyOn>): number {
    return spy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY).length
  }

  it('flag off：sidecar 编辑不读写留存数据键，也不写工作区键', { timeout: 20_000 }, async () => {
    installLocks()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(MOCK_TRIP.title)
    const dataReads: string[] = []
    const dataWrites: string[] = []
    const originalGet = Storage.prototype.getItem
    const originalSet = Storage.prototype.setItem
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(function (this: Storage, key: string) {
        if (key === SESSION_RESUME_DATA_KEY) dataReads.push(key)
        return originalGet.call(this, key)
      })
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === SESSION_RESUME_DATA_KEY) dataWrites.push(key)
        return originalSet.call(this, key, value)
      })
    try {
      await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
      expect(await screen.findByText(/已关联《/)).toBeInTheDocument()
      await openChecklistAndAdd(user, 'flagoff 清单')
      expect(dataReads).toEqual([])
      expect(dataWrites).toEqual([])
      expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
    } finally {
      getItemSpy.mockRestore()
      setItemSpy.mockRestore()
    }
  })

  it('flagon：清单 / 约束 / 锚点 sidecar-only transition 都按当前 workspace 更新 v2 留存；reload 可读；不写工作区键、无自触发循环', { timeout: 20_000 }, async () => {
    installLocks()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(MOCK_TRIP.title)

    await user.click(screen.getByRole('button', { name: /在此浏览器保留工作进度/ }))
    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    expect(await screen.findByText(/已关联《/)).toBeInTheDocument()
    await waitFor(() => expect(parseSessionWorkspace()).not.toBeNull())
    expect(parseSessionWorkspace()?.workspaceRevision).toBe(1)

    // 清单（sidecar-only）：revision 1 → 2，留存 payload 携带新清单
    await openChecklistAndAdd(user, '留存护照')
    await waitFor(() => {
      const seeded = parseSessionWorkspace()
      expect(seeded?.workspaceRevision).toBe(2)
      expect(JSON.stringify(seeded?.sidecar.checklist)).toContain('留存护照')
    })

    // 约束（sidecar-only）：revision 2 → 3
    await user.click(screen.getByRole('button', { name: '准备清单' }))
    const constraintsRevisionBefore = Number(
      hubRegion().textContent.match(/revision (\d+)/)?.[1] ?? 0,
    )
    await user.click(screen.getByRole('button', { name: '必去点与预约时间约束' }))
    await screen.findByRole('region', { name: '必去点与预约时间约束' })
    await user.click(screen.getByRole('button', { name: '添加约束' }))
    await user.type(screen.getByLabelText('标题'), '断桥残雪')
    await user.click(screen.getByRole('button', { name: '保存约束' }))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    await waitFor(() => {
      const seeded = parseSessionWorkspace()
      expect(seeded?.workspaceRevision).toBe(constraintsRevisionBefore + 1)
      expect(JSON.stringify(seeded?.sidecar.constraints)).toContain('断桥残雪')
    })
    await user.click(screen.getByRole('button', { name: '必去点与预约时间约束' }))

    // 锚点（sidecar-only）：添加住宿并应用 → revision +1，留存携带 accommodation
    const anchorsRevisionBefore = Number(
      hubRegion().textContent.match(/revision (\d+)/)?.[1] ?? 0,
    )
    await user.click(screen.getByRole('button', { name: '住宿与抵离锚点' }))
    await user.click(screen.getByRole('button', { name: '添加住宿信息' }))
    await user.type(screen.getByLabelText('住宿名称'), '留存酒店')
    await user.type(screen.getByLabelText('入住日期（当地）'), '2026-04-03')
    await user.type(screen.getByLabelText('退房日期（当地）'), '2026-04-05')
    await user.click(screen.getByRole('button', { name: '预览提案' }))
    await user.click(screen.getByRole('button', { name: '应用提案' }))
    await waitFor(() => {
      const seeded = parseSessionWorkspace()
      expect(seeded?.workspaceRevision).toBe(anchorsRevisionBefore + 1)
      expect(seeded?.sidecar.anchors.accommodation?.name).toBe('留存酒店')
    })

    // reload 视角：留存键按当前 workspace 重建（不能用 persisted 旧 revision 误判）
    const load = loadSessionResumeRecord(window.localStorage)
    expect(load.status).toBe('pending')
    if (load.status === 'pending') {
      expect(load.record.session.workspace?.workspaceRevision).toBe(anchorsRevisionBefore + 1)
      expect(JSON.stringify(load.record.session.workspace?.sidecar.checklist)).toContain('留存护照')
      expect(JSON.stringify(load.record.session.workspace?.sidecar.constraints)).toContain('断桥残雪')
      expect(load.record.session.workspace?.sidecar.anchors.accommodation?.name).toBe('留存酒店')
    }

    // 不写工作区键；静止后无自触发循环
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    try {
      const writesBefore = countSessionWrites(setItemSpy)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150))
      })
      expect(countSessionWrites(setItemSpy)).toBe(writesBefore)
    } finally {
      setItemSpy.mockRestore()
    }
  })
})

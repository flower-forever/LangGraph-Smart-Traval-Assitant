/**
 * App × DayReplanPanel × F2 约束接线测试：
 * - 关联工作区后，AI day 请求体带严格 constraints wire（scope/day/parent.revision）；
 * - 候选含 H 级硬冲突：拒绝应用，不提供确认入口，revision / 存储不变；
 * - 候选含 U 级未知时间端：先在面板外独立确认，确认后才走一次整体 transition；
 * - 应用后 sidecar 约束保留，且不自动写工作区键。
 *
 * 业务请求（health / example / replan）用 fetch mock；build / validate / apply 走真实模块。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import type { DayReplanRequest, DayReplanResponse } from '../lib/dayReplan'
import type { WorkspaceLockManager } from '../lib/workspaceStorage'
import { WORKSPACE_STORAGE_KEY } from '../lib/workspaceTypes'
import { MOCK_TRIP } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function candidateFor(request: DayReplanRequest): DayReplanResponse {
  const firstId = 'ai-day-1'
  const secondId = 'ai-day-2'
  return {
    day: {
      day: request.day,
      date: request.date,
      title: 'AI 调整后的运河线',
      summary: 'AI 候选摘要：拱宸桥与小河直街。',
      stops: [
        {
          id: firstId,
          name: '拱宸桥',
          time: '09:30',
          duration_minutes: 60,
          description: '运河边的石拱桥。',
          address: '杭州市拱墅区桥弄街',
          location: { lng: 120.14, lat: 30.32 },
        },
        {
          id: secondId,
          name: '小河直街',
          time: '11:00',
          duration_minutes: 90,
          description: '运河畔的旧街区。',
          address: '杭州市拱墅区小河直街',
          location: { lng: 120.141, lat: 30.306 },
        },
      ],
      legs: [
        {
          from_stop_id: firstId,
          to_stop_id: secondId,
          mode: request.travel_mode,
          route_type: 'navigation',
          distance_m: 820,
          duration_minutes: 13,
          geometry: [
            { lng: 120.14, lat: 30.32 },
            { lng: 120.141, lat: 30.306 },
          ],
          description: '沿运河步行。',
        },
      ],
    },
    warnings: ['本次返回提醒：09:30 是计划时刻，不是已确认的预约时间。'],
    map_status: 'ready',
    parent: { ...request.parent },
    source: 'agent',
  }
}

type ReplanHandler = (request: DayReplanRequest, body: unknown) => Promise<Response> | Response

function stubFetch(handler: ReplanHandler) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/health') {
      return Promise.resolve(jsonResponse({ status: 'healthy', planner_ready: true }))
    }
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
    if (url === '/api/trips/days/replan') {
      const body = JSON.parse(String(init?.body)) as unknown
      return Promise.resolve(handler(body as DayReplanRequest, body))
    }
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

async function openConstraintsPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '必去点与预约' }))
  await screen.findByRole('region', { name: '必去点与预约时间约束' })
}

async function applyReminderConstraint(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) {
  await openConstraintsPanel(user)
  await user.click(screen.getByRole('button', { name: '添加约束' }))
  await user.selectOptions(screen.getByLabelText('类型'), 'reminder')
  await user.type(screen.getByLabelText('标题'), title)
  await user.click(screen.getByRole('button', { name: '保存约束' }))
  await user.click(screen.getByRole('button', { name: '应用约束改动' }))
  await waitFor(() => expect(hubRegion().textContent).toContain('revision 2'))
  // 收起约束面板，给 AI 面板让位
  await user.click(screen.getByRole('button', { name: '必去点与预约' }))
}

async function applyMustVisitConstraint(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) {
  await openConstraintsPanel(user)
  await user.click(screen.getByRole('button', { name: '添加约束' }))
  await user.type(screen.getByLabelText('标题'), title)
  await user.click(screen.getByRole('button', { name: '保存约束' }))
  await user.click(screen.getByRole('button', { name: '应用约束改动' }))
  await waitFor(() => expect(hubRegion().textContent).toContain('revision 2'))
  await user.click(screen.getByRole('button', { name: '必去点与预约' }))
}

async function applyIncompleteWindowConstraint(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) {
  await openConstraintsPanel(user)
  await user.click(screen.getByRole('button', { name: '添加约束' }))
  await user.selectOptions(screen.getByLabelText('类型'), 'fixed_window')
  await user.type(screen.getByLabelText('标题'), title)
  await user.type(screen.getByLabelText('开始日期'), '2026-04-03')
  await user.click(screen.getByRole('button', { name: '保存约束' }))
  await user.click(screen.getByLabelText(/我确认仍采用含未核实时间方案/))
  await user.click(screen.getByRole('button', { name: '应用约束改动' }))
  await waitFor(() => expect(hubRegion().textContent).toContain('revision 2'))
  await user.click(screen.getByRole('button', { name: '必去点与预约' }))
}

async function openAiPanelAndGenerate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'AI 调整这一天' }))
  const panel = await screen.findByRole('region', { name: 'AI 调整单日安排' })
  await user.click(within(panel).getByLabelText('步行'))
  await user.type(within(panel).getByLabelText(/调整指令/), '把这一天调整成运河线。')
  await user.click(within(panel).getByRole('button', { name: '生成调整候选' }))
  return panel
}

describe('App AI 单日 × F2 约束接线', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
    installLocks()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // @ts-expect-error 测试环境清理注入的锁
    delete window.navigator.locks
  })

  it('请求体带 constraints：scope/day/parent.revision 与当前工作区一致；应用后 revision+1 且 sidecar 保留', { timeout: 20_000 }, async () => {
    let requestBody: Record<string, unknown> | null = null
    stubFetch((request, body) => {
      requestBody = body as Record<string, unknown>
      return jsonResponse(candidateFor(request))
    })
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)
    await applyReminderConstraint(user, '预约提醒')

    await openAiPanelAndGenerate(user)
    await waitFor(() => expect(requestBody).not.toBeNull())
    const body = requestBody as unknown as Record<string, unknown>
    expect(body.parent).toEqual({ trip_id: MOCK_TRIP.id, revision: 2 })
    const constraints = body.constraints as Record<string, unknown>
    expect(constraints.version).toBe(1)
    expect(constraints.scope).toBe('day')
    expect(constraints.day).toBe(1)
    expect(constraints.anchor_stop_id).toBeNull()
    expect(typeof constraints.fingerprint).toBe('string')
    const items = constraints.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'reminder',
      title: '预约提醒',
      day: 1,
      stop_id: null,
    })

    const panel = screen.getByRole('region', { name: 'AI 调整单日安排' })
    await user.click(within(panel).getByRole('button', { name: '应用候选' }))
    await waitFor(() => expect(hubRegion().textContent).toContain('revision 3'))
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()

    // 整体 transition 保留 sidecar：重新打开约束面板仍能看到该条目
    await openConstraintsPanel(user)
    expect(await screen.findByText('预约提醒')).toBeInTheDocument()
  })

  it('H1 硬冲突：应用被拒绝，无确认入口，revision 与存储不变', { timeout: 20_000 }, async () => {
    stubFetch((request) => jsonResponse(candidateFor(request)))
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)
    // 必去「断桥残雪」，但 AI 候选整天替换后不再包含该站 -> H
    await applyMustVisitConstraint(user, '断桥残雪')

    await openAiPanelAndGenerate(user)
    const panel = screen.getByRole('region', { name: 'AI 调整单日安排' })
    await user.click(within(panel).getByRole('button', { name: '应用候选' }))

    expect(await within(panel).findByText(/存在 H 级硬冲突/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '未核实时间确认' })).toBeNull()
    // AI 面板打开期间工作区卡片暂时收起；先确认页面 revision 未被应用推进，再关闭面板核对内存 revision。
    expect(screen.getByRole('region', { name: '行程安排' })).toHaveAttribute('data-trip-revision', '2')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
    await user.click(within(panel).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(hubRegion().textContent).toContain('revision 2'))
  })

  it('U1 未知时间端：必须先独立确认，确认后整体 transition 应用并保留约束', { timeout: 20_000 }, async () => {
    stubFetch((request) => jsonResponse(candidateFor(request)))
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)
    // 只填开始日期的预约窗口：时间端未知 -> U
    await applyIncompleteWindowConstraint(user, '西湖游船预约')

    await openAiPanelAndGenerate(user)
    const panel = screen.getByRole('region', { name: 'AI 调整单日安排' })
    await user.click(within(panel).getByRole('button', { name: '应用候选' }))

    const ackRegion = await screen.findByRole('region', { name: '未核实时间确认' })
    // 未确认前不推进页面 revision、不写存储
    expect(screen.getByRole('region', { name: '行程安排' })).toHaveAttribute('data-trip-revision', '2')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
    await user.click(
      within(ackRegion).getByRole('button', { name: '仍采用含未核实时间方案并应用' }),
    )

    await waitFor(() => expect(hubRegion().textContent).toContain('revision 3'))
    expect(screen.queryByRole('region', { name: '未核实时间确认' })).toBeNull()
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('U 确认挂起后修改调整指令：旧确认同步作废，Trip / revision 不变；重新生成后的新候选可再次确认', { timeout: 20_000 }, async () => {
    stubFetch((request) => jsonResponse(candidateFor(request)))
    const user = userEvent.setup()
    await setupLinkedWorkspace(user)
    await applyIncompleteWindowConstraint(user, '西湖游船预约')

    await openAiPanelAndGenerate(user)
    const panel = screen.getByRole('region', { name: 'AI 调整单日安排' })
    await user.click(within(panel).getByRole('button', { name: '应用候选' }))
    await screen.findByRole('region', { name: '未核实时间确认' })

    // 只改调整指令（不改工作区）：旧 U 确认必须作废，绝不能把旧候选套在新输入上
    await user.type(within(panel).getByLabelText(/调整指令/), '再顺路加一段运河步道。')
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '未核实时间确认' })).toBeNull(),
    )
    // 未发生任何应用：页面 revision 不变、没有写存储
    expect(screen.getByRole('region', { name: '行程安排' })).toHaveAttribute('data-trip-revision', '2')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
    expect(within(panel).getByRole('button', { name: '应用候选' })).toBeDisabled()

    // 用新输入重新生成：新一轮候选重新走 U 确认（A→B→A 不复活旧确认）
    await user.click(within(panel).getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(within(panel).getByRole('button', { name: '应用候选' })).toBeEnabled())
    await user.click(within(panel).getByRole('button', { name: '应用候选' }))
    await screen.findByRole('region', { name: '未核实时间确认' })

    // 同类代表：改出行方式同样作废旧确认
    await user.click(within(panel).getByLabelText('驾车'))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '未核实时间确认' })).toBeNull(),
    )
    expect(screen.queryByRole('region', { name: '未核实时间确认' })).toBeNull()

    // 再用当前输入重新生成并确认：新候选可以走完整 U 流程
    await user.click(within(panel).getByRole('button', { name: '生成调整候选' }))
    await waitFor(() => expect(within(panel).getByRole('button', { name: '应用候选' })).toBeEnabled())
    await user.click(within(panel).getByRole('button', { name: '应用候选' }))
    const ackThird = await screen.findByRole('region', { name: '未核实时间确认' })
    await user.click(
      within(ackThird).getByRole('button', { name: '仍采用含未核实时间方案并应用' }),
    )
    await waitFor(() => expect(hubRegion().textContent).toContain('revision 3'))
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })
})

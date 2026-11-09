/**
 * App × AssistantDialogPanel 接线集成测试：AI 行程助手入口、五类指令全链路
 * （输入 → 提案 → 应用 → 生效 → 撤销）、H 级禁 apply、别处改行程 → 提案失效、
 * 在途提案不做 UI 复活、重排失败保旧。
 *
 * 业务请求（health / example / replan）一律用 fetch mock；纯函数、面板与真实
 * App 组件不 mock。此文件不启动浏览器，也不发真实服务请求。
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import { SAVED_TRIPS_STORAGE_KEY } from '../lib/savedTrips'
import { WORKSPACE_STORAGE_KEY } from '../lib/workspaceTypes'
import { MOCK_TRIP } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

type ReplanHandler = () => Promise<Response> | Response

/** health / example 正常返回；replan 由每个用例决定如何应答。 */
function stubFetch(options: { replan?: ReplanHandler } = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/health') {
      return Promise.resolve(jsonResponse({ status: 'healthy', planner_ready: true, amap_configured: true }))
    }
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
    if (url === '/api/trips/days/replan') {
      if (!options.replan) return Promise.reject(new TypeError('本用例不应发起 replan 请求'))
      return Promise.resolve(options.replan())
    }
    return Promise.reject(new TypeError(`unexpected url: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function replanUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/replan'))
}

/** jsdom 没有 navigator.locks：注入一个最小可用的互斥管理器（串行队列）。 */
function installLocks(): void {
  const chains = new Map<string, Promise<unknown>>()
  const manager = {
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

async function openAssistant(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'AI 行程助手' }))
  await screen.findByRole('region', { name: 'AI 行程助手' })
}

async function generate(user: ReturnType<typeof userEvent.setup>, instruction: string) {
  const panel = screen.getByRole('region', { name: 'AI 行程助手' })
  await user.clear(within(panel).getByLabelText(/想怎么改/))
  await user.type(within(panel).getByLabelText(/想怎么改/), instruction)
  await user.click(within(panel).getByRole('button', { name: '生成建议' }))
}

function assistantPanel() {
  return screen.getByRole('region', { name: 'AI 行程助手' })
}

function itinerary() {
  return screen.getByRole('tabpanel')
}

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

describe('App AI 行程助手接线', () => {
  it('删除站点全链路：输入 → 提案 → 应用 → 生效 → 撤销，且不写存储', { timeout: 20_000 }, async () => {
    const fetchMock = stubFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const section = screen.getByRole('region', { name: '行程安排' })
    const revisionBefore = Number(section.getAttribute('data-trip-revision'))

    await openAssistant(user)
    // 打开面板本身不发请求、不写存储
    expect(replanUrls(fetchMock)).toHaveLength(0)
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()

    await generate(user, '去掉第 1 天的平湖秋月')
    const card = within(assistantPanel()).getByLabelText('建议卡片')
    expect(within(card).getByText('删除站点')).toBeInTheDocument()
    expect(within(card).getByText(/删掉第 1 天的「平湖秋月」/)).toBeInTheDocument()
    // 提案挂起期间：行程与存储都没动
    expect(within(itinerary()).getByText('平湖秋月')).toBeInTheDocument()
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()

    await user.click(within(card).getByRole('button', { name: '应用建议' }))
    await waitFor(() => expect(within(itinerary()).queryByText('平湖秋月')).toBeNull())
    // 其余站点不变
    expect(within(itinerary()).getByText('断桥残雪')).toBeInTheDocument()
    expect(Number(section.getAttribute('data-trip-revision'))).toBe(revisionBefore + 1)
    // 应用只是内存改动：不写存储
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
    expect(within(assistantPanel()).getByText('已应用')).toBeInTheDocument()

    // 撤销：回到应用前的安排，且不与行程草稿的 undo 栈串联
    await user.click(within(assistantPanel()).getByRole('button', { name: '撤销这条建议' }))
    await waitFor(() => expect(within(itinerary()).getByText('平湖秋月')).toBeInTheDocument())
    expect(Number(section.getAttribute('data-trip-revision'))).toBe(revisionBefore + 2)
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('删掉必去点：H 级硬冲突禁用应用，且没有任何确认绕过入口', { timeout: 20_000 }, async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 先建工作区，再加一条必去点约束
    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    await user.click(screen.getByRole('button', { name: '必去点与预约时间约束' }))
    await user.click(await screen.findByRole('button', { name: '添加约束' }))
    await user.type(screen.getByLabelText('标题'), '平湖秋月')
    await user.click(screen.getByRole('button', { name: '保存约束' }))
    await screen.findByText(/已加入约束「平湖秋月」/)
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '查看约束 平湖秋月' })).toBeInTheDocument(),
    )

    await openAssistant(user)
    await generate(user, '删掉第 1 天的平湖秋月')

    const card = within(assistantPanel()).getByLabelText('建议卡片')
    expect(within(card).getByText(/冲突（/)).toBeInTheDocument()
    expect(within(card).getByText(/必去目标缺失/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '应用建议' })).toBeDisabled()
    // H 级没有 U 级确认入口
    expect(within(card).queryByLabelText('仍采用含未核实时间方案')).toBeNull()
    // 行程与存储都没动
    expect(within(itinerary()).getByText('平湖秋月')).toBeInTheDocument()
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('行程在别处被改：挂起的提案立刻失效，旧提案不会被应用', { timeout: 20_000 }, async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openAssistant(user)
    await generate(user, '去掉第 1 天的平湖秋月')
    expect(within(assistantPanel()).getByRole('button', { name: '应用建议' })).toBeEnabled()

    // 在本地草稿里改行程：与助手面板并存，行程因此变了
    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    const editor = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getByRole('button', { name: '删除第 2 站「平湖秋月」（可撤销）' }))
    await user.click(within(editor).getByRole('button', { name: '应用草稿' }))
    await waitFor(() => expect(within(itinerary()).queryByText('平湖秋月')).toBeNull())

    // 助手面板还在：挂起的提案作废，不能再应用
    await waitFor(() =>
      expect(within(assistantPanel()).getByText(/提案已失效，请重新生成/)).toBeInTheDocument(),
    )
    expect(within(assistantPanel()).getByRole('button', { name: '应用建议' })).toBeDisabled()
  })

  it('关联工作区后：应用让工作区版本 +1，撤销是独立一层（再 +1，版本不回退）', { timeout: 20_000 }, async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 先建工作区：面板改的就是这条工作区记录
    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    await screen.findByText(/已关联《/)
    const status = screen.getByTestId('workspace-status')
    expect(status.textContent).toContain('revision 1')

    await openAssistant(user)
    await generate(user, '去掉第 1 天的平湖秋月')
    await user.click(within(assistantPanel()).getByRole('button', { name: '应用建议' }))

    // 应用：工作区版本 +1，内容生效
    await waitFor(() => expect(screen.getByTestId('workspace-status')).toHaveTextContent('revision 2'))
    expect(within(itinerary()).queryByText('平湖秋月')).toBeNull()

    // 撤销：独立一层，版本继续 +1 而不是回退；内容恢复
    await user.click(within(assistantPanel()).getByRole('button', { name: '撤销这条建议' }))
    await waitFor(() => expect(screen.getByTestId('workspace-status')).toHaveTextContent('revision 3'))
    expect(within(itinerary()).getByText('平湖秋月')).toBeInTheDocument()
    // 撤销不写盘
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('在途提案不做 UI 复活：面板卸载重挂载后没有旧提案', { timeout: 20_000 }, async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openAssistant(user)
    await generate(user, '去掉第 1 天的平湖秋月')
    expect(within(assistantPanel()).getByLabelText('建议卡片')).toBeInTheDocument()

    // 关闭面板再打开：在途提案不复活，行程也没被改
    await user.click(within(assistantPanel()).getByRole('button', { name: '收起' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'AI 行程助手' })).toBeNull())
    await openAssistant(user)
    expect(within(assistantPanel()).queryByLabelText('建议卡片')).toBeNull()
    expect(within(itinerary()).getByText('平湖秋月')).toBeInTheDocument()
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('不采纳：零写入、行程不动、提案作废', { timeout: 20_000 }, async () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem')
    const removeItem = vi.spyOn(window.localStorage, 'removeItem')
    stubFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openAssistant(user)
    await generate(user, '去掉第 1 天的平湖秋月')
    await user.click(within(assistantPanel()).getByRole('button', { name: '不采纳' }))

    expect(within(assistantPanel()).getByText('已放弃')).toBeInTheDocument()
    // 行程与存储都没动
    expect(within(itinerary()).getByText('平湖秋月')).toBeInTheDocument()
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })

  it('U 级冲突：必须单独勾选确认才能应用；确认绑定快照，行程一变立刻失效', { timeout: 20_000 }, async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 先建工作区，再加一条时间端不全的预约窗口约束 → 候选出现 U 级
    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    await user.click(screen.getByRole('button', { name: '必去点与预约时间约束' }))
    await user.click(await screen.findByRole('button', { name: '添加约束' }))
    await user.selectOptions(screen.getByLabelText('类型'), 'fixed_window')
    await user.type(screen.getByLabelText('标题'), '平湖秋月')
    await user.type(screen.getByLabelText('开始日期'), '2026-04-03')
    await user.click(screen.getByRole('button', { name: '保存约束' }))
    await screen.findByText(/已加入约束「平湖秋月」/)
    // 约束本身含未核实时间端：应用约束也要独立确认
    await user.click(screen.getByLabelText(/我确认仍采用含未核实时间方案/))
    await user.click(screen.getByRole('button', { name: '应用约束改动' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '查看约束 平湖秋月' })).toBeInTheDocument(),
    )

    await openAssistant(user)
    await generate(user, '把断桥残雪挪到第 2 天下午')

    const card = within(assistantPanel()).getByLabelText('建议卡片')
    const ack = within(card).getByLabelText('仍采用含未核实时间方案') as HTMLInputElement
    expect(ack.checked).toBe(false)
    // 没有独立确认就不能应用
    expect(within(card).getByRole('button', { name: '应用建议' })).toBeDisabled()

    await user.click(ack)
    expect((within(card).getByLabelText('仍采用含未核实时间方案') as HTMLInputElement).checked).toBe(true)
    expect(within(card).getByRole('button', { name: '应用建议' })).toBeEnabled()

    // 行程在别处变了：确认绑定的是旧快照 → 提案立刻失效
    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    const editor = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getByRole('button', { name: '删除第 2 站「平湖秋月」（可撤销）' }))
    await user.click(within(editor).getByRole('button', { name: '应用草稿' }))
    await waitFor(() => expect(within(itinerary()).queryByText('平湖秋月')).toBeNull())

    await waitFor(() =>
      expect(within(assistantPanel()).getByText(/提案已失效，请重新生成/)).toBeInTheDocument(),
    )
    expect(within(assistantPanel()).getByRole('button', { name: '应用建议' })).toBeDisabled()
  })

  it('已有待确认提案时提交新指令：先问要不要替换，旧提案零写入丢弃', { timeout: 20_000 }, async () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem')
    stubFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openAssistant(user)
    await generate(user, '去掉第 1 天的平湖秋月')
    expect(
      within(within(assistantPanel()).getByLabelText('建议卡片')).getAllByText(/平湖秋月/).length,
    ).toBeGreaterThan(0)

    // 提交新指令 → 出现替换确认
    await generate(user, '去掉第 1 天的湖滨晴雨')
    expect(within(assistantPanel()).getByRole('region', { name: '替换待确认的提案' })).toBeInTheDocument()

    await user.click(within(assistantPanel()).getByRole('button', { name: '替换并生成' }))
    await waitFor(() =>
      expect(
        within(within(assistantPanel()).getByLabelText('建议卡片')).getAllByText(/湖滨晴雨/).length,
      ).toBeGreaterThan(0),
    )
    expect(
      within(within(assistantPanel()).getByLabelText('建议卡片')).queryByText(/平湖秋月/),
    ).toBeNull()
    // 行程与存储都没动
    expect(within(itinerary()).getByText('平湖秋月')).toBeInTheDocument()
    expect(within(itinerary()).getByText('湖滨晴雨')).toBeInTheDocument()
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
    expect(setItem).not.toHaveBeenCalled()
  })

  it('重排失败保旧：后端报错时行程与存储都不变', { timeout: 20_000 }, async () => {
    const fetchMock = stubFetch({
      replan: () => Promise.reject(new TypeError('后端不可用')),
    })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const section = screen.getByRole('region', { name: '行程安排' })
    const revisionBefore = Number(section.getAttribute('data-trip-revision'))

    await openAssistant(user)
    await generate(user, '第 1 天停留久一点')
    const card = within(assistantPanel()).getByLabelText('建议卡片')
    expect(within(card).getByText('时间偏好（交给单日重排）')).toBeInTheDocument()

    await user.click(within(card).getByRole('button', { name: '应用建议' }))
    await waitFor(() => expect(replanUrls(fetchMock)).toHaveLength(1))
    await waitFor(() => expect(within(assistantPanel()).getByRole('alert')).toBeInTheDocument())
    expect(within(assistantPanel()).getByRole('alert').textContent).toContain('当前行程保持不变')

    // 旧数据不变：行程内容、版本号与存储都没动
    expect(within(itinerary()).getByText('平湖秋月')).toBeInTheDocument()
    expect(Number(section.getAttribute('data-trip-revision'))).toBe(revisionBefore)
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('重排成功：走既有单日重排通道与既有应用流程', { timeout: 20_000 }, async () => {
    const fetchMock = stubFetch({
      replan: () =>
        jsonResponse({
          day: {
            day: 1,
            date: '2026-04-03',
            title: '重排后的第 1 天',
            summary: '候选摘要。',
            stops: [
              {
                id: 's1',
                name: '断桥残雪',
                time: '10:00',
                duration_minutes: 90,
                description: '多留一会儿。',
                address: '杭州市西湖区白堤东端',
                location: { lng: 120.1576, lat: 30.2726 },
              },
            ],
            legs: [],
          },
          warnings: [],
          map_status: 'ready',
          parent: { trip_id: MOCK_TRIP.id, revision: 1 },
          source: 'agent',
        }),
    })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await openAssistant(user)
    await generate(user, '第 1 天停留久一点')
    await user.click(within(assistantPanel()).getByRole('button', { name: '应用建议' }))
    await waitFor(() => expect(replanUrls(fetchMock)).toHaveLength(1))

    await user.click(await screen.findByRole('button', { name: '应用重排候选' }))
    // 既有单日重排应用流程的界面反馈：应用说明 + 行程里的候选内容
    await screen.findByTestId('apply-notice')
    expect(screen.getByTestId('apply-notice').textContent).toContain('不会自动保存')
  })

  it('关联工作区后重排类建议同样能走既有通道落地', { timeout: 20_000 }, async () => {
    const fetchMock = stubFetch({
      replan: () =>
        jsonResponse({
          day: {
            day: 1,
            date: '2026-04-03',
            title: '重排后的第 1 天',
            summary: '候选摘要。',
            stops: [
              {
                id: 's1',
                name: '断桥残雪',
                time: '10:00',
                duration_minutes: 90,
                description: '多留一会儿。',
                address: '杭州市西湖区白堤东端',
                location: { lng: 120.1576, lat: 30.2726 },
              },
            ],
            legs: [],
          },
          warnings: [],
          map_status: 'ready',
          parent: { trip_id: MOCK_TRIP.id, revision: 1 },
          source: 'agent',
        }),
    })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 关联工作区：重排请求会带上 F2 约束，落地也走工作区 transition
    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    await screen.findByText(/已关联《/)

    await openAssistant(user)
    await generate(user, '第 1 天停留久一点')
    await user.click(within(assistantPanel()).getByRole('button', { name: '应用建议' }))
    await waitFor(() => expect(replanUrls(fetchMock)).toHaveLength(1))

    await user.click(await screen.findByRole('button', { name: '应用重排候选' }))
    // 候选真的落到行程上了，不是被拒绝
    await screen.findByTestId('apply-notice')
    expect(screen.getByTestId('apply-notice').textContent).toContain('不会自动保存')
  })

  it('助手改动行程后：旧的「撤销应用」入口彻底失效，不会连带回退助手这次改动', { timeout: 20_000 }, async () => {
    stubFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 先用本地草稿改一趟行程：草稿栈留下一条「撤销应用」
    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    const editor = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getByRole('button', { name: '删除第 3 站「湖滨晴雨」（可撤销）' }))
    await user.click(within(editor).getByRole('button', { name: '应用草稿' }))
    await waitFor(() => expect(within(itinerary()).queryByText('湖滨晴雨')).toBeNull())
    // 草稿栈那条撤销入口确实在页面上
    expect(screen.getByRole('button', { name: '撤销应用' })).toBeInTheDocument()

    // 再开助手并应用一条建议：助手这一层自带独立撤销
    await openAssistant(user)
    await generate(user, '去掉第 1 天的平湖秋月')
    await user.click(within(assistantPanel()).getByRole('button', { name: '应用建议' }))
    await waitFor(() => expect(within(itinerary()).queryByText('平湖秋月')).toBeNull())

    // 旧的草稿栈入口彻底失效：它回退的是助手改动之前的行程，
    // 留着会被误点成把助手这次改动一起撤销。
    expect(screen.queryByRole('button', { name: '撤销应用' })).toBeNull()
    expect(screen.queryByTestId('apply-notice')).toBeNull()
    // 助手这次改动仍然生效，草稿那次改动也没有被回退
    expect(within(itinerary()).queryByText('平湖秋月')).toBeNull()
    expect(within(itinerary()).queryByText('湖滨晴雨')).toBeNull()
    // 助手自己的撤销入口不受影响：它只回退助手这一层
    expect(within(assistantPanel()).getByRole('button', { name: '撤销这条建议' })).toBeInTheDocument()
  })

  it('ABA：版本没变、只有内容变了 → 重排候选作废，按钮禁用且旧候选不会被套用', { timeout: 20_000 }, async () => {
    const fetchMock = stubFetch({
      replan: () =>
        jsonResponse({
          day: {
            day: 1,
            date: '2026-04-03',
            title: '重排后的第 1 天',
            summary: '候选摘要。',
            stops: [
              {
                id: 's1',
                name: '断桥残雪',
                time: '10:00',
                duration_minutes: 90,
                description: '多留一会儿。',
                address: '杭州市西湖区白堤东端',
                location: { lng: 120.1576, lat: 30.2726 },
              },
            ],
            legs: [],
          },
          warnings: [],
          map_status: 'ready',
          parent: { trip_id: MOCK_TRIP.id, revision: 1 },
          source: 'agent',
        }),
    })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 关联工作区：候选的基准 = 工作区版本 + 整条记录的内容指纹
    await user.click(screen.getByRole('button', { name: '用当前行程新建工作区' }))
    await screen.findByText(/已关联《/)
    // 先存到本地：存下来的这份就是「同版本」基准
    await user.click(screen.getByRole('button', { name: '保存工作区' }))
    await waitFor(() => expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).not.toBeNull())
    const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_STORAGE_KEY) as string) as {
      workspaceRevision: number
      trip: { title: string }
    }
    const statusBefore = screen.getByTestId('workspace-status').textContent
    const revisionBefore = /revision (\d+)/.exec(statusBefore ?? '')?.[1] ?? ''

    await openAssistant(user)
    await generate(user, '第 1 天停留久一点')
    await user.click(within(assistantPanel()).getByRole('button', { name: '应用建议' }))
    await waitFor(() => expect(replanUrls(fetchMock)).toHaveLength(1))
    expect(await screen.findByRole('button', { name: '应用重排候选' })).toBeEnabled()

    // 版本没变、只有内容变了：改掉本地存的工作区内容，版本号保持不动
    stored.trip.title = `${stored.trip.title}（别处改过）`
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(stored))
    await user.click(screen.getByRole('button', { name: '重新打开本地工作区' }))
    await screen.findByText('杭州三日漫步路书（别处改过）')
    // 确实只是内容变了：工作区版本没有推进
    expect(screen.getByTestId('workspace-status').textContent).toContain(
      `revision ${revisionBefore}`,
    )

    // 旧候选作废：按钮禁用
    const stale = within(assistantPanel()).getByRole('button', { name: '应用重排候选' })
    expect(stale).toBeDisabled()
    expect(within(assistantPanel()).getByText(/这条重排候选已经失效/)).toBeInTheDocument()

    // 点不动：处理器不会被调用，旧候选也没有套到行程上
    await user.click(stale)
    expect(screen.queryByTestId('apply-notice')).toBeNull()
    expect(within(itinerary()).getByText('断桥残雪')).toBeInTheDocument()
  })
})

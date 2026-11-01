/**
 * 本地保存 / 恢复的用户路径测试：真实 App + 真实 localStorage（jsdom），
 * 只替换 fetch。地图与日期切换仍走真实组件，验证恢复后不会残留选中站点。
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SAVED_TRIPS_STORAGE_KEY, SAVED_TRIPS_VERSION, saveTripToStorage } from '../lib/savedTrips'
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

function savedToolbar(): HTMLElement {
  return screen.getByRole('region', { name: '本地行程保存' })
}

function savedPanel(): HTMLElement {
  return screen.getByRole('region', { name: '已保存的行程列表' })
}

async function openSavedPanel(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(within(savedToolbar()).getByRole('button', { name: /已保存行程/ }))
  return await screen.findByRole('region', { name: '已保存的行程列表' })
}

function storedTrips(): unknown[] {
  const raw = localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
  if (!raw) return []
  return (JSON.parse(raw) as { trips: unknown[] }).trips
}

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('scrollTo', vi.fn())
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('本地保存行程', () => {
  it('后端不可用时仍可打开并恢复本地保存的行程', async () => {
    expect(saveTripToStorage(MOCK_TRIP).ok).toBe(true)
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText(/连不上后端服务/)
    const toolbar = await screen.findByRole('region', { name: '本地行程保存' })
    expect(within(toolbar).queryByRole('button', { name: '保存当前行程' })).toBeNull()
    expect(within(toolbar).getByText(/当前还没有打开行程/)).toBeInTheDocument()

    const panel = await openSavedPanel(user)
    await user.click(within(panel).getByRole('button', { name: /恢复保存的行程《杭州三日漫步路书》/ }))

    await waitFor(() => expect(screen.getByRole('heading', { name: '杭州三日漫步路书' })).toBeInTheDocument())
    expect(screen.queryByText(/连不上后端服务/)).toBeNull()
    expect(screen.getByText(/从本浏览器保存的副本恢复/)).toBeInTheDocument()
    expect(within(savedToolbar()).getByRole('button', { name: '保存当前行程' })).toBeInTheDocument()
  })

  it('示例请求还没返回时可以恢复本地副本，迟到的示例响应不会覆盖恢复结果', async () => {
    expect(saveTripToStorage(MOCK_TRIP).ok).toBe(true)
    let resolveExample!: (response: Response) => void
    const examplePending = new Promise<Response>((resolve) => {
      resolveExample = resolve
    })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') return examplePending
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    const user = userEvent.setup()
    render(<App />)

    // 初始示例还没返回：加载骨架和本地保存入口同时存在，不必等示例
    expect(screen.getByLabelText('正在加载示例行程')).toBeInTheDocument()
    await screen.findByRole('region', { name: '本地行程保存' })
    const panel = await openSavedPanel(user)
    await user.click(within(panel).getByRole('button', { name: /恢复保存的行程《杭州三日漫步路书》/ }))

    await waitFor(() => expect(screen.getByRole('heading', { name: '杭州三日漫步路书' })).toBeInTheDocument())
    expect(screen.queryByLabelText('正在加载示例行程')).toBeNull()

    // 模拟忽略 abort 的旧请求：示例响应迟到也不能覆盖已经恢复的副本
    await act(async () => {
      resolveExample(jsonResponse({ ...MOCK_TRIP, id: 'example-late', title: '迟到的示例行程' }))
      await Promise.resolve()
    })
    expect(screen.queryByText('迟到的示例行程')).toBeNull()
    expect(screen.getByRole('heading', { name: '杭州三日漫步路书' })).toBeInTheDocument()
    expect(screen.getByText(/从本浏览器保存的副本恢复/)).toBeInTheDocument()
  })

  it('恢复本地副本会忽略仍在路上的旧规划响应', async () => {
    let resolvePlan!: (response: Response) => void
    const planResponse = new Promise<Response>((resolve) => {
      resolvePlan = resolve
    })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/plan') return planResponse
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))

    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /正在规划/ })).toBeInTheDocument())

    // 规划请求还没返回时恢复本地副本；旧响应稍后到达也不能覆盖恢复结果
    const panel = await openSavedPanel(user)
    await user.click(within(panel).getByRole('button', { name: /恢复保存的行程《杭州三日漫步路书》/ }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '杭州三日漫步路书' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '生成行程' })).toBeInTheDocument()

    await act(async () => {
      resolvePlan(jsonResponse({
        ...MOCK_TRIP,
        id: 'trip-agent-1',
        source: 'agent',
        title: '西安两日速览',
      }))
      await Promise.resolve()
    })
    expect(screen.queryByText('西安两日速览')).toBeNull()
    expect(screen.getByRole('heading', { name: '杭州三日漫步路书' })).toBeInTheDocument()
  })

  it('不会自动保存；点击保存后才写入，并明确标注示例行程', async () => {
    const fetchMock = stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 仅加载示例，不写 localStorage
    expect(localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
    expect(within(savedToolbar()).getByText(/当前浏览器与当前网址/)).toBeInTheDocument()
    const fetchCallsBeforeSave = fetchMock.mock.calls.length

    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    await waitFor(() => {
      expect(within(savedToolbar()).getByText(/已保存《杭州三日漫步路书》/)).toBeInTheDocument()
    })
    // 保存只写当前浏览器，不额外请求后端
    expect(fetchMock.mock.calls.length).toBe(fetchCallsBeforeSave)
    expect(storedTrips()).toHaveLength(1)
    const record = storedTrips()[0] as { trip: { source: string; warnings: string[] } }
    expect(record.trip.source).toBe('example')
    expect(record.trip.warnings).toEqual(MOCK_TRIP.warnings)

    const panel = await openSavedPanel(user)
    const list = within(panel).getByRole('list', { name: '保存的行程' })
    expect(within(list).getByText('示例')).toBeInTheDocument()
    expect(within(list).getByText(/示例数据，仅用于演示/)).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: /恢复保存的行程《杭州三日漫步路书》/ })).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: /删除保存的行程《杭州三日漫步路书》/ })).toBeInTheDocument()
  })

  it('重复保存不会产生第二条记录，只更新时间', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    const save = within(savedToolbar()).getByRole('button', { name: '保存当前行程' })
    await user.click(save)
    await user.click(save)

    await waitFor(() => {
      expect(within(savedToolbar()).getByText(/已更新保存时间，没有产生重复记录/)).toBeInTheDocument()
    })
    expect(storedTrips()).toHaveLength(1)

    const panel = await openSavedPanel(user)
    expect(within(panel).getByRole('list', { name: '保存的行程' }).querySelectorAll('li')).toHaveLength(1)
    expect(within(savedToolbar()).getByText('已保存行程（1）')).toBeInTheDocument()
  })

  it('删除后可在页面内直接撤销，并把焦点留在列表或面板上', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    let panel = await openSavedPanel(user)

    await user.click(within(panel).getByRole('button', { name: /删除保存的行程《杭州三日漫步路书》/ }))
    await waitFor(() => expect(storedTrips()).toHaveLength(0))
    expect(
      within(savedToolbar()).getByText(/已删除《杭州三日漫步路书》/, { selector: '.saved-notice' }),
    ).toBeInTheDocument()
    expect(within(savedPanel()).getByRole('button', { name: '撤销删除' })).toBeInTheDocument()
    expect(within(savedPanel()).getByText(/还没有保存的行程/)).toBeInTheDocument()
    await waitFor(() => {
      expect(within(savedPanel()).getByRole('button', { name: '撤销删除' })).toHaveFocus()
    })

    await user.click(within(savedPanel()).getByRole('button', { name: '撤销删除' }))
    await waitFor(() => expect(storedTrips()).toHaveLength(1))
    panel = savedPanel()
    expect(within(panel).getByText('杭州三日漫步路书')).toBeInTheDocument()
    expect(within(savedToolbar()).getByText(/已撤销删除/)).toBeInTheDocument()
    await waitFor(() => {
      expect(within(savedPanel()).getByRole('button', { name: /恢复保存的行程《杭州三日漫步路书》/ })).toHaveFocus()
    })
  })

  it('恢复同一天的行程也会清空当前站点选中，不依赖日期变化', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')
    await waitFor(() => expect(container.querySelectorAll('.stop-dot-wrapper')).toHaveLength(2))

    // 停在第 1 天并选中站点；恢复后 activeDay 不变，只能靠恢复逻辑主动清空
    await user.click(screen.getByText('断桥残雪'))
    await waitFor(() => expect(container.querySelector('.stop-detail h4')?.textContent).toBe('断桥残雪'))

    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    const panel = await openSavedPanel(user)
    await user.click(within(panel).getByRole('button', { name: /恢复保存的行程《杭州三日漫步路书》/ }))

    await waitFor(() => {
      expect(container.querySelectorAll('.stop-detail')).toHaveLength(0)
      expect(container.querySelectorAll('.stop-dot[data-active="true"]')).toHaveLength(0)
    })
    expect(screen.getByRole('tab', { name: /西湖环湖/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('达到份数上限时明确提示并拒绝写入，已有记录一份都不淘汰', async () => {
    for (let index = 0; index < 20; index += 1) {
      const result = saveTripToStorage({
        ...MOCK_TRIP,
        id: `cap-${index}`,
        title: `容量测试行程 ${index}`,
      })
      expect(result.ok).toBe(true)
    }
    const before = localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    expect(before).toBeTruthy()
    expect(storedTrips()).toHaveLength(20)

    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    await waitFor(() => {
      expect(
        within(savedToolbar()).getByText(/最多保存 20 份/, { selector: '.saved-notice' }),
      ).toBeInTheDocument()
    })
    // fail-closed：超限时不删除旧记录，也不写入任何字节
    expect(localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(before)
    expect(storedTrips()).toHaveLength(20)
  })

  it('存在无法识别的记录时普通保存被拒绝且字节不变，二次确认后才能清空', async () => {
    const raw = JSON.stringify({
      version: SAVED_TRIPS_VERSION,
      trips: [
        { id: MOCK_TRIP.id, savedAt: Date.now(), trip: MOCK_TRIP },
        { id: 'broken-record', savedAt: Date.now(), trip: { ...MOCK_TRIP, days: [null] } },
      ],
    })
    localStorage.setItem(SAVED_TRIPS_STORAGE_KEY, raw)
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    const panel = await openSavedPanel(user)
    expect(within(panel).getByText(/1 条保存记录无法识别/)).toBeInTheDocument()
    const unreadable = within(panel).getAllByText(/无法识别、重复或超出上限/)
    expect(unreadable.length).toBeGreaterThan(0)

    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    await waitFor(() => {
      expect(
        within(savedToolbar()).getByText(/无法识别、重复或超出上限/, { selector: '.saved-notice' }),
      ).toBeInTheDocument()
    })
    expect(localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(raw)

    // 清除必须由用户点开再二次确认；确认前原始字节保持不变
    await user.click(within(panel).getByRole('button', { name: '清除全部本地数据' }))
    expect(localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(raw)
    const confirm = within(panel).getByRole('group', { name: '确认清除全部本地数据' })
    expect(within(confirm).getByText(/无法撤销/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: '确认清除' }))
    await waitFor(() => expect(localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull())
  })

  it('恢复保存的行程会切回第一天并清空站点选中与地图高亮', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')
    await waitFor(() => expect(container.querySelectorAll('.stop-dot-wrapper')).toHaveLength(2))

    // 切到第 3 天并选中一个站点，制造「非默认日期 + 有选中」的状态
    await user.click(screen.getByRole('tab', { name: /龙井问茶/ }))
    await user.click(screen.getByText('龙井村'))
    await waitFor(() => expect(container.querySelector('.stop-detail h4')?.textContent).toBe('龙井村'))

    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    const panel = await openSavedPanel(user)
    await user.click(within(panel).getByRole('button', { name: /恢复保存的行程《杭州三日漫步路书》/ }))

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /西湖环湖/ })).toHaveAttribute('aria-selected', 'true')
    })
    await waitFor(() => {
      expect(container.querySelectorAll('.stop-detail')).toHaveLength(0)
      expect(container.querySelectorAll('.stop-dot[data-active="true"]')).toHaveLength(0)
    })
    expect(screen.getByText(/从本浏览器保存的副本恢复/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '已保存的行程列表' })).toBeNull()
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '杭州三日漫步路书' })).toHaveFocus()
    })
  })
})

describe('本地存储失败状态', () => {
  it('损坏 JSON 时提示并暂停保存；页面内确认清除后可重新保存', async () => {
    const broken = '{"version":1,"trips":['
    localStorage.setItem(SAVED_TRIPS_STORAGE_KEY, broken)
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    const panel = await openSavedPanel(user)
    const alert = within(panel).getByRole('alert')
    expect(alert.textContent).toContain('不是合法 JSON')
    expect(alert.textContent).toContain('保存已暂停')

    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    await waitFor(() => {
      expect(within(savedToolbar()).getByText(/为避免覆盖旧数据/)).toBeInTheDocument()
    })
    expect(localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(broken)

    await user.click(within(panel).getByRole('button', { name: '清除损坏数据' }))
    const confirm = within(panel).getByRole('group', { name: '确认清除损坏数据' })
    expect(within(confirm).getByText(/无法撤销/)).toBeInTheDocument()
    await user.click(within(confirm).getByRole('button', { name: '确认清除' }))

    await waitFor(() => {
      expect(localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
    })
    expect(within(savedPanel()).getByText(/还没有保存的行程/)).toBeInTheDocument()

    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    await waitFor(() => expect(storedTrips()).toHaveLength(1))
  })

  it('存储配额满时给出真实失败提示，且不写入任何记录', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === SAVED_TRIPS_STORAGE_KEY) throw new DOMException('quota', 'QuotaExceededError')
      original.call(this, key, value)
    })

    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    await waitFor(() => {
      expect(within(savedToolbar()).getByText(/浏览器本地存储已满/)).toBeInTheDocument()
    })
    expect(localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('读取被浏览器拒绝时显示不可用，不假装列表为空', async () => {
    stubHappyFetch()
    const original = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === SAVED_TRIPS_STORAGE_KEY) throw new DOMException('denied', 'SecurityError')
      return original.call(this, key)
    })
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    const panel = await openSavedPanel(user)
    expect(within(panel).getByText(/浏览器拒绝读取本地存储/)).toBeInTheDocument()
    expect(within(panel).queryByText(/还没有保存的行程/)).toBeNull()

    await user.click(within(savedToolbar()).getByRole('button', { name: '保存当前行程' }))
    await waitFor(() => {
      expect(
        within(savedToolbar()).getByText(/浏览器拒绝读取本地存储/, { selector: '.saved-notice' }),
      ).toBeInTheDocument()
    })
  })
})

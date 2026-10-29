/**
 * App 集成测试：mock fetch，渲染真实 TripMap（真实 Leaflet + jsdom）。
 * 地图不做组件 mock——marker / popup 的选中联动必须走真实 Leaflet 事件才覆盖得到。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function textResponse(body: string, status = 200, contentType = 'text/plain') {
  return new Response(body, { status, headers: { 'Content-Type': contentType } })
}

function proxyErrorResponse() {
  return textResponse(
    'Error occurred while trying to proxy: 127.0.0.1:5173/api/trips/example',
    500,
  )
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

function markerByName(container: HTMLElement, name: string): Element {
  const marker = Array.from(container.querySelectorAll('.stop-dot-wrapper'))
    .find((node) => node.getAttribute('aria-label')?.includes(name))
  if (!marker) throw new Error(`找不到站点 marker：${name}`)
  return marker
}

function stopRow(container: HTMLElement, name: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('.stop-row'))
    .find((node) => node.textContent?.includes(name))
  if (!row) throw new Error(`找不到站点行：${name}`)
  return row
}

describe('App 集成', () => {
  beforeEach(() => {
    // jsdom 没实现滚动，规划成功后 App 会滚动到行程区
    vi.stubGlobal('scrollTo', vi.fn())
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })

  it('首次打开加载示例行程，探活走 /api/health 而非 /health', async () => {
    const fetchMock = stubHappyFetch()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    expect(screen.getByText('示例行程')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('后端服务正常')).toBeInTheDocument())

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls).toContain('/api/health')
    expect(urls).not.toContain('/health')
  })

  it('探活拿到 200 HTML（SPA fallback）时不判为后端在线', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(textResponse('<!doctype html><html></html>', 200, 'text/html'))
      if (url === '/api/trips/example') return Promise.resolve(textResponse('<!doctype html><html></html>', 200, 'text/html'))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    render(<App />)
    await waitFor(() => expect(screen.getByText(/连不上后端服务/)).toBeInTheDocument())
    expect(screen.queryByText('后端服务正常')).toBeNull()
    expect(screen.getByText(/后端未连接/)).toBeInTheDocument()
  })

  it('业务请求成功后会修正探活的误判（后端确实在线）', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(textResponse('<!doctype html>', 200, 'text/html'))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('后端服务正常')).toBeInTheDocument())
  })

  it('health 明确 planner_ready=false：提示后端在线但规划不可用，禁用提交且表单仍可编辑', async () => {
    const leakyHealth = {
      status: 'healthy',
      tools_count: 0,
      planner_ready: false,
      warnings: ['C:\\Users\\someone\\travel-assistant\\.env 里 DASHSCOPE_API_KEY 未设置（sk-live-should-not-render）'],
    }
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse(leakyHealth))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/plan') return Promise.resolve(jsonResponse(MOCK_TRIP))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('杭州三日漫步路书')
    expect(await screen.findByText('后端在线，规划暂不可用')).toBeInTheDocument()

    const submit = screen.getByRole('button', { name: '规划暂不可用' })
    expect(submit).toBeDisabled()

    // 表单本身不禁用，参数可以继续填
    const dest = screen.getByLabelText(/目的地/) as HTMLInputElement
    expect(dest).toBeEnabled()
    await user.type(dest, '西安')
    expect(dest.value).toBe('西安')

    // 点禁用按钮不会发出规划请求，也不白跑一趟后端
    await user.click(submit)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/trips/plan')).toHaveLength(0)

    // 不把后端 warnings 原文（绝对路径、疑似密钥）搬到页面上
    const pageText = document.body.textContent ?? ''
    expect(pageText).toContain('planner_ready=false')
    expect(pageText).not.toContain('C:\\Users')
    expect(pageText).not.toContain('sk-live-should-not-render')
  })

  it('health 缺 planner_ready：显示规划能力未知，仍允许提交', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy', tools_count: 2 }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/plan') return Promise.resolve(jsonResponse(MOCK_TRIP))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('杭州三日漫步路书')
    expect(await screen.findByText(/规划能力未知/)).toBeInTheDocument()
    expect(screen.queryByText('后端在线，规划暂不可用')).toBeNull()

    const submit = screen.getByRole('button', { name: '生成行程' })
    expect(submit).toBeEnabled()
    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(submit)
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/trips/plan')).toHaveLength(1))
  })

  it('点「重新检测」后规划状态更新，不需要刷新页面', async () => {
    let healthCalls = 0
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/health') {
        healthCalls += 1
        return Promise.resolve(jsonResponse(healthCalls === 1
          ? { status: 'healthy', planner_ready: false }
          : { status: 'healthy', planner_ready: true }))
      }
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('后端在线，规划暂不可用')
    expect(screen.getByRole('button', { name: '规划暂不可用' })).toBeDisabled()

    const reprobe = screen.getByRole('button', { name: '重新检测' })
    expect(reprobe).toBeEnabled()
    await user.click(reprobe)

    await waitFor(() => expect(screen.getByText('后端服务正常')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '生成行程' })).toBeEnabled()
    expect(screen.queryByText('后端在线，规划暂不可用')).toBeNull()
    expect(healthCalls).toBe(2)
  })

  it('规划成功后迟到的探活不能把状态翻回不可用', async () => {
    let resolveHealth!: (response: Response) => void
    const pendingHealth = new Promise<Response>((resolve) => {
      resolveHealth = resolve
    })
    const planned = { ...MOCK_TRIP, id: 'trip-agent-x', source: 'agent' as const, title: '西安速览' }
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return pendingHealth
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/plan') return Promise.resolve(jsonResponse(planned))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('杭州三日漫步路书')
    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await screen.findByText('西安速览')
    expect(screen.getByText('后端服务正常')).toBeInTheDocument()

    await act(async () => {
      resolveHealth(jsonResponse({ status: 'healthy', planner_ready: false }))
      await Promise.resolve()
    })

    // 真实规划已经证明能力可用，这场迟到的旧探活不能把提交重新锁上
    expect(screen.queryByText('后端在线，规划暂不可用')).toBeNull()
    expect(screen.getByRole('button', { name: '生成行程' })).toBeEnabled()
  })

  it('示例先成功、探活稍后失败：不把在线结论翻成断开', async () => {
    let resolveHealth!: (response: Response) => void
    const pendingHealth = new Promise<Response>((resolve) => {
      resolveHealth = resolve
    })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return pendingHealth
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    render(<App />)

    await screen.findByText('杭州三日漫步路书')
    expect(screen.getByText('后端服务正常')).toBeInTheDocument()

    await act(async () => {
      resolveHealth(textResponse('Error occurred while trying to proxy', 500))
      await Promise.resolve()
    })

    expect(screen.queryByText(/后端未连接/)).toBeNull()
    expect(screen.getByText('后端服务正常')).toBeInTheDocument()
  })

  it('健康检查先判 planner_ready=false，随后示例请求网络失败：能力不被翻成未知，提交保持禁用', async () => {
    let rejectExample!: (err: unknown) => void
    const examplePending = new Promise<Response>((_resolve, reject) => {
      rejectExample = reject
    })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy', planner_ready: false }))
      if (url === '/api/trips/example') return examplePending
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    render(<App />)

    // 探活先落地：后端在线，但规划明确不可用
    expect(await screen.findByText('后端在线，规划暂不可用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '规划暂不可用' })).toBeDisabled()

    // 示例请求迟到失败：只说明那一次调用没成，不能把 health 的能力判定抹成 unknown
    await act(async () => {
      rejectExample(new TypeError('fetch failed'))
      await Promise.resolve()
    })

    expect(screen.getByText('后端在线，规划暂不可用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '规划暂不可用' })).toBeDisabled()
    // 规划能力仍以 health 为准，不会退化成「未知」后重新放行提交
    expect(screen.queryByText(/规划能力未知/)).toBeNull()
    expect(screen.queryByRole('button', { name: '生成行程' })).toBeNull()
  })

  it('示例请求的旧失败迟到，不覆盖之后完成的健康检查结论', async () => {
    let rejectExample!: (err: unknown) => void
    const examplePending = new Promise<Response>((_resolve, reject) => {
      rejectExample = reject
    })
    let healthCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') {
        healthCalls += 1
        return Promise.resolve(jsonResponse(healthCalls === 1
          ? { status: 'healthy', planner_ready: false }
          : { status: 'healthy', planner_ready: true }))
      }
      if (url === '/api/trips/example') return examplePending
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    const user = userEvent.setup()
    render(<App />)

    await screen.findByText('后端在线，规划暂不可用')

    // 重测比示例请求新：后端这次说规划就绪
    await user.click(screen.getByRole('button', { name: '重新检测' }))
    await waitFor(() => expect(screen.getByText('后端服务正常')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '生成行程' })).toBeEnabled()

    // 最初那次示例请求现在才失败：它比新探活旧，不许把页面翻回「未连接」
    await act(async () => {
      rejectExample(new TypeError('fetch failed'))
      await Promise.resolve()
    })

    expect(screen.getByText('后端服务正常')).toBeInTheDocument()
    expect(screen.queryByText(/后端未连接/)).toBeNull()
    expect(screen.queryByText(/最近一次请求没成功/)).toBeNull()
    expect(screen.getByRole('button', { name: '生成行程' })).toBeEnabled()
  })

  it('规划请求传输失败算业务失败：说明来自业务请求，不借用健康检查的失败文案', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy', planner_ready: true }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/plan') return Promise.reject(new TypeError('fetch failed'))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('后端服务正常')).toBeInTheDocument())

    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('连不上后端服务'))

    // 头部把这次失败归到业务请求自身，而不是复述健康检查的口径
    expect(screen.getByText(/最近一次请求没成功/)).toBeInTheDocument()
    const pageText = document.body.textContent ?? ''
    expect(pageText).toContain('这次失败来自业务请求，不是健康检查')
    expect(pageText).not.toContain('健康检查请求没能送达后端')
  })

  it('重新检测期间给出可见与 aria 反馈，结束后恢复结论', async () => {
    let resolveHealth!: (response: Response) => void
    let healthCalls = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') {
        healthCalls += 1
        if (healthCalls === 1) return Promise.resolve(jsonResponse({ status: 'healthy', planner_ready: true }))
        return new Promise<Response>((resolve) => {
          resolveHealth = resolve
        })
      }
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('后端服务正常')).toBeInTheDocument())

    const reprobe = screen.getByRole('button', { name: '重新检测' })
    expect(reprobe).not.toHaveAttribute('aria-busy')

    await user.click(reprobe)

    // 可见：结论后面挂上进行中；aria：状态区会播报，按钮标记 busy
    expect(screen.getByText(/正在重新检测/)).toBeInTheDocument()
    expect(screen.getByRole('status').textContent).toContain('正在重新检测')
    expect(reprobe).toHaveAttribute('aria-busy', 'true')
    // 按钮不 disabled，焦点不会丢
    expect(reprobe).toBeEnabled()

    await act(async () => {
      resolveHealth(jsonResponse({ status: 'healthy', planner_ready: true }))
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByText(/正在重新检测/)).toBeNull())
    expect(reprobe).not.toHaveAttribute('aria-busy')
    expect(screen.getByText('后端服务正常')).toBeInTheDocument()
  })

  it('健康检查失败原因用可见的固定安全文案，不塞进 title 也不回显后端原文', async () => {
    const leaky = {
      status: 'unhealthy',
      warnings: ['C:\\Users\\someone\\travel-assistant\\.env 里 DASHSCOPE_API_KEY 未设置（sk-live-should-not-render）'],
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse(leaky, 503))
      if (url === '/api/trips/example') return Promise.resolve(proxyErrorResponse())
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    render(<App />)

    // 文案在正文里可见（getByText 只认文本内容，title 属性不算）
    const hint = await screen.findByText(/健康检查返回了错误状态码/)
    expect(hint).toBeVisible()
    expect(screen.getByRole('button', { name: '重新检测' })).toHaveAccessibleDescription(/健康检查返回了错误状态码/)

    const pageText = document.body.textContent ?? ''
    expect(pageText).not.toContain('C:\\Users')
    expect(pageText).not.toContain('sk-live-should-not-render')
  })

  it('后端断开时不声称还能浏览示例，并提供重试', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))
    render(<App />)
    await waitFor(() => expect(screen.getByText(/连不上后端服务/)).toBeInTheDocument())
    expect(screen.queryByText(/仍可查看示例/)).toBeNull()
    expect(screen.getByText(/后端未连接/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('Vite 代理断开（500 text/plain）时给出可操作提示，且不硬编码 API 地址', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(proxyErrorResponse())))
    render(<App />)
    const banner = await screen.findByRole('alert')
    expect(banner.textContent).toContain('连不上后端服务')
    expect(banner.textContent).toContain('VITE_API_BASE')
    expect(banner.textContent).toContain('/api')
    expect(banner.textContent).not.toMatch(/127\.0\.0\.1/)
  })

  it('表单校验：空目的地不提交', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: '生成行程' }))
    expect(await screen.findByText('请填写目的地')).toBeInTheDocument()
    // 未发出规划请求
    const calls = vi.mocked(fetch).mock.calls.filter(([u]) => u === '/api/trips/plan')
    expect(calls).toHaveLength(0)
  })

  it('填写表单后真实触发 POST /api/trips/plan 并渲染新行程', async () => {
    const plannedTrip = {
      ...MOCK_TRIP,
      id: 'trip-agent-1',
      source: 'agent' as const,
      title: '西安两日速览',
    }
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/plan') return Promise.resolve(jsonResponse(plannedTrip))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))

    await waitFor(() => expect(screen.getByText('西安两日速览')).toBeInTheDocument())
    expect(screen.getByText('AI 规划')).toBeInTheDocument()
    const planCall = fetchMock.mock.calls.find(([u]) => u === '/api/trips/plan')
    expect(planCall).toBeTruthy()
    const body = JSON.parse(String(planCall![1]?.body))
    expect(body).toMatchObject({ destination: '西安', days: 3, travelers: 2, travel_mode: 'walking', departure_date: null })
  })

  it('按日切换行程与地图；没有站点的空日不显示「站点均无坐标」', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.click(screen.getByRole('tab', { name: /运河与老巷/ }))
    expect(screen.getByText(/这一天暂无具体安排/)).toBeInTheDocument()
    expect(screen.queryByText(/站点均无坐标/)).toBeNull()
    expect(screen.queryByText(/站点缺少坐标/)).toBeNull()

    await user.click(screen.getByRole('tab', { name: /龙井问茶/ }))
    expect(screen.getByText('龙井村')).toBeInTheDocument()
  })

  it('有站点但都无坐标时才显示坐标提示', async () => {
    stubHappyFetch(MOCK_TRIP_NO_COORD)
    render(<App />)
    await waitFor(() => expect(screen.getByText('无坐标测试行程')).toBeInTheDocument())
    expect(screen.getByText('这一天的站点缺少坐标')).toBeInTheDocument()
    expect(screen.getAllByText('无坐标').length).toBeGreaterThan(0)
  })

  it('地图 marker、列表与弹窗的选中状态互相联动（真实 Leaflet）', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    await waitFor(() => expect(container.querySelectorAll('.stop-dot-wrapper')).toHaveLength(2))

    const detailName = () => container.querySelector('.stop-detail h4')?.textContent ?? null
    const activeDots = () => container.querySelectorAll('.stop-dot[data-active="true"]').length

    // 1) 点 marker 选中；旧实现里 popupopen 会再 toggle 一次，选中被立刻取消
    fireEvent.click(markerByName(container, '断桥残雪'))
    await waitFor(() => expect(detailName()).toBe('断桥残雪'))
    expect(activeDots()).toBe(1)
    expect(stopRow(container, '断桥残雪').getAttribute('aria-expanded')).toBe('true')

    // 2) 弹窗里的「查看逐点讲解」不会把选中取消
    await user.click(screen.getByRole('button', { name: '查看逐点讲解' }))
    expect(detailName()).toBe('断桥残雪')

    // 3) 换一个 marker：选中切换，高亮唯一
    fireEvent.click(markerByName(container, '平湖秋月'))
    await waitFor(() => expect(detailName()).toBe('平湖秋月'))
    expect(activeDots()).toBe(1)

    // 4) 列表点当前项 → 传空串收起
    await user.click(stopRow(container, '平湖秋月'))
    await waitFor(() => expect(detailName()).toBeNull())
    expect(activeDots()).toBe(0)

    // 5) 列表再点开，地图同步高亮并打开弹窗
    await user.click(stopRow(container, '断桥残雪'))
    await waitFor(() => expect(detailName()).toBe('断桥残雪'))
    expect(activeDots()).toBe(1)
    expect(screen.getByRole('button', { name: '查看逐点讲解' })).toBeInTheDocument()
  })

  it('返回 days:[null] 之类的坏数据时友好报错，不崩页面', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse({ ...MOCK_TRIP, days: [null] }))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    render(<App />)
    await waitFor(() => expect(screen.getByText(/数据格式不符合约定/)).toBeInTheDocument())
    expect(screen.getByText('路书')).toBeInTheDocument()
    expect(screen.queryByText('杭州三日漫步路书')).toBeNull()
  })

  it('停止等待会立刻恢复提交，旧请求忽略 abort 迟到也不能覆盖新结果', async () => {
    const planResolvers: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/plan') {
        return new Promise<Response>((resolve) => {
          planResolvers.push(resolve)
        })
      }
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /正在规划/ })).toBeInTheDocument())
    expect(screen.getByRole('note').textContent).toContain('不能保证服务端立刻停止处理与计费')

    await user.click(screen.getByRole('button', { name: '停止等待' }))
    // 立即恢复可提交，并明确说明只取消本页等待
    expect(screen.getByRole('button', { name: '生成行程' })).toBeEnabled()
    const cancelStatus = screen.getByText(/已停止等待这次规划/)
    expect(cancelStatus.textContent).toContain('不能保证后端或上游模型立即停止处理')

    // 立刻重试：第二次请求发出并进入等待
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /正在规划/ })).toBeInTheDocument())
    expect(planResolvers).toHaveLength(2)

    // 旧请求模拟忽略 abort 后迟到 resolve：不能覆盖页面，也不能结束新的等待
    await act(async () => {
      planResolvers[0](jsonResponse({ ...MOCK_TRIP, id: 'trip-old', source: 'agent', title: '旧响应' }))
      await Promise.resolve()
    })
    expect(screen.queryByText('旧响应')).toBeNull()
    expect(screen.getByRole('button', { name: /正在规划/ })).toBeInTheDocument()

    await act(async () => {
      planResolvers[1](jsonResponse({ ...MOCK_TRIP, id: 'trip-new', source: 'agent', title: '新响应' }))
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getByText('新响应')).toBeInTheDocument())
    expect(screen.queryByText('旧响应')).toBeNull()
  })

  it('规划成功后，仍在加载的示例响应迟到也不会覆盖新行程', async () => {
    let resolveExample!: (response: Response) => void
    const examplePending = new Promise<Response>((resolve) => {
      resolveExample = resolve
    })
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') return examplePending
      if (url === '/api/trips/plan') {
        return Promise.resolve(jsonResponse({ ...MOCK_TRIP, id: 'trip-planned', source: 'agent', title: '规划结果' }))
      }
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))
    const user = userEvent.setup()
    render(<App />)

    // 示例仍在路上时也能直接规划
    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await waitFor(() => expect(screen.getByText('规划结果')).toBeInTheDocument())

    await act(async () => {
      resolveExample(jsonResponse({ ...MOCK_TRIP, id: 'example-late', title: '迟到的示例' }))
      await Promise.resolve()
    })
    expect(screen.queryByText('迟到的示例')).toBeNull()
    expect(screen.getByText('规划结果')).toBeInTheDocument()
    expect(screen.getByText('AI 规划')).toBeInTheDocument()
  })

  it('清空天数输入不会写入 NaN 或触发 React NaN 警告，并给出本地校验', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    const daysInput = screen.getByLabelText('天数') as HTMLInputElement
    await user.clear(daysInput)
    expect(daysInput.value).toBe('')

    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))

    expect(await screen.findByText('天数需在 1 到 7 之间')).toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/trips/plan')).toHaveLength(0)
    const nanWarnings = errorSpy.mock.calls.filter((args) => String(args[0]).includes('NaN'))
    expect(nanWarnings).toHaveLength(0)
  })

  it('复制按钮真实写入剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    // user-event setup 会接管 navigator.clipboard，这里在其之后再覆盖为可观测的 spy
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    await user.click(screen.getByRole('button', { name: '复制本日行程' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toContain('断桥残雪')
    expect(await screen.findByText('已复制')).toBeInTheDocument()
  })
})

/**
 * WebSourcesPanel 用户路径测试：受控 React harness + 真实校验/展示逻辑。
 * 请求 adapter 全部 mock：不调真实 Tavily、不发网络、不写任何 Storage。
 *
 * 重点：
 * - 挂载/切天/选站/输入/属性变化零请求；显式点击恰好一次请求；
 * - 十种业务状态诚实区分（no_results ≠ no_usable_results ≠ no_key 等）；
 * - 不安全 payload 拒绝、纯文本渲染、安全链接属性、未知日期；
 * - 停止等待/关闭/卸载/输入变化的取消与迟到丢弃、忽略 abort 的 adapter、
 *   旧 finally 不结束新请求；
 * - 归属快照：同引用原地修改（含未选中日/站点名）、新引用同 id/revision、
 *   跨天、query 原文空白变化、ABA、序列化失败 fail closed；
 * - 固定安全文案不回显 reason/detail/异常；不写 Trip / localStorage。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { Trip, TripDay } from '../lib/api'
import { normalizeWebSearchQuery, type WebSearchReport, type WebSourceStatus } from '../lib/webSources'
import WebSourcesPanel from '../components/WebSourcesPanel'
import { MOCK_TRIP } from './fixtures/trip'
import { makeWebSearchReport } from './fixtures/webSources'

const RAW = '西湖 旅游'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type MockAdapter = Mock<
  (rawQuery: string, options?: { signal?: AbortSignal }) => Promise<WebSearchReport>
>

/** 与组件同口径：requested_query 必须等于本次 raw 的规范化结果，否则整包校验失败。 */
function reportFor(raw: string, overrides: Partial<WebSearchReport> = {}): WebSearchReport {
  return makeWebSearchReport({ requested_query: normalizeWebSearchQuery(raw), ...overrides })
}

function adapterMock(
  impl?: (raw: string, options?: { signal?: AbortSignal }) => Promise<WebSearchReport>,
): MockAdapter {
  return vi.fn(impl ?? ((raw: string) => Promise.resolve(reportFor(raw))))
}

/** 十种业务状态的合法信封变体（满足 validateWebSearchReport 的状态矩阵）。 */
function statusReport(raw: string, status: WebSourceStatus): WebSearchReport {
  const base = reportFor(raw)
  if (status === 'available') return base
  if (status === 'no_results') {
    // 成功状态：reason 必须为 null；no_results = 上游真空结果
    return {
      ...base,
      status,
      reason: null,
      provider_http_status: 200,
      results_seen: 0,
      results: [],
    }
  }
  if (status === 'no_usable_results') {
    // 成功状态：有上游条目但全部被安全检查过滤
    return {
      ...base,
      status,
      reason: null,
      provider_http_status: 200,
      results_seen: 2,
      results: [],
    }
  }
  if (status === 'invalid_request') {
    return {
      ...base,
      status,
      reason: '上游固定短句（不应回显）',
      provider_http_status: null,
      fetched_at: null,
      requested_query: null,
      results_seen: 0,
      results: [],
    }
  }
  // 业务失败态：必须有固定 reason、无 fetched_at、无结果
  const provider =
    status === 'rate_limited'
      ? 429
      : status === 'unauthorized'
        ? 401
        : status === 'failed'
          ? 400
          : null
  return {
    ...base,
    status,
    reason: '上游固定短句（不应回显）',
    provider_http_status: provider,
    fetched_at: null,
    results_seen: 0,
    results: [],
  }
}

interface RenderOptions {
  trip?: Trip
  day?: TripDay | null
  revision?: number
  openedFromFile?: boolean | null
  activeStopId?: string | null
  requestWebSources?: MockAdapter
  onClose?: () => void
}

function renderPanel(options: RenderOptions = {}) {
  const trip = options.trip ?? MOCK_TRIP
  const day = options.day !== undefined ? options.day : trip.days[0]
  const requestWebSources = (options.requestWebSources ?? adapterMock()) as MockAdapter
  const onClose = options.onClose ?? vi.fn()
  const view = render(
    <WebSourcesPanel
      trip={trip}
      day={day}
      revision={options.revision ?? 1}
      openedFromFile={options.openedFromFile}
      activeStopId={options.activeStopId}
      requestWebSources={requestWebSources}
      onClose={onClose}
    />,
  )
  return { ...view, trip, day, requestWebSources, onClose }
}

async function typeQuery(user: ReturnType<typeof userEvent.setup>, text: string = RAW) {
  await user.type(screen.getByLabelText('网页搜索内容'), text)
}

async function searchOnce(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '搜索网页资料' }))
}

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('初始状态与显式请求', () => {
  it('挂载零请求：无结果区、查询为空、按钮禁用、无存储写入', () => {
    const { requestWebSources } = renderPanel()
    expect(requestWebSources).not.toHaveBeenCalled()
    expect(screen.getByTestId('web-sources-panel')).toBeInTheDocument()
    expect(screen.getByTestId('web-sources-attribution')).toBeInTheDocument()
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(screen.getByLabelText('网页搜索内容')).toHaveValue('')
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('输入 query 零请求；按钮变为可用；站点上下文不自动拼接进输入框', async () => {
    const user = userEvent.setup()
    const { requestWebSources } = renderPanel({ activeStopId: 's2' })
    await typeQuery(user)
    expect(requestWebSources).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()

    await user.selectOptions(screen.getByLabelText('站点上下文（可选）'), 's3')
    expect(requestWebSources).not.toHaveBeenCalled()
    expect(screen.getByLabelText('网页搜索内容')).toHaveValue(RAW)
  })

  it('显式点击恰好一次请求：raw 原样传给 adapter、带 AbortSignal、结果落地', async () => {
    const user = userEvent.setup()
    const { requestWebSources } = renderPanel()
    await typeQuery(user, `  ${RAW}  `)
    await searchOnce(user)

    expect(requestWebSources).toHaveBeenCalledTimes(1)
    // 组件只透传用户输入原文；规范化是 adapter（searchWebSources）的职责
    expect(requestWebSources.mock.calls[0][0]).toBe(`  ${RAW}  `)
    expect(requestWebSources.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)

    const result = await screen.findByTestId('web-sources-result')
    expect(result).toBeInTheDocument()
    expect(screen.getByTestId('web-sources-status-tag')).toHaveTextContent('已返回')
  })

  it('pending 期间搜索按钮禁用：连点不产生第二次请求', async () => {
    const user = userEvent.setup()
    const d = deferred<WebSearchReport>()
    const { requestWebSources } = renderPanel({ requestWebSources: adapterMock(() => d.promise) })
    await typeQuery(user)
    await searchOnce(user)
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '搜索网页资料' }))
    expect(requestWebSources).toHaveBeenCalledTimes(1)
    await act(async () => {
      d.resolve(reportFor(RAW))
      await d.promise.catch(() => {})
    })
  })

  it('站点下拉：无坐标站点也在列（s3）、activeStopId 初始线索、未命中回落第一个', () => {
    const { unmount } = renderPanel({ activeStopId: 's2' })
    expect(screen.getByLabelText('站点上下文（可选）')).toHaveValue('s2')
    expect(screen.getByRole('option', { name: '湖滨晴雨' })).toBeInTheDocument()
    unmount()

    renderPanel({ activeStopId: 'no-such-stop' })
    expect(screen.getByLabelText('站点上下文（可选）')).toHaveValue('s1')
  })

  it('空/纯空白/超长/孤立代理输入：按钮禁用、本地提示、零请求', async () => {
    const user = userEvent.setup()
    const { requestWebSources } = renderPanel()

    // 空输入：按钮禁用 + 本地提示，点击无效果
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(screen.getByText(QUERY_EMPTY_HINT_TEXT)).toBeInTheDocument()
    await searchOnce(user)
    expect(requestWebSources).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('网页搜索内容'), '   ')
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    cleanup()

    renderPanel()
    fireEvent.change(screen.getByLabelText('网页搜索内容'), {
      target: { value: '🚀'.repeat(301) },
    })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(screen.getByText(QUERY_EMPTY_HINT_TEXT)).toBeInTheDocument()
    cleanup()

    renderPanel()
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: '\uD800' } })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(screen.getByText(QUERY_EMPTY_HINT_TEXT)).toBeInTheDocument()
    expect(requestWebSources).not.toHaveBeenCalled()
  })

  it('300 个 astral 码点合法可用（恰好上限不误拒）', () => {
    renderPanel()
    fireEvent.change(screen.getByLabelText('网页搜索内容'), {
      target: { value: '🚀'.repeat(300) },
    })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()
  })

  it('day 为 null：提示无法查询、无表单、收起仍可用', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <WebSourcesPanel
        trip={MOCK_TRIP}
        day={null}
        revision={1}
        requestWebSources={adapterMock()}
        onClose={onClose}
      />,
    )
    expect(screen.getByText(/没有可显示的这一天/)).toBeInTheDocument()
    expect(screen.queryByLabelText('网页搜索内容')).toBeNull()
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('本日没有站点：下拉整体隐藏，但输入 query 后仍可搜索', async () => {
    const user = userEvent.setup()
    const { requestWebSources } = renderPanel({ day: MOCK_TRIP.days[1] })
    expect(screen.queryByLabelText('站点上下文（可选）')).toBeNull()
    await typeQuery(user)
    await searchOnce(user)
    expect(requestWebSources).toHaveBeenCalledTimes(1)
    await screen.findByTestId('web-sources-result')
  })
})

/**
 * query 准入与二次校验口径：唯一判据是 lib/webSources.ts 的
 * normalizeWebSearchQuery（Python str.strip() 同口径：多 U+001C–1F/U+0085、
 * 少 U+FEFF）。组件不得自造 JS trim / Array.from 码点口径：
 * - U+FEFF 是合法正文（后端合同保留），JS trim 会误剥导致二次校验 bad_payload；
 * - 「空白 + 300 astral + 空白」规范化后合法，按码点先限 300 会误拒；
 * - U+001C–1F / U+0085 是 Python 空白、JS trim 不剥，纯这类输入必须零请求；
 * - FEFF-only 非空白，合法可查询。
 * 归属快照仍记录 raw 原文（空白 edit / ABA 合同不退化）。
 */
describe('query 准入口径与二次校验一致（Python strip 同口径）', () => {
  it('FEFF 填充 query：显式搜索成功，二次校验不误判 bad_payload', async () => {
    const user = userEvent.setup()
    const rawWithFeff = `\uFEFF${RAW}\uFEFF`
    const { requestWebSources } = renderPanel()
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: rawWithFeff } })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()

    await searchOnce(user)
    expect(requestWebSources).toHaveBeenCalledTimes(1)
    expect(requestedRaw(requestWebSources, 0)).toBe(rawWithFeff)
    await screen.findByTestId('web-sources-result')
    // 二次校验通过：requested_query 是 FEFF 剥离后的规范化结果
    expect(screen.getByText(RAW)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('FEFF-only 输入：按后端合同合法可查询，不按空白禁用', async () => {
    const user = userEvent.setup()
    const { requestWebSources } = renderPanel()
    fireEvent.change(screen.getByLabelText('网页搜索内容'), {
      target: { value: '\uFEFF\uFEFF' },
    })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()

    await searchOnce(user)
    expect(requestWebSources).toHaveBeenCalledTimes(1)
    await screen.findByTestId('web-sources-result')
  })

  it('纯 U+001C–1F / U+0085 输入：Python 空白、JS trim 不剥——按钮禁用、零请求', () => {
    const { requestWebSources } = renderPanel()
    fireEvent.change(screen.getByLabelText('网页搜索内容'), {
      target: { value: '\u001C\u001D\u0085' },
    })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(requestWebSources).not.toHaveBeenCalled()
  })

  it('空白 + 300 astral + 空白：规范化后合法可用（不被 raw 码点先限误拒）', async () => {
    const user = userEvent.setup()
    const { requestWebSources } = renderPanel()
    fireEvent.change(screen.getByLabelText('网页搜索内容'), {
      target: { value: ` \u2028 ${'🚀'.repeat(300)} \u00A0` },
    })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()

    await searchOnce(user)
    expect(requestWebSources).toHaveBeenCalledTimes(1)
    await screen.findByTestId('web-sources-result')
  })

  it('规范化后 301 码点：禁用、零请求（FEFF 不剥，计入上限）', () => {
    const { requestWebSources } = renderPanel()
    // 299 astral + 首尾 FEFF：Python strip 不剥 FEFF → 规范化后 301 码点 → 拒
    fireEvent.change(screen.getByLabelText('网页搜索内容'), {
      target: { value: `\uFEFF${'🚀'.repeat(299)}\uFEFF` },
    })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()

    cleanup()
    renderPanel()
    // 1 码点正文 + 300 astral：规范化后 301 → 拒
    fireEvent.change(screen.getByLabelText('网页搜索内容'), {
      target: { value: `x${'🚀'.repeat(300)}` },
    })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(requestWebSources).not.toHaveBeenCalled()
  })

  it('raw 含孤立代理：禁用、零请求（normalizeWebSearchQuery 拒绝）', () => {
    const { requestWebSources } = renderPanel()
    fireEvent.change(screen.getByLabelText('网页搜索内容'), {
      target: { value: `\uFEFF${RAW}\uD800` },
    })
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(requestWebSources).not.toHaveBeenCalled()
  })

  it('输入有值时本地准入提示不出现（只有不可用时才提示）', () => {
    renderPanel()
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: RAW } })
    expect(screen.queryByText(QUERY_EMPTY_HINT_TEXT)).toBeNull()
  })

  it('归属快照仍记录 raw 原文：空白 edit 仍失效（不因规范化退化）', async () => {
    const user = userEvent.setup()
    const trip = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    const props = { trip, day: trip.days[0], revision: 1, requestWebSources: adapterMock() }
    const view = render(<WebSourcesPanel {...props} />)
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: RAW } })
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')

    // 只加一个尾随空格：内容级快照（raw 原文）必须变化 → 旧结果失效
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: `${RAW} ` } })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    view.unmount()
  })
})

describe('归属变化后的迟到与旧状态（review Minor）', () => {
  it('归属变化后 deferred reject：不落新 owner、不显示错误', async () => {
    const user = userEvent.setup()
    let release!: (reason?: unknown) => void
    const gated = new Promise<WebSearchReport>((_, reject) => {
      release = reject
    })
    const trip = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    const props = { trip, day: trip.days[0], revision: 1, requestWebSources: adapterMock(() => gated) }
    const view = render(<WebSourcesPanel {...props} />)
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: RAW } })
    await searchOnce(user)

    // 归属变化（revision+1）：旧请求作废，其迟到 reject 不得落新 owner
    view.rerender(<WebSourcesPanel {...props} revision={2} />)
    await act(async () => {
      release(new Error('late boom'))
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    view.unmount()
  })

  it('归属变化清旧错误：旧错误文案不落新 owner', async () => {
    const user = userEvent.setup()
    const trip = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    const props = {
      trip,
      day: trip.days[0],
      revision: 1,
      requestWebSources: (() =>
        Promise.reject(new Error('network down'))) as unknown as MockAdapter,
    }
    const view = render(<WebSourcesPanel {...props} />)
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: RAW } })
    await searchOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    view.rerender(<WebSourcesPanel {...props} revision={2} />)
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
  })

  it('归属变化后忽略 AbortSignal 的 adapter 迟到 resolve 也不落地', async () => {
    const user = userEvent.setup()
    let release!: (value: WebSearchReport) => void
    const gated = new Promise<WebSearchReport>((resolve) => {
      release = resolve
    })
    const trip = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    const props = { trip, day: trip.days[0], revision: 1, requestWebSources: adapterMock(() => gated) }
    const view = render(<WebSourcesPanel {...props} />)
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: RAW } })
    await searchOnce(user)
    const signal = (props.requestWebSources as MockAdapter).mock.calls[0]?.[1]?.signal

    view.rerender(<WebSourcesPanel {...props} revision={2} />)
    expect(signal?.aborted).toBe(true)

    await act(async () => {
      release(reportFor(RAW))
    })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    view.unmount()
  })
})

describe('结果展示：来源、日期与未核实边界', () => {
  it('available：标题/摘录/安全链接/日期/双时间/notes 纯文本与未核实常显', async () => {
    const user = userEvent.setup()
    const report = reportFor(RAW, {
      results: [
        makeWebSearchResultSafe(),
        {
          title: null,
          url: 'https://www.example-travel.com/lingyin',
          snippet: null,
          snippet_truncated: false,
          publication_date: null,
        },
      ],
      results_seen: 3,
      notes: ['已丢弃 1 条不安全链接'],
    })
    renderPanel({ requestWebSources: adapterMock(() => Promise.resolve(report)) })

    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')

    // 标题/摘录缺失不杜撰
    expect(screen.getByText('杭州西湖旅游攻略')).toBeInTheDocument()
    expect(screen.getByText('（来源未提供标题）')).toBeInTheDocument()
    expect(screen.getByText('（来源未提供摘录）')).toBeInTheDocument()
    // 双日期：来源日期与未知分开
    expect(screen.getByText('网页发布日期：2025-06-01')).toBeInTheDocument()
    expect(screen.getByText('网页发布日期：未知（来源未提供）')).toBeInTheDocument()
    // 双时间分开：查询发起 vs 本次获取
    expect(screen.getByText('查询发起时间')).toBeInTheDocument()
    expect(screen.getByText('2026-11-03 08:00:00 UTC')).toBeInTheDocument()
    expect(screen.getByText('本次获取时间')).toBeInTheDocument()
    expect(screen.getByText('2026-11-03 08:00:01 UTC')).toBeInTheDocument()
    // 实发查询回显
    expect(screen.getByText('实发查询')).toBeInTheDocument()
    expect(screen.getByText(RAW)).toBeInTheDocument()
    // notes 纯文本
    expect(screen.getByTestId('web-sources-notes')).toHaveTextContent('已丢弃 1 条不安全链接')
    // 未核实：面板横幅 + 每项标签
    expect(screen.getByTestId('web-sources-unverified')).toHaveTextContent('未核实')
    expect(screen.getAllByText('未核实')).toHaveLength(2)
    // 不冒充官方/实时数据
    expect(screen.getByTestId('web-sources-unverified')).toHaveTextContent(/不代表官方信息/)
  })

  it('摘录截断时如实标注，不冒充完整原文', async () => {
    const user = userEvent.setup()
    const report = reportFor(RAW, {
      results: [
        {
          title: '长摘录条目',
          url: 'https://www.example-travel.com/long',
          snippet: 'x'.repeat(500),
          snippet_truncated: true,
          publication_date: null,
        },
      ],
    })
    renderPanel({ requestWebSources: adapterMock(() => Promise.resolve(report)) })
    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(screen.getByTestId('web-sources-result')).toHaveTextContent('（摘录超长，已截断显示）')
  })

  it('全部链接 https + target=_blank + rel=noopener noreferrer', async () => {
    const user = userEvent.setup()
    renderPanel()
    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThanOrEqual(2)
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      expect(link.getAttribute('href')).toMatch(/^https:/)
    }
  })

  it('十种业务状态各自诚实区分，不回显上游 reason 原文', async () => {
    const cases: Array<{ status: WebSourceStatus; marker: string | RegExp }> = [
      { status: 'available', marker: '已返回' },
      { status: 'no_results', marker: '没有搜索结果' },
      { status: 'no_usable_results', marker: '结果无法安全展示' },
      { status: 'invalid_request', marker: '查询参数未接受' },
      { status: 'no_key', marker: '未配置搜索 Key' },
      { status: 'timeout', marker: '查询超时' },
      { status: 'rate_limited', marker: '请求过于频繁' },
      { status: 'unauthorized', marker: '搜索授权未通过' },
      { status: 'unavailable', marker: '搜索服务不可用' },
      { status: 'failed', marker: '本次查询失败' },
    ]
    for (const { status, marker } of cases) {
      const user = userEvent.setup()
      const report = statusReport(RAW, status)
      const { unmount } = renderPanel({
        requestWebSources: adapterMock(() => Promise.resolve(report)),
      })
      await typeQuery(user)
      await searchOnce(user)
      await screen.findByTestId('web-sources-result')
      expect(screen.getByTestId('web-sources-status-tag')).toHaveTextContent(marker)
      // 任何状态都不回显上游 reason 原文
      expect(screen.queryByText('上游固定短句（不应回显）')).toBeNull()
      unmount()
      cleanup()
    }
  })

  it('no_results 与 no_usable_results 语义分开：后者说明取得条数与安全过滤', async () => {
    const user = userEvent.setup()
    const none = statusReport(RAW, 'no_results')
    const unusable = statusReport(RAW, 'no_usable_results')
    let call = 0
    renderPanel({
      requestWebSources: adapterMock(() =>
        Promise.resolve(call++ === 0 ? none : unusable),
      ),
    })

    await typeQuery(user)
    await searchOnce(user)
    expect(await screen.findByTestId('web-sources-empty')).toHaveTextContent(/不代表该地点不存在/)
    expect(screen.getByTestId('web-sources-empty')).toHaveTextContent('没有拿到搜索结果')

    await searchOnce(user)
    await waitFor(() => expect(screen.getByTestId('web-sources-empty')).toHaveTextContent(/2 条/))
    expect(screen.getByTestId('web-sources-empty')).toHaveTextContent('未通过安全链接检查')
  })

  it('失败状态：fetched_at 显示未知，checked_at 仍标明为查询发起时间', async () => {
    const user = userEvent.setup()
    renderPanel({
      requestWebSources: adapterMock(() => Promise.resolve(statusReport(RAW, 'no_key'))),
    })
    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(screen.getByText('未知（未成功获取）')).toBeInTheDocument()
    expect(screen.getByText('2026-11-03 08:00:00 UTC')).toBeInTheDocument()
    expect(screen.queryByText('2026-11-03 08:00:01 UTC')).toBeNull()
  })
})

describe('不安全 payload 与注入防御', () => {
  it('信封缺字段：整包拒绝，固定文案，无结果', async () => {
    const user = userEvent.setup()
    const bad = { ...reportFor(RAW) } as Record<string, unknown>
    delete bad.notes
    renderPanel({
      requestWebSources: adapterMock(() => Promise.resolve(bad as unknown as WebSearchReport)),
    })
    await typeQuery(user)
    await searchOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('完整性检查'))
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('requested_query 与本次实发不一致：拒绝落地（防注入 adapter 绕过归属）', async () => {
    const user = userEvent.setup()
    const mismatched = reportFor('别的查询')
    renderPanel({ requestWebSources: adapterMock(() => Promise.resolve(mismatched)) })
    await typeQuery(user)
    await searchOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('完整性检查'))
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('结果里混入非 https 链接：整包拒绝，不部分展示', async () => {
    const user = userEvent.setup()
    const unsafe = reportFor(RAW, {
      results: [
        {
          title: 'HTTP 条目',
          url: 'http://www.example-travel.com/insecure',
          snippet: '明文链接',
          snippet_truncated: false,
          publication_date: null,
        },
      ],
    })
    renderPanel({ requestWebSources: adapterMock(() => Promise.resolve(unsafe)) })
    await typeQuery(user)
    await searchOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('完整性检查'))
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('标题/摘录按纯文本渲染：标签与事件不执行', async () => {
    const user = userEvent.setup()
    const hostile = reportFor(RAW, {
      results: [
        {
          title: '<img src=x onerror="window.__wspInjected=true">',
          url: 'https://www.example-travel.com/xss',
          snippet: '<script>window.__wspSnippet=1</script>',
          snippet_truncated: false,
          publication_date: null,
        },
      ],
    })
    renderPanel({ requestWebSources: adapterMock(() => Promise.resolve(hostile)) })
    await typeQuery(user)
    await searchOnce(user)
    const result = await screen.findByTestId('web-sources-result')
    expect(result).toHaveTextContent('<img src=x onerror="window.__wspInjected=true">')
    expect(result).toHaveTextContent('<script>window.__wspSnippet=1</script>')
    expect(result.querySelector('img')).toBeNull()
    expect(result.querySelector('script')).toBeNull()
    expect((window as { __wspInjected?: boolean }).__wspInjected).toBeUndefined()
    expect((window as { __wspSnippet?: number }).__wspSnippet).toBeUndefined()
  })
})

describe('传输错误分类与安全文案', () => {
  it('timeout/network/server/bad_payload 显示固定文案，不回显底层异常', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <WebSourcesPanel
        trip={MOCK_TRIP}
        day={MOCK_TRIP.days[0]}
        revision={1}
        requestWebSources={(() =>
          Promise.reject(new Error('<html>proxy boom</html>'))) as unknown as MockAdapter}
      />,
    )
    await typeQuery(user)
    await searchOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('连不上后端服务'))
    expect(screen.queryByText(/proxy boom/)).toBeNull()

    rerender(
      <WebSourcesPanel
        trip={MOCK_TRIP}
        day={MOCK_TRIP.days[0]}
        revision={2}
        requestWebSources={(() =>
          Promise.reject(
            Object.assign(new Error('x'), { kind: 'timeout', name: 'ApiError' }),
          )) as unknown as MockAdapter}
      />,
    )
    await typeQuery(user)
    await searchOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('超时'))

    rerender(
      <WebSourcesPanel
        trip={MOCK_TRIP}
        day={MOCK_TRIP.days[0]}
        revision={3}
        requestWebSources={(() =>
          Promise.reject(
            Object.assign(new Error('Key=sk-secret'), {
              kind: 'server',
              name: 'ApiError',
              status: 422,
              detail: 'Key=sk-secret',
            }),
          )) as unknown as MockAdapter}
      />,
    )
    await typeQuery(user)
    await searchOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('请求失败'))
    expect(screen.queryByText(/sk-secret/)).toBeNull()
  })
})

describe('取消与竞态', () => {
  it('停止等待：signal 中止、固定文案、迟到成功不落地、可再次查询', async () => {
    const user = userEvent.setup()
    const d = deferred<WebSearchReport>()
    const adapter = adapterMock(() => d.promise)
    renderPanel({ requestWebSources: adapter })

    await typeQuery(user)
    await searchOnce(user)
    expect(screen.getByRole('button', { name: '停止等待' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '停止等待' }))
    expect(adapter.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(screen.getByRole('alert')).toHaveTextContent('已停止等待')
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()

    await act(async () => {
      d.resolve(reportFor(RAW))
      await d.promise.catch(() => {})
    })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    // 停止等待后仍可再次显式查询（不残留 pending）
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled()
  })

  it('查询中收起：onClose 触发、迟到响应不落地', async () => {
    const user = userEvent.setup()
    const d = deferred<WebSearchReport>()
    const onClose = vi.fn()
    renderPanel({ requestWebSources: adapterMock(() => d.promise), onClose })

    await typeQuery(user)
    await searchOnce(user)
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    await act(async () => {
      d.resolve(reportFor(RAW))
      await d.promise.catch(() => {})
    })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('卸载取消在途请求：adapter 收到的 signal 被中止', async () => {
    const user = userEvent.setup()
    const d = deferred<WebSearchReport>()
    const adapter = adapterMock(() => d.promise)
    const { unmount } = renderPanel({ requestWebSources: adapter })

    await typeQuery(user)
    await searchOnce(user)
    const signal = adapter.mock.calls[0][1]?.signal
    unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      d.resolve(reportFor(RAW))
      await d.promise.catch(() => {})
    })
  })

  it('adapter 忽略 abort 也不能落地（序号/信号独立检查）', async () => {
    const user = userEvent.setup()
    const d = deferred<WebSearchReport>()
    renderPanel({ requestWebSources: adapterMock(() => d.promise) })

    await typeQuery(user)
    await searchOnce(user)
    await user.click(screen.getByRole('button', { name: '停止等待' }))
    await act(async () => {
      d.resolve(reportFor(RAW))
      await d.promise.catch(() => {})
    })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('已停止等待')
  })

  it('等待中修改输入：在途请求被作废，迟到响应不落地，可重新查询', async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gated = new Promise<WebSearchReport>((resolve) => {
      release = () => resolve(reportFor(RAW))
    })
    let call = 0
    const adapter = adapterMock(() => {
      call += 1
      return call === 1 ? gated : Promise.resolve(reportFor(`${RAW} 补充`))
    })
    renderPanel({ requestWebSources: adapter })

    await typeQuery(user)
    await searchOnce(user)
    await user.type(screen.getByLabelText('网页搜索内容'), ' 补充')
    expect(adapter.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)

    // 迟到成功不落地，也不留错误
    await act(async () => {
      release()
    })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    await searchOnce(user)
    expect(adapter).toHaveBeenCalledTimes(2)
    expect(requestedRaw(adapter, 1)).toBe(`${RAW} 补充`)
    await screen.findByTestId('web-sources-result')
  })

  it('旧 finally 不结束新请求：A 迟到收尾不影响 B 的等待与结果', async () => {
    const user = userEvent.setup()
    const dA = deferred<WebSearchReport>()
    const dB = deferred<WebSearchReport>()
    let call = 0
    const adapter = adapterMock(() => {
      call += 1
      return call === 1 ? dA.promise : dB.promise
    })
    renderPanel({ requestWebSources: adapter })

    await typeQuery(user)
    await searchOnce(user)
    await user.type(screen.getByLabelText('网页搜索内容'), 'x')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled(),
    )
    await searchOnce(user)
    expect(screen.getByRole('button', { name: '停止等待' })).toBeInTheDocument()

    // A 的迟到收尾：不得清掉 B 的等待状态，也不得改写错误/结果
    await act(async () => {
      dA.resolve(reportFor(RAW))
      await dA.promise.catch(() => {})
    })
    expect(screen.getByRole('button', { name: '停止等待' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => {
      dB.resolve(reportFor(`${RAW}x`))
      await dB.promise.catch(() => {})
    })
    await screen.findByTestId('web-sources-result')
    expect(screen.queryByRole('button', { name: '停止等待' })).toBeNull()
  })
})

describe('归属快照与失效', () => {
  function renderRerenderable(adapter: MockAdapter) {
    const trip = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    const props = {
      trip,
      day: trip.days[0],
      revision: 1,
      requestWebSources: adapter,
    }
    const view = render(<WebSourcesPanel {...props} />)
    const rerenderWith = (next: Partial<typeof props> = {}) =>
      view.rerender(<WebSourcesPanel {...{ ...props, ...next }} />)
    return { trip, rerenderWith }
  }

  async function searchAndLand(user: ReturnType<typeof userEvent.setup>) {
    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
  }

  it('同引用原地修改 trip 字段：旧结果渲染期立即隐藏，迟到响应不落地', async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gated = new Promise<WebSearchReport>((resolve) => {
      release = () => resolve(reportFor(RAW))
    })
    const { trip, rerenderWith } = renderRerenderable(adapterMock(() => gated))
    await typeQuery(user)
    await searchOnce(user)
    // 先放行第一次查询拿到结果，再原地修改
    await act(async () => {
      release()
    })
    await screen.findByTestId('web-sources-result')

    act(() => {
      trip.summary = '原地改写的概要'
    })
    rerenderWith()
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('同引用原地修改未选中日：同样失效', async () => {
    const user = userEvent.setup()
    const { trip, rerenderWith } = renderRerenderable(adapterMock())
    await searchAndLand(user)

    act(() => {
      trip.days[1].title = '被改的另一天'
    })
    rerenderWith()
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('同引用原地修改选中站点名称：失效', async () => {
    const user = userEvent.setup()
    const { trip, rerenderWith } = renderRerenderable(adapterMock())
    await searchAndLand(user)

    act(() => {
      trip.days[0].stops[0].name = '断桥（改名）'
    })
    rerenderWith()
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('新引用同 id/revision 同内容：仍视为新归属，旧结果失效', async () => {
    const user = userEvent.setup()
    const { trip, rerenderWith } = renderRerenderable(adapterMock())
    await searchAndLand(user)

    const clone = JSON.parse(JSON.stringify(trip)) as Trip
    rerenderWith({ trip: clone, day: clone.days[0] })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('切天：旧结果失效，面板随新天重建（无站点天下拉隐藏且仍可查询）', async () => {
    const user = userEvent.setup()
    const { trip, rerenderWith } = renderRerenderable(adapterMock())
    await searchAndLand(user)

    rerenderWith({ day: trip.days[1] })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(screen.queryByLabelText('站点上下文（可选）')).toBeNull()

    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
  })

  it('下拉换站：旧结果立即隐藏', async () => {
    const user = userEvent.setup()
    const { rerenderWith } = renderRerenderable(adapterMock())
    await searchAndLand(user)
    rerenderWith() // 稳定基线
    await user.selectOptions(screen.getByLabelText('站点上下文（可选）'), 's2')
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('query 原文空白变化（trim 等价也算变化）：旧结果立即隐藏', async () => {
    const user = userEvent.setup()
    const { rerenderWith } = renderRerenderable(adapterMock())
    await searchAndLand(user)
    rerenderWith()

    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: `${RAW} ` } })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('ABA：A→B→A 旧结果不复活，epoch 单调推进后仍可重新查询', async () => {
    const user = userEvent.setup()
    const tripA = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    const tripB = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    tripB.id = 'trip-b'
    tripB.title = '另一份行程'
    const props = { trip: tripA, day: tripA.days[0], revision: 1, requestWebSources: adapterMock() }
    const view = render(<WebSourcesPanel {...props} />)
    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')

    view.rerender(<WebSourcesPanel {...props} trip={tripB} day={tripB.days[0]} />)
    expect(screen.queryByTestId('web-sources-result')).toBeNull()

    view.rerender(<WebSourcesPanel {...props} trip={tripA} day={tripA.days[0]} />)
    expect(screen.queryByTestId('web-sources-result')).toBeNull()

    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
  })

  it('revision 变化：旧结果失效', async () => {
    const user = userEvent.setup()
    const { rerenderWith } = renderRerenderable(adapterMock())
    await searchAndLand(user)
    rerenderWith({ revision: 2 })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })

  it('来源三态变化（openedFromFile）：旧结果失效', async () => {
    const user = userEvent.setup()
    const trip = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    const props = {
      trip,
      day: trip.days[0],
      revision: 1,
      openedFromFile: null as boolean | null,
      requestWebSources: adapterMock(),
    }
    const view = render(<WebSourcesPanel {...props} />)
    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    expect(screen.getByText(/没有来源标记/)).toBeInTheDocument()

    view.rerender(<WebSourcesPanel {...props} openedFromFile={true} />)
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(screen.getByText(/来自导入文件/)).toBeInTheDocument()
  })

  it('activeStopId 变化：作废旧结果，但不拉动面板已选站点', async () => {
    const user = userEvent.setup()
    const trip = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    const props = {
      trip,
      day: trip.days[0],
      revision: 1,
      activeStopId: 's2' as string | null,
      requestWebSources: adapterMock(),
    }
    const view = render(<WebSourcesPanel {...props} />)
    expect(screen.getByLabelText('站点上下文（可选）')).toHaveValue('s2')
    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')

    view.rerender(<WebSourcesPanel {...props} activeStopId="s3" />)
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(screen.getByLabelText('站点上下文（可选）')).toHaveValue('s2')
  })

  it('序列化失败（循环引用）：fail closed——禁查询、隐藏旧结果、取消在途', async () => {
    const user = userEvent.setup()
    const d = deferred<WebSearchReport>()
    const trip = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    const props = { trip, day: trip.days[0], revision: 1, requestWebSources: adapterMock(() => d.promise) }
    const view = render(<WebSourcesPanel {...props} />)
    await typeQuery(user)
    await searchOnce(user)
    const signal = (props.requestWebSources as MockAdapter).mock.calls[0][1]?.signal

    act(() => {
      ;(trip as { loop?: unknown }).loop = trip
    })
    view.rerender(<WebSourcesPanel {...props} />)
    expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeDisabled()
    expect(screen.getByText(/无法安全序列化/)).toBeInTheDocument()
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
    expect(signal?.aborted).toBe(true)

    await act(async () => {
      d.resolve(reportFor(RAW))
      await d.promise.catch(() => {})
    })
    expect(screen.queryByTestId('web-sources-result')).toBeNull()

    // 恢复可序列化后可再次查询，但旧结果不复活
    act(() => {
      delete (trip as { loop?: unknown }).loop
    })
    view.rerender(<WebSourcesPanel {...props} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '搜索网页资料' })).toBeEnabled(),
    )
    expect(screen.queryByTestId('web-sources-result')).toBeNull()
  })
})

describe('副作用边界', () => {
  it('成功与失败后：Trip 内容不变，无任何 Storage 写入', async () => {
    const user = userEvent.setup()
    const trip = JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
    let call = 0
    const snapshot = JSON.stringify(trip)
    renderPanel({
      trip,
      requestWebSources: adapterMock(() => {
        call += 1
        return call === 1
          ? Promise.resolve(reportFor(RAW))
          : Promise.reject(new Error('network down'))
      }),
    })

    await typeQuery(user)
    await searchOnce(user)
    await screen.findByTestId('web-sources-result')
    await searchOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    expect(JSON.stringify(trip)).toBe(snapshot)
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })
})

function makeWebSearchResultSafe() {
  return {
    title: '杭州西湖旅游攻略',
    url: 'https://www.example-travel.com/xihu-guide',
    snippet: '西湖位于杭州市西湖区。',
    snippet_truncated: false,
    publication_date: '2025-06-01' as string | null,
  }
}

function requestedRaw(adapter: MockAdapter, index: number): string {
  return adapter.mock.calls[index]?.[0] ?? ''
}

/** 与组件不可用提示对齐的完整句（避免 import 组件内部常量；默认精确匹配）。 */
const QUERY_EMPTY_HINT_TEXT =
  '当前输入不能作为查询：需要 1–300 个字符（按服务端同一规范化口径计算），且不能含有无法使用的字符。请修改后再搜索。'

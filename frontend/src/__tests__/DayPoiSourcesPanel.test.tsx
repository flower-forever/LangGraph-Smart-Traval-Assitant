/**
 * DayPoiSourcesPanel 用户路径测试：受控 React harness + 真实校验/展示逻辑。
 * 请求 adapter 全部 mock，不调用真实服务、不写 Storage。
 * 重点：显式一次请求、取消/迟到丢弃、same-query 失败旧数据标注、
 * 空结果清理、切天/revision/站点/坐标变化隔离、身份未确认与标签原文边界。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { Trip } from '../lib/api'
import type { PoiSourceQuery, PoiSourceReport } from '../lib/poiSources'
import DayPoiSourcesPanel from '../components/DayPoiSourcesPanel'
import type { PoiSourcesAdapter } from '../lib/poiSourcesApi'
import {
  makePoiCandidate,
  makePoiSourceReport,
  makePoiTrip,
  tagUnknown,
  tripDay,
} from './fixtures/poiSources'

const QUERY: PoiSourceQuery = { lat: 31.2304, lon: 121.4737 }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type MockPoiAdapter = Mock<PoiSourcesAdapter>

function adapterMock(
  impl?: (query: PoiSourceQuery, options?: { signal?: AbortSignal }) => Promise<PoiSourceReport>,
): MockPoiAdapter {
  return vi.fn<PoiSourcesAdapter>(impl ?? ((query) => Promise.resolve(makePoiSourceReport(query))))
}

interface RenderOptions {
  trip?: Trip
  dayNumber?: number
  revision?: number
  openedFromFile?: boolean
  activeStopId?: string | null
  requestPoiSources?: PoiSourcesAdapter
  onClose?: () => void
}

function renderPanel(options: RenderOptions = {}) {
  const trip = options.trip ?? makePoiTrip()
  const day = tripDay(trip, options.dayNumber ?? 1)
  const requestPoiSources = (options.requestPoiSources ?? adapterMock()) as MockPoiAdapter
  const onClose = options.onClose ?? vi.fn()
  const view = render(
    <DayPoiSourcesPanel
      trip={trip}
      day={day}
      revision={options.revision ?? 1}
      openedFromFile={options.openedFromFile}
      activeStopId={options.activeStopId}
      requestPoiSources={requestPoiSources}
      onClose={onClose}
    />,
  )
  return { ...view, trip, requestPoiSources, onClose }
}

async function queryOnce(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '查询附近资料' }))
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('初始状态与显式请求', () => {
  it('挂载不发请求；署名与身份未确认提示可见；结果区不出现', () => {
    const { requestPoiSources } = renderPanel()
    expect(requestPoiSources).not.toHaveBeenCalled()
    expect(screen.getByTestId('poi-sources-attribution')).toBeInTheDocument()
    expect(screen.getByText(/身份未确认/)).toBeInTheDocument()
    expect(screen.queryByTestId('poi-sources-result')).toBeNull()
    expect(screen.getByLabelText('按哪条记录坐标查询')).toHaveValue('p1')
    expect(window.localStorage.length).toBe(0)
  })

  it('activeStopId 作为初始站点线索；没有该站时回落第一个', () => {
    const { unmount } = renderPanel({ activeStopId: 'p2' })
    expect(screen.getByLabelText('按哪条记录坐标查询')).toHaveValue('p2')
    unmount()

    renderPanel({ activeStopId: 'no-such-stop' })
    expect(screen.getByLabelText('按哪条记录坐标查询')).toHaveValue('p1')
  })

  it('显式查询一次：请求坐标取自所选站点记录，0/负坐标原样透传', async () => {
    const user = userEvent.setup()
    const { requestPoiSources } = renderPanel()
    await user.selectOptions(screen.getByLabelText('按哪条记录坐标查询'), 'p2')

    await queryOnce(user)
    expect(requestPoiSources).toHaveBeenCalledTimes(1)
    expect(requestPoiSources.mock.calls[0][0]).toEqual({ lat: 51.5072, lon: -0.1276 })
  })

  it('本日没有坐标站点时禁用查询并说明，不发请求', () => {
    const { requestPoiSources } = renderPanel({ dayNumber: 2 })
    expect(screen.getByText(/本日没有带 WGS84 坐标的站点记录/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查询附近资料' })).toBeDisabled()
    expect(requestPoiSources).not.toHaveBeenCalled()
  })

  it('day 为 null 时提示无法查询并保留收起按钮', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <DayPoiSourcesPanel
        trip={makePoiTrip()}
        day={null}
        revision={1}
        requestPoiSources={adapterMock()}
        onClose={onClose}
      />,
    )
    expect(screen.getByText(/没有可显示的这一天/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('结果展示边界', () => {
  it('available：候选名称/距离/OSM 链接/标签原文/双时间/未确认全部可见', async () => {
    const user = userEvent.setup()
    const report = makePoiSourceReport(QUERY, {
      candidates: [
        makePoiCandidate(),
        makePoiCandidate({
          elementType: 'way',
          elementId: 987654321,
          name: null,
          distance_m: 26.5,
          source_updated_at: null,
          opening_hours: tagUnknown(),
          fee: { state: 'source_only', value: 'yes' },
        }),
      ],
    })
    renderPanel({ requestPoiSources: adapterMock(() => Promise.resolve(report)) })

    await queryOnce(user)
    const result = await screen.findByTestId('poi-sources-result')
    expect(result).toBeInTheDocument()
    expect(screen.getByText('示例便利店（虚构）')).toBeInTheDocument()
    expect(screen.getByText('（来源未提供名称）')).toBeInTheDocument()
    expect(screen.getByText('距离约 26.5 m')).toBeInTheDocument()
    expect(screen.getByText('Mo-Su 07:00-22:00')).toBeInTheDocument()

    const links = screen.getAllByRole('link', { name: /OSM 对象/ })
    expect(links[0]).toHaveAttribute('href', 'https://www.openstreetmap.org/node/1234567890')
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer')
    expect(links[1]).toHaveAttribute('href', 'https://www.openstreetmap.org/way/987654321')

    // 双时间分开：获取时间与对象编辑时间各自可达；缺失显示未知
    // （两个候选各自的 retrieved_at + 信封级 fetched_at，同一真实时间出现多次）
    expect(screen.getAllByText('2026-10-30 04:05:02 UTC').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('未知（来源未提供）')).toBeInTheDocument()
    // fee=yes 是原文，不是「已证实免费」
    expect(screen.getByText('yes')).toBeInTheDocument()
    expect(screen.queryByText(/已证实免费/)).toBeNull()
    // 身份未确认标签
    expect(screen.getAllByText('身份未确认').length).toBe(2)
    // 获取时间（信封级）与查询发起时间分开
    expect(screen.getByText('查询发起时间')).toBeInTheDocument()
    expect(screen.getByText('2026-10-30 04:05:00 UTC')).toBeInTheDocument()
    expect(screen.getByText('本次获取时间')).toBeInTheDocument()
  })

  it('cached=true 时显示缓存说明，不把缓存时间说成新抓取', async () => {
    const user = userEvent.setup()
    const report = makePoiSourceReport(QUERY, { cached: true })
    renderPanel({ requestPoiSources: adapterMock(() => Promise.resolve(report)) })

    await queryOnce(user)
    await screen.findByTestId('poi-sources-result')
    expect(screen.getByTestId('poi-sources-cached')).toHaveTextContent(/近期缓存/)
    expect(screen.getByTestId('poi-sources-cached')).toHaveTextContent(/原时间/)
  })

  it('no_candidates：清空并说明不代表地点不存在', async () => {
    const user = userEvent.setup()
    const okReport = makePoiSourceReport(QUERY)
    const noneReport = makePoiSourceReport(QUERY, { status: 'no_candidates', candidates: [] })
    let call = 0
    renderPanel({
      requestPoiSources: adapterMock(() => Promise.resolve(call++ === 0 ? okReport : noneReport)),
    })

    await queryOnce(user)
    await screen.findByTestId('poi-sources-result')
    expect(screen.getByText('示例便利店（虚构）')).toBeInTheDocument()

    await queryOnce(user)
    await waitFor(() => expect(screen.queryByText('示例便利店（虚构）')).toBeNull())
    expect(screen.getByText(/不代表该地点/)).toBeInTheDocument()
  })

  it('notes 以纯文本展示', async () => {
    const user = userEvent.setup()
    const report = makePoiSourceReport(QUERY, {
      notes: ['源元素数超过上限，仅处理前 30 个'],
      source_elements_seen: 42,
    })
    renderPanel({ requestPoiSources: adapterMock(() => Promise.resolve(report)) })
    await queryOnce(user)
    await screen.findByTestId('poi-sources-result')
    expect(screen.getByTestId('poi-sources-notes')).toHaveTextContent(
      '源元素数超过上限，仅处理前 30 个',
    )
  })
})

describe('取消与竞态', () => {
  it('挂起时可停止：abort 传给 adapter，停止后迟到响应不落地', async () => {
    const user = userEvent.setup()
    const d = deferred<PoiSourceReport>()
    const adapter = adapterMock(() => d.promise)
    renderPanel({ requestPoiSources: adapter })

    await queryOnce(user)
    expect(screen.getByRole('button', { name: '停止等待' })).toBeInTheDocument()
    expect(adapter.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)

    await user.click(screen.getByRole('button', { name: '停止等待' }))
    expect(screen.getByRole('alert')).toHaveTextContent('已停止等待')

    await act(async () => {
      d.resolve(makePoiSourceReport(QUERY))
      await d.promise.catch(() => {})
    })
    expect(screen.queryByTestId('poi-sources-result')).toBeNull()
    // 恢复后可再次显式查询
    expect(screen.getByRole('button', { name: '查询附近资料' })).toBeEnabled()
  })

  it('查询中收起面板：迟到响应不落地，onClose 触发', async () => {
    const user = userEvent.setup()
    const d = deferred<PoiSourceReport>()
    const onClose = vi.fn()
    renderPanel({ requestPoiSources: adapterMock(() => d.promise), onClose })

    await queryOnce(user)
    await user.click(screen.getByRole('button', { name: '收起' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    await act(async () => {
      d.resolve(makePoiSourceReport(QUERY))
      await d.promise.catch(() => {})
    })
    expect(screen.queryByTestId('poi-sources-result')).toBeNull()
  })

  it('adapter 忽略 abort 也能按时被序号丢弃：切站点后旧响应不串上下文', async () => {
    const user = userEvent.setup()
    // adapter 故意不响应 signal，模拟「忽略 abort 的适配器」
    const d = deferred<PoiSourceReport>()
    const adapter = adapterMock(() => d.promise)
    renderPanel({ requestPoiSources: adapter })

    await queryOnce(user)
    await user.selectOptions(screen.getByLabelText('按哪条记录坐标查询'), 'p2')

    await act(async () => {
      d.resolve(makePoiSourceReport({ lat: 51.5072, lon: -0.1276 }))
      await d.promise.catch(() => {})
    })
    // 旧响应属于 p1 的查询，切到 p2 后必须丢弃，不出现结果
    expect(screen.queryByTestId('poi-sources-result')).toBeNull()
  })

  it('查询中切站点/换天/改 revision：旧结果立即不可见', async () => {
    const user = userEvent.setup()
    const d = deferred<PoiSourceReport>()
    const { rerender } = render(
      <DayPoiSourcesPanel
        trip={makePoiTrip()}
        day={makePoiTrip().days[0]}
        revision={1}
        requestPoiSources={() => d.promise}
      />,
    )
    await queryOnce(user)

    const trip = makePoiTrip()
    rerender(
      <DayPoiSourcesPanel
        trip={trip}
        day={trip.days[0]}
        revision={1}
        requestPoiSources={() => d.promise}
      />,
    )
    await act(async () => {
      d.resolve(makePoiSourceReport(QUERY))
      await d.promise.catch(() => {})
    })
    // trip 对象引用变化 → 作废旧结果
    expect(screen.queryByTestId('poi-sources-result')).toBeNull()
  })
})

describe('same-query 失败与旧数据标注', () => {
  it('停止等待：若有旧成功候选则明确标注「上次结果」，第一次查询停止则无候选', async () => {
    const user = userEvent.setup()
    let call = 0
    let release!: () => void
    const gate = () =>
      new Promise<PoiSourceReport>((resolve) => {
        release = () => resolve(makePoiSourceReport(QUERY))
      })
    const okReport = makePoiSourceReport(QUERY)
    renderPanel({
      requestPoiSources: adapterMock(() => (call++ === 0 ? Promise.resolve(okReport) : gate())),
    })

    // 第一次成功，有旧候选
    await queryOnce(user)
    await screen.findByTestId('poi-sources-result')
    expect(screen.queryByTestId('poi-sources-stale')).toBeNull()

    // same-query 刷新挂起 → 停止：旧候选仍在但必须标注「上次结果」
    await queryOnce(user)
    expect(screen.getByRole('button', { name: '停止等待' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '停止等待' }))
    await waitFor(() => expect(screen.getByTestId('poi-sources-stale')).toBeInTheDocument())
    expect(screen.getByTestId('poi-sources-stale')).toHaveTextContent('上次查询的结果')
    expect(screen.getByText('示例便利店（虚构）')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('已停止等待')

    // 迟到响应不落地，也不撤标注
    await act(async () => {
      release()
    })
    expect(screen.getByTestId('poi-sources-stale')).toBeInTheDocument()
    expect(screen.getAllByText('2026-10-30 04:05:02 UTC').length).toBeGreaterThanOrEqual(1)
  })

  it('第一次查询就停止：没有旧候选，不显示结果也不显示 stale', async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gated = new Promise<PoiSourceReport>((resolve) => {
      release = () => resolve(makePoiSourceReport(QUERY))
    })
    renderPanel({ requestPoiSources: adapterMock(() => gated) })

    await queryOnce(user)
    await user.click(screen.getByRole('button', { name: '停止等待' }))
    await act(async () => {
      release()
    })
    expect(screen.queryByTestId('poi-sources-result')).toBeNull()
    expect(screen.queryByTestId('poi-sources-stale')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('已停止等待')
  })

  it('same-query 刷新失败：保留旧候选并显示「本次未得到新结果」，原时间不变', async () => {
    const user = userEvent.setup()
    const okReport = makePoiSourceReport(QUERY)
    let call = 0
    renderPanel({
      requestPoiSources: adapterMock(() =>
        call++ === 0 ? Promise.resolve(okReport) : Promise.reject(new Error('boom')),
      ),
    })

    await queryOnce(user)
    await screen.findByTestId('poi-sources-result')
    expect(screen.queryByTestId('poi-sources-stale')).toBeNull()

    await queryOnce(user)
    await waitFor(() => expect(screen.getByTestId('poi-sources-stale')).toBeInTheDocument())
    // 旧候选仍在
    expect(screen.getByText('示例便利店（虚构）')).toBeInTheDocument()
    // 原获取时间保持（信封级事实区），没有伪造成新时间
    expect(screen.getAllByText('2026-10-30 04:05:02 UTC').length).toBeGreaterThanOrEqual(1)
  })

  it('不同 query（切站点）后旧结果立即清掉，不挂到新站', async () => {
    const user = userEvent.setup()
    const okReport = makePoiSourceReport(QUERY)
    renderPanel({ requestPoiSources: adapterMock(() => Promise.resolve(okReport)) })

    await queryOnce(user)
    await screen.findByTestId('poi-sources-result')
    expect(screen.getByText('示例便利店（虚构）')).toBeInTheDocument()

    // 换站点：entry 上下文不匹配，结果立刻消失（无 stale 标注）
    await user.selectOptions(screen.getByLabelText('按哪条记录坐标查询'), 'p2')
    expect(screen.queryByTestId('poi-sources-result')).toBeNull()
    expect(screen.queryByTestId('poi-sources-stale')).toBeNull()
  })

  it('same-query 后端业务失败（rate_limited 信封）：保留旧候选并标注', async () => {
    const user = userEvent.setup()
    const okReport = makePoiSourceReport(QUERY)
    const limited = makePoiSourceReport(QUERY, {
      status: 'rate_limited',
      candidates: [],
      reason: '兴趣点公开资料服务请求过于频繁，请稍后再试',
    })
    let call = 0
    renderPanel({
      requestPoiSources: adapterMock(() => Promise.resolve(call++ === 0 ? okReport : limited)),
    })

    await queryOnce(user)
    await screen.findByTestId('poi-sources-result')

    await queryOnce(user)
    await waitFor(() => expect(screen.getByTestId('poi-sources-stale')).toBeInTheDocument())
    expect(screen.getByText('示例便利店（虚构）')).toBeInTheDocument()
    // 固定文案，不回显 reason 原文
    expect(screen.getByRole('alert')).toHaveTextContent('请求过于频繁')
    expect(screen.queryByText(/兴趣点公开资料服务请求过于频繁/)).toBeNull()
  })

  it('same-query 成功拿到新结果后 stale 标注撤掉', async () => {
    const user = userEvent.setup()
    const okReport = makePoiSourceReport(QUERY)
    let call = 0
    renderPanel({
      requestPoiSources: adapterMock(() => {
        call += 1
        if (call === 2) return Promise.reject(new Error('boom'))
        return Promise.resolve(okReport)
      }),
    })

    await queryOnce(user)
    await screen.findByTestId('poi-sources-result')
    await queryOnce(user)
    await waitFor(() => expect(screen.getByTestId('poi-sources-stale')).toBeInTheDocument())
    await queryOnce(user)
    await waitFor(() => expect(screen.queryByTestId('poi-sources-stale')).toBeNull())
    expect(screen.getByText('示例便利店（虚构）')).toBeInTheDocument()
  })
})

describe('错误分类与不可变', () => {
  it('超时 / 网络 / bad_payload 显示固定文案，不回显底层异常', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <DayPoiSourcesPanel
        trip={makePoiTrip()}
        day={makePoiTrip().days[0]}
        revision={1}
        requestPoiSources={() => Promise.reject(new Error('<html>proxy error</html>'))}
      />,
    )
    await queryOnce(user)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('查询附近资料时出现问题'),
    )
    expect(screen.queryByText(/<html>/)).toBeNull()

    rerender(
      <DayPoiSourcesPanel
        trip={makePoiTrip()}
        day={makePoiTrip().days[0]}
        revision={2}
        requestPoiSources={() =>
          Promise.reject(
            Object.assign(new Error('x'), { kind: 'timeout', name: 'ApiError' }),
          )
        }
      />,
    )
    await queryOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('超时'))
  })

  it('查询失败不改行程：trip 对象引用内容保持不变', async () => {
    const user = userEvent.setup()
    const trip = makePoiTrip()
    const snapshot = JSON.stringify(trip)
    renderPanel({
      trip,
      requestPoiSources: () => Promise.reject(new Error('network down')),
    })
    await queryOnce(user)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(JSON.stringify(trip)).toBe(snapshot)
  })
})

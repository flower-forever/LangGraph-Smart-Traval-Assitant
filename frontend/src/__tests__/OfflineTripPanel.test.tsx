import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OfflineTripPanel, {
  OFFLINE_TRIP_HTML_URL_REVOKE_DELAY_MS,
  downloadOfflineTripHtml,
} from '../components/OfflineTripPanel'
import { OFFLINE_TRIP_HTML_MIME_TYPE } from '../lib/offlineTripHtml'
import type { Trip } from '../lib/api'
import { createWorkspaceRecord, emptyBudgetSnapshot, emptySidecar } from '../lib/workspace'
import type { WorkspaceRecordV1 } from '../lib/workspaceTypes'
import { WORKSPACE_STORAGE_KEY } from '../lib/workspaceTypes'
import { utf8ByteLength } from '../lib/savedTrips'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_760_000_000_000
const EXPORTED_AT = Date.UTC(2026, 10, 5, 16, 3, 12)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function makeRecord(
  overrides: {
    ownerId?: string
    title?: string
    budget?: WorkspaceRecordV1['budget']
  } = {},
): WorkspaceRecordV1 {
  const trip = clone(MOCK_TRIP) as Trip
  if (overrides.title !== undefined) trip.title = overrides.title
  const result = createWorkspaceRecord({
    workspaceId: 'workspace-panel',
    ownerId: overrides.ownerId ?? 'owner-panel',
    trip,
    workspaceRevision: 3,
    now: NOW,
    sidecar: emptySidecar(),
    budget: overrides.budget === undefined ? null : overrides.budget,
    label: '面板测试',
  })
  if (!result.ok) throw new Error(`${result.path}: ${result.message}`)
  return result.value
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 失败'))
    reader.readAsText(blob)
  })
}

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:offline-trip')
  revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.spyOn(Date, 'now').mockReturnValue(EXPORTED_AT)
})

afterEach(() => {
  cleanup()
  const urlStatics = URL as unknown as Record<string, unknown>
  delete urlStatics.createObjectURL
  delete urlStatics.revokeObjectURL
  vi.restoreAllMocks()
})

function region(): HTMLElement {
  return screen.getByRole('region', { name: /离线随身行程页/ })
}

function previewFrame(): HTMLIFrameElement {
  return within(region()).getByTitle('离线行程页预览') as HTMLIFrameElement
}

function frameHtml(frame: HTMLIFrameElement): string {
  return frame.getAttribute('srcdoc') ?? frame.srcdoc
}

describe('OfflineTripPanel：显式预览与下载', () => {
  it('挂载时不生成 HTML、不建 Blob URL、不点击下载、不联网、不写存储', () => {
    window.localStorage.clear()
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<OfflineTripPanel record={makeRecord()} />)

    expect(within(region()).getByRole('button', { name: '预览离线行程页' })).toBeInTheDocument()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('点预览才生成：sandbox 空 iframe + srcdoc 展示静态页，预览前不出现下载按钮', async () => {
    const user = userEvent.setup()
    render(<OfflineTripPanel record={makeRecord()} />)
    const previewButton = within(region()).getByRole('button', { name: '预览离线行程页' })
    await user.click(previewButton)

    const frame = previewFrame()
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame).not.toHaveAttribute('allow')
    expect(frame.getAttribute('src')).toBeNull()
    const html = frameHtml(frame)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.toLowerCase()).not.toContain('<script')
    expect(html).not.toMatch(/https?:\/\//i)
    expect(html).toContain(new Date(EXPORTED_AT).toISOString())
    expect(within(region()).getByRole('button', { name: '下载离线页 (.html)' })).toBeInTheDocument()
    expect(within(region()).getByRole('heading', { name: /预览：/ })).toBeInTheDocument()
    expect(within(region()).getByText(/生成时间：/)).toBeInTheDocument()
    // 预览本身不建 Blob URL、不下载
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('下载只使用预览的同一份字节：一次 Blob URL、一次点击、延迟回收', async () => {
    const user = userEvent.setup()
    render(<OfflineTripPanel record={makeRecord()} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    const html = frameHtml(previewFrame())
    await user.click(within(region()).getByRole('button', { name: '下载离线页 (.html)' }))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe(OFFLINE_TRIP_HTML_MIME_TYPE)
    expect(blob.size).toBe(utf8ByteLength(html))
    expect(await readBlob(blob)).toBe(html)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(within(region()).getAllByText(/已发起浏览器下载/).length).toBe(1)
  })

  it('重复下载不重新生成：两次 Blob 内容都与预览一致', async () => {
    const user = userEvent.setup()
    render(<OfflineTripPanel record={makeRecord()} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    const html = frameHtml(previewFrame())
    const download = within(region()).getByRole('button', { name: '下载离线页 (.html)' })
    await user.click(download)
    await user.click(download)

    expect(createObjectURL).toHaveBeenCalledTimes(2)
    const first = createObjectURL.mock.calls[0][0] as Blob
    const second = createObjectURL.mock.calls[1][0] as Blob
    expect(await readBlob(first)).toBe(html)
    expect(await readBlob(second)).toBe(html)
    expect(frameHtml(previewFrame())).toBe(html)
  })

  it('放弃预览：预览与下载按钮消失，焦点回到生成按钮', async () => {
    const user = userEvent.setup()
    render(<OfflineTripPanel record={makeRecord()} />)
    const generate = within(region()).getByRole('button', { name: '预览离线行程页' })
    await user.click(generate)
    expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()

    await user.click(within(region()).getByRole('button', { name: '放弃预览' }))
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
    expect(generate).toHaveFocus()
  })
})

describe('OfflineTripPanel：变化作废与 fail closed', () => {
  it('owner 变化：旧预览立即作废，A→B→A 不复活，须重新预览', async () => {
    const user = userEvent.setup()
    const record = makeRecord()
    const { rerender } = render(<OfflineTripPanel record={record} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()

    rerender(<OfflineTripPanel record={{ ...record, ownerId: 'owner-other' }} />)
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()

    rerender(<OfflineTripPanel record={record} />)
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()

    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()
  })

  it('同 id 内容变化：旧预览作废，下载按钮消失，须重新预览', async () => {
    const user = userEvent.setup()
    const record = makeRecord()
    const { rerender } = render(<OfflineTripPanel record={record} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    expect(within(region()).getByRole('button', { name: '下载离线页 (.html)' })).toBeInTheDocument()

    rerender(
      <OfflineTripPanel record={{ ...record, trip: { ...record.trip, title: '改过的标题' } }} />,
    )
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('同内容换 record 引用：旧预览作废，A→B→A 不复活，且不自动下载', async () => {
    const user = userEvent.setup()
    const record = makeRecord()
    const { rerender } = render(<OfflineTripPanel record={record} epoch={1} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()

    rerender(<OfflineTripPanel record={clone(record)} epoch={1} />)
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()

    rerender(<OfflineTripPanel record={record} epoch={1} />)
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('单层 trip / sidecar / budget 引用变化（内容相同）都作废旧预览', async () => {
    const user = userEvent.setup()
    const record = makeRecord({ budget: emptyBudgetSnapshot() })
    const { rerender } = render(<OfflineTripPanel record={record} epoch={7} />)
    const previewButton = within(region()).getByRole('button', { name: '预览离线行程页' })

    const variants = [
      { ...record, trip: { ...record.trip } },
      { ...record, sidecar: { ...record.sidecar } },
      { ...record, budget: record.budget === null ? null : { ...record.budget } },
    ]
    for (const variant of variants) {
      await user.click(previewButton)
      expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()
      rerender(<OfflineTripPanel record={variant} epoch={7} />)
      expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
      expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
      rerender(<OfflineTripPanel record={record} epoch={7} />)
      expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    }
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('epoch A→B→A 不复活旧预览，须重新点击预览', async () => {
    const user = userEvent.setup()
    const record = makeRecord()
    const { rerender } = render(<OfflineTripPanel record={record} epoch={1} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()

    rerender(<OfflineTripPanel record={record} epoch={2} />)
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()

    rerender(<OfflineTripPanel record={record} epoch={1} />)
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()

    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()
  })

  it('非法 epoch fail closed：固定提示、无预览、无下载、0 Blob', async () => {
    const user = userEvent.setup()
    render(<OfflineTripPanel record={makeRecord()} epoch={Number.NaN} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))

    expect(within(region()).getByText(/epoch 不合法/)).toBeInTheDocument()
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('下载前记录被原地改写：拒绝下载并保留可见的重新预览提示，0 Blob / 0 click', async () => {
    const user = userEvent.setup()
    const record = makeRecord()
    render(<OfflineTripPanel record={record} epoch={1} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()

    // §5.1.1 禁止外部原地突变；组件仍必须 fail closed，而不是拿旧字节自证。
    record.trip.title = '原地改过的标题'
    await user.click(within(region()).getByRole('button', { name: '下载离线页 (.html)' }))

    expect(within(region()).getByText(/请重新预览后再下载/)).toBeInTheDocument()
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('非法记录 fail closed：固定错误、无预览、无下载、不写存储', async () => {
    window.localStorage.clear()
    window.localStorage.setItem('panel-sentinel', 'keep')
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const bad = clone(makeRecord())
    bad.trip.days[0].stops[1].id = bad.trip.days[0].stops[0].id

    const user = userEvent.setup()
    render(<OfflineTripPanel record={bad} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))

    expect(within(region()).getByText(/没有生成离线页/)).toBeInTheDocument()
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('panel-sentinel')).toBe('keep')
  })

  it('toJSON 等不可序列化字段不能伪造预览快照：fail closed，不生成预览', async () => {
    const record = makeRecord()
    ;(record.trip as Trip & { toJSON?: () => unknown }).toJSON = () => ({ id: 'fake' })

    const user = userEvent.setup()
    render(<OfflineTripPanel record={record} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))

    expect(within(region()).getByText(/无法序列化为可验证的快照/)).toBeInTheDocument()
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载离线页 (.html)' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('非法记录修正后不自动生成，须用户重新点击预览', async () => {
    const bad = clone(makeRecord())
    bad.trip.days[0].stops[1].id = bad.trip.days[0].stops[0].id
    const good = makeRecord()
    const user = userEvent.setup()
    const { rerender } = render(<OfflineTripPanel record={bad} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()

    rerender(<OfflineTripPanel record={good} />)
    expect(within(region()).queryByTitle('离线行程页预览')).toBeNull()
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()
  })

  it('下载时 createObjectURL 抛错：固定文案、预览保留可重试、不回显异常原文', async () => {
    createObjectURL.mockImplementation(() => {
      throw new Error('boom secret/path')
    })
    const user = userEvent.setup()
    render(<OfflineTripPanel record={makeRecord()} />)
    await user.click(within(region()).getByRole('button', { name: '预览离线行程页' }))
    await user.click(within(region()).getByRole('button', { name: '下载离线页 (.html)' }))

    expect(within(region()).getAllByText(/创建下载链接失败/).length).toBe(1)
    expect(within(region()).queryByText(/boom secret/)).toBeNull()
    expect(within(region()).getByTitle('离线行程页预览')).toBeInTheDocument()
    expect(within(region()).getByRole('button', { name: '下载离线页 (.html)' })).toBeInTheDocument()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })
})

describe('downloadOfflineTripHtml：浏览器侧下载封装', () => {
  const HTML = '<!doctype html><html><body>离线页</body></html>'

  it('空内容不建 Blob URL', () => {
    for (const html of [null, undefined, '']) {
      const outcome = downloadOfflineTripHtml(html, 'trip.html')
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.reason).toBe('missing_content')
    }
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('URL API 不可用返回 unsupported 固定文案', () => {
    const urlStatics = URL as unknown as Record<string, unknown>
    urlStatics.createObjectURL = undefined
    urlStatics.revokeObjectURL = undefined
    const outcome = downloadOfflineTripHtml(HTML, 'trip.html')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unsupported')
    expect(outcome.message).toContain('URL.createObjectURL 不可用')
  })

  it('用传入的同一份 HTML 创建 text/html Blob、点击一次并按注入调度延迟回收（幂等）', async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []
    const outcome = downloadOfflineTripHtml(HTML, 'trip.html', {
      schedule: (callback, delayMs) => scheduled.push({ callback, delayMs }),
    })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.filename).toBe('trip.html')
    expect(outcome.html).toBe(HTML)
    expect(outcome.bytes).toBe(utf8ByteLength(HTML))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(scheduled).toEqual([
      { callback: expect.any(Function), delayMs: OFFLINE_TRIP_HTML_URL_REVOKE_DELAY_MS },
    ])

    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe(OFFLINE_TRIP_HTML_MIME_TYPE)
    expect(await readBlob(blob)).toBe(HTML)

    scheduled[0].callback()
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:offline-trip')
    scheduled[0].callback()
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('createObjectURL 抛错时返回 error，固定文案不回显原始异常', () => {
    createObjectURL.mockImplementation(() => {
      throw new Error('quota boom secret/path')
    })
    const outcome = downloadOfflineTripHtml(HTML, 'trip.html')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('error')
    expect(outcome.message).not.toContain('quota boom')
    expect(outcome.message).not.toContain('secret/path')
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('不写 localStorage、不发请求', () => {
    window.localStorage.clear()
    window.localStorage.setItem('download-sentinel', 'keep')
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const outcome = downloadOfflineTripHtml(HTML, 'trip.html', { schedule: () => {} })
    expect(outcome.ok).toBe(true)
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('download-sentinel')).toBe('keep')
  })
})

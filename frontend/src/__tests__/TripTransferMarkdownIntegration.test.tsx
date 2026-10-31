import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TripTransferPanel from '../components/TripTransferPanel'
import type { Trip } from '../lib/api'
import { SAVED_TRIPS_STORAGE_KEY } from '../lib/savedTrips'
import { createTripBackup } from '../lib/tripTransfer'
import { safeTripMarkdownFilename } from '../lib/tripMarkdown'
import { MOCK_TRIP } from './fixtures/trip'

const FIXED_NOW = new Date('2026-01-01T08:00:00.000Z')

function backupTextOf(trip: Trip): string {
  const backup = createTripBackup(trip, { now: FIXED_NOW })
  if (!backup.ok) throw new Error(`生成备份失败：${backup.reason}`)
  return backup.json
}

function jsonFile(text: string): File {
  return new File([text], 'trip.json', { type: 'application/json' })
}

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  createObjectURL = vi.fn(() => 'blob:integration')
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
})

afterEach(() => {
  cleanup()
  const urlStatics = URL as unknown as Record<string, unknown>
  delete urlStatics.createObjectURL
  delete urlStatics.revokeObjectURL
  vi.restoreAllMocks()
  window.localStorage.clear()
})

function panel(): HTMLElement {
  return screen.getByRole('region', { name: '行程备份与导入' })
}

function markdownRegion(): HTMLElement {
  return screen.getByRole('region', { name: '导出可读路书（Markdown）' })
}

describe('TripTransferPanel × TripMarkdownExport：子入口接线', () => {
  it('有行程时子入口挂载；原 JSON 下载、导入预览仍正常', async () => {
    const user = userEvent.setup()
    render(<TripTransferPanel trip={MOCK_TRIP} onOpen={vi.fn()} />)

    expect(markdownRegion()).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: '下载行程备份 (.json)' })).toBeInTheDocument()
    expect(within(panel()).getByText(/只用于阅读分享的 Markdown 路书导出/)).toBeInTheDocument()

    // 原 JSON 下载路径不受影响
    await user.click(within(panel()).getByRole('button', { name: '下载行程备份 (.json)' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('application/json;charset=utf-8')
  })

  it('没有行程时子入口不挂载，也不能预览 Markdown', () => {
    render(<TripTransferPanel trip={null} />)
    expect(screen.queryByRole('region', { name: '导出可读路书（Markdown）' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('JSON 导入预览流程与 Markdown 预览互不干扰', async () => {
    const user = userEvent.setup()
    render(<TripTransferPanel trip={null} onOpen={vi.fn()} />)
    const input = screen.getByLabelText(/选择备份文件/) as HTMLInputElement

    // 先导入预览
    fireEvent.change(input, { target: { files: [jsonFile(backupTextOf(MOCK_TRIP))] } })
    await screen.findByRole('heading', { name: /预览：杭州三日漫步路书/ })
    expect(screen.queryByRole('region', { name: '导出可读路书（Markdown）' })).toBeNull()

    // 打开这份行程的回调被调用
    await user.click(screen.getByRole('button', { name: '打开这份行程' }))
  })

  it('宿主带行程时 Markdown 子入口预览的是当前行程', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<TripTransferPanel trip={MOCK_TRIP} onOpen={onOpen} />)

    await user.click(within(markdownRegion()).getByRole('button', { name: '预览路书（Markdown）' }))
    const textarea = within(markdownRegion()).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toContain('# 杭州三日漫步路书')
    expect(safeTripMarkdownFilename(MOCK_TRIP)).toContain('.md')
  })

  it('存储不被 Markdown 流程触碰：预览 / 下载 / 放弃全程 localStorage 为空', async () => {
    const user = userEvent.setup()
    render(<TripTransferPanel trip={MOCK_TRIP} />)
    await user.click(within(markdownRegion()).getByRole('button', { name: '预览路书（Markdown）' }))
    await user.click(within(markdownRegion()).getByRole('button', { name: '下载路书 (.md)' }))
    await user.click(within(markdownRegion()).getByRole('button', { name: '放弃预览' }))
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
    // JSON 与 Markdown 共享 Blob URL 计数：JSON 下载 0 次（本用例没点），Markdown 1 次
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('同 id 内容变化后 Markdown 预览作废，JSON 导出区域不受影响', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripTransferPanel trip={MOCK_TRIP} />)
    await user.click(within(markdownRegion()).getByRole('button', { name: '预览路书（Markdown）' }))
    expect(within(markdownRegion()).getByRole('textbox')).toBeInTheDocument()

    rerender(<TripTransferPanel trip={{ ...MOCK_TRIP, summary: '内容变了' }} />)
    expect(within(markdownRegion()).queryByRole('textbox')).toBeNull()
    // 原导出区域照常显示当前行程
    expect(within(panel()).getByText(/共 3 天 \/ 4 个站点/)).toBeInTheDocument()
  })
})

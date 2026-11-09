/**
 * 分享卡片面板（四期 S4）：默认态、风格/日期切换零写入、显式下载、
 * PNG 失败 typed 文案与成功路径。全部离线，不依赖真实 canvas。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ShareCardPanel from '../components/ShareCardPanel'
import type { RasterizeOutcome } from '../lib/shareCardPng'
import { MOCK_TRIP } from './fixtures/trip'

function snapshotStorage(): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key !== null) snapshot.set(key, window.localStorage.getItem(key) ?? '')
  }
  return snapshot
}

function expectSameStorage(before: Map<string, string>) {
  const after = snapshotStorage()
  expect(after.size).toBe(before.size)
  for (const [key, raw] of before) {
    expect(after.get(key)).toBe(raw)
  }
}

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
let lastDownload: string

beforeEach(() => {
  window.localStorage.clear()
  createObjectURL = vi.fn(() => 'blob:share-card-test')
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
  lastDownload = ''
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    lastDownload = this.download
  })
})

afterEach(() => {
  cleanup()
  const urlStatics = URL as unknown as Record<string, unknown>
  delete urlStatics.createObjectURL
  delete urlStatics.revokeObjectURL
  window.localStorage.clear()
  vi.restoreAllMocks()
})

function renderPanel(overrides: {
  rasterize?: (svg: string) => Promise<RasterizeOutcome>
} = {}) {
  const onClose = vi.fn()
  const utils = render(
    <ShareCardPanel
      trip={MOCK_TRIP}
      initialDay={1}
      onClose={onClose}
      rasterize={overrides.rasterize}
    />,
  )
  return { ...utils, onClose }
}

function preview(): HTMLElement {
  return screen.getByTestId('share-card-preview')
}

describe('ShareCardPanel · 默认态与零写入', () => {
  it('默认宣纸雅集 + initialDay，对话框语义完整', () => {
    renderPanel()

    const dialog = screen.getByRole('dialog', { name: '生成分享卡片' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByLabelText('选择日期')).toHaveValue('1')
    expect(preview().querySelector('[data-style]')).toHaveAttribute('data-style', 'xuanzhi')
    expect(screen.getByRole('button', { name: '宣纸雅集' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '旅行日报' })).toHaveAttribute('aria-pressed', 'false')
    expect(preview().innerHTML).toContain('断桥残雪')
    expect(preview().innerHTML).toContain('第 1 天')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('六风格按钮可访问名精确，切换只改预览 data-style 与 aria-pressed', async () => {
    const user = userEvent.setup()
    const labels = ['宣纸雅集', '旅行日报', '老黄历', '双色印刷海报', '夜航卡', '登机牌']
    const ids = ['xuanzhi', 'daily', 'almanac', 'riso', 'midnight', 'boarding']
    window.localStorage.setItem('travel-assistant:saved-trips:v1', JSON.stringify({ trips: ['keep'] }))
    window.localStorage.setItem('unrelated:key', 'raw-value-原样')
    const before = snapshotStorage()
    renderPanel()

    for (const label of labels) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }

    for (let index = 0; index < labels.length; index += 1) {
      await user.click(screen.getByRole('button', { name: labels[index] }))
      expect(preview().querySelector('[data-style]')).toHaveAttribute('data-style', ids[index])
      expect(screen.getByRole('button', { name: labels[index] })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(createObjectURL).not.toHaveBeenCalled()
      expectSameStorage(before)
    }
  })

  it('切换日期只更新预览，站名随所选天变化', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('travel-assistant:theme:v1', 'dark')
    window.localStorage.setItem('unrelated:key', 'raw-value-原样')
    const before = snapshotStorage()
    renderPanel()

    await user.selectOptions(screen.getByLabelText('选择日期'), '2')
    expect(screen.getByLabelText('选择日期')).toHaveValue('2')
    expect(preview().innerHTML).toContain('运河与老巷')
    expect(preview().innerHTML).toContain('第 2 天')
    expect(preview().innerHTML).not.toContain('断桥残雪')

    await user.selectOptions(screen.getByLabelText('选择日期'), '3')
    expect(preview().innerHTML).toContain('龙井村')
    expect(preview().innerHTML).toContain('日期未知')
    expect(createObjectURL).not.toHaveBeenCalled()
    expectSameStorage(before)
  })
})

describe('ShareCardPanel · 显式下载', () => {
  it('点「下载 SVG」只触发一次下载，文件名含天与风格', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('travel-assistant:saved-trips:v1', JSON.stringify({ trips: ['keep'] }))
    const before = snapshotStorage()
    renderPanel()

    await user.click(screen.getByRole('button', { name: '下载 SVG' }))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(lastDownload).toBe('travel-assistant-share-d1-xuanzhi.svg')
    expect(preview()).toBeInTheDocument()
    expectSameStorage(before)
  })

  it('关闭或 Esc 不触发下载，零存储写入', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('travel-assistant:saved-trips:v1', JSON.stringify({ trips: ['keep'] }))
    window.localStorage.setItem('unrelated:key', 'raw-value-原样')
    const before = snapshotStorage()
    const { onClose } = renderPanel()

    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(createObjectURL).not.toHaveBeenCalled()
    expectSameStorage(before)
  })

  it.each([
    ['unsupported', '当前浏览器不支持在本地生成 PNG，请改下载 SVG。'],
    ['decode', '卡片图像解码失败，请重试或改下载 SVG。'],
    ['encode', 'PNG 编码失败，请重试或改下载 SVG。'],
  ] as const)('PNG %s 失败显示 typed 文案且不崩溃', async (reason, text) => {
    const user = userEvent.setup()
    const rasterize = vi.fn(async () => ({ ok: false as const, reason }))
    renderPanel({ rasterize })

    await user.click(screen.getByRole('button', { name: '下载 PNG' }))

    expect(await screen.findByText(text)).toHaveAttribute('role', 'alert')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('PNG 生成中按钮 disabled + aria-busy，完成后恢复', async () => {
    const user = userEvent.setup()
    let resolveRasterize: (outcome: RasterizeOutcome) => void = () => {}
    const pending = new Promise<RasterizeOutcome>((resolve) => {
      resolveRasterize = resolve
    })
    renderPanel({ rasterize: () => pending })

    await user.click(screen.getByRole('button', { name: '下载 PNG' }))
    const busyButton = screen.getByRole('button', { name: '正在生成 PNG…' })
    expect(busyButton).toBeDisabled()
    expect(busyButton).toHaveAttribute('aria-busy', 'true')

    resolveRasterize({ ok: false, reason: 'encode' })
    expect(await screen.findByText('PNG 编码失败，请重试或改下载 SVG。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载 PNG' })).toBeEnabled()
  })

  it('PNG 生成中切换风格：旧图结果作废，不触发下载', async () => {
    const user = userEvent.setup()
    let resolveRasterize: (outcome: RasterizeOutcome) => void = () => {}
    const pending = new Promise<RasterizeOutcome>((resolve) => {
      resolveRasterize = resolve
    })
    renderPanel({ rasterize: () => pending })

    await user.click(screen.getByRole('button', { name: '下载 PNG' }))
    await user.click(screen.getByRole('button', { name: '旅行日报' }))
    resolveRasterize({
      ok: true,
      blob: new Blob(['png-bytes'], { type: 'image/png' }),
    })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '下载 PNG' })).toBeEnabled(),
    )
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(preview().querySelector('[data-style]')).toHaveAttribute('data-style', 'daily')
  })

  it('PNG 成功路径通过 Blob 下载一次，文件名 .png', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('travel-assistant:saved-trips:v1', JSON.stringify({ trips: ['keep'] }))
    const before = snapshotStorage()
    const rasterize = vi.fn(async () => ({
      ok: true as const,
      blob: new Blob(['png-bytes'], { type: 'image/png' }),
    }))
    renderPanel({ rasterize })

    await user.click(screen.getByRole('button', { name: '下载 PNG' }))

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))
    expect(lastDownload).toBe('travel-assistant-share-d1-xuanzhi.png')
    expect(rasterize).toHaveBeenCalledTimes(1)
    expectSameStorage(before)
  })
})

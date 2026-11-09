/**
 * 五期 S5 · 分享面板扩展：来源单选（草稿/已应用）、路线小地图尾部块、
 * 离线 HTML 路书预览 → 确认下载、2 MiB 明确失败、零存储写入。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ShareCardPanel, { type ShareCardPanelProps } from '../components/ShareCardPanel'
import type { Trip } from '../lib/api'
import { POI_CARDS_FORMAT, POI_CARDS_VERSION, type PoiCardsRecordV1 } from '../lib/poiCards'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_760_000_000_000

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

function cloneTrip(): Trip {
  return JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
}

function draftTrip(): Trip {
  const draft = cloneTrip()
  draft.id = 'draft-trip-1'
  draft.days[0].stops[0].name = '草稿新站'
  return draft
}

function poiRecord(): PoiCardsRecordV1 {
  return {
    format: POI_CARDS_FORMAT,
    version: POI_CARDS_VERSION,
    cards: [
      {
        id: 'card-1',
        identityKey: '断桥残雪',
        name: '断桥残雪',
        intro: '白堤东端',
        openingHours: '全天',
        ticket: '免费',
        images: [],
        provenance: {
          intro: { source: 'manual', detail: '手工粘贴', recordedAt: NOW - 1000 },
          openingHours: null,
          ticket: null,
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    updatedAt: NOW,
  }
}

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
let lastDownload: string
let lastBlob: Blob | null

beforeEach(() => {
  window.localStorage.clear()
  lastBlob = null
  createObjectURL = vi.fn((value: Blob) => {
    lastBlob = value
    return 'blob:share-s5-test'
  })
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

function renderPanel(overrides: Partial<ShareCardPanelProps> = {}) {
  const onClose = vi.fn()
  const utils = render(
    <ShareCardPanel
      trip={MOCK_TRIP}
      initialDay={1}
      onClose={onClose}
      now={() => NOW}
      {...overrides}
    />,
  )
  return { ...utils, onClose }
}

function preview(): HTMLElement {
  return screen.getByTestId('share-card-preview')
}

/** jsdom 的 Blob 没有 text()，用 FileReader 读出下载内容。 */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('blob read failed'))
    reader.readAsText(blob)
  })
}

describe('ShareCardPanel · S5 分享来源', () => {
  it('没有草稿时不制造来源选项', () => {
    renderPanel()
    expect(screen.queryByTestId('share-source')).toBeNull()
    expect(screen.queryByTestId('share-draft-badge')).toBeNull()
  })

  it('有草稿：默认已应用，切草稿后预览即时刷新并显示未应用徽章，零写入', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('unrelated:key', 'raw-value-原样')
    const before = snapshotStorage()
    renderPanel({ draftTrip: draftTrip() })

    expect(screen.getByRole('radio', { name: '当前已应用行程（默认）' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '当前草稿（未应用）' })).not.toBeChecked()
    expect(preview().innerHTML).toContain('断桥残雪')
    expect(screen.queryByTestId('share-draft-badge')).toBeNull()

    await user.click(screen.getByRole('radio', { name: '当前草稿（未应用）' }))
    expect(preview().innerHTML).toContain('草稿新站')
    expect(preview().innerHTML).not.toContain('断桥残雪')
    expect(screen.getByTestId('share-draft-badge')).toHaveTextContent('草稿未应用，分享的是草稿')
    expectSameStorage(before)

    await user.click(screen.getByRole('radio', { name: '当前已应用行程（默认）' }))
    expect(preview().innerHTML).toContain('断桥残雪')
    expect(screen.queryByTestId('share-draft-badge')).toBeNull()
    expectSameStorage(before)
  })
})

describe('ShareCardPanel · S5 路线小地图', () => {
  it('默认不加尾部块；勾选后预览与下载 SVG 都含小地图，零写入', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('unrelated:key', 'raw-value-原样')
    const before = snapshotStorage()
    renderPanel()

    expect(preview().innerHTML).not.toContain('data-share-minimap')
    expect(screen.getByTestId('share-minimap-preview')).toBeInTheDocument()
    expect(screen.getByTestId('share-minimap-unknown')).toHaveTextContent('湖滨晴雨')

    await user.click(screen.getByTestId('share-minimap-toggle'))
    expect(preview().innerHTML).toContain('data-share-minimap="true"')
    expect(preview().innerHTML).toContain('路线小地图')
    expectSameStorage(before)

    await user.click(screen.getByRole('button', { name: '下载 SVG' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(lastBlob).not.toBeNull()
    const text = await readBlob(lastBlob as Blob)
    expect(text).toContain('data-share-minimap="true"')
    expect(text).toContain('data-route="navigation"')
    expectSameStorage(before)
  })

  it('勾选小地图后 PNG 光栅化拿到的也是 1080×1440 组合 SVG', async () => {
    const user = userEvent.setup()
    let received = ''
    const rasterize = vi.fn(async (svg: string) => {
      received = svg
      return { ok: true as const, blob: new Blob(['png-bytes'], { type: 'image/png' }) }
    })
    renderPanel({ rasterize })

    await user.click(screen.getByTestId('share-minimap-toggle'))
    await user.click(screen.getByRole('button', { name: '下载 PNG' }))
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))

    expect(received).toContain('data-share-minimap="true"')
    expect(received).toContain('viewBox="0 0 1080 1440"')
    expect(lastDownload).toBe('travel-assistant-share-d1-xuanzhi.png')
  })

  it('整日无坐标时小地图不可勾选，并提示位置未知', async () => {
    const user = userEvent.setup()
    renderPanel({
      trip: { ...cloneTrip(), days: [cloneTrip().days[1]] },
      initialDay: 2,
    })
    expect(screen.getByTestId('share-minimap-toggle')).toBeDisabled()
    expect(screen.queryByTestId('share-minimap-preview')).toBeNull()
    await user.click(screen.getByRole('button', { name: '下载 SVG' }))
    const text = await readBlob(lastBlob as Blob)
    expect(text).not.toContain('data-share-minimap')
  })
})

describe('ShareCardPanel · S5 离线 HTML 路书', () => {
  it('先预览、取消零下载；确认后下载 .html，零存储写入', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem('unrelated:key', 'raw-value-原样')
    const before = snapshotStorage()
    renderPanel()

    await user.click(screen.getByRole('button', { name: '下载离线路书 (.html)' }))
    const frame = screen.getByTestId('roadbook-preview')
    const html = frame.getAttribute('srcdoc') ?? ''
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('data-day-tab="1"')
    expect(html).toContain('西湖环湖')
    expect(createObjectURL).not.toHaveBeenCalled()
    expectSameStorage(before)

    await user.click(screen.getByRole('button', { name: '取消预览' }))
    expect(screen.queryByTestId('roadbook-preview')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '下载离线路书 (.html)' }))
    await user.click(screen.getByRole('button', { name: '确认下载 .html' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(lastDownload).toMatch(/^travel-assistant-roadbook-.+\.html$/)
    expect(screen.queryByTestId('roadbook-preview')).toBeNull()
    expectSameStorage(before)
  })

  it('超过 2 MiB 明确报错：不预览、不下载、不写存储', async () => {
    const user = userEvent.setup()
    const huge = cloneTrip()
    huge.days[0].stops[0].address = 'x'.repeat(2 * 1024 * 1024)
    window.localStorage.setItem('unrelated:key', 'raw-value-原样')
    const before = snapshotStorage()
    renderPanel({ trip: huge })

    await user.click(screen.getByRole('button', { name: '下载离线路书 (.html)' }))
    const alert = await screen.findByTestId('roadbook-error')
    expect(alert).toHaveTextContent('超过 2 MiB 上限')
    expect(alert).toHaveTextContent('未生成任何文件')
    expect(screen.queryByTestId('roadbook-preview')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expectSameStorage(before)
  })

  it('路书预览复用 S2 三态来源徽章', async () => {
    const user = userEvent.setup()
    renderPanel({ poiCards: poiRecord() })
    await user.click(screen.getByRole('button', { name: '下载离线路书 (.html)' }))
    const html = screen.getByTestId('roadbook-preview').getAttribute('srcdoc') ?? ''
    expect(html).toContain('有来源（待核对）')
    expect(html).toContain('未核实')
    expect(html).not.toContain('已核实')
  })

  it('草稿来源的路书带未应用徽章', async () => {
    const user = userEvent.setup()
    renderPanel({ draftTrip: draftTrip() })
    await user.click(screen.getByRole('radio', { name: '当前草稿（未应用）' }))
    await user.click(screen.getByRole('button', { name: '下载离线路书 (.html)' }))
    const html = screen.getByTestId('roadbook-preview').getAttribute('srcdoc') ?? ''
    expect(html).toContain('草稿未应用，分享的是草稿')
    expect(html).toContain('草稿新站')
  })

  it('切换日期会清掉旧路书预览，避免下载与当前选择不符', async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: '下载离线路书 (.html)' }))
    expect(screen.getByTestId('roadbook-preview')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('选择日期'), '2')
    expect(screen.queryByTestId('roadbook-preview')).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '下载离线路书 (.html)' })).toBeEnabled(),
    )
  })
})

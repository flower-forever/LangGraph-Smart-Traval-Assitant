/**
 * S6 App 级接线集成测试：资料卡备份入口 → 预览 → 确认导入真实写入 poi-cards:v1；
 * 其它存储键 raw 不变；打开面板时重读最新库；外部改动 raw 后确认 → expectedRaw
 * 冲突门拒绝且原字节不动；冲突后「重新载入资料卡库」可在本会话恢复并重新导入。
 * mock 方式沿用同目录 App 测试：fetch 只回 health / example。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import { addCandidateToRecord, createEmptyCandidateRecord } from '../lib/candidatePool'
import { buildPoiCardBackup, serializePoiCardBackup } from '../lib/poiCardBackup'
import {
  POI_CARDS_STORAGE_KEY,
  createEmptyPoiCardsRecord,
  createPoiCard,
  type PoiCardV1,
  type PoiCardsRecordV1,
} from '../lib/poiCards'
import { CANDIDATES_STORAGE_KEY, VERSIONS_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from '../lib/workspaceTypes'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_760_000_000_000

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubHappyFetch() {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
    return Promise.reject(new TypeError(`unexpected url: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function ok<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function makeCard(id: string, name: string, address: string, intro = '杭州著名古刹。'): PoiCardV1 {
  return ok(createPoiCard({ id, name, address, intro }, NOW))
}

function makeRecord(cards: PoiCardV1[]): PoiCardsRecordV1 {
  return { ...ok(createEmptyPoiCardsRecord(NOW)), cards }
}

function seedCandidate(name: string): void {
  const empty = ok(createEmptyCandidateRecord(NOW))
  const added = addCandidateToRecord(
    empty,
    {
      id: 'candidate-1',
      name,
      address: '法云弄1号',
      notes: null,
      tags: [],
      priority: 0,
      location: null,
      source: 'manual',
      copiedFromStopId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    NOW,
  )
  expect(added.ok).toBe(true)
  if (!added.ok) throw new Error(added.message)
  window.localStorage.setItem(CANDIDATES_STORAGE_KEY, JSON.stringify(added.value.record))
}

function backupFile(record: PoiCardsRecordV1, name: string): File {
  return new File([serializePoiCardBackup(buildPoiCardBackup(record, NOW))], name, {
    type: 'application/json',
  })
}

function chooseFile(file: File): void {
  const input = screen.getByLabelText('选择资料卡备份文件') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

function snapshotStorage(): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key !== null) snapshot.set(key, window.localStorage.getItem(key) ?? '')
  }
  return snapshot
}

describe('App × 资料卡备份与恢复', () => {
  let createObjectURL: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
    stubHappyFetch()
    createObjectURL = vi.fn(() => 'blob:app-poi-backup')
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    const urlStatics = URL as unknown as Record<string, unknown>
    delete urlStatics.createObjectURL
    delete urlStatics.revokeObjectURL
  })

  it('打开面板重读最新库：空存储 → 空记录；corrupt → null；两者都零写入', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(MOCK_TRIP.title)
    const entry = screen.getByRole('button', { name: '资料卡备份' })
    const before = snapshotStorage()
    expect(window.localStorage.getItem(POI_CARDS_STORAGE_KEY)).toBeNull()

    await user.click(entry)
    let panel = screen.getByRole('region', { name: '资料卡备份与恢复' })
    expect(within(panel).getByText('当前资料卡库共 0 张卡。')).toBeInTheDocument()
    expect(snapshotStorage()).toEqual(before)

    await user.click(within(panel).getByRole('button', { name: '收起' }))
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, '{ corrupt poi cards')
    const corruptBefore = snapshotStorage()

    await user.click(entry)
    panel = screen.getByRole('region', { name: '资料卡备份与恢复' })
    expect(
      within(panel).getByText('资料卡库当前不可用或未能读取，暂时不能导出。'),
    ).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: '导出资料卡备份' })).toBeDisabled()
    expect(window.localStorage.getItem(POI_CARDS_STORAGE_KEY)).toBe('{ corrupt poi cards')
    expect(snapshotStorage()).toEqual(corruptBefore)
  })

  it(
    '打开入口 → 预览 → 真实写入；打开时重读最新库；冲突后可重载并重新导入',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup()
      const existingA = makeCard('card-a', '灵隐寺', '法云弄1号', '本地版本。')
      const existing = makeRecord([existingA])
      window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'workspace-raw-sentinel')
      window.localStorage.setItem(CANDIDATES_STORAGE_KEY, 'candidates-raw-sentinel')
      window.localStorage.setItem(VERSIONS_STORAGE_KEY, 'versions-raw-sentinel')

      render(<App />)
      await screen.findByText(MOCK_TRIP.title)
      const before = snapshotStorage()

      const entry = screen.getByRole('button', { name: '资料卡备份' })
      expect(entry).toHaveAttribute('aria-expanded', 'false')
      await user.click(entry)
      expect(entry).toHaveAttribute('aria-expanded', 'true')
      let panel = screen.getByRole('region', { name: '资料卡备份与恢复' })
      expect(within(panel).getByText('当前资料卡库共 1 张卡。')).toBeInTheDocument()

      // 导出只读：一次下载，存储全键 raw 不变。
      await user.click(within(panel).getByRole('button', { name: '导出资料卡备份' }))
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(snapshotStorage()).toEqual(before)

      const incoming = makeRecord([
        makeCard('card-a-new', '灵隐寺', '法云弄1号', '文件版本。'),
        makeCard('card-b', '断桥残雪', '北山街'),
      ])
      chooseFile(backupFile(incoming, 'app-import.json'))
      const preview = await within(panel).findByRole('region', { name: '导入预览' })
      expect(preview.textContent).toContain('文件《app-import.json》：共 2 张；新增 1 张 / 已存在 1 张。')

      await user.click(within(preview).getByRole('radio', { name: '覆盖已存在（用文件版本替换本地）' }))
      await user.click(within(preview).getByRole('button', { name: '确认导入' }))

      expect(await within(panel).findByText('已导入 2 张卡（新增 1 / 覆盖 1 / 跳过 0）。')).toBeInTheDocument()
      await waitFor(() => expect(within(panel).getByText('当前资料卡库共 2 张卡。')).toBeInTheDocument())

      const stored = JSON.parse(window.localStorage.getItem(POI_CARDS_STORAGE_KEY) ?? 'null') as PoiCardsRecordV1
      expect(stored.cards.map((card) => card.id)).toEqual(['card-a-new', 'card-b'])
      expect(stored.cards[0].intro).toBe('文件版本。')

      const after = snapshotStorage()
      for (const key of [WORKSPACE_STORAGE_KEY, CANDIDATES_STORAGE_KEY, VERSIONS_STORAGE_KEY]) {
        expect(after.get(key)).toBe(before.get(key))
      }

      // 关闭后外部入口更新资料卡库；重新打开面板时应重读最新库（无需刷新页面）。
      await user.click(within(panel).getByRole('button', { name: '收起' }))
      expect(entry).toHaveAttribute('aria-expanded', 'false')
      const external = makeRecord([makeCard('card-x', '雷峰塔', '南山路', '外部版本。')])
      window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(external))

      await user.click(entry)
      panel = screen.getByRole('region', { name: '资料卡备份与恢复' })
      expect(within(panel).getByText('当前资料卡库共 1 张卡。')).toBeInTheDocument()
      expect(within(panel).queryByText('当前资料卡库共 2 张卡。')).toBeNull()

      // 打开后先预览，再由外部入口直接改 raw（不通知 App 的冻结 raw）→ 确认冲突。
      const later = makeRecord([makeCard('card-c', '苏堤', '苏堤北路')])
      chooseFile(backupFile(later, 'second.json'))
      const secondPreview = await within(panel).findByRole('region', { name: '导入预览' })
      expect(secondPreview.textContent).toContain('新增 1 张 / 已存在 0 张')

      const external2 = makeRecord([makeCard('card-y', '九溪烟树', '九溪路', '外部第二次。')])
      const external2Raw = JSON.stringify(external2)
      window.localStorage.setItem(POI_CARDS_STORAGE_KEY, external2Raw)

      await user.click(within(secondPreview).getByRole('button', { name: '确认导入' }))
      expect(await within(panel).findByText(/另一处已更新资料卡数据/)).toBeInTheDocument()
      expect(within(panel).getByText(/资料卡库已被其它入口更新/)).toBeInTheDocument()
      expect(window.localStorage.getItem(POI_CARDS_STORAGE_KEY)).toBe(external2Raw)
      expect(within(panel).getByRole('region', { name: '导入预览' })).toBeInTheDocument()

      // 冲突后本会话可恢复：重新载入 → 外部新库 → 重新预览并成功导入。
      await user.click(within(panel).getByRole('button', { name: '重新载入资料卡库' }))
      expect(within(panel).queryByRole('region', { name: '导入预览' })).toBeNull()
      expect(within(panel).getByText('当前资料卡库共 1 张卡。')).toBeInTheDocument()

      chooseFile(backupFile(later, 'second-retry.json'))
      const retryPreview = await within(panel).findByRole('region', { name: '导入预览' })
      expect(retryPreview.textContent).toContain('新增 1 张 / 已存在 0 张')
      await user.click(within(retryPreview).getByRole('button', { name: '确认导入' }))

      expect(await within(panel).findByText('已导入 1 张卡（新增 1 / 覆盖 0 / 跳过 0）。')).toBeInTheDocument()
      const recovered = JSON.parse(
        window.localStorage.getItem(POI_CARDS_STORAGE_KEY) ?? 'null',
      ) as PoiCardsRecordV1
      expect(recovered.cards.map((card) => card.id)).toEqual(['card-y', 'card-c'])
      expect(recovered.cards[0].intro).toBe('外部第二次。')

      // 冲突与恢复全程都不碰其它键。
      const afterRecovery = snapshotStorage()
      for (const key of [WORKSPACE_STORAGE_KEY, CANDIDATES_STORAGE_KEY, VERSIONS_STORAGE_KEY]) {
        expect(afterRecovery.get(key)).toBe(before.get(key))
      }
    },
  )

  it('raw 未变时打开备份面板不重置同屏资料卡的未保存编辑，且零写入', async () => {
    const user = userEvent.setup()
    const card = makeCard('card-1', '灵隐寺', '法云弄1号', '已保存介绍。')
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(makeRecord([card])))
    seedCandidate('灵隐寺')
    const before = snapshotStorage()

    render(<App />)
    await screen.findByText(MOCK_TRIP.title)
    await user.click(screen.getByRole('button', { name: '候选地点池' }))
    await user.click(await screen.findByRole('button', { name: '查看 灵隐寺 的资料卡' }))

    const intro = screen.getByLabelText(/介绍/) as HTMLTextAreaElement
    await user.clear(intro)
    await user.type(intro, '尚未保存的新介绍。')

    await user.click(screen.getByRole('button', { name: '资料卡备份' }))
    expect(screen.getByRole('region', { name: '资料卡备份与恢复' })).toBeInTheDocument()
    // 表单 state 没有被 record 引用重建触发 useEffect 重置。
    expect(screen.getByLabelText(/介绍/)).toHaveValue('尚未保存的新介绍。')
    expect(screen.getByTestId('poi-card-view')).toHaveTextContent('已保存介绍。')
    expect(snapshotStorage()).toEqual(before)
  })

  it('外部 raw 真变化后重载会同步新库，并允许重置未保存表单', async () => {
    const user = userEvent.setup()
    const card = makeCard('card-1', '灵隐寺', '法云弄1号', '本地旧介绍。')
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(makeRecord([card])))
    seedCandidate('灵隐寺')

    render(<App />)
    await screen.findByText(MOCK_TRIP.title)
    await user.click(screen.getByRole('button', { name: '候选地点池' }))
    await user.click(await screen.findByRole('button', { name: '查看 灵隐寺 的资料卡' }))

    const intro = screen.getByLabelText(/介绍/) as HTMLTextAreaElement
    await user.clear(intro)
    await user.type(intro, '本页未保存的介绍。')

    const external = makeRecord([makeCard('card-1', '灵隐寺', '法云弄1号', '外部新介绍。')])
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(external))

    await user.click(screen.getByRole('button', { name: '资料卡备份' }))
    expect(screen.getByRole('region', { name: '资料卡备份与恢复' })).toBeInTheDocument()
    expect(screen.getByText('当前资料卡库共 1 张卡。')).toBeInTheDocument()
    // raw 真变化：允许同步新库并重置同屏表单，避免用户继续编辑旧快照。
    expect(screen.getByLabelText(/介绍/)).toHaveValue('外部新介绍。')
    expect(screen.getByTestId('poi-card-view')).toHaveTextContent('外部新介绍。')
  })

  it('存储不可用后恢复：打开面板重新读取空库，不把 unavailable 当成已加载空库', async () => {
    const user = userEvent.setup()
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    try {
      render(<App />)
      await screen.findByText(MOCK_TRIP.title)
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
    }

    await user.click(screen.getByRole('button', { name: '资料卡备份' }))
    const panel = screen.getByRole('region', { name: '资料卡备份与恢复' })
    expect(within(panel).getByText('当前资料卡库共 0 张卡。')).toBeInTheDocument()
  })
})

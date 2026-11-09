/**
 * S6 资料卡备份与恢复面板测试（全离线、确定性）。
 * 覆盖：导出一次下载且零写入 / 预览与策略文案 / 取消零写入 / 三分支确认导入 /
 * 导入失败与冲突恢复 / 预览后外部保存不串状态 / 库变化后计数实时更新 /
 * 超大 file.size 读取前拒绝 / 关闭重开后旧结果不复活 / 其它存储键 raw 逐字节不变。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PoiCardBackupPanel from '../components/PoiCardBackupPanel'
import {
  MAX_POI_CARDS_BACKUP_BYTES,
  buildPoiCardBackup,
  serializePoiCardBackup,
} from '../lib/poiCardBackup'
import {
  POI_CARDS_STORAGE_KEY,
  createEmptyPoiCardsRecord,
  createPoiCard,
  loadPoiCardsRecord,
  savePoiCardsRecord,
  type PoiCardV1,
  type PoiCardsRecordV1,
  type PoiCardsSaveResult,
  type PoiCardsStorageLike,
} from '../lib/poiCards'
import { CANDIDATES_STORAGE_KEY, VERSIONS_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from '../lib/workspaceTypes'

const NOW = 1_760_000_000_000

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

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    },
  }
}

function snapshotStorage(): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index)
    if (key !== null) snapshot.set(key, window.localStorage.getItem(key) ?? '')
  }
  return snapshot
}

function expectStorageUnchanged(before: Map<string, string>): void {
  expect(snapshotStorage()).toEqual(before)
}

function backupFileOf(record: PoiCardsRecordV1, name = 'poi-backup.json'): File {
  return new File([serializePoiCardBackup(buildPoiCardBackup(record, NOW))], name, {
    type: 'application/json',
  })
}

function chooseFile(file: File): void {
  const input = screen.getByLabelText('选择资料卡备份文件') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

/**
 * 模拟父级 App：真实 savePoiCardsRecord（expectedRaw 冻结门）+ 受控 record。
 * 额外提供「外部保存成功 / 失败」按钮与显隐切换，用来验证面板不读取父级共享保存状态。
 */
function Harness({
  initial,
  storage,
  failSave = false,
  saveSpy,
  externalRecord,
  customSave,
  now = NOW + 1000,
}: {
  initial: PoiCardsRecordV1
  storage: PoiCardsStorageLike
  failSave?: boolean
  saveSpy?: (record: PoiCardsRecordV1) => void
  externalRecord?: PoiCardsRecordV1
  customSave?: (record: PoiCardsRecordV1) => Promise<PoiCardsSaveResult>
  now?: number
}) {
  const [record, setRecord] = useState<PoiCardsRecordV1 | null>(initial)
  const [visible, setVisible] = useState(true)
  const [parentStatus, setParentStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [parentMessage, setParentMessage] = useState<string | null>(null)
  const rawRef = useRef<string | null>(storage.getItem(POI_CARDS_STORAGE_KEY))

  const handleReload = () => {
    const read = loadPoiCardsRecord(storage)
    rawRef.current = read.status === 'empty' ? null : read.raw
    if (read.status === 'empty') {
      const empty = createEmptyPoiCardsRecord(now)
      setRecord(empty.ok ? empty.value : null)
    } else {
      setRecord(read.record)
    }
    setParentStatus('idle')
    setParentMessage(null)
  }

  const handleSave = async (next: PoiCardsRecordV1): Promise<PoiCardsSaveResult> => {
    saveSpy?.(next)
    if (customSave) return customSave(next)
    setParentStatus('saving')
    setParentMessage(null)
    if (failSave) {
      setParentStatus('error')
      setParentMessage('模拟写入失败。')
      return { ok: false, reason: 'unknown', message: '模拟写入失败。' }
    }
    const result = await savePoiCardsRecord(next, { storage, expectedRaw: rawRef.current })
    if (!result.ok) {
      setParentStatus('error')
      setParentMessage(result.message)
      return result
    }
    rawRef.current = result.raw
    setRecord(result.record)
    setParentStatus('saved')
    setParentMessage(`已保存资料卡（${result.record.cards.length} 张，${result.bytes} 字节）。`)
    return result
  }

  const handleExternalSave = () => {
    if (!externalRecord) return
    setParentStatus('saving')
    setParentMessage(null)
    void savePoiCardsRecord(externalRecord, { storage, expectedRaw: rawRef.current }).then((result) => {
      if (!result.ok) {
        setParentStatus('error')
        setParentMessage(result.message)
        return
      }
      rawRef.current = result.raw
      setRecord(result.record)
      setParentStatus('saved')
      setParentMessage(`已保存资料卡（${result.record.cards.length} 张，${result.bytes} 字节）。`)
    })
  }

  return (
    <div>
      <button type="button" onClick={() => setVisible((value) => !value)}>
        切换测试面板
      </button>
      {externalRecord ? (
        <button type="button" onClick={handleExternalSave}>
          外部保存成功
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setParentStatus('error')
          setParentMessage('外部保存失败。')
        }}
      >
        外部保存失败
      </button>
      <p data-testid="parent-status">
        {parentStatus}:{parentMessage ?? ''}
      </p>
      {visible ? (
        <PoiCardBackupPanel
          record={record}
          now={() => now}
          onSave={handleSave}
          onReload={handleReload}
          onClose={() => {}}
        />
      ) : null}
    </div>
  )
}

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
let clickedDownload: string | null

beforeEach(() => {
  window.localStorage.clear()
  createObjectURL = vi.fn(() => 'blob:poi-backup')
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
  clickedDownload = null
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clickedDownload = this.download
  })
})

afterEach(() => {
  cleanup()
  const urlStatics = URL as unknown as Record<string, unknown>
  delete urlStatics.createObjectURL
  delete urlStatics.revokeObjectURL
  vi.restoreAllMocks()
})

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 失败'))
    reader.readAsText(blob)
  })
}

describe('PoiCardBackupPanel · 导出', () => {
  it('点击导出只触发一次下载，文件只含卡片数据，所有存储键 raw 前后全等', async () => {
    const user = userEvent.setup()
    const record = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(record))
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'workspace-raw-sentinel')
    window.localStorage.setItem(CANDIDATES_STORAGE_KEY, 'candidates-raw-sentinel')
    window.localStorage.setItem(VERSIONS_STORAGE_KEY, 'versions-raw-sentinel')
    const before = snapshotStorage()

    render(<Harness initial={record} storage={window.localStorage} />)
    expect(createObjectURL).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '导出资料卡备份' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:poi-backup')
    expect(clickedDownload).toBe('travel-assistant-poi-cards-2025-10-09.json')

    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('application/json;charset=utf-8')
    const text = await readBlob(blob)
    const parsed = JSON.parse(text) as { version: number; exportedAt: string; cards: PoiCardV1[] }
    expect(parsed.version).toBe(1)
    expect(parsed.exportedAt).toBe(new Date(NOW + 1000).toISOString())
    expect(parsed.cards).toEqual(record.cards)
    expect(text).not.toContain('workspace-raw-sentinel')
    expect(text).not.toContain('candidates-raw-sentinel')
    expect(text).not.toContain('versions-raw-sentinel')

    expect(await screen.findByText(/已开始下载 travel-assistant-poi-cards-2025-10-09\.json/)).toBeInTheDocument()
    expectStorageUnchanged(before)
  })

  it('资料卡库为 null 时导出禁用并说明，不创建文件', () => {
    render(
      <PoiCardBackupPanel
        record={null}
        onSave={async () => ({ ok: false, reason: 'unknown', message: '未使用' })}
        onReload={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '导出资料卡备份' })).toBeDisabled()
    expect(screen.getByText('资料卡库当前不可用或未能读取，暂时不能导出。')).toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})

describe('PoiCardBackupPanel · 导入预览与取消', () => {
  it('合法文件显示卡数、分组名称与新增/已存在计数；切换策略文案变化；取消零写入', async () => {
    const user = userEvent.setup()
    const existing = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    const incoming = makeRecord([
      makeCard('card-a-new', '灵隐寺', '法云弄1号', '文件版本。'),
      makeCard('card-b', '断桥残雪', '北山街'),
      makeCard('card-c', '雷峰塔', '南山路'),
    ])
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'workspace-raw-sentinel')
    const before = snapshotStorage()

    render(<Harness initial={existing} storage={window.localStorage} />)
    chooseFile(backupFileOf(incoming, 'my-cards.json'))

    const preview = await screen.findByRole('region', { name: '导入预览' })
    expect(preview.textContent).toContain('文件《my-cards.json》：共 3 张；新增 2 张 / 已存在 1 张。')
    const groups = within(preview)
    expect(groups.getByText('断桥残雪')).toBeInTheDocument()
    expect(groups.getByText('雷峰塔')).toBeInTheDocument()
    expect(groups.getByText('灵隐寺')).toBeInTheDocument()
    expect(groups.getByRole('radio', { name: '跳过已存在（保留本地版本）' })).toBeChecked()
    expect(groups.queryByText(/覆盖将替换已存在的/)).toBeNull()

    await user.click(groups.getByRole('radio', { name: '覆盖已存在（用文件版本替换本地）' }))
    expect(groups.getByText('覆盖将替换已存在的 1 张卡；其它卡保持不变。确认前不会写入。')).toBeInTheDocument()

    await user.click(groups.getByRole('button', { name: '取消导入' }))
    expect(screen.queryByRole('region', { name: '导入预览' })).toBeNull()
    expectStorageUnchanged(before)
  })

  it('坏文件与版本不兼容 → typed 错误、无预览、旧库 raw 不变', async () => {
    const existing = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))
    const before = snapshotStorage()
    render(<Harness initial={existing} storage={window.localStorage} />)

    chooseFile(new File(['{ broken json'], 'broken.json', { type: 'application/json' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('备份文件不是有效的 JSON')
    expect(screen.queryByRole('region', { name: '导入预览' })).toBeNull()
    expectStorageUnchanged(before)

    chooseFile(
      new File(
        [JSON.stringify({ version: 2, exportedAt: new Date(NOW).toISOString(), cards: existing.cards })],
        'v2.json',
        { type: 'application/json' },
      ),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('版本不是 1')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('不会自动迁移'))
    expect(screen.queryByRole('region', { name: '导入预览' })).toBeNull()
    expectStorageUnchanged(before)
  })

  it('超大 file.size 在读取前直接 typed 拒绝，不调用文件读取', async () => {
    const existing = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))
    const before = snapshotStorage()
    render(<Harness initial={existing} storage={window.localStorage} />)

    const file = new File(['{}'], 'huge.json', { type: 'application/json' })
    const textSpy = vi.fn(async () => '{}')
    Object.defineProperty(file, 'text', { configurable: true, value: textSpy })
    Object.defineProperty(file, 'size', { configurable: true, value: MAX_POI_CARDS_BACKUP_BYTES + 1 })
    const readSpy = vi.spyOn(FileReader.prototype, 'readAsText')

    chooseFile(file)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `备份文件超过 ${MAX_POI_CARDS_BACKUP_BYTES} 字节的 UTF-8 上限（实际 ${MAX_POI_CARDS_BACKUP_BYTES + 1} 字节），没有读取`,
    )
    expect(textSpy).not.toHaveBeenCalled()
    expect(readSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: '导入预览' })).toBeNull()
    expectStorageUnchanged(before)
  })
})

describe('PoiCardBackupPanel · 确认导入', () => {
  it('skip：保留本地已存在卡，只追加新增，并给出三分支统计', async () => {
    const user = userEvent.setup()
    const existingA = makeCard('card-a', '灵隐寺', '法云弄1号', '本地版本。')
    const existing = makeRecord([existingA])
    const incoming = makeRecord([
      makeCard('card-a-new', '灵隐寺', '法云弄1号', '文件版本。'),
      makeCard('card-b', '断桥残雪', '北山街'),
      makeCard('card-c', '雷峰塔', '南山路'),
    ])
    const { storage, map } = memoryStorage()
    map.set(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'workspace-raw-sentinel')
    const before = snapshotStorage()

    render(<Harness initial={existing} storage={storage} />)
    chooseFile(backupFileOf(incoming))
    const preview = await screen.findByRole('region', { name: '导入预览' })
    await user.click(within(preview).getByRole('button', { name: '确认导入' }))

    expect(await screen.findByText('已导入 3 张卡（新增 2 / 覆盖 0 / 跳过 1）。')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('region', { name: '导入预览' })).toBeNull())
    const stored = loadPoiCardsRecord(storage)
    expect(stored.status).toBe('ok')
    expect(stored.record?.cards.map((card) => card.id)).toEqual(['card-a', 'card-b', 'card-c'])
    expect(stored.record?.cards[0].intro).toBe('本地版本。')
    expectStorageUnchanged(before)
  })

  it('overwrite：用文件版本替换同 identityKey 的本地卡，保留其它卡', async () => {
    const user = userEvent.setup()
    const existing = makeRecord([
      makeCard('card-a', '灵隐寺', '法云弄1号', '本地版本。'),
      makeCard('card-b', '断桥残雪', '北山街', '本地另一张。'),
    ])
    const incoming = makeRecord([
      makeCard('card-a-new', '灵隐寺', '法云弄1号', '文件版本。'),
      makeCard('card-c', '雷峰塔', '南山路'),
    ])
    const { storage, map } = memoryStorage()
    map.set(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))

    render(<Harness initial={existing} storage={storage} />)
    chooseFile(backupFileOf(incoming))
    const preview = await screen.findByRole('region', { name: '导入预览' })
    await user.click(within(preview).getByRole('radio', { name: '覆盖已存在（用文件版本替换本地）' }))
    await user.click(within(preview).getByRole('button', { name: '确认导入' }))

    expect(await screen.findByText('已导入 2 张卡（新增 1 / 覆盖 1 / 跳过 0）。')).toBeInTheDocument()
    const stored = loadPoiCardsRecord(storage)
    expect(stored.record?.cards.map((card) => card.id)).toEqual(['card-a-new', 'card-b', 'card-c'])
    expect(stored.record?.cards[0].intro).toBe('文件版本。')
    expect(stored.record?.cards[1].intro).toBe('本地另一张。')
  })

  it('导入失败：只显示本次 onSave 结果，保留预览与旧库字节', async () => {
    const user = userEvent.setup()
    const existing = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    const incoming = makeRecord([makeCard('card-b', '断桥残雪', '北山街')])
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))
    const before = snapshotStorage()

    render(<Harness initial={existing} storage={window.localStorage} failSave />)
    chooseFile(backupFileOf(incoming))
    const preview = await screen.findByRole('region', { name: '导入预览' })
    await user.click(within(preview).getByRole('button', { name: '确认导入' }))

    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((alert) => alert.textContent?.includes('导入失败：模拟写入失败'))).toBe(true)
    expect(alerts.some((alert) => alert.textContent?.includes('资料卡库原字节未改动'))).toBe(true)
    expect(screen.getByRole('region', { name: '导入预览' })).toBeInTheDocument()
    expectStorageUnchanged(before)
  })

  it('冲突后显示重新载入入口：重载到外部新库、清空预览，重新选文件可成功导入', async () => {
    const user = userEvent.setup()
    const existing = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    const incoming = makeRecord([makeCard('card-b', '断桥残雪', '北山街')])
    const external = makeRecord([makeCard('card-x', '雷峰塔', '南山路', '外部版本。')])
    const { storage, map } = memoryStorage()
    map.set(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))

    render(<Harness initial={existing} storage={storage} />)
    chooseFile(backupFileOf(incoming))
    const preview = await screen.findByRole('region', { name: '导入预览' })

    // 外部入口直接写入存储（不通知父级 rawRef）→ 确认时 expectedRaw 冲突。
    const externalRaw = JSON.stringify(external)
    storage.setItem(POI_CARDS_STORAGE_KEY, externalRaw)
    await user.click(within(preview).getByRole('button', { name: '确认导入' }))

    expect(await screen.findByText(/资料卡库已被其它入口更新/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新载入资料卡库' })).toBeInTheDocument()
    expect(storage.getItem(POI_CARDS_STORAGE_KEY)).toBe(externalRaw)
    expect(screen.getByRole('region', { name: '导入预览' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重新载入资料卡库' }))
    expect(screen.queryByRole('region', { name: '导入预览' })).toBeNull()
    expect(screen.getByText('当前资料卡库共 1 张卡。')).toBeInTheDocument()

    // 重新选择同一个文件：此时按外部新库预览，新增 1；确认后真实写入。
    chooseFile(backupFileOf(incoming))
    const secondPreview = await screen.findByRole('region', { name: '导入预览' })
    expect(secondPreview.textContent).toContain('新增 1 张 / 已存在 0 张')
    await user.click(within(secondPreview).getByRole('button', { name: '确认导入' }))

    expect(await screen.findByText('已导入 1 张卡（新增 1 / 覆盖 0 / 跳过 0）。')).toBeInTheDocument()
    const stored = loadPoiCardsRecord(storage)
    expect(stored.record?.cards.map((card) => card.id)).toEqual(['card-x', 'card-b'])
  })

  it('预览后别处保存成功/失败不会清空预览，也不显示导入成功/失败', async () => {
    const user = userEvent.setup()
    const existing = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    const external = makeRecord([
      makeCard('card-a', '灵隐寺', '法云弄1号'),
      makeCard('card-e', '苏堤', '苏堤北路'),
    ])
    const incoming = makeRecord([makeCard('card-b', '断桥残雪', '北山街')])
    const { storage, map } = memoryStorage()
    map.set(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))

    render(<Harness initial={existing} storage={storage} externalRecord={external} />)
    chooseFile(backupFileOf(incoming))
    await screen.findByRole('region', { name: '导入预览' })

    await user.click(screen.getByRole('button', { name: '外部保存成功' }))
    await waitFor(() =>
      expect(screen.getByTestId('parent-status').textContent).toContain('saved:'),
    )
    expect(screen.getByRole('region', { name: '导入预览' })).toBeInTheDocument()
    expect(screen.queryByText(/已导入 \d+ 张卡/)).toBeNull()
    expect(screen.queryByText(/导入失败：/)).toBeNull()
    expect(screen.getByText(/资料卡库已更新，请核对/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '外部保存失败' }))
    expect(screen.getByTestId('parent-status').textContent).toContain('error:外部保存失败。')
    expect(screen.getByRole('region', { name: '导入预览' })).toBeInTheDocument()
    expect(screen.queryByText(/已导入 \d+ 张卡/)).toBeNull()
    expect(screen.queryByText(/导入失败：/)).toBeNull()
  })

  it('预览后库新增同 identityKey 卡：覆盖计数实时更新，确认使用最新 plan', async () => {
    const user = userEvent.setup()
    const existing = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    const external = makeRecord([
      makeCard('card-a', '灵隐寺', '法云弄1号'),
      makeCard('card-external-b', '断桥残雪', '北山街', '外部版本。'),
    ])
    const incoming = makeRecord([makeCard('card-b', '断桥残雪', '北山街', '文件版本。')])
    const { storage, map } = memoryStorage()
    map.set(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))

    render(<Harness initial={existing} storage={storage} externalRecord={external} />)
    chooseFile(backupFileOf(incoming))
    let preview = await screen.findByRole('region', { name: '导入预览' })
    expect(preview.textContent).toContain('新增 1 张 / 已存在 0 张')
    await user.click(within(preview).getByRole('radio', { name: '覆盖已存在（用文件版本替换本地）' }))
    expect(within(preview).getByText('覆盖将替换已存在的 0 张卡；其它卡保持不变。确认前不会写入。')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '外部保存成功' }))
    await waitFor(() =>
      expect(screen.getByTestId('parent-status').textContent).toContain('saved:'),
    )

    preview = screen.getByRole('region', { name: '导入预览' })
    expect(preview.textContent).toContain('新增 0 张 / 已存在 1 张')
    expect(within(preview).getByText('覆盖将替换已存在的 1 张卡；其它卡保持不变。确认前不会写入。')).toBeInTheDocument()
    expect(within(preview).getByText(/资料卡库已更新，请核对/)).toBeInTheDocument()

    await user.click(within(preview).getByRole('button', { name: '确认导入' }))
    expect(await screen.findByText('已导入 1 张卡（新增 0 / 覆盖 1 / 跳过 0）。')).toBeInTheDocument()
    const stored = loadPoiCardsRecord(storage)
    expect(stored.record?.cards.map((card) => card.id)).toEqual(['card-a', 'card-b'])
    expect(stored.record?.cards[1].intro).toBe('文件版本。')
  })

  it('关闭再打开面板：旧导入结果与预览不复活', async () => {
    const user = userEvent.setup()
    const existing = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    const incoming = makeRecord([makeCard('card-b', '断桥残雪', '北山街')])
    const { storage, map } = memoryStorage()
    map.set(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))

    render(<Harness initial={existing} storage={storage} />)
    chooseFile(backupFileOf(incoming))
    const preview = await screen.findByRole('region', { name: '导入预览' })
    await user.click(within(preview).getByRole('button', { name: '确认导入' }))
    expect(await screen.findByText('已导入 1 张卡（新增 1 / 覆盖 0 / 跳过 0）。')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '切换测试面板' }))
    expect(screen.queryByRole('region', { name: '资料卡备份与恢复' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '切换测试面板' }))

    expect(screen.getByRole('region', { name: '资料卡备份与恢复' })).toBeInTheDocument()
    expect(screen.queryByText(/已导入 \d+ 张卡/)).toBeNull()
    expect(screen.queryByRole('region', { name: '导入预览' })).toBeNull()
  })

  it('保存进行中关闭面板：迟到的结果不会在重新打开后复活', async () => {
    const user = userEvent.setup()
    const existing = makeRecord([makeCard('card-a', '灵隐寺', '法云弄1号')])
    const incoming = makeRecord([makeCard('card-b', '断桥残雪', '北山街')])
    const { storage, map } = memoryStorage()
    map.set(POI_CARDS_STORAGE_KEY, JSON.stringify(existing))

    let resolveSave: (result: PoiCardsSaveResult) => void = () => {}
    const customSave = () =>
      new Promise<PoiCardsSaveResult>((resolve) => {
        resolveSave = resolve
      })

    render(<Harness initial={existing} storage={storage} customSave={customSave} />)
    chooseFile(backupFileOf(incoming))
    const preview = await screen.findByRole('region', { name: '导入预览' })
    await user.click(within(preview).getByRole('button', { name: '确认导入' }))
    expect(await screen.findByText('正在写入资料卡库…')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '切换测试面板' }))
    expect(screen.queryByRole('region', { name: '资料卡备份与恢复' })).toBeNull()

    const savedRecord = makeRecord([...existing.cards, ...incoming.cards])
    resolveSave({
      ok: true,
      record: savedRecord,
      raw: JSON.stringify(savedRecord),
      bytes: 1,
    })

    await user.click(screen.getByRole('button', { name: '切换测试面板' }))
    expect(screen.getByRole('region', { name: '资料卡备份与恢复' })).toBeInTheDocument()
    expect(screen.queryByText(/已导入 \d+ 张卡/)).toBeNull()
    expect(screen.queryByText('正在写入资料卡库…')).toBeNull()
  })
})

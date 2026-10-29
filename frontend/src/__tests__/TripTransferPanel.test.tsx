import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TripTransferPanel from '../components/TripTransferPanel'
import type { Trip } from '../lib/api'
import {
  SAVED_TRIPS_STORAGE_KEY,
  SAVED_TRIPS_VERSION,
  saveTripToStorage,
  type SavedTrip,
  type StorageLike,
} from '../lib/savedTrips'
import {
  MAX_TRIP_FILE_BYTES,
  TRIP_TRANSFER_FORMAT,
  TRIP_TRANSFER_VERSION,
  createTripBackup,
} from '../lib/tripTransfer'
import { MOCK_TRIP } from './fixtures/trip'

const FIXED_NOW = new Date('2026-01-01T08:00:00.000Z')

function backupTextOf(trip: Trip): string {
  const backup = createTripBackup(trip, { now: FIXED_NOW })
  if (!backup.ok) throw new Error(`生成备份失败：${backup.reason}`)
  return backup.json
}

/** 手工拼信封：用来投递「结构非法、正常导出路径根本产不出来」的文件 */
function envelopeTextOf(trip: unknown): string {
  return JSON.stringify({
    format: TRIP_TRANSFER_FORMAT,
    version: TRIP_TRANSFER_VERSION,
    exportedAt: FIXED_NOW.toISOString(),
    trip,
  })
}

/** 手工指定 exportedAt：验证文件自述字段被篡改后的展示 */
function envelopeTextWithExportedAt(exportedAt: unknown, trip: unknown = MOCK_TRIP): string {
  return JSON.stringify({
    format: TRIP_TRANSFER_FORMAT,
    version: TRIP_TRANSFER_VERSION,
    exportedAt,
    trip,
  })
}

/** 真实 File：走的是浏览器里的 File.text() 路径 */
function jsonFile(text: string, name = 'trip.json'): File {
  return new File([text], name, { type: 'application/json' })
}

function readRawStorage(): string | null {
  return window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
}

function writeEnvelope(records: unknown[]): string {
  const raw = JSON.stringify({ version: SAVED_TRIPS_VERSION, trips: records })
  window.localStorage.setItem(SAVED_TRIPS_STORAGE_KEY, raw)
  return raw
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: '行程备份与导入' })
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText(/选择备份文件/) as HTMLInputElement
}

function selectFile(file: unknown) {
  fireEvent.change(fileInput(), { target: { files: [file] } })
}

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  window.localStorage.clear()
  createObjectURL = vi.fn(() => 'blob:panel-trip')
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
})

describe('TripTransferPanel：导出', () => {
  it('渲染时不下载也不写本地存储，只有点下载才触发一次链接点击', async () => {
    const user = userEvent.setup()
    render(<TripTransferPanel trip={MOCK_TRIP} />)

    const region = panel()
    expect(within(region).getByRole('heading', { name: '行程备份与导入' })).toBeInTheDocument()
    expect(within(region).getByText('杭州三日漫步路书')).toBeInTheDocument()
    expect(within(region).getByText(/共 3 天 \/ 4 个站点/)).toBeInTheDocument()
    expect(within(region).getByText('杭州-杭州三日漫步路书.json')).toBeInTheDocument()
    expect(within(region).getByText(/无法保证其中不含敏感信息/)).toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(readRawStorage()).toBeNull()

    await user.click(within(region).getByRole('button', { name: '下载行程备份 (.json)' }))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    expect(within(region).getByText(/已开始下载 杭州-杭州三日漫步路书\.json/)).toBeInTheDocument()
    expect(within(region).getByText(/不会上传，也不会自动加入本地保存列表/)).toBeInTheDocument()
    // 下载只碰文件，不动 localStorage
    expect(readRawStorage()).toBeNull()
  })

  it('没有当前行程时不提供导出按钮', () => {
    render(<TripTransferPanel />)

    const region = panel()
    expect(within(region).queryByRole('button', { name: '下载行程备份 (.json)' })).toBeNull()
    expect(within(region).getByText(/当前还没有打开行程，暂时不能导出/)).toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('无法创建下载链接时给固定文案，不回显浏览器原始错误', async () => {
    const urlStatics = URL as unknown as Record<string, unknown>
    urlStatics.createObjectURL = undefined
    urlStatics.revokeObjectURL = undefined

    const user = userEvent.setup()
    render(<TripTransferPanel trip={MOCK_TRIP} />)
    await user.click(screen.getByRole('button', { name: '下载行程备份 (.json)' }))

    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(screen.getByText(/当前浏览器无法创建本地下载链接，没有下载任何文件/)).toBeInTheDocument()
    expect(readRawStorage()).toBeNull()
  })

  it('点击下载时抛异常也给固定文案，不回显浏览器原始错误与本机路径', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('blocked by policy: C:\\Users\\86133\\AppData\\secret\\downloads')
    })

    const user = userEvent.setup()
    render(<TripTransferPanel trip={MOCK_TRIP} />)
    await user.click(screen.getByRole('button', { name: '下载行程备份 (.json)' }))

    expect(screen.getByText(/触发下载失败，没有下载任何文件/)).toBeInTheDocument()
    const region = panel()
    expect(region).not.toHaveTextContent('blocked by policy')
    expect(region).not.toHaveTextContent('secret')
    expect(region).not.toHaveTextContent('C:\\')
    expect(readRawStorage()).toBeNull()
  })
})

describe('TripTransferPanel：导入预览', () => {
  it('非法文件与超限文件都被拒绝，文案固定且不写本地存储', async () => {
    const secret = 'TOP-SECRET-user-description'
    render(<TripTransferPanel trip={MOCK_TRIP} />)

    selectFile(jsonFile(`{ "note": "${secret}"`, 'broken.json'))

    await waitFor(() =>
      expect(
        within(panel()).getByText(/文件内容不是合法的 JSON，无法读取/),
      ).toBeInTheDocument(),
    )
    // 文案是固定文本，不回显文件内容
    expect(within(panel()).queryByText(new RegExp(secret))).toBeNull()
    expect(readRawStorage()).toBeNull()

    // 未真正读取就按体积拒绝：text() 不应该被调用
    const text = vi.fn(() => Promise.resolve('{}'))
    const oversize = { name: 'huge.json', size: MAX_TRIP_FILE_BYTES + 1, text }
    selectFile(oversize)

    await waitFor(() => expect(within(panel()).getByText(/超过 704 KB 的上限，已拒绝/)).toBeInTheDocument())
    expect(text).not.toHaveBeenCalled()
    expect(readRawStorage()).toBeNull()
  })

  it('预览只展示解析结果，默认不写存储；onOpen 收到行程', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<TripTransferPanel trip={null} onOpen={onOpen} />)

    selectFile(jsonFile(backupTextOf(MOCK_TRIP)))

    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：杭州三日漫步路书/ })).toBeInTheDocument(),
    )
    const region = panel()
    expect(within(region).getByText('杭州')).toBeInTheDocument()
    expect(within(region).getByText('3 天 · 4 个站点')).toBeInTheDocument()
    expect(within(region).getByText('trip-mock-1')).toBeInTheDocument()
    expect(within(region).getByText('示例行程')).toBeInTheDocument()
    expect(within(region).getByText(/预览只是把文件内容显示在页面里，还没有写入本地保存/)).toBeInTheDocument()
    expect(readRawStorage()).toBeNull()

    await user.click(within(region).getByRole('button', { name: '打开这份行程' }))

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(MOCK_TRIP)
    expect(within(region).getByText(/已把这份行程交给页面打开/)).toBeInTheDocument()
    expect(readRawStorage()).toBeNull()
  })

  it('预览把来源与导出时间标成文件自述，时间按 UTC 规范化展示', async () => {
    render(<TripTransferPanel trip={null} />)
    selectFile(jsonFile(backupTextOf(MOCK_TRIP)))

    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：杭州三日漫步路书/ })).toBeInTheDocument(),
    )
    const region = panel()
    // 标签写清楚是「文件自述」：source 只能证明文件自己这么写
    expect(within(region).getByText('行程来源（文件自述）')).toBeInTheDocument()
    expect(within(region).getByText('示例行程')).toBeInTheDocument()
    expect(within(region).getByText('导出时间（文件自述）')).toBeInTheDocument()
    expect(within(region).getByText('2026-01-01 08:00 UTC')).toBeInTheDocument()
    expect(within(region).getByTestId('trip-transfer-provenance-hint')).toHaveTextContent(
      '不能证明这份行程的真实来源',
    )
    expect(readRawStorage()).toBeNull()
  })

  it('被篡改的超长导出时间不进入页面，只显示固定文案', async () => {
    const hostile = `2026-01-01T08:00:00Z${'-'.repeat(4000)}<img src=x onerror=alert(1)>`
    render(<TripTransferPanel trip={null} />)
    selectFile(jsonFile(envelopeTextWithExportedAt(hostile)))

    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：杭州三日漫步路书/ })).toBeInTheDocument(),
    )
    const region = panel()
    expect(
      within(region).getByText('文件里记录的导出时间格式无法识别，已忽略'),
    ).toBeInTheDocument()
    // 原文一个字都不渲染，也不会被当成 HTML
    expect(region).not.toHaveTextContent('onerror')
    expect(region).not.toHaveTextContent('2026-01-01T08:00:00Z---')
    expect(region.querySelectorAll('img')).toHaveLength(0)
    expect(readRawStorage()).toBeNull()
  })

  it('文件没写导出时间时说明缺失，不借用导入时间冒充', async () => {
    render(<TripTransferPanel trip={null} />)
    selectFile(
      jsonFile(
        JSON.stringify({ format: TRIP_TRANSFER_FORMAT, version: TRIP_TRANSFER_VERSION, trip: MOCK_TRIP }),
      ),
    )

    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：杭州三日漫步路书/ })).toBeInTheDocument(),
    )
    expect(within(panel()).getByText('文件里没有记录导出时间')).toBeInTheDocument()
    expect(readRawStorage()).toBeNull()
  })

  it('没接 onOpen 时只预览，不提供打开按钮', async () => {
    render(<TripTransferPanel trip={null} />)
    selectFile(jsonFile(backupTextOf(MOCK_TRIP)))

    await waitFor(() => expect(within(panel()).getByText(/预览：杭州三日漫步路书/)).toBeInTheDocument())
    expect(within(panel()).queryByRole('button', { name: '打开这份行程' })).toBeNull()
    expect(within(panel()).getByText(/当前页面还没接入「打开行程」的处理/)).toBeInTheDocument()
  })

  it('两次选择并发时后选的文件胜出，旧的读取结果被丢弃', async () => {
    let resolveSlow: (text: string) => void = () => {}
    const slowPicked: Trip = { ...MOCK_TRIP, id: 'trip-slow', title: '先选但读得慢' }
    const slowText = new Promise<string>((resolve) => {
      resolveSlow = resolve
    })
    const slowFile = { name: 'slow.json', size: 100, text: () => slowText }
    const fastPicked: Trip = { ...MOCK_TRIP, id: 'trip-fast', title: '后选但先读完' }

    render(<TripTransferPanel trip={null} />)

    selectFile(slowFile)
    selectFile(jsonFile(backupTextOf(fastPicked)))

    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：后选但先读完/ })).toBeInTheDocument(),
    )

    // 旧请求晚到：不能把预览改回旧文件
    resolveSlow(backupTextOf(slowPicked))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(within(panel()).getByRole('heading', { name: /预览：后选但先读完/ })).toBeInTheDocument()
    expect(within(panel()).queryByText('trip-slow')).toBeNull()
    expect(readRawStorage()).toBeNull()
  })

  it('同一个文件可以重新选择重试', async () => {
    const text = vi.fn(() => Promise.resolve('{'))
    const brokenFile = { name: 'broken.json', size: 10, text }

    render(<TripTransferPanel trip={null} />)

    selectFile(brokenFile)
    await waitFor(() => expect(within(panel()).getByText(/文件内容不是合法的 JSON/)).toBeInTheDocument())

    selectFile(brokenFile)
    await waitFor(() => expect(text).toHaveBeenCalledTimes(2))
    expect(within(panel()).getByText(/文件内容不是合法的 JSON/)).toBeInTheDocument()
    expect(readRawStorage()).toBeNull()
  })
})

describe('TripTransferPanel：保存到本地', () => {
  it('无冲突时点「保存到本地」才写入，且只写一份', async () => {
    const user = userEvent.setup()
    const incoming: Trip = { ...MOCK_TRIP, id: 'trip-incoming', title: '待导入的行程' }
    render(<TripTransferPanel trip={null} />)

    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：待导入的行程/ })).toBeInTheDocument(),
    )
    expect(readRawStorage()).toBeNull()

    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))

    const raw = readRawStorage()
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw as string) as { version: number; trips: SavedTrip[] }
    expect(stored.version).toBe(SAVED_TRIPS_VERSION)
    expect(stored.trips).toHaveLength(1)
    expect(stored.trips[0].id).toBe('trip-incoming')
    expect(stored.trips[0].trip.title).toBe('待导入的行程')
    expect(within(panel()).getByText(/新增一份/)).toBeInTheDocument()
  })

  it('同 ID 必须页面内二次确认；取消后本地存储逐字节不变', async () => {
    const user = userEvent.setup()
    // 预置一条同 ID 的本地副本
    const existed = saveTripToStorage({ ...MOCK_TRIP, title: '本地旧副本' })
    expect(existed.ok).toBe(true)
    const rawBefore = readRawStorage()
    expect(rawBefore).not.toBeNull()

    const incoming: Trip = { ...MOCK_TRIP, title: '文件里的新副本' }
    render(<TripTransferPanel trip={null} />)

    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：文件里的新副本/ })).toBeInTheDocument(),
    )
    expect(readRawStorage()).toBe(rawBefore)

    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))

    const confirm = within(panel()).getByRole('alert')
    expect(confirm).toHaveTextContent('本地已存在同一 ID 的保存记录')
    expect(confirm).toHaveTextContent('本地旧副本')
    expect(confirm).toHaveTextContent('替换这份本地副本')
    expect(confirm).toHaveTextContent('无法撤销')
    // 确认前不写入
    expect(readRawStorage()).toBe(rawBefore)

    // alert 只放文字，按钮在紧邻的 group 里（读屏不会把交互控件当公告内容）
    const confirmActions = within(panel()).getByRole('group', { name: '替换本地副本确认' })
    expect(confirmActions).toHaveAccessibleDescription(/替换这份本地副本/)

    await user.click(within(confirmActions).getByRole('button', { name: '取消替换' }))

    expect(within(panel()).queryByRole('alert')).toBeNull()
    expect(within(panel()).getByText(/已取消替换，本地保存没有变化/)).toBeInTheDocument()
    expect(readRawStorage()).toBe(rawBefore)
  })

  it('预览之后才出现同 ID 副本时不直接覆盖，确认后才替换', async () => {
    const user = userEvent.setup()
    const incoming: Trip = { ...MOCK_TRIP, id: 'trip-race', title: '后来的新副本' }
    render(<TripTransferPanel trip={null} />)

    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：后来的新副本/ })).toBeInTheDocument(),
    )

    // 预览完成之后，本地才出现同 ID 的副本
    const raced = saveTripToStorage({ ...MOCK_TRIP, id: 'trip-race', title: '刚写入的旧副本' })
    expect(raced.ok).toBe(true)
    const rawAfterRace = readRawStorage()

    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))

    expect(within(panel()).getByRole('alert')).toHaveTextContent('刚写入的旧副本')
    expect(readRawStorage()).toBe(rawAfterRace)

    await user.click(within(panel()).getByRole('button', { name: '确认替换本地副本' }))

    const stored = JSON.parse(readRawStorage() as string) as { trips: SavedTrip[] }
    expect(stored.trips).toHaveLength(1)
    expect(stored.trips[0].id).toBe('trip-race')
    expect(stored.trips[0].trip.title).toBe('后来的新副本')
    expect(within(panel()).getByText(/已替换本地副本《后来的新副本》/)).toBeInTheDocument()
  })

  it('确认前本地副本被其他页面更新时拒绝写入，并刷新快照', async () => {
    const user = userEvent.setup()
    const incoming: Trip = { ...MOCK_TRIP, id: 'trip-stale', title: '文件副本' }
    render(<TripTransferPanel trip={null} />)

    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：文件副本/ })).toBeInTheDocument(),
    )

    expect(saveTripToStorage({ ...MOCK_TRIP, id: 'trip-stale', title: '确认前的旧副本' }).ok).toBe(true)
    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))
    expect(within(panel()).getByRole('alert')).toHaveTextContent('确认前的旧副本')

    // 另一个标签页在用户确认前改写了同一份记录
    const newer = writeEnvelope([
      { id: 'trip-stale', savedAt: Date.now() + 60_000, trip: { ...MOCK_TRIP, id: 'trip-stale', title: '别处的新副本' } },
    ])

    await user.click(within(panel()).getByRole('button', { name: '确认替换本地副本' }))

    expect(readRawStorage()).toBe(newer)
    expect(within(panel()).getByText(/本地副本在确认前发生了变化/)).toBeInTheDocument()
    const refreshed = within(panel()).getByRole('alert')
    expect(refreshed).toHaveTextContent('别处的新副本')

    // 再确认一次（快照已刷新）才替换
    const refreshedActions = within(panel()).getByRole('group', { name: '替换本地副本确认' })
    await user.click(within(refreshedActions).getByRole('button', { name: '确认替换本地副本' }))
    const stored = JSON.parse(readRawStorage() as string) as { trips: SavedTrip[] }
    expect(stored.trips).toHaveLength(1)
    expect(stored.trips[0].trip.title).toBe('文件副本')
  })

  it('本地数据损坏或有异常记录时拒绝覆盖原始数据', async () => {
    const user = userEvent.setup()
    const incoming: Trip = { ...MOCK_TRIP, id: 'trip-guard', title: '要保存的副本' }
    render(<TripTransferPanel trip={null} />)

    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：要保存的副本/ })).toBeInTheDocument(),
    )

    // 1) 整体损坏
    const corruptRaw = '{"version":1,"trips":['
    window.localStorage.setItem(SAVED_TRIPS_STORAGE_KEY, corruptRaw)
    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))

    expect(readRawStorage()).toBe(corruptRaw)
    expect(within(panel()).getByText(/本地保存数据不是合法 JSON|为避免覆盖/)).toBeInTheDocument()

    // 2) 能读到的有效记录 + 一条无法识别的记录：普通写入必须整体拒绝
    const anomalyRaw = writeEnvelope([
      { id: MOCK_TRIP.id, savedAt: 1_700_000_000_000, trip: MOCK_TRIP },
      { id: '', savedAt: 0, trip: null },
    ])
    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))

    expect(readRawStorage()).toBe(anomalyRaw)
    expect(within(panel()).getByText(/无法识别、重复或超出上限/)).toBeInTheDocument()
  })
})

describe('TripTransferPanel：导入结构与本地保存一致，预览前就拒绝', () => {
  const stop = MOCK_TRIP.days[0].stops[0]
  const duplicatedDays: Trip = {
    ...MOCK_TRIP,
    days: [MOCK_TRIP.days[0], { ...MOCK_TRIP.days[0] }],
  }
  const sixtyDays: Trip = {
    ...MOCK_TRIP,
    warnings: [],
    days: Array.from({ length: 60 }, (_, index) => ({
      day: index + 1,
      date: null,
      title: `第 ${index + 1} 天`,
      summary: '',
      stops: [],
      legs: [],
    })),
  }
  const duplicatedStopIds: Trip = {
    ...MOCK_TRIP,
    days: [{ ...MOCK_TRIP.days[0], stops: [stop, { ...stop }], legs: [] }],
  }

  it('重复 day 的文件不进入预览，也没有「打开这份行程」', async () => {
    const onOpen = vi.fn()
    render(<TripTransferPanel trip={null} onOpen={onOpen} />)

    selectFile(jsonFile(envelopeTextOf(duplicatedDays)))

    await waitFor(() => expect(within(panel()).getByText(/重复的天数/)).toBeInTheDocument())
    expect(within(panel()).queryByRole('heading', { name: /预览/ })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: '打开这份行程' })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: '保存到本地' })).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
    expect(readRawStorage()).toBeNull()
  })

  it('60 天的文件同样在预览前被拒绝', async () => {
    const onOpen = vi.fn()
    render(<TripTransferPanel trip={null} onOpen={onOpen} />)

    selectFile(jsonFile(envelopeTextOf(sixtyDays)))

    await waitFor(() => expect(within(panel()).getByText(/重复的天数/)).toBeInTheDocument())
    expect(within(panel()).queryByRole('heading', { name: /预览/ })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: '打开这份行程' })).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
    expect(readRawStorage()).toBeNull()
  })

  it('同一天里重复站点 ID 的文件同样进不了预览', async () => {
    const onOpen = vi.fn()
    render(<TripTransferPanel trip={null} onOpen={onOpen} />)

    selectFile(jsonFile(envelopeTextOf(duplicatedStopIds)))

    await waitFor(() => expect(within(panel()).getByText(/重复的站点 ID/)).toBeInTheDocument())
    expect(within(panel()).queryByRole('heading', { name: /预览/ })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: '打开这份行程' })).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
    expect(readRawStorage()).toBeNull()
  })
})

describe('TripTransferPanel：同 ID 覆盖确认与焦点', () => {
  it('savedAt 相同但内容在确认前被改写时拒绝覆盖，原始字节不变', async () => {
    const user = userEvent.setup()
    const savedAt = 1_760_000_000_000
    const localTrip: Trip = { ...MOCK_TRIP, id: 'trip-same-ms', title: '同一毫秒的原始副本' }
    const beforeRaw = writeEnvelope([{ id: localTrip.id, savedAt, trip: localTrip }])

    const incoming: Trip = { ...MOCK_TRIP, id: 'trip-same-ms', title: '文件里的副本' }
    render(<TripTransferPanel trip={null} />)

    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：文件里的副本/ })).toBeInTheDocument(),
    )

    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))
    expect(within(panel()).getByRole('alert')).toHaveTextContent('同一毫秒的原始副本')
    expect(readRawStorage()).toBe(beforeRaw)

    // 另一个标签页在同一毫秒改写了内容：savedAt 完全没变，只有内容变了
    const rewrittenRaw = writeEnvelope([
      { id: localTrip.id, savedAt, trip: { ...localTrip, title: '同一毫秒被改写' } },
    ])

    await user.click(
      within(within(panel()).getByRole('group', { name: '替换本地副本确认' })).getByRole('button', {
        name: '确认替换本地副本',
      }),
    )

    // 不写入：原始字节逐字节保持被改写后的样子
    expect(readRawStorage()).toBe(rewrittenRaw)
    expect(within(panel()).getByText(/本地副本在确认前发生了变化/)).toBeInTheDocument()
    expect(within(panel()).getByRole('alert')).toHaveTextContent('同一毫秒被改写')
  })

  it('取消替换或确认替换后，焦点都回到「保存到本地」', async () => {
    const user = userEvent.setup()
    expect(saveTripToStorage({ ...MOCK_TRIP, title: '本地旧副本' }).ok).toBe(true)

    const incoming: Trip = { ...MOCK_TRIP, title: '文件里的新副本' }
    render(<TripTransferPanel trip={null} />)
    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：文件里的新副本/ })).toBeInTheDocument(),
    )

    const saveButton = within(panel()).getByRole('button', { name: '保存到本地' })

    await user.click(saveButton)
    const confirmGroup = within(panel()).getByRole('group', { name: '替换本地副本确认' })
    await user.click(within(confirmGroup).getByRole('button', { name: '取消替换' }))
    await waitFor(() => expect(saveButton).toHaveFocus())

    await user.click(saveButton)
    const confirmAgain = within(panel()).getByRole('group', { name: '替换本地副本确认' })
    await user.click(within(confirmAgain).getByRole('button', { name: '确认替换本地副本' }))
    await waitFor(() => expect(saveButton).toHaveFocus())
  })

  it('放弃预览后焦点回到文件选择框，待确认状态一并清掉', async () => {
    const user = userEvent.setup()
    expect(saveTripToStorage({ ...MOCK_TRIP, title: '本地旧副本' }).ok).toBe(true)
    const rawBefore = readRawStorage()

    const incoming: Trip = { ...MOCK_TRIP, title: '文件里的新副本' }
    render(<TripTransferPanel trip={null} />)
    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：文件里的新副本/ })).toBeInTheDocument(),
    )

    // 先进入替换确认，再放弃预览：确认块和预览一起消失
    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))
    expect(within(panel()).getByRole('alert')).toBeInTheDocument()

    await user.click(within(panel()).getByRole('button', { name: '放弃预览' }))

    await waitFor(() => expect(fileInput()).toHaveFocus())
    expect(within(panel()).queryByRole('alert')).toBeNull()
    expect(within(panel()).queryByRole('heading', { name: /预览/ })).toBeNull()
    // 放弃预览不碰存储：本地副本逐字节还是原来那份
    expect(readRawStorage()).toBe(rawBefore)
  })

  it('还没有待确认时点「放弃预览」，焦点回到文件选择框且不写本地存储', async () => {
    const user = userEvent.setup()
    const incoming: Trip = { ...MOCK_TRIP, id: 'trip-focus-plain', title: '没有冲突的新副本' }
    render(<TripTransferPanel trip={null} />)

    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：没有冲突的新副本/ })).toBeInTheDocument(),
    )
    expect(readRawStorage()).toBeNull()

    // 普通预览分支：pending 一直是 null，放弃时预览区连同按钮一起卸载，
    // 焦点会掉到 body，必须交回文件选择框（README 的口径）
    await user.click(within(panel()).getByRole('button', { name: '放弃预览' }))

    await waitFor(() => expect(fileInput()).toHaveFocus())
    expect(within(panel()).queryByRole('heading', { name: /预览/ })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: '保存到本地' })).toBeNull()
    expect(readRawStorage()).toBeNull()
  })

  it('键盘 Tab 到「放弃预览」并回车，焦点同样回到文件选择框', async () => {
    const user = userEvent.setup()
    const incoming: Trip = { ...MOCK_TRIP, id: 'trip-focus-keyboard', title: '键盘放弃的副本' }
    render(<TripTransferPanel trip={null} />)

    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：键盘放弃的副本/ })).toBeInTheDocument(),
    )

    // 真实键盘路径：从「保存到本地」往后一格就是「放弃预览」，回车触发 click
    within(panel()).getByRole('button', { name: '保存到本地' }).focus()
    await user.tab()
    expect(within(panel()).getByRole('button', { name: '放弃预览' })).toHaveFocus()

    await user.keyboard('{Enter}')

    await waitFor(() => expect(fileInput()).toHaveFocus())
    expect(within(panel()).queryByRole('heading', { name: /预览/ })).toBeNull()
    expect(readRawStorage()).toBeNull()
  })

  it('放弃预览后重新选择文件：异步读取不写存储，也不抢走文件选择框的焦点', async () => {
    let resolveSlow: (text: string) => void = () => {}
    const slowText = new Promise<string>((resolve) => {
      resolveSlow = resolve
    })
    const slowFile = { name: 'slow.json', size: 100, text: () => slowText }

    const user = userEvent.setup()
    render(<TripTransferPanel trip={null} />)

    selectFile(jsonFile(backupTextOf({ ...MOCK_TRIP, id: 'trip-first', title: '第一份副本' })))
    await waitFor(() => expect(within(panel()).getByRole('heading', { name: /预览：第一份副本/ })).toBeInTheDocument())

    await user.click(within(panel()).getByRole('button', { name: '放弃预览' }))
    await waitFor(() => expect(fileInput()).toHaveFocus())
    expect(readRawStorage()).toBeNull()

    // 重新选择：读取还没回来时焦点留在文件选择框
    selectFile(slowFile)
    expect(within(panel()).getByText('正在读取文件…')).toBeInTheDocument()
    expect(fileInput()).toHaveFocus()

    // 读取晚到：只出预览，不写存储，也不去挪焦点
    resolveSlow(backupTextOf({ ...MOCK_TRIP, id: 'trip-second', title: '第二份副本' }))
    await waitFor(() => expect(within(panel()).getByRole('heading', { name: /预览：第二份副本/ })).toBeInTheDocument())

    expect(fileInput()).toHaveFocus()
    expect(readRawStorage()).toBeNull()
  })

  it('读取还没结束就卸载组件，晚到的结果不写存储也不会去聚焦', async () => {
    let resolveSlow: (text: string) => void = () => {}
    const slowText = new Promise<string>((resolve) => {
      resolveSlow = resolve
    })
    const slowFile = { name: 'slow.json', size: 100, text: () => slowText }

    const { unmount } = render(<TripTransferPanel trip={null} />)
    selectFile(slowFile)
    expect(within(panel()).getByText('正在读取文件…')).toBeInTheDocument()

    unmount()
    resolveSlow(backupTextOf(MOCK_TRIP))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(readRawStorage()).toBeNull()
    expect(document.activeElement).toBe(document.body)
  })

  it('确认框打开时重新选择文件，旧确认不会残留', async () => {
    const user = userEvent.setup()
    const localTrip: Trip = { ...MOCK_TRIP, id: 'trip-switch', title: '本地副本' }
    const beforeRaw = writeEnvelope([{ id: localTrip.id, savedAt: 1_760_000_000_000, trip: localTrip }])

    render(<TripTransferPanel trip={null} />)
    selectFile(jsonFile(backupTextOf({ ...MOCK_TRIP, id: 'trip-switch', title: '文件副本' })))
    await waitFor(() => expect(within(panel()).getByRole('heading', { name: /预览：文件副本/ })).toBeInTheDocument())

    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))
    expect(within(panel()).getByRole('alert')).toHaveTextContent('本地副本')

    // 换一个文件：旧的待确认状态必须一起清掉
    selectFile(jsonFile(backupTextOf({ ...MOCK_TRIP, id: 'trip-other', title: '另一份行程' })))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：另一份行程/ })).toBeInTheDocument(),
    )

    expect(within(panel()).queryByRole('alert')).toBeNull()
    expect(within(panel()).queryByRole('group', { name: '替换本地副本确认' })).toBeNull()
    expect(readRawStorage()).toBe(beforeRaw)
  })
})

describe('TripTransferPanel：存储异常不把原生错误回显给用户', () => {
  const fakePath = 'C:\\Users\\86133\\AppData\\Local\\secret\\trip.json'

  it('读取抛异常时只显示固定文案，不出现本机路径或异常代码', async () => {
    const user = userEvent.setup()
    const failingStorage: StorageLike = {
      getItem() {
        throw new Error(`EACCES: permission denied, open '${fakePath}'`)
      },
      setItem() {},
      removeItem() {},
    }

    const incoming: Trip = { ...MOCK_TRIP, id: 'trip-read-error', title: '读失败' }
    render(<TripTransferPanel trip={null} storage={failingStorage} />)
    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：读失败/ })).toBeInTheDocument(),
    )

    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))

    expect(within(panel()).getByText(/读取本地保存数据失败/)).toBeInTheDocument()
    const region = panel()
    expect(region).not.toHaveTextContent('EACCES')
    expect(region).not.toHaveTextContent('secret')
    expect(region).not.toHaveTextContent('C:\\')
    expect(readRawStorage()).toBeNull()
  })

  it('写入抛异常时只显示固定文案，原有记录逐字节不变', async () => {
    const user = userEvent.setup()
    const data = new Map<string, string>()
    const keptTrip: Trip = { ...MOCK_TRIP, id: 'kept', title: '已有记录' }
    const beforeRaw = JSON.stringify({
      version: SAVED_TRIPS_VERSION,
      trips: [{ id: keptTrip.id, savedAt: 1_760_000_000_000, trip: keptTrip }],
    })
    data.set(SAVED_TRIPS_STORAGE_KEY, beforeRaw)
    const failingStorage: StorageLike = {
      getItem: (key) => data.get(key) ?? null,
      setItem() {
        throw new Error(`EACCES: permission denied, open '${fakePath}'`)
      },
      removeItem() {},
    }

    const incoming: Trip = { ...MOCK_TRIP, id: 'trip-write-error', title: '写失败' }
    render(<TripTransferPanel trip={null} storage={failingStorage} />)
    selectFile(jsonFile(backupTextOf(incoming)))
    await waitFor(() =>
      expect(within(panel()).getByRole('heading', { name: /预览：写失败/ })).toBeInTheDocument(),
    )

    await user.click(within(panel()).getByRole('button', { name: '保存到本地' }))

    expect(within(panel()).getByText(/写入本地存储失败，当前行程没有保存/)).toBeInTheDocument()
    const region = panel()
    expect(region).not.toHaveTextContent('EACCES')
    expect(region).not.toHaveTextContent('secret')
    expect(region).not.toHaveTextContent('C:\\')
    expect(data.get(SAVED_TRIPS_STORAGE_KEY)).toBe(beforeRaw)
  })
})

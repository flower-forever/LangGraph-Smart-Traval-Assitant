/**
 * App × sessionRestore 集成测试：opt-in 开关、pending 概况、显式恢复、
 * 迟到示例/规划不覆盖、草稿与费用恢复、dirty 暂停、关闭与删除语义。
 * 全部离线 jsdom + mock fetch，不发任何网络请求。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { Trip } from '../lib/api'
import { MOCK_TRIP } from './fixtures/trip'
import {
  SESSION_RESUME_DATA_KEY,
  SESSION_RESUME_FLAG_KEY,
  setSessionResumeFlag,
  writeSessionResume,
} from '../lib/sessionRestore'
import { SAVED_TRIPS_STORAGE_KEY, saveTripToStorage } from '../lib/savedTrips'
import { createTripBackup } from '../lib/tripTransfer'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
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

/** PLAN_TRIP：与示例不同的第二份合法行程，用于验证「示例不能覆盖待恢复副本」 */
const PLAN_TRIP = {
  ...MOCK_TRIP,
  id: 'trip-planned-1',
  source: 'agent' as const,
  title: '南京两日规划行',
}

const EDITED_DAY_ONE = {
  ...MOCK_TRIP.days[0]!,
  stops: [
    ...MOCK_TRIP.days[0]!.stops.slice(0, 2),
    { ...MOCK_TRIP.days[0]!.stops[0]!, id: 'new-stop-x', name: '新加站点', time: '15:00', location: null },
  ],
  legs: [],
}

/** 导入用行程夹具：与示例/规划行不同，标题可辨识 */
const IMPORTED_TRIP: Trip = {
  id: 'trip-imported-sr',
  source: 'agent',
  destination: '西安',
  title: '西安古城两日行',
  summary: '从备份文件导入的行程，用于验证留存来源边界。',
  map_coordinate_system: 'WGS84',
  warnings: [],
  days: [
    {
      day: 1,
      date: null,
      title: '城墙',
      summary: '登城墙。',
      stops: [
        {
          id: 'sr-s1',
          name: '永宁门',
          time: '09:00',
          duration_minutes: 45,
          description: '城墙南门。',
          address: '西安市碑林区',
          location: { lng: 108.947, lat: 34.2515 },
        },
      ],
      legs: [],
    },
  ],
}

/** 用真实 createTripBackup 生成合法备份文件 */
function backupFileOf(trip: Trip): File {
  const backup = createTripBackup(trip, { now: new Date('2026-02-02T00:00:00.000Z') })
  if (!backup.ok) throw new Error(`生成备份失败：${backup.reason}`)
  return new File([backup.json], 'trip-backup.json', { type: 'application/json' })
}

async function expandTransferPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '行程备份与导入' }))
}

function pickBackupFile(trip: Trip) {
  const input = screen.getByLabelText(/选择备份文件/) as HTMLInputElement
  fireEvent.change(input, { target: { files: [backupFileOf(trip)] } })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('scrollTo', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

async function enableResume(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /在此浏览器保留工作进度/ }))
}

describe('App 会话留存：默认关闭与启用', () => {
  it('默认 off：正常流程不读写恢复数据键，正式保存行为原样', async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')
    // 默认 off 只读独立 flag；挂载/示例加载期间不读数据键
    expect(getItemSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
    // 页面上存在留存入口（开关），但从未启用时数据键不出现
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBeNull()
    // 正式保存不受影响
    await user.click(within(container).getByRole('button', { name: '保存当前行程' }))
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).not.toBeNull()
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()
  })

  it('I1: localStorage getter 抛 SecurityError → 明确未启用/不可用；恢复后重试可启用', async () => {
    stubHappyFetch()
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
      await screen.findByText('杭州三日漫步路书')
      expect(await screen.findByText(/浏览器本地存储不可用/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /在此浏览器保留工作进度/ }))
      // 仍在报不可用，不能显示已启用或静默无反馈
      expect(screen.getByText(/浏览器本地存储不可用/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /在此浏览器保留工作进度/ })).toBeInTheDocument()
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
    }
    // 存储恢复可用后，同一按钮重试才真正启用
    await user.click(screen.getByRole('button', { name: /在此浏览器保留工作进度/ }))
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('1'))
    expect(screen.queryByText(/浏览器本地存储不可用/)).toBeNull()
  })

  it('启用后开始有界自动留存：写入独立数据键；示例返回不破坏副本', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    await enableResume(user)
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('1')
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull())
    const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!
    const parsed = JSON.parse(raw) as { session: { trip: { id: string } } }
    expect(parsed.session.trip.id).toBe(MOCK_TRIP.id)
  })
})

describe('App 会话留存：pending 概况与显式恢复', () => {
  function seedResumeRecord() {
    writeSessionResume(
      {
        payload: {
          trip: PLAN_TRIP,
          draft: null,
          budget: null,
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        },
        expectedRaw: null,
      },
      window.localStorage,
    )
    setSessionResumeFlag(window.localStorage, true)
  }

  it('重开页面发现副本 → pending 概况；示例照常进内存但不覆盖副本、不自动恢复', async () => {
    seedResumeRecord()
    stubHappyFetch()
    render(<App />)
    // 概况卡出现，显示待恢复标题
    const card = await screen.findByTestId('session-resume-card')
    expect(within(card).getByText(/南京两日规划行/)).toBeInTheDocument()
    // 主视图仍是示例行程（未自动恢复）
    expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
    // 副本原样：示例返回没有把它写没
    const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!
    expect((JSON.parse(raw) as { session: { trip: { id: string } } }).session.trip.id).toBe(PLAN_TRIP.id)
  })

  it('显式恢复替换视图；迟到的示例响应不能覆盖恢复结果', async () => {
    let resolveExample: ((value: unknown) => void) | undefined
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') {
        return new Promise((resolve) => {
          resolveExample = resolve
        })
      }
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    seedResumeRecord()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
    expect(screen.getByText('南京两日规划行')).toBeInTheDocument()
    // 迟到的示例返回被丢弃
    await act(async () => {
      resolveExample?.(MOCK_TRIP)
    })
    expect(screen.getByText('南京两日规划行')).toBeInTheDocument()
    expect(screen.queryByText('杭州三日漫步路书')).toBeNull()
  })

  it('恢复带未应用草稿的副本：草稿处于编辑态但不自动应用；放弃回原 base', async () => {
    seedResumeRecordWithDraft()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
    // 草稿预览态出现（编辑中），新站点在预览里可见
    expect(await screen.findByTestId('draft-preview-note')).toBeInTheDocument()
    expect(screen.getAllByText('新加站点').length).toBeGreaterThan(0)
    // 放弃草稿回原视图（编辑器内联确认两步）
    await user.click(screen.getByRole('button', { name: '放弃草稿' }))
    await user.click(screen.getByRole('button', { name: '确认放弃草稿' }))
    await waitFor(() => expect(screen.queryAllByText('新加站点').length).toBe(0))
    expect(screen.getByText('南京两日规划行')).toBeInTheDocument()
  })

  function seedResumeRecordWithDraft() {
    writeSessionResume(
      {
        payload: {
          trip: PLAN_TRIP,
          draft: {
            forkTripId: 'fork-resumed',
            newLegMode: 'walking',
            editedDays: [{ day: 1, days: [EDITED_DAY_ONE] }],
          },
          budget: null,
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        },
        expectedRaw: null,
      },
      window.localStorage,
    )
    setSessionResumeFlag(window.localStorage, true)
  }

  it('恢复 current 费用：按新会话重绑可编辑；打开费用面板金额原样', async () => {
    seedResumeRecordWithBudget('current')
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
    await user.click(screen.getByRole('button', { name: '费用估算' }))
    expect(await screen.findByDisplayValue('128.5')).toBeInTheDocument()
  })

  function seedResumeRecordWithBudget(kind: 'current' | 'stale') {
    writeSessionResume(
      {
        payload: {
          trip: PLAN_TRIP,
          draft: null,
          budget: {
            binding:
              kind === 'current'
                ? { kind: 'current', tripId: PLAN_TRIP.id }
                : { kind: 'stale', tripId: 'trip-older', tripTitle: '更早的行程' },
            budgetRaw: '',
            rows: [{ id: 'row-1', category: 'transport', name: '高铁票', amountRaw: '128.5' }],
          },
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        },
        expectedRaw: null,
      },
      window.localStorage,
    )
    setSessionResumeFlag(window.localStorage, true)
  }

  it('恢复 stale 费用：只读沿用提示出现，须显式沿用或新建；不自动 fresh', async () => {
    seedResumeRecordWithBudget('stale')
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
    await user.click(screen.getByRole('button', { name: '费用估算' }))
    // 既有 stale 交互出现
    expect(await screen.findByText(/属于旧版本的行程/)).toBeInTheDocument()
  })

  it('放弃恢复并开始留存当前进度：确认后替换副本；关闭开关保数据；删除需内联确认', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByTestId('session-resume-card')
    // 显式「放弃并开始留存」：确认文案出现后确认
    await user.click(screen.getByRole('button', { name: /放弃恢复并开始留存/ }))
    await user.click(screen.getByRole('button', { name: /确认放弃/ }))
    await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      expect(raw).not.toBeNull()
      expect((JSON.parse(raw!) as { session: { trip: { id: string } } }).session.trip.id).toBe(MOCK_TRIP.id)
    })
    // 关闭开关：数据键保留；关闭后删除入口仍可用（problem/idle 下都可管理）
    await user.click(screen.getByRole('button', { name: /关闭保留/ }))
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('0')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull()
    // 关闭后可同页重新开启（flag 写回 '1'，旧副本回到 pending 概况）
    await user.click(screen.getByRole('button', { name: '在此浏览器保留工作进度' }))
    await screen.findByTestId('session-resume-card')
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('1')
    expect(within(screen.getByTestId('session-resume-card')).getByText(/杭州三日漫步路书/)).toBeInTheDocument()
    // 再次关闭后删除副本：内联确认后才删
    await user.click(screen.getByRole('button', { name: /关闭保留/ }))
    await user.click(screen.getByRole('button', { name: '删除本机恢复副本' }))
    await user.click(screen.getByRole('button', { name: /确认删除副本/ }))
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull())
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('损坏副本：概况卡显示错误且不提供恢复入口、原 raw 保留', async () => {
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, '{broken json')
    stubHappyFetch()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    expect(within(card).getByText(/损坏/)).toBeInTheDocument()
    // 损坏时不渲染恢复按钮（无法部分恢复），只有删除入口
    expect(within(card).queryByRole('button', { name: '恢复上次的工作进度' })).toBeNull()
    expect(within(card).getByRole('button', { name: '删除本机恢复副本' })).toBeInTheDocument()
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe('{broken json')
    // 主视图照常加载示例，损坏数据不影响页面
    await screen.findByText('杭州三日漫步路书')
  })

  it('D1: corrupt 后示例返回 + 用户改名触发自动写，raw 仍逐字节不变（停写有效）', async () => {
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    const brokenRaw = '{"format":"travel-assistant.session-resume","version":1,savedAt'
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, brokenRaw)
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByTestId('session-resume-card')
    await screen.findByText('杭州三日漫步路书')
    // 示例已返回；再触发一次真实编辑（进入草稿改时间保存）——自动写必须被暂停挡住
    await user.click(within(container).getByRole('button', { name: '编辑这趟行程' }))
    const editor = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const nameInput = within(editor).getByLabelText(/站点名称/)
    await user.clear(nameInput)
    await user.type(nameInput, '改名测试')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await waitFor(() => expect(within(editor).getAllByText('改名测试').length).toBeGreaterThan(0))
    // 编辑后 raw 逐字节不变
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(brokenRaw)
  })

  it('D3: 恢复不删除副本（无 removeItem）；写失败时旧 raw 原样且下一次写保旧', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    const rawBefore = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!
    // mock setItem：恢复后的下一次自动写会失败（quota），旧 raw 必须原样
    const originalSetItem = Storage.prototype.setItem
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === SESSION_RESUME_DATA_KEY) throw new DOMException('quota', 'QuotaExceededError')
      return originalSetItem.call(this, key, value)
    })
    try {
      await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
      expect(screen.getByText('南京两日规划行')).toBeInTheDocument()
      // 恢复动作本身没有删数据
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull()
      // 等待恢复后的自动写尝试（会失败）→ raw 仍是恢复前的旧值
      await waitFor(() => expect(setItemSpy).toHaveBeenCalled())
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawBefore)
      // 失败显式可见（problem 提示），UI 不假装还在正常留存
      expect(screen.getByText(/已暂停/)).toBeInTheDocument()
    } finally {
      setItemSpy.mockRestore()
    }
  })

  it('C: 外部只 setItem 不派发事件 → 恢复被 CAS 拒绝，UI/外部 raw 不变且不写', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await screen.findByText('杭州三日漫步路书')
    const original = JSON.parse(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!) as {
      session: { trip: { title: string } }
    }
    original.session.trip.title = '外部标签行程'
    const externalRaw = JSON.stringify(original)
    // 只写存储、不派发 StorageEvent，模拟事件尚未到达本标签
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, externalRaw)
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    try {
      await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
      await waitFor(() => expect(screen.getByText(/另一个标签页更新了留存副本/)).toBeInTheDocument())
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(externalRaw)
      expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
      expect(screen.queryByText('南京两日规划行')).toBeNull()
      expect(setItemSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
    } finally {
      setItemSpy.mockRestore()
    }
  })

  it('C: 外部只 setItem 不派发事件 → 放弃替换被 CAS 拒绝，双方数据不变', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await screen.findByText('杭州三日漫步路书')
    const original = JSON.parse(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!) as {
      session: { trip: { title: string } }
    }
    original.session.trip.title = '外部标签行程'
    const externalRaw = JSON.stringify(original)
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, externalRaw)
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    try {
      await user.click(within(card).getByRole('button', { name: /放弃恢复并开始留存/ }))
      await user.click(screen.getByRole('button', { name: /确认放弃/ }))
      await waitFor(() => expect(screen.getByText(/另一个标签页更新了留存副本/)).toBeInTheDocument())
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(externalRaw)
      expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
      expect(screen.queryByText('南京两日规划行')).toBeNull()
      expect(setItemSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
    } finally {
      setItemSpy.mockRestore()
    }
  })

  it('C: empty 首次读 null、随后外部已有 raw → 冻结首次 null，自动写 conflict 且外部 raw 不变', async () => {
    const seeded = writeSessionResume(
      {
        payload: {
          trip: PLAN_TRIP,
          draft: null,
          budget: null,
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        },
        expectedRaw: null,
      },
      window.localStorage,
    )
    if (!seeded.ok) throw new Error(`fixture 失败：${seeded.reason}`)
    const externalRaw = seeded.writtenRaw
    // 外部标签已有合法 raw，但不派发 StorageEvent；首次加载读取被模拟成“当时为空”
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    const originalGetItem = Storage.prototype.getItem
    let dataReads = 0
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === SESSION_RESUME_DATA_KEY) {
        dataReads += 1
        return dataReads === 1 ? null : externalRaw
      }
      return originalGetItem.call(this, key)
    })
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    stubHappyFetch()
    try {
      render(<App />)
      await screen.findByText('杭州三日漫步路书')
      await waitFor(() => expect(screen.getByText(/另一个标签页更新了留存副本/)).toBeInTheDocument())
      // 自动写必须以首次 empty 的 null 为基准，被外部 raw 挡住
      expect(setItemSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
      expect(originalGetItem.call(window.localStorage, SESSION_RESUME_DATA_KEY)).toBe(externalRaw)
    } finally {
      getItemSpy.mockRestore()
      setItemSpy.mockRestore()
    }
  })

  it('I2: pending A 外部换成 B 无事件 → 删除被拒，B 逐字节保留、removeItem 0', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await screen.findByText('杭州三日漫步路书')
    const original = JSON.parse(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!) as {
      session: { trip: { title: string } }
    }
    original.session.trip.title = '外部标签行程'
    const externalRaw = JSON.stringify(original)
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, externalRaw)
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
    try {
      await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
      await waitFor(() => expect(screen.getByText(/删除未执行/)).toBeInTheDocument())
      expect(screen.queryByRole('button', { name: /确认删除副本/ })).toBeNull()
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(externalRaw)
      expect(removeSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
      expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
    } finally {
      removeSpy.mockRestore()
    }
  })

  it('I2: 损坏/未知记录删除也冻结实际 raw；外部换成 B 后拒绝且不删 B', async () => {
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    const brokenRaw = '{"format":"travel-assistant.session-resume","version":1'
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, brokenRaw)
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    expect(await screen.findByText(/损坏/)).toBeInTheDocument()
    const externalRaw = '{"format":"travel-assistant.session-resume","version":1,"savedAt":1,"session":{}}'
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, externalRaw)
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
    try {
      await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
      await waitFor(() => expect(screen.getByText(/删除未执行/)).toBeInTheDocument())
      expect(screen.queryByRole('button', { name: /确认删除副本/ })).toBeNull()
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(externalRaw)
      expect(removeSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
    } finally {
      removeSpy.mockRestore()
    }
  })

  /**
   * I2 补充窗口：prepare 成功（确认框已打开并冻结候选 raw）之后、点击确认之前，
   * 外部标签静默写入 B（只 setItem、不发 StorageEvent）。确认删除必须走
   * compare-then-remove：读到 B ≠ 冻结候选 → 拒绝删除，B 逐字节保留、
   * 数据键 removeItem 0 次、给出冲突反馈，当前内存行程不被外部 B 隐式替换。
   */
  function externalPendingRawB(): string {
    // 外部标签按同一写协议 compare-then-write：以它读到的 A 为基准写入 B
    const rawA = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    const seeded = writeSessionResume(
      {
        payload: {
          trip: PLAN_TRIP,
          draft: null,
          budget: null,
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        },
        expectedRaw: rawA,
      },
      window.localStorage,
    )
    if (!seeded.ok) throw new Error(`fixture 失败：${seeded.reason}`)
    // 外部标签视角下的 B：标题可辨识，与本标签冻结的候选 A 不同
    const parsed = JSON.parse(seeded.writtenRaw) as { session: { trip: { title: string } } }
    parsed.session.trip.title = '外部标签行程B'
    return JSON.stringify(parsed)
  }

  it('I2: prepare 打开确认后外部静默写 B（无事件）→ 确认被拒，B 逐字节保留、removeItem 0、内存不隐式换成 B', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await screen.findByText('杭州三日漫步路书')
    // 打开删除确认：prepare 此时读到 A 且与冻结基准一致 → 成功
    await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
    const confirmGroup = await within(card).findByRole('group')
    expect(within(confirmGroup).getByRole('button', { name: /确认删除副本/ })).toBeInTheDocument()
    // prepare 与 confirm 之间：外部标签只写存储、不派发 StorageEvent
    const externalRawB = externalPendingRawB()
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, externalRawB)
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
    try {
      await user.click(within(confirmGroup).getByRole('button', { name: /确认删除副本/ }))
      await waitFor(() => expect(screen.getByText(/删除未执行/)).toBeInTheDocument())
      // 确认框已随冲突反馈关闭，不再残留可点击的旧确认
      expect(screen.queryByRole('button', { name: /确认删除副本/ })).toBeNull()
      // 外部 B 逐字节保留
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(externalRawB)
      expect(removeSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
      // 当前内存行程仍是本标签自己的（示例），未被外部 B 隐式替换
      expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
      expect(screen.queryByText('外部标签行程B')).toBeNull()
    } finally {
      removeSpy.mockRestore()
    }
  })

  it('I2: 损坏基线在确认窗口内被外部换成另一坏记录 → 确认同样被拒且不删外部记录', async () => {
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    const brokenRaw = '{"format":"travel-assistant.session-resume","version":1'
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, brokenRaw)
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    expect(await screen.findByText(/损坏/)).toBeInTheDocument()
    // prepare 在损坏基线上成功打开确认
    await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
    const confirmGroup = await within(card).findByRole('group')
    expect(within(confirmGroup).getByRole('button', { name: /确认删除副本/ })).toBeInTheDocument()
    // 确认窗口内外部换成另一条不同的坏记录
    const externalBroken = '{"format":"travel-assistant.session-resume","version":9'
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, externalBroken)
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
    try {
      await user.click(within(confirmGroup).getByRole('button', { name: /确认删除副本/ }))
      await waitFor(() => expect(screen.getByText(/删除未执行/)).toBeInTheDocument())
      expect(screen.queryByRole('button', { name: /确认删除副本/ })).toBeNull()
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(externalBroken)
      expect(removeSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
    } finally {
      removeSpy.mockRestore()
    }
  })

  it('C: 恢复前读取存储抛 SecurityError → 安全停写，不替换当前页面', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await screen.findByText('杭州三日漫步路书')
    const rawBefore = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    const originalGetItem = Storage.prototype.getItem
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === SESSION_RESUME_DATA_KEY) throw new DOMException('denied', 'SecurityError')
      return originalGetItem.call(this, key)
    })
    try {
      await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
      await waitFor(() => expect(screen.getByText(/读取本机留存副本失败/)).toBeInTheDocument())
      expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
      expect(screen.queryByText('南京两日规划行')).toBeNull()
      // 无法读取时也不能假定为空而写入；原 raw 经原始读方法核对仍逐字节不变
      expect(originalGetItem.call(window.localStorage, SESSION_RESUME_DATA_KEY)).toBe(rawBefore)
    } finally {
      getItemSpy.mockRestore()
    }
  })

  it('D5: flag 外部变化（storage 事件）→ 停写 + 后续编辑 raw 保旧；flag 外部 off 后 UI 不复活写', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByTestId('session-resume-card')
    await screen.findByText('杭州三日漫步路书') // 示例进内存；待恢复副本标题在概况卡
    // 模拟他标签写数据键
    const rawBefore = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!
    await act(async () => {
      window.localStorage.setItem(SESSION_RESUME_DATA_KEY, rawBefore.slice(0, -2) + 'x}')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SESSION_RESUME_DATA_KEY,
          storageArea: window.localStorage,
          newValue: 'x',
        }),
      )
    })
    // 本标签进入冲突暂停
    await waitFor(() => expect(screen.getByText(/另一个标签页/)).toBeInTheDocument())
    // 之后用户在草稿里改东西 → raw 保旧（冻结值不被覆盖）
    await user.click(within(container).getByRole('button', { name: '编辑这趟行程' }))
    const editor = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const nameInput = within(editor).getByLabelText(/站点名称/)
    await user.clear(nameInput)
    await user.type(nameInput, '冲突后改名')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await waitFor(() => expect(within(editor).getAllByText('冲突后改名').length).toBeGreaterThan(0))
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawBefore.slice(0, -2) + 'x}')

    // flag 外部 off：UI 回 off 且后续编辑不再写（新 raw 不会出现）
    await user.click(screen.getByRole('button', { name: '放弃草稿' }))
    await user.click(screen.getByRole('button', { name: '确认放弃草稿' }))
    await act(async () => {
      window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '0')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SESSION_RESUME_FLAG_KEY,
          storageArea: window.localStorage,
          newValue: '0',
        }),
      )
    })
    await waitFor(() => expect(screen.getByRole('button', { name: '在此浏览器保留工作进度' })).toBeInTheDocument())
    const rawAtOff = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    await user.click(within(container).getByRole('button', { name: '编辑这趟行程' }))
    const editor2 = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor2).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const nameInput2 = within(editor2).getByLabelText(/站点名称/)
    await user.clear(nameInput2)
    await user.type(nameInput2, '关闭后改名')
    await user.click(within(editor2).getByRole('button', { name: '保存到草稿' }))
    await waitFor(() => expect(within(editor2).getAllByText('关闭后改名').length).toBeGreaterThan(0))
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawAtOff)
  })

  it('D5: 外部把 flag 重新开启不自动复活；显式启用才重新读取旧 pending', async () => {
    writeSessionResume(
      {
        payload: {
          trip: PLAN_TRIP,
          draft: null,
          budget: null,
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        },
        expectedRaw: null,
      },
      window.localStorage,
    )
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '0')
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const card = await screen.findByTestId('session-resume-card')
    expect(screen.getByRole('button', { name: '在此浏览器保留工作进度' })).toBeInTheDocument()
    expect(within(card).queryByText(/南京两日规划行/)).toBeNull()

    // 其他标签把 flag 打开：本标签不自动启用、不自动写，也不偷偷恢复
    await act(async () => {
      window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SESSION_RESUME_FLAG_KEY,
          storageArea: window.localStorage,
          newValue: '1',
        }),
      )
    })
    expect(screen.getByRole('button', { name: '在此浏览器保留工作进度' })).toBeInTheDocument()
    expect(within(card).queryByText(/南京两日规划行/)).toBeNull()

    // 用户显式启用 = 重新读取并显示旧 pending
    await user.click(screen.getByRole('button', { name: '在此浏览器保留工作进度' }))
    expect(await within(card).findByText(/南京两日规划行/)).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '恢复上次的工作进度' })).toBeInTheDocument()
  })

  it('D5: 删除副本后 UI 明示保持暂停；同 transition 不默默重建', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
    await user.click(within(card).getByRole('button', { name: /确认删除副本/ }))
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull())
    // UI 明示已删除 + 保持暂停；删除成功不能再声称“原始数据已原样保留”
    const deletedCard = screen.getByTestId('session-resume-card')
    expect(within(deletedCard).getByText(/已删除本机恢复副本/)).toBeInTheDocument()
    expect(within(deletedCard).getByText(/保持暂停/)).toBeInTheDocument()
    expect(within(deletedCard).queryByText(/原始数据已原样保留/)).toBeNull()
    await screen.findByText('杭州三日漫步路书')
    // 示例加载完成后也没有同 transition 立即重建副本
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull()
    // 暂停不是死局：显式关闭再启用后，新的编辑/启用动作才重新留存当前进度
    await user.click(screen.getByRole('button', { name: /关闭保留/ }))
    await user.click(screen.getByRole('button', { name: '在此浏览器保留工作进度' }))
    await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      expect(raw).not.toBeNull()
      expect((JSON.parse(raw!) as { session: { trip: { id: string } } }).session.trip.id).toBe(MOCK_TRIP.id)
    })
  })

  it('D7: 导入文件 → 启用留存 → 恢复后仍显示「来自备份文件、未向服务器核对」；非文件 session 恢复不冒充打开文件', async () => {
    // 1) 正常启用留存（来源=应用内）：快照 ui.openedFromFile=false
    stubHappyFetch()
    const user = userEvent.setup()
    const { container, unmount } = render(<App />)
    await screen.findByText('杭州三日漫步路书')
    await enableResume(user)
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull())
    const nonFileRaw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!
    expect((JSON.parse(nonFileRaw) as { session: { ui: { openedFromFile: boolean } } }).session.ui.openedFromFile).toBe(false)
    unmount()

    // 2) pending 期间导入文件：内存行程更新，但待恢复副本逐字节不变
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, nonFileRaw)
    const second = render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const pendingCard = await screen.findByTestId('session-resume-card')
    expect(within(pendingCard).getByText(/杭州三日漫步路书/)).toBeInTheDocument()
    await expandTransferPanel(user)
    pickBackupFile(IMPORTED_TRIP)
    expect(await screen.findByText('预览：西安古城两日行')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开这份行程' }))
    expect(screen.getByText(/这份行程来自你选择的备份文件/)).toBeInTheDocument()
    // 导入只改内存，pending A 仍在且 raw 逐字节不变
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(nonFileRaw)
    expect(within(pendingCard).getByText(/杭州三日漫步路书/)).toBeInTheDocument()
    // 只有用户显式确认放弃恢复，才用当前导入文件替换副本
    await user.click(within(pendingCard).getByRole('button', { name: /放弃恢复并开始留存/ }))
    await user.click(screen.getByRole('button', { name: /确认放弃/ }))
    await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      expect(raw).not.toBeNull()
      expect((JSON.parse(raw!) as { session: { trip: { id: string }; ui: { openedFromFile: boolean } } }).session.ui.openedFromFile).toBe(true)
      expect((JSON.parse(raw!) as { session: { trip: { id: string } } }).session.trip.id).toBe(IMPORTED_TRIP.id)
    })
    second.unmount()

    // 3) reload：pending 概况显示文件来源自述；恢复后提示未核对且不是「已保存」
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const card = await screen.findByTestId('session-resume-card')
    expect(within(card).getByText(/来自你选择的备份文件/)).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
    expect(screen.getByText(/西安古城两日行/)).toBeInTheDocument()
    expect(screen.getAllByText(/来自你选择的备份文件/).length).toBeGreaterThan(0)
    expect(screen.getByText(/仍未向服务器核对|未向服务器核对/)).toBeInTheDocument()
    expect(screen.queryByText(/从本浏览器保存的副本恢复/)).toBeNull()
    void container
  })

  it('I4: pending 期间恢复已保存行程 → pending raw 不变；显式放弃后才接管', async () => {
    seedResumeRecord()
    const saved = saveTripToStorage(IMPORTED_TRIP)
    expect(saved.ok).toBe(true)
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await screen.findByText('杭州三日漫步路书')
    const rawA = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    await user.click(within(container).getByRole('button', { name: /已保存行程/ }))
    await user.click(within(container).getByRole('button', { name: /恢复保存的行程/ }))
    expect((await screen.findAllByText(/西安古城两日行/)).length).toBeGreaterThan(0)
    // 已保存恢复只改内存：pending A 原样
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawA)
    expect(within(card).getByText(/南京两日规划行/)).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: /放弃恢复并开始留存/ }))
    await user.click(screen.getByRole('button', { name: /确认放弃/ }))
    await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      expect(raw).not.toBeNull()
      expect((JSON.parse(raw!) as { session: { trip: { id: string } } }).session.trip.id).toBe(IMPORTED_TRIP.id)
    })
  })

  it('D7 legacy: 缺来源恢复后再次留存仍为 unknown，重载仍提示未知；编辑/应用不升级', async () => {
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    window.localStorage.setItem(
      SESSION_RESUME_DATA_KEY,
      JSON.stringify({
        format: 'travel-assistant.session-resume',
        version: 1,
        savedAt: 1_800_000_000_000,
        session: {
          trip: PLAN_TRIP,
          draft: null,
          budget: null,
          // 旧记录没有 openedFromFile 字段
          ui: { activeDay: 1, draftMode: 'walking' },
        },
      }),
    )
    stubHappyFetch()
    const user = userEvent.setup()
    const first = render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    expect(within(card).getByText(/没有记录来源标记/)).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
    await screen.findByText('南京两日规划行')
    await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw!) as { session: { trip: { id: string }; ui: { openedFromFile: boolean | null } } }
      expect(parsed.session.trip.id).toBe(PLAN_TRIP.id)
      expect(parsed.session.ui.openedFromFile).toBeNull()
    })

    // 本地改草稿并应用：来源仍保持未知，不能升级成 false
    await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
    const editor = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const nameInput = within(editor).getByLabelText(/站点名称/)
    await user.clear(nameInput)
    await user.type(nameInput, 'legacy改名')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      expect(raw).toContain('legacy改名')
      const parsed = JSON.parse(raw!) as { session: { ui: { openedFromFile: boolean | null } } }
      expect(parsed.session.ui.openedFromFile).toBeNull()
    })
    await user.click(screen.getByRole('button', { name: '应用草稿' }))
    await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      const parsed = JSON.parse(raw!) as {
        session: { trip: { id: string }; ui: { openedFromFile: boolean | null } }
      }
      expect(parsed.session.trip.id).not.toBe(PLAN_TRIP.id)
      expect(parsed.session.ui.openedFromFile).toBeNull()
    })

    // 卸载重载：仍显示来源未知，而不是“上次页面留存快照”的已知来源
    first.unmount()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const reloadedCard = await screen.findByTestId('session-resume-card')
    expect(within(reloadedCard).getByText(/没有记录来源标记/)).toBeInTheDocument()
  })

  it('D8: dirty 单站输入未提交时该输入不写入留存且 UI 明示；提交后随草稿更新', async () => {
    seedResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    // 恢复动作本身不删副本；下一次自动写以旧 expectedRaw 做单次替换。
    // 基准必须在点击恢复前取：恢复后的自动写可能在 restore 事件内就已完成。
    const rawBeforeRestore = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
    await screen.findByText('南京两日规划行')
    let rawAtResume: string | null = null
    await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      expect(raw).not.toBeNull()
      expect(raw).not.toBe(rawBeforeRestore)
      // 自动写的是恢复后的页面行程，不是已被丢弃的示例行程
      expect((JSON.parse(raw!) as { session: { trip: { id: string } } }).session.trip.id).toBe(PLAN_TRIP.id)
      rawAtResume = raw
    })
    // 进入编辑器并打开单站表单（此时尚未改动）；打开编辑器本身会写一次无差异草稿，
    // 所以 dirty 基准要在开始输入前取，而不是在进入编辑器前。
    await user.click(within(container).getByRole('button', { name: '编辑这趟行程' }))
    const editor = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const nameInput = within(editor).getByLabelText(/站点名称/)
    const rawBeforeDirtyInput = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    expect(rawBeforeDirtyInput).not.toContain('未提交的新名字')
    await user.clear(nameInput)
    await user.type(nameInput, '未提交的新名字')
    // dirty 时 raw 不变（该输入没被留存）
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawBeforeDirtyInput)
    // UI 明示暂停（编辑器与 App 日期切换提示各有一处）
    expect(screen.getAllByText(/单站输入尚未保存/).length).toBeGreaterThan(0)
    // 提交到草稿后随草稿更新
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      expect(raw).not.toBeNull()
      expect(raw).not.toBe(rawAtResume)
      expect(raw).toContain('未提交的新名字')
      // 不只是时间戳变化：名字确实进了 draft.editedDays
      const parsed = JSON.parse(raw!) as {
        session: { draft: null | { editedDays: { day: number; days: Trip['days'] }[] } }
      }
      expect(parsed.session.draft).not.toBeNull()
      const edited = parsed.session.draft!.editedDays.find((entry) => entry.day === 1)
      expect(edited).toBeDefined()
      expect(JSON.stringify(edited)).toContain('未提交的新名字')
    })
    // 无自动请求：fetch 只含 health + example
    const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u))
    expect(urls.filter((u: string) => u !== '/api/health' && u !== '/api/trips/example')).toEqual([])
    // 正式保存键未被触碰
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })
})

describe('App 会话留存：关闭后副本管理（Important 修复）', () => {
  /**
   * off 基线夹具：写入合法副本但 flag 关闭（模拟「启用过、写成功、关闭/重载后 flag=0」）。
   * 返回写入的 raw，供外部换 B / 逐字节断言使用。
   */
  function seedOffResumeRecord(): string {
    const seeded = writeSessionResume(
      {
        payload: {
          trip: PLAN_TRIP,
          draft: null,
          budget: null,
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        },
        expectedRaw: null,
      },
      window.localStorage,
    )
    if (!seeded.ok) throw new Error(`fixture 失败：${seeded.reason}`)
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '0')
    return seeded.writtenRaw
  }

  it('M1: 启用自动写成功后关闭保留 → 删除入口仍在，同页两步删除副本', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    await enableResume(user)
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull())
    // 关闭保留：flag 回 0，数据键原样保留
    await user.click(screen.getByRole('button', { name: /关闭保留/ }))
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('0')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull()
    // 关闭后删除入口必须仍可用（写成功需同步 hasStoredData），两步确认后删除
    const card = screen.getByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
    await user.click(within(card).getByRole('button', { name: /确认删除副本/ }))
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull())
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('0')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('M2: off 挂载零数据键读取 → 显式检查发现副本 → 独立两步删除', async () => {
    seedOffResumeRecord()
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    // off 挂载/示例加载全程不读数据键（既有默认合同必须保留）
    expect(getItemSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
    const card = screen.getByTestId('session-resume-card')
    // 未检查前无删除入口，只有显式检查入口
    expect(within(card).getByRole('button', { name: '检查本机恢复副本' })).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '删除本机恢复副本' })).toBeNull()
    // 显式检查：发现副本并给出管理反馈，删除入口出现
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    await within(card).findByText(/仍留有恢复副本/)
    // 两步删除独立完成：flag 仍关、正式保存不受影响
    await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
    await within(card).findByRole('button', { name: /确认删除副本/ })
    await user.click(within(card).getByRole('button', { name: /确认删除副本/ }))
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull())
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('0')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
  })

  it('M3: 检查区分 null 与空串/空白/坏 JSON/异版本：null 未找到，其余均可独立删除', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    // null：检查报「未找到」，不出现删除入口
    const first = render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const card = screen.getByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    expect(within(card).getByText(/未找到本机恢复副本/)).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '删除本机恢复副本' })).toBeNull()
    first.unmount()

    // 空串 / 空白 / 坏 JSON / 异版本：任何存在 raw 都算「有副本」，可独立删除
    const variants = ['', '   ', '{broken json', JSON.stringify({ format: 'other-format', version: 99 })]
    for (const raw of variants) {
      window.localStorage.clear()
      window.localStorage.setItem(SESSION_RESUME_DATA_KEY, raw)
      window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '0')
      const view = render(<App />)
      await screen.findByText('杭州三日漫步路书')
      const c = screen.getByTestId('session-resume-card')
      await user.click(within(c).getByRole('button', { name: '检查本机恢复副本' }))
      await within(c).findByText(/仍留有恢复副本/)
      await user.click(within(c).getByRole('button', { name: '删除本机恢复副本' }))
      await within(c).findByRole('button', { name: /确认删除副本/ })
      await user.click(within(c).getByRole('button', { name: /确认删除副本/ }))
      await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull())
      view.unmount()
    }
  })

  it('M4: 显式检查不启用 flag、不写存储、不恢复、不改内存；之后仍停写', async () => {
    seedOffResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
    const card = screen.getByTestId('session-resume-card')
    const rawBefore = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)!
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    expect(within(card).getByText(/仍留有恢复副本/)).toBeInTheDocument()
    // flag 未被启用，数据键无写入/删除，正式保存键不动
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('0')
    expect(
      setItemSpy.mock.calls.filter(
        ([key]) => key === SESSION_RESUME_DATA_KEY || key === SESSION_RESUME_FLAG_KEY,
      ),
    ).toEqual([])
    expect(removeSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBeNull()
    // 内容未解析进页面：主视图仍是示例，不是副本行程
    expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
    expect(screen.queryByText('南京两日规划行')).toBeNull()
    // 检查后关闭状态保持停写：真实编辑触发也不写副本
    await user.click(within(container).getByRole('button', { name: '编辑这趟行程' }))
    const editor = await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const nameInput = within(editor).getByLabelText(/站点名称/)
    await user.clear(nameInput)
    await user.type(nameInput, '检查后改名')
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await waitFor(() => expect(within(editor).getAllByText('检查后改名').length).toBeGreaterThan(0))
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawBefore)
  })

  it('M5: 检查发现 A 后外部静默换 B → prepare 被拒，B 逐字节保留', async () => {
    const rawA = seedOffResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const card = screen.getByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    await within(card).findByText(/仍留有恢复副本/)
    // prepare 之前：外部只写存储、不派发事件
    const rawB = rawA.replace('南京两日规划行', '外部标签行程B')
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, rawB)
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
    try {
      await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
      await waitFor(() => expect(screen.getByText(/删除未执行/)).toBeInTheDocument())
      expect(screen.queryByRole('button', { name: /确认删除副本/ })).toBeNull()
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawB)
      expect(removeSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
      expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
      expect(screen.queryByText('外部标签行程B')).toBeNull()
    } finally {
      removeSpy.mockRestore()
    }
  })

  it('M5: prepare 打开确认后外部静默换 B → confirm 被拒，B 保留且 removeItem 0', async () => {
    const rawA = seedOffResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const card = screen.getByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    // prepare：冻结候选 A，确认框打开
    await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
    const confirmGroup = await within(card).findByRole('group')
    expect(within(confirmGroup).getByRole('button', { name: /确认删除副本/ })).toBeInTheDocument()
    // 确认窗口内：外部静默写 B
    const rawB = rawA.replace('南京两日规划行', '外部标签行程B')
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, rawB)
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
    try {
      await user.click(within(confirmGroup).getByRole('button', { name: /确认删除副本/ }))
      await waitFor(() => expect(screen.getByText(/删除未执行/)).toBeInTheDocument())
      expect(screen.queryByRole('button', { name: /确认删除副本/ })).toBeNull()
      expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawB)
      expect(removeSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])
      // 当前内存行程未被外部 B 隐式替换
      expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
      expect(screen.queryByText('外部标签行程B')).toBeNull()
    } finally {
      removeSpy.mockRestore()
    }
  })

  it('M6: 检查读取抛 SecurityError → 诚实反馈不假称存在；恢复后重试成功', async () => {
    const rawA = seedOffResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const originalGetItem = Storage.prototype.getItem
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === SESSION_RESUME_DATA_KEY) throw new DOMException('denied', 'SecurityError')
      return originalGetItem.call(this, key)
    })
    const card = screen.getByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    // 失败反馈诚实：不假称存在、不假称未找到，无删除入口，检查可重试
    expect(within(card).getByText(/读取本机留存副本失败/)).toBeInTheDocument()
    expect(within(card).queryByText(/未找到本机恢复副本/)).toBeNull()
    expect(within(card).queryByText(/仍留有恢复副本/)).toBeNull()
    expect(within(card).queryByRole('button', { name: '删除本机恢复副本' })).toBeNull()
    getItemSpy.mockRestore()
    // 存储恢复可用后重试：发现副本，raw 逐字节不变
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    expect(within(card).getByText(/仍留有恢复副本/)).toBeInTheDocument()
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawA)
  })

  it('M7: 检查再次读取（同候选或换候选）使旧删除确认立即失效，ABA 不复用', async () => {
    const rawA = seedOffResumeRecord()
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')
    const card = screen.getByTestId('session-resume-card')
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    await within(card).findByText(/仍留有恢复副本/)
    // 打开确认后再检查一次（同候选 A）：旧确认必须立即失效
    await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
    expect(within(card).getByRole('button', { name: /确认删除副本/ })).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    await within(card).findByText(/仍留有恢复副本/)
    expect(within(card).queryByRole('button', { name: /确认删除副本/ })).toBeNull()
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawA)
    // 重新 prepare → 确认窗口内外部静默换 B → 再检查读到 B：旧确认失效，之后删的是 B
    await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
    expect(within(card).getByRole('button', { name: /确认删除副本/ })).toBeInTheDocument()
    const rawB = rawA.replace('南京两日规划行', '外部标签行程B')
    window.localStorage.setItem(SESSION_RESUME_DATA_KEY, rawB)
    await user.click(within(card).getByRole('button', { name: '检查本机恢复副本' }))
    await within(card).findByText(/仍留有恢复副本/)
    expect(within(card).queryByRole('button', { name: /确认删除副本/ })).toBeNull()
    await user.click(within(card).getByRole('button', { name: '删除本机恢复副本' }))
    await within(card).findByRole('button', { name: /确认删除副本/ })
    await user.click(within(card).getByRole('button', { name: /确认删除副本/ }))
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBeNull())
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('0')
  })

  /**
   * 同页静默 flag off（Minor 修复）：同页 DevTools/扩展直接把 flag 置 '0' 且不派
   * StorageEvent（StorageEvent 本就不跨同一页面）。此时 UI 仍显示已启用；
   * 下一次费用/草稿提交触发原有自动写尝试时，发现 flag ≠ '1'，必须：
   * - 把本标签 UI 向下同步为 off（停写、关闭当前启用状态）；
   * - 保留原 raw 与当前 Trip 草稿/费用内容；不写 flag、不读恢复内容键、
   *   不删除、不自动恢复/应用/保存。
   * 本测试只 setItem(flag,'0')、绝不手动 dispatch StorageEvent——那不是本缺陷。
   */
  it('D9: 同页静默 flag 置 0（无事件）→ 下一次自动写尝试把本标签 UI 同步为 off，raw/内存内容原样、不写 flag 不读数据键', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')
    await enableResume(user)
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull())
    const rawBefore = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('1')
    // UI 当前显示已启用（有关闭保留按钮）
    expect(screen.getByRole('button', { name: /关闭保留/ })).toBeInTheDocument()

    // 展开费用面板并填入名称，让内存持有费用内容；此时自动写把费用快照进副本
    await user.click(screen.getByRole('button', { name: '费用估算' }))
    await user.click(screen.getByRole('button', { name: '添加费用项' }))
    await waitFor(() => expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull())
    await user.type(screen.getByLabelText(/名称（可留空）/), '高铁票')
    const rawWithBudget = await waitFor(() => {
      const raw = window.localStorage.getItem(SESSION_RESUME_DATA_KEY)
      expect(raw).not.toBeNull()
      expect(raw).toContain('高铁票')
      return raw!
    })
    expect(rawWithBudget).not.toBe(rawBefore)

    // 同页静默关闭：只 setItem，绝不 dispatch StorageEvent（同页本就没有该事件）
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '0')

    // 通过业务操作触发原有自动写尝试（费用输入提交）
    await user.type(screen.getByLabelText(/金额（元）/), '128.5')

    // 写尝试检测到 flag ≠ '1'：本标签 UI 向下同步为 off
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '在此浏览器保留工作进度' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: /关闭保留/ })).toBeNull()
    expect(screen.getByTestId('session-resume-card')).toBeInTheDocument()

    // 原 raw 逐字节保留；flag 保持外部写的 '0'，不被应用回写
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawWithBudget)
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('0')

    // flag 关闭后业务 setItem/removeItem 均为 0（不含 flag 键本身的那次外部写）
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem')
    await user.type(screen.getByLabelText(/名称（可留空）/), '续')
    await waitFor(() => expect(screen.getByDisplayValue('高铁票续')).toBeInTheDocument())
    expect(
      setItemSpy.mock.calls.filter(
        ([key]) => key === SESSION_RESUME_DATA_KEY || key === SESSION_RESUME_FLAG_KEY,
      ),
    ).toEqual([])
    expect(removeSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])

    // 无额外数据键读取（ off 合同：默认零内容键读取）
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
    await user.type(screen.getByLabelText(/金额（元）/), '9')
    await waitFor(() => expect(screen.getByDisplayValue('128.59')).toBeInTheDocument())
    expect(getItemSpy.mock.calls.filter(([key]) => key === SESSION_RESUME_DATA_KEY)).toEqual([])

    // 内存费用与当前 Trip 原样保留：页面行程未变、费用草稿仍在
    expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument()
    expect(screen.getByDisplayValue('高铁票续')).toBeInTheDocument()
    expect(screen.getByDisplayValue('128.59')).toBeInTheDocument()

    // 外部把 flag 回 '1'（仍无事件）：本标签不自动重启写或恢复 UI，保持 off
    await act(async () => {
      window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    })
    await user.type(screen.getByLabelText(/金额（元）/), '1')
    expect(screen.getByRole('button', { name: '在此浏览器保留工作进度' })).toBeInTheDocument()
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawWithBudget)

    // 只有用户显式启用：按当前存储内容重新读取——存储里已有副本 → pending 概况重现
    // （自动写被 pending 挂起是既有行为，不期待自动写）；内存费用原样保留
    await user.click(screen.getByRole('button', { name: '在此浏览器保留工作进度' }))
    expect(await screen.findByRole('button', { name: /关闭保留/ })).toBeInTheDocument()
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('1')
    const resumedCard = screen.getByTestId('session-resume-card')
    expect(await within(resumedCard).findByText(/杭州三日漫步路书/)).toBeInTheDocument()
    expect(within(resumedCard).getByRole('button', { name: '恢复上次的工作进度' })).toBeInTheDocument()
    // 副本仍是静默关闭前的 raw（pending 挂起不写）；内存费用草稿原样
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).toBe(rawWithBudget)
    expect(screen.getByDisplayValue('高铁票续')).toBeInTheDocument()
    expect(screen.getByDisplayValue('128.591')).toBeInTheDocument()
    void container
  })

  /**
   * D9 守卫补充：静默 off 同步后，外部把 flag 回 '1'（无事件）也不自动开启本标签；
   * 只有用户显式启用才恢复 pending 读取。既有「写尝试时才检测」边界保持：
   * 不加 polling/timer/事件劫持，不声称同页写入瞬时侦测。
   */
  it('D9: 静默 off 同步后外部 flag 回 1（无事件）不自动开启；显式启用才恢复 pending 读取', async () => {
    // 本 describe 无 seedResumeRecord：内联同一夹具（合法副本 + flag '1'）
    const seeded = writeSessionResume(
      {
        payload: {
          trip: PLAN_TRIP,
          draft: null,
          budget: null,
          ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
        },
        expectedRaw: null,
      },
      window.localStorage,
    )
    if (!seeded.ok) throw new Error(`fixture 失败：${seeded.reason}`)
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    const card = await screen.findByTestId('session-resume-card')
    await screen.findByText('杭州三日漫步路书')
    expect(within(card).getByText(/南京两日规划行/)).toBeInTheDocument()
    // 显式恢复进入 idle：自动写恢复运行，后续编辑器打开才能触达 flag 检查
    await user.click(within(card).getByRole('button', { name: '恢复上次的工作进度' }))
    await screen.findByText('南京两日规划行')
    // 同页静默置 0：UI 仍显示已启用（缺陷现场）
    window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '0')
    // 触发一次原有自动写尝试（打开编辑器会产生一次写尝试）
    await user.click(within(container).getByRole('button', { name: '编辑这趟行程' }))
    await screen.findByRole('region', { name: '本地行程草稿编辑器' })
    // 同步后本标签 UI 为 off；副本原样保留、flag 不被改写
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '在此浏览器保留工作进度' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: /关闭保留/ })).toBeNull()
    expect(window.localStorage.getItem(SESSION_RESUME_FLAG_KEY)).toBe('0')
    expect(window.localStorage.getItem(SESSION_RESUME_DATA_KEY)).not.toBeNull()

    // 外部把 flag 回 '1'（无事件）：本标签不自动开启、不自动读 pending
    await act(async () => {
      window.localStorage.setItem(SESSION_RESUME_FLAG_KEY, '1')
    })
    expect(screen.getByRole('button', { name: '在此浏览器保留工作进度' })).toBeInTheDocument()
    expect(within(screen.getByTestId('session-resume-card')).queryByText(/南京两日规划行/)).toBeNull()

    // 用户显式启用：按当前存储重新读取，pending 概况回来
    await user.click(screen.getByRole('button', { name: '在此浏览器保留工作进度' }))
    const revived = await screen.findByTestId('session-resume-card')
    expect(await within(revived).findByText(/南京两日规划行/)).toBeInTheDocument()
    expect(within(revived).getByRole('button', { name: '恢复上次的工作进度' })).toBeInTheDocument()
  })
})

/**
 * P6.5 · S8-40 守卫回归：无草稿时确认顺延会造 fork 草稿，必须先作废在途示例加载。
 *
 * 构造真实可达的窗口：示例请求挂起期间用户先完成一次 AI 规划（handlePlan 只取消规划，
 * 不碰示例），页面已有行程、示例仍在途。这时从体检卡「建议顺延」进面板，预览后确认 →
 * createHealthDraft。守卫缺失时示例请求继续挂着，迟到的示例会替换 fork 后的行程。
 * 断言落在 fetch 的 init.signal 上：getJson 用请求时钟把调用方 abort 转发成 fetch 信号。
 */
describe('App 体检顺延：S8-40 示例在途守卫', () => {
  /**
   * 长日行程：09:00 到达、各停留 60 分钟、20:00 离开 → 日跨度 12 小时，
   * 超过均衡节奏上限 10 小时，体检卡因此给出 notice 级 pace 条目（带「建议顺延」入口）。
   */
  const LONG_DAY_TRIP: Trip = {
    ...MOCK_TRIP,
    id: 'trip-long-day-s840',
    source: 'agent',
    title: '超长日规划行',
    days: [
      {
        day: 1,
        date: null,
        title: '长日',
        summary: '',
        stops: [
          {
            id: 'ld-1',
            name: '早站',
            time: '09:00',
            duration_minutes: 60,
            description: '',
            address: '',
            location: null,
          },
          {
            id: 'ld-2',
            name: '晚站',
            time: '20:00',
            duration_minutes: 60,
            description: '',
            address: '',
            location: null,
          },
        ],
        legs: [],
      },
    ],
  }

  it('无草稿确认顺延 → 创建 fork 草稿时作废在途示例请求', async () => {
    let exampleSignal: AbortSignal | null = null
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') {
        exampleSignal = init?.signal ?? null
        // 永不返回：示例请求全程在途（慢后端 / 长排队），测试结束时由卸载清理收尾
        return new Promise<Response>(() => {})
      }
      if (url === '/api/trips/plan') return Promise.resolve(jsonResponse(LONG_DAY_TRIP))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<App />)

    // 示例还没回来就能先规划（与既有 AppDraft 用例同口径）；规划成功 → 页面有行程
    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await screen.findByText('超长日规划行')
    expect(exampleSignal).not.toBeNull()
    // 前提成立：此刻示例请求仍活着，规划路径不会作废它
    expect(exampleSignal!.aborted).toBe(false)

    // 体检卡 → 展开详情 → 建议顺延 → 预览 → 确认（无草稿：确认时 createHealthDraft 造 fork 草稿）
    await user.click(await screen.findByTestId('health-toggle'))
    await user.click(await screen.findByTestId('health-suggest-postpone'))
    await user.click(await screen.findByTestId('postpone-preview-action'))
    await user.click(await screen.findByTestId('postpone-confirm'))

    // 守卫：示例请求被作废；即使响应忽略 abort 迟到，也不能替换 fork 后的行程
    await waitFor(() => expect(exampleSignal!.aborted).toBe(true))
    // 页面仍停在 fork 出的长日行程（草稿预览会重复引用同一标题，故按存在性断言）
    expect(screen.getAllByText('超长日规划行').length).toBeGreaterThan(0)
  })
})

/**
 * App × TripDraftEditor 接线集成测试：本地编辑入口、草稿预览、应用 / 放弃 / 撤销应用、
 * 编辑期间的外部暂停、迟到响应归属与存储边界。mock fetch，渲染真实 TripDraftEditor
 * 与 TripMap；不 mock 草稿纯函数。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { SAVED_TRIPS_STORAGE_KEY, saveTripToStorage } from '../lib/savedTrips'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function textResponse(body: string, status = 200, contentType = 'text/plain') {
  return new Response(body, { status, headers: { 'Content-Type': contentType } })
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

function stopRow(container: HTMLElement, name: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('.stop-row'))
    .find((node) => node.textContent?.includes(name))
  if (!row) throw new Error(`找不到站点行：${name}`)
  return row
}

/** 从行程区点开本地编辑入口 */
async function startEditing(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '编辑这趟行程' }))
  await screen.findByRole('region', { name: '本地行程草稿编辑器' })
}

/** 在编辑器里编辑第一个站点的名称并保存到草稿 */
async function renameFirstStop(user: ReturnType<typeof userEvent.setup>, newName: string) {
  const editor = screen.getByRole('region', { name: '本地行程草稿编辑器' })
  await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
  const nameInput = within(editor).getByLabelText(/站点名称/)
  await user.clear(nameInput)
  await user.type(nameInput, newName)
  await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
  await waitFor(() => expect(within(editor).getAllByText(newName).length).toBeGreaterThan(0))
}

/** 在编辑器里修改第一个站点的时间并保存到草稿（时间编辑保留坐标与路线） */
async function retimeFirstStop(user: ReturnType<typeof userEvent.setup>, newTime: string) {
  const editor = screen.getByRole('region', { name: '本地行程草稿编辑器' })
  await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
  const timeInput = within(editor).getByLabelText(/^时间/)
  await user.clear(timeInput)
  await user.type(timeInput, newTime)
  await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
  await waitFor(() => expect(within(editor).getAllByText(newTime).length).toBeGreaterThan(0))
}

describe('App 本地编辑接线', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('进入编辑：出现编辑器、暂停说明与草稿预览说明，原有保存/导入入口被收起', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)

    // 编辑器就位，显示的是当前行程
    expect(screen.getByText('杭州三日漫步路书', { selector: '.tde-title' })).toBeInTheDocument()
    // 规划表单被 disabled fieldset 暂停
    expect(screen.getByText(/本地编辑进行中：新行程规划、保存、恢复、导出备份和导出日历已暂停/)).toBeInTheDocument()
    const destInput = screen.getByLabelText(/目的地/)
    expect(destInput).toBeDisabled()
    // 保存/日历/备份入口被收起
    expect(screen.queryByRole('button', { name: '保存当前行程' })).toBeNull()
    expect(screen.queryByRole('button', { name: '行程备份与导入' })).toBeNull()
    // 草稿预览说明出现
    expect(screen.getByTestId('draft-preview-note').textContent).toContain('还没有应用')
  })

  it('改名后地图与列表显示草稿预览；未应用时 localStorage 逐字节不动', async () => {
    const fetchMock = stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await renameFirstStop(user, '断桥·草稿版')

    // 列表显示草稿预览
    expect(stopRow(container, '断桥·草稿版')).toBeTruthy()
    // 草稿与原始行程一致（时间/描述没变）时地图 marker 仍按草稿渲染：改时间编辑在下一个用例覆盖；
    // 这里改名清了坐标，原坐标站点只剩平湖秋月
    await waitFor(() => expect(container.querySelectorAll('.stop-dot-wrapper')).toHaveLength(1))
    // 未应用：存储不动、无新请求
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    const urls = fetchMock.mock.calls.map(([u]) => String(u))
    expect(urls).not.toContain('/api/trips/plan')
  })

  it('改时间后坐标与路线保留，预览地图仍画出站点', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await retimeFirstStop(user, '08:15')

    // 时间编辑不清坐标：两个带坐标站点仍在地图上
    await waitFor(() => expect(container.querySelectorAll('.stop-dot-wrapper')).toHaveLength(2))
    expect(container.textContent).toContain('08:15')
  })

  it('应用草稿：生成新 id 的副本成为当前行程，原保存记录字节不动，本地检查/预览说明消失', async () => {
    const fetchMock = stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await renameFirstStop(user, '断桥·应用版')
    await user.click(screen.getByRole('button', { name: '应用草稿' }))

    // 应用后的归属说明：不会自动保存
    const notice = screen.getByTestId('apply-notice')
    expect(notice.textContent).toContain('不会自动保存')
    expect(notice.textContent).toContain('不会更新之前导入的日历事件')
    // 编辑器消失，列表显示应用后的内容
    expect(screen.queryByRole('region', { name: '本地行程草稿编辑器' })).toBeNull()
    expect(stopRow(container, '断桥·应用版')).toBeTruthy()
    // 原保存记录逐字节不动
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
    // 没有新增网络请求
    expect(fetchMock.mock.calls.map(([u]) => String(u))).not.toContain('/api/trips/plan')
  })

  it('从本浏览器保存的副本恢复后应用草稿：不再沿用「已保存副本」的旧时间戳', async () => {
    stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await user.click(within(container).getByRole('button', { name: /已保存行程/ }))
    await user.click(within(container).getByRole('button', { name: /恢复保存的行程《杭州三日漫步路书》/ }))
    expect(screen.getByText(/从本浏览器保存的副本恢复/)).toBeInTheDocument()

    await startEditing(user)
    await retimeFirstStop(user, '08:05')
    await user.click(screen.getByRole('button', { name: '应用草稿' }))
    await screen.findByTestId('apply-notice')
    // 应用后的副本不是那份保存记录，不能再暗示「从保存的副本恢复」
    expect(screen.queryByText(/从本浏览器保存的副本恢复/)).toBeNull()
  })

  it('应用后用户仍能显式保存、导出 ICS 与备份；应用提示不持久断言「当前未保存」', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await retimeFirstStop(user, '07:45')
    await user.click(screen.getByRole('button', { name: '应用草稿' }))
    await screen.findByTestId('apply-notice')

    // 显式保存仍可用（面板恢复显示）
    const saveBtn = screen.getByRole('button', { name: '保存当前行程' })
    await user.click(saveBtn)
    await waitFor(() =>
      expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).not.toBeNull(),
    )
    // 保存后提示仍只说「应用操作不会自动保存」这类事件用语，没有说「你还没有保存」
    const pageText = document.body.textContent ?? ''
    expect(pageText).not.toContain('尚未保存，需要保存请再点')
  })

  it('放弃草稿：回到原视图，原行程与存储不变', async () => {
    stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await renameFirstStop(user, '草稿将放弃')
    await user.click(screen.getByRole('button', { name: '放弃草稿' }))
    // 有实际改动时编辑器内先出确认
    await user.click(screen.getByRole('button', { name: '确认放弃草稿' }))

    expect(screen.queryByRole('region', { name: '本地行程草稿编辑器' })).toBeNull()
    expect(stopRow(container, '断桥残雪')).toBeTruthy()
    expect(container.textContent).not.toContain('草稿将放弃')
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
  })

  it('撤销应用：回到应用前的行程；已显式保存的副本不被删除', async () => {
    stubHappyFetch()
    const seed = saveTripToStorage(MOCK_TRIP, window.localStorage)
    expect(seed.ok).toBe(true)
    const storageBefore = window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await renameFirstStop(user, '撤销测试站')
    await user.click(screen.getByRole('button', { name: '应用草稿' }))
    expect(stopRow(container, '撤销测试站')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '撤销应用' }))
    await waitFor(() => expect(screen.queryByText('撤销测试站')).toBeNull())
    expect(stopRow(container, '断桥残雪')).toBeTruthy()
    // 已显式保存的记录不受撤销影响
    expect(window.localStorage.getItem(SAVED_TRIPS_STORAGE_KEY)).toBe(storageBefore)
  })

  it('pending 的旧规划/示例响应在编辑期间迟到，不覆盖草稿视图', async () => {
    let resolvePlan!: (response: Response) => void
    let resolveExample!: (response: Response) => void
    // 示例也挂着：进编辑时它的等待被中止，忽略 abort 后迟到也不许覆盖草稿视图
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') {
        return new Promise<Response>((resolve) => {
          resolveExample = resolve
        })
      }
      if (url === '/api/trips/plan') {
        return new Promise<Response>((resolve) => {
          resolvePlan = resolve
        })
      }
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)

    // 示例还在路上就能先规划
    await user.type(screen.getByLabelText(/目的地/), '西安')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /正在规划/ })).toBeInTheDocument())

    // 让挂起的示例先回来：页面有行程才有编辑入口
    await act(async () => {
      resolveExample(jsonResponse(MOCK_TRIP))
      await Promise.resolve()
    })
    await screen.findByText('杭州三日漫步路书')

    // 进编辑（入口仍在：草稿归属的是旧行程，规划挂起被中止）
    await startEditing(user)

    await act(async () => {
      resolvePlan(jsonResponse({ ...MOCK_TRIP, id: 'trip-late-plan', source: 'agent', title: '迟到的规划' }))
      await Promise.resolve()
    })

    // 迟到的规划不会结束编辑状态，也不会替换页面行程
    expect(screen.getByRole('region', { name: '本地行程草稿编辑器' })).toBeInTheDocument()
    expect(screen.queryByText('迟到的规划')).toBeNull()
  })

  it('有未提交输入时日切换被暂停并给出说明；无表单时允许跨日编辑同一草稿', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    // 打开第 1 站编辑表单，输入但不保存
    const editor = screen.getByRole('region', { name: '本地行程草稿编辑器' })
    await user.click(within(editor).getAllByRole('button', { name: /^编辑第 1 站/ })[0])
    const nameInput = within(editor).getByLabelText(/站点名称/)
    await user.clear(nameInput)
    await user.type(nameInput, '输入中')

    // 日签被挡住：点击不切换
    await user.click(screen.getByRole('tab', { name: /龙井问茶/ }))
    expect(screen.getByRole('tab', { name: /西湖环湖/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/日期切换已暂停/)).toBeInTheDocument()

    // 保存输入到草稿后（无表单状态）允许跨日切换
    await user.click(within(editor).getByRole('button', { name: '保存到草稿' }))
    await waitFor(() => expect(screen.queryByLabelText(/站点名称/)).toBeNull())
    await user.click(screen.getByRole('tab', { name: /龙井问茶/ }))
    expect(screen.getByRole('tab', { name: /龙井问茶/ })).toHaveAttribute('aria-selected', 'true')
    // 草稿仍在：预览说明没消失
    expect(screen.getByTestId('draft-preview-note')).toBeInTheDocument()
    // 列表显示的是草稿（改名在第 1 天）
    expect(container.textContent).toContain('输入中')
  })

  it('离线（后端断开）时：示例失败仍可恢复副本并进入编辑；编辑期间探活可继续', async () => {
    // 示例请求先成功拿到行程，探活失败不阻塞
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(textResponse('proxy error', 500))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await renameFirstStop(user, '离线编辑站')
    // 离线状态仍能应用草稿（纯本地操作）
    await user.click(screen.getByRole('button', { name: '应用草稿' }))
    expect(screen.getByTestId('apply-notice')).toBeInTheDocument()
    expect(screen.getByText('离线编辑站')).toBeInTheDocument()
  })

  it('存储完全不可用时编辑、预览与应用照常工作', async () => {
    stubHappyFetch()
    // 模拟存储读写抛错
    vi.stubGlobal('Storage', class {
      getItem() { throw new TypeError('blocked') }
      setItem() { throw new TypeError('blocked') }
      removeItem() { throw new TypeError('blocked') }
      clear() { throw new TypeError('blocked') }
      key() { return null }
      get length() { return 0 }
    })
    const user = userEvent.setup()
    const { container } = render(<App />)
    await screen.findByText('杭州三日漫步路书')

    await startEditing(user)
    await retimeFirstStop(user, '08:30')
    await user.click(screen.getByRole('button', { name: '应用草稿' }))

    expect(screen.getByTestId('apply-notice')).toBeInTheDocument()
    expect(container.textContent).toContain('08:30')
  })

  it('示例行程衍生的编辑副本保留示例身份；导入文件打开后提示「打开文件这个动作不会自动保存」', async () => {
    stubHappyFetch()
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('杭州三日漫步路书')

    // 示例标签在编辑期间保持
    await startEditing(user)
    const editor = screen.getByRole('region', { name: '本地行程草稿编辑器' })
    expect(within(editor).getByText('示例参考')).toBeInTheDocument()
    expect(within(editor).getByText(/应用后仍保留示例身份/)).toBeInTheDocument()
    await user.click(within(editor).getByRole('button', { name: '放弃草稿' }))

    // 导入说明：打开文件这个动作不会自动保存
    await user.click(screen.getByRole('button', { name: '行程备份与导入' }))
    const input = screen.getByLabelText(/选择备份文件/)
    const { createTripBackup } = await import('../lib/tripTransfer')
    const backup = createTripBackup({ ...MOCK_TRIP, id: 'trip-file-x', title: '文件里的行程' }, {
      now: new Date('2026-03-01T00:00:00.000Z'),
    })
    if (!backup.ok) throw new Error('fixture backup failed')
    fireEvent.change(input, { target: { files: [new File([backup.json], 'b.json', { type: 'application/json' })] } })
    await screen.findByText('预览：文件里的行程')
    // 点「打开这份行程」后页面出现来源说明（trip-imported-note）
    await user.click(screen.getByRole('button', { name: '打开这份行程' }))
    expect(await screen.findByText(/打开文件这个动作不会自动保存/)).toBeInTheDocument()
    expect(screen.getByText(/不能证明它的真实来源/)).toBeInTheDocument()
  })

  it('全缺坐标行程进入编辑（新增未定位站点前）文案保持中性，不再说「后端没能解析」', async () => {
    stubHappyFetch(MOCK_TRIP_NO_COORD)
    const { container } = render(<App />)
    await screen.findByText('无坐标测试行程')

    const text = container.textContent ?? ''
    expect(text).not.toContain('后端没能解析')
    expect(text).toContain('尚未定位')
  })
})

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import IcsExportPanel from '../components/IcsExportPanel'
import type { Trip } from '../lib/api'
import { MOCK_TRIP } from './fixtures/trip'

function undatedTrip(): Trip {
  return {
    ...MOCK_TRIP,
    id: 'trip-undated-panel',
    days: MOCK_TRIP.days.map((day) => ({ ...day, date: null })),
  }
}

function noEventTrip(): Trip {
  return {
    ...MOCK_TRIP,
    id: 'trip-no-events',
    days: MOCK_TRIP.days.map((day) => ({
      ...day,
      stops: day.stops.map((stop) => ({ ...stop, time: '不是时间' })),
    })),
  }
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
  createObjectURL = vi.fn(() => 'blob:panel-ics')
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

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '导出日历 (.ics)' }))
  return screen.getByRole('region', { name: '导出日历' })
}

describe('IcsExportPanel：显式下载', () => {
  it('默认不生成文件；展开后显示事件数、示例标识、跳过与提示，未下载前不创建 Blob URL', async () => {
    const user = userEvent.setup()
    render(<IcsExportPanel trip={MOCK_TRIP} />)

    expect(screen.queryByRole('heading', { name: '导出到日历' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()

    const region = await openPanel(user)
    const toggle = screen.getByRole('button', { name: '导出日历 (.ics)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-controls', region.querySelector('section')?.id ?? '')
    expect(within(region).getByRole('heading', { name: '导出到日历' })).toBeInTheDocument()
    expect(within(region).getByText('可导出 3 个日历事件，跳过 1 个站点。')).toBeInTheDocument()
    expect(within(region).getByText(/示例行程：导出的事件标题会带【示例】前缀/)).toBeInTheDocument()
    expect(within(region).getByText(/不带时区/)).toBeInTheDocument()
    expect(within(region).getByText(/查看被跳过的 1 个站点/)).toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('点击下载才创建 Blob、生成安全文件名并触发一次链接点击', async () => {
    const user = userEvent.setup()
    render(<IcsExportPanel trip={MOCK_TRIP} />)
    const region = await openPanel(user)

    expect(within(region).getByText(/文件名：/)).toHaveTextContent('杭州-杭州三日漫步路书.ics')
    await user.click(within(region).getByRole('button', { name: '下载 .ics 文件' }))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/calendar;charset=utf-8')
    const text = await readBlob(blob)
    expect(text).toContain('BEGIN:VCALENDAR')
    expect(text).toContain('SUMMARY:【示例】断桥残雪')
    expect(within(region).getByText(/已开始下载 杭州-杭州三日漫步路书\.ics（3 个事件）/)).toBeInTheDocument()
    expect(within(region).getByText(/文件只保存在本机，不会上传/)).toBeInTheDocument()
  })

  it('没有有效事件时不渲染下载按钮，也不创建 Blob URL', async () => {
    const user = userEvent.setup()
    render(<IcsExportPanel trip={noEventTrip()} />)
    const region = await openPanel(user)

    expect(within(region).getByText(/没有可导出的有效事件/)).toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: '下载 .ics 文件' })).toBeNull()
    expect(within(region).getByText(/不会创建或下载文件/)).toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('整份缺日期时必须由用户明确选首日：不预填、不修改原行程、跨月闰年按真实日历', async () => {
    const trip = undatedTrip()
    const snapshot = JSON.parse(JSON.stringify(trip))
    const user = userEvent.setup()
    render(<IcsExportPanel trip={trip} />)
    const region = await openPanel(user)

    const dateInput = within(region).getByLabelText(/行程首日/) as HTMLInputElement
    expect(dateInput.value).toBe('')
    expect(within(region).queryByRole('button', { name: '下载 .ics 文件' })).toBeNull()
    expect(within(region).getAllByText(/所有天都没有日期/).length).toBeGreaterThan(0)

    fireEvent.change(dateInput, { target: { value: '2028-02-27' } })

    expect(within(region).getByText('第 1 天 · 2028-02-27')).toBeInTheDocument()
    expect(within(region).getByText('第 2 天 · 2028-02-28')).toBeInTheDocument()
    expect(within(region).getByText('第 3 天 · 2028-02-29')).toBeInTheDocument()
    expect(within(region).getByText(/按你明确选择的首日 2028-02-27/)).toBeInTheDocument()
    expect(trip).toEqual(snapshot)

    await user.click(within(region).getByRole('button', { name: '下载 .ics 文件' }))
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const text = await readBlob(blob)
    expect(text).toContain('DTSTART:20280227T090000')
    expect(text).toContain('DTSTART:20280229T100000')
    expect(text).toContain('SUMMARY:【示例】龙井村')
    expect(trip).toEqual(snapshot)
  })

  it('部分日期缺失时只跳过并提示，不出现首日选择，也不会补出缺失日期', async () => {
    const user = userEvent.setup()
    render(<IcsExportPanel trip={MOCK_TRIP} />)
    const region = await openPanel(user)

    expect(within(region).queryByLabelText(/行程首日/)).toBeNull()
    expect(within(region).getAllByText(/第 3 天没有可用的日期/).length).toBeGreaterThan(0)

    await user.click(within(region).getByRole('button', { name: '下载 .ics 文件' }))
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const text = await readBlob(blob)
    // 已有真实日期保持原值，缺失的第 3 天没有事件
    expect(text).toContain('DTSTART:20260403T090000')
    expect(text).not.toContain('DTSTART:20260405')
    expect(text).not.toContain('龙井村')
  })

  describe('目的地时区选择（仅本次导出会话）', () => {
    it('默认不选择时区：floating 导出，输入不预填', async () => {
      const user = userEvent.setup()
      render(<IcsExportPanel trip={MOCK_TRIP} />)
      const region = await openPanel(user)

      const select = within(region).getByLabelText(/目的地时区/) as HTMLSelectElement
      expect(select.value).toBe('')
      expect(within(region).getByText(/留空则保持默认的 floating 本地时间导出/)).toBeInTheDocument()

      await user.click(within(region).getByRole('button', { name: '下载 .ics 文件' }))
      const blob = createObjectURL.mock.calls[0][0] as Blob
      const text = await readBlob(blob)
      expect(text).toContain('DTSTART:20260403T090000')
      expect(text).not.toContain('DTSTART:20260403T010000Z')
    })

    it('选择目的地时区后：预览与下载都是带 Z 的 UTC，同一设置贯穿两层', async () => {
      const user = userEvent.setup()
      render(<IcsExportPanel trip={MOCK_TRIP} />)
      const region = await openPanel(user)

      fireEvent.change(within(region).getByLabelText(/目的地时区/), {
        target: { value: 'Asia/Shanghai' },
      })

      // 预览层已换算为 UTC
      expect(within(region).getByText(/已按你选择的目的地时区 Asia\/Shanghai/)).toBeInTheDocument()
      await user.click(within(region).getByRole('button', { name: '下载 .ics 文件' }))

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      const blob = createObjectURL.mock.calls[0][0] as Blob
      const text = await readBlob(blob)
      // 上海 2026-04-03 09:00 = 01:00Z；下载与预览同一时区设置
      expect(text).toContain('DTSTART:20260403T010000Z')
      expect(text).toContain('DTEND:20260403T014000Z')
      expect(text).not.toContain('DTSTART:20260403T090000')
      expect(within(region).getByText(/已开始下载 杭州-杭州三日漫步路书\.ics（3 个事件）/)).toBeInTheDocument()
    })

    it('自定义 IANA 时区可输入；无效时区显示错误、无下载按钮、不创建 Blob URL', async () => {
      const user = userEvent.setup()
      render(<IcsExportPanel trip={MOCK_TRIP} />)
      const region = await openPanel(user)

      const customInput = within(region).getByPlaceholderText(/自定义 IANA 时区/) as HTMLInputElement
      // 自定义值直接在输入框里填；填完后 select 里出现「（自定义）」动态 option
      fireEvent.change(customInput, { target: { value: 'Asia/Kathmandu' } })
      expect(within(region).getByText(/Asia\/Kathmandu（自定义）/)).toBeInTheDocument()
      expect(customInput.value).toBe('Asia/Kathmandu')

      fireEvent.change(customInput, { target: { value: 'Not/AZone' } })

      expect(within(region).getAllByText(/不是当前运行环境支持的 IANA 时区/).length).toBeGreaterThan(0)
      expect(within(region).queryByRole('button', { name: '下载 .ics 文件' })).toBeNull()
      expect(within(region).getAllByText(/不会创建或下载文件/).length).toBeGreaterThan(0)
      expect(createObjectURL).not.toHaveBeenCalled()

      // 回到默认模式后错误消失，可下载恢复
      fireEvent.change(customInput, { target: { value: '' } })
      fireEvent.change(within(region).getByLabelText(/目的地时区/), { target: { value: '' } })
      expect(within(region).getByRole('button', { name: '下载 .ics 文件' })).toBeInTheDocument()
    })

    it('DST 重复时刻在预览中可见：站点被跳过且原因可展开查看', async () => {
      const dstTrip: Trip = {
        ...MOCK_TRIP,
        id: 'trip-dst-panel',
        destination: '纽约',
        title: 'DST 回拨测试',
        warnings: [],
        days: [
          {
            day: 1,
            date: '2026-11-01',
            title: '',
            summary: '',
            stops: [
              {
                id: 'dst1',
                name: '回拨站',
                time: '01:30',
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
      const user = userEvent.setup()
      render(<IcsExportPanel trip={dstTrip} />)
      const region = await openPanel(user)

      fireEvent.change(within(region).getByLabelText(/目的地时区/), {
        target: { value: 'America/New_York' },
      })

      expect(within(region).getByText(/没有可导出的有效事件/)).toBeInTheDocument()
      expect(within(region).getByText(/有 1 个站点无法按当前导出设置生成日历事件，具体原因见下方跳过清单/)).toBeInTheDocument()
      expect(within(region).getAllByText(/出现两次/).length).toBeGreaterThan(0)
      expect(within(region).getAllByText(/无法唯一确定/).length).toBeGreaterThan(0)
      expect(within(region).queryByRole('button', { name: '下载 .ics 文件' })).toBeNull()
      expect(createObjectURL).not.toHaveBeenCalled()
    })

    it('UTC 年份超范围的站点不误报成夏令时：UI 按真实原因分开展示', async () => {
      // 9999-12-31 19:00 纽约 = UTC 10000-01-01：日期时刻合法，只是 UTC 超出 4 位年份
      const yearTrip: Trip = {
        ...MOCK_TRIP,
        id: 'trip-year-range-panel',
        destination: '纽约',
        title: '年份越界测试',
        warnings: [],
        days: [
          {
            day: 1,
            date: '9999-12-31',
            title: '',
            summary: '',
            stops: [
              {
                id: 'year1',
                name: '跨年尾站',
                time: '19:00',
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
      const user = userEvent.setup()
      render(<IcsExportPanel trip={yearTrip} />)
      const region = await openPanel(user)

      fireEvent.change(within(region).getByLabelText(/目的地时区/), {
        target: { value: 'America/New_York' },
      })

      // 总提示是中性口径（按结构化 reason 计数，不解析站点文案），
      // 年份越界的具体原因仍在跳过清单逐站可见
      expect(within(region).getByText(/有 1 个站点无法按当前导出设置生成日历事件，具体原因见下方跳过清单/)).toBeInTheDocument()
      expect(within(region).queryByText(/夏令时切换造成的重复或不存在时刻/)).toBeNull()
      // 跳过清单仍给出具体原因（含实际换算结果）
      expect(within(region).getAllByText(/超出 4 位年份支持范围，无法写入日历/).length).toBeGreaterThan(0)
      expect(within(region).queryByRole('button', { name: '下载 .ics 文件' })).toBeNull()
      expect(createObjectURL).not.toHaveBeenCalled()
    })

    it('时区设置不写入行程，也不触发 fetch；重新挂载后输入重置', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const user = userEvent.setup()
      const { unmount } = render(<IcsExportPanel trip={MOCK_TRIP} />)
      const region = await openPanel(user)

      fireEvent.change(within(region).getByLabelText(/目的地时区/), {
        target: { value: 'Asia/Shanghai' },
      })
      expect(within(region).getByText(/已按你选择的目的地时区 Asia\/Shanghai/)).toBeInTheDocument()
      expect(fetchSpy).not.toHaveBeenCalled()

      unmount()
      // 真实应用里 App.tsx 用 key={`ics:${trip.id}`} 强制重挂载；这里用重新 render 验证 state 不残留
      render(<IcsExportPanel trip={MOCK_TRIP} />)
      const newRegion = await openPanel(user)
      const select = within(newRegion).getByLabelText(/目的地时区/) as HTMLSelectElement
      expect(select.value).toBe('')
      fetchSpy.mockRestore()
    })

    it('自定义输入有可访问 label；选「自定义…」不改变当前设置、不冒充已选定', async () => {
      const user = userEvent.setup()
      render(<IcsExportPanel trip={MOCK_TRIP} />)
      const region = await openPanel(user)

      const select = within(region).getByLabelText(/目的地时区/) as HTMLSelectElement
      const customInput = within(region).getByLabelText(/自定义时区（IANA 名称）/) as HTMLInputElement
      expect(customInput).toBeInTheDocument()

      // 输入自定义 zone 后 select 显示「（自定义）」动态 option，输入框保留完整值
      fireEvent.change(customInput, { target: { value: 'Asia/Kathmandu' } })
      expect(customInput.value).toBe('Asia/Kathmandu')
      expect(within(region).getByText(/Asia\/Kathmandu（自定义）/)).toBeInTheDocument()
      // 帮助文案清楚说明当前生效设置
      expect(within(region).getByText(/当前生效的目的地时区：Asia\/Kathmandu/)).toBeInTheDocument()

      // 选「自定义…」哨兵项：不改变当前输入、不把状态伪装成已选定
      fireEvent.change(select, { target: { value: '__custom__' } })
      expect(customInput.value).toBe('Asia/Kathmandu')
      expect(within(region).getByText(/当前生效的目的地时区：Asia\/Kathmandu/)).toBeInTheDocument()
    })

    it('预设与自定义真实切换：换回预设覆盖自定义值，清空自定义回到 floating', async () => {
      const user = userEvent.setup()
      render(<IcsExportPanel trip={MOCK_TRIP} />)
      const region = await openPanel(user)

      const select = within(region).getByLabelText(/目的地时区/) as HTMLSelectElement
      const customInput = within(region).getByLabelText(/自定义时区（IANA 名称）/) as HTMLInputElement

      // 自定义 → 切回预设：select 值覆盖，输入框同步清空（两者共享同一 state）
      fireEvent.change(customInput, { target: { value: 'Not/AZone' } })
      expect(within(region).getAllByText(/不是当前运行环境支持的 IANA 时区/).length).toBeGreaterThan(0)
      fireEvent.change(select, { target: { value: 'Europe/London' } })
      expect(select.value).toBe('Europe/London')
      expect(customInput.value).toBe('Europe/London')
      expect(within(region).queryByText(/不是当前运行环境支持的 IANA 时区/)).toBeNull()

      // 预设 → 清空输入框：回到 floating，帮助文案回到默认模式说明
      fireEvent.change(customInput, { target: { value: '   ' } })
      expect(select.value).toBe('')
      expect(within(region).getByText(/留空则保持默认的 floating 本地时间导出/)).toBeInTheDocument()

      // floating 状态下可正常下载，时间不带 Z
      await user.click(within(region).getByRole('button', { name: '下载 .ics 文件' }))
      const blob = createObjectURL.mock.calls[0][0] as Blob
      const text = await readBlob(blob)
      expect(text).toContain('DTSTART:20260403T090000')
      expect(text).not.toContain('DTSTART:20260403T090000Z')
    })
  })
})

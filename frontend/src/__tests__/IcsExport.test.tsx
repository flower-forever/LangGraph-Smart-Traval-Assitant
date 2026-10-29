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
})

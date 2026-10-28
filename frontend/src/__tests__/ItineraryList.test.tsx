/** 复制兜底路径：jsdom 下没有真实剪贴板，必须能可控地验证成功/失败与临时节点清理 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ItineraryList, { copyText } from '../components/ItineraryList'
import { MOCK_TRIP } from './fixtures/trip'

const day = MOCK_TRIP.days[0]
const originalExecCommand = document.execCommand

function renderList() {
  return render(<ItineraryList day={day} activeStopId={null} onSelectStop={vi.fn()} />)
}

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
}

function setExecCommand(impl: unknown) {
  Object.defineProperty(document, 'execCommand', { value: impl, configurable: true, writable: true })
}

async function clickCopy(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '复制本日行程' }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setClipboard(undefined)
  setExecCommand(originalExecCommand)
})

describe('ItineraryList 复制', () => {
  it('剪贴板 API 可用时直接写入，不产生临时节点', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('已复制')).toBeInTheDocument())
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('断桥残雪')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('没有剪贴板 API 时退回 execCommand，并清理临时 textarea', async () => {
    setClipboard(undefined)
    const exec = vi.fn(() => true)
    setExecCommand(exec)
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('已复制')).toBeInTheDocument())
    expect(exec).toHaveBeenCalledWith('copy')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('execCommand 抛异常时提示失败，临时 textarea 也要清理', async () => {
    setClipboard(undefined)
    setExecCommand(() => {
      throw new Error('copy denied')
    })
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('复制失败，请手动选择')).toBeInTheDocument())
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('剪贴板被拒后兜底也失败时提示手动复制', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    setExecCommand(() => false)
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('复制失败，请手动选择')).toBeInTheDocument())
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('document.execCommand 不存在时优雅失败，不抛未捕获异常', async () => {
    setClipboard(undefined)
    setExecCommand(undefined)
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('复制失败，请手动选择')).toBeInTheDocument())
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('copyText 兜底失败时返回 false 且不留残余节点', async () => {
    setClipboard(undefined)
    setExecCommand(() => {
      throw new Error('boom')
    })
    await expect(copyText('第 1 天')).resolves.toBe(false)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('复制过程不打印 DEBUG 日志', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) })
    renderList()
    await clickCopy()
    await waitFor(() => expect(screen.getByText('已复制')).toBeInTheDocument())
    expect(logSpy).not.toHaveBeenCalled()
  })
})

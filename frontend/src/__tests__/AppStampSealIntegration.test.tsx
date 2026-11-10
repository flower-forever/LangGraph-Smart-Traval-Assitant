/**
 * 六期 S1 · 落印触发口径（App 集成）：只有真实规划成功盖章；
 * 示例加载 / 导入恢复不盖。零数据影响（localStorage 全键不变）。
 *
 * fetch 全程 mock（同 App.test.tsx 口径）；落印动画本体在真实浏览器/E2E 验证，
 * jsdom 里断言挂载与 App 计时器静默卸载的接线（卸载等待约 2.7s，真实计时器）。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import { createTripBackup } from '../lib/tripTransfer'
import type { Trip } from '../lib/api'
import { MOCK_TRIP } from './fixtures/trip'

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

function plannedTrip(): Trip {
  return {
    ...MOCK_TRIP,
    id: 'trip-stamp-1',
    source: 'agent',
    title: '落印测试行程',
  }
}

/** 用真实 createTripBackup 生成合法备份文本，包成浏览器里选中的 File */
function backupFileOf(trip: Trip): File {
  const backup = createTripBackup(trip, { now: new Date('2026-02-02T00:00:00.000Z') })
  if (!backup.ok) throw new Error(`生成备份失败：${backup.reason}`)
  return new File([backup.json], 'trip-backup.json', { type: 'application/json' })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('scrollTo', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App × 落印（六期 S1）', () => {
  it('规划成功后落印出现，驻留计时后静默卸载；示例加载不触发', async () => {
    const user = userEvent.setup()
    const planned = plannedTrip()
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/trips/plan') return Promise.resolve(jsonResponse(planned))
      return Promise.reject(new TypeError(`unexpected url: ${url}`))
    }))

    render(<App />)
    // 示例加载：不盖印
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    expect(screen.queryByTestId('stamp-seal')).toBeNull()

    // 规划成功：盖章
    await user.type(screen.getByLabelText(/目的地/), '杭州')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await waitFor(() => expect(screen.getByText('落印测试行程')).toBeInTheDocument())
    const seal = screen.getByTestId('stamp-seal')
    expect(seal).toHaveTextContent('行程既定')
    expect(seal).toHaveAttribute('aria-hidden', 'true')

    // 驻留 2.5s + 淡出收尾后静默卸载（STAMP_UNMOUNT_MS=2700，App 计时器）
    await waitFor(
      () => expect(screen.queryByTestId('stamp-seal')).toBeNull(),
      { timeout: 5000, interval: 200 },
    )
  }, 15000)

  it('导入备份恢复不触发落印', async () => {
    const user = userEvent.setup()
    stubHappyFetch()
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    // 展开「行程备份与导入」面板 → 选文件 → 显式打开（与 App.test.tsx 同口径）
    await user.click(screen.getByRole('button', { name: '行程备份与导入' }))
    const input = screen.getByLabelText(/选择备份文件/) as HTMLInputElement
    const imported: Trip = { ...MOCK_TRIP, id: 'trip-import-1', title: '导入的行程' }
    fireEvent.change(input, { target: { files: [backupFileOf(imported)] } })
    expect(await screen.findByText(`预览：${imported.title}`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开这份行程' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: imported.title })).toBeInTheDocument())
    expect(screen.queryByTestId('stamp-seal')).toBeNull()
  }, 15000)
})

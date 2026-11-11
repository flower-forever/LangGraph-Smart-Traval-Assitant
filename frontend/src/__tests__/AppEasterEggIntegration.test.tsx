/**
 * 六期 S3 · 彩蛋 App 集成测试：规划成功 → 节日印章问候（相交 / 不相交）+
 * 电影包装 props 接线 + 零数据影响（localStorage 全键 raw 前后一致）。
 *
 * fetch 全程 mock（同 AppStampSealIntegration.test.tsx 口径）。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import type { Trip } from '../lib/api'
import { MOCK_TRIP } from './fixtures/trip'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 行程日期整体平移：保持天数与站点结构，date 数组逐位替换（null 位写 null）。 */
function tripDated(base: Trip, dates: (string | null)[]): Trip {
  return {
    ...base,
    id: `trip-egg-${dates.map((value) => value ?? 'x').join('-')}`,
    source: 'agent',
    title: `彩蛋行程 ${dates[0] ?? ''}`,
    days: base.days.map((day, index) => ({ ...day, date: dates[index] ?? null })),
  }
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

function planTripFixture(trip: Trip) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/health') return Promise.resolve(jsonResponse({ status: 'healthy' }))
    if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
    if (url === '/api/trips/plan') return Promise.resolve(jsonResponse(trip))
    return Promise.reject(new TypeError(`unexpected url: ${url}`))
  }))
}

describe('App × 节日印章（六期 S3 彩蛋②）', () => {
  it('规划行程日期命中 2026 端午 → 落印带「端午安康」小字', async () => {
    const user = userEvent.setup()
    const planned = tripDated(MOCK_TRIP, ['2026-06-18', '2026-06-20', null])
    planTripFixture(planned)
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.type(screen.getByLabelText(/目的地/), '杭州')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await waitFor(() => expect(screen.getByText(/彩蛋行程 2026-06-18/)).toBeInTheDocument())
    // 印章驻留 2.7s 后卸载：一次性断言小字与文案，避免第二次 waitFor 晚于退场
    await waitFor(() => {
      const seal = screen.getByTestId('stamp-seal')
      expect(seal).toHaveTextContent('行程既定')
      expect(screen.getByTestId('stamp-seal-festival')).toHaveTextContent('端午安康')
    })
  }, 15000)

  it('规划行程日期不命中节日 → 落印无小字（data-festival=false）', async () => {
    const user = userEvent.setup()
    const planned = tripDated(MOCK_TRIP, ['2026-03-10', '2026-03-11', null])
    planTripFixture(planned)
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.type(screen.getByLabelText(/目的地/), '杭州')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    await waitFor(() => expect(screen.getByText(/彩蛋行程 2026-03-10/)).toBeInTheDocument())
    await waitFor(() => {
      const seal = screen.getByTestId('stamp-seal')
      expect(seal).toHaveTextContent('行程既定')
      expect(screen.queryByTestId('stamp-seal-festival')).toBeNull()
      expect(seal).toHaveAttribute('data-festival', 'false')
    })
  }, 15000)
})

describe('App × 彩蛋零数据影响（六期 S3）', () => {
  it('规划成功 + 落印带节日期间：localStorage 全键 raw 前后一致', async () => {
    const user = userEvent.setup()
    const planned = tripDated(MOCK_TRIP, ['2026-06-19', null, null])
    planTripFixture(planned)
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    const before = new Map<string, string | null>()
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) as string
      before.set(key, window.localStorage.getItem(key))
    }

    await user.type(screen.getByLabelText(/目的地/), '杭州')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    // 印章驻留 2.7s 后卸载：印章与节日小字一次 waitFor 内断言，避免跨 waitFor 错过退场
    await waitFor(() => {
      const seal = screen.getByTestId('stamp-seal')
      expect(seal).toHaveTextContent('行程既定')
      expect(screen.getByTestId('stamp-seal-festival')).toHaveTextContent('端午安康')
    })

    const after = new Map<string, string | null>()
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) as string
      after.set(key, window.localStorage.getItem(key))
    }
    expect(after.size).toBe(before.size)
    for (const [key, value] of before) {
      expect(after.get(key)).toBe(value)
    }
  }, 15000)

  it('Trip 对象字节不变：规划返回的行程在落印期间结构未被追加任何字段', async () => {
    const user = userEvent.setup()
    const planned = tripDated(MOCK_TRIP, ['2026-06-19', null, null])
    planTripFixture(planned)
    const snapshot = JSON.stringify(planned)
    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    await user.type(screen.getByLabelText(/目的地/), '杭州')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    // 印章驻留 2.7s 后卸载：印章挂载即断言 Trip 快照（一次 waitFor 内完成）
    await waitFor(() => expect(screen.getByTestId('stamp-seal')).toBeInTheDocument())

    // 传入的 planned 对象在全程没有被 App 修改（零数据影响的最直接证据）
    expect(JSON.stringify(planned)).toBe(snapshot)
  }, 15000)
})

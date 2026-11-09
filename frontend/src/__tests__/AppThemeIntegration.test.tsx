/**
 * App × 主题接线集成测试（四期 S2）：
 * header 出现三态主题控件；显式深色落到 documentElement；
 * 主题键之外 localStorage raw 不变；浅色下「跟随系统」+ 系统浅色回到浅色。
 * fetch 沿用 App.test.tsx 的 happy-path 桩；matchMedia 本地桩，全程离线。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { THEME_STORAGE_KEY } from '../lib/theme'
import { MOCK_TRIP } from './fixtures/trip'

const DARK_QUERY = '(prefers-color-scheme: dark)'

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

function installMatchMedia(initialDark: boolean): { setDark(next: boolean): void } {
  let dark = initialDark
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const mql = {
    get matches() {
      return dark
    },
    get media() {
      return DARK_QUERY
    },
    onchange: null,
    addEventListener: (type: string, cb: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.add(cb)
    },
    removeEventListener: (type: string, cb: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.delete(cb)
    },
    addListener: (cb: (event: MediaQueryListEvent) => void) => listeners.add(cb),
    removeListener: (cb: (event: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: () => true,
  }
  vi.stubGlobal('matchMedia', vi.fn(() => mql as unknown as MediaQueryList))
  return {
    setDark(next: boolean) {
      dark = next
      const event = { matches: next, media: DARK_QUERY } as MediaQueryListEvent
      listeners.forEach((cb) => cb(event))
    },
  }
}

function snapshotStorage(): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i)
    if (key !== null && key !== THEME_STORAGE_KEY) {
      snapshot.set(key, window.localStorage.getItem(key) ?? '')
    }
  }
  return snapshot
}

function expectStorageUnchanged(snapshot: Map<string, string>): void {
  expect(snapshotStorage()).toEqual(snapshot)
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
  document.documentElement.classList.remove('dark')
  document.documentElement.style.removeProperty('color-scheme')
})

describe('App 主题接线', () => {
  it('header 出现主题控件；点深色加 dark；再点跟随系统（系统浅色）回到浅色', async () => {
    const user = userEvent.setup()
    installMatchMedia(false)
    stubHappyFetch()

    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    const toggle = screen.getByTestId('theme-toggle')
    expect(toggle).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '主题' })).toBe(toggle)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    await user.click(screen.getByRole('button', { name: '深色' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    await user.click(screen.getByRole('button', { name: '跟随系统' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('系统深色时首屏即深色；点浅色切回浅色', async () => {
    const user = userEvent.setup()
    installMatchMedia(true)
    stubHappyFetch()

    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    await user.click(screen.getByRole('button', { name: '浅色' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('主题切换只改主题键，其它 localStorage 键 raw 完全不变', async () => {
    const user = userEvent.setup()
    installMatchMedia(false)
    stubHappyFetch()
    window.localStorage.setItem('travel-assistant:saved-trips:v1', JSON.stringify({ trips: ['keep'] }))
    window.localStorage.setItem('unrelated:key', 'raw-value-不能动')

    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())
    const before = snapshotStorage()

    await user.click(screen.getByRole('button', { name: '深色' }))
    expectStorageUnchanged(before)
    await user.click(screen.getByRole('button', { name: '浅色' }))
    expectStorageUnchanged(before)
    await user.click(screen.getByRole('button', { name: '跟随系统' }))
    expectStorageUnchanged(before)
  })

  it('系统主题变化在 preference=system 时驱动 resolved；显式浅色时忽略', async () => {
    const user = userEvent.setup()
    const media = installMatchMedia(false)
    stubHappyFetch()

    render(<App />)
    await waitFor(() => expect(screen.getByText('杭州三日漫步路书')).toBeInTheDocument())

    act(() => media.setDark(true))
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    await user.click(screen.getByRole('button', { name: '浅色' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    act(() => media.setDark(false))
    act(() => media.setDark(true))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})

/**
 * ThemeToggle 组件测试（四期 S2）：三态按钮、dark 类落点、显式选择持久化、
 * 系统主题变化只在 preference=system 时生效、主题键之外零写入。
 * matchMedia 全部用本地桩，不发网络请求。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ThemeToggle from '../components/ThemeToggle'
import { THEME_STORAGE_KEY } from '../lib/theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

interface FakeMedia {
  setDark(next: boolean): void
  listenerCount(): number
}

/** 安装 window.matchMedia 桩：同一 mql 对象，支持 change 订阅。 */
function installMatchMedia(initialDark: boolean): FakeMedia {
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
    listenerCount: () => listeners.size,
  }
}

function pressedStates(): Record<string, string | null> {
  return Object.fromEntries(
    ['跟随系统', '浅色', '深色'].map((name) => [
      name,
      screen.getByRole('button', { name }).getAttribute('aria-pressed'),
    ]),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
  document.documentElement.classList.remove('dark')
  document.documentElement.style.removeProperty('color-scheme')
})

describe('ThemeToggle', () => {
  it('默认跟随系统；系统深色时 documentElement 有 dark，且 mount 不写存储', () => {
    installMatchMedia(true)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    render(<ThemeToggle />)

    expect(screen.getByRole('group', { name: '主题' })).toBeInTheDocument()
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(pressedStates()).toEqual({ 跟随系统: 'true', 浅色: 'false', 深色: 'false' })
    expect(setItem).not.toHaveBeenCalled()
  })

  it('系统主题变化不写存储（mount 后 setItem 仍 0 次）', () => {
    const media = installMatchMedia(false)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    render(<ThemeToggle />)
    expect(setItem).not.toHaveBeenCalled()

    act(() => media.setDark(true))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(setItem).not.toHaveBeenCalled()

    act(() => media.setDark(false))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(setItem).not.toHaveBeenCalled()
  })

  it('点「浅色」移除 dark，且只写主题键', async () => {
    const user = userEvent.setup()
    installMatchMedia(true)
    window.localStorage.setItem('other:key', 'keep-me')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    render(<ThemeToggle />)
    await user.click(screen.getByRole('button', { name: '浅色' }))

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(window.localStorage.getItem('other:key')).toBe('keep-me')
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'light')
    expect(pressedStates()).toEqual({ 跟随系统: 'false', 浅色: 'true', 深色: 'false' })
  })

  it('点「深色」加 dark，只写主题键', async () => {
    const user = userEvent.setup()
    installMatchMedia(false)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    render(<ThemeToggle />)
    await user.click(screen.getByRole('button', { name: '深色' }))

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(pressedStates()).toEqual({ 跟随系统: 'false', 浅色: 'false', 深色: 'true' })
  })

  it('卸载重挂（模拟 reload）保持显式选择，即使系统主题相反', async () => {
    const user = userEvent.setup()
    installMatchMedia(false)
    const first = render(<ThemeToggle />)
    await user.click(screen.getByRole('button', { name: '深色' }))
    first.unmount()

    installMatchMedia(false)
    render(<ThemeToggle />)

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(pressedStates()).toEqual({ 跟随系统: 'false', 浅色: 'false', 深色: 'true' })
  })

  it('系统主题变化只在 preference=system 时改变 resolved', async () => {
    const user = userEvent.setup()
    const media = installMatchMedia(false)
    render(<ThemeToggle />)

    expect(document.documentElement.classList.contains('dark')).toBe(false)

    act(() => media.setDark(true))
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    await user.click(screen.getByRole('button', { name: '浅色' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    act(() => media.setDark(false))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    act(() => media.setDark(true))
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    await user.click(screen.getByRole('button', { name: '跟随系统' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(pressedStates()['跟随系统']).toBe('true')
  })

  it('主题操作前后 localStorage 其它键 raw 完全一致', async () => {
    const user = userEvent.setup()
    installMatchMedia(false)
    window.localStorage.setItem('travel-assistant:saved-trips:v1', '{"raw":"kept"}')
    window.localStorage.setItem('something:else', 'x'.repeat(32))
    const before = new Map<string, string>()
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (key !== null) before.set(key, window.localStorage.getItem(key) ?? '')
    }

    render(<ThemeToggle />)
    await user.click(screen.getByRole('button', { name: '深色' }))
    await user.click(screen.getByRole('button', { name: '浅色' }))
    await user.click(screen.getByRole('button', { name: '跟随系统' }))

    for (const [key, raw] of before) {
      expect(window.localStorage.getItem(key), key).toBe(raw)
    }
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })
})

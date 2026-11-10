/**
 * 六期 S1 · useReducedMotion 公共通道行为测试：matchMedia 全程 mock，零网络。
 *
 * 覆盖：初值跟随系统、change 事件实时更新、卸载移除订阅、matchMedia 缺失不崩。
 * 与 AppThemeIntegration.test.tsx 的 mql 桩同口径（含 add/removeEventListener）。
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useReducedMotion } from '../lib/useReducedMotion'

type Listener = (event: { matches: boolean }) => void

function installMatchMedia(initialReduced: boolean) {
  let reduced = initialReduced
  const listeners = new Set<Listener>()
  const mql = {
    get matches() {
      return reduced
    },
    get media() {
      return '(prefers-reduced-motion: reduce)'
    },
    onchange: null,
    addEventListener: (type: string, cb: unknown) => {
      if (type === 'change') listeners.add(cb as Listener)
    },
    removeEventListener: (type: string, cb: unknown) => {
      if (type === 'change') listeners.delete(cb as Listener)
    },
  }
  const spy = vi.stubGlobal('matchMedia', vi.fn(() => mql))
  return {
    spy,
    listenerCount: () => listeners.size,
    setReduced(next: boolean) {
      reduced = next
      const event = { matches: next, media: '(prefers-reduced-motion: reduce)' }
      listeners.forEach((cb) => cb(event))
    },
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useReducedMotion', () => {
  it('初值跟随系统 prefers-reduced-motion', () => {
    installMatchMedia(true)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(true)
  })

  it('系统未开启时初值为 false，change 事件实时更新（act）', () => {
    const media = installMatchMedia(false)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)

    act(() => {
      media.setReduced(true)
    })
    expect(result.current).toBe(true)
    act(() => {
      media.setReduced(false)
    })
    expect(result.current).toBe(false)
  })

  it('卸载后移除 change 订阅', () => {
    const media = installMatchMedia(false)
    const { unmount } = renderHook(() => useReducedMotion())
    expect(media.listenerCount()).toBe(1)
    unmount()
    expect(media.listenerCount()).toBe(0)
  })

  it('matchMedia 不存在（旧环境）按 false 兜底不崩', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)
  })
})

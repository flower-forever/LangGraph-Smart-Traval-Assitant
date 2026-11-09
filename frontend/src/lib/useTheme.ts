/**
 * 主题 hook（四期 S2）：三态偏好（system / light / dark）。
 *
 * 规则：
 * - 初始偏好只读一次存储；mount / render / 系统主题变化都不写存储。
 * - 只有显式 setPreference 才写 THEME_STORAGE_KEY。
 * - matchMedia 不存在（jsdom / 旧环境）时按浅色处理，不崩。
 * - preference 或系统主题变化时，统一经 applyThemeToDocument 落到 <html>。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  applyThemeToDocument,
  readThemePreference,
  resolveTheme,
  systemThemeOf,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from './theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function readSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  try {
    return systemThemeOf(window.matchMedia(DARK_QUERY))
  } catch {
    return 'light'
  }
}

export interface ThemeState {
  preference: ThemePreference
  resolvedTheme: ResolvedTheme
  setPreference: (pref: ThemePreference) => void
}

export function useTheme(): ThemeState {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readThemePreference())
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => readSystemTheme())

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let mql: MediaQueryList
    try {
      mql = window.matchMedia(DARK_QUERY)
    } catch {
      return
    }

    const handleChange = (event: MediaQueryListEvent) => setSystemTheme(systemThemeOf(event))
    // 挂载时再对齐一次：首帧与 effect 之间系统主题可能已经变化
    setSystemTheme(systemThemeOf(mql))

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handleChange)
      return () => mql.removeEventListener('change', handleChange)
    }
    // 旧 Safari / 简化测试桩的 legacy API
    if (typeof mql.addListener === 'function') {
      mql.addListener(handleChange)
      return () => mql.removeListener(handleChange)
    }
    return
  }, [])

  const resolvedTheme = resolveTheme(preference, systemTheme)

  useEffect(() => {
    applyThemeToDocument(resolvedTheme)
  }, [resolvedTheme])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    writeThemePreference(next)
  }, [])

  return { preference, resolvedTheme, setPreference }
}

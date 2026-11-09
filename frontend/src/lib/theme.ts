/**
 * 主题状态层（四期 S2 深色模式）——纯函数 + 存储适配，独立可测。
 *
 * 约定：
 * - 只使用一个存储键 THEME_STORAGE_KEY，值为 'system' | 'light' | 'dark'；
 *   缺失 / 非法 / 读取异常一律回退 'system'。
 * - 本模块只做解析、解析结果落 DOM；是否持久化由调用方（useTheme.setPreference）决定。
 * - matchMedia 可能不存在（jsdom / 旧环境），systemThemeOf 对 null/undefined 按浅色。
 */

export const THEME_STORAGE_KEY = 'travel-assistant:theme:v1'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

/** 最小存储接口：便于测试注入只读/抛错实现，不依赖真实 localStorage。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 只接受显式 light/dark；'system'、null、大小写不符等一律回退 system。 */
export function parseThemePreference(raw: string | null): ThemePreference {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

/** 系统偏好归一化：matcher 缺失按浅色。 */
export function systemThemeOf(matcher: { matches: boolean } | null | undefined): ResolvedTheme {
  return matcher?.matches ? 'dark' : 'light'
}

/** 三态偏好 + 系统主题 → 实际生效主题。 */
export function resolveTheme(pref: ThemePreference, system: ResolvedTheme): ResolvedTheme {
  return pref === 'system' ? system : pref
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    // 隐私模式 / 沙箱禁用 localStorage 时，访问本身可能抛错
    return null
  }
}

/** 读取主题偏好；存储不可用或抛错时回退 system，绝不抛出。 */
export function readThemePreference(storage: StorageLike | null = defaultStorage()): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY) ?? null)
  } catch {
    return 'system'
  }
}

/** 写入主题偏好；只碰 THEME_STORAGE_KEY。异常返回 false，绝不抛出。 */
export function writeThemePreference(
  pref: ThemePreference,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  try {
    if (!storage) return false
    storage.setItem(THEME_STORAGE_KEY, pref)
    return true
  } catch {
    return false
  }
}

/** 同步把主题落到 DOM：<html> 的 dark 类、color-scheme、可选 meta theme-color。不写存储。 */
export function applyThemeToDocument(
  theme: ResolvedTheme,
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  if (!doc) return
  const root = doc.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme

  const meta = doc.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', theme === 'dark' ? '#1c1a17' : '#f5f2ea')
  }
}

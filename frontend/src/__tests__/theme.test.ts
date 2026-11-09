/**
 * 主题状态层单测（四期 S2）：解析 / 系统偏好归一化 / 存储读写 / DOM 落点。
 * 全部离线、确定性；不依赖真实 matchMedia（不传 matcher 或传普通对象）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  systemThemeOf,
  writeThemePreference,
  type StorageLike,
  type ThemePreference,
} from '../lib/theme'

describe('parseThemePreference', () => {
  it('只接受 light / dark', () => {
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
  })

  it('null / system / 非法值 / 大小写不符一律回退 system', () => {
    expect(parseThemePreference(null)).toBe('system')
    expect(parseThemePreference('system')).toBe('system')
    expect(parseThemePreference('DARK')).toBe('system')
    expect(parseThemePreference('')).toBe('system')
    expect(parseThemePreference('auto')).toBe('system')
  })
})

describe('systemThemeOf / resolveTheme', () => {
  it('matcher 缺失或 matches=false 按浅色', () => {
    expect(systemThemeOf(null)).toBe('light')
    expect(systemThemeOf(undefined)).toBe('light')
    expect(systemThemeOf({ matches: false })).toBe('light')
    expect(systemThemeOf({ matches: true })).toBe('dark')
  })

  it('system 跟随系统；显式 light/dark 忽略系统', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark')
    expect(resolveTheme('system', 'light')).toBe('light')
    expect(resolveTheme('light', 'dark')).toBe('light')
    expect(resolveTheme('dark', 'light')).toBe('dark')
  })
})

describe('readThemePreference', () => {
  it('读取已有值', () => {
    const storage: StorageLike = {
      getItem: (key) => (key === THEME_STORAGE_KEY ? 'dark' : null),
      setItem: () => undefined,
    }
    expect(readThemePreference(storage)).toBe('dark')
  })

  it('只查询 THEME_STORAGE_KEY', () => {
    const getItem = vi.fn(() => 'light')
    readThemePreference({ getItem, setItem: () => undefined })
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY)
  })

  it('存储读取抛错时回退 system（不抛出）', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => undefined,
    }
    expect(() => readThemePreference(storage)).not.toThrow()
    expect(readThemePreference(storage)).toBe('system')
  })

  it('storage 为 null 时回退 system', () => {
    expect(readThemePreference(null)).toBe('system')
  })
})

describe('writeThemePreference', () => {
  it('只写 THEME_STORAGE_KEY 并返回 true', () => {
    const setItem = vi.fn()
    const ok = writeThemePreference('dark', { getItem: () => null, setItem })
    expect(ok).toBe(true)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark')
  })

  it('写入抛错返回 false（不抛出）', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(writeThemePreference('light', storage)).toBe(false)
  })

  it('storage 为 null 返回 false', () => {
    expect(writeThemePreference('system', null)).toBe(false)
  })
})

describe('applyThemeToDocument', () => {
  function docWithMeta(content = '#f5f2ea'): Document {
    const doc = document.implementation.createHTMLDocument('theme-test')
    doc.head.innerHTML = `<meta name="theme-color" content="${content}">`
    return doc
  }

  it('深色：加 dark 类、colorScheme=dark、meta 变深色底', () => {
    const doc = docWithMeta()
    applyThemeToDocument('dark', doc)
    expect(doc.documentElement.classList.contains('dark')).toBe(true)
    expect(doc.documentElement.style.colorScheme).toBe('dark')
    expect(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#1c1a17')
  })

  it('浅色：移除 dark 类、colorScheme=light、meta 回浅色底', () => {
    const doc = docWithMeta('#1c1a17')
    doc.documentElement.classList.add('dark')
    applyThemeToDocument('light', doc)
    expect(doc.documentElement.classList.contains('dark')).toBe(false)
    expect(doc.documentElement.style.colorScheme).toBe('light')
    expect(doc.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#f5f2ea')
  })

  it('没有 meta theme-color 时跳过且不抛错', () => {
    const doc = document.implementation.createHTMLDocument('no-meta')
    expect(() => applyThemeToDocument('dark', doc)).not.toThrow()
    expect(doc.documentElement.classList.contains('dark')).toBe(true)
  })

  it('不写任何存储', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const doc = docWithMeta()
    applyThemeToDocument('dark', doc)
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('doc 缺失时安全返回（SSR 兜底）', () => {
    expect(() => applyThemeToDocument('dark', undefined)).not.toThrow()
  })
})

describe('ThemePreference 类型面', () => {
  it('三态取值可穷举', () => {
    const all: ThemePreference[] = ['system', 'light', 'dark']
    expect(all).toHaveLength(3)
  })
})

/**
 * 分享卡片 PNG 光栅化与文件名安全化（四期 S4）。
 * 通过 deps 注入假 Image / canvas，不依赖 jsdom 的 canvas 实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rasterizeShareCardPng } from '../lib/shareCardPng'
import { safeShareCardFileName, shareCardFileName } from '../lib/shareCardFile'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1440"></svg>'

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:share-card-png')
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
})

afterEach(() => {
  const urlStatics = URL as unknown as Record<string, unknown>
  delete urlStatics.createObjectURL
  delete urlStatics.revokeObjectURL
  vi.restoreAllMocks()
})

function fakeImage(mode: 'load' | 'error'): HTMLImageElement {
  const image = { onload: null, onerror: null } as unknown as HTMLImageElement
  Object.defineProperty(image, 'src', {
    configurable: true,
    set() {
      if (mode === 'load') {
        ;(image.onload as unknown as (() => void) | null)?.()
      } else {
        ;(image.onerror as unknown as (() => void) | null)?.()
      }
    },
  })
  return image
}

function fakeCanvas(result: Blob | null): HTMLCanvasElement {
  return {
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (callback: (blob: Blob | null) => void) => callback(result),
  } as unknown as HTMLCanvasElement
}

describe('rasterizeShareCardPng · deps 注入', () => {
  it('缺少 URL.createObjectURL 时返回 unsupported，不抛异常', async () => {
    const urlStatics = URL as unknown as Record<string, unknown>
    delete urlStatics.createObjectURL
    delete urlStatics.revokeObjectURL

    const result = await rasterizeShareCardPng(SVG, {
      createImage: () => fakeImage('load'),
      createCanvas: () => fakeCanvas(new Blob(['png'], { type: 'image/png' })),
    })
    expect(result).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('图片解码失败返回 decode，并 revoke Blob URL', async () => {
    const result = await rasterizeShareCardPng(SVG, {
      createImage: () => fakeImage('error'),
      createCanvas: () => fakeCanvas(null),
    })
    expect(result).toEqual({ ok: false, reason: 'decode' })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:share-card-png')
  })

  it('toBlob 返回 null 时返回 encode，并 revoke Blob URL', async () => {
    const result = await rasterizeShareCardPng(SVG, {
      createImage: () => fakeImage('load'),
      createCanvas: () => fakeCanvas(null),
    })
    expect(result).toEqual({ ok: false, reason: 'encode' })
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:share-card-png')
  })

  it('成功时返回 PNG Blob，并 revoke Blob URL', async () => {
    const png = new Blob(['png-bytes'], { type: 'image/png' })
    const result = await rasterizeShareCardPng(SVG, {
      createImage: () => fakeImage('load'),
      createCanvas: () => fakeCanvas(png),
    })
    expect(result).toEqual({ ok: true, blob: png })
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:share-card-png')
  })

  it('空 SVG 按解码失败处理，不创建 URL', async () => {
    const result = await rasterizeShareCardPng('   ')
    expect(result).toEqual({ ok: false, reason: 'decode' })
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})

describe('shareCardFileName · 文件名安全化', () => {
  it('固定格式为 travel-assistant-share-d<天>-<风格>.<扩展名>', () => {
    expect(shareCardFileName(2, 'daily', 'svg')).toBe('travel-assistant-share-d2-daily.svg')
    expect(shareCardFileName(1, 'xuanzhi', 'png')).toBe('travel-assistant-share-d1-xuanzhi.png')
  })

  it('去掉路径分隔符、控制字符与 Windows 非法字符，保留扩展名', () => {
    const name = safeShareCardFileName('..\\evil/卡:片*?<>|"控制\u0000字符.PNG')
    expect(name.endsWith('.png')).toBe(true)
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
    expect(name).not.toContain('\u0000')
    expect(name.length).toBeGreaterThan(0)
  })
})

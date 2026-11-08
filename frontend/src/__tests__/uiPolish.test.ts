/**
 * UI 打磨回归测试（样式契约层）：
 * 1. --color-faint 在它实际出现的每种纸底上都要满足正文 4.5:1，
 *    且不能和禁用控件的观感混在一起（disabled 是 ink 50% 透明度的合成色）。
 * 2. 日签选中态：组件（App.tsx）输出 aria-selected，样式就挂 aria-selected
 *    工具类（aria-[current]/aria-selected 变体）——曾经 CSS 匹配 aria-pressed
 *    导致选中态零视觉差异，这里钉住「组件状态属性 = 样式匹配属性」契约防漂移。
 * 3. 地图弹窗操作位：样式必须同时覆盖链接和按钮（标签无关选择器），
 *    按钮要显式关闭原生外观，触达高度不低于 24px。
 *
 * 源文件用 node:fs 读取（vitest 运行时是 Node；css ?raw 在 vitest 里返回空串，
 * 不能用）。对比度用 OKLab 规范矩阵 + WCAG 相对亮度现算，不依赖浏览器。
 * W4：设计令牌唯一权威是 src/theme.css（tokens.css 已退役），token() 从那里读。
 */
// tsconfig.app 只声明了 vite/client 类型；node:fs / node:path 由 @types/node 提供（S1 起已装）
const fs = (await import('node:fs')) as { readFileSync(path: string, enc: 'utf8'): string }
const path = (await import('node:path')) as { resolve(...parts: string[]): string }

const here = (import.meta as unknown as { dirname: string }).dirname
const appCss = fs.readFileSync(path.resolve(here, '../app.css'), 'utf8')
const themeCss = fs.readFileSync(path.resolve(here, '../theme.css'), 'utf8')
const appTsx = fs.readFileSync(path.resolve(here, '../App.tsx'), 'utf8')

import { describe, expect, it } from 'vitest'

interface Oklch {
  l: number
  c: number
  h: number
}

/** 从 theme.css 读静态 oklch token（@theme 静态块或 :root 语义变量） */
function token(name: string): Oklch {
  const m = themeCss.match(new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`))
  if (!m) throw new Error(`theme.css 里找不到 --${name} 的 oklch 值`)
  return { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]) }
}

/** OKLCH → sRGB（gamma 编码后），按 CSS Color 4 规范矩阵 */
function oklchToSrgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b
  const lr = l_ ** 3
  const mg = m_ ** 3
  const sb = s_ ** 3
  const enc = (v: number) => {
    const x = Math.min(1, Math.max(0, v))
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
  }
  return [
    enc(4.0767416621 * lr - 3.3077115913 * mg + 0.2309699292 * sb),
    enc(-1.2684380046 * lr + 2.6097574011 * mg - 0.3413193965 * sb),
    enc(-0.0041960863 * lr - 0.7034186147 * mg + 1.707614701 * sb),
  ]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const ya = relativeLuminance(a)
  const yb = relativeLuminance(b)
  const [hi, lo] = ya > yb ? [ya, yb] : [yb, ya]
  return (hi + 0.05) / (lo + 0.05)
}

/** 前景以 alpha 透明度叠在背景上：浏览器在 gamma 空间合成 */
function blend(fg: [number, number, number], bg: [number, number, number], alpha: number): [number, number, number] {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as [number, number, number]
}

describe('--color-faint 对比度', () => {
  const faint = oklchToSrgb(token('color-faint'))
  // 权威 oklch 值在 :root 的 --muted-foreground（@theme inline 只做 var 桥接，不是字面量）
  const muted = oklchToSrgb(token('muted-foreground'))
  const ink = oklchToSrgb(token('foreground'))

  // faint 实际出现的底色：app-footer / 表单帮助文本 / placeholder 在 paper 系，
  // 选中态脚注在 warn-bg
  const backgrounds: Array<[string, [number, number, number]]> = [
    ['paper', oklchToSrgb(token('background'))],
    ['paper-2', oklchToSrgb(token('card'))],
    ['paper-3', oklchToSrgb(token('secondary'))],
    ['warn-bg', oklchToSrgb(token('color-warn-bg'))],
  ]

  it.each(backgrounds)('faint 在 %s 上达到正文 4.5:1', (_name, bg) => {
    expect(contrast(faint, bg)).toBeGreaterThanOrEqual(4.5)
  })

  it('faint 仍比 muted 弱（弱化 < 辅助的层级不被倒置）', () => {
    const paper2 = oklchToSrgb(token('card'))
    expect(contrast(faint, paper2)).toBeLessThan(contrast(muted, paper2))
  })

  it('faint 不与禁用控件观感混淆（禁用主按钮是 ink 50% 透明度叠底）', () => {
    const paper2 = oklchToSrgb(token('card'))
    const disabled = blend(ink, paper2, 0.5)
    const gap = contrast(faint, paper2) - contrast(disabled, paper2)
    expect(gap).toBeGreaterThanOrEqual(1.5)
  })
})

describe('日签选中态样式契约', () => {
  it('App 的日签输出 aria-selected（role=tab 的真实状态属性）', () => {
    expect(appTsx).toMatch(/role="tab"[\s\S]{0,160}?aria-selected/)
  })

  it('日签样式挂 aria-selected / aria-disabled 状态属性，不再匹配 aria-pressed（历史漂移点）', () => {
    // W4：.day-tab 旧规则退役，选中态由 App.tsx 里 aria-selected 变体工具类承接
    const selectedClasses = appTsx.match(/aria-selected[^"']*(?:'[^']*'|"([^"]*)")/g) ?? []
    expect(appTsx).toMatch(/aria-selected/)
    for (const hit of selectedClasses) {
      expect(hit).not.toContain('aria-pressed')
    }
    expect(appTsx).not.toContain('aria-pressed')
  })
})

describe('地图弹窗操作位（.pop-more）', () => {
  /** 取某个选择器的规则体；app.css 内无嵌套花括号，首个 } 即块尾 */
  function ruleBody(selector: string): string {
    const idx = appCss.indexOf(selector)
    expect(idx, `app.css 缺少选择器 ${selector}`).toBeGreaterThanOrEqual(0)
    const open = appCss.indexOf('{', idx)
    const close = appCss.indexOf('}', open)
    return appCss.slice(open + 1, close)
  }

  it('存在标签无关的共享规则，链接和按钮一并命中', () => {
    const body = ruleBody('.leaflet-popup-content .pop-more')
    expect(body).toContain('display')
    expect(body).toContain('cursor')
  })

  it('按钮显式重置原生外观（appearance: none）', () => {
    const body = ruleBody('.leaflet-popup-content button.pop-more').replace(/\s/g, '')
    expect(body).toContain('appearance:none')
  })

  it('触达高度不低于 24px', () => {
    const body = ruleBody('.leaflet-popup-content .pop-more')
    const m = body.match(/min-height:\s*(\d+(?:\.\d+)?)px/)
    expect(m, '共享规则缺少 min-height').toBeTruthy()
    expect(Number(m![1])).toBeGreaterThanOrEqual(24)
  })
})

describe('瓦片全失败覆盖层不锁死地图', () => {
  /** 精确命中某个独立选择器的规则体：避开 .map-status-note / .map-status .big 的前缀误匹配 */
  function exactRuleBody(selector: string): string {
    const escaped = selector.replace(/[.*?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|[\\n,])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm')
    const m = appCss.match(re)
    expect(m, `app.css 缺少独立选择器 ${selector}`).toBeTruthy()
    return m![1]
  }

  it('.map-status 必须保持 pointer-events:none（否则全幅透明层拦截 marker 点击与缩放）', () => {
    // W4：地图状态层迁 TripMap.tsx Tailwind 工具类，但 pointer-events:none 契约不放宽
    const mapTsx = fs.readFileSync(path.resolve(here, '../components/TripMap.tsx'), 'utf8')
    const hasStatus = mapTsx.includes('pointer-events-none') || appCss.includes('.map-status')
    expect(hasStatus, 'TripMap 状态层必须显式声明 pointer-events:none').toBe(true)
    if (appCss.includes('.map-status')) {
      const body = exactRuleBody('.map-status').replace(/\s/g, '')
      expect(body).toContain('pointer-events:none')
    } else {
      expect(mapTsx).toMatch(/map-status[\s\S]{0,220}pointer-events-none/)
    }
  })
})

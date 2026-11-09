/**
 * 深色模式对比度契约（四期 S2 返修）：
 * 从 theme.css 的 `.dark` 块解析 oklch token，按 WCAG 相对亮度实算并断言正文级组合 ≥4.5:1。
 * 源文件用 node:fs 读取（vitest 运行时是 Node；css ?raw 不适用），全程离线、确定性。
 * 解析失败会抛出带 token 名的错误，测试直接 fail，不会静默跳过。
 */
const fs = (await import('node:fs')) as { readFileSync(path: string, enc: 'utf8'): string }
const path = (await import('node:path')) as { resolve(...parts: string[]): string }

const here = (import.meta as unknown as { dirname: string }).dirname
const themeCss = fs.readFileSync(path.resolve(here, '../theme.css'), 'utf8')

import { describe, expect, it } from 'vitest'

interface Oklch {
  l: number
  c: number
  h: number
}

type Rgb = [number, number, number]

/** 截取 `.dark { ... }` 块（按花括号配对，避免把 @theme 的浅色值混进来）。 */
function darkBlock(css: string): string {
  const selector = /(?:^|\n)\s*\.dark\s*\{/.exec(css)
  if (!selector) throw new Error('theme.css 里找不到 .dark { 选择器块')
  const start = selector.index + selector[0].lastIndexOf('{')
  let depth = 0
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start + 1, i)
    }
  }
  throw new Error('.dark 块花括号未闭合')
}

const darkCss = darkBlock(themeCss)

/** 从 .dark 块读取指定 token 的 oklch；缺失 / 非字面量直接 fail 并说明 token 名。 */
function token(name: string): Oklch {
  const m = darkCss.match(
    new RegExp(`--${name}\\s*:\\s*oklch\\(\\s*([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)`),
  )
  if (!m) throw new Error(`.dark 块缺少 --${name}: oklch(...) 字面量，无法核算对比度`)
  return { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]) }
}

/** OKLCH → sRGB（gamma 编码后），按 CSS Color 4 规范矩阵。 */
function oklchToSrgb({ l, c, h }: Oklch): Rgb {
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

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const ya = relativeLuminance(a)
  const yb = relativeLuminance(b)
  const [hi, lo] = ya > yb ? [ya, yb] : [yb, ya]
  return (hi + 0.05) / (lo + 0.05)
}

/** 前景以 alpha 透明度叠在背景上（浏览器 gamma 空间合成，与 uiPolish 同口径）。 */
function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb
}

function rgb(name: string): Rgb {
  return oklchToSrgb(token(name))
}

describe('深色模式正文级对比度 ≥4.5:1', () => {
  const pairs: Array<[string, string, string]> = [
    ['foreground / background', 'foreground', 'background'],
    ['muted-foreground / background', 'muted-foreground', 'background'],
    ['muted-foreground / card', 'muted-foreground', 'card'],
    ['muted-foreground / accent', 'muted-foreground', 'accent'],
    ['accent-foreground / background', 'accent-foreground', 'background'],
    ['accent-foreground / card', 'accent-foreground', 'card'],
    ['destructive / card', 'destructive', 'card'],
    ['destructive / background', 'destructive', 'background'],
    ['color-faint / card', 'color-faint', 'card'],
    ['primary-foreground / primary', 'primary-foreground', 'primary'],
  ]

  for (const [label, fgName, bgName] of pairs) {
    it(`${label} ≥ 4.5:1`, () => {
      expect(contrast(rgb(fgName), rgb(bgName)), `.dark ${label}`).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('Alert destructive 描述：destructive 文字在 destructive/10 叠加卡面上 ≥4.5:1', () => {
    const destructive = rgb('destructive')
    const card = rgb('card')
    const tinted = blend(destructive, card, 0.1)
    expect(contrast(destructive, tinted)).toBeGreaterThanOrEqual(4.5)
  })

  it('Alert destructive 描述：destructive 文字在 destructive/10 叠加页底上 ≥4.5:1', () => {
    const destructive = rgb('destructive')
    const background = rgb('background')
    const tinted = blend(destructive, background, 0.1)
    expect(contrast(destructive, tinted)).toBeGreaterThanOrEqual(4.5)
  })

  it('Alert success 描述：color-ok 文字在 color-ok/10 叠加卡面与页底上均 ≥4.5:1', () => {
    const ok = rgb('color-ok')
    expect(contrast(ok, blend(ok, rgb('card'), 0.1))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(ok, blend(ok, rgb('background'), 0.1))).toBeGreaterThanOrEqual(4.5)
  })

  it('深色块解析到的 token 数量足够（防止空解析静默通过）', () => {
    const declared = darkCss.match(/--[\w-]+\s*:\s*oklch\(/g) ?? []
    expect(declared.length).toBeGreaterThanOrEqual(20)
  })
})

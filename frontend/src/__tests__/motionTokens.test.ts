/**
 * 六期 S1 · 动效基建回归：motion tokens 存在性 + 主题解耦 + reduced-motion 降级分支。
 *
 * 与 uiPolish.test.ts 同一口径：源文件用 node:fs 读取（vitest 里 css ?raw 是空串），
 * 全部断言落在源码文本上，不依赖浏览器。零网络、零存储。
 */
const fs = (await import('node:fs')) as { readFileSync(path: string, enc: 'utf8'): string }
const path = (await import('node:path')) as { resolve(...parts: string[]): string }

const here = (import.meta as unknown as { dirname: string }).dirname
const themeCss = fs.readFileSync(path.resolve(here, '../theme.css'), 'utf8')
const appCss = fs.readFileSync(path.resolve(here, '../app.css'), 'utf8')
const stampSealTsx = fs.readFileSync(path.resolve(here, '../components/StampSeal.tsx'), 'utf8')

import { describe, expect, it } from 'vitest'

/** 任意 :root 选择器块（跳过注释里的提及）内某个 token 的值；找到即返回 */
function rootToken(css: string, name: string): string | null {
  const rootSelector = /:root\s*\{/g
  let m0: RegExpExecArray | null
  while ((m0 = rootSelector.exec(css)) !== null) {
    const rest = css.slice(m0.index + 1)
    const nextRoot = rootSelector.exec(rest)
    const blockEnd = nextRoot ? m0.index + 1 + nextRoot.index : css.length
    const block = css.slice(m0.index, blockEnd)
    const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`))
    if (m) return m[1].trim()
    // 重置 lastIndex 到 rest 起点，避免 exec 连续匹配同一位置
    rootSelector.lastIndex = m0.index + 1
  }
  return null
}

describe('motion tokens 存在性与取值（六期任务书口径）', () => {
  it('四个规格 motion token + 落印驻留 token 全部定义且值正确', () => {
    expect(rootToken(themeCss, 'motion-duration-fast')).toBe('120ms')
    expect(rootToken(themeCss, 'motion-normal')).toBe('180ms')
    expect(rootToken(themeCss, 'motion-duration-slow')).toBe('300ms')
    expect(rootToken(themeCss, 'motion-ease-standard')).toMatch(/^cubic-bezier\(/)
    expect(rootToken(themeCss, 'motion-dwell-stamp')).toBe('2.5s')
  })

  it('motion tokens 只定义一次（六主题不携带动效值）：.dark 块不覆盖它们', () => {
    const darkBlock = themeCss.slice(themeCss.indexOf('.dark {'))
    for (const name of ['motion-duration-fast', 'motion-normal', 'motion-duration-slow', 'motion-ease-standard', 'motion-dwell-stamp']) {
      expect(darkBlock).not.toContain(`--${name}:`)
    }
    // 全文件恰好定义一次
    for (const name of ['motion-duration-fast', 'motion-normal', 'motion-duration-slow', 'motion-ease-standard', 'motion-dwell-stamp']) {
      const count = themeCss.split(`--${name}:`).length - 1
      expect(count).toBe(1)
    }
  })
})

describe('面板微转场与落印的 CSS 契约', () => {
  it('动效 keyframes 只动 transform / opacity（红线：不碰 layout 属性）', () => {
    const keyframesBlock = appCss.slice(appCss.indexOf('@keyframes oc-panel-in'))
    expect(keyframesBlock).not.toBe('')
    for (const name of ['oc-panel-in', 'oc-overlay-in', 'oc-stamp-in', 'oc-stamp-jolt', 'oc-stamp-out']) {
      const start = appCss.indexOf(`@keyframes ${name}`)
      expect(start).toBeGreaterThanOrEqual(0)
      const open = appCss.indexOf('{', start)
      // keyframes 内部花括号成对，简单取到配对深度归零
      let depth = 0
      let end = open
      for (let i = open; i < appCss.length; i += 1) {
        if (appCss[i] === '{') depth += 1
        if (appCss[i] === '}') {
          depth -= 1
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      const body = appCss.slice(open, end)
      // 允许的动画属性白名单：transform / opacity（含 scale/translate 组合写法也不该出现）
      expect(body).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\s*:/)
      expect(body).toMatch(/transform|opacity/)
    }
  })

  it('微转场时长全部引用 motion tokens，不散落魔法数', () => {
    for (const cls of ['oc-panel-enter', 'oc-panel-enter-fast', 'oc-overlay-enter']) {
      const re = new RegExp(`\\.${cls}\\s*\\{[^}]*\\}`)
      const m = appCss.match(re)
      expect(m, `app.css 缺少 .${cls}`).toBeTruthy()
      expect(m![0]).toMatch(/var\(--motion-(duration-fast|normal|duration-slow)\)/)
    }
  })

  it('app.css 引用的每个 var(--motion-*) 都在 theme.css :root 有定义（悬空 var 会作废整条 animation 声明）', () => {
    // theme.css 实际定义的 --motion-* 家族（注释里提及但无冒号的不算）
    const defined = new Set<string>()
    for (const m of themeCss.matchAll(/--(motion-[a-z-]+)\s*:/g)) defined.add(m[1])

    // app.css 里全部 var(--motion-*) 引用
    const referenced = new Set<string>()
    for (const m of appCss.matchAll(/var\(--(motion-[a-z-]+)\)/g)) referenced.add(m[1])

    // 防止正则失配让用例空转变绿：两侧 fixture 必须非空
    expect(defined.size).toBeGreaterThanOrEqual(5)
    expect(referenced.size).toBeGreaterThan(0)

    const missing = [...referenced].filter((name) => !defined.has(name))
    expect(
      missing,
      `app.css 引用了未定义的 motion token：${missing.join(', ')}——CSS 规范下悬空 var 使整条 animation shorthand 作废`,
    ).toEqual([])
  })

  it('落印 pointer-events: none（红线：绝不截住行程区点击）', () => {
    const m = appCss.match(/\.oc-stamp-seal\s*\{[^}]*\}/)
    expect(m).toBeTruthy()
    expect(m![0]).toContain('pointer-events: none')
  })

  it('落印退场时机引用 motion tokens（2.5s 由 App 层定义，CSS 不写死 2500ms）', () => {
    const m = appCss.match(/\.oc-stamp-seal\s*\{[^}]*\}/)
    expect(m![0]).toMatch(/var\(--motion-duration-slow\)/)
    expect(m![0]).toMatch(/var\(--motion-normal\)/)
    expect(m![0]).not.toMatch(/\d{4}ms/)
  })

  it('印章文案「行程既定」来自组件层', () => {
    expect(stampSealTsx).toContain('行程既定')
  })
})

/**
 * 单条声明块（选择器首次出现处）：返回起点与花括号内的声明文本。
 * 值里没有嵌套花括号，取第一个 `}` 即可。
 */
function ruleBlock(css: string, selector: string, from = 0): { start: number; body: string } {
  const start = css.indexOf(`${selector} {`, from)
  if (start < 0) throw new Error(`找不到规则 ${selector}`)
  const open = css.indexOf('{', start)
  const end = css.indexOf('}', open)
  return { start, body: css.slice(open + 1, end) }
}

/** 按顶层逗号切分 CSS 值（var() / cubic-bezier() 内的逗号不切）。 */
function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/** var(--token) → theme.css :root 里的字面值；悬空 token 直接炸（不静默放行）。 */
function resolveVars(value: string): string {
  return value.replace(/var\((--[a-z0-9-]+)\)/g, (_match, name: string) => {
    const token = rootToken(themeCss, name.slice(2))
    if (token === null) throw new Error(`theme.css 未定义 ${name}`)
    return token
  })
}

describe('normal 模式 computed animation（六期 S1-3 固化）', () => {
  it('落印三条动画名俱全、时长由 token 解析为 0.3s/0.3s/0.18s（与审计 §4-3 浏览器实测同值）', () => {
    // jsdom 的 getComputedStyle 不展开 animation 简写（只回原文），
    // 故这里按「真实声明 + token 解析」得到与浏览器 computed 相同的值：
    // 审计 §4-3 实测 animation-name = oc-stamp-in, oc-stamp-jolt, oc-stamp-out；
    // duration = 0.3s, 0.3s, 0.18s。规则必须取 normal 块（reduced 块在它之后才覆盖）。
    const normal = ruleBlock(appCss, '.oc-stamp-seal')
    const reducedStart = appCss.indexOf('@media (prefers-reduced-motion: reduce)', normal.start)
    expect(reducedStart).toBeGreaterThan(normal.start)

    const animation = normal.body.match(/animation:\s*([^;]+);/)
    expect(animation, '.oc-stamp-seal 缺少 animation 声明').toBeTruthy()
    const tracks = splitTopLevel(animation![1]).map((item) => item.split(/\s+/))
    expect(tracks.map((track) => track[0])).toEqual(['oc-stamp-in', 'oc-stamp-jolt', 'oc-stamp-out'])
    expect(tracks.map((track) => resolveVars(track[1]))).toEqual(['300ms', '300ms', '180ms'])
    expect(resolveVars(tracks[0][2])).toMatch(/^cubic-bezier\(/)
    expect(resolveVars(tracks[1][2])).toMatch(/^cubic-bezier\(/)
    expect(resolveVars(tracks[2][2])).toBe('ease-in')

    // 对照组：reduced 块必须丢掉 oc-stamp-jolt——证明上面断言的是 normal 模式
    const reduced = ruleBlock(appCss, '.oc-stamp-seal', reducedStart)
    const reducedAnimation = reduced.body.match(/animation:\s*([^;]+);/)
    expect(reducedAnimation).toBeTruthy()
    const reducedNames = splitTopLevel(reducedAnimation![1]).map((item) => item.split(/\s+/)[0])
    expect(reducedNames).toEqual(['oc-stamp-in', 'oc-stamp-out'])
  })
})

describe('reduced-motion 降级分支（每个动效都有且可审查）', () => {
  it('微转场三类的降级分支存在', () => {
    const reduced = appCss.slice(appCss.indexOf('@media (prefers-reduced-motion: reduce)'), appCss.indexOf('/* ---------- 落印'))
    for (const cls of ['oc-panel-enter', 'oc-panel-enter-fast', 'oc-overlay-enter']) {
      expect(reduced).toContain(`.${cls}`)
    }
  })

  it('落印降级分支存在且不包含震动 keyframes（仅淡入不震动）', () => {
    const reduced = appCss.slice(appCss.indexOf('/* 落印降级分支') >= 0 ? appCss.indexOf('@media (prefers-reduced-motion: reduce)', appCss.indexOf('.oc-stamp-seal')) : appCss.indexOf('@media (prefers-reduced-motion: reduce)', appCss.indexOf('.oc-stamp-seal')))
    expect(reduced).toContain('.oc-stamp-seal')
    expect(reduced).not.toContain('oc-stamp-jolt')
    expect(reduced).toContain('oc-stamp-in')
    expect(reduced).toContain('oc-stamp-out')
  })
})

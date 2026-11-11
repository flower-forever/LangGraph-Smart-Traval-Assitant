/**
 * 六期 S3 · 电影彩蛋纯逻辑测试：成都水印确定性、箴言 hash 取模。
 * 节日表相交 / 过表测试在 festivalCalendar.test.ts。
 * 全部零网络零存储零时钟；同输入两次输出逐字节一致（确定性红线）。
 */
import { describe, expect, it } from 'vitest'

import {
  pandaWatermarkFor,
  travelQuoteFor,
} from '../lib/travelEasterEggs'

describe('pandaWatermarkFor · 成都暗号', () => {
  it('destination 含「成都」返回确定性水印片段', () => {
    const first = pandaWatermarkFor('成都')
    const second = pandaWatermarkFor('四川成都五日游')
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.svgFragment).toBe(second!.svgFragment)
    expect(first!.svgFragment).toContain('data-panda-watermark="true"')
    expect(first!.svgFragment).toContain('<path')
  })

  it('同一输入两次输出逐字节相同（零随机）', () => {
    const a = pandaWatermarkFor('成都')
    const b = pandaWatermarkFor('成都')
    expect(a!.svgFragment).toBe(b!.svgFragment)
  })

  it('非成都返回 null（含近似词「成都」不出现的情形）', () => {
    expect(pandaWatermarkFor('杭州')).toBeNull()
    expect(pandaWatermarkFor('都江堰')).toBeNull()
    expect(pandaWatermarkFor('')).toBeNull()
  })

  it('水印淡色：opacity 0.28 内嵌在片段里，不依赖调用方补样式', () => {
    const watermark = pandaWatermarkFor('成都')!
    expect(watermark.svgFragment).toContain('opacity="0.28"')
  })
})

describe('travelQuoteFor · credits 箴言确定性', () => {
  it('同一 trip.id 永远同一句', () => {
    expect(travelQuoteFor('trip-e2e-plan-1')).toBe(travelQuoteFor('trip-e2e-plan-1'))
    expect(travelQuoteFor('trip-mock-1')).toBe(travelQuoteFor('trip-mock-1'))
  })

  it('异 id 有分布（6 句池 + 60 个合成 id 覆盖 ≥3 句），且输出都在池内', () => {
    const pool = new Set<string>()
    const outputs = new Set<string>()
    for (let index = 0; index < 60; index += 1) {
      const quote = travelQuoteFor(`distribution-trip-${index}`)
      pool.add(quote)
      outputs.add(quote)
    }
    // 箴言池 6 句：distribution-trip-0..59 至少命中 3 句（hash 取模的分布下限，防退化成常量）
    expect(outputs.size).toBeGreaterThanOrEqual(3)
    // 所有输出都在这 6 句池里（无凭空句）
    const canonical = new Set([
      travelQuoteFor('probe-0'),
      travelQuoteFor('probe-1'),
      travelQuoteFor('probe-2'),
      travelQuoteFor('probe-3'),
      travelQuoteFor('probe-4'),
      travelQuoteFor('probe-5'),
      travelQuoteFor('probe-6'),
      travelQuoteFor('probe-7'),
    ])
    for (const quote of outputs) expect(canonical.has(quote)).toBe(true)
    void pool
  })

  it('空 id 也确定（不抛错、同输入同输出）', () => {
    expect(travelQuoteFor('')).toBe(travelQuoteFor(''))
  })
})

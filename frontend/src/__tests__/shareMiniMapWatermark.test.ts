/**
 * 六期 S3 · 小地图成都水印测试（彩蛋①）。
 *
 * 既有 shareMiniMap.test.ts 不动（不改既有测试断言红线）：本文件只补水印行为——
 * 成都触发 / 非成都不触发、确定性、不影响小地图几何与坐标分组、缺坐标日无水印。
 */
import { describe, expect, it } from 'vitest'

import type { TripDay } from '../lib/api'
import { buildShareMiniMap } from '../lib/shareMiniMap'
import { MOCK_TRIP, MOCK_TRIP_NO_COORD } from './fixtures/trip'

function cloneDay(): TripDay {
  return JSON.parse(JSON.stringify(MOCK_TRIP.days[0])) as TripDay
}

describe('buildShareMiniMap · 成都水印（六期 S3 彩蛋①）', () => {
  it('destination 含「成都」→ SVG 末尾有 data-panda-watermark 块', () => {
    const day = cloneDay()
    const result = buildShareMiniMap(day, { destination: '四川成都' })
    expect(result.svg).not.toBeNull()
    const svg = result.svg as string
    expect(svg).toContain('data-panda-watermark="true"')
    // 水印在图例之后（SVG 末尾叠层），且在 </svg> 之前
    expect(svg.indexOf('data-panda-watermark')).toBeGreaterThan(svg.indexOf('data-route'))
    expect(svg.indexOf('data-panda-watermark')).toBeLessThan(svg.lastIndexOf('</svg>'))
  })

  it('非成都 / 缺省 options → 无水印块（旧行为字节不变）', () => {
    const day = cloneDay()
    const withCity = buildShareMiniMap(day, { destination: '杭州' })
    const legacy = buildShareMiniMap(day)
    expect(withCity.svg).not.toContain('data-panda-watermark')
    expect(withCity.svg).toBe(legacy.svg) // 不传 destination 的输出与旧版完全一致
  })

  it('同一成都输入两次输出逐字节相同（确定性）', () => {
    const day = cloneDay()
    const first = buildShareMiniMap(day, { destination: '成都' })
    const second = buildShareMiniMap(day, { destination: '成都' })
    expect(first.svg).toBe(second.svg)
  })

  it('水印不改变小地图几何：站点点位 / 路线形状与无水印版本一致', () => {
    const day = cloneDay()
    const base = buildShareMiniMap(day) // 杭州，无水印
    const withWatermark = buildShareMiniMap(day, { destination: '成都' })
    const baseSvg = base.svg as string
    const marked = withWatermark.svg as string
    // 去掉水印片段后应与基线逐字节一致（水印是纯追加、不嵌进几何）
    expect(marked.replace(/<g data-panda-watermark="true"[\s\S]*?<\/g>/, '')).toBe(baseSvg)
    // 站点分组数量不变
    expect((marked.match(/data-stop-index=/g) ?? []).length).toBe(
      (baseSvg.match(/data-stop-index=/g) ?? []).length,
    )
    expect((marked.match(/data-route=/g) ?? []).length).toBe(
      (baseSvg.match(/data-route=/g) ?? []).length,
    )
  })

  it('整日无坐标（svg=null）不产生水印，返回结构与既有口径一致', () => {
    const result = buildShareMiniMap(MOCK_TRIP_NO_COORD.days[0], { destination: '成都' })
    expect(result.svg).toBeNull()
    expect(result.unknownStops).toEqual(['某无名站点'])
  })
})

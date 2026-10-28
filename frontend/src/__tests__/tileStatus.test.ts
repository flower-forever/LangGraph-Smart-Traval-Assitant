import { describe, expect, it } from 'vitest'
import {
  TILE_STATS_INITIAL,
  onTileLoadStart,
  onTileSettled,
  tileStateOf,
  type TileStats,
} from '../lib/tileStatus'

/** 依次喂入事件，返回最终计数 */
function settle(events: Array<'start' | 'load' | 'error'>): TileStats {
  let stats = TILE_STATS_INITIAL
  for (const event of events) {
    if (event === 'start') stats = onTileLoadStart(stats)
    else stats = onTileSettled(stats, event)
  }
  return stats
}

describe('tileStateOf / 瓦片状态结算', () => {
  it('还有瓦片在途时保持 loading', () => {
    expect(tileStateOf(settle(['start', 'start', 'load']))).toBe('loading')
  })

  it('全部成功才算 ok', () => {
    expect(tileStateOf(settle(['start', 'start', 'load', 'load']))).toBe('ok')
  })

  it('全部失败才算 failed', () => {
    expect(tileStateOf(settle(['start', 'start', 'error', 'error']))).toBe('failed')
  })

  it('最后一个瓦片是成功时也要结算出部分失败', () => {
    // 旧实现只在 tileerror 里结算：最后一发是成功，状态会卡在 loading
    const stats = settle(['start', 'start', 'start', 'error', 'load', 'load'])
    expect(stats).toEqual({ pending: 0, loaded: 2, failed: 1 })
    expect(tileStateOf(stats)).toBe('partial')
  })

  it('最后一个瓦片是失败时同样结算', () => {
    const stats = settle(['start', 'start', 'load', 'error'])
    expect(stats).toEqual({ pending: 0, loaded: 1, failed: 1 })
    expect(tileStateOf(stats)).toBe('partial')
  })

  it('pending 不会掉到负数，也不会把未开始的瓦片算进去', () => {
    const stats = onTileSettled(TILE_STATS_INITIAL, 'error')
    expect(stats.pending).toBe(0)
    expect(tileStateOf(stats)).toBe('failed')
  })
})

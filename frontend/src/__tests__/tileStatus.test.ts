import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TILE_STALL_TIMEOUT_MS,
  TILE_STATS_INITIAL,
  createTileWatch,
  onTileLoadStart,
  onTileSettled,
  onTileUnloaded,
  tileStateOf,
  type TileState,
  type TileStats,
  type TileWatch,
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

/** 记录状态回调，便于断言「什么时候给出了什么结论」 */
function recordStates(): { states: TileState[]; watch: TileWatch } {
  const states: TileState[] = []
  const watch = createTileWatch((state) => states.push(state))
  return { states, watch }
}

/**
 * 构造和 Leaflet TileEvent 一致的瓦片身份：tile 是 <img> 元素，coords 带 z。
 * 每个瓦片用独立的元素，和真实的 GridLayer 行为一致（_addTile 每次新建节点）。
 */
function tileRef(x: number, z = 12): { tile: HTMLImageElement; coords: { x: number; y: number; z: number } } {
  return { tile: document.createElement('img'), coords: { x, y: 0, z } }
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

  it('tileunload 只扣在途计数，不算成功也不算失败', () => {
    expect(onTileUnloaded({ pending: 1, loaded: 2, failed: 1 })).toEqual({
      pending: 0,
      loaded: 2,
      failed: 1,
    })
    expect(onTileUnloaded(TILE_STATS_INITIAL).pending).toBe(0)
  })
})

describe('createTileWatch / 只有 start 时的超时兜底', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('等待预算落在 8~10 秒之间', () => {
    expect(TILE_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(8000)
    expect(TILE_STALL_TIMEOUT_MS).toBeLessThanOrEqual(10000)
  })

  it('只收到 tileloadstart 时先保持 loading，到预算才给出 stalled', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    expect(states).toEqual(['loading'])

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS - 1)
    expect(states).toEqual(['loading'])

    vi.advanceTimersByTime(1)
    expect(states.at(-1)).toBe('stalled')
    // 超时后定时器已经用掉，不该再有重复告警
    expect(vi.getTimerCount()).toBe(0)
  })

  it('连续发起加载不会把超时窗口一直往后推', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()

    watch.handleStart(tileRef(1))
    vi.advanceTimersByTime(6000)
    // 新瓦片开始加载，但前面那批还没结论：截止时间不能被重置
    watch.handleStart(tileRef(2))
    expect(states.at(-1)).toBe('loading')

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS - 6000)
    expect(states.at(-1)).toBe('stalled')
  })

  it('迟到的 load 从 stalled 恢复为 ok，并清掉定时器', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS)
    expect(states.at(-1)).toBe('stalled')

    watch.handleSettled('load', a)
    expect(states.at(-1)).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)

    // 恢复之后不能再冒出超时
    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS * 3)
    expect(states.filter((s) => s === 'stalled')).toHaveLength(1)
  })

  it('迟到的是 error 时仍按原有失败语义结算', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS)
    watch.handleSettled('error', a)

    expect(states.at(-1)).toBe('failed')
  })

  it('在途瓦片全部结束后不再判定超时', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    vi.advanceTimersByTime(3000)
    watch.handleSettled('load', a)
    expect(states.at(-1)).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS * 5)
    expect(states).toEqual(['loading', 'ok'])
  })

  it('零 pending 时不启动计时器', () => {
    vi.useFakeTimers()
    const { states } = recordStates()

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS * 3)
    expect(states).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose 清掉定时器，之后的事件不再回调', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    expect(vi.getTimerCount()).toBe(1)

    watch.dispose()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS * 3)
    watch.handleStart(a)
    watch.handleSettled('load', a)
    expect(states).toEqual(['loading'])
  })

  it('换天/换视野时从换的那一刻重新计时', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()

    watch.handleStart(tileRef(1))
    vi.advanceTimersByTime(6000)
    watch.resetForViewChange()
    expect(states.at(-1)).toBe('loading')

    // 距离第一次 start 已经 15 秒，但换视野后只过了 9 秒
    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS - 1)
    expect(states).not.toContain('stalled')

    vi.advanceTimersByTime(1)
    expect(states.at(-1)).toBe('stalled')
  })

  it('在途瓦片被 unload 后不会留下永远 loading 的 pending', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    watch.handleUnload(a)
    expect(states.at(-1)).toBe('loading')

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS * 2)
    expect(states).not.toContain('stalled')
    expect(vi.getTimerCount()).toBe(0)
  })
})

// Leaflet 在缩放/平移时会卸载旧瓦片，其中既有已成功的也有还在途的。
// 早期实现把每一次 tileunload 都当成「某个在途瓦片结束了」，于是一个已成功的旧瓦片
// 会把另一个挂起瓦片的 pending 扣掉，watchdog 被清掉，挂起的瓦片再也不会报超时。
describe('createTileWatch / 按瓦片身份结算', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('已成功的瓦片被卸载，不会扣掉仍在途瓦片的 pending', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)
    const b = tileRef(2)

    watch.handleStart(a)
    watch.handleStart(b)
    watch.handleSettled('load', a)
    expect(watch.snapshot()).toEqual({ pending: 1, loaded: 1, failed: 0 })

    // 缩放时 Leaflet 卸载已经成功的旧瓦片：它离场后不再算进当前底图（loaded 减 1），
    // 但它既不是 B，也不该算任何结算，B 的 pending 一分不能少
    watch.handleUnload(a)
    expect(watch.snapshot()).toEqual({ pending: 1, loaded: 0, failed: 0 })
    expect(states.at(-1)).toBe('loading')

    // B 一直没有响应，9 秒后必须给出结论，而不是被 A 的 unload 静默清掉
    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS - 1)
    expect(states).not.toContain('stalled')
    vi.advanceTimersByTime(1)
    expect(states.at(-1)).toBe('stalled')
  })

  it('同一个瓦片重复 load/error 与离场都不会重复记账，也不会吃掉别的 pending', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)
    const b = tileRef(2)
    const c = tileRef(3)

    watch.handleStart(a)
    watch.handleStart(b)
    watch.handleStart(c)

    watch.handleSettled('load', a)
    expect(watch.snapshot()).toEqual({ pending: 2, loaded: 1, failed: 0 })

    // 重复的 load、同一瓦片后来的 error 都是迟到/重复事件，a 早已结算
    watch.handleSettled('load', a)
    watch.handleSettled('error', a)
    expect(watch.snapshot()).toEqual({ pending: 2, loaded: 1, failed: 0 })
    expect(states.at(-1)).toBe('loading')

    // a 离场只撤自己那一笔
    watch.handleUnload(a)
    expect(watch.snapshot()).toEqual({ pending: 2, loaded: 0, failed: 0 })

    // b 自己失败、c 最后成功：图上仍有成功的 c，所以是部分失败而不是全失败
    watch.handleSettled('error', b)
    watch.handleSettled('load', c)
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 1, failed: 1 })
    expect(states.at(-1)).toBe('partial')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('在途瓦片被卸载时取消该项，之后迟到的结果不再记账', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    expect(watch.snapshot().pending).toBe(1)

    watch.handleUnload(a)
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 0, failed: 0 })
    expect(states.at(-1)).toBe('loading')
    expect(vi.getTimerCount()).toBe(0)

    // 已经取消的瓦片之后才到的 load 不能把它算成成功
    watch.handleSettled('load', a)
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 0, failed: 0 })

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS * 2)
    expect(states).not.toContain('stalled')
  })

  it('tileabort 取消在途瓦片（换 zoom 时 Leaflet 只发这个）', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    watch.handleAbort(a)
    expect(watch.snapshot().pending).toBe(0)

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS * 2)
    expect(states).not.toContain('stalled')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('tileabort 只取消它自己，另一个在途瓦片仍按预算报超时', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)
    const b = tileRef(2)

    watch.handleStart(a)
    watch.handleStart(b)
    watch.handleAbort(a)
    expect(watch.snapshot()).toEqual({ pending: 1, loaded: 0, failed: 0 })
    expect(states.at(-1)).toBe('loading')

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS - 1)
    expect(states).not.toContain('stalled')
    vi.advanceTimersByTime(1)
    expect(states.at(-1)).toBe('stalled')
  })

  it('重复的 tileabort 只扣一次，abort 之后迟到的 load/error 不再记账', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)
    const b = tileRef(2)

    watch.handleStart(a)
    watch.handleStart(b)
    watch.handleAbort(a)
    watch.handleAbort(a)
    expect(watch.snapshot()).toEqual({ pending: 1, loaded: 0, failed: 0 })

    // abort 之后浏览器仍可能补发 load/error，但瓦片已经不在途，不能转成成功或失败
    watch.handleSettled('load', a)
    watch.handleSettled('error', a)
    expect(watch.snapshot()).toEqual({ pending: 1, loaded: 0, failed: 0 })

    watch.handleSettled('load', b)
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 1, failed: 0 })
    expect(states.at(-1)).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('已成功的瓦片被 abort（迟到/重复事件）不动别的在途瓦片', () => {
    const { states, watch } = recordStates()
    const a = tileRef(1)
    const b = tileRef(2)

    watch.handleStart(a)
    watch.handleStart(b)
    watch.handleSettled('load', a)
    // Leaflet 的 _abortLoading 只挑未完成的瓦片，abort 指向已成功的瓦片属于不该出现的事件
    watch.handleAbort(a)
    expect(watch.snapshot()).toEqual({ pending: 1, loaded: 1, failed: 0 })
    expect(states.at(-1)).toBe('loading')

    watch.handleSettled('load', b)
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 2, failed: 0 })
    expect(states.at(-1)).toBe('ok')
  })

  it('已经超时后切回视图：撤掉超时结论并从切换那一刻重新计时', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()

    watch.handleStart(tileRef(1))
    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS)
    expect(states.filter((s) => s === 'stalled')).toHaveLength(1)

    watch.resetForViewChange()
    expect(states.at(-1)).toBe('loading')

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS - 1)
    expect(states.filter((s) => s === 'stalled')).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(states.filter((s) => s === 'stalled')).toHaveLength(2)
  })

  it('超时之后再 dispose 不再回调，也不留下定时器', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()

    watch.handleStart(tileRef(1))
    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS)
    const seen = states.length

    watch.dispose()
    expect(vi.getTimerCount()).toBe(0)

    watch.handleStart(tileRef(2))
    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS * 3)
    expect(states).toHaveLength(seen)
  })

  it('同一个瓦片重复 start 不重复计 pending', () => {
    const { watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    watch.handleStart(a)
    expect(watch.snapshot().pending).toBe(1)

    watch.handleSettled('load', a)
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 1, failed: 0 })
  })

  it('同一格子换了一个瓦片元素时算两个瓦片', () => {
    const { watch } = recordStates()
    const first = tileRef(7)
    // 同一个 z/x/y，但 Leaflet 重新建了 <img>
    const second = { tile: document.createElement('img'), coords: { x: 7, y: 0, z: 12 } }

    watch.handleStart(first)
    watch.handleStart(second)
    expect(watch.snapshot().pending).toBe(2)

    watch.handleSettled('load', first)
    watch.handleUnload(second)
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 1, failed: 0 })
  })

  it('没有身份信息的事件仍按到达顺序结算（只作兜底，不作为正常路径）', () => {
    const { watch } = recordStates()

    watch.handleStart()
    watch.handleStart()
    expect(watch.snapshot().pending).toBe(2)

    watch.handleSettled('load')
    watch.handleSettled('load')
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 2, failed: 0 })
  })
})

// 旧实现把 loaded / failed 当成图层生命周期累计：一次早高峰里失败的瓦片，哪怕早就被
// 平移卸载、当前视野全绿，界面还在说「部分瓦片加载失败」。这里锁定新语义——状态只描述
// 此刻仍挂在图上的瓦片，瓦片离场就把它那一笔一起撤掉。
describe('createTileWatch / 只反映当前底图上的瓦片', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('旧失败瓦片被卸载后，新视野全部成功就不再显示历史错误', () => {
    const { states, watch } = recordStates()
    const old = tileRef(1)
    const failed = tileRef(2)
    const fresh = tileRef(3)

    watch.handleStart(old)
    watch.handleStart(failed)
    watch.handleSettled('load', old)
    watch.handleSettled('error', failed)
    expect(states.at(-1)).toBe('partial')

    // 平移：失败那块出视野被 Leaflet 卸载，新视野的瓦片全部成功
    watch.handleUnload(failed)
    watch.handleUnload(old)
    watch.handleStart(fresh)
    watch.handleSettled('load', fresh)

    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 1, failed: 0 })
    expect(states.at(-1)).toBe('ok')
    expect(states).not.toContain('failed')
  })

  it('仍挂在图上的成功瓦片 + 平移新请求的一片失败，只算部分失败', () => {
    const { states, watch } = recordStates()
    const kept = tileRef(1)

    watch.handleStart(kept)
    watch.handleSettled('load', kept)
    expect(states.at(-1)).toBe('ok')

    // 平移只新请求了一片，这一片失败：视野里还有成功的底图，不能说整张图都失败
    const edge = tileRef(2)
    watch.handleStart(edge)
    expect(states.at(-1)).toBe('loading')
    watch.handleSettled('error', edge)

    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 1, failed: 1 })
    expect(states.at(-1)).toBe('partial')
    expect(states).not.toContain('failed')
  })

  it('卸载已完成的瓦片只撤它自己，在途瓦片的 pending 与超时照旧', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const a = tileRef(1)
    const b = tileRef(2)
    const c = tileRef(3)

    watch.handleStart(a)
    watch.handleStart(b)
    watch.handleStart(c)
    watch.handleSettled('load', a)
    watch.handleSettled('load', c)

    watch.handleUnload(a)
    watch.handleUnload(c)
    expect(watch.snapshot()).toEqual({ pending: 1, loaded: 0, failed: 0 })
    expect(states.at(-1)).toBe('loading')

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS - 1)
    expect(states).not.toContain('stalled')
    vi.advanceTimersByTime(1)
    expect(states.at(-1)).toBe('stalled')
  })

  it('已失败的瓦片离场后，迟到的事件不会把失败重新点亮', () => {
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    watch.handleSettled('error', a)
    expect(states.at(-1)).toBe('failed')

    watch.handleUnload(a)
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 0, failed: 0 })
    expect(states.at(-1)).toBe('loading')

    // 卸载之后补发的任何事件都不能虚构失败或恢复
    watch.handleSettled('error', a)
    watch.handleSettled('load', a)
    watch.handleUnload(a)
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 0, failed: 0 })
    expect(states).not.toContain('partial')
    expect(states).not.toContain('ok')
    expect(states.at(-1)).toBe('loading')
  })

  it('abort 之后迟到的 error 不能把这张瓦片算成失败', () => {
    const { states, watch } = recordStates()
    const a = tileRef(1)

    watch.handleStart(a)
    watch.handleAbort(a)
    // _abortLoading 清掉 src 之后浏览器仍可能补发 error（请求被取消）
    watch.handleSettled('error', a)

    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 0, failed: 0 })
    expect(states).not.toContain('failed')
    expect(states).not.toContain('partial')
  })

  it('abort 只清在途瓦片：已成功的瓦片一条记录都不动', () => {
    const { watch } = recordStates()
    const a = tileRef(1)
    const b = tileRef(2)

    watch.handleStart(a)
    watch.handleStart(b)
    watch.handleSettled('load', a)
    watch.handleAbort(a)

    expect(watch.snapshot()).toEqual({ pending: 1, loaded: 1, failed: 0 })
  })

  it('卸载已成功的瓦片不算进展，不会把挂起瓦片的超时窗口往后推', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const settled = tileRef(1)
    const hung = tileRef(2)

    watch.handleStart(settled)
    watch.handleSettled('load', settled)
    expect(vi.getTimerCount()).toBe(0)

    // 挂起的那张开始加载：9 秒从这一刻起算
    watch.handleStart(hung)
    vi.advanceTimersByTime(8000)

    // 平移把已成功的旧瓦片卸掉：pending 没变，这不是加载有进展的证据
    watch.handleUnload(settled)
    expect(states.at(-1)).toBe('loading')

    vi.advanceTimersByTime(999)
    expect(states).not.toContain('stalled')
    vi.advanceTimersByTime(1)
    expect(states.at(-1)).toBe('stalled')
  })

  it('全部瓦片失败后把失败的都卸载掉，状态退回等待而不是继续报失败', () => {
    const { states, watch } = recordStates()
    const a = tileRef(1)
    const b = tileRef(2)

    watch.handleStart(a)
    watch.handleStart(b)
    watch.handleSettled('error', a)
    watch.handleSettled('error', b)
    expect(states.at(-1)).toBe('failed')

    watch.handleUnload(a)
    watch.handleUnload(b)
    expect(states.at(-1)).toBe('loading')
    expect(states).not.toContain('partial')
    // 退回 loading 不等于宣称恢复：没有成功瓦片就不该出现 ok
    expect(states).not.toContain('ok')
  })
})

// 计时预算和「stats 指回初始值」这两件事写在实现注释里，但没有测试盯着，改动容易漂移。
describe('createTileWatch / 计时预算与内部状态', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('在途瓦片结算后，剩余瓦片从结算那一刻重新拿一整个预算', () => {
    // 有瓦片真的拿到了结果，说明加载在推进：不能沿用旧截止时间立刻报超时，
    // 但也不能让剩余瓦片无限期拖下去。
    vi.useFakeTimers()
    const { states, watch } = recordStates()
    const fast = tileRef(1)
    const slow = tileRef(2)

    watch.handleStart(fast)
    watch.handleStart(slow)
    vi.advanceTimersByTime(8000)
    watch.handleSettled('load', fast)

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS - 1)
    expect(states).not.toContain('stalled')

    vi.advanceTimersByTime(1)
    expect(states.at(-1)).toBe('stalled')
  })

  it('没有在途瓦片时换视野不会凭空启动计时器', () => {
    vi.useFakeTimers()
    const { states, watch } = recordStates()

    watch.resetForViewChange()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(TILE_STALL_TIMEOUT_MS * 3)
    expect(states).not.toContain('stalled')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('snapshot 返回副本，外部改动不会影响内部计数', () => {
    const { watch } = recordStates()
    watch.handleStart(tileRef(1))

    const snap = watch.snapshot()
    expect(snap).toEqual({ pending: 1, loaded: 0, failed: 0 })
    expect(snap).not.toBe(watch.snapshot())

    snap.pending = 99
    expect(watch.snapshot().pending).toBe(1)
  })

  it('初始计数是冻结的，外部改写不会污染 reset/dispose 指回去的那份基准', () => {
    // dispose / reset 会把 stats 直接指回 TILE_STATS_INITIAL：它一旦被外部改过，
    // 之后每个 watch 的起点都跟着串味。
    expect(Object.isFrozen(TILE_STATS_INITIAL)).toBe(true)
    expect(() => {
      TILE_STATS_INITIAL.pending = 99
    }).toThrow()
    expect(TILE_STATS_INITIAL).toEqual({ pending: 0, loaded: 0, failed: 0 })

    const { watch } = recordStates()
    watch.handleStart(tileRef(1))
    watch.dispose()
    expect(watch.snapshot()).toEqual({ pending: 0, loaded: 0, failed: 0 })
  })
})

/**
 * 瓦片加载状态的结算逻辑。
 * 瓦片是并发加载的，必须等「已经开始的瓦片」全部结束（成功或失败）才能下结论，
 * 否则最后一个瓦片失败后状态会永远停在 loading，或者最后一次成功把失败吞掉。
 */

export type TileState = 'loading' | 'ok' | 'partial' | 'failed'

export interface TileStats {
  /** 已开始、还没结束的瓦片数 */
  pending: number
  loaded: number
  failed: number
}

export const TILE_STATS_INITIAL: TileStats = { pending: 0, loaded: 0, failed: 0 }

export function onTileLoadStart(stats: TileStats): TileStats {
  return { ...stats, pending: stats.pending + 1 }
}

/** 单个瓦片结束（成功或失败）后计数；pending 不会掉到负数 */
export function onTileSettled(stats: TileStats, outcome: 'load' | 'error'): TileStats {
  const pending = Math.max(0, stats.pending - 1)
  return outcome === 'load'
    ? { ...stats, pending, loaded: stats.loaded + 1 }
    : { ...stats, pending, failed: stats.failed + 1 }
}

/** 还有瓦片在途就是 loading；全部结束后再区分成功 / 部分失败 / 全失败 */
export function tileStateOf(stats: TileStats): TileState {
  if (stats.pending > 0) return 'loading'
  if (stats.failed > 0) return stats.loaded > 0 ? 'partial' : 'failed'
  return stats.loaded > 0 ? 'ok' : 'loading'
}

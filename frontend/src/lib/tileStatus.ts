/**
 * 瓦片加载状态的结算逻辑。
 * 瓦片是并发加载的，必须等「已经开始的瓦片」全部结束（成功或失败）才能下结论，
 * 否则最后一个瓦片失败后状态会永远停在 loading，或者最后一次成功把失败吞掉。
 *
 * 还有一种结算不了的情况：浏览器只发了 tileloadstart，之后既不 load 也不 error
 * （请求挂住、代理静默丢弃、图片被拦但没有回调）。这时 pending 永远大于 0，
 * 状态会一直停在 loading，用户只看到一片灰底图却没有任何说明。
 * createTileWatch 负责这种情况：在途瓦片超过预算时间没有任何结论就转成 stalled，
 * 迟到的 load/error 仍按真实结果结算回来。
 *
 * 计数必须按瓦片身份来：Leaflet 会在缩放/平移时卸载旧瓦片，其中既有已成功的也有
 * 还在途的。把任意一次 tileunload 都当成「某个在途瓦片结束了」，会让一个已成功的
 * 旧瓦片把另一个仍在挂起的瓦片的 pending 扣掉，watchdog 随之被清掉，挂起的瓦片
 * 就再也不会报超时。所以每个事件都带着 TileEvent 的 tile（<img> 元素）和 coords
 * （z/x/y）进来，只有「这个瓦片此刻仍在途」并且是它第一次给出结果时才记账。
 */

export type TileState = 'loading' | 'ok' | 'partial' | 'failed' | 'stalled'

export interface TileStats {
  /** 已开始、还没结束的瓦片数 */
  pending: number
  loaded: number
  failed: number
}

export const TILE_STATS_INITIAL: TileStats = { pending: 0, loaded: 0, failed: 0 }

/**
 * 底图 watchdog 的等待预算。
 * 取 9 秒：正常首屏瓦片远快于它，挂死的请求又不会让用户盯着灰地图太久。
 */
export const TILE_STALL_TIMEOUT_MS = 9000

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

/**
 * 瓦片被移除（缩放/平移时旧瓦片卸载、图层被拿掉）。
 * 它既不是加载成功也不是加载失败，只把在途计数扣掉，避免 pending 泄漏成永久 loading。
 */
export function onTileUnloaded(stats: TileStats): TileStats {
  return { ...stats, pending: Math.max(0, stats.pending - 1) }
}

/** 还有瓦片在途就是 loading；全部结束后再区分成功 / 部分失败 / 全失败 */
export function tileStateOf(stats: TileStats): TileState {
  if (stats.pending > 0) return 'loading'
  if (stats.failed > 0) return stats.loaded > 0 ? 'partial' : 'failed'
  return stats.loaded > 0 ? 'ok' : 'loading'
}

/**
 * 能唯一指认一个瓦片的最小信息，与 Leaflet 的 TileEvent 结构兼容：
 * - tile：事件里的 <img> 元素，同一个瓦片从 start 到 load/error/unload 都是它；
 * - coords：TileEvent.coords（z/x/y），元素被复用或跨视野重开时用来区分。
 */
export interface TileRef {
  tile?: unknown
  coords?: { x: number; y: number; z: number } | null
}

/** 没有身份的瓦片只可能来自不按 Leaflet 语义发事件的调用方，用匿名 key 兜底排队 */
const ANONYMOUS_PREFIX = 'anon:'

/** 元素 → 稳定序号。WeakMap 不阻止 <img> 被回收，也不跨测试泄漏引用 */
const tileElementIds = new WeakMap<object, number>()
let nextElementId = 1

function elementIdOf(tile: unknown): string {
  if (typeof tile !== 'object' || tile === null) return '?'
  let id = tileElementIds.get(tile)
  if (id === undefined) {
    id = nextElementId
    nextElementId += 1
    tileElementIds.set(tile, id)
  }
  return String(id)
}

/** 事件 → 瓦片身份；两个字段都没有时返回 null，交给匿名队列 */
function tileKeyOf(ref: TileRef | undefined): string | null {
  if (!ref) return null
  const { tile, coords } = ref
  if (tile === undefined && !coords) return null
  const coordPart = coords ? `${coords.z}/${coords.x}/${coords.y}` : '?'
  return `${coordPart}#${elementIdOf(tile)}`
}

export interface TileWatchOptions {
  /** 无 load/error 时判定超时的等待时间，默认 TILE_STALL_TIMEOUT_MS */
  stallTimeoutMs?: number
}

export interface TileWatch {
  /** tileloadstart */
  handleStart(tile?: TileRef): void
  /** tileload / tileerror */
  handleSettled(outcome: 'load' | 'error', tile?: TileRef): void
  /** tileunload：瓦片被移除 */
  handleUnload(tile?: TileRef): void
  /** tileabort：Leaflet 放弃在途瓦片（换 zoom 时只发这个，不发 unload） */
  handleAbort(tile?: TileRef): void
  /** 视图换了（换天 / 重新适配视野）：旧计时作废，有在途瓦片就从现在重新计时 */
  resetForViewChange(): void
  /** 当前计数快照，供调用方与测试观察 */
  snapshot(): TileStats
  /** 卸载：清定时器，之后不再回调 */
  dispose(): void
}

/**
 * 把「事件 → 状态」和 watchdog 定时器收在一起，组件只负责转发 Leaflet 事件。
 *
 * 记账规则：
 * - 同一瓦片重复 start 不重复计 pending；
 * - 只有仍在途的瓦片第一次 load/error/unload/abort 才改计数，重复或迟到的同类事件
 *   直接忽略，不去动别的瓦片的 pending；
 * - 已成功的瓦片之后被卸载属于常规清理，不算失败，也不扣别的瓦片的 pending。
 *
 * 计时规则：
 * - 没有在途瓦片（pending 为 0）不启动计时，避免空日或还没开始加载就报超时；
 * - 连续 tileloadstart 不重置计时，否则慢吞吞的请求会把截止时间一直往后推；
 * - 任一在途瓦片给出结论后清掉 stalled 并重新给剩余瓦片一个完整预算；
 * - 超时只表示「没有拿到瓦片结果」，不代表网络断了，文案由调用方负责。
 */
export function createTileWatch(
  onState: (state: TileState) => void,
  options: TileWatchOptions = {},
): TileWatch {
  const stallTimeoutMs = options.stallTimeoutMs ?? TILE_STALL_TIMEOUT_MS
  let stats: TileStats = TILE_STATS_INITIAL
  /** 在途瓦片的身份集合；与 stats.pending 一一对应 */
  const inFlight = new Set<string>()
  let anonymousSeq = 0
  let stalled = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const currentState = (): TileState =>
    stalled && stats.pending > 0 ? 'stalled' : tileStateOf(stats)

  const emit = (): void => {
    if (disposed) return
    onState(currentState())
  }

  const arm = (): void => {
    clearTimer()
    if (disposed || stalled || stats.pending === 0) return
    timer = setTimeout(() => {
      timer = null
      // 定时器排队期间可能已经全部结算或组件卸载，这时不该再报超时
      if (disposed || stats.pending === 0) return
      stalled = true
      emit()
    }, stallTimeoutMs)
  }

  /** 把该瓦片从在途集合拿掉；不在途说明是重复/迟到事件，返回 false */
  const takeInFlight = (ref: TileRef | undefined): boolean => {
    const key = tileKeyOf(ref)
    if (key !== null) return inFlight.delete(key)
    for (const candidate of inFlight) {
      if (candidate.startsWith(ANONYMOUS_PREFIX)) {
        inFlight.delete(candidate)
        return true
      }
    }
    return false
  }

  /** 在途瓦片减少后的统一收尾：清掉超时告警，按剩余在途瓦片重新计时 */
  const afterSettled = (): void => {
    stalled = false
    if (stats.pending > 0) arm()
    else clearTimer()
    emit()
  }

  return {
    handleStart(ref) {
      if (disposed) return
      const key = tileKeyOf(ref) ?? `${ANONYMOUS_PREFIX}${anonymousSeq++}`
      // 同一个瓦片重复 start：不能重复计 pending，否则永远等不到对应数量的结束事件
      if (inFlight.has(key)) return
      inFlight.add(key)
      const wasIdle = stats.pending === 0
      stats = onTileLoadStart(stats)
      if (wasIdle) {
        stalled = false
        arm()
      }
      emit()
    },

    handleSettled(outcome, ref) {
      if (disposed) return
      // 不在途的事件（已结算过的瓦片、已被卸载的瓦片、换视野后才到的迟到事件）
      // 一律不记账：否则一个瓦片被算两次，还会把别的挂起瓦片的 pending 吃掉
      if (!takeInFlight(ref)) return
      stats = onTileSettled(stats, outcome)
      afterSettled()
    },

    handleUnload(ref) {
      if (disposed) return
      // 已结算的瓦片被卸载是缩放/平移里的常规行为，不扣任何在途计数
      if (!takeInFlight(ref)) return
      stats = onTileUnloaded(stats)
      afterSettled()
    },

    handleAbort(ref) {
      if (disposed) return
      if (!takeInFlight(ref)) return
      stats = onTileUnloaded(stats)
      afterSettled()
    },

    resetForViewChange() {
      if (disposed) return
      stalled = false
      if (stats.pending > 0) arm()
      else clearTimer()
      emit()
    },

    snapshot() {
      return { ...stats }
    },

    dispose() {
      disposed = true
      stalled = false
      clearTimer()
    },
  }
}

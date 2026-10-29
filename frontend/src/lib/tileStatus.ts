/**
 * 瓦片加载状态的结算逻辑：只描述「此刻还挂在底图上的瓦片」。
 *
 * 为什么不能按图层生命周期累计：tileload / tileerror 只增不减时，一次偶发失败会一直
 * 粘在界面上。用户平移、缩放之后当前视野的瓦片明明都成功了，界面还在说「部分瓦片加载
 * 失败」——那是在描述历史，不是在描述底图现在的样子。
 *
 * Leaflet 的事件足够支撑按瓦片身份撤销：每个 TileEvent 都带 tile（<img> 元素）和
 * coords（z/x/y）。tileloadstart 记一张瓦片；tileload / tileerror 给它结论；
 * tileunload（GridLayer._removeTile：瓦片被移出或离开 keepBuffer）和 tileabort
 * （TileLayer._abortLoading：换 zoom 时放弃在途瓦片）表示这张瓦片已经不在图上，整条
 * 记录跟着删掉。之后的迟到事件因为查不到记录被忽略——既不会扣掉别人的 pending，也
 * 不会把已经撤下的失败重新点亮。
 *
 * 判定范围的技术局限（有意保守）：Leaflet 的 keepBuffer 会在视野外额外保留约两圈
 * 瓦片，只靠事件分不清「视野内」和「缓冲区」。这里把「还挂在图层上」当作判定范围，
 * 缓冲区里的失败也算失败。方向是宁可多提示、不假装恢复：缓冲区瓦片没被卸载就不会
 * 重新请求，平移回去真的能看到缺口。要精确到像素视野得读 map.getPixelBounds() 和
 * 私有 TileRange，不属于事件层的职责，也不适合在没有浏览器布局的单测里自证。
 *
 * 容易被误判成「恢复了」的地方：缓冲区里的瓦片失败后并没有被卸载，Leaflet 不会重新
 * 请求它，那块缺口一直在，只是不在视野里。所以面向用户的文案必须跟着这个口径走——
 * partial / failed 覆盖的是「图层上的全部瓦片」，不是像素视窗：不能说成「你看到的
 * 底图有洞」，也不能承诺「平移就会重试」（仍挂在图层上的失败瓦片不会重发请求，要先
 * 移出缓冲区再移回，或者换 zoom 重建瓦片）。
 *
 * 还有一种结算不了的情况：浏览器只发了 tileloadstart，之后既不 load 也不 error
 * （请求挂住、代理静默丢弃、图片被拦但没有回调）。这时 pending 永远大于 0，
 * 状态会一直停在 loading，用户只看到一片灰底图却没有任何说明。
 * createTileWatch 负责这种情况：在途瓦片超过预算时间没有任何结论就转成 stalled，
 * 迟到的 load/error 仍按真实结果结算回来。
 */

export type TileState = 'loading' | 'ok' | 'partial' | 'failed' | 'stalled'

/** 一张瓦片此刻所处的阶段：在途 / 成功 / 失败 */
export type TileStatus = 'pending' | 'loaded' | 'failed'

export interface TileStats {
  /** 已开始、还没结束的瓦片数 */
  pending: number
  /** 当前成功、且仍挂在图上的瓦片数 */
  loaded: number
  /** 当前失败、且仍挂在图上的瓦片数 */
  failed: number
}

export const TILE_STATS_INITIAL: TileStats = Object.freeze({ pending: 0, loaded: 0, failed: 0 })

/**
 * 底图 watchdog 的等待预算。
 * 取 9 秒：正常首屏瓦片远快于它，挂死的请求又不会让用户盯着灰地图太久。
 */
export const TILE_STALL_TIMEOUT_MS = 9000

export function onTileLoadStart(stats: TileStats): TileStats {
  return { ...stats, pending: stats.pending + 1 }
}

/** 单个瓦片结束（成功或失败）后记一笔；pending 不会掉到负数 */
export function onTileSettled(stats: TileStats, outcome: 'load' | 'error'): TileStats {
  const pending = Math.max(0, stats.pending - 1)
  return outcome === 'load'
    ? { ...stats, pending, loaded: stats.loaded + 1 }
    : { ...stats, pending, failed: stats.failed + 1 }
}

/** 在途瓦片被拿掉（还没结论就离场）：只扣 pending。等价于 onTileRemoved(stats, 'pending') */
export function onTileUnloaded(stats: TileStats): TileStats {
  return { ...stats, pending: Math.max(0, stats.pending - 1) }
}

/**
 * 瓦片离场（tileunload / tileabort）时按它当时的真实阶段撤账。
 *
 * 关键点：撤的是「这张瓦片自己」那一笔。已成功的瓦片离场只减 loaded，不会顺手把
 * 另一张仍在途瓦片的 pending 减掉；已失败的瓦片离场则把那笔失败一起带走，界面不再
 * 报历史错误。
 */
export function onTileRemoved(stats: TileStats, status: TileStatus): TileStats {
  if (status === 'pending') return onTileUnloaded(stats)
  if (status === 'loaded') return { ...stats, loaded: Math.max(0, stats.loaded - 1) }
  return { ...stats, failed: Math.max(0, stats.failed - 1) }
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
  /** tileunload：瓦片被移除（出视野 / 被 prune / 图层被清） */
  handleUnload(tile?: TileRef): void
  /** tileabort：Leaflet 放弃在途瓦片（换 zoom 时只发这个，不发 unload） */
  handleAbort(tile?: TileRef): void
  /** 视图换了（换天 / 重新适配视野）：旧计时作废，有在途瓦片就从现在重新计时 */
  resetForViewChange(): void
  /** 当前计数快照，供调用方与测试观察 */
  snapshot(): TileStats
  /** 卸载：清定时器与在册瓦片，之后不再回调 */
  dispose(): void
}

/**
 * 把「事件 → 状态」和 watchdog 定时器收在一起，组件只负责转发 Leaflet 事件。
 *
 * 记账规则：
 * - 在册瓦片集合就是界面此刻的底图：只有它里面的瓦片参与计数；
 * - 同一瓦片重复 start 不重复计 pending；
 * - load/error 只对仍在途的那张瓦片生效，重复或迟到的同类事件直接忽略；
 * - unload/abort 按那张瓦片当时的真实阶段撤账（见 onTileRemoved），撤完就删记录，
 *   之后它再来什么事件都查不到，不会影响别人。
 *
 * 计时规则：
 * - 没有在途瓦片（pending 为 0）不启动计时，避免空日或还没开始加载就报超时；
 * - 连续 tileloadstart 不重置计时，否则慢吞吞的请求会把截止时间一直往后推；
 * - 只有 pending 真的变了才重新计时：把已结算的瓦片卸载掉不算「加载有进展」，
 *   不能借它把挂起瓦片的截止时间推后；
 * - 在途瓦片给出结论后清掉 stalled 并重新给剩余瓦片一个完整预算；
 * - 超时只表示「没有拿到瓦片结果」，不代表网络断了，文案由调用方负责。
 */
export function createTileWatch(
  onState: (state: TileState) => void,
  options: TileWatchOptions = {},
): TileWatch {
  const stallTimeoutMs = options.stallTimeoutMs ?? TILE_STALL_TIMEOUT_MS
  /** 此刻还挂在底图上的瓦片：key → 阶段。stats 是它的汇总 */
  const live = new Map<string, TileStatus>()
  let stats: TileStats = TILE_STATS_INITIAL
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

  /**
   * 计数变化后的统一收尾。
   *
   * 只有「在途数量变了」才重新计时：瓦片离场不一定有结论，一次平移把已成功的瓦片
   * 卸掉不该把挂起瓦片的截止时间往后推。pending 归零则连告警一起撤掉。
   */
  const afterDelta = (pendingChanged: boolean): void => {
    if (stats.pending === 0) {
      stalled = false
      clearTimer()
    } else if (pendingChanged) {
      stalled = false
      arm()
    }
    emit()
  }

  /**
   * 事件 → 此刻在册的瓦片 key。
   * 返回 null 表示这张瓦片已经不在册（重复事件、迟到事件、已被卸载），一律不记账。
   */
  const resolveLiveKey = (ref: TileRef | undefined, onlyPending = false): string | null => {
    const key = tileKeyOf(ref)
    if (key !== null) {
      const status = live.get(key)
      if (status === undefined) return null
      return !onlyPending || status === 'pending' ? key : null
    }
    // 没有身份的事件只能按到达顺序认领一个匿名在途记录（兜底路径）
    for (const [candidate, status] of live) {
      if (status === 'pending' && candidate.startsWith(ANONYMOUS_PREFIX)) return candidate
    }
    return null
  }

  /** 瓦片离场：按真实阶段撤账并删记录；不在册的事件什么都不做 */
  const forget = (ref: TileRef | undefined, onlyPending = false): void => {
    if (disposed) return
    const key = resolveLiveKey(ref, onlyPending)
    if (key === null) return
    const status = live.get(key)
    if (status === undefined) return
    live.delete(key)
    stats = onTileRemoved(stats, status)
    afterDelta(status === 'pending')
  }

  return {
    handleStart(ref) {
      if (disposed) return
      const key = tileKeyOf(ref) ?? `${ANONYMOUS_PREFIX}${anonymousSeq++}`
      // 同一个瓦片重复 start：不能重复计 pending，否则永远等不到对应数量的结束事件
      if (live.has(key)) return
      live.set(key, 'pending')
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
      // 只有仍在途的那张瓦片能给结论：已结算的重复事件、已被卸载后才到的迟到事件
      // 都在这里被挡掉，否则一张瓦片会被算两次，还会把别人挂起的 pending 吃掉
      const key = resolveLiveKey(ref, true)
      if (key === null) return
      live.set(key, outcome === 'load' ? 'loaded' : 'failed')
      stats = onTileSettled(stats, outcome)
      afterDelta(true)
    },

    handleUnload(ref) {
      // unload 只说明「这张瓦片离开图层」，成功还是失败都成立，按它当时的阶段撤账
      forget(ref)
    },

    handleAbort(ref) {
      // abort 的语义是「这张还在加载的瓦片不要了」：Leaflet 的 _abortLoading 只挑
      // 未完成的瓦片。已结算的瓦片要是收到 abort（重复/迟到），不能拿它撤掉一条
      // 真实可见的成功记录
      forget(ref, true)
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
      live.clear()
      stats = TILE_STATS_INITIAL
    },
  }
}

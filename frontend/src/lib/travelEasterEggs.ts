/**
 * 六期 S3 · 电影彩蛋纯逻辑层（零数据影响）——成都水印 + credits 箴言。
 *
 * 全部纯函数，不碰 DOM / 存储 / 网络 / 时钟，不引入 Math.random：
 * - 成都暗号：destination 含「成都」→ 返回小熊猫剪影 SVG 片段（淡色水印），
 *   由 lib/shareMiniMap.ts 在小地图角落追加；不影响几何与坐标分组。
 * - credits 箴言：按 trip.id 确定性选句（FNV-1a hash 取模），同 id 同句；
 *   hash 实现与 lib/calendar.ts 的 UID 双轮 FNV-1a 同一算法口径。
 *
 * 节日表与相交判定在 lib/festivalCalendar.ts（单独成文件：主包只带节日表，
 * 本文件整体留在 lazy chunk——引用方 RouteReplayPanel / shareMiniMap 均按需加载）。
 *
 * 边界（六期 §4.2）：纯装饰层，输出只是「要显示的字符串」，调用方拼进视图；
 * 绝不写 Trip、不写 localStorage、不发请求。
 */

/* ───────────────────────── 成都暗号（小熊猫水印） ───────────────────────── */

/**
 * 小熊猫剪影 SVG path（手绘简洁风：圆耳 + 圆脸侧影，48×48 视框）。
 * 纯装饰：与坐标分组无关，不携带任何站点信息。
 */
const PANDA_SILHOUETTE_PATH =
  'M10 30 Q6 26 7 20 Q8 13 14 11 Q15 5 20 5 Q24 5 25 9 Q27 8 29 9 Q31 5 35 6 Q39 7 39 12 ' +
  'Q45 15 45 22 Q45 28 40 30 Q44 32 44 36 Q43 40 38 40 L36 40 Q34 44 29 44 L20 44 Q15 44 13 40 ' +
  'L10 40 Q5 40 4 36 Q3 32 8 31 Z'

export interface PandaWatermark {
  /** 水印 <g> 片段；调用方插入小地图 SVG 末尾（角落在上层，不遮站点编号）。 */
  svgFragment: string
  /** 无障碍说明；进 aria title，读屏可跳过。 */
  label: string
}

/**
 * 成都暗号判定：destination 含「成都」→ 返回确定性水印片段。
 * 输出只依赖调用（无随机、无时钟），同一输入逐字节相同；非成都返回 null。
 */
export function pandaWatermarkFor(destination: string): PandaWatermark | null {
  if (!destination.includes('成都')) return null
  const fragment =
    `<g data-panda-watermark="true" aria-hidden="true" opacity="0.28">` +
    `<path d="${PANDA_SILHOUETTE_PATH}" fill="#b9a98d" stroke="none"/>` +
    `</g>`
  return { svgFragment: fragment, label: '小熊猫剪影水印（成都彩蛋）' }
}

/* ───────────────────────── credits 尾帧箴言 ───────────────────────── */

/**
 * 内置旅行箴言（6 句，静态文案）。选择按 trip.id 确定性 hash 取模，不引入随机。
 */
const TRAVEL_QUOTES: readonly string[] = [
  '旅途的意义不在终点，而在沿途照亮你的那些瞬间。',
  '走得慢一点，让风景追上你。',
  '每一条没走过的路，都比想象中近。',
  '把日程留给城市，把意外留给晴天。',
  '最好的向导是好奇心，其次是本地公交。',
  '回程的行囊里，装着出发时没有的自己。',
]

/** FNV-1a 32 位哈希（与 lib/calendar.ts UID 同一算法口径）；确定性、零随机。 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * credits 定格尾帧箴言：按 trip.id 确定性选择，同行程同句。
 * id 缺失 / 空串按空串参与 hash（依然确定）；箴言表非空恒有输出。
 */
export function travelQuoteFor(tripId: string): string {
  const hash = fnv1a(tripId)
  return TRAVEL_QUOTES[hash % TRAVEL_QUOTES.length] ?? TRAVEL_QUOTES[0]
}

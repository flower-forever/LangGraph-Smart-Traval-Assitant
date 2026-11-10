/**
 * 六期 S2 · 交互动效常量：地图飞行时长。
 *
 * 统一 TripMap（选中联动）与 RouteReplayPanel（回放到站 / 换天）的 Leaflet
 * flyTo 时长。放在 lib 而不是 CSS token：Leaflet duration 是 JS 参数，不是
 * CSS 属性；文件头注释指回 theme.css 的 motion tokens（fast/normal/slow 三档），
 * 数值取「slow 档 300ms 的延长口径」——飞行距离长，300ms 会显得急促，0.75s
 * 是「slow 档的地图版」。零新依赖、零网络、零写入。
 */

/** TripMap：点选站点 / 列表选中联动时的平滑飞行时长（秒）。 */
export const MAP_FLY_DURATION_S = 0.75

/** 回放面板：到站平移的平滑飞行时长（秒）。 */
export const REPLAY_FLY_DURATION_S = 0.75

/**
 * 换一翻卡：动画标注在站点行上停留多久后清除（毫秒）。
 * 与 app.css 的 `calc(var(--motion-normal) * 2)`（滑出+滑入各一个 normal 档）
 * 同源：180ms × 2 = 360ms，再留 140ms 余量覆盖定时器抖动与慢帧。
 * 只用于 setTimeout 清 data-swap-anim，不进任何 CSS。
 */
export const SWAP_ANIM_CLEAR_MS = 500

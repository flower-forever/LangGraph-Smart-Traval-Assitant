/**
 * 六期 S7 · 绕行拦截阈值（单一权威）。
 *
 * 单独成文件是为了让 `DetourInterceptCard.tsx` 的轻量预筛只带两个常量进主包，
 * 不把 `detourIntercept.ts`（含 haversine 依赖）拖进主 chunk。
 *
 * 保守性理由见 `detourIntercept.ts` 顶部注释。
 */

/** 命中所需的最小实际里程（公里）：低于这条地板，比例再高也不拦。 */
export const DETOUR_INTERCEPT_MIN_KM = 30

/** 命中所需的「实际里程 / 直线距离」倍数。 */
export const DETOUR_INTERCEPT_RATIO = 3

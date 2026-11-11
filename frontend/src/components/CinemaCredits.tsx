/**
 * 六期 S3 · 电影片尾 credits（RouteReplayPanel 内部组件）。
 *
 * 规格（六期 §4.1）：正片正常播完（非 Esc 提前退出）→ credits 滚动 3–4s
 * （行程名 + 既有口径「路线与时间仅为参考」）；结束后定格尾帧；Esc 中途退出不进
 * credits。尾帧箴言按 trip.id 确定性选择（lib/travelEasterEggs.ts）。
 *
 * 边界（六期 §0.3 动效专属条款）：
 * - 只动 transform / opacity：credits 内容块从下往上滚（translateY），滚动时长是
 *   产品行为参数（CREDITS_SCROLL_DURATION_MS 3500ms），CSS 里通过 --cinema-credits
 *   变量注入，缓动线性（滚动感），其余时长引用 --motion-* tokens。
 * - reduced-motion：credits 不滚动改静态整页（CSS 降级分支去掉 translateY 动画，
 *   内容直接完整呈现）；data-reduced 落在 DOM 上供测试钉住。
 * - 纯装饰层：不读不写存储、不发请求、不进 Trip / localStorage；aria-hidden，
 *   不进 tab 序。
 * - 定格尾帧（phase='end'）：滚动动画 forwards 停在最终帧，父层保持挂载即定格。
 */

import type { CSSProperties } from 'react'

import { CREDITS_SCROLL_DURATION_MS } from '../lib/cinemaWrapper'

export interface CinemaCreditsProps {
  /** 行程名（credits 主行）。 */
  tripTitle: string
  /** 目的地 + 日期区间（credits 次行）。 */
  subtitle: string
  /** 尾帧箴言（trip.id 确定性；定格尾帧显示）。 */
  quote: string
  /** true = 定格尾帧（credits 已滚动完）；false = 滚动中。 */
  settled: boolean
  /** reduced-motion 公共通道当前值：仅决定 data-reduced 标注，样式降级在 CSS。 */
  reducedMotion: boolean
}

export default function CinemaCredits({
  tripTitle,
  subtitle,
  quote,
  settled,
  reducedMotion,
}: CinemaCreditsProps) {
  return (
    <div
      className="oc-cinema-credits"
      data-testid="cinema-credits"
      data-reduced={reducedMotion ? 'true' : 'false'}
      data-settled={settled ? 'true' : 'false'}
      aria-hidden="true"
      // 滚动总时长是产品行为参数（lib/cinemaWrapper.ts 单一来源）：注入 CSS 变量，
      // CSS 不写死秒数。定格（settled）后动画停在 forwards 最终帧，无需改动。
      style={{ '--cinema-credits-scroll': `${CREDITS_SCROLL_DURATION_MS}ms` } as CSSProperties}
    >
      <div className="oc-cinema-credits-scroll">
        <p className="oc-cinema-credits-brand">路线回放</p>
        <p className="oc-cinema-credits-title">{tripTitle}</p>
        <p className="oc-cinema-credits-subtitle">{subtitle}</p>
        <p className="oc-cinema-credits-divider" />
        <p className="oc-cinema-credits-note">
          路线与时间仅为参考；开放时间、票价与交通信息请以官方渠道为准。
        </p>
        <p className="oc-cinema-credits-quote">{quote}</p>
      </div>
    </div>
  )
}

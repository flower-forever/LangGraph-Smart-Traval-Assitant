import type { TripStop } from '../lib/api'
import { projectDepthGeneratedDate, projectStopDepth } from '../lib/stopDepth'

/**
 * 六期 S5 景点深度卡（信息深度 B）· 懒加载实现体。
 *
 * 本文件只被 `StopDepthCard.tsx` 的 `lazy(() => import(...))` 引用，
 * 与 `lib/stopDepth.ts` 投影一起落在独立 chunk，避免主包回涨。
 *
 * - 只读展示：不写存储、不发请求、不改行程。
 * - 无任何深度块：返回 null；有块但逐项缺失：该分区显示「未提供」，不编造。
 * - 「AI 生成·供参考」徽章与「出发前请自行确认」提示常驻。
 * - P6.5 X4：有生成时间时显示「生成于 YYYY-MM-DD」（UTC 存储转本地日期）；
 *   旧行程没有该字段就不显示，不伪造。
 * - 与 S2 三态徽章分工：易变事实（营业 / 票价）看核实状态，稳定知识看生成标注。
 * - 样式全部用组件内 Tailwind 类，不新增全局 CSS。
 */

export interface StopDepthCardContentProps {
  stop: TripStop
}

const SECTION_TITLE =
  'm-0 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-secondary-foreground)]'
const SECTION_BODY = 'm-0 mt-1 text-sm text-foreground'
const MUTED = 'text-[color:var(--color-faint)]'

export default function StopDepthCardContent({ stop }: StopDepthCardContentProps) {
  const view = projectStopDepth(stop)
  const generatedDate = projectDepthGeneratedDate(stop)
  if (!view) return null

  return (
    <section
      data-testid={`stop-depth-card-${stop.id}`}
      aria-label={`景点深度：${stop.name}`}
      className="mt-3 rounded-[8px] border border-[color:var(--color-line-strong)] bg-secondary/50 px-3 py-2.5 text-sm leading-relaxed"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="m-0 text-sm font-semibold text-foreground">景点深度</p>
        <span
          data-testid="stop-depth-badge"
          className="rounded-full border border-[color:var(--color-line-strong)] bg-card px-2 py-0.5 text-[11px] font-normal text-[color:var(--color-secondary-foreground)]"
        >
          AI 生成·供参考
        </span>
        {generatedDate ? (
          <span
            data-testid="stop-depth-generated-at"
            className="text-[11px] text-[color:var(--color-secondary-foreground)]"
          >
            生成于 {generatedDate}
          </span>
        ) : null}
      </div>
      <p className="m-0 mt-1 text-[11px] text-[color:var(--color-secondary-foreground)]">
        以下为稳定知识与游玩建议；营业时间、票价等易变信息以下方核实状态为准。
      </p>

      <div className="mt-2 grid gap-2">
        <section data-testid="stop-depth-highlights" aria-label="看点">
          <h4 className={SECTION_TITLE}>看点</h4>
          {view.highlights.length === 0 ? (
            <p className={`${SECTION_BODY} ${MUTED}`}>未提供</p>
          ) : (
            <ul className="m-0 mt-1 grid list-none gap-1 p-0">
              {view.highlights.map((highlight) => (
                <li key={highlight} className="flex gap-1.5">
                  <span aria-hidden="true" className="text-[color:var(--color-accent-foreground)]">
                    ·
                  </span>
                  <span>{highlight}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section data-testid="stop-depth-suitable" aria-label="适合">
          <h4 className={SECTION_TITLE}>适合</h4>
          {view.suitableFor.length === 0 ? (
            <p className={`${SECTION_BODY} ${MUTED}`}>未提供</p>
          ) : (
            <ul className="m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0">
              {view.suitableFor.map((tag) => (
                <li
                  key={tag.value}
                  className="rounded-full border border-[color:var(--color-line-strong)] bg-card px-2 py-0.5 text-xs text-[color:var(--color-secondary-foreground)]"
                >
                  {tag.label}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section data-testid="stop-depth-stay" aria-label="建议停留">
          <h4 className={SECTION_TITLE}>建议停留</h4>
          <p className={`${SECTION_BODY} ${view.suggestedStayMinutes ? '' : MUTED}`}>
            {view.suggestedStayMinutes
              ? `建议停留 ${view.suggestedStayMinutes.min}–${view.suggestedStayMinutes.max} 分钟`
              : '未提供'}
          </p>
        </section>

        <section data-testid="stop-depth-tips" aria-label="贴士">
          <h4 className={SECTION_TITLE}>贴士</h4>
          {view.tips.length === 0 ? (
            <p className={`${SECTION_BODY} ${MUTED}`}>未提供</p>
          ) : (
            <ul className="m-0 mt-1 grid list-none gap-1 p-0">
              {view.tips.map((tip) => (
                <li key={tip} className="flex gap-1.5">
                  <span aria-hidden="true" className="text-[color:var(--color-accent-foreground)]">
                    ·
                  </span>
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p data-testid="stop-depth-disclaimer" className={`m-0 mt-2 text-[11px] ${MUTED}`}>
        AI 生成内容仅供行程参考，出发前请自行确认。
      </p>
    </section>
  )
}

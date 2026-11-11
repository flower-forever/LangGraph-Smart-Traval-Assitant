import { useState } from 'react'

import type { CityProfile } from '../lib/api'
import { projectCityProfile } from '../lib/cityProfile'

/**
 * 六期 S4 城市导览卡（信息深度 A）· 懒加载实现体。
 *
 * 本文件只被 `CityProfileCard.tsx` 的 `lazy(() => import(...))` 引用，
 * 与 `lib/cityProfile.ts` 投影一起落在独立 chunk，避免主包回涨。
 *
 * - 只读展示：不写存储、不发请求、不改行程。
 * - 无 cityProfile / 所有块都缺省：组件返回 null，由父级决定是否挂载。
 * - 单个块缺字段：该分区显示「未提供」，不编造。
 * - 「AI 生成·供参考」徽章与「出发前请自行确认」提示常驻，折叠时不消失。
 * - 样式全部用组件内 Tailwind 类，不新增全局 CSS。
 */

export interface CityProfileCardProps {
  cityProfile?: CityProfile | null
  /** 默认展开；折叠只是组件内状态，不持久化。 */
  defaultOpen?: boolean
}

const SECTION_TITLE =
  'm-0 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-secondary-foreground)]'
const SECTION_BODY = 'm-0 mt-1 text-sm text-foreground'
const MUTED = 'text-[color:var(--color-faint)]'

export default function CityProfileCardContent({
  cityProfile,
  defaultOpen = true,
}: CityProfileCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  const view = projectCityProfile(cityProfile)
  if (!view) return null

  return (
    <section
      data-testid="city-profile-card"
      aria-label="城市导览"
      className="mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-line-strong)] bg-card px-4 py-3 text-sm leading-relaxed"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 flex flex-wrap items-center gap-2 font-semibold">
          城市导览
          <span
            data-testid="city-profile-badge"
            className="rounded-full border border-[color:var(--color-line-strong)] bg-secondary px-2 py-0.5 text-xs font-normal text-[color:var(--color-secondary-foreground)]"
          >
            AI 生成·供参考
          </span>
        </p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          data-testid="city-profile-toggle"
          className="min-h-9 cursor-pointer rounded-[6px] px-2 py-1 text-xs text-[color:var(--color-secondary-foreground)] hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent-foreground)]"
        >
          {open ? '收起' : '展开'}
        </button>
      </div>

      {open && (
        <div data-testid="city-profile-body" className="mt-3 grid gap-3">
          <section data-testid="city-profile-impression" aria-label="一句话印象">
            <h3 className={SECTION_TITLE}>一句话印象</h3>
            <p className={`${SECTION_BODY} ${view.oneLineImpression ? '' : MUTED}`}>
              {view.oneLineImpression ?? '未提供'}
            </p>
          </section>

          <section data-testid="city-profile-days" aria-label="建议天数">
            <h3 className={SECTION_TITLE}>建议天数</h3>
            <p className={`${SECTION_BODY} ${view.suggestedDays ? '' : MUTED}`}>
              {view.suggestedDays
                ? `建议游玩 ${view.suggestedDays.min}–${view.suggestedDays.max} 天`
                : '未提供'}
            </p>
          </section>

          <section data-testid="city-profile-districts" aria-label="片区">
            <h3 className={SECTION_TITLE}>片区</h3>
            {view.districts.length === 0 ? (
              <p className={`${SECTION_BODY} ${MUTED}`}>未提供</p>
            ) : (
              <ul className="m-0 mt-1 grid list-none gap-2 p-0">
                {view.districts.map((district) => (
                  <li key={district.name} className="rounded-[6px] bg-secondary/60 px-3 py-2">
                    <p className="m-0">
                      <span className="font-semibold">{district.name}</span>
                      {district.summary && <span>：{district.summary}</span>}
                    </p>
                    {district.attractions.length > 0 && (
                      <p className="m-0 mt-1 text-xs text-[color:var(--color-secondary-foreground)]">
                        代表景点：{district.attractions.join('、')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section data-testid="city-profile-season" aria-label="当季贴士">
            <h3 className={SECTION_TITLE}>当季贴士</h3>
            <p className={`${SECTION_BODY} ${view.seasonTips ? '' : MUTED}`}>
              {view.seasonTips ?? '未提供'}
            </p>
          </section>

          <section data-testid="city-profile-classics" aria-label="经典清单">
            <h3 className={SECTION_TITLE}>
              经典清单{view.classicList.length > 0 ? ` · ${view.classicList.length} 条` : ''}
            </h3>
            {view.classicList.length === 0 ? (
              <p className={`${SECTION_BODY} ${MUTED}`}>未提供</p>
            ) : (
              <ol className="m-0 mt-1 grid list-none gap-1.5 p-0">
                {view.classicList.map((item) => (
                  <li key={item.name}>
                    <span className="font-semibold">{item.name}</span>
                    {item.reason && <span>：{item.reason}</span>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}

      <p data-testid="city-profile-disclaimer" className={`m-0 mt-2 text-xs ${MUTED}`}>
        AI 生成内容仅供行程参考；营业时间、票价与预约政策请以官方渠道为准，出发前请自行确认。
      </p>
    </section>
  )
}

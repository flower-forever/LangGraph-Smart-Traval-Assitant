import type { TripDay } from '../lib/api'
import { analyzeDayRoute } from '../lib/routeFlow'

/**
 * 顺路度只读提示（四期 S5）。
 *
 * 只提示相邻两站交换可缩短路程的情况；没有可信建议（站点不足、坐标缺失、
 * 无改善或全程零距离）时整卡不渲染，诚实沉默。组件不提供应用入口、不写存储，
 * 也不修改行程。
 */
export default function RouteFlowHint({ day }: { day: TripDay }) {
  const analysis = analyzeDayRoute(
    day.stops.map((stop) => ({
      name: stop.name,
      lat: stop.location?.lat ?? null,
      lng: stop.location?.lng ?? null,
    })),
  )

  if (analysis.status !== 'suggestion') return null

  const { index, improvementRatio, savedKm } = analysis.suggestion
  const percent = (improvementRatio * 100).toFixed(1)
  const km = savedKm.toFixed(1)
  const message =
    `本日路线可优化：第 ${index} 站与第 ${index + 1} 站互换，` +
    `路程约缩短 ${percent}%（约 ${km} 公里）。`

  return (
    <div
      role="status"
      data-testid="route-flow-hint"
      className="mb-4 min-w-0 max-w-[72ch] rounded-[10px] border border-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] px-4 py-3 text-sm leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]"
    >
      <p className="m-0 font-semibold">{message}</p>
      <p className="m-0 mt-1 text-xs leading-relaxed">
        只提示相邻两站的交换，不是全局最优路线；不会自动修改行程，是否调整请用编辑或 AI 助手。
      </p>
    </div>
  )
}

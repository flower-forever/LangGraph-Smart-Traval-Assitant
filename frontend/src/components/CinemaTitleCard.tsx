/**
 * 六期 S3 · 电影片头标题卡（RouteReplayPanel 内部组件）。
 *
 * 规格（六期 §4.1）：进入电影模式后 1.5s 标题卡（城市 + 行程日期），点击 / 按键
 * 立即可跳过；跳过或自动结束后才开始正片推进。Esc 保留给面板既有「退出电影模式」
 * 语义，跳过按键是任意非 Esc 键。
 *
 * 边界（六期 §0.3 动效专属条款）：
 * - 只动 transform / opacity：入场淡入 + 缓慢放大（片头「推近感」），时长引用
 *   --motion-* tokens（app.css 的 .oc-cinema-title）。
 * - reduced-motion：标题卡直显直隐——CSS 降级分支把动画整段退化为瞬时（0.01ms），
 *   组件层不写分支逻辑；data-reduced 落在 DOM 上供测试钉住。
 * - 纯装饰层：不读不写存储、不发请求、不进 Trip / localStorage；aria-hidden，
 *   不进 tab 序、不截键盘（点击跳过走整卡 click，按键跳过由父面板 onEscape 接线）。
 * - 覆盖层 pointer-events: auto（本层必须能点），但只在电影模式 title 阶段挂载，
 *   卸载后不残留。
 */

export interface CinemaTitleCardProps {
  /** 标题主行：行程目的地 / 行程名。 */
  destination: string
  /** 副行：行程日期区间文本（无日期时由父层传「日期未提供」）。 */
  dateRange: string
  /** reduced-motion 公共通道当前值：仅决定 data-reduced 标注，样式降级在 CSS。 */
  reducedMotion: boolean
  /** 用户点击标题卡（= 跳过片头）。 */
  onSkip: () => void
}

export default function CinemaTitleCard({
  destination,
  dateRange,
  reducedMotion,
  onSkip,
}: CinemaTitleCardProps) {
  return (
    // role=presentation：整卡是一个大按钮的语义由父层 aria 处理；这里保持装饰层定位
    <button
      type="button"
      className="oc-cinema-title"
      data-testid="cinema-title-card"
      data-reduced={reducedMotion ? 'true' : 'false'}
      onClick={onSkip}
      aria-label={`片头：${destination}，点击跳过`}
    >
      <span className="oc-cinema-title-frame" aria-hidden="true" />
      <span className="oc-cinema-title-destination">{destination}</span>
      <span className="oc-cinema-title-date">{dateRange}</span>
      <span className="oc-cinema-title-hint" aria-hidden="true">
        点击或按任意键跳过
      </span>
    </button>
  )
}

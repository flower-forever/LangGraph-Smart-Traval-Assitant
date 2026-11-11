/**
 * 六期 S1 · 落印 StampSeal：规划成功时朱砂印章「行程既定」盖在行程区顶部。
 *
 * 边界（六期 §2 落印规格 + §0.3 动效专属条款）：
 * - 纯展示层：零数据影响——不读不写任何存储、不发请求、不进 Trip / localStorage；
 *   不注册键盘事件、不参与 tab 序（aria-hidden + 无交互元素）。
 * - 不阻塞交互：整枚印章 pointer-events: none，永不截住行程区的点击
 *   （E2E 场景会在落印展示期间真实点击页面）。
 * - 只动 transform / opacity：淡入 + 纸面微震（transform 位移）+ 静默淡出，
 *   时长/缓动全部引用 --motion-* tokens（app.css 的 .oc-stamp-seal）。
 * - 生命周期归 App 层：挂载即播放入场，驻留 --motion-dwell-stamp（2.5s）后 CSS
 *   静默淡出，App 计时器随后卸载。组件不监听 animationend——jsdom 没有
 *   AnimationEvent，动画名过滤在跨环境都不可靠；卸载晚于淡出完成是安全顺序
 *   （淡出 forwards 保持隐藏），提前卸载也不会截断任何交互。
 * - reduced-motion：app.css 降级分支把微震帧整个去掉、入场退化为瞬时——组件层
 *   不需要分支逻辑，但 data-reduced 仍落在 DOM 上供测试钉住「仅淡入不震动」。
 * - 六期 S3 彩蛋②：节日问候小字只是印章下方一行静态文字（同一 aria-hidden 容器），
 *   随印章整体淡入淡出，不引入任何独立动效。
 */

export interface StampSealProps {
  /** reduced-motion 公共通道的当前值：仅决定 data-reduced 标注，样式降级在 CSS。 */
  reducedMotion: boolean
  /**
   * 六期 S3 彩蛋②：行程日期区间命中内置节日表时的问候小字（如「端午安康」），
   * 显示在印章面下方；undefined / null = 无彩蛋（旧行为不变）。
   * 纯装饰字符串，由 App 层用 lib/travelEasterEggs.ts 算出；组件自身零逻辑零写入。
   */
  festivalGreeting?: string | null
}

export default function StampSeal({ reducedMotion, festivalGreeting }: StampSealProps) {
  return (
    <div
      className="oc-stamp-seal"
      data-testid="stamp-seal"
      data-reduced={reducedMotion ? 'true' : 'false'}
      data-festival={festivalGreeting ? 'true' : 'false'}
      aria-hidden="true"
    >
      <span className="stamp-seal-face">行程既定</span>
      {festivalGreeting && (
        <span className="stamp-seal-festival" data-testid="stamp-seal-festival">
          {festivalGreeting}
        </span>
      )}
    </div>
  )
}

/**
 * 六期 S3 · 电影包装状态机（片头标题卡 + 片尾 credits）纯逻辑。
 *
 * 与 RouteReplayPanel 的既有播放状态机（lib/routeReplay.ts）分层：本文件只管
 * 「包装层」的阶段流转，不碰播放进度；RouteReplayPanel 的 reducer 依旧管理站点 /
 * 路段 / finished。全部纯函数可单测、零副作用。
 *
 * 阶段（CinemaPhase）：
 * - 'idle'      ：非电影模式，无包装层。
 * - 'title'     ：进入电影模式后的片头标题卡（1.5s 自动推进，点击 / 按键立即跳过）。
 * - 'playing'   ：正片播放（交回 RouteReplayPanel 既有状态机推进）。
 * - 'credits'   ：正片「正常播完」（phase === 'finished' 且非 Esc 退出）→ credits 滚动
 *                 3.5s，结束后定格尾帧（'end'）。
 * - 'end'       ：credits 播完的定格尾帧（含箴言），显示直到退出电影模式。
 *
 * Esc 语义（沿用面板既有口径，六期 S3 不改它）：
 * - Esc 在电影模式任何阶段（含片头）都是退出电影模式；非电影模式 Esc 关闭面板。
 *   「Esc 中途退出不进 credits」由该语义自然满足——退出即回 idle，credits 消失。
 * - 片头跳过走「点击 / 任意非 Esc 按键」（面板在 title 阶段挂 document keydown，
 *   Escape 显式放行给 useDialogFocus），提示文案见 CinemaTitleCard。
 */

/** 片头标题卡自动推进时长（ms）；规格 1.5s。 */
export const TITLE_CARD_DURATION_MS = 1500
/** credits 滚动时长（ms）；规格 3–4s，取 3.5s。 */
export const CREDITS_SCROLL_DURATION_MS = 3500

export type CinemaPhase = 'idle' | 'title' | 'playing' | 'credits' | 'end'

export interface CinemaState {
  phase: CinemaPhase
}

export const INITIAL_CINEMA_STATE: CinemaState = { phase: 'idle' }

export type CinemaAction =
  | { type: 'enter' }
  | { type: 'exit' }
  /** 片头自动推进完成（定时器触发）。 */
  | { type: 'titleDone' }
  /** 用户在片头点击 / 按键跳过。 */
  | { type: 'titleSkip' }
  /** 正片正常播完（replay state.phase 变为 finished 且非 Esc 退出）。 */
  | { type: 'replayFinished' }
  /** credits 滚动完成（定时器触发）→ 定格尾帧。 */
  | { type: 'creditsDone' }

/** 阶段守卫：动作只在自己所属阶段生效，跨阶段的动作原样返回旧状态（幂等）。 */
export function reduceCinema(state: CinemaState, action: CinemaAction): CinemaState {
  switch (action.type) {
    case 'enter':
      // 电影模式开启：从片头开始；重复 enter（已开着）不重放片头。
      return state.phase === 'idle' ? { phase: 'title' } : state
    case 'exit':
      // 退出电影模式回到 idle；任何阶段都允许（面板 Esc 的既有语义）。
      return state.phase === 'idle' ? state : { phase: 'idle' }
    case 'titleDone':
      return state.phase === 'title' ? { phase: 'playing' } : state
    case 'titleSkip':
      return state.phase === 'title' ? { phase: 'playing' } : state
    case 'replayFinished':
      // 只有正片推进中播完才进 credits；从 credits / end 重入（例如手动拖动后再次
      // 播完）不重复滚动——credits 每次电影模式只放一次，定格后保持尾帧。
      return state.phase === 'playing' ? { phase: 'credits' } : state
    case 'creditsDone':
      return state.phase === 'credits' ? { phase: 'end' } : state
    default:
      return state
  }
}

/**
 * Esc 处理（六期 S3 设计修订）：Esc 在电影模式任何阶段都交回面板既有逻辑
 * （退电影模式 / 关面板）——「Esc 中途退出不进 credits」由退出语义自然满足。
 * 本函数恒返回 false，保留导出是为了状态机完整性测试与未来若要区分 credits 阶段
 * Esc 行为时不再改签名；面板不再调用它。
 */
export function cinemaHandlesEscape(state: CinemaState): boolean {
  void state
  return false
}

/**
 * 片头跳过按键判定：片头阶段任何非 Escape 键都跳过（规格「点击 / 按键立即跳过」；
 * Esc 保留给退出电影模式，与面板既有 Esc 语义不冲突）。
 */
export function titleSkipKey(key: string): boolean {
  return key !== 'Escape'
}

/**
 * credits 触发判定（给 RouteReplayPanel 的 effect 用）：只有「正片推进中到达
 * finished」才发 replayFinished。面板其它路径（换天空日、Esc 退出）不会走到这里——
 * 换天会 dispatch reset 回 station，Esc 直接退出电影模式。
 */
export function shouldEnterCredits(
  phase: CinemaPhase,
  replayFinished: boolean,
): boolean {
  return phase === 'playing' && replayFinished
}

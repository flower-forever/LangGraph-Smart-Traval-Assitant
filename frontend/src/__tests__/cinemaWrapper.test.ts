/**
 * 六期 S3 · 电影包装状态机测试：片头跳过 / 自动推进、credits 只在正常播完触发、
 * Esc 语义、定格幂等。纯函数，零 DOM 零存储。
 */
import { describe, expect, it } from 'vitest'

import {
  CREDITS_SCROLL_DURATION_MS,
  INITIAL_CINEMA_STATE,
  TITLE_CARD_DURATION_MS,
  cinemaHandlesEscape,
  reduceCinema,
  shouldEnterCredits,
  titleSkipKey,
} from '../lib/cinemaWrapper'

describe('规格常量', () => {
  it('片头 1.5s、credits 3.5s（规格 3–4s 区间内）', () => {
    expect(TITLE_CARD_DURATION_MS).toBe(1500)
    expect(CREDITS_SCROLL_DURATION_MS).toBeGreaterThanOrEqual(3000)
    expect(CREDITS_SCROLL_DURATION_MS).toBeLessThanOrEqual(4000)
  })
})

describe('reduceCinema · 阶段流转', () => {
  it('enter：idle → title；已开着（title）重复 enter 不重放片头', () => {
    expect(reduceCinema(INITIAL_CINEMA_STATE, { type: 'enter' })).toEqual({ phase: 'title' })
    expect(reduceCinema({ phase: 'title' }, { type: 'enter' })).toEqual({ phase: 'title' })
    expect(reduceCinema({ phase: 'playing' }, { type: 'enter' })).toEqual({ phase: 'playing' })
  })

  it('title 自动推进 / 点击跳过都到 playing；跨阶段动作幂等 no-op', () => {
    expect(reduceCinema({ phase: 'title' }, { type: 'titleDone' })).toEqual({ phase: 'playing' })
    expect(reduceCinema({ phase: 'title' }, { type: 'titleSkip' })).toEqual({ phase: 'playing' })
    // 非 title 阶段的 titleDone / titleSkip 不生效
    expect(reduceCinema({ phase: 'playing' }, { type: 'titleDone' })).toEqual({ phase: 'playing' })
    expect(reduceCinema({ phase: 'credits' }, { type: 'titleSkip' })).toEqual({ phase: 'credits' })
  })

  it('replayFinished：只有 playing 播完才进 credits；credits / end 不重放（定格保持）', () => {
    expect(reduceCinema({ phase: 'playing' }, { type: 'replayFinished' })).toEqual({ phase: 'credits' })
    // 正片播完后手动再次触发（例如重播又播完）不重滚 credits
    expect(reduceCinema({ phase: 'credits' }, { type: 'replayFinished' })).toEqual({ phase: 'credits' })
    expect(reduceCinema({ phase: 'end' }, { type: 'replayFinished' })).toEqual({ phase: 'end' })
    expect(reduceCinema({ phase: 'title' }, { type: 'replayFinished' })).toEqual({ phase: 'title' })
  })

  it('creditsDone：credits → end 定格；end 保持 end', () => {
    expect(reduceCinema({ phase: 'credits' }, { type: 'creditsDone' })).toEqual({ phase: 'end' })
    expect(reduceCinema({ phase: 'end' }, { type: 'creditsDone' })).toEqual({ phase: 'end' })
  })

  it('exit：任何阶段回 idle；idle 保持 idle', () => {
    for (const phase of ['title', 'playing', 'credits', 'end'] as const) {
      expect(reduceCinema({ phase }, { type: 'exit' })).toEqual({ phase: 'idle' })
    }
    expect(reduceCinema(INITIAL_CINEMA_STATE, { type: 'exit' })).toEqual({ phase: 'idle' })
  })

  it('完整链路：enter → titleDone → replayFinished → creditsDone → end → exit', () => {
    let state = INITIAL_CINEMA_STATE
    state = reduceCinema(state, { type: 'enter' })
    expect(state.phase).toBe('title')
    state = reduceCinema(state, { type: 'titleDone' })
    expect(state.phase).toBe('playing')
    state = reduceCinema(state, { type: 'replayFinished' })
    expect(state.phase).toBe('credits')
    state = reduceCinema(state, { type: 'creditsDone' })
    expect(state.phase).toBe('end')
    state = reduceCinema(state, { type: 'exit' })
    expect(state.phase).toBe('idle')
  })

  it('跳过链路：enter → titleSkip（非 Esc 按键）→ playing；Esc 退出不进 credits', () => {
    let state = reduceCinema(INITIAL_CINEMA_STATE, { type: 'enter' })
    state = reduceCinema(state, { type: 'titleSkip' })
    expect(state.phase).toBe('playing')
    state = reduceCinema(state, { type: 'exit' })
    expect(state.phase).toBe('idle')
  })
})

describe('cinemaHandlesEscape / titleSkipKey · Esc 与跳过键语义', () => {
  it('Esc 恒交回面板既有逻辑（电影模式任何阶段 Esc = 退出；面板不再吃掉 Esc）', () => {
    for (const phase of ['idle', 'title', 'playing', 'credits', 'end'] as const) {
      expect(cinemaHandlesEscape({ phase })).toBe(false)
    }
  })

  it('titleSkipKey：任意非 Escape 键跳过片头；Escape 放行给退出语义', () => {
    expect(titleSkipKey(' ')).toBe(true)
    expect(titleSkipKey('Enter')).toBe(true)
    expect(titleSkipKey('ArrowRight')).toBe(true)
    expect(titleSkipKey('Escape')).toBe(false)
  })
})

describe('shouldEnterCredits · 触发判定', () => {
  it('仅 playing + finished 触发；title / credits / end / idle 不触发', () => {
    expect(shouldEnterCredits('playing', true)).toBe(true)
    expect(shouldEnterCredits('playing', false)).toBe(false)
    expect(shouldEnterCredits('title', true)).toBe(false)
    expect(shouldEnterCredits('credits', true)).toBe(false)
    expect(shouldEnterCredits('end', true)).toBe(false)
    expect(shouldEnterCredits('idle', true)).toBe(false)
  })
})

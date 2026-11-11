/**
 * 六期 S3 · 电影包装集成测试（RouteReplayPanel × cinemaWrapper）。
 *
 * 覆盖（任务书第 7 条）：片头可跳过 / 不跳过自动开始、片尾仅正常播完触发、
 * Esc 退出无 credits、reduced-motion 三态、箴言随 trip.id 确定。jsdom 用真实计时器
 * （1.5s / 3.5s 在用例内 waitFor 等待，真实定时器），零写入零网络。
 *
 * 既有 RouteReplayPanel.test.tsx 不动；本文件只新增电影包装行为。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import RouteReplayPanel from '../components/RouteReplayPanel'
import { REPLAY_DAYS } from './fixtures/replay'
import { travelQuoteFor } from '../lib/travelEasterEggs'

function panel(): HTMLElement {
  return screen.getByTestId('route-replay-panel')
}

function renderPanel(props: Partial<Parameters<typeof RouteReplayPanel>[0]> = {}) {
  return render(
    <RouteReplayPanel
      days={REPLAY_DAYS}
      initialDay={1}
      onClose={vi.fn()}
      reducedMotion
      {...props}
    />,
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RouteReplayPanel · 片头标题卡', () => {
  it('进入电影模式显示标题卡（目的地 + 日期区间），点击立即跳过 → 正片可见', async () => {
    renderPanel({
      tripTitle: '成都五日慢游',
      destination: '成都',
      days: REPLAY_DAYS.map((day, index) => ({
        ...day,
        date: index === 0 ? '2026-06-19' : index === 1 ? '2026-06-20' : null,
      })),
    })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    expect(panel()).toHaveAttribute('data-cinema', 'true')
    expect(panel()).toHaveAttribute('data-cinema-phase', 'title')

    const card = screen.getByTestId('cinema-title-card')
    expect(card).toHaveTextContent('成都')
    expect(card).toHaveTextContent('2026-06-19 ～ 2026-06-20')

    // 点击跳过：不等待 1.5s
    fireEvent.click(card)
    await waitFor(() => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'))
    expect(screen.queryByTestId('cinema-title-card')).toBeNull()
    expect(screen.queryByTestId('cinema-credits')).toBeNull()
  }, 15000)

  it('不跳过：1.5s 后自动开始正片（真实计时器）', async () => {
    renderPanel({ tripTitle: '杭州三日', destination: '杭州' })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    expect(panel()).toHaveAttribute('data-cinema-phase', 'title')
    await waitFor(
      () => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'),
      { timeout: 4000, interval: 100 },
    )
    expect(screen.queryByTestId('cinema-title-card')).toBeNull()
  }, 15000)

  it('片头阶段任意非 Esc 按键跳过 → 正片；Esc = 退出电影模式（既有语义不变）', async () => {
    const onClose = vi.fn()
    renderPanel({ onClose })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    expect(panel()).toHaveAttribute('data-cinema-phase', 'title')

    // 非 Esc 按键：跳过片头进正片
    fireEvent.keyDown(document, { key: ' ' })
    await waitFor(() => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'))
    expect(panel()).toHaveAttribute('data-cinema', 'true')
    expect(onClose).not.toHaveBeenCalled()
  }, 15000)

  it('片头阶段 Esc = 退出电影模式（沿用既有口径，不进正片）', async () => {
    const onClose = vi.fn()
    renderPanel({ onClose })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    expect(panel()).toHaveAttribute('data-cinema-phase', 'title')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(panel()).toHaveAttribute('data-cinema', 'false')
    expect(panel()).toHaveAttribute('data-cinema-phase', 'idle')
    expect(screen.queryByTestId('cinema-title-card')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  }, 15000)
})

describe('RouteReplayPanel · 片尾 credits', () => {
  it('正片正常播完 → credits 滚动 → 3.5s 后定格尾帧（data-settled=true）', async () => {
    const quote = travelQuoteFor('trip-hangzhou-3d')
    renderPanel({ tripId: 'trip-hangzhou-3d', tripTitle: '杭州三日漫步路书', destination: '杭州' })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    await waitFor(() => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'), {
      timeout: 4000,
      interval: 100,
    })

    // 播放直到 finished（reduced-motion 逐站翻页最快；手动逐站推进等价于播完语义）
    fireEvent.click(screen.getByTestId('replay-play-toggle'))
    await waitFor(
      () => expect(panel()).toHaveAttribute('data-cinema-phase', 'credits'),
      { timeout: 20000, interval: 200 },
    )
    const credits = screen.getByTestId('cinema-credits')
    expect(credits).toHaveTextContent('杭州三日漫步路书')
    expect(credits).toHaveTextContent('路线与时间仅为参考')
    expect(credits).toHaveTextContent(quote)
    // 选择键是 trip.id，不是 title：本样本两者取句不同，credits 必须是 id 的那句。
    expect(travelQuoteFor('trip-hangzhou-3d')).not.toBe(travelQuoteFor('杭州三日漫步路书'))
    expect(credits).not.toHaveTextContent(travelQuoteFor('杭州三日漫步路书'))
    expect(credits).toHaveAttribute('data-settled', 'false')

    // 3.5s 滚动完成 → 定格尾帧（同帧同箴言）
    await waitFor(() => expect(credits).toHaveAttribute('data-settled', 'true'), {
      timeout: 6000,
      interval: 200,
    })
    expect(credits).toHaveTextContent(quote)
  }, 40000)

  it('Esc 退出电影模式不进 credits（playing 阶段 Esc = 退电影模式）', async () => {
    renderPanel({ tripTitle: '杭州三日漫步路书' })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    await waitFor(() => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'), {
      timeout: 4000,
      interval: 100,
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(panel()).toHaveAttribute('data-cinema', 'false')
    expect(panel()).toHaveAttribute('data-cinema-phase', 'idle')
    expect(screen.queryByTestId('cinema-credits')).toBeNull()
  }, 15000)

  it('credits / 定格阶段 Esc = 退电影模式（credits 消失，不给正片续播）', async () => {
    renderPanel({ tripTitle: '杭州三日漫步路书' })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    await waitFor(() => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'), {
      timeout: 4000,
      interval: 100,
    })
    fireEvent.click(screen.getByTestId('replay-play-toggle'))
    await waitFor(
      () => expect(panel()).toHaveAttribute('data-cinema-phase', 'credits'),
      { timeout: 20000, interval: 200 },
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(panel()).toHaveAttribute('data-cinema', 'false')
    expect(panel()).toHaveAttribute('data-cinema-phase', 'idle')
    expect(screen.queryByTestId('cinema-credits')).toBeNull()
  }, 40000)

  it('同 trip.id 同箴言：换 title 不换句（确定性穿透面板）', async () => {
    const first = renderPanel({ tripId: 'trip-chengdu-5d', tripTitle: '成都五日慢游', destination: '成都' })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    await waitFor(() => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'), {
      timeout: 4000,
      interval: 100,
    })
    fireEvent.click(screen.getByTestId('replay-play-toggle'))
    await waitFor(
      () => expect(panel()).toHaveAttribute('data-cinema-phase', 'credits'),
      { timeout: 20000, interval: 200 },
    )
    const quoteA =
      screen.getByTestId('cinema-credits').querySelector('.oc-cinema-credits-quote')?.textContent ??
      ''
    expect(quoteA).toBe(travelQuoteFor('trip-chengdu-5d'))
    first.unmount()
    cleanup()

    // 同一 id、改 title：箴言仍同句（选择键不是 title）。
    const second = renderPanel({ tripId: 'trip-chengdu-5d', tripTitle: '成都五日慢游·改', destination: '成都' })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    await waitFor(() => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'), {
      timeout: 4000,
      interval: 100,
    })
    fireEvent.click(screen.getByTestId('replay-play-toggle'))
    await waitFor(
      () => expect(panel()).toHaveAttribute('data-cinema-phase', 'credits'),
      { timeout: 20000, interval: 200 },
    )
    const quoteB =
      screen.getByTestId('cinema-credits').querySelector('.oc-cinema-credits-quote')?.textContent ??
      ''
    expect(quoteB).toBe(travelQuoteFor('trip-chengdu-5d'))
    expect(quoteA).toBe(quoteB)
    second.unmount()
  }, 60000)
})

describe('RouteReplayPanel · reduced-motion 三态', () => {
  it('片头 data-reduced=true（直显直隐在 CSS）；回放逐站翻页提示仍在', () => {
    renderPanel({ reducedMotion: true })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    expect(screen.getByTestId('cinema-title-card')).toHaveAttribute('data-reduced', 'true')
    expect(screen.getByTestId('replay-reduced-note')).toBeInTheDocument()
  })

  it('credits data-reduced=true（静态整页在 CSS）+ data-settled 演进不受影响', async () => {
    renderPanel({ reducedMotion: true, tripTitle: '杭州三日漫步路书' })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    await waitFor(() => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'), {
      timeout: 4000,
      interval: 100,
    })
    fireEvent.click(screen.getByTestId('replay-play-toggle'))
    await waitFor(
      () => expect(panel()).toHaveAttribute('data-cinema-phase', 'credits'),
      { timeout: 20000, interval: 200 },
    )
    const credits = screen.getByTestId('cinema-credits')
    expect(credits).toHaveAttribute('data-reduced', 'true')
    await waitFor(() => expect(credits).toHaveAttribute('data-settled', 'true'), {
      timeout: 6000,
      interval: 200,
    })
  }, 40000)
})

describe('RouteReplayPanel · 电影包装零数据影响', () => {
  it('片头跳过 / 播完进 credits / 定格全程：localStorage 全键与写入次数不变', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const before = Object.keys(localStorage).length
    renderPanel({ tripTitle: '杭州三日漫步路书', destination: '成都' })
    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    fireEvent.click(screen.getByTestId('cinema-title-card'))
    await waitFor(() => expect(panel()).toHaveAttribute('data-cinema-phase', 'playing'), {
      timeout: 4000,
      interval: 100,
    })
    fireEvent.click(screen.getByTestId('replay-play-toggle'))
    await waitFor(
      () => expect(panel()).toHaveAttribute('data-cinema-phase', 'credits'),
      { timeout: 20000, interval: 200 },
    )
    await waitFor(
      () => expect(screen.getByTestId('cinema-credits')).toHaveAttribute('data-settled', 'true'),
      { timeout: 6000, interval: 200 },
    )
    expect(Object.keys(localStorage)).toHaveLength(before)
    expect(setItem).not.toHaveBeenCalled()
  }, 40000)
})

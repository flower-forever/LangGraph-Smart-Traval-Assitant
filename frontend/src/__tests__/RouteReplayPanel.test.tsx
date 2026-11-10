/**
 * S7 · 路线回放面板组件测试（jsdom + 真实 Leaflet）。
 *
 * 覆盖：五站按序查看 / 上一站 / 下一站 / 拖动 / 倍速 / 换天 / 电影模式与 Esc、
 * 三种缺失降级（无坐标、straight_line、unavailable）不画假路线、reduced-motion
 * 逐站翻页提示、零写入零网络。播放时钟本身由 routeReplay.test.ts 的状态机覆盖。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import RouteReplayPanel from '../components/RouteReplayPanel'
import { REPLAY_DAYS } from './fixtures/replay'

function panel(): HTMLElement {
  return screen.getByTestId('route-replay-panel')
}

function drawnPaths(): SVGPathElement[] {
  return Array.from(document.querySelectorAll<SVGPathElement>('.leaflet-overlay-pane path[data-drawn="true"]'))
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

describe('RouteReplayPanel · 基本回放', () => {
  it('打开在第 1 天第 1 站，展示时间 / 停留 / 下一段摘要', () => {
    renderPanel()
    expect(panel()).toHaveAttribute('data-station-count', '5')
    expect(panel()).toHaveAttribute('data-station-index', '0')
    expect(screen.getByTestId('replay-current-name')).toHaveTextContent('断桥残雪')
    expect(screen.getByTestId('replay-current-time')).toHaveTextContent('09:00')
    expect(screen.getByTestId('replay-current-stay')).toHaveTextContent('停留 约 40 分钟')
    expect(screen.getByTestId('replay-current-position')).toHaveTextContent('位置已定位')
    expect(screen.getByTestId('replay-current-route')).toHaveTextContent('起点站')
    expect(screen.getByTestId('replay-next-leg')).toHaveTextContent('步行')
    expect(screen.getByTestId('replay-next-leg')).toHaveTextContent('地图服务路线')
    expect(document.querySelectorAll('.stop-dot-wrapper')).toHaveLength(5)
  })

  it('下一站 / 上一站 / 拖动都更新当前站，路线按已走路段绘制', () => {
    renderPanel()
    expect(drawnPaths()).toHaveLength(0)

    fireEvent.click(screen.getByTestId('replay-next'))
    expect(panel()).toHaveAttribute('data-station-index', '1')
    expect(screen.getByTestId('replay-current-name')).toHaveTextContent('平湖秋月')
    expect(screen.getByTestId('replay-current-route')).toHaveTextContent('地图服务路线')
    expect(drawnPaths()).toHaveLength(1)

    fireEvent.click(screen.getByTestId('replay-next'))
    expect(screen.getByTestId('replay-current-name')).toHaveTextContent('湖滨晴雨')
    expect(screen.getByTestId('replay-current-route')).toHaveTextContent('示意直线')
    // straight_line 用虚线，地图上不会画成导航实线
    expect(document.querySelectorAll('.leaflet-overlay-pane path[stroke-dasharray]').length).toBeGreaterThanOrEqual(1)
    expect(drawnPaths()).toHaveLength(2)

    fireEvent.click(screen.getByTestId('replay-prev'))
    expect(screen.getByTestId('replay-current-name')).toHaveTextContent('平湖秋月')

    fireEvent.change(screen.getByTestId('replay-progress'), { target: { value: '4' } })
    expect(panel()).toHaveAttribute('data-station-index', '4')
    expect(screen.getByTestId('replay-current-name')).toHaveTextContent('龙井村')
    expect(screen.getByTestId('replay-current-time')).toHaveTextContent('16:30')
    expect(screen.getByTestId('replay-current-stay')).toHaveTextContent('停留 约 1 小时 30 分钟')
  })

  it('unavailable 路段不画线，卡片明确「路线未知」', () => {
    renderPanel()
    fireEvent.change(screen.getByTestId('replay-progress'), { target: { value: '3' } })
    expect(screen.getByTestId('replay-current-name')).toHaveTextContent('灵隐寺')
    expect(screen.getByTestId('replay-current-route')).toHaveTextContent('路线未知')
    expect(panel()).toHaveAttribute('data-route-kind', 'unavailable')
    // 已画：nav（1→2）+ straight（2→3）；unavailable（3→4）没有线，4→5 还未到
    expect(drawnPaths()).toHaveLength(2)
  })

  it('navigation 无 geometry 降级为示意直线并说明', () => {
    renderPanel()
    fireEvent.change(screen.getByTestId('replay-progress'), { target: { value: '4' } })
    expect(screen.getByTestId('replay-current-route')).toHaveTextContent('按示意直线显示')
    expect(panel()).toHaveAttribute('data-route-kind', 'straight_line')
  })

  it('播放 / 暂停按钮切换 data-playing，倍速按钮切换 data-speed', () => {
    renderPanel()
    const playButton = screen.getByTestId('replay-play-toggle')
    expect(panel()).toHaveAttribute('data-playing', 'false')
    fireEvent.click(playButton)
    expect(panel()).toHaveAttribute('data-playing', 'true')
    expect(playButton).toHaveTextContent('暂停')
    fireEvent.click(playButton)
    expect(panel()).toHaveAttribute('data-playing', 'false')

    fireEvent.click(screen.getByTestId('replay-speed-2'))
    expect(panel()).toHaveAttribute('data-speed', '2')
    expect(screen.getByTestId('replay-speed-2')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByTestId('replay-speed-1.5'))
    expect(panel()).toHaveAttribute('data-speed', '1.5')
  })
})

describe('RouteReplayPanel · 缺失与换天', () => {
  it('无坐标站：位置未知、不显示 marker、不移动地图', () => {
    renderPanel()
    fireEvent.change(screen.getByTestId('replay-day-select'), { target: { value: '1' } })
    expect(panel()).toHaveAttribute('data-station-count', '2')
    expect(document.querySelectorAll('.stop-dot-wrapper')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('replay-next'))
    expect(screen.getByTestId('replay-current-name')).toHaveTextContent('没有坐标的站')
    expect(screen.getByTestId('replay-current-position')).toHaveTextContent('位置未知')
    expect(screen.getByTestId('replay-current-route')).toHaveTextContent('位置未知，无法绘制路线')
    expect(document.querySelectorAll('.stop-dot-wrapper')).toHaveLength(1)
    expect(drawnPaths()).toHaveLength(0)
  })

  it('换到空日：显示空态，播放禁用，phase 为 finished', () => {
    renderPanel()
    fireEvent.change(screen.getByTestId('replay-day-select'), { target: { value: '2' } })
    expect(panel()).toHaveAttribute('data-station-count', '0')
    expect(panel()).toHaveAttribute('data-phase', 'finished')
    expect(screen.getByTestId('replay-empty')).toHaveTextContent('这一天没有可回放的站点')
    expect(screen.getByTestId('replay-play-toggle')).toBeDisabled()
    expect(screen.getByTestId('replay-progress')).toBeDisabled()

    // 从空日切回有站点的日子：必须回到第一站，而不是停在 finished
    fireEvent.change(screen.getByTestId('replay-day-select'), { target: { value: '0' } })
    expect(panel()).toHaveAttribute('data-phase', 'station')
    expect(panel()).toHaveAttribute('data-station-index', '0')
    expect(screen.getByTestId('replay-current-name')).toHaveTextContent('断桥残雪')
  })

  it('reduced-motion 提示可见，且换天重置回第一站', () => {
    renderPanel()
    expect(screen.getByTestId('replay-reduced-note')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('replay-progress'), { target: { value: '3' } })
    expect(panel()).toHaveAttribute('data-station-index', '3')
    fireEvent.change(screen.getByTestId('replay-day-select'), { target: { value: '0' } })
    expect(panel()).toHaveAttribute('data-station-index', '0')
    expect(screen.getByTestId('replay-current-name')).toHaveTextContent('断桥残雪')
  })
})

describe('RouteReplayPanel · 电影模式与边界', () => {
  it('电影模式隐藏页头与侧栏，Esc 先退电影模式，再 Esc 关闭面板', () => {
    const onClose = vi.fn()
    renderPanel({ onClose })
    expect(screen.getByTestId('replay-close')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('replay-cinema-toggle'))
    expect(panel()).toHaveAttribute('data-cinema', 'true')
    expect(screen.queryByTestId('replay-close')).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(panel()).toHaveAttribute('data-cinema', 'false')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('零写入零网络：查看 / 换天 / 拖动不碰 localStorage / fetch', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const before = Object.keys(localStorage).length

    renderPanel()
    fireEvent.click(screen.getByTestId('replay-next'))
    fireEvent.change(screen.getByTestId('replay-progress'), { target: { value: '4' } })
    fireEvent.change(screen.getByTestId('replay-day-select'), { target: { value: '1' } })

    expect(Object.keys(localStorage)).toHaveLength(before)
    expect(setItem).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

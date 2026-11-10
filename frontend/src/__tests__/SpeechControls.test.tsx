/**
 * S7 · 语音讲解组件接线测试。
 *
 * 不真实发声：在 window 上装一个假 speechSynthesis + SpeechSynthesisUtterance，
 * 断言 speak / pause / resume / cancel 的调用与按钮状态；同时验证：
 * - 无 speechSynthesis → 按钮禁用并说明；
 * - 有 voice 但没有中文 → 明确降级，不硬读；
 * - 切换站点（卸载）会停止；
 * - 连续播放本日按站点顺序推进；
 * - 零写入。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import StopPoiCard from '../components/StopPoiCard'
import TodayPanel from '../components/TodayPanel'
import type { TripStop } from '../lib/api'
import type { NarrationUtterance, SpeechVoice } from '../lib/speech'
import { REPLAY_DAY } from './fixtures/replay'

const ZH_VOICE: SpeechVoice = { name: 'Microsoft Xiaoxiao', lang: 'zh-CN', localService: true }
const EN_VOICE: SpeechVoice = { name: 'Microsoft David', lang: 'en-US', localService: true }

const STOP: TripStop = {
  id: 's1',
  name: '断桥残雪',
  time: '09:00',
  duration_minutes: 40,
  description: '白堤东端，冬日雪后桥面半融半积。',
  address: '杭州市西湖区白堤东端',
  location: { lng: 120.1576, lat: 30.2726 },
}

const OTHER_STOP: TripStop = {
  ...STOP,
  id: 's2',
  name: '平湖秋月',
  time: '10:00',
}

class FakeUtterance {
  text: string
  lang = ''
  rate = 1
  voice: unknown = null
  onend: (() => void) | null = null
  onerror: ((event?: unknown) => void) | null = null

  constructor(text: string) {
    this.text = text
  }
}

function installSpeech(voices: SpeechVoice[]) {
  const utterances: NarrationUtterance[] = []
  const synth = {
    getVoices: () => voices as unknown as SpeechSynthesisVoice[],
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
      utterances.push(utterance as unknown as NarrationUtterance)
    }),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth })
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: FakeUtterance })
  return { synth, utterances }
}

function uninstallSpeech() {
  delete (window as unknown as Record<string, unknown>).speechSynthesis
  delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance
}

afterEach(() => {
  cleanup()
  uninstallSpeech()
  vi.restoreAllMocks()
})

describe('StopPoiCard · 语音讲解入口', () => {
  it('没有 speechSynthesis：按钮禁用并说明', () => {
    render(<StopPoiCard stop={STOP} poiCards={null} />)
    const button = screen.getByTestId('stop-listen-s1')
    expect(button).toBeDisabled()
    expect(screen.getByTestId('stop-speech-status-s1')).toHaveTextContent('当前浏览器不支持语音朗读')
  })

  it('有 voice 但没有中文：明确降级，不硬读', () => {
    installSpeech([EN_VOICE])
    render(<StopPoiCard stop={STOP} poiCards={null} />)
    expect(screen.getByTestId('stop-listen-s1')).toBeDisabled()
    expect(screen.getByTestId('stop-speech-status-s1')).toHaveTextContent('当前设备没有中文语音')
  })

  it('中文 voice：点击朗读，再点暂停 / 继续，停止会 cancel', () => {
    const { synth, utterances } = installSpeech([ZH_VOICE])
    render(<StopPoiCard stop={STOP} poiCards={null} />)

    fireEvent.click(screen.getByTestId('stop-listen-s1'))
    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(utterances[0].text).toContain('断桥残雪')
    expect(utterances[0].text).toContain('时间 09:00')
    expect(utterances[0].text).toContain('地址 杭州市西湖区白堤东端')
    expect(screen.getByTestId('stop-listen-s1')).toHaveTextContent('暂停讲解')
    expect(screen.getByTestId('stop-speech-status-s1')).toHaveTextContent('正在朗读')

    fireEvent.click(screen.getByTestId('stop-listen-s1'))
    expect(synth.pause).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('stop-listen-s1')).toHaveTextContent('继续讲解')

    fireEvent.click(screen.getByTestId('stop-listen-s1'))
    expect(synth.resume).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('stop-listen-s1')).toHaveTextContent('暂停讲解')

    fireEvent.click(screen.getByTestId('stop-speech-stop-s1'))
    expect(synth.cancel).toHaveBeenCalled()
    expect(screen.getByTestId('stop-listen-s1')).toHaveTextContent('听讲解')
  })

  it('语速选择会应用到下一次朗读', () => {
    const { utterances } = installSpeech([ZH_VOICE])
    render(<StopPoiCard stop={STOP} poiCards={null} />)
    fireEvent.change(screen.getByTestId('stop-speech-rate-s1'), { target: { value: '1.5' } })
    fireEvent.click(screen.getByTestId('stop-listen-s1'))
    expect(utterances[0].rate).toBe(1.5)
  })

  it('切换站点（卸载旧卡）会停止朗读', () => {
    const { synth } = installSpeech([ZH_VOICE])
    const view = render(<StopPoiCard stop={STOP} poiCards={null} />)
    fireEvent.click(screen.getByTestId('stop-listen-s1'))
    expect(synth.speak).toHaveBeenCalledTimes(1)

    view.rerender(<StopPoiCard stop={OTHER_STOP} poiCards={null} />)
    expect(synth.cancel).toHaveBeenCalled()
  })

  it('零写入：朗读 / 暂停 / 停止不碰 localStorage', () => {
    installSpeech([ZH_VOICE])
    const before = Object.keys(localStorage).length
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    render(<StopPoiCard stop={STOP} poiCards={null} />)
    fireEvent.click(screen.getByTestId('stop-listen-s1'))
    fireEvent.click(screen.getByTestId('stop-listen-s1'))
    fireEvent.click(screen.getByTestId('stop-speech-stop-s1'))
    expect(Object.keys(localStorage)).toHaveLength(before)
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('TodayPanel · 连续播放本日', () => {
  const NOW = new Date(2026, 3, 3, 8, 0, 0).getTime()

  function renderToday(overrides: Partial<Parameters<typeof TodayPanel>[0]> = {}) {
    return render(
      <TodayPanel
        days={[REPLAY_DAY]}
        poiCardsRecord={null}
        poiCardsLoaded={false}
        checklist={[]}
        constraints={[]}
        activeStopId={null}
        onSelectStop={vi.fn()}
        now={() => NOW}
        {...overrides}
      />,
    )
  }

  it('按站点顺序连续朗读，暂停 / 继续 / 停止可用', () => {
    const { synth, utterances } = installSpeech([ZH_VOICE])
    renderToday()

    fireEvent.click(screen.getByTestId('today-listen-day'))
    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(utterances[0].text).toContain('第 1 站')
    expect(utterances[0].text).toContain('断桥残雪')
    expect(screen.getByTestId('today-listen-day')).toHaveTextContent('暂停本日讲解')
    expect(screen.getByTestId('today-speech-status')).toHaveTextContent('正在朗读第 1 站 / 共 5 站')

    act(() => {
      utterances[0].onend?.()
    })
    expect(synth.speak).toHaveBeenCalledTimes(2)
    expect(utterances[1].text).toContain('第 2 站')
    expect(utterances[1].text).toContain('平湖秋月')
    expect(screen.getByTestId('today-speech-status')).toHaveTextContent('正在朗读第 2 站 / 共 5 站')

    fireEvent.click(screen.getByTestId('today-listen-day'))
    expect(synth.pause).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('today-listen-day')).toHaveTextContent('继续本日讲解')

    fireEvent.click(screen.getByTestId('today-listen-day'))
    expect(synth.resume).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('today-speech-stop'))
    expect(synth.cancel).toHaveBeenCalled()
    expect(screen.getByTestId('today-listen-day')).toHaveTextContent('连续播放本日讲解')
  })

  it('没有 speechSynthesis：本日播放按钮禁用并说明', () => {
    renderToday()
    expect(screen.getByTestId('today-listen-day')).toBeDisabled()
    expect(screen.getByTestId('today-speech-status')).toHaveTextContent('当前浏览器不支持语音朗读')
  })

  it('没有中文 voice：本日播放按钮禁用并说明', () => {
    installSpeech([EN_VOICE])
    renderToday()
    expect(screen.getByTestId('today-listen-day')).toBeDisabled()
    expect(screen.getByTestId('today-speech-status')).toHaveTextContent('当前设备没有中文语音')
  })
})

/**
 * S7 · 语音讲解纯逻辑测试（计划 §8.1）。
 *
 * 覆盖：文案（名称/时间/简介/地址、去 Markdown/URL、无简介「暂无讲解」）、
 * 中文 voice 选择与降级、播放/暂停/继续/停止/连续队列、语速夹取、
 * 浏览器不支持 / 无中文 voice、同一时刻只允许一路发声、零写入零网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TripStop } from '../lib/api'
import {
  DEFAULT_SPEECH_RATE,
  IDLE_NARRATION_STATE,
  SPEECH_MAX_RATE,
  SPEECH_MIN_RATE,
  buildStopNarration,
  chineseVoiceStatus,
  clampSpeechRate,
  isChineseVoice,
  pickChineseVoice,
  stripMarkdownForSpeech,
  type NarrationUtterance,
  type SpeechEngine,
  type SpeechVoice,
} from '../lib/speech'
import { createNarrationPlayer } from '../lib/speechCore'

const STOP: TripStop = {
  id: 's1',
  name: '断桥残雪',
  time: '09:00:00',
  duration_minutes: 40,
  description: '白堤东端，冬日雪后桥面半融半积。',
  address: '杭州市西湖区白堤东端',
  location: { lng: 120.1576, lat: 30.2726 },
}

function fakeEngine(voices: SpeechVoice[]) {
  const utterances: NarrationUtterance[] = []
  const engine: SpeechEngine = {
    getVoices: () => voices,
    speak: (utterance) => {
      utterances.push(utterance)
    },
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    create: (text) => ({
      text,
      lang: '',
      rate: 1,
      voice: null,
      onend: null,
      onerror: null,
    }),
  }
  return { engine, utterances }
}

class FakeNativeVoice {
  constructor(
    readonly name: string,
    readonly lang: string,
    readonly localService = true,
    readonly isDefault = false,
  ) {}
}

/**
 * 模拟浏览器 WebIDL：utterance.voice 的 setter 只接受原生 voice 实例。
 * 普通结构化对象（toVoice 的旧实现）会在这里抛 TypeError，和真机一致。
 */
function webIdlEngine(voices: FakeNativeVoice[], exposeNative = true) {
  const utterances: NarrationUtterance[] = []
  const engine: SpeechEngine = {
    getVoices: () =>
      voices.map((voice) => ({
        name: voice.name,
        lang: voice.lang,
        localService: voice.localService,
        default: voice.isDefault,
        ...(exposeNative ? { native: voice as unknown as SpeechSynthesisVoice } : {}),
      })),
    speak: (utterance) => {
      utterances.push(utterance)
    },
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    create: (text) => {
      const utterance = {
        text,
        lang: '',
        rate: 1,
        voice: null,
        onend: null,
        onerror: null,
      } as NarrationUtterance
      let stored: unknown = null
      Object.defineProperty(utterance, 'voice', {
        configurable: true,
        get: () => stored,
        set: (value: unknown) => {
          if (value !== null && !(value instanceof FakeNativeVoice)) {
            throw new TypeError("Failed to convert value to 'SpeechSynthesisVoice'.")
          }
          stored = value
        },
      })
      return utterance
    },
  }
  return { engine, utterances }
}

const ZH_VOICE: SpeechVoice = { name: 'Microsoft Xiaoxiao', lang: 'zh-CN', localService: true }
const ZH_TW: SpeechVoice = { name: 'Microsoft Yating', lang: 'zh-TW', localService: true }
const EN_VOICE: SpeechVoice = { name: 'Microsoft David', lang: 'en-US', localService: true }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('stripMarkdownForSpeech', () => {
  it('去掉 Markdown 链接、裸 URL、强调符与行首标记', () => {
    const text = stripMarkdownForSpeech(
      '## 西湖\n**断桥**：[官网](https://example.com/a) 和 https://example.org/b ，`白堤`东端。',
    )
    expect(text).toContain('西湖')
    expect(text).toContain('断桥')
    expect(text).toContain('官网')
    expect(text).toContain('白堤东端')
    expect(text).not.toContain('http')
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
    expect(text).not.toContain('##')
  })

  it('图片保留 alt 文本，不朗读图片地址', () => {
    const text = stripMarkdownForSpeech('![断桥雪景](https://img.example.com/a.png) 冬日景色')
    expect(text).toContain('断桥雪景')
    expect(text).not.toContain('img.example.com')
  })
})

describe('buildStopNarration', () => {
  it('名称 + 时间 + 简介 + 地址，连续播放带站序', () => {
    const text = buildStopNarration(STOP, { index: 0 })
    expect(text).toContain('第 1 站')
    expect(text).toContain('断桥残雪')
    expect(text).toContain('时间 09:00')
    expect(text).toContain('白堤东端，冬日雪后桥面半融半积')
    expect(text).toContain('地址 杭州市西湖区白堤东端')
    expect(text.endsWith('。')).toBe(true)
  })

  it('无简介显示「暂无讲解」，无时间显示「时间未知」', () => {
    const text = buildStopNarration({ ...STOP, description: '', time: '' })
    expect(text).toContain('暂无讲解')
    expect(text).toContain('时间未知')
  })

  it('不朗读门票 / 营业时间等未核实字段', () => {
    const text = buildStopNarration(STOP)
    expect(text).not.toContain('门票')
    expect(text).not.toContain('开放时间')
    expect(text).not.toContain('价格')
  })

  it('讲解末尾标点不会和连接逗号叠成「。，」', () => {
    const text = buildStopNarration({ ...STOP, description: '很好看。', address: '某路。' })
    expect(text).not.toContain('。，')
  })
})

describe('中文 voice 选择', () => {
  it('识别 zh / cmn，忽略 en', () => {
    expect(isChineseVoice(ZH_VOICE)).toBe(true)
    expect(isChineseVoice({ name: 'cmn', lang: 'cmn-Hans-CN' })).toBe(true)
    expect(isChineseVoice(EN_VOICE)).toBe(false)
  })

  it('优先大陆简体，再繁体，再本地合成', () => {
    expect(pickChineseVoice([EN_VOICE, ZH_TW, ZH_VOICE])?.lang).toBe('zh-CN')
    expect(pickChineseVoice([EN_VOICE, ZH_TW])?.lang).toBe('zh-TW')
    expect(pickChineseVoice([EN_VOICE])).toBeNull()
  })

  it('voices 未加载是 unknown，加载后没有中文才是 missing', () => {
    expect(chineseVoiceStatus([])).toBe('unknown')
    expect(chineseVoiceStatus([EN_VOICE])).toBe('missing')
    expect(chineseVoiceStatus([EN_VOICE, ZH_VOICE])).toBe('ready')
  })
})

describe('语速夹取', () => {
  it('限制在 0.8–1.5，非法值回落默认', () => {
    expect(clampSpeechRate(0.1)).toBe(SPEECH_MIN_RATE)
    expect(clampSpeechRate(9)).toBe(SPEECH_MAX_RATE)
    expect(clampSpeechRate(1.24)).toBe(1.2)
    expect(clampSpeechRate(Number.NaN)).toBe(DEFAULT_SPEECH_RATE)
  })
})

describe('播放器 · 单站与连续队列', () => {
  it('单站：play 后朗读，end 后回到 idle', () => {
    const { engine, utterances } = fakeEngine([ZH_VOICE])
    const player = createNarrationPlayer({ engine, rate: 1.2 })
    const result = player.play([{ id: 's1', text: buildStopNarration(STOP) }])
    expect(result.ok).toBe(true)
    expect(utterances).toHaveLength(1)
    expect(utterances[0].text).toContain('断桥残雪')
    expect(utterances[0].lang).toBe('zh-CN')
    expect(utterances[0].rate).toBe(1.2)
    expect(utterances[0].voice?.lang).toBe('zh-CN')
    expect(player.getState()).toMatchObject({ status: 'speaking', currentId: 's1', index: 0, total: 1 })

    utterances[0].onend?.()
    expect(player.getState()).toEqual(IDLE_NARRATION_STATE)
  })

  it('真实引擎保留原生 voice 实例：WebIDL setter 接受并正常调用 speak', () => {
    const native = new FakeNativeVoice('Microsoft Huihui', 'zh-CN')
    const { engine, utterances } = webIdlEngine([native])
    const player = createNarrationPlayer({ engine })

    const result = player.play([{ id: 's1', text: '第一站' }])

    expect(result).toEqual({ ok: true })
    expect(utterances).toHaveLength(1)
    expect(utterances[0].voice).toBe(native)
    expect(player.getState()).toMatchObject({ status: 'speaking', currentId: 's1' })
  })

  it('voice 赋值抛 WebIDL TypeError：收口 speech_error，不调用 speak、不假报 speaking', () => {
    // 故意不暴露 native：模拟旧 toVoice 把原生实例降级成普通对象。
    const native = new FakeNativeVoice('Microsoft Huihui', 'zh-CN')
    const { engine, utterances } = webIdlEngine([native], false)
    const player = createNarrationPlayer({ engine })

    const result = player.play([{ id: 's1', text: '第一站' }])

    expect(result).toEqual({ ok: false, reason: 'speech_error' })
    expect(utterances).toHaveLength(0)
    expect(player.getState()).toMatchObject({ status: 'idle', currentId: null, failure: 'speech_error' })
  })

  it('连续队列：上一项 end 后自动读下一项，全部结束回 idle', () => {
    const { engine, utterances } = fakeEngine([ZH_VOICE])
    const player = createNarrationPlayer({ engine })
    player.play([
      { id: 's1', text: '第一站' },
      { id: 's2', text: '第二站' },
      { id: 's3', text: '第三站' },
    ])
    expect(utterances).toHaveLength(1)
    expect(player.getState().currentId).toBe('s1')

    utterances[0].onend?.()
    expect(utterances).toHaveLength(2)
    expect(utterances[1].text).toBe('第二站')
    expect(player.getState().currentId).toBe('s2')

    utterances[1].onend?.()
    expect(utterances).toHaveLength(3)
    expect(player.getState().currentId).toBe('s3')

    utterances[2].onend?.()
    expect(player.getState()).toEqual(IDLE_NARRATION_STATE)
  })

  it('暂停 / 继续调用引擎并更新状态', () => {
    const { engine } = fakeEngine([ZH_VOICE])
    const player = createNarrationPlayer({ engine })
    player.play([{ id: 's1', text: '第一站' }])

    player.pause()
    expect(engine.pause).toHaveBeenCalledTimes(1)
    expect(player.getState().status).toBe('paused')

    player.resume()
    expect(engine.resume).toHaveBeenCalledTimes(1)
    expect(player.getState().status).toBe('speaking')
  })

  it('停止会 cancel，并忽略迟到的 onend', () => {
    const { engine, utterances } = fakeEngine([ZH_VOICE])
    const player = createNarrationPlayer({ engine })
    player.play([
      { id: 's1', text: '第一站' },
      { id: 's2', text: '第二站' },
    ])
    const first = utterances[0]
    player.stop()
    expect(engine.cancel).toHaveBeenCalled()
    expect(player.getState()).toEqual(IDLE_NARRATION_STATE)

    first.onend?.()
    expect(utterances).toHaveLength(1)
    expect(player.getState()).toEqual(IDLE_NARRATION_STATE)
  })

  it('无中文 voice：拒绝播放且不调用 speak，返回明确原因', () => {
    const { engine, utterances } = fakeEngine([EN_VOICE])
    const player = createNarrationPlayer({ engine })
    const result = player.play([{ id: 's1', text: '第一站' }])
    expect(result).toEqual({ ok: false, reason: 'no_chinese_voice' })
    expect(utterances).toHaveLength(0)
    expect(player.availability()).toBe('no_chinese_voice')
    expect(player.getState().failure).toBe('no_chinese_voice')
  })

  it('voices 尚未加载：允许尝试，由浏览器按 lang 选 voice', () => {
    const { engine, utterances } = fakeEngine([])
    const player = createNarrationPlayer({ engine })
    const result = player.play([{ id: 's1', text: '第一站' }])
    expect(result.ok).toBe(true)
    expect(utterances[0].voice).toBeNull()
    expect(utterances[0].lang).toBe('zh-CN')
    expect(player.availability()).toBe('unknown')
  })

  it('浏览器不支持：play 返回 unsupported', () => {
    const player = createNarrationPlayer({ engine: null })
    expect(player.play([{ id: 's1', text: '第一站' }])).toEqual({ ok: false, reason: 'unsupported' })
    expect(player.availability()).toBe('unsupported')
  })

  it('空队列返回 empty', () => {
    const { engine } = fakeEngine([ZH_VOICE])
    const player = createNarrationPlayer({ engine })
    expect(player.play([])).toEqual({ ok: false, reason: 'empty' })
  })

  it('换语速：正在读时重读当前项，不跳站', () => {
    const { engine, utterances } = fakeEngine([ZH_VOICE])
    const player = createNarrationPlayer({ engine })
    player.play([
      { id: 's1', text: '第一站' },
      { id: 's2', text: '第二站' },
    ])
    player.setRate(9)
    expect(engine.cancel).toHaveBeenCalled()
    expect(utterances).toHaveLength(2)
    expect(utterances[1].text).toBe('第一站')
    expect(utterances[1].rate).toBe(SPEECH_MAX_RATE)
    expect(player.getState().currentId).toBe('s1')
  })

  it('同一时刻只允许一路发声：B 播放会停掉 A', () => {
    const a = fakeEngine([ZH_VOICE])
    const b = fakeEngine([ZH_VOICE])
    const playerA = createNarrationPlayer({ engine: a.engine })
    const playerB = createNarrationPlayer({ engine: b.engine })

    playerA.play([{ id: 'a1', text: 'A 站' }])
    expect(playerA.getState().status).toBe('speaking')

    playerB.play([{ id: 'b1', text: 'B 站' }])
    expect(a.engine.cancel).toHaveBeenCalled()
    expect(playerA.getState().status).toBe('idle')
    expect(playerB.getState().status).toBe('speaking')
  })

  it('零写入零网络：播放全过程不碰 localStorage / fetch', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { engine, utterances } = fakeEngine([ZH_VOICE])
    const player = createNarrationPlayer({ engine })
    player.play([{ id: 's1', text: '第一站' }])
    utterances[0].onend?.()
    player.stop()

    expect(setItem).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

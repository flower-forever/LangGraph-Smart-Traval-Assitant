/**
 * S7 · 语音讲解（计划 §8.1）。
 *
 * 边界（全部是硬约束）：
 * - **零写入 / 零上传**：本模块只调用浏览器 `speechSynthesis`，不碰 localStorage /
 *   sessionStorage / 草稿 / 行程，也不发任何网络请求；朗读文本只留在本页内存。
 * - **显式点击才发声**：没有任何自动播放入口；调用方必须由用户操作触发 play()。
 * - **不朗读未核实事实**：文案只取站点名称、时间、讲解、地址；资料卡里的门票、
 *   营业时间等「未核实 / 未知」字段一律不进入朗读文本。
 * - **诚实降级**：设备没有中文 voice 时返回明确原因，不静默改用英文 voice 硬读；
 *   浏览器没有 speechSynthesis 时由组件禁用按钮并说明。
 * - 引擎可注入（测试用假对象），生产默认取 `window.speechSynthesis`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { TripStop } from './api'
import { displayTime } from './format'

export const SPEECH_MIN_RATE = 0.8
export const SPEECH_MAX_RATE = 1.5
export const SPEECH_RATE_OPTIONS = [0.8, 1, 1.2, 1.5] as const
export type SpeechRateOption = (typeof SPEECH_RATE_OPTIONS)[number]
export const DEFAULT_SPEECH_RATE = 1

export const SPEECH_UNSUPPORTED_TEXT = '当前浏览器不支持语音朗读，可查看文字讲解。'
export const SPEECH_NO_VOICE_TEXT = '当前设备没有中文语音，可查看文字讲解。'
export const SPEECH_ERROR_TEXT = '语音播放中断，可重试。'

/* ───────────────────────── 引擎抽象（可注入） ───────────────────────── */

export interface SpeechVoice {
  name: string
  lang: string
  localService?: boolean
  default?: boolean
  /**
   * 浏览器原生 SpeechSynthesisVoice。
   * WebIDL 的 `utterance.voice` setter 只接受原生实例，不能赋结构化副本；
   * 注入的测试 voice 没有原生实例时可省略。
   */
  native?: SpeechSynthesisVoice
}

/** 只描述本模块用到的字段，真实 SpeechSynthesisUtterance 可结构兼容。 */
export interface NarrationUtterance {
  text: string
  lang: string
  rate: number
  voice: SpeechVoice | null
  onend: (() => void) | null
  onerror: ((event?: unknown) => void) | null
}

export interface SpeechEngine {
  getVoices(): SpeechVoice[]
  speak(utterance: NarrationUtterance): void
  cancel(): void
  pause(): void
  resume(): void
  create(text: string): NarrationUtterance
  onVoicesChanged?: (listener: () => void) => () => void
}

type BrowserSpeechWindow = {
  speechSynthesis?: SpeechSynthesis
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance
}

/**
 * 默认引擎：只取浏览器原生 API；两个能力缺一即视为不支持。
 * `getVoices` / `speak` 都可能抛异常（部分浏览器在无音频设备时抛错），
 * 读 voice 失败按空列表处理，播放异常由 player 收口成 speech_error。
 */
export function createBrowserSpeechEngine(
  target: BrowserSpeechWindow | undefined = typeof window === 'undefined'
    ? undefined
    : (window as unknown as BrowserSpeechWindow),
): SpeechEngine | null {
  if (!target) return null
  const synth = target.speechSynthesis
  const UtteranceCtor = target.SpeechSynthesisUtterance
  if (!synth || typeof UtteranceCtor !== 'function') return null

  const toVoice = (voice: SpeechSynthesisVoice): SpeechVoice => ({
    name: voice.name,
    lang: voice.lang,
    localService: voice.localService,
    default: voice.default,
    native: voice,
  })

  return {
    getVoices() {
      try {
        return Array.from(synth.getVoices() ?? [], toVoice)
      } catch {
        return []
      }
    },
    speak(utterance) {
      synth.speak(utterance as unknown as SpeechSynthesisUtterance)
    },
    cancel() {
      synth.cancel()
    },
    pause() {
      synth.pause()
    },
    resume() {
      synth.resume()
    },
    create(text) {
      return new UtteranceCtor(text) as unknown as NarrationUtterance
    },
    onVoicesChanged:
      typeof synth.addEventListener === 'function'
        ? (listener) => {
            synth.addEventListener('voiceschanged', listener)
            return () => synth.removeEventListener('voiceschanged', listener)
          }
        : undefined,
  }
}

/* ───────────────────────── 声音选择 ───────────────────────── */

const CHINESE_LANG = /^(zh|cmn)([-_]|$)/i

export function isChineseVoice(voice: SpeechVoice): boolean {
  return CHINESE_LANG.test(voice.lang ?? '')
}

/**
 * 中文 voice 优先级：大陆简体 > 繁体（台港澳）> 其他 zh/cmn；同级再偏好本地合成、
 * 系统默认。只做排序，不改写 voice 的任何字段。
 */
export function pickChineseVoice(voices: readonly SpeechVoice[]): SpeechVoice | null {
  const chinese = voices.filter(isChineseVoice)
  if (chinese.length === 0) return null

  const score = (voice: SpeechVoice): number => {
    const lang = (voice.lang ?? '').toLowerCase()
    let value = 0
    if (/^zh([-_]?)(cn|hans)\b/.test(lang) || lang.includes('hans')) value += 30
    else if (/^zh([-_]?)(tw|hk|mo)\b/.test(lang) || lang.includes('hant')) value += 20
    else value += 10
    if (voice.localService) value += 2
    if (voice.default) value += 1
    return value
  }

  return [...chinese].sort((a, b) => score(b) - score(a))[0]
}

/** 组件展示用：voices 尚未加载时是 unknown，不急着下「没有中文语音」的结论。 */
export type SpeechVoiceStatus = 'ready' | 'missing' | 'unknown'

export function chineseVoiceStatus(voices: readonly SpeechVoice[]): SpeechVoiceStatus {
  if (voices.length === 0) return 'unknown'
  return pickChineseVoice(voices) ? 'ready' : 'missing'
}

export function clampSpeechRate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPEECH_RATE
  return Math.min(SPEECH_MAX_RATE, Math.max(SPEECH_MIN_RATE, Math.round(value * 10) / 10))
}

/* ───────────────────────── 讲解文案 ───────────────────────── */

const TRAILING_PUNCTUATION = /[\s。．.!！?？;；,，、]+$/

/**
 * 去 Markdown / URL，只留可以自然朗读的纯文本。
 * 顺序有意义：先图片/链接（连 URL 一起吃掉），再裸 URL、HTML、行首标记、强调符。
 */
export function stripMarkdownForSpeech(raw: string): string {
  if (!raw) return ''
  let text = raw.replace(/\r\n?/g, '\n')
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/<((?:https?|mailto):[^>]*)>/gi, ' ')
  text = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
  text = text.replace(/<[^>]*>/g, ' ')
  text = text.replace(/^[ \t]{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
  text = text.replace(/[*_~`]+/g, '')
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 站点讲解文本：站点名称 + 时间 + 简介 + 地址。
 * - 无简介 → 「暂无讲解」；
 * - 无时间 → 「时间未知」（不补默认时刻）；
 * - 不包含门票 / 营业时间 / 价格等未核实字段。
 */
export function buildStopNarration(stop: TripStop, options: { index?: number } = {}): string {
  const parts: string[] = []
  if (typeof options.index === 'number') parts.push(`第 ${options.index + 1} 站`)
  parts.push(stripMarkdownForSpeech(stop.name) || '未命名站点')
  parts.push(stop.time.trim() ? `时间 ${displayTime(stop.time)}` : '时间未知')
  const summary = stripMarkdownForSpeech(stop.description).replace(TRAILING_PUNCTUATION, '')
  parts.push(summary || '暂无讲解')
  const address = stripMarkdownForSpeech(stop.address).replace(TRAILING_PUNCTUATION, '')
  if (address) parts.push(`地址 ${address}`)
  return `${parts.join('，')}。`
}

export interface NarrationItem {
  id: string
  text: string
}

/* ───────────────────────── 播放器（单站 / 连续） ───────────────────────── */

export type SpeechStatus = 'idle' | 'speaking' | 'paused'
export type SpeechFailure = 'unsupported' | 'no_chinese_voice' | 'empty' | 'speech_error'

export interface NarrationState {
  status: SpeechStatus
  currentId: string | null
  /** 当前播放到第几项（0 基）；队列结束 / 停止后为 null */
  index: number | null
  total: number
  failure: SpeechFailure | null
}

export const IDLE_NARRATION_STATE: NarrationState = {
  status: 'idle',
  currentId: null,
  index: null,
  total: 0,
  failure: null,
}

export interface NarrationPlayResult {
  ok: boolean
  reason?: SpeechFailure
}

export interface NarrationPlayer {
  play(items: readonly NarrationItem[]): NarrationPlayResult
  pause(): void
  resume(): void
  stop(): void
  /** 返回实际生效的语速（已夹到 0.8–1.5）。 */
  setRate(rate: number): number
  getState(): NarrationState
  availability(): 'unsupported' | 'no_chinese_voice' | 'ready' | 'unknown'
  dispose(): void
}

/**
 * 模块级「当前朗读者」：同一页面同时只允许一路发声。
 * 在 A 站朗读时点开 B 站，B 的 play 会先停掉 A，避免两路叠读。
 */
let activeNarrator: NarrationPlayer | null = null

export function stopActiveNarration(): void {
  activeNarrator?.stop()
}

export interface NarrationPlayerOptions {
  engine: SpeechEngine | null
  rate?: number
  onState?: (state: NarrationState) => void
}

export function createNarrationPlayer(options: NarrationPlayerOptions): NarrationPlayer {
  const { engine } = options
  let rate = clampSpeechRate(options.rate ?? DEFAULT_SPEECH_RATE)
  let items: NarrationItem[] = []
  let state: NarrationState = { ...IDLE_NARRATION_STATE }
  let token = 0
  let disposed = false

  const emit = () => {
    if (!disposed) options.onState?.({ ...state })
  }

  const update = (patch: Partial<NarrationState>) => {
    state = { ...state, ...patch }
    emit()
  }

  const releaseActive = () => {
    if (activeNarrator === player) activeNarrator = null
  }

  const finish = () => {
    token += 1
    items = []
    releaseActive()
    update({ ...IDLE_NARRATION_STATE })
  }

  const fail = () => {
    token += 1
    items = []
    releaseActive()
    update({ ...IDLE_NARRATION_STATE, failure: 'speech_error' })
  }

  const speakCurrent = (currentToken: number) => {
    if (!engine) return
    const index = state.index
    if (index === null) {
      finish()
      return
    }
    const item = items[index]
    if (!item) {
      finish()
      return
    }
    const voices = engine.getVoices()
    const voice = pickChineseVoice(voices)
    // 队列启动时已检查过「有 voice 列表但没有中文」；这里再兜一层，避免中途换设备
    if (voices.length > 0 && voice === null) {
      fail()
      return
    }
    try {
      const utterance = engine.create(item.text)
      utterance.lang = 'zh-CN'
      utterance.rate = rate
      // WebIDL 只接受原生 SpeechSynthesisVoice；注入 fake 没有 native 时保留结构化对象。
      // 赋值本身也可能抛 TypeError，必须和 speak 一起收口，绝不能留下「speaking 但无声」。
      utterance.voice = voice?.native ?? voice
      utterance.onend = () => {
        if (disposed || currentToken !== token) return
        const next = (state.index ?? 0) + 1
        if (next >= items.length) {
          finish()
          return
        }
        update({ status: 'speaking', currentId: items[next].id, index: next })
        speakCurrent(token)
      }
      utterance.onerror = () => {
        if (disposed || currentToken !== token) return
        fail()
      }
      engine.speak(utterance)
    } catch {
      fail()
    }
  }

  const play: NarrationPlayer['play'] = (nextItems) => {
    if (disposed || !engine) {
      update({ ...IDLE_NARRATION_STATE, failure: 'unsupported' })
      return { ok: false, reason: 'unsupported' }
    }
    const cleaned = nextItems
      .map((item) => ({ id: item.id, text: item.text.trim() }))
      .filter((item) => item.text.length > 0)
    if (cleaned.length === 0) {
      update({ ...IDLE_NARRATION_STATE, failure: 'empty' })
      return { ok: false, reason: 'empty' }
    }
    const voices = engine.getVoices()
    if (voices.length > 0 && pickChineseVoice(voices) === null) {
      update({ ...IDLE_NARRATION_STATE, failure: 'no_chinese_voice' })
      return { ok: false, reason: 'no_chinese_voice' }
    }

    // 另一路正在读：先停掉，保证同一时刻只有一个声音
    if (activeNarrator && activeNarrator !== player) activeNarrator.stop()
    activeNarrator = player

    token += 1
    const currentToken = token
    try {
      engine.cancel()
    } catch {
      // 取消失败不影响后续 speak；真失败会由 speak 的 catch 收口
    }
    items = cleaned
    update({
      status: 'speaking',
      currentId: items[0].id,
      index: 0,
      total: items.length,
      failure: null,
    })
    speakCurrent(currentToken)
    // voice 赋值 / speak 是同步失败：返回失败而不是让调用方以为已经开始朗读。
    return state.failure === 'speech_error' ? { ok: false, reason: 'speech_error' } : { ok: true }
  }

  const pause = () => {
    if (!engine || state.status !== 'speaking') return
    try {
      engine.pause()
    } catch {
      return
    }
    update({ status: 'paused' })
  }

  const resume = () => {
    if (!engine || state.status !== 'paused') return
    try {
      engine.resume()
    } catch {
      return
    }
    update({ status: 'speaking' })
  }

  const stop = () => {
    token += 1
    items = []
    if (engine) {
      try {
        engine.cancel()
      } catch {
        // 停不下来也要把状态清干净
      }
    }
    releaseActive()
    update({ ...IDLE_NARRATION_STATE })
  }

  const setRate = (value: number): number => {
    const next = clampSpeechRate(value)
    rate = next
    // 正在读时换语速：重读当前这一项（不跳站、不自动续播别的站）
    if (engine && state.status === 'speaking') {
      token += 1
      try {
        engine.cancel()
      } catch {
        // 同上
      }
      speakCurrent(token)
    }
    return next
  }

  const availability: NarrationPlayer['availability'] = () => {
    if (!engine) return 'unsupported'
    const voices = engine.getVoices()
    if (voices.length === 0) return 'unknown'
    return pickChineseVoice(voices) ? 'ready' : 'no_chinese_voice'
  }

  const dispose = () => {
    token += 1
    items = []
    if (engine) {
      try {
        engine.cancel()
      } catch {
        // 卸载阶段不再抛
      }
    }
    releaseActive()
    disposed = true
  }

  const player: NarrationPlayer = {
    play,
    pause,
    resume,
    stop,
    setRate,
    getState: () => ({ ...state }),
    availability,
    dispose,
  }

  return player
}

/* ───────────────────────── React 接线 ───────────────────────── */

export interface UseSpeechNarration {
  supported: boolean
  voiceStatus: SpeechVoiceStatus
  status: SpeechStatus
  currentId: string | null
  index: number | null
  total: number
  failure: SpeechFailure | null
  rate: number
  play: (items: readonly NarrationItem[]) => NarrationPlayResult
  pause: () => void
  resume: () => void
  stop: () => void
  setRate: (rate: number) => void
}

/**
 * 组件接线：一个组件一份 player；卸载时 cancel 并把状态归零。
 * `supported` 只看浏览器能力；`voiceStatus` 会随 voiceschanged 更新，
 * 语音列表尚未加载时是 unknown（此时仍允许尝试，浏览器自己会选 voice）。
 */
export function useSpeechNarration(initialRate: number = DEFAULT_SPEECH_RATE): UseSpeechNarration {
  const engineRef = useRef<SpeechEngine | null | undefined>(undefined)
  if (engineRef.current === undefined) engineRef.current = createBrowserSpeechEngine()
  const engine = engineRef.current
  const supported = engine !== null

  const [voiceStatus, setVoiceStatus] = useState<SpeechVoiceStatus>(() =>
    engine ? chineseVoiceStatus(engine.getVoices()) : 'unknown',
  )
  const [state, setState] = useState<NarrationState>(IDLE_NARRATION_STATE)
  const [rate, setRateState] = useState(() => clampSpeechRate(initialRate))
  const rateRef = useRef(rate)
  const playerRef = useRef<NarrationPlayer | null>(null)

  const getPlayer = useCallback((): NarrationPlayer | null => {
    if (!engine) return null
    if (!playerRef.current) {
      playerRef.current = createNarrationPlayer({
        engine,
        rate: rateRef.current,
        onState: setState,
      })
    }
    return playerRef.current
  }, [engine])

  useEffect(() => {
    if (!engine?.onVoicesChanged) return
    return engine.onVoicesChanged(() => {
      setVoiceStatus(chineseVoiceStatus(engine.getVoices()))
    })
  }, [engine])

  useEffect(
    () => () => {
      playerRef.current?.dispose()
      playerRef.current = null
    },
    [],
  )

  const play = useCallback(
    (items: readonly NarrationItem[]): NarrationPlayResult => {
      const player = getPlayer()
      if (!player) {
        setState({ ...IDLE_NARRATION_STATE, failure: 'unsupported' })
        return { ok: false, reason: 'unsupported' }
      }
      const result = player.play(items)
      if (!result.ok && result.reason === 'no_chinese_voice') setVoiceStatus('missing')
      return result
    },
    [getPlayer],
  )

  const pause = useCallback(() => {
    playerRef.current?.pause()
  }, [])

  const resume = useCallback(() => {
    playerRef.current?.resume()
  }, [])

  const stop = useCallback(() => {
    playerRef.current?.stop()
  }, [])

  const setRate = useCallback((value: number) => {
    const next = clampSpeechRate(value)
    rateRef.current = next
    setRateState(next)
    playerRef.current?.setRate(next)
  }, [])

  return {
    supported,
    voiceStatus,
    status: state.status,
    currentId: state.currentId,
    index: state.index,
    total: state.total,
    failure: state.failure,
    rate,
    play,
    pause,
    resume,
    stop,
    setRate,
  }
}

/** 组件展示用：把能力 / 降级状态收成一句人话（无问题时返回 null）。 */
export function speechNotice(
  supported: boolean,
  voiceStatus: SpeechVoiceStatus,
  failure: SpeechFailure | null,
): string | null {
  if (!supported) return SPEECH_UNSUPPORTED_TEXT
  if (voiceStatus === 'missing') return SPEECH_NO_VOICE_TEXT
  if (failure === 'speech_error') return SPEECH_ERROR_TEXT
  if (failure === 'no_chinese_voice') return SPEECH_NO_VOICE_TEXT
  return null
}

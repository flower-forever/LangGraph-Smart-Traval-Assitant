/**
 * S7 · 语音讲解的轻量公共层（S8 拆包后从 speech.ts 抽出）。
 *
 * 这里只放常量、类型与纯函数：不引用 React、不碰 window、不产生副作用。
 * 重实现（浏览器引擎适配 + 播放器）在 `speechCore.ts`，由 `speech.ts` 的
 * `useSpeechNarration` 按需动态加载，避免首屏 chunk 带上整段语音逻辑。
 */
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

/* ───────────────────────── 播放器状态与接口（类型） ───────────────────────── */

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

export interface NarrationPlayerOptions {
  engine: SpeechEngine | null
  rate?: number
  onState?: (state: NarrationState) => void
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

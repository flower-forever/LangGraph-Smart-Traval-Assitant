/**
 * S7 · 语音讲解（计划 §8.1）；S8 拆包。
 *
 * 本文件只保留公开 API 与 React 接线：
 * - 常量 / 类型 / 纯函数在 `speechText.ts`（首屏同步可用）；
 * - 浏览器引擎与播放器在 `speechCore.ts`，组件挂载后才动态加载。
 *
 * 边界（硬约束，重实现见 speechCore.ts）：
 * - 零写入 / 零上传：只调用浏览器 `speechSynthesis`，不碰存储、不发请求；
 * - 显式点击才发声；
 * - 不朗读未核实事实；
 * - 诚实降级：没有中文 voice 时明确说明，不静默改英文；
 * - 引擎可注入（测试用假对象），生产默认取 `window.speechSynthesis`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  DEFAULT_SPEECH_RATE,
  IDLE_NARRATION_STATE,
  chineseVoiceStatus,
  clampSpeechRate,
  type NarrationItem,
  type NarrationPlayResult,
  type NarrationPlayer,
  type NarrationState,
  type SpeechEngine,
  type SpeechFailure,
  type SpeechStatus,
  type SpeechVoice,
  type SpeechVoiceStatus,
} from './speechText'

export * from './speechText'

type BrowserSpeechWindow = {
  speechSynthesis?: SpeechSynthesis
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance
}

/** 同步能力探测：只判断 API 是否存在，不创建引擎、不读 voice。 */
function hasSpeechApi(): boolean {
  if (typeof window === 'undefined') return false
  const target = window as unknown as BrowserSpeechWindow
  return Boolean(target.speechSynthesis && typeof target.SpeechSynthesisUtterance === 'function')
}

/** 同步读一次原生 voice 列表，只为让首帧就能判断「没有中文 voice」。 */
function readBrowserVoices(): SpeechVoice[] {
  if (typeof window === 'undefined') return []
  try {
    const synth = (window as unknown as BrowserSpeechWindow).speechSynthesis
    if (!synth) return []
    return Array.from(synth.getVoices() ?? [], (voice) => ({
      name: voice.name,
      lang: voice.lang,
      localService: voice.localService,
      default: voice.default,
      native: voice,
    }))
  } catch {
    return []
  }
}

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
 * `supported` 只看浏览器能力（同步）；重实现在挂载后动态加载，
 * 加载完成前点击播放会先排队，加载完立即开播。
 */
export function useSpeechNarration(initialRate: number = DEFAULT_SPEECH_RATE): UseSpeechNarration {
  const supported = useMemo(hasSpeechApi, [])
  const coreRef = useRef<typeof import('./speechCore') | null>(null)
  const engineRef = useRef<SpeechEngine | null>(null)
  const playerRef = useRef<NarrationPlayer | null>(null)
  const pendingRef = useRef<readonly NarrationItem[] | null>(null)

  const [coreReady, setCoreReady] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<SpeechVoiceStatus>(() =>
    supported ? chineseVoiceStatus(readBrowserVoices()) : 'unknown',
  )
  const [state, setState] = useState<NarrationState>(IDLE_NARRATION_STATE)
  const [rate, setRateState] = useState(() => clampSpeechRate(initialRate))
  const rateRef = useRef(rate)

  useEffect(() => {
    if (!supported) return
    let alive = true
    void import('./speechCore')
      .then((core) => {
        if (!alive) return
        coreRef.current = core
        const engine = core.createBrowserSpeechEngine()
        engineRef.current = engine
        if (engine) setVoiceStatus(chineseVoiceStatus(engine.getVoices()))
        setCoreReady(true)
      })
      .catch(() => {
        // 加载失败：标记 core 已结束，后续点击走明确的 unsupported 降级。
        if (alive) setCoreReady(true)
      })
    return () => {
      alive = false
    }
  }, [supported])

  const getPlayer = useCallback((): NarrationPlayer | null => {
    const engine = engineRef.current
    const core = coreRef.current
    if (!engine || !core) return null
    if (!playerRef.current) {
      playerRef.current = core.createNarrationPlayer({
        engine,
        rate: rateRef.current,
        onState: setState,
      })
    }
    return playerRef.current
  }, [])

  useEffect(() => {
    if (!coreReady) return
    const engine = engineRef.current
    if (!engine?.onVoicesChanged) return
    return engine.onVoicesChanged(() => {
      setVoiceStatus(chineseVoiceStatus(engine.getVoices()))
    })
  }, [coreReady])

  useEffect(
    () => () => {
      playerRef.current?.dispose()
      playerRef.current = null
      pendingRef.current = null
    },
    [],
  )

  /* 模块加载完成时补播排队的那一次点击（用户通常感知不到）。 */
  useEffect(() => {
    if (!coreReady) return
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    const player = getPlayer()
    if (!player) {
      setState({ ...IDLE_NARRATION_STATE, failure: 'unsupported' })
      return
    }
    player.play(pending)
  }, [coreReady, getPlayer])

  const play = useCallback(
    (items: readonly NarrationItem[]): NarrationPlayResult => {
      if (!supported) {
        setState({ ...IDLE_NARRATION_STATE, failure: 'unsupported' })
        return { ok: false, reason: 'unsupported' }
      }
      const player = getPlayer()
      if (!player) {
        if (coreReady) {
          setState({ ...IDLE_NARRATION_STATE, failure: 'unsupported' })
          return { ok: false, reason: 'unsupported' }
        }
        pendingRef.current = items
        return { ok: true }
      }
      const result = player.play(items)
      if (!result.ok && result.reason === 'no_chinese_voice') setVoiceStatus('missing')
      return result
    },
    [supported, coreReady, getPlayer],
  )

  const pause = useCallback(() => {
    playerRef.current?.pause()
  }, [])

  const resume = useCallback(() => {
    playerRef.current?.resume()
  }, [])

  const stop = useCallback(() => {
    pendingRef.current = null
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

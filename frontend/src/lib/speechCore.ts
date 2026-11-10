/**
 * S7 · 语音讲解重实现（S8 拆包后从 speech.ts 抽出）。
 *
 * 只在 `useSpeechNarration` 首次挂载后动态加载；纯逻辑测试直接从本模块导入。
 * 边界与原 speech.ts 完全一致：
 * - 只调用浏览器 `speechSynthesis`，不写存储、不发网络请求；
 * - 显式点击才发声；
 * - 没有中文 voice 时明确降级，不硬读；
 * - 同一页面同时只允许一路发声。
 */
import {
  DEFAULT_SPEECH_RATE,
  IDLE_NARRATION_STATE,
  clampSpeechRate,
  pickChineseVoice,
  type NarrationItem,
  type NarrationPlayer,
  type NarrationPlayerOptions,
  type NarrationState,
  type NarrationUtterance,
  type SpeechEngine,
  type SpeechVoice,
} from './speechText'

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

/**
 * 模块级「当前朗读者」：同一页面同时只允许一路发声。
 * 在 A 站朗读时点开 B 站，B 的 play 会先停掉 A，避免两路叠读。
 */
let activeNarrator: NarrationPlayer | null = null

export function stopActiveNarration(): void {
  activeNarrator?.stop()
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

import { useEffect } from 'react'

import type { TripStop } from '../lib/api'
import { projectStopFacts, type StopFactField } from '../lib/stopFacts'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import {
  SPEECH_RATE_OPTIONS,
  buildStopNarration,
  speechNotice,
  useSpeechNarration,
} from '../lib/speech'
import StopFactBadge from './StopFactBadge'

interface StopPoiCardProps {
  stop: TripStop
  /** 资料卡库（父级读好传入；null = 未加载）。只读投影，不写任何键。 */
  poiCards: PoiCardsRecordV1 | null
  /**
   * 「去资料卡补充」入口（S2）：无卡 / 多命中时显示；点击后由父级打开
   * 资料卡面板（预填停点名）。本组件不自动抓取、不发请求、零写入。
   */
  onOpenPoiCardPanel?: (stopName: string) => void
  /**
   * 当前时刻（epoch ms）。展示口径不依赖墙钟：缺省 Date.now，测试可注入。
   * 投影本身以参数收当前时间（stopFacts.ts），组件只负责传参。
   */
  now?: () => number
}

/** 三字段共同的行布局：标签 + 值 + 徽章；值为空时由徽章的「未知」承担展示值。
 * 用 div 不用 p：sourced 徽章含 <details>，块级展开内容不能嵌在段落里。 */
function FactRow({
  label,
  fact,
  detailLabel,
}: {
  label: string
  fact: StopFactField
  detailLabel: string
}) {
  return (
    <div className="m-0 mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-[color:var(--color-secondary-foreground)]">
      <span className="shrink-0">{label}：</span>
      {fact.value !== null && <span>{fact.value}</span>}
      <StopFactBadge fact={fact} detailLabel={detailLabel} />
    </div>
  )
}

/**
 * 停点信息可信卡（四期 S3 抽出，五期 S2 改造）：列表视图与时间轴视图
 * 共用同一投影（projectStopFacts）与同一徽章（StopFactBadge）口径。
 * 三字段（介绍 / 开放时间 / 门票）各带状态徽章：有来源（待核对）/ 未核实 / 未知；
 * sourced 可展开来源详情（source + sourceDetail + recordedAt），超 180 天加「可能过期」。
 * 无卡 / 多命中 → 三字段「未知」+ 可选「去资料卡补充」入口（仅入口，不自动抓取）。
 * 只读展示：本组件不写任何键、不发请求。
 */
export default function StopPoiCard({ stop, poiCards, onOpenPoiCardPanel, now = () => Date.now() }: StopPoiCardProps) {
  const facts = projectStopFacts(stop, poiCards, now())
  const title = facts.matched ? `景点资料卡 · ${facts.cardName ?? stop.name}` : '景点信息 · 未知'

  /* ── S7 语音讲解：只有显式点击才发声；切换站点 / 卸载自动停止 ── */
  const speech = useSpeechNarration()
  useEffect(() => {
    // 同一张卡被复用到另一个站点时也要停掉上一站；stop 是稳定回调
    speech.stop()
  }, [stop.id, speech.stop])
  const narration = buildStopNarration(stop)
  const notice = speechNotice(speech.supported, speech.voiceStatus, speech.failure)
  const speechBlocked = !speech.supported || speech.voiceStatus === 'missing'
  const speakingThis = speech.status !== 'idle' && speech.currentId === stop.id
  const listenLabel = speakingThis
    ? speech.status === 'paused'
      ? '继续讲解'
      : '暂停讲解'
    : '听讲解'

  const handleListen = () => {
    if (speechBlocked) return
    if (speakingThis) {
      if (speech.status === 'paused') speech.resume()
      else speech.pause()
      return
    }
    speech.play([{ id: stop.id, text: narration }])
  }

  return (
    <div
      className="mt-3 rounded-[10px] border border-border bg-card p-3"
      data-testid={`stop-poi-card-${stop.id}`}
      role="note"
      aria-label={`景点信息可信卡：${stop.name}`}
    >
      <p className="m-0 mb-1 text-sm font-semibold text-foreground">{title}</p>
      <FactRow label="介绍" fact={facts.intro} detailLabel={`介绍来源：${stop.name}`} />
      <FactRow label="开放时间" fact={facts.openingHours} detailLabel={`开放时间来源：${stop.name}`} />
      <FactRow label="门票" fact={facts.ticket} detailLabel={`门票来源：${stop.name}`} />
      {facts.matched ? (
        <p className="m-0 text-xs text-muted-foreground">按名称匹配，请自行核对</p>
      ) : (
        <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>暂无名称匹配的资料卡；信息未知。</span>
          {onOpenPoiCardPanel && (
            <button
              type="button"
              className="cursor-pointer border-0 bg-none p-0 font-[inherit] text-xs text-[color:var(--color-accent-foreground)] underline underline-offset-2 [text-decoration-thickness:1px] hover:text-primary"
              data-testid="stop-poi-card-supplement"
              onClick={() => onOpenPoiCardPanel(stop.name)}
            >
              去资料卡补充
            </button>
          )}
        </p>
      )}

      <div
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3"
        data-testid={`stop-speech-controls-${stop.id}`}
      >
        <button
          type="button"
          className="min-h-11 cursor-pointer rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-4 text-sm hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
          data-testid={`stop-listen-${stop.id}`}
          onClick={handleListen}
          disabled={speechBlocked}
          aria-pressed={speakingThis}
        >
          {listenLabel}
        </button>
        {speakingThis && (
          <button
            type="button"
            className="min-h-11 cursor-pointer rounded-[6px] border border-border bg-background px-4 text-sm hover:bg-secondary"
            data-testid={`stop-speech-stop-${stop.id}`}
            onClick={() => speech.stop()}
          >
            停止
          </button>
        )}
        {speech.supported && speech.voiceStatus !== 'missing' && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            语速
            <select
              className="min-h-9 rounded-[6px] border border-border bg-background px-1.5 text-xs"
              data-testid={`stop-speech-rate-${stop.id}`}
              value={String(speech.rate)}
              onChange={(event) => speech.setRate(Number(event.target.value))}
            >
              {SPEECH_RATE_OPTIONS.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}x
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="text-xs text-muted-foreground" aria-live="polite" data-testid={`stop-speech-status-${stop.id}`}>
          {notice ?? (speakingThis ? (speech.status === 'paused' ? '已暂停' : '正在朗读…') : '语音只在点击后播放，不上传文本')}
        </span>
      </div>
    </div>
  )
}

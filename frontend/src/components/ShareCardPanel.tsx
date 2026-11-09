/**
 * 行程分享卡片预览与下载面板（四期 S4）。
 *
 * 边界：
 * - 打开面板、切换日期、切换风格都只重算内存里的 SVG 预览：不发请求、
 *   不写 localStorage / sessionStorage、不改 Trip、不自动下载。
 * - 只有显式点「下载 SVG」「下载 PNG」才创建文件；PNG 在本地 canvas 光栅化。
 * - 关闭 / Esc 会作废尚未完成的 PNG 生成，关闭后不会再触发下载。
 * - 预览卡片颜色固定在 lib/shareCard.ts 的六风格 token 中，不随 App 深浅主题变化；
 *   面板外壳使用 App 语义变量，深浅主题下均可读。
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Trip } from '../lib/api'
import {
  DEFAULT_SHARE_CARD_STYLE,
  SHARE_CARD_STYLES,
  buildShareCardData,
  renderShareCard,
  type ShareCardStyle,
} from '../lib/shareCard'
import {
  rasterizeShareCardPng,
  type RasterizeOutcome,
} from '../lib/shareCardPng'
import {
  downloadPngBlob,
  downloadSvgCard,
  shareCardFileName,
} from '../lib/shareCardFile'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'

export interface ShareCardPanelProps {
  trip: Trip
  initialDay: number
  onClose: () => void
  /** 测试注入 PNG 光栅化；默认走原生 canvas。 */
  rasterize?: (svg: string) => Promise<RasterizeOutcome>
}

type PngState = 'idle' | 'working' | 'unsupported' | 'decode' | 'encode'

const PNG_ERROR_TEXT: Record<Exclude<PngState, 'idle' | 'working'>, string> = {
  unsupported: '当前浏览器不支持在本地生成 PNG，请改下载 SVG。',
  decode: '卡片图像解码失败，请重试或改下载 SVG。',
  encode: 'PNG 编码失败，请重试或改下载 SVG。',
}

const FIELD_LABEL = 'text-sm leading-relaxed text-muted-foreground'
const PANEL_NOTE = 'm-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]'

export default function ShareCardPanel({
  trip,
  initialDay,
  onClose,
  rasterize = (svg) => rasterizeShareCardPng(svg),
}: ShareCardPanelProps) {
  const initialExists = trip.days.some((day) => day.day === initialDay)
  const [dayNumber, setDayNumber] = useState<number>(
    initialExists ? initialDay : (trip.days[0]?.day ?? initialDay),
  )
  const [style, setStyle] = useState<ShareCardStyle>(DEFAULT_SHARE_CARD_STYLE)
  const [pngState, setPngState] = useState<PngState>('idle')
  const [svgFailed, setSvgFailed] = useState(false)

  const titleId = useId()
  const dayId = useId()
  const styleId = useId()
  const pngErrorId = useId()
  const pngSeqRef = useRef(0)

  const selectedDay = useMemo(
    () => trip.days.find((day) => day.day === dayNumber) ?? trip.days[0],
    [trip.days, dayNumber],
  )
  const data = useMemo(
    () => (selectedDay ? buildShareCardData(trip, selectedDay) : null),
    [trip, selectedDay],
  )
  const svg = useMemo(
    () => (data ? renderShareCard(style, data) : ''),
    [style, data],
  )

  const handleClose = useCallback(() => {
    pngSeqRef.current += 1
    setPngState('idle')
    onClose()
  }, [onClose])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      handleClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [handleClose])

  useEffect(() => {
    // 父级直接卸载面板时作废未完成的 PNG，避免卸载后仍触发下载
    return () => {
      pngSeqRef.current += 1
    }
  }, [])

  const handleStyleChange = (next: ShareCardStyle) => {
    // 预览变了：作废仍在生成的旧风格 PNG，切换本身不产生任何下载
    pngSeqRef.current += 1
    setStyle(next)
    setPngState('idle')
    setSvgFailed(false)
  }

  const handleDayChange = (next: number) => {
    // 同上：换天后旧图不再对应当前预览
    pngSeqRef.current += 1
    setDayNumber(next)
    setPngState('idle')
    setSvgFailed(false)
  }

  const handleDownloadSvg = () => {
    if (!data) return
    const ok = downloadSvgCard(svg, shareCardFileName(data.dayNumber, style, 'svg'))
    setSvgFailed(!ok)
  }

  const handleDownloadPng = async () => {
    if (!data || pngState === 'working') return
    const sequence = pngSeqRef.current + 1
    pngSeqRef.current = sequence
    setPngState('working')
    setSvgFailed(false)

    const outcome = await rasterize(svg).catch((): RasterizeOutcome => ({ ok: false, reason: 'encode' }))
    // 关闭 / Esc / 切换预览会推进序号：迟到的结果直接丢弃，不再触发下载
    if (sequence !== pngSeqRef.current) return
    if (outcome.ok) {
      const downloaded = downloadPngBlob(
        outcome.blob,
        shareCardFileName(data.dayNumber, style, 'png'),
      )
      setPngState(downloaded ? 'idle' : 'unsupported')
      return
    }
    setPngState(outcome.reason)
  }

  const pngError =
    pngState === 'unsupported' || pngState === 'decode' || pngState === 'encode'
      ? PNG_ERROR_TEXT[pngState]
      : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-3 sm:p-6"
      data-testid="share-card-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-[10px] border border-border bg-background p-4 shadow-xl sm:p-6"
      >
        <div className="grid min-w-0 gap-5">
          <div className="grid min-w-0 gap-1.5">
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--color-accent-foreground)]">
              四期 S4 · 只读预览
            </p>
            <h2
              className="m-0 font-display text-2xl font-bold leading-[1.3] tracking-[0.02em] [overflow-wrap:anywhere]"
              id={titleId}
            >
              生成分享卡片
            </h2>
            <p className={PANEL_NOTE}>
              卡片只含行程名、天数、日期、站点与交通摘要。预览与风格切换不会写入任何存储；
              只有点「下载 SVG」或「下载 PNG」才会在你自己的电脑上生成文件。
            </p>
          </div>

          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="grid min-w-0 content-start gap-3">
              <div
                className="mx-auto w-full max-w-[420px] overflow-hidden rounded-[6px] border border-border bg-secondary shadow-sm [&>div>svg]:block [&>div>svg]:h-auto [&>div>svg]:w-full"
                data-testid="share-card-preview"
              >
                <div
                  data-style={style}
                  // 内容由 lib/shareCard.ts 受控生成，所有用户文本已做 XML 转义
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
              <p className={`${PANEL_NOTE} text-center`}>
                预览按 1080 × 1440 比例缩放；字体使用系统字体栈，不同电脑上的字形可能略有差异。
              </p>
            </div>

            <div className="grid min-w-0 content-start gap-4">
              <div className="grid gap-1.5">
                <label className={FIELD_LABEL} htmlFor={dayId}>
                  选择日期
                </label>
                <Select
                  id={dayId}
                  value={selectedDay?.day ?? ''}
                  onChange={(event) => handleDayChange(Number(event.target.value))}
                >
                  {trip.days.map((day) => (
                    <option key={day.day} value={day.day}>
                      {`D${day.day} · ${day.title}`}
                    </option>
                  ))}
                </Select>
              </div>

              <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
                <legend className={FIELD_LABEL} id={styleId}>
                  选择风格
                </legend>
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
                  {SHARE_CARD_STYLES.map((item) => {
                    const active = item.id === style
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={active}
                        aria-label={item.label}
                        onClick={() => handleStyleChange(item.id)}
                        className={[
                          'grid min-h-11 min-w-0 cursor-pointer gap-0.5 rounded-[6px] border-2 px-3 py-2 text-left transition-colors duration-150 ease-out',
                          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-accent-foreground)]',
                          active
                            ? 'border-[color:var(--color-accent-foreground)] bg-accent-surface text-[color:var(--color-accent-foreground)]'
                            : 'border-border bg-background text-foreground hover:bg-secondary',
                        ].join(' ')}
                      >
                        <span className="text-sm font-semibold leading-normal">{item.label}</span>
                        <span
                          aria-hidden="true"
                          className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
                        >
                          {item.description}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </fieldset>

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleDownloadSvg}>下载 SVG</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void handleDownloadPng()
                  }}
                  disabled={pngState === 'working'}
                  aria-busy={pngState === 'working' || undefined}
                  aria-describedby={pngError ? pngErrorId : undefined}
                >
                  {pngState === 'working' ? '正在生成 PNG…' : '下载 PNG'}
                </Button>
                <Button variant="ghost" onClick={handleClose}>
                  关闭
                </Button>
              </div>

              <div aria-live="polite" aria-atomic="true">
                {pngError ? (
                  <p
                    className="m-0 rounded-[6px] border border-[color:var(--color-warn-ink)]/40 bg-[color:var(--color-warn-bg)] p-2.5 text-sm font-medium leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]"
                    id={pngErrorId}
                    role="alert"
                  >
                    {pngError}
                  </p>
                ) : null}
                {svgFailed ? (
                  <p
                    className="m-0 rounded-[6px] border border-[color:var(--color-warn-ink)]/40 bg-[color:var(--color-warn-bg)] p-2.5 text-sm font-medium leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]"
                    role="alert"
                  >
                    当前浏览器不支持在本地创建下载文件，未下载任何文件。
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

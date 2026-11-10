/**
 * 行程分享卡片预览与下载面板（四期 S4；五期 S5 扩展）。
 *
 * 边界：
 * - 打开面板、切换日期 / 风格 / 来源、勾选小地图都只重算内存里的预览：
 *   不发请求、不写 localStorage / sessionStorage、不改 Trip、不自动下载。
 * - 只有显式点「下载 SVG」「下载 PNG」才创建图片文件；PNG 在本地 canvas 光栅化。
 * - 离线路书必须先预览，再点「确认下载 .html」才创建文件；取消零下载。
 * - 草稿来源只在父级传入 draftTrip 时出现；没有草稿不制造选项，默认永远
 *   是「当前已应用行程」。
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
import type { RasterizeOutcome } from '../lib/shareCardPng'
import {
  downloadPngBlob,
  downloadSvgCard,
  shareCardFileName,
} from '../lib/shareCardFile'
import {
  appendMiniMapToShareCard,
  buildShareMiniMap,
  type ShareMiniMap,
} from '../lib/shareMiniMap'
import type { PoiCardsRecordV1 } from '../lib/poiCards'
import { useDialogFocus } from '../lib/useDialogFocus'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'

export interface ShareCardPanelProps {
  /** 当前已应用（保存中）的行程。 */
  trip: Trip
  initialDay: number
  onClose: () => void
  /**
   * 未应用草稿的行程预览；null / 缺省 = 没有草稿，不显示来源切换。
   * 由父级显式传入，组件不自行从 store 推断草稿状态。
   */
  draftTrip?: Trip | null
  /** 资料卡库；离线路书的三态来源徽章复用 projectStopFacts。缺省 = 全部未知。 */
  poiCards?: PoiCardsRecordV1 | null
  /** 当前时刻注入（epoch ms）；离线路书记录时效用，缺省 Date.now。 */
  now?: () => number
  /** 测试注入 PNG 光栅化；默认走原生 canvas。 */
  rasterize?: (svg: string) => Promise<RasterizeOutcome>
}

type PngState = 'idle' | 'working' | 'unsupported' | 'decode' | 'encode'
type ShareSource = 'applied' | 'draft'

interface RoadbookPreview {
  html: string
  fileName: string
}

const PNG_ERROR_TEXT: Record<Exclude<PngState, 'idle' | 'working'>, string> = {
  unsupported: '当前浏览器不支持在本地生成 PNG，请改下载 SVG。',
  decode: '卡片图像解码失败，请重试或改下载 SVG。',
  encode: 'PNG 编码失败，请重试或改下载 SVG。',
}

const FIELD_LABEL = 'text-sm leading-relaxed text-muted-foreground'
const PANEL_NOTE = 'm-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]'

function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

export default function ShareCardPanel({
  trip,
  initialDay,
  onClose,
  draftTrip = null,
  poiCards = null,
  now = () => Date.now(),
  rasterize = async (svg) => (await import('../lib/shareCardPng')).rasterizeShareCardPng(svg),
}: ShareCardPanelProps) {
  const initialExists = trip.days.some((day) => day.day === initialDay)
  const [dayNumber, setDayNumber] = useState<number>(
    initialExists ? initialDay : (trip.days[0]?.day ?? initialDay),
  )
  const [style, setStyle] = useState<ShareCardStyle>(DEFAULT_SHARE_CARD_STYLE)
  const [source, setSource] = useState<ShareSource>('applied')
  const [includeMiniMap, setIncludeMiniMap] = useState(false)
  const [pngState, setPngState] = useState<PngState>('idle')
  const [svgFailed, setSvgFailed] = useState(false)
  const [roadbookPreview, setRoadbookPreview] = useState<RoadbookPreview | null>(null)
  const [roadbookError, setRoadbookError] = useState<string | null>(null)
  const [roadbookBusy, setRoadbookBusy] = useState(false)

  const titleId = useId()
  const dayId = useId()
  const styleId = useId()
  const sourceName = useId()
  const pngErrorId = useId()
  const pngSeqRef = useRef(0)

  // 草稿只有真实存在且带日期时才提供选项；缺省永远显示已应用行程。
  const hasDraft = draftTrip !== null && draftTrip.days.length > 0
  const effectiveSource: ShareSource = source === 'draft' && hasDraft ? 'draft' : 'applied'
  const activeTrip = effectiveSource === 'draft' && draftTrip !== null ? draftTrip : trip

  const selectedDay = useMemo(
    () => activeTrip.days.find((day) => day.day === dayNumber) ?? activeTrip.days[0],
    [activeTrip.days, dayNumber],
  )
  const data = useMemo(
    () => (selectedDay ? buildShareCardData(activeTrip, selectedDay) : null),
    [activeTrip, selectedDay],
  )
  const miniMap = useMemo<ShareMiniMap>(
    () =>
      selectedDay
        ? buildShareMiniMap(selectedDay)
        : { svg: null, unknownStops: [], routeTypes: [] },
    [selectedDay],
  )
  const cardSvg = useMemo(
    () => (data ? renderShareCard(style, data) : ''),
    [style, data],
  )
  const svg = useMemo(() => {
    if (!includeMiniMap || miniMap.svg === null || cardSvg === '') return cardSvg
    return appendMiniMapToShareCard(cardSvg, miniMap, {
      label: data ? `${data.tripTitle} · 第 ${data.dayNumber} 天 · 路线小地图` : '路线小地图',
    })
  }, [cardSvg, data, includeMiniMap, miniMap])

  const handleClose = useCallback(() => {
    pngSeqRef.current += 1
    setPngState('idle')
    onClose()
  }, [onClose])

  const dialogRef = useDialogFocus<HTMLDivElement>({ onEscape: handleClose })

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
    // 同上：换天后旧图不再对应当前预览；路书预览也必须重算
    pngSeqRef.current += 1
    setDayNumber(next)
    setPngState('idle')
    setSvgFailed(false)
    setRoadbookPreview(null)
    setRoadbookError(null)
  }

  const handleSourceChange = (next: ShareSource) => {
    if (next === 'draft' && !hasDraft) return
    pngSeqRef.current += 1
    setSource(next)
    setPngState('idle')
    setSvgFailed(false)
    setRoadbookPreview(null)
    setRoadbookError(null)
    const days = next === 'draft' && draftTrip !== null ? draftTrip.days : trip.days
    if (days.length > 0 && !days.some((day) => day.day === dayNumber)) {
      setDayNumber(days[0].day)
    }
  }

  const handleToggleMiniMap = (checked: boolean) => {
    pngSeqRef.current += 1
    setIncludeMiniMap(checked)
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

  const handleRoadbookRequest = async () => {
    if (roadbookBusy) return
    setRoadbookBusy(true)
    setRoadbookError(null)
    try {
      const { buildOfflineRoadbook } = await import('../lib/offlineRoadbook')
      const result = buildOfflineRoadbook(activeTrip, {
        poiCards,
        now: now(),
        isDraft: effectiveSource === 'draft',
      })
      if (!result.ok) {
        const limitLabel = result.limit === 2 * 1024 * 1024 ? '2 MiB' : mebibytes(result.limit)
        setRoadbookPreview(null)
        setRoadbookError(
          `离线路书超过 ${limitLabel} 上限（当前 ${mebibytes(result.bytes)}），未生成任何文件；请精简站点或文字后重试。`,
        )
        return
      }
      setRoadbookPreview({ html: result.html, fileName: result.fileName })
    } catch {
      setRoadbookPreview(null)
      setRoadbookError('离线路书模块加载失败，未生成任何文件；请重试。')
    } finally {
      setRoadbookBusy(false)
    }
  }

  const handleRoadbookConfirm = async () => {
    if (!roadbookPreview) return
    setRoadbookBusy(true)
    try {
      const { downloadRoadbookHtml } = await import('../lib/offlineRoadbook')
      if (!downloadRoadbookHtml(roadbookPreview.html, roadbookPreview.fileName)) {
        setRoadbookError('当前浏览器不支持在本地创建下载文件，未下载任何文件。')
        return
      }
      setRoadbookError(null)
      setRoadbookPreview(null)
    } catch {
      setRoadbookError('离线路书模块加载失败，未下载任何文件；请重试。')
    } finally {
      setRoadbookBusy(false)
    }
  }

  const pngError =
    pngState === 'unsupported' || pngState === 'decode' || pngState === 'encode'
      ? PNG_ERROR_TEXT[pngState]
      : null
  const isDraftSource = effectiveSource === 'draft'

  return (
    <div
      className="oc-overlay-enter fixed inset-0 z-[1200] flex items-center justify-center bg-black/55 p-3 sm:p-6"
      data-testid="share-card-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="oc-panel-enter max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-[10px] border border-border bg-background p-4 shadow-xl sm:p-6"
      >
        <div className="grid min-w-0 gap-5">
          <div className="grid min-w-0 gap-1.5">
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--color-accent-foreground)]">
              四期 S4 · 只读预览
            </p>
            <h2
              className="m-0 font-display text-2xl font-bold leading-[1.3] tracking-[0.02em] [overflow-wrap:anywhere]"
              id={titleId}
              tabIndex={-1}
              data-dialog-initial-focus
            >
              生成分享卡片
            </h2>
            <p className={PANEL_NOTE}>
              卡片只含行程名、天数、日期、站点与交通摘要。预览、风格切换与路线小地图都不会写入任何存储；
              只有点「下载 SVG」「下载 PNG」或在路书预览里确认下载，才会在你自己的电脑上生成文件。
            </p>
          </div>

          {hasDraft ? (
            <fieldset
              className="m-0 grid min-w-0 gap-2 rounded-[6px] border border-border bg-card p-3"
              data-testid="share-source"
            >
              <legend className={FIELD_LABEL}>分享哪一版行程</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                <label className="flex min-h-11 items-center gap-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name={sourceName}
                    value="applied"
                    checked={effectiveSource === 'applied'}
                    onChange={() => handleSourceChange('applied')}
                  />
                  当前已应用行程（默认）
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name={sourceName}
                    value="draft"
                    checked={effectiveSource === 'draft'}
                    onChange={() => handleSourceChange('draft')}
                  />
                  当前草稿（未应用）
                </label>
              </div>
              {isDraftSource ? (
                <p
                  className="m-0 rounded-[6px] border border-[color:var(--color-warn-ink)]/40 bg-[color:var(--color-warn-bg)] p-2 text-sm font-medium leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]"
                  data-testid="share-draft-badge"
                  role="status"
                >
                  草稿未应用，分享的是草稿
                </p>
              ) : null}
            </fieldset>
          ) : null}

          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="grid min-w-0 content-start gap-3">
              <div
                className="mx-auto w-full max-w-[420px] overflow-hidden rounded-[6px] border border-border bg-secondary shadow-sm [&>div>svg]:block [&>div>svg]:h-auto [&>div>svg]:w-full"
                data-testid="share-card-preview"
              >
                <div
                  data-style={style}
                  // 内容由 lib/shareCard.ts / lib/shareMiniMap.ts 受控生成，所有用户文本已做 XML 转义
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
              <p className={`${PANEL_NOTE} text-center`}>
                预览按 1080 × 1440 比例缩放；字体使用系统字体栈，不同电脑上的字形可能略有差异。
              </p>

              <div
                className="grid min-w-0 gap-2 rounded-[6px] border border-border bg-card p-3"
                data-testid="share-minimap-block"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="m-0 text-sm font-semibold text-foreground">路线小地图（SVG）</p>
                  <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={includeMiniMap && miniMap.svg !== null}
                      disabled={miniMap.svg === null}
                      onChange={(event) => handleToggleMiniMap(event.target.checked)}
                      data-testid="share-minimap-toggle"
                    />
                    附加到分享卡尾部
                  </label>
                </div>
                {miniMap.svg !== null ? (
                  <div
                    className="[&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
                    data-testid="share-minimap-preview"
                    dangerouslySetInnerHTML={{ __html: miniMap.svg }}
                  />
                ) : (
                  <p className={PANEL_NOTE}>
                    本日没有可用坐标，无法绘制小地图；缺坐标站点会在离线路书里单列「位置未知」。
                  </p>
                )}
                {miniMap.unknownStops.length > 0 ? (
                  <p className={PANEL_NOTE} data-testid="share-minimap-unknown">
                    位置未知（未画入地图）：
                    {miniMap.unknownStops
                      .map((name) => (name.trim() === '' ? '未命名站点' : name.trim()))
                      .join('、')}
                  </p>
                ) : null}
                <p className={PANEL_NOTE}>
                  实线 = 导航路线；虚线 = 示意直线（不是导航结果）；不画线 = 路线未知。地图不使用任何瓦片或网络请求。
                </p>
              </div>
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
                  {activeTrip.days.map((day) => (
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

              <div className="grid min-w-0 gap-2 border-t border-border pt-3">
                <p className="m-0 text-sm font-semibold text-foreground">离线 HTML 路书</p>
                <p className={PANEL_NOTE}>
                  单文件 HTML：样式与脚本内联，断网可打开；先预览，确认后才下载，取消不产生文件。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      void handleRoadbookRequest()
                    }}
                    disabled={roadbookBusy}
                    aria-busy={roadbookBusy || undefined}
                  >
                    {roadbookBusy ? '正在准备离线路书…' : '下载离线路书 (.html)'}
                  </Button>
                </div>
                {roadbookError ? (
                  <p
                    className="m-0 rounded-[6px] border border-[color:var(--color-warn-ink)]/40 bg-[color:var(--color-warn-bg)] p-2.5 text-sm font-medium leading-relaxed text-[color:var(--color-warn-ink)] [overflow-wrap:anywhere]"
                    data-testid="roadbook-error"
                    role="alert"
                  >
                    {roadbookError}
                  </p>
                ) : null}
                {roadbookPreview ? (
                  <div className="grid min-w-0 gap-2" data-testid="roadbook-preview-block">
                    <p className={PANEL_NOTE}>
                      离线路书预览（{isDraftSource ? '草稿版' : '已应用行程'}）。确认后才下载；取消不产生任何文件。
                    </p>
                    <iframe
                      title="离线路书预览"
                      sandbox="allow-scripts"
                      srcDoc={roadbookPreview.html}
                      className="h-[360px] w-full rounded-[6px] border border-border bg-white"
                      data-testid="roadbook-preview"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        onClick={() => {
                          void handleRoadbookConfirm()
                        }}
                        disabled={roadbookBusy}
                      >
                        确认下载 .html
                      </Button>
                      <Button variant="ghost" onClick={() => setRoadbookPreview(null)}>
                        取消预览
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

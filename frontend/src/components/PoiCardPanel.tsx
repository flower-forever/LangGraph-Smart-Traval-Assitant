/**
 * P · 景点资料卡 · 手动编辑 + 收进预填面板（shadcn 组件构建；三期 S2/S3）。
 *
 * 边界（与三期计划 §2.2 / docs/POI_CARDS.md 对齐）：
 * - **显式保存才落盘**：编辑只在内存 state 里；点「保存资料卡」才把整条记录交给
 *   onSave（父级写 poiCards:v1）。取消 / 关闭零写入。
 * - **未保存编辑 reload 不复活**：本组件没有任何自动写盘路径；reload 后内存态
 *   自然消失，存储里只有上次显式保存过的内容。
 * - **不自动写其它键**：组件不 import 任何其它 storage 键，也不读 localStorage
 *   （读取由父级完成并经 props 传入）。
 * - 卡片构造 / 更新走 lib/poiCards 的纯函数（createPoiCard / updatePoiCard），
 *   面板不复制 identityKey / 校验口径。
 * - **S3 收进通道**：prefill 不为 null = 收进态（表单用预填初始化，用户可改）；
 *   不点来源面板的「收进」就不会构造 prefill、不会出现预填表单——没有任何
 *   自动收进路径。预填字段 provenance 由来源面板提供（tavily / osm）；
 *   用户补填的空字段标 manual。
 * - **图片 URL 收进**：「手动添加图片 URL」入口保存 source 按收进上下文标注
 *   （收进态用 prefill.imageSourceHint，默认 manual）；仅存 URL，不抓取图片。
 * - **S5 Wikimedia 图片搜索**：编辑内存态内的「搜索图片」子区。只有显式点
 *   「搜索图片」才发一次请求（挂载 / 改输入 / 换卡都不发）；每次点击最多一次
 *   上游请求，无隐式重试（失败后不自动重发，由用户再点）。结果网格逐张展示
 *   缩略图 + license + 作者署名；**缺署名（artist null）的结果不提供收进**
 *   （CC 协议要求保留署名）。逐张「收进」把图片加入编辑内存态 form.images
 *   （source='wikimedia'，保留 attribution/license），仍走本面板已有的
 *   「保存资料卡」显式保存才落盘——**不自动写任何键**。失败信封 7 态各配
 *   固定文案诚实展示（不回显上游 reason），失败保旧：旧结果与编辑内存态、
 *   存储字节都不受影响。
 * - 文案红线：无「已预订/已确认/已出票」；未知显示「未知」；所有内容默认
 *   「未核实」标注 + 来源；OSM 收进显示「来自协作地图，未核实」。
 * - **查看态可信徽章**：开放时间 / 门票复用 `stopFacts` 的单字段投影与
 *   `StopFactBadge`（与 StopPoiCard / TodayPanel 同一三态口径，不另造文案）。
 * - 图片仅存 URL；渲染懒加载（loading="lazy"）；加载失败 → 占位 + 「图片加载失败」，
 *   不阻断不编造。无坐标字段、无 (0,0)。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field'
import {
  MAX_POI_CARD_INTRO_LENGTH,
  MAX_POI_CARD_FIELD_LENGTH,
  MAX_POI_CARD_URL_LENGTH,
  MAX_POI_CARD_IMAGES,
  createPoiCard,
  updatePoiCard,
  poiCardsRecordBytes,
  type CardImageV1,
  type PoiCardFieldProvenanceV1,
  type PoiCardsRecordV1,
} from '../lib/poiCards'
import type { PoiCardPrefill } from '../lib/poiCardPrefill'
import {
  IMAGE_SOURCES_MAX_QUERY_CODEPOINTS,
  normalizeImageQuery,
  type ImageSearchItem,
  type ImageSearchReport,
} from '../lib/imageSources'
import { searchImageSources, type ImageSourcesAdapter } from '../lib/imageSourcesApi'
import { projectStopFactField } from '../lib/stopFacts'
import StopFactBadge from './StopFactBadge'
import type { ApiError } from '../lib/api'

/** 来源标签：与数据层 PoiCardImageSource 一一对应；展示用。 */
const SOURCE_LABEL: Record<CardImageV1['source'], string> = {
  manual: '手动粘贴',
  tavily: '网页资料',
  osm: '协作地图',
  wikimedia: 'Wikimedia',
}

/** 未保存编辑的内存形状：全部字符串，保存时统一 trim 并交给纯函数校验。 */
interface CardFormState {
  name: string
  intro: string
  openingHours: string
  ticket: string
  /** 表单内已确认要收进 / 保留的图片引用（仅 URL）。 */
  images: CardImageV1[]
}

function emptyForm(): CardFormState {
  return { name: '', intro: '', openingHours: '', ticket: '', images: [] }
}

function formFromCard(card: PoiCardV1 | null, prefill: PoiCardPrefill | null): CardFormState {
  if (card === null) {
    if (prefill === null) return emptyForm()
    return {
      name: prefill.name,
      intro: prefill.intro ?? '',
      openingHours: prefill.openingHours ?? '',
      ticket: prefill.ticket ?? '',
      images: prefill.images ? [...prefill.images] : [],
    }
  }
  return {
    name: card.name,
    intro: card.intro,
    openingHours: card.openingHours,
    ticket: card.ticket,
    images: [...card.images],
  }
}

type PoiCardV1 = PoiCardsRecordV1['cards'][number]

/** 展示 / 编辑共用：未知显示「未知」，不补 0。 */
function displayValue(value: string): string {
  const trimmed = value.trim()
  return trimmed.length === 0 ? '未知' : trimmed
}

function displayProvenance(
  provenance: PoiCardFieldProvenanceV1 | null,
): string | null {
  if (provenance === null) return null
  const at = new Date(provenance.recordedAt)
  const time = Number.isNaN(at.getTime()) ? '未知时间' : at.toLocaleString('zh-CN', { hour12: false })
  return `${SOURCE_LABEL[provenance.source]}${provenance.detail ? ` · ${provenance.detail}` : ''} · ${time}`
}

/** 单张图片：懒加载 + 失败占位，不阻断卡片其余内容。 */
function CardImageItem({ image }: { image: CardImageV1 }) {
  const [failed, setFailed] = useState(false)
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      {failed ? (
        <div
          role="img"
          aria-label="图片加载失败"
          className="flex h-24 w-full items-center justify-center rounded-[6px] border border-border bg-muted-surface text-xs text-muted-foreground"
        >
          图片加载失败
        </div>
      ) : (
        <img
          src={image.url}
          alt={image.caption ?? '资料卡图片'}
          loading="lazy"
          className="h-24 w-full rounded-[6px] border border-border object-cover"
          onError={() => setFailed(true)}
        />
      )}
      <figcaption className="text-xs text-muted-foreground">
        {image.caption ?? ''}
        {image.source !== 'manual' ? ` · 来源：${SOURCE_LABEL[image.source]}` : ''}
        {image.license ? ` · ${image.license}` : ''}
        {image.attribution ? ` · 作者：${image.attribution}` : ''}
      </figcaption>
    </figure>
  )
}

export interface PoiCardPanelProps {
  /** 父级读好的资料卡库记录；null = 未加载 / 不可用（面板只读提示，不假装为空）。 */
  record: PoiCardsRecordV1 | null
  /** 要查看 / 编辑的卡 id；null = 新建态。 */
  cardId: string | null
  /**
   * S3 收进预填（新建态专用）：不为 null 时表单用它初始化（用户可改），
   * 字段 provenance 用预填来源；cardId 非 null（编辑已有卡）时忽略。
   */
  prefill?: PoiCardPrefill | null
  /** 显式保存：把整条记录交给父级；父级写 poiCards:v1 并回报。 */
  onSave: (record: PoiCardsRecordV1) => void
  /** 保存状态（父级回传）；saving = 写入中。 */
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error'
  /** 保存结果消息（父级回传，含失败原因）。 */
  saveMessage?: string | null
  /** 关闭面板：取消编辑，零写入。 */
  onClose: () => void
  /** 新卡 id 工厂（新建态用）；测试可注入。 */
  createCardId?: () => string
  /** 当前时刻（epoch ms）；测试可注入，默认 Date.now。 */
  now?: () => number
  /**
   * S5 Wikimedia 图片搜索请求 adapter，默认走 imageSourcesApi.searchImageSources；
   * 测试注入 mock。每次调用只发一次请求，无重试。
   */
  requestImageSources?: ImageSourcesAdapter
}

/**
 * 资料卡编辑面板：查看 + 手动编辑。
 * 编辑态全部在内存；「保存资料卡」显式提交，取消 / 关闭丢弃且零写入。
 */
export default function PoiCardPanel({
  record,
  cardId,
  prefill = null,
  onSave,
  saveStatus = 'idle',
  saveMessage,
  onClose,
  createCardId = () =>
    `poi-card-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
  now = () => Date.now(),
  requestImageSources,
}: PoiCardPanelProps) {
  const baseId = useId()
  const current = record?.cards.find((card) => card.id === cardId) ?? null
  // 收进预填只在新建态生效；编辑已有卡时忽略（不覆盖已保存内容）。
  const effectivePrefill = current === null ? prefill : null
  const [form, setForm] = useState<CardFormState>(() => formFromCard(current, effectivePrefill))
  const [formError, setFormError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [imageUrl, setImageUrl] = useState('')
  const [imageError, setImageError] = useState<string | null>(null)

  // 换卡 / 外部记录变化时重置编辑态（丢弃未保存草稿；不写任何键）。
  useEffect(() => {
    setForm(formFromCard(current, effectivePrefill))
    setFormError(null)
    setImageError(null)
    setImageUrl('')
    setReloadKey((key) => key + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, record, effectivePrefill])

  const editable = record !== null
  const isEditingExisting = current !== null
  const introTooLong = form.intro.length > MAX_POI_CARD_INTRO_LENGTH
  const fieldTooLong =
    form.openingHours.length > MAX_POI_CARD_FIELD_LENGTH ||
    form.ticket.length > MAX_POI_CARD_FIELD_LENGTH
  const nameBlank = form.name.trim().length === 0
  const canSave = editable && !nameBlank && !introTooLong && !fieldTooLong

  const handleSave = () => {
    if (record === null) return
    const timestamp = now()
    if (isEditingExisting && current) {
      const updated = updatePoiCard(
        record,
        current.id,
        {
          name: form.name,
          intro: form.intro,
          openingHours: form.openingHours,
          ticket: form.ticket,
          images: form.images,
        },
        timestamp,
      )
      if (!updated.ok) {
        setFormError(updated.message)
        return
      }
      setFormError(null)
      onSave({
        format: updated.value.format,
        version: updated.value.version,
        cards: updated.value.cards,
        updatedAt: updated.value.updatedAt,
      })
      return
    }
    // 新建（手动或收进预填）：预填字段用来源 provenance（tavily / osm），
    // 用户补填的空字段标 manual；一切内容保存后仍默认「未核实」。
    const prefillProvenance = effectivePrefill?.provenance ?? null
    const manualProvenance = (): PoiCardFieldProvenanceV1 => ({
      source: 'manual',
      detail: '手工粘贴',
      recordedAt: timestamp,
    })
    const created = createPoiCard(
      {
        id: createCardId(),
        name: form.name,
        intro: form.intro,
        openingHours: form.openingHours,
        ticket: form.ticket,
        images: form.images,
        provenance: {
          intro:
            form.intro.trim().length > 0
              ? prefillProvenance?.intro ?? manualProvenance()
              : null,
          openingHours:
            form.openingHours.trim().length > 0
              ? prefillProvenance?.openingHours ?? manualProvenance()
              : null,
          ticket:
            form.ticket.trim().length > 0
              ? prefillProvenance?.ticket ?? manualProvenance()
              : null,
        },
      },
      timestamp,
    )
    if (!created.ok) {
      setFormError(created.message)
      return
    }
    const next = {
      format: record.format,
      version: record.version,
      cards: [...record.cards, created.value],
      updatedAt: timestamp,
    }
    const bytes = poiCardsRecordBytes(next)
    if (bytes === null) {
      setFormError('资料卡无法序列化；没有保存。')
      return
    }
    setFormError(null)
    onSave(next)
  }

  /** 表单内添加图片 URL：仅存 URL 引用；来源按收进上下文标注（tavily 收进时
   *  attribution 标页面来源），手动新建 / 编辑标 manual。零网络调用。 */
  const handleAddImageUrl = () => {
    const trimmed = imageUrl.trim()
    setImageError(null)
    if (trimmed.length === 0) {
      setImageError('请先粘贴图片 URL；不自动抓取任何图片。')
      return
    }
    if (trimmed.length > MAX_POI_CARD_URL_LENGTH) {
      setImageError(`图片 URL 最多 ${MAX_POI_CARD_URL_LENGTH} 个字符。`)
      return
    }
    if (!/^(https?:\/\/|\/)/i.test(trimmed)) {
      setImageError('图片 URL 必须以 http(s):// 或 / 开头。')
      return
    }
    if (form.images.some((image) => image.url === trimmed)) {
      setImageError('同一张图片 URL 已在表单里；没有重复添加。')
      return
    }
    if (form.images.length >= MAX_POI_CARD_IMAGES) {
      setImageError(`一张资料卡最多 ${MAX_POI_CARD_IMAGES} 张图片。`)
      return
    }
    const timestamp = now()
    const source = effectivePrefill?.imageSourceHint ?? 'manual'
    const attribution = source === 'manual' ? null : (effectivePrefill?.imageAttributionHint ?? null)
    setForm((state) => ({
      ...state,
      images: [
        ...state.images,
        {
          url: trimmed,
          caption: null,
          source,
          attribution,
          license: null,
          addedAt: timestamp,
        },
      ],
    }))
    setImageUrl('')
  }

  const provenance = current?.provenance ?? null
  // 查看态：开放时间 / 门票各带可信徽章（与停点卡同一投影口径；现在时刻由 now 注入）。
  const openingFact =
    current === null ? null : projectStopFactField(current.openingHours, current.provenance.openingHours, now())
  const ticketFact =
    current === null ? null : projectStopFactField(current.ticket, current.provenance.ticket, now())

  /** S5 Wikimedia 搜索结果「收进」：只改编辑内存态，不落盘、不写任何键。 */
  const handleCollectWikimediaImage = (item: ImageSearchItem) => {
    if (record === null) return
    const url = item.thumbUrl
    if (
      url.length > MAX_POI_CARD_URL_LENGTH ||
      form.images.some((image) => image.url === url) ||
      form.images.length >= MAX_POI_CARD_IMAGES
    ) {
      return
    }
    setForm((state) => ({
      ...state,
      images: [
        ...state.images,
        {
          url,
          caption: null,
          source: 'wikimedia',
          attribution: item.artist,
          license: item.license,
          addedAt: now(),
        },
      ],
    }))
  }

  return (
    <Card role="region" aria-label="景点资料卡">
      <CardHeader>
        <CardDescription>景点资料卡 · 手动整理，默认「未核实」，永不自动写入行程或费用</CardDescription>
        <CardTitle>
          {isEditingExisting
            ? current.name
            : effectivePrefill !== null
              ? form.name.trim().length > 0
                ? `收进：${form.name}`
                : '收进新资料卡'
              : '新建资料卡'}
        </CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">未核实</Badge>
          {isEditingExisting ? (
            <Badge variant="secondary">
              已保存内容 · 更新于 {new Date(current.updatedAt).toLocaleString('zh-CN', { hour12: false })}
            </Badge>
          ) : effectivePrefill !== null ? (
            <Badge variant="secondary">收进预填 · 确认保存才写入本地</Badge>
          ) : (
            <Badge variant="secondary">尚未保存 · 显式保存才写入本地</Badge>
          )}
        </div>
      </CardHeader>

      {record === null ? (
        <CardContent>
          <p role="note" className="text-sm text-muted-foreground">
            资料卡库尚未加载或不可用；本面板不会读取本地键，也不会假装为空库。
          </p>
        </CardContent>
      ) : (
        <>
          <CardContent className="flex flex-col gap-4">
            {isEditingExisting ? (
              <div className="flex flex-col gap-2" data-testid="poi-card-view">
                <div className="grid grid-cols-[8rem_1fr] items-baseline gap-x-3 gap-y-1 text-sm">
                  <span className="text-xs text-muted-foreground">介绍</span>
                  <span>{displayValue(current.intro)}</span>
                  <span className="text-xs text-muted-foreground">开放时间</span>
                  <span className="flex flex-wrap items-center gap-2">
                    {displayValue(current.openingHours)}
                    {openingFact !== null && (
                      <StopFactBadge fact={openingFact} detailLabel={`开放时间来源：${current.name}`} />
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">门票</span>
                  <span className="flex flex-wrap items-center gap-2">
                    {displayValue(current.ticket)}
                    {ticketFact !== null && (
                      <StopFactBadge fact={ticketFact} detailLabel={`门票来源：${current.name}`} />
                    )}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  来源：{provenance?.intro ? displayProvenance(provenance.intro) : '未知'}
                  {provenance?.openingHours ? `；开放时间 ${displayProvenance(provenance.openingHours)}` : ''}
                  {provenance?.ticket ? `；门票 ${displayProvenance(provenance.ticket)}` : ''}
                </p>
                {current.images.length > 0 ? (
                  <div className="flex flex-wrap gap-3" data-testid="poi-card-images">
                    {current.images.map((image) => (
                      <CardImageItem key={image.url} image={image} />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">暂无图片。</p>
                )}
              </div>
            ) : null}

            <div className="flex flex-col gap-4" data-testid="poi-card-edit">
              {effectivePrefill?.collectNotice ? (
                <p role="note" className="text-sm text-muted-foreground" data-testid="poi-card-collect-notice">
                  {effectivePrefill.collectNotice}
                </p>
              ) : null}
              <Field>
                <FieldLabel htmlFor={`${baseId}-name`}>名称</FieldLabel>
                <Input
                  id={`${baseId}-name`}
                  key={`name-${reloadKey}`}
                  value={form.name}
                  onChange={(event) => setForm((state) => ({ ...state, name: event.target.value }))}
                  disabled={!editable}
                  aria-invalid={nameBlank || undefined}
                />
                {nameBlank ? <FieldError>名称不能为空。</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel htmlFor={`${baseId}-intro`}>介绍（≤{MAX_POI_CARD_INTRO_LENGTH} 字）</FieldLabel>
                <Textarea
                  id={`${baseId}-intro`}
                  key={`intro-${reloadKey}`}
                  value={form.intro}
                  onChange={(event) => setForm((state) => ({ ...state, intro: event.target.value }))}
                  disabled={!editable}
                  aria-invalid={introTooLong || undefined}
                  rows={5}
                />
                <FieldDescription>
                  {form.intro.length}/{MAX_POI_CARD_INTRO_LENGTH} 字 · 默认标「未核实」，请自行核对
                </FieldDescription>
                {introTooLong ? (
                  <FieldError>介绍超过 {MAX_POI_CARD_INTRO_LENGTH} 字，请精简后再保存。</FieldError>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor={`${baseId}-hours`}>开放时间</FieldLabel>
                <Input
                  id={`${baseId}-hours`}
                  key={`hours-${reloadKey}`}
                  value={form.openingHours}
                  onChange={(event) => setForm((state) => ({ ...state, openingHours: event.target.value }))}
                  disabled={!editable}
                  aria-invalid={form.openingHours.length > MAX_POI_CARD_FIELD_LENGTH || undefined}
                />
                <FieldDescription>留空显示「未知」；不自动查询、不编造。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${baseId}-ticket`}>门票</FieldLabel>
                <Input
                  id={`${baseId}-ticket`}
                  key={`ticket-${reloadKey}`}
                  value={form.ticket}
                  onChange={(event) => setForm((state) => ({ ...state, ticket: event.target.value }))}
                  disabled={!editable}
                  aria-invalid={form.ticket.length > MAX_POI_CARD_FIELD_LENGTH || undefined}
                />
                <FieldDescription>留空显示「未知」；金额不自动换算。</FieldDescription>
              </Field>

              <div className="flex flex-col gap-2" data-testid="poi-card-image-edit">
                <FieldLabel htmlFor={`${baseId}-image-url`}>图片（仅存 URL，最多 {MAX_POI_CARD_IMAGES} 张）</FieldLabel>
                {form.images.length > 0 ? (
                  <ul className="flex flex-col gap-1" data-testid="poi-card-image-list">
                    {form.images.map((image) => (
                      <li key={image.url} className="flex items-center justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate" title={image.url}>
                          {image.url}
                          {image.source !== 'manual'
                            ? ` · 来源：${SOURCE_LABEL[image.source]}${image.attribution ? ` · ${image.attribution}` : ''}${image.license ? ` · ${image.license}` : ''}`
                            : ''}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setForm((state) => ({
                              ...state,
                              images: state.images.filter((item) => item.url !== image.url),
                            }))
                          }
                          aria-label={`移除图片 ${image.url}`}
                        >
                          移除
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">暂无图片。</p>
                )}
                <div className="flex items-start gap-2">
                  <Input
                    id={`${baseId}-image-url`}
                    key={`image-url-${reloadKey}`}
                    value={imageUrl}
                    onChange={(event) => setImageUrl(event.target.value)}
                    disabled={!editable}
                    placeholder="https://…（仅存 URL 引用）"
                    aria-label="图片 URL"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleAddImageUrl}
                    disabled={!editable || saveStatus === 'saving'}
                    aria-label="添加图片 URL"
                  >
                    添加图片
                  </Button>
                </div>
                <FieldDescription>
                  手动粘贴的图片标「手动粘贴」来源；不抓取、不转存，加载失败会显示占位提示。
                </FieldDescription>
                {imageError ? <FieldError role="alert">{imageError}</FieldError> : null}

                {editable ? (
                  <WikimediaImageSearch
                    baseId={`${baseId}-img-search`}
                    initialQuery={form.name}
                    requestImageSources={requestImageSources}
                    onCollect={handleCollectWikimediaImage}
                    collectedUrls={form.images.map((image) => image.url)}
                  />
                ) : null}
              </div>

              {formError ? <FieldError role="alert">{formError}</FieldError> : null}
            </div>
          </CardContent>
          <CardFooter>
            <Button
              variant="default"
              onClick={handleSave}
              disabled={!canSave || saveStatus === 'saving'}
              aria-label="保存资料卡"
            >
              {saveStatus === 'saving' ? '保存中…' : '保存资料卡'}
            </Button>
            <Button
              variant="outline"
              onClick={onClose}
              aria-label={effectivePrefill !== null ? '不采纳，关闭资料卡' : '取消编辑资料卡'}
            >
              {effectivePrefill !== null ? '不采纳，关闭' : '取消'}
            </Button>
            {saveMessage ? (
              <p role="status" className="text-xs text-muted-foreground">
                {saveMessage}
              </p>
            ) : null}
          </CardFooter>
        </>
      )}
    </Card>
  )
}

export { SOURCE_LABEL, displayValue }

/* ───────── S5 · Wikimedia 图片搜索（编辑内存态内子区） ───────── */

/** 传输层失败文案全部用前端固定句，不复述 provider / 后端 reason / 异常文本。 */
const IMAGE_SEARCH_ERROR_TEXT = {
  bad_payload: '返回的图片搜索结果没有通过完整性检查，本次结果没有展示。已编辑内容不受影响。',
  timeout: '等待图片搜索服务响应超时。这次没有拿到新结果，可以重新点「搜索图片」再试一次。',
  network: '连不上后端服务，本次没有拿到图片搜索结果。请确认后端已启动后再试。',
  server: '图片搜索请求失败，这次没有拿到结果，可以稍后再试。',
  abort: '已停止等待这次图片搜索，本次结果不展示。',
} as const

/**
 * 七种业务状态的固定文案（信封 reason 一律不回显；诚实展示，无兜底编造）。
 * no_candidates 如实说明「上游没有返回可用条目」，不代表地点不存在。
 */
const IMAGE_SEARCH_STATUS_TEXT: Record<ImageSearchReport['status'], string> = {
  available: '找到可用图片。',
  no_candidates:
    '本次查询没有拿到可展示的图片条目。这只说明本次查询条件下没有可用结果，不代表该地点不存在。',
  invalid_request: '这次查询内容没有被服务接受，请修改查询后重试。',
  timeout: '图片搜索服务这次等待超时，没有拿到结果。可以稍后再试。',
  rate_limited: '图片搜索请求过于频繁，这次没有拿到结果。可以稍后再试。',
  unavailable: '图片搜索服务暂时不可用，这次没有拿到结果。可以稍后再试。',
  failed: '图片搜索响应异常，这次没有拿到结果。可以稍后再试。',
}

const IMAGE_SEARCH_UNVERIFIED_TEXT =
  '以下结果来自 Wikimedia Commons，未核实：图片内容、署名与许可是检索时刻的上游展示，' +
  '不代表已核验图片权利状态。署名与许可按上游原样保留，缺署名的条目不提供收进' +
  '（CC 协议要求保留署名）。'

function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && (err as { kind?: unknown }).kind !== undefined
}

function errorTextForApi(err: ApiError): string {
  switch (err.kind) {
    case 'timeout':
      return IMAGE_SEARCH_ERROR_TEXT.timeout
    case 'abort':
      return IMAGE_SEARCH_ERROR_TEXT.abort
    case 'server':
      return IMAGE_SEARCH_ERROR_TEXT.server
    case 'network':
      return IMAGE_SEARCH_ERROR_TEXT.network
    case 'bad_payload':
      return IMAGE_SEARCH_ERROR_TEXT.bad_payload
  }
}

/** 搜索结果的一条：缩略图 + license + 署名；缺署名不提供收进。 */
function ImageSearchResultItem({
  item,
  collected,
  canCollect,
  onCollect,
}: {
  item: ImageSearchItem
  /** 该条 thumbUrl 已在编辑内存态里（去重展示用）。 */
  collected: boolean
  /** 表单还能收进（未满 8 张）；false 时本条不提供收进按钮。 */
  canCollect: boolean
  onCollect: (item: ImageSearchItem) => void
}) {
  const [failed, setFailed] = useState(false)
  const hasArtist = typeof item.artist === 'string' && item.artist.trim().length > 0
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-[6px] border border-border p-2" data-testid="poi-card-image-result">
      {failed ? (
        <div
          role="img"
          aria-label="缩略图加载失败"
          className="flex h-24 w-full items-center justify-center rounded-[6px] border border-border bg-muted-surface text-xs text-muted-foreground"
        >
          缩略图加载失败
        </div>
      ) : (
        <img
          src={item.thumbUrl}
          alt={item.title ?? 'Commons 图片'}
          loading="lazy"
          className="h-24 w-full rounded-[6px] border border-border object-cover"
          onError={() => setFailed(true)}
        />
      )}
      <p className="min-w-0 truncate text-xs" title={item.title ?? '（来源未提供标题）'}>
        {item.title ?? '（来源未提供标题）'}
      </p>
      <p className="text-xs text-muted-foreground">
        许可：{item.license ?? '未知'}
        {' · '}
        作者：{item.artist ?? '未知'}
      </p>
      {hasArtist ? (
        collected || !canCollect ? (
          <Badge variant="secondary">
            {collected ? '已收进表单' : '图片已满，先移除后才能收进'}
          </Badge>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onCollect(item)}
            aria-label={`收进图片 ${item.title ?? item.thumbUrl}`}
          >
            收进
          </Button>
        )
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="poi-card-image-no-artist">
          缺作者署名，不提供收进（CC 协议要求保留署名）。
        </p>
      )}
    </li>
  )
}

/**
 * Wikimedia 图片搜索子区（S5）：
 * - 只有显式点「搜索图片」才发起一次请求；挂载、改输入、换卡、收进都不发。
 * - 每次点击最多一次上游请求；失败不自动重发（无隐式重试）。
 * - 查询输入带卡名预填（可改）；发送前按与后端同口径规范化，1..100 码点。
 * - 结果与错误只存本子区内存；失败保旧：旧结果清空展示新错误，但编辑内存态
 *   （form.images）与存储字节不受影响。
 * - 收进只改父级编辑内存态（onCollect），落盘仍走「保存资料卡」显式保存。
 */
function WikimediaImageSearch({
  baseId,
  initialQuery,
  requestImageSources,
  onCollect,
  collectedUrls,
}: {
  baseId: string
  /** 卡名预填（可改）；只在子区首次挂载时取一次，之后不跟随表单改名。 */
  initialQuery: string
  requestImageSources?: ImageSourcesAdapter
  onCollect: (item: ImageSearchItem) => void
  /** 父级编辑内存态已有的图片 URL（收进去重 + 已收进标记）。 */
  collectedUrls: string[]
}) {
  const [rawQuery, setRawQuery] = useState(initialQuery)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<ImageSearchReport | null>(null)
  /** 每次点击的序号：迟到响应 / 失败后不再触发任何自动请求（无隐式重试）。 */
  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      // 卸载只做资源清理：取消在途请求，不写任何东西。
      seqRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const queryReady = normalizeImageQuery(rawQuery) !== null

  async function handleSearch() {
    if (pending || !queryReady) return
    const raw = rawQuery
    const seq = seqRef.current + 1
    seqRef.current = seq
    const controller = new AbortController()
    abortRef.current = controller
    setPending(true)
    setError(null)
    setReport(null)

    const search = requestImageSources ?? searchImageSources
    try {
      const response = await search(raw, { signal: controller.signal })
      if (seqRef.current !== seq || controller.signal.aborted) return
      setReport(response)
    } catch (err) {
      if (seqRef.current !== seq || controller.signal.aborted) return
      setError(isApiError(err) ? errorTextForApi(err) : IMAGE_SEARCH_ERROR_TEXT.network)
    } finally {
      if (seqRef.current === seq) {
        setPending(false)
        if (abortRef.current === controller) abortRef.current = null
      }
    }
  }

  const collectedSet = new Set(collectedUrls)
  const canCollect = collectedUrls.length < MAX_POI_CARD_IMAGES
  const items = report?.items ?? []

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-muted-surface p-3" data-testid="poi-card-image-search">
      <FieldLabel htmlFor={`${baseId}-query`}>搜索 Wikimedia 图片（显式触发）</FieldLabel>
      <div className="flex items-start gap-2">
        <Input
          id={`${baseId}-query`}
          value={rawQuery}
          onChange={(event) => setRawQuery(event.target.value)}
          placeholder="用景点名或关键词搜索 Commons 图片"
          aria-label="Wikimedia 图片搜索内容"
          maxLength={IMAGE_SOURCES_MAX_QUERY_CODEPOINTS * 2}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void handleSearch()
          }}
          disabled={pending || !queryReady}
          aria-label="搜索图片"
        >
          {pending ? '搜索中…' : '搜索图片'}
        </Button>
      </div>
      <FieldDescription>
        只有点「搜索图片」才请求一次；不会自动搜索，也不会自动重试。查询内容默认预填卡名，可改。
      </FieldDescription>

      {pending ? (
        <p role="status" className="text-xs text-muted-foreground" data-testid="poi-card-image-search-pending">
          正在等待图片搜索服务响应。可以停止等待：这只结束本页的等待，不保证后端或上游停止处理。
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="poi-card-image-search-error">
          {error}
        </p>
      ) : null}

      {report !== null && !pending ? (
        <div data-testid="poi-card-image-search-result" data-status={report.status}>
          <p role="note" className="text-xs text-muted-foreground">
            {IMAGE_SEARCH_UNVERIFIED_TEXT}
          </p>
          {report.status === 'available' ? (
            <>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
                {items.map((item, index) => (
                  <ImageSearchResultItem
                    key={`${item.thumbUrl}-${index}`}
                    item={item}
                    collected={collectedSet.has(item.thumbUrl)}
                    canCollect={canCollect}
                    onCollect={onCollect}
                  />
                ))}
              </ul>
              {report.notes.length > 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="poi-card-image-search-notes">
                  来源处理说明：{report.notes.join('；')}
                </p>
              ) : null}
            </>
          ) : (
            <p role="status" className="text-xs text-muted-foreground" data-testid="poi-card-image-search-status">
              {IMAGE_SEARCH_STATUS_TEXT[report.status]}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

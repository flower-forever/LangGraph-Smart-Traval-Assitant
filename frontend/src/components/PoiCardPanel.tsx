/**
 * P · 景点资料卡 · 手动编辑面板（shadcn 组件构建；三期 S2）。
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
 * - 文案红线：无「已预订/已确认/已出票」；未知显示「未知」；所有内容默认
 *   「未核实」标注 + 来源。
 * - 图片仅存 URL；渲染懒加载（loading="lazy"）；加载失败 → 占位 + 「图片加载失败」，
 *   不阻断不编造。无坐标字段、无 (0,0)。
 */
import { useEffect, useId, useState } from 'react'
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
  createPoiCard,
  updatePoiCard,
  poiCardsRecordBytes,
  type CardImageV1,
  type PoiCardFieldProvenanceV1,
  type PoiCardsRecordV1,
} from '../lib/poiCards'

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
}

function emptyForm(): CardFormState {
  return { name: '', intro: '', openingHours: '', ticket: '' }
}

function formFromCard(card: PoiCardV1 | null): CardFormState {
  if (card === null) return emptyForm()
  return {
    name: card.name,
    intro: card.intro,
    openingHours: card.openingHours,
    ticket: card.ticket,
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
}

/**
 * 资料卡编辑面板：查看 + 手动编辑。
 * 编辑态全部在内存；「保存资料卡」显式提交，取消 / 关闭丢弃且零写入。
 */
export default function PoiCardPanel({
  record,
  cardId,
  onSave,
  saveStatus = 'idle',
  saveMessage,
  onClose,
  createCardId = () =>
    `poi-card-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
  now = () => Date.now(),
}: PoiCardPanelProps) {
  const baseId = useId()
  const current = record?.cards.find((card) => card.id === cardId) ?? null
  const [form, setForm] = useState<CardFormState>(() => formFromCard(current))
  const [formError, setFormError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // 换卡 / 外部记录变化时重置编辑态（丢弃未保存草稿；不写任何键）。
  useEffect(() => {
    setForm(formFromCard(current))
    setFormError(null)
    setReloadKey((key) => key + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId, record])

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
    const created = createPoiCard(
      {
        id: createCardId(),
        name: form.name,
        intro: form.intro,
        openingHours: form.openingHours,
        ticket: form.ticket,
        provenance: {
          intro: form.intro.trim().length > 0 ? { source: 'manual', detail: '手工粘贴', recordedAt: timestamp } : null,
          openingHours:
            form.openingHours.trim().length > 0
              ? { source: 'manual', detail: '手工粘贴', recordedAt: timestamp }
              : null,
          ticket: form.ticket.trim().length > 0 ? { source: 'manual', detail: '手工粘贴', recordedAt: timestamp } : null,
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

  const provenance = current?.provenance ?? null

  return (
    <Card role="region" aria-label="景点资料卡">
      <CardHeader>
        <CardDescription>景点资料卡 · 手动整理，默认「未核实」，永不自动写入行程或费用</CardDescription>
        <CardTitle>{isEditingExisting ? current.name : '新建资料卡'}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">未核实</Badge>
          {isEditingExisting ? (
            <Badge variant="secondary">
              已保存内容 · 更新于 {new Date(current.updatedAt).toLocaleString('zh-CN', { hour12: false })}
            </Badge>
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
                  <span>{displayValue(current.openingHours)}</span>
                  <span className="text-xs text-muted-foreground">门票</span>
                  <span>{displayValue(current.ticket)}</span>
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
            <Button variant="outline" onClick={onClose} aria-label="取消编辑资料卡">
              取消
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

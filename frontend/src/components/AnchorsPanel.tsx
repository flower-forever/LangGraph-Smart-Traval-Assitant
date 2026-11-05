/**
 * F1 · 住宿与抵离锚点面板（受控可集成，尚未接入 App）。
 *
 * 边界：
 * - 只在本地表单 / 预览里工作；不写 localStorage、不改 App、不发网络请求。
 * - 点「预览提案」只生成 proposal；点「应用提案」才把 proposal 交给父级回调。
 * - 父级负责用 `applyAnchorsProposal` + 自己的 storage owner 完成显式保存。
 * - 面板不把锚点标成「已在行程」：链接已有 stop / 将新增独立 occurrence /
 *   仅参考三种状态分开显示。
 */
import { useEffect, useId, useMemo, useState } from 'react'

import type { TripDay, TripStop, TravelMode } from '../lib/api'
import {
  anchorsToForm,
  buildAnchorsFromForm,
  createAnchorsProposal,
  emptyAccommodationForm,
  emptyDayAnchorForm,
  emptyTransportAnchorForm,
  type AnchorsForm,
  type AnchorsIdFactory,
  type AnchorsProposal,
  type DayAnchorForm,
  type TransportAnchorForm,
} from '../lib/anchors'
import type { WorkspaceRecordV1 } from '../lib/workspaceTypes'
import { createLogicalId } from '../lib/workspace'
import './AnchorsPanel.css'

export type AnchorsPanelApplyResult = { ok: true } | { ok: false; message: string }

export interface AnchorsPanelProps {
  /** 完整工作区记录：面板从 sidecar.anchors 读，绝不自己写回去。 */
  record: WorkspaceRecordV1
  /** 组件级单调 epoch；任何 owner / base 变化由父级推进。 */
  epoch: number
  /** 新增酒店 occurrence 时新 leg 的显式出行方式；不猜。 */
  newLegMode: TravelMode
  /** 显式应用回调。返回失败时面板保留表单与预览，原记录不变。 */
  onApply: (proposal: AnchorsProposal) => AnchorsPanelApplyResult | void
  onClose?: () => void
  /** 测试 / 上层统一撤销用；缺省使用契约的 createLogicalId。 */
  createId?: AnchorsIdFactory
}

function defaultCreateId(kind: 'hotel' | 'anchor' | 'stop'): string {
  void kind
  return createLogicalId()
}

function formKeyOf(form: AnchorsForm): string {
  return JSON.stringify(form)
}

const COORDINATE_HINT =
  '坐标留空 = 未知；0 是有效坐标值。不会 geocode，也不会把未知补成 (0, 0)。'

export default function AnchorsPanel({
  record,
  epoch,
  newLegMode,
  onApply,
  onClose,
  createId = defaultCreateId,
}: AnchorsPanelProps) {
  const [form, setForm] = useState<AnchorsForm>(() => anchorsToForm(record.sidecar.anchors))
  const [preview, setPreview] = useState<AnchorsProposal | null>(null)
  const [previewSignature, setPreviewSignature] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const recordKey =
    `${record.workspaceId}\u0000${record.ownerId}\u0000${record.tripId}\u0000${record.workspaceRevision}`
  useEffect(() => {
    setForm(anchorsToForm(record.sidecar.anchors))
    setPreview(null)
    setPreviewSignature(null)
    setError(null)
    setStatus(null)
  }, [recordKey])

  const formKey = useMemo(() => formKeyOf(form), [form])
  useEffect(() => {
    if (preview !== null && previewSignature !== formKey) {
      setPreview(null)
      setPreviewSignature(null)
    }
  }, [formKey, preview, previewSignature])

  const currentPreview = preview !== null && previewSignature === formKey ? preview : null
  const stay = form.accommodation

  function ensureStayHotelId(): string | null {
    if (stay === null) return null
    if (stay.hotelId !== null) return stay.hotelId
    const hotelId = createId('hotel')
    setForm((current) =>
      current.accommodation === null || current.accommodation.hotelId !== null
        ? current
        : { ...current, accommodation: { ...current.accommodation, hotelId } },
    )
    return hotelId
  }

  function updateAccommodation(patch: Partial<ReturnType<typeof emptyAccommodationForm>>): void {
    setForm((current) => ({
      ...current,
      accommodation: { ...(current.accommodation ?? emptyAccommodationForm()), ...patch },
    }))
    setError(null)
    setStatus(null)
  }

  function removeAccommodation(): void {
    setForm((current) => {
      const daily: AnchorsForm['daily'] = {}
      for (const key of Object.keys(current.daily)) {
        const entry = current.daily[key]
        const clear = (anchor: DayAnchorForm | null): DayAnchorForm | null =>
          anchor === null ? null : { ...anchor, hotelId: '' }
        daily[key] = { start: clear(entry.start), end: clear(entry.end) }
      }
      return { ...current, accommodation: null, daily }
    })
    setError(null)
    setStatus(null)
  }

  function setDayAnchor(dayNumber: number, position: 'start' | 'end', anchor: DayAnchorForm | null): void {
    setForm((current) => {
      const key = String(dayNumber)
      const entry = current.daily[key] ?? { start: null, end: null }
      return {
        ...current,
        daily: { ...current.daily, [key]: { ...entry, [position]: anchor } },
      }
    })
    setError(null)
    setStatus(null)
  }

  function updateDayAnchor(dayNumber: number, position: 'start' | 'end', patch: Partial<DayAnchorForm>): void {
    setForm((current) => {
      const key = String(dayNumber)
      const entry = current.daily[key] ?? { start: null, end: null }
      const existing = entry[position] ?? emptyDayAnchorForm()
      return {
        ...current,
        daily: { ...current.daily, [key]: { ...entry, [position]: { ...existing, ...patch } } },
      }
    })
    setError(null)
    setStatus(null)
  }

  function fillFromAccommodation(dayNumber: number, position: 'start' | 'end'): void {
    if (stay === null) return
    const hotelId = ensureStayHotelId()
    if (hotelId === null) return
    updateDayAnchor(dayNumber, position, {
      kind: 'manual',
      stopId: '',
      hotelId,
      name: stay.name,
      address: stay.address,
      lng: stay.lng,
      lat: stay.lat,
    })
  }

  function associateAccommodation(dayNumber: number, position: 'start' | 'end', checked: boolean): void {
    if (!checked) {
      updateDayAnchor(dayNumber, position, { hotelId: '' })
      return
    }
    const hotelId = ensureStayHotelId()
    if (hotelId === null) return
    updateDayAnchor(dayNumber, position, { hotelId })
  }

  function useStop(dayNumber: number, position: 'start' | 'end', day: TripDay, stopId: string): void {
    const stop: TripStop | undefined = day.stops.find((item) => item.id === stopId)
    if (!stop) return
    updateDayAnchor(dayNumber, position, {
      kind: 'stop',
      stopId: stop.id,
      hotelId: '',
      name: stop.name,
      address: stop.address,
      lng: stop.location === null ? '' : String(stop.location.lng),
      lat: stop.location === null ? '' : String(stop.location.lat),
      date: day.date ?? '',
    })
  }

  function handlePreview(): void {
    const anchorsResult = buildAnchorsFromForm(form, createId)
    if (!anchorsResult.ok) {
      setPreview(null)
      setPreviewSignature(null)
      setError(anchorsResult.message)
      setStatus(null)
      return
    }
    const proposalResult = createAnchorsProposal({
      record,
      epoch,
      anchors: anchorsResult.value,
      newLegMode,
      createStopId: () => createId('stop'),
    })
    if (!proposalResult.ok) {
      setPreview(null)
      setPreviewSignature(null)
      setError(proposalResult.message)
      setStatus(null)
      return
    }
    setPreview(proposalResult.value)
    setPreviewSignature(formKey)
    setError(null)
    setStatus('预览已生成，尚未应用；当前工作区与行程没有改变。')
  }

  function handleApply(): void {
    if (currentPreview === null) {
      setError('请先生成预览，再显式应用提案。')
      return
    }
    setError(null)
    const result = onApply(currentPreview)
    if (result !== undefined && !result.ok) {
      setError(result.message)
      setStatus(null)
      return
    }
    setStatus('提案已交给父级处理；只有父级完成显式保存后才会更新工作区。')
  }

  function handleCancelPreview(): void {
    setPreview(null)
    setPreviewSignature(null)
    setError(null)
    setStatus('预览已取消；当前工作区与已应用行程没有改变。')
  }

  function handleReset(): void {
    setForm(anchorsToForm(record.sidecar.anchors))
    setPreview(null)
    setPreviewSignature(null)
    setError(null)
    setStatus('已放弃未应用的修改，恢复为当前工作区里的锚点。')
  }

  return (
    <section className="anchors-panel" aria-label="住宿与抵离锚点" data-testid="anchors-panel">
      <div className="anchors-head">
        <div className="anchors-head-main">
          <p className="anchors-eyebrow">F1 · 住宿与抵离</p>
          <h3 className="anchors-title">住宿与抵离锚点</h3>
          <p className="anchors-meta">
            {record.trip.title}
            <span className="anchors-tag">未接入 App · 受控面板</span>
          </p>
        </div>
        {onClose ? (
          <button type="button" className="anchors-btn" onClick={onClose}>
            收起
          </button>
        ) : null}
      </div>

      <p className="anchors-note">
        这里只记录你填写的住宿与每日起终 / 抵离参考。预览不会改行程；点「应用提案」后才交给父级，
        由父级通过工作区 transition 显式保存。酒店信息来自你的填写，不代表酒店会为你保留房间。
      </p>

      <fieldset className="anchors-section">
        <legend>住宿（手工填写）</legend>
        {stay === null ? (
          <button
            type="button"
            className="anchors-btn"
            onClick={() => {
              setForm((current) => ({
                ...current,
                accommodation: { ...emptyAccommodationForm(), hotelId: createId('hotel') },
              }))
              setError(null)
              setStatus(null)
            }}
          >
            添加住宿信息
          </button>
        ) : (
          <div className="anchors-grid">
            <label className="anchors-field">
              <span>住宿名称</span>
              <input
                value={stay.name}
                onChange={(event) => updateAccommodation({ name: event.target.value })}
                placeholder="例如：中央酒店（你填写的名称）"
              />
            </label>
            <label className="anchors-field">
              <span>地址</span>
              <input
                value={stay.address}
                onChange={(event) => updateAccommodation({ address: event.target.value })}
                placeholder="可留空"
              />
            </label>
            <label className="anchors-field">
              <span>经度（WGS84）</span>
              <input
                value={stay.lng}
                onChange={(event) => updateAccommodation({ lng: event.target.value })}
                placeholder="留空 = 未知"
                inputMode="decimal"
              />
            </label>
            <label className="anchors-field">
              <span>纬度（WGS84）</span>
              <input
                value={stay.lat}
                onChange={(event) => updateAccommodation({ lat: event.target.value })}
                placeholder="留空 = 未知"
                inputMode="decimal"
              />
            </label>
            <label className="anchors-field">
              <span>入住日期（当地）</span>
              <input
                value={stay.checkInDate}
                onChange={(event) => updateAccommodation({ checkInDate: event.target.value })}
                placeholder="YYYY-MM-DD"
              />
            </label>
            <label className="anchors-field">
              <span>退房日期（当地）</span>
              <input
                value={stay.checkOutDate}
                onChange={(event) => updateAccommodation({ checkOutDate: event.target.value })}
                placeholder="YYYY-MM-DD"
              />
            </label>
            <p className="anchors-hint anchors-grid-full">{COORDINATE_HINT}</p>
            <div className="anchors-grid-full">
              <button type="button" className="anchors-btn" onClick={removeAccommodation}>
                移除住宿信息
              </button>
            </div>
          </div>
        )}
      </fieldset>

      <fieldset className="anchors-section">
        <legend>每日起点 / 终点</legend>
        <p className="anchors-hint">
          引用已有站点只 link，不复制、不改原 id；手工地点若关联住宿，应用后会生成独立酒店停靠 id。
          同一酒店做起点和终点会得到两个不同 stop id，跨天也不会复用。
        </p>
        {record.trip.days.map((day) => (
          <div className="anchors-day" key={day.day} data-testid={`anchors-day-${day.day}`}>
            <h4 className="anchors-day-title">
              第 {day.day} 天{day.date ? ` · ${day.date}` : ''}
              {day.stops.length === 0 ? '（当天没有站点）' : ''}
            </h4>
            <div className="anchors-anchor-row">
              <label className="anchors-check">
                <input
                  type="checkbox"
                  checked={form.daily[String(day.day)]?.start !== null && form.daily[String(day.day)]?.start !== undefined}
                  onChange={(event) => {
                    if (!event.target.checked) {
                      setDayAnchor(day.day, 'start', null)
                      return
                    }
                    const hotelId = ensureStayHotelId()
                    setDayAnchor(day.day, 'start', {
                      ...emptyDayAnchorForm(),
                      hotelId: hotelId ?? '',
                      name: stay?.name ?? '',
                    })
                  }}
                />
                <span>使用起点锚点</span>
              </label>
              {form.daily[String(day.day)]?.start ? (
                <DayAnchorEditor
                  day={day}
                  title="起点"
                  anchor={form.daily[String(day.day)].start as DayAnchorForm}
                  hasAccommodation={stay !== null}
                  onChange={(patch) => updateDayAnchor(day.day, 'start', patch)}
                  onUseStop={(stopId) => useStop(day.day, 'start', day, stopId)}
                  onUseAccommodation={() => fillFromAccommodation(day.day, 'start')}
                  onAssociateAccommodation={(checked) => associateAccommodation(day.day, 'start', checked)}
                />
              ) : null}
            </div>
            <div className="anchors-anchor-row">
              <label className="anchors-check">
                <input
                  type="checkbox"
                  checked={form.daily[String(day.day)]?.end !== null && form.daily[String(day.day)]?.end !== undefined}
                  onChange={(event) => {
                    if (!event.target.checked) {
                      setDayAnchor(day.day, 'end', null)
                      return
                    }
                    const hotelId = ensureStayHotelId()
                    setDayAnchor(day.day, 'end', {
                      ...emptyDayAnchorForm(),
                      hotelId: hotelId ?? '',
                      name: stay?.name ?? '',
                    })
                  }}
                />
                <span>使用终点锚点</span>
              </label>
              {form.daily[String(day.day)]?.end ? (
                <DayAnchorEditor
                  day={day}
                  title="终点"
                  anchor={form.daily[String(day.day)].end as DayAnchorForm}
                  hasAccommodation={stay !== null}
                  onChange={(patch) => updateDayAnchor(day.day, 'end', patch)}
                  onUseStop={(stopId) => useStop(day.day, 'end', day, stopId)}
                  onUseAccommodation={() => fillFromAccommodation(day.day, 'end')}
                  onAssociateAccommodation={(checked) => associateAccommodation(day.day, 'end', checked)}
                />
              ) : null}
            </div>
          </div>
        ))}
      </fieldset>

      <fieldset className="anchors-section">
        <legend>抵达 / 离开（机场 / 车站）</legend>
        <div className="anchors-transport-row">
          <label className="anchors-check">
            <input
              type="checkbox"
              checked={form.arrival !== null}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  arrival: event.target.checked ? emptyTransportAnchorForm('airport') : null,
                }))
              }
            />
            <span>填写抵达信息</span>
          </label>
          {form.arrival ? (
            <TransportEditor
              title="抵达"
              value={form.arrival}
              onChange={(patch) =>
                setForm((current) => ({
                  ...current,
                  arrival: { ...(current.arrival ?? emptyTransportAnchorForm()), ...patch },
                }))
              }
            />
          ) : null}
        </div>
        <div className="anchors-transport-row">
          <label className="anchors-check">
            <input
              type="checkbox"
              checked={form.departure !== null}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  departure: event.target.checked ? emptyTransportAnchorForm('station') : null,
                }))
              }
            />
            <span>填写离开信息</span>
          </label>
          {form.departure ? (
            <TransportEditor
              title="离开"
              value={form.departure}
              onChange={(patch) =>
                setForm((current) => ({
                  ...current,
                  departure: { ...(current.departure ?? emptyTransportAnchorForm()), ...patch },
                }))
              }
            />
          ) : null}
        </div>
        <p className="anchors-hint">抵离日期 / 时间可留空；缺失只是缺信息，不阻断，也不会自动补 0 点。</p>
      </fieldset>

      {error ? (
        <p className="anchors-error" role="alert" data-testid="anchors-error">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="anchors-status" role="status" data-testid="anchors-status">
          {status}
        </p>
      ) : null}

      <div className="anchors-actions">
        <button type="button" className="anchors-btn anchors-btn-primary" onClick={handlePreview}>
          预览提案
        </button>
        <button
          type="button"
          className="anchors-btn"
          onClick={handleApply}
          disabled={currentPreview === null}
        >
          应用提案
        </button>
        {preview !== null ? (
          <button type="button" className="anchors-btn" onClick={handleCancelPreview}>
            取消预览
          </button>
        ) : null}
        <button type="button" className="anchors-btn" onClick={handleReset}>
          放弃未应用修改
        </button>
        <p className="anchors-hint anchors-actions-hint">
          应用按钮只调用父级回调；面板不写 storage，也不会因为设置锚点而偷偷修改当前 Trip。
        </p>
      </div>

      {currentPreview ? <PreviewBlock proposal={currentPreview} /> : null}
    </section>
  )
}

function DayAnchorEditor({
  day,
  title,
  anchor,
  hasAccommodation,
  onChange,
  onUseStop,
  onUseAccommodation,
  onAssociateAccommodation,
}: {
  day: TripDay
  title: '起点' | '终点'
  anchor: DayAnchorForm
  hasAccommodation: boolean
  onChange: (patch: Partial<DayAnchorForm>) => void
  onUseStop: (stopId: string) => void
  onUseAccommodation: () => void
  onAssociateAccommodation: (checked: boolean) => void
}) {
  const baseId = useId()
  const kindId = `${baseId}-kind`
  const stopId = `${baseId}-stop`
  const nameId = `${baseId}-name`
  const addressId = `${baseId}-address`
  const timeId = `${baseId}-time`
  const dateId = `${baseId}-date`
  const lngId = `${baseId}-lng`
  const latId = `${baseId}-lat`
  const hotelId = `${baseId}-hotel`
  return (
    <div className="anchors-anchor-editor" data-testid={`anchors-editor-${title}`}>
      <p className="anchors-anchor-title">{title}</p>
      <div className="anchors-grid">
        <label className="anchors-field" htmlFor={kindId}>
          <span>类型</span>
          <select
            id={kindId}
            value={anchor.kind}
            onChange={(event) => {
              const kind = event.target.value === 'stop' ? 'stop' : 'manual'
              onChange({ kind, stopId: kind === 'manual' ? '' : anchor.stopId })
            }}
          >
            <option value="manual">手工地点</option>
            <option value="stop">引用已有站点</option>
          </select>
        </label>
        {anchor.kind === 'stop' ? (
          <label className="anchors-field" htmlFor={stopId}>
            <span>已有站点</span>
            <select id={stopId} value={anchor.stopId} onChange={(event) => onUseStop(event.target.value)}>
              <option value="">请选择当天站点</option>
              {day.stops.map((stop) => (
                <option key={stop.id} value={stop.id}>
                  {stop.name}（{stop.time}）
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="anchors-field" htmlFor={nameId}>
          <span>名称</span>
          <input id={nameId} value={anchor.name} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className="anchors-field" htmlFor={addressId}>
          <span>地址（可留空）</span>
          <input
            id={addressId}
            value={anchor.address}
            onChange={(event) => onChange({ address: event.target.value })}
          />
        </label>
        <label className="anchors-field" htmlFor={timeId}>
          <span>时间（HH:MM，可留空）</span>
          <input
            id={timeId}
            value={anchor.time}
            onChange={(event) => onChange({ time: event.target.value })}
            placeholder="HH:MM"
          />
        </label>
        <label className="anchors-field" htmlFor={dateId}>
          <span>日期（YYYY-MM-DD，可留空）</span>
          <input
            id={dateId}
            value={anchor.date}
            onChange={(event) => onChange({ date: event.target.value })}
            placeholder="YYYY-MM-DD"
          />
        </label>
        <label className="anchors-field" htmlFor={lngId}>
          <span>经度（可留空）</span>
          <input
            id={lngId}
            value={anchor.lng}
            onChange={(event) => onChange({ lng: event.target.value })}
            inputMode="decimal"
          />
        </label>
        <label className="anchors-field" htmlFor={latId}>
          <span>纬度（可留空）</span>
          <input
            id={latId}
            value={anchor.lat}
            onChange={(event) => onChange({ lat: event.target.value })}
            inputMode="decimal"
          />
        </label>
        {hasAccommodation ? (
          <label className="anchors-check anchors-grid-full" htmlFor={hotelId}>
            <input
              id={hotelId}
              type="checkbox"
              checked={anchor.hotelId !== ''}
              onChange={(event) => onAssociateAccommodation(event.target.checked)}
            />
            <span>关联住宿实体（勾选后应用会生成独立酒店停靠）</span>
          </label>
        ) : null}
        {hasAccommodation ? (
          <div className="anchors-grid-full">
            <button type="button" className="anchors-btn" onClick={onUseAccommodation}>
              填入住宿信息
            </button>
          </div>
        ) : null}
        <p className="anchors-hint anchors-grid-full">{COORDINATE_HINT}</p>
      </div>
    </div>
  )
}

function TransportEditor({
  title,
  value,
  onChange,
}: {
  title: '抵达' | '离开'
  value: TransportAnchorForm
  onChange: (patch: Partial<TransportAnchorForm>) => void
}) {
  const baseId = useId()
  return (
    <div className="anchors-anchor-editor" data-testid={`anchors-transport-${title}`}>
      <div className="anchors-grid">
        <label className="anchors-field" htmlFor={`${baseId}-kind`}>
          <span>类型</span>
          <select
            id={`${baseId}-kind`}
            value={value.kind}
            onChange={(event) =>
              onChange({
                kind:
                  event.target.value === 'station'
                    ? 'station'
                    : event.target.value === 'other'
                      ? 'other'
                      : 'airport',
              })
            }
          >
            <option value="airport">机场</option>
            <option value="station">车站</option>
            <option value="other">其他</option>
          </select>
        </label>
        <label className="anchors-field" htmlFor={`${baseId}-name`}>
          <span>名称</span>
          <input
            id={`${baseId}-name`}
            value={value.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <label className="anchors-field" htmlFor={`${baseId}-date`}>
          <span>日期（可留空）</span>
          <input
            id={`${baseId}-date`}
            value={value.date}
            onChange={(event) => onChange({ date: event.target.value })}
            placeholder="YYYY-MM-DD"
          />
        </label>
        <label className="anchors-field" htmlFor={`${baseId}-time`}>
          <span>时间（可留空）</span>
          <input
            id={`${baseId}-time`}
            value={value.time}
            onChange={(event) => onChange({ time: event.target.value })}
            placeholder="HH:MM"
          />
        </label>
        <label className="anchors-field" htmlFor={`${baseId}-lng`}>
          <span>经度（可留空）</span>
          <input
            id={`${baseId}-lng`}
            value={value.lng}
            onChange={(event) => onChange({ lng: event.target.value })}
            inputMode="decimal"
          />
        </label>
        <label className="anchors-field" htmlFor={`${baseId}-lat`}>
          <span>纬度（可留空）</span>
          <input
            id={`${baseId}-lat`}
            value={value.lat}
            onChange={(event) => onChange({ lat: event.target.value })}
            inputMode="decimal"
          />
        </label>
        <p className="anchors-hint anchors-grid-full">{COORDINATE_HINT}</p>
      </div>
    </div>
  )
}

function PreviewBlock({ proposal }: { proposal: AnchorsProposal }) {
  return (
    <div className="anchors-preview" data-testid="anchors-preview">
      <div className="anchors-preview-head">
        <h4>提案预览（尚未应用）</h4>
        <span className="anchors-tag">owner revision {proposal.baseRevision}</span>
      </div>
      <p className="anchors-hint">
        本次只新增 {proposal.occurrences.length} 个独立酒店停靠；已有站点 id 与内容保持不变。
        锚点本身不是行程站点，应用前不会出现在 Trip 里。
      </p>

      {proposal.occurrences.length > 0 ? (
        <ul className="anchors-list" data-testid="anchors-occurrences">
          {proposal.occurrences.map((occurrence) => (
            <li key={occurrence.stop.id}>
              第 {occurrence.day} 天{occurrence.position === 'start' ? '起点' : '终点'}：将新增独立停靠
              <code>{occurrence.stop.id}</code>（酒店实体 <code>{occurrence.hotelId}</code>，预览未写入）
            </li>
          ))}
        </ul>
      ) : (
        <p className="anchors-hint" data-testid="anchors-no-occurrences">
          本次不新增任何 stop；锚点只作为 sidecar 参考保存。
        </p>
      )}

      <ul className="anchors-list" data-testid="anchors-placements">
        {proposal.placements.map((placement) => (
          <li key={`${placement.day}-${placement.position}-${placement.anchorId}`}>
            第 {placement.day} 天{placement.position === 'start' ? '起点' : '终点'}：
            {placement.status === 'linked_existing'
              ? `链接已有站点 ${placement.stopId}，不复制`
              : placement.status === 'new_occurrence'
                ? `将新增独立停靠 ${placement.stopId}`
                : '仅参考，未写入行程'}
          </li>
        ))}
      </ul>

      {proposal.hardGate.blockers.length > 0 ? (
        <div className="anchors-conflict-block" data-testid="anchors-blockers">
          <h5>明确冲突（需要先改行程或改锚点）</h5>
          <ul>
            {proposal.hardGate.blockers.map((conflict, index) => (
              <li key={`${conflict.code}-${index}`}>{conflict.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {proposal.hardGate.unverified.length > 0 ? (
        <div className="anchors-conflict-block" data-testid="anchors-unverified">
          <h5>待确认（未知按未知处理，不补 0）</h5>
          <ul>
            {proposal.hardGate.unverified.map((conflict, index) => (
              <li key={`${conflict.code}-${index}`}>{conflict.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="anchors-list anchors-notices" data-testid="anchors-notices">
        {proposal.notices.map((notice) => (
          <li key={notice}>{notice}</li>
        ))}
      </ul>
    </div>
  )
}

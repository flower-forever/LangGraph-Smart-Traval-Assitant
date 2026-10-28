import { useId, useState } from 'react'
import type { PlanRequest, TravelMode } from '../lib/api'

export interface PlanFormProps {
  onSubmit: (payload: PlanRequest) => void
  loading: boolean
}

interface FormState {
  destination: string
  days: number
  departure_date: string
  travelers: number
  preferences: string
  travel_mode: TravelMode
}

const INITIAL: FormState = {
  destination: '',
  days: 3,
  departure_date: '',
  travelers: 2,
  preferences: '',
  travel_mode: 'walking',
}

interface Errors {
  destination?: string
  days?: string
  departure_date?: string
  travelers?: string
}

/** 本地校验，返回错误对象；空对象表示通过 */
function validate(f: FormState): Errors {
  const errors: Errors = {}
  const dest = f.destination.trim()
  if (!dest) errors.destination = '请填写目的地'
  else if (dest.length > 60) errors.destination = '目的地最多 60 字'

  if (!Number.isInteger(f.days) || f.days < 1 || f.days > 7) {
    errors.days = '天数需在 1 到 7 之间'
  }

  if (f.departure_date) {
    // 要求 YYYY-MM-DD 且不是过去的日子（浏览器日期框通常已约束，双保险）
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.departure_date)) {
      errors.departure_date = '日期格式应为 YYYY-MM-DD'
    } else {
      const [y, m, d] = f.departure_date.split('-').map(Number)
      const picked = new Date(y, m - 1, d)
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      if (picked < today) errors.departure_date = '出发日期不能早于今天'
      else if (picked.getFullYear() > today.getFullYear() + 2) errors.departure_date = '日期过远，请选两年以内'
    }
  }

  if (!Number.isInteger(f.travelers) || f.travelers < 1 || f.travelers > 20) {
    errors.travelers = '人数需在 1 到 20 之间'
  }
  return errors
}

export default function PlanForm({ onSubmit, loading }: PlanFormProps) {
  const [form, setForm] = useState<FormState>(INITIAL)
  const [errors, setErrors] = useState<Errors>({})
  const [touched, setTouched] = useState(false)

  const destId = useId()
  const daysId = useId()
  const dateId = useId()
  const travId = useId()
  const prefId = useId()

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    if (touched) {
      // 已提交过一次后即时复检
      setErrors(validate({ ...form, [key]: value }))
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const nextErrors = validate(form)
    setErrors(nextErrors)
    setTouched(true)
    if (Object.keys(nextErrors).length > 0) return
    onSubmit({
      destination: form.destination.trim(),
      days: form.days,
      departure_date: form.departure_date || null,
      travelers: form.travelers,
      preferences: form.preferences.trim(),
      travel_mode: form.travel_mode,
    })
  }

  const hasError = (key: keyof Errors) => Boolean(errors[key])

  return (
    <form className="plan-card" onSubmit={handleSubmit} noValidate aria-label="行程规划表单">
      <h2 className="plan-heading">规划一次新的出行</h2>
      <p className="plan-hint">填写基本信息，由后端智能体生成逐日路线、中文讲解与地图路线。</p>

      <div className="plan-fields">
        <div className="field field-destination">
          <label className="field-label" htmlFor={destId}>目的地<span className="req" aria-hidden="true">*</span></label>
          <input
            id={destId}
            className="field-input"
            type="text"
            value={form.destination}
            onChange={(e) => set('destination', e.target.value)}
            placeholder="例如：杭州"
            autoComplete="off"
            maxLength={80}
            aria-required="true"
            aria-invalid={hasError('destination') || undefined}
            aria-describedby={hasError('destination') ? `${destId}-err` : undefined}
            disabled={loading}
          />
          {hasError('destination') && (
            <p className="field-error" id={`${destId}-err`} role="alert">{errors.destination}</p>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={daysId}>天数</label>
          <input
            id={daysId}
            className="field-input"
            type="number"
            min={1}
            max={7}
            step={1}
            value={form.days}
            onChange={(e) => set('days', e.target.value === '' ? NaN : Number(e.target.value))}
            aria-invalid={hasError('days') || undefined}
            aria-describedby={hasError('days') ? `${daysId}-err` : undefined}
            disabled={loading}
          />
          {hasError('days')
            ? <p className="field-error" id={`${daysId}-err`} role="alert">{errors.days}</p>
            : <p className="field-help">1 到 7 天</p>}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={dateId}>出发日期（可选）</label>
          <input
            id={dateId}
            className="field-input"
            type="date"
            value={form.departure_date}
            onChange={(e) => set('departure_date', e.target.value)}
            aria-invalid={hasError('departure_date') || undefined}
            aria-describedby={hasError('departure_date') ? `${dateId}-err` : undefined}
            disabled={loading}
          />
          {hasError('departure_date')
            ? <p className="field-error" id={`${dateId}-err`} role="alert">{errors.departure_date}</p>
            : <p className="field-help">留空由助手安排</p>}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={travId}>出行人数</label>
          <input
            id={travId}
            className="field-input"
            type="number"
            min={1}
            max={20}
            step={1}
            value={form.travelers}
            onChange={(e) => set('travelers', e.target.value === '' ? NaN : Number(e.target.value))}
            aria-invalid={hasError('travelers') || undefined}
            aria-describedby={hasError('travelers') ? `${travId}-err` : undefined}
            disabled={loading}
          />
          {hasError('travelers')
            ? <p className="field-error" id={`${travId}-err`} role="alert">{errors.travelers}</p>
            : <p className="field-help">1 到 20 人</p>}
        </div>

        <div className="field">
          <span className="field-label" id="travel-mode-label">出行方式</span>
          <div className="mode-toggle" role="radiogroup" aria-labelledby="travel-mode-label">
            <label className="mode-option">
              <input
                type="radio"
                name="travel_mode"
                value="walking"
                checked={form.travel_mode === 'walking'}
                onChange={() => set('travel_mode', 'walking')}
                disabled={loading}
              />
              <span>步行优先</span>
            </label>
            <label className="mode-option">
              <input
                type="radio"
                name="travel_mode"
                value="driving"
                checked={form.travel_mode === 'driving'}
                onChange={() => set('travel_mode', 'driving')}
                disabled={loading}
              />
              <span>驾车</span>
            </label>
          </div>
        </div>

        <div className="field field-preferences">
          <label className="field-label" htmlFor={prefId}>偏好（可选）</label>
          <textarea
            id={prefId}
            className="field-input"
            value={form.preferences}
            onChange={(e) => set('preferences', e.target.value)}
            placeholder="例如：喜欢老街和历史建筑，带两位老人，节奏慢一些，不吃辣"
            maxLength={300}
            rows={2}
            disabled={loading}
          />
          <p className="field-help">{form.preferences.length} / 300 字</p>
        </div>
      </div>

      <div className="plan-actions">
        <button className="btn btn-primary" type="submit" disabled={loading} data-loading={loading}>
          {loading ? '正在规划…' : '生成行程'}
        </button>
      </div>
    </form>
  )
}

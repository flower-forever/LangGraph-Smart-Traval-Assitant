import { useId, useState } from 'react'
import type { PlanRequest, TravelMode } from '../lib/api'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'

export interface PlanFormProps {
  onSubmit: (payload: PlanRequest) => void
  loading: boolean
  /** 停止等待当前规划请求（只取消本页等待，不保证终止后端 / 上游处理） */
  onCancel?: () => void
  /**
   * 后端已经明确说 planner_ready=false。
   * 只能传 true：探活未知（旧后端 / 字段缺失）必须保持 undefined，不能当不可用。
   */
  plannerUnavailable?: boolean
}

interface FormState {
  destination: string
  /** 数字输入框用字符串保存，清空时保留空输入，不把 NaN 写进受控 value */
  days: string
  departure_date: string
  travelers: string
  preferences: string
  travel_mode: TravelMode
}

const INITIAL: FormState = {
  destination: '',
  days: '3',
  departure_date: '',
  travelers: '2',
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

  const days = Number(f.days)
  if (f.days.trim() === '' || !Number.isInteger(days) || days < 1 || days > 7) {
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

  const travelers = Number(f.travelers)
  if (f.travelers.trim() === '' || !Number.isInteger(travelers) || travelers < 1 || travelers > 20) {
    errors.travelers = '人数需在 1 到 20 之间'
  }
  return errors
}

/* W4：表单骨架（plan-card 卡面 / plan-fields 三列栅格 / field 块 / 出行方式按钮组）
 * 从 app.css 旧规则迁为工具类；UI_DESIGN §4 映射表同款。plan-card 类名是测试提交锚点
 * （PlanForm.test form.plan-card），保留。 */
const PLAN_CARD =
  'plan-card mb-6 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5 shadow-[var(--shadow-1)]'
const PLAN_FIELDS =
  'grid grid-cols-1 gap-4 max-[480px]:grid-cols-1 min-[481px]:max-[768px]:grid-cols-2 min-[769px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]'
const FIELD_DESTINATION =
  'flex min-w-0 flex-col gap-1 min-[481px]:max-[768px]:col-span-full min-[769px]:col-auto'
const FIELD_PREFERENCES = 'flex min-w-0 flex-col gap-1 col-span-full'
const FIELD = 'flex min-w-0 flex-col gap-1'
const FIELD_LABEL = 'text-sm font-semibold text-[color:var(--color-secondary-foreground)]'
const FIELD_REQ = 'ml-[2px] text-[color:var(--color-accent-foreground)]'
const FIELD_ERROR = 'm-0 text-xs text-[color:var(--color-accent-foreground)]'
const FIELD_HELP = 'm-0 text-xs text-[color:var(--color-faint)]'
const MODE_TOGGLE = 'flex gap-2'
const MODE_OPTION =
  'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-4 py-2 transition-colors duration-150 ease-out hover:bg-secondary has-[input:checked]:border-[color:var(--color-primary)] has-[input:checked]:bg-accent-surface'
const MODE_RADIO =
  'size-4 shrink-0 accent-[color:var(--color-primary)] outline-2 outline-offset-2 outline-[color:var(--color-accent-foreground)] focus-visible:outline'
const PLAN_ACTIONS =
  'mt-4 flex items-center gap-3 max-[640px]:flex-wrap max-[640px]:[&>*]:flex-[1_1_auto]'
const PLAN_CANCEL_NOTE =
  'mt-2 max-w-[72ch] text-xs leading-relaxed text-[color:var(--color-faint)] [overflow-wrap:anywhere]'

export default function PlanForm({ onSubmit, loading, onCancel, plannerUnavailable = false }: PlanFormProps) {
  const [form, setForm] = useState<FormState>(INITIAL)
  const [errors, setErrors] = useState<Errors>({})
  const [touched, setTouched] = useState(false)

  const destId = useId()
  const daysId = useId()
  const dateId = useId()
  const travId = useId()
  const prefId = useId()
  const cancelNoteId = useId()
  const plannerNoteId = useId()

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
    if (touched) {
      // 已提交过一次后即时复检
      setErrors(validate({ ...form, [key]: value }))
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // 按钮已禁用；回车提交（隐式提交）也拦住，不白跑一趟后端
    if (plannerUnavailable) return
    const nextErrors = validate(form)
    setErrors(nextErrors)
    setTouched(true)
    if (Object.keys(nextErrors).length > 0) return
    onSubmit({
      destination: form.destination.trim(),
      days: Number(form.days),
      departure_date: form.departure_date || null,
      travelers: Number(form.travelers),
      preferences: form.preferences.trim(),
      travel_mode: form.travel_mode,
    })
  }

  const hasError = (key: keyof Errors) => Boolean(errors[key])

  return (
    <form className={PLAN_CARD} onSubmit={handleSubmit} noValidate aria-label="行程规划表单">
      <h2 className="m-0 mb-2 font-display text-md font-bold tracking-[0.04em]">规划一次新的出行</h2>
      <p className="m-0 mb-4 text-sm text-muted-foreground">
        填写基本信息，由后端智能体生成逐日路线、中文讲解与地图路线。
      </p>

      {plannerUnavailable && (
        <div
          className="grid gap-1.5 rounded-[6px] border-l-[3px] border-l-[color:var(--color-warn-ink)] bg-[color:var(--color-warn-bg)] p-3 text-sm leading-relaxed text-[color:var(--color-secondary-foreground)] [overflow-wrap:anywhere]"
          id={plannerNoteId}
          role="status"
          aria-live="polite"
        >
          <p className="m-0 text-sm font-semibold text-[color:var(--color-warn-ink)]">
            后端在线，规划暂不可用。
          </p>
          <p className="m-0">
            后端健康检查明确返回 <code className="rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-xs">planner_ready=false</code>，说明结构化规划组件还没就绪。
            这时提交也会失败，所以提交按钮先禁用了；参数仍可以接着填。
          </p>
          <p className="m-0">
            具体原因前端看不到，可能包括后端没有配置模型访问凭据（例如 DASHSCOPE_API_KEY），
            或规划依赖初始化失败；实际以服务端启动日志为准。处理完后点页面上方的「重新检测」，不用刷新页面。
          </p>
          <p className="m-0">示例行程和这个浏览器里保存的副本不受影响，仍可查看。</p>
        </div>
      )}

      <div className={PLAN_FIELDS}>
        <div className={FIELD_DESTINATION}>
          <label className={FIELD_LABEL} htmlFor={destId}>目的地<span className={FIELD_REQ} aria-hidden="true">*</span></label>
          <Input
            id={destId}
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
            <p className={FIELD_ERROR} id={`${destId}-err`} role="alert">{errors.destination}</p>
          )}
        </div>

        <div className={FIELD}>
          <label className={FIELD_LABEL} htmlFor={daysId}>天数</label>
          <Input
            id={daysId}
            type="number"
            min={1}
            max={7}
            step={1}
            className="font-mono text-sm"
            value={form.days}
            onChange={(e) => set('days', e.target.value)}
            aria-invalid={hasError('days') || undefined}
            aria-describedby={hasError('days') ? `${daysId}-err` : undefined}
            disabled={loading}
          />
          {hasError('days')
            ? <p className={FIELD_ERROR} id={`${daysId}-err`} role="alert">{errors.days}</p>
            : <p className={FIELD_HELP}>1 到 7 天</p>}
        </div>

        <div className={FIELD}>
          <label className={FIELD_LABEL} htmlFor={dateId}>出发日期（可选）</label>
          <Input
            id={dateId}
            type="date"
            value={form.departure_date}
            onChange={(e) => set('departure_date', e.target.value)}
            aria-invalid={hasError('departure_date') || undefined}
            aria-describedby={hasError('departure_date') ? `${dateId}-err` : undefined}
            disabled={loading}
          />
          {hasError('departure_date')
            ? <p className={FIELD_ERROR} id={`${dateId}-err`} role="alert">{errors.departure_date}</p>
            : <p className={FIELD_HELP}>留空由助手安排</p>}
        </div>

        <div className={FIELD}>
          <label className={FIELD_LABEL} htmlFor={travId}>出行人数</label>
          <Input
            id={travId}
            type="number"
            min={1}
            max={20}
            step={1}
            className="font-mono text-sm"
            value={form.travelers}
            onChange={(e) => set('travelers', e.target.value)}
            aria-invalid={hasError('travelers') || undefined}
            aria-describedby={hasError('travelers') ? `${travId}-err` : undefined}
            disabled={loading}
          />
          {hasError('travelers')
            ? <p className={FIELD_ERROR} id={`${travId}-err`} role="alert">{errors.travelers}</p>
            : <p className={FIELD_HELP}>1 到 20 人</p>}
        </div>

        <div className={FIELD}>
          <span className={FIELD_LABEL} id="travel-mode-label">出行方式</span>
          <div className={MODE_TOGGLE} role="radiogroup" aria-labelledby="travel-mode-label">
            <label className={MODE_OPTION}>
              <input
                type="radio"
                name="travel_mode"
                value="walking"
                className={MODE_RADIO}
                checked={form.travel_mode === 'walking'}
                onChange={() => set('travel_mode', 'walking')}
                disabled={loading}
              />
              <span>步行优先</span>
            </label>
            <label className={MODE_OPTION}>
              <input
                type="radio"
                name="travel_mode"
                value="driving"
                className={MODE_RADIO}
                checked={form.travel_mode === 'driving'}
                onChange={() => set('travel_mode', 'driving')}
                disabled={loading}
              />
              <span>驾车</span>
            </label>
          </div>
        </div>

        <div className={FIELD_PREFERENCES}>
          <label className={FIELD_LABEL} htmlFor={prefId}>偏好（可选）</label>
          <Textarea
            id={prefId}
            value={form.preferences}
            onChange={(e) => set('preferences', e.target.value)}
            placeholder="例如：喜欢老街和历史建筑，带两位老人，节奏慢一些，不吃辣"
            maxLength={300}
            rows={2}
            className="min-h-16 resize-y font-body"
            disabled={loading}
          />
          <p className={FIELD_HELP}>{form.preferences.length} / 300 字</p>
        </div>
      </div>

      <div className={PLAN_ACTIONS}>
        <Button
          type="submit"
          disabled={loading || plannerUnavailable}
          aria-describedby={plannerUnavailable ? plannerNoteId : undefined}
          className="relative min-h-11 px-5 text-base font-semibold tracking-[0.08em] aria-busy:relative aria-busy:text-transparent"
          aria-busy={loading || undefined}
        >
          {loading ? '正在规划…' : plannerUnavailable ? '规划暂不可用' : '生成行程'}
          {loading && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
            >
              <span className="size-4 animate-spin rounded-full border-2 border-[color:var(--primary-foreground)] border-t-transparent" />
            </span>
          )}
        </Button>
        {loading && onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            aria-describedby={cancelNoteId}
            className="min-h-11 px-5 text-base"
          >
            停止等待
          </Button>
        )}
      </div>
      {loading && (
        <p className={PLAN_CANCEL_NOTE} id={cancelNoteId} role="note">
          「停止等待」只会让本页不再等待这次结果，可以立刻改参数重新提交；它不会中断后端或上游模型的处理，
          也不能保证服务端立刻停止处理与计费。
        </p>
      )}
    </form>
  )
}

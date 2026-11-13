import { useId, useState } from 'react'
import type { PlanRequest, TravelMode } from '../lib/api'
import type { HealthPace } from '../lib/itineraryHealth'
import {
  INTEREST_OPTIONS,
  interestLabelOf,
  normalizeInterests,
  type PlanInterest,
} from '../lib/interests'
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
  /** 规划节奏：空字符串 = 不选（= 均衡，不传 pace 字段，请求体与旧版一致） */
  pace: '' | HealthPace
  /** 个性化兴趣（S6）：空数组 = 不选（不传 interests 字段，请求体与旧版一致） */
  interests: PlanInterest[]
  /** 多城联程（七期 S1）：按添加顺序排列的额外城市；空数组 = 单城请求 */
  extraCities: CityDraft[]
}

/** 多城联程的一行草稿：数字输入框同样用字符串保存 */
interface CityDraft {
  name: string
  days: string
}

const INITIAL: FormState = {
  destination: '',
  days: '3',
  departure_date: '',
  travelers: '2',
  preferences: '',
  travel_mode: 'walking',
  pace: '',
  interests: [],
  extraCities: [],
}

/** 多城联程上限：总城市 ≤ 3（主城 + 最多 2 座额外城市），单城 1..6 天 */
const MAX_EXTRA_CITIES = 2
const MAX_CITY_DAYS = 6

/** 节奏选项：label 与 value；不选 = 均衡（pace 字段不进请求体）。 */
const PACE_OPTIONS: ReadonlyArray<{ value: HealthPace; label: string; help: string }> = [
  { value: 'relaxed', label: '松弛', help: '≤4 站/天，日跨度 ≤8 小时' },
  { value: 'balanced', label: '均衡', help: '≤6 站/天，日跨度 ≤10 小时' },
  { value: 'packed', label: '紧凑', help: '≤8 站/天，日跨度 ≤12 小时' },
]

interface CityRowErrors {
  name?: string
  days?: string
}

interface Errors {
  destination?: string
  days?: string
  departure_date?: string
  travelers?: string
  /** 多城联程：按行错误，index 与 extraCities 对齐；存在即表示至少一行有错 */
  cityRows?: CityRowErrors[]
  /** 多城区块级错误（城市数量、主城剩余天数） */
  cities?: string
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

  // 七期 S1：多城联程校验。单城（没有额外城市）完全不进入这里，请求体保持旧 shape。
  if (f.extraCities.length > 0) {
    let hasRowError = false
    const rowErrors: CityRowErrors[] = f.extraCities.map(() => ({}))
    const seenNames = new Set<string>()
    if (dest) seenNames.add(dest)
    f.extraCities.forEach((row, index) => {
      const name = row.name.trim()
      if (!name) {
        rowErrors[index].name = '请填写城市名'
        hasRowError = true
      } else if (dest && name === dest) {
        rowErrors[index].name = '城市名不能与主城重复'
        hasRowError = true
      } else if (seenNames.has(name)) {
        rowErrors[index].name = '城市名不能与其它城市重复'
        hasRowError = true
      } else {
        seenNames.add(name)
      }
      const cityDays = Number(row.days)
      if (
        row.days.trim() === '' ||
        !Number.isInteger(cityDays) ||
        cityDays < 1 ||
        cityDays > MAX_CITY_DAYS
      ) {
        rowErrors[index].days = `天数需在 1 到 ${MAX_CITY_DAYS} 之间`
        hasRowError = true
      }
    })
    if (hasRowError) errors.cityRows = rowErrors

    if (f.extraCities.length > MAX_EXTRA_CITIES) {
      errors.cities = '最多再添加 2 座城市（总城市不超过 3 座）'
    }
    // 主城天数 = 总天数 − 其它城市天数；小于 1 天时明确失败。
    if (Number.isInteger(days) && days >= 1 && days <= 7) {
      const extraDays = f.extraCities.reduce((sum, row) => {
        const value = Number(row.days)
        return Number.isInteger(value) && value > 0 ? sum + value : sum
      }, 0)
      if (days - extraDays < 1) {
        errors.cities = '主城至少保留 1 天'
      }
    }
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
const INTEREST_OPTION =
  'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[6px] border border-[color:var(--color-line-strong)] bg-background px-4 py-2 transition-colors duration-150 ease-out hover:bg-secondary has-[input:checked]:border-[color:var(--color-primary)] has-[input:checked]:bg-accent-surface'
const INTEREST_CHECKBOX =
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
  const multicityId = useId()

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
    const extraDays = form.extraCities.reduce((sum, row) => sum + Number(row.days), 0)
    onSubmit({
      destination: form.destination.trim(),
      days: Number(form.days),
      departure_date: form.departure_date || null,
      travelers: Number(form.travelers),
      preferences: form.preferences.trim(),
      travel_mode: form.travel_mode,
      // 不选节奏 = 均衡：pace 字段不进请求体，保持旧版请求逐字节兼容。
      ...(form.pace !== '' ? { pace: form.pace } : {}),
      // 不选兴趣：interests 字段整个不进请求体，保持旧版请求逐字节兼容。
      ...(form.interests.length > 0 ? { interests: [...form.interests] } : {}),
      // 七期 S1：没有额外城市时 cities 字段整个不进请求体，单城请求保持旧 shape。
      ...(form.extraCities.length > 0
        ? {
            cities: [
              { name: form.destination.trim(), days: Number(form.days) - extraDays },
              ...form.extraCities.map((row) => ({
                name: row.name.trim(),
                days: Number(row.days),
              })),
            ],
          }
        : {}),
    })
  }

  function addCity() {
    if (form.extraCities.length >= MAX_EXTRA_CITIES) return
    set('extraCities', [...form.extraCities, { name: '', days: '1' }])
  }

  function updateCity(index: number, patch: Partial<CityDraft>) {
    const next = form.extraCities.map((row, i) => (i === index ? { ...row, ...patch } : row))
    set('extraCities', next)
  }

  function removeCity(index: number) {
    set('extraCities', form.extraCities.filter((_, i) => i !== index))
  }

  function toggleInterest(value: PlanInterest) {
    setForm((prev) => {
      const next = prev.interests.includes(value)
        ? prev.interests.filter((item) => item !== value)
        : [...prev.interests, value]
      // 固定顺序：同一组兴趣永远序列化成同一个请求体。
      return { ...prev, interests: normalizeInterests(next) }
    })
  }

  const hasError = (key: keyof Errors) => Boolean(errors[key])

  const extraCityDays = form.extraCities.reduce((sum, row) => {
    const value = Number(row.days)
    return Number.isInteger(value) && value > 0 ? sum + value : sum
  }, 0)
  const totalDays = Number(form.days)
  const mainCityDays =
    Number.isInteger(totalDays) && totalDays >= 1 && totalDays <= 7
      ? totalDays - extraCityDays
      : null

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

        <div className={`${FIELD_PREFERENCES} pace-field`} data-testid="pace-field">
          <span className={FIELD_LABEL} id="pace-label">节奏（可选，默认均衡）</span>
          <div className={MODE_TOGGLE} role="radiogroup" aria-labelledby="pace-label" data-testid="pace-radiogroup">
            {PACE_OPTIONS.map(({ value, label }) => (
              <label key={value} className={MODE_OPTION}>
                <input
                  type="radio"
                  name="pace"
                  value={value}
                  className={MODE_RADIO}
                  checked={form.pace === value}
                  onChange={() => set('pace', value)}
                  disabled={loading}
                />
                <span>{label}</span>
              </label>
            ))}
            <label className={MODE_OPTION}>
              <input
                type="radio"
                name="pace"
                value=""
                className={MODE_RADIO}
                checked={form.pace === ''}
                onChange={() => set('pace', '')}
                disabled={loading}
              />
              <span>不选</span>
            </label>
          </div>
          <p className={FIELD_HELP}>
            {PACE_OPTIONS.find(({ value }) => value === form.pace)?.help ??
              '不选按均衡节奏规划；节奏是建议，不是保证'}
          </p>
        </div>

        <div className={`${FIELD_PREFERENCES} interest-field`} data-testid="interest-field">
          <span className={FIELD_LABEL} id="interest-label">兴趣（可选，可多选）</span>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-labelledby="interest-label"
            data-testid="interest-group"
          >
            {INTEREST_OPTIONS.map(({ value, label }) => (
              <label key={value} className={INTEREST_OPTION}>
                <input
                  type="checkbox"
                  name="interests"
                  value={value}
                  className={INTEREST_CHECKBOX}
                  checked={form.interests.includes(value)}
                  onChange={() => toggleInterest(value)}
                  disabled={loading}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <p className={FIELD_HELP}>
            {form.interests.length > 0
              ? `已选：${form.interests.map(interestLabelOf).join('、')}。兴趣只是偏好，规划器不保证一定安排到。`
              : '不选就不传兴趣偏好（请求与旧版一致）；兴趣只是偏好，不代表一定安排到。'}
          </p>
        </div>
      </div>

      {/* 七期 S1：多城联程请求入口。只改请求 shape，不渲染多城结果（S3 才消费）。 */}
      <div className="mt-4 flex flex-col gap-3" data-testid="multicity-field">
        <span className={FIELD_LABEL} id={`${multicityId}-label`}>多城联程（可选）</span>
        <p className={FIELD_HELP} id={`${multicityId}-help`}>
          按顺序添加第二/第三座城市；城际转移只给直线距离与建议预留时长，不生成车次或时刻表。
        </p>
        {form.extraCities.length > 0 && (
          <ul
            className="m-0 flex list-none flex-col gap-3 p-0"
            aria-labelledby={`${multicityId}-label`}
          >
            {form.extraCities.map((row, index) => {
              const rowError = errors.cityRows?.[index]
              const nameId = `${multicityId}-city-${index}-name`
              const daysInputId = `${multicityId}-city-${index}-days`
              return (
                <li
                  key={index}
                  className="grid grid-cols-1 gap-3 rounded-[6px] border border-[color:var(--color-line-strong)] bg-background p-3 min-[560px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] min-[560px]:items-end"
                >
                  <div className={FIELD}>
                    <label className={FIELD_LABEL} htmlFor={nameId}>
                      第 {index + 2} 座城市
                    </label>
                    <Input
                      id={nameId}
                      type="text"
                      value={row.name}
                      onChange={(e) => updateCity(index, { name: e.target.value })}
                      placeholder="例如：苏州"
                      autoComplete="off"
                      maxLength={60}
                      aria-invalid={Boolean(rowError?.name) || undefined}
                      aria-describedby={rowError?.name ? `${nameId}-err` : undefined}
                      disabled={loading}
                    />
                    {rowError?.name && (
                      <p className={FIELD_ERROR} id={`${nameId}-err`} role="alert">
                        {rowError.name}
                      </p>
                    )}
                  </div>
                  <div className={FIELD}>
                    <label className={FIELD_LABEL} htmlFor={daysInputId}>
                      第 {index + 2} 座城市天数
                    </label>
                    <Input
                      id={daysInputId}
                      type="number"
                      min={1}
                      max={MAX_CITY_DAYS}
                      step={1}
                      className="font-mono text-sm"
                      value={row.days}
                      onChange={(e) => updateCity(index, { days: e.target.value })}
                      aria-invalid={Boolean(rowError?.days) || undefined}
                      aria-describedby={rowError?.days ? `${daysInputId}-err` : undefined}
                      disabled={loading}
                    />
                    {rowError?.days ? (
                      <p className={FIELD_ERROR} id={`${daysInputId}-err`} role="alert">
                        {rowError.days}
                      </p>
                    ) : (
                      <p className={FIELD_HELP}>1 到 {MAX_CITY_DAYS} 天</p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => removeCity(index)}
                    disabled={loading}
                    aria-label={`移除第 ${index + 2} 座城市`}
                    className="min-h-11 px-4"
                  >
                    移除
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
        {errors.cities && (
          <p className={FIELD_ERROR} role="alert" data-testid="multicity-error">
            {errors.cities}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={addCity}
            disabled={loading || form.extraCities.length >= MAX_EXTRA_CITIES}
            className="min-h-11 px-4"
            aria-describedby={`${multicityId}-help`}
          >
            添加城市
          </Button>
          <p className={FIELD_HELP}>
            {form.extraCities.length >= MAX_EXTRA_CITIES
              ? '最多 3 座城市（主城 + 2 座）'
              : form.extraCities.length > 0
                ? `主城「${form.destination.trim() || '首城'}」保留 ${mainCityDays ?? '—'} 天（总天数 − 其它城市天数）`
                : '不添加就是单城行程，请求与旧版一致。'}
          </p>
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

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlanForm from '../components/PlanForm'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function fillDestination(user: ReturnType<typeof userEvent.setup>, value = '杭州') {
  await user.type(screen.getByLabelText(/目的地/), value)
}

async function setTotalDays(user: ReturnType<typeof userEvent.setup>, value: string) {
  const input = screen.getByLabelText('天数')
  await user.clear(input)
  await user.type(input, value)
}

describe('PlanForm 多城联程（七期 S1）', () => {
  it('默认单城提交：payload 不含 cities 键，字段与现值一致', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} />)

    await fillDestination(user)
    await user.click(screen.getByRole('button', { name: '生成行程' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const payload = onSubmit.mock.calls[0][0]
    expect(payload).toMatchObject({
      destination: '杭州',
      days: 3,
      departure_date: null,
      travelers: 2,
      preferences: '',
      travel_mode: 'walking',
    })
    expect(payload).not.toHaveProperty('cities')
    expect(JSON.stringify(payload)).not.toContain('"cities"')
  })

  it('添加苏州 2 天（总 5 天）：cities 按主城在前、添加顺序排列', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} />)

    await fillDestination(user)
    await setTotalDays(user, '5')
    await user.click(screen.getByRole('button', { name: '添加城市' }))
    await user.type(screen.getByLabelText('第 2 座城市'), '苏州')
    const cityDays = screen.getByLabelText('第 2 座城市天数')
    await user.clear(cityDays)
    await user.type(cityDays, '2')
    await user.click(screen.getByRole('button', { name: '生成行程' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const payload = onSubmit.mock.calls[0][0]
    expect(payload.destination).toBe('杭州')
    expect(payload.days).toBe(5)
    expect(payload.cities).toEqual([
      { name: '杭州', days: 3 },
      { name: '苏州', days: 2 },
    ])
  })

  it('城市名与主城重复：阻止提交并显示可定位错误', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} />)

    await fillDestination(user)
    await user.click(screen.getByRole('button', { name: '添加城市' }))
    const cityName = screen.getByLabelText('第 2 座城市')
    await user.type(cityName, '杭州')
    await user.click(screen.getByRole('button', { name: '生成行程' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('城市名不能与主城重复')).toBeInTheDocument()
    expect(cityName).toHaveAttribute('aria-invalid', 'true')
    expect(cityName).toHaveAttribute(
      'aria-describedby',
      screen.getByText('城市名不能与主城重复').id,
    )
  })

  it('主城剩余天数 < 1：阻止提交并提示「主城至少保留 1 天」', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} />)

    await fillDestination(user)
    await setTotalDays(user, '3')
    await user.click(screen.getByRole('button', { name: '添加城市' }))
    await user.type(screen.getByLabelText('第 2 座城市'), '苏州')
    const cityDays = screen.getByLabelText('第 2 座城市天数')
    await user.clear(cityDays)
    await user.type(cityDays, '3')
    await user.click(screen.getByRole('button', { name: '生成行程' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByTestId('multicity-error')).toHaveTextContent('主城至少保留 1 天')
  })

  it('额外城市天数越界：阻止提交并显示行内错误', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} />)

    await fillDestination(user)
    await setTotalDays(user, '5')
    await user.click(screen.getByRole('button', { name: '添加城市' }))
    await user.type(screen.getByLabelText('第 2 座城市'), '苏州')
    const cityDays = screen.getByLabelText('第 2 座城市天数')
    await user.clear(cityDays)
    await user.type(cityDays, '7')
    await user.click(screen.getByRole('button', { name: '生成行程' }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('天数需在 1 到 6 之间')).toBeInTheDocument()
    expect(cityDays).toHaveAttribute('aria-invalid', 'true')
  })

  it('移除城市后回到单城请求 shape', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} />)

    await fillDestination(user)
    await user.click(screen.getByRole('button', { name: '添加城市' }))
    await user.type(screen.getByLabelText('第 2 座城市'), '苏州')
    await user.click(screen.getByRole('button', { name: '移除第 2 座城市' }))
    expect(screen.queryByLabelText('第 2 座城市')).toBeNull()

    await user.click(screen.getByRole('button', { name: '生成行程' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('cities')
  })
})

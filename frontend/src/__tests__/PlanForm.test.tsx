import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlanForm from '../components/PlanForm'

describe('PlanForm', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('plannerUnavailable 时禁用提交、说明原因，输入仍可编辑', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} plannerUnavailable />)

    const submit = screen.getByRole('button', { name: '规划暂不可用' })
    expect(submit).toBeDisabled()

    // 说明里要能看懂「后端在线、但规划没就绪」，并且不复述后端原文
    expect(screen.getByText('后端在线，规划暂不可用。')).toBeInTheDocument()
    const pageText = document.body.textContent ?? ''
    expect(pageText).toContain('planner_ready=false')
    expect(pageText).not.toMatch(/[A-Za-z]:\\/)

    const dest = screen.getByLabelText(/目的地/) as HTMLInputElement
    expect(dest).toBeEnabled()
    await user.type(dest, '西安')
    expect(dest.value).toBe('西安')

    await user.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('禁用状态下表单隐式提交（回车）也拦住，不会白跑一趟', () => {
    const onSubmit = vi.fn()
    const { container } = render(<PlanForm onSubmit={onSubmit} loading={false} plannerUnavailable />)
    fireEvent.change(screen.getByLabelText(/目的地/), { target: { value: '西安' } })
    const form = container.querySelector('form.plan-card')
    expect(form).not.toBeNull()
    fireEvent.submit(form!)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('未知状态（不传 plannerUnavailable）照常允许提交', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} />)

    expect(screen.getByRole('button', { name: '生成行程' })).toBeEnabled()
    expect(screen.queryByText('后端在线，规划暂不可用。')).toBeNull()

    await user.type(screen.getByLabelText(/目的地/), '杭州')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ destination: '杭州', days: 3, travelers: 2 })
  })

  it('规划不可用的提示是 live region；重新检测恢复可用后提示消失、提交恢复', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<PlanForm onSubmit={onSubmit} loading={false} plannerUnavailable />)

    const note = screen.getByRole('status')
    expect(note).toHaveAttribute('aria-live', 'polite')
    expect(note.textContent).toContain('planner_ready=false')

    // 页面重新检测拿到 planner_ready=true 后会用新 props 重渲染：提示收起，提交恢复
    rerender(<PlanForm onSubmit={onSubmit} loading={false} />)
    expect(screen.queryByText('后端在线，规划暂不可用。')).toBeNull()

    const submit = screen.getByRole('button', { name: '生成行程' })
    expect(submit).toBeEnabled()
    await user.type(screen.getByLabelText(/目的地/), '杭州')
    await user.click(submit)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('loading 时显示「正在规划」并提供停止等待', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={vi.fn()} loading onCancel={onCancel} />)

    expect(screen.getByRole('button', { name: /正在规划/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '停止等待' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  /* ───────── S3 · 节奏选择 ───────── */

  it('不选节奏：payload 不含 pace 字段（旧请求体逐字节兼容）', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} />)

    await user.type(screen.getByLabelText(/目的地/), '杭州')
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    const payload = onSubmit.mock.calls[0][0]
    expect(payload).not.toHaveProperty('pace')
    // JSON.stringify 后也不该出现 pace 键
    expect(JSON.stringify(payload)).not.toContain('"pace"')
  })

  it('选「松弛」：payload 带 pace=relaxed；切回「不选」恢复兼容', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PlanForm onSubmit={onSubmit} loading={false} />)

    await user.type(screen.getByLabelText(/目的地/), '杭州')
    const relaxed = screen.getByLabelText('松弛')
    await user.click(relaxed)
    expect((relaxed as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ pace: 'relaxed' })

    // 再切回不选：payload 恢复无 pace（第二个表单独立渲染）
    cleanup()
    const reset = vi.fn()
    render(<PlanForm onSubmit={reset} loading={false} />)
    await user.type(screen.getByLabelText(/目的地/), '杭州')
    await user.click(screen.getByLabelText('紧凑'))
    await user.click(screen.getByLabelText('不选'))
    await user.click(screen.getByRole('button', { name: '生成行程' }))
    expect(reset.mock.calls[0][0]).not.toHaveProperty('pace')
  })

  it('节奏组是 radiogroup、默认均衡被说明、有阈值提示', () => {
    render(<PlanForm onSubmit={vi.fn()} loading={false} />)
    const group = screen.getByTestId('pace-radiogroup')
    expect(group).toHaveAttribute('role', 'radiogroup')
    const help = screen.getByTestId('pace-field').textContent ?? ''
    expect(help).toContain('默认均衡')
    expect(help).toContain('节奏是建议，不是保证')
  })

  it('选中档位显示对应阈值说明（均衡 → ≤6 站）', async () => {
    const user = userEvent.setup()
    render(<PlanForm onSubmit={vi.fn()} loading={false} />)
    await user.click(screen.getByLabelText('均衡'))
    expect(screen.getByTestId('pace-field').textContent).toContain('≤6 站/天')
  })
})

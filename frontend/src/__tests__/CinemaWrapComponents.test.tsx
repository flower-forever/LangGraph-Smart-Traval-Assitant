/**
 * 六期 S3 · 电影包装组件测试：片头标题卡（可跳过 + reduced 标注）、片尾 credits
 * （静态结构 + 定格标注 + reduced 标注）。零写入零网络；动画本体在真实浏览器验证。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CinemaTitleCard from '../components/CinemaTitleCard'
import CinemaCredits from '../components/CinemaCredits'

afterEach(cleanup)

describe('CinemaTitleCard · 片头标题卡', () => {
  it('渲染目的地与日期区间，data-reduced=false', () => {
    render(
      <CinemaTitleCard
        destination="杭州"
        dateRange="2026-04-03 ～ 2026-04-05"
        reducedMotion={false}
        onSkip={() => {}}
      />,
    )
    const card = screen.getByTestId('cinema-title-card')
    expect(card).toHaveTextContent('杭州')
    expect(card).toHaveTextContent('2026-04-03 ～ 2026-04-05')
    expect(card).toHaveTextContent('点击或按任意键跳过')
    expect(card).toHaveAttribute('data-reduced', 'false')
  })

  it('reduced-motion 时 data-reduced=true（样式降级在 CSS，组件不写分支逻辑）', () => {
    render(
      <CinemaTitleCard destination="成都" dateRange="2026-06-19" reducedMotion onSkip={() => {}} />,
    )
    expect(screen.getByTestId('cinema-title-card')).toHaveAttribute('data-reduced', 'true')
  })

  it('点击标题卡 = 跳过（onSkip 触发一次）', () => {
    const onSkip = vi.fn()
    render(
      <CinemaTitleCard destination="杭州" dateRange="2026-04-03" reducedMotion={false} onSkip={onSkip} />,
    )
    fireEvent.click(screen.getByTestId('cinema-title-card'))
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('纯装饰：挂载全程零存储写入', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    render(
      <CinemaTitleCard destination="杭州" dateRange="2026-04-03" reducedMotion={false} onSkip={() => {}} />,
    )
    expect(setItem).not.toHaveBeenCalled()
  })
})

describe('CinemaCredits · 片尾 credits', () => {
  it('渲染行程名、免责口径、箴言；滚动中 data-settled=false', () => {
    render(
      <CinemaCredits
        tripTitle="杭州三日漫步路书"
        subtitle="杭州 · 2026-04-03 ～ 2026-04-05"
        quote="走得慢一点，让风景追上你。"
        settled={false}
        reducedMotion={false}
      />,
    )
    const credits = screen.getByTestId('cinema-credits')
    expect(credits).toHaveTextContent('杭州三日漫步路书')
    expect(credits).toHaveTextContent('路线与时间仅为参考')
    expect(credits).toHaveTextContent('走得慢一点，让风景追上你。')
    expect(credits).toHaveAttribute('data-settled', 'false')
    expect(credits).toHaveAttribute('aria-hidden', 'true')
  })

  it('定格尾帧 data-settled=true；reduced-motion data-reduced=true', () => {
    render(
      <CinemaCredits
        tripTitle="成都五日"
        subtitle="成都 · 2026-06-19"
        quote="回程的行囊里，装着出发时没有的自己。"
        settled
        reducedMotion
      />,
    )
    const credits = screen.getByTestId('cinema-credits')
    expect(credits).toHaveAttribute('data-settled', 'true')
    expect(credits).toHaveAttribute('data-reduced', 'true')
  })

  it('零数据影响：挂载全程零存储写入', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    render(
      <CinemaCredits
        tripTitle="杭州三日漫步路书"
        subtitle="杭州 · 2026-04-03"
        quote="任何箴言"
        settled={false}
        reducedMotion={false}
      />,
    )
    expect(setItem).not.toHaveBeenCalled()
  })
})

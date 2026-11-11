/**
 * 六期 S3 · 节日印章测试（彩蛋②）：StampSeal 新增问候小字 prop 的组件层行为。
 *
 * 既有 StampSeal.test.tsx 不动：本文件只钉住新增 prop——有问候渲染小字、
 * 无问候（undefined / null）不渲染且 data-festival=false、纯装饰零写入。
 * App 层「仅规划成功触发 + 相交判定」由 AppEasterEggIntegration.test.tsx 钉住。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import StampSeal from '../components/StampSeal'

afterEach(cleanup)

describe('StampSeal · 节日问候小字（六期 S3 彩蛋②）', () => {
  it('传问候语时印章下渲染一行小字，data-festival=true', () => {
    render(<StampSeal reducedMotion={false} festivalGreeting="端午安康" />)
    const seal = screen.getByTestId('stamp-seal')
    expect(seal).toHaveTextContent('行程既定')
    expect(screen.getByTestId('stamp-seal-festival')).toHaveTextContent('端午安康')
    expect(seal).toHaveAttribute('data-festival', 'true')
  })

  it('不传（undefined）与传 null 都不渲染小字，data-festival=false（旧行为不变）', () => {
    const { unmount: unmount1 } = render(<StampSeal reducedMotion={false} />)
    expect(screen.queryByTestId('stamp-seal-festival')).toBeNull()
    expect(screen.getByTestId('stamp-seal')).toHaveAttribute('data-festival', 'false')
    unmount1()

    render(<StampSeal reducedMotion={false} festivalGreeting={null} />)
    expect(screen.queryByTestId('stamp-seal-festival')).toBeNull()
    expect(screen.getByTestId('stamp-seal')).toHaveAttribute('data-festival', 'false')
  })

  it('问候语仍然在 aria-hidden 容器内：不进读屏与 tab 序', () => {
    render(<StampSeal reducedMotion={false} festivalGreeting="中秋团圆" />)
    expect(screen.getByTestId('stamp-seal')).toHaveAttribute('aria-hidden', 'true')
  })

  it('零数据影响：带问候挂载全程零存储写入', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    render(<StampSeal reducedMotion={false} festivalGreeting="新春快乐" />)
    expect(setItem).not.toHaveBeenCalled()
  })
})

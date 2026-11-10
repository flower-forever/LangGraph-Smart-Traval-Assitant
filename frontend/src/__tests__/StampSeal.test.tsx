/**
 * 六期 S1 · 落印 StampSeal 组件测试：零数据影响 + data-reduced 标注。
 *
 * 边界对齐组件注释：pointer-events:none 在 CSS（app.css 有源码级契约测试），
 * 退场时机（2.5s+淡出）由 App 层计时器驱动（AppStampSealIntegration 钉住），
 * 这里钉住 DOM 层：aria-hidden、reduced-motion 标注、零存储写入。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import StampSeal from '../components/StampSeal'

afterEach(cleanup)

describe('StampSeal · 落印', () => {
  it('渲染印章面「行程既定」，aria-hidden 不进读屏', () => {
    render(<StampSeal reducedMotion={false} />)
    const seal = screen.getByTestId('stamp-seal')
    expect(seal).toHaveAttribute('aria-hidden', 'true')
    expect(seal).toHaveTextContent('行程既定')
    expect(seal).toHaveAttribute('data-reduced', 'false')
  })

  it('reduced-motion 时 data-reduced=true（样式降级分支在 CSS，被 motionTokens 测试钉住）', () => {
    render(<StampSeal reducedMotion />)
    expect(screen.getByTestId('stamp-seal')).toHaveAttribute('data-reduced', 'true')
  })

  it('零数据影响：挂载全程零存储写入', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    render(<StampSeal reducedMotion={false} />)
    expect(setItem).not.toHaveBeenCalled()
  })
})

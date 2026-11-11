/**
 * 六期 S7 · 绕行拦截卡组件测试。
 * 全离线：不读写 localStorage、不发请求；回调只断言被触发。
 * 覆盖：命中证据渲染 / 保留回调（本地立即收起）/ 去调整回调（第一条命中天）/
 * 无命中不渲染 / lazy 边界与轻量预筛。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import DetourInterceptCard from '../components/DetourInterceptCard'
import DetourInterceptCardContent from '../components/DetourInterceptContent'
import type { Trip, TripDay } from '../lib/api'

function stop(id: string, name: string, lng: number, lat: number) {
  return {
    id,
    name,
    time: '09:00',
    duration_minutes: 60,
    description: '',
    address: '',
    location: { lng, lat },
  }
}

function hitDay(dayNumber: number, prefix: string): TripDay {
  return {
    day: dayNumber,
    date: null,
    title: `第 ${dayNumber} 天`,
    summary: '',
    stops: [
      stop(`${prefix}-1`, `${prefix}起点`, 110.5465, 29.3455),
      stop(`${prefix}-2`, `${prefix}终点`, 110.478, 29.117),
    ],
    legs: [
      {
        from_stop_id: `${prefix}-1`,
        to_stop_id: `${prefix}-2`,
        mode: 'driving',
        route_type: 'navigation',
        distance_m: 97_200,
        duration_minutes: null,
        geometry: [],
        description: '',
      },
    ],
  }
}

function tripWith(days: TripDay[]): Trip {
  return {
    id: 'trip-detour',
    source: 'agent',
    destination: '张家界',
    title: '绕行拦截测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days,
  }
}

const hitTrip = tripWith([hitDay(1, '武陵源')])

afterEach(() => {
  cleanup()
})

describe('DetourInterceptCardContent · 证据与动作', () => {
  it('列全部命中路段与证据：天 / 站序 / 站名 / 直线 vs 规划 / 倍数', () => {
    render(<DetourInterceptCardContent trip={hitTrip} />)
    const card = screen.getByTestId('detour-intercept-card')

    expect(screen.getByTestId('detour-intercept-count')).toHaveTextContent('共 1 段')
    expect(screen.getByTestId('detour-intercept-badge')).toHaveTextContent('直线 × 实际里程')
    expect(card).toHaveTextContent('这些路段绕行较远，可能不是最优路线')
    expect(card).toHaveTextContent('第 1 天 · 第 1→2 站：武陵源起点 → 武陵源终点')
    expect(screen.getByTestId('detour-intercept-evidence-0')).toHaveTextContent(
      '依据：直线 26.3 km，规划 97.2 km（约 3.7 倍）',
    )
    expect(card).toHaveTextContent('保留后本次行程不再自动提示；体检卡里仍可查看')
    expect(screen.getByTestId('detour-intercept-keep')).toHaveTextContent('保留原样')
    expect(screen.getByTestId('detour-intercept-adjust')).toHaveTextContent('去调整')
  })

  it('多条命中全部列出；「去调整」传第一条命中的天号', () => {
    const onGoAdjust = vi.fn()
    render(
      <DetourInterceptCardContent
        trip={tripWith([hitDay(2, '甲'), hitDay(3, '乙')])}
        onGoAdjust={onGoAdjust}
      />,
    )
    expect(screen.getByTestId('detour-intercept-count')).toHaveTextContent('共 2 段')
    expect(screen.getByTestId('detour-intercept-hit-0')).toHaveAttribute('data-day', '2')
    expect(screen.getByTestId('detour-intercept-hit-1')).toHaveAttribute('data-day', '3')

    fireEvent.click(screen.getByTestId('detour-intercept-adjust'))
    expect(onGoAdjust).toHaveBeenCalledTimes(1)
    expect(onGoAdjust).toHaveBeenCalledWith(2)
  })

  it('「保留原样」调 onKeep，并立即收起卡片（父级再负责会话内不重弹）', () => {
    const onKeep = vi.fn()
    render(<DetourInterceptCardContent trip={hitTrip} onKeep={onKeep} />)

    fireEvent.click(screen.getByTestId('detour-intercept-keep'))
    expect(onKeep).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('detour-intercept-card')).toBeNull()
  })

  it('无命中：整卡不渲染（包括「未发现绕行」这类伪结论）', () => {
    const noHit = tripWith([
      {
        ...hitDay(1, '甲'),
        legs: [{ ...hitDay(1, '甲').legs[0], distance_m: 31_000 }],
      },
    ])
    const view = render(<DetourInterceptCardContent trip={noHit} />)
    expect(view.container).toBeEmptyDOMElement()
  })
})

describe('DetourInterceptCard · lazy 边界与预筛', () => {
  it('有 ≥30km 路段：lazy 解析后正常渲染', async () => {
    render(<DetourInterceptCard trip={hitTrip} />)
    expect(await screen.findByTestId('detour-intercept-card')).toBeInTheDocument()
    expect(screen.getByTestId('detour-intercept-count')).toHaveTextContent('共 1 段')
  })

  it('没有任何 ≥30km 路段：包装器直接不渲染，不出现 loading 残留', () => {
    const allShort = tripWith([
      {
        ...hitDay(1, '甲'),
        legs: [{ ...hitDay(1, '甲').legs[0], distance_m: 29_999 }],
      },
    ])
    const view = render(<DetourInterceptCard trip={allShort} />)
    expect(view.container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('detour-intercept-loading')).toBeNull()
  })

  it('有 ≥30km 路段但坐标缺失：最终不渲染，也不留 loading', async () => {
    const missingLocation = hitDay(1, '甲')
    missingLocation.stops[0] = { ...missingLocation.stops[0], location: null }
    const view = render(<DetourInterceptCard trip={tripWith([missingLocation])} />)

    await vi.waitFor(() => {
      expect(view.container).toBeEmptyDOMElement()
    })
    expect(screen.queryByTestId('detour-intercept-loading')).toBeNull()
  })
})

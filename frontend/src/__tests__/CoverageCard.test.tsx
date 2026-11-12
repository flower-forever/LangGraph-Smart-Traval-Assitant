/**
 * 六期 S6 · 选择充分度卡组件测试。
 * 全离线：不读写 localStorage、不发请求；加入候选池只断言回调被触发。
 * 覆盖：统计行 / 已覆盖 / 未安排+按钮回调 / 徽章与提示常驻 / 折叠 /
 * 未识别文案 / 无画像不渲染 / 无回调不渲染按钮 / 全覆盖分支 / lazy 边界。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CoverageCard from '../components/CoverageCard'
import CoverageCardContent from '../components/CoverageCardContent'
import type { CoveragePoolItem } from '../components/CoverageCardContent'
import type { Trip } from '../lib/api'

function tripWith(
  classics: Array<{ name: string; reason?: string }>,
  stopNames: string[],
): Trip {
  return {
    id: 'trip-cov',
    source: 'example',
    destination: '杭州',
    title: '充分度测试行程',
    summary: '',
    map_coordinate_system: 'WGS84',
    warnings: [],
    cityProfile: {
      source: 'model_generated',
      classicList: classics.map((item) => ({
        name: item.name,
        reason: item.reason ?? `${item.name}的理由`,
        source: 'model_generated' as const,
      })),
    },
    days: [
      {
        day: 1,
        date: null,
        title: '第一天',
        summary: '',
        legs: [],
        stops: stopNames.map((name, index) => ({
          id: `stop-${index}`,
          name,
          time: '09:00',
          duration_minutes: null,
          description: '',
          address: '',
          location: null,
        })),
      },
    ],
  }
}

const sampleTrip = tripWith(
  [
    { name: '苏堤春晓' },
    { name: '浙江省博物馆', reason: '镇馆之宝' },
    { name: '断桥' },
    { name: '灵隐寺' },
  ],
  ['苏堤春晓', '浙江省博物馆', '九溪烟树'],
)

afterEach(() => {
  cleanup()
})

describe('CoverageCardContent · 统计与清单', () => {
  it('统计行「已覆盖 2/4 · 未安排 2 条」、已覆盖徽片、未安排条目带理由与按钮', () => {
    render(<CoverageCardContent trip={sampleTrip} onAddToPool={() => {}} />)
    const card = screen.getByTestId('trip-coverage-card')

    expect(within(card).getByTestId('trip-coverage-summary')).toHaveTextContent(
      '已覆盖 2/4 · 未安排 2 条',
    )
    const covered = within(card).getByTestId('trip-coverage-covered')
    expect(within(covered).getByText('苏堤春晓')).toBeInTheDocument()
    expect(within(covered).getByText('浙江省博物馆')).toBeInTheDocument()

    const uncovered = within(card).getByTestId('trip-coverage-uncovered')
    expect(within(uncovered).getByText('经典清单里你还没安排')).toBeInTheDocument()
    expect(within(uncovered).getByText('断桥')).toBeInTheDocument()
    expect(within(uncovered).getByText('：断桥的理由')).toBeInTheDocument()
    expect(within(uncovered).getByTestId('trip-coverage-add-0')).toHaveTextContent('加入候选池')
    expect(within(uncovered).getByTestId('trip-coverage-add-1')).toBeInTheDocument()
  })

  it('未识别站点如实说明且不改统计', () => {
    render(<CoverageCardContent trip={sampleTrip} />)
    const note = screen.getByTestId('trip-coverage-unrecognized')
    expect(note).toHaveTextContent('1 个行程站点不在经典清单口径内')
    expect(note).toHaveTextContent('九溪烟树')
    expect(note).toHaveTextContent('未识别，未计入覆盖统计')
    expect(screen.getByTestId('trip-coverage-summary')).toHaveTextContent('已覆盖 2/4')
  })

  it('全部未覆盖：已覆盖区显示空态文案，统计 0/N', () => {
    render(
      <CoverageCardContent trip={tripWith([{ name: '断桥' }], ['某无名茶馆'])} />,
    )
    expect(screen.getByTestId('trip-coverage-summary')).toHaveTextContent('已覆盖 0/1 · 未安排 1 条')
    const covered = screen.getByTestId('trip-coverage-covered')
    expect(within(covered).getByText('行程还没有安排经典清单里的条目。')).toBeInTheDocument()
  })

  it('全覆盖：未安排区显示「都已安排」，无按钮', () => {
    render(<CoverageCardContent trip={tripWith([{ name: '断桥' }], ['断桥'])} onAddToPool={() => {}} />)
    expect(screen.getByTestId('trip-coverage-summary')).toHaveTextContent('已覆盖 1/1 · 未安排 0 条')
    const uncovered = screen.getByTestId('trip-coverage-uncovered')
    expect(within(uncovered).getByText('经典清单里的条目都已安排。')).toBeInTheDocument()
    expect(within(uncovered).queryByRole('button')).toBeNull()
  })

  it('未识别超过 12 个：只展示 12 个名字并如实收口「共 N 个」', () => {
    const stops = Array.from({ length: 14 }, (_, index) => `站点${index + 1}`)
    render(<CoverageCardContent trip={tripWith([{ name: '断桥' }], ['断桥', ...stops])} />)
    const note = screen.getByTestId('trip-coverage-unrecognized')
    expect(note).toHaveTextContent('14 个行程站点不在经典清单口径内')
    expect(note).toHaveTextContent('站点12')
    expect(note).toHaveTextContent('共 14 个')
    expect(note).not.toHaveTextContent('等 14 个')
  })
})

describe('CoverageCardContent · 加入候选池回调', () => {
  it('点击按钮发出 {name, reason}；按钮变「已加入候选池 ✓」且不可重复点击', () => {
    const onAddToPool = vi.fn()
    render(<CoverageCardContent trip={sampleTrip} onAddToPool={onAddToPool} />)
    const button = screen.getByTestId('trip-coverage-add-0')
    fireEvent.click(button)

    expect(onAddToPool).toHaveBeenCalledTimes(1)
    const item = onAddToPool.mock.calls[0]![0] as CoveragePoolItem
    expect(item.name).toBe('断桥')
    expect(item.reason).toBe('断桥的理由')

    const clicked = screen.getByTestId('trip-coverage-add-0')
    expect(clicked).toHaveTextContent('已加入候选池 ✓')
    expect(clicked).toBeDisabled()

    fireEvent.click(clicked)
    expect(onAddToPool).toHaveBeenCalledTimes(1)
  })

  it('未提供 onAddToPool：不渲染按钮，卡片只读', () => {
    render(<CoverageCardContent trip={sampleTrip} />)
    expect(screen.queryByRole('button', { name: '加入候选池' })).toBeNull()
    expect(screen.getByTestId('trip-coverage-uncovered')).toBeInTheDocument()
  })
})

describe('CoverageCardContent · 徽章 / 提示 / 折叠', () => {
  it('「AI 生成·供参考」徽章与「不构成权威必去」提示常驻', () => {
    render(<CoverageCardContent trip={sampleTrip} />)
    expect(screen.getByTestId('trip-coverage-badge')).toHaveTextContent('AI 生成·供参考')
    const disclaimer = screen.getByTestId('trip-coverage-disclaimer')
    expect(disclaimer).toHaveTextContent('仅供选择参考')
    expect(disclaimer).toHaveTextContent('不构成权威必去推荐')
    expect(disclaimer).toHaveTextContent('出发前请自行确认')
    expect(screen.queryByText(/必去清单|权威排名/)).toBeNull()
  })

  it('默认展开；收起后正文移除，统计行、徽章与提示仍在', () => {
    render(<CoverageCardContent trip={sampleTrip} />)
    const toggle = screen.getByTestId('trip-coverage-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('trip-coverage-body')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('trip-coverage-body')).toBeNull()
    expect(screen.getByTestId('trip-coverage-summary')).toHaveTextContent('已覆盖 2/4 · 未安排 2 条')
    expect(screen.getByTestId('trip-coverage-badge')).toBeInTheDocument()
    expect(screen.getByTestId('trip-coverage-disclaimer')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.getByTestId('trip-coverage-body')).toBeInTheDocument()
  })

  it('defaultOpen=false 时初始收起', () => {
    render(<CoverageCardContent trip={sampleTrip} defaultOpen={false} />)
    expect(screen.queryByTestId('trip-coverage-body')).toBeNull()
    expect(screen.getByTestId('trip-coverage-toggle')).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('CoverageCardContent · 降级', () => {
  it('无 cityProfile / 无 classicList：整卡不渲染', () => {
    // classicList 映射后为空数组 → 投影 null → 不渲染（也不显示 0/0 伪统计）
    const emptyClassics = render(<CoverageCardContent trip={tripWith([], [])} />)
    expect(screen.queryByTestId('trip-coverage-card')).toBeNull()
    emptyClassics.unmount()

    const nullTrip = render(<CoverageCardContent trip={null} />)
    expect(nullTrip.container).toBeEmptyDOMElement()
    nullTrip.unmount()

    const undefinedTrip = render(<CoverageCardContent />)
    expect(undefinedTrip.container).toBeEmptyDOMElement()
  })
})

describe('CoverageCard · lazy 边界', () => {
  it('默认导出经 React.lazy 解析后正常渲染', async () => {
    render(<CoverageCard trip={sampleTrip} />)
    expect(await screen.findByTestId('trip-coverage-card')).toBeInTheDocument()
    expect(screen.getByTestId('trip-coverage-badge')).toHaveTextContent('AI 生成·供参考')
  })

  it('wrapper 对无 classicList 的 trip 直接不渲染、无 loading 残留', () => {
    const bareTrip = { ...sampleTrip, cityProfile: undefined } as unknown as Trip
    const view = render(<CoverageCard trip={bareTrip} />)
    expect(view.container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('trip-coverage-loading')).toBeNull()
  })
})

/**
 * 六期 S4 · 城市导览卡组件测试。
 * 全离线：不读写 localStorage、不发请求；折叠只影响组件内状态。
 * 覆盖：五块完整渲染、徽章/提示常驻、折叠、缺字段降级、无画像不渲染、坏块降级。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import CityProfileCard from '../components/CityProfileCard'
import CityProfileCardContent from '../components/CityProfileCardContent'
import type { CityProfile } from '../lib/api'

const fullProfile: CityProfile = {
  source: 'model_generated',
  oneLineImpression: { text: '湖山相映的慢城', source: 'model_generated' },
  suggestedDays: { min: 2, max: 4, source: 'model_generated' },
  districts: [
    {
      name: '西湖',
      summary: '湖景与老街',
      attractions: ['断桥', '苏堤'],
      source: 'model_generated',
    },
    {
      name: '灵隐',
      summary: '山林古寺',
      attractions: ['灵隐寺'],
      source: 'model_generated',
    },
    {
      name: '河坊街',
      summary: '市井小吃',
      attractions: ['河坊街', '南宋御街'],
      source: 'model_generated',
    },
  ],
  seasonTips: { text: '春季多雨，带伞', source: 'model_generated' },
  classicList: Array.from({ length: 10 }, (_, index) => ({
    name: `经典${index + 1}`,
    reason: `理由${index + 1}`,
    source: 'model_generated' as const,
  })),
}

afterEach(() => {
  cleanup()
})

describe('CityProfileCard · 完整画像', () => {
  it('五块内容全部渲染，徽章与「出发前请自行确认」提示常驻', () => {
    render(<CityProfileCardContent cityProfile={fullProfile} />)
    const card = screen.getByTestId('city-profile-card')

    expect(within(card).getByTestId('city-profile-badge')).toHaveTextContent('AI 生成·供参考')
    expect(within(card).getByTestId('city-profile-disclaimer')).toHaveTextContent('出发前请自行确认')

    expect(within(card).getByText('湖山相映的慢城')).toBeInTheDocument()
    expect(within(card).getByText('建议游玩 2–4 天')).toBeInTheDocument()
    expect(within(card).getByText('西湖')).toBeInTheDocument()
    expect(within(card).getByText('代表景点：断桥、苏堤')).toBeInTheDocument()
    expect(within(card).getByText('春季多雨，带伞')).toBeInTheDocument()
    expect(within(card).getByText('经典清单 · 10 条')).toBeInTheDocument()
    expect(within(card).getByText('经典1')).toBeInTheDocument()
    expect(within(card).getByText('：理由1')).toBeInTheDocument()
  })
})

describe('CityProfileCard · 折叠', () => {
  it('默认展开；点击收起后正文移除，徽章与提示仍在，aria-expanded 正确', () => {
    render(<CityProfileCardContent cityProfile={fullProfile} />)
    const toggle = screen.getByTestId('city-profile-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('city-profile-body')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('city-profile-body')).toBeNull()
    expect(screen.getByTestId('city-profile-badge')).toBeInTheDocument()
    expect(screen.getByTestId('city-profile-disclaimer')).toBeInTheDocument()

    fireEvent.click(toggle)
    expect(screen.getByTestId('city-profile-body')).toBeInTheDocument()
  })

  it('defaultOpen=false 时初始收起', () => {
    render(<CityProfileCardContent cityProfile={fullProfile} defaultOpen={false} />)
    expect(screen.queryByTestId('city-profile-body')).toBeNull()
    expect(screen.getByTestId('city-profile-toggle')).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('CityProfileCard · 缺字段降级', () => {
  it('只有一句话印象时，其余四块显示「未提供」', () => {
    render(
      <CityProfileCardContent
        cityProfile={{
          source: 'model_generated',
          oneLineImpression: { text: '只有这一句', source: 'model_generated' },
        }}
      />,
    )
    const card = screen.getByTestId('city-profile-card')
    expect(within(card).getByText('只有这一句')).toBeInTheDocument()
    for (const id of [
      'city-profile-days',
      'city-profile-districts',
      'city-profile-season',
      'city-profile-classics',
    ]) {
      expect(within(within(card).getByTestId(id)).getByText('未提供')).toBeInTheDocument()
    }
  })

  it('无 cityProfile / 空画像：整卡不渲染', () => {
    const nullRender = render(<CityProfileCardContent cityProfile={null} />)
    expect(nullRender.container).toBeEmptyDOMElement()
    nullRender.unmount()

    const undefinedRender = render(<CityProfileCardContent />)
    expect(undefinedRender.container).toBeEmptyDOMElement()
    undefinedRender.unmount()

    const emptyRender = render(<CityProfileCardContent cityProfile={{ source: 'model_generated' }} />)
    expect(emptyRender.container).toBeEmptyDOMElement()
  })

  it('坏块逐块降级，不影响其它块渲染', () => {
    const malformed = {
      source: 'model_generated',
      // 文本块兼容裸字符串（后端正常不会这样，但旧数据/手写备份可能）
      oneLineImpression: '裸字符串也接受',
      // min > max 视为未提供
      suggestedDays: { min: 5, max: 2, source: 'model_generated' },
      // 非数组视为未提供
      districts: 'nope',
      // 空白文本视为未提供
      seasonTips: { text: '   ', source: 'model_generated' },
      // 空名称条目被丢弃
      classicList: [{ name: '', reason: '无效', source: 'model_generated' }],
    } as unknown as CityProfile

    render(<CityProfileCardContent cityProfile={malformed} />)
    const card = screen.getByTestId('city-profile-card')
    expect(within(card).getByText('裸字符串也接受')).toBeInTheDocument()
    for (const id of [
      'city-profile-days',
      'city-profile-districts',
      'city-profile-season',
      'city-profile-classics',
    ]) {
      expect(within(within(card).getByTestId(id)).getByText('未提供')).toBeInTheDocument()
    }
  })
})

describe('CityProfileCard · 数量上限', () => {
  it('片区最多 6 个、经典清单最多 15 条、每片区代表景点最多 3 个', () => {
    const oversized = {
      source: 'model_generated',
      districts: Array.from({ length: 8 }, (_, index) => ({
        name: `片区${index + 1}`,
        summary: '',
        attractions: ['A', 'B', 'C', 'D'],
        source: 'model_generated',
      })),
      classicList: Array.from({ length: 20 }, (_, index) => ({
        name: `清单${index + 1}`,
        reason: '',
        source: 'model_generated',
      })),
    } as unknown as CityProfile

    render(<CityProfileCardContent cityProfile={oversized} />)
    const districts = screen.getByTestId('city-profile-districts')
    expect(within(districts).getAllByRole('listitem')).toHaveLength(6)
    expect(
      within(within(districts).getAllByRole('listitem')[0]).getByText('代表景点：A、B、C'),
    ).toBeInTheDocument()

    const classics = screen.getByTestId('city-profile-classics')
    expect(within(classics).getAllByRole('listitem')).toHaveLength(15)
    expect(within(classics).queryByText('清单16')).toBeNull()
  })
})

describe('CityProfileCard · lazy 边界', () => {
  it('默认导出经 React.lazy 解析后正常渲染', async () => {
    render(<CityProfileCard cityProfile={fullProfile} />)
    expect(await screen.findByTestId('city-profile-card')).toBeInTheDocument()
    expect(screen.getByTestId('city-profile-badge')).toHaveTextContent('AI 生成·供参考')
  })
})


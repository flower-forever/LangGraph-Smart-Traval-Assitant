/**
 * 七期 S6 · 城市导览卡多城徽标测试。
 * 全离线：不读写 localStorage、不发请求。
 * 覆盖：传 cityName 显示徽标 / 不传与空白不显示（单城 DOM 旧形态）/
 * 折叠后徽标仍在 / lazy 包装器透传。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import CityProfileCard from '../components/CityProfileCard'
import CityProfileCardContent from '../components/CityProfileCardContent'
import type { CityProfile } from '../lib/api'

const profile: CityProfile = {
  source: 'model_generated',
  oneLineImpression: { text: '湖山相映的慢城', source: 'model_generated' },
}

afterEach(() => {
  cleanup()
})

describe('CityProfileCardContent · 城市徽标', () => {
  it('传入 cityName：标题区显示该城徽标，卡片内容不变', () => {
    render(<CityProfileCardContent cityProfile={profile} cityName="杭州" />)

    expect(screen.getByTestId('city-profile-city')).toHaveTextContent('杭州')
    expect(screen.getByTestId('city-profile-card')).toBeInTheDocument()
    expect(screen.getByText('城市导览')).toBeInTheDocument()
    expect(screen.getByText('湖山相映的慢城')).toBeInTheDocument()
  })

  it('不传 cityName：无城市徽标（单城旧 DOM 不变）', () => {
    render(<CityProfileCardContent cityProfile={profile} />)

    expect(screen.queryByTestId('city-profile-city')).toBeNull()
    expect(screen.getByTestId('city-profile-card')).toBeInTheDocument()
    expect(screen.getByTestId('city-profile-badge')).toHaveTextContent('AI 生成·供参考')
  })

  it('空白 cityName 按未提供处理，不渲染空徽标', () => {
    render(<CityProfileCardContent cityProfile={profile} cityName="   " />)
    expect(screen.queryByTestId('city-profile-city')).toBeNull()
  })

  it('cityName 首尾空白被 trim', () => {
    render(<CityProfileCardContent cityProfile={profile} cityName=" 苏州 " />)
    expect(screen.getByTestId('city-profile-city')).toHaveTextContent(/^苏州$/)
  })

  it('折叠后正文移除，城市徽标、AI 徽章与提示仍在', () => {
    render(<CityProfileCardContent cityProfile={profile} cityName="杭州" />)

    fireEvent.click(screen.getByTestId('city-profile-toggle'))
    expect(screen.queryByTestId('city-profile-body')).toBeNull()
    expect(screen.getByTestId('city-profile-city')).toHaveTextContent('杭州')
    expect(screen.getByTestId('city-profile-badge')).toBeInTheDocument()
    expect(screen.getByTestId('city-profile-disclaimer')).toBeInTheDocument()
  })
})

describe('CityProfileCard · lazy 包装器透传 cityName', () => {
  it('默认导出经 React.lazy 解析后显示城市徽标', async () => {
    render(<CityProfileCard cityProfile={profile} cityName="苏州" />)
    expect(await screen.findByTestId('city-profile-city')).toHaveTextContent('苏州')
  })
})

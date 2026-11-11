/**
 * 六期 S4 · 城市导览契约兼容测试。
 * 旧行程（无 cityProfile）与新行程（带 cityProfile）必须同时通过
 * isTripLike / checkTripShape；投影对坏块逐块降级。
 */
import { describe, expect, it } from 'vitest'
import { isTripLike } from '../lib/api'
import type { CityProfile, Trip } from '../lib/api'
import { projectCityProfile } from '../lib/cityProfile'
import { checkTripShape } from '../lib/savedTrips'

const oldTrip: Trip = {
  id: 'trip-old',
  source: 'agent',
  destination: '杭州',
  title: '旧行程',
  summary: '',
  map_coordinate_system: 'WGS84',
  warnings: [],
  days: [
    {
      day: 1,
      date: null,
      title: '第1天',
      summary: '',
      stops: [
        {
          id: 's1',
          name: '西湖',
          time: '09:00',
          duration_minutes: 90,
          description: '',
          address: '',
          location: null,
        },
      ],
      legs: [],
    },
  ],
}

const profile: CityProfile = {
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
  ],
  seasonTips: { text: '春季多雨，带伞', source: 'model_generated' },
  classicList: [{ name: '灵隐寺', reason: '山林古寺', source: 'model_generated' }],
}

describe('城市导览契约兼容', () => {
  it('旧行程无 cityProfile：isTripLike 与 checkTripShape 照常放行', () => {
    expect(isTripLike(oldTrip)).toBe(true)
    expect(checkTripShape(oldTrip).ok).toBe(true)
  })

  it('新行程带 cityProfile：两形态都放行', () => {
    const newTrip = { ...oldTrip, cityProfile: profile }
    expect(isTripLike(newTrip)).toBe(true)
    expect(checkTripShape(newTrip).ok).toBe(true)
  })

  it('cityProfile: null 也放行（后端无画像时的响应形态）', () => {
    expect(isTripLike({ ...oldTrip, cityProfile: null })).toBe(true)
    expect(checkTripShape({ ...oldTrip, cityProfile: null }).ok).toBe(true)
  })

  it('cityProfile 不是对象：拒绝整份行程（结构性坏数据）', () => {
    expect(isTripLike({ ...oldTrip, cityProfile: 'oops' })).toBe(false)
    expect(checkTripShape({ ...oldTrip, cityProfile: 'oops' }).ok).toBe(false)
  })
})

describe('projectCityProfile 投影', () => {
  it('完整画像：五块都有值，经典清单可供 S6 复用', () => {
    const view = projectCityProfile(profile)
    expect(view).not.toBeNull()
    expect(view?.oneLineImpression).toBe('湖山相映的慢城')
    expect(view?.suggestedDays).toEqual({ min: 2, max: 4 })
    expect(view?.districts[0]).toEqual({
      name: '西湖',
      summary: '湖景与老街',
      attractions: ['断桥', '苏堤'],
    })
    expect(view?.seasonTips).toBe('春季多雨，带伞')
    expect(view?.classicList).toEqual([{ name: '灵隐寺', reason: '山林古寺' }])
  })

  it('无画像 / 空画像 / 全坏块：返回 null（组件据此不渲染）', () => {
    expect(projectCityProfile(null)).toBeNull()
    expect(projectCityProfile(undefined)).toBeNull()
    expect(projectCityProfile({ source: 'model_generated' })).toBeNull()
    expect(
      projectCityProfile({
        source: 'model_generated',
        districts: 'nope',
        classicList: [{ name: '', reason: '', source: 'model_generated' }],
      } as unknown as CityProfile),
    ).toBeNull()
  })
})

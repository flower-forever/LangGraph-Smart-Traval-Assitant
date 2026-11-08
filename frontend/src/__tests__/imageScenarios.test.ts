/**
 * dev-stub imageScenarios fixture 形状测试（离线，纯数据）：
 * - 8 个场景齐备，失败信封不携带条目；
 * - available 场景条目 URL 全部在白名单主机上（与 lib/imageSources 校验一致）；
 * - resolveImageSearchScenario 回填 requested_query；未知场景折算 failed。
 */
import { describe, expect, it } from 'vitest'

import {
  IMAGE_SEARCH_SCENARIOS,
  resolveImageSearchScenario,
} from '../../dev-stub/imageScenarios.mjs'
import {
  isWhitelistedImageUrl,
  validateImageSearchReport,
  type ImageSearchReport,
} from '../lib/imageSources'

const SCENARIO_NAMES = [
  'available_many',
  'available_single',
  'no_candidates',
  'invalid_request',
  'timeout',
  'rate_limited',
  'unavailable',
  'failed',
] as const

describe('dev-stub imageScenarios（fixture 数据形状）', () => {
  it('8 个场景齐备', () => {
    for (const name of SCENARIO_NAMES) {
      expect(IMAGE_SEARCH_SCENARIOS[name], `缺少场景 ${name}`).toBeTruthy()
    }
  })

  it('available 场景条目 URL 全部通过前端白名单校验；无署名条目存在于 available_many', () => {
    for (const name of ['available_many', 'available_single'] as const) {
      const scenario = IMAGE_SEARCH_SCENARIOS[name] as {
        items: Array<{ thumbUrl: string; imageUrl: string; descriptionUrl: string }>
      }
      expect(scenario.items.length).toBeGreaterThan(0)
      for (const item of scenario.items) {
        expect(isWhitelistedImageUrl(item.thumbUrl, 'upload.wikimedia.org')).toBe(true)
        expect(isWhitelistedImageUrl(item.imageUrl, 'upload.wikimedia.org')).toBe(true)
        expect(isWhitelistedImageUrl(item.descriptionUrl, 'commons.wikimedia.org')).toBe(true)
      }
    }
    const many = IMAGE_SEARCH_SCENARIOS.available_many as { items: Array<{ artist: string | null }> }
    expect(many.items.some((item) => item.artist === null)).toBe(true)
  })

  it('失败信封不携带条目；invalid_request 的 requested_query 为 null', () => {
    for (const name of ['no_candidates', 'invalid_request', 'timeout', 'rate_limited', 'unavailable', 'failed'] as const) {
      const scenario = IMAGE_SEARCH_SCENARIOS[name] as ImageSearchReport
      expect(scenario.items).toHaveLength(0)
    }
    expect(
      (IMAGE_SEARCH_SCENARIOS.invalid_request as ImageSearchReport).requested_query,
    ).toBeNull()
  })

  it('resolveImageSearchScenario：场景前缀选择 + requested_query 回填 + 未知场景折算 failed', () => {
    const resolved = resolveImageSearchScenario('场景:timeout') as ImageSearchReport
    expect(resolved.status).toBe('timeout')
    expect(resolved.requested_query).toBe('场景:timeout')
    expect(validateImageSearchReport(resolved, '场景:timeout').ok).toBe(true)

    const available = resolveImageSearchScenario('西湖') as ImageSearchReport
    expect(available.status).toBe('available')
    expect(validateImageSearchReport(available, '西湖').ok).toBe(true)

    const unknown = resolveImageSearchScenario('场景:不存在') as ImageSearchReport
    expect(unknown.status).toBe('failed')
    expect(unknown.requested_query).toBe('场景:不存在')
  })
})

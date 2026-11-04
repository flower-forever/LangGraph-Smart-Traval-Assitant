/**
 * Tavily 网页资料搜索的真实后端信封形状（以 tavily_web_client.py 为准）。
 * 仅测试用；不发起网络请求。
 */
import type { WebSearchReport, WebSearchResult } from '../../lib/webSources'

export function makeWebSearchResult(
  overrides: Partial<WebSearchResult> = {},
): WebSearchResult {
  return {
    title: '杭州西湖旅游攻略',
    url: 'https://www.example-travel.com/xihu-guide',
    snippet: '西湖位于杭州市西湖区。',
    snippet_truncated: false,
    publication_date: '2025-06-01',
    ...overrides,
  }
}

export function makeWebSearchReport(
  overrides: Partial<WebSearchReport> = {},
): WebSearchReport {
  return {
    status: 'available',
    reason: null,
    provider_http_status: 200,
    checked_at: '2026-11-03T08:00:00+00:00',
    fetched_at: '2026-11-03T08:00:01+00:00',
    requested_query: '西湖 旅游',
    max_results: 3,
    results_seen: 1,
    results: [makeWebSearchResult()],
    notes: [],
    source: {
      provider: 'tavily',
      endpoint: 'https://api.tavily.com/search',
      docs_url: 'https://docs.tavily.com/api-reference/endpoint/search',
    },
    content_status: 'unverified',
    ...overrides,
  }
}

/**
 * Wikimedia Commons 图片搜索的真实后端信封形状（以 image_sources_client.py
 * 的 ImageSearchReport / ImageSearchItem 为准）。仅测试用；不发起网络请求。
 * URL 一律用白名单主机（upload.wikimedia.org / commons.wikimedia.org），
 * 与 lib/imageSources.ts 的校验口径一致。
 */
import type { ImageSearchItem, ImageSearchReport } from '../../lib/imageSources'

export function makeImageSearchItem(
  overrides: Partial<ImageSearchItem> = {},
): ImageSearchItem {
  return {
    title: 'File:West Lake Hangzhou.jpg',
    thumbUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/West_Lake_Hangzhou.jpg/320px-West_Lake_Hangzhou.jpg',
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/West_Lake_Hangzhou.jpg',
    descriptionUrl: 'https://commons.wikimedia.org/wiki/File:West_Lake_Hangzhou.jpg',
    license: 'CC BY-SA 4.0',
    artist: '示例摄影师',
    width: 4032,
    height: 3024,
    ...overrides,
  }
}

export function makeImageSearchReport(
  overrides: Partial<ImageSearchReport> = {},
): ImageSearchReport {
  return {
    status: 'available',
    reason: null,
    provider_http_status: 200,
    checked_at: '2026-11-08T08:00:00+00:00',
    fetched_at: '2026-11-08T08:00:01+00:00',
    requested_query: '西湖',
    max_results: 10,
    results_seen: 2,
    items: [makeImageSearchItem()],
    notes: [],
    source: {
      provider: 'wikimedia-commons',
      endpoint: 'https://commons.wikimedia.org/w/api.php',
      docs_url: 'https://www.mediawiki.org/wiki/API:Search',
      attribution_url:
        'https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia',
      data_source: 'Wikimedia Commons',
    },
    ...overrides,
  }
}

/** 无署名条目（artist=null）：前端不得提供收进（CC 协议要求）。 */
export function makeImageSearchItemWithoutArtist(
  overrides: Partial<ImageSearchItem> = {},
): ImageSearchItem {
  return makeImageSearchItem({
    title: 'File:No Artist Unknown.jpg',
    thumbUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/No_Artist_Unknown.jpg/320px-No_Artist_Unknown.jpg',
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/c/cd/No_Artist_Unknown.jpg',
    descriptionUrl: 'https://commons.wikimedia.org/wiki/File:No_Artist_Unknown.jpg',
    license: 'CC0',
    artist: null,
    ...overrides,
  })
}

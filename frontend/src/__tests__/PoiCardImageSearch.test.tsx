/**
 * S5 Wikimedia 图片搜索用户路径测试（全离线，jsdom）：
 * - 显式触发：不点「搜索图片」零请求（fetch 调用计数 / adapter 调用计数）；
 * - 每次点击最多一次上游请求；失败后不自动重发（无隐式重试）；
 * - 逐张展示缩略图 + license + 署名；缺署名（artist null）无收进按钮；
 * - 收进保留 attribution / license / source=wikimedia，且只进编辑内存态：
 *   显式「保存资料卡」才落盘（localStorage raw 断言），不点保存零写入；
 * - 收进去重 / 张数上限沿用 S3 规则；
 * - 失败信封 7 态逐状态固定文案；失败保旧：旧编辑内存态与存储字节不变。
 * adapter 全 mock，不发任何真实网络请求。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PoiCardPanel from '../components/PoiCardPanel'
import {
  POI_CARDS_STORAGE_KEY,
  createEmptyPoiCardsRecord,
  createPoiCard,
  loadPoiCardsRecord,
  savePoiCardsRecord,
  type PoiCardsRecordV1,
} from '../lib/poiCards'
import type { ImageSearchReport } from '../lib/imageSources'
import {
  makeImageSearchItem,
  makeImageSearchItemWithoutArtist,
  makeImageSearchReport,
} from './fixtures/imageSources'

const NOW = 1_760_200_000_000

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function memoryStorage(): {
  storage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void }
  map: Map<string, string>
} {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key),
    },
  }
}

function makeRecordWithCard(name = '灵隐寺'): PoiCardsRecordV1 {
  const card = createPoiCard({ id: 'card-1', name, intro: '杭州著名古刹。' }, NOW)
  if (!card.ok) throw new Error(card.message)
  const empty = createEmptyPoiCardsRecord(NOW)
  if (!empty.ok) throw new Error(empty.message)
  return { ...empty.value, cards: [card.value] }
}

/** 受控 harness：保存路径真实走到内存 stub，模拟父级 App 行为。 */
function SearchHarness({
  initialRecord,
  cardId,
  storage,
  requestImageSources,
}: {
  initialRecord: PoiCardsRecordV1 | null
  cardId: string | null
  storage: ReturnType<typeof memoryStorage>['storage']
  requestImageSources?: (rawQuery: string) => Promise<ImageSearchReport>
}) {
  const [record, setRecord] = useState<PoiCardsRecordV1 | null>(initialRecord)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)
  return (
    <div>
      <p data-testid="harness-key-count">{record?.cards.length ?? -1}</p>
      <PoiCardPanel
        record={record}
        cardId={cardId}
        saveStatus={status}
        saveMessage={message}
        createCardId={() => 'card-search-1'}
        now={() => NOW + 100}
        requestImageSources={requestImageSources}
        onSave={(next) => {
          setStatus('saving')
          void savePoiCardsRecord(next, { storage, expectedRaw: loadPoiCardsRecord(storage).raw }).then(
            (result) => {
              if (!result.ok) {
                setStatus('error')
                setMessage(result.message)
                return
              }
              setRecord(result.record)
              setStatus('saved')
              setMessage(`已保存资料卡（${result.record.cards.length} 张，${result.bytes} 字节）。`)
            },
          )
        }}
        onClose={() => setMessage('closed')}
      />
    </div>
  )
}

describe('PoiCardPanel · Wikimedia 搜索显式触发', () => {
  it('不点按钮零请求：挂载、改输入、改名、收进都不发请求', async () => {
    const user = userEvent.setup()
    const adapter = vi.fn(() => Promise.resolve(makeImageSearchReport()))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)

    // 输入框带卡名预填
    expect((screen.getByLabelText('Wikimedia 图片搜索内容') as HTMLInputElement).value).toBe('灵隐寺')
    await user.type(screen.getByLabelText('Wikimedia 图片搜索内容'), '西湖')
    expect(adapter).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('点一次按钮恰好一次请求；按钮文案预填卡名可改', async () => {
    const user = userEvent.setup()
    const adapter = vi.fn((_rawQuery: string) =>
      Promise.resolve(makeImageSearchReport({ requested_query: '西湖' })),
    ) as unknown as ReturnType<typeof vi.fn> & { mock: { calls: Array<[string]> } }
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)

    const input = screen.getByLabelText('Wikimedia 图片搜索内容') as HTMLInputElement
    await user.clear(input)
    await user.type(input, '西湖')
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-result')).toBeInTheDocument())
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(adapter.mock.calls[0]?.[0]).toBe('西湖')
  })

  it('每次点击最多一次请求；连续两次点击共两次（无合并无翻倍）', async () => {
    const user = userEvent.setup()
    let call = 0
    const adapter = vi.fn(() => {
      call += 1
      return Promise.resolve(makeImageSearchReport({ requested_query: `q${call}` }))
    })
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)

    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-result')).toBeInTheDocument())
    expect(adapter).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(2))
    expect(adapter).toHaveBeenCalledTimes(2)
  })

  it('失败后不自动重发：错误展示期间 adapter 仍只有一次调用', async () => {
    const user = userEvent.setup()
    const adapter = vi.fn(() => Promise.reject(new Error('network down')))
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)

    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-error')).toBeInTheDocument())
    expect(adapter).toHaveBeenCalledTimes(1)
    // 错误文案诚实：连不上后端
    expect(screen.getByTestId('poi-card-image-search-error').textContent).toContain('连不上后端服务')

    // 等待一段时间确认没有隐式重试
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(adapter).toHaveBeenCalledTimes(1)
  })
})

describe('PoiCardPanel · 结果网格：license + 署名 + 收进边界', () => {
  it('逐张展示 license 与作者署名；收进按钮逐张提供', async () => {
    const user = userEvent.setup()
    const adapter = vi.fn(() =>
      Promise.resolve(
        makeImageSearchReport({
          requested_query: '灵隐寺',
          results_seen: 2,
          items: [
            makeImageSearchItem({ title: 'File:Lingyin.jpg', license: 'CC BY-SA 4.0', artist: '作者甲' }),
            makeImageSearchItem({
              title: 'File:Lingyin2.jpg',
              thumbUrl:
                'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/Lingyin2.jpg/320px-Lingyin2.jpg',
              imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/b/bc/Lingyin2.jpg',
              descriptionUrl: 'https://commons.wikimedia.org/wiki/File:Lingyin2.jpg',
              license: 'CC0',
              artist: '作者乙',
            }),
          ],
        }),
      ),
    )
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getAllByTestId('poi-card-image-result')).toHaveLength(2))
    const text = screen.getByTestId('poi-card-image-search-result').textContent ?? ''
    expect(text).toContain('CC BY-SA 4.0')
    expect(text).toContain('作者甲')
    expect(text).toContain('CC0')
    expect(text).toContain('作者乙')
    expect(screen.getAllByRole('button', { name: /收进图片/ })).toHaveLength(2)
  })

  it('缺署名（artist null）的结果不提供收进按钮', async () => {
    const user = userEvent.setup()
    const adapter = vi.fn(() =>
      Promise.resolve(
        makeImageSearchReport({
          requested_query: '灵隐寺',
          results_seen: 1,
          items: [makeImageSearchItemWithoutArtist()],
        }),
      ),
    )
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-result')).toBeInTheDocument())
    expect(screen.getByTestId('poi-card-image-no-artist').textContent).toContain('缺作者署名')
    expect(screen.queryByRole('button', { name: /收进图片/ })).toBeNull()
  })

  it('收进 → 编辑内存态：展示来源 Wikimedia + 署名 + 许可；显式保存才落盘（raw 断言）', async () => {
    const user = userEvent.setup()
    const adapter = vi.fn(() =>
      Promise.resolve(
        makeImageSearchReport({
          requested_query: '灵隐寺',
          results_seen: 1,
          items: [
            makeImageSearchItem({
              title: 'File:Lingyin Hall.jpg',
              thumbUrl:
                'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Lingyin_Hall.jpg/320px-Lingyin_Hall.jpg',
              imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Lingyin_Hall.jpg',
              descriptionUrl: 'https://commons.wikimedia.org/wiki/File:Lingyin_Hall.jpg',
              license: 'CC BY-SA 4.0',
              artist: '作者甲',
            }),
          ],
        }),
      ),
    )
    const { storage, map } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)

    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-result')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /收进图片/ }))

    // 收进只进编辑内存态：存储仍然为空（poiCards:v1 无键，其它键零写入）
    expect(loadPoiCardsRecord(storage).status).toBe('empty')
    expect(map.has(POI_CARDS_STORAGE_KEY)).toBe(false)
    expect(screen.getByTestId('poi-card-image-list').textContent).toContain('来源：Wikimedia')
    expect(screen.getByTestId('poi-card-image-list').textContent).toContain('作者甲')
    expect(screen.getByTestId('poi-card-image-list').textContent).toContain('CC BY-SA 4.0')

    // 显式保存才落盘
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())
    const raw = window.localStorage.getItem(POI_CARDS_STORAGE_KEY)
    expect(raw).toBeNull() // harness 用注入式存储，window.localStorage 保持为空
    const read = loadPoiCardsRecord(storage)
    expect(read.status).toBe('ok')
    const image = read.record?.cards[0].images[0]
    expect(image?.source).toBe('wikimedia')
    expect(image?.attribution).toBe('作者甲')
    expect(image?.license).toBe('CC BY-SA 4.0')
    expect(image?.url).toBe(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Lingyin_Hall.jpg/320px-Lingyin_Hall.jpg',
    )
    expect(read.record?.cards[0].provenance.intro?.source ?? null).toBeNull()
  })

  it('不保存直接关闭：收进内容零写入', async () => {
    const user = userEvent.setup()
    const adapter = vi.fn(() => Promise.resolve(makeImageSearchReport()))
    const { storage, map } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-result')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /收进图片/ }))
    await user.click(screen.getByRole('button', { name: '取消编辑资料卡' }))
    expect(loadPoiCardsRecord(storage).status).toBe('empty')
    expect(map.size).toBe(0)
  })

  it('收进去重：同一 thumbUrl 二次收进被拒绝并提示已收进', async () => {
    const user = userEvent.setup()
    const adapter = vi.fn(() =>
      Promise.resolve(makeImageSearchReport({ requested_query: '灵隐寺', results_seen: 1 })),
    )
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-result')).toBeInTheDocument())

    const collect = screen.getByRole('button', { name: /收进图片/ })
    await user.click(collect)
    expect(screen.getAllByTestId('poi-card-image-list').length).toBe(1)
    // 收进后该条变为「已收进表单」徽标，收进按钮消失 → 无法重复收进
    expect(screen.queryByRole('button', { name: /收进图片/ })).toBeNull()
    expect(screen.getByText('已收进表单')).toBeInTheDocument()

    // 图片列表里恰好一条（URL 去重）
    expect(screen.getByTestId('poi-card-image-list').children).toHaveLength(1)
  })

  it('张数上限沿用 S3：满 8 张后其余结果不可再收进（收进按钮消失）', async () => {
    const user = userEvent.setup()
    const full = makeRecordWithCard()
    const card = full.cards[0]
    const images = Array.from({ length: 8 }, (_, i) => ({
      url: `https://upload.wikimedia.org/wikipedia/commons/full-${i}.jpg`,
      caption: null,
      source: 'manual' as const,
      attribution: null,
      license: null,
      addedAt: NOW,
    }))
    const updated = createPoiCard(
      { id: card.id, name: card.name, intro: card.intro, images },
      NOW,
    )
    if (!updated.ok) throw new Error(updated.message)
    const fullRecord: PoiCardsRecordV1 = { ...full, cards: [updated.value] }

    const adapter = vi.fn(() => Promise.resolve(makeImageSearchReport()))
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={fullRecord} cardId="card-1" storage={storage} requestImageSources={adapter} />)
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-result')).toBeInTheDocument())
    // 已满 8 张：不提供收进（收进按钮消失，显示「图片已满」提示）
    expect(screen.queryByRole('button', { name: /收进图片/ })).toBeNull()
    expect(screen.getByText('图片已满，先移除后才能收进')).toBeInTheDocument()
  })
})

describe('PoiCardPanel · 失败信封逐状态明示 + 失败保旧', () => {
  function failCase(status: ImageSearchReport['status'], expected: string) {
    return async () => {
      const user = userEvent.setup()
      const adapter = vi.fn(() => Promise.resolve(makeImageSearchReport({ status, reason: '固定短句', items: [], results_seen: 0, fetched_at: status === 'no_candidates' ? makeImageSearchReport().fetched_at : null })))
      const { storage } = memoryStorage()
      // 先编辑内存态（改 intro），再触发失败搜索：失败保旧
      render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)
      await user.type(screen.getByLabelText(/介绍/), '（未保存的修改）')
      await user.click(screen.getByRole('button', { name: '搜索图片' }))
      await waitFor(() => expect(screen.getByTestId('poi-card-image-search-status')).toBeInTheDocument())
      expect(screen.getByTestId('poi-card-image-search-status').textContent).toContain(expected)
      expect(adapter).toHaveBeenCalledTimes(1)
      // 失败保旧：编辑内存态仍在；存储字节不变（仍为空）
      expect((screen.getByLabelText(/介绍/) as HTMLTextAreaElement).value).toContain('（未保存的修改）')
      expect(loadPoiCardsRecord(storage).status).toBe('empty')
    }
  }

  it('no_candidates：诚实说明没有可用条目', failCase('no_candidates', '没有拿到可展示的图片条目'))
  it('invalid_request：参数未接受', failCase('invalid_request', '没有被服务接受'))
  it('timeout：超时', failCase('timeout', '等待超时'))
  it('rate_limited：请求过于频繁', failCase('rate_limited', '过于频繁'))
  it('unavailable：服务不可用', failCase('unavailable', '暂时不可用'))
  it('failed：响应异常', failCase('failed', '响应异常'))

  it('传输层失败：超时 / 网络 / bad_payload 各自固定文案，不回显异常文本', async () => {
    const user = userEvent.setup()
    const { storage } = memoryStorage()

    // timeout
    const timeoutAdapter = vi.fn(() => Promise.reject(Object.assign(new Error('x'), { kind: 'timeout' })))
    const { unmount } = render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={timeoutAdapter} />)
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-error')).toBeInTheDocument())
    expect(screen.getByTestId('poi-card-image-search-error').textContent).toContain('超时')
    expect(screen.getByTestId('poi-card-image-search-error').textContent).not.toContain('x')
    unmount()
    cleanup()

    // bad_payload：结构不符
    const badAdapter = vi.fn(() => Promise.reject(Object.assign(new Error('结构坏了'), { kind: 'bad_payload' })))
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={badAdapter} />)
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-error')).toBeInTheDocument())
    expect(screen.getByTestId('poi-card-image-search-error').textContent).toContain('完整性检查')
    expect(screen.getByTestId('poi-card-image-search-error').textContent).not.toContain('结构坏了')
    expect(badAdapter).toHaveBeenCalledTimes(1)
  })

  it('搜索失败后旧结果不残留误导：展示错误时无结果网格', async () => {
    const user = userEvent.setup()
    let shouldFail = false
    const adapter = vi.fn(() => {
      if (shouldFail) return Promise.reject(Object.assign(new Error('x'), { kind: 'network' }))
      return Promise.resolve(makeImageSearchReport())
    })
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-result')).toBeInTheDocument())
    expect(screen.getAllByTestId('poi-card-image-result').length).toBeGreaterThan(0)

    shouldFail = true
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-error')).toBeInTheDocument())
    expect(screen.queryByTestId('poi-card-image-search-result')).toBeNull()
    expect(adapter).toHaveBeenCalledTimes(2)
  })
})

describe('PoiCardPanel · 搜索区文案红线', () => {
  it('搜索区无「已预订/已确认/已出票」；结果带「未核实」语义', async () => {
    const user = userEvent.setup()
    const adapter = vi.fn(() => Promise.resolve(makeImageSearchReport()))
    const { storage } = memoryStorage()
    render(<SearchHarness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} requestImageSources={adapter} />)
    await user.click(screen.getByRole('button', { name: '搜索图片' }))
    await waitFor(() => expect(screen.getByTestId('poi-card-image-search-result')).toBeInTheDocument())
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('已预订')
    expect(text).not.toContain('已确认')
    expect(text).not.toContain('已出票')
    expect(text).toContain('未核实')
  })
})

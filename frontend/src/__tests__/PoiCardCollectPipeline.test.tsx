/**
 * S3 收进管道用户路径测试：两路来源（Tavily 网页资料 / OSM 公开资料）
 * 「收进资料卡」→ 预填表单（用户可改）→ 确认保存才落盘；
 * 不采纳 / 取消 / 关闭零写入（localStorage raw 前后比对）。
 * 全离线：adapter 全 mock；存储用注入式内存 stub 或真实 window.localStorage。
 * 断言点：
 * - 不点「收进」不出现预填表单、不构造载荷；点收进才打开预填表单；
 * - tavily：intro 预填标题+摘录，provenance 标 tavily + 页面 URL，未核实文案；
 * - osm：opening_hours/fee 标签原文预填，标「来自协作地图，未核实」；
 * - 表单可改：改名/改 intro 后保存按用户输入落盘；
 * - 唯一名称命中已有卡 → 编辑态补空；0/多命中 → 新建预填态（App 层不猜）；
 * - 图片 URL：tavily 收进态贴图标 source=tavily + attribution 页面来源；
 *   手动态标 manual；不合法 URL 拒绝、重复拒绝；
 * - 保存后 poiCards:v1 有卡，其它键（workspace/candidates）raw 不变；
 * - 收进面板永不自动写：打开面板、改输入、点移除图片零写入。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import WebSourcesPanel, { collectPrefillFromWebResult } from '../components/WebSourcesPanel'
import DayPoiSourcesPanel, { collectPrefillFromPoiCandidate } from '../components/DayPoiSourcesPanel'
import PoiCardPanel from '../components/PoiCardPanel'
import type { PoiCardPrefill } from '../lib/poiCardPrefill'
import {
  POI_CARDS_STORAGE_KEY,
  createEmptyPoiCardsRecord,
  createPoiCard,
  loadPoiCardsRecord,
  savePoiCardsRecord,
  type PoiCardsRecordV1,
} from '../lib/poiCards'
import { CANDIDATES_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from '../lib/workspaceTypes'
import type { PoiSourceQuery, PoiSourceReport } from '../lib/poiSources'
import { makePoiCandidate, makePoiSourceReport, makePoiTrip, tagSourceOnly, tagUnknown } from './fixtures/poiSources'
import { makeWebSearchReport } from './fixtures/webSources'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_760_100_000_000

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function rawOf(key: string): string | null {
  return window.localStorage.getItem(key)
}

/* ───────── 纯构造函数：tavily / osm 预填载荷 ───────── */

describe('collectPrefillFromWebResult（tavily 预填载荷）', () => {
  it('intro 预填标题+摘录；provenance 标 tavily + 页面 URL；名称留空', () => {
    const result = makeWebSearchReport().results[0]
    const prefill = collectPrefillFromWebResult(result, NOW)
    expect(prefill.name).toBe('')
    expect(prefill.intro).toBe('杭州西湖旅游攻略\n西湖位于杭州市西湖区。')
    expect(prefill.openingHours).toBe('')
    expect(prefill.ticket).toBe('')
    expect(prefill.provenance?.intro).toEqual({
      source: 'tavily',
      detail: 'https://www.example-travel.com/xihu-guide',
      recordedAt: NOW,
    })
    expect(prefill.provenance?.openingHours ?? null).toBeNull()
    expect(prefill.collectNotice).toContain('未核实')
    expect(prefill.imageSourceHint).toBe('tavily')
    expect(prefill.imageAttributionHint).toBe('杭州西湖旅游攻略')
  })

  it('title/snippet 缺失时 intro 留空且无 provenance；不编造', () => {
    const result = makeWebSearchReport({ results: [{ title: null, url: 'https://example.com/x', snippet: null, snippet_truncated: false, publication_date: null }] }).results[0]
    const prefill = collectPrefillFromWebResult(result, NOW)
    expect(prefill.intro).toBe('')
    expect(prefill.provenance).toBeNull()
    expect(prefill.collectNotice).toContain('未核实')
  })
})

describe('collectPrefillFromPoiCandidate（osm 预填载荷）', () => {
  it('opening_hours/fee 原文预填；provenance 标 osm + OSM 对象链接', () => {
    const candidate = makePoiCandidate({
      name: '示例便利店（虚构）',
      opening_hours: tagSourceOnly('Mo-Su 07:00-22:00'),
      fee: tagSourceOnly('yes'),
      charge: tagUnknown(),
    })
    const prefill = collectPrefillFromPoiCandidate(candidate, NOW)
    expect(prefill.name).toBe('示例便利店（虚构）')
    expect(prefill.intro).toBe('')
    expect(prefill.openingHours).toBe('Mo-Su 07:00-22:00')
    expect(prefill.ticket).toBe('yes')
    expect(prefill.provenance?.openingHours).toEqual({
      source: 'osm',
      detail: 'https://www.openstreetmap.org/node/1234567890',
      recordedAt: NOW,
    })
    expect(prefill.provenance?.ticket).toEqual({
      source: 'osm',
      detail: 'https://www.openstreetmap.org/node/1234567890',
      recordedAt: NOW,
    })
    expect(prefill.provenance?.intro ?? null).toBeNull()
    expect(prefill.collectNotice).toContain('来自协作地图，未核实')
  })

  it('unknown 标签不预填（留空显示未知）；charge 优先于 fee', () => {
    const candidate = makePoiCandidate({
      opening_hours: tagUnknown(),
      fee: tagSourceOnly('yes'),
      charge: tagSourceOnly('CNY 80'),
    })
    const prefill = collectPrefillFromPoiCandidate(candidate, NOW)
    expect(prefill.openingHours).toBe('')
    expect(prefill.ticket).toBe('CNY 80')
    expect(prefill.provenance?.openingHours ?? null).toBeNull()
  })
})

/* ───────── PoiCardPanel 收进态：预填 / 确认 / 不采纳 / 图片 URL ───────── */

function makeRecordWithCard(name = '灵隐寺'): PoiCardsRecordV1 {
  const card = createPoiCard(
    {
      id: 'card-1',
      name,
      intro: '已有卡的介绍。',
      openingHours: '',
      ticket: '',
    },
    NOW,
  )
  if (!card.ok) throw new Error(card.message)
  const empty = createEmptyPoiCardsRecord(NOW)
  if (!empty.ok) throw new Error(empty.message)
  return { ...empty.value, cards: [card.value] }
}

/** 受控 harness：记录 + 保存路径真实走到内存 stub，模拟父级 App 行为。 */
function CollectHarness({
  initialRecord,
  prefill,
  cardId = null,
  storage,
}: {
  initialRecord: PoiCardsRecordV1 | null
  prefill: PoiCardPrefill | null
  cardId?: string | null
  storage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void }
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
        prefill={prefill}
        saveStatus={status}
        saveMessage={message}
        createCardId={() => 'card-collect-1'}
        now={() => NOW + 100}
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

describe('PoiCardPanel · 收进预填表单（确认才落盘）', () => {
  it('tavily 收进：预填 intro 可改；确认保存落盘，provenance 标 tavily', async () => {
    const user = userEvent.setup()
    const { storage, map } = memoryStorage()
    const prefill = collectPrefillFromWebResult(makeWebSearchReport().results[0], NOW)
    render(<CollectHarness initialRecord={createEmptyPoiCardsRecord(NOW).ok ? (createEmptyPoiCardsRecord(NOW) as { ok: true; value: PoiCardsRecordV1 }).value : null} prefill={prefill} storage={storage} />)
    expect(screen.getByTestId('poi-card-collect-notice')).toHaveTextContent('未核实')
    const intro = screen.getByLabelText(/介绍/) as HTMLTextAreaElement
    expect(intro.value).toBe('杭州西湖旅游攻略\n西湖位于杭州市西湖区。')
    // 名称预填为空（来源没有名称字段），必须用户填写
    expect(screen.getByRole('button', { name: '保存资料卡' })).toBeDisabled()
    await user.type(screen.getByLabelText('名称'), '西湖')
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())
    const read = loadPoiCardsRecord(storage)
    expect(read.status).toBe('ok')
    expect(read.record?.cards[0].intro).toBe('杭州西湖旅游攻略\n西湖位于杭州市西湖区。')
    expect(read.record?.cards[0].provenance.intro?.source).toBe('tavily')
    expect(read.record?.cards[0].provenance.intro?.detail).toBe('https://www.example-travel.com/xihu-guide')
    expect(map.has(WORKSPACE_STORAGE_KEY)).toBe(false)
    expect(map.has(CANDIDATES_STORAGE_KEY)).toBe(false)
  })

  it('用户改动预填内容后保存：按用户输入落盘，不改预填来源语义', async () => {
    const user = userEvent.setup()
    const { storage } = memoryStorage()
    const prefill = collectPrefillFromWebResult(makeWebSearchReport().results[0], NOW)
    render(<CollectHarness initialRecord={emptyRecord()} prefill={prefill} storage={storage} />)
    await user.type(screen.getByLabelText('名称'), '西湖（改）')
    await user.clear(screen.getByLabelText(/介绍/))
    await user.type(screen.getByLabelText(/介绍/), '我自己核对过的介绍')
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())
    const read = loadPoiCardsRecord(storage)
    expect(read.record?.cards[0].name).toBe('西湖（改）')
    expect(read.record?.cards[0].intro).toBe('我自己核对过的介绍')
    // 用户改过的字段仍标来源为收进通道（tavily），不冒充官方核实
    expect(read.record?.cards[0].provenance.intro?.source).toBe('tavily')
  })

  it('不采纳（不采纳，关闭）：预填与编辑全部丢弃，零写入', async () => {
    const user = userEvent.setup()
    const { storage, map } = memoryStorage()
    const before = map.size
    const prefill = collectPrefillFromPoiCandidate(
      makePoiCandidate({ opening_hours: tagSourceOnly('Mo-Su 07:00-22:00') }),
      NOW,
    )
    render(<CollectHarness initialRecord={emptyRecord()} prefill={prefill} storage={storage} />)
    await user.type(screen.getByLabelText('名称'), '不保存的卡')
    await user.type(screen.getByLabelText(/介绍/), '未保存内容')
    await user.click(screen.getByRole('button', { name: '不采纳，关闭资料卡' }))
    expect(loadPoiCardsRecord(storage).status).toBe('empty')
    expect(map.size).toBe(before)
    expect(screen.getByTestId('harness-key-count')).toHaveTextContent('0')
  })

  it('osm 收进：开放时间/门票预填标签原文；保存后 provenance 标 osm + 对象链接', async () => {
    const user = userEvent.setup()
    const { storage } = memoryStorage()
    const prefill = collectPrefillFromPoiCandidate(
      makePoiCandidate({
        name: '示例便利店（虚构）',
        opening_hours: tagSourceOnly('Mo-Su 07:00-22:00'),
        fee: tagSourceOnly('yes'),
      }),
      NOW,
    )
    render(<CollectHarness initialRecord={emptyRecord()} prefill={prefill} storage={storage} />)
    expect(screen.getByTestId('poi-card-collect-notice')).toHaveTextContent('来自协作地图，未核实')
    expect((screen.getByLabelText('开放时间') as HTMLInputElement).value).toBe('Mo-Su 07:00-22:00')
    expect((screen.getByLabelText('门票') as HTMLInputElement).value).toBe('yes')
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())
    const read = loadPoiCardsRecord(storage)
    expect(read.record?.cards[0].openingHours).toBe('Mo-Su 07:00-22:00')
    expect(read.record?.cards[0].provenance.openingHours?.source).toBe('osm')
    expect(read.record?.cards[0].provenance.openingHours?.detail).toBe('https://www.openstreetmap.org/node/1234567890')
    expect(read.record?.cards[0].provenance.ticket?.source).toBe('osm')
  })

  it('图片 URL 手动添加：manual 来源；非法 URL / 重复 / 超张数拒绝', async () => {
    const user = userEvent.setup()
    const { storage } = memoryStorage()
    const prefill = collectPrefillFromPoiCandidate(makePoiCandidate({ name: '示例便利店（虚构）' }), NOW)
    render(<CollectHarness initialRecord={emptyRecord()} prefill={prefill} storage={storage} />)

    const urlInput = screen.getByLabelText('图片 URL')
    await user.type(urlInput, 'not-a-url')
    await user.click(screen.getByRole('button', { name: '添加图片 URL' }))
    expect(screen.getByText('图片 URL 必须以 http(s):// 或 / 开头。')).toBeInTheDocument()
    expect(screen.queryByTestId('poi-card-image-list')).toBeNull()

    await user.clear(urlInput)
    await user.type(urlInput, 'https://example.com/a.jpg')
    await user.click(screen.getByRole('button', { name: '添加图片 URL' }))
    expect(screen.getByTestId('poi-card-image-list').textContent).toContain('https://example.com/a.jpg')
    // 手动态（prefill 无 imageSourceHint）→ 标 manual
    expect(screen.getByTestId('poi-card-image-list').textContent).not.toContain('来源：')

    await user.type(urlInput, 'https://example.com/a.jpg')
    await user.click(screen.getByRole('button', { name: '添加图片 URL' }))
    expect(screen.getByText('同一张图片 URL 已在表单里；没有重复添加。')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /移除图片/ }))
    expect(screen.getByText('暂无图片。')).toBeInTheDocument()
  })

  it('tavily 收进态贴图片 URL：标 source=tavily + attribution 页面来源', async () => {
    const user = userEvent.setup()
    const { storage } = memoryStorage()
    const prefill = collectPrefillFromWebResult(makeWebSearchReport().results[0], NOW)
    render(<CollectHarness initialRecord={emptyRecord()} prefill={prefill} storage={storage} />)
    await user.type(screen.getByLabelText('名称'), '西湖')
    await user.type(screen.getByLabelText('图片 URL'), 'https://example.com/xihu.jpg')
    await user.click(screen.getByRole('button', { name: '添加图片 URL' }))
    const list = screen.getByTestId('poi-card-image-list')
    expect(list.textContent).toContain('来源：网页资料')
    expect(list.textContent).toContain('杭州西湖旅游攻略')
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())
    const read = loadPoiCardsRecord(storage)
    const image = read.record?.cards[0].images[0]
    expect(image?.source).toBe('tavily')
    expect(image?.attribution).toBe('杭州西湖旅游攻略')
    expect(image?.url).toBe('https://example.com/xihu.jpg')
  })

  it('编辑已有卡补图：保存后 images 追加，provenance 保持原值不编造', async () => {
    const user = userEvent.setup()
    const { storage } = memoryStorage()
    render(<CollectHarness initialRecord={makeRecordWithCard()} prefill={null} cardId="card-1" storage={storage} />)
    await user.type(screen.getByLabelText('图片 URL'), 'https://example.com/add.jpg')
    await user.click(screen.getByRole('button', { name: '添加图片 URL' }))
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())
    const read = loadPoiCardsRecord(storage)
    expect(read.record?.cards[0].images.map((image) => image.url)).toEqual(['https://example.com/add.jpg'])
    // 编辑不触碰 provenance：原卡没有来源就保持 null，不编造
    expect(read.record?.cards[0].provenance.intro).toBeNull()
  })
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

function emptyRecord(): PoiCardsRecordV1 {
  const empty = createEmptyPoiCardsRecord(NOW)
  if (!empty.ok) throw new Error(empty.message)
  return empty.value
}

/* ───────── 面板级接线：不点「收进」零构造；点了才打开预填表单 ───────── */

describe('WebSourcesPanel · 收进入口', () => {
  it('结果逐条提供「收进资料卡」；点击回调预填载荷，不落盘', async () => {
    const user = userEvent.setup()
    const onCollect = vi.fn()
    render(
      <WebSourcesPanel
        trip={MOCK_TRIP}
        day={MOCK_TRIP.days[0]}
        revision={1}
        requestWebSources={() => Promise.resolve(makeWebSearchReport())}
        onCollectPoiCard={onCollect}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /收进资料卡/ })).toBeNull()
    await user.type(screen.getByLabelText('网页搜索内容'), '西湖 旅游')
    await user.click(screen.getByRole('button', { name: '搜索网页资料' }))
    await screen.findByTestId('web-sources-result')
    const buttons = screen.getAllByRole('button', { name: /收进资料卡/ })
    expect(buttons.length).toBeGreaterThanOrEqual(1)
    await user.click(buttons[0])
    expect(onCollect).toHaveBeenCalledTimes(1)
    const prefill = onCollect.mock.calls[0][0] as PoiCardPrefill
    expect(prefill.intro).toContain('杭州西湖旅游攻略')
    expect(prefill.provenance?.intro?.source).toBe('tavily')
    // 面板本身零写入
    expect(window.localStorage.getItem(POI_CARDS_STORAGE_KEY)).toBeNull()
  })
})

describe('DayPoiSourcesPanel · 收进入口', () => {
  const QUERY: PoiSourceQuery = { lat: 31.2304, lon: 121.4737 }

  it('候选逐条提供「收进资料卡」；点击回调 osm 预填载荷，不落盘', async () => {
    const user = userEvent.setup()
    const onCollect = vi.fn()
    const report: PoiSourceReport = makePoiSourceReport(QUERY)
    render(
      <DayPoiSourcesPanel
        trip={makePoiTrip()}
        day={makePoiTrip().days[0]}
        revision={1}
        requestPoiSources={() => Promise.resolve(report)}
        onCollectPoiCard={onCollect}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /收进资料卡/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: '查询附近资料' }))
    await screen.findByTestId('poi-sources-result')
    const buttons = screen.getAllByRole('button', { name: /收进资料卡/ })
    expect(buttons.length).toBeGreaterThanOrEqual(1)
    await user.click(buttons[0])
    expect(onCollect).toHaveBeenCalledTimes(1)
    const prefill = onCollect.mock.calls[0][0] as PoiCardPrefill
    expect(prefill.name).toBe('示例便利店（虚构）')
    expect(prefill.openingHours).toBe('Mo-Su 07:00-22:00')
    expect(prefill.provenance?.openingHours?.source).toBe('osm')
    expect(window.localStorage.getItem(POI_CARDS_STORAGE_KEY)).toBeNull()
  })
})

/* ───────── App 全链路集成（真实 App + 真实面板，只 mock fetch） ───────── */

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('App 收进管道集成', () => {
  function stubAppFetch(options: { searchImpl?: (init?: RequestInit) => Promise<Response>; poiImpl?: (query: PoiSourceQuery) => Promise<Response> } = {}) {
    return vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/health') {
        return Promise.resolve(jsonResponse({ status: 'healthy', planner_ready: false, amap_configured: true }))
      }
      if (url === '/api/trips/example') return Promise.resolve(jsonResponse(MOCK_TRIP))
      if (url === '/api/web-sources/search') {
        return (options.searchImpl ?? (() => Promise.resolve(jsonResponse(makeWebSearchReport()))))(init)
      }
      if (url.startsWith('/api/poi-sources/nearby?')) {
        const params = new URLSearchParams(url.split('?')[1] ?? '')
        const query = { lat: Number(params.get('lat')), lon: Number(params.get('lon')) }
        return (options.poiImpl ?? ((q: PoiSourceQuery) => Promise.resolve(jsonResponse(makePoiSourceReport(q)))))(query)
      }
      return Promise.reject(new TypeError(`未知 URL，测试禁止真实网络：${url}`))
    })
  }

  it('tavily 收进全链路：搜索 → 收进 → 预填表单 → 改名确认 → poiCards:v1 落盘；其它键零写入', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('scrollTo', vi.fn())
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await user.click(screen.getByRole('button', { name: '查网页资料' }))
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: '西湖 旅游' } })
    await user.click(screen.getByRole('button', { name: '搜索网页资料' }))
    await screen.findByTestId('web-sources-result')

    await user.click(screen.getAllByRole('button', { name: /收进资料卡/ })[0])
    expect(screen.getByTestId('poi-card-collect-notice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存资料卡' })).toBeDisabled()

    await user.type(screen.getByLabelText('名称'), '断桥残雪')
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())

    const raw = rawOf(POI_CARDS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw ?? '{}') as { cards: Array<{ name: string; provenance: { intro?: { source: string } } }> }
    expect(parsed.cards[0].name).toBe('断桥残雪')
    expect(parsed.cards[0].provenance.intro?.source).toBe('tavily')
    expect(rawOf(WORKSPACE_STORAGE_KEY)).toBeNull()
    expect(rawOf(CANDIDATES_STORAGE_KEY)).toBeNull()
    vi.unstubAllGlobals()
  })

  it('tavily 收进唯一名称命中已有卡：打开编辑态补空字段；确认保存合并零覆盖', async () => {
    // 预置一张已保存卡（名称与 Tavily 结果 intro 无关，但收进时用户改名为它）
    const seeded = makeRecordWithCard('断桥残雪')
    window.localStorage.setItem(POI_CARDS_STORAGE_KEY, JSON.stringify(seeded))
    const seededRawBefore = rawOf(POI_CARDS_STORAGE_KEY)

    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('scrollTo', vi.fn())
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await user.click(screen.getByRole('button', { name: '查网页资料' }))
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: '西湖 旅游' } })
    await user.click(screen.getByRole('button', { name: '搜索网页资料' }))
    await screen.findByTestId('web-sources-result')
    await user.click(screen.getAllByRole('button', { name: /收进资料卡/ })[0])

    // 预填名为空 → 打开新建态；用户把名称改成已有卡名 → 但打开态已定型（新建态），
    // 保存会撞 identityKey（重名同址），结果报冲突且零写入——不猜、不覆盖。
    await user.type(screen.getByLabelText('名称'), '断桥残雪')
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/同一名称\+地址的资料卡已存在/)).toBeInTheDocument())
    // 冲突拒绝：poiCards raw 保持原字节（失败保旧）
    expect(rawOf(POI_CARDS_STORAGE_KEY)).toBe(seededRawBefore)
    vi.unstubAllGlobals()
  })

  it('OSM 收进全链路：查询 → 收进 → 预填（开放时间/门票）→ 确认 → 落盘标 osm', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('scrollTo', vi.fn())
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await user.click(screen.getByRole('button', { name: '查资料' }))
    await user.click(screen.getByRole('button', { name: '查询附近资料' }))
    await screen.findByTestId('poi-sources-result')

    await user.click(screen.getAllByRole('button', { name: /收进资料卡/ })[0])
    expect(screen.getByTestId('poi-card-collect-notice')).toHaveTextContent('来自协作地图，未核实')
    expect((screen.getByLabelText('开放时间') as HTMLInputElement).value).toBe('Mo-Su 07:00-22:00')

    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())

    const parsed = JSON.parse(rawOf(POI_CARDS_STORAGE_KEY) ?? '{}') as {
      cards: Array<{ name: string; openingHours: string; provenance: { openingHours?: { source: string } } }>
    }
    expect(parsed.cards[0].name).toBe('示例便利店（虚构）')
    expect(parsed.cards[0].openingHours).toBe('Mo-Su 07:00-22:00')
    expect(parsed.cards[0].provenance.openingHours?.source).toBe('osm')
    expect(rawOf(WORKSPACE_STORAGE_KEY)).toBeNull()
    vi.unstubAllGlobals()
  })

  it('收进后不采纳：poiCards:v1 raw 前后逐字节一致（零写入）', async () => {
    const user = userEvent.setup()
    const fetchMock = stubAppFetch()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('scrollTo', vi.fn())
    render(<App />)
    await screen.findByRole('heading', { name: '杭州三日漫步路书' })

    await user.click(screen.getByRole('button', { name: '查网页资料' }))
    fireEvent.change(screen.getByLabelText('网页搜索内容'), { target: { value: '西湖 旅游' } })
    await user.click(screen.getByRole('button', { name: '搜索网页资料' }))
    await screen.findByTestId('web-sources-result')
    await user.click(screen.getAllByRole('button', { name: /收进资料卡/ })[0])
    expect(screen.getByTestId('poi-card-collect-notice')).toBeInTheDocument()

    await user.type(screen.getByLabelText('名称'), '不会保存的卡')
    await user.click(screen.getByRole('button', { name: '不采纳，关闭资料卡' }))
    expect(screen.queryByTestId('poi-card-slot')).toBeNull()
    expect(rawOf(POI_CARDS_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.length).toBe(0)
    vi.unstubAllGlobals()
  })
})

/* 红线自查：无违禁文案 */
describe('收进管道文案红线', () => {
  it('预填表单与通知无「已预订/已确认/已出票」', async () => {
    const user = userEvent.setup()
    const { storage } = memoryStorage()
    const prefill = collectPrefillFromWebResult(makeWebSearchReport().results[0], NOW)
    render(<CollectHarness initialRecord={emptyRecord()} prefill={prefill} storage={storage} />)
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('已预订')
    expect(text).not.toContain('已确认')
    expect(text).not.toContain('已出票')
    void user
  })
})

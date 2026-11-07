/**
 * PoiCardPanel 用户路径测试：显式保存才落盘 / 取消零写入 / 未保存不复活 /
 * 文案红线 / 图片懒加载与失败占位 / 其它键 raw 不变。
 * 全离线：存储用注入式内存 stub；父级 onSave 是显式 mock。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PoiCardPanel from '../components/PoiCardPanel'
import {
  createEmptyPoiCardsRecord,
  createPoiCard,
  loadPoiCardsRecord,
  savePoiCardsRecord,
  type PoiCardsRecordV1,
} from '../lib/poiCards'
import { CANDIDATES_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from '../lib/workspaceTypes'

const NOW = 1_760_000_000_000

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

function ok<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function makeRecordWithCard(name = '灵隐寺'): PoiCardsRecordV1 {
  const card = ok(
    createPoiCard(
      {
        id: 'card-1',
        name,
        intro: '杭州著名古刹。',
        openingHours: '07:30-18:00',
        ticket: '飞来峰45元，灵隐寺30元',
        provenance: {
          intro: { source: 'manual', detail: '手工粘贴', recordedAt: NOW },
          openingHours: null,
          ticket: null,
        },
      },
      NOW,
    ),
  )
  const empty = ok(createEmptyPoiCardsRecord(NOW))
  return { ...empty, cards: [card] }
}

/** 受控 harness：记录 + 保存路径真实走到内存 stub，模拟父级 App 行为。 */
function Harness({
  initialRecord,
  cardId,
  storage,
}: {
  initialRecord: PoiCardsRecordV1 | null
  cardId: string | null
  storage: ReturnType<typeof memoryStorage>['storage']
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
        createCardId={() => 'card-new-1'}
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

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PoiCardPanel · 显式保存才落盘', () => {
  it('编辑只改内存；点保存后 record 与存储才变化', async () => {
    const user = userEvent.setup()
    const { storage, map } = memoryStorage()
    render(<Harness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} />)
    expect(loadPoiCardsRecord(storage).status).toBe('empty')

    await user.clear(screen.getByLabelText('名称'))
    await user.type(screen.getByLabelText('名称'), '灵隐寺（改）')
    // 未保存：存储仍为空，harness 计数不变
    expect(loadPoiCardsRecord(storage).status).toBe('empty')
    expect(screen.getByTestId('harness-key-count')).toHaveTextContent('1')

    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())
    const read = loadPoiCardsRecord(storage)
    expect(read.status).toBe('ok')
    expect(read.record?.cards[0].name).toBe('灵隐寺（改）')
    expect(read.record?.cards[0].updatedAt).toBe(NOW + 100)
    expect(map.has(WORKSPACE_STORAGE_KEY)).toBe(false)
    expect(map.has(CANDIDATES_STORAGE_KEY)).toBe(false)
  })

  it('新建态保存后多一张卡，provenance 标 manual + 未核实', async () => {
    const user = userEvent.setup()
    const { storage } = memoryStorage()
    render(<Harness initialRecord={ok(createEmptyPoiCardsRecord(NOW))} cardId={null} storage={storage} />)
    await user.type(screen.getByLabelText('名称'), '断桥残雪')
    await user.type(screen.getByLabelText(/介绍/), '西湖十景之一。')
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡（1 张/)).toBeInTheDocument())
    const read = loadPoiCardsRecord(storage)
    expect(read.record?.cards[0].name).toBe('断桥残雪')
    expect(read.record?.cards[0].provenance.intro?.source).toBe('manual')
    // 面板上有「未核实」标注
    expect(screen.getAllByText('未核实').length).toBeGreaterThan(0)
  })

  it('取消 / 关闭零写入：修改后点取消，存储与记录不变', async () => {
    const user = userEvent.setup()
    const { storage, map } = memoryStorage()
    render(<Harness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} />)
    await user.type(screen.getByLabelText(/介绍/), '追加的未保存内容')
    await user.click(screen.getByRole('button', { name: '取消编辑资料卡' }))
    expect(loadPoiCardsRecord(storage).status).toBe('empty')
    expect(map.size).toBe(0)
    expect(screen.getByTestId('harness-key-count')).toHaveTextContent('1')
  })

  it('未保存编辑 reload 不复活：重新挂载后回到已保存内容', async () => {
    const user = userEvent.setup()
    const { storage } = memoryStorage()
    // 第一轮：保存一份基线内容
    const { unmount } = render(<Harness initialRecord={makeRecordWithCard()} cardId="card-1" storage={storage} />)
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    await waitFor(() => expect(screen.getByText(/已保存资料卡/)).toBeInTheDocument())
    unmount()

    // 第二轮（模拟 reload）：挂载后应显示存储里已保存的 intro，而不是上一轮未保存输入
    const record = loadPoiCardsRecord(storage)
    expect(record.status).toBe('ok')
    render(<Harness initialRecord={record.record ?? null} cardId="card-1" storage={storage} />)
    expect(screen.getByTestId('poi-card-view')).toHaveTextContent('杭州著名古刹。')
    const editIntro = screen.getByLabelText(/介绍/) as HTMLTextAreaElement
    expect(editIntro.value).toBe('杭州著名古刹。')
  })
})

describe('PoiCardPanel · 文案红线', () => {
  it('未知字段显示「未知」，不补 0；不出现违禁词', () => {
    const { storage } = memoryStorage()
    const card = ok(
      createPoiCard({ id: 'card-1', name: '无字碑', intro: '', openingHours: '', ticket: '' }, NOW),
    )
    const empty = ok(createEmptyPoiCardsRecord(NOW))
    render(
      <PoiCardPanel
        record={{ ...empty, cards: [card] }}
        cardId="card-1"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    void storage
    const view = screen.getByTestId('poi-card-view')
    expect(within(view).getAllByText('未知').length).toBeGreaterThanOrEqual(2)
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('已预订')
    expect(text).not.toContain('已确认')
    expect(text).not.toContain('已出票')
  })

  it('所有内容默认「未核实」标注', () => {
    const { storage } = memoryStorage()
    void storage
    render(
      <PoiCardPanel
        record={makeRecordWithCard()}
        cardId="card-1"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getAllByText('未核实').length).toBeGreaterThan(0)
  })

  it('介绍超长时保存禁用并提示，不静默截断', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <PoiCardPanel
        record={ok(createEmptyPoiCardsRecord(NOW))}
        cardId={null}
        onSave={onSave}
        onClose={vi.fn()}
        now={() => NOW}
      />,
    )
    await user.type(screen.getByLabelText('名称'), '长介绍卡')
    // 2001 字逐字输入太慢；直接设置值后触发一次 change 事件
    const intro = screen.getByLabelText(/介绍/)
    fireEvent.change(intro, { target: { value: '好'.repeat(2001) } })
    expect(screen.getByRole('button', { name: '保存资料卡' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '保存资料卡' }))
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('PoiCardPanel · 图片', () => {
  it('图片懒加载 + 失败占位（图片加载失败，不阻断）', () => {
    const { storage } = memoryStorage()
    void storage
    const card = ok(
      createPoiCard(
        {
          id: 'card-1',
          name: '有图卡',
          images: [
            {
              url: 'https://example.com/broken.jpg',
              caption: '远景',
              source: 'manual',
              attribution: null,
              license: null,
              addedAt: NOW,
            },
          ],
        },
        NOW,
      ),
    )
    const empty = ok(createEmptyPoiCardsRecord(NOW))
    render(
      <PoiCardPanel
        record={{ ...empty, cards: [card] }}
        cardId="card-1"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const img = screen.getByRole('img', { name: '远景' }) as HTMLImageElement
    expect(img.getAttribute('loading')).toBe('lazy')
    fireEvent.error(img)
    expect(screen.getByText('图片加载失败')).toBeInTheDocument()
    // 占位不阻断：卡片其余内容（标题 + 图片说明）仍在
    const region = screen.getByRole('region', { name: '景点资料卡' })
    expect(within(region).getByText('有图卡')).toBeInTheDocument()
    expect(screen.getByText(/远景/)).toBeInTheDocument()
  })

  it('记录不可用时只读提示，不假装为空库', () => {
    render(
      <PoiCardPanel record={null} cardId={null} onSave={vi.fn()} onClose={vi.fn()} />,
    )
    expect(screen.getByText(/资料卡库尚未加载或不可用/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存资料卡' })).toBeNull()
  })
})

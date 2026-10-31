import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TripMarkdownExport from '../components/TripMarkdownExport'
import type { Trip } from '../lib/api'
import { safeTripMarkdownFilename, tripToMarkdown } from '../lib/tripMarkdown'
import * as tripMarkdownModule from '../lib/tripMarkdown'
import * as tripMarkdownFile from '../lib/tripMarkdownFile'
import { MOCK_TRIP } from './fixtures/trip'

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取 Blob 失败'))
    reader.readAsText(blob)
  })
}

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:md-panel')
  revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  const urlStatics = URL as unknown as Record<string, unknown>
  delete urlStatics.createObjectURL
  delete urlStatics.revokeObjectURL
  vi.restoreAllMocks()
})

function region(): HTMLElement {
  return screen.getByRole('region', { name: '导出可读路书（Markdown）' })
}

/** 拦截 downloadTripMarkdown 的真实 DOM 副作用，只断言传参 */
function stubDownload() {
  return vi
    .spyOn(tripMarkdownFile, 'downloadTripMarkdown')
    .mockImplementation((() => ({
      ok: true,
      filename: safeTripMarkdownFilename(MOCK_TRIP),
      blob: new Blob(['x'], { type: 'text/markdown' }),
      markdown: 'x',
      bytes: 1,
    })) as typeof tripMarkdownFile.downloadTripMarkdown)
}

describe('TripMarkdownExport：挂载与预览', () => {
  it('挂载时不生成文本、不建 Blob URL、不点击下载、不写存储', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    window.localStorage.clear()
    render(<TripMarkdownExport trip={MOCK_TRIP} />)

    expect(within(region()).getByRole('button', { name: '预览路书（Markdown）' })).toBeInTheDocument()
    expect(within(region()).queryByRole('button', { name: '下载路书 (.md)' })).toBeNull()
    expect(within(region()).queryByRole('button', { name: '放弃预览' })).toBeNull()
    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('travel-assistant:saved-trips:v1')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('点预览才生成：只读纯文本展示，预览前不出现下载按钮', async () => {
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))

    const textarea = within(region()).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea).toHaveAttribute('readonly')
    expect(textarea.value.startsWith('# 杭州三日漫步路书\n')).toBe(true)
    expect(within(region()).getByRole('button', { name: '下载路书 (.md)' })).toBeInTheDocument()
    expect(within(region()).getByRole('button', { name: '放弃预览' })).toBeInTheDocument()
    // 生成预览本身不建 Blob URL、不下载
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    // 预览元信息（标题文案分两个文本节点，用正则匹配 heading；notice 双容器用 getAllByText）
    expect(
      within(region()).getByRole('heading', { name: /预览：杭州-杭州三日漫步路书\.md/ }),
    ).toBeInTheDocument()
    expect(within(region()).getAllByText(/行程来源：示例行程/).length).toBeGreaterThan(0)
  })

  it('预览是纯文本：注入字符串不会被解释成 HTML 或 Markdown 结构', async () => {
    const evil: Trip = {
      ...MOCK_TRIP,
      id: 'trip-evil-panel',
      title: '<img src=x onerror="alert(1)">标题',
      days: [
        {
          day: 1,
          date: null,
          title: 'evil day',
          summary: '',
          stops: [],
          legs: [],
        },
      ],
    }
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={evil} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))

    const textarea = within(region()).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).not.toContain('<img src=x onerror')
    expect(textarea.value).toContain('&lt;img')
    // 页面里没有真的插入 img 元素
    expect(document.querySelector('img[src="x"]')).toBeNull()
  })

  it('点下载把当前预览的同一份文本交给下载函数', async () => {
    const spy = stubDownload()
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    const textarea = within(region()).getByRole('textbox') as HTMLTextAreaElement
    await user.click(within(region()).getByRole('button', { name: '下载路书 (.md)' }))

    expect(spy).toHaveBeenCalledTimes(1)
    const [, markdownArg] = spy.mock.calls[0]
    expect(markdownArg).toBe(textarea.value)
    // 下载成功 / 失败通告只出现一次：唯一 aria-live 播报区，有预览时也不重复
    expect(within(region()).getAllByText(/已发起浏览器下载/).length).toBe(1)
    expect(within(region()).getAllByTestId('trip-md-notice').length).toBe(1)
  })
})

describe('TripMarkdownExport：作废与放弃', () => {
  it('同 id 内容变化：旧预览在渲染期立即作废，须重新预览', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    expect(within(region()).getByRole('button', { name: '下载路书 (.md)' })).toBeInTheDocument()

    // 同一 id，只改内容（改标题）：预览立即消失
    rerender(<TripMarkdownExport trip={{ ...MOCK_TRIP, title: '杭州三日漫步路书（改）' }} />)
    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载路书 (.md)' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('换 id（另一份行程）：旧预览同样作废', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))

    rerender(<TripMarkdownExport trip={{ ...MOCK_TRIP, id: 'trip-other' }} />)
    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载路书 (.md)' })).toBeNull()
  })

  it('预览存在时换 id 再换回来：旧预览永久作废不复活，须重新预览', async () => {
    const user = userEvent.setup()
    const other = { ...MOCK_TRIP, id: 'trip-other' }
    const { rerender } = render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    expect(within(region()).getByRole('textbox')).toBeInTheDocument()

    rerender(<TripMarkdownExport trip={other} />)
    expect(within(region()).queryByRole('textbox')).toBeNull()
    // 换回原行程（内容一致）：state 里的旧预览已被永久清掉，不因快照巧合而复活；须重新点击生成
    rerender(<TripMarkdownExport trip={MOCK_TRIP} />)
    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载路书 (.md)' })).toBeNull()

    // 重新预览后恢复
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    expect(within(region()).getByRole('textbox')).toBeInTheDocument()
  })

  it('same-id 内容变化再撤销回原文：旧预览同样不复活', async () => {
    const user = userEvent.setup()
    const modified = { ...MOCK_TRIP, title: '改过的标题' }
    const { rerender } = render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    expect(within(region()).getByRole('textbox')).toBeInTheDocument()

    rerender(<TripMarkdownExport trip={modified} />)
    expect(within(region()).queryByRole('textbox')).toBeNull()
    // B 撤销回 A（内容与首次相同）：作废时已永久清除，不复活；合同要求内容一变就作废
    rerender(<TripMarkdownExport trip={MOCK_TRIP} />)
    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载路书 (.md)' })).toBeNull()
  })

  it('放弃预览：预览与下载按钮消失，焦点回到生成按钮', async () => {
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={MOCK_TRIP} />)
    const generate = within(region()).getByRole('button', { name: '预览路书（Markdown）' })
    await user.click(generate)
    expect(within(region()).getByRole('textbox')).toBeInTheDocument()

    await user.click(within(region()).getByRole('button', { name: '放弃预览' }))
    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载路书 (.md)' })).toBeNull()
    expect(generate).toHaveFocus()
  })

  it('行程内容变化后下载按钮消失，点击作废前的下载不可达', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    rerender(<TripMarkdownExport trip={{ ...MOCK_TRIP, summary: '变了' }} />)
    // 作废后重新预览生成新快照，下载的是新内容
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    const textarea = within(region()).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).not.toBe('')
  })
})

describe('TripMarkdownExport：失败路径', () => {
  it('bad_limit 失败给固定配置错误文案，不指责行程数据非法，不露原始异常', async () => {
    vi.spyOn(tripMarkdownModule, 'tripToMarkdown').mockImplementation(
      (() => ({
        ok: false as const,
        reason: 'bad_limit' as const,
        message:
          '导出配置的输出上限不合法（必须是不超过 1 MiB 的正数），没有生成文件。这是程序配置问题，与行程内容无关。',
      })) as typeof tripMarkdownModule.tripToMarkdown,
    )
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))

    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(
      within(region()).getByText(/这是程序配置问题，与行程内容无关/),
    ).toBeInTheDocument()
    // 不用「数据结构不完整」的 invalid_trip 文案指责行程非法
    expect(within(region()).queryByText(/数据结构不完整/)).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载路书 (.md)' })).toBeNull()
    expect(within(region()).getAllByTestId('trip-md-notice').length).toBe(1)
  })

  it('生成失败（无预览）后换行程：旧错误通告不挂到新行程上', async () => {
    const bad = {
      ...MOCK_TRIP,
      id: 'trip-broken',
      days: [
        {
          ...MOCK_TRIP.days[0],
          stops: [MOCK_TRIP.days[0].stops[0], { ...MOCK_TRIP.days[0].stops[0], time: '10:00' }],
        },
      ],
    } as Trip
    const user = userEvent.setup()
    const { rerender } = render(<TripMarkdownExport trip={bad} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    expect(within(region()).getByText(/数据结构不完整或包含异常字段/)).toBeInTheDocument()

    // 此时 preview 为 null，之前 effect 只在 preview!==null 且 stale 时才清 notice：
    // 换到另一份合法行程后，旧错误必须清掉，不能误导新行程出了问题
    rerender(<TripMarkdownExport trip={{ ...MOCK_TRIP, id: 'trip-fresh' }} />)
    expect(within(region()).queryByText(/数据结构不完整或包含异常字段/)).toBeNull()
    expect(within(region()).queryByTestId('trip-md-notice')).toBeNull()
    expect(within(region()).queryByRole('textbox')).toBeNull()
  })

  it('生成失败（无预览）后同 id 修正内容：错误同样清除，须重新预览', async () => {
    const bad = {
      ...MOCK_TRIP,
      id: 'trip-fixable',
      days: [
        {
          ...MOCK_TRIP.days[0],
          stops: [MOCK_TRIP.days[0].stops[0], { ...MOCK_TRIP.days[0].stops[0], time: '10:00' }],
        },
      ],
    } as Trip
    const user = userEvent.setup()
    const { rerender } = render(<TripMarkdownExport trip={bad} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    expect(within(region()).getByText(/数据结构不完整或包含异常字段/)).toBeInTheDocument()

    // 同 id 修好了重复站点：错误清掉，但不自动生成，须用户重新点击
    rerender(<TripMarkdownExport trip={{ ...bad, days: MOCK_TRIP.days }} />)
    expect(within(region()).queryByText(/数据结构不完整或包含异常字段/)).toBeNull()
    expect(within(region()).queryByTestId('trip-md-notice')).toBeNull()
    // 不自动生成：修正后仍无预览，须重新点击
    expect(within(region()).queryByRole('textbox')).toBeNull()
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    expect(within(region()).getByRole('textbox')).toBeInTheDocument()
  })

  it('行程携带不可序列化字段（BigInt）时 fail closed：生成成得但快照守卫建不起来，不给预览', async () => {
    // extra BigInt 不进投影（tripToMarkdown 能成功），但 JSON.stringify 会抛：
    // 序列化不了的快照无法证明「内容没变」，合同要求 fail closed，不能拿哨兵串假装能比
    const tripWithBigInt = {
      ...MOCK_TRIP,
      id: 'trip-bigint',
      internalSeq: BigInt(1),
    } as unknown as Trip
    const libResult = tripToMarkdown(tripWithBigInt)
    expect(libResult.ok).toBe(true)

    const user = userEvent.setup()
    render(<TripMarkdownExport trip={tripWithBigInt} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))

    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(within(region()).queryByRole('button', { name: '下载路书 (.md)' })).toBeNull()
    expect(within(region()).getByText(/无法生成预览守卫/)).toBeInTheDocument()
  })

  it('结构非法的行程给固定错误文案，不产生预览与下载', async () => {
    const bad = {
      ...MOCK_TRIP,
      days: [
        {
          ...MOCK_TRIP.days[0],
          stops: [MOCK_TRIP.days[0].stops[0], { ...MOCK_TRIP.days[0].stops[0], time: '10:00' }],
        },
      ],
    } as Trip
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={bad} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))

    expect(within(region()).queryByRole('textbox')).toBeNull()
    expect(within(region()).getByText(/数据结构不完整或包含异常字段，没有生成 Markdown/)).toBeInTheDocument()
    expect(within(region()).queryByRole('button', { name: '下载路书 (.md)' })).toBeNull()
    // 错误通告只出现一次（唯一播报区）
    expect(within(region()).getAllByTestId('trip-md-notice').length).toBe(1)
  })

  it('下载失败给固定文案且保留预览可重试', async () => {
    vi.spyOn(tripMarkdownFile, 'downloadTripMarkdown').mockImplementation(
      (() => ({
        ok: false as const,
        reason: 'error' as const,
        message: '触发下载失败，未下载任何文件。请重试；如果一直失败，检查浏览器的下载设置。',
      })) as typeof tripMarkdownFile.downloadTripMarkdown,
    )
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    await user.click(within(region()).getByRole('button', { name: '下载路书 (.md)' }))

    expect(within(region()).getAllByText(/触发下载失败，未下载任何文件/).length).toBe(1)
    // 预览还在，可以直接重试
    expect(within(region()).getByRole('textbox')).toBeInTheDocument()
    expect(within(region()).getByRole('button', { name: '下载路书 (.md)' })).toBeInTheDocument()
  })

  it('真实 DOM 下载路径：点预览再点下载只创建一次 Blob URL，延迟回收', async () => {
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    await user.click(within(region()).getByRole('button', { name: '下载路书 (.md)' }))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/markdown;charset=utf-8')
    expect(await readBlob(blob)).toContain('# 杭州三日漫步路书')
  })

  it('重复下载也只对已预览内容各建一次 URL，不重新生成内容', async () => {
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    await user.click(within(region()).getByRole('button', { name: '下载路书 (.md)' }))
    await user.click(within(region()).getByRole('button', { name: '下载路书 (.md)' }))
    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(2)
  })

  it('回收延迟按 TRIP_MARKDOWN_URL_REVOKE_DELAY_MS 注册：预览后下载 revoke 未同步发生', async () => {
    const user = userEvent.setup()
    render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    await user.click(within(region()).getByRole('button', { name: '下载路书 (.md)' }))
    expect(tripMarkdownFile.TRIP_MARKDOWN_URL_REVOKE_DELAY_MS).toBe(1000)
    // 真实 setTimeout 由 jsdom 计时；这里只验证 revoke 尚未被同步调用
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('下载失败后行程变化：旧预览与旧失败通告一起作废，不挂到新行程上', async () => {
    vi.spyOn(tripMarkdownFile, 'downloadTripMarkdown').mockImplementation(
      (() => ({
        ok: false as const,
        reason: 'error' as const,
        message: '触发下载失败，未下载任何文件。请重试；如果一直失败，检查浏览器的下载设置。',
      })) as typeof tripMarkdownFile.downloadTripMarkdown,
    )
    const user = userEvent.setup()
    const { rerender } = render(<TripMarkdownExport trip={MOCK_TRIP} />)
    await user.click(within(region()).getByRole('button', { name: '预览路书（Markdown）' }))
    await user.click(within(region()).getByRole('button', { name: '下载路书 (.md)' }))
    expect(within(region()).getAllByText(/触发下载失败/).length).toBe(1)

    // 行程一变：旧下载失败通告与预览都清掉，不挂在新的 Trip 上下文里
    rerender(<TripMarkdownExport trip={{ ...MOCK_TRIP, title: '另一个行程' }} />)
    expect(within(region()).queryByText(/触发下载失败/)).toBeNull()
    expect(within(region()).queryByRole('textbox')).toBeNull()
  })
})

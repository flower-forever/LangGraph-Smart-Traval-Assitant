import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TRIP_MARKDOWN_URL_REVOKE_DELAY_MS,
  downloadTripMarkdown,
} from '../lib/tripMarkdownFile'
import { TRIP_MARKDOWN_MIME_TYPE } from '../lib/tripMarkdown'
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
let scheduled: Array<{ callback: () => void; delayMs: number }>

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:md-test')
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
  scheduled = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  const urlStatics = URL as unknown as Record<string, unknown>
  delete urlStatics.createObjectURL
  delete urlStatics.revokeObjectURL
  document.body.innerHTML = ''
})

const MARKDOWN = '# 杭州三日漫步路书\n\n测试内容。'

describe('downloadTripMarkdown：显式下载', () => {
  it('用传入的文本创建 text/markdown Blob，触发一次点击并延迟回收', async () => {
    const schedule = vi.fn((callback: () => void, delayMs: number) => {
      scheduled.push({ callback, delayMs })
    })
    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, { schedule })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.filename).toBe('杭州-杭州三日漫步路书.md')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe(TRIP_MARKDOWN_MIME_TYPE)
    expect(outcome.blob).toBe(blob)
    expect(outcome.bytes).toBe(blob.size)
    expect(outcome.markdown).toBe(MARKDOWN)
    expect(await readBlob(blob)).toBe(MARKDOWN)

    expect(scheduled).toEqual([{ callback: expect.any(Function), delayMs: TRIP_MARKDOWN_URL_REVOKE_DELAY_MS }])
    scheduled[0].callback()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:md-test')
  })

  it('anchor 带 download 文件名与 noopener，挂在 body 上且点击后移除', () => {
    let createdAnchor: HTMLAnchorElement | null = null
    const originalCreate = document.createElement.bind(document)
    const doc = {
      createElement: (tag: string) => {
        const el = originalCreate(tag)
        if (tag === 'a') createdAnchor = el as HTMLAnchorElement
        return el
      },
      body: document.body,
    } as unknown as Document

    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, { document: doc, schedule: () => {} })
    expect(outcome.ok).toBe(true)
    expect(createdAnchor).not.toBeNull()
    const anchor = createdAnchor as unknown as HTMLAnchorElement
    expect(anchor.href).toContain('blob:')
    expect(anchor.download).toBe('杭州-杭州三日漫步路书.md')
    expect(anchor.rel).toBe('noopener')
    // finally 里的 remove 已经把它摘下来
    expect(anchor.isConnected).toBe(false)
  })

  it('download 只发起浏览器下载，不写 localStorage、不发请求', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    window.localStorage.clear()
    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, { schedule: () => {} })
    expect(outcome.ok).toBe(true)
    expect(window.localStorage.getItem('travel-assistant:saved-trips:v1')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('downloadTripMarkdown：fail-closed', () => {
  it('没有预览文本（null / undefined / 空串）时不创建 Blob URL', () => {
    for (const text of [null, undefined, '']) {
      const outcome = downloadTripMarkdown(MOCK_TRIP, text as string | null)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.reason).toBe('missing_text')
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    }
  })

  it('URL API 不可用返回 unsupported 固定文案', () => {
    const urlStatics = URL as unknown as Record<string, unknown>
    urlStatics.createObjectURL = undefined
    urlStatics.revokeObjectURL = undefined

    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unsupported')
    expect(outcome.message).toContain('URL.createObjectURL 不可用')
  })

  it('createObjectURL 抛错时返回 error，固定文案不回显原始异常', () => {
    createObjectURL.mockImplementation(() => {
      throw new Error('quota boom secret/path')
    })
    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('error')
    expect(outcome.message).toContain('创建下载链接失败')
    expect(outcome.message).toContain('未下载任何文件')
    // 固定文案承诺：原始异常文本不进界面
    expect(outcome.message).not.toContain('quota boom')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('Blob 构造抛错时返回固定 error，不创建 URL 不点击', () => {
    const originalBlob = globalThis.Blob
    class BrokenBlob {
      constructor() {
        throw new Error('blob boom')
      }
    }
    ;(globalThis as unknown as { Blob: unknown }).Blob = BrokenBlob
    try {
      const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reason).toBe('error')
      expect(outcome.message).toContain('创建下载链接失败')
      expect(outcome.message).not.toContain('blob boom')
      expect(createObjectURL).not.toHaveBeenCalled()
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as unknown as { Blob: unknown }).Blob = originalBlob
    }
  })

  it('anchor 属性设置抛错时回收 URL 并返回固定 error，不点击不残留', () => {
    const originalCreate = document.createElement.bind(document)
    const doc = {
      createElement: (tag: string) => {
        const el = originalCreate(tag) as HTMLAnchorElement
        if (tag === 'a') {
          Object.defineProperty(el, 'href', {
            set() {
              throw new Error('href blocked')
            },
          })
        }
        return el
      },
      body: document.body,
    } as unknown as Document

    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, { document: doc })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('error')
    expect(outcome.message).toContain('创建下载链接失败')
    expect(outcome.message).not.toContain('href blocked')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:md-test')
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(document.querySelectorAll('a[download]').length).toBe(0)
  })

  it('appendChild 抛错时移除已插入节点并回收 URL，返回固定 error', () => {
    const originalCreate = document.createElement.bind(document)
    const created: HTMLAnchorElement[] = []
    const brokenBody = {
      appendChild: (child: Node) => {
        created.push(child as HTMLAnchorElement)
        // 模拟宿主在部分插入后抛错
        child.textContent = 'half-inserted'
        throw new Error('append blocked')
      },
    }
    const doc = {
      createElement: originalCreate,
      body: brokenBody,
    } as unknown as Document

    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, { document: doc })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('error')
    expect(outcome.message).toContain('触发下载失败')
    expect(outcome.message).not.toContain('append blocked')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:md-test')
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    // anchor 已按清理意图处理：不留下第二次点击或残留下载元素
    expect(created.length).toBe(1)
    expect(document.querySelectorAll('a[download]').length).toBe(0)
  })

  it('click 抛错时立即回收 URL 并返回 error，不冒充成功', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('download blocked')
    })
    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('error')
    expect(outcome.message).not.toContain('download blocked')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:md-test')
  })

  it('schedule 抛错时不让异常逃出事件，下载仍算成功（best-effort 回收）', () => {
    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, {
      schedule: () => {
        throw new Error('timer boom')
      },
    })
    // 成功结果就是 ok:true，不带异常文本；不因调度失败伪称下载失败
    expect(outcome.ok).toBe(true)
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
  })

  it('schedule 抛错后改用默认 setTimeout 兜底：revoke 最终发生，click 只有一次', () => {
    vi.useFakeTimers()
    try {
      const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, {
        revokeDelayMs: 1000,
        schedule: () => {
          throw new Error('timer boom')
        },
      })
      expect(outcome.ok).toBe(true)
      expect(revokeObjectURL).not.toHaveBeenCalled()
      // 默认调度器接管后，到期时 URL 被回收，不会只能等页面关闭
      vi.advanceTimersByTime(1000)
      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:md-test')
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('注入调度器先执行回调再抛错：回收幂等，不重复 revoke，异常不逃逸，兜底不再重复回收', () => {
    vi.useFakeTimers()
    try {
      const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, {
        revokeDelayMs: 1000,
        schedule: (callback: () => void) => {
          callback()
          throw new Error('timer boom after callback')
        },
      })
      expect(outcome.ok).toBe(true)
      // 回调已执行一次；兜底路径注册默认 setTimeout，到期后幂等守卫拦截，仍是 1 次
      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1000)
      expect(revokeObjectURL).toHaveBeenCalledTimes(1)
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('正常路径行为不变：注入的 schedule 收到 revokeDelayMs，不抛错时不兜底', () => {
    const schedule = vi.fn()
    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, { schedule, revokeDelayMs: 500 })
    expect(outcome.ok).toBe(true)
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 500)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('没有 document 的环境返回 unsupported', () => {
    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, { document: null })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unsupported')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('revoke 自身抛错不影响业务结果', () => {
    revokeObjectURL.mockImplementation(() => {
      throw new Error('revoke failed')
    })
    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, { schedule: () => {} })
    expect(outcome.ok).toBe(true)
  })

  it('anchor.remove 抛错不影响下载成功结果', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'remove').mockImplementation(() => {
      throw new Error('remove failed')
    })
    const outcome = downloadTripMarkdown(MOCK_TRIP, MARKDOWN, { schedule: () => {} })
    expect(outcome.ok).toBe(true)
  })
})

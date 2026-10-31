/**
 * tripBudgetFile.ts 测试：文件名、Blob 构造、显式下载（同一份预览 JSON）、
 * URL / DOM / 调度清理、失败固定文案、幂等回收、下载不假称落盘；
 * 文件读取：字节路径优先（严格 UTF-8 解码 + BOM 合同）、File.size 门禁
 * （缺失 / 超限 / 异常 size）、maxBytes 非法配置独立错误、File.text 与
 * FileReader 兜底、工厂抛错受控、读错 / 取消、过期结果由调用方守卫。
 * 全部离线 fake / DOM，不真实下载。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BudgetTextFileReader, BudgetUploadLike } from '../lib/tripBudgetFile'
import {
  BUDGET_URL_REVOKE_DELAY_MS,
  downloadBudgetBackup,
  readBudgetBackupFile,
} from '../lib/tripBudgetFile'
import { createBudgetBackup, MAX_BUDGET_TRANSFER_BYTES } from '../lib/tripBudgetTransfer'
import { utf8ByteLength } from '../lib/savedTrips'

const JSON_TEXT = JSON.stringify({
  format: 'travel-assistant.budget',
  version: 1,
  currency: 'CNY',
  trip: { id: 'trip-1', title: '杭州三日' },
  draft: { budgetRaw: '100', rows: [{ id: 'r1', category: 'other', name: 'x', amountRaw: '1' }] },
})

function fakeReader(behavior: 'load' | 'error' | 'abort', result: string | ArrayBuffer = ''): BudgetTextFileReader {
  const reader: BudgetTextFileReader = {
    result: null,
    error: null,
    onload: null,
    onerror: null,
    onabort: null,
    readAsText() {
      queueMicrotask(() => {
        if (behavior === 'load') {
          reader.result = result
          reader.onload?.()
          return
        }
        if (behavior === 'error') {
          reader.error = new Error('E: 读盘失败 /secret/path')
          reader.onerror?.()
          return
        }
        reader.onabort?.()
      })
    },
  }
  return reader
}

beforeEach(() => {
  document.body.innerHTML = ''
  // jsdom 不实现下载导航：挡掉真实点击
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('downloadBudgetBackup：下载 adapter', () => {
  function setupUrl(impl?: (blob: Blob) => string) {
    const createObjectURL = vi.fn(impl ?? (() => 'blob:budget-1'))
    const revokeObjectURL = vi.fn()
    return { createObjectURL, revokeObjectURL }
  }

  it('预览文本原样进 Blob：bytes 等于 Blob.size，文件名来自 metadata 且净化', () => {
    const { createObjectURL, revokeObjectURL } = setupUrl()
    const outcome = downloadBudgetBackup(JSON_TEXT, { id: 'trip-1', title: '杭州三日' }, {
      createObjectURL,
      revokeObjectURL,
      revokeDelayMs: 0,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.filename).toBe('budget-杭州三日-trip-1.budget.json')
    expect(outcome.blob.size).toBe(utf8ByteLength(JSON_TEXT))
    expect(outcome.json).toBe(JSON_TEXT)
    expect(outcome.bytes).toBe(utf8ByteLength(JSON_TEXT))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('成功后延迟回收 URL：默认延迟 1000ms，注入调度器可控', () => {
    vi.useFakeTimers()
    const { createObjectURL, revokeObjectURL } = setupUrl()
    const outcome = downloadBudgetBackup(JSON_TEXT, { id: 'trip-1', title: 't' }, {
      createObjectURL,
      revokeObjectURL,
    })
    expect(outcome.ok).toBe(true)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BUDGET_URL_REVOKE_DELAY_MS)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:budget-1')
    // 幂等：再推进不会重复回收
    vi.advanceTimersByTime(BUDGET_URL_REVOKE_DELAY_MS)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('点击失败：立即回收 URL、移除 anchor、固定文案不回显异常', async () => {
    const { createObjectURL, revokeObjectURL } = setupUrl()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('点击被宿主拦截 /secret/detail')
    })
    const outcome = downloadBudgetBackup(JSON_TEXT, { id: 't', title: 't' }, {
      createObjectURL,
      revokeObjectURL,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('error')
    expect(outcome.message).not.toContain('/secret/detail')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:budget-1')
    expect(document.querySelector('a')).toBeNull()
  })

  it('createObjectURL / createElement / 属性设置 / appendChild 抛错：受控失败并清理', () => {
    const { createObjectURL, revokeObjectURL } = setupUrl(() => {
      throw new Error('quota')
    })
    const failCreate = downloadBudgetBackup(JSON_TEXT, null, { createObjectURL, revokeObjectURL })
    expect(failCreate.ok).toBe(false)
    if (!failCreate.ok) expect(failCreate.message).not.toContain('quota')

    const docStub = {
      createElement: vi.fn(() => {
        throw new Error('nope')
      }),
      body: document.body,
    }
    const failElement = downloadBudgetBackup(JSON_TEXT, null, {
      createObjectURL: vi.fn(() => 'blob:x'),
      revokeObjectURL,
      document: docStub as unknown as Document,
    })
    expect(failElement.ok).toBe(false)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')

    const anchorStub = {
      href: '',
      download: '',
      rel: '',
      style: {} as CSSStyleDeclaration,
    }
    const docProps = {
      createElement: vi.fn(() => anchorStub),
      body: {
        appendChild: vi.fn(() => {
          throw new Error('denied')
        }),
      },
    }
    const failAppend = downloadBudgetBackup(JSON_TEXT, null, {
      createObjectURL: vi.fn(() => 'blob:y'),
      revokeObjectURL,
      document: docProps as unknown as Document,
    })
    expect(failAppend.ok).toBe(false)
    if (!failAppend.ok) expect(failAppend.message).not.toContain('denied')
  })

  it('调度器抛错：改用默认调度兜底且不重复回收；点击已发起按成功处理', () => {
    vi.useFakeTimers()
    const { createObjectURL, revokeObjectURL } = setupUrl()
    const outcome = downloadBudgetBackup(JSON_TEXT, { id: 't', title: 't' }, {
      createObjectURL,
      revokeObjectURL,
      revokeDelayMs: 50,
      schedule: vi.fn(() => {
        throw new Error('scheduler down')
      }),
    })
    expect(outcome.ok).toBe(true)
    vi.advanceTimersByTime(50)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('调度器先执行回调再抛错：回收幂等，不重复回收', () => {
    const { createObjectURL, revokeObjectURL } = setupUrl()
    const outcome = downloadBudgetBackup(JSON_TEXT, { id: 't', title: 't' }, {
      createObjectURL,
      revokeObjectURL,
      revokeDelayMs: 0,
      schedule: (callback) => {
        callback()
        throw new Error('after callback')
      },
    })
    expect(outcome.ok).toBe(true)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('missing_text：没有预览文本时 fail-closed，不创建 URL', () => {
    const { createObjectURL, revokeObjectURL } = setupUrl()
    for (const text of [null, undefined, '']) {
      const outcome = downloadBudgetBackup(text as never, null, { createObjectURL, revokeObjectURL })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toBe('missing_text')
    }
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('没有 document / 不支持 URL API：unsupported 固定文案', () => {
    const noDoc = downloadBudgetBackup(JSON_TEXT, null, { document: null })
    expect(noDoc.ok).toBe(false)
    if (!noDoc.ok) expect(noDoc.reason).toBe('unsupported')
    const noUrl = downloadBudgetBackup(JSON_TEXT, null, {
      createObjectURL: undefined,
      revokeObjectURL: undefined,
      document: {
        createElement: () => document.createElement('a'),
        body: document.body,
      } as unknown as Document,
    })
    expect(noUrl.ok).toBe(false)
    if (!noUrl.ok) expect(noUrl.message).not.toContain('undefined')
  })

  it('下载成功只表示已发起：不写存储、不发网络（由调用方组件测试再断言 UI 文案）', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const { createObjectURL, revokeObjectURL } = setupUrl()
    const outcome = downloadBudgetBackup(JSON_TEXT, null, {
      createObjectURL,
      revokeObjectURL,
      revokeDelayMs: 0,
    })
    expect(outcome.ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    setItemSpy.mockRestore()
  })
})

describe('readBudgetBackupFile：文件读取', () => {
  const JSON_BYTES = new TextEncoder().encode(JSON_TEXT)

  function goodFile(overrides: Partial<BudgetUploadLike> = {}): BudgetUploadLike {
    return {
      name: 'backup.budget.json',
      size: JSON_BYTES.byteLength,
      arrayBuffer: () => Promise.resolve(JSON_BYTES.slice().buffer),
      text: () => Promise.resolve(JSON_TEXT),
      ...overrides,
    }
  }

  it('合法文件：字节路径解析通过', async () => {
    const result = await readBudgetBackupFile(goodFile())
    expect(result.ok).toBe(true)
  })

  it('File.size 超限：读前拒绝，不调用任何读取方法', async () => {
    const text = vi.fn(() => Promise.resolve(JSON_TEXT))
    const arrayBuffer = vi.fn(() => Promise.resolve(JSON_BYTES.buffer))
    const result = await readBudgetBackupFile(goodFile({ size: MAX_BUDGET_TRANSFER_BYTES + 1, text, arrayBuffer }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('too_large')
    expect(text).not.toHaveBeenCalled()
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('File.size 异常（NaN / 负数 / Infinity / 小数 / 非数字）：保守拒绝不读取', async () => {
    const text = vi.fn(() => Promise.resolve(JSON_TEXT))
    const arrayBuffer = vi.fn(() => Promise.resolve(JSON_BYTES.buffer))
    for (const size of [Number.NaN, -1, Number.POSITIVE_INFINITY, 1.5, '100' as unknown as number]) {
      const result = await readBudgetBackupFile(goodFile({ size, text, arrayBuffer }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('read_error')
        expect(result.message).not.toContain('NaN')
      }
    }
    expect(text).not.toHaveBeenCalled()
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('File.size 缺失：保守拒绝，不无界读（复现点6修复前直接读全文）', async () => {
    const text = vi.fn(() => Promise.resolve(JSON_TEXT))
    const arrayBuffer = vi.fn(() => Promise.resolve(JSON_BYTES.buffer))
    const result = await readBudgetBackupFile(goodFile({ size: undefined, text, arrayBuffer }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('read_error')
    expect(text).not.toHaveBeenCalled()
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('maxBytes 非法配置：独立 invalid_options，不伪装文件过大也不绕固定 cap', async () => {
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 256 * 1024 + 1]) {
      const result = await readBudgetBackupFile(goodFile(), { maxBytes })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('invalid_options')
    }
  })

  it('字节路径超限：读后字节复核也拒绝（size 与实际不一致时不漏判）', async () => {
    const bigBytes = new TextEncoder().encode('长'.repeat(90_000))
    const result = await readBudgetBackupFile(goodFile({
      size: 10,
      arrayBuffer: () => Promise.resolve(bigBytes.buffer),
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('too_large')
  })

  it('字节路径 + 严格解码：坏 UTF-8 固定错误，不静默替换（复现点7）', async () => {
    const bad = new Uint8Array(new TextEncoder().encode(JSON_TEXT))
    const idx = bad.indexOf(0x22) // 第一个引号后一字节改成孤立续字节 → 非法序列
    bad[idx + 1] = 0x80
    const result = await readBudgetBackupFile(goodFile({ arrayBuffer: () => Promise.resolve(bad.buffer) }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('read_error')
      expect(result.message).toContain('UTF-8')
    }
  })

  it('BOM 合同经字节路径：单 BOM 允许，双 BOM 拒绝（复现点7：原生吞 BOM 的问题不再存在）', async () => {
    const body = new TextEncoder().encode(JSON_TEXT)
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    const single = new Uint8Array(bom.length + body.length)
    single.set(bom, 0)
    single.set(body, bom.length)
    const okResult = await readBudgetBackupFile(goodFile({
      size: single.byteLength,
      arrayBuffer: () => Promise.resolve(single.buffer),
    }))
    expect(okResult.ok).toBe(true)

    const double = new Uint8Array(bom.length * 2 + body.length)
    double.set(bom, 0)
    double.set(bom, bom.length)
    double.set(body, bom.length * 2)
    const badResult = await readBudgetBackupFile(goodFile({
      size: double.byteLength,
      arrayBuffer: () => Promise.resolve(double.buffer),
    }))
    expect(badResult.ok).toBe(false)
    if (!badResult.ok) expect(badResult.reason).toBe('parse_error')
  })

  it('File.text 抛错 / 返回非字符串：read_error 固定文案（仅字节接口本来不可用时的兼容路径）', async () => {
    const thrown = await readBudgetBackupFile(goodFile({ arrayBuffer: undefined, text: () => Promise.reject(new Error('disk /secret')) }))
    expect(thrown.ok).toBe(false)
    if (!thrown.ok) {
      expect(thrown.reason).toBe('read_error')
      expect(thrown.message).not.toContain('/secret')
    }
    const nonText = await readBudgetBackupFile(goodFile({
      arrayBuffer: undefined,
      text: () => Promise.resolve(42 as never),
    }))
    expect(nonText.ok).toBe(false)
    if (!nonText.ok) expect(nonText.reason).toBe('read_error')
  })

  it('字节接口存在但读取失败：固定 read_error，不降级 text，不泄露 raw（发布前窄收尾）', async () => {
    // text 能返回合法 JSON：若错误降级，这份文件会被当成合法导入——修复前正是这样
    const text = vi.fn(() => Promise.resolve(JSON_TEXT))
    const rejected = await readBudgetBackupFile(
      goodFile({ arrayBuffer: () => Promise.reject(new Error('read /secret/fail')), text }),
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.reason).toBe('read_error')
      expect(rejected.message).not.toContain('/secret')
    }
    expect(text).not.toHaveBeenCalled()

    // 同步抛错同样固定失败、不降级
    const textAfterSyncThrow = vi.fn(() => Promise.resolve(JSON_TEXT))
    const syncThrow = await readBudgetBackupFile(
      goodFile({
        arrayBuffer: () => {
          throw new Error('sync boom /secret')
        },
        text: textAfterSyncThrow,
      }),
    )
    expect(syncThrow.ok).toBe(false)
    if (!syncThrow.ok) {
      expect(syncThrow.reason).toBe('read_error')
      expect(syncThrow.message).not.toContain('/secret')
    }
    expect(textAfterSyncThrow).not.toHaveBeenCalled()
  })

  it('没有 arrayBuffer 时用 FileReader 兜底：load / error / abort', async () => {
    const loaded = await readBudgetBackupFile(goodFile({ arrayBuffer: undefined, text: undefined }), {
      fileReaderFactory: () => fakeReader('load', JSON_TEXT),
    })
    expect(loaded.ok).toBe(true)

    const failed = await readBudgetBackupFile(goodFile({ arrayBuffer: undefined, text: undefined }), {
      fileReaderFactory: () => fakeReader('error'),
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.message).not.toContain('/secret')

    const aborted = await readBudgetBackupFile(goodFile({ arrayBuffer: undefined, text: undefined }), {
      fileReaderFactory: () => fakeReader('abort'),
    })
    expect(aborted.ok).toBe(false)
    if (!aborted.ok) expect(aborted.reason).toBe('read_error')
  })

  it('fileReaderFactory 抛错：固定 read_error，raw 异常不逃出 async（复现点6）', async () => {
    const result = await readBudgetBackupFile(goodFile({ arrayBuffer: undefined, text: undefined }), {
      fileReaderFactory: () => {
        throw new Error('raw FileReader boom /secret')
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('read_error')
      expect(result.message).not.toContain('/secret')
      expect(result.message).not.toContain('boom')
    }
  })

  it('两种读取方式都不可用：固定文案', async () => {
    const result = await readBudgetBackupFile(goodFile({ arrayBuffer: undefined, text: undefined }), {
      fileReaderFactory: () => null as unknown as BudgetTextFileReader,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('read_error')
  })

  it('坏内容照样落到解析层固定错误（readBudgetBackupFile 不吞解析结果）', async () => {
    const bad = await readBudgetBackupFile(goodFile({ arrayBuffer: undefined, text: () => Promise.resolve('not json') }))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('parse_error')
    const wrongFormat = await readBudgetBackupFile(goodFile({
      arrayBuffer: undefined,
      text: () => Promise.resolve(JSON.stringify({ format: 'other', version: 1, currency: 'CNY', draft: {} })),
    }))
    expect(wrongFormat.ok).toBe(false)
    if (!wrongFormat.ok) expect(wrongFormat.reason).toBe('format_mismatch')
  })
})

describe('生成与下载闭环', () => {
  it('createBudgetBackup 生成的 JSON 原样可下载：同一份字节，不重生成', () => {
    const source = createBudgetBackup({
      tripId: 'trip-1',
      tripTitle: '杭州三日',
      budgetRaw: '100',
      rows: [{ id: 'r1', category: 'other', name: 'x', amountRaw: '1' }],
    })
    if (!source.ok) throw new Error(source.message)
    const { createObjectURL } = {
      createObjectURL: vi.fn(() => 'blob:same'),
    }
    const outcome = downloadBudgetBackup(source.json, source.trip, {
      createObjectURL,
      revokeObjectURL: vi.fn(),
      revokeDelayMs: 0,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.json).toBe(source.json)
    expect(outcome.bytes).toBe(source.bytes)
  })
})

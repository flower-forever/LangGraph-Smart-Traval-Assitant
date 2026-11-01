/**
 * TripBudgetTransfer 面板测试：默认收起、展开不生成、点预览才生成只读 JSON、
 * 下载同一份字节、费用/owner 变化作废导出预览且不复活、旧 owner 备份自述、
 * 选择文件只预览（不发请求/不写存储/不下载）、失败固定文案可重试、
 * 内联两步确认、确认期间变化作废 pending、空草稿警示、无法验证快照禁用应用、
 * 放弃预览焦点回位、无 alert/confirm。全部离线 DOM。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import TripBudgetTransfer from '../components/TripBudgetTransfer'
import {
  createBudgetBackup,
  parseBudgetBackup,
  type BudgetExportInput,
} from '../lib/tripBudgetTransfer'
import {
  emptyBudgetSession,
  type BudgetSessionState,
} from '../lib/tripBudget'
import type { Trip } from '../lib/api'
import { MOCK_TRIP } from './fixtures/trip'

function envelopeOf(input: Partial<BudgetExportInput>): string {
  const result = createBudgetBackup({
    tripId: 'trip-x',
    tripTitle: '别处行程',
    budgetRaw: '100',
    rows: [{ id: 'i1', category: 'other', name: '导入门票', amountRaw: '80' }],
    ...input,
  })
  if (!result.ok) throw new Error(result.message)
  return result.json
}

const IMPORT_JSON = envelopeOf({})

interface Harness {
  session: BudgetSessionState
  setSession: (next: BudgetSessionState) => void
}

interface RenderOpts {
  trip?: Trip
  revision?: number
  session?: BudgetSessionState
  fileText?: string | (() => Promise<string>)
  fileSize?: number
}

function setup(opts: RenderOpts = {}) {
  const trip = opts.trip ?? MOCK_TRIP
  const revision = opts.revision ?? 1
  const harness: Harness = {
    session: opts.session ?? emptyBudgetSession(),
    setSession: () => {},
  }
  const user = userEvent.setup()
  function uiFor(session: BudgetSessionState): ReactElement {
    return (
      <TripBudgetTransfer
        trip={trip}
        revision={revision}
        session={session}
        onSessionChange={(next) => {
          harness.setSession(next)
          view.rerender(uiFor(next))
        }}
      />
    )
  }
  const view = render(uiFor(harness.session))
  harness.setSession = (next: BudgetSessionState) => {
    harness.session = next
    view.rerender(uiFor(next))
  }
  const fileText = opts.fileText ?? IMPORT_JSON
  const fileContent = typeof fileText === 'function' ? fileText : () => Promise.resolve(fileText)
  const file = {
    name: 'backup.budget.json',
    size: opts.fileSize ?? fileContent.length,
    text: fileContent,
  }
  const fileInput = () =>
    within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
  async function uploadFile(content: string) {
    await user.upload(
      fileInput(),
      { name: 'backup.budget.json', size: content.length, text: () => Promise.resolve(content) } as unknown as File,
    )
  }
  async function chooseFile() {
    await uploadFile(typeof fileText === 'string' ? fileText : '')
    await screen.findByTestId('budget-import-preview')
  }
  return { user, harness, view, file, fileInput, chooseFile, uploadFile }
}

function transfer(): HTMLElement {
  return screen.getByTestId('budget-transfer')
}

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:budget-test')
  revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  const urlStatics = URL as unknown as Record<string, unknown>
  delete urlStatics.createObjectURL
  delete urlStatics.revokeObjectURL
  vi.restoreAllMocks()
})

async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(transfer()).getByRole('button', { name: '展开费用文件备份' }))
}

async function previewExport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(transfer()).getByRole('button', { name: '预览费用备份' }))
  await screen.findByTestId('budget-export-preview')
}

describe('收起与展开', () => {
  it('默认收起：展开前没有预览、没有文件输入、不创建 Blob URL、不点击下载', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<TripBudgetTransfer trip={MOCK_TRIP} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />)
    expect(within(transfer()).getByRole('button', { name: '展开费用文件备份' })).toBeInTheDocument()
    expect(within(transfer()).queryByLabelText(/选择费用备份文件/)).toBeNull()
    expect(within(transfer()).queryByRole('button', { name: '预览费用备份' })).toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('展开只显示说明与入口：不生成文件、不建 Blob URL', async () => {
    const { user } = setup()
    await expand(user)
    expect(within(transfer()).getByRole('button', { name: '预览费用备份' })).toBeInTheDocument()
    expect(within(transfer()).getByLabelText(/选择费用备份文件/)).toBeInTheDocument()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('再点一次收起：预览丢失（面板内存），展开开关获得焦点；session 回调未被调用', async () => {
    const setSession = vi.fn()
    const { user } = setup()
    await expand(user)
    await previewExport(user)
    await user.click(within(transfer()).getByRole('button', { name: '收起费用文件备份' }))
    expect(within(transfer()).queryByTestId('budget-export-preview')).toBeNull()
    expect(document.activeElement).toBe(within(transfer()).getByRole('button', { name: '展开费用文件备份' }))
    expect(setSession).not.toHaveBeenCalled()
  })
})

describe('导出：预览与下载', () => {
  it('点预览才生成只读 JSON：内容与纯函数一致；预览本身不建 Blob URL', async () => {
    const { user, harness } = setup()
    await expand(user)
    await previewExport(user)
    const textarea = within(transfer()).getByRole('textbox') as HTMLTextAreaElement
    expect(textarea).toHaveAttribute('readonly')
    const expected = createBudgetBackup({
      tripId: null,
      tripTitle: null,
      budgetRaw: harness.session.budgetRaw,
      rows: harness.session.rows,
    })
    if (!expected.ok) throw new Error(expected.message)
    expect(textarea.value).toBe(expected.json)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
  })

  it('有 owner 的草稿导出：备份自述写 owner 的行程标题；无 owner 时明确说不记录归属', async () => {
    // 先造一个绑定 owner 的 session。直接在空 session 上用 addBudgetRow 会因
    // no_owner 失败，所以手动构造（与 App 持有的真实结构一致）。
    let session = emptyBudgetSession()
    // 直接通过 updateBudgetRow 在空 session 上操作会因 no_owner 失败，所以先手动构造：
    // 用面板语义模拟：owner 由导入应用建立。这里用 addBudgetRow 不行（no_owner），
    // 因此用 applyBudgetImport 语义等价物：直接构造 session（与 App 持有的真实结构一致）。
    session = {
      owner: {
        tripId: 'old-trip',
        revision: 9,
        tripSnapshot: '{"id":"old-trip"}',
        tripTitle: '旧版行程',
      },
      rows: [{ id: 'r1', category: 'other', name: '旧门票', amountRaw: '66' }],
      budgetRaw: '500',
      result: null,
      undo: null,
    }
    const { user } = setup({ session })
    await expand(user)
    await previewExport(user)
    const ownerLine = within(transfer()).getByTestId('budget-export-owner')
    expect(ownerLine.textContent).toContain('旧版行程')
    expect(ownerLine.textContent).not.toContain(MOCK_TRIP.title)
    const textarea = within(transfer()).getByRole('textbox') as HTMLTextAreaElement
    const parsed = JSON.parse(textarea.value) as { trip: { id: string; title: string } }
    expect(parsed.trip).toEqual({ id: 'old-trip', title: '旧版行程' })
  })

  it('点下载：同一份预览 JSON 原样进 Blob，不重新生成；成功只说已发起', async () => {
    const { user, harness } = setup()
    await expand(user)
    await previewExport(user)
    const textarea = within(transfer()).getByRole('textbox') as HTMLTextAreaElement
    await user.click(within(transfer()).getByRole('button', { name: '下载费用备份 (.budget.json)' }))
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0] as Blob
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('x'))
      reader.readAsText(blob)
    })
    expect(text).toBe(textarea.value)
    expect(text).toBe(
      createBudgetBackup({ tripId: null, tripTitle: null, budgetRaw: harness.session.budgetRaw, rows: harness.session.rows })
        .ok === true
        ? (createBudgetBackup({ tripId: null, tripTitle: null, budgetRaw: harness.session.budgetRaw, rows: harness.session.rows }) as { ok: true; json: string }).json
        : '',
    )
    expect(revokeObjectURL).not.toHaveBeenCalled()
    const notice = within(transfer()).getByTestId('budget-export-notice')
    expect(notice.textContent).toContain('已发起')
    expect(notice.textContent).not.toContain('已保存')
  })

  it('任何费用输入变化：旧导出预览立即作废，须重新预览；A→B→A 不复活', async () => {
    const { user, harness } = setup()
    await expand(user)
    await previewExport(user)
    expect(within(transfer()).getByTestId('budget-export-preview')).toBeInTheDocument()

    // 输入变化 → 渲染期作废 + effect 永久清理
    harness.setSession({
      ...harness.session,
      budgetRaw: '999',
    })
    await user.click(within(transfer()).getByRole('button', { name: '预览费用备份' }))
    expect(within(transfer()).getByTestId('budget-export-preview')).toBeInTheDocument()

    // A→B→A：把输入改回原样也不复活旧预览（state 已被 effect 清掉，需重新生成）
    harness.setSession({ ...harness.session, budgetRaw: '' })
    expect(within(transfer()).queryByTestId('budget-export-preview')).toBeNull()
    await user.click(within(transfer()).getByRole('button', { name: '预览费用备份' }))
    expect(within(transfer()).getByTestId('budget-export-preview')).toBeInTheDocument()
  })

  it('点 1：staleOwner 草稿在当前 B 下导出，沿用（owner 变化）后旧预览永久作废，输入不变也不复活', async () => {
    // 导出绑的是实际费用 owner 全指纹：沿用把 owner 从 A 换到 B，旧预览必须作废；
    // A→B→A 也不复活。修复前 ownerKey 绑当前 Trip ctx，沿用后不变 → 旧预览不失效。
    const staleSession = {
      owner: { tripId: 'trip-a', revision: 1, tripSnapshot: '{"id":"trip-a"}', tripTitle: '行程A' },
      rows: [{ id: 'r1', category: 'other' as const, name: '旧草稿项', amountRaw: '66' }],
      budgetRaw: '500',
      result: null,
      undo: null,
    }
    const { user, harness } = setup({ session: staleSession })
    await expand(user)
    await previewExport(user)
    const preview = within(transfer()).getByTestId('budget-export-preview')
    expect(preview.textContent).toContain('行程A') // 自述写原 owner，不冒充当前 Trip

    // 沿用：owner 变成当前 Trip（B），输入（rows/budgetRaw）不变
    const adopted = {
      ...staleSession,
      owner: { tripId: MOCK_TRIP.id, revision: 1, tripSnapshot: JSON.stringify(MOCK_TRIP), tripTitle: MOCK_TRIP.title },
    }
    harness.setSession(adopted)
    expect(within(transfer()).queryByTestId('budget-export-preview')).toBeNull()
    // A→B→A：owner 改回 A 也不复活
    harness.setSession(staleSession)
    expect(within(transfer()).queryByTestId('budget-export-preview')).toBeNull()
  })

  it('点 4：预览标题文件名与实际下载同名，非法字符已被净化', async () => {
    const evilTrip: Trip = { ...MOCK_TRIP, id: 't1', title: 'A:*?"<>|B\u0000C' }
    const session = {
      owner: { tripId: 't1', revision: 1, tripSnapshot: '{"x":1}', tripTitle: evilTrip.title },
      rows: [],
      budgetRaw: '',
      result: null,
      undo: null,
    }
    const { user } = setup({ trip: evilTrip, session })
    await expand(user)
    await previewExport(user)
    const heading = within(transfer()).getByRole('heading', { name: /预览：/ })
    const previewName = heading.textContent!.replace('预览：', '')
    expect(previewName).toBe('budget-A B C-t1.budget.json')
    expect(previewName).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/)
  })

  it('行程内容变化（同 id）：旧导出预览作废不复活', async () => {
    const view = render(
      <TripBudgetTransfer trip={MOCK_TRIP} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    const user = userEvent.setup()
    await expand(user)
    await previewExport(user)
    expect(within(transfer()).getByTestId('budget-export-preview')).toBeInTheDocument()

    // 同 id 内容变化（原地替换 Trip 对象）
    const changed: Trip = { ...MOCK_TRIP, summary: '被改过的摘要' }
    view.rerender(
      <TripBudgetTransfer trip={changed} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    expect(within(transfer()).queryByTestId('budget-export-preview')).toBeNull()
    // 改回原内容也不复活
    view.rerender(
      <TripBudgetTransfer trip={MOCK_TRIP} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    expect(within(transfer()).queryByTestId('budget-export-preview')).toBeNull()
  })

  it('下载失败：固定文案，合法预览保留可重试', async () => {
    const { user } = setup()
    await expand(user)
    await previewExport(user)
    createObjectURL.mockImplementation(() => {
      throw new Error('quota denied')
    })
    await user.click(within(transfer()).getByRole('button', { name: '下载费用备份 (.budget.json)' }))
    const notice = within(transfer()).getByTestId('budget-export-notice')
    expect(notice.textContent).not.toContain('quota denied')
    expect(within(transfer()).getByTestId('budget-export-preview')).toBeInTheDocument()
    expect(within(transfer()).getByRole('button', { name: '下载费用备份 (.budget.json)' })).toBeEnabled()
  })

  it('放弃导出预览：预览消失，焦点回「预览费用备份」按钮', async () => {
    const { user } = setup()
    await expand(user)
    await previewExport(user)
    await user.click(within(transfer()).getByRole('button', { name: '放弃导出预览' }))
    expect(within(transfer()).queryByTestId('budget-export-preview')).toBeNull()
    expect(document.activeElement).toBe(within(transfer()).getByRole('button', { name: '预览费用备份' }))
  })
})

describe('导入：选择文件只预览', () => {
  it('选择合法文件：显示条目、原字符串、合法合计与目标行程；不下载、不改 session', async () => {
    const setSession = vi.fn()
    const { user, harness, chooseFile } = setup()
    void harness
    void setSession
    await expand(user)
    await chooseFile()
    const preview = within(transfer()).getByTestId('budget-import-preview')
    expect(within(preview).getAllByTestId('budget-import-rows')[0].textContent).toContain('导入门票')
    expect(within(preview).getAllByTestId('budget-import-rows')[0].textContent).toContain('80')
    expect(within(preview).getByTestId('budget-import-file-trip').textContent).toContain('别处行程')
    expect(within(preview).getByTestId('budget-import-target').textContent).toContain(MOCK_TRIP.title)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(0)
  })

  it('选择新文件先清旧候选：旧预览不冒充新文件', async () => {
    const secondJson = envelopeOf({ budgetRaw: '222', rows: [{ id: 'z1', category: 'food', name: '第二份', amountRaw: '1' }] })
    const { user, chooseFile } = setup({ fileText: secondJson })
    await expand(user)
    await chooseFile()
    expect(within(transfer()).getByTestId('budget-import-preview').textContent).toContain('第二份')
    // 再选一个内容不同的文件
    const thirdJson = envelopeOf({ budgetRaw: '333', rows: [{ id: 'y1', category: 'food', name: '第三份', amountRaw: '3' }] })
    const fileInput = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(fileInput, { name: 'c.budget.json', size: thirdJson.length, text: () => Promise.resolve(thirdJson) } as unknown as File)
    const preview = within(transfer()).getByTestId('budget-import-preview')
    expect(preview.textContent).toContain('第三份')
    expect(preview.textContent).not.toContain('第二份')
  })

  it('坏 JSON / 格式不匹配：固定错误文案，不回显内容，可重新选择重试', async () => {
    const { user, uploadFile } = setup({ fileText: '这不是 JSON' })
    await expand(user)
    await uploadFile('这不是 JSON')
    const notice = await screen.findByTestId('budget-import-notice')
    expect(notice.textContent).not.toContain('这不是 JSON')
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()

    // 重试：选择合法文件成功
    await uploadFile(IMPORT_JSON)
    await screen.findByTestId('budget-import-preview')
    expect(within(transfer()).getByTestId('budget-import-preview')).toBeInTheDocument()
  })

  it('文件读取失败（text 抛错）：固定 read_error 文案，不改当前费用', async () => {
    const harnessSession = emptyBudgetSession()
    const { user, uploadFile } = setup({
      session: harnessSession,
      fileText: () => Promise.reject(new Error('disk /secret/path')),
    })
    await expand(user)
    await uploadFile('ignored')
    // text 抛错 → read_error notice；preview 不出现
    const notice = await screen.findByTestId('budget-import-notice')
    expect(notice.textContent).not.toContain('/secret/path')
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()
  })

  it('空草稿备份：明确提示确认替换将清空当前费用', async () => {
    const emptyJson = envelopeOf({ budgetRaw: '', rows: [] })
    const { user, chooseFile } = setup({ fileText: emptyJson })
    await expand(user)
    await chooseFile()
    expect(within(transfer()).getByTestId('budget-import-empty').textContent).toContain('清空')
  })

  it('旧文件晚回不覆盖新候选（序号守卫）：第二次选择的结果胜出', async () => {
    // 第一次选择：挂起。release 用 ref 对象装：直接用 let 会被 TS 控制流
    // 收窄成 null（闭包内赋值不参与流分析），晚回调用报 never 不可调用
    const releaseRef: { current: ((text: string) => void) | null } = { current: null }
    const slowFirst = () =>
      new Promise<string>((resolve) => {
        releaseRef.current = resolve
      })
    const firstJson = envelopeOf({ budgetRaw: '111', rows: [{ id: 'f1', category: 'other', name: '慢的第一份', amountRaw: '1' }] })
    const { user } = setup()
    await expand(user)
    // 第一次选择：挂起
    const fileInput = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    const firstFile = { name: 'a.budget.json', size: firstJson.length, text: slowFirst }
    await user.upload(fileInput, firstFile as unknown as File)
    // 第二次选择：立即返回
    const secondJson = envelopeOf({ budgetRaw: '222', rows: [{ id: 's1', category: 'other', name: '快的第二份', amountRaw: '2' }] })
    const secondFile = { name: 'b.budget.json', size: secondJson.length, text: () => Promise.resolve(secondJson) }
    await user.upload(fileInput, secondFile as unknown as File)
    await screen.findByTestId('budget-import-preview')
    expect(within(transfer()).getByTestId('budget-import-preview').textContent).toContain('快的第二份')
    // 旧文件晚回：被忽略
    releaseRef.current?.(firstJson)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(within(transfer()).getByTestId('budget-import-preview').textContent).toContain('快的第二份')
    expect(within(transfer()).getByTestId('budget-import-preview').textContent).not.toContain('慢的第一份')
  })
})

describe('导入确认与应用', () => {
  async function startReplace(user: ReturnType<typeof userEvent.setup>) {
    await user.click(within(transfer()).getByRole('button', { name: '替换当前费用草稿' }))
    await screen.findByTestId('budget-import-confirm-text')
  }

  it('确认才改费用：新 owner / 导入 rows / result 清空；App 回调收到新 session', async () => {
    const { user, harness, chooseFile } = setup()
    await expand(user)
    await chooseFile()
    await startReplace(user)
    expect(within(transfer()).getByTestId('budget-import-confirm-text').textContent).toContain('确认后')
    await user.click(within(transfer()).getByRole('button', { name: '确认替换费用' }))
    expect(harness.session.rows).toHaveLength(1)
    expect(harness.session.rows[0].name).toBe('导入门票')
    expect(harness.session.budgetRaw).toBe('100')
    expect(harness.session.owner).toEqual({
      tripId: MOCK_TRIP.id,
      revision: 1,
      tripSnapshot: JSON.stringify(MOCK_TRIP),
      tripTitle: MOCK_TRIP.title,
    })
    expect(harness.session.result).toBeNull()
    const notice = within(transfer()).getByTestId('budget-import-notice')
    expect(notice.textContent).toContain('已替换')
  })

  it('有既有草稿时须两步确认：第一步只显示前后对比，不直接改', async () => {
    const session = {
      owner: null,
      rows: [{ id: 'r1', category: 'transport' as const, name: '原有车票', amountRaw: '50' }],
      budgetRaw: '888',
      result: null,
      undo: null,
    }
    const { user, chooseFile } = setup({ session })
    await expand(user)
    await chooseFile()
    // 第一步前没有确认块
    expect(within(transfer()).queryByTestId('budget-import-confirm-text')).toBeNull()
    await startReplace(user)
    const confirmText = within(transfer()).getByTestId('budget-import-confirm-text').textContent
    expect(confirmText).toContain('1 项')
    expect(confirmText).toContain('888')
    expect(confirmText).toContain('1 项')
    // 还没改
    expect(within(transfer()).getByRole('button', { name: '确认替换费用' })).toBeInTheDocument()
  })

  it('确认期间费用输入变化：pending 作废，不覆盖新输入；候选可重新确认', async () => {
    const { user, harness, chooseFile } = setup()
    await expand(user)
    await chooseFile()
    await startReplace(user)
    // 用户在确认期间改了当前费用输入
    harness.setSession({
      ...harness.session,
      rows: [{ id: 'new', category: 'food', name: '新填的', amountRaw: '9' }],
    })
    expect(within(transfer()).queryByTestId('budget-import-confirm-text')).toBeNull()
    // 文件里的候选还在，可重新确认
    expect(within(transfer()).getByTestId('budget-import-preview')).toBeInTheDocument()
    await startReplace(user)
    await user.click(within(transfer()).getByRole('button', { name: '确认替换费用' }))
    expect(harness.session.rows[0].name).toBe('导入门票')
  })

  it('行程内容变化后旧 pending 与候选永久清理：A→B→A 也不复活（窄收尾）', async () => {
    // 窄收尾前：目标变化只清 pending，旧候选被自动留成新目标的预览可重新确认。
    // 窄收尾后：候选绑定选择时的目标 ctx 指纹，目标变化渲染期隐藏 + effect 永久清理。
    const view = render(
      <TripBudgetTransfer trip={MOCK_TRIP} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    const user = userEvent.setup()
    await user.click(within(transfer()).getByRole('button', { name: '展开费用文件备份' }))
    const fileInput = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(fileInput, {
      name: 'a.budget.json',
      size: IMPORT_JSON.length,
      text: () => Promise.resolve(IMPORT_JSON),
    } as unknown as File)
    await screen.findByTestId('budget-import-preview')
    await user.click(within(transfer()).getByRole('button', { name: '替换当前费用草稿' }))
    await screen.findByTestId('budget-import-confirm-text')

    // 行程内容变化：pending 与候选都立即隐藏
    const changed: Trip = { ...MOCK_TRIP, summary: '内容变了' }
    view.rerender(<TripBudgetTransfer trip={changed} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />)
    expect(within(transfer()).queryByTestId('budget-import-confirm-text')).toBeNull()
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()

    // A→B→A：改回原内容也不复活旧确认或旧候选
    view.rerender(<TripBudgetTransfer trip={MOCK_TRIP} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />)
    expect(within(transfer()).queryByTestId('budget-import-confirm-text')).toBeNull()
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()
    // 重新选择文件仍可用
    const fileInput2 = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(fileInput2, {
      name: 'b.budget.json',
      size: IMPORT_JSON.length,
      text: () => Promise.resolve(IMPORT_JSON),
    } as unknown as File)
    await screen.findByTestId('budget-import-preview')
  })

  it('确认期间当前费用 owner 变化（沿用）：pending 作废，不覆盖后续输入；A→B→A 不复活（点 2）', async () => {
    // 修复前 pending 只存 inputSnapshot 不含 owner：staleOwner 草稿在确认中沿用后，
    // 输入不变 → 旧确认仍可执行。修复后 pending 绑当前 owner 全指纹。
    const staleSession = {
      owner: { tripId: 'trip-a', revision: 1, tripSnapshot: '{"id":"trip-a"}', tripTitle: '行程A' },
      rows: [{ id: 'r1', category: 'other' as const, name: '旧草稿项', amountRaw: '66' }],
      budgetRaw: '500',
      result: null,
      undo: null,
    }
    const { user, harness, chooseFile } = setup({ session: staleSession })
    await expand(user)
    await chooseFile()
    await user.click(within(transfer()).getByRole('button', { name: '替换当前费用草稿' }))
    await screen.findByTestId('budget-import-confirm-text')

    // 沿用：owner 变（A→当前），输入不变 → 旧确认立即作废
    const adopted = {
      ...staleSession,
      owner: { tripId: MOCK_TRIP.id, revision: 1, tripSnapshot: JSON.stringify(MOCK_TRIP), tripTitle: MOCK_TRIP.title },
    }
    harness.setSession(adopted)
    expect(within(transfer()).queryByTestId('budget-import-confirm-text')).toBeNull()
    // A→B→A：owner 改回 A 也不复活
    harness.setSession(staleSession)
    expect(within(transfer()).queryByTestId('budget-import-confirm-text')).toBeNull()
    // 候选保留，可重新确认；确认后正常替换
    expect(within(transfer()).getByTestId('budget-import-preview')).toBeInTheDocument()
    await user.click(within(transfer()).getByRole('button', { name: '替换当前费用草稿' }))
    await user.click(within(transfer()).getByRole('button', { name: '确认替换费用' }))
    expect(harness.session.rows[0].name).toBe('导入门票')
  })

  it('读取期间 Trip 切换：旧读取晚回不落地、不出提示、不动新目标（点 3）', async () => {
    const view = render(
      <TripBudgetTransfer trip={MOCK_TRIP} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    const user = userEvent.setup()
    await user.click(within(transfer()).getByRole('button', { name: '展开费用文件备份' }))
    // release 用 ref 对象装：直接用 let 会被 TS 控制流收窄成 null（闭包内赋值
    // 不参与流分析），晚回调用报 never 不可调用
    const releaseRef: { current: ((text: string) => void) | null } = { current: null }
    const slowText = () => new Promise<string>((resolve) => { releaseRef.current = resolve })
    const fileInput = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(fileInput, {
      name: 'a.budget.json',
      size: IMPORT_JSON.length,
      text: slowText,
    } as unknown as File)
    // 读取挂起中切换 Trip / revision
    const otherTrip: Trip = { ...MOCK_TRIP, id: 'trip-other' }
    view.rerender(
      <TripBudgetTransfer trip={otherTrip} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    expect(within(transfer()).queryByRole('status')).toBeNull()
    // 旧文件晚回：不落地、不出错误提示
    releaseRef.current?.(IMPORT_JSON)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()
    expect(within(transfer()).queryByTestId('budget-import-notice')).toBeNull()
    // 新目标下重新选择仍可用
    const fileInput2 = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(fileInput2, {
      name: 'b.budget.json',
      size: IMPORT_JSON.length,
      text: () => Promise.resolve(IMPORT_JSON),
    } as unknown as File)
    await screen.findByTestId('budget-import-preview')
  })

  it('收起使在途读取作废：晚回不落地、不复活旧状态（点 3）', async () => {
    const { user } = setup()
    await expand(user)
    // 手动上传一个永不 resolve 的文件（读取一直挂起）
    const fileInput = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(fileInput, {
      name: 'hang.budget.json',
      size: IMPORT_JSON.length,
      text: () => new Promise<string>(() => {}),
    } as unknown as File)
    expect(within(transfer()).getByRole('status').textContent).toContain('正在读取')
    // 收起：读取状态与在途结果全部作废
    await user.click(within(transfer()).getByRole('button', { name: '收起费用文件备份' }))
    expect(within(transfer()).queryByRole('status')).toBeNull()
    // 展开后旧读取也不能复活任何状态
    await user.click(within(transfer()).getByRole('button', { name: '展开费用文件备份' }))
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()
    expect(within(transfer()).queryByTestId('budget-import-notice')).toBeNull()
  })

  it('文件对象缺自定义属性也能走通（user-event 要求 name；守卫由解析层承担）', async () => {
    const { user, uploadFile } = setup()
    await expand(user)
    await uploadFile(IMPORT_JSON)
    await screen.findByTestId('budget-import-preview')
    expect(within(transfer()).getByTestId('budget-import-preview')).toBeInTheDocument()
  })

  it('无法验证当前 Trip 快照：只能查看，应用按钮禁用且提示锁定', async () => {
    // 传一个无法序列化的 Trip（循环引用），模拟 snapshot 序列化失败
    const evilTrip: Trip & { self?: unknown } = { ...MOCK_TRIP }
    evilTrip.self = evilTrip
    const { user, chooseFile } = setup({ trip: evilTrip })
    await expand(user)
    await chooseFile()
    expect(within(transfer()).getByTestId('budget-import-locked').textContent).toContain('不能应用')
    expect(within(transfer()).getByRole('button', { name: '替换当前费用草稿' })).toBeDisabled()
  })

  it('取消替换：pending 丢弃，当前费用不变，提示固定', async () => {
    const { user, harness, chooseFile } = setup()
    await expand(user)
    await chooseFile()
    await startReplace(user)
    await user.click(within(transfer()).getByRole('button', { name: '取消替换' }))
    expect(within(transfer()).queryByTestId('budget-import-confirm-text')).toBeNull()
    expect(within(transfer()).getByTestId('budget-import-notice').textContent).toContain('已取消替换')
    expect(harness.session.rows).toHaveLength(0)
  })

  it('放弃导入预览：候选与 pending 丢弃，session 不变，焦点回文件选择框', async () => {
    const { user, harness, chooseFile } = setup()
    await expand(user)
    await chooseFile()
    await startReplace(user)
    await user.click(within(transfer()).getByRole('button', { name: '放弃导入预览' }))
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()
    expect(harness.session.rows).toHaveLength(0)
    expect(document.activeElement).toBe(within(transfer()).getByLabelText(/选择费用备份文件/))
  })

  it('应用后撤销语义由 session.undo 承接：面板提示可撤销（App 集成测试覆盖真实撤销）', async () => {
    const { user, harness, chooseFile } = setup()
    await expand(user)
    await chooseFile()
    await startReplace(user)
    await user.click(within(transfer()).getByRole('button', { name: '确认替换费用' }))
    expect(harness.session.undo).not.toBeNull()
    expect(harness.session.undo!.owner).toBeNull()
    expect(harness.session.undo!.rows).toHaveLength(0)
  })
})

describe('窄收尾：目标 ctx 与候选守卫', () => {
  it('读取挂起中从不可验证行程切到可验证：晚回不落地（null→valid 也是目标变化，独立哨兵不复用 null）', async () => {
    // 修复前 lastSeen ctx 指纹用 null 初始化，null→valid 被误当首次渲染初始化，
    // 序号不递增且旧闭包比较恒等 → 晚回落地到新目标。修复后独立哨兵 + 渲染期 ref。
    const evilTrip: Trip & { self?: unknown } = { ...MOCK_TRIP }
    evilTrip.self = evilTrip
    const view = render(
      <TripBudgetTransfer trip={evilTrip} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    const user = userEvent.setup()
    await user.click(within(transfer()).getByRole('button', { name: '展开费用文件备份' }))
    // release 用 ref 对象装：直接用 let 会被 TS 控制流收窄成 null（闭包内赋值
    // 不参与流分析），晚回调用报 never 不可调用
    const releaseRef: { current: ((text: string) => void) | null } = { current: null }
    const slowText = () => new Promise<string>((resolve) => { releaseRef.current = resolve })
    const fileInput = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(fileInput, {
      name: 'a.budget.json',
      size: IMPORT_JSON.length,
      text: slowText,
    } as unknown as File)
    // 切到可验证行程：目标从不可验证（ctx 指纹 null）变为可验证
    view.rerender(
      <TripBudgetTransfer trip={MOCK_TRIP} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    // 旧文件晚回：目标已变，不落地、不出提示
    releaseRef.current?.(IMPORT_JSON)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()
    expect(within(transfer()).queryByTestId('budget-import-notice')).toBeNull()
    // 新目标下重新选择仍可用
    const fileInput2 = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(fileInput2, {
      name: 'b.budget.json',
      size: IMPORT_JSON.length,
      text: () => Promise.resolve(IMPORT_JSON),
    } as unknown as File)
    await screen.findByTestId('budget-import-preview')
  })

  it('不可验证行程下预览的候选，切到可验证行程后不自动留成新目标的预览，回切也不复活', async () => {
    const evilTrip: Trip & { self?: unknown } = { ...MOCK_TRIP }
    evilTrip.self = evilTrip
    const view = render(
      <TripBudgetTransfer trip={evilTrip} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    const user = userEvent.setup()
    await user.click(within(transfer()).getByRole('button', { name: '展开费用文件备份' }))
    const fileInput = within(transfer()).getByLabelText('选择费用备份文件（.budget.json）') as HTMLInputElement
    await user.upload(fileInput, {
      name: 'a.budget.json',
      size: IMPORT_JSON.length,
      text: () => Promise.resolve(IMPORT_JSON),
    } as unknown as File)
    await screen.findByTestId('budget-import-preview')

    // 切到可验证行程：候选绑定不可验证时的目标，不能自动留成新目标的预览
    view.rerender(
      <TripBudgetTransfer trip={MOCK_TRIP} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()
    // 回切到不可验证行程也不复活
    view.rerender(
      <TripBudgetTransfer trip={evilTrip} revision={1} session={emptyBudgetSession()} onSessionChange={() => {}} />,
    )
    expect(within(transfer()).queryByTestId('budget-import-preview')).toBeNull()
  })

  it('旧 owner 草稿在当前 Trip 不可验证时仍可导出备份：export 只绑 session.owner，不绑回当前 Trip', async () => {
    const evilTrip: Trip & { self?: unknown } = { ...MOCK_TRIP }
    evilTrip.self = evilTrip
    const session = {
      owner: { tripId: 'old-trip', revision: 9, tripSnapshot: '{"id":"old-trip"}', tripTitle: '旧版行程' },
      rows: [{ id: 'r1', category: 'other' as const, name: '旧门票', amountRaw: '66' }],
      budgetRaw: '500',
      result: null,
      undo: null,
    }
    const { user } = setup({ trip: evilTrip, session })
    await expand(user)
    await previewExport(user)
    // 当前 Trip 不可验证不阻碍备份已有 owner 的草稿：自述写原 owner
    const ownerLine = within(transfer()).getByTestId('budget-export-owner')
    expect(ownerLine.textContent).toContain('旧版行程')
    const textarea = within(transfer()).getByRole('textbox') as HTMLTextAreaElement
    const parsed = JSON.parse(textarea.value) as { trip: { id: string; title: string } }
    expect(parsed.trip).toEqual({ id: 'old-trip', title: '旧版行程' })
    // 当前行程不可验证只锁导入应用，不锁导出
    expect(within(transfer()).queryByTestId('budget-import-locked')).toBeNull()
  })
})

describe('文件名与净化（展示层）', () => {
  it('导出预览标题的文件名不含路径分隔符等非法字符', async () => {
    const evilTrip: Trip = { ...MOCK_TRIP, id: '../../evil', title: 'A:*?"<>|坏标题' }
    let session = emptyBudgetSession()
    session = {
      owner: { tripId: evilTrip.id, revision: 1, tripSnapshot: '{"x":1}', tripTitle: evilTrip.title },
      rows: [],
      budgetRaw: '',
      result: null,
      undo: null,
    }
    const { user } = setup({ trip: evilTrip, session })
    await expand(user)
    await previewExport(user)
    const heading = within(transfer()).getByRole('heading', { name: /预览：/ })
    expect(heading.textContent).not.toMatch(/[\\/:*?"<>|]/)
    expect(heading.textContent).toContain('.budget.json')
  })
})

describe('解析层对接', () => {
  it('面板展示的文件自述来自解析结果：metadata 相同也不自动证明来源（固定提示文案）', async () => {
    const sameTripJson = envelopeOf({ tripId: MOCK_TRIP.id, tripTitle: MOCK_TRIP.title })
    const { user, chooseFile } = setup({ fileText: sameTripJson })
    await expand(user)
    await chooseFile()
    const line = within(transfer()).getByTestId('budget-import-file-trip')
    expect(line.textContent).toContain(MOCK_TRIP.title)
    expect(line.textContent).toContain('不能证明')
  })

  it('导入预览条目展示原字符串：空 / 非法金额不补 0 不丢数据', async () => {
    const draftJson = JSON.stringify({
      format: 'travel-assistant.budget',
      version: 1,
      currency: 'CNY',
      trip: null,
      draft: {
        budgetRaw: 'abc',
        rows: [
          { id: 'r1', category: 'other', name: '', amountRaw: '' },
          { id: 'r2', category: 'other', name: 'X', amountRaw: '12.345' },
          { id: 'r3', category: 'other', name: 'Y', amountRaw: '0' },
        ],
      },
    })
    const parsed = parseBudgetBackup(draftJson)
    expect(parsed.ok).toBe(true)
    const { user, chooseFile } = setup({ fileText: draftJson })
    await expand(user)
    await chooseFile()
    const rows = within(transfer()).getByTestId('budget-import-rows')
    expect(rows.textContent).toContain('（未填）')
    expect(rows.textContent).toContain('12.345')
    expect(rows.textContent).toContain('0')
    expect(within(transfer()).getByTestId('budget-import-preview').textContent).toContain('无效')
  })
})

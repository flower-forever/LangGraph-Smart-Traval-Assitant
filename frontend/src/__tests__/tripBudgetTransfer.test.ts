/**
 * tripBudgetTransfer.ts 纯函数测试：envelope 投影（已知字段 / 原字符串 /
 * 0 / 空 / 非法金额 / 中文多行 / HTML / extra / Unicode / trip 自述投影）、
 * 版本 / 币种 / 结构严格校验（32+33 行、重复 id、字段类型）、UTF-8 256 KiB cap
 * （生成后与解析前）、BOM（最多剥一个）、坏 JSON / 数组 / null、确定性、
 * 不可变、导出文件不含 session 内部字段、metadata 相同不证明来源、
 * summarize 与 applyBudgetImport 的守卫。全部离线，不读网络 / 存储 / 时钟。
 */
import { describe, expect, it } from 'vitest'

import {
  BUDGET_JSON_SHARE_NOTICE,
  BUDGET_RECORD_SOURCE_TEXT,
  BUDGET_TRANSFER_FORMAT,
  BUDGET_TRANSFER_MIME_TYPE,
  BUDGET_TRANSFER_VERSION,
  MAX_BUDGET_TRANSFER_BYTES,
  applyBudgetImport,
  createBudgetBackup,
  formatBudgetTooLargeMessage,
  parseBudgetBackup,
  projectBudgetEnvelope,
  safeBudgetFilename,
  summarizeBudgetDraft,
  type BudgetExportInput,
} from '../lib/tripBudgetTransfer'
import { utf8ByteLength } from '../lib/savedTrips'
import {
  emptyBudgetSession,
  createBudgetForTrip,
  addBudgetRow,
  updateBudgetRow,
  updateBudgetTotal,
  undoBudget,
  type BudgetTripContext,
} from '../lib/tripBudget'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item)
    }
    Object.freeze(value)
  }
  return value
}

function exportInput(overrides: Partial<BudgetExportInput> = {}): BudgetExportInput {
  return {
    tripId: 'trip-1',
    tripTitle: '杭州三日',
    budgetRaw: '5000',
    rows: [
      { id: 'r1', category: 'transport', name: '高铁票', amountRaw: '128.50' },
      { id: 'r2', category: 'food', name: '', amountRaw: '0' },
      { id: 'r3', category: 'other', name: '零食', amountRaw: '' },
    ],
    ...overrides,
  }
}

const CTX_OK: BudgetTripContext = {
  tripId: 'trip-1',
  revision: 1,
  snapshot: '{"id":"trip-1","v":1}',
  tripTitle: '杭州三日',
}
const CTX_NO_SNAP: BudgetTripContext = { ...CTX_OK, snapshot: null }

function sessionBoundTo(ctx: BudgetTripContext) {
  const created = createBudgetForTrip(emptyBudgetSession(), ctx)
  if (!created.ok) throw new Error(created.message)
  return created.session
}

describe('createBudgetBackup：投影与生成', () => {
  it('生成完整 envelope：format / version / currency / trip 自述 / draft 原字符串', () => {
    const result = createBudgetBackup(exportInput())
    if (!result.ok) throw new Error(result.message)
    const parsed = JSON.parse(result.json) as Record<string, unknown>
    expect(parsed.format).toBe('travel-assistant.budget')
    expect(parsed.version).toBe(1)
    expect(parsed.currency).toBe('CNY')
    expect(parsed.trip).toEqual({ id: 'trip-1', title: '杭州三日' })
    const draft = parsed.draft as Record<string, unknown>
    expect(draft.budgetRaw).toBe('5000')
    expect(draft.rows).toEqual([
      { id: 'r1', category: 'transport', name: '高铁票', amountRaw: '128.50' },
      { id: 'r2', category: 'food', name: '', amountRaw: '0' },
      { id: 'r3', category: 'other', name: '零食', amountRaw: '' },
    ])
    expect(result.bytes).toBe(utf8ByteLength(result.json))
    expect(result.notices).toContain(BUDGET_JSON_SHARE_NOTICE)
    expect(result.notices).toContain(BUDGET_RECORD_SOURCE_TEXT)
  })

  it('同一草稿确定性输出：两次生成逐字节相同，不写导出时间', () => {
    const a = createBudgetBackup(exportInput())
    const b = createBudgetBackup(exportInput())
    if (!a.ok || !b.ok) throw new Error('生成失败')
    expect(a.json).toBe(b.json)
    expect(a.json).not.toContain('exportedAt')
    expect(a.json).not.toContain('savedAt')
  })

  it('空 / 0 / 非法金额原样保留：不补 0、不丢数据、不算合法性门槛', () => {
    const result = createBudgetBackup(
      exportInput({
        budgetRaw: '12.345',
        rows: [
          { id: 'r1', category: 'food', name: '', amountRaw: '' },
          { id: 'r2', category: 'food', name: 'X', amountRaw: '0' },
          { id: 'r3', category: 'other', name: 'Y', amountRaw: '12.345' },
          { id: 'r4', category: 'other', name: 'Z', amountRaw: 'abc' },
          { id: 'r5', category: 'other', name: 'W', amountRaw: '-5' },
        ],
      }),
    )
    if (!result.ok) throw new Error(result.message)
    const parsed = JSON.parse(result.json) as { draft: { rows: { amountRaw: string }[]; budgetRaw: string } }
    expect(parsed.draft.budgetRaw).toBe('12.345')
    expect(parsed.draft.rows.map((row) => row.amountRaw)).toEqual(['', '0', '12.345', 'abc', '-5'])
  })

  it('中文多行、HTML 片段与 Unicode 原样进 JSON，不被改写', () => {
    const result = createBudgetBackup(
      exportInput({
        rows: [
          { id: 'r1', category: 'other', name: '第一行\n第二行<img src=x onerror="alert(1)">\u00e9\u4e2d\u6587\ud83d\ude00', amountRaw: '1' },
        ],
      }),
    )
    if (!result.ok) throw new Error(result.message)
    const parsed = JSON.parse(result.json) as { draft: { rows: { name: string }[] } }
    expect(parsed.draft.rows[0].name).toBe('第一行\n第二行<img src=x onerror="alert(1)">\u00e9\u4e2d\u6587\ud83d\ude00')
  })

  it('owner 为 null 时 trip 写 null；trip 字段只投影 id 与 title', () => {
    const result = createBudgetBackup(exportInput({ tripId: null, tripTitle: null }))
    if (!result.ok) throw new Error(result.message)
    const parsed = JSON.parse(result.json) as { trip: unknown }
    expect(parsed.trip).toBeNull()
  })

  it('projectBudgetEnvelope 不接收未知字段：传入多余属性的行只保留四个已知字段', () => {
    const envelope = projectBudgetEnvelope({
      tripId: 'trip-1',
      tripTitle: 'T',
      budgetRaw: '1',
      rows: [{ id: 'r1', category: 'other', name: 'n', amountRaw: '1', tripSnapshot: 'X', extra: true } as never],
    })
    expect(envelope.draft.rows[0]).toEqual({ id: 'r1', category: 'other', name: 'n', amountRaw: '1' })
    expect(Object.keys(envelope.draft.rows[0]).sort()).toEqual(['amountRaw', 'category', 'id', 'name'])
  })

  it('输入违反结构（重复 id、非文本字段、超 32 行）时 typed 拒绝，不产出半份文件', () => {
    expect(createBudgetBackup(exportInput({ rows: [
      { id: 'r1', category: 'other', name: '', amountRaw: '1' },
      { id: 'r1', category: 'other', name: '', amountRaw: '2' },
    ] })).ok).toBe(false)
    expect(createBudgetBackup(exportInput({ rows: [
      { id: 'r1', category: 'nope' as never, name: '', amountRaw: '1' },
    ] })).ok).toBe(false)
    expect(createBudgetBackup(exportInput({ rows: [
      { id: '', category: 'other', name: '', amountRaw: '1' },
    ] })).ok).toBe(false)
    const tooMany = Array.from({ length: 33 }, (_, i) => ({
      id: `r${i}`,
      category: 'other' as const,
      name: '',
      amountRaw: '1',
    }))
    const tooManyResult = createBudgetBackup(exportInput({ rows: tooMany }))
    expect(tooManyResult.ok).toBe(false)
    if (!tooManyResult.ok) expect(tooManyResult.reason).toBe('invalid_input')
  })

  it('生成后 UTF-8 字节超 256 KiB 时 too_large 拒绝', () => {
    const bigName = '长'.repeat(90_000)
    const result = createBudgetBackup(
      exportInput({ rows: [{ id: 'r1', category: 'other', name: bigName, amountRaw: '1' }] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('too_large')
      expect(result.message).toBe(formatBudgetTooLargeMessage(utf8ByteLength(JSON.stringify({
        format: BUDGET_TRANSFER_FORMAT,
        version: BUDGET_TRANSFER_VERSION,
        currency: 'CNY',
        trip: { id: 'trip-1', title: '杭州三日' },
        draft: { budgetRaw: '5000', rows: [{ id: 'r1', category: 'other', name: bigName, amountRaw: '1' }] },
      })), MAX_BUDGET_TRANSFER_BYTES).replace('文件体积', '文件体积'))
    }
  })

  it('deepFreeze 输入不修改：纯函数', () => {
    const input = deepFreeze(exportInput())
    const result = createBudgetBackup(input)
    expect(result.ok).toBe(true)
  })
})

describe('safeBudgetFilename：文件名净化', () => {
  it('来自导出自述 metadata：budget-标题-id.budget.json', () => {
    expect(safeBudgetFilename({ id: 'trip-1', title: '杭州三日' })).toBe('budget-杭州三日-trip-1.budget.json')
  })

  it('清掉路径分隔符、Windows 非法字符与控制字符；保留名加前缀', () => {
    const name = safeBudgetFilename({ id: '../../x', title: 'A:*?"<>|B\u0000C' })
    expect(name.endsWith('.budget.json')).toBe(true)
    expect(name).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/)
    expect(name.startsWith('.')).toBe(false)
    expect(safeBudgetFilename({ id: 'x', title: 'CON' })).toBe('budget-CON-x.budget.json')
  })

  it('null 或全空 metadata 退到 budget.budget.json', () => {
    expect(safeBudgetFilename(null)).toBe('budget.budget.json')
    expect(safeBudgetFilename({ id: '', title: '' })).toBe('budget.budget.json')
  })
})

describe('parseBudgetBackup：解析与严格校验', () => {
  function goodEnvelope(): Record<string, unknown> {
    return {
      format: 'travel-assistant.budget',
      version: 1,
      currency: 'CNY',
      trip: { id: 'trip-1', title: '杭州三日' },
      draft: {
        budgetRaw: '5000',
        rows: [{ id: 'r1', category: 'transport', name: '高铁票', amountRaw: '128.50' }],
      },
    }
  }

  it('合法 envelope 解析通过：draft / trip / bytes / notices', () => {
    const result = parseBudgetBackup(JSON.stringify(goodEnvelope()))
    if (!result.ok) throw new Error(result.message)
    expect(result.draft.rows).toHaveLength(1)
    expect(result.trip).toEqual({ id: 'trip-1', title: '杭州三日' })
    expect(result.bytes).toBe(utf8ByteLength(JSON.stringify(goodEnvelope())))
    expect(result.notices).toContain(BUDGET_RECORD_SOURCE_TEXT)
  })

  it('trip 为 null 合法；trip 缺 title 或非对象拒绝', () => {
    const ok = parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), trip: null }))
    expect(ok.ok).toBe(true)
    for (const trip of [{ id: 'x' }, { title: 'y' }, 'str', 42, []]) {
      expect(parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), trip })).ok).toBe(false)
    }
  })

  it('坏 JSON / 空白 / 数组 / null / 非对象都固定 parse_error 或 format_mismatch，不回显内容', () => {
    for (const text of ['not json', '', '   ', '[]', 'null', '42', '"str"']) {
      const result = parseBudgetBackup(text)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(['parse_error', 'format_mismatch']).toContain(result.reason)
        expect(result.message).not.toContain('not json')
      }
    }
  })

  it('format 不匹配 / version 缺失或字符串 / currency 非 CNY 都固定拒绝', () => {
    const wrongFormat = parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), format: 'travel-assistant.trip' }))
    expect(wrongFormat.ok).toBe(false)
    if (!wrongFormat.ok) expect(wrongFormat.reason).toBe('format_mismatch')
    const versionString = parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), version: '1' }))
    expect(versionString.ok).toBe(false)
    if (!versionString.ok) expect(versionString.reason).toBe('version_mismatch')
    const versionTwo = parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), version: 2 }))
    expect(versionTwo.ok).toBe(false)
    if (!versionTwo.ok) expect(versionTwo.reason).toBe('version_mismatch')
    const usd = parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), currency: 'USD' }))
    expect(usd.ok).toBe(false)
    if (!usd.ok) {
      expect(usd.reason).toBe('currency_mismatch')
      expect(usd.message).not.toContain('USD')
    }
  })

  it('结构校验：draft 缺失 / rows 非数组 / 字段类型不对 / 重复 id / 33 行拒绝', () => {
    expect(parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), draft: null })).ok).toBe(false)
    expect(parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), draft: { budgetRaw: 1, rows: [] } })).ok).toBe(false)
    expect(parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), draft: { budgetRaw: '', rows: {} } })).ok).toBe(false)
    const badCategory = goodEnvelope() as { draft: { rows: unknown[] } }
    badCategory.draft.rows = [{ id: 'r1', category: 'nope', name: '', amountRaw: '1' }]
    expect(parseBudgetBackup(JSON.stringify(badCategory)).ok).toBe(false)
    const badId = goodEnvelope() as { draft: { rows: unknown[] } }
    badId.draft.rows = [{ id: '', category: 'other', name: '', amountRaw: '1' }]
    expect(parseBudgetBackup(JSON.stringify(badId)).ok).toBe(false)
    const dup = goodEnvelope() as { draft: { rows: unknown[] } }
    dup.draft.rows = [
      { id: 'r1', category: 'other', name: '', amountRaw: '1' },
      { id: 'r1', category: 'other', name: '', amountRaw: '2' },
    ]
    const dupResult = parseBudgetBackup(JSON.stringify(dup))
    expect(dupResult.ok).toBe(false)
    if (!dupResult.ok) expect(dupResult.message).not.toContain('r1')
    const rows33 = Array.from({ length: 33 }, (_, i) => ({
      id: `r${i}`,
      category: 'other',
      name: '',
      amountRaw: '1',
    }))
    expect(parseBudgetBackup(JSON.stringify({ ...goodEnvelope(), draft: { budgetRaw: '', rows: rows33 } })).ok).toBe(false)
  })

  it('行上的未知字段不进输出：投影后只剩四个已知字段', () => {
    const extra = goodEnvelope() as { draft: { rows: Record<string, unknown>[] } }
    extra.draft.rows = [{ id: 'r1', category: 'other', name: '', amountRaw: '1', session: { owner: 'x' }, evil: '<script>' }]
    const result = parseBudgetBackup(JSON.stringify(extra))
    if (!result.ok) throw new Error(result.message)
    expect(Object.keys(result.draft.rows[0]).sort()).toEqual(['amountRaw', 'category', 'id', 'name'])
    expect(JSON.stringify(result)).not.toContain('<script>')
    expect(JSON.stringify(result)).not.toContain('owner')
  })

  it('空白 id（trim 后为空）拒绝：与 computeBudgetSummary 的结构约束对齐，不伪 known0/budget empty', () => {
    // 复现点5：修复前 id=' ' 通过导出 / 解析 / apply，但摘要伪成 known0/issues0/budget empty，
    // 且 applyBudgetImport 不校验直接放行 → 导入一份 UI 不能修 id 的坏结构
    const blankId = goodEnvelope() as { draft: { rows: unknown[] } }
    blankId.draft.rows = [{ id: '  ', category: 'other', name: '空白id行', amountRaw: '100' }]
    const blankResult = parseBudgetBackup(JSON.stringify(blankId))
    expect(blankResult.ok).toBe(false)
    if (!blankResult.ok) expect(blankResult.reason).toBe('invalid_structure')
    expect(createBudgetBackup(exportInput({ rows: [{ id: ' ', category: 'other', name: 'x', amountRaw: '1' }] })).ok).toBe(false)
    const appliedBlank = applyBudgetImport(sessionBoundTo(CTX_OK), CTX_OK, {
      budgetRaw: '5000',
      rows: [{ id: ' ', category: 'other', name: '空白id行', amountRaw: '100' }],
    })
    expect(appliedBlank.ok).toBe(false)
    if (!appliedBlank.ok) expect(appliedBlank.reason).toBe('invalid_draft')
  })

  it('maxBytes 配置只能收紧或合法：NaN / Infinity / 超固定cap / 非整数是独立 invalid_options', () => {
    // 复现点6：修复前 NaN / Infinity / 10^12 绕过 256KiB cap；-1 / 0 伪装成 too_large
    const bigText = JSON.stringify(goodEnvelope()).replace('高铁票', '长'.repeat(90_000))
    expect(utf8ByteLength(bigText)).toBeGreaterThan(MAX_BUDGET_TRANSFER_BYTES)
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 10 ** 12]) {
      const r = parseBudgetBackup(bigText, { maxBytes })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('invalid_options')
    }
    // 合法文件 + 非法配置：同样是配置错误，不冒充用户文件非法
    for (const maxBytes of [Number.NaN, 0, -1, 1.5, 256 * 1024 + 1]) {
      const r = parseBudgetBackup(JSON.stringify(goodEnvelope()), { maxBytes })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('invalid_options')
    }
    // 收紧到恰好够用：合法
    expect(parseBudgetBackup(JSON.stringify(goodEnvelope()), { maxBytes: utf8ByteLength(JSON.stringify(goodEnvelope())) }).ok).toBe(true)
  })

  it('BOM 最多剥一个：单 BOM 通过，双 BOM 算坏 JSON', () => {
    const ok = parseBudgetBackup('\uFEFF' + JSON.stringify(goodEnvelope()))
    expect(ok.ok).toBe(true)
    const bad = parseBudgetBackup('\uFEFF\uFEFF' + JSON.stringify(goodEnvelope()))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('parse_error')
  })

  it('解析前 UTF-8 字节门禁：超 256 KiB 的文本 too_large，且不进入 JSON.parse', () => {
    const bigText = JSON.stringify(goodEnvelope()).replace('高铁票', '长'.repeat(90_000))
    expect(utf8ByteLength(bigText)).toBeGreaterThan(MAX_BUDGET_TRANSFER_BYTES)
    const result = parseBudgetBackup(bigText)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('too_large')
  })

  it('非法金额的草稿照样解析通过：可计算性与备份合法性解耦', () => {
    const draftEnvelope = goodEnvelope() as { draft: Record<string, unknown> }
    draftEnvelope.draft = {
      budgetRaw: '',
      rows: [
        { id: 'r1', category: 'other', name: '', amountRaw: '' },
        { id: 'r2', category: 'other', name: 'x', amountRaw: 'abc' },
        { id: 'r3', category: 'other', name: 'y', amountRaw: '0' },
      ],
    }
    const result = parseBudgetBackup(JSON.stringify(draftEnvelope))
    expect(result.ok).toBe(true)
  })
})

describe('summarizeBudgetDraft：摘要沿用旧规则', () => {
  it('统计已知 / 未填 / 无效项与合计，无效不当 0', () => {
    const summary = summarizeBudgetDraft({
      budgetRaw: '5000',
      rows: [
        { id: 'r1', category: 'food', name: '', amountRaw: '0' },
        { id: 'r2', category: 'other', name: 'X', amountRaw: '' },
        { id: 'r3', category: 'other', name: 'Y', amountRaw: 'abc' },
        { id: 'r4', category: 'other', name: 'Z', amountRaw: '12.50' },
      ],
    })
    if (!summary.ok) throw new Error(summary.message)
    expect(summary.rowCount).toBe(4)
    expect(summary.knownCount).toBe(2)
    expect(summary.emptyCount).toBe(1)
    expect(summary.issueCount).toBe(1)
    expect(summary.knownTotalText).toBe('12.50')
    expect(summary.hasAnyIssue).toBe(true)
    expect(summary.issueLines[0].message).not.toBe('')
  })

  it('0 合法计入合计；预算留空 budgetKind=empty', () => {
    const summary = summarizeBudgetDraft({
      budgetRaw: '',
      rows: [{ id: 'r1', category: 'other', name: '', amountRaw: '0' }],
    })
    if (!summary.ok) throw new Error(summary.message)
    expect(summary.knownCount).toBe(1)
    expect(summary.knownTotalText).toBe('0.00')
    expect(summary.budgetKind).toBe('empty')
  })

  it('空白 id 的草稿返回 ok=false 的 typed 失败：不冒充 known0/issues0/budget empty', () => {
    // 复现点5：id=' ' 会让 computeBudgetSummary 拒绝整个草稿；
    // 修复后 summarize 也 typed 失败而不是伪空摘要
    const summary = summarizeBudgetDraft({
      budgetRaw: '5000',
      rows: [{ id: ' ', category: 'other', name: '空白id行', amountRaw: '100' }],
    })
    expect(summary.ok).toBe(false)
    if (!summary.ok) {
      expect(summary.rowCount).toBe(1)
      expect(summary.message).toContain('结构不完整')
    }
  })
})

describe('applyBudgetImport：应用守卫与撤销', () => {
  const draft = {
    budgetRaw: '300',
    rows: [
      { id: 'i1', category: 'ticket' as const, name: '门票', amountRaw: '80' },
      { id: 'i2', category: 'food' as const, name: '', amountRaw: '' },
    ],
  }

  it('应用后：新 owner、导入 rows/budgetRaw、result null、一层 undo 保存应用前内容', () => {
    const session = sessionBoundTo(CTX_OK)
    const withRow = addBudgetRow(session, CTX_OK, 'old-1')
    if (!withRow.ok) throw new Error(withRow.message)
    const result = applyBudgetImport(withRow.session, CTX_OK, draft)
    if (!result.ok) throw new Error(result.message)
    expect(result.session.owner).toEqual({
      tripId: 'trip-1',
      revision: 1,
      tripSnapshot: CTX_OK.snapshot,
      tripTitle: '杭州三日',
    })
    expect(result.session.rows).toEqual(draft.rows)
    expect(result.session.budgetRaw).toBe('300')
    expect(result.session.result).toBeNull()
    // undo 保存应用前的一层（owner + rows + budgetRaw），不递归
    expect(result.session.undo).not.toBeNull()
    expect(result.session.undo!.rows).toEqual(withRow.session.rows)
    expect(result.session.undo!.budgetRaw).toBe(withRow.session.budgetRaw)
    expect(result.session.undo!.owner).toEqual(withRow.session.owner)
    // 撤销能恢复替换前的费用
    const undone = undoBudget(result.session, CTX_OK)
    expect(undone.ok).toBe(true)
    if (undone.ok) {
      expect(undone.session.rows).toEqual(withRow.session.rows)
      expect(undone.session.owner).toEqual(withRow.session.owner)
    }
  })

  it('ctx.snapshot 为 null（无法验证当前 Trip）时 fail closed 拒绝', () => {
    const session = sessionBoundTo(CTX_OK)
    const result = applyBudgetImport(session, CTX_NO_SNAP, draft)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unverifiable_owner')
  })

  it('异常候选（空白 id）apply 固定失败：session 保持不变', () => {
    const session = sessionBoundTo(CTX_OK)
    const result = applyBudgetImport(session, CTX_OK, {
      budgetRaw: '1',
      rows: [{ id: '\t', category: 'other', name: 'x', amountRaw: '1' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_draft')
    expect(session.rows).toEqual([])
  })

  it('owner 失配（行程已变化）时按 lib 契约建立新 owner：守卫在组件确认层，lib 只负责应用', () => {
    const session = sessionBoundTo(CTX_OK)
    const ctxB: BudgetTripContext = { ...CTX_OK, revision: 2, snapshot: '{"id":"trip-1","v":2}' }
    const result = applyBudgetImport(session, ctxB, draft)
    // lib 层沿 createBudgetForTrip 语义：显式应用即绑定当前 ctx；
    // 「行程变化后旧确认作废、不能自动套到新 Trip」由组件的 pending 守卫承担。
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.session.owner).toEqual({
        tripId: 'trip-1',
        revision: 2,
        tripSnapshot: '{"id":"trip-1","v":2}',
        tripTitle: '杭州三日',
      })
    }
    // 原 session 对象不变（纯函数）
    expect(session.rows).toEqual([])
  })

  it('deepFreeze 输入不修改：纯函数', () => {
    const session = deepFreeze(sessionBoundTo(CTX_OK))
    const result = applyBudgetImport(session, CTX_OK, deepFreeze(draft))
    expect(result.ok).toBe(true)
  })
})

describe('常量与来源口径', () => {
  it('常量值与互不通用性', () => {
    expect(BUDGET_TRANSFER_FORMAT).toBe('travel-assistant.budget')
    expect(BUDGET_TRANSFER_VERSION).toBe(1)
    expect(BUDGET_TRANSFER_MIME_TYPE).toBe('application/json;charset=utf-8')
    expect(MAX_BUDGET_TRANSFER_BYTES).toBe(256 * 1024)
    expect(BUDGET_RECORD_SOURCE_TEXT).toContain('输入或此前确认导入')
    expect(BUDGET_RECORD_SOURCE_TEXT).not.toContain('都是你自己填的')
  })

  it('trip id 相同也不证明来源：metadata 相同的两个草稿互不自动匹配', () => {
    // 这里的「证明」是产品语义：导出/导入只写自述，解析与应用从不按 metadata 匹配 owner。
    // 用类型层断言：trip 字段类型只有 id/title，没有任何「来源证明」字段。
    const result = createBudgetBackup(exportInput({ tripId: 'trip-1', tripTitle: '杭州三日' }))
    if (!result.ok) throw new Error(result.message)
    const parsed = JSON.parse(result.json) as { trip: Record<string, unknown> }
    expect(Object.keys(parsed.trip).sort()).toEqual(['id', 'title'])
  })
})

describe('session 投影不泄漏内部字段', () => {
  it('从真实 session 导出：owner.tripSnapshot / revision / undo / result 不出现在 JSON', () => {
    let session = sessionBoundTo(CTX_OK)
    const added = addBudgetRow(session, CTX_OK, 'r1')
    if (!added.ok) throw new Error(added.message)
    session = added.session
    const updated = updateBudgetRow(session, CTX_OK, 'r1', { name: '门票<img>', amountRaw: '' })
    if (!updated.ok) throw new Error(updated.message)
    session = updated.session
    const total = updateBudgetTotal(session, CTX_OK, 'abc')
    if (!total.ok) throw new Error(total.message)
    session = total.session

    const result = createBudgetBackup({
      tripId: session.owner!.tripId,
      tripTitle: session.owner!.tripTitle,
      budgetRaw: session.budgetRaw,
      rows: session.rows,
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.json).not.toContain('tripSnapshot')
    expect(result.json).not.toContain('revision')
    expect(result.json).not.toContain('"undo"')
    expect(result.json).not.toContain('"result"')
    expect(result.json).not.toContain(CTX_OK.snapshot)
    // 原字符串（无效金额、空金额）都保留
    const parsed = JSON.parse(result.json) as { draft: { rows: { amountRaw: string }[]; budgetRaw: string } }
    expect(parsed.draft.budgetRaw).toBe('abc')
    expect(parsed.draft.rows[0].amountRaw).toBe('')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trip } from '../lib/api'
import { createWorkspaceRecord } from '../lib/workspace'
import type {
  BudgetSnapshotV1,
  ChecklistItemV1,
  ConstraintItemV1,
  WorkspaceRecordV1,
  WorkspaceSidecarV1,
} from '../lib/workspaceTypes'
import {
  CANDIDATES_STORAGE_KEY,
  VERSIONS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
} from '../lib/workspaceTypes'
import { SESSION_RESUME_DATA_KEY } from '../lib/sessionRestore'
import { MAX_OFFLINE_TRIP_HTML_BYTES, tripToOfflineHtml } from '../lib/offlineTripHtml'
import { utf8ByteLength } from '../lib/savedTrips'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_760_000_000_000
const EXPORTED_AT = Date.UTC(2026, 10, 5, 16, 3, 12)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function makeTrip(): Trip {
  const trip = clone(MOCK_TRIP)
  trip.title = '杭州三日漫步路书'
  // 合法 0 与未知并存：停留 0 分钟、时间 00:00、空时间串、缺坐标。
  trip.days[0].stops[0].duration_minutes = 0
  trip.days[0].stops[1].time = '00:00'
  trip.days[0].stops[2].time = ''
  trip.days[0].stops[2].duration_minutes = null
  // 路段：一段未知，一段合法 0。
  trip.days[0].legs[0] = {
    ...trip.days[0].legs[0],
    distance_m: null,
    duration_minutes: null,
  }
  trip.days[0].legs[1] = {
    ...trip.days[0].legs[1],
    distance_m: 0,
    duration_minutes: 0,
  }
  return trip
}

function makeConstraint(overrides: Partial<ConstraintItemV1> = {}): ConstraintItemV1 {
  return {
    id: 'constraint-1',
    kind: 'fixed_window',
    title: '博物馆预约窗口',
    day: 1,
    stopId: 's1',
    startDate: '2026-04-03',
    endDate: '2026-04-03',
    startTime: '14:00',
    endTime: '16:00',
    durationMinutes: 120,
    notes: '按记录填写，尚未与馆方核对',
    priority: 2,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeChecklistItem(overrides: Partial<ChecklistItemV1> = {}): ChecklistItemV1 {
  return {
    id: 'check-1',
    category: 'ticket',
    title: '打印车票',
    done: true,
    date: '2026-04-03',
    day: 1,
    stopId: 's1',
    originalStopId: null,
    notes: '已勾选，不代表出票',
    updatedAt: NOW,
    ...overrides,
  }
}

function makeSidecar(): WorkspaceSidecarV1 {
  return {
    anchors: {
      accommodation: {
        hotelId: 'hotel-1',
        name: '西湖边客栈',
        address: '杭州市西湖区北山街 1 号',
        location: null,
        locationSource: null,
        checkInDate: '2026-04-03',
        checkOutDate: '2026-04-05',
      },
      daily: {
        '1': {
          start: {
            anchorId: 'anchor-start-1',
            kind: 'manual',
            stopId: null,
            hotelId: 'hotel-1',
            name: '客栈出发',
            address: '北山街 1 号',
            location: null,
            time: '08:30',
            date: '2026-04-03',
          },
          end: {
            anchorId: 'anchor-end-1',
            kind: 'stop',
            stopId: 's3',
            hotelId: 'hotel-1',
            name: '湖滨收尾',
            address: null,
            location: { lng: 0, lat: 0 },
            time: null,
            date: '2026-04-03',
          },
        },
      },
      arrival: {
        kind: 'airport',
        name: '萧山机场',
        date: '2026-04-03',
        time: '15:40',
        location: null,
      },
      departure: null,
    },
    constraints: {
      items: [
        makeConstraint(),
        makeConstraint({
          id: 'constraint-2',
          kind: 'must_visit',
          title: '必去平湖秋月',
          stopId: 's2',
          startDate: null,
          endDate: null,
          startTime: null,
          endTime: null,
          durationMinutes: null,
          notes: null,
          priority: 3,
        }),
        makeConstraint({
          id: 'constraint-3',
          kind: 'reminder',
          title: '带伞提醒',
          day: 2,
          stopId: null,
          startDate: null,
          endDate: null,
          startTime: null,
          endTime: null,
          durationMinutes: null,
          notes: '只是提醒',
          priority: 1,
        }),
        makeConstraint({
          id: 'constraint-4',
          title: '未绑定天数的预约',
          day: 99,
          stopId: 'missing-stop',
          startDate: '2026-04-10',
          endDate: null,
          startTime: '09:00',
          endTime: null,
          durationMinutes: null,
          notes: null,
          priority: 1,
        }),
      ],
    },
    checklist: {
      items: [
        makeChecklistItem(),
        makeChecklistItem({
          id: 'check-2',
          category: 'document',
          title: '带身份证',
          done: false,
          date: null,
          day: null,
          stopId: null,
          notes: null,
        }),
        makeChecklistItem({
          id: 'check-3',
          category: 'appointment',
          title: '核对博物馆时间',
          done: false,
          date: '2026-04-03',
          day: 1,
          stopId: 's2',
          notes: '出发前再看一次',
        }),
        makeChecklistItem({
          id: 'check-4',
          category: 'todo',
          title: '旧站点遗留',
          done: false,
          date: null,
          day: null,
          stopId: null,
          originalStopId: 's-old',
          notes: '原站点已删除',
        }),
      ],
      appliedTemplates: ['tpl-ticket', 'tpl-doc'],
    },
    applies: [{ candidateId: 'cand-1', tripId: MOCK_TRIP.id, day: 1, stopId: 's1' }],
  }
}

function makeBudget(): BudgetSnapshotV1 {
  return {
    budgetRaw: '1000',
    rows: [
      { id: 'b1', category: 'transport', name: '机场巴士', amountRaw: '0' },
      { id: 'b2', category: 'food', name: '午餐', amountRaw: '' },
      { id: 'b3', category: 'ticket', name: '门票', amountRaw: 'abc' },
      { id: 'b4', category: 'stay', name: '住宿', amountRaw: '0.10' },
      { id: 'b5', category: 'other', name: '其他', amountRaw: '0.20' },
    ],
  }
}

interface RecordOverrides {
  trip?: Trip
  sidecar?: WorkspaceSidecarV1
  budget?: BudgetSnapshotV1 | null
  label?: string | null
  workspaceRevision?: number
  ownerId?: string
}

function buildRecord(overrides: RecordOverrides = {}): WorkspaceRecordV1 {
  const result = createWorkspaceRecord({
    workspaceId: 'workspace-1',
    ownerId: overrides.ownerId ?? 'owner-1',
    trip: overrides.trip ?? makeTrip(),
    workspaceRevision: overrides.workspaceRevision ?? 7,
    now: NOW,
    sidecar: overrides.sidecar ?? makeSidecar(),
    budget: overrides.budget === undefined ? makeBudget() : overrides.budget,
    label: overrides.label === undefined ? '杭州夜行' : overrides.label,
  })
  if (!result.ok) throw new Error(`${result.path}: ${result.message}`)
  return result.value
}

function generate(record: WorkspaceRecordV1) {
  const result = tripToOfflineHtml(record, { exportedAt: EXPORTED_AT })
  if (!result.ok) throw new Error(result.message)
  return result
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function expectNoExecutableElements(doc: Document): void {
  expect(doc.querySelectorAll('script, img, svg, iframe, object, embed, link, base, form').length).toBe(0)
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.name.toLowerCase().startsWith('on')).toBe(false)
      expect(attribute.value.toLowerCase()).not.toContain('javascript:')
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tripToOfflineHtml：内容投影', () => {
  it('生成完整单文件页：每日顺序、时间地址、锚点、预约、交通、费用、清单、导出时间与数据来源', () => {
    const record = buildRecord()
    const result = generate(record)
    const doc = parseHtml(result.html)
    const body = doc.body.textContent ?? ''

    expect(result.filename).toMatch(/\.html$/)
    expect(result.bytes).toBe(utf8ByteLength(result.html))
    expect(result.exportedAt).toBe(EXPORTED_AT)
    expect(result.exportedAtIso).toBe(new Date(EXPORTED_AT).toISOString())
    expect(result.exportedAtText).toContain(result.exportedAtIso)
    expect(result.html).toContain(new Date(EXPORTED_AT).toISOString())
    expect(doc.title).toContain('杭州三日漫步路书')

    expect(body).toContain('导出页生成时间')
    expect(body).toContain('当前工作区记录')
    expect(body).toContain(record.workspaceId)
    expect(body).toContain(record.tripId)
    expect(body).toContain('工作区 revision')
    expect(body).toContain('revision 7')
    expect(body).toContain('示例行程（记录自述 source=example）')
    expect(body).toContain('这一份已应用行程')

    const days = Array.from(doc.querySelectorAll('[data-day]')).map((element) => element.getAttribute('data-day'))
    expect(days).toEqual(['1', '2', '3'])
    const day1 = doc.querySelector('[data-day="1"]')
    expect(day1).not.toBeNull()
    const dayText = day1?.textContent ?? ''
    const stopListText = day1?.querySelector('.stops')?.textContent ?? ''
    expect(stopListText.indexOf('断桥残雪')).toBeLessThan(stopListText.indexOf('平湖秋月'))
    expect(stopListText.indexOf('平湖秋月')).toBeLessThan(stopListText.indexOf('湖滨晴雨'))
    expect(dayText).toContain('杭州市西湖区白堤东端')
    expect(dayText).toContain('08:30')
    expect(dayText).toContain('00:00')
    expect(dayText).toContain('时间未填写')

    expect(body).toContain('西湖边客栈')
    expect(body).toContain('2026-04-03')
    expect(body).toContain('2026-04-05')
    expect(body).toContain('萧山机场')
    expect(body).toContain('15:40')
    expect(body).toContain('客栈出发')
    expect(body).toContain('湖滨收尾')

    expect(body).toContain('预约窗口')
    expect(body).toContain('博物馆预约窗口')
    expect(body).toContain('14:00')
    expect(body).toContain('16:00')
    expect(body).toContain('必去要求')
    expect(body).toContain('必去平湖秋月')
    expect(body).toContain('提醒')
    expect(body).toContain('带伞提醒')
    expect(body).toContain('未绑定到具体天数的约束')
    expect(body).toContain('未绑定天数的预约')
    expect(body).toContain('第 99 天')
    expect(body).toContain('当前行程中没有第 99 天')

    expect(body).toContain('导航路线')
    expect(body).toContain('示意直线')
    expect(body).toContain('记录耗时：未知（不是 0 分钟）')
    expect(body).toContain('0 分钟')
    expect(body).toContain('记录距离：未知（不是 0 米）')
    expect(body).toContain('0 米')

    expect(body).toContain('0.00 元')
    expect(body).toContain('未填写（未知，不按 0 元计）')
    expect(body).toContain('无法解析（未知，不按 0 元计）')
    expect(body).toContain('0.30 元')
    expect(body).toContain('只统计已填写的合法金额')

    expect(body).toContain('已准备')
    expect(body).toContain('未准备')
    expect(body).toContain('打印车票')
    expect(body).toContain('需重新关联（原站点 ID：s-old）')
    expect(body).toContain('不代表下单成功、出票或商家受理')
    expect(body).toContain('示例数据仅用于演示界面')

    expect(result.html).toContain('@media print')
    expect(result.html).toContain('@page')
    expect(result.html).toContain('Content-Security-Policy')

    // 不宣称已预订 / 已确认 / 已出票，也不声称导出时做过实时核实。
    for (const forbidden of ['已预订', '已确认', '已出票', '已核实', '实时']) {
      expect(body).not.toContain(forbidden)
    }
  })

  it('budget=null 明确显示「没有预算数据」，不伪造 0 元合计', () => {
    const result = generate(buildRecord({ budget: null }))
    const body = parseHtml(result.html).body.textContent ?? ''
    expect(body).toContain('明确没有预算数据（不等于 0 元）')
    expect(body).not.toContain('已知合计：0.00 元')
    expect(body).not.toContain('总预算：0.00 元')
  })

  it('坐标 null 显示未知，合法 0 坐标按 0 显示；缺坐标不补 (0,0)', () => {
    const result = generate(buildRecord())
    const body = parseHtml(result.html).body.textContent ?? ''
    expect(body).toContain('坐标未知（记录没有填写；不补 0）')
    expect(body).toContain('经度 0，纬度 0（记录值，未核实）')
  })

  it('没有清单条目 / 没有路段时给明确空态，不编造内容', () => {
    const sidecar = makeSidecar()
    sidecar.checklist = { items: [], appliedTemplates: [] }
    const trip = makeTrip()
    trip.days[0].legs = []
    const result = generate(buildRecord({ trip, sidecar }))
    const body = parseHtml(result.html).body.textContent ?? ''
    expect(body).toContain('清单里还没有条目。')
    expect(body).toContain('记录里没有路段摘要。')
    expect(body).toContain('已采纳模板：无')
  })
})

describe('tripToOfflineHtml：清单预约关联（constraintId）', () => {
  function checklistSectionText(doc: Document): string {
    return doc.querySelector('#checklist-title')?.closest('section')?.textContent ?? ''
  }

  it('constraintId 指向已删除预约：保留任务与完成状态，明确提示需重新关联', () => {
    const sidecar = makeSidecar()
    sidecar.constraints = { items: [] }
    sidecar.checklist.items = [
      makeChecklistItem({
        id: 'check-orphan',
        category: 'appointment',
        title: '核对博物馆预约',
        done: true,
        constraintId: 'constraint-1',
      }),
    ]

    const result = generate(buildRecord({ sidecar }))
    const doc = parseHtml(result.html)
    const text = checklistSectionText(doc)

    expect(text).toContain('核对博物馆预约')
    expect(text).toContain('已准备')
    expect(text).toContain('需重新关联')
    expect(text).toContain('关联预约已不在当前行程')
    expect(text).toContain('constraint-1')
    expect(doc.querySelectorAll('.check-item')).toHaveLength(1)
    expect(doc.querySelector('.check-item')?.getAttribute('data-done')).toBe('true')
  })

  it('有效 constraintId 按 ID 显示关联预约，不宣称已核实', () => {
    const sidecar = makeSidecar()
    sidecar.checklist.items = [
      makeChecklistItem({
        id: 'check-linked',
        category: 'appointment',
        title: '核对博物馆预约',
        done: false,
        constraintId: 'constraint-1',
      }),
    ]

    const result = generate(buildRecord({ sidecar }))
    const text = checklistSectionText(parseHtml(result.html))

    expect(text).toContain('关联预约：博物馆预约窗口')
    expect(text).toContain('constraint-1')
    expect(text).not.toContain('需重新关联')
    expect(text).not.toContain('已核实')
  })

  it('旧版缺省 constraintId 与显式 null 都是普通条目，不被同名 / 同日期 / 同站点预约认领', () => {
    const sidecar = makeSidecar()
    sidecar.checklist.items = [
      makeChecklistItem({
        id: 'check-legacy',
        category: 'luggage',
        title: '旧版行李',
        notes: null,
      }),
      makeChecklistItem({
        id: 'check-null',
        category: 'luggage',
        title: '明确解除的行李',
        notes: null,
        constraintId: null,
      }),
    ]

    const result = generate(buildRecord({ sidecar }))
    const text = checklistSectionText(parseHtml(result.html))

    expect(text).toContain('旧版行李')
    expect(text).toContain('明确解除的行李')
    expect(text).not.toContain('关联预约：')
    expect(text).not.toContain('需重新关联')
    expect(text).not.toContain('博物馆预约窗口')
  })
})

describe('tripToOfflineHtml：转义与离线安全', () => {
  it('标题 / 名称 / 地址 / 备注 / 清单 / 来源中的 HTML 与脚本注入被当作纯文本', () => {
    const trip = makeTrip()
    trip.title = '杭州 <script>alert(1)</script> "quoted" & \'single\''
    trip.days[0].title = '<img src=x onerror=alert(3)>'
    trip.days[0].stops[0].name = '</script><img src=x onerror=alert(1)>断桥'
    trip.days[0].stops[0].address = '"><svg onload=alert(2)>'
    trip.days[0].stops[0].description = 'javascript:alert(1) data:text/html,<script>alert(2)</script>'
    trip.warnings = ['</script><img src=x onerror=alert(4)>']

    const sidecar = makeSidecar()
    if (sidecar.anchors.accommodation !== null) {
      sidecar.anchors.accommodation.name = '<script>alert(5)</script> 客栈'
      sidecar.anchors.accommodation.address = '"><img src=x onerror=alert(6)>'
    }
    const start = sidecar.anchors.daily['1']?.start
    if (start !== null && start !== undefined) {
      start.name = '</script><svg onload=alert(7)>'
      start.address = 'javascript:alert(8)'
    }
    sidecar.constraints.items[0].title = '</script><img src=x onerror=alert(9)>预约'
    sidecar.constraints.items[0].notes = '"><iframe src=javascript:alert(10)>'
    sidecar.checklist.items[0].title = '</script><img src=x onerror=alert(11)>车票'
    sidecar.checklist.items[0].notes = 'javascript:alert(12)'
    sidecar.checklist.items[0].constraintId = sidecar.constraints.items[0].id
    sidecar.checklist.appliedTemplates = ['</script><img src=x onerror=alert(13)>']

    const result = generate(buildRecord({ trip, sidecar }))
    expect(result.html.toLowerCase()).not.toContain('<script')
    expect(result.html).not.toContain('<img')
    expect(result.html).not.toContain('<svg')
    expect(result.html).toContain('&lt;/script&gt;')
    expect(result.html).toContain('&quot;')

    const doc = parseHtml(result.html)
    expectNoExecutableElements(doc)
    expect(doc.querySelectorAll('[src],[href],[srcset],[poster],[data],[action],[formaction]').length).toBe(0)

    const body = doc.body.textContent ?? ''
    expect(body).toContain('</script><img src=x onerror=alert(1)>断桥')
    expect(body).toContain('"><svg onload=alert(2)>')
    expect(body).toContain('javascript:alert(1)')
    expect(body).toContain('</script><img src=x onerror=alert(9)>预约')
    expect(body).toContain('</script><img src=x onerror=alert(11)>车票')
  })

  it('离线文档没有外链资源、脚本、@import、url() 或 javascript/data 链接', () => {
    const result = generate(buildRecord())
    expect(result.html.toLowerCase()).not.toContain('<script')
    expect(result.html).not.toContain('<link')
    expect(result.html).not.toContain('<img')
    expect(result.html).not.toContain('@import')
    expect(result.html).not.toContain('url(')
    expect(result.html).not.toMatch(/https?:\/\//i)

    const doc = parseHtml(result.html)
    expectNoExecutableElements(doc)
    expect(doc.querySelectorAll('[src],[href],[srcset],[poster],[data],[action],[formaction]').length).toBe(0)
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')
    expect(csp?.getAttribute('content')).toContain("default-src 'none'")
  })

  it('Trip 上夹带的额外字段不会进入离线页', () => {
    const trip = makeTrip() as Trip & { secret?: string; candidates?: unknown }
    trip.secret = 'sk-live-SECRET'
    trip.candidates = [{ name: 'hidden candidate' }]
    const result = generate(buildRecord({ trip }))
    expect(result.html).not.toContain('sk-live-SECRET')
    expect(result.html).not.toContain('hidden candidate')
  })

  it('不包含其它库 / 会话恢复 / 本地存储键 / 候选使用关系', () => {
    const result = generate(buildRecord())
    for (const key of [
      WORKSPACE_STORAGE_KEY,
      CANDIDATES_STORAGE_KEY,
      VERSIONS_STORAGE_KEY,
      SESSION_RESUME_DATA_KEY,
    ]) {
      expect(result.html).not.toContain(key)
    }
    // applies 是 sidecar 里的候选使用关系；本页只做行程只读快照，不展开候选库。
    expect(result.html).not.toContain('cand-1')
  })
})

describe('tripToOfflineHtml：fail closed', () => {
  it('顶层污染 / sidecar 未知字段 / 循环引用 / NaN / 重复 stop id 都被拒绝，不产出 HTML', () => {
    const valid = buildRecord()

    const topLevel = clone(valid) as unknown as Record<string, unknown>
    topLevel.candidates = { items: [] }
    const topLevelResult = tripToOfflineHtml(topLevel as unknown as WorkspaceRecordV1, {
      exportedAt: EXPORTED_AT,
    })
    expect(topLevelResult.ok).toBe(false)
    if (!topLevelResult.ok) expect(topLevelResult.reason).toBe('invalid_record')

    const nested = clone(valid) as unknown as Record<string, unknown>
    ;(nested.sidecar as Record<string, unknown>).versions = { items: [] }
    const nestedResult = tripToOfflineHtml(nested as unknown as WorkspaceRecordV1, {
      exportedAt: EXPORTED_AT,
    })
    expect(nestedResult.ok).toBe(false)
    if (!nestedResult.ok) expect(nestedResult.reason).toBe('invalid_record')

    const cyclic = clone(valid)
    ;(cyclic.trip as Trip & { loop?: unknown }).loop = cyclic.trip
    const cyclicResult = tripToOfflineHtml(cyclic, { exportedAt: EXPORTED_AT })
    expect(cyclicResult.ok).toBe(false)
    if (!cyclicResult.ok) expect(cyclicResult.reason).toBe('invalid_record')

    const nan = clone(valid)
    nan.trip.days[0].stops[0].duration_minutes = Number.NaN
    const nanResult = tripToOfflineHtml(nan, { exportedAt: EXPORTED_AT })
    expect(nanResult.ok).toBe(false)
    if (!nanResult.ok) expect(nanResult.reason).toBe('invalid_record')

    const duplicate = clone(valid)
    duplicate.trip.days[0].stops[1].id = duplicate.trip.days[0].stops[0].id
    const duplicateResult = tripToOfflineHtml(duplicate, { exportedAt: EXPORTED_AT })
    expect(duplicateResult.ok).toBe(false)
    if (!duplicateResult.ok) expect(duplicateResult.reason).toBe('invalid_record')

    for (const result of [
      topLevelResult,
      nestedResult,
      cyclicResult,
      nanResult,
      duplicateResult,
    ]) {
      expect('html' in result).toBe(false)
    }
  })

  it('非法导出时间 / 非法上限 / 超过输出上限都明确失败，不生成半截文件', () => {
    const record = buildRecord()
    for (const exportedAt of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      const result = tripToOfflineHtml(record, { exportedAt })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('bad_exported_at')
      expect('html' in result).toBe(false)
    }
    for (const maxBytes of [0, -1, Number.NaN, MAX_OFFLINE_TRIP_HTML_BYTES + 1]) {
      const result = tripToOfflineHtml(record, { exportedAt: EXPORTED_AT, maxBytes })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('bad_limit')
      expect('html' in result).toBe(false)
    }
    const tooLarge = tripToOfflineHtml(record, { exportedAt: EXPORTED_AT, maxBytes: 1024 })
    expect(tooLarge.ok).toBe(false)
    if (!tooLarge.ok) {
      expect(tooLarge.reason).toBe('too_large')
      expect(tooLarge.message).toContain('没有生成文件')
    }
    expect('html' in tooLarge).toBe(false)
  })

  it('失败时不写 storage、不发请求；成功也不读时钟 / 不改输入', () => {
    const record = buildRecord()
    const before = JSON.stringify(record)
    const nowSpy = vi.spyOn(Date, 'now')
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const first = generate(record)
    const second = generate(record)
    expect(first.html).toBe(second.html)
    expect(nowSpy).not.toHaveBeenCalled()
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(getItemSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(record)).toBe(before)

    const invalid = clone(record)
    invalid.trip.days[0].stops[0].duration_minutes = Number.NaN
    const failed = tripToOfflineHtml(invalid, { exportedAt: EXPORTED_AT })
    expect(failed.ok).toBe(false)
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(record)).toBe(before)
  })

  it('文件名清洗：恶意标题不会带出路径分隔符或标签字符', () => {
    const trip = makeTrip()
    trip.title = '../../<script>alert(1)</script>'
    const result = generate(buildRecord({ trip }))
    expect(result.filename).toMatch(/\.html$/)
    expect(result.filename).not.toMatch(/[<>:"/\\|?*]/)
  })
})

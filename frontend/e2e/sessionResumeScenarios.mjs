/**
 * 恢复启用（opt-in 会话留存）的离线浏览器场景，从 runner.mjs 的编排调用。
 *
 * 模式边界（与 runner 一致）：全部 /api 请求打本进程契约桩，非本机 HTTP 由 runner 的
 * route 门禁截获；本文件只驱动真实 UI 与真实 localStorage。**不注入页面业务状态**——
 * 行程/草稿/费用一律从真实 UI 操作产生；唯一例外是 B/C 场景的直接存储种子
 * （写 flag 与数据键），那是**被测输入**（模拟「上次会话留下的副本」），不是对页面
 * 运行时状态的注入；坏 JSON / 异版本种子本身就是要测的被测输入。
 *
 * 注入边界（重要，报告与文档均须保留这句话）：场景 D 对 window.localStorage 的属性
 * getter 与 Storage.prototype.setItem 做浏览器内可控注入（Playwright addInitScript /
 * page.evaluate），用于触发 SecurityError 与 QuotaExceededError。这是**可控注入**，
 * 不是平台自然触发的配额／权限事件；自然 quota 在 fresh 临时 profile 里不可复现，
 * 边界如实声明。注入脚本本身只改访问入口，不伪造任何业务数据，也不代表留存功能已
 * 「恢复」——面板必须显式反馈且旧副本原样，才算通过。
 *
 * 来源三态覆盖：场景 5 在真实 UI 启用后的自动留存 raw 里断言 openedFromFile===false
 * （应用内生成）；场景 6 的种子与再次留存断言 null（旧记录缺字段）全程保持未知；
 * 场景 9 从真实导出→标准 file input 选择→显式打开→启用留存的完整链路断言 true
 * （文件自述、未向服务器核对）。
 *
 * 覆盖限制（如实声明，不假称全覆盖）：
 * - 费用 binding=stale（只读沿用/新建）由 jsdom 集成测试覆盖，这里不造 stale 夹具。
 * - 真实平台自然 quota、localStorage.clear() 的 key=null 事件、too_large 门禁不在本批
 *   （场景 8 的 quota/SecurityError 是可控注入，非自然事件）。
 */
/** 留存两键：与 src/lib/sessionRestore.ts 的常量同值（纯 ESM 场景文件不引 TS 源） */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const artifactsDir = resolve(here, 'artifacts')

export const SESSION_RESUME_FLAG_KEY = 'travel-assistant:session-resume:enabled:v1'
export const SESSION_RESUME_DATA_KEY = 'travel-assistant:session-resume:data:v1'

export const SAVED_TRIPS_STORAGE_KEY = 'travel-assistant:saved-trips:v1'

/** 恢复 UI 选择器（与 SessionResumePanel / App 当前实现的可访问名对齐） */
export const resumeSel = {
  card: '[data-testid="session-resume-card"]',
  enableButton: 'button:has-text("在此浏览器保留工作进度")',
  disableButton: 'button:has-text("关闭保留（已留存的副本会保留）")',
  deleteEntry: 'button:has-text("删除本机恢复副本")',
  /** W4 改版：.session-resume-pending 退役；pending 概况是卡片内的绿边概况块（含「有上次的工作进度待恢复」文案） */
  pendingSummary: '[data-testid="session-resume-card"] p:has-text("有上次的工作进度待恢复")',
  restoreButton: 'button:has-text("恢复上次的工作进度")',
  discardEntry: 'button:has-text("放弃恢复并开始留存当前进度")',
  /** W4 改版：.session-resume/.field-error 退役；problem 态文案是卡片内 destructive Alert（role=alert） */
  problemAlert: '[data-testid="session-resume-card"] div[role="alert"]',
}

/** 本批场景用到的业务选择器（复用 runner 的 sel 之外补充的） */
export const bizSel = {
  startEditing: 'button:has-text("编辑这趟行程")',
  draftEditor: '[aria-label="本地行程草稿编辑器"]',
  applyDraft: 'button:has-text("应用草稿")',
  budgetEntry: '[data-testid="budget-entry"]',
  openBudget: 'button:has-text("费用估算")',
  budgetPanel: '[data-testid="trip-budget-panel"]',
  addBudgetRow: 'button:has-text("添加费用项")',
  budgetCompute: 'button:has-text("计算已填费用")',
  budgetKnownTotal: '[data-testid="budget-known-total"]',
  budgetNoAmounts: '[data-testid="budget-no-amounts"]',
  budgetIssues: '[data-testid="budget-issues"]',
  budgetRow: '[data-testid="budget-row"]',
  budgetOwnerNote: '[data-testid="budget-owner-note"]',
  /** W4 改版：.saved-toggle 退役，按可见文本定位（SavedTripsPanel 开关按钮） */
  savedToggle: 'button:has-text("已保存行程")',
  /** W4 改版：.saved-state 退役；unavailable 态是 destructive Alert（role="status"），data-variant 由 Alert 组件渲染 */
  savedUnavailable: '[aria-label="已保存的行程列表"] [data-variant="destructive"]',
  dayTabs: '[role="tablist"][aria-label="按日切换"] button[role="tab"]',
  /** W4 改版：.day-switch-note 退役；提示文案用 p:has-text 收窄（DAY_SWITCH_NOTE 现为工具类） */
  daySwitchNote: 'p',
}

export async function readStorageRaw(page, key) {
  return page.evaluate((k) => window.localStorage.getItem(k), key)
}

export async function listStorageKeys(page) {
  return page.evaluate(() => Object.keys(window.localStorage))
}

/** 断言（失败抛错，由 makeStepRecorder.step 记录） */
export function expectTrue(condition, message) {
  if (!condition) throw new Error(message)
}

export function expectEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}：期望 ${b.slice(0, 200)}，实际 ${a.slice(0, 200)}`)
}

/** 断言留存面板处于 off 形态：只有启用入口，无 pending / 恢复 / 关闭入口 */
export async function assertResumeUiDefaults(page, rec) {
  await rec.step('留存面板默认 off：只有启用入口，无待恢复卡/恢复/关闭/删除按钮', async () => {
    await page.waitForSelector(resumeSel.card, { timeout: 10000 })
    expectEqual(await page.locator(resumeSel.enableButton).count(), 1, '启用入口应恰有一个')
    expectEqual(await page.locator(resumeSel.disableButton).count(), 0, 'off 形态不应有关闭保留按钮')
    expectEqual(await page.locator(resumeSel.pendingSummary).count(), 0, 'off 形态不应有待恢复概况卡')

    expectEqual(await page.locator(resumeSel.restoreButton).count(), 0, 'off 形态不应有恢复按钮')
    expectEqual(await page.locator(resumeSel.deleteEntry).count(), 0, 'off 且无副本时不应有删除入口')
    return { off: true }
  })
}

/**
 * 断言待恢复概况卡文案与快照自述一致；raw 由调用方单独断言（本函数不读存储）。
 * 注意：概况文案只自述保存时的行数/标题，不提供内容核对——内容核对在恢复后做。
 */
export async function assertPendingCard(page, rec, expected) {
  await rec.step('待恢复概况卡：标题/天数/草稿/费用条数/来源未知自述', async () => {
    await page.waitForSelector(resumeSel.pendingSummary, { timeout: 10000 })
    const text = (await page.textContent(resumeSel.pendingSummary)) ?? ''
    expectTrue(text.includes(`《${expected.tripTitle}》`), `概况缺行程标题：${text.slice(0, 160)}`)
    expectTrue(text.includes(`共 ${expected.dayCount} 天`), `概况缺天数：${text.slice(0, 160)}`)
    expectTrue(text.includes('，含未应用的草稿修改'), `概况缺草稿标记：${text.slice(0, 160)}`)
    expectTrue(text.includes(`${expected.budgetRowCount} 条手工费用`), `概况缺费用条数：${text.slice(0, 160)}`)
    expectTrue(text.includes('这份进度没有记录来源标记，行程内容按未核实处理'), `概况缺未知来源自述：${text.slice(0, 160)}`)
    expectTrue(text.includes('点「恢复」才会替换当前页面'), `概况缺显式恢复说明：${text.slice(0, 160)}`)
    return { text: text.slice(0, 240) }
  })
}

/** deferred gate（与 runner.mjs 的 createGate 同构）：挂起契约桩响应以制造迟到/停止等待 */
function createGate() {
  const gate = { waiters: [] }
  gate.pendingCount = () => gate.waiters.length
  gate.release = () => {
    for (const resolveWaiter of gate.waiters.splice(0)) resolveWaiter()
  }
  return gate
}

/**
 * 场景 A：同 browser context 双真实页面——显式开启、草稿未应用、费用原字符串（0/空/非法）、
 * 第二页面真实 localStorage 写触发 StorageEvent → 第一页停写且外部副本不丢。
 */
export async function runResumeCrossTabScenario({ page, pageB, rec, screenshot }) {
  await assertResumeUiDefaults(page, rec)
  await rec.step('启用留存：flag 键写 1，自动留存把当前页面写入数据键', async () => {
    await page.click(resumeSel.enableButton)
    await page.waitForFunction(
      (key) => { try { return window.localStorage.getItem(key) === '1' } catch { return false } },
      SESSION_RESUME_FLAG_KEY,
      { timeout: 10000 },
    )
    // 自动写是 effect 驱动：等到数据键出现非空内容（真实写入证据），不猜时间
    await page.waitForFunction(
      (key) => { try { return (window.localStorage.getItem(key) ?? '').length > 0 } catch { return false } },
      SESSION_RESUME_DATA_KEY,
      { timeout: 10000 },
    )
    const raw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    const parsed = JSON.parse(raw)
    expectTrue(parsed.format === 'travel-assistant.session-resume' && parsed.version === 1, '留存信封 format/version 异常')
    expectTrue(typeof parsed.savedAt === 'number' && parsed.savedAt > 0, '留存信封 savedAt 异常')
    expectEqual(await page.locator(resumeSel.disableButton).count(), 1, '启用后应出现关闭保留按钮')
    return { flag: '1', dataBytes: raw.length, savedAt: parsed.savedAt }
  })
  await screenshot(page, '14-resume-enabled.png')

  await rec.step('留存面板帮助文案：列明不保留范围（未提交输入/撤销历史/AI 检查结论）', async () => {
    // W4 改版：.field-help 退役，帮助文案是卡片内的说明段（含「未提交的表单输入…不会留存」那一段）
    const help = (await page.$$eval(`${resumeSel.card} p`, (nodes) => nodes.map((n) => n.textContent ?? '').join('\n'))) ?? ''
    expectTrue(help.includes('未提交的表单输入'), `帮助缺未提交输入声明：${help.slice(0, 120)}`)
    expectTrue(help.includes('撤销历史'), `帮助缺撤销历史声明：${help.slice(0, 120)}`)
    expectTrue(help.includes('AI 检查结论'), `帮助缺 AI 检查结论声明：${help.slice(0, 120)}`)
    expectTrue(help.includes('不等于「保存行程」') || help.includes('正式保存仍需'), `帮助缺与正式保存的区分：${help.slice(0, 120)}`)
    return { help: help.slice(0, 200) }
  })

  await rec.step('填费用原字符串：0 / 留空 / 非法中间态（abc），计算已知合计 25.50（编辑前填，费用与草稿可同快照）', async () => {
    await page.click(bizSel.openBudget)
    await page.waitForSelector(bizSel.budgetPanel, { timeout: 5000 })
    await page.click(bizSel.addBudgetRow)
    await page.fill(`${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=0 >> input[placeholder="例如 高铁票"]`, '公交（0 元）')
    await page.fill(`${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=0 >> input[placeholder="0 也算一项"]`, '0')
    await page.click(bizSel.addBudgetRow)
    await page.fill(`${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=1 >> input[placeholder="例如 高铁票"]`, '未填金额项')
    // 第 2 行金额留空（empty 原字符串）
    await page.click(bizSel.addBudgetRow)
    await page.fill(`${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=2 >> input[placeholder="例如 高铁票"]`, '手滑输入项')
    await page.fill(`${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=2 >> input[placeholder="0 也算一项"]`, 'abc')
    await page.click(bizSel.addBudgetRow)
    await page.fill(`${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=3 >> input[placeholder="例如 高铁票"]`, '门票')
    await page.fill(`${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=3 >> input[placeholder="0 也算一项"]`, '25.5')
    await page.click(bizSel.budgetCompute)
    await page.waitForSelector(bizSel.budgetKnownTotal, { timeout: 5000 })
    const total = ((await page.textContent(bizSel.budgetKnownTotal)) ?? '').trim()
    expectTrue(total.startsWith('25.50'), `费用合计期望 25.50 开头，实际「${total}」`)
    const issues = await page.locator(bizSel.budgetIssues).count()
    expectTrue(issues === 1, '非法金额 abc 应出现在无效项列表')
    const issueText = (await page.textContent(bizSel.budgetIssues)) ?? ''
    expectTrue(issueText.includes('「abc」'), `无效项列表应保留原字符串 abc：${issueText.slice(0, 120)}`)
    return { total, issueText: issueText.slice(0, 160) }
  })
  await screenshot(page, '15-resume-budget.png')

  await rec.step('进入草稿编辑：改第 1 站名并保存到草稿，不应用（草稿预览说明可见；费用面板随编辑收起但输入仍在）', async () => {
    await page.click(bizSel.startEditing)
    await page.waitForSelector(bizSel.draftEditor, { timeout: 5000 })
    await page.locator(`${bizSel.draftEditor} [aria-label^="编辑第 1 站"]`).first().click()
    const nameInput = page.locator(`${bizSel.draftEditor} input[placeholder="例如 断桥残雪"]`).first()
    await nameInput.fill('留存验证改的站名')
    await page.click(`${bizSel.draftEditor} button:has-text("保存到草稿")`)
    // 「保存到草稿」清掉 dirty 后自动写恢复；等预览说明出现（草稿进入主视图预览态）
    await page.waitForSelector('[data-testid="draft-preview-note"]', { timeout: 5000 })
    return { editedStopName: '留存验证改的站名' }
  })
  await screenshot(page, '16-resume-draft-editing.png')

  await rec.step('自动留存同时捕获草稿块与费用原字符串（读存储 raw 原文断言，不经 UI）', async () => {
    // 保存到草稿触发一次自动写；等存储快照出现草稿块 + 4 行费用
    await page.waitForFunction(
      (key) => {
        try {
          const raw = window.localStorage.getItem(key)
          if (!raw) return false
          const parsed = JSON.parse(raw)
          return (
            parsed.session?.draft !== null &&
            Array.isArray(parsed.session?.budget?.rows) &&
            parsed.session.budget.rows.length === 4
          )
        } catch {
          return false
        }
      },
      SESSION_RESUME_DATA_KEY,
      { timeout: 10000 },
    )
    const raw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    const parsed = JSON.parse(raw)
    expectTrue(parsed.session.draft !== null && Array.isArray(parsed.session.draft.editedDays), '保存到草稿后快照应有 draft 块')
    expectTrue(
      JSON.stringify(parsed.session.draft.editedDays).includes('留存验证改的站名'),
      'draft 块应包含未应用的站名编辑',
    )
    // 来源 false：本 context 全程真实 UI（启用→编辑→费用），无文件打开，快照自述必须写 false
    expectEqual(parsed.session.ui.openedFromFile, false, '应用内来源快照应显式写 openedFromFile=false（不能是 null/缺失）')
    const rows = parsed.session.budget.rows
    expectEqual(
      rows.map((r) => `${r.name}:${r.amountRaw}`),
      ['公交（0 元）:0', '未填金额项:', '手滑输入项:abc', '门票:25.5'],
      '留存快照的费用原字符串与页面输入不一致',
    )
    expectEqual(parsed.session.budget.binding.kind, 'current', '当前行程的费用应绑定为 current')
    return { rows: rows.map((r) => `${r.name}:${r.amountRaw}`), hasDraft: true }
  })

  await rec.step('编辑器未提交输入（dirty）期间暂停自动写，提交后恢复', async () => {
    const rawBeforeDirty = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    await page.locator(`${bizSel.draftEditor} [aria-label^="编辑第 1 站"]`).first().click()
    const nameInput = page.locator(`${bizSel.draftEditor} input[placeholder="例如 断桥残雪"]`).first()
    await nameInput.fill('未提交的临时输入')
    await page.waitForSelector('p:has-text("日期切换已暂停")', { timeout: 5000 })
    const savedBefore = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    // 有界等待真实 effect（200ms×10）确认没有写入发生；不写死「等 2 秒当成功」
    let unchanged = true
    for (let i = 0; i < 10; i += 1) {
      await page.waitForTimeout(200)
      const rawNow = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
      if (rawNow !== savedBefore) { unchanged = false; break }
    }
    expectTrue(unchanged, 'dirty 期间留存副本发生了自动写入（应暂停）')
    await page.click(`${bizSel.draftEditor} button:has-text("取消输入")`)
    await page.waitForFunction(
      ([key, prev]) => { try { return window.localStorage.getItem(key) !== prev } catch { return false } },
      [SESSION_RESUME_DATA_KEY, savedBefore],
      { timeout: 10000 },
    )
    const rawAfter = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    void rawBeforeDirty
    const parsed = JSON.parse(rawAfter)
    expectTrue(
      parsed.session?.draft !== null &&
      Array.isArray(parsed.session?.budget?.rows) &&
      parsed.session.budget.rows.length === 4,
      '取消输入后的自动写应保留草稿块与费用 4 行',
    )
    expectTrue((await page.locator('p:has-text("日期切换已暂停")').count()) === 0, '取消输入后 dirty 提示应消失')
    return { dirtyPaused: true, resumedAfterCancel: true }
  })

  await rec.step('同 context 第二真实页面打开：同 origin、同一 localStorage（无预注入状态）', async () => {
    await pageB.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await pageB.waitForSelector(resumeSel.card, { timeout: 15000 })
    // 第二页读同一个 flag=1，也应进入启用形态（真实共享存储证据）
    expectEqual(await pageB.locator(resumeSel.enableButton).count(), 0, '第二页共享 flag=1，不应再显示启用入口')
    return { sharedStorage: true }
  })

  await rec.step('第二页面直接写数据键 → 第一页收到真实 StorageEvent 并停写', async () => {
    const rawA = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    const externalSnapshot = JSON.parse(rawA)
    // 外部副本 = 第一页刚写的快照，把行程标题改掉以区分来源
    externalSnapshot.session.trip = { ...externalSnapshot.session.trip, title: '外部标签页写入的行程' }
    const externalRaw = JSON.stringify(externalSnapshot)
    await pageB.evaluate(
      ([key, value]) => { window.localStorage.setItem(key, value) },
      [SESSION_RESUME_DATA_KEY, externalRaw],
    )
    // 条件等待第一页 problem 横幅（storage 事件 → 冲突暂停），不固定 sleep
    await page.waitForSelector(resumeSel.problemAlert, { timeout: 10000 })
    const alert = (await page.textContent(resumeSel.problemAlert)) ?? ''
    expectTrue(alert.includes('检测到另一个标签页更新了留存副本'), `冲突提示文案异常：${alert.slice(0, 200)}`)
    expectTrue(alert.includes('已暂停自动留存'), `冲突提示缺停写声明：${alert.slice(0, 200)}`)
    // 外部副本原样，没有被第一页覆盖
    const rawAfter = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(rawAfter === externalRaw, '冲突后外部副本被第一页改写（应原样保留）')
    // 停写证据：在第一页做一次会触发自动写的草稿编辑，等有界窗口确认副本不被触碰
    await page.locator(`${bizSel.draftEditor} [aria-label^="编辑第 1 站"]`).first().click()
    const nameInput = page.locator(`${bizSel.draftEditor} input[placeholder="例如 断桥残雪"]`).first()
    await nameInput.fill('停写后的编辑')
    await page.click(`${bizSel.draftEditor} button:has-text("保存到草稿")`)
    await page.waitForSelector('[data-testid="draft-preview-note"]', { timeout: 5000 })
    let externalUnchanged = true
    for (let i = 0; i < 10; i += 1) {
      await page.waitForTimeout(200)
      const rawNow = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
      if (rawNow !== externalRaw) { externalUnchanged = false; break }
    }
    expectTrue(externalUnchanged, '冲突暂停后第一页的编辑仍写入了留存副本（应停写）')
    return { conflictAlert: alert.slice(0, 160), externalTitle: '外部标签页写入的行程', externalUnchanged }
  })

  await rec.step('外部副本内容仍可被读回（off 之外的第二页 pending 语义在场景 B 覆盖；此处断言数据不丢）', async () => {
    const raw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    const parsed = JSON.parse(raw)
    expectTrue(parsed.session.trip.title === '外部标签页写入的行程', '外部副本内容丢失')
    return { preserved: true }
  })
}

/**
 * 场景 B：reload → pending（示例/规划迟到都不覆盖 raw）→ 显式恢复草稿/费用/来源未知 →
 * 关闭保副本 → 重开再 pending；全程不写正式保存键。
 */
export async function runResumeRestoreScenario({ page, rec, control, screenshot }) {
  await rec.step('首页默认 off 且无恢复数据（fresh context：两键均不存在）', async () => {
    await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForSelector(resumeSel.card, { timeout: 15000 })
    const keys = await listStorageKeys(page)
    expectTrue(!keys.includes(SESSION_RESUME_FLAG_KEY) && !keys.includes(SESSION_RESUME_DATA_KEY), `fresh context 不应有留存键：${JSON.stringify(keys)}`)
    expectEqual(await page.locator(resumeSel.pendingSummary).count(), 0, 'off 形态不应有待恢复卡')
    return { keys }
  })

  await rec.step('生成一次规划（gate 挂起 → 停止等待，验证停止不写任何留存键）', async () => {
    control.planDelay = createGate()
    await page.fill('input[placeholder="例如：杭州"]', '苏州')
    await page.click('button:has-text("生成行程")')
    await page.waitForSelector('button:has-text("停止等待")', { timeout: 15000 })
    await page.click('button:has-text("停止等待")')
    // W4 改版：.plan-cancel-status 退役；PLAN_CANCEL_STATUS 现为工具类，文案锚点 role="status"
    await page.waitForSelector('p[role="status"]:has-text("已停止等待")', { timeout: 5000 })
    control.planDelay.release()
    control.planDelay = null
    const keys = await listStorageKeys(page)
    expectTrue(!keys.includes(SESSION_RESUME_FLAG_KEY) && !keys.includes(SESSION_RESUME_DATA_KEY), `off 时规划/停止不应写留存键：${JSON.stringify(keys)}`)
    return { stoppedWaiting: true }
  })

  await rec.step('种子化：flag=1 + 来源未知（openedFromFile:null，旧记录缺字段）v1 信封（含草稿/费用 0/空/非法）', async () => {
    const seeded = await page.evaluate(
      ([flagKey, dataKey, payload]) => {
        window.localStorage.setItem(flagKey, '1')
        window.localStorage.setItem(dataKey, JSON.stringify(payload))
        return { flag: window.localStorage.getItem(flagKey), bytes: (window.localStorage.getItem(dataKey) ?? '').length }
      },
      [SESSION_RESUME_FLAG_KEY, SESSION_RESUME_DATA_KEY, seededResumePayload()],
    )
    expectTrue(seeded.flag === '1' && seeded.bytes > 500, `种子化写入异常：${JSON.stringify(seeded)}`)
    return seeded
  })

  await rec.step('reload → flag=1 + 数据键存在 → pending 概况（示例行程不覆盖副本）', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await assertPendingCard(page, rec, {
      tripTitle: '留存恢复验证·苏州两日',
      dayCount: 2,
      budgetRowCount: 3,
    })
    // 示例加载完成后主视图标题仍是示例（pending 不自动替换页面），raw 原样
    await page.waitForSelector('section[aria-label="行程安排"] h2', { timeout: 15000 })
    const exampleTitle = (await page.textContent('section[aria-label="行程安排"] h2')) ?? ''
    expectTrue(exampleTitle.includes('契约桩示例'), `首屏不是示例行程：${exampleTitle}`)
    const rawNow = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    const parsed = JSON.parse(rawNow)
    expectTrue(parsed.session.trip.title === '留存恢复验证·苏州两日', 'pending 期间留存副本被示例覆盖')
    expectTrue(rawNow === JSON.stringify(seededResumePayload()), 'pending 期间副本 raw 被改写')
    return { exampleTitle, rawPreserved: true }
  })
  await screenshot(page, '16-resume-pending.png')

  await rec.step('pending 期间提交规划：gate 挂起 → 停止等待 → 迟到响应不覆盖 pending 副本', async () => {
    control.planDelay = createGate()
    await page.fill('input[placeholder="例如：杭州"]', '西安')
    await page.click('button:has-text("生成行程")')
    await page.waitForSelector('button:has-text("停止等待")', { timeout: 15000 })
    await page.click('button:has-text("停止等待")')
    // W4 改版：.plan-cancel-status 退役；PLAN_CANCEL_STATUS 现为工具类，文案锚点 role="status"
    await page.waitForSelector('p[role="status"]:has-text("已停止等待")', { timeout: 5000 })
    // 停止等待后桩仍收到这次 plan 请求（真实到达证据），再显式放行让它「迟到」
    const deadline = Date.now() + 5000
    while (!control.requests.some((r) => r.path === '/api/trips/plan') && Date.now() < deadline) {
      await page.waitForTimeout(50)
    }
    expectTrue(control.requests.some((r) => r.path === '/api/trips/plan'), 'pending 期间的规划请求未到达桩')
    control.planDelay.release()
    control.planDelay = null
    const rawNow = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(rawNow === JSON.stringify(seededResumePayload()), 'pending 期间（含迟到响应后）副本 raw 被改写')
    expectEqual(await page.locator(resumeSel.pendingSummary).count(), 1, 'pending 卡不应消失')
    const titleAfterLate = (await page.textContent('section[aria-label="行程安排"] h2')) ?? ''
    expectTrue(titleAfterLate.includes('契约桩示例'), `迟到响应覆盖了页面：${titleAfterLate}`)
    return { rawPreserved: true, titleAfterLate }
  })

  await rec.step('显式恢复：带草稿副本进入编辑态（未自动应用），主视图为草稿预览', async () => {
    await page.click(resumeSel.restoreButton)
    // 恢复的副本带未应用草稿 → 页面进入草稿编辑态；appliedNotice 在编辑期间不渲染，
    // 所以先核对编辑态证据，恢复通告（含来源说明）在下一步放弃草稿后核对。
    await page.waitForSelector('[data-testid="draft-preview-note"]', { timeout: 10000 })
    const title = (await page.textContent('section[aria-label="行程安排"] h2')) ?? ''
    expectTrue(title.includes('留存恢复验证·苏州两日'), `恢复后主视图标题异常：${title}`)
    const stops = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(stops.includes('D1 改名站（来自草稿）'), `恢复后主视图缺草稿预览站：${JSON.stringify(stops)}`)
    expectTrue(stops.includes('拙政园') && stops.includes('定园'), `恢复后缺 base 站：${JSON.stringify(stops)}`)
    expectEqual(await page.locator('button:has-text("应用草稿")').count(), 1, '恢复后应有「应用草稿」入口（草稿未自动应用）')
    expectEqual(await page.locator('button:has-text("恢复上次的工作进度")').count(), 0, '恢复后 pending 卡应消失')
    // 不显示「已保存」/「从本浏览器保存的副本恢复」时间戳（restoredAt 只属于已保存行程）
    expectEqual(await page.locator('.trip-restored-note').count(), 0, '留存恢复不应显示已保存时间戳')
    return { title, restoredStops: stops }
  })

  await rec.step('放弃恢复来的草稿（两步确认）→ 恢复通告可见：来源未知自述 + 不是已保存行程', async () => {
    await page.click('button:has-text("放弃草稿")')
    await page.click('button:has-text("确认放弃草稿")')
    await page.waitForSelector('[data-testid="apply-notice"]', { timeout: 10000 })
    const notice = (await page.textContent('[data-testid="apply-notice"]')) ?? ''
    expectTrue(notice.includes('已从本机留存的工作进度恢复'), `恢复通告异常：${notice.slice(0, 240)}`)
    expectTrue(notice.includes('这份进度没有记录来源标记，行程内容按未核实处理'), `恢复通告缺未知来源声明：${notice.slice(0, 240)}`)
    expectTrue(notice.includes('这不是「保存的行程」'), `恢复通告缺非保存声明：${notice.slice(0, 240)}`)
    const stopsAfterDiscard = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(!stopsAfterDiscard.includes('D1 改名站（来自草稿）'), '放弃草稿后主视图仍显示草稿站')
    expectTrue(stopsAfterDiscard.includes('平江路'), `放弃草稿后 base 站异常：${JSON.stringify(stopsAfterDiscard)}`)
    return { notice: notice.slice(0, 240), stopsAfterDiscard }
  })

  await rec.step('恢复后费用面板：3 行原字符串（0/空/abc）可编辑（current 已重绑），可计算合计 0.00', async () => {
    await page.click('button:has-text("费用估算")')
    await page.waitForSelector('[data-testid="trip-budget-panel"]', { timeout: 5000 })
    const rowTexts = await page.$$eval('[data-testid="budget-row"]', (nodes) =>
      nodes.map((node) => {
        const name = node.querySelector('input[placeholder="例如 高铁票"]')?.value ?? ''
        const amount = node.querySelector('input[placeholder="0 也算一项"]')?.value ?? ''
        return `${name}:${amount}`
      }),
    )
    expectEqual(rowTexts, ['公交（0 元）:0', '未填金额项:', '手滑输入项:abc'], '恢复后费用原字符串不一致')
    expectEqual(await page.locator('[data-testid="budget-owner-note"]').count(), 0, 'current 费用恢复后不应进入只读锁定')
    // 当前新行程版本：填写金额并计算，验证费用确实绑定到恢复后的行程（可编辑）
    await page.fill('[data-testid="budget-row"] >> nth=1 >> input[placeholder="0 也算一项"]', '30')
    await page.click('button:has-text("计算已填费用")')
    await page.waitForSelector('[data-testid="budget-known-total"]', { timeout: 5000 })
    const total = ((await page.textContent('[data-testid="budget-known-total"]')) ?? '').trim()
    expectTrue(total.startsWith('30.00'), `恢复后重绑费用应可计算，合计期望 30.00 开头，实际「${total}」`)
    return { rowTextsBeforeEdit: ['公交（0 元）:0', '未填金额项:', '手滑输入项:abc'], totalAfterEdit: total }
  })
  await screenshot(page, '17-resume-restored.png')

  await rec.step('恢复不是保存：正式保存键全程未出现；再次留存款据带恢复行程、来源保持未知', async () => {
    const keys = await listStorageKeys(page)
    expectTrue(!keys.includes(SAVED_TRIPS_STORAGE_KEY), `不应写入正式保存键：${JSON.stringify(keys)}`)
    const currentRaw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    const currentParsed = JSON.parse(currentRaw)
    expectTrue(
      typeof currentParsed.savedAt === 'number' && currentParsed.savedAt > 1793000000000,
      `自动留存未重新落盘（savedAt 应晚于种子时间 1793000000000）：${currentParsed.savedAt}`,
    )
    expectTrue(currentParsed.session.trip.title === '留存恢复验证·苏州两日', '恢复后自动留存应携带恢复的行程')
    expectTrue(Array.isArray(currentParsed.session.budget?.rows) && currentParsed.session.budget.rows.length === 3, '恢复后自动留存的费用行数异常')
    expectEqual(currentParsed.session.ui.openedFromFile, null, '旧记录未知来源在再次留存时必须保持 null（不降级成 false）')
    // 草稿已在此前步骤显式放弃：无差异投影为 null 是合法空值，不是丢块
    expectEqual(currentParsed.session.draft, null, '放弃草稿后再次留存 draft 应为 null（合法空值）')
    return { savedTripsKeyAbsent: true, openedFromFileKeptNull: true, reSavedAt: currentParsed.savedAt }
  })

  await rec.step('关闭保副本：flag 置 0（停用语义）、数据键原样、面板回 off 且仍有删除入口', async () => {
    const rawBefore = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    await page.click('button:has-text("关闭保留（已留存的副本会保留）")')
    // setSessionResumeFlag(false) 写 '0'：读端只有 '1' 算启用 → off 语义，键不必被移除
    await page.waitForFunction(
      (flagKey) => { try { return window.localStorage.getItem(flagKey) !== '1' } catch { return true } },
      SESSION_RESUME_FLAG_KEY,
      { timeout: 10000 },
    )
    const flagAfter = await readStorageRaw(page, SESSION_RESUME_FLAG_KEY)
    const rawAfter = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(rawAfter === rawBefore, '关闭保留改动了数据键（应原样）')
    await page.waitForSelector('button:has-text("在此浏览器保留工作进度")', { timeout: 5000 })
    // W4 改版：.field-error 退役；problem 态文案是卡片内 destructive Alert（本步断言无错误 → 计数 0）
    expectEqual(await page.locator('[data-testid="session-resume-card"] div[role="alert"]').count(), 0, '关闭保留不应显示错误文案')
    expectEqual(await page.locator('button:has-text("删除本机恢复副本")').count(), 1, 'off 但有副本时应显示删除入口')
    return { flagAfter, dataBytes: rawAfter.length }
  })

  await rec.step('重新开启按合同：重读副本 → 再次 pending（不自动恢复、不自动覆盖）', async () => {
    await page.click('button:has-text("在此浏览器保留工作进度")')
    // 二选一等待：pending 概况出现即通过；若出现 problem 横幅则作为缺陷证据记录并失败
    const outcome = await Promise.race([
      page
        .waitForSelector('p:has-text("有上次的工作进度待恢复")', { timeout: 10000 })
        .then(() => 'pending'),
      page
        .waitForSelector(resumeSel.problemAlert, { timeout: 10000 })
        .then(async () => `problem:${((await page.textContent(resumeSel.problemAlert)) ?? '').slice(0, 160)}`),
    ]).catch(async () => `neither:${((await page.textContent(resumeSel.card)) ?? '').slice(0, 200)}`)
    expectTrue(outcome === 'pending', `重新开启后未出现 pending（结果：${outcome}；面板原文：${((await page.textContent(resumeSel.card)) ?? '').slice(0, 300)}）`)
    expectEqual(await page.locator('button:has-text("恢复上次的工作进度")').count(), 1, '重新开启后应出现恢复按钮')
    expectEqual(await page.locator('button:has-text("应用草稿")').count(), 0, '重新开启不应自动恢复草稿')
    return { repending: true }
  })

  await rec.step('闭环恢复：App 自己写回的副本 → reload 后 pending 仍在 → 显式恢复再次成功', async () => {
    // 关闭前 App 刚把「恢复后的行程 + 编辑过的费用」写回数据键（步骤「恢复不是保存」已断言
    // savedAt 晚于种子）；这里关闭→重开→reload，验证 App 写回的 record 走完整 pending→恢复闭环
    await page.click('button:has-text("关闭保留（已留存的副本会保留）")')
    await page.waitForFunction(
      (flagKey) => { try { return window.localStorage.getItem(flagKey) !== '1' } catch { return true } },
      SESSION_RESUME_FLAG_KEY,
      { timeout: 10000 },
    )
    await page.click('button:has-text("在此浏览器保留工作进度")')
    await page.waitForSelector(resumeSel.pendingSummary, { timeout: 10000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    // reload 后 App 重新读存储：pending 概况 = App 写回的那份（标题一致）
    await page.waitForSelector(resumeSel.pendingSummary, { timeout: 10000 })
    const pendingText = (await page.textContent(resumeSel.pendingSummary)) ?? ''
    expectTrue(pendingText.includes('留存恢复验证·苏州两日'), `reload 后 pending 标题异常：${pendingText.slice(0, 200)}`)
    expectTrue(pendingText.includes('3 条手工费用'), `reload 后 pending 费用条数异常：${pendingText.slice(0, 200)}`)
    // 显式恢复：无草稿（已放弃过）→ 不进编辑态；恢复通告直接可见
    await page.click(resumeSel.restoreButton)
    await page.waitForSelector('[data-testid="apply-notice"]', { timeout: 10000 })
    const notice = (await page.textContent('[data-testid="apply-notice"]')) ?? ''
    expectTrue(notice.includes('已从本机留存的工作进度恢复'), `闭环恢复通告异常：${notice.slice(0, 240)}`)
    expectTrue(notice.includes('这份进度没有记录来源标记，行程内容按未核实处理'), `闭环恢复缺未知来源声明：${notice.slice(0, 240)}`)
    const title = (await page.textContent('section[aria-label="行程安排"] h2')) ?? ''
    expectTrue(title.includes('留存恢复验证·苏州两日'), `闭环恢复后标题异常：${title}`)
    expectEqual(await page.locator('button:has-text("应用草稿")').count(), 0, '闭环恢复不应有草稿（此前已显式放弃）')
    expectEqual(await page.locator('.trip-restored-note').count(), 0, '闭环恢复不应显示已保存时间戳')
    return { closedLoopRestored: true, notice: notice.slice(0, 240) }
  })

  await rec.step('闭环恢复后费用原字符串仍在：步骤「30」的编辑经 App 写回→reload→恢复保持', async () => {
    await page.click('button:has-text("费用估算")')
    await page.waitForSelector('[data-testid="trip-budget-panel"]', { timeout: 5000 })
    const rowTexts = await page.$$eval('[data-testid="budget-row"]', (nodes) =>
      nodes.map((node) => {
        const name = node.querySelector('input[placeholder="例如 高铁票"]')?.value ?? ''
        const amount = node.querySelector('input[placeholder="0 也算一项"]')?.value ?? ''
        return `${name}:${amount}`
      }),
    )
    expectEqual(rowTexts, ['公交（0 元）:0', '未填金额项:30', '手滑输入项:abc'], '闭环恢复后费用原字符串（含编辑过的 30）不一致')
    const keys = await listStorageKeys(page)
    expectTrue(!keys.includes(SAVED_TRIPS_STORAGE_KEY), `闭环恢复不应写正式保存键：${JSON.stringify(keys)}`)
    return { rowTexts, savedTripsKeyAbsent: true }
  })
}
/** runner 传入的 appOrigin（模块顶层可变，避免每个场景重复传参） */
let appOriginFromRunner = null
export function setAppOrigin(origin) {
  appOriginFromRunner = origin
}

/**
 * 场景 C：坏 JSON / 异版本 → 问题态（恢复禁用、raw 逐字节保留、删除入口在）；off 门禁不读。
 */
export async function runResumeCorruptScenario({ page, rec, screenshot }) {
  await rec.step('fresh context 默认 off；先种坏 JSON（flag=1）→ reload → 问题态', async () => {
    await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForSelector(resumeSel.card, { timeout: 15000 })
    expectEqual(await page.locator(resumeSel.pendingSummary).count(), 0, 'off 不应显示 pending')
    await page.evaluate(
      ([flagKey, dataKey]) => {
        window.localStorage.setItem(flagKey, '1')
        window.localStorage.setItem(dataKey, '{not-valid-json!!')
      },
      [SESSION_RESUME_FLAG_KEY, SESSION_RESUME_DATA_KEY],
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(resumeSel.problemAlert, { timeout: 10000 })
    const alert = (await page.textContent(resumeSel.problemAlert)) ?? ''
    expectTrue(alert.includes('不是合法 JSON'), `坏 JSON 提示异常：${alert.slice(0, 200)}`)
    expectTrue(alert.includes('原始数据已原样保留'), `坏 JSON 提示缺保旧声明：${alert.slice(0, 200)}`)
    expectEqual(await page.locator(resumeSel.restoreButton).count(), 0, '损坏副本不应提供恢复入口')
    expectEqual(await page.locator(resumeSel.deleteEntry).count(), 1, '损坏副本应保留删除入口')
    const raw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(raw === '{not-valid-json!!', '坏 JSON raw 被改写')
    // 示例行程正常加载（留存损坏不拖垮页面主流程）
    await page.waitForSelector('section[aria-label="行程安排"] h2', { timeout: 15000 })
    expectTrue(((await page.textContent('section[aria-label="行程安排"] h2')) ?? '').includes('契约桩示例'), '损坏副本影响示例加载')
    return { alert: alert.slice(0, 200), rawPreserved: true }
  })
  await screenshot(page, '18-resume-corrupt.png')

  await rec.step('异版本（version:99，其余合法 v1 结构）→ 问题态 + raw 逐字节保留', async () => {
    const future = JSON.stringify({ ...seededResumePayload(), version: 99 })
    await page.evaluate(
      ([dataKey, value]) => { window.localStorage.setItem(dataKey, value) },
      [SESSION_RESUME_DATA_KEY, future],
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(resumeSel.problemAlert, { timeout: 10000 })
    const alert = (await page.textContent(resumeSel.problemAlert)) ?? ''
    expectTrue(alert.includes('版本不受支持'), `异版本提示异常：${alert.slice(0, 200)}`)
    expectEqual(await page.locator(resumeSel.restoreButton).count(), 0, '异版本不应提供恢复入口')
    const raw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(raw === future, '异版本 raw 被改写')
    return { alert: alert.slice(0, 160), rawPreserved: true }
  })

  await rec.step('关闭 flag（异版本问题态下）→ off 门禁生效：数据键不被读取也不再被改写', async () => {
    const rawBefore = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    await page.click(resumeSel.disableButton)
    await page.waitForFunction(
      (flagKey) => { try { return window.localStorage.getItem(flagKey) !== '1' } catch { return true } },
      SESSION_RESUME_FLAG_KEY,
      { timeout: 10000 },
    )
    const rawAfter = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(rawAfter === rawBefore, '关闭后异版本副本被改写')
    expectEqual(await page.locator(resumeSel.problemAlert).count(), 0, '关闭后问题文案应消失')
    expectEqual(await page.locator(resumeSel.deleteEntry).count(), 1, 'off 但副本仍在应显示删除入口')
    return { offGating: true }
  })

  await rec.step('off 下 reload：不自动读取或展示待恢复内容，数据键仍原样', async () => {
    const rawBefore = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(resumeSel.card, { timeout: 15000 })
    expectEqual(await page.locator(resumeSel.pendingSummary).count(), 0, 'off 不应显示 pending')
    expectEqual(await page.locator(resumeSel.problemAlert).count(), 0, 'off 不应读取数据键产生问题文案')
    expectEqual(await page.locator(resumeSel.deleteEntry).count(), 0, 'off 且从未启用过（本页会话）不显示删除入口')
    const rawAfter = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(rawAfter === rawBefore, 'off reload 后异版本副本被改写')
    return { offGatingAfterReload: true }
  })
}

/**
 * 场景 D：浏览器内可控注入 getter SecurityError / setItem QuotaExceededError。
 * 注入边界已在文件头声明：这是 CDP 脚本覆盖，不是平台自然 quota/权限故障。
 */
export async function runResumeInjectionScenario({ context, page, rec, screenshot }) {
  await rec.step('启用留存并等待首份自动留存（真实 UI 点击 + 存储证据）', async () => {
    await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForSelector(resumeSel.enableButton, { timeout: 15000 })
    await page.click(resumeSel.enableButton)
    await page.waitForFunction(
      (key) => { try { return (window.localStorage.getItem(key) ?? '').length > 0 } catch { return false } },
      SESSION_RESUME_DATA_KEY,
      { timeout: 10000 },
    )
    const raw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    return { enabled: true, dataBytes: raw.length }
  })

  await rec.step('可控注入 getter SecurityError → UI 明确「存储不可用、留存未启用」，旧副本 raw 原样', async () => {
    const rawBefore = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    // addInitScript：在页面脚本之前覆盖 window.localStorage 的属性 getter —— 模拟
    // 「localStorage getter 本身抛 SecurityError / 不可达」（Safari 隐私模式一类）。
    // App 初始化 getLocalStorageSafe() 访问 window.localStorage 抛错 → storage=null
    // → 初始 problem「存储不可用、留存未启用」。脚本读 sessionStorage 哨兵：
    // 还原的同时写 '1'，后续 reload 不再注入（Playwright 无 removeInitScript）。
    await context.addInitScript(() => {
      if (window.sessionStorage.getItem('__resumeGetterInjectionOff') === '1') return
      const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('injected: localStorage getter blocked', 'SecurityError')
        },
      })
      window.__resumeRestoreGetter = () => {
        Object.defineProperty(window, 'localStorage', storageDescriptor)
        delete window.__resumeRestoreGetter
      }
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(resumeSel.problemAlert, { timeout: 10000 })
    const alert = (await page.textContent(resumeSel.problemAlert)) ?? ''
    expectTrue(alert.includes('浏览器本地存储不可用'), `注入 getter 后提示异常：${alert.slice(0, 200)}`)
    expectTrue(alert.includes('工作进度留存未启用'), `注入 getter 后提示缺未启用声明：${alert.slice(0, 200)}`)
    expectEqual(await page.locator(resumeSel.enableButton).count(), 1, '存储不可用时仍应有启用入口（点击可重试获取）')
    // 还原 getter 后核对旧副本逐字节原样（注入只影响页面读取，磁盘数据不可被页面触碰）
    await page.evaluate(() => {
      window.sessionStorage.setItem('__resumeGetterInjectionOff', '1')
      window.__resumeRestoreGetter()
    })
    const flagAfterRestore = await readStorageRaw(page, SESSION_RESUME_FLAG_KEY)
    const rawAfter = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(rawAfter === rawBefore, '注入期间旧副本被改写')
    return { alert: alert.slice(0, 200), rawPreserved: true, flagAfterRestore, injection: 'window.localStorage getter SecurityError（addInitScript 可控注入）' }
  })
  await screenshot(page, '19-resume-injection-getter.png')

  await rec.step('可控注入 setItem QuotaExceededError → 写失败提示出现且旧副本原样，停写持久', async () => {
    // 先回到干净启用态：flag 置 1 → reload（getter 注入已还原，不再拦截）→ pending → 显式恢复
    await page.evaluate((flagKey) => { window.localStorage.setItem(flagKey, '1') }, SESSION_RESUME_FLAG_KEY)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(resumeSel.pendingSummary, { timeout: 10000 })
    await page.click(resumeSel.restoreButton)
    await page.waitForSelector('[data-testid="apply-notice"]', { timeout: 10000 })
    // 等恢复后的自动写完成（示例行程标题快照重新落盘），再取「注入前基准」
    await page.waitForFunction(
      (key) => {
        try {
          const raw = window.localStorage.getItem(key)
          if (!raw) return false
          return JSON.parse(raw).session?.trip?.title === '契约桩示例·杭州三日（离线验收）'
        } catch {
          return false
        }
      },
      SESSION_RESUME_DATA_KEY,
      { timeout: 10000 },
    )
    const rawBefore = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    await page.evaluate(() => {
      const realSet = Storage.prototype.setItem
      Object.defineProperty(Storage.prototype, 'setItem', {
        configurable: true,
        value: function () {
          const e = new DOMException('injected: quota exceeded', 'QuotaExceededError')
          e.code = 22
          throw e
        },
      })
      window.__resumeRestoreSetter = () => {
        Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: realSet })
        delete window.__resumeRestoreSetter
      }
    })
    // 触发一次真实自动写（切日签即可），写失败 → problem 停写提示
    await page.click('[role="tab"]:has-text("D2")')
    await page.waitForSelector(resumeSel.problemAlert, { timeout: 10000 })
    const alert = (await page.textContent(resumeSel.problemAlert)) ?? ''
    expectTrue(alert.includes('浏览器本地存储已满'), `quota 注入提示异常：${alert.slice(0, 200)}`)
    expectTrue(alert.includes('已有副本保持原样'), `quota 注入提示缺保旧声明：${alert.slice(0, 200)}`)
    // 还原 setter 后核对旧副本逐字节未动
    await page.evaluate(() => window.__resumeRestoreSetter())
    const rawAfter = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(rawAfter === rawBefore, 'quota 注入期间旧副本被改写')
    // 停写是持久的：还原后再做一次会触发自动写的操作，副本仍不动
    await page.click('[role="tab"]:has-text("D1")')
    let stillPaused = true
    for (let i = 0; i < 10; i += 1) {
      await page.waitForTimeout(200)
      const rawNow = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
      if (rawNow !== rawBefore) { stillPaused = false; break }
    }
    expectTrue(stillPaused, 'quota 失败后自动写未保持暂停（应停写至用户显式操作）')
    return { alert: alert.slice(0, 200), rawPreserved: true, stayedPaused: true, injection: 'setItem QuotaExceededError（页面内 Storage.prototype 注入，可控）' }
  })
  await screenshot(page, '20-resume-injection-quota.png')

  await rec.step('注入边界声明：本场景的错误由测试脚本可控注入，非平台自然 quota/权限故障', async () => {
    const flagRaw = await readStorageRaw(page, SESSION_RESUME_FLAG_KEY)
    return {
      injectionNote: '可控注入（页面脚本覆盖 Storage.prototype），不是平台自然触发的 quota/权限事件；自然 quota 在 fresh 临时 profile 不可复现。',
      flagRaw,
    }
  })
}

/**
 * 场景 9：文件来源 true 的完整真实 UI 链路——本 App 显式导出合法备份（真实 download）→
 * 标准 file input（setInputFiles）选择→显式「打开这份行程」→启用留存→从 UI 产生
 * 有辨识度的费用与未应用草稿→reload 后 pending raw 保旧→显式恢复→文件自述/未向服务器
 * 核对保持 true、草稿未自动应用、正式保存键未出现。每个动作都是显式点击，不绕过 UI。
 */
export async function runResumeFileSourceScenario({ context, page, rec, control, screenshot }) {
  const downloadDir = resolve(artifactsDir, 'file-source')
  const fileSourceState = { exportedFilename: null }
  await rec.step('打开首页加载示例行程（fresh context：无留存键）', async () => {
    await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForSelector('section[aria-label="行程安排"] h2', { timeout: 15000 })
    expectTrue(((await page.textContent('section[aria-label="行程安排"] h2')) ?? '').includes('契约桩示例'), '首屏不是契约桩示例行程')
    const keys = await listStorageKeys(page)
    expectTrue(!keys.includes(SESSION_RESUME_FLAG_KEY) && !keys.includes(SESSION_RESUME_DATA_KEY), `fresh context 不应有留存键：${JSON.stringify(keys)}`)
    return { title: await page.textContent('section[aria-label="行程安排"] h2') }
  })

  await rec.step('真实规划一次（契约桩 AI 行程）作为导出来源（与示例区分）', async () => {
    await page.fill('input[placeholder="例如：杭州"]', '成都')
    await page.click('button:has-text("生成行程")')
    await page.waitForFunction(
      () => document.querySelector('section[aria-label="行程安排"] h2')?.textContent?.includes('AI 契约桩') ?? false,
      undefined,
      { timeout: 20000 },
    )
    const title = (await page.textContent('section[aria-label="行程安排"] h2')) ?? ''
    expectTrue(title.includes('AI 契约桩'), `规划标题异常：${title}`)
    return { title }
  })

  await rec.step('展开「行程备份与导入」→ 显式点「下载行程备份 (.json)」→ 真实 download 保存', async () => {
    await page.click('button:has-text("行程备份与导入")')
    await page.waitForSelector('button:has-text("下载行程备份 (.json)")', { timeout: 5000 })
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 })
    await page.click('button:has-text("下载行程备份 (.json)")')
    const download = await downloadPromise
    mkdirSync(downloadDir, { recursive: true })
    await download.saveAs(resolve(downloadDir, download.suggestedFilename()))
    fileSourceState.exportedFilename = download.suggestedFilename()
    const backupJson = (await import('node:fs')).readFileSync(resolve(downloadDir, download.suggestedFilename()), 'utf-8')
    const envelope = JSON.parse(backupJson)
    expectTrue(envelope.format === 'travel-assistant.trip' && envelope.version === 1, `备份信封异常：${envelope.format}/${envelope.version}`)
    expectTrue(typeof envelope.exportedAt === 'string' && envelope.exportedAt.length > 0, '备份缺 exportedAt')
    expectTrue(envelope.trip?.title?.includes('AI 契约桩'), '备份 trip 应是刚规划的 AI 行程')
    return { filename: download.suggestedFilename(), bytes: backupJson.length, exportedAt: envelope.exportedAt }
  })

  await rec.step('标准 file input 选择刚下载的备份（setInputFiles）→ 页面预览（不绕过 UI）', async () => {
    const savedPath = resolve(downloadDir, fileSourceState.exportedFilename)
    // W4 改版：.trip-transfer-input 退役；file input 紧跟「选择备份文件（.json）」label
    await page.setInputFiles('input[type="file"][accept=".json,application/json"]', savedPath)
    // W4 改版：.trip-transfer-preview(-title) 退役；预览块标题是 h5「预览：{title}」
    await page.waitForSelector('h5:has-text("预览：")', { timeout: 10000 })
    const previewTitle = (await page.textContent('h5:has-text("预览：")')) ?? ''
    expectTrue(previewTitle.includes('AI 契约桩'), `预览标题异常：${previewTitle}`)
    return { previewTitle }
  })

  await rec.step('显式点「打开这份行程」→ 主视图替换 + 「来自备份文件」来源说明（openedFromFile=true 的 UI 证据）', async () => {
    await page.click('button:has-text("打开这份行程")')
    await page.waitForSelector('[data-note="imported-file"]', { timeout: 10000 })
    const importNote = (await page.textContent('[data-note="imported-file"]')) ?? ''
    expectTrue(importNote.includes('这份行程来自你选择的备份文件'), `来源说明异常：${importNote.slice(0, 200)}`)
    expectTrue(importNote.includes('页面没有向服务器核对过内容'), `来源说明缺未核对声明：${importNote.slice(0, 200)}`)
    expectTrue(importNote.includes('打开文件这个动作不会自动保存'), `来源说明缺非自动保存声明：${importNote.slice(0, 200)}`)
    const title = (await page.textContent('section[aria-label="行程安排"] h2')) ?? ''
    expectTrue(title.includes('AI 契约桩'), `打开文件后主视图标题异常：${title}`)
    return { title, importNote: importNote.slice(0, 200) }
  })
  await screenshot(page, '21-filesource-opened.png')

  await rec.step('显式点「在此浏览器保留工作进度」启用留存（打开文件之后：快照应自述 true）', async () => {
    await page.click(resumeSel.enableButton)
    await page.waitForFunction(
      (key) => { try { return (window.localStorage.getItem(key) ?? '').length > 0 } catch { return false } },
      SESSION_RESUME_DATA_KEY,
      { timeout: 10000 },
    )
    const raw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    const parsed = JSON.parse(raw)
    expectEqual(parsed.session.ui.openedFromFile, true, '打开文件后启用的首份快照应写 openedFromFile=true')
    expectTrue(parsed.session.trip.title.includes('AI 契约桩'), '首份快照应携带文件来源的行程')
    return { openedFromFile: parsed.session.ui.openedFromFile, dataBytes: raw.length }
  })

  await rec.step('从 UI 产生有辨识度的费用（77.25）与未应用草稿（改名「文件来源站（未应用）」）', async () => {
    await page.click('button:has-text("费用估算")')
    await page.waitForSelector('[data-testid="trip-budget-panel"]', { timeout: 5000 })
    await page.click('button:has-text("添加费用项")')
    await page.fill('[data-testid="budget-row"] >> nth=0 >> input[placeholder="例如 高铁票"]', '文件来源验证门票')
    await page.fill('[data-testid="budget-row"] >> nth=0 >> input[placeholder="0 也算一项"]', '77.25')
    await page.click('button:has-text("计算已填费用")')
    await page.waitForSelector('[data-testid="budget-known-total"]', { timeout: 5000 })
    const total = ((await page.textContent('[data-testid="budget-known-total"]')) ?? '').trim()
    expectTrue(total.startsWith('77.25'), `费用合计期望 77.25 开头，实际「${total}」`)
    // 费用面板随编辑收起：进入草稿编辑，改第 1 站名并保存到草稿（不应用）
    await page.click('button:has-text("编辑这趟行程")')
    await page.waitForSelector('[aria-label="本地行程草稿编辑器"]', { timeout: 5000 })
    await page.locator('[aria-label="本地行程草稿编辑器"] [aria-label^="编辑第 1 站"]').first().click()
    const nameInput = page.locator('[aria-label="本地行程草稿编辑器"] input[placeholder="例如 断桥残雪"]').first()
    await nameInput.fill('文件来源站（未应用）')
    await page.click('[aria-label="本地行程草稿编辑器"] button:has-text("保存到草稿")')
    await page.waitForSelector('[data-testid="draft-preview-note"]', { timeout: 5000 })
    // 自动写恢复：等快照出现草稿块 + 1 行费用
    await page.waitForFunction(
      (key) => {
        try {
          const raw = window.localStorage.getItem(key)
          if (!raw) return false
          const parsed = JSON.parse(raw)
          return parsed.session?.draft !== null && parsed.session?.budget?.rows?.length === 1
        } catch {
          return false
        }
      },
      SESSION_RESUME_DATA_KEY,
      { timeout: 10000 },
    )
    const raw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    const parsed = JSON.parse(raw)
    expectEqual(parsed.session.ui.openedFromFile, true, '编辑后的再次留存必须保持 openedFromFile=true（不能降级）')
    expectEqual(parsed.session.budget.rows[0].amountRaw, '77.25', '快照费用原字符串异常')
    return { total, amountRaw: parsed.session.budget.rows[0].amountRaw, hasDraft: true }
  })
  await screenshot(page, '22-filesource-draft-budget.png')

  await rec.step('reload → pending 概况（文件来源自述 + raw 保旧）→ pending 期间副本不被示例覆盖', async () => {
    const rawBefore = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector(resumeSel.pendingSummary, { timeout: 15000 })
    const pendingText = (await page.textContent(resumeSel.pendingSummary)) ?? ''
    expectTrue(pendingText.includes('AI 契约桩'), `pending 标题异常：${pendingText.slice(0, 200)}`)
    expectTrue(pendingText.includes('这份进度当时的行程来自你选择的备份文件'), `pending 缺文件来源自述：${pendingText.slice(0, 240)}`)
    expectTrue(pendingText.includes('页面没有向服务器核对过'), `pending 缺未核对声明：${pendingText.slice(0, 240)}`)
    expectTrue(pendingText.includes('1 条手工费用'), `pending 费用条数异常：${pendingText.slice(0, 200)}`)
    // 示例照常加载但不覆盖副本
    await page.waitForSelector('section[aria-label="行程安排"] h2', { timeout: 15000 })
    expectTrue(((await page.textContent('section[aria-label="行程安排"] h2')) ?? '').includes('契约桩示例'), 'pending 期间示例未加载')
    const rawNow = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(rawNow === rawBefore, 'pending 期间副本 raw 被改写')
    return { pendingText: pendingText.slice(0, 240), rawPreserved: true }
  })

  await rec.step('显式恢复：草稿进编辑态（未自动应用）；放弃草稿后恢复通告=文件自述+未向服务器核对', async () => {
    await page.click(resumeSel.restoreButton)
    await page.waitForSelector('[data-testid="draft-preview-note"]', { timeout: 10000 })
    const stops = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(stops.includes('文件来源站（未应用）'), `恢复后主视图缺草稿预览站：${JSON.stringify(stops)}`)
    expectEqual(await page.locator('button:has-text("应用草稿")').count(), 1, '恢复后应有「应用草稿」入口（草稿未自动应用）')
    // 草稿编辑期间 appliedNotice 不渲染；放弃草稿（两步确认）后核对恢复通告
    await page.click('button:has-text("放弃草稿")')
    await page.click('button:has-text("确认放弃草稿")')
    await page.waitForSelector('[data-testid="apply-notice"]', { timeout: 10000 })
    const notice = (await page.textContent('[data-testid="apply-notice"]')) ?? ''
    expectTrue(notice.includes('已从本机留存的工作进度恢复'), `恢复通告异常：${notice.slice(0, 260)}`)
    expectTrue(notice.includes('这份进度当时的行程来自你选择的备份文件'), `恢复通告缺文件来源自述：${notice.slice(0, 260)}`)
    expectTrue(notice.includes('页面仍未向服务器核对内容'), `恢复通告缺未核对声明：${notice.slice(0, 260)}`)
    expectTrue(notice.includes('这不是「保存的行程」'), `恢复通告缺非保存声明：${notice.slice(0, 260)}`)
    // 主视图仍带「来自备份文件」说明（打开文件来源在恢复后保持）
    expectEqual(await page.locator('[data-note="imported-file"]').count(), 1, '恢复后应保留文件来源说明')
    // restoredAt 时间戳说明（「从本浏览器保存的副本恢复 · 保存于 …」）只在已保存行程恢复时出现；
    // 该说明与文件来源说明共用 .trip-restored-note 样式类，用文案区分（不能按类名计数）
    expectEqual(await page.locator('.trip-restored-note:has-text("从本浏览器保存的副本恢复")').count(), 0, '留存恢复不应显示已保存时间戳')
    return { notice: notice.slice(0, 260) }
  })
  await screenshot(page, '23-filesource-restored.png')

  await rec.step('恢复后费用原字符串 77.25 原样且可编辑；再次留存 true 保持；正式保存键未出现', async () => {
    await page.click('button:has-text("费用估算")')
    await page.waitForSelector('[data-testid="trip-budget-panel"]', { timeout: 5000 })
    const rowTexts = await page.$$eval('[data-testid="budget-row"]', (nodes) =>
      nodes.map((node) => {
        const name = node.querySelector('input[placeholder="例如 高铁票"]')?.value ?? ''
        const amount = node.querySelector('input[placeholder="0 也算一项"]')?.value ?? ''
        return `${name}:${amount}`
      }),
    )
    expectEqual(rowTexts, ['文件来源验证门票:77.25'], '恢复后费用原字符串不一致')
    expectEqual(await page.locator('[data-testid="budget-owner-note"]').count(), 0, 'current 费用恢复后不应进入只读锁定')
    // 再次留存（放弃草稿触发一次写）：true 保持
    await page.waitForFunction(
      (key) => {
        try {
          const raw = window.localStorage.getItem(key)
          if (!raw) return false
          return JSON.parse(raw).session?.ui?.openedFromFile === true
        } catch {
          return false
        }
      },
      SESSION_RESUME_DATA_KEY,
      { timeout: 10000 },
    )
    const raw = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    const parsed = JSON.parse(raw)
    expectEqual(parsed.session.ui.openedFromFile, true, '恢复后再次留存必须保持 openedFromFile=true')
    expectTrue(Array.isArray(parsed.session.budget?.rows) && parsed.session.budget.rows.length === 1, '再次留存费用行数异常')
    const keys = await listStorageKeys(page)
    expectTrue(!keys.includes(SAVED_TRIPS_STORAGE_KEY), `不应写入正式保存键：${JSON.stringify(keys)}`)
    expectEqual(parsed.session.draft, null, '放弃草稿后再次留存 draft 应为 null（合法空值）')
    return { rowTexts, openedFromFileKeptTrue: true, savedTripsKeyAbsent: true }
  })

  await rec.step('关闭清理（场景隔离）：flag 置 0、数据键原样；下载目录留在 ignored artifacts', async () => {
    const rawBefore = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    await page.click('button:has-text("关闭保留（已留存的副本会保留）")')
    await page.waitForFunction(
      (flagKey) => { try { return window.localStorage.getItem(flagKey) !== '1' } catch { return true } },
      SESSION_RESUME_FLAG_KEY,
      { timeout: 10000 },
    )
    const rawAfter = await readStorageRaw(page, SESSION_RESUME_DATA_KEY)
    expectTrue(rawAfter === rawBefore, '关闭保留改动了数据键（应原样）')
    return { closed: true, dataBytes: rawAfter.length }
  })
}

/** v1 信封种子（合法结构，供场景 B/C 直接种子化）：苏州两日 + 草稿 + 费用 0/空/abc + 来源 null */
export function seededResumePayload() {
  return {
    format: 'travel-assistant.session-resume',
    version: 1,
    savedAt: 1793000000000,
    session: {
      trip: {
        id: 'trip-resume-e2e-1',
        source: 'agent',
        title: '留存恢复验证·苏州两日',
        destination: '苏州',
        summary: '用于浏览器恢复验收的两日行程。',
        map_coordinate_system: 'WGS84',
        warnings: ['浏览器验收种子数据，不是真实规划结果。'],
        days: [
          {
            day: 1,
            date: '2026-11-05',
            title: '古城一日',
            summary: '种子行程第一天。',
            stops: [
              { id: 's1', name: '拙政园', time: '09:00', duration_minutes: 120, description: '种子站 1。', address: '苏州市姑苏区东北街178号', location: { lng: 120.6295, lat: 31.3255 } },
              { id: 's2', name: '平江路', time: '13:00', duration_minutes: 90, description: '种子站 2。', address: '苏州市姑苏区平江路', location: { lng: 120.6322, lat: 31.3189 } },
              { id: 's3', name: '定园', time: '15:30', duration_minutes: 60, description: '种子站 3。', address: '苏州市姑苏区', location: { lng: 120.6341, lat: 31.3157 } },
            ],
            legs: [
              { from_stop_id: 's1', to_stop_id: 's2', mode: 'walking', route_type: 'navigation', distance_m: 800, duration_minutes: 12, geometry: [ { lng: 120.6295, lat: 31.3255 }, { lng: 120.6322, lat: 31.3189 } ], description: '种子路线（固定测试值）。' },
              { from_stop_id: 's2', to_stop_id: 's3', mode: 'walking', route_type: 'straight_line', distance_m: 500, duration_minutes: 8, geometry: [ { lng: 120.6322, lat: 31.3189 }, { lng: 120.6341, lat: 31.3157 } ], description: '种子直线示意（固定测试值）。' },
            ],
          },
          {
            day: 2,
            date: '2026-11-06',
            title: '虎丘一日',
            summary: '种子行程第二天。',
            stops: [
              { id: 's4', name: '虎丘', time: '09:30', duration_minutes: 120, description: '种子站 4。', address: '苏州市姑苏区山塘街虎丘山门', location: { lng: 120.5736, lat: 31.3252 } },
            ],
            legs: [],
          },
        ],
      },
      draft: {
        forkTripId: 'fork-resume-e2e-1',
        newLegMode: 'walking',
        editedDays: [
          {
            day: 1,
            days: [
              {
                day: 1,
                date: '2026-11-05',
                title: '古城一日',
                summary: '种子行程第一天（草稿改过第 2 站名）。',
                stops: [
                  { id: 's1', name: '拙政园', time: '09:00', duration_minutes: 120, description: '种子站 1。', address: '苏州市姑苏区东北街178号', location: { lng: 120.6295, lat: 31.3255 } },
                  { id: 's2', name: 'D1 改名站（来自草稿）', time: '13:00', duration_minutes: 90, description: '草稿改名站。', address: '苏州市姑苏区平江路', location: null },
                  { id: 's3', name: '定园', time: '15:30', duration_minutes: 60, description: '种子站 3。', address: '苏州市姑苏区', location: { lng: 120.6341, lat: 31.3157 } },
                ],
                legs: [
                  { from_stop_id: 's1', to_stop_id: 's2', mode: 'walking', route_type: 'unavailable', distance_m: null, duration_minutes: null, geometry: [], description: '本地编辑后待重新获取路线' },
                  { from_stop_id: 's2', to_stop_id: 's3', mode: 'walking', route_type: 'unavailable', distance_m: null, duration_minutes: null, geometry: [], description: '本地编辑后待重新获取路线' },
                ],
              },
            ],
          },
        ],
      },
      budget: {
        binding: { kind: 'current', tripId: 'trip-resume-e2e-1' },
        budgetRaw: '',
        rows: [
          { id: 'r1', category: 'transport', name: '公交（0 元）', amountRaw: '0' },
          { id: 'r2', category: 'food', name: '未填金额项', amountRaw: '' },
          { id: 'r3', category: 'ticket', name: '手滑输入项', amountRaw: 'abc' },
        ],
      },
      ui: { activeDay: 1, draftMode: 'walking', openedFromFile: null },
    },
  }
}

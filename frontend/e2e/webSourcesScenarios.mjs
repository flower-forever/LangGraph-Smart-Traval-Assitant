/**
 * 网页资料（Tavily 搜索摘要）的离线浏览器场景（场景 10–12），从 runner.mjs 编排调用。
 *
 * 模式边界（与 runner 一致）：全部 /api 请求打本进程契约桩，非本机 HTTP 由 runner 的
 * route 门禁截获；本文件只驱动真实 UI 与真实 localStorage，不注入页面业务状态。
 * 网页资料模式（control.webSourcesMode）与迟到 gate（control.webSourcesDelay）由 runner
 * 持有的内存 control 控制，无 HTTP 控制端点；每个场景前后由 runner 复位为默认，防污染。
 *
 * 覆盖边界（如实声明，不假称全覆盖）：
 * - 结果链接只检查 href / target / rel，不实际点击、不抓取任何网页；notes/免责声明
 *   明示契约桩固定测试数据，不冒真实服务。
 * - 「忽略 AbortSignal 的适配器」的迟到落地边界由既有 jsdom 单测覆盖；浏览器场景只
 *   证明真实网络 abort 由桩侧 settled 显式观察到（'aborted'），不冒充浏览器网络 abort
 *   之外的实现证明。
 * - 网页业务失败信封是 HTTP 200（x-web-sources-status 头），不应产生任何 console
 *   资源错误；门禁对网页场景零豁免（503 豁免仍只属于 fail 场景的 plan 证据）。
 *
 * **本批只准备代码：场景尚未实跑，步骤数与断言以实跑后的 report.json 为准。**
 */
import { bizSel } from './sessionResumeScenarios.mjs'

/** runner 传入的 appOrigin（模块顶层可变，与 sessionResumeScenarios 同模式） */
let appOriginFromRunner = null

export function setWebSourcesAppOrigin(origin) {
  appOriginFromRunner = origin
}

/** 网页资料面板选择器（与 WebSourcesPanel / App 当前实现的可访问名对齐） */
export const webSourcesSel = {
  entry: '[data-testid="web-sources-entry"]',
  openEntry: 'button:has-text("查网页资料")',
  panel: '[data-testid="web-sources-panel"]',
  queryInput: '[data-testid="web-sources-panel"] input[type="text"]',
  search: '[data-testid="web-sources-panel"] button:has-text("搜索网页资料")',
  stop: '[data-testid="web-sources-panel"] button:has-text("停止等待")',
  collapse: '[data-testid="web-sources-panel"] button:has-text("收起")',
  result: '[data-testid="web-sources-result"]',
  statusTag: '[data-testid="web-sources-status-tag"]',
  unverified: '[data-testid="web-sources-unverified"]',
  notes: '[data-testid="web-sources-notes"]',
  empty: '[data-testid="web-sources-empty"]',
  error: '[data-testid="web-sources-error"]',
  // W4 改版：.wsp-result-item 退役；结果条是 ol > li（ResultItem），链接在 li 内第一个 a
  resultItems: 'ol > li',
  resultLinks: 'ol > li a',
}

/** W4 改版：标题是行程安排 section 里唯一的 h2（App.tsx TRIP_TITLE） */
const tripTitleSel = 'section[aria-label="行程安排"] h2'

/** 网页搜索请求计数与末条（control.requests 里 path 过滤；body 已是解析后的 JSON） */
export function countWebSearchRequests(control) {
  return control.requests.filter((r) => r.path === '/api/web-sources/search').length
}

export function lastWebSearchRequest(control) {
  const list = control.requests.filter((r) => r.path === '/api/web-sources/search')
  return list[list.length - 1] ?? null
}

/**
 * control.requests 全程累计（跨场景共享同一桩进程）：场景内断言一律用相对增量
 * （场景开始时取基线 baseCount，webCount() 返回本场景内的请求增量），
 * 不假设本场景是首个网页场景。
 */

/** 断言（失败抛错，由 makeStepRecorder.step 记录） */
function expectTrue(condition, message) {
  if (!condition) throw new Error(message)
}

function expectEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}：期望 ${b.slice(0, 200)}，实际 ${a.slice(0, 200)}`)
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

/** settled 生命周期（'responded' | 'aborted'）显式定序；超时返回 'timeout'，不固定 sleep 正向同步 */
function settledOf(request, timeoutMs = 5000) {
  return Promise.race([
    request.settled,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), timeoutMs)),
  ])
}

/** 有界等桩侧证据（gate 挂起 / responses 记录出现）：沿用 runner 场景 3 的显式定序模式 */
async function waitForCondition(poll, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!poll() && Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 50))
  }
  return poll()
}

async function assertNoHorizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
}

/** 打开首页加载契约桩示例行程（fresh context 默认 off：存储零键） */
async function openAppWithExampleTrip(page) {
  await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector(tripTitleSel, { timeout: 15000 })
  const title = (await page.textContent(tripTitleSel)) ?? ''
  expectTrue(title.includes('契约桩示例'), `首屏不是契约桩示例行程：${title}`)
  return title
}

/** 预填费用 77.25 并计算后收起：给「搜索不改费用」一个可重开核对的基准 */
async function prefillBudgetBaseline(page) {
  await page.click(bizSel.openBudget)
  await page.waitForSelector(bizSel.budgetPanel, { timeout: 5000 })
  await page.click(bizSel.addBudgetRow)
  await page.fill(
    `${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=0 >> input[placeholder="例如 高铁票"]`,
    '门票（网页资料基准）',
  )
  await page.fill(
    `${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=0 >> input[placeholder="0 也算一项"]`,
    '77.25',
  )
  await page.click(`${bizSel.budgetPanel} button:has-text("计算已填费用")`)
  await page.waitForSelector(bizSel.budgetKnownTotal, { timeout: 5000 })
  const totalText = ((await page.textContent(bizSel.budgetKnownTotal)) ?? '').trim()
  expectTrue(totalText.startsWith('77.25'), `费用合计期望 77.25 开头，实际「${totalText}」`)
  await page.click(`${bizSel.budgetPanel} button:has-text("收起")`)
  await page.waitForSelector(bizSel.budgetPanel, { state: 'detached', timeout: 5000 })
  return totalText
}

/** 重开费用面板核对原字符串仍在并重新计算（不假设面板自动重算） */
async function assertBudgetBaselinePreserved(page) {
  await page.click(bizSel.openBudget)
  await page.waitForSelector(bizSel.budgetPanel, { timeout: 5000 })
  const amount = await page.inputValue(
    `${bizSel.budgetPanel} ${bizSel.budgetRow} >> nth=0 >> input[placeholder="0 也算一项"]`,
  )
  expectEqual(amount, '77.25', '费用原字符串被改动')
  await page.click(`${bizSel.budgetPanel} button:has-text("计算已填费用")`)
  await page.waitForSelector(bizSel.budgetKnownTotal, { timeout: 5000 })
  const totalText = ((await page.textContent(bizSel.budgetKnownTotal)) ?? '').trim()
  expectTrue(totalText.startsWith('77.25'), `重算合计期望 77.25 开头，实际「${totalText}」`)
  await page.click(`${bizSel.budgetPanel} button:has-text("收起")`)
  await page.waitForSelector(bizSel.budgetPanel, { state: 'detached', timeout: 5000 })
  return { amount, totalText }
}

async function assertStorageUntouched(page) {
  const keys = await page.evaluate(() => Object.keys(window.localStorage))
  expectEqual(keys, [], '网页资料流程不应写任何 localStorage 键')
  return keys
}

/**
 * 场景 10（webMain，桌面 1440）：真实 UI 打开零请求 → FEFF 中文 query 显式恰好一次
 * POST（body 仅规范化 query，FEFF 原样保留）→ available 结果安全展示（纯文本摘录/
 * https 链接只查 href/出处日期与未知/checked-fetched 时间/未核实与测试数据免责声明）
 * → 搜索不写 Trip/费用/localStorage（重开费用 77.25 原字符串仍在）→ 收起重开为全新实例。
 */
export async function runWebSourcesMainScenario({ page, rec, control, screenshot }) {
  const QUERY_RAW = '\uFEFF西湖 断桥\uFEFF'
  /** 场景开始时的累计基线：断言用相对增量（requests 跨场景共享同一桩进程） */
  const baseCount = countWebSearchRequests(control)

  await rec.step('打开首页（fresh context）加载示例行程', async () => {
    const title = await openAppWithExampleTrip(page)
    expectEqual(countWebSearchRequests(control) - baseCount, 0, '首页加载不应发网页搜索请求')
    return { title, storageKeys: await assertStorageUntouched(page) }
  })

  await rec.step('网页资料入口默认收起、打开面板零请求', async () => {
    await page.waitForSelector(webSourcesSel.entry, { timeout: 10000 })
    expectEqual(await page.locator(webSourcesSel.panel).count(), 0, '默认不应有面板')
    await page.click(webSourcesSel.openEntry)
    await page.waitForSelector(webSourcesSel.panel, { timeout: 5000 })
    expectEqual(countWebSearchRequests(control) - baseCount, 0, '打开面板不应发请求')
    expectEqual(await page.locator('label:has-text("网页搜索内容")').count(), 1, '缺查询输入 label')
    expectEqual(await page.locator(webSourcesSel.search).count(), 1, '缺显式搜索按钮')
    expectEqual(countWebSearchRequests(control) - baseCount, 0, '面板打开后仍应零请求')
    return { panelOpened: true }
  })
  await screenshot(page, '24-web-open.png')

  await rec.step('预填费用 77.25 并计算，收起费用面板（搜索前的可核对基准）', async () => {
    const totalText = await prefillBudgetBaseline(page)
    expectEqual(countWebSearchRequests(control) - baseCount, 0, '费用流程不应发网页搜索请求')
    return { totalText }
  })

  await rec.step('输入 FEFF 包裹中文 query，显式搜索恰好一次 POST，body 仅规范化 query（FEFF 原样保留）', async () => {
    await page.fill(webSourcesSel.queryInput, QUERY_RAW)
    await page.click(webSourcesSel.search)
    await page.waitForSelector(webSourcesSel.result, { timeout: 15000 })
    expectEqual(countWebSearchRequests(control) - baseCount, 1, '应恰好一次网页搜索请求')
    const request = lastWebSearchRequest(control)
    expectEqual(request.path, '/api/web-sources/search', '请求路径异常')
    expectEqual(request.method, 'POST', '应为 POST')
    expectTrue(request.body !== undefined && typeof request.body === 'object', 'body 应为 JSON 对象')
    expectEqual(Object.keys(request.body), ['query'], 'body 只允许 query 键')
    expectEqual(request.body.query, QUERY_RAW, 'FEFF 是合法正文：Python strip 口径不剥离，应原样入 body')
    const settled = await settledOf(request)
    expectEqual(settled, 'responded', '请求应在桩侧正常响应')
    return { body: request.body, settled }
  })

  await rec.step('available 结果安全展示：状态/未核实/纯文本摘录/https 链接只查 href/出处日期与未知/时间/免责声明', async () => {
    expectEqual(await page.getAttribute(webSourcesSel.result, 'data-status'), 'available', '结果状态异常')
    expectEqual(((await page.textContent(webSourcesSel.statusTag)) ?? '').trim(), '已返回', '状态标签异常')
    expectEqual(await page.locator(webSourcesSel.unverified).count(), 1, '缺未核实声明')
    expectEqual(await page.locator(webSourcesSel.resultItems).count(), 2, '契约桩 available 应有 2 条结果')
    // 只读属性核对，不点击任何链接
    const links = await page.$$eval(webSourcesSel.resultLinks, (nodes) =>
      nodes.map((a) => ({
        href: a.getAttribute('href'),
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel'),
      })),
    )
    expectEqual(links.length, 2, '结果链接数异常')
    for (const link of links) {
      expectTrue((link.href ?? '').startsWith('https://'), `结果链接必须 https：${link.href}`)
      expectEqual(link.target, '_blank', '结果链接应新窗口打开')
      expectTrue(
        (link.rel ?? '').includes('noopener') && (link.rel ?? '').includes('noreferrer'),
        `结果链接 rel 应含 noopener noreferrer：${link.rel}`,
      )
    }
    expectTrue(links.some((l) => l.href === 'https://www.westlake.com.cn/'), '缺契约桩官网条目链接')
    expectTrue(links.some((l) => l.href === 'https://www.example-travel.com/xihu-guide'), '缺契约桩攻略条目链接')
    // 纯文本摘录：结果容器不允许出现脚本/内嵌资源元素
    const dangerous = await page.locator(
      `${webSourcesSel.result} script, ${webSourcesSel.result} iframe, ${webSourcesSel.result} img, ${webSourcesSel.result} style`,
    ).count()
    expectEqual(dangerous, 0, '结果容器出现非纯文本元素')
    const resultText = (await page.textContent(webSourcesSel.result)) ?? ''
    expectTrue(resultText.includes('网页发布日期：2025-06-01'), '缺真实出处日期')
    expectTrue(resultText.includes('网页发布日期：未知（来源未提供）'), '缺缺失日期的「未知」展示')
    expectTrue(resultText.includes('查询发起时间') && resultText.includes('本次获取时间'), '缺 checked/fetched 时间')
    expectTrue(resultText.includes(QUERY_RAW), '实发查询应显示 FEFF 原文')
    expectTrue(resultText.includes('2 条'), '缺上游返回条目数')
    const notesText = (await page.textContent(webSourcesSel.notes)) ?? ''
    expectTrue(notesText.includes('测试') && notesText.includes('契约桩'), '缺契约桩测试数据免责声明')
    expectEqual(await page.getAttribute(webSourcesSel.panel, 'aria-busy'), null, '结果到达后不应保持等待态')
    return { links }
  })
  await screenshot(page, '25-web-available.png')

  await rec.step('搜索不写 Trip/费用/localStorage：行程标题不变、重开费用 77.25 原字符串仍在、存储零键', async () => {
    const title = (await page.textContent(tripTitleSel)) ?? ''
    expectTrue(title.includes('契约桩示例'), `搜索后行程标题被改动：${title}`)
    await assertStorageUntouched(page)
    const budget = await assertBudgetBaselinePreserved(page)
    return { title, ...budget }
  })

  await rec.step('收起后重开：全新实例（空输入、无旧结果、零新请求）', async () => {
    await page.click(webSourcesSel.collapse)
    await page.waitForSelector(webSourcesSel.panel, { state: 'detached', timeout: 5000 })
    await page.waitForSelector(webSourcesSel.entry, { timeout: 5000 })
    expectEqual(countWebSearchRequests(control) - baseCount, 1, '收起不应发请求')
    await page.click(webSourcesSel.openEntry)
    await page.waitForSelector(webSourcesSel.panel, { timeout: 5000 })
    expectEqual(await page.inputValue(webSourcesSel.queryInput), '', '重开后输入应清空')
    expectEqual(await page.locator(webSourcesSel.result).count(), 0, '重开不应展示旧结果')
    expectEqual(countWebSearchRequests(control) - baseCount, 1, '重开不应重发前次 query')
    await assertStorageUntouched(page)
    return { reopened: true }
  })
}

/**
 * 场景 11（webFailure，桌面 1440，同 context）：业务失败四态各用实际 mode 明示
 * （no_results / no_usable_results / no_key / unavailable），失败清当前结果、
 * Trip/费用/localStorage 保旧；每次点击恰好一请求，无隐式重试（HTTP 200 信封，
 * 不产生 console 资源错误）。
 */
export async function runWebSourcesFailureModesScenario({ page, rec, control, screenshot }) {
  const QUERY_1 = '西湖 安全检查'
  const QUERY_2 = '西湖 不可展示'
  /** 场景开始时的累计基线：断言用相对增量（requests 跨场景共享同一桩进程） */
  const baseCount = countWebSearchRequests(control)

  await rec.step('打开首页加载示例；预填费用 77.25 计算后收起；打开面板零请求', async () => {
    await openAppWithExampleTrip(page)
    await prefillBudgetBaseline(page)
    await page.waitForSelector(webSourcesSel.entry, { timeout: 10000 })
    await page.click(webSourcesSel.openEntry)
    await page.waitForSelector(webSourcesSel.panel, { timeout: 5000 })
    expectEqual(countWebSearchRequests(control) - baseCount, 0, '打开面板不应发请求')
    return { ready: true }
  })

  await rec.step('no_results：一次点击恰一请求，明示「没有搜索结果」且不写行程', async () => {
    control.webSourcesMode = 'no_results'
    await page.fill(webSourcesSel.queryInput, QUERY_1)
    await page.click(webSourcesSel.search)
    await page.waitForSelector(webSourcesSel.result, { timeout: 15000 })
    expectEqual(await page.getAttribute(webSourcesSel.result, 'data-status'), 'no_results', '结果状态异常')
    expectEqual(((await page.textContent(webSourcesSel.statusTag)) ?? '').trim(), '没有搜索结果', '状态标签异常')
    const emptyText = (await page.textContent(webSourcesSel.empty)) ?? ''
    expectTrue(emptyText.includes('不代表该地点不存在'), '缺「无结果不等于地点不存在」声明')
    expectEqual(await page.locator(webSourcesSel.resultItems).count(), 0, '无结果态不应有条目列表')
    expectEqual(countWebSearchRequests(control) - baseCount, 1, '应恰好一次请求（无隐式重试）')
    const request = lastWebSearchRequest(control)
    expectEqual(request.body, { query: QUERY_1 }, 'body 应仅规范化 query')
    expectEqual(await settledOf(request), 'responded', '业务失败信封应正常响应')
    const title = (await page.textContent(tripTitleSel)) ?? ''
    expectTrue(title.includes('契约桩示例'), `行程标题被改动：${title}`)
    return { status: 'no_results', body: request.body }
  })

  await rec.step('no_usable_results：明示「结果无法安全展示」（取得 3 条全部未过安全检查），旧结果被清除', async () => {
    control.webSourcesMode = 'no_usable_results'
    await page.fill(webSourcesSel.queryInput, QUERY_2)
    await page.click(webSourcesSel.search)
    await page.waitForSelector(webSourcesSel.result, { timeout: 15000 })
    expectEqual(await page.getAttribute(webSourcesSel.result, 'data-status'), 'no_usable_results', '旧结果未被清除')
    expectEqual(((await page.textContent(webSourcesSel.statusTag)) ?? '').trim(), '结果无法安全展示', '状态标签异常')
    const emptyText = (await page.textContent(webSourcesSel.empty)) ?? ''
    expectTrue(emptyText.includes('上游返回了 3 条'), '缺取得条数说明')
    expectTrue(emptyText.includes('全部未通过安全链接检查'), '缺安全过滤说明')
    expectTrue(emptyText.includes('不代表该地点不存在'), '缺「过滤失败不等于无结果」声明')
    expectEqual(await page.locator(webSourcesSel.resultItems).count(), 0, '不可展示态不应有条目列表')
    expectEqual(countWebSearchRequests(control) - baseCount, 2, '应恰好一次新请求（无隐式重试）')
    const request = lastWebSearchRequest(control)
    expectEqual(request.body, { query: QUERY_2 }, 'body 应仅规范化 query')
    return { status: 'no_usable_results' }
  })

  await rec.step('no_key：明示「未配置搜索 Key」，清当前结果、Trip/费用/存储保旧', async () => {
    control.webSourcesMode = 'no_key'
    await page.click(webSourcesSel.search)
    await page.waitForSelector(webSourcesSel.result, { timeout: 15000 })
    expectEqual(await page.getAttribute(webSourcesSel.result, 'data-status'), 'no_key', '结果状态异常')
    expectEqual(((await page.textContent(webSourcesSel.statusTag)) ?? '').trim(), '未配置搜索 Key', '状态标签异常')
    const emptyText = (await page.textContent(webSourcesSel.empty)) ?? ''
    expectTrue(emptyText.includes('服务端没有配置搜索 Key'), '缺 no_key 固定文案')
    expectTrue(!emptyText.includes('tvly') && !emptyText.includes('未配置搜索服务 Key，网页资料搜索不可用'), '不应回显上游 reason 原文')
    expectEqual(countWebSearchRequests(control) - baseCount, 3, '应恰好一次新请求（无隐式重试）')
    const title = (await page.textContent(tripTitleSel)) ?? ''
    expectTrue(title.includes('契约桩示例'), `行程标题被改动：${title}`)
    await assertStorageUntouched(page)
    return { status: 'no_key' }
  })
  await screenshot(page, '26-web-failure-modes.png')

  await rec.step('unavailable：明示「搜索服务不可用」；恢复默认 mode；重开费用 77.25 原字符串仍在、存储全程零键', async () => {
    control.webSourcesMode = 'unavailable'
    await page.click(webSourcesSel.search)
    await page.waitForSelector(webSourcesSel.result, { timeout: 15000 })
    expectEqual(await page.getAttribute(webSourcesSel.result, 'data-status'), 'unavailable', '结果状态异常')
    expectEqual(((await page.textContent(webSourcesSel.statusTag)) ?? '').trim(), '搜索服务不可用', '状态标签异常')
    const emptyText = (await page.textContent(webSourcesSel.empty)) ?? ''
    expectTrue(emptyText.includes('搜索服务暂时不可用'), '缺 unavailable 固定文案')
    expectEqual(countWebSearchRequests(control) - baseCount, 4, '应恰好一次新请求（无隐式重试）')
    control.webSourcesMode = null
    await page.click(webSourcesSel.collapse)
    await page.waitForSelector(webSourcesSel.panel, { state: 'detached', timeout: 5000 })
    const title = (await page.textContent(tripTitleSel)) ?? ''
    expectTrue(title.includes('契约桩示例'), `行程标题被改动：${title}`)
    const budget = await assertBudgetBaselinePreserved(page)
    await assertStorageUntouched(page)
    return { status: 'unavailable', ...budget }
  })
}

/**
 * 场景 12（webLate，桌面 1440 → 390 窄屏）：迟到 gate 挂起有 pendingCount 证据 →
 * 停止等待/收起两条停止路径桩侧均显式观察到 aborted → release 迟到响应不复活 →
 * 重开全新实例后默认 mode 显式搜索成功 → 390 窄屏查询渲染无横向溢出、控件可操作。
 */
export async function runWebSourcesLateAndNarrowScenario({ page, rec, control, screenshot }) {
  const LATE_QUERY = '西湖 迟到'
  const NARROW_QUERY = '西湖 窄屏'
  /** 场景开始时的累计基线：断言用相对增量（requests 跨场景共享同一桩进程） */
  const baseCount = countWebSearchRequests(control)

  await rec.step('打开首页加载示例，打开网页资料面板', async () => {
    await openAppWithExampleTrip(page)
    await page.waitForSelector(webSourcesSel.entry, { timeout: 10000 })
    await page.click(webSourcesSel.openEntry)
    await page.waitForSelector(webSourcesSel.panel, { timeout: 5000 })
    expectEqual(countWebSearchRequests(control) - baseCount, 0, '打开面板不应发请求')
    return { ready: true }
  })

  await rec.step('gate 挂起 → 显式搜索 → 桩侧 pending≥1 显式证据（面板等待态）', async () => {
    control.webSourcesDelay = createGate()
    await page.fill(webSourcesSel.queryInput, LATE_QUERY)
    await page.click(webSourcesSel.search)
    await page.waitForSelector(webSourcesSel.stop, { timeout: 10000 })
    expectEqual(await page.getAttribute(webSourcesSel.panel, 'aria-busy'), 'true', '等待态 aria-busy 应为 true')
    const observed = await waitForCondition(() => control.webSourcesDelay.pendingCount() >= 1)
    expectTrue(observed, '请求未在桩侧挂起')
    const request = lastWebSearchRequest(control)
    expectEqual(request.body, { query: LATE_QUERY }, 'body 应仅规范化 query')
    expectEqual(countWebSearchRequests(control) - baseCount, 1, '应恰好一次请求')
    return { pendingAtGate: control.webSourcesDelay.pendingCount(), seq: request.seq }
  })

  await rec.step('停止等待：桩侧显式观察到连接 abort；release 迟到响应不落地（固定安全文案、无结果）', async () => {
    const request = lastWebSearchRequest(control)
    await page.click(webSourcesSel.stop)
    const settled = await settledOf(request)
    expectTrue(settled === 'aborted', `停止等待后桩侧应观察到连接断开（abort 生效），实际：${settled}`)
    control.webSourcesDelay.release()
    control.webSourcesDelay = null
    // 迟到响应确实被桩侧写出（responses 出现该 seq）之后，UI 仍不得出现结果
    const writtenOut = await waitForCondition(() => control.responses.some((r) => r.seq === request.seq))
    expectTrue(writtenOut, '迟到响应未在桩侧完成写出（release 未生效）')
    await page.waitForSelector(webSourcesSel.error, { timeout: 5000 })
    const errorText = (await page.textContent(webSourcesSel.error)) ?? ''
    expectTrue(errorText.includes('已停止等待'), `缺停止等待固定文案：${errorText}`)
    expectEqual(await page.locator(webSourcesSel.result).count(), 0, '迟到响应落地复活了结果')
    expectEqual(countWebSearchRequests(control) - baseCount, 1, '不得隐式重试')
    const title = (await page.textContent(tripTitleSel)) ?? ''
    expectTrue(title.includes('契约桩示例'), `行程标题被改动：${title}`)
    return { settled }
  })

  await rec.step('再次 gate 挂起 → 显式搜索 → 用「收起」结束等待：桩侧 abort 证据、release 不复活', async () => {
    control.webSourcesDelay = createGate()
    await page.click(webSourcesSel.search)
    await page.waitForSelector(webSourcesSel.stop, { timeout: 10000 })
    const observed = await waitForCondition(() => control.webSourcesDelay.pendingCount() >= 1)
    expectTrue(observed, '第二次请求未在桩侧挂起')
    expectEqual(countWebSearchRequests(control) - baseCount, 2, '应恰好一次新请求')
    const request = lastWebSearchRequest(control)
    await page.click(webSourcesSel.collapse)
    await page.waitForSelector(webSourcesSel.panel, { state: 'detached', timeout: 5000 })
    const settled = await settledOf(request)
    expectTrue(settled === 'aborted', `收起后桩侧应观察到连接断开，实际：${settled}`)
    control.webSourcesDelay.release()
    control.webSourcesDelay = null
    const writtenOut = await waitForCondition(() => control.responses.some((r) => r.seq === request.seq))
    expectTrue(writtenOut, '迟到响应未在桩侧完成写出（release 未生效）')
    await page.waitForSelector(webSourcesSel.entry, { timeout: 5000 })
    expectEqual(await page.locator(webSourcesSel.panel).count(), 0, '收起后面板不应存在')
    return { settled }
  })
  await screenshot(page, '27-web-late-no-revival.png')

  await rec.step('重开面板为全新实例；恢复默认后显式搜索成功 available（迟到链路后仍可正常查询）', async () => {
    await page.click(webSourcesSel.openEntry)
    await page.waitForSelector(webSourcesSel.panel, { timeout: 5000 })
    expectEqual(await page.inputValue(webSourcesSel.queryInput), '', '重开后输入应清空')
    expectEqual(await page.locator(webSourcesSel.result).count(), 0, '重开不应展示旧结果')
    expectEqual(countWebSearchRequests(control) - baseCount, 2, '重开不应重发前次 query')
    await page.fill(webSourcesSel.queryInput, LATE_QUERY)
    await page.click(webSourcesSel.search)
    await page.waitForSelector(webSourcesSel.result, { timeout: 15000 })
    expectEqual(await page.getAttribute(webSourcesSel.result, 'data-status'), 'available', '恢复默认后应成功返回')
    expectEqual(countWebSearchRequests(control) - baseCount, 3, '应恰好一次新请求')
    await page.click(webSourcesSel.collapse)
    await page.waitForSelector(webSourcesSel.panel, { state: 'detached', timeout: 5000 })
    await assertStorageUntouched(page)
    return { finalStatus: 'available' }
  })

  await rec.step('390 窄屏：面板查询渲染无横向溢出、控件可操作、安全链接仅查 href', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForSelector(webSourcesSel.entry, { timeout: 5000 })
    await page.click(webSourcesSel.openEntry)
    await page.waitForSelector(webSourcesSel.panel, { timeout: 5000 })
    await page.fill(webSourcesSel.queryInput, NARROW_QUERY)
    await page.click(webSourcesSel.search)
    await page.waitForSelector(webSourcesSel.result, { timeout: 15000 })
    expectEqual(await page.getAttribute(webSourcesSel.result, 'data-status'), 'available', '窄屏结果状态异常')
    expectEqual(countWebSearchRequests(control) - baseCount, 4, '窄屏应恰好一次新请求')
    const overflow = await assertNoHorizontalOverflow(page)
    expectTrue(!overflow, '390 窄屏出现横向溢出')
    const links = await page.$$eval(webSourcesSel.resultLinks, (nodes) =>
      nodes.map((a) => a.getAttribute('href')),
    )
    expectTrue(links.length === 2 && links.every((href) => (href ?? '').startsWith('https://')), `窄屏结果链接异常：${JSON.stringify(links)}`)
    expectTrue(await page.locator(webSourcesSel.collapse).isVisible(), '窄屏下收起按钮不可见')
    // 视觉证据：结果展开态留档（收起之前）。窄屏视口 844 高装不下完整结果卡，
    // 用真实 DOM locator 把结果滚入视野再拍——仅视觉动作，不改任何断言/样式/状态；
    // 下方原 28 仍拍收起后状态
    await page.locator(webSourcesSel.result).scrollIntoViewIfNeeded()
    await screenshot(page, '28-narrow-web-open.png')
    await page.click(webSourcesSel.collapse)
    await page.waitForSelector(webSourcesSel.panel, { state: 'detached', timeout: 5000 })
    await page.waitForSelector(webSourcesSel.entry, { timeout: 5000 })
    const overflowAfter = await assertNoHorizontalOverflow(page)
    expectTrue(!overflowAfter, '窄屏收起后出现横向溢出')
    await assertStorageUntouched(page)
    return { links, viewport: '390x844' }
  })
  await screenshot(page, '28-narrow-web.png')
}

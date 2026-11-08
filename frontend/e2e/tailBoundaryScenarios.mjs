/**
 * 后段衔接路线（/api/trips/days/leg-refresh）的离线浏览器场景（场景 13–17），
 * 从 runner.mjs 编排调用。
 *
 * 模式边界（与 runner 一致）：全部 /api 请求打本进程契约桩，非本机 HTTP 由 runner 的
 * route 门禁截获；本文件只驱动真实 UI 与真实 localStorage，不注入页面业务状态，
 * 不用纯模块快照替代真实用户点击闭环。衔接路线模式（control.legRefreshMode）与
 * 迟到 gate（control.legRefreshDelay）由 runner 持有的内存 control 控制，无 HTTP
 * 控制端点；每个场景前后由 runner 复位为默认，防污染。
 *
 * 后段候选识别：契约桩按 request.instruction 以「【后段重规划】」开头返回专用尾段
 * 候选（ai-tail-e2e-1 13:00 / ai-tail-e2e-2 15:00，首站时刻晚于锚点 s-e2e-2 的冻结
 * 下界 11:10，不会 time_conflict）；整日请求原样走既有 replanDay fixture。
 *
 * 覆盖边界（如实声明，不假称全覆盖）：
 * - 「显式查询恰好一次」用 control.requests 里 /api/trips/days/leg-refresh 的相对
 *   增量断言（requests 跨场景共享同一桩进程）；「打开候选不自动查询」用同一增量。
 * - 迟到/停止等待的证明与 webSources 场景同口径：桩侧 settled 显式观察到 'aborted'，
 *   release 后响应在桩侧写出（responses 出现该 seq）但 UI 不得复活；「忽略 AbortSignal
 *   的适配器」迟到落地边界由 jsdom 单测覆盖，浏览器不另行构造。
 * - 距离/耗时/来源展示文案与「应用后段与衔接路线」等按钮文字为任务书期望文案；
 *   UI 落地后若最终用词不同，只需改本文件底部 tailSel/tailText 常量（已集中声明）。
 * - **本批只准备代码：场景尚未实跑（UI 门未过），步骤数与断言以实跑后的 report.json 为准。**
 */
import { bizSel, expectEqual, expectTrue } from './sessionResumeScenarios.mjs'

/** runner 传入的 appOrigin（模块顶层可变，与 sessionResumeScenarios 同模式） */
let appOriginFromRunner = null

export function setTailBoundaryAppOrigin(origin) {
  appOriginFromRunner = origin
}

/**
 * 后段衔接路线面板选择器：与已提交基线（277e396）DayReplanPanel/App 的可访问名对齐；
 * 衔接路线按钮/文案为任务书期望文案（G Wave 3 在途，落地后集中在这里适配）。
 */
export const tailSel = {
  aiPanel: '[aria-label="AI 调整单日安排"]',
  aiInstruction: '[aria-label="AI 调整单日安排"] textarea',
  generateCandidate: 'button:has-text("生成调整候选")',
  /** 调整范围：某站之后（后段模式）单选（已提交基线即有） */
  tailRangeRadio: '[aria-label="AI 调整单日安排"] input[type="radio"][name="drp-range"][value="tail"]',
  /** 锚点选择 select：option value 即站点 id（已提交基线即有） */
  anchorSelect: '[aria-label="AI 调整单日安排"] select',
  candidatePreview: '[aria-label="候选预览"]',
  /** 以下为衔接路线新控件（期望文案，G 落地后适配） */
  queryBoundary: 'button:has-text("获取衔接路线")',
  stopBoundary: 'button:has-text("停止等待衔接路线")',
  discardBoundary: 'button:has-text("舍弃衔接路线")',
  applyTailWithRoute: 'button:has-text("应用后段与衔接路线")',
  applyTailUnknown: 'button:has-text("仅应用后段（衔接未知）")',
}

/** 期望文案集中声明（G Wave 3 最终落地后只改这里） */
export const tailText = {
  /** 采用导航后的 App appliedNotice 不再说「未重算」；原未知文案含「锚点衔接路线未重算」 */
  unknownNoticeFragment: '锚点衔接路线未重算',
  /** 来源说明（预览里应可见） */
  routeSourceFragment: '高德地图',
  routeCoordinateFragment: 'WGS84',
  routeIdentityFragment: '未重新核对',
  /** 停止等待后的固定反馈 */
  stopBoundaryFeedbackFragment: '已停止等待衔接路线',
}

/** W4 改版：标题是行程安排 section 里唯一的 h2（App.tsx TRIP_TITLE） */
const tripTitleSel = 'section[aria-label="行程安排"] h2'
const applyNoticeSel = '[data-testid="apply-notice"]'
const undoApplyButtonSel = 'button:has-text("撤销应用")'
const LEG_REFRESH_PATH = '/api/trips/days/leg-refresh'

/** 衔接路线请求计数与末条（control.requests 里 path 过滤；body 已是解析后的 JSON） */
export function countLegRefreshRequests(control) {
  return control.requests.filter((r) => r.path === LEG_REFRESH_PATH).length
}

export function lastLegRefreshRequest(control) {
  const list = control.requests.filter((r) => r.path === LEG_REFRESH_PATH)
  return list[list.length - 1] ?? null
}

/**
 * control.requests 全程累计（跨场景共享同一桩进程）：场景内断言一律用相对增量
 * （场景开始时取基线 baseCount，legCount() 返回本场景内的请求增量）。
 */

/** deferred gate（与 runner.mjs 的 createGate 同构）：挂起契约桩响应以制造停止等待 */
function createGate() {
  const gate = { waiters: [] }
  gate.pendingCount = () => gate.waiters.length
  gate.release = () => {
    for (const resolveWaiter of gate.waiters.splice(0)) resolveWaiter()
  }
  return gate
}

/** settled 生命周期（'responded' | 'aborted'）显式定序；超时返回 'timeout' */
function settledOf(request, timeoutMs = 5000) {
  return Promise.race([
    request.settled,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), timeoutMs)),
  ])
}

/** 有界等桩侧证据（gate 挂起 / responses 记录出现）：沿用既有场景的显式定序模式 */
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

/** 打开 AI 面板、切后段模式、选锚点 s-e2e-2、填指令、生成候选（真实用户点击闭环） */
async function generateTailCandidate(page, instruction) {
  await page.click('button:has-text("AI 调整这一天")')
  await page.waitForSelector(tailSel.aiPanel, { timeout: 5000 })
  await page.check(tailSel.tailRangeRadio)
  await page.waitForSelector(tailSel.anchorSelect, { timeout: 5000 })
  // 锚点 s-e2e-2（曲院风荷，第 2 站）：option value 即站点 id
  await page.selectOption(tailSel.anchorSelect, 's-e2e-2')
  await page.fill(tailSel.aiInstruction, instruction)
  await page.click(tailSel.generateCandidate)
  await page.waitForSelector(tailSel.candidatePreview, { timeout: 15000 })
}

/**
 * 场景 13（tailReady，桌面 1440）：后段候选零衔接请求 → 显式获取恰好 1 POST
 * （body 固定两原 WGS84 端点 + scope mode、无地址字段）→ 预览显示距离/耗时/高德
 * WGS84/未核对身份 → 不改 Trip/保存/费用 → 显式应用后目标日后段跨界 navigation、
 * 前缀与其他天不变、App notice 不再说当次未重算 → 一次 undo 整体恢复原 Trip。
 */
export async function runTailBoundaryReadyScenario({ page, rec, control, screenshot }) {
  const baseCount = countLegRefreshRequests(control)
  /** 载入时的行程标题（查询/应用前的真实基线，用于证明查询不改 Trip） */
  let loadedTitle = ''

  await rec.step('打开首页加载示例行程；后段候选生成阶段零衔接路线请求', async () => {
    loadedTitle = await openAppWithExampleTrip(page)
    await generateTailCandidate(page, '换成安静一点的地方')
    const previewText = (await page.textContent(tailSel.candidatePreview)) ?? ''
    expectTrue(previewText.includes('杭州花圃'), '后段候选预览缺少专用候选首站（杭州花圃）')
    expectEqual(countLegRefreshRequests(control) - baseCount, 0, '生成候选/渲染预览不应发衔接路线请求')
    return { previewText: previewText.slice(0, 120) }
  })
  await screenshot(page, '30-tail-candidate.png')

  await rec.step('显式获取衔接路线：恰好 1 次 POST，body 固定两端点与 mode、无地址', async () => {
    await page.click(tailSel.queryBoundary)
    await page.waitForSelector(tailSel.applyTailWithRoute, { timeout: 15000 })
    expectEqual(countLegRefreshRequests(control) - baseCount, 1, '应恰好一次衔接路线请求（不自动重试）')
    const request = lastLegRefreshRequest(control)
    expectEqual(request.path, LEG_REFRESH_PATH, '请求路径异常')
    expectEqual(request.method, 'POST', '应为 POST')
    const body = request.body
    expectTrue(body && typeof body === 'object', 'body 应为 JSON 对象')
    // 严格白名单六字段；地址/名称/几何绝不进入请求
    expectEqual(
      Object.keys(body).sort(),
      ['date', 'day', 'from_stop', 'parent', 'to_stop', 'travel_mode'],
      '请求字段超出白名单',
    )
    // 载入示例行程后 App 的行程版本号为 1（每次写入当前行程 +1），父令牌必须与
    // 生成候选时的当前版本一致；此断言锁定「父令牌 = 当时真实版本」，不是改语义。
    expectEqual(body.parent, { trip_id: 'trip-e2e-plan-1', revision: 1 }, 'parent 令牌异常')
    expectEqual(body.day, 1, '目标日异常')
    expectEqual(body.date, '2026-11-07', '日期异常')
    expectEqual(body.travel_mode, 'walking', 'travel_mode 应取 scope 模式（walking）')
    // 锚点 s-e2e-2 与候选首站 ai-tail-e2e-1 的原 WGS84 坐标（contractFixtures/尾段 fixture 固定值）
    expectEqual(body.from_stop, { id: 's-e2e-2', location: { lng: 120.141, lat: 30.261 } }, '起点端点异常')
    expectEqual(body.to_stop, { id: 'ai-tail-e2e-1', location: { lng: 120.1264, lat: 30.2412 } }, '终点端点异常')
    const bodyText = JSON.stringify(body)
    expectTrue(!bodyText.includes('address') && !bodyText.includes('name'), '请求不得携带地址或名称')
    const settled = await settledOf(request)
    expectEqual(settled, 'responded', '请求应在桩侧正常响应')
    return { body, settled }
  })
  await screenshot(page, '31-tail-route-ready.png')

  await rec.step('组合预览显示距离/耗时/来源（高德 WGS84）与未核对身份说明；点击本身不产生新请求', async () => {
    expectEqual(countLegRefreshRequests(control) - baseCount, 1, '渲染预览不应产生新请求')
    const previewText = (await page.textContent(tailSel.candidatePreview)) ?? ''
    expectTrue(previewText.includes('2850'), '预览缺固定距离 2850m')
    expectTrue(previewText.includes('41'), '预览缺固定耗时 41 分钟')
    expectTrue(previewText.includes(tailText.routeSourceFragment), '预览缺来源（高德地图）说明')
    expectTrue(previewText.includes(tailText.routeCoordinateFragment), '预览缺 WGS84 坐标系说明')
    expectTrue(previewText.includes(tailText.routeIdentityFragment), '预览缺「未重新核对地点身份」说明')
    return { previewText: previewText.slice(0, 200) }
  })

  await rec.step('查询不改 Trip/保存/费用：标题不变、存储零键', async () => {
    const title = (await page.textContent(tripTitleSel)) ?? ''
    expectEqual(title, loadedTitle, `查询后行程标题被改动：${title}`)
    const storageKeys = await page.evaluate(() => Object.keys(window.localStorage))
    expectEqual(storageKeys, [], '衔接路线查询不应写任何 localStorage 键')
    return { storageKeys, title }
  })

  await rec.step('显式「应用后段与衔接路线」：面板关闭、目标日后段含 navigation 跨界、notice 不再说当次未重算', async () => {
    await page.click(tailSel.applyTailWithRoute)
    await page.waitForSelector(tailSel.aiPanel, { state: 'detached', timeout: 5000 })
    await page.waitForSelector(applyNoticeSel, { timeout: 5000 })
    const notice = (await page.textContent(applyNoticeSel)) ?? ''
    expectTrue(
      !notice.includes(tailText.unknownNoticeFragment),
      `采用路线后 appliedNotice 不应再说「未重算」：${notice.slice(0, 160)}`,
    )
    // 预览里的导航说明应落进 notice（来源诚实），仍保留不自动保存声明
    expectTrue(notice.includes(tailText.routeSourceFragment), `notice 缺路线来源说明：${notice.slice(0, 200)}`)
    return { notice: notice.slice(0, 200) }
  })

  await rec.step('应用后目标日：前缀站点原样 + 跨界 navigation leg + 后段候选；其他天不变（UI 导出核对）', async () => {
    const stopNames = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    // 第 1 天组合：s-e2e-1、s-e2e-2（冻结前缀）+ 杭州花圃、茅家埠（候选）
    expectTrue(stopNames.includes('苏堤春晓') && stopNames.includes('曲院风荷'), `冻结前缀丢失：${JSON.stringify(stopNames)}`)
    expectTrue(stopNames.includes('杭州花圃') && stopNames.includes('茅家埠'), `后段候选未落主视图：${JSON.stringify(stopNames)}`)
    // 其他天不变：龙井村/九溪烟树（第 3 天仍在，切天核对）
    const dayTabs = '[role="tablist"][aria-label="按日切换"] button[role="tab"]'
    await page.locator(dayTabs).nth(2).click()
    const day3Names = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(day3Names.includes('龙井村') && day3Names.includes('九溪烟树'), `其他天被改动：${JSON.stringify(day3Names)}`)
    await page.locator(dayTabs).first().click()
    return { stopNames, day3Names }
  })

  await rec.step('一次撤销：整体恢复原 Trip（后段与衔接路线一并回滚）', async () => {
    await page.click(undoApplyButtonSel)
    await page.waitForSelector('text=已撤销应用', { timeout: 5000 })
    const stopNames = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(!stopNames.includes('杭州花圃'), '撤销后候选站点仍在')
    expectTrue(stopNames.includes('曲院风荷') && stopNames.includes('浙江省博物馆'), `撤销后原行程未恢复：${JSON.stringify(stopNames)}`)
    expectEqual(countLegRefreshRequests(control) - baseCount, 1, '撤销不应发新请求')
    return { stopNames }
  })
  await screenshot(page, '32-tail-undone.png')
}

/**
 * 场景 14（tailNoKey，桌面 1440）：control.legRefreshMode='no_key' → 查询恰好 1 次、
 * 固定安全原因、无自动 retry；候选仍在，「仅应用后段（衔接未知）」可达并成功；
 * 应用后边界 leg unavailable、距离/耗时 null；undo 可整体恢复。
 */
export async function runTailBoundaryNoKeyScenario({ page, rec, control, screenshot }) {
  const baseCount = countLegRefreshRequests(control)
  /** 载入时的行程标题（后段应用只替换一天，行程标题不应被改写） */
  let loadedTitle = ''

  await rec.step('打开首页加载示例行程并生成后段候选', async () => {
    loadedTitle = await openAppWithExampleTrip(page)
    await generateTailCandidate(page, 'no_key 场景：换个后段')
    expectEqual(countLegRefreshRequests(control) - baseCount, 0, '生成候选不应发衔接路线请求')
    return { ready: true }
  })

  await rec.step('no_key：显式查询恰好 1 次，固定安全原因，候选仍在', async () => {
    control.legRefreshMode = 'no_key'
    await page.click(tailSel.queryBoundary)
    await page.waitForSelector(`${tailSel.aiPanel} [role="alert"]`, { timeout: 15000 })
    expectEqual(countLegRefreshRequests(control) - baseCount, 1, '应恰好一次请求（无自动 retry）')
    const request = lastLegRefreshRequest(control)
    expectEqual(await settledOf(request), 'responded', 'typed 失败信封应正常响应')
    const panelText = (await page.textContent(tailSel.aiPanel)) ?? ''
    expectTrue(
      panelText.includes('未配置高德地图 Key'),
      `缺 no_key 固定安全原因：${panelText.slice(0, 200)}`,
    )
    expectTrue(panelText.includes('杭州花圃'), '失败后候选预览丢失')
    return { status: 'no_key' }
  })
  await screenshot(page, '33-tail-no-key.png')

  await rec.step('恢复默认 mode 后查询不再自动发生；「仅应用后段（衔接未知）」可达', async () => {
    control.legRefreshMode = null
    expectEqual(countLegRefreshRequests(control) - baseCount, 1, '失败展示阶段不应发新请求')
    expectEqual(await page.locator(tailSel.applyTailUnknown).count(), 1, '缺「仅应用后段（衔接未知）」按钮')
    return { applyUnknownVisible: true }
  })

  await rec.step('显式仅应用后段：边界 leg unavailable、距离/耗时 null；一次 undo 整体恢复', async () => {
    await page.click(tailSel.applyTailUnknown)
    await page.waitForSelector(tailSel.aiPanel, { state: 'detached', timeout: 5000 })
    await page.waitForSelector(applyNoticeSel, { timeout: 5000 })
    const notice = (await page.textContent(applyNoticeSel)) ?? ''
    expectTrue(
      notice.includes(tailText.unknownNoticeFragment),
      `未知应用 notice 应保留「未重算」原文：${notice.slice(0, 160)}`,
    )
    const stopNames = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(stopNames.includes('杭州花圃'), '仅应用后段后候选站点应在主视图')
    // 未知衔接：边界 leg route_type=unavailable，距离/耗时保持 null（展示上不补 0）
    // W4 改版：.leg/.leg-mode-line 退役；leg 块是 col-start-2 边框容器，mode 行是内部第一个 flex 行
    const boundaryLeg = await page.evaluate(() => {
      const legs = Array.from(document.querySelectorAll('div[class*="col-start-2"]'))
      const target = legs.find((el) => el.querySelector('[data-route="unavailable"]'))
      if (!target) return null
      const modeLine = target.querySelector('div.flex')
      const modeText = (modeLine?.textContent ?? '').replace(/\s+/g, ' ').trim()
      return {
        text: (target.textContent ?? '').replace(/\s+/g, ' ').trim(),
        modeText,
      }
    })
    expectTrue(boundaryLeg !== null, '仅应用后段后应出现边界 leg（路线不可用）')
    expectTrue(!/公里|\d\s*米/.test(boundaryLeg.modeText), `未知衔接不应显示距离（不得补 0）：${boundaryLeg.modeText}`)
    expectTrue(!/分钟/.test(boundaryLeg.modeText), `未知衔接不应显示耗时（不得补 0）：${boundaryLeg.modeText}`)
    expectTrue(
      boundaryLeg.text.includes('衔接路线未重算'),
      `未知衔接 leg 应保留「未重算」说明：${boundaryLeg.text.slice(0, 120)}`,
    )
    // 后段应用只替换一天：行程标题（副本身份）不被改写
    const title = (await page.textContent(tripTitleSel)) ?? ''
    expectEqual(title, loadedTitle, `应用后行程标题被改写：${title}`)
    await page.click(undoApplyButtonSel)
    await page.waitForSelector('text=已撤销应用', { timeout: 5000 })
    const restored = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(!restored.includes('杭州花圃'), '撤销后候选站点仍在')
    return { notice: notice.slice(0, 160), restoredCount: restored.length }
  })
  await screenshot(page, '34-tail-no-key-unknown-applied.png')
}

/**
 * 场景 15（tailStopWaiting，桌面 1440）：control.legRefreshDelay gate 挂起 →
 * pending 时「仅应用后段」与「应用后段与衔接路线」都禁用、「停止等待衔接路线」可点 →
 * 停止后桩侧显式观察到 aborted、候选有效、可仅 apply unknown → release 迟到响应
 * 不落地、不污染后续查询（恢复默认后再查成功）。
 */
export async function runTailBoundaryStopWaitingScenario({ page, rec, control, screenshot }) {
  const baseCount = countLegRefreshRequests(control)

  await rec.step('打开首页加载示例行程并生成后段候选', async () => {
    await openAppWithExampleTrip(page)
    await generateTailCandidate(page, '停止等待场景：换个后段')
    return { ready: true }
  })

  await rec.step('gate 挂起 → 显式查询 → 桩侧 pending≥1；pending 时两个最终应用都禁用、停止可点', async () => {
    control.legRefreshDelay = createGate()
    await page.click(tailSel.queryBoundary)
    await page.waitForSelector(tailSel.stopBoundary, { timeout: 10000 })
    const observed = await waitForCondition(() => control.legRefreshDelay.pendingCount() >= 1)
    expectTrue(observed, '衔接路线请求未在桩侧挂起')
    expectEqual(countLegRefreshRequests(control) - baseCount, 1, '应恰好一次请求')
    const applyWithRoute = page.locator(tailSel.applyTailWithRoute)
    const applyUnknown = page.locator(tailSel.applyTailUnknown)
    // pending 时两个最终应用都必须不存在或禁用（不得跨越请求状态应用）
    const withRouteCount = await applyWithRoute.count()
    if (withRouteCount > 0) {
      expectTrue(!(await applyWithRoute.first().isEnabled()), 'pending 时「应用后段与衔接路线」不应可点')
    }
    if ((await applyUnknown.count()) > 0) {
      expectTrue(!(await applyUnknown.first().isEnabled()), 'pending 时「仅应用后段」不应可点')
    }
    expectTrue(await page.locator(tailSel.stopBoundary).isEnabled(), 'pending 时停止等待应可点')
    return { pendingAtGate: control.legRefreshDelay.pendingCount() }
  })

  await rec.step('停止等待：桩侧显式 abort；候选仍在，「仅应用后段」恢复可用', async () => {
    const request = lastLegRefreshRequest(control)
    await page.click(tailSel.stopBoundary)
    const settled = await settledOf(request)
    expectTrue(settled === 'aborted', `停止等待后桩侧应观察到连接断开（abort 生效），实际：${settled}`)
    control.legRefreshDelay.release()
    control.legRefreshDelay = null
    // 迟到响应确实被桩侧写出之后，UI 不得出现衔接路线预览
    const writtenOut = await waitForCondition(() => control.responses.some((r) => r.seq === request.seq))
    expectTrue(writtenOut, '迟到响应未在桩侧完成写出（release 未生效）')
    const panelText = (await page.textContent(tailSel.aiPanel)) ?? ''
    expectTrue(panelText.includes(tailText.stopBoundaryFeedbackFragment), `缺停止等待固定反馈：${panelText.slice(0, 200)}`)
    expectTrue(panelText.includes('杭州花圃'), '停止等待后候选预览丢失')
    expectEqual(countLegRefreshRequests(control) - baseCount, 1, '停止等待不得隐式重试')
    const applyUnknown = page.locator(tailSel.applyTailUnknown)
    expectTrue((await applyUnknown.count()) === 1 && (await applyUnknown.isEnabled()), '停止后「仅应用后段」应恢复可用')
    return { settled }
  })

  await rec.step('停止后仅应用后段（衔接未知）成功；undo 恢复', async () => {
    await page.click(tailSel.applyTailUnknown)
    await page.waitForSelector(tailSel.aiPanel, { state: 'detached', timeout: 5000 })
    const stopNames = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(stopNames.includes('杭州花圃'), '仅应用后段未生效')
    await page.click(undoApplyButtonSel)
    await page.waitForSelector('text=已撤销应用', { timeout: 5000 })
    return { applied: true }
  })
  await screenshot(page, '35-tail-stop-waiting.png')

  await rec.step('迟到响应不污染下一次查询：恢复默认后重新查询成功（ready）', async () => {
    await page.click('button:has-text("AI 调整这一天")')
    await page.waitForSelector(tailSel.aiPanel, { timeout: 5000 })
    await page.check(tailSel.tailRangeRadio)
    await page.selectOption(tailSel.anchorSelect, 's-e2e-2')
    await page.fill(tailSel.aiInstruction, '停止等待场景：再次生成')
    await page.click(tailSel.generateCandidate)
    await page.waitForSelector(tailSel.candidatePreview, { timeout: 15000 })
    await page.click(tailSel.queryBoundary)
    await page.waitForSelector(tailSel.applyTailWithRoute, { timeout: 15000 })
    expectEqual(countLegRefreshRequests(control) - baseCount, 2, '重新查询应恰好一次新请求')
    const previewText = (await page.textContent(tailSel.candidatePreview)) ?? ''
    expectTrue(previewText.includes('2850'), '重新查询应显示 ready 距离')
    // 收尾：放弃候选，恢复默认 control，不留在途状态
    await page.click(tailSel.discardBoundary)
    await page.click('button:has-text("放弃候选")')
    await page.waitForSelector(tailSel.candidatePreview, { state: 'detached', timeout: 5000 })
    return { finalCount: 2 }
  })
}

/**
 * 场景 16（tailZeroDistance，桌面 1440）：control.legRefreshMode='ready_zero_distance'
 * （贴近端点 fixture，0 值几何既有桩校验已接受，不改生产 validator）→ 预览显示 0
 * 距离与未知耗时，不补 0；应用后 notice 仍不声称实时数据。
 */
export async function runTailBoundaryZeroDistanceScenario({ page, rec, control, screenshot }) {
  const baseCount = countLegRefreshRequests(control)

  await rec.step('打开首页加载示例行程并生成后段候选', async () => {
    await openAppWithExampleTrip(page)
    await generateTailCandidate(page, '0 距离场景：换个后段')
    return { ready: true }
  })

  await rec.step('ready_zero_distance：显式查询恰好 1 次；预览显示 0 距离与未知耗时，不补 0', async () => {
    control.legRefreshMode = 'ready_zero_distance'
    await page.click(tailSel.queryBoundary)
    await page.waitForSelector(tailSel.applyTailWithRoute, { timeout: 15000 })
    expectEqual(countLegRefreshRequests(control) - baseCount, 1, '应恰好一次请求')
    const request = lastLegRefreshRequest(control)
    expectEqual(await settledOf(request), 'responded', '0 距离信封应正常响应')
    const previewText = (await page.textContent(tailSel.candidatePreview)) ?? ''
    // 实际 fixture 格式：距离 0（不是未知、不是被抹掉），耗时 null 显示「未知」，不补 0
    expectTrue(previewText.includes('距离 0 米'), `预览缺 0 距离展示：${previewText.slice(0, 200)}`)
    expectTrue(previewText.includes('耗时未知'), `预览缺未知耗时展示：${previewText.slice(0, 200)}`)
    expectTrue(previewText.includes(tailText.routeSourceFragment), '预览缺来源说明')
    return { status: 'ready_zero_distance' }
  })
  await screenshot(page, '36-tail-zero-distance.png')

  await rec.step('0 距离应用：notice 不声称实时数据；undo 恢复；control 复位', async () => {
    await page.click(tailSel.applyTailWithRoute)
    await page.waitForSelector(tailSel.aiPanel, { state: 'detached', timeout: 5000 })
    const notice = (await page.textContent(applyNoticeSel)) ?? ''
    expectTrue(notice.includes(tailText.routeSourceFragment), `notice 缺来源说明：${notice.slice(0, 160)}`)
    // 诚实口径：notice 必须保留「不代表实时交通」免责声明，且去掉该声明后不再出现「实时」主张
    expectTrue(notice.includes('不代表实时交通'), `notice 应保留「不代表实时交通」免责声明：${notice.slice(0, 200)}`)
    expectTrue(
      !notice.split('不代表实时交通').join('').includes('实时'),
      `notice 不应声称实时交通：${notice.slice(0, 200)}`,
    )
    await page.click(undoApplyButtonSel)
    await page.waitForSelector('text=已撤销应用', { timeout: 5000 })
    control.legRefreshMode = null
    return { undone: true }
  })
}

/**
 * 场景 17（tailNarrow，390×844）：后段候选 → 显式查询 ready → 核心按钮/来源/说明
 * 可见无横向溢出；截图留档 artifacts（.gitignore 已忽略，不入 Git）。
 */
export async function runTailBoundaryNarrowScenario({ page, rec, control, screenshot }) {
  const baseCount = countLegRefreshRequests(control)

  await rec.step('打开首页加载示例行程并生成后段候选（390 视口）', async () => {
    await openAppWithExampleTrip(page)
    await generateTailCandidate(page, '窄屏场景：换个后段')
    const overflow = await assertNoHorizontalOverflow(page)
    expectTrue(!overflow, '390 窄屏候选预览出现横向溢出')
    return { ready: true }
  })

  await rec.step('显式查询 ready：按钮/来源/说明可见、无横向溢出', async () => {
    await page.click(tailSel.queryBoundary)
    await page.waitForSelector(tailSel.applyTailWithRoute, { timeout: 15000 })
    expectEqual(countLegRefreshRequests(control) - baseCount, 1, '窄屏应恰好一次请求')
    const previewText = (await page.textContent(tailSel.candidatePreview)) ?? ''
    expectTrue(previewText.includes('2850'), '窄屏预览缺距离 2850')
    expectTrue(previewText.includes(tailText.routeSourceFragment), '窄屏预览缺来源说明')
    expectTrue(previewText.includes(tailText.routeCoordinateFragment), '窄屏预览缺 WGS84 说明')
    expectTrue(previewText.includes(tailText.routeIdentityFragment), '窄屏预览缺「未重新核对」说明')
    // ready 状态必须真实渲染三个关键动作按钮（不是「存在才检查」）；「获取衔接路线」
    // 在已有衔接路线时按设计不再渲染（ready 状态由舍弃/应用替代），故不在此强制。
    for (const [name, locator] of [
      ['仅应用后段（衔接未知）', page.locator(tailSel.applyTailUnknown)],
      ['应用后段与衔接路线', page.locator(tailSel.applyTailWithRoute)],
      ['舍弃衔接路线', page.locator(tailSel.discardBoundary)],
    ]) {
      expectEqual(await locator.count(), 1, `窄屏 ready 状态应有且仅有一个「${name}」`)
      expectTrue(await locator.first().isVisible(), `窄屏下「${name}」不可见`)
    }
    const overflow = await assertNoHorizontalOverflow(page)
    expectTrue(!overflow, '390 窄屏查询结果出现横向溢出')
    return { status: 'ready' }
  })
  await screenshot(page, '37-tail-narrow-390.png')

  await rec.step('窄屏显式应用成功、一次 undo 恢复', async () => {
    await page.click(tailSel.applyTailWithRoute)
    await page.waitForSelector(tailSel.aiPanel, { state: 'detached', timeout: 5000 })
    const stopNames = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(stopNames.includes('杭州花圃'), '窄屏应用后候选站点应在主视图')
    await page.click(undoApplyButtonSel)
    await page.waitForSelector('text=已撤销应用', { timeout: 5000 })
    const restored = await page.$$eval('[data-testid="stop-row"]', (nodes) =>
      nodes.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim() ?? ''),
    )
    expectTrue(!restored.includes('杭州花圃'), '窄屏撤销后候选站点仍在')
    const overflow = await assertNoHorizontalOverflow(page)
    expectTrue(!overflow, '390 窄屏撤销后出现横向溢出')
    return { undone: true }
  })
  await screenshot(page, '38-tail-narrow-undone.png')
}

/**
 * 六期 S5 · 景点深度卡 E2E 场景（从 runner.mjs 编排调用）。
 *
 * 覆盖计划 §6 的两条验收：
 * - 渲染：完整深度 → 看点 / 适合 / 建议停留 / 贴士四分区、AI 徽章、常驻提示与分工说明；
 * - 缺字段降级：只有看点 → 其余三分区「未提供」；无深度站点 → 整卡不渲染、无 loading 残留。
 *
 * 数据注入：只在当前 page 内拦截 `GET /api/trips/example`，返回 contract 桩行程 +
 * 本文件内置的深度字段。不新增出站请求，不改 dev-stub 服务端。
 */
import { buildPlanTrip } from '../dev-stub/contract-server.mjs'
import { expectTrue } from './sessionResumeScenarios.mjs'

const sel = {
  tripTitle: 'section[aria-label="行程安排"] h2',
  stopRow: '[data-testid="stop-row"]',
  stopDetail: '[data-testid="stop-detail"]',
  depthCard: '[data-testid^="stop-depth-card-"]',
  loading: '[data-testid="stop-depth-loading"]',
  badge: '[data-testid="stop-depth-badge"]',
  disclaimer: '[data-testid="stop-depth-disclaimer"]',
  highlights: '[data-testid="stop-depth-highlights"]',
  suitable: '[data-testid="stop-depth-suitable"]',
  stay: '[data-testid="stop-depth-stay"]',
  tips: '[data-testid="stop-depth-tips"]',
}

const fullDepth = {
  highlights: {
    items: ['E2E 湖面开阔，长堤一线', 'E2E 春晓时分光线柔和'],
    source: 'model_generated',
  },
  suitableFor: { tags: ['nature', 'photo'], source: 'model_generated' },
  suggestedStayMinutes: { min: 60, max: 90, source: 'model_generated' },
  tips: {
    items: ['E2E 清晨与傍晚人少', 'E2E 沿堤可步行串联'],
    source: 'model_generated',
  },
}

const partialDepth = {
  highlights: { items: ['E2E 只有看点'], source: 'model_generated' },
}

async function installExampleRoute(page, { depthByStopId }) {
  await page.route('**/api/trips/example', async (route) => {
    const payload = { ...buildPlanTrip('example') }
    payload.days = payload.days.map((day) => ({
      ...day,
      stops: day.stops.map((stop) =>
        depthByStopId[stop.id] ? { ...stop, ...depthByStopId[stop.id] } : stop,
      ),
    }))
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(payload),
    })
  })
}

async function openExample(page, appOrigin) {
  await page.goto(appOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
}

function textOf(page, selector) {
  return page.textContent(selector).then((text) => (text ?? '').trim())
}

async function openStop(page, index) {
  await page.locator(sel.stopRow).nth(index).click()
  await page.waitForSelector(sel.stopDetail, { timeout: 5000 })
}

async function assertFullDepthCard(page) {
  await page.waitForSelector(sel.depthCard, { timeout: 15000 })

  for (const selector of [sel.highlights, sel.suitable, sel.stay, sel.tips]) {
    expectTrue((await page.locator(selector).count()) === 1, `深度卡缺少分区：${selector}`)
  }

  const badge = await textOf(page, sel.badge)
  expectTrue(badge.includes('AI 生成·供参考'), `AI 徽章异常：${badge}`)
  const disclaimer = await textOf(page, sel.disclaimer)
  expectTrue(disclaimer.includes('出发前请自行确认'), `常驻提示异常：${disclaimer}`)
  const cardText = await textOf(page, sel.depthCard)
  expectTrue(cardText.includes('易变信息以下方核实状态为准'), '未渲染三态分工说明')

  expectTrue((await textOf(page, sel.highlights)).includes('E2E 湖面开阔，长堤一线'), '看点未渲染')
  expectTrue((await textOf(page, sel.suitable)).includes('自然'), '适合标签未渲染')
  expectTrue((await textOf(page, sel.suitable)).includes('拍照'), '适合标签未渲染')
  expectTrue((await textOf(page, sel.stay)).includes('建议停留 60–90 分钟'), '建议停留未渲染')
  expectTrue((await textOf(page, sel.tips)).includes('E2E 清晨与傍晚人少'), '贴士未渲染')

  return { badge, disclaimer }
}

export async function runS5StopDepthCard({ page, rec, screenshot, appOrigin }) {
  await installExampleRoute(page, {
    depthByStopId: {
      's-e2e-1': fullDepth,
      's-e2e-2': fullDepth,
      's-e2e-3': fullDepth,
    },
  })

  await rec.step('完整深度：打开示例行程并展开第一站', async () => {
    await openExample(page, appOrigin)
    const title = await textOf(page, sel.tripTitle)
    expectTrue(title.length > 0, '首屏没有行程标题')
    await openStop(page, 0)
    return { title }
  })

  await rec.step('深度卡四分区、AI 徽章、常驻提示与三态分工说明', async () => {
    return assertFullDepthCard(page)
  })
  await page.locator(sel.depthCard).scrollIntoViewIfNeeded()
  await screenshot(page, '60-s5-stop-depth-card.png')
}

export async function runS5StopDepthDegraded({ page, rec, screenshot, appOrigin }) {
  await installExampleRoute(page, {
    depthByStopId: {
      's-e2e-1': partialDepth,
    },
  })

  await rec.step('缺字段：只有看点的站点，其余三分区显示「未提供」', async () => {
    await openExample(page, appOrigin)
    await openStop(page, 0)
    await page.waitForSelector(sel.depthCard, { timeout: 15000 })
    expectTrue((await textOf(page, sel.highlights)).includes('E2E 只有看点'), '看点未渲染')
    for (const selector of [sel.suitable, sel.stay, sel.tips]) {
      const text = await textOf(page, selector)
      expectTrue(text.includes('未提供'), `缺失分区未降级为「未提供」：${selector} => ${text}`)
    }
    return { partial: true }
  })
  await page.locator(sel.depthCard).scrollIntoViewIfNeeded()
  await screenshot(page, '61-s5-stop-depth-partial.png')

  await rec.step('无深度站点：展开后整卡与 loading 都不渲染', async () => {
    await openStop(page, 1)
    const cardCount = await page.locator(sel.depthCard).count()
    const loadingCount = await page.locator(sel.loading).count()
    expectTrue(cardCount === 0, `无深度时仍渲染深度卡：${cardCount}`)
    expectTrue(loadingCount === 0, `无深度时残留 loading：${loadingCount}`)
    return { cardCount, loadingCount }
  })
  await screenshot(page, '62-s5-stop-depth-absent.png')
}

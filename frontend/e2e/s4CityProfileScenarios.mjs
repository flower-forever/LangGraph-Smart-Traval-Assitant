/**
 * 六期 S4 · 城市导览卡 E2E 场景（从 runner.mjs 编排调用）。
 *
 * 覆盖计划 §5 的三条验收：
 * - 出现：完整 cityProfile → 五块内容、AI 徽章、常驻提示；
 * - 折叠：header 按钮切换正文显隐，徽章/提示不消失；
 * - 缺字段降级：部分块缺失 → 对应块「未提供」；无 cityProfile → 整卡与 loading 都不渲染。
 *
 * 数据注入：只在当前 page 内拦截 `GET /api/trips/example`，返回 contract 桩行程 +
 * 本文件内置的 cityProfile。不新增出站请求，不改 dev-stub 服务端。
 */
import { buildPlanTrip } from '../dev-stub/contract-server.mjs'
import { expectTrue } from './sessionResumeScenarios.mjs'

const sel = {
  tripTitle: 'section[aria-label="行程安排"] h2',
  card: '[data-testid="city-profile-card"]',
  badge: '[data-testid="city-profile-badge"]',
  disclaimer: '[data-testid="city-profile-disclaimer"]',
  body: '[data-testid="city-profile-body"]',
  loading: '[data-testid="city-profile-loading"]',
  toggle: '[data-testid="city-profile-toggle"]',
  impression: '[data-testid="city-profile-impression"]',
  days: '[data-testid="city-profile-days"]',
  districts: '[data-testid="city-profile-districts"]',
  season: '[data-testid="city-profile-season"]',
  classics: '[data-testid="city-profile-classics"]',
}

const fullProfile = {
  source: 'model_generated',
  oneLineImpression: { text: 'E2E 湖山慢城', source: 'model_generated' },
  suggestedDays: { min: 2, max: 4, source: 'model_generated' },
  districts: [
    {
      name: '西湖片区',
      summary: '湖景与老街',
      attractions: ['断桥', '苏堤'],
      source: 'model_generated',
    },
    {
      name: '灵隐片区',
      summary: '山林古寺',
      attractions: ['灵隐寺'],
      source: 'model_generated',
    },
  ],
  seasonTips: { text: 'E2E 春季多雨，带伞', source: 'model_generated' },
  classicList: [
    { name: '断桥', reason: 'E2E 经典湖景', source: 'model_generated' },
    { name: '苏堤', reason: 'E2E 长堤春晓', source: 'model_generated' },
  ],
}

const partialProfile = {
  source: 'model_generated',
  oneLineImpression: { text: 'E2E 只有一句话', source: 'model_generated' },
}

async function installExampleRoute(page, variant) {
  await page.route('**/api/trips/example', async (route) => {
    const payload = { ...buildPlanTrip('example') }
    if (variant.profile) payload.cityProfile = variant.profile
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

async function assertFullCard(page) {
  await page.waitForSelector(sel.card, { timeout: 15000 })
  await page.waitForSelector(sel.body, { timeout: 5000 })

  for (const selector of [sel.impression, sel.days, sel.districts, sel.season, sel.classics]) {
    expectTrue((await page.locator(selector).count()) === 1, `城市卡缺少块：${selector}`)
  }

  const badge = await textOf(page, sel.badge)
  expectTrue(badge.includes('AI 生成·供参考'), `AI 徽章异常：${badge}`)
  const disclaimer = await textOf(page, sel.disclaimer)
  expectTrue(disclaimer.includes('出发前请自行确认'), `常驻提示异常：${disclaimer}`)
  expectTrue((await textOf(page, sel.impression)).includes('E2E 湖山慢城'), '一句话印象未渲染')
  expectTrue((await textOf(page, sel.days)).includes('建议游玩 2–4 天'), '建议天数未渲染')
  expectTrue((await textOf(page, sel.districts)).includes('西湖片区'), '片区未渲染')
  expectTrue((await textOf(page, sel.districts)).includes('代表景点：断桥、苏堤'), '片区景点未渲染')
  expectTrue((await textOf(page, sel.season)).includes('E2E 春季多雨，带伞'), '当季贴士未渲染')
  expectTrue((await textOf(page, sel.classics)).includes('断桥'), '经典清单未渲染')

  return { badge, disclaimer }
}

export async function runS4CityProfileAppearance({ page, rec, screenshot, appOrigin }) {
  const variant = { profile: fullProfile }
  await installExampleRoute(page, variant)

  await rec.step('完整 cityProfile：打开示例行程并渲染城市卡', async () => {
    await openExample(page, appOrigin)
    const title = await textOf(page, sel.tripTitle)
    expectTrue(title.length > 0, '首屏没有行程标题')
    return { title }
  })

  await rec.step('城市卡五块、AI 徽章与「出发前请自行确认」常驻', async () => {
    const result = await assertFullCard(page)
    return result
  })
  await page.locator(sel.card).scrollIntoViewIfNeeded()
  await screenshot(page, '50-s4-city-profile-appearance.png')
}

export async function runS4CityProfileCollapse({ page, rec, screenshot, appOrigin }) {
  const variant = { profile: fullProfile }
  await installExampleRoute(page, variant)

  await rec.step('完整 cityProfile：等待城市卡正文展开', async () => {
    await openExample(page, appOrigin)
    await page.waitForSelector(sel.body, { timeout: 15000 })
    const expanded = await page.getAttribute(sel.toggle, 'aria-expanded')
    expectTrue(expanded === 'true', `初始 aria-expanded 异常：${expanded}`)
    return { expanded }
  })

  await rec.step('点击「收起」：正文移除，徽章/提示仍在；再展开恢复', async () => {
    await page.click(sel.toggle)
    await page.waitForSelector(sel.body, { state: 'detached', timeout: 5000 })
    const collapsed = await page.getAttribute(sel.toggle, 'aria-expanded')
    expectTrue(collapsed === 'false', `收起后 aria-expanded 异常：${collapsed}`)
    expectTrue((await textOf(page, sel.badge)).includes('AI 生成·供参考'), '收起后徽章消失')
    expectTrue((await textOf(page, sel.disclaimer)).includes('出发前请自行确认'), '收起后提示消失')
    expectTrue((await page.locator(sel.body).count()) === 0, '收起后正文仍存在')

    await page.locator(sel.card).scrollIntoViewIfNeeded()
    await screenshot(page, '51-s4-city-profile-collapse.png')

    await page.click(sel.toggle)
    await page.waitForSelector(sel.body, { timeout: 5000 })
    const reopened = await page.getAttribute(sel.toggle, 'aria-expanded')
    expectTrue(reopened === 'true', `再展开后 aria-expanded 异常：${reopened}`)
    return { collapsed, reopened }
  })
}

export async function runS4CityProfileDegraded({ page, rec, screenshot, appOrigin }) {
  const variant = { profile: partialProfile }
  await installExampleRoute(page, variant)

  await rec.step('部分块缺失：仅一句话印象，其余四块显示「未提供」', async () => {
    await openExample(page, appOrigin)
    await page.waitForSelector(sel.card, { timeout: 15000 })
    await page.waitForSelector(sel.body, { timeout: 5000 })
    expectTrue((await textOf(page, sel.impression)).includes('E2E 只有一句话'), '一句话印象未渲染')
    for (const selector of [sel.days, sel.districts, sel.season, sel.classics]) {
      const text = await textOf(page, selector)
      expectTrue(text.includes('未提供'), `缺失块未降级为「未提供」：${selector} => ${text}`)
    }
    return { partial: true }
  })
  await page.locator(sel.card).scrollIntoViewIfNeeded()
  await screenshot(page, '52-s4-city-profile-partial.png')

  await rec.step('无 cityProfile：整卡与 loading 都不渲染', async () => {
    variant.profile = null
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    await page.goto(appOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForSelector(sel.tripTitle, { timeout: 15000 })

    const cardCount = await page.locator(sel.card).count()
    const loadingCount = await page.locator(sel.loading).count()
    expectTrue(cardCount === 0, `无 cityProfile 时仍渲染城市卡：${cardCount}`)
    expectTrue(loadingCount === 0, `无 cityProfile 时残留 loading：${loadingCount}`)
    return { cardCount, loadingCount }
  })
  await screenshot(page, '53-s4-city-profile-absent.png')
}

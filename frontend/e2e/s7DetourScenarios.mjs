/**
 * 六期 S7 · 绕行拦截卡 E2E 场景（从 runner.mjs 编排调用）。
 *
 * 覆盖计划 §8 的验收：
 * - 97.2km 型绕行：拦截卡渲染 + 证据（直线 / 规划 / 倍数）+ 不恐吓文案。
 * - 保留原样：卡片收起；父级按 trip id 抑制后重新挂载也不重弹；体检卡仍可查 detour。
 * - 去调整：回调收到正确天号。
 * - 阈值保守：2 倍 / 40km 的合理绕行不拦截（体检仍提示）；5 倍但 25km 的短途不拦截。
 *
 * 数据注入：不拦 /api——组件挂载在 detour-harness.html（专用 E2E 页，不进主包、
 * 不进构建产物；作者禁改 App.tsx，真实挂载点为 PM 接线项）。零出站请求、零存储写入。
 */
import { expectTrue } from './sessionResumeScenarios.mjs'

const sel = {
  card: '[data-testid="detour-intercept-card"]',
  count: '[data-testid="detour-intercept-count"]',
  badge: '[data-testid="detour-intercept-badge"]',
  hit0: '[data-testid="detour-intercept-hit-0"]',
  evidence0: '[data-testid="detour-intercept-evidence-0"]',
  keep: '[data-testid="detour-intercept-keep"]',
  adjust: '[data-testid="detour-intercept-adjust"]',
  loading: '[data-testid="detour-intercept-loading"]',
  suppressed: '[data-testid="detour-harness-suppressed"]',
  remount: '[data-testid="detour-harness-remount"]',
  mountCount: '[data-testid="detour-harness-mount-count"]',
  adjustStatus: '[data-testid="detour-harness-adjust-status"]',
  variant: '[data-testid="detour-harness-variant"]',
  healthToggle: '[data-testid="health-toggle"]',
  healthDetour: '[data-code="detour"]',
  healthCard: '[data-testid="itinerary-health-card"]',
}

async function openHarness(page, appOrigin, variant = 'hit') {
  const query = variant === 'hit' ? '' : `?variant=${variant}`
  await page.goto(`${appOrigin}/detour-harness.html${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  })
  // 体检卡总是渲染；等它出现即代表挂载完成（变体标记本身是 hidden 的，不能等 visible）。
  await page.waitForSelector(sel.healthCard, { timeout: 15000 })
  const shownVariant = await page.textContent(sel.variant)
  expectTrue((shownVariant ?? '').trim() === variant, `挂载页变体异常：${shownVariant}`)
}

function textOf(page, selector) {
  return page.textContent(selector).then((text) => (text ?? '').trim())
}

async function assertNoHarnessStorageWrites(page) {
  const sizes = await page.evaluate(() => ({
    local: window.localStorage.length,
    session: window.sessionStorage.length,
  }))
  expectTrue(sizes.local === 0, `拦截流程写了 localStorage：${sizes.local} 个键`)
  expectTrue(sizes.session === 0, `拦截流程写了 sessionStorage：${sizes.session} 个键`)
}

export async function runS7DetourKeep({ page, rec, screenshot, appOrigin }) {
  await rec.step('97.2km 型：拦截卡 + 证据（直线/规划/倍数）+ 不恐吓文案', async () => {
    await openHarness(page, appOrigin)
    await page.waitForSelector(sel.card, { timeout: 15000 })

    expectTrue((await textOf(page, sel.count)).includes('共 1 段'), '命中段数异常')
    expectTrue((await textOf(page, sel.badge)).includes('直线 × 实际里程'), '判定口径徽章缺失')

    const hit = await textOf(page, sel.hit0)
    expectTrue(hit.includes('第 1 天 · 第 1→2 站'), `天/站序异常：${hit}`)
    expectTrue(hit.includes('武陵源标志门 → 天门山索道'), `站名异常：${hit}`)

    const evidence = await textOf(page, sel.evidence0)
    expectTrue(evidence.includes('直线 26.3 km'), `直线证据异常：${evidence}`)
    expectTrue(evidence.includes('规划 97.2 km'), `实际里程证据异常：${evidence}`)
    expectTrue(evidence.includes('约 3.7 倍'), `倍数证据异常：${evidence}`)

    const card = await textOf(page, sel.card)
    expectTrue(card.includes('可能不是最优路线'), '非恐吓文案缺失')
    expectTrue(card.includes('保留后本次行程不再自动提示'), '保留说明缺失')
    expectTrue(card.includes('体检卡里仍可查看'), '体检仍可查提示缺失')

    await page.locator(sel.card).scrollIntoViewIfNeeded()
    await screenshot(page, '65-s7-detour-intercept.png')
    return { evidence }
  })

  await rec.step('保留原样：卡片收起；重新挂载不重弹；体检卡仍可查；零存储写入', async () => {
    await page.click(sel.keep)
    await page.waitForSelector(sel.card, { state: 'detached', timeout: 5000 })
    await page.waitForSelector(sel.suppressed, { timeout: 5000 })

    await page.click(sel.remount)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('重新挂载次数：1'),
      sel.mountCount,
      { timeout: 5000 },
    )
    expectTrue(
      (await page.locator(sel.card).count()) === 0,
      '重新挂载后拦截卡再次出现（同一次行程重弹）',
    )
    expectTrue((await textOf(page, sel.suppressed)).includes('会话内不再自动出现'), '抑制说明缺失')

    // 体检卡仍可查：展开后 detour 条目应包含 97.2 公里。
    await page.click(sel.healthToggle)
    await page.waitForSelector(sel.healthDetour, { timeout: 5000 })
    const healthDetour = await textOf(page, sel.healthDetour)
    expectTrue(healthDetour.includes('97.2 公里'), `体检 detour 条目异常：${healthDetour}`)

    await assertNoHarnessStorageWrites(page)
    await screenshot(page, '66-s7-detour-health-after-keep.png')
    return { healthDetour }
  })
}

export async function runS7DetourAdjustAndThresholds({ page, rec, screenshot, appOrigin }) {
  await rec.step('去调整：回调收到第一条命中路段的天号', async () => {
    await openHarness(page, appOrigin)
    await page.waitForSelector(sel.card, { timeout: 15000 })

    await page.click(sel.adjust)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('已请求编辑：第 1 天'),
      sel.adjustStatus,
      { timeout: 5000 },
    )
    const status = await textOf(page, sel.adjustStatus)
    expectTrue(status === '已请求编辑：第 1 天', `去调整回调天数异常：${status}`)
    await screenshot(page, '67-s7-detour-adjust.png')
    return { status }
  })

  await rec.step('阈值保守：5 倍但 25km 不拦；2 倍 40km 不拦（体检仍有 detour）', async () => {
    await openHarness(page, appOrigin, 'below-floor')
    expectTrue(
      (await page.locator(sel.card).count()) === 0,
      '25km 短途（尽管比例 5 倍）不应被拦截',
    )

    await openHarness(page, appOrigin, 'winding')
    expectTrue(
      (await page.locator(sel.card).count()) === 0,
      '40km / 直线 20km（2 倍）的合理绕行不应被拦截',
    )

    await page.click(sel.healthToggle)
    await page.waitForSelector(sel.healthDetour, { timeout: 5000 })
    const healthDetour = await textOf(page, sel.healthDetour)
    expectTrue(healthDetour.includes('40.0 公里'), `体检 detour 条目异常：${healthDetour}`)

    await assertNoHarnessStorageWrites(page)
    await screenshot(page, '68-s7-detour-thresholds.png')
    return { healthDetour }
  })
}

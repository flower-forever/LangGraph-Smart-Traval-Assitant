/**
 * 六期 S6 · 选择充分度卡 E2E 场景（从 runner.mjs 编排调用）。
 *
 * 覆盖计划 §7 的两条验收：
 * - 充分度卡渲染：统计「已覆盖 X/N · 未安排 Y 条」、AI 徽章、已覆盖 / 未安排 /
 *   未识别三态、折叠；文案只说「经典清单里你还没安排」，无权威必去宣称。
 * - 加入候选池冒烟：点「加入候选池」→ 走既有候选库显式写入路径（与 PM 接线到
 *   App.tsx 后同款调用）→ 成功反馈 → 候选记录真实落盘（可删）。
 *
 * 数据注入：不拦 /api——组件挂载在 coverage-harness.html（专用 E2E 页，不进主包、
 * 不进构建产物；作者禁改 App.tsx，真实挂载点为 PM 接线项）。零出站请求。
 */
import { expectTrue } from './sessionResumeScenarios.mjs'

const sel = {
  root: '#root',
  card: '[data-testid="trip-coverage-card"]',
  summary: '[data-testid="trip-coverage-summary"]',
  badge: '[data-testid="trip-coverage-badge"]',
  disclaimer: '[data-testid="trip-coverage-disclaimer"]',
  body: '[data-testid="trip-coverage-body"]',
  toggle: '[data-testid="trip-coverage-toggle"]',
  covered: '[data-testid="trip-coverage-covered"]',
  uncovered: '[data-testid="trip-coverage-uncovered"]',
  unrecognized: '[data-testid="trip-coverage-unrecognized"]',
  addButton: '[data-testid="trip-coverage-add-0"]',
  addButton2: '[data-testid="trip-coverage-add-1"]',
  poolStatus: '[data-testid="coverage-harness-pool-status"]',
}

const CANDIDATES_KEY = 'travel-assistant:workspace:candidates:v1'

async function openHarness(page, appOrigin) {
  await page.goto(`${appOrigin}/coverage-harness.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  })
  await page.waitForSelector(sel.card, { timeout: 15000 })
}

function textOf(page, selector) {
  return page.textContent(selector).then((text) => (text ?? '').trim())
}

async function readCandidates(page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    return JSON.parse(raw)
  }, CANDIDATES_KEY)
}

export async function runS6CoverageCard({ page, rec, screenshot, appOrigin }) {
  await rec.step('充分度卡：打开挂载页，统计行 / 徽章 / 已覆盖 / 未安排齐备', async () => {
    await openHarness(page, appOrigin)
    const summary = await textOf(page, sel.summary)
    expectTrue(summary.includes('已覆盖 2/4'), `统计行异常：${summary}`)
    expectTrue(summary.includes('未安排 2 条'), `未安排计数异常：${summary}`)

    const badge = await textOf(page, sel.badge)
    expectTrue(badge.includes('AI 生成·供参考'), `AI 徽章异常：${badge}`)
    const disclaimer = await textOf(page, sel.disclaimer)
    expectTrue(disclaimer.includes('仅供选择参考'), '「仅供选择参考」口径缺失')
    expectTrue(disclaimer.includes('不构成权威必去推荐'), '「不构成权威必去」口径缺失')
    expectTrue(disclaimer.includes('出发前请自行确认'), '「出发前请自行确认」提示缺失')

    const covered = await textOf(page, sel.covered)
    expectTrue(covered.includes('苏堤春晓'), '已覆盖条目未渲染：苏堤春晓')
    expectTrue(covered.includes('浙江省博物馆'), '已覆盖条目未渲染：浙江省博物馆')

    const uncovered = await textOf(page, sel.uncovered)
    expectTrue(uncovered.includes('经典清单里你还没安排'), '未安排区标题缺失（文案口径）')
    expectTrue(uncovered.includes('断桥'), '未安排条目未渲染：断桥')
    expectTrue(uncovered.includes('灵隐寺'), '未安排条目未渲染：灵隐寺')
    expectTrue((await page.locator(`${sel.uncovered} button`).count()) === 2, '加入候选池按钮数量异常')

    const unrecognized = await textOf(page, sel.unrecognized)
    expectTrue(unrecognized.includes('九溪烟树'), '未识别站点未如实说明')
    expectTrue(unrecognized.includes('未识别，未计入覆盖统计'), '未识别口径缺失')
    return { summary, badge }
  })

  await rec.step('折叠：正文移除，统计行 / 徽章 / 提示仍在；再展开恢复', async () => {
    await page.click(sel.toggle)
    await page.waitForSelector(sel.body, { state: 'detached', timeout: 5000 })
    const collapsed = await page.getAttribute(sel.toggle, 'aria-expanded')
    expectTrue(collapsed === 'false', `收起后 aria-expanded 异常：${collapsed}`)
    expectTrue((await textOf(page, sel.summary)).includes('已覆盖 2/4'), '收起后统计行消失')
    expectTrue((await textOf(page, sel.badge)).includes('AI 生成·供参考'), '收起后徽章消失')

    await page.locator(sel.card).scrollIntoViewIfNeeded()
    await screenshot(page, '63-s6-coverage-card.png')

    await page.click(sel.toggle)
    await page.waitForSelector(sel.body, { timeout: 5000 })
    const reopened = await page.getAttribute(sel.toggle, 'aria-expanded')
    expectTrue(reopened === 'true', `再展开后 aria-expanded 异常：${reopened}`)
    return { collapsed, reopened }
  })
}

export async function runS6CoveragePoolSmoke({ page, rec, screenshot, appOrigin }) {
  await rec.step('加入候选池：点「断桥」→ 成功反馈 + 候选记录真实落盘（manual / 备注为理由）', async () => {
    await openHarness(page, appOrigin)
    await page.click(sel.addButton)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('已把「断桥」加入候选池'),
      sel.poolStatus,
      { timeout: 10000 },
    )
    const buttonAfter = await textOf(page, sel.addButton)
    expectTrue(buttonAfter.includes('已加入候选池'), `点击后按钮态异常：${buttonAfter}`)
    expectTrue(await page.locator(`${sel.addButton}[disabled]`).count() === 1, '按钮未禁用，可能重复入池')

    const record = await readCandidates(page)
    expectTrue(record !== null, '候选库键未写入')
    expectTrue((record?.items ?? []).length === 1, `候选条数异常：${record?.items?.length}`)
    const item = record.items[0]
    expectTrue(item.name === '断桥', `候选名称异常：${item.name}`)
    expectTrue(item.source === 'manual', `候选来源异常：${item.source}`)
    expectTrue(item.notes === 'E2E 白娘子传说地标', `候选备注（理由）异常：${item.notes}`)
    return { itemCount: record.items.length }
  })

  await rec.step('第二条「灵隐寺」再入池：共 2 条，均可在候选池面板删除（既有能力）', async () => {
    await page.click(sel.addButton2)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('已把「灵隐寺」加入候选池'),
      sel.poolStatus,
      { timeout: 10000 },
    )
    const record = await readCandidates(page)
    const names = (record?.items ?? []).map((item) => item.name).sort()
    expectTrue(names.join(',') === '断桥,灵隐寺', `候选清单异常：${names.join(',')}`)
    expectTrue((await textOf(page, sel.poolStatus)).includes('共 2 个候选'), '保存反馈计数异常')

    await page.locator(sel.card).scrollIntoViewIfNeeded()
    await screenshot(page, '64-s6-coverage-pool.png')
    return { names }
  })
}

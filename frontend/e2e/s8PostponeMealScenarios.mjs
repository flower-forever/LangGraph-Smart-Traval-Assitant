/**
 * 六期 S8 · 时刻顺延 + 用餐补推荐 E2E 场景（从 runner.mjs 编排调用）。
 *
 * 覆盖计划 §9 的两条验收：
 * - 顺延：体检条目入口 → 30 分钟级联预览（前后对照）→ 确认创建草稿并写入
 *   → 体检重跑（notice 清零、重跑计数 +1）→ 撤销一次整体恢复。
 * - 补餐：3 个餐饮候选 → 预览时间 / 位置 / leg 作废 → 确认插入（站点数 +1、
 *   2 段路段待重取）→ 撤销恢复；另验证双库空时「暂无餐饮候选」沉默。
 *
 * 数据注入：不拦 /api——组件挂载在 postpone-meal-harness.html（专用 E2E 页，
 * 不进主包、不进构建产物；作者禁改 App.tsx，真实挂载点为 PM 接线项）。零出站请求。
 */
import { expectTrue } from './sessionResumeScenarios.mjs'

const sel = {
  root: '#root',
  healthCard: '[data-testid="itinerary-health-card"]',
  healthToggle: '[data-testid="health-toggle"]',
  healthSummary: '[data-testid="health-summary"]',
  healthCounts: '[data-testid="s8-health-counts"]',
  suggestPostpone: '[data-testid="health-suggest-postpone"]',
  suggestMeal: '[data-testid="health-suggest-meal"]',
  postponePanel: '[data-testid="postpone-panel"]',
  postponeTarget: '[data-testid="postpone-target"]',
  postponeMinutes30: '[data-testid="postpone-minutes-30"]',
  postponePreviewAction: '[data-testid="postpone-preview-action"]',
  postponePreview: '[data-testid="postpone-preview"]',
  postponeConfirm: '[data-testid="postpone-confirm"]',
  postponeUndo: '[data-testid="postpone-undo"]',
  postponeForkNote: '[data-testid="postpone-fork-note"]',
  mealPanel: '[data-testid="meal-suggest-panel"]',
  mealSlot: '[data-testid="meal-slot"]',
  mealWindowFallback: '[data-testid="meal-window-fallback"]',
  mealCandidate: '[data-testid="meal-candidate"]',
  mealPreview: '[data-testid="meal-preview"]',
  mealConfirm: '[data-testid="meal-confirm"]',
  mealUndo: '[data-testid="meal-undo"]',
  mealEmpty: '[data-testid="meal-empty"]',
  mealForkNote: '[data-testid="meal-fork-note"]',
  draftStatus: '[data-testid="s8-draft-status"]',
  draftRevision: '[data-testid="s8-draft-revision"]',
  stopCount: '[data-testid="s8-stop-count"]',
  unavailableLegs: '[data-testid="s8-unavailable-legs"]',
  recheckCount: '[data-testid="s8-recheck-count"]',
}

async function openHarness(page, appOrigin, query) {
  await page.goto(`${appOrigin}/postpone-meal-harness.html?${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  })
  await page.waitForSelector(sel.healthCard, { timeout: 15000 })
}

function textOf(page, selector) {
  return page.textContent(selector).then((text) => (text ?? '').trim())
}

export async function runS8PostponeSequence({ page, rec, screenshot, appOrigin }) {
  await rec.step('顺延入口：体检 pace 条目出现「建议顺延」，默认起点=体检建议的下一站', async () => {
    await openHarness(page, appOrigin, 'variant=postpone')
    await page.click(sel.healthToggle)
    await page.waitForSelector(sel.suggestPostpone, { timeout: 5000 })
    expectTrue((await textOf(page, sel.healthSummary)).includes('1 项需确认'), '顺延前体检应有 1 项需确认')

    await page.click(sel.suggestPostpone)
    await page.waitForSelector(sel.postponePanel, { timeout: 5000 })
    const target = await page.inputValue(sel.postponeTarget)
    expectTrue(target === 'p-s2', `默认顺延起点应为体检建议的下一站 p-s2，实际 ${target}`)
    expectTrue((await textOf(page, sel.postponeForkNote)).includes('基于当前行程创建'), '无草稿 fork 提示缺失')
    return { target }
  })

  await rec.step('30 分钟预览：目标站及之后级联后移，目标站之前不动；预览不写草稿', async () => {
    await page.click(sel.postponeMinutes30)
    await page.click(sel.postponePreviewAction)
    await page.waitForSelector(sel.postponePreview, { timeout: 5000 })
    const preview = await textOf(page, sel.postponePreview)
    expectTrue(preview.includes('10:10 → 10:40'), `第 2 站未按 30 分钟后移：${preview}`)
    expectTrue(preview.includes('11:00 → 11:30'), `第 3 站未级联后移：${preview}`)
    expectTrue(preview.includes('14:00 → 14:30'), `第 4 站未级联后移：${preview}`)
    expectTrue(preview.includes('09:00 → 不变'), '目标站之前的站不应被后移')

    expectTrue((await textOf(page, sel.draftStatus)).includes('未创建草稿'), '预览阶段不应创建草稿')
    expectTrue((await textOf(page, sel.draftRevision)).includes('none'), '预览阶段不应产生 revision')
    return { preview: preview.slice(0, 120) }
  })

  await rec.step('确认写入草稿：走 fork 创建，时刻级联生效，体检自动重跑且 notice 清零', async () => {
    await page.click(sel.postponeConfirm)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('10:40 平湖秋月'),
      sel.draftStatus,
      { timeout: 10000 },
    )
    const status = await textOf(page, sel.draftStatus)
    expectTrue(status.includes('11:30 湖滨晴雨'), `第 3 站时刻异常：${status}`)
    expectTrue(status.includes('14:30 柳浪闻莺'), `第 4 站时刻异常：${status}`)
    expectTrue(status.includes('09:00 断桥残雪'), '目标站之前的站不应变化')
    expectTrue((await textOf(page, sel.draftRevision)).includes('revision：1'), '顺延应只增加一个撤销步')
    expectTrue((await textOf(page, sel.stopCount)).includes('4'), '顺延不应增删站点')

    const recheck = await textOf(page, sel.recheckCount)
    expectTrue(recheck.includes('1') && recheck.includes('第 1 天'), `体检重跑回调异常：${recheck}`)
    const counts = await textOf(page, sel.healthCounts)
    expectTrue(counts.includes('需确认 0'), `顺延后体检应即时重算（notice 清零）：${counts}`)

    await page.locator(sel.postponePanel).scrollIntoViewIfNeeded()
    await screenshot(page, '65-s8-postpone.png')
    return { status, recheck, counts }
  })

  await rec.step('撤销一次：整体恢复顺延前时刻，体检再次重跑并恢复提示', async () => {
    await page.click(sel.postponeUndo)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('10:10 平湖秋月'),
      sel.draftStatus,
      { timeout: 10000 },
    )
    const status = await textOf(page, sel.draftStatus)
    expectTrue(status.includes('11:00 湖滨晴雨'), `第 3 站未恢复：${status}`)
    expectTrue(status.includes('14:00 柳浪闻莺'), `第 4 站未恢复：${status}`)
    const recheck = await textOf(page, sel.recheckCount)
    expectTrue(recheck.includes('2'), `撤销后也应重跑体检：${recheck}`)
    const counts = await textOf(page, sel.healthCounts)
    expectTrue(counts.includes('需确认 1'), `撤销后体检提示应恢复：${counts}`)
    return { status, recheck }
  })
}

export async function runS8MealSequence({ page, rec, screenshot, appOrigin }) {
  await rec.step('补餐入口：体检 meal_gap 条目出现「补一餐」，展示最近空档与 3 个餐饮候选', async () => {
    await openHarness(page, appOrigin, 'variant=meal')
    await page.click(sel.healthToggle)
    await page.waitForSelector(sel.suggestMeal, { timeout: 5000 })
    await page.click(sel.suggestMeal)
    await page.waitForSelector(sel.mealPanel, { timeout: 5000 })

    const slot = await textOf(page, sel.mealSlot)
    expectTrue(slot.includes('午餐 12:00–12:45'), `最近空档异常：${slot}`)
    expectTrue(slot.includes('第 2 站「龙井村」之后'), `插入位置（前一站）异常：${slot}`)
    expectTrue(slot.includes('第 3 站「西湖」之前'), `插入位置（后一站）异常：${slot}`)
    const fallback = await textOf(page, sel.mealWindowFallback)
    expectTrue(fallback.includes('晚餐窗口偏紧'), `S8-36 未优先体检提示窗口：${fallback}`)
    expectTrue(fallback.includes('已改用午餐空档'), `S8-36 回退未显式说明：${fallback}`)
    expectTrue((await textOf(page, sel.mealForkNote)).includes('基于当前行程创建'), '无草稿 fork 提示缺失')

    const count = await page.locator(sel.mealCandidate).count()
    expectTrue(count === 3, `餐饮候选应为 3 个，实际 ${count}`)
    const candidateText = await textOf(page, sel.mealCandidate)
    expectTrue(candidateText.includes('楼外楼餐厅'), `第一候选异常：${candidateText}`)
    return { slot, count }
  })

  await rec.step('插入预览：时间 / 位置 / 相邻 2 段 leg 作废说明；预览不写草稿', async () => {
    await page.locator(sel.mealCandidate).first().getByText('预览插入').click()
    await page.waitForSelector(sel.mealPreview, { timeout: 5000 })
    const preview = await textOf(page, sel.mealPreview)
    expectTrue(preview.includes('12:00–12:45'), `插入时间异常：${preview}`)
    expectTrue(preview.includes('第 2 站「龙井村」之后'), `插入位置异常：${preview}`)
    expectTrue(preview.includes('2 段相邻路线'), `受影响路段数异常：${preview}`)
    expectTrue(preview.includes('路线待重取'), 'leg 作废口径缺失')
    expectTrue((await textOf(page, sel.draftStatus)).includes('未创建草稿'), '预览阶段不应创建草稿')
    return { preview: preview.slice(0, 140) }
  })

  await rec.step('确认插入：站点数 +1、2 段路段待重取、体检重跑；撤销一次恢复', async () => {
    await page.click(sel.mealConfirm)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('12:00 楼外楼餐厅'),
      sel.draftStatus,
      { timeout: 10000 },
    )
    const status = await textOf(page, sel.draftStatus)
    expectTrue(status.includes('09:00 灵隐寺'), '原有首站不应变化')
    expectTrue(status.includes('13:00 西湖'), '原有第 3 站不应变化')
    expectTrue((await textOf(page, sel.stopCount)).includes('5'), '补餐后站点数应为 5')
    expectTrue((await textOf(page, sel.unavailableLegs)).includes('2'), '新站前后应有 2 段待重取路段')
    const recheck = await textOf(page, sel.recheckCount)
    expectTrue(recheck.includes('1') && recheck.includes('第 1 天'), `体检重跑回调异常：${recheck}`)

    await page.locator(sel.mealPanel).scrollIntoViewIfNeeded()
    await screenshot(page, '66-s8-meal.png')

    await page.click(sel.mealUndo)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.textContent?.includes('站点数：4'),
      sel.stopCount,
      { timeout: 10000 },
    )
    const restored = await textOf(page, sel.draftStatus)
    expectTrue(!restored.includes('楼外楼餐厅'), '撤销后新站应移除')
    expectTrue((await textOf(page, sel.unavailableLegs)).includes('0'), '撤销后不应遗留待重取路段')
    expectTrue((await textOf(page, sel.recheckCount)).includes('2'), '撤销后也应重跑体检')
    return { status, restored }
  })

  await rec.step('双库皆空：沉默显示「暂无餐饮候选」，不提供插入', async () => {
    await openHarness(page, appOrigin, 'variant=meal&candidates=empty')
    await page.click(sel.healthToggle)
    await page.waitForSelector(sel.suggestMeal, { timeout: 5000 })
    await page.click(sel.suggestMeal)
    await page.waitForSelector(sel.mealPanel, { timeout: 5000 })

    const empty = await textOf(page, sel.mealEmpty)
    expectTrue(empty.includes('暂无餐饮候选'), `空态文案异常：${empty}`)
    expectTrue(empty.includes('不会编造候选'), '空态未说明不编造候选')
    expectTrue((await page.locator(sel.mealCandidate).count()) === 0, '空态不应出现候选卡')
    expectTrue((await page.locator(sel.mealConfirm).count()) === 0, '空态不应提供确认插入')

    await page.locator(sel.mealPanel).scrollIntoViewIfNeeded()
    await screenshot(page, '67-s8-meal-empty.png')
    return { empty }
  })
}

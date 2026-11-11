/**
 * 五期 S8 · 收尾冒烟场景（从 runner.mjs 编排调用）。
 *
 * 覆盖（冒烟级，不重复 S2–S7 的细粒度断言）：
 * - 可信卡徽章存在性（打开站点详情，至少一个三态徽章）；
 * - 体检卡展开；
 * - 「今天」卡出现；
 * - 分享面板：草稿来源徽章、离线路书预览 + 确认下载（Playwright 捕获 blob 下载）；
 * - 焦点：打开面板后焦点在面板内、Tab 不逃出模态、Esc 关闭后回到入口按钮；
 * - 路线回放：入口 → 面板开 → 瓦片 mock 加载 → 播放一帧 → 暂停；
 * - 语音只做 feature-detect，不点真实发声。
 *
 * 全程离线：/api 由 runner 的契约桩承接，瓦片由 runner 的 route 门禁 fulfill；
 * 本文件不注入页面业务状态，只驱动真实点击。
 */
import { expectTrue } from './sessionResumeScenarios.mjs'

let appOriginFromRunner = null

export function setS8AppOrigin(origin) {
  appOriginFromRunner = origin
}

const sel = {
  tripTitle: 'section[aria-label="行程安排"] h2',
  todayPanel: '[data-testid="today-panel"]',
  todaySpeech: '[data-testid="today-speech"]',
  todayListen: '[data-testid="today-listen-day"]',
  healthCard: '[data-testid="itinerary-health-card"]',
  healthToggle: '[data-testid="health-toggle"]',
  healthItems: '[data-testid="health-items"]',
  stopRow: '[data-testid="stop-row"]',
  stopDetail: '[data-testid="stop-detail"]',
  stopPoiCard: '[data-testid^="stop-poi-card-"]',
  factBadge: '[data-testid^="stop-poi-card-"] [data-status]',
  startEditing: 'button:has-text("编辑这趟行程")',
  draftEditor: '[aria-label="本地行程草稿编辑器"]',
  shareOpen: 'button:has-text("生成分享卡片")',
  shareOverlay: '[data-testid="share-card-overlay"]',
  shareDialog: '[data-testid="share-card-overlay"] [role="dialog"]',
  shareSource: '[data-testid="share-source"]',
  shareDraftRadio: '[data-testid="share-source"] input[value="draft"]',
  shareDraftBadge: '[data-testid="share-draft-badge"]',
  roadbookButton: 'button:has-text("预览离线路书 (.html)")',
  roadbookPreview: '[data-testid="roadbook-preview"]',
  roadbookConfirm: 'button:has-text("确认下载 .html")',
  replayEntry: '[data-testid="route-replay-entry"]',
  replayPanel: '[data-testid="route-replay-panel"]',
  replayMap: '[data-testid="replay-map"]',
  replayPlay: '[data-testid="replay-play-toggle"]',
  replayCounter: '[data-testid="replay-counter"]',
}

async function openApp(page) {
  await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
  const title = (await page.textContent(sel.tripTitle)) ?? ''
  expectTrue(title.includes('契约桩示例'), `首屏不是契约桩示例行程：${title}`)
  return title
}

async function activeElementInside(page, rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector)
    return root !== null && root.contains(document.activeElement)
  }, rootSelector)
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  expectTrue(!overflow, '页面出现横向溢出')
}

async function openSharePanel(page, rec) {
  await rec.step('打开分享卡片面板（按需加载 chunk）', async () => {
    await page.click(sel.shareOpen)
    await page.waitForSelector(sel.shareOverlay, { timeout: 15000 })
    await page.waitForSelector(sel.shareDialog, { timeout: 5000 })
    const focusedInside = await activeElementInside(page, sel.shareDialog)
    expectTrue(focusedInside, '分享面板打开后焦点不在面板内')
    return { focusedInside }
  })
}

async function closeSharePanelWithEsc(page, rec) {
  await rec.step('Esc 关闭分享面板：焦点回到「生成分享卡片」入口', async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector(sel.shareOverlay, { state: 'detached', timeout: 5000 })
    const activeText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
    expectTrue(activeText.includes('生成分享卡片'), `焦点未回到分享入口：${activeText}`)
    return { activeText }
  })
}

export async function runS8SmokeDesktop({ page, rec, screenshot, control }) {
  await rec.step('打开首页加载契约桩示例行程', async () => {
    const title = await openApp(page)
    return { title }
  })

  await rec.step('「今天」卡出现；语音只做 feature-detect（不点真实发声）', async () => {
    await page.waitForSelector(sel.todayPanel, { timeout: 5000 })
    const speechCount = await page.locator(sel.todaySpeech).count()
    expectTrue(speechCount === 1, `今天卡语音区块数量异常：${speechCount}`)
    const listen = page.locator(sel.todayListen)
    const disabled = await listen.isDisabled()
    const statusText = (await page.textContent(sel.todaySpeech)) ?? ''
    // 不点击：只记录当前能力状态，真实发声在无音频设备的 CI 不可断言
    return { speechPresent: true, listenDisabled: disabled, statusText: statusText.slice(0, 80) }
  })

  await rec.step('体检卡展开后出现条目容器', async () => {
    await page.waitForSelector(sel.healthCard, { timeout: 5000 })
    await page.click(sel.healthToggle)
    await page.waitForSelector(sel.healthItems, { timeout: 5000 })
    const summary = (await page.textContent(`${sel.healthCard} [data-testid="health-summary"]`)) ?? ''
    expectTrue(summary.includes('冲突') || summary.includes('待确认'), `体检摘要异常：${summary}`)
    return { summary }
  })

  await rec.step('可信卡徽章存在性：站点详情至少一个三态徽章', async () => {
    await page.locator(sel.stopRow).first().click()
    await page.waitForSelector(sel.stopDetail, { timeout: 5000 })
    await page.waitForSelector(sel.stopPoiCard, { timeout: 5000 })
    const badges = await page.$$eval(sel.factBadge, (nodes) =>
      nodes.map((node) => ({
        status: node.getAttribute('data-status') ?? '',
        text: node.textContent?.trim() ?? '',
      })),
    )
    expectTrue(badges.length >= 1, '可信卡没有三态徽章')
    expectTrue(
      badges.every((badge) => ['sourced', 'unverified', 'unknown'].includes(badge.status)),
      `徽章状态非法：${JSON.stringify(badges)}`,
    )
    return { badgeCount: badges.length, statuses: badges.map((badge) => badge.status) }
  })
  await screenshot(page, '39-s8-smoke-today-health-trust.png')

  await rec.step('进入草稿编辑（分享面板出现草稿来源）', async () => {
    await page.click(sel.startEditing)
    await page.waitForSelector(sel.draftEditor, { timeout: 5000 })
    return { draftOpen: true }
  })

  await openSharePanel(page, rec)

  await rec.step('分享来源切到草稿：草稿徽章出现', async () => {
    await page.waitForSelector(sel.shareSource, { timeout: 5000 })
    await page.click(sel.shareDraftRadio)
    await page.waitForSelector(sel.shareDraftBadge, { timeout: 5000 })
    const badge = (await page.textContent(sel.shareDraftBadge)) ?? ''
    expectTrue(badge.includes('草稿未应用'), `草稿徽章文案异常：${badge}`)
    return { badge: badge.slice(0, 60) }
  })

  await rec.step('模态 Tab 圈定：连按 Tab 焦点始终在分享面板内', async () => {
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab')
      const inside = await activeElementInside(page, sel.shareDialog)
      expectTrue(inside, `第 ${i + 1} 次 Tab 后焦点逃出分享面板`)
    }
    return { tabs: 12, trapped: true }
  })

  await rec.step('离线路书：预览 → 确认下载 .html（blob 下载）', async () => {
    await page.click(sel.roadbookButton)
    const frame = await page.waitForSelector(sel.roadbookPreview, { timeout: 15000 })
    const srcdoc = (await frame.getAttribute('srcdoc')) ?? ''
    expectTrue(srcdoc.startsWith('<!doctype html>'), '离线路书预览不是完整 HTML')
    expectTrue(srcdoc.includes('契约桩示例'), '离线路书预览缺少行程标题')

    const downloadPromise = page.waitForEvent('download', { timeout: 15000 })
    await page.click(sel.roadbookConfirm)
    const download = await downloadPromise
    const fileName = download.suggestedFilename()
    expectTrue(fileName.endsWith('.html'), `下载文件名不是 .html：${fileName}`)
    const saved = await download.path()
    expectTrue(Boolean(saved), '离线路书下载没有落盘路径')
    return { fileName, bytes: srcdoc.length }
  })
  await screenshot(page, '40-s8-smoke-share-draft-roadbook.png')

  await closeSharePanelWithEsc(page, rec)

  await rec.step('路线回放入口 → 面板打开 → 瓦片 mock 加载', async () => {
    await page.click(sel.replayEntry)
    await page.waitForSelector(sel.replayPanel, { timeout: 15000 })
    await page.waitForSelector(`${sel.replayPanel} .leaflet-tile-loaded`, { timeout: 15000 })
    const stationCount = Number(
      (await page.getAttribute(sel.replayPanel, 'data-station-count')) ?? '0',
    )
    expectTrue(stationCount > 0, `回放站点数异常：${stationCount}`)
    const focusedInside = await activeElementInside(page, sel.replayPanel)
    expectTrue(focusedInside, '回放面板打开后焦点不在面板内')
    return { stationCount }
  })

  await rec.step('播放一帧后暂停：data-playing 真实切换', async () => {
    await page.click(sel.replayPlay)
    await page.waitForFunction(
      () => document.querySelector('[data-testid="route-replay-panel"]')?.getAttribute('data-playing') === 'true',
      undefined,
      { timeout: 5000 },
    )
    const counterWhilePlaying = (await page.textContent(sel.replayCounter)) ?? ''
    await page.click(sel.replayPlay)
    await page.waitForFunction(
      () => document.querySelector('[data-testid="route-replay-panel"]')?.getAttribute('data-playing') === 'false',
      undefined,
      { timeout: 5000 },
    )
    return { counterWhilePlaying }
  })
  await screenshot(page, '41-s8-smoke-replay.png')

  await rec.step('Esc 关闭回放：焦点回到「路线回放」入口', async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector(sel.replayPanel, { state: 'detached', timeout: 5000 })
    const activeText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
    expectTrue(activeText.includes('路线回放'), `焦点未回到回放入口：${activeText}`)
    return { activeText }
  })

  await rec.step('语音零请求：整个过程没有新增 /api 语音端点', async () => {
    const speechPaths = control.requests.filter((request) => /speech|voice|tts/i.test(request.path))
    expectTrue(speechPaths.length === 0, `出现语音网络请求：${JSON.stringify(speechPaths)}`)
    return { speechPaths: 0 }
  })
}

export async function runS8SmokeNarrow({ page, rec, screenshot }) {
  await rec.step('375 窄屏打开首页并加载示例行程', async () => {
    const title = await openApp(page)
    await assertNoHorizontalOverflow(page)
    return { title }
  })

  await rec.step('窄屏「今天」卡与体检卡可见，体检可展开', async () => {
    await page.waitForSelector(sel.todayPanel, { timeout: 5000 })
    await page.waitForSelector(sel.healthCard, { timeout: 5000 })
    await page.click(sel.healthToggle)
    await page.waitForSelector(sel.healthItems, { timeout: 5000 })
    await assertNoHorizontalOverflow(page)
    return { today: true, healthOpen: true }
  })
  await screenshot(page, '42-s8-smoke-narrow-today-health.png')

  await openSharePanel(page, rec)
  await rec.step('窄屏分享面板无横向溢出', async () => {
    await assertNoHorizontalOverflow(page)
    return { overflow: false }
  })
  await screenshot(page, '43-s8-smoke-narrow-share.png')
  await closeSharePanelWithEsc(page, rec)

  await rec.step('窄屏路线回放：面板打开 + 瓦片 mock 加载', async () => {
    await page.click(sel.replayEntry)
    await page.waitForSelector(sel.replayPanel, { timeout: 15000 })
    await page.waitForSelector(`${sel.replayPanel} .leaflet-tile-loaded`, { timeout: 15000 })
    await assertNoHorizontalOverflow(page)
    return { replayOpen: true }
  })
  await screenshot(page, '44-s8-smoke-narrow-replay.png')

  await rec.step('窄屏 Esc 关闭回放', async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector(sel.replayPanel, { state: 'detached', timeout: 5000 })
    return { closed: true }
  })
}

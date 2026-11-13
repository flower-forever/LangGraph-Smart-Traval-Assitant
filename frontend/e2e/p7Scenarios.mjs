/**
 * 七期 S8 · 三条离线 E2E 补测（从 runner.mjs 编排调用）。
 *
 * 覆盖：
 * A. 落印 StampSeal：规划成功后出现、自动退场；reduced-motion 下不跑微震且仍退场。
 * B. 换一换 + 地图 fly-to：候选池手工新增 → 草稿内替换 → li[data-swap-anim] 出现并摘除
 *    → 撤销反向 → reduced-motion 动画瞬时 → Esc 关闭 → 选中未替换站点触发真实 fly-to。
 * C. 电影模式 + 片尾彩蛋：片头标题卡 → 正片推进到 finished → credits 可读文本 →
 *    定格尾帧 → Esc 退出电影模式 / 关闭面板。
 *
 * 全程离线：/api 由 runner 契约桩承接；瓦片由 runner 的 route 门禁 fulfill；
 * 不注入页面业务状态，只驱动真实 UI（候选池写入走面板既有可见表单）。
 */
import { expectTrue } from './sessionResumeScenarios.mjs'

let appOriginFromRunner = null

export function setP7AppOrigin(origin) {
  appOriginFromRunner = origin
}

const sel = {
  destinationInput: 'input[placeholder="例如：杭州"]',
  submitPlan: 'button:has-text("生成行程")',
  tripTitle: 'section[aria-label="行程安排"] h2',
  stamp: '[data-testid="stamp-seal"]',
  startEditing: 'button:has-text("编辑这趟行程")',
  draftEditor: '[aria-label="本地行程草稿编辑器"]',
  swapEntry: '[data-testid^="stop-swap-open-"]',
  swapPanel: '[data-testid="stop-swap-panel"]',
  swapCandidate: '[data-testid="stop-swap-candidate"]',
  swapPreview: '[data-testid="stop-swap-preview"]',
  candidatePoolTool: 'button:has-text("候选地点池")',
  candidatePoolPanel: '[data-testid="candidate-pool-panel"]',
  manualForm: 'form[aria-label="手工新增候选表单"]',
  replayEntry: '[data-testid="route-replay-entry"]',
  replayPanel: '[data-testid="route-replay-panel"]',
  replayNext: '[data-testid="replay-next"]',
  replayPlay: '[data-testid="replay-play-toggle"]',
  replaySpeed2: '[data-testid="replay-speed-2"]',
  cinemaToggle: '[data-testid="replay-cinema-toggle"]',
  cinemaTitle: '[data-testid="cinema-title-card"]',
  cinemaCredits: '[data-testid="cinema-credits"]',
  mapPane: '[aria-label="交互式地图"] .leaflet-map-pane',
  mapPopup: '[aria-label="交互式地图"] .leaflet-popup',
}

async function openApp(page) {
  await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
  return (await page.textContent(sel.tripTitle)) ?? ''
}

async function planTrip(page, destination = '杭州') {
  await page.fill(sel.destinationInput, destination)
  await page.click(sel.submitPlan)
  const stamp = await page.waitForSelector(sel.stamp, { timeout: 20000 })
  expectTrue(await stamp.isVisible(), '规划成功后落印不可见')
  return stamp
}

/** 把 computed animation-duration 统一换算成毫秒，便于跨浏览器字符串格式比较。 */
function durationToMs(raw) {
  const text = raw.trim()
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY
  return text.endsWith('ms') ? value : value * 1000
}

/**
 * 地图视图快照（纯 DOM 可观察数据）。
 *
 * Leaflet 的 flyTo 在「缩放级别不变」时不会改 .leaflet-map-pane 的 transform，
 * 而是重排 marker 与瓦片的 translate —— 所以以 marker / 瓦片位置作为视图变化证据，
 * 不硬读 React/Leaflet 内部状态。
 */
async function readMapSnapshot(page) {
  return page.evaluate(() => {
    const container = document.querySelector('[aria-label="交互式地图"]')
    const pane = container?.querySelector('.leaflet-map-pane')
    const rect = container?.getBoundingClientRect()
    const markers = [...(container?.querySelectorAll('.leaflet-marker-icon') ?? [])]
      .map((element) => {
        const markerRect = element.getBoundingClientRect()
        const dx = markerRect.left + markerRect.width / 2 - (rect ? rect.left + rect.width / 2 : 0)
        const dy = markerRect.top + markerRect.height / 2 - (rect ? rect.top + rect.height / 2 : 0)
        return {
          label: element.getAttribute('aria-label') ?? '',
          distance: Math.hypot(dx, dy),
          style: element.style.transform,
        }
      })
      .sort((left, right) => left.label.localeCompare(right.label))
    const tiles = [...(container?.querySelectorAll('.leaflet-tile') ?? [])]
      .map((element) => element.style.transform)
      .sort()
    return { transform: pane?.style.transform ?? '', markers, tiles }
  })
}

function flattenMapSnapshot(snapshot) {
  return {
    transform: snapshot.transform,
    markers: snapshot.markers.map((marker) => marker.style).join('|'),
    tiles: snapshot.tiles.join('|'),
  }
}

/* ───────────────────────── A · 落印 ───────────────────────── */

export async function runP7StampScenario({ page, rec, screenshot }) {
  await rec.step('打开首页并生成行程：落印出现且带 data-reduced=false', async () => {
    await openApp(page)
    const stamp = await planTrip(page)
    const title = (await page.textContent(sel.tripTitle)) ?? ''
    expectTrue(title.includes('AI 契约桩'), `生成后标题异常：${title}`)
    const reduced = await page.getAttribute(sel.stamp, 'data-reduced')
    expectTrue(reduced === 'false', `普通模式落印 data-reduced 异常：${reduced}`)
    const animationName = await page.evaluate(
      (selector) => getComputedStyle(document.querySelector(selector)).animationName,
      sel.stamp,
    )
    expectTrue(animationName.includes('oc-stamp-jolt'), `普通模式缺少盖章微震：${animationName}`)
    await screenshot(page, '70-p7-stamp-seal.png')
    return { title, reduced, animationName }
  })

  await rec.step('落印自动退场：DOM 卸载且页面仍可交互', async () => {
    await page.waitForSelector(sel.stamp, { state: 'detached', timeout: 6000 })
    // 不卡死：退场后行程区仍可点击进入草稿编辑
    await page.click(sel.startEditing)
    await page.waitForSelector(sel.draftEditor, { timeout: 5000 })
    return { detached: true }
  })

  await rec.step('reduced-motion 再规划一次：不跑微震，仍自动退场', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
    await planTrip(page)
    const reduced = await page.getAttribute(sel.stamp, 'data-reduced')
    expectTrue(reduced === 'true', `reduced 模式落印 data-reduced 异常：${reduced}`)
    const animationName = await page.evaluate(
      (selector) => getComputedStyle(document.querySelector(selector)).animationName,
      sel.stamp,
    )
    expectTrue(!animationName.includes('oc-stamp-jolt'), `reduced 模式仍播放盖章微震：${animationName}`)
    const animationDuration = await page.evaluate(
      (selector) => getComputedStyle(document.querySelector(selector)).animationDuration,
      sel.stamp,
    )
    expectTrue(
      durationToMs(animationDuration) <= 1,
      `reduced 模式入场动画未退化：${animationDuration}`,
    )
    await page.waitForSelector(sel.stamp, { state: 'detached', timeout: 6000 })
    return { reduced, animationName, animationDuration }
  })

  // 恢复未指定媒体状态，避免后续 runner 复用同 context 时受残留影响（本场景随即关闭 context）。
  await page.emulateMedia({ reducedMotion: 'no-preference' }).catch(() => {})
}

/* ───────────────────────── B · 换一换 + 地图 fly-to ───────────────────────── */

async function addSwapCandidateFromPanel(page, rec) {
  await rec.step('候选池手工新增一条替换候选（真实面板表单）', async () => {
    await page.click(sel.candidatePoolTool)
    await page.waitForSelector(sel.candidatePoolPanel, { timeout: 15000 })
    const form = page.locator(sel.manualForm)
    await form.waitFor({ timeout: 5000 })
    await page.getByLabel('候选名称').fill('E2E 换一候选地点')
    await page.getByLabel('经度（可选）').fill('120.155')
    await page.getByLabel('纬度（可选）').fill('30.255')
    await form.locator('button[type="submit"]').click()
    await page.waitForFunction(
      (selector) =>
        document.querySelector(selector)?.textContent?.includes('E2E 换一候选地点') ?? false,
      sel.candidatePoolPanel,
      { timeout: 5000 },
    )
    await page.click(`${sel.candidatePoolPanel} button:has-text("收起")`)
    await page.waitForSelector(sel.candidatePoolPanel, { state: 'detached', timeout: 5000 })
    return { candidate: 'E2E 换一候选地点' }
  })
}

export async function runP7SwapFlyToScenario({ page, rec, screenshot }) {
  await rec.step('打开首页加载契约桩示例行程', async () => {
    const title = await openApp(page)
    expectTrue(title.includes('契约桩示例'), `首屏不是契约桩示例行程：${title}`)
    return { title }
  })

  await addSwapCandidateFromPanel(page, rec)

  await rec.step('进入草稿编辑并打开「换一个」面板', async () => {
    await page.click(sel.startEditing)
    await page.waitForSelector(sel.draftEditor, { timeout: 5000 })
    const entry = page.locator(sel.swapEntry).first()
    const entryTestId = await entry.getAttribute('data-testid')
    expectTrue(Boolean(entryTestId), '未找到换一换入口 data-testid')
    const stopId = entryTestId.replace('stop-swap-open-', '')
    await entry.click()
    await page.waitForSelector(sel.swapPanel, { timeout: 5000 })
    await page.waitForSelector(sel.swapCandidate, { timeout: 5000 })
    return { stopId, entryTestId }
  })

  const swapEvidence = await rec.step('预览并确认替换：li[data-swap-anim=forward] 出现后摘除', async () => {
    const entryTestId = await page.locator(sel.swapEntry).first().getAttribute('data-testid')
    const stopId = entryTestId.replace('stop-swap-open-', '')
    const rowSelector = `li:has([data-testid="stop-swap-open-${stopId}"])`
    const candidate = page.locator(sel.swapCandidate).first()
    const candidateName = ((await candidate.locator('span').first().textContent()) ?? '').trim()
    expectTrue(candidateName.length > 0, '候选名称为空')
    await candidate.locator('button:has-text("预览替换")').click()
    await page.waitForSelector(sel.swapPreview, { timeout: 5000 })
    await page.locator(`${sel.swapPreview} button:has-text("确认替换")`).click()
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-swap-anim') === 'forward',
      rowSelector,
      { timeout: 3000 },
    )
    const animAtPeak = await page.getAttribute(rowSelector, 'data-swap-anim')
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-swap-anim') === null,
      rowSelector,
      { timeout: 3000 },
    )
    const rowText = (await page.textContent(rowSelector)) ?? ''
    expectTrue(rowText.includes(candidateName), `替换后站点行未出现候选名：${candidateName}`)
    return { stopId, rowSelector, candidateName, animAtPeak }
  })

  await rec.step('撤销这次更换：li[data-swap-anim=backward] 出现后摘除', async () => {
    await page.click(`${sel.swapPanel} button:has-text("撤销这次更换")`)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-swap-anim') === 'backward',
      swapEvidence.rowSelector,
      { timeout: 3000 },
    )
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-swap-anim') === null,
      swapEvidence.rowSelector,
      { timeout: 3000 },
    )
    return { animAtPeak: 'backward', cleared: true }
  })

  await rec.step('reduced-motion 再替换：动画时长退化到 ≤1ms，标注随后摘除', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator(`${sel.swapCandidate} button:has-text("预览替换")`).first().click()
    await page.waitForSelector(sel.swapPreview, { timeout: 5000 })
    await page.locator(`${sel.swapPreview} button:has-text("确认替换")`).click()
    const handle = await page.waitForFunction(
      (selector) => {
        const element = document.querySelector(selector)
        if (!element || element.getAttribute('data-swap-anim') !== 'forward') return null
        return {
          anim: element.getAttribute('data-swap-anim'),
          duration: getComputedStyle(element).animationDuration,
        }
      },
      swapEvidence.rowSelector,
      { timeout: 3000 },
    )
    const evidence = await handle.jsonValue()
    expectTrue(
      durationToMs(evidence.duration) <= 1,
      `reduced-motion 下换一翻卡未瞬时完成：${evidence.duration}`,
    )
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-swap-anim') === null,
      swapEvidence.rowSelector,
      { timeout: 3000 },
    )
    return evidence
  })

  await rec.step('Esc 关闭「换一个」面板', async () => {
    await page.keyboard.press('Escape')
    await page.waitForSelector(sel.swapPanel, { state: 'detached', timeout: 5000 })
    return { closed: true }
  })

  await rec.step('地图 fly-to：选中未替换站点后地图视图与弹窗真实变化', async () => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const before = await readMapSnapshot(page)
    expectTrue(before.markers.length >= 1, '地图没有可观测 marker')
    const farthest = [...before.markers].sort((left, right) => right.distance - left.distance)[0]
    const name = farthest.label
      .replace(/^站点 \d+：/, '')
      .replace(/（当前选中）/, '')
      .replace(/，按回车查看讲解$/, '')
    const rowButton = page
      .locator('button[aria-label^="在地图中查看"]')
      .filter({ hasText: name })
      .first()
    expectTrue((await rowButton.count()) === 1, `草稿里找不到可点击站点行：${name}`)
    const beforeFlat = flattenMapSnapshot(before)
    await rowButton.click()
    await page.waitForFunction(
      ({ beforeFlat }) => {
        const container = document.querySelector('[aria-label="交互式地图"]')
        const pane = container?.querySelector('.leaflet-map-pane')
        const markers = [...(container?.querySelectorAll('.leaflet-marker-icon') ?? [])]
          .map((element) => element.style.transform)
          .sort()
          .join('|')
        const tiles = [...(container?.querySelectorAll('.leaflet-tile') ?? [])]
          .map((element) => element.style.transform)
          .sort()
          .join('|')
        return (
          (pane?.style.transform ?? '') !== beforeFlat.transform ||
          markers !== beforeFlat.markers ||
          tiles !== beforeFlat.tiles
        )
      },
      { beforeFlat },
      { timeout: 5000 },
    )
    await page.waitForSelector(sel.mapPopup, { timeout: 5000 })
    // flyTo 时长 0.75s；等动画落定后再取稳定快照作为证据。
    await page.waitForTimeout(900)
    const after = await readMapSnapshot(page)
    const afterFlat = flattenMapSnapshot(after)
    expectTrue(
      JSON.stringify(afterFlat) !== JSON.stringify(beforeFlat),
      '地图视图（marker / 瓦片位置）未变化',
    )
    const activeLabels = await page.$$eval('.leaflet-marker-icon[aria-pressed="true"]', (nodes) =>
      nodes.map((node) => node.getAttribute('aria-label') ?? ''),
    )
    expectTrue(activeLabels.length === 1, `选中 marker 数量异常：${activeLabels.length}`)
    expectTrue(activeLabels[0].includes(name), `选中 marker 不是点击的站点：${activeLabels[0]}`)
    await page.locator('[aria-label="交互式地图"]').scrollIntoViewIfNeeded()
    await screenshot(page, '71-p7-swap-map-flyto.png')
    return { name, before: beforeFlat, after: afterFlat, activeMarker: activeLabels[0] }
  })
}

/* ───────────────────────── C · 电影模式 + 台词彩蛋 ───────────────────────── */

export async function runP7CinemaScenario({ page, rec, screenshot }) {
  await rec.step('打开路线回放并进入电影模式：片头标题卡出现', async () => {
    const title = await openApp(page)
    expectTrue(title.includes('契约桩示例'), `首屏不是契约桩示例行程：${title}`)
    await page.click(sel.replayEntry)
    await page.waitForSelector(sel.replayPanel, { timeout: 15000 })
    await page.click(sel.cinemaToggle)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-cinema-phase') === 'title',
      sel.replayPanel,
      { timeout: 3000 },
    )
    await page.waitForSelector(sel.cinemaTitle, { timeout: 3000 })
    const titleText = ((await page.textContent(sel.cinemaTitle)) ?? '').trim()
    const cinema = await page.getAttribute(sel.replayPanel, 'data-cinema')
    const overlayCount = await page.locator('[data-testid="route-replay-overlay"]').count()
    expectTrue(cinema === 'true', `电影模式 data-cinema 异常：${cinema}`)
    expectTrue(overlayCount === 1, `电影模式遮罩数量异常：${overlayCount}`)
    expectTrue(titleText.length > 0, '片头标题卡没有可读文本')
    expectTrue(titleText.includes('杭州'), `片头标题卡缺少目的地：${titleText}`)
    return { titleText: titleText.slice(0, 80), cinema }
  })

  await rec.step('点击片头跳过 → 正片推进到 finished', async () => {
    await page.click(sel.cinemaTitle)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-cinema-phase') === 'playing',
      sel.replayPanel,
      { timeout: 3000 },
    )
    // 走到最后一站（next 在末站禁用），再用 2x 播放让最后一站的自然停留走完 → finished。
    for (let index = 0; index < 10; index += 1) {
      const next = page.locator(sel.replayNext)
      if (await next.isDisabled()) break
      await next.click()
      await page.waitForTimeout(30)
    }
    await page.click(sel.replaySpeed2)
    await page.click(sel.replayPlay)
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-phase') === 'finished',
      sel.replayPanel,
      { timeout: 8000 },
    )
    const phase = await page.getAttribute(sel.replayPanel, 'data-phase')
    expectTrue(phase === 'finished', `正片未推进到 finished：${phase}`)
    await page.waitForSelector(sel.cinemaCredits, { timeout: 5000 })
    return { phase }
  })

  await rec.step('credits 可读文本与箴言存在，滚动到定格尾帧', async () => {
    const creditsText = ((await page.textContent(sel.cinemaCredits)) ?? '').trim()
    expectTrue(creditsText.length > 0, 'credits 文本为空')
    expectTrue(creditsText.includes('路线与时间仅为参考'), 'credits 缺既有免责口径')
    const quote = (
      (await page.textContent(`${sel.cinemaCredits} .oc-cinema-credits-quote`)) ?? ''
    ).trim()
    expectTrue(quote.length > 0, 'credits 箴言为空')
    expectTrue(await page.locator(sel.cinemaCredits).isVisible(), 'credits 不可见')
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-settled') === 'true',
      sel.cinemaCredits,
      { timeout: 8000 },
    )
    await page.locator(sel.cinemaCredits).scrollIntoViewIfNeeded().catch(() => {})
    await screenshot(page, '72-p7-cinema-credits.png')
    return { creditsLength: creditsText.length, quote: quote.slice(0, 40) }
  })

  await rec.step('Esc 退出电影模式，再 Esc 关闭回放面板', async () => {
    await page.keyboard.press('Escape')
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute('data-cinema') === 'false',
      sel.replayPanel,
      { timeout: 3000 },
    )
    await page.waitForSelector(sel.cinemaCredits, { state: 'detached', timeout: 3000 })
    await page.keyboard.press('Escape')
    await page.waitForSelector(sel.replayPanel, { state: 'detached', timeout: 5000 })
    return { exitedCinema: true, closedPanel: true }
  })
}

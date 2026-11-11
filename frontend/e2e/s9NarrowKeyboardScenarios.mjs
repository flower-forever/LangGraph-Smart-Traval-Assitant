/**
 * 六期 S9 · 五期收编的两条键盘回归场景。
 *
 * ① 375 三面板键盘可达性：分享 / 回放 / 换一在 375 视口都能用键盘打开，
 *    焦点进入面板，分享与回放保持模态 Tab 圈定，Esc 能关闭并把焦点还给入口；
 *    换一是非模态内联面板（WCAG 2.1.2 不圈定），Tab 能遍历面板内控件。
 * ② 换一焦点落点：五期 I-1 的回归断言——Esc 关闭后焦点必须回到同一颗
 *    「换一个」入口，而不是 document.body（入口在面板打开期间被 disabled）。
 *
 * 全程离线：/api 由 runner 契约桩承接；瓦片由 runner 门禁 fulfill。
 */
import { expectTrue } from './sessionResumeScenarios.mjs'

let appOriginFromRunner = null

export function setS9AppOrigin(origin) {
  appOriginFromRunner = origin
}

const sel = {
  tripTitle: 'section[aria-label="行程安排"] h2',
  startEditing: 'button:has-text("编辑这趟行程")',
  draftEditor: '[aria-label="本地行程草稿编辑器"]',
  shareOpen: 'button:has-text("生成分享卡片")',
  shareOverlay: '[data-testid="share-card-overlay"]',
  shareDialog: '[data-testid="share-card-overlay"] [role="dialog"]',
  replayEntry: '[data-testid="route-replay-entry"]',
  replayPanel: '[data-testid="route-replay-panel"]',
  swapEntry: '[data-testid^="stop-swap-open-"]',
  swapPanel: '[data-testid="stop-swap-panel"]',
}

async function openApp(page) {
  await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
}

async function activeInside(page, rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector)
    return root !== null && root.contains(document.activeElement)
  }, rootSelector)
}

/**
 * 焦点归属证据：元素身份而不是文字包含。
 * - inside：焦点在指定容器内（容器本身为 document.body 时不算）
 * - sameAsExpected：焦点就是打开面板的那颗入口元素（ElementHandle 同一性）
 * - isBody：焦点丢失到 document.body
 * 入口按钮的文字在 body.textContent 里同样存在，文字断言会把 body 焦点误判为通过。
 */
async function focusState(page, rootSelector = null, expectedHandle = null) {
  return page.evaluate(
    ({ selector, hasExpected, expected }) => {
      const active = document.activeElement
      const root = selector ? document.querySelector(selector) : null
      return {
        isBody: active === document.body,
        inside: root !== null && root !== document.body && root.contains(active),
        sameAsExpected: hasExpected && active === expected,
        tag: active?.tagName ?? '',
        testId: active?.getAttribute('data-testid') ?? '',
        label: active?.getAttribute('aria-label') ?? '',
        text: active?.textContent?.trim().slice(0, 30) ?? '',
      }
    },
    { selector: rootSelector, hasExpected: expectedHandle !== null, expected: expectedHandle },
  )
}

async function focusEntry(page, selector) {
  const handle = await page.locator(selector).first().elementHandle()
  const meta = await handle.evaluate((el) => ({
    found: el !== null,
    tag: el?.tagName ?? '',
    testId: el?.getAttribute('data-testid') ?? '',
    label: el?.getAttribute('aria-label') ?? '',
    text: el?.textContent?.trim().slice(0, 30) ?? '',
  }))
  return { handle, ...meta }
}

async function openDraftEditor(page) {
  await page.click(sel.startEditing)
  await page.waitForSelector(sel.draftEditor, { timeout: 5000 })
}

export async function runS9NarrowKeyboard({ page, rec }) {
  await rec.step('375 打开首页并加载契约桩行程', async () => {
    await openApp(page)
    return { viewport: await page.evaluate(() => `${innerWidth}x${innerHeight}`) }
  })

  await rec.step('分享面板：键盘打开 → 焦点入面板 → Tab 20 次不逃逸 → Esc 关闭归还入口', async () => {
    const shareEntry = await focusEntry(page, sel.shareOpen)
    expectTrue(shareEntry.found && shareEntry.tag === 'BUTTON', '未找到「生成分享卡片」入口按钮')
    await shareEntry.handle.evaluate((el) => el.focus())
    await page.keyboard.press('Enter')
    await page.waitForSelector(sel.shareOverlay, { timeout: 15000 })
    await page.waitForSelector(sel.shareDialog, { timeout: 5000 })
    const opened = await focusState(page, sel.shareDialog)
    expectTrue(!opened.isBody, '分享面板打开后焦点落在 body')
    expectTrue(opened.inside, `分享面板打开后焦点不在面板内：${opened.tag}`)
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab')
      expectTrue(await activeInside(page, sel.shareDialog), `分享面板第 ${i + 1} 次 Tab 后焦点逃逸`)
    }
    await page.keyboard.press('Escape')
    await page.waitForSelector(sel.shareOverlay, { state: 'detached', timeout: 5000 })
    const returned = await focusState(page, sel.shareDialog, shareEntry.handle)
    expectTrue(!returned.isBody, '分享关闭后焦点丢失到 body')
    expectTrue(
      returned.sameAsExpected,
      `分享关闭后焦点未回到打开它的同一入口：${returned.testId || returned.tag}「${returned.text}」≠ ${shareEntry.testId || shareEntry.text}`,
    )
    return { tabs: 20, returnFocus: returned.testId || returned.text }
  })

  await rec.step('回放面板：键盘打开 → 焦点入面板 → Tab 20 次不逃逸 → Esc 关闭归还入口', async () => {
    const replayEntry = await focusEntry(page, sel.replayEntry)
    expectTrue(replayEntry.found && replayEntry.tag === 'BUTTON', '未找到「路线回放」入口按钮')
    await replayEntry.handle.evaluate((el) => el.focus())
    await page.keyboard.press('Enter')
    await page.waitForSelector(sel.replayPanel, { timeout: 15000 })
    const opened = await focusState(page, sel.replayPanel)
    expectTrue(!opened.isBody, '回放面板打开后焦点落在 body')
    expectTrue(opened.inside, `回放面板打开后焦点不在面板内：${opened.tag}`)
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab')
      expectTrue(await activeInside(page, sel.replayPanel), `回放面板第 ${i + 1} 次 Tab 后焦点逃逸`)
    }
    await page.keyboard.press('Escape')
    await page.waitForSelector(sel.replayPanel, { state: 'detached', timeout: 5000 })
    const returned = await focusState(page, sel.replayPanel, replayEntry.handle)
    expectTrue(!returned.isBody, '回放关闭后焦点丢失到 body')
    expectTrue(
      returned.sameAsExpected,
      `回放关闭后焦点未回到打开它的同一入口：${returned.testId || returned.tag}「${returned.text}」≠ ${replayEntry.testId || replayEntry.text}`,
    )
    return { tabs: 20, returnFocus: returned.testId || returned.text }
  })

  await rec.step('换一面板：键盘打开 → 焦点入面板 → Tab 可达关闭/候选控件 → Esc 关闭', async () => {
    await openDraftEditor(page)
    const entry = page.locator(sel.swapEntry).first()
    await entry.focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector(sel.swapPanel, { timeout: 5000 })
    expectTrue(await activeInside(page, sel.swapPanel), '换一面板打开后焦点不在面板内')

    const controlCount = await page.evaluate((selector) => {
      const root = document.querySelector(selector)
      if (!root) return 0
      return Array.from(root.querySelectorAll('button, input, select, textarea, a[href]')).filter(
        (node) => !node.disabled,
      ).length
    }, sel.swapPanel)
    expectTrue(controlCount > 0, '换一面板没有可键盘聚焦的控件')

    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Tab')
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? '')
    expectTrue(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(focusedTag), `换一面板 Tab 未落到控件：${focusedTag}`)

    await page.keyboard.press('Escape')
    await page.waitForSelector(sel.swapPanel, { state: 'detached', timeout: 5000 })
    return { controls: controlCount, tabs: 3, closed: true }
  })
}

export async function runS9SwapFocus({ page, rec }) {
  await rec.step('375 进入草稿编辑，键盘打开「换一个」内联面板', async () => {
    await openApp(page)
    await openDraftEditor(page)
    const entry = page.locator(sel.swapEntry).first()
    await entry.focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector(sel.swapPanel, { timeout: 5000 })
    const inside = await activeInside(page, sel.swapPanel)
    expectTrue(inside, '换一面板打开后焦点不在面板内')
    return { inside }
  })

  await rec.step('面板打开期间入口 disabled（I-1 根因条件仍成立）', async () => {
    const disabled = await page.locator(sel.swapEntry).first().isDisabled()
    expectTrue(disabled, '面板打开时入口未被 disabled，回归条件已变化')
    return { entryDisabled: disabled }
  })

  await rec.step('Tab 后 Esc：焦点落回同一颗「换一个」入口，且不是 body / 已恢复可用', async () => {
    const entryTestId = await page.locator(sel.swapEntry).first().getAttribute('data-testid')
    const entryLabel = await page.locator(sel.swapEntry).first().getAttribute('aria-label')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Escape')
    await page.waitForSelector(sel.swapPanel, { state: 'detached', timeout: 5000 })
    const focused = await page.evaluate(() => {
      const el = document.activeElement
      return {
        isBody: el === document.body,
        testId: el?.getAttribute('data-testid') ?? '',
        label: el?.getAttribute('aria-label') ?? '',
        disabled: el instanceof HTMLButtonElement ? el.disabled : null,
      }
    })
    expectTrue(!focused.isBody, 'Esc 后焦点丢失到 body')
    expectTrue(focused.testId === entryTestId, `焦点未回到同一入口：${focused.testId} ≠ ${entryTestId}`)
    expectTrue(focused.label === entryLabel, `焦点入口 aria-label 不一致：${focused.label}`)
    expectTrue(focused.disabled === false, '焦点入口仍处于 disabled')
    return { focused: focused.testId, label: focused.label }
  })
}

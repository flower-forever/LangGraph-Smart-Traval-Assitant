/**
 * 七期 S2 · 四个 workspace 工具面板「打开即加载且功能不破」E2E。
 *
 * 每个面板独立一个场景（与计划 §6「4 × E2E」逐条对应）：
 * - AnchorsPanel / ConstraintsPanel / ChecklistPanel 需要先关联工作区；
 * - CandidatePoolPanel 是独立键，不依赖工作区。
 *
 * 除面板内容可见外，还记录面板源码模块请求：
 * 首屏必须 0 次，点击后必须 ≥1 次——证明 React.lazy 真的按需加载。
 * 全程离线，不注入页面业务状态，只驱动真实按钮。
 */
import { expectTrue } from './sessionResumeScenarios.mjs'

let appOriginFromRunner = null

export function setP7LazyAppOrigin(origin) {
  appOriginFromRunner = origin
}

const sel = {
  tripTitle: 'section[aria-label="行程安排"] h2',
  createWorkspace: 'button:has-text("用当前行程新建工作区")',
  saveWorkspace: 'button:has-text("保存工作区")',
  anchorsButton: 'button:has-text("住宿与抵离锚点")',
  constraintsButton: 'button:has-text("必去点与预约时间约束")',
  checklistButton: 'button:has-text("准备清单")',
  candidatePoolButton: 'button:has-text("候选地点池")',
}

const PANELS = {
  anchors: {
    name: 'AnchorsPanel',
    button: sel.anchorsButton,
    ready: '[data-testid="anchors-panel"]',
    content: '[data-testid="anchors-day-1"]',
    module: '/src/components/AnchorsPanel.tsx',
    needsWorkspace: true,
    screenshot: '97-p7-lazy-anchors.png',
  },
  constraints: {
    name: 'ConstraintsPanel',
    button: sel.constraintsButton,
    ready: '[data-testid="constraints-panel"]',
    content: '[data-testid="constraints-panel"] h2',
    module: '/src/components/ConstraintsPanel.tsx',
    needsWorkspace: true,
    screenshot: '98-p7-lazy-constraints.png',
  },
  checklist: {
    name: 'ChecklistPanel',
    button: sel.checklistButton,
    ready: '[data-testid="checklist-panel"]',
    content: '[data-testid="checklist-panel"] h2',
    module: '/src/components/ChecklistPanel.tsx',
    needsWorkspace: true,
    screenshot: '99-p7-lazy-checklist.png',
  },
  candidatePool: {
    name: 'CandidatePoolPanel',
    button: sel.candidatePoolButton,
    ready: '[data-testid="candidate-pool-panel"]',
    content: '[data-testid="candidate-pool-stats"]',
    module: '/src/components/CandidatePoolPanel.tsx',
    needsWorkspace: false,
    screenshot: '100-p7-lazy-candidate-pool.png',
  },
}

async function openApp(page) {
  await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
}

async function ensureWorkspace(page) {
  if ((await page.locator(sel.saveWorkspace).count()) > 0) return
  await page.click(sel.createWorkspace)
  await page.waitForSelector(sel.saveWorkspace, { timeout: 10000 })
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  expectTrue(!overflow, '页面出现横向溢出')
}

async function runPanelScenario({ page, rec, screenshot, key }) {
  const panel = PANELS[key]
  let moduleRequests = 0
  const onRequest = (request) => {
    if (request.url().includes(panel.module)) moduleRequests += 1
  }
  page.on('request', onRequest)

  await rec.step(`首屏加载：${panel.name} 源码模块 0 次请求（未抢跑）`, async () => {
    await openApp(page)
    const before = moduleRequests
    expectTrue(before === 0, `${panel.name} 首屏已请求 ${before} 次，lazy 失效`)
    return { firstScreenModuleRequests: before }
  })

  if (panel.needsWorkspace) {
    await rec.step('关联工作区（三个工具面板的共同前置）', async () => {
      await ensureWorkspace(page)
      return { workspaceLinked: true }
    })
  }

  await rec.step(`打开${panel.name}：按需请求模块并渲染真实内容`, async () => {
    await page.click(panel.button)
    await page.waitForSelector(panel.ready, { timeout: 20000 })
    await page.waitForSelector(panel.content, { timeout: 5000 })
    const after = moduleRequests
    expectTrue(after >= 1, `${panel.name} 已渲染但源码模块请求仍为 0`)
    await assertNoHorizontalOverflow(page)
    const text = ((await page.textContent(panel.ready)) ?? '').slice(0, 120)
    return { moduleRequests: after, text }
  })

  await screenshot(page, panel.screenshot)
}

export async function runP7LazyAnchorsScenario(args) {
  await runPanelScenario({ ...args, key: 'anchors' })
}

export async function runP7LazyConstraintsScenario(args) {
  await runPanelScenario({ ...args, key: 'constraints' })
}

export async function runP7LazyChecklistScenario(args) {
  await runPanelScenario({ ...args, key: 'checklist' })
}

export async function runP7LazyCandidatePoolScenario(args) {
  await runPanelScenario({ ...args, key: 'candidatePool' })
}

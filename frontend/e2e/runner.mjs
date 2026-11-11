/**
 * 离线 HTTP 契约浏览器验收（单命令：pnpm verify:e2e）。
 *
 * 模式声明：这是「离线契约浏览器验收」——所有 /api 请求打到本进程内的契约桩，
 * 外部 HTTP 一律在 route 层截获（本进程拥有的 origin 放行；OSM 瓦片 fulfill 本地图块；
 * 其余——含其它 loopback 端口与公网——abort 并计入门禁）。它验证 UI 行为与前后端契约，
 * 不是真实模型输出，也不是真实地图质量。
 *
 * 结构：一个 Node 进程从第一个资源创建起包在 top-level try/finally 里（stub http.Server、
 * Vite dev server、Chromium 任一启动失败都走 finally 清理），finally 全部 close；
 * Chromium 用本机 Chrome/Edge 的独立临时 profile。
 */
import { chromium } from 'playwright-core'
import react from '@vitejs/plugin-react'
import { createServer as createViteServer } from 'vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import {
  createContractServer,
  createContractState,
  TILE_PNG_BASE64,
} from '../dev-stub/contract-server.mjs'
import { classifyConsoleEvents, summarizeRouteOutcomes } from './diagnose.mjs'
import { classifyUrl } from './routePolicy.mjs'
import {
  runResumeCrossTabScenario,
  runResumeRestoreScenario,
  runResumeCorruptScenario,
  runResumeInjectionScenario,
  runResumeFileSourceScenario,
  setAppOrigin,
} from './sessionResumeScenarios.mjs'
import {
  runWebSourcesMainScenario,
  runWebSourcesFailureModesScenario,
  runWebSourcesLateAndNarrowScenario,
  setWebSourcesAppOrigin,
} from './webSourcesScenarios.mjs'
import {
  runTailBoundaryReadyScenario,
  runTailBoundaryNoKeyScenario,
  runTailBoundaryStopWaitingScenario,
  runTailBoundaryZeroDistanceScenario,
  runTailBoundaryNarrowScenario,
  setTailBoundaryAppOrigin,
} from './tailBoundaryScenarios.mjs'
import {
  runS8SmokeDesktop,
  runS8SmokeNarrow,
  setS8AppOrigin,
} from './s8SmokeScenarios.mjs'
import {
  runS4CityProfileAppearance,
  runS4CityProfileCollapse,
  runS4CityProfileDegraded,
} from './s4CityProfileScenarios.mjs'
import {
  runS5StopDepthCard,
  runS5StopDepthDegraded,
} from './s5StopDepthScenarios.mjs'
import {
  runS6CoverageCard,
  runS6CoveragePoolSmoke,
} from './s6CoverageScenarios.mjs'
import {
  runS7DetourAdjustAndThresholds,
  runS7DetourKeep,
} from './s7DetourScenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const frontendRoot = resolve(here, '..')
const artifactsDir = resolve(here, 'artifacts')

/** ───────────────────────── 基础设施 ───────────────────────── */

function findChromeExecutable() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('未找到本机 Chrome/Edge，无法执行浏览器验收')
  return found
}

/** 隔离回环端口：绑定 127.0.0.1:0 由内核分配，再取实际端口 */
function listenOnLoopback(server, port = 0) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolveListen(typeof address === 'object' && address ? address.port : port)
    })
  })
}

/**
 * 预留一个空闲回环端口给 Vite 用：内核随机分配后立即释放。
 * 并行 worker 常占着默认 5173，验收进程必须避开固定端口（实际绑定端口仍从
 * httpServer.address() 读回，不假设任何固定值）。
 */
async function reserveLoopbackPort() {
  const probe = createServer()
  const port = await listenOnLoopback(probe)
  await new Promise((resolveClose) => probe.close(() => resolveClose()))
  return port
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server || !server.listening) {
      resolveClose()
      return
    }
    server.close(() => resolveClose())
    setTimeout(() => {
      try {
        server.closeAllConnections?.()
      } catch {
        /* 旧 Node 无此方法 */
      }
    }, 500).unref()
  })
}

/** deferred gate：场景 3 用；release 后 waiter 全部放行；wait() 返回内部数组供断言挂起数 */
function createGate() {
  const gate = { waiters: [] }
  gate.pendingCount = () => gate.waiters.length
  gate.release = () => {
    for (const resolveWaiter of gate.waiters.splice(0)) resolveWaiter()
  }
  return gate
}

const report = {
  mode: 'offline-contract-browser-acceptance',
  mode_note:
    '离线HTTP契约浏览器验收：/api 全部命中本进程契约桩，非本机HTTP在route层截获；不是真实模型输出，也不是真实地图质量。',
  started_at: new Date().toISOString(),
  env_probe: {},
  views: {},
  scenarios: {},
  console_events: [],
  page_errors: [],
  route_outcomes: [],
  expected_console: [],
  unexpected_console: [],
  failures: [],
}

function recordFailure(scenario, message) {
  report.failures.push({ scenario, message })
}

/** ───────────────────────── 选择器（与当前实现对齐的可访问名） ───────────────────────── */

const sel = {
  destinationInput: 'input[placeholder="例如：杭州"]',
  submitPlan: 'button:has-text("生成行程")',
  /** W4 改版：标题是行程安排 section 里唯一的 h2（App.tsx TRIP_TITLE） */
  tripTitle: 'section[aria-label="行程安排"] h2',
  tripSection: 'section[aria-label="行程安排"]',
  /** W4 改版：.error-banner 退役，role="alert" 保留；App 仅此处是 div[role=alert]（另一处是草稿里的 p[role=alert]，非 plan 错误横幅） */
  errorBanner: 'div[role="alert"]',
  outcomeNote: '[data-testid="request-status-note"]',
  startEditing: 'button:has-text("编辑这趟行程")',
  draftEditor: '[aria-label="本地行程草稿编辑器"]',
  applyDraft: 'button:has-text("应用草稿")',
  applyNotice: '[data-testid="apply-notice"]',
  openAi: 'button:has-text("AI 调整这一天")',
  aiPanel: '[aria-label="AI 调整单日安排"]',
  aiInstruction: '[aria-label="AI 调整单日安排"] textarea',
  generateCandidate: 'button:has-text("生成调整候选")',
  stopWaiting: 'button:has-text("停止等待")',
  candidatePreview: '[aria-label="候选预览"]',
  applyCandidate: 'button:has-text("应用候选")',
  discardCandidate: 'button:has-text("放弃候选")',
  openMapRefresh: 'button:has-text("仅刷新地图")',
  mapPanel: '[aria-label="仅刷新地图"]',
  mapFetch: 'button:has-text("获取地图候选")',
  mapApply: 'button:has-text("应用地图更新")',
  weatherEntry: '[data-testid="weather-entry"]',
  openWeather: 'button:has-text("查天气")',
  weatherPanel: '[data-testid="weather-panel"]',
  weatherQuery: 'button:has-text("查询天气")',
  weatherResult: '[data-testid="weather-result"]',
  poiEntry: '[data-testid="poi-sources-entry"]',
  openPoi: 'button:has-text("查资料")',
  poiPanel: '[data-testid="poi-sources-panel"]',
  poiQuery: 'button:has-text("查询附近资料")',
  poiResult: '[data-testid="poi-sources-result"]',
  openBudget: 'button:has-text("费用估算")',
  budgetPanel: '[data-testid="trip-budget-panel"]',
  addBudgetRow: 'button:has-text("添加费用项")',
  budgetCompute: 'button:has-text("计算已填费用")',
  budgetKnownTotal: '[data-testid="budget-known-total"]',
  budgetExportToggle: 'button:has-text("展开费用文件备份")',
  budgetExportPreview: 'button:has-text("预览费用备份")',
  budgetDownload: 'button:has-text("下载费用备份 (.budget.json)")',
  saveCurrentTrip: 'button:has-text("保存当前行程")',
  /** W4 改版：.saved-toggle 退役；按可见文本 + aria-expanded 定位开关按钮（SavedTripsPanel） */
  savedToggle: 'button:has-text("已保存行程")',
  restoreFirst: '[aria-label^="恢复保存的行程《"]',
  transferToggle: 'button:has-text("行程备份与导入")',
  exportJson: 'button:has-text("下载行程备份 (.json)")',
  exportIcsToggle: 'button:has-text("导出日历 (.ics)")',
  exportIcs: 'button:has-text("下载 .ics 文件")',
  exportMdPreview: 'button:has-text("预览路书（Markdown）")',
  exportMd: 'button:has-text("下载路书 (.md)")',
  dayTabs: '[role="tablist"][aria-label="按日切换"] button[role="tab"]',
}

/** ───────────────────────── owned 资源与离线路由（D/G 项） ───────────────────────── */

const control = createContractState()
const stubServer = createContractServer(control)
let stubPort = null
let vite = null
let appOrigin = null
let stubOrigin = null
const browserRef = { current: null }
/** 每个 label 的 console/pageerror 原始事件（分类在 finally 统一做） */
const consoleEvents = []
/** 场景证据：fail 场景消费一次 plan 503 */
const scenarioEvidence = { fail: { plan503Responses: 0 }, happy: { plan503Responses: 0 }, late: { plan503Responses: 0 }, narrow: { plan503Responses: 0 } }

async function installOfflineRouting(page, label) {
  await page.route('**/*', (route) => {
    const outcome = { label, kind: null, url: '' }
    try {
      const request = route.request()
      const url = new URL(request.url())
      outcome.url = url.href
      const decision = classifyUrl(url, appOrigin, stubOrigin)
      outcome.kind = decision
      report.route_outcomes.push(outcome)
      if (decision === 'continue_local') {
        void route.continue().catch(() => {
          // context/页面关闭时的正常拒绝：决策已记录（continue_local），处置结果不再改写
        })
        return
      }
      if (decision === 'fulfill_tile') {
        void route
          .fulfill({
            status: 200,
            contentType: 'image/png',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: Buffer.from(TILE_PNG_BASE64, 'base64'),
          })
          .catch(() => {
            // 同上：决策已记录，不因关闭时序改写统计
          })
        return
      }
      // abort_external（公网，DNS 前截获）/ abort_loopback_foreign（如真实 8000）
      void route.abort('blockedofflinemode').catch(() => {})
    } catch (error) {
      outcome.kind = 'handler_error'
      outcome.url = String(error).slice(0, 120)
      report.route_outcomes.push(outcome)
      void route.abort('blockedofflinemode').catch(() => {})
    }
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const event = {
        kind: 'console',
        scenarioLabel: label,
        text: msg.text(),
        location: msg.location()?.url ?? '',
      }
      report.console_events.push(event)
    }
  })
  page.on('pageerror', (err) => {
    const event = {
      kind: 'pageerror',
      scenarioLabel: label,
      text: String(err),
      location: '',
    }
    report.page_errors.push(`${label}: ${String(err).slice(0, 300)}`)
    report.console_events.push(event)
  })
}

async function newOfflineContext(label, viewport = { width: 1440, height: 1000 }) {
  const context = await browserRef.current.newContext({ viewport, locale: 'zh-CN' })
  const page = await context.newPage()
  await installOfflineRouting(page, label)
  return { context, page }
}

mkdirSync(artifactsDir, { recursive: true })

async function screenshot(page, name) {
  const path = resolve(artifactsDir, name)
  await page.screenshot({ path, fullPage: false })
  return path
}

async function assertNoHorizontalOverflow(page, scenario) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  if (overflow) recordFailure(scenario, '页面出现横向溢出')
}

/** 站点顺序（从真实 UI 读）：主视图站名列表（W4：站名为 stop-row 内的站名 span，无 .stop-name 类） */
async function readUiStopOrder(page) {
  return page.$$eval('[data-testid="stop-row"]', (nodes) =>
    nodes.map((node) => {
      const nameSpan = node.querySelector('span.min-w-0 > span')
      return nameSpan?.textContent?.trim() ?? ''
    }),
  )
}

/** 地图 marker 明细（真实 DOM 可观察数据）：aria-label + Leaflet transform 定位 */
async function readMapMarkerDetails(page) {
  return page.$$eval('.stop-dot-wrapper', (nodes) =>
    nodes.map((node) => {
      const positioned = node.closest('.leaflet-marker-icon')
      return {
        label: node.getAttribute('aria-label') ?? '',
        transform: positioned ? positioned.style.transform : '',
      }
    }),
)
}

/** 场景步骤记录（B 项）：每步完成即写证据，失败.ok=false */
function makeStepRecorder(scenario, viewportLabel) {
  const state = { ok: true, viewport: viewportLabel, steps: [], startedAt: new Date().toISOString() }
  return {
    state,
    /** 执行一步并记录；返回 evidence 供后续步骤复用 */
    async step(name, fn) {
      try {
        const evidence = await fn()
        state.steps.push({ name, ok: true, evidence: evidence ?? null })
        return evidence
      } catch (error) {
        state.ok = false
        state.steps.push({ name, ok: false, evidence: String(error).slice(0, 300) })
        recordFailure(scenario, `步骤「${name}」失败：${String(error).slice(0, 200)}`)
        throw error
      }
    },
    fail(message) {
      state.ok = false
      recordFailure(scenario, message)
    },
  }
}

/** 断言 helper：失败抛错（由 step 捕获记录） */
function expectTrue(condition, message) {
  if (!condition) throw new Error(message)
}

function expectEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}：期望 ${b.slice(0, 200)}，实际 ${a.slice(0, 200)}`)
}

/** ───────────────────────── 场景 1：正常全链路（桌面 1440） ───────────────────────── */

async function scenarioHappyPath() {
  const { context, page } = await newOfflineContext('happy')
  const rec = makeStepRecorder('happy', 'desktop-1440')
  try {
    await rec.step('打开首页并加载示例行程', async () => {
      await page.goto(appOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
      const title = await page.textContent(sel.tripTitle)
      expectTrue(title.includes('契约桩示例'), `首屏不是契约桩示例行程：${title}`)
      return { title }
    })

    await rec.step('地图瓦片（本地测试图块）渲染', async () => {
      await page.waitForSelector('.leaflet-tile-loaded', { timeout: 15000 })
      return { tileLoaded: true }
    })

    await rec.step('横向无溢出（初始）', async () => assertNoHorizontalOverflow(page, 'happy'))
    await screenshot(page, '01-initial-example-desktop.png')

    const plannedTitle = await rec.step('填写目的地并生成行程', async () => {
      await page.fill(sel.destinationInput, '杭州')
      await page.click(sel.submitPlan)
      await page.waitForFunction(
        () => document.querySelector('section[aria-label="行程安排"] h2')?.textContent?.includes('AI 契约桩') ?? false,
        undefined,
        { timeout: 20000 },
      )
      const title = await page.textContent(sel.tripTitle)
      expectTrue(title.includes('AI 契约桩'), `生成后标题异常：${title}`)
      return { title }
    })
    await screenshot(page, '02-planned-desktop.png')

    await rec.step('本地编辑：进入草稿并重排（下移第 1 站），UI 顺序真实变化', async () => {
      await page.click(sel.startEditing)
      await page.waitForSelector(sel.draftEditor, { timeout: 5000 })
      const before = await readUiStopOrder(page)
      await page.locator(`${sel.draftEditor} [aria-label^="下移第 1 站"]`).first().click()
      await page.waitForFunction(
        (prev) => {
          const rows = [...document.querySelectorAll('[data-testid="stop-row"]')]
          const names = rows.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim())
          return JSON.stringify(names) !== JSON.stringify(prev)
        },
        before,
        { timeout: 5000 },
      )
      const after = await readUiStopOrder(page)
      expectTrue(before.length >= 2, `站点数不足：${before.length}`)
      expectEqual(after[0], before[1], '重排后第 1 站应是原第 2 站')
      expectEqual(after[1], before[0], '重排后第 2 站应是原第 1 站')
      return { before, after }
    })

    await rec.step('显式应用草稿，行程标题与顺序落为主视图', async () => {
      await page.click(sel.applyDraft)
      await page.waitForSelector(sel.applyNotice, { timeout: 5000 })
      const notice = await page.textContent(sel.applyNotice)
      expectTrue(notice.includes('已把草稿应用成当前行程'), `应用通告异常：${notice}`)
      const order = await readUiStopOrder(page)
      return { notice, orderAfterApply: order }
    })
    await screenshot(page, '03-draft-applied-desktop.png')

    await rec.step('AI 单日调整：候选预览并显式应用', async () => {
      await page.click(sel.openAi)
      await page.waitForSelector(sel.aiPanel, { timeout: 5000 })
      const dayOrderBefore = await readUiStopOrder(page)
      await page.fill(sel.aiInstruction, '把这天换成博物馆主题')
      await page.click(sel.generateCandidate)
      await page.waitForSelector(sel.candidatePreview, { timeout: 15000 })
      const previewText = await page.textContent(sel.candidatePreview)
      expectTrue(previewText.includes('中国茶叶博物馆'), '候选预览缺少候选站点名')
      await page.click(sel.applyCandidate)
      await page.waitForSelector(sel.aiPanel, { state: 'detached', timeout: 5000 })
      const dayOrderAfter = await readUiStopOrder(page)
      expectTrue(
        JSON.stringify(dayOrderAfter) !== JSON.stringify(dayOrderBefore),
        'AI 应用后当日站点顺序没有变化',
      )
      expectTrue(dayOrderAfter.includes('中国茶叶博物馆'), 'AI 应用后主视图缺候选站点')
      return { orderBefore: dayOrderBefore, orderAfter: dayOrderAfter }
    })
    await screenshot(page, '04-ai-applied-desktop.png')

    await rec.step('仅刷新地图：预览阶段不改行程，显式应用后地图按候选坐标重渲染', async () => {
      const stopsBefore = await readUiStopOrder(page)
      const markersBefore = await readMapMarkerDetails(page)
      await page.click(sel.openMapRefresh)
      await page.waitForSelector(sel.mapPanel, { timeout: 5000 })
      // 预览前行程未变（面板打开本身不发请求）
      const stopsInPanel = await readUiStopOrder(page)
      expectEqual(stopsInPanel, stopsBefore, '面板打开后行程站点不应变化')
      await page.click(`${sel.mapPanel} input[type="radio"][value="walking"]`)
      await page.click(sel.mapFetch)
      await page.waitForSelector(sel.mapApply, { timeout: 15000 })
      // 预览已取得但未应用：主视图顺序仍不变
      const stopsStillBefore = await readUiStopOrder(page)
      expectEqual(stopsStillBefore, stopsBefore, '预览阶段行程站点被提前修改')
      await page.click(sel.mapApply)
      await page.waitForSelector(sel.mapPanel, { state: 'detached', timeout: 5000 })
      // 应用后地图重渲染（真实 DOM 可观察数据）：
      // - marker aria-label 集合（站名+序号）与候选站点一致；
      // - 每个 marker 的 Leaflet 像素位置（transform）随 fitBounds 重排；
      // - latlng 通过「导出当前行程 UI JSON」的候选坐标核对（与桩派生坐标闭环），
      //   不读 React 状态。fitBounds 会让不同坐标落在相似屏幕位置，
      //   所以像素坐标只断言「非零且各自可分辨」，坐标一致性由 latlng 断言承担。
      const markersAfter = await readMapMarkerDetails(page)
      expectEqual(
        markersAfter.map((m) => m.label),
        stopsBefore.map((name, index) => `站点 ${index + 1}：${name}，按回车查看讲解`),
        '应用后 marker 可访问名与候选站点不一致',
      )
      const transformsAfter = markersAfter.map((m) => m.transform)
      expectTrue(transformsAfter.every((t) => t && t !== 'none'), 'marker 缺 Leaflet transform 定位')
      expectTrue(new Set(transformsAfter).size === transformsAfter.length, '所有 marker 屏幕位置相同——fitBounds 未按候选坐标区分')
      // 像素布局与刷新前不同（图层数据变了；AI 候选坐标与刷新前不同）
      expectTrue(
        JSON.stringify(markersAfter.map((m) => m.transform)) !== JSON.stringify(markersBefore.map((m) => m.transform)),
        '应用前后 marker 屏幕布局完全相同——地图未按候选重渲染',
      )
      return {
        stopsBefore,
        markersCount: markersAfter.length,
        transformsAfter,
      }
    })
    // 地图主体可见的截图：滚到地图区再截（W4：地图容器 aria-label="交互式地图"）
    await page.locator('[aria-label="交互式地图"]').first().scrollIntoViewIfNeeded()
    await screenshot(page, '05-map-refresh-applied-desktop.png')

    await rec.step('地图 marker 坐标与 UI 导出候选坐标一致（latlng 闭环）', async () => {
      const envelope = await exportCurrentTripViaDownload('after-map-refresh')
      const day1 = envelope.days.find((d) => d.day === 1)
      const uiCoords = day1.stops
        .filter((s) => s.location)
        .map((s) => ({ name: s.name, lng: s.location.lng, lat: s.location.lat }))
      expectTrue(uiCoords.length >= 2, `第 1 天可画站点不足：${uiCoords.length}`)
      // 桩的派生坐标满足：lng∈[120.1,120.19), lat∈[30.15,30.24)
      for (const coord of uiCoords) {
        expectTrue(
          coord.lng >= 120.1 && coord.lng < 120.2 && coord.lat >= 30.15 && coord.lat < 30.25,
          `候选坐标超出契约桩派生范围：${JSON.stringify(coord)}`,
        )
      }
      // 页面真实 Leaflet latlng：从 marker 的投影反推不可行（无 window 句柄），
      // 用 popup 打开后的坐标文本核对（ItineraryList 展示 WGS84 lat,lng）
      await page.locator('[data-testid="stop-row"]').first().click()
      await page.waitForSelector('[data-testid="stop-detail"]', { timeout: 5000 })
      const coordText = await page.textContent('[data-testid="stop-detail"]')
      const firstCoord = uiCoords[0]
      expectTrue(
        coordText.includes(firstCoord.lat.toFixed(4)) && coordText.includes(firstCoord.lng.toFixed(4)),
        `站点详情坐标与候选不一致：${coordText} vs ${JSON.stringify(firstCoord)}`,
      )
      return { uiCoords, coordText: coordText.slice(0, 80) }
    })

    await rec.step('天气查询：available 结果', async () => {
      await page.click(sel.openWeather)
      await page.waitForSelector(sel.weatherPanel, { timeout: 5000 })
      await page.click(sel.weatherQuery)
      await page.waitForSelector(sel.weatherResult, { timeout: 15000 })
      const status = await page.getAttribute(sel.weatherResult, 'data-status')
      expectTrue(status === 'available', `天气结果状态：${status}`)
      await page.click(`${sel.weatherPanel} button:has-text("收起")`)
      return { status }
    })

    await rec.step('POI 查询：available 结果', async () => {
      await page.click(sel.openPoi)
      await page.waitForSelector(sel.poiPanel, { timeout: 5000 })
      await page.click(sel.poiQuery)
      await page.waitForSelector(sel.poiResult, { timeout: 15000 })
      const status = await page.getAttribute(sel.poiResult, 'data-status')
      expectTrue(status === 'available', `POI 结果状态：${status}`)
      await page.click(`${sel.poiPanel} button:has-text("收起")`)
      return { status }
    })
    await screenshot(page, '06-weather-poi-desktop.png')

    await rec.step('费用：0 与 25.5 合计 25.50 元', async () => {
      await page.click(sel.openBudget)
      await page.waitForSelector(sel.budgetPanel, { timeout: 5000 })
      await page.click(sel.addBudgetRow)
      await page.fill(`${sel.budgetPanel} [data-testid="budget-row"] >> nth=0 >> input[placeholder="例如 高铁票"]`, '公交（0 元）')
      await page.fill(`${sel.budgetPanel} [data-testid="budget-row"] >> nth=0 >> input[placeholder="0 也算一项"]`, '0')
      await page.click(sel.addBudgetRow)
      await page.fill(`${sel.budgetPanel} [data-testid="budget-row"] >> nth=1 >> input[placeholder="例如 高铁票"]`, '门票')
      await page.fill(`${sel.budgetPanel} [data-testid="budget-row"] >> nth=1 >> input[placeholder="0 也算一项"]`, '25.5')
      await page.click(sel.budgetCompute)
      await page.waitForSelector(sel.budgetKnownTotal, { timeout: 5000 })
      const totalText = (await page.textContent(sel.budgetKnownTotal))?.trim() ?? ''
      expectTrue(totalText.startsWith('25.50'), `费用合计期望 25.50 开头，实际「${totalText}」`)
      return { totalText }
    })
    await screenshot(page, '07-budget-desktop.png')

    await rec.step('保存当前行程到浏览器本地', async () => {
      await page.click(sel.saveCurrentTrip)
      await page.waitForSelector('text=已保存《', { timeout: 5000 })
      return { saved: true }
    })

    /** 从 UI 导出当前行程 JSON（不注入状态）：借「下载行程备份」的实时下载 */
    async function exportCurrentTripViaDownload(tag) {
      await ensureTransferPanelOpen()
      const downloadPromise = page.waitForEvent('download', { timeout: 10000 })
      await page.click(sel.exportJson)
      const download = await downloadPromise
      const path = resolve(artifactsDir, `ui-export-${tag}.json`)
      await download.saveAs(path)
      return JSON.parse((await import('node:fs')).readFileSync(path, 'utf-8')).trip
    }

    const savedTrip = await rec.step('导出当前行程 JSON（作为保存基准数据）', async () => {
      const trip = await exportCurrentTripViaDownload('saved-baseline')
      expectTrue(trip.title.includes('AI 契约桩'), `导出标题异常：${trip.title}`)
      return trip
    })

    /** 备份面板默认收起；已展开时不要收起 */
    async function ensureTransferPanelOpen() {
      const toggle = page.locator(sel.transferToggle).first()
      if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'true') {
        return
      }
      await page.click(sel.transferToggle)
      await page.waitForSelector(sel.exportJson, { timeout: 5000 })
    }

    await rec.step('已保存列表可见', async () => {
      const savedToggle = page.locator(sel.savedToggle).first()
      if ((await savedToggle.getAttribute('aria-expanded')) !== 'true') {
        await savedToggle.click()
      }
      await page.waitForSelector(sel.restoreFirst, { timeout: 5000 })
      return { visible: true }
    })
    await screenshot(page, '08-saved-desktop.png')

    const downloads = await rec.step('四类文件下载并逐项核对内容', async () => {
      await ensureTransferPanelOpen()

      // JSON
      const jsonPromise = page.waitForEvent('download', { timeout: 10000 })
      await page.click(sel.exportJson)
      const jsonFile = await jsonPromise
      const jsonPath = resolve(artifactsDir, 'download-trip-backup.json')
      await jsonFile.saveAs(jsonPath)

      // ICS
      await page.click(sel.exportIcsToggle)
      const icsPromise = page.waitForEvent('download', { timeout: 10000 })
      await page.click(sel.exportIcs)
      const icsFile = await icsPromise
      const icsPath = resolve(artifactsDir, 'download-calendar.ics')
      await icsFile.saveAs(icsPath)

      // Markdown
      await page.click(sel.exportMdPreview)
      const mdPromise = page.waitForEvent('download', { timeout: 10000 })
      await page.click(sel.exportMd)
      const mdFile = await mdPromise
      const mdPath = resolve(artifactsDir, 'download-guidebook.md')
      await mdFile.saveAs(mdPath)

      // 费用备份
      await page.click(sel.budgetExportToggle)
      await page.click(sel.budgetExportPreview)
      const budgetPromise = page.waitForEvent('download', { timeout: 10000 })
      await page.click(sel.budgetDownload)
      const budgetFile = await budgetPromise
      const budgetPath = resolve(artifactsDir, 'download-budget.budget.json')
      await budgetFile.saveAs(budgetPath)

      const readFile = (await import('node:fs')).readFileSync
      // JSON：与 UI 导出的基准逐项一致（站点/路线）。savedTrip 已是 envelope.trip
      const jsonEnvelope = JSON.parse(readFile(jsonPath, 'utf-8'))
      expectEqual(jsonEnvelope.trip.days, savedTrip.days, 'JSON 备份 days 与基准不一致')
      expectEqual(jsonEnvelope.trip.id, savedTrip.id, 'JSON 备份 id 与基准不一致')

      // ICS：事件数 = 有时刻+有名字的站点数；抽验首站 SUMMARY/DTSTART/LOCATION
      const icsContent = readFile(icsPath, 'utf-8')
      expectTrue(icsContent.startsWith('BEGIN:VCALENDAR'), 'ICS 缺 VCALENDAR 头')
      const eventCount = (icsContent.match(/BEGIN:VEVENT/g) ?? []).length
      const allStops = savedTrip.days.flatMap((day) => day.stops)
      const expectedEvents = allStops.filter((s) => s.time && s.name?.trim()).length
      expectEqual(eventCount, expectedEvents, `ICS 事件数应为 ${expectedEvents}`)
      const firstStop = allStops.find((s) => s.time && s.name?.trim())
      expectTrue(icsContent.includes(`SUMMARY:${firstStop.name}`), `ICS 缺首站 SUMMARY：${firstStop.name}`)
      expectTrue(icsContent.includes(`LOCATION:${firstStop.address}`), `ICS 缺首站 LOCATION`)
      const firstStopDay = savedTrip.days.find((day) => day.stops.some((s) => s.id === firstStop.id))
      const dtstart = `${firstStopDay.date.replace(/-/g, '')}T${firstStop.time.replace(':', '')}00`
      expectTrue(icsContent.includes(`DTSTART:${dtstart}`), `ICS 首站 DTSTART 应含 ${dtstart}`)

      // Markdown：站名/时间/停留/路段标签逐项
      const mdContent = readFile(mdPath, 'utf-8')
      for (const stop of allStops) {
        expectTrue(mdContent.includes(stop.name), `MD 缺站名：${stop.name}`)
      }
      expectTrue(mdContent.includes('停留 120 分钟'), 'MD 缺停留时长')
      expectTrue(mdContent.includes('示意直线（不是导航结果，无真实道路）'), 'MD 缺示意直线标签（第 3 天）')
      expectTrue(mdContent.includes('导航路线（按记录原样导出，本次未重新计算路线）'), 'MD 缺导航路线标签')

      // 费用备份：绑定当前 trip id，保留 0 / 25.5 / 空预算
      const budgetContent = JSON.parse(readFile(budgetPath, 'utf-8'))
      expectEqual(budgetContent.trip?.id, savedTrip.id, '费用备份未绑定当前 trip id')
      expectEqual(budgetContent.draft?.budgetRaw, '', '费用备份总预算应为空串')
      const rows = budgetContent.draft?.rows ?? []
      expectTrue(rows.some((r) => r.amountRaw === '0' && r.name === '公交（0 元）'), '费用备份缺 0 元行')
      expectTrue(rows.some((r) => r.amountRaw === '25.5' && r.name === '门票'), '费用备份缺 25.5 行')
      const jsonBytes = (await import('node:fs')).statSync(jsonPath).size
      return { eventCount, jsonBytes }
    })

    await rec.step('修改当前内容但不保存，再恢复到已存数据并核对完整性', async () => {
      // 先改标题（本地编辑→改站名→应用）制造与已存数据的差异
      await page.click(sel.startEditing)
      await page.waitForSelector(sel.draftEditor, { timeout: 5000 })
      const firstEdit = page.locator(`${sel.draftEditor} [aria-label^="编辑第 1 站"]`).first()
      await firstEdit.click()
      const nameInput = page.locator(`${sel.draftEditor} input[placeholder="例如 断桥残雪"]`).first()
      await nameInput.fill('被修改的站名（未保存）')
      await page.click(`${sel.draftEditor} button:has-text("保存到草稿")`)
      await page.click(sel.applyDraft)
      await page.waitForSelector(sel.applyNotice, { timeout: 5000 })
      const mutatedOrder = await readUiStopOrder(page)
      expectTrue(mutatedOrder.includes('被修改的站名（未保存）'), '修改未生效')

      // 恢复前：只读直取正式存储原始字节（page.evaluate 读 localStorage，不经 React 状态）
      const storageKeyBefore = await page.evaluate(
        (key) => window.localStorage.getItem(key),
        'travel-assistant:saved-trips:v1',
      )
      expectTrue(storageKeyBefore?.includes(savedTrip.id) ?? false, '正式存储里没有已保存行程')

      // 恢复已存行程
      const savedToggle = page.locator(sel.savedToggle).first()
      if ((await savedToggle.getAttribute('aria-expanded')) !== 'true') {
        await savedToggle.click()
      }
      await page.waitForSelector(sel.restoreFirst, { timeout: 5000 })
      await page.click(sel.restoreFirst)
      await page.waitForSelector('text=已恢复《', { timeout: 5000 })

      // 正式存储记录逐字节不动：恢复只改视图，存储字符串必须完全一致
      const storageKeyAfter = await page.evaluate(
        (key) => window.localStorage.getItem(key),
        'travel-assistant:saved-trips:v1',
      )
      expectEqual(storageKeyAfter, storageKeyBefore, '恢复后正式存储记录被改动')

      // 恢复后从 UI 重新导出，与保存基准逐项核对（Trip 内容一致，id 一致）
      const restored = await exportCurrentTripViaDownload('restored')
      expectEqual(restored.days, savedTrip.days, '恢复后行程内容与已存基准不一致')
      expectEqual(restored.id, savedTrip.id, '恢复后行程 id 与已存基准不一致')
      return { restoredId: restored.id, mutatedOrder, storageUnchanged: true }
    })
    await screenshot(page, '09-restored-desktop.png')

    await rec.step('横向无溢出（流程末尾）', async () => assertNoHorizontalOverflow(page, 'happy'))
  } finally {
    report.views['desktop-1440'] = rec.state
    report.scenarios.happy = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 2：规划失败保旧 ───────────────────────── */

async function scenarioPlanFailure() {
  const { context, page } = await newOfflineContext('fail')
  const rec = makeStepRecorder('fail', 'desktop-1440')
  try {
    await rec.step('打开首页加载示例行程', async () => {
      await page.goto(appOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
      return { title: await page.textContent(sel.tripTitle) }
    })

    await rec.step('切 503 后提交生成：旧行程保留 + 错误横幅 + 归属说明', async () => {
      const titleBefore = await page.textContent(sel.tripTitle)
      control.planMode = 'fail503'
      scenarioEvidence.fail.plan503Responses += 1
      await page.fill(sel.destinationInput, '西安')
      await page.click(sel.submitPlan)
      await page.waitForSelector(sel.errorBanner, { timeout: 10000 })
      await page.waitForSelector(sel.outcomeNote, { timeout: 5000 })
      const titleAfter = await page.textContent(sel.tripTitle)
      expectEqual(titleAfter, titleBefore, '失败后当前行程标题被改变')
      const outcome = await page.textContent(sel.outcomeNote)
      expectTrue(outcome.includes('西安'), `归属说明缺目的地：${outcome}`)
      return { titleAfter, outcome }
    })
    await screenshot(page, '10-plan-failure-desktop.png')

    await rec.step('恢复 planMode 后可重新生成', async () => {
      control.planMode = 'ok'
      await page.fill(sel.destinationInput, '杭州')
      await page.click(sel.submitPlan)
      await page.waitForFunction(
        () => document.querySelector('section[aria-label="行程安排"] h2')?.textContent?.includes('AI 契约桩') ?? false,
        undefined,
        { timeout: 20000 },
      )
      return { recovered: true }
    })
  } finally {
    report.scenarios.planFailure = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 3：重排迟到不复活（显式定序，E 项） ───────────────────────── */

async function scenarioLateReplan() {
  const { context, page } = await newOfflineContext('late')
  const rec = makeStepRecorder('late', 'desktop-1440')
  try {
    await rec.step('打开首页加载示例行程', async () => {
      await page.goto(appOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
      return { title: await page.textContent(sel.tripTitle) }
    })

    await rec.step('直接生成候选成功后放弃（基线）', async () => {
      await page.click(sel.openAi)
      await page.waitForSelector(sel.aiPanel, { timeout: 5000 })
      await page.fill(sel.aiInstruction, '迟到场景基线')
      await page.click(sel.generateCandidate)
      await page.waitForSelector(sel.candidatePreview, { timeout: 15000 })
      await page.click(sel.discardCandidate)
      await page.waitForSelector(sel.candidatePreview, { state: 'detached', timeout: 5000 })
      return { baseline: true }
    })

    await rec.step('挂 gate → 生成 → 请求在桩侧挂起（pending=1）', async () => {
      control.replanDelay = createGate()
      await page.click(sel.generateCandidate)
      await page.waitForSelector(`${sel.aiPanel} button:has-text("停止等待")`, { timeout: 10000 })
      // 显式证据：桩确实收到并仍挂起（不是等固定时间）
      const deadline = Date.now() + 5000
      while (control.replanDelay.pendingCount() === 0 && Date.now() < deadline) {
        await page.waitForTimeout(50)
      }
      expectTrue(control.replanDelay.pendingCount() >= 1, '请求未在桩侧挂起')
      return { pendingAtGate: control.replanDelay.pendingCount() }
    })

    await rec.step('停止等待：浏览器 abort 在途请求，桩侧显式收到断开', async () => {
      const pendingSeq = control.requests[control.requests.length - 1].seq
      await page.click(sel.stopWaiting)
      const settled = await Promise.race([
        control.requests.find((r) => r.seq === pendingSeq)?.settled ?? Promise.resolve('missing'),
        new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 5000)),
      ])
      control.replanDelay.release()
      control.replanDelay = null
      expectTrue(
        settled === 'aborted',
        `停止等待后桩侧应观察到连接断开（abort 生效），实际：${settled}`,
      )
      return { settled }
    })

    await rec.step('迟到响应不复活候选，当前行程不变', async () => {
      // 已显式观察到 abort，无 sleep：面板此时不可能收到响应；直接断言状态
      const previewCount = await page.locator(sel.candidatePreview).count()
      expectTrue(previewCount === 0, '停止等待后候选预览复活')
      await page.click(`${sel.aiPanel} button:has-text("收起")`)
      const title = await page.textContent(sel.tripTitle)
      expectTrue(title.includes('契约桩示例'), `迟到场景后行程异常：${title}`)
      return { title }
    })
    await screenshot(page, '11-late-replan-no-revival.png')
  } finally {
    report.scenarios.lateReplan = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 4：窄屏 390 冒烟 ───────────────────────── */

async function scenarioNarrowViewport() {
  const { context, page } = await newOfflineContext('narrow', { width: 390, height: 844 })
  const rec = makeStepRecorder('narrow', 'mobile-390')
  try {
    await rec.step('打开首页（390 视口）加载示例', async () => {
      await page.goto(appOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
      return { title: await page.textContent(sel.tripTitle) }
    })
    await rec.step('横向无溢出（初始）', async () => assertNoHorizontalOverflow(page, 'narrow'))
    await screenshot(page, '12-narrow-initial.png')

    await rec.step('生成行程', async () => {
      await page.fill(sel.destinationInput, '杭州')
      await page.click(sel.submitPlan)
      await page.waitForFunction(
        () => document.querySelector('section[aria-label="行程安排"] h2')?.textContent?.includes('AI 契约桩') ?? false,
        undefined,
        { timeout: 20000 },
      )
      return { planned: true }
    })

    await rec.step('编辑移动一站后应用', async () => {
      await page.click(sel.startEditing)
      await page.waitForSelector(sel.draftEditor, { timeout: 5000 })
      const before = await readUiStopOrder(page)
      await page.locator(`${sel.draftEditor} [aria-label^="下移第 1 站"]`).first().click()
      await page.waitForFunction(
        (prev) => {
          const rows = [...document.querySelectorAll('[data-testid="stop-row"]')]
          const names = rows.map((node) => node.querySelector('span.min-w-0 > span')?.textContent?.trim())
          return JSON.stringify(names) !== JSON.stringify(prev)
        },
        before,
        { timeout: 5000 },
      )
      await page.click(sel.applyDraft)
      await page.waitForSelector(sel.applyNotice, { timeout: 5000 })
      const after = await readUiStopOrder(page)
      expectEqual(after.slice(0, 2), before.slice(0, 2).reverse(), '窄屏重排未生效')
      return { orderAfter: after }
    })

    await rec.step('AI 候选生成并应用（显式选步行）', async () => {
      await page.click(sel.openAi)
      await page.waitForSelector(sel.aiPanel, { timeout: 5000 })
      const walkingRadio = page.locator(`${sel.aiPanel} input[type="radio"][value="walking"]`).first()
      if (await walkingRadio.isEnabled()) {
        await walkingRadio.check()
      }
      await page.fill(sel.aiInstruction, '窄屏冒烟：候选生成')
      await page.click(sel.generateCandidate)
      await page.waitForSelector(sel.candidatePreview, { timeout: 15000 })
      await page.click(sel.applyCandidate)
      await page.waitForSelector(sel.aiPanel, { state: 'detached', timeout: 5000 })
      return { applied: true }
    })

    await rec.step('保存当前行程', async () => {
      await page.click(sel.saveCurrentTrip)
      await page.waitForSelector('text=已保存《', { timeout: 5000 })
      return { saved: true }
    })

    await rec.step('横向无溢出（流程末尾）', async () => assertNoHorizontalOverflow(page, 'narrow'))
    await screenshot(page, '13-narrow-after-flow.png')
  } finally {
    report.views['mobile-390'] = rec.state
    report.scenarios.narrow = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 5：恢复跨标签（启用/草稿/费用/StorageEvent 停写） ───────────────────────── */

async function scenarioResumeCrossTab() {
  const { context, page } = await newOfflineContext('resumeCrossTab')
  const rec = makeStepRecorder('resumeCrossTab', 'desktop-1440')
  try {
    await rec.step('打开首页加载示例行程', async () => {
      await page.goto(appOrigin, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
      return { title: await page.textContent(sel.tripTitle) }
    })
    const pageB = await context.newPage()
    await installOfflineRouting(pageB, 'resumeCrossTabB')
    await runResumeCrossTabScenario({
      page,
      pageB,
      rec,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.resumeCrossTab = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 6：恢复 reload→pending→显式恢复→关闭/重开 ───────────────────────── */

async function scenarioResumeRestore() {
  const { context, page } = await newOfflineContext('resumeRestore')
  const rec = makeStepRecorder('resumeRestore', 'desktop-1440')
  try {
    await runResumeRestoreScenario({ page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.resumeRestore = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 7：恢复坏数据原子保旧 + off 门禁 ───────────────────────── */

async function scenarioResumeCorrupt() {
  const { context, page } = await newOfflineContext('resumeCorrupt')
  const rec = makeStepRecorder('resumeCorrupt', 'desktop-1440')
  try {
    await runResumeCorruptScenario({ page, rec, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.resumeCorrupt = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 8：可控注入 getter/quota（明示非自然故障） ───────────────────────── */

async function scenarioResumeInjection() {
  const { context, page } = await newOfflineContext('resumeInjection')
  const rec = makeStepRecorder('resumeInjection', 'desktop-1440')
  try {
    await runResumeInjectionScenario({ context, page, rec, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.resumeInjection = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 9：文件来源 true 全链路（真实导出→setInputFiles→显式打开→留存→恢复） ───────────────────────── */

async function scenarioResumeFileSource() {
  const { context, page } = await newOfflineContext('resumeFileSource')
  const rec = makeStepRecorder('resumeFileSource', 'desktop-1440')
  try {
    await runResumeFileSourceScenario({ context, page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.resumeFileSource = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 10：网页资料主链路（桌面 1440） ───────────────────────── */

async function scenarioWebSourcesMain() {
  const { context, page } = await newOfflineContext('webMain')
  const rec = makeStepRecorder('webMain', 'desktop-1440')
  try {
    await runWebSourcesMainScenario({ page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.webMain = rec.state
    control.webSourcesMode = null
    control.webSourcesDelay = null
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 11：网页资料业务失败四态保旧（桌面 1440） ───────────────────────── */

async function scenarioWebSourcesFailureModes() {
  const { context, page } = await newOfflineContext('webFailure')
  const rec = makeStepRecorder('webFailure', 'desktop-1440')
  try {
    await runWebSourcesFailureModesScenario({ page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.webFailure = rec.state
    control.webSourcesMode = null
    control.webSourcesDelay = null
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 12：网页资料迟到不复活 + 390 窄屏（同 context 先桌面后窄屏） ───────────────────────── */

async function scenarioWebSourcesLateAndNarrow() {
  const { context, page } = await newOfflineContext('webLate')
  const rec = makeStepRecorder('webLate', 'desktop-1440→mobile-390')
  try {
    await runWebSourcesLateAndNarrowScenario({ page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.webLate = rec.state
    control.webSourcesMode = null
    control.webSourcesDelay = null
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 13–17：后段衔接路线（tailBoundaryScenarios.mjs） ───────────────────────── */

async function scenarioTailBoundaryReady() {
  const { context, page } = await newOfflineContext('tailReady')
  const rec = makeStepRecorder('tailReady', 'desktop-1440')
  try {
    await runTailBoundaryReadyScenario({ page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.tailReady = rec.state
    control.legRefreshMode = null
    control.legRefreshDelay = null
    await context.close().catch(() => {})
  }
}

async function scenarioTailBoundaryNoKey() {
  const { context, page } = await newOfflineContext('tailNoKey')
  const rec = makeStepRecorder('tailNoKey', 'desktop-1440')
  try {
    await runTailBoundaryNoKeyScenario({ page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.tailNoKey = rec.state
    control.legRefreshMode = null
    control.legRefreshDelay = null
    await context.close().catch(() => {})
  }
}

async function scenarioTailBoundaryStopWaiting() {
  const { context, page } = await newOfflineContext('tailStop')
  const rec = makeStepRecorder('tailStop', 'desktop-1440')
  try {
    await runTailBoundaryStopWaitingScenario({ page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.tailStop = rec.state
    control.legRefreshMode = null
    control.legRefreshDelay = null
    await context.close().catch(() => {})
  }
}

async function scenarioTailBoundaryZeroDistance() {
  const { context, page } = await newOfflineContext('tailZero')
  const rec = makeStepRecorder('tailZero', 'desktop-1440')
  try {
    await runTailBoundaryZeroDistanceScenario({ page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.tailZero = rec.state
    control.legRefreshMode = null
    control.legRefreshDelay = null
    await context.close().catch(() => {})
  }
}

async function scenarioTailBoundaryNarrow() {
  const { context, page } = await newOfflineContext('tailNarrow', { width: 390, height: 844 })
  const rec = makeStepRecorder('tailNarrow', 'mobile-390')
  try {
    await runTailBoundaryNarrowScenario({ page, rec, control, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.tailNarrow = rec.state
    control.legRefreshMode = null
    control.legRefreshDelay = null
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 18–19：五期 S8 收尾冒烟（桌面 / 375 窄屏） ───────────────────────── */

async function scenarioS8SmokeDesktop() {
  const { context, page } = await newOfflineContext('s8Smoke')
  const rec = makeStepRecorder('s8Smoke', 'desktop-1440')
  try {
    await runS8SmokeDesktop({
      page,
      rec,
      control,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s8Smoke = rec.state
    await context.close().catch(() => {})
  }
}

async function scenarioS8SmokeNarrow() {
  const { context, page } = await newOfflineContext('s8SmokeNarrow', { width: 375, height: 812 })
  const rec = makeStepRecorder('s8SmokeNarrow', 'mobile-375')
  try {
    await runS8SmokeNarrow({ page, rec, screenshot: (p, name) => screenshot(p, name) })
  } finally {
    report.scenarios.s8SmokeNarrow = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 20–22：六期 S4 城市导览卡（出现 / 折叠 / 降级） ───────────────────────── */

async function scenarioS4CityProfileAppearance() {
  const { context, page } = await newOfflineContext('s4CityProfileAppearance')
  const rec = makeStepRecorder('s4CityProfileAppearance', 'desktop-1440')
  try {
    await runS4CityProfileAppearance({
      page,
      rec,
      appOrigin,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s4CityProfileAppearance = rec.state
    await context.close().catch(() => {})
  }
}

async function scenarioS4CityProfileCollapse() {
  const { context, page } = await newOfflineContext('s4CityProfileCollapse')
  const rec = makeStepRecorder('s4CityProfileCollapse', 'desktop-1440')
  try {
    await runS4CityProfileCollapse({
      page,
      rec,
      appOrigin,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s4CityProfileCollapse = rec.state
    await context.close().catch(() => {})
  }
}

async function scenarioS4CityProfileDegraded() {
  const { context, page } = await newOfflineContext('s4CityProfileDegraded')
  const rec = makeStepRecorder('s4CityProfileDegraded', 'desktop-1440')
  try {
    await runS4CityProfileDegraded({
      page,
      rec,
      appOrigin,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s4CityProfileDegraded = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 23–24：六期 S5 景点深度卡（渲染 / 缺字段降级） ───────────────────────── */

async function scenarioS5StopDepthCard() {
  const { context, page } = await newOfflineContext('s5StopDepthCard')
  const rec = makeStepRecorder('s5StopDepthCard', 'desktop-1440')
  try {
    await runS5StopDepthCard({
      page,
      rec,
      appOrigin,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s5StopDepthCard = rec.state
    await context.close().catch(() => {})
  }
}

async function scenarioS5StopDepthDegraded() {
  const { context, page } = await newOfflineContext('s5StopDepthDegraded')
  const rec = makeStepRecorder('s5StopDepthDegraded', 'desktop-1440')
  try {
    await runS5StopDepthDegraded({
      page,
      rec,
      appOrigin,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s5StopDepthDegraded = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 场景 25–26：六期 S6 选择充分度（渲染 / 加入候选池冒烟） ───────────────────────── */

async function scenarioS6CoverageCard() {
  const { context, page } = await newOfflineContext('s6CoverageCard')
  const rec = makeStepRecorder('s6CoverageCard', 'desktop-1440')
  try {
    await runS6CoverageCard({
      page,
      rec,
      appOrigin,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s6CoverageCard = rec.state
    await context.close().catch(() => {})
  }
}

async function scenarioS6CoveragePoolSmoke() {
  const { context, page } = await newOfflineContext('s6CoveragePoolSmoke')
  const rec = makeStepRecorder('s6CoveragePoolSmoke', 'desktop-1440')
  try {
    await runS6CoveragePoolSmoke({
      page,
      rec,
      appOrigin,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s6CoveragePoolSmoke = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 绕行拦截（S7） ───────────────────────── */

async function scenarioS7DetourKeep() {
  const { context, page } = await newOfflineContext('s7DetourKeep')
  const rec = makeStepRecorder('s7DetourKeep', 'desktop-1440')
  try {
    await runS7DetourKeep({
      page,
      rec,
      appOrigin,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s7DetourKeep = rec.state
    await context.close().catch(() => {})
  }
}

async function scenarioS7DetourAdjustAndThresholds() {
  const { context, page } = await newOfflineContext('s7DetourAdjustAndThresholds')
  const rec = makeStepRecorder('s7DetourAdjustAndThresholds', 'desktop-1440')
  try {
    await runS7DetourAdjustAndThresholds({
      page,
      rec,
      appOrigin,
      screenshot: (p, name) => screenshot(p, name),
    })
  } finally {
    report.scenarios.s7DetourAdjustAndThresholds = rec.state
    await context.close().catch(() => {})
  }
}

/** ───────────────────────── 编排：从第一个资源起全程 try/finally ───────────────────────── */

let bootstrapError = null
try {
  stubPort = await listenOnLoopback(stubServer)
  stubOrigin = `http://127.0.0.1:${stubPort}`

  // Vite 端口：预留一个空闲回环端口，避免与并行 worker 的 dev server 抢固定端口；
  // strictPort=false 兜住「预留后被抢占」的竞态，实际端口从 httpServer 读回。
  const reservedVitePort = await reserveLoopbackPort()
  vite = await createViteServer({
    configFile: false,
    // 钉死 import.meta.env.VITE_API_BASE 为空串：不读 .env，也不继承 process.env（D 项）
    define: {
      'import.meta.env.VITE_API_BASE': JSON.stringify(''),
      'import.meta.env.VITE_API_BASE_LOCAL': JSON.stringify(''),
    },
    envDir: false,
    root: frontendRoot,
    // 依赖预构建缓存写到 Temp 区，不写共享 node_modules/.vite
    cacheDir: resolve(tmpdir(), 'opencode', 'night-20261105', 'vite-cache'),
    plugins: [react()],
    // 与 vite.config.ts 的 alias 保持一致：S2 起组件用 @/components/ui/* 导入，
    // 内联配置（configFile:false）若缺 resolve.alias，Vite 解析会 500、App 不挂载
    resolve: {
      alias: {
        '@': resolve(frontendRoot, 'src'),
      },
    },
    appType: 'spa',
    server: {
      host: '127.0.0.1',
      port: reservedVitePort,
      strictPort: false,
      proxy: { '/api': { target: stubOrigin, changeOrigin: true } },
    },
  })
  await vite.listen()
  const viteAddress = vite.httpServer?.address()
  const vitePort = typeof viteAddress === 'object' && viteAddress ? viteAddress.port : 0
  appOrigin = `http://127.0.0.1:${vitePort}`

  // 恶意继承探针：报告当前 shell 的 VITE_API_BASE（不打印值本身之外的信息；仅存在性）
  report.env_probe.process_VITE_API_BASE_present = process.env.VITE_API_BASE !== undefined
  report.env_probe.process_VITE_API_BASE_length = process.env.VITE_API_BASE?.length ?? 0

  browserRef.current = await chromium.launch({
    executablePath: findChromeExecutable(),
    headless: true,
  })

  await scenarioHappyPath()
  await scenarioPlanFailure()
  await scenarioLateReplan()
  await scenarioNarrowViewport()
  setAppOrigin(appOrigin)
  await scenarioResumeCrossTab()
  await scenarioResumeRestore()
  await scenarioResumeCorrupt()
  await scenarioResumeInjection()
  await scenarioResumeFileSource()
  setWebSourcesAppOrigin(appOrigin)
  await scenarioWebSourcesMain()
  await scenarioWebSourcesFailureModes()
  await scenarioWebSourcesLateAndNarrow()
  setTailBoundaryAppOrigin(appOrigin)
  await scenarioTailBoundaryReady()
  await scenarioTailBoundaryNoKey()
  await scenarioTailBoundaryStopWaiting()
  await scenarioTailBoundaryZeroDistance()
  await scenarioTailBoundaryNarrow()
  setS8AppOrigin(appOrigin)
  await scenarioS8SmokeDesktop()
  await scenarioS8SmokeNarrow()
  await scenarioS4CityProfileAppearance()
  await scenarioS4CityProfileCollapse()
  await scenarioS4CityProfileDegraded()
  await scenarioS5StopDepthCard()
  await scenarioS5StopDepthDegraded()
  await scenarioS6CoverageCard()
  await scenarioS6CoveragePoolSmoke()
  await scenarioS7DetourKeep()
  await scenarioS7DetourAdjustAndThresholds()
} catch (error) {
  bootstrapError = error
  recordFailure('bootstrap', String(error).slice(0, 400))
} finally {
  await browserRef.current?.close().catch(() => {})
  await vite?.close().catch(() => {})
  await closeServer(stubServer)

  // console/pageerror 分类（A 项）：从原始事件 + 场景证据导出
  const classified = classifyConsoleEvents(report.console_events, scenarioEvidence)
  report.expected_console = classified.expected
  report.unexpected_console = classified.unexpected
  for (const item of classified.unexpected) {
    recordFailure('console', `未预期 ${item.kind}（${item.scenarioLabel}）：${item.text.slice(0, 160)}`)
  }

  // 离线统计（G 项）：从实际 route 处置结果导出
  const routeSummary = summarizeRouteOutcomes(report.route_outcomes)
  report.route_summary = routeSummary
  if (routeSummary.actualOutbound > 0) {
    recordFailure('offline', `有 ${routeSummary.actualOutbound} 个请求被放行出站——离线模式不允许`)
  }
  if (routeSummary.handlerErrors > 0) {
    recordFailure('offline', `route handler 有 ${routeSummary.handlerErrors} 次异常`)
  }
  if (routeSummary.abortedLoopbackForeign > 0 || routeSummary.abortedExternal > 0) {
    // 被截获的未知目标是允许的（这正是门禁价值），但要列出以便审计
    report.intercepted_foreign = report.route_outcomes.filter(
      (o) => o.kind === 'abort_external' || o.kind === 'abort_loopback_foreign',
    )
  }

  report.finished_at = new Date().toISOString()
  report.contract_requests = control.requests.map(({ path: p, method: m, body: b, seq: s }) => ({ path: p, method: m, body: b, seq: s }))
  const expectedPaths = [
    '/api/health',
    '/api/trips/example',
    '/api/trips/plan',
    '/api/trips/days/replan',
    '/api/trips/days/map-refresh',
    '/api/trips/days/leg-refresh',
    '/api/weather/day',
    '/api/poi-sources/nearby',
    '/api/web-sources/search',
  ]
  const seenPaths = new Set(control.requests.map((r) => r.path))
  report.contract_paths_expected = expectedPaths
  report.contract_paths_seen = [...seenPaths]
  const missingPaths = expectedPaths.filter((p) => !seenPaths.has(p))
  if (missingPaths.length > 0) {
    recordFailure('contract', `契约路径缺失：${missingPaths.join(', ')}`)
  }

  // 恢复场景注入声明（进报告，防阅读者误判为自然故障）
  report.resume_injection_note =
    'resumeInjection 场景的 SecurityError / QuotaExceededError 由测试脚本经 Playwright addInitScript / page.evaluate 可控注入（覆盖 window.localStorage getter 与 Storage.prototype.setItem），不是平台自然触发的 quota/权限事件；自然 quota 在 fresh 临时 profile 不可复现。'
  // 恢复场景覆盖边界（进报告，与 docs/E2E_ACCEPTANCE.md 一致）
  report.resume_coverage_limits = [
    '费用 binding=stale（只读沿用/新建）由 jsdom 集成测试覆盖，浏览器场景不造 stale 夹具。',
    '自然平台 quota、localStorage.clear() 的 key=null 事件、too_large 体积门禁不在本批（注入场景的 quota/SecurityError 是可控注入，非自然事件）。',
  ]

  const reportPath = resolve(artifactsDir, 'report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8')
  console.log(`[verify:e2e] 报告：${reportPath}`)
  console.log(
    `[verify:e2e] route 处置：fulfill瓦片=${routeSummary.fulfilledTiles} 截获公网=${routeSummary.abortedExternal} 截获其它loopback=${routeSummary.abortedLoopbackForeign} 本机放行=${routeSummary.continuedLocal} handler异常=${routeSummary.handlerErrors} 实际出站=${routeSummary.actualOutbound}`,
  )
  console.log(
    `[verify:e2e] console 分类：预期=${report.expected_console.length} 未预期=${report.unexpected_console.length}`,
  )
  if (bootstrapError !== null) {
    console.error(`[verify:e2e] 编排异常：${String(bootstrapError).slice(0, 300)}`)
  }
  if (report.failures.length > 0) {
    console.error('[verify:e2e] 存在失败：')
    for (const failure of report.failures) {
      console.error(`  - [${failure.scenario}] ${failure.message}`)
    }
    process.exitCode = 1
  } else {
    console.log('[verify:e2e] 离线契约浏览器验收：全部通过')
  }
}

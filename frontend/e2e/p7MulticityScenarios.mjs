/**
 * P7 S9 · 真实多城 App 链路 E2E（从 runner.mjs 编排调用）。
 *
 * 覆盖：
 * A. 两城全链路：真实 PlanForm 提交 cities[] → 城市分段 → 今日城市徽标 →
 *    分城城市导览/覆盖 → 地图跨日投影 → 分享卡片/离线路书城市序列 →
 *    浅/深主题截图 → 切日城际卡（estimated、距离/耗时、固定提示、无车次时刻）→
 *    切苏州分段（日 3、徽标/导览换城、城际卡消失、地图只投影苏州当天）。
 * B. 三城冒烟：杭州/苏州/南京三段城市按钮逐城切换，徽标、导览、aria-pressed、
 *    城际卡与地图站点数均正确，页面无崩溃。
 *
 * 全程离线：POST /api/trips/plan 在页面级 route 注入契约 fixture；
 * 生成内容不是真实 LLM/高德输出（后端生成由 pytest 覆盖），此处验证前端真实链路。
 */
import { expectEqual, expectTrue } from './sessionResumeScenarios.mjs'

let appOriginFromRunner = null

export function setP7MulticityAppOrigin(origin) {
  appOriginFromRunner = origin
}

const sel = {
  destinationInput: 'input[placeholder="例如：杭州"]',
  submitPlan: 'button:has-text("生成行程")',
  addCity: 'button:has-text("添加城市")',
  tripTitle: 'section[aria-label="行程安排"] h2',
  stamp: '[data-testid="stamp-seal"]',
  citySegments: '[data-testid="city-segments"]',
  todayCityBadge: '[data-testid="today-city-badge"]',
  cityProfileCard: '[data-testid="city-profile-card"]',
  cityProfileCity: '[data-testid="city-profile-city"]',
  coverageCard: '[data-testid="trip-coverage-card"]',
  healthCard: '[data-testid="itinerary-health-card"]',
  intercityCard: '[data-testid="intercity-transfer-card"]',
  intercityTitle: '[data-testid="intercity-transfer-title"]',
  intercityEstimate: '[data-testid="intercity-transfer-estimate"]',
  intercityNotice: '[data-testid="intercity-transfer-notice"]',
  shareOpen: 'button:has-text("生成分享卡片")',
  shareOverlay: '[data-testid="share-card-overlay"]',
  sharePreview: '[data-testid="share-card-preview"]',
  roadbookOpen: 'button:has-text("预览离线路书 (.html)")',
  roadbookPreview: '[data-testid="roadbook-preview"]',
  roadbookError: '[data-testid="roadbook-error"]',
  roadbookCancel: 'button:has-text("取消预览")',
  close: 'button:has-text("关闭")',
  themeToggle: '[data-testid="theme-toggle"]',
  mapMarkers: '[aria-label="交互式地图"] .leaflet-marker-icon',
}

const CITY_PROFILES = {
  杭州: {
    source: 'model_generated',
    oneLineImpression: '湖山与市井相距不远，适合慢走。',
    suggestedDays: 2,
    districts: ['西湖', '上城'],
    seasonTips: '春秋最舒适，梅雨季备伞。',
    classicList: [
      { name: '西湖', reason: '湖山代表', source: 'model_generated' },
      { name: '灵隐寺', reason: '古刹与造像', source: 'model_generated' },
    ],
  },
  苏州: {
    source: 'model_generated',
    oneLineImpression: '园林与水巷适合半日一景。',
    suggestedDays: 1,
    districts: ['姑苏'],
    seasonTips: '春看花，秋看银杏。',
    classicList: [
      { name: '拙政园', reason: '园林代表', source: 'model_generated' },
      { name: '留园', reason: '精巧小园', source: 'model_generated' },
    ],
  },
  南京: {
    source: 'model_generated',
    oneLineImpression: '山、湖、城墙与市井都在城里。',
    suggestedDays: 1,
    districts: ['玄武', '秦淮'],
    seasonTips: '秋末梧桐最好看。',
    classicList: [
      { name: '中山陵', reason: '城市地标', source: 'model_generated' },
      { name: '夫子庙', reason: '秦淮市井', source: 'model_generated' },
    ],
  },
}

function stop(id, name, time, duration, lng, lat, address, description) {
  return {
    id,
    name,
    time,
    duration_minutes: duration,
    description,
    address,
    location: { lng, lat },
  }
}

function walkLeg(from, to, distance, duration, description) {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'walking',
    route_type: 'navigation',
    distance_m: distance,
    duration_minutes: duration,
    geometry: [],
    description,
  }
}

function intercityLeg(from, to, distance, duration, fromCoord, toCoord, text) {
  return {
    from_stop_id: from,
    to_stop_id: to,
    mode: 'driving',
    route_type: 'straight_line',
    distance_m: distance,
    duration_minutes: duration,
    geometry: [
      { lng: fromCoord[0], lat: fromCoord[1] },
      { lng: toCoord[0], lat: toCoord[1] },
    ],
    description: text,
    transferKind: 'intercity',
  }
}

function tripDays() {
  return [
    {
      day: 1,
      date: '2026-11-14',
      city: '杭州',
      title: '西湖与灵隐',
      summary: '湖边走一段，再去灵隐。',
      stops: [
        stop('hz-xihu', '西湖', '09:00', 120, 120.148, 30.246, '西湖景区', '沿湖慢走。'),
        stop('hz-lingyin', '灵隐寺', '13:30', 90, 120.101, 30.241, '灵隐路 1 号', '看飞来峰造像。'),
      ],
      legs: [walkLeg('hz-xihu', 'hz-lingyin', 4500, 55, '沿湖步行到灵隐。')],
    },
    {
      day: 2,
      date: '2026-11-15',
      city: '杭州',
      title: '龙井与河坊街',
      summary: '茶山半日，傍晚回城。',
      stops: [
        stop('hz-longjing', '龙井村', '09:30', 90, 120.105, 30.219, '龙井村', '茶山步道。'),
        stop('hz-hefang', '河坊街', '13:00', 60, 120.169, 30.243, '河坊街', '老街小吃。'),
      ],
      legs: [
        walkLeg('hz-longjing', 'hz-hefang', 3200, 40, '下山进城。'),
        intercityLeg(
          'hz-hefang',
          'sz-zhuozhengyuan',
          130000,
          72,
          [120.169, 30.243],
          [120.629, 31.325],
          '城际转移：杭州 → 苏州，直线距离约 130 公里，建议预留约 1 小时 12 分钟（不含市内接驳与候车）。',
        ),
      ],
    },
    {
      day: 3,
      date: '2026-11-16',
      city: '苏州',
      title: '园林与平江路',
      summary: '一座园林，一条水巷。',
      stops: [
        stop('sz-zhuozhengyuan', '拙政园', '09:30', 120, 120.629, 31.325, '东北街 178 号', '看中部花园。'),
        stop('sz-pingjiang', '平江路', '13:30', 90, 120.634, 31.314, '平江路', '沿河慢走。'),
      ],
      legs: [walkLeg('sz-zhuozhengyuan', 'sz-pingjiang', 1800, 25, '步行到平江路。')],
    },
  ]
}

function twoCityTrip() {
  return {
    id: 'trip-e2e-multicity-two',
    source: 'agent',
    destination: '杭州',
    title: '杭州 · 苏州 三日行程',
    summary: '杭州两日，苏州一日。',
    map_coordinate_system: 'WGS84',
    warnings: [],
    days: tripDays(),
    cityProfiles: {
      杭州: CITY_PROFILES.杭州,
      苏州: CITY_PROFILES.苏州,
    },
  }
}

function threeCityTrip() {
  const days = tripDays()
  days[2].legs.push(
    intercityLeg(
      'sz-pingjiang',
      'nj-zhongshanling',
      null,
      null,
      [120.634, 31.314],
      [118.853, 32.059],
      '城际转移：苏州 → 南京，距离与耗时未知，请自行查询。',
    ),
  )
  days.push({
    day: 4,
    date: '2026-11-17',
    city: '南京',
    title: '中山陵与夫子庙',
    summary: '上午上山，傍晚进城。',
    stops: [
      stop('nj-zhongshanling', '中山陵', '09:30', 120, 118.853, 32.059, '中山陵园', '登台阶看城。'),
      stop('nj-fuzimiao', '夫子庙', '14:00', 90, 118.783, 32.02, '夫子庙', '秦淮河边。'),
    ],
    legs: [walkLeg('nj-zhongshanling', 'nj-fuzimiao', 6800, 50, '下山进城。')],
  })
  return {
    ...twoCityTrip(),
    id: 'trip-e2e-multicity-three',
    title: '杭州 · 苏州 · 南京 四日行程',
    summary: '杭州两日，苏州一日，南京一日。',
    days,
    cityProfiles: {
      杭州: CITY_PROFILES.杭州,
      苏州: CITY_PROFILES.苏州,
      南京: CITY_PROFILES.南京,
    },
  }
}

async function openApp(page) {
  await page.goto(appOriginFromRunner, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector(sel.tripTitle, { timeout: 15000 })
}

async function submitPlan(page, trip, extraCities = []) {
  let requestBody = null
  await page.route('**/api/trips/plan', async (route) => {
    try {
      requestBody = route.request().postDataJSON()
    } catch {
      requestBody = null
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(trip),
    })
  })
  await page.fill(sel.destinationInput, trip.destination)
  await page.getByLabel('天数', { exact: true }).fill(String(trip.days.length))
  for (let index = 0; index < extraCities.length; index += 1) {
    await page.click(sel.addCity)
    const city = extraCities[index]
    await page.getByLabel(`第 ${index + 2} 座城市`, { exact: true }).fill(city.name)
    await page.getByLabel(`第 ${index + 2} 座城市天数`, { exact: true }).fill(String(city.days))
  }
  await page.click(sel.submitPlan)
  try {
    await page.waitForSelector(sel.stamp, { timeout: 20000 })
  } catch (error) {
    const alerts = await page.locator('[role="alert"]').allTextContents().catch(() => [])
    const bodyText = ((await page.textContent('body').catch(() => '')) ?? '').slice(0, 1600)
    throw new Error(
      `${error.message}\nrequest=${JSON.stringify(requestBody)}\nalerts=${JSON.stringify(alerts)}\nbody=${bodyText}`,
    )
  }
  return requestBody
}

async function waitCitySegment(page, city) {
  const button = page.locator(`${sel.citySegments} button[data-city="${city}"]`)
  await button.waitFor({ state: 'visible', timeout: 15000 })
  return button
}

async function waitCityProfile(page, city) {
  await page.waitForFunction(
    ({ card, citySelector, expected }) => {
      const root = document.querySelector(card)
      const label = root?.querySelector(citySelector)?.textContent?.trim() ?? ''
      return root != null && label === expected
    },
    { card: sel.cityProfileCard, citySelector: sel.cityProfileCity, expected: city },
    { timeout: 15000 },
  )
  const badge = (await page.textContent('[data-testid="city-profile-badge"]')) ?? ''
  expectTrue(badge.includes('AI 生成·供参考'), `${city} 城市导览缺少 model_generated 徽章：${badge}`)
}

async function waitMarkers(page, expected, city) {
  try {
    await page.waitForFunction(
      ({ selector, count }) => document.querySelectorAll(selector).length === count,
      { selector: sel.mapMarkers, count: expected },
      { timeout: 15000 },
    )
  } catch (error) {
    const actual = await page.locator(sel.mapMarkers).count().catch(() => -1)
    throw new Error(`${city} 地图 marker 数等待 ${expected} 失败，实际 ${actual}：${error.message}`)
  }
  const labels = await page
    .locator(sel.mapMarkers)
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? ''))
  expectTrue(
    labels.some((label) => label.includes(city)),
    `${city} 地图 marker 缺少城市站点：${labels.join(' | ')}`,
  )
  return labels
}

async function switchDay(page, day) {
  await page.click(`#day-tab-${day}`)
  await page.waitForFunction(
    (index) => document.querySelector(`#day-tab-${index}`)?.getAttribute('aria-selected') === 'true',
    day,
    { timeout: 10000 },
  )
}

async function openSharePanel(page) {
  await page.click(sel.shareOpen)
  await page.waitForSelector(sel.shareOverlay, { timeout: 10000 })
  await page.waitForSelector(sel.sharePreview, { timeout: 10000 })
}

async function closeSharePanel(page) {
  const cancel = page.locator(sel.roadbookCancel)
  if ((await cancel.count()) > 0) {
    await cancel.click()
  }
  await page.click(`${sel.shareOverlay} ${sel.close}`)
  await page.waitForSelector(sel.shareOverlay, { state: 'detached', timeout: 10000 })
}

async function assertShareCities(page, expectedLabel) {
  const previewText = await page.textContent(sel.sharePreview)
  expectTrue(
    (previewText ?? '').includes(expectedLabel),
    `分享卡片缺少城市序列 ${expectedLabel}：${previewText ?? ''}`,
  )
  await page.click(sel.roadbookOpen)
  await page.waitForSelector(sel.roadbookPreview, { timeout: 10000 })
  const srcdoc = await page.getAttribute(sel.roadbookPreview, 'srcdoc')
  expectTrue((srcdoc ?? '').includes(expectedLabel), '离线路书缺少城市序列')
  const error = await page.locator(sel.roadbookError).count()
  expectTrue(error === 0, '离线路书渲染失败')
}

async function setTheme(page, label) {
  await page.click(`${sel.themeToggle} button:has-text("${label}")`)
  if (label === '深色') {
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'), null, {
      timeout: 5000,
    })
  } else {
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), null, {
      timeout: 5000,
    })
  }
}

/* ───────────────────── A · 两城全链路 ───────────────────── */

export async function runP7MulticityTwoCityScenario({ page, rec, screenshot }) {
  let requestBody = null

  await rec.step('提交两城表单：请求 cities[] = 杭州2/苏州1', async () => {
    await openApp(page)
    requestBody = await submitPlan(page, twoCityTrip(), [{ name: '苏州', days: 1 }])
    expectEqual(
      requestBody?.cities,
      [
        { name: '杭州', days: 2 },
        { name: '苏州', days: 1 },
      ],
      '多城请求体 cities 异常',
    )
    const title = (await page.textContent(sel.tripTitle)) ?? ''
    expectTrue(title.includes('杭州 · 苏州'), `多城标题异常：${title}`)
    return { cities: requestBody?.cities, title }
  })

  await rec.step('城市分段、今日徽标、城市导览与分城覆盖', async () => {
    const hangzhou = await waitCitySegment(page, '杭州')
    const suzhou = await waitCitySegment(page, '苏州')
    expectTrue((await hangzhou.getAttribute('aria-pressed')) === 'true', '初始城市分段不是杭州')
    expectTrue((await suzhou.getAttribute('aria-pressed')) === 'false', '初始城市分段错误激活苏州')
    expectTrue((await hangzhou.textContent() ?? '').includes('杭州 · 2 天'), '杭州分段天数异常')
    expectTrue((await suzhou.textContent() ?? '').includes('苏州 · 1 天'), '苏州分段天数异常')

    const badge = (await page.textContent(sel.todayCityBadge)) ?? ''
    expectTrue(badge.includes('杭州'), `今日城市徽标异常：${badge}`)
    await waitCityProfile(page, '杭州')

    await page.waitForSelector('[data-testid="trip-coverage-city-1"]', { timeout: 15000 })
    const hzCoverage = (await page.textContent('[data-testid="trip-coverage-city-0"]')) ?? ''
    const szCoverage = (await page.textContent('[data-testid="trip-coverage-city-1"]')) ?? ''
    expectTrue(hzCoverage.includes('杭州 · 已覆盖 2/2'), `杭州覆盖异常：${hzCoverage}`)
    expectTrue(szCoverage.includes('苏州 · 已覆盖 1/2'), `苏州覆盖异常：${szCoverage}`)
    await page.waitForSelector(sel.healthCard, { timeout: 15000 })
    return { badge, hzCoverage, szCoverage }
  })

  await rec.step('地图默认投影杭州连续两天（4 个站点）', async () => {
    const labels = await waitMarkers(page, 4, '西湖')
    expectTrue(labels.some((label) => label.includes('龙井村')), '地图缺少杭州第二天站点')
    return { markers: labels }
  })

  await rec.step('分享卡片与离线路书包含两城城市序列', async () => {
    await openSharePanel(page)
    await assertShareCities(page, '杭州 · 苏州')
    await closeSharePanel(page)
  })

  await rec.step('浅色与深色主题截图', async () => {
    await setTheme(page, '浅色')
    await page.locator('.map-container').scrollIntoViewIfNeeded()
    await screenshot(page, '90-p7-multicity-two-city-light.png')
    await setTheme(page, '深色')
    await page.locator('.map-container').scrollIntoViewIfNeeded()
    await screenshot(page, '91-p7-multicity-two-city-dark.png')
    await setTheme(page, '浅色')
  })

  await rec.step('切到第 2 天：城际卡 estimated、距离/耗时/固定提示，无车次时刻', async () => {
    await switchDay(page, 2)
    await page.waitForSelector(`${sel.intercityCard}[data-state="estimated"]`, { timeout: 15000 })
    const title = (await page.textContent(sel.intercityTitle)) ?? ''
    expectTrue(title.includes('城际转移 · 杭州 → 苏州'), `城际卡标题异常：${title}`)
    const estimate = (await page.textContent(sel.intercityEstimate)) ?? ''
    expectTrue(estimate.includes('直线约 130.0 公里'), `城际距离异常：${estimate}`)
    expectTrue(estimate.includes('约 1 小时 12 分钟'), `城际耗时异常：${estimate}`)
    const notice = (await page.textContent(sel.intercityNotice)) ?? ''
    expectTrue(notice.includes('具体班次与时刻未提供，请自行查询。'), `城际提示异常：${notice}`)
    const cardText = (await page.textContent(sel.intercityCard)) ?? ''
    expectTrue(!/[GDC]\d{1,4}|\d{1,2}:\d{2}\s*[—-]\s*\d{1,2}:\d{2}/.test(cardText), `城际卡疑似出现车次/时刻表：${cardText}`)
    const labels = await waitMarkers(page, 4, '西湖')
    expectTrue(labels.some((label) => label.includes('河坊街')), '第 2 天地图缺少河坊街')
    await page.locator(sel.intercityCard).scrollIntoViewIfNeeded()
    await screenshot(page, '92-p7-multicity-two-city-intercity.png')
    return { title, estimate, notice }
  })

  await rec.step('切苏州分段：日 3、徽标/导览换城、城际卡消失、地图只投影苏州当天', async () => {
    const suzhou = await waitCitySegment(page, '苏州')
    await suzhou.click()
    await page.waitForFunction(
      () => document.querySelector('#day-tab-3')?.getAttribute('aria-selected') === 'true',
      null,
      { timeout: 10000 },
    )
    expectTrue((await suzhou.getAttribute('aria-pressed')) === 'true', '苏州分段未激活')
    const badge = (await page.textContent(sel.todayCityBadge)) ?? ''
    expectTrue(badge.includes('苏州'), `切城后今日徽标异常：${badge}`)
    await waitCityProfile(page, '苏州')
    expectTrue((await page.locator(sel.intercityCard).count()) === 0, '苏州当天不应再有城际卡')
    const labels = await waitMarkers(page, 2, '拙政园')
    expectTrue(labels.some((label) => label.includes('平江路')), '苏州地图缺少平江路')
    await page.locator(sel.citySegments).scrollIntoViewIfNeeded()
    await screenshot(page, '93-p7-multicity-two-city-suzhou.png')
    return { badge, markers: labels }
  })
}

/* ───────────────────── B · 三城冒烟 ───────────────────── */

export async function runP7MulticityThreeCityScenario({ page, rec, screenshot }) {
  let requestBody = null

  await rec.step('提交三城表单：请求 cities[] = 杭州2/苏州1/南京1', async () => {
    await openApp(page)
    requestBody = await submitPlan(page, threeCityTrip(), [
      { name: '苏州', days: 1 },
      { name: '南京', days: 1 },
    ])
    expectEqual(
      requestBody?.cities,
      [
        { name: '杭州', days: 2 },
        { name: '苏州', days: 1 },
        { name: '南京', days: 1 },
      ],
      '三城请求体 cities 异常',
    )
    for (const city of ['杭州', '苏州', '南京']) {
      await waitCitySegment(page, city)
    }
    expectEqual(await page.locator(`${sel.citySegments} button`).count(), 3, '三城分段按钮数量异常')
    return { cities: requestBody?.cities }
  })

  await rec.step('逐城切换：徽标、导览、aria-pressed、地图与城际卡', async () => {
    const hangzhou = await waitCitySegment(page, '杭州')
    expectTrue((await hangzhou.getAttribute('aria-pressed')) === 'true', '三城初始未激活杭州')
    await waitCityProfile(page, '杭州')
    const initialLabels = await waitMarkers(page, 4, '西湖')
    expectTrue(initialLabels.some((label) => label.includes('龙井村')), '三城杭州地图缺少龙井村')
    await page.locator('.map-container').scrollIntoViewIfNeeded()
    await screenshot(page, '94-p7-multicity-three-city-hangzhou.png')

    const suzhou = await waitCitySegment(page, '苏州')
    await suzhou.click()
    await page.waitForFunction(
      () => document.querySelector('#day-tab-3')?.getAttribute('aria-selected') === 'true',
      null,
      { timeout: 10000 },
    )
    expectTrue((await suzhou.getAttribute('aria-pressed')) === 'true', '三城未激活苏州')
    expectTrue(((await page.textContent(sel.todayCityBadge)) ?? '').includes('苏州'), '三城苏州徽标异常')
    await waitCityProfile(page, '苏州')
    await waitMarkers(page, 2, '拙政园')
    await page.waitForSelector(`${sel.intercityCard}[data-state="unknown"]`, { timeout: 15000 })
    const szTitle = (await page.textContent(sel.intercityTitle)) ?? ''
    expectTrue(szTitle.includes('城际转移 · 苏州 → 南京'), `三城苏州城际卡异常：${szTitle}`)
    const unknownText = (await page.textContent('[data-testid="intercity-transfer-unknown"]')) ?? ''
    expectTrue(unknownText.includes('距离与耗时未知'), `三城城际卡未知态异常：${unknownText}`)
    expectTrue((await page.locator(sel.intercityEstimate).count()) === 0, '未知态不应出现估算行')
    const szNotice = (await page.textContent(sel.intercityNotice)) ?? ''
    expectTrue(szNotice.includes('具体班次与时刻未提供，请自行查询。'), `三城城际提示异常：${szNotice}`)
    await page.locator(sel.intercityCard).scrollIntoViewIfNeeded()
    await screenshot(page, '95-p7-multicity-three-city-suzhou.png')

    const nanjing = await waitCitySegment(page, '南京')
    await nanjing.click()
    await page.waitForFunction(
      () => document.querySelector('#day-tab-4')?.getAttribute('aria-selected') === 'true',
      null,
      { timeout: 10000 },
    )
    expectTrue((await nanjing.getAttribute('aria-pressed')) === 'true', '三城未激活南京')
    expectTrue(((await page.textContent(sel.todayCityBadge)) ?? '').includes('南京'), '三城南京徽标异常')
    await waitCityProfile(page, '南京')
    const labels = await waitMarkers(page, 2, '中山陵')
    expectTrue(labels.some((label) => label.includes('夫子庙')), '三城南京地图缺少夫子庙')
    expectTrue((await page.locator(sel.intercityCard).count()) === 0, '南京当天不应再有城际卡')
    await page.locator(sel.citySegments).scrollIntoViewIfNeeded()
    await screenshot(page, '96-p7-multicity-three-city-nanjing.png')
    return { szTitle, nanjingMarkers: labels }
  })
}

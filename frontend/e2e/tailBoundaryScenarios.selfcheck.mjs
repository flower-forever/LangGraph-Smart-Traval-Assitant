/**
 * tailBoundaryScenarios 的模块级小测试（不启浏览器，node 直接跑）：
 * 守住计数器相对增量语义、选择器/文案常量形态、与既有模块的 import 独立性。
 * 属于任务书允许的「必要本模块小测试」；不是浏览器验收，不声称 E2E 通过。
 */
import { strict as assert } from 'node:assert'
import {
  countLegRefreshRequests,
  lastLegRefreshRequest,
  tailSel,
  tailText,
  setTailBoundaryAppOrigin,
} from './tailBoundaryScenarios.mjs'
import { bizSel, expectEqual, expectTrue } from './sessionResumeScenarios.mjs'

// 计数器：空 control 为 0；只按 path 过滤，replan 不计入
const control = { requests: [], responses: [] }
assert.equal(countLegRefreshRequests(control), 0)
control.requests.push({ path: '/api/trips/days/replan', method: 'POST', body: {}, seq: 0 })
control.requests.push({
  path: '/api/trips/days/leg-refresh',
  method: 'POST',
  body: { day: 1 },
  seq: 1,
  settled: Promise.resolve('responded'),
})
assert.equal(countLegRefreshRequests(control), 1)
assert.equal(lastLegRefreshRequest(control).seq, 1)
assert.equal(lastLegRefreshRequest(control).path, '/api/trips/days/leg-refresh')

// 相对增量：baseCount 语义成立
const baseCount = countLegRefreshRequests(control)
control.requests.push({
  path: '/api/trips/days/leg-refresh',
  method: 'POST',
  body: { day: 1 },
  seq: 2,
  settled: Promise.resolve('responded'),
})
assert.equal(countLegRefreshRequests(control) - baseCount, 1)

// 选择器：语义 role/text 优先，锚点 radio/select 与已提交基线对齐
assert.equal(tailSel.tailRangeRadio.includes('[value="tail"]'), true)
assert.equal(tailSel.anchorSelect.includes('select'), true)
// 新控件用期望文案，不用过宽 regex
assert.equal(tailSel.queryBoundary, 'button:has-text("获取衔接路线")')
assert.equal(tailSel.stopBoundary, 'button:has-text("停止等待衔接路线")')
assert.equal(tailSel.discardBoundary, 'button:has-text("舍弃衔接路线")')
assert.equal(tailSel.applyTailWithRoute, 'button:has-text("应用后段与衔接路线")')
assert.equal(tailSel.applyTailUnknown, 'button:has-text("仅应用后段（衔接未知）")')

// 期望文案常量集中（适配点），不过宽
assert.equal(tailText.unknownNoticeFragment, '锚点衔接路线未重算')
assert.equal(tailText.routeSourceFragment, '高德地图')
assert.equal(tailText.routeCoordinateFragment, 'WGS84')
assert.equal(tailText.routeIdentityFragment, '未重新核对')
assert.equal(tailText.stopBoundaryFeedbackFragment, '已停止等待衔接路线')

// appOrigin setter 可调用（runner 编排用）
setTailBoundaryAppOrigin('http://127.0.0.1:1234')

// 与既有模块共享的 helper 签名一致（runner 复用同一 expectTrue/expectEqual）
assert.equal(typeof expectTrue, 'function')
assert.equal(typeof expectEqual, 'function')
assert.equal(typeof bizSel.openBudget, 'string')

console.log('tailBoundaryScenarios module tests: all passed')

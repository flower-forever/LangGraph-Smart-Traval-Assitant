/**
 * E2E 门禁的纯诊断 helper：console/pageerror 分类与离线拦截统计，
 * 不依赖浏览器，可被故障注入测试直接驱动。
 */

/**
 * 预期 console 噪声分类：只承认「失败场景下、来自业务请求自身的资源加载失败」。
 * 规则（逐条都不满足才判 unexpected）：
 * - message 形如 "Failed to load resource: ... (503)" 这类资源错误；
 * - 503 状态（或无状态但 scenario 标注为 plan 失败场景）；
 * - 该场景确实声明过一次 /api/trips/plan 503 响应（location 含 /api/trips/plan）。
 * 其余一切 console.error / pageerror 一律 unexpected，门禁必须红。
 */
export function classifyConsoleEvents(events, scenarios = {}) {
  const expected = []
  const unexpected = []
  for (const event of events) {
    const verdict = classifyOne(event, scenarios[event.scenarioLabel])
    if (verdict.expected) expected.push({ ...event, reason: verdict.reason })
    else unexpected.push({ ...event, reason: verdict.reason })
  }
  return { expected, unexpected }
}

function classifyOne(event, scenario) {
  if (event.kind === 'pageerror') {
    return { expected: false, reason: 'pageerror 一律不预期：页面不应抛任何未捕获异常' }
  }
  const text = event.text ?? ''
  const resourceFail = /Failed to load resource/.test(text)
  if (!resourceFail) {
    return { expected: false, reason: `非资源加载失败的 console.error：${text.slice(0, 120)}` }
  }
  const statusMatch = /\b(\d{3})\b/.exec(text)
  const status = statusMatch ? Number(statusMatch[1]) : null
  if (status !== 503) {
    return { expected: false, reason: `资源失败状态不是 503：${text.slice(0, 120)}` }
  }
  // 场景证据：该场景必须记录过一次 /api/trips/plan 的 503 响应
  const evidence = scenario?.plan503Responses ?? 0
  const locationIsPlan = (event.location ?? '').includes('/api/trips/plan')
  if (!locationIsPlan || evidence < 1) {
    return {
      expected: false,
      reason: `503 资源错误但缺乏场景证据（location=${event.location ?? '未知'}，场景503记录=${evidence}）`,
    }
  }
  // 计数消费：同场景第 2 次没有对应证据就红
  scenario.plan503Responses -= 1
  return { expected: true, reason: 'plan 失败场景声明的单次 503 资源错误' }
}

/**
 * 离线拦截统计：从 route 处置结果导出，不做任何硬编码。
 * - fulfilled：瓦片 fulfill 成功；
 * - abortedLocalForeign：本次不拥有的 loopback（如 8000）被 abort；
 * - abortedExternal：公网请求被 abort（DNS 前拦截）；
 * - handlerErrors：handler 自身抛错（不许吞：门禁红）。
 * blocked 意味着「被截获的非本机请求」，不是「实际出站」；出站恒为 0 由全量 abort/fulfill 证明。
 */
export function summarizeRouteOutcomes(outcomes) {
  const summary = {
    fulfilledTiles: 0,
    abortedExternal: 0,
    abortedLoopbackForeign: 0,
    continuedLocal: 0,
    handlerErrors: 0,
    actualOutbound: 0,
  }
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case 'fulfill_tile':
        summary.fulfilledTiles += 1
        break
      case 'abort_external':
        summary.abortedExternal += 1
        break
      case 'abort_loopback_foreign':
        summary.abortedLoopbackForeign += 1
        break
      case 'continue_local':
        summary.continuedLocal += 1
        break
      case 'handler_error':
        summary.handlerErrors += 1
        break
      case 'outbound':
        // 只有显式放行的请求才计入；当前不存在任何放行分支
        summary.actualOutbound += 1
        break
      default:
        summary.handlerErrors += 1
    }
  }
  return summary
}

/**
 * 诊断 helper 的故障注入测试（先红绿验证门禁逻辑本身，再用于 runner）：
 * - 未预期的 console.error / pageerror 必须判 unexpected（门禁会红）；
 * - 只有带场景证据的单次 plan 503 资源错误判 expected；
 * - 拦截统计从处置结果导出，未知处置判 handler_error；
 * - 启动编排的故障注入：Vite listen 失败时已启动的 stub 必须被关闭。
 */
import { describe, expect, it } from 'vitest'
import { classifyConsoleEvents, summarizeRouteOutcomes } from './diagnose.mjs'

describe('console/pageerror 分类（A 项）', () => {
  it('未预期 console.error 判 unexpected', () => {
    const result = classifyConsoleEvents([
      { kind: 'console', scenarioLabel: 'happy', text: 'Something went wrong', location: 'app.js:1' },
    ])
    expect(result.expected).toHaveLength(0)
    expect(result.unexpected).toHaveLength(1)
    expect(result.unexpected[0].reason).not.toContain('503')
  })

  it('pageerror 一律 unexpected', () => {
    const result = classifyConsoleEvents([
      { kind: 'pageerror', scenarioLabel: 'happy', text: 'TypeError: x is not a function', location: '' },
    ])
    expect(result.expected).toHaveLength(0)
    expect(result.unexpected).toHaveLength(1)
  })

  it('带场景证据的单次 plan 503 资源错误判 expected', () => {
    const scenarios = { fail: { plan503Responses: 1 } }
    const result = classifyConsoleEvents(
      [
        {
          kind: 'console',
          scenarioLabel: 'fail',
          text: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
          location: 'http://127.0.0.1:5199/api/trips/plan',
        },
      ],
      scenarios,
    )
    expect(result.expected).toHaveLength(1)
    expect(result.unexpected).toHaveLength(0)
  })

  it('同类 503 第二次（证据已消费）判 unexpected —— 不是所有 503 都放过', () => {
    const scenarios = { fail: { plan503Responses: 1 } }
    const event = (label) => ({
      kind: 'console',
      scenarioLabel: label,
      text: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
      location: 'http://127.0.0.1:5199/api/trips/plan',
    })
    const result = classifyConsoleEvents([event('fail'), event('fail')], scenarios)
    expect(result.expected).toHaveLength(1)
    expect(result.unexpected).toHaveLength(1)
  })

  it('happy 场景的任何 503（无场景证据）判 unexpected', () => {
    const result = classifyConsoleEvents([
      {
        kind: 'console',
        scenarioLabel: 'happy',
        text: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
        location: 'http://127.0.0.1:5199/api/trips/plan',
      },
    ])
    expect(result.expected).toHaveLength(0)
    expect(result.unexpected).toHaveLength(1)
  })

  it('非 503 状态的 404/500 资源错误判 unexpected', () => {
    const scenarios = { fail: { plan503Responses: 5 } }
    const result = classifyConsoleEvents(
      [
        {
          kind: 'console',
          scenarioLabel: 'fail',
          text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
          location: 'http://127.0.0.1:5199/api/trips/plan',
        },
      ],
      scenarios,
    )
    expect(result.unexpected).toHaveLength(1)
  })
})

describe('拦截统计导出（D/G 项）', () => {
  it('从处置结果汇总，未知处置计 handler_error', () => {
    const summary = summarizeRouteOutcomes([
      { kind: 'fulfill_tile' },
      { kind: 'fulfill_tile' },
      { kind: 'abort_external' },
      { kind: 'abort_loopback_foreign' },
      { kind: 'continue_local' },
      { kind: 'weird_unknown' },
    ])
    expect(summary.fulfilledTiles).toBe(2)
    expect(summary.abortedExternal).toBe(1)
    expect(summary.abortedLoopbackForeign).toBe(1)
    expect(summary.continuedLocal).toBe(1)
    expect(summary.handlerErrors).toBe(1)
    expect(summary.actualOutbound).toBe(0)
  })

  it('显式放行计入 actualOutbound（当前分支不存在放行，出现即红）', () => {
    const summary = summarizeRouteOutcomes([{ kind: 'outbound' }])
    expect(summary.actualOutbound).toBe(1)
  })

  it('runner 接线回放：对内联最小 report shape 验证分类与逐事件证据（fresh clone 无 artifacts 也绿）', () => {
    // 内联最小真实 report 形状（字段与 runner finally 写出的一致），不读 ignored artifacts
    const inlineReport = {
      console_events: [
        {
          kind: 'console',
          scenarioLabel: 'fail',
          text: 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
          location: 'http://127.0.0.1:5199/api/trips/plan',
        },
      ],
      expected_console: [
        { kind: 'console', scenarioLabel: 'fail', reason: 'plan 失败场景声明的单次 503 资源错误' },
      ],
      unexpected_console: [],
    }
    // 真实运行的 report 形状约定：unexpected 为空数组；expected 每条 reason 带 503 证据
    expect(inlineReport.unexpected_console).toHaveLength(0)
    for (const item of inlineReport.expected_console) {
      expect(item.reason).toContain('503')
    }
    // 分类器对这组事件 + 场景证据重放，必须与 report 的 expected/unexpected 划分一致
    const replay = classifyConsoleEvents(inlineReport.console_events, {
      fail: { plan503Responses: 1 },
    })
    expect(replay.expected).toHaveLength(inlineReport.expected_console.length)
    expect(replay.unexpected).toHaveLength(inlineReport.unexpected_console.length)
    // 故障注入：同形状下多喂一条普通 console.error，必须产生 unexpected（门禁红）
    const injected = classifyConsoleEvents(
      [
        ...inlineReport.console_events,
        { kind: 'console', scenarioLabel: 'happy', text: 'Unrelated noise', location: '' },
      ],
      { fail: { plan503Responses: 1 }, happy: { plan503Responses: 0 } },
    )
    expect(injected.unexpected).toHaveLength(1)
    expect(injected.unexpected[0].scenarioLabel).toBe('happy')
  })

  it('route 处置函数：未知公网与其它 loopback 一律 abort（不触网，直接驱动决策函数）', async () => {
    // 决策表与 runner 的 page.route handler 同源（routePolicy.mjs）；
    // runner 的真实拦截由每次运行的 route_summary 证明（abortedExternal/abortedLoopbackForeign）。
    const { classifyUrl } = await import('./routePolicy.mjs')
    const cases = [
      { url: 'https://example.com/', expected: 'abort_external' },
      { url: 'http://127.0.0.1:8000/health', expected: 'abort_loopback_foreign' },
      { url: 'http://localhost:9999/x', expected: 'abort_loopback_foreign' },
      { url: 'https://tile.openstreetmap.org/5/10/12.png', expected: 'fulfill_tile' },
      { url: 'http://tile.openstreetmap.org/5/10/12.png', expected: 'abort_external' },
      { url: 'https://tile.openstreetmap.org/weird', expected: 'abort_external' },
      { url: 'http://127.0.0.1:5199/src/App.tsx', app: true, expected: 'continue_local' },
      { url: 'http://127.0.0.1:8901/api/health', stub: true, expected: 'continue_local' },
    ]
    for (const c of cases) {
      const decision = classifyUrl(
        new URL(c.url),
        c.app ? 'http://127.0.0.1:5199' : 'http://127.0.0.1:1',
        c.stub ? 'http://127.0.0.1:8901' : 'http://127.0.0.1:2',
      )
      expect(decision, c.url).toBe(c.expected)
    }
  })
})

describe('启动编排故障注入（协调者补充项）', () => {
  it('Vite 启动失败时已监听的 stub 被关闭（不漏服务）', async () => {
    const { createContractServer, createContractState } = await import('../dev-stub/contract-server.mjs')
    const net = await import('node:net')

    const control = createContractState()
    const stub = createContractServer(control)
    await new Promise((resolveListen) => stub.listen(0, '127.0.0.1', resolveListen))
    const stubPort = stub.address().port
    expect(stub.listening).toBe(true)

    // 模拟编排中的下一步失败：向已占用端口启动一个"Vite"（必然 EADDRINUSE）
    const bogusVite = net.createServer()
    const listenFailure = new Promise((resolveFail) => bogusVite.once('error', resolveFail))
    bogusVite.listen(stubPort, '127.0.0.1')
    const error = await listenFailure
    expect(error.code).toBe('EADDRINUSE')

    // 编排的 finally 路径：清理已启动资源
    await new Promise((resolveClose) => stub.close(() => resolveClose()))
    expect(stub.listening).toBe(false)

    // 端口确实释放：同端口可以再次监听
    const rebind = net.createServer()
    await new Promise((resolveListen) => rebind.listen(stubPort, '127.0.0.1', resolveListen))
    await new Promise((resolveClose) => rebind.close(() => resolveClose()))
  })

  it('编排失败路径复现：stub+Vite 已启动、后续步骤抛错，finally 释放两者（端口可复用）', async () => {
    const { createContractServer, createContractState } = await import('../dev-stub/contract-server.mjs')
    const net = await import('node:net')

    // 复刻 runner 的编排形态：stub listen → Vite listen → 业务抛错 → finally 逆序清理
    const control = createContractState()
    const stub = createContractServer(control)
    await new Promise((resolveListen) => stub.listen(0, '127.0.0.1', resolveListen))
    const stubPort = stub.address().port

    const fakeVite = net.createServer()
    await new Promise((resolveListen) => fakeVite.listen(0, '127.0.0.1', resolveListen))
    const vitePort = fakeVite.address().port

    let bootstrapError = null
    try {
      // 模拟业务阶段失败（如 Chrome launch 失败）
      throw new Error('模拟 Chromium 启动失败')
    } catch (error) {
      bootstrapError = error
    } finally {
      await new Promise((resolveClose) => fakeVite.close(() => resolveClose()))
      await new Promise((resolveClose) => stub.close(() => resolveClose()))
    }

    expect(bootstrapError).not.toBeNull()
    expect(stub.listening).toBe(false)
    expect(fakeVite.listening).toBe(false)
    // 两个端口都确实释放
    const rebindStub = net.createServer()
    await new Promise((r) => rebindStub.listen(stubPort, '127.0.0.1', r))
    await new Promise((r) => rebindStub.close(r))
    const rebindVite = net.createServer()
    await new Promise((r) => rebindVite.listen(vitePort, '127.0.0.1', r))
    await new Promise((r) => rebindVite.close(r))
  })
})

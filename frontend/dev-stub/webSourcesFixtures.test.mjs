/**
 * 网页资料搜索契约桩的 HTTP 路径测试：真实起服 contract-server，用 node:http
 * 走完整 socket（不 mock transport）。重点守住：
 * - 每次请求恰好一条 control.requests 记录（seq 递增、settled 生命周期）；
 * - 桩不隐式重试：一次点击 = 一次 POST = 一条记录，客户端必须显式重发；
 * - query 原样 echo（FEFF 属 Python 非空白，client 已规范化，桩不得 trim）；
 * - 本地形状不符 → 固定 422，不回显原始 body；
 * - 业务失败（no_key / unavailable）信封 HTTP 200 + x-web-sources-status 头；
 * - deferred gate：请求挂起、release 放行、客户端断开在桩侧呈现为 aborted。
 * 只起本机 http 服务，不访问 Tavily、模型或任何外网。
 */
import http from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  createContractServer,
  createContractState,
} from './contract-server.mjs'

let server
let port

/** runner 同款 deferred gate：waiters + pendingCount + release（不共享代码，形态一致） */
function createGate() {
  const gate = { waiters: [] }
  gate.pendingCount = () => gate.waiters.length
  gate.release = () => {
    for (const resolveWaiter of gate.waiters.splice(0)) resolveWaiter()
  }
  return gate
}

function request(path, { method = 'GET', rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: rawBody !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null }),
        )
      },
    )
    req.on('error', reject)
    if (rawBody !== undefined) req.write(rawBody)
    req.end()
  })
}

/** 打开 socket 后立刻销毁：模拟浏览器 abort 在途请求（gate 场景）。
 * 销毁引发的读错误（ECONNRESET）在客户端侧是预期事件，不是测试失败。 */
function requestThenAbort(path, rawBody) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      () => {},
    )
    req.on('error', () => resolve())
    req.on('close', () => resolve())
    if (rawBody !== undefined) req.write(rawBody)
    req.end()
    setTimeout(() => req.destroy(), 300)
  })
}

/** gate 挂起计数轮询（无固定 sleep 等待响应，显式证据优先） */
async function waitForGatePending(gate, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs
  while (gate.pendingCount() === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  server = createContractServer(control)
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  port = server.address().port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

afterEach(() => {
  control.webSourcesMode = null
  control.webSourcesDelay?.release()
  control.webSourcesDelay = null
})

const control = createContractState()
const SEARCH_PATH = '/api/web-sources/search'

describe('网页资料搜索契约桩（HTTP 路径）', () => {
  it('默认模式 available：一请求一记录，200 信封带 x-web-sources-status 头', async () => {
    const before = control.requests.length
    const res = await request(SEARCH_PATH, { method: 'POST', rawBody: JSON.stringify({ query: '西湖 开放时间' }) })
    expect(res.status).toBe(200)
    expect(res.headers['x-web-sources-status']).toBe('available')
    expect(res.body.status).toBe('available')
    expect(res.body.requested_query).toBe('西湖 开放时间')
    // 每次点击契约一请求：恰好新增一条，且无重试尾巴
    expect(control.requests.length - before).toBe(1)
    const record = control.requests[control.requests.length - 1]
    expect(record.path).toBe(SEARCH_PATH)
    expect(record.method).toBe('POST')
    expect(record.body).toEqual({ query: '西湖 开放时间' })
    expect(await record.settled).toBe('responded')
  })

  it('query 原样 echo：FEFF 与 padding 原样返回，桩不 trim', async () => {
    const query = '\uFEFF西湖 开放时间\uFEFF'
    const res = await request(SEARCH_PATH, { method: 'POST', rawBody: JSON.stringify({ query }) })
    expect(res.status).toBe(200)
    expect(res.body.requested_query).toBe(query)
    expect(res.body.requested_query.codePointAt(0)).toBe(0xfeff)
  })

  it('业务失败信封：no_key / unavailable 都是 HTTP 200 + 对应状态头', async () => {
    for (const mode of ['no_key', 'unavailable']) {
      control.webSourcesMode = mode
      const res = await request(SEARCH_PATH, { method: 'POST', rawBody: JSON.stringify({ query: '西湖' }) })
      expect(res.status).toBe(200)
      expect(res.headers['x-web-sources-status']).toBe(mode)
      expect(res.body.status).toBe(mode)
      expect(res.body.results).toEqual([])
      expect(res.body.fetched_at).toBeNull()
    }
  })

  it('本地形状不符 → 固定 422 不回显原文；请求记录照常落账（0 上游尝试）', async () => {
    const before = control.requests.length
    const cases = [
      JSON.stringify({ query: '西湖', extra: 1 }),
      JSON.stringify({ q: '西湖' }),
      JSON.stringify('西湖'),
      'not-json',
    ]
    for (const rawBody of cases) {
      const res = await request(SEARCH_PATH, { method: 'POST', rawBody })
      expect(res.status).toBe(422)
      expect(res.headers['x-web-sources-status']).toBe('invalid_request')
      expect(res.body).toEqual({
        detail: 'query 必须为去除首尾空白后 1 到 300 个字符的文本',
        report: null,
      })
      // 不回显通道：detail 是整个 body 的唯一字符串，report 恒 null——
      // 任何输入原文（含非法字符）都没有第二个可出现的字段
      expect(res.body.report).toBeNull()
      expect(Object.keys(res.body)).toEqual(['detail', 'report'])
      expect(typeof res.body.detail).toBe('string')
    }
    expect(control.requests.length - before).toBe(cases.length)
  })

  it('连续两次显式请求 = 两条记录两个 seq：桩无隐式重试', async () => {
    const before = control.requests.length
    await request(SEARCH_PATH, { method: 'POST', rawBody: JSON.stringify({ query: '第一次' }) })
    await request(SEARCH_PATH, { method: 'POST', rawBody: JSON.stringify({ query: '第二次' }) })
    const records = control.requests.slice(before)
    expect(records).toHaveLength(2)
    expect(records[1].seq).toBe(records[0].seq + 1)
    expect(records[0].body).toEqual({ query: '第一次' })
    expect(records[1].body).toEqual({ query: '第二次' })
    expect(await records[0].settled).toBe('responded')
    expect(await records[1].settled).toBe('responded')
  })

  it('deferred gate：请求在桩侧挂起（pending=1）→ release 放行；客户端断开 → aborted', async () => {
    // 放行路径：挂起 → release → 请求完成（显式 release 定序，不空等响应）
    control.webSourcesDelay = createGate()
    const pendingPromise = request(SEARCH_PATH, { method: 'POST', rawBody: JSON.stringify({ query: '迟到场景' }) })
    await waitForGatePending(control.webSourcesDelay)
    expect(control.webSourcesDelay.pendingCount()).toBe(1)
    const pendingRecord = control.requests[control.requests.length - 1]
    control.webSourcesDelay.release()
    const released = await pendingPromise
    expect(released.status).toBe(200)
    expect(released.body.status).toBe('available')
    expect(await pendingRecord.settled).toBe('responded')

    // 断开路径：挂起期间客户端销毁 socket → 桩侧显式收到 aborted（关闭迟到场景的前提）
    control.webSourcesDelay = createGate()
    const abortPromise = requestThenAbort(SEARCH_PATH, JSON.stringify({ query: '断开场景' }))
    await waitForGatePending(control.webSourcesDelay)
    const abortRecord = control.requests[control.requests.length - 1]
    const settledRace = Promise.race([
      abortRecord.settled,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 5000)),
    ])
    await abortPromise
    expect(await settledRace).toBe('aborted')
    control.webSourcesDelay.release()
  })
})

/**
 * 恶意 VITE_API_BASE 继承探针（显式命令运行，不在 pnpm test 默认集合）：
 *
 *   pnpm verify:e2e:malicious-base
 *
 * 需要：本机 Chrome/Edge（内部跑完整 verify:e2e 浏览器验收）。
 *
 * 证明目标：即使 shell 继承了指向「非 runner 拥有」origin 的 VITE_API_BASE，
 * 前端请求仍只落在本进程契约桩（define 钉死 import.meta.env.VITE_API_BASE），
 * 没有任何请求触达该外部 origin。sentinel 用动态隔离回环端口（不 bind 固定
 * 8000，不碰用户可能开着的服务）；该端口是「probe 自己拥有的 foreign origin」，
 * runner 不拥有它，route 层应把它截获（abort_loopback_foreign），报告如实记录。
 */
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const frontendRoot = resolve(here, '..')

/** 动态隔离回环端口 + 显式 error 处理：占用/失败都 reject，不悬挂、不碰固定端口 */
function listenLoopbackOnce(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveListen(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server.listening) return resolveClose()
    server.close(() => resolveClose())
    setTimeout(() => server.closeAllConnections?.(), 200).unref()
  })
}

const sentinel = net.createServer((socket) => {
  connections += 1
  socket.destroy()
})
let connections = 0
let sentinelPort = 0

try {
  sentinelPort = await listenLoopbackOnce(sentinel)
  console.log(`[malicious-base] 哨兵已监听隔离端口 127.0.0.1:${sentinelPort}（runner 不拥有它）`)

  const result = spawnSync('pnpm', ['verify:e2e'], {
    cwd: frontendRoot,
    encoding: 'utf-8',
    env: { ...process.env, VITE_API_BASE: `http://127.0.0.1:${sentinelPort}` },
    shell: true,
    timeout: 380_000,
  })

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  assert.equal(result.status, 0, `verify:e2e 应通过。\nstdout 末尾：${stdout.slice(-500)}\nstderr 末尾：${stderr.slice(-300)}`)

  // 哨兵收到的连接数必须为 0：前端没有触达这个 foreign origin
  assert.equal(connections, 0, `哨兵收到 ${connections} 个连接——前端确实触达了外部 origin`)

  // 报告证据：env_probe 记录了恶意变量确实存在（证明钉死在真实继承下生效）
  const report = JSON.parse((await import('node:fs')).readFileSync(
    resolve(frontendRoot, 'e2e/artifacts/report.json'),
    'utf-8',
  ))
  assert.equal(report.env_probe?.process_VITE_API_BASE_present, true, 'env_probe 应记录恶意变量存在')
  assert.equal(
    report.env_probe?.process_VITE_API_BASE_length,
    `http://127.0.0.1:${sentinelPort}`.length,
    'env_probe 长度应与恶意 origin 一致',
  )
  assert.equal(report.route_summary?.actualOutbound ?? -1, 0, '实际出站必须为 0')
  // 若 route 层见到过该 foreign origin，应记录为截获而非放行
  const intercepted = (report.route_outcomes ?? []).filter(
    (o) => o.kind === 'abort_loopback_foreign' && o.url.includes(`127.0.0.1:${sentinelPort}`),
  )
  for (const item of intercepted) {
    assert.ok(item.kind === 'abort_loopback_foreign', `foreign origin 请求未被截获：${item.url}`)
  }

  console.log(`[malicious-base] PASS：恶意 VITE_API_BASE=http://127.0.0.1:${sentinelPort} 下 verify:e2e 通过；`)
  console.log(`[malicious-base] 哨兵连接数=0（零触达）；route 截获 foreign=${intercepted.length}；实际出站=0`)
  process.exitCode = 0
} catch (error) {
  console.error(`[malicious-base] FAIL：${error.message}`)
  process.exitCode = 1
} finally {
  await closeServer(sentinel)
}

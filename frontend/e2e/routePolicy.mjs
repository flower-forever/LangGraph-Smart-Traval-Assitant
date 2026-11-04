/**
 * 离线路由决策（纯函数）：runner 的 page.route handler 与测试共用同一份决策表。
 * 决策：本次 owned origin 放行；HTTPS 且正规路径的 OSM 瓦片 fulfill；其余一律截获
 * （公网 abort_external / 其它 loopback abort_loopback_foreign）。不存在任何出站放行分支。
 */

/**
 * @param {URL} url 请求 URL
 * @param {string} appOrigin 本次 runner 拥有的 Vite origin
 * @param {string} stubOrigin 本次 runner 拥有的契约桩 origin
 * @returns {'continue_local'|'fulfill_tile'|'abort_external'|'abort_loopback_foreign'}
 */
export function classifyUrl(url, appOrigin, stubOrigin) {
  const isOwnedApp = appOrigin !== null && url.host === new URL(appOrigin).host
  const isOwnedStub = stubOrigin !== null && url.host === new URL(stubOrigin).host
  if (isOwnedApp || isOwnedStub) return 'continue_local'
  if (
    url.hostname === 'tile.openstreetmap.org' &&
    url.protocol === 'https:' &&
    /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)
  ) {
    return 'fulfill_tile'
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    return 'abort_loopback_foreign'
  }
  return 'abort_external'
}

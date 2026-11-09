/**
 * 分享卡片文件下载（四期 S4）。
 *
 * - 只有显式调用才会创建 Blob、Blob URL 与 <a download>；挂载/预览不触发。
 * - 下载后移除 anchor；Blob URL 延迟回收（Firefox 同步回收会取消下载）。
 * - 文件名安全化：去掉路径分隔符、控制字符与 Windows 保留字符。
 * - 不写 localStorage / sessionStorage，不发请求。
 */

const URL_REVOKE_DELAY_MS = 1000

/** 文件名安全化：保留扩展名，替换非法字符，限制长度。 */
export function safeShareCardFileName(name: string): string {
  const trimmed = (name ?? '').trim()
  const dot = trimmed.lastIndexOf('.')
  const hasExtension = dot > 0 && dot < trimmed.length - 1
  const rawStem = hasExtension ? trimmed.slice(0, dot) : trimmed
  const rawExtension = hasExtension ? trimmed.slice(dot + 1) : ''

  const clean = (value: string) =>
    value
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
      .slice(0, 96)

  const stem = clean(rawStem) || 'travel-assistant-share-card'
  const extension = clean(rawExtension).toLowerCase().replace(/[^a-z0-9]/g, '')
  return extension ? `${stem}.${extension}` : stem
}

/** 统一文件名格式：travel-assistant-share-d<day>-<style>.<format> */
export function shareCardFileName(
  dayNumber: number,
  style: string,
  format: 'svg' | 'png',
): string {
  return safeShareCardFileName(
    `travel-assistant-share-d${dayNumber}-${style}.${format}`,
  )
}

function triggerDownload(blob: Blob, fileName: string): boolean {
  if (typeof document === 'undefined') return false
  const createObjectURL =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL.bind(URL)
      : null
  const revokeObjectURL =
    typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function'
      ? URL.revokeObjectURL.bind(URL)
      : null
  if (!createObjectURL || !revokeObjectURL) return false

  let objectUrl: string | null = null
  let anchor: HTMLAnchorElement | null = null
  try {
    objectUrl = createObjectURL(blob)
    anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = safeShareCardFileName(fileName)
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    anchor = null
  } catch {
    if (anchor) {
      try {
        anchor.remove()
      } catch {
        /* 清理失败静默 */
      }
    }
    if (objectUrl !== null) {
      try {
        revokeObjectURL(objectUrl)
      } catch {
        /* 清理失败静默 */
      }
    }
    return false
  }

  const url = objectUrl
  setTimeout(() => {
    try {
      revokeObjectURL(url)
    } catch {
      /* 回收失败静默 */
    }
  }, URL_REVOKE_DELAY_MS)
  return true
}

/** 下载 SVG 文本；自动补 XML 声明，保证独立 .svg 文件在查看器中可解析。 */
export function downloadSvgCard(svg: string, fileName: string): boolean {
  if (typeof svg !== 'string' || svg.trim() === '') return false
  const content = svg.trimStart().startsWith('<?xml')
    ? svg
    : `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`
  try {
    const blob = new Blob([content], { type: 'image/svg+xml;charset=utf-8' })
    return triggerDownload(blob, fileName)
  } catch {
    return false
  }
}

/** 下载 PNG Blob（由 rasterizeShareCardPng 生成）。 */
export function downloadPngBlob(blob: Blob, fileName: string): boolean {
  if (!(blob instanceof Blob)) return false
  return triggerDownload(blob, fileName)
}

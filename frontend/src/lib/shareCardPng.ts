/**
 * 分享卡片 PNG 光栅化（四期 S4）。
 *
 * 零依赖：SVG → Blob URL → Image → 1080×1440 canvas → toBlob('image/png')。
 * 不使用 html2canvas 等第三方库，也不发起任何网络请求。
 *
 * 环境边界：
 * - 缺少 document / Image / canvas / toBlob / URL.createObjectURL 时返回
 *   unsupported，不抛异常。
 * - SVG 解码失败返回 decode；canvas 绘制或 toBlob 失败/返回 null 返回 encode。
 * - 无论成功还是失败都 revoke 已创建的 Blob URL。
 * - 测试可通过 deps 注入 Image / canvas 工厂，不依赖 jsdom 的 canvas 实现。
 */

export interface RasterizeDeps {
  createImage?: () => HTMLImageElement
  createCanvas?: (w: number, h: number) => HTMLCanvasElement
}

export type RasterizeOutcome =
  | { ok: true; blob: Blob }
  | { ok: false; reason: 'unsupported' | 'decode' | 'encode' }

const CARD_WIDTH = 1080
const CARD_HEIGHT = 1440

export async function rasterizeShareCardPng(
  svg: string,
  deps: RasterizeDeps = {},
): Promise<RasterizeOutcome> {
  if (typeof svg !== 'string' || svg.trim() === '') {
    return { ok: false, reason: 'decode' }
  }

  const createImage =
    deps.createImage ??
    (typeof Image !== 'undefined' ? () => new Image() : null)
  const createCanvas =
    deps.createCanvas ??
    (typeof document !== 'undefined' && typeof document.createElement === 'function'
      ? (width: number, height: number) => {
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          return canvas
        }
      : null)
  const createObjectURL =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL.bind(URL)
      : null
  const revokeObjectURL =
    typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function'
      ? URL.revokeObjectURL.bind(URL)
      : null

  if (!createImage || !createCanvas || !createObjectURL || !revokeObjectURL) {
    return { ok: false, reason: 'unsupported' }
  }

  let objectUrl: string | null = null
  try {
    let blob: Blob
    try {
      blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    } catch {
      return { ok: false, reason: 'decode' }
    }

    try {
      objectUrl = createObjectURL(blob)
    } catch {
      return { ok: false, reason: 'unsupported' }
    }

    const image = createImage()
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('decode'))
        image.src = objectUrl as string
      })
    } catch {
      return { ok: false, reason: 'decode' }
    }

    let canvas: HTMLCanvasElement
    let context: CanvasRenderingContext2D | null
    try {
      canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT)
      context = canvas.getContext('2d')
    } catch {
      return { ok: false, reason: 'encode' }
    }
    if (!context) return { ok: false, reason: 'encode' }

    try {
      context.drawImage(image, 0, 0, CARD_WIDTH, CARD_HEIGHT)
    } catch {
      return { ok: false, reason: 'encode' }
    }

    let png: Blob | null = null
    try {
      png = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((result) => resolve(result), 'image/png')
      })
    } catch {
      return { ok: false, reason: 'encode' }
    }
    if (!png) return { ok: false, reason: 'encode' }
    return { ok: true, blob: png }
  } finally {
    if (objectUrl !== null) {
      try {
        revokeObjectURL(objectUrl)
      } catch {
        /* 回收失败静默，不影响业务结果 */
      }
    }
  }
}

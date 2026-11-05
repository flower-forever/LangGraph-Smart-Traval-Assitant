/**
 * Canonical JSON + 短指纹（纯函数；不读存储 / 时钟 / 网络）。
 *
 * 契约（docs/WORKSPACE_SIDECAR.md）：
 * - canonical JSON 对对象键排序，**数组保持原有顺序**；不为指纹重排 anchor / visit。
 * - 只接受 JSON 值：null / boolean / string / 有限 number / array / plain object。
 *   undefined、函数、Symbol、BigInt、NaN、Infinity、循环引用、非 plain object 一律失败，
 *   不做 JSON.stringify 那种静默丢弃。
 * - 短指纹是 FNV-1a 32-bit（UTF-8 字节），小写 8 位十六进制，**只作索引 / 显示**；
 *   碰撞客观存在，hash 相等必须再用完整 canonical 文本确认。
 * - 不承诺「任一字段变化必变」；owner 权威判定永远看 canonical 全文 + identity + revision + epoch。
 */
import type { WorkspaceFingerprintV1 } from './workspaceTypes'

export type CanonicalJsonFailureReason =
  | 'unsupported_value'
  | 'non_finite_number'
  | 'cycle'

export type CanonicalJsonResult =
  | { ok: true; text: string }
  | { ok: false; reason: CanonicalJsonFailureReason; path: string; message: string }

class CanonicalJsonError extends Error {
  readonly reason: CanonicalJsonFailureReason
  readonly path: string

  constructor(reason: CanonicalJsonFailureReason, path: string, message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
    this.reason = reason
    this.path = path
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function canonicalize(value: unknown, path: string, stack: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          'non_finite_number',
          path,
          'canonical JSON 不接受 NaN / Infinity；未知数必须显式用 null。',
        )
      }
      // JSON.stringify(-0) 是 '0'，与 JSON 语义一致。
      return JSON.stringify(value)
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new CanonicalJsonError(
        'unsupported_value',
        path,
        'canonical JSON 不接受 undefined / 函数 / Symbol / BigInt；未知值必须显式用 null。',
      )
    default:
      break
  }

  if (Array.isArray(value)) {
    if (stack.has(value)) {
      throw new CanonicalJsonError('cycle', path, 'canonical JSON 不接受循环引用。')
    }
    stack.add(value)
    try {
      const parts: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        // 用下标读取：稀疏数组的空位会得到 undefined，按不支持值拒绝，不静默变成 null。
        parts.push(canonicalize(value[index], `${path}[${index}]`, stack))
      }
      return `[${parts.join(',')}]`
    } finally {
      stack.delete(value)
    }
  }

  if (typeof value === 'object') {
    if (!isPlainObject(value)) {
      throw new CanonicalJsonError(
        'unsupported_value',
        path,
        'canonical JSON 只接受普通对象；Date / Map / class 实例必须先投影成普通 JSON。',
      )
    }
    if (stack.has(value)) {
      throw new CanonicalJsonError('cycle', path, 'canonical JSON 不接受循环引用。')
    }
    stack.add(value)
    try {
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort()
      const parts: string[] = []
      for (const key of keys) {
        parts.push(`${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, stack)}`)
      }
      return `{${parts.join(',')}}`
    } finally {
      stack.delete(value)
    }
  }

  // 理论上到不了这里；保留 fail-closed 分支。
  throw new CanonicalJsonError('unsupported_value', path, 'canonical JSON 遇到不支持的值。')
}

/** 把 JSON 值序列化成确定性 canonical JSON。失败时返回可展示的固定原因。 */
export function canonicalJson(value: unknown): CanonicalJsonResult {
  try {
    return { ok: true, text: canonicalize(value, '$', new Set<object>()) }
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      return { ok: false, reason: error.reason, path: error.path, message: error.message }
    }
    return {
      ok: false,
      reason: 'unsupported_value',
      path: '$',
      message: 'canonical JSON 序列化失败；原始数据未被修改。',
    }
  }
}

/** 短指纹算法标识；后端只把 short 当不透明索引，不自行验证 canonical。 */
export const SHORT_FINGERPRINT_ALGORITHM = 'fnv1a32-utf8' as const

/**
 * FNV-1a 32-bit，输入按 UTF-8 字节计算，输出 8 位小写十六进制。
 * 非加密、允许碰撞；不能单独证明内容相同。
 */
export function shortFingerprint(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export type FingerprintResult =
  | { ok: true; fingerprint: WorkspaceFingerprintV1 }
  | {
      ok: false
      reason: CanonicalJsonFailureReason
      path: string
      message: string
    }

/** 完整 canonical + 短索引。canonical 是权威内容；short 只用于显示 / 快速筛。 */
export function fingerprintOf(value: unknown): FingerprintResult {
  const canonical = canonicalJson(value)
  if (!canonical.ok) return canonical
  return {
    ok: true,
    fingerprint: {
      canonical: canonical.text,
      short: shortFingerprint(canonical.text),
    },
  }
}

/**
 * 指纹比较：先比 short 做廉价排除，相等后再比完整 canonical。
 * short 相等但 canonical 不同 → false（碰撞不能被当成相同）。
 */
export function fingerprintsMatch(
  left: WorkspaceFingerprintV1 | null | undefined,
  right: WorkspaceFingerprintV1 | null | undefined,
): boolean {
  if (!left || !right) return false
  if (left.short !== right.short) return false
  return left.canonical === right.canonical
}

/** 短指纹形状校验；只检查格式，不证明内容。 */
export function isShortFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value)
}

/** 两个任意 JSON 值在 canonical 语义下是否相同；任一序列化失败都返回 false。 */
export function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  const a = canonicalJson(left)
  const b = canonicalJson(right)
  return a.ok && b.ok && a.text === b.text
}


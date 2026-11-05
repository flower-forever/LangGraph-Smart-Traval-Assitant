import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  canonicalValuesEqual,
  fingerprintOf,
  fingerprintsMatch,
  isShortFingerprint,
  shortFingerprint,
} from '../lib/workspaceFingerprint'

describe('canonicalJson', () => {
  it('sorts object keys recursively but preserves array order', () => {
    const left = canonicalJson({ b: 2, a: [{ z: 1, y: 2 }, 'second'] })
    const right = canonicalJson({ a: [{ y: 2, z: 1 }, 'second'], b: 2 })
    expect(left.ok).toBe(true)
    expect(right.ok).toBe(true)
    if (!left.ok || !right.ok) return
    expect(left.text).toBe('{"a":[{"y":2,"z":1},"second"],"b":2}')
    expect(left.text).toBe(right.text)
  })

  it('does not sort arrays: [a,b] and [b,a] differ', () => {
    const left = canonicalJson({ list: ['a', 'b'] })
    const right = canonicalJson({ list: ['b', 'a'] })
    expect(left.ok && right.ok && left.text !== right.text).toBe(true)
  })

  it('fails closed on undefined, non-finite numbers, functions and cycles', () => {
    expect(canonicalJson({ value: undefined }).ok).toBe(false)
    expect(canonicalJson({ value: Number.NaN }).ok).toBe(false)
    expect(canonicalJson({ value: Number.POSITIVE_INFINITY }).ok).toBe(false)
    expect(canonicalJson({ value: () => 1 }).ok).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(canonicalJson(cyclic).ok).toBe(false)
  })

  it('rejects non-plain objects instead of invoking toJSON', () => {
    expect(canonicalJson({ value: new Date(0) }).ok).toBe(false)
    expect(canonicalJson({ value: new Map([['a', 1]]) }).ok).toBe(false)
  })

  it('treats -0 as 0 and keeps UTF-8 text intact', () => {
    const result = canonicalJson({ n: -0, text: '杭州🚄' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text).toBe('{"n":0,"text":"杭州🚄"}')
  })
})

describe('shortFingerprint', () => {
  it('matches the FNV-1a 32-bit reference values', () => {
    expect(shortFingerprint('')).toBe('811c9dc5')
    expect(shortFingerprint('a')).toBe('e40c292c')
    expect(isShortFingerprint(shortFingerprint('杭州'))).toBe(true)
  })

  it('is deterministic and sensitive to canonical text', () => {
    const a = shortFingerprint('{"a":1}')
    const b = shortFingerprint('{"a":1}')
    const c = shortFingerprint('{"a":2}')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('fingerprintOf / fingerprintsMatch', () => {
  it('uses the full canonical text as authority, not the short hash', () => {
    const left = { fingerprint: fingerprintOf({ b: 1, a: 2 }) }
    const right = { fingerprint: fingerprintOf({ a: 2, b: 1 }) }
    expect(left.fingerprint.ok).toBe(true)
    expect(right.fingerprint.ok).toBe(true)
    if (!left.fingerprint.ok || !right.fingerprint.ok) return
    expect(fingerprintsMatch(left.fingerprint.fingerprint, right.fingerprint.fingerprint)).toBe(true)

    expect(
      fingerprintsMatch(
        { canonical: '{"a":1}', short: '00000000' },
        { canonical: '{"a":2}', short: '00000000' },
      ),
    ).toBe(false)
    expect(fingerprintsMatch(null, right.fingerprint.fingerprint)).toBe(false)
  })

  it('canonicalValuesEqual handles reordered keys and unserializable input', () => {
    expect(canonicalValuesEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true)
    expect(canonicalValuesEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(canonicalValuesEqual({ a: undefined }, { a: undefined })).toBe(false)
  })
})

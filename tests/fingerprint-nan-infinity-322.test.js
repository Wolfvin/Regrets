// tests/fingerprint-nan-infinity-322.test.js — regression tests for issue #322
// Verifies that stableStringify / fingerprint distinguish NaN, Infinity, -Infinity
// from null and from each other. Previously JSON.stringify collapsed all four to
// "null", causing (a) misleading .regret files (OUTPUT null when the function
// actually returned NaN) and (b) hash collisions (NaN → null refactor undetectable).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stableStringify, fingerprint } from '../scripts/fingerprint.js'

// ─── stableStringify sentinel handling ───────────────────────────────────────

describe('stableStringify NaN/Infinity sentinels (#322)', () => {
  it('serializes NaN as a distinct sentinel, NOT as "null"', () => {
    assert.equal(stableStringify(NaN), '"__nan__"')
    assert.notEqual(stableStringify(NaN), stableStringify(null))
  })

  it('serializes Infinity as a distinct sentinel, NOT as "null"', () => {
    assert.equal(stableStringify(Infinity), '"__infinity__"')
    assert.notEqual(stableStringify(Infinity), stableStringify(null))
  })

  it('serializes -Infinity as a distinct sentinel, NOT as "null"', () => {
    assert.equal(stableStringify(-Infinity), '"__neg_infinity__"')
    assert.notEqual(stableStringify(-Infinity), stableStringify(null))
  })

  it('produces THREE distinct sentinels for Infinity, -Infinity, and NaN', () => {
    const pos = stableStringify(Infinity)
    const neg = stableStringify(-Infinity)
    const nan = stableStringify(NaN)
    const all = new Set([pos, neg, nan, stableStringify(null)])
    assert.equal(all.size, 4, 'Infinity, -Infinity, NaN, and null must all serialize differently')
  })

  it('does NOT collide Infinity with very large finite numbers', () => {
    // 1e308 is the largest finite double; JSON.stringify renders it as "1e+308".
    // Infinity previously rendered as "null" — making it collide with neither
    // NaN nor 1e308, but ALSO failing to capture that the function returned +Inf.
    // After the fix, Infinity has its own sentinel distinct from any finite number.
    assert.notEqual(stableStringify(Infinity), stableStringify(1e308))
    assert.notEqual(stableStringify(-Infinity), stableStringify(-1e308))
  })

  it('is idempotent — same sentinel input always yields same output', () => {
    assert.equal(stableStringify(NaN), stableStringify(NaN))
    assert.equal(stableStringify(Infinity), stableStringify(Infinity))
    assert.equal(stableStringify(-Infinity), stableStringify(-Infinity))
  })
})

// ─── Recursive handling (nested inside objects/arrays) ──────────────────────

describe('stableStringify NaN/Infinity recursion (#322)', () => {
  it('handles NaN nested inside an object', () => {
    const result = stableStringify({ ok: NaN, other: 1 })
    assert.ok(result.includes('"__nan__"'), `expected __nan__ sentinel in: ${result}`)
    assert.notEqual(
      stableStringify({ ok: NaN, other: 1 }),
      stableStringify({ ok: null, other: 1 })
    )
  })

  it('handles Infinity / -Infinity nested inside an array', () => {
    const result = stableStringify([Infinity, -Infinity, NaN])
    assert.ok(result.includes('"__infinity__"'), `expected __infinity__ sentinel in: ${result}`)
    assert.ok(result.includes('"__neg_infinity__"'), `expected __neg_infinity__ sentinel in: ${result}`)
    assert.ok(result.includes('"__nan__"'), `expected __nan__ sentinel in: ${result}`)
    assert.notEqual(
      stableStringify([Infinity, -Infinity, NaN]),
      stableStringify([null, null, null])
    )
  })

  it('handles deeply nested mix of NaN/Infinity', () => {
    const withSentinels = { a: NaN, b: [Infinity, -Infinity, { c: NaN }] }
    const withNulls     = { a: null, b: [null, null, { c: null }] }
    assert.notEqual(stableStringify(withSentinels), stableStringify(withNulls))
  })
})

// ─── End-to-end fingerprint() integration ────────────────────────────────────

describe('fingerprint() distinguishes NaN/Infinity from null (#322)', () => {
  it('fingerprint(NaN output) !== fingerprint(null output)', () => {
    const fpNan  = fingerprint('input', NaN)
    const fpNull = fingerprint('input', null)
    assert.notEqual(fpNan, fpNull, 'NaN and null must produce different fingerprints')
  })

  it('fingerprint(Infinity output) !== fingerprint(null output)', () => {
    assert.notEqual(fingerprint('input', Infinity), fingerprint('input', null))
  })

  it('fingerprint(-Infinity output) !== fingerprint(null output)', () => {
    assert.notEqual(fingerprint('input', -Infinity), fingerprint('input', null))
  })

  it('fingerprint(Infinity) !== fingerprint(-Infinity) (both differ from null too)', () => {
    const fpPos = fingerprint('input', Infinity)
    const fpNeg = fingerprint('input', -Infinity)
    assert.notEqual(fpPos, fpNeg)
    assert.notEqual(fpPos, fingerprint('input', null))
    assert.notEqual(fpNeg, fingerprint('input', null))
  })

  it('fingerprint(Infinity) !== fingerprint(very large finite number)', () => {
    assert.notEqual(fingerprint('input', Infinity), fingerprint('input', 1e308))
    assert.notEqual(fingerprint('input', -Infinity), fingerprint('input', -1e308))
  })

  it('fingerprint nested {a: NaN, b: [Infinity, -Infinity]} !== same shape with nulls', () => {
    const fpSentinels = fingerprint('input', { a: NaN, b: [Infinity, -Infinity] })
    const fpNulls     = fingerprint('input', { a: null, b: [null, null] })
    assert.notEqual(fpSentinels, fpNulls)
  })

  it('fingerprint is idempotent for NaN / Infinity / -Infinity outputs', () => {
    assert.equal(fingerprint('input', NaN), fingerprint('input', NaN))
    assert.equal(fingerprint('input', Infinity), fingerprint('input', Infinity))
    assert.equal(fingerprint('input', -Infinity), fingerprint('input', -Infinity))
  })
})

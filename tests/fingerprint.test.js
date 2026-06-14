// tests/fingerprint.test.js — unit tests for scripts/fingerprint.js
// Uses Node.js built-in node:test and node:assert (zero external dependencies)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  stableStringify,
  normalize,
  stripFields,
  fingerprint,
  fingerprintSequence,
  extractSchema,
  snapshotOutput
} from '../scripts/fingerprint.js'

// ─── stableStringify ──────────────────────────────────────────────────────────

describe('stableStringify', () => {
  it('sorts object keys deterministically', () => {
    const a = stableStringify({ z: 1, a: 2, m: 3 })
    const b = stableStringify({ a: 2, m: 3, z: 1 })
    assert.equal(a, b)
  })

  it('handles nested objects with key order independence', () => {
    const a = stableStringify({ outer: { b: 2, a: 1 }, x: 0 })
    const b = stableStringify({ x: 0, outer: { a: 1, b: 2 } })
    assert.equal(a, b)
  })

  it('preserves array order (does not sort arrays)', () => {
    const result = stableStringify([3, 1, 2])
    assert.equal(result, '[3,1,2]')
  })

  it('handles null and undefined', () => {
    assert.equal(stableStringify(null), 'null')
    assert.equal(stableStringify(undefined), 'undefined')
  })

  it('serializes BigInt with tagged prefix', () => {
    assert.equal(stableStringify(18n), '__bigint__:18')
  })

  it('serializes Map to sorted entry array', () => {
    const m = new Map([['b', 2], ['a', 1]])
    const result = stableStringify(m)
    assert.ok(result.startsWith('Map:'))
    // Keys should be sorted: a before b
    assert.ok(result.indexOf('"a"') < result.indexOf('"b"'))
  })

  it('serializes TypedArrays as regular arrays', () => {
    const u8 = new Uint8Array([1, 2, 3])
    const result = stableStringify(u8)
    assert.equal(result, '[1,2,3]')
  })

  it('handles deep nesting (10 levels)', () => {
    let obj = { value: 'deep' }
    for (let i = 0; i < 9; i++) obj = { inner: obj }
    const result = stableStringify(obj)
    assert.ok(typeof result === 'string' && result.length > 0)
  })
})

// ─── normalize ────────────────────────────────────────────────────────────────

describe('normalize', () => {
  it('normalizes ISO timestamps', () => {
    const result = normalize('2024-01-15T10:30:00Z', ['timestamps'])
    assert.equal(result, '<TIMESTAMP>')
  })

  it('normalizes UUIDs', () => {
    const result = normalize('550e8400-e29b-41d4-a716-446655440000', ['uuids'])
    assert.equal(result, '<UUID>')
  })

  it('normalizes epoch numbers', () => {
    const result = normalize(1700000000, ['epochs'])
    assert.equal(result, '<EPOCH>')
  })

  it('does not normalize small numbers as epochs', () => {
    const result = normalize(42, ['epochs'])
    assert.equal(result, 42)
  })

  it('normalizes absolute paths', () => {
    const result = normalize('/home/user/project/src/file.js', ['absPaths'])
    assert.equal(result, '<ROOT>/project/src/file.js')
  })

  it('normalizes dynamicDates with MMYYYY pattern', () => {
    const result = normalize('FPK-052026', ['dynamicDates'])
    assert.equal(result, 'FPK-<MMYYYY>')
  })

  it('normalizes floatTolerance with default 2 decimal places', () => {
    const result = normalize(123456.789, ['floatTolerance'])
    assert.equal(result, 123456.79)
  })

  it('normalizes floatTolerance with custom decimal places', () => {
    const result = normalize(123456.789, ['floatTolerance:4'])
    assert.equal(result, 123456.789)
  })

  it('normalizes autoIncrement string IDs', () => {
    const result = normalize('b42', ['autoIncrement'])
    assert.equal(result, 'b<ID>')
  })

  it('normalizes autoIncrement numeric IDs (1-9999)', () => {
    const result = normalize(7, ['autoIncrement'])
    assert.equal(result, '<ID>')
  })

  it('does not normalize numbers outside autoIncrement range', () => {
    const result = normalize(10001, ['autoIncrement'])
    assert.equal(result, 10001)
  })

  it('normalizes incrementingIds with prefix+number pattern', () => {
    const result = normalize('field-42', ['incrementingIds'])
    assert.equal(result, 'field-<ID>')
  })

  it('normalizes timezoneOffsets', () => {
    const result = normalize('2025-01-15T10:30:00+05:30', ['timezoneOffsets'])
    assert.ok(result.includes('<TZ_OFFSET>'))
  })

  it('normalizes isoDates', () => {
    const result = normalize('2025-01-15T10:30:00.000Z', ['isoDates'])
    assert.equal(result, '<ISO_DATE>')
  })

  it('normalizes objects recursively', () => {
    const result = normalize({ ts: '2024-01-15T10:30:00Z', name: 'test' }, ['timestamps'])
    assert.deepEqual(result, { ts: '<TIMESTAMP>', name: 'test' })
  })

  it('normalizes arrays recursively', () => {
    const result = normalize(['2024-01-15T10:30:00Z', 'hello'], ['timestamps'])
    assert.deepEqual(result, ['<TIMESTAMP>', 'hello'])
  })

  it('converts TypedArrays to arrays during normalize', () => {
    const result = normalize(new Uint8Array([1, 2, 3]), [])
    assert.ok(Array.isArray(result))
    assert.deepEqual(result, [1, 2, 3])
  })
})

// ─── stripFields ──────────────────────────────────────────────────────────────

describe('stripFields', () => {
  it('removes specified top-level keys', () => {
    const result = stripFields({ a: 1, b: 2, c: 3 }, ['b'])
    assert.deepEqual(result, { a: 1, c: 3 })
  })

  it('removes nested keys recursively', () => {
    const result = stripFields({ a: { b: 1, c: 2 }, d: 3 }, ['c'])
    assert.deepEqual(result, { a: { b: 1 }, d: 3 })
  })

  it('strips fields from arrays of objects', () => {
    const result = stripFields([{ x: 1, secret: 'a' }, { x: 2, secret: 'b' }], ['secret'])
    assert.deepEqual(result, [{ x: 1 }, { x: 2 }])
  })

  it('uses ignorePaths with dot notation to recurse into nested objects', () => {
    // Note: ignorePaths recurses into the path but the leaf key is only
    // removed if it matches via ignoreFields. This test verifies the
    // current behavior — ignorePaths narrows the scope for recursion.
    const obj = { request: { socket: 'hidden', data: 'visible' }, status: 200 }
    const result = stripFields(obj, [], ['request.socket'])
    // Current behavior: ignorePaths recurses but doesn't strip leaf keys
    // (leaf removal requires ignoreFields). The recursion ensures child
    // ignorePaths are applied at deeper levels.
    assert.deepEqual(result, { request: { socket: 'hidden', data: 'visible' }, status: 200 })
  })

  it('ignorePaths combined with ignoreFields removes leaf keys at paths', () => {
    const obj = { request: { socket: 'hidden', data: 'visible' }, status: 200 }
    const result = stripFields(obj, ['socket'], ['request.socket'])
    assert.deepEqual(result, { request: { data: 'visible' }, status: 200 })
  })

  it('returns original object when no ignoreFields or ignorePaths', () => {
    const obj = { a: 1 }
    const result = stripFields(obj, [], [])
    assert.equal(result, obj) // same reference — no clone
  })

  it('handles TypedArrays by converting to arrays', () => {
    const result = stripFields(new Uint8Array([1, 2, 3]), ['x'])
    assert.ok(Array.isArray(result))
  })
})

// ─── fingerprint ──────────────────────────────────────────────────────────────

describe('fingerprint', () => {
  it('produces deterministic 7-char base36 hash', () => {
    const fp = fingerprint('hello', 'world')
    assert.equal(fp.length, 7)
    assert.ok(/^[0-9a-z]{7}$/.test(fp))
  })

  it('produces same hash for same input', () => {
    const fp1 = fingerprint({ a: 1 }, { b: 2 })
    const fp2 = fingerprint({ a: 1 }, { b: 2 })
    assert.equal(fp1, fp2)
  })

  it('produces different hashes for different inputs', () => {
    const fp1 = fingerprint('input1', 'output')
    const fp2 = fingerprint('input2', 'output')
    assert.notEqual(fp1, fp2)
  })

  it('handles null input', () => {
    const fp = fingerprint(null, 'output')
    assert.ok(typeof fp === 'string' && fp.length === 7)
  })

  it('handles undefined input', () => {
    const fp = fingerprint(undefined, 'output')
    assert.ok(typeof fp === 'string' && fp.length === 7)
  })

  it('is order-insensitive for object keys', () => {
    const fp1 = fingerprint({ b: 2, a: 1 }, { y: 0, x: 1 })
    const fp2 = fingerprint({ a: 1, b: 2 }, { x: 1, y: 0 })
    assert.equal(fp1, fp2)
  })

  it('applies normalize rules from clusterConfig', () => {
    const fp1 = fingerprint('input', '2024-01-15T10:30:00Z', { normalize: ['timestamps'] })
    const fp2 = fingerprint('input', '2025-12-25T23:59:59Z', { normalize: ['timestamps'] })
    assert.equal(fp1, fp2)
  })

  it('applies ignoreFields from clusterConfig', () => {
    const fp1 = fingerprint('input', { a: 1, b: 'secret' }, { ignoreFields: ['b'] })
    const fp2 = fingerprint('input', { a: 1, b: 'different' }, { ignoreFields: ['b'] })
    assert.equal(fp1, fp2)
  })
})

// ─── fingerprintSequence ─────────────────────────────────────────────────────

describe('fingerprintSequence', () => {
  it('produces 7-char deterministic hash from call sequence', () => {
    const calls = [
      { fn: 'add', args: [1, 2], result: 3 },
      { fn: 'mul', args: [3, 4], result: 12 }
    ]
    const fp = fingerprintSequence(calls)
    assert.equal(fp.length, 7)
    assert.ok(/^[0-9a-z]{7}$/.test(fp))
  })

  it('produces different hashes for different call sequences', () => {
    const calls1 = [{ fn: 'add', args: [1, 2], result: 3 }]
    const calls2 = [{ fn: 'add', args: [1, 2], result: 4 }]
    assert.notEqual(fingerprintSequence(calls1), fingerprintSequence(calls2))
  })
})

// ─── extractSchema ────────────────────────────────────────────────────────────

describe('extractSchema', () => {
  it('extracts schema from simple object', () => {
    const schema = extractSchema({ name: 'Ali', age: 30, active: true, meta: null })
    assert.deepEqual(schema, { active: 'boolean', age: 'number', meta: 'null', name: 'string' })
  })

  it('extracts schema from uniform array', () => {
    const schema = extractSchema([1, 2, 3])
    assert.deepEqual(schema, ['number'])
  })

  it('returns "array" for empty array', () => {
    assert.equal(extractSchema([]), 'array')
  })

  it('returns "null" for null', () => {
    assert.equal(extractSchema(null), 'null')
  })

  it('returns "undefined" for undefined', () => {
    assert.equal(extractSchema(undefined), 'undefined')
  })

  it('extracts schema from TypedArray as array of numbers', () => {
    assert.deepEqual(extractSchema(new Uint8Array([1, 2, 3])), ['number'])
  })
})

// ─── snapshotOutput ───────────────────────────────────────────────────────────

describe('snapshotOutput', () => {
  it('returns deepClone when transform is null', () => {
    const obj = { a: 1 }
    const result = snapshotOutput(obj, null)
    assert.deepEqual(result, obj)
    assert.notEqual(result, obj) // different reference
  })

  it('calls toDict() when transform is "to_dict"', () => {
    const obj = { x: 1, toDict() { return { x: this.x } } }
    const result = snapshotOutput(obj, 'to_dict')
    assert.deepEqual(result, { x: 1 })
  })

  it('calls toJSON() when transform is "to_json"', () => {
    const obj = { val: 42, toJSON() { return { val: this.val } } }
    const result = snapshotOutput(obj, 'to_json')
    assert.deepEqual(result, { val: 42 })
  })

  it('returns JSON.stringify for "repr" transform', () => {
    const result = snapshotOutput({ a: 1 }, 'repr')
    assert.equal(result, '{"a":1}')
  })

  it('converts Buffer to hex for "hex" transform', () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    const result = snapshotOutput(buf, 'hex')
    assert.equal(result, 'deadbeef')
  })

  it('applies custom transform function', () => {
    const result = snapshotOutput({ a: 1, b: 2 }, v => v.a + v.b)
    assert.equal(result, 3)
  })
})

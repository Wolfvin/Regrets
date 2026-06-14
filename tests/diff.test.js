// tests/diff.test.js — unit tests for scripts/diff-utils.js
// Uses Node.js built-in node:test and node:assert (zero external dependencies)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deepDiff, formatDiffs, formatValue } from '../scripts/diff-utils.js'

// ─── deepDiff ─────────────────────────────────────────────────────────────────

describe('deepDiff', () => {
  it('returns empty array for identical values', () => {
    assert.deepEqual(deepDiff(42, 42), [])
    assert.deepEqual(deepDiff('hello', 'hello'), [])
    assert.deepEqual(deepDiff(null, null), [])
  })

  it('detects value_mismatch for different primitives', () => {
    const diffs = deepDiff('alice', 'bob')
    assert.equal(diffs.length, 1)
    assert.equal(diffs[0].type, 'value_mismatch')
    assert.equal(diffs[0].expected, 'alice')
    assert.equal(diffs[0].actual, 'bob')
  })

  it('detects added_key in objects', () => {
    const diffs = deepDiff({ a: 1 }, { a: 1, b: 2 })
    const added = diffs.find(d => d.type === 'added_key')
    assert.ok(added)
    assert.equal(added.path, 'b')
    assert.equal(added.actual, 2)
  })

  it('detects removed_key in objects', () => {
    const diffs = deepDiff({ a: 1, b: 2 }, { a: 1 })
    const removed = diffs.find(d => d.type === 'removed_key')
    assert.ok(removed)
    assert.equal(removed.path, 'b')
    assert.equal(removed.expected, 2)
  })

  it('detects type_mismatch between array and object', () => {
    const diffs = deepDiff([1, 2], { 0: 1, 1: 2 })
    const typeDiff = diffs.find(d => d.type === 'type_mismatch')
    assert.ok(typeDiff)
  })

  it('detects nested object differences', () => {
    const diffs = deepDiff(
      { user: { name: 'Alice', age: 30 } },
      { user: { name: 'Bob', age: 30 } }
    )
    const nameDiff = diffs.find(d => d.path === 'user.name')
    assert.ok(nameDiff)
    assert.equal(nameDiff.type, 'value_mismatch')
    assert.equal(nameDiff.expected, 'Alice')
    assert.equal(nameDiff.actual, 'Bob')
  })

  it('detects array length_mismatch', () => {
    const diffs = deepDiff([1, 2, 3], [1, 2])
    const lenDiff = diffs.find(d => d.type === 'length_mismatch')
    assert.ok(lenDiff)
  })

  it('detects float_tolerance for small numeric differences', () => {
    const diffs = deepDiff(1.000000001, 1.0)
    const floatDiff = diffs.find(d => d.type === 'float_tolerance')
    assert.ok(floatDiff)
  })

  it('detects value_mismatch for large numeric differences', () => {
    const diffs = deepDiff(100, 200)
    const valDiff = diffs.find(d => d.type === 'value_mismatch')
    assert.ok(valDiff)
  })

  it('detects null vs object as value_mismatch', () => {
    const diffs = deepDiff(null, { a: 1 })
    assert.equal(diffs.length, 1)
    assert.equal(diffs[0].type, 'value_mismatch')
  })

  it('handles deeply nested added_key', () => {
    const diffs = deepDiff(
      { level1: { level2: { a: 1 } } },
      { level1: { level2: { a: 1, b: 2 } } }
    )
    const added = diffs.find(d => d.type === 'added_key')
    assert.ok(added)
    assert.equal(added.path, 'level1.level2.b')
  })

  it('compares arrays element by element', () => {
    const diffs = deepDiff([1, 2, 3], [1, 99, 3])
    const elemDiff = diffs.find(d => d.path === '[1]')
    assert.ok(elemDiff)
    assert.equal(elemDiff.expected, 2)
    assert.equal(elemDiff.actual, 99)
  })
})

// ─── formatValue ──────────────────────────────────────────────────────────────

describe('formatValue', () => {
  it('formats undefined as "undefined"', () => {
    assert.equal(formatValue(undefined), 'undefined')
  })

  it('formats null as "null"', () => {
    assert.equal(formatValue(null), 'null')
  })

  it('formats objects as JSON', () => {
    assert.equal(formatValue({ a: 1 }), '{"a":1}')
  })

  it('truncates long strings', () => {
    const longStr = 'x'.repeat(100)
    const result = formatValue(longStr, 10)
    assert.ok(result.endsWith('...'))
    assert.equal(result.length, 13) // 10 chars + '...'
  })
})

// ─── formatDiffs ──────────────────────────────────────────────────────────────

describe('formatDiffs', () => {
  it('returns no-differences message for empty array', () => {
    const result = formatDiffs([])
    assert.ok(result.includes('no differences'))
  })

  it('formats value_mismatch with ≠ icon', () => {
    const result = formatDiffs([
      { path: 'name', expected: 'Alice', actual: 'Bob', type: 'value_mismatch' }
    ])
    assert.ok(result.includes('≠'))
    assert.ok(result.includes('name'))
    assert.ok(result.includes('Alice'))
    assert.ok(result.includes('Bob'))
  })

  it('formats added_key with + icon', () => {
    const result = formatDiffs([
      { path: 'newField', expected: undefined, actual: 42, type: 'added_key' }
    ])
    assert.ok(result.includes('+'))
    assert.ok(result.includes('newField'))
  })

  it('formats float_tolerance with ≈ icon and diff value', () => {
    const result = formatDiffs([
      { path: 'price', expected: 1.0, actual: 1.001, type: 'float_tolerance', diff: 0.001 }
    ])
    assert.ok(result.includes('≈'))
    assert.ok(result.includes('float tolerance'))
    assert.ok(result.includes('0.001'))
  })
})

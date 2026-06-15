#!/usr/bin/env node
// Edge case probe — test all 12 edge cases against fingerprint.js, ghost.js, capture.js
// This script tests each case and reports: PASS (handled correctly), CRASH (throw/stack overflow), or SILENT_FAIL (wrong result)

import { stableStringify, fingerprint, normalize, stripFields } from '../scripts/fingerprint.js'
import { deepClone, createGhost, consumeIterator } from '../scripts/ghost.js'

const results = []

function test(name, fn) {
  try {
    const result = fn()
    results.push({ name, status: 'PASS', detail: result })
    console.log(`  ✅ ${name}: ${result}`)
  } catch (err) {
    results.push({ name, status: 'CRASH', detail: err.message })
    console.log(`  ❌ ${name}: CRASH — ${err.message}`)
  }
}

function testSilent(name, fn, checkFn) {
  try {
    const result = fn()
    const ok = checkFn(result)
    if (ok) {
      results.push({ name, status: 'PASS', detail: 'correct' })
      console.log(`  ✅ ${name}: correct`)
    } else {
      results.push({ name, status: 'SILENT_FAIL', detail: `got ${JSON.stringify(result)}` })
      console.log(`  ⚠️  ${name}: SILENT FAIL — got ${JSON.stringify(result).slice(0, 100)}`)
    }
  } catch (err) {
    results.push({ name, status: 'CRASH', detail: err.message })
    console.log(`  ❌ ${name}: CRASH — ${err.message}`)
  }
}

console.log('\n=== EDGE CASE PROBE ===\n')

// ─── 1. Circular reference ────────────────────────────────────────────────────
console.log('1. Circular reference')
testSilent('stableStringify(circular)', () => {
  const obj = {}; obj.self = obj
  return stableStringify(obj)
}, r => typeof r === 'string' && r.includes('__circular__'))

testSilent('deepClone(circular)', () => {
  const obj = {}; obj.self = obj
  return deepClone(obj)
}, r => r !== undefined && r !== null)

testSilent('fingerprint(circular)', () => {
  const obj = {}; obj.self = obj
  return fingerprint('input', obj)
}, r => typeof r === 'string' && r.length === 7)

// ─── 2. Very large output ────────────────────────────────────────────────────
console.log('\n2. Very large output')
testSilent('fingerprint(array 10k items)', () => {
  const arr = Array.from({ length: 10000 }, (_, i) => i)
  return fingerprint('input', arr)
}, r => typeof r === 'string' && r.length === 7)

testSilent('fingerprint(string 1MB)', () => {
  const bigStr = 'x'.repeat(1_000_000)
  return fingerprint('input', bigStr)
}, r => typeof r === 'string' && r.length === 7)

// ─── 3. Output undefined ──────────────────────────────────────────────────────
console.log('\n3. Output undefined')
testSilent('fingerprint(undefined output)', () => {
  return fingerprint('input', undefined)
}, r => typeof r === 'string' && r.length === 7)

testSilent('stableStringify(undefined)', () => {
  return stableStringify(undefined)
}, r => r === 'undefined')

// ─── 4. Output null ──────────────────────────────────────────────────────────
console.log('\n4. Output null')
testSilent('fingerprint(null output)', () => {
  return fingerprint('input', null)
}, r => typeof r === 'string' && r.length === 7)

testSilent('stableStringify(null)', () => {
  return stableStringify(null)
}, r => r === 'null')

// ─── 5. Output function ──────────────────────────────────────────────────────
console.log('\n5. Output function')
testSilent('stableStringify(() => {})', () => {
  return stableStringify(() => {})
}, r => typeof r === 'string')

testSilent('fingerprint(function output)', () => {
  return fingerprint('input', () => {})
}, r => typeof r === 'string' && r.length === 7)

testSilent('deepClone(function)', () => {
  return deepClone(() => {})
}, r => typeof r === 'function')

// ─── 6. Output with BigInt ────────────────────────────────────────────────────
console.log('\n6. Output with BigInt')
testSilent('stableStringify(BigInt)', () => {
  return stableStringify(BigInt(42))
}, r => typeof r === 'string' && r.includes('__bigint__'))

testSilent('fingerprint(BigInt output)', () => {
  return fingerprint('input', BigInt(42))
}, r => typeof r === 'string' && r.length === 7)

testSilent('fingerprint(object with BigInt)', () => {
  return fingerprint('input', { n: BigInt(100) })
}, r => typeof r === 'string' && r.length === 7)

// ─── 7. Output with Date object ──────────────────────────────────────────────
console.log('\n7. Output with Date object')
testSilent('stableStringify(Date)', () => {
  return stableStringify(new Date('2024-01-15T10:00:00Z'))
}, r => typeof r === 'string' && r.includes('2024'))

testSilent('fingerprint(Date output) — consistent hash', () => {
  const d = new Date('2024-01-15T10:00:00Z')
  const h1 = fingerprint('input', d)
  const d2 = new Date('2024-01-15T10:00:00Z')
  const h2 = fingerprint('input', d2)
  return h1 === h2 ? h1 : `INCONSISTENT: ${h1} vs ${h2}`
}, r => typeof r === 'string' && r.length === 7 && !r.includes('INCONSISTENT'))

testSilent('fingerprint(Date output) — different date = different hash', () => {
  const h1 = fingerprint('input', new Date('2024-01-15T10:00:00Z'))
  const h2 = fingerprint('input', new Date('2025-06-20T12:00:00Z'))
  return h1 !== h2 ? 'different' : `SAME: ${h1}`
}, r => r === 'different')

// ─── 8. Async generator as output ─────────────────────────────────────────────
console.log('\n8. Async generator as output')
test('consumeIterator(async generator)', async () => {
  async function* gen() { yield 1; yield 2; yield 3 }
  const { consumed, result } = await consumeIterator(gen())
  return `consumed=${consumed}, items=${result.length}`
})

test('consumeIterator(infinite async generator with maxYields=5)', async () => {
  let i = 0
  async function* infiniteGen() { while (true) { yield i++ } }
  const { consumed, result } = await consumeIterator(infiniteGen(), 5)
  return `consumed=${consumed}, items=${result.length}, truncated=${result.some(r => r.__truncated__)}`
})

// ─── 9. watches with non-existent function names ──────────────────────────────
console.log('\n9. watches with non-existent function names')
testSilent('createGhost with non-existent watches', () => {
  const mod = { foo: () => 42 }
  const recorder = []
  const ghost = createGhost(mod, ['foo', 'nonExistent', 'alsoMissing'], recorder)
  // Should skip non-existent and still proxy 'foo'
  ghost.foo(1)
  return `recorded=${recorder.length}, entries=${recorder.map(r => r.fn).join(',')}`
}, r => r.includes('recorded=1'))

// ─── 10. inputs: [] (empty array) ────────────────────────────────────────────
console.log('\n10. inputs: [] (empty array)')
testSilent('fingerprint with undefined input (empty inputs fallback)', () => {
  return fingerprint(undefined, { result: 42 })
}, r => typeof r === 'string' && r.length === 7)

// ─── 11. multiArgs: true but input not array ─────────────────────────────────
console.log('\n11. multiArgs: true but input not array')
// This is a capture.js-level concern, but we can test the pattern
testSilent('fingerprint with non-array multiArgs pattern', () => {
  const input = "notAnArray"
  const args_ = true && Array.isArray(input) ? [...input] : [input]
  return fingerprint(args_, { result: 42 })
}, r => typeof r === 'string' && r.length === 7)

// ─── 12. Unicode extreme in inputs ────────────────────────────────────────────
console.log('\n12. Unicode extreme in inputs')
testSilent('fingerprint(emoji input)', () => {
  return fingerprint('🎉🎊💧', { result: 42 })
}, r => typeof r === 'string' && r.length === 7)

testSilent('fingerprint(zero-width chars)', () => {
  return fingerprint('hello\u200B\u200C\u200Dworld', { result: 42 })
}, r => typeof r === 'string' && r.length === 7)

testSilent('fingerprint(RTL text)', () => {
  return fingerprint('\u202Ehello\u202C', { result: 42 })
}, r => typeof r === 'string' && r.length === 7)

testSilent('stableStringify(emoji)', () => {
  return stableStringify('🎉🎊💧')
}, r => typeof r === 'string')

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n=== SUMMARY ===')
const crashed = results.filter(r => r.status === 'CRASH')
const silent = results.filter(r => r.status === 'SILENT_FAIL')
const passed = results.filter(r => r.status === 'PASS')
console.log(`  PASS: ${passed.length}`)
console.log(`  CRASH: ${crashed.length}`)
console.log(`  SILENT_FAIL: ${silent.length}`)

if (crashed.length) {
  console.log('\nCrashed tests:')
  for (const c of crashed) console.log(`  ❌ ${c.name}: ${c.detail}`)
}
if (silent.length) {
  console.log('\nSilent failures:')
  for (const s of silent) console.log(`  ⚠️  ${s.name}: ${s.detail}`)
}

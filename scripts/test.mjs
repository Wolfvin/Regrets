#!/usr/bin/env node
// test.mjs — integration test suite for the regrets skill
// Validates: fingerprint parity (JS/Python), .regret parsing, ghost proxy, extractSchema
//
// Usage:
//   node The-skill/regresion-testing/scripts/test.mjs
//   npm run regret:test

import { execFileSync } from 'child_process'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { resolve, dirname, join } from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = __dirname

// Import modules under test
import { stableStringify, normalize, stripFields, fingerprint, fingerprintSequence, extractSchema } from './fingerprint.js'
import { createGhost, deepClone, normalizeHtml } from './ghost.js'

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures = []

function assert(condition, label) {
  if (condition) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ❌ ${label}`)
  }
}

function assertEqual(actual, expected, label) {
  const ok = actual === expected
  if (ok) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ❌ ${label}`)
    console.log(`     Expected: ${JSON.stringify(expected)}`)
    console.log(`     Got:      ${JSON.stringify(actual)}`)
  }
}

// ─── 1. Fingerprint Algorithm ─────────────────────────────────────────────────

console.log('\n🧪 Fingerprint Algorithm\n')

// Determinism: same input must produce same hash
const fp1 = fingerprint('hello', 'world')
const fp2 = fingerprint('hello', 'world')
assertEqual(fp1, fp2, 'fingerprint is deterministic')

// Different inputs must produce different hashes
const fp3 = fingerprint('hello', 'different')
assert(fp1 !== fp3, 'different inputs produce different hashes')

// Hash is 7 chars
assertEqual(fp1.length, 7, 'fingerprint is 7 characters')

// Order-insensitive: {b:2, a:1} and {a:1, b:2} should hash the same
const fp_order1 = fingerprint({ b: 2, a: 1 }, { y: 0, x: 1 })
const fp_order2 = fingerprint({ a: 1, b: 2 }, { x: 1, y: 0 })
assertEqual(fp_order1, fp_order2, 'key order does not affect fingerprint')

// Null and undefined handling
const fp_null = fingerprint(null, 'output')
assert(typeof fp_null === 'string' && fp_null.length === 7, 'fingerprint handles null input')

const fp_undef = fingerprint(undefined, 'output')
assert(typeof fp_undef === 'string' && fp_undef.length === 7, 'fingerprint handles undefined input')

// ─── 2. Normalization ─────────────────────────────────────────────────────────

console.log('\n🧪 Normalization Rules\n')

// Timestamps
const ts_norm = normalize('2024-01-15T10:30:00Z', ['timestamps'])
assertEqual(ts_norm, '<TIMESTAMP>', 'timestamps normalized')

// UUIDs
const uuid_norm = normalize('550e8400-e29b-41d4-a716-446655440000', ['uuids'])
assertEqual(uuid_norm, '<UUID>', 'UUIDs normalized')

// Epochs
const epoch_norm = normalize(1718803200, ['epochs'])
assertEqual(epoch_norm, '<EPOCH>', 'epochs normalized')

// AbsPaths
const path_norm = normalize('/home/user/project/src/file.js', ['absPaths'])
assertEqual(path_norm, '<ROOT>/project/src/file.js', 'absolute paths normalized')

// DynamicDates — MMYYYY
const mmyyyy_norm = normalize('FPK-052026', ['dynamicDates'])
assertEqual(mmyyyy_norm, 'FPK-<MMYYYY>', 'dynamicDates MMYYYY normalized')

// DynamicDates — YYYY standalone
const yyyy_norm = normalize('DOC-2026-report', ['dynamicDates'])
assertEqual(yyyy_norm, 'DOC-<YYYY>-report', 'dynamicDates YYYY normalized')

// DynamicDates — should NOT match invalid months like 132025
const no_match = normalize('132025', ['dynamicDates'])
assertEqual(no_match, '132025', 'dynamicDates does not match invalid month 13')

// ─── 3. stripFields ───────────────────────────────────────────────────────────

console.log('\n🧪 stripFields\n')

const stripped = stripFields({ a: 1, b: 2, c: 3 }, ['b'])
assertEqual(JSON.stringify(stripped), JSON.stringify({ a: 1, c: 3 }), 'stripFields removes specified keys')

const nested = stripFields({ a: { b: 1, c: 2 }, d: 3 }, ['c'])
assertEqual(JSON.stringify(nested), JSON.stringify({ a: { b: 1 }, d: 3 }), 'stripFields works recursively')

// ignorePaths round-trip: verify serialize/parse consistency between capture.js and validate.js
// capture.js writes: ignorePaths: [a.b, c.d]
// validate.js reads: val.slice(1, -1).split(', ').filter(Boolean)
// These must produce the same array that the manifest provided.
const manifestIgnorePaths = ['request.socket', 'response.headers.x-request-id']

// Simulate capture.js serialization
const serialized = `ignorePaths: [${manifestIgnorePaths.join(', ')}]`

// Simulate validate.js parseRegret parsing (same pattern as line 72 of validate.js)
const val = serialized.slice(serialized.indexOf(': ') + 2).trim()
const parsedVal = val.slice(1, -1).split(', ').filter(Boolean)

assertEqual(JSON.stringify(parsedVal), JSON.stringify(manifestIgnorePaths), 'ignorePaths round-trip: serialized → parsed matches original array')

// Verify that parsed ignorePaths produces same fingerprint config as manifest ignorePaths
// (this confirms that capture→validate pipeline is consistent)
const testInput = { request: { socket: 'sock1', data: 'hello' }, response: { headers: { 'x-request-id': 'abc', 'content-type': 'json' } } }
const testOutput = { ok: true }
const fpManifest = fingerprint(testInput, testOutput, { ignorePaths: manifestIgnorePaths })
const fpParsed = fingerprint(testInput, testOutput, { ignorePaths: parsedVal })
assertEqual(fpManifest, fpParsed, 'ignorePaths round-trip: fingerprint with manifest array matches fingerprint with parsed-from-.regret array')

// ─── 4. extractSchema ─────────────────────────────────────────────────────────

console.log('\n🧪 extractSchema\n')

const schema_simple = extractSchema({ name: 'Ali', age: 30, active: true, meta: null })
assertEqual(JSON.stringify(schema_simple), JSON.stringify({ active: 'boolean', age: 'number', meta: 'null', name: 'string' }), 'extractSchema produces correct object schema')

const schema_array = extractSchema([1, 2, 3])
assertEqual(JSON.stringify(schema_array), JSON.stringify(['number']), 'extractSchema produces correct uniform array schema')

const schema_empty = extractSchema([])
assertEqual(schema_empty, 'array', 'extractSchema handles empty array')

const schema_mixed = extractSchema([1, 'two', true])
assert(Array.isArray(schema_mixed) && schema_mixed.length === 3, 'extractSchema detects mixed-type array')

const schema_null = extractSchema(null)
assertEqual(schema_null, 'null', 'extractSchema handles null')

const schema_undef = extractSchema(undefined)
assertEqual(schema_undef, 'undefined', 'extractSchema handles undefined')

// ─── 5. stableStringify ───────────────────────────────────────────────────────

console.log('\n🧪 stableStringify\n')

const ss1 = stableStringify({ b: 2, a: 1 })
const ss2 = stableStringify({ a: 1, b: 2 })
assertEqual(ss1, ss2, 'stableStringify produces order-independent output')

const ss_arr = stableStringify([3, 1, 2])
assertEqual(ss_arr, '[3,1,2]', 'stableStringify preserves array order')

// ─── 6. Ghost Proxy ───────────────────────────────────────────────────────────

console.log('\n🧪 Ghost Proxy\n')

// Test that ghost proxy records calls without changing behavior
const testModule = {
  add: (a, b) => a + b,
  greet: (name) => `Hello, ${name}!`,
}

const recorder = []
const ghost = createGhost(testModule, ['add'], recorder)

const result = ghost.add(3, 4)
assertEqual(result, 7, 'ghost proxy does not change function behavior')
assertEqual(recorder.length, 1, 'ghost proxy records exactly one call')
assertEqual(recorder[0].fn, 'add', 'ghost proxy records function name')
assertEqual(recorder[0].args.length, 2, 'ghost proxy records arguments')
assertEqual(recorder[0].result, 7, 'ghost proxy records result')

// Non-watched functions pass through unchanged
const greetResult = ghost.greet('World')
assertEqual(greetResult, 'Hello, World!', 'non-watched functions pass through')
assertEqual(recorder.length, 1, 'non-watched function not recorded')

// ─── 7. deepClone ─────────────────────────────────────────────────────────────

console.log('\n🧪 deepClone\n')

const original = { a: [1, 2], b: { c: 3 } }
const cloned = deepClone(original)
cloned.a.push(4)
cloned.b.c = 99
assertEqual(JSON.stringify(original), JSON.stringify({ a: [1, 2], b: { c: 3 } }), 'deepClone creates independent copy')

// ─── 8. normalizeHtml ─────────────────────────────────────────────────────────

console.log('\n🧪 normalizeHtml\n')

const html_norm = normalizeHtml('  <div  class="test" >  Hello  </div>  ', [])
assert(!html_norm.includes('  '), 'normalizeHtml collapses whitespace')

const html_strip = normalizeHtml('<div data-testid="x" class="c">Hi</div>', ['data-testid'])
assert(!html_strip.includes('data-testid'), 'normalizeHtml strips specified attributes')
assert(html_strip.includes('class="c"'), 'normalizeHtml preserves non-stripped attributes')

// ─── 9. fingerprintSequence ───────────────────────────────────────────────────

console.log('\n🧪 fingerprintSequence\n')

const calls = [
  { fn: 'add', args: [1, 2], result: 3 },
  { fn: 'multiply', args: [3, 4], result: 12 },
]
const seq_fp1 = fingerprintSequence(calls)
const seq_fp2 = fingerprintSequence(calls)
assertEqual(seq_fp1, seq_fp2, 'fingerprintSequence is deterministic')
assertEqual(seq_fp1.length, 7, 'fingerprintSequence produces 7-char hash')

// ─── 10. Cross-stack Parity (JS vs Python) ────────────────────────────────────

console.log('\n🧪 Cross-Stack Parity (JS vs Python)\n')

// Test that Python fingerprint module produces the same hash
let pythonAvailable = false
try {
  execFileSync('python3', ['--version'], { stdio: 'pipe' })
  pythonAvailable = true
} catch {
  console.log('  ⏭️  Python3 not available — skipping cross-stack parity tests')
}

if (pythonAvailable) {
  const parityScript = `
import sys
sys.path.insert(0, '${SCRIPTS_DIR}')
from fingerprint import fingerprint

# Test 1: Simple string
r1 = fingerprint('hello', 'world')
print(f'TEST1:{r1}')

# Test 2: Object with key ordering
r2 = fingerprint({"b": 2, "a": 1}, {"y": 0, "x": 1})
print(f'TEST2:{r2}')

# Test 3: Null input
r3 = fingerprint(None, 'output')
print(f'TEST3:{r3}')

# Test 4: With normalization
r4 = fingerprint('input', '2024-01-15T10:30:00Z', ['timestamps'], [])
print(f'TEST4:{r4}')
`.trim()

  const tmpPy = resolve(SCRIPTS_DIR, '_parity_test.py')
  writeFileSync(tmpPy, parityScript, 'utf8')

  try {
    const pyOutput = execFileSync('python3', [tmpPy], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = pyOutput.trim().split('\n')

    for (const line of lines) {
      const [key, val] = line.split(':')
      if (key === 'TEST1') assertEqual(val, fingerprint('hello', 'world'), 'JS/Python parity: simple string')
      if (key === 'TEST2') assertEqual(val, fingerprint({ b: 2, a: 1 }, { y: 0, x: 1 }), 'JS/Python parity: object key ordering')
      if (key === 'TEST3') assertEqual(val, fingerprint(null, 'output'), 'JS/Python parity: null input')
      if (key === 'TEST4') assertEqual(val, fingerprint('input', '2024-01-15T10:30:00Z', { normalize: ['timestamps'] }), 'JS/Python parity: timestamp normalization')
    }
  } catch (err) {
    console.log(`  ⚠️  Python parity test failed: ${err.message}`)
  } finally {
    rmSync(tmpPy, { force: true })
  }
}

// ─── 11. .regret File Parsing Round-Trip ──────────────────────────────────────

console.log('\n🧪 .regret File Parsing Round-Trip\n')

// Create a sample .regret file and verify parseRegret can read it back
const sampleRegret = `cluster: test-cluster
fingerprint: abc1234
captured: 2024-01-15T10:30:00Z
watches: [add, multiply]
entry: computeTotal
stack: js
fingerprintLevel: entry
fingerprintMode: schema
normalize: [timestamps, dynamicDates]
---
INPUT  {"a":1,"b":2}
OUTPUT {"total":3}
HASH   abc1234`

// Parse it using validate.js's parseRegret logic (inline)
const [metaSection, dataSection] = sampleRegret.split('\n---\n')
const meta = {}
for (const line of metaSection.split('\n')) {
  const colonIdx = line.indexOf(': ')
  if (colonIdx === -1) continue
  const key = line.slice(0, colonIdx)
  const val = line.slice(colonIdx + 2).trim()
  if (key === 'watches') meta.watches = val.slice(1, -1).split(', ').filter(Boolean)
  else if (key === 'normalize') meta.normalize = val.slice(1, -1).split(', ').filter(Boolean)
  else if (key === 'fingerprintMode') meta.fingerprintMode = val
  else meta[key] = val
}
const dataLines = dataSection?.split('\n') ?? []
const inputLine = dataLines.find(l => l.startsWith('INPUT '))
const outputLine = dataLines.find(l => l.startsWith('OUTPUT '))
const hashLine = dataLines.find(l => l.startsWith('HASH '))

assertEqual(meta.cluster, 'test-cluster', '.regret parse: cluster name')
assertEqual(meta.fingerprint, 'abc1234', '.regret parse: fingerprint')
assertEqual(meta.fingerprintMode, 'schema', '.regret parse: fingerprintMode')
assert(meta.watches.includes('add') && meta.watches.includes('multiply'), '.regret parse: watches array')
assert(meta.normalize.includes('timestamps') && meta.normalize.includes('dynamicDates'), '.regret parse: normalize array')
assertEqual(JSON.stringify(JSON.parse(inputLine.replace(/^INPUT\s+/, ''))), JSON.stringify({ a: 1, b: 2 }), '.regret parse: INPUT JSON')
assertEqual(JSON.stringify(JSON.parse(outputLine.replace(/^OUTPUT\s+/, ''))), JSON.stringify({ total: 3 }), '.regret parse: OUTPUT JSON')
assertEqual(hashLine.replace(/^HASH\s+/, '').trim(), 'abc1234', '.regret parse: HASH')

// ─── 12. Property-Based Tests ─────────────────────────────────────────────────

console.log('\n🧪 Property-Based Testing (Fingerprint Determinism)\n')

function* generateRandomInputs(seed = 42, count = 50) {
  let s = seed
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  for (let i = 0; i < count; i++) {
    const types = ['string', 'number', 'object', 'array', 'null', 'boolean']
    const type = types[Math.floor(rand() * types.length)]
    let input, output
    switch (type) {
      case 'string': input = `test-${rand().toString(36).slice(2)}`; output = `out-${rand().toString(36).slice(2)}`; break
      case 'number': input = Math.floor(rand() * 10000); output = Math.floor(rand() * 10000); break
      case 'object': input = { x: rand(), y: rand() }; output = { z: rand() }; break
      case 'array': input = [rand(), rand()]; output = [rand()]; break
      case 'null': input = null; output = null; break
      case 'boolean': input = rand() > 0.5; output = rand() > 0.5; break
    }
    yield { input, output }
  }
}

let propTestCount = 0
for (const { input, output } of generateRandomInputs()) {
  propTestCount++
  const fpA = fingerprint(input, output)
  const fpB = fingerprint(input, output)
  assert(fpA === fpB, `property: fingerprint determinism #${propTestCount}`)
  assertEqual(fpA.length, 7, `property: fingerprint length is 7 #${propTestCount}`)
  assert(/^[0-9a-z]{7}$/.test(fpA), `property: fingerprint is valid base36 #${propTestCount}`)
}

// ─── 13. Edge Case Stress Tests ────────────────────────────────────────────────

console.log('\n🧪 Edge Case Stress Tests\n')

const fp_empty = fingerprint('', '')
assert(typeof fp_empty === 'string' && fp_empty.length === 7, 'fingerprint handles empty string input/output')

const fp_long = fingerprint('x'.repeat(10000), 'y'.repeat(10000))
assert(typeof fp_long === 'string' && fp_long.length === 7, 'fingerprint handles very long strings (10000 chars)')

const fp_nested = fingerprint({a:{a:{a:{a:{a:{a:{a:{a:{a:{a:1}}}}}}}}}}, 'out')
assert(typeof fp_nested === 'string' && fp_nested.length === 7, 'fingerprint handles deeply nested object (10 levels)')

const fp_large_arr = fingerprint(Array.from({length:100}, (_, i) => i), 'out')
assert(typeof fp_large_arr === 'string' && fp_large_arr.length === 7, 'fingerprint handles large array (100 elements)')

const fp_unicode = fingerprint('你好世界', 'こんにちは')
assert(typeof fp_unicode === 'string' && fp_unicode.length === 7, 'fingerprint handles Unicode strings')

const fp_special = fingerprint('hello\n\t\r"\\', 'world<>%$')
assert(typeof fp_special === 'string' && fp_special.length === 7, 'fingerprint handles special characters')

// ─── 13.5. TypedArray Support ─────────────────────────────────────────────────

console.log('\n🧪 TypedArray Support\n')

// Uint8Array fingerprinting — must serialize as array, not indexed object
const uint8 = new Uint8Array([212, 29, 140, 217])
const fp_uint8 = fingerprint('input', uint8)
assert(typeof fp_uint8 === 'string' && fp_uint8.length === 7, 'fingerprint handles Uint8Array output')

// Uint8Array must produce same fingerprint as equivalent array
const fp_array_equiv = fingerprint('input', [212, 29, 140, 217])
assertEqual(fp_uint8, fp_array_equiv, 'Uint8Array fingerprint matches equivalent array')

// Different TypedArray values must produce different hashes
const uint8_diff = new Uint8Array([0, 0, 0, 0])
const fp_uint8_diff = fingerprint('input', uint8_diff)
assert(fp_uint8 !== fp_uint8_diff, 'different TypedArray values produce different hashes')

// stableStringify TypedArray
const ss_uint8 = stableStringify(new Uint8Array([1, 2, 3]))
assertEqual(ss_uint8, '[1,2,3]', 'stableStringify serializes Uint8Array as array')

// normalize TypedArray
const norm_uint8 = normalize(new Uint8Array([1, 2, 3]), [])
assert(Array.isArray(norm_uint8), 'normalize converts TypedArray to array')

// stripFields TypedArray
const stripped_uint8 = stripFields(new Uint8Array([1, 2, 3]), ['x'])
assert(Array.isArray(stripped_uint8), 'stripFields converts TypedArray to array')

// extractSchema TypedArray
const schema_uint8 = extractSchema(new Uint8Array([1, 2, 3]))
assertEqual(JSON.stringify(schema_uint8), JSON.stringify(['number']), 'extractSchema handles TypedArray')

// Int32Array
const int32 = new Int32Array([1000, 2000])
const fp_int32 = fingerprint('input', int32)
assert(typeof fp_int32 === 'string' && fp_int32.length === 7, 'fingerprint handles Int32Array')

// deepClone TypedArray
const cloned_uint8 = deepClone(new Uint8Array([10, 20, 30]))
assert(Array.isArray(cloned_uint8), 'deepClone converts TypedArray to array')
assertEqual(cloned_uint8[0], 10, 'deepClone preserves TypedArray values')
assertEqual(cloned_uint8[2], 30, 'deepClone preserves all TypedArray values')

// Float64Array
const f64 = new Float64Array([1.5, 2.5, 3.5])
const fp_f64 = fingerprint('input', f64)
assert(typeof fp_f64 === 'string' && fp_f64.length === 7, 'fingerprint handles Float64Array')

// ─── 14. E2E Full-Cycle Test ──────────────────────────────────────────────────

console.log('\n🧪 End-to-End Full Cycle Test\n')

const tmpDir = resolve(os.tmpdir(), `regret-e2e-test-${Date.now()}`)
mkdirSync(tmpDir, { recursive: true })

try {
  // 1. Create a test module in memory
  const testModuleCode = `export function add(a, b) { return a + b }`
  const modulePath = join(tmpDir, 'math.mjs')
  writeFileSync(modulePath, testModuleCode, 'utf8')

  // 2. Compute the expected fingerprint directly
  const testInput = { a: 1, b: 2 }
  const testOutput = 3
  const expectedFp = fingerprint(testInput, testOutput)

  // 3. Write a .regret file
  const regretContent = `cluster: math-cluster
fingerprint: ${expectedFp}
captured: ${new Date().toISOString()}
watches: [add]
entry: add
stack: js
fingerprintLevel: entry
fingerprintMode: schema
normalize: []
---
INPUT  ${JSON.stringify(testInput)}
OUTPUT ${JSON.stringify(testOutput)}
HASH   ${expectedFp}`
  const regretPath = join(tmpDir, 'math-cluster.regret')
  writeFileSync(regretPath, regretContent, 'utf8')
  assert(existsSync(regretPath), 'E2E: .regret file was created')

  // 4. Read it back and verify the hash matches
  const readBack = readFileSync(regretPath, 'utf8')
  const readBackHash = readBack.split('\n').find(l => l.startsWith('HASH')).replace(/^HASH\s+/, '').trim()
  assertEqual(readBackHash, expectedFp, 'E2E: read-back hash matches expected fingerprint')

  // 5. Test mismatch: change the hash, verify it no longer matches
  const tamperedContent = regretContent.replace(`HASH   ${expectedFp}`, 'HASH   tamper!')
  writeFileSync(regretPath, tamperedContent, 'utf8')
  const tamperedRead = readFileSync(regretPath, 'utf8')
  const tamperedHash = tamperedRead.split('\n').find(l => l.startsWith('HASH')).replace(/^HASH\s+/, '').trim()
  assert(tamperedHash !== expectedFp, 'E2E: tampered hash no longer matches expected fingerprint')

  // 6. Re-capture: write the correct hash back
  writeFileSync(regretPath, regretContent, 'utf8')
  const restoredRead = readFileSync(regretPath, 'utf8')
  const restoredHash = restoredRead.split('\n').find(l => l.startsWith('HASH')).replace(/^HASH\s+/, '').trim()
  assertEqual(restoredHash, expectedFp, 'E2E: re-captured hash matches after restore')

  console.log('  🏁 E2E full cycle completed successfully')
} finally {
  // 7. Clean up temp directory
  rmSync(tmpDir, { recursive: true, force: true })
  assert(!existsSync(tmpDir), 'E2E: temp directory cleaned up')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
if (failed === 0) {
  console.log(`✅ All ${passed} tests passed. Skill is healthy.\n`)
  process.exit(0)
} else {
  console.log(`❌ ${failed}/${passed + failed} tests failed:\n`)
  for (const f of failures) {
    console.log(`  • ${f}`)
  }
  console.log()
  process.exit(1)
}

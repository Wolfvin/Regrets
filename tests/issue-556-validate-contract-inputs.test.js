// tests/issue-556-validate-contract-inputs.test.js
//
// Issue #556: validate.js must only re-test inputs recorded in the .regret
// contract (INPUT line + INPUTS line), NOT raw inputs from the manifest.
//
// Before #556, validate read ALL inputs from clusterDef.inputs (the manifest),
// including inputs that had thrown during capture and were therefore excluded
// from the .regret file. This caused ~30% false FAIL clusters on first
// validation with no code change.
//
// Coverage:
//   1. Fresh capture with crashing inputs → validate PASSES (no false FAIL)
//   2. Validate reports uncovered inputs (informational, NOT a FAIL)
//   3. JSON output includes uncoveredInputs field
//   4. Full cycle: capture → PASS → break function → FAIL → restore → PASS
//   5. Backward compat: old .regret without INPUTS line still works
//
// Run: node --test tests/issue-556-validate-contract-inputs.test.js

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')

const TMP = resolve(join(process.cwd(), 'tests', `__issue556_${process.pid}__`))

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: TMP, stdio: 'pipe', ...opts })
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ? r.stdout.toString() : '',
    stderr: r.stderr ? r.stderr.toString() : '',
  }
}

function setupProject(sourceCode, inputs) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), sourceCode)
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({
    name: 'issue-556-test', version: '0.0.0', type: 'module',
  }))
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: 'fn',
      entry: 'fn',
      file: 'api.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs,
      watches: [],
    }],
  }, null, 2))
}

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

function readRegret() {
  return readFileSync(join(TMP, 'regrets', 'fn.regret'), 'utf8')
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('#556 — validate uses .regret contract as input source, not manifest', () => {
  beforeEach(() => {
    cleanup()
    // Function that throws on non-string input (like validator.js's assertString)
    setupProject(
      `export function fn(x) {
         if (typeof x !== 'string') throw new TypeError('Expected string, got ' + typeof x)
         return x.toUpperCase()
       }`,
      ['hello', 'world', 42, null, { nested: true }],
    )
  })
  after(() => cleanup())

  it('capture succeeds and writes .regret with only non-throwing inputs', () => {
    const r = sh('node', [CAPTURE_JS])
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)
    assert.ok(existsSync(join(TMP, 'regrets', 'fn.regret')),
      '.regret should exist after capture')
    const content = readRegret()
    // Golden input
    assert.ok(content.includes('INPUT  "hello"'), 'golden input should be "hello"')
    // Only "world" should be in INPUTS (the other 3 threw during capture)
    const inputsLine = content.split('\n').find(l => l.startsWith('INPUTS '))
    assert.ok(inputsLine, 'should have INPUTS line for multi-input manifest')
    const parsed = JSON.parse(inputsLine.replace(/^INPUTS\s+/, ''))
    assert.equal(parsed.length, 1, 'INPUTS should have 1 entry (only "world" succeeded)')
    assert.equal(parsed[0].input, 'world', 'the only INPUTS entry should be "world"')
  })

  it('validate PASSES on fresh capture with no code change (no false FAIL)', () => {
    sh('node', [CAPTURE_JS])
    const r = sh('node', [VALIDATE_JS])
    assert.equal(r.exitCode, 0,
      `validate should PASS on fresh capture. stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stdout, /✅ fn.*PASS/,
      'validate output should show fn PASS')
  })

  it('validate reports uncovered inputs as informational (NOT a FAIL)', () => {
    sh('node', [CAPTURE_JS])
    const r = sh('node', [VALIDATE_JS])
    assert.match(r.stdout, /3 input\(s\) in manifest not covered by contract/,
      'validate should report 3 uncovered inputs')
    // The uncovered inputs message should appear AFTER the PASS line
    assert.match(r.stdout, /✅ fn.*PASS[\s\S]*3 input\(s\) in manifest not covered by contract/,
      'uncovered inputs message should be informational, not a failure')
  })

  it('JSON output includes uncoveredInputs field', () => {
    sh('node', [CAPTURE_JS])
    const r = sh('node', [VALIDATE_JS, '--json'])
    assert.equal(r.exitCode, 0, `validate --json should PASS. stdout: ${r.stdout}`)
    const parsed = JSON.parse(r.stdout)
    const fnResult = parsed.clusters.find(x => x.id === 'fn')
    assert.ok(fnResult, 'should have fn result')
    assert.equal(fnResult.pass, true, 'fn should PASS')
    assert.equal(fnResult.uncoveredInputs, 3,
      'should report 3 uncovered inputs in JSON')
  })

  it('validate FAILs when function actually breaks', () => {
    sh('node', [CAPTURE_JS])
    // Change behavior: return lowercase instead of uppercase
    setupProject(
      `export function fn(x) {
         if (typeof x !== 'string') throw new TypeError('Expected string, got ' + typeof x)
         return x.toLowerCase()
       }`,
      ['hello', 'world', 42, null, { nested: true }],
    )
    const r = sh('node', [VALIDATE_JS])
    assert.notEqual(r.exitCode, 0,
      'validate MUST FAIL when function behavior changed')
    assert.match(r.stdout, /❌ fn.*FAIL/,
      'validate output should show fn FAIL')
  })

  it('full cycle: capture → PASS → break → FAIL → restore → PASS', () => {
    // Step 1: Capture
    const cap = sh('node', [CAPTURE_JS])
    assert.equal(cap.exitCode, 0, `capture failed: ${cap.stderr}`)

    // Step 2: Validate PASSES
    const v1 = sh('node', [VALIDATE_JS])
    assert.equal(v1.exitCode, 0, `validate should PASS after capture. stdout: ${v1.stdout}`)

    // Step 3: Break function
    setupProject(
      `export function fn(x) {
         if (typeof x !== 'string') throw new TypeError('Expected string, got ' + typeof x)
         return x.toLowerCase()
       }`,
      ['hello', 'world', 42, null, { nested: true }],
    )

    // Step 4: Validate FAILs
    const v2 = sh('node', [VALIDATE_JS])
    assert.notEqual(v2.exitCode, 0, 'validate MUST FAIL after breaking change')
    assert.match(v2.stdout, /❌ fn.*FAIL/, 'should show FAIL for broken function')

    // Step 5: Restore function
    setupProject(
      `export function fn(x) {
         if (typeof x !== 'string') throw new TypeError('Expected string, got ' + typeof x)
         return x.toUpperCase()
       }`,
      ['hello', 'world', 42, null, { nested: true }],
    )

    // Step 6: Validate PASSES again
    const v3 = sh('node', [VALIDATE_JS])
    assert.equal(v3.exitCode, 0,
      `validate should PASS after restoring. stdout: ${v3.stdout}`)
    assert.match(v3.stdout, /✅ fn.*PASS/, 'should show PASS after restore')
  })
})

describe('#556 — backward compat: old .regret without INPUTS line', () => {
  beforeEach(() => {
    cleanup()
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'api.mjs'),
      `export function fn(x) { return typeof x === 'string' ? x.toUpperCase() : String(x) }`)
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'issue-556-backward-compat', version: '0.0.0', type: 'module',
    }))
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'fn', entry: 'fn', file: 'api.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: ['hello', 42], watches: [],
      }],
    }, null, 2))
    // Hand-craft an OLD .regret file (no INPUTS line).
    // Use the actual correct hash for fn("hello") = "HELLO"
    writeFileSync(join(TMP, 'regrets', 'fn.regret'), [
      'cluster: fn',
      'version: 1',
      'fingerprint: 67q5v7m',
      `captured: ${new Date().toISOString()}`,
      'watches: []',
      'entry: fn',
      'stack: js',
      'fingerprintLevel: entry',
      '---',
      'INPUT  "hello"',
      'OUTPUT "HELLO"',
      'HASH   67q5v7m',
    ].join('\n'))
  })
  after(() => cleanup())

  it('old .regret (no INPUTS line) validates without crashing', () => {
    const r = sh('node', [VALIDATE_JS])
    // Should not crash — may report uncovered inputs but should not FAIL
    assert.equal(r.exitCode, 0,
      `old .regret should validate without crash. stdout: ${r.stdout}\nstderr: ${r.stderr}`)
  })

  it('old .regret reports uncovered manifest inputs', () => {
    const r = sh('node', [VALIDATE_JS])
    // Input "42" is in the manifest but not in the old .regret contract
    // (old .regret only has golden input "hello", no INPUTS line)
    assert.match(r.stdout, /1 input\(s\) in manifest not covered by contract/,
      'should report 1 uncovered input (42)')
  })
})

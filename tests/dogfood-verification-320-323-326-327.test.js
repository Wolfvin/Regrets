// tests/dogfood-verification-320-323-326-327.test.js
//
// Meta-regression test that verifies all 4 DOGFOOD issues are fixed in a
// single runnable file. This complements the per-issue tests in:
//   - tests/scope.test.js (#320, #323)
//   - tests/capture-dogfood-324-318-326.test.js (#326)
//   - tests/install-scope-discovery.test.js (#327)
//
// Each describe block reproduces the EXACT scenario from the original issue
// report and asserts the fix is in place. This file exists so that BOS /
// future workers can audit all 4 fixes in one place, and so that any
// regression that breaks ALL 4 fixes simultaneously (e.g. a refactor of
// install.js that re-introduces flat-dir-only mode) is caught loudly.
//
// Issues covered:
//   #320 — install --scope on single .js file reports 0 functions
//   #323 — install --scope <dir> silently uses maxDepth:0 (non-recursive)
//   #326 — Capture inconsistently writes callee contracts
//   #327 — Install summary "N captured" is misleading (no callee breakdown)
//
// Run: node --test tests/dogfood-verification-320-323-326-327.test.js

import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const INSTALL_JS = join(REPO_ROOT, 'scripts', 'install.js')
const CAPTURE_JS = join(REPO_ROOT, 'scripts', 'capture.js')

const TMP = resolve(REPO_ROOT, 'tests', `__dogfood_verify_${process.pid}__`)

function setupProject(files) {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(TMP, path)
    mkdirSync(resolve(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, content)
  }
}

function runInstall(args = []) {
  const r = spawnSync('node', [INSTALL_JS, ...args], {
    cwd: TMP, encoding: 'utf8', timeout: 30_000,
  })
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function runCapture(args = []) {
  const r = spawnSync('node', [CAPTURE_JS, ...args], {
    cwd: TMP, encoding: 'utf8', timeout: 30_000,
  })
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

before(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }) })
beforeEach(() => {
  // Reset TMP to a clean state before each test — remove all files but keep the dir
  const entries = readdirSync(TMP, { withFileTypes: true })
  for (const e of entries) {
    rmSync(join(TMP, e.name), { recursive: true, force: true })
  }
})
after(()  => { rmSync(TMP, { recursive: true, force: true }) })

// ─── #320 — single-file scope reports 0 functions ────────────────────────────

describe('#320 — install --scope <single-file.js> reports exported functions (not 0)', () => {
  it('finds all exported functions in a single .js file', () => {
    setupProject({
      'big-file.js': `
export function add(a, b) { return a + b }
export function mul(a, b) { return a * b }
export function isPositive(n) { return n > 0 }
export const square = (x) => x * x
export function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1) }
`,
    })

    const r = runInstall(['--scope', 'big-file.js', '--stack', 'js', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)
    // The bug: "Found 0 exported functions across 0 files". The fix: 5 found.
    assert.match(r.stdout, /Found 5 exported functions across 1 files?/,
      'single-file scope should find all 5 exported functions (was: 0)')
    assert.match(r.stdout, /Scope: single file — big-file\.js/,
      'should report single-file scope mode')
  })
})

// ─── #323 — --scope <dir> is recursive by default ────────────────────────────

describe('#323 — install --scope <dir> scans recursively by default', () => {
  it('finds functions in nested subdirectories (not just top level)', () => {
    setupProject({
      'top.js': `export function topFn() { return 'top' }`,
      'sub/nested.js': `export function nestedFn() { return 'nested' }`,
      'sub/deep/deeper.js': `export function deepFn() { return 'deep' }`,
    })

    const r = runInstall(['--scope', '.', '--stack', 'js', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)
    // The bug: only top.js was scanned (1 file, 1 function).
    // The fix: all 3 files scanned recursively (3 functions).
    assert.match(r.stdout, /Found 3 exported functions across 3 files?/,
      'recursive scan should find functions in all 3 files (was: 1 file only)')

    // Verify the manifest includes functions from nested files
    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(entries.includes('topFn'), 'topFn should be in manifest')
    assert.ok(entries.includes('nestedFn'), 'nestedFn should be in manifest')
    assert.ok(entries.includes('deepFn'), 'deepFn should be in manifest')
  })

  it('--flat flag restores the old non-recursive behavior', () => {
    // Re-setup the same fixture as the recursive test (beforeEach cleared it)
    setupProject({
      'top.js': `export function topFn() { return 'top' }`,
      'sub/nested.js': `export function nestedFn() { return 'nested' }`,
      'sub/deep/deeper.js': `export function deepFn() { return 'deep' }`,
    })

    const r = runInstall(['--scope', '.', '--stack', 'js', '--skip-capture', '--flat'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)
    // With --flat, only top.js is scanned (1 file, 1 function)
    assert.match(r.stdout, /Found 1 exported functions? across 1 files?/,
      '--flat should scan only top-level (1 file, 1 function)')
  })
})

// ─── #326 — callee contracts written consistently ────────────────────────────

describe('#326 — capture writes callee contracts for all invoked callees', () => {
  it('writes contracts for both callees when both are invoked (axios isEmptyObject scenario)', () => {
    setupProject({
      'utils.mjs': `
function isObject(val) { return val !== null && typeof val === 'object' }
function isBuffer(val) {
  return val !== null && typeof val === 'object' && val._isBuffer === true
}
export function isEmptyObject(val) {
  if (!isObject(val) || isBuffer(val)) { return false }
  return Object.keys(val).length === 0
}
export default { isObject, isBuffer, isEmptyObject }
`,
    })

    // Provide inputs that exercise BOTH callees:
    //   null → isObject(null)=false → !false=true → short-circuits (isBuffer NOT called)
    //   {}   → isObject({})=true  → !true=false  → isBuffer({}) IS called
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'utils-is-empty-object',
        entry: 'isEmptyObject',
        file: './utils.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [null, {}],
        callees: ['isObject', 'isBuffer'],
        watches: [],
      }],
    }))

    const r = runCapture(['--cluster', 'utils-is-empty-object'])
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)

    // The bug: only isBuffer.regret was written (isObject.regret was missing).
    // The fix: both callee contracts are written because both are invoked
    // across the 2 inputs.
    const isObjectRegret = join(TMP, 'regrets', 'utils-is-empty-object.calls.isObject.regret')
    const isBufferRegret = join(TMP, 'regrets', 'utils-is-empty-object.calls.isBuffer.regret')
    assert.ok(existsSync(isObjectRegret),
      'isObject.regret should exist (was missing before #326 fix)')
    assert.ok(existsSync(isBufferRegret),
      'isBuffer.regret should exist')

    // Combined output should mention both saves
    const combined = r.stdout + r.stderr
    assert.match(combined, /Saved: regrets\/utils-is-empty-object\.calls\.isObject\.regret/,
      'capture output should mention isObject.regret save')
    assert.match(combined, /Saved: regrets\/utils-is-empty-object\.calls\.isBuffer\.regret/,
      'capture output should mention isBuffer.regret save')
  })

  it('emits clear "not called" info (not warning) for callee behind untriggered conditional', () => {
    setupProject({
      'utils.mjs': `
function isObject(val) { return val !== null && typeof val === 'object' }
function isBuffer(val) {
  return val !== null && typeof val === 'object' && val._isBuffer === true
}
export function isEmptyObject(val) {
  if (!isObject(val) || isBuffer(val)) { return false }
  return Object.keys(val).length === 0
}
export default { isObject, isBuffer, isEmptyObject }
`,
    })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'utils-is-empty-object',
        entry: 'isEmptyObject',
        file: './utils.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        // Only input null — isObject is called, isBuffer is NOT (short-circuit)
        inputs: [null],
        callees: ['isObject', 'isBuffer'],
        watches: [],
      }],
    }))

    const r = runCapture(['--cluster', 'utils-is-empty-object'])
    const combined = r.stdout + r.stderr

    // The bug: silent skip + validate FAIL with confusing "missing" message.
    // The fix: clear "ℹ️ was not called" info (not ⚠️ warning), with actionable guidance.
    assert.match(combined, /ℹ️\s+Callee "isBuffer" was not called during capture/,
      'isBuffer (not called for input null) should get the "was not called" info message')
    assert.match(combined, /conditional/,
      'message should mention conditional logic as the cause')
    assert.match(combined, /Add inputs that exercise the branch containing "isBuffer"/,
      'message should suggest adding inputs that exercise the branch')

    // isObject WAS called → contract should be written, no warning
    assert.doesNotMatch(combined, /Callee "isObject" was not called/,
      'isObject should NOT get the "not called" warning (it was called)')
  })
})

// ─── #327 — install summary shows callee-coverage breakdown ──────────────────

describe('#327 — install summary shows callee-coverage breakdown', () => {
  it('summary distinguishes fully-verified / partial / parent-only clusters', () => {
    // Build a fixture with 3 clusters:
    //   - parentOnly: no callees declared → parent only
    //   - fullyVerified: callees declared AND all are called → fully verified
    //   - partial: callees declared but only some are called → partial
    setupProject({
      'fixture.mjs': `
function helper(x) { return x + 1 }
function unusedHelper(x) { return x - 1 }
export function parentOnly(x) { return x * 2 }
export function fullyVerified(x) { return helper(x) }
export function partial(x) {
  if (x > 0) { return helper(x) }
  return unusedHelper(x)  // never called for input 0
}
export default { helper, unusedHelper, parentOnly, fullyVerified, partial }
`,
    })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [
        {
          id: 'parent-only', entry: 'parentOnly', file: './fixture.mjs',
          stack: 'js', fingerprintLevel: 'entry', inputs: [5],
          watches: [], callees: [],
        },
        {
          id: 'fully-verified', entry: 'fullyVerified', file: './fixture.mjs',
          stack: 'js', fingerprintLevel: 'entry', inputs: [5],
          watches: [], callees: ['helper'],
        },
        {
          id: 'partial', entry: 'partial', file: './fixture.mjs',
          stack: 'js', fingerprintLevel: 'entry', inputs: [5],
          watches: [], callees: ['helper', 'unusedHelper'],
        },
      ],
    }))

    // Run install (which will capture). We use install directly because #327
    // is specifically about install's summary output.
    const r = runInstall(['--scope', '.', '--stack', 'js'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)

    // The bug: install summary only showed "Clusters captured: N" with no
    // callee breakdown. The fix: breakdown by fully verified / partial /
    // parent only.
    assert.match(r.stdout, /fully verified \(all declared callees contracted\)/,
      'summary should show "fully verified" line (#327 fix)')
    assert.match(r.stdout, /partial \(some callees not contracted\)/,
      'summary should show "partial" line (#327 fix)')
    assert.match(r.stdout, /parent only \(no callees declared\)/,
      'summary should show "parent only" line (#327 fix)')
  })
})

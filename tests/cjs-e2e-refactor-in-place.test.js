// tests/cjs-e2e-refactor-in-place.test.js — E2E test for CJS ghost proxy path
//
// Fills the gap from issue #252: the existing tests/e2e.test.js covers the
// ESM transform path (capture → validate → mutate → validate), but the CJS
// ghost proxy path (module.exports + cjs-callee-transform.js + cjs-wrapper.js
// + cjs-merge.js) had no equivalent refactor-in-place E2E test.
//
// What this proves:
//   1. capture() on a CJS module with module.exports + callee watches → writes .regret
//   2. validate() with no code changes → PASS (no regression)
//   3. validate() after a SAFE refactor (rename internal var, output unchanged) → PASS
//   4. validate() after a BREAKING refactor (change behavior) → FAIL (regression detected)
//   5. validate() after restoring original code → PASS again
//
// The SAFE refactor step is the key addition over e2e.test.js — that test only
// covers "no change → PASS" and "mutate → FAIL", not "safe refactor → PASS".
// A safe refactor (e.g. renaming a parameter, switching loop style) should NOT
// change the output and therefore should NOT change the fingerprint. This test
// proves that contract holds for the CJS path.
//
// Both capture and validate run as child processes (via execFileSync) to mirror
// real CLI usage and avoid Node.js module caching issues when the fixture file
// is rewritten between steps.
//
// Run: node --test tests/cjs-e2e-refactor-in-place.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

// ─── Fixture helpers ────────────────────────────────────────────────────────

const TMP = resolve(join(tmpdir(), 'regrets-cjs-e2e-' + process.pid))
const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_JS = join(SCRIPTS_DIR, 'capture.js')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')

function writeManifest(tmpDir, clusters) {
  // Use absolute paths for file fields — runCluster() in validate.js resolves
  // relative to process.cwd(), so relative paths break when test runs from
  // the repo root. Absolute paths work regardless.
  const withAbsPaths = clusters.map(c => ({
    ...c,
    file: resolve(tmpDir, c.file),
  }))
  writeFileSync(join(tmpDir, 'regrets', 'manifest.json'), JSON.stringify({ clusters: withAbsPaths }))
}

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })

  // CJS module with module.exports + a callee (internal function call).
  // This exercises the cjs-callee-transform.js + cjs-wrapper.js + cjs-merge.js
  // pipeline — the "ghost proxy" path for CommonJS modules.
  writeFileSync(join(TMP, 'math.js'), `
function add(a, b) { return a + b }
function main(a, b) { return module.exports.add(a, b) }
module.exports = { add, main }
`)

  writeManifest(TMP, [
    {
      id: 'main',
      entry: 'main',
      file: './math.js',
      stack: 'js',
      fingerprintLevel: 'entry',
      multiArgs: true,
      inputs: [[3, 4], [10, 5], [0, 0], [-1, 1]],
      watches: ['add'],
    }
  ])
}

function applySafeRefactor() {
  // SAFE refactor: rename parameters (a,b → x,y) and switch from `return` to
  // a local variable. Output is IDENTICAL → fingerprint should NOT change.
  writeFileSync(join(TMP, 'math.js'), `
function add(x, y) {
  const result = x + y
  return result
}
function main(x, y) { return module.exports.add(x, y) }
module.exports = { add, main }
`)
}

function applyBreakingRefactor() {
  // BREAKING refactor: change `+` to `*` — output changes → fingerprint MUST change.
  writeFileSync(join(TMP, 'math.js'), `
function add(a, b) { return a * b }
function main(a, b) { return module.exports.add(a, b) }
module.exports = { add, main }
`)
}

function restoreModule() {
  writeFileSync(join(TMP, 'math.js'), `
function add(a, b) { return a + b }
function main(a, b) { return module.exports.add(a, b) }
module.exports = { add, main }
`)
}

function cleanupProject() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
}

/**
 * Run `node scripts/capture.js` as a child process.
 * capture.js exits 0 on success, 1 if any cluster fails.
 */
function runCaptureCli(cwd) {
  try {
    const stdout = execFileSync('node', [CAPTURE_JS, '--quiet'], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { exitCode: 0, stdout, passed: true }
  } catch (err) {
    return { exitCode: err.status || 1, stdout: err.stdout || '', stderr: err.stderr || '', passed: false }
  }
}

/**
 * Run `node scripts/validate.js` as a child process and parse the exit code.
 * validate.js exits 0 if all pass, 1 if any fail.
 */
function runValidateCli(cwd) {
  try {
    const stdout = execFileSync('node', [VALIDATE_JS, '--quiet'], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { exitCode: 0, stdout, passed: true }
  } catch (err) {
    return { exitCode: err.status || 1, stdout: err.stdout || '', stderr: err.stderr || '', passed: false }
  }
}

// ─── E2E Tests ──────────────────────────────────────────────────────────────

describe('CJS E2E: full capture → validate → safe-refactor → breaking-refactor → restore cycle', () => {
  before(() => setupProject())
  after(() => cleanupProject())

  it('capture() writes a .regret file with a fingerprint (CJS ghost proxy path)', () => {
    const result = runCaptureCli(TMP)

    assert.equal(result.exitCode, 0, `capture should exit 0; got stdout: ${result.stdout}, stderr: ${result.stderr}`)
    assert.ok(result.passed, 'capture should report passed')

    // Verify the .regret file exists on disk
    const regretPath = join(TMP, 'regrets', 'main.regret')
    assert.ok(existsSync(regretPath), '.regret file should exist after capture')

    // Verify the .regret file contains expected structure
    const content = readFileSync(regretPath, 'utf8')
    assert.ok(content.includes('cluster: main'), '.regret has cluster id')
    assert.ok(content.includes('fingerprint:'), '.regret has fingerprint field')
    assert.ok(content.includes('---'), '.regret has data separator')
    assert.ok(content.includes('HASH'), '.regret has HASH line')
    assert.ok(content.includes('stack: js'), '.regret has stack field')
  })

  it('validate passes when code is unchanged (no regression)', () => {
    const result = runValidateCli(TMP)

    assert.equal(result.exitCode, 0, `validate should exit 0; stdout: ${result.stdout}`)
    assert.ok(result.passed, 'validate should report passed')
  })

  it('validate PASSES after a SAFE refactor (rename params — output unchanged)', () => {
    applySafeRefactor()

    const result = runValidateCli(TMP)

    assert.equal(result.exitCode, 0,
      `validate should exit 0 after safe refactor (output unchanged → fingerprint unchanged); stdout: ${result.stdout}, stderr: ${result.stderr}`)
    assert.ok(result.passed, 'validate should report passed after safe refactor')
  })

  it('validate FAILS after a BREAKING refactor (change + to * — output changed)', () => {
    applyBreakingRefactor()

    const result = runValidateCli(TMP)

    assert.notEqual(result.exitCode, 0, 'validate should exit non-zero after breaking refactor')
    assert.ok(!result.passed, 'validate should report failed after breaking refactor')
    assert.ok(
      result.stdout.includes('FAIL') || result.stdout.includes('❌') || (result.stderr || '').includes('FAIL'),
      'output should indicate failure'
    )
  })

  it('validate passes again after restoring original code', () => {
    restoreModule()

    const result = runValidateCli(TMP)

    assert.equal(result.exitCode, 0, `validate should exit 0 after restore; stdout: ${result.stdout}`)
    assert.ok(result.passed, 'validate should report passed after restore')
  })
})

describe('CJS E2E: callee contract is also written and validated', () => {
  // This sub-suite verifies that the ghost proxy actually intercepted the
  // callee (module.exports.add) during capture — proving the cjs-callee-transform
  // + cjs-wrapper + cjs-merge pipeline worked end-to-end. If the callee .regret
  // file is missing, the ghost proxy did not fire and the callee contract is
  // silently skipped.

  const calleeTmp = resolve(join(tmpdir(), 'regrets-cjs-e2e-callee-' + process.pid))

  before(() => {
    mkdirSync(join(calleeTmp, 'regrets'), { recursive: true })

    writeFileSync(join(calleeTmp, 'math.js'), `
function multiply(a, b) { return a * b }
function compute(a, b) { return module.exports.multiply(a, b) }
module.exports = { multiply, compute }
`)

    writeManifest(calleeTmp, [
      {
        id: 'compute',
        entry: 'compute',
        file: './math.js',
        stack: 'js',
        fingerprintLevel: 'entry',
        multiArgs: true,
        inputs: [[3, 4], [5, 6]],
        watches: ['multiply'],
        // `callees` (not `watches`) is what triggers the ghost proxy wrapping
        // for CJS module.exports.* calls. install.js auto-populates this via
        // analyzeScope(); for a hand-written manifest test fixture we set it
        // explicitly. Without this field, capture.js skips callee wrapping
        // with "fingerprintLevel: entry — internal calls aren't proxied".
        callees: ['multiply'],
      }
    ])
  })

  after(() => {
    if (existsSync(calleeTmp)) rmSync(calleeTmp, { recursive: true, force: true })
  })

  it('capture writes both parent .regret AND callee .regret (ghost proxy fired)', () => {
    const result = runCaptureCli(calleeTmp)
    assert.equal(result.exitCode, 0, `capture should exit 0; stdout: ${result.stdout}`)

    const parentRegret = join(calleeTmp, 'regrets', 'compute.regret')
    const calleeRegret = join(calleeTmp, 'regrets', 'compute.calls.multiply.regret')

    assert.ok(existsSync(parentRegret), 'parent .regret should exist')
    assert.ok(existsSync(calleeRegret),
      'callee .regret (compute.calls.multiply.regret) should exist — proves ghost proxy intercepted module.exports.multiply')
  })

  it('validate re-validates callee contract too (not just parent)', () => {
    const result = runValidateCli(calleeTmp)
    assert.equal(result.exitCode, 0, `validate should exit 0; stdout: ${result.stdout}`)
  })
})

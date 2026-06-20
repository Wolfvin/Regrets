// tests/issue-299-callee-esm-transform.test.js
// Closes #299: validate.js's runCalleeContract must apply the same ESM
// source transform as capture.js when the callee function is NOT directly
// exported. Without the transform, validate.js produces a false FAIL for
// non-exported top-level function callees (a pattern capture.js handles
// fine via __regretsHolder).
//
// Setup:
//   api.mjs exports only `main`, but `add` is a non-exported top-level
//   function_declaration that main() calls. capture.js applies the ESM
//   transform → __regretsHolder.add = add; export { __regretsHolder };
//   → wrapCallees intercepts add() calls → writes main.calls.add.regret.
//
// Pre-fix: validate.js's runCalleeContract imports the ORIGINAL api.mjs
//   (no transform), does mod['add'] → undefined → "callee not found" FAIL.
// Post-fix: runCalleeContract falls back to applying the ESM transform,
//   loads the transformed temp file, looks up add via __regretsHolder.add,
//   re-runs the callee, computes the live hash, compares to golden → PASS.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')

const TMP = resolve(join(process.cwd(), 'tests', `__issue299_${process.pid}__`))

function setupProject(apiSource) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), apiSource)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['add'],
      },
    ],
  }, null, 2))
}

function runCapture(cwd) {
  const result = spawnSync('node', [CAPTURE_JS], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runValidate(cwd, args = []) {
  const result = spawnSync('node', [VALIDATE_JS, ...args], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('Issue #299 — runCalleeContract applies ESM transform for non-exported callees', () => {
  // `add` is NOT exported — only `main` is. capture.js handles this via
  // the ESM transform (rewrites add(x,1) → __regretsHolder.add(x,1) and
  // exports __regretsHolder so wrapCallees can install a proxy). Without
  // the #299 fix, validate.js fails because mod['add'] is undefined.
  const nonExportedCalleeApi = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main }
`

  before(() => setupProject(nonExportedCalleeApi))
  after(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) })

  it('capture succeeds and writes main.calls.add.regret', () => {
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
    assert.ok(existsSync(join(TMP, 'regrets', 'main.calls.add.regret')),
      'main.calls.add.regret should exist after capture')
  })

  it('validate re-runs the non-exported callee via ESM transform → PASS (not false FAIL)', () => {
    const result = runValidate(TMP)
    assert.equal(result.exitCode, 0,
      `expected exit 0 (nothing changed), got ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

    // The callee contract should PASS — capture.js's transform exposed
    // `add` via __regretsHolder, and validate.js (post-fix) applies the
    // same transform so it can find and re-run `add`.
    assert.match(result.stdout, /main\.calls\.add.*PASS \(callee\)/,
      `main.calls.add should PASS (callee); got:\n${result.stdout}`)

    // Summary line should mention callee contract verification.
    assert.match(result.stdout, /callee contract.*verified/,
      `summary should mention callee contract verification; got:\n${result.stdout}`)

    // The pre-fix bug surfaced as "callee not found (or not a function)"
    // — make sure that error message is NOT present.
    assert.doesNotMatch(result.stdout, /main\.calls\.add.*not found.*not a function/i,
      `should NOT report "not found (or not a function)" for non-exported callee; got:\n${result.stdout}`)
  })

  it('detects real callee regression (mutated add) → callee FAIL, exit 1', () => {
    // Sanity check: the re-validation is REAL, not a no-op. Mutate add()
    // to subtract — the callee contract's fingerprint changes.
    writeFileSync(join(TMP, 'api.mjs'), `
function add(a, b) { return a - b }
function main(x) { return add(x, 1) }
export { main }
`)

    const result = runValidate(TMP)
    assert.equal(result.exitCode, 1,
      `expected exit 1 on callee regression, got ${result.exitCode}\nstdout:\n${result.stdout}`)

    assert.match(result.stdout, /main\.calls\.add.*FAIL \(callee\)/,
      `main.calls.add should FAIL after mutation; got:\n${result.stdout}`)
  })

  it('--skip-callees bypasses the re-validation phase entirely', () => {
    // Restore the original add() so the parent cluster passes.
    writeFileSync(join(TMP, 'api.mjs'), nonExportedCalleeApi)

    const result = runValidate(TMP, ['--skip-callees'])
    assert.equal(result.exitCode, 0,
      `expected exit 0 with --skip-callees, got ${result.exitCode}\nstdout:\n${result.stdout}`)

    // Should NOT mention callee contracts at all.
    assert.doesNotMatch(result.stdout, /callee contract/i,
      `should not mention callee contracts with --skip-callees; got:\n${result.stdout}`)
  })
})

describe('Issue #299 — exported callees still work (no regression)', () => {
  // Sanity check: the transform fallback is ONLY triggered when the direct
  // lookup fails. For normally-exported callees (the common case), the
  // direct path should still work without invoking the transform.
  const exportedCalleeApi = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }
`

  before(() => setupProject(exportedCalleeApi))
  after(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) })

  it('capture + validate works for exported callee (regression check)', () => {
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)

    const result = runValidate(TMP)
    assert.equal(result.exitCode, 0,
      `expected exit 0, got ${result.exitCode}\nstdout:\n${result.stdout}`)
    assert.match(result.stdout, /main\.calls\.add.*PASS \(callee\)/,
      `main.calls.add should PASS (callee); got:\n${result.stdout}`)
  })
})

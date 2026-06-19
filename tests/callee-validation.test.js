// tests/callee-validation.test.js — Callee contract re-validation in validate.js
//
// Verifies that `regret validate` re-runs each `.calls.*` callee contract
// against the live callee function and reports PASS/FAIL — closing the gap
// where callee regressions were previously silently skipped.
//
// Contract:
//   - Default behavior: callee contracts are re-validated; summary line
//     reports the count of verified callee contracts.
//   - --skip-callees: callee re-validation is disabled; summary line does
//     NOT mention callee contracts.
//   - --verbose: skipped clusters (the `.calls.*` files in the main loop)
//     are printed with reason `[skipped: callee contract — not in manifest]`.
//   - Callee that changed behavior → validate reports FAIL and exits 1.
//   - --cluster filter: callee phase does not run (single-cluster mode).
//   - Parent cluster not in manifest → callee is skipped with a warning,
//     NOT counted as a failure.
//
// Run: node --test tests/callee-validation.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')

// ─── Helpers ────────────────────────────────────────────────────────────────

const TMP = resolve(join(process.cwd(), 'tests', `__callee_val_${process.pid}__`))

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
        callees: ['add', 'mul'],
      },
    ],
  }, null, 2))
}

function rewriteApi(apiSource) {
  writeFileSync(join(TMP, 'api.mjs'), apiSource)
}

function rewriteManifest(manifest) {
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))
}

function runCli(cwd, args = []) {
  const result = spawnSync('node', [VALIDATE_JS, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function runCapture(cwd) {
  const result = spawnSync('node', [CAPTURE_JS], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Callee re-validation: default behavior', () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`

  before(() => {
    setupProject(originalApi)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('re-validates callee contracts when nothing changed — all PASS, exit 0', () => {
    const result = runCli(TMP)
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    // Summary line should mention "callee contracts verified"
    assert.match(
      result.stdout,
      /All 1 tests passed, 2 callee contracts verified/,
      `summary should report 2 callee contracts verified; got:\n${result.stdout}`
    )

    // Per-callee PASS lines should appear
    assert.match(result.stdout, /main\.calls\.add.*PASS \(callee\)/, 'should report main.calls.add PASS')
    assert.match(result.stdout, /main\.calls\.mul.*PASS \(callee\)/, 'should report main.calls.mul PASS')
  })

  it('detects callee regression — modified add() → callee FAIL, exit 1', () => {
    // Mutate add() to subtract instead of add — same parent signature would
    // also fail, but the point is the callee contract independently fails.
    rewriteApi(`
function add(a, b) { return a - b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`)

    const result = runCli(TMP)
    assert.equal(result.exitCode, 1, `expected exit 1 on callee regression, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Both parent and callee should fail
    assert.match(result.stdout, /main\.calls\.add.*FAIL \(callee\)/, 'should report main.calls.add FAIL')
    // mul callee should still pass (we didn't change it)
    assert.match(result.stdout, /main\.calls\.mul.*PASS \(callee\)/, 'should still report main.calls.mul PASS')

    // Summary should mention callee contract failed
    assert.match(
      result.stdout,
      /1 callee contract failed/,
      `summary should report 1 callee contract failed; got:\n${result.stdout}`
    )

    // Failure detail block should list the callee id with [callee] tag
    assert.match(result.stdout, /•\s+main\.calls\.add\s+\[callee\]/, 'failure detail should list main.calls.add as [callee]')
  })

  it('detects callee removed from module — callee FAIL with "not found" error', () => {
    // Remove the add() function entirely. The parent cluster will also fail
    // (ReferenceError on call), but the callee contract should fail with
    // a clear "not found" message rather than crashing the validator.
    rewriteApi(`
function mul(a, b) { return a * b }
function main(x) { return mul(x, 2) }
export { main, mul }
`)

    const result = runCli(TMP)
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // main.calls.add should FAIL with "not found" — NOT a crash
    assert.match(
      result.stdout,
      /main\.calls\.add.*FAIL/,
      'main.calls.add should FAIL (function removed)'
    )
    assert.ok(
      !result.stdout.includes('TypeError: entryFn is not a function'),
      'validator should NOT crash with raw TypeError — should report a clean FAIL'
    )
    // main.calls.mul should still pass (function still exists)
    assert.match(result.stdout, /main\.calls\.mul.*PASS \(callee\)/, 'main.calls.mul should still PASS')
  })

  it('detects callee that now throws when it previously did not — expectThrow violated', () => {
    // Restore add() first to get a clean state, then make it throw.
    rewriteApi(`
function add(a, b) { throw new Error('boom') }
function mul(a, b) { return a * b }
function main(x) { return mul(x, 2) }
export { main, add, mul }
`)

    const result = runCli(TMP)
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Callee should FAIL with expectThrow violation message
    assert.match(
      result.stdout,
      /main\.calls\.add.*expectThrow violated.*unexpected throw/,
      'should report expectThrow violated for add()'
    )
  })
})

describe('Callee re-validation: --skip-callees flag', () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`

  before(() => {
    setupProject(originalApi)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('--skip-callees disables callee re-validation — summary omits callee count', () => {
    const result = runCli(TMP, ['--skip-callees'])
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Summary should NOT mention callee contracts
    assert.doesNotMatch(
      result.stdout,
      /callee contract/i,
      `summary should NOT mention callee contracts with --skip-callees; got:\n${result.stdout}`
    )

    // No "Re-validating N callee contract(s)" line should appear
    assert.doesNotMatch(
      result.stdout,
      /Re-validating \d+ callee contract/,
      'should not print the callee re-validation header'
    )
  })

  it('--skip-callees with broken callee — only parent cluster fails, callee not checked', () => {
    rewriteApi(`
function add(a, b) { return a - b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`)

    const result = runCli(TMP, ['--skip-callees'])
    assert.equal(result.exitCode, 1, `expected exit 1 (parent cluster fails), got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Parent cluster should still fail (its fingerprint changed)
    assert.match(result.stdout, /main.*FAIL/, 'parent cluster main should still FAIL')

    // No callee PASS/FAIL output should appear
    assert.doesNotMatch(
      result.stdout,
      /main\.calls\.add.*PASS \(callee\)|main\.calls\.add.*FAIL \(callee\)/,
      'should not print any callee PASS/FAIL line with --skip-callees'
    )
  })
})

describe('Callee re-validation: --verbose prints skipped clusters', () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`

  before(() => {
    setupProject(originalApi)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('--verbose prints each skipped .calls.* cluster with reason', () => {
    const result = runCli(TMP, ['--verbose'])
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Both callee clusters should be reported as skipped in the main loop
    assert.match(
      result.stdout,
      /⏭\s+main\.calls\.add\s+\[skipped: callee contract — not in manifest\]/,
      'should print skipped message for main.calls.add'
    )
    assert.match(
      result.stdout,
      /⏭\s+main\.calls\.mul\s+\[skipped: callee contract — not in manifest\]/,
      'should print skipped message for main.calls.mul'
    )

    // The skipped message should explain WHY (not just the id)
    assert.match(
      result.stdout,
      /\[skipped: callee contract — not in manifest\]/,
      'skipped message should include the reason "callee contract — not in manifest"'
    )
  })

  it('without --verbose, skipped clusters are NOT printed (default behavior preserved)', () => {
    const result = runCli(TMP)
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // The ⏭ skipped line should NOT appear in the main loop section
    // (callee re-validation results still appear later, but the "skipped" line
    // from the main loop should be suppressed without --verbose).
    assert.doesNotMatch(
      result.stdout,
      /⏭\s+main\.calls\.add\s+\[skipped: callee contract — not in manifest\]/,
      'should NOT print skipped message without --verbose'
    )
  })
})

describe('Callee re-validation: edge cases', () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`

  before(() => {
    setupProject(originalApi)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('--cluster filter skips callee phase entirely', () => {
    const result = runCli(TMP, ['--cluster', 'main'])
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // No callee phase should run when --cluster is set
    assert.doesNotMatch(
      result.stdout,
      /Re-validating \d+ callee contract/,
      'should NOT run callee phase with --cluster filter'
    )
    assert.doesNotMatch(
      result.stdout,
      /callee contract/i,
      'should NOT mention callee contracts with --cluster filter'
    )
  })

  it('orphan callee (parent not in manifest) — skipped with warning, NOT a failure', () => {
    // Remove main from manifest but keep the .regret files.
    rewriteManifest({ clusters: [] })

    const result = runCli(TMP)
    // Exit code should be 0 because nothing actively failed — orphan callees
    // are skipped with a warning, not treated as failures (the user may be
    // in the middle of refactoring the manifest).
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Should warn about orphan callees
    assert.match(
      result.stdout,
      /main\.calls\.add.*parent "main" not in manifest — skipping/,
      'should warn about orphan callee main.calls.add'
    )
    assert.match(
      result.stdout,
      /main\.calls\.mul.*parent "main" not in manifest — skipping/,
      'should warn about orphan callee main.calls.mul'
    )

    // Summary should NOT claim "callee contracts verified" — they were skipped
    assert.doesNotMatch(
      result.stdout,
      /callee contract.*verified/,
      'should not claim callees verified when they were all skipped'
    )
  })

  it('JSON output includes callee results as a separate "callees" field', () => {
    // Restore manifest for this test
    rewriteManifest({
      clusters: [
        {
          id: 'main',
          entry: 'main',
          file: './api.mjs',
          stack: 'js',
          fingerprintLevel: 'entry',
          inputs: [5],
          watches: [],
          callees: ['add', 'mul'],
        },
      ],
    })
    // Restore api too
    rewriteApi(originalApi)

    const result = runCli(TMP, ['--json'])
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const json = JSON.parse(result.stdout)
    assert.ok(json.callees, 'JSON output should have a "callees" field')
    assert.equal(json.callees.passed, 2, 'callees.passed should be 2')
    assert.equal(json.callees.failed, 0, 'callees.failed should be 0')
    assert.equal(json.callees.considered, 2, 'callees.considered should be 2')
    assert.equal(json.callees.contracts.length, 2, 'should have 2 callee contract entries')

    const addContract = json.callees.contracts.find(c => c.id === 'main.calls.add')
    assert.ok(addContract, 'should have main.calls.add contract')
    assert.equal(addContract.status, 'pass', 'main.calls.add should be pass')
  })

  it('JSON output reports callee failures with status="fail" and exit 1', () => {
    rewriteApi(`
function add(a, b) { return a - b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`)

    const result = runCli(TMP, ['--json'])
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}`)

    const json = JSON.parse(result.stdout)
    assert.equal(json.callees.failed, 1, 'callees.failed should be 1')
    assert.equal(json.callees.passed, 1, 'callees.passed should be 1 (mul still passes)')

    const addContract = json.callees.contracts.find(c => c.id === 'main.calls.add')
    assert.equal(addContract.status, 'fail', 'main.calls.add should be fail')
    assert.ok(addContract.expected, 'fail entry should have expected hash')
    assert.ok(addContract.actual, 'fail entry should have actual hash')
    assert.notEqual(addContract.expected, addContract.actual, 'expected and actual hashes should differ')
  })
})

// ─── Programmatic API test (runCalleeContract) ─────────────────────────────

describe('runCalleeContract (programmatic API)', () => {
  it('is exported and callable directly for testing/tools', async () => {
    const mod = await import('../scripts/validate.js')
    assert.equal(typeof mod.runCalleeContract, 'function', 'runCalleeContract should be exported')

    // Minimal smoke test — calling with a fake regret + parent def should
    // return a structured result (not throw). We use a minimal in-memory
    // setup that doesn't require fixture files.
    const fakeCalleeRegret = {
      entry: 'nonExistent',
      input: [1, 2],
      goldenHash: 'xxxxxxx',
      threw: false,
    }
    const fakeParentDef = {
      id: 'fake-parent',
      file: './non-existent-file.mjs',
      stack: 'js',
    }
    const result = await mod.runCalleeContract(fakeCalleeRegret, fakeParentDef, {})
    assert.equal(result.pass, false, 'should return pass=false for missing file')
    assert.ok(result.error, 'should return an error message')
    assert.match(result.error, /not found/i, 'error should mention file not found')
  })
})

// ─── "Only callee fails" — fingerprintLevel: "calls" ──────────────────────
//
// When the parent cluster uses `fingerprintLevel: "calls"`, its fingerprint
// is based on call counts (which functions were called and how many times),
// NOT on the return values of those calls. This means a callee can change
// its return value without affecting the parent's fingerprint — the parent
// still PASSes while the callee FAILs. This is the exact "only callee fails"
// scenario from the spec:
//   "❌ 1 callee contract failed: main.calls.add"

describe('Callee re-validation: only-callee-fails scenario (fingerprintLevel: "calls")', () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`

  before(() => {
    // Use fingerprintLevel: "calls" so main's fingerprint is based on
    // call counts, not return values. This lets us change add()'s return
    // value without affecting main's fingerprint.
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'api.mjs'), originalApi)
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [
        {
          id: 'main',
          entry: 'main',
          file: './api.mjs',
          stack: 'js',
          fingerprintLevel: 'calls',
          inputs: [5],
          watches: ['add', 'mul'],
          callees: ['add', 'mul'],
        },
      ],
    }, null, 2))
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('parent PASSes (call counts unchanged) but callee FAILs (return value changed)', () => {
    // Change add() to subtract — main still calls add() once and mul() once,
    // so main's "calls" fingerprint is unchanged → main PASSes.
    // But add()'s callee contract fingerprint changes (return value 6 → 4)
    // → main.calls.add FAILs.
    rewriteApi(`
function add(a, b) { return a - b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`)

    const result = runCli(TMP)
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Parent cluster should PASS (call counts unchanged)
    assert.match(result.stdout, /main.*PASS/, 'parent cluster main should PASS (call counts unchanged)')

    // Callee add should FAIL
    assert.match(result.stdout, /main\.calls\.add.*FAIL \(callee\)/, 'main.calls.add should FAIL')

    // Callee mul should still PASS (unchanged)
    assert.match(result.stdout, /main\.calls\.mul.*PASS \(callee\)/, 'main.calls.mul should still PASS')

    // Summary line should use the spec's "only callee fails" format:
    //   "❌ 1 callee contract failed: main.calls.add"
    assert.match(
      result.stdout,
      /❌ 1 callee contract failed: main\.calls\.add/,
      `summary should use the "only callee fails" format with the failing id; got:\n${result.stdout}`
    )
  })
})

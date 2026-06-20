// tests/capture-ghost-fixes.test.js — Tests for issues #295, #298, #300, #301, #261
//
// Covers fixes in scripts/capture.js and scripts/ghost.js:
//   #295 — capture.js imports HOLDER_NAME but never used → now passed to wrapCallees
//   #298 — callee contract saves only first call → now saves all unique calls (CALLS line)
//   #300 — capture.js writes INPUT null when actual is undefined → now writes "undefined"
//   #301 — misleading "declared but never called" for ESM imported bindings → specific warning
//   #261 — capture.js crashes when manifest cluster omits "watches" → defaults to []
//
// Run: node --test tests/capture-ghost-fixes.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(label) {
  const dir = resolve(join(process.cwd(), 'tests', `__fix_${label}_${process.pid}__`))
  mkdirSync(join(dir, 'regrets'), { recursive: true })
  return dir
}

function writeManifest(tmpDir, clusters) {
  writeFileSync(
    join(tmpDir, 'regrets', 'manifest.json'),
    JSON.stringify({ clusters }, null, 2)
  )
}

function writeFile(tmpDir, name, content) {
  writeFileSync(join(tmpDir, name), content)
}

function runCaptureCli(cwd, args = []) {
  const result = spawnSync('node', [CAPTURE_JS, ...args], {
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

function runValidateCli(cwd, args = []) {
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

function readRegret(tmpDir, name) {
  const path = join(tmpDir, 'regrets', `${name}.regret`)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

// ─── #261: missing "watches" field no longer crashes capture ─────────────

describe('#261: capture.js defaults missing "watches" to [] (no crash)', () => {
  const tmpDir = makeTmpDir('watches_missing')

  before(() => {
    // CJS module with module.exports.foo calls — same fixture as issue #261.
    writeFile(tmpDir, 'math.cjs', `
function add(a, b) { return a + b }
function main(a, b) { return module.exports.add(a, b) }
module.exports = { add, main }
`)
    // Manifest WITHOUT the "watches" field — this used to crash.
    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './math.cjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        multiArgs: true,
        inputs: [[3, 4]],
        callees: ['add'],
        // NOTE: no "watches" field — issue #261
      },
    ])
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('capture exits 0 (no TypeError)', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0,
      `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.ok(!result.stderr.includes('TypeError'),
      `stderr should not contain TypeError; got: ${result.stderr}`)
  })

  it('main.regret is written with empty watches: []', () => {
    const regret = readRegret(tmpDir, 'main')
    assert.ok(regret, 'main.regret should be written')
    assert.match(regret, /^watches: \[\]/m,
      `watches line should be empty array; got:\n${regret}`)
  })

  it('callee .regret is also written (callees still work without watches)', () => {
    const calleeRegret = readRegret(tmpDir, 'main.calls.add')
    assert.ok(calleeRegret, 'main.calls.add.regret should be written')
  })
})

// ─── #300: INPUT undefined is preserved (not coerced to null) ────────────

describe('#300: capture writes INPUT undefined (not null) when input is undefined', () => {
  const tmpDir = makeTmpDir('undefined_input')

  before(() => {
    // ESM module with a zero-arg entry — `inputs: []` makes capture pass
    // `undefined` as the single input.
    writeFile(tmpDir, 'api.mjs', `
function getVersion() { return '1.0.0' }
export { getVersion }
`)
    writeManifest(tmpDir, [
      {
        id: 'getVersion',
        entry: 'getVersion',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [],
        watches: [],
      },
    ])
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('capture writes "INPUT  undefined" (literal string)', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0,
      `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regret = readRegret(tmpDir, 'getVersion')
    assert.ok(regret, 'getVersion.regret should be written')
    assert.match(regret, /^INPUT  undefined$/m,
      `INPUT line should be the literal string "undefined" (not "null"); got:\n${regret}`)
  })

  it('validate PASSES immediately after capture (no code change) — fingerprint matches', () => {
    // This is the core regression test for #300: previously, capture wrote
    // `INPUT null` but computed the golden hash with `undefined`, so validate
    // (which read `null` back) computed a different hash and ALWAYS FAILED.
    const result = runValidateCli(tmpDir)
    assert.equal(result.exitCode, 0,
      `validate should exit 0 (no code change)\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /All 1 tests? passed/,
      `validate should report success; got:\n${result.stdout}`)
  })
})

// ─── #295: HOLDER_NAME is passed to wrapCallees (ESM callee still works) ─

describe('#295: HOLDER_NAME import is used (passed to wrapCallees)', () => {
  // We can't directly observe the option being passed without instrumenting
  // wrapCallees, but we CAN verify the END-TO-END behavior that #295's
  // "Preferred" fix protects: an ESM bare-name callee is correctly
  // intercepted (which requires the holder name to match between the
  // transformer and wrapCallees). If HOLDER_NAME were not passed and the
  // default diverged, this test would fail (no callee .regret written).

  const tmpDir = makeTmpDir('holder_name')

  before(() => {
    writeFile(tmpDir, 'api.mjs', `
function helper(x) { return x * 2 }
function main(x) { return helper(x) + 1 }
export { main, helper }
`)
    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['helper'],
      },
    ])
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('capture intercepts the ESM callee and writes main.calls.helper.regret', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0,
      `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const calleeRegret = readRegret(tmpDir, 'main.calls.helper')
    assert.ok(calleeRegret, 'main.calls.helper.regret should be written (holder name invariant holds)')
  })

  it('source code is unchanged (no in-place modification)', () => {
    const src = readFileSync(join(tmpDir, 'api.mjs'), 'utf8')
    assert.ok(!src.includes('__regretsHolder'),
      'original source should NOT contain __regretsHolder (transform is in-memory only)')
  })
})

// ─── #298: callee contract records ALL unique calls ─────────────────────

describe('#298: callee contract records all unique calls (CALLS line)', () => {
  const tmpDir = makeTmpDir('multicall')

  // The exact reproduce from the issue: helper is called 4 times with the
  // SAME args ([5]), so the dedup produces 1 unique call. To exercise the
  // multi-call path we need DIFFERENT args. We use [5, -5] so the callee
  // sees both positive and negative inputs.
  const originalApi = `
function helper(x) { return x > 0 ? x * 2 : x * 3 }
function main(arr) { return helper(arr[0]) + helper(arr[1]) }
export { main, helper }
`

  before(() => {
    writeFile(tmpDir, 'api.mjs', originalApi)
    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [[5, -5]],
        watches: [],
        callees: ['helper'],
      },
    ])
    const cap = runCaptureCli(tmpDir)
    assert.equal(cap.exitCode, 0,
      `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('main.calls.helper.regret has a CALLS line with 2 unique entries', () => {
    const regret = readRegret(tmpDir, 'main.calls.helper')
    assert.ok(regret, 'callee .regret should be written')

    // The CALLS line should be present and contain a JSON array with 2
    // entries: {args:[5], result:10, ...} and {args:[-5], result:-15, ...}
    const callsLine = regret.split('\n').find(l => l.startsWith('CALLS '))
    assert.ok(callsLine, `CALLS line should be present; got:\n${regret}`)

    const callsPayload = JSON.parse(callsLine.replace(/^CALLS\s+/, ''))
    assert.equal(callsPayload.length, 2,
      `should have 2 unique calls; got ${callsPayload.length}`)

    // Each entry must have args, hash, threw
    for (const entry of callsPayload) {
      assert.ok(Array.isArray(entry.args), 'each entry should have args array')
      assert.equal(typeof entry.hash, 'string', 'each entry should have hash string')
      assert.equal(typeof entry.threw, 'boolean', 'each entry should have threw boolean')
    }

    // First call's hash should match the top-level HASH line (backward compat)
    const hashLine = regret.split('\n').find(l => l.startsWith('HASH   '))
    assert.ok(hashLine, 'HASH line should be present')
    const topHash = hashLine.replace(/^HASH\s+/, '').trim()
    assert.equal(callsPayload[0].hash, topHash,
      'first call hash should match top-level HASH (backward compat)')
  })

  it('validate PASSES when callee behavior is unchanged', () => {
    const result = runValidateCli(tmpDir)
    assert.equal(result.exitCode, 0,
      `validate should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /main\.calls\.helper.*PASS \(callee\)/,
      `callee should PASS; got:\n${result.stdout}`)
  })

  it('validate FAILs when callee behavior changes for the SECOND call\'s args', () => {
    // Refactor helper to break for negative input — the FIRST call (helper(5))
    // still returns 10, but the SECOND call (helper(-5)) now returns 999
    // instead of -15. Pre-#298, validate would PASS (only first call checked).
    // Post-#298, validate should FAIL on the second call.
    writeFile(tmpDir, 'api.mjs', `
function helper(x) { return x > 0 ? x * 2 : 999 }
function main(arr) { return helper(arr[0]) + helper(arr[1]) }
export { main, helper }
`)

    const result = runValidateCli(tmpDir)
    assert.notEqual(result.exitCode, 0,
      `validate should FAIL (callee regression on second call); got exit ${result.exitCode}\nstdout: ${result.stdout}`)

    // The callee should FAIL — either the parent also fails (because main's
    // output changed) or only the callee fails. Either way, the callee
    // contract must be reported as failed.
    assert.match(result.stdout, /main\.calls\.helper.*FAIL \(callee\)/,
      `main.calls.helper should FAIL; got:\n${result.stdout}`)

    // The multi-call failure detail should mention which args broke.
    // The output should include "Multi-call contract failures" and reference
    // call #2 (the second unique call with args [-5]).
    assert.match(result.stdout, /Multi-call contract failures/,
      `should mention multi-call failures; got:\n${result.stdout}`)
    assert.match(result.stdout, /call #2/,
      `should reference call #2 (the second unique call); got:\n${result.stdout}`)
  })

  it('single-call callee (called once) does NOT have a CALLS line (backward compat)', () => {
    // Restore original behavior and re-capture with a single-call setup.
    writeFile(tmpDir, 'api.mjs', originalApi)
    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [[5, 5]],  // both calls use same args → 1 unique call
        watches: [],
        callees: ['helper'],
      },
    ])
    const cap = runCaptureCli(tmpDir)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}`)

    const regret = readRegret(tmpDir, 'main.calls.helper')
    assert.ok(regret, 'callee .regret should be written')
    const callsLine = regret.split('\n').find(l => l.startsWith('CALLS '))
    assert.equal(callsLine, undefined,
      `CALLS line should NOT be present for single-call callee; got:\n${regret}`)
  })
})

// ─── #298: backward compat — old .regret without CALLS line still validates

describe('#298: backward compat — old .regret without CALLS line still validates', () => {
  const tmpDir = makeTmpDir('backward_compat')

  before(() => {
    writeFile(tmpDir, 'api.mjs', `
function helper(x) { return x * 2 }
function main(x) { return helper(x) + 1 }
export { main, helper }
`)
    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['helper'],
      },
    ])
    const cap = runCaptureCli(tmpDir)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}`)
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('manually removing the CALLS line still allows validate to pass (single-call fallback)', () => {
    // Simulate an old .regret file by removing the CALLS line if present.
    // (For single-call callees, no CALLS line is written anyway, so this
    // test just confirms the single-call fallback path works.)
    const result = runValidateCli(tmpDir)
    assert.equal(result.exitCode, 0,
      `validate should exit 0 (single-call fallback)\nstdout: ${result.stdout}`)
    assert.match(result.stdout, /main\.calls\.helper.*PASS \(callee\)/,
      `callee should PASS via single-call path; got:\n${result.stdout}`)
  })
})

// ─── #301: imported binding warning is specific, not "closure-private" ───

describe('#301: imported binding callees get a specific warning', () => {
  const tmpDir = makeTmpDir('imported_binding')

  before(() => {
    // ESM module that imports readFileSync from 'fs' and calls it.
    // readFileSync is NOT a top-level function_declaration in this file,
    // so the transformer can't rewrite it. wrapCallees can't find it on
    // the module namespace (ESM imported bindings aren't exposed as
    // properties). The callee IS being called (its effect is visible in
    // the output), but no .calls.readFileSync.regret will be written.
    writeFile(tmpDir, 'api.mjs', `
import { readFileSync } from 'fs'
function main(x) { return readFileSync(${JSON.stringify(join(tmpDir, 'data.txt'))}, 'utf8').length + x }
export { main }
`)
    writeFile(tmpDir, 'data.txt', 'test content\n')
    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['readFileSync'],
      },
    ])
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('capture still succeeds (parent cluster captured, readFileSync called normally)', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0,
      `capture should exit 0 (parent still captured)\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    // Parent .regret should be written — and the output should reflect that
    // readFileSync WAS called (file content length + 5).
    const regret = readRegret(tmpDir, 'main')
    assert.ok(regret, 'main.regret should be written')
    // "test content\n" is 13 chars, +5 = 18
    assert.match(regret, /^OUTPUT 18$/m,
      `output should be 18 (readFileSync WAS called); got:\n${regret}`)
  })

  it('capture emits a specific "imported binding" warning (NOT "closure-private")', () => {
    const result = runCaptureCli(tmpDir)
    const combined = result.stdout + result.stderr

    // Should mention "readFileSync" and indicate it's an imported binding.
    // The previous misleading message said "closure-private or not exported"
    // — that phrasing should NOT appear for imported bindings.
    assert.ok(combined.includes('readFileSync'),
      `warning should mention readFileSync; got: ${combined}`)

    // The specific imported-binding warning should fire.
    assert.match(combined, /imported binding/i,
      `warning should say "imported binding"; got: ${combined}`)

    // Should reference the source module ('fs') so the user knows where
    // the binding comes from.
    assert.ok(combined.includes('fs'),
      `warning should mention the source module 'fs'; got: ${combined}`)
  })

  it('NO main.calls.readFileSync.regret is written (callee cannot be intercepted)', () => {
    runCaptureCli(tmpDir) // ensure capture ran
    const calleeRegret = readRegret(tmpDir, 'main.calls.readFileSync')
    assert.equal(calleeRegret, null,
      'main.calls.readFileSync.regret should NOT be written (imported binding)')
  })
})

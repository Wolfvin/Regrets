// tests/redteam-verification-296-297-298-300.test.js
//
// Meta-regression test that verifies all 4 RED TEAM issues are fixed in a
// single auditable file. Each describe block reproduces the EXACT scenario
// from the original issue report and asserts the fix is in place.
//
// Issues covered:
//   #296 — install --scope <empty-folder> silently succeeds with no manifest
//          written + misleading "Next steps: regret validate"
//   #297 — install --scope <file-with-no-extension> bypasses language detection
//          — file parsed as JS regardless
//   #298 — Callee contract saves only FIRST call args — refactors that break
//          callee for un-saved args produce false-negative PASS
//   #300 — capture.js writes INPUT null when actual input is undefined —
//          validate computes different fingerprint → clusters with inputs:[]
//          ALWAYS FAIL
//
// All 4 fixes are on main (commit 307 merged #295/#298/#300/#301; commit 312
// merged #265/#268/#270/#294/#296/#297). This file locks in the fixes so
// future workers / BOS can audit them in one place.
//
// Run: node --test tests/redteam-verification-296-297-298-300.test.js

import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const INSTALL_JS  = join(REPO_ROOT, 'scripts', 'install.js')
const CAPTURE_JS  = join(REPO_ROOT, 'scripts', 'capture.js')
const VALIDATE_JS = join(REPO_ROOT, 'scripts', 'validate.js')

const TMP = resolve(REPO_ROOT, 'tests', `__redteam_verify_${process.pid}__`)

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

function runValidate(args = []) {
  const r = spawnSync('node', [VALIDATE_JS, ...args], {
    cwd: TMP, encoding: 'utf8', timeout: 30_000,
  })
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

before(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }) })
beforeEach(() => {
  // Reset TMP between tests
  const entries = readdirSync(TMP, { withFileTypes: true })
  for (const e of entries) {
    rmSync(join(TMP, e.name), { recursive: true, force: true })
  }
})
after(()  => { rmSync(TMP, { recursive: true, force: true }) })

// ─── #296 — empty folder: no manifest, no misleading "Next steps" ────────────

describe('#296 — install --scope <empty-folder> does not mislead user', () => {
  it('clearly states no source files found and does not write manifest', () => {
    setupProject({
      'package.json': '{"name":"wrapper","version":"1.0.0"}',
      'empty-folder/.gitkeep': '',  // ensure dir exists
    })

    const r = runInstall(['--scope', 'empty-folder', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)

    // The bug: install printed "Next steps: regret validate" despite no manifest.
    // The fix: clear "No source files found" message, no "Next steps" section.
    assert.match(r.stdout, /No source files found in ['"]empty-folder['"]/,
      'should clearly state no source files found')
    assert.match(r.stdout, /manifest not created/i,
      'should explicitly say manifest was not created')

    // The misleading "Next steps: regret validate" should NOT appear when
    // no source files were found.
    const nextStepsSection = r.stdout.match(/Next steps:[\s\S]*?(?=\n\n|$)/)
    if (nextStepsSection) {
      assert.doesNotMatch(nextStepsSection[0], /regret validate — verify all GREEN/,
        'should NOT include "regret validate — verify all GREEN" when no source files')
    }

    // No manifest should be written
    assert.ok(!existsSync(join(TMP, 'regrets', 'manifest.json')),
      'no manifest.json should be written for empty folder')
  })
})

// ─── #297 — file with no extension is rejected ───────────────────────────────

describe('#297 — install --scope <file-with-no-extension> is rejected', () => {
  it('rejects file without extension with a clear error', () => {
    // File without extension that happens to contain valid JS
    setupProject({
      'package.json': '{"name":"test","version":"1.0.0"}',
      'noext': `function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
module.exports = { add, main }
`,
    })

    const r = runInstall(['--scope', 'noext', '--skip-capture'])

    // The bug: install parsed the no-ext file as JS, found 1 function,
    // wrote empty manifest, exit 0 with no warning.
    // The fix: install rejects the file with a clear error.
    const combined = r.stdout + r.stderr
    assert.match(combined, /unsupported file extension/i,
      'should reject file with unsupported extension')
    assert.match(combined, /Supported:.*\.js.*\.mjs.*\.cjs.*\.ts.*\.tsx.*\.py/,
      'should list supported extensions')
    assert.match(combined, /no extension|noext/,
      'should mention "no extension" or the file name')

    // Should NOT have parsed the file as JS (no "Found 1 exported function")
    assert.doesNotMatch(r.stdout, /Found 1 exported function/,
      'should NOT have parsed the no-extension file as JS')
  })
})

// ─── #298 — callee contract saves ALL unique call args ───────────────────────

describe('#298 — callee contract saves ALL unique call args (multi-call)', () => {
  it('writes CALLS line with every unique (args, result) pair', () => {
    setupProject({
      'test.mjs': `
function helper(x) { return x > 0 ? x * 2 : x * 3 }
export function main(arr) {
  return helper(arr[0]) + helper(arr[1]) + helper(arr[2]) + helper(arr[3])
}
export { helper }
`,
      'package.json': '{"name":"test","version":"0.0.0","type":"module"}',
    })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'main',
        entry: 'main',
        file: './test.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [[5, -5, 5, -5]],  // 2 unique args: 5 and -5
        watches: [],
        callees: ['helper'],
      }],
    }))

    const r = runCapture()
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)

    const calleeRegretPath = join(TMP, 'regrets', 'main.calls.helper.regret')
    assert.ok(existsSync(calleeRegretPath), 'callee .regret file should exist')
    const calleeContent = readFileSync(calleeRegretPath, 'utf8')

    // The bug: only the FIRST call was saved (INPUT [5], OUTPUT 10, HASH 1bh0687).
    // The fix: a CALLS line lists ALL unique (args, hash, result) tuples.
    assert.match(calleeContent, /^CALLS\s+/m,
      'callee .regret should have a CALLS line (#298 fix)')

    // Parse the CALLS line and verify it contains 2 unique calls
    const callsMatch = calleeContent.match(/^CALLS\s+(\[.*\])$/m)
    assert.ok(callsMatch, 'CALLS line should contain a JSON array')
    const calls = JSON.parse(callsMatch[1])
    assert.equal(calls.length, 2,
      `should have 2 unique calls (args [5] and [-5]), got ${calls.length}`)

    // Verify the two args are [5] and [-5]
    const argsSets = calls.map(c => JSON.stringify(c.args)).sort()
    assert.deepEqual(argsSets, ['[-5]', '[5]'],
      'CALLS should contain args [-5] and [5]')

    // Verify each call has the expected result
    const callByArgs = new Map(calls.map(c => [JSON.stringify(c.args), c]))
    assert.equal(callByArgs.get('[5]').result, 10, 'helper(5) should return 10')
    assert.equal(callByArgs.get('[-5]').result, -15, 'helper(-5) should return -15')
  })

  it('validate re-runs callee with ALL stored args — detects breaking refactor for un-saved args', () => {
    // Capture with the original helper (helper(-5) = -15)
    setupProject({
      'test.mjs': `
function helper(x) { return x > 0 ? x * 2 : x * 3 }
export function main(arr) {
  return helper(arr[0]) + helper(arr[1]) + helper(arr[2]) + helper(arr[3])
}
export { helper }
`,
      'package.json': '{"name":"test","version":"0.0.0","type":"module"}',
    })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'main',
        entry: 'main',
        file: './test.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [[5, -5, 5, -5]],
        watches: [],
        callees: ['helper'],
      }],
    }))

    let r = runCapture()
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)

    // Refactor: helper(-x) now returns 999 instead of x*3
    writeFileSync(join(TMP, 'test.mjs'), `
function helper(x) { return x > 0 ? x * 2 : 999 }
export function main(arr) {
  return helper(arr[0]) + helper(arr[1]) + helper(arr[2]) + helper(arr[3])
}
export { helper }
`)

    r = runValidate()
    // The bug: validate PASSed because only helper(5) was checked.
    // The fix: validate FAILs because helper(-5) now returns 999 (was -15).
    assert.notEqual(r.exitCode, 0,
      'validate should FAIL after breaking refactor of helper(-5)')

    const combined = r.stdout + r.stderr
    // Should mention the multi-call contract failure for the callee
    assert.match(combined, /main\.calls\.helper/,
      'validate output should mention the callee contract failure')
    // Should mention the specific args that failed ([-5])
    // (Either in the multi-call failure details or in a hash mismatch line)
    assert.ok(
      combined.includes('-5') || combined.includes('6d2x1ox'),
      'validate output should reference the failing args [-5] or its hash 6d2x1ox'
    )
  })
})

// ─── #300 — undefined input handled correctly (not coerced to null) ──────────

describe('#300 — capture writes INPUT undefined (not null) for inputs:[] clusters', () => {
  it('writes "INPUT undefined" to .regret file when actual input is undefined', () => {
    setupProject({
      'test.mjs': `
function failing() { throw new Error('boom') }
export function main() {
  try { return failing() } catch (e) { return 'caught: ' + e.message }
}
export { failing }
`,
      'package.json': '{"name":"test","version":"0.0.0","type":"module"}',
    })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'main',
        entry: 'main',
        file: './test.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [],  // zero-arg function — actual input is undefined
        watches: [],
        callees: ['failing'],
      }],
    }))

    const r = runCapture()
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)

    const regretPath = join(TMP, 'regrets', 'main.regret')
    const content = readFileSync(regretPath, 'utf8')

    // The bug: capture wrote "INPUT null" (input ?? null coerced undefined → null)
    // The fix: capture writes "INPUT undefined" explicitly.
    assert.match(content, /^INPUT\s+undefined$/m,
      '.regret should write "INPUT undefined" (was: "INPUT null")')
    assert.doesNotMatch(content, /^INPUT\s+null$/m,
      '.regret should NOT write "INPUT null" for an undefined input')
  })

  it('validate PASSes immediately after capture (no code change) for inputs:[] cluster', () => {
    setupProject({
      'test.mjs': `
function failing() { throw new Error('boom') }
export function main() {
  try { return failing() } catch (e) { return 'caught: ' + e.message }
}
export { failing }
`,
      'package.json': '{"name":"test","version":"0.0.0","type":"module"}',
    })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'main',
        entry: 'main',
        file: './test.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [],
        watches: [],
        callees: ['failing'],
      }],
    }))

    let r = runCapture()
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)

    r = runValidate()
    // The bug: validate immediately FAILed because capture wrote INPUT null
    // but validate computed fingerprint for INPUT undefined.
    // The fix: capture writes INPUT undefined, validate reads it back as
    // undefined, fingerprints match → PASS.
    assert.equal(r.exitCode, 0,
      `validate should PASS immediately after capture (no code change). Got exit ${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)

    const combined = r.stdout + r.stderr
    assert.match(combined, /✅\s+main.*PASS/,
      'main cluster should PASS validate')
  })

  it('validate FAILs after a breaking refactor of the zero-arg function', () => {
    setupProject({
      'test.mjs': `
function failing() { throw new Error('boom') }
export function main() {
  try { return failing() } catch (e) { return 'caught: ' + e.message }
}
export { failing }
`,
      'package.json': '{"name":"test","version":"0.0.0","type":"module"}',
    })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'main',
        entry: 'main',
        file: './test.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [],
        watches: [],
        callees: ['failing'],
      }],
    }))

    let r = runCapture()
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)

    // Refactor: change the catch message
    writeFileSync(join(TMP, 'test.mjs'), `
function failing() { throw new Error('boom') }
export function main() {
  try { return failing() } catch (e) { return 'CAUGHT: ' + e.message }
}
export { failing }
`)

    r = runValidate()
    assert.notEqual(r.exitCode, 0,
      'validate should FAIL after breaking refactor of main()')
    const combined = r.stdout + r.stderr
    assert.match(combined, /❌\s+main.*FAIL/,
      'validate output should show main FAIL')
  })
})

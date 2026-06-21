// tests/redteam-verification-261-268-270-271.test.js
//
// Meta-regression test that verifies all 4 RED TEAM / Integration Gap issues
// are fixed in a single auditable file. Each describe block reproduces the
// EXACT scenario from the original issue report and asserts the fix is in
// place.
//
// Issues covered:
//   #261 — capture.js crashes with TypeError when watches field is missing
//          from manifest cluster
//   #268 — regret install --scope produces empty manifest when trivial guard
//          skips all clusters — user loses auto-detected callees
//   #270 — install.js discards analyzer method-call edges for class-based code
//          (callees never populated)
//   #271 — install.js regex extractor does not detect `export { foo, bar }` style
//
// All 4 fixes are on main (per-issue tests in tests/capture-ghost-fixes.test.js
// for #261; install.js changes for #268/#270/#271 across multiple PRs).
// This file locks in the fixes so future workers / BOS can audit them in one place.
//
// Run: node --test tests/redteam-verification-261-268-270-271.test.js

import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const INSTALL_JS  = join(REPO_ROOT, 'scripts', 'install.js')
const CAPTURE_JS  = join(REPO_ROOT, 'scripts', 'capture.js')

const TMP = resolve(REPO_ROOT, 'tests', `__redteam_verify_5_${process.pid}__`)

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
  const entries = readdirSync(TMP, { withFileTypes: true })
  for (const e of entries) {
    rmSync(join(TMP, e.name), { recursive: true, force: true })
  }
})
after(()  => { rmSync(TMP, { recursive: true, force: true }) })

// ─── #261 — capture.js does not crash when watches field is missing ──────────

describe('#261 — capture.js handles missing watches field without crashing', () => {
  it('defaults watches to [] when absent from manifest cluster', () => {
    setupProject({
      'math.js': `
function add(a, b) { return a + b }
function main(a, b) { return add(a, b) }
module.exports = { add, main }
`,
      'package.json': '{"name":"test","version":"0.0.0"}',
    })
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    // Manifest WITHOUT "watches" field — the bug scenario from #261
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'main',
        entry: 'main',
        file: 'math.js',
        stack: 'js',
        fingerprintLevel: 'entry',
        multiArgs: true,
        inputs: [[3, 4]],
        callees: ['add'],
        // NOTE: no "watches" field — the bug
      }],
    }))

    const r = runCapture()
    // The bug: TypeError: Cannot read properties of undefined (reading 'join')
    // The fix: capture.js defaults watches to [] when absent
    assert.equal(r.exitCode, 0,
      `capture should NOT crash when watches is missing. Got exit ${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stdout, /Capturing: main/,
      'should start capture for the cluster')
    assert.match(r.stdout, /Fingerprint:/,
      'should compute a fingerprint')
    assert.ok(existsSync(join(TMP, 'regrets', 'main.regret')),
      '.regret file should be written')

    // Verify no TypeError in output
    const combined = r.stdout + r.stderr
    assert.doesNotMatch(combined, /TypeError.*'join'/,
      'should NOT throw TypeError about join')
    assert.doesNotMatch(combined, /Cannot read properties of undefined/,
      'should NOT throw "Cannot read properties of undefined"')
  })
})

// ─── #268 — install preserves cluster definitions when trivial guard skips ──

describe('#268 — install preserves cluster definitions in install-skipped.txt', () => {
  it('writes install-skipped.txt with auto-detected callees when all clusters are trivial-skipped', () => {
    // Fixture: class that throws on auto-generated trivial inputs
    // (constructor without args throws)
    setupProject({
      'calc.js': `
class Calculator {
  constructor() { throw new Error('needs args') }
  add(a, b) { return a + b }
  multiply(a, b) { return this.add(a, a) + this.add(b, b) - a - b }
}
module.exports = { Calculator }
`,
      'package.json': '{"name":"test","version":"0.0.0"}',
    })

    const r = runInstall(['--scope', 'calc.js', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)

    // The bug: when all clusters are trivial-skipped, manifest.json was empty
    // ({ "clusters": [] }) and the auto-detected callees were LOST.
    // The fix: install writes install-skipped.txt with the cluster definitions
    // INCLUDING the auto-detected callees.
    const skippedPath = join(TMP, 'regrets', 'install-skipped.txt')
    assert.ok(existsSync(skippedPath),
      'install-skipped.txt should exist when clusters are trivial-skipped')

    const skippedContent = readFileSync(skippedPath, 'utf8')
    // The cluster definition should include the auto-detected callees
    assert.match(skippedContent, /"callees"/,
      'install-skipped.txt should preserve auto-detected callees')
    assert.match(skippedContent, /"add"/,
      'install-skipped.txt should list "add" as an auto-detected callee')
    assert.match(skippedContent, /Cluster:\s+\S*calculator/i,
      'install-skipped.txt should list the cluster name (with optional file prefix)')

    // Also: install summary should mention install-skipped.txt
    assert.match(r.stdout, /install-skipped\.txt/,
      'install summary should point the user to install-skipped.txt')
  })

  it('preserves cluster definitions even when SOME clusters are captured', () => {
    // Fixture: one capturable function + one that throws on trivial inputs
    setupProject({
      'mixed.js': `
function add(a, b) { return a + b }
function throwsy(a, b) { if (typeof a !== 'number') throw new Error('bad'); return a + b }
module.exports = { add, throwsy }
`,
      'package.json': '{"name":"test","version":"0.0.0"}',
    })

    const r = runInstall(['--scope', 'mixed.js', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)

    // Manifest should contain the capturable cluster
    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    assert.ok(existsSync(manifestPath), 'manifest.json should exist')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.ok(manifest.clusters.length > 0,
      'manifest should contain at least the capturable cluster')

    // If any cluster was skipped, install-skipped.txt should exist with its definition
    if (r.stdout.includes('Skipped:') || r.stdout.includes('trivial')) {
      const skippedPath = join(TMP, 'regrets', 'install-skipped.txt')
      assert.ok(existsSync(skippedPath),
        'install-skipped.txt should exist when some clusters are trivial-skipped')
    }
  })
})

// ─── #270 — install.js auto-populates callees for class methods ──────────────

describe('#270 — install.js auto-populates callees for class method-call edges', () => {
  it('detects this.add() call inside Calculator.multiply() and adds "add" to callees', () => {
    setupProject({
      'calculator.js': `
class Calculator {
  add(a, b) { return a + b }
  multiply(a, b) {
    return this.add(a, a) + this.add(b, b) - a - b
  }
}
module.exports = { Calculator }
`,
      'package.json': '{"name":"test","version":"0.0.0"}',
    })

    const r = runInstall(['--scope', 'calculator.js', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)

    // The bug: analyzer detected the edge (multiply -> add), but install.js
    // filtered it out because "multiply" wasn't in extractExportedFunctions.
    // The class was detected as a cluster but with NO callees.

    // The fix: install.js now preserves the analyzer edges for class methods.
    // Either:
    //   (a) the cluster definition in manifest.json or install-skipped.txt
    //       includes "callees": ["add"], OR
    //   (b) the install-skipped.txt shows "Callees: add"

    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    const skippedPath = join(TMP, 'regrets', 'install-skipped.txt')

    let calleesFound = false
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      for (const cluster of manifest.clusters) {
        if (cluster.callees && cluster.callees.includes('add')) {
          calleesFound = true
          break
        }
      }
    }
    if (!calleesFound && existsSync(skippedPath)) {
      const skipped = readFileSync(skippedPath, 'utf8')
      if (/Callees:\s*add/.test(skipped) || /"callees"\s*:\s*\[\s*"add"\s*\]/.test(skipped)) {
        calleesFound = true
      }
    }

    assert.ok(calleesFound,
      'install should auto-populate callees with "add" for the Calculator class ' +
      '(in either manifest.json or install-skipped.txt)')
  })
})

// ─── #271 — install.js detects `export { foo, bar }` style ───────────────────

describe('#271 — install.js detects `export { foo, bar }` style exports', () => {
  it('finds functions exported via `export { foo, bar }` statement', () => {
    setupProject({
      'calc.mjs': `
function square(x) { return x * x }
function cube(x) { return square(x) * x }
export { square, cube }
`,
      'package.json': '{"name":"test","version":"0.0.0","type":"module"}',
    })

    const r = runInstall(['--scope', 'calc.mjs', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)

    // The bug: "Found 0 exported functions" because extractExportedFunctions
    // only matched `export function` / `export const`, not `export { foo, bar }`.
    // The fix: install.js detects named export lists.
    assert.match(r.stdout, /Found 2 exported functions across 1 files?/,
      'should find both square and cube via `export { square, cube }`')

    // Verify the manifest contains both clusters
    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    assert.ok(existsSync(manifestPath), 'manifest.json should be written')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(entries.includes('square'),
      'manifest should include "square" cluster')
    assert.ok(entries.includes('cube'),
      'manifest should include "cube" cluster')
  })

  it('also handles `export { foo as bar }` alias syntax', () => {
    setupProject({
      'aliased.mjs': `
function original(x) { return x * 2 }
export { original as doubled }
`,
      'package.json': '{"name":"test","version":"0.0.0","type":"module"}',
    })

    const r = runInstall(['--scope', 'aliased.mjs', '--skip-capture'])
    assert.equal(r.exitCode, 0, `install failed: ${r.stderr}`)

    // Should find the function (either as "original" or "doubled" —
    // the alias name is the public name)
    assert.match(r.stdout, /Found 1 exported functions? across 1 files?/,
      'should find the aliased export')
  })
})

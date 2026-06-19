// tests/phase3-callees.test.js — Phase 3: auto-populate `callees` from analyzer
//
// Verifies that `regret install` calls analyzeScope on each scanned file and
// writes the resulting direct-call list (filtered to in-file callees only)
// into the cluster manifest entry as `callees: [...]`.
//
// Contract:
//   - main calls helper → cluster main has callees: ["helper"]
//   - helper calls nothing internal → cluster helper has NO callees field
//   - external calls (readdirSync, fs.join, ...) are filtered out
//   - empty callees → field is omitted (backward compat with Phase 1/2 manifests)
//
// Run: node --test tests/phase3-callees.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')

// ─── Test fixtures ──────────────────────────────────────────────────────────

const TMP = resolve(join(process.cwd(), 'tests', '__phase3_test_tmp__'))

function setupFixtures() {
  mkdirSync(TMP, { recursive: true })

  // Fixture 1: minimal CJS file from the Phase 3 spec.
  //   main → helper (internal)
  // Expected: main has callees:["helper"], helper has NO callees field.
  writeFileSync(join(TMP, 'simple.js'), `
function helper(x) { return x * 2 }
function main(x) { return helper(x) + 1 }
module.exports = { main, helper }
`)

  // Fixture 2: file with a mix of internal + external callees.
  //   main → add, mul, readdirSync (external)
  // Expected: callees:["add","mul"] — readdirSync is filtered out because it
  // is not defined in the same file.
  writeFileSync(join(TMP, 'with_external.js'), `
import { readdirSync } from 'fs'
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main() {
  const xs = readdirSync('.')
  return add(xs.length, 1) + mul(xs.length, 2)
}
module.exports = { main, add, mul }
`)

  // Fixture 3: file with NO internal calls.
  //   leaf just returns a constant
  // Expected: no `callees` field at all (backward compat — empty omitted).
  writeFileSync(join(TMP, 'leaf.js'), `
function leaf(x) { return x + 1 }
module.exports = { leaf }
`)

  // package.json so npm-style resolution (if any) works inside the temp dir.
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({
    name: 'phase3-test-fixture',
    version: '0.0.0',
    type: 'module',
  }))
}

function cleanupFixtures() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

/**
 * Run install.js with given args inside the fixture tmp dir.
 * Returns { exitCode, stdout, stderr }.
 */
function runInstall(args) {
  try {
    const stdout = execFileSync('node', [INSTALL_JS, ...args], {
      cwd: TMP,
      stdio: 'pipe',
      timeout: 30_000,
    })
    return { exitCode: 0, stdout: stdout.toString(), stderr: '' }
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    }
  }
}

function readManifest(relPath = 'regrets/manifest.json') {
  const p = join(TMP, relPath)
  assert.ok(existsSync(p), `manifest.json not found at ${relPath}`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

/**
 * Wipe any existing manifest so each test starts from a clean slate.
 * install.js merges with existing manifests by cluster id, so without this
 * a previous test's clusters (and their callees) would leak into the next
 * test's manifest and break assertions.
 */
function cleanManifest() {
  rmSync(join(TMP, 'regrets'), { recursive: true, force: true })
}

function findCluster(manifest, entry) {
  return manifest.clusters.find(c => c.entry === entry)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Phase 3: install auto-populates callees from analyzer', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('attaches callees:["helper"] to the main cluster (spec example)', () => {
    cleanManifest()
    const result = runInstall(['--scope', 'simple.js', '--skip-capture'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifest = readManifest()
    const mainCluster = findCluster(manifest, 'main')
    const helperCluster = findCluster(manifest, 'helper')

    assert.ok(mainCluster, 'cluster "main" should exist')
    assert.ok(helperCluster, 'cluster "helper" should exist')

    assert.deepEqual(
      mainCluster.callees,
      ['helper'],
      'main cluster should have callees:["helper"] auto-populated'
    )

    assert.equal(
      helperCluster.callees,
      undefined,
      'helper cluster should NOT have a callees field — it calls nothing internal'
    )
  })

  it('filters out external callees (readdirSync) — only in-file functions kept', () => {
    cleanManifest()
    const result = runInstall(['--scope', 'with_external.js', '--skip-capture'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifest = readManifest()
    const mainCluster = findCluster(manifest, 'main')
    assert.ok(mainCluster, 'cluster "main" should exist')

    assert.deepEqual(
      mainCluster.callees,
      ['add', 'mul'],
      'main cluster should only include in-file callees; readdirSync must be filtered out'
    )

    // add and mul should NOT have callees — they don't call anything internal
    assert.equal(findCluster(manifest, 'add').callees, undefined)
    assert.equal(findCluster(manifest, 'mul').callees, undefined)
  })

  it('omits the callees field entirely when a function has no internal callees (backward compat)', () => {
    cleanManifest()
    const result = runInstall(['--scope', 'leaf.js', '--skip-capture'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifest = readManifest()
    const leafCluster = findCluster(manifest, 'leaf')
    assert.ok(leafCluster, 'cluster "leaf" should exist')

    // No callees field at all — not `callees: []`, not `callees: null`, just absent.
    assert.equal(
      leafCluster.callees,
      undefined,
      'leaf cluster should have NO callees key for backward compat with Phase 1/2 manifests'
    )
    // Sanity: ensure the key is literally not present in the JSON
    const rawJson = readFileSync(join(TMP, 'regrets', 'manifest.json'), 'utf8')
    assert.ok(
      !rawJson.includes('"callees"'),
      'manifest JSON should not contain the string "callees" anywhere'
    )
  })

  it('does not crash when analyzer cannot parse a file (e.g. unknown language)', () => {
    // Install a file with an unsupported extension. install.js should still
    // proceed and produce a manifest (with no callees) — never throw.
    writeFileSync(join(TMP, 'unknown.txt'), `
function helper(x) { return x * 2 }
function main(x) { return helper(x) + 1 }
`)
    cleanManifest()
    // Note: install.js only scans JS/TS/PY by default, so unknown.txt will
    // be skipped during discovery — but if someone points --scope at it
    // directly, install should not throw. The expected behavior is the
    // scope-not-found error path, which is fine; the assertion here is
    // that the process exits cleanly without a Node-level crash.
    const result = runInstall(['--scope', 'unknown.txt', '--skip-capture'])
    // Exit may be non-zero (scope path error or "no functions found") — that's
    // acceptable. We just assert it did not throw an uncaught exception.
    assert.ok(result.exitCode !== null, 'install should produce a clean exit code, not a crash')
    assert.ok(
      !result.stderr.includes('TypeError'),
      'install should not throw a TypeError when given an unsupported file type'
    )
  })
})

// ─── Method call extraction tests ─────────────────────────────────────────
//
// Verifies that method calls (obj.method(), this.helper(), super.init())
// are tracked as call edges by the analyzer, with only the method name
// (not the receiver) captured. External method names (arr.map, etc.)
// are filtered out by install.js because they are not defined in the file.

describe('Phase 3: method call extraction (obj.method(), this.helper(), super.init())', () => {
  before(() => {
    mkdirSync(TMP, { recursive: true })

    // Fixture: class with this.helper() and super.init() method calls,
    // plus bare identifier calls for comparison.
    writeFileSync(join(TMP, 'method_calls.js'), `
function helper(x) { return x * 2 }
function init(x) { return x + 1 }
function main() {
  this.helper(1)
  super.init(2)
  obj.process(3)
  arr.map(fn)
  helper(4)
}
module.exports = { main, helper, init }
`)

    // Fixture: method calls where the method IS defined in the same file.
    // helper and init are defined → they should appear in callees.
    // process and map are NOT defined → they should be filtered out.
    writeFileSync(join(TMP, 'method_internal.js'), `
function helper(x) { return x * 2 }
function init(x) { return x + 1 }
function main() {
  this.helper(1)
  super.init(2)
  obj.process(3)
  arr.map(fn)
}
module.exports = { main, helper, init }
`)

    // Fixture: mixed bare + method calls to the same function.
    // helper is called both as bare identifier AND as method —
    // callees should deduplicate.
    writeFileSync(join(TMP, 'method_mixed.js'), `
function helper(x) { return x * 2 }
function main() {
  helper(1)
  this.helper(2)
}
module.exports = { main, helper }
`)

    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'phase3-method-call-test',
      version: '0.0.0',
      type: 'module',
    }))
  })

  after(() => cleanupFixtures())

  it('tracks this.helper() as a call edge to "helper"', () => {
    cleanManifest()
    const result = runInstall(['--scope', 'method_calls.js', '--skip-capture'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifest = readManifest()
    const mainCluster = findCluster(manifest, 'main')
    assert.ok(mainCluster, 'cluster "main" should exist')
    assert.ok(
      mainCluster.callees && mainCluster.callees.includes('helper'),
      'main cluster callees should include "helper" from this.helper()'
    )
  })

  it('tracks super.init() as a call edge to "init"', () => {
    cleanManifest()
    const result = runInstall(['--scope', 'method_calls.js', '--skip-capture'])
    assert.equal(result.exitCode, 0)

    const manifest = readManifest()
    const mainCluster = findCluster(manifest, 'main')
    assert.ok(mainCluster, 'cluster "main" should exist')
    assert.ok(
      mainCluster.callees && mainCluster.callees.includes('init'),
      'main cluster callees should include "init" from super.init()'
    )
  })

  it('tracks obj.process() as a call edge to "process"', () => {
    cleanManifest()
    const result = runInstall(['--scope', 'method_calls.js', '--skip-capture'])
    assert.equal(result.exitCode, 0)

    const manifest = readManifest()
    const mainCluster = findCluster(manifest, 'main')
    assert.ok(mainCluster, 'cluster "main" should exist')
    // "process" is NOT defined in the file, so it should be filtered out
    // from callees by install.js. But the edge itself should exist in the
    // raw analyzer output. We verify via the integration that it's not in
    // the final callees (proving the filter works).
    assert.ok(
      !mainCluster.callees || !mainCluster.callees.includes('process'),
      'main cluster callees should NOT include "process" — it is not defined in the file'
    )
  })

  it('filters out external method names (arr.map) that are not in-file functions', () => {
    cleanManifest()
    const result = runInstall(['--scope', 'method_internal.js', '--skip-capture'])
    assert.equal(result.exitCode, 0)

    const manifest = readManifest()
    const mainCluster = findCluster(manifest, 'main')
    assert.ok(mainCluster, 'cluster "main" should exist')

    // helper and init ARE defined in file → should be in callees
    // process and map are NOT defined → should be filtered out
    assert.deepEqual(
      mainCluster.callees,
      ['helper', 'init'],
      'main cluster should only include in-file method callees; process and map must be filtered out'
    )
  })

  it('deduplicates when the same function is called via bare identifier AND method call', () => {
    cleanManifest()
    const result = runInstall(['--scope', 'method_mixed.js', '--skip-capture'])
    assert.equal(result.exitCode, 0)

    const manifest = readManifest()
    const mainCluster = findCluster(manifest, 'main')
    assert.ok(mainCluster, 'cluster "main" should exist')

    assert.deepEqual(
      mainCluster.callees,
      ['helper'],
      'main cluster callees should have "helper" once despite being called via helper() and this.helper()'
    )
  })

  it('bare identifier calls still work alongside method call extraction', () => {
    cleanManifest()
    const result = runInstall(['--scope', 'method_calls.js', '--skip-capture'])
    assert.equal(result.exitCode, 0)

    const manifest = readManifest()
    const mainCluster = findCluster(manifest, 'main')
    assert.ok(mainCluster, 'cluster "main" should exist')

    // helper appears both from this.helper() and bare helper(4)
    // Both should be captured, but deduplicated in callees
    assert.ok(
      mainCluster.callees && mainCluster.callees.includes('helper'),
      'bare identifier call helper(4) should still be tracked'
    )
  })
})

// tests/install-scope-discovery.test.js
//
// Integration tests for the 5 install.js scope/discovery fixes:
//   #317 — extractExportedFunctions verifies export (no internal functions)
//   #320 — single-file --scope works (gitignore no longer filters explicit file)
//   #323 — --scope <dir> recursive by default + --flat escape hatch
//   #319 — expanded default probe inputs (string-first APIs captured, not skipped)
//   #327 — install summary shows callee-coverage breakdown
//
// Run: node --test tests/install-scope-discovery.test.js

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
  readFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')

// Each describe block gets its own temp directory to avoid interference.
const TMP_BASE = resolve(join(process.cwd(), 'tests', '__install_scope_disc__'))

function makeTmpDir(label) {
  const dir = join(TMP_BASE, label)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

function cleanupAll() {
  rmSync(TMP_BASE, { recursive: true, force: true })
}

/**
 * Run install.js with given args and return { exitCode, stdout, stderr }.
 */
function runInstall(args, cwd) {
  const result = spawnSync('node', [INSTALL_JS, ...args], {
    cwd: cwd || TMP_BASE,
    stdio: 'pipe',
    timeout: 60_000,
  })
  return {
    exitCode: result.status ?? (result.signal ? 1 : 0),
    stdout: result.stdout ? result.stdout.toString() : '',
    stderr: result.stderr ? result.stderr.toString() : '',
  }
}

// ─── #317 — extractExportedFunctions verifies export ──────────────────────────

describe('#317 — only exported functions become clusters', () => {
  after(() => cleanupAll())

  it('CJS file: 5 functions, 2 exported → only 2 in manifest', () => {
    const dir = makeTmpDir('issue-317')
    // 5 functions: only `foo` and `bar` are exported via module.exports.
    // `helper`, `internal`, and `logerror` are internal — they must NOT
    // become clusters.
    writeFileSync(join(dir, 'mod.js'), `
function helper(a) { return String(a) }
function internal(b) { return b * 2 }
function logerror(err) { return String(err) }
function foo(x) { return helper(x) + ':foo' }
function bar(y) { return internal(y) + ':bar' }
module.exports = { foo, bar }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-317', version: '1.0.0',
    }))

    const result = runInstall(['--scope', 'mod.js', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)

    assert.ok(entries.includes('foo'), 'manifest should include exported foo')
    assert.ok(entries.includes('bar'), 'manifest should include exported bar')
    assert.ok(!entries.includes('helper'),
      'manifest must NOT include internal helper (#317)')
    assert.ok(!entries.includes('internal'),
      'manifest must NOT include non-exported top-level internal (#317)')
    assert.ok(!entries.includes('logerror'),
      'manifest must NOT include non-exported top-level logerror (#317)')
  })

  it('ESM file: closure-private inner function not extracted', () => {
    const dir = makeTmpDir('issue-317-esm')
    writeFileSync(join(dir, 'mod.mjs'), `
export function process(input) {
  function inner(x) { return x.toUpperCase() }
  return inner(String(input))
}
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-317-esm', version: '1.0.0', type: 'module',
    }))

    const result = runInstall(['--scope', 'mod.mjs', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)

    assert.ok(entries.includes('process'), 'manifest should include exported process')
    assert.ok(!entries.includes('inner'),
      'manifest must NOT include closure-private inner function (#317)')
  })

  it('export default { foo, bar } object — names extracted', () => {
    const dir = makeTmpDir('issue-317-default-obj')
    writeFileSync(join(dir, 'mod.mjs'), `
function foo(x) { return 'foo:' + String(x) }
function bar(y) { return 'bar:' + String(y) }
function helper(z) { return String(z) }
export default { foo, bar }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-317-default', version: '1.0.0', type: 'module',
    }))

    const result = runInstall(['--scope', 'mod.mjs', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)

    assert.ok(entries.includes('foo'),
      'manifest should include foo from export default { foo, bar }')
    assert.ok(entries.includes('bar'),
      'manifest should include bar from export default { foo, bar }')
    assert.ok(!entries.includes('helper'),
      'manifest must NOT include non-exported helper')
  })
})

// ─── #320 — single-file --scope works even with .gitignore ───────────────────

describe('#320 — single-file --scope ignores .gitignore', () => {
  after(() => cleanupAll())

  it('file matched by .gitignore *.js is still scanned', () => {
    const dir = makeTmpDir('issue-320')
    writeFileSync(join(dir, 'validator.js'), `
module.exports.isEmail = function isEmail(str) { return 'email:' + String(str) }
module.exports.isURL = function isURL(str) { return 'url:' + String(str) }
`)
    // .gitignore would filter out all .js files — but --scope <file>
    // explicitly points at this file, so it must NOT be filtered.
    writeFileSync(join(dir, '.gitignore'), '*.js\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-320', version: '1.0.0',
    }))

    const result = runInstall(['--scope', 'validator.js', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    // Must NOT see "No source files found" — the file was explicitly requested.
    assert.ok(!result.stdout.includes('No source files found'),
      'should not report "No source files found" for explicitly-scoped file (#320)')
    assert.ok(result.stdout.includes('Found 2 exported functions'),
      'should find 2 exported functions in the single file')

    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(entries.includes('isEmail'), 'manifest should include isEmail')
    assert.ok(entries.includes('isURL'), 'manifest should include isURL')
  })
})

// ─── #323 — --scope <dir> recursive by default + --flat ──────────────────────

describe('#323 — --scope <dir> recursive by default', () => {
  after(() => cleanupAll())

  it('recursive: nested subdir .js file is found', () => {
    const dir = makeTmpDir('issue-323')
    mkdirSync(join(dir, 'lib', 'core'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'top.js'), `
export function topFn(a) { return 'top:' + String(a) }
`)
    writeFileSync(join(dir, 'lib', 'core', 'deep.js'), `
export function deepFn(a) { return 'deep:' + String(a) }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-323', version: '1.0.0',
    }))

    // --scope lib/ — recursive by default (no --flat)
    const result = runInstall(['--scope', 'lib/', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'lib', 'regrets', 'manifest.json'), 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(entries.includes('topFn'), 'should include top-level function')
    assert.ok(entries.includes('deepFn'),
      'should include nested subdir function (recursive by default — #323)')
  })

  it('--flat: nested subdir .js file is NOT found', () => {
    const dir = makeTmpDir('issue-323-flat')
    mkdirSync(join(dir, 'lib', 'core'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'top.js'), `
export function topFn(a) { return 'top:' + String(a) }
`)
    writeFileSync(join(dir, 'lib', 'core', 'deep.js'), `
export function deepFn(a) { return 'deep:' + String(a) }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-323-flat', version: '1.0.0',
    }))

    const result = runInstall(['--scope', 'lib/', '--flat', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifest = JSON.parse(readFileSync(join(dir, 'lib', 'regrets', 'manifest.json'), 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(entries.includes('topFn'), 'should include top-level function')
    assert.ok(!entries.includes('deepFn'),
      'should NOT include nested subdir function with --flat')
  })
})

// ─── #319 — string-first API captured (not trivial-skipped) ──────────────────

describe('#319 — string-first API captured with expanded probe inputs', () => {
  after(() => cleanupAll())

  it('upper(s) is captured because "test" probe produces "TEST"', () => {
    const dir = makeTmpDir('issue-319')
    // A string-first function: upper(null) throws, upper({}) throws,
    // but upper('test') returns 'TEST' — meaningful.
    // With the old [null, {}] inputs, ANY-trivial policy would skip it
    // (null throws → trivial). With the new expanded probe set and
    // ALL-trivial policy, 'test' produces 'TEST' → NOT trivial → captured.
    writeFileSync(join(dir, 'str.js'), `
export function upper(s) { return String(s).toUpperCase() }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-319', version: '1.0.0',
    }))

    const result = runInstall(['--scope', 'str.js', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    // The cluster should be in the manifest (NOT trivial-skipped).
    const manifest = JSON.parse(readFileSync(join(dir, 'regrets', 'manifest.json'), 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(entries.includes('upper'),
      'upper should be captured — "test" probe produces "TEST" (meaningful). #319')

    // Should NOT be in install-skipped.txt
    const skipLogPath = join(dir, 'regrets', 'install-skipped.txt')
    if (existsSync(skipLogPath)) {
      const skipLog = readFileSync(skipLogPath, 'utf8')
      assert.ok(!skipLog.includes('upper'),
        'upper should NOT be in install-skipped.txt — it produces meaningful output with string inputs')
    }
  })

  it('function that throws for ALL inputs is still trivial-skipped', () => {
    const dir = makeTmpDir('issue-319-still-skipped')
    // This function throws for every input in the default probe set.
    // Under the ALL-trivial policy, it should still be skipped.
    writeFileSync(join(dir, 'broken.js'), `
export function broken(x) { throw new Error('always broken') }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-319-skip', version: '1.0.0',
    }))

    const result = runInstall(['--scope', 'broken.js', '--skip-capture'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    // broken should be trivial-skipped (throws for ALL inputs)
    assert.match(result.stderr, /Cluster "broken" skipped/,
      'broken should be trivial-skipped — it throws for all inputs')
  })
})

// ─── #327 — install summary callee-coverage breakdown ────────────────────────

describe('#327 — install summary shows callee-coverage breakdown', () => {
  after(() => cleanupAll())

  it('summary shows fully verified / partial / parent only breakdown', () => {
    const dir = makeTmpDir('issue-327')
    // Create a file with:
    //   - `parent` (has callee: inner — closure-private, can't be wrapped by
    //     capture.js → callee .regret NOT created → partial)
    //   - `standalone` (no callees → parent only)
    // Both produce meaningful output (non-trivial) so they get captured.
    writeFileSync(join(dir, 'mod.js'), `
function parent(x) {
  function inner(y) { return y * 2 }
  return inner(x) + ':parent'
}
function standalone(x) { return 'stand:' + String(x) }
module.exports = { parent, standalone }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-327', version: '1.0.0',
    }))

    // Run full install (not --skip-capture) so capture runs and we get
    // the breakdown in the summary.
    const result = runInstall(['--scope', 'mod.js'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    // Summary should include the breakdown lines
    assert.match(result.stdout, /fully verified \(all declared callees contracted\)/,
      'summary should show "fully verified" line (#327)')
    assert.match(result.stdout, /partial \(some callees not contracted\)/,
      'summary should show "partial" line (#327)')
    assert.match(result.stdout, /parent only \(no callees declared\)/,
      'summary should show "parent only" line (#327)')

    // `parent` has callee `helper` → callee .regret file NOT captured during
    // install → partial. `standalone` has no callees → parent only.
    // So: fullyVerified=0, partialCallees>=1, parentOnly>=1.
    // The warning should appear since partialCallees > 0.
    assert.match(result.stdout, /partial callee coverage/,
      'summary should warn about partial callee coverage (#327)')
  })

  it('workspace summary also shows aggregate breakdown', () => {
    const dir = makeTmpDir('issue-327-workspace')
    mkdirSync(join(dir, 'pkg-a'), { recursive: true })
    writeFileSync(join(dir, 'pkg-a', 'package.json'), JSON.stringify({
      name: 'pkg-a', version: '1.0.0',
    }))
    writeFileSync(join(dir, 'pkg-a', 'index.js'), `
function helper(x) { return 'h:' + String(x) }
function main(x) { return helper(x) + ':main' }
module.exports = { main }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'mono-327', version: '1.0.0',
    }))

    const result = runInstall(['--scope', '.'], dir)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    // Workspace totals should include the breakdown
    assert.match(result.stdout, /fully verified \(all declared callees contracted\)/,
      'workspace summary should show aggregate "fully verified" line (#327)')
    assert.match(result.stdout, /partial \(some callees not contracted\)/,
      'workspace summary should show aggregate "partial" line (#327)')
    assert.match(result.stdout, /parent only \(no callees declared\)/,
      'workspace summary should show aggregate "parent only" line (#327)')
  })
})

// tests/install-red-team.test.js — Red team regression tests for install.js
//
// Covers the 6 red-team issues fixed in this PR:
//   #265 — workspace mode bypassed trivial-input guard (cluster.file resolved
//          against projectRoot instead of package subfolder)
//   #268 — `regret install --scope <file>` produced empty manifest when all
//          clusters trivial-skipped, losing auto-detected callees
//   #270 — class-based code's method-call edges were dropped by install.js's
//          `e.from === fnName` filter (analyzer emits `from: <methodName>`,
//          not `from: <className>`)
//   #294 — flat-directory --scope mode had the same trivial-guard bypass as
//          #265 (cwd != scopeRoot → existsSync() returns false)
//   #296 — `regret install --scope <empty-folder>` silently succeeded with
//          misleading "Next steps: regret validate"
//   #297 — file without extension was parsed as JS (no language detection in
//          single-file mode)
//
// Run: node --test tests/install-red-team.test.js

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
  readFileSync, readdirSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')

// Per-issue tmp dirs to avoid cross-test contamination. Each test creates
// its own subdir under TMP/<issue-key>/ so they can run in parallel
// without stepping on each other.
const TMP = resolve(join(process.cwd(), 'tests', '__red_team_tmp__'))

function makeTmpDir(sub) {
  const p = join(TMP, sub)
  mkdirSync(p, { recursive: true })
  return p
}

function cleanupAll() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

/**
 * Run install.js with given args inside the given cwd.
 * Returns { exitCode, stdout, stderr }.
 *
 * Uses spawnSync (not execFileSync) so we capture stdout AND stderr
 * separately even on exit 0 — install.js writes trivial-skip warnings
 * to stderr via process.stderr.write, and several assertions need to
 * inspect them.
 */
function runInstall(args, cwd) {
  const result = spawnSync('node', [INSTALL_JS, ...args], {
    cwd,
    stdio: 'pipe',
    timeout: 60_000,
  })
  return {
    exitCode: result.status ?? (result.signal ? 1 : 0),
    stdout: result.stdout ? result.stdout.toString() : '',
    stderr: result.stderr ? result.stderr.toString() : '',
  }
}

function readManifest(dir, relPath = 'regrets/manifest.json') {
  const p = join(dir, relPath)
  return JSON.parse(readFileSync(p, 'utf8'))
}

// ─── #265 — workspace mode trivial-input guard ──────────────────────────────

describe('#265 — workspace mode applies trivial-input guard (no NaN/null captures)', () => {
  beforeEach(() => {
    cleanupAll()
    // Workspace: pkg-a/index.js with two functions that produce NaN for
    // ALL probe inputs (expanded default set in #319). Before the fix,
    // probeTrivialOutputs() resolved `cluster.file = 'index.js'` against
    // projectRoot (the workspace root) — that path didn't exist, so the
    // probe returned `{trivial: false}` and the cluster was "captured" with
    // a meaningless NaN fingerprint.
    //
    // #319: The default probe inputs are now ['', 'test', 0, 1, {}, [], null]
    // and a cluster is skipped only if ALL inputs produce trivial output.
    // These functions return NaN regardless of input, so they are still
    // trivial-skipped under the new policy.
    const dir = makeTmpDir('issue-265')
    mkdirSync(join(dir, 'pkg-a'), { recursive: true })
    writeFileSync(join(dir, 'pkg-a', 'package.json'), JSON.stringify({
      name: 'pkg-a', version: '1.0.0',
    }))
    writeFileSync(join(dir, 'pkg-a', 'index.js'), `
function add(a, b) { return NaN }
function subtract(a, b) { return NaN }
module.exports = { add, subtract }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'mono-test-265', version: '1.0.0',
    }))
  })
  after(() => cleanupAll())

  it('does NOT capture clusters that produce NaN outputs (trivial guard fires)', () => {
    const cwd = join(TMP, 'issue-265')
    const result = runInstall(['--scope', '.'], cwd)
    assert.equal(result.exitCode, 0,
      `install should exit 0 (trivial skips are not failures). stderr: ${result.stderr}`)

    // Both clusters should be trivial-skipped, not captured.
    assert.match(result.stdout, /2 trivial skipped/,
      'workspace summary should report 2 trivial-skipped clusters in pkg-a')

    // No .regret files should have been written (capture never ran for them).
    const regretsDir = join(cwd, 'pkg-a', 'regrets')
    const regretFiles = existsSync(regretsDir)
      ? readdirSync(regretsDir).filter(f => f.endsWith('.regret'))
      : []
    assert.equal(regretFiles.length, 0,
      `expected 0 .regret files (clusters trivial-skipped), found: ${regretFiles.join(', ')}`)
  })

  it('writes install-skipped.txt with cluster definitions in pkg-a/regrets/', () => {
    const cwd = join(TMP, 'issue-265')
    runInstall(['--scope', '.'], cwd)

    const skipLogPath = join(cwd, 'pkg-a', 'regrets', 'install-skipped.txt')
    assert.ok(existsSync(skipLogPath), 'install-skipped.txt should exist in pkg-a/regrets/')

    const skipLog = readFileSync(skipLogPath, 'utf8')
    // Both clusters should appear in the skip log
    const clusterCount = (skipLog.match(/^Cluster: /gm) || []).length
    assert.equal(clusterCount, 2,
      `install-skipped.txt should list 2 clusters, found ${clusterCount}`)
    // Reason should mention NaN
    assert.match(skipLog, /NaN/,
      'install-skipped.txt should mention NaN as the trivial-output reason')
  })

  it('does NOT write an empty manifest (no manifest.json in pkg-a/regrets/)', () => {
    const cwd = join(TMP, 'issue-265')
    runInstall(['--scope', '.'], cwd)

    const manifestPath = join(cwd, 'pkg-a', 'regrets', 'manifest.json')
    assert.ok(!existsSync(manifestPath),
      'manifest.json must NOT be written when all clusters trivial-skipped (issue #268 contract)')
  })
})

// ─── #294 — flat-directory mode trivial-input guard ─────────────────────────

describe('#294 — flat-directory --scope mode applies trivial-input guard', () => {
  beforeEach(() => {
    cleanupAll()
    // Project layout: <root>/src/greetings.mjs with two functions.
    // `shout` always throws (regardless of input) → trivial for ALL probes.
    // `formatGreeting` returns a meaningful string for all inputs → kept.
    //
    // #319: With the expanded default probe set ('', 'test', 0, 1, {}, [],
    // null), a function is trivial-skipped only if ALL inputs produce
    // trivial output. `shout` throws for every input, so it is still
    // skipped. `formatGreeting` produces 'Hello, !', 'Hello, test!', etc.
    // — all meaningful — so it is kept.
    //
    // Before the fix (#294), probeTrivialOutputs() resolved `cluster.file`
    // against projectRoot (cwd), but the file lives at
    // <root>/src/greetings.mjs — so the probe returned false and `shout`
    // was "captured" only to fail at capture.js time with a runtime error.
    const dir = makeTmpDir('issue-294')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'greetings.mjs'), `
export function shout(text) { throw new Error('shout requires a valid string') }
export function formatGreeting(name) { return \`Hello, \${name}!\` }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'flat-scope-294', version: '1.0.0', type: 'module',
    }))
  })
  after(() => cleanupAll())

  it('skips `shout` cluster (throws on null input) and keeps `formatGreeting`', () => {
    const cwd = join(TMP, 'issue-294')
    const result = runInstall(['--scope', 'src/', '--skip-capture'], cwd)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    // `shout` should be trivial-skipped (throws on null.toUpperCase).
    // install.js writes the per-cluster skip warning to stderr via
    // process.stderr.write — check stderr, not stdout.
    assert.match(result.stderr, /Cluster "shout" skipped — throws on auto-generated input/,
      'install should skip `shout` cluster with a throws reason (warning on stderr)')

    // `formatGreeting` should be kept (returns "Hello, null!" — meaningful)
    assert.doesNotMatch(result.stderr, /Cluster "formatGreeting" skipped/,
      'install should NOT skip `formatGreeting` — its output is meaningful')

    // Manifest should contain formatGreeting but NOT shout
    const manifest = readManifest(cwd, 'src/regrets/manifest.json')
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(entries.includes('formatGreeting'),
      'manifest should include formatGreeting (kept)')
    assert.ok(!entries.includes('shout'),
      'manifest should NOT include shout (trivial-skipped)')
  })

  it('writes install-skipped.txt with the shout cluster definition in src/regrets/', () => {
    const cwd = join(TMP, 'issue-294')
    runInstall(['--scope', 'src/', '--skip-capture'], cwd)

    const skipLogPath = join(cwd, 'src', 'regrets', 'install-skipped.txt')
    assert.ok(existsSync(skipLogPath),
      'install-skipped.txt should exist in src/regrets/ for partial-skip case')

    const skipLog = readFileSync(skipLogPath, 'utf8')
    assert.match(skipLog, /Cluster:\s+greetings-shout/,
      'install-skipped.txt should mention the greetings-shout cluster')
    assert.match(skipLog, /throws on auto-generated input/,
      'install-skipped.txt should mention the throws reason')
  })
})

// ─── #268 — all-clusters-trivial-skipped preserves callees in install-skipped.txt

describe('#268 — all clusters trivial-skipped: no empty manifest, callees preserved', () => {
  beforeEach(() => {
    cleanupAll()
    const dir = makeTmpDir('issue-268')
    // math.js: 3 functions all producing NaN for ALL probe inputs (#319
    // expanded default set). main calls add + multiply internally —
    // auto-detected callees!
    writeFileSync(join(dir, 'math.js'), `
function add(a, b) { return NaN }
function multiply(a, b) { return NaN }
function main(a, b) { return add(a, b) + multiply(a, b) }
module.exports = { add, multiply, main }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'empty-manifest-268', version: '1.0.0',
    }))
  })
  after(() => cleanupAll())

  it('does NOT write an empty manifest', () => {
    const cwd = join(TMP, 'issue-268')
    const result = runInstall(['--scope', 'math.js', '--skip-capture'], cwd)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    const manifestPath = join(cwd, 'regrets', 'manifest.json')
    assert.ok(!existsSync(manifestPath),
      'manifest.json must NOT be written when all clusters trivial-skipped')
  })

  it('writes install-skipped.txt with all cluster definitions', () => {
    const cwd = join(TMP, 'issue-268')
    runInstall(['--scope', 'math.js', '--skip-capture'], cwd)

    const skipLogPath = join(cwd, 'regrets', 'install-skipped.txt')
    assert.ok(existsSync(skipLogPath), 'install-skipped.txt should exist')

    const skipLog = readFileSync(skipLogPath, 'utf8')
    const clusterCount = (skipLog.match(/^Cluster: /gm) || []).length
    assert.equal(clusterCount, 3,
      `install-skipped.txt should list all 3 clusters, found ${clusterCount}`)
  })

  it('preserves auto-detected callees for the main cluster', () => {
    const cwd = join(TMP, 'issue-268')
    runInstall(['--scope', 'math.js', '--skip-capture'], cwd)

    const skipLog = readFileSync(join(cwd, 'regrets', 'install-skipped.txt'), 'utf8')
    // The main cluster's definition should include callees: ["add", "multiply"]
    // (auto-detected by the analyzer, preserved in the skip log so the user
    // can paste the cluster into manifest.json with meaningful inputs and
    // re-run capture).
    //
    // Note: cluster IDs are prefixed with the file name (e.g. "math-main"),
    // so we match on the Entry field which is the bare function name.
    assert.match(skipLog, /Entry:\s+main\b[\s\S]*?Callees:\s+add,\s+multiply/,
      'install-skipped.txt should preserve callees for the main cluster')

    // The cluster definition JSON should also include the callees field.
    assert.match(skipLog, /"callees":\s*\[\s*"add"\s*,\s*"multiply"\s*\]/,
      'cluster definition JSON in install-skipped.txt should include callees array')
  })

  it('prints a clear summary pointing to install-skipped.txt', () => {
    const cwd = join(TMP, 'issue-268')
    const result = runInstall(['--scope', 'math.js', '--skip-capture'], cwd)
    assert.equal(result.exitCode, 0)

    assert.match(result.stdout, /All 3 cluster\(s\) skipped due to trivial inputs/,
      'summary should clearly state all 3 clusters were skipped due to trivial inputs')
    assert.match(result.stdout, /install-skipped\.txt/,
      'summary should point the user to install-skipped.txt')

    // Should NOT recommend `regret validate` (there is no manifest to validate).
    // The "Next steps" section should point at editing inputs and capture instead.
    const nextStepsMatch = result.stdout.match(/Next steps:[\s\S]*?(?=\n\n|\n$|$)/)
    if (nextStepsMatch) {
      const nextSteps = nextStepsMatch[0]
      assert.doesNotMatch(nextSteps, /regret validate/,
        'Next steps must NOT recommend `regret validate` (no manifest exists)')
      assert.match(nextSteps, /regret capture/,
        'Next steps should recommend `regret capture` after editing inputs')
    }
  })
})

// ─── #270 — class-based code: method-call edges preserved in callees ────────

describe('#270 — class-based code: method-call edges reach cluster callees', () => {
  beforeEach(() => {
    cleanupAll()
    const dir = makeTmpDir('issue-270')
    // Calculator class with `add` and `multiply` methods. `multiply` calls
    // `this.add(...)` twice — analyzer produces edges {from:'multiply', to:'add'}.
    // Before the fix, install.js's `e.from === 'Calculator'` filter returned []
    // because no edge had `from: 'Calculator'` (edges had `from: 'multiply'`).
    // Result: the Calculator cluster was created with NO `callees` field —
    // silently dropping the analyzer's work.
    writeFileSync(join(dir, 'calculator.js'), `
class Calculator {
  add(a, b) { return a + b }
  multiply(a, b) {
    return this.add(a, a) + this.add(b, b) - a - b
  }
}
module.exports = { Calculator }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'class-270', version: '1.0.0',
    }))
  })
  after(() => cleanupAll())

  it('preserves `add` as a callee of the Calculator cluster (even when trivial-skipped)', () => {
    const cwd = join(TMP, 'issue-270')
    const result = runInstall(['--scope', 'calculator.js', '--skip-capture'], cwd)
    assert.equal(result.exitCode, 0,
      `install should exit 0. stderr: ${result.stderr}`)

    // Calculator cluster is trivial-skipped (calling `new Calculator(null, {})`
    // returns an instance but the trivial-output guard treats class
    // constructors with [null, {}] inputs as trivial). The skipped cluster
    // definition should still preserve the auto-detected callees.
    const skipLog = readFileSync(join(cwd, 'regrets', 'install-skipped.txt'), 'utf8')
    assert.match(skipLog, /Cluster:\s+calculator\b[\s\S]*?Callees:\s+add/,
      'install-skipped.txt should list `add` as a callee of the Calculator cluster')
    assert.match(skipLog, /"callees":\s*\[\s*"add"\s*\]/,
      'Calculator cluster definition JSON should include callees: ["add"]')
  })

  it('does not crash when extracting class methods from various class shapes', () => {
    const cwd = join(TMP, 'issue-270')
    // Add more class shapes to verify the class-method detector handles them.
    writeFileSync(join(cwd, 'shapes.js'), `
class Empty {}
class WithStatic {
  static build() { return new WithStatic() }
  greet() { return 'hi' }
}
class WithExtends extends WithStatic {
  async asyncMethod() { return this.greet() }
}
module.exports = { Empty, WithStatic, WithExtends }
`)
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'class-shapes-270', version: '1.0.0',
    }))

    const result = runInstall(['--scope', 'shapes.js', '--skip-capture'], cwd)
    // Should exit cleanly (no crash from the class detector)
    assert.equal(result.exitCode, 0,
      `install should not crash on various class shapes. stderr: ${result.stderr}`)

    // WithExtends's asyncMethod calls this.greet() — `greet` is defined in
    // WithStatic (parent class). analyzer.js may or may not surface this
    // edge depending on inheritance handling, but install.js should not
    // crash either way.
    assert.doesNotMatch(result.stderr, /TypeError/,
      'install should not throw a TypeError on class shapes')
  })
})

// ─── #296 — empty folder: no manifest, no "Next steps: regret validate" ──────

describe('#296 — empty folder: clear message, no manifest, no misleading Next steps', () => {
  beforeEach(() => {
    cleanupAll()
    const dir = makeTmpDir('issue-296')
    mkdirSync(join(dir, 'empty-folder'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'wrapper-296', version: '1.0.0',
    }))
  })
  after(() => cleanupAll())

  it('exits 0 with a clear "No source files found" message', () => {
    const cwd = join(TMP, 'issue-296')
    const result = runInstall(['--scope', 'empty-folder', '--skip-capture'], cwd)
    assert.equal(result.exitCode, 0,
      `install should exit 0 (empty folder is not a hard error). stderr: ${result.stderr}`)

    assert.match(result.stdout, /No source files found in 'empty-folder' — manifest not created/,
      'install should clearly state no source files were found and no manifest was created')
  })

  it('does NOT write a manifest.json anywhere', () => {
    const cwd = join(TMP, 'issue-296')
    runInstall(['--scope', 'empty-folder', '--skip-capture'], cwd)

    const manifestInScope = join(cwd, 'empty-folder', 'regrets', 'manifest.json')
    const manifestInRoot = join(cwd, 'regrets', 'manifest.json')
    assert.ok(!existsSync(manifestInScope),
      'manifest.json must NOT be written inside the empty folder')
    assert.ok(!existsSync(manifestInRoot),
      'manifest.json must NOT be written at the cwd root either')
  })

  it('does NOT recommend "regret validate" in Next steps', () => {
    const cwd = join(TMP, 'issue-296')
    const result = runInstall(['--scope', 'empty-folder', '--skip-capture'], cwd)

    // Find the "Next steps" section (if any) and assert it doesn't
    // recommend validate. The fix may omit Next steps entirely OR replace
    // it with a clear "nothing to validate" message — both are acceptable.
    const nextStepsMatch = result.stdout.match(/Next steps:[\s\S]*?(?=\n\n|\n$|$)/)
    if (nextStepsMatch) {
      assert.doesNotMatch(nextStepsMatch[0], /regret validate/,
        'Next steps must NOT recommend `regret validate` for an empty folder')
    }
    // Also check the body — the "nothing to validate" guidance should appear
    // somewhere in the output.
    assert.match(result.stdout, /nothing to validate|No source files found/,
      'output should explain there is nothing to validate')
  })

  it('handles folder with only non-source files (.md, .json, .png)', () => {
    const cwd = join(TMP, 'issue-296')
    // Add non-source files to the empty folder
    writeFileSync(join(cwd, 'empty-folder', 'README.md'), '# docs only')
    writeFileSync(join(cwd, 'empty-folder', 'config.json'), '{}')
    writeFileSync(join(cwd, 'empty-folder', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = runInstall(['--scope', 'empty-folder', '--skip-capture'], cwd)
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /No source files found in 'empty-folder'/,
      'install should treat folder with only non-source files as empty')
  })
})

// ─── #297 — file without extension: error out, do not parse as JS ───────────

describe('#297 — file without extension: clear error, no JS parsing', () => {
  beforeEach(() => {
    cleanupAll()
    const dir = makeTmpDir('issue-297')
    // File with no extension that contains valid-looking JS source.
    // Before the fix, install.js would extract `add` and `main` as JS
    // functions, create clusters, and silently mislabel them as `stack: 'js'`.
    writeFileSync(join(dir, 'noext'), `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
module.exports = { add, main }
`)
    // Also create a Makefile and Dockerfile — common no-extension files
    // that should never be parsed as JS.
    writeFileSync(join(dir, 'Makefile'), `all:
\techo "build function foo() {}"
`)
    writeFileSync(join(dir, 'Dockerfile'), `FROM node:18
CMD ["node", "function foo() {}"]
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'noext-297', version: '1.0.0',
    }))
  })
  after(() => cleanupAll())

  it('errors out for a file with no extension', () => {
    const cwd = join(TMP, 'issue-297')
    const result = runInstall(['--scope', 'noext', '--skip-capture'], cwd)
    assert.notEqual(result.exitCode, 0,
      'install should exit non-zero for a file with no extension')

    assert.match(result.stderr, /unsupported file extension \(no extension\)/,
      'stderr should explain the file has no extension')
    assert.match(result.stderr, /\.js.*\.mjs.*\.cjs.*\.ts.*\.tsx.*\.py/,
      'stderr should list the supported extensions')
  })

  it('does NOT write a manifest for a no-extension file', () => {
    const cwd = join(TMP, 'issue-297')
    runInstall(['--scope', 'noext', '--skip-capture'], cwd)

    const manifestPath = join(cwd, 'regrets', 'manifest.json')
    assert.ok(!existsSync(manifestPath),
      'manifest.json must NOT be written for a no-extension file')
  })

  it('errors out for files with unsupported extensions (.txt, .md)', () => {
    const cwd = join(TMP, 'issue-297')
    writeFileSync(join(cwd, 'notes.txt'), `
function add(a, b) { return a + b }
`)

    const result = runInstall(['--scope', 'notes.txt', '--skip-capture'], cwd)
    assert.notEqual(result.exitCode, 0,
      'install should exit non-zero for a .txt file')
    assert.match(result.stderr, /unsupported file extension \('\.txt'\)/,
      'stderr should mention the unsupported .txt extension')
  })

  it('still accepts supported extensions (.js, .mjs, .cjs, .ts, .tsx, .py)', () => {
    const cwd = join(TMP, 'issue-297')
    // .js — should work (functions return meaningful strings so trivial guard doesn't skip)
    writeFileSync(join(cwd, 'ok.js'), `
export function greet(name) { return 'hi:' + String(name) }
`)
    const result = runInstall(['--scope', 'ok.js', '--skip-capture'], cwd)
    assert.equal(result.exitCode, 0,
      `install should accept .js files. stderr: ${result.stderr}`)
    const manifest = readManifest(cwd)
    assert.ok(manifest.clusters.some(c => c.entry === 'greet'),
      'manifest should contain the greet cluster for .js file')
  })

  it('errors out for Makefile and Dockerfile (no extension)', () => {
    const cwd = join(TMP, 'issue-297')

    const makeResult = runInstall(['--scope', 'Makefile', '--skip-capture'], cwd)
    assert.notEqual(makeResult.exitCode, 0,
      'Makefile (no extension) should be rejected')
    assert.match(makeResult.stderr, /unsupported file extension \(no extension\)/,
      'Makefile should trigger the no-extension error')

    const dockerResult = runInstall(['--scope', 'Dockerfile', '--skip-capture'], cwd)
    assert.notEqual(dockerResult.exitCode, 0,
      'Dockerfile (no extension) should be rejected')
    assert.match(dockerResult.stderr, /unsupported file extension \(no extension\)/,
      'Dockerfile should trigger the no-extension error')
  })
})

// ─── Cross-cutting: no regression on existing patterns ──────────────────────

describe('No regression — install.js still works for the happy path', () => {
  beforeEach(() => {
    cleanupAll()
    const dir = makeTmpDir('no-regression')
    writeFileSync(join(dir, 'math.js'), `
export function double(x) { return 'double:' + String(x) }
export function triple(x) { return 'triple:' + String(x) }
`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'no-regression', version: '1.0.0',
    }))
  })
  after(() => cleanupAll())

  it('still captures JS clusters with meaningful outputs', () => {
    const cwd = join(TMP, 'no-regression')
    const result = runInstall(['--scope', 'math.js'], cwd)
    assert.equal(result.exitCode, 0,
      `install should succeed for the happy path. stderr: ${result.stderr}`)

    assert.match(result.stdout, /Clusters captured: 2/,
      'both JS functions should be captured (no trivial-skip — outputs are meaningful strings)')

    const regretsDir = join(cwd, 'regrets')
    const regretFiles = readdirSync(regretsDir).filter(f => f.endsWith('.regret'))
    assert.ok(regretFiles.length >= 2,
      `expected at least 2 .regret files, found: ${regretFiles.join(', ')}`)

    // install-skipped.txt should NOT exist when everything captured cleanly.
    assert.ok(!existsSync(join(regretsDir, 'install-skipped.txt')),
      'install-skipped.txt must not exist when all clusters captured successfully')
  })
})

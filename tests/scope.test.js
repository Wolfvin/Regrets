// tests/scope.test.js — Integration tests for the --scope flag on regret install
// Uses Node.js built-in node:test and node:assert (zero external dependencies)
//
// Tests the three scope modes (file, flat directory, workspace) and the
// mutual exclusivity of --scope with --dir.
//
// Run: node --test tests/scope.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
  readFileSync, readdirSync
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')

// ─── Test fixtures ──────────────────────────────────────────────────────────

const TMP = resolve(join(process.cwd(), 'tests', '__scope_test_tmp__'))

function setupFixtures() {
  // Single file: src/utils/math.js
  // Functions that return meaningful strings even with [null, {}] inputs
  mkdirSync(join(TMP, 'src', 'utils'), { recursive: true })
  writeFileSync(join(TMP, 'src', 'utils', 'math.js'), `
export function add(a) { return 'add:' + String(a) }
export function multiply(a) { return 'mul:' + String(a) }
`)

  // Another file in same dir: src/utils/string.js
  writeFileSync(join(TMP, 'src', 'utils', 'string.js'), `
export function capitalize(a) { return 'cap:' + String(a) }
export function lowercase(a) { return 'low:' + String(a) }
`)

  // Root-level file
  writeFileSync(join(TMP, 'src', 'main.js'), `
export function greet(a) { return 'hi:' + String(a) }
export function farewell(a) { return 'bye:' + String(a) }
`)

  // Monorepo: packages/pkg-a and packages/pkg-b
  mkdirSync(join(TMP, 'packages', 'pkg-a'), { recursive: true })
  writeFileSync(join(TMP, 'packages', 'pkg-a', 'package.json'), '{"name":"pkg-a","version":"1.0.0"}')
  writeFileSync(join(TMP, 'packages', 'pkg-a', 'index.js'), `
export function fnA() { return 'A' }
export function helperA(x) { return 'h:' + String(x) }
`)

  mkdirSync(join(TMP, 'packages', 'pkg-b'), { recursive: true })
  writeFileSync(join(TMP, 'packages', 'pkg-b', 'package.json'), '{"name":"pkg-b","version":"1.0.0"}')
  writeFileSync(join(TMP, 'packages', 'pkg-b', 'index.js'), `
export function fnB() { return 'B' }
`)

  // Empty directory (no JS files)
  mkdirSync(join(TMP, 'empty-dir'), { recursive: true })
}

function cleanupFixtures() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
}

/**
 * Run install.js with given args and return { exitCode, stdout, stderr }
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('--scope Mode 1: single file', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('creates manifest with only functions from the scoped file', () => {
    const result = runInstall(['--scope', 'src/utils/math.js', '--skip-capture'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    assert.ok(existsSync(manifestPath), 'manifest.json should exist at regrets/')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(entries.includes('add'), 'should include add from math.js')
    assert.ok(entries.includes('multiply'), 'should include multiply from math.js')
    assert.ok(!entries.includes('capitalize'), 'should NOT include capitalize from string.js')
    assert.ok(!entries.includes('lowercase'), 'should NOT include lowercase from string.js')
  })

  it('sets file paths relative to project root', () => {
    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

    for (const cluster of manifest.clusters) {
      assert.ok(cluster.file.includes('math.js'), `file path should reference math.js, got: ${cluster.file}`)
    }
  })

  it('reports scope mode as single file', () => {
    const result = runInstall(['--scope', 'src/utils/math.js', '--skip-capture'])
    assert.ok(result.stdout.includes('Scope: single file'), 'should indicate single-file mode')
  })

  it('shows file count in summary', () => {
    const result = runInstall(['--scope', 'src/utils/math.js', '--skip-capture'])
    assert.ok(result.stdout.includes('Files scanned: 1'), 'should show 1 file scanned')
  })
})

describe('--scope Mode 2: flat directory', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('creates manifest at <dir>/regrets/ with all functions from that dir', () => {
    const result = runInstall(['--scope', 'src/utils/', '--skip-capture'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifestPath = join(TMP, 'src', 'utils', 'regrets', 'manifest.json')
    assert.ok(existsSync(manifestPath), 'manifest.json should exist at src/utils/regrets/')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(entries.includes('add'), 'should include add from math.js')
    assert.ok(entries.includes('multiply'), 'should include multiply from math.js')
    assert.ok(entries.includes('capitalize'), 'should include capitalize from string.js')
    assert.ok(entries.includes('lowercase'), 'should include lowercase from string.js')
  })

  it('does not include functions from outside the scoped dir', () => {
    const manifestPath = join(TMP, 'src', 'utils', 'regrets', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    assert.ok(!entries.includes('greet'), 'should NOT include greet from main.js')
    assert.ok(!entries.includes('farewell'), 'should NOT include farewell from main.js')
  })

  it('reports scope mode as directory', () => {
    const result = runInstall(['--scope', 'src/utils/', '--skip-capture'])
    assert.ok(result.stdout.includes('Scope: directory'), 'should indicate directory mode')
  })

  it('shows file count in summary', () => {
    const result = runInstall(['--scope', 'src/utils/', '--skip-capture'])
    assert.ok(result.stdout.includes('Files scanned: 2'), 'should show 2 files scanned')
  })

  it('does not recurse into subdirectories', () => {
    // Add a subdirectory with JS files inside src/utils/
    mkdirSync(join(TMP, 'src', 'utils', 'inner'), { recursive: true })
    writeFileSync(join(TMP, 'src', 'utils', 'inner', 'deep.js'), `
export function deepFn() { return 'deep' }
`)

    const manifestPath = join(TMP, 'src', 'utils', 'regrets', 'manifest.json')
    // Remove existing to get fresh scan
    rmSync(join(TMP, 'src', 'utils', 'regrets'), { recursive: true, force: true })

    const result = runInstall(['--scope', 'src/utils/', '--skip-capture'])
    assert.equal(result.exitCode, 0)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    // deepFn should NOT be included because Mode 2 is non-recursive (1 level)
    assert.ok(!entries.includes('deepFn'), 'should NOT include functions from subdirectories (1 level only)')
  })
})

describe('--scope Mode 3: workspace / monorepo', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('creates a separate manifest per subfolder with package.json', () => {
    const result = runInstall(['--scope', 'packages/', '--skip-capture'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifestA = join(TMP, 'packages', 'pkg-a', 'regrets', 'manifest.json')
    const manifestB = join(TMP, 'packages', 'pkg-b', 'regrets', 'manifest.json')

    assert.ok(existsSync(manifestA), 'pkg-a should have its own manifest')
    assert.ok(existsSync(manifestB), 'pkg-b should have its own manifest')

    const clustersA = JSON.parse(readFileSync(manifestA, 'utf8')).clusters
    const clustersB = JSON.parse(readFileSync(manifestB, 'utf8')).clusters

    const entriesA = clustersA.map(c => c.entry)
    const entriesB = clustersB.map(c => c.entry)

    assert.ok(entriesA.includes('fnA'), 'pkg-a manifest should include fnA')
    assert.ok(entriesA.includes('helperA'), 'pkg-a manifest should include helperA')
    assert.ok(entriesB.includes('fnB'), 'pkg-b manifest should include fnB')

    // Cross-contamination check
    assert.ok(!entriesA.includes('fnB'), 'pkg-a should NOT include fnB from pkg-b')
    assert.ok(!entriesB.includes('fnA'), 'pkg-b should NOT include fnA from pkg-a')
  })

  it('reports scope mode as workspace', () => {
    const result = runInstall(['--scope', 'packages/', '--skip-capture'])
    assert.ok(result.stdout.includes('Scope: workspace'), 'should indicate workspace mode')
    assert.ok(result.stdout.includes('2 package(s)'), 'should report 2 packages found')
  })

  it('shows workspace summary with totals', () => {
    const result = runInstall(['--scope', 'packages/', '--skip-capture'])
    assert.ok(result.stdout.includes('WORKSPACE SUMMARY'), 'should include workspace summary')
    assert.ok(result.stdout.includes('Workspace Totals'), 'should include workspace totals')
    assert.ok(result.stdout.includes('Packages: 2'), 'should show 2 packages')
    assert.ok(result.stdout.includes('Files scanned:'), 'should show file count')
  })
})

describe('--scope and --dir mutual exclusivity', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('errors when both --scope and --dir are provided', () => {
    const result = runInstall(['--scope', 'src/utils/', '--dir', 'src/', '--skip-capture'])
    assert.notEqual(result.exitCode, 0, 'should exit with non-zero code')
    assert.ok(
      result.stderr.includes('--scope and --dir cannot be used together'),
      'should explain mutual exclusivity'
    )
  })
})

describe('--scope with nonexistent path', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('errors when scope path does not exist', () => {
    const result = runInstall(['--scope', 'nonexistent/path.js', '--skip-capture'])
    assert.notEqual(result.exitCode, 0, 'should exit with non-zero code')
    assert.ok(
      result.stderr.includes('Scope path not found'),
      'should report scope path not found'
    )
  })
})

describe('Default behavior unchanged (no --scope)', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('scans from cwd and creates manifest at regrets/', () => {
    const result = runInstall(['--skip-capture'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    assert.ok(existsSync(manifestPath), 'manifest.json should exist at regrets/')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const entries = manifest.clusters.map(c => c.entry)
    // Should include functions from ALL files, not just one scope
    assert.ok(entries.length >= 4, `should find functions across all files, found ${entries.length}`)
  })

  it('does not show scope mode label', () => {
    const result = runInstall(['--skip-capture'])
    assert.ok(!result.stdout.includes('Scope:'), 'should not show scope label in default mode')
  })
})

describe('--scope --dry-run', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('previews without writing files', () => {
    const result = runInstall(['--scope', 'src/utils/math.js', '--dry-run'])
    assert.equal(result.exitCode, 0)

    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    assert.ok(!existsSync(manifestPath), 'manifest should NOT be written in dry-run mode')
    assert.ok(result.stdout.includes('DRY RUN'), 'should indicate dry-run mode')
  })
})

describe('--scope --help', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('shows help text including --scope flag', () => {
    const result = runInstall(['--help'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)
    assert.ok(result.stdout.includes('--scope'), 'help should mention --scope')
    assert.ok(result.stdout.includes('Target a specific file'), 'help should describe --scope')
  })
})

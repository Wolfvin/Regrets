// tests/install-dry-run.test.js — Tests for `regret install --dry-run` (#249)
//
// Covers:
//   - default-mode --dry-run (no --scope): preview without writing files
//   - --dry-run --json: machine-readable JSON-only output for CI consumption
//   - --json without --dry-run: warns and ignores --json
//
// Run: node --test tests/install-dry-run.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
  readFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')

const TMP = resolve(join(process.cwd(), 'tests', '__install_dryrun_tmp__'))

function setupFixtures() {
  mkdirSync(join(TMP, 'src'), { recursive: true })
  // Functions that return meaningful strings even with [null, {}] inputs —
  // matches the pattern used by tests/scope.test.js to avoid the trivial-
  // inputs guard.
  writeFileSync(join(TMP, 'src', 'math.js'), `
export function add(a) { return 'add:' + String(a) }
export function multiply(a) { return 'mul:' + String(a) }
`)
  writeFileSync(join(TMP, 'src', 'string.js'), `
export function capitalize(a) { return 'cap:' + String(a) }
`)
}

function cleanupFixtures() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
}

/**
 * Run install.js with given args and return { exitCode, stdout, stderr }.
 * Uses spawnSync (not execFileSync) so we can capture stderr even on exit 0.
 */
function runInstall(args) {
  const result = spawnSync('node', [INSTALL_JS, ...args], {
    cwd: TMP,
    stdio: 'pipe',
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ? result.stdout.toString() : '',
    stderr: result.stderr ? result.stderr.toString() : '',
  }
}

describe('--dry-run (default mode, no --scope)', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('previews without writing manifest or regrets/', () => {
    const result = runInstall(['--dry-run'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifestPath = join(TMP, 'regrets', 'manifest.json')
    assert.ok(!existsSync(manifestPath), 'manifest.json must NOT be written in --dry-run mode')
    assert.ok(!existsSync(join(TMP, 'regrets')), 'regrets/ directory must NOT be created in --dry-run mode')
  })

  it('includes a DRY RUN marker and the proposed manifest JSON in stdout', () => {
    const result = runInstall(['--dry-run'])
    assert.ok(result.stdout.includes('DRY RUN'), 'stdout should include "DRY RUN" marker')
    assert.ok(result.stdout.includes('"clusters"'), 'stdout should include the proposed manifest JSON')
    // Should mention the discovered entries
    assert.ok(result.stdout.includes('add'), 'stdout should mention discovered function "add"')
    assert.ok(result.stdout.includes('multiply'), 'stdout should mention discovered function "multiply"')
    assert.ok(result.stdout.includes('capitalize'), 'stdout should mention discovered function "capitalize"')
  })

  it('does not execute capture (no .regret files written)', () => {
    const result = runInstall(['--dry-run'])
    assert.equal(result.exitCode, 0)
    // No .regret files should exist anywhere in the project
    const regretsDir = join(TMP, 'regrets')
    if (existsSync(regretsDir)) {
      const regretFiles = readFileSync(join(regretsDir, 'manifest.json'), 'utf8').toString()
      assert.fail(`regrets/ should not exist; found:\n${regretFiles}`)
    }
    // Capture output should NOT mention running capture
    assert.ok(!result.stdout.toLowerCase().includes('capturing'), 'should not run capture in --dry-run mode')
  })
})

describe('--dry-run --json (CI-friendly machine output)', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('emits ONLY valid JSON to stdout (no human-readable text)', () => {
    const result = runInstall(['--dry-run', '--json'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    // stdout must be parseable as JSON
    let parsed
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout) }, 'stdout must be valid JSON')

    // Must be an object with a `clusters` array
    assert.ok(parsed && typeof parsed === 'object', 'parsed output must be an object')
    assert.ok(Array.isArray(parsed.clusters), 'parsed.clusters must be an array')

    // Human-readable markers must NOT be present
    assert.ok(!result.stdout.includes('DRY RUN'), 'JSON output must not include "DRY RUN" marker')
    assert.ok(!result.stdout.includes('Run without --dry-run'), 'JSON output must not include human-readable footer')
    assert.ok(!result.stdout.includes('new clusters would be added'), 'JSON output must not include human-readable summary')
  })

  it('includes all discovered clusters in the JSON output', () => {
    const result = runInstall(['--dry-run', '--json'])
    assert.equal(result.exitCode, 0)

    const parsed = JSON.parse(result.stdout)
    const entries = parsed.clusters.map(c => c.entry)

    assert.ok(entries.includes('add'), 'JSON clusters should include "add"')
    assert.ok(entries.includes('multiply'), 'JSON clusters should include "multiply"')
    assert.ok(entries.includes('capitalize'), 'JSON clusters should include "capitalize"')
  })

  it('cluster entries conform to the manifest schema (have id, entry, file, stack)', () => {
    const result = runInstall(['--dry-run', '--json'])
    assert.equal(result.exitCode, 0)

    const parsed = JSON.parse(result.stdout)
    for (const cluster of parsed.clusters) {
      assert.ok(typeof cluster.id === 'string' && cluster.id.length > 0, `cluster.id must be non-empty string, got: ${JSON.stringify(cluster.id)}`)
      assert.ok(typeof cluster.entry === 'string' && cluster.entry.length > 0, `cluster.entry must be non-empty string, got: ${JSON.stringify(cluster.entry)}`)
      assert.ok(typeof cluster.file === 'string' && cluster.file.length > 0, `cluster.file must be non-empty string, got: ${JSON.stringify(cluster.file)}`)
      assert.ok(typeof cluster.stack === 'string' && cluster.stack.length > 0, `cluster.stack must be non-empty string, got: ${JSON.stringify(cluster.stack)}`)
    }
  })

  it('does NOT write manifest.json or regrets/', () => {
    const result = runInstall(['--dry-run', '--json'])
    assert.equal(result.exitCode, 0)

    assert.ok(!existsSync(join(TMP, 'regrets', 'manifest.json')), 'manifest.json must NOT be written')
    assert.ok(!existsSync(join(TMP, 'regrets')), 'regrets/ must NOT be created')
  })

  it('is pipeable to jq-style consumers (output ends with a newline)', () => {
    const result = runInstall(['--dry-run', '--json'])
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.endsWith('\n'), 'JSON output must end with newline for clean pipe behavior')
  })
})

describe('--json without --dry-run (graceful fallback)', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('warns on stderr that --json requires --dry-run', () => {
    // Use --skip-capture so we don't actually try to run capture during this test
    const result = runInstall(['--json', '--skip-capture'])
    // Should still exit 0 (we accept --json but ignore it outside dry-run)
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)
    assert.ok(
      result.stderr.includes('--json is currently only supported with --dry-run'),
      'stderr should warn that --json requires --dry-run'
    )
  })
})

describe('--dry-run is idempotent across runs', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('two consecutive --dry-run invocations produce identical output', () => {
    const r1 = runInstall(['--dry-run', '--json'])
    const r2 = runInstall(['--dry-run', '--json'])
    assert.equal(r1.exitCode, 0)
    assert.equal(r2.exitCode, 0)
    assert.equal(r1.stdout, r2.stdout, 'consecutive --dry-run --json runs must produce identical output')
  })
})

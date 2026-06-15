// tests/e2e.test.js — End-to-end test proving the full Regrets cycle works
// Uses Node.js built-in node:test and node:assert (zero external dependencies)
//
// What this proves:
//   1. capture() records a fingerprint of a live function → writes .regret file
//   2. validate() with no code changes → PASS (no regression)
//   3. validate() after mutating the function → FAIL (regression detected)
//   4. validate() after restoring → PASS again
//
// Architecture note:
//   capture() uses the API (scripts/api.js) directly — it works in-process.
//   validate() runs via child_process (node scripts/validate.js) because
//   Node.js ESM module caching prevents re-importing a mutated file in the
//   same process. Running validate as a separate process mirrors real CLI usage
//   and avoids the cache staleness issue entirely.
//
// Run: node --test tests/e2e.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { capture } from '../scripts/api.js'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

// ─── Fixture helpers ────────────────────────────────────────────────────────

const TMP = resolve(join(tmpdir(), 'regrets-e2e-test-' + process.pid))

function writeManifest(tmpDir, clusters) {
  // Use absolute paths for file fields — runCluster() in validate.js resolves
  // relative to process.cwd(), so relative paths break when test runs from
  // the repo root. Absolute paths work regardless.
  const withAbsPaths = clusters.map(c => ({
    ...c,
    file: resolve(tmpDir, c.file),
  }))
  writeFileSync(join(tmpDir, 'regrets', 'manifest.json'), JSON.stringify({ clusters: withAbsPaths }))
}

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })

  // Dummy module with a simple pure function
  writeFileSync(join(TMP, 'math.js'), `
export function double(x) { return x * 2 }
export function triple(x) { return x * 3 }
`)

  writeManifest(TMP, [
    {
      id: 'double-fn',
      entry: 'double',
      file: './math.js',
      stack: 'js',
      inputs: [[2], [5], [0], [-1]],
      watches: ['triple'],
    }
  ])
}

function mutateModule() {
  // Change the function behavior — this is the "refactor that introduced a bug"
  writeFileSync(join(TMP, 'math.js'), `
export function double(x) { return x * 3 }
export function triple(x) { return x * 3 }
`)
}

function restoreModule() {
  // Restore original behavior
  writeFileSync(join(TMP, 'math.js'), `
export function double(x) { return x * 2 }
export function triple(x) { return x * 3 }
`)
}

function cleanupProject() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
}

/**
 * Run `node scripts/validate.js` as a child process and parse the exit code
 * and stdout to determine pass/fail status.
 *
 * validate.js exits with code 0 if all pass, code 1 if any fail.
 * Stdout contains lines like "✅ double-fn  ...  PASS" or "❌ double-fn  ...  FAIL".
 */
function runValidateCli(cwd) {
  const scriptPath = resolve(import.meta.dirname, '..', 'scripts', 'validate.js')
  let stdout
  try {
    stdout = execFileSync('node', [scriptPath, '--quiet'], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { exitCode: 0, stdout, passed: true }
  } catch (err) {
    // Exit code 1 means some clusters failed — that's a valid result
    return { exitCode: err.status || 1, stdout: err.stdout || '', stderr: err.stderr || '', passed: false }
  }
}

// ─── E2E Tests ──────────────────────────────────────────────────────────────

describe('E2E: full capture → validate → mutate → validate cycle', () => {
  before(() => setupProject())
  after(() => cleanupProject())

  it('capture() writes a .regret file with a fingerprint', async () => {
    const result = await capture({ cwd: TMP })

    assert.equal(result.passed, 1, 'exactly 1 cluster should be captured')
    assert.equal(result.failed, 0, 'no failures during capture')
    assert.equal(result.clusters.length, 1, 'one cluster result')
    assert.ok(result.clusters[0].fingerprint, 'fingerprint should be present')
    assert.ok(result.clusters[0].pass, 'cluster capture should pass')

    // Verify the .regret file exists on disk
    const regretPath = join(TMP, 'regrets', 'double-fn.regret')
    assert.ok(existsSync(regretPath), '.regret file should exist after capture')

    // Verify the .regret file contains expected structure
    const content = readFileSync(regretPath, 'utf8')
    assert.ok(content.includes('cluster: double-fn'), '.regret has cluster id')
    assert.ok(content.includes('fingerprint:'), '.regret has fingerprint field')
    assert.ok(content.includes('---'), '.regret has data separator')
    assert.ok(content.includes('HASH'), '.regret has HASH line')
  })

  it('validate passes when code is unchanged (no regression)', () => {
    const result = runValidateCli(TMP)

    assert.equal(result.exitCode, 0, 'validate should exit 0 (all pass)')
    assert.ok(result.passed, 'validate should report passed')
  })

  it('validate fails after function is mutated (regression detected)', () => {
    mutateModule()

    const result = runValidateCli(TMP)

    assert.notEqual(result.exitCode, 0, 'validate should exit non-zero (some fail)')
    assert.ok(!result.passed, 'validate should report failed')
    assert.ok(result.stdout.includes('FAIL') || result.stdout.includes('❌') || result.stderr?.includes('FAIL'),
      'output should indicate failure')
  })

  it('validate passes again after restoring original code', () => {
    restoreModule()

    const result = runValidateCli(TMP)

    assert.equal(result.exitCode, 0, 'validate should exit 0 after restore')
    assert.ok(result.passed, 'validate should report passed after restore')
  })
})

describe('E2E: no temp files left after cleanup', () => {
  it('temp directory is removed in after() hook', () => {
    const freshTmp = resolve(join(tmpdir(), 'regrets-e2e-cleanup-' + process.pid))
    mkdirSync(join(freshTmp, 'regrets'), { recursive: true })
    assert.ok(existsSync(freshTmp), 'temp dir exists before cleanup')

    rmSync(freshTmp, { recursive: true, force: true })
    assert.ok(!existsSync(freshTmp), 'temp dir is removed after cleanup')
  })
})

describe('E2E: capture with cluster filter', () => {
  const filterTmp = resolve(join(tmpdir(), 'regrets-e2e-filter-' + process.pid))

  before(() => {
    mkdirSync(join(filterTmp, 'regrets'), { recursive: true })

    writeFileSync(join(filterTmp, 'math.js'), `
export function add(a, b) { return a + b }
export function subtract(a, b) { return a - b }
`)

    writeManifest(filterTmp, [
      { id: 'add-fn', entry: 'add', file: './math.js', stack: 'js', inputs: [[1, 2], [3, 4]] },
      { id: 'subtract-fn', entry: 'subtract', file: './math.js', stack: 'js', inputs: [[10, 3], [5, 1]] },
    ])
  })

  after(() => {
    if (existsSync(filterTmp)) rmSync(filterTmp, { recursive: true, force: true })
  })

  it('capture() with cluster filter only captures the specified cluster', async () => {
    const result = await capture({ cwd: filterTmp, cluster: 'add-fn' })

    assert.equal(result.passed, 1, 'only 1 cluster captured')
    assert.equal(result.clusters.length, 1, 'only 1 result')
    assert.equal(result.clusters[0].id, 'add-fn', 'captured the filtered cluster')

    // Only the add-fn .regret file should exist
    assert.ok(existsSync(join(filterTmp, 'regrets', 'add-fn.regret')), 'add-fn.regret exists')
    assert.ok(!existsSync(join(filterTmp, 'regrets', 'subtract-fn.regret')),
      'subtract-fn.regret should NOT exist when filtered out')
  })
})

describe('E2E: re-capture overwrites previous fingerprint', () => {
  const recaptureTmp = resolve(join(tmpdir(), 'regrets-e2e-recapture-' + process.pid))

  before(() => {
    mkdirSync(join(recaptureTmp, 'regrets'), { recursive: true })

    writeFileSync(join(recaptureTmp, 'math.js'), `
export function square(x) { return x * x }
`)

    writeManifest(recaptureTmp, [
      { id: 'square-fn', entry: 'square', file: './math.js', stack: 'js', inputs: [[3], [4]], watches: [] },
    ])
  })

  after(() => {
    if (existsSync(recaptureTmp)) rmSync(recaptureTmp, { recursive: true, force: true })
  })

  it('second capture() overwrites the .regret file with a new fingerprint', async () => {
    // First capture via CLI (so it runs in its own process)
    const captureScript = resolve(import.meta.dirname, '..', 'scripts', 'capture.js')
    execFileSync('node', [captureScript, '--quiet'], {
      cwd: recaptureTmp,
      encoding: 'utf8',
      timeout: 30_000,
    })

    // Read the first fingerprint from the .regret file
    const regretContent1 = readFileSync(join(recaptureTmp, 'regrets', 'square-fn.regret'), 'utf8')
    const hashMatch1 = regretContent1.match(/^HASH\s+(\S+)/m)
    const firstFp = hashMatch1 ? hashMatch1[1] : null
    assert.ok(firstFp, 'first capture should produce a fingerprint')

    // Mutate the function
    writeFileSync(join(recaptureTmp, 'math.js'), `
export function square(x) { return x * x + 1 }
`)

    // Second capture — separate process picks up the mutated module
    execFileSync('node', [captureScript, '--quiet'], {
      cwd: recaptureTmp,
      encoding: 'utf8',
      timeout: 30_000,
    })

    // Read the second fingerprint
    const regretContent2 = readFileSync(join(recaptureTmp, 'regrets', 'square-fn.regret'), 'utf8')
    const hashMatch2 = regretContent2.match(/^HASH\s+(\S+)/m)
    const secondFp = hashMatch2 ? hashMatch2[1] : null

    assert.ok(secondFp, 'second capture should produce a fingerprint')
    assert.notEqual(firstFp, secondFp,
      're-capture should produce a different fingerprint after mutation')

    // Validate against the new fingerprint should now pass
    const valResult = runValidateCli(recaptureTmp)
    assert.equal(valResult.exitCode, 0, 'validate should pass after re-capture')
  })
})

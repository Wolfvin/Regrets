// tests/diff-callee.test.js — Callee contract diff in regret diff (#282)
//
// Verifies that `regret diff` correctly diffs callee contracts instead of
// silently skipping them with a misleading "not in manifest" warning.
// Previously, callee .regret files (e.g. main.calls.add.regret) were skipped
// because their IDs are not in the manifest — but that is by design.
//
// Contract:
//   - Callee contracts (.calls.* pattern) are diffed using their parent's
//     module definition, with the callee name as the entry point.
//   - When callee output matches golden: shows ✅ with [callee] tag
//   - When callee output differs: shows ❌ with [callee] tag + diff details
//   - --cluster <parent> filter includes callee contracts of that parent
//   - Truly orphaned files (not in manifest AND not .calls.* pattern) still
//     show "not in manifest — skipping" warning
//   - Callee with parent not in manifest shows specific warning about parent
//
// Run: node --test tests/diff-callee.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const DIFF_JS     = join(SCRIPTS_DIR, 'diff.js')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')

// ─── Helpers ────────────────────────────────────────────────────────

const TMP = resolve(join(process.cwd(), 'tests', `__diff_callee_${process.pid}__`))

const API_SOURCE = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`

const MANIFEST_WITH_CALLEES = {
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
}

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), API_SOURCE)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(MANIFEST_WITH_CALLEES, null, 2))
}

function rewriteApi(apiSource) {
  writeFileSync(join(TMP, 'api.mjs'), apiSource)
}

function rewriteManifest(manifest) {
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))
}

function runDiff(cwd, args = []) {
  const result = spawnSync('node', [DIFF_JS, ...args], {
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

// ─── Tests ──────────────────────────────────────────────────────────

describe('regret diff: callee contracts (#282)', () => {
  before(() => {
    setupProject()
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('diffs callee contracts with [callee] tag when nothing changed', () => {
    const result = runDiff(TMP)
    // Exit 0 because nothing changed
    assert.equal(result.exitCode, 0, `diff should exit 0 when no changes\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    // Callee contracts should be diffed (not skipped)
    assert.match(
      result.stdout,
      /main\.calls\.add.*\[callee\]/,
      'should show main.calls.add with [callee] tag'
    )
    assert.match(
      result.stdout,
      /main\.calls\.mul.*\[callee\]/,
      'should show main.calls.mul with [callee] tag'
    )

    // Should NOT show "not in manifest — skipping" for callee contracts
    assert.doesNotMatch(
      result.stdout,
      /main\.calls\.(add|mul).*not in manifest/,
      'should NOT show "not in manifest" warning for callee contracts'
    )
  })

  it('detects callee regression and shows diff details', () => {
    // Mutate add() to subtract instead of add
    rewriteApi(`
function add(a, b) { return a - b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`)

    const result = runDiff(TMP)
    assert.equal(result.exitCode, 1, `diff should exit 1 on callee regression\nstdout: ${result.stdout}`)

    // main.calls.add should show ❌ with [callee] tag
    assert.match(
      result.stdout,
      /❌\s+main\.calls\.add.*\[callee\]/,
      'should show main.calls.add as failed with [callee] tag'
    )

    // main.calls.mul should still pass
    assert.match(
      result.stdout,
      /✅\s+main\.calls\.mul.*\[callee\]/,
      'should show main.calls.mul as passed with [callee] tag'
    )

    // Should show diff details (≠ icon appears after the callee ❌ line)
    assert.match(
      result.stdout,
      /≠/,
      'should show diff details for changed callee'
    )
    // The diff output should show golden vs live values
    assert.match(
      result.stdout,
      /golden:.*6/,
      'should show golden output in diff details'
    )
    assert.match(
      result.stdout,
      /live:.*4/,
      'should show live output in diff details'
    )
  })

  it('still skips truly orphaned files with "not in manifest" warning', () => {
    // Add an orphaned .regret file that is NOT a callee pattern
    writeFileSync(
      join(TMP, 'regrets', 'orphaned-cluster.regret'),
      'fingerprint: abc123\nentry: orphaned\ncaptured: 2025-01-01T00:00:00Z\n\n---\n\nINPUT 1\nOUTPUT 2\n'
    )

    const result = runDiff(TMP)

    // Truly orphaned file should still show "not in manifest" warning
    // console.warn goes to stderr
    const combinedOutput = result.stdout + result.stderr
    assert.match(
      combinedOutput,
      /orphaned-cluster.*not in manifest.*skipping/,
      'should still warn about truly orphaned files'
    )

    // Callee contracts should NOT show this warning
    assert.doesNotMatch(
      combinedOutput,
      /main\.calls\.(add|mul).*not in manifest.*skipping/,
      'callee contracts should NOT show "not in manifest" warning'
    )
  })
})

describe('regret diff: --cluster filter includes callees (#282)', () => {
  before(() => {
    setupProject()
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('--cluster <parent> includes callee contracts in diff', () => {
    const result = runDiff(TMP, ['--cluster', 'main'])
    assert.equal(result.exitCode, 0, `diff --cluster main should exit 0\nstdout: ${result.stdout}`)

    // Both parent and callee contracts should be diffed
    assert.match(
      result.stdout,
      /main\b/,
      'should diff parent cluster "main"'
    )
    assert.match(
      result.stdout,
      /main\.calls\.add.*\[callee\]/,
      'should diff main.calls.add with --cluster main'
    )
    assert.match(
      result.stdout,
      /main\.calls\.mul.*\[callee\]/,
      'should diff main.calls.mul with --cluster main'
    )
  })

  it('--cluster <parent> detects callee regression', () => {
    rewriteApi(`
function add(a, b) { return a - b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`)

    const result = runDiff(TMP, ['--cluster', 'main'])
    assert.equal(result.exitCode, 1, `diff --cluster main should exit 1 on regression\nstdout: ${result.stdout}`)

    // Callee regression should be detected
    assert.match(
      result.stdout,
      /❌\s+main\.calls\.add.*\[callee\]/,
      'should detect main.calls.add regression with --cluster main'
    )
  })
})

describe('regret diff: callee with parent not in manifest (#282)', () => {
  before(() => {
    setupProject()
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('shows specific warning when callee parent is not in manifest', () => {
    // Remove parent from manifest but keep callee .regret files
    rewriteManifest({ clusters: [] })

    const result = runDiff(TMP)

    // Should warn about parent not in manifest (not generic "not in manifest")
    // console.warn goes to stderr
    const combinedOutput = result.stdout + result.stderr
    assert.match(
      combinedOutput,
      /main\.calls\.add.*parent "main" not in manifest.*skipping/,
      'should warn about callee parent not being in manifest for main.calls.add'
    )
    assert.match(
      combinedOutput,
      /main\.calls\.mul.*parent "main" not in manifest.*skipping/,
      'should warn about callee parent not being in manifest for main.calls.mul'
    )
  })
})

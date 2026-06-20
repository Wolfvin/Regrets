// tests/list-callee.test.js — Callee contract display in regret list (#281)
//
// Verifies that `regret list` correctly separates callee contracts from truly
// orphaned files. Previously, callee .regret files (e.g. main.calls.add.regret)
// were reported as "Orphaned .regret files" because their IDs are not in the
// manifest — but that is by design (callee contracts are derived from their
// parent cluster by capture.js, per PR #240/#258).
//
// Contract:
//   - Callee contracts (.calls.* pattern) shown in "Callee contracts (N)" section
//   - Truly orphaned files (not in manifest AND not .calls.* pattern) still
//     shown in "Orphaned .regret files" section
//   - --json output includes "calleeContracts" array and "orphaned" array
//   - Callee with parent in manifest shows parent reference
//   - Callee without parent in manifest shows "(not in manifest)" note
//
// Run: node --test tests/list-callee.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const LIST_JS     = join(SCRIPTS_DIR, 'list.js')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')

// ─── Helpers ────────────────────────────────────────────────────────

const TMP = resolve(join(process.cwd(), 'tests', `__list_callee_${process.pid}__`))

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

function rewriteManifest(manifest) {
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))
}

function runList(cwd, args = []) {
  const result = spawnSync('node', [LIST_JS, ...args], {
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

describe('regret list: callee contracts (#281)', () => {
  before(() => {
    setupProject()
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('shows callee contracts in "Callee contracts (N)" section, NOT as orphaned', () => {
    const result = runList(TMP)
    assert.equal(result.exitCode, 0, `list should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    // Callee contracts should appear in their own section
    assert.match(
      result.stdout,
      /📞 Callee contracts \(2\)/,
      'should show "Callee contracts (2)" section header'
    )

    // Each callee should be listed with .regret suffix
    assert.match(
      result.stdout,
      /main\.calls\.add\.regret/,
      'should list main.calls.add.regret'
    )
    assert.match(
      result.stdout,
      /main\.calls\.mul\.regret/,
      'should list main.calls.mul.regret'
    )

    // Callee contracts must NOT appear in the orphaned section
    // If "Orphaned" section appears, it should NOT contain callee files
    const orphanedSection = result.stdout.match(/⚠️\s+Orphaned.*?\n([\s\S]*?)(?:\n\n|\n$|$)/)
    if (orphanedSection) {
      assert.doesNotMatch(
        orphanedSection[1],
        /\.calls\./,
        'callee contracts should NOT appear in orphaned section'
      )
    }
  })

  it('shows parent reference for callee contracts', () => {
    const result = runList(TMP)
    assert.match(
      result.stdout,
      /parent: main\b/,
      'should show parent cluster reference'
    )
    assert.doesNotMatch(
      result.stdout,
      /parent: main \(not in manifest\)/,
      'parent is in manifest, should not show "not in manifest" note'
    )
  })

  it('still reports truly orphaned files in "Orphaned .regret files" section', () => {
    // Add an orphaned .regret file that is NOT a callee pattern
    writeFileSync(
      join(TMP, 'regrets', 'orphaned-cluster.regret'),
      'fingerprint: abc123\nentry: orphaned\ncaptured: 2025-01-01T00:00:00Z\n\n---\n\nINPUT 1\nOUTPUT 2\n'
    )

    const result = runList(TMP)

    // Truly orphaned file should appear in the orphaned section
    assert.match(
      result.stdout,
      /⚠️\s+Orphaned \.regret files \(not in manifest\)/,
      'should show orphaned section header'
    )
    assert.match(
      result.stdout,
      /orphaned-cluster\.regret/,
      'should list orphaned-cluster.regret as orphaned'
    )

    // Callee files should still be in their own section, not orphaned
    assert.match(
      result.stdout,
      /📞 Callee contracts/,
      'callee section should still appear'
    )
  })

  it('shows "not in manifest" note for callee with missing parent', () => {
    // Remove parent from manifest but keep callee .regret files
    rewriteManifest({ clusters: [] })

    const result = runList(TMP)

    // Should show callee contracts with parent-not-in-manifest note
    assert.match(
      result.stdout,
      /📞 Callee contracts/,
      'should still show callee contracts section'
    )
    assert.match(
      result.stdout,
      /parent: main \(not in manifest\)/,
      'should show "not in manifest" note for orphan callee'
    )
  })
})

describe('regret list --json: callee contracts (#281)', () => {
  before(() => {
    setupProject()
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('includes calleeContracts array in JSON output', () => {
    const result = runList(TMP, ['--json'])
    assert.equal(result.exitCode, 0, `list --json should exit 0\nstdout: ${result.stdout}`)

    const json = JSON.parse(result.stdout)
    assert.ok(Array.isArray(json.calleeContracts), 'JSON should have calleeContracts array')
    assert.equal(json.calleeContracts.length, 2, 'should have 2 callee contracts')

    const addContract = json.calleeContracts.find(c => c.id === 'main.calls.add')
    assert.ok(addContract, 'should have main.calls.add entry')
    assert.equal(addContract.parent, 'main', 'callee parent should be "main"')
    assert.equal(addContract.calleeName, 'add', 'calleeName should be "add"')
    assert.equal(addContract.parentInManifest, true, 'parent should be in manifest')
    assert.ok(addContract.fingerprint, 'should have a fingerprint')

    const mulContract = json.calleeContracts.find(c => c.id === 'main.calls.mul')
    assert.ok(mulContract, 'should have main.calls.mul entry')
    assert.equal(mulContract.parent, 'main', 'callee parent should be "main"')
    assert.equal(mulContract.calleeName, 'mul', 'calleeName should be "mul"')
  })

  it('includes orphaned array in JSON output (empty when no orphans)', () => {
    const result = runList(TMP, ['--json'])
    const json = JSON.parse(result.stdout)
    assert.ok(Array.isArray(json.orphaned), 'JSON should have orphaned array')
    // No truly orphaned files in this setup
    assert.equal(json.orphaned.length, 0, 'should have 0 orphaned files')
  })

  it('populates orphaned array with truly orphaned files only', () => {
    // Add an orphaned .regret file
    writeFileSync(
      join(TMP, 'regrets', 'orphaned-cluster.regret'),
      'fingerprint: abc123\nentry: orphaned\ncaptured: 2025-01-01T00:00:00Z\n\n---\n\nINPUT 1\nOUTPUT 2\n'
    )

    const result = runList(TMP, ['--json'])
    const json = JSON.parse(result.stdout)

    assert.ok(Array.isArray(json.orphaned), 'JSON should have orphaned array')
    assert.equal(json.orphaned.length, 1, 'should have 1 orphaned file')
    assert.equal(json.orphaned[0], 'orphaned-cluster', 'orphaned file should be "orphaned-cluster"')

    // Callee contracts should NOT be in the orphaned array
    assert.ok(
      !json.orphaned.includes('main.calls.add'),
      'callee contracts should not be in orphaned array'
    )
    assert.ok(
      !json.orphaned.includes('main.calls.mul'),
      'callee contracts should not be in orphaned array'
    )
  })

  it('marks callee as parentInManifest=false when parent removed', () => {
    rewriteManifest({ clusters: [] })

    const result = runList(TMP, ['--json'])
    const json = JSON.parse(result.stdout)

    assert.equal(json.calleeContracts.length, 2, 'should still have 2 callee contracts')
    for (const cc of json.calleeContracts) {
      assert.equal(cc.parentInManifest, false, `${cc.id} parent should not be in manifest`)
    }
  })
})

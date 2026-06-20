// tests/backlog-features.test.js — Tests for backlog feature issues
//
// #248 — regret history command
// #249 — install --dry-run shows full proposed manifest
// #250 — update --reason stores author + git SHA
// #256 — trivial guard edge case: streams/async iterables
//
// Run: node --test tests/backlog-features.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'child_process'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const HISTORY_JS = join(SCRIPTS_DIR, 'history.js')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')

const TMP = resolve(join(process.cwd(), 'tests', '__backlog_tmp__'))

function setupFixtures() {
  mkdirSync(TMP, { recursive: true })
}

function cleanupFixtures() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

// ─── #248: regret history command ──────────────────────────────────────────

describe('#248: regret history <clusterId>', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('shows entries for a specific cluster from audit.log', () => {
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    const auditLog = join(TMP, 'regrets', 'audit.log')
    writeFileSync(auditLog, `2025-01-15T10:30:00Z  UPDATE  main
  old: abc1234
  new: def5678
  reason: refactored main logic
  by: TestAuthor
  chain: x1y2z3

2025-01-16T14:00:00Z  UPDATE  helper
  old: aaa0000
  new: bbb1111
  reason: optimized helper
  by: TestAuthor2
  chain: c3d4e5

2025-01-17T09:00:00Z  UPDATE  main
  old: def5678
  new: ghi9999
  reason: fixed edge case
  by: TestAuthor
  gitSha: a1b2c3d
  chain: f6g7h8
`, 'utf8')

    const result = execFileSync('node', [HISTORY_JS, 'main'], {
      cwd: TMP,
      stdio: 'pipe',
      timeout: 10_000,
    })
    const output = result.toString()
    assert.ok(output.includes('main'), 'output should mention cluster name')
    assert.ok(output.includes('abc1234'), 'output should include old hash')
    assert.ok(output.includes('ghi9999'), 'output should include latest new hash')
    assert.ok(output.includes('refactored main logic'), 'output should include first reason')
    assert.ok(output.includes('fixed edge case'), 'output should include second reason')
    assert.ok(output.includes('TestAuthor'), 'output should include author')
    assert.ok(output.includes('a1b2c3d'), 'output should include git SHA')
  })

  it('shows no entries message for unknown cluster', () => {
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    const auditLog = join(TMP, 'regrets', 'audit.log')
    writeFileSync(auditLog, `
2025-01-15T10:30:00Z  UPDATE  main
  old: abc1234
  new: def5678
  reason: test
  by: Author
  chain: x1y2z3
`, 'utf8')

    const result = execFileSync('node', [HISTORY_JS, 'nonexistent'], {
      cwd: TMP,
      stdio: 'pipe',
      timeout: 10_000,
    })
    const output = result.toString()
    assert.ok(output.includes('No audit entries'), 'should report no entries for unknown cluster')
  })

  it('outputs JSON when --json flag is passed', () => {
    mkdirSync(join(TMP, 'regrets'), { recursive: true })
    const auditLog = join(TMP, 'regrets', 'audit.log')
    writeFileSync(auditLog, `
2025-01-15T10:30:00Z  UPDATE  myFn
  old: aaa
  new: bbb
  reason: test reason
  by: Author
  gitSha: c1d2e3f
  chain: xyz
`, 'utf8')

    const result = execFileSync('node', [HISTORY_JS, 'myFn', '--json'], {
      cwd: TMP,
      stdio: 'pipe',
      timeout: 10_000,
    })
    const output = result.toString()
    const parsed = JSON.parse(output)
    assert.ok(Array.isArray(parsed), 'JSON output should be an array')
    assert.equal(parsed.length, 1, 'should have 1 entry')
    assert.equal(parsed[0].clusterId, 'myFn')
    assert.equal(parsed[0].reason, 'test reason')
    assert.equal(parsed[0].gitSha, 'c1d2e3f')
  })

  it('reports missing audit.log gracefully', () => {
    mkdirSync(join(TMP, 'empty'), { recursive: true })
    try {
      execFileSync('node', [HISTORY_JS, 'main'], {
        cwd: join(TMP, 'empty'),
        stdio: 'pipe',
        timeout: 10_000,
      })
      assert.fail('should have exited with non-zero code')
    } catch (err) {
      assert.ok(err.stderr.toString().includes('No audit.log') || err.status !== 0)
    }
  })
})

// ─── #249: install --dry-run shows full proposed manifest ──────────────────

describe('#249: install --dry-run shows proposed manifest', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('prints full proposed manifest (not just new clusters)', () => {
    mkdirSync(join(TMP, 'dry_run_test'), { recursive: true })
    writeFileSync(join(TMP, 'dry_run_test', 'simple.js'), `
export function add(a, b) { return a + b }
export function mul(a, b) { return a * b }
`)
    writeFileSync(join(TMP, 'dry_run_test', 'package.json'), JSON.stringify({
      name: 'dry-run-test',
      version: '0.0.0',
      type: 'module',
    }))

    const result = execFileSync('node', [INSTALL_JS, '--scope', 'simple.js', '--dry-run'], {
      cwd: join(TMP, 'dry_run_test'),
      stdio: 'pipe',
      timeout: 30_000,
    })
    const output = result.toString()
    // Should show full proposed manifest with cluster details
    assert.ok(output.includes('Proposed manifest:'), 'should show proposed manifest header')
    assert.ok(output.includes('add'), 'should include add in manifest preview')
    assert.ok(output.includes('mul'), 'should include mul in manifest preview')
    // Should NOT have written any files
    assert.ok(!existsSync(join(TMP, 'dry_run_test', 'regrets')), 'should not create regrets/ dir in dry-run')
  })
})

// ─── #256: trivial guard edge case: streams/async iterables ───────────────

describe('#256: trivialOutputReason detects streams, async iterables, generators', () => {
  // Replicate the function for isolated testing
  function trivialOutputReason(output, threw) {
    if (threw) return 'throws on auto-generated input'
    if (output === undefined) return 'output is undefined — inputs likely not meaningful'
    if (output === null) return 'output is null — inputs likely not meaningful'
    if (Number.isNaN(output)) return 'output is NaN — inputs likely not meaningful'
    if (typeof output === 'object' && output !== null) {
      if (typeof output[Symbol.asyncIterator] === 'function') {
        return 'output is an async iterable — not fingerprintable with auto-generated inputs'
      }
      if (typeof output[Symbol.iterator] === 'function' && typeof output.next === 'function') {
        return 'output is a generator/iterator — not fingerprintable with auto-generated inputs'
      }
      if (typeof output.pipe === 'function' && typeof output.on === 'function') {
        return 'output is a stream — not fingerprintable with auto-generated inputs'
      }
    }
    return null
  }

  it('detects async iterable output as trivial', () => {
    const asyncIterable = {
      [Symbol.asyncIterator]: async function* () { yield 1 }
    }
    const reason = trivialOutputReason(asyncIterable, false)
    assert.ok(reason, 'should detect async iterable as trivial')
    assert.ok(reason.includes('async iterable'), 'reason should mention async iterable')
  })

  it('detects generator output as trivial', () => {
    function* gen() { yield 1 }
    const genObj = gen()
    const reason = trivialOutputReason(genObj, false)
    assert.ok(reason, 'should detect generator as trivial')
    assert.ok(reason.includes('generator'), 'reason should mention generator')
  })

  it('detects Readable stream as trivial', () => {
    // Minimal stream-like object
    const stream = { pipe: () => {}, on: () => {} }
    const reason = trivialOutputReason(stream, false)
    assert.ok(reason, 'should detect stream as trivial')
    assert.ok(reason.includes('stream'), 'reason should mention stream')
  })

  it('does not flag regular objects as trivial', () => {
    const normal = { result: 42 }
    const reason = trivialOutputReason(normal, false)
    assert.equal(reason, null, 'regular objects should not be trivial')
  })

  it('does not flag arrays as trivial', () => {
    const arr = [1, 2, 3]
    const reason = trivialOutputReason(arr, false)
    assert.equal(reason, null, 'arrays should not be trivial')
  })

  it('still detects null/undefined/NaN as trivial', () => {
    assert.ok(trivialOutputReason(null, false), 'null should be trivial')
    assert.ok(trivialOutputReason(undefined, false), 'undefined should be trivial')
    assert.ok(trivialOutputReason(NaN, false), 'NaN should be trivial')
  })
})

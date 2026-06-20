// tests/update-metadata.test.js — Tests for #250
// `regret update --reason` stores author + git SHA + CI run id in audit.log
//
// These tests set up a real (temporary) git repo, run validate.js --update
// against a captured cluster, then assert the audit.log contains the new
// gitAuthor / gitSha / ciRunId fields. They also run `regret history` to
// confirm the metadata round-trips through the parser.
//
// Run: node --test tests/update-metadata.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')
const HISTORY_JS  = join(SCRIPTS_DIR, 'history.js')

// For tests that need a git repo, we use a TMP dir INSIDE the Regrets
// working tree (so the .git directory is reachable from cwd lookups).
const TMP = resolve(join(process.cwd(), 'tests', `__upd_meta_${process.pid}__`))

// For the "git unavailable" test, we use a directory OUTSIDE any git repo
// (system tmpdir) so `git config` and `git rev-parse` will fail.
const TMP_NO_GIT = join(tmpdir(), `regrets-no-git-${randomBytes(4).toString('hex')}`)

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: TMP, stdio: 'pipe', ...opts })
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ? r.stdout.toString() : '',
    stderr: r.stderr ? r.stderr.toString() : '',
  }
}

function shIn(dir, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', ...opts })
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ? r.stdout.toString() : '',
    stderr: r.stderr ? r.stderr.toString() : '',
  }
}

function setupProject() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  // Single-function module that always returns the same output for the
  // same input — needed so capture + initial validate PASS.
  writeFileSync(join(TMP, 'api.mjs'), `
export function double(x) { return x * 2 }
`)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: 'double',
      entry: 'double',
      watches: [],
      file: 'api.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [21],
    }],
  }, null, 2))

  // Initialize a git repo so validate.js can look up user.name + HEAD SHA
  sh('git', ['init', '-q'])
  sh('git', ['config', 'user.name', 'Test Worker'])
  sh('git', ['config', 'user.email', 'test@example.invalid'])
  sh('git', ['add', '.'])
  sh('git', ['commit', '-q', '-m', 'initial fixture'])
}

function cleanupProject() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

describe('regret update — audit.log metadata (#250)', () => {
  before(() => setupProject())
  after(() => cleanupProject())

  it('capture succeeds and writes the .regret file', () => {
    const r = sh('node', [CAPTURE_JS])
    assert.equal(r.exitCode, 0, `capture failed: ${r.stderr}`)
    assert.ok(existsSync(join(TMP, 'regrets', 'double.regret')), 'double.regret should exist')
  })

  it('after behavior change, --update writes audit.log entry with git metadata', () => {
    // Change behavior: double(x) → x * 2 + 1
    writeFileSync(join(TMP, 'api.mjs'), `
export function double(x) { return x * 2 + 1 }
`)

    // Commit the change so HEAD advances — that SHA should land in audit.log
    sh('git', ['add', '.'])
    sh('git', ['commit', '-q', '-m', 'change double behavior'])

    // Run validate --update with a 4+ word reason (required)
    const r = sh('node', [VALIDATE_JS, '--update', '--cluster', 'double', '--reason', 'shifted baseline for testing audit metadata capture'])
    assert.equal(r.exitCode, 0, `validate --update failed: ${r.stderr}\nstdout: ${r.stdout}`)

    const auditPath = join(TMP, 'regrets', 'audit.log')
    assert.ok(existsSync(auditPath), 'audit.log should be created by --update')
    const auditContent = readFileSync(auditPath, 'utf8')

    // Legacy fields still present (backward compat)
    assert.ok(auditContent.includes('UPDATE  double'), 'audit.log should include UPDATE event for double cluster')
    assert.ok(/old: \S+/.test(auditContent), 'audit.log should include old hash')
    assert.ok(/new: \S+/.test(auditContent), 'audit.log should include new hash')
    assert.ok(auditContent.includes('reason:'), 'audit.log should include reason field')
    assert.ok(auditContent.includes('by: AI refactor session'), 'audit.log should include legacy "by" line for backward compat')

    // New #250 fields
    assert.ok(
      auditContent.includes('gitAuthor: Test Worker <test@example.invalid>'),
      'audit.log should include gitAuthor field with name + email'
    )
    assert.ok(
      /gitSha: [0-9a-f]{7,}/.test(auditContent),
      'audit.log should include gitSha field with at least 7-char short SHA'
    )
    // Chain hash is still present and last
    assert.ok(/chain: [0-9a-f]+/.test(auditContent), 'audit.log should include chain hash')
  })

  it('regret history reads the new metadata and renders it', () => {
    const r = sh('node', [HISTORY_JS, 'double'])
    assert.equal(r.exitCode, 0, `history failed: ${r.stderr}`)

    assert.ok(r.stdout.includes('Test Worker <test@example.invalid>'), 'history should render gitAuthor as author')
    assert.ok(/git sha:\s+[0-9a-f]{7,}/.test(r.stdout), 'history should render git sha line')
  })

  it('regret history --json includes gitSha and gitAuthor fields', () => {
    const r = sh('node', [HISTORY_JS, 'double', '--json'])
    assert.equal(r.exitCode, 0)
    const parsed = JSON.parse(r.stdout)
    assert.ok(parsed.events.length >= 1, 'should have at least 1 event')
    const ev = parsed.events[0]
    assert.equal(ev.gitAuthor ?? ev.author, 'Test Worker <test@example.invalid>')
    assert.match(ev.gitSha, /^[0-9a-f]{7,}$/)
  })
})

describe('regret update — CI run id capture (#250)', () => {
  before(() => setupProject())
  after(() => cleanupProject())

  it('captures GITHUB_RUN_ID env var when set', () => {
    // Capture first
    const cap = sh('node', [CAPTURE_JS])
    assert.equal(cap.exitCode, 0, `capture failed: ${cap.stderr}`)

    // Change behavior
    writeFileSync(join(TMP, 'api.mjs'), `
export function double(x) { return x * 3 }
`)
    sh('git', ['add', '.'])
    sh('git', ['commit', '-q', '-m', 'change double behavior again'])

    // Run validate --update with GITHUB_RUN_ID set
    const r = spawnSync('node', [VALIDATE_JS, '--update', '--cluster', 'double', '--reason', 'trigger ci run id capture test'], {
      cwd: TMP,
      stdio: 'pipe',
      env: { ...process.env, GITHUB_RUN_ID: '1234567890' },
      timeout: 30_000,
    })
    assert.equal(r.status, 0, `validate --update failed: ${r.stderr ? r.stderr.toString() : ''}`)

    const auditContent = readFileSync(join(TMP, 'regrets', 'audit.log'), 'utf8')
    assert.ok(
      auditContent.includes('ciRunId: 1234567890'),
      'audit.log should include ciRunId field with GITHUB_RUN_ID value'
    )
  })

  it('regret history --json surfaces ciRunId', () => {
    const r = sh('node', [HISTORY_JS, 'double', '--json'])
    assert.equal(r.exitCode, 0)
    const parsed = JSON.parse(r.stdout)
    assert.ok(parsed.events.length >= 1)
    const ev = parsed.events.find(e => e.ciRunId === '1234567890')
    assert.ok(ev, 'should find an event with ciRunId=1234567890')
  })
})

describe('regret update — graceful when git is unavailable', () => {
  before(() => {
    // Setup project in TMP_NO_GIT (outside any git repo) WITHOUT git init
    mkdirSync(join(TMP_NO_GIT, 'regrets'), { recursive: true })
    writeFileSync(join(TMP_NO_GIT, 'api.mjs'), `
export function double(x) { return x * 2 }
`)
    writeFileSync(join(TMP_NO_GIT, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'double',
        entry: 'double',
        watches: [],
        file: 'api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [21],
      }],
    }, null, 2))

    // Sanity check: confirm this directory is NOT inside any git repo.
    // (Note: `git config user.name` may still succeed via global config —
    // that's expected. We only require `git rev-parse HEAD` to fail here.)
    const shaCheck = shIn(TMP_NO_GIT, 'git', ['rev-parse', 'HEAD'])
    assert.notEqual(shaCheck.exitCode, 0, 'TMP_NO_GIT must NOT have a HEAD commit for this test')
  })
  after(() => {
    if (existsSync(TMP_NO_GIT)) rmSync(TMP_NO_GIT, { recursive: true, force: true })
  })

  // Helper: run node with env that disables global + system git config so
  // `git config user.name` and `git config user.email` truly return nothing.
  function shNoGitConfig(cmd, args) {
    const r = spawnSync(cmd, args, {
      cwd: TMP_NO_GIT,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        HOME: '/nonexistent',  // suppress user-level config too
      },
      timeout: 30_000,
    })
    return {
      exitCode: r.status ?? 1,
      stdout: r.stdout ? r.stdout.toString() : '',
      stderr: r.stderr ? r.stderr.toString() : '',
    }
  }

  it('still writes a valid audit.log entry when no HEAD commit exists (gitSha absent)', () => {
    const cap = shIn(TMP_NO_GIT, 'node', [CAPTURE_JS])
    assert.equal(cap.exitCode, 0, `capture failed: ${cap.stderr}`)

    writeFileSync(join(TMP_NO_GIT, 'api.mjs'), `
export function double(x) { return x * 2 + 100 }
`)

    const r = shIn(TMP_NO_GIT, 'node', [VALIDATE_JS, '--update', '--cluster', 'double', '--reason', 'no git available fallback path test'])
    assert.equal(r.exitCode, 0, `validate --update failed: ${r.stderr}`)

    const auditContent = readFileSync(join(TMP_NO_GIT, 'regrets', 'audit.log'), 'utf8')
    assert.ok(auditContent.includes('UPDATE  double'), 'audit.log should still include the UPDATE event')
    assert.ok(auditContent.includes('by: AI refactor session'), 'legacy "by" line should still be present')
    // gitSha MUST be absent because there's no HEAD commit
    assert.ok(!auditContent.includes('gitSha:'), 'gitSha line should be absent when no HEAD commit exists')
    // Chain hash should still be present (entry is still tamper-evident)
    assert.ok(/chain: [0-9a-f]+/.test(auditContent), 'chain hash should still be present')
  })

  it('gitSha is null in history JSON when no HEAD commit exists', () => {
    const r = shIn(TMP_NO_GIT, 'node', [HISTORY_JS, 'double', '--json'])
    assert.equal(r.exitCode, 0)
    const parsed = JSON.parse(r.stdout)
    assert.ok(parsed.events.length >= 1)
    const ev = parsed.events[0]
    assert.equal(ev.gitSha, null, 'gitSha should be null when no HEAD commit exists')
  })

  it('writes audit.log entry with NO gitAuthor when global git config is also unavailable', () => {
    // Re-capture to reset state, then update with all git config disabled
    shIn(TMP_NO_GIT, 'node', [CAPTURE_JS])
    writeFileSync(join(TMP_NO_GIT, 'api.mjs'), `
export function double(x) { return x * 2 + 200 }
`)
    // Remove existing audit.log so we can assert on a fresh entry
    rmSync(join(TMP_NO_GIT, 'regrets', 'audit.log'), { force: true })

    const r = shNoGitConfig('node', [VALIDATE_JS, '--update', '--cluster', 'double', '--reason', 'fully no git config scenario test case'])
    assert.equal(r.exitCode, 0, `validate --update failed: ${r.stderr}`)

    const auditContent = readFileSync(join(TMP_NO_GIT, 'regrets', 'audit.log'), 'utf8')
    assert.ok(auditContent.includes('UPDATE  double'), 'audit.log should still include the UPDATE event')
    assert.ok(!auditContent.includes('gitAuthor:'), 'gitAuthor line should be absent when global git config is also unavailable')
    assert.ok(!auditContent.includes('gitSha:'), 'gitSha line should be absent when no HEAD commit exists')
  })
})

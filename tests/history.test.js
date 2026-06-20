// tests/history.test.js — Tests for `regret history` (#248)
//
// Covers:
//   - parsing of audit.log entries (UPDATE, DRIFT, mixed types)
//   - per-cluster filter
//   - --all flag shows events for every cluster
//   - --json output schema
//   - --limit N truncation
//   - graceful handling when audit.log missing or empty
//   - graceful handling when cluster has no events
//   - legacy entries (no gitSha / gitAuthor fields) still render correctly
//
// Run: node --test tests/history.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const HISTORY_JS = join(SCRIPTS_DIR, 'history.js')

const TMP = resolve(join(process.cwd(), 'tests', '__history_test_tmp__'))

function setupFixtures(auditContent = '') {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  if (auditContent) {
    writeFileSync(join(TMP, 'regrets', 'audit.log'), auditContent)
  }
}

function cleanupFixtures() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
}

/**
 * Run history.js with given args from TMP; return { exitCode, stdout, stderr }.
 */
function runHistory(args) {
  const result = spawnSync('node', [HISTORY_JS, ...args], {
    cwd: TMP,
    stdio: 'pipe',
    timeout: 15_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ? result.stdout.toString() : '',
    stderr: result.stderr ? result.stderr.toString() : '',
  }
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

const MIXED_AUDIT_LOG = `
2026-06-19T10:00:00Z  UPDATE  parse-config
  old: abc1234
  new: def5678
  reason: tax rate updated from 11 to 12 percent
  by: AI refactor session
  chain: 1a2b3c4

2026-06-19T11:30:00Z  DRIFT  parse-config
  new: ghi9012
  reason: drift detected on input 3
  by: AI refactor session
  chain: 5e6f7g8

2026-06-20T09:15:00Z  UPDATE  build-session
  old: aaa1111
  new: bbb2222
  reason: switched session storage from in-memory to redis
  by: AI refactor session
  chain: 9h0i1j2
`

// Audit log with #250-style enriched entries (gitSha, gitAuthor fields).
const ENRICHED_AUDIT_LOG = `
2026-06-21T14:00:00Z  UPDATE  enriched-cluster
  old: old1234
  new: new5678
  reason: refactored to use Map instead of plain object
  by: AI refactor session
  gitSha: abc1234
  gitAuthor: Alice <alice@example.com>
  chain: enriched_chain_hash
`

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('regret history <cluster> (basic)', () => {
  before(() => setupFixtures(MIXED_AUDIT_LOG))
  after(() => cleanupFixtures())

  it('shows all events for the requested cluster in chronological order', () => {
    const result = runHistory(['parse-config'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)
    // Both events should be present
    assert.ok(result.stdout.includes('UPDATE  parse-config'), 'should include the UPDATE event')
    assert.ok(result.stdout.includes('DRIFT  parse-config'), 'should include the DRIFT event')
    // Order: UPDATE first (older), DRIFT second (newer)
    const updateIdx = result.stdout.indexOf('UPDATE  parse-config')
    const driftIdx = result.stdout.indexOf('DRIFT  parse-config')
    assert.ok(updateIdx < driftIdx, 'UPDATE event should appear before DRIFT event')
  })

  it('includes timestamp, hashes, reason, author, and chain in output', () => {
    const result = runHistory(['parse-config'])
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes('2026-06-19T10:00:00Z'), 'should include timestamp')
    assert.ok(result.stdout.includes('abc1234 → def5678'), 'should include old → new hash transition')
    assert.ok(result.stdout.includes('tax rate updated from 11 to 12 percent'), 'should include reason')
    assert.ok(result.stdout.includes('AI refactor session'), 'should include author (from "by" line)')
    assert.ok(result.stdout.includes('1a2b3c4'), 'should include chain hash')
  })

  it('shows only events for the requested cluster (excludes other clusters)', () => {
    const result = runHistory(['parse-config'])
    assert.equal(result.exitCode, 0)
    assert.ok(!result.stdout.includes('build-session'), 'should NOT include events from other clusters')
  })

  it('exits 0 with informational message when cluster has no events', () => {
    const result = runHistory(['nonexistent-cluster'])
    assert.equal(result.exitCode, 0)
    assert.ok(
      result.stderr.includes('No audit-log events found') || result.stdout.includes('No audit-log events'),
      'should print informational message'
    )
    assert.ok(
      result.stderr.includes('nonexistent-cluster') || result.stdout.includes('nonexistent-cluster'),
      'should mention the requested cluster id'
    )
  })
})

describe('regret history <cluster> --json', () => {
  before(() => setupFixtures(MIXED_AUDIT_LOG))
  after(() => cleanupFixtures())

  it('emits valid JSON with the expected schema', () => {
    const result = runHistory(['parse-config', '--json'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    let parsed
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout) }, 'stdout must be valid JSON')
    assert.ok(parsed && typeof parsed === 'object')
    assert.equal(parsed.clusterId, 'parse-config')
    assert.equal(parsed.eventCount, 2)
    assert.equal(parsed.totalEventCount, 2)
    assert.ok(Array.isArray(parsed.events))
    assert.equal(parsed.events.length, 2)
  })

  it('event objects have the required fields', () => {
    const result = runHistory(['parse-config', '--json'])
    const parsed = JSON.parse(result.stdout)
    for (const e of parsed.events) {
      assert.ok(typeof e.timestamp === 'string', 'event.timestamp must be string')
      assert.ok(typeof e.type === 'string', 'event.type must be string')
      assert.ok(typeof e.clusterId === 'string', 'event.clusterId must be string')
      // author can be either gitAuthor or by field
      assert.ok(typeof e.author === 'string', 'event.author must be string')
      assert.ok(typeof e.chain === 'string', 'event.chain must be string')
      // gitSha may be null for legacy entries
      assert.ok(e.gitSha === null || typeof e.gitSha === 'string', 'event.gitSha must be null or string')
    }
  })

  it('exits 0 with empty events array when cluster has no events', () => {
    const result = runHistory(['nonexistent-cluster', '--json'])
    assert.equal(result.exitCode, 0)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.eventCount, 0)
    assert.equal(parsed.events.length, 0)
  })
})

describe('regret history --all', () => {
  before(() => setupFixtures(MIXED_AUDIT_LOG))
  after(() => cleanupFixtures())

  it('shows events for every cluster, not just one', () => {
    const result = runHistory(['--all'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)
    assert.ok(result.stdout.includes('parse-config'), 'should include parse-config events')
    assert.ok(result.stdout.includes('build-session'), 'should include build-session events')
  })

  it('header says "(all clusters)"', () => {
    const result = runHistory(['--all'])
    assert.ok(result.stdout.includes('(all clusters)'), 'header should say (all clusters)')
  })

  it('--all --json returns events array across all clusters', () => {
    const result = runHistory(['--all', '--json'])
    assert.equal(result.exitCode, 0)
    const parsed = JSON.parse(result.stdout)
    assert.ok(parsed.events.length >= 3, `should have at least 3 events, got ${parsed.events.length}`)
    // Should include events from multiple clusters
    const clusterIds = new Set(parsed.events.map(e => e.clusterId))
    assert.ok(clusterIds.size >= 2, 'should include events from at least 2 different clusters')
    assert.ok(clusterIds.has('parse-config'), 'should include parse-config')
    assert.ok(clusterIds.has('build-session'), 'should include build-session')
  })
})

describe('regret history --limit N', () => {
  before(() => setupFixtures(MIXED_AUDIT_LOG))
  after(() => cleanupFixtures())

  it('shows only the last N events for a cluster', () => {
    // parse-config has 2 events. With --limit 1, only the last (DRIFT) should appear.
    const result = runHistory(['parse-config', '--limit', '1'])
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes('DRIFT  parse-config'), 'should include the DRIFT event (last 1)')
    assert.ok(!result.stdout.includes('UPDATE  parse-config'), 'should NOT include the older UPDATE event')
  })

  it('reports the limit in the summary line', () => {
    const result = runHistory(['parse-config', '--limit', '1'])
    assert.ok(
      result.stdout.includes('showing last 1 of 2'),
      'should report "showing last 1 of 2" in the summary line'
    )
  })

  it('--limit larger than event count shows all events', () => {
    const result = runHistory(['parse-config', '--limit', '99'])
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes('UPDATE  parse-config'))
    assert.ok(result.stdout.includes('DRIFT  parse-config'))
  })
})

describe('regret history — missing or empty audit.log', () => {
  // Use separate describes so each test gets fresh setup/cleanup, since
  // node:test does not export afterEach in this Node version.
  describe('when audit.log does not exist', () => {
    before(() => setupFixtures(''))  // creates regrets/ but no audit.log
    after(() => cleanupFixtures())

    it('exits 0 with helpful message', () => {
      const result = runHistory(['any-cluster'])
      assert.equal(result.exitCode, 0)
      assert.ok(
        result.stderr.includes('No audit log found') || result.stdout.includes('No audit log'),
        'should explain that no audit.log exists'
      )
      assert.ok(
        result.stderr.includes('regret update') || result.stdout.includes('regret update'),
        'should hint at how to create audit log entries'
      )
    })

    it('exits 0 with empty events JSON when audit.log does not exist', () => {
      const result = runHistory(['any-cluster', '--json'])
      assert.equal(result.exitCode, 0)
      const parsed = JSON.parse(result.stdout)
      assert.equal(parsed.eventCount, 0)
      assert.equal(parsed.events.length, 0)
    })
  })

  describe('when --all is invoked and audit.log does not exist', () => {
    before(() => setupFixtures(''))
    after(() => cleanupFixtures())

    it('exits 0 with empty result', () => {
      const result = runHistory(['--all'])
      assert.equal(result.exitCode, 0)
      assert.ok(
        result.stdout.includes('Audit log is empty') || result.stderr.includes('No audit log'),
        'should indicate empty audit log'
      )
    })
  })
})

describe('regret history — legacy entries (pre-#250, no git fields)', () => {
  before(() => setupFixtures(MIXED_AUDIT_LOG))
  after(() => cleanupFixtures())

  it('renders the "by" line as author when gitAuthor is absent', () => {
    const result = runHistory(['parse-config'])
    assert.ok(result.stdout.includes('author:   AI refactor session'), 'should render "by" line as author')
  })

  it('does NOT print "git sha:" line for legacy entries', () => {
    const result = runHistory(['parse-config'])
    assert.ok(!result.stdout.includes('git sha:'), 'should not print git sha line for legacy entries')
  })

  it('JSON output has gitSha=null for legacy entries', () => {
    const result = runHistory(['parse-config', '--json'])
    const parsed = JSON.parse(result.stdout)
    for (const e of parsed.events) {
      assert.equal(e.gitSha, null, 'gitSha should be null for legacy entries')
    }
  })
})

describe('regret history — enriched entries (#250 gitSha + gitAuthor)', () => {
  before(() => setupFixtures(ENRICHED_AUDIT_LOG))
  after(() => cleanupFixtures())

  it('renders gitAuthor as the author when present', () => {
    const result = runHistory(['enriched-cluster'])
    assert.ok(result.stdout.includes('Alice <alice@example.com>'), 'should render gitAuthor as author')
  })

  it('renders git sha line when gitSha is present', () => {
    const result = runHistory(['enriched-cluster'])
    assert.ok(result.stdout.includes('git sha:  abc1234'), 'should render git sha line')
  })

  it('JSON output includes the gitSha and gitAuthor fields', () => {
    const result = runHistory(['enriched-cluster', '--json'])
    assert.equal(result.exitCode, 0)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.events.length, 1)
    assert.equal(parsed.events[0].gitSha, 'abc1234')
    assert.equal(parsed.events[0].author, 'Alice <alice@example.com>')
  })
})

describe('regret history — argument validation', () => {
  before(() => setupFixtures(MIXED_AUDIT_LOG))
  after(() => cleanupFixtures())

  it('exits 1 with usage hint when no cluster id is provided', () => {
    const result = runHistory([])
    assert.notEqual(result.exitCode, 0, 'should exit non-zero without args')
    assert.ok(
      result.stderr.includes('Usage:') || result.stderr.includes('regret history'),
      'should print usage hint on stderr'
    )
  })

  it('--help exits 0 and prints documentation', () => {
    const result = runHistory(['--help'])
    assert.equal(result.exitCode, 0)
    assert.ok(result.stdout.includes('regret history'), 'help should mention the command name')
    assert.ok(result.stdout.includes('USAGE'), 'help should include USAGE section')
    assert.ok(result.stdout.includes('--json'), 'help should mention --json flag')
    assert.ok(result.stdout.includes('--limit'), 'help should mention --limit flag')
  })
})

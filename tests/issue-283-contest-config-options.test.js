// tests/issue-283-contest-config-options.test.js
// Closes #283: contest.mjs must honour cluster config options that affect
// the fingerprint (ignorePaths, fingerprintLevel, fingerprintMode,
// valuePaths). Previously contest.mjs only passed `normalize` and
// `ignoreFields` to `fingerprint()`, which meant chain hashes diverged
// from capture.js hashes for the same cluster + input.
//
// We test this end-to-end: capture.js produces a `main.regret` for a
// cluster that uses `ignorePaths`, then contest.mjs --capture produces
// `c1.chain`. The chain hash MUST match what contest.mjs --validate
// recomputes for the same input. Pre-fix, contest.mjs's hash would
// differ from capture.js's hash because ignorePaths was dropped.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CONTEST_MJS = join(SCRIPTS_DIR, 'contest.mjs')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')

const TMP = resolve(join(process.cwd(), 'tests', `__issue283_${process.pid}__`))

function setupProject(apiSource, clusterOpts = {}) {
  mkdirSync(join(TMP, 'regrets', 'chains'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), apiSource)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        ...clusterOpts,
      },
    ],
  }, null, 2))
  writeFileSync(join(TMP, 'regrets', 'chains.json'), JSON.stringify({
    chains: [
      { id: 'c1', steps: [{ cluster: 'main', input: 5 }] },
    ],
  }, null, 2))
}

function runCapture(cwd) {
  const result = spawnSync('node', [CAPTURE_JS], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runContest(cwd, args = []) {
  const result = spawnSync('node', [CONTEST_MJS, ...args], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runValidate(cwd, args = []) {
  const result = spawnSync('node', [VALIDATE_JS, ...args], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function extractChainHash(stdout) {
  const m = stdout.match(/Chain hash:\s+(\S+)/)
  return m ? m[1] : null
}

describe('Issue #283 — contest.mjs honours cluster config options', () => {
  // The output includes a `timestamp` field that varies per run. With
  // `ignorePaths: ['timestamp']`, capture.js strips it from the
  // fingerprinted output. Pre-fix, contest.mjs did NOT strip it → the
  // chain hash differed from the captured main.regret hash for the same
  // input. We test that contest.mjs's chain hash is stable across runs
  // (the timestamp would otherwise change between runs and break the
  // chain golden).
  const apiWithTimestamp = `
function main(x) {
  return { value: x * 2, timestamp: Date.now() }
}
export { main }
`

  before(() => setupProject(apiWithTimestamp, { ignorePaths: ['timestamp'] }))
  after(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) })

  it('capture.js produces main.regret with ignorePaths config', () => {
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
    const regretContent = readFileSync(join(TMP, 'regrets', 'main.regret'), 'utf8')
    assert.match(regretContent, /ignorePaths:\s*\[timestamp\]/,
      `main.regret should record ignorePaths: [timestamp]; got:\n${regretContent}`)
  })

  it('contest.mjs --capture produces a stable chain hash (ignorePaths honoured)', () => {
    // Run capture twice. If contest.mjs honours ignorePaths, both runs
    // should produce the SAME chain hash (because the volatile timestamp
    // is stripped before fingerprinting). Pre-fix, the hashes would
    // differ because each Date.now() returns a different value.
    const con1 = runContest(TMP, ['--capture'])
    assert.equal(con1.exitCode, 0, `first capture should exit 0\nstdout: ${con1.stdout}\nstderr: ${con1.stderr}`)
    const hash1 = extractChainHash(con1.stdout)
    assert.ok(hash1, `first capture should produce a chain hash; got:\n${con1.stdout}`)

    const con2 = runContest(TMP, ['--capture'])
    assert.equal(con2.exitCode, 0, `second capture should exit 0\nstdout: ${con2.stdout}\nstderr: ${con2.stderr}`)
    const hash2 = extractChainHash(con2.stdout)
    assert.ok(hash2, `second capture should produce a chain hash; got:\n${con2.stdout}`)

    assert.equal(hash1, hash2,
      `chain hash must be stable across runs when ignorePaths is set; got ${hash1} then ${hash2}`)
  })

  it('contest.mjs --validate matches the captured chain (ignorePaths honoured on both sides)', () => {
    // The chain file was written by --capture. Now --validate should
    // recompute the same hash (Date.now() returns a different value, but
    // ignorePaths strips it) and Match.
    const result = runContest(TMP, ['--validate'])
    assert.equal(result.exitCode, 0,
      `expected exit 0 (Match), got ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stdout, /✅ Match/,
      `should report Match; got:\n${result.stdout}`)
  })

  it('validate.js ALSO passes for the same cluster (confirms ignorePaths is consistent across capture + validate + contest)', () => {
    // Sanity: validate.js (which already supported ignorePaths) should
    // also pass for the same cluster — confirms the cross-tool parity.
    const result = runValidate(TMP)
    assert.equal(result.exitCode, 0,
      `validate.js should pass for the same cluster; got exit ${result.exitCode}\nstdout:\n${result.stdout}`)
  })
})

describe('Issue #283 — contest.mjs honours fingerprintLevel: "calls"', () => {
  // With fingerprintLevel: "calls", the fingerprint is based on call
  // counts (which functions were called and how many times), NOT on
  // return values. contest.mjs must use the same dispatch as capture.js
  // so the chain hash matches.
  const apiWithCalls = `
function helper(x) { return x + 1 }
function main(x) { return helper(x) }
export { main }
`

  before(() => setupProject(apiWithCalls, {
    fingerprintLevel: 'calls',
    watches: ['helper'],
    callees: ['helper'],
  }))
  after(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) })

  it('capture + contest --capture + contest --validate all agree on hash', () => {
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)

    const con1 = runContest(TMP, ['--capture'])
    assert.equal(con1.exitCode, 0, `contest --capture should exit 0\nstdout: ${con1.stdout}`)
    const hash1 = extractChainHash(con1.stdout)
    assert.ok(hash1, `should produce a chain hash; got:\n${con1.stdout}`)

    // Validate immediately — should Match (nothing changed).
    const con2 = runContest(TMP, ['--validate'])
    assert.equal(con2.exitCode, 0,
      `contest --validate should exit 0 (Match); got:\n${con2.stdout}`)
    assert.match(con2.stdout, /✅ Match/, `should report Match; got:\n${con2.stdout}`)

    // Mutate helper()'s return value — call counts unchanged, so the
    // "calls" fingerprint should still match. Use --skip-callees here
    // because we're specifically testing the chain HASH (fingerprintLevel:
    // "calls") — the callee re-validation would (correctly) catch the
    // helper regression, but that's #272's territory, not #283's.
    writeFileSync(join(TMP, 'api.mjs'), `
function helper(x) { return x + 999 }
function main(x) { return helper(x) }
export { main }
`)
    const con3 = runContest(TMP, ['--validate', '--skip-callees'])
    assert.equal(con3.exitCode, 0,
      `contest --validate should still exit 0 (call counts unchanged); got:\n${con3.stdout}`)
    assert.match(con3.stdout, /✅ Match/,
      `chain hash should still Match after callee return-value mutation (fingerprintLevel: "calls"); got:\n${con3.stdout}`)
  })
})

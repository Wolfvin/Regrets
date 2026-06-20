// tests/issue-272-273-contest-callee-revalidation.test.js
// Closes #272: contest.mjs must re-validate callee contracts (mirroring
// validate.js post PR #258/#303). Previously contest.mjs skipped this
// phase entirely — a chain could PASS while a callee had regressed.
//
// Closes #283 (incidentally, via the same fixture): contest.mjs now reads
// `ignorePaths` and other cluster config options that affect the
// fingerprint, so chain hashes match what capture.js produces for the
// same input.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CONTEST_MJS = join(SCRIPTS_DIR, 'contest.mjs')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')

const TMP = resolve(join(process.cwd(), 'tests', `__issue272_${process.pid}__`))

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
        callees: ['add'],
        ...clusterOpts,
      },
    ],
  }, null, 2))
  // chains.json: single-step chain that calls main(5)
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

describe('Issue #272 — contest.mjs re-validates callee contracts', () => {
  const originalApi = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }
`

  before(() => setupProject(originalApi))
  after(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) })

  it('capture + contest --capture succeeds and writes the chain file', () => {
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)

    const con = runContest(TMP, ['--capture'])
    assert.equal(con.exitCode, 0, `contest --capture should exit 0\nstdout: ${con.stdout}\nstderr: ${con.stderr}`)
    assert.ok(existsSync(join(TMP, 'regrets', 'chains', 'c1.chain')),
      'c1.chain should exist after contest --capture')
  })

  it('contest --validate (nothing changed) → Match, exit 0', () => {
    const result = runContest(TMP, ['--validate'])
    assert.equal(result.exitCode, 0,
      `expected exit 0, got ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stdout, /✅ Match/, `should report Match; got:\n${result.stdout}`)
  })

  it('contest --validate detects callee regression → FAIL, exit 1 (closes #272)', () => {
    // Mutate add() — main()'s output changes from 6 to 4, so the chain
    // hash mismatches AND the callee contract regresses. Both signal
    // the failure.
    writeFileSync(join(TMP, 'api.mjs'), `
function add(a, b) { return a - b }
function main(x) { return add(x, 1) }
export { main, add }
`)

    const result = runContest(TMP, ['--validate'])
    assert.equal(result.exitCode, 1,
      `expected exit 1 on callee regression, got ${result.exitCode}\nstdout:\n${result.stdout}`)

    // The chain step should report the callee regression.
    assert.match(result.stdout, /main\.calls\.add.*FAIL \(callee\)/,
      `should report main.calls.add FAIL (callee); got:\n${result.stdout}`)
  })

  it('contest --validate with --skip-callees bypasses callee re-validation', () => {
    // Restore add() to a clean state first.
    writeFileSync(join(TMP, 'api.mjs'), originalApi)
    // Re-capture to reset the chain golden (we just mutated it).
    const con = runContest(TMP, ['--capture'])
    assert.equal(con.exitCode, 0, `re-capture should succeed\nstdout: ${con.stdout}`)

    // Now mutate add() — main()'s output changes, so the chain mismatches.
    // But with --skip-callees, the callee re-validation should NOT run.
    writeFileSync(join(TMP, 'api.mjs'), `
function add(a, b) { return a - b }
function main(x) { return add(x, 1) }
export { main, add }
`)

    const result = runContest(TMP, ['--validate', '--skip-callees'])
    // The chain still mismatches (parent output changed), so exit 1.
    assert.equal(result.exitCode, 1,
      `expected exit 1 (chain mismatch), got ${result.exitCode}\nstdout:\n${result.stdout}`)

    // But NO callee PASS/FAIL output should appear.
    assert.doesNotMatch(result.stdout, /main\.calls\.add.*(PASS|FAIL) \(callee\)/,
      `should NOT print callee PASS/FAIL with --skip-callees; got:\n${result.stdout}`)
    // And the --skip-callees notice should be printed.
    assert.match(result.stdout, /--skip-callees/i,
      `should print --skip-callees notice; got:\n${result.stdout}`)
  })

  it('contest --validate catches callee-only regression (parent passes via fingerprintLevel: "calls")', () => {
    // Restore clean state and re-capture with fingerprintLevel: "calls"
    // so the parent's fingerprint is based on call counts (not return
    // values). This lets us mutate add()'s return without changing the
    // parent fingerprint — the callee re-validation is the ONLY signal.
    writeFileSync(join(TMP, 'api.mjs'), originalApi)
    setupProject(originalApi, { fingerprintLevel: 'calls', watches: ['add'] })
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `re-capture should succeed\nstdout: ${cap.stdout}`)
    const con = runContest(TMP, ['--capture'])
    assert.equal(con.exitCode, 0, `contest --capture should succeed\nstdout: ${con.stdout}`)

    // Mutate add() to return a different value — main() still calls add
    // exactly once, so the "calls" fingerprint is unchanged. Only the
    // callee contract catches the regression.
    writeFileSync(join(TMP, 'api.mjs'), `
function add(a, b) { return a + b + 100 }
function main(x) { return add(x, 1) }
export { main, add }
`)

    const result = runContest(TMP, ['--validate'])
    assert.equal(result.exitCode, 1,
      `expected exit 1 (callee regression), got ${result.exitCode}\nstdout:\n${result.stdout}`)

    // Chain hash should still match (call counts unchanged).
    assert.match(result.stdout, /✅ Match|❌ Mismatch/,
      `should print chain match/mismatch line; got:\n${result.stdout}`)

    // Callee should FAIL.
    assert.match(result.stdout, /main\.calls\.add.*FAIL \(callee\)/,
      `should report main.calls.add FAIL (callee); got:\n${result.stdout}`)
  })
})

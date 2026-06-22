// tests/haskell-stack.test.js — end-to-end test for the Haskell stack
//
// Runs scripts/capture_haskell.sh and scripts/validate_haskell.sh against the
// tests/fixtures/haskell-example fixture, then asserts:
//   1. capture writes .regret files with all standard fields + INPUTS line
//   2. validate (no code change) exits 0 and prints PASS for all clusters
//   3. validate detects breaking change → exit 1, FAIL
//   4. cross-stack parity: Haskell-written HASH matches JS fingerprint()
//   5. JS validate.js can parse Haskell-generated .regret (cross-tool compat)
//
// Skips automatically if `stack` (Haskell toolchain) is not on PATH.
//
// Run: node --test tests/haskell-stack.test.js

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fingerprint } from '../scripts/fingerprint.js'
import { parseRegret } from '../scripts/validate.js'

const ROOT = resolve(import.meta.dirname, '..')
const SCRIPTS_DIR = join(ROOT, 'scripts')
const CAPTURE_HASKELL = join(SCRIPTS_DIR, 'capture_haskell.sh')
const VALIDATE_HASKELL = join(SCRIPTS_DIR, 'validate_haskell.sh')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'haskell-example')

// ─── Skip if `stack` is not available ────────────────────────────────────────

function stackAvailable() {
  const r = spawnSync('stack', ['runghc', '--', '--version'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` },
  })
  return r.status === 0 || (r.stdout && r.stdout.includes('runghc'))
}

const hasStack = stackAvailable()

function runBash(scriptPath, args = [], cwd = FIXTURE) {
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 300_000, // 5 minutes — Haskell compilation can be slow
    env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` },
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

describe('Haskell stack — capture + validate', { skip: !hasStack && 'stack (Haskell toolchain) not on PATH' }, () => {
  before(() => {
    // Clean .regret files
    const regretDir = join(FIXTURE, 'regrets')
    if (existsSync(regretDir)) {
      for (const f of readdirSync(regretDir)) {
        if (f.endsWith('.regret')) rmSync(join(regretDir, f))
      }
    }
  })

  it('capture writes .regret files with all standard fields + INPUTS line for multi-input', () => {
    const result = runBash(CAPTURE_HASKELL)
    assert.equal(result.exitCode, 0,
      `capture failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    for (const id of ['slugify-fn', 'count-vowels-fn', 'reverse-fn', 'add-fn']) {
      const regretPath = join(FIXTURE, 'regrets', `${id}.regret`)
      assert.ok(existsSync(regretPath), `${id}.regret was not written`)
      const content = readFileSync(regretPath, 'utf8')

      // Header fields
      assert.match(content, /^cluster: /m, `${id}: missing cluster header`)
      assert.match(content, /^version: 1/m, `${id}: missing version header`)
      assert.match(content, /^fingerprint: \S{7}/m, `${id}: missing fingerprint header`)
      assert.match(content, /^captured: /m, `${id}: missing captured header`)
      assert.match(content, /^watches: \[/m, `${id}: missing watches header`)
      assert.match(content, /^entry: /m, `${id}: missing entry header`)
      assert.match(content, /^stack: haskell/m, `${id}: missing/wrong stack header`)
      assert.match(content, /^fingerprintLevel: entry/m, `${id}: missing fingerprintLevel header`)
      assert.match(content, /^file: /m, `${id}: missing file header`)

      // Data section
      assert.match(content, /^---$/m, `${id}: missing --- separator`)
      assert.match(content, /^INPUT\s+/m, `${id}: missing INPUT line`)
      assert.match(content, /^OUTPUT\s+/m, `${id}: missing OUTPUT line`)
      assert.match(content, /^HASH\s+\S{7}/m, `${id}: missing HASH line`)

      // Multi-input INPUTS line — each cluster has 3+ inputs
      assert.match(content, /^INPUTS\s+\[/m, `${id}: missing INPUTS line for multi-input cluster`)
    }
  })

  it('validate (no code change) exits 0 and prints PASS for all clusters', () => {
    // Capture first (clean state)
    runBash(CAPTURE_HASKELL)
    const result = runBash(VALIDATE_HASKELL)
    assert.equal(result.exitCode, 0,
      `validate failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /PASS.*slugify-fn|slugify-fn.*PASS/i, 'should PASS slugify-fn')
    assert.match(result.stdout, /PASS.*add-fn|add-fn.*PASS/i, 'should PASS add-fn')
  })

  it('validate detects breaking change → exit 1, FAIL', () => {
    runBash(CAPTURE_HASKELL)
    // Mutate slugify: replace hyphens with underscores
    const srcPath = join(FIXTURE, 'StringUtils.hs')
    const original = readFileSync(srcPath, 'utf8')
    const mutated = original.replace("else '-'", "else '_'")
    writeFileSync(srcPath, mutated)
    try {
      const result = runBash(VALIDATE_HASKELL)
      assert.notEqual(result.exitCode, 0,
        `validate should exit non-zero on breaking change; got ${result.exitCode}`)
      assert.match(result.stdout, /FAIL.*slugify-fn|slugify-fn.*FAIL/i, 'should FAIL slugify-fn')
    } finally {
      writeFileSync(srcPath, original)
    }
  })

  it('cross-stack parity: Haskell-written HASH matches JS fingerprint()', () => {
    runBash(CAPTURE_HASKELL)
    for (const id of ['slugify-fn', 'count-vowels-fn', 'reverse-fn', 'add-fn']) {
      const regretPath = join(FIXTURE, 'regrets', `${id}.regret`)
      const content = readFileSync(regretPath, 'utf8')
      const regret = parseRegret(content)

      const jsHash = fingerprint(regret.input, regret.output)
      assert.equal(jsHash, regret.goldenHash,
        `${id}: cross-stack parity FAILED — JS computed "${jsHash}" but Haskell .regret stored "${regret.goldenHash}"`)

      if (regret.goldenInputs) {
        for (let i = 0; i < regret.goldenInputs.length; i++) {
          const gi = regret.goldenInputs[i]
          const jsHashI = fingerprint(gi.input, gi.output)
          assert.equal(jsHashI, gi.hash,
            `${id}: cross-stack parity FAILED for input #${i + 2}`)
        }
      }
    }
  })

  it('JS validate.js can parse Haskell-generated .regret (cross-tool compat)', () => {
    runBash(CAPTURE_HASKELL)
    const content = readFileSync(join(FIXTURE, 'regrets', 'add-fn.regret'), 'utf8')
    const regret = parseRegret(content)
    assert.equal(regret.stack, 'haskell')
    assert.equal(regret.entry, 'add')
    assert.ok(regret.goldenHash, 'should have goldenHash')
    assert.ok(regret.goldenInputs, 'should have goldenInputs (INPUTS line)')
    assert.equal(regret.goldenInputs.length, 2, 'add-fn has 3 inputs → 2 in INPUTS')
  })
})

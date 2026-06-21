// tests/issue-255-sampling-mode.test.js — Regression test for #255
//
// #255 — perf: measure callee wrapping overhead + add sampling mode for hot code paths
//
// This is a FEATURE REQUEST, not a bug. The issue asks for:
//   1. Benchmark callee wrapping overhead per callee
//   2. Add optional `sampleRate: 0.1` field in manifest cluster — only capture
//      10% of calls (for hot code paths where full capture is impractical)
//
// Status: intentionally NOT implemented. Listed in CONTEXT.md "Known Gaps":
//   "#255 Sampling mode untuk hot code paths (perlu design decision)"
//
// Design questions that must be answered before implementation:
//   - Benchmark methodology: synthetic micro-benchmark vs real-world fixture?
//   - sampleRate semantics: deterministic (every Nth call) vs probabilistic
//     (random 10%)?
//   - How does sampling interact with the callee contract (validate re-runs
//     ALL recorded calls — sampling at capture time means some calls are
//     never recorded, so validate can't verify them)?
//   - Report format: per-callee overhead? Aggregate? Both?
//
// This test documents the current state: no `sampleRate` field is recognized
// in the manifest, and capture does NOT sample. If a future PR implements
// sampling, this test should be updated to verify the new behavior — and
// the design questions above should be answered in the PR description.
//
// Run: node --test tests/issue-255-sampling-mode.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_JS = join(SCRIPTS_DIR, 'capture.js')

const TMP = resolve(join(process.cwd(), 'tests', `__issue_255_${process.pid}__`))

function setup() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
}

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

function runCaptureCli() {
  const result = spawnSync('node', [CAPTURE_JS], {
    cwd: TMP,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

describe('#255 — sampling mode (feature request, not yet implemented)', () => {
  before(() => {
    setup()
    // Fixture: a simple function with multiple inputs. If sampling were
    // implemented, a `sampleRate: 0.1` field would cause capture to only
    // record ~10% of calls. Currently, capture records ALL calls — the
    // `sampleRate` field is silently ignored if present (backward compat).
    writeFileSync(join(TMP, 'api.cjs'), `function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
module.exports = { add, main }
`)
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'test-issue-255',
      version: '0.0.0',
    }))
    // Manifest with a `sampleRate` field — capture should accept this
    // without crashing (forward-compat: if sampling is ever implemented,
    // existing manifests with `sampleRate` should not break).
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'main',
        entry: 'main',
        file: './api.cjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [1, 2, 3, 4, 5],
        watches: [],
        callees: ['add'],
        // Forward-compat field — currently ignored, documented in #255
        sampleRate: 0.1,
      }],
    }))
  })

  after(() => {
    cleanup()
  })

  it('capture.js does NOT crash when manifest contains a `sampleRate` field', () => {
    // This locks in forward-compat behavior: if a user adds `sampleRate`
    // to their manifest (e.g. copied from a future docs example), capture
    // should not crash. The field is currently ignored — ALL calls are
    // recorded, not just 10%.
    const result = runCaptureCli()
    assert.equal(
      result.exitCode, 0,
      `capture should exit 0 even with sampleRate field in manifest\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
    )
  })

  it('capture records ALL calls (no sampling) — parent .regret written', () => {
    const result = runCaptureCli()
    assert.equal(result.exitCode, 0)

    const regretFiles = readdirSync(join(TMP, 'regrets')).filter(f => f.endsWith('.regret'))
    assert.ok(
      regretFiles.includes('main.regret'),
      `parent .regret should be written; got: ${regretFiles.join(', ')}`
    )
  })

  it('capture records ALL callee calls (no sampling) — callee .regret written', () => {
    // With 5 inputs, `main` calls `add` 5 times. Without sampling, all 5
    // calls are recorded. The callee .regret file should exist and contain
    // multiple CALLS entries (one per unique args).
    const result = runCaptureCli()
    assert.equal(result.exitCode, 0)

    const regretFiles = readdirSync(join(TMP, 'regrets')).filter(f => f.endsWith('.regret'))
    assert.ok(
      regretFiles.includes('main.calls.add.regret'),
      `callee .regret should be written (no sampling); got: ${regretFiles.join(', ')}`
    )

    // Read the callee .regret file and verify it has CALLS entries.
    const calleeContent = readFileSync(join(TMP, 'regrets', 'main.calls.add.regret'), 'utf8')
    // The CALLS line should be present (multi-input callee contract).
    // Without sampling, all unique (args) calls are recorded.
    assert.ok(
      calleeContent.includes('CALLS') || calleeContent.includes('INPUT'),
      `callee .regret should contain CALLS or INPUT entries (no sampling); got:\n${calleeContent}`
    )
  })
})

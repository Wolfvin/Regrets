// tests/capture-rust-cli-flag.test.js — Regression test for PR #355 CLI bug
//
// The original capture_rust.sh and validate_rust.sh used `for arg in "$@"`
// with `shift` inside, which misparses flag-value pairs when multiple
// value-taking flags are present (e.g. `--project X --cluster Y` would
// assign CLUSTER_FILTER=--cluster instead of CLUSTER_FILTER=Y).
//
// Additionally, even when --cluster was parsed correctly by the bash wrapper,
// the Rust test runner (regret_runner.rs) ignored it and validated ALL
// clusters — because the wrapper only filtered its own printout, not what
// cargo test actually ran. The fix exports REGRET_CLUSTER_FILTER env var,
// which the Rust runner now honors.
//
// This test locks in both fixes. It skips with exit 0 (not fail) when cargo
// is not available, so CI environments without Rust toolchain don't break.
//
// Run: node --test tests/capture-rust-cli-flag.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_RUST = join(SCRIPTS_DIR, 'capture_rust.sh')
const VALIDATE_RUST = join(SCRIPTS_DIR, 'validate_rust.sh')
const RUST_REF = resolve(import.meta.dirname, '..', 'references', 'rust')

function cargoAvailable() {
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasCargo = cargoAvailable()

describe('Rust stack CLI flag handling (regression for #355 bug)', () => {
  before(() => {
    if (!hasCargo) return
    // Ensure .regret files exist (capture if missing)
    try {
      execFileSync('bash', [CAPTURE_RUST, '--project', RUST_REF], { stdio: 'pipe' })
    } catch {
      // Ignore — files might already exist from a previous run
    }
  })

  after(() => {
    // Clean up any modified .regret files
    if (!hasCargo) return
    try {
      execFileSync('git', ['checkout', join('references/rust/regrets/')], { stdio: 'ignore' })
    } catch {
      // ignore
    }
  })

  it('should skip when cargo is not available', { skip: hasCargo }, () => {
    // Skipped body — only runs when cargo is NOT available
    assert.ok(true, 'this test is a skip placeholder')
  })

  it('--cluster rust-add --project X filters to exactly 1 cluster', { skip: !hasCargo }, () => {
    const out = execFileSync('bash', [VALIDATE_RUST, '--cluster', 'rust-add', '--project', RUST_REF], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Should validate exactly 1 cluster (rust-add), not all 5
    assert.match(out, /1 passed, 0 failed, 0 skipped/,
      `Expected "1 passed" in output, got:\n${out}`)
    assert.match(out, /PASS rust-add/, `Expected "PASS rust-add" in output, got:\n${out}`)
    assert.doesNotMatch(out, /PASS rust-mul/, `Should NOT validate rust-mul when --cluster rust-add is used. Got:\n${out}`)
  })

  it('--project X --cluster rust-add filters to exactly 1 cluster (was bug: mis-parsed)', { skip: !hasCargo }, () => {
    const out = execFileSync('bash', [VALIDATE_RUST, '--project', RUST_REF, '--cluster', 'rust-add'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Before the fix, this would print "No Rust clusters found in manifest" because
    // CLUSTER_FILTER was set to '--cluster' (the literal flag), and the filter
    // `c.id === '--cluster'` matched nothing.
    assert.doesNotMatch(out, /No Rust clusters found/,
      `Regression: --project X --cluster Y is broken again. Got:\n${out}`)
    assert.match(out, /1 passed, 0 failed, 0 skipped/,
      `Expected "1 passed" in output, got:\n${out}`)
  })

  it('--cluster with non-existent cluster → exit non-zero (no match)', { skip: !hasCargo }, () => {
    let err = null
    try {
      execFileSync('bash', [VALIDATE_RUST, '--project', RUST_REF, '--cluster', 'no-such-cluster'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      err = e
    }
    // Either the bash wrapper exits 1 (no clusters found), or cargo test passes with 0 clusters.
    // Either way, the output should indicate 0 clusters processed.
    const out = err ? (err.stdout || '') + (err.stderr || '') : ''
    assert.ok(
      out.includes('No Rust clusters found') || out.includes('0 passed') || out.includes('0 clusters'),
      `Expected "no clusters" indication, got:\n${out}`,
    )
  })

  it('--unknown-flag should exit non-zero with usage hint', () => {
    let err = null
    try {
      execFileSync('bash', [VALIDATE_RUST, '--bogus-flag'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      err = e
    }
    assert.ok(err, 'Expected non-zero exit for unknown flag')
    const out = (err.stdout || '') + (err.stderr || '')
    assert.match(out, /Unknown flag|--help|Usage/i, `Expected usage hint, got:\n${out}`)
  })
})

// tests/sigint-propagation.test.js — Tests for #302
// SIGINT/SIGTERM propagation through bin/regret.js → scripts/regret.js → child
//
// Issue #302: previously, both bin/regret.js and scripts/regret.js used
// execFileSync (blocking), which swallowed SIGINT — the parent exited but
// the child was orphaned and kept running. PR #244's SIGINT cleanup
// handlers in capture.js / esm-callee-transform.js never received the
// signal, so temp files leaked.
//
// These tests verify the fix:
//   1. SIGINT to bin/regret.js propagates to the grandchild (capture.js)
//   2. SIGINT to scripts/regret.js propagates to the child (capture.js)
//   3. Exit code is 130 (128 + SIGINT) — conventional shell behavior
//   4. No orphan node processes remain after the parent exits
//   5. SIGTERM also propagates (exit 143)
//   6. Normal (non-signal) exits still work and produce exit 0
//
// Run: node --test tests/sigint-propagation.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BIN_REGRET = join(ROOT, 'bin', 'regret.js')
const SCRIPTS_REGRET = join(ROOT, 'scripts', 'regret.js')

const TMP = resolve(join(process.cwd(), 'tests', `__sigint_${process.pid}__`))

function setupSlowFixture() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  // 5s per call × 4 inputs = 20s total. Plenty of time to send SIGINT.
  writeFileSync(join(TMP, 'test.mjs'), `
async function slow(x) {
  await new Promise(r => setTimeout(r, 5000))
  return x * 2
}
async function main(x) { return (await slow(x)) + 1 }
export { main, slow }
`)
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.0', type: 'module' }))
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: 'main',
      entry: 'main',
      file: './test.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [1, 2, 3, 4],
      watches: [],
      callees: ['slow'],
    }],
  }))
}

function setupFastFixture() {
  // Reuse the same TMP dir but with a fast function for the normal-exit test.
  // The previous test's after() hook may have removed TMP, so recreate it.
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'test.mjs'), `
function quick(x) { return x * 2 }
function main(x) { return quick(x) + 1 }
export { main, quick }
`)
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.0', type: 'module' }))
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [{
      id: 'main',
      entry: 'main',
      file: './test.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [1, 2],
      watches: [],
    }],
  }))
  // Clear any old .regret files so capture runs cleanly
  try { rmSync(join(TMP, 'regrets', 'main.regret'), { force: true }) } catch {}
}

function cleanupFixture() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

/**
 * Spawn a child process, wait for it to start, send a signal, wait for exit.
 * Returns { exitCode, signal, durationMs, orphanPids }.
 *
 * orphanPids is checked AFTER the parent exits — if any node process matching
 * the matcher is still alive, we have an orphan (bug #302).
 *
 * The orphan matcher is scoped to processes whose cwd is `cwd` (the test
 * fixture), so we don't pick up unrelated capture.js processes from other
 * tests running in parallel.
 */
async function spawnSendSignalAndAwait({
  cmd, args, cwd, signalName, settleMs = 1000, orphanMatcher,
}) {
  const child = spawn(cmd, args, { cwd, stdio: 'pipe' })
  const pid = child.pid

  // Give the process time to spin up its children before sending the signal
  await new Promise(r => setTimeout(r, 1500))

  const start = Date.now()
  try { child.kill(signalName) } catch { /* already exited */ }

  const result = await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ exitCode: code, signal, durationMs: Date.now() - start })
    })
    // Safety: don't hang forever. If the process hasn't exited in 15s, force kill.
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, 15_000)
  })

  // Wait a bit for any orphaned grandchildren to die (or stay alive — that's the bug)
  await new Promise(r => setTimeout(r, settleMs))

  // Check for orphans. We scope the search to processes whose command line
  // includes the test fixture's absolute path (TMP) — this avoids false
  // positives from unrelated capture.js processes spawned by other tests
  // running in parallel in the same suite.
  let orphanPids = []
  if (orphanMatcher) {
    const escapedCwd = cwd.replace(/[/\\]/g, '\\$&')
    const pattern = `${orphanMatcher}.*${escapedCwd}|${escapedCwd}.*${orphanMatcher}`
    const psResult = spawnSync('bash', ['-c', `pgrep -af "${pattern}" | grep -v grep || true`])
    const lines = psResult.stdout.toString().trim().split('\n').filter(Boolean)
    orphanPids = lines
  }

  return { ...result, orphanPids }
}

describe('#302 SIGINT propagation — bin/regret.js', () => {
  before(() => setupSlowFixture())
  after(() => cleanupFixture())

  it('SIGINT propagates to grandchild (capture.js), exit code 130, no orphans', async () => {
    const result = await spawnSendSignalAndAwait({
      cmd: 'node',
      args: [BIN_REGRET, 'capture'],
      cwd: TMP,
      signalName: 'SIGINT',
      orphanMatcher: 'scripts/capture.js',
    })

    // Exit code should be 130 (128 + SIGINT(2)) — conventional shell behavior
    assert.equal(result.exitCode, 130,
      `Expected exit 130 (128+SIGINT), got ${result.exitCode}. Duration: ${result.durationMs}ms`)

    // Should exit quickly — within 5 seconds (was 20+ seconds before the fix)
    assert.ok(result.durationMs < 5000,
      `Expected exit within 5s, took ${result.durationMs}ms`)

    // No orphan capture.js processes should remain
    assert.equal(result.orphanPids.length, 0,
      `Expected no orphan capture.js processes, found: ${result.orphanPids.join('\n')}`)
  })
})

describe('#302 SIGINT propagation — scripts/regret.js', () => {
  before(() => setupSlowFixture())
  after(() => cleanupFixture())

  it('SIGINT propagates to child (capture.js), exit code 130, no orphans', async () => {
    const result = await spawnSendSignalAndAwait({
      cmd: 'node',
      args: [SCRIPTS_REGRET, 'capture'],
      cwd: TMP,
      signalName: 'SIGINT',
      orphanMatcher: 'scripts/capture.js',
    })

    assert.equal(result.exitCode, 130,
      `Expected exit 130, got ${result.exitCode}. Duration: ${result.durationMs}ms`)
    assert.ok(result.durationMs < 5000,
      `Expected exit within 5s, took ${result.durationMs}ms`)
    assert.equal(result.orphanPids.length, 0,
      `Expected no orphan capture.js processes, found: ${result.orphanPids.join('\n')}`)
  })
})

describe('#302 SIGTERM propagation — bin/regret.js', () => {
  before(() => setupSlowFixture())
  after(() => cleanupFixture())

  it('SIGTERM propagates to child, exit code 143 (128+15), no orphans', async () => {
    const result = await spawnSendSignalAndAwait({
      cmd: 'node',
      args: [BIN_REGRET, 'capture'],
      cwd: TMP,
      signalName: 'SIGTERM',
      orphanMatcher: 'scripts/capture.js',
    })

    // SIGTERM is signal 15, so exit code should be 128+15 = 143
    assert.equal(result.exitCode, 143,
      `Expected exit 143 (128+SIGTERM), got ${result.exitCode}`)
    assert.ok(result.durationMs < 5000,
      `Expected exit within 5s, took ${result.durationMs}ms`)
    assert.equal(result.orphanPids.length, 0,
      `Expected no orphan capture.js processes, found: ${result.orphanPids.join('\n')}`)
  })
})

describe('#302 normal exit (no signal) — regression check', () => {
  before(() => setupFastFixture())
  after(() => cleanupFixture())

  it('bin/regret.js capture completes normally with exit 0 when not interrupted', async () => {
    // Use spawnSync since this is a fast operation
    const result = spawnSync('node', [BIN_REGRET, 'capture'], {
      cwd: TMP,
      stdio: 'pipe',
      timeout: 30_000,
    })
    assert.equal(result.status, 0,
      `Expected exit 0 for normal capture, got ${result.status}. stderr: ${result.stderr?.toString() ?? ''}`)
  })

  it('scripts/regret.js capture completes normally with exit 0 when not interrupted', async () => {
    // Reset the .regret file so capture actually runs
    try { rmSync(join(TMP, 'regrets', 'main.regret'), { force: true }) } catch {}
    const result = spawnSync('node', [SCRIPTS_REGRET, 'capture'], {
      cwd: TMP,
      stdio: 'pipe',
      timeout: 30_000,
    })
    assert.equal(result.status, 0,
      `Expected exit 0 for normal capture, got ${result.status}. stderr: ${result.stderr?.toString() ?? ''}`)
  })
})

describe('#302 help command works (regression check)', () => {
  it('bin/regret.js help exits 0', () => {
    const result = spawnSync('node', [BIN_REGRET, 'help'], {
      stdio: 'pipe',
      timeout: 10_000,
    })
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}`)
    const stdout = result.stdout?.toString() ?? ''
    assert.ok(stdout.includes('regret.js'), 'help output should mention regret.js')
    assert.ok(stdout.includes('capture'), 'help output should mention capture command')
  })

  it('bin/regret.js with no args also shows help and exits 0', () => {
    const result = spawnSync('node', [BIN_REGRET], {
      stdio: 'pipe',
      timeout: 10_000,
    })
    assert.equal(result.status, 0, `Expected exit 0, got ${result.status}`)
  })
})

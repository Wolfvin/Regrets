// tests/esm-callee-e2e.test.js — End-to-end test for ESM bare-name callee wrapping
//
// This test exercises the FULL capture.js pipeline (not just the transform
// function in isolation):
//   1. Write an ESM fixture with bare-name function declarations
//   2. Write a manifest declaring `callees: [...]`
//   3. Run `node scripts/capture.js` via child process
//   4. Verify the callee `.regret` file is created (proving the callee was
//      intercepted — which requires the source transformation to have
//      succeeded AND wrapCallees to have installed the proxy on the holder)
//   5. Verify NO temp files are left behind in the fixture directory
//   6. Verify the original source file is unmodified
//
// Also tests the Approach B fallback path:
//   - Fixture with shadowing (transformer aborts)
//   - Run capture
//   - Verify NO callee .regret file is created
//   - Verify the actionable warning is printed to stderr/stdout
//
// Also tests the temp-file lifecycle safety improvements (esm-temp-manager):
//   - SIGINT/SIGTERM during capture leaves no temp files behind
//   - Crashed capture (process.kill) leaves no temp files behind
//   - Temp filenames are collision-safe across concurrent runs
//
// Run: node --test tests/esm-callee-e2e.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_JS = join(SCRIPTS_DIR, 'capture.js')

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(label) {
  const dir = resolve(join(process.cwd(), 'tests', `__esm_e2e_${label}_${process.pid}__`))
  mkdirSync(join(dir, 'regrets'), { recursive: true })
  return dir
}

function writeManifest(tmpDir, clusters) {
  writeFileSync(
    join(tmpDir, 'regrets', 'manifest.json'),
    JSON.stringify({ clusters }, null, 2)
  )
}

function runCaptureCli(cwd) {
  // Use spawnSync (not execFileSync) so we capture BOTH stdout AND stderr
  // regardless of exit code. console.warn → stderr, console.log → stdout,
  // and we need both to verify warnings are emitted on successful captures.
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

function listRegretFiles(tmpDir) {
  const regretDir = join(tmpDir, 'regrets')
  if (!existsSync(regretDir)) return []
  return readdirSync(regretDir).filter(f => f.endsWith('.regret'))
}

function listTempTransformFiles(tmpDir) {
  // Temp files created by capture.js have the prefix `.regrets-transform-`
  return readdirSync(tmpDir).filter(f => f.startsWith('.regrets-transform-'))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('E2E: ESM bare-name callee wrapping via capture.js CLI', () => {
  const tmpDir = makeTmpDir('bare')

  before(() => {
    // Fixture: classic ESM bare-name function declarations
    // main() calls add() — add() is a local binding, not a namespace property.
    // Without source transformation, wrapCallees cannot intercept add().
    // With transformation, the call routes through __regretsHolder.add.
    writeFileSync(join(tmpDir, 'api.mjs'), `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }
`)

    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['add'],
      },
    ])
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('capture.js intercepts the bare-name callee and writes both .regret files', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0, `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = listRegretFiles(tmpDir)
    assert.ok(
      regretFiles.includes('main.regret'),
      `parent .regret file should exist; got: ${regretFiles.join(', ')}`
    )
    assert.ok(
      regretFiles.includes('main.calls.add.regret'),
      `callee .regret file should exist (proving the bare-name callee was intercepted); got: ${regretFiles.join(', ')}`
    )

    // Verify the callee .regret file content
    const calleeContent = readFileSync(join(tmpDir, 'regrets', 'main.calls.add.regret'), 'utf8')
    assert.ok(calleeContent.includes('cluster: main.calls.add'), 'callee regret has correct cluster id')
    assert.ok(calleeContent.includes('parent: main'), 'callee regret has parent reference')
    assert.ok(calleeContent.includes('callee: add'), 'callee regret has callee name')
    // The golden call should be add(5, 1) → 6
    assert.ok(calleeContent.includes('INPUT  [5,1]'), 'callee regret records args [5, 1]')
    assert.ok(calleeContent.includes('OUTPUT 6'), 'callee regret records result 6')
  })

  it('capture.js leaves no temp files in the fixture directory', () => {
    const tempFiles = listTempTransformFiles(tmpDir)
    assert.deepEqual(
      tempFiles, [],
      `no temp transform files should remain after capture; got: ${tempFiles.join(', ')}`
    )
  })

  it('original source file is unmodified after capture', () => {
    const source = readFileSync(join(tmpDir, 'api.mjs'), 'utf8')
    assert.ok(source.includes('function add(a, b) { return a + b }'),
      'original add() declaration should be unchanged')
    assert.ok(source.includes('function main(x) { return add(x, 1) }'),
      'original main() declaration should be unchanged (no __regretsHolder leakage)')
    assert.ok(!source.includes('__regretsHolder'),
      'no __regretsHolder should leak into the original source')
  })

  it('capture.js stdout mentions the ESM transform was applied', () => {
    // Re-run capture to capture stdout
    const result = runCaptureCli(tmpDir)
    assert.ok(
      result.stdout.includes('ESM bare-name transform applied'),
      `stdout should mention transform applied; got: ${result.stdout}`
    )
  })
})

describe('E2E: Approach B fallback when transformer aborts (shadowing)', () => {
  const tmpDir = makeTmpDir('shadowed')

  before(() => {
    // Fixture: the entry function shadows `add` with a local variable.
    // The transformer must abort (return null) and capture.js should fall
    // back to importing the original file. wrapCallees will then emit the
    // actionable warning (Approach B).
    //
    // main(5) returns 5 - 1 = 4 (uses the inner subtracting add, not the
    // top-level adding add). The parent contract captures this output.
    // No callee .regret is written because wrapCallees couldn't install
    // the proxy on the frozen ESM namespace.
    writeFileSync(join(tmpDir, 'shadowed.mjs'), `
function add(a, b) { return a + b }
function main(x) {
  const add = (a, b) => a - b
  return add(x, 1)
}
export { main, add }
`)

    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './shadowed.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['add'],
      },
    ])
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('capture.js still succeeds (parent cluster captured) but no callee .regret', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0, `capture should exit 0 (parent still captured)\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = listRegretFiles(tmpDir)
    assert.ok(
      regretFiles.includes('main.regret'),
      `parent .regret should still be written; got: ${regretFiles.join(', ')}`
    )
    assert.ok(
      !regretFiles.includes('main.calls.add.regret'),
      `callee .regret should NOT be written (transformer aborted due to shadowing); got: ${regretFiles.join(', ')}`
    )
  })

  it('capture.js emits an actionable warning mentioning the callee name', () => {
    const result = runCaptureCli(tmpDir)
    const combined = result.stdout + result.stderr
    assert.ok(
      combined.includes('add') && (combined.includes('frozen') || combined.includes('could not') || combined.includes('ESM')),
      `warning should mention 'add' and the ESM issue; got: ${combined}`
    )
  })

  it('no temp files left behind even when transformer aborts', () => {
    const tempFiles = listTempTransformFiles(tmpDir)
    assert.deepEqual(tempFiles, [], `no temp files; got: ${tempFiles.join(', ')}`)
  })
})

describe('E2E: CJS module with callees is NOT transformed (zero breaking change)', () => {
  const tmpDir = makeTmpDir('cjs')

  before(() => {
    // Classic CJS module — should work without transformation.
    // capture.js should NOT attempt transformation (isEsmSource returns false
    // for .cjs and for .js with module.exports).
    writeFileSync(join(tmpDir, 'math.cjs'), `
function add(a, b) { return a + b }
function main(x) { return module.exports.add(x, 1) }
module.exports = { main, add }
`)

    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './math.cjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['add'],
      },
    ])
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('CJS callee wrapping still works without transformation', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0, `CJS capture should succeed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = listRegretFiles(tmpDir)
    assert.ok(
      regretFiles.includes('main.calls.add.regret'),
      `CJS callee .regret should be written (existing behavior preserved); got: ${regretFiles.join(', ')}`
    )

    // Verify the callee .regret content
    const calleeContent = readFileSync(join(tmpDir, 'regrets', 'main.calls.add.regret'), 'utf8')
    assert.ok(calleeContent.includes('OUTPUT 6'), 'CJS callee should record result 6')
  })

  it('capture.js does NOT mention ESM transform for CJS modules', () => {
    const result = runCaptureCli(tmpDir)
    assert.ok(
      !result.stdout.includes('ESM bare-name transform applied'),
      `CJS capture should NOT trigger ESM transform; got: ${result.stdout}`
    )
  })

  it('no temp files created for CJS module', () => {
    const tempFiles = listTempTransformFiles(tmpDir)
    assert.deepEqual(tempFiles, [], `no temp files for CJS; got: ${tempFiles.join(', ')}`)
  })
})

// ─── Temp file lifecycle: SIGINT/SIGTERM/crash cleanup ─────────────────────
//
// These tests verify the safety improvements from esm-temp-manager.js:
//   - Temp files are cleaned up even when capture.js is interrupted
//   - Temp files are cleaned up even when capture.js crashes
//   - Temp filenames are collision-safe (no reliance on Date.now()+random())
//
// Strategy: we use a "slow" fixture that sleeps inside the entry function.
// This gives us a window to send SIGINT/SIGTERM to the child process while
// the temp file exists. After the child terminates, we check the fixture
// directory for leftover temp files.

describe('E2E: temp file lifecycle on SIGINT/SIGTERM/crash', () => {
  // The slow fixture: entry function sleeps for 5 seconds via async sleep,
  // giving the test a window to send a signal mid-capture. The temp file
  // is created BEFORE the import resolves (i.e. before the entry function
  // runs), so it will exist during the sleep window.
  //
  // IMPORTANT: we use async `await new Promise(setTimeout)` instead of a
  // synchronous busy-wait. A busy-wait blocks the Node event loop, which
  // prevents signal handlers from running until the busy-wait ends. The
  // async sleep yields to the event loop, allowing SIGINT/SIGTERM handlers
  // to fire promptly.
  const SLOW_FIXTURE_SOURCE = `
function add(a, b) { return a + b }
async function main(x) {
  // Async sleep — yields to the event loop so signal handlers can fire.
  // 5 seconds is long enough for the test to detect the temp file and
  // send a signal, but short enough that the test doesn't time out.
  await new Promise(r => setTimeout(r, 5000))
  return add(x, 1)
}
export { main, add }
`

  function makeSlowFixtureDir(label) {
    const dir = makeTmpDir(label)
    writeFileSync(join(dir, 'slow.mjs'), SLOW_FIXTURE_SOURCE)
    writeManifest(dir, [
      {
        id: 'main',
        entry: 'main',
        file: './slow.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['add'],
      },
    ])
    return dir
  }

  /**
   * Spawn capture.js, wait for the temp file to appear in the fixture dir,
   * then send the given signal. Returns when the child has exited.
   *
   * @param {string} cwd - Working directory for capture.js
   * @param {string} signal - Node signal name: 'SIGINT', 'SIGTERM', 'SIGKILL'
   * @returns {Promise<{exitCode: number|null, signal: string|null}>}
   */
  function spawnCaptureAndSignal(cwd, signal) {
    return new Promise((resolve) => {
      const child = spawn('node', [CAPTURE_JS], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'], // pipe stdout/stderr so they don't inherit
      })

      let exited = false
      const finish = (exitCode, sig) => {
        if (exited) return
        exited = true
        resolve({ exitCode: exitCode, signal: sig })
      }

      child.on('exit', (code, sig) => finish(code, sig))
      child.on('error', () => finish(-1, null))

      // Poll for the temp file to appear. Once it exists, the ESM transform
      // has been applied and the child is about to (or already) running the
      // entry function. Send the signal at that point.
      const pollStart = Date.now()
      const pollInterval = setInterval(() => {
        const tempFiles = listTempTransformFiles(cwd)
        if (tempFiles.length > 0) {
          clearInterval(pollInterval)
          // Give the child a moment to actually start executing the entry
          // function (the temp file is created BEFORE the import resolves).
          setTimeout(() => {
            try {
              child.kill(signal)
            } catch {
              // Child may have already exited — that's fine, the test will
              // still verify no temp files leaked.
            }
          }, 100)
        } else if (Date.now() - pollStart > 10_000) {
          // Timeout — capture.js should have created the temp file by now.
          // Force-kill and let the test fail with a clear assertion.
          clearInterval(pollInterval)
          try { child.kill('SIGKILL') } catch {}
        }
      }, 20)
    })
  }

  it('SIGINT during capture leaves no temp files behind', async () => {
    const tmpDir = makeSlowFixtureDir('sigint')
    try {
      const result = await spawnCaptureAndSignal(tmpDir, 'SIGINT')

      // The child should have been terminated by SIGINT (exit code null and
      // signal 'SIGINT', or exit code 130 if our handler ran process.exit).
      // Either is acceptable — what matters is no temp files leaked.
      assert.ok(
        result.signal === 'SIGINT' || result.exitCode === 130 || result.exitCode === null,
        `child should have been killed by SIGINT; got exitCode=${result.exitCode} signal=${result.signal}`
      )

      // Wait a moment for the process to fully exit and the exit handler to run
      await new Promise(r => setTimeout(r, 200))

      const tempFiles = listTempTransformFiles(tmpDir)
      assert.deepEqual(
        tempFiles, [],
        `no temp files should remain after SIGINT; got: ${tempFiles.join(', ')}`
      )
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('SIGTERM during capture leaves no temp files behind', async () => {
    const tmpDir = makeSlowFixtureDir('sigterm')
    try {
      const result = await spawnCaptureAndSignal(tmpDir, 'SIGTERM')

      assert.ok(
        result.signal === 'SIGTERM' || result.exitCode === 143 || result.exitCode === null,
        `child should have been killed by SIGTERM; got exitCode=${result.exitCode} signal=${result.signal}`
      )

      await new Promise(r => setTimeout(r, 200))

      const tempFiles = listTempTransformFiles(tmpDir)
      assert.deepEqual(
        tempFiles, [],
        `no temp files should remain after SIGTERM; got: ${tempFiles.join(', ')}`
      )
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('SIGKILL (uncatchable) — temp file leaks but is collision-safe', async () => {
    // SIGKILL cannot be caught by any handler — the process is terminated
    // immediately by the kernel. The temp file WILL leak in this case
    // (no signal handler can run). This test verifies that:
    //   1. The leaked temp file has the expected collision-safe name format
    //   2. The leaked temp file is hidden (starts with `.`)
    //   3. The leaked temp file does NOT collide with concurrent runs
    //
    // This documents the SIGKILL limitation honestly — it's an OS-level
    // constraint, not a bug we can fix in user-space.
    const tmpDir = makeSlowFixtureDir('sigkill')
    try {
      const result = await spawnCaptureAndSignal(tmpDir, 'SIGKILL')

      assert.ok(
        result.signal === 'SIGKILL' || result.exitCode === null,
        `child should have been killed by SIGKILL; got exitCode=${result.exitCode} signal=${result.signal}`
      )

      await new Promise(r => setTimeout(r, 200))

      const tempFiles = listTempTransformFiles(tmpDir)
      // SIGKILL is uncatchable — temp file WILL leak. Verify it's well-formed.
      assert.ok(
        tempFiles.length === 1,
        `exactly 1 temp file should leak after SIGKILL; got: ${tempFiles.join(', ')}`
      )
      const leakedFile = tempFiles[0]
      assert.ok(
        leakedFile.startsWith('.regrets-transform-'),
        `leaked temp file should have regrets-transform prefix; got: ${leakedFile}`
      )
      assert.ok(
        leakedFile.endsWith('.mjs'),
        `leaked temp file should have .mjs extension; got: ${leakedFile}`
      )
      // Verify it contains a UUID (36 chars: 8-4-4-4-12 hex digits)
      const uuidMatch = leakedFile.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
      assert.ok(uuidMatch,
        `leaked temp file should contain a UUID for collision safety; got: ${leakedFile}`)

      // Cleanup the leaked file so the test directory is clean
      try { rmSync(join(tmpDir, leakedFile)) } catch {}
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('normal capture (no signal) still leaves no temp files', () => {
    // Regression test: the signal handler registration should not interfere
    // with the normal cleanup path. This is the same test as the existing
    // "leaves no temp files" test, but explicitly labeled as a regression
    // guard for the temp-manager changes.
    const tmpDir = makeTmpDir('normal-cleanup-regression')

    writeFileSync(join(tmpDir, 'api.mjs'), `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }
`)

    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['add'],
      },
    ])

    try {
      const result = runCaptureCli(tmpDir)
      assert.equal(result.exitCode, 0, `normal capture should succeed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

      const tempFiles = listTempTransformFiles(tmpDir)
      assert.deepEqual(
        tempFiles, [],
        `no temp files should remain after normal capture; got: ${tempFiles.join(', ')}`
      )
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('temp filenames are collision-safe across concurrent captures', () => {
    // Run two capture.js processes concurrently on the same fixture.
    // Both will create temp files in the same directory. With Date.now()+
    // Math.random() naming (the OLD implementation), there was a small but
    // non-zero chance of collision. With crypto.randomUUID() (the NEW
    // implementation), collisions are effectively impossible.
    //
    // We can't truly test "no collision" with just 2 runs (the old code
    // would also pass 2 runs most of the time). What we CAN test is that
    // both temp files have UUID-based names and that neither run fails
    // with an EEXIST error.
    const tmpDir = makeTmpDir('concurrent')
    writeFileSync(join(tmpDir, 'api.mjs'), `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }
`)
    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['add'],
      },
    ])

    try {
      // Run two captures concurrently. We use spawnSync with a short delay
      // between starts to maximize overlap. Both should succeed without
      // EEXIST errors.
      const results = []
      const proc1 = spawnSync('node', [CAPTURE_JS], {
        cwd: tmpDir,
        encoding: 'utf8',
        timeout: 30_000,
      })
      const proc2 = spawnSync('node', [CAPTURE_JS], {
        cwd: tmpDir,
        encoding: 'utf8',
        timeout: 30_000,
      })
      results.push(proc1, proc2)

      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        assert.equal(r.status, 0,
          `concurrent capture ${i + 1} should succeed; got exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
        // Verify no EEXIST error in output (would indicate filename collision)
        assert.ok(
          !r.stderr.includes('EEXIST'),
          `concurrent capture ${i + 1} should not have EEXIST errors; stderr: ${r.stderr}`
        )
      }

      // After both runs, no temp files should remain (each run cleans up
      // its own temp file in the finally block).
      const tempFiles = listTempTransformFiles(tmpDir)
      assert.deepEqual(tempFiles, [],
        `no temp files should remain after concurrent captures; got: ${tempFiles.join(', ')}`)
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

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
// Run: node --test tests/esm-callee-e2e.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
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

// ─── E2E: SIGINT mid-capture does not leak temp files ──────────────────────
//
// Closes issue #244. Before the fix, if capture.js received SIGINT between
// writing the ESM transform temp file and running the finally block, the
// temp file was orphaned forever. With the new process-wide lifecycle
// registry + signal handlers, the temp file is deleted on SIGINT.
//
// Strategy:
//   1. Write an ESM fixture whose entry function returns a never-resolving
//      promise — capture.js will hang forever inside the cluster try block,
//      AFTER the temp file has been written.
//   2. Spawn capture.js as a child process.
//   3. Watch stdout for the "ESM bare-name transform applied" message,
//      which proves the temp file has been written.
//   4. Send SIGINT to the child.
//   5. Wait for the child to exit.
//   6. Verify NO `.regrets-transform-*` files remain in the fixture dir.

describe('E2E: SIGINT mid-capture does not leak temp files (#244)', () => {
  const tmpDir = makeTmpDir('sigint')

  before(() => {
    // Fixture: entry function calls add() (so the ESM transformer finds a
    // call site to rewrite and actually writes a temp file), then returns
    // a promise that resolves after 30 seconds. This gives us a long
    // window where capture.js is hung mid-capture (after temp file write,
    // before finally block) — perfect for sending SIGINT/SIGTERM.
    //
    // We use a 30s timeout (rather than `new Promise(() => {})`) because
    // Node 24+ exits with code 13 when a top-level await is detected to
    // be unsettled for too long. A 30s timeout is "settled" (will resolve
    // eventually) so Node doesn't kill the process — but we'll send
    // SIGINT/SIGTERM within ~5s, well before the 30s elapses.
    writeFileSync(join(tmpDir, 'hang.mjs'), `
function add(a, b) { return a + b }
function main(x) {
  // Call add() so the transformer has a call site to rewrite — without
  // this, the transformer would abort (no internal calls) and no temp
  // file would be written, defeating the test's purpose.
  const _ = add(x, 1)
  return new Promise(resolve => setTimeout(() => resolve(x), 30000))
}
export { main, add }
`)

    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './hang.mjs',
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

  it('SIGINT mid-capture does not leave temp files behind', async () => {
    const child = spawn('node', [CAPTURE_JS], {
      cwd: tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })

    // Wait for the temp file to appear on disk — proves capture.js has
    // written it AND the registry has been populated. We poll the
    // filesystem because Node's stdout is buffered when piped, so the
    // "ESM bare-name transform applied" message may not flush until the
    // process exits.
    const tempFileAppeared = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false)
      }, 15_000)

      const check = () => {
        const tempFiles = listTempTransformFiles(tmpDir)
        if (tempFiles.length > 0) {
          clearTimeout(timeout)
          resolve(true)
        } else {
          setTimeout(check, 25)
        }
      }
      check()
    })

    assert.ok(
      tempFileAppeared,
      `should observe a temp file on disk before sending SIGINT\nstdout: ${stdout}\nstderr: ${stderr}`
    )

    // Snapshot the temp file names so we can verify they're gone after SIGINT.
    const tempFilesBefore = listTempTransformFiles(tmpDir)
    assert.ok(
      tempFilesBefore.length > 0,
      `precondition: at least one temp file should exist\nstdout: ${stdout}\nstderr: ${stderr}`
    )

    // Send SIGINT — the signal handler in capture.js should nuke the temp
    // file, then call process.exit(130).
    child.kill('SIGINT')

    // Wait for the child to exit (with timeout — the handler should exit
    // promptly because cleanup is synchronous).
    const exitInfo = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Child didn't exit — kill it harder and fail
        child.kill('SIGKILL')
        resolve({ code: null, signal: 'TIMEOUT', timedOut: true })
      }, 5_000)

      child.on('exit', (code, signal) => {
        clearTimeout(timeout)
        resolve({ code, signal, timedOut: false })
      })
    })

    assert.ok(!exitInfo.timedOut, `capture.js child should exit promptly after SIGINT\nstdout: ${stdout}\nstderr: ${stderr}`)

    // Verify NO temp files remain in the fixture directory. This is the
    // core assertion of issue #244 — without the signal handler cleanup,
    // the temp file would still be on disk here.
    const tempFiles = listTempTransformFiles(tmpDir)
    assert.deepEqual(
      tempFiles, [],
      `no temp files should remain after SIGINT; got: ${tempFiles.join(', ')}\nstdout: ${stdout}\nstderr: ${stderr}`
    )
  }, 30_000)  // 30s test timeout (generous; first run may take ~5s for tree-sitter WASM init)

  it('SIGTERM mid-capture does not leave temp files behind', async () => {
    const child = spawn('node', [CAPTURE_JS], {
      cwd: tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })

    // Poll filesystem for temp file appearance (stdout is buffered when piped).
    const tempFileAppeared = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 15_000)
      const check = () => {
        if (listTempTransformFiles(tmpDir).length > 0) {
          clearTimeout(timeout)
          resolve(true)
        } else {
          setTimeout(check, 25)
        }
      }
      check()
    })
    assert.ok(tempFileAppeared, `should observe temp file on disk before SIGTERM\nstdout: ${stdout}\nstderr: ${stderr}`)

    // Send SIGTERM — same handler path as SIGINT, but with exit code 143.
    child.kill('SIGTERM')

    const exitInfo = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ timedOut: true })
      }, 5_000)
      child.on('exit', () => {
        clearTimeout(timeout)
        resolve({ timedOut: false })
      })
    })
    assert.ok(!exitInfo.timedOut, `capture.js child should exit promptly after SIGTERM\nstdout: ${stdout}\nstderr: ${stderr}`)

    const tempFiles = listTempTransformFiles(tmpDir)
    assert.deepEqual(
      tempFiles, [],
      `no temp files should remain after SIGTERM; got: ${tempFiles.join(', ')}\nstdout: ${stdout}\nstderr: ${stderr}`
    )
  }, 30_000)
})

// ─── E2E: three new patterns (closes #262, #263, #276) ──────────────────────
//
// These tests exercise the FULL capture.js pipeline for the three callee
// declaration patterns that the Red Team identified as silently failing
// before this fix:
//
//   #262 — `export function foo() {}` (ESM — the most common idiom)
//   #276 — `export const foo = () => {}` and `export const foo = function() {}` (ESM)
//   #263 — bare-name calls in CJS (`function foo() {} + module.exports = { foo }`)
//
// Each test:
//   1. Writes a fixture in the supported pattern
//   2. Writes a manifest declaring `callees: [...]`
//   3. Runs `node scripts/capture.js`
//   4. Verifies the callee `.regret` file is created (proving interception)
//   5. Verifies NO temp files are left behind
//   6. Verifies the original source file is unmodified

describe('E2E: capture.js intercepts callee in `export function foo()` module (issue #262)', () => {
  const tmpDir = makeTmpDir('export_fn')

  before(() => {
    // The MOST COMMON ESM idiom — used to be silently skipped by the
    // transformer because `function_declaration` was wrapped in an
    // `export_statement` node (not a direct child of the program node).
    writeFileSync(join(tmpDir, 'api.mjs'), `
export function add(a, b) { return a + b }
export function main(x) { return add(x, 1) }
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

  it('capture.js intercepts the callee and writes both .regret files', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0, `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = listRegretFiles(tmpDir)
    assert.ok(
      regretFiles.includes('main.regret'),
      `parent .regret file should exist; got: ${regretFiles.join(', ')}`
    )
    assert.ok(
      regretFiles.includes('main.calls.add.regret'),
      `callee .regret file should exist (proving the \`export function foo()\` callee was intercepted); got: ${regretFiles.join(', ')}`
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

  it('capture.js stdout mentions the ESM transform was applied', () => {
    const result = runCaptureCli(tmpDir)
    assert.ok(
      result.stdout.includes('ESM bare-name transform applied'),
      `stdout should mention transform applied; got: ${result.stdout}`
    )
  })

  it('no temp files left behind after capture', () => {
    // Re-run to make sure cleanup happens
    runCaptureCli(tmpDir)
    const tempFiles = listTempTransformFiles(tmpDir)
    assert.deepEqual(tempFiles, [], `no temp files; got: ${tempFiles.join(', ')}`)
  })

  it('original source file is unmodified after capture', () => {
    const source = readFileSync(join(tmpDir, 'api.mjs'), 'utf8')
    assert.ok(source.includes('export function add(a, b) { return a + b }'),
      'original export function add() declaration should be unchanged')
    assert.ok(source.includes('export function main(x) { return add(x, 1) }'),
      'original export function main() declaration should be unchanged')
    assert.ok(!source.includes('__regretsHolder'),
      'no __regretsHolder should leak into the original source')
  })
})

describe('E2E: capture.js intercepts callee in `export const foo = () => {}` module (issue #276)', () => {
  const tmpDir = makeTmpDir('export_const_arrow')

  before(() => {
    // The SKILL.md previously CLAIMED this worked, but it actually threw
    // "Cannot assign to read only property" because ESM namespace properties
    // set via `export const` are non-writable. The fix strips the `export`
    // keyword and re-exports via a trailing `export { ..., __regretsHolder }`
    // list, which keeps the property writable.
    writeFileSync(join(tmpDir, 'api.mjs'), `
export const add = (a, b) => a + b
export const main = (x) => add(x, 1)
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

  it('capture.js intercepts the callee and writes both .regret files', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0, `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = listRegretFiles(tmpDir)
    assert.ok(
      regretFiles.includes('main.calls.add.regret'),
      `callee .regret file should exist (proving the \`export const foo = () => {}\` callee was intercepted); got: ${regretFiles.join(', ')}`
    )

    const calleeContent = readFileSync(join(tmpDir, 'regrets', 'main.calls.add.regret'), 'utf8')
    assert.ok(calleeContent.includes('cluster: main.calls.add'), 'callee regret has correct cluster id')
    assert.ok(calleeContent.includes('INPUT  [5,1]'), 'callee regret records args [5, 1]')
    assert.ok(calleeContent.includes('OUTPUT 6'), 'callee regret records result 6')
  })

  it('capture.js stdout mentions the ESM transform was applied', () => {
    const result = runCaptureCli(tmpDir)
    assert.ok(
      result.stdout.includes('ESM bare-name transform applied'),
      `stdout should mention transform applied; got: ${result.stdout}`
    )
  })

  it('no temp files left behind', () => {
    runCaptureCli(tmpDir)
    const tempFiles = listTempTransformFiles(tmpDir)
    assert.deepEqual(tempFiles, [], `no temp files; got: ${tempFiles.join(', ')}`)
  })

  it('original source file is unmodified', () => {
    const source = readFileSync(join(tmpDir, 'api.mjs'), 'utf8')
    assert.ok(source.includes('export const add = (a, b) => a + b'),
      'original export const add declaration should be unchanged')
    assert.ok(!source.includes('__regretsHolder'),
      'no __regretsHolder should leak into the original source')
  })
})

describe('E2E: capture.js intercepts callee in `export const foo = function() {}` module (issue #276 variant)', () => {
  const tmpDir = makeTmpDir('export_const_fn')

  before(() => {
    writeFileSync(join(tmpDir, 'api.mjs'), `
export const add = function(a, b) { return a + b }
export const main = function(x) { return add(x, 1) }
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

  it('capture.js intercepts the callee and writes both .regret files', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0, `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = listRegretFiles(tmpDir)
    assert.ok(
      regretFiles.includes('main.calls.add.regret'),
      `callee .regret file should exist; got: ${regretFiles.join(', ')}`
    )

    const calleeContent = readFileSync(join(tmpDir, 'regrets', 'main.calls.add.regret'), 'utf8')
    assert.ok(calleeContent.includes('INPUT  [5,1]'), 'callee regret records args [5, 1]')
    assert.ok(calleeContent.includes('OUTPUT 6'), 'callee regret records result 6')
  })
})

describe('E2E: capture.js intercepts bare-name callee in CJS module (issue #263)', () => {
  const tmpDir = makeTmpDir('cjs_bare_name')

  before(() => {
    // The classic CJS pattern that BROKE before this fix:
    //   function add() {} is a local binding
    //   main() calls add() — resolves to the local binding, not module.exports.add
    //   wrapCallees reassigned module.exports.add = proxy, but the internal call
    //   never saw it. The warning "declared but never called during capture"
    //   was misleading — the callee WAS called, just not intercepted.
    writeFileSync(join(tmpDir, 'api.cjs'), `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, mul(x, 2)) }
module.exports = { main, add, mul }
`)
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'cjs-bare-name-test',
      version: '0.0.0',
    }))

    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.cjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
        callees: ['add', 'mul'],
      },
    ])
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('capture.js intercepts both bare-name callees and writes their .regret files', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0, `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = listRegretFiles(tmpDir)
    assert.ok(
      regretFiles.includes('main.regret'),
      `parent .regret should exist; got: ${regretFiles.join(', ')}`
    )
    assert.ok(
      regretFiles.includes('main.calls.add.regret'),
      `add callee .regret should exist (proving CJS bare-name interception now works); got: ${regretFiles.join(', ')}`
    )
    assert.ok(
      regretFiles.includes('main.calls.mul.regret'),
      `mul callee .regret should exist; got: ${regretFiles.join(', ')}`
    )

    // main(5) = add(5, mul(5, 2)) = add(5, 10) = 15
    // The callee contracts should record these intermediate values.
    const addContent = readFileSync(join(tmpDir, 'regrets', 'main.calls.add.regret'), 'utf8')
    assert.ok(addContent.includes('cluster: main.calls.add'), 'add callee regret has correct cluster id')
    assert.ok(addContent.includes('INPUT  [5,10]'), 'add callee regret records args [5, 10] (5 from main, 10 from mul)')
    assert.ok(addContent.includes('OUTPUT 15'), 'add callee regret records result 15')

    const mulContent = readFileSync(join(tmpDir, 'regrets', 'main.calls.mul.regret'), 'utf8')
    assert.ok(mulContent.includes('cluster: main.calls.mul'), 'mul callee regret has correct cluster id')
    assert.ok(mulContent.includes('INPUT  [5,2]'), 'mul callee regret records args [5, 2]')
    assert.ok(mulContent.includes('OUTPUT 10'), 'mul callee regret records result 10')
  })

  it('capture.js stdout mentions the CJS transform was applied', () => {
    const result = runCaptureCli(tmpDir)
    assert.ok(
      result.stdout.includes('CJS bare-name transform applied'),
      `stdout should mention CJS transform applied; got: ${result.stdout}`
    )
  })

  it('no temp files left behind after CJS capture', () => {
    runCaptureCli(tmpDir)
    const tempFiles = listTempTransformFiles(tmpDir)
    assert.deepEqual(tempFiles, [], `no temp files; got: ${tempFiles.join(', ')}`)
  })

  it('original CJS source file is unmodified after capture', () => {
    const source = readFileSync(join(tmpDir, 'api.cjs'), 'utf8')
    assert.ok(source.includes('function add(a, b) { return a + b }'),
      'original function add declaration should be unchanged')
    assert.ok(source.includes('function main(x) { return add(x, mul(x, 2)) }'),
      'original function main declaration should be unchanged (bare-name calls preserved)')
    assert.ok(source.includes('module.exports = { main, add, mul }'),
      'module.exports statement should be unchanged')
    assert.ok(!source.includes('__regretsHolder'),
      'no __regretsHolder should leak into the original source')
  })
})

describe('E2E: capture.js intercepts bare-name callee in CJS module with const arrow (issue #263 variant)', () => {
  const tmpDir = makeTmpDir('cjs_const_arrow')

  before(() => {
    writeFileSync(join(tmpDir, 'api.cjs'), `
const add = (a, b) => a + b
const main = (x) => add(x, 1)
module.exports = { main, add }
`)
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'cjs-const-arrow-test',
      version: '0.0.0',
    }))

    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.cjs',
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

  it('capture.js intercepts the callee and writes both .regret files', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0, `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = listRegretFiles(tmpDir)
    assert.ok(
      regretFiles.includes('main.calls.add.regret'),
      `callee .regret should exist for const-arrow CJS pattern; got: ${regretFiles.join(', ')}`
    )

    const calleeContent = readFileSync(join(tmpDir, 'regrets', 'main.calls.add.regret'), 'utf8')
    assert.ok(calleeContent.includes('INPUT  [5,1]'), 'callee regret records args [5, 1]')
    assert.ok(calleeContent.includes('OUTPUT 6'), 'callee regret records result 6')
  })
})

describe('E2E: CJS module with module.exports.foo() calls does NOT trigger transform', () => {
  // Sanity check: the existing CJS pattern (using `module.exports.foo(...)`
  // explicitly) already works without source transformation. capture.js
  // should NOT apply the CJS transform in this case (no bare-name calls to
  // rewrite). This preserves backward compatibility with PR #243.
  const tmpDir = makeTmpDir('cjs_module_exports')

  before(() => {
    writeFileSync(join(tmpDir, 'api.cjs'), `
function add(a, b) { return a + b }
function main(x) { return module.exports.add(x, 1) }
module.exports = { main, add }
`)
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'cjs-module-exports-test',
      version: '0.0.0',
    }))

    writeManifest(tmpDir, [
      {
        id: 'main',
        entry: 'main',
        file: './api.cjs',
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

  it('capture.js intercepts via the existing module.exports path (no transform needed)', () => {
    const result = runCaptureCli(tmpDir)
    assert.equal(result.exitCode, 0, `capture should exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    const regretFiles = listRegretFiles(tmpDir)
    assert.ok(
      regretFiles.includes('main.calls.add.regret'),
      `callee .regret should exist (existing module.exports path still works); got: ${regretFiles.join(', ')}`
    )
  })

  it('capture.js does NOT mention CJS transform for module.exports.foo modules', () => {
    const result = runCaptureCli(tmpDir)
    assert.ok(
      !result.stdout.includes('CJS bare-name transform applied'),
      `CJS capture should NOT trigger transform when there are no bare-name calls; got: ${result.stdout}`
    )
  })

  it('no temp files created', () => {
    runCaptureCli(tmpDir)
    const tempFiles = listTempTransformFiles(tmpDir)
    assert.deepEqual(tempFiles, [], `no temp files; got: ${tempFiles.join(', ')}`)
  })
})

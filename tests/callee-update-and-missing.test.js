// tests/callee-update-and-missing.test.js — Tests for #284 + #288 fixes
//
// Validates four behavioral changes to `regret validate` / `regret update`:
//
// #284 — three sub-bugs around callee contracts:
//   Bug A: `regret update <parent>` must also re-capture and update all
//          `<parent>.calls.*.regret` files, not just the parent. Previously,
//          the next `regret validate` would report callee FAIL because the
//          golden callee hash no longer matched the live callee behavior
//          (which the user had just confirmed via --reason).
//   Bug B: `regret update <parent>.calls.<callee>` (direct callee update)
//          must FAIL with a clear error pointing the user to update the
//          parent or re-capture instead. Previously it silently exited 0
//          with "0 updated", misleading the user.
//   Bug C: `regret validate --cluster <parent>` must still re-validate the
//          callee contracts of that parent. Previously, the --cluster filter
//          excluded `.calls.*.regret` files from regretFiles AND the
//          `runCalleePhase` was gated on `!clusterFilter`, producing a
//          false GREEN when a callee regression preserved the parent output.
//
// #288 — missing callee .regret detection:
//   If a manifest parent declares `callees: [...]` but the corresponding
//   `<parent>.calls.<callee>.regret` file does not exist (e.g. capture
//   failed, file deleted manually), validate must FAIL with a clear message.
//   Previously it silently PASSED — false sense of security.
//   `--skip-callees` opts out of this check entirely.
//
// Run: node --test tests/callee-update-and-missing.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const VALIDATE_JS = join(SCRIPTS_DIR, 'validate.js')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')

// ─── Helpers ────────────────────────────────────────────────────────────────

const TMP = resolve(join(process.cwd(), 'tests', `__callee_upd_${process.pid}__`))

function setupProject(apiSource, manifestClusters) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), apiSource)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: manifestClusters,
  }, null, 2))
}

function rewriteApi(apiSource) {
  writeFileSync(join(TMP, 'api.mjs'), apiSource)
}

function rewriteManifest(manifest) {
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))
}

function runCli(cwd, args = []) {
  const result = spawnSync('node', [VALIDATE_JS, ...args], {
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

function runCapture(cwd, args = []) {
  const result = spawnSync('node', [CAPTURE_JS, ...args], {
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

function readRegretHash(clusterId) {
  const path = join(TMP, 'regrets', `${clusterId}.regret`)
  const content = readFileSync(path, 'utf8')
  const m = content.match(/^HASH\s+(\S+)/m)
  return m ? m[1] : null
}

function listRegretFiles() {
  return readdirSync(join(TMP, 'regrets')).filter(f => f.endsWith('.regret'))
}

// ─── #284 Bug A: regret update <parent> updates callee .regret files ──────

describe('#284 Bug A: regret update <parent> updates callee .regret files', () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`
  const manifestClusters = [
    {
      id: 'main',
      entry: 'main',
      file: './api.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [5],
      watches: [],
      callees: ['add', 'mul'],
    },
  ]

  before(() => {
    setupProject(originalApi, manifestClusters)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('mutates add() — regret update main updates both main.regret AND main.calls.add.regret', () => {
    // Snapshot golden hashes before update
    const mainHashBefore = readRegretHash('main')
    const addHashBefore  = readRegretHash('main.calls.add')
    const mulHashBefore  = readRegretHash('main.calls.mul')
    assert.ok(mainHashBefore, 'main.regret should exist with a hash')
    assert.ok(addHashBefore, 'main.calls.add.regret should exist with a hash')
    assert.ok(mulHashBefore, 'main.calls.mul.regret should exist with a hash')

    // Mutate add() so its behavior changes (and consequently main's output too)
    rewriteApi(`
function add(a, b) { return a + b + 100 }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`)

    const result = runCli(TMP, ['--update', 'main', '--reason', 'add now adds 100 to every result for tax calc'])
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    // Parent should be updated
    assert.match(result.stdout, /main.*UPDATED/, 'should report main UPDATED')

    // Callee add should be updated — it changed
    assert.match(
      result.stdout,
      /main\.calls\.add.*UPDATED \(callee\)/,
      `should report main.calls.add UPDATED (callee); got:\n${result.stdout}`
    )

    // Callee mul should NOT be updated (no behavior change) — should not appear
    // with "UPDATED (callee)" marker
    assert.doesNotMatch(
      result.stdout,
      /main\.calls\.mul.*UPDATED \(callee\)/,
      'should NOT update main.calls.mul (unchanged)'
    )

    // Summary line should mention callee contracts updated
    assert.match(
      result.stdout,
      /1 callee contract also updated/,
      `summary should mention 1 callee contract updated; got:\n${result.stdout}`
    )

    // Verify the .regret files were actually written with new hashes
    const mainHashAfter = readRegretHash('main')
    const addHashAfter  = readRegretHash('main.calls.add')
    const mulHashAfter  = readRegretHash('main.calls.mul')

    assert.notEqual(mainHashAfter, mainHashBefore, 'main hash should change after update')
    assert.notEqual(addHashAfter, addHashBefore, 'main.calls.add hash should change after update')
    assert.equal(mulHashAfter, mulHashBefore, 'main.calls.mul hash should be unchanged (callee unchanged)')
  })

  it('next regret validate PASSES — callees are in sync with parent', () => {
    // This is the core of #284 Bug A: previously, after updating the parent,
    // the next validate would FAIL on the callee because its golden was stale.
    // Now that update also refreshed the callee, validate should PASS.
    const result = runCli(TMP)
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
    assert.match(result.stdout, /All 1 tests passed, 2 callee contracts verified/, 'should report all PASS with callees verified')
  })

  it('update parent with no callee behavior change — callees stay unchanged', () => {
    // Restore original behavior, then re-capture fresh.
    rewriteApi(originalApi)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `re-capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)

    const mainHashBefore = readRegretHash('main')
    const addHashBefore  = readRegretHash('main.calls.add')

    // Now change ONLY main's body in a way that changes output but keeps
    // add() unchanged — e.g., main calls mul differently.
    rewriteApi(`
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) + 1 }
export { main, add, mul }
`)

    const result = runCli(TMP, ['--update', 'main', '--reason', 'main now adds 1 to the result for rounding'])
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Parent should be updated
    assert.match(result.stdout, /main.*UPDATED/, 'main should be UPDATED')

    // Callee add should NOT be updated (no behavior change)
    assert.doesNotMatch(
      result.stdout,
      /main\.calls\.add.*UPDATED \(callee\)/,
      'should NOT update main.calls.add (unchanged)'
    )

    // main hash should change, add hash should not
    const mainHashAfter = readRegretHash('main')
    const addHashAfter  = readRegretHash('main.calls.add')
    assert.notEqual(mainHashAfter, mainHashBefore, 'main hash should change')
    assert.equal(addHashAfter, addHashBefore, 'main.calls.add hash should be unchanged')
  })

  it('update parent warns when callee .regret file is missing', () => {
    // Delete one callee .regret file to simulate missing-contract scenario
    rmSync(join(TMP, 'regrets', 'main.calls.add.regret'))

    // Mutate main so update has something to do
    rewriteApi(`
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) + 2 }
export { main, add, mul }
`)

    const result = runCli(TMP, ['--update', 'main', '--reason', 'main now adds 2 for additional rounding buffer'])
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Should warn about missing callee contract
    assert.match(
      result.stdout,
      /main\.calls\.add.*missing — run `regret capture --cluster main` to generate/,
      'should warn about missing main.calls.add.regret'
    )

    // Summary line should mention missing callee
    assert.match(
      result.stdout,
      /1 callee contract missing/,
      `summary should mention 1 callee contract missing; got:\n${result.stdout}`
    )
  })
})

// ─── #284 Bug B: direct callee update rejected ────────────────────────────

describe('#284 Bug B: regret update <parent>.calls.<callee> rejected', () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`
  const manifestClusters = [
    {
      id: 'main',
      entry: 'main',
      file: './api.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [5],
      watches: [],
      callees: ['add', 'mul'],
    },
  ]

  before(() => {
    setupProject(originalApi, manifestClusters)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('regret update main.calls.add fails with exit 1 and clear error', () => {
    const result = runCli(TMP, ['--update', 'main.calls.add', '--reason', 'trying to update callee directly here'])
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)

    // Error message should clearly say callee contracts cannot be updated directly
    assert.match(
      result.stderr,
      /Cannot update callee contract "main\.calls\.add" directly/,
      'stderr should reject direct callee update'
    )

    // Error should point the user to the parent or re-capture
    assert.match(
      result.stderr,
      /regret update main --reason/,
      'should suggest updating the parent instead'
    )
    assert.match(
      result.stderr,
      /regret capture --cluster main/,
      'should suggest re-capturing the parent'
    )
  })

  it('JSON output mode also reports the error cleanly', () => {
    const result = runCli(TMP, ['--update', 'main.calls.mul', '--reason', 'trying json mode direct callee update', '--json'])
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}`)

    const json = JSON.parse(result.stdout)
    assert.ok(json.error, 'JSON output should have an error field')
    assert.match(json.error, /Cannot update callee contract "main\.calls\.mul" directly/)
  })
})

// ─── #284 Bug C: --cluster filter catches callee regression ───────────────

describe('#284 Bug C: regret validate --cluster <parent> catches callee regression', () => {
  const originalApi = `
function add(a, b) { return a + b + 100 }
function mul(a, b) { return a * b }
function main(x) { return mod.add(x, 1) - 100 + mod.mul(x, 2) }
export { main, add, mul }
`
  // Note: originalApi above has a bug (mod is not defined in ESM). Let me use
  // a cleaner version that doesn't reference mod.

  const cleanOriginalApi = `
function add(a, b) { return a + b + 100 }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) - 100 + mul(x, 2) }
export { main, add, mul }
`
  const manifestClusters = [
    {
      id: 'main',
      entry: 'main',
      file: './api.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [5],
      watches: [],
      callees: ['add', 'mul'],
    },
  ]

  before(() => {
    setupProject(cleanOriginalApi, manifestClusters)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('callee add() changes but main output preserved — --cluster main catches the regression', () => {
    // Change add() from "+100" to "+200" and compensate in main() with "-200"
    // so main's output is preserved. main.calls.add's fingerprint WILL change.
    rewriteApi(`
function add(a, b) { return a + b + 200 }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) - 200 + mul(x, 2) }
export { main, add, mul }
`)

    const result = runCli(TMP, ['--cluster', 'main'])
    assert.equal(result.exitCode, 1, `expected exit 1 (callee regression detected), got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Parent main should PASS (output preserved)
    assert.match(result.stdout, /main.*PASS/, 'parent main should PASS (output preserved)')

    // Callee add should FAIL (behavior changed)
    assert.match(
      result.stdout,
      /main\.calls\.add.*FAIL \(callee\)/,
      'should report main.calls.add FAIL (callee regression)'
    )

    // Callee mul should PASS (unchanged)
    assert.match(result.stdout, /main\.calls\.mul.*PASS \(callee\)/, 'main.calls.mul should still PASS')

    // Summary should mention callee contract failed
    assert.match(
      result.stdout,
      /1 callee contract failed: main\.calls\.add/,
      `summary should report callee contract failed with id; got:\n${result.stdout}`
    )
  })

  it('--cluster <callee> directly still works (only that callee is checked)', () => {
    // Restore add() so we can verify --cluster on a specific callee works
    rewriteApi(cleanOriginalApi)
    // Re-capture to get fresh golden state
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `re-capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)

    const result = runCli(TMP, ['--cluster', 'main.calls.add'])
    // Exit 0 because nothing changed
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // main.regret should NOT be loaded (filtered out)
    // Only main.calls.add.regret should be processed
    assert.match(result.stdout, /Validating 1 cluster\(s\)/, 'should validate only 1 cluster')
  })
})

// ─── #288: missing callee .regret file detection ──────────────────────────

describe('#288: missing callee .regret file fails validate', () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`
  const manifestClusters = [
    {
      id: 'main',
      entry: 'main',
      file: './api.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [5],
      watches: [],
      callees: ['add', 'mul'],
    },
  ]

  before(() => {
    setupProject(originalApi, manifestClusters)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('deleting main.calls.add.regret → validate FAILs with clear message', () => {
    rmSync(join(TMP, 'regrets', 'main.calls.add.regret'))

    const result = runCli(TMP)
    assert.equal(result.exitCode, 1, `expected exit 1 (missing callee), got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Should report CALLEE CONTRACT MISSING for main
    assert.match(
      result.stdout,
      /main.*CALLEE CONTRACT MISSING/,
      'should report main CALLEE CONTRACT MISSING'
    )

    // Should list which file is missing
    assert.match(
      result.stdout,
      /Missing: main\.calls\.add\.regret/,
      'should list main.calls.add.regret as missing'
    )

    // Should suggest the fix command
    assert.match(
      result.stdout,
      /regret capture --cluster main/,
      'should suggest regret capture --cluster main as the fix'
    )

    // Summary line should report failure
    assert.match(result.stdout, /1\/1 FAILED/, 'summary should report 1/1 FAILED')
  })

  it('--skip-callees bypasses missing callee check — validate PASSES', () => {
    // main.calls.add.regret is still missing from the previous test
    // Verify that --skip-callees allows validate to pass (opt-out)
    const result = runCli(TMP, ['--skip-callees'])
    assert.equal(result.exitCode, 0, `expected exit 0 with --skip-callees, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Should NOT mention callee contract missing
    assert.doesNotMatch(
      result.stdout,
      /CALLEE CONTRACT MISSING/,
      'should NOT report CALLEE CONTRACT MISSING with --skip-callees'
    )

    // Should report all tests passed
    assert.match(result.stdout, /All 1 tests passed/, 'should report all tests passed with --skip-callees')
  })

  it('JSON output reports missing callee as a failure with descriptive error', () => {
    // Restore the .regret file first, then delete it again for a clean test
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `re-capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
    rmSync(join(TMP, 'regrets', 'main.calls.add.regret'))

    const result = runCli(TMP, ['--json'])
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}`)

    const json = JSON.parse(result.stdout)
    assert.equal(json.failed, 1, 'JSON failed count should be 1')

    const mainResult = json.clusters.find(c => c.id === 'main')
    assert.ok(mainResult, 'should have a main cluster result')
    // Status is 'fail' or 'error' depending on whether the result was tagged
    // with an error message — both indicate a failure.
    assert.ok(
      mainResult.status === 'fail' || mainResult.status === 'error',
      `main status should be 'fail' or 'error', got '${mainResult.status}'`
    )
    assert.match(mainResult.error, /callee contract missing for: main\.calls\.add\.regret/, 'error should mention missing callee contract')
  })

  it('multiple missing callees all listed in error', () => {
    // Re-capture to restore both callees, then delete both
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `re-capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
    rmSync(join(TMP, 'regrets', 'main.calls.add.regret'))
    rmSync(join(TMP, 'regrets', 'main.calls.mul.regret'))

    const result = runCli(TMP)
    assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Both missing callees should be listed
    assert.match(result.stdout, /main\.calls\.add\.regret/, 'should mention main.calls.add.regret')
    assert.match(result.stdout, /main\.calls\.mul\.regret/, 'should mention main.calls.mul.regret')
  })

  it('parent without callees declaration is unaffected (no FAIL for missing callees)', () => {
    // Re-capture, then remove callees from manifest
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `re-capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)

    rewriteManifest({
      clusters: [
        {
          id: 'main',
          entry: 'main',
          file: './api.mjs',
          stack: 'js',
          fingerprintLevel: 'entry',
          inputs: [5],
          watches: [],
          // No callees field
        },
      ],
    })

    const result = runCli(TMP)
    assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}`)
    assert.match(result.stdout, /All 1 tests passed/, 'should PASS — no callees declared, no missing-callee check')
  })
})

// ─── #288 interaction with #284: update parent with all callees missing ──

describe('#284 + #288 interaction: update parent with callees missing', () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`
  const manifestClusters = [
    {
      id: 'main',
      entry: 'main',
      file: './api.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [5],
      watches: [],
      callees: ['add', 'mul'],
    },
  ]

  before(() => {
    setupProject(originalApi, manifestClusters)
    const cap = runCapture(TMP)
    assert.equal(cap.exitCode, 0, `capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)
    // Delete both callee files to simulate "never captured" state
    rmSync(join(TMP, 'regrets', 'main.calls.add.regret'))
    rmSync(join(TMP, 'regrets', 'main.calls.mul.regret'))
  })

  after(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
  })

  it('update parent — warns about ALL missing callees, parent still updated', () => {
    // Mutate main
    rewriteApi(`
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) + 5 }
export { main, add, mul }
`)

    const result = runCli(TMP, ['--update', 'main', '--reason', 'main now adds 5 for tax rounding adjustment'])
    assert.equal(result.exitCode, 0, `expected exit 0 (update succeeds even with missing callees), got ${result.exitCode}\nstdout: ${result.stdout}`)

    // Parent should be updated
    assert.match(result.stdout, /main.*UPDATED/, 'main should be UPDATED')

    // Should warn about both missing callees
    assert.match(result.stdout, /main\.calls\.add.*missing — run `regret capture --cluster main` to generate/, 'should warn about main.calls.add missing')
    assert.match(result.stdout, /main\.calls\.mul.*missing — run `regret capture --cluster main` to generate/, 'should warn about main.calls.mul missing')

    // Summary should mention 2 missing callees
    assert.match(result.stdout, /2 callee contracts missing/, 'should mention 2 callee contracts missing')
  })

  it('next validate still FAILs (callees still missing) — until regret capture regenerates them', () => {
    const result = runCli(TMP)
    assert.equal(result.exitCode, 1, `expected exit 1 (callees still missing), got ${result.exitCode}\nstdout: ${result.stdout}`)
    assert.match(result.stdout, /CALLEE CONTRACT MISSING/, 'should report CALLEE CONTRACT MISSING')
  })

  it('regret capture regenerates missing callees — validate then PASSES', () => {
    const cap = runCapture(TMP, ['--cluster', 'main'])
    assert.equal(cap.exitCode, 0, `re-capture should exit 0\nstdout: ${cap.stdout}\nstderr: ${cap.stderr}`)

    // Both callee files should exist again
    assert.ok(existsSync(join(TMP, 'regrets', 'main.calls.add.regret')), 'main.calls.add.regret should exist after re-capture')
    assert.ok(existsSync(join(TMP, 'regrets', 'main.calls.mul.regret')), 'main.calls.mul.regret should exist after re-capture')

    const result = runCli(TMP)
    assert.equal(result.exitCode, 0, `expected exit 0 after re-capture, got ${result.exitCode}\nstdout: ${result.stdout}`)
    assert.match(result.stdout, /All 1 tests passed, 2 callee contracts verified/, 'should PASS with callees verified')
  })
})

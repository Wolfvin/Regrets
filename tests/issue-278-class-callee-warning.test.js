// tests/issue-278-class-callee-warning.test.js — Regression test for #278
//
// #278 — Class callee warning suggests nonsensical arrow-function refactor
//
// When a cluster declares `callees: ["Thing"]` and `Thing` is a class
// (not a function), `wrapCallees` in `scripts/ghost.js` previously emitted
// a warning suggesting the user refactor the class into an arrow function:
//
//     1. Refactor:  function Thing() { ... }  →  export const Thing = () => { ... }
//
// This suggestion is not actionable for classes — classes have `new`
// semantics, prototype chain, `instanceof`, etc. that arrow functions
// don't support. A user who follows the suggestion would end up with
// code that breaks at `new Thing(...)`.
//
// The fix (PR #428 + this PR's test lock-in) detects when the callee is a
// class via `original.toString()` and emits a class-specific warning:
//
//     ⚠️  Callee "Thing" is a class — ESM class declarations cannot be
//         intercepted for callee wrapping (cluster: main)
//         Classes cannot be refactored to arrow functions (they have `new`
//         semantics, prototype chain, instanceof, etc).
//         Options:
//           1. Wrap the class instantiation in a factory function:
//                function makeThing(x) { return new Thing(x) }
//              and declare `callees: ["makeThing"]` instead.
//           2. Convert the module to CommonJS:  module.exports.Thing = class { ... }
//              (CJS namespaces are mutable, so wrapCallees can install the proxy.)
//           3. Remove "Thing" from the `callees` array if you don't need a
//              callee contract for it — the parent cluster is still captured.
//         The callee is skipped; the parent cluster is still captured.
//
// This test verifies BOTH:
//   1. The nonsensical arrow-function suggestion is NOT emitted.
//   2. The class-specific warning IS emitted (lock in the UX improvement).
//
// Run: node --test tests/issue-278-class-callee-warning.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_JS = join(SCRIPTS_DIR, 'capture.js')

// Unique tmp dir per test file to avoid collisions with parallel test runs.
const TMP = resolve(join(process.cwd(), 'tests', `__issue_278_${process.pid}__`))

function setup() {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
}

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

function writeManifest(clusters) {
  writeFileSync(
    join(TMP, 'regrets', 'manifest.json'),
    JSON.stringify({ clusters }, null, 2)
  )
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

describe('#278 — class callee warning must not suggest nonsensical arrow-function refactor', () => {
  before(() => {
    setup()

    // Reproduce the exact fixture from issue #278:
    //   - `Thing` is a class (constructor + method)
    //   - `main` instantiates Thing and calls its method
    //   - Manifest declares `callees: ["Thing"]` — this is a misconfiguration
    //     (callees should be functions, not classes), but the warning emitted
    //     must guide the user correctly, not suggest an impossible refactor.
    writeFileSync(join(TMP, 'api.mjs'), `class Thing {
  constructor(x) { this.x = x }
  value() { return this.x }
}
function main(x) { return new Thing(x).value() }
export { main, Thing }
`)
    writeFileSync(join(TMP, 'package.json'), JSON.stringify({
      name: 'test-issue-278',
      version: '0.0.0',
      type: 'module',
    }))
    writeManifest([{
      id: 'main',
      entry: 'main',
      file: './api.mjs',
      stack: 'js',
      fingerprintLevel: 'entry',
      inputs: [5],
      watches: [],
      callees: ['Thing'],
    }])
  })

  after(() => {
    cleanup()
  })

  it('capture.js still succeeds (parent cluster captured, callee skipped)', () => {
    const result = runCaptureCli()
    assert.equal(
      result.exitCode, 0,
      `capture should exit 0 (parent still captured even if callee is a class)\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`
    )

    // Parent .regret must exist — the cluster is still captured.
    const regretFiles = readdirSync(join(TMP, 'regrets')).filter(f => f.endsWith('.regret'))
    assert.ok(
      regretFiles.includes('main.regret'),
      `parent .regret should be written; got: ${regretFiles.join(', ')}`
    )

    // Callee .regret must NOT exist — the class callee is skipped.
    assert.ok(
      !regretFiles.includes('main.calls.Thing.regret'),
      `callee .regret should NOT be written (class callees are skipped); got: ${regretFiles.join(', ')}`
    )
  })

  it('warning does NOT suggest refactoring class to arrow function', () => {
    const result = runCaptureCli()
    const combined = result.stdout + result.stderr

    // The OLD (buggy) warning text was:
    //   "Refactor:  function Thing() { ... }  →  export const Thing = () => { ... }"
    // This suggestion is nonsensical for classes — `new Thing(...)` would fail
    // on an arrow function ("Thing is not a constructor").
    const nonsensicalPatterns = [
      /export\s+const\s+Thing\s*=\s*\(\s*\)\s*=>/i,        // "export const Thing = () =>"
      /Refactor:.*function\s+Thing.*→.*export\s+const/i,    // "Refactor: function Thing() → export const Thing"
    ]
    for (const pattern of nonsensicalPatterns) {
      assert.ok(
        !pattern.test(combined),
        `warning must NOT suggest refactoring class Thing to arrow function; ` +
        `matched pattern ${pattern}; got: ${combined.slice(-600)}`
      )
    }
  })

  it('warning emits class-specific guidance (detects class, suggests factory function)', () => {
    const result = runCaptureCli()
    const combined = result.stdout + result.stderr

    // The fix (PR #428) detects that `original` is a class via
    // `original.toString().slice(0, 20)` matching `/^\s*class[\s{]/`.
    // When detected, it emits a class-specific warning instead of the
    // generic "refactor to a supported pattern" message.
    //
    // We assert the class-specific warning is present. This locks in the
    // UX improvement so a future refactor can't silently regress to the
    // old nonsensical suggestion.

    // 1. Warning must identify the callee as a class.
    assert.ok(
      /Callee\s+"Thing"\s+is\s+a\s+class/i.test(combined),
      `warning should identify callee "Thing" as a class; got: ${combined.slice(-800)}`
    )

    // 2. Warning must explain WHY classes can't be arrow functions.
    assert.ok(
      /new\s+semantics|prototype\s+chain|instanceof/i.test(combined),
      `warning should explain why classes can't be arrow functions (new semantics / prototype chain / instanceof); got: ${combined.slice(-800)}`
    )

    // 3. Warning must suggest a factory function workaround.
    assert.ok(
      /makeThing|factory\s+function/i.test(combined),
      `warning should suggest a factory function (makeThing); got: ${combined.slice(-800)}`
    )

    // 4. Warning must mention the callee name "Thing" so the user can identify it.
    assert.ok(
      combined.includes('Thing'),
      `warning should mention the callee name 'Thing'; got: ${combined.slice(-400)}`
    )
  })
})

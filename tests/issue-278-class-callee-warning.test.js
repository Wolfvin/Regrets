// tests/issue-278-class-callee-warning.test.js — Regression test for #278
//
// #278 — Class callee warning suggests nonsensical arrow-function refactor
//
// When a cluster declares `callees: ["Thing"]` and `Thing` is a class
// (not a function), `wrapCallees` previously emitted a warning suggesting
// the user refactor the class into an arrow function:
//
//     1. Refactor:  function Thing() { ... }  →  export const Thing = () => { ... }
//
// This suggestion is not actionable for classes — classes have `new`
// semantics, prototype chain, `instanceof`, etc. that arrow functions
// don't support. A user who follows the suggestion would end up with
// code that breaks at `new Thing(...)`.
//
// The current code (post-fix, see ghost.js:550-555) emits a generic
// warning instead:
//
//     1. Refactor to a supported pattern (see list above) and ensure the
//        callee name is not shadowed anywhere in the file.
//     2. For CJS: call the callee via `module.exports.<name>(...)` instead
//        of the bare name — this works without source transformation.
//
// This test verifies the nonsensical arrow-function suggestion is NOT
// emitted when a class is declared as a callee.
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
  })

  it('warning does NOT suggest refactoring class to arrow function', () => {
    const result = runCaptureCli()
    const combined = result.stdout + result.stderr

    // The OLD (buggy) warning text was:
    //   "Refactor:  function Thing() { ... }  →  export const Thing = () => { ... }"
    // This suggestion is nonsensical for classes — `new Thing(...)` would fail
    // on an arrow function ("Thing is not a constructor").
    //
    // The current code (post-fix) emits a generic warning instead. We assert
    // the specific nonsensical suggestion pattern is NOT present.
    const nonsensicalPatterns = [
      /export\s+const\s+Thing\s*=\s*\(\)\s*=>/i,        // "export const Thing = () =>"
      /function\s+Thing\s*\(\s*\)\s*\{\s*\.\.\.\s*\}/i,  // "function Thing() { ... }"
      /Refactor:.*function\s+Thing.*→.*export\s+const/i, // "Refactor: function Thing() → export const Thing"
    ]
    for (const pattern of nonsensicalPatterns) {
      assert.ok(
        !pattern.test(combined),
        `warning must NOT suggest refactoring class Thing to arrow function; ` +
        `matched pattern ${pattern}; got: ${combined.slice(-600)}`
      )
    }
  })

  it('warning mentions the callee name "Thing" so the user can identify it', () => {
    const result = runCaptureCli()
    const combined = result.stdout + result.stderr
    // The warning should at least mention "Thing" so the user knows which
    // callee is problematic. (Both the old and new warning do this — we
    // include this assertion to lock in the behavior.)
    assert.ok(
      combined.includes('Thing'),
      `warning should mention the callee name 'Thing'; got: ${combined.slice(-400)}`
    )
  })
})

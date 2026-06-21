// tests/issue-287-method-call-edge-filter.test.js
//
// Regression test for #287: analyzer.js false-positives method calls
// (.method()) as bare function calls when method name matches an exported
// function.
//
// Background: analyzeScope() emits edges for ALL calls — bare identifier
// calls AND method calls (e.g. `s.split('')` emits an edge from caller to
// `split`). When the method name coincides with an in-file exported function
// name (e.g. function `reverse` calls `arr.reverse()` — Array.prototype.reverse,
// NOT itself), the analyzer emits a self-referencing edge `reverse -> reverse`
// with `isMethod: true`.
//
// The bug #287 reports: this false-positive edge polluted the manifest's
// `callees` array, causing potential infinite recursion if callee wrapping
// were applied.
//
// The fix: install.js filters out method-call edges (isMethod: true) when
// building the `callees` field of a cluster manifest entry. The analyzer
// itself still emits the noisy edge (by design — see
// tests/analyzer-method-calls.test.js), but the manifest stays clean.
//
// This test verifies the manifest-level fix: when a function calls a method
// whose name matches an exported function (including itself), the manifest's
// `callees` array must NOT include the method-call target.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')

const TMP = resolve(join(process.cwd(), 'tests', `__issue287_${process.pid}__`))

function setupFixture() {
  // Reproduce the exact scenario from #287:
  // function reverse(s) calls `split(s.split('')).reverse()` — `.reverse()`
  // is Array.prototype.reverse (a method), NOT a recursive call to the
  // local `reverse` function.
  mkdirSync(join(TMP, 'src'), { recursive: true })
  writeFileSync(join(TMP, 'package.json'), JSON.stringify({
    name: 'issue-287-fixture', version: '1.0.0', type: 'module',
  }))
  writeFileSync(join(TMP, 'src', 'arr.mjs'), `
export function split(arr) { return arr.slice() }
export function join(arr) { return arr.join('') }
// reverse calls .reverse() on the array — Array.prototype.reverse, NOT itself
export function reverse(s) {
  return join(split(s.split('')).reverse())
}
`)
}

function cleanup() {
  rmSync(TMP, { recursive: true, force: true })
}

describe('#287 — install.js filters method-call edges from manifest callees', () => {
  before(() => {
    cleanup()
    setupFixture()
  })
  after(cleanup)

  it('manifest callees for `reverse` cluster do NOT include `reverse` itself', () => {
    // Run regret install --scope src/ --skip-build --skip-capture
    const result = spawnSync('node', [
      INSTALL_JS, '--scope', 'src/', '--skip-build', '--skip-capture',
    ], {
      cwd: TMP,
      encoding: 'utf8',
    })

    assert.equal(result.status, 0, `install.js should exit 0; got stderr:\n${result.stderr}`)

    const manifestPath = join(TMP, 'src', 'regrets', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

    const reverseCluster = manifest.clusters.find(c => c.entry === 'reverse')
    assert.ok(reverseCluster, 'manifest should have a cluster with entry=reverse')

    // The bug #287 reported: callees: ['reverse'] polluted the manifest.
    // After fix: callees should include 'join' and 'split' (bare calls), but
    // NOT 'reverse' (the self-referencing method call from .reverse()).
    assert.ok(reverseCluster.callees,
      'reverse cluster should have a callees array (bare calls were detected)')
    assert.ok(!reverseCluster.callees.includes('reverse'),
      `callees must NOT include 'reverse' (would cause infinite recursion if callee wrapping applied). Got: ${JSON.stringify(reverseCluster.callees)}`)
    assert.ok(reverseCluster.callees.includes('join'),
      `callees should include 'join' (bare function call). Got: ${JSON.stringify(reverseCluster.callees)}`)
    assert.ok(reverseCluster.callees.includes('split'),
      `callees should include 'split' (bare function call). Got: ${JSON.stringify(reverseCluster.callees)}`)
  })

  it('manifest callees for `split` cluster (no method calls) are clean', () => {
    const manifestPath = join(TMP, 'src', 'regrets', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

    const splitCluster = manifest.clusters.find(c => c.entry === 'split')
    assert.ok(splitCluster, 'manifest should have a cluster with entry=split')

    // split calls arr.slice() — slice is a method on the arr argument,
    // not a bare function call. callees should be empty (or absent).
    const callees = splitCluster.callees || []
    assert.ok(!callees.includes('slice'),
      `callees for split must NOT include 'slice' (it is arr.slice() — a method call). Got: ${JSON.stringify(callees)}`)
  })
})

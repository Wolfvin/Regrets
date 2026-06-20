// tests/discover-watches-noise-321.test.js — Tests for issue #321
//
// Bug: `regret discover --entry isEmail --file validator.js` filled the
// `watches` array with ALL 98 exported functions from the module — not just
// the ones actually called during trace. Result: 98 entries all "not called
// during trace", signal-to-noise 0/98.
//
// Fix: watches array ONLY contains functions actually invoked during the
// trace. If no callees were traced (self-contained fn), watches stays empty
// and a clear Indonesian message is printed — NO fallback to all exports.
//
// Run: node --test tests/discover-watches-noise-321.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs'
import { resolve, join } from 'node:path'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const DISCOVER_JS = join(SCRIPTS_DIR, 'discover.js')

const TMP = resolve(join(process.cwd(), 'tests', `__discover_321_${process.pid}__`))

/**
 * Build a fixture module with N exported functions, where the entry calls
 * only a named subset via `this.<fn>()` (so the tracing proxy can intercept).
 * The remaining functions are exported but never called.
 */
function buildFixture(totalCount, calledNames) {
  const lines = []
  for (let i = 0; i < totalCount; i++) {
    const name = `fn${i}`
    lines.push(`export function ${name}(x) { return '${name}:' + String(x) }`)
  }
  // Entry calls only `calledNames` via this.fn() so the proxy intercepts.
  const calls = calledNames.map(n => `this.${n}(x)`).join(', ')
  lines.push(`export function entry(x) { return [${calls}].join('|') }`)
  return lines.join('\n') + '\n'
}

/**
 * Build a self-contained fixture where entry makes NO traceable calls.
 * Entry calls an internal (non-exported) helper directly — bypassing the
 * proxy by design — to simulate the validator.js scenario from #321 where
 * the module is one large self-contained function.
 */
function buildSelfContainedFixture(totalCount) {
  const lines = []
  // Internal helper — NOT exported, called directly (proxy can't see this).
  lines.push(`function internalHelper(x) { return 'internal:' + String(x) }`)
  for (let i = 0; i < totalCount; i++) {
    const name = `fn${i}`
    lines.push(`export function ${name}(x) { return '${name}:' + String(x) }`)
  }
  // Entry calls only the internal helper — no trackable exported callees.
  lines.push(`export function entry(x) { return internalHelper(x) }`)
  return lines.join('\n') + '\n'
}

function setupDir() {
  mkdirSync(TMP, { recursive: true })
}

function cleanupDir() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
}

/**
 * Run discover.js with given args and return { exitCode, stdout, stderr }.
 */
function runDiscover(args) {
  const result = spawnSync('node', [DISCOVER_JS, ...args], {
    cwd: TMP,
    stdio: 'pipe',
    timeout: 30_000,
  })
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ? result.stdout.toString() : '',
    stderr: result.stderr ? result.stderr.toString() : '',
  }
}

/**
 * Extract the JSON manifest printed to stdout. discover.js prints the manifest
 * as a pretty-printed JSON object on its own (between blank lines, before the
 * "Next steps" footer). We locate the top-level object by finding a line that
 * is exactly "{" and walking forward to its matching closing line "}".
 */
function extractManifest(stdout) {
  const lines = stdout.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '{') {
      start = i
      break
    }
  }
  assert.ok(start !== -1, 'manifest JSON opening line not found in stdout')
  // Find the matching closing line "}" (walk forward, balance braces).
  let depth = 0
  let end = -1
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end !== -1) break
  }
  assert.ok(end !== -1, 'manifest JSON closing line not found in stdout')
  const jsonStr = lines.slice(start, end + 1).join('\n')
  return JSON.parse(jsonStr)
}

describe('#321 — discover watches array noise', () => {
  before(() => setupDir())
  after(() => cleanupDir())

  it('watches contains ONLY functions actually called (2 of 100), not all 100 exports', () => {
    // 100 exported functions + entry; entry calls only fn7 and fn42
    const fixture = buildFixture(100, ['fn7', 'fn42'])
    writeFileSync(join(TMP, 'bigmod.js'), fixture)

    const result = runDiscover(['--entry', 'entry', '--file', 'bigmod.js', '--inputs', '["hello"]'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifest = extractManifest(result.stdout)
    assert.ok(manifest.clusters && manifest.clusters.length === 1, 'manifest must have 1 cluster')
    const cluster = manifest.clusters[0]
    assert.equal(cluster.entry, 'entry')
    assert.ok(Array.isArray(cluster.watches), 'watches must be an array')

    // THE BUG: previously this would be 100 (all exports). Fix: only 2.
    assert.equal(cluster.watches.length, 2,
      `Expected watches to contain exactly 2 functions (the ones called), got ${cluster.watches.length}: ${JSON.stringify(cluster.watches)}`)

    // Both must be the called functions, in any order
    assert.ok(cluster.watches.includes('fn7'), 'watches must include fn7 (called)')
    assert.ok(cluster.watches.includes('fn42'), 'watches must include fn42 (called)')

    // Spot-check: a few uncalled exports must NOT be in watches
    assert.ok(!cluster.watches.includes('fn0'), 'fn0 was not called — must NOT be in watches')
    assert.ok(!cluster.watches.includes('fn1'), 'fn1 was not called — must NOT be in watches')
    assert.ok(!cluster.watches.includes('fn99'), 'fn99 was not called — must NOT be in watches')

    // Human-readable output should surface uncalled exports separately,
    // NOT advertise them as watches.
    assert.ok(result.stdout.includes('NOT called during trace'),
      'stdout should list uncalled exports in a separate "not called" section')
  })

  it('watches is empty for a self-contained function — clear message printed, NO fallback to all exports', () => {
    // 50 exported functions but entry calls only an internal helper (untraceable)
    const fixture = buildSelfContainedFixture(50)
    writeFileSync(join(TMP, 'selfish.js'), fixture)

    const result = runDiscover(['--entry', 'entry', '--file', 'selfish.js', '--inputs', '["hello"]'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifest = extractManifest(result.stdout)
    assert.ok(manifest.clusters && manifest.clusters.length === 1, 'manifest must have 1 cluster')
    const cluster = manifest.clusters[0]
    assert.equal(cluster.entry, 'entry')
    assert.ok(Array.isArray(cluster.watches), 'watches must be an array')

    // The critical assertion: watches is EMPTY — not filled with 50 exports
    assert.equal(cluster.watches.length, 0,
      `Expected watches to be empty (no callees traced), got ${cluster.watches.length}: ${JSON.stringify(cluster.watches)}`)

    // The clear message MUST be present (issue #321 spec)
    assert.ok(
      result.stdout.includes('Tidak ada call lain yang terdeteksi selama trace'),
      `stdout must include the self-contained message.\nGot stdout:\n${result.stdout}`
    )
    assert.ok(
      result.stdout.includes('watches kosong'),
      `stdout must mention 'watches kosong'.\nGot stdout:\n${result.stdout}`
    )
  })

  it('watches lists called functions in call-count order when counts differ', () => {
    // Build a module where entry calls fnA twice and fnB once
    const fixture = `
export function fnA(x) { return 'a:' + String(x) }
export function fnB(x) { return 'b:' + String(x) }
export function fnC(x) { return 'c:' + String(x) }
export function fnD(x) { return 'd:' + String(x) }
export function entry(x) {
  // fnA called 2x, fnB 1x, fnC and fnD never
  const a1 = this.fnA(x)
  const a2 = this.fnA(x + '!')
  const b1 = this.fnB(x)
  return [a1, a2, b1].join('|')
}
`
    writeFileSync(join(TMP, 'counts.js'), fixture)

    const result = runDiscover(['--entry', 'entry', '--file', 'counts.js', '--inputs', '["x"]'])
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`)

    const manifest = extractManifest(result.stdout)
    const cluster = manifest.clusters[0]
    assert.equal(cluster.watches.length, 2, 'watches should contain fnA and fnB only')
    assert.ok(cluster.watches.includes('fnA'), 'fnA must be in watches')
    assert.ok(cluster.watches.includes('fnB'), 'fnB must be in watches')
    assert.ok(!cluster.watches.includes('fnC'), 'fnC was not called — must NOT be in watches')
    assert.ok(!cluster.watches.includes('fnD'), 'fnD was not called — must NOT be in watches')
  })
})

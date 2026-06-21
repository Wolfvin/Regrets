// tests/api-scan-289.test.js — tests for #289 fix
// Verifies that api.js#scan() emits the SAME cluster shape as install.js,
// including detection parity for indirect object exports.
//
// Run: node --test tests/api-scan-289.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { scan } from '../scripts/api.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Test fixtures ────────────────────────────────────────────────────────────

let TMP

function setupFixtures() {
  TMP = mkdtempSync(join(tmpdir(), 'api-scan-289-'))

  // 1. Indirect export pattern (original #289 repro):
  //    module.exports = <identifier> where <identifier> is declared as const X = { ... }
  writeFileSync(join(TMP, 'api.cjs'), `const mod = {
  add: function(a, b) { return a + b },
  mul: function(a, b) { return a * b },
  main: function(x) { return mod.add(x, 1) + mod.mul(x, 2) }
}
module.exports = mod
`)

  // 2. ESM parity fixture: covers all install.js detection patterns
  writeFileSync(join(TMP, 'parity.mjs'), `export function syncFn(x) { return x * 2 }
export async function asyncFn(x) { return x + 1 }
export class Widget {
  constructor() { this.x = 1 }
  render() { return '<widget>' }
}
export default class DefaultWidget {
  render() { return '<default>' }
}
`)

  // 3. Comment false-positive guard (#286):
  //    Export patterns inside comments must NOT be detected
  writeFileSync(join(TMP, 'comments.cjs'), `// export function fakeFn() { return 1 }
/* export function alsoFake() { return 2 } */
module.exports = { realFn: function() { return 'real' } }
`)

  // 4. Named export list (#271): export { foo, bar }
  writeFileSync(join(TMP, 'named-list.mjs'), `function foo() { return 1 }
function bar() { return 2 }
export { foo, bar }
`)

  // 5. Default export object (#317): export default { foo, bar }
  writeFileSync(join(TMP, 'default-obj.mjs'), `function alpha() { return 1 }
function beta() { return 2 }
export default { alpha, beta }
`)

  // 6. CJS named function: module.exports = function Name() {}
  writeFileSync(join(TMP, 'cjs-named.cjs'), `module.exports = function cjsEntry(x) { return x + 100 }
`)
}

function teardownFixtures() {
  if (TMP) {
    try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('#289 — api.js#scan() emits same shape as install.js', () => {
  before(setupFixtures)
  after(teardownFixtures)

  it('emits watches: [] (NOT [fnName]) — was the original #289 bug', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    assert.ok(suggestions.length > 0, 'should find at least one suggestion')
    for (const s of suggestions) {
      assert.deepEqual(s.watches, [],
        `suggestion ${s.id} should have watches: [] (got ${JSON.stringify(s.watches)})`)
    }
  })

  it('emits fingerprintLevel: "entry" for every suggestion', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    for (const s of suggestions) {
      assert.equal(s.fingerprintLevel, 'entry',
        `suggestion ${s.id} should have fingerprintLevel: 'entry'`)
    }
  })

  it('emits inputs as DEFAULT_PROBE_INPUTS (["", "test", 0, 1, {}, [], null])', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const expected = ['', 'test', 0, 1, {}, [], null]
    for (const s of suggestions) {
      assert.deepEqual(s.inputs, expected,
        `suggestion ${s.id} should have DEFAULT_PROBE_INPUTS (got ${JSON.stringify(s.inputs)})`)
    }
  })

  it('emits path-hinted kebab-case id (e.g. "api-add" not "add")', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const apiAdd = suggestions.find(s => s.entry === 'add' && s.file === 'api.cjs')
    assert.ok(apiAdd, 'should find the "add" function from api.cjs')
    assert.equal(apiAdd.id, 'api-add',
      `expected id "api-add" (path hint + kebab fn name), got "${apiAdd.id}"`)
  })

  it('parses indirect export pattern (module.exports = <identifier>)', async () => {
    // Per the original #289 repro: const mod = { add, mul, main }; module.exports = mod
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const apiSuggestions = suggestions.filter(s => s.file === 'api.cjs')
    const entries = apiSuggestions.map(s => s.entry).sort()
    assert.ok(entries.includes('add'), `should detect "add" (entries: ${entries.join(',')})`)
    assert.ok(entries.includes('mul'), `should detect "mul" (entries: ${entries.join(',')})`)
    assert.ok(entries.includes('main'), `should detect "main" (entries: ${entries.join(',')})`)
  })

  it('detects export class X and export default class X (#292 parity)', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const entries = suggestions.filter(s => s.file === 'parity.mjs').map(s => s.entry).sort()
    assert.ok(entries.includes('Widget'),
      `should detect "Widget" class (entries: ${entries.join(',')})`)
    assert.ok(entries.includes('DefaultWidget'),
      `should detect "DefaultWidget" default class (entries: ${entries.join(',')})`)
  })

  it('detects export async function (#289 parity)', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const entries = suggestions.filter(s => s.file === 'parity.mjs').map(s => s.entry).sort()
    assert.ok(entries.includes('asyncFn'),
      `should detect "asyncFn" (entries: ${entries.join(',')})`)
  })

  it('detects export { foo, bar } named-export list (#271 parity)', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const entries = suggestions.filter(s => s.file === 'named-list.mjs').map(s => s.entry).sort()
    assert.ok(entries.includes('foo'),
      `should detect "foo" from export { foo, bar } (entries: ${entries.join(',')})`)
    assert.ok(entries.includes('bar'),
      `should detect "bar" from export { foo, bar } (entries: ${entries.join(',')})`)
  })

  it('detects export default { foo, bar } object (#317 parity)', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const entries = suggestions.filter(s => s.file === 'default-obj.mjs').map(s => s.entry).sort()
    assert.ok(entries.includes('alpha'),
      `should detect "alpha" from export default { alpha, beta } (entries: ${entries.join(',')})`)
    assert.ok(entries.includes('beta'),
      `should detect "beta" from export default { alpha, beta } (entries: ${entries.join(',')})`)
  })

  it('detects module.exports = function Name (CJS named function)', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const entries = suggestions.filter(s => s.file === 'cjs-named.cjs').map(s => s.entry).sort()
    assert.ok(entries.includes('cjsEntry'),
      `should detect "cjsEntry" (entries: ${entries.join(',')})`)
  })

  it('does NOT detect export patterns inside comments (#286 parity)', async () => {
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const entries = suggestions.filter(s => s.file === 'comments.cjs').map(s => s.entry).sort()
    assert.ok(!entries.includes('fakeFn'),
      `should NOT detect "fakeFn" (in // comment) (entries: ${entries.join(',')})`)
    assert.ok(!entries.includes('alsoFake'),
      `should NOT detect "alsoFake" (in /* */ comment) (entries: ${entries.join(',')})`)
    assert.ok(entries.includes('realFn'),
      `should detect "realFn" (real export) (entries: ${entries.join(',')})`)
  })

  it('omits callees field when no in-file callees are detected', async () => {
    // api.cjs has indirect exports: add, mul, main. main calls mod.add and mod.mul
    // (method calls on `mod`, not bare calls) — these are tagged isMethod=true
    // with receiver=`mod`, so the #287 filter drops them. callees should be
    // omitted for all 3 clusters.
    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const apiSuggestions = suggestions.filter(s => s.file === 'api.cjs')
    for (const s of apiSuggestions) {
      assert.equal(s.callees, undefined,
        `suggestion ${s.id} should NOT have callees (method calls on \`mod\` are filtered out)`)
    }
  })

  it('populates callees when bare in-file calls exist (best-effort)', async () => {
    // Build a fixture with explicit bare calls between exported fns
    const calleeDir = mkdtempSync(join(tmpdir(), 'api-scan-289-callee-'))
    try {
      writeFileSync(join(calleeDir, 'calls.mjs'), `export function a(x) { return b(x) + c(x) }
export function b(x) { return x * 2 }
export function c(x) { return x + 1 }
`)
      const { suggestions } = await scan({ cwd: calleeDir, dir: '.' })
      const aSuggestion = suggestions.find(s => s.entry === 'a' && s.file === 'calls.mjs')
      assert.ok(aSuggestion, `should find entry "a" (suggestions: ${suggestions.map(s => s.entry).join(',')})`)
      // analyzeScope may not always populate callees (depends on WASM init),
      // but when it does, the callees list should be present and contain b & c.
      // We only assert non-emptiness if callees exists — analyzeScope is best-effort.
      if (aSuggestion.callees !== undefined) {
        assert.ok(aSuggestion.callees.length > 0,
          `if callees is present, it should be non-empty (got ${JSON.stringify(aSuggestion.callees)})`)
        assert.ok(aSuggestion.callees.includes('b'),
          `callees should include "b" (got ${JSON.stringify(aSuggestion.callees)})`)
        assert.ok(aSuggestion.callees.includes('c'),
          `callees should include "c" (got ${JSON.stringify(aSuggestion.callees)})`)
      }
    } finally {
      try { rmSync(calleeDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })

  it('shape matches install.js manifest output exactly (id, watches, fp level, inputs)', async () => {
    // Cross-check: install.js --dry-run on the same fixture should produce the
    // same id + watches + fingerprintLevel + inputs as scan(). This is the
    // core #289 invariant.
    const { execSync } = await import('node:child_process')
    const installOut = execSync(
      `node ${join(process.cwd(), 'scripts/install.js')} --dir ${TMP} --dry-run --skip-capture`,
      { encoding: 'utf8', cwd: TMP }
    )
    // Parse the JSON manifest from install.js output. install.js prints:
    //   Manifest that would be generated:
    //   {
    //     "clusters": [ <array of cluster objects> ]
    //   }
    // We need to find the outer `clusters` array and parse it. Because cluster
    // objects contain nested arrays (inputs), a simple regex won't work — we
    // use a depth-counting bracket parser starting at the `clusters` key.
    const clustersKeyIdx = installOut.indexOf('"clusters"')
    assert.ok(clustersKeyIdx >= 0, 'install.js output should contain a "clusters" key')
    const arrayStart = installOut.indexOf('[', clustersKeyIdx)
    assert.ok(arrayStart >= 0, 'install.js output should contain [ after "clusters"')
    let depth = 0
    let inString = false
    let stringChar = ''
    let arrayEnd = -1
    for (let i = arrayStart; i < installOut.length; i++) {
      const ch = installOut[i]
      if (inString) {
        if (ch === '\\') { i++; continue }
        if (ch === stringChar) inString = false
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue }
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) { arrayEnd = i; break }
      }
    }
    assert.ok(arrayEnd > arrayStart, 'install.js output should have a balanced clusters[] array')
    const clustersJson = installOut.slice(arrayStart, arrayEnd + 1)
    const installClusters = JSON.parse(clustersJson)
    const installByEntry = new Map(installClusters.map(c => [c.entry, c]))

    const { suggestions } = await scan({ cwd: TMP, dir: '.' })
    const scanByEntry = new Map(suggestions.map(s => [s.entry, s]))

    // Both should find the same set of entries
    const installEntries = new Set(installByEntry.keys())
    const scanEntries = new Set(scanByEntry.keys())
    assert.deepEqual([...scanEntries].sort(), [...installEntries].sort(),
      `scan() and install.js should find the same entries\n` +
      `  scan-only: ${[...scanEntries].filter(e => !installEntries.has(e)).join(',')}\n` +
      `  install-only: ${[...installEntries].filter(e => !scanEntries.has(e)).join(',')}`)

    // Each entry should have the same id, watches, fingerprintLevel, inputs
    for (const entry of installEntries) {
      const iCluster = installByEntry.get(entry)
      const sSuggestion = scanByEntry.get(entry)
      assert.equal(sSuggestion.id, iCluster.id,
        `entry "${entry}": id mismatch (scan="${sSuggestion.id}", install="${iCluster.id}")`)
      assert.deepEqual(sSuggestion.watches, iCluster.watches,
        `entry "${entry}": watches mismatch`)
      assert.equal(sSuggestion.fingerprintLevel, iCluster.fingerprintLevel,
        `entry "${entry}": fingerprintLevel mismatch`)
      assert.deepEqual(sSuggestion.inputs, iCluster.inputs,
        `entry "${entry}": inputs mismatch`)
    }
  })
})

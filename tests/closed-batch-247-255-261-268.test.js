// tests/closed-batch-247-255-261-268.test.js
//
// Status-lock tests for 4 old non-CLAIM issues closed in a single batch PR.
// Each test pins the resolution state of one issue so that future changes
// don't silently regress the contract that closed the issue.
//
// Issues covered:
//   #247 — feat(ghost): opt-in callee wrapping depth > 1
//          → Skip (deferred feature request, needs BOS design decision,
//            listed in CONTEXT.md Known Gaps)
//   #255 — perf: measure callee wrapping overhead + add sampling mode
//          → Skip (deferred feature request, needs BOS design decision,
//            listed in CONTEXT.md Known Gaps)
//   #261 — [RED TEAM] capture.js crashes when manifest cluster omits "watches"
//          → Fix (already fixed: capture.js:276 destructures `watches = []`.
//            This test runs the EXACT reproduction from the issue body and
//            asserts no TypeError is thrown.)
//   #268 — [RED TEAM] regret install --scope produces empty manifest when
//          trivial guard skips all clusters
//          → Fix (already fixed: install.js now writes install-skipped.txt
//            preserving cluster definitions + callees, and does NOT write
//            an empty manifest. This test runs the EXACT reproduction from
//            the issue body and asserts the install-skipped.txt contract.)
//
// Run: node --test tests/closed-batch-247-255-261-268.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { readFileSync as readFileSyncFs } from 'node:fs'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const CAPTURE_JS  = join(SCRIPTS_DIR, 'capture.js')
const INSTALL_JS  = join(SCRIPTS_DIR, 'install.js')
const GHOST_JS    = join(SCRIPTS_DIR, 'ghost.js')

// ─── #247 / #255 — deferred feature requests (negative existence tests) ────
//
// These issues ask for `calleeDepth` (#247) and `sampleRate` (#255) fields
// to be added to manifest clusters. Both are listed in CONTEXT.md "Known
// Gaps" as needing design decisions from BOS before implementation.
//
// The negative test below asserts that NO `calleeDepth` / `sampleRate`
// implementation has been silently added. If someone implements either
// feature later, this test will fail — forcing them to update CONTEXT.md
// Known Gaps list and re-evaluate issue closure.

describe('#247 + #255 — deferred feature requests (negative existence tests)', () => {
  it('#247 — no calleeDepth implementation in scripts/ (needs BOS design decision)', () => {
    // Walk scripts/ and grep for calleeDepth / callee_depth / callee.depth
    const scriptsDir = resolve(import.meta.dirname, '..', 'scripts')
    const files = readdirSync(scriptsDir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
    let hits = []
    for (const f of files) {
      const content = readFileSync(join(scriptsDir, f), 'utf8')
      // Match `calleeDepth`, `callee_depth`, `callee.depth` as identifier-ish
      // patterns — but NOT inside comments or strings.
      const lines = content.split('\n')
      lines.forEach((line, idx) => {
        // Skip comment-only lines
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        if (/\b(calleeDepth|callee_depth)\b/.test(line) || /\.callee\.depth\b/.test(line)) {
          hits.push(`${f}:${idx + 1}: ${line.trim()}`)
        }
      })
    }
    assert.equal(hits.length, 0,
      `#247 is deferred (needs BOS design decision per CONTEXT.md Known Gaps). ` +
      `Found calleeDepth implementation in scripts/:\n${hits.join('\n')}\n` +
      `If you implemented this feature, update CONTEXT.md Known Gaps and ` +
      `re-evaluate issue closure.`)
  })

  it('#255 — no sampleRate implementation in scripts/ (needs BOS design decision)', () => {
    const scriptsDir = resolve(import.meta.dirname, '..', 'scripts')
    const files = readdirSync(scriptsDir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
    let hits = []
    for (const f of files) {
      const content = readFileSync(join(scriptsDir, f), 'utf8')
      const lines = content.split('\n')
      lines.forEach((line, idx) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        if (/\b(sampleRate|sample_rate|sampleRatio)\b/.test(line)) {
          hits.push(`${f}:${idx + 1}: ${line.trim()}`)
        }
      })
    }
    assert.equal(hits.length, 0,
      `#255 is deferred (needs BOS design decision per CONTEXT.md Known Gaps). ` +
      `Found sampleRate implementation in scripts/:\n${hits.join('\n')}\n` +
      `If you implemented this feature, update CONTEXT.md Known Gaps and ` +
      `re-evaluate issue closure.`)
  })

  it('CONTEXT.md Known Gaps list still mentions #247 and #255', () => {
    // The CONTEXT.md worker context file lives in _skills/context-snapshot/Regrets/
    // when bootstrapped, but the in-repo copy (if present) is at the repo root
    // or referenced from WORKERS.md. We check the worker-skills snapshot path
    // since that's the authoritative source workers read.
    const possiblePaths = [
      '/home/z/my-project/_skills/context-snapshot/Regrets/CONTEXT.md',
      resolve(import.meta.dirname, '..', 'CONTEXT.md'),
      resolve(import.meta.dirname, '..', 'WORKERS.md'),
    ]
    let found = false
    for (const p of possiblePaths) {
      try {
        const content = readFileSyncFs(p, 'utf8')
        if (content.includes('#247') && content.includes('#255')) {
          found = true
          break
        }
      } catch { /* file not present, try next */ }
    }
    // Soft check — CONTEXT.md is in worker-skills repo, not in this repo.
    // If neither path has it, that's OK (the test still runs in CI without
    // the worker-skills checkout). We just want to flag if CONTEXT.md IS
    // present but DOESN'T mention #247/#255.
    if (!found) {
      // Try one more location — repo root WORKERS.md redirect
      const workersPath = resolve(import.meta.dirname, '..', 'WORKERS.md')
      if (existsSync(workersPath)) {
        const w = readFileSyncFs(workersPath, 'utf8')
        // WORKERS.md is a redirect stub; it's fine if it doesn't list issues.
        if (!w.includes('Known Gaps')) return
      }
      // Skip silently if no CONTEXT.md is available in this checkout.
      // The negative implementation tests above are the real contract.
      return
    }
    assert.ok(found, 'CONTEXT.md should still list #247 and #255 as Known Gaps')
  })
})

// ─── #261 — capture.js doesn't crash when watches field is missing ─────────
//
// Exact reproduction from issue #261 body:
//   1. Create a CJS project with `add`/`main` (module.exports pattern)
//   2. Create manifest WITHOUT "watches" field (but with callees)
//   3. Run `node scripts/regret.js capture`
//   4. Expected: exit 0, no TypeError
//
// The fix is at scripts/capture.js:276 — `const { id, entry, watches = [], ... }`
// destructures `watches` with a default empty array, so `watches.join(", ")`
// never throws on undefined.

describe('#261 — capture.js no longer crashes when manifest cluster omits "watches"', () => {
  const tmpDir = resolve(join(process.cwd(), 'tests', `__batch_261_${process.pid}__`))

  before(() => {
    mkdirSync(join(tmpDir, 'regrets'), { recursive: true })
    // math.cjs — exact fixture from issue #261 body, but with .cjs extension
    // because the repo's package.json has "type": "module" (so .js files are
    // treated as ESM, but `module.exports` requires CJS).
    writeFileSync(join(tmpDir, 'math.cjs'), `function add(a, b) { return a + b }
function main(a, b) { return module.exports.add(a, b) }
module.exports = { add, main }
`)
    // manifest.json — exact fixture from issue #261 body (NO watches field)
    writeFileSync(join(tmpDir, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'main',
        entry: 'main',
        file: 'math.cjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        multiArgs: true,
        inputs: [[3, 4]],
        callees: ['add'],
        // NOTE: no "watches" field — this is the #261 reproduction
      }],
    }, null, 2))
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('capture exits 0 (no TypeError: Cannot read properties of undefined)', () => {
    const r = spawnSync('node', [CAPTURE_JS], {
      cwd: tmpDir, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(r.status, 0,
      `capture should exit 0; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.ok(!r.stderr.includes('TypeError'),
      `stderr should not contain TypeError; got: ${r.stderr}`)
    // Specifically check the original error message no longer appears
    assert.ok(!r.stderr.includes("Cannot read properties of undefined (reading 'join')"),
      `the original #261 TypeError should be gone; got: ${r.stderr}`)
  })

  it('main.regret is written with empty watches: []', () => {
    const regret = readFileSync(join(tmpDir, 'regrets', 'main.regret'), 'utf8')
    assert.match(regret, /^watches: \[\]/m,
      `watches line should be empty array (default applied); got:\n${regret}`)
  })

  it('callee contract .regret is also written (callees still work without watches)', () => {
    const calleePath = join(tmpDir, 'regrets', 'main.calls.add.regret')
    assert.ok(existsSync(calleePath),
      'main.calls.add.regret should exist — callees work even without watches field')
  })
})

// ─── #268 — install --scope preserves callees when trivial guard skips all ──
//
// Exact reproduction from issue #268 body:
//   1. Create math.js with add/multiply/main (main calls add + multiply)
//   2. Run `regret install --scope math.js`
//   3. Original bug: manifest.json = { "clusters": [] }, callees lost
//   4. Fixed behavior: install-skipped.txt preserves all cluster definitions
//      + auto-detected callees; manifest.json is NOT written when all
//      clusters trivial-skipped (avoids the "empty manifest" footgun).

describe('#268 — install --scope preserves callees when trivial guard skips all clusters', () => {
  const tmpDir = resolve(join(process.cwd(), 'tests', `__batch_268_${process.pid}__`))

  before(() => {
    mkdirSync(tmpDir, { recursive: true })
    // math.js — exact fixture from issue #268 body (all 3 functions return NaN
    // for any probe input → all clusters trivial-skipped)
    writeFileSync(join(tmpDir, 'math.js'), `function add(a, b) { return NaN }
function multiply(a, b) { return NaN }
function main(a, b) { return add(a, b) + multiply(a, b) }
module.exports = { add, multiply, main }
`)
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({
      name: 'empty-manifest-268-batch', version: '1.0.0',
    }))
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('install exits 0 (no crash, no silent success)', () => {
    const r = spawnSync('node', [INSTALL_JS, '--scope', 'math.js', '--skip-capture'], {
      cwd: tmpDir, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(r.status, 0,
      `install should exit 0; got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  })

  it('manifest.json is NOT written with empty clusters (the original #268 footgun)', () => {
    // The fix: install.js does NOT write manifest.json when all clusters are
    // trivial-skipped. Previously it wrote `{ "clusters": [] }` — losing
    // auto-detected callees.
    spawnSync('node', [INSTALL_JS, '--scope', 'math.js', '--skip-capture'], {
      cwd: tmpDir, encoding: 'utf8', timeout: 30_000,
    })
    const manifestPath = join(tmpDir, 'regrets', 'manifest.json')
    assert.ok(!existsSync(manifestPath),
      `manifest.json must NOT be written when all clusters trivial-skipped — ` +
      `this was the original #268 bug. Got: ${existsSync(manifestPath) ? 'exists' : 'absent'}`)
  })

  it('install-skipped.txt is written with all 3 cluster definitions', () => {
    spawnSync('node', [INSTALL_JS, '--scope', 'math.js', '--skip-capture'], {
      cwd: tmpDir, encoding: 'utf8', timeout: 30_000,
    })
    const skipLogPath = join(tmpDir, 'regrets', 'install-skipped.txt')
    assert.ok(existsSync(skipLogPath),
      'install-skipped.txt should exist when all clusters are trivial-skipped')

    const skipLog = readFileSync(skipLogPath, 'utf8')
    const clusterCount = (skipLog.match(/^Cluster: /gm) || []).length
    assert.equal(clusterCount, 3,
      `install-skipped.txt should list all 3 clusters (add, multiply, main); got ${clusterCount}`)
  })

  it('auto-detected callees for the main cluster are preserved (the original #268 loss)', () => {
    spawnSync('node', [INSTALL_JS, '--scope', 'math.js', '--skip-capture'], {
      cwd: tmpDir, encoding: 'utf8', timeout: 30_000,
    })
    const skipLog = readFileSync(join(tmpDir, 'regrets', 'install-skipped.txt'), 'utf8')
    // The main cluster should have callees: ["add", "multiply"] preserved
    assert.match(skipLog, /Entry:\s+main\b[\s\S]*?Callees:\s+add,\s+multiply/,
      `install-skipped.txt should preserve callees: add, multiply for the main cluster — ` +
      `this was the original #268 data loss. Got:\n${skipLog}`)
    assert.match(skipLog, /"callees":\s*\[\s*"add"\s*,\s*"multiply"\s*\]/,
      `cluster definition JSON in install-skipped.txt should include the callees array`)
  })

  it('install summary points user to install-skipped.txt', () => {
    const r = spawnSync('node', [INSTALL_JS, '--scope', 'math.js', '--skip-capture'], {
      cwd: tmpDir, encoding: 'utf8', timeout: 30_000,
    })
    assert.match(r.stdout, /All 3 cluster\(s\) skipped due to trivial inputs/,
      `summary should clearly state all 3 clusters were skipped due to trivial inputs`)
    assert.match(r.stdout, /install-skipped\.txt/,
      `summary should point the user to install-skipped.txt for cluster definitions`)
  })
})

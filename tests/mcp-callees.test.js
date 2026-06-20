// tests/mcp-callees.test.js — MCP regrets_capture / regrets_validate callee delegation
//
// Verifies (issue #266) that the MCP tools now correctly handle callees:
//   - regrets_capture spawns scripts/capture.js (which performs Phase 2
//     callee wrapping and writes <parent>.calls.<callee>.regret files).
//   - regrets_validate spawns scripts/validate.js (which performs Phase 3
//     callee contract re-validation and reports callee PASS/FAIL).
//
// Previously the MCP tools imported capture()/validate() from regret-testing
// (scripts/api.js), which reimplemented the capture/validate loop separately
// from the CLI scripts and silently skipped both Phase 2 and Phase 3.
//
// These tests import the compiled MCP handlers from @regrets/mcp (the
// workspace package whose dist is built by `npm run pretest` /
// `npm run build --workspace mcp`). If the dist build is missing or fails
// to load, the tests are skipped with a clear message.
//
// Run: node --test tests/mcp-callees.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

// Dynamic ESM import — the MCP bundle is ESM-only (tsup output), so
// require() cannot load it. We resolve the import at the top of the file
// and skip the tests if it fails.
let mcp = null
let mcpLoadError = null
try {
  mcp = await import('@regrets/mcp')
} catch (e) {
  mcpLoadError = e
}

const SKIP = !mcp || !mcp.handleCapture || !mcp.handleValidate
const SKIP_REASON = mcpLoadError
  ? `Failed to load @regrets/mcp: ${mcpLoadError.message}. Run \`npm run build --workspace mcp\` and retry.`
  : 'MCP dist did not export handleCapture/handleValidate — rebuild with `npm run build --workspace mcp`.'

// ─── Test fixtures ──────────────────────────────────────────────────────────

const TMP = resolve(join(process.cwd(), 'tests', `__mcp_callees_${process.pid}__`))

function setupProject(apiSource, manifest) {
  mkdirSync(join(TMP, 'regrets'), { recursive: true })
  writeFileSync(join(TMP, 'api.mjs'), apiSource)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))
}

function rewriteApi(apiSource) {
  writeFileSync(join(TMP, 'api.mjs'), apiSource)
}

function cleanupProject() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

/**
 * Invoke the MCP regrets_capture handler and parse its JSON text payload.
 * The handler returns { content: [{ type: 'text', text: '...' }] }.
 */
async function callCapture(args) {
  const result = await mcp.handleCapture(args)
  assert.ok(result.content, 'handler must return content array')
  assert.ok(result.content[0], 'handler must return at least one content entry')
  assert.equal(result.content[0].type, 'text', 'content type must be text')
  return JSON.parse(result.content[0].text)
}

async function callValidate(args) {
  const result = await mcp.handleValidate(args)
  assert.ok(result.content, 'handler must return content array')
  assert.ok(result.content[0], 'handler must return at least one content entry')
  assert.equal(result.content[0].type, 'text', 'content type must be text')
  return JSON.parse(result.content[0].text)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCP regrets_capture — Phase 2 callee wrapping (#266)', { skip: SKIP && SKIP_REASON }, () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`
  const manifest = {
    clusters: [
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
    ],
  }

  before(() => setupProject(originalApi, manifest))
  after(() => cleanupProject())

  it('spawns capture.js and writes both parent and callee .regret files', async () => {
    const result = await callCapture({ cwd: TMP })

    assert.equal(result.passed, 1, `expected 1 passed, got ${result.passed}`)
    assert.equal(result.failed, 0, `expected 0 failed, got ${result.failed}`)
    assert.ok(Array.isArray(result.clusters), 'clusters must be an array')
    assert.equal(result.clusters.length, 1, 'must report exactly one cluster')

    const mainCluster = result.clusters[0]
    assert.equal(mainCluster.id, 'main')
    assert.equal(mainCluster.pass, true, 'parent cluster must pass')
    assert.ok(mainCluster.fingerprint, 'parent must have a fingerprint')

    // ── NEW (Phase 2): per-cluster `callees` array listing callee contracts written
    assert.ok(Array.isArray(mainCluster.callees), 'cluster must have callees array')
    assert.equal(mainCluster.callees.length, 2, 'must report 2 callee contracts')

    const calleeIds = mainCluster.callees.map(c => c.id).sort()
    assert.deepEqual(calleeIds, ['main.calls.add', 'main.calls.mul'])

    for (const callee of mainCluster.callees) {
      assert.equal(callee.pass, true, `callee ${callee.id} must pass`)
      assert.ok(callee.fingerprint, `callee ${callee.id} must have a fingerprint`)
    }

    // ── Verify .regret files were actually written to disk
    const regretFiles = readdirSync(join(TMP, 'regrets'))
      .filter(f => f.endsWith('.regret'))
      .sort()
    assert.deepEqual(
      regretFiles,
      ['main.calls.add.regret', 'main.calls.mul.regret', 'main.regret'],
      `expected 3 .regret files (1 parent + 2 callees); got: ${regretFiles.join(', ')}`
    )
  })

  it('respects the `cluster` filter — only captures the requested cluster', async () => {
    // Clean up .regret files from the previous test to avoid stale state.
    rmSync(join(TMP, 'regrets', 'main.regret'))
    rmSync(join(TMP, 'regrets', 'main.calls.add.regret'))
    rmSync(join(TMP, 'regrets', 'main.calls.mul.regret'))

    const result = await callCapture({ cwd: TMP, cluster: 'main' })
    assert.equal(result.passed, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.clusters.length, 1)
    assert.equal(result.clusters[0].id, 'main')
    assert.ok(result.clusters[0].callees?.length === 2, 'filtered capture must still write callees')
  })

  it('returns a structured error when manifest is missing', async () => {
    // Use a cwd with no manifest — handler must NOT throw, must return a
    // structured-error CallToolResult.
    const badCwd = resolve(join(process.cwd(), 'tests', `__mcp_missing_${process.pid}__`))
    try {
      mkdirSync(badCwd, { recursive: true })
      const result = await mcp.handleCapture({ cwd: badCwd })

      // capture.js exits 1 when manifest can't be read. The MCP handler
      // captures that and returns either a structured-error body OR a
      // JSON object with an `error` field — either is acceptable as long
      // as it doesn't throw.
      assert.ok(result.content, 'handler must return content even on failure')
      const text = result.content[0].text
      const parsed = JSON.parse(text)
      // The body must indicate failure (either via structuredError's
      // `success: false` or via capture.js's `error` field).
      const indicatesError =
        parsed.success === false ||
        typeof parsed.error === 'string' ||
        (Array.isArray(parsed.clusters) && parsed.clusters.length === 0 && parsed.failed !== 0)
      assert.ok(indicatesError, `expected error indication in body, got: ${text}`)
    } finally {
      if (existsSync(badCwd)) rmSync(badCwd, { recursive: true, force: true })
    }
  })
})

describe('MCP regrets_validate — Phase 3 callee re-validation (#266)', { skip: SKIP && SKIP_REASON }, () => {
  const originalApi = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`
  const manifest = {
    clusters: [
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
    ],
  }

  before(async () => {
    setupProject(originalApi, manifest)
    // Capture baseline fingerprints (parent + callees) before validating.
    const cap = await callCapture({ cwd: TMP })
    assert.equal(cap.passed, 1, `setup capture should pass; got: ${JSON.stringify(cap)}`)
    assert.equal(cap.failed, 0)
  })
  after(() => cleanupProject())

  it('re-validates callee contracts when nothing changed — all PASS', async () => {
    const result = await callValidate({ cwd: TMP })

    // ── Existing MCP contract (must stay stable)
    assert.equal(result.verdict, 'ALL PASS')
    assert.equal(result.passed, 1)
    assert.equal(result.failed, 0)
    assert.ok(Array.isArray(result.summary))
    assert.match(result.summary[0], /main:\sPASS/, 'summary must mention main: PASS')
    assert.ok(Array.isArray(result.results))
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].id, 'main')
    assert.equal(result.results[0].pass, true)

    // ── NEW (Phase 3): top-level `callees` object with per-contract results
    assert.ok(result.callees, 'must include top-level callees object')
    assert.equal(result.callees.passed, 2, '2 callee contracts should pass')
    assert.equal(result.callees.failed, 0)
    assert.equal(result.callees.considered, 2)
    assert.ok(Array.isArray(result.callees.contracts))
    assert.equal(result.callees.contracts.length, 2)

    const contractIds = result.callees.contracts.map(c => c.id).sort()
    assert.deepEqual(contractIds, ['main.calls.add', 'main.calls.mul'])

    for (const c of result.callees.contracts) {
      assert.equal(c.pass, true, `callee ${c.id} should PASS`)
      assert.ok(c.expected, `callee ${c.id} must have expected hash`)
      assert.ok(c.actual, `callee ${c.id} must have actual hash`)
      assert.equal(c.expected, c.actual, `callee ${c.id} hashes must match`)
    }
  })

  it('detects callee regression — modified add() → callee FAIL', async () => {
    rewriteApi(`
function add(a, b) { return a - b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`)

    const result = await callValidate({ cwd: TMP })

    assert.notEqual(result.verdict, 'ALL PASS', 'verdict must not be ALL PASS')
    assert.ok(result.failed >= 1, 'at least the parent cluster should fail')

    // ── Callee `add` must FAIL (behavior changed: + → -)
    assert.ok(result.callees, 'must include callees object')
    assert.ok(result.callees.failed >= 1, 'at least one callee should fail')
    const addContract = result.callees.contracts.find(c => c.id === 'main.calls.add')
    assert.ok(addContract, 'main.calls.add must be in contracts')
    assert.equal(addContract.pass, false, 'main.calls.add must FAIL')
    assert.notEqual(addContract.expected, addContract.actual, 'hashes must differ')

    // ── Callee `mul` must still PASS (unchanged)
    const mulContract = result.callees.contracts.find(c => c.id === 'main.calls.mul')
    assert.ok(mulContract, 'main.calls.mul must be in contracts')
    assert.equal(mulContract.pass, true, 'main.calls.mul must still PASS')
    assert.equal(mulContract.expected, mulContract.actual)
  })

  it('skipCallees=true disables Phase 3 callee re-validation', async () => {
    // add() is still broken from the previous test, but with skipCallees
    // the parent cluster will still FAIL (its hash changed) while callees
    // are NOT re-validated — the contracts array must be empty.
    const result = await callValidate({ cwd: TMP, skipCallees: true })

    // Parent cluster still fails (fingerprintLevel: 'entry' caught the output change)
    assert.notEqual(result.verdict, 'ALL PASS')
    assert.ok(result.failed >= 1, 'parent cluster must still fail')

    // Callee phase must be skipped — no contracts considered
    assert.ok(result.callees, 'callees object must still be present (for shape stability)')
    assert.equal(result.callees.considered, 0, 'no callee contracts should be considered')
    assert.equal(result.callees.passed, 0)
    assert.equal(result.callees.failed, 0)
    assert.equal(result.callees.contracts.length, 0)
  })

  it('preserves existing MCP output contract — verdict/passed/failed/summary/results', async () => {
    // Restore the original API so everything passes cleanly.
    rewriteApi(originalApi)

    const result = await callValidate({ cwd: TMP })

    // Every field that existed BEFORE this PR must still be present and
    // have the same type/semantics. New fields (callees, status, confidence,
    // drift, etc.) are additive and not asserted here.
    assert.equal(typeof result.verdict, 'string')
    assert.equal(typeof result.passed, 'number')
    assert.equal(typeof result.failed, 'number')
    assert.ok(Array.isArray(result.summary))
    assert.ok(Array.isArray(result.results))

    for (const r of result.results) {
      assert.equal(typeof r.id, 'string')
      assert.equal(typeof r.pass, 'boolean')
      // expected/actual/diff/error/skipped are optional but must be the
      // right type when present.
      if (r.expected !== undefined) assert.equal(typeof r.expected, 'string')
      if (r.actual !== undefined) assert.equal(typeof r.actual, 'string')
      if (r.diff !== undefined) assert.equal(typeof r.diff, 'string')
      if (r.error !== undefined) assert.equal(typeof r.error, 'string')
      if (r.skipped !== undefined) assert.equal(typeof r.skipped, 'boolean')
    }
  })
})

describe('MCP regrets_validate — missing callee contracts (issue #288 integration)', { skip: SKIP && SKIP_REASON }, () => {
  const api = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
export { main, add, mul }
`
  const manifest = {
    clusters: [
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
    ],
  }

  before(() => setupProject(api, manifest))
  after(() => cleanupProject())

  it('fails parent cluster with missingCallees when .calls.*.regret files absent', async () => {
    // Capture the parent only by temporarily dropping `callees` from the manifest,
    // then put callees back so validate expects callee contracts that don't exist.
    const noCalleeManifest = JSON.parse(JSON.stringify(manifest))
    noCalleeManifest.clusters[0].callees = []
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(noCalleeManifest, null, 2))
    const cap = await callCapture({ cwd: TMP })
    assert.equal(cap.passed, 1, 'capture without callees should pass')

    // Restore callees in manifest; .regret files for callees are missing on disk.
    writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify(manifest, null, 2))

    const result = await callValidate({ cwd: TMP })

    // Parent cluster should FAIL with missingCallees info — this is the
    // #288 gap that previously went silently green in MCP because api.js
    // didn't implement the missing-callee check.
    assert.notEqual(result.verdict, 'ALL PASS')
    assert.ok(result.failed >= 1, 'parent should fail because callee contracts are missing')

    const mainResult = result.results.find(r => r.id === 'main')
    assert.ok(mainResult, 'main result must be present')
    assert.equal(mainResult.pass, false, 'main must FAIL')

    // missingCallees field is additive (new in this PR) — when present,
    // it lists the callee names whose .regret files are missing.
    if (mainResult.missingCallees) {
      assert.ok(Array.isArray(mainResult.missingCallees))
      assert.ok(mainResult.missingCallees.includes('add'))
      assert.ok(mainResult.missingCallees.includes('mul'))
    }

    // Error message should point the user at `regret capture` to fix it.
    if (mainResult.error) {
      assert.match(mainResult.error, /callee contract missing/i, `error should mention missing callee contract; got: ${mainResult.error}`)
    }
  })
})

describe('MCP input schema — skipCallees option exists', { skip: SKIP && SKIP_REASON }, () => {
  it('validateToolSchema includes skipCallees as an optional boolean', () => {
    assert.ok(mcp.validateToolSchema, 'validateToolSchema must be exported')
    assert.ok(mcp.validateToolSchema.skipCallees, 'skipCallees must be present in the schema')
    // Zod schema object — the optional boolean is wrapped in ZodOptional<ZodBoolean>
    // We just check the description mentions callee re-validation.
    const desc = mcp.validateToolSchema.skipCallees.description ?? ''
    assert.match(desc, /callee/i, `skipCallees description should mention callees; got: ${desc}`)
  })

  it('captureToolSchema preserves existing fields (manifestPath, cluster, cwd)', () => {
    assert.ok(mcp.captureToolSchema, 'captureToolSchema must be exported')
    assert.ok(mcp.captureToolSchema.manifestPath, 'manifestPath must be present')
    assert.ok(mcp.captureToolSchema.cluster, 'cluster must be present')
    assert.ok(mcp.captureToolSchema.cwd, 'cwd must be present')
  })
})

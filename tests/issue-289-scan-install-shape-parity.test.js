// tests/issue-289-scan-install-shape-parity.test.js
//
// Regression test for #289: api.js#scan() emits a different cluster-suggestion
// shape than install.js — `watches` mismatch (scan: [fnName] vs install: []),
// no `fingerprintLevel`/`inputs`/`callees` fields.
//
// Background: scan() in scripts/api.js is consumed by the MCP server's
// `regrets_scan` tool. MCP agents (LLMs using the MCP tool) build manifests
// from scan() output. Previously scan() emitted `watches: [fnName]`, which
// triggered `fingerprintLevel: 'watched'` default mode in capture.js
// (ghost proxy + callee recording) — a different contract from
// `regret install` which emits `watches: []` + explicit `fingerprintLevel: 'entry'`.
//
// The fix: scan() now emits the same field shape as install.js:
//   - watches: []          (was: [fnName])
//   - fingerprintLevel: 'entry'   (was: absent — capture.js defaulted to 'watched')
//   - inputs: []           (was: absent — install.js probes; scan does not)
//   - callees: []          (was: absent — install.js runs analyzeScope; scan does not)
//
// inputs/callees are intentionally left empty (scan is a lightweight
// suggestion tool, not a full installer). MCP agents should run
// `regret install` to populate them, or fill them manually.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { scan } from '../scripts/api.js'

const TMP = resolve(join(process.cwd(), 'tests', `__issue289_${process.pid}__`))

function setupFixture() {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'math.mjs'), `
export function add(a, b) { return a + b }
export function multiply(a, b) { return a * b }
`)
}

function cleanup() {
  rmSync(TMP, { recursive: true, force: true })
}

describe('#289 — scan() output shape matches install.js shape', () => {
  before(() => {
    cleanup()
    setupFixture()
  })
  after(cleanup)

  it('scan() suggestions contain watches: [] (NOT [fnName])', async () => {
    const { suggestions } = await scan({ dir: TMP, stack: 'js' })

    assert.equal(suggestions.length, 2, `expected 2 suggestions (add, multiply); got ${suggestions.length}`)

    for (const s of suggestions) {
      assert.ok(Array.isArray(s.watches),
        `suggestion for ${s.entry} should have a watches array; got ${typeof s.watches}`)
      assert.equal(s.watches.length, 0,
        `watches for ${s.entry} must be empty (was [fnName] before fix, triggering watched mode). Got: ${JSON.stringify(s.watches)}`)
    }
  })

  it('scan() suggestions contain explicit fingerprintLevel: "entry"', async () => {
    const { suggestions } = await scan({ dir: TMP, stack: 'js' })

    for (const s of suggestions) {
      assert.equal(s.fingerprintLevel, 'entry',
        `suggestion for ${s.entry} must have fingerprintLevel='entry' (was absent before fix, capture.js defaulted to 'watched'). Got: ${JSON.stringify(s.fingerprintLevel)}`)
    }
  })

  it('scan() suggestions include inputs and callees arrays (empty by design)', async () => {
    const { suggestions } = await scan({ dir: TMP, stack: 'js' })

    for (const s of suggestions) {
      assert.ok(Array.isArray(s.inputs),
        `suggestion for ${s.entry} should have an inputs array (empty — scan does not probe). Got: ${typeof s.inputs}`)
      assert.equal(s.inputs.length, 0,
        `inputs for ${s.entry} should be empty (scan is a lightweight suggestion tool; run regret install to probe). Got: ${JSON.stringify(s.inputs)}`)

      assert.ok(Array.isArray(s.callees),
        `suggestion for ${s.entry} should have a callees array (empty — scan does not run analyzeScope). Got: ${typeof s.callees}`)
      assert.equal(s.callees.length, 0,
        `callees for ${s.entry} should be empty (scan does not run analyzeScope; run regret install to detect). Got: ${JSON.stringify(s.callees)}`)
    }
  })

  it('scan() suggestion has all 8 required fields (parity with install.js)', async () => {
    const { suggestions } = await scan({ dir: TMP, stack: 'js' })
    const REQUIRED_FIELDS = ['id', 'entry', 'file', 'stack', 'watches', 'fingerprintLevel', 'inputs', 'callees']

    for (const s of suggestions) {
      for (const field of REQUIRED_FIELDS) {
        assert.ok(field in s,
          `suggestion for ${s.entry} must have field '${field}'. Got keys: ${Object.keys(s).join(', ')}`)
      }
    }
  })
})

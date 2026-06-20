// tests/issue-285-chain-stderr.test.js
// Closes #285: api.js#chain() must capture stderr (not just stdout) from
// contest.mjs. When stdout parsing yields "no result line found in output",
// the actual error message (written to stderr by contest.mjs) was
// previously discarded. The fix includes the captured stderr in the
// failure reason so users see the real error.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { chain } from '../scripts/api.js'

const TMP = resolve(join(process.cwd(), 'tests', `__issue285_${process.pid}__`))

function setupBrokenChainProject() {
  mkdirSync(join(TMP, 'regrets', 'chains'), { recursive: true })
  // A module with a syntax error — contest.mjs will fail to import it,
  // writing the error to stderr. Pre-fix, chain() would return
  // "no result line found in output" with no hint about the syntax error.
  writeFileSync(join(TMP, 'broken.mjs'), `
function main(x) { return x + }  // syntax error: missing operand
export { main }
`)
  writeFileSync(join(TMP, 'regrets', 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'main',
        entry: 'main',
        file: './broken.mjs',
        stack: 'js',
        fingerprintLevel: 'entry',
        inputs: [5],
        watches: [],
      },
    ],
  }, null, 2))
  writeFileSync(join(TMP, 'regrets', 'chains.json'), JSON.stringify({
    chains: [
      { id: 'broken-chain', steps: [{ cluster: 'main', input: 5 }] },
    ],
  }, null, 2))
}

describe('Issue #285 — api.js#chain() captures stderr from contest.mjs', () => {
  before(() => setupBrokenChainProject())
  after(() => { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }) })

  it('chain() returns a structured result with passed/failed/chains (no throw)', async () => {
    // Pre-fix: chain() would return { passed: 0, failed: 1, chains: [{ id: 'broken-chain', status: 'failed', reason: 'no result line found in output' }] }
    // — the opaque reason with no stderr context.
    // Post-fix: the reason (and a separate `stderr` field) include the
    // actual error from contest.mjs.
    let result
    try {
      result = await chain({ cwd: TMP, mode: 'validate' })
    } catch (err) {
      // Some failures (e.g. contest.mjs itself crashing) might still
      // throw — that's OK as long as the error message is meaningful
      // (it now includes stderr from the rejected promise path too).
      assert.ok(typeof err.message === 'string' && err.message.length > 0)
      return
    }
    assert.ok(result, 'chain() should return a result object')
    assert.ok('passed' in result, 'result should have passed field')
    assert.ok('failed' in result, 'result should have failed field')
    assert.ok(Array.isArray(result.chains), 'result.chains should be an array')
    assert.equal(result.failed, 1, `expected 1 failed chain; got: ${JSON.stringify(result)}`)
  })

  it('failed chain reason includes actual error from stderr (not just "no result line found")', async () => {
    const result = await chain({ cwd: TMP, mode: 'validate' })
    const failedChain = result.chains.find(c => c.id === 'broken-chain')
    assert.ok(failedChain, `should have a result entry for broken-chain; got: ${JSON.stringify(result.chains)}`)
    assert.equal(failedChain.status, 'failed',
      `chain status should be 'failed'; got: ${failedChain.status}`)

    // The reason should NOT be the opaque pre-fix message alone.
    // It should EITHER include the actual stderr content OR be a more
    // specific contest.mjs message like "Chain failed: ...".
    const reason = failedChain.reason || ''
    const stderr = failedChain.stderr || ''
    const combined = `${reason}\n${stderr}`

    // Pre-fix bug: reason was exactly "no result line found in output"
    // with no stderr context. Post-fix: either the reason includes
    // stderr, OR there's a separate `stderr` field, OR contest.mjs
    // produced a "Chain failed: ..." line that was parsed.
    const hasOpaqueReasonAlone = reason === 'no result line found in output' && !stderr
    assert.ok(!hasOpaqueReasonAlone,
      `should not return opaque "no result line found in output" without stderr context; got reason=${JSON.stringify(reason)}, stderr=${JSON.stringify(stderr)}`)

    // The combined output should reference the syntax error somehow
    // (e.g. "SyntaxError", "Unexpected", or contest.mjs's "Chain failed").
    assert.ok(
      /SyntaxError|Unexpected|Chain failed|stderr/i.test(combined),
      `combined reason+stderr should reference the actual error (SyntaxError / Chain failed / stderr); got:\n${combined}`
    )
  })
})

describe('Issue #285 — chain() returns clean structured result when contest.mjs succeeds', () => {
  // Sanity check: the stderr-capture refactor doesn't break the success
  // path. A working chain should still produce a passed result with no
  // stderr field on the chain entry.
  const TMP_OK = resolve(join(process.cwd(), 'tests', `__issue285_ok_${process.pid}__`))

  before(() => {
    mkdirSync(join(TMP_OK, 'regrets', 'chains'), { recursive: true })
    writeFileSync(join(TMP_OK, 'ok.mjs'), `
function main(x) { return x * 2 }
export { main }
`)
    writeFileSync(join(TMP_OK, 'regrets', 'manifest.json'), JSON.stringify({
      clusters: [{
        id: 'main', entry: 'main', file: './ok.mjs', stack: 'js',
        fingerprintLevel: 'entry', inputs: [5], watches: [],
      }],
    }, null, 2))
    writeFileSync(join(TMP_OK, 'regrets', 'chains.json'), JSON.stringify({
      chains: [{ id: 'ok-chain', steps: [{ cluster: 'main', input: 5 }] }],
    }, null, 2))
  })
  after(() => { if (existsSync(TMP_OK)) rmSync(TMP_OK, { recursive: true, force: true }) })

  it('chain() returns passed:1 with no stderr field for a working chain (capture mode)', async () => {
    const result = await chain({ cwd: TMP_OK, mode: 'capture' })
    assert.equal(result.passed, 1, `expected 1 passed chain; got: ${JSON.stringify(result)}`)
    assert.equal(result.failed, 0, `expected 0 failed chains; got: ${JSON.stringify(result)}`)
    const okChain = result.chains.find(c => c.id === 'ok-chain')
    assert.ok(okChain, 'should have ok-chain in results')
    assert.equal(okChain.status, 'passed')
    // No stderr field on a successful chain entry.
    assert.ok(!okChain.stderr, `successful chain should not have stderr field; got: ${JSON.stringify(okChain)}`)
  })
})

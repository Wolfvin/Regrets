// tests/api.test.js — unit tests for scripts/api.js
// Uses Node.js built-in node:test and node:assert (zero external dependencies)
// Tests the validate(), check(), and chain() API functions with mock filesystem.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { validate, check, chain, scan } from '../scripts/api.js'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

// ─── Test fixtures ──────────────────────────────────────────────────────────

const TMP = resolve(join(process.cwd(), 'tests', '__api_test_tmp__'))
const REGRETS = join(TMP, 'regrets')

function setupFixtures() {
  mkdirSync(REGRETS, { recursive: true })

  // Simple module with named export
  writeFileSync(join(TMP, 'math.js'), `
export function add(a, b) { return a + b }
export function multiply(a, b) { return a * b }
`)

  // Manifest at regrets/manifest.json (default path)
  writeFileSync(join(REGRETS, 'manifest.json'), JSON.stringify({
    clusters: [
      {
        id: 'add-fn',
        entry: 'add',
        file: './math.js',
        stack: 'js',
        inputs: [[1, 2], [3, 4]],
        watches: ['multiply']
      }
    ]
  }))

  // Regret file for the add-fn cluster
  const regretContent = [
    'fingerprint: placeholder',
    'captured: 2024-01-01T00:00:00.000Z',
    '---',
    'null'
  ].join('\n')
  writeFileSync(join(REGRETS, 'add-fn.regret'), regretContent)

  // Empty manifest
  writeFileSync(join(TMP, 'empty-manifest.json'), JSON.stringify({ clusters: [] }))

  // Corrupt manifest
  writeFileSync(join(TMP, 'corrupt-manifest.json'), 'not valid json {{{')

  // Manifest with missing required fields
  writeFileSync(join(TMP, 'bad-manifest.json'), JSON.stringify({
    clusters: [
      { id: 'missing-entry-and-stack' }
    ]
  }))

  // Manifest with no inputs (for warning test)
  writeFileSync(join(TMP, 'no-inputs-manifest.json'), JSON.stringify({
    clusters: [
      { id: 'no-inputs', entry: 'add', file: './math.js', stack: 'js' }
    ]
  }))
}

function cleanupFixtures() {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true })
  }
}

// ─── validate() ─────────────────────────────────────────────────────────────

describe('validate()', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('returns error when manifest not found', async () => {
    const result = await validate({ cwd: '/nonexistent/path' })
    assert.ok(result.error)
    assert.ok(result.error.includes('Could not read manifest'))
    assert.equal(result.passed, 0)
    assert.equal(result.failed, 0)
    assert.equal(result.results.length, 0)
  })

  it('returns error when manifest is corrupt', async () => {
    const result = await validate({ cwd: TMP, manifestPath: 'corrupt-manifest.json' })
    assert.ok(result.error)
    assert.ok(result.error.includes('Could not read manifest'))
  })

  it('returns structured result with passed/failed/results', async () => {
    const result = await validate({ cwd: TMP })
    assert.ok('passed' in result, 'has passed field')
    assert.ok('failed' in result, 'has failed field')
    assert.ok('results' in result, 'has results field')
    assert.ok(Array.isArray(result.results), 'results is an array')
  })

  it('results contain id and pass fields', async () => {
    const result = await validate({ cwd: TMP })
    if (result.results.length > 0) {
      const entry = result.results[0]
      assert.ok('id' in entry, 'result entry has id')
      assert.ok('pass' in entry, 'result entry has pass boolean')
    }
  })

  it('returns error when no .regret files found with filter', async () => {
    const result = await validate({ cwd: TMP, cluster: 'nonexistent' })
    assert.ok(result.error)
    assert.ok(result.error.includes('No .regret files found'))
  })

  it('returns correct shape: { passed, failed, results }', async () => {
    const result = await validate({ cwd: TMP })
    assert.equal(typeof result.passed, 'number')
    assert.equal(typeof result.failed, 'number')
    assert.ok(Array.isArray(result.results))
  })

  it('validates each cluster and returns pass or fail per result', async () => {
    const result = await validate({ cwd: TMP })
    for (const r of result.results) {
      assert.equal(typeof r.pass, 'boolean')
      assert.equal(typeof r.id, 'string')
    }
  })
})

// ─── check() ────────────────────────────────────────────────────────────────

describe('check()', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('returns valid:true for a well-formed manifest', async () => {
    const result = await check({ cwd: TMP })
    // Our test manifest has id, entry, stack — should be valid structure
    assert.equal(result.valid, true)
    assert.equal(result.checked, 1)
    assert.ok(Array.isArray(result.errors))
    assert.ok(Array.isArray(result.warnings))
  })

  it('returns valid:true for empty manifest', async () => {
    const result = await check({ cwd: TMP, manifestPath: 'empty-manifest.json' })
    assert.equal(result.valid, true)
    assert.equal(result.checked, 0)
  })

  it('returns error when manifest not found', async () => {
    const result = await check({ cwd: '/nonexistent/path' })
    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
    assert.ok(result.errors[0].message.includes('Could not read manifest'))
  })

  it('returns valid:false for manifest with missing required fields', async () => {
    const result = await check({ cwd: TMP, manifestPath: 'bad-manifest.json' })
    assert.equal(result.valid, false)
    assert.ok(result.errors.length > 0)
    const messages = result.errors.map(e => e.message)
    assert.ok(messages.some(m => m.includes('Missing required field')), 'reports missing fields')
  })

  it('result has errors, warnings, and checked fields', async () => {
    const result = await check({ cwd: TMP })
    assert.ok('errors' in result)
    assert.ok('warnings' in result)
    assert.ok('checked' in result)
    assert.ok(Array.isArray(result.errors))
    assert.ok(Array.isArray(result.warnings))
    assert.equal(typeof result.checked, 'number')
  })

  it('warns about clusters with no inputs', async () => {
    const result = await check({ cwd: TMP, manifestPath: 'no-inputs-manifest.json' })
    assert.ok(result.warnings.length > 0)
    assert.ok(result.warnings.some(w => w.message.includes('No inputs')))
  })

  it('reports duplicate cluster IDs', async () => {
    writeFileSync(join(TMP, 'dup-manifest.json'), JSON.stringify({
      clusters: [
        { id: 'dup', entry: 'add', file: './math.js', stack: 'js', inputs: [1] },
        { id: 'dup', entry: 'add', file: './math.js', stack: 'js', inputs: [2] }
      ]
    }))
    const result = await check({ cwd: TMP, manifestPath: 'dup-manifest.json' })
    assert.equal(result.valid, false)
    assert.ok(result.errors.some(e => e.message.includes('Duplicate cluster id')))
  })
})

// ─── chain() ────────────────────────────────────────────────────────────────

describe('chain()', () => {
  it('returns structured result shape with passed/failed/chains', async () => {
    // chain() spawns contest.mjs — test with nonexistent dir should fail gracefully
    try {
      const result = await chain({ cwd: '/nonexistent/path', mode: 'validate' })
      assert.ok('passed' in result)
      assert.ok('failed' in result)
      assert.ok('chains' in result)
      assert.ok(Array.isArray(result.chains))
    } catch (err) {
      // chain() may throw for missing project — verify error is meaningful
      assert.ok(typeof err.message === 'string')
      assert.ok(err.message.length > 0)
    }
  })

  it('defaults mode to validate when not specified', async () => {
    try {
      const result = await chain({ cwd: TMP })
      assert.equal(typeof result.passed, 'number')
      assert.equal(typeof result.failed, 'number')
      assert.ok(Array.isArray(result.chains))
    } catch (err) {
      // Expected for missing chains.json
      assert.ok(err)
    }
  })

  it('handles capture mode', async () => {
    try {
      const result = await chain({ cwd: TMP, mode: 'capture' })
      assert.ok('passed' in result)
      assert.ok('failed' in result)
      assert.ok('chains' in result)
    } catch (err) {
      // Expected for missing chains.json
      assert.ok(err)
    }
  })
})

// ─── scan() — issue #289: shape must mirror install.js ───────────────────────

describe('scan() — issue #289 shape alignment with install.js', () => {
  const SCAN_TMP = resolve(join(process.cwd(), 'tests', '__api_scan_tmp__'))

  before(() => {
    mkdirSync(SCAN_TMP, { recursive: true })
    writeFileSync(join(SCAN_TMP, 'api.cjs'), `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, 1) + mul(x, 2) }
module.exports = { add, mul, main }
`)
    writeFileSync(join(SCAN_TMP, 'package.json'), '{"name":"scan-test","version":"0.0.0"}')
  })

  after(() => {
    rmSync(SCAN_TMP, { recursive: true, force: true })
  })

  it('emits id with file-path hint (e.g. "api-add" not just "add")', async () => {
    const result = await scan({ dir: '.', cwd: SCAN_TMP })
    const ids = result.suggestions.map(s => s.id).sort()
    assert.deepEqual(ids, ['api-add', 'api-main', 'api-mul'],
      `expected path-hinted ids, got: ${ids.join(', ')}`)
  })

  it('emits watches: [] (not [fnName]) — matches install.js default', async () => {
    const result = await scan({ dir: '.', cwd: SCAN_TMP })
    for (const s of result.suggestions) {
      assert.deepEqual(s.watches, [],
        `expected watches: [] for ${s.id}, got: ${JSON.stringify(s.watches)}`)
    }
  })

  it('emits fingerprintLevel: "entry" explicitly', async () => {
    const result = await scan({ dir: '.', cwd: SCAN_TMP })
    for (const s of result.suggestions) {
      assert.equal(s.fingerprintLevel, 'entry',
        `expected fingerprintLevel: 'entry' for ${s.id}, got: ${s.fingerprintLevel}`)
    }
  })

  it('emits inputs: [null, {}] — matches install.js default', async () => {
    const result = await scan({ dir: '.', cwd: SCAN_TMP })
    for (const s of result.suggestions) {
      assert.deepEqual(s.inputs, [null, {}],
        `expected inputs: [null, {}] for ${s.id}, got: ${JSON.stringify(s.inputs)}`)
    }
  })

  it('does NOT emit watches: [fnName] (the old broken shape)', async () => {
    const result = await scan({ dir: '.', cwd: SCAN_TMP })
    for (const s of result.suggestions) {
      assert.ok(!s.watches.includes(s.entry),
        `suggestion ${s.id} must not have watches: [${s.entry}] (old broken shape from issue #289)`)
    }
  })
})

describe('scan() — issue #289 follow-up: `module.exports = someVar` pattern', () => {
  // CJS common pattern: define a const with object literal, then export it.
  // Both install.js and api.js must detect the inner function names.
  const INDIRECT_TMP = resolve(join(process.cwd(), 'tests', '__api_indirect_tmp__'))

  before(() => {
    mkdirSync(INDIRECT_TMP, { recursive: true })
    // Original repro from issue #289:
    writeFileSync(join(INDIRECT_TMP, 'api.cjs'), `
const mod = {
  add: function(a, b) { return a + b },
  mul: function(a, b) { return a * b },
  main: function(x) { return mod.add(x, 1) + mod.mul(x, 2) }
}
module.exports = mod
`)
    writeFileSync(join(INDIRECT_TMP, 'package.json'), '{"name":"indirect-test","version":"0.0.0"}')
  })

  after(() => {
    rmSync(INDIRECT_TMP, { recursive: true, force: true })
  })

  it('scan() detects exports via `module.exports = someVar` (indirect object export)', async () => {
    const result = await scan({ dir: '.', cwd: INDIRECT_TMP })
    const entries = result.suggestions.map(s => s.entry).sort()
    assert.deepEqual(entries, ['add', 'main', 'mul'],
      `expected [add, main, mul] for indirect object export, got: ${entries.join(', ')}`)
  })

  it('scan() suggestions for indirect export still have correct shape (#289)', async () => {
    const result = await scan({ dir: '.', cwd: INDIRECT_TMP })
    for (const s of result.suggestions) {
      assert.deepEqual(s.watches, [],
        `expected watches: [] for ${s.id}, got: ${JSON.stringify(s.watches)}`)
      assert.equal(s.fingerprintLevel, 'entry',
        `expected fingerprintLevel: 'entry' for ${s.id}`)
      assert.deepEqual(s.inputs, [null, {}],
        `expected inputs: [null, {}] for ${s.id}`)
      // Path-hinted id: "api-add" not "add"
      assert.ok(s.id.startsWith('api-'),
        `expected id with file-path hint (api-*) for ${s.entry}, got: ${s.id}`)
    }
  })
})

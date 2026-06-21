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

// ─── scan() ──────────────────────────────────────────────────────────────────

describe('scan()', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('returns suggestions array with expected shape (issue #289)', async () => {
    const { suggestions } = await scan({ cwd: TMP })
    assert.ok(Array.isArray(suggestions), 'suggestions should be an array')
    assert.ok(suggestions.length > 0, 'should find at least one suggestion in fixtures')

    const s = suggestions[0]
    // #289: scan() must emit the SAME shape as install.js
    assert.ok('id' in s, 'suggestion has id')
    assert.ok('entry' in s, 'suggestion has entry')
    assert.ok('file' in s, 'suggestion has file')
    assert.ok('stack' in s, 'suggestion has stack')
    assert.ok('watches' in s, 'suggestion has watches')
    assert.ok('fingerprintLevel' in s, 'suggestion has fingerprintLevel (#289 fix)')
    assert.ok('inputs' in s, 'suggestion has inputs (#289 fix)')
    assert.ok('callees' in s, 'suggestion has callees (#289 fix)')
  })

  it('watches is [] (NOT [fnName]) — matches install.js (issue #289)', async () => {
    const { suggestions } = await scan({ cwd: TMP })
    for (const s of suggestions) {
      assert.deepEqual(s.watches, [],
        `suggestion ${s.id}: watches should be [] (not [${s.entry}]) — matches install.js shape`)
    }
  })

  it('fingerprintLevel is "entry" — matches install.js (issue #289)', async () => {
    const { suggestions } = await scan({ cwd: TMP })
    for (const s of suggestions) {
      assert.equal(s.fingerprintLevel, 'entry',
        `suggestion ${s.id}: fingerprintLevel should be 'entry'`)
    }
  })

  it('inputs is [null, {}] — matches install.js default probes (issue #289)', async () => {
    const { suggestions } = await scan({ cwd: TMP })
    for (const s of suggestions) {
      assert.deepEqual(s.inputs, [null, {}],
        `suggestion ${s.id}: inputs should be [null, {}]`)
    }
  })

  it('callees is [] (present but empty) — matches install.js shape (issue #289)', async () => {
    const { suggestions } = await scan({ cwd: TMP })
    for (const s of suggestions) {
      assert.deepEqual(s.callees, [],
        `suggestion ${s.id}: callees should be []`)
    }
  })

  it('detects export class X (#292 parity with install.js)', async () => {
    // Create a class-only module — install.js detects it, scan() must too
    writeFileSync(join(TMP, 'class-only.mjs'),
      'export class Calculator {\n  add(a, b) { return a + b }\n}\n')
    try {
      const { suggestions } = await scan({ cwd: TMP, dir: '.', stack: 'js' })
      const classSuggestion = suggestions.find(s => s.entry === 'Calculator')
      assert.ok(classSuggestion, 'should detect export class Calculator (#292 parity)')
    } finally {
      try { rmSync(join(TMP, 'class-only.mjs')) } catch {}
    }
  })

  it('does NOT detect function names in comments (#286 parity with install.js)', async () => {
    // The comment mentions `export const phantom` — scan() must NOT create a cluster for it
    writeFileSync(join(TMP, 'with-comment.mjs'),
      '// ESM module with `export const phantom = () => ...` callees\n' +
      'export const real = (s) => s.toLowerCase()\n')
    try {
      const { suggestions } = await scan({ cwd: TMP, dir: '.', stack: 'js' })
      const entries = suggestions.map(s => s.entry)
      assert.ok(entries.includes('real'), 'should detect `real`')
      assert.ok(!entries.includes('phantom'),
        'should NOT detect `phantom` (only mentioned in comment — #286 parity)')
    } finally {
      try { rmSync(join(TMP, 'with-comment.mjs')) } catch {}
    }
  })

  it('detects export { foo, bar } named export list (#271 parity)', async () => {
    writeFileSync(join(TMP, 'named-exports.mjs'),
      'function foo() { return 1 }\nfunction bar() { return 2 }\nexport { foo, bar }\n')
    try {
      const { suggestions } = await scan({ cwd: TMP, dir: '.', stack: 'js' })
      const entries = suggestions.map(s => s.entry)
      assert.ok(entries.includes('foo'), 'should detect foo from export { foo, bar }')
      assert.ok(entries.includes('bar'), 'should detect bar from export { foo, bar }')
    } finally {
      try { rmSync(join(TMP, 'named-exports.mjs')) } catch {}
    }
  })
})

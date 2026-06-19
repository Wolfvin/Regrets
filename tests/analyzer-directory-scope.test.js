// tests/analyzer-directory-scope.test.js — Unit tests for directory input in analyzeScope()
//
// Tests that analyzeScope(dirPath) recursively discovers source files,
// analyzes each one, and merges the results with proper dedup.
//
// Run: node --test tests/analyzer-directory-scope.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { analyzeScope } from '../scripts/analyzer.js'

const TMP = resolve(join(process.cwd(), 'tests', '__analyzer_dir_tmp__'))

function setupFixtures() {
  // Directory with 3 JS files
  mkdirSync(TMP, { recursive: true })

  writeFileSync(join(TMP, 'math.js'), `
function add(a, b) { return a + b }
function multiply(a, b) { return a * b }
`)

  writeFileSync(join(TMP, 'string.js'), `
function capitalize(s) { return s.toUpperCase() }
function lowercase(s) { return s.toLowerCase() }
`)

  writeFileSync(join(TMP, 'core.js'), `
function main() {
  add(1, 2)
  capitalize("hello")
}
`)

  // Nested subdirectory with more JS files
  mkdirSync(join(TMP, 'utils'), { recursive: true })
  writeFileSync(join(TMP, 'utils', 'helpers.js'), `
function helper(x) { return x }
`)

  // node_modules should be skipped
  mkdirSync(join(TMP, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(TMP, 'node_modules', 'pkg', 'index.js'), `
function externalFn() { return 1 }
`)

  // .git should be skipped
  mkdirSync(join(TMP, '.git'), { recursive: true })
  writeFileSync(join(TMP, '.git', 'hook.js'), `
function gitHook() { return 0 }
`)

  // dist should be skipped
  mkdirSync(join(TMP, 'dist'), { recursive: true })
  writeFileSync(join(TMP, 'dist', 'bundle.js'), `
function bundled() { return 0 }
`)

  // Python file should also be discovered
  writeFileSync(join(TMP, 'logic.py'), `
def compute(x):
    return x + 1
`)

  // Non-source file should be ignored
  writeFileSync(join(TMP, 'readme.md'), '# Hello')
}

function cleanupFixtures() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('analyzeScope — directory input', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('aggregates functions from all 3 top-level JS files', async () => {
    const { functions } = await analyzeScope(TMP)
    const names = functions.map(f => f.name)
    // math.js: add, multiply; string.js: capitalize, lowercase; core.js: main
    assert.ok(names.includes('add'), 'should include add from math.js')
    assert.ok(names.includes('multiply'), 'should include multiply from math.js')
    assert.ok(names.includes('capitalize'), 'should include capitalize from string.js')
    assert.ok(names.includes('lowercase'), 'should include lowercase from string.js')
    assert.ok(names.includes('main'), 'should include main from core.js')
  })

  it('recursively discovers files in subdirectories', async () => {
    const { functions } = await analyzeScope(TMP)
    const names = functions.map(f => f.name)
    assert.ok(names.includes('helper'), 'should include helper from utils/helpers.js')
  })

  it('includes Python functions', async () => {
    const { functions } = await analyzeScope(TMP)
    const names = functions.map(f => f.name)
    assert.ok(names.includes('compute'), 'should include compute from logic.py')
  })

  it('skips node_modules/', async () => {
    const { functions } = await analyzeScope(TMP)
    const names = functions.map(f => f.name)
    assert.ok(!names.includes('externalFn'), 'should NOT include externalFn from node_modules')
  })

  it('skips .git/', async () => {
    const { functions } = await analyzeScope(TMP)
    const names = functions.map(f => f.name)
    assert.ok(!names.includes('gitHook'), 'should NOT include gitHook from .git')
  })

  it('skips dist/', async () => {
    const { functions } = await analyzeScope(TMP)
    const names = functions.map(f => f.name)
    assert.ok(!names.includes('bundled'), 'should NOT include bundled from dist')
  })

  it('aggregates edges from all files', async () => {
    const { edges } = await analyzeScope(TMP)
    // core.js: main calls add, main calls capitalize
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'add'),
      'should have edge from main to add')
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'capitalize'),
      'should have edge from main to capitalize')
  })

  it('sets correct file path on each function', async () => {
    const { functions } = await analyzeScope(TMP)
    const addFn = functions.find(f => f.name === 'add')
    assert.ok(addFn, 'should find add function')
    assert.ok(addFn.file.includes('math.js'), `file should reference math.js, got: ${addFn.file}`)

    const helperFn = functions.find(f => f.name === 'helper')
    assert.ok(helperFn, 'should find helper function')
    assert.ok(helperFn.file.includes('helpers.js'), `file should reference helpers.js, got: ${helperFn.file}`)

    const computeFn = functions.find(f => f.name === 'compute')
    assert.ok(computeFn, 'should find compute function')
    assert.ok(computeFn.file.includes('logic.py'), `file should reference logic.py, got: ${computeFn.file}`)
  })

  it('dedups functions by (name + file)', async () => {
    const { functions } = await analyzeScope(TMP)
    // Count occurrences of each (name, file) pair
    const counts = new Map()
    for (const fn of functions) {
      const key = `${fn.name}::${fn.file}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    for (const [key, count] of counts) {
      assert.equal(count, 1, `function ${key} should appear exactly once, got ${count}`)
    }
  })

  it('return shape is unchanged — { functions, edges }', async () => {
    const result = await analyzeScope(TMP)
    assert.ok(typeof result === 'object', 'result should be an object')
    assert.ok(Array.isArray(result.functions), 'result.functions should be an array')
    assert.ok(Array.isArray(result.edges), 'result.edges should be an array')
    // Verify function shape
    if (result.functions.length > 0) {
      const fn = result.functions[0]
      assert.ok(typeof fn.name === 'string', 'function.name should be a string')
      assert.ok(typeof fn.file === 'string', 'function.file should be a string')
      assert.ok(typeof fn.line === 'number', 'function.line should be a number')
    }
    // Verify edge shape
    if (result.edges.length > 0) {
      const edge = result.edges[0]
      assert.ok(typeof edge.from === 'string', 'edge.from should be a string')
      assert.ok(typeof edge.to === 'string', 'edge.to should be a string')
    }
  })

  it('still works for single file input (backward compat)', async () => {
    const result = await analyzeScope(join(TMP, 'math.js'))
    const names = result.functions.map(f => f.name)
    assert.ok(names.includes('add'), 'should include add')
    assert.ok(names.includes('multiply'), 'should include multiply')
    assert.ok(!names.includes('capitalize'), 'should NOT include capitalize from another file')
  })

  it('empty directory returns empty arrays', async () => {
    const emptyDir = join(TMP, 'empty')
    mkdirSync(emptyDir, { recursive: true })
    const result = await analyzeScope(emptyDir)
    assert.deepEqual(result.functions, [], 'empty dir should return no functions')
    assert.deepEqual(result.edges, [], 'empty dir should return no edges')
  })

  it('nonexistent path returns empty arrays', async () => {
    const result = await analyzeScope('/nonexistent/path/that/does/not/exist')
    assert.deepEqual(result.functions, [], 'nonexistent path should return no functions')
    assert.deepEqual(result.edges, [], 'nonexistent path should return no edges')
  })
})

describe('analyzeScope — directory with same-named functions across files', () => {
  const DEDUP_TMP = resolve(join(process.cwd(), 'tests', '__analyzer_dir_dedup_tmp__'))

  before(() => {
    mkdirSync(DEDUP_TMP, { recursive: true })
    writeFileSync(join(DEDUP_TMP, 'a.js'), `
function process() { return 1 }
`)
    writeFileSync(join(DEDUP_TMP, 'b.js'), `
function process() { return 2 }
`)
  })

  after(() => {
    if (existsSync(DEDUP_TMP)) rmSync(DEDUP_TMP, { recursive: true, force: true })
  })

  it('keeps both functions with the same name from different files', async () => {
    const { functions } = await analyzeScope(DEDUP_TMP)
    const processFns = functions.filter(f => f.name === 'process')
    assert.equal(processFns.length, 2, 'should have 2 process functions from different files')
    const files = processFns.map(f => f.file)
    assert.ok(files.some(f => f.includes('a.js')), 'one should be from a.js')
    assert.ok(files.some(f => f.includes('b.js')), 'one should be from b.js')
  })
})

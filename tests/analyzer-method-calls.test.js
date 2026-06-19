// tests/analyzer-method-calls.test.js — Unit tests for method call edge extraction
//
// Directly tests analyzeScope() to verify that method calls
// (obj.method(), this.helper(), super.init()) produce call edges
// with the method name as the callee. This tests the raw analyzer
// output before install.js filtering.
//
// Run: node --test tests/analyzer-method-calls.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { analyzeScope } from '../scripts/analyzer.js'

const TMP = resolve(join(process.cwd(), 'tests', '__analyzer_method_tmp__'))

function setupFixtures() {
  mkdirSync(TMP, { recursive: true })

  // JS fixture: all method call patterns
  writeFileSync(join(TMP, 'method_calls.js'), `
function helper(x) { return x * 2 }
function init(x) { return x + 1 }
function process(x) { return x - 1 }
function main() {
  this.helper(1)
  super.init(2)
  obj.process(3)
  arr.map(fn)
  helper(5)
}
module.exports = { main, helper, init, process }
`)

  // JS fixture: chained method calls — a.b.c()
  writeFileSync(join(TMP, 'chained.js'), `
function final(x) { return x }
function main() {
  a.b.final(1)
}
module.exports = { main, final }
`)

  // JS fixture: method calls inside class methods
  writeFileSync(join(TMP, 'class_methods.js'), `
class Service {
  helper(x) { return x * 2 }
  run() {
    this.helper(1)
  }
}
module.exports = { Service }
`)

  // Python fixture: method calls via attribute access
  writeFileSync(join(TMP, 'method_calls.py'), `
def helper(x):
    return x * 2

def process(x):
    return x + 1

def main():
    self.helper(1)
    obj.process(2)
    helper(3)
`)

  // JS fixture: only external method calls (no in-file matches)
  writeFileSync(join(TMP, 'external_only.js'), `
function main() {
  console.log("hello")
  arr.map(fn)
  obj.process()
}
module.exports = { main }
`)
}

function cleanupFixtures() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('analyzer method call extraction — JavaScript', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('extracts this.helper() as edge { from: "main", to: "helper" }', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'method_calls.js'))
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'helper'),
      'should have edge from main to helper for this.helper()')
  })

  it('extracts super.init() as edge { from: "main", to: "init" }', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'method_calls.js'))
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'init'),
      'should have edge from main to init for super.init()')
  })

  it('extracts obj.process() as edge { from: "main", to: "process" }', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'method_calls.js'))
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'process'),
      'should have edge from main to process for obj.process()')
  })

  it('extracts arr.map() as edge { from: "main", to: "map" }', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'method_calls.js'))
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'map'),
      'should have edge from main to map for arr.map()')
  })

  it('bare identifier calls still work alongside method calls', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'method_calls.js'))
    // helper(5) is a bare identifier call — should produce an edge too
    const helperEdges = edges.filter(e => e.from === 'main' && e.to === 'helper')
    assert.ok(helperEdges.length >= 1,
      'should have at least one edge from main to helper (bare call)')
  })

  it('extracts method name from chained calls like a.b.final()', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'chained.js'))
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'final'),
      'should have edge from main to final for a.b.final() — only the method name is captured')
  })

  it('extracts method calls inside class method definitions', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'class_methods.js'))
    // class methods show up as method_definition
    assert.ok(functions.some(f => f.name === 'helper'), 'should detect helper method_definition')
    assert.ok(functions.some(f => f.name === 'run'), 'should detect run method_definition')
    // this.helper() inside run() should produce edge { from: "run", to: "helper" }
    assert.ok(edges.some(e => e.from === 'run' && e.to === 'helper'),
      'should have edge from run to helper for this.helper() inside class')
  })

  it('external method calls produce edges (filtering is install.js job)', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'external_only.js'))
    // The analyzer produces edges for ALL calls — install.js filters
    // out non-in-file callees later. Verify raw edges include external methods.
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'log'),
      'should have edge from main to log for console.log()')
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'map'),
      'should have edge from main to map for arr.map()')
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'process'),
      'should have edge from main to process for obj.process()')
  })

  it('return shape unchanged — still { functions, edges }', async () => {
    const result = await analyzeScope(join(TMP, 'method_calls.js'))
    assert.ok(typeof result === 'object', 'result should be an object')
    assert.ok(Array.isArray(result.functions), 'result.functions should be an array')
    assert.ok(Array.isArray(result.edges), 'result.edges should be an array')
  })
})

describe('analyzer method call extraction — Python', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('extracts self.helper() as edge { from: "main", to: "helper" }', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'method_calls.py'))
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'helper'),
      'should have edge from main to helper for self.helper()')
  })

  it('extracts obj.process() as edge { from: "main", to: "process" }', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'method_calls.py'))
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'process'),
      'should have edge from main to process for obj.process()')
  })

  it('bare identifier calls still work in Python alongside attribute calls', async () => {
    const { functions, edges } = await analyzeScope(join(TMP, 'method_calls.py'))
    // helper(3) is a bare identifier call
    assert.ok(edges.some(e => e.from === 'main' && e.to === 'helper'),
      'should have edge from main to helper for bare helper() call')
  })
})

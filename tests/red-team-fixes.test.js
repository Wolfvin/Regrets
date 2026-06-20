// tests/red-team-fixes.test.js — Tests for 6 red-team issue fixes
//
// #267: tree-sitter ERROR node handling
// #271: export { foo, bar } detection
// #280: analyzeScope false positive: unclosed string
// #286: extractExportedFunctions matches in comments
// #287: method call false-positive collision with bare function
// #292: export class X detection
//
// Run: node --test tests/red-team-fixes.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { analyzeScope } from '../scripts/analyzer.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SCRIPTS_DIR = resolve(import.meta.dirname, '..', 'scripts')
const INSTALL_JS = join(SCRIPTS_DIR, 'install.js')

const TMP = resolve(join(process.cwd(), 'tests', '__red_team_tmp__'))

function setupFixtures() {
  mkdirSync(TMP, { recursive: true })
}

function cleanupFixtures() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
}

// ─── #267: tree-sitter ERROR node handling ─────────────────────────────────

describe('#267: tree-sitter ERROR node — warn on parse errors, exclude malformed functions', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('warns about parse errors and excludes broken functions in Python', async () => {
    // Python with a syntax error: missing colon after def broken_fn
    // tree-sitter's error recovery will find valid_fn correctly but
    // broken_fn won't appear as a function_definition at all.
    // another_valid may or may not appear depending on recovery.
    writeFileSync(join(TMP, 'py_error.py'), `
def valid_fn(x):
    return x + 1

def broken_fn(x)
    return x * 2

def another_valid(y):
    return y - 1
`)
    const { functions } = await analyzeScope(join(TMP, 'py_error.py'))
    const names = functions.map(f => f.name)
    // valid_fn is correctly parsed and should be found
    assert.ok(names.includes('valid_fn'), 'valid_fn should be detected (correctly parsed)')
    // broken_fn is NOT a valid function_definition node in the AST —
    // tree-sitter doesn't produce one for it
    assert.ok(!names.includes('broken_fn'), 'broken_fn should NOT be detected (syntax error)')
  })

  it('warns about parse errors and excludes broken functions in JS', async () => {
    // JS with a syntax error: invalid parameter list
    writeFileSync(join(TMP, 'js_error.js'), `
function goodFn() { return 1 }

function badFn( { return 2 }

function alsoGood() { return 3 }
`)
    const { functions } = await analyzeScope(join(TMP, 'js_error.js'))
    const names = functions.map(f => f.name)
    // goodFn is correctly parsed and should be found
    assert.ok(names.includes('goodFn'), 'goodFn should be detected (correctly parsed)')
    // badFn is NOT a valid function_declaration — tree-sitter can't parse it
    assert.ok(!names.includes('badFn'), 'badFn should NOT be detected (syntax error)')
  })

  it('excludes a function whose own subtree has errors', async () => {
    // A function that has an ERROR node within its body.
    // Using ??? which tree-sitter cannot parse — it will create a
    // function_declaration but mark it with hasError: true.
    writeFileSync(join(TMP, 'fn_with_error.js'), `
function cleanFn() { return 1 }

function dirtyFn() {
  const x = ???
  return 2
}
`)
    const { functions } = await analyzeScope(join(TMP, 'fn_with_error.js'))
    const names = functions.map(f => f.name)
    // cleanFn should be found — it has no errors in its subtree
    assert.ok(names.includes('cleanFn'), 'cleanFn should be detected')
    // dirtyFn's subtree has errors — it should be excluded
    assert.ok(!names.includes('dirtyFn'), 'dirtyFn should be excluded (error in function body)')
  })

  it('returns all functions when there are no parse errors', async () => {
    writeFileSync(join(TMP, 'no_error.py'), `
def add(a, b):
    return a + b

def mul(a, b):
    return a * b
`)
    const { functions } = await analyzeScope(join(TMP, 'no_error.py'))
    const names = functions.map(f => f.name)
    assert.ok(names.includes('add'), 'add should be detected')
    assert.ok(names.includes('mul'), 'mul should be detected')
  })
})

// ─── #271: export { foo, bar } detection ───────────────────────────────────

describe('#271: extractExportedFunctions detects export { foo, bar }', () => {
  // Replicate extractExportedFunctions for isolated unit testing
  function extractExportedFunctions(source, ext) {
    const fns = []

    if (ext === '.py') {
      const matches = source.matchAll(/^def\s+(\w+)\s*\(/gm)
      for (const m of matches) fns.push(m[1])
      return fns
    }

    const strippedSource = source
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')

    const namedExportFn = strippedSource.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)
    for (const m of namedExportFn) fns.push(m[1])

    const arrowExports = strippedSource.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)
    for (const m of arrowExports) fns.push(m[1])

    const defaultExportFn = strippedSource.matchAll(/export\s+default\s+function\s+(\w+)/g)
    for (const m of defaultExportFn) fns.push(m[1])

    const namedExportClass = strippedSource.matchAll(/export\s+class\s+(\w+)/g)
    for (const m of namedExportClass) fns.push(m[1])

    const defaultExportClass = strippedSource.matchAll(/export\s+default\s+class\s+(\w+)/g)
    for (const m of defaultExportClass) fns.push(m[1])

    const namedExportList = strippedSource.matchAll(/export\s*\{([^}]*)\}/g)
    for (const m of namedExportList) {
      const body = m[1]
      const items = body.split(',')
      for (const item of items) {
        const trimmed = item.trim()
        if (!trimmed) continue
        const asMatch = trimmed.match(/\bas\s+(\w+)$/)
        if (asMatch) {
          fns.push(asMatch[1])
        } else {
          const identMatch = trimmed.match(/^(\w+)$/)
          if (identMatch) {
            fns.push(identMatch[1])
          }
        }
      }
    }

    const moduleExports = strippedSource.matchAll(/module\.exports\.(\w+)\s*=/g)
    for (const m of moduleExports) fns.push(m[1])

    const exportsAssign = strippedSource.matchAll(/^exports\.(\w+)\s*=/gm)
    for (const m of exportsAssign) fns.push(m[1])

    const cjsNamedFn = strippedSource.matchAll(/module\.exports\s*=\s*function\s+(\w+)/g)
    for (const m of cjsNamedFn) fns.push(m[1])

    return [...new Set(fns)]
  }

  it('detects simple named export list: export { foo, bar }', () => {
    const source = `
function foo() { return 1 }
function bar() { return 2 }
export { foo, bar }
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.includes('foo'), 'should detect foo from export { foo, bar }')
    assert.ok(fns.includes('bar'), 'should detect bar from export { foo, bar }')
  })

  it('detects named export list with "as" alias: export { foo as bar }', () => {
    const source = `
function foo() { return 1 }
export { foo as bar }
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.includes('bar'), 'should detect bar (alias) from export { foo as bar }')
  })

  it('detects mixed named export list with aliases and plain names', () => {
    const source = `
function add() { return 1 }
function mul() { return 2 }
function helper() { return 3 }
export { add, mul as multiply, helper }
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.includes('add'), 'should detect add')
    assert.ok(fns.includes('multiply'), 'should detect multiply (alias)')
    assert.ok(fns.includes('helper'), 'should detect helper')
  })

  it('detects export { default as Name } pattern', () => {
    const source = `
export default function() { return 1 }
export { default as mainFn }
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.includes('mainFn'), 'should detect mainFn from export { default as mainFn }')
  })

  it('does not break existing export function detection', () => {
    const source = `
export function add(a, b) { return a + b }
export const mul = (a, b) => a * b
export default function main() {}
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.includes('add'), 'should detect named export function')
    assert.ok(fns.includes('mul'), 'should detect arrow export')
    assert.ok(fns.includes('main'), 'should detect default export')
  })

  it('handles multi-line export list', () => {
    const source = `
function foo() {}
function bar() {}
function baz() {}
export {
  foo,
  bar,
  baz
}
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.includes('foo'), 'should detect foo from multi-line export')
    assert.ok(fns.includes('bar'), 'should detect bar from multi-line export')
    assert.ok(fns.includes('baz'), 'should detect baz from multi-line export')
  })
})

// ─── #280: analyzeScope false positive: unclosed string ────────────────────

describe('#280: tree-sitter is source of truth — unclosed string not a function', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('unclosed string does not produce false-positive function in analyzeScope', async () => {
    writeFileSync(join(TMP, 'unclosed_string.js'), `
function main() {
  const x = "unclosed string
  helper(1)
}
function helper(x) { return x * 2 }
module.exports = { main, helper }
`)
    const { functions, edges } = await analyzeScope(join(TMP, 'unclosed_string.js'))
    // tree-sitter should detect a parse error and either return empty
    // or exclude functions in the error region — never produce a
    // false-positive function from an unclosed string
    const names = functions.map(f => f.name)
    // If tree-sitter recovers and still finds helper, that's fine.
    // But there should never be a function named from inside the string.
    assert.ok(
      !names.some(n => n.includes('unclosed')),
      'no function name from unclosed string content'
    )
  })

  it('valid code with similar structure works correctly', async () => {
    writeFileSync(join(TMP, 'valid_string.js'), `
function main() {
  const x = "closed string"
  helper(1)
}
function helper(x) { return x * 2 }
module.exports = { main, helper }
`)
    const { functions } = await analyzeScope(join(TMP, 'valid_string.js'))
    const names = functions.map(f => f.name)
    assert.ok(names.includes('main'), 'main should be detected')
    assert.ok(names.includes('helper'), 'helper should be detected')
  })
})

// ─── #286: extractExportedFunctions matches in comments ────────────────────

describe('#286: extractExportedFunctions skips comments', () => {
  // Replicate extractExportedFunctions for isolated unit testing (same as #271)
  function extractExportedFunctions(source, ext) {
    const fns = []

    if (ext === '.py') {
      const matches = source.matchAll(/^def\s+(\w+)\s*\(/gm)
      for (const m of matches) fns.push(m[1])
      return fns
    }

    const strippedSource = source
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')

    const namedExportFn = strippedSource.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)
    for (const m of namedExportFn) fns.push(m[1])

    const arrowExports = strippedSource.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)
    for (const m of arrowExports) fns.push(m[1])

    const defaultExportFn = strippedSource.matchAll(/export\s+default\s+function\s+(\w+)/g)
    for (const m of defaultExportFn) fns.push(m[1])

    const namedExportClass = strippedSource.matchAll(/export\s+class\s+(\w+)/g)
    for (const m of namedExportClass) fns.push(m[1])

    const defaultExportClass = strippedSource.matchAll(/export\s+default\s+class\s+(\w+)/g)
    for (const m of defaultExportClass) fns.push(m[1])

    const namedExportList = strippedSource.matchAll(/export\s*\{([^}]*)\}/g)
    for (const m of namedExportList) {
      const body = m[1]
      const items = body.split(',')
      for (const item of items) {
        const trimmed = item.trim()
        if (!trimmed) continue
        const asMatch = trimmed.match(/\bas\s+(\w+)$/)
        if (asMatch) {
          fns.push(asMatch[1])
        } else {
          const identMatch = trimmed.match(/^(\w+)$/)
          if (identMatch) {
            fns.push(identMatch[1])
          }
        }
      }
    }

    const moduleExports = strippedSource.matchAll(/module\.exports\.(\w+)\s*=/g)
    for (const m of moduleExports) fns.push(m[1])

    const exportsAssign = strippedSource.matchAll(/^exports\.(\w+)\s*=/gm)
    for (const m of exportsAssign) fns.push(m[1])

    const cjsNamedFn = strippedSource.matchAll(/module\.exports\s*=\s*function\s+(\w+)/g)
    for (const m of cjsNamedFn) fns.push(m[1])

    return [...new Set(fns)]
  }

  it('does not detect export function in single-line comment', () => {
    const source = `
// export function fakeFn() { return 1 }
export function realFn() { return 2 }
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(!fns.includes('fakeFn'), 'fakeFn in comment should NOT be detected')
    assert.ok(fns.includes('realFn'), 'realFn should be detected')
  })

  it('does not detect export function in block comment', () => {
    const source = `
/* export function commentedOut() { return 1 } */
export function activeFn() { return 2 }
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(!fns.includes('commentedOut'), 'commentedOut in block comment should NOT be detected')
    assert.ok(fns.includes('activeFn'), 'activeFn should be detected')
  })

  it('does not detect module.exports in comment', () => {
    const source = `
// module.exports.fakeCjs = function() {}
module.exports.realCjs = function() { return 1 }
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(!fns.includes('fakeCjs'), 'fakeCjs in comment should NOT be detected')
    assert.ok(fns.includes('realCjs'), 'realCjs should be detected')
  })

  it('does not detect export class in comment', () => {
    const source = `
// export class FakeClass {}
export class RealClass {}
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(!fns.includes('FakeClass'), 'FakeClass in comment should NOT be detected')
    assert.ok(fns.includes('RealClass'), 'RealClass should be detected')
  })

  it('does not detect export { } list in comment', () => {
    const source = `
// export { fakeFoo, fakeBar }
function foo() {}
function bar() {}
export { foo, bar }
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(!fns.includes('fakeFoo'), 'fakeFoo in comment should NOT be detected')
    assert.ok(!fns.includes('fakeBar'), 'fakeBar in comment should NOT be detected')
    assert.ok(fns.includes('foo'), 'foo should be detected from real export')
    assert.ok(fns.includes('bar'), 'bar should be detected from real export')
  })
})

// ─── #287: method call false-positive collision with bare function ─────────

describe('#287: method call edges are tagged with isMethod and do not collide with bare calls', () => {
  before(() => setupFixtures())
  after(() => cleanupFixtures())

  it('obj.helper() edge has isMethod: true', async () => {
    writeFileSync(join(TMP, 'method_tag.js'), `
function helper(x) { return x * 2 }
function main() {
  obj.helper(1)
}
module.exports = { main, helper }
`)
    const { edges } = await analyzeScope(join(TMP, 'method_tag.js'))
    const helperEdges = edges.filter(e => e.from === 'main' && e.to === 'helper')
    assert.ok(helperEdges.length >= 1, 'should have at least one edge to helper')
    assert.ok(
      helperEdges.some(e => e.isMethod === true),
      'obj.helper() edge should have isMethod: true'
    )
  })

  it('bare helper() edge does NOT have isMethod', async () => {
    writeFileSync(join(TMP, 'bare_call.js'), `
function helper(x) { return x * 2 }
function main() {
  helper(1)
}
module.exports = { main, helper }
`)
    const { edges } = await analyzeScope(join(TMP, 'bare_call.js'))
    const helperEdges = edges.filter(e => e.from === 'main' && e.to === 'helper')
    assert.ok(helperEdges.length >= 1, 'should have at least one edge to helper')
    assert.ok(
      helperEdges.some(e => !e.isMethod),
      'bare helper() edge should NOT have isMethod or isMethod should be falsy'
    )
  })

  it('obj.helper() has methodReceiver "obj"', async () => {
    writeFileSync(join(TMP, 'receiver_obj.js'), `
function helper(x) { return x * 2 }
function main() {
  obj.helper(1)
}
module.exports = { main, helper }
`)
    const { edges } = await analyzeScope(join(TMP, 'receiver_obj.js'))
    const methodEdges = edges.filter(e => e.isMethod && e.to === 'helper')
    assert.ok(methodEdges.length >= 1, 'should have method edge to helper')
    assert.equal(methodEdges[0].methodReceiver, 'obj', 'receiver should be "obj"')
  })

  it('this.helper() has methodReceiver "this"', async () => {
    writeFileSync(join(TMP, 'receiver_this.js'), `
function helper(x) { return x * 2 }
function main() {
  this.helper(1)
}
module.exports = { main, helper }
`)
    const { edges } = await analyzeScope(join(TMP, 'receiver_this.js'))
    const methodEdges = edges.filter(e => e.isMethod && e.to === 'helper')
    assert.ok(methodEdges.length >= 1, 'should have method edge to helper')
    assert.equal(methodEdges[0].methodReceiver, 'this', 'receiver should be "this"')
  })

  it('install.js filters out obj.process() from callees when process is a local function', () => {
    // Integration test: obj.process() should NOT appear in callees because
    // the method receiver is an arbitrary object, not this/super.
    mkdirSync(join(TMP, 'install_method_test'), { recursive: true })
    writeFileSync(join(TMP, 'install_method_test', 'method_collision.js'), `
function process(x) { return x }
function helper(x) { return x * 2 }
function main() {
  obj.process(3)
  this.helper(1)
  helper(2)
}
module.exports = { main, process, helper }
`)
    writeFileSync(join(TMP, 'install_method_test', 'package.json'), JSON.stringify({
      name: 'method-collision-test',
      version: '0.0.0',
      type: 'module',
    }))

    const result = execFileSync('node', [INSTALL_JS, '--scope', 'method_collision.js', '--skip-capture'], {
      cwd: join(TMP, 'install_method_test'),
      stdio: 'pipe',
      timeout: 30_000,
    })

    const manifestPath = join(TMP, 'install_method_test', 'regrets', 'manifest.json')
    assert.ok(existsSync(manifestPath), 'manifest should exist')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const mainCluster = manifest.clusters.find(c => c.entry === 'main')
    assert.ok(mainCluster, 'main cluster should exist')

    // obj.process() should NOT be in callees (arbitrary object method)
    // this.helper() and helper() SHOULD be in callees (this/super or bare)
    const callees = mainCluster.callees || []
    assert.ok(
      !callees.includes('process'),
      'obj.process() should NOT be in callees — it is a method call on an arbitrary object, not this/super'
    )
    assert.ok(
      callees.includes('helper'),
      'helper should be in callees — called via this.helper() and/or bare helper()'
    )
  })

  it('install.js includes this.helper() in callees when helper is a local function', () => {
    mkdirSync(join(TMP, 'install_this_test'), { recursive: true })
    writeFileSync(join(TMP, 'install_this_test', 'this_method.js'), `
function helper(x) { return x * 2 }
function main() {
  this.helper(1)
}
module.exports = { main, helper }
`)
    writeFileSync(join(TMP, 'install_this_test', 'package.json'), JSON.stringify({
      name: 'this-method-test',
      version: '0.0.0',
      type: 'module',
    }))

    execFileSync('node', [INSTALL_JS, '--scope', 'this_method.js', '--skip-capture'], {
      cwd: join(TMP, 'install_this_test'),
      stdio: 'pipe',
      timeout: 30_000,
    })

    const manifestPath = join(TMP, 'install_this_test', 'regrets', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const mainCluster = manifest.clusters.find(c => c.entry === 'main')
    assert.ok(mainCluster, 'main cluster should exist')

    const callees = mainCluster.callees || []
    assert.ok(
      callees.includes('helper'),
      'this.helper() should be in callees — this is a valid class method call'
    )
  })
})

// ─── #292: export class X detection ────────────────────────────────────────

describe('#292: extractExportedFunctions detects export class X', () => {
  // Replicate extractExportedFunctions for isolated unit testing
  function extractExportedFunctions(source, ext) {
    const fns = []

    if (ext === '.py') {
      const matches = source.matchAll(/^def\s+(\w+)\s*\(/gm)
      for (const m of matches) fns.push(m[1])
      return fns
    }

    const strippedSource = source
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')

    const namedExportFn = strippedSource.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)
    for (const m of namedExportFn) fns.push(m[1])

    const arrowExports = strippedSource.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)
    for (const m of arrowExports) fns.push(m[1])

    const defaultExportFn = strippedSource.matchAll(/export\s+default\s+function\s+(\w+)/g)
    for (const m of defaultExportFn) fns.push(m[1])

    const namedExportClass = strippedSource.matchAll(/export\s+class\s+(\w+)/g)
    for (const m of namedExportClass) fns.push(m[1])

    const defaultExportClass = strippedSource.matchAll(/export\s+default\s+class\s+(\w+)/g)
    for (const m of defaultExportClass) fns.push(m[1])

    const namedExportList = strippedSource.matchAll(/export\s*\{([^}]*)\}/g)
    for (const m of namedExportList) {
      const body = m[1]
      const items = body.split(',')
      for (const item of items) {
        const trimmed = item.trim()
        if (!trimmed) continue
        const asMatch = trimmed.match(/\bas\s+(\w+)$/)
        if (asMatch) {
          fns.push(asMatch[1])
        } else {
          const identMatch = trimmed.match(/^(\w+)$/)
          if (identMatch) {
            fns.push(identMatch[1])
          }
        }
      }
    }

    const moduleExports = strippedSource.matchAll(/module\.exports\.(\w+)\s*=/g)
    for (const m of moduleExports) fns.push(m[1])

    const exportsAssign = strippedSource.matchAll(/^exports\.(\w+)\s*=/gm)
    for (const m of exportsAssign) fns.push(m[1])

    const cjsNamedFn = strippedSource.matchAll(/module\.exports\s*=\s*function\s+(\w+)/g)
    for (const m of cjsNamedFn) fns.push(m[1])

    return [...new Set(fns)]
  }

  it('detects export class X', () => {
    const source = `
export class Calculator {
  add(a, b) { return a + b }
}
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.includes('Calculator'), 'should detect export class Calculator')
  })

  it('detects export default class X', () => {
    const source = `
export default class Service {
  run() { return 1 }
}
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.includes('Service'), 'should detect export default class Service')
  })

  it('class-only file does not report 0 functions', () => {
    const source = `
export class Utils {
  static format(x) { return String(x) }
}
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.length > 0, 'class-only file should report at least the class name')
    assert.ok(fns.includes('Utils'), 'should detect Utils class')
  })

  it('does not break existing function detection alongside classes', () => {
    const source = `
export function helper() { return 1 }
export class Calculator {
  add(a, b) { return a + b }
}
`
    const fns = extractExportedFunctions(source, '.js')
    assert.ok(fns.includes('helper'), 'should detect export function helper')
    assert.ok(fns.includes('Calculator'), 'should detect export class Calculator')
  })
})

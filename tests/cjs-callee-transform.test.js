// tests/cjs-callee-transform.test.js — tests for scripts/cjs-callee-transform.js
//
// Verifies that the CJS source transformer (the new module that closes #263):
//   1. Rewrites bare-name internal call sites to go through `__regretsHolder`
//   2. Populates the holder with original function references at the end
//   3. Attaches the holder to `module.exports.__regretsHolder`
//   4. Aborts (returns null) on safety concerns (shadowing, no callees, etc.)
//   5. Leaves `module.exports.foo(...)` calls UNCHANGED (those already work)
//
// Also includes end-to-end integration tests:
//   1. Transformed source can be imported via dynamic import()
//   2. wrapCallees on the transformed module actually intercepts bare-name calls
//   3. Original source file is never modified
//
// Closes #263 — CJS bare-name calls (`foo()` instead of `module.exports.foo()`)
// used to be silently invisible to wrapCallees because the internal call
// resolved to the local binding, not `module.exports.foo`. The misleading
// warning "declared but never called during capture" was the symptom.
//
// Run: node --test tests/cjs-callee-transform.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  isCjsSource,
  transformCjsForCallees,
  HOLDER_NAME,
} from '../scripts/cjs-callee-transform.js'
import { wrapCallees } from '../scripts/ghost.js'
import { mergeCjsModule } from '../scripts/cjs-merge.js'

// ─── isCjsSource ────────────────────────────────────────────────────────────

describe('isCjsSource', () => {
  it('returns true for .cjs regardless of content', () => {
    assert.equal(isCjsSource('console.log(1)', '.cjs'), true)
    assert.equal(isCjsSource('export const x = 1', '.cjs'), true)
  })

  it('returns false for .mjs regardless of content', () => {
    assert.equal(isCjsSource('module.exports = { foo: 1 }', '.mjs'), false)
  })

  it('returns true for .js with CJS syntax (module.exports)', () => {
    assert.equal(isCjsSource('module.exports = { foo: 1 }', '.js'), true)
    assert.equal(isCjsSource('module.exports.foo = function() {}', '.js'), true)
  })

  it('returns true for .js with CJS syntax (exports.X =)', () => {
    assert.equal(isCjsSource('exports.foo = function() {}', '.js'), true)
  })

  it('returns false for .js with ESM syntax (export)', () => {
    assert.equal(isCjsSource('export function foo() {}', '.js'), false)
    assert.equal(isCjsSource('export const x = 1', '.js'), false)
  })

  it('returns false for .js with ESM syntax (import)', () => {
    assert.equal(isCjsSource("import { x } from 'y'\nconsole.log(x)", '.js'), false)
  })

  it('returns true for .js with no ESM/CJS signal (default Node behavior)', () => {
    // No module.exports, no exports.X, no export, no import → default CJS
    assert.equal(isCjsSource('function foo() { return 1 }', '.js'), true)
  })

  it('returns false for unknown extensions', () => {
    assert.equal(isCjsSource('module.exports = {}', '.py'), false)
    assert.equal(isCjsSource('module.exports = {}', '.txt'), false)
  })
})

// ─── transformCjsForCallees — happy path ────────────────────────────────────

describe('transformCjsForCallees — happy path (function declarations)', () => {
  it('rewrites bare-name internal calls to go through __regretsHolder', async () => {
    const source = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.ok(result, 'transform should succeed')
    assert.equal(result.holderName, HOLDER_NAME)

    // Internal call should be rewritten
    assert.ok(
      result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`),
      'internal bare-name call should be rewritten to use holder'
    )

    // The original function declarations should be preserved
    assert.ok(result.transformedSource.includes('function add(a, b)'), 'add declaration preserved')
    assert.ok(result.transformedSource.includes('function main(x)'), 'main declaration preserved')

    // module.exports statement preserved
    assert.ok(result.transformedSource.includes('module.exports = { main, add }'),
      'module.exports statement preserved')

    // The holder should be declared at the top
    assert.ok(
      result.transformedSource.includes(`const ${HOLDER_NAME} = {}`),
      'holder declaration present'
    )
    // The holder should be populated at the end
    assert.ok(
      result.transformedSource.includes(`${HOLDER_NAME}.add = add`),
      'holder populated with add reference'
    )
    // The holder should be attached to module.exports
    assert.ok(
      result.transformedSource.includes(`module.exports.${HOLDER_NAME} = ${HOLDER_NAME}`),
      'holder attached to module.exports'
    )
  })

  it('handles multiple callees', async () => {
    const source = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, mul(x, 2)) }
module.exports = { main, add, mul }
`
    const result = await transformCjsForCallees(source, ['add', 'mul'], '.cjs')
    assert.ok(result)

    // Both callees should be rewritten
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add(x,`))
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.mul(x, 2)`))

    // Both should be on the holder
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add = add`))
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.mul = mul`))
  })

  it('does NOT rewrite `module.exports.foo(...)` calls (those already work)', async () => {
    // This is the key CJS invariant: if the user already uses the explicit
    // `module.exports.foo(...)` idiom, wrapCallees can intercept WITHOUT
    // source transformation. The transformer should leave those calls alone.
    const source = `
function add(a, b) { return a + b }
function main(x) { return module.exports.add(x, 1) }
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    // No bare-name calls → transform aborts (returns null) — correct.
    assert.equal(result, null,
      'should abort when there are no bare-name calls to rewrite (module.exports.foo already works)')
  })

  it('handles mixed bare-name + module.exports.foo calls (only rewrites bare-name)', async () => {
    const source = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) + module.exports.add(x, 2) }
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.ok(result, 'transform should succeed (bare-name call exists)')
    // The bare call should be rewritten
    assert.ok(
      result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`),
      'bare-name call should be rewritten to use holder'
    )
    // The module.exports call should NOT be rewritten
    assert.ok(
      result.transformedSource.includes('module.exports.add(x, 2)'),
      'module.exports.add call should NOT be rewritten (it already works)'
    )
  })

  it('only rewrites calls inside function bodies, not top-level calls', async () => {
    const source = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
const topLevelResult = add(1, 2)
module.exports = { main, add, topLevelResult }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.ok(result)

    // Top-level call should NOT be rewritten (preserves module-eval semantics)
    assert.ok(
      result.transformedSource.includes('const topLevelResult = add(1, 2)'),
      'top-level call should NOT be rewritten'
    )

    // Internal call should be rewritten
    assert.ok(
      result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`),
      'internal call should be rewritten'
    )
  })
})

describe('transformCjsForCallees — happy path (const arrow / function expressions)', () => {
  it('rewrites bare-name calls when callee is `const add = () => ...`', async () => {
    const source = `
const add = (a, b) => a + b
const main = (x) => add(x, 1)
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.ok(result, 'transform should succeed for const arrow callee')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`), 'internal call rewritten')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add = add`), 'holder populated')
    // The const declaration stays in place (no export stripping needed for CJS)
    assert.ok(result.transformedSource.includes('const add = (a, b) => a + b'), 'const arrow preserved')
  })

  it('rewrites bare-name calls when callee is `const add = function() {}`', async () => {
    const source = `
const add = function(a, b) { return a + b }
const main = function(x) { return add(x, 1) }
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.ok(result, 'transform should succeed for const function-expression callee')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`), 'internal call rewritten')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add = add`), 'holder populated')
    assert.ok(result.transformedSource.includes('const add = function(a, b)'), 'function expression preserved')
  })

  it('handles `let` and `var` declarations too', async () => {
    const source = `
var add = function(a, b) { return a + b }
let main = (x) => add(x, 1)
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.ok(result, 'transform should succeed for var/let function-bearing declarations')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`), 'internal call rewritten')
  })
})

// ─── transformCjsForCallees — safety aborts ─────────────────────────────────

describe('transformCjsForCallees — safety aborts', () => {
  it('returns null when callees array is empty', async () => {
    const result = await transformCjsForCallees('function foo() {}', [], '.cjs')
    assert.equal(result, null)
  })

  it('returns null when callees array is null', async () => {
    const result = await transformCjsForCallees('function foo() {}', null, '.cjs')
    assert.equal(result, null)
  })

  it('returns null when callee is a class method (not top-level)', async () => {
    const source = `
class Calculator {
  add(a, b) { return a + b }
  main(x) { return this.add(x, 1) }
}
module.exports = { Calculator }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    // `add` is a class method, not a top-level function declaration
    assert.equal(result, null, 'should abort — class methods are not transformable')
  })

  it('returns null when callee is shadowed by a function parameter', async () => {
    const source = `
function add(a, b) { return a + b }
function main(add) { return add(1, 2) }
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.equal(result, null, 'should abort on parameter shadowing')
  })

  it('returns null when callee is shadowed by inner let/const', async () => {
    const source = `
function add(a, b) { return a + b }
function main() {
  const add = (x, y) => x - y
  return add(1, 2)
}
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.equal(result, null, 'should abort on inner let/const shadowing')
  })

  it('returns null when callee is shadowed by destructuring parameter', async () => {
    const source = `
function add(a, b) { return a + b }
function main({ add }) { return add(1, 2) }
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.equal(result, null, 'should abort on destructuring parameter shadowing')
  })

  it('returns null when there are no bare-name calls to rewrite', async () => {
    // The user uses `module.exports.foo(...)` exclusively — no transform needed.
    const source = `
function add(a, b) { return a + b }
function main(x) { return module.exports.add(x, 1) }
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.equal(result, null, 'should abort when there are no bare-name calls to rewrite')
  })

  it('returns null when callee is a non-function variable', async () => {
    // `add` is a number, not a function — the call `add(1, 2)` would throw
    // at runtime, but tree-sitter parses it fine. We abort because the
    // callee name is shadowed by a non-function declaration.
    const source = `
const add = 42
function main() { return add(1, 2) }
module.exports = { main, add }
`
    const result = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.equal(result, null, 'should abort when callee name is a non-function variable')
  })
})

// ─── End-to-end integration: transform → import → wrapCallees ──────────────

describe('E2E: transform → import → wrapCallees intercepts bare-name callee (CJS)', () => {
  let tmpDir

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'regrets-cjs-transform-'))
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('intercepts bare-name callee in a transformed CJS module (function declarations)', async () => {
    const source = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, mul(x, 2)) }
module.exports = { main, add, mul }
`
    const fixturePath = join(tmpDir, 'fixture.cjs')
    writeFileSync(fixturePath, source, 'utf8')

    const transformResult = await transformCjsForCallees(source, ['add', 'mul'], '.cjs')
    assert.ok(transformResult)

    const tempPath = join(tmpDir, '.regrets-tmp-test.cjs')
    writeFileSync(tempPath, transformResult.transformedSource, 'utf8')

    try {
      let mod = await import(pathToFileURL(tempPath).href)
      mod = mergeCjsModule(mod)

      // The holder should be accessible
      assert.ok(mod.default?.[HOLDER_NAME] || mod[HOLDER_NAME], 'holder should be accessible on the imported module')

      // Before wrapping: calling main should produce expected result
      // main(3) = add(3, mul(3, 2)) = add(3, 6) = 9
      assert.equal(mod.main(3), 9)

      const recorder = []
      const cleanup = wrapCallees(mod, ['add', 'mul'], recorder, {
        parentClusterId: 'main',
        quiet: true,
      })

      try {
        const result = mod.main(3)
        assert.equal(result, 9, 'main return value passes through')
        // mul is called first (innermost), then add
        assert.equal(recorder.length, 2, 'both callees intercepted')
        assert.equal(recorder[0].fn, 'mul')
        assert.deepEqual(recorder[0].args, [3, 2])
        assert.equal(recorder[0].result, 6)
        assert.equal(recorder[1].fn, 'add')
        assert.deepEqual(recorder[1].args, [3, 6])
        assert.equal(recorder[1].result, 9)
      } finally {
        cleanup()
      }

      // After cleanup, mod.main should still work normally
      // main(10) = add(10, mul(10, 2)) = add(10, 20) = 30
      assert.equal(mod.main(10), 30)
    } finally {
      try { rmSync(tempPath, { force: true }) } catch {}
    }

    // Verify the ORIGINAL source file was never modified
    const originalAfter = readFileSync(fixturePath, 'utf8')
    assert.equal(originalAfter, source, 'original source file must not be modified')
  })

  it('intercepts bare-name callee in a CJS module with const arrow functions', async () => {
    const source = `
const add = (a, b) => a + b
const main = (x) => add(x, 1)
module.exports = { main, add }
`
    const tempPath = join(tmpDir, '.regrets-tmp-const-arrow.cjs')
    const transformResult = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.ok(transformResult)
    writeFileSync(tempPath, transformResult.transformedSource, 'utf8')

    try {
      let mod = await import(pathToFileURL(tempPath).href)
      mod = mergeCjsModule(mod)
      const recorder = []
      const cleanup = wrapCallees(mod, ['add'], recorder, {
        parentClusterId: 'main',
        quiet: true,
      })

      try {
        const result = mod.main(41)
        assert.equal(result, 42)
        assert.equal(recorder.length, 1)
        assert.equal(recorder[0].fn, 'add')
        assert.deepEqual(recorder[0].args, [41, 1])
        assert.equal(recorder[0].result, 42)
      } finally {
        cleanup()
      }
    } finally {
      try { rmSync(tempPath, { force: true }) } catch {}
    }
  })

  it('records errors from wrapped bare-name callees in CJS', async () => {
    const source = `
function boom() { throw new Error('kaboom') }
function main() { return boom() }
module.exports = { main, boom }
`
    const tempPath = join(tmpDir, '.regrets-tmp-throw.cjs')
    const transformResult = await transformCjsForCallees(source, ['boom'], '.cjs')
    assert.ok(transformResult)
    writeFileSync(tempPath, transformResult.transformedSource, 'utf8')

    try {
      let mod = await import(pathToFileURL(tempPath).href)
      mod = mergeCjsModule(mod)
      const recorder = []
      const cleanup = wrapCallees(mod, ['boom'], recorder, {
        parentClusterId: 'main',
        quiet: true,
      })

      try {
        assert.throws(() => mod.main(), { message: 'kaboom' })
        assert.equal(recorder.length, 1)
        assert.ok(recorder[0].error.includes('kaboom'))
      } finally {
        cleanup()
      }
    } finally {
      try { rmSync(tempPath, { force: true }) } catch {}
    }
  })

  it('preserves relative requires in transformed CJS module', async () => {
    // Write a helper CJS module that the fixture requires
    writeFileSync(join(tmpDir, 'helper.cjs'), `
module.exports.double = function(x) { return x * 2 }
`, 'utf8')

    const source = `
const { double } = require('./helper.cjs')
function add(a, b) { return a + b }
function main(x) { return add(double(x), 1) }
module.exports = { main, add }
`
    const tempPath = join(tmpDir, '.regrets-tmp-require.cjs')
    const transformResult = await transformCjsForCallees(source, ['add'], '.cjs')
    assert.ok(transformResult)
    writeFileSync(tempPath, transformResult.transformedSource, 'utf8')

    try {
      let mod = await import(pathToFileURL(tempPath).href)
      mod = mergeCjsModule(mod)
      const recorder = []
      const cleanup = wrapCallees(mod, ['add'], recorder, {
        parentClusterId: 'main',
        quiet: true,
      })

      try {
        // main(3) = add(double(3), 1) = add(6, 1) = 7
        const result = mod.main(3)
        assert.equal(result, 7)
        assert.equal(recorder.length, 1)
        assert.deepEqual(recorder[0].args, [6, 1])
        assert.equal(recorder[0].result, 7)
      } finally {
        cleanup()
      }
    } finally {
      try { rmSync(tempPath, { force: true }) } catch {}
    }
  })
})

// ─── E2E: ESM not touched (sanity check) ────────────────────────────────────

describe('E2E: ESM modules are not transformed by the CJS transformer', () => {
  it('isCjsSource returns false for ESM, so CJS transform is never attempted', () => {
    const esmSource = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }
`
    assert.equal(isCjsSource(esmSource, '.mjs'), false)
    assert.equal(isCjsSource(esmSource, '.js'), false) // export → ESM heuristic
  })
})

// tests/esm-callee-transform.test.js — tests for scripts/esm-callee-transform.js
//
// Verifies that the ESM source transformer:
//   1. Rewrites internal call sites to go through `__regretsHolder`
//   2. Populates the holder with original function references
//   3. Exports the holder so wrapCallees can reassign entries
//   4. Aborts (returns null) on safety concerns (shadowing, no callees, etc.)
//   5. Leaves CJS sources untouched
//
// Also includes end-to-end integration tests:
//   1. Transformed source can be imported via dynamic import()
//   2. wrapCallees on the transformed module actually intercepts calls
//   3. Original source file is never modified
//
// Run: node --test tests/esm-callee-transform.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  isEsmSource,
  transformEsmForCallees,
  HOLDER_NAME,
  registerEsmTempFile,
  deleteEsmTempFile,
  cleanupAllEsmTempFiles,
  generateEsmTempFileName,
} from '../scripts/esm-callee-transform.js'
import { wrapCallees } from '../scripts/ghost.js'

// ─── isEsmSource ────────────────────────────────────────────────────────────

describe('isEsmSource', () => {
  it('returns true for .mjs regardless of content', () => {
    assert.equal(isEsmSource('console.log(1)', '.mjs'), true)
  })

  it('returns false for .cjs regardless of content', () => {
    assert.equal(isEsmSource('export const x = 1', '.cjs'), false)
  })

  it('returns true for .js with ESM syntax (export)', () => {
    assert.equal(isEsmSource('export function foo() {}', '.js'), true)
    assert.equal(isEsmSource('export const x = 1', '.js'), true)
    assert.equal(isEsmSource('export default function() {}', '.js'), true)
  })

  it('returns true for .js with ESM syntax (import)', () => {
    assert.equal(isEsmSource("import { x } from 'y'\nconsole.log(x)", '.js'), true)
  })

  it('returns false for .js with CJS syntax (module.exports)', () => {
    assert.equal(isEsmSource('module.exports = { foo: 1 }', '.js'), false)
    assert.equal(isEsmSource('module.exports.foo = function() {}', '.js'), false)
  })

  it('returns false for .js with CJS syntax (exports.X =)', () => {
    assert.equal(isEsmSource('exports.foo = function() {}', '.js'), false)
  })

  it('returns false for unknown extensions', () => {
    assert.equal(isEsmSource('export const x = 1', '.py'), false)
    assert.equal(isEsmSource('export const x = 1', '.txt'), false)
  })

  it('returns true for .ts with ESM syntax', () => {
    assert.equal(isEsmSource('export function foo(x: number): number { return x }', '.ts'), true)
  })
})

// ─── transformEsmForCallees — happy path ────────────────────────────────────

describe('transformEsmForCallees — happy path', () => {
  it('rewrites internal calls to go through __regretsHolder', async () => {
    const source = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(result, 'transform should succeed')
    assert.equal(result.holderName, HOLDER_NAME)

    // The internal call should be rewritten
    assert.ok(
      result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`),
      'internal call should be rewritten to use holder'
    )

    // The original function declarations should be preserved
    assert.ok(result.transformedSource.includes('function add(a, b)'), 'add declaration preserved')
    assert.ok(result.transformedSource.includes('function main(x)'), 'main declaration preserved')

    // The holder should be declared and populated
    assert.ok(
      result.transformedSource.includes(`const ${HOLDER_NAME} = {}`),
      'holder declaration present'
    )
    assert.ok(
      result.transformedSource.includes(`${HOLDER_NAME}.add = add`),
      'holder populated with add reference'
    )

    // The holder should be exported
    assert.ok(
      result.transformedSource.includes(`export { ${HOLDER_NAME} }`),
      'holder exported'
    )
  })

  it('handles multiple callees', async () => {
    const source = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, mul(x, 2)) }
export { main, add, mul }
`
    const result = await transformEsmForCallees(source, ['add', 'mul'], '.mjs')
    assert.ok(result)

    // Both callees should be rewritten
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add(x,`))
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.mul(x, 2)`))

    // Both should be on the holder
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add = add`))
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.mul = mul`))
  })

  it('only rewrites calls inside function bodies, not top-level calls', async () => {
    const source = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
const topLevelResult = add(1, 2)
export { main, add, topLevelResult }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
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

  it('preserves async and generator function declarations', async () => {
    const source = `
async function fetchData(url) { return fetch(url) }
function* gen() { yield 1 }
function main(url) { return fetchData(url) }
export { main, fetchData, gen }
`
    const result = await transformEsmForCallees(source, ['fetchData'], '.mjs')
    assert.ok(result)
    assert.ok(result.transformedSource.includes('async function fetchData'))
    assert.ok(result.transformedSource.includes('function* gen'))
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.fetchData(url)`))
  })

  it('does not rewrite member calls (obj.method())', async () => {
    // Include both a bare call (add(x, 1)) and a member call (obj.add(1, 2)).
    // The bare call should be rewritten; the member call should NOT.
    const source = `
function add(a, b) { return a + b }
function main(obj) { return add(obj.x, 1) + obj.add(1, 2) }
export { main, add }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(result, 'transform should succeed (bare call exists)')
    // The bare call should be rewritten
    assert.ok(
      result.transformedSource.includes(`${HOLDER_NAME}.add(obj.x, 1)`),
      'bare call should be rewritten to use holder'
    )
    // The member call should NOT be rewritten
    assert.ok(
      result.transformedSource.includes('obj.add(1, 2)'),
      'member call should NOT be rewritten'
    )
  })

  it('handles imports correctly (holder is inserted after imports)', async () => {
    const source = `
import { readFile } from 'fs'
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(result)

    // Holder should be declared AFTER the import (so it doesn't break import ordering)
    const holderIdx = result.transformedSource.indexOf(`const ${HOLDER_NAME} = {}`)
    const importIdx = result.transformedSource.indexOf("import { readFile } from 'fs'")
    assert.ok(importIdx < holderIdx, 'holder should be declared after imports')
  })
})

// ─── transformEsmForCallees — safety checks ─────────────────────────────────

describe('transformEsmForCallees — safety aborts', () => {
  it('returns null when callees array is empty', async () => {
    const result = await transformEsmForCallees('function foo() {}', [], '.mjs')
    assert.equal(result, null)
  })

  it('returns null when callees array is null', async () => {
    const result = await transformEsmForCallees('function foo() {}', null, '.mjs')
    assert.equal(result, null)
  })

  it('returns null when no top-level function_declaration matches a callee', async () => {
    const source = `
const add = (a, b) => a + b  // arrow function, not function_declaration
function main(x) { return add(x, 1) }
export { main, add }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    // add is not a function_declaration, so transformation should abort
    assert.equal(result, null, 'should abort when callee is not a function_declaration')
  })

  it('returns null when a callee name is shadowed by a function parameter', async () => {
    const source = `
function add(a, b) { return a + b }
function main(add) { return add(1, 2) }  // 'add' is shadowed by parameter
export { main, add }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.equal(result, null, 'should abort on parameter shadowing')
  })

  it('returns null when a callee name is shadowed by a destructuring parameter', async () => {
    const source = `
function add(a, b) { return a + b }
function main({ add }) { return add(1, 2) }  // 'add' shadowed by destructuring
export { main, add }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.equal(result, null, 'should abort on destructuring parameter shadowing')
  })

  it('returns null when a callee name is shadowed by a non-function let/const', async () => {
    const source = `
function add(a, b) { return a + b }
function main() {
  const add = (x, y) => x - y  // shadowing!
  return add(1, 2)
}
export { main, add }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.equal(result, null, 'should abort on inner let/const shadowing')
  })

  it('returns null when there are no internal calls to rewrite', async () => {
    const source = `
function add(a, b) { return a + b }
function main(x) { return x + 1 }  // doesn't call add
export { main, add }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.equal(result, null, 'should abort when there are no calls to rewrite')
  })

  it('does not abort when a callee name is also a function-bearing const', async () => {
    // This is the legitimate case: `const add = () => ...` is the actual definition
    // But it's NOT a function_declaration, so we still abort because we can't
    // transform arrow function exports (only function declarations).
    const source = `
const add = (a, b) => a + b
function main(x) { return add(x, 1) }
export { main, add }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    // Aborts because `add` is not a function_declaration
    assert.equal(result, null)
  })
})

// ─── End-to-end integration: transform + import + wrapCallees ──────────────

describe('E2E: transform → import → wrapCallees intercepts bare-name callee', () => {
  let tmpDir

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'regrets-esm-transform-'))
  })

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('intercepts bare-name callee calls in a transformed ESM module', async () => {
    // Write an ESM fixture with bare-name function declarations
    const source = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main, add }
`
    const fixturePath = join(tmpDir, 'fixture.mjs')
    writeFileSync(fixturePath, source, 'utf8')

    // Transform the source
    const transformResult = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(transformResult, 'transform should succeed')

    // Write transformed source to a temp file in the SAME directory
    // (mirrors what capture.js does — temp file in same dir for relative imports)
    const tempPath = join(tmpDir, '.regrets-tmp-test.mjs')
    writeFileSync(tempPath, transformResult.transformedSource, 'utf8')

    try {
      // Import the transformed module
      const mod = await import(pathToFileURL(tempPath).href)

      // The holder should be exported
      assert.ok(mod[HOLDER_NAME], 'holder should be exported')
      assert.equal(typeof mod[HOLDER_NAME].add, 'function', 'holder.add should be a function')

      // Before wrapping: calling main should produce expected result
      assert.equal(mod.main(5), 6)

      // Now wrapCallees on the module — should intercept add() calls
      const recorder = []
      const cleanup = wrapCallees(mod, ['add'], recorder, {
        parentClusterId: 'main',
        quiet: true,
      })

      try {
        const result = mod.main(41)
        assert.equal(result, 42, 'main return value passes through')
        assert.equal(recorder.length, 1, 'add() should be intercepted exactly once')
        assert.equal(recorder[0].fn, 'add')
        assert.deepEqual(recorder[0].args, [41, 1])
        assert.equal(recorder[0].result, 42)
        assert.equal(recorder[0].parentClusterId, 'main')
      } finally {
        cleanup()
      }

      // After cleanup, add should no longer be wrapped — but the holder
      // entry is restored to the original add function, so calls still work
      assert.equal(mod.main(10), 11)
    } finally {
      // Cleanup temp file
      try { rmSync(tempPath, { force: true }) } catch {}
    }

    // Verify the ORIGINAL source file was never modified
    const originalAfter = readFileSync(fixturePath, 'utf8')
    assert.equal(originalAfter, source, 'original source file must not be modified')
  })

  it('intercepts multiple callees in a transformed ESM module', async () => {
    const source = `
function add(a, b) { return a + b }
function mul(a, b) { return a * b }
function main(x) { return add(x, mul(x, 2)) }
export { main, add, mul }
`
    const tempPath = join(tmpDir, '.regrets-tmp-multi.mjs')
    const transformResult = await transformEsmForCallees(source, ['add', 'mul'], '.mjs')
    assert.ok(transformResult)
    writeFileSync(tempPath, transformResult.transformedSource, 'utf8')

    try {
      const mod = await import(pathToFileURL(tempPath).href + '?v=1')
      const recorder = []
      const cleanup = wrapCallees(mod, ['add', 'mul'], recorder, {
        parentClusterId: 'main',
        quiet: true,
      })

      try {
        // main(3) = add(3, mul(3, 2)) = add(3, 6) = 9
        const result = mod.main(3)
        assert.equal(result, 9)
        // mul is called first (innermost), then add
        assert.equal(recorder.length, 2)
        assert.equal(recorder[0].fn, 'mul')
        assert.deepEqual(recorder[0].args, [3, 2])
        assert.equal(recorder[0].result, 6)
        assert.equal(recorder[1].fn, 'add')
        assert.deepEqual(recorder[1].args, [3, 6])
        assert.equal(recorder[1].result, 9)
      } finally {
        cleanup()
      }
    } finally {
      try { rmSync(tempPath, { force: true }) } catch {}
    }
  })

  it('handles async callees in transformed ESM', async () => {
    const source = `
async function fetchData(url) { return 'response:' + url }
async function main(url) { return await fetchData(url) }
export { main, fetchData }
`
    const tempPath = join(tmpDir, '.regrets-tmp-async.mjs')
    const transformResult = await transformEsmForCallees(source, ['fetchData'], '.mjs')
    assert.ok(transformResult)
    writeFileSync(tempPath, transformResult.transformedSource, 'utf8')

    try {
      const mod = await import(pathToFileURL(tempPath).href + '?v=1')
      const recorder = []
      const cleanup = wrapCallees(mod, ['fetchData'], recorder, {
        parentClusterId: 'main',
        quiet: true,
      })

      try {
        const result = await mod.main('http://test')
        assert.equal(result, 'response:http://test')
        assert.equal(recorder.length, 1)
        assert.equal(recorder[0].fn, 'fetchData')
        assert.deepEqual(recorder[0].args, ['http://test'])
        assert.equal(recorder[0].result, 'response:http://test')
      } finally {
        cleanup()
      }
    } finally {
      try { rmSync(tempPath, { force: true }) } catch {}
    }
  })

  it('records errors from wrapped bare-name callees', async () => {
    const source = `
function boom() { throw new Error('kaboom') }
function main() { return boom() }
export { main, boom }
`
    const tempPath = join(tmpDir, '.regrets-tmp-throw.mjs')
    const transformResult = await transformEsmForCallees(source, ['boom'], '.mjs')
    assert.ok(transformResult)
    writeFileSync(tempPath, transformResult.transformedSource, 'utf8')

    try {
      const mod = await import(pathToFileURL(tempPath).href + '?v=1')
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

  it('preserves relative imports in transformed module', async () => {
    // Write a helper module that the fixture imports
    const helperSource = `
export function double(x) { return x * 2 }
`
    writeFileSync(join(tmpDir, 'helper.mjs'), helperSource, 'utf8')

    const source = `
import { double } from './helper.mjs'
function add(a, b) { return a + b }
function main(x) { return add(double(x), 1) }
export { main, add }
`
    const tempPath = join(tmpDir, '.regrets-tmp-imports.mjs')
    const transformResult = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(transformResult)
    writeFileSync(tempPath, transformResult.transformedSource, 'utf8')

    try {
      const mod = await import(pathToFileURL(tempPath).href + '?v=1')
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

// ─── E2E: CJS not touched ───────────────────────────────────────────────────

describe('E2E: CJS modules are not transformed', () => {
  it('isEsmSource returns false for CJS, so transform is never attempted', () => {
    const cjsSource = `
function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
module.exports = { main, add }
`
    assert.equal(isEsmSource(cjsSource, '.cjs'), false)
    assert.equal(isEsmSource(cjsSource, '.js'), false) // module.exports → CJS heuristic
  })

  it('CJS module.exports wrapping still works without transformation', async () => {
    // This is the existing CJS path — verify it's unchanged.
    // The test mirrors the existing wrapCallees test for CJS-style modules.
    const liveExports = {
      add: (a, b) => a + b,
      main: function (x) { return liveExports.add(x, 1) },
    }
    const mod = { default: liveExports, add: liveExports.add, main: liveExports.main }
    const recorder = []
    const cleanup = wrapCallees(mod, ['add'], recorder, { parentClusterId: 'main', quiet: true })
    try {
      const result = mod.main(41)
      assert.equal(result, 42)
      assert.equal(recorder.length, 1)
      assert.equal(recorder[0].fn, 'add')
    } finally {
      cleanup()
    }
  })
})

// ─── New patterns: export function, export const arrow/function ────────────
//
// Closes #262 (export function foo() {}) and #276 (export const foo = () => {}).
// These patterns are the most common ESM idioms in real-world code and used
// to be silently skipped by the transformer.

describe('transformEsmForCallees — export function foo() (issue #262)', () => {
  it('transforms `export function foo() {}` — the most common ESM idiom', async () => {
    const source = `
export function add(a, b) { return a + b }
export function main(x) { return add(x, 1) }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(result, 'transform should succeed for `export function foo()`')

    // Internal call should be rewritten
    assert.ok(
      result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`),
      'internal call should be rewritten to use holder'
    )

    // The export function declarations should be preserved in place
    assert.ok(result.transformedSource.includes('export function add(a, b)'), 'add declaration preserved')
    assert.ok(result.transformedSource.includes('export function main(x)'), 'main declaration preserved')

    // Holder declared + populated + exported
    assert.ok(result.transformedSource.includes(`const ${HOLDER_NAME} = {}`), 'holder declaration present')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add = add`), 'holder populated with add reference')
    assert.ok(result.transformedSource.includes(`export { ${HOLDER_NAME} }`), 'holder exported')
  })

  it('transforms `export async function foo() {}`', async () => {
    const source = `
export async function fetchData(url) { return 'response:' + url }
export async function main(url) { return await fetchData(url) }
`
    const result = await transformEsmForCallees(source, ['fetchData'], '.mjs')
    assert.ok(result, 'transform should succeed for `export async function foo()`')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.fetchData(url)`), 'internal call rewritten')
    assert.ok(result.transformedSource.includes('export async function fetchData'), 'declaration preserved')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.fetchData = fetchData`), 'holder populated')
  })

  it('transforms `export function* foo() {}` (generator)', async () => {
    const source = `
export function* gen() { yield 1; yield 2 }
export function main() { return [...gen()] }
`
    const result = await transformEsmForCallees(source, ['gen'], '.mjs')
    assert.ok(result, 'transform should succeed for `export function* foo()`')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.gen()`), 'internal call rewritten')
    assert.ok(result.transformedSource.includes('export function* gen'), 'declaration preserved')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.gen = gen`), 'holder populated')
  })

  it('handles mixed: `export function foo` + bare `function main` + `export { main }`', async () => {
    const source = `
export function add(a, b) { return a + b }
function main(x) { return add(x, 1) }
export { main }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(result, 'mixed export patterns should work')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`), 'internal call rewritten')
    assert.ok(result.transformedSource.includes('export function add'), 'export function preserved')
    assert.ok(result.transformedSource.includes('function main'), 'bare function preserved')
    assert.ok(result.transformedSource.includes('export { main }'), 'bare export preserved')
  })

  it('E2E: intercepts bare-name callee in `export function foo()` module', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'regrets-esm-export-fn-'))
    try {
      const source = `
export function add(a, b) { return a + b }
export function main(x) { return add(x, 1) }
`
      const transformResult = await transformEsmForCallees(source, ['add'], '.mjs')
      assert.ok(transformResult)
      const tempPath = join(tmpDir, '.regrets-tmp-export-fn.mjs')
      writeFileSync(tempPath, transformResult.transformedSource, 'utf8')
      try {
        const mod = await import(pathToFileURL(tempPath).href)
        assert.equal(mod.main(5), 6, 'main return value correct without wrap')

        const recorder = []
        const cleanup = wrapCallees(mod, ['add'], recorder, { parentClusterId: 'main', quiet: true })
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
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  })
})

describe('transformEsmForCallees — export const foo = () => {} (issue #276)', () => {
  it('transforms `export const foo = () => {}` (arrow function)', async () => {
    const source = `
export const add = (a, b) => a + b
export const main = (x) => add(x, 1)
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(result, 'transform should succeed for `export const foo = () => {}`')

    // Internal call should be rewritten
    assert.ok(
      result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`),
      'internal call should be rewritten to use holder'
    )

    // The `export` keyword should be stripped from the callee declaration,
    // turning `export const add = ...` into `const add = ...`
    assert.ok(result.transformedSource.includes('const add = (a, b) => a + b'), 'add declaration kept (export stripped)')
    assert.ok(!result.transformedSource.match(/export\s+const\s+add\s*=/), 'export keyword removed from add')

    // The `export` keyword should be preserved for non-callee declarations
    assert.ok(result.transformedSource.includes('export const main ='), 'main export preserved (we did not strip it)')

    // Holder declared + populated + callee re-exported via trailing export list
    assert.ok(result.transformedSource.includes(`const ${HOLDER_NAME} = {}`), 'holder declaration present')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add = add`), 'holder populated with add reference')
    assert.ok(
      result.transformedSource.includes(`export { ${HOLDER_NAME}, add }`),
      'holder AND add re-exported via trailing export list'
    )
  })

  it('transforms `export const foo = function() {}` (function expression)', async () => {
    const source = `
export const add = function(a, b) { return a + b }
export const main = function(x) { return add(x, 1) }
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(result, 'transform should succeed for `export const foo = function() {}`')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add(x, 1)`), 'internal call rewritten')
    assert.ok(result.transformedSource.includes('const add = function(a, b)'), 'function expression declaration kept (export stripped)')
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add = add`), 'holder populated')
    assert.ok(result.transformedSource.includes(`export { ${HOLDER_NAME}, add }`), 'trailing export list includes add')
  })

  it('does NOT strip export from non-callee `export const` declarations', async () => {
    // The user declares both `add` (callee) and `mul` (NOT a callee).
    // We should only strip `export` from `add`, not from `mul`.
    const source = `
export const add = (a, b) => a + b
export const mul = (a, b) => a * b
export const main = (x) => add(x, mul(x, 2))
`
    const result = await transformEsmForCallees(source, ['add'], '.mjs')
    assert.ok(result)
    // add's export stripped
    assert.ok(result.transformedSource.includes('const add = (a, b) => a + b'))
    assert.ok(!result.transformedSource.match(/export\s+const\s+add\s*=/))
    // mul's export PRESERVED (we didn't ask to transform mul)
    assert.ok(result.transformedSource.includes('export const mul = (a, b) => a * b'),
      'mul (non-callee) export should NOT be stripped')
    // main's export PRESERVED
    assert.ok(result.transformedSource.includes('export const main ='),
      'main (non-callee) export should NOT be stripped')
    // Only `add` (callee) is in the trailing re-export list alongside the holder
    assert.ok(result.transformedSource.includes(`export { ${HOLDER_NAME}, add }`),
      'trailing export list should contain only holder + callee names whose export we stripped')
  })

  it('E2E: intercepts bare-name callee in `export const foo = () => {}` module', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'regrets-esm-export-const-arrow-'))
    try {
      const source = `
export const add = (a, b) => a + b
export const main = (x) => add(x, 1)
`
      const transformResult = await transformEsmForCallees(source, ['add'], '.mjs')
      assert.ok(transformResult)
      const tempPath = join(tmpDir, '.regrets-tmp-export-const-arrow.mjs')
      writeFileSync(tempPath, transformResult.transformedSource, 'utf8')
      try {
        const mod = await import(pathToFileURL(tempPath).href)
        // Verify the export surface is preserved (mod.add is still accessible)
        assert.equal(typeof mod.add, 'function', 'mod.add should still be exported')
        assert.equal(typeof mod.main, 'function', 'mod.main should still be exported')
        assert.equal(mod.main(5), 6, 'main return value correct without wrap')

        const recorder = []
        const cleanup = wrapCallees(mod, ['add'], recorder, { parentClusterId: 'main', quiet: true })
        try {
          const result = mod.main(41)
          assert.equal(result, 42)
          assert.equal(recorder.length, 1, 'add should be intercepted exactly once')
          assert.equal(recorder[0].fn, 'add')
          assert.deepEqual(recorder[0].args, [41, 1])
          assert.equal(recorder[0].result, 42)
        } finally {
          cleanup()
        }

        // After cleanup, mod.add should still be accessible and behave normally
        assert.equal(mod.main(10), 11)
      } finally {
        try { rmSync(tempPath, { force: true }) } catch {}
      }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  })

  it('E2E: intercepts bare-name callee in `export const foo = function() {}` module', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'regrets-esm-export-const-fn-'))
    try {
      const source = `
export const add = function(a, b) { return a + b }
export const main = function(x) { return add(x, 1) }
`
      const transformResult = await transformEsmForCallees(source, ['add'], '.mjs')
      assert.ok(transformResult)
      const tempPath = join(tmpDir, '.regrets-tmp-export-const-fn.mjs')
      writeFileSync(tempPath, transformResult.transformedSource, 'utf8')
      try {
        const mod = await import(pathToFileURL(tempPath).href)
        assert.equal(typeof mod.add, 'function')
        assert.equal(mod.main(5), 6)

        const recorder = []
        const cleanup = wrapCallees(mod, ['add'], recorder, { parentClusterId: 'main', quiet: true })
        try {
          const result = mod.main(41)
          assert.equal(result, 42)
          assert.equal(recorder.length, 1)
          assert.deepEqual(recorder[0].args, [41, 1])
          assert.equal(recorder[0].result, 42)
        } finally {
          cleanup()
        }
      } finally {
        try { rmSync(tempPath, { force: true }) } catch {}
      }
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  })

  it('handles multiple `export const` callees simultaneously', async () => {
    const source = `
export const add = (a, b) => a + b
export const mul = (a, b) => a * b
export const main = (x) => add(x, mul(x, 2))
`
    const result = await transformEsmForCallees(source, ['add', 'mul'], '.mjs')
    assert.ok(result)
    // Both callees' exports stripped
    assert.ok(result.transformedSource.includes('const add = (a, b) => a + b'))
    assert.ok(result.transformedSource.includes('const mul = (a, b) => a * b'))
    // Both internal calls rewritten
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.mul(x, 2)`))
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add(x,`))
    // Both holders populated
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.add = add`))
    assert.ok(result.transformedSource.includes(`${HOLDER_NAME}.mul = mul`))
    // Trailing export includes both callees
    assert.ok(result.transformedSource.includes(`export { ${HOLDER_NAME}, add, mul }`))
  })
})

// ─── ESM temp file lifecycle ────────────────────────────────────────────────
//
// Tests for the process-wide temp file registry + signal handlers that
// prevent temp file leaks when capture.js is killed mid-capture (SIGINT,
// SIGTERM, crash). Closes issue #244.
//
// These tests exercise the API directly. End-to-end coverage (actual SIGINT
// to a running capture.js child process) lives in tests/esm-callee-e2e.test.js.

describe('ESM temp file lifecycle', () => {
  let tmpDir

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'regrets-esm-lifecycle-'))
  })

  after(() => {
    // Belt-and-suspenders: nuke anything still in the registry from this
    // test process, then remove the temp dir.
    cleanupAllEsmTempFiles()
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  // ─── generateEsmTempFileName ───────────────────────────────────────────────

  describe('generateEsmTempFileName', () => {
    it('produces name with the expected prefix (for e2e test compatibility)', () => {
      const name = generateEsmTempFileName()
      assert.ok(
        name.startsWith('.regrets-transform-'),
        `name should keep the existing prefix convention; got: ${name}`
      )
    })

    it('produces name with .mjs extension', () => {
      const name = generateEsmTempFileName()
      assert.ok(name.endsWith('.mjs'), `name should end with .mjs; got: ${name}`)
    })

    it('includes the current process pid (for attribution)', () => {
      const name = generateEsmTempFileName()
      assert.ok(
        name.includes(`-${process.pid}-`),
        `name should include pid segment "-${process.pid}-"; got: ${name}`
      )
    })

    it('produces unique names on repeated calls (UUID collision resistance)', () => {
      const names = new Set()
      for (let i = 0; i < 100; i++) {
        names.add(generateEsmTempFileName())
      }
      assert.equal(names.size, 100, 'all 100 names should be unique')
    })
  })

  // ─── registerEsmTempFile + deleteEsmTempFile ───────────────────────────────

  describe('registerEsmTempFile + deleteEsmTempFile', () => {
    it('deleteEsmTempFile removes a registered file from disk', () => {
      const tmpPath = join(tmpDir, '.regrets-transform-test-delete.mjs')
      writeFileSync(tmpPath, '// test', 'utf8')
      registerEsmTempFile(tmpPath)

      assert.ok(existsSync(tmpPath), 'precondition: file exists')
      const deleted = deleteEsmTempFile(tmpPath)
      assert.equal(deleted, true, 'deleteEsmTempFile should return true when it deleted the file')
      assert.ok(!existsSync(tmpPath), 'file should be gone from disk')
    })

    it('deleteEsmTempFile is idempotent — second call is a no-op', () => {
      const tmpPath = join(tmpDir, '.regrets-transform-test-idempotent.mjs')
      writeFileSync(tmpPath, '// test', 'utf8')
      registerEsmTempFile(tmpPath)

      deleteEsmTempFile(tmpPath)
      // Second call — should not throw, should return false (file already gone)
      const deletedAgain = deleteEsmTempFile(tmpPath)
      assert.equal(deletedAgain, false, 'second call should return false (file already gone)')
    })

    it('deleteEsmTempFile is safe for a path that was never registered (no throw)', () => {
      const tmpPath = join(tmpDir, '.regrets-transform-test-unregistered.mjs')
      // Don't register, don't create — should swallow ENOENT
      const deleted = deleteEsmTempFile(tmpPath)
      assert.equal(deleted, false, 'should return false since file does not exist')
    })

    it('deleteEsmTempFile swallows ENOENT for a registered-but-already-removed path', () => {
      const tmpPath = join(tmpDir, '.regrets-transform-test-enoent.mjs')
      // Register but don't create — deleteEsmTempFile should swallow ENOENT
      registerEsmTempFile(tmpPath)
      const deleted = deleteEsmTempFile(tmpPath)
      assert.equal(deleted, false, 'should return false (file did not exist on disk)')
    })
  })

  // ─── cleanupAllEsmTempFiles ────────────────────────────────────────────────

  describe('cleanupAllEsmTempFiles', () => {
    it('removes ALL registered files in one call', () => {
      const path1 = join(tmpDir, '.regrets-transform-cleanup-1.mjs')
      const path2 = join(tmpDir, '.regrets-transform-cleanup-2.mjs')
      const path3 = join(tmpDir, '.regrets-transform-cleanup-3.mjs')
      writeFileSync(path1, '// test', 'utf8')
      writeFileSync(path2, '// test', 'utf8')
      writeFileSync(path3, '// test', 'utf8')
      registerEsmTempFile(path1)
      registerEsmTempFile(path2)
      registerEsmTempFile(path3)

      const deleted = cleanupAllEsmTempFiles()
      assert.equal(deleted, 3, 'all 3 files should be reported as deleted')
      assert.ok(!existsSync(path1), 'path1 deleted from disk')
      assert.ok(!existsSync(path2), 'path2 deleted from disk')
      assert.ok(!existsSync(path3), 'path3 deleted from disk')
    })

    it('is idempotent — second call returns 0 (registry is empty)', () => {
      const deleted = cleanupAllEsmTempFiles()
      assert.equal(deleted, 0, 'no files should be left to delete')
    })

    it('handles mixed state (some files exist, some are already gone)', () => {
      const existsPath = join(tmpDir, '.regrets-transform-mixed-exists.mjs')
      const gonePath = join(tmpDir, '.regrets-transform-mixed-gone.mjs')
      writeFileSync(existsPath, '// test', 'utf8')
      // Register both, but only the first exists on disk
      registerEsmTempFile(existsPath)
      registerEsmTempFile(gonePath)

      const deleted = cleanupAllEsmTempFiles()
      assert.equal(deleted, 1, 'only the existing file should be reported as deleted')
      assert.ok(!existsSync(existsPath), 'existing file should be removed')
    })
  })

  // ─── Signal handler integration ────────────────────────────────────────────
  //
  // We cannot test SIGINT/SIGTERM directly in this process (it would kill
  // the test runner). The end-to-end SIGINT behavior is covered in
  // tests/esm-callee-e2e.test.js by spawning capture.js as a child process.
  // Here we just verify the cleanup API that the signal handlers call.

  describe('signal handler contract (verified via cleanupAllEsmTempFiles)', () => {
    it('the function the signal handlers call is exported and idempotent', () => {
      // Just verify the export exists and can be called repeatedly without
      // throwing — this is the function wired into SIGINT/SIGTERM/exit/
      // uncaughtException by installEsmTempFileCleanupHandlers().
      assert.equal(typeof cleanupAllEsmTempFiles, 'function')
      assert.doesNotThrow(() => cleanupAllEsmTempFiles())
      assert.doesNotThrow(() => cleanupAllEsmTempFiles())
      assert.doesNotThrow(() => cleanupAllEsmTempFiles())
    })
  })
})

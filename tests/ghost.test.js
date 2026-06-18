// tests/ghost.test.js — unit tests for scripts/ghost.js
// Uses Node.js built-in node:test and node:assert (zero external dependencies)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGhost,
  wrapCallees,
  deepClone,
  normalizeHtml,
  consumeIterator
} from '../scripts/ghost.js'

// ─── deepClone ────────────────────────────────────────────────────────────────

describe('deepClone', () => {
  it('clones nested objects deeply', () => {
    const obj = { a: { b: { c: 1 } }, d: [1, 2] }
    const clone = deepClone(obj)
    assert.deepEqual(clone, obj)
    assert.notEqual(clone, obj)
    assert.notEqual(clone.a, obj.a)
  })

  it('clones arrays with nested objects', () => {
    const arr = [{ x: 1 }, { y: 2 }]
    const clone = deepClone(arr)
    assert.deepEqual(clone, arr)
    assert.notEqual(clone, arr)
    assert.notEqual(clone[0], arr[0])
  })

  it('preserves Date as ISO string', () => {
    const date = new Date('2024-01-15T10:30:00Z')
    const clone = deepClone(date)
    assert.equal(clone, '2024-01-15T10:30:00.000Z')
  })

  it('converts Map to plain object', () => {
    const m = new Map([['a', 1], ['b', 2]])
    const clone = deepClone(m)
    assert.deepEqual(clone, { a: 1, b: 2 })
  })

  it('converts Set to array', () => {
    const s = new Set([1, 2, 3])
    const clone = deepClone(s)
    assert.deepEqual(clone, [1, 2, 3])
  })

  it('converts RegExp to string', () => {
    const re = /^test$/i
    const clone = deepClone(re)
    assert.equal(clone, '/^test$/i')
  })

  it('converts BigInt to string with n suffix', () => {
    const clone = deepClone(18n)
    assert.equal(clone, '18n')
  })

  it('converts Uint8Array to regular array', () => {
    const u8 = new Uint8Array([10, 20, 30])
    const clone = deepClone(u8)
    assert.deepEqual(clone, [10, 20, 30])
  })

  it('returns primitives as-is', () => {
    assert.equal(deepClone(42), 42)
    assert.equal(deepClone('hello'), 'hello')
    assert.equal(deepClone(true), true)
    assert.equal(deepClone(null), null)
  })

  it('handles objects with nested BigInt values', () => {
    const obj = { count: 5n, name: 'test' }
    const clone = deepClone(obj)
    assert.deepEqual(clone, { count: '5n', name: 'test' })
  })
})

// ─── createGhost ──────────────────────────────────────────────────────────────

describe('createGhost', () => {
  it('wraps function and records calls without changing behavior', () => {
    const mod = { add: (a, b) => a + b }
    const recorder = []
    const ghost = createGhost(mod, ['add'], recorder)
    const result = ghost.add(2, 3)
    assert.equal(result, 5, 'return value unchanged')
    assert.equal(recorder.length, 1, 'exactly one call recorded')
  })

  it('records function name in call record', () => {
    const mod = { greet: (name) => `hi ${name}` }
    const recorder = []
    const ghost = createGhost(mod, ['greet'], recorder)
    ghost.greet('Alice')
    assert.equal(recorder[0].fn, 'greet')
  })

  it('records arguments in call record', () => {
    const mod = { add: (a, b) => a + b }
    const recorder = []
    const ghost = createGhost(mod, ['add'], recorder)
    ghost.add(2, 3)
    assert.deepEqual(recorder[0].args, [2, 3])
  })

  it('records result in call record', () => {
    const mod = { double: (x) => x * 2 }
    const recorder = []
    const ghost = createGhost(mod, ['double'], recorder)
    ghost.double(5)
    assert.equal(recorder[0].result, 10)
  })

  it('passes through non-watched functions', () => {
    const mod = { watched: () => 'a', unwatched: () => 'b' }
    const recorder = []
    const ghost = createGhost(mod, ['watched'], recorder)
    assert.equal(ghost.unwatched(), 'b')
    assert.equal(recorder.length, 0, 'non-watched function not recorded')
  })

  it('handles async functions transparently', async () => {
    const mod = { asyncFetch: async (url) => `response:${url}` }
    const recorder = []
    const ghost = createGhost(mod, ['asyncFetch'], recorder)
    const result = await ghost.asyncFetch('http://test')
    assert.equal(result, 'response:http://test')
    assert.equal(recorder.length, 1)
    assert.equal(recorder[0].result, 'response:http://test')
  })

  it('records errors thrown by wrapped functions', () => {
    const mod = { boom: () => { throw new Error('kaboom') } }
    const recorder = []
    const ghost = createGhost(mod, ['boom'], recorder)
    assert.throws(() => ghost.boom(), { message: 'kaboom' })
    assert.equal(recorder.length, 1)
    assert.ok(recorder[0].error.includes('kaboom'))
  })

  it('intercepts new constructor calls with construct trap', () => {
    class Track {
      constructor(name) { this.name = name }
    }
    const mod = { Track }
    const recorder = []
    const ghost = createGhost(mod, ['Track'], recorder)
    const instance = new ghost.Track('test-track')
    assert.equal(instance.name, 'test-track')
    assert.equal(recorder.length, 1)
    assert.equal(recorder[0].construct, true)
  })

  it('warns and skips non-function watch targets', () => {
    const mod = { notFn: 42 }
    const recorder = []
    const ghost = createGhost(mod, ['notFn'], recorder)
    assert.equal(ghost.notFn, 42)
    assert.equal(recorder.length, 0)
  })
})

// ─── normalizeHtml ────────────────────────────────────────────────────────────

describe('normalizeHtml', () => {
  it('collapses whitespace', () => {
    const result = normalizeHtml('<div>  hello   world  </div>')
    assert.equal(result, '<div> hello world </div>')
  })

  it('strips specified attributes', () => {
    const html = '<div data-testid="x" class="y">content</div>'
    const result = normalizeHtml(html, ['data-testid'])
    assert.ok(!result.includes('data-testid'))
    assert.ok(result.includes('class="y"'))
  })

  it('preserves non-stripped attributes', () => {
    const html = '<div id="main" class="container">hi</div>'
    const result = normalizeHtml(html, ['data-cy'])
    assert.ok(result.includes('id="main"'))
    assert.ok(result.includes('class="container"'))
  })
})

// ─── consumeIterator ──────────────────────────────────────────────────────────

describe('consumeIterator', () => {
  it('consumes sync generator into array', async () => {
    function* gen() { yield 1; yield 2; yield 3 }
    const { consumed, result } = await consumeIterator(gen())
    assert.equal(consumed, true)
    assert.deepEqual(result, [1, 2, 3])
  })

  it('consumes async generator into array', async () => {
    async function* asyncGen() { yield 'a'; yield 'b' }
    const { consumed, result } = await consumeIterator(asyncGen())
    assert.equal(consumed, true)
    assert.deepEqual(result, ['a', 'b'])
  })

  it('returns non-iterator unchanged', async () => {
    const { consumed, result } = await consumeIterator({ x: 1 })
    assert.equal(consumed, false)
    assert.deepEqual(result, { x: 1 })
  })

  it('returns primitives unchanged', async () => {
    const { consumed, result } = await consumeIterator(42)
    assert.equal(consumed, false)
    assert.equal(result, 42)
  })

  it('respects maxYields limit with truncation sentinel', async () => {
    function* gen() { yield 1; yield 2; yield 3; yield 4; yield 5 }
    const { consumed, result } = await consumeIterator(gen(), 3)
    assert.equal(consumed, true)
    assert.equal(result.length, 4) // 3 items + truncation sentinel
    assert.deepEqual(result[3], { __truncated__: true, maxYields: 3 })
  })

  it('does not consume plain arrays (they are not generators)', async () => {
    const arr = [1, 2, 3]
    const { consumed } = await consumeIterator(arr)
    assert.equal(consumed, false)
  })
})

// ─── Edge case regression tests ──────────────────────────────────────────────

describe('deepClone edge cases', () => {
  it('handles circular references without stack overflow', () => {
    const obj = {}
    obj.self = obj
    const clone = deepClone(obj)
    assert.ok(typeof clone === 'object')
    assert.equal(clone.self, '__circular__')
  })

  it('handles nested circular references', () => {
    const a = { name: 'a' }
    const b = { name: 'b', ref: a }
    a.ref = b
    const clone = deepClone(a)
    assert.ok(typeof clone === 'object')
    assert.equal(clone.name, 'a')
    // At some point the circular chain is broken with '__circular__'
  })

  it('handles circular arrays without stack overflow', () => {
    const arr = [1, 2]
    arr.push(arr)
    const clone = deepClone(arr)
    assert.ok(Array.isArray(clone))
    assert.equal(clone[0], 1)
    assert.equal(clone[1], 2)
    assert.equal(clone[2], '__circular__')
  })

  it('returns functions as-is', () => {
    const fn = () => 42
    const clone = deepClone(fn)
    assert.equal(typeof clone, 'function')
    assert.equal(clone(), 42)
  })

  it('handles objects with function values (returned as-is)', () => {
    const obj = { name: 'test', fn: () => 42 }
    const clone = deepClone(obj)
    assert.equal(clone.name, 'test')
    assert.equal(typeof clone.fn, 'function')
  })
})

describe('consumeIterator edge cases', () => {
  it('handles infinite async generator with maxYields', async () => {
    let i = 0
    async function* infiniteGen() { while (true) { yield i++ } }
    const { consumed, result } = await consumeIterator(infiniteGen(), 5)
    assert.equal(consumed, true)
    assert.equal(result.length, 6) // 5 items + truncation sentinel
    assert.ok(result.some(r => r.__truncated__))
  })

  it('handles infinite sync generator with maxYields', async () => {
    let i = 0
    function* infiniteGen() { while (true) { yield i++ } }
    const { consumed, result } = await consumeIterator(infiniteGen(), 3)
    assert.equal(consumed, true)
    assert.ok(result.some(r => r.__truncated__))
  })
})

describe('createGhost edge cases', () => {
  it('skips non-existent watch targets gracefully', () => {
    const mod = { foo: () => 42 }
    const recorder = []
    const ghost = createGhost(mod, ['foo', 'doesNotExist', 'alsoMissing'], recorder)
    // foo should still be proxied
    const result = ghost.foo(1)
    assert.equal(result, 42)
    assert.equal(recorder.length, 1)
  })

  it('skips non-function watch targets', () => {
    const mod = { foo: () => 42, bar: 'not a function' }
    const recorder = []
    const ghost = createGhost(mod, ['foo', 'bar'], recorder)
    // foo should be proxied, bar should be skipped
    ghost.foo(1)
    assert.equal(recorder.length, 1)
    assert.equal(recorder[0].fn, 'foo')
  })
})

// ─── wrapCallees (Phase 2: callee wrapping) ─────────────────────────────────

describe('wrapCallees', () => {
  it('records callee invocation with args and result', () => {
    const mod = { add: (a, b) => a + b, main: (x) => mod.add(x, 1) }
    const recorder = []
    const cleanup = wrapCallees(mod, ['add'], recorder, { parentClusterId: 'main', quiet: true })
    try {
      mod.main(5)
      assert.equal(recorder.length, 1, 'exactly one callee call recorded')
      assert.equal(recorder[0].fn, 'add')
      assert.deepEqual(recorder[0].args, [5, 1])
      assert.equal(recorder[0].result, 6)
      assert.equal(recorder[0].parentClusterId, 'main')
    } finally {
      cleanup()
    }
  })

  it('does NOT alter the return value of the wrapped callee', () => {
    const mod = { double: (x) => x * 2, run: (x) => mod.double(x) }
    const recorder = []
    const cleanup = wrapCallees(mod, ['double'], recorder, { quiet: true })
    try {
      const result = mod.run(21)
      assert.equal(result, 42, 'callee return value passes through unchanged')
    } finally {
      cleanup()
    }
  })

  it('records multiple invocations of the same callee', () => {
    const mod = { inc: (x) => x + 1, run: () => mod.inc(mod.inc(mod.inc(0))) }
    const recorder = []
    const cleanup = wrapCallees(mod, ['inc'], recorder, { quiet: true })
    try {
      mod.run()
      assert.equal(recorder.length, 3, 'three inc() calls recorded')
      assert.deepEqual(recorder.map(r => r.args), [[0], [1], [2]])
      assert.deepEqual(recorder.map(r => r.result), [1, 2, 3])
    } finally {
      cleanup()
    }
  })

  it('records distinct callees separately in one recorder', () => {
    const mod = {
      a: (x) => x + 1,
      b: (x) => x * 2,
      main: (x) => mod.b(mod.a(x)),
    }
    const recorder = []
    const cleanup = wrapCallees(mod, ['a', 'b'], recorder, { quiet: true })
    try {
      mod.main(10)
      assert.equal(recorder.length, 2)
      assert.equal(recorder[0].fn, 'a')
      assert.equal(recorder[0].result, 11)
      assert.equal(recorder[1].fn, 'b')
      assert.equal(recorder[1].result, 22)
    } finally {
      cleanup()
    }
  })

  it('records errors thrown by wrapped callees and re-throws', () => {
    const mod = { boom: () => { throw new Error('kaboom') }, run: () => mod.boom() }
    const recorder = []
    const cleanup = wrapCallees(mod, ['boom'], recorder, { quiet: true })
    try {
      assert.throws(() => mod.run(), { message: 'kaboom' })
      assert.equal(recorder.length, 1)
      assert.ok(recorder[0].error.includes('kaboom'))
      assert.equal(recorder[0].result, undefined)
    } finally {
      cleanup()
    }
  })

  it('handles async callees transparently', async () => {
    const mod = {
      asyncFetch: async (url) => `response:${url}`,
      run: async (url) => mod.asyncFetch(url),
    }
    const recorder = []
    const cleanup = wrapCallees(mod, ['asyncFetch'], recorder, { quiet: true })
    try {
      const result = await mod.run('http://test')
      assert.equal(result, 'response:http://test')
      assert.equal(recorder.length, 1)
      assert.equal(recorder[0].result, 'response:http://test')
      assert.deepEqual(recorder[0].args, ['http://test'])
    } finally {
      cleanup()
    }
  })

  it('warns and skips callees that are not exported on the module', () => {
    const mod = { main: () => 42 }  // no `add` export
    const recorder = []
    const warnings = []
    const origWarn = console.warn
    console.warn = (msg) => warnings.push(String(msg))
    try {
      const cleanup = wrapCallees(mod, ['add'], recorder, { parentClusterId: 'main' })
      // main was never wrapped — calling it should not record anything
      mod.main()
      assert.equal(recorder.length, 0, 'missing callee should not record')
      assert.ok(warnings.some(w => w.includes('add') && w.includes('main')),
        `expected a warning mentioning 'add' and 'main', got: ${warnings.join(' | ')}`)
      cleanup()
    } finally {
      console.warn = origWarn
    }
  })

  it('warns and skips non-function callees', () => {
    const mod = { notFn: 42, main: () => 1 }
    const recorder = []
    const warnings = []
    const origWarn = console.warn
    console.warn = (msg) => warnings.push(String(msg))
    try {
      const cleanup = wrapCallees(mod, ['notFn'], recorder, { parentClusterId: 'main' })
      mod.main()
      assert.equal(recorder.length, 0)
      assert.ok(warnings.some(w => w.includes('notFn')))
      cleanup()
    } finally {
      console.warn = origWarn
    }
  })

  it('restores original functions on cleanup', () => {
    const originalAdd = (a, b) => a + b
    const mod = { add: originalAdd, main: (x) => mod.add(x, 1) }
    const recorder = []
    const cleanup = wrapCallees(mod, ['add'], recorder, { quiet: true })
    cleanup()
    // After cleanup, `add` should be the original function (not a Proxy)
    assert.equal(mod.add, originalAdd, 'original function restored after cleanup')
    // And calls should not be recorded anymore
    mod.main(5)
    assert.equal(recorder.length, 0, 'no recording after cleanup')
  })

  it('cleanup is idempotent (safe to call multiple times)', () => {
    const mod = { add: (a, b) => a + b }
    const recorder = []
    const cleanup = wrapCallees(mod, ['add'], recorder, { quiet: true })
    cleanup()
    // Calling again should not throw
    assert.doesNotThrow(() => cleanup())
  })

  it('treats missing calleeNames as a no-op', () => {
    const mod = { add: (a, b) => a + b }
    const recorder = []
    const cleanup = wrapCallees(mod, undefined, recorder, { quiet: true })
    // add() should still be the original (no Proxy wrapping)
    mod.add(1, 2)
    assert.equal(recorder.length, 0)
    cleanup()
  })

  it('is opt-in — calling wrapCallees does not interfere with createGhost', () => {
    const mod = { add: (a, b) => a + b, main: (x) => mod.add(x, 1) }
    const ghostRecorder = []
    const calleeRecorder = []
    // Wrap main with createGhost AND wrap add with wrapCallees.
    // The ghost captures main; the callee wrapper captures add.
    const ghost = createGhost(mod, ['main'], ghostRecorder)
    const cleanup = wrapCallees(mod, ['add'], calleeRecorder, { parentClusterId: 'main', quiet: true })
    try {
      ghost.main(5)
      assert.equal(ghostRecorder.length, 1, 'main captured by ghost')
      assert.equal(ghostRecorder[0].fn, 'main')
      assert.equal(calleeRecorder.length, 1, 'add captured by wrapCallees')
      assert.equal(calleeRecorder[0].fn, 'add')
      assert.equal(calleeRecorder[0].result, 6)
    } finally {
      cleanup()
    }
  })

  it('records new-constructor callee invocations with instance snapshot', () => {
    class Thing {
      constructor(name) { this.name = name }
    }
    const mod = { Thing, makeThing: (n) => new mod.Thing(n) }
    const recorder = []
    const cleanup = wrapCallees(mod, ['Thing'], recorder, { quiet: true })
    try {
      mod.makeThing('widget')
      assert.equal(recorder.length, 1)
      assert.equal(recorder[0].fn, 'Thing')
      assert.equal(recorder[0].construct, true)
      assert.deepEqual(recorder[0].result, { name: 'widget' })
    } finally {
      cleanup()
    }
  })

  it('propagates reassignment to targetModule.default for CJS-style modules', () => {
    // Simulate a CJS module imported via dynamic import() after mergeCjsModule:
    //   targetModule = { default: <module.exports>, ...shallow-copied keys }
    // The entry function calls the callee via `module.exports.foo(...)`,
    // which resolves to `default.foo` — NOT to the merged top-level key.
    // wrapCallees must reassign on BOTH holders for the proxy to be hit.
    const liveExports = {
      add: (a, b) => a + b,
      // main looks up add via the live exports object (CJS idiom)
      main: function (x) { return liveExports.add(x, 1) },
    }
    const mod = { default: liveExports, add: liveExports.add, main: liveExports.main }
    const recorder = []
    const cleanup = wrapCallees(mod, ['add'], recorder, { parentClusterId: 'main', quiet: true })
    try {
      const result = mod.main(41)
      assert.equal(result, 42, 'main return value passes through')
      assert.equal(recorder.length, 1, 'add() was intercepted via the default-holder path')
      assert.equal(recorder[0].fn, 'add')
      assert.deepEqual(recorder[0].args, [41, 1])
      assert.equal(recorder[0].result, 42)
    } finally {
      cleanup()
    }
    // After cleanup, default.add must also be restored (not just the top-level key)
    assert.equal(liveExports.add, mod.add, 'default.add restored to original')
  })

  it('warns when callee cannot be reassigned because all holders are frozen', () => {
    // ESM namespace objects are frozen — Object.isFrozen returns true.
    // wrapCallees should detect the failed reassignment and warn.
    const frozen = Object.freeze({
      add: (a, b) => a + b,
      main: (x) => frozen.add(x, 1),
    })
    const mod = frozen
    const recorder = []
    const warnings = []
    const origWarn = console.warn
    console.warn = (msg) => warnings.push(String(msg))
    try {
      const cleanup = wrapCallees(mod, ['add'], recorder, { parentClusterId: 'main' })
      // Even though reassignment fails, the call still goes through the original
      // function — but no recording happens because the proxy was never installed.
      const result = mod.main(5)
      assert.equal(result, 6)
      assert.equal(recorder.length, 0, 'proxy not installed on frozen module → no recording')
      assert.ok(warnings.some(w => w.includes('frozen') && w.includes('add')),
        `expected a frozen-module warning mentioning 'add', got: ${warnings.join(' | ')}`)
      cleanup()
    } finally {
      console.warn = origWarn
    }
  })
})

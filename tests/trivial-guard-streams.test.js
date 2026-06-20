// tests/trivial-guard-streams.test.js — Tests for #256
// Trivial-input guard edge cases: streams, async iterables, generator returns
//
// The trivial-output guard in scripts/install.js previously checked for
// null/undefined/NaN/throws. Issue #256 points out that streams, async
// iterables, and generator objects are truthy objects but not meaningful
// outputs — they're lazy producers that need to be consumed before the
// real output is observable. Fingerprinting the producer object itself
// is meaningless.
//
// These tests verify the extended guard correctly flags:
//   - Generator objects (from `function*`)
//   - Async generator objects (from `async function*`)
//   - Async iterables (objects with Symbol.asyncIterator)
//   - Node.js Readable/Writable streams (have pipe + read/write)
//   - Web ReadableStream/WritableStream (have getReader/getWriter)
//   - Plain iterator objects (have next, no Symbol.iterator)
//
// And does NOT flag (regression check):
//   - Plain objects (legitimate return values)
//   - Arrays (legitimate return values)
//   - Maps / Sets (iterables but legitimate)
//   - Numbers, strings, booleans (primitives)
//   - Promises (handled by await in the probe loop)
//   - Functions (legitimate higher-order return values)
//
// Run: node --test tests/trivial-guard-streams.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable, Transform } from 'node:stream'
import { trivialOutputReason } from '../scripts/install.js'

describe('#256 trivial guard — pre-existing behavior (regression check)', () => {
  it('flags throws', () => {
    const reason = trivialOutputReason(undefined, true)
    assert.ok(reason !== null, 'should flag when function threw')
    assert.match(reason, /throws/)
  })

  it('flags undefined output', () => {
    const reason = trivialOutputReason(undefined, false)
    assert.ok(reason !== null)
    assert.match(reason, /undefined/)
  })

  it('flags null output', () => {
    const reason = trivialOutputReason(null, false)
    assert.ok(reason !== null)
    assert.match(reason, /null/)
  })

  it('flags NaN output', () => {
    const reason = trivialOutputReason(NaN, false)
    assert.ok(reason !== null)
    assert.match(reason, /NaN/)
  })
})

describe('#256 trivial guard — generators', () => {
  it('flags sync generator objects (from function*)', () => {
    function* gen() { yield 1; yield 2; yield 3 }
    const output = gen()
    const reason = trivialOutputReason(output, false)
    assert.ok(reason !== null, 'should flag generator object output')
    assert.match(reason, /Generator/)
  })

  it('flags async generator objects (from async function*)', () => {
    async function* asyncGen() { yield 1; yield 2 }
    const output = asyncGen()
    const reason = trivialOutputReason(output, false)
    assert.ok(reason !== null, 'should flag async generator object output')
    assert.match(reason, /AsyncGenerator/)
  })

  it('does NOT flag a function that returns an array of values (consumed generator)', () => {
    // If the function already consumed the generator and returned an array,
    // that's a meaningful output — the consumption happened inside the function.
    const output = [1, 2, 3]
    const reason = trivialOutputReason(output, false)
    assert.equal(reason, null, 'should NOT flag an array (legitimate consumed output)')
  })
})

describe('#256 trivial guard — async iterables', () => {
  it('flags objects with Symbol.asyncIterator', () => {
    const asyncIterable = {
      async *[Symbol.asyncIterator]() {
        yield 1; yield 2; yield 3
      },
    }
    const reason = trivialOutputReason(asyncIterable, false)
    assert.ok(reason !== null, 'should flag async iterable')
    assert.match(reason, /async iterable/)
  })

  it('does NOT flag plain objects without asyncIterator', () => {
    const output = { name: 'Alice', age: 30 }
    const reason = trivialOutputReason(output, false)
    assert.equal(reason, null, 'should NOT flag a plain object')
  })
})

describe('#256 trivial guard — Node.js streams', () => {
  it('flags Readable streams', () => {
    const r = Readable.from(['chunk1', 'chunk2'])
    const reason = trivialOutputReason(r, false)
    assert.ok(reason !== null, 'should flag Node.js Readable stream')
    // Node.js Readable implements Symbol.asyncIterator in modern Node, so
    // the reason may say "async iterable" OR "Node.js stream". Both are
    // correct — what matters is that the stream is flagged as trivial.
    assert.ok(
      /Node\.js stream|async iterable/.test(reason),
      `reason should mention Node.js stream or async iterable, got: ${reason}`
    )
  })

  it('flags Writable streams', () => {
    const w = new Writable({
      write(chunk, encoding, callback) { callback() },
    })
    const reason = trivialOutputReason(w, false)
    assert.ok(reason !== null, 'should flag Node.js Writable stream')
    // Writable streams don't have asyncIterator, so they should hit the
    // pipe+write check specifically.
    assert.match(reason, /Node\.js stream/)
  })

  it('flags Transform streams', () => {
    const t = new Transform({
      transform(chunk, encoding, callback) { callback(null, chunk) },
    })
    const reason = trivialOutputReason(t, false)
    assert.ok(reason !== null, 'should flag Node.js Transform stream')
    // Transform is both Readable + Writable, may be flagged as either.
    assert.ok(
      /Node\.js stream|async iterable/.test(reason),
      `reason should mention Node.js stream or async iterable, got: ${reason}`
    )
  })
})

describe('#256 trivial guard — web streams', () => {
  it('flags ReadableStream (web standard)', () => {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue('chunk1')
        controller.enqueue('chunk2')
        controller.close()
      },
    })
    const reason = trivialOutputReason(rs, false)
    assert.ok(reason !== null, 'should flag web ReadableStream')
    // Web ReadableStream implements Symbol.asyncIterator in Node 18+, so the
    // reason may say "async iterable" OR "web stream". Both are correct —
    // what matters is that the output is flagged.
    assert.ok(
      /web stream|async iterable/.test(reason),
      `reason should mention web stream or async iterable, got: ${reason}`
    )
  })

  it('flags WritableStream (web standard)', () => {
    const ws = new WritableStream({
      write(chunk) { /* no-op */ },
    })
    const reason = trivialOutputReason(ws, false)
    assert.ok(reason !== null, 'should flag web WritableStream')
    // WritableStream doesn't have asyncIterator, so it should hit the
    // getWriter check specifically.
    assert.match(reason, /web stream/)
  })
})

describe('#256 trivial guard — synchronous iterators', () => {
  it('flags plain iterator objects (has next, no Symbol.iterator)', () => {
    // A plain iterator: has next() but is not itself iterable
    const iterator = {
      _count: 0,
      next() {
        return this._count < 3
          ? { value: this._count++, done: false }
          : { value: undefined, done: true }
      },
    }
    const reason = trivialOutputReason(iterator, false)
    assert.ok(reason !== null, 'should flag plain iterator object')
    assert.match(reason, /Iterator/)
  })

  it('does NOT flag Map (iterable but legitimate collection)', () => {
    const m = new Map([['a', 1], ['b', 2]])
    const reason = trivialOutputReason(m, false)
    assert.equal(reason, null, 'should NOT flag Map (legitimate return value)')
  })

  it('does NOT flag Set (iterable but legitimate collection)', () => {
    const s = new Set([1, 2, 3])
    const reason = trivialOutputReason(s, false)
    assert.equal(reason, null, 'should NOT flag Set (legitimate return value)')
  })
})

describe('#256 trivial guard — meaningful outputs (regression check)', () => {
  it('does NOT flag numbers', () => {
    assert.equal(trivialOutputReason(42, false), null)
    assert.equal(trivialOutputReason(0, false), null)
    assert.equal(trivialOutputReason(-1, false), null)
    assert.equal(trivialOutputReason(3.14, false), null)
  })

  it('does NOT flag strings', () => {
    assert.equal(trivialOutputReason('hello', false), null)
    assert.equal(trivialOutputReason('', false), null)
  })

  it('does NOT flag booleans', () => {
    assert.equal(trivialOutputReason(true, false), null)
    assert.equal(trivialOutputReason(false, false), null)
  })

  it('does NOT flag plain objects', () => {
    assert.equal(trivialOutputReason({}, false), null)
    assert.equal(trivialOutputReason({ name: 'Alice' }, false), null)
    assert.equal(trivialOutputReason({ nested: { deep: [1, 2, 3] } }, false), null)
  })

  it('does NOT flag arrays', () => {
    assert.equal(trivialOutputReason([], false), null)
    assert.equal(trivialOutputReason([1, 2, 3], false), null)
    assert.equal(trivialOutputReason(['a', 'b'], false), null)
  })

  it('does NOT flag class instances (legitimate domain objects)', () => {
    class User { constructor(name) { this.name = name } }
    const u = new User('Alice')
    assert.equal(trivialOutputReason(u, false), null)
  })

  it('does NOT flag functions (legitimate higher-order return values)', () => {
    const fn = () => 42
    assert.equal(trivialOutputReason(fn, false), null)
  })

  it('does NOT flag Uint8Array / Buffer (legitimate binary data)', () => {
    const buf = Buffer.from([1, 2, 3])
    assert.equal(trivialOutputReason(buf, false), null)
    const arr = new Uint8Array([4, 5, 6])
    assert.equal(trivialOutputReason(arr, false), null)
  })

  it('does NOT flag Date objects', () => {
    const d = new Date('2026-01-01')
    assert.equal(trivialOutputReason(d, false), null)
  })

  it('does NOT flag RegExp objects', () => {
    const re = /abc/g
    assert.equal(trivialOutputReason(re, false), null)
  })

  it('does NOT flag Error objects (legitimate error contracts)', () => {
    const err = new Error('something failed')
    assert.equal(trivialOutputReason(err, false), null)
  })
})

describe('#256 trivial guard — reason strings are actionable', () => {
  // The reason string is shown to the user when a cluster is skipped.
  // It should explain WHAT was detected and WHAT the user should do.

  it('generator reason mentions "add meaningful inputs"', () => {
    function* gen() { yield 1 }
    const reason = trivialOutputReason(gen(), false)
    assert.match(reason, /add meaningful inputs/i)
  })

  it('async iterable reason mentions "add meaningful inputs"', () => {
    const ai = { async *[Symbol.asyncIterator]() { yield 1 } }
    const reason = trivialOutputReason(ai, false)
    assert.match(reason, /add meaningful inputs/i)
  })

  it('Node.js stream reason mentions "add meaningful inputs"', () => {
    const r = Readable.from(['x'])
    const reason = trivialOutputReason(r, false)
    assert.match(reason, /add meaningful inputs/i)
  })

  it('web stream reason mentions "add meaningful inputs"', () => {
    const rs = new ReadableStream({ start(c) { c.close() } })
    const reason = trivialOutputReason(rs, false)
    assert.match(reason, /add meaningful inputs/i)
  })
})

describe('#256 trivial guard — exported from install.js', () => {
  it('trivialOutputReason is exported and callable', () => {
    assert.equal(typeof trivialOutputReason, 'function',
      'trivialOutputReason should be exported from install.js')
  })

  it('handles edge case: output is a string (no Symbol.toStringTag conflict)', () => {
    // Strings have a Symbol.iterator but should NOT be flagged as iterators
    const reason = trivialOutputReason('hello', false)
    assert.equal(reason, null)
  })

  it('handles edge case: output is a Promise (should NOT flag — caller awaits)', () => {
    // Promises are objects but they're handled by the `await` in the probe
    // loop. The output the function "returns" is actually the resolved
    // value, not the Promise itself. So we should NOT flag Promise objects.
    // (This is a defensive check — if the probe loop is broken and a
    // Promise leaks through, we'd rather fingerprint it than skip.)
    const p = Promise.resolve(42)
    const reason = trivialOutputReason(p, false)
    assert.equal(reason, null, 'should NOT flag Promise (handled by await in probe loop)')
  })
})

// tests/outputTransform.test.js — unit tests for scripts/outputTransform.js
// Uses Node.js built-in node:test and node:assert (zero external dependencies)

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyOutputTransform,
  applyOutputTransformAsync,
  toPojo
} from '../scripts/outputTransform.js'

// ─── applyOutputTransform — str ─────────────────────────────────────────────

describe('applyOutputTransform — str', () => {
  it('converts number to string', () => {
    assert.equal(applyOutputTransform(42, 'str'), '42')
  })

  it('converts boolean to string', () => {
    assert.equal(applyOutputTransform(true, 'str'), 'true')
  })

  it('converts each element in an array', () => {
    const result = applyOutputTransform([1, 2, 3], 'str')
    assert.deepEqual(result, ['1', '2', '3'])
  })

  it('passes through null transform', () => {
    const obj = { a: 1 }
    assert.equal(applyOutputTransform(obj, null), obj)
  })

  it('passes through undefined transform', () => {
    const val = 42
    assert.equal(applyOutputTransform(val, undefined), val)
  })
})

// ─── applyOutputTransform — repr ────────────────────────────────────────────

describe('applyOutputTransform — repr', () => {
  it('JSON.stringifies the value', () => {
    assert.equal(applyOutputTransform({ a: 1 }, 'repr'), '{"a":1}')
  })

  it('handles arrays', () => {
    assert.equal(applyOutputTransform([1, 2], 'repr'), '[1,2]')
  })

  it('handles primitives', () => {
    assert.equal(applyOutputTransform(42, 'repr'), '42')
    assert.equal(applyOutputTransform('hello', 'repr'), '"hello"')
  })
})

// ─── applyOutputTransform — len ─────────────────────────────────────────────

describe('applyOutputTransform — len', () => {
  it('returns array length', () => {
    assert.equal(applyOutputTransform([1, 2, 3], 'len'), 3)
  })

  it('returns string length', () => {
    assert.equal(applyOutputTransform('hello', 'len'), 5)
  })

  it('returns object key count', () => {
    assert.equal(applyOutputTransform({ a: 1, b: 2 }, 'len'), 2)
  })

  it('returns 0 for null', () => {
    assert.equal(applyOutputTransform(null, 'len'), 0)
  })

  it('returns 0 for number', () => {
    assert.equal(applyOutputTransform(42, 'len'), 0)
  })

  it('returns 0 for empty array', () => {
    assert.equal(applyOutputTransform([], 'len'), 0)
  })
})

// ─── applyOutputTransform — type ────────────────────────────────────────────

describe('applyOutputTransform — type', () => {
  it('returns "null" for null', () => {
    assert.equal(applyOutputTransform(null, 'type'), 'null')
  })

  it('returns "undefined" for undefined', () => {
    assert.equal(applyOutputTransform(undefined, 'type'), 'undefined')
  })

  it('returns "array" for arrays', () => {
    assert.equal(applyOutputTransform([1, 2], 'type'), 'array')
  })

  it('returns constructor name for class instances', () => {
    class MyClass {}
    assert.equal(applyOutputTransform(new MyClass(), 'type'), 'MyClass')
  })

  it('returns "object" for plain objects', () => {
    assert.equal(applyOutputTransform({ a: 1 }, 'type'), 'object')
  })

  it('returns "Number" for numbers (constructor name)', () => {
    // 42 is a Number primitive — typeof is 'number' but outputTransform
    // checks constructor.name first, and Number(42).constructor.name = 'Number'
    assert.equal(applyOutputTransform(42, 'type'), 'Number')
  })

  it('returns "String" for strings (constructor name)', () => {
    assert.equal(applyOutputTransform('hi', 'type'), 'String')
  })
})

// ─── applyOutputTransform — array_summary ───────────────────────────────────

describe('applyOutputTransform — array_summary', () => {
  it('summarizes array with length, first, last', () => {
    const result = applyOutputTransform([10, 20, 30], 'array_summary')
    assert.equal(result.length, 3)
    assert.equal(result.first, 10)
    assert.equal(result.last, 30)
  })

  it('summarizes empty array with only length', () => {
    const result = applyOutputTransform([], 'array_summary')
    assert.equal(result.length, 0)
    assert.ok(!('first' in result))
  })

  it('summarizes TypedArray with length and byteLength', () => {
    const u8 = new Uint8Array([1, 2, 3])
    const result = applyOutputTransform(u8, 'array_summary')
    assert.equal(result.length, 3)
    assert.equal(result.byteLength, 3)
  })

  it('summarizes object with length and keys', () => {
    const result = applyOutputTransform({ x: 1, y: 2 }, 'array_summary')
    assert.equal(result.length, 2)
    assert.deepEqual(result.keys, ['x', 'y'])
  })

  it('returns { length: 0 } for null', () => {
    const result = applyOutputTransform(null, 'array_summary')
    assert.deepEqual(result, { length: 0 })
  })
})

// ─── applyOutputTransform — dict ────────────────────────────────────────────

describe('applyOutputTransform — dict', () => {
  it('converts Map to plain object', () => {
    const m = new Map([['a', 1], ['b', 2]])
    const result = applyOutputTransform(m, 'dict')
    assert.deepEqual(result, { a: 1, b: 2 })
  })

  it('converts class instance to plain object via toPojo', () => {
    class Foo { constructor() { this.x = 1 } }
    const result = applyOutputTransform(new Foo(), 'dict')
    assert.deepEqual(result, { x: 1 })
    assert.ok(!(result instanceof Foo))
  })

  it('passes through arrays unchanged', () => {
    const arr = [1, 2, 3]
    assert.equal(applyOutputTransform(arr, 'dict'), arr)
  })
})

// ─── applyOutputTransform — json ────────────────────────────────────────────

describe('applyOutputTransform — json', () => {
  it('strips non-serializable values via JSON round-trip', () => {
    const obj = { a: 1, b: undefined }
    const result = applyOutputTransform(obj, 'json')
    assert.deepEqual(result, { a: 1 })
  })

  it('deep-clones via JSON round-trip on each array element', () => {
    const arr = [{ a: 1 }, { b: undefined }]
    const result = applyOutputTransform(arr, 'json')
    assert.deepEqual(result, [{ a: 1 }, {}])
  })
})

// ─── applyOutputTransform — keys ────────────────────────────────────────────

describe('applyOutputTransform — keys', () => {
  it('returns Object.keys() for objects', () => {
    const result = applyOutputTransform({ z: 1, a: 2 }, 'keys')
    assert.deepEqual(result, ['z', 'a'])
  })

  it('passes through non-objects unchanged', () => {
    assert.equal(applyOutputTransform(42, 'keys'), 42)
  })
})

// ─── applyOutputTransform — toString ────────────────────────────────────────

describe('applyOutputTransform — toString', () => {
  it('calls .toString() on objects', () => {
    const obj = { toString() { return 'custom' } }
    assert.equal(applyOutputTransform(obj, 'toString'), 'custom')
  })

  it('maps toString over arrays', () => {
    const result = applyOutputTransform([1, 2, 3], 'toString')
    assert.deepEqual(result, ['1', '2', '3'])
  })
})

// ─── applyOutputTransform — toJSON ──────────────────────────────────────────

describe('applyOutputTransform — toJSON', () => {
  it('calls .toJSON() on objects', () => {
    const obj = { toJSON() { return { serialized: true } } }
    assert.deepEqual(applyOutputTransform(obj, 'toJSON'), { serialized: true })
  })

  it('maps toJSON over arrays', () => {
    const items = [
      { toJSON() { return 'a' } },
      { toJSON() { return 'b' } }
    ]
    const result = applyOutputTransform(items, 'toJSON')
    assert.deepEqual(result, ['a', 'b'])
  })

  it('deepClones when .toJSON() is not available', () => {
    const obj = { x: 1 }
    const result = applyOutputTransform(obj, 'toJSON')
    assert.deepEqual(result, { x: 1 })
    assert.notEqual(result, obj)
  })
})

// ─── applyOutputTransform — isoformat ───────────────────────────────────────

describe('applyOutputTransform — isoformat', () => {
  it('converts Date to ISO string', () => {
    const date = new Date('2024-01-15T10:30:00Z')
    assert.equal(applyOutputTransform(date, 'isoformat'), '2024-01-15T10:30:00.000Z')
  })

  it('converts each Date in array', () => {
    const dates = [new Date('2024-01-15T10:30:00Z'), new Date('2025-06-01T00:00:00Z')]
    const result = applyOutputTransform(dates, 'isoformat')
    assert.equal(result[0], '2024-01-15T10:30:00.000Z')
    assert.equal(result[1], '2025-06-01T00:00:00.000Z')
  })

  it('converts non-Date to string in array', () => {
    const result = applyOutputTransform([42, 'hello'], 'isoformat')
    assert.deepEqual(result, ['42', 'hello'])
  })
})

// ─── applyOutputTransform — pojo / dataclass_dict ──────────────────────────

describe('applyOutputTransform — pojo / dataclass_dict', () => {
  it('pojo strips class identity', () => {
    class Foo { constructor() { this.x = 1 } }
    const result = applyOutputTransform(new Foo(), 'pojo')
    assert.deepEqual(result, { x: 1 })
    assert.ok(!(result instanceof Foo))
  })

  it('dataclass_dict is alias for pojo', () => {
    class Bar { constructor() { this.y = 2 } }
    const pojoResult = applyOutputTransform(new Bar(), 'pojo')
    const dcResult = applyOutputTransform(new Bar(), 'dataclass_dict')
    assert.deepEqual(pojoResult, dcResult)
  })
})

// ─── applyOutputTransform — custom module.function ─────────────────────────

describe('applyOutputTransform — custom module.function', () => {
  it('passes through output for dot-notation transform (sync)', () => {
    const output = { data: [1, 2, 3] }
    const result = applyOutputTransform(output, 'myModule.myTransform')
    assert.equal(result, output) // sync version passes through; async version does the import
  })
})

// ─── applyOutputTransformAsync ──────────────────────────────────────────────

describe('applyOutputTransformAsync', () => {
  it('passes through null transform', async () => {
    const obj = { a: 1 }
    const result = await applyOutputTransformAsync(obj, null)
    assert.equal(result, obj)
  })

  it('delegates to sync applyOutputTransform for known transforms', async () => {
    assert.equal(await applyOutputTransformAsync(42, 'str'), '42')
    assert.equal(await applyOutputTransformAsync([1, 2, 3], 'len'), 3)
    assert.equal(await applyOutputTransformAsync(null, 'type'), 'null')
  })

  it('throws for invalid custom module path', async () => {
    await assert.rejects(
      () => applyOutputTransformAsync({ x: 1 }, 'nonexistent_module.fn', '/tmp'),
      { message: /Cannot resolve outputTransform/ }
    )
  })
})

// ─── toPojo ─────────────────────────────────────────────────────────────────

describe('toPojo', () => {
  it('strips class identity from instances', () => {
    class Foo { constructor() { this.x = 1; this.y = 'hello' } }
    const result = toPojo(new Foo())
    assert.deepEqual(result, { x: 1, y: 'hello' })
    assert.ok(!(result instanceof Foo))
  })

  it('recursively converts nested class instances', () => {
    class Inner { constructor() { this.val = 42 } }
    class Outer { constructor() { this.inner = new Inner() } }
    const result = toPojo(new Outer())
    assert.deepEqual(result, { inner: { val: 42 } })
    assert.ok(!(result.inner instanceof Inner))
  })

  it('converts Map to sorted plain object', () => {
    const m = new Map([['b', 2], ['a', 1]])
    const result = toPojo(m)
    assert.deepEqual(result, { a: 1, b: 2 })
  })

  it('converts Set to array', () => {
    assert.deepEqual(toPojo(new Set([1, 2, 3])), [1, 2, 3])
  })

  it('converts Date to ISO string', () => {
    const date = new Date('2024-06-15T12:00:00Z')
    assert.equal(toPojo(date), '2024-06-15T12:00:00.000Z')
  })

  it('converts RegExp to string', () => {
    assert.equal(toPojo(/^test$/gi), '/^test$/gi')
  })

  it('converts Uint8Array to array', () => {
    assert.deepEqual(toPojo(new Uint8Array([1, 2, 3])), [1, 2, 3])
  })

  it('uses .toJSON() when available', () => {
    const obj = { val: 99, toJSON() { return { serialized: this.val } } }
    assert.deepEqual(toPojo(obj), { serialized: 99 })
  })

  it('skips function-valued properties', () => {
    class WithMethod { constructor() { this.data = 1 } greet() { return 'hi' } }
    const result = toPojo(new WithMethod())
    assert.deepEqual(result, { data: 1 })
    assert.ok(!('greet' in result))
  })

  it('returns primitives and null as-is', () => {
    assert.equal(toPojo(null), null)
    assert.equal(toPojo(undefined), undefined)
    assert.equal(toPojo(42), 42)
    assert.equal(toPojo('hello'), 'hello')
  })
})

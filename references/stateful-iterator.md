# Stateful Iterator — Fingerprinting Guide

Many libraries expose stateful iterators: objects with `next()`/`prev()` methods that
advance internal state on each call. Examples include cron schedulers, cursor-based
pagination, sequence generators, and parser token streams.

Regrets' default `classMethod` pattern calls a single method and fingerprints its
return value. This is insufficient for iterators because:

1. **Each `next()` call mutates internal state** — calling it twice with no arguments
   produces different results, so fingerprinting a single call proves nothing.
2. **The contract is the SEQUENCE of outputs** — what matters is that `next()` ×5
   produces the same 5 values after refactoring.
3. **Construction often requires a factory method** — `CronExpressionParser.parse()`
   returns a `CronExpression` instance; you can't just `new CronExpression()`.
4. **Output is a class instance** — `CronDate` from `.next()` has methods and private
   fields that `deepClone()` can't round-trip. You need an adapter to serialize.

---

## Pattern 1: Adapter That Materializes a Sequence

The most reliable approach: create an adapter that constructs the iterator,
calls `.next()` N times, and returns an array of serialized results.

### Adapter Example (cron-parser)

```js
// regret-adapters.mjs
import { CronExpressionParser } from './dist/index.js';

export function adaptParseAndIterate(input) {
  const { expression, iterations, options } = input;
  const interval = CronExpressionParser.parse(expression, options);

  const results = [];
  for (let i = 0; i < iterations; i++) {
    const nextDate = interval.next();
    // CronDate.toJSON() returns ISO string — this is fingerprintable
    results.push(nextDate.toISOString());
  }
  return results;
}

export function adaptParseAndStringify(input) {
  const { expression, options } = input;
  const interval = CronExpressionParser.parse(expression, options);
  return interval.stringify();
}

export function adaptFieldsToExpression(input) {
  const { fields, options } = input;
  // CronExpression.fieldsToExpression is a static factory
  const CronExpression = CronExpressionParser.parse('* * * * *').constructor;
  // Reconstruct from serialized fields
  const interval = CronExpression.fieldsToExpression(fields, options);
  const results = [];
  for (let i = 0; i < 3; i++) {
    results.push(interval.next().toISOString());
  }
  return results;
}
```

### Manifest Configuration

```json
{
  "preBuild": "npm run build",
  "clusters": [
    {
      "id": "parse-and-iterate-every-5-min",
      "entry": "adaptParseAndIterate",
      "watches": ["adaptParseAndIterate"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": [
        { "expression": "*/5 * * * *", "iterations": 5, "options": {} }
      ]
    },
    {
      "id": "parse-and-iterate-hourly",
      "entry": "adaptParseAndIterate",
      "watches": ["adaptParseAndIterate"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": [
        { "expression": "0 * * * *", "iterations": 3, "options": {} }
      ]
    },
    {
      "id": "stringify-expression",
      "entry": "adaptParseAndStringify",
      "watches": ["adaptParseAndStringify"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": [
        { "expression": "*/5 * * * *", "options": {} },
        { "expression": "0 0 1 1 *", "options": {} }
      ]
    }
  ]
}
```

---

## Pattern 2: Chain Testing for Multi-Step Flows

When the iterator output feeds into another function, use chain testing.

### chains.json

```json
{
  "chains": [
    {
      "id": "parse-iterate-stringify",
      "steps": [
        {
          "cluster": "parse-and-iterate-every-5-min",
          "input": { "expression": "*/5 * * * *", "iterations": 5, "options": {} }
        },
        {
          "cluster": "stringify-expression",
          "input": { "expression": "*/5 * * * *", "options": {} }
        }
      ]
    }
  ]
}
```

The chain hash verifies that parsing → iterating → stringifying all produce
consistent, compatible results.

---

## Pattern 3: Timezone-Dependent Output

Iterators that produce time-based output are timezone-sensitive. The same cron
expression parsed at UTC+0 produces different ISO strings than at UTC+7.

### Solution A: Fixed TZ in adapter

```js
export function adaptParseAndIterateUTC(input) {
  // Force UTC to ensure deterministic output regardless of system timezone
  const interval = CronExpressionParser.parse(input.expression, {
    ...input.options,
    tz: 'UTC',
  });
  const results = [];
  for (let i = 0; i < input.iterations; i++) {
    results.push(interval.next().toISOString());
  }
  return results;
}
```

### Solution B: Normalize timezone offsets

Use `"normalize": ["timezoneOffsets"]` to replace UTC offset strings like
`+05:30`, `-04:00` with `<TZ_OFFSET>`. This makes fingerprints timezone-agnostic
while still catching structural changes.

### Solution C: Normalize ISO date strings

Use `"normalize": ["isoDates"]` to replace ISO 8601 date strings like
`2025-01-15T10:30:00.000Z` with `<ISO_DATE>`. This completely removes date
sensitivity, leaving only the structure to verify.

**Recommendation**: Use Solution A (fixed TZ) when possible. It gives the strongest
guarantee — exact output matching. Solutions B and C are for cases where the
timezone cannot be controlled (e.g., the library doesn't accept a TZ parameter).

---

## Pattern 4: Static Factory → Instance Method

When the only way to get an instance is through a static factory method
(e.g., `CronExpressionParser.parse()`), you cannot use the `classMethod`
manifest pattern directly. Instead, use an adapter that calls the factory
and then the instance method.

### Why classMethod Doesn't Work

The `classMethod` pattern in Regrets assumes:
1. `constructor` is the class name
2. `constructorArgs` are passed to `new ClassName(...args)`
3. `classMethod` is called on the resulting instance

But static factories don't use `new` — they're called as
`ClassName.staticMethod()`. There's no manifest field for this pattern.

### Adapter Solution

```js
export function adaptStaticFactoryMethod(input) {
  const instance = CronExpressionParser.parse(input.expression, input.options);
  return instance[input.method]();
}
```

With manifest:
```json
{
  "id": "cron-next",
  "entry": "adaptStaticFactoryMethod",
  "watches": ["adaptStaticFactoryMethod"],
  "file": "regret-adapters.mjs",
  "stack": "js",
  "fingerprintLevel": "entry",
  "inputs": [
    { "expression": "*/5 * * * *", "options": {}, "method": "next" }
  ]
}
```

---

## How `regret scan` Detects These Patterns

After the improvements in this release, `regret scan` now detects:

1. **Static class methods** — `export class Foo { static bar() }` is reported as
   a static method `Foo.bar` requiring an adapter.

2. **Stateful iterators** — Classes with `next()` + `take()`/`hasNext()`/`[Symbol.iterator]`
   are reported as iterators needing adapter-based sequence materialization.

3. **`regret structure`** adds classification columns for "STATIC FACTORY" and
   "STATEFUL ITERATOR" patterns, with refactoring priority bonuses for iterators
   inside God Objects.

---

## Decision Tree

```
Does the API return a class instance?
├── No (returns plain JSON/primitive)
│   → Use standard function-based cluster
│
└── Yes
    ├── Can you construct with `new`?
    │   ├── Yes → Use classMethod + constructor pattern
    │   └── No (requires static factory)
    │       → Use adapter that calls the factory
    │
    └── Is it a stateful iterator (has next()/prev())?
        ├── Yes
        │   ├── Can you materialize the sequence?
        │   │   ├── Yes → Adapter that calls next() N times, returns array
        │   │   └── No → Use schema mode on single call result
        │   └── Is the output timezone-dependent?
        │       ├── Yes → Force UTC in adapter + normalize rules
        │       └── No → Value mode is fine
        └── No (single-shot method)
            └── Does toJSON() serialize correctly?
                ├── Yes → Function-based entry works
                └── No → Use adapter with explicit serialization
```

---

## Real-World Example: cron-parser

| API | Pattern | Fingerprint Mode | Notes |
|-----|---------|-----------------|-------|
| `CronExpressionParser.parse(expr, opts)` | Static factory | value (via adapter) | Returns CronExpression instance |
| `CronExpression.next()` | Stateful iterator | value (sequence) | Materialize N calls → array of ISO strings |
| `CronExpression.prev()` | Stateful iterator | value (sequence) | Same pattern as next() |
| `CronExpression.stringify()` | Instance method | value | Returns plain string |
| `CronExpression.includesDate(date)` | Instance method | value (via adapter) | Takes Date, returns boolean |
| `CronFieldCollection.stringify()` | Instance method | value | Returns plain string |
| `CronFieldCollection.serialize()` | Instance method | value | Returns plain JSON |

All iterator-based clusters should use adapters. All single-method clusters can
use either direct entry or simple adapters.

---

## Summary

| Challenge | Solution |
|-----------|----------|
| Static factory → instance method | Adapter that calls factory, then method |
| Stateful iterator output sequence | Adapter materializes N calls into array |
| Timezone-dependent output | Force UTC in adapter + normalize rules |
| Class instance output (non-serializable) | Adapter serializes via `.toISOString()`, `.toJSON()`, or explicit field extraction |
| Multiple iterator methods (next/prev) | Separate clusters or adapter with method parameter |

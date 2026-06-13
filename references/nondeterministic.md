# Non-Deterministic Functions — Fingerprinting Guide

Not all functions produce the same output for the same input. Functions that call `Math.random()`, `crypto.randomUUID()`, `Date.now()`, or depend on external state produce different outputs on each invocation. This guide explains how to use Regrets with such functions.

---

## The Problem

Regrets' default value-mode fingerprinting hashes the exact input and output. If a function produces different output each run (even with identical input), the fingerprint changes — causing drift detection to flag the cluster.

This is **not a bug in the code** — it's inherent non-determinism. The question is: how do we regression-test a function whose output is intentionally variable?

---

## Solution 1: Schema Mode

Use `"fingerprintMode": "schema"` to fingerprint the **structure** of the output, not the values.

```json
{
  "id": "zalgo-generation",
  "entry": "zalgoGeneration",
  "watches": ["zalgoGeneration"],
  "file": "dist/src/zalgo-generator.js",
  "stack": "js",
  "fingerprintLevel": "entry",
  "fingerprintMode": "schema",
  "multiArgs": true,
  "description": "Zalgo generator — random output, stable schema",
  "inputs": [["hello", 1, 1, 1]]
}
```

For a function that always returns a string, `extractSchema(output)` produces `"string"` regardless of the string content. The schema fingerprint is stable across runs.

**When to use:** The output structure is consistent but values vary. Best for generators, randomizers, and any function where the "shape" matters more than the exact content.

---

## Solution 2: Mixed Mode

Use `"fingerprintMode": "mixed"` when some output values matter and some don't.

```json
{
  "id": "api-response-factory",
  "fingerprintMode": "mixed",
  "valuePaths": ["$.statusCode", "$.data.type"],
  "inputs": [{"endpoint": "/api/test"}]
}
```

The schema captures the structure, and `valuePaths` captures specific values that must be exact. Random parts of the output are captured by schema only.

**When to use:** The output has both deterministic and non-deterministic parts. For example, an API response factory that always returns the same status code but different request IDs.

---

## Solution 3: Extract Pure Logic

Refactor the non-deterministic function into two parts:
1. A **pure function** that takes a random source as a parameter
2. A **wrapper** that calls the pure function with `Math.random()`

```typescript
// Before — non-deterministic, hard to fingerprint
function generateToken(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// After — pure logic extracted, testable
function generateTokenWithSource(length: number, randomSource: () => number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(randomSource() * chars.length)];
  }
  return result;
}

function generateToken(length: number): string {
  return generateTokenWithSource(length, Math.random);
}
```

Now fingerprint `generateTokenWithSource` with a seeded random source:

```json
{
  "id": "generate-token-logic",
  "entry": "generateTokenWithSource",
  "multiArgs": true,
  "inputs": [[16, "((() => { let s=42; return () => { s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; }; })())"]]
}
```

**When to use:** You need exact value matching for a function that currently uses randomness internally. This is the most rigorous approach.

---

## Real-World Example: Zalgo Text Generator

The `zalgo-generator` npm package provides three functions:

| Function | Deterministic? | Fingerprint Mode |
|----------|---------------|-----------------|
| `zalgoGeneration(text, up, mid, down)` | No — uses `Math.random()` to select combining characters | `schema` |
| `zalgoRandomGeneration(text, count)` | No — random counts AND random characters | `schema` |
| `unzalgoText(zalgoText)` | **Yes** — deterministically strips combining characters | `value` |

The `unzalgoText` function is the perfect deterministic anchor: given Zalgo text, it always produces the same clean output. This can be fingerprinted with value mode for exact matching.

The `zalgoGeneration` function uses `Math.random()` to select which combining characters to add, so the exact output varies. Schema mode fingerprints "this function returns a string" which is stable.

Both functions can be regression-tested together: `unzalgoText(zalgoGeneration("hello", 1, 1, 1))` should always return `"hello"` — this roundtrip property is the real contract.

---

## Decision Tree

```
Is the function deterministic?
├── Yes → Use value mode (default)
└── No → Does the output structure stay the same?
    ├── Yes, always the same shape
    │   ├── Do some specific values need to match exactly?
    │   │   ├── Yes → Use mixed mode with valuePaths
    │   │   └── No → Use schema mode
    │   └── Can you extract the pure logic?
    │       └── Yes → Extract and fingerprint pure version with value mode
    └── No, structure also varies
        → Need to normalize or restructure the code first
```

---

## Common Non-Deterministic APIs

| API | Type | Normalization |
|-----|------|--------------|
| `Math.random()` | Random number | Use schema mode or extract pure logic |
| `crypto.randomUUID()` | Random UUID | Use `"normalize": ["uuids"]` or schema mode |
| `Date.now()` / `new Date()` | Timestamp | Use `"normalize": ["timestamps"]` |
| `process.pid` | System value | Use `"ignoreFields": ["pid"]` |
| Network calls | External state | Mock at boundary layer |
| File system reads | External state | Mock or extract pure logic |

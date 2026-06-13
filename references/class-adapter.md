# Class-Based API Adapter Pattern

Many real-world libraries export class instances (DNA sequences, monetary values, color objects) rather than plain JSON data. Regrets' fingerprint system hashes JSON-serializable input/output pairs, so class instances that carry methods, private fields, or non-enumerable properties need an adapter layer.

## The Problem

```js
// Library exports class instances
import { parseDNA } from 'ts-dna'
const result = parseDNA('ATCG')
// result.data is a DNA class instance with .sequence, .getComplement(), etc.
// JSON.stringify(result.data) → {"sequence":"ATCG"} (methods lost!)
```

When the Ghost Proxy records this output via `deepClone()`, the class methods are stripped — only the data survives. This means:
1. The fingerprint only captures the data fields, not the class identity
2. If the class adds a new data field later, the fingerprint silently changes
3. If the class changes a method name, the fingerprint doesn't detect it (but behavior might)

## Solution: Adapter Module

Create a `regret-adapters.mjs` file alongside your source that:
1. Takes **plain string/object inputs** (not class instances)
2. Calls the real library functions
3. Returns **plain JSON objects** with only the data that matters

### Example: ts-dna Molecular Biology Library

```js
// regret-adapters.mjs
import { parseDNA } from './dist/sequence/index.js';
import { transcribeSequence } from './dist/sequence/conversion.js';

// Adapter: string input → plain JSON output
export function adaptParseDNA(input) {
  const result = parseDNA(input);
  if (result.success) {
    return { ok: true, sequence: result.data.sequence };
  }
  return { ok: false, error: result.data };
}

// Adapter: DNA string → RNA string (via class instance, but serialized)
export function adaptTranscribeSequence(dnaStr) {
  const dnaResult = parseDNA(dnaStr);
  if (!dnaResult.success) return { ok: false, error: dnaResult.data };
  const rna = transcribeSequence(dnaResult.data);
  return { ok: true, rnaSequence: rna.sequence };
}
```

### Manifest Configuration

```json
{
  "clusters": [
    {
      "id": "parse-dna",
      "entry": "adaptParseDNA",
      "watches": ["adaptParseDNA"],
      "file": "regret-adapters.mjs",
      "stack": "js",
      "fingerprintLevel": "entry",
      "description": "Parse DNA sequence string — validates {A,C,G,T} alphabet",
      "inputs": ["ATCG", "atcg", "", "XYZ"]
    }
  ]
}
```

## Design Rules for Adapters

1. **One adapter per cluster** — each adapter is a single entry function
2. **Plain string/object inputs** — no class instances as input; construct them inside the adapter
3. **Plain JSON output** — return only data fields, not class references
4. **Error passthrough** — if the underlying function returns a `Result`, preserve the error structure
5. **Name convention** — prefix with `adapt` to distinguish from library functions
6. **Multi-argument functions** — use object inputs: `{ dnaStr, start, end }` rather than positional args

## When to Use vs. When Not To

### Use adapters when:
- The library returns class instances (DNA, Money, Color, DateTime)
- The library uses Result/Either monads for error handling
- The library requires construction via factory functions (not `new`)
- Input types are class instances, not primitives

### Skip adapters when:
- Functions already take and return plain JSON (strings, numbers, arrays, plain objects)
- The library is purely functional (no class instances)
- You're testing pure utility functions (formatters, parsers that return primitives)

## TypedArray Handling

Regrets already handles TypedArrays (Uint8Array, Int32Array, etc.) — they're automatically converted to regular arrays for fingerprinting. You don't need an adapter for this.

```js
// This works without an adapter:
export function hashBytes(input) {
  return crypto.hash(input); // Returns Uint8Array
}
// Regrets fingerprints Uint8Array as [212, 29, 140, 217] — deterministic
```

## Multi-Input Clusters with Adapters

When testing functions that take class instances as arguments, pass the serialized form and reconstruct inside the adapter:

```js
// Instead of: parseDoubleStrandedDNA(dnaInstance1, dnaInstance2)
// Do this:
export function adaptParseDoubleStrandedDNA(input) {
  const { forwardStr, reverseStr } = input;
  const forward = parseDNA(forwardStr).unwrap();
  const reverse = parseDNA(reverseStr).unwrap();
  return parseDoubleStrandedDNA(forward, reverse);
}
```

This pattern lets Regrets fingerprint the *contract* (what string inputs produce what outputs) without needing to serialize class instances.

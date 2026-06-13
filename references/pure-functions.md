# Pure-Function Libraries — Regrets Reference Guide

Pure-function libraries are the ideal use case for Regrets. This guide covers how to set up regression testing for small, stateless utility libraries — encoders, decoders, hash functions, formatters, and lookup-table packages.

---

## Why Pure-Function Libraries Are Perfect for Regrets

A pure function has two properties:
1. **Deterministic** — same input always produces the same output
2. **No side effects** — doesn't modify external state

These properties are exactly what Regrets' fingerprint-based validation depends on. When a function is pure:

- **Fingerprints are stable** — no timestamps, no random IDs, no external state to normalize
- **Entry-level fingerprinting is sufficient** — no need for schema or mixed modes
- **Every input maps to exactly one output** — the golden fingerprint is truly golden
- **Roundtrip testing is trivial** — `decode(encode(x)) === x` validates both functions at once

Contrast this with impure functions that return timestamps, random UUIDs, or mutable state — those require `normalize` rules, `fingerprintMode: "schema"`, or careful `ignoreFields` configuration. Pure functions just work out of the box.

---

## Example Manifest: Encode/Decode Functions

Here's a manifest for a library with `encode` and `decode` functions (e.g., base64, braille-encode, hex):

```json
{
  "clusters": [
    {
      "id": "encode",
      "entry": "encode",
      "watches": ["encode"],
      "file": "src/index.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["hello", "world", ""]
    },
    {
      "id": "decode",
      "entry": "decode",
      "watches": ["decode"],
      "file": "src/index.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["aGVsbG8=", "d29ybGQ=", ""]
    }
  ]
}
```

Key points:
- **Separate clusters for `encode` and `decode`** — each function gets its own golden fingerprint
- **`fingerprintLevel: "entry"`** — we only care about the input→output mapping, not the internal call sequence
- **Multiple `inputs`** — Regrets captures one golden fingerprint per cluster using the first input, but validates against all inputs during `validate`

---

## Testing the Roundtrip Property

For encode/decode libraries, the most powerful test is the **roundtrip property**: `decode(encode(x)) === x`. This catches bugs in both functions simultaneously.

There are two approaches:

### Approach 1: Separate Clusters (Recommended)

Keep `encode` and `decode` as separate clusters. This is the simplest setup and produces clear failure messages:

```json
{
  "clusters": [
    {
      "id": "encode",
      "entry": "encode",
      "watches": ["encode"],
      "file": "src/index.js",
      "stack": "js",
      "inputs": ["hello"]
    },
    {
      "id": "decode",
      "entry": "decode",
      "watches": ["decode"],
      "file": "src/index.js",
      "stack": "js",
      "inputs": ["aGVsbG8="]
    }
  ]
}
```

When `encode` changes, the `encode` cluster fails. When `decode` changes, the `decode` cluster fails. You know exactly which function broke.

### Approach 2: Roundtrip Cluster

If you want to test the roundtrip property directly, create a small wrapper:

```js
// test-roundtrip.js
import { encode, decode } from './src/index.js'
export function roundtrip(str) {
  return decode(encode(str))
}
```

```json
{
  "clusters": [
    {
      "id": "roundtrip",
      "entry": "roundtrip",
      "watches": ["encode", "decode"],
      "file": "test-roundtrip.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["hello", "world"]
    }
  ]
}
```

**Important caveat**: When using `fingerprintLevel: "full"` with `watches: ["encode", "decode"]`, Regrets will warn you if only some watched functions are called. In this roundtrip example both `encode` and `decode` are triggered, so no warning. But if your entry function only calls a subset of the watches, you'll get:

```
   ⚠️  Watched function(s) never called during capture: decode
      The fingerprint may be based on incomplete data.
      Consider splitting into separate clusters or adjusting the entry function.
```

This is intentional — it catches the common mistake of listing functions in `watches` that aren't actually exercised by the entry function.

---

## Pattern: Libraries with Lookup Tables

Many encoding libraries use lookup tables (maps, objects, or arrays) for performance. These are still pure functions, but the internal structure matters for regression testing.

### Example: braille-encode

The `qntm/braille-encode` library uses lookup tables to map between Unicode braille patterns and binary representations. Here's how to set up Regrets for it:

```json
{
  "clusters": [
    {
      "id": "encode",
      "entry": "encode",
      "watches": ["encode"],
      "file": "src/braille.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["abc", "Hello World", ""]
    },
    {
      "id": "decode",
      "entry": "decode",
      "watches": ["decode"],
      "file": "src/braille.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["⠃⠗⠁⠊⠇⠇⠑"]
    }
  ]
}
```

**Why `fingerprintLevel: "entry"` instead of `"full"`?**

With `"full"`, the fingerprint includes the call sequence of watched functions. For pure functions that call internal helpers or lookup tables, this creates brittle fingerprints — any refactoring of the internal call chain changes the fingerprint even though the output is identical. Entry-level fingerprinting only cares about the input→output mapping.

Use `"full"` only when you specifically need to verify that certain internal functions are called in a particular order (e.g., for security-critical code paths).

### When Lookup Tables Return Non-JSON Types

If your lookup table or function returns non-JSON-serializable values (Map, Set, RegExp, Date, TypedArray), Regrets' `deepClone` function handles them:

| Type | Serialized As | Example |
|------|--------------|---------|
| `Uint8Array` | Regular array | `[1, 2, 3]` |
| `Map` | Plain object | `{"key": "value"}` |
| `Set` | Array | `[1, 2, 3]` |
| `RegExp` | String pattern | `"/^abc$/i"` |
| `Date` | ISO string | `"2025-01-15T00:00:00.000Z"` |

This means fingerprints are deterministic even when the library uses these types internally.

---

## Case Study: braille-encode Walkthrough

[braille-encode](https://github.com/qntm/braille-encode) is a tiny library that encodes arbitrary bytes as Unicode braille characters and decodes them back. It's the archetype of a pure-function library.

### Step 1: Initialize

```bash
npx regret init
```

### Step 2: Create the Manifest

```json
{
  "clusters": [
    {
      "id": "encode",
      "entry": "encode",
      "watches": ["encode"],
      "file": "src/index.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["hello", "test", ""]
    },
    {
      "id": "decode",
      "entry": "decode",
      "watches": ["decode"],
      "file": "src/index.js",
      "stack": "js",
      "fingerprintLevel": "entry",
      "inputs": ["⠓⠑⠇⠇⠕"]
    }
  ]
}
```

### Step 3: Capture

```bash
node scripts/capture.js
```

Output:
```
📡 Capturing: encode
   File:    src/index.js
   Entry:   encode
   Watches: encode
   ✅ Fingerprint: a3f7b2
   📄 Saved: regrets/encode.regret

📡 Capturing: decode
   File:    src/index.js
   Entry:   decode
   Watches: decode
   ✅ Fingerprint: k9m4x1
   📄 Saved: regrets/decode.regret
```

### Step 4: Validate

```bash
node scripts/validate.js
```

```
🔍 Validating 2 cluster(s)...

  ✅ encode                              a3f7b2                  PASS
  ✅ decode                              k9m4x1                  PASS

✅ All 2 tests passed. Refactor is safe.
```

### Step 5: Refactor with Confidence

Now you can refactor the internal lookup tables, rename helper functions, or restructure the module. As long as `encode("hello")` produces the same output, Regrets will pass.

If you accidentally break the encoding:

```
  ❌ encode                              a3f7b2 → c8d2e5         FAIL
```

The golden fingerprint doesn't match — the output changed. Fix the code, don't edit the `.regret` file.

### What the .regret File Looks Like

```
cluster: encode
version: 1
fingerprint: a3f7b2
captured: 2025-06-01T12:00:00.000Z
watches: [encode]
entry: encode
stack: js
fingerprintLevel: entry
---
INPUT  "hello"
OUTPUT "⠓⠑⠇⠇⠕"
HASH   a3f7b2
```

Simple. The input is `"hello"`, the output is the braille encoding, and the hash is the golden fingerprint.

---

## Common Pitfalls

### 1. Watching Functions That the Entry Never Calls

If you list both `encode` and `decode` in `watches` but the entry is only `encode`, you'll get:

```
   ⚠️  Watched function(s) never called during capture: decode
      The fingerprint may be based on incomplete data.
      Consider splitting into separate clusters or adjusting the entry function.
```

**Fix**: Create separate clusters for each function, or only watch the function the entry actually calls.

### 2. Using `fingerprintLevel: "full"` for Pure Functions

With `"full"`, the fingerprint is based on the *sequence of watched function calls*, not just the input→output mapping. For pure functions, this is almost never what you want — internal refactoring would break the fingerprint even though the output is correct.

**Fix**: Use `fingerprintLevel: "entry"` (the default) for pure functions.

### 3. Non-Serializable Return Values

If your function returns a Map, Set, RegExp, or Date, older versions of Regrets would silently drop the value during `deepClone`, producing `undefined` or `{}`. Current versions handle these types correctly (see the lookup table section above).

**Fix**: Make sure you're using the latest version of `ghost.js` which includes enhanced `deepClone` support.

---

## Summary

| Aspect | Pure-Function Libraries | Stateful Libraries |
|--------|------------------------|--------------------|
| `fingerprintLevel` | `"entry"` | `"entry"` or `"full"` |
| `fingerprintMode` | `"value"` | `"schema"` or `"mixed"` |
| `normalize` rules | Usually none | Often needed (timestamps, IDs) |
| Roundtrip testing | Trivial | May not apply |
| Fingerprint stability | Very high | May require tuning |

Pure-function libraries are where Regrets shines brightest: zero configuration, stable fingerprints, and immediate confidence that your refactoring preserved behavior.

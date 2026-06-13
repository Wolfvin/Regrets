# base1 Test Case — Regression Testing Proof

This document records a real-world proof that the Regrets regression testing skill works correctly on an unlikely, niche codebase with BigInt and Uint8Array types.

## Target Repository

**Repo:** [qntm/base1](https://github.com/qntm/base1)
**Language:** JavaScript (ES modules)
**Size:** 1 source file (~46 lines), zero dependencies
**What it does:** Converts binary data (Uint8Array) into a unary representation — a string of repeated "A" characters whose count equals the encoded BigInt value. The author's own keywords include "useless" and "inefficient".

**Why this repo?** Base1 is an intentionally absurd encoding scheme that converts binary to a string of repeated "A" characters. Nobody would think to regression-test a unary encoding library — making it the perfect edge case. It also exercises BigInt (which cannot be JSON-serialized) and Uint8Array (which requires special handling in the fingerprinter).

---

## Cluster Design

| Cluster | Entry | Watches | Fingerprint Level | Inputs |
|---------|-------|---------|------------------|--------|
| `encode-l-str` | `encodeLToString` | `encodeLToString` | entry | 6 test cases (empty, single byte, multi-byte) |
| `encode-bytes` | `encode` | `encode` | entry | 4 test cases (empty, single byte, boundary) |
| `decode-l-str` | `decodeLFromString` | `decodeLFromString` | entry | 7 test cases (zero, small, medium, large BigInt) |
| `decode-base1` | `decode` | `decode` | entry | 3 test cases (empty, single "A", multi-"A") |
| `roundtrip-encode-decode` | `roundtrip` | `roundtrip` | entry | 4 test cases (verifying encode→decode identity) |

### BigInt Adapter Pattern

`encodeL` returns a `BigInt` and `decodeL` accepts a `BigInt` as input. Since `JSON.stringify` throws `TypeError` on BigInt values, direct fingerprinting is impossible. The solution is **adapter functions** that convert BigInt to/from string representation:

```js
// src/adapters.js
import { encodeL, decodeL } from './index.js'

export const encodeLToString = uint8Array => String(encodeL(uint8Array))
export const decodeLFromString = bigintStr => decodeL(BigInt(bigintStr))
```

These adapters make the I/O JSON-serializable while preserving all information. The adapter functions themselves become the Regrets entry points.

### Roundtrip Helper

A `roundtrip()` function was created in `src/roundtrip.js` to test the encode→decode composition:

```js
import { encode } from './encode.js'
import { decode } from './decode.js'

export const roundtrip = uint8Array => decode(encode(uint8Array))
export { encode, decode }
```

---

## Phase 1 Results — Capture & Drift

All 5 clusters captured successfully with zero failures:

| Cluster | Fingerprint | Drift (10 runs) |
|---------|------------|----------------|
| encode-l-str | `2uzb9uv` | STABLE |
| encode-bytes | `jxfgb8x` | STABLE |
| decode-l-str | `1qiyvca` | STABLE |
| decode-base1 | `22vo0pr` | STABLE |
| roundtrip-encode-decode | `1nveqm9` | STABLE |

**ZERO false positives. ZERO drift. All SOLID.**

### Key Observations

1. **BigInt requires adapter pattern**: Functions that accept or return BigInt values cannot be fingerprinted directly because `JSON.stringify` throws on BigInt. Adapter functions that convert to/from string representations are required.

2. **Internal function calls are invisible to Ghost Proxy**: When `encode` internally calls `encodeL`, the Ghost Proxy cannot intercept this call because the proxy wraps module exports, not internal references. Only the entry function's output is captured. Use `fingerprintLevel: "entry"` and watch only the entry function itself for such clusters.

3. **Multi-byte inputs can produce enormous strings**: The `encode` function for multi-byte Uint8Array inputs produces strings whose length equals 256^n equivalent. For example, encoding "Hello" produces a string of 315,251,060,080 "A" characters — far beyond any practical limit. Only single-byte or small inputs should be used for `encode` cluster testing.

4. **TypedArray handling works correctly**: The existing TypedArray support in `deepClone` and `fingerprint` handles Uint8Array inputs and outputs without issues.

---

## Phase 2 Results — Two Truths

### KEBENARAN 1 (Raw Output)
All entry functions were called directly with their test inputs. The raw return values were recorded in `regrets/truth1-raw-output.json`.

### KEBENARAN 2 (Regrets Fingerprint)
Fingerprints: `2uzb9uv`, `jxfgb8x`, `1qiyvca`, `22vo0pr`, `1nveqm9` — all GREEN and STABLE.

### Verification
KEBENARAN 1 and KEBENARAN 2 are **semantically identical** — the raw output matches what Regrets captured in the `.regret` files. This was verified by recomputing all fingerprints from the raw I/O data and comparing against the golden hashes.

---

## Phase 3 Results — Refactoring Proof

### Refactoring Performed

1. **Split into encode/decode modules** (`src/encode.js`, `src/decode.js`):
   - Extracted encoding functions into `src/encode.js`
   - Extracted decoding functions into `src/decode.js`
   - Converted `src/index.js` into a re-export hub for backward compatibility

2. **Improved documentation**:
   - Added comprehensive JSDoc to all functions with `@param`, `@returns`, `@throws`
   - Added module-level documentation explaining the encoding scheme
   - Documented the BigInt offset logic (+1 per byte)

3. **Renamed variables for clarity**:
   - `l` → `unaryLength` (descriptive)
   - `b` → `byte` (readable)
   - `number` → `lengthAsNumber` (precise)
   - `l` (mutated in decodeL) → `remaining` (immutable pattern)

4. **Removed stale TODO comment** in `decode` function

5. **Updated imports** in `adapters.js` and `roundtrip.js` to use specific modules

### Three Verifications After Refactoring

| Verification | Result |
|-------------|--------|
| VERIFICATION 1: Regrets clusters | ✅ All 5 GREEN (2uzb9uv, jxfgb8x, 1qiyvca, 22vo0pr, 1nveqm9) |
| VERIFICATION 2: Raw output vs KEBENARAN 1 | ✅ All 25 I/O pairs identical |
| VERIFICATION 3: Fingerprint vs KEBENARAN 2 | ✅ All 5 fingerprints match |

The refactor was proven safe by all three independent verification methods.

---

## Lessons for the Regrets Skill

### 1. BigInt Requires Adapter Functions

Functions that accept or return BigInt values cannot be directly fingerprinted because `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`. The solution is adapter functions:

```js
// Adapter: BigInt output → string output
export const encodeLToString = uint8Array => String(encodeL(uint8Array))

// Adapter: string input → BigInt input
export const decodeLFromString = bigintStr => decodeL(BigInt(bigintStr))
```

**When to use:** Any function that uses BigInt as input or output type. Common in cryptographic, mathematical, or encoding libraries.

### 2. Internal Function Calls Bypass Ghost Proxy

When function A calls function B internally (both in the same module), wrapping B in the Ghost Proxy does NOT intercept calls from A. The proxy only intercepts calls made through the proxied module object. Internal direct calls bypass the proxy entirely.

**Impact:** If you list internal helpers in `watches`, you'll get warnings like "Watched function(s) never called during capture." This is not a bug — it's a fundamental limitation of the Proxy pattern.

**Solution:** Use `fingerprintLevel: "entry"` and only watch the entry function itself. If you need to trace internal calls, refactor to make the internal function a parameter (dependency injection).

### 3. Enormous Output Values Need Careful Input Selection

Some functions produce output proportional to their input in extreme ways. Base1's `encode` for an n-byte input produces a string of length ~256^n. For "Hello" (5 bytes), this is 315 billion characters.

**Solution:** Limit test inputs to small values where the output is manageable. For Base1, single-byte inputs (0-255) produce strings of 0-256 characters — perfectly testable.

### 4. Empty Input Edge Cases Are Essential

Empty Uint8Array (encode) and empty string (decode) are critical edge cases:
- `encode(Uint8Array.from([]))` → `""` (0 "A"s, representing BigInt 0n)
- `decode("")` → `Uint8Array.from([])` (empty binary)

Always include empty input cases in the `inputs` array.

# braille-encode Test Case — Regression Testing Proof

This document records a real-world proof that the Regrets regression testing skill works correctly on an unlikely, niche codebase.

## Target Repository

**Repo:** [qntm/braille-encode](https://github.com/qntm/braille-encode)
**Language:** JavaScript (ES modules)
**Size:** 1 source file (~37 lines), zero dependencies
**What it does:** Converts binary data (Uint8Array) into Braille Unicode characters and back. Each byte maps to a single Braille character via a 256-entry lookup table.

**Why this repo?** The author explicitly states the library is "of no use to Braille users. Or to anybody, for that matter." It repurposes Braille Unicode for binary visualization. Nobody would think to regression-test a binary-to-Braille converter — making it the perfect edge case.

---

## Cluster Design

| Cluster | Entry | Watches | Fingerprint Level | Inputs |
|---------|-------|---------|------------------|--------|
| `encode-bytes` | `encode` | `encode` | entry | 5 test cases (including empty, single byte, multi-byte) |
| `decode-braille` | `decode` | `decode` | entry | 5 test cases (including empty, single char, multi-char) |
| `roundtrip-encode-decode` | `roundtrip` | `encode`, `decode`, `roundtrip` | full | 3 test cases (verifying encode→decode identity) |

### Roundtrip Helper

A `roundtrip()` function was created in `src/roundtrip.js` to test the encode→decode composition:

```js
export const roundtrip = uint8Array => {
  const encoded = encode(uint8Array)
  return decode(encoded)
}
```

This function re-exports `encode` and `decode` for Ghost Proxy watchability.

---

## Phase 1 Results — Capture & Drift

All 3 clusters captured successfully with zero failures:

| Cluster | Fingerprint | Drift (10 runs) |
|---------|------------|----------------|
| encode-bytes | `5dmmgln` | STABLE |
| decode-braille | `4cdd3af` | STABLE |
| roundtrip-encode-decode | `50bhoui` | STABLE |

**ZERO false positives. ZERO drift. All SOLID.**

### Key Observations

1. **TypedArray handling**: The `encode` function takes `Uint8Array` input and returns a `string`. The `decode` function takes a `string` and returns `Uint8Array`. Regrets' existing TypedArray support (from PR #12) correctly serializes these without issues.

2. **Re-export for watchability**: Functions imported from another module are NOT automatically available for Ghost Proxy wrapping. They must be re-exported from the entry point's file. This is documented as a pattern for multi-module clusters.

3. **fingerprintLevel: "full"**: The roundtrip cluster uses `fingerprintLevel: "full"` to hash the entire watched call sequence, providing stricter verification than entry-level fingerprinting alone.

---

## Phase 2 Results — Two Truths

### KEBENARAN 1 (Raw Output)
All entry functions were called directly with their test inputs. The raw return values were recorded:

- `encode([72,101,108,108,111])` → `"⠊⢖⠞⠞⢾"`
- `encode([0,127,255])` → `"⠀⣾⣿"`
- `encode([])` → `""`
- `encode([1])` → `"⢀"`
- `encode([212,29,140,217])` → `"⡓⣘⠙⣋"`
- `decode("⠳⢥⠺⠺⠼")` → `[198,163,78,78,46]`
- `decode("⠁⠿⣿")` → `[128,238,255]`
- `decode("")` → `[]`
- `decode("⢀")` → `[1]`
- `decode("⣇⢕")` → `[241,165]`
- `roundtrip([72,101,108,108,111])` → `[72,101,108,108,111]` (identity)
- `roundtrip([0,1,2,254,255])` → `[0,1,2,254,255]` (identity)
- `roundtrip([128,192,224,240])` → `[128,192,224,240]` (identity)

### KEBENARAN 2 (Regrets Fingerprint)
Fingerprints: `5dmmgln`, `4cdd3af`, `50bhoui` — all GREEN and STABLE.

### Verification
KEBENARAN 1 and KEBENARAN 2 are **semantically identical** — the raw output matches what Regrets captured in the `.regret` files.

---

## Phase 3 Results — Refactoring Proof

### Refactoring Performed

1. **Split lookup table into separate module** (`src/lookup.js`):
   - Extracted `BRAILLE_CHAR_TABLE` and `BRAILLE_BYTE_TABLE` from `index.js`
   - Renamed `encodechar` → `BRAILLE_CHAR_TABLE` (descriptive, constant naming)
   - Renamed `decodechar` → `BRAILLE_BYTE_TABLE` (descriptive, constant naming)
   - Added JSDoc documentation explaining the non-standard dot numbering

2. **Improved encode function**:
   - Changed from `reduce()` to `Array.from().map().join('')` pattern
   - More readable: explicit mapping of each byte to its character
   - Added JSDoc with `@param` and `@returns`

3. **Improved decode function**:
   - Extracted byte conversion into a separate `bytes` array variable
   - Used more descriptive names: `ch` for character, `bytes` for result
   - Added JSDoc with `@param`, `@returns`, and `@throws`

4. **New file `src/roundtrip.js`** for round-trip testing support

### Three Verifications After Refactoring

| Verification | Result |
|-------------|--------|
| VERIFICATION 1: Regrets clusters | ✅ All 3 GREEN (5dmmgln, 4cdd3af, 50bhoui) |
| VERIFICATION 2: Raw output vs KEBENARAN 1 | ✅ All 13 inputs produce identical output |
| VERIFICATION 3: Fingerprint vs KEBENARAN 2 | ✅ All 3 fingerprints match |

The refactor was proven safe by all three independent verification methods.

---

## Lessons for the Regrets Skill

### 1. Re-export Pattern for Cross-Module Watches

When a cluster's entry function imports other functions from a different module, those imported functions are NOT available for Ghost Proxy wrapping because they are properties of the source module, not the entry module.

**Pattern:**
```js
// src/roundtrip.js
import { encode, decode } from './index.js'

export const roundtrip = uint8Array => decode(encode(uint8Array))

// Re-export for Ghost Proxy watchability
export { encode, decode }
```

Without re-exporting, `createGhost()` would log warnings:
```
⚠️  Watch target "encode" is not a function — skipping
⚠️  Watch target "decode" is not a function — skipping
```

### 2. TypedArray Inputs Work Transparently

The existing TypedArray serialization support (PR #12, #64df83c) handles `Uint8Array` inputs and outputs correctly. No special `ignoreFields` or `normalize` rules were needed.

### 3. Empty Input Edge Cases

Empty `Uint8Array` (encode) and empty string (decode) are important edge cases that should always be included in test inputs. They correctly produce empty string and empty `Uint8Array` respectively.

### 4. fingerprintLevel: "full" for Composition Testing

When testing function composition (encode→decode roundtrip), using `fingerprintLevel: "full"` provides stricter verification than `"entry"` alone, as it fingerprints the entire watched call sequence.
